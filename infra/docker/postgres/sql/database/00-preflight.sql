-- 阶段 09A / M2A：database scope 预检。
--
-- database 阶段只在目标 meal_agent* 数据库存在后运行。这里核对连接目标与
-- admin 能力；具体阶段的顺序前置条件（ledger/owner 状态）由各阶段自己检查。

\set ON_ERROR_STOP on

-- psql 不会在 dollar-quoted 块内部做变量替换，因此先把期望库名放进一个带命名
-- 空间的自定义 GUC，再在 DO 块里读取。
SELECT set_config('meal_agent.expected_db', :'expected_db', false);

DO $database_preflight$
DECLARE
  expected_database constant text := current_setting('meal_agent.expected_db');
BEGIN
  IF current_database() <> expected_database THEN
    RAISE EXCEPTION
      'database preflight: connected to database %, expected %',
      current_database(), expected_database;
  END IF;

  IF current_database() !~ '^meal_agent(_[a-z0-9_]+)?$' THEN
    RAISE EXCEPTION
      'database preflight: % is not a project database name',
      current_database();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE EXCEPTION
      'database preflight: % is not a cluster superuser; the database baseline '
      'changes ownership and database-level ACLs', current_user;
  END IF;

  -- cluster 阶段必须先跑过：六个项目角色都要存在。
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup',
      'meal_agent_migration_login', 'meal_agent_runtime_login',
      'meal_agent_backup_login'
    ]) AS candidate
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = candidate)
  ) THEN
    RAISE EXCEPTION
      'database preflight: project roles are missing; run '
      '"bootstrap.sh cluster" first';
  END IF;
END
$database_preflight$;
