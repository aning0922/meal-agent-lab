import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import {
  apiErrorSchema,
  authenticatedSessionSchema,
  serviceLivenessSuccessSchema,
} from "@meal-agent/contracts";

import {
  buildApp,
  maximumRequestTargetBytes,
  type BuildAppOptions,
} from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";

const ids = {
  user: "018f0000-0000-7000-8000-000000000001",
  identity: "018f0000-0000-7000-8000-000000000002",
  session: "018f0000-0000-7000-8000-000000000003",
  household: "018f0000-0000-7000-8000-000000000004",
  lot: "018f0000-0000-7000-8000-000000000005",
} as const;
const now = "2026-07-23T12:00:00Z";
const token = "t".repeat(43);
const login = authenticatedSessionSchema.parse({
  accessToken: token,
  session: {
    id: ids.session,
    userId: ids.user,
    authIdentityId: ids.identity,
    status: "active",
    issuedAt: now,
    expiresAt: "2026-08-22T12:00:00Z",
    lastSeenAt: now,
    tokenVersion: 1,
  },
  user: {
    id: ids.user,
    status: "active",
    locale: "zh-CN",
    createdAt: now,
    updatedAt: now,
    version: 0,
  },
});

const unavailable = async (): Promise<never> => {
  throw new Error("operation should not be called");
};

const operations = {
  consumeInventoryLot: unavailable,
  createHousehold: unavailable,
  createInventoryLot: unavailable,
  exchangeWechatCode: async () => login,
  getMe: unavailable,
  listHouseholds: unavailable,
  listInventoryLots: unavailable,
  revokeSession: unavailable,
} satisfies NonNullable<BuildAppOptions["operations"]>;

const config = loadConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgresql://localhost/not-used",
  WECHAT_ADAPTER: "fake",
});

test("health and readiness use the shared success/error contracts", async () => {
  const app = await buildApp({
    config,
    operations,
    readiness: async () => false,
  });
  try {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const health = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": requestId },
    });
    assert.equal(health.statusCode, 200);
    const healthBody = serviceLivenessSuccessSchema.parse(health.json());
    assert.equal(healthBody.meta.requestId, requestId);

    const readiness = await app.inject({
      method: "GET",
      url: "/readyz",
    });
    assert.equal(readiness.statusCode, 503);
    assert.equal(readiness.headers["content-type"]?.includes(
      "application/problem+json",
    ), true);
    assert.equal(
      apiErrorSchema.parse(readiness.json()).code,
      "EXTERNAL_DEPENDENCY_UNAVAILABLE",
    );
  } finally {
    await app.close();
  }
});

test("HTTP contract rejects estimated consumed requests before a handler can write", async () => {
  const app = await buildApp({
    config,
    operations,
    readiness: async () => true,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/households/${ids.household}` +
        `/inventory-lots/${ids.lot}/events/consumed`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "consume-http-0001",
      },
      payload: {
        consumedQuantity: {
          kind: "approximate",
          amount: 1,
          unit: "kg",
          confidence: "high",
          originalText: "大约一公斤",
        },
        expectedVersion: 1,
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(apiErrorSchema.parse(response.json()).code, "VALIDATION_FAILED");
  } finally {
    await app.close();
  }
});

test("malformed JSON, missing routes and overlong request targets share the problem boundary", async () => {
  const app = await buildApp({
    config,
    operations,
    readiness: async () => true,
  });
  try {
    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat/exchange",
      headers: { "content-type": "application/json" },
      payload: '{"loginCode":',
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/not-a-route",
    });
    const overlong = await app.inject({
      method: "GET",
      url: `/healthz?padding=${"x".repeat(maximumRequestTargetBytes)}`,
    });

    for (const response of [malformed, missing, overlong]) {
      assert.equal(
        response.headers["content-type"]?.includes(
          "application/problem+json",
        ),
        true,
      );
      apiErrorSchema.parse(response.json());
    }
    assert.equal(malformed.statusCode, 400);
    assert.equal(
      apiErrorSchema.parse(malformed.json()).code,
      "VALIDATION_FAILED",
    );
    assert.equal(missing.statusCode, 404);
    assert.equal(
      apiErrorSchema.parse(missing.json()).code,
      "RESOURCE_NOT_FOUND",
    );
    assert.equal(overlong.statusCode, 414);
    assert.equal(
      apiErrorSchema.parse(overlong.json()).code,
      "URI_TOO_LONG",
    );
  } finally {
    await app.close();
  }
});

test("request logging excludes login code and issued token values", async () => {
  let logs = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const app = await buildApp({
    config,
    logger: createLogger("info", stream),
    operations,
    readiness: async () => true,
  });
  try {
    const codeSentinel = "LOGIN-CODE-HTTP-SENTINEL";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/wechat/exchange",
      payload: { loginCode: codeSentinel },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.accessToken, token);
    assert.equal(logs.includes(codeSentinel), false);
    assert.equal(logs.includes(token), false);
  } finally {
    await app.close();
  }
});
