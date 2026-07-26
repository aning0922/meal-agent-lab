-- 阶段 09A / M2A：登录角色。
--
-- 由 bootstrap/admin 在 owner 交接之后执行；可重复执行。
--
-- 身份与角色分离：登录角色自身 NOINHERIT 且不持有任何业务权限，必须显式
-- SET ROLE 才能取得对应的 NOLOGIN 角色权限。任何一个登录角色都不是
-- superuser，也没有 CREATEDB / CREATEROLE / REPLICATION / BYPASSRLS。
--
-- 密码通过环境变量注入，不出现在命令行、仓库或 psql 历史中。
-- 本轮只建立权限模型；Compose secret file 注入属于 M2B/M3。

\set ON_ERROR_STOP on

\getenv migration_password MEAL_AGENT_MIGRATION_PASSWORD
\getenv runtime_password MEAL_AGENT_RUNTIME_PASSWORD
\getenv backup_password MEAL_AGENT_BACKUP_PASSWORD

BEGIN;

DO $logins$
DECLARE
  login_role text;
BEGIN
  FOREACH login_role IN ARRAY ARRAY[
    'meal_agent_migration_login',
    'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = login_role) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT', login_role);
    END IF;
  END LOOP;
END
$logins$;

-- 每次执行都重申完整属性集：即使有人临时放宽过某个属性，重复 bootstrap
-- 也会把它收敛回基线，而不是保留扩大后的权限。
ALTER ROLE meal_agent_migration_login
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'migration_password';
ALTER ROLE meal_agent_runtime_login
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'runtime_password';
ALTER ROLE meal_agent_backup_login
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'backup_password';

-- ---------------------------------------------------------------------------
-- membership：每个登录角色只能进入自己那一个业务角色。
-- WITH INHERIT FALSE 让权限只能通过显式 SET ROLE 取得；SET 选项保持默认 TRUE。
-- ---------------------------------------------------------------------------
GRANT meal_agent_migrator TO meal_agent_migration_login WITH INHERIT FALSE;
GRANT meal_agent_app TO meal_agent_runtime_login WITH INHERIT FALSE;
GRANT meal_agent_backup TO meal_agent_backup_login WITH INHERIT FALSE;

-- ---------------------------------------------------------------------------
-- 显式收回全部越界 membership。
-- 重复执行 bootstrap 时，这一段保证权限矩阵收敛到基线而不是叠加。
-- ---------------------------------------------------------------------------
REVOKE meal_agent_migrator FROM meal_agent_runtime_login;
REVOKE meal_agent_backup FROM meal_agent_runtime_login;
REVOKE meal_agent_app FROM meal_agent_migration_login;
REVOKE meal_agent_backup FROM meal_agent_migration_login;
REVOKE meal_agent_app FROM meal_agent_backup_login;
REVOKE meal_agent_migrator FROM meal_agent_backup_login;

-- 登录角色自身不得直接持有业务对象权限；权限只挂在 NOLOGIN 角色上。
REVOKE ALL ON SCHEMA public FROM
  meal_agent_migration_login, meal_agent_runtime_login, meal_agent_backup_login;
REVOKE ALL ON SCHEMA drizzle FROM
  meal_agent_migration_login, meal_agent_runtime_login, meal_agent_backup_login;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM
  meal_agent_migration_login, meal_agent_runtime_login, meal_agent_backup_login;
REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM
  meal_agent_migration_login, meal_agent_runtime_login, meal_agent_backup_login;

COMMIT;
