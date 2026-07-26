-- 阶段 09A / M2A：cluster scope 角色基线。
--
-- 独立、幂等，连接明确的 maintenance/control 数据库（默认 postgres）执行。
-- **不要求目标 meal_agent 数据库存在**，也不修改任何目标数据库的 ACL——
-- 数据库级与对象级权限属于 database scope（sql/database/）。
--
-- 因此本阶段可以在 createdb 之前运行，M4 的恢复流程将复用它预建 dump 引用的
-- 角色，然后 createdb --owner=meal_agent_migrator 再 pg_restore。
-- 本文件不执行任何恢复动作，也不创建业务对象。
--
-- 每次运行都把六个项目角色**完整规范化**到基线：属性、role-level GUC 配置、
-- membership 图和目标数据库级权限。因此重复执行只会收敛权限，不会叠加权限。
--
-- 0000 中的 `CREATE ROLE ... IF NOT EXISTS` 与 `ALTER ROLE ... BYPASSRLS` 在本
-- 阶段先跑过之后会成为幂等 no-op，两者结论一致。

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 创建缺失角色（属性在下一步统一规范化，这里不依赖创建时的属性）
-- ---------------------------------------------------------------------------
DO $create$
DECLARE
  project_role text;
BEGIN
  FOREACH project_role IN ARRAY ARRAY[
    'meal_agent_migrator',
    'meal_agent_app',
    'meal_agent_backup',
    'meal_agent_migration_login',
    'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = project_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', project_role);
    END IF;
  END LOOP;
END
$create$;

-- ---------------------------------------------------------------------------
-- 2. NOLOGIN 业务角色：权限只挂在这三个角色上，它们自己永远不能登录。
--    BYPASSRLS 按角色职责精确设置，不是一律给或一律不给。
-- ---------------------------------------------------------------------------
ALTER ROLE meal_agent_migrator
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
ALTER ROLE meal_agent_app
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE meal_agent_backup
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;

-- ---------------------------------------------------------------------------
-- 3. 登录角色：自身零业务权限，必须显式 SET ROLE 才能取得对应角色的权限。
--    connection limit 与 valid until 都显式声明，不依赖默认值。
--    口令不在这里设置：`bootstrap.sh logins` 用客户端生成的 SCRAM verifier 设置，
--    原始口令不进入 SQL 文本。
-- ---------------------------------------------------------------------------
ALTER ROLE meal_agent_migration_login
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 4 VALID UNTIL 'infinity';
ALTER ROLE meal_agent_runtime_login
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 40 VALID UNTIL 'infinity';
ALTER ROLE meal_agent_backup_login
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 8 VALID UNTIL 'infinity';

-- ---------------------------------------------------------------------------
-- 4. 清空全部 role-level GUC 配置。
--    注意：`ALTER ROLE x RESET ALL` 只清全局（setdatabase = 0）设置，不会清
--    `ALTER ROLE x IN DATABASE d SET ...` 留下的每库设置，因此必须按 catalog
--    枚举逐条清理，否则会残留一条能改变会话行为的配置。
-- ---------------------------------------------------------------------------
DO $reset_config$
DECLARE
  leftover record;
BEGIN
  FOR leftover IN
    SELECT r.rolname AS role_name, d.datname AS database_name
    FROM pg_db_role_setting s
    JOIN pg_roles r ON r.oid = s.setrole
    LEFT JOIN pg_database d ON d.oid = s.setdatabase
    WHERE r.rolname IN (
      'meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup',
      'meal_agent_migration_login', 'meal_agent_runtime_login',
      'meal_agent_backup_login'
    )
  LOOP
    IF leftover.database_name IS NULL THEN
      EXECUTE format('ALTER ROLE %I RESET ALL', leftover.role_name);
    ELSE
      EXECUTE format(
        'ALTER ROLE %I IN DATABASE %I RESET ALL',
        leftover.role_name, leftover.database_name
      );
    END IF;
  END LOOP;
END
$reset_config$;

-- ---------------------------------------------------------------------------
-- 5. membership 收敛为精确图。
--
--    先撤销一切涉及六个项目角色的 membership（两个方向：别的角色进入项目角色、
--    项目角色进入别的角色），再重新授予三条目标边。
--
--    关键：pg_auth_members 的键是 (roleid, member, grantor)，同一条边可以由不同
--    grantor 授予多行；不带 GRANTED BY 的 REVOKE 只会删掉「由执行者授予」的那
--    一行，别的 grantor 授予的行会残留。因此这里按 catalog 逐行撤销并显式指定
--    GRANTED BY，包括目标边本身——随后统一重新授予，保证最终恰好三行、grantor
--    与选项都确定。
-- ---------------------------------------------------------------------------
DO $memberships$
DECLARE
  project_roles constant text[] := ARRAY[
    'meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup',
    'meal_agent_migration_login', 'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ];
  edge record;
BEGIN
  FOR edge IN
    SELECT member_role.rolname AS member_name,
           granted_role.rolname AS granted_name,
           grantor_role.rolname AS grantor_name
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles grantor_role ON grantor_role.oid = membership.grantor
    WHERE member_role.rolname = ANY(project_roles)
       OR granted_role.rolname = ANY(project_roles)
  LOOP
    RAISE NOTICE
      'role baseline: clearing membership % -> % (granted by %)',
      edge.member_name, edge.granted_name, edge.grantor_name;
    EXECUTE format(
      'REVOKE %I FROM %I GRANTED BY %I',
      edge.granted_name, edge.member_name, edge.grantor_name
    );
  END LOOP;
END
$memberships$;

-- 三条目标边由当前 bootstrap admin 统一授予，三个选项全部显式声明：
-- 部分选项列表只会更新被点名的选项，未点名的会保留旧值，因此必须写全。
GRANT meal_agent_migrator TO meal_agent_migration_login
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT meal_agent_app TO meal_agent_runtime_login
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT meal_agent_backup TO meal_agent_backup_login
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

-- ---------------------------------------------------------------------------
-- 6. 结果自检：基线不成立就 fail closed，而不是留下半套权限。
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  -- 精确六角色数组：不使用未转义的 LIKE 'meal_agent%'（`_` 是通配符）。
  project_roles constant text[] := ARRAY[
    'meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup',
    'meal_agent_migration_login', 'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ];
  problem text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO problem
  FROM pg_roles
  WHERE rolname IN (
      'meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup',
      'meal_agent_migration_login', 'meal_agent_runtime_login',
      'meal_agent_backup_login'
    )
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'role baseline: cluster attributes not normalized on %',
      problem;
  END IF;

  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO problem
  FROM pg_roles
  WHERE rolname IN (
      'meal_agent_migration_login', 'meal_agent_runtime_login',
      'meal_agent_backup_login'
    )
    AND (NOT rolcanlogin OR rolinherit OR rolbypassrls OR rolconnlimit < 0);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'role baseline: login attributes not normalized on %',
      problem;
  END IF;

  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO problem
  FROM pg_roles
  WHERE rolname IN ('meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup')
    AND rolcanlogin;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'role baseline: business roles must stay NOLOGIN: %',
      problem;
  END IF;

  IF (SELECT count(*) FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole
      WHERE r.rolname = ANY(project_roles)) <> 0 THEN
    RAISE EXCEPTION 'role baseline: leftover role-level configuration remains';
  END IF;

  -- membership 必须恰好是三条目标边，且全部 admin=false / inherit=false / set=true。
  SELECT string_agg(
           format('%s -> %s (admin=%s inherit=%s set=%s)',
                  member_role.rolname, granted_role.rolname,
                  membership.admin_option, membership.inherit_option,
                  membership.set_option),
           ', ')
    INTO problem
  FROM pg_auth_members membership
  JOIN pg_roles member_role ON member_role.oid = membership.member
  JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
  WHERE (member_role.rolname = ANY(project_roles)
         OR granted_role.rolname = ANY(project_roles))
    AND NOT (
      member_role.rolname || '|' || granted_role.rolname = ANY(ARRAY[
        'meal_agent_migration_login|meal_agent_migrator',
        'meal_agent_runtime_login|meal_agent_app',
        'meal_agent_backup_login|meal_agent_backup'
      ])
      AND membership.admin_option IS FALSE
      AND membership.inherit_option IS FALSE
      AND membership.set_option IS TRUE
    );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'role baseline: unexpected membership edge(s): %', problem;
  END IF;

  IF (SELECT count(*) FROM pg_auth_members membership
      JOIN pg_roles member_role ON member_role.oid = membership.member
      JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = ANY(project_roles)
         OR granted_role.rolname = ANY(project_roles)) <> 3 THEN
    RAISE EXCEPTION
      'role baseline: expected exactly three project membership edges';
  END IF;

END
$verify$;

COMMIT;
