import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";

/**
 * 阶段 09A / M3A：中央 logger 边界的完整性。
 *
 * 每一条都**扫描真实 Pino 的最终输出**，而不是单测某个辅助函数——「辅助函数
 * 会脱敏」与「日志里真的没有」是两件事，中间隔着 formatters、serializers、
 * chindings、printf 插值和 `JSON.stringify` 五个环节，任何一个都可能把取值
 * 重新放回去。
 *
 * sentinel 都是显式的合成值，不是任何真实凭据。
 */

const password = "p@ss-w#rd-SENTINEL";
const encoded = "p%40ss%20w%23rd%2FSENTINEL";
const quoted = " QUOTED-LEAK-SENTINEL";
const dsn = `postgresql://meal_agent_app:${password}@postgres:5432/meal_agent`;
const encodedDsn =
  `postgres://meal_agent_admin:${encoded}@postgres:5432/meal_agent`;

const sentinels = [password, encoded, quoted.trim(), "SENTINEL"] as const;

interface Capture {
  readonly logger: ReturnType<typeof createLogger>;
  output: () => string;
}

const capturingLogger = (): Capture => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { logger: createLogger("info", stream), output: () => output };
};

const assertClean = (output: string, label: string): void => {
  for (const sentinel of sentinels) {
    assert.equal(
      output.includes(sentinel),
      false,
      `${label}: ${sentinel} reached the log stream\n${output}`,
    );
  }
};

test("plain log objects are redacted at any nesting depth", () => {
  const capture = capturingLogger();
  // 刻意**不**调用 redactSensitive：脱敏必须发生在 logger 边界本身。
  capture.logger.info(
    {
      databaseUrl: dsn,
      database_url: dsn,
      "DATABASE-URL": dsn,
      connectionString: dsn,
      "connection-string": dsn,
      connectionUri: encodedDsn,
      password,
      dbPassword: password,
      pgPassword: password,
      dsn: `host=postgres user=meal_agent_app password=${password}`,
      // 键名完全无害，取值却是整条带口令的连接串。
      note: dsn,
      encodedNote: encodedDsn,
      deeply: {
        nested: [
          { adminDatabaseUrl: dsn },
          { migration: { connectionString: encodedDsn } },
          { free: `restore from ${encodedDsn} now` },
        ],
      },
      safe: "visible",
    },
    "connection failed",
  );

  assertClean(capture.output(), "plain object");
  assert.equal(capture.output().includes("visible"), true);
  assert.equal(capture.output().includes("connection failed"), true);
});

test("child logger bindings go through the same canonicalizer", () => {
  const capture = capturingLogger();
  const child = capture.logger.child({
    databaseUrl: dsn,
    deployment: { migration: { connectionString: encodedDsn } },
    component: "migration-runner",
  });
  child.info("child binding check");

  // 孙 logger 也必须继续被覆盖，否则一层 child 之后就漏了。
  const grandchild = child.child({ note: dsn, stage: "handoff" });
  grandchild.info("grandchild binding check");

  assertClean(capture.output(), "child bindings");
  assert.equal(capture.output().includes("migration-runner"), true);
  assert.equal(capture.output().includes("handoff"), true);
});

test("printf %j, %o and %s arguments are redacted before interpolation", () => {
  const capture = capturingLogger();
  capture.logger.info({}, "structured %j", { databaseUrl: dsn });
  capture.logger.info({}, "inspected %o", { note: encodedDsn });
  capture.logger.info({}, "interpolated %s", dsn);
  capture.logger.info("bare message %s", encodedDsn);
  capture.logger.info(`template ${dsn}`);
  capture.logger.warn({ safe: "visible" }, `retrying ${dsn}`);

  assertClean(capture.output(), "printf arguments");
  assert.equal(capture.output().includes("visible"), true);
});

test("an own enumerable toJSON cannot regenerate a secret at stringify time", () => {
  const capture = capturingLogger();
  const hostile = {
    note: "harmless",
    // own enumerable：`Object.entries` 看得见它，`JSON.stringify` 也会调用它。
    // 如果 canonicalizer 把它原样留下，脱敏后的取值会在序列化阶段被**重新生成**。
    toJSON: () => ({ leaked: dsn }),
  };
  const hostileToString = {
    note: "harmless",
    toString: () => dsn,
  };
  capture.logger.info({ hostile, hostileToString }, "toJSON check");
  capture.logger.info({}, "interpolated %j", hostile);

  assertClean(capture.output(), "own toJSON");
  assert.equal(capture.output().includes("harmless"), true);
  assert.equal(capture.output().includes("[Function]"), true);
});

test("quoted and escaped libpq conninfo is redacted conservatively", () => {
  const capture = capturingLogger();
  capture.logger.info(
    {
      // 带引号、带空格的取值无法用一条正则可靠地找到结束位置，因此实现的口径
      // 是「看到 password= 就把其后的全部文本删掉」。
      conninfoNote: `host=postgres user=app password='${quoted}' sslmode=disable`,
      escaped: `host=postgres password=\\'${quoted}\\' application_name=x`,
      spaced: `host=postgres password = '${quoted}'`,
      upper: `HOST=postgres PGPASSWORD=${quoted}`,
      passfile: `passfile=${quoted}`,
    },
    "conninfo check",
  );
  capture.logger.info({}, `raw conninfo host=db password='${quoted}' end`);

  assertClean(capture.output(), "quoted conninfo");
});

test("the request serializer redacts the request target", async () => {
  const capture = capturingLogger();
  const config = loadConfig({
    NODE_ENV: "test",
    DEPLOYMENT_STAGE: "local-test",
    DEPLOYMENT_EXPOSURE: "loopback",
    DATABASE_URL:
      "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent",
    WECHAT_ADAPTER: "fake",
    LOG_LEVEL: "info",
  });
  const unavailable = async (): Promise<never> => {
    throw new Error("operation should not be called");
  };
  const app = await buildApp({
    config,
    logger: capture.logger,
    // 只需要一个能启动的实例；本用例不调用任何业务操作。
    operations: new Proxy(
      {},
      { get: () => unavailable },
    ) as never,
    readiness: async () => true,
  });
  try {
    // 请求目标是调用方完全可控的文本：它会经过 req serializer 进入日志。
    await app.inject({
      method: "GET",
      url: `/api/v1/not-a-route/${encodeURIComponent(dsn)}`,
    });
    await app.inject({
      method: "GET",
      url: `/api/v1/not-a-route/${dsn.replaceAll("/", "%2F")}?q=${encoded}`,
    });
  } finally {
    await app.close();
  }

  assertClean(capture.output(), "request serializer");
});

test("errors and nested causes never carry their message into the log", () => {
  const capture = capturingLogger();
  capture.logger.error({ err: new Error(`connect failed: ${dsn}`) }, "err key");
  capture.logger.error(new Error(`connect failed: ${encodedDsn}`), "first arg");
  capture.logger.info(
    {
      cause: new Error(`connect failed: ${dsn}`),
      wrapped: { inner: new Error(`connect failed: ${encodedDsn}`) },
      list: [new Error(`connect failed: ${dsn}`)],
    },
    "nested causes",
  );
  // 带 own enumerable 属性的 Error：属性也必须被脱敏。
  const decorated = Object.assign(new Error("boom"), { databaseUrl: dsn });
  capture.logger.error({ err: decorated }, "decorated error");

  assertClean(capture.output(), "errors");
  assert.equal(capture.output().includes("request failed"), true);
  assert.equal(capture.output().includes('"type":"Error"'), true);
});

test("cycles in both objects and arrays are handled without recursion", () => {
  const capture = capturingLogger();

  const cyclicObject: Record<string, unknown> = { databaseUrl: dsn };
  cyclicObject["self"] = cyclicObject;

  const cyclicArray: unknown[] = [dsn];
  cyclicArray.push(cyclicArray);

  const mutual: Record<string, unknown> = { note: dsn };
  const mutualList: unknown[] = [mutual];
  mutual["list"] = mutualList;

  // 同一个对象作为**兄弟节点**出现两次不是循环，不应被误判。
  const shared = { note: encodedDsn };

  capture.logger.info(
    { cyclicObject, cyclicArray, mutual, first: shared, second: shared },
    "cycle check",
  );

  const output = capture.output();
  assertClean(output, "cycles");
  assert.equal(output.includes("[Circular]"), true);
  // 兄弟节点被完整展开两次，而不是第二次退化成 [Circular]。
  assert.equal(output.split("[Redacted]").length - 1 >= 2, true);
});
