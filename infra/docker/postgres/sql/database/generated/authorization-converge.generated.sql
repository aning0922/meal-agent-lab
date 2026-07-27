-- 阶段 09A / M2A：授权收敛（按真实 grantor 撤销一切不在 manifest 内的授权，再只重建允许项）。
--
-- GENERATED FILE — DO NOT EDIT.
-- 事实源： services/api/src/database/authorization-manifest.ts
-- 重新生成： pnpm --filter @meal-agent/api manifest:generate
-- 门禁： pnpm --filter @meal-agent/api manifest:check（内存渲染逐字节比对，不会自动改写本文件）
-- manifest version: 1
-- canonical manifest digest: sha256:ceb71dc24e49e7616a280461887a6121e23e0370034ec59038e71de70ad082e9
--
-- 本文件会修改 ACL：这是它的职责。它不改 ownership，也不建任何对象。
-- 调用方必须先设置 GUC meal_agent.acl_phase（containment 或 final）。

DO $meal_agent_authorization_converge$
DECLARE
  ledger_signature text;
  acl_phase text;
  state_key text;
  missing text;
  row_record record;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
  PERFORM pg_catalog.set_config('quote_all_identifiers', 'off', true);

  IF to_regclass('drizzle.__meal_agent_migrations') IS NULL THEN
    RAISE EXCEPTION
      'authorization manifest: the migration ledger is missing; the database '
      'is not in a state this baseline can reason about';
  END IF;
  SELECT COALESCE(
           pg_catalog.string_agg(name, ',' ORDER BY name COLLATE "C"), '')
    INTO ledger_signature
    FROM drizzle.__meal_agent_migrations;
  acl_phase := current_setting('meal_agent.acl_phase');
  IF acl_phase NOT IN ('containment', 'final') THEN
    RAISE EXCEPTION
      'authorization manifest: unknown phase %; expected containment or final',
      acl_phase;
  END IF;
  state_key := ledger_signature || '|' || acl_phase;
  IF NOT (state_key = ANY (ARRAY['0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', '0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', '0000_stage_06.sql|containment', '0000_stage_06.sql|final']::text[])) THEN
    RAISE EXCEPTION
      'authorization manifest: unregistered (ledger, phase) state %; register '
      'it in services/api/src/database/authorization-manifest.ts before '
      'running this baseline', state_key;
  END IF;

  -- 1. Large Object 入口。产品声明禁用 LO，因此 pg_catalog 的创建/读写入口不能
  --    保留 PUBLIC EXECUTE——否则 runtime 可以自己造出不受 schema ACL 与 RLS
  --    约束的存储面。同时清掉可能直接授予被监管角色的那一份。
  FOR row_record IN
    SELECT identity FROM unnest(ARRAY['pg_catalog.lo_close(integer)', 'pg_catalog.lo_creat(integer)', 'pg_catalog.lo_create(oid)', 'pg_catalog.lo_export(oid, text)', 'pg_catalog.lo_from_bytea(oid, bytea)', 'pg_catalog.lo_get(oid)', 'pg_catalog.lo_get(oid, bigint, integer)', 'pg_catalog.lo_import(text)', 'pg_catalog.lo_import(text, oid)', 'pg_catalog.lo_lseek(integer, integer, integer)', 'pg_catalog.lo_lseek64(integer, bigint, integer)', 'pg_catalog.lo_open(oid, integer)', 'pg_catalog.lo_put(oid, bigint, bytea)', 'pg_catalog.lo_tell(integer)', 'pg_catalog.lo_tell64(integer)', 'pg_catalog.lo_truncate(integer, integer)', 'pg_catalog.lo_truncate64(integer, bigint)', 'pg_catalog.lo_unlink(oid)', 'pg_catalog.loread(integer, integer)', 'pg_catalog.lowrite(integer, bytea)']::text[]) AS identity
  LOOP
    IF to_regprocedure(row_record.identity) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC CASCADE',
                     row_record.identity);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %s CASCADE',
                     row_record.identity,
                     (SELECT string_agg(quote_ident(g), ', ' ORDER BY g)
                        FROM unnest(ARRAY['PUBLIC', 'meal_agent_app', 'meal_agent_backup', 'meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_runtime_login']::text[]) AS g
                       WHERE g <> 'PUBLIC'));
    END IF;
  END LOOP;

  -- 1b. Large Object 上的对象权限。LO 不受 schema ACL 与 RLS 约束，产品也不使用
  --     它，因此指向被监管角色或 PUBLIC 的 lomacl 条目一律按真实 grantor 撤销。
  --     LO 的**归属**不在这里处理：项目角色拥有 LO 由调用方报告并失败，不删数据。
  FOR row_record IN
    SELECT m.oid AS loid,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident(pg_catalog.pg_get_userbyid(acl.grantee))
           END AS grantee_sql,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type AS privilege
      FROM pg_catalog.pg_largeobject_metadata m,
           aclexplode(m.lomacl) AS acl
     WHERE acl.grantee = 0
        OR pg_catalog.pg_get_userbyid(acl.grantee)
             = ANY (ARRAY['PUBLIC', 'meal_agent_app', 'meal_agent_backup', 'meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_runtime_login']::text[])
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', row_record.grantor);
    EXECUTE format('REVOKE %s ON LARGE OBJECT %s FROM %s CASCADE',
                   row_record.privilege, row_record.loid,
                   row_record.grantee_sql);
    RESET ROLE;
  END LOOP;

  -- 2. 撤销 current − allowed，按真实 grantor。列级授权一律不允许。
  FOR row_record IN
    WITH
    current_acl (objkey, target, colname, grantee, grantor, privilege,
                 grantable) AS (
      SELECT 'database:<current>'::text,
             ('DATABASE ' || quote_ident(current_database()))::text,
             NULL::text,
             (CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(acl.grantee) END)::text,
             pg_catalog.pg_get_userbyid(acl.grantor)::text,
             acl.privilege_type::text, acl.is_grantable
        FROM pg_catalog.pg_database d,
             -- datacl 为 NULL 时是**隐式**默认 ACL（PUBLIC 有 CONNECT/TEMPORARY），
             -- aclexplode(NULL) 会漏掉它，因此用 acldefault 展开。
             aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
       WHERE d.datname = current_database()
      UNION ALL
      SELECT 'schema:' || n.nspname,
             'SCHEMA ' || quote_ident(n.nspname), NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'relation:' || n.nspname || '.' || c.relname,
             CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END
               || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
             aclexplode(c.relacl) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'column:' || n.nspname || '.' || c.relname || '.' || a.attname,
             'TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
             a.attname::text,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
             aclexplode(a.attacl) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'routine:' || n.nspname || '.' || p.proname || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             'ROUTINE ' || quote_ident(n.nspname) || '.'
               || quote_ident(p.proname) || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
             aclexplode(COALESCE(p.proacl,
                                 acldefault('f', p.proowner))) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'type:' || n.nspname || '.' || t.typname,
             'TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname),
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace,
             aclexplode(COALESCE(t.typacl,
                                 acldefault('T', t.typowner))) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'language:' || l.lanname,
             'LANGUAGE ' || quote_ident(l.lanname), NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_language l, aclexplode(l.lanacl) AS acl
    ),
    allowed_grant (state, objkey, grantee, privilege) AS (
      VALUES
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment'::text, 'database:<current>'::text, 'meal_agent_backup_login'::text, 'CONNECT'::text),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profile_link_requests', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._household_invites', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._person_profile_link_requests', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profile_link_requests', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profile_link_requests', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._household_invites', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._person_profile_link_requests', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._users', 'PUBLIC', 'USAGE')
    ),
    allowed_default (state, scope_key, grantee, privilege) AS (
      VALUES
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment'::text, 'T@drizzle'::text, 'PUBLIC'::text, 'USAGE'::text),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'S@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'r@drizzle', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'r@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|containment', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'S@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'r@drizzle', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'r@public', 'meal_agent_backup', 'SELECT')
    )
    SELECT ca.target, ca.colname, ca.privilege, ca.grantable,
           ca.grantor,
           CASE WHEN ca.grantee = 'PUBLIC' THEN 'PUBLIC'
                ELSE quote_ident(ca.grantee) END AS grantee_sql,
           EXISTS (SELECT 1 FROM allowed_grant a
                    WHERE a.state = state_key AND a.objkey = ca.objkey
                      AND a.grantee = ca.grantee
                      AND a.privilege = ca.privilege) AS is_allowed
      FROM current_acl ca
     WHERE ca.grantee = ANY (ARRAY['PUBLIC', 'meal_agent_app', 'meal_agent_backup', 'meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_runtime_login']::text[])
  LOOP
    IF row_record.is_allowed AND NOT row_record.grantable
       AND row_record.colname IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', row_record.grantor);
    IF row_record.colname IS NOT NULL THEN
      EXECUTE format('REVOKE %s (%I) ON %s FROM %s CASCADE',
                     row_record.privilege, row_record.colname,
                     row_record.target, row_record.grantee_sql);
    ELSE
      EXECUTE format('REVOKE GRANT OPTION FOR %s ON %s FROM %s CASCADE',
                     row_record.privilege, row_record.target,
                     row_record.grantee_sql);
      IF NOT row_record.is_allowed THEN
        EXECUTE format('REVOKE %s ON %s FROM %s CASCADE',
                       row_record.privilege, row_record.target,
                       row_record.grantee_sql);
      END IF;
    END IF;
    RESET ROLE;
  END LOOP;

  -- 3. manifest 声明的对象必须真实存在，否则 GRANT 会静默漏掉。
  WITH
    managed_objects (objkey, target) AS (
      SELECT 'database:<current>'::text,
             ('DATABASE ' || quote_ident(current_database()))::text
      UNION ALL
      SELECT 'schema:' || n.nspname,
             'SCHEMA ' || quote_ident(n.nspname)
        FROM pg_catalog.pg_namespace n
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'relation:' || n.nspname || '.' || c.relname,
             CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END
               || quote_ident(n.nspname) || '.' || quote_ident(c.relname)
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
         AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      UNION ALL
      SELECT 'routine:' || n.nspname || '.' || p.proname || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             'ROUTINE ' || quote_ident(n.nspname) || '.'
               || quote_ident(p.proname) || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'type:' || n.nspname || '.' || t.typname,
             'TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname)
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'language:' || l.lanname, 'LANGUAGE ' || quote_ident(l.lanname)
        FROM pg_catalog.pg_language l
    ),
    allowed_grant (state, objkey, grantee, privilege) AS (
      VALUES
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment'::text, 'database:<current>'::text, 'meal_agent_backup_login'::text, 'CONNECT'::text),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profile_link_requests', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._household_invites', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._person_profile_link_requests', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profile_link_requests', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profile_link_requests', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._household_invites', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._person_profile_link_requests', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._users', 'PUBLIC', 'USAGE')
    ),
    allowed_default (state, scope_key, grantee, privilege) AS (
      VALUES
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment'::text, 'T@drizzle'::text, 'PUBLIC'::text, 'USAGE'::text),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'S@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'r@drizzle', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'r@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|containment', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'S@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'r@drizzle', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'r@public', 'meal_agent_backup', 'SELECT')
    )
  SELECT string_agg(DISTINCT a.objkey, ', ' ORDER BY a.objkey) INTO missing
    FROM allowed_grant a
   WHERE a.state = state_key
     AND NOT EXISTS (SELECT 1 FROM managed_objects mo
                      WHERE mo.objkey = a.objkey);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'authorization manifest: state % expects object(s) that do not exist: %',
      state_key, missing;
  END IF;

  -- 4. 授予 allowed − current。
  FOR row_record IN
    WITH
    managed_objects (objkey, target) AS (
      SELECT 'database:<current>'::text,
             ('DATABASE ' || quote_ident(current_database()))::text
      UNION ALL
      SELECT 'schema:' || n.nspname,
             'SCHEMA ' || quote_ident(n.nspname)
        FROM pg_catalog.pg_namespace n
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'relation:' || n.nspname || '.' || c.relname,
             CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END
               || quote_ident(n.nspname) || '.' || quote_ident(c.relname)
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
         AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      UNION ALL
      SELECT 'routine:' || n.nspname || '.' || p.proname || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             'ROUTINE ' || quote_ident(n.nspname) || '.'
               || quote_ident(p.proname) || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'type:' || n.nspname || '.' || t.typname,
             'TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname)
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'language:' || l.lanname, 'LANGUAGE ' || quote_ident(l.lanname)
        FROM pg_catalog.pg_language l
    ),
    current_acl (objkey, target, colname, grantee, grantor, privilege,
                 grantable) AS (
      SELECT 'database:<current>'::text,
             ('DATABASE ' || quote_ident(current_database()))::text,
             NULL::text,
             (CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(acl.grantee) END)::text,
             pg_catalog.pg_get_userbyid(acl.grantor)::text,
             acl.privilege_type::text, acl.is_grantable
        FROM pg_catalog.pg_database d,
             -- datacl 为 NULL 时是**隐式**默认 ACL（PUBLIC 有 CONNECT/TEMPORARY），
             -- aclexplode(NULL) 会漏掉它，因此用 acldefault 展开。
             aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
       WHERE d.datname = current_database()
      UNION ALL
      SELECT 'schema:' || n.nspname,
             'SCHEMA ' || quote_ident(n.nspname), NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'relation:' || n.nspname || '.' || c.relname,
             CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END
               || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
             aclexplode(c.relacl) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'column:' || n.nspname || '.' || c.relname || '.' || a.attname,
             'TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
             a.attname::text,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
             aclexplode(a.attacl) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'routine:' || n.nspname || '.' || p.proname || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             'ROUTINE ' || quote_ident(n.nspname) || '.'
               || quote_ident(p.proname) || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
             aclexplode(COALESCE(p.proacl,
                                 acldefault('f', p.proowner))) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'type:' || n.nspname || '.' || t.typname,
             'TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname),
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace,
             aclexplode(COALESCE(t.typacl,
                                 acldefault('T', t.typowner))) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'language:' || l.lanname,
             'LANGUAGE ' || quote_ident(l.lanname), NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_language l, aclexplode(l.lanacl) AS acl
    ),
    allowed_grant (state, objkey, grantee, privilege) AS (
      VALUES
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment'::text, 'database:<current>'::text, 'meal_agent_backup_login'::text, 'CONNECT'::text),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profile_link_requests', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._household_invites', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._person_profile_link_requests', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profile_link_requests', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profile_link_requests', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._household_invites', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._person_profile_link_requests', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._users', 'PUBLIC', 'USAGE')
    ),
    allowed_default (state, scope_key, grantee, privilege) AS (
      VALUES
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment'::text, 'T@drizzle'::text, 'PUBLIC'::text, 'USAGE'::text),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'S@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'r@drizzle', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'r@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|containment', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'S@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'r@drizzle', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'r@public', 'meal_agent_backup', 'SELECT')
    )
    SELECT mo.target,
           CASE WHEN a.grantee = 'PUBLIC' THEN 'PUBLIC'
                ELSE quote_ident(a.grantee) END AS grantee_sql,
           a.privilege
      FROM allowed_grant a
      JOIN managed_objects mo ON mo.objkey = a.objkey
     WHERE a.state = state_key
       AND NOT EXISTS (SELECT 1 FROM current_acl ca
                        WHERE ca.objkey = a.objkey
                          AND ca.grantee = a.grantee
                          AND ca.privilege = a.privilege
                          AND ca.colname IS NULL)
  LOOP
    EXECUTE format('GRANT %s ON %s TO %s', row_record.privilege,
                   row_record.target, row_record.grantee_sql);
  END LOOP;

  -- 5. default privileges：逐槽位比较有效默认权限并收敛。
  FOR row_record IN
    WITH
    default_slots (objtype, scope) AS (
      VALUES
        ('L'::text, 'global'::text),
        ('S', 'drizzle'),
        ('S', 'global'),
        ('S', 'meal_agent_private'),
        ('S', 'public'),
        ('T', 'drizzle'),
        ('T', 'global'),
        ('T', 'meal_agent_private'),
        ('T', 'public'),
        ('f', 'drizzle'),
        ('f', 'global'),
        ('f', 'meal_agent_private'),
        ('f', 'public'),
        ('n', 'global'),
        ('r', 'drizzle'),
        ('r', 'global'),
        ('r', 'meal_agent_private'),
        ('r', 'public')
    ),
    current_default (scope_key, grantee, privilege) AS (
      SELECT s.objtype || '@' || s.scope,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             acl.privilege_type::text
        FROM default_slots s,
             LATERAL (
               SELECT COALESCE(
                 (SELECT d.defaclacl
                    FROM pg_catalog.pg_default_acl d
                    JOIN pg_catalog.pg_namespace dn ON dn.oid = d.defaclnamespace
                   WHERE pg_catalog.pg_get_userbyid(d.defaclrole)
                           = 'meal_agent_migrator'
                     AND d.defaclobjtype = s.objtype::"char"
                     AND dn.nspname = s.scope),
                 (SELECT d.defaclacl
                    FROM pg_catalog.pg_default_acl d
                   WHERE pg_catalog.pg_get_userbyid(d.defaclrole)
                           = 'meal_agent_migrator'
                     AND d.defaclobjtype = s.objtype::"char"
                     AND d.defaclnamespace = 0),
                 acldefault(s.objtype::"char",
                            (SELECT oid FROM pg_catalog.pg_roles
                              WHERE rolname = 'meal_agent_migrator'))
               ) AS effective_acl
             ) AS resolved,
             aclexplode(resolved.effective_acl) AS acl
       WHERE (CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(acl.grantee) END)
             = ANY (ARRAY['PUBLIC', 'meal_agent_app', 'meal_agent_backup', 'meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_runtime_login']::text[])
    ),
    allowed_grant (state, objkey, grantee, privilege) AS (
      VALUES
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment'::text, 'database:<current>'::text, 'meal_agent_backup_login'::text, 'CONNECT'::text),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.household_invites', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profile_link_requests', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._household_invites', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._person_profile_link_requests', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.auth_identities', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.household_invites', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.households', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.idempotency_records', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_events', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.inventory_lots', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.memberships', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profile_link_requests', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profile_link_requests', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.person_profiles', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.sessions', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'relation:public.users', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._household_invites', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._person_profile_link_requests', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql|containment', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|containment', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|containment', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|containment', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'type:public._users', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_backup_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_migration_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'database:<current>', 'meal_agent_runtime_login', 'CONNECT'),
        ('0000_stage_06.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:drizzle.__meal_agent_migrations', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.auth_identities', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.households', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.idempotency_records', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_events', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.inventory_lots', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.memberships', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.person_profiles', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.sessions', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'INSERT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'SELECT'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_app', 'UPDATE'),
        ('0000_stage_06.sql|final', 'relation:public.users', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.app_household_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.app_user_id()', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)', 'meal_agent_app', 'EXECUTE'),
        ('0000_stage_06.sql|final', 'schema:drizzle', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:drizzle', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:meal_agent_private', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:public', 'meal_agent_app', 'USAGE'),
        ('0000_stage_06.sql|final', 'schema:public', 'meal_agent_backup', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:drizzle.___meal_agent_migrations', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._auth_identities', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._households', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._idempotency_records', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._inventory_events', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._inventory_lots', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._memberships', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._person_profiles', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._sessions', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'type:public._users', 'PUBLIC', 'USAGE')
    ),
    allowed_default (state, scope_key, grantee, privilege) AS (
      VALUES
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment'::text, 'T@drizzle'::text, 'PUBLIC'::text, 'USAGE'::text),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'S@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'r@drizzle', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'r@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|containment', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|containment', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'S@public', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'T@drizzle', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@global', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@meal_agent_private', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'T@public', 'PUBLIC', 'USAGE'),
        ('0000_stage_06.sql|final', 'r@drizzle', 'meal_agent_backup', 'SELECT'),
        ('0000_stage_06.sql|final', 'r@public', 'meal_agent_backup', 'SELECT')
    )
    SELECT scope_key, grantee, privilege, action FROM (
      SELECT cd.scope_key, cd.grantee, cd.privilege, 'REVOKE'::text AS action
        FROM current_default cd
       WHERE NOT EXISTS (SELECT 1 FROM allowed_default ad
                          WHERE ad.state = state_key
                            AND ad.scope_key = cd.scope_key
                            AND ad.grantee = cd.grantee
                            AND ad.privilege = cd.privilege)
      UNION ALL
      SELECT ad.scope_key, ad.grantee, ad.privilege, 'GRANT'
        FROM allowed_default ad
       WHERE ad.state = state_key
         AND NOT EXISTS (SELECT 1 FROM current_default cd
                          WHERE cd.scope_key = ad.scope_key
                            AND cd.grantee = ad.grantee
                            AND cd.privilege = ad.privilege)
    ) AS diff
     ORDER BY action DESC, scope_key, grantee, privilege
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator%s %s %s ON %s %s %s',
      CASE WHEN split_part(row_record.scope_key, '@', 2) = 'global' THEN ''
           ELSE ' IN SCHEMA '
                || quote_ident(split_part(row_record.scope_key, '@', 2)) END,
      row_record.action, row_record.privilege,
      CASE split_part(row_record.scope_key, '@', 1)
             WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES'
             WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES'
             WHEN 'n' THEN 'SCHEMAS' WHEN 'L' THEN 'LARGE OBJECTS' END,
      CASE WHEN row_record.action = 'REVOKE' THEN 'FROM' ELSE 'TO' END,
      CASE WHEN row_record.grantee = 'PUBLIC' THEN 'PUBLIC'
           ELSE quote_ident(row_record.grantee) END);
  END LOOP;
END
$meal_agent_authorization_converge$;
