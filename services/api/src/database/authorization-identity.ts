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
