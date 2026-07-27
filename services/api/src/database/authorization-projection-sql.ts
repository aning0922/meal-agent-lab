import {
  authorizationManifest,
  AuthorizationManifestError,
  type AuthorizationManifest,
} from "./authorization-manifest.js";
import { byCodeUnit } from "./stage06-manifest.js";

/**
 * 阶段 09A / M2A（R8A 修订）：**只读**的授权 catalog 投影。
 *
 * 边界（本轮不变）：不实现 ACL convergence。渲染出的 SQL 是**单条只读 SELECT**，
 * 不含 `GRANT`/`REVOKE`/`ALTER`/`SET ROLE`/`SET`/`set_config` 或任何其他 mutation；
 * 它只观察。单元测试对此有断言。它被设计成后续 verify/converge 可复用的 canonical
 * projector，但本轮**尚未接入**任何阶段。
 *
 * ## 四类投影分别定义（不使用「全部 ACL 主体」这种笼统说法）
 *
 * - **raw**：catalog 里真实存在的授权条目本身。
 *   覆盖 database、managed schema、其中的 relation/sequence/column/routine/
 *   非数组 type、language、Large Object，以及 20 个 `pg_catalog` LO 入口点。
 *   grantee 与 grantor 全部动态枚举，一条 `(object, grantee, grantor, privilege,
 *   is_grantable)` 一行——同一权限由不同 grantor 授予会保留成不同的行。
 *   `pg_default_acl` 的 raw 层分 `default-global` 与 `default-schema` 两种 kind。
 * - **effective**：`has_*_privilege` 的探测结果，覆盖 database、schema、
 *   relation/sequence、**column**、routine、type、**language**、
 *   **Large Object（SELECT/UPDATE）**。
 * - **owner**：database、managed schema，及其中全部 relation/sequence/routine/
 *   type 与全部 Large Object 的归属。
 * - **role coverage**：参与 effective 探测的角色集合，逐个列出便于复核覆盖面。
 *
 * 未覆盖的类别不在此声称覆盖：FDW/foreign server/user mapping、tablespace、
 * event trigger、subscription、publication、parameter ACL 均**不在**本投影内。
 *
 * ## `pg_default_acl` 的真实合成语义（PostgreSQL 18.4 实测）
 *
 * 1. **非空**的 global 行**替换**内建默认，而不是与之合并：
 *    `ALTER DEFAULT PRIVILEGES FOR ROLE m REVOKE TRUNCATE ON TABLES FROM m`
 *    产生 `{m=arwdxtm/m}`，新建表的 `relacl` 就是 `{m=arwdxtm/m}`——内建默认里的
 *    `TRUNCATE` 没有回来。
 * 2. **空**的 global 行（`{}`，`array_length = 0`）等价于**没有行**：新建对象仍然
 *    落到内建默认（实测新函数 `proacl IS NULL`，`PUBLIC` 仍有 `EXECUTE`）。
 *    因此「行是否存在」必须**先于** `aclexplode` 判断——展开一个空 ACL 得到零行，
 *    与「没有这一行」无法区分。
 * 3. schema 行**叠加**在上述 base 之上；同一 `(grantee, grantor, privilege)` 只
 *    产生**一条**结果，`is_grantable` 取真实聚合值（global 非 grantable +
 *    schema `WITH GRANT OPTION` ⇒ 一条 `SELECT`、`grantable = true`）。
 *
 * ## canonical identity 编码
 *
 * identity 不再是未转义的 `#`/`@`/`|` 拼接串——含这些字符（或引号）的合法角色名与
 * 对象名会造成歧义甚至碰撞。改用 **JSON 数组**：结构化、可证明无歧义，且
 * PostgreSQL 与 Node 两侧使用同一表示（见 `encodeProjectionIdentity`）。
 *
 * identity 里也不再出现受 `search_path` / `quote_all_identifiers` 影响的
 * `pg_get_function_identity_arguments` 或 `format_type`：routine 的参数类型直接从
 * `pg_proc.proargtypes` → `pg_type` → `pg_namespace` 构造，**始终 schema 限定**，
 * 与任何 GUC 无关。database identity 统一为逻辑键 `<current>`，测试库的随机后缀
 * 不进入 identity。
 */

const dollarTag = "$meal_agent_authorization_projection$";

const unrenderable = (value: string): boolean =>
  ["\\", "\r", "\n", String.fromCharCode(0), dollarTag].some((forbidden) =>
    value.includes(forbidden),
  );

const literal = (value: string): string => {
  if (unrenderable(value)) {
    throw new AuthorizationManifestError(
      "a projection value cannot be rendered as a deterministic SQL literal",
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
};

const textArray = (values: readonly string[]): string =>
  values.length === 0
    ? "ARRAY[]::text[]"
    : `ARRAY[${values.map(literal).join(", ")}]::text[]`;

/**
 * canonical identity 的 **Node 侧**编码，必须与 PostgreSQL `jsonb_build_array(...)
 * ::text` 的输出逐字节相同：JSON 数组、元素间 `, `（逗号加一个空格）。
 * 数据库测试用含 `#`、`@`、`|`、引号的名字证明两侧一致。
 */
export type ProjectionIdentityPart = string | readonly ProjectionIdentityPart[];

export const encodeProjectionIdentity = (
  parts: readonly ProjectionIdentityPart[],
): string =>
  `[${parts
    .map((part) =>
      typeof part === "string"
        ? JSON.stringify(part)
        : encodeProjectionIdentity(part),
    )
    .join(", ")}]`;

/** 逻辑数据库键：库名随环境不同，不进入 identity。 */
export const projectionDatabaseKey = "<current>";

/** `0` 是 `PUBLIC`，其余取角色名。 */
const granteeText = (column: string): string =>
  `CASE WHEN ${column} = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(${column}) END`;

const flagText = (column: string): string =>
  `CASE WHEN ${column} THEN 't' ELSE 'f' END`;

/**
 * routine 的参数类型列表，从 catalog 字段确定性构造：每个参数一个
 * `[schema, typname]` 对，始终 schema 限定，不经过 `format_type`。
 * `proargtypes` 恰好是 IN/INOUT/VARIADIC 参数，与 identity 语义一致。
 */
const routineArgumentTypes = (procAlias: string): string =>
  `COALESCE((SELECT jsonb_agg(jsonb_build_array(atn.nspname, at.typname)
                                ORDER BY argument.ordinality)
               FROM unnest(${procAlias}.proargtypes) WITH ORDINALITY
                      AS argument(type_oid, ordinality)
               JOIN pg_catalog.pg_type at ON at.oid = argument.type_oid
               JOIN pg_catalog.pg_namespace atn ON atn.oid = at.typnamespace),
            '[]'::jsonb)`;

const routineKey = (procAlias: string, schemaExpression: string): string =>
  `jsonb_build_array('routine', ${schemaExpression}, ${procAlias}.proname,
                     ${routineArgumentTypes(procAlias)})`;

/** 单条只读投影：`(kind, identity, detail)`，行序固定。 */
export const renderAuthorizationProjectionSql = (
  manifest: AuthorizationManifest = authorizationManifest,
): string => {
  const managed = textArray([...manifest.managedSchemas].sort(byCodeUnit));
  const denied = textArray([...manifest.deniedRoutines].sort(byCodeUnit));
  const databaseKey = `jsonb_build_array('database', ${literal(
    projectionDatabaseKey,
  )})`;

  return `WITH
  managed_schema (nspname, oid, nspowner, nspacl) AS (
    SELECT n.nspname::text, n.oid, n.nspowner, n.nspacl
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname = ANY (${managed})
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
      FROM unnest(${denied}) AS lo(identity)
     WHERE to_regprocedure(lo.identity) IS NOT NULL
  ),
  acl_source (objkey, grantee, grantor, privilege, grantable) AS (
    SELECT ${databaseKey},
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_database d,
           aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
     WHERE d.datname = current_database()
    UNION ALL
    SELECT jsonb_build_array('schema', n.nspname),
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM managed_schema n,
           aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
    UNION ALL
    SELECT jsonb_build_array('relation', n.nspname, c.relname),
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
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
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN managed_schema n ON n.oid = c.relnamespace,
           aclexplode(a.attacl) AS acl
     WHERE a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT ${routineKey("p", "n.nspname")},
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace,
           aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    UNION ALL
    -- 20 个 pg_catalog Large Object 入口点：产品声明禁用 LO，它们的直接 ACL
    -- 同样必须可见。
    SELECT ${routineKey("lp", "lpn.nspname")},
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM denied_routine dr
      JOIN pg_catalog.pg_proc lp ON lp.oid = dr.oid
      JOIN pg_catalog.pg_namespace lpn ON lpn.oid = lp.pronamespace,
           aclexplode(COALESCE(lp.proacl, acldefault('f', lp.proowner))) AS acl
    UNION ALL
    SELECT jsonb_build_array('type', n.nspname, t.typname),
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace,
           aclexplode(COALESCE(t.typacl, acldefault('T', t.typowner))) AS acl
     WHERE NOT (t.typcategory = 'A' AND t.typelem <> 0)
    UNION ALL
    -- language 的隐式 ACL：lanacl 为 NULL 时受信语言对 PUBLIC 开放 USAGE，
    -- 非受信语言只有 owner 可用。两者都用 acldefault 展开，避免漏掉隐式条目。
    SELECT jsonb_build_array('language', l.lanname),
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_language l,
           aclexplode(COALESCE(l.lanacl, acldefault('l', l.lanowner))) AS acl
     WHERE l.lanacl IS NOT NULL OR l.lanpltrusted
    UNION ALL
    SELECT jsonb_build_array('largeobject', m.oid::text),
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
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
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM default_row r, aclexplode(r.acl) AS acl
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
  default_slot (defaclrole, owner_oid, objtype, scope, schema_scoped) AS (
    SELECT o.rolname, o.oid, t.objtype, s.scope, s.schema_scoped
      FROM default_owner o,
           (SELECT unnest(ARRAY['r', 'S', 'f', 'T', 'n', 'L']) AS objtype) t,
           (SELECT nspname AS scope, true AS schema_scoped FROM managed_schema
             UNION ALL SELECT '-', false) s
     WHERE s.schema_scoped = false
        OR t.objtype IN ('r', 'S', 'f', 'T')
  ),
  -- base = 非空 global 行则**替换**内建默认；否则内建默认。
  default_base (defaclrole, objtype, scope, grantee, grantor, privilege,
                grantable) AS (
    SELECT sl.defaclrole, sl.objtype, sl.scope,
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM default_slot sl
      LEFT JOIN default_row g
        ON g.scope_kind = 'global' AND g.defaclrole = sl.defaclrole
       AND g.objtype = sl.objtype AND NOT g.is_empty,
           aclexplode(COALESCE(g.acl,
                               acldefault(sl.objtype::"char",
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
    SELECT ${databaseKey}, pg_catalog.pg_get_userbyid(d.datdba)::text
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
    SELECT ${routineKey("p", "n.nspname")},
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
    SELECT ${databaseKey}, pr.role_name,
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
    SELECT ${routineKey("p", "n.nspname")}, pr.role_name,
           CASE WHEN has_function_privilege(pr.probe_name, p.oid, 'EXECUTE')
                THEN 'EXECUTE' ELSE NULL END
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace, probe_role pr
    UNION ALL
    SELECT ${routineKey("lp", "lpn.nspname")}, pr.role_name,
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
             ('grantable=' || ${flagText("grantable")})::text AS detail
        FROM acl_source
      UNION ALL
      SELECT 'default-' || scope_kind,
             jsonb_build_array(defaclrole, objtype, scope, grantee, grantor,
                               privilege)::text,
             'grantable=' || ${flagText("grantable")}
        FROM default_raw
      UNION ALL
      SELECT 'default-row',
             jsonb_build_array(defaclrole, objtype, scope, scope_kind)::text,
             'exists=t empty=' || ${flagText("is_empty")}
        FROM default_row
      UNION ALL
      SELECT 'default-effective',
             jsonb_build_array(defaclrole, objtype, scope, grantee, grantor,
                               privilege)::text,
             'grantable=' || ${flagText("grantable")}
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
   ORDER BY kind COLLATE "C", identity COLLATE "C", detail COLLATE "C"`;
};

export const renderAuthorizationProjectionAdapter = (
  manifest: AuthorizationManifest = authorizationManifest,
): string =>
  [
    "-- 阶段 09A / M2A：授权 catalog 的**只读**投影（R8A 修订）。",
    "--",
    "-- GENERATED FILE — DO NOT EDIT.",
    "-- 事实源： services/api/src/database/authorization-projection-sql.ts",
    "-- 重新生成： pnpm --filter @meal-agent/api manifest:generate",
    "-- 门禁： pnpm --filter @meal-agent/api manifest:check",
    "--",
    "-- 本文件是**单条只读 SELECT**：不含 GRANT / REVOKE / ALTER / SET ROLE /",
    "-- SET / set_config 或任何其他 mutation，因此它既不改数据也不改调用方会话。",
    "-- 它是后续 verify / converge 共用的 canonical projector，本轮只用于观察与",
    "-- 反向测试，尚未接入 02/03 的任何阶段。",
    "",
    `${renderAuthorizationProjectionSql(manifest)};`,
    "",
  ].join("\n");
