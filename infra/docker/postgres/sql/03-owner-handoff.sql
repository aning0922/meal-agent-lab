-- 阶段 09A / M2A：owner 交接。
--
-- 由 bootstrap/admin 在冻结的 0000 应用之后、0001 之前执行；可重复执行。
-- 这不是业务 migration：它只处理对象归属，不新增、不修改任何业务表结构，
-- 因此不进入 services/api/migrations，也不写 migration ledger。
--
-- 归属变更使用**显式 allowlist**。发现 allowlist 之外的对象、或 allowlist 内
-- 对象归属于预期之外的 owner 时，报告并失败——绝不静默夺取所有权。

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 顺序预检：0000 必须已经应用，否则说明调用顺序错了。
-- ---------------------------------------------------------------------------
DO $handoff_preflight$
BEGIN
  IF to_regclass('drizzle.__meal_agent_migrations') IS NULL THEN
    RAISE EXCEPTION
      'owner handoff: migration ledger is missing; run '
      '"db:migrate -- --bootstrap-0000" first';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM drizzle.__meal_agent_migrations
    WHERE name = '0000_stage_06.sql'
  ) THEN
    RAISE EXCEPTION
      'owner handoff: 0000_stage_06.sql has not been applied; run '
      '"db:migrate -- --bootstrap-0000" first';
  END IF;

  -- 0000 建立的角色必须已经存在（角色基线或 0000 自身都会建立它们）。
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'meal_agent_migrator'
  ) THEN
    RAISE EXCEPTION 'owner handoff: meal_agent_migrator does not exist';
  END IF;
END
$handoff_preflight$;

-- ---------------------------------------------------------------------------
-- 2. database owner 交给 migrator。
--    0001 起的 REVOKE CREATE ON SCHEMA public 需要 migrator 是 owner/grantor。
-- ---------------------------------------------------------------------------
ALTER DATABASE :"expected_db" OWNER TO meal_agent_migrator;

-- ---------------------------------------------------------------------------
-- 3. schema owner 交接（显式清单）
-- ---------------------------------------------------------------------------
ALTER SCHEMA public OWNER TO meal_agent_migrator;
ALTER SCHEMA drizzle OWNER TO meal_agent_migrator;
ALTER SCHEMA meal_agent_private OWNER TO meal_agent_migrator;

-- ---------------------------------------------------------------------------
-- 4. 表归属：显式 allowlist + 未知对象/未知 owner fail closed。
--
--    allowlist 覆盖 0000—0004 建立的全部业务表与 migration ledger。handoff 在
--    0001 之前运行，因此清单里只有一部分当前存在；存在但不在清单中的表说明
--    数据库里有本项目未管理的对象，必须由人来判断，不能自动接管。
-- ---------------------------------------------------------------------------
DO $tables$
DECLARE
  managed constant text[] := ARRAY[
    'public.users',
    'public.auth_identities',
    'public.sessions',
    'public.households',
    'public.memberships',
    'public.person_profiles',
    'public.inventory_lots',
    'public.inventory_events',
    'public.idempotency_records',
    'public.household_invites',
    'public.person_profile_link_requests',
    'drizzle.__meal_agent_migrations'
  ];
  bootstrap_admin constant text := current_user;
  unexpected text;
  target record;
BEGIN
  -- 4a. allowlist 之外的对象：报告并失败。
  SELECT string_agg(
           format('%s.%s (owner %s)', n.nspname, c.relname,
                  pg_catalog.pg_get_userbyid(c.relowner)),
           ', ' ORDER BY n.nspname, c.relname)
    INTO unexpected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle')
    AND c.relkind IN ('r', 'p')
    AND NOT (n.nspname || '.' || c.relname = ANY(managed));

  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: unmanaged table(s) present, refusing to take ownership: %',
      unexpected;
  END IF;

  -- 4b. allowlist 内但 owner 既不是 migrator、也不是执行本脚本的 bootstrap
  --     admin：说明归属状态未知，报告并失败。
  SELECT string_agg(
           format('%s.%s (owner %s)', n.nspname, c.relname,
                  pg_catalog.pg_get_userbyid(c.relowner)),
           ', ' ORDER BY n.nspname, c.relname)
    INTO unexpected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle')
    AND c.relkind IN ('r', 'p')
    AND n.nspname || '.' || c.relname = ANY(managed)
    AND pg_catalog.pg_get_userbyid(c.relowner)
        NOT IN ('meal_agent_migrator', bootstrap_admin);

  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: unexpected owner on managed table(s): %', unexpected;
  END IF;

  -- 4c. 只把「由 bootstrap admin 持有的 allowlist 内对象」交给 migrator。
  FOR target IN
    SELECT format('%I.%I', n.nspname, c.relname) AS ident
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle')
      AND c.relkind IN ('r', 'p')
      AND n.nspname || '.' || c.relname = ANY(managed)
      AND pg_catalog.pg_get_userbyid(c.relowner) = bootstrap_admin
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO meal_agent_migrator', target.ident);
  END LOOP;
END
$tables$;

-- ---------------------------------------------------------------------------
-- 5. 备份角色的对象级只读权限。
--    角色本身与其 cluster 属性由 01-role-baseline.sql 规范化。
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO meal_agent_backup;
GRANT USAGE ON SCHEMA drizzle TO meal_agent_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO meal_agent_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO meal_agent_backup;

-- 0001 起由 migrator 创建的新表自动获得 backup 只读权限。
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO meal_agent_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO meal_agent_backup;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM meal_agent_backup;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA drizzle FROM meal_agent_backup;
REVOKE CREATE ON SCHEMA public FROM meal_agent_backup;
REVOKE CREATE ON SCHEMA drizzle FROM meal_agent_backup;

-- ---------------------------------------------------------------------------
-- 6. owner 变更后重申 app 角色对 migration ledger 的只读权限。
--    readiness 以 meal_agent_app 身份读取 ledger，必须保持可读。
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA drizzle TO meal_agent_app;
GRANT SELECT ON drizzle.__meal_agent_migrations TO meal_agent_app;

-- app 角色不得建表：业务 DDL 只能由 migrator 执行。
REVOKE CREATE ON SCHEMA public FROM meal_agent_app;
REVOKE CREATE ON SCHEMA drizzle FROM meal_agent_app;

-- ---------------------------------------------------------------------------
-- 7. 结果自检
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
