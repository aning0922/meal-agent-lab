-- 阶段 08 审计整改收口。
--
-- migrate.ts 对每个迁移文件开启单一事务；本文件刻意按以下顺序执行：
--   1. 新增结构与受控函数；
--   2. 转换旧数据与历史幂等响应；
--   3. 撤销旧策略/权限并收紧函数执行边界。
-- 0000/0001 已应用 checksum 不得改变。

-- ---------------------------------------------------------------------------
-- 1. 新结构：未知成员事实 + 用餐档案关联双确认命令。
-- ---------------------------------------------------------------------------

ALTER TABLE public.person_profiles
  ALTER COLUMN default_participation DROP NOT NULL,
  ALTER COLUMN default_portion_scale DROP NOT NULL,
  ALTER COLUMN cooking_skill DROP NOT NULL;

ALTER TABLE public.person_profiles
  DROP CONSTRAINT person_profiles_default_participation_check,
  DROP CONSTRAINT person_profiles_default_portion_scale_check,
  DROP CONSTRAINT person_profiles_cooking_skill_check;

ALTER TABLE public.person_profiles
  ADD CONSTRAINT person_profiles_default_participation_check
    CHECK (
      default_participation IS NULL
      OR default_participation IN (0, 1)
    ),
  ADD CONSTRAINT person_profiles_default_portion_scale_check
    CHECK (
      default_portion_scale IS NULL
      OR default_portion_scale BETWEEN 0.25 AND 4
    ),
  ADD CONSTRAINT person_profiles_cooking_skill_check
    CHECK (
      cooking_skill IS NULL
      OR cooking_skill IN ('none', 'beginner', 'intermediate', 'advanced')
    );

CREATE TABLE public.person_profile_link_requests (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id),
  profile_id uuid NOT NULL,
  target_membership_id uuid NOT NULL,
  initiated_by_user_id uuid NOT NULL,
  status varchar(32) NOT NULL
    CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  CONSTRAINT person_profile_link_requests_profile_foreign
    FOREIGN KEY (household_id, profile_id)
    REFERENCES public.person_profiles(household_id, id),
  CONSTRAINT person_profile_link_requests_membership_foreign
    FOREIGN KEY (household_id, target_membership_id)
    REFERENCES public.memberships(household_id, id),
  CONSTRAINT person_profile_link_requests_initiator_foreign
    FOREIGN KEY (household_id, initiated_by_user_id)
    REFERENCES public.memberships(household_id, user_id),
  CONSTRAINT person_profile_link_requests_time_check
    CHECK (
      expires_at > created_at
      AND expires_at <= created_at + interval '7 days'
    ),
  CONSTRAINT person_profile_link_requests_confirmation_check
    CHECK (
      (status = 'accepted' AND confirmed_at IS NOT NULL)
      OR (status <> 'accepted' AND confirmed_at IS NULL)
    )
);

CREATE UNIQUE INDEX person_profile_link_requests_pending_profile_unique
  ON public.person_profile_link_requests(household_id, profile_id)
  WHERE status = 'pending';

CREATE INDEX person_profile_link_requests_target_status_index
  ON public.person_profile_link_requests(
    household_id, target_membership_id, status
  );

ALTER TABLE public.person_profile_link_requests
  OWNER TO meal_agent_migrator;

CREATE OR REPLACE FUNCTION meal_agent_private.redeem_household_invite(
  p_code_digest char(64),
  p_membership_id uuid,
  p_capabilities jsonb,
  p_now timestamptz
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
     OR v_invite.expires_at <= p_now
     OR v_invite.used_count >= v_invite.max_uses THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- 两个不同邀请码并发加入同一家庭时，必须在检查 membership 前以
  -- household + user 串行化，避免唯一约束异常泄漏为 500。
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
        capabilities = p_capabilities,
        status = 'active',
        joined_at = p_now,
        updated_at = p_now,
        version = version + 1
    WHERE id = v_membership.id;
    v_membership_id := v_membership.id;
  ELSE
    INSERT INTO public.memberships (
      id, household_id, user_id, role, capabilities, status,
      joined_at, updated_at, version
    ) VALUES (
      p_membership_id, v_invite.household_id, v_user_id, 'member',
      p_capabilities, 'active', p_now, p_now, 0
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

  -- 重新加入只恢复 membership。既有 archived profile 保持归档，
  -- 由用户通过显式 restore 命令恢复，且不复制私人约束。
  RETURN QUERY
    SELECT 'joined'::text, v_invite.household_id, v_membership_id;
END;
$function$;

CREATE FUNCTION meal_agent_private.transition_membership_status(
  p_target_membership_id uuid,
  p_expected_version integer,
  p_now timestamptz
)
RETURNS TABLE (
  result_code text,
  out_membership_id uuid,
  out_status text,
  out_version integer
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
  v_actor public.memberships%ROWTYPE;
  v_target public.memberships%ROWTYPE;
  v_next_status text;
  v_owner_count integer;
BEGIN
  IF v_user_id IS NULL OR v_household_id IS NULL THEN
    RETURN QUERY SELECT
      'not_found'::text, NULL::uuid, NULL::text, NULL::integer;
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

  IF NOT FOUND OR v_actor.id IS NULL OR v_target.status <> 'active' THEN
    RETURN QUERY SELECT
      'not_found'::text, NULL::uuid, NULL::text, NULL::integer;
    RETURN;
  END IF;

  IF v_target.version <> p_expected_version THEN
    RETURN QUERY SELECT
      'version_conflict'::text, v_target.id, v_target.status::text,
      v_target.version;
    RETURN;
  END IF;

  IF v_actor.role <> 'owner' AND v_actor.id <> v_target.id THEN
    RETURN QUERY SELECT
      'forbidden'::text, v_target.id, v_target.status::text, v_target.version;
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
        v_target.version;
      RETURN;
    END IF;
  END IF;

  v_next_status := CASE
    WHEN v_actor.id = v_target.id THEN 'left'
    ELSE 'removed'
  END;

  UPDATE public.memberships
  SET status = v_next_status,
      updated_at = p_now,
      version = version + 1
  WHERE id = v_target.id;

  -- 退出/移除与档案归档是同一事务；不自动转换为 dining-only。
  UPDATE public.person_profiles
  SET status = 'archived',
      updated_at = p_now,
      version = version + 1
  WHERE household_id = v_household_id
    AND linked_membership_id = v_target.id
    AND status = 'active';

  RETURN QUERY SELECT
    'changed'::text, v_target.id, v_next_status, v_target.version + 1;
END;
$function$;

CREATE FUNCTION meal_agent_private.confirm_person_profile_link(
  p_request_id uuid,
  p_expected_version integer,
  p_now timestamptz
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
  v_request public.person_profile_link_requests%ROWTYPE;
  v_target public.memberships%ROWTYPE;
  v_profile public.person_profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_request
  FROM public.person_profile_link_requests
  WHERE id = p_request_id
    AND household_id = v_household_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_request.status <> 'pending'
     OR v_request.expires_at <= p_now THEN
    RETURN QUERY SELECT
      'not_found'::text, NULL::uuid, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  IF v_request.version <> p_expected_version THEN
    RETURN QUERY SELECT
      'version_conflict'::text, v_request.profile_id, NULL::integer,
      v_request.version;
    RETURN;
  END IF;

  SELECT * INTO v_target
  FROM public.memberships
  WHERE id = v_request.target_membership_id
    AND household_id = v_household_id
    AND user_id = v_user_id
    AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'forbidden'::text, v_request.profile_id, NULL::integer,
      v_request.version;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'person-profile-link:' || v_household_id::text || ':' ||
      v_target.id::text,
      0
    )
  );

  SELECT * INTO v_profile
  FROM public.person_profiles
  WHERE id = v_request.profile_id
    AND household_id = v_household_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_profile.status <> 'active'
     OR v_profile.linked_membership_id IS NOT NULL THEN
    RETURN QUERY SELECT
      'profile_unavailable'::text, v_request.profile_id, NULL::integer,
      v_request.version;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.person_profiles
    WHERE household_id = v_household_id
      AND linked_membership_id = v_target.id
  ) THEN
    RETURN QUERY SELECT
      'membership_has_profile'::text, v_request.profile_id, NULL::integer,
      v_request.version;
    RETURN;
  END IF;

  UPDATE public.person_profiles
  SET linked_membership_id = v_target.id,
      updated_at = p_now,
      version = version + 1
  WHERE id = v_profile.id;

  UPDATE public.person_profile_link_requests
  SET status = 'accepted',
      confirmed_at = p_now,
      version = version + 1
  WHERE id = v_request.id;

  RETURN QUERY SELECT
    'linked'::text, v_profile.id, v_profile.version + 1,
    v_request.version + 1;
END;
$function$;

ALTER FUNCTION meal_agent_private.redeem_household_invite(
  char, uuid, jsonb, timestamptz
) OWNER TO meal_agent_migrator;
ALTER FUNCTION meal_agent_private.transition_membership_status(
  uuid, integer, timestamptz
) OWNER TO meal_agent_migrator;
ALTER FUNCTION meal_agent_private.confirm_person_profile_link(
  uuid, integer, timestamptz
) OWNER TO meal_agent_migrator;

ALTER TABLE public.person_profile_link_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_profile_link_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY person_profile_link_requests_select
ON public.person_profile_link_requests
FOR SELECT TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND (
    meal_agent_private.is_active_owner(household_id)
    OR EXISTS (
      SELECT 1
      FROM public.memberships AS target_membership
      WHERE target_membership.id =
          person_profile_link_requests.target_membership_id
        AND target_membership.household_id =
          person_profile_link_requests.household_id
        AND target_membership.user_id = meal_agent_private.app_user_id()
        AND target_membership.status = 'active'
    )
  )
);

CREATE POLICY person_profile_link_requests_insert
ON public.person_profile_link_requests
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND initiated_by_user_id = meal_agent_private.app_user_id()
  AND meal_agent_private.is_active_owner(household_id)
);

GRANT SELECT, INSERT ON public.person_profile_link_requests
  TO meal_agent_app;

-- ---------------------------------------------------------------------------
-- 2. 旧数据转换：结构化映射状态、过期邀请、敏感幂等响应。
-- ---------------------------------------------------------------------------

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
          WHEN item.value->>'enforcement' = 'hard'
               AND NOT (item.value ? 'mappingStatus') THEN
            item.value || pg_catalog.jsonb_build_object(
              'mappingStatus',
              CASE
                WHEN pg_catalog.jsonb_array_length(
                  coalesce(
                    item.value->'foodConceptIds',
                    '[]'::jsonb
                  )
                ) > 0
                OR (
                  item.value->>'kind' = 'allergy'
                  AND pg_catalog.jsonb_array_length(
                    coalesce(
                      item.value->'allergenCodes',
                      '[]'::jsonb
                    )
                  ) > 0
                )
                THEN 'structured'
                ELSE 'needs_structured_mapping'
              END
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

UPDATE public.household_invites
SET status = 'expired',
    version = version + 1
WHERE status = 'active'
  AND expires_at <= pg_catalog.clock_timestamp();

-- 旧 profile/constraint 响应若能识别，转换为无私密字段 receipt；
-- 无法安全识别的记录改为 non_replayable tombstone。命令 key 和完成标识
-- 均保留，绝不因清理缓存而让同一命令重新执行。
UPDATE public.idempotency_records
SET response_body =
  CASE
    WHEN response_body #> '{data,profile}' IS NOT NULL
         AND response_body #>> '{data,profile,id}' IS NOT NULL
         AND response_body #>> '{data,profile,householdId}' IS NOT NULL
         AND response_body #>> '{data,profile,status}' IS NOT NULL
         AND response_body #>> '{data,profile,version}' IS NOT NULL THEN
      pg_catalog.jsonb_set(
        response_body,
        '{data}',
        pg_catalog.jsonb_build_object(
          'householdId', response_body #>> '{data,profile,householdId}',
          'profileId', response_body #>> '{data,profile,id}',
          'operation',
            CASE
              WHEN normalized_route LIKE '%/dietary-constraints'
                   AND method = 'POST' THEN 'add_constraint'
              WHEN normalized_route LIKE '%/dietary-constraints'
                   AND method = 'DELETE' THEN 'remove_constraint'
              WHEN normalized_route = '/api/v1/households/{id}/person-profiles'
                THEN 'create'
              WHEN response_body #>> '{data,profile,status}' = 'archived'
                THEN 'archive'
              ELSE 'update'
            END,
          'status', response_body #>> '{data,profile,status}',
          'resultingVersion',
            (response_body #>> '{data,profile,version}')::integer
        ),
        true
      )
    ELSE
      pg_catalog.jsonb_set(
        response_body,
        '{data}',
        pg_catalog.jsonb_build_object(
          'nonReplayable', true,
          'reason', 'legacy_sensitive_response'
        ),
        true
      )
  END
WHERE response_body IS NOT NULL
  AND (
    normalized_route = '/api/v1/households/{id}/person-profiles'
    OR normalized_route =
      '/api/v1/households/{id}/person-profiles/{profileId}'
    OR normalized_route =
      '/api/v1/households/{id}/person-profiles/{profileId}/dietary-constraints'
  );

-- 防御性清理：即使旧应用版本曾将明文邀请码写入缓存，也只移除秘密字段，
-- 不删除幂等记录。
UPDATE public.idempotency_records
SET response_body = response_body #- '{data,inviteCode}'
WHERE normalized_route = '/api/v1/households/{id}/invites'
  AND method = 'POST'
  AND response_body #> '{data,inviteCode}' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. 撤销旧权限，所有成员状态改变仅可走受控函数。
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS memberships_manage_update ON public.memberships;
REVOKE UPDATE ON public.memberships FROM meal_agent_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

REVOKE ALL ON FUNCTION meal_agent_private.redeem_household_invite(
  char, uuid, jsonb, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION meal_agent_private.transition_membership_status(
  uuid, integer, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION meal_agent_private.confirm_person_profile_link(
  uuid, integer, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION meal_agent_private.redeem_household_invite(
  char, uuid, jsonb, timestamptz
) TO meal_agent_app;
GRANT EXECUTE ON FUNCTION meal_agent_private.transition_membership_status(
  uuid, integer, timestamptz
) TO meal_agent_app;
GRANT EXECUTE ON FUNCTION meal_agent_private.confirm_person_profile_link(
  uuid, integer, timestamptz
) TO meal_agent_app;
