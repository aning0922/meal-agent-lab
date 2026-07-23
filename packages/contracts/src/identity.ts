import { z } from "zod";

import {
  authIdentityIdSchema,
  foodConceptIdSchema,
  householdIdSchema,
  membershipIdSchema,
  personProfileIdSchema,
  sessionIdSchema,
  userIdSchema,
  utcDateTimeSchema,
  versionSchema,
} from "./primitives.js";

export const userSchema = z.strictObject({
  id: userIdSchema,
  status: z.enum(["active", "disabled", "deletion_pending"]),
  displayName: z.string().min(1).max(80).optional(),
  locale: z.string().min(2).max(35),
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
  providerTenantKey: z.string().min(1).max(128),
  providerSubject: z.string().min(1).max(255),
  providerUnionSubject: z.string().min(1).max(255).optional(),
  status: z.enum(["active", "unlinked", "disabled"]),
  createdAt: utcDateTimeSchema,
  lastAuthenticatedAt: utcDateTimeSchema,
});
export type AuthIdentity = z.infer<typeof authIdentitySchema>;

export const sessionSchema = z.strictObject({
  id: sessionIdSchema,
  userId: userIdSchema,
  authIdentityId: authIdentityIdSchema,
  status: z.enum(["active", "expired", "revoked"]),
  issuedAt: utcDateTimeSchema,
  expiresAt: utcDateTimeSchema,
  lastSeenAt: utcDateTimeSchema,
  revokedAt: utcDateTimeSchema.optional(),
  tokenVersion: z.int().positive(),
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionTokenSchema = z
  .string()
  .min(43)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"SessionToken">();
export type SessionToken = z.infer<typeof sessionTokenSchema>;

export const authenticatedSessionSchema = z.strictObject({
  accessToken: sessionTokenSchema,
  session: sessionSchema,
  user: userSchema,
});
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
  name: z.string().min(1).max(80),
  timezone: z.string().min(1).max(64),
  locale: z.string().min(2).max(35),
  status: z.enum(["active", "deletion_pending", "deleted"]),
  createdByUserId: userIdSchema,
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
  version: versionSchema,
});
export type Household = z.infer<typeof householdSchema>;

export const createHouseholdRequestSchema = z.strictObject({
  name: z.string().min(1).max(80),
  timezone: z.string().min(1).max(64),
  locale: z.string().min(2).max(35),
  ownerProfile: z.strictObject({
    displayName: z.string().min(1).max(80),
    defaultPortionScale: z.number().finite().min(0.25).max(4),
    cookingSkill: z.enum(["none", "beginner", "intermediate", "advanced"]),
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
  capabilities: z
    .array(membershipCapabilitySchema)
    .refine(
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
  id: z.uuid(),
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
  visibility: z.enum(["household", "subject_and_owner"]),
  confirmedAt: utcDateTimeSchema,
  confirmedByUserId: userIdSchema,
});

const softDietaryConstraintSchema = z.strictObject({
  id: z.uuid(),
  kind: z.literal("preference"),
  enforcement: z.literal("soft"),
  label: z.string().min(1).max(120),
  preference: z.enum(["prefer", "dislike"]),
  foodConceptIds: z.array(foodConceptIdSchema).default([]),
  notes: z.string().max(500).optional(),
  visibility: z.enum(["household", "subject_and_owner"]),
  confirmedAt: utcDateTimeSchema,
  confirmedByUserId: userIdSchema,
});

export const dietaryConstraintSchema = z.discriminatedUnion("enforcement", [
  hardDietaryConstraintSchema,
  softDietaryConstraintSchema,
]).superRefine((constraint, context) => {
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
});
export type DietaryConstraint = z.infer<typeof dietaryConstraintSchema>;

export const personProfileSchema = z.strictObject({
  id: personProfileIdSchema,
  householdId: householdIdSchema,
  linkedMembershipId: membershipIdSchema.optional(),
  displayName: z.string().min(1).max(80),
  status: z.enum(["active", "archived"]),
  defaultParticipation: z.boolean(),
  defaultPortionScale: z.number().finite().min(0.25).max(4),
  cookingSkill: z.enum(["none", "beginner", "intermediate", "advanced"]),
  dietaryConstraints: z.array(dietaryConstraintSchema),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
  version: versionSchema,
});
export type PersonProfile = z.infer<typeof personProfileSchema>;
