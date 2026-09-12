import { z } from "zod";

import { ruleSuperRefine } from "./contract-rule-schema.js";
import {
  canonicalSha256DigestSchema,
  foodConceptIdSchema,
  householdIdSchema,
  inventoryLotIdSchema,
  mealIdSchema,
  nonEmptyQuantitySchema,
  personProfileIdSchema,
  recipeIdSchema,
  recommendationCandidateIdSchema,
  recommendationIdSchema,
  utcDateTimeSchema,
  versionSchema,
} from "./primitives.js";

export const recipeIngredientSchema = z.strictObject({
  foodConceptId: foodConceptIdSchema,
  displayName: z.string().min(1).max(120),
  quantity: nonEmptyQuantitySchema,
  optional: z.boolean(),
  allergenCodes: z.array(z.string().min(1).max(64)),
  mayContainAllergenCodes: z.array(z.string().min(1).max(64)),
});
export type RecipeIngredient = z.infer<typeof recipeIngredientSchema>;

export const recipeSchema = ruleSuperRefine(
  z.strictObject({
    id: recipeIdSchema,
    version: z.int().positive(),
    status: z.enum(["draft", "reviewed", "retired"]),
    title: z.string().min(1).max(160),
    description: z.string().max(1000).optional(),
    servings: z.number().finite().positive(),
    dishRole: z.enum(["staple", "main", "vegetable", "soup", "side"]),
    ingredients: z.array(recipeIngredientSchema).min(1),
    steps: z
      .array(
        z.strictObject({
          order: z.int().positive(),
          instruction: z.string().min(1).max(1000),
          safetyNote: z.string().max(500).optional(),
        }),
      )
      .min(1),
    requiredEquipment: z.array(z.string().min(1).max(80)),
    activeMinutes: z.int().nonnegative(),
    totalMinutes: z.int().positive(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]),
    source: z.strictObject({
      name: z.string().min(1).max(200),
      url: z.url().optional(),
      licenseStatus: z.enum(["authorized", "licensed", "internal_original"]),
      licenseReference: z.string().min(1).max(500),
      retrievedAt: utcDateTimeSchema,
    }),
    reviewedAt: utcDateTimeSchema.optional(),
  }),
  "meal.recipe.review-and-steps.v1",
  "recipeSchema",
  (recipe, context) => {
    if (recipe.status === "reviewed" && recipe.reviewedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["reviewedAt"],
        message: "reviewed recipes require reviewedAt",
      });
    }

    const stepOrders = recipe.steps.map((step) => step.order);
    if (new Set(stepOrders).size !== stepOrders.length) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "recipe step order values must be unique",
      });
    }
  },
);
export type Recipe = z.infer<typeof recipeSchema>;

export const mealRecipeSelectionSchema = z.strictObject({
  recipeId: recipeIdSchema,
  recipeVersion: z.int().positive(),
  servings: z.number().finite().positive(),
});
export type MealRecipeSelection = z.infer<typeof mealRecipeSelectionSchema>;

export const mealSchema = ruleSuperRefine(
  z.strictObject({
    id: mealIdSchema,
    householdId: householdIdSchema,
    recommendationId: recommendationIdSchema.optional(),
    participantProfileIds: z.array(personProfileIdSchema).min(1),
    cookProfileId: personProfileIdSchema,
    recipes: z.array(mealRecipeSelectionSchema).min(1).max(3),
    status: z.enum([
      "draft",
      "confirmed",
      "shopping_required",
      "ready",
      "cooking",
      "completed",
      "cancelled",
    ]),
    scheduledFor: utcDateTimeSchema,
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
    version: versionSchema,
  }),
  "meal.instance.unique-participants-recipes.v1",
  "mealSchema",
  (meal, context) => {
    if (
      new Set(meal.participantProfileIds).size !==
      meal.participantProfileIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["participantProfileIds"],
        message: "meal participants must be unique",
      });
    }

    const recipeIds = meal.recipes.map((recipe) => recipe.recipeId);
    if (new Set(recipeIds).size !== recipeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["recipes"],
        message: "a meal cannot include the same recipe more than once",
      });
    }
  },
);
export type Meal = z.infer<typeof mealSchema>;

/**
 * 确认本餐的请求。它是既有实体 schema 的薄组合，不引入新实体。
 * `expectedSnapshotDigest` 由服务端在确认时与已持久化 Recommendation 的
 * `snapshot.snapshotDigest` 逐字节比对；不相容即稳定 409，**不**创建 Meal。
 */
export const createMealRequestSchema = ruleSuperRefine(
  z.strictObject({
    recommendationId: recommendationIdSchema,
    participantProfileIds: z.array(personProfileIdSchema).min(1),
    cookProfileId: personProfileIdSchema,
    recipes: z.array(mealRecipeSelectionSchema).min(1).max(3),
    scheduledFor: utcDateTimeSchema,
    expectedSnapshotDigest: canonicalSha256DigestSchema,
  }),
  "meal.create-request.participants-unique.v1",
  "createMealRequestSchema",
  (request, context) => {
    if (
      new Set(request.participantProfileIds).size !==
      request.participantProfileIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["participantProfileIds"],
        message: "meal request participants must be unique",
      });
    }
  },
);
export type CreateMealRequest = z.infer<typeof createMealRequestSchema>;

export const recommendationCandidateSchema = z.strictObject({
  id: recommendationCandidateIdSchema,
  recipeId: recipeIdSchema,
  recipeVersion: z.int().positive(),
  servings: z.number().finite().positive(),
  dishRole: z.enum(["staple", "main", "vegetable", "soup", "side"]),
  activeMinutes: z.int().nonnegative(),
  totalMinutes: z.int().positive(),
  missingFoodConceptIds: z.array(foodConceptIdSchema),
  plannedInventoryLotIds: z.array(inventoryLotIdSchema),
  reasonCodes: z.array(z.string().min(1).max(80)).min(1),
  assumptions: z.array(z.string().min(1).max(300)),
  hardConstraintCheck: z.strictObject({
    status: z.literal("passed"),
    policyVersion: z.string().min(1).max(100),
    checkedAt: utcDateTimeSchema,
  }),
});
export type RecommendationCandidate = z.infer<
  typeof recommendationCandidateSchema
>;

/**
 * 统一四段快照（of record §5.4）：库存 / 约束 / 食谱 / 策略，各段带自己的
 * 规范化摘要，外加一个覆盖**全部四段**的 `snapshotDigest`。每一段内数组按
 * 其键升序（`canonicalJson` 只定义对象键序，段内顺序由本契约固定为升序），
 * 规范化一律复用既有 `canonicalJson`，不另造规则。
 *
 * `constraintSetDigest` 绑定**未脱敏**约束集，因此只承载摘要、绝不承载原文。
 */
export const recommendationSnapshotSchema = z.strictObject({
  inventory: z.strictObject({
    lots: z.array(
      z.strictObject({
        lotId: inventoryLotIdSchema,
        lotVersion: versionSchema,
        foodConceptRevision: versionSchema,
        safetyAssessmentRevision: versionSchema,
      }),
    ),
    inventoryDigest: canonicalSha256DigestSchema,
  }),
  constraints: z.strictObject({
    profiles: z.array(
      z.strictObject({
        participantProfileId: personProfileIdSchema,
        profileVersion: versionSchema,
        constraintSetDigest: canonicalSha256DigestSchema,
      }),
    ),
    mappingReleaseId: z.string().min(1).max(100),
    constraintDigest: canonicalSha256DigestSchema,
  }),
  recipes: z.strictObject({
    recipes: z.array(
      z.strictObject({
        recipeId: recipeIdSchema,
        recipeVersion: z.int().positive(),
        contentDigest: canonicalSha256DigestSchema,
        datasetReleaseId: z.string().min(1).max(100),
      }),
    ),
    recipeDigest: canonicalSha256DigestSchema,
  }),
  policies: z.strictObject({
    foodConceptReleaseId: z.string().min(1).max(100),
    allergenReleaseId: z.string().min(1).max(100),
    religiousEthicalReleaseId: z.string().min(1).max(100),
    foodSafetyReleaseId: z.string().min(1).max(100),
    techniqueReleaseId: z.string().min(1).max(100),
    recommendationEngineVersion: z.string().min(1).max(100),
    policyDigest: canonicalSha256DigestSchema,
  }),
  snapshotDigest: canonicalSha256DigestSchema,
});
export type RecommendationSnapshot = z.infer<
  typeof recommendationSnapshotSchema
>;

export const recommendationSchema = ruleSuperRefine(
  z.strictObject({
    id: recommendationIdSchema,
    householdId: householdIdSchema,
    outcome: z.enum(["options", "no_feasible_option"]),
    participantProfileIds: z.array(personProfileIdSchema).min(1),
    cookProfileId: personProfileIdSchema,
    maximumTotalMinutes: z.int().positive(),
    purchaseTolerance: z.enum(["none", "limited", "allowed"]),
    suggestedDishCount: z.int().min(1).max(3),
    candidates: z.array(recommendationCandidateSchema),
    preselectedCandidateIds: z
      .array(recommendationCandidateIdSchema)
      .max(3),
    blockerCodes: z.array(z.string().min(1).max(80)),
    assumptions: z.array(z.string().min(1).max(300)),
    snapshot: recommendationSnapshotSchema,
    recommendationPolicyVersion: z.string().min(1).max(100),
    createdAt: utcDateTimeSchema,
    expiresAt: utcDateTimeSchema,
  }),
  "meal.recommendation.outcome-consistency.v1",
  "recommendationSchema",
  (recommendation, context) => {
    if (
      recommendation.outcome === "options" &&
      recommendation.candidates.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "options outcome requires at least one validated candidate",
      });
    }

    if (
      recommendation.outcome === "options" &&
      recommendation.preselectedCandidateIds.length !==
        recommendation.suggestedDishCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["preselectedCandidateIds"],
        message:
          "preselected candidates must match the suggested dish count",
      });
    }

    if (
      recommendation.outcome === "options" &&
      recommendation.blockerCodes.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["blockerCodes"],
        message: "an options outcome cannot contain hard blockers",
      });
    }

    if (
      recommendation.outcome === "no_feasible_option" &&
      (recommendation.candidates.length !== 0 ||
        recommendation.blockerCodes.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "no-feasible-option requires blockers and cannot contain candidates",
      });
    }

    const candidateIds = new Set(
      recommendation.candidates.map((candidate) => candidate.id),
    );
    if (candidateIds.size !== recommendation.candidates.length) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "recommendation candidate IDs must be unique",
      });
    }

    if (
      new Set(recommendation.preselectedCandidateIds).size !==
      recommendation.preselectedCandidateIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["preselectedCandidateIds"],
        message: "preselected candidate IDs must be unique",
      });
    }

    if (
      recommendation.preselectedCandidateIds.some(
        (candidateId) => !candidateIds.has(candidateId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["preselectedCandidateIds"],
        message: "preselected candidates must be included in candidates",
      });
    }
  },
);
export type Recommendation = z.infer<typeof recommendationSchema>;

/**
 * 生成推荐的请求。字段与 `recommendationSchema` 的同名输入面逐一同形，
 * 刻意**不**新增字段——尤其没有客户端快照断言：快照由服务端在生成时读取
 * 当前事实并冻结进 `recommendationSchema.snapshot`。
 */
export const generateRecommendationRequestSchema = ruleSuperRefine(
  z.strictObject({
    participantProfileIds: z.array(personProfileIdSchema).min(1),
    cookProfileId: personProfileIdSchema,
    maximumTotalMinutes: z.int().positive(),
    purchaseTolerance: z.enum(["none", "limited", "allowed"]),
    suggestedDishCount: z.int().min(1).max(3),
  }),
  "meal.recommendation-request.participants-unique.v1",
  "generateRecommendationRequestSchema",
  (request, context) => {
    if (
      new Set(request.participantProfileIds).size !==
      request.participantProfileIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["participantProfileIds"],
        message: "recommendation request participants must be unique",
      });
    }
  },
);
export type GenerateRecommendationRequest = z.infer<
  typeof generateRecommendationRequestSchema
>;
