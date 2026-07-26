-- 阶段 09A / M2A：所有 bootstrap 阶段的公共预检。
--
-- 目标：连错数据库或身份不足时 fail closed，而不是在半途留下不一致的权限。

\set ON_ERROR_STOP on

-- psql 不会在 dollar-quoted 块内部做变量替换，因此先把期望库名放进一个带命名
-- 空间的自定义 GUC，再在 DO 块里读取。
SELECT set_config('meal_agent.expected_db', :'expected_db', false);

DO $preflight$
DECLARE
  expected_database constant text := current_setting('meal_agent.expected_db');
BEGIN
  -- 1. 真的连到了 --dbname 指定的库。PGDATABASE、service 文件或连接串都不能
  --    把我们悄悄接到别的库上。
  IF current_database() <> expected_database THEN
    RAISE EXCEPTION
      'bootstrap preflight: connected to database %, expected %',
      current_database(), expected_database;
  END IF;

  -- 2. 目标库名必须是受控的项目标识符。
  IF current_database() !~ '^meal_agent(_[a-z0-9_]+)?$' THEN
    RAISE EXCEPTION
      'bootstrap preflight: % is not a project database name',
      current_database();
  END IF;

  -- 3. bootstrap 是如实记录的 cluster-admin 边界：授予 BYPASSRLS、变更
  --    database owner 都需要 superuser。身份不足时立即失败。
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE EXCEPTION
      'bootstrap preflight: % is not a cluster superuser; bootstrap requires '
      'cluster-admin capability', current_user;
  END IF;
END
$preflight$;
