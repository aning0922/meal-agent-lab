-- 阶段 09A / M2A：目标数据库 ACL 基线（database scope）。
--
-- 只在目标 meal_agent* 数据库存在后运行。fresh install 与 restore 之后都可复用：
-- 它不执行 0000，也不做 owner handoff，只收敛权限。
--
-- 处理四层：
--   1. 数据库级 ACL；
--   2. schema 级 ACL，含 public schema 的严格基线；
--   3. 三个登录角色的全部直接对象授权（schema / table / column / sequence /
--      routine / default privileges）；
--   4. 业务角色所需的最小 schema 可见性。
--
-- 收敛方式是「枚举 → 撤销 → 重新枚举 → 断言为空」，因此即使某种 REVOKE 形式
-- 覆盖不到某一类授权，最后的断言也会失败，而不是给出虚假的通过。

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. 登录角色不得拥有任何被管理对象。
--    若已成为 owner，说明归属状态未知：报告并失败，不静默接管，也不删除。
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
-- 1. 数据库级 ACL
--    默认 datacl 为 NULL，表示 PUBLIC 隐含拥有 CONNECT 与 TEMPORARY。
--    meal_agent_migrator 被刻意排除：它是（或将成为）database owner，
--    对 owner 执行 REVOKE ALL 会剥夺其隐含的 CREATE/TEMP 权限。
-- ---------------------------------------------------------------------------
REVOKE CONNECT, TEMPORARY ON DATABASE :"expected_db" FROM PUBLIC;
REVOKE ALL ON DATABASE :"expected_db" FROM
  meal_agent_migration_login, meal_agent_runtime_login, meal_agent_backup_login;
GRANT CONNECT ON DATABASE :"expected_db" TO
  meal_agent_migration_login, meal_agent_runtime_login, meal_agent_backup_login;
REVOKE ALL ON DATABASE :"expected_db" FROM meal_agent_app, meal_agent_backup;

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
    SELECT n.nspname, pg_catalog.pg_get_userbyid(acl.grantee) AS grantee
    FROM pg_namespace n, aclexplode(n.nspacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
    GROUP BY 1, 2
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I',
                   grant_row.nspname, grant_row.grantee);
  END LOOP;

  -- 2b. table / view / materialized view / foreign table / sequence
  FOR grant_row IN
    SELECT n.nspname, c.relname, c.relkind,
           pg_catalog.pg_get_userbyid(acl.grantee) AS grantee
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(c.relacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
    GROUP BY 1, 2, 3, 4
  LOOP
    IF grant_row.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM %I',
                     grant_row.nspname, grant_row.relname, grant_row.grantee);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I',
                     grant_row.nspname, grant_row.relname, grant_row.grantee);
    END IF;
  END LOOP;

  -- 2c. column 级：不会出现在 relacl 里，必须单独枚举 attacl
  FOR grant_row IN
    SELECT n.nspname, c.relname, a.attname,
           pg_catalog.pg_get_userbyid(acl.grantee) AS grantee,
           acl.privilege_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(a.attacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
  LOOP
    EXECUTE format('REVOKE %s (%I) ON TABLE %I.%I FROM %I',
                   grant_row.privilege_type, grant_row.attname,
                   grant_row.nspname, grant_row.relname, grant_row.grantee);
  END LOOP;

  -- 2d. routine 级
  FOR grant_row IN
    SELECT n.nspname, p.proname, p.oid AS prooid,
           pg_catalog.pg_get_userbyid(acl.grantee) AS grantee
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = ANY(login_roles)
    GROUP BY 1, 2, 3, 4
  LOOP
    EXECUTE format('REVOKE ALL ON ROUTINE %I.%I(%s) FROM %I',
                   grant_row.nspname, grant_row.proname,
                   pg_catalog.pg_get_function_identity_arguments(
                     grant_row.prooid),
                   grant_row.grantee);
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
      END,
      grant_row.grantee);
  END LOOP;
END
$revoke_login_grants$;

-- ---------------------------------------------------------------------------
-- 3. public schema 严格基线。
--    不再依赖 template 的默认 ACL：显式收回 PUBLIC 的 USAGE/CREATE，再显式把
--    USAGE 授予真正需要它的业务角色。migrator 是 schema owner，无需授予。
--    三个登录角色在 SET ROLE 之前因此对 public 没有有效 USAGE。
-- ---------------------------------------------------------------------------
REVOKE USAGE, CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM meal_agent_app, meal_agent_backup;
GRANT USAGE ON SCHEMA public TO meal_agent_app, meal_agent_backup;

REVOKE USAGE, CREATE ON SCHEMA drizzle FROM PUBLIC;
REVOKE CREATE ON SCHEMA drizzle FROM meal_agent_app, meal_agent_backup;
GRANT USAGE ON SCHEMA drizzle TO meal_agent_app, meal_agent_backup;

-- readiness 以 meal_agent_app 身份读取 migration ledger。
GRANT SELECT ON drizzle.__meal_agent_migrations TO meal_agent_app;

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
  problem text;
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

  -- 4c. public/drizzle schema 严格基线：PUBLIC 无 USAGE/CREATE；
  --     app/backup 有 USAGE 无 CREATE；三个 login 无有效 USAGE。
  FOREACH problem IN ARRAY ARRAY['public', 'drizzle']
  LOOP
    IF has_schema_privilege('public', problem, 'USAGE')
       OR has_schema_privilege('public', problem, 'CREATE') THEN
      RAISE EXCEPTION
        'acl baseline: PUBLIC still holds USAGE/CREATE on schema %', problem;
    END IF;
    IF NOT has_schema_privilege('meal_agent_app', problem, 'USAGE')
       OR NOT has_schema_privilege('meal_agent_backup', problem, 'USAGE') THEN
      RAISE EXCEPTION
        'acl baseline: app/backup lost USAGE on schema %', problem;
    END IF;
    IF has_schema_privilege('meal_agent_app', problem, 'CREATE')
       OR has_schema_privilege('meal_agent_backup', problem, 'CREATE') THEN
      RAISE EXCEPTION
        'acl baseline: app/backup must not hold CREATE on schema %', problem;
    END IF;
  END LOOP;

  SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO problem
  FROM unnest(login_roles) AS candidate
  WHERE has_schema_privilege(candidate, 'public', 'USAGE')
     OR has_schema_privilege(candidate, 'drizzle', 'USAGE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'acl baseline: % must not have effective USAGE before SET ROLE: %',
      problem, problem;
  END IF;
END
$verify$;

COMMIT;
