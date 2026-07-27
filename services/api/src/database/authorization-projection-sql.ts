import {
  authorizationManifest,
  AuthorizationManifestError,
  type AuthorizationManifest,
} from "./authorization-manifest.js";
import { byCodeUnit } from "./stage06-manifest.js";

/**
 * 阶段 09A / M2A（R8B）：授权 catalog 的 **canonical projector**。
 *
 * 本模块被拆成两层，这是 R8B 的结构要求：
 *
 *   1. {@link renderAuthorizationProjectorCtes}：**可复用的结构化 projector CTE
 *      renderer**。它只做**事实采集**——把 catalog 里与授权有关的事实规范化成一组
 *      具名 CTE（`regulated_object` / `acl_source` / `default_row` /
 *      `default_raw` / `default_effective` / `owner_source` / `effective_source` /
 *      `type_class` / `large_object` / `probe_role` …），不含任何期望值、任何策略
 *      判断、任何 mutation。
 *   2. {@link renderAuthorizationProjectionSql}：**对外的三列
 *      `(kind, identity, detail)` 只读 SELECT**，是 R8A 已 Accepted 的可观察性
 *      产物。它的语义与行集在 R8B **不回归**。
 *
 * 同一组 CTE 同时被 `authorization-manifest-sql.ts` 的 verify 与 converge 复用，
 * 因此「观察」「策略判断」「收敛」三方共享同一套 catalog 事实。**共享的是事实
 * 采集，不是把动态投影冻结成跨环境快照**：期望值与策略全部留在
 * `authorization-policy-sql.ts`，本模块一条期望值都没有。
 *
 * ## 五类投影的精确含义（每一类只声称自己实际证明的事）
 *
 * - **normalized raw ACL semantics**（kind `acl`）：直接授权的**规范化语义**，
 *   **不是**「物理 catalog 里真实存在的 ACL 行」。`datacl`/`nspacl`/`relacl`/
 *   `proacl`/`typacl`/`lanacl`/`lomacl` 为 `NULL` 时，PostgreSQL 的语义是「适用
 *   内建默认权限」而不是「没有任何权限」，因此这里统一用
 *   `COALESCE(<acl>, acldefault(...))` 展开：一个 `relacl IS NULL` 的表在物理上
 *   一条 aclitem 都没有，本投影仍会给出 owner 的内建默认权限。唯一的例外是
 *   `attacl`（列级），它没有内建默认值，`NULL` 就是「没有列级授权」。
 *   覆盖 database、managed schema、其中的 relation/sequence/column/routine/
 *   非数组 type、language、Large Object，以及 20 个 `pg_catalog` LO 入口点。
 *   grantee 与 grantor 全部动态枚举，一条 `(object, grantee, grantor, privilege,
 *   is_grantable)` 一行——同一权限由不同 grantor 授予会保留成不同的行。
 * - **pg_default_acl physical row**（kind `default-row`）：唯一表示
 *   `pg_default_acl` **物理行存在性**的投影，detail 里同时给出 `empty`。
 *   `default-global` / `default-schema` 是这些物理行展开后的条目，
 *   `default-effective` 是按 PostgreSQL 真实语义叠加出的结果（见下）。
 * - **effective has_\* privileges**（kind `effective`）：`has_*_privilege` 的探测
 *   结果，把 `PUBLIC` 派生与角色继承一并算入。覆盖 database、schema、
 *   relation/sequence、**column**、routine、type、**language**、
 *   **Large Object（SELECT/UPDATE）**。探测主体见下面的 role coverage——
 *   effective **不是**对「所有角色」的枚举。
 * - **owner**（kind `owner` / `large-object`）：database、managed schema，及其中
 *   全部 relation/sequence/routine/type 与全部 Large Object 的归属。
 * - **role coverage**（kind `role`）：实际参与 effective 探测的角色集合，逐个列出
 *   便于复核覆盖面。它是**覆盖面证据**，不是「允许出现的角色」白名单；策略层
 *   不得把这些行当成 allowlist 冻结。
 *
 * 未覆盖的类别不在此声称覆盖：FDW/foreign server/user mapping、tablespace、
 * event trigger、subscription、publication、parameter ACL 均**不在**本投影内。
 *
 * ## 环境相关性（策略层必须遵守的边界）
 *
 * 投影结果**必然反映当前环境**：它包含动态枚举的 LOGIN 角色、`pg_default_acl`
 * 里出现过的 owner，以及 Large Object 的 OID。因此消费方：
 *
 * - `role` 行是 coverage 证据，不是允许角色白名单；
 * - 外部角色只能用**策略**匹配（例如「非项目主体且非对象 owner 的 grantee 一律
 *   视为异常」），不能靠逐个登记角色名；
 * - 产品声明禁用 Large Object，因此**任意** LO 对象都按政策判为异常并 fail
 *   closed，只报告、不自动删除未知数据；LO 的 OID 不进入任何固定允许 manifest；
 * - 只有 database identity 是可移植的逻辑键（见下），整份投影不可移植。
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
 * 4. base 里的 `acldefault()` **不能**直接吃 `pg_default_acl.defaclobjtype`：
 *    两者是两套 objtype 编码，见 `defaultAclObjtypeMappings`。
 *
 * `default_raw` 与 `default_effective` 的分工是**收敛正确性的关键**：真正决定要
 * 执行哪条 `ALTER DEFAULT PRIVILEGES` 的是 `default_raw`（物理行），
 * `default_effective` 只用于最终语义验证。反过来从 `default_effective` 猜 DDL 会
 * 把「内建默认」误当成「需要显式授予的项」。
 *
 * ## canonical identity 编码
 *
 * identity 不是未转义的 `#`/`@`/`|` 拼接串——含这些字符（或引号）的合法角色名与
 * 对象名会造成歧义甚至碰撞。使用 **JSON 数组**：结构化、可证明无歧义，且
 * PostgreSQL 与 Node 两侧使用同一表示（见 `encodeProjectionIdentity`）。消费方
 * 只能按下标做**结构化**访问（`->` / `->>`），不得用 `split_part`、正则或任何
 * 字符串拆分反向解析 identity。
 *
 * identity 里也不出现受 `search_path` / `quote_all_identifiers` 影响的
 * `pg_get_function_identity_arguments` 或 `format_type`：routine 的参数类型直接从
 * `pg_proc.proargtypes` → `pg_type` → `pg_namespace` 构造，**始终 schema 限定**，
 * 与任何 GUC 无关。database identity 统一为逻辑键 `<current>`，测试库的随机后缀
 * 不进入 identity。（`regulated_object.target_sql` 里确实用了
 * `pg_get_function_identity_arguments`，但那是**给 DDL 用的执行目标**，不是
 * identity，也不进入对外三列投影；converge 在固定 GUC 的会话里使用它。）
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
 * `pg_default_acl.defaclobjtype` 与 `acldefault()` 的 objtype 是**两套编码**。
 * 六种受监管对象里只有 sequence 的字母不同，而那一个不同足以静默改变语义：
 *
 * | 对象 | `pg_default_acl.defaclobjtype` | `acldefault()` |
 * | --- | --- | --- |
 * | table / view / matview | `r` | `r` |
 * | **sequence** | `S` | **`s`** |
 * | function / procedure | `f` | `f` |
 * | type / domain | `T` | `T` |
 * | schema | `n` | `n` |
 * | large object | `L` | `L` |
 *
 * `acldefault()` 里的**大写 `S` 是 FOREIGN SERVER**。PostgreSQL 18.4 实测：
 * `acldefault('S', m)` = `{m=U/m}`（foreign server 的 `USAGE`），
 * `acldefault('s', m)` = `{m=rwU/m}`（sequence 的 `SELECT`/`UPDATE`/`USAGE`）。
 * 因此把 `defaclobjtype` 直接喂给 `acldefault` 会让 sequence 的 base **少掉
 * SELECT 与 UPDATE**——是**低报**权限，而收敛恰恰要依赖这一层判断「哪些默认权限
 * 是本来就该有的」。
 *
 * `schemaScoped` 记录该 objtype 能否出现在 `IN SCHEMA` 形式里：PostgreSQL 只允许
 * table/sequence/function/type 带 schema，schema 与 large object 只有全局形式。
 *
 * `ddlKeyword` 是 `ALTER DEFAULT PRIVILEGES … ON <keyword>` 里的复数关键字。它
 * 与 objtype 同源固定，避免收敛阶段再从 identity 字符串里反解一次。
 */
export interface DefaultAclObjtypeMapping {
  /** `pg_default_acl.defaclobjtype` 的取值。 */
  readonly objtype: string;
  /** 同一对象在 `acldefault()` 里的 objtype。 */
  readonly acldefaultObjtype: string;
  readonly schemaScoped: boolean;
  /** `ALTER DEFAULT PRIVILEGES … ON <ddlKeyword>` 的关键字。 */
  readonly ddlKeyword: string;
}

/** 受监管的六种 default ACL objtype，按 code unit 序固定。 */
export const defaultAclObjtypeMappings: readonly DefaultAclObjtypeMapping[] =
  Object.freeze([
    {
      objtype: "L",
      acldefaultObjtype: "L",
      schemaScoped: false,
      ddlKeyword: "LARGE OBJECTS",
    },
    {
      objtype: "S",
      acldefaultObjtype: "s",
      schemaScoped: true,
      ddlKeyword: "SEQUENCES",
    },
    {
      objtype: "T",
      acldefaultObjtype: "T",
      schemaScoped: true,
      ddlKeyword: "TYPES",
    },
    {
      objtype: "f",
      acldefaultObjtype: "f",
      schemaScoped: true,
      ddlKeyword: "FUNCTIONS",
    },
    {
      objtype: "n",
      acldefaultObjtype: "n",
      schemaScoped: false,
      ddlKeyword: "SCHEMAS",
    },
    {
      objtype: "r",
      acldefaultObjtype: "r",
      schemaScoped: true,
      ddlKeyword: "TABLES",
    },
  ] as const);

/**
 * canonical 六元组的**逐字文本**。校验只比对这一行：只检查「objtype 集合齐全」
 * 是不够的——把 `S` 映射成 `S`（错误目标）或把 sequence 标成非 schema-scoped
 * （错误作用域）都能通过集合检查，却分别导致低报权限与整类槽位消失。DDL 关键字
 * 同样进签名：`S` 配成 `TABLES` 会让 sequence 的收敛语句打到表上。
 */
const canonicalObjtypeSignature =
  "L>L/f:LARGE OBJECTS,S>s/t:SEQUENCES,T>T/t:TYPES,f>f/t:FUNCTIONS," +
  "n>n/f:SCHEMAS,r>r/t:TABLES";

const objtypeSignature = (
  mappings: readonly DefaultAclObjtypeMapping[],
): string =>
  mappings
    .map(
      (mapping) =>
        `${mapping.objtype}>${mapping.acldefaultObjtype}/` +
        `${mapping.schemaScoped ? "t" : "f"}:${mapping.ddlKeyword}`,
    )
    .join(",");

/**
 * 映射表本身 fail closed。任何偏离 canonical 六元组的写法——少一项、多一项、
 * 乱序、重复、映射到错误的 `acldefault` objtype、标错 schema 作用域，或配错 DDL
 * 关键字——都在渲染之前抛出，而不是渲染出一段「少了一类默认权限」「把 sequence
 * 当 FOREIGN SERVER」或「把 sequence 的默认权限改到表上」的 SQL。
 */
export const assertDefaultAclObjtypeMappings = (
  mappings: readonly DefaultAclObjtypeMapping[] = defaultAclObjtypeMappings,
): void => {
  for (const mapping of mappings) {
    if (
      mapping.objtype.length !== 1 ||
      mapping.acldefaultObjtype.length !== 1
    ) {
      throw new AuthorizationManifestError(
        `objtype ${JSON.stringify(mapping.objtype)} must map a single ` +
          "character to a single character",
      );
    }
  }
  const signature = objtypeSignature(mappings);
  if (signature !== canonicalObjtypeSignature) {
    throw new AuthorizationManifestError(
      "the acldefault mapping must be exactly the canonical six " +
        `<defaclobjtype>><acldefault objtype>/<schema-scoped>:<ddl keyword> ` +
        `tuples ${canonicalObjtypeSignature}; found ${signature}`,
    );
  }
};

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

/**
 * 受监管对象的分类标签。策略层按它区分「哪条规则适用」，因此它是 projector 的
 * **结构化输出**，不由消费方从 identity 字符串里反解。
 */
export const projectionObjectClasses = Object.freeze([
  "column",
  "database",
  "denied-routine",
  "language",
  "largeobject",
  "relation",
  "routine",
  "schema",
  "type",
] as const);

export type ProjectionObjectClass =
  (typeof projectionObjectClasses)[number];

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

/** DDL 执行目标：`ROUTINE <schema>.<name>(<identity args>)`。 */
const routineTarget = (procAlias: string, schemaAlias: string): string =>
  `'ROUTINE ' || quote_ident(${schemaAlias}.nspname) || '.'
             || quote_ident(${procAlias}.proname) || '('
             || pg_catalog.pg_get_function_identity_arguments(${procAlias}.oid)
             || ')'`;

/**
 * **可复用的结构化 projector CTE renderer**——R8B 的共享事实采集层。
 *
 * 返回的是不带前导 `WITH` 的 CTE 列表，调用方拼上 `WITH` 之后即可在自己的
 * SELECT / DO 块里引用下列具名关系：
 *
 * | CTE | 含义 |
 * | --- | --- |
 * | `managed_schema` | 三个受管理 schema 的 oid/owner/acl |
 * | `probe_role` | effective 探测主体：`PUBLIC` + 项目角色 + 全部非 superuser LOGIN |
 * | `denied_routine` | 20 个 `pg_catalog` Large Object 入口点 |
 * | `regulated_object` | 受监管对象的统一枚举：identity、分类、owner、DDL 目标、原始 ACL 与 `acldefault` objtype |
 * | `managed_object` | `regulated_object` 中可以直接 `GRANT` 的子集（不含 column / LO / 入口点） |
 * | `acl_source` | 规范化直接授权：`(objkey, class, owner, target, colname, grantee, grantor, privilege, grantable)` |
 * | `default_row` | `pg_default_acl` 的**物理行**（含 `is_empty`） |
 * | `default_raw` | 物理行展开后的条目——**决定执行哪条 `ALTER DEFAULT PRIVILEGES`** |
 * | `default_objtype` | objtype 映射表（含 DDL 关键字） |
 * | `default_owner` / `default_slot` / `default_base` | 有效默认权限的中间层 |
 * | `default_effective` | 按真实语义叠加出的有效默认权限——**只用于语义验证** |
 * | `owner_source` | 归属 |
 * | `effective_source` | `has_*_privilege` 探测结果（privileges 是排序数组） |
 * | `routine_fingerprint` | 受控 routine 的 owner / `SECURITY DEFINER` / `proconfig` / 正文摘要 |
 * | `role_membership` | `pg_auth_members` 全图——database scope 只观察、不修改 |
 * | `type_class` | 类型分类与数组类型的委托关系 |
 * | `large_object` | Large Object 的归属 |
 *
 * 这一层**没有任何期望值**：它不认识 manifest 的允许项，也不做任何策略判断。
 */
export const renderAuthorizationProjectorCtes = (
  manifest: AuthorizationManifest = authorizationManifest,
): string => {
  assertDefaultAclObjtypeMappings();
  const managed = textArray([...manifest.managedSchemas].sort(byCodeUnit));
  const denied = textArray([...manifest.deniedRoutines].sort(byCodeUnit));
  const databaseKey = `jsonb_build_array('database', ${literal(
    projectionDatabaseKey,
  )})`;

  return `  managed_schema (nspname, oid, nspowner, nspacl) AS (
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
  -- 受监管对象的**统一枚举**。identity、分类、owner、DDL 目标、原始 ACL 与
  -- acldefault 的 objtype 都在这里一次性确定，下游的 acl_source 与
  -- managed_object 都从它派生，不再各自重复扫描 catalog。
  --   * acl_default_objtype 为 NULL 表示该类没有内建默认 ACL（只有列级如此：
  --     attacl IS NULL 就是「没有列级授权」，不能 COALESCE 成内建默认）。
  --   * 数组类型不在此枚举内：PostgreSQL 直接拒绝对数组类型授权与改属，
  --     它们只在 type_class 里记录「向元素类型委托」。
  regulated_object (objkey, object_class, owner_name, owner_oid, target_sql,
                    colname, acl, acl_default_objtype) AS (
    SELECT ${databaseKey}, 'database'::text,
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
    SELECT ${routineKey("p", "n.nspname")}, 'routine',
           pg_catalog.pg_get_userbyid(p.proowner), p.proowner,
           ${routineTarget("p", "n")}, NULL,
           p.proacl, 'f'
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace
    UNION ALL
    -- 20 个 pg_catalog Large Object 入口点：产品声明禁用 LO，它们的直接 ACL
    -- 同样必须可见。
    SELECT ${routineKey("lp", "lpn.nspname")}, 'denied-routine',
           pg_catalog.pg_get_userbyid(lp.proowner), lp.proowner,
           ${routineTarget("lp", "lpn")}, NULL,
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
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
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
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
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
${defaultAclObjtypeMappings
  .map(
    (mapping, index) =>
      `      (${literal(mapping.objtype)}${index === 0 ? "::text" : ""}, ` +
      `${literal(mapping.acldefaultObjtype)}${index === 0 ? "::text" : ""}, ` +
      `${String(mapping.schemaScoped)}${index === 0 ? "::boolean" : ""}, ` +
      `${literal(mapping.ddlKeyword)}${index === 0 ? "::text" : ""})`,
  )
  .join(",\n")}
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
           ${granteeText("acl.grantee")}, pg_catalog.pg_get_userbyid(acl.grantor),
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
    SELECT ${databaseKey}, 'database'::text,
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
    SELECT ${routineKey("p", "n.nspname")}, 'routine',
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
    SELECT ${databaseKey}, 'database'::text, pr.role_name,
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
    SELECT ${routineKey("p", "n.nspname")}, 'routine', pr.role_name,
           CASE WHEN has_function_privilege(pr.probe_name, p.oid, 'EXECUTE')
                THEN ARRAY['EXECUTE'] ELSE NULL END
      FROM pg_catalog.pg_proc p
      JOIN managed_schema n ON n.oid = p.pronamespace, probe_role pr
    UNION ALL
    SELECT ${routineKey("lp", "lpn.nspname")}, 'denied-routine', pr.role_name,
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
    SELECT ${routineKey("p", "n.nspname")},
           pg_catalog.pg_get_userbyid(p.proowner)::text,
           p.prosecdef,
           COALESCE(pg_catalog.array_to_string(p.proconfig, '|'), '')::text,
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
  )`;
};

/**
 * **对外的三列 `(kind, identity, detail)` 只读投影**，行序固定。
 *
 * 这是 R8A 已 Accepted 的可观察性产物：行集与语义在 R8B **不回归**，只是改为
 * 从共享的结构化 projector CTE 派生。
 */
export const renderAuthorizationProjectionSql = (
  manifest: AuthorizationManifest = authorizationManifest,
): string => `WITH
${renderAuthorizationProjectorCtes(manifest)}
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
      -- fail closed：一个本投影不认识的 defaclobjtype 不能静默从 base 里消失。
      -- 它没有可信的 acldefault 参数，因此不参与 default-effective，但必须显式
      -- 现形，由消费方（verify/converge 的 fatal preflight）判为异常。
      -- PostgreSQL 18 的默认权限语句只能写出上面六种 objtype，所以健康库里这一类
      -- 恒为空——它是版本前向保护，不是已发生过的状态。
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
             'grantable=' || ${flagText("grantable")}
        FROM default_effective
      UNION ALL
      SELECT 'effective', jsonb_build_array(objkey, role_name)::text,
             'privs=' || pg_catalog.array_to_string(privileges, ',')
        FROM effective_source
       WHERE privileges IS NOT NULL
      UNION ALL
      SELECT 'owner', objkey::text, 'owner=' || owner_name
        FROM owner_source
      UNION ALL
      SELECT 'large-object', objkey::text, 'owner=' || owner_name
        FROM large_object
      UNION ALL
      SELECT 'type-class', objkey::text, detail
        FROM type_class
      UNION ALL
      SELECT 'role', jsonb_build_array(role_name)::text, 'class=' || role_class
        FROM probe_role
    ) AS projection
   ORDER BY kind COLLATE "C", identity COLLATE "C", detail COLLATE "C"`;

export const renderAuthorizationProjectionAdapter = (
  manifest: AuthorizationManifest = authorizationManifest,
): string =>
  [
    "-- 阶段 09A / M2A：授权 catalog 的**只读**投影（canonical projector 的对外三列）。",
    "--",
    "-- GENERATED FILE — DO NOT EDIT.",
    "-- 事实源： services/api/src/database/authorization-projection-sql.ts",
    "-- 重新生成： pnpm --filter @meal-agent/api manifest:generate",
    "-- 门禁： pnpm --filter @meal-agent/api manifest:check",
    "--",
    "-- 本文件是**单条只读 SELECT**：不含 GRANT / REVOKE / ALTER / SET ROLE /",
    "-- SET / set_config 或任何其他 mutation，因此它既不改数据也不改调用方会话。",
    "-- 它上面那一整段 CTE 是 R8B 的**共享结构化 projector**：verify 与 converge",
    "-- 复用同一段事实采集，因此观察、策略判断与收敛看到的是同一套 catalog 事实。",
    "-- 本文件只是它的**只读出口**，不含任何期望值与策略判断。",
    "--",
    "-- 每个 kind 只声称自己实际证明的事：",
    "--   acl               规范化的直接授权语义（NULL ACL 展开为隐式内建默认），",
    "--                     **不是**物理 catalog 里存在的 ACL 行；",
    "--   default-row       pg_default_acl 的**物理行**存在性（含 empty 标志）；",
    "--   default-global /  物理行展开后的条目——**决定执行哪条 default DDL**；",
    "--   default-schema",
    "--   default-effective 按 PostgreSQL 真实语义叠加出的有效默认权限，",
    "--                     **只用于语义验证**，不得据此反推 DDL；",
    "--   default-unmapped  未知 defaclobjtype 的 fail-closed 标记（健康库恒为空）；",
    "--   effective         has_*_privilege 的探测结果（含 PUBLIC 派生与角色继承）；",
    "--   owner /           归属；",
    "--   large-object",
    "--   type-class        类型分类与数组类型的委托关系；",
    "--   role              参与 effective 探测的角色集合——**覆盖面证据**，",
    "--                     不是允许角色白名单。",
    "",
    `${renderAuthorizationProjectionSql(manifest)};`,
    "",
  ].join("\n");
