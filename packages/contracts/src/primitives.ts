import { z } from "zod";

export const contractVersion = "0.1.0" as const;

export const userIdSchema = z.uuidv7().brand<"UserId">();
export const authIdentityIdSchema = z.uuidv7().brand<"AuthIdentityId">();
export const sessionIdSchema = z.uuidv7().brand<"SessionId">();
export const householdIdSchema = z.uuidv7().brand<"HouseholdId">();
export const membershipIdSchema = z.uuidv7().brand<"MembershipId">();
export const personProfileIdSchema = z.uuidv7().brand<"PersonProfileId">();
export const dietaryConstraintIdSchema = z
  .uuidv7()
  .brand<"DietaryConstraintId">();
export const foodConceptIdSchema = z.uuidv7().brand<"FoodConceptId">();
export const inventoryLotIdSchema = z.uuidv7().brand<"InventoryLotId">();
export const inventoryEventIdSchema = z.uuidv7().brand<"InventoryEventId">();
export const recipeIdSchema = z.uuidv7().brand<"RecipeId">();
export const mealIdSchema = z.uuidv7().brand<"MealId">();
export const recommendationIdSchema = z
  .uuidv7()
  .brand<"RecommendationId">();
export const recommendationCandidateIdSchema = z
  .uuidv7()
  .brand<"RecommendationCandidateId">();
export const shoppingItemIdSchema = z.uuidv7().brand<"ShoppingItemId">();
export const requestIdSchema = z.uuid().brand<"RequestId">();

export type UserId = z.infer<typeof userIdSchema>;
export type AuthIdentityId = z.infer<typeof authIdentityIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type HouseholdId = z.infer<typeof householdIdSchema>;
export type MembershipId = z.infer<typeof membershipIdSchema>;
export type PersonProfileId = z.infer<typeof personProfileIdSchema>;
export type DietaryConstraintId = z.infer<
  typeof dietaryConstraintIdSchema
>;
export type FoodConceptId = z.infer<typeof foodConceptIdSchema>;
export type InventoryLotId = z.infer<typeof inventoryLotIdSchema>;
export type InventoryEventId = z.infer<typeof inventoryEventIdSchema>;
export type RecipeId = z.infer<typeof recipeIdSchema>;
export type MealId = z.infer<typeof mealIdSchema>;
export type RecommendationId = z.infer<typeof recommendationIdSchema>;
export type RecommendationCandidateId = z.infer<
  typeof recommendationCandidateIdSchema
>;
export type ShoppingItemId = z.infer<typeof shoppingItemIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;

export const utcDateTimeSchema = z.iso.datetime({ offset: true });
export const localDateSchema = z.iso.date();
export const versionSchema = z.int().nonnegative();

export const confidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof confidenceSchema>;

export const informationSourceSchema = z
  .strictObject({
    kind: z.enum([
      "package_label",
      "user_input",
      "verified_rule",
      "confirmed_recognition",
      "system_event",
    ]),
    confidence: confidenceSchema,
    reference: z.string().min(1).max(500).optional(),
    ruleVersion: z.string().min(1).max(100).optional(),
    capturedAt: utcDateTimeSchema,
    confirmedByUserId: userIdSchema.optional(),
  })
  .superRefine((source, context) => {
    if (source.kind === "verified_rule" && source.ruleVersion === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ruleVersion"],
        message: "verified_rule requires ruleVersion",
      });
    }

    if (
      source.kind === "confirmed_recognition" &&
      source.confirmedByUserId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmedByUserId"],
        message: "recognized information must be confirmed by a user",
      });
    }
  });
export type InformationSource = z.infer<typeof informationSourceSchema>;

export const foodDateSchema = z
  .strictObject({
    kind: z.enum([
      "purchase_date",
      "production_date",
      "best_before_date",
      "use_by_date",
      "prepared_at",
      "opened_at",
      "frozen_at",
      "thawed_at",
      "estimated_use_by_date",
    ]),
    value: z.union([localDateSchema, utcDateTimeSchema]),
    source: informationSourceSchema,
  })
  .superRefine((date, context) => {
    const timestampKinds = new Set([
      "prepared_at",
      "opened_at",
      "frozen_at",
      "thawed_at",
    ]);
    const isTimestamp = date.value.includes("T");

    if (timestampKinds.has(date.kind) !== isTimestamp) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: timestampKinds.has(date.kind)
          ? "event dates require an offset datetime"
          : "package and derived dates require a calendar date",
      });
    }

    if (
      date.kind === "estimated_use_by_date" &&
      date.source.kind !== "verified_rule"
    ) {
      context.addIssue({
        code: "custom",
        path: ["source", "kind"],
        message: "estimated use-by dates must come from a verified rule",
      });
    }

    if (
      date.kind === "purchase_date" &&
      !["user_input", "confirmed_recognition"].includes(date.source.kind)
    ) {
      context.addIssue({
        code: "custom",
        path: ["source", "kind"],
        message:
          "purchase dates must be entered by a user or come from confirmed recognition",
      });
    }

    if (
      [
        "production_date",
        "best_before_date",
        "use_by_date",
      ].includes(date.kind) &&
      ![
        "package_label",
        "user_input",
        "confirmed_recognition",
      ].includes(date.source.kind)
    ) {
      context.addIssue({
        code: "custom",
        path: ["source", "kind"],
        message: "package dates cannot come from a derived rule or system event",
      });
    }

    if (
      timestampKinds.has(date.kind) &&
      ![
        "user_input",
        "confirmed_recognition",
        "system_event",
      ].includes(date.source.kind)
    ) {
      context.addIssue({
        code: "custom",
        path: ["source", "kind"],
        message: "state event dates require a user, confirmed, or system source",
      });
    }
  });
export type FoodDate = z.infer<typeof foodDateSchema>;

export const exactQuantitySchema = z.strictObject({
  kind: z.literal("exact"),
  amount: z.number().finite().nonnegative(),
  unit: z.string().min(1).max(32),
  originalText: z.string().min(1).max(200).optional(),
});

export const approximateQuantitySchema = z.strictObject({
  kind: z.literal("approximate"),
  amount: z.number().finite().positive().optional(),
  unit: z.string().min(1).max(32).optional(),
  originalText: z.string().min(1).max(200),
  confidence: confidenceSchema,
});

export const qualitativeQuantitySchema = z.strictObject({
  kind: z.literal("qualitative"),
  level: z.enum(["plenty", "some", "low", "empty", "unknown"]),
  originalText: z.string().min(1).max(200).optional(),
});

export const quantitySchema = z.discriminatedUnion("kind", [
  exactQuantitySchema,
  approximateQuantitySchema,
  qualitativeQuantitySchema,
]);
export type Quantity = z.infer<typeof quantitySchema>;

export const nonEmptyQuantitySchema = quantitySchema.superRefine(
  (quantity, context) => {
    if (
      (quantity.kind === "exact" && quantity.amount === 0) ||
      (quantity.kind === "qualitative" && quantity.level === "empty")
    ) {
      context.addIssue({
        code: "custom",
        message: "quantity must represent a non-empty amount",
      });
    }
  },
);
export type NonEmptyQuantity = z.infer<typeof nonEmptyQuantitySchema>;

export const quantityDeltaSchema = z.strictObject({
  kind: z.literal("numeric"),
  amount: z.number().finite().refine((amount) => amount !== 0, {
    message: "quantity delta cannot be zero",
  }),
  unit: z.string().min(1).max(32),
  precision: z.enum(["exact", "estimated"]),
  originalText: z.string().min(1).max(200).optional(),
});
export type QuantityDelta = z.infer<typeof quantityDeltaSchema>;

export const qualitativeQuantityChangeSchema = z.strictObject({
  kind: z.literal("qualitative"),
  fromLevel: qualitativeQuantitySchema.shape.level,
  toLevel: qualitativeQuantitySchema.shape.level,
  originalText: z.string().min(1).max(200).optional(),
});
export type QualitativeQuantityChange = z.infer<
  typeof qualitativeQuantityChangeSchema
>;

export const quantityChangeSchema = z.discriminatedUnion("kind", [
  quantityDeltaSchema,
  qualitativeQuantityChangeSchema,
]);
export type QuantityChange = z.infer<typeof quantityChangeSchema>;
