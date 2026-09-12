import assert from "node:assert/strict";
import test from "node:test";

import { apiErrorSchema, requestIdSchema } from "@meal-agent/contracts";
import type { IdempotencyKey } from "@meal-agent/contracts/api";
import {
  mealSchema,
  recommendationSchema,
  type Meal,
  type Recommendation,
} from "@meal-agent/contracts/meals";

import { buildApp, type BuildAppOptions } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

/**
 * 冻结 §3.3 / §8.3：受约束家庭得到的是 **201 + `ok: true` +
 * `outcome: "no_feasible_option"`**，**不是** 4xx。阻断是正确结果，不是错误屏幕。
 * 同时覆盖两条写路由的幂等头要求与成功信封（§3.5）。
 */

const ids = {
  household: "018f0000-0000-7000-8000-000000000004",
  profile: "018f0000-0000-7000-8000-000000000006",
  lot: "018f0000-0000-7000-8000-000000000008",
  recipe: "018f0000-0000-7000-8000-000000000010",
  meal: "018f0000-0000-7000-8000-000000000011",
  recommendation: "018f0000-0000-7000-8000-000000000012",
} as const;
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const now = "2026-07-23T12:00:00Z";
const token = "t".repeat(43);
const digest = (seed: number): string =>
  `sha256:${seed.toString(16).padStart(64, "0")}`;

const snapshot = {
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
    mappingReleaseId: "synthetic-m4a-constraint-mapping-v1",
    constraintDigest: digest(3),
  },
  recipes: {
    recipes: [
      {
        recipeId: ids.recipe,
        recipeVersion: 1,
        contentDigest: digest(4),
        datasetReleaseId: "synthetic-m4a-recipes-v1",
      },
    ],
    recipeDigest: digest(5),
  },
  policies: {
    foodConceptReleaseId: "synthetic-m4a-food-concepts-v1",
    allergenReleaseId: "synthetic-m4a-allergens-v1",
    religiousEthicalReleaseId: "synthetic-m4a-religious-ethical-v1",
    foodSafetyReleaseId: "synthetic-m4a-food-safety-v1",
    techniqueReleaseId: "synthetic-m4a-techniques-v1",
    recommendationEngineVersion: "stage09p-m4a-menu-engine-v1",
    policyDigest: digest(6),
  },
  snapshotDigest: digest(7),
};

const blockedRecommendation = (): Recommendation =>
  recommendationSchema.parse({
    id: ids.recommendation,
    householdId: ids.household,
    outcome: "no_feasible_option",
    participantProfileIds: [ids.profile],
    cookProfileId: ids.profile,
    maximumTotalMinutes: 30,
    purchaseTolerance: "none",
    suggestedDishCount: 1,
    candidates: [],
    preselectedCandidateIds: [],
    blockerCodes: ["menu.blocked.hard_constraint_allergy"],
    assumptions: [],
    snapshot,
    recommendationPolicyVersion: "stage09a-m4a-recommendation-policy-v1",
    createdAt: now,
    expiresAt: "2026-07-23T12:10:00Z",
  });

const confirmedMeal = (): Meal =>
  mealSchema.parse({
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

const idempotentMeta = (key: string) => ({
  requestId: requestIdSchema.parse(requestId),
  idempotency: {
    key: key as IdempotencyKey,
    scope: "household" as const,
    replayed: false,
    firstProcessedAt: now,
    originalRequestId: requestIdSchema.parse(requestId),
  },
});

const config = loadConfig({
  NODE_ENV: "test",
  DEPLOYMENT_STAGE: "local-test",
  DEPLOYMENT_EXPOSURE: "loopback",
  LOG_LEVEL: "silent",
  DATABASE_URL:
    "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/not-used",
  WECHAT_ADAPTER: "fake",
});

const unused = async (): Promise<never> => {
  throw new Error("operation should not be called");
};

const operations = {
  addDietaryConstraint: unused,
  confirmMeal: async (
    _token: string | undefined,
    _requestId: string,
    _householdId: string,
    idempotencyKey: string,
  ) => ({
    statusCode: 201,
    body: { ok: true as const, data: confirmedMeal(), meta: idempotentMeta(idempotencyKey) },
  }),
  confirmPersonProfileLinkRequest: unused,
  consumeInventoryLot: unused,
  createHousehold: unused,
  createHouseholdInvite: unused,
  createInventoryLot: unused,
  createPersonProfile: unused,
  createPersonProfileLinkRequest: unused,
  exchangeWechatCode: unused,
  generateRecommendation: async (
    _token: string | undefined,
    _requestId: string,
    _householdId: string,
    idempotencyKey: string,
  ) => ({
    statusCode: 201,
    body: {
      ok: true as const,
      data: blockedRecommendation(),
      meta: idempotentMeta(idempotencyKey),
    },
  }),
  getMe: unused,
  getPersonProfile: unused,
  joinHousehold: unused,
  listHouseholdInvites: unused,
  listHouseholdMembers: unused,
  listHouseholds: unused,
  listInventoryLots: unused,
  listPersonProfileLinkRequests: unused,
  listPersonProfiles: unused,
  patchPersonProfile: unused,
  removeDietaryConstraint: unused,
  removeMembership: unused,
  revokeHouseholdInvite: unused,
  revokeSession: unused,
} satisfies NonNullable<BuildAppOptions["operations"]>;

test("a blocked household receives 201 + ok:true + no_feasible_option, never a 4xx", async () => {
  const app = await buildApp({ config, operations, readiness: async () => true });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/households/${ids.household}/recommendations`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "recommendation-http-0001",
      },
      payload: {
        participantProfileIds: [ids.profile],
        cookProfileId: ids.profile,
        maximumTotalMinutes: 30,
        purchaseTolerance: "none",
        suggestedDishCount: 1,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.outcome, "no_feasible_option");
    assert.deepEqual(body.data.candidates, []);
    assert.ok(
      body.data.blockerCodes.includes("menu.blocked.hard_constraint_allergy"),
    );
  } finally {
    await app.close();
  }
});

test("the recommendations route is a contract-validated idempotent write", async () => {
  const app = await buildApp({ config, operations, readiness: async () => true });
  try {
    const missingKey = await app.inject({
      method: "POST",
      url: `/api/v1/households/${ids.household}/recommendations`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        participantProfileIds: [ids.profile],
        cookProfileId: ids.profile,
        maximumTotalMinutes: 30,
        purchaseTolerance: "none",
        suggestedDishCount: 1,
      },
    });
    assert.equal(missingKey.statusCode, 400);
    assert.equal(apiErrorSchema.parse(missingKey.json()).code, "VALIDATION_FAILED");

    const badBody = await app.inject({
      method: "POST",
      url: `/api/v1/households/${ids.household}/recommendations`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "recommendation-http-0002",
      },
      payload: {
        participantProfileIds: [],
        cookProfileId: ids.profile,
        maximumTotalMinutes: 0,
        purchaseTolerance: "none",
        suggestedDishCount: 4,
      },
    });
    assert.equal(badBody.statusCode, 400);
    assert.equal(apiErrorSchema.parse(badBody.json()).code, "VALIDATION_FAILED");
  } finally {
    await app.close();
  }
});

test("the meals route returns the meal success envelope and requires an idempotency key", async () => {
  const app = await buildApp({ config, operations, readiness: async () => true });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/households/${ids.household}/meals`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "meal-http-000001",
      },
      payload: {
        recommendationId: ids.recommendation,
        participantProfileIds: [ids.profile],
        cookProfileId: ids.profile,
        recipes: [{ recipeId: ids.recipe, recipeVersion: 1, servings: 2 }],
        scheduledFor: now,
        expectedSnapshotDigest: digest(7),
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.id, ids.meal);
    assert.equal(body.data.status, "confirmed");
  } finally {
    await app.close();
  }
});
