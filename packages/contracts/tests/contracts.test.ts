import assert from "node:assert/strict";
import test from "node:test";

import {
  apiErrorSchema,
  authenticatedSessionSchema,
  authIdentitySchema,
  consumeInventoryLotRequestSchema,
  consumeInventoryLotResultSchema,
  createApiResultSchema,
  createApiSuccessSchema,
  createHouseholdRequestSchema,
  createHouseholdResultSchema,
  createInventoryLotRequestSchema,
  createInventoryLotResultSchema,
  createPaginatedDataSchema,
  dietaryConstraintSchema,
  exactQuantityAmountSchema,
  householdSchema,
  idempotencyKeySchema,
  inventoryEventSchema,
  inventoryLotSchema,
  mealSchema,
  membershipSchema,
  personProfileSchema,
  quantityDecimalMax,
  recipeSchema,
  recommendationSchema,
  sessionSchema,
  shoppingItemSchema,
  userSchema,
} from "../src/index.js";

const ids = {
  user: "018f0000-0000-7000-8000-000000000001",
  user2: "018f0000-0000-7000-8000-000000000017",
  identity: "018f0000-0000-7000-8000-000000000002",
  session: "018f0000-0000-7000-8000-000000000003",
  household: "018f0000-0000-7000-8000-000000000004",
  household2: "018f0000-0000-7000-8000-000000000018",
  membership: "018f0000-0000-7000-8000-000000000005",
  profile: "018f0000-0000-7000-8000-000000000006",
  food: "018f0000-0000-7000-8000-000000000007",
  lot: "018f0000-0000-7000-8000-000000000008",
  event: "018f0000-0000-7000-8000-000000000009",
  recipe: "018f0000-0000-7000-8000-000000000010",
  meal: "018f0000-0000-7000-8000-000000000011",
  recommendation: "018f0000-0000-7000-8000-000000000012",
  candidate: "018f0000-0000-7000-8000-000000000013",
  shoppingItem: "018f0000-0000-7000-8000-000000000014",
  request: "018f0000-0000-7000-8000-000000000015",
  constraint: "018f0000-0000-7000-8000-000000000016",
} as const;

const now = "2026-07-23T12:00:00Z";
const accessToken = "a".repeat(43);

test("identity, household, membership and profile contracts compose without using provider identity as a user key", () => {
  const user = userSchema.parse({
    id: ids.user,
    status: "active",
    displayName: "家庭成员",
    locale: "zh-CN",
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
  const identity = authIdentitySchema.parse({
    id: ids.identity,
    userId: user.id,
    provider: "wechat_miniprogram",
    providerTenantKey: "test-app",
    providerSubject: "opaque-open-id",
    status: "active",
    createdAt: now,
    lastAuthenticatedAt: now,
  });
  const session = sessionSchema.parse({
    id: ids.session,
    userId: user.id,
    authIdentityId: identity.id,
    status: "active",
    issuedAt: now,
    expiresAt: "2026-08-22T12:00:00Z",
    lastSeenAt: now,
    tokenVersion: 1,
  });
  const household = householdSchema.parse({
    id: ids.household,
    name: "测试家庭",
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    status: "active",
    createdByUserId: user.id,
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
  const membership = membershipSchema.parse({
    id: ids.membership,
    householdId: household.id,
    userId: user.id,
    role: "owner",
    capabilities: [],
    status: "active",
    joinedAt: now,
    updatedAt: now,
    version: 0,
  });
  const profile = personProfileSchema.parse({
    id: ids.profile,
    householdId: household.id,
    linkedMembershipId: membership.id,
    displayName: "主要做饭者",
    status: "active",
    defaultParticipation: true,
    defaultPortionScale: 1,
    cookingSkill: "beginner",
    dietaryConstraints: [
      {
        id: ids.constraint,
        kind: "allergy",
        enforcement: "hard",
        label: "花生过敏",
        foodConceptIds: [],
        allergenCodes: ["PEANUT"],
        visibility: "subject_and_owner",
        confirmedAt: now,
        confirmedByUserId: user.id,
      },
    ],
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
  const safeOwnerProfile = {
    ...profile,
    dietaryConstraints: [],
  };

  assert.equal(identity.userId, user.id);
  assert.equal(session.userId, user.id);
  assert.equal(membership.householdId, profile.householdId);
  assert.equal(
    createHouseholdResultSchema.safeParse({
      household,
      membership,
      ownerProfile: safeOwnerProfile,
    }).success,
    true,
  );
  assert.equal(
    createHouseholdResultSchema.safeParse({
      household,
      membership,
      ownerProfile: {
        ...safeOwnerProfile,
        householdId: ids.household2,
      },
    }).success,
    false,
  );
  assert.equal(
    createHouseholdResultSchema.safeParse({
      household,
      membership,
      ownerProfile: profile,
    }).success,
    false,
  );
  assert.equal(
    sessionSchema.safeParse({
      ...session,
      status: "revoked",
    }).success,
    false,
  );
  assert.equal(
    sessionSchema.safeParse({
      ...session,
      expiresAt: session.issuedAt,
    }).success,
    false,
  );

  assert.equal(
    createHouseholdRequestSchema.safeParse({
      name: "新家庭",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      ownerProfile: {
        displayName: "创建者",
        defaultPortionScale: 1,
        cookingSkill: "beginner",
      },
      createdByUserId: ids.user,
    }).success,
    false,
  );
});

test("authenticated sessions require matching active session and user records", () => {
  const user = {
    id: ids.user,
    status: "active",
    locale: "zh-CN",
    createdAt: now,
    updatedAt: now,
    version: 0,
  } as const;
  const session = {
    id: ids.session,
    userId: ids.user,
    authIdentityId: ids.identity,
    status: "active",
    issuedAt: now,
    expiresAt: "2026-08-22T12:00:00Z",
    lastSeenAt: now,
    tokenVersion: 1,
  } as const;
  const authenticatedSession = {
    accessToken,
    session,
    user,
  };

  assert.equal(
    authenticatedSessionSchema.safeParse(authenticatedSession).success,
    true,
  );
  assert.equal(
    authenticatedSessionSchema.safeParse({
      ...authenticatedSession,
      user: { ...user, status: "disabled" },
    }).success,
    false,
  );
  assert.equal(
    authenticatedSessionSchema.safeParse({
      ...authenticatedSession,
      session: { ...session, status: "expired" },
    }).success,
    false,
  );
  assert.equal(
    authenticatedSessionSchema.safeParse({
      ...authenticatedSession,
      session: { ...session, userId: ids.user2 },
    }).success,
    false,
  );
});

test("hard constraints cannot be downgraded to soft preferences", () => {
  const result = dietaryConstraintSchema.safeParse({
    id: ids.constraint,
    kind: "allergy",
    enforcement: "soft",
    label: "花生过敏",
    preference: "dislike",
    foodConceptIds: [],
    visibility: "household",
    confirmedAt: now,
    confirmedByUserId: ids.user,
  });

  assert.equal(result.success, false);
  assert.equal(
    dietaryConstraintSchema.safeParse({
      id: ids.constraint,
      kind: "allergy",
      enforcement: "hard",
      label: "未结构化过敏",
      foodConceptIds: [],
      allergenCodes: [],
      visibility: "household",
      confirmedAt: now,
      confirmedByUserId: ids.user,
    }).success,
    false,
  );
});

test("inventory lots preserve date provenance and events enforce append-only version semantics", () => {
  const createRequest = createInventoryLotRequestSchema.parse({
    foodConceptId: ids.food,
    displayName: "豆腐",
    storageLocation: "refrigerated",
    initialQuantity: {
      kind: "approximate",
      amount: 0.5,
      unit: "box",
      originalText: "半盒",
      confidence: "medium",
    },
    dates: [
      {
        kind: "purchase_date",
        value: "2026-07-22",
        source: {
          kind: "user_input",
          confidence: "high",
        },
      },
    ],
  });
  const lot = inventoryLotSchema.parse({
    id: ids.lot,
    householdId: ids.household,
    foodConceptId: ids.food,
    displayName: "豆腐",
    state: "active",
    storageLocation: "refrigerated",
    currentQuantity: {
      kind: "approximate",
      amount: 0.5,
      unit: "box",
      originalText: "半盒",
      confidence: "medium",
    },
    dates: [
      {
        kind: "purchase_date",
        value: "2026-07-22",
        source: {
          kind: "user_input",
          confidence: "high",
          capturedAt: now,
          confirmedByUserId: ids.user,
        },
      },
      {
        kind: "estimated_use_by_date",
        value: "2026-07-25",
        source: {
          kind: "verified_rule",
          confidence: "medium",
          ruleVersion: "food-date-cn-1",
          capturedAt: now,
        },
      },
    ],
    safetyAssessment: {
      status: "eligible",
      reasonCodes: [],
      policyVersion: "food-safety-1",
      evaluatedAt: now,
    },
    origin: "manual",
    createdByUserId: ids.user,
    createdAt: now,
    updatedAt: now,
    version: 2,
  });
  const event = inventoryEventSchema.parse({
    id: ids.event,
    householdId: lot.householdId,
    inventoryLotId: lot.id,
    type: "consumed",
    quantityChange: {
      kind: "numeric",
      amount: -0.5,
      unit: "box",
      precision: "estimated",
      confidence: "medium",
      originalText: "用了半盒",
    },
    actorUserId: ids.user,
    source: "meal_completion_confirmation",
    occurredAt: now,
    recordedAt: now,
    idempotencyKey: "meal-complete:018f00000001",
    expectedLotVersion: 2,
    resultingLotVersion: 3,
  });

  assert.equal(event.resultingLotVersion, lot.version + 1);
  assert.equal(lot.dates[0]?.kind, "purchase_date");
  assert.equal(createRequest.dates[0]?.kind, "purchase_date");
  assert.equal(
    inventoryLotSchema.safeParse({
      ...lot,
      currentQuantity: { kind: "exact", amount: "0", unit: "box" },
    }).success,
    false,
  );
  assert.equal(
    inventoryLotSchema.safeParse({
      ...lot,
      state: "depleted",
      currentQuantity: { kind: "exact", amount: "0", unit: "box" },
    }).success,
    true,
  );
  assert.equal(
    inventoryLotSchema.safeParse({
      ...lot,
      safetyAssessment: {
        ...lot.safetyAssessment,
        status: "blocked",
        reasonCodes: [],
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      initialQuantity: { kind: "exact", amount: "0", unit: "box" },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      initialQuantity: {
        kind: "exact",
        amount: "1",
        unit: "box",
      },
    }).success,
    true,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      initialQuantity: {
        kind: "approximate",
        originalText: "半盒",
        confidence: "medium",
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      initialQuantity: {
        kind: "approximate",
        amount: 0.5,
        unit: "box",
        originalText: "半盒",
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      initialQuantity: {
        kind: "approximate",
        amount: 0.5,
        unit: "box",
        confidence: "medium",
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      initialQuantity: {
        kind: "approximate",
        amount: 0.5,
        originalText: "半盒",
        confidence: "medium",
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      initialQuantity: {
        kind: "qualitative",
        originalText: "还有一些",
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      initialQuantity: {
        kind: "approximate",
        unit: "box",
        originalText: "半盒",
        confidence: "medium",
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      initialQuantity: {
        kind: "qualitative",
        level: "some",
        originalText: "还有一些",
      },
    }).success,
    true,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      initialQuantity: {
        kind: "qualitative",
        level: "empty",
        originalText: "没有了",
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      dates: [createRequest.dates[0], createRequest.dates[0]],
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      dates: Array.from({ length: 5 }, () => createRequest.dates[0]),
    }).success,
    false,
  );
  assert.equal(
    inventoryLotSchema.safeParse({
      ...lot,
      dates: [...lot.dates, lot.dates[0]],
    }).success,
    false,
  );
  assert.equal(
    inventoryLotSchema.safeParse({
      ...lot,
      dates: Array.from({ length: 10 }, () => lot.dates[0]),
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotRequestSchema.safeParse({
      ...createRequest,
      dates: [
        {
          kind: "purchase_date",
          value: "2026-07-22",
          source: { kind: "package_label", confidence: "high" },
        },
      ],
    }).success,
    false,
  );

  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      quantityChange: { ...event.quantityChange, amount: 0.5 },
    }).success,
    false,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      quantityChange: {
        kind: "numeric",
        amount: -0.5,
        unit: "box",
        precision: "estimated",
        originalText: "用了半盒",
      },
    }).success,
    false,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      quantityChange: {
        kind: "numeric",
        amount: -0.5,
        unit: "box",
        precision: "estimated",
        confidence: "medium",
      },
    }).success,
    false,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      quantityChange: {
        kind: "numeric",
        amount: "-0.5",
        unit: "box",
        precision: "exact",
        confidence: "medium",
        originalText: "用了半盒",
      },
    }).success,
    false,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      type: "consumed",
      quantityChange: {
        kind: "qualitative",
        fromLevel: "low",
        toLevel: "plenty",
      },
    }).success,
    false,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      id: ids.event,
      type: "corrected",
      correctionOfEventId: ids.event,
      quantityChange: {
        kind: "numeric",
        amount: 0.25,
        unit: "box",
        precision: "estimated",
        confidence: "medium",
        originalText: "修正为四分之一盒",
      },
    }).success,
    false,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      correctionOfEventId: ids.event,
    }).success,
    false,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      type: "moved",
      quantityChange: undefined,
      fromStorageLocation: "refrigerated",
      toStorageLocation: "pantry",
    }).success,
    true,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      type: "frozen",
      quantityChange: undefined,
      fromStorageLocation: "refrigerated",
      toStorageLocation: "pantry",
    }).success,
    false,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      type: "discarded",
      quantityChange: {
        kind: "qualitative",
        fromLevel: "some",
        toLevel: "low",
      },
    }).success,
    false,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      type: "opened",
      quantityChange: {
        kind: "qualitative",
        fromLevel: "some",
        toLevel: "low",
      },
    }).success,
    false,
  );
  assert.equal(
    inventoryEventSchema.safeParse({
      ...event,
      resultingLotVersion: 4,
    }).success,
    false,
  );
});

test("inventory create and consume results keep lot, event, household and versions aligned", () => {
  const initialLot = {
    id: ids.lot,
    householdId: ids.household,
    foodConceptId: ids.food,
    displayName: "豆腐",
    state: "active",
    storageLocation: "refrigerated",
    currentQuantity: {
      kind: "exact",
      amount: "2",
      unit: "box",
    },
    dates: [],
    safetyAssessment: {
      status: "eligible",
      reasonCodes: [],
      policyVersion: "food-safety-1",
      evaluatedAt: now,
    },
    origin: "manual",
    createdByUserId: ids.user,
    createdAt: now,
    updatedAt: now,
    version: 1,
  } as const;
  const initialEvent = {
    id: ids.event,
    householdId: ids.household,
    inventoryLotId: ids.lot,
    type: "acquired",
    quantityChange: {
      kind: "numeric",
      amount: "2",
      unit: "box",
      precision: "exact",
    },
    actorUserId: ids.user,
    source: "manual_confirmation",
    occurredAt: now,
    recordedAt: now,
    idempotencyKey: "inventory-add:018f00000001",
    expectedLotVersion: 0,
    resultingLotVersion: 1,
  } as const;
  const created = { lot: initialLot, event: initialEvent };

  assert.equal(createInventoryLotResultSchema.safeParse(created).success, true);
  assert.equal(
    createInventoryLotResultSchema.safeParse({
      ...created,
      event: { ...initialEvent, householdId: ids.household2 },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotResultSchema.safeParse({
      ...created,
      event: {
        ...initialEvent,
        inventoryLotId: "018f0000-0000-7000-8000-000000000019",
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotResultSchema.safeParse({
      lot: { ...initialLot, version: 2 },
      event: {
        ...initialEvent,
        expectedLotVersion: 1,
        resultingLotVersion: 2,
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotResultSchema.safeParse({
      ...created,
      event: { ...initialEvent, type: "produced" },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotResultSchema.safeParse({
      ...created,
      event: {
        ...initialEvent,
        quantityChange: { ...initialEvent.quantityChange, amount: "3" },
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotResultSchema.safeParse({
      ...created,
      event: {
        ...initialEvent,
        quantityChange: { ...initialEvent.quantityChange, unit: "kg" },
      },
    }).success,
    false,
  );
  assert.equal(
    createInventoryLotResultSchema.safeParse({
      ...created,
      event: {
        ...initialEvent,
        quantityChange: {
          kind: "qualitative",
          fromLevel: "empty",
          toLevel: "some",
        },
      },
    }).success,
    false,
  );

  const approximateCreated = {
    lot: {
      ...initialLot,
      currentQuantity: {
        kind: "approximate",
        amount: 0.5,
        unit: "box",
        originalText: "半盒",
        confidence: "medium",
      },
    },
    event: {
      ...initialEvent,
      quantityChange: {
        kind: "numeric",
        amount: 0.5,
        unit: "box",
        precision: "estimated",
        confidence: "medium",
        originalText: "半盒",
      },
    },
  } as const;
  assert.equal(
    createInventoryLotResultSchema.safeParse(approximateCreated).success,
    true,
  );
  assert.equal(
    createInventoryLotResultSchema.safeParse({
      lot: {
        ...approximateCreated.lot,
        currentQuantity: {
          kind: "approximate",
          originalText: "约半盒",
          confidence: "low",
        },
      },
      event: {
        ...approximateCreated.event,
        quantityChange: {
          kind: "qualitative",
          fromLevel: "empty",
          toLevel: "unknown",
          originalText: "约半盒",
        },
      },
    }).success,
    false,
  );

  const qualitativeCreated = {
    lot: {
      ...initialLot,
      currentQuantity: {
        kind: "qualitative",
        level: "some",
        originalText: "还有一些",
      },
    },
    event: {
      ...initialEvent,
      quantityChange: {
        kind: "qualitative",
        fromLevel: "empty",
        toLevel: "some",
        originalText: "还有一些",
      },
    },
  } as const;
  assert.equal(
    createInventoryLotResultSchema.safeParse(qualitativeCreated).success,
    true,
  );

  const consumeRequest = consumeInventoryLotRequestSchema.parse({
    consumedQuantity: {
      kind: "exact",
      amount: "1",
      unit: "box",
    },
    expectedVersion: 1,
  });
  const consumed = {
    lot: {
      ...initialLot,
      currentQuantity: { kind: "exact", amount: "1", unit: "box" },
      updatedAt: "2026-07-23T12:01:00Z",
      version: 2,
    },
    event: {
      ...initialEvent,
      type: "consumed",
      quantityChange: {
        kind: "numeric",
        amount: `-${consumeRequest.consumedQuantity.amount}`,
        unit: consumeRequest.consumedQuantity.unit,
        precision: "exact",
      },
      source: "manual_confirmation",
      occurredAt: "2026-07-23T12:01:00Z",
      recordedAt: "2026-07-23T12:01:00Z",
      idempotencyKey: "inventory-consume:018f0001",
      expectedLotVersion: consumeRequest.expectedVersion,
      resultingLotVersion: 2,
    },
  } as const;

  assert.equal(
    consumeInventoryLotResultSchema.safeParse(consumed).success,
    true,
  );
  assert.equal(
    consumeInventoryLotResultSchema.safeParse({
      ...consumed,
      lot: {
        ...consumed.lot,
        currentQuantity: {
          kind: "approximate",
          amount: 1,
          unit: "box",
          confidence: "medium",
          originalText: "约一盒",
        },
      },
    }).success,
    false,
  );
  assert.equal(
    consumeInventoryLotResultSchema.safeParse({
      ...consumed,
      lot: {
        ...consumed.lot,
        currentQuantity: {
          kind: "qualitative",
          level: "some",
          originalText: "还有一些",
        },
      },
    }).success,
    false,
  );
  assert.equal(
    consumeInventoryLotResultSchema.safeParse({
      ...consumed,
      event: {
        ...consumed.event,
        quantityChange: {
          ...consumed.event.quantityChange,
          unit: "kg",
        },
      },
    }).success,
    false,
  );
  for (const source of [
    "meal_completion_confirmation",
    "confirmed_recognition",
    "administrative_recovery",
  ] as const) {
    assert.equal(
      consumeInventoryLotResultSchema.safeParse({
        ...consumed,
        event: {
          ...consumed.event,
          source,
        },
      }).success,
      false,
    );
  }
  assert.equal(
    consumeInventoryLotResultSchema.safeParse({
      ...consumed,
      lot: {
        ...consumed.lot,
        state: "depleted",
        currentQuantity: {
          kind: "exact",
          amount: "0",
          unit: "box",
        },
      },
    }).success,
    true,
  );
  assert.equal(
    consumeInventoryLotRequestSchema.safeParse({
      ...consumeRequest,
      consumedQuantity: {
        ...consumeRequest.consumedQuantity,
        amount: "-1",
      },
    }).success,
    false,
  );
  assert.equal(
    consumeInventoryLotRequestSchema.safeParse({
      ...consumeRequest,
      consumedQuantity: {
        ...consumeRequest.consumedQuantity,
        amount: "0.123456",
      },
    }).success,
    true,
  );
  for (const amount of [
    "0.000001",
    "999999999.999998",
    quantityDecimalMax,
  ]) {
    assert.equal(exactQuantityAmountSchema.safeParse(amount).success, true);
  }
  assert.equal(exactQuantityAmountSchema.parse("1.000000"), "1");
  assert.equal(exactQuantityAmountSchema.parse("0.100000"), "0.1");
  assert.equal(exactQuantityAmountSchema.safeParse(1).success, false);
  assert.equal(
    consumeInventoryLotRequestSchema.safeParse({
      ...consumeRequest,
      consumedQuantity: {
        ...consumeRequest.consumedQuantity,
        amount: "0.1234567",
      },
    }).success,
    false,
  );
  for (const amount of [
    "0.0000001",
    "999999999.9999991",
    "900000000.00000001",
    "1e-6",
  ]) {
    assert.equal(exactQuantityAmountSchema.safeParse(amount).success, false);
  }
  assert.equal(
    consumeInventoryLotRequestSchema.safeParse({
      ...consumeRequest,
      consumedQuantity: {
        ...consumeRequest.consumedQuantity,
        amount: "1000000000",
      },
    }).success,
    false,
  );
  assert.equal(
    consumeInventoryLotRequestSchema.safeParse({
      ...consumeRequest,
      consumedQuantity: {
        kind: "approximate",
        amount: 1,
        unit: "box",
        confidence: "medium",
        originalText: "约一盒",
      },
    }).success,
    false,
  );
  assert.equal(
    consumeInventoryLotRequestSchema.safeParse({
      ...consumeRequest,
      consumedQuantity: {
        ...consumeRequest.consumedQuantity,
        precision: "estimated",
      },
    }).success,
    false,
  );
  assert.equal(
    consumeInventoryLotResultSchema.safeParse({
      ...consumed,
      event: { ...consumed.event, type: "adjusted" },
    }).success,
    false,
  );
  const estimatedConsumedEvent = {
    ...consumed.event,
    quantityChange: {
      kind: "numeric",
      amount: -1,
      unit: "box",
      precision: "estimated",
      confidence: "medium",
      originalText: "约一盒",
    },
  } as const;
  assert.equal(
    inventoryEventSchema.safeParse(estimatedConsumedEvent).success,
    true,
  );
  assert.equal(
    consumeInventoryLotResultSchema.safeParse({
      ...consumed,
      event: estimatedConsumedEvent,
    }).success,
    false,
  );
});

test("meal, recipe and recommendation contracts only expose validated candidates", () => {
  const recipe = recipeSchema.parse({
    id: ids.recipe,
    version: 1,
    status: "reviewed",
    title: "番茄炒蛋",
    servings: 2,
    dishRole: "main",
    ingredients: [
      {
        foodConceptId: ids.food,
        displayName: "番茄",
        quantity: { kind: "exact", amount: "2", unit: "piece" },
        optional: false,
        allergenCodes: [],
        mayContainAllergenCodes: [],
      },
    ],
    steps: [{ order: 1, instruction: "按审核步骤烹饪。" }],
    requiredEquipment: ["wok"],
    activeMinutes: 10,
    totalMinutes: 15,
    difficulty: "beginner",
    source: {
      name: "内部审核菜谱",
      licenseStatus: "internal_original",
      licenseReference: "content-policy-v1",
      retrievedAt: now,
    },
    reviewedAt: now,
  });
  const recommendation = recommendationSchema.parse({
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
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        servings: 2,
        dishRole: recipe.dishRole,
        activeMinutes: recipe.activeMinutes,
        totalMinutes: recipe.totalMinutes,
        missingFoodConceptIds: [],
        plannedInventoryLotIds: [ids.lot],
        reasonCodes: ["USES_AVAILABLE_INGREDIENT"],
        assumptions: ["仅基于已确认库存"],
        hardConstraintCheck: {
          status: "passed",
          policyVersion: "constraint-policy-1",
          checkedAt: now,
        },
      },
    ],
    preselectedCandidateIds: [ids.candidate],
    blockerCodes: [],
    assumptions: ["未录入的食材保持未知"],
    inventorySnapshotVersion: 2,
    constraintSnapshotVersion: 1,
    recommendationPolicyVersion: "recommendation-policy-1",
    createdAt: now,
    expiresAt: "2026-07-23T12:10:00Z",
  });
  const meal = mealSchema.parse({
    id: ids.meal,
    householdId: ids.household,
    recommendationId: recommendation.id,
    participantProfileIds: [ids.profile],
    cookProfileId: ids.profile,
    recipes: [
      {
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        servings: 2,
      },
    ],
    status: "confirmed",
    scheduledFor: now,
    createdAt: now,
    updatedAt: now,
    version: 0,
  });

  assert.equal(meal.recipes.length, 1);
  assert.equal(recommendation.candidates[0]?.hardConstraintCheck.status, "passed");

  assert.equal(
    recommendationSchema.safeParse({
      ...recommendation,
      outcome: "no_feasible_option",
      blockerCodes: [],
    }).success,
    false,
  );
  assert.equal(
    recommendationSchema.safeParse({
      ...recommendation,
      blockerCodes: ["HARD_CONSTRAINT"],
    }).success,
    false,
  );
  assert.equal(
    recommendationSchema.safeParse({
      ...recommendation,
      suggestedDishCount: 2,
    }).success,
    false,
  );
});

test("shopping state keeps purchase separate from confirmed inventory", () => {
  const pending = shoppingItemSchema.parse({
    id: ids.shoppingItem,
    householdId: ids.household,
    foodConceptId: ids.food,
    displayName: "番茄",
    requestedQuantity: { kind: "approximate", originalText: "一袋", confidence: "low" },
    status: "purchased_pending_inventory",
    sources: [{ kind: "manual", addedByUserId: ids.user }],
    inventoryLotIds: [],
    lastChangedByUserId: ids.user,
    purchasedAt: now,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });

  assert.equal(pending.purchasedQuantity, undefined);
  assert.equal(
    shoppingItemSchema.safeParse({
      ...pending,
      inventoryLotIds: [ids.lot],
    }).success,
    false,
  );
  assert.equal(
    shoppingItemSchema.safeParse({
      ...pending,
      status: "to_buy",
    }).success,
    false,
  );
  assert.equal(
    shoppingItemSchema.safeParse({
      ...pending,
      status: "to_buy",
      inventoryLotIds: [ids.lot],
      purchasedAt: undefined,
    }).success,
    false,
  );
});

test("API result, error, pagination and idempotency schemas have stable semantics", () => {
  const key = idempotencyKeySchema.parse("inventory-add:018f00000001");
  const successSchema = createApiSuccessSchema(
    createPaginatedDataSchema(userSchema),
  );
  const resultSchema = createApiResultSchema(
    createPaginatedDataSchema(userSchema),
  );
  const success = successSchema.parse({
    ok: true,
    data: {
      items: [
        {
          id: ids.user,
          status: "active",
          locale: "zh-CN",
          createdAt: now,
          updatedAt: now,
          version: 0,
        },
      ],
      pageInfo: {
        nextCursor: null,
        hasMore: false,
      },
    },
    meta: {
      requestId: ids.request,
      idempotency: {
        key,
        scope: "household",
        replayed: false,
        firstProcessedAt: now,
        originalRequestId: ids.request,
      },
    },
  });
  const error = apiErrorSchema.parse({
    ok: false,
    type: "https://api.meal-agent.invalid/problems/inventory-version-conflict",
    title: "库存已被其他成员修改",
    status: 409,
    code: "INVENTORY_VERSION_CONFLICT",
    requestId: ids.request,
    retryable: true,
  });

  assert.equal(success.ok, true);
  assert.equal(error.status, 409);
  assert.equal(resultSchema.safeParse(success).success, true);
  assert.equal(resultSchema.safeParse(error).success, true);
  assert.equal(
    apiErrorSchema.safeParse({ ...error, status: 500 }).success,
    false,
  );
  assert.equal(idempotencyKeySchema.safeParse("short").success, false);
  assert.equal(
    resultSchema.safeParse({
      ...success,
      data: {
        ...success.data,
        pageInfo: { nextCursor: null, hasMore: true },
      },
    }).success,
    false,
  );
  assert.equal(
    resultSchema.safeParse({
      ...success,
      data: {
        ...success.data,
        pageInfo: { nextCursor: "next_cursor", hasMore: false },
      },
    }).success,
    false,
  );

  const createHouseholdSuccessSchema = createApiSuccessSchema(
    createHouseholdResultSchema,
  );
  const firstHouseholdResult = createHouseholdSuccessSchema.parse({
    ok: true,
    data: {
      household: {
        id: ids.household,
        name: "新家庭",
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
        status: "active",
        createdByUserId: ids.user,
        createdAt: now,
        updatedAt: now,
        version: 0,
      },
      membership: {
        id: ids.membership,
        householdId: ids.household,
        userId: ids.user,
        role: "owner",
        capabilities: [],
        status: "active",
        joinedAt: now,
        updatedAt: now,
        version: 0,
      },
      ownerProfile: {
        id: ids.profile,
        householdId: ids.household,
        linkedMembershipId: ids.membership,
        displayName: "创建者",
        status: "active",
        defaultParticipation: true,
        defaultPortionScale: 1,
        cookingSkill: "beginner",
        dietaryConstraints: [],
        createdAt: now,
        updatedAt: now,
        version: 0,
      },
    },
    meta: {
      requestId: ids.request,
      idempotency: {
        key: "household-create:018f0001",
        scope: "user",
        replayed: true,
        firstProcessedAt: now,
        originalRequestId: ids.request,
      },
    },
  });
  assert.equal(firstHouseholdResult.data.household.id, ids.household);
  assert.equal(firstHouseholdResult.meta.idempotency?.scope, "user");
  assert.equal(firstHouseholdResult.meta.idempotency?.replayed, true);
});

test("contracts reject undeclared fields at trust boundaries", () => {
  const result = householdSchema.safeParse({
    id: ids.household,
    name: "测试家庭",
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    status: "active",
    createdByUserId: ids.user,
    createdAt: now,
    updatedAt: now,
    version: 0,
    providerSubject: "must-not-leak",
  });

  assert.equal(result.success, false);
});
