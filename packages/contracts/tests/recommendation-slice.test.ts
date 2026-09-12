import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSha256DigestSchema,
  createMealRequestSchema,
  generateRecommendationRequestSchema,
  mealSuccessSchema,
  recommendationSnapshotSchema,
  recommendationSuccessSchema,
  type CreateMealRequest,
  type GenerateRecommendationRequest,
} from "../src/index.js";

const ids = {
  household: "018f0000-0000-7000-8000-000000000004",
  profile: "018f0000-0000-7000-8000-000000000006",
  profile2: "018f0000-0000-7000-8000-000000000019",
  lot: "018f0000-0000-7000-8000-000000000008",
  recipe: "018f0000-0000-7000-8000-000000000010",
  meal: "018f0000-0000-7000-8000-000000000011",
  recommendation: "018f0000-0000-7000-8000-000000000012",
  candidate: "018f0000-0000-7000-8000-000000000013",
} as const;

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const now = "2026-07-23T12:00:00Z";

const digest = (seed: number): string =>
  `sha256:${seed.toString(16).padStart(64, "0")}`;

const validSnapshot = () => ({
  inventory: {
    lots: [
      {
        lotId: ids.lot,
        lotVersion: 1,
        foodConceptRevision: 1,
        safetyAssessmentRevision: 1,
      },
    ],
    inventoryDigest: digest(1),
  },
  constraints: {
    profiles: [
      {
        participantProfileId: ids.profile,
        profileVersion: 1,
        constraintSetDigest: digest(2),
      },
    ],
    mappingReleaseId: "mapping-release-1",
    constraintDigest: digest(3),
  },
  recipes: {
    recipes: [
      {
        recipeId: ids.recipe,
        recipeVersion: 1,
        contentDigest: digest(4),
        datasetReleaseId: "recipe-release-1",
      },
    ],
    recipeDigest: digest(5),
  },
  policies: {
    foodConceptReleaseId: "food-concept-release-1",
    allergenReleaseId: "allergen-release-1",
    religiousEthicalReleaseId: "religious-ethical-release-1",
    foodSafetyReleaseId: "food-safety-release-1",
    techniqueReleaseId: "technique-release-1",
    recommendationEngineVersion: "engine-1",
    policyDigest: digest(6),
  },
  snapshotDigest: digest(7),
});

const validRecommendation = () => ({
  id: ids.recommendation,
  householdId: ids.household,
  outcome: "options",
  participantProfileIds: [ids.profile],
  cookProfileId: ids.profile,
  maximumTotalMinutes: 30,
  purchaseTolerance: "none",
  suggestedDishCount: 1,
  candidates: [
    {
      id: ids.candidate,
      recipeId: ids.recipe,
      recipeVersion: 1,
      servings: 2,
      dishRole: "main",
      activeMinutes: 10,
      totalMinutes: 15,
      missingFoodConceptIds: [],
      plannedInventoryLotIds: [ids.lot],
      reasonCodes: ["USES_AVAILABLE_INGREDIENT"],
      assumptions: [],
      hardConstraintCheck: {
        status: "passed",
        policyVersion: "constraint-policy-1",
        checkedAt: now,
      },
    },
  ],
  preselectedCandidateIds: [ids.candidate],
  blockerCodes: [],
  assumptions: [],
  snapshot: validSnapshot(),
  recommendationPolicyVersion: "recommendation-policy-1",
  createdAt: now,
  expiresAt: "2026-07-23T12:10:00Z",
});

const validMeal = () => ({
  id: ids.meal,
  householdId: ids.household,
  recommendationId: ids.recommendation,
  participantProfileIds: [ids.profile],
  cookProfileId: ids.profile,
  recipes: [{ recipeId: ids.recipe, recipeVersion: 1, servings: 2 }],
  status: "confirmed",
  scheduledFor: now,
  createdAt: now,
  updatedAt: now,
  version: 0,
});

const validGenerateRequest = () => ({
  participantProfileIds: [ids.profile],
  cookProfileId: ids.profile,
  maximumTotalMinutes: 30,
  purchaseTolerance: "none",
  suggestedDishCount: 1,
});

const validCreateMealRequest = () => ({
  recommendationId: ids.recommendation,
  participantProfileIds: [ids.profile],
  cookProfileId: ids.profile,
  recipes: [{ recipeId: ids.recipe, recipeVersion: 1, servings: 2 }],
  scheduledFor: now,
  expectedSnapshotDigest: digest(7),
});

test("canonical digest schema accepts only a sha256 prefix followed by 64 lowercase hex digits", () => {
  assert.equal(canonicalSha256DigestSchema.safeParse(digest(0)).success, true);
  assert.equal(
    canonicalSha256DigestSchema.safeParse(
      `sha256:${"abcdef0123456789".repeat(4)}`,
    ).success,
    true,
  );

  const wrongLength = [
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`,
    `sha256:${"a".repeat(64)}b`,
  ];
  for (const value of wrongLength) {
    assert.equal(
      canonicalSha256DigestSchema.safeParse(value).success,
      false,
      value,
    );
  }

  const wrongPrefix = [
    `sha512:${"a".repeat(64)}`,
    `SHA256:${"a".repeat(64)}`,
    `sha256-${"a".repeat(64)}`,
    "a".repeat(64),
  ];
  for (const value of wrongPrefix) {
    assert.equal(
      canonicalSha256DigestSchema.safeParse(value).success,
      false,
      value,
    );
  }

  assert.equal(
    canonicalSha256DigestSchema.safeParse(`sha256:${"A".repeat(64)}`).success,
    false,
  );
});

test("generateRecommendationRequestSchema accepts a well-formed request and rejects malformed input", () => {
  const parsed: GenerateRecommendationRequest =
    generateRecommendationRequestSchema.parse(validGenerateRequest());
  assert.equal(parsed.suggestedDishCount, 1);
  assert.deepEqual(parsed.participantProfileIds, [ids.profile]);

  const rejected = [
    { ...validGenerateRequest(), participantProfileIds: [] },
    { ...validGenerateRequest(), maximumTotalMinutes: 0 },
    { ...validGenerateRequest(), suggestedDishCount: 4 },
    { ...validGenerateRequest(), purchaseTolerance: "anything" },
    { ...validGenerateRequest(), householdId: ids.household },
    {
      participantProfileIds: [ids.profile],
      cookProfileId: ids.profile,
    },
  ];
  for (const value of rejected) {
    assert.equal(
      generateRecommendationRequestSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
  }
});

test("generateRecommendationRequestSchema enforces the registered participant-uniqueness refinement", () => {
  const duplicated = generateRecommendationRequestSchema.safeParse({
    ...validGenerateRequest(),
    participantProfileIds: [ids.profile, ids.profile],
  });
  assert.equal(duplicated.success, false);
  if (duplicated.success) return;
  assert.ok(
    duplicated.error.issues.some(
      (issue) =>
        issue.message === "recommendation request participants must be unique",
    ),
    "the uniqueness refinement, not a shape rule, must be the failing check",
  );

  assert.equal(
    generateRecommendationRequestSchema.safeParse({
      ...validGenerateRequest(),
      participantProfileIds: [ids.profile, ids.profile2],
    }).success,
    true,
  );
});

test("createMealRequestSchema accepts a well-formed request and rejects malformed input", () => {
  const parsed: CreateMealRequest = createMealRequestSchema.parse(
    validCreateMealRequest(),
  );
  assert.equal(parsed.expectedSnapshotDigest, digest(7));
  assert.equal(parsed.recipes.length, 1);

  const rejected = [
    { ...validCreateMealRequest(), recipes: [] },
    { ...validCreateMealRequest(), scheduledFor: "2026-07-23" },
    {
      ...validCreateMealRequest(),
      expectedSnapshotDigest: `sha256:${"a".repeat(63)}`,
    },
    { ...validCreateMealRequest(), expectedSnapshotDigest: "not-a-digest" },
    { ...validCreateMealRequest(), unexpectedField: true },
  ];
  for (const value of rejected) {
    assert.equal(
      createMealRequestSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
  }
});

test("createMealRequestSchema enforces the registered participant-uniqueness refinement", () => {
  const duplicated = createMealRequestSchema.safeParse({
    ...validCreateMealRequest(),
    participantProfileIds: [ids.profile, ids.profile],
  });
  assert.equal(duplicated.success, false);
  if (duplicated.success) return;
  assert.ok(
    duplicated.error.issues.some(
      (issue) => issue.message === "meal request participants must be unique",
    ),
    "the uniqueness refinement, not a shape rule, must be the failing check",
  );

  assert.equal(
    createMealRequestSchema.safeParse({
      ...validCreateMealRequest(),
      participantProfileIds: [ids.profile, ids.profile2],
    }).success,
    true,
  );
});

test("recommendationSnapshotSchema requires all four segments plus the covering digest", () => {
  assert.equal(recommendationSnapshotSchema.safeParse(validSnapshot()).success, true);

  for (const segment of [
    "inventory",
    "constraints",
    "recipes",
    "policies",
    "snapshotDigest",
  ] as const) {
    const withoutSegment: Record<string, unknown> = { ...validSnapshot() };
    delete withoutSegment[segment];
    assert.equal(
      recommendationSnapshotSchema.safeParse(withoutSegment).success,
      false,
      `a snapshot without ${segment} must be rejected`,
    );
  }

  assert.equal(
    recommendationSnapshotSchema.safeParse({
      ...validSnapshot(),
      snapshotDigest: "sha256:missing",
    }).success,
    false,
  );
});

test("recommendation and meal success envelopes hold the documented shape and are reachable from the package entry", () => {
  assert.equal(typeof recommendationSuccessSchema.parse, "function");
  assert.equal(typeof mealSuccessSchema.parse, "function");

  assert.equal(
    recommendationSuccessSchema.parse({
      ok: true,
      data: validRecommendation(),
      meta: { requestId },
    }).data.id,
    ids.recommendation,
  );
  assert.equal(
    mealSuccessSchema.parse({
      ok: true,
      data: validMeal(),
      meta: { requestId },
    }).data.id,
    ids.meal,
  );

  const rejected = [
    { ok: false, data: validRecommendation(), meta: { requestId } },
    { ok: true, data: validRecommendation() },
    { ok: true, data: { ...validRecommendation(), status: "extra" }, meta: { requestId } },
  ];
  for (const value of rejected) {
    assert.equal(
      recommendationSuccessSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
  }
  assert.equal(
    mealSuccessSchema.safeParse({
      ok: true,
      data: validMeal(),
      meta: { requestId: "not-a-request-id" },
    }).success,
    false,
  );
});

test("the recommendation success envelope round-trips through JSON without loss", () => {
  const envelope = recommendationSuccessSchema.parse({
    ok: true,
    data: validRecommendation(),
    meta: { requestId },
  });
  const reparsed = recommendationSuccessSchema.parse(
    JSON.parse(JSON.stringify(envelope)),
  );
  assert.deepEqual(reparsed, envelope);
});
