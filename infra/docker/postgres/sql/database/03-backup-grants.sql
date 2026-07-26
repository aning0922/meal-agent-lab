-- 阶段 09A / M2A：migration 之后的备份角色只读补授。
--
-- 由 bootstrap/admin 在 0001—最新 migration 应用之后执行；可重复执行。
--
-- 01-owner-handoff.sql 的 ALTER DEFAULT PRIVILEGES 已经覆盖「由 migrator 新建
-- 的表」，这里再做一次显式补授，用于兜底历史上由其他角色建立的对象。
-- 只授予 SELECT，并再次收回全部写权限与 DDL 权限。
--
-- M4 的恢复流程只在此登记约束，本轮不实现：恢复时复用 01-role-baseline.sql
-- 预建 dump 引用的角色，不得在已有 dump 目标上重跑 0000，也不得对 dump 已经
-- 建立的对象重跑 owner handoff。

\set ON_ERROR_STOP on

BEGIN;

-- 顺序预检：owner 交接必须已经完成。
DO $grants_preflight$
BEGIN
  IF to_regclass('drizzle.__meal_agent_migrations') IS NULL THEN
    RAISE EXCEPTION 'backup grants: migration ledger is missing';
  END IF;

  IF (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_namespace
      WHERE nspname = 'public') <> 'meal_agent_migrator' THEN
    RAISE EXCEPTION
      'backup grants: public schema is not owned by meal_agent_migrator; '
      'run "bootstrap.sh handoff" first';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'meal_agent_backup'
  ) THEN
    RAISE EXCEPTION
      'backup grants: meal_agent_backup does not exist; run '
      '"bootstrap.sh cluster" first';
  END IF;
END
$grants_preflight$;

GRANT USAGE ON SCHEMA public TO meal_agent_backup;
GRANT USAGE ON SCHEMA drizzle TO meal_agent_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO meal_agent_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO meal_agent_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO meal_agent_backup;

-- 今后由 migrator 新建的 table/sequence 自动获得 backup 只读权限。
-- sequence 只给 SELECT：USAGE/UPDATE 会让 nextval/setval 可用，那不是只读。
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO meal_agent_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO meal_agent_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO meal_agent_backup;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM meal_agent_backup;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA drizzle FROM meal_agent_backup;
REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM meal_agent_backup;
REVOKE CREATE ON SCHEMA public FROM meal_agent_backup;
REVOKE CREATE ON SCHEMA drizzle FROM meal_agent_backup;

-- 备份角色不得执行受控状态转换函数：它只导出数据，不驱动业务写路径。
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA meal_agent_private FROM meal_agent_backup;
REVOKE ALL ON SCHEMA meal_agent_private FROM meal_agent_backup;

-- ---------------------------------------------------------------------------
-- 结果自检：backup 必须精确只读。
-- ---------------------------------------------------------------------------
DO $verify_backup$
DECLARE
  problem text;
BEGIN
  -- 表/视图只有 SELECT，且不带 GRANT OPTION。
  SELECT string_agg(format('%s.%s:%s%s', n.nspname, c.relname,
                           acl.privilege_type,
                           CASE WHEN acl.is_grantable THEN ' (grantable)'
                                ELSE '' END),
                    ', ')
    INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       aclexplode(c.relacl) AS acl
  WHERE n.nspname IN ('public', 'drizzle')
    AND acl.grantee <> 0
    AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
    AND (acl.privilege_type <> 'SELECT' OR acl.is_grantable);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: backup must hold only non-grantable SELECT: %', problem;
  END IF;

  -- 列级授权一律不应存在。
  SELECT string_agg(format('%s.%s.%s', n.nspname, c.relname, a.attname), ', ')
    INTO problem
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace,
       aclexplode(a.attacl) AS acl
  WHERE acl.grantee <> 0
    AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: backup must not hold column-level grants: %', problem;
  END IF;

  -- meal_agent_private 既无 USAGE 也无 EXECUTE。
  IF has_schema_privilege('meal_agent_backup', 'meal_agent_private', 'USAGE') THEN
    RAISE EXCEPTION
      'backup grants: backup must not have USAGE on meal_agent_private';
  END IF;

  -- schema 只有 USAGE，没有 CREATE。
  IF has_schema_privilege('meal_agent_backup', 'public', 'CREATE')
     OR has_schema_privilege('meal_agent_backup', 'drizzle', 'CREATE') THEN
    RAISE EXCEPTION 'backup grants: backup must not hold CREATE on a schema';
  END IF;

  -- 数据库级无 TEMP。
  IF has_database_privilege('meal_agent_backup', current_database(), 'TEMP') THEN
    RAISE EXCEPTION 'backup grants: backup must not hold TEMP';
  END IF;
END
$verify_backup$;

COMMIT;
