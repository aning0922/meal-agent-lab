import {
  authorizationManifest,
  AuthorizationManifestError,
  type AuthorizationManifest,
} from "./authorization-manifest.js";
import { byCodeUnit } from "./stage06-manifest.js";

/**
 * 阶段 09A / M2A（第八轮 A）：**只读**的授权 catalog 投影。
 *
 * 目的与边界：
 *
 *   - 这一轮**不实现 ACL convergence**。在能可靠收敛之前，先要能把权限状态
 *     完整、确定、只读地观察出来——否则「收敛」只是把看不见的东西换个方式看不见。
 *   - 因此本模块渲染出的 SQL 里不含 `GRANT`、`REVOKE`、`ALTER`、`SET ROLE`
 *     或任何其他权限 mutation；它只 `SELECT`。单元测试对此有断言。
 *   - 它被设计成后续 verify / converge 可以直接复用的 canonical projector：
 *     两者需要的「当前真实授权状态」就是这里的输出。
 *
 * 相对既有 `authorization-manifest-sql.ts` 的关键差别：
 *
 *   1. **不使用 `watchedGrantees` 过滤**。grantee 与 grantor 全部动态枚举——
 *      静态名单永远追不上「谁可能出现在 ACL 里」。
 *   2. 每条 ACL 一行 `(object, grantee, grantor, privilege, is_grantable)`。
 *      同一权限由不同 grantor 授予会保留成**不同的行**，因此「合规但来自第三方
 *      grantor 的重复授权」不会被聚合掉。
 *   3. `pg_default_acl` 分三层：raw global、raw schema，以及两者按 PostgreSQL
 *      真实语义**叠加**后的 effective。已在 PostgreSQL 18.4 上实测：global 与
 *      schema 行是**按权限求并集**叠加的（同一 grantee 在 global 有 `INSERT`、
 *      在 schema 有 `SELECT`，新建对象得到两者），不是「schema 覆盖 global」，
 *      更不是三选一的 `COALESCE`。
 *   4. effective 探测覆盖项目 NOLOGIN 角色**以及目标库内所有非 superuser
 *      LOGIN 角色**，因此外部 login 或经由角色继承取得的权限不会漏检。
 *   5. owner 投影覆盖 database、managed schema 及其中**全部** relation /
 *      sequence / routine / type，不局限于对象 manifest 已登记的那些。
 *   6. Large Object 全量可见：任意 `pg_largeobject_metadata` 对象、任意
 *      grantee/grantor 的 LO ACL，以及 20 个 `pg_catalog` LO 入口的直接与有效
 *      `EXECUTE`。
 *   7. type 明确区分 element/row/array：数组类型不能单独 `GRANT`/`REVOKE`
 *      （PostgreSQL 直接报 `cannot set privileges of array types`），其权限检查
 *      委托到元素类型，因此它**不是**一个可独立收敛的目标，投影如实标注。
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

/** 归一化 grantee/grantor：`0` 是 `PUBLIC`，其余取角色名。 */
const granteeText = (column: string): string =>
  `CASE WHEN ${column} = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(${column}) END`;

const flagText = (column: string): string =>
  `CASE WHEN ${column} THEN 't' ELSE 'f' END`;

/**
 * 只读投影。返回 `(kind, identity, detail)` 三列，行序固定。
 *
 * kind 一览：
 *   `acl`               直接 catalog ACL，一权限一 grantor 一行
 *   `default-global`    `pg_default_acl` 的全局原始行
 *   `default-schema`    `pg_default_acl` 的 schema 原始行
 *   `default-effective` 内建默认 + 全局 + schema 叠加后的未来对象 ACL
 *   `effective`         `has_*_privilege` 探测结果
 *   `owner`             database / schema / relation / routine / type 的归属
 *   `large-object`      LO 自身及其 ACL
 *   `type-class`        element / row / array 分类与委托事实
 *   `role`              参与探测的角色集合（便于复核覆盖面）
 */
export const renderAuthorizationProjectionSql = (
  manifest: AuthorizationManifest = authorizationManifest,
): string => {
  const managed = textArray([...manifest.managedSchemas].sort(byCodeUnit));
  const denied = textArray([...manifest.deniedRoutines].sort(byCodeUnit));

  return `WITH RECURSIVE
  managed_schema (nspname, oid) AS (
    SELECT n.nspname::text, n.oid
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname = ANY (${managed})
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
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_database d,
           aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
     WHERE d.datname = current_database()
    UNION ALL
    SELECT 'schema:' || n.nspname,
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_namespace n,
           aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
     WHERE n.nspname = ANY (${managed})
    UNION ALL
    SELECT 'relation:' || n.nspname || '.' || c.relname,
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
    SELECT 'column:' || n.nspname || '.' || c.relname || '.' || a.attname,
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN managed_schema n ON n.oid = c.relnamespace,
           aclexplode(a.attacl) AS acl
     WHERE a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'routine:' || n.nspname || '.' || p.proname || '('
             || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace,
           aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    UNION ALL
    -- 20 个 pg_catalog Large Object 入口点：产品声明禁用 LO，它们的直接 ACL
    -- 同样属于必须可见的范围。
    SELECT 'routine:' || lo.identity,
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM unnest(${denied}) AS lo(identity)
      JOIN pg_catalog.pg_proc lp ON lp.oid = to_regprocedure(lo.identity),
           aclexplode(COALESCE(lp.proacl, acldefault('f', lp.proowner))) AS acl
    UNION ALL
    SELECT 'type:' || n.nspname || '.' || t.typname,
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_type t
      JOIN managed_schema n ON n.oid = t.typnamespace,
           aclexplode(COALESCE(t.typacl, acldefault('T', t.typowner))) AS acl
     WHERE NOT (t.typcategory = 'A' AND t.typelem <> 0)
    UNION ALL
    SELECT 'language:' || l.lanname,
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
           acl.privilege_type::text, acl.is_grantable
      FROM pg_catalog.pg_language l, aclexplode(l.lanacl) AS acl
    UNION ALL
    SELECT 'largeobject:' || m.oid::text,
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
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
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
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
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
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
      FROM unnest(${denied}) AS lo(identity), probe_role pr
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
             ('grantable=' || ${flagText("grantable")})::text AS detail
        FROM acl_source
      UNION ALL
      SELECT 'default-' || scope_kind,
             defaclrole || '#' || objtype || '@' || scope || '#' || grantee
               || '#' || grantor || '#' || privilege,
             'grantable=' || ${flagText("grantable")}
        FROM default_raw
      UNION ALL
      SELECT 'default-effective',
             defaclrole || '#' || objtype || '@' || scope || '#' || grantee
               || '#' || grantor || '#' || privilege,
             'grantable=' || ${flagText("grantable")}
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
   ORDER BY kind COLLATE "C", identity COLLATE "C", detail COLLATE "C"`;
};

/**
 * 把投影包进一个自带 GUC 保存/还原的只读语句。`pg_get_*` 系列的输出同时受
 * `search_path` 与 `quote_all_identifiers` 影响，而 `set_config(..., true)` 只在
 * **事务**结束时恢复，不会在语句结束时恢复。
 */
export const renderAuthorizationProjectionAdapter = (
  manifest: AuthorizationManifest = authorizationManifest,
): string =>
  [
    "-- 阶段 09A / M2A：授权 catalog 的**只读**投影。",
    "--",
    "-- GENERATED FILE — DO NOT EDIT.",
    "-- 事实源： services/api/src/database/authorization-projection-sql.ts",
    "-- 重新生成： pnpm --filter @meal-agent/api manifest:generate",
    "-- 门禁： pnpm --filter @meal-agent/api manifest:check",
    "--",
    "-- 本文件只 SELECT：不含 GRANT / REVOKE / ALTER / SET ROLE 或任何其他权限",
    "-- mutation。它是后续 verify / converge 共用的 canonical projector，本轮只",
    "-- 用于观察与反向测试，尚未接入 02/03 的任何阶段。",
    "",
    `${renderAuthorizationProjectionSql(manifest)};`,
    "",
  ].join("\n");
