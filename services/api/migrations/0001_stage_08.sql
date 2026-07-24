-- 阶段 08：家庭成员与硬约束纵切。
-- 首个增量迁移，验证 migrate.ts 多文件序列 + checksum：本文件只新增
-- household_invites 表、成员/邀请所需的 SECURITY DEFINER 辅助函数、
-- 以及成员/档案变更所需的 RLS 策略与授权，不修改 0000 既有结构。

CREATE TABLE household_invites (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  created_by_user_id uuid NOT NULL,
  -- 只存邀请码的 sha256 digest；明文永不落库（仅创建响应返回一次）。
  code_digest char(64) NOT NULL
    CONSTRAINT household_invites_code_digest_unique UNIQUE,
  status varchar(32) NOT NULL
    CHECK (status IN ('active', 'revoked', 'exhausted', 'expired')),
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 10),
  used_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  CONSTRAINT household_invites_creator_membership_foreign
    FOREIGN KEY (household_id, created_by_user_id)
    REFERENCES memberships(household_id, user_id),
  CONSTRAINT household_invites_used_count_check
    CHECK (used_count >= 0 AND used_count <= max_uses),
  CONSTRAINT household_invites_expiry_check
    CHECK (
      expires_at > created_at
      AND expires_at <= created_at + interval '7 days'
    )
);

CREATE INDEX household_invites_household_status_index
  ON household_invites(household_id, status);

ALTER TABLE household_invites OWNER TO meal_agent_migrator;

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER 辅助（沿用 0000 的 meal_agent_private 模式；owner 为
-- migrator 以 BYPASSRLS 运行，SET row_security = off 双保险）。
-- ---------------------------------------------------------------------------

CREATE FUNCTION meal_agent_private.is_active_owner(target_household_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships
    WHERE household_id = target_household_id
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      AND role = 'owner'
      AND status = 'active'
  )
$function$;

CREATE FUNCTION meal_agent_private.owns_profile(p_linked_membership_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
  SELECT p_linked_membership_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.memberships
      WHERE id = p_linked_membership_id
        AND household_id =
          NULLIF(current_setting('app.household_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND status = 'active'
    )
$function$;

-- 凭码加入：digest 查询 + used_count 递增 + membership 落库全部在一个
-- SECURITY DEFINER 函数内完成，杜绝"未持有效码也能自插成员"的空档；
-- FOR UPDATE 串行化同码并发，保证 used_count 恰好递增、不超 max_uses。
CREATE FUNCTION meal_agent_private.redeem_household_invite(
  p_code_digest char(64),
  p_membership_id uuid,
  p_capabilities jsonb,
  p_now timestamptz
)
-- 输出列刻意不叫 household_id/membership_id：否则会与函数体内的表列同名，
-- 触发 "column reference is ambiguous"。
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
  v_user_id uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
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

  -- 无效 / 撤销 / 用尽 / 过期一律收敛为 not_found，不泄露家庭存在性。
  IF NOT FOUND
     OR v_invite.status <> 'active'
     OR v_invite.expires_at <= p_now
     OR v_invite.used_count >= v_invite.max_uses THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO v_membership
  FROM public.memberships
  WHERE household_id = v_invite.household_id
    AND user_id = v_user_id;

  IF FOUND AND v_membership.status = 'active' THEN
    RETURN QUERY
      SELECT 'already_member'::text, v_invite.household_id, v_membership.id;
    RETURN;
  END IF;

  v_next_used := v_invite.used_count + 1;

  IF FOUND THEN
    -- 曾退出/被移除者，凭新邀请重新激活为 member。
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

  RETURN QUERY
    SELECT 'joined'::text, v_invite.household_id, v_membership_id;
END;
$function$;

ALTER FUNCTION meal_agent_private.is_active_owner(uuid)
  OWNER TO meal_agent_migrator;
ALTER FUNCTION meal_agent_private.owns_profile(uuid)
  OWNER TO meal_agent_migrator;
ALTER FUNCTION meal_agent_private.redeem_household_invite(
  char, uuid, jsonb, timestamptz
) OWNER TO meal_agent_migrator;

GRANT EXECUTE ON FUNCTION meal_agent_private.is_active_owner(uuid)
  TO meal_agent_app;
GRANT EXECUTE ON FUNCTION meal_agent_private.owns_profile(uuid)
  TO meal_agent_app;
GRANT EXECUTE ON FUNCTION meal_agent_private.redeem_household_invite(
  char, uuid, jsonb, timestamptz
) TO meal_agent_app;

-- ---------------------------------------------------------------------------
-- RLS：邀请表策略 + 成员表查看/变更 + 档案变更。
-- ---------------------------------------------------------------------------

ALTER TABLE household_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_invites FORCE ROW LEVEL SECURITY;

-- 仅 owner 可读/建/撤销邀请；join 的 digest 查询走 SECURITY DEFINER，
-- 非成员永远无法直接 SELECT 邀请行。
CREATE POLICY household_invites_owner_select ON household_invites
FOR SELECT TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.is_active_owner(household_id)
);
CREATE POLICY household_invites_owner_insert ON household_invites
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND created_by_user_id = meal_agent_private.app_user_id()
  AND meal_agent_private.is_active_owner(household_id)
);
CREATE POLICY household_invites_owner_update ON household_invites
FOR UPDATE TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.is_active_owner(household_id)
)
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.is_active_owner(household_id)
);

-- 成员列表：同家庭的活跃成员可查看本家庭全部 membership 行（在设置了
-- household 上下文时）。0000 的 bootstrap_select 仍保留，用于无 household
-- 上下文的登录态自查。
CREATE POLICY memberships_household_select ON memberships
FOR SELECT TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);

-- 成员移除/退出：owner 可改本家庭任意成员，普通成员只能改自己（退出）。
-- WITH CHECK 不依赖 has_active_membership（避免读到本语句刚更新的自身行），
-- 由 USING 在旧行上确保调用者本就是活跃成员。
CREATE POLICY memberships_manage_update ON memberships
FOR UPDATE TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
  AND (
    meal_agent_private.is_active_owner(household_id)
    OR user_id = meal_agent_private.app_user_id()
  )
)
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND (
    meal_agent_private.is_active_owner(household_id)
    OR user_id = meal_agent_private.app_user_id()
  )
);

-- 档案编辑/约束增删/归档：owner 或"档案本人"（linked_membership 属于
-- 调用者）；仅用餐档案（无 linked_membership）只有 owner 能改。
CREATE POLICY person_profiles_manage_update ON person_profiles
FOR UPDATE TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
  AND (
    meal_agent_private.is_active_owner(household_id)
    OR meal_agent_private.owns_profile(linked_membership_id)
  )
)
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND (
    meal_agent_private.is_active_owner(household_id)
    OR meal_agent_private.owns_profile(linked_membership_id)
  )
);

GRANT SELECT, INSERT, UPDATE ON household_invites TO meal_agent_app;
GRANT UPDATE ON memberships TO meal_agent_app;
GRANT UPDATE ON person_profiles TO meal_agent_app;
