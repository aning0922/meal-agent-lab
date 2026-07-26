-- 阶段 09A / M2A：migration 之后的备份角色只读补授。
--
-- 由 bootstrap/admin 在 0001—最新 migration 应用之后执行；可重复执行。
--
-- 01-owner-handoff.sql 的 ALTER DEFAULT PRIVILEGES 已经覆盖「由 migrator 新建
-- 的表」，这里再做一次显式补授，用于兜底以下情况：
--   * 从 dump 恢复后对象由 restore operator 创建；
--   * 历史上由其他角色建立的对象。
-- 只授予 SELECT，并再次收回全部写权限与 DDL 权限。

\set ON_ERROR_STOP on

BEGIN;

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
