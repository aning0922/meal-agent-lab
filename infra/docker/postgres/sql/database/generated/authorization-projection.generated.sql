-- 阶段 09A / M2A：授权 catalog 的**只读**投影。
--
-- GENERATED FILE — DO NOT EDIT.
-- 事实源： services/api/src/database/authorization-projection-sql.ts
-- 重新生成： pnpm --filter @meal-agent/api manifest:generate
-- 门禁： pnpm --filter @meal-agent/api manifest:check
--
-- 本文件只 SELECT：不含 GRANT / REVOKE / ALTER / SET ROLE 或任何其他权限
-- mutation。它是后续 verify / converge 共用的 canonical projector，本轮只
-- 用于观察与反向测试，尚未接入 02/03 的任何阶段。

WITH RECURSIVE
  managed_schema (nspname, oid) AS (
    SELECT n.nspname::text, n.oid
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
  ),
  -- 探测角色：项目 NOLOGIN 角色 + 目标库里所有非 superuser LOGIN + PUBLIC。
  -- 静态名单会漏掉外部创建的 login，因此这里动态枚举。
  probe_role (role_name, probe_name, role_class) AS (
    SELECT 'PUBLIC'::text, 'public'::text, 'pseudo'::text
    UNION ALL
    SELECT r.rolname::text, r.rolname::text,
           CASE WHEN r.rolcanlogin THEN 'login' ELSE 'nologin' END
      FROM pg_catalog.pg_roles r
     WHERE NOT r.rolsuper
       AND (r.rolcanlogin OR r.rolname LIKE 'meal!_agent%' ESCAPE '!')
  ),
  acl_source (objkey, grantee, grantor, privilege, grantable) AS (
    SELECT 'database:' || d.datname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_database d,
           aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
     WHERE d.datname = current_database()
    UNION ALL
    SELECT 'schema:' || n.nspname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_namespace n,
           aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
     WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
    UNION ALL
    SELECT 'relation:' || n.nspname || '.' || c.relname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_class c
      JOIN managed_schema n ON n.oid = c.relnamespace,
           aclexplode(COALESCE(c.relacl,
                               acldefault(CASE WHEN c.relkind = 'S'
                                               THEN 's' ELSE 'r' END::"char",
                                          c.relowner))) AS acl
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT 'column:' || n.nspname || '.' || c.relname || '.' || a.attname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN managed_schema n ON n.oid = c.relnamespace,
           aclexplode(a.attacl) AS acl
     WHERE a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'routine:' || n.nspname || '.' || p.proname || '('
             || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace,
           aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    UNION ALL
    -- 20 个 pg_catalog Large Object 入口点：产品声明禁用 LO，它们的直接 ACL
    -- 同样属于必须可见的范围。
    SELECT 'routine:' || lo.identity,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM unnest(ARRAY['pg_catalog.lo_close(integer)', 'pg_catalog.lo_creat(integer)', 'pg_catalog.lo_create(oid)', 'pg_catalog.lo_export(oid, text)', 'pg_catalog.lo_from_bytea(oid, bytea)', 'pg_catalog.lo_get(oid)', 'pg_catalog.lo_get(oid, bigint, integer)', 'pg_catalog.lo_import(text)', 'pg_catalog.lo_import(text, oid)', 'pg_catalog.lo_lseek(integer, integer, integer)', 'pg_catalog.lo_lseek64(integer, bigint, integer)', 'pg_catalog.lo_open(oid, integer)', 'pg_catalog.lo_put(oid, bigint, bytea)', 'pg_catalog.lo_tell(integer)', 'pg_catalog.lo_tell64(integer)', 'pg_catalog.lo_truncate(integer, integer)', 'pg_catalog.lo_truncate64(integer, bigint)', 'pg_catalog.lo_unlink(oid)', 'pg_catalog.loread(integer, integer)', 'pg_catalog.lowrite(integer, bytea)']::text[]) AS lo(identity)
      JOIN pg_catalog.pg_proc lp ON lp.oid = to_regprocedure(lo.identity),
           aclexplode(COALESCE(lp.proacl, acldefault('f', lp.proowner))) AS acl
    UNION ALL
    SELECT 'type:' || n.nspname || '.' || t.typname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace,
           aclexplode(COALESCE(t.typacl, acldefault('T', t.typowner))) AS acl
     WHERE NOT (t.typcategory = 'A' AND t.typelem <> 0)
    UNION ALL
    SELECT 'language:' || l.lanname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_language l, aclexplode(l.lanacl) AS acl
    UNION ALL
    SELECT 'largeobject:' || m.oid::text,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_largeobject_metadata m,
           aclexplode(m.lomacl) AS acl
  ),
  default_raw (scope_kind, defaclrole, objtype, scope, grantee, grantor,
               privilege, grantable) AS (
    SELECT CASE WHEN d.defaclnamespace = 0 THEN 'global' ELSE 'schema' END,
           pg_catalog.pg_get_userbyid(d.defaclrole)::text,
           d.defaclobjtype::text,
           COALESCE(dn.nspname::text, '-'),
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_default_acl d
      LEFT JOIN pg_catalog.pg_namespace dn ON dn.oid = d.defaclnamespace,
           aclexplode(d.defaclacl) AS acl
  ),
  -- 未来对象的**有效**默认权限 = 内建默认 ∪ 全局行 ∪ schema 行。
  -- PostgreSQL 18.4 实测：global 与 schema 是按权限求并集叠加的，不是覆盖，
  -- 也不是三选一——因此这里做真正的并集，而不是 COALESCE。
  default_effective (defaclrole, objtype, scope, grantee, grantor, privilege,
                     grantable) AS (
    SELECT owner_role.rolname::text, slot.objtype, slot.scope,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM (SELECT unnest(ARRAY['r', 'S', 'f', 'T']) AS objtype) slot_type,
           LATERAL (SELECT slot_type.objtype AS objtype, ms.nspname AS scope
                      FROM managed_schema ms) slot,
           pg_catalog.pg_roles owner_role,
           aclexplode(acldefault(slot.objtype::"char", owner_role.oid)) AS acl
     WHERE owner_role.rolname = 'meal_agent_migrator'
    UNION
    SELECT raw.defaclrole, raw.objtype, ms.nspname, raw.grantee, raw.grantor,
           raw.privilege, raw.grantable
      FROM default_raw raw, managed_schema ms
     WHERE raw.scope_kind = 'global'
       AND raw.objtype IN ('r', 'S', 'f', 'T')
    UNION
    SELECT raw.defaclrole, raw.objtype, raw.scope, raw.grantee, raw.grantor,
           raw.privilege, raw.grantable
      FROM default_raw raw
     WHERE raw.scope_kind = 'schema'
       AND raw.objtype IN ('r', 'S', 'f', 'T')
  ),
  owner_source (objkey, owner_name) AS (
    SELECT 'database:' || d.datname,
           pg_catalog.pg_get_userbyid(d.datdba)::text
      FROM pg_catalog.pg_database d WHERE d.datname = current_database()
    UNION ALL
    SELECT 'schema:' || ms.nspname,
           pg_catalog.pg_get_userbyid(n.nspowner)::text
      FROM managed_schema ms
      JOIN pg_catalog.pg_namespace n ON n.oid = ms.oid
    UNION ALL
    SELECT 'relation:' || n.nspname || '.' || c.relname,
           pg_catalog.pg_get_userbyid(c.relowner)::text
      FROM pg_catalog.pg_class c
      JOIN managed_schema n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT 'routine:' || n.nspname || '.' || p.proname || '('
             || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
           pg_catalog.pg_get_userbyid(p.proowner)::text
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace
    UNION ALL
    SELECT 'type:' || n.nspname || '.' || t.typname,
           pg_catalog.pg_get_userbyid(t.typowner)::text
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace
    UNION ALL
    SELECT 'largeobject:' || m.oid::text,
           pg_catalog.pg_get_userbyid(m.lomowner)::text
      FROM pg_catalog.pg_largeobject_metadata m
  ),
  effective_source (objkey, role_name, privileges) AS (
    SELECT 'database:' || current_database(), pr.role_name,
           (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p
             WHERE has_database_privilege(pr.probe_name, current_database(), p))
      FROM probe_role pr
    UNION ALL
    SELECT 'schema:' || n.nspname, pr.role_name,
           (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['CREATE', 'USAGE']) AS p
             WHERE has_schema_privilege(pr.probe_name, n.oid, p))
      FROM managed_schema n, probe_role pr
    UNION ALL
    SELECT 'relation:' || n.nspname || '.' || c.relname, pr.role_name,
           CASE WHEN c.relkind = 'S' THEN
             (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
                FROM unnest(ARRAY['SELECT', 'UPDATE', 'USAGE']) AS p
               WHERE has_sequence_privilege(pr.probe_name, c.oid, p))
           ELSE
             (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
                FROM unnest(ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES',
                                  'SELECT', 'TRIGGER', 'TRUNCATE',
                                  'UPDATE']) AS p
               WHERE has_table_privilege(pr.probe_name, c.oid, p))
           END
      FROM pg_catalog.pg_class c
      JOIN managed_schema n ON n.oid = c.relnamespace, probe_role pr
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT 'routine:' || n.nspname || '.' || p.proname || '('
             || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
           pr.role_name,
           CASE WHEN has_function_privilege(pr.probe_name, p.oid, 'EXECUTE')
                THEN 'EXECUTE' ELSE NULL END
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace, probe_role pr
    UNION ALL
    SELECT 'routine:' || lo.identity, pr.role_name,
           CASE WHEN has_function_privilege(pr.probe_name,
                                            lo.identity::regprocedure,
                                            'EXECUTE')
                THEN 'EXECUTE' ELSE NULL END
      FROM unnest(ARRAY['pg_catalog.lo_close(integer)', 'pg_catalog.lo_creat(integer)', 'pg_catalog.lo_create(oid)', 'pg_catalog.lo_export(oid, text)', 'pg_catalog.lo_from_bytea(oid, bytea)', 'pg_catalog.lo_get(oid)', 'pg_catalog.lo_get(oid, bigint, integer)', 'pg_catalog.lo_import(text)', 'pg_catalog.lo_import(text, oid)', 'pg_catalog.lo_lseek(integer, integer, integer)', 'pg_catalog.lo_lseek64(integer, bigint, integer)', 'pg_catalog.lo_open(oid, integer)', 'pg_catalog.lo_put(oid, bigint, bytea)', 'pg_catalog.lo_tell(integer)', 'pg_catalog.lo_tell64(integer)', 'pg_catalog.lo_truncate(integer, integer)', 'pg_catalog.lo_truncate64(integer, bigint)', 'pg_catalog.lo_unlink(oid)', 'pg_catalog.loread(integer, integer)', 'pg_catalog.lowrite(integer, bytea)']::text[]) AS lo(identity), probe_role pr
     WHERE to_regprocedure(lo.identity) IS NOT NULL
    UNION ALL
    SELECT 'type:' || n.nspname || '.' || t.typname, pr.role_name,
           CASE WHEN has_type_privilege(pr.probe_name, t.oid, 'USAGE')
                THEN 'USAGE' ELSE NULL END
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace, probe_role pr
  )
  SELECT kind, identity, detail
    FROM (
      SELECT 'acl'::text AS kind,
             (objkey || '#' || grantee || '#' || grantor || '#'
               || privilege)::text AS identity,
             ('grantable=' || CASE WHEN grantable THEN 't' ELSE 'f' END)::text AS detail
        FROM acl_source
      UNION ALL
      SELECT 'default-' || scope_kind,
             defaclrole || '#' || objtype || '@' || scope || '#' || grantee
               || '#' || grantor || '#' || privilege,
             'grantable=' || CASE WHEN grantable THEN 't' ELSE 'f' END
        FROM default_raw
      UNION ALL
      SELECT 'default-effective',
             defaclrole || '#' || objtype || '@' || scope || '#' || grantee
               || '#' || grantor || '#' || privilege,
             'grantable=' || CASE WHEN grantable THEN 't' ELSE 'f' END
        FROM default_effective
      UNION ALL
      SELECT 'effective', objkey || '#' || role_name, 'privs=' || privileges
        FROM effective_source
       WHERE privileges IS NOT NULL
      UNION ALL
      SELECT 'owner', objkey, 'owner=' || owner_name
        FROM owner_source
      UNION ALL
      SELECT 'large-object', 'largeobject:' || m.oid::text,
             'owner=' || pg_catalog.pg_get_userbyid(m.lomowner)
        FROM pg_catalog.pg_largeobject_metadata m
      UNION ALL
      -- 数组类型无法单独授权（PostgreSQL 直接报 "cannot set privileges of array
      -- types"），其权限检查委托到元素类型；投影如实标注，避免把 implicit 的
      -- 数组行当成可独立收敛的目标。
      SELECT 'type-class', 'type:' || n.nspname || '.' || t.typname,
             CASE
               WHEN t.typcategory = 'A' AND t.typelem <> 0
                 THEN 'class=array delegates-to='
                        || pg_catalog.format_type(t.typelem, NULL)
               WHEN t.typtype = 'c' AND EXISTS (
                      SELECT 1 FROM pg_catalog.pg_class rc
                       WHERE rc.oid = t.typrelid AND rc.relkind <> 'c')
                 THEN 'class=row grantable-directly=t'
               ELSE 'class=element grantable-directly=t'
             END
        FROM pg_catalog.pg_type t
        JOIN managed_schema n ON n.oid = t.typnamespace
      UNION ALL
      SELECT 'role', role_name, 'class=' || role_class FROM probe_role
    ) AS projection
   ORDER BY kind COLLATE "C", identity COLLATE "C", detail COLLATE "C";
