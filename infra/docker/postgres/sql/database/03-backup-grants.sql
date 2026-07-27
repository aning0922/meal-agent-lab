-- 阶段 09A / M2A：目标数据库 ACL 基线——**final 阶段**（database scope）。
--
-- 由 bootstrap/admin 在 0001—最新 migration 应用之后执行；可重复执行。
--
-- containment（02-acl-baseline.sql）负责 migration 之前 / 恢复之后的收敛，
-- 那个阶段刻意**不**给备份角色任何表级 SELECT——migration 期间没有理由存在一份
-- 可读全库的授权。final 阶段才建立最终 ACL，并且**同时验证 PUBLIC、
-- meal_agent_app、meal_agent_backup 与三个 login**，而不是只看备份角色：
-- 只检查 backup 会漏掉「migration 顺手把某张新表授给了 PUBLIC」这类问题。
--
-- 授权本身由 ledger 感知的 manifest 描述：
--   事实源  services/api/src/database/authorization-manifest.ts
--   收敛    generated/authorization-converge.generated.sql
--   断言    generated/authorization-verify.generated.sql
-- 两个 generated 文件都禁止手改，由 `manifest:check` 逐字节校验。
--
-- M4 的恢复流程只在此登记约束，本轮不实现：恢复时复用 cluster/01-roles.sql
-- 预建 dump 引用的角色，不得在已有 dump 目标上重跑 0000，也不得对 dump 已经
-- 建立的对象重跑 owner handoff。

\set ON_ERROR_STOP on

SELECT set_config('meal_agent.acl_phase', 'final', false);

BEGIN;

-- 顺序预检：owner 交接必须已经完成，六个项目角色必须齐全。
DO $grants_preflight$
DECLARE
  missing text;
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

  SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO missing
  FROM unnest(ARRAY[
    'meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup',
    'meal_agent_migration_login', 'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ]) AS candidate
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = candidate);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: project role(s) missing: %; run "bootstrap.sh cluster" '
      'first', missing;
  END IF;
END
$grants_preflight$;

-- routine 边界与 Large Object 归属：与 containment 阶段同一条底线，migration
-- 之后再核一次（0001—0004 只应在 meal_agent_private 建函数）。
DO $object_boundary$
DECLARE
  project_roles constant text[] := ARRAY[
    'meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup',
    'meal_agent_migration_login', 'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ];
  problem text;
BEGIN
  SELECT string_agg(format('%s.%s(%s) [security definer: %s]',
                           n.nspname, p.proname,
                           pg_catalog.pg_get_function_identity_arguments(p.oid),
                           p.prosecdef),
                    ', ' ORDER BY n.nspname, p.proname)
    INTO problem
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'drizzle');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: public and drizzle must not contain routines: %', problem;
  END IF;

  SELECT string_agg(format('%s (owner %s)', m.oid,
                           pg_catalog.pg_get_userbyid(m.lomowner)), ', ')
    INTO problem
  FROM pg_largeobject_metadata m
  WHERE pg_catalog.pg_get_userbyid(m.lomowner) = ANY(project_roles);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: project role(s) own large object(s): %', problem;
  END IF;
END
$object_boundary$;

-- ---------------------------------------------------------------------------
-- 1. 授权收敛（生成文件，禁止手改）：final 阶段的允许集合包含备份角色的表级
--    非 grantable SELECT 与三条 default privileges。
-- ---------------------------------------------------------------------------
\ir generated/authorization-converge.generated.sql

-- ---------------------------------------------------------------------------
-- 2. 授权断言（生成文件，禁止手改）：PUBLIC、app、backup、三个 login 一起验证，
--    catalog ACL / 有效默认权限 / has_*_privilege 有效权限三者同时比对。
-- ---------------------------------------------------------------------------
\ir generated/authorization-verify.generated.sql

COMMIT;
