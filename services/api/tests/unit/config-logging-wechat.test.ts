import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { loadConfig } from "../../src/config.js";
import { AppError } from "../../src/errors.js";
import { createLogger, redactSensitive } from "../../src/logging.js";
import {
  canonicalJson,
  requestHash,
  toDatabaseQuantityDecimal,
} from "../../src/utils.js";
import { FakeWechatAdapter } from "../../src/wechat/fake.js";
import { RealWechatAdapter } from "../../src/wechat/real.js";

// local-test 是唯一允许 fake adapter 的部署身份（见 deployment-boundaries 测试）。
const baseEnvironment = {
  NODE_ENV: "test",
  DEPLOYMENT_STAGE: "local-test",
  DEPLOYMENT_EXPOSURE: "loopback",
  DATABASE_URL:
    "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent",
  WECHAT_ADAPTER: "fake",
};

// 真实 adapter 只能出现在非 local-test 的部署身份上：local-test 携带 AppID 或
// AppSecret 本身就必须 fail closed，而真实 adapter 又必须有这两个值。
const realEnvironment = {
  NODE_ENV: "test",
  DEPLOYMENT_STAGE: "staging",
  DEPLOYMENT_EXPOSURE: "private-network",
  DATABASE_URL:
    "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent",
  WECHAT_ADAPTER: "real",
  WECHAT_APP_ID: "configured-at-runtime",
  WECHAT_APP_SECRET: "configured-at-runtime",
};

test("config validates Node service settings and requires real WeChat credentials together", () => {
  const fake = loadConfig(baseEnvironment);
  assert.equal(fake.port, 3000);
  assert.equal(fake.wechatAdapter, "fake");
  assert.equal(fake.deploymentStage, "local-test");
  assert.equal(fake.deploymentExposure, "loopback");
  assert.equal(fake.sessionAbsoluteTtlDays, 30);
  assert.equal(fake.sessionIdleTtlDays, 7);

  assert.throws(() =>
    loadConfig({
      ...realEnvironment,
      WECHAT_APP_ID: undefined,
      WECHAT_APP_SECRET: undefined,
    }),
  );
  assert.throws(() =>
    loadConfig({
      ...baseEnvironment,
      SESSION_ABSOLUTE_TTL_DAYS: "2",
      SESSION_IDLE_TTL_DAYS: "3",
    }),
  );

  const real = loadConfig(realEnvironment);
  assert.equal(real.wechatAdapter, "real");
  assert.equal(real.deploymentStage, "staging");
});

test("config refuses to start without an explicit WeChat adapter choice", () => {
  assert.throws(() =>
    loadConfig({
      NODE_ENV: "test",
      DEPLOYMENT_STAGE: "local-test",
      DEPLOYMENT_EXPOSURE: "loopback",
      DATABASE_URL:
    "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent",
    }),
  );
  assert.throws(() =>
    loadConfig({
      DATABASE_URL:
    "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent",
    }),
  );
});

test("production rejects the fake WeChat adapter, including a missing adapter", () => {
  assert.throws(() =>
    loadConfig({
      NODE_ENV: "production",
      DEPLOYMENT_STAGE: "production",
      DEPLOYMENT_EXPOSURE: "public",
      DATABASE_URL:
    "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent",
    }),
  );
  assert.throws(() =>
    loadConfig({
      ...baseEnvironment,
      NODE_ENV: "production",
    }),
  );

  const production = loadConfig({
    ...realEnvironment,
    NODE_ENV: "production",
    DEPLOYMENT_STAGE: "production",
    DEPLOYMENT_EXPOSURE: "public",
  });
  assert.equal(production.wechatAdapter, "real");

  assert.throws(() =>
    loadConfig({
      ...realEnvironment,
      NODE_ENV: "production",
      DEPLOYMENT_STAGE: "production",
      DEPLOYMENT_EXPOSURE: "public",
      WECHAT_CODE2SESSION_URL: "http://api.weixin.qq.com/sns/jscode2session",
    }),
  );
});

test("quantity decimal formatting pads without rounding and rejects excess scale", () => {
  assert.equal(toDatabaseQuantityDecimal("0.000001"), "0.000001");
  assert.equal(
    toDatabaseQuantityDecimal("999999999.999998"),
    "999999999.999998",
  );
  assert.equal(
    toDatabaseQuantityDecimal("999999999.999999"),
    "999999999.999999",
  );
  assert.throws(() =>
    toDatabaseQuantityDecimal("999999999.9999991"),
  );
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

const realAdapterReturning = (body: Record<string, unknown>) =>
  new RealWechatAdapter(
    {
      appId: "runtime-app-id",
      appSecret: "runtime-app-secret",
      endpoint: "https://api.weixin.qq.com/sns/jscode2session",
    },
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );

test("real WeChat adapter accepts a success body that includes errcode 0", async () => {
  const identity = await realAdapterReturning({
    openid: "provider-open-id",
    session_key: "provider-session-key",
    errcode: 0,
    errmsg: "ok",
  }).exchange("one-time-login-code");
  assert.equal(identity.providerSubject, "provider-open-id");
});

test("real WeChat adapter maps caller rejections to an authentication failure", async () => {
  for (const errcode of [40_029, 40_163, 40_226]) {
    await assert.rejects(
      realAdapterReturning({ errcode, errmsg: "invalid code" }).exchange(
        "bad-login-code",
      ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "AUTHENTICATION_REQUIRED" &&
        error.retryable === false,
    );
  }
});

test("real WeChat adapter keeps provider outages as retryable dependency failures", async () => {
  for (const errcode of [-1, 45_011]) {
    await assert.rejects(
      realAdapterReturning({ errcode, errmsg: "transient" }).exchange(
        "one-time-login-code",
      ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "EXTERNAL_DEPENDENCY_UNAVAILABLE" &&
        error.retryable === true,
    );
  }
  await assert.rejects(
    realAdapterReturning({ errcode: 40_013, errmsg: "invalid appid" }).exchange(
      "one-time-login-code",
    ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "EXTERNAL_DEPENDENCY_UNAVAILABLE" &&
      error.retryable === false,
  );
});

test("real WeChat adapter rejects a plaintext code2Session endpoint at its boundary", () => {
  assert.throws(() =>
    new RealWechatAdapter({
      appId: "runtime-app-id",
      appSecret: "runtime-app-secret",
      endpoint: "http://api.weixin.qq.com/sns/jscode2session",
    }),
  );
});

test("the central logger boundary redacts database credentials without any caller opt-in", () => {
  // 口令同时以原值与 URL 百分号编码形态出现：只脱敏其中一种会漏掉另一种。
  //
  // 两类取值分开：连接串与 conninfo 里放**格式合法**的口令（真实连接串里的空格
  // 必须被百分号编码），因此按取值脱敏可以整条替换；带空格的口令只出现在键名
  // 本身就敏感的字段上，由按键名脱敏兜住。按取值脱敏不声称能从任意自由文本里
  // 认出一个它不认识的口令。
  const password = "p@ss-w#rd-SENTINEL";
  const encoded = "p%40ss%20w%23rd%2FSENTINEL";
  const spacedPassword = "p@ss w#rd/SENTINEL";
  const dsn = `postgresql://meal_agent_app:${password}@postgres:5432/meal_agent`;
  const encodedDsn = `postgres://meal_agent_admin:${encoded}@postgres:5432/meal_agent`;

  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const logger = createLogger("info", stream);

  // 刻意**不**调用 redactSensitive：脱敏必须发生在 logger 边界本身。
  logger.info(
    {
      databaseUrl: dsn,
      database_url: dsn,
      "DATABASE-URL": dsn,
      connectionString: dsn,
      "connection-string": dsn,
      connectionUri: encodedDsn,
      password: spacedPassword,
      dbPassword: spacedPassword,
      pgPassword: spacedPassword,
      dsn: `host=postgres user=meal_agent_app password=${spacedPassword}`,
      // 键名完全无害，取值却是整条带口令的连接串或 conninfo。
      note: dsn,
      encodedNote: encodedDsn,
      neutralConninfo: `host=postgres user=meal_agent_app password=${password}`,
      conninfo: `host=postgres password=${spacedPassword}`,
      deeply: {
        nested: [
          { adminDatabaseUrl: dsn },
          { migration: { connectionString: encodedDsn } },
          { free: `restore from ${encodedDsn} now` },
        ],
      },
      // Error 的 message 是不可枚举属性，按属性递归看不见它。
      cause: new Error(`connect failed: ${dsn}`),
      err: new Error(`connect failed: ${encodedDsn}`),
      safe: "visible",
    },
    "connection failed",
  );
  // 消息串本身也走同一条边界。
  logger.warn({ safe: "visible" }, `retrying ${dsn}`);
  logger.error(`giving up on ${encodedDsn}`);

  for (const sentinel of [password, encoded, spacedPassword, "SENTINEL"]) {
    assert.equal(
      output.includes(sentinel),
      false,
      `${sentinel} must not reach the log stream`,
    );
  }
  assert.equal(output.includes("visible"), true);
  // 第八轮起：record 一旦带 `err`，显式 msg 就**无条件**折成固定串。原来的判据是
  // 「msg 与 err.message 逐字相同才折」，那条可以靠包装/截断绕开。代价是这里的
  // "connection failed" 也一起被折掉；诊断信息改从 `err.type` 走。
  assert.equal(output.includes("connection failed"), false);
  // Error 仍然保留它自己的类型名，只是内容被换成固定安全串。
  assert.equal(output.includes('"type":"Error"'), true);
  assert.equal(output.includes("request failed"), true);
  // 不带 `err` 的那两条日志的 msg 只走文本脱敏，不被折叠：一条保留了前缀，
  // 另一条因为整串在**任意层百分号编码之下**都藏着连接串而被整条替换（fail
  // closed 的那条规则）。两者都不是固定的 "request failed"。
  assert.equal(output.includes('"msg":"retrying [Redacted]"'), true);
  assert.equal(output.includes('"msg":"[Redacted]"'), true);
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
