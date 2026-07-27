import { createHash } from "node:crypto";

/**
 * 阶段 09A / M2A：冻结的 `0000_stage_06.sql` 应用之后，「对象与安全属性投影」的
 * **唯一事实源**。
 *
 * 为什么是这个形状：
 *
 *   1. 之前 `migrate.ts` 与 `01-owner-handoff.sql` 各自维护一份手写对象清单。
 *      两份清单会独立漂移，而且都只覆盖「有没有这个对象」，覆盖不到 RLS、policy、
 *      `proconfig`、约束定义这些真正决定安全边界的属性。
 *   2. 这里改为**单一 typed manifest**：它描述冻结 0000（外加 migration runner
 *      建立的 drizzle ledger）执行完毕后，catalog 中与安全相关的规范化投影。
 *      两个入口都从它渲染出同一段纯 SQL，不再各写一遍。
 *   3. manifest **不是**从 `0000_stage_06.sql` 正则推导出来的。它是在真实
 *      PostgreSQL 18 上执行冻结 0000 之后，从 catalog 采集并冻结下来的规范化投影；
 *      `stage09a.roles.database.test.ts` 的 semantic parity 用例持续证明这一点。
 *
 * owner 语义：业务对象在 0000 里就已经 `OWNER TO meal_agent_migrator`，所以是精确
 * 值；`public` / `drizzle` schema 与 drizzle ledger 在 owner handoff **之前**属于
 * bootstrap admin 或 `pg_database_owner`，之后才属于 migrator。这两种都是合法的
 * 过渡态，因此用 `handoff-pending` 策略表达，而不是把 owner 检查整个放弃。
 */

/** 关系类型：0000 只建普通表，其余取值用于把「意外出现的对象」如实呈现。 */
export type Stage06RelationKind = "r" | "p" | "v" | "m" | "S" | "f";

/**
 * owner 策略：
 *   - `migrator`：必须精确是 `meal_agent_migrator`；
 *   - `handoff-pending`：owner handoff 前后都合法，即 `meal_agent_migrator`、
 *     `pg_database_owner` 或当前执行 bootstrap 的 admin（`current_user`）。
 */
export type Stage06OwnerPolicy = "migrator" | "handoff-pending";

export interface Stage06SchemaEntry {
  readonly name: string;
  readonly owner: Stage06OwnerPolicy;
}

export interface Stage06RelationEntry {
  readonly schema: string;
  readonly name: string;
  readonly relkind: Stage06RelationKind;
  readonly owner: Stage06OwnerPolicy;
  readonly rowSecurity: boolean;
  readonly forceRowSecurity: boolean;
}

export interface Stage06IndexEntry {
  readonly schema: string;
  readonly name: string;
  /** `schema.table`，与 `definition` 互相印证。 */
  readonly table: string;
  /** `pg_get_indexdef` 的规范化输出（search_path 固定为 `pg_catalog`）。 */
  readonly definition: string;
}

export interface Stage06ConstraintEntry {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /**
   * `pg_constraint.contype`：`p`/`u`/`f`/`c`/`n`。PostgreSQL 18 把 NOT NULL 也
   * 登记为约束，因此约束漂移里也包含「某列的 NOT NULL 被去掉」。
   */
  readonly contype: string;
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

export interface Stage06TypeEntry {
  readonly schema: string;
  readonly name: string;
  readonly typtype: string;
}

export interface Stage06TriggerEntry {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

export interface Stage06Manifest {
  readonly version: number;
  readonly schemas: readonly Stage06SchemaEntry[];
  readonly relations: readonly Stage06RelationEntry[];
  readonly indexes: readonly Stage06IndexEntry[];
  readonly constraints: readonly Stage06ConstraintEntry[];
  readonly routines: readonly Stage06RoutineEntry[];
  readonly policies: readonly Stage06PolicyEntry[];
  readonly types: readonly Stage06TypeEntry[];
  readonly triggers: readonly Stage06TriggerEntry[];
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
export const stage06ManifestVersion = 1;

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
  schemas: [
    { name: "drizzle", owner: "handoff-pending" },
    { name: "meal_agent_private", owner: "migrator" },
    { name: "public", owner: "handoff-pending" },
  ],
  relations: [
    {
      schema: "drizzle",
      name: "__meal_agent_migrations",
      relkind: "r",
      owner: "handoff-pending",
      rowSecurity: false,
      forceRowSecurity: false,
    },
    {
      schema: "public",
      name: "auth_identities",
      relkind: "r",
      owner: "migrator",
      rowSecurity: false,
      forceRowSecurity: false,
    },
    {
      schema: "public",
      name: "households",
      relkind: "r",
      owner: "migrator",
      rowSecurity: true,
      forceRowSecurity: true,
    },
    {
      schema: "public",
      name: "idempotency_records",
      relkind: "r",
      owner: "migrator",
      rowSecurity: true,
      forceRowSecurity: true,
    },
    {
      schema: "public",
      name: "inventory_events",
      relkind: "r",
      owner: "migrator",
      rowSecurity: true,
      forceRowSecurity: true,
    },
    {
      schema: "public",
      name: "inventory_lots",
      relkind: "r",
      owner: "migrator",
      rowSecurity: true,
      forceRowSecurity: true,
    },
    {
      schema: "public",
      name: "memberships",
      relkind: "r",
      owner: "migrator",
      rowSecurity: true,
      forceRowSecurity: true,
    },
    {
      schema: "public",
      name: "person_profiles",
      relkind: "r",
      owner: "migrator",
      rowSecurity: true,
      forceRowSecurity: true,
    },
    {
      schema: "public",
      name: "sessions",
      relkind: "r",
      owner: "migrator",
      rowSecurity: false,
      forceRowSecurity: false,
    },
    {
      schema: "public",
      name: "users",
      relkind: "r",
      owner: "migrator",
      rowSecurity: false,
      forceRowSecurity: false,
    },
  ],
  indexes: [
    {
      schema: "drizzle",
      name: "__meal_agent_migrations_pkey",
      table: "drizzle.__meal_agent_migrations",
      definition:
        "CREATE UNIQUE INDEX __meal_agent_migrations_pkey ON drizzle.__meal_agent_migrations USING btree (name)",
    },
    {
      schema: "public",
      name: "auth_identities_id_user_unique",
      table: "public.auth_identities",
      definition:
        "CREATE UNIQUE INDEX auth_identities_id_user_unique ON public.auth_identities USING btree (id, user_id)",
    },
    {
      schema: "public",
      name: "auth_identities_pkey",
      table: "public.auth_identities",
      definition:
        "CREATE UNIQUE INDEX auth_identities_pkey ON public.auth_identities USING btree (id)",
    },
    {
      schema: "public",
      name: "auth_identities_provider_subject_unique",
      table: "public.auth_identities",
      definition:
        "CREATE UNIQUE INDEX auth_identities_provider_subject_unique ON public.auth_identities USING btree (provider, provider_tenant_key, provider_subject)",
    },
    {
      schema: "public",
      name: "households_pkey",
      table: "public.households",
      definition:
        "CREATE UNIQUE INDEX households_pkey ON public.households USING btree (id)",
    },
    {
      schema: "public",
      name: "idempotency_records_pkey",
      table: "public.idempotency_records",
      definition:
        "CREATE UNIQUE INDEX idempotency_records_pkey ON public.idempotency_records USING btree (id)",
    },
    {
      schema: "public",
      name: "idempotency_records_scope_unique",
      table: "public.idempotency_records",
      definition:
        "CREATE UNIQUE INDEX idempotency_records_scope_unique ON public.idempotency_records USING btree (user_id, household_id, method, normalized_route, idempotency_key) NULLS NOT DISTINCT",
    },
    {
      schema: "public",
      name: "inventory_events_household_actor_route_idempotency_unique",
      table: "public.inventory_events",
      definition:
        "CREATE UNIQUE INDEX inventory_events_household_actor_route_idempotency_unique ON public.inventory_events USING btree (household_id, actor_user_id, normalized_route, idempotency_key)",
    },
    {
      schema: "public",
      name: "inventory_events_household_id_unique",
      table: "public.inventory_events",
      definition:
        "CREATE UNIQUE INDEX inventory_events_household_id_unique ON public.inventory_events USING btree (household_id, id)",
    },
    {
      schema: "public",
      name: "inventory_events_lot_recorded_index",
      table: "public.inventory_events",
      definition:
        "CREATE INDEX inventory_events_lot_recorded_index ON public.inventory_events USING btree (household_id, inventory_lot_id, recorded_at, id)",
    },
    {
      schema: "public",
      name: "inventory_events_pkey",
      table: "public.inventory_events",
      definition:
        "CREATE UNIQUE INDEX inventory_events_pkey ON public.inventory_events USING btree (id)",
    },
    {
      schema: "public",
      name: "inventory_lots_household_created_index",
      table: "public.inventory_lots",
      definition:
        "CREATE INDEX inventory_lots_household_created_index ON public.inventory_lots USING btree (household_id, created_at, id)",
    },
    {
      schema: "public",
      name: "inventory_lots_household_id_unique",
      table: "public.inventory_lots",
      definition:
        "CREATE UNIQUE INDEX inventory_lots_household_id_unique ON public.inventory_lots USING btree (household_id, id)",
    },
    {
      schema: "public",
      name: "inventory_lots_pkey",
      table: "public.inventory_lots",
      definition:
        "CREATE UNIQUE INDEX inventory_lots_pkey ON public.inventory_lots USING btree (id)",
    },
    {
      schema: "public",
      name: "memberships_household_id_unique",
      table: "public.memberships",
      definition:
        "CREATE UNIQUE INDEX memberships_household_id_unique ON public.memberships USING btree (household_id, id)",
    },
    {
      schema: "public",
      name: "memberships_household_user_unique",
      table: "public.memberships",
      definition:
        "CREATE UNIQUE INDEX memberships_household_user_unique ON public.memberships USING btree (household_id, user_id)",
    },
    {
      schema: "public",
      name: "memberships_pkey",
      table: "public.memberships",
      definition:
        "CREATE UNIQUE INDEX memberships_pkey ON public.memberships USING btree (id)",
    },
    {
      schema: "public",
      name: "memberships_user_active_index",
      table: "public.memberships",
      definition:
        "CREATE INDEX memberships_user_active_index ON public.memberships USING btree (user_id, household_id) WHERE ((status)::text = 'active'::text)",
    },
    {
      schema: "public",
      name: "person_profiles_household_id_unique",
      table: "public.person_profiles",
      definition:
        "CREATE UNIQUE INDEX person_profiles_household_id_unique ON public.person_profiles USING btree (household_id, id)",
    },
    {
      schema: "public",
      name: "person_profiles_linked_membership_unique",
      table: "public.person_profiles",
      definition:
        "CREATE UNIQUE INDEX person_profiles_linked_membership_unique ON public.person_profiles USING btree (household_id, linked_membership_id) WHERE (linked_membership_id IS NOT NULL)",
    },
    {
      schema: "public",
      name: "person_profiles_pkey",
      table: "public.person_profiles",
      definition:
        "CREATE UNIQUE INDEX person_profiles_pkey ON public.person_profiles USING btree (id)",
    },
    {
      schema: "public",
      name: "sessions_pkey",
      table: "public.sessions",
      definition:
        "CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (id)",
    },
    {
      schema: "public",
      name: "sessions_token_digest_unique",
      table: "public.sessions",
      definition:
        "CREATE UNIQUE INDEX sessions_token_digest_unique ON public.sessions USING btree (token_digest)",
    },
    {
      schema: "public",
      name: "users_pkey",
      table: "public.users",
      definition:
        "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
    },
  ],
  constraints: [
    {
      schema: "drizzle",
      table: "__meal_agent_migrations",
      name: "__meal_agent_migrations_applied_at_not_null",
      contype: "n",
      definition:
        "NOT NULL applied_at",
    },
    {
      schema: "drizzle",
      table: "__meal_agent_migrations",
      name: "__meal_agent_migrations_hash_not_null",
      contype: "n",
      definition:
        "NOT NULL hash",
    },
    {
      schema: "drizzle",
      table: "__meal_agent_migrations",
      name: "__meal_agent_migrations_name_not_null",
      contype: "n",
      definition:
        "NOT NULL name",
    },
    {
      schema: "drizzle",
      table: "__meal_agent_migrations",
      name: "__meal_agent_migrations_pkey",
      contype: "p",
      definition:
        "PRIMARY KEY (name)",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_created_at_not_null",
      contype: "n",
      definition:
        "NOT NULL created_at",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_id_not_null",
      contype: "n",
      definition:
        "NOT NULL id",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_id_user_unique",
      contype: "u",
      definition:
        "UNIQUE (id, user_id)",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_last_authenticated_at_not_null",
      contype: "n",
      definition:
        "NOT NULL last_authenticated_at",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_pkey",
      contype: "p",
      definition:
        "PRIMARY KEY (id)",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_provider_check",
      contype: "c",
      definition:
        "CHECK (((provider)::text = ANY ((ARRAY['wechat_miniprogram'::character varying, 'phone'::character varying, 'apple'::character varying, 'huawei'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_provider_not_null",
      contype: "n",
      definition:
        "NOT NULL provider",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_provider_subject_not_null",
      contype: "n",
      definition:
        "NOT NULL provider_subject",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_provider_subject_unique",
      contype: "u",
      definition:
        "UNIQUE (provider, provider_tenant_key, provider_subject)",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_provider_tenant_key_not_null",
      contype: "n",
      definition:
        "NOT NULL provider_tenant_key",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_status_check",
      contype: "c",
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_status_not_null",
      contype: "n",
      definition:
        "NOT NULL status",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_user_id_fkey",
      contype: "f",
      definition:
        "FOREIGN KEY (user_id) REFERENCES public.users(id)",
    },
    {
      schema: "public",
      table: "auth_identities",
      name: "auth_identities_user_id_not_null",
      contype: "n",
      definition:
        "NOT NULL user_id",
    },
    {
      schema: "public",
      table: "households",
      name: "households_created_at_not_null",
      contype: "n",
      definition:
        "NOT NULL created_at",
    },
    {
      schema: "public",
      table: "households",
      name: "households_created_by_user_id_fkey",
      contype: "f",
      definition:
        "FOREIGN KEY (created_by_user_id) REFERENCES public.users(id)",
    },
    {
      schema: "public",
      table: "households",
      name: "households_created_by_user_id_not_null",
      contype: "n",
      definition:
        "NOT NULL created_by_user_id",
    },
    {
      schema: "public",
      table: "households",
      name: "households_id_not_null",
      contype: "n",
      definition:
        "NOT NULL id",
    },
    {
      schema: "public",
      table: "households",
      name: "households_locale_not_null",
      contype: "n",
      definition:
        "NOT NULL locale",
    },
    {
      schema: "public",
      table: "households",
      name: "households_name_not_null",
      contype: "n",
      definition:
        "NOT NULL name",
    },
    {
      schema: "public",
      table: "households",
      name: "households_pkey",
      contype: "p",
      definition:
        "PRIMARY KEY (id)",
    },
    {
      schema: "public",
      table: "households",
      name: "households_status_check",
      contype: "c",
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'deletion_pending'::character varying, 'deleted'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "households",
      name: "households_status_not_null",
      contype: "n",
      definition:
        "NOT NULL status",
    },
    {
      schema: "public",
      table: "households",
      name: "households_timezone_not_null",
      contype: "n",
      definition:
        "NOT NULL timezone",
    },
    {
      schema: "public",
      table: "households",
      name: "households_updated_at_not_null",
      contype: "n",
      definition:
        "NOT NULL updated_at",
    },
    {
      schema: "public",
      table: "households",
      name: "households_version_check",
      contype: "c",
      definition:
        "CHECK ((version >= 0))",
    },
    {
      schema: "public",
      table: "households",
      name: "households_version_not_null",
      contype: "n",
      definition:
        "NOT NULL version",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_completion_check",
      contype: "c",
      definition:
        "CHECK (((status_code IS NULL) = (response_body IS NULL)))",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_expires_at_not_null",
      contype: "n",
      definition:
        "NOT NULL expires_at",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_first_processed_at_not_null",
      contype: "n",
      definition:
        "NOT NULL first_processed_at",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_id_not_null",
      contype: "n",
      definition:
        "NOT NULL id",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_idempotency_key_not_null",
      contype: "n",
      definition:
        "NOT NULL idempotency_key",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_membership_foreign",
      contype: "f",
      definition:
        "FOREIGN KEY (household_id, user_id) REFERENCES public.memberships(household_id, user_id)",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_method_not_null",
      contype: "n",
      definition:
        "NOT NULL method",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_normalized_route_not_null",
      contype: "n",
      definition:
        "NOT NULL normalized_route",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_original_request_id_not_null",
      contype: "n",
      definition:
        "NOT NULL original_request_id",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_pkey",
      contype: "p",
      definition:
        "PRIMARY KEY (id)",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_request_hash_not_null",
      contype: "n",
      definition:
        "NOT NULL request_hash",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_scope_check",
      contype: "c",
      definition:
        "CHECK (((((scope_kind)::text = 'user'::text) AND (household_id IS NULL)) OR (((scope_kind)::text = 'household'::text) AND (household_id IS NOT NULL))))",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_scope_kind_not_null",
      contype: "n",
      definition:
        "NOT NULL scope_kind",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_scope_unique",
      contype: "u",
      definition:
        "UNIQUE NULLS NOT DISTINCT (user_id, household_id, method, normalized_route, idempotency_key)",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_status_check",
      contype: "c",
      definition:
        "CHECK (((status_code IS NULL) OR ((status_code >= 200) AND (status_code <= 299))))",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_user_id_fkey",
      contype: "f",
      definition:
        "FOREIGN KEY (user_id) REFERENCES public.users(id)",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_user_id_not_null",
      contype: "n",
      definition:
        "NOT NULL user_id",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_actor_membership_foreign",
      contype: "f",
      definition:
        "FOREIGN KEY (household_id, actor_user_id) REFERENCES public.memberships(household_id, user_id)",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_actor_user_id_not_null",
      contype: "n",
      definition:
        "NOT NULL actor_user_id",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_correction_foreign",
      contype: "f",
      definition:
        "FOREIGN KEY (household_id, correction_of_event_id) REFERENCES public.inventory_events(household_id, id)",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_expected_lot_version_not_null",
      contype: "n",
      definition:
        "NOT NULL expected_lot_version",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_household_actor_route_idempotency_unique",
      contype: "u",
      definition:
        "UNIQUE (household_id, actor_user_id, normalized_route, idempotency_key)",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_household_id_not_null",
      contype: "n",
      definition:
        "NOT NULL household_id",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_household_id_unique",
      contype: "u",
      definition:
        "UNIQUE (household_id, id)",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_id_not_null",
      contype: "n",
      definition:
        "NOT NULL id",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_idempotency_key_not_null",
      contype: "n",
      definition:
        "NOT NULL idempotency_key",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_inventory_lot_id_not_null",
      contype: "n",
      definition:
        "NOT NULL inventory_lot_id",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_lot_foreign",
      contype: "f",
      definition:
        "FOREIGN KEY (household_id, inventory_lot_id) REFERENCES public.inventory_lots(household_id, id)",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_normalized_route_not_null",
      contype: "n",
      definition:
        "NOT NULL normalized_route",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_occurred_at_not_null",
      contype: "n",
      definition:
        "NOT NULL occurred_at",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_pkey",
      contype: "p",
      definition:
        "PRIMARY KEY (id)",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_quantity_shape_check",
      contype: "c",
      definition:
        "CHECK ((((quantity_change_kind IS NULL) AND (quantity_change_amount IS NULL) AND (quantity_from_level IS NULL) AND (quantity_to_level IS NULL)) OR (((quantity_change_kind)::text = 'numeric'::text) AND (quantity_change_amount IS NOT NULL) AND (quantity_change_amount <> (0)::numeric) AND (quantity_change_unit IS NOT NULL) AND ((quantity_change_precision)::text = ANY ((ARRAY['exact'::character varying, 'estimated'::character varying])::text[])) AND (quantity_from_level IS NULL) AND (quantity_to_level IS NULL) AND ((((quantity_change_precision)::text = 'exact'::text) AND (quantity_change_confidence IS NULL)) OR (((quantity_change_precision)::text = 'estimated'::text) AND ((quantity_change_confidence)::text = ANY ((ARRAY['high'::character varying, 'medium'::character varying, 'low'::character varying])::text[])) AND (quantity_change_original_text IS NOT NULL)))) OR (((quantity_change_kind)::text = 'qualitative'::text) AND (quantity_change_amount IS NULL) AND (quantity_change_unit IS NULL) AND (quantity_change_precision IS NULL) AND ((quantity_from_level)::text = ANY ((ARRAY['plenty'::character varying, 'some'::character varying, 'low'::character varying, 'empty'::character varying, 'unknown'::character varying])::text[])) AND ((quantity_to_level)::text = ANY ((ARRAY['plenty'::character varying, 'some'::character varying, 'low'::character varying, 'empty'::character varying, 'unknown'::character varying])::text[])) AND ((quantity_from_level)::text <> (quantity_to_level)::text))))",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_recorded_at_not_null",
      contype: "n",
      definition:
        "NOT NULL recorded_at",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_resulting_lot_version_not_null",
      contype: "n",
      definition:
        "NOT NULL resulting_lot_version",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_source_not_null",
      contype: "n",
      definition:
        "NOT NULL source",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_type_not_null",
      contype: "n",
      definition:
        "NOT NULL type",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_version_check",
      contype: "c",
      definition:
        "CHECK (((expected_lot_version >= 0) AND (resulting_lot_version = (expected_lot_version + 1))))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_created_at_not_null",
      contype: "n",
      definition:
        "NOT NULL created_at",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_created_by_user_id_not_null",
      contype: "n",
      definition:
        "NOT NULL created_by_user_id",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_creator_membership_foreign",
      contype: "f",
      definition:
        "FOREIGN KEY (household_id, created_by_user_id) REFERENCES public.memberships(household_id, user_id)",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_current_quantity_kind_not_null",
      contype: "n",
      definition:
        "NOT NULL current_quantity_kind",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_dates_check",
      contype: "c",
      definition:
        "CHECK (((jsonb_typeof(dates) = 'array'::text) AND (jsonb_array_length(dates) <= 9)))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_dates_not_null",
      contype: "n",
      definition:
        "NOT NULL dates",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_display_name_not_null",
      contype: "n",
      definition:
        "NOT NULL display_name",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_household_id_fkey",
      contype: "f",
      definition:
        "FOREIGN KEY (household_id) REFERENCES public.households(id)",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_household_id_not_null",
      contype: "n",
      definition:
        "NOT NULL household_id",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_household_id_unique",
      contype: "u",
      definition:
        "UNIQUE (household_id, id)",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_id_not_null",
      contype: "n",
      definition:
        "NOT NULL id",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_origin_check",
      contype: "c",
      definition:
        "CHECK (((origin)::text = ANY ((ARRAY['manual'::character varying, 'shopping_confirmation'::character varying, 'leftover'::character varying, 'confirmed_import'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_origin_not_null",
      contype: "n",
      definition:
        "NOT NULL origin",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_pkey",
      contype: "p",
      definition:
        "PRIMARY KEY (id)",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_quantity_shape_check",
      contype: "c",
      definition:
        "CHECK (((((current_quantity_kind)::text = 'exact'::text) AND (current_quantity_amount IS NOT NULL) AND (current_quantity_amount >= (0)::numeric) AND (current_quantity_unit IS NOT NULL) AND (current_quantity_confidence IS NULL) AND (current_quantity_level IS NULL)) OR (((current_quantity_kind)::text = 'approximate'::text) AND (current_quantity_amount IS NOT NULL) AND (current_quantity_amount >= (0)::numeric) AND (current_quantity_unit IS NOT NULL) AND ((current_quantity_confidence)::text = ANY ((ARRAY['high'::character varying, 'medium'::character varying, 'low'::character varying])::text[])) AND (current_quantity_original_text IS NOT NULL) AND (current_quantity_level IS NULL)) OR (((current_quantity_kind)::text = 'qualitative'::text) AND (current_quantity_amount IS NULL) AND (current_quantity_unit IS NULL) AND (current_quantity_confidence IS NULL) AND ((current_quantity_level)::text = ANY ((ARRAY['plenty'::character varying, 'some'::character varying, 'low'::character varying, 'empty'::character varying, 'unknown'::character varying])::text[])))))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_safety_evaluated_at_not_null",
      contype: "n",
      definition:
        "NOT NULL safety_evaluated_at",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_safety_policy_version_not_null",
      contype: "n",
      definition:
        "NOT NULL safety_policy_version",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_safety_reason_codes_check",
      contype: "c",
      definition:
        "CHECK ((jsonb_typeof(safety_reason_codes) = 'array'::text))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_safety_reason_codes_not_null",
      contype: "n",
      definition:
        "NOT NULL safety_reason_codes",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_safety_status_check",
      contype: "c",
      definition:
        "CHECK (((safety_status)::text = ANY ((ARRAY['eligible'::character varying, 'blocked'::character varying, 'unknown'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_safety_status_not_null",
      contype: "n",
      definition:
        "NOT NULL safety_status",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_state_check",
      contype: "c",
      definition:
        "CHECK (((state)::text = ANY ((ARRAY['active'::character varying, 'depleted'::character varying, 'discarded'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_state_not_null",
      contype: "n",
      definition:
        "NOT NULL state",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_state_quantity_check",
      contype: "c",
      definition:
        "CHECK (((((state)::text = 'active'::text) AND ((((current_quantity_kind)::text = ANY ((ARRAY['exact'::character varying, 'approximate'::character varying])::text[])) AND (current_quantity_amount > (0)::numeric)) OR (((current_quantity_kind)::text = 'qualitative'::text) AND ((current_quantity_level)::text <> 'empty'::text)))) OR (((state)::text = ANY ((ARRAY['depleted'::character varying, 'discarded'::character varying])::text[])) AND ((((current_quantity_kind)::text = 'exact'::text) AND (current_quantity_amount = (0)::numeric)) OR (((current_quantity_kind)::text = 'qualitative'::text) AND ((current_quantity_level)::text = 'empty'::text))))))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_storage_location_check",
      contype: "c",
      definition:
        "CHECK (((storage_location)::text = ANY ((ARRAY['pantry'::character varying, 'refrigerated'::character varying, 'frozen'::character varying, 'other'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_storage_location_not_null",
      contype: "n",
      definition:
        "NOT NULL storage_location",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_updated_at_not_null",
      contype: "n",
      definition:
        "NOT NULL updated_at",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_version_check",
      contype: "c",
      definition:
        "CHECK ((version > 0))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_version_not_null",
      contype: "n",
      definition:
        "NOT NULL version",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_capabilities_check",
      contype: "c",
      definition:
        "CHECK ((jsonb_typeof(capabilities) = 'array'::text))",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_capabilities_not_null",
      contype: "n",
      definition:
        "NOT NULL capabilities",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_household_id_fkey",
      contype: "f",
      definition:
        "FOREIGN KEY (household_id) REFERENCES public.households(id)",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_household_id_not_null",
      contype: "n",
      definition:
        "NOT NULL household_id",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_household_id_unique",
      contype: "u",
      definition:
        "UNIQUE (household_id, id)",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_household_user_unique",
      contype: "u",
      definition:
        "UNIQUE (household_id, user_id)",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_id_not_null",
      contype: "n",
      definition:
        "NOT NULL id",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_joined_at_not_null",
      contype: "n",
      definition:
        "NOT NULL joined_at",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_pkey",
      contype: "p",
      definition:
        "PRIMARY KEY (id)",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_role_check",
      contype: "c",
      definition:
        "CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'member'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_role_not_null",
      contype: "n",
      definition:
        "NOT NULL role",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_status_check",
      contype: "c",
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'left'::character varying, 'removed'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_status_not_null",
      contype: "n",
      definition:
        "NOT NULL status",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_updated_at_not_null",
      contype: "n",
      definition:
        "NOT NULL updated_at",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_user_id_fkey",
      contype: "f",
      definition:
        "FOREIGN KEY (user_id) REFERENCES public.users(id)",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_user_id_not_null",
      contype: "n",
      definition:
        "NOT NULL user_id",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_version_check",
      contype: "c",
      definition:
        "CHECK ((version >= 0))",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_version_not_null",
      contype: "n",
      definition:
        "NOT NULL version",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_cooking_skill_check",
      contype: "c",
      definition:
        "CHECK (((cooking_skill)::text = ANY ((ARRAY['none'::character varying, 'beginner'::character varying, 'intermediate'::character varying, 'advanced'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_cooking_skill_not_null",
      contype: "n",
      definition:
        "NOT NULL cooking_skill",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_created_at_not_null",
      contype: "n",
      definition:
        "NOT NULL created_at",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_default_participation_check",
      contype: "c",
      definition:
        "CHECK ((default_participation = ANY (ARRAY[0, 1])))",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_default_participation_not_null",
      contype: "n",
      definition:
        "NOT NULL default_participation",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_default_portion_scale_check",
      contype: "c",
      definition:
        "CHECK (((default_portion_scale >= 0.25) AND (default_portion_scale <= (4)::numeric)))",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_default_portion_scale_not_null",
      contype: "n",
      definition:
        "NOT NULL default_portion_scale",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_dietary_constraints_check",
      contype: "c",
      definition:
        "CHECK ((jsonb_typeof(dietary_constraints) = 'array'::text))",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_dietary_constraints_not_null",
      contype: "n",
      definition:
        "NOT NULL dietary_constraints",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_display_name_not_null",
      contype: "n",
      definition:
        "NOT NULL display_name",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_household_id_fkey",
      contype: "f",
      definition:
        "FOREIGN KEY (household_id) REFERENCES public.households(id)",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_household_id_not_null",
      contype: "n",
      definition:
        "NOT NULL household_id",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_household_id_unique",
      contype: "u",
      definition:
        "UNIQUE (household_id, id)",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_id_not_null",
      contype: "n",
      definition:
        "NOT NULL id",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_membership_foreign",
      contype: "f",
      definition:
        "FOREIGN KEY (household_id, linked_membership_id) REFERENCES public.memberships(household_id, id)",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_pkey",
      contype: "p",
      definition:
        "PRIMARY KEY (id)",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_status_check",
      contype: "c",
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_status_not_null",
      contype: "n",
      definition:
        "NOT NULL status",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_updated_at_not_null",
      contype: "n",
      definition:
        "NOT NULL updated_at",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_version_check",
      contype: "c",
      definition:
        "CHECK ((version >= 0))",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_version_not_null",
      contype: "n",
      definition:
        "NOT NULL version",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_auth_identity_id_not_null",
      contype: "n",
      definition:
        "NOT NULL auth_identity_id",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_expires_at_not_null",
      contype: "n",
      definition:
        "NOT NULL expires_at",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_expiry_check",
      contype: "c",
      definition:
        "CHECK (((expires_at > issued_at) AND (idle_expires_at > issued_at)))",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_id_not_null",
      contype: "n",
      definition:
        "NOT NULL id",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_identity_user_foreign",
      contype: "f",
      definition:
        "FOREIGN KEY (auth_identity_id, user_id) REFERENCES public.auth_identities(id, user_id)",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_idle_expires_at_not_null",
      contype: "n",
      definition:
        "NOT NULL idle_expires_at",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_issued_at_not_null",
      contype: "n",
      definition:
        "NOT NULL issued_at",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_last_seen_at_not_null",
      contype: "n",
      definition:
        "NOT NULL last_seen_at",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_pkey",
      contype: "p",
      definition:
        "PRIMARY KEY (id)",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_revoked_at_check",
      contype: "c",
      definition:
        "CHECK ((((status)::text = 'revoked'::text) = (revoked_at IS NOT NULL)))",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_status_check",
      contype: "c",
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'expired'::character varying, 'revoked'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_status_not_null",
      contype: "n",
      definition:
        "NOT NULL status",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_token_digest_not_null",
      contype: "n",
      definition:
        "NOT NULL token_digest",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_token_digest_unique",
      contype: "u",
      definition:
        "UNIQUE (token_digest)",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_token_version_check",
      contype: "c",
      definition:
        "CHECK ((token_version > 0))",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_token_version_not_null",
      contype: "n",
      definition:
        "NOT NULL token_version",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_user_id_fkey",
      contype: "f",
      definition:
        "FOREIGN KEY (user_id) REFERENCES public.users(id)",
    },
    {
      schema: "public",
      table: "sessions",
      name: "sessions_user_id_not_null",
      contype: "n",
      definition:
        "NOT NULL user_id",
    },
    {
      schema: "public",
      table: "users",
      name: "users_created_at_not_null",
      contype: "n",
      definition:
        "NOT NULL created_at",
    },
    {
      schema: "public",
      table: "users",
      name: "users_id_not_null",
      contype: "n",
      definition:
        "NOT NULL id",
    },
    {
      schema: "public",
      table: "users",
      name: "users_locale_not_null",
      contype: "n",
      definition:
        "NOT NULL locale",
    },
    {
      schema: "public",
      table: "users",
      name: "users_pkey",
      contype: "p",
      definition:
        "PRIMARY KEY (id)",
    },
    {
      schema: "public",
      table: "users",
      name: "users_status_check",
      contype: "c",
      definition:
        "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying, 'deletion_pending'::character varying])::text[])))",
    },
    {
      schema: "public",
      table: "users",
      name: "users_status_not_null",
      contype: "n",
      definition:
        "NOT NULL status",
    },
    {
      schema: "public",
      table: "users",
      name: "users_updated_at_not_null",
      contype: "n",
      definition:
        "NOT NULL updated_at",
    },
    {
      schema: "public",
      table: "users",
      name: "users_version_check",
      contype: "c",
      definition:
        "CHECK ((version >= 0))",
    },
    {
      schema: "public",
      table: "users",
      name: "users_version_not_null",
      contype: "n",
      definition:
        "NOT NULL version",
    },
  ],
  routines: [
    {
      schema: "meal_agent_private",
      name: "app_household_id",
      identityArguments: "",
      prokind: "f",
      owner: "migrator",
      securityDefiner: false,
      language: "sql",
      volatility: "s",
      parallelSafety: "s",
      leakproof: false,
      result: "uuid",
      config: [],
      bodyDigest:
        "e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246",
    },
    {
      schema: "meal_agent_private",
      name: "app_user_id",
      identityArguments: "",
      prokind: "f",
      owner: "migrator",
      securityDefiner: false,
      language: "sql",
      volatility: "s",
      parallelSafety: "s",
      leakproof: false,
      result: "uuid",
      config: [],
      bodyDigest:
        "e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a",
    },
    {
      schema: "meal_agent_private",
      name: "has_active_membership",
      identityArguments: "target_household_id uuid",
      prokind: "f",
      owner: "migrator",
      securityDefiner: true,
      language: "sql",
      volatility: "s",
      parallelSafety: "u",
      leakproof: false,
      result: "boolean",
      config: ["search_path=pg_catalog, public", "row_security=off"],
      bodyDigest:
        "07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b",
    },
    {
      schema: "meal_agent_private",
      name: "is_household_creator",
      identityArguments: "target_household_id uuid",
      prokind: "f",
      owner: "migrator",
      securityDefiner: true,
      language: "sql",
      volatility: "s",
      parallelSafety: "u",
      leakproof: false,
      result: "boolean",
      config: ["search_path=pg_catalog, public", "row_security=off"],
      bodyDigest:
        "5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a",
    },
  ],
  policies: [
    {
      schema: "public",
      table: "households",
      name: "households_creator_insert",
      command: "a",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((id = meal_agent_private.app_household_id()) AND (created_by_user_id = meal_agent_private.app_user_id()) AND ((status)::text = 'active'::text))",
    },
    {
      schema: "public",
      table: "households",
      name: "households_user_list_select",
      command: "r",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "(((meal_agent_private.app_household_id() IS NULL) OR (id = meal_agent_private.app_household_id())) AND meal_agent_private.has_active_membership(id))",
      withCheck:
        "",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_scope_insert",
      command: "a",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = 'user'::text) AND (household_id IS NULL)) OR (((scope_kind)::text = 'household'::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))))",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_scope_select",
      command: "r",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = 'user'::text) AND (household_id IS NULL)) OR (((scope_kind)::text = 'household'::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))))",
      withCheck:
        "",
    },
    {
      schema: "public",
      table: "idempotency_records",
      name: "idempotency_records_scope_update",
      command: "w",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = 'user'::text) AND (household_id IS NULL)) OR (((scope_kind)::text = 'household'::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))))",
      withCheck:
        "((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = 'user'::text) AND (household_id IS NULL)) OR (((scope_kind)::text = 'household'::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))))",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_household_insert",
      command: "a",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
    },
    {
      schema: "public",
      table: "inventory_events",
      name: "inventory_events_household_select",
      command: "r",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
      withCheck:
        "",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_household_insert",
      command: "a",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_household_select",
      command: "r",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
      withCheck:
        "",
    },
    {
      schema: "public",
      table: "inventory_lots",
      name: "inventory_lots_household_update",
      command: "w",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
      withCheck:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_bootstrap_select",
      command: "r",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((user_id = meal_agent_private.app_user_id()) AND ((status)::text = 'active'::text) AND ((meal_agent_private.app_household_id() IS NULL) OR (household_id = meal_agent_private.app_household_id())))",
      withCheck:
        "",
    },
    {
      schema: "public",
      table: "memberships",
      name: "memberships_creator_insert",
      command: "a",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((household_id = meal_agent_private.app_household_id()) AND (user_id = meal_agent_private.app_user_id()) AND ((role)::text = 'owner'::text) AND ((status)::text = 'active'::text) AND meal_agent_private.is_household_creator(household_id))",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_household_insert",
      command: "a",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "",
      withCheck:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
    },
    {
      schema: "public",
      table: "person_profiles",
      name: "person_profiles_household_select",
      command: "r",
      permissive: true,
      roles: ["meal_agent_app"],
      using:
        "((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))",
      withCheck:
        "",
    },
  ],
  types: [],
  triggers: [],
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
const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

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

  for (const entry of manifest.schemas) {
    push("schema", entry.name, `owner=${ownerToken(entry.owner)}`);
  }
  for (const entry of manifest.relations) {
    push(
      "relation",
      `${entry.schema}.${entry.name}`,
      `relkind=${entry.relkind} owner=${ownerToken(entry.owner)} ` +
        `rls=${flag(entry.rowSecurity)} force=${flag(entry.forceRowSecurity)}`,
    );
  }
  for (const entry of manifest.indexes) {
    push(
      "index",
      `${entry.schema}.${entry.name}`,
      `table=${entry.table} def=${entry.definition}`,
    );
  }
  for (const entry of manifest.constraints) {
    push(
      "constraint",
      `${entry.schema}.${entry.table}.${entry.name}`,
      `contype=${entry.contype} def=${entry.definition}`,
    );
  }
  for (const entry of manifest.routines) {
    push(
      "routine",
      `${entry.schema}.${entry.name}(${entry.identityArguments})`,
      `prokind=${entry.prokind} owner=${ownerToken(entry.owner)} ` +
        `secdef=${flag(entry.securityDefiner)} lang=${entry.language} ` +
        `volatile=${entry.volatility} parallel=${entry.parallelSafety} ` +
        `leakproof=${flag(entry.leakproof)} result=${entry.result} ` +
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
    push("type", `${entry.schema}.${entry.name}`, `typtype=${entry.typtype}`);
  }
  for (const entry of manifest.triggers) {
    push(
      "trigger",
      `${entry.schema}.${entry.table}.${entry.name}`,
      `def=${entry.definition}`,
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
 * 这些对象做 owner 归一化，其余对象一律按精确 owner 比较。
 */
export const handoffPendingKeys = (
  manifest: Stage06Manifest = stage06SecurityManifest,
): readonly string[] =>
  [
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
  ].sort(byCodeUnit);
