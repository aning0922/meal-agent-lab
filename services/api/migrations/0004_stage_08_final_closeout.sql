-- 阶段 08 最终审计收口。
--
-- 0000—0003 已纳入 checksum，不得修改。本迁移只做 additive 数据结构
-- 与受控函数替换：
--   1. link request 固化发起时的安全披露快照；
--   2. 用 household 级 advisory lock 串行化 profile/target 关联不变量；
--   3. 让 profile_changed 等终态可由调用方在事务提交后映射为 HTTP 409；
--   4. 对 app-role 传入的 constraint JSONB 做完整的数据库边界校验。

-- ---------------------------------------------------------------------------
-- 1. Link request 的知情确认快照。
-- ---------------------------------------------------------------------------

ALTER TABLE public.person_profile_link_requests
  ADD COLUMN disclosure_version integer,
  ADD COLUMN profile_version_at_request integer,
  ADD COLUMN disclosed_profile_name varchar(80),
  ADD COLUMN disclosed_household_hard_count integer,
  ADD COLUMN disclosed_household_soft_count integer,
  ADD COLUMN disclosed_private_constraint_count integer;

-- 旧 pending 没有“发起时”披露证据，不得使用迁移时的当前值冒充原始披露。
UPDATE public.person_profile_link_requests
SET status = 'cancelled',
    terminal_reason = 'profile_changed',
    version = version + 1
WHERE status = 'pending';

UPDATE public.person_profile_link_requests AS request
SET disclosure_version = 1,
    profile_version_at_request = profile.version,
    disclosed_profile_name = profile.display_name,
    disclosed_household_hard_count = counts.household_hard_count,
    disclosed_household_soft_count = counts.household_soft_count,
    disclosed_private_constraint_count = counts.private_count
FROM public.person_profiles AS profile
CROSS JOIN LATERAL (
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE item.value->>'visibility' = 'household'
        AND item.value->>'enforcement' = 'hard'
    )::integer AS household_hard_count,
    pg_catalog.count(*) FILTER (
      WHERE item.value->>'visibility' = 'household'
        AND item.value->>'enforcement' = 'soft'
    )::integer AS household_soft_count,
    pg_catalog.count(*) FILTER (
      WHERE item.value->>'visibility' = 'subject_and_owner'
    )::integer AS private_count
  FROM pg_catalog.jsonb_array_elements(
    profile.dietary_constraints
  ) AS item(value)
) AS counts
WHERE request.household_id = profile.household_id
  AND request.profile_id = profile.id;

ALTER TABLE public.person_profile_link_requests
  ALTER COLUMN disclosure_version SET NOT NULL,
  ALTER COLUMN profile_version_at_request SET NOT NULL,
  ALTER COLUMN disclosed_profile_name SET NOT NULL,
  ALTER COLUMN disclosed_household_hard_count SET NOT NULL,
  ALTER COLUMN disclosed_household_soft_count SET NOT NULL,
  ALTER COLUMN disclosed_private_constraint_count SET NOT NULL,
  ADD CONSTRAINT person_profile_link_requests_disclosure_check CHECK (
    disclosure_version = 1
    AND profile_version_at_request >= 0
    AND pg_catalog.length(disclosed_profile_name) BETWEEN 1 AND 80
    AND disclosed_household_hard_count >= 0
    AND disclosed_household_soft_count >= 0
    AND disclosed_private_constraint_count >= 0
  );

ALTER TABLE public.person_profile_link_requests
  DROP CONSTRAINT person_profile_link_requests_terminal_reason_check;

ALTER TABLE public.person_profile_link_requests
  ADD CONSTRAINT person_profile_link_requests_terminal_reason_check
    CHECK (
      (
        status = 'pending'
        AND confirmed_at IS NULL
        AND terminal_reason IS NULL
      )
      OR (
        status = 'accepted'
        AND confirmed_at IS NOT NULL
        AND terminal_reason IS NULL
      )
      OR (
        status = 'expired'
        AND confirmed_at IS NULL
        AND terminal_reason = 'expired'
      )
      OR (
        status = 'cancelled'
        AND confirmed_at IS NULL
        AND terminal_reason IN (
          'target_membership_inactive',
          'profile_unavailable',
          'target_membership_has_profile',
          'profile_changed'
        )
      )
  );

-- link lifecycle 的 409 可能伴随已经物化并提交的终态。保留完成 marker
-- 才能让丢响应后的同 key 重放同一失败，而不是在状态变化后重新执行。
ALTER TABLE public.idempotency_records
  DROP CONSTRAINT idempotency_records_status_check;
ALTER TABLE public.idempotency_records
  ADD CONSTRAINT idempotency_records_status_check CHECK (
    status_code IS NULL
    OR status_code BETWEEN 200 AND 299
    OR (
      status_code = 409
      AND normalized_route IN (
        '/api/v1/households/{id}/person-profiles/{profileId}/link-requests',
        '/api/v1/households/{id}/person-profile-link-requests/{requestId}/confirm'
      )
      AND response_body->>'ok' = 'false'
      AND response_body->'error'->>'code' = 'CONFLICT'
    )
  );

-- 新列同样属于 owner 创建、target 只读的资源；应用角色不能自行 UPDATE。
DROP POLICY person_profile_link_requests_insert
  ON public.person_profile_link_requests;
CREATE POLICY person_profile_link_requests_insert
ON public.person_profile_link_requests
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND initiated_by_user_id = meal_agent_private.app_user_id()
  AND meal_agent_private.is_active_owner(household_id)
  AND status = 'pending'
  AND confirmed_at IS NULL
  AND terminal_reason IS NULL
  AND version = 0
  AND disclosure_version = 1
  AND profile_version_at_request >= 0
  AND disclosed_household_hard_count >= 0
  AND disclosed_household_soft_count >= 0
  AND disclosed_private_constraint_count >= 0
);

-- ---------------------------------------------------------------------------
-- 2. Link 生命周期：household lock 是所有关联路径的第一把锁。
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
  meal_agent_private.materialize_person_profile_link_requests(
    p_household_id uuid,
    p_profile_id uuid,
    p_target_membership_id uuid
  )
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
DECLARE
  v_user_id uuid := NULLIF(
    pg_catalog.current_setting('app.user_id', true),
    ''
  )::uuid;
  v_context_household_id uuid := NULLIF(
    pg_catalog.current_setting('app.household_id', true),
    ''
  )::uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_request public.person_profile_link_requests%ROWTYPE;
  v_target public.memberships%ROWTYPE;
  v_profile public.person_profiles%ROWTYPE;
  v_changed integer := 0;
BEGIN
  IF v_user_id IS NULL
     OR v_context_household_id IS DISTINCT FROM p_household_id
     OR NOT EXISTS (
       SELECT 1
       FROM public.memberships
       WHERE household_id = p_household_id
         AND user_id = v_user_id
         AND status = 'active'
     ) THEN
    RETURN 0;
  END IF;

  -- household 级锁先于 request/profile/membership 行锁。它避免 OR 范围跨越
  -- 多 target 时形成锁环，并让 self-create 与 confirm 使用同一确定性顺序。
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'person-profile-links:' || p_household_id::text,
      0
    )
  );

  FOR v_request IN
    SELECT *
    FROM public.person_profile_link_requests
    WHERE household_id = p_household_id
      AND status = 'pending'
      AND (
        (p_profile_id IS NULL AND p_target_membership_id IS NULL)
        OR (p_profile_id IS NOT NULL AND profile_id = p_profile_id)
        OR (
          p_target_membership_id IS NOT NULL
          AND target_membership_id = p_target_membership_id
        )
      )
    ORDER BY target_membership_id, profile_id, id
    FOR UPDATE
  LOOP
    SELECT * INTO v_profile
    FROM public.person_profiles
    WHERE household_id = p_household_id
      AND id = v_request.profile_id
    FOR UPDATE;

    SELECT * INTO v_target
    FROM public.memberships
    WHERE household_id = p_household_id
      AND id = v_request.target_membership_id
    FOR UPDATE;

    IF v_request.expires_at <= v_now THEN
      UPDATE public.person_profile_link_requests
      SET status = 'expired',
          terminal_reason = 'expired',
          version = version + 1
      WHERE id = v_request.id;
      v_changed := v_changed + 1;
    ELSIF v_target.id IS NULL OR v_target.status <> 'active' THEN
      UPDATE public.person_profile_link_requests
      SET status = 'cancelled',
          terminal_reason = 'target_membership_inactive',
          version = version + 1
      WHERE id = v_request.id;
      v_changed := v_changed + 1;
    ELSIF v_profile.id IS NULL
          OR v_profile.status <> 'active'
          OR v_profile.linked_membership_id IS NOT NULL THEN
      UPDATE public.person_profile_link_requests
      SET status = 'cancelled',
          terminal_reason = 'profile_unavailable',
          version = version + 1
      WHERE id = v_request.id;
      v_changed := v_changed + 1;
    ELSIF v_profile.version <> v_request.profile_version_at_request THEN
      UPDATE public.person_profile_link_requests
      SET status = 'cancelled',
          terminal_reason = 'profile_changed',
          version = version + 1
      WHERE id = v_request.id;
      v_changed := v_changed + 1;
    ELSIF EXISTS (
      SELECT 1
      FROM public.person_profiles
      WHERE household_id = p_household_id
        AND linked_membership_id = v_request.target_membership_id
    ) THEN
      UPDATE public.person_profile_link_requests
      SET status = 'cancelled',
          terminal_reason = 'target_membership_has_profile',
          version = version + 1
      WHERE id = v_request.id;
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  IF p_profile_id IS NOT NULL THEN
    PERFORM 1
    FROM public.person_profiles
    WHERE household_id = p_household_id
      AND id = p_profile_id
    FOR UPDATE;
  END IF;
  IF p_target_membership_id IS NOT NULL THEN
    PERFORM 1
    FROM public.memberships
    WHERE household_id = p_household_id
      AND id = p_target_membership_id
    FOR UPDATE;
  END IF;

  RETURN v_changed;
END;
$function$;

CREATE OR REPLACE FUNCTION
  meal_agent_private.confirm_person_profile_link(
    p_request_id uuid,
    p_expected_version integer
  )
RETURNS TABLE (
  result_code text,
  out_profile_id uuid,
  out_profile_version integer,
  out_request_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
DECLARE
  v_user_id uuid := NULLIF(
    pg_catalog.current_setting('app.user_id', true),
    ''
  )::uuid;
  v_household_id uuid := NULLIF(
    pg_catalog.current_setting('app.household_id', true),
    ''
  )::uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_request public.person_profile_link_requests%ROWTYPE;
  v_target public.memberships%ROWTYPE;
  v_profile public.person_profiles%ROWTYPE;
BEGIN
  IF p_expected_version IS NULL THEN
    RETURN QUERY SELECT
      'invalid_expected_version'::text, NULL::uuid, NULL::integer,
      NULL::integer;
    RETURN;
  END IF;

  SELECT * INTO v_request
  FROM public.person_profile_link_requests
  WHERE id = p_request_id
    AND household_id = v_household_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_found'::text, NULL::uuid, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  -- 先取得全 household 不变量锁，并在同一事务内物化所有相关终态。
  PERFORM meal_agent_private.materialize_person_profile_link_requests(
    v_household_id,
    v_request.profile_id,
    v_request.target_membership_id
  );

  SELECT * INTO v_request
  FROM public.person_profile_link_requests
  WHERE id = p_request_id
    AND household_id = v_household_id
  FOR UPDATE;

  SELECT * INTO v_target
  FROM public.memberships
  WHERE household_id = v_household_id
    AND id = v_request.target_membership_id
  FOR UPDATE;

  IF v_target.id IS NULL OR v_target.user_id <> v_user_id THEN
    RETURN QUERY SELECT
      'forbidden'::text, v_request.profile_id, NULL::integer,
      v_request.version;
    RETURN;
  END IF;
  IF v_request.status <> 'pending' THEN
    RETURN QUERY SELECT
      CASE
        WHEN v_request.terminal_reason IS NULL THEN 'not_pending'::text
        ELSE v_request.terminal_reason::text
      END,
      v_request.profile_id, NULL::integer, v_request.version;
    RETURN;
  END IF;
  IF v_request.version <> p_expected_version THEN
    RETURN QUERY SELECT
      'version_conflict'::text, v_request.profile_id, NULL::integer,
      v_request.version;
    RETURN;
  END IF;

  SELECT * INTO v_profile
  FROM public.person_profiles
  WHERE household_id = v_household_id
    AND id = v_request.profile_id
  FOR UPDATE;
  -- materialize 已在相同 household lock 下验证；这里的防御分支仍将终态
  -- 持久化，且 repository 会在事务提交后才映射为 409。
  IF v_profile.id IS NULL
     OR v_profile.status <> 'active'
     OR v_profile.linked_membership_id IS NOT NULL
     OR v_profile.version <> v_request.profile_version_at_request THEN
    UPDATE public.person_profile_link_requests
    SET status = 'cancelled',
        terminal_reason = CASE
          WHEN v_profile.id IS NOT NULL
               AND v_profile.status = 'active'
               AND v_profile.linked_membership_id IS NULL
            THEN 'profile_changed'
          ELSE 'profile_unavailable'
        END,
        version = version + 1
    WHERE id = v_request.id;
    RETURN QUERY SELECT
      CASE
        WHEN v_profile.id IS NOT NULL
             AND v_profile.status = 'active'
             AND v_profile.linked_membership_id IS NULL
          THEN 'profile_changed'
        ELSE 'profile_unavailable'
      END::text,
      v_request.profile_id, NULL::integer, v_request.version + 1;
    RETURN;
  END IF;

  UPDATE public.person_profiles
  SET linked_membership_id = v_target.id,
      updated_at = v_now,
      version = version + 1
  WHERE id = v_profile.id;

  UPDATE public.person_profile_link_requests
  SET status = 'accepted',
      confirmed_at = v_now,
      terminal_reason = NULL,
      version = version + 1
  WHERE id = v_request.id;

  UPDATE public.person_profile_link_requests
  SET status = 'cancelled',
      terminal_reason = 'target_membership_has_profile',
      version = version + 1
  WHERE household_id = v_household_id
    AND target_membership_id = v_target.id
    AND id <> v_request.id
    AND status = 'pending';

  RETURN QUERY SELECT
    'linked'::text, v_profile.id, v_profile.version + 1,
    v_request.version + 1;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. JSONB constraint 边界：任何失败都发生在 profile UPDATE 之前。
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
  meal_agent_private.add_person_profile_constraint(
    p_profile_id uuid,
    p_expected_version integer,
    p_constraint_id uuid,
    p_constraint_input jsonb,
    p_hard_confirmed boolean
  )
RETURNS TABLE (
  result_code text,
  out_profile_id uuid,
  out_status text,
  out_version integer,
  out_constraint_id uuid,
  out_updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
DECLARE
  v_user_id uuid := NULLIF(
    pg_catalog.current_setting('app.user_id', true),
    ''
  )::uuid;
  v_household_id uuid := NULLIF(
    pg_catalog.current_setting('app.household_id', true),
    ''
  )::uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_profile public.person_profiles%ROWTYPE;
  v_role text;
  v_enforcement text := p_constraint_input->>'enforcement';
  v_kind text := p_constraint_input->>'kind';
  v_visibility text := p_constraint_input->>'visibility';
  v_label text := p_constraint_input->>'label';
  v_constraint jsonb;
  v_invalid boolean := false;
BEGIN
  IF p_expected_version IS NULL THEN
    RETURN QUERY SELECT
      'invalid_expected_version'::text, NULL::uuid, NULL::text,
      NULL::integer, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT role INTO v_role
  FROM public.memberships
  WHERE household_id = v_household_id
    AND user_id = v_user_id
    AND status = 'active';
  SELECT * INTO v_profile
  FROM public.person_profiles
  WHERE household_id = v_household_id
    AND id = p_profile_id
  FOR UPDATE;
  IF v_profile.id IS NULL OR v_role IS NULL THEN
    RETURN QUERY SELECT
      'not_found'::text, NULL::uuid, NULL::text, NULL::integer,
      NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_role <> 'owner' AND NOT EXISTS (
    SELECT 1
    FROM public.memberships
    WHERE household_id = v_household_id
      AND id = v_profile.linked_membership_id
      AND user_id = v_user_id
      AND status = 'active'
  ) THEN
    RETURN QUERY SELECT
      'forbidden'::text, v_profile.id, v_profile.status::text,
      v_profile.version, NULL::uuid, v_profile.updated_at;
    RETURN;
  END IF;
  IF v_profile.version <> p_expected_version THEN
    RETURN QUERY SELECT
      'version_conflict'::text, v_profile.id, v_profile.status::text,
      v_profile.version, NULL::uuid, v_profile.updated_at;
    RETURN;
  END IF;
  IF v_profile.status <> 'active' THEN
    RETURN QUERY SELECT
      'profile_inactive'::text, v_profile.id, v_profile.status::text,
      v_profile.version, NULL::uuid, v_profile.updated_at;
    RETURN;
  END IF;

  IF p_constraint_id IS NULL
     OR pg_catalog.jsonb_typeof(p_constraint_input)
        IS DISTINCT FROM 'object'
     OR v_label IS NULL
     OR pg_catalog.length(v_label) NOT BETWEEN 1 AND 120
     OR v_visibility IS NULL
     OR v_visibility NOT IN ('household', 'subject_and_owner')
     OR pg_catalog.jsonb_typeof(p_constraint_input->'foodConceptIds')
        IS DISTINCT FROM 'array'
     OR (
       p_constraint_input ? 'notes'
       AND pg_catalog.jsonb_typeof(p_constraint_input->'notes')
           IS DISTINCT FROM 'string'
     ) THEN
    RETURN QUERY SELECT
      'invalid_constraint'::text, v_profile.id, v_profile.status::text,
      v_profile.version, NULL::uuid, v_profile.updated_at;
    RETURN;
  END IF;

  v_invalid :=
    pg_catalog.jsonb_array_length(
      p_constraint_input->'foodConceptIds'
    ) > 100
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(
        p_constraint_input->'foodConceptIds'
      ) AS item(value)
      WHERE pg_catalog.jsonb_typeof(item.value) <> 'string'
         OR item.value #>> '{}' !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    OR (
      SELECT pg_catalog.count(*) <>
             pg_catalog.count(DISTINCT item.value #>> '{}')
      FROM pg_catalog.jsonb_array_elements(
        p_constraint_input->'foodConceptIds'
      ) AS item(value)
    )
    OR (
      p_constraint_input ? 'notes'
      AND pg_catalog.length(p_constraint_input->>'notes') > 500
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(
        v_profile.dietary_constraints
      ) AS existing(value)
      WHERE existing.value->>'id' = p_constraint_id::text
    );

  IF v_enforcement = 'hard' THEN
    IF pg_catalog.jsonb_typeof(p_constraint_input->'allergenCodes')
       IS DISTINCT FROM 'array' THEN
      RETURN QUERY SELECT
        'invalid_constraint'::text, v_profile.id, v_profile.status::text,
        v_profile.version, NULL::uuid, v_profile.updated_at;
      RETURN;
    END IF;
    v_invalid := v_invalid
      OR p_constraint_input - ARRAY[
        'kind', 'enforcement', 'label', 'foodConceptIds',
        'allergenCodes', 'notes', 'visibility'
      ]::text[] <> '{}'::jsonb
      OR v_kind IS NULL
      OR v_kind NOT IN (
        'allergy',
        'religious',
        'ethical',
        'explicit_avoid',
        'food_safety_exclusion'
      )
      OR pg_catalog.jsonb_array_length(
           p_constraint_input->'allergenCodes'
         ) > 100
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(
          p_constraint_input->'allergenCodes'
        ) AS item(value)
        WHERE pg_catalog.jsonb_typeof(item.value) <> 'string'
           OR pg_catalog.length(item.value #>> '{}') NOT BETWEEN 1 AND 64
      )
      OR (
        SELECT pg_catalog.count(*) <>
               pg_catalog.count(DISTINCT item.value #>> '{}')
        FROM pg_catalog.jsonb_array_elements(
          p_constraint_input->'allergenCodes'
        ) AS item(value)
      );
  ELSIF v_enforcement = 'soft' THEN
    v_invalid := v_invalid
      OR p_constraint_input - ARRAY[
        'kind', 'enforcement', 'label', 'preference',
        'foodConceptIds', 'notes', 'visibility'
      ]::text[] <> '{}'::jsonb
      OR v_kind IS DISTINCT FROM 'preference'
      OR p_constraint_input->>'preference' IS NULL
      OR p_constraint_input->>'preference' NOT IN ('prefer', 'dislike');
  ELSE
    v_invalid := true;
  END IF;

  IF v_invalid THEN
    RETURN QUERY SELECT
      'invalid_constraint'::text, v_profile.id, v_profile.status::text,
      v_profile.version, NULL::uuid, v_profile.updated_at;
    RETURN;
  END IF;
  IF v_enforcement = 'hard' AND p_hard_confirmed IS DISTINCT FROM true THEN
    RETURN QUERY SELECT
      'confirmation_required'::text, v_profile.id,
      v_profile.status::text, v_profile.version, NULL::uuid,
      v_profile.updated_at;
    RETURN;
  END IF;

  IF v_enforcement = 'hard' THEN
    v_constraint := pg_catalog.jsonb_build_object(
      'id', p_constraint_id,
      'kind', v_kind,
      'enforcement', 'hard',
      'label', v_label,
      'foodConceptIds', p_constraint_input->'foodConceptIds',
      'allergenCodes', p_constraint_input->'allergenCodes',
      'mappingStatus', 'needs_structured_mapping',
      'visibility', v_visibility,
      'confirmedAt', v_now,
      'confirmedByUserId', v_user_id
    );
  ELSE
    v_constraint := pg_catalog.jsonb_build_object(
      'id', p_constraint_id,
      'kind', 'preference',
      'enforcement', 'soft',
      'label', v_label,
      'preference', p_constraint_input->>'preference',
      'foodConceptIds', p_constraint_input->'foodConceptIds',
      'visibility', v_visibility,
      'confirmedAt', v_now,
      'confirmedByUserId', v_user_id
    );
  END IF;

  IF p_constraint_input ? 'notes' THEN
    v_constraint := v_constraint || pg_catalog.jsonb_build_object(
      'notes',
      p_constraint_input->>'notes'
    );
  END IF;

  UPDATE public.person_profiles
  SET dietary_constraints =
        dietary_constraints || pg_catalog.jsonb_build_array(v_constraint),
      updated_at = v_now,
      version = version + 1
  WHERE id = v_profile.id;

  RETURN QUERY SELECT
    'changed'::text, v_profile.id, v_profile.status::text,
    v_profile.version + 1, p_constraint_id, v_now;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. 保持 SECURITY DEFINER owner/search_path/EXECUTE 边界明确。
-- ---------------------------------------------------------------------------

ALTER FUNCTION
  meal_agent_private.materialize_person_profile_link_requests(
    uuid, uuid, uuid
  ) OWNER TO meal_agent_migrator;
ALTER FUNCTION
  meal_agent_private.confirm_person_profile_link(uuid, integer)
  OWNER TO meal_agent_migrator;
ALTER FUNCTION
  meal_agent_private.add_person_profile_constraint(
    uuid, integer, uuid, jsonb, boolean
  ) OWNER TO meal_agent_migrator;

REVOKE ALL ON FUNCTION
  meal_agent_private.materialize_person_profile_link_requests(
    uuid, uuid, uuid
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  meal_agent_private.confirm_person_profile_link(uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  meal_agent_private.add_person_profile_constraint(
    uuid, integer, uuid, jsonb, boolean
  ) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  meal_agent_private.materialize_person_profile_link_requests(
    uuid, uuid, uuid
  ) TO meal_agent_app;
GRANT EXECUTE ON FUNCTION
  meal_agent_private.confirm_person_profile_link(uuid, integer)
  TO meal_agent_app;
GRANT EXECUTE ON FUNCTION
  meal_agent_private.add_person_profile_constraint(
    uuid, integer, uuid, jsonb, boolean
  ) TO meal_agent_app;
