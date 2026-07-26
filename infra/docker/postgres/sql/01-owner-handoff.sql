-- 阶段 09A / M2A：owner 交接与备份角色。
--
-- 由 bootstrap/admin（cluster admin）在冻结的 0000 应用之后、0001 之前执行。
-- 这不是业务 migration：它只处理 cluster 角色与对象归属，不新增、不修改任何
-- 业务表结构，因此不进入 services/api/migrations，也不写 migration ledger。
--
-- 可重复执行：全部语句为幂等形式，重复运行不会扩大权限。
--
-- 前置：0000 已创建 meal_agent_migrator（NOLOGIN BYPASSRLS）与
--       meal_agent_app（NOLOGIN NOBYPASSRLS），且 migration runner 已建立
--       drizzle schema 与 drizzle.__meal_agent_migrations。

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. database owner 交给 migrator
--    :"DBNAME" 是 psql 内置变量，按标识符安全引用当前数据库名。
--    0001 起的 REVOKE CREATE ON SCHEMA public 需要 migrator 是 owner/grantor。
-- ---------------------------------------------------------------------------
ALTER DATABASE :"DBNAME" OWNER TO meal_agent_migrator;

-- ---------------------------------------------------------------------------
-- 2. schema owner 交接
-- ---------------------------------------------------------------------------
ALTER SCHEMA public OWNER TO meal_agent_migrator;
ALTER SCHEMA drizzle OWNER TO meal_agent_migrator;
ALTER SCHEMA meal_agent_private OWNER TO meal_agent_migrator;

-- ---------------------------------------------------------------------------
-- 3. migration ledger owner 交接
--    ledger 由 migration runner 以 admin 身份建立，必须交给 migrator，
--    否则后续 migration login 无法写入。
-- ---------------------------------------------------------------------------
ALTER TABLE drizzle.__meal_agent_migrations OWNER TO meal_agent_migrator;

-- ---------------------------------------------------------------------------
-- 4. 兜底：public/drizzle 中仍归 bootstrap admin 的表交给 migrator。
--    0000 已显式 ALTER TABLE ... OWNER TO meal_agent_migrator，这里只处理
--    残留情况，保证 handoff 后 owner 集合确定。
-- ---------------------------------------------------------------------------
DO $handoff$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.oid::regclass AS ident
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle')
      AND c.relkind IN ('r', 'p')
      AND c.relowner <> 'meal_agent_migrator'::regrole
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO meal_agent_migrator', target.ident);
  END LOOP;
END
$handoff$;

-- ---------------------------------------------------------------------------
-- 5. 专用备份角色
--    需要 BYPASSRLS 才能在 FORCE RLS 下完整导出多个家庭；这是敏感的全库读取
--    权限，不是普通家庭只读账号。它不得写业务表，也不得执行 DDL。
-- ---------------------------------------------------------------------------
DO $backup_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'meal_agent_backup'
  ) THEN
    CREATE ROLE meal_agent_backup NOLOGIN;
  END IF;
END
$backup_role$;

ALTER ROLE meal_agent_backup
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;

GRANT USAGE ON SCHEMA public TO meal_agent_backup;
GRANT USAGE ON SCHEMA drizzle TO meal_agent_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO meal_agent_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO meal_agent_backup;

-- 0001 起由 migrator 创建的新表自动获得 backup 只读权限。
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO meal_agent_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO meal_agent_backup;

-- 显式收回写权限与建表权限：备份角色只读。
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

COMMIT;
