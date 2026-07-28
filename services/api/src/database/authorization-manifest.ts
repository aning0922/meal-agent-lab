import { createHash } from "node:crypto";

import {
  assertRenderableValue,
  defaultObjtypeRules,
  encodeProjectionIdentity,
  globalDefaultScope,
  grantableObjectClasses,
  objectClassPrivileges,
  type ProjectionIdentityPart,
} from "./authorization-identity.js";
import { byCodeUnit } from "./stage06-manifest.js";

/**
 * 阶段 09A / M2A（R8B）：**ledger 感知**的授权 manifest——目标数据库上「谁在什么
 * 阶段应该拥有什么权限」的唯一事实源。
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
 *
 * 未登记的 ledger 或阶段一律 fail closed：宁可让运维显式登记一个新状态，也不能
 * 让「没见过的状态」静默通过。
 *
 * ## R8B：manifest 只登记**固定允许项**，其余全部由可移植策略判定
 *
 * manifest **不是**对当前环境的快照，也不再枚举「要观察哪些 grantee」。观察面由
 * canonical projector 动态给出（全部 grantee 与 grantor），manifest 只回答「哪些
 * 是允许的」：
 *
 * - `grants`：固定允许的**直接授权**，canonical grantor 恒为
 *   {@link AuthorizationPrincipals.owner}，且**永不允许 grant option**。只覆盖
 *   database / schema / relation / routine 四类；type、column、language、
 *   Large Object 与 20 个 LO 入口点由**策略**判定，manifest 不得为它们登记允许
 *   项（见 `authorization-policy-sql.ts`）。
 * - `defaults`：`pg_default_acl` 的**物理行**条目——它决定实际要执行哪条
 *   `ALTER DEFAULT PRIVILEGES`。**不是**有效默认权限。
 * - `defaultEffective`：按 PostgreSQL 真实语义叠加出的**有效**默认权限，**只用于
 *   最终语义验证**。禁止据此反推该执行哪条 default privilege DDL：内建默认不需要
 *   任何 DDL，而 `defaults` 里的物理行才需要。
 * - `effective`：`has_*_privilege` 的有效权限——`PUBLIC` 派生与角色继承都算在内。
 *   只对 {@link AuthorizationPrincipals.grantees} 与上述四类对象**逐条精确验证**；
 *   目标库里其他非 superuser LOGIN 由策略判定（除内建 language `USAGE` 外不得有
 *   任何受监管权限）。
 * - `routines`：受控 routine 的 identity/owner/`SECURITY DEFINER`/`proconfig`/
 *   正文摘要。managed schema 里出现任何**未登记**的 routine 一律 fail closed。
 *
 * 所有 identity 都是**结构化 JSON 数组**，与 canonical projector 的编码逐字节
 * 相同；任何一侧都不得用字符串拼接或 `split_part` 反解。
 */

export type AuthorizationPhase = "containment" | "final";

/**
 * 固定的项目主体。它**只**允许用于三件事：
 *
 *   1. 固定允许权限（`grants` / `effective` 的 grantee 白名单，与 canonical
 *      grantor）；
 *   2. 角色存在性（六个项目角色必须存在，membership 图必须恰好是三条边）；
 *   3. 区分「项目角色」与「动态发现的外部角色」。
 *
 * 它**不得**用来过滤 catalog 里的 grantee 或 grantor——观察面必须是动态的，否则
 * 一个没登记过的角色拿到权限就永远看不见。
 */
export interface AuthorizationPrincipals {
  /** 全部受管理对象的 canonical owner，也是固定允许授权的 canonical grantor。 */
  readonly owner: string;
  /** 受精确验证的授权主体：`PUBLIC` 与五个项目角色（不含 owner）。 */
  readonly grantees: readonly string[];
  /** 三个登录角色。 */
  readonly logins: readonly string[];
  /** canonical membership 图：恰好三条边，全部 `INHERIT FALSE, SET TRUE`。 */
  readonly memberships: readonly AuthorizationMembershipEntry[];
}

export interface AuthorizationMembershipEntry {
  readonly member: string;
  readonly granted: string;
}

export interface AuthorizationGrantEntry {
  /** 结构化对象键，例如 `["relation", "public", "users"]`。 */
  readonly object: readonly ProjectionIdentityPart[];
  /** `PUBLIC` 或项目角色名。 */
  readonly grantee: string;
  /** 权限名，按 C 序排列；本 manifest 不允许任何 grant option。 */
  readonly privileges: readonly string[];
}

/**
 * `pg_default_acl` 的**物理行**条目。`defaclrole` 与 grantor 恒为
 * {@link AuthorizationPrincipals.owner}，`grantable` 恒为 false，因此不在这里
 * 重复登记。`scope` 是 managed schema 名或 {@link globalDefaultScope}。
 */
export interface AuthorizationDefaultEntry {
  readonly objtype: string;
  readonly scope: string;
  readonly grantee: string;
  readonly privileges: readonly string[];
}

/** 叠加之后的**有效**默认权限，只用于最终语义验证。 */
export interface AuthorizationDefaultEffectiveEntry {
  readonly objtype: string;
  readonly scope: string;
  readonly grantee: string;
  readonly privileges: readonly string[];
}

export interface AuthorizationEffectiveEntry {
  readonly object: readonly ProjectionIdentityPart[];
  readonly role: string;
  readonly privileges: readonly string[];
}

/**
 * 受控 `SECURITY DEFINER` routine 的精确指纹。EXECUTE 授权由 `grants` 覆盖，
 * 但「谁能执行」只是一半：以谁的身份执行、带什么 `search_path` / `row_security`、
 * 正文是不是原来那一份，同样决定安全边界。因此这里按**结构化 identity** 精确
 * 匹配，不做任何 schema 级通配豁免。
 */
export interface AuthorizationRoutineEntry {
  readonly object: readonly ProjectionIdentityPart[];
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
  readonly defaultEffective: readonly AuthorizationDefaultEffectiveEntry[];
  readonly effective: readonly AuthorizationEffectiveEntry[];
}

export interface AuthorizationManifest {
  readonly version: number;
  readonly principals: AuthorizationPrincipals;
  readonly managedSchemas: readonly string[];
  /**
   * 产品声明**禁用 Large Object**，因此这些 `pg_catalog` 入口点只允许函数
   * owner 自身的 `EXECUTE`：只封堵对象权限而放着 `lo_create` / `lo_creat` /
   * `lo_from_bytea` 这些**创建入口**开着，等于允许 runtime 自己造出一个不受
   * schema ACL 与 RLS 约束的存储面。
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

/**
 * 版本 2：R8B 把 canonical projector 接入 verify/converge。相对版本 1 的破坏性
 * 变化——`watchedGrantees` 静态观察名单被 `principals` 取代（后者只表达允许项与
 * 角色存在性，不再过滤观察面）；identity 改为结构化 JSON 数组；`defaults` 从
 * 「有效默认权限」改为 **`pg_default_acl` 物理行**，有效默认权限移到
 * `defaultEffective`；数组类型的 `PUBLIC USAGE` 条目删除（PostgreSQL 直接拒绝
 * 对数组类型授权，它们只向元素类型委托）。
 */
export const authorizationManifestVersion = 2;

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
  principals: {
    owner: "meal_agent_migrator",
    grantees: [
      "PUBLIC",
      "meal_agent_app",
      "meal_agent_backup",
      "meal_agent_backup_login",
      "meal_agent_migration_login",
      "meal_agent_runtime_login",
    ],
    logins: [
      "meal_agent_backup_login",
      "meal_agent_migration_login",
      "meal_agent_runtime_login",
    ],
    memberships: [
      { member: "meal_agent_backup_login", granted: "meal_agent_backup" },
      { member: "meal_agent_migration_login", granted: "meal_agent_migrator" },
      { member: "meal_agent_runtime_login", granted: "meal_agent_app" },
    ],
  },
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
      ledger: [
        "0000_stage_06.sql",
      ],
      phase: "containment",
      routines: [
        {
          object: ["routine","meal_agent_private","app_household_id",[]],
          owner: "meal_agent_migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246",
        },
        {
          object: ["routine","meal_agent_private","app_user_id",[]],
          owner: "meal_agent_migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a",
        },
        {
          object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b",
        },
        {
          object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a",
        },
      ],
      grants: [
        { object: ["database","<current>"],
          grantee: "meal_agent_backup_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          grantee: "meal_agent_migration_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          grantee: "meal_agent_runtime_login",
          privileges: ["CONNECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          grantee: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","public","auth_identities"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","households"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","idempotency_records"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","inventory_events"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","inventory_lots"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","memberships"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","person_profiles"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","sessions"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","users"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["routine","meal_agent_private","app_household_id",[]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_user_id",[]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["schema","drizzle"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","drizzle"],
          grantee: "meal_agent_backup",
          privileges: ["USAGE"] },
        { object: ["schema","meal_agent_private"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          grantee: "meal_agent_backup",
          privileges: ["USAGE"] },
      ],
      defaults: [
        { objtype: "T", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "f", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
      ],
      defaultEffective: [
        { objtype: "L", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE"] },
        { objtype: "S", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "T", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "f", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "n", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["CREATE","USAGE"] },
        { objtype: "r", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
      ],
      effective: [
        { object: ["database","<current>"],
          role: "meal_agent_backup_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          role: "meal_agent_migration_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          role: "meal_agent_runtime_login",
          privileges: ["CONNECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          role: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","public","auth_identities"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","households"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","idempotency_records"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","inventory_events"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","inventory_lots"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","memberships"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","person_profiles"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","sessions"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","users"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["routine","meal_agent_private","app_household_id",[]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_user_id",[]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["schema","drizzle"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","drizzle"],
          role: "meal_agent_backup",
          privileges: ["USAGE"] },
        { object: ["schema","meal_agent_private"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          role: "meal_agent_backup",
          privileges: ["USAGE"] },
      ],
    },
    {
      ledger: [
        "0000_stage_06.sql",
      ],
      phase: "final",
      routines: [
        {
          object: ["routine","meal_agent_private","app_household_id",[]],
          owner: "meal_agent_migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246",
        },
        {
          object: ["routine","meal_agent_private","app_user_id",[]],
          owner: "meal_agent_migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a",
        },
        {
          object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b",
        },
        {
          object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a",
        },
      ],
      grants: [
        { object: ["database","<current>"],
          grantee: "meal_agent_backup_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          grantee: "meal_agent_migration_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          grantee: "meal_agent_runtime_login",
          privileges: ["CONNECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          grantee: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","auth_identities"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","auth_identities"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","households"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","households"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","idempotency_records"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","idempotency_records"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","inventory_events"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","inventory_events"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","inventory_lots"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","inventory_lots"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","memberships"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","memberships"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","person_profiles"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","person_profiles"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","sessions"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","sessions"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","users"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","users"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["routine","meal_agent_private","app_household_id",[]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_user_id",[]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["schema","drizzle"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","drizzle"],
          grantee: "meal_agent_backup",
          privileges: ["USAGE"] },
        { object: ["schema","meal_agent_private"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          grantee: "meal_agent_backup",
          privileges: ["USAGE"] },
      ],
      defaults: [
        { objtype: "S", scope: "public",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { objtype: "T", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "f", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "r", scope: "drizzle",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { objtype: "r", scope: "public",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
      ],
      defaultEffective: [
        { objtype: "L", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE"] },
        { objtype: "S", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "public",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { objtype: "S", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "T", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "f", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "n", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["CREATE","USAGE"] },
        { objtype: "r", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "drizzle",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { objtype: "r", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "public",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { objtype: "r", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
      ],
      effective: [
        { object: ["database","<current>"],
          role: "meal_agent_backup_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          role: "meal_agent_migration_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          role: "meal_agent_runtime_login",
          privileges: ["CONNECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          role: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","auth_identities"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","auth_identities"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","households"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","households"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","idempotency_records"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","idempotency_records"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","inventory_events"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","inventory_events"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","inventory_lots"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","inventory_lots"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","memberships"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","memberships"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","person_profiles"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","person_profiles"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","sessions"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","sessions"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","users"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","users"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["routine","meal_agent_private","app_household_id",[]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_user_id",[]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["schema","drizzle"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","drizzle"],
          role: "meal_agent_backup",
          privileges: ["USAGE"] },
        { object: ["schema","meal_agent_private"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          role: "meal_agent_backup",
          privileges: ["USAGE"] },
      ],
    },
    {
      ledger: [
        "0000_stage_06.sql",
        "0001_stage_08.sql",
        "0002_stage_08_audit_closeout.sql",
        "0003_stage_08_secondary_closeout.sql",
        "0004_stage_08_final_closeout.sql",
      ],
      phase: "containment",
      routines: [
        {
          object: ["routine","meal_agent_private","add_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"],["pg_catalog","jsonb"],["pg_catalog","bool"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "8b3b8383eaafef2859c7c6c400fea4560397e2e791398f34eb3d92c983b84d19",
        },
        {
          object: ["routine","meal_agent_private","app_household_id",[]],
          owner: "meal_agent_migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246",
        },
        {
          object: ["routine","meal_agent_private","app_user_id",[]],
          owner: "meal_agent_migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a",
        },
        {
          object: ["routine","meal_agent_private","confirm_person_profile_link",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "d8bd3080b2b718d97dd351aa88cabb64d887a05f70188c42875bd93598455ff4",
        },
        {
          object: ["routine","meal_agent_private","create_person_profile_link_request",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","int4"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "340b7dafbb3538c8f7be9b75680eee66ac11d95cb7bb63c7eacecc1f0dd181b4",
        },
        {
          object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b",
        },
        {
          object: ["routine","meal_agent_private","is_active_owner",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "2f6eaefdd9503cc95274b27a06bd2c026510ccef5b7d5ee1e39c493856a12b1c",
        },
        {
          object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a",
        },
        {
          object: ["routine","meal_agent_private","materialize_person_profile_link_requests",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "49c69edb63ba9c79f1cebedfa662a79008307ef7ff58c654b90b3fa0a5f5802d",
        },
        {
          object: ["routine","meal_agent_private","owns_profile",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "8a6ca11f5b63ddd757d2ab4ee55bd6d8eeafa0b86109e48d57804f7beb983d56",
        },
        {
          object: ["routine","meal_agent_private","redeem_household_invite",[["pg_catalog","bpchar"],["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "9f114cec5f9c266b441cb4225ca188bd3069bbcc80b2dbb7d066725a3e3013b2",
        },
        {
          object: ["routine","meal_agent_private","remove_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "bda888f524207ddd8ecb1875ed75cff298b4c8e57d27e869370f55cf92702e2a",
        },
        {
          object: ["routine","meal_agent_private","stage08_constraints_are_safe",[["pg_catalog","jsonb"]]],
          owner: "meal_agent_migrator",
          securityDefiner: false,
          config: ["search_path=pg_catalog, public"],
          bodyDigest:
            "aaee625351184de80262214f2f0b048e1941afac9200ffd5c54b8956c71f250a",
        },
        {
          object: ["routine","meal_agent_private","transition_membership_status",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "73fd5f37faf85bef8803c3902375365d9f3d2eb5ced6d318813a911864b35df4",
        },
        {
          object: ["routine","meal_agent_private","transition_person_profile_status",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","text"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "5dabf7d1671c857717fd8a18d72ea7961ab6f582965f6177dcdb697d2f14988c",
        },
        {
          object: ["routine","meal_agent_private","update_person_profile_fields",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","text"],["pg_catalog","bool"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","numeric"],["pg_catalog","bool"],["pg_catalog","text"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "44e6d5df0e195097d4a782ae2b4a0fd6e9eb6e2e74d570910ab075e804af1cc9",
        },
      ],
      grants: [
        { object: ["database","<current>"],
          grantee: "meal_agent_backup_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          grantee: "meal_agent_migration_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          grantee: "meal_agent_runtime_login",
          privileges: ["CONNECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          grantee: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","public","auth_identities"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","household_invites"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","households"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","idempotency_records"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","inventory_events"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","inventory_lots"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","memberships"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","person_profile_link_requests"],
          grantee: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","public","person_profiles"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","sessions"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","users"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["routine","meal_agent_private","add_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"],["pg_catalog","jsonb"],["pg_catalog","bool"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_household_id",[]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_user_id",[]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","confirm_person_profile_link",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","create_person_profile_link_request",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","int4"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_active_owner",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","materialize_person_profile_link_requests",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","owns_profile",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","redeem_household_invite",[["pg_catalog","bpchar"],["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","remove_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","stage08_constraints_are_safe",[["pg_catalog","jsonb"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","transition_membership_status",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","transition_person_profile_status",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","text"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","update_person_profile_fields",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","text"],["pg_catalog","bool"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","numeric"],["pg_catalog","bool"],["pg_catalog","text"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["schema","drizzle"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","drizzle"],
          grantee: "meal_agent_backup",
          privileges: ["USAGE"] },
        { object: ["schema","meal_agent_private"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          grantee: "meal_agent_backup",
          privileges: ["USAGE"] },
      ],
      defaults: [
        { objtype: "T", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "f", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
      ],
      defaultEffective: [
        { objtype: "L", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE"] },
        { objtype: "S", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "T", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "f", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "n", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["CREATE","USAGE"] },
        { objtype: "r", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
      ],
      effective: [
        { object: ["database","<current>"],
          role: "meal_agent_backup_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          role: "meal_agent_migration_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          role: "meal_agent_runtime_login",
          privileges: ["CONNECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          role: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","public","auth_identities"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","household_invites"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","households"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","idempotency_records"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","inventory_events"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","inventory_lots"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","memberships"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","person_profile_link_requests"],
          role: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","public","person_profiles"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","sessions"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","users"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["routine","meal_agent_private","add_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"],["pg_catalog","jsonb"],["pg_catalog","bool"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_household_id",[]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_user_id",[]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","confirm_person_profile_link",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","create_person_profile_link_request",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","int4"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_active_owner",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","materialize_person_profile_link_requests",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","owns_profile",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","redeem_household_invite",[["pg_catalog","bpchar"],["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","remove_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","stage08_constraints_are_safe",[["pg_catalog","jsonb"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","transition_membership_status",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","transition_person_profile_status",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","text"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","update_person_profile_fields",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","text"],["pg_catalog","bool"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","numeric"],["pg_catalog","bool"],["pg_catalog","text"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["schema","drizzle"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","drizzle"],
          role: "meal_agent_backup",
          privileges: ["USAGE"] },
        { object: ["schema","meal_agent_private"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          role: "meal_agent_backup",
          privileges: ["USAGE"] },
      ],
    },
    {
      ledger: [
        "0000_stage_06.sql",
        "0001_stage_08.sql",
        "0002_stage_08_audit_closeout.sql",
        "0003_stage_08_secondary_closeout.sql",
        "0004_stage_08_final_closeout.sql",
      ],
      phase: "final",
      routines: [
        {
          object: ["routine","meal_agent_private","add_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"],["pg_catalog","jsonb"],["pg_catalog","bool"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "8b3b8383eaafef2859c7c6c400fea4560397e2e791398f34eb3d92c983b84d19",
        },
        {
          object: ["routine","meal_agent_private","app_household_id",[]],
          owner: "meal_agent_migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246",
        },
        {
          object: ["routine","meal_agent_private","app_user_id",[]],
          owner: "meal_agent_migrator",
          securityDefiner: false,
          config: [],
          bodyDigest:
            "e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a",
        },
        {
          object: ["routine","meal_agent_private","confirm_person_profile_link",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "d8bd3080b2b718d97dd351aa88cabb64d887a05f70188c42875bd93598455ff4",
        },
        {
          object: ["routine","meal_agent_private","create_person_profile_link_request",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","int4"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "340b7dafbb3538c8f7be9b75680eee66ac11d95cb7bb63c7eacecc1f0dd181b4",
        },
        {
          object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b",
        },
        {
          object: ["routine","meal_agent_private","is_active_owner",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "2f6eaefdd9503cc95274b27a06bd2c026510ccef5b7d5ee1e39c493856a12b1c",
        },
        {
          object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a",
        },
        {
          object: ["routine","meal_agent_private","materialize_person_profile_link_requests",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "49c69edb63ba9c79f1cebedfa662a79008307ef7ff58c654b90b3fa0a5f5802d",
        },
        {
          object: ["routine","meal_agent_private","owns_profile",[["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "8a6ca11f5b63ddd757d2ab4ee55bd6d8eeafa0b86109e48d57804f7beb983d56",
        },
        {
          object: ["routine","meal_agent_private","redeem_household_invite",[["pg_catalog","bpchar"],["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "9f114cec5f9c266b441cb4225ca188bd3069bbcc80b2dbb7d066725a3e3013b2",
        },
        {
          object: ["routine","meal_agent_private","remove_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "bda888f524207ddd8ecb1875ed75cff298b4c8e57d27e869370f55cf92702e2a",
        },
        {
          object: ["routine","meal_agent_private","stage08_constraints_are_safe",[["pg_catalog","jsonb"]]],
          owner: "meal_agent_migrator",
          securityDefiner: false,
          config: ["search_path=pg_catalog, public"],
          bodyDigest:
            "aaee625351184de80262214f2f0b048e1941afac9200ffd5c54b8956c71f250a",
        },
        {
          object: ["routine","meal_agent_private","transition_membership_status",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "73fd5f37faf85bef8803c3902375365d9f3d2eb5ced6d318813a911864b35df4",
        },
        {
          object: ["routine","meal_agent_private","transition_person_profile_status",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","text"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "5dabf7d1671c857717fd8a18d72ea7961ab6f582965f6177dcdb697d2f14988c",
        },
        {
          object: ["routine","meal_agent_private","update_person_profile_fields",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","text"],["pg_catalog","bool"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","numeric"],["pg_catalog","bool"],["pg_catalog","text"]]],
          owner: "meal_agent_migrator",
          securityDefiner: true,
          config: ["search_path=pg_catalog, public","row_security=off"],
          bodyDigest:
            "44e6d5df0e195097d4a782ae2b4a0fd6e9eb6e2e74d570910ab075e804af1cc9",
        },
      ],
      grants: [
        { object: ["database","<current>"],
          grantee: "meal_agent_backup_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          grantee: "meal_agent_migration_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          grantee: "meal_agent_runtime_login",
          privileges: ["CONNECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          grantee: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","auth_identities"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","auth_identities"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","household_invites"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","household_invites"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","households"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","households"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","idempotency_records"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","idempotency_records"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","inventory_events"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","inventory_events"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","inventory_lots"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","inventory_lots"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","memberships"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","memberships"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","person_profile_link_requests"],
          grantee: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","public","person_profile_link_requests"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","person_profiles"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","person_profiles"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","sessions"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","sessions"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","users"],
          grantee: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","users"],
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["routine","meal_agent_private","add_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"],["pg_catalog","jsonb"],["pg_catalog","bool"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_household_id",[]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_user_id",[]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","confirm_person_profile_link",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","create_person_profile_link_request",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","int4"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_active_owner",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","materialize_person_profile_link_requests",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","owns_profile",[["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","redeem_household_invite",[["pg_catalog","bpchar"],["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","remove_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","stage08_constraints_are_safe",[["pg_catalog","jsonb"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","transition_membership_status",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","transition_person_profile_status",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","text"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","update_person_profile_fields",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","text"],["pg_catalog","bool"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","numeric"],["pg_catalog","bool"],["pg_catalog","text"]]],
          grantee: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["schema","drizzle"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","drizzle"],
          grantee: "meal_agent_backup",
          privileges: ["USAGE"] },
        { object: ["schema","meal_agent_private"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          grantee: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          grantee: "meal_agent_backup",
          privileges: ["USAGE"] },
      ],
      defaults: [
        { objtype: "S", scope: "public",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { objtype: "T", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "f", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "r", scope: "drizzle",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { objtype: "r", scope: "public",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
      ],
      defaultEffective: [
        { objtype: "L", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE"] },
        { objtype: "S", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "S", scope: "public",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { objtype: "S", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["SELECT","UPDATE","USAGE"] },
        { objtype: "T", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "T", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["USAGE"] },
        { objtype: "f", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "f", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["EXECUTE"] },
        { objtype: "n", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["CREATE","USAGE"] },
        { objtype: "r", scope: "-",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "drizzle",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { objtype: "r", scope: "drizzle",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "meal_agent_private",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
        { objtype: "r", scope: "public",
          grantee: "meal_agent_backup",
          privileges: ["SELECT"] },
        { objtype: "r", scope: "public",
          grantee: "meal_agent_migrator",
          privileges: ["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"] },
      ],
      effective: [
        { object: ["database","<current>"],
          role: "meal_agent_backup_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          role: "meal_agent_migration_login",
          privileges: ["CONNECT"] },
        { object: ["database","<current>"],
          role: "meal_agent_runtime_login",
          privileges: ["CONNECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          role: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","drizzle","__meal_agent_migrations"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","auth_identities"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","auth_identities"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","household_invites"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","household_invites"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","households"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","households"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","idempotency_records"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","idempotency_records"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","inventory_events"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","inventory_events"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","inventory_lots"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","inventory_lots"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","memberships"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","memberships"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","person_profile_link_requests"],
          role: "meal_agent_app",
          privileges: ["SELECT"] },
        { object: ["relation","public","person_profile_link_requests"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","person_profiles"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT"] },
        { object: ["relation","public","person_profiles"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","sessions"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","sessions"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["relation","public","users"],
          role: "meal_agent_app",
          privileges: ["INSERT","SELECT","UPDATE"] },
        { object: ["relation","public","users"],
          role: "meal_agent_backup",
          privileges: ["SELECT"] },
        { object: ["routine","meal_agent_private","add_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"],["pg_catalog","jsonb"],["pg_catalog","bool"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_household_id",[]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","app_user_id",[]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","confirm_person_profile_link",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","create_person_profile_link_request",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","int4"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","has_active_membership",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_active_owner",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","is_household_creator",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","materialize_person_profile_link_requests",[["pg_catalog","uuid"],["pg_catalog","uuid"],["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","owns_profile",[["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","redeem_household_invite",[["pg_catalog","bpchar"],["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","remove_person_profile_constraint",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","uuid"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","stage08_constraints_are_safe",[["pg_catalog","jsonb"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","transition_membership_status",[["pg_catalog","uuid"],["pg_catalog","int4"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","transition_person_profile_status",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","text"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["routine","meal_agent_private","update_person_profile_fields",[["pg_catalog","uuid"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","text"],["pg_catalog","bool"],["pg_catalog","int4"],["pg_catalog","bool"],["pg_catalog","numeric"],["pg_catalog","bool"],["pg_catalog","text"]]],
          role: "meal_agent_app",
          privileges: ["EXECUTE"] },
        { object: ["schema","drizzle"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","drizzle"],
          role: "meal_agent_backup",
          privileges: ["USAGE"] },
        { object: ["schema","meal_agent_private"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          role: "meal_agent_app",
          privileges: ["USAGE"] },
        { object: ["schema","public"],
          role: "meal_agent_backup",
          privileges: ["USAGE"] },
      ],
    },
  ],
};

export const authorizationManifest: AuthorizationManifest =
  deepFreeze(manifestData);

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

/**
 * 渲染守卫：manifest 里的每一个**标量**最终都会被拼进高权限 SQL（收敛块会
 * `SET LOCAL ROLE`、`GRANT`、`REVOKE`、`ALTER DEFAULT PRIVILEGES`），因此在这里
 * 就用**全体 renderer 共用**的 {@link assertRenderableValue} 拒绝任何 SQL token。
 */
const assertRenderable = (field: string, value: string): string =>
  assertRenderableValue(field, value);

/**
 * 规范化行的 identity 与 detail 是**聚合出来的 JSON**，本来就含双引号，因此这一层
 * 只做结构字符检查；单个标识符（角色名 / schema 名 / 权限名 / objtype / scope /
 * identity 的每一段）在更早的位置已经过了完整的 SQL token 守卫。
 */
const structurallyForbidden = /[\\\r\n\u0000]/u;

const assertComposable = (field: string, value: string): string => {
  if (structurallyForbidden.test(value)) {
    throw new AuthorizationManifestError(
      `${field} contains a character that cannot be rendered deterministically`,
    );
  }
  return value;
};

/** identity 的每一段都要过同一道守卫，嵌套的参数类型也不例外。 */
const assertRenderableIdentity = (
  field: string,
  parts: readonly ProjectionIdentityPart[],
): string => {
  for (const part of parts) {
    if (typeof part === "string") {
      assertRenderableValue(field, part);
    } else {
      assertRenderableIdentity(field, part);
    }
  }
  return encodeProjectionIdentity(parts);
};

const privilegeList = (
  privileges: readonly string[],
  allowed: readonly string[],
  context: string,
): string => {
  if (privileges.length === 0) {
    throw new AuthorizationManifestError(
      "an entry must not declare an empty privilege set; omit the entry instead",
    );
  }
  const seen = new Set<string>();
  for (const privilege of privileges) {
    assertRenderableValue(`${context} privilege`, privilege);
    if (privilege.endsWith("*")) {
      throw new AuthorizationManifestError(
        `grant options are never allowed: ${privilege}`,
      );
    }
    if (!allowed.includes(privilege)) {
      throw new AuthorizationManifestError(
        `privilege ${JSON.stringify(privilege)} is not valid for ${context}; ` +
          `expected one of ${allowed.join(", ")}`,
      );
    }
    if (seen.has(privilege)) {
      throw new AuthorizationManifestError(
        `duplicate privilege ${JSON.stringify(privilege)} for ${context}`,
      );
    }
    seen.add(privilege);
  }
  return [...privileges].sort(byCodeUnit).join(",");
};

/**
 * `defaults` 与 `defaultEffective` 的槽位键。objtype 必须是六种受监管取值之一，
 * scope 必须是 managed schema 或 global——否则渲染出的 `ALTER DEFAULT
 * PRIVILEGES` 会打到一个本基线根本不管的作用域上。
 */
const assertDefaultSlot = (
  manifest: AuthorizationManifest,
  objtype: string,
  scope: string,
): readonly string[] => {
  assertRenderableValue("default privilege objtype", objtype);
  assertRenderableValue("default privilege scope", scope);
  const rule = defaultObjtypeRules[objtype];
  if (rule === undefined) {
    throw new AuthorizationManifestError(
      `unknown default privilege objtype ${JSON.stringify(objtype)}`,
    );
  }
  if (scope === globalDefaultScope) {
    return rule.privileges;
  }
  if (!manifest.managedSchemas.includes(scope)) {
    throw new AuthorizationManifestError(
      `default privilege scope ${JSON.stringify(scope)} is neither global ` +
        "nor a managed schema",
    );
  }
  if (!rule.schemaScoped) {
    throw new AuthorizationManifestError(
      `default privilege objtype ${JSON.stringify(objtype)} has no schema ` +
        `scope; ${JSON.stringify(scope)} is not a legal slot`,
    );
  }
  return rule.privileges;
};

/** 固定允许授权只可能落在四类对象上；其余类别由策略判定，不得登记允许项。 */
const assertGrantableObject = (
  object: readonly ProjectionIdentityPart[],
): readonly string[] => {
  const [objectClass] = object;
  if (
    typeof objectClass !== "string" ||
    !(grantableObjectClasses as readonly string[]).includes(objectClass)
  ) {
    throw new AuthorizationManifestError(
      `object ${encodeProjectionIdentity(object)} is not a class the manifest ` +
        "may register a fixed grant for; type, column, language and large " +
        "object are decided by policy",
    );
  }
  const privileges = objectClassPrivileges[objectClass];
  if (privileges === undefined) {
    throw new AuthorizationManifestError(
      `no privilege allowlist for object class ${objectClass}`,
    );
  }
  return privileges;
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
      state: assertComposable("state", state),
      kind: assertComposable("kind", kind),
      identity: assertComposable("identity", identity),
      detail: assertComposable("detail", detail),
    });
  };

  const { owner, grantees } = manifest.principals;
  if (grantees.includes(owner)) {
    throw new AuthorizationManifestError(
      "the canonical owner must not be registered as a fixed grantee; its " +
        "privileges follow from ownership and are matched by policy",
    );
  }

  for (const state of manifest.states) {
    const key = authorizationStateKey(state.ledger, state.phase);
    for (const entry of state.routines) {
      const [objectClass, schema] = entry.object;
      if (objectClass !== "routine" || typeof schema !== "string") {
        throw new AuthorizationManifestError(
          `routine identity ${encodeProjectionIdentity(entry.object)} is not ` +
            "a routine key",
        );
      }
      if (!manifest.managedSchemas.includes(schema)) {
        throw new AuthorizationManifestError(
          `routine ${encodeProjectionIdentity(entry.object)} is outside the ` +
            "managed schemas",
        );
      }
      for (const setting of entry.config) {
        assertRenderableValue("routine proconfig", setting);
      }
      push(
        key,
        "routine",
        assertRenderableIdentity("routine identity", entry.object),
        `owner=${assertRenderable("routine owner", entry.owner)} ` +
          `secdef=${entry.securityDefiner ? "t" : "f"} ` +
          // proconfig 用结构化 JSON 数组，不用 `|` 拼接：设置值本身可以包含
          // 分隔符，拼接串在那一刻就会变得不可反解也不可比较。
          `config=${encodeProjectionIdentity(entry.config)} ` +
          `body=${assertRenderable("routine body digest", entry.bodyDigest)}`,
      );
    }
    for (const entry of state.grants) {
      if (!grantees.includes(entry.grantee)) {
        throw new AuthorizationManifestError(
          `grant for grantee ${entry.grantee}, which is not a project ` +
            "principal; external roles are never allowed a fixed grant",
        );
      }
      const grantPrivileges = assertGrantableObject(entry.object);
      assertRenderableIdentity("grant object", entry.object);
      push(
        key,
        "grant",
        encodeProjectionIdentity([entry.object, entry.grantee]),
        `privs=${privilegeList(
          entry.privileges,
          grantPrivileges,
          `grant on ${String(entry.object[0])}`,
        )}`,
      );
    }
    for (const entry of state.defaults) {
      const allowed = assertDefaultSlot(manifest, entry.objtype, entry.scope);
      push(
        key,
        "default",
        encodeProjectionIdentity([entry.objtype, entry.scope, entry.grantee]),
        `privs=${privilegeList(
          entry.privileges,
          allowed,
          `default privilege ${entry.objtype}@${entry.scope}`,
        )}`,
      );
    }
    for (const entry of state.defaultEffective) {
      const allowed = assertDefaultSlot(manifest, entry.objtype, entry.scope);
      push(
        key,
        "default-effective",
        encodeProjectionIdentity([entry.objtype, entry.scope, entry.grantee]),
        `privs=${privilegeList(
          entry.privileges,
          allowed,
          `default privilege ${entry.objtype}@${entry.scope}`,
        )}`,
      );
    }
    for (const entry of state.effective) {
      if (!grantees.includes(entry.role)) {
        throw new AuthorizationManifestError(
          `effective expectation for role ${entry.role}, which is not a ` +
            "project principal; external roles are matched by policy",
        );
      }
      const effectivePrivileges = assertGrantableObject(entry.object);
      assertRenderableIdentity("effective object", entry.object);
      push(
        key,
        "effective",
        encodeProjectionIdentity([entry.object, entry.role]),
        `privs=${privilegeList(
          entry.privileges,
          effectivePrivileges,
          `effective on ${String(entry.object[0])}`,
        )}`,
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

/**
 * manifest 的**顶层**字段同样进 digest。只对 states 取摘要是不够的：改掉
 * `principals.owner`、`managedSchemas` 或 `deniedRoutines` 会实质改变策略与
 * 生成结果，却不会动任何一条 state 行——digest 必须跟着变，否则 generated
 * adapter 的 canonical digest 会静默说谎。
 */
const canonicalManifestHeader = (
  manifest: AuthorizationManifest,
): readonly string[] => {
  const { owner, grantees, logins, memberships } = manifest.principals;
  return [
    `<manifest>|version|[]|${String(manifest.version)}`,
    `<manifest>|owner|[]|${assertRenderable("principals.owner", owner)}`,
    `<manifest>|grantees|[]|${encodeProjectionIdentity(
      [...grantees].map((value) => assertRenderable("grantee", value)).sort(byCodeUnit),
    )}`,
    `<manifest>|logins|[]|${encodeProjectionIdentity(
      [...logins].map((value) => assertRenderable("login", value)).sort(byCodeUnit),
    )}`,
    `<manifest>|memberships|[]|${encodeProjectionIdentity(
      [...memberships]
        .map((entry) => [
          assertRenderable("membership member", entry.member),
          assertRenderable("membership granted", entry.granted),
        ])
        .sort((left, right) => byCodeUnit(left.join(","), right.join(","))),
    )}`,
    `<manifest>|managedSchemas|[]|${encodeProjectionIdentity(
      [...manifest.managedSchemas]
        .map((value) => assertRenderable("managed schema", value))
        .sort(byCodeUnit),
    )}`,
    `<manifest>|deniedRoutines|[]|${encodeProjectionIdentity(
      [...manifest.deniedRoutines]
        .map((value) => assertRenderable("denied routine", value))
        .sort(byCodeUnit),
    )}`,
  ];
};

export const canonicalAuthorizationText = (
  manifest: AuthorizationManifest = authorizationManifest,
): string =>
  `${[
    ...canonicalManifestHeader(manifest),
    ...canonicalAuthorizationRows(manifest).map(
      (row) => `${row.state}|${row.kind}|${row.identity}|${row.detail}`,
    ),
  ].join("\n")}\n`;

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

/** 六个项目角色：owner + 五个受精确验证的主体（不含 `PUBLIC`）。 */
export const projectRoles = (
  manifest: AuthorizationManifest = authorizationManifest,
): readonly string[] =>
  [
    manifest.principals.owner,
    ...manifest.principals.grantees.filter((grantee) => grantee !== "PUBLIC"),
  ].sort(byCodeUnit);
