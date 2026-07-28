import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config.js";
import { createWechatAdapter } from "../../src/wechat/adapter.js";
import {
  isOfficialWechatCode2SessionUrl,
  officialWechatCode2SessionUrl,
} from "../../src/wechat/endpoint.js";
import { FakeWechatAdapter } from "../../src/wechat/fake.js";
import { RealWechatAdapter, type FetchLike } from "../../src/wechat/real.js";

/**
 * 阶段 09A / M3A：部署身份、fake 登录边界与真实 code2Session endpoint。
 *
 * 三条防线**互相独立**，任何一条都不能替另一条放行：
 *   - `NODE_ENV`：Node 运行模式；
 *   - `DEPLOYMENT_STAGE`：这套部署是什么；
 *   - `DEPLOYMENT_EXPOSURE`：谁访问得到它。
 * 两个部署维度都**没有默认值**——猜出来的部署身份正是 fake 登录最危险的失败
 * 方式。
 */

const databaseUrl =
  "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent";

const localTest = {
  NODE_ENV: "test",
  DEPLOYMENT_STAGE: "local-test",
  DEPLOYMENT_EXPOSURE: "loopback",
  DATABASE_URL: databaseUrl,
  WECHAT_ADAPTER: "fake",
} as const;

const stages = ["local-test", "staging", "production"] as const;
const exposures = ["loopback", "private-network", "public"] as const;
const nodeEnvironments = ["development", "test", "production"] as const;

test("the deployment dimensions have no defaults and only accept known values", () => {
  for (const missing of [
    { DEPLOYMENT_STAGE: undefined },
    { DEPLOYMENT_EXPOSURE: undefined },
    { DEPLOYMENT_STAGE: undefined, DEPLOYMENT_EXPOSURE: undefined },
    { DEPLOYMENT_STAGE: "" },
    { DEPLOYMENT_EXPOSURE: "" },
  ]) {
    assert.throws(
      () => loadConfig({ ...localTest, ...missing }),
      `${JSON.stringify(missing)} must fail closed instead of defaulting`,
    );
  }

  for (const unknown of [
    { DEPLOYMENT_STAGE: "localtest" },
    { DEPLOYMENT_STAGE: "prod" },
    { DEPLOYMENT_STAGE: "LOCAL-TEST" },
    { DEPLOYMENT_EXPOSURE: "internal" },
    { DEPLOYMENT_EXPOSURE: "private network" },
    { DEPLOYMENT_EXPOSURE: "LOOPBACK" },
  ]) {
    assert.throws(
      () => loadConfig({ ...localTest, ...unknown }),
      `${JSON.stringify(unknown)} must be rejected`,
    );
  }
});

test("the fake adapter is only allowed on local-test + loopback + non-production", () => {
  let accepted = 0;
  for (const stage of stages) {
    for (const exposure of exposures) {
      for (const nodeEnv of nodeEnvironments) {
        const allowed =
          stage === "local-test" &&
          exposure === "loopback" &&
          nodeEnv !== "production";
        const environment = {
          NODE_ENV: nodeEnv,
          DEPLOYMENT_STAGE: stage,
          DEPLOYMENT_EXPOSURE: exposure,
          DATABASE_URL: databaseUrl,
          WECHAT_ADAPTER: "fake",
        };
        const label = `${nodeEnv} / ${stage} / ${exposure}`;
        if (allowed) {
          const config = loadConfig(environment);
          assert.equal(config.wechatAdapter, "fake", label);
          assert.equal(config.deploymentStage, "local-test", label);
          assert.equal(config.deploymentExposure, "loopback", label);
          accepted += 1;
        } else {
          assert.throws(
            () => loadConfig(environment),
            `fake must be rejected at ${label}`,
          );
        }
      }
    }
  }
  // 27 个组合里只有 development/local-test/loopback 与 test/local-test/loopback
  // 两个可以承载 fake。
  assert.equal(accepted, 2);
});

test("NODE_ENV and the deployment dimensions are independent lines of defence", () => {
  // 部署维度看起来完全无害时，NODE_ENV=production 仍然拒绝 fake。
  assert.throws(() => loadConfig({ ...localTest, NODE_ENV: "production" }));
  // 反过来，NODE_ENV 无害时，部署维度仍然拒绝 fake——一条不能顶替另一条。
  assert.throws(() =>
    loadConfig({
      ...localTest,
      NODE_ENV: "development",
      DEPLOYMENT_STAGE: "production",
    }),
  );
  assert.throws(() =>
    loadConfig({
      ...localTest,
      NODE_ENV: "development",
      DEPLOYMENT_EXPOSURE: "public",
    }),
  );
  assert.throws(() =>
    loadConfig({
      ...localTest,
      NODE_ENV: "development",
      DEPLOYMENT_EXPOSURE: "private-network",
    }),
  );
});

test("local-test must never carry WeChat credentials", () => {
  for (const credentials of [
    { WECHAT_APP_ID: "wx-real-app-id" },
    { WECHAT_APP_SECRET: "real-app-secret" },
    { WECHAT_APP_ID: "wx-real-app-id", WECHAT_APP_SECRET: "real-app-secret" },
    { WECHAT_APP_ID: " " },
  ]) {
    assert.throws(
      () => loadConfig({ ...localTest, ...credentials }),
      `${JSON.stringify(credentials)} must fail before the service starts`,
    );
  }

  // 空值示例（`.env.example` 的惯例）等价于「没有设置」，因此不阻塞 local-test。
  const withEmpty = loadConfig({
    ...localTest,
    WECHAT_APP_ID: "",
    WECHAT_APP_SECRET: "",
  });
  assert.equal(withEmpty.wechatAppId, undefined);
  assert.equal(withEmpty.wechatAppSecret, undefined);

  // 因此 local-test 与真实 adapter 在结构上互斥：真实 adapter 必须有凭据，
  // 而 local-test 不允许携带凭据。
  assert.throws(() => loadConfig({ ...localTest, WECHAT_ADAPTER: "real" }));
  assert.throws(() =>
    loadConfig({
      ...localTest,
      WECHAT_ADAPTER: "real",
      WECHAT_APP_ID: "wx-real-app-id",
      WECHAT_APP_SECRET: "real-app-secret",
    }),
  );
});

const rejectedEndpoints = [
  // 明文
  "http://api.weixin.qq.com/sns/jscode2session",
  "ws://api.weixin.qq.com/sns/jscode2session",
  "wss://api.weixin.qq.com/sns/jscode2session",
  // 相似域名与子域名
  "https://api.weixin.qq.com.evil.example/sns/jscode2session",
  "https://a.api.weixin.qq.com/sns/jscode2session",
  "https://api-weixin.qq.com/sns/jscode2session",
  "https://api.weixin.qq.com./sns/jscode2session",
  "https://weixin.qq.com/sns/jscode2session",
  "https://evil.example/api.weixin.qq.com/sns/jscode2session",
  "https://127.0.0.1/sns/jscode2session",
  "https://API.WEIXIN.QQ.COM/sns/jscode2session",
  // 另一个 endpoint / path 变体
  "https://api.weixin.qq.com/sns/userinfo",
  "https://api.weixin.qq.com/sns/oauth2/access_token",
  "https://api.weixin.qq.com/sns/jscode2session/",
  "https://api.weixin.qq.com//sns/jscode2session",
  "https://api.weixin.qq.com/SNS/jscode2session",
  "https://api.weixin.qq.com/",
  // 端口（含显式的默认端口）
  "https://api.weixin.qq.com:443/sns/jscode2session",
  "https://api.weixin.qq.com:8443/sns/jscode2session",
  // query / fragment / userinfo
  "https://api.weixin.qq.com/sns/jscode2session?appid=leaked",
  "https://api.weixin.qq.com/sns/jscode2session#fragment",
  "https://user:pass@api.weixin.qq.com/sns/jscode2session",
  // 空白
  " https://api.weixin.qq.com/sns/jscode2session",
  "https://api.weixin.qq.com/sns/jscode2session ",
] as const;

test("the real code2Session endpoint is pinned to the one official URL", () => {
  assert.equal(
    officialWechatCode2SessionUrl,
    "https://api.weixin.qq.com/sns/jscode2session",
  );
  assert.equal(isOfficialWechatCode2SessionUrl(officialWechatCode2SessionUrl), true);

  const realEnvironment = {
    NODE_ENV: "test",
    DEPLOYMENT_STAGE: "staging",
    DEPLOYMENT_EXPOSURE: "private-network",
    DATABASE_URL: databaseUrl,
    WECHAT_ADAPTER: "real",
    WECHAT_APP_ID: "configured-at-runtime",
    WECHAT_APP_SECRET: "configured-at-runtime",
  };
  // 缺省与显式写出官方地址都成立。
  assert.equal(
    loadConfig(realEnvironment).wechatCode2SessionUrl,
    officialWechatCode2SessionUrl,
  );
  assert.equal(
    loadConfig({
      ...realEnvironment,
      WECHAT_CODE2SESSION_URL: officialWechatCode2SessionUrl,
    }).wechatCode2SessionUrl,
    officialWechatCode2SessionUrl,
  );

  for (const endpoint of rejectedEndpoints) {
    assert.equal(
      isOfficialWechatCode2SessionUrl(endpoint),
      false,
      `${endpoint} must not be treated as the official endpoint`,
    );
    // 配置层
    assert.throws(
      () =>
        loadConfig({
          ...realEnvironment,
          WECHAT_CODE2SESSION_URL: endpoint,
        }),
      `config must reject ${endpoint}`,
    );
    // adapter 边界再拒绝一次：AppID/AppSecret 会作为 query 参数发到这个地址，
    // 因此它不能只由上游配置层保证。
    assert.throws(
      () =>
        new RealWechatAdapter({
          appId: "configured-at-runtime",
          appSecret: "configured-at-runtime",
          endpoint,
        }),
      `the real adapter must reject ${endpoint}`,
    );
  }
});

test("the fake adapter performs no external call at all", async () => {
  let calls = 0;
  const exploding: FetchLike = async () => {
    calls += 1;
    throw new Error("the fake adapter must never reach the network");
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("no external call is allowed in local-test");
  }) as typeof globalThis.fetch;

  try {
    const config = loadConfig(localTest);
    const adapter = createWechatAdapter(config, exploding);
    assert.ok(
      adapter instanceof FakeWechatAdapter,
      "local-test must select the fake adapter",
    );

    const identity = await adapter.exchange("fake-login-code");
    assert.equal(identity.providerTenantKey, "stage-06-fake-wechat-app");
    const repeated = await adapter.exchange("fake-login-code");
    assert.deepEqual(identity, repeated);
    // fake 的失败分支同样不得外呼。
    await assert.rejects(adapter.exchange("fake-dependency-unavailable"));

    assert.equal(
      calls,
      0,
      "neither the injected fetch nor globalThis.fetch may be called",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
