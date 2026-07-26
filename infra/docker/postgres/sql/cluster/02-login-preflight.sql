-- 阶段 09A / M2A：设置口令前的预检。
--
-- 口令本身由 `bootstrap.sh logins` 通过 psql 的 \password 设置：客户端生成
-- SCRAM-SHA-256 verifier，原始口令不进入 SQL 文本、命令行或服务端日志。
-- 这里只确认目标角色已经由角色基线建立并规范化。

\set ON_ERROR_STOP on

DO $login_preflight$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO missing
  FROM unnest(ARRAY[
    'meal_agent_migration_login',
    'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ]) AS candidate
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = candidate);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'login preflight: % do not exist; run "bootstrap.sh roles" first',
      missing;
  END IF;

  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO missing
  FROM pg_roles
  WHERE rolname IN (
      'meal_agent_migration_login',
      'meal_agent_runtime_login',
      'meal_agent_backup_login'
    )
    AND (NOT rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'login preflight: % are not normalized; run "bootstrap.sh roles" first',
      missing;
  END IF;
END
$login_preflight$;
