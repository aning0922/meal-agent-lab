-- 阶段 09A / M2A：目标数据库 ACL 基线（database scope）。
--
-- 只在目标 meal_agent* 数据库存在后运行。fresh install 与 restore 之后都可复用：
-- 它不执行 0000，也不做 owner handoff，只收敛权限。
--
-- 处理六层：
--   1. 三个 managed schema 的存在性（任何 mutation 之前）；
--   2. 数据库级 ACL，含 PUBLIC 的跨 grantor 收敛；
--   3. 三个登录角色的全部直接对象授权；
--   4. 三个 managed schema 的 schema 级 ACL，含 PUBLIC / app / backup 的跨
--      grantor 收敛与唯一目标基线；
--   5. routine 边界：public 与 drizzle 不得存在 routine，PUBLIC 不得持有
--      EXECUTE；app / backup / 三个 login 的**有效** EXECUTE 逐条验证，因此
--      恢复路径上「某个 routine 把 EXECUTE 授给 PUBLIC」也会被抓到；
--   6. Large Object：当前产品不使用，任何指向项目角色或 PUBLIC 的 LO 权限与
--      objtype='L' 的异常默认权限一律收敛并断言为空。
--
-- 收敛方式是「枚举 → 撤销 → 重新枚举 → 断言为空」，因此即使某种 REVOKE 形式
-- 覆盖不到某一类授权，最后的断言也会失败，而不是给出虚假的通过。
--
-- 跨 grantor 的授权必须**真正撤销**，不能依赖后置校验失败后整体回滚：回滚只是
-- 让命令失败，权限仍然留在数据库里。因此每一类 ACL 都以真实 grantor 的身份
-- （`SET LOCAL ROLE`）逐条撤销。

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. 三个 managed schema 必须都存在。缺失任何一个都说明这不是一个可以安全
--    收敛的目标：恢复路径可能只恢复了一部分，fresh install 可能漏了 0000。
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
-- 1. 数据库级 ACL
--    默认 datacl 为 NULL，表示 PUBLIC 隐含拥有 CONNECT 与 TEMPORARY；这条隐含
--    授权的 grantor 是 database owner，用一条普通 REVOKE 物化并清除即可。
--    但**显式**的 PUBLIC 授权可能来自任何第三方 grantor，普通 REVOKE 对它无效，
--    必须以真实 grantor 的身份逐条撤销——否则只能在后置校验里失败并整体回滚，
--    而权限依旧留在数据库里。
--
--    meal_agent_migrator 被刻意排除：它是 database owner，对 owner 执行
--    REVOKE ALL 会剥夺其隐含的 CREATE/TEMP 权限。
-- ---------------------------------------------------------------------------
REVOKE CONNECT, TEMPORARY ON DATABASE :"expected_db" FROM PUBLIC;

DO $database_acl$
DECLARE
  targets constant text[] := ARRAY[
    'meal_agent_migration_login', 'meal_agent_runtime_login',
    'meal_agent_backup_login', 'meal_agent_app', 'meal_agent_backup'
  ];
  grant_row record;
BEGIN
  FOR grant_row IN
    SELECT d.datname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident(pg_catalog.pg_get_userbyid(acl.grantee))
           END AS grantee,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type
    FROM pg_database d, aclexplode(d.datacl) AS acl
    WHERE d.datname = current_database()
      AND (acl.grantee = 0
           OR pg_catalog.pg_get_userbyid(acl.grantee) = ANY(targets))
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    EXECUTE format('REVOKE %s ON DATABASE %I FROM %s CASCADE',
                   grant_row.privilege_type, grant_row.datname,
                   grant_row.grantee);
    RESET ROLE;
  END LOOP;
END
$database_acl$;

GRANT CONNECT ON DATABASE :"expected_db" TO
  meal_agent_migration_login, meal_agent_runtime_login, meal_agent_backup_login;

-- ---------------------------------------------------------------------------
-- 2. 三个登录角色的全部直接对象授权：逐条枚举并撤销。
--    覆盖 schema、table/view/sequence（relacl）、column（attacl）、
--    routine（proacl）与 default privileges（pg_default_acl）。
-- ---------------------------------------------------------------------------
DO $revoke_login_grants$
DECLARE
  login_roles constant text[] := ARRAY[
    'meal_agent_migration_login',
    'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ];
  grant_row record;
BEGIN
  -- 2a. schema 级
  FOR grant_row IN
    SELECT n.nspname, pg_catalog.pg_get_userbyid(acl.grantee) AS grantee,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor
    FROM pg_namespace n, aclexplode(n.nspacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
    GROUP BY 1, 2, 3
  LOOP
    -- 必须以**真实 grantor 的身份**撤销：不带这一步的 REVOKE 只会撤销
    -- 「由执行者授予」的那一份。对象权限的 GRANTED BY 只接受 current_user
    -- （"grantor must be current user"），因此这里 SET LOCAL ROLE 到 grantor。
    -- CASCADE 是显式选择：依赖链一并清除，保证收敛。
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I CASCADE',
                   grant_row.nspname, grant_row.grantee);
    RESET ROLE;
  END LOOP;

  -- 2b. table / view / materialized view / foreign table / sequence
  FOR grant_row IN
    SELECT n.nspname, c.relname, c.relkind,
           pg_catalog.pg_get_userbyid(acl.grantee) AS grantee,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(c.relacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    -- 精确按 privilege_type 撤销（含 GRANT OPTION FOR），而不是 REVOKE ALL：
    -- sequence 的 USAGE/SELECT/UPDATE 语义不同，必须逐项处理。
    IF grant_row.relkind = 'S' THEN
      EXECUTE format(
        'REVOKE GRANT OPTION FOR %s ON SEQUENCE %I.%I FROM %I CASCADE',
        grant_row.privilege_type, grant_row.nspname, grant_row.relname,
        grant_row.grantee);
      EXECUTE format('REVOKE %s ON SEQUENCE %I.%I FROM %I CASCADE',
                     grant_row.privilege_type, grant_row.nspname,
                     grant_row.relname, grant_row.grantee);
    ELSE
      EXECUTE format(
        'REVOKE GRANT OPTION FOR %s ON TABLE %I.%I FROM %I CASCADE',
        grant_row.privilege_type, grant_row.nspname, grant_row.relname,
        grant_row.grantee);
      EXECUTE format('REVOKE %s ON TABLE %I.%I FROM %I CASCADE',
                     grant_row.privilege_type, grant_row.nspname,
                     grant_row.relname, grant_row.grantee);
    END IF;
    RESET ROLE;
  END LOOP;

  -- 2c. column 级：不会出现在 relacl 里，必须单独枚举 attacl
  FOR grant_row IN
    SELECT n.nspname, c.relname, a.attname,
           pg_catalog.pg_get_userbyid(acl.grantee) AS grantee,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(a.attacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    EXECUTE format('REVOKE %s (%I) ON TABLE %I.%I FROM %I CASCADE',
                   grant_row.privilege_type, grant_row.attname,
                   grant_row.nspname, grant_row.relname, grant_row.grantee);
    RESET ROLE;
  END LOOP;

  -- 2d. routine 级
  FOR grant_row IN
    SELECT n.nspname, p.proname, p.oid AS prooid,
           pg_catalog.pg_get_userbyid(acl.grantee) AS grantee,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
    GROUP BY 1, 2, 3, 4, 5
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    EXECUTE format('REVOKE ALL ON ROUTINE %I.%I(%s) FROM %I CASCADE',
                   grant_row.nspname, grant_row.proname,
                   pg_catalog.pg_get_function_identity_arguments(
                     grant_row.prooid),
                   grant_row.grantee);
    RESET ROLE;
  END LOOP;

  -- 2e. default privileges：FOR ROLE 必须与 defaclrole 精确匹配
  FOR grant_row IN
    SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS defowner,
           n.nspname,
           d.defaclobjtype,
           pg_catalog.pg_get_userbyid(acl.grantee) AS grantee
    FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace,
         aclexplode(d.defaclacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
    GROUP BY 1, 2, 3, 4
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL ON %s FROM %I',
      grant_row.defowner,
      CASE WHEN grant_row.nspname IS NULL THEN ''
           ELSE format(' IN SCHEMA %I', grant_row.nspname) END,
      CASE grant_row.defaclobjtype
        WHEN 'r' THEN 'TABLES'
        WHEN 'S' THEN 'SEQUENCES'
        WHEN 'f' THEN 'FUNCTIONS'
        WHEN 'T' THEN 'TYPES'
        WHEN 'n' THEN 'SCHEMAS'
        WHEN 'L' THEN 'LARGE OBJECTS'
      END,
      grant_row.grantee);
  END LOOP;
END
$revoke_login_grants$;

-- ---------------------------------------------------------------------------
-- 3. 三个 managed schema 的严格基线。
--
--    先按真实 grantor 收敛 PUBLIC、meal_agent_app 与 meal_agent_backup 在这三个
--    schema 上的**全部** schema 级授权（三个 login 已在第 2 步收敛），再显式建立
--    唯一目标基线。这样跨 grantor 的 PUBLIC USAGE/CREATE 会被真正撤销，而不是
--    留到后置校验才失败。
--
--    meal_agent_private 是受控状态转换函数所在的 schema：
--      * PUBLIC 无 USAGE / CREATE；
--      * meal_agent_app 只有 USAGE，没有 CREATE，因此不能在其中建对象；
--      * meal_agent_backup 与三个 login 完全没有有效访问。
-- ---------------------------------------------------------------------------
DO $converge_schema_acl$
DECLARE
  managed constant text[] := ARRAY[
    'public', 'drizzle', 'meal_agent_private'
  ];
  business_roles constant text[] := ARRAY[
    'meal_agent_app', 'meal_agent_backup'
  ];
  grant_row record;
BEGIN
  FOR grant_row IN
    SELECT n.nspname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident(pg_catalog.pg_get_userbyid(acl.grantee))
           END AS grantee,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type
    FROM pg_namespace n, aclexplode(n.nspacl) AS acl
    WHERE n.nspname = ANY(managed)
      AND (acl.grantee = 0
           OR pg_catalog.pg_get_userbyid(acl.grantee) = ANY(business_roles))
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    EXECUTE format('REVOKE GRANT OPTION FOR %s ON SCHEMA %I FROM %s CASCADE',
                   grant_row.privilege_type, grant_row.nspname,
                   grant_row.grantee);
    EXECUTE format('REVOKE %s ON SCHEMA %I FROM %s CASCADE',
                   grant_row.privilege_type, grant_row.nspname,
                   grant_row.grantee);
    RESET ROLE;
  END LOOP;
END
$converge_schema_acl$;

-- nspacl 为 NULL 时是隐含默认 ACL（PUBLIC 对 public schema 有 USAGE），
-- aclexplode 展不开，用普通 REVOKE 物化并清除。
REVOKE USAGE, CREATE ON SCHEMA public FROM PUBLIC;
REVOKE USAGE, CREATE ON SCHEMA drizzle FROM PUBLIC;
REVOKE USAGE, CREATE ON SCHEMA meal_agent_private FROM PUBLIC;

-- 唯一目标基线：只授 USAGE，绝不授 CREATE。migrator 是 schema owner，无需授予。
GRANT USAGE ON SCHEMA public TO meal_agent_app, meal_agent_backup;
GRANT USAGE ON SCHEMA drizzle TO meal_agent_app, meal_agent_backup;
GRANT USAGE ON SCHEMA meal_agent_private TO meal_agent_app;

-- readiness 以 meal_agent_app 身份读取 migration ledger。
GRANT SELECT ON drizzle.__meal_agent_migrations TO meal_agent_app;

-- ---------------------------------------------------------------------------
-- 3b. routine 边界。
--
--   * public 与 drizzle 中不得存在任何 routine，更不得存在 SECURITY DEFINER
--     函数：受控状态转换函数都在 meal_agent_private，由 migrator 拥有。
--     恢复路径尤其需要这一条——dump 可以把任意函数带进 drizzle。
--   * PostgreSQL 默认把新函数的 EXECUTE 授予 PUBLIC。这里显式收回三个 managed
--     schema 中现有 routine 的 PUBLIC EXECUTE，并用 default privileges 收回
--     migrator 今后新建 routine 的 PUBLIC EXECUTE。
--   * **不**对 app 使用 `GRANT EXECUTE ON ALL FUNCTIONS`：app 的函数权限只能
--     来自冻结 migration 明确授予的那一组，这里不得扩大。
-- ---------------------------------------------------------------------------
DO $routine_boundary$
DECLARE
  managed constant text[] := ARRAY[
    'public', 'drizzle', 'meal_agent_private'
  ];
  problem text;
  routine_row record;
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

  FOR routine_row IN
    SELECT n.nspname, p.proname, p.oid AS prooid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
         -- proacl 为 NULL 时是**隐式**默认 ACL（PUBLIC 有 EXECUTE），
         -- aclexplode(NULL) 会漏掉它，因此用 acldefault 展开。
         aclexplode(COALESCE(p.proacl,
                             acldefault('f', p.proowner))) AS acl
    WHERE n.nspname = ANY(managed)
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
    GROUP BY 1, 2, 3
  LOOP
    EXECUTE format('REVOKE EXECUTE ON ROUTINE %I.%I(%s) FROM PUBLIC',
                   routine_row.nspname, routine_row.proname,
                   pg_catalog.pg_get_function_identity_arguments(
                     routine_row.prooid));
  END LOOP;
END
$routine_boundary$;

-- migrator 今后新建的 routine 不再默认授予 PUBLIC EXECUTE。
-- 这里用**全局**（不带 IN SCHEMA）形式：带 schema 的默认权限只覆盖该 schema，
-- 覆盖不到将来出现在其他 schema 的函数。
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3c. Large Object。
--
-- 当前产品不使用 Large Object，也不打算引入：LO 不受 schema ACL 与 RLS 约束，
-- 一旦某个项目角色（或 PUBLIC）拿到 LO 权限，就等于绕开了整套边界。这里的策略
-- 是「存在即收敛并断言为空」，不为此扩展任何业务能力：
--   * pg_largeobject_metadata.lomacl 中授予项目角色或 PUBLIC 的权限逐条撤销；
--   * pg_default_acl 中 objtype='L' 的非 owner 默认权限一律撤销。
-- LO 的**归属**不做变更：项目角色拥有 LO 属于异常状态，只报告并失败，不静默
-- 删除数据。
-- ---------------------------------------------------------------------------
DO $converge_large_objects$
DECLARE
  project_roles constant text[] := ARRAY[
    'meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup',
    'meal_agent_migration_login', 'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ];
  owned text;
  lo_row record;
BEGIN
  SELECT string_agg(format('%s (owner %s)', m.oid,
                           pg_catalog.pg_get_userbyid(m.lomowner)), ', ')
    INTO owned
  FROM pg_largeobject_metadata m
  WHERE pg_catalog.pg_get_userbyid(m.lomowner) = ANY(project_roles);
  IF owned IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: project role(s) own large object(s): %; this product does '
      'not use large objects, and this baseline will not drop data', owned;
  END IF;

  FOR lo_row IN
    SELECT m.oid AS loid,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident(pg_catalog.pg_get_userbyid(acl.grantee))
           END AS grantee,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type
    FROM pg_largeobject_metadata m, aclexplode(m.lomacl) AS acl
    WHERE acl.grantee = 0
       OR pg_catalog.pg_get_userbyid(acl.grantee) = ANY(project_roles)
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', lo_row.grantor);
    EXECUTE format('REVOKE %s ON LARGE OBJECT %s FROM %s CASCADE',
                   lo_row.privilege_type, lo_row.loid, lo_row.grantee);
    RESET ROLE;
  END LOOP;

  -- objtype='L' 的默认权限不分 schema（LO 不属于任何 schema），因此没有
  -- IN SCHEMA 子句。owner 自身的隐含条目不算漂移，不去动它。
  FOR lo_row IN
    SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS defowner,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident(pg_catalog.pg_get_userbyid(acl.grantee))
           END AS grantee
    FROM pg_default_acl d, aclexplode(d.defaclacl) AS acl
    WHERE d.defaclobjtype = 'L'
      AND acl.grantee IS DISTINCT FROM d.defaclrole
    GROUP BY 1, 2
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON LARGE OBJECTS '
      'FROM %s', lo_row.defowner, lo_row.grantee);
  END LOOP;
END
$converge_large_objects$;

-- ---------------------------------------------------------------------------
-- 3d. 被管理对象的 owner 必须是 migrator——不只是「login 不能是 owner」。
-- ---------------------------------------------------------------------------
DO $managed_owners$
DECLARE
  problem text;
BEGIN
  SELECT string_agg(format('%s %s.%s (owner %s)',
           CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view'
                          WHEN 'm' THEN 'matview' ELSE 'table' END,
           n.nspname, c.relname, pg_catalog.pg_get_userbyid(c.relowner)),
         ', ' ORDER BY n.nspname, c.relname)
    INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    AND pg_catalog.pg_get_userbyid(c.relowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: managed relation(s) not owned by meal_agent_migrator: %',
      problem;
  END IF;

  SELECT string_agg(format('%s.%s (owner %s)', n.nspname, p.proname,
                           pg_catalog.pg_get_userbyid(p.proowner)),
                    ', ' ORDER BY n.nspname, p.proname)
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
$managed_owners$;

-- ---------------------------------------------------------------------------
-- 4. 结果自检：枚举必须为空，基线必须成立。
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  login_roles constant text[] := ARRAY[
    'meal_agent_migration_login',
    'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ];
  managed constant text[] := ARRAY[
    'public', 'drizzle', 'meal_agent_private'
  ];
  problem text;
  schema_name text;
BEGIN
  -- 4a. 三个登录角色不得再有任何直接对象授权。
  SELECT string_agg(entry, ', ' ORDER BY entry) INTO problem
  FROM (
    SELECT format('schema %s -> %s', n.nspname,
                  pg_catalog.pg_get_userbyid(acl.grantee)) AS entry
    FROM pg_namespace n, aclexplode(n.nspacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
    UNION ALL
    SELECT format('relation %s.%s -> %s', n.nspname, c.relname,
                  pg_catalog.pg_get_userbyid(acl.grantee))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(c.relacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
    UNION ALL
    SELECT format('column %s.%s.%s -> %s', n.nspname, c.relname, a.attname,
                  pg_catalog.pg_get_userbyid(acl.grantee))
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(a.attacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
    UNION ALL
    SELECT format('routine %s.%s -> %s', n.nspname, p.proname,
                  pg_catalog.pg_get_userbyid(acl.grantee))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
    UNION ALL
    SELECT format('default privilege %s -> %s',
                  coalesce(n.nspname, '<cluster>'),
                  pg_catalog.pg_get_userbyid(acl.grantee))
    FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace,
         aclexplode(d.defaclacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
  ) AS remaining;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: login role(s) still hold direct grant(s): %', problem;
  END IF;

  -- 4b. 数据库级：PUBLIC 无 CONNECT/TEMP；三个 login 恰好只有 CONNECT。
  IF has_database_privilege('public', current_database(), 'CONNECT')
     OR has_database_privilege('public', current_database(), 'TEMP') THEN
    RAISE EXCEPTION 'acl baseline: PUBLIC still holds CONNECT/TEMP on %',
      current_database();
  END IF;

  SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO problem
  FROM unnest(login_roles) AS candidate
  WHERE NOT has_database_privilege(candidate, current_database(), 'CONNECT')
     OR has_database_privilege(candidate, current_database(), 'TEMP')
     OR has_database_privilege(candidate, current_database(), 'CREATE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: % must hold exactly CONNECT on %', problem,
      current_database();
  END IF;

  SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO problem
  FROM unnest(ARRAY['meal_agent_app', 'meal_agent_backup']) AS candidate
  WHERE has_database_privilege(candidate, current_database(), 'TEMP');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'acl baseline: % must not hold TEMP', problem;
  END IF;

  -- 4c. 三个 managed schema 的严格基线：
  --     PUBLIC 无 USAGE/CREATE；app 三个 schema 都有 USAGE、都无 CREATE；
  --     backup 只有 public/drizzle 的 USAGE，对 meal_agent_private 无访问；
  --     三个 login 对三个 schema 都没有有效 USAGE。
  FOREACH schema_name IN ARRAY managed
  LOOP
    IF has_schema_privilege('public', schema_name, 'USAGE')
       OR has_schema_privilege('public', schema_name, 'CREATE') THEN
      RAISE EXCEPTION
        'acl baseline: PUBLIC still holds USAGE/CREATE on schema %',
        schema_name;
    END IF;

    IF NOT has_schema_privilege('meal_agent_app', schema_name, 'USAGE') THEN
      RAISE EXCEPTION
        'acl baseline: meal_agent_app lost USAGE on schema %', schema_name;
    END IF;

    IF has_schema_privilege('meal_agent_app', schema_name, 'CREATE') THEN
      RAISE EXCEPTION
        'acl baseline: meal_agent_app must not hold CREATE on schema %',
        schema_name;
    END IF;

    IF has_schema_privilege('meal_agent_backup', schema_name, 'CREATE') THEN
      RAISE EXCEPTION
        'acl baseline: meal_agent_backup must not hold CREATE on schema %',
        schema_name;
    END IF;

    IF schema_name = 'meal_agent_private' THEN
      IF has_schema_privilege('meal_agent_backup', schema_name, 'USAGE') THEN
        RAISE EXCEPTION
          'acl baseline: meal_agent_backup must not have USAGE on %',
          schema_name;
      END IF;
    ELSIF NOT has_schema_privilege('meal_agent_backup', schema_name, 'USAGE')
    THEN
      RAISE EXCEPTION
        'acl baseline: meal_agent_backup lost USAGE on schema %', schema_name;
    END IF;

    SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO problem
    FROM unnest(login_roles) AS candidate
    WHERE has_schema_privilege(candidate, schema_name, 'USAGE')
       OR has_schema_privilege(candidate, schema_name, 'CREATE');
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION
        'acl baseline: % must not have effective access to schema % before '
        'SET ROLE', problem, schema_name;
    END IF;
  END LOOP;

  -- 4d0. PUBLIC 不得对任何 managed routine 持有 EXECUTE。单独断言是为了给出
  --      直接的原因，而不是只在 4d 里表现为「每个角色都多了一份 EXECUTE」。
  SELECT string_agg(format('%s.%s(%s)', n.nspname, p.proname,
                           pg_catalog.pg_get_function_identity_arguments(p.oid)),
                    ', ' ORDER BY n.nspname, p.proname)
    INTO problem
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
       aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
  WHERE n.nspname = ANY(managed)
    AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: PUBLIC still holds EXECUTE on routine(s): %', problem;
  END IF;

  -- 4d. routine 的**有效** EXECUTE 边界。
  --     用 has_function_privilege 而不是只看 proacl 中的直接 grantee：PUBLIC
  --     授权会派生给每一个角色，只查直接授权会漏掉恢复路径带进来的
  --     `GRANT EXECUTE ... TO PUBLIC`。
  SELECT string_agg(entry, ', ' ORDER BY entry) INTO problem
  FROM (
    SELECT format('%s.%s(%s) -> %s [security definer: %s]',
                  n.nspname, p.proname,
                  pg_catalog.pg_get_function_identity_arguments(p.oid),
                  candidate, p.prosecdef) AS entry
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         unnest(ARRAY['meal_agent_app', 'meal_agent_backup',
                      'meal_agent_migration_login',
                      'meal_agent_runtime_login',
                      'meal_agent_backup_login']) AS candidate
    WHERE n.nspname = ANY(managed)
      AND has_function_privilege(candidate, p.oid, 'EXECUTE')
      AND NOT (candidate = 'meal_agent_app'
               AND n.nspname = 'meal_agent_private')
  ) AS effective_execute;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: unexpected effective EXECUTE: %', problem;
  END IF;

  -- 4e. Large Object：项目角色与 PUBLIC 都不得持有任何 LO 权限，
  --     objtype='L' 也不得留下任何非 owner 默认权限。
  SELECT string_agg(entry, ', ' ORDER BY entry) INTO problem
  FROM (
    SELECT format('large object %s -> %s (%s)', m.oid,
                  CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
                  acl.privilege_type) AS entry
    FROM pg_largeobject_metadata m, aclexplode(m.lomacl) AS acl
    WHERE acl.grantee = 0
       OR pg_catalog.pg_get_userbyid(acl.grantee) = ANY(ARRAY[
            'meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup',
            'meal_agent_migration_login', 'meal_agent_runtime_login',
            'meal_agent_backup_login'])
    UNION ALL
    SELECT format('default large object privilege %s -> %s',
                  pg_catalog.pg_get_userbyid(d.defaclrole),
                  CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(acl.grantee) END)
    FROM pg_default_acl d, aclexplode(d.defaclacl) AS acl
    WHERE d.defaclobjtype = 'L'
      AND acl.grantee IS DISTINCT FROM d.defaclrole
  ) AS large_objects;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: large object privileges must be empty: %', problem;
  END IF;
END
$verify$;

COMMIT;
