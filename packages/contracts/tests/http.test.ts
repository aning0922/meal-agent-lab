import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeInventoryLotSuccessSchema,
  householdPageSuccessSchema,
  serviceLivenessSuccessSchema,
  wechatLoginExchangeSuccessSchema,
} from "../src/http.js";

const requestId = "123e4567-e89b-42d3-a456-426614174000";

test("stage 06 HTTP envelopes retain shared request and identity constraints", () => {
  assert.equal(
    serviceLivenessSuccessSchema.safeParse({
      ok: true,
      data: { status: "ok" },
      meta: { requestId },
    }).success,
    true,
  );
  assert.equal(
    serviceLivenessSuccessSchema.safeParse({
      ok: true,
      data: { status: "ok", handwrittenStatus: true },
      meta: { requestId },
    }).success,
    false,
  );

  assert.equal(
    householdPageSuccessSchema.safeParse({
      ok: true,
      data: {
        items: [],
        pageInfo: { nextCursor: null, hasMore: true },
      },
      meta: { requestId },
    }).success,
    false,
  );

  assert.equal(
    wechatLoginExchangeSuccessSchema.safeParse({
      ok: true,
      data: {
        accessToken: "t".repeat(43),
        providerSubject: "must-not-be-returned",
      },
      meta: { requestId },
    }).success,
    false,
  );

  assert.equal(
    consumeInventoryLotSuccessSchema.safeParse({
      ok: true,
      data: {
        lot: {},
        event: {
          type: "consumed",
          quantityChange: {
            kind: "numeric",
            amount: -1,
            unit: "kg",
            precision: "estimated",
          },
        },
      },
      meta: { requestId },
    }).success,
    false,
  );
});
