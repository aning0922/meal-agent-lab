-- 阶段 09A / M2A：授权 catalog 的**只读**投影（R8A 最终修订）。
--
-- GENERATED FILE — DO NOT EDIT.
-- 事实源： services/api/src/database/authorization-projection-sql.ts
-- 重新生成： pnpm --filter @meal-agent/api manifest:generate
-- 门禁： pnpm --filter @meal-agent/api manifest:check
--
-- 本文件是**单条只读 SELECT**：不含 GRANT / REVOKE / ALTER / SET ROLE /
-- SET / set_config 或任何其他 mutation，因此它既不改数据也不改调用方会话。
-- 它是后续 verify / converge 共用的 canonical projector，本轮只用于观察与
-- 反向测试，尚未接入 02/03 的任何阶段。
--
-- 每个 kind 只声称自己实际证明的事：
--   acl               规范化的直接授权语义（NULL ACL 展开为隐式内建默认），
--                     **不是**物理 catalog 里存在的 ACL 行；
--   default-row       pg_default_acl 的**物理行**存在性（含 empty 标志）；
--   default-global /  物理行展开后的条目；
--   default-schema
--   default-effective 按 PostgreSQL 真实语义叠加出的有效默认权限；
--   default-unmapped  未知 defaclobjtype 的 fail-closed 标记（健康库恒为空）；
--   effective         has_*_privilege 的探测结果（含 PUBLIC 派生与角色继承）；
--   owner /           归属；
--   large-object
--   type-class        类型分类与数组类型的委托关系；
--   role              参与 effective 探测的角色集合——**覆盖面证据**，
--                     不是允许角色白名单。

WITH
  managed_schema (nspname, oid, nspowner, nspacl) AS (
    SELECT n.nspname::text, n.oid, n.nspowner, n.nspacl
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
  ),
  -- 探测角色：PUBLIC + 项目 NOLOGIN 角色 + 目标库里所有非 superuser LOGIN。
  -- 静态名单永远追不上「谁可能出现在 ACL 里」，因此动态枚举。
  probe_role (role_name, probe_name, role_class) AS (
    SELECT 'PUBLIC'::text, 'public'::text, 'pseudo'::text
    UNION ALL
    SELECT r.rolname::text, r.rolname::text,
           CASE WHEN r.rolcanlogin THEN 'login' ELSE 'nologin' END
      FROM pg_catalog.pg_roles r
     WHERE NOT r.rolsuper
       AND (r.rolcanlogin OR r.rolname LIKE 'meal!_agent%' ESCAPE '!')
  ),
  denied_routine (identity, oid) AS (
    SELECT lo.identity, to_regprocedure(lo.identity)
      FROM unnest(ARRAY['pg_catalog.lo_close(integer)', 'pg_catalog.lo_creat(integer)', 'pg_catalog.lo_create(oid)', 'pg_catalog.lo_export(oid, text)', 'pg_catalog.lo_from_bytea(oid, bytea)', 'pg_catalog.lo_get(oid)', 'pg_catalog.lo_get(oid, bigint, integer)', 'pg_catalog.lo_import(text)', 'pg_catalog.lo_import(text, oid)', 'pg_catalog.lo_lseek(integer, integer, integer)', 'pg_catalog.lo_lseek64(integer, bigint, integer)', 'pg_catalog.lo_open(oid, integer)', 'pg_catalog.lo_put(oid, bigint, bytea)', 'pg_catalog.lo_tell(integer)', 'pg_catalog.lo_tell64(integer)', 'pg_catalog.lo_truncate(integer, integer)', 'pg_catalog.lo_truncate64(integer, bigint)', 'pg_catalog.lo_unlink(oid)', 'pg_catalog.loread(integer, integer)', 'pg_catalog.lowrite(integer, bytea)']::text[]) AS lo(identity)
     WHERE to_regprocedure(lo.identity) IS NOT NULL
  ),
  acl_source (objkey, grantee, grantor, privilege, grantable) AS (
    SELECT jsonb_build_array('database', '<current>'),
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_database d,
           aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
     WHERE d.datname = current_database()
    UNION ALL
    SELECT jsonb_build_array('schema', n.nspname),
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM managed_schema n,
           aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
    UNION ALL
    SELECT jsonb_build_array('relation', n.nspname, c.relname),
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
    SELECT jsonb_build_array('column', n.nspname, c.relname, a.attname),
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN managed_schema n ON n.oid = c.relnamespace,
           aclexplode(a.attacl) AS acl
     WHERE a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT jsonb_build_array('routine', n.nspname, p.proname,
                     COALESCE((SELECT jsonb_agg(jsonb_build_array(atn.nspname, at.typname)
                                ORDER BY argument.ordinality)
               FROM unnest(p.proargtypes) WITH ORDINALITY
                      AS argument(type_oid, ordinality)
               JOIN pg_catalog.pg_type at ON at.oid = argument.type_oid
               JOIN pg_catalog.pg_namespace atn ON atn.oid = at.typnamespace),
            '[]'::jsonb)),
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace,
           aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    UNION ALL
    -- 20 个 pg_catalog Large Object 入口点：产品声明禁用 LO，它们的直接 ACL
    -- 同样必须可见。
    SELECT jsonb_build_array('routine', lpn.nspname, lp.proname,
                     COALESCE((SELECT jsonb_agg(jsonb_build_array(atn.nspname, at.typname)
                                ORDER BY argument.ordinality)
               FROM unnest(lp.proargtypes) WITH ORDINALITY
                      AS argument(type_oid, ordinality)
               JOIN pg_catalog.pg_type at ON at.oid = argument.type_oid
               JOIN pg_catalog.pg_namespace atn ON atn.oid = at.typnamespace),
            '[]'::jsonb)),
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM denied_routine dr
      JOIN pg_catalog.pg_proc lp ON lp.oid = dr.oid
      JOIN pg_catalog.pg_namespace lpn ON lpn.oid = lp.pronamespace,
           aclexplode(COALESCE(lp.proacl, acldefault('f', lp.proowner))) AS acl
    UNION ALL
    SELECT jsonb_build_array('type', n.nspname, t.typname),
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace,
           aclexplode(COALESCE(t.typacl, acldefault('T', t.typowner))) AS acl
     WHERE NOT (t.typcategory = 'A' AND t.typelem <> 0)
    UNION ALL
    -- language 的隐式 ACL。PostgreSQL 18.4 实测：acldefault 对**受信与非受信
    -- 语言完全相同**，都是 {=U/owner, owner=U/owner}——非受信语言的限制在建函数
    -- 时按 superuser 判定，不体现在 ACL 上，因此 has_language_privilege 对任意
    -- 角色、非受信语言同样返回 true。
    -- 所以这里**不能**按 lanpltrusted 过滤：那会让 raw 说「没人有 USAGE」而
    -- effective 说「所有人都有」，两层自相矛盾。
    SELECT jsonb_build_array('language', l.lanname),
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_language l,
           aclexplode(COALESCE(l.lanacl, acldefault('l', l.lanowner))) AS acl
    UNION ALL
    SELECT jsonb_build_array('largeobject', m.oid::text),
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_largeobject_metadata m,
           aclexplode(COALESCE(m.lomacl, acldefault('L', m.lomowner))) AS acl
  ),
  -- pg_default_acl 的原始行。**先保留行存在性**，再展开 ACL：空 ACL 展开是零行，
  -- 与「没有这一行」无法区分，因此存在性不能由 aclexplode 的结果反推。
  default_row (scope_kind, defaclrole, objtype, scope, acl, is_empty) AS (
    SELECT CASE WHEN d.defaclnamespace = 0 THEN 'global' ELSE 'schema' END,
           pg_catalog.pg_get_userbyid(d.defaclrole)::text,
           d.defaclobjtype::text,
           COALESCE(dn.nspname::text, '-'),
           d.defaclacl,
           COALESCE(array_length(d.defaclacl, 1), 0) = 0
      FROM pg_catalog.pg_default_acl d
      LEFT JOIN pg_catalog.pg_namespace dn ON dn.oid = d.defaclnamespace
  ),
  default_raw (scope_kind, defaclrole, objtype, scope, grantee, grantor,
               privilege, grantable) AS (
    SELECT r.scope_kind, r.defaclrole, r.objtype, r.scope,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM default_row r, aclexplode(r.acl) AS acl
  ),
  -- pg_default_acl 的 objtype ↔ acldefault 的 objtype。两套编码只有 sequence
  -- 不同名（S vs s），而 acldefault('S', …) 是 FOREIGN SERVER，会把 sequence 的
  -- 内建默认从 SELECT/UPDATE/USAGE 悄悄变成只剩 USAGE。渲染成显式映射表，
  -- 保证 base 永远不会拿 defaclobjtype 直接去调 acldefault。
  default_objtype (objtype, acldefault_objtype, schema_scoped) AS (
    VALUES
      ('L'::text, 'L'::text, false::boolean),
      ('S', 's', true),
      ('T', 'T', true),
      ('f', 'f', true),
      ('n', 'n', false),
      ('r', 'r', true)
  ),
  -- 被监管的 default ACL 槽位：受监管的 owner × 六个 objtype × （managed schema
  -- 与 global）。owner 集合动态取自 pg_default_acl 里出现过的 defaclrole，再并上
  -- canonical 的 migrator——因此不是「硬编码一个 owner + 四个 objtype」。
  default_owner (rolname, oid) AS (
    SELECT r.rolname::text, r.oid
      FROM pg_catalog.pg_roles r
     WHERE r.rolname = 'meal_agent_migrator'
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d
                    WHERE d.defaclrole = r.oid)
  ),
  default_slot (defaclrole, owner_oid, objtype, acldefault_objtype, scope,
                schema_scoped) AS (
    SELECT o.rolname, o.oid, t.objtype, t.acldefault_objtype, s.scope,
           s.schema_scoped
      FROM default_owner o,
           default_objtype t,
           (SELECT nspname AS scope, true AS schema_scoped FROM managed_schema
             UNION ALL SELECT '-', false) s
     WHERE s.schema_scoped = false
        OR t.schema_scoped
  ),
  -- base = 非空 global 行则**替换**内建默认；否则内建默认（按映射后的 objtype）。
  default_base (defaclrole, objtype, scope, grantee, grantor, privilege,
                grantable) AS (
    SELECT sl.defaclrole, sl.objtype, sl.scope,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM default_slot sl
      LEFT JOIN default_row g
        ON g.scope_kind = 'global' AND g.defaclrole = sl.defaclrole
       AND g.objtype = sl.objtype AND NOT g.is_empty,
           aclexplode(COALESCE(g.acl,
                               acldefault(sl.acldefault_objtype::"char",
                                          sl.owner_oid))) AS acl
  ),
  -- effective = base ⊎ schema 行；同一 (grantee, grantor, privilege) 只出一行，
  -- grantable 用 bool_or 聚合真实语义。
  default_effective (defaclrole, objtype, scope, grantee, grantor, privilege,
                     grantable) AS (
    SELECT defaclrole, objtype, scope, grantee, grantor, privilege,
           bool_or(grantable)
      FROM (
        SELECT defaclrole, objtype, scope, grantee, grantor, privilege, grantable
          FROM default_base
        UNION ALL
        SELECT r.defaclrole, r.objtype, r.scope, r.grantee, r.grantor,
               r.privilege, r.grantable
          FROM default_raw r
         WHERE r.scope_kind = 'schema'
           AND EXISTS (SELECT 1 FROM default_slot sl
                        WHERE sl.defaclrole = r.defaclrole
                          AND sl.objtype = r.objtype AND sl.scope = r.scope)
      ) AS composed
     GROUP BY defaclrole, objtype, scope, grantee, grantor, privilege
  ),
  owner_source (objkey, owner_name) AS (
    SELECT jsonb_build_array('database', '<current>'), pg_catalog.pg_get_userbyid(d.datdba)::text
      FROM pg_catalog.pg_database d WHERE d.datname = current_database()
    UNION ALL
    SELECT jsonb_build_array('schema', n.nspname),
           pg_catalog.pg_get_userbyid(n.nspowner)::text
      FROM managed_schema n
    UNION ALL
    SELECT jsonb_build_array('relation', n.nspname, c.relname),
           pg_catalog.pg_get_userbyid(c.relowner)::text
      FROM pg_catalog.pg_class c
      JOIN managed_schema n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT jsonb_build_array('routine', n.nspname, p.proname,
                     COALESCE((SELECT jsonb_agg(jsonb_build_array(atn.nspname, at.typname)
                                ORDER BY argument.ordinality)
               FROM unnest(p.proargtypes) WITH ORDINALITY
                      AS argument(type_oid, ordinality)
               JOIN pg_catalog.pg_type at ON at.oid = argument.type_oid
               JOIN pg_catalog.pg_namespace atn ON atn.oid = at.typnamespace),
            '[]'::jsonb)),
           pg_catalog.pg_get_userbyid(p.proowner)::text
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace
    UNION ALL
    SELECT jsonb_build_array('type', n.nspname, t.typname),
           pg_catalog.pg_get_userbyid(t.typowner)::text
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace
    UNION ALL
    SELECT jsonb_build_array('largeobject', m.oid::text),
           pg_catalog.pg_get_userbyid(m.lomowner)::text
      FROM pg_catalog.pg_largeobject_metadata m
  ),
  effective_source (objkey, role_name, privileges) AS (
    SELECT jsonb_build_array('database', '<current>'), pr.role_name,
           (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p
             WHERE has_database_privilege(pr.probe_name, current_database(), p))
      FROM probe_role pr
    UNION ALL
    SELECT jsonb_build_array('schema', n.nspname), pr.role_name,
           (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['CREATE', 'USAGE']) AS p
             WHERE has_schema_privilege(pr.probe_name, n.oid, p))
      FROM managed_schema n, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('relation', n.nspname, c.relname), pr.role_name,
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
    -- 列级有效权限：列上的授权不出现在 relacl 里，只看表级会整类漏掉。
    SELECT jsonb_build_array('column', n.nspname, c.relname, a.attname),
           pr.role_name,
           (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['INSERT', 'REFERENCES', 'SELECT',
                                'UPDATE']) AS p
             WHERE has_column_privilege(pr.probe_name, c.oid, a.attnum, p))
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN managed_schema n ON n.oid = c.relnamespace, probe_role pr
     WHERE a.attnum > 0 AND NOT a.attisdropped
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    UNION ALL
    SELECT jsonb_build_array('routine', n.nspname, p.proname,
                     COALESCE((SELECT jsonb_agg(jsonb_build_array(atn.nspname, at.typname)
                                ORDER BY argument.ordinality)
               FROM unnest(p.proargtypes) WITH ORDINALITY
                      AS argument(type_oid, ordinality)
               JOIN pg_catalog.pg_type at ON at.oid = argument.type_oid
               JOIN pg_catalog.pg_namespace atn ON atn.oid = at.typnamespace),
            '[]'::jsonb)), pr.role_name,
           CASE WHEN has_function_privilege(pr.probe_name, p.oid, 'EXECUTE')
                THEN 'EXECUTE' ELSE NULL END
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('routine', lpn.nspname, lp.proname,
                     COALESCE((SELECT jsonb_agg(jsonb_build_array(atn.nspname, at.typname)
                                ORDER BY argument.ordinality)
               FROM unnest(lp.proargtypes) WITH ORDINALITY
                      AS argument(type_oid, ordinality)
               JOIN pg_catalog.pg_type at ON at.oid = argument.type_oid
               JOIN pg_catalog.pg_namespace atn ON atn.oid = at.typnamespace),
            '[]'::jsonb)), pr.role_name,
           CASE WHEN has_function_privilege(pr.probe_name, lp.oid, 'EXECUTE')
                THEN 'EXECUTE' ELSE NULL END
      FROM denied_routine dr
      JOIN pg_catalog.pg_proc lp ON lp.oid = dr.oid
      JOIN pg_catalog.pg_namespace lpn ON lpn.oid = lp.pronamespace, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('type', n.nspname, t.typname), pr.role_name,
           CASE WHEN has_type_privilege(pr.probe_name, t.oid, 'USAGE')
                THEN 'USAGE' ELSE NULL END
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('language', l.lanname), pr.role_name,
           CASE WHEN has_language_privilege(pr.probe_name, l.oid, 'USAGE')
                THEN 'USAGE' ELSE NULL END
      FROM pg_catalog.pg_language l, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('largeobject', m.oid::text), pr.role_name,
           (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['SELECT', 'UPDATE']) AS p
             WHERE has_largeobject_privilege(pr.probe_name, m.oid, p))
      FROM pg_catalog.pg_largeobject_metadata m, probe_role pr
  )
  SELECT kind, identity, detail
    FROM (
      SELECT 'acl'::text AS kind,
             jsonb_build_array(objkey, grantee, grantor, privilege)::text
               AS identity,
             ('grantable=' || CASE WHEN grantable THEN 't' ELSE 'f' END)::text AS detail
        FROM acl_source
      UNION ALL
      SELECT 'default-' || scope_kind,
             jsonb_build_array(defaclrole, objtype, scope, grantee, grantor,
                               privilege)::text,
             'grantable=' || CASE WHEN grantable THEN 't' ELSE 'f' END
        FROM default_raw
      UNION ALL
      SELECT 'default-row',
             jsonb_build_array(defaclrole, objtype, scope, scope_kind)::text,
             'exists=t empty=' || CASE WHEN is_empty THEN 't' ELSE 'f' END
        FROM default_row
      UNION ALL
      -- fail closed：一个本投影不认识的 defaclobjtype 不能静默从 base 里消失。
      -- 它没有可信的 acldefault 参数，因此不参与 default-effective，但必须显式
      -- 现形，由消费方（R8B 的 verify）判为异常。PostgreSQL 18 的默认权限语句
      -- 只能写出上面六种 objtype，所以健康库里这一类恒为空——它是版本前向
      -- 保护，不是已发生过的状态。
      SELECT 'default-unmapped',
             jsonb_build_array(defaclrole, objtype, scope, scope_kind)::text,
             'acldefault-objtype=unknown'
        FROM default_row r
       WHERE NOT EXISTS (SELECT 1 FROM default_objtype t
                          WHERE t.objtype = r.objtype)
      UNION ALL
      SELECT 'default-effective',
             jsonb_build_array(defaclrole, objtype, scope, grantee, grantor,
                               privilege)::text,
             'grantable=' || CASE WHEN grantable THEN 't' ELSE 'f' END
        FROM default_effective
      UNION ALL
      SELECT 'effective', jsonb_build_array(objkey, role_name)::text,
             'privs=' || privileges
        FROM effective_source
       WHERE privileges IS NOT NULL
      UNION ALL
      SELECT 'owner', objkey::text, 'owner=' || owner_name
        FROM owner_source
      UNION ALL
      SELECT 'large-object', jsonb_build_array('largeobject', m.oid::text)::text,
             'owner=' || pg_catalog.pg_get_userbyid(m.lomowner)
        FROM pg_catalog.pg_largeobject_metadata m
      UNION ALL
      -- 策略：managed 非数组类型的 PUBLIC/app/backup/三个 login 默认无 USAGE，
      -- owner（migrator）保留必要权限；数组类型只记录委托关系，既不建立也不尝试
      -- 撤销独立 ACL（PostgreSQL 对数组类型直接拒绝授权与改属操作）。
      SELECT 'type-class', jsonb_build_array('type', n.nspname, t.typname)::text,
             CASE
               WHEN t.typcategory = 'A' AND t.typelem <> 0
                 THEN 'class=array delegates-to='
                        || jsonb_build_array(etn.nspname, et.typname)::text
               WHEN t.typtype = 'c' AND EXISTS (
                      SELECT 1 FROM pg_catalog.pg_class rc
                       WHERE rc.oid = t.typrelid AND rc.relkind <> 'c')
                 THEN 'class=row grantable-directly=t'
               ELSE 'class=element grantable-directly=t'
             END
        FROM pg_catalog.pg_type t
        JOIN managed_schema n ON n.oid = t.typnamespace
        LEFT JOIN pg_catalog.pg_type et ON et.oid = t.typelem
        LEFT JOIN pg_catalog.pg_namespace etn ON etn.oid = et.typnamespace
      UNION ALL
      SELECT 'role', jsonb_build_array(role_name)::text, 'class=' || role_class
        FROM probe_role
    ) AS projection
   ORDER BY kind COLLATE "C", identity COLLATE "C", detail COLLATE "C";
