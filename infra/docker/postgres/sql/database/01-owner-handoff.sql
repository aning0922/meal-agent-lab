-- 阶段 09A / M2A：owner 交接（database scope，仅全新安装路径）。
--
-- 由 bootstrap/admin 在冻结的 0000 应用之后、0001 之前执行；可重复执行。
-- 恢复路径**不**运行本文件：dump 已经带着正确的 owner，重跑交接只会制造漂移。
--
-- 设计要点：
--   1. **所有状态检查先于任何 ownership mutation**；任一检查失败时，
--      database/schema/table owner 全部保持原状。
--   2. admin 真正需要交接的只有三类明确对象：目标 database、三个 schema，
--      以及由 migration runner 以 admin 身份建立的 drizzle ledger。
--   3. 业务表与 meal_agent_private 函数的 owner 由冻结的 0000—0004 自己设置为
--      migrator，这里只**验证**，不动态接管：不符合就失败。
--   4. 允许出现的对象集合由 **ledger 实际内容**推导：只应用了 0000 时，
--      0001/0002 的表出现就是异常，不能提前放行。

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 阶段 1：只读检查。任何失败都在此抛出，此时尚未做过任何归属变更。
-- ---------------------------------------------------------------------------
DO $checks$
DECLARE
  -- 冻结 migration 与它们各自建立的 public 业务表。
  stage06_tables constant text[] := ARRAY[
    'auth_identities', 'households', 'idempotency_records', 'inventory_events',
    'inventory_lots', 'memberships', 'person_profiles', 'sessions', 'users'
  ];
  stage08_first constant text[] := ARRAY['household_invites'];
  stage08_second constant text[] := ARRAY['person_profile_link_requests'];
  bootstrap_admin constant text := current_user;
  applied text[];
  allowed text[];
  present text[];
  problem text;
BEGIN
  -- 1a. ledger 必须存在且包含有效的 0000。
  IF to_regclass('drizzle.__meal_agent_migrations') IS NULL THEN
    RAISE EXCEPTION
      'owner handoff: migration ledger is missing; run '
      '"pnpm --filter @meal-agent/api db:bootstrap" first';
  END IF;

  SELECT array_agg(name ORDER BY name) INTO applied
  FROM drizzle.__meal_agent_migrations;
  applied := coalesce(applied, ARRAY[]::text[]);

  IF NOT ('0000_stage_06.sql' = ANY(applied)) THEN
    RAISE EXCEPTION
      'owner handoff: 0000_stage_06.sql has not been applied; run '
      '"pnpm --filter @meal-agent/api db:bootstrap" first';
  END IF;

  -- 1b. 根据 ledger 实际内容推导允许出现的 public 业务表集合。
  --     只有 0000 时，0001/0002 建立的表出现即为异常。
  allowed := stage06_tables;
  IF '0001_stage_08.sql' = ANY(applied) THEN
    allowed := allowed || stage08_first;
  END IF;
  IF '0002_stage_08_audit_closeout.sql' = ANY(applied) THEN
    allowed := allowed || stage08_second;
  END IF;

  SELECT coalesce(array_agg(c.relname ORDER BY c.relname), ARRAY[]::text[])
    INTO present
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');

  -- 1c. 未知对象（表/视图/序列/物化视图/外部表）一律拒绝。
  SELECT string_agg(format('%s %s.%s (owner %s)',
           CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                          WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview'
                          WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign table'
                          ELSE c.relkind::text END,
           n.nspname, c.relname, pg_catalog.pg_get_userbyid(c.relowner)),
         ', ' ORDER BY n.nspname, c.relname)
    INTO problem
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND NOT (c.relname = ANY(allowed));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: unmanaged object(s) in public for the applied migration '
      'set %: %', applied, problem;
  END IF;

  -- 1d. 已应用的 migration 应当建立的表必须都在。
  SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO problem
  FROM unnest(allowed) AS candidate
  WHERE NOT (candidate = ANY(present));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: migration(s) recorded as applied but table(s) missing: %',
      problem;
  END IF;

  -- 1e. drizzle schema 里除 ledger 外不应有其他对象。
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO problem
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'drizzle'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    AND c.relname <> '__meal_agent_migrations';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: unexpected object(s) in schema drizzle: %', problem;
  END IF;

  -- 1f. 业务表 owner 只验证不接管：冻结的 0000—0004 已把它们设为 migrator。
  SELECT string_agg(format('%s (owner %s)', c.relname,
                           pg_catalog.pg_get_userbyid(c.relowner)),
                    ', ' ORDER BY c.relname)
    INTO problem
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND pg_catalog.pg_get_userbyid(c.relowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: business table(s) are not owned by meal_agent_migrator; '
      'the frozen migrations set this, so this is an unexpected state: %',
      problem;
  END IF;

  -- 1g. meal_agent_private 的 SECURITY DEFINER 函数 owner 决定其有效权限，
  --     同样只验证。
  IF to_regnamespace('meal_agent_private') IS NULL THEN
    RAISE EXCEPTION 'owner handoff: schema meal_agent_private is missing';
  END IF;
  SELECT string_agg(format('%s (owner %s)', p.proname,
                           pg_catalog.pg_get_userbyid(p.proowner)),
                    ', ' ORDER BY p.proname)
    INTO problem
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'meal_agent_private'
    AND pg_catalog.pg_get_userbyid(p.proowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: meal_agent_private function(s) not owned by '
      'meal_agent_migrator: %', problem;
  END IF;

  -- 1h. 要交接的三个 schema 与 ledger，其当前 owner 只能是 migrator（已交接）
  --     或执行本脚本的 bootstrap admin（尚未交接）。
  SELECT string_agg(format('schema %s (owner %s)', nspname,
                           pg_catalog.pg_get_userbyid(nspowner)),
                    ', ' ORDER BY nspname)
    INTO problem
  FROM pg_namespace
  WHERE nspname IN ('public', 'drizzle', 'meal_agent_private')
    AND pg_catalog.pg_get_userbyid(nspowner)
        NOT IN ('meal_agent_migrator', bootstrap_admin, 'pg_database_owner');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'owner handoff: unexpected schema owner(s): %', problem;
  END IF;

  IF (SELECT pg_catalog.pg_get_userbyid(c.relowner)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'drizzle' AND c.relname = '__meal_agent_migrations')
     NOT IN ('meal_agent_migrator', bootstrap_admin) THEN
    RAISE EXCEPTION
      'owner handoff: the migration ledger has an unexpected owner';
  END IF;
END
$checks$;

-- ---------------------------------------------------------------------------
-- 阶段 2：归属变更。只有上面全部检查通过才会执行到这里。
--         交接对象是明确的三类：database、三个 schema、drizzle ledger。
-- ---------------------------------------------------------------------------
ALTER DATABASE :"expected_db" OWNER TO meal_agent_migrator;

ALTER SCHEMA public OWNER TO meal_agent_migrator;
ALTER SCHEMA drizzle OWNER TO meal_agent_migrator;
ALTER SCHEMA meal_agent_private OWNER TO meal_agent_migrator;

ALTER TABLE drizzle.__meal_agent_migrations OWNER TO meal_agent_migrator;

-- ---------------------------------------------------------------------------
-- 阶段 3：结果自检
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  problem text;
BEGIN
  IF (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_database
      WHERE datname = current_database()) <> 'meal_agent_migrator' THEN
    RAISE EXCEPTION 'owner handoff: database owner is not meal_agent_migrator';
  END IF;

  SELECT string_agg(nspname, ', ' ORDER BY nspname) INTO problem
  FROM pg_namespace
  WHERE nspname IN ('public', 'drizzle', 'meal_agent_private')
    AND pg_catalog.pg_get_userbyid(nspowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'owner handoff: schema(s) % not owned by migrator', problem;
  END IF;

  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO problem
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle')
    AND c.relkind IN ('r', 'p')
    AND pg_catalog.pg_get_userbyid(c.relowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'owner handoff: table(s) % not owned by migrator', problem;
  END IF;
END
$verify$;

COMMIT;
