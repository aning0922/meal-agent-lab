import { z } from "zod";

import {
  dietaryConstraintIdSchema,
  foodConceptIdSchema,
  householdIdSchema,
  householdInviteIdSchema,
  membershipIdSchema,
  personProfileIdSchema,
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

export const householdInviteSchema = z
  .strictObject({
    id: householdInviteIdSchema,
    householdId: householdIdSchema,
    createdByUserId: userIdSchema,
    status: householdInviteStatusSchema,
    expiresAt: utcDateTimeSchema,
    maxUses: z.int().min(1).max(10),
    usedCount: z.int().nonnegative(),
    createdAt: utcDateTimeSchema,
    version: versionSchema,
  })
  .superRefine((invite, context) => {
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
  })
  .meta({
    "x-zod-refinements": [
      "invite used count cannot exceed its maximum uses",
      "invite expiry must be after creation",
    ],
  });
export type HouseholdInvite = z.infer<typeof householdInviteSchema>;

export const createHouseholdInviteRequestSchema = z.strictObject({
  maxUses: z.int().min(1).max(10).default(1),
  /** 有效期（小时）；上限 168 小时 = 7 天，与数据库约束一致。 */
  expiresInHours: z.int().min(1).max(168).default(168),
});
export type CreateHouseholdInviteRequest = z.infer<
  typeof createHouseholdInviteRequestSchema
>;

export const createHouseholdInviteResultSchema = z
  .strictObject({
    invite: householdInviteSchema,
    /**
     * 明文邀请码。仅首次创建响应携带一次，且**永不落库**（服务端在写入
     * 幂等记录前剔除）。因此幂等重放（网络重试命中同一 key）返回的响应
     * 不含该字段——这是"明文仅一次"的安全语义，故本字段为 optional。
     * 客户端若在重放响应中拿不到码，应引导用户在邀请列表查看或重新生成。
     */
    inviteCode: householdInviteCodeSchema.optional(),
  })
  .superRefine((result, context) => {
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
  })
  .meta({
    "x-zod-refinements": [
      "a freshly created invite is active with zero uses",
    ],
  });
export type CreateHouseholdInviteResult = z.infer<
  typeof createHouseholdInviteResultSchema
>;

export const revokeHouseholdInviteResultSchema = z
  .strictObject({
    invite: householdInviteSchema,
  })
  .superRefine((result, context) => {
    if (result.invite.status !== "revoked") {
      context.addIssue({
        code: "custom",
        path: ["invite", "status"],
        message: "a revoked invite must report revoked status",
      });
    }
  })
  .meta({
    "x-zod-refinements": ["a revoked invite reports revoked status"],
  });
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

export const joinHouseholdResultSchema = z
  .strictObject({
    membership: membershipSchema,
    household: householdSchema,
  })
  .superRefine((result, context) => {
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
  })
  .meta({
    "x-zod-refinements": [
      "joined membership is an active member of the returned household",
    ],
  });
export type JoinHouseholdResult = z.infer<
  typeof joinHouseholdResultSchema
>;

// ---------------------------------------------------------------------------
// 成员移除 / 退出
// ---------------------------------------------------------------------------

export const removeMembershipResultSchema = z
  .strictObject({
    membership: membershipSchema,
  })
  .superRefine((result, context) => {
    if (result.membership.status === "active") {
      context.addIssue({
        code: "custom",
        path: ["membership", "status"],
        message: "a removed or departed membership cannot remain active",
      });
    }
  })
  .meta({
    "x-zod-refinements": [
      "removal yields a left or removed membership, never active",
    ],
  });
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
  defaultParticipation: z.boolean(),
  defaultPortionScale: z.number().finite().min(0.25).max(4),
  cookingSkill: cookingSkillSchema,
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

/** PATCH 子命令：更新可编辑字段（不含约束，约束走独立增删路由）。 */
export const updatePersonProfileRequestSchema = z
  .strictObject({
    operation: z.literal("update"),
    expectedVersion: versionSchema,
    displayName: z.string().min(1).max(80).optional(),
    defaultParticipation: z.boolean().optional(),
    defaultPortionScale: z.number().finite().min(0.25).max(4).optional(),
    cookingSkill: cookingSkillSchema.optional(),
  })
  .superRefine((request, context) => {
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
  })
  .meta({
    "x-zod-refinements": ["an update must change at least one field"],
  });
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

/** PATCH `/person-profiles/:profileId` 请求体：更新或归档二选一。 */
export const patchPersonProfileRequestSchema = z.discriminatedUnion(
  "operation",
  [updatePersonProfileRequestSchema, archivePersonProfileRequestSchema],
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

const hardConstraintInputSchema = z
  .strictObject({
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
    }),
  })
  .superRefine((constraint, context) => {
    if (
      constraint.kind === "allergy" &&
      constraint.foodConceptIds.length === 0 &&
      constraint.allergenCodes.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["allergenCodes"],
        message:
          "allergy constraints require an allergen code or food concept",
      });
    }
  })
  .meta({
    "x-zod-refinements": [
      "hard constraints require explicit confirmation acknowledgement",
      "allergy constraints require an allergen code or food concept",
    ],
  });

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
