-- 阶段 08 二次审计整改。
--
-- 不修改 0000/0001/0002 及其 checksum。本迁移在一个事务内：
--   1. 收紧 PersonProfile 与幂等 RLS；
--   2. 用内部时钟和安全默认值替换 SECURITY DEFINER 签名；
--   3. 统一 profile/member 锁顺序并物化 link request 生命周期；
--   4. 把所有未经权威词表映射的 hard constraint 降为安全阻断状态。

-- ---------------------------------------------------------------------------
-- 1. Link request 终态与 hard constraint 数据约束。
-- ---------------------------------------------------------------------------

ALTER TABLE public.person_profile_link_requests
  ADD COLUMN terminal_reason varchar(64);

UPDATE public.person_profile_link_requests
SET terminal_reason = CASE status
  WHEN 'expired' THEN 'expired'
  WHEN 'cancelled' THEN 'profile_unavailable'
  ELSE NULL
END;

ALTER TABLE public.person_profile_link_requests
  DROP CONSTRAINT person_profile_link_requests_confirmation_check;

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
          'target_membership_has_profile'
        )
      )
    );

-- 当前没有权威 allergen / food concept / 宗教 / 伦理 / 食品安全词表。
-- 任何历史 "structured" 只代表形状校验，不能继续冒充机器可执行映射。
UPDATE public.person_profiles AS profile
SET dietary_constraints = transformed.constraints,
    updated_at = pg_catalog.clock_timestamp(),
    version = profile.version + 1
FROM (
  SELECT
    source.id,
    coalesce(
      pg_catalog.jsonb_agg(
        CASE
          WHEN item.value->>'enforcement' = 'hard' THEN
            item.value || pg_catalog.jsonb_build_object(
              'mappingStatus',
              'needs_structured_mapping'
            )
          ELSE item.value
        END
        ORDER BY item.ordinality
      ) FILTER (WHERE item.value IS NOT NULL),
      '[]'::jsonb
    ) AS constraints
  FROM public.person_profiles AS source
  LEFT JOIN LATERAL pg_catalog.jsonb_array_elements(
    source.dietary_constraints
  ) WITH ORDINALITY AS item(value, ordinality) ON true
  GROUP BY source.id
) AS transformed
WHERE profile.id = transformed.id
  AND profile.dietary_constraints IS DISTINCT FROM transformed.constraints;

CREATE FUNCTION meal_agent_private.stage08_constraints_are_safe(
  p_constraints jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT
    pg_catalog.jsonb_typeof(p_constraints) = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_constraints) AS item(value)
      WHERE item.value->>'enforcement' = 'hard'
        AND item.value->>'mappingStatus'
            IS DISTINCT FROM 'needs_structured_mapping'
    );
$function$;

ALTER FUNCTION meal_agent_private.stage08_constraints_are_safe(jsonb)
  OWNER TO meal_agent_migrator;
REVOKE ALL ON FUNCTION
  meal_agent_private.stage08_constraints_are_safe(jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  meal_agent_private.stage08_constraints_are_safe(jsonb)
  TO meal_agent_app;

ALTER TABLE public.person_profiles
  ADD CONSTRAINT person_profiles_hard_mapping_status_check
    CHECK (
      meal_agent_private.stage08_constraints_are_safe(
        dietary_constraints
      )
    );

-- ---------------------------------------------------------------------------
-- 2. 幂等：membership removal 可在 active membership 消失后完成和重放。
-- ---------------------------------------------------------------------------

DROP POLICY idempotency_records_scope_select
  ON public.idempotency_records;
DROP POLICY idempotency_records_scope_insert
  ON public.idempotency_records;
DROP POLICY idempotency_records_scope_update
  ON public.idempotency_records;

CREATE POLICY idempotency_records_scope_select
ON public.idempotency_records
FOR SELECT TO meal_agent_app
USING (
  user_id = meal_agent_private.app_user_id()
  AND (
    (scope_kind = 'user' AND household_id IS NULL)
    OR (
      scope_kind = 'household'
      AND household_id = meal_agent_private.app_household_id()
      AND (
        meal_agent_private.has_active_membership(household_id)
        OR (
          method = 'DELETE'
          AND normalized_route =
            '/api/v1/households/{id}/memberships/{membershipId}'
        )
      )
    )
  )
);

CREATE POLICY idempotency_records_scope_insert
ON public.idempotency_records
FOR INSERT TO meal_agent_app
WITH CHECK (
  user_id = meal_agent_private.app_user_id()
  AND status_code IS NULL
  AND response_body IS NULL
  AND (
    (scope_kind = 'user' AND household_id IS NULL)
    OR (
      scope_kind = 'household'
      AND household_id = meal_agent_private.app_household_id()
      AND (
        meal_agent_private.has_active_membership(household_id)
        OR (
          method = 'DELETE'
          AND normalized_route =
            '/api/v1/households/{id}/memberships/{membershipId}'
        )
      )
    )
  )
);

CREATE POLICY idempotency_records_scope_update
ON public.idempotency_records
FOR UPDATE TO meal_agent_app
USING (
  user_id = meal_agent_private.app_user_id()
  AND (
    (scope_kind = 'user' AND household_id IS NULL)
    OR (
      scope_kind = 'household'
      AND household_id = meal_agent_private.app_household_id()
      AND (
        meal_agent_private.has_active_membership(household_id)
        OR (
          method = 'DELETE'
          AND normalized_route =
            '/api/v1/households/{id}/memberships/{membershipId}'
        )
      )
    )
  )
)
WITH CHECK (
  user_id = meal_agent_private.app_user_id()
  AND (
    (scope_kind = 'user' AND household_id IS NULL)
    OR (
      scope_kind = 'household'
      AND household_id = meal_agent_private.app_household_id()
      AND (
        meal_agent_private.has_active_membership(household_id)
        OR (
          method = 'DELETE'
          AND normalized_route =
            '/api/v1/households/{id}/memberships/{membershipId}'
        )
      )
    )
  )
);

-- ---------------------------------------------------------------------------
-- 3. PersonProfile 表权限：身份字段永远不能由应用角色直接 UPDATE。
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS person_profiles_manage_update
  ON public.person_profiles;
REVOKE UPDATE ON public.person_profiles FROM meal_agent_app;

DROP POLICY person_profiles_household_insert
  ON public.person_profiles;
CREATE POLICY person_profiles_household_insert
ON public.person_profiles
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
  AND status = 'active'
  AND version = 0
  AND dietary_constraints = '[]'::jsonb
  AND (
    (
      linked_membership_id IS NULL
      AND meal_agent_private.is_active_owner(household_id)
    )
    OR (
      linked_membership_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.memberships AS linked
        WHERE linked.household_id = person_profiles.household_id
          AND linked.id = person_profiles.linked_membership_id
          AND linked.user_id = meal_agent_private.app_user_id()
          AND linked.status = 'active'
      )
    )
  )
);

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
);

-- ---------------------------------------------------------------------------
-- 4. 删除旧 SECURITY DEFINER 签名；时间与 capabilities 不再由调用方传入。
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION meal_agent_private.redeem_household_invite(
  char, uuid, jsonb, timestamptz
) FROM meal_agent_app;
REVOKE ALL ON FUNCTION meal_agent_private.transition_membership_status(
  uuid, integer, timestamptz
) FROM meal_agent_app;
REVOKE ALL ON FUNCTION meal_agent_private.confirm_person_profile_link(
  uuid, integer, timestamptz
) FROM meal_agent_app;

DROP FUNCTION meal_agent_private.redeem_household_invite(
  char, uuid, jsonb, timestamptz
);
DROP FUNCTION meal_agent_private.transition_membership_status(
  uuid, integer, timestamptz
);
DROP FUNCTION meal_agent_private.confirm_person_profile_link(
  uuid, integer, timestamptz
);

CREATE FUNCTION meal_agent_private.redeem_household_invite(
  p_code_digest char(64),
  p_membership_id uuid
)
RETURNS TABLE (
  result_code text,
  out_household_id uuid,
  out_membership_id uuid
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
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_invite public.household_invites%ROWTYPE;
  v_membership public.memberships%ROWTYPE;
  v_next_used integer;
  v_membership_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT 'no_user'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO v_invite
  FROM public.household_invites
  WHERE code_digest = p_code_digest
  FOR UPDATE;

  IF NOT FOUND
     OR v_invite.status <> 'active'
     OR v_invite.expires_at <= v_now
     OR v_invite.used_count >= v_invite.max_uses THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'redeem-membership:' || v_invite.household_id::text || ':' ||
      v_user_id::text,
      0
    )
  );

  SELECT * INTO v_membership
  FROM public.memberships
  WHERE household_id = v_invite.household_id
    AND user_id = v_user_id
  FOR UPDATE;

  IF FOUND AND v_membership.status = 'active' THEN
    RETURN QUERY
      SELECT 'already_member'::text, v_invite.household_id, v_membership.id;
    RETURN;
  END IF;

  v_next_used := v_invite.used_count + 1;

  IF FOUND THEN
    UPDATE public.memberships
    SET role = 'member',
        capabilities = '[]'::jsonb,
        status = 'active',
        joined_at = v_now,
        updated_at = v_now,
        version = version + 1
    WHERE id = v_membership.id;
    v_membership_id := v_membership.id;
  ELSE
    INSERT INTO public.memberships (
      id, household_id, user_id, role, capabilities, status,
      joined_at, updated_at, version
    ) VALUES (
      p_membership_id, v_invite.household_id, v_user_id, 'member',
      '[]'::jsonb, 'active', v_now, v_now, 0
    );
    v_membership_id := p_membership_id;
  END IF;

  UPDATE public.household_invites
  SET used_count = v_next_used,
      status = CASE
        WHEN v_next_used >= max_uses THEN 'exhausted'
        ELSE status
      END,
      version = version + 1
  WHERE id = v_invite.id;

  RETURN QUERY
    SELECT 'joined'::text, v_invite.household_id, v_membership_id;
END;
$function$;

CREATE FUNCTION meal_agent_private.materialize_person_profile_link_requests(
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
  v_candidate public.person_profile_link_requests%ROWTYPE;
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

  -- 指定 target 时，即使当前没有 pending request，也必须先持有同一成员
  -- 不变量锁；这样直接创建 linked profile 与确认关联使用完全相同的锁。
  IF p_target_membership_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'person-profile-membership:' || p_household_id::text || ':' ||
        p_target_membership_id::text,
        0
      )
    );
    PERFORM 1
    FROM public.memberships
    WHERE household_id = p_household_id
      AND id = p_target_membership_id
    FOR UPDATE;
  END IF;

  FOR v_candidate IN
    SELECT *
    FROM public.person_profile_link_requests
    WHERE household_id = p_household_id
      AND status = 'pending'
      AND (p_profile_id IS NULL OR profile_id = p_profile_id)
      AND (
        p_target_membership_id IS NULL
        OR target_membership_id = p_target_membership_id
      )
    ORDER BY target_membership_id, id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'person-profile-membership:' || p_household_id::text || ':' ||
        v_candidate.target_membership_id::text,
        0
      )
    );

    SELECT * INTO v_target
    FROM public.memberships
    WHERE household_id = p_household_id
      AND id = v_candidate.target_membership_id
    FOR UPDATE;

    SELECT * INTO v_request
    FROM public.person_profile_link_requests
    WHERE household_id = p_household_id
      AND id = v_candidate.id
    FOR UPDATE;
    IF NOT FOUND OR v_request.status <> 'pending' THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_profile
    FROM public.person_profiles
    WHERE household_id = p_household_id
      AND id = v_request.profile_id
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

  RETURN v_changed;
END;
$function$;

CREATE FUNCTION meal_agent_private.transition_membership_status(
  p_target_membership_id uuid,
  p_expected_version integer
)
RETURNS TABLE (
  result_code text,
  out_membership_id uuid,
  out_status text,
  out_version integer,
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
  v_actor public.memberships%ROWTYPE;
  v_target public.memberships%ROWTYPE;
  v_next_status text;
  v_owner_count integer;
BEGIN
  IF p_expected_version IS NULL THEN
    RETURN QUERY SELECT
      'invalid_expected_version'::text, NULL::uuid, NULL::text,
      NULL::integer, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_user_id IS NULL OR v_household_id IS NULL THEN
    RETURN QUERY SELECT
      'not_found'::text, NULL::uuid, NULL::text, NULL::integer,
      NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'household-memberships:' || v_household_id::text,
      0
    )
  );

  SELECT * INTO v_actor
  FROM public.memberships
  WHERE household_id = v_household_id
    AND user_id = v_user_id
    AND status = 'active'
  FOR UPDATE;

  SELECT * INTO v_target
  FROM public.memberships
  WHERE household_id = v_household_id
    AND id = p_target_membership_id
  FOR UPDATE;

  IF v_target.id IS NULL OR v_actor.id IS NULL
     OR v_target.status <> 'active' THEN
    RETURN QUERY SELECT
      'not_found'::text, NULL::uuid, NULL::text, NULL::integer,
      NULL::timestamptz;
    RETURN;
  END IF;
  IF v_target.version <> p_expected_version THEN
    RETURN QUERY SELECT
      'version_conflict'::text, v_target.id, v_target.status::text,
      v_target.version, v_target.updated_at;
    RETURN;
  END IF;
  IF v_actor.role <> 'owner' AND v_actor.id <> v_target.id THEN
    RETURN QUERY SELECT
      'forbidden'::text, v_target.id, v_target.status::text,
      v_target.version, v_target.updated_at;
    RETURN;
  END IF;

  IF v_target.role = 'owner' THEN
    SELECT pg_catalog.count(*)::integer INTO v_owner_count
    FROM public.memberships
    WHERE household_id = v_household_id
      AND role = 'owner'
      AND status = 'active';
    IF v_owner_count <= 1 THEN
      RETURN QUERY SELECT
        'last_owner'::text, v_target.id, v_target.status::text,
        v_target.version, v_target.updated_at;
      RETURN;
    END IF;
  END IF;

  v_next_status := CASE
    WHEN v_actor.id = v_target.id THEN 'left'
    ELSE 'removed'
  END;

  UPDATE public.memberships
  SET status = v_next_status,
      updated_at = v_now,
      version = version + 1
  WHERE id = v_target.id;

  UPDATE public.person_profile_link_requests
  SET status = 'cancelled',
      terminal_reason = 'target_membership_inactive',
      version = version + 1
  WHERE household_id = v_household_id
    AND target_membership_id = v_target.id
    AND status = 'pending';

  UPDATE public.person_profiles
  SET status = 'archived',
      updated_at = v_now,
      version = version + 1
  WHERE household_id = v_household_id
    AND linked_membership_id = v_target.id
    AND status = 'active';

  UPDATE public.person_profile_link_requests AS link_request
  SET status = 'cancelled',
      terminal_reason = 'profile_unavailable',
      version = link_request.version + 1
  FROM public.person_profiles AS profile
  WHERE link_request.household_id = v_household_id
    AND link_request.profile_id = profile.id
    AND profile.household_id = v_household_id
    AND profile.linked_membership_id = v_target.id
    AND link_request.status = 'pending';

  RETURN QUERY SELECT
    'changed'::text, v_target.id, v_next_status,
    v_target.version + 1, v_now;
END;
$function$;

CREATE FUNCTION meal_agent_private.confirm_person_profile_link(
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
  v_snapshot public.person_profile_link_requests%ROWTYPE;
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

  SELECT * INTO v_snapshot
  FROM public.person_profile_link_requests
  WHERE id = p_request_id
    AND household_id = v_household_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_found'::text, NULL::uuid, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'person-profile-membership:' || v_household_id::text || ':' ||
      v_snapshot.target_membership_id::text,
      0
    )
  );

  SELECT * INTO v_target
  FROM public.memberships
  WHERE id = v_snapshot.target_membership_id
    AND household_id = v_household_id
  FOR UPDATE;

  SELECT * INTO v_request
  FROM public.person_profile_link_requests
  WHERE id = p_request_id
    AND household_id = v_household_id
  FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'pending' THEN
    RETURN QUERY SELECT
      'not_found'::text, v_snapshot.profile_id, NULL::integer,
      v_request.version;
    RETURN;
  END IF;

  SELECT * INTO v_profile
  FROM public.person_profiles
  WHERE id = v_request.profile_id
    AND household_id = v_household_id
  FOR UPDATE;

  IF v_request.expires_at <= v_now THEN
    UPDATE public.person_profile_link_requests
    SET status = 'expired',
        terminal_reason = 'expired',
        version = version + 1
    WHERE id = v_request.id;
    RETURN QUERY SELECT
      'expired'::text, v_request.profile_id, NULL::integer,
      v_request.version + 1;
    RETURN;
  END IF;
  IF v_target.id IS NULL OR v_target.status <> 'active' THEN
    UPDATE public.person_profile_link_requests
    SET status = 'cancelled',
        terminal_reason = 'target_membership_inactive',
        version = version + 1
    WHERE id = v_request.id;
    RETURN QUERY SELECT
      'target_inactive'::text, v_request.profile_id, NULL::integer,
      v_request.version + 1;
    RETURN;
  END IF;
  IF v_target.user_id <> v_user_id THEN
    RETURN QUERY SELECT
      'forbidden'::text, v_request.profile_id, NULL::integer,
      v_request.version;
    RETURN;
  END IF;
  IF v_profile.id IS NULL
     OR v_profile.status <> 'active'
     OR v_profile.linked_membership_id IS NOT NULL THEN
    UPDATE public.person_profile_link_requests
    SET status = 'cancelled',
        terminal_reason = 'profile_unavailable',
        version = version + 1
    WHERE id = v_request.id;
    RETURN QUERY SELECT
      'profile_unavailable'::text, v_request.profile_id, NULL::integer,
      v_request.version + 1;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.person_profiles
    WHERE household_id = v_household_id
      AND linked_membership_id = v_target.id
  ) THEN
    UPDATE public.person_profile_link_requests
    SET status = 'cancelled',
        terminal_reason = 'target_membership_has_profile',
        version = version + 1
    WHERE id = v_request.id;
    RETURN QUERY SELECT
      'membership_has_profile'::text, v_request.profile_id, NULL::integer,
      v_request.version + 1;
    RETURN;
  END IF;
  IF v_request.version <> p_expected_version THEN
    RETURN QUERY SELECT
      'version_conflict'::text, v_request.profile_id, NULL::integer,
      v_request.version;
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

  RETURN QUERY SELECT
    'linked'::text, v_profile.id, v_profile.version + 1,
    v_request.version + 1;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. PersonProfile 受控 mutation。函数不接收 household/link 身份字段。
-- ---------------------------------------------------------------------------

CREATE FUNCTION meal_agent_private.update_person_profile_fields(
  p_profile_id uuid,
  p_expected_version integer,
  p_set_display_name boolean,
  p_display_name text,
  p_set_default_participation boolean,
  p_default_participation integer,
  p_set_default_portion_scale boolean,
  p_default_portion_scale numeric,
  p_set_cooking_skill boolean,
  p_cooking_skill text
)
RETURNS TABLE (
  result_code text,
  out_profile_id uuid,
  out_status text,
  out_version integer,
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
BEGIN
  IF p_expected_version IS NULL THEN
    RETURN QUERY SELECT
      'invalid_expected_version'::text, NULL::uuid, NULL::text,
      NULL::integer, NULL::timestamptz;
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
      NULL::timestamptz;
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
      v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;
  IF v_profile.version <> p_expected_version THEN
    RETURN QUERY SELECT
      'version_conflict'::text, v_profile.id, v_profile.status::text,
      v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;
  IF v_profile.status <> 'active' THEN
    RETURN QUERY SELECT
      'profile_inactive'::text, v_profile.id, v_profile.status::text,
      v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;
  IF NOT (
    p_set_display_name
    OR p_set_default_participation
    OR p_set_default_portion_scale
    OR p_set_cooking_skill
  ) THEN
    RETURN QUERY SELECT
      'invalid_update'::text, v_profile.id, v_profile.status::text,
      v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;

  UPDATE public.person_profiles
  SET display_name = CASE
        WHEN p_set_display_name THEN p_display_name
        ELSE display_name
      END,
      default_participation = CASE
        WHEN p_set_default_participation THEN p_default_participation
        ELSE default_participation
      END,
      default_portion_scale = CASE
        WHEN p_set_default_portion_scale THEN p_default_portion_scale
        ELSE default_portion_scale
      END,
      cooking_skill = CASE
        WHEN p_set_cooking_skill THEN p_cooking_skill
        ELSE cooking_skill
      END,
      updated_at = v_now,
      version = version + 1
  WHERE id = v_profile.id;

  RETURN QUERY SELECT
    'changed'::text, v_profile.id, v_profile.status::text,
    v_profile.version + 1, v_now;
END;
$function$;

CREATE FUNCTION meal_agent_private.transition_person_profile_status(
  p_profile_id uuid,
  p_expected_version integer,
  p_operation text
)
RETURNS TABLE (
  result_code text,
  out_profile_id uuid,
  out_status text,
  out_version integer,
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
  v_pending public.person_profile_link_requests%ROWTYPE;
  v_profile public.person_profiles%ROWTYPE;
  v_role text;
  v_next_status text;
BEGIN
  IF p_expected_version IS NULL THEN
    RETURN QUERY SELECT
      'invalid_expected_version'::text, NULL::uuid, NULL::text,
      NULL::integer, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_operation NOT IN ('archive', 'restore') THEN
    RETURN QUERY SELECT
      'invalid_operation'::text, NULL::uuid, NULL::text,
      NULL::integer, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO v_pending
  FROM public.person_profile_link_requests
  WHERE household_id = v_household_id
    AND profile_id = p_profile_id
    AND status = 'pending'
  ORDER BY id
  LIMIT 1;

  IF v_pending.id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'person-profile-membership:' || v_household_id::text || ':' ||
        v_pending.target_membership_id::text,
        0
      )
    );
    PERFORM 1
    FROM public.memberships
    WHERE household_id = v_household_id
      AND id = v_pending.target_membership_id
    FOR UPDATE;
    PERFORM 1
    FROM public.person_profile_link_requests
    WHERE id = v_pending.id
    FOR UPDATE;
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
      NULL::timestamptz;
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
      v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;
  IF v_profile.version <> p_expected_version THEN
    RETURN QUERY SELECT
      'version_conflict'::text, v_profile.id, v_profile.status::text,
      v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;

  v_next_status := CASE p_operation
    WHEN 'archive' THEN 'archived'
    ELSE 'active'
  END;
  IF v_profile.status = v_next_status THEN
    RETURN QUERY SELECT
      'invalid_transition'::text, v_profile.id, v_profile.status::text,
      v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;
  IF p_operation = 'restore'
     AND v_profile.linked_membership_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.memberships
       WHERE household_id = v_household_id
         AND id = v_profile.linked_membership_id
         AND status = 'active'
     ) THEN
    RETURN QUERY SELECT
      'linked_membership_inactive'::text, v_profile.id,
      v_profile.status::text, v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;

  UPDATE public.person_profiles
  SET status = v_next_status,
      updated_at = v_now,
      version = version + 1
  WHERE id = v_profile.id;

  IF p_operation = 'archive' THEN
    UPDATE public.person_profile_link_requests
    SET status = 'cancelled',
        terminal_reason = 'profile_unavailable',
        version = version + 1
    WHERE household_id = v_household_id
      AND profile_id = v_profile.id
      AND status = 'pending';
  END IF;

  RETURN QUERY SELECT
    'changed'::text, v_profile.id, v_next_status,
    v_profile.version + 1, v_now;
END;
$function$;

CREATE FUNCTION meal_agent_private.add_person_profile_constraint(
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
  IF pg_catalog.jsonb_typeof(p_constraint_input) <> 'object'
     OR v_label IS NULL
     OR pg_catalog.length(v_label) NOT BETWEEN 1 AND 120
     OR v_visibility NOT IN ('household', 'subject_and_owner')
     OR pg_catalog.jsonb_typeof(p_constraint_input->'foodConceptIds')
        <> 'array' THEN
    RETURN QUERY SELECT
      'invalid_constraint'::text, v_profile.id, v_profile.status::text,
      v_profile.version, NULL::uuid, v_profile.updated_at;
    RETURN;
  END IF;

  IF v_enforcement = 'hard' THEN
    IF p_hard_confirmed IS DISTINCT FROM true
       OR v_kind NOT IN (
         'allergy',
         'religious',
         'ethical',
         'explicit_avoid',
         'food_safety_exclusion'
       )
       OR pg_catalog.jsonb_typeof(p_constraint_input->'allergenCodes')
          <> 'array'
       OR (
         v_kind = 'allergy'
         AND pg_catalog.jsonb_array_length(
           p_constraint_input->'foodConceptIds'
         ) = 0
         AND pg_catalog.jsonb_array_length(
           p_constraint_input->'allergenCodes'
         ) = 0
       ) THEN
      RETURN QUERY SELECT
        CASE
          WHEN p_hard_confirmed IS DISTINCT FROM true
            THEN 'confirmation_required'
          ELSE 'invalid_constraint'
        END,
        v_profile.id, v_profile.status::text, v_profile.version,
        NULL::uuid, v_profile.updated_at;
      RETURN;
    END IF;
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
  ELSIF v_enforcement = 'soft'
        AND v_kind = 'preference'
        AND p_constraint_input->>'preference' IN ('prefer', 'dislike') THEN
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
  ELSE
    RETURN QUERY SELECT
      'invalid_constraint'::text, v_profile.id, v_profile.status::text,
      v_profile.version, NULL::uuid, v_profile.updated_at;
    RETURN;
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

CREATE FUNCTION meal_agent_private.remove_person_profile_constraint(
  p_profile_id uuid,
  p_expected_version integer,
  p_constraint_id uuid
)
RETURNS TABLE (
  result_code text,
  out_profile_id uuid,
  out_status text,
  out_version integer,
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
  v_next jsonb;
BEGIN
  IF p_expected_version IS NULL THEN
    RETURN QUERY SELECT
      'invalid_expected_version'::text, NULL::uuid, NULL::text,
      NULL::integer, NULL::timestamptz;
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
      NULL::timestamptz;
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
      v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;
  IF v_profile.version <> p_expected_version THEN
    RETURN QUERY SELECT
      'version_conflict'::text, v_profile.id, v_profile.status::text,
      v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;
  IF v_profile.status <> 'active' THEN
    RETURN QUERY SELECT
      'profile_inactive'::text, v_profile.id, v_profile.status::text,
      v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;

  SELECT pg_catalog.coalesce(
    pg_catalog.jsonb_agg(item.value ORDER BY item.ordinality),
    '[]'::jsonb
  ) INTO v_next
  FROM pg_catalog.jsonb_array_elements(
    v_profile.dietary_constraints
  ) WITH ORDINALITY AS item(value, ordinality)
  WHERE item.value->>'id' <> p_constraint_id::text;

  IF v_next = v_profile.dietary_constraints THEN
    RETURN QUERY SELECT
      'constraint_not_found'::text, v_profile.id,
      v_profile.status::text, v_profile.version, v_profile.updated_at;
    RETURN;
  END IF;

  UPDATE public.person_profiles
  SET dietary_constraints = v_next,
      updated_at = v_now,
      version = version + 1
  WHERE id = v_profile.id;

  RETURN QUERY SELECT
    'changed'::text, v_profile.id, v_profile.status::text,
    v_profile.version + 1, v_now;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Ownership and least-privilege grants for every new function.
-- ---------------------------------------------------------------------------

ALTER FUNCTION meal_agent_private.redeem_household_invite(char, uuid)
  OWNER TO meal_agent_migrator;
ALTER FUNCTION
  meal_agent_private.materialize_person_profile_link_requests(
    uuid, uuid, uuid
  ) OWNER TO meal_agent_migrator;
ALTER FUNCTION
  meal_agent_private.transition_membership_status(uuid, integer)
  OWNER TO meal_agent_migrator;
ALTER FUNCTION
  meal_agent_private.confirm_person_profile_link(uuid, integer)
  OWNER TO meal_agent_migrator;
ALTER FUNCTION
  meal_agent_private.update_person_profile_fields(
    uuid, integer, boolean, text, boolean, integer, boolean, numeric,
    boolean, text
  ) OWNER TO meal_agent_migrator;
ALTER FUNCTION
  meal_agent_private.transition_person_profile_status(uuid, integer, text)
  OWNER TO meal_agent_migrator;
ALTER FUNCTION
  meal_agent_private.add_person_profile_constraint(
    uuid, integer, uuid, jsonb, boolean
  ) OWNER TO meal_agent_migrator;
ALTER FUNCTION
  meal_agent_private.remove_person_profile_constraint(
    uuid, integer, uuid
  ) OWNER TO meal_agent_migrator;

REVOKE ALL ON FUNCTION
  meal_agent_private.redeem_household_invite(char, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  meal_agent_private.materialize_person_profile_link_requests(
    uuid, uuid, uuid
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  meal_agent_private.transition_membership_status(uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  meal_agent_private.confirm_person_profile_link(uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  meal_agent_private.update_person_profile_fields(
    uuid, integer, boolean, text, boolean, integer, boolean, numeric,
    boolean, text
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  meal_agent_private.transition_person_profile_status(uuid, integer, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  meal_agent_private.add_person_profile_constraint(
    uuid, integer, uuid, jsonb, boolean
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  meal_agent_private.remove_person_profile_constraint(
    uuid, integer, uuid
  ) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  meal_agent_private.redeem_household_invite(char, uuid)
  TO meal_agent_app;
GRANT EXECUTE ON FUNCTION
  meal_agent_private.materialize_person_profile_link_requests(
    uuid, uuid, uuid
  ) TO meal_agent_app;
GRANT EXECUTE ON FUNCTION
  meal_agent_private.transition_membership_status(uuid, integer)
  TO meal_agent_app;
GRANT EXECUTE ON FUNCTION
  meal_agent_private.confirm_person_profile_link(uuid, integer)
  TO meal_agent_app;
GRANT EXECUTE ON FUNCTION
  meal_agent_private.update_person_profile_fields(
    uuid, integer, boolean, text, boolean, integer, boolean, numeric,
    boolean, text
  ) TO meal_agent_app;
GRANT EXECUTE ON FUNCTION
  meal_agent_private.transition_person_profile_status(uuid, integer, text)
  TO meal_agent_app;
GRANT EXECUTE ON FUNCTION
  meal_agent_private.add_person_profile_constraint(
    uuid, integer, uuid, jsonb, boolean
  ) TO meal_agent_app;
GRANT EXECUTE ON FUNCTION
  meal_agent_private.remove_person_profile_constraint(
    uuid, integer, uuid
  ) TO meal_agent_app;
