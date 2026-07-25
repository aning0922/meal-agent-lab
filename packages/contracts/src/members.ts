import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { ruleSuperRefine } from "./contract-rule-schema.js";
import {
  dietaryConstraintIdSchema,
  foodConceptIdSchema,
  householdIdSchema,
  householdInviteIdSchema,
  membershipIdSchema,
  personProfileIdSchema,
  personProfileLinkRequestIdSchema,
  userIdSchema,
  utcDateTimeSchema,
  versionSchema,
} from "./primitives.js";
import {
  householdSchema,
  membershipSchema,
  personProfileSchema,
  safeOwnerProfileResponseSchema,
} from "./identity.js";

// ---------------------------------------------------------------------------
// 家庭邀请（Household invites）
//
// 明文邀请码只在创建响应出现一次；持久化实体既不含明文也不含 digest，
// 避免任何读取路径泄露可用于加入的凭证。
// ---------------------------------------------------------------------------

export const householdInviteStatusSchema = z.enum([
  "active",
  "revoked",
  "exhausted",
  "expired",
]);
export type HouseholdInviteStatus = z.infer<
  typeof householdInviteStatusSchema
>;

/** 高熵邀请码：≥128 bit 随机串，编码为 URL-safe base64（22–128 字符）。 */
export const householdInviteCodeSchema = z
  .string()
  .min(22)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"HouseholdInviteCode">();
export type HouseholdInviteCode = z.infer<
  typeof householdInviteCodeSchema
>;

export const householdInviteSchema = ruleSuperRefine(
  z.strictObject({
    id: householdInviteIdSchema,
    householdId: householdIdSchema,
    createdByUserId: userIdSchema,
    status: householdInviteStatusSchema,
    expiresAt: utcDateTimeSchema,
    maxUses: z.int().min(1).max(10),
    usedCount: z.int().nonnegative(),
    createdAt: utcDateTimeSchema,
    version: versionSchema,
  }),
  "members.invite.entity-consistency.v1",
  "householdInviteSchema",
  (invite, context) => {
    if (invite.usedCount > invite.maxUses) {
      context.addIssue({
        code: "custom",
        path: ["usedCount"],
        message: "invite used count cannot exceed its maximum uses",
      });
    }
    if (Date.parse(invite.expiresAt) <= Date.parse(invite.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "invite expiry must be after creation",
      });
    }
  },
);
export type HouseholdInvite = z.infer<typeof householdInviteSchema>;

export const createHouseholdInviteRequestSchema = z.strictObject({
  maxUses: z.int().min(1).max(10).default(1),
  /** 有效期（小时）；上限 168 小时 = 7 天，与数据库约束一致。 */
  expiresInHours: z.int().min(1).max(168).default(168),
});
export type CreateHouseholdInviteRequest = z.infer<
  typeof createHouseholdInviteRequestSchema
>;

export const createHouseholdInviteResultSchema = ruleSuperRefine(
  z.strictObject({
    invite: householdInviteSchema,
    /**
     * 明文邀请码。仅首次创建响应携带一次，且**永不落库**（服务端在写入
     * 幂等记录前剔除）。因此幂等重放（网络重试命中同一 key）返回的响应
     * 不含该字段——这是"明文仅一次"的安全语义，故本字段为 optional。
     * 客户端若在重放响应中拿不到码，应引导用户在邀请列表查看或重新生成。
     */
    inviteCode: householdInviteCodeSchema.optional(),
  }),
  "members.invite.create-result.v1",
  "createHouseholdInviteResultSchema",
  (result, context) => {
    if (result.invite.status !== "active") {
      context.addIssue({
        code: "custom",
        path: ["invite", "status"],
        message: "a freshly created invite must be active",
      });
    }
    if (result.invite.usedCount !== 0) {
      context.addIssue({
        code: "custom",
        path: ["invite", "usedCount"],
        message: "a freshly created invite must have zero uses",
      });
    }
  },
);
export type CreateHouseholdInviteResult = z.infer<
  typeof createHouseholdInviteResultSchema
>;

export const revokeHouseholdInviteResultSchema = ruleSuperRefine(
  z.strictObject({
    invite: householdInviteSchema,
  }),
  "members.invite.revoke-result.v1",
  "revokeHouseholdInviteResultSchema",
  (result, context) => {
    if (result.invite.status !== "revoked") {
      context.addIssue({
        code: "custom",
        path: ["invite", "status"],
        message: "a revoked invite must report revoked status",
      });
    }
  },
);
export type RevokeHouseholdInviteResult = z.infer<
  typeof revokeHouseholdInviteResultSchema
>;

// ---------------------------------------------------------------------------
// 加入家庭（Join by invite code）
// ---------------------------------------------------------------------------

export const joinHouseholdRequestSchema = z.strictObject({
  inviteCode: householdInviteCodeSchema,
});
export type JoinHouseholdRequest = z.infer<
  typeof joinHouseholdRequestSchema
>;

export const joinHouseholdResultSchema = ruleSuperRefine(
  z.strictObject({
    membership: membershipSchema,
    household: householdSchema,
  }),
  "members.join.result-consistency.v1",
  "joinHouseholdResultSchema",
  (result, context) => {
    if (result.membership.householdId !== result.household.id) {
      context.addIssue({
        code: "custom",
        path: ["membership", "householdId"],
        message: "joined membership and household must share a household id",
      });
    }
    if (result.membership.status !== "active") {
      context.addIssue({
        code: "custom",
        path: ["membership", "status"],
        message: "a joined membership must be active",
      });
    }
    if (result.membership.role !== "member") {
      context.addIssue({
        code: "custom",
        path: ["membership", "role"],
        message: "joining by invite yields a member role, never owner",
      });
    }
  },
);
export type JoinHouseholdResult = z.infer<
  typeof joinHouseholdResultSchema
>;

// ---------------------------------------------------------------------------
// 成员移除 / 退出
// ---------------------------------------------------------------------------

export const removeMembershipResultSchema = ruleSuperRefine(
  z.strictObject({
    membership: membershipSchema,
  }),
  "members.remove.result-consistency.v1",
  "removeMembershipResultSchema",
  (result, context) => {
    if (result.membership.status === "active") {
      context.addIssue({
        code: "custom",
        path: ["membership", "status"],
        message: "a removed or departed membership cannot remain active",
      });
    }
  },
);
export type RemoveMembershipResult = z.infer<
  typeof removeMembershipResultSchema
>;

// ---------------------------------------------------------------------------
// 成员列表与字段级 redaction
//
// 两种响应形状固定在 schema 层：owner 视图每条成员携带完整档案（可含
// subject_and_owner 私密约束）；member 视图把"本人"档案单独完整返回，
// "其他成员"档案走 household 视图（结构上不可能携带私密约束，复用
// safeOwnerProfileResponseSchema 的 allowlist）。
// ---------------------------------------------------------------------------

/** 特权条目：请求者有权看到完整档案（本人，或请求者为 owner）。 */
export const householdMemberSelfViewSchema = z.strictObject({
  membership: membershipSchema,
  profile: personProfileSchema.nullable(),
});
export type HouseholdMemberSelfView = z.infer<
  typeof householdMemberSelfViewSchema
>;

/**
 * 脱敏条目：档案投影只允许 household 可见约束，subject_and_owner
 * 约束在结构上无法出现（不是运行时删字段，是类型层排除）。
 */
export const householdMemberRedactedViewSchema = z.strictObject({
  membership: membershipSchema,
  profile: safeOwnerProfileResponseSchema.nullable(),
});
export type HouseholdMemberRedactedView = z.infer<
  typeof householdMemberRedactedViewSchema
>;

export const listHouseholdMembersResultSchema = z.discriminatedUnion(
  "viewerRole",
  [
    z.strictObject({
      viewerRole: z.literal("owner"),
      members: z.array(householdMemberSelfViewSchema),
    }),
    z.strictObject({
      viewerRole: z.literal("member"),
      /** 请求成员本人条目，完整返回（本人可见自己的私密约束）。 */
      self: householdMemberSelfViewSchema,
      /** 其他成员条目，一律脱敏。 */
      others: z.array(householdMemberRedactedViewSchema),
    }),
  ],
);
export type ListHouseholdMembersResult = z.infer<
  typeof listHouseholdMembersResultSchema
>;

// ---------------------------------------------------------------------------
// 用餐档案 CRUD（Person profile）
// ---------------------------------------------------------------------------

const cookingSkillSchema = z.enum([
  "none",
  "beginner",
  "intermediate",
  "advanced",
]);

export const createPersonProfileRequestSchema = z.strictObject({
  /** 关联到某登录成员的 membership；缺省表示仅用餐档案（非登录）。 */
  linkedMembershipId: membershipIdSchema.optional(),
  displayName: z.string().min(1).max(80),
  defaultParticipation: z.boolean().nullable(),
  defaultPortionScale: z.number().finite().min(0.25).max(4).nullable(),
  cookingSkill: cookingSkillSchema.nullable(),
});
export type CreatePersonProfileRequest = z.infer<
  typeof createPersonProfileRequestSchema
>;

export const personProfileResultSchema = z.strictObject({
  profile: personProfileSchema,
});
export type PersonProfileResult = z.infer<
  typeof personProfileResultSchema
>;

export const personProfileMutationOperationSchema = z.enum([
  "create",
  "update",
  "archive",
  "restore",
  "add_constraint",
  "remove_constraint",
  "link",
]);
export type PersonProfileMutationOperation = z.infer<
  typeof personProfileMutationOperationSchema
>;

/**
 * 敏感资源写操作只返回稳定 receipt。完整 PersonProfile 必须通过授权 GET
 * 读取，避免 subject_and_owner 约束进入通用幂等响应缓存。
 */
export const personProfileMutationReceiptSchema = z.strictObject({
  householdId: householdIdSchema,
  profileId: personProfileIdSchema,
  operation: personProfileMutationOperationSchema,
  status: z.enum(["active", "archived"]),
  resultingVersion: versionSchema,
  constraintId: dietaryConstraintIdSchema.optional(),
});
export type PersonProfileMutationReceipt = z.infer<
  typeof personProfileMutationReceiptSchema
>;

export const personProfileStatusFilterSchema = z
  .enum(["active", "archived", "all"])
  .default("active");
export type PersonProfileStatusFilter = z.infer<
  typeof personProfileStatusFilterSchema
>;

export const personProfileQuerySchema = z.strictObject({
  status: personProfileStatusFilterSchema,
});
export type PersonProfileQuery = z.infer<typeof personProfileQuerySchema>;

export const listPersonProfilesResultSchema = z.discriminatedUnion(
  "viewerRole",
  [
    z.strictObject({
      viewerRole: z.literal("owner"),
      profiles: z.array(personProfileSchema),
    }),
    z.strictObject({
      viewerRole: z.literal("member"),
      self: personProfileSchema.nullable(),
      others: z.array(safeOwnerProfileResponseSchema),
    }),
  ],
);
export type ListPersonProfilesResult = z.infer<
  typeof listPersonProfilesResultSchema
>;

export const getPersonProfileResultSchema = z.discriminatedUnion(
  "access",
  [
    z.strictObject({
      access: z.literal("owner_or_self"),
      profile: personProfileSchema,
    }),
    z.strictObject({
      access: z.literal("household"),
      profile: safeOwnerProfileResponseSchema,
    }),
  ],
);
export type GetPersonProfileResult = z.infer<
  typeof getPersonProfileResultSchema
>;

// ---------------------------------------------------------------------------
// dining-only profile 与登录成员的显式双确认关联。
// owner 创建请求只表示 owner 确认；target membership 对应用户必须再确认。
// ---------------------------------------------------------------------------

export const personProfileLinkRequestStatusSchema = z.enum([
  "pending",
  "accepted",
  "cancelled",
  "expired",
]);

/**
 * 关联确认只披露完成知情确认所需的稳定摘要。私密约束只给出数量，不返回
 * label、notes、结构化 ID 或其他内容。
 */
export const personProfileLinkDisclosureSchema = z.strictObject({
  disclosureVersion: z.literal(1),
  profileVersion: versionSchema,
  profileDisplayName: z.string().min(1).max(80),
  householdVisibleHardConstraintCount: z.int().min(0),
  householdVisibleSoftConstraintCount: z.int().min(0),
  privateConstraintCount: z.int().min(0),
  subjectWillGainProfileAccess: z.literal(true),
  membershipExitArchivesProfile: z.literal(true),
  rejoinRestoresAutomatically: z.literal(false),
  privateConstraintContentsRemainPrivate: z.literal(true),
});
export type PersonProfileLinkDisclosure = z.infer<
  typeof personProfileLinkDisclosureSchema
>;

export const personProfileLinkRequestSchema = z.strictObject({
  id: personProfileLinkRequestIdSchema,
  householdId: householdIdSchema,
  profileId: personProfileIdSchema,
  targetMembershipId: membershipIdSchema,
  initiatedByUserId: userIdSchema,
  status: personProfileLinkRequestStatusSchema,
  createdAt: utcDateTimeSchema,
  expiresAt: utcDateTimeSchema,
  confirmedAt: utcDateTimeSchema.optional(),
  disclosure: personProfileLinkDisclosureSchema,
  version: versionSchema,
});
export type PersonProfileLinkRequest = z.infer<
  typeof personProfileLinkRequestSchema
>;

export const createPersonProfileLinkRequestSchema = z.strictObject({
  targetMembershipId: membershipIdSchema,
  expiresInHours: z.int().min(1).max(168).default(168),
  ownerConfirmation: z.strictObject({
    acknowledged: z.literal(true),
  }),
});
export type CreatePersonProfileLinkRequest = z.infer<
  typeof createPersonProfileLinkRequestSchema
>;

export const confirmPersonProfileLinkRequestSchema = z.strictObject({
  expectedVersion: versionSchema,
  subjectConfirmation: z.strictObject({
    acknowledged: z.literal(true),
  }),
});
export type ConfirmPersonProfileLinkRequest = z.infer<
  typeof confirmPersonProfileLinkRequestSchema
>;

export const personProfileLinkRequestResultSchema = z.strictObject({
  request: personProfileLinkRequestSchema,
});
export type PersonProfileLinkRequestResult = z.infer<
  typeof personProfileLinkRequestResultSchema
>;

export const personProfileLinkRequestListResultSchema = z.strictObject({
  requests: z.array(personProfileLinkRequestSchema),
});
export type PersonProfileLinkRequestListResult = z.infer<
  typeof personProfileLinkRequestListResultSchema
>;

export const confirmPersonProfileLinkResultSchema = z.strictObject({
  request: personProfileLinkRequestSchema,
  receipt: personProfileMutationReceiptSchema,
});
export type ConfirmPersonProfileLinkResult = z.infer<
  typeof confirmPersonProfileLinkResultSchema
>;

/** PATCH 子命令：更新可编辑字段（不含约束，约束走独立增删路由）。 */
export const updatePersonProfileRequestSchema = ruleSuperRefine(
  z.strictObject({
    operation: z.literal("update"),
    expectedVersion: versionSchema,
    displayName: z.string().min(1).max(80).optional(),
    defaultParticipation: z.boolean().nullable().optional(),
    defaultPortionScale: z
      .number()
      .finite()
      .min(0.25)
      .max(4)
      .nullable()
      .optional(),
    cookingSkill: cookingSkillSchema.nullable().optional(),
  }),
  "profiles.update.non-empty.v1",
  "updatePersonProfileRequestSchema",
  (request, context) => {
    if (
      request.displayName === undefined &&
      request.defaultParticipation === undefined &&
      request.defaultPortionScale === undefined &&
      request.cookingSkill === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: "an update must change at least one field",
      });
    }
  },
);
export type UpdatePersonProfileRequest = z.infer<
  typeof updatePersonProfileRequestSchema
>;

/** PATCH 子命令：归档（"移除"用餐档案），乐观并发。 */
export const archivePersonProfileRequestSchema = z.strictObject({
  operation: z.literal("archive"),
  expectedVersion: versionSchema,
});
export type ArchivePersonProfileRequest = z.infer<
  typeof archivePersonProfileRequestSchema
>;

export const restorePersonProfileRequestSchema = z.strictObject({
  operation: z.literal("restore"),
  expectedVersion: versionSchema,
});
export type RestorePersonProfileRequest = z.infer<
  typeof restorePersonProfileRequestSchema
>;

/** PATCH `/person-profiles/:profileId` 请求体：更新、归档或恢复。 */
export const patchPersonProfileRequestSchema = z.discriminatedUnion(
  "operation",
  [
    updatePersonProfileRequestSchema,
    archivePersonProfileRequestSchema,
    restorePersonProfileRequestSchema,
  ],
);
export type PatchPersonProfileRequest = z.infer<
  typeof patchPersonProfileRequestSchema
>;

// ---------------------------------------------------------------------------
// 饮食约束增删（硬约束双确认）
//
// 请求体不含 id / confirmedAt / confirmedByUserId：这些由服务端在写入时
// 生成，操作者身份作为 confirmedByUserId，避免客户端伪造确认来源。
// ---------------------------------------------------------------------------

const constraintVisibilitySchema = z.enum([
  "household",
  "subject_and_owner",
]);

type HardConstraintFingerprintFields = {
  readonly kind:
    | "allergy"
    | "religious"
    | "ethical"
    | "explicit_avoid"
    | "food_safety_exclusion";
  readonly enforcement: "hard";
  readonly label: string;
  readonly foodConceptIds: readonly string[];
  readonly allergenCodes: readonly string[];
  readonly notes?: string | undefined;
  readonly visibility: "household" | "subject_and_owner";
};

const sortForCanonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortForCanonicalJson(item)]),
    );
  }
  return value;
};

/**
 * 硬约束确认指纹覆盖全部业务字段（包括 visibility）。调用方必须先完成
 * schema 默认值展开再计算；服务端会对同一 payload 重算，字段变化会让旧
 * 确认立即失效。
 */
export const hardConstraintConfirmationFingerprint = (
  constraint: HardConstraintFingerprintFields,
): string =>
  bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify(sortForCanonicalJson(constraint)),
      ),
    ),
  );

const hardConstraintInputSchema = ruleSuperRefine(
  z.strictObject({
    kind: z.enum([
      "allergy",
      "religious",
      "ethical",
      "explicit_avoid",
      "food_safety_exclusion",
    ]),
    enforcement: z.literal("hard"),
    label: z.string().min(1).max(120),
    foodConceptIds: z.array(foodConceptIdSchema).default([]),
    allergenCodes: z.array(z.string().min(1).max(64)).default([]),
    notes: z.string().max(500).optional(),
    visibility: constraintVisibilitySchema,
    /** 硬约束必须携带显式确认；acknowledged 只接受字面 true。 */
    confirmation: z.strictObject({
      acknowledged: z.literal(true),
      fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  }),
  "profiles.constraint.confirmation-fingerprint.v1",
  "dietaryConstraintInputSchema",
  (constraint, context) => {
    const { confirmation, ...fingerprintFields } = constraint;
    if (
      confirmation.fingerprint !==
      hardConstraintConfirmationFingerprint(fingerprintFields)
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmation", "fingerprint"],
        message:
          "hard constraint confirmation no longer matches all submitted fields",
      });
    }
  },
);

const softConstraintInputSchema = z.strictObject({
  kind: z.literal("preference"),
  enforcement: z.literal("soft"),
  label: z.string().min(1).max(120),
  preference: z.enum(["prefer", "dislike"]),
  foodConceptIds: z.array(foodConceptIdSchema).default([]),
  notes: z.string().max(500).optional(),
  visibility: constraintVisibilitySchema,
});

export const dietaryConstraintInputSchema = z.discriminatedUnion(
  "enforcement",
  [hardConstraintInputSchema, softConstraintInputSchema],
);
export type DietaryConstraintInput = z.infer<
  typeof dietaryConstraintInputSchema
>;

export const addDietaryConstraintRequestSchema = z.strictObject({
  expectedVersion: versionSchema,
  constraint: dietaryConstraintInputSchema,
});
export type AddDietaryConstraintRequest = z.infer<
  typeof addDietaryConstraintRequestSchema
>;

/** 不提供原地编辑：改 = 删 + 加，硬约束的双确认因此无法被绕过。 */
export const removeDietaryConstraintRequestSchema = z.strictObject({
  constraintId: dietaryConstraintIdSchema,
  expectedVersion: versionSchema,
});
export type RemoveDietaryConstraintRequest = z.infer<
  typeof removeDietaryConstraintRequestSchema
>;
