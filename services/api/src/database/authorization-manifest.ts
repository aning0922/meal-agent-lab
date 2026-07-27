import { createHash } from "node:crypto";

import { byCodeUnit } from "./stage06-manifest.js";

/**
 * 阶段 09A / M2A：**ledger 感知**的授权 manifest——目标数据库上「谁在什么阶段
 * 应该拥有什么权限」的唯一事实源。
 *
 * 为什么需要第二个 manifest：
 *
 *   1. 对象 manifest 描述的是冻结 `0000` 之后的**结构**，它只对 0000-only 状态
 *      成立，回答不了「0001—0004 应用之后 app 应该有哪些表权限」。
 *   2. 授权状态本身随两件事变化：
 *      - **ledger**：应用了哪些 migration，决定业务对象与它们自带的 GRANT；
 *      - **阶段**：`containment`（migration 之前 / 恢复之后立即收敛）与
 *        `final`（migration 之后建立最终 ACL）。备份角色的表级 `SELECT` 只在
 *        `final` 存在，因此把两者混为一谈必然要么放行过多、要么误伤。
 *   3. 因此这里按 `(ledger, phase)` 精确描述三件事：
 *      - `grants`：catalog 里的直接授权（`relacl` / `nspacl` / `proacl` …）；
 *      - `defaults`：`pg_default_acl` 的**有效**默认权限（含内建默认值）；
 *      - `effective`：`has_*_privilege` 的有效权限——它会把 `PUBLIC` 派生和角色
 *        继承一起算进来，因此只查直接授权看不见的洞在这里会显形。
 *
 * 未登记的 ledger 或阶段一律 fail closed：宁可让运维显式登记一个新状态，也不能
 * 让「没见过的状态」静默通过。
 */

export type AuthorizationPhase = "containment" | "final";

export interface AuthorizationGrantEntry {
  /** 对象键，例如 `relation:public.users`、`routine:meal_agent_private.f(uuid)`。 */
  readonly object: string;
  /** `PUBLIC` 或角色名。 */
  readonly grantee: string;
  /** 权限名，按 C 序排列；本 manifest 不允许任何 grant option。 */
  readonly privileges: readonly string[];
}

export interface AuthorizationDefaultEntry {
  /** `<objtype>@<schema|global>`，objtype 取 `r`/`S`/`f`/`T`/`n`/`L`。 */
  readonly scope: string;
  readonly grantee: string;
  readonly privileges: readonly string[];
}

export interface AuthorizationEffectiveEntry {
  readonly object: string;
  readonly role: string;
  readonly privileges: readonly string[];
}

/**
 * 受控 `SECURITY DEFINER` routine 的精确指纹。EXECUTE 授权由 `grants` 覆盖，
 * 但「谁能执行」只是一半：以谁的身份执行、带什么 `search_path` / `row_security`、
 * 正文是不是原来那一份，同样决定安全边界。因此这里按 **identity** 精确匹配，
 * 不做任何 schema 级通配豁免。
 */
export interface AuthorizationRoutineEntry {
  readonly identity: string;
  readonly owner: string;
  readonly securityDefiner: boolean;
  readonly config: readonly string[];
  readonly bodyDigest: string;
}

export interface AuthorizationState {
  /** 已应用的 migration 文件名，按文件名排序。 */
  readonly ledger: readonly string[];
  readonly phase: AuthorizationPhase;
  readonly routines: readonly AuthorizationRoutineEntry[];
  readonly grants: readonly AuthorizationGrantEntry[];
  readonly defaults: readonly AuthorizationDefaultEntry[];
  readonly effective: readonly AuthorizationEffectiveEntry[];
}

export interface AuthorizationManifest {
  readonly version: number;
  /** 被监管的授权对象；其余角色（如 owner 自身）不在收敛与断言范围内。 */
  readonly watchedGrantees: readonly string[];
  readonly managedSchemas: readonly string[];
  /**
   * 产品声明**禁用 Large Object**，因此这些 `pg_catalog` 入口点的
   * `PUBLIC EXECUTE` 必须被收回：只封堵对象权限而放着 `lo_create` /
   * `lo_creat` / `lo_from_bytea` 这些**创建入口**开着，等于允许 runtime 自己
   * 造出一个不受 schema ACL 与 RLS 约束的存储面。
   */
  readonly deniedRoutines: readonly string[];
  readonly states: readonly AuthorizationState[];
}

export class AuthorizationManifestError extends Error {
  public constructor(detail: string) {
    super(`authorization manifest: ${detail}`);
    this.name = "AuthorizationManifestError";
  }
}

export const authorizationManifestVersion = 1;

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
};

const manifestData: AuthorizationManifest = {
  version: authorizationManifestVersion,
  watchedGrantees: [
    "PUBLIC",
    "meal_agent_app",
    "meal_agent_backup",
    "meal_agent_backup_login",
    "meal_agent_migration_login",
    "meal_agent_runtime_login",
  ],
  managedSchemas: ["drizzle", "meal_agent_private", "public"],
  deniedRoutines: [
    "pg_catalog.lo_close(integer)",
    "pg_catalog.lo_creat(integer)",
    "pg_catalog.lo_create(oid)",
    "pg_catalog.lo_export(oid, text)",
    "pg_catalog.lo_from_bytea(oid, bytea)",
    "pg_catalog.lo_get(oid)",
    "pg_catalog.lo_get(oid, bigint, integer)",
    "pg_catalog.lo_import(text)",
    "pg_catalog.lo_import(text, oid)",
    "pg_catalog.lo_lseek(integer, integer, integer)",
    "pg_catalog.lo_lseek64(integer, bigint, integer)",
    "pg_catalog.lo_open(oid, integer)",
    "pg_catalog.lo_put(oid, bigint, bytea)",
    "pg_catalog.lo_tell(integer)",
    "pg_catalog.lo_tell64(integer)",
    "pg_catalog.lo_truncate(integer, integer)",
    "pg_catalog.lo_truncate64(integer, bigint)",
    "pg_catalog.lo_unlink(oid)",
    "pg_catalog.loread(integer, integer)",
    "pg_catalog.lowrite(integer, bytea)",
  ],
  states: [
    {
      ledger: ["0000_stage_06.sql"],
      phase: "containment",
      routines: [
        { identity:
          "meal_agent_private.app_household_id()",
          owner: "migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246" },
        { identity:
          "meal_agent_private.app_user_id()",
          owner: "migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a" },
        { identity:
          "meal_agent_private.has_active_membership(target_household_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b" },
        { identity:
          "meal_agent_private.is_household_creator(target_household_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a" },
      ],
      grants: [
        { object: "type:drizzle.___meal_agent_migrations",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._auth_identities",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._households",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._idempotency_records",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._inventory_events",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._inventory_lots",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._memberships",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._person_profiles",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._sessions",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._users",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "database:<current>",
          grantee: "meal_agent_backup_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          grantee: "meal_agent_migration_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          grantee: "meal_agent_runtime_login", privileges: ["CONNECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          grantee: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:public.auth_identities",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.households",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.idempotency_records",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.inventory_events",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.inventory_lots",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.memberships",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.person_profiles",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.sessions",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.users",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "routine:meal_agent_private.app_household_id()",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_user_id()",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.has_active_membership(target_household_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_household_creator(target_household_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "schema:drizzle",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:drizzle",
          grantee: "meal_agent_backup", privileges: ["USAGE"] },
        { object: "schema:meal_agent_private",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          grantee: "meal_agent_backup", privileges: ["USAGE"] },
      ],
      defaults: [
        { scope: "T@drizzle", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@global", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@meal_agent_private", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@public", grantee: "PUBLIC", privileges: ["USAGE"] },
      ],
      effective: [
        { object: "database:<current>",
          role: "meal_agent_backup_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          role: "meal_agent_migration_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          role: "meal_agent_runtime_login", privileges: ["CONNECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          role: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:public.auth_identities",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.households",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.idempotency_records",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.inventory_events",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.inventory_lots",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.memberships",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.person_profiles",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.sessions",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.users",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "routine:meal_agent_private.app_household_id()",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_user_id()",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.has_active_membership(target_household_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_household_creator(target_household_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "schema:drizzle",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:drizzle",
          role: "meal_agent_backup", privileges: ["USAGE"] },
        { object: "schema:meal_agent_private",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          role: "meal_agent_backup", privileges: ["USAGE"] },
      ],
    },
    {
      ledger: ["0000_stage_06.sql"],
      phase: "final",
      routines: [
        { identity:
          "meal_agent_private.app_household_id()",
          owner: "migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246" },
        { identity:
          "meal_agent_private.app_user_id()",
          owner: "migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a" },
        { identity:
          "meal_agent_private.has_active_membership(target_household_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b" },
        { identity:
          "meal_agent_private.is_household_creator(target_household_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a" },
      ],
      grants: [
        { object: "type:drizzle.___meal_agent_migrations",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._auth_identities",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._households",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._idempotency_records",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._inventory_events",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._inventory_lots",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._memberships",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._person_profiles",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._sessions",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._users",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "database:<current>",
          grantee: "meal_agent_backup_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          grantee: "meal_agent_migration_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          grantee: "meal_agent_runtime_login", privileges: ["CONNECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          grantee: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.auth_identities",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.auth_identities",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.households",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.households",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.idempotency_records",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.idempotency_records",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.inventory_events",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.inventory_events",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.inventory_lots",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.inventory_lots",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.memberships",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.memberships",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.person_profiles",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.person_profiles",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.sessions",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.sessions",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.users",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.users",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "routine:meal_agent_private.app_household_id()",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_user_id()",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.has_active_membership(target_household_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_household_creator(target_household_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "schema:drizzle",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:drizzle",
          grantee: "meal_agent_backup", privileges: ["USAGE"] },
        { object: "schema:meal_agent_private",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          grantee: "meal_agent_backup", privileges: ["USAGE"] },
      ],
      defaults: [
        { scope: "S@public", grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { scope: "T@drizzle", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@global", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@meal_agent_private", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@public", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "r@drizzle", grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { scope: "r@public", grantee: "meal_agent_backup", privileges: ["SELECT"] },
      ],
      effective: [
        { object: "database:<current>",
          role: "meal_agent_backup_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          role: "meal_agent_migration_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          role: "meal_agent_runtime_login", privileges: ["CONNECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          role: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.auth_identities",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.auth_identities",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.households",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.households",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.idempotency_records",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.idempotency_records",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.inventory_events",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.inventory_events",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.inventory_lots",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.inventory_lots",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.memberships",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.memberships",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.person_profiles",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.person_profiles",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.sessions",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.sessions",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.users",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.users",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "routine:meal_agent_private.app_household_id()",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_user_id()",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.has_active_membership(target_household_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_household_creator(target_household_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "schema:drizzle",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:drizzle",
          role: "meal_agent_backup", privileges: ["USAGE"] },
        { object: "schema:meal_agent_private",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          role: "meal_agent_backup", privileges: ["USAGE"] },
      ],
    },
    {
      ledger: ["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"],
      phase: "containment",
      routines: [
        { identity:
          "meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "8b3b8383eaafef2859c7c6c400fea4560397e2e791398f34eb3d92c983b84d19" },
        { identity:
          "meal_agent_private.app_household_id()",
          owner: "migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246" },
        { identity:
          "meal_agent_private.app_user_id()",
          owner: "migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a" },
        { identity:
          "meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "d8bd3080b2b718d97dd351aa88cabb64d887a05f70188c42875bd93598455ff4" },
        { identity:
          "meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "340b7dafbb3538c8f7be9b75680eee66ac11d95cb7bb63c7eacecc1f0dd181b4" },
        { identity:
          "meal_agent_private.has_active_membership(target_household_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b" },
        { identity:
          "meal_agent_private.is_active_owner(target_household_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "2f6eaefdd9503cc95274b27a06bd2c026510ccef5b7d5ee1e39c493856a12b1c" },
        { identity:
          "meal_agent_private.is_household_creator(target_household_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a" },
        { identity:
          "meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "49c69edb63ba9c79f1cebedfa662a79008307ef7ff58c654b90b3fa0a5f5802d" },
        { identity:
          "meal_agent_private.owns_profile(p_linked_membership_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "8a6ca11f5b63ddd757d2ab4ee55bd6d8eeafa0b86109e48d57804f7beb983d56" },
        { identity:
          "meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "9f114cec5f9c266b441cb4225ca188bd3069bbcc80b2dbb7d066725a3e3013b2" },
        { identity:
          "meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "bda888f524207ddd8ecb1875ed75cff298b4c8e57d27e869370f55cf92702e2a" },
        { identity:
          "meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)",
          owner: "migrator",
          securityDefiner: false,
          config: ["search_path=pg_catalog, public"],
          bodyDigest:
            "aaee625351184de80262214f2f0b048e1941afac9200ffd5c54b8956c71f250a" },
        { identity:
          "meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "73fd5f37faf85bef8803c3902375365d9f3d2eb5ced6d318813a911864b35df4" },
        { identity:
          "meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "5dabf7d1671c857717fd8a18d72ea7961ab6f582965f6177dcdb697d2f14988c" },
        { identity:
          "meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "44e6d5df0e195097d4a782ae2b4a0fd6e9eb6e2e74d570910ab075e804af1cc9" },
      ],
      grants: [
        { object: "type:drizzle.___meal_agent_migrations",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._auth_identities",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._household_invites",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._households",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._idempotency_records",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._inventory_events",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._inventory_lots",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._memberships",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._person_profile_link_requests",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._person_profiles",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._sessions",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._users",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "database:<current>",
          grantee: "meal_agent_backup_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          grantee: "meal_agent_migration_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          grantee: "meal_agent_runtime_login", privileges: ["CONNECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          grantee: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:public.auth_identities",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.household_invites",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.households",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.idempotency_records",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.inventory_events",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.inventory_lots",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.memberships",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.person_profile_link_requests",
          grantee: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:public.person_profiles",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.sessions",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.users",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_household_id()",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_user_id()",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.has_active_membership(target_household_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_active_owner(target_household_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_household_creator(target_household_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "schema:drizzle",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:drizzle",
          grantee: "meal_agent_backup", privileges: ["USAGE"] },
        { object: "schema:meal_agent_private",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          grantee: "meal_agent_backup", privileges: ["USAGE"] },
      ],
      defaults: [
        { scope: "T@drizzle", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@global", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@meal_agent_private", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@public", grantee: "PUBLIC", privileges: ["USAGE"] },
      ],
      effective: [
        { object: "database:<current>",
          role: "meal_agent_backup_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          role: "meal_agent_migration_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          role: "meal_agent_runtime_login", privileges: ["CONNECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          role: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:public.auth_identities",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.household_invites",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.households",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.idempotency_records",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.inventory_events",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.inventory_lots",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.memberships",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.person_profile_link_requests",
          role: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:public.person_profiles",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.sessions",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.users",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_household_id()",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_user_id()",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.has_active_membership(target_household_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_active_owner(target_household_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_household_creator(target_household_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "schema:drizzle",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:drizzle",
          role: "meal_agent_backup", privileges: ["USAGE"] },
        { object: "schema:meal_agent_private",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          role: "meal_agent_backup", privileges: ["USAGE"] },
      ],
    },
    {
      ledger: ["0000_stage_06.sql", "0001_stage_08.sql", "0002_stage_08_audit_closeout.sql", "0003_stage_08_secondary_closeout.sql", "0004_stage_08_final_closeout.sql"],
      phase: "final",
      routines: [
        { identity:
          "meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "8b3b8383eaafef2859c7c6c400fea4560397e2e791398f34eb3d92c983b84d19" },
        { identity:
          "meal_agent_private.app_household_id()",
          owner: "migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246" },
        { identity:
          "meal_agent_private.app_user_id()",
          owner: "migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a" },
        { identity:
          "meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "d8bd3080b2b718d97dd351aa88cabb64d887a05f70188c42875bd93598455ff4" },
        { identity:
          "meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "340b7dafbb3538c8f7be9b75680eee66ac11d95cb7bb63c7eacecc1f0dd181b4" },
        { identity:
          "meal_agent_private.has_active_membership(target_household_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b" },
        { identity:
          "meal_agent_private.is_active_owner(target_household_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "2f6eaefdd9503cc95274b27a06bd2c026510ccef5b7d5ee1e39c493856a12b1c" },
        { identity:
          "meal_agent_private.is_household_creator(target_household_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a" },
        { identity:
          "meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "49c69edb63ba9c79f1cebedfa662a79008307ef7ff58c654b90b3fa0a5f5802d" },
        { identity:
          "meal_agent_private.owns_profile(p_linked_membership_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "8a6ca11f5b63ddd757d2ab4ee55bd6d8eeafa0b86109e48d57804f7beb983d56" },
        { identity:
          "meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "9f114cec5f9c266b441cb4225ca188bd3069bbcc80b2dbb7d066725a3e3013b2" },
        { identity:
          "meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "bda888f524207ddd8ecb1875ed75cff298b4c8e57d27e869370f55cf92702e2a" },
        { identity:
          "meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)",
          owner: "migrator",
          securityDefiner: false,
          config: ["search_path=pg_catalog, public"],
          bodyDigest:
            "aaee625351184de80262214f2f0b048e1941afac9200ffd5c54b8956c71f250a" },
        { identity:
          "meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "73fd5f37faf85bef8803c3902375365d9f3d2eb5ced6d318813a911864b35df4" },
        { identity:
          "meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "5dabf7d1671c857717fd8a18d72ea7961ab6f582965f6177dcdb697d2f14988c" },
        { identity:
          "meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)",
          owner: "migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public", "row_security=off"],
          bodyDigest:
            "44e6d5df0e195097d4a782ae2b4a0fd6e9eb6e2e74d570910ab075e804af1cc9" },
      ],
      grants: [
        { object: "type:drizzle.___meal_agent_migrations",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._auth_identities",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._household_invites",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._households",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._idempotency_records",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._inventory_events",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._inventory_lots",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._memberships",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._person_profile_link_requests",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._person_profiles",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._sessions",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "type:public._users",
          grantee: "PUBLIC", privileges: ["USAGE"] },
        { object: "database:<current>",
          grantee: "meal_agent_backup_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          grantee: "meal_agent_migration_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          grantee: "meal_agent_runtime_login", privileges: ["CONNECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          grantee: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.auth_identities",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.auth_identities",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.household_invites",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.household_invites",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.households",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.households",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.idempotency_records",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.idempotency_records",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.inventory_events",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.inventory_events",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.inventory_lots",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.inventory_lots",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.memberships",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.memberships",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.person_profile_link_requests",
          grantee: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:public.person_profile_link_requests",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.person_profiles",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.person_profiles",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.sessions",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.sessions",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.users",
          grantee: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.users",
          grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_household_id()",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_user_id()",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.has_active_membership(target_household_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_active_owner(target_household_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_household_creator(target_household_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)",
          grantee: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "schema:drizzle",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:drizzle",
          grantee: "meal_agent_backup", privileges: ["USAGE"] },
        { object: "schema:meal_agent_private",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          grantee: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          grantee: "meal_agent_backup", privileges: ["USAGE"] },
      ],
      defaults: [
        { scope: "S@public", grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { scope: "T@drizzle", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@global", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@meal_agent_private", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "T@public", grantee: "PUBLIC", privileges: ["USAGE"] },
        { scope: "r@drizzle", grantee: "meal_agent_backup", privileges: ["SELECT"] },
        { scope: "r@public", grantee: "meal_agent_backup", privileges: ["SELECT"] },
      ],
      effective: [
        { object: "database:<current>",
          role: "meal_agent_backup_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          role: "meal_agent_migration_login", privileges: ["CONNECT"] },
        { object: "database:<current>",
          role: "meal_agent_runtime_login", privileges: ["CONNECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          role: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:drizzle.__meal_agent_migrations",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.auth_identities",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.auth_identities",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.household_invites",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.household_invites",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.households",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.households",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.idempotency_records",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.idempotency_records",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.inventory_events",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.inventory_events",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.inventory_lots",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.inventory_lots",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.memberships",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.memberships",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.person_profile_link_requests",
          role: "meal_agent_app", privileges: ["SELECT"] },
        { object: "relation:public.person_profile_link_requests",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.person_profiles",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT"] },
        { object: "relation:public.person_profiles",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.sessions",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.sessions",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "relation:public.users",
          role: "meal_agent_app", privileges: ["INSERT", "SELECT", "UPDATE"] },
        { object: "relation:public.users",
          role: "meal_agent_backup", privileges: ["SELECT"] },
        { object: "routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_household_id()",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.app_user_id()",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.has_active_membership(target_household_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_active_owner(target_household_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.is_household_creator(target_household_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)",
          role: "meal_agent_app", privileges: ["EXECUTE"] },
        { object: "schema:drizzle",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:drizzle",
          role: "meal_agent_backup", privileges: ["USAGE"] },
        { object: "schema:meal_agent_private",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          role: "meal_agent_app", privileges: ["USAGE"] },
        { object: "schema:public",
          role: "meal_agent_backup", privileges: ["USAGE"] },
      ],
    },
  ],
};

export const authorizationManifest: AuthorizationManifest =
  deepFreeze(manifestData);

/** default ACL 的槽位：`objtype@scope`。收敛与断言都按这些槽位逐个比较。 */
export const defaultAclSlots = (
  manifest: AuthorizationManifest = authorizationManifest,
): readonly { readonly objtype: string; readonly scope: string }[] => {
  const slots: { objtype: string; scope: string }[] = [];
  for (const objtype of ["r", "S", "f", "T"]) {
    for (const scope of manifest.managedSchemas) {
      slots.push({ objtype, scope });
    }
  }
  for (const objtype of ["r", "S", "f", "T", "n", "L"]) {
    slots.push({ objtype, scope: "global" });
  }
  return slots.sort((left, right) =>
    byCodeUnit(
      `${left.objtype}@${left.scope}`,
      `${right.objtype}@${right.scope}`,
    ),
  );
};

/** `(ledger, phase)` 的稳定 key：ledger 用逗号连接，再接阶段。 */
export const authorizationStateKey = (
  ledger: readonly string[],
  phase: AuthorizationPhase,
): string => `${[...ledger].sort(byCodeUnit).join(",")}|${phase}`;

export interface AuthorizationCanonicalRow {
  readonly state: string;
  readonly kind: string;
  readonly identity: string;
  readonly detail: string;
}

const forbiddenCharacters = /[\\\r\n\u0000]/u;

const assertRenderable = (field: string, value: string): string => {
  if (forbiddenCharacters.test(value)) {
    throw new AuthorizationManifestError(
      `${field} contains a character that cannot be rendered deterministically`,
    );
  }
  return value;
};

const privilegeList = (privileges: readonly string[]): string => {
  if (privileges.length === 0) {
    throw new AuthorizationManifestError(
      "an entry must not declare an empty privilege set; omit the entry instead",
    );
  }
  for (const privilege of privileges) {
    if (privilege.endsWith("*")) {
      throw new AuthorizationManifestError(
        `grant options are never allowed: ${privilege}`,
      );
    }
  }
  return [...privileges].sort(byCodeUnit).join(",");
};

/**
 * 规范化行。与对象 manifest 一样强制唯一键与固定排序；这里的唯一键是
 * `(state, kind, identity)`，因为同一对象在不同 `(ledger, phase)` 下有不同期望。
 */
export const canonicalAuthorizationRows = (
  manifest: AuthorizationManifest = authorizationManifest,
): readonly AuthorizationCanonicalRow[] => {
  const rows: AuthorizationCanonicalRow[] = [];
  const push = (
    state: string,
    kind: string,
    identity: string,
    detail: string,
  ): void => {
    rows.push({
      state: assertRenderable("state", state),
      kind: assertRenderable("kind", kind),
      identity: assertRenderable("identity", identity),
      detail: assertRenderable("detail", detail),
    });
  };

  for (const state of manifest.states) {
    const key = authorizationStateKey(state.ledger, state.phase);
    for (const entry of state.routines) {
      push(
        key,
        "routine",
        entry.identity,
        `owner=${entry.owner === "migrator" ? "meal_agent_migrator" : entry.owner} ` +
          `secdef=${entry.securityDefiner ? "t" : "f"} ` +
          `config=${entry.config.join("|")} body=${entry.bodyDigest}`,
      );
    }
    for (const entry of state.grants) {
      if (!manifest.watchedGrantees.includes(entry.grantee)) {
        throw new AuthorizationManifestError(
          `grant for unwatched grantee ${entry.grantee}`,
        );
      }
      push(
        key,
        "grant",
        `${entry.object}#${entry.grantee}`,
        `privs=${privilegeList(entry.privileges)}`,
      );
    }
    for (const entry of state.defaults) {
      push(
        key,
        "default",
        `${entry.scope}#${entry.grantee}`,
        `privs=${privilegeList(entry.privileges)}`,
      );
    }
    for (const entry of state.effective) {
      push(
        key,
        "effective",
        `${entry.object}#${entry.role}`,
        `privs=${privilegeList(entry.privileges)}`,
      );
    }
  }

  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.state}:${row.kind}:${row.identity}`;
    if (seen.has(key)) {
      throw new AuthorizationManifestError(`duplicate identity ${key}`);
    }
    seen.add(key);
  }

  const stateKeys = new Set(
    manifest.states.map((state) =>
      authorizationStateKey(state.ledger, state.phase),
    ),
  );
  if (stateKeys.size !== manifest.states.length) {
    throw new AuthorizationManifestError("duplicate (ledger, phase) state");
  }

  rows.sort(
    (left, right) =>
      byCodeUnit(left.state, right.state) ||
      byCodeUnit(left.kind, right.kind) ||
      byCodeUnit(left.identity, right.identity),
  );
  return rows;
};

export const canonicalAuthorizationText = (
  manifest: AuthorizationManifest = authorizationManifest,
): string =>
  `${canonicalAuthorizationRows(manifest)
    .map((row) => `${row.state}|${row.kind}|${row.identity}|${row.detail}`)
    .join("\n")}\n`;

export const authorizationDigest = (
  manifest: AuthorizationManifest = authorizationManifest,
): string =>
  createHash("sha256")
    .update(canonicalAuthorizationText(manifest), "utf8")
    .digest("hex");

/** 已登记的 `(ledger, phase)` state key，按 C 序排列。 */
export const authorizationStateKeys = (
  manifest: AuthorizationManifest = authorizationManifest,
): readonly string[] =>
  manifest.states
    .map((state) => authorizationStateKey(state.ledger, state.phase))
    .sort(byCodeUnit);
