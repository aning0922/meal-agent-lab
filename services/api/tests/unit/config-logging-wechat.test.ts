import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { loadConfig } from "../../src/config.js";
import { createLogger, redactSensitive } from "../../src/logging.js";
import { canonicalJson, requestHash } from "../../src/utils.js";
import { FakeWechatAdapter } from "../../src/wechat/fake.js";
import { RealWechatAdapter } from "../../src/wechat/real.js";

const baseEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost/meal_agent",
  WECHAT_ADAPTER: "fake",
};

test("config validates Node service settings and requires real WeChat credentials together", () => {
  const fake = loadConfig(baseEnvironment);
  assert.equal(fake.port, 3000);
  assert.equal(fake.wechatAdapter, "fake");
  assert.equal(fake.sessionAbsoluteTtlDays, 30);
  assert.equal(fake.sessionIdleTtlDays, 7);

  assert.throws(() =>
    loadConfig({
      ...baseEnvironment,
      WECHAT_ADAPTER: "real",
    }),
  );
  assert.throws(() =>
    loadConfig({
      ...baseEnvironment,
      SESSION_ABSOLUTE_TTL_DAYS: "2",
      SESSION_IDLE_TTL_DAYS: "3",
    }),
  );

  const real = loadConfig({
    ...baseEnvironment,
    WECHAT_ADAPTER: "real",
    WECHAT_APP_ID: "configured-at-runtime",
    WECHAT_APP_SECRET: "configured-at-runtime",
  });
  assert.equal(real.wechatAdapter, "real");
});

test("production rejects the fake WeChat adapter, including its default", () => {
  assert.throws(() =>
    loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://localhost/meal_agent",
    }),
  );
  assert.throws(() =>
    loadConfig({
      ...baseEnvironment,
      NODE_ENV: "production",
    }),
  );

  const production = loadConfig({
    ...baseEnvironment,
    NODE_ENV: "production",
    WECHAT_ADAPTER: "real",
    WECHAT_APP_ID: "configured-at-runtime",
    WECHAT_APP_SECRET: "configured-at-runtime",
  });
  assert.equal(production.wechatAdapter, "real");
});

test("canonical request hashes are independent of object key order", () => {
  assert.equal(
    canonicalJson({ second: 2, first: { b: 2, a: 1 } }),
    canonicalJson({ first: { a: 1, b: 2 }, second: 2 }),
  );
  assert.equal(
    requestHash({ second: 2, first: 1 }),
    requestHash({ first: 1, second: 2 }),
  );
  assert.notEqual(requestHash({ amount: 1 }), requestHash({ amount: 2 }));
});

test("deterministic fake WeChat adapter restores the same provider identity", async () => {
  const adapter = new FakeWechatAdapter();
  const first = await adapter.exchange("repeatable-code");
  const second = await adapter.exchange("repeatable-code");
  const other = await adapter.exchange("different-code");

  assert.deepEqual(first, second);
  assert.notEqual(first.providerSubject, other.providerSubject);
  assert.equal(first.providerSubject.includes("repeatable-code"), false);
});

test("real WeChat adapter exposes only the identity boundary and discards session_key", async () => {
  let requestedUrl: URL | undefined;
  const adapter = new RealWechatAdapter(
    {
      appId: "runtime-app-id",
      appSecret: "runtime-app-secret",
      endpoint: "https://api.weixin.qq.com/sns/jscode2session",
    },
    async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(
        JSON.stringify({
          openid: "provider-open-id",
          unionid: "provider-union-id",
          session_key: "provider-session-key",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const identity = await adapter.exchange("one-time-login-code");
  assert.deepEqual(identity, {
    providerTenantKey: "runtime-app-id",
    providerSubject: "provider-open-id",
    providerUnionSubject: "provider-union-id",
  });
  assert.equal("sessionKey" in identity, false);
  assert.equal(requestedUrl?.searchParams.get("grant_type"), "authorization_code");
});

test("recursive redaction prevents secrets and private member constraints from reaching logs", () => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const logger = createLogger("info", stream);
  logger.info(
    redactSensitive({
      loginCode: "LOGIN-CODE-SENTINEL",
      accessToken: "TOKEN-SENTINEL",
      providerSubject: "OPENID-SENTINEL",
      providerUnionSubject: "UNIONID-SENTINEL",
      wechatAppSecret: "APPSECRET-SENTINEL",
      member: {
        dietaryConstraints: ["PRIVATE-CONSTRAINT-SENTINEL"],
      },
      safe: "visible",
    }),
    "redaction-test",
  );

  for (const sentinel of [
    "LOGIN-CODE-SENTINEL",
    "TOKEN-SENTINEL",
    "OPENID-SENTINEL",
    "UNIONID-SENTINEL",
    "APPSECRET-SENTINEL",
    "PRIVATE-CONSTRAINT-SENTINEL",
  ]) {
    assert.equal(output.includes(sentinel), false);
  }
  assert.equal(output.includes("visible"), true);
});
