-- 阶段 09A / M2A：migration 之后的备份角色只读补授。
--
-- 由 bootstrap/admin 在 0001—最新 migration 应用之后执行；可重复执行。
--
-- 本文件的 ALTER DEFAULT PRIVILEGES 覆盖「由 migrator 新建的表与 sequence」，
-- 前面的显式补授则兜底历史上由其他角色建立的对象。
-- 只授予 SELECT，并再次收回全部写权限与 DDL 权限。
--
-- M4 的恢复流程只在此登记约束，本轮不实现：恢复时复用 cluster/01-roles.sql
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
      '"bootstrap.sh cluster" first';
  END IF;
END
$grants_preflight$;

-- ---------------------------------------------------------------------------
-- 1. 先收敛 backup 现有的一切异常权限：跨 grantor、grant option、列级、
--    sequence 的 USAGE/UPDATE、routine EXECUTE 与 database 级异常。
-- ---------------------------------------------------------------------------
DO $converge_backup$
DECLARE
  grant_row record;
BEGIN
  -- 1a. database 级
  FOR grant_row IN
    SELECT d.datname, pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type
    FROM pg_database d, aclexplode(d.datacl) AS acl
    WHERE d.datname = current_database() AND acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    EXECUTE format('REVOKE %s ON DATABASE %I FROM meal_agent_backup CASCADE',
                   grant_row.privilege_type, grant_row.datname);
    RESET ROLE;
  END LOOP;

  -- 1b. schema 级
  FOR grant_row IN
    SELECT n.nspname, pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type
    FROM pg_namespace n, aclexplode(n.nspacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    EXECUTE format('REVOKE %s ON SCHEMA %I FROM meal_agent_backup CASCADE',
                   grant_row.privilege_type, grant_row.nspname);
    RESET ROLE;
  END LOOP;

  -- 1c. relation 级（表/视图/序列），逐 privilege 精确撤销，含 grant option
  FOR grant_row IN
    SELECT n.nspname, c.relname, c.relkind,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(c.relacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    IF grant_row.relkind = 'S' THEN
      EXECUTE format('REVOKE GRANT OPTION FOR %s ON SEQUENCE %I.%I '
                     'FROM meal_agent_backup CASCADE',
                     grant_row.privilege_type, grant_row.nspname,
                     grant_row.relname);
      EXECUTE format('REVOKE %s ON SEQUENCE %I.%I FROM meal_agent_backup CASCADE',
                     grant_row.privilege_type, grant_row.nspname,
                     grant_row.relname);
    ELSE
      EXECUTE format('REVOKE GRANT OPTION FOR %s ON TABLE %I.%I '
                     'FROM meal_agent_backup CASCADE',
                     grant_row.privilege_type, grant_row.nspname,
                     grant_row.relname);
      EXECUTE format('REVOKE %s ON TABLE %I.%I FROM meal_agent_backup CASCADE',
                     grant_row.privilege_type, grant_row.nspname,
                     grant_row.relname);
    END IF;
    RESET ROLE;
  END LOOP;

  -- 1d. 列级
  FOR grant_row IN
    SELECT n.nspname, c.relname, a.attname,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(a.attacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    EXECUTE format('REVOKE %s (%I) ON TABLE %I.%I FROM meal_agent_backup CASCADE',
                   grant_row.privilege_type, grant_row.attname,
                   grant_row.nspname, grant_row.relname);
    RESET ROLE;
  END LOOP;

  -- 1e. routine 级
  FOR grant_row IN
    SELECT n.nspname, p.proname, p.oid AS prooid,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
    GROUP BY 1, 2, 3, 4
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    -- format 只有三个占位符；grantee 固定为 meal_agent_backup，
    -- 多传一个未 SELECT 的 grant_row.grantee 会在循环体真正执行时报运行时错误。
    EXECUTE format('REVOKE ALL ON ROUTINE %I.%I(%s) FROM meal_agent_backup CASCADE',
                   grant_row.nspname, grant_row.proname,
                   pg_catalog.pg_get_function_identity_arguments(
                     grant_row.prooid));
    RESET ROLE;
  END LOOP;

  -- 1f. pg_default_acl 中所有授给 backup 的默认权限，先全部清除。
  FOR grant_row IN
    SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS defowner,
           n.nspname, d.defaclobjtype
    FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace,
         aclexplode(d.defaclacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
    GROUP BY 1, 2, 3
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL ON %s '
      'FROM meal_agent_backup',
      grant_row.defowner,
      CASE WHEN grant_row.nspname IS NULL THEN ''
           ELSE format(' IN SCHEMA %I', grant_row.nspname) END,
      CASE grant_row.defaclobjtype
        WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES'
        WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES'
        WHEN 'n' THEN 'SCHEMAS' WHEN 'L' THEN 'LARGE OBJECTS' END);
  END LOOP;

  -- 1g. Large Object：备份角色是「可以读到全部业务数据」的敏感角色，因此它更
  --     不能顺带拿到不受 schema ACL 与 RLS 约束的 LO 权限。当前产品不使用 LO，
  --     这里直接收敛掉指向 backup 的 LO 权限与 objtype='L' 默认权限。
  FOR grant_row IN
    SELECT m.oid AS loid,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type
    FROM pg_largeobject_metadata m, aclexplode(m.lomacl) AS acl
    WHERE acl.grantee <> 0
      AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', grant_row.grantor);
    EXECUTE format(
      'REVOKE %s ON LARGE OBJECT %s FROM meal_agent_backup CASCADE',
      grant_row.privilege_type, grant_row.loid);
    RESET ROLE;
  END LOOP;
END
$converge_backup$;

-- ---------------------------------------------------------------------------
-- 2. 建立唯一目标基线。
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO meal_agent_backup;
GRANT USAGE ON SCHEMA drizzle TO meal_agent_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO meal_agent_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO meal_agent_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO meal_agent_backup;

-- 今后由 migrator 新建的对象：table/drizzle table 与 public sequence 只给
-- 非 grantable 的 SELECT；其他对象类型、其他 schema 一律不给默认权限。
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO meal_agent_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO meal_agent_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO meal_agent_backup;

-- ---------------------------------------------------------------------------
-- 3. 结果自检：当前 ACL 与 pg_default_acl 都必须精确。
-- ---------------------------------------------------------------------------
DO $verify_backup$
DECLARE
  problem text;
BEGIN
  -- 3a. relation：public/drizzle 的表只有非 grantable SELECT；
  --     public sequence 只有非 grantable SELECT；其他一律不允许。
  SELECT string_agg(format('%s.%s:%s%s', n.nspname, c.relname,
                           acl.privilege_type,
                           CASE WHEN acl.is_grantable THEN ' (grantable)'
                                ELSE '' END), ', ')
    INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       aclexplode(c.relacl) AS acl
  WHERE acl.grantee <> 0
    AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
    AND (acl.privilege_type <> 'SELECT'
         OR acl.is_grantable
         OR n.nspname NOT IN ('public', 'drizzle'));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: backup must hold only non-grantable SELECT on '
      'public/drizzle relations: %', problem;
  END IF;

  -- 3b. 列级授权一律不应存在。
  SELECT string_agg(format('%s.%s.%s', n.nspname, c.relname, a.attname), ', ')
    INTO problem
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace,
       aclexplode(a.attacl) AS acl
  WHERE acl.grantee <> 0
    AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: backup must not hold column-level grants: %', problem;
  END IF;

  -- 3c. routine：backup 不得持有任何**有效** EXECUTE。
  --     用 has_function_privilege 而不是只看直接 grantee：`GRANT EXECUTE ...
  --     TO PUBLIC` 会派生给 backup，恢复路径带进来的这类授权只查直接授权是看
  --     不见的。SECURITY DEFINER 函数尤其致命——那等于让 backup 以 migrator
  --     身份执行。
  SELECT string_agg(entry, ', ' ORDER BY entry) INTO problem
  FROM (
    SELECT format('%s.%s(%s) [security definer: %s]', n.nspname, p.proname,
                  pg_catalog.pg_get_function_identity_arguments(p.oid),
                  p.prosecdef) AS entry
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE has_function_privilege('meal_agent_backup', p.oid, 'EXECUTE')
      AND n.nspname IN ('public', 'drizzle', 'meal_agent_private')
  ) AS effective_execute;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: backup must not hold routine EXECUTE: %', problem;
  END IF;

  -- 3d. schema：只有 public/drizzle 的 USAGE。
  SELECT string_agg(format('%s:%s', n.nspname, acl.privilege_type), ', ')
    INTO problem
  FROM pg_namespace n, aclexplode(n.nspacl) AS acl
  WHERE acl.grantee <> 0
    AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
    AND (acl.privilege_type <> 'USAGE'
         OR n.nspname NOT IN ('public', 'drizzle')
         OR acl.is_grantable);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: backup schema privileges must be exactly USAGE on '
      'public and drizzle: %', problem;
  END IF;
  IF has_schema_privilege('meal_agent_backup', 'meal_agent_private', 'USAGE') THEN
    RAISE EXCEPTION
      'backup grants: backup must not have USAGE on meal_agent_private';
  END IF;

  -- 3e. database：无 TEMP / CREATE。
  IF has_database_privilege('meal_agent_backup', current_database(), 'TEMP')
     OR has_database_privilege('meal_agent_backup', current_database(), 'CREATE')
  THEN
    RAISE EXCEPTION 'backup grants: backup must not hold TEMP or CREATE';
  END IF;

  -- 3f. pg_default_acl：只允许三条目标默认权限，且都必须是非 grantable SELECT。
  SELECT string_agg(format('%s/%s/%s:%s%s',
                           pg_catalog.pg_get_userbyid(d.defaclrole),
                           COALESCE(n.nspname, '<global>'),
                           d.defaclobjtype, acl.privilege_type,
                           CASE WHEN acl.is_grantable THEN ' (grantable)'
                                ELSE '' END), ', ')
    INTO problem
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace,
       aclexplode(d.defaclacl) AS acl
  WHERE acl.grantee <> 0
    AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
    AND NOT (
      pg_catalog.pg_get_userbyid(d.defaclrole) = 'meal_agent_migrator'
      AND acl.privilege_type = 'SELECT'
      AND NOT acl.is_grantable
      AND (
        (d.defaclobjtype = 'r' AND n.nspname IN ('public', 'drizzle'))
        OR (d.defaclobjtype = 'S' AND n.nspname = 'public')
      )
    );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: unexpected default privilege(s) for backup: %', problem;
  END IF;

  -- 3g. Large Object：backup 不得持有任何 LO 权限，也不得有 objtype='L' 的默认
  --     权限；PUBLIC 的 LO 授权会派生给 backup，因此一并断言为空。
  SELECT string_agg(entry, ', ' ORDER BY entry) INTO problem
  FROM (
    SELECT format('large object %s -> %s (%s)', m.oid,
                  CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
                  acl.privilege_type) AS entry
    FROM pg_largeobject_metadata m, aclexplode(m.lomacl) AS acl
    WHERE acl.grantee = 0
       OR pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'
    UNION ALL
    SELECT format('default large object privilege %s -> %s',
                  pg_catalog.pg_get_userbyid(d.defaclrole),
                  CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(acl.grantee) END)
    FROM pg_default_acl d, aclexplode(d.defaclacl) AS acl
    WHERE d.defaclobjtype = 'L'
      AND (acl.grantee = 0
           OR pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup')
  ) AS large_objects;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'backup grants: backup must hold no large object privilege: %', problem;
  END IF;
END
$verify_backup$;

COMMIT;
