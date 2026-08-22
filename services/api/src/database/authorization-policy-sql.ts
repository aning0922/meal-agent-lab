import {
  assertRenderableValue,
  encodeProjectionIdentity,
} from "./authorization-identity.js";
import {
  authorizationManifest,
  authorizationStateKey,
  AuthorizationManifestError,
  projectRoles,
  validateAuthorizationManifest,
  type AuthorizationManifest,
} from "./authorization-manifest.js";
import { renderAuthorizationProjectorCtes } from "./authorization-projection-sql.js";
import { byCodeUnit } from "./stage06-manifest.js";

/**
 * 阶段 09A / M2A（R8B）：**可移植的授权策略匹配器**。
 *
 * 它是「共享事实采集」之上的第二层。canonical projector
 * （`authorization-projection-sql.ts`）只回答「现在是什么」；本模块只回答「什么是
 * 允许的」，而且只用**可移植**的方式回答：
 *
 * - 固定允许项来自 manifest，identity 是结构化 JSON 数组，canonical grantor 恒为
 *   `principals.owner`，永不允许可再授予（grantable）；
 * - 其余一律按**策略**匹配，不逐个登记环境相关的名字：对象 owner 自身的内建
 *   权限、language 的内建 `PUBLIC USAGE`、20 个 Large Object 入口点只允许函数
 *   owner、列级授权一律不允许、managed 非数组 type 只允许 owner、任意 Large
 *   Object 一律 fail closed；
 * - `role` 覆盖面是证据不是白名单，外部角色不进任何允许集合。
 *
 * 因此同一段策略在任何 cluster 上都成立：它不含动态 LOGIN 角色名、不含
 * `pg_default_acl` 里出现过的 owner，也不含 Large Object 的 OID。
 *
 * ## 两类 default privilege 事实的分工
 *
 * - `default_raw`（物理行）决定**要执行哪条**默认权限语句；manifest 的
 *   `defaults` 就是按物理行登记的。
 * - `default_effective`（叠加结果）只用于**最终语义验证**。绝不据此反推语句：
 *   内建默认不需要任何语句，只有物理行才需要。
 *
 * ## 与 mutation 的关系
 *
 * {@link renderAuthorizationPreflightStatement} 渲染的是**一条只读语句**，在任何
 * mutation 之前执行；它把全部致命前置条件一次性收集再抛出。收敛不允许「先改、
 * 再靠事务回滚冒充 preflight」——回滚只让命令失败，中途已经产生过真实变更，而
 * 权限本身仍然留在数据库里。
 */

/** 这些字符出现在值里就无法确定性渲染成 SQL 字面量。 */
const unrenderable = (value: string): boolean =>
  ["\\", "\r", "\n", String.fromCharCode(0)].some((forbidden) =>
    value.includes(forbidden),
  );

export const policyLiteral = (value: string): string => {
  // 结构化 identity 与 detail 里合法地带引号（JSON 编码的产物），因此它们只过
  // 结构字符检查；单个标识符（角色名 / schema 名 / 权限名 / objtype / scope）
  // 由 manifest 侧的共用守卫在更早的位置拒绝 SQL token。
  if (unrenderable(value)) {
    throw new AuthorizationManifestError(
      "a policy value cannot be rendered as a deterministic SQL literal",
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
};

/** 单个标识符走全体 renderer 共用的守卫。 */
export const policyIdentifier = (field: string, value: string): string =>
  policyLiteral(assertRenderableValue(field, value));

export const policyTextArray = (values: readonly string[]): string =>
  values.length === 0
    ? "ARRAY[]::text[]"
    : `ARRAY[${values.map(policyLiteral).join(", ")}]::text[]`;

/** `PUBLIC` 在 SQL 语句里是关键字，其余 grantee 必须 quote。 */
export const granteeSql = (column: string): string =>
  `CASE WHEN ${column} = 'PUBLIC' THEN 'PUBLIC'
                       ELSE quote_ident(${column}) END`;

/**
 * 渲染 `VALUES` 列表。允许集合在某个 `(ledger, phase)` 下为空是正常的，而空
 * `VALUES` 是语法错误，因此空集合渲染成一条恒假的 SELECT。第一行按列补类型
 * 标注，其余行沿用。
 */
const renderValues = (
  rows: readonly (readonly string[])[],
  types: readonly string[],
  emptyProjection: string,
): string => {
  if (rows.length === 0) {
    return `      ${emptyProjection} WHERE false`;
  }
  const sorted = [...rows].sort((left, right) =>
    byCodeUnit(left.join(""), right.join("")),
  );
  const rendered = sorted.map((row, index) => {
    const columns = row.map((value, column) => {
      const type = types[column];
      return index === 0 && type !== undefined && type !== ""
        ? `${value}::${type}`
        : value;
    });
    return `        (${columns.join(", ")})`;
  });
  return `      VALUES\n${rendered.join(",\n")}`;
};

/**
 * 固定允许项与策略判定的 CTE。它们**只**表达允许集合，不表达观察面：观察面由
 * canonical projector 动态给出。
 *
 * 依赖调用方已经把 {@link renderAuthorizationProjectorCtes} 的 CTE 放在前面，
 * 并且在 plpgsql 里声明了 `state_key` 变量。
 */
export const renderAuthorizationPolicyCtes = (
  manifest: AuthorizationManifest = authorizationManifest,
): string => {
  validateAuthorizationManifest(manifest);
  const { owner, grantees, logins, memberships } = manifest.principals;
  const grantRows: string[][] = [];
  const effectiveRows: string[][] = [];
  const defaultRows: string[][] = [];
  const defaultEffectiveRows: string[][] = [];
  const routineRows: string[][] = [];

  for (const state of manifest.states) {
    const key = policyLiteral(authorizationStateKey(state.ledger, state.phase));
    for (const entry of state.grants) {
      for (const privilege of [...entry.privileges].sort(byCodeUnit)) {
        grantRows.push([
          key,
          policyLiteral(encodeProjectionIdentity(entry.object)),
          policyLiteral(entry.grantee),
          policyLiteral(privilege),
        ]);
      }
    }
    for (const entry of state.effective) {
      effectiveRows.push([
        key,
        policyLiteral(encodeProjectionIdentity(entry.object)),
        policyLiteral(entry.role),
        policyTextArray([...entry.privileges].sort(byCodeUnit)),
      ]);
    }
    for (const entry of state.defaults) {
      for (const privilege of [...entry.privileges].sort(byCodeUnit)) {
        defaultRows.push([
          key,
          policyLiteral(entry.objtype),
          policyLiteral(entry.scope),
          policyLiteral(entry.grantee),
          policyLiteral(privilege),
        ]);
      }
    }
    for (const entry of state.defaultEffective) {
      defaultEffectiveRows.push([
        key,
        policyLiteral(entry.objtype),
        policyLiteral(entry.scope),
        policyLiteral(entry.grantee),
        policyTextArray([...entry.privileges].sort(byCodeUnit)),
      ]);
    }
    for (const entry of state.routines) {
      routineRows.push([
        key,
        policyLiteral(encodeProjectionIdentity(entry.object)),
        policyLiteral(
          `owner=${entry.owner} secdef=${entry.securityDefiner ? "t" : "f"} ` +
            `config=${encodeProjectionIdentity(entry.config)} ` +
            `body=${entry.bodyDigest}`,
        ),
      ]);
    }
  }

  const membershipRows = memberships.map((entry) => [
    policyLiteral(entry.member),
    policyLiteral(entry.granted),
  ]);

  return `  -- 固定项目主体。**只**用于固定允许权限、角色存在性，以及区分项目角色与
  -- 动态发现的外部角色；绝不用来过滤 catalog 里的 grantee 或 grantor。
  principal (role_name) AS (
    SELECT unnest(${policyTextArray([...grantees].sort(byCodeUnit))})
  ),
  project_role (role_name) AS (
    SELECT unnest(${policyTextArray(projectRoles(manifest))})
  ),
  project_login (role_name) AS (
    SELECT unnest(${policyTextArray([...logins].sort(byCodeUnit))})
  ),
  -- canonical membership 图。database scope 绝不修改 membership：这里只用于判断
  -- 「有效权限漂移是不是继承造成的」，是就 fail closed 并要求先跑 cluster role
  -- baseline。
  canonical_membership (member_name, granted_name) AS (
${renderValues(membershipRows, ["text", "text"], "SELECT NULL::text, NULL::text")}
  ),
  -- 固定允许的直接授权。canonical grantor 恒为 ${owner}。
  allowed_grants (state, objkey, grantee, privilege) AS (
${renderValues(
  grantRows,
  ["text", "jsonb", "text", "text"],
  "SELECT NULL::text, NULL::jsonb, NULL::text, NULL::text",
)}
  ),
  -- 固定允许的**有效**权限，只覆盖四类对象 × 项目主体。
  allowed_effective (state, objkey, role_name, privileges) AS (
${renderValues(
  effectiveRows,
  ["text", "jsonb", "text", ""],
  "SELECT NULL::text, NULL::jsonb, NULL::text, NULL::text[]",
)}
  ),
  -- 固定允许的 pg_default_acl **物理行**条目：它决定要执行哪条默认权限语句。
  allowed_default (state, objtype, scope, grantee, privilege) AS (
${renderValues(
  defaultRows,
  ["text", "text", "text", "text", "text"],
  "SELECT NULL::text, NULL::text, NULL::text, NULL::text, NULL::text",
)}
  ),
  -- 叠加之后的**有效**默认权限，只用于最终语义验证。
  allowed_default_effective (state, objtype, scope, grantee, privileges) AS (
${renderValues(
  defaultEffectiveRows,
  ["text", "text", "text", "text", ""],
  "SELECT NULL::text, NULL::text, NULL::text, NULL::text, NULL::text[]",
)}
  ),
  -- 受控 routine 的允许指纹。managed schema 里出现任何未登记的 routine 一律
  -- fail closed——恢复路径可以把任意 SECURITY DEFINER 函数带进 drizzle。
  allowed_routine (state, objkey, detail) AS (
${renderValues(
  routineRows,
  ["text", "jsonb", "text"],
  "SELECT NULL::text, NULL::jsonb, NULL::text",
)}
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
             -- 固定允许项：canonical grantor 必须是 ${owner}。
             WHEN a.object_class IN ('database', 'schema', 'relation', 'routine')
                  AND a.grantor = ${policyLiteral(owner)}
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
           r.defaclrole = ${policyLiteral(owner)}
             AND r.grantor = ${policyLiteral(owner)}
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
    SELECT ${policyLiteral(owner)}, ad.objtype, ad.scope,
           CASE WHEN ad.scope = '-' THEN 'global' ELSE 'schema' END,
           ad.grantee, ${policyLiteral(owner)}, ad.privilege, false
      FROM allowed_default ad
     WHERE ad.state = state_key
    UNION ALL
    SELECT b.defaclrole, b.objtype, b.scope, 'global', b.grantee, b.grantor,
           b.privilege, b.grantable
      FROM default_baseline b
     WHERE b.defaclrole = ${policyLiteral(owner)}
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
       AND role_name <> ${policyLiteral(owner)}
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
  )`;
};

/** 共享事实层 + 策略层，供 verify 与 converge 的每条语句直接拼在 `WITH` 之后。 */
export const renderAuthorizationSharedCtes = (
  manifest: AuthorizationManifest = validateAuthorizationManifest(
    authorizationManifest,
  ),
): string =>
  `${renderAuthorizationProjectorCtes(manifest)},\n${renderAuthorizationPolicyCtes(manifest)}`;

/**
 * 致命前置条件。**一条只读语句**，在任何 mutation 之前执行；把全部问题一次收集
 * 再抛出，因此不会「改了一半才发现不该改」。
 *
 * 覆盖：managed schema 缺失、项目角色缺失、owner 漂移、登录角色拥有对象、
 * routine 指纹漂移 / 未知 routine / 异常 `SECURITY DEFINER`、manifest 要求的对象
 * 缺失、未知 `defaclobjtype`、任意 Large Object，以及无法由 ACL mutation 修复的
 * membership 漂移。未登记的 `(ledger, phase)` 由调用方的 state 解析更早拦下。
 */
export const renderAuthorizationPreflightStatement = (
  manifest: AuthorizationManifest = authorizationManifest,
): string => {
  validateAuthorizationManifest(manifest);
  const { owner } = manifest.principals;
  const managed = policyTextArray(
    [...manifest.managedSchemas].sort(byCodeUnit),
  );
  return `  WITH
${renderAuthorizationSharedCtes(manifest)},
  preflight_problem (rank, kind, entry) AS (
    -- 1. managed schema 必须齐全：缺任何一个都说明这不是一个可以安全收敛的
    --    目标（新安装漏了 0000，或恢复只恢复了一部分）。
    SELECT 1, 'schema'::text,
           'managed schema ' || expected || ' is missing'
      FROM unnest(${managed}) AS expected
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
             || ', expected ' || ${policyLiteral(owner)}
      FROM owner_source o
     WHERE o.object_class IN ('database', 'schema', 'relation', 'routine',
                              'type')
       AND o.owner_name <> ${policyLiteral(owner)}
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
      'version ${String(manifest.version)}): %',
      state_key, problem_count,
      problem_detail
        || CASE WHEN problem_count > 8 THEN '; ...' ELSE '' END;
  END IF;`;
};
