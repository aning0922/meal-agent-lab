-- 阶段 09A / M2A：授权断言（完整元组的 catalog ACL + default privilege 物理行与有效叠加 + has_*_privilege 有效权限）。
--
-- GENERATED FILE — DO NOT EDIT.
-- 事实源： services/api/src/database/authorization-manifest.ts
-- 共享观察： services/api/src/database/authorization-projection-sql.ts
-- 可移植策略： services/api/src/database/authorization-policy-sql.ts
-- 重新生成： pnpm --filter @meal-agent/api manifest:generate
-- 门禁： pnpm --filter @meal-agent/api manifest:check（内存渲染逐字节比对，不会自动改写本文件）
-- manifest version: 2
-- canonical manifest digest: sha256:8ce7d05c8ffa89a8fb0429d119b9edbc6b22badd1ff4f78e56d1e7e0635c5ea8
--
-- 本文件是纯只读 SQL：不匹配时 RAISE EXCEPTION，不做任何变更。
-- 调用方必须先设置 GUC meal_agent.acl_phase（containment 或 final）。

DO $meal_agent_authorization_verify$
DECLARE
  acl_phase text;
  state_key text;
  problem_count integer;
  problem_detail text;
  divergence_count integer;
  divergence text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
  PERFORM pg_catalog.set_config('quote_all_identifiers', 'off', true);

  IF to_regclass('drizzle.__meal_agent_migrations') IS NULL THEN
    RAISE EXCEPTION
      'authorization manifest: the migration ledger is missing; the database '
      'is not in a state this baseline can reason about';
  END IF;
  acl_phase := current_setting('meal_agent.acl_phase');
  IF acl_phase NOT IN ('containment', 'final') THEN
    RAISE EXCEPTION
      'authorization manifest: unknown phase %; expected containment or final',
      acl_phase;
  END IF;
  SELECT jsonb_build_array(
           COALESCE((SELECT jsonb_agg(name ORDER BY name COLLATE "C")
                       FROM drizzle.__meal_agent_migrations),
                    '[]'::jsonb),
           acl_phase)::text
    INTO state_key;
  IF NOT (state_key = ANY (ARRAY['[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '[["0000_stage_06.sql"], "containment"]', '[["0000_stage_06.sql"], "final"]']::text[])) THEN
    RAISE EXCEPTION
      'authorization manifest: unregistered (ledger, phase) state %; register '
      'it in services/api/src/database/authorization-manifest.ts before '
      'running this baseline', state_key;
  END IF;

  -- 1. 与收敛完全相同的致命前置条件，同样先于一切判断。
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
  -- 受监管对象的**统一枚举**。identity、分类、owner、DDL 目标、原始 ACL 与
  -- acldefault 的 objtype 都在这里一次性确定，下游的 acl_source 与
  -- managed_object 都从它派生，不再各自重复扫描 catalog。
  --   * acl_default_objtype 为 NULL 表示该类没有内建默认 ACL（只有列级如此：
  --     attacl IS NULL 就是「没有列级授权」，不能 COALESCE 成内建默认）。
  --   * 数组类型不在此枚举内：PostgreSQL 直接拒绝对数组类型授权与改属，
  --     它们只在 type_class 里记录「向元素类型委托」。
  regulated_object (objkey, object_class, owner_name, owner_oid, target_sql,
                    colname, acl, acl_default_objtype) AS (
    SELECT jsonb_build_array('database', '<current>'), 'database'::text,
           pg_catalog.pg_get_userbyid(d.datdba)::text, d.datdba,
           ('DATABASE ' || quote_ident(current_database()))::text, NULL::text,
           d.datacl, 'd'::"char"
      FROM pg_catalog.pg_database d WHERE d.datname = current_database()
    UNION ALL
    SELECT jsonb_build_array('schema', n.nspname), 'schema',
           pg_catalog.pg_get_userbyid(n.nspowner), n.nspowner,
           'SCHEMA ' || quote_ident(n.nspname), NULL,
           n.nspacl, 'n'
      FROM managed_schema n
    UNION ALL
    SELECT jsonb_build_array('relation', n.nspname, c.relname), 'relation',
           pg_catalog.pg_get_userbyid(c.relowner), c.relowner,
           CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END
             || quote_ident(n.nspname) || '.' || quote_ident(c.relname), NULL,
           c.relacl,
           CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char"
      FROM pg_catalog.pg_class c
      JOIN managed_schema n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT jsonb_build_array('column', n.nspname, c.relname, a.attname),
           'column', pg_catalog.pg_get_userbyid(c.relowner), c.relowner,
           'TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
           a.attname::text,
           a.attacl, NULL
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN managed_schema n ON n.oid = c.relnamespace
     WHERE a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT jsonb_build_array('routine', n.nspname, p.proname,
                     COALESCE((SELECT jsonb_agg(jsonb_build_array(atn.nspname, at.typname)
                                ORDER BY argument.ordinality)
               FROM unnest(p.proargtypes) WITH ORDINALITY
                      AS argument(type_oid, ordinality)
               JOIN pg_catalog.pg_type at ON at.oid = argument.type_oid
               JOIN pg_catalog.pg_namespace atn ON atn.oid = at.typnamespace),
            '[]'::jsonb)), 'routine',
           pg_catalog.pg_get_userbyid(p.proowner), p.proowner,
           'ROUTINE ' || quote_ident(n.nspname) || '.'
             || quote_ident(p.proname) || '('
             || pg_catalog.pg_get_function_identity_arguments(p.oid)
             || ')', NULL,
           p.proacl, 'f'
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace
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
            '[]'::jsonb)), 'denied-routine',
           pg_catalog.pg_get_userbyid(lp.proowner), lp.proowner,
           'ROUTINE ' || quote_ident(lpn.nspname) || '.'
             || quote_ident(lp.proname) || '('
             || pg_catalog.pg_get_function_identity_arguments(lp.oid)
             || ')', NULL,
           lp.proacl, 'f'
      FROM denied_routine dr
      JOIN pg_catalog.pg_proc lp ON lp.oid = dr.oid
      JOIN pg_catalog.pg_namespace lpn ON lpn.oid = lp.pronamespace
    UNION ALL
    SELECT jsonb_build_array('type', n.nspname, t.typname), 'type',
           pg_catalog.pg_get_userbyid(t.typowner), t.typowner,
           'TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname),
           NULL,
           t.typacl, 'T'
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace
     WHERE NOT (t.typcategory = 'A' AND t.typelem <> 0)
    UNION ALL
    -- language 的隐式 ACL。PostgreSQL 18.4 实测：acldefault 对**受信与非受信
    -- 语言完全相同**，都是 {=U/owner, owner=U/owner}——非受信语言的限制在建函数
    -- 时按 superuser 判定，不体现在 ACL 上，因此 has_language_privilege 对任意
    -- 角色、非受信语言同样返回 true。
    -- 所以这里**不能**按 lanpltrusted 过滤：那会让 raw 说「没人有 USAGE」而
    -- effective 说「所有人都有」，两层自相矛盾。
    SELECT jsonb_build_array('language', l.lanname), 'language',
           pg_catalog.pg_get_userbyid(l.lanowner), l.lanowner,
           'LANGUAGE ' || quote_ident(l.lanname), NULL,
           l.lanacl, 'l'
      FROM pg_catalog.pg_language l
    UNION ALL
    SELECT jsonb_build_array('largeobject', m.oid::text), 'largeobject',
           pg_catalog.pg_get_userbyid(m.lomowner), m.lomowner,
           NULL, NULL,
           m.lomacl, 'L'
      FROM pg_catalog.pg_largeobject_metadata m
  ),
  -- 可以直接作为授权语句目标的对象。列级授权要经由父表加列名，Large Object
  -- 一律 fail closed 不参与 mutation，入口点只允许 owner 自身，因此三者都不在
  -- 这里。（本文件仍是纯 SELECT：这里只是把执行目标文本采集成事实。）
  managed_object (objkey, object_class, owner_name, target_sql) AS (
    SELECT objkey, object_class, owner_name, target_sql
      FROM regulated_object
     WHERE object_class IN ('database', 'schema', 'relation', 'routine',
                            'type', 'language')
  ),
  acl_source (objkey, object_class, owner_name, target_sql, colname,
              grantee, grantor, privilege, grantable) AS (
    SELECT o.objkey, o.object_class, o.owner_name, o.target_sql, o.colname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM regulated_object o,
           aclexplode(
             CASE WHEN o.acl_default_objtype IS NULL THEN o.acl
                  ELSE COALESCE(o.acl,
                                acldefault(o.acl_default_objtype, o.owner_oid))
             END) AS acl
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
  -- 保证 base 永远不会拿 defaclobjtype 直接去调 acldefault；ddl_keyword 同源，
  -- 收敛阶段不必再从 identity 里反解 objtype。
  default_objtype (objtype, acldefault_objtype, schema_scoped, ddl_keyword) AS (
    VALUES
      ('L'::text, 'L'::text, false::boolean, 'LARGE OBJECTS'::text),
      ('S', 's', true, 'SEQUENCES'),
      ('T', 'T', true, 'TYPES'),
      ('f', 'f', true, 'FUNCTIONS'),
      ('n', 'n', false, 'SCHEMAS'),
      ('r', 'r', true, 'TABLES')
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
  owner_source (objkey, object_class, owner_name) AS (
    SELECT jsonb_build_array('database', '<current>'), 'database'::text,
           pg_catalog.pg_get_userbyid(d.datdba)::text
      FROM pg_catalog.pg_database d WHERE d.datname = current_database()
    UNION ALL
    SELECT jsonb_build_array('schema', n.nspname), 'schema',
           pg_catalog.pg_get_userbyid(n.nspowner)::text
      FROM managed_schema n
    UNION ALL
    SELECT jsonb_build_array('relation', n.nspname, c.relname), 'relation',
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
            '[]'::jsonb)), 'routine',
           pg_catalog.pg_get_userbyid(p.proowner)::text
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace
    UNION ALL
    SELECT jsonb_build_array('type', n.nspname, t.typname), 'type',
           pg_catalog.pg_get_userbyid(t.typowner)::text
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace
    UNION ALL
    SELECT jsonb_build_array('largeobject', m.oid::text), 'largeobject',
           pg_catalog.pg_get_userbyid(m.lomowner)::text
      FROM pg_catalog.pg_largeobject_metadata m
  ),
  -- 有效权限。privileges 是**排序后的数组**而不是拼接串：策略层需要做子集判定
  -- （列级有效权限必须是同表表级有效权限的子集），拼接串只能靠再切一次字符串。
  -- 对外三列投影里再 array_to_string 成原来的 'privs=A,B' 形态，语义不变。
  effective_source (objkey, object_class, role_name, privileges) AS (
    SELECT jsonb_build_array('database', '<current>'), 'database'::text, pr.role_name,
           (SELECT array_agg(p ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p
             WHERE has_database_privilege(pr.probe_name, current_database(), p))
      FROM probe_role pr
    UNION ALL
    SELECT jsonb_build_array('schema', n.nspname), 'schema', pr.role_name,
           (SELECT array_agg(p ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['CREATE', 'USAGE']) AS p
             WHERE has_schema_privilege(pr.probe_name, n.oid, p))
      FROM managed_schema n, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('relation', n.nspname, c.relname), 'relation',
           pr.role_name,
           CASE WHEN c.relkind = 'S' THEN
             (SELECT array_agg(p ORDER BY p COLLATE "C")
                FROM unnest(ARRAY['SELECT', 'UPDATE', 'USAGE']) AS p
               WHERE has_sequence_privilege(pr.probe_name, c.oid, p))
           ELSE
             (SELECT array_agg(p ORDER BY p COLLATE "C")
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
           'column', pr.role_name,
           (SELECT array_agg(p ORDER BY p COLLATE "C")
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
            '[]'::jsonb)), 'routine', pr.role_name,
           CASE WHEN has_function_privilege(pr.probe_name, p.oid, 'EXECUTE')
                THEN ARRAY['EXECUTE'] ELSE NULL END
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
            '[]'::jsonb)), 'denied-routine', pr.role_name,
           CASE WHEN has_function_privilege(pr.probe_name, lp.oid, 'EXECUTE')
                THEN ARRAY['EXECUTE'] ELSE NULL END
      FROM denied_routine dr
      JOIN pg_catalog.pg_proc lp ON lp.oid = dr.oid
      JOIN pg_catalog.pg_namespace lpn ON lpn.oid = lp.pronamespace, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('type', n.nspname, t.typname), 'type', pr.role_name,
           CASE WHEN has_type_privilege(pr.probe_name, t.oid, 'USAGE')
                THEN ARRAY['USAGE'] ELSE NULL END
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('language', l.lanname), 'language', pr.role_name,
           CASE WHEN has_language_privilege(pr.probe_name, l.oid, 'USAGE')
                THEN ARRAY['USAGE'] ELSE NULL END
      FROM pg_catalog.pg_language l, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('largeobject', m.oid::text), 'largeobject',
           pr.role_name,
           (SELECT array_agg(p ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['SELECT', 'UPDATE']) AS p
             WHERE has_largeobject_privilege(pr.probe_name, m.oid, p))
      FROM pg_catalog.pg_largeobject_metadata m, probe_role pr
  ),
  -- 受控 routine 的精确指纹：identity + owner + SECURITY DEFINER + proconfig
  -- + 正文摘要。执行授权只是一半，另一半是「以谁的身份、带什么
  -- search_path / row_security、跑的是不是原来那份正文」。
  routine_fingerprint (objkey, owner_name, security_definer, config,
                       body_digest) AS (
    SELECT jsonb_build_array('routine', n.nspname, p.proname,
                     COALESCE((SELECT jsonb_agg(jsonb_build_array(atn.nspname, at.typname)
                                ORDER BY argument.ordinality)
               FROM unnest(p.proargtypes) WITH ORDINALITY
                      AS argument(type_oid, ordinality)
               JOIN pg_catalog.pg_type at ON at.oid = argument.type_oid
               JOIN pg_catalog.pg_namespace atn ON atn.oid = at.typnamespace),
            '[]'::jsonb)),
           pg_catalog.pg_get_userbyid(p.proowner)::text,
           p.prosecdef,
           -- proconfig 用结构化 JSON 数组：设置值本身可以含分隔符，拼接串
           -- 在那一刻就不可反解也不可比较。Node 侧用同一份 identity 编码。
           COALESCE(to_jsonb(p.proconfig), '[]'::jsonb)::text,
           pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')::text
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace
  ),
  -- 角色成员图。database scope **不修改** membership，只观察：由继承造成、
  -- 无法靠 ACL mutation 修复的 effective 漂移必须 fail closed 并指向
  -- cluster role baseline。这里是纯事实，不含任何允许集合。
  role_membership (member_name, granted_name, grantor_name, admin_option,
                   inherit_option, set_option) AS (
    SELECT m.rolname::text, g.rolname::text, gr.rolname::text,
           a.admin_option, a.inherit_option, a.set_option
      FROM pg_catalog.pg_auth_members a
      JOIN pg_catalog.pg_roles m ON m.oid = a.member
      JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
      JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
  ),
  -- 类型分类：managed 非数组类型的 PUBLIC/app/backup/三个 login 默认无 USAGE，
  -- owner（migrator）保留必要权限；数组类型只记录委托关系，既不建立也不尝试
  -- 撤销独立 ACL（PostgreSQL 对数组类型直接拒绝授权与改属操作）。
  type_class (objkey, class_name, detail) AS (
    SELECT jsonb_build_array('type', n.nspname, t.typname),
           CASE
             WHEN t.typcategory = 'A' AND t.typelem <> 0 THEN 'array'
             WHEN t.typtype = 'c' AND EXISTS (
                    SELECT 1 FROM pg_catalog.pg_class rc
                     WHERE rc.oid = t.typrelid AND rc.relkind <> 'c')
               THEN 'row'
             ELSE 'element'
           END,
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
  ),
  large_object (objkey, loid, owner_name) AS (
    SELECT jsonb_build_array('largeobject', m.oid::text), m.oid,
           pg_catalog.pg_get_userbyid(m.lomowner)::text
      FROM pg_catalog.pg_largeobject_metadata m
  ),
  -- 固定项目主体。**只**用于固定允许权限、角色存在性，以及区分项目角色与
  -- 动态发现的外部角色；绝不用来过滤 catalog 里的 grantee 或 grantor。
  principal (role_name) AS (
    SELECT unnest(ARRAY['PUBLIC', 'meal_agent_app', 'meal_agent_backup', 'meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_runtime_login']::text[])
  ),
  project_role (role_name) AS (
    SELECT unnest(ARRAY['meal_agent_app', 'meal_agent_backup', 'meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_migrator', 'meal_agent_runtime_login']::text[])
  ),
  project_login (role_name) AS (
    SELECT unnest(ARRAY['meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_runtime_login']::text[])
  ),
  -- canonical membership 图。database scope 绝不修改 membership：这里只用于判断
  -- 「有效权限漂移是不是继承造成的」，是就 fail closed 并要求先跑 cluster role
  -- baseline。
  canonical_membership (member_name, granted_name) AS (
      VALUES
        ('meal_agent_backup_login'::text, 'meal_agent_backup'::text),
        ('meal_agent_migration_login', 'meal_agent_migrator'),
        ('meal_agent_runtime_login', 'meal_agent_app')
  ),
  -- 固定允许的直接授权。canonical grantor 恒为 meal_agent_migrator。
  allowed_grants (state, objkey, grantee, privilege) AS (
      VALUES
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]'::text, '["database", "<current>"]'::jsonb, 'meal_agent_backup_login'::text, 'CONNECT'::text),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_migration_login', 'CONNECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_runtime_login', 'CONNECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "meal_agent_private"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "public"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "public"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_backup_login', 'CONNECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_migration_login', 'CONNECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_runtime_login', 'CONNECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "meal_agent_private"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "public"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "public"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_backup_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_migration_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_runtime_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "meal_agent_private"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "public"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "public"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_backup_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_migration_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_runtime_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "meal_agent_private"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "public"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "public"]', 'meal_agent_backup', 'USAGE')
  ),
  -- 固定允许的**有效**权限，只覆盖四类对象 × 项目主体。
  allowed_effective (state, objkey, role_name, privileges) AS (
      VALUES
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]'::text, '["database", "<current>"]'::jsonb, 'meal_agent_backup_login'::text, ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_migration_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_runtime_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "household_invites"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "meal_agent_private"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "public"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "public"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_backup_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_migration_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_runtime_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "meal_agent_private"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "public"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "public"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_backup_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_migration_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_runtime_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "meal_agent_private"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "public"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "public"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_backup_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_migration_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_runtime_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "meal_agent_private"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "public"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "public"]', 'meal_agent_backup', ARRAY['USAGE']::text[])
  ),
  -- 固定允许的 pg_default_acl **物理行**条目：它决定要执行哪条默认权限语句。
  allowed_default (state, objtype, scope, grantee, privilege) AS (
      VALUES
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]'::text, 'T'::text, '-'::text, 'meal_agent_migrator'::text, 'USAGE'::text),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'f', '-', 'meal_agent_migrator', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', 'public', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'T', '-', 'meal_agent_migrator', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'f', '-', 'meal_agent_migrator', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'drizzle', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'public', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', 'T', '-', 'meal_agent_migrator', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', 'f', '-', 'meal_agent_migrator', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', 'S', 'public', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', 'T', '-', 'meal_agent_migrator', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', 'f', '-', 'meal_agent_migrator', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'drizzle', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'public', 'meal_agent_backup', 'SELECT')
  ),
  -- 叠加之后的**有效**默认权限，只用于最终语义验证。
  allowed_default_effective (state, objtype, scope, grantee, privileges) AS (
      VALUES
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]'::text, 'L'::text, '-'::text, 'meal_agent_migrator'::text, ARRAY['SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'S', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'S', 'drizzle', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'S', 'meal_agent_private', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'S', 'public', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'T', '-', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'T', 'drizzle', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'T', 'meal_agent_private', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'T', 'public', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'f', '-', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'f', 'drizzle', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'f', 'meal_agent_private', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'f', 'public', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'n', '-', 'meal_agent_migrator', ARRAY['CREATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'r', '-', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'r', 'drizzle', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'r', 'meal_agent_private', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'r', 'public', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'L', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', 'drizzle', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', 'meal_agent_private', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', 'public', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', 'public', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'T', '-', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'T', 'drizzle', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'T', 'meal_agent_private', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'T', 'public', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'f', '-', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'f', 'drizzle', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'f', 'meal_agent_private', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'f', 'public', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'n', '-', 'meal_agent_migrator', ARRAY['CREATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', '-', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'drizzle', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'drizzle', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'meal_agent_private', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'public', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'public', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'L', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'S', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'S', 'drizzle', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'S', 'meal_agent_private', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'S', 'public', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'T', '-', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'T', 'drizzle', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'T', 'meal_agent_private', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'T', 'public', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'f', '-', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'f', 'drizzle', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'f', 'meal_agent_private', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'f', 'public', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'n', '-', 'meal_agent_migrator', ARRAY['CREATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'r', '-', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'r', 'drizzle', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'r', 'meal_agent_private', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'r', 'public', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'L', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'S', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'S', 'drizzle', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'S', 'meal_agent_private', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'S', 'public', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'S', 'public', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'T', '-', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'T', 'drizzle', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'T', 'meal_agent_private', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'T', 'public', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'f', '-', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'f', 'drizzle', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'f', 'meal_agent_private', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'f', 'public', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'n', '-', 'meal_agent_migrator', ARRAY['CREATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', '-', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'drizzle', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'drizzle', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'meal_agent_private', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'public', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'public', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[])
  ),
  -- 受控 routine 的允许指纹。managed schema 里出现任何未登记的 routine 一律
  -- fail closed——恢复路径可以把任意 SECURITY DEFINER 函数带进 drizzle。
  allowed_routine (state, objkey, detail) AS (
      VALUES
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]'::text, '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]'::jsonb, 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=8b3b8383eaafef2859c7c6c400fea4560397e2e791398f34eb3d92c983b84d19'::text),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=d8bd3080b2b718d97dd351aa88cabb64d887a05f70188c42875bd93598455ff4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=340b7dafbb3538c8f7be9b75680eee66ac11d95cb7bb63c7eacecc1f0dd181b4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=2f6eaefdd9503cc95274b27a06bd2c026510ccef5b7d5ee1e39c493856a12b1c'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=49c69edb63ba9c79f1cebedfa662a79008307ef7ff58c654b90b3fa0a5f5802d'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=8a6ca11f5b63ddd757d2ab4ee55bd6d8eeafa0b86109e48d57804f7beb983d56'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=9f114cec5f9c266b441cb4225ca188bd3069bbcc80b2dbb7d066725a3e3013b2'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=bda888f524207ddd8ecb1875ed75cff298b4c8e57d27e869370f55cf92702e2a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'owner=meal_agent_migrator secdef=f config=["search_path=pg_catalog, public"] body=aaee625351184de80262214f2f0b048e1941afac9200ffd5c54b8956c71f250a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=73fd5f37faf85bef8803c3902375365d9f3d2eb5ced6d318813a911864b35df4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5dabf7d1671c857717fd8a18d72ea7961ab6f582965f6177dcdb697d2f14988c'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=44e6d5df0e195097d4a782ae2b4a0fd6e9eb6e2e74d570910ab075e804af1cc9'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=8b3b8383eaafef2859c7c6c400fea4560397e2e791398f34eb3d92c983b84d19'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=d8bd3080b2b718d97dd351aa88cabb64d887a05f70188c42875bd93598455ff4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=340b7dafbb3538c8f7be9b75680eee66ac11d95cb7bb63c7eacecc1f0dd181b4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=2f6eaefdd9503cc95274b27a06bd2c026510ccef5b7d5ee1e39c493856a12b1c'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=49c69edb63ba9c79f1cebedfa662a79008307ef7ff58c654b90b3fa0a5f5802d'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=8a6ca11f5b63ddd757d2ab4ee55bd6d8eeafa0b86109e48d57804f7beb983d56'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=9f114cec5f9c266b441cb4225ca188bd3069bbcc80b2dbb7d066725a3e3013b2'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=bda888f524207ddd8ecb1875ed75cff298b4c8e57d27e869370f55cf92702e2a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'owner=meal_agent_migrator secdef=f config=["search_path=pg_catalog, public"] body=aaee625351184de80262214f2f0b048e1941afac9200ffd5c54b8956c71f250a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=73fd5f37faf85bef8803c3902375365d9f3d2eb5ced6d318813a911864b35df4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5dabf7d1671c857717fd8a18d72ea7961ab6f582965f6177dcdb697d2f14988c'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=44e6d5df0e195097d4a782ae2b4a0fd6e9eb6e2e74d570910ab075e804af1cc9'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a')
  ),
  -- 直接授权的策略判定。privilege_allowed **不含** grantable 判断：一条本身允许、
  -- 只是多带了可再授予标志的授权只应收回该标志，而不是把 owner 自己的权限
  -- 一并撤掉。
  acl_verdict (objkey, object_class, owner_name, target_sql, colname, grantee,
               grantor, privilege, grantable, privilege_allowed) AS (
    SELECT a.objkey, a.object_class, a.owner_name, a.target_sql, a.colname,
           a.grantee, a.grantor, a.privilege, a.grantable,
           CASE
             -- 列级：当前没有任何允许项，任何列 ACL 都是漂移。
             WHEN a.object_class = 'column' THEN false
             -- Large Object：产品声明禁用，任意对象都在 mutation 之前 fail
             -- closed；这里同样不给任何允许项。
             WHEN a.object_class = 'largeobject' THEN false
             -- 对象 owner 自身：NULL ACL 展开出来的内建默认，以及 owner 对自己
             -- 对象的固有权限。managed 非数组 type 只靠这一条放行。
             WHEN a.grantee = a.owner_name AND a.grantor = a.owner_name
               THEN true
             -- language：PostgreSQL 内建的 owner 与 PUBLIC USAGE。显式外部授权、
             -- 错误 grantor 与可再授予标志都落不到这一条上。
             WHEN a.object_class = 'language' AND a.grantee = 'PUBLIC'
                  AND a.grantor = a.owner_name AND a.privilege = 'USAGE'
               THEN true
             -- 固定允许项：canonical grantor 必须是 meal_agent_migrator。
             WHEN a.object_class IN ('database', 'schema', 'relation', 'routine')
                  AND a.grantor = 'meal_agent_migrator'
               THEN EXISTS (SELECT 1 FROM allowed_grants g
                             WHERE g.state = state_key
                               AND g.objkey = a.objkey
                               AND g.grantee = a.grantee
                               AND g.privilege = a.privilege)
             ELSE false
           END
      FROM acl_source a
  ),
  -- 默认权限物理行的策略判定，同样把可再授予标志与「条目本身允许」分开。
  default_verdict (scope_kind, defaclrole, objtype, scope, grantee, grantor,
                   privilege, grantable, ddl_keyword, privilege_allowed) AS (
    SELECT r.scope_kind, r.defaclrole, r.objtype, r.scope, r.grantee, r.grantor,
           r.privilege, r.grantable, t.ddl_keyword,
           r.defaclrole = 'meal_agent_migrator'
             AND r.grantor = 'meal_agent_migrator'
             AND EXISTS (SELECT 1 FROM allowed_default ad
                          WHERE ad.state = state_key
                            AND ad.objtype = r.objtype
                            AND ad.scope = r.scope
                            AND ad.grantee = r.grantee
                            AND ad.privilege = r.privilege)
      FROM default_raw r
      LEFT JOIN default_objtype t ON t.objtype = r.objtype
  ),
  -- 默认权限语句的**起算点**（PostgreSQL 18.4 实测，与 R8A 固化的叠加语义
  -- 同源）：global 形式从内建 acldefault 起算，schema 形式从空起算。
  -- 因此一个「内容是内建默认真子集」的 global 行，只能靠**撤销**才能得到——
  -- 只补授缺失项永远造不出它，而且补授的结果恰好等于内建默认时 PostgreSQL 会
  -- 直接把行删掉。
  default_baseline (defaclrole, objtype, scope, grantee, grantor, privilege,
                    grantable) AS (
    SELECT sl.defaclrole, sl.objtype, sl.scope,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
           pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM default_slot sl,
           aclexplode(acldefault(sl.acldefault_objtype::"char",
                                 sl.owner_oid)) AS acl
     WHERE sl.scope = '-'
  ),
  -- 默认权限语句**当前看到的**内容：有物理行就是行里的内容（哪怕是空行），
  -- 没有物理行时 global 落回内建默认、schema 落回空。
  default_current (defaclrole, objtype, scope, scope_kind, grantee, grantor,
                   privilege, grantable) AS (
    SELECT r.defaclrole, r.objtype, r.scope, r.scope_kind, r.grantee, r.grantor,
           r.privilege, r.grantable
      FROM default_raw r
    UNION ALL
    SELECT b.defaclrole, b.objtype, b.scope, 'global', b.grantee, b.grantor,
           b.privilege, b.grantable
      FROM default_baseline b
     WHERE NOT EXISTS (SELECT 1 FROM default_row g
                        WHERE g.defaclrole = b.defaclrole
                          AND g.objtype = b.objtype
                          AND g.scope_kind = 'global')
  ),
  -- 目标内容。有登记项的槽位：目标就是登记项；没有登记项的槽位：目标是「没有
  -- 物理行」，也就是回落到起算点。后者对 schema 槽位是空集，对 global 槽位是
  -- 内建默认——正是这一条让「没登记 = 不动内建默认」成立。
  default_target (defaclrole, objtype, scope, scope_kind, grantee, grantor,
                  privilege, grantable) AS (
    SELECT 'meal_agent_migrator', ad.objtype, ad.scope,
           CASE WHEN ad.scope = '-' THEN 'global' ELSE 'schema' END,
           ad.grantee, 'meal_agent_migrator', ad.privilege, false
      FROM allowed_default ad
     WHERE ad.state = state_key
    UNION ALL
    SELECT b.defaclrole, b.objtype, b.scope, 'global', b.grantee, b.grantor,
           b.privilege, b.grantable
      FROM default_baseline b
     WHERE b.defaclrole = 'meal_agent_migrator'
       AND NOT EXISTS (SELECT 1 FROM allowed_default ad
                        WHERE ad.state = state_key
                          AND ad.objtype = b.objtype
                          AND ad.scope = b.scope)
  ),
  -- language 的**必需**授权：PostgreSQL 内建默认给出 owner 与 PUBLIC 的
  -- USAGE，两条都是运行所需（plpgsql 没有 PUBLIC USAGE 时，任何非 owner 角色
  -- 都无法执行 plpgsql 函数）。它们是动态登记的——owner 从 catalog 现取，
  -- 不写死角色名——因此缺失时 verify 拒绝、converge 以 language owner 的身份
  -- 恢复。
  required_language_grants (objkey, target_sql, owner_name, grantee,
                           privilege) AS (
    SELECT o.objkey, o.target_sql, o.owner_name, required.grantee, 'USAGE'::text
      FROM regulated_object o,
           LATERAL (VALUES ('PUBLIC'::text), (o.owner_name)) AS required(grantee)
     WHERE o.object_class = 'language'
  ),
  effective_actual (objkey, object_class, role_name, privileges) AS (
    SELECT objkey, object_class, role_name, privileges
      FROM effective_source
     WHERE privileges IS NOT NULL
  ),
  -- 受精确验证的有效权限面：四类对象 × 非 owner 主体。owner 的有效权限来自
  -- 归属，由 owner 前置条件单独验证，不在这里逐条冻结。
  effective_regulated (objkey, role_name, privileges) AS (
    SELECT objkey, role_name, privileges
      FROM effective_actual
     WHERE object_class IN ('database', 'schema', 'relation', 'routine')
       AND role_name <> 'meal_agent_migrator'
  ),
  -- **继承而来**的有效权限：既没有授予 PUBLIC、也没有授予该角色自己，却仍然
  -- 探测得到——只可能来自角色成员关系（外部 NOLOGIN、项目角色，或 pg_read_all_data
  -- 之类的 predefined role）。ACL 阶段按设计**不修改 membership**，因此这一类
  -- 越权不可能靠 ACL mutation 修好，必须在任何 mutation 之前 fail closed。
  -- 数组类型除外：它们没有独立 ACL，有效权限完全委托给元素类型，而元素类型
  -- 本身在 acl_source 里。
  inherited_effective (objkey, object_class, role_name, privilege) AS (
    SELECT e.objkey, e.object_class, e.role_name, granted.privilege
      FROM effective_actual e,
           LATERAL unnest(e.privileges) AS granted(privilege)
     WHERE e.object_class IN ('database', 'schema', 'relation', 'routine',
                              'type', 'denied-routine', 'largeobject')
       AND NOT EXISTS (SELECT 1 FROM type_class tc
                        WHERE tc.objkey = e.objkey AND tc.class_name = 'array')
       AND NOT EXISTS (SELECT 1 FROM acl_source a
                        WHERE a.objkey = e.objkey
                          AND a.privilege = granted.privilege
                          AND (a.grantee = 'PUBLIC'
                               OR a.grantee = e.role_name))
  ),
  preflight_problem (rank, kind, entry) AS (
    -- 1. managed schema 必须齐全：缺任何一个都说明这不是一个可以安全收敛的
    --    目标（新安装漏了 0000，或恢复只恢复了一部分）。
    SELECT 1, 'schema'::text,
           'managed schema ' || expected || ' is missing'
      FROM unnest(ARRAY['drizzle', 'meal_agent_private', 'public']::text[]) AS expected
     WHERE NOT EXISTS (SELECT 1 FROM managed_schema m
                        WHERE m.nspname = expected)
    UNION ALL
    -- 2. 六个项目角色必须存在。
    SELECT 2, 'role',
           'project role ' || pr.role_name || ' is missing; run the cluster '
             || 'role baseline first'
      FROM project_role pr
     WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                        WHERE r.rolname = pr.role_name)
    UNION ALL
    -- 3. 归属。恢复路径尤其不能靠 ACL 阶段偷偷接管归属。
    SELECT 3, 'owner',
           'object ' || o.objkey::text || ' is owned by ' || o.owner_name
             || ', expected ' || 'meal_agent_migrator'
      FROM owner_source o
     WHERE o.object_class IN ('database', 'schema', 'relation', 'routine',
                              'type')
       AND o.owner_name <> 'meal_agent_migrator'
    UNION ALL
    -- 4. 登录角色不得拥有**任何**对象（不限于 managed schema）。若已成为 owner，
    --    归属状态未知：报告并失败，不静默接管，也不删除。
    SELECT 4, 'owner', 'login role owns ' || owned.what
      FROM (
        SELECT 'schema ' || n.nspname AS what,
               pg_catalog.pg_get_userbyid(n.nspowner) AS role_name
          FROM pg_catalog.pg_namespace n
        UNION ALL
        SELECT 'relation ' || n.nspname || '.' || c.relname,
               pg_catalog.pg_get_userbyid(c.relowner)
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        UNION ALL
        SELECT 'routine ' || n.nspname || '.' || p.proname,
               pg_catalog.pg_get_userbyid(p.proowner)
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      ) AS owned
      JOIN project_login pl ON pl.role_name = owned.role_name
    UNION ALL
    -- 5. routine 指纹：identity + owner + SECURITY DEFINER + proconfig + 正文
    --    摘要。未登记的 routine（含 public / drizzle 里的任何函数）一律拒绝。
    SELECT 5, 'routine',
           'unknown routine ' || rf.objkey::text || ' [owner=' || rf.owner_name
             || ' secdef='
             || CASE WHEN rf.security_definer THEN 't' ELSE 'f' END || ']'
      FROM routine_fingerprint rf
     WHERE NOT EXISTS (SELECT 1 FROM allowed_routine ar
                        WHERE ar.state = state_key AND ar.objkey = rf.objkey)
    UNION ALL
    SELECT 5, 'routine', 'missing routine ' || ar.objkey::text
      FROM allowed_routine ar
     WHERE ar.state = state_key
       AND NOT EXISTS (SELECT 1 FROM routine_fingerprint rf
                        WHERE rf.objkey = ar.objkey)
    UNION ALL
    SELECT 5, 'routine',
           'drifted routine ' || ar.objkey::text || ' [expected ' || ar.detail
             || '] [found ' || 'owner=' || rf.owner_name || ' secdef='
             || CASE WHEN rf.security_definer THEN 't' ELSE 'f' END
             || ' config=' || rf.config || ' body=' || rf.body_digest || ']'
      FROM allowed_routine ar
      JOIN routine_fingerprint rf ON rf.objkey = ar.objkey
     WHERE ar.state = state_key
       AND ar.detail IS DISTINCT FROM
           'owner=' || rf.owner_name || ' secdef='
             || CASE WHEN rf.security_definer THEN 't' ELSE 'f' END
             || ' config=' || rf.config || ' body=' || rf.body_digest
    UNION ALL
    -- 6. manifest 要求的对象必须真实存在，否则允许项会静默漏掉。
    SELECT 6, 'object',
           'state expects an object that does not exist: '
             || required.objkey::text
      FROM (SELECT objkey FROM allowed_grants WHERE state = state_key
            UNION
            SELECT objkey FROM allowed_effective
             WHERE state = state_key) AS required
     WHERE NOT EXISTS (SELECT 1 FROM managed_object mo
                        WHERE mo.objkey = required.objkey)
    UNION ALL
    -- 7. 未知 defaclobjtype：没有可信的 acldefault 参数，因此绝不能静默进入
    --    收敛。它是版本前向保护，健康库恒为空。
    SELECT 7, 'default-unmapped',
           'pg_default_acl row with an unmapped objtype: '
             || jsonb_build_array(defaclrole, objtype, scope, scope_kind)::text
      FROM default_row r
     WHERE NOT EXISTS (SELECT 1 FROM default_objtype t
                        WHERE t.objtype = r.objtype)
    UNION ALL
    -- 8. 任意 Large Object。产品声明禁用 LO；这里**只报告**，不解除链接、不删
    --    数据、不接管归属、不改 lomacl，LO 的 OID 也不进入任何固定允许 manifest。
    SELECT 8, 'large-object',
           'large object ' || lo.loid::text || ' owned by ' || lo.owner_name
             || ' exists; this product does not use large objects and this '
             || 'baseline will not remove data'
      FROM large_object lo
    UNION ALL
    -- 9. membership 漂移。database scope 不修改 membership，因此由继承造成、
    --    无法靠 ACL mutation 修复的越权只能 fail closed。
    SELECT 9, 'membership',
           'unexpected role membership ' || rm.member_name || ' in '
             || rm.granted_name || '; run the cluster role baseline first'
      FROM role_membership rm
     WHERE (EXISTS (SELECT 1 FROM project_role pr
                     WHERE pr.role_name = rm.granted_name)
            OR EXISTS (SELECT 1 FROM project_role pr
                        WHERE pr.role_name = rm.member_name))
       AND NOT EXISTS (SELECT 1 FROM canonical_membership cm
                        WHERE cm.member_name = rm.member_name
                          AND cm.granted_name = rm.granted_name)
    UNION ALL
    SELECT 9, 'membership',
           'missing role membership ' || cm.member_name || ' in '
             || cm.granted_name || '; run the cluster role baseline first'
      FROM canonical_membership cm
     WHERE NOT EXISTS (SELECT 1 FROM role_membership rm
                        WHERE rm.member_name = cm.member_name
                          AND rm.granted_name = cm.granted_name)
    UNION ALL
    SELECT 9, 'membership',
           'role membership ' || rm.member_name || ' in ' || rm.granted_name
             || ' has non-canonical options; run the cluster role baseline '
             || 'first'
      FROM role_membership rm
      JOIN canonical_membership cm ON cm.member_name = rm.member_name
                                  AND cm.granted_name = rm.granted_name
     WHERE rm.admin_option OR rm.inherit_option OR NOT rm.set_option
    UNION ALL
    -- pg_auth_members 的键是 (roleid, member, grantor)：同一条 canonical 边可以
    -- 由**两个不同 grantor** 各存在一行。逐 pair 计数因此是必要的——只检查
    -- 「这条边在不在」会把重复边当成正常。
    SELECT 9, 'membership',
           'role membership ' || rm.member_name || ' in ' || rm.granted_name
             || ' is recorded ' || count(*)::text || ' time(s) by grantor(s) '
             || pg_catalog.string_agg(rm.grantor_name, ','
                                      ORDER BY rm.grantor_name COLLATE "C")
             || '; run the cluster role baseline first'
      FROM role_membership rm
      JOIN canonical_membership cm ON cm.member_name = rm.member_name
                                  AND cm.granted_name = rm.granted_name
     GROUP BY rm.member_name, rm.granted_name
    HAVING count(*) <> 1
    UNION ALL
    -- 图的**总数**也必须精确：多一条越界边、少一条 canonical 边都在这里现形。
    SELECT 9, 'membership',
           'the project role membership graph has ' || graph.total::text
             || ' edge(s), expected exactly ' || graph.expected::text
             || '; run the cluster role baseline first'
      FROM (SELECT (SELECT count(*) FROM role_membership rm
                     WHERE EXISTS (SELECT 1 FROM project_role pr
                                    WHERE pr.role_name = rm.granted_name)
                        OR EXISTS (SELECT 1 FROM project_role pr
                                    WHERE pr.role_name = rm.member_name))
                     AS total,
                   (SELECT count(*) FROM canonical_membership) AS expected)
             AS graph
     WHERE graph.total <> graph.expected
    UNION ALL
    -- 继承而来的越权：ACL 阶段不改 membership，因此这一类只能 fail closed。
    SELECT 10, 'effective',
           'role ' || ie.role_name || ' reaches ' || ie.objkey::text
             || ' with ' || ie.privilege
             || ' through role membership rather than through a grant; the '
             || 'database ACL phase never changes membership - run the cluster '
             || 'role baseline first'
      FROM inherited_effective ie
  )
  SELECT (SELECT count(*) FROM preflight_problem)::integer,
         (SELECT pg_catalog.string_agg(pg_catalog.left(entry, 400), '; '
                                       ORDER BY rank, entry COLLATE "C")
            FROM (SELECT rank, entry FROM preflight_problem
                   ORDER BY rank, entry COLLATE "C" LIMIT 8) AS capped)
    INTO problem_count, problem_detail;

  IF problem_count > 0 THEN
    RAISE EXCEPTION
      'authorization preflight failed for state % (% problem(s), manifest '
      'version 2): %',
      state_key, problem_count,
      problem_detail
        || CASE WHEN problem_count > 8 THEN '; ...' ELSE '' END;
  END IF;

  -- 2. 策略比对。三层同时看：完整元组的直接授权、default privilege 的物理行与
  --    有效叠加、has_*_privilege 的有效权限。
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
  -- 受监管对象的**统一枚举**。identity、分类、owner、DDL 目标、原始 ACL 与
  -- acldefault 的 objtype 都在这里一次性确定，下游的 acl_source 与
  -- managed_object 都从它派生，不再各自重复扫描 catalog。
  --   * acl_default_objtype 为 NULL 表示该类没有内建默认 ACL（只有列级如此：
  --     attacl IS NULL 就是「没有列级授权」，不能 COALESCE 成内建默认）。
  --   * 数组类型不在此枚举内：PostgreSQL 直接拒绝对数组类型授权与改属，
  --     它们只在 type_class 里记录「向元素类型委托」。
  regulated_object (objkey, object_class, owner_name, owner_oid, target_sql,
                    colname, acl, acl_default_objtype) AS (
    SELECT jsonb_build_array('database', '<current>'), 'database'::text,
           pg_catalog.pg_get_userbyid(d.datdba)::text, d.datdba,
           ('DATABASE ' || quote_ident(current_database()))::text, NULL::text,
           d.datacl, 'd'::"char"
      FROM pg_catalog.pg_database d WHERE d.datname = current_database()
    UNION ALL
    SELECT jsonb_build_array('schema', n.nspname), 'schema',
           pg_catalog.pg_get_userbyid(n.nspowner), n.nspowner,
           'SCHEMA ' || quote_ident(n.nspname), NULL,
           n.nspacl, 'n'
      FROM managed_schema n
    UNION ALL
    SELECT jsonb_build_array('relation', n.nspname, c.relname), 'relation',
           pg_catalog.pg_get_userbyid(c.relowner), c.relowner,
           CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END
             || quote_ident(n.nspname) || '.' || quote_ident(c.relname), NULL,
           c.relacl,
           CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char"
      FROM pg_catalog.pg_class c
      JOIN managed_schema n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT jsonb_build_array('column', n.nspname, c.relname, a.attname),
           'column', pg_catalog.pg_get_userbyid(c.relowner), c.relowner,
           'TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
           a.attname::text,
           a.attacl, NULL
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN managed_schema n ON n.oid = c.relnamespace
     WHERE a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT jsonb_build_array('routine', n.nspname, p.proname,
                     COALESCE((SELECT jsonb_agg(jsonb_build_array(atn.nspname, at.typname)
                                ORDER BY argument.ordinality)
               FROM unnest(p.proargtypes) WITH ORDINALITY
                      AS argument(type_oid, ordinality)
               JOIN pg_catalog.pg_type at ON at.oid = argument.type_oid
               JOIN pg_catalog.pg_namespace atn ON atn.oid = at.typnamespace),
            '[]'::jsonb)), 'routine',
           pg_catalog.pg_get_userbyid(p.proowner), p.proowner,
           'ROUTINE ' || quote_ident(n.nspname) || '.'
             || quote_ident(p.proname) || '('
             || pg_catalog.pg_get_function_identity_arguments(p.oid)
             || ')', NULL,
           p.proacl, 'f'
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace
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
            '[]'::jsonb)), 'denied-routine',
           pg_catalog.pg_get_userbyid(lp.proowner), lp.proowner,
           'ROUTINE ' || quote_ident(lpn.nspname) || '.'
             || quote_ident(lp.proname) || '('
             || pg_catalog.pg_get_function_identity_arguments(lp.oid)
             || ')', NULL,
           lp.proacl, 'f'
      FROM denied_routine dr
      JOIN pg_catalog.pg_proc lp ON lp.oid = dr.oid
      JOIN pg_catalog.pg_namespace lpn ON lpn.oid = lp.pronamespace
    UNION ALL
    SELECT jsonb_build_array('type', n.nspname, t.typname), 'type',
           pg_catalog.pg_get_userbyid(t.typowner), t.typowner,
           'TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname),
           NULL,
           t.typacl, 'T'
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace
     WHERE NOT (t.typcategory = 'A' AND t.typelem <> 0)
    UNION ALL
    -- language 的隐式 ACL。PostgreSQL 18.4 实测：acldefault 对**受信与非受信
    -- 语言完全相同**，都是 {=U/owner, owner=U/owner}——非受信语言的限制在建函数
    -- 时按 superuser 判定，不体现在 ACL 上，因此 has_language_privilege 对任意
    -- 角色、非受信语言同样返回 true。
    -- 所以这里**不能**按 lanpltrusted 过滤：那会让 raw 说「没人有 USAGE」而
    -- effective 说「所有人都有」，两层自相矛盾。
    SELECT jsonb_build_array('language', l.lanname), 'language',
           pg_catalog.pg_get_userbyid(l.lanowner), l.lanowner,
           'LANGUAGE ' || quote_ident(l.lanname), NULL,
           l.lanacl, 'l'
      FROM pg_catalog.pg_language l
    UNION ALL
    SELECT jsonb_build_array('largeobject', m.oid::text), 'largeobject',
           pg_catalog.pg_get_userbyid(m.lomowner), m.lomowner,
           NULL, NULL,
           m.lomacl, 'L'
      FROM pg_catalog.pg_largeobject_metadata m
  ),
  -- 可以直接作为授权语句目标的对象。列级授权要经由父表加列名，Large Object
  -- 一律 fail closed 不参与 mutation，入口点只允许 owner 自身，因此三者都不在
  -- 这里。（本文件仍是纯 SELECT：这里只是把执行目标文本采集成事实。）
  managed_object (objkey, object_class, owner_name, target_sql) AS (
    SELECT objkey, object_class, owner_name, target_sql
      FROM regulated_object
     WHERE object_class IN ('database', 'schema', 'relation', 'routine',
                            'type', 'language')
  ),
  acl_source (objkey, object_class, owner_name, target_sql, colname,
              grantee, grantor, privilege, grantable) AS (
    SELECT o.objkey, o.object_class, o.owner_name, o.target_sql, o.colname,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM regulated_object o,
           aclexplode(
             CASE WHEN o.acl_default_objtype IS NULL THEN o.acl
                  ELSE COALESCE(o.acl,
                                acldefault(o.acl_default_objtype, o.owner_oid))
             END) AS acl
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
  -- 保证 base 永远不会拿 defaclobjtype 直接去调 acldefault；ddl_keyword 同源，
  -- 收敛阶段不必再从 identity 里反解 objtype。
  default_objtype (objtype, acldefault_objtype, schema_scoped, ddl_keyword) AS (
    VALUES
      ('L'::text, 'L'::text, false::boolean, 'LARGE OBJECTS'::text),
      ('S', 's', true, 'SEQUENCES'),
      ('T', 'T', true, 'TYPES'),
      ('f', 'f', true, 'FUNCTIONS'),
      ('n', 'n', false, 'SCHEMAS'),
      ('r', 'r', true, 'TABLES')
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
  owner_source (objkey, object_class, owner_name) AS (
    SELECT jsonb_build_array('database', '<current>'), 'database'::text,
           pg_catalog.pg_get_userbyid(d.datdba)::text
      FROM pg_catalog.pg_database d WHERE d.datname = current_database()
    UNION ALL
    SELECT jsonb_build_array('schema', n.nspname), 'schema',
           pg_catalog.pg_get_userbyid(n.nspowner)::text
      FROM managed_schema n
    UNION ALL
    SELECT jsonb_build_array('relation', n.nspname, c.relname), 'relation',
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
            '[]'::jsonb)), 'routine',
           pg_catalog.pg_get_userbyid(p.proowner)::text
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace
    UNION ALL
    SELECT jsonb_build_array('type', n.nspname, t.typname), 'type',
           pg_catalog.pg_get_userbyid(t.typowner)::text
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace
    UNION ALL
    SELECT jsonb_build_array('largeobject', m.oid::text), 'largeobject',
           pg_catalog.pg_get_userbyid(m.lomowner)::text
      FROM pg_catalog.pg_largeobject_metadata m
  ),
  -- 有效权限。privileges 是**排序后的数组**而不是拼接串：策略层需要做子集判定
  -- （列级有效权限必须是同表表级有效权限的子集），拼接串只能靠再切一次字符串。
  -- 对外三列投影里再 array_to_string 成原来的 'privs=A,B' 形态，语义不变。
  effective_source (objkey, object_class, role_name, privileges) AS (
    SELECT jsonb_build_array('database', '<current>'), 'database'::text, pr.role_name,
           (SELECT array_agg(p ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p
             WHERE has_database_privilege(pr.probe_name, current_database(), p))
      FROM probe_role pr
    UNION ALL
    SELECT jsonb_build_array('schema', n.nspname), 'schema', pr.role_name,
           (SELECT array_agg(p ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['CREATE', 'USAGE']) AS p
             WHERE has_schema_privilege(pr.probe_name, n.oid, p))
      FROM managed_schema n, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('relation', n.nspname, c.relname), 'relation',
           pr.role_name,
           CASE WHEN c.relkind = 'S' THEN
             (SELECT array_agg(p ORDER BY p COLLATE "C")
                FROM unnest(ARRAY['SELECT', 'UPDATE', 'USAGE']) AS p
               WHERE has_sequence_privilege(pr.probe_name, c.oid, p))
           ELSE
             (SELECT array_agg(p ORDER BY p COLLATE "C")
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
           'column', pr.role_name,
           (SELECT array_agg(p ORDER BY p COLLATE "C")
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
            '[]'::jsonb)), 'routine', pr.role_name,
           CASE WHEN has_function_privilege(pr.probe_name, p.oid, 'EXECUTE')
                THEN ARRAY['EXECUTE'] ELSE NULL END
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
            '[]'::jsonb)), 'denied-routine', pr.role_name,
           CASE WHEN has_function_privilege(pr.probe_name, lp.oid, 'EXECUTE')
                THEN ARRAY['EXECUTE'] ELSE NULL END
      FROM denied_routine dr
      JOIN pg_catalog.pg_proc lp ON lp.oid = dr.oid
      JOIN pg_catalog.pg_namespace lpn ON lpn.oid = lp.pronamespace, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('type', n.nspname, t.typname), 'type', pr.role_name,
           CASE WHEN has_type_privilege(pr.probe_name, t.oid, 'USAGE')
                THEN ARRAY['USAGE'] ELSE NULL END
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('language', l.lanname), 'language', pr.role_name,
           CASE WHEN has_language_privilege(pr.probe_name, l.oid, 'USAGE')
                THEN ARRAY['USAGE'] ELSE NULL END
      FROM pg_catalog.pg_language l, probe_role pr
    UNION ALL
    SELECT jsonb_build_array('largeobject', m.oid::text), 'largeobject',
           pr.role_name,
           (SELECT array_agg(p ORDER BY p COLLATE "C")
              FROM unnest(ARRAY['SELECT', 'UPDATE']) AS p
             WHERE has_largeobject_privilege(pr.probe_name, m.oid, p))
      FROM pg_catalog.pg_largeobject_metadata m, probe_role pr
  ),
  -- 受控 routine 的精确指纹：identity + owner + SECURITY DEFINER + proconfig
  -- + 正文摘要。执行授权只是一半，另一半是「以谁的身份、带什么
  -- search_path / row_security、跑的是不是原来那份正文」。
  routine_fingerprint (objkey, owner_name, security_definer, config,
                       body_digest) AS (
    SELECT jsonb_build_array('routine', n.nspname, p.proname,
                     COALESCE((SELECT jsonb_agg(jsonb_build_array(atn.nspname, at.typname)
                                ORDER BY argument.ordinality)
               FROM unnest(p.proargtypes) WITH ORDINALITY
                      AS argument(type_oid, ordinality)
               JOIN pg_catalog.pg_type at ON at.oid = argument.type_oid
               JOIN pg_catalog.pg_namespace atn ON atn.oid = at.typnamespace),
            '[]'::jsonb)),
           pg_catalog.pg_get_userbyid(p.proowner)::text,
           p.prosecdef,
           -- proconfig 用结构化 JSON 数组：设置值本身可以含分隔符，拼接串
           -- 在那一刻就不可反解也不可比较。Node 侧用同一份 identity 编码。
           COALESCE(to_jsonb(p.proconfig), '[]'::jsonb)::text,
           pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')::text
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace
  ),
  -- 角色成员图。database scope **不修改** membership，只观察：由继承造成、
  -- 无法靠 ACL mutation 修复的 effective 漂移必须 fail closed 并指向
  -- cluster role baseline。这里是纯事实，不含任何允许集合。
  role_membership (member_name, granted_name, grantor_name, admin_option,
                   inherit_option, set_option) AS (
    SELECT m.rolname::text, g.rolname::text, gr.rolname::text,
           a.admin_option, a.inherit_option, a.set_option
      FROM pg_catalog.pg_auth_members a
      JOIN pg_catalog.pg_roles m ON m.oid = a.member
      JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
      JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantor
  ),
  -- 类型分类：managed 非数组类型的 PUBLIC/app/backup/三个 login 默认无 USAGE，
  -- owner（migrator）保留必要权限；数组类型只记录委托关系，既不建立也不尝试
  -- 撤销独立 ACL（PostgreSQL 对数组类型直接拒绝授权与改属操作）。
  type_class (objkey, class_name, detail) AS (
    SELECT jsonb_build_array('type', n.nspname, t.typname),
           CASE
             WHEN t.typcategory = 'A' AND t.typelem <> 0 THEN 'array'
             WHEN t.typtype = 'c' AND EXISTS (
                    SELECT 1 FROM pg_catalog.pg_class rc
                     WHERE rc.oid = t.typrelid AND rc.relkind <> 'c')
               THEN 'row'
             ELSE 'element'
           END,
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
  ),
  large_object (objkey, loid, owner_name) AS (
    SELECT jsonb_build_array('largeobject', m.oid::text), m.oid,
           pg_catalog.pg_get_userbyid(m.lomowner)::text
      FROM pg_catalog.pg_largeobject_metadata m
  ),
  -- 固定项目主体。**只**用于固定允许权限、角色存在性，以及区分项目角色与
  -- 动态发现的外部角色；绝不用来过滤 catalog 里的 grantee 或 grantor。
  principal (role_name) AS (
    SELECT unnest(ARRAY['PUBLIC', 'meal_agent_app', 'meal_agent_backup', 'meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_runtime_login']::text[])
  ),
  project_role (role_name) AS (
    SELECT unnest(ARRAY['meal_agent_app', 'meal_agent_backup', 'meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_migrator', 'meal_agent_runtime_login']::text[])
  ),
  project_login (role_name) AS (
    SELECT unnest(ARRAY['meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_runtime_login']::text[])
  ),
  -- canonical membership 图。database scope 绝不修改 membership：这里只用于判断
  -- 「有效权限漂移是不是继承造成的」，是就 fail closed 并要求先跑 cluster role
  -- baseline。
  canonical_membership (member_name, granted_name) AS (
      VALUES
        ('meal_agent_backup_login'::text, 'meal_agent_backup'::text),
        ('meal_agent_migration_login', 'meal_agent_migrator'),
        ('meal_agent_runtime_login', 'meal_agent_app')
  ),
  -- 固定允许的直接授权。canonical grantor 恒为 meal_agent_migrator。
  allowed_grants (state, objkey, grantee, privilege) AS (
      VALUES
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]'::text, '["database", "<current>"]'::jsonb, 'meal_agent_backup_login'::text, 'CONNECT'::text),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_migration_login', 'CONNECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_runtime_login', 'CONNECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "meal_agent_private"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "public"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "public"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_backup_login', 'CONNECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_migration_login', 'CONNECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_runtime_login', 'CONNECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "meal_agent_private"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "public"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "public"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_backup_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_migration_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_runtime_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "meal_agent_private"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "public"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "public"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_backup_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_migration_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_runtime_login', 'CONNECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'INSERT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', 'UPDATE'),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_backup', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "meal_agent_private"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "public"]', 'meal_agent_app', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "public"]', 'meal_agent_backup', 'USAGE')
  ),
  -- 固定允许的**有效**权限，只覆盖四类对象 × 项目主体。
  allowed_effective (state, objkey, role_name, privileges) AS (
      VALUES
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]'::text, '["database", "<current>"]'::jsonb, 'meal_agent_backup_login'::text, ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_migration_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_runtime_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "household_invites"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "meal_agent_private"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "public"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["schema", "public"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_backup_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_migration_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["database", "<current>"]', 'meal_agent_runtime_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "household_invites"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profile_link_requests"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "meal_agent_private"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "public"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["schema", "public"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_backup_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_migration_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["database", "<current>"]', 'meal_agent_runtime_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "households"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "memberships"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "sessions"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["relation", "public", "users"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "drizzle"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "meal_agent_private"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "public"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', '["schema", "public"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_backup_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_migration_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["database", "<current>"]', 'meal_agent_runtime_login', ARRAY['CONNECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_app', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "drizzle", "__meal_agent_migrations"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "auth_identities"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "households"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "idempotency_records"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_events"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "inventory_lots"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "memberships"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "person_profiles"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "sessions"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_app', ARRAY['INSERT', 'SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["relation", "public", "users"]', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'meal_agent_app', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "drizzle"]', 'meal_agent_backup', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "meal_agent_private"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "public"]', 'meal_agent_app', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', '["schema", "public"]', 'meal_agent_backup', ARRAY['USAGE']::text[])
  ),
  -- 固定允许的 pg_default_acl **物理行**条目：它决定要执行哪条默认权限语句。
  allowed_default (state, objtype, scope, grantee, privilege) AS (
      VALUES
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]'::text, 'T'::text, '-'::text, 'meal_agent_migrator'::text, 'USAGE'::text),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'f', '-', 'meal_agent_migrator', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', 'public', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'T', '-', 'meal_agent_migrator', 'USAGE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'f', '-', 'meal_agent_migrator', 'EXECUTE'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'drizzle', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'public', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "containment"]', 'T', '-', 'meal_agent_migrator', 'USAGE'),
        ('[["0000_stage_06.sql"], "containment"]', 'f', '-', 'meal_agent_migrator', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', 'S', 'public', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', 'T', '-', 'meal_agent_migrator', 'USAGE'),
        ('[["0000_stage_06.sql"], "final"]', 'f', '-', 'meal_agent_migrator', 'EXECUTE'),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'drizzle', 'meal_agent_backup', 'SELECT'),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'public', 'meal_agent_backup', 'SELECT')
  ),
  -- 叠加之后的**有效**默认权限，只用于最终语义验证。
  allowed_default_effective (state, objtype, scope, grantee, privileges) AS (
      VALUES
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]'::text, 'L'::text, '-'::text, 'meal_agent_migrator'::text, ARRAY['SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'S', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'S', 'drizzle', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'S', 'meal_agent_private', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'S', 'public', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'T', '-', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'T', 'drizzle', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'T', 'meal_agent_private', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'T', 'public', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'f', '-', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'f', 'drizzle', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'f', 'meal_agent_private', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'f', 'public', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'n', '-', 'meal_agent_migrator', ARRAY['CREATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'r', '-', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'r', 'drizzle', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'r', 'meal_agent_private', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', 'r', 'public', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'L', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', 'drizzle', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', 'meal_agent_private', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', 'public', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'S', 'public', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'T', '-', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'T', 'drizzle', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'T', 'meal_agent_private', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'T', 'public', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'f', '-', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'f', 'drizzle', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'f', 'meal_agent_private', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'f', 'public', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'n', '-', 'meal_agent_migrator', ARRAY['CREATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', '-', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'drizzle', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'drizzle', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'meal_agent_private', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'public', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', 'r', 'public', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'L', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'S', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'S', 'drizzle', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'S', 'meal_agent_private', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'S', 'public', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'T', '-', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'T', 'drizzle', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'T', 'meal_agent_private', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'T', 'public', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'f', '-', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'f', 'drizzle', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'f', 'meal_agent_private', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'f', 'public', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'n', '-', 'meal_agent_migrator', ARRAY['CREATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'r', '-', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'r', 'drizzle', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'r', 'meal_agent_private', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "containment"]', 'r', 'public', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'L', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'S', '-', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'S', 'drizzle', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'S', 'meal_agent_private', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'S', 'public', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'S', 'public', 'meal_agent_migrator', ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'T', '-', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'T', 'drizzle', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'T', 'meal_agent_private', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'T', 'public', 'meal_agent_migrator', ARRAY['USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'f', '-', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'f', 'drizzle', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'f', 'meal_agent_private', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'f', 'public', 'meal_agent_migrator', ARRAY['EXECUTE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'n', '-', 'meal_agent_migrator', ARRAY['CREATE', 'USAGE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', '-', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'drizzle', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'drizzle', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'meal_agent_private', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'public', 'meal_agent_backup', ARRAY['SELECT']::text[]),
        ('[["0000_stage_06.sql"], "final"]', 'r', 'public', 'meal_agent_migrator', ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']::text[])
  ),
  -- 受控 routine 的允许指纹。managed schema 里出现任何未登记的 routine 一律
  -- fail closed——恢复路径可以把任意 SECURITY DEFINER 函数带进 drizzle。
  allowed_routine (state, objkey, detail) AS (
      VALUES
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]'::text, '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]'::jsonb, 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=8b3b8383eaafef2859c7c6c400fea4560397e2e791398f34eb3d92c983b84d19'::text),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=d8bd3080b2b718d97dd351aa88cabb64d887a05f70188c42875bd93598455ff4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=340b7dafbb3538c8f7be9b75680eee66ac11d95cb7bb63c7eacecc1f0dd181b4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=2f6eaefdd9503cc95274b27a06bd2c026510ccef5b7d5ee1e39c493856a12b1c'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=49c69edb63ba9c79f1cebedfa662a79008307ef7ff58c654b90b3fa0a5f5802d'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=8a6ca11f5b63ddd757d2ab4ee55bd6d8eeafa0b86109e48d57804f7beb983d56'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=9f114cec5f9c266b441cb4225ca188bd3069bbcc80b2dbb7d066725a3e3013b2'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=bda888f524207ddd8ecb1875ed75cff298b4c8e57d27e869370f55cf92702e2a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'owner=meal_agent_migrator secdef=f config=["search_path=pg_catalog, public"] body=aaee625351184de80262214f2f0b048e1941afac9200ffd5c54b8956c71f250a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=73fd5f37faf85bef8803c3902375365d9f3d2eb5ced6d318813a911864b35df4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5dabf7d1671c857717fd8a18d72ea7961ab6f582965f6177dcdb697d2f14988c'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "containment"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=44e6d5df0e195097d4a782ae2b4a0fd6e9eb6e2e74d570910ab075e804af1cc9'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "add_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"], ["pg_catalog", "jsonb"], ["pg_catalog", "bool"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=8b3b8383eaafef2859c7c6c400fea4560397e2e791398f34eb3d92c983b84d19'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "confirm_person_profile_link", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=d8bd3080b2b718d97dd351aa88cabb64d887a05f70188c42875bd93598455ff4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "create_person_profile_link_request", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=340b7dafbb3538c8f7be9b75680eee66ac11d95cb7bb63c7eacecc1f0dd181b4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_active_owner", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=2f6eaefdd9503cc95274b27a06bd2c026510ccef5b7d5ee1e39c493856a12b1c'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "materialize_person_profile_link_requests", [["pg_catalog", "uuid"], ["pg_catalog", "uuid"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=49c69edb63ba9c79f1cebedfa662a79008307ef7ff58c654b90b3fa0a5f5802d'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "owns_profile", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=8a6ca11f5b63ddd757d2ab4ee55bd6d8eeafa0b86109e48d57804f7beb983d56'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "redeem_household_invite", [["pg_catalog", "bpchar"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=9f114cec5f9c266b441cb4225ca188bd3069bbcc80b2dbb7d066725a3e3013b2'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "remove_person_profile_constraint", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=bda888f524207ddd8ecb1875ed75cff298b4c8e57d27e869370f55cf92702e2a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "stage08_constraints_are_safe", [["pg_catalog", "jsonb"]]]', 'owner=meal_agent_migrator secdef=f config=["search_path=pg_catalog, public"] body=aaee625351184de80262214f2f0b048e1941afac9200ffd5c54b8956c71f250a'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_membership_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=73fd5f37faf85bef8803c3902375365d9f3d2eb5ced6d318813a911864b35df4'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "transition_person_profile_status", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "text"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5dabf7d1671c857717fd8a18d72ea7961ab6f582965f6177dcdb697d2f14988c'),
        ('[["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"], "final"]', '["routine", "meal_agent_private", "update_person_profile_fields", [["pg_catalog", "uuid"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "text"], ["pg_catalog", "bool"], ["pg_catalog", "int4"], ["pg_catalog", "bool"], ["pg_catalog", "numeric"], ["pg_catalog", "bool"], ["pg_catalog", "text"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=44e6d5df0e195097d4a782ae2b4a0fd6e9eb6e2e74d570910ab075e804af1cc9'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_household_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "app_user_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
        ('[["0000_stage_06.sql"], "containment"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_household_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "app_user_id", []]', 'owner=meal_agent_migrator secdef=f config=[] body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "has_active_membership", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
        ('[["0000_stage_06.sql"], "final"]', '["routine", "meal_agent_private", "is_household_creator", [["pg_catalog", "uuid"]]]', 'owner=meal_agent_migrator secdef=t config=["search_path=pg_catalog, public", "row_security=off"] body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a')
  ),
  -- 直接授权的策略判定。privilege_allowed **不含** grantable 判断：一条本身允许、
  -- 只是多带了可再授予标志的授权只应收回该标志，而不是把 owner 自己的权限
  -- 一并撤掉。
  acl_verdict (objkey, object_class, owner_name, target_sql, colname, grantee,
               grantor, privilege, grantable, privilege_allowed) AS (
    SELECT a.objkey, a.object_class, a.owner_name, a.target_sql, a.colname,
           a.grantee, a.grantor, a.privilege, a.grantable,
           CASE
             -- 列级：当前没有任何允许项，任何列 ACL 都是漂移。
             WHEN a.object_class = 'column' THEN false
             -- Large Object：产品声明禁用，任意对象都在 mutation 之前 fail
             -- closed；这里同样不给任何允许项。
             WHEN a.object_class = 'largeobject' THEN false
             -- 对象 owner 自身：NULL ACL 展开出来的内建默认，以及 owner 对自己
             -- 对象的固有权限。managed 非数组 type 只靠这一条放行。
             WHEN a.grantee = a.owner_name AND a.grantor = a.owner_name
               THEN true
             -- language：PostgreSQL 内建的 owner 与 PUBLIC USAGE。显式外部授权、
             -- 错误 grantor 与可再授予标志都落不到这一条上。
             WHEN a.object_class = 'language' AND a.grantee = 'PUBLIC'
                  AND a.grantor = a.owner_name AND a.privilege = 'USAGE'
               THEN true
             -- 固定允许项：canonical grantor 必须是 meal_agent_migrator。
             WHEN a.object_class IN ('database', 'schema', 'relation', 'routine')
                  AND a.grantor = 'meal_agent_migrator'
               THEN EXISTS (SELECT 1 FROM allowed_grants g
                             WHERE g.state = state_key
                               AND g.objkey = a.objkey
                               AND g.grantee = a.grantee
                               AND g.privilege = a.privilege)
             ELSE false
           END
      FROM acl_source a
  ),
  -- 默认权限物理行的策略判定，同样把可再授予标志与「条目本身允许」分开。
  default_verdict (scope_kind, defaclrole, objtype, scope, grantee, grantor,
                   privilege, grantable, ddl_keyword, privilege_allowed) AS (
    SELECT r.scope_kind, r.defaclrole, r.objtype, r.scope, r.grantee, r.grantor,
           r.privilege, r.grantable, t.ddl_keyword,
           r.defaclrole = 'meal_agent_migrator'
             AND r.grantor = 'meal_agent_migrator'
             AND EXISTS (SELECT 1 FROM allowed_default ad
                          WHERE ad.state = state_key
                            AND ad.objtype = r.objtype
                            AND ad.scope = r.scope
                            AND ad.grantee = r.grantee
                            AND ad.privilege = r.privilege)
      FROM default_raw r
      LEFT JOIN default_objtype t ON t.objtype = r.objtype
  ),
  -- 默认权限语句的**起算点**（PostgreSQL 18.4 实测，与 R8A 固化的叠加语义
  -- 同源）：global 形式从内建 acldefault 起算，schema 形式从空起算。
  -- 因此一个「内容是内建默认真子集」的 global 行，只能靠**撤销**才能得到——
  -- 只补授缺失项永远造不出它，而且补授的结果恰好等于内建默认时 PostgreSQL 会
  -- 直接把行删掉。
  default_baseline (defaclrole, objtype, scope, grantee, grantor, privilege,
                    grantable) AS (
    SELECT sl.defaclrole, sl.objtype, sl.scope,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
           pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM default_slot sl,
           aclexplode(acldefault(sl.acldefault_objtype::"char",
                                 sl.owner_oid)) AS acl
     WHERE sl.scope = '-'
  ),
  -- 默认权限语句**当前看到的**内容：有物理行就是行里的内容（哪怕是空行），
  -- 没有物理行时 global 落回内建默认、schema 落回空。
  default_current (defaclrole, objtype, scope, scope_kind, grantee, grantor,
                   privilege, grantable) AS (
    SELECT r.defaclrole, r.objtype, r.scope, r.scope_kind, r.grantee, r.grantor,
           r.privilege, r.grantable
      FROM default_raw r
    UNION ALL
    SELECT b.defaclrole, b.objtype, b.scope, 'global', b.grantee, b.grantor,
           b.privilege, b.grantable
      FROM default_baseline b
     WHERE NOT EXISTS (SELECT 1 FROM default_row g
                        WHERE g.defaclrole = b.defaclrole
                          AND g.objtype = b.objtype
                          AND g.scope_kind = 'global')
  ),
  -- 目标内容。有登记项的槽位：目标就是登记项；没有登记项的槽位：目标是「没有
  -- 物理行」，也就是回落到起算点。后者对 schema 槽位是空集，对 global 槽位是
  -- 内建默认——正是这一条让「没登记 = 不动内建默认」成立。
  default_target (defaclrole, objtype, scope, scope_kind, grantee, grantor,
                  privilege, grantable) AS (
    SELECT 'meal_agent_migrator', ad.objtype, ad.scope,
           CASE WHEN ad.scope = '-' THEN 'global' ELSE 'schema' END,
           ad.grantee, 'meal_agent_migrator', ad.privilege, false
      FROM allowed_default ad
     WHERE ad.state = state_key
    UNION ALL
    SELECT b.defaclrole, b.objtype, b.scope, 'global', b.grantee, b.grantor,
           b.privilege, b.grantable
      FROM default_baseline b
     WHERE b.defaclrole = 'meal_agent_migrator'
       AND NOT EXISTS (SELECT 1 FROM allowed_default ad
                        WHERE ad.state = state_key
                          AND ad.objtype = b.objtype
                          AND ad.scope = b.scope)
  ),
  -- language 的**必需**授权：PostgreSQL 内建默认给出 owner 与 PUBLIC 的
  -- USAGE，两条都是运行所需（plpgsql 没有 PUBLIC USAGE 时，任何非 owner 角色
  -- 都无法执行 plpgsql 函数）。它们是动态登记的——owner 从 catalog 现取，
  -- 不写死角色名——因此缺失时 verify 拒绝、converge 以 language owner 的身份
  -- 恢复。
  required_language_grants (objkey, target_sql, owner_name, grantee,
                           privilege) AS (
    SELECT o.objkey, o.target_sql, o.owner_name, required.grantee, 'USAGE'::text
      FROM regulated_object o,
           LATERAL (VALUES ('PUBLIC'::text), (o.owner_name)) AS required(grantee)
     WHERE o.object_class = 'language'
  ),
  effective_actual (objkey, object_class, role_name, privileges) AS (
    SELECT objkey, object_class, role_name, privileges
      FROM effective_source
     WHERE privileges IS NOT NULL
  ),
  -- 受精确验证的有效权限面：四类对象 × 非 owner 主体。owner 的有效权限来自
  -- 归属，由 owner 前置条件单独验证，不在这里逐条冻结。
  effective_regulated (objkey, role_name, privileges) AS (
    SELECT objkey, role_name, privileges
      FROM effective_actual
     WHERE object_class IN ('database', 'schema', 'relation', 'routine')
       AND role_name <> 'meal_agent_migrator'
  ),
  -- **继承而来**的有效权限：既没有授予 PUBLIC、也没有授予该角色自己，却仍然
  -- 探测得到——只可能来自角色成员关系（外部 NOLOGIN、项目角色，或 pg_read_all_data
  -- 之类的 predefined role）。ACL 阶段按设计**不修改 membership**，因此这一类
  -- 越权不可能靠 ACL mutation 修好，必须在任何 mutation 之前 fail closed。
  -- 数组类型除外：它们没有独立 ACL，有效权限完全委托给元素类型，而元素类型
  -- 本身在 acl_source 里。
  inherited_effective (objkey, object_class, role_name, privilege) AS (
    SELECT e.objkey, e.object_class, e.role_name, granted.privilege
      FROM effective_actual e,
           LATERAL unnest(e.privileges) AS granted(privilege)
     WHERE e.object_class IN ('database', 'schema', 'relation', 'routine',
                              'type', 'denied-routine', 'largeobject')
       AND NOT EXISTS (SELECT 1 FROM type_class tc
                        WHERE tc.objkey = e.objkey AND tc.class_name = 'array')
       AND NOT EXISTS (SELECT 1 FROM acl_source a
                        WHERE a.objkey = e.objkey
                          AND a.privilege = granted.privilege
                          AND (a.grantee = 'PUBLIC'
                               OR a.grantee = e.role_name))
  ),
  default_effective_actual (objtype, scope, grantee, privileges, grantable) AS (
    SELECT objtype, scope, grantee,
           array_agg(privilege ORDER BY privilege COLLATE "C"),
           bool_or(grantable)
      FROM default_effective
     WHERE defaclrole = 'meal_agent_migrator'
     GROUP BY objtype, scope, grantee
  ),
  divergence_rows (rank, kind, entry) AS (
    -- 有效权限：项目主体逐条精确匹配；外部角色在受监管四类对象上必须为空。
    SELECT 1, 'effective'::text,
           'unexpected effective ' || jsonb_build_array(e.objkey, e.role_name)::text
             || ' [privs=' || array_to_string(e.privileges, ',') || ']'
      FROM effective_regulated e
      LEFT JOIN allowed_effective a
        ON a.state = state_key AND a.objkey = e.objkey
       AND a.role_name = e.role_name
     WHERE a.objkey IS NULL
    UNION ALL
    SELECT 1, 'effective',
           'missing effective ' || jsonb_build_array(a.objkey, a.role_name)::text
             || ' [expected privs=' || array_to_string(a.privileges, ',') || ']'
      FROM allowed_effective a
      LEFT JOIN effective_regulated e
        ON e.objkey = a.objkey AND e.role_name = a.role_name
     WHERE a.state = state_key AND e.objkey IS NULL
    UNION ALL
    SELECT 1, 'effective',
           'drifted effective ' || jsonb_build_array(a.objkey, a.role_name)::text
             || ' [expected privs=' || array_to_string(a.privileges, ',')
             || '] [found privs=' || array_to_string(e.privileges, ',') || ']'
      FROM allowed_effective a
      JOIN effective_regulated e
        ON e.objkey = a.objkey AND e.role_name = a.role_name
     WHERE a.state = state_key AND e.privileges IS DISTINCT FROM a.privileges
    UNION ALL
    -- language：PostgreSQL 的内建默认让每个探测主体恰好有 USAGE。多一点少一点
    -- 都说明有人显式动过 lanacl。
    SELECT 1, 'effective',
           'unexpected language privileges '
             || jsonb_build_array(e.objkey, e.role_name)::text
             || ' [privs=' || array_to_string(e.privileges, ',') || ']'
      FROM effective_actual e
     WHERE e.object_class = 'language'
       AND e.privileges IS DISTINCT FROM ARRAY['USAGE']
    UNION ALL
    -- 类型、20 个 Large Object 入口点与 Large Object 本身：除对象 owner 之外
    -- 任何主体都不得有效到达。
    SELECT 1, 'effective',
           'unexpected effective ' || jsonb_build_array(e.objkey, e.role_name)::text
             || ' [privs=' || array_to_string(e.privileges, ',') || ']'
      FROM effective_actual e
     WHERE e.object_class IN ('type', 'denied-routine', 'largeobject')
       AND NOT (e.object_class = 'type' AND e.role_name = 'meal_agent_migrator')
    UNION ALL
    -- owner 必须**保留** managed 非数组类型的 USAGE：收敛只收回别人的权限。
    SELECT 1, 'effective',
           'owner lost USAGE on type ' || tc.objkey::text
      FROM type_class tc
     WHERE tc.class_name <> 'array'
       AND NOT EXISTS (SELECT 1 FROM effective_actual e
                        WHERE e.objkey = tc.objkey
                          AND e.object_class = 'type'
                          AND e.role_name = 'meal_agent_migrator'
                          AND e.privileges = ARRAY['USAGE'])
    UNION ALL
    -- 列级有效权限必须是同表表级有效权限的子集：列级授权一律不允许，出现即说明
    -- 收敛没有覆盖到列。
    SELECT 1, 'effective',
           'column privileges exceed table privileges '
             || jsonb_build_array(c.objkey, c.role_name)::text
             || ' [privs=' || array_to_string(c.privileges, ',') || ']'
      FROM effective_actual c
      LEFT JOIN effective_actual r
        ON r.object_class = 'relation' AND r.role_name = c.role_name
       AND r.objkey = jsonb_build_array('relation', c.objkey->1, c.objkey->2)
     WHERE c.object_class = 'column'
       AND NOT (c.privileges <@ COALESCE(r.privileges, ARRAY[]::text[]))
    UNION ALL
    -- 直接授权的**完整元组**：object + grantee + grantor + privilege +
    -- grantable。权限集合看起来合规但 grantor 错误、重复授权或可再授予，
    -- 都在这里现形。
    SELECT 3, 'grant',
           'unexpected grant '
             || jsonb_build_array(v.objkey, v.grantee, v.grantor,
                                  v.privilege)::text
             || ' [grantable=' || CASE WHEN v.grantable THEN 't' ELSE 'f' END
             || ']'
      FROM acl_verdict v
     WHERE NOT v.privilege_allowed
    UNION ALL
    SELECT 3, 'grant',
           'grant option on '
             || jsonb_build_array(v.objkey, v.grantee, v.grantor,
                                  v.privilege)::text
      FROM acl_verdict v
     WHERE v.privilege_allowed AND v.grantable
    UNION ALL
    SELECT 3, 'grant',
           'missing grant '
             || jsonb_build_array(g.objkey, g.grantee, 'meal_agent_migrator',
                                  g.privilege)::text
      FROM allowed_grants g
     WHERE g.state = state_key
       AND NOT EXISTS (SELECT 1 FROM acl_source s
                        WHERE s.objkey = g.objkey
                          AND s.grantee = g.grantee
                          AND s.privilege = g.privilege
                          AND s.grantor = 'meal_agent_migrator'
                          AND NOT s.grantable)
    UNION ALL
    SELECT 3, 'grant',
           'missing language grant '
             || jsonb_build_array(r.objkey, r.grantee, r.owner_name,
                                  r.privilege)::text
      FROM required_language_grants r
     WHERE NOT EXISTS (SELECT 1 FROM acl_source s
                        WHERE s.objkey = r.objkey
                          AND s.grantee = r.grantee
                          AND s.grantor = r.owner_name
                          AND s.privilege = r.privilege
                          AND NOT s.grantable)
    UNION ALL
    -- pg_default_acl 的**物理行**：它决定实际执行哪条默认权限语句。
    SELECT 4, 'default',
           'unexpected default privilege '
             || jsonb_build_array(v.defaclrole, v.objtype, v.scope, v.grantee,
                                  v.grantor, v.privilege)::text
             || ' [grantable=' || CASE WHEN v.grantable THEN 't' ELSE 'f' END
             || ']'
      FROM default_verdict v
     WHERE NOT v.privilege_allowed
    UNION ALL
    SELECT 4, 'default',
           'grant option on default privilege '
             || jsonb_build_array(v.defaclrole, v.objtype, v.scope, v.grantee,
                                  v.grantor, v.privilege)::text
      FROM default_verdict v
     WHERE v.privilege_allowed AND v.grantable
    UNION ALL
    SELECT 4, 'default',
           'missing default privilege '
             || jsonb_build_array('meal_agent_migrator', ad.objtype, ad.scope, ad.grantee,
                                  'meal_agent_migrator', ad.privilege)::text
      FROM allowed_default ad
     WHERE ad.state = state_key
       AND NOT EXISTS (SELECT 1 FROM default_raw r
                        WHERE r.defaclrole = 'meal_agent_migrator'
                          AND r.grantor = 'meal_agent_migrator'
                          AND r.objtype = ad.objtype
                          AND r.scope = ad.scope
                          AND r.grantee = ad.grantee
                          AND r.privilege = ad.privilege
                          AND NOT r.grantable)
    UNION ALL
    -- 叠加出的**有效**默认权限：只在这里做最终语义验证，绝不据此反推语句。
    SELECT 4, 'default-effective',
           'unexpected effective default privilege '
             || jsonb_build_array(da.objtype, da.scope, da.grantee)::text
             || ' [privs=' || array_to_string(da.privileges, ',')
             || ' grantable=' || CASE WHEN da.grantable THEN 't' ELSE 'f' END
             || ']'
      FROM default_effective_actual da
      LEFT JOIN allowed_default_effective ae
        ON ae.state = state_key AND ae.objtype = da.objtype
       AND ae.scope = da.scope AND ae.grantee = da.grantee
     WHERE ae.objtype IS NULL
    UNION ALL
    SELECT 4, 'default-effective',
           'missing effective default privilege '
             || jsonb_build_array(ae.objtype, ae.scope, ae.grantee)::text
             || ' [expected privs=' || array_to_string(ae.privileges, ',') || ']'
      FROM allowed_default_effective ae
      LEFT JOIN default_effective_actual da
        ON da.objtype = ae.objtype AND da.scope = ae.scope
       AND da.grantee = ae.grantee
     WHERE ae.state = state_key AND da.objtype IS NULL
    UNION ALL
    SELECT 4, 'default-effective',
           'drifted effective default privilege '
             || jsonb_build_array(ae.objtype, ae.scope, ae.grantee)::text
             || ' [expected privs=' || array_to_string(ae.privileges, ',')
             || '] [found privs=' || array_to_string(da.privileges, ',')
             || ' grantable=' || CASE WHEN da.grantable THEN 't' ELSE 'f' END
             || ']'
      FROM allowed_default_effective ae
      JOIN default_effective_actual da
        ON da.objtype = ae.objtype AND da.scope = ae.scope
       AND da.grantee = ae.grantee
     WHERE ae.state = state_key
       AND (da.privileges IS DISTINCT FROM ae.privileges OR da.grantable)
    UNION ALL
    -- 数组类型只向元素类型委托：PostgreSQL 直接拒绝对它们授权与改属，因此它们
    -- 既不能成为收敛目标，也不该有任何直接 ACL 条目。
    SELECT 5, 'type',
           'array type ' || tc.objkey::text
             || ' must never be an authorization target'
      FROM type_class tc
     WHERE tc.class_name = 'array'
       AND (EXISTS (SELECT 1 FROM managed_object mo WHERE mo.objkey = tc.objkey)
            OR EXISTS (SELECT 1 FROM acl_source a WHERE a.objkey = tc.objkey))
  )
  SELECT (SELECT count(*) FROM divergence_rows)::integer,
         (SELECT pg_catalog.string_agg(pg_catalog.left(entry, 400), '; '
                                       ORDER BY rank, entry COLLATE "C")
            FROM (SELECT rank, entry FROM divergence_rows
                   ORDER BY rank, entry COLLATE "C" LIMIT 8) AS capped)
    INTO divergence_count, divergence;

  IF divergence_count > 0 THEN
    RAISE EXCEPTION
      'authorization manifest does not match state % '
      '(% divergence(s), manifest version 2): %',
      state_key, divergence_count,
      divergence || CASE WHEN divergence_count > 8 THEN '; ...' ELSE '' END;
  END IF;
END
$meal_agent_authorization_verify$;
