import { createHash } from "node:crypto";

/**
 * 阶段 09A / M2A：冻结的 `0000_stage_06.sql` 应用之后，「对象与安全属性投影」的
 * **唯一事实源**。
 *
 * 为什么是这个形状：
 *
 *   1. 之前 `migrate.ts` 与 `01-owner-handoff.sql` 各自维护一份手写对象清单。
 *      两份清单会独立漂移，而且都只覆盖「有没有这个对象」，覆盖不到 RLS、policy、
 *      `proconfig`、列定义、约束定义这些真正决定安全边界的属性。
 *   2. 这里改为**单一 typed manifest**：它描述冻结 0000（外加 migration runner
 *      建立的 drizzle ledger）执行完毕后，catalog 中与安全相关的规范化投影。
 *      两个入口都从它渲染出同一段纯 SQL，不再各写一遍。
 *   3. manifest **不是**从 `0000_stage_06.sql` 正则推导出来的。它是在真实
 *      PostgreSQL 18 上执行冻结 0000 之后，从 catalog 采集并冻结下来的规范化投影；
 *      `stage09a.roles.database.test.ts` 的 semantic parity 用例持续证明这一点。
 *
 * owner 语义分两种策略，且**与 handoff 阶段有关**：
 *
 *   - `migrator`：必须精确是 `meal_agent_migrator`。业务对象在 0000 里就已经
 *     `OWNER TO meal_agent_migrator`，因此与阶段无关。
 *   - `handoff-pending`：`public` / `drizzle` schema、drizzle ledger 及其数组类型
 *     在 owner handoff **之前**属于 bootstrap admin 或 `pg_database_owner`，
 *     之后属于 migrator。**handoff 完成之后，这些对象也必须精确是 migrator**——
 *     判定依据是可观察的事实：目标 database 的 owner 是否已经是
 *     `meal_agent_migrator`（handoff 的第一条 mutation 就是 `ALTER DATABASE
 *     ... OWNER TO`，且整段在同一事务内）。因此 `handoff-pending` 不是「永远
 *     放行 admin」，只是如实表达那个有界的过渡态。
 */

/** 关系类型：0000 只建普通表，其余取值用于把「意外出现的对象」如实呈现。 */
export type Stage06RelationKind = "r" | "p" | "v" | "m" | "S" | "f";

/** owner 策略，语义见文件头。 */
export type Stage06OwnerPolicy = "migrator" | "handoff-pending";

export interface Stage06DatabaseEntry {
  readonly owner: Stage06OwnerPolicy;
}

export interface Stage06SchemaEntry {
  readonly name: string;
  readonly owner: Stage06OwnerPolicy;
}

export interface Stage06RelationEntry {
  readonly schema: string;
  readonly name: string;
  readonly relkind: Stage06RelationKind;
  readonly owner: Stage06OwnerPolicy;
  /** `p` = permanent、`u` = unlogged、`t` = temporary。 */
  readonly persistence: string;
  readonly rowSecurity: boolean;
  readonly forceRowSecurity: boolean;
}

export interface Stage06ColumnEntry {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /** 列序号：改变列顺序也算漂移。 */
  readonly attnum: number;
  readonly type: string;
  readonly notNull: boolean;
  readonly identity: string;
  readonly generated: string;
  readonly storage: string;
  readonly compression: string;
  readonly collation: string;
  readonly default: string;
}

export interface Stage06IndexEntry {
  readonly schema: string;
  readonly name: string;
  /** `schema.table`，与 `definition` 互相印证。 */
  readonly table: string;
  readonly valid: boolean;
  readonly ready: boolean;
  /** `pg_get_indexdef` 的规范化输出（`search_path` 与 `quote_all_identifiers` 固定）。 */
  readonly definition: string;
}

export interface Stage06ConstraintEntry {
  readonly schema: string;
  /** 约束宿主：表名，或域约束的域名，都没有时为 `-`。 */
  readonly parent: string;
  readonly name: string;
  /**
   * `pg_constraint.contype`：`p`/`u`/`f`/`c`/`n`。PostgreSQL 18 把 NOT NULL 也
   * 登记为约束，因此约束漂移里也包含「某列的 NOT NULL 被去掉」。
   */
  readonly contype: string;
  readonly validated: boolean;
  readonly definition: string;
}

export interface Stage06RoutineEntry {
  readonly schema: string;
  readonly name: string;
  /** `pg_get_function_identity_arguments`，因此同名 overload 是不同 identity。 */
  readonly identityArguments: string;
  readonly prokind: string;
  readonly owner: Stage06OwnerPolicy;
  readonly securityDefiner: boolean;
  readonly language: string;
  readonly volatility: string;
  readonly parallelSafety: string;
  readonly leakproof: boolean;
  readonly strict: boolean;
  readonly returnsSet: boolean;
  readonly result: string;
  /** `proconfig`，按原始顺序；固定 `search_path` 与 `row_security=off` 就在这里。 */
  readonly config: readonly string[];
  /** 正文摘要：`sha256(prosrc)`，不把函数正文整段搬进 manifest。 */
  readonly bodyDigest: string;
}

export interface Stage06PolicyEntry {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /** `pg_policy.polcmd`：`r`/`a`/`w`/`d`/`*`。 */
  readonly command: string;
  readonly permissive: boolean;
  /** 角色名，按 C collation 排序；`PUBLIC` 表示 `polroles = {0}`。 */
  readonly roles: readonly string[];
  readonly using: string;
  readonly withCheck: string;
}

/**
 * 用户类型：**包含 shell 与 base 类型**。0000 自己不建类型，但每张表的行类型都
 * 会带来一个数组类型，它们同样是真实的 catalog 对象，owner 与属性都算安全面。
 */
export interface Stage06TypeEntry {
  readonly schema: string;
  readonly name: string;
  readonly typtype: string;
  readonly owner: Stage06OwnerPolicy;
  readonly category: string;
  readonly defined: boolean;
  readonly length: number;
  readonly byValue: boolean;
  readonly align: string;
  readonly storage: string;
  readonly notNull: boolean;
  readonly delimiter: string;
  readonly element: string;
  readonly baseType: string;
  readonly dimensions: number;
  readonly collation: string;
  readonly default: string;
}

export interface Stage06TriggerEntry {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /** `O`/`D`/`R`/`A`：`D` 表示被禁用。 */
  readonly enabled: string;
  readonly definition: string;
}

/**
 * 外键等约束背后的**内部触发器**。它们的名字里带 OID（`RI_ConstraintTrigger_a_…`）
 * 因此不能作为 identity；这里用「表 + 约束 + 触发器函数」定位。
 *
 * 覆盖它们的原因很实际：`ALTER TABLE … DISABLE TRIGGER ALL` 会把内部触发器一起
 * 置为 `D`，外键从此不再强制，而表结构、约束定义、RLS 全都看不出任何变化。
 */
export interface Stage06ConstraintTriggerEntry {
  readonly schema: string;
  readonly table: string;
  readonly constraint: string;
  readonly function: string;
  readonly enabled: string;
  readonly type: number;
  readonly deferrable: boolean;
  readonly initiallyDeferred: boolean;
}

export interface Stage06RuleEntry {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly enabled: string;
  readonly definition: string;
}

/**
 * 其余明确枚举的 namespace 对象类别：operator、opclass、opfamily、collation、
 * conversion、扩展统计、文本搜索四件套与 extension。0000 一个都不建，因此
 * manifest 为空、出现即 `unexpected`。
 */
export interface Stage06NamespaceObjectEntry {
  readonly category: string;
  readonly schema: string;
  readonly identity: string;
  readonly detail: string;
}

export interface Stage06Manifest {
  readonly version: number;
  readonly database: Stage06DatabaseEntry;
  readonly schemas: readonly Stage06SchemaEntry[];
  readonly relations: readonly Stage06RelationEntry[];
  readonly columns: readonly Stage06ColumnEntry[];
  readonly indexes: readonly Stage06IndexEntry[];
  readonly constraints: readonly Stage06ConstraintEntry[];
  readonly routines: readonly Stage06RoutineEntry[];
  readonly policies: readonly Stage06PolicyEntry[];
  readonly types: readonly Stage06TypeEntry[];
  readonly triggers: readonly Stage06TriggerEntry[];
  readonly constraintTriggers: readonly Stage06ConstraintTriggerEntry[];
  readonly rules: readonly Stage06RuleEntry[];
  readonly namespaceObjects: readonly Stage06NamespaceObjectEntry[];
}

export class Stage06ManifestError extends Error {
  public constructor(detail: string) {
    super(`stage06 manifest: ${detail}`);
    this.name = "Stage06ManifestError";
  }
}

/**
 * manifest 的版本。渲染出的 generated SQL 会带上它；改变 manifest 结构或内容都
 * 必须重新生成 adapter，`manifest:check` 会挡住忘记重新生成的提交。
 */
export const stage06ManifestVersion = 2;

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
};

const manifestData: Stage06Manifest = {
  version: stage06ManifestVersion,
  database: { owner: "handoff-pending" },
  schemas: [
    { name: "drizzle", owner: "handoff-pending" },
    { name: "meal_agent_private", owner: "migrator" },
    { name: "public", owner: "handoff-pending" },
  ],
  relations: [
    { schema: "drizzle", name: "__meal_agent_migrations", relkind: "r",
      owner: "handoff-pending", persistence: "p",
      rowSecurity: false, forceRowSecurity: false },
    { schema: "public", name: "auth_identities", relkind: "r",
      owner: "migrator", persistence: "p",
      rowSecurity: false, forceRowSecurity: false },
    { schema: "public", name: "households", relkind: "r",
      owner: "migrator", persistence: "p",
      rowSecurity: true, forceRowSecurity: true },
    { schema: "public", name: "idempotency_records", relkind: "r",
      owner: "migrator", persistence: "p",
      rowSecurity: true, forceRowSecurity: true },
    { schema: "public", name: "inventory_events", relkind: "r",
      owner: "migrator", persistence: "p",
      rowSecurity: true, forceRowSecurity: true },
    { schema: "public", name: "inventory_lots", relkind: "r",
      owner: "migrator", persistence: "p",
      rowSecurity: true, forceRowSecurity: true },
    { schema: "public", name: "memberships", relkind: "r",
      owner: "migrator", persistence: "p",
      rowSecurity: true, forceRowSecurity: true },
    { schema: "public", name: "person_profiles", relkind: "r",
      owner: "migrator", persistence: "p",
      rowSecurity: true, forceRowSecurity: true },
    { schema: "public", name: "sessions", relkind: "r",
      owner: "migrator", persistence: "p",
      rowSecurity: false, forceRowSecurity: false },
    { schema: "public", name: "users", relkind: "r",
      owner: "migrator", persistence: "p",
      rowSecurity: false, forceRowSecurity: false },
  ],
  columns: [
    { schema: "drizzle", table: "__meal_agent_migrations", name: "name",
      attnum: 1, type: "text", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "drizzle", table: "__meal_agent_migrations", name: "hash",
      attnum: 2, type: "character(64)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "drizzle", table: "__meal_agent_migrations", name: "applied_at",
      attnum: 3, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "clock_timestamp()" },
    { schema: "public", table: "auth_identities", name: "id",
      attnum: 1, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "auth_identities", name: "user_id",
      attnum: 2, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "auth_identities", name: "provider",
      attnum: 3, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "auth_identities", name: "provider_tenant_key",
      attnum: 4, type: "character varying(128)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "auth_identities", name: "provider_subject",
      attnum: 5, type: "character varying(255)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "auth_identities", name: "provider_union_subject",
      attnum: 6, type: "character varying(255)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "auth_identities", name: "status",
      attnum: 7, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "auth_identities", name: "created_at",
      attnum: 8, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "auth_identities", name: "last_authenticated_at",
      attnum: 9, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "households", name: "id",
      attnum: 1, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "households", name: "name",
      attnum: 2, type: "character varying(80)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "households", name: "timezone",
      attnum: 3, type: "character varying(64)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "households", name: "locale",
      attnum: 4, type: "character varying(35)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "households", name: "status",
      attnum: 5, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "households", name: "created_by_user_id",
      attnum: 6, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "households", name: "created_at",
      attnum: 7, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "households", name: "updated_at",
      attnum: 8, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "households", name: "version",
      attnum: 9, type: "integer", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "0" },
    { schema: "public", table: "idempotency_records", name: "id",
      attnum: 1, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "idempotency_records", name: "scope_kind",
      attnum: 2, type: "character varying(16)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "idempotency_records", name: "user_id",
      attnum: 3, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "idempotency_records", name: "household_id",
      attnum: 4, type: "uuid", notNull: false,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "idempotency_records", name: "method",
      attnum: 5, type: "character varying(16)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "idempotency_records", name: "normalized_route",
      attnum: 6, type: "character varying(255)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "idempotency_records", name: "idempotency_key",
      attnum: 7, type: "character varying(128)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "idempotency_records", name: "request_hash",
      attnum: 8, type: "character(64)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "idempotency_records", name: "status_code",
      attnum: 9, type: "integer", notNull: false,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "idempotency_records", name: "response_body",
      attnum: 10, type: "jsonb", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "idempotency_records", name: "original_request_id",
      attnum: 11, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "idempotency_records", name: "first_processed_at",
      attnum: 12, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "idempotency_records", name: "expires_at",
      attnum: 13, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "id",
      attnum: 1, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "household_id",
      attnum: 2, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "inventory_lot_id",
      attnum: 3, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "type",
      attnum: 4, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "quantity_change_kind",
      attnum: 5, type: "character varying(32)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "quantity_change_amount",
      attnum: 6, type: "numeric(15,6)", notNull: false,
      identity: "", generated: "",
      storage: "m", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "quantity_change_unit",
      attnum: 7, type: "character varying(32)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "quantity_change_precision",
      attnum: 8, type: "character varying(16)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "quantity_change_confidence",
      attnum: 9, type: "character varying(16)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "quantity_change_original_text",
      attnum: 10, type: "character varying(200)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "quantity_from_level",
      attnum: 11, type: "character varying(16)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "quantity_to_level",
      attnum: 12, type: "character varying(16)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "from_storage_location",
      attnum: 13, type: "character varying(32)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "to_storage_location",
      attnum: 14, type: "character varying(32)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "correction_of_event_id",
      attnum: 15, type: "uuid", notNull: false,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "actor_user_id",
      attnum: 16, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "source",
      attnum: 17, type: "character varying(48)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "occurred_at",
      attnum: 18, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "recorded_at",
      attnum: 19, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "idempotency_key",
      attnum: 20, type: "character varying(128)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "normalized_route",
      attnum: 21, type: "character varying(255)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_events", name: "expected_lot_version",
      attnum: 22, type: "integer", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "resulting_lot_version",
      attnum: 23, type: "integer", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_events", name: "note",
      attnum: 24, type: "text", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "id",
      attnum: 1, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_lots", name: "household_id",
      attnum: 2, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_lots", name: "food_concept_id",
      attnum: 3, type: "uuid", notNull: false,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_lots", name: "display_name",
      attnum: 4, type: "character varying(120)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "state",
      attnum: 5, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "storage_location",
      attnum: 6, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "current_quantity_kind",
      attnum: 7, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "current_quantity_amount",
      attnum: 8, type: "numeric(15,6)", notNull: false,
      identity: "", generated: "",
      storage: "m", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_lots", name: "current_quantity_unit",
      attnum: 9, type: "character varying(32)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "current_quantity_original_text",
      attnum: 10, type: "character varying(200)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "current_quantity_confidence",
      attnum: 11, type: "character varying(16)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "current_quantity_level",
      attnum: 12, type: "character varying(16)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "dates",
      attnum: 13, type: "jsonb", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_lots", name: "safety_status",
      attnum: 14, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "safety_reason_codes",
      attnum: 15, type: "jsonb", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_lots", name: "safety_policy_version",
      attnum: 16, type: "character varying(100)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "safety_evaluated_at",
      attnum: 17, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_lots", name: "origin",
      attnum: 18, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "inventory_lots", name: "created_by_user_id",
      attnum: 19, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_lots", name: "created_at",
      attnum: 20, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_lots", name: "updated_at",
      attnum: 21, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "inventory_lots", name: "version",
      attnum: 22, type: "integer", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "memberships", name: "id",
      attnum: 1, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "memberships", name: "household_id",
      attnum: 2, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "memberships", name: "user_id",
      attnum: 3, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "memberships", name: "role",
      attnum: 4, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "memberships", name: "capabilities",
      attnum: 5, type: "jsonb", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "memberships", name: "status",
      attnum: 6, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "memberships", name: "joined_at",
      attnum: 7, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "memberships", name: "updated_at",
      attnum: 8, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "memberships", name: "version",
      attnum: 9, type: "integer", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "0" },
    { schema: "public", table: "person_profiles", name: "id",
      attnum: 1, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "person_profiles", name: "household_id",
      attnum: 2, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "person_profiles", name: "linked_membership_id",
      attnum: 3, type: "uuid", notNull: false,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "person_profiles", name: "display_name",
      attnum: 4, type: "character varying(80)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "person_profiles", name: "status",
      attnum: 5, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "person_profiles", name: "default_participation",
      attnum: 6, type: "integer", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "person_profiles", name: "default_portion_scale",
      attnum: 7, type: "numeric(6,3)", notNull: true,
      identity: "", generated: "",
      storage: "m", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "person_profiles", name: "cooking_skill",
      attnum: 8, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "person_profiles", name: "dietary_constraints",
      attnum: 9, type: "jsonb", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "person_profiles", name: "created_at",
      attnum: 10, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "person_profiles", name: "updated_at",
      attnum: 11, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "person_profiles", name: "version",
      attnum: 12, type: "integer", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "0" },
    { schema: "public", table: "sessions", name: "id",
      attnum: 1, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "sessions", name: "user_id",
      attnum: 2, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "sessions", name: "auth_identity_id",
      attnum: 3, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "sessions", name: "token_digest",
      attnum: 4, type: "character(64)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "sessions", name: "status",
      attnum: 5, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "sessions", name: "issued_at",
      attnum: 6, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "sessions", name: "expires_at",
      attnum: 7, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "sessions", name: "idle_expires_at",
      attnum: 8, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "sessions", name: "last_seen_at",
      attnum: 9, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "sessions", name: "revoked_at",
      attnum: 10, type: "timestamp with time zone", notNull: false,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "sessions", name: "token_version",
      attnum: 11, type: "integer", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "1" },
    { schema: "public", table: "users", name: "id",
      attnum: 1, type: "uuid", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "users", name: "status",
      attnum: 2, type: "character varying(32)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "users", name: "display_name",
      attnum: 3, type: "character varying(80)", notNull: false,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "users", name: "locale",
      attnum: 4, type: "character varying(35)", notNull: true,
      identity: "", generated: "",
      storage: "x", compression: "",
      collation: "default", default: "" },
    { schema: "public", table: "users", name: "created_at",
      attnum: 5, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "users", name: "updated_at",
      attnum: 6, type: "timestamp with time zone", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "" },
    { schema: "public", table: "users", name: "version",
      attnum: 7, type: "integer", notNull: true,
      identity: "", generated: "",
      storage: "p", compression: "",
      collation: "", default: "0" },
  ],
  indexes: [
    { schema: "drizzle", name: "__meal_agent_migrations_pkey", table: "drizzle.__meal_agent_migrations",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX __meal_agent_migrations_pkey ON drizzle.__meal_agent_migrations USING btree (name)" },
    { schema: "public", name: "auth_identities_id_user_unique", table: "public.auth_identities",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX auth_identities_id_user_unique ON public.auth_identities USING btree (id, user_id)" },
    { schema: "public", name: "auth_identities_pkey", table: "public.auth_identities",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX auth_identities_pkey ON public.auth_identities USING btree (id)" },
    { schema: "public", name: "auth_identities_provider_subject_unique", table: "public.auth_identities",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX auth_identities_provider_subject_unique ON public.auth_identities USING btree (provider, provider_tenant_key, provider_subject)" },
    { schema: "public", name: "households_pkey", table: "public.households",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX households_pkey ON public.households USING btree (id)" },
    { schema: "public", name: "idempotency_records_pkey", table: "public.idempotency_records",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX idempotency_records_pkey ON public.idempotency_records USING btree (id)" },
    { schema: "public", name: "idempotency_records_scope_unique", table: "public.idempotency_records",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX idempotency_records_scope_unique ON public.idempotency_records USING btree (user_id, household_id, method, normalized_route, idempotency_key) NULLS NOT DISTINCT" },
    { schema: "public", name: "inventory_events_household_actor_route_idempotency_unique", table: "public.inventory_events",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX inventory_events_household_actor_route_idempotency_unique ON public.inventory_events USING btree (household_id, actor_user_id, normalized_route, idempotency_key)" },
    { schema: "public", name: "inventory_events_household_id_unique", table: "public.inventory_events",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX inventory_events_household_id_unique ON public.inventory_events USING btree (household_id, id)" },
    { schema: "public", name: "inventory_events_lot_recorded_index", table: "public.inventory_events",
      valid: true, ready: true,
      definition:
        "CREATE INDEX inventory_events_lot_recorded_index ON public.inventory_events USING btree (household_id, inventory_lot_id, recorded_at, id)" },
    { schema: "public", name: "inventory_events_pkey", table: "public.inventory_events",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX inventory_events_pkey ON public.inventory_events USING btree (id)" },
    { schema: "public", name: "inventory_lots_household_created_index", table: "public.inventory_lots",
      valid: true, ready: true,
      definition:
        "CREATE INDEX inventory_lots_household_created_index ON public.inventory_lots USING btree (household_id, created_at, id)" },
    { schema: "public", name: "inventory_lots_household_id_unique", table: "public.inventory_lots",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX inventory_lots_household_id_unique ON public.inventory_lots USING btree (household_id, id)" },
    { schema: "public", name: "inventory_lots_pkey", table: "public.inventory_lots",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX inventory_lots_pkey ON public.inventory_lots USING btree (id)" },
    { schema: "public", name: "memberships_household_id_unique", table: "public.memberships",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX memberships_household_id_unique ON public.memberships USING btree (household_id, id)" },
    { schema: "public", name: "memberships_household_user_unique", table: "public.memberships",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX memberships_household_user_unique ON public.memberships USING btree (household_id, user_id)" },
    { schema: "public", name: "memberships_pkey", table: "public.memberships",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX memberships_pkey ON public.memberships USING btree (id)" },
    { schema: "public", name: "memberships_user_active_index", table: "public.memberships",
      valid: true, ready: true,
      definition:
        "CREATE INDEX memberships_user_active_index ON public.memberships USING btree (user_id, household_id) WHERE ((status)::text = 'active'::text)" },
    { schema: "public", name: "person_profiles_household_id_unique", table: "public.person_profiles",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX person_profiles_household_id_unique ON public.person_profiles USING btree (household_id, id)" },
    { schema: "public", name: "person_profiles_linked_membership_unique", table: "public.person_profiles",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX person_profiles_linked_membership_unique ON public.person_profiles USING btree (household_id, linked_membership_id) WHERE (linked_membership_id IS NOT NULL)" },
    { schema: "public", name: "person_profiles_pkey", table: "public.person_profiles",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX person_profiles_pkey ON public.person_profiles USING btree (id)" },
    { schema: "public", name: "sessions_pkey", table: "public.sessions",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (id)" },
    { schema: "public", name: "sessions_token_digest_unique", table: "public.sessions",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX sessions_token_digest_unique ON public.sessions USING btree (token_digest)" },
    { schema: "public", name: "users_pkey", table: "public.users",
      valid: true, ready: true,
      definition:
        "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)" },
  ],
  constraints: [
    { schema: "drizzle", parent: "__meal_agent_migrations", name: "__meal_agent_migrations_applied_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL applied_at" },
    { schema: "drizzle", parent: "__meal_agent_migrations", name: "__meal_agent_migrations_hash_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL hash" },
    { schema: "drizzle", parent: "__meal_agent_migrations", name: "__meal_agent_migrations_name_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL name" },
    { schema: "drizzle", parent: "__meal_agent_migrations", name: "__meal_agent_migrations_pkey",
      contype: "p", validated: true,
      definition:
        "PRIMARY KEY (name)" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_created_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL created_at" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL id" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_id_user_unique",
      contype: "u", validated: true,
      definition:
        "UNIQUE (id, user_id)" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_last_authenticated_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL last_authenticated_at" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_pkey",
      contype: "p", validated: true,
      definition:
        "PRIMARY KEY (id)" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_provider_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((provider)::text = ANY ((ARRAY['wechat_miniprogram'::character varying, 'phone'::character varying, 'apple'::character varying, 'huawei'::character varying])::text[])))" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_provider_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL provider" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_provider_subject_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL provider_subject" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_provider_subject_unique",
      contype: "u", validated: true,
      definition:
        "UNIQUE (provider, provider_tenant_key, provider_subject)" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_provider_tenant_key_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL provider_tenant_key" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_status_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying])::text[])))" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_status_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL status" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_user_id_fkey",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (user_id) REFERENCES public.users(id)" },
    { schema: "public", parent: "auth_identities", name: "auth_identities_user_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL user_id" },
    { schema: "public", parent: "households", name: "households_created_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL created_at" },
    { schema: "public", parent: "households", name: "households_created_by_user_id_fkey",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (created_by_user_id) REFERENCES public.users(id)" },
    { schema: "public", parent: "households", name: "households_created_by_user_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL created_by_user_id" },
    { schema: "public", parent: "households", name: "households_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL id" },
    { schema: "public", parent: "households", name: "households_locale_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL locale" },
    { schema: "public", parent: "households", name: "households_name_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL name" },
    { schema: "public", parent: "households", name: "households_pkey",
      contype: "p", validated: true,
      definition:
        "PRIMARY KEY (id)" },
    { schema: "public", parent: "households", name: "households_status_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'deletion_pending'::character varying, 'deleted'::character varying])::text[])))" },
    { schema: "public", parent: "households", name: "households_status_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL status" },
    { schema: "public", parent: "households", name: "households_timezone_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL timezone" },
    { schema: "public", parent: "households", name: "households_updated_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL updated_at" },
    { schema: "public", parent: "households", name: "households_version_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((version >= 0))" },
    { schema: "public", parent: "households", name: "households_version_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL version" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_completion_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((status_code IS NULL) = (response_body IS NULL)))" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_expires_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL expires_at" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_first_processed_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL first_processed_at" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL id" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_idempotency_key_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL idempotency_key" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_membership_foreign",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (household_id, user_id) REFERENCES public.memberships(household_id, user_id)" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_method_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL method" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_normalized_route_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL normalized_route" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_original_request_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL original_request_id" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_pkey",
      contype: "p", validated: true,
      definition:
        "PRIMARY KEY (id)" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_request_hash_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL request_hash" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_scope_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((((scope_kind)::text = 'user'::text) AND (household_id IS NULL)) OR (((scope_kind)::text = 'household'::text) AND (household_id IS NOT NULL))))" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_scope_kind_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL scope_kind" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_scope_unique",
      contype: "u", validated: true,
      definition:
        "UNIQUE NULLS NOT DISTINCT (user_id, household_id, method, normalized_route, idempotency_key)" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_status_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((status_code IS NULL) OR ((status_code >= 200) AND (status_code <= 299))))" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_user_id_fkey",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (user_id) REFERENCES public.users(id)" },
    { schema: "public", parent: "idempotency_records", name: "idempotency_records_user_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL user_id" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_actor_membership_foreign",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (household_id, actor_user_id) REFERENCES public.memberships(household_id, user_id)" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_actor_user_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL actor_user_id" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_correction_foreign",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (household_id, correction_of_event_id) REFERENCES public.inventory_events(household_id, id)" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_expected_lot_version_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL expected_lot_version" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_household_actor_route_idempotency_unique",
      contype: "u", validated: true,
      definition:
        "UNIQUE (household_id, actor_user_id, normalized_route, idempotency_key)" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_household_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL household_id" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_household_id_unique",
      contype: "u", validated: true,
      definition:
        "UNIQUE (household_id, id)" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL id" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_idempotency_key_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL idempotency_key" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_inventory_lot_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL inventory_lot_id" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_lot_foreign",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (household_id, inventory_lot_id) REFERENCES public.inventory_lots(household_id, id)" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_normalized_route_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL normalized_route" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_occurred_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL occurred_at" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_pkey",
      contype: "p", validated: true,
      definition:
        "PRIMARY KEY (id)" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_quantity_shape_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((((quantity_change_kind IS NULL) AND (quantity_change_amount IS NULL) AND (quantity_from_level IS NULL) AND (quantity_to_level IS NULL)) OR (((quantity_change_kind)::text = 'numeric'::text) AND (quantity_change_amount IS NOT NULL) AND (quantity_change_amount <> (0)::numeric) AND (quantity_change_unit IS NOT NULL) AND ((quantity_change_precision)::text = ANY ((ARRAY['exact'::character varying, 'estimated'::character varying])::text[])) AND (quantity_from_level IS NULL) AND (quantity_to_level IS NULL) AND ((((quantity_change_precision)::text = 'exact'::text) AND (quantity_change_confidence IS NULL)) OR (((quantity_change_precision)::text = 'estimated'::text) AND ((quantity_change_confidence)::text = ANY ((ARRAY['high'::character varying, 'medium'::character varying, 'low'::character varying])::text[])) AND (quantity_change_original_text IS NOT NULL)))) OR (((quantity_change_kind)::text = 'qualitative'::text) AND (quantity_change_amount IS NULL) AND (quantity_change_unit IS NULL) AND (quantity_change_precision IS NULL) AND ((quantity_from_level)::text = ANY ((ARRAY['plenty'::character varying, 'some'::character varying, 'low'::character varying, 'empty'::character varying, 'unknown'::character varying])::text[])) AND ((quantity_to_level)::text = ANY ((ARRAY['plenty'::character varying, 'some'::character varying, 'low'::character varying, 'empty'::character varying, 'unknown'::character varying])::text[])) AND ((quantity_from_level)::text <> (quantity_to_level)::text))))" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_recorded_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL recorded_at" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_resulting_lot_version_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL resulting_lot_version" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_source_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL source" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_type_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL type" },
    { schema: "public", parent: "inventory_events", name: "inventory_events_version_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((expected_lot_version >= 0) AND (resulting_lot_version = (expected_lot_version + 1))))" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_created_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL created_at" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_created_by_user_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL created_by_user_id" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_creator_membership_foreign",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (household_id, created_by_user_id) REFERENCES public.memberships(household_id, user_id)" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_current_quantity_kind_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL current_quantity_kind" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_dates_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((jsonb_typeof(dates) = 'array'::text) AND (jsonb_array_length(dates) <= 9)))" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_dates_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL dates" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_display_name_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL display_name" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_household_id_fkey",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (household_id) REFERENCES public.households(id)" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_household_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL household_id" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_household_id_unique",
      contype: "u", validated: true,
      definition:
        "UNIQUE (household_id, id)" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL id" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_origin_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((origin)::text = ANY ((ARRAY['manual'::character varying, 'shopping_confirmation'::character varying, 'leftover'::character varying, 'confirmed_import'::character varying])::text[])))" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_origin_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL origin" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_pkey",
      contype: "p", validated: true,
      definition:
        "PRIMARY KEY (id)" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_quantity_shape_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((((current_quantity_kind)::text = 'exact'::text) AND (current_quantity_amount IS NOT NULL) AND (current_quantity_amount >= (0)::numeric) AND (current_quantity_unit IS NOT NULL) AND (current_quantity_confidence IS NULL) AND (current_quantity_level IS NULL)) OR (((current_quantity_kind)::text = 'approximate'::text) AND (current_quantity_amount IS NOT NULL) AND (current_quantity_amount >= (0)::numeric) AND (current_quantity_unit IS NOT NULL) AND ((current_quantity_confidence)::text = ANY ((ARRAY['high'::character varying, 'medium'::character varying, 'low'::character varying])::text[])) AND (current_quantity_original_text IS NOT NULL) AND (current_quantity_level IS NULL)) OR (((current_quantity_kind)::text = 'qualitative'::text) AND (current_quantity_amount IS NULL) AND (current_quantity_unit IS NULL) AND (current_quantity_confidence IS NULL) AND ((current_quantity_level)::text = ANY ((ARRAY['plenty'::character varying, 'some'::character varying, 'low'::character varying, 'empty'::character varying, 'unknown'::character varying])::text[])))))" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_safety_evaluated_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL safety_evaluated_at" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_safety_policy_version_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL safety_policy_version" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_safety_reason_codes_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((jsonb_typeof(safety_reason_codes) = 'array'::text))" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_safety_reason_codes_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL safety_reason_codes" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_safety_status_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((safety_status)::text = ANY ((ARRAY['eligible'::character varying, 'blocked'::character varying, 'unknown'::character varying])::text[])))" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_safety_status_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL safety_status" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_state_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((state)::text = ANY ((ARRAY['active'::character varying, 'depleted'::character varying, 'discarded'::character varying])::text[])))" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_state_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL state" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_state_quantity_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((((state)::text = 'active'::text) AND ((((current_quantity_kind)::text = ANY ((ARRAY['exact'::character varying, 'approximate'::character varying])::text[])) AND (current_quantity_amount > (0)::numeric)) OR (((current_quantity_kind)::text = 'qualitative'::text) AND ((current_quantity_level)::text <> 'empty'::text)))) OR (((state)::text = ANY ((ARRAY['depleted'::character varying, 'discarded'::character varying])::text[])) AND ((((current_quantity_kind)::text = 'exact'::text) AND (current_quantity_amount = (0)::numeric)) OR (((current_quantity_kind)::text = 'qualitative'::text) AND ((current_quantity_level)::text = 'empty'::text))))))" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_storage_location_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((storage_location)::text = ANY ((ARRAY['pantry'::character varying, 'refrigerated'::character varying, 'frozen'::character varying, 'other'::character varying])::text[])))" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_storage_location_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL storage_location" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_updated_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL updated_at" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_version_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((version > 0))" },
    { schema: "public", parent: "inventory_lots", name: "inventory_lots_version_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL version" },
    { schema: "public", parent: "memberships", name: "memberships_capabilities_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((jsonb_typeof(capabilities) = 'array'::text))" },
    { schema: "public", parent: "memberships", name: "memberships_capabilities_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL capabilities" },
    { schema: "public", parent: "memberships", name: "memberships_household_id_fkey",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (household_id) REFERENCES public.households(id)" },
    { schema: "public", parent: "memberships", name: "memberships_household_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL household_id" },
    { schema: "public", parent: "memberships", name: "memberships_household_id_unique",
      contype: "u", validated: true,
      definition:
        "UNIQUE (household_id, id)" },
    { schema: "public", parent: "memberships", name: "memberships_household_user_unique",
      contype: "u", validated: true,
      definition:
        "UNIQUE (household_id, user_id)" },
    { schema: "public", parent: "memberships", name: "memberships_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL id" },
    { schema: "public", parent: "memberships", name: "memberships_joined_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL joined_at" },
    { schema: "public", parent: "memberships", name: "memberships_pkey",
      contype: "p", validated: true,
      definition:
        "PRIMARY KEY (id)" },
    { schema: "public", parent: "memberships", name: "memberships_role_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'member'::character varying])::text[])))" },
    { schema: "public", parent: "memberships", name: "memberships_role_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL role" },
    { schema: "public", parent: "memberships", name: "memberships_status_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'left'::character varying, 'removed'::character varying])::text[])))" },
    { schema: "public", parent: "memberships", name: "memberships_status_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL status" },
    { schema: "public", parent: "memberships", name: "memberships_updated_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL updated_at" },
    { schema: "public", parent: "memberships", name: "memberships_user_id_fkey",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (user_id) REFERENCES public.users(id)" },
    { schema: "public", parent: "memberships", name: "memberships_user_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL user_id" },
    { schema: "public", parent: "memberships", name: "memberships_version_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((version >= 0))" },
    { schema: "public", parent: "memberships", name: "memberships_version_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL version" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_cooking_skill_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((cooking_skill)::text = ANY ((ARRAY['none'::character varying, 'beginner'::character varying, 'intermediate'::character varying, 'advanced'::character varying])::text[])))" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_cooking_skill_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL cooking_skill" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_created_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL created_at" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_default_participation_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((default_participation = ANY (ARRAY[0, 1])))" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_default_participation_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL default_participation" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_default_portion_scale_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((default_portion_scale >= 0.25) AND (default_portion_scale <= (4)::numeric)))" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_default_portion_scale_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL default_portion_scale" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_dietary_constraints_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((jsonb_typeof(dietary_constraints) = 'array'::text))" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_dietary_constraints_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL dietary_constraints" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_display_name_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL display_name" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_household_id_fkey",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (household_id) REFERENCES public.households(id)" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_household_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL household_id" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_household_id_unique",
      contype: "u", validated: true,
      definition:
        "UNIQUE (household_id, id)" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL id" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_membership_foreign",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (household_id, linked_membership_id) REFERENCES public.memberships(household_id, id)" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_pkey",
      contype: "p", validated: true,
      definition:
        "PRIMARY KEY (id)" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_status_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_status_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL status" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_updated_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL updated_at" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_version_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((version >= 0))" },
    { schema: "public", parent: "person_profiles", name: "person_profiles_version_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL version" },
    { schema: "public", parent: "sessions", name: "sessions_auth_identity_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL auth_identity_id" },
    { schema: "public", parent: "sessions", name: "sessions_expires_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL expires_at" },
    { schema: "public", parent: "sessions", name: "sessions_expiry_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((expires_at > issued_at) AND (idle_expires_at > issued_at)))" },
    { schema: "public", parent: "sessions", name: "sessions_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL id" },
    { schema: "public", parent: "sessions", name: "sessions_identity_user_foreign",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (auth_identity_id, user_id) REFERENCES public.auth_identities(id, user_id)" },
    { schema: "public", parent: "sessions", name: "sessions_idle_expires_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL idle_expires_at" },
    { schema: "public", parent: "sessions", name: "sessions_issued_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL issued_at" },
    { schema: "public", parent: "sessions", name: "sessions_last_seen_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL last_seen_at" },
    { schema: "public", parent: "sessions", name: "sessions_pkey",
      contype: "p", validated: true,
      definition:
        "PRIMARY KEY (id)" },
    { schema: "public", parent: "sessions", name: "sessions_revoked_at_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((((status)::text = 'revoked'::text) = (revoked_at IS NOT NULL)))" },
    { schema: "public", parent: "sessions", name: "sessions_status_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'expired'::character varying, 'revoked'::character varying])::text[])))" },
    { schema: "public", parent: "sessions", name: "sessions_status_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL status" },
    { schema: "public", parent: "sessions", name: "sessions_token_digest_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL token_digest" },
    { schema: "public", parent: "sessions", name: "sessions_token_digest_unique",
      contype: "u", validated: true,
      definition:
        "UNIQUE (token_digest)" },
    { schema: "public", parent: "sessions", name: "sessions_token_version_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((token_version > 0))" },
    { schema: "public", parent: "sessions", name: "sessions_token_version_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL token_version" },
    { schema: "public", parent: "sessions", name: "sessions_user_id_fkey",
      contype: "f", validated: true,
      definition:
        "FOREIGN KEY (user_id) REFERENCES public.users(id)" },
    { schema: "public", parent: "sessions", name: "sessions_user_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL user_id" },
    { schema: "public", parent: "users", name: "users_created_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL created_at" },
    { schema: "public", parent: "users", name: "users_id_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL id" },
    { schema: "public", parent: "users", name: "users_locale_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL locale" },
    { schema: "public", parent: "users", name: "users_pkey",
      contype: "p", validated: true,
      definition:
        "PRIMARY KEY (id)" },
    { schema: "public", parent: "users", name: "users_status_check",
      contype: "c", validated: true,
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying, 'deletion_pending'::character varying])::text[])))" },
    { schema: "public", parent: "users", name: "users_status_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL status" },
    { schema: "public", parent: "users", name: "users_updated_at_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL updated_at" },
    { schema: "public", parent: "users", name: "users_version_check",
      contype: "c", validated: true,
      definition:
        "CHECK ((version >= 0))" },
    { schema: "public", parent: "users", name: "users_version_not_null",
      contype: "n", validated: true,
      definition:
        "NOT NULL version" },
  ],
  routines: [
    { schema: "meal_agent_private", name: "app_household_id",
      identityArguments: "", prokind: "f",
      owner: "migrator", securityDefiner: false,
      language: "sql", volatility: "s",
      parallelSafety: "s", leakproof: false,
      strict: false, returnsSet: false,
      result: "uuid", config: [],
      bodyDigest:
        "e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246" },
    { schema: "meal_agent_private", name: "app_user_id",
      identityArguments: "", prokind: "f",
      owner: "migrator", securityDefiner: false,
      language: "sql", volatility: "s",
      parallelSafety: "s", leakproof: false,
      strict: false, returnsSet: false,
      result: "uuid", config: [],
      bodyDigest:
        "e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a" },
    { schema: "meal_agent_private", name: "has_active_membership",
      identityArguments: "target_household_id uuid", prokind: "f",
      owner: "migrator", securityDefiner: true,
      language: "sql", volatility: "s",
      parallelSafety: "u", leakproof: false,
      strict: false, returnsSet: false,
      result: "boolean", config: ["search_path=pg_catalog, public", "row_security=off"],
      bodyDigest:
        "07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b" },
    { schema: "meal_agent_private", name: "is_household_creator",
      identityArguments: "target_household_id uuid", prokind: "f",
      owner: "migrator", securityDefiner: true,
      language: "sql", volatility: "s",
      parallelSafety: "u", leakproof: false,
      strict: false, returnsSet: false,
      result: "boolean", config: ["search_path=pg_catalog, public", "row_security=off"],
      bodyDigest:
        "5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a" },
  ],
  policies: [
    { schema: "public", table: "households", name: "households_creator_insert",
      command: "a", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((id = meal_agent_private.app_household_id()) AND (created_by_user_id = meal_agent_private.app_user_id()) AND ((status)::text = 'active'::text))" },
    { schema: "public", table: "households", name: "households_user_list_select",
      command: "r", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "(((meal_agent_private.app_household_id() IS NULL) OR (id = meal_agent_private.app_household_id())) AND meal_agent_private.has_active_membership(id))",
      withCheck:
        "" },
    { schema: "public", table: "idempotency_records", name: "idempotency_records_scope_insert",
      command: "a", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = 'user'::text) AND (household_id IS NULL)) OR (((scope_kind)::text = 'household'::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))))" },
    { schema: "public", table: "idempotency_records", name: "idempotency_records_scope_select",
      command: "r", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = 'user'::text) AND (household_id IS NULL)) OR (((scope_kind)::text = 'household'::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))))",
      withCheck:
        "" },
    { schema: "public", table: "idempotency_records", name: "idempotency_records_scope_update",
      command: "w", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = 'user'::text) AND (household_id IS NULL)) OR (((scope_kind)::text = 'household'::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))))",
      withCheck:
        "((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = 'user'::text) AND (household_id IS NULL)) OR (((scope_kind)::text = 'household'::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))))" },
    { schema: "public", table: "inventory_events", name: "inventory_events_household_insert",
      command: "a", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))" },
    { schema: "public", table: "inventory_events", name: "inventory_events_household_select",
      command: "r", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
      withCheck:
        "" },
    { schema: "public", table: "inventory_lots", name: "inventory_lots_household_insert",
      command: "a", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))" },
    { schema: "public", table: "inventory_lots", name: "inventory_lots_household_select",
      command: "r", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
      withCheck:
        "" },
    { schema: "public", table: "inventory_lots", name: "inventory_lots_household_update",
      command: "w", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
      withCheck:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))" },
    { schema: "public", table: "memberships", name: "memberships_bootstrap_select",
      command: "r", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((user_id = meal_agent_private.app_user_id()) AND ((status)::text = 'active'::text) AND ((meal_agent_private.app_household_id() IS NULL) OR (household_id = meal_agent_private.app_household_id())))",
      withCheck:
        "" },
    { schema: "public", table: "memberships", name: "memberships_creator_insert",
      command: "a", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((household_id = meal_agent_private.app_household_id()) AND (user_id = meal_agent_private.app_user_id()) AND ((role)::text = 'owner'::text) AND ((status)::text = 'active'::text) AND meal_agent_private.is_household_creator(household_id))" },
    { schema: "public", table: "person_profiles", name: "person_profiles_household_insert",
      command: "a", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))" },
    { schema: "public", table: "person_profiles", name: "person_profiles_household_select",
      command: "r", permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
      withCheck:
        "" },
  ],
  types: [
    { schema: "drizzle", name: "___meal_agent_migrations", typtype: "b",
      owner: "handoff-pending", category: "A", defined: true,
      length: -1, byValue: false, align: "d",
      storage: "x", notNull: false, delimiter: ",",
      element: "drizzle.__meal_agent_migrations", baseType: "",
      dimensions: 0, collation: "",
      default: "" },
    { schema: "public", name: "_auth_identities", typtype: "b",
      owner: "migrator", category: "A", defined: true,
      length: -1, byValue: false, align: "d",
      storage: "x", notNull: false, delimiter: ",",
      element: "public.auth_identities", baseType: "",
      dimensions: 0, collation: "",
      default: "" },
    { schema: "public", name: "_households", typtype: "b",
      owner: "migrator", category: "A", defined: true,
      length: -1, byValue: false, align: "d",
      storage: "x", notNull: false, delimiter: ",",
      element: "public.households", baseType: "",
      dimensions: 0, collation: "",
      default: "" },
    { schema: "public", name: "_idempotency_records", typtype: "b",
      owner: "migrator", category: "A", defined: true,
      length: -1, byValue: false, align: "d",
      storage: "x", notNull: false, delimiter: ",",
      element: "public.idempotency_records", baseType: "",
      dimensions: 0, collation: "",
      default: "" },
    { schema: "public", name: "_inventory_events", typtype: "b",
      owner: "migrator", category: "A", defined: true,
      length: -1, byValue: false, align: "d",
      storage: "x", notNull: false, delimiter: ",",
      element: "public.inventory_events", baseType: "",
      dimensions: 0, collation: "",
      default: "" },
    { schema: "public", name: "_inventory_lots", typtype: "b",
      owner: "migrator", category: "A", defined: true,
      length: -1, byValue: false, align: "d",
      storage: "x", notNull: false, delimiter: ",",
      element: "public.inventory_lots", baseType: "",
      dimensions: 0, collation: "",
      default: "" },
    { schema: "public", name: "_memberships", typtype: "b",
      owner: "migrator", category: "A", defined: true,
      length: -1, byValue: false, align: "d",
      storage: "x", notNull: false, delimiter: ",",
      element: "public.memberships", baseType: "",
      dimensions: 0, collation: "",
      default: "" },
    { schema: "public", name: "_person_profiles", typtype: "b",
      owner: "migrator", category: "A", defined: true,
      length: -1, byValue: false, align: "d",
      storage: "x", notNull: false, delimiter: ",",
      element: "public.person_profiles", baseType: "",
      dimensions: 0, collation: "",
      default: "" },
    { schema: "public", name: "_sessions", typtype: "b",
      owner: "migrator", category: "A", defined: true,
      length: -1, byValue: false, align: "d",
      storage: "x", notNull: false, delimiter: ",",
      element: "public.sessions", baseType: "",
      dimensions: 0, collation: "",
      default: "" },
    { schema: "public", name: "_users", typtype: "b",
      owner: "migrator", category: "A", defined: true,
      length: -1, byValue: false, align: "d",
      storage: "x", notNull: false, delimiter: ",",
      element: "public.users", baseType: "",
      dimensions: 0, collation: "",
      default: "" },
  ],
  triggers: [
  ],
  constraintTriggers: [
    { schema: "public", table: "auth_identities",
      constraint: "auth_identities_user_id_fkey", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "auth_identities",
      constraint: "auth_identities_user_id_fkey", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "auth_identities",
      constraint: "sessions_identity_user_foreign", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "auth_identities",
      constraint: "sessions_identity_user_foreign", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "households",
      constraint: "households_created_by_user_id_fkey", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "households",
      constraint: "households_created_by_user_id_fkey", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "households",
      constraint: "inventory_lots_household_id_fkey", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "households",
      constraint: "inventory_lots_household_id_fkey", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "households",
      constraint: "memberships_household_id_fkey", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "households",
      constraint: "memberships_household_id_fkey", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "households",
      constraint: "person_profiles_household_id_fkey", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "households",
      constraint: "person_profiles_household_id_fkey", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "idempotency_records",
      constraint: "idempotency_records_membership_foreign", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "idempotency_records",
      constraint: "idempotency_records_membership_foreign", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "idempotency_records",
      constraint: "idempotency_records_user_id_fkey", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "idempotency_records",
      constraint: "idempotency_records_user_id_fkey", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_events",
      constraint: "inventory_events_actor_membership_foreign", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_events",
      constraint: "inventory_events_actor_membership_foreign", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_events",
      constraint: "inventory_events_correction_foreign", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_events",
      constraint: "inventory_events_correction_foreign", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_events",
      constraint: "inventory_events_correction_foreign", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_events",
      constraint: "inventory_events_correction_foreign", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_events",
      constraint: "inventory_events_lot_foreign", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_events",
      constraint: "inventory_events_lot_foreign", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_lots",
      constraint: "inventory_events_lot_foreign", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_lots",
      constraint: "inventory_events_lot_foreign", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_lots",
      constraint: "inventory_lots_creator_membership_foreign", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_lots",
      constraint: "inventory_lots_creator_membership_foreign", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_lots",
      constraint: "inventory_lots_household_id_fkey", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "inventory_lots",
      constraint: "inventory_lots_household_id_fkey", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "idempotency_records_membership_foreign", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "idempotency_records_membership_foreign", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "inventory_events_actor_membership_foreign", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "inventory_events_actor_membership_foreign", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "inventory_lots_creator_membership_foreign", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "inventory_lots_creator_membership_foreign", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "memberships_household_id_fkey", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "memberships_household_id_fkey", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "memberships_user_id_fkey", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "memberships_user_id_fkey", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "person_profiles_membership_foreign", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "memberships",
      constraint: "person_profiles_membership_foreign", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "person_profiles",
      constraint: "person_profiles_household_id_fkey", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "person_profiles",
      constraint: "person_profiles_household_id_fkey", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "person_profiles",
      constraint: "person_profiles_membership_foreign", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "person_profiles",
      constraint: "person_profiles_membership_foreign", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "sessions",
      constraint: "sessions_identity_user_foreign", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "sessions",
      constraint: "sessions_identity_user_foreign", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "sessions",
      constraint: "sessions_user_id_fkey", function: "RI_FKey_check_ins",
      enabled: "O", type: 5,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "sessions",
      constraint: "sessions_user_id_fkey", function: "RI_FKey_check_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "users",
      constraint: "auth_identities_user_id_fkey", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "users",
      constraint: "auth_identities_user_id_fkey", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "users",
      constraint: "households_created_by_user_id_fkey", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "users",
      constraint: "households_created_by_user_id_fkey", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "users",
      constraint: "idempotency_records_user_id_fkey", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "users",
      constraint: "idempotency_records_user_id_fkey", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "users",
      constraint: "memberships_user_id_fkey", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "users",
      constraint: "memberships_user_id_fkey", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "users",
      constraint: "sessions_user_id_fkey", function: "RI_FKey_noaction_del",
      enabled: "O", type: 9,
      deferrable: false, initiallyDeferred: false },
    { schema: "public", table: "users",
      constraint: "sessions_user_id_fkey", function: "RI_FKey_noaction_upd",
      enabled: "O", type: 17,
      deferrable: false, initiallyDeferred: false },
  ],
  rules: [],
  namespaceObjects: [],
};

/** 冻结 0000 之后的安全投影。只读、深冻结。 */
export const stage06SecurityManifest: Stage06Manifest = deepFreeze(manifestData);

/** 规范化行：`kind` + `identity` 唯一定位一个对象，`detail` 是它的安全属性投影。 */
export interface Stage06CanonicalRow {
  readonly kind: string;
  readonly identity: string;
  readonly detail: string;
}

const flag = (value: boolean): string => (value ? "t" : "f");

/** `handoff-pending` 在规范化文本里就是这个占位符，两端一致。 */
export const handoffPendingOwnerToken = "handoff-pending";

const ownerToken = (owner: Stage06OwnerPolicy): string =>
  owner === "migrator" ? "meal_agent_migrator" : handoffPendingOwnerToken;

/**
 * 规范化文本不允许出现的字符：
 *   - 反斜杠会在 `standard_conforming_strings = off` 的会话里改变字面量语义；
 *   - 换行/回车会破坏 generated 文件的逐行可审查性；
 *   - NUL 无法进入 SQL 字面量。
 * 出现即拒绝，而不是悄悄转义。
 */
const forbiddenCharacters = /[\\\r\n\u0000]/u;

const assertRenderable = (field: string, value: string): string => {
  if (forbiddenCharacters.test(value)) {
    throw new Stage06ManifestError(
      `${field} contains a character that cannot be rendered deterministically`,
    );
  }
  return value;
};

/** 固定排序：按 UTF-16 码元逐位比较，不依赖 locale 或 `Intl`。 */
export const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** 数据库自身的 identity 是固定占位符：库名随环境不同，不进入 manifest。 */
export const databaseIdentity = "<current>";

/**
 * 把 typed manifest 投影成规范化行，并在此处强制两条不变量：
 *   1. `(kind, identity)` 唯一——重复 identity 直接拒绝，不做「后者覆盖前者」；
 *   2. 固定排序——渲染结果与声明顺序无关。
 */
export const canonicalManifestRows = (
  manifest: Stage06Manifest = stage06SecurityManifest,
): readonly Stage06CanonicalRow[] => {
  const rows: Stage06CanonicalRow[] = [];
  const push = (kind: string, identity: string, detail: string): void => {
    rows.push({
      kind: assertRenderable("kind", kind),
      identity: assertRenderable("identity", identity),
      detail: assertRenderable("detail", detail),
    });
  };

  push("database", databaseIdentity, `owner=${ownerToken(manifest.database.owner)}`);
  for (const entry of manifest.schemas) {
    push("schema", entry.name, `owner=${ownerToken(entry.owner)}`);
  }
  for (const entry of manifest.relations) {
    push(
      "relation",
      `${entry.schema}.${entry.name}`,
      `relkind=${entry.relkind} owner=${ownerToken(entry.owner)} ` +
        `persistence=${entry.persistence} rls=${flag(entry.rowSecurity)} ` +
        `force=${flag(entry.forceRowSecurity)}`,
    );
  }
  for (const entry of manifest.columns) {
    push(
      "column",
      `${entry.schema}.${entry.table}.${entry.name}`,
      `attnum=${String(entry.attnum)} type=${entry.type} ` +
        `notnull=${flag(entry.notNull)} identity=${entry.identity} ` +
        `generated=${entry.generated} storage=${entry.storage} ` +
        `compression=${entry.compression} collation=${entry.collation} ` +
        `default=${entry.default}`,
    );
  }
  for (const entry of manifest.indexes) {
    push(
      "index",
      `${entry.schema}.${entry.name}`,
      `table=${entry.table} valid=${flag(entry.valid)} ` +
        `ready=${flag(entry.ready)} def=${entry.definition}`,
    );
  }
  for (const entry of manifest.constraints) {
    push(
      "constraint",
      `${entry.schema}.${entry.parent}.${entry.name}`,
      `contype=${entry.contype} validated=${flag(entry.validated)} ` +
        `def=${entry.definition}`,
    );
  }
  for (const entry of manifest.routines) {
    push(
      "routine",
      `${entry.schema}.${entry.name}(${entry.identityArguments})`,
      `prokind=${entry.prokind} owner=${ownerToken(entry.owner)} ` +
        `secdef=${flag(entry.securityDefiner)} lang=${entry.language} ` +
        `volatile=${entry.volatility} parallel=${entry.parallelSafety} ` +
        `leakproof=${flag(entry.leakproof)} strict=${flag(entry.strict)} ` +
        `set=${flag(entry.returnsSet)} result=${entry.result} ` +
        `config=${entry.config.join("|")} body=${entry.bodyDigest}`,
    );
  }
  for (const entry of manifest.policies) {
    push(
      "policy",
      `${entry.schema}.${entry.table}.${entry.name}`,
      `cmd=${entry.command} permissive=${flag(entry.permissive)} ` +
        `roles=${entry.roles.join(",")} using=${entry.using} ` +
        `check=${entry.withCheck}`,
    );
  }
  for (const entry of manifest.types) {
    push(
      "type",
      `${entry.schema}.${entry.name}`,
      `typtype=${entry.typtype} owner=${ownerToken(entry.owner)} ` +
        `category=${entry.category} defined=${flag(entry.defined)} ` +
        `len=${String(entry.length)} byval=${flag(entry.byValue)} ` +
        `align=${entry.align} storage=${entry.storage} ` +
        `notnull=${flag(entry.notNull)} delim=${entry.delimiter} ` +
        `elem=${entry.element} base=${entry.baseType} ` +
        `ndims=${String(entry.dimensions)} collation=${entry.collation} ` +
        `default=${entry.default}`,
    );
  }
  for (const entry of manifest.triggers) {
    push(
      "trigger",
      `${entry.schema}.${entry.table}.${entry.name}`,
      `enabled=${entry.enabled} def=${entry.definition}`,
    );
  }
  for (const entry of manifest.constraintTriggers) {
    push(
      "constraint-trigger",
      `${entry.schema}.${entry.table}.${entry.constraint}#${entry.function}`,
      `enabled=${entry.enabled} type=${String(entry.type)} ` +
        `deferrable=${flag(entry.deferrable)} ` +
        `initdeferred=${flag(entry.initiallyDeferred)}`,
    );
  }
  for (const entry of manifest.rules) {
    push(
      "rule",
      `${entry.schema}.${entry.table}.${entry.name}`,
      `enabled=${entry.enabled} def=${entry.definition}`,
    );
  }
  for (const entry of manifest.namespaceObjects) {
    push(
      entry.category,
      `${entry.schema}.${entry.identity}`,
      entry.detail,
    );
  }

  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.kind}:${row.identity}`;
    if (seen.has(key)) {
      throw new Stage06ManifestError(`duplicate identity ${key}`);
    }
    seen.add(key);
  }

  rows.sort(
    (left, right) =>
      byCodeUnit(left.kind, right.kind) ||
      byCodeUnit(left.identity, right.identity),
  );
  return rows;
};

/** 规范化文本：逐行 `kind|identity|detail`，末尾固定换行。 */
export const canonicalManifestText = (
  manifest: Stage06Manifest = stage06SecurityManifest,
): string =>
  `${canonicalManifestRows(manifest)
    .map((row) => `${row.kind}|${row.identity}|${row.detail}`)
    .join("\n")}\n`;

/** canonical digest：只由 manifest 内容决定，不含时间、路径、locale 或随机值。 */
export const manifestDigest = (
  manifest: Stage06Manifest = stage06SecurityManifest,
): string =>
  createHash("sha256")
    .update(canonicalManifestText(manifest), "utf8")
    .digest("hex");

/** 被管理的 schema 集合：relation / routine / policy 等枚举的范围。 */
export const managedSchemas = (
  manifest: Stage06Manifest = stage06SecurityManifest,
): readonly string[] =>
  [...manifest.schemas.map((entry) => entry.name)].sort(byCodeUnit);

/**
 * owner 允许处于 handoff 过渡态的对象键（`kind:identity`）。渲染出的投影 SQL 只对
 * 这些对象做 owner 归一化，其余对象一律按精确 owner 比较；而且归一化本身还要求
 * 「handoff 尚未完成」，因此 handoff 之后 admin 重新夺回 owner 会被判为漂移。
 */
export const handoffPendingKeys = (
  manifest: Stage06Manifest = stage06SecurityManifest,
): readonly string[] =>
  [
    ...(manifest.database.owner === "handoff-pending"
      ? [`database:${databaseIdentity}`]
      : []),
    ...manifest.schemas
      .filter((entry) => entry.owner === "handoff-pending")
      .map((entry) => `schema:${entry.name}`),
    ...manifest.relations
      .filter((entry) => entry.owner === "handoff-pending")
      .map((entry) => `relation:${entry.schema}.${entry.name}`),
    ...manifest.routines
      .filter((entry) => entry.owner === "handoff-pending")
      .map(
        (entry) =>
          `routine:${entry.schema}.${entry.name}(${entry.identityArguments})`,
      ),
    ...manifest.types
      .filter((entry) => entry.owner === "handoff-pending")
      .map((entry) => `type:${entry.schema}.${entry.name}`),
  ].sort(byCodeUnit);
