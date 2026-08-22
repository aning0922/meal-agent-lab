/**
 * 阶段 09A / M2A（R8B）：授权事实的 **canonical identity 编码**。
 *
 * 单独成模块的原因是它同时被 manifest（期望值）与 projector（观察）使用，放在
 * 任何一侧都会造成循环导入。它本身不含任何期望值，也不含任何 SQL。
 *
 * identity 不是未转义的 `#`/`@`/`|` 拼接串——含这些字符（或引号）的合法角色名与
 * 对象名会造成歧义甚至碰撞。改用 **JSON 数组**：结构化、可证明无歧义，且
 * PostgreSQL 与 Node 两侧使用同一表示。消费方只能按下标做**结构化**访问
 * （SQL 侧 `->` / `->>`，TS 侧数组下标），**不得**用 `split_part`、正则或任何
 * 字符串拆分反向解析 identity。
 */

/**
 * **UTF-8 字节序**比较——与 PostgreSQL 的 `COLLATE "C"` 逐字节等价。
 *
 * 为什么不能用 JavaScript 的默认字符串比较：`<` / `Array#sort` 比的是 **UTF-16
 * 码元**。对补充平面字符（U+10000 及以上，用代理对表示），两种顺序会真的分叉：
 * U+FFFD 的 UTF-8 是 `EF BF BD`、U+10000 是 `F0 90 80 80`，字节序里 U+FFFD 在
 * 前；而 UTF-16 码元序里 U+10000 的高位代理 `D800` 小于 `FFFD`，顺序正好相反。
 *
 * exact-ledger 的 state identity 由「排序后的 migration 文件名」构成，而
 * PostgreSQL 现场用 `ORDER BY name COLLATE "C"` 排。两侧一旦用不同的序，同一批
 * 文件就会算出不同的 identity——已登记状态会被判成未登记，或者更糟，反过来。
 * 因此 Node 侧的 ledger 排序与 migration 文件排序都必须走这一个 comparator。
 */
export const byUtf8Bytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export type ProjectionIdentityPart = string | readonly ProjectionIdentityPart[];

/**
 * canonical identity 的 **Node 侧**编码，必须与 PostgreSQL
 * `jsonb_build_array(...)::text` 的输出逐字节相同：JSON 数组、元素间 `, `
 * （逗号加一个空格）。数据库测试用含 `#`、`@`、`|`、引号的名字证明两侧一致。
 */
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

export type ProjectionObjectClass = (typeof projectionObjectClasses)[number];

/**
 * 固定允许授权只可能落在这四类对象上。type / column / language / Large Object
 * 与 20 个 LO 入口点由**策略**判定（分别是「只有 owner」「一律不允许」「内建
 * owner + PUBLIC USAGE」「只有函数 owner」），manifest 不得为它们登记允许项。
 */
export const grantableObjectClasses = Object.freeze([
  "database",
  "relation",
  "routine",
  "schema",
] as const);

/** `pg_default_acl` 里 global 作用域在投影中的 scope 取值。 */
export const globalDefaultScope = "-";

/**
 * 所有 renderer **共用**的渲染守卫。
 *
 * 三个 renderer（projection / policy / manifest-sql）都会把 manifest 里的值原样
 * 拼进高权限 SQL：收敛块会 `SET LOCAL ROLE`、`GRANT`、`REVOKE`、`ALTER DEFAULT
 * PRIVILEGES`。因此值里出现的任何 SQL token 都必须在**渲染之前**被拒绝，而不是
 * 指望某一层恰好做了转义——三层各写一份守卫，迟早会有一层漏掉。
 *
 * 拒绝的内容：
 *
 * - 会破坏文本结构的字符：反斜杠、CR、LF、NUL；
 * - 会终止或注入语句的 token：单引号、双引号、分号、`--`、`/*`、`*` + `/`；
 * - 三个 dollar-quote 标签（一旦出现在值里就能提前关闭 `DO` 块）。
 *
 * 合法的项目角色名、schema 名、对象名、权限名与 objtype 都不含这些 token，因此
 * 这条守卫不会误伤真实数据；catalog 里**观察到**的奇怪名字不走这里——它们经
 * `jsonb_build_array` 与 `quote_ident` 在运行时处理，R8A 的特殊字符 identity
 * 证据因此不受影响。
 */
export const authorizationDollarQuoteTags = Object.freeze([
  "$meal_agent_authorization_converge$",
  "$meal_agent_authorization_verify$",
  "$meal_agent_authorization_projection$",
] as const);

const forbiddenRenderTokens: readonly string[] = Object.freeze([
  "\\",
  "\r",
  "\n",
  String.fromCharCode(0),
  "'",
  '"',
  ";",
  "--",
  "/*",
  "*/",
  ...authorizationDollarQuoteTags,
]);

export class AuthorizationRenderError extends Error {
  public constructor(detail: string) {
    super(`authorization renderer: ${detail}`);
    this.name = "AuthorizationRenderError";
  }
}

export const assertRenderableValue = (field: string, value: string): string => {
  for (const token of forbiddenRenderTokens) {
    if (value.includes(token)) {
      throw new AuthorizationRenderError(
        `${field} contains ${JSON.stringify(token)}, which cannot be rendered ` +
          `into a privileged SQL statement: ${JSON.stringify(value)}`,
      );
    }
  }
  return value;
};

/**
 * 每类受监管对象**精确**的权限集合。收敛块会把这些名字直接拼进 `GRANT` /
 * `REVOKE`，因此它们必须是穷尽的固定枚举，而不是「看起来像权限名就放行」。
 *
 * `relation` 是 table 与 sequence 的并集：manifest 的对象键不区分二者，而
 * PostgreSQL 会在语句层拒绝不适用的组合。
 */
export const objectClassPrivileges: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  database: Object.freeze(["CONNECT", "CREATE", "TEMPORARY"]),
  schema: Object.freeze(["CREATE", "USAGE"]),
  relation: Object.freeze([
    "DELETE",
    "INSERT",
    "MAINTAIN",
    "REFERENCES",
    "SELECT",
    "TRIGGER",
    "TRUNCATE",
    "UPDATE",
    "USAGE",
  ]),
  routine: Object.freeze(["EXECUTE"]),
});

/**
 * 每种 `pg_default_acl.defaclobjtype` 精确的权限集合，以及它能否带 schema 作用域。
 * PostgreSQL 只允许 table/sequence/function/type 出现在 `IN SCHEMA` 形式里；
 * schema 与 large object 只有全局形式。
 */
export const defaultObjtypeRules: Readonly<
  Record<string, { readonly privileges: readonly string[]; readonly schemaScoped: boolean }>
> = Object.freeze({
  L: Object.freeze({
    privileges: Object.freeze(["SELECT", "UPDATE"]),
    schemaScoped: false,
  }),
  S: Object.freeze({
    privileges: Object.freeze(["SELECT", "UPDATE", "USAGE"]),
    schemaScoped: true,
  }),
  T: Object.freeze({ privileges: Object.freeze(["USAGE"]), schemaScoped: true }),
  f: Object.freeze({
    privileges: Object.freeze(["EXECUTE"]),
    schemaScoped: true,
  }),
  n: Object.freeze({
    privileges: Object.freeze(["CREATE", "USAGE"]),
    schemaScoped: false,
  }),
  r: Object.freeze({
    privileges: Object.freeze([
      "DELETE",
      "INSERT",
      "MAINTAIN",
      "REFERENCES",
      "SELECT",
      "TRIGGER",
      "TRUNCATE",
      "UPDATE",
    ]),
    schemaScoped: true,
  }),
});
