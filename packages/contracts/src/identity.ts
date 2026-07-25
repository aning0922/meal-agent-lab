import { z } from "zod";

import {
  ruleRefine,
  ruleSuperRefine,
} from "./contract-rule-schema.js";
import {
  authIdentityIdSchema,
  allergenCodesSchema,
  dietaryConstraintIdSchema,
  foodConceptIdsSchema,
  householdIdSchema,
  membershipIdSchema,
  personProfileIdSchema,
  postgresTextSchema,
  sessionIdSchema,
  userIdSchema,
  utcDateTimeSchema,
  versionSchema,
} from "./primitives.js";

export const userSchema = z.strictObject({
  id: userIdSchema,
  status: z.enum(["active", "disabled", "deletion_pending"]),
  displayName: postgresTextSchema(1, 80).optional(),
  locale: postgresTextSchema(2, 35),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
  version: versionSchema,
});
export type User = z.infer<typeof userSchema>;

export const authIdentitySchema = z.strictObject({
  id: authIdentityIdSchema,
  userId: userIdSchema,
  provider: z.enum([
    "wechat_miniprogram",
    "phone",
    "apple",
    "huawei",
  ]),
  providerTenantKey: postgresTextSchema(1, 128),
  providerSubject: postgresTextSchema(1, 255),
  providerUnionSubject: postgresTextSchema(1, 255).optional(),
  status: z.enum(["active", "disabled"]),
  createdAt: utcDateTimeSchema,
  lastAuthenticatedAt: utcDateTimeSchema,
});
export type AuthIdentity = z.infer<typeof authIdentitySchema>;

export const sessionSchema = ruleSuperRefine(
  z.strictObject({
    id: sessionIdSchema,
    userId: userIdSchema,
    authIdentityId: authIdentityIdSchema,
    status: z.enum(["active", "expired", "revoked"]),
    issuedAt: utcDateTimeSchema,
    expiresAt: utcDateTimeSchema,
    lastSeenAt: utcDateTimeSchema,
    revokedAt: utcDateTimeSchema.optional(),
    tokenVersion: z.int().positive(),
  }),
  "identity.session.lifecycle.v1",
  "sessionSchema",
  (session, context) => {
    if (session.status === "revoked" && session.revokedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "revoked sessions require revokedAt",
      });
    }

    if (session.status !== "revoked" && session.revokedAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "only revoked sessions may have revokedAt",
      });
    }

    if (Date.parse(session.expiresAt) <= Date.parse(session.issuedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "session expiry must be after issuance",
      });
    }
  },
);
export type Session = z.infer<typeof sessionSchema>;

export const sessionTokenSchema = z
  .string()
  .min(43)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"SessionToken">();
export type SessionToken = z.infer<typeof sessionTokenSchema>;

export const authenticatedSessionSchema = ruleSuperRefine(
  z.strictObject({
    accessToken: sessionTokenSchema,
    session: sessionSchema,
    user: userSchema,
  }),
  "identity.authenticated-session.consistency.v1",
  "authenticatedSessionSchema",
  (authenticatedSession, context) => {
    if (authenticatedSession.user.status !== "active") {
      context.addIssue({
        code: "custom",
        path: ["user", "status"],
        message: "authenticated sessions require an active user",
      });
    }

    if (authenticatedSession.session.status !== "active") {
      context.addIssue({
        code: "custom",
        path: ["session", "status"],
        message: "authenticated sessions require an active session",
      });
    }

    if (
      authenticatedSession.session.userId !==
      authenticatedSession.user.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["session", "userId"],
        message: "session user must match the authenticated user",
      });
    }
  },
);
export type AuthenticatedSession = z.infer<
  typeof authenticatedSessionSchema
>;

export const wechatLoginExchangeRequestSchema = z.strictObject({
  loginCode: z.string().min(1).max(512),
});
export type WechatLoginExchangeRequest = z.infer<
  typeof wechatLoginExchangeRequestSchema
>;

export const householdSchema = z.strictObject({
  id: householdIdSchema,
  name: postgresTextSchema(1, 80),
  timezone: postgresTextSchema(1, 64),
  locale: postgresTextSchema(2, 35),
  status: z.enum(["active", "deletion_pending", "deleted"]),
  createdByUserId: userIdSchema,
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
  version: versionSchema,
});
export type Household = z.infer<typeof householdSchema>;

export const createHouseholdRequestSchema = z.strictObject({
  name: postgresTextSchema(1, 80),
  timezone: postgresTextSchema(1, 64),
  locale: postgresTextSchema(2, 35),
  ownerProfile: z.strictObject({
    displayName: postgresTextSchema(1, 80),
    defaultParticipation: z.boolean().nullable().default(null),
    defaultPortionScale: z
      .number()
      .finite()
      .min(0.25)
      .max(4)
      .nullable()
      .default(null),
    cookingSkill: z
      .enum(["none", "beginner", "intermediate", "advanced"])
      .nullable()
      .default(null),
  }),
});
export type CreateHouseholdRequest = z.infer<
  typeof createHouseholdRequestSchema
>;

export const membershipCapabilitySchema = z.enum([
  "inventory:write",
  "meal:write",
  "shopping:write",
]);
export type MembershipCapability = z.infer<
  typeof membershipCapabilitySchema
>;

export const membershipSchema = z.strictObject({
  id: membershipIdSchema,
  householdId: householdIdSchema,
  userId: userIdSchema,
  role: z.enum(["owner", "member"]),
  capabilities: ruleRefine(
    z.array(membershipCapabilitySchema),
    "identity.membership.capabilities-unique.v1",
    "membershipSchema.capabilities",
      (capabilities) =>
        new Set(capabilities).size === capabilities.length,
      { message: "membership capabilities must be unique" },
    ),
  status: z.enum(["active", "left", "removed"]),
  joinedAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
  version: versionSchema,
});
export type Membership = z.infer<typeof membershipSchema>;

const hardDietaryConstraintSchema = z.strictObject({
  id: dietaryConstraintIdSchema,
  kind: z.enum([
    "allergy",
    "religious",
    "ethical",
    "explicit_avoid",
    "food_safety_exclusion",
  ]),
  enforcement: z.literal("hard"),
  label: postgresTextSchema(1, 120),
  foodConceptIds: foodConceptIdsSchema.default([]),
  allergenCodes: allergenCodesSchema.default([]),
  // Stage 08 尚无权威 allergen / food concept / 宗教 / 伦理规则词表。
  // 形状正确的字符串或 UUID 不能被当成机器可执行映射。
  mappingStatus: z.literal("needs_structured_mapping"),
  notes: postgresTextSchema(0, 500).optional(),
  visibility: z.enum(["household", "subject_and_owner"]),
  confirmedAt: utcDateTimeSchema,
  confirmedByUserId: userIdSchema,
});

const softDietaryConstraintSchema = z.strictObject({
  id: dietaryConstraintIdSchema,
  kind: z.literal("preference"),
  enforcement: z.literal("soft"),
  label: postgresTextSchema(1, 120),
  preference: z.enum(["prefer", "dislike"]),
  foodConceptIds: foodConceptIdsSchema.default([]),
  notes: postgresTextSchema(0, 500).optional(),
  visibility: z.enum(["household", "subject_and_owner"]),
  confirmedAt: utcDateTimeSchema,
  confirmedByUserId: userIdSchema,
});

export const dietaryConstraintSchema = z.discriminatedUnion(
  "enforcement",
  [hardDietaryConstraintSchema, softDietaryConstraintSchema],
);
export type DietaryConstraint = z.infer<typeof dietaryConstraintSchema>;

export const personProfileSchema = z.strictObject({
  id: personProfileIdSchema,
  householdId: householdIdSchema,
  linkedMembershipId: membershipIdSchema.optional(),
  displayName: postgresTextSchema(1, 80),
  status: z.enum(["active", "archived"]),
  defaultParticipation: z.boolean().nullable(),
  defaultPortionScale: z.number().finite().min(0.25).max(4).nullable(),
  cookingSkill: z
    .enum(["none", "beginner", "intermediate", "advanced"])
    .nullable(),
  dietaryConstraints: z.array(dietaryConstraintSchema),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
  version: versionSchema,
});
export type PersonProfile = z.infer<typeof personProfileSchema>;

const householdVisibleDietaryConstraintSchema = ruleRefine(
  dietaryConstraintSchema,
  "identity.profile.household-visibility.v1",
  "safeOwnerProfileResponseSchema",
    (constraint) => constraint.visibility === "household",
    {
      message:
        "safe profile responses cannot contain subject_and_owner constraints",
    },
  );

export const safeOwnerProfileResponseSchema = personProfileSchema.extend({
  dietaryConstraints: z.array(householdVisibleDietaryConstraintSchema),
});
export type SafeOwnerProfileResponse = z.infer<
  typeof safeOwnerProfileResponseSchema
>;

export const createHouseholdResultSchema = ruleSuperRefine(
  z.strictObject({
    household: householdSchema,
    membership: membershipSchema,
    ownerProfile: safeOwnerProfileResponseSchema,
  }),
  "identity.household-create.consistency.v1",
  "createHouseholdResultSchema",
  (result, context) => {
    if (
      result.membership.householdId !== result.household.id ||
      result.ownerProfile.householdId !== result.household.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["membership", "householdId"],
        message:
          "created household, owner membership and owner profile must share a household",
      });
    }

    if (
      result.membership.userId !== result.household.createdByUserId ||
      result.membership.role !== "owner" ||
      result.membership.status !== "active"
    ) {
      context.addIssue({
        code: "custom",
        path: ["membership"],
        message:
          "created household requires an active owner membership for its creator",
      });
    }

    if (
      result.ownerProfile.linkedMembershipId !== result.membership.id ||
      result.ownerProfile.status !== "active"
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownerProfile", "linkedMembershipId"],
        message:
          "created owner profile must be active and linked to the owner membership",
      });
    }
  },
);
export type CreateHouseholdResult = z.infer<
  typeof createHouseholdResultSchema
>;
