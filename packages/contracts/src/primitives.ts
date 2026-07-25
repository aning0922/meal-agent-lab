import { z } from "zod";

import {
  bindNativeContractRule,
  ruleRefine,
  ruleSuperRefine,
} from "./contract-rule-schema.js";

export const contractVersion = "0.4.0" as const;

export const userIdSchema = z.uuidv7().brand<"UserId">();
export const authIdentityIdSchema = z.uuidv7().brand<"AuthIdentityId">();
export const sessionIdSchema = z.uuidv7().brand<"SessionId">();
export const householdIdSchema = z.uuidv7().brand<"HouseholdId">();
export const householdInviteIdSchema = z
  .uuidv7()
  .brand<"HouseholdInviteId">();
export const membershipIdSchema = z.uuidv7().brand<"MembershipId">();
export const personProfileIdSchema = z.uuidv7().brand<"PersonProfileId">();
export const personProfileLinkRequestIdSchema = z
  .uuidv7()
  .brand<"PersonProfileLinkRequestId">();
export const dietaryConstraintIdSchema = z
  .uuidv7()
  .brand<"DietaryConstraintId">();
const lowercaseUuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 一个 PostgreSQL 可持久化的 Unicode scalar：
 * - BMP 中排除 U+0000 与 surrogate 区间；
 * - supplementary code point 必须由完整 high+low surrogate pair 表示。
 *
 * 该片段刻意不依赖 RegExp `u` flag。这样同一 pattern 可直接进入
 * OpenAPI 3.0，并由一次重复匹配代表一个 PostgreSQL character_length
 * 字符；合法 emoji 算一个，孤立 high/low surrogate 不匹配。
 */
const postgresUnicodeScalarPattern =
  "(?:[\\u0001-\\uD7FF\\uE000-\\uFFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])";

/**
 * PostgreSQL text/varchar/jsonb reject U+0000 and non-scalar surrogate
 * sequences；character_length 按 Unicode scalar 计数。公共持久化字符串
 * 必须在 HTTP contract 层先与该边界对齐，不能把数据库编码错误变成 500。
 */
export const postgresTextSchema = (
  minimum: number,
  maximum: number,
) => {
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 0 ||
    maximum < minimum
  ) {
    throw new Error("invalid PostgreSQL text length boundary");
  }
  const pattern = new RegExp(
    `^(?:${postgresUnicodeScalarPattern}){${minimum},${maximum}}$`,
  );
  return z.string().regex(pattern, {
    message:
      `text must contain ${minimum}-${maximum} PostgreSQL Unicode scalar values`,
  }).meta({
    minLength: minimum,
    maxLength: maximum,
    "x-postgresql-length-unit": "unicode-code-point",
    "x-postgresql-forbidden-code-points": [
      "U+0000",
      "isolated-high-surrogate",
      "isolated-low-surrogate",
    ],
  });
};

export const foodConceptIdSchema = z
  .string()
  .regex(lowercaseUuidV7Pattern, {
    message: "food concept id must be a lowercase UUIDv7",
  })
  .brand<"FoodConceptId">();
export const foodConceptIdsSchema = ruleRefine(
  z.array(foodConceptIdSchema).max(100).meta({ uniqueItems: true }),
  "profiles.constraint.food-concepts-unique.v1",
  "foodConceptIdsSchema",
  (ids) => new Set(ids).size === ids.length,
  { message: "food concept ids must be unique" },
);
export const allergenCodesSchema = ruleRefine(
  z
    .array(postgresTextSchema(1, 64))
    .max(100)
    .meta({ uniqueItems: true }),
  "profiles.constraint.allergen-codes-unique.v1",
  "allergenCodesSchema",
  (codes) => new Set(codes).size === codes.length,
  { message: "allergen codes must be unique" },
);
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
export type HouseholdInviteId = z.infer<typeof householdInviteIdSchema>;
export type MembershipId = z.infer<typeof membershipIdSchema>;
export type PersonProfileId = z.infer<typeof personProfileIdSchema>;
export type PersonProfileLinkRequestId = z.infer<
  typeof personProfileLinkRequestIdSchema
>;
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

export const informationSourceSchema = ruleSuperRefine(
  z.strictObject({
    kind: z.enum([
      "package_label",
      "user_input",
      "verified_rule",
      "confirmed_recognition",
      "system_event",
    ]),
    confidence: confidenceSchema,
    reference: postgresTextSchema(1, 500).optional(),
    ruleVersion: postgresTextSchema(1, 100).optional(),
    capturedAt: utcDateTimeSchema,
    confirmedByUserId: userIdSchema.optional(),
  }),
  "quantity.information-source.consistency.v1",
  "informationSourceSchema",
  (source, context) => {
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
  },
);
export type InformationSource = z.infer<typeof informationSourceSchema>;

export const foodDateSchema = ruleSuperRefine(
  z.strictObject({
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
  }),
  "quantity.food-date.kind-source.v1",
  "foodDateSchema",
  (date, context) => {
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
  },
);
export type FoodDate = z.infer<typeof foodDateSchema>;

const quantityUnitSchema = postgresTextSchema(1, 32);
const quantityOriginalTextSchema = postgresTextSchema(1, 200);

export const quantityDecimalPrecision = 15;
export const quantityDecimalScale = 6;
export const quantityDecimalStep = "0.000001";
export const quantityDecimalMax = "999999999.999999";

const quantityDecimalNumberMax = 999_999_999.999_999;

const hasAtMostQuantityDecimalScale = (value: number): boolean => {
  if (!Number.isFinite(value)) {
    return false;
  }
  const [coefficient, exponentText] = value
    .toString()
    .toLowerCase()
    .split("e");
  const fractionalDigits = coefficient?.split(".")[1]?.length ?? 0;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, fractionalDigits - exponent) <= quantityDecimalScale;
};

const unsignedQuantityDecimalPattern =
  /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;
const signedQuantityDecimalPattern =
  /^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;
const positiveQuantityDecimalPattern =
  /^(?!0(?:\.0{1,6})?$)(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;
const nonZeroSignedQuantityDecimalPattern =
  /^(?!-?0(?:\.0{1,6})?$)-?(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;

export const normalizeQuantityDecimal = (value: string): string => {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "", fraction = ""] = unsigned.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const normalized =
    trimmedFraction.length === 0
      ? whole
      : `${whole}.${trimmedFraction}`;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
};

export const exactQuantityAmountSchema = z
  .string()
  .min(1)
  .max(quantityDecimalPrecision + 1)
  .regex(unsignedQuantityDecimalPattern, {
    message:
      "quantity amount must be a plain nonnegative decimal string with at most 9 integer and 6 fractional digits",
  })
  .overwrite(normalizeQuantityDecimal)
  .meta({
    format: "decimal",
    "x-decimal-maximum": quantityDecimalMax,
    "x-decimal-scale": quantityDecimalScale,
    "x-zod-refinements": [
      "quantity amount rejects JSON numbers and exponent notation before any IEEE-754 conversion",
      "equivalent fixed-point aliases normalize before idempotency hashing",
    ],
  });

export const positiveExactQuantityAmountSchema = bindNativeContractRule(
  z.string()
    .min(1)
    .max(quantityDecimalPrecision + 1)
    .regex(positiveQuantityDecimalPattern, {
      message:
        "quantity amount must be a plain positive decimal string with at most 9 integer and 6 fractional digits",
    })
    .overwrite(normalizeQuantityDecimal)
    .meta({
      format: "decimal",
      "x-decimal-minimum-exclusive": "0",
      "x-decimal-maximum": quantityDecimalMax,
      "x-decimal-scale": quantityDecimalScale,
      "x-meal-agent-rules": [
        {
          id: "quantity.exact.positive.v1",
          enforcement: "native",
          description:
            "exact quantity must be positive, including before alias normalization",
        },
      ],
    }),
  "quantity.exact.positive.v1",
  "persistableInitialQuantitySchema.exact.amount",
);

export const positiveApproximateQuantityAmountSchema = ruleRefine(
  z.number()
  .finite()
  .positive()
  .max(quantityDecimalNumberMax),
  "quantity.approximate.scale.v1",
  "approximateQuantitySchema.amount",
  hasAtMostQuantityDecimalScale,
  {
    message: `approximate quantity amount supports at most ${quantityDecimalScale} decimal places`,
  },
);

export const exactQuantitySchema = z.strictObject({
  kind: z.literal("exact"),
  amount: exactQuantityAmountSchema,
  unit: quantityUnitSchema,
  originalText: quantityOriginalTextSchema.optional(),
});

export const approximateQuantitySchema = ruleSuperRefine(
  z.strictObject({
    kind: z.literal("approximate"),
    amount: positiveApproximateQuantityAmountSchema.optional(),
    unit: quantityUnitSchema.optional(),
    originalText: quantityOriginalTextSchema,
    confidence: confidenceSchema,
  }),
  "quantity.approximate.amount-unit-pair.v1",
  "approximateQuantitySchema",
  (quantity, context) => {
    if (
      (quantity.amount === undefined) !== (quantity.unit === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["unit"],
        message:
          "approximate amount and unit must be both present or both absent",
      });
    }
  },
);

export const qualitativeQuantitySchema = z.strictObject({
  kind: z.literal("qualitative"),
  level: z.enum(["plenty", "some", "low", "empty", "unknown"]),
  originalText: quantityOriginalTextSchema.optional(),
});

export const quantitySchema = z.discriminatedUnion("kind", [
  exactQuantitySchema,
  approximateQuantitySchema,
  qualitativeQuantitySchema,
]);
export type Quantity = z.infer<typeof quantitySchema>;

export const nonEmptyQuantitySchema = ruleSuperRefine(
  quantitySchema,
  "quantity.non-empty.v1",
  "nonEmptyQuantitySchema",
  (quantity, context) => {
    if (
      (quantity.kind === "exact" && quantity.amount === "0") ||
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

export const persistableInitialQuantitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("exact"),
    amount: positiveExactQuantityAmountSchema,
    unit: quantityUnitSchema,
    originalText: quantityOriginalTextSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("approximate"),
    amount: positiveApproximateQuantityAmountSchema,
    unit: quantityUnitSchema,
    confidence: confidenceSchema,
    originalText: quantityOriginalTextSchema,
  }),
  z.strictObject({
    kind: z.literal("qualitative"),
    level: z.enum(["plenty", "some", "low", "unknown"]),
    originalText: quantityOriginalTextSchema.optional(),
  }),
]);
export type PersistableInitialQuantity = z.infer<
  typeof persistableInitialQuantitySchema
>;

const estimatedQuantityDeltaAmountWithScale = ruleRefine(
  z.number()
  .finite()
  .min(-quantityDecimalNumberMax)
  .max(quantityDecimalNumberMax)
  .meta({ not: { const: 0 } }),
  "quantity.delta.estimated-scale.v1",
  "quantityDeltaSchema.estimated.amount",
  hasAtMostQuantityDecimalScale,
  {
    message: `quantity delta supports at most ${quantityDecimalScale} decimal places`,
  },
);
export const nonZeroEstimatedQuantityDeltaAmountSchema = ruleRefine(
  estimatedQuantityDeltaAmountWithScale,
  "quantity.delta.estimated-nonzero.v1",
  "quantityDeltaSchema.estimated.amount",
  (amount) => amount !== 0,
  {
    message: "quantity delta cannot be zero",
  },
);

const nonZeroExactQuantityDeltaAmountSchema = bindNativeContractRule(
  z.string()
    .min(1)
    .max(quantityDecimalPrecision + 2)
    .regex(nonZeroSignedQuantityDecimalPattern, {
      message:
        "exact quantity delta must be a plain signed decimal string with at most 9 integer and 6 fractional digits",
    })
    .overwrite(normalizeQuantityDecimal)
    .meta({
      format: "decimal",
      "x-decimal-minimum": `-${quantityDecimalMax}`,
      "x-decimal-maximum": quantityDecimalMax,
      "x-decimal-scale": quantityDecimalScale,
      "x-zod-refinements": [
        "exact quantity delta rejects JSON numbers and exponent notation before any IEEE-754 conversion",
        "quantity delta cannot be zero",
      ],
      "x-meal-agent-rules": [
        {
          id: "quantity.delta.exact-nonzero.v1",
          enforcement: "native",
          description: "exact quantity delta cannot be mathematical zero",
        },
      ],
    }),
  "quantity.delta.exact-nonzero.v1",
  "quantityDeltaSchema.exact.amount",
);

export const quantityDeltaSchema = z.discriminatedUnion("precision", [
  z.strictObject({
    kind: z.literal("numeric"),
    amount: nonZeroExactQuantityDeltaAmountSchema,
    unit: quantityUnitSchema,
    precision: z.literal("exact"),
    originalText: quantityOriginalTextSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("numeric"),
    amount: nonZeroEstimatedQuantityDeltaAmountSchema,
    unit: quantityUnitSchema,
    precision: z.literal("estimated"),
    confidence: confidenceSchema,
    originalText: quantityOriginalTextSchema,
  }),
]);
export type QuantityDelta = z.infer<typeof quantityDeltaSchema>;

export const qualitativeQuantityChangeSchema = z.strictObject({
  kind: z.literal("qualitative"),
  fromLevel: qualitativeQuantitySchema.shape.level,
  toLevel: qualitativeQuantitySchema.shape.level,
  originalText: quantityOriginalTextSchema.optional(),
});
export type QualitativeQuantityChange = z.infer<
  typeof qualitativeQuantityChangeSchema
>;

export const quantityChangeSchema = z.union([
  quantityDeltaSchema,
  qualitativeQuantityChangeSchema,
]);
export type QuantityChange = z.infer<typeof quantityChangeSchema>;
