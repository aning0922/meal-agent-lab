-- 阶段 09A / M2A：migration 之后的备份角色只读补授。
--
-- 由 bootstrap/admin 在 0001—最新 migration 应用之后执行；可重复执行。
--
-- 03-owner-handoff.sql 的 ALTER DEFAULT PRIVILEGES 已经覆盖「由 migrator 新建
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
      '"bootstrap.sh roles" first';
  END IF;
END
$grants_preflight$;

GRANT USAGE ON SCHEMA public TO meal_agent_backup;
GRANT USAGE ON SCHEMA drizzle TO meal_agent_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO meal_agent_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO meal_agent_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO meal_agent_backup;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM meal_agent_backup;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA drizzle FROM meal_agent_backup;
REVOKE CREATE ON SCHEMA public FROM meal_agent_backup;
REVOKE CREATE ON SCHEMA drizzle FROM meal_agent_backup;

-- 备份角色不得执行受控状态转换函数：它只导出数据，不驱动业务写路径。
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA meal_agent_private FROM meal_agent_backup;
REVOKE ALL ON SCHEMA meal_agent_private FROM meal_agent_backup;

COMMIT;
