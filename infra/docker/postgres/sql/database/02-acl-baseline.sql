-- 阶段 09A / M2A：目标数据库 ACL 基线——**containment 阶段**（database scope）。
--
-- 全新安装时它在 owner handoff 之后、migration 之前运行；恢复时它在 pg_restore
-- 之后、migration 之前运行。两条路径的共同点是：此刻数据库里的授权可能来自
-- 任何地方（dump 带回来的、历史遗留的、第三方 grantor 授予的），因此这一阶段的
-- 职责是**收敛**——把一切不在 manifest 里的授权按真实 grantor 撤销，再只重建
-- manifest 允许的项。备份角色的表级 SELECT 属于 migration 之后的 final 阶段
-- （见 03-backup-grants.sql），这里不建立，也因此不会在 migration 期间多留一份
-- 可读全库的授权。
--
-- 授权本身由 ledger 感知的 manifest 描述：
--   事实源  services/api/src/database/authorization-manifest.ts
--   收敛    generated/authorization-converge.generated.sql
--   断言    generated/authorization-verify.generated.sql
-- 两个 generated 文件都禁止手改，由 `manifest:check` 逐字节校验。
--
-- 本文件只保留 manifest 覆盖不到的三类前置条件：managed schema 是否齐全、
-- 归属是否正确、以及 public/drizzle 里是否混进了 routine 或项目角色拥有的
-- Large Object。

\set ON_ERROR_STOP on

-- generated 收敛/断言块通过这个带命名空间的 GUC 得知当前阶段。
SELECT set_config('meal_agent.acl_phase', 'containment', false);

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. 三个 managed schema 必须都存在。缺失任何一个都说明这不是一个可以安全
--    收敛的目标：新安装漏了 0000，或恢复只恢复了一部分。
--    这一步在**任何 mutation 之前**执行。
-- ---------------------------------------------------------------------------
DO $managed_schemas_present$
DECLARE
  managed constant text[] := ARRAY[
    'public', 'drizzle', 'meal_agent_private'
  ];
  missing text;
BEGIN
  SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO missing
  FROM unnest(managed) AS candidate
  WHERE to_regnamespace(candidate) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: managed schema(s) missing: %; the database is not in a '
      'state this baseline can converge (fresh install must have applied '
      '0000_stage_06.sql; a restore must have restored every schema)', missing;
  END IF;
END
$managed_schemas_present$;

-- ---------------------------------------------------------------------------
-- 0a. 登录角色不得拥有任何被管理对象。
--     若已成为 owner，说明归属状态未知：报告并失败，不静默接管，也不删除。
-- ---------------------------------------------------------------------------
DO $owned_by_login$
DECLARE
  login_roles constant text[] := ARRAY[
    'meal_agent_migration_login',
    'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ];
  owned text;
BEGIN
  SELECT string_agg(entry, ', ' ORDER BY entry) INTO owned
  FROM (
    SELECT format('schema %s (owner %s)', nspname,
                  pg_catalog.pg_get_userbyid(nspowner)) AS entry
    FROM pg_namespace
    WHERE pg_catalog.pg_get_userbyid(nspowner) = ANY(login_roles)
    UNION ALL
    SELECT format('relation %s.%s (owner %s)', n.nspname, c.relname,
                  pg_catalog.pg_get_userbyid(c.relowner))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pg_catalog.pg_get_userbyid(c.relowner) = ANY(login_roles)
    UNION ALL
    SELECT format('routine %s.%s (owner %s)', n.nspname, p.proname,
                  pg_catalog.pg_get_userbyid(p.proowner))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE pg_catalog.pg_get_userbyid(p.proowner) = ANY(login_roles)
  ) AS owned_objects;

  IF owned IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: login role(s) own managed object(s); refusing to take '
      'over or drop them: %', owned;
  END IF;
END
$owned_by_login$;

-- ---------------------------------------------------------------------------
-- 0b. 任何 mutation 之前验证 owner。owner 不对时 fail closed——恢复路径尤其
--     不能靠 ACL 阶段偷偷接管归属。
-- ---------------------------------------------------------------------------
DO $owner_preconditions$
DECLARE
  problem text;
BEGIN
  IF (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_database
      WHERE datname = current_database()) <> 'meal_agent_migrator' THEN
    RAISE EXCEPTION
      'acl baseline: database owner is %, expected meal_agent_migrator; '
      'run "bootstrap.sh handoff" (fresh install) or restore with '
      'createdb --owner=meal_agent_migrator',
      (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_database
       WHERE datname = current_database());
  END IF;

  SELECT string_agg(format('%s (owner %s)', nspname,
                           pg_catalog.pg_get_userbyid(nspowner)), ', ')
    INTO problem
  FROM pg_namespace
  WHERE nspname IN ('public', 'drizzle', 'meal_agent_private')
    AND pg_catalog.pg_get_userbyid(nspowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: schema(s) not owned by meal_agent_migrator: %', problem;
  END IF;

  SELECT string_agg(format('%s.%s (owner %s)', n.nspname, c.relname,
                           pg_catalog.pg_get_userbyid(c.relowner)), ', ')
    INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle', 'meal_agent_private')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    AND pg_catalog.pg_get_userbyid(c.relowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: managed relation(s) not owned by meal_agent_migrator: %',
      problem;
  END IF;

  SELECT string_agg(format('%s.%s (owner %s)', n.nspname, p.proname,
                           pg_catalog.pg_get_userbyid(p.proowner)), ', ')
    INTO problem
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'drizzle', 'meal_agent_private')
    AND pg_catalog.pg_get_userbyid(p.proowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: managed routine(s) not owned by meal_agent_migrator: %',
      problem;
  END IF;
END
$owner_preconditions$;

-- ---------------------------------------------------------------------------
-- 0c. routine 边界与 Large Object 归属。
--
--   * public 与 drizzle 中不得存在任何 routine，更不得存在 SECURITY DEFINER
--     函数：受控状态转换函数都在 meal_agent_private，由 migrator 拥有。
--     恢复路径尤其需要这一条——dump 可以把任意函数带进 drizzle。
--   * 当前产品不使用 Large Object。项目角色**拥有** LO 属于异常状态，只报告
--     并失败，不静默删数据；LO 上的**权限**由 manifest 收敛块负责清零。
-- ---------------------------------------------------------------------------
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
      'acl baseline: public and drizzle must not contain routines: %', problem;
  END IF;

  SELECT string_agg(format('%s (owner %s)', m.oid,
                           pg_catalog.pg_get_userbyid(m.lomowner)), ', ')
    INTO problem
  FROM pg_largeobject_metadata m
  WHERE pg_catalog.pg_get_userbyid(m.lomowner) = ANY(project_roles);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: project role(s) own large object(s): %; this product does '
      'not use large objects, and this baseline will not drop data', problem;
  END IF;
END
$object_boundary$;

-- ---------------------------------------------------------------------------
-- 1. 授权收敛（生成文件，禁止手改）。
--    按真实 grantor 撤销一切不在 manifest 内的授权，再只重建允许项；同时收回
--    pg_catalog 中 Large Object 入口点的 PUBLIC EXECUTE。
-- ---------------------------------------------------------------------------
\ir generated/authorization-converge.generated.sql

-- ---------------------------------------------------------------------------
-- 2. 授权断言（生成文件，禁止手改）。
--    同时比对 catalog ACL、pg_default_acl 的有效默认权限，以及
--    has_*_privilege 的有效权限——PUBLIC 派生与角色继承都算在内。
-- ---------------------------------------------------------------------------
\ir generated/authorization-verify.generated.sql

COMMIT;
