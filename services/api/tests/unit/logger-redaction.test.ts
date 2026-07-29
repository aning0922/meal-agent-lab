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

test("setBindings goes through the canonicalizer on root, child and grandchild", () => {
  const capture = capturingLogger();

  capture.logger.setBindings({ databaseUrl: dsn, component: "root" });
  capture.logger.info("root after setBindings");

  const child = capture.logger.child({ stage: "handoff" });
  child.setBindings({ note: encodedDsn, component: "child" });
  child.info("child after setBindings");

  const grandchild = child.child({ stage: "acl" });
  grandchild.setBindings({
    migration: { connectionString: dsn },
    component: "grandchild",
  });
  grandchild.info("grandchild after setBindings");

  assertClean(capture.output(), "setBindings");
  for (const marker of ["root", "child", "grandchild"]) {
    assert.equal(
      capture.output().includes(marker),
      true,
      `${marker} bindings must still be emitted`,
    );
  }
});

test("child options cannot reintroduce a secret after redaction", () => {
  const capture = capturingLogger();

  // 1. serializers：子 logger 的 serializer 在 canonicalizer 之后运行。
  const withSerializer = capture.logger.child(
    { component: "serializer" },
    {
      serializers: {
        payload: () => ({ leaked: dsn }),
      },
    },
  );
  withSerializer.info({ payload: { harmless: true } }, "child serializer");

  // 2. formatters.log：子 logger 的 formatters 会**替换**父 logger 的同名项。
  const withFormatter = capture.logger.child(
    { component: "formatter" },
    {
      formatters: {
        log: (object: object) => ({ ...object, leaked: dsn }),
      },
    },
  );
  withFormatter.info({ harmless: true }, "child formatter");

  // 3. formatters.bindings。
  const withBindingFormatter = capture.logger.child(
    { component: "bindings" },
    {
      formatters: {
        bindings: (bindings: object) => ({ ...bindings, leaked: encodedDsn }),
      },
    },
  );
  withBindingFormatter.info("child binding formatter");

  // 4. redact.censor：censor 的返回值直接进入输出。
  const withCensor = capture.logger.child(
    { component: "censor" },
    {
      redact: {
        paths: ["secretish"],
        censor: () => dsn,
      },
    },
  );
  withCensor.info({ secretish: "x" }, "child censor");

  const withStringCensor = capture.logger.child(
    { component: "string-censor" },
    { redact: { paths: ["secretish"], censor: encodedDsn } },
  );
  withStringCensor.info({ secretish: "x" }, "child string censor");

  // 5. msgPrefix：它是在我们的 logMethod 之后才拼到 msg 前面的。
  const withPrefix = capture.logger.child(
    { component: "prefix" },
    { msgPrefix: `[${dsn}] ` },
  );
  withPrefix.info("child msgPrefix");

  assertClean(capture.output(), "child options");
  for (const marker of [
    "serializer",
    "formatter",
    "bindings",
    "censor",
    "prefix",
  ]) {
    assert.equal(
      capture.output().includes(marker),
      true,
      `${marker} child must still emit its own bindings`,
    );
  }
});

test("request logging keeps method, redacted path, remote address and status", async () => {
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
    operations: new Proxy({}, { get: () => unavailable }) as never,
    readiness: async () => true,
  });
  try {
    await app.inject({ method: "GET", url: "/healthz?trace=1" });
  } finally {
    await app.close();
  }

  const entries = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  // 正向断言：脱敏不能把请求日志掏空。
  const request = entries.find((entry) => entry["req"] !== undefined)?.[
    "req"
  ] as Record<string, unknown> | undefined;
  assert.ok(request, "an incoming-request entry must exist");
  assert.equal(request["method"], "GET");
  // query 被去掉，路径本身保留并过了一遍取值脱敏。
  assert.equal(request["path"], "/healthz");
  assert.equal(
    typeof request["remoteAddress"],
    "string",
    "remoteAddress must be present, not silently dropped",
  );
  assert.notEqual(request["remoteAddress"], "");
  assert.equal(typeof request["requestId"], "string");

  const response = entries.find((entry) => entry["res"] !== undefined)?.[
    "res"
  ] as Record<string, unknown> | undefined;
  assert.ok(response, "a request-completed entry must exist");
  assert.equal(response["statusCode"], 200);
});

/**
 * 以**运行时**形态调用 `child()`。本文件里有几组用例刻意传入不符合 Pino 类型
 * 契约的 options（那正是被测行为），静态类型挡在这里没有意义。
 */
const childWithOptions = (
  logger: ReturnType<typeof createLogger>,
  bindings: Record<string, unknown>,
  options: unknown,
): ReturnType<typeof createLogger> =>
  (
    logger.child as unknown as (
      childBindings: Record<string, unknown>,
      childOptions: unknown,
    ) => ReturnType<typeof createLogger>
  )(bindings, options);

/** 解析捕获到的 NDJSON，并剥掉每行都有的 level/time/msg。 */
const bindingsOf = (
  output: string,
): readonly { msg: string; bindings: Record<string, unknown> }[] =>
  output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const { level: _level, time: _time, msg, ...bindings } = parsed;
      return { msg: String(msg), bindings };
    });

test("child and grandchild loggers stay isolated from root", () => {
  const capture = capturingLogger();

  const child = capture.logger.child({ layer: "child", note: dsn });
  const grandchild = child.child({ layer2: "grandchild", note2: encodedDsn });

  capture.logger.info("root-1");
  child.info("child-1");
  grandchild.info("grandchild-1");

  child.setBindings({ layer: "child-updated" });
  child.info("child-2");
  capture.logger.info("root-2");
  const laterGrandchild = child.child({ layer3: "later" });
  laterGrandchild.info("later-grandchild");

  grandchild.setBindings({ layer2: "grandchild-updated" });
  grandchild.info("grandchild-2");
  child.info("child-3");
  capture.logger.info("root-3");

  const entries = new Map(
    bindingsOf(capture.output()).map((entry) => [entry.msg, entry.bindings]),
  );
  const at = (msg: string): Record<string, unknown> => {
    const value = entries.get(msg);
    assert.ok(value, `${msg} must have been emitted`);
    return value;
  };

  // 1. child 继承 root bindings（root 没有额外 binding，因此 child 只有自己的）。
  assert.equal(at("child-1")["layer"], "child");
  // 2. grandchild 同时继承 root、parent 与自己的 bindings。
  assert.equal(at("grandchild-1")["layer"], "child");
  assert.equal(at("grandchild-1")["layer2"], "grandchild");
  // 3. child.setBindings 只改 child 及其**之后**建立的后代。
  assert.equal(at("child-2")["layer"], "child-updated");
  assert.equal(at("later-grandchild")["layer"], "child-updated");
  assert.equal(at("later-grandchild")["layer3"], "later");
  // 4. grandchild.setBindings 不改 parent 与 root。
  assert.equal(at("grandchild-2")["layer2"], "grandchild-updated");
  assert.equal(at("child-3")["layer"], "child-updated");
  assert.equal(at("child-3")["layer2"], undefined);
  // 5. root 的输出里不得出现任何子 logger 的 binding。
  for (const msg of ["root-1", "root-2", "root-3"]) {
    assert.deepEqual(
      at(msg),
      {},
      `${msg} must not inherit any child binding`,
    );
  }
  // 6. binding 里的 Secret 仍然被脱敏。
  assertClean(capture.output(), "logger isolation");
});

test("customLevels with a level formatter cannot inject a secret", () => {
  const capture = capturingLogger();

  const audited = childWithOptions(
    capture.logger,
    { component: "audit" },
    {
      customLevels: { audit: 35 },
      formatters: {
        level: (label: string, number: number) => ({
          level: number,
          levelLabel: label,
          leaked: dsn,
          leakedText: `password='${quoted}'`,
        }),
      },
    },
  ) as ReturnType<typeof createLogger> & { audit: (message: string) => void };

  audited.audit("custom level line");
  audited.info("standard level line");

  assertClean(capture.output(), "customLevels + formatters.level");
  assert.equal(capture.output().includes("audit"), true);
});

test("child redact.censor shapes outside the Pino contract fail closed", () => {
  const capture = capturingLogger();
  for (const censor of [
    { leaked: dsn },
    [dsn],
    42,
    true,
  ]) {
    assert.throws(
      () =>
        childWithOptions(
          capture.logger,
          { component: "censor" },
          { redact: { paths: ["secretish"], censor } },
        ),
      /redact\.censor must be a string or a function/,
      `censor ${JSON.stringify(censor)} must be rejected`,
    );
  }
  assert.throws(
    () =>
      childWithOptions(
        capture.logger,
        { component: "censor" },
        { redact: "not-an-object" },
      ),
    /redact must be an array of paths or an options object/,
  );
  // 合法形态仍然可用（并且仍然被包装）。
  const stringCensor = childWithOptions(
    capture.logger,
    { component: "ok" },
    { redact: { paths: ["secretish"], censor: "[hidden]" } },
  );
  stringCensor.info({ secretish: dsn }, "string censor");
  const pathsOnly = childWithOptions(capture.logger, { component: "ok2" }, {
    redact: ["secretish"],
  });
  pathsOnly.info({ secretish: dsn }, "paths only");
  assertClean(capture.output(), "valid censor shapes");
});

test("percent-encoded connection secrets are found through bounded re-decoding", () => {
  const capture = capturingLogger();
  const conninfo = `host=db user=app password='${quoted}'`;

  const encodedForms: readonly [string, string][] = [
    ["single encoding", encodeURIComponent(dsn)],
    ["double encoding", encodeURIComponent(encodeURIComponent(dsn))],
    [
      "triple encoding",
      encodeURIComponent(encodeURIComponent(encodeURIComponent(dsn))),
    ],
    ["malformed %ZZ prefix", `%ZZ${encodeURIComponent(dsn)}`],
    [
      "malformed prefix then double encoding",
      `%ZZ${encodeURIComponent(encodeURIComponent(dsn))}`,
    ],
    ["encoded conninfo", encodeURIComponent(conninfo)],
    ["double-encoded conninfo", encodeURIComponent(encodeURIComponent(conninfo))],
    ["encoded inside a longer path", `/api/v1/x/${encodeURIComponent(dsn)}/y`],
  ];

  const started = Date.now();
  for (const [label, value] of encodedForms) {
    capture.logger.info({ note: value }, `encoded ${label}`);
    capture.logger.info({}, `interpolated ${value}`);
  }

  // 正常含百分号的文本不得被无界重复解码，也不得被误伤。
  const benign = ["100% done", "50%25 complete", "%", "%%%%", "a%b%c"];
  for (const value of benign) {
    capture.logger.info({ progress: value }, "benign percent text");
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `re-decoding must stay bounded, took ${String(elapsed)}ms`);

  assertClean(capture.output(), "percent-encoded forms");
  for (const value of benign) {
    assert.equal(
      capture.output().includes(value),
      true,
      `${value} is harmless and must survive`,
    );
  }
});

test("the real Fastify request log rejects encoded connection secrets", async () => {
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
    operations: new Proxy({}, { get: () => unavailable }) as never,
    readiness: async () => true,
  });
  try {
    // 请求目标完全由调用方控制：单重、双重与畸形前缀三种编码都要在**最终
    // Pino 输出**上被拦住，而不只是在 helper 的单测里。
    for (const encodedTarget of [
      encodeURIComponent(dsn),
      encodeURIComponent(encodeURIComponent(dsn)),
      `%ZZ${encodeURIComponent(dsn)}`,
      encodeURIComponent(`host=db password='${quoted}'`),
    ]) {
      await app.inject({
        method: "GET",
        url: `/api/v1/not-a-route/${encodedTarget}`,
      });
    }
  } finally {
    await app.close();
  }

  assertClean(capture.output(), "encoded request targets");

  // 脱敏不能靠把请求信息一起丢掉来「通过」。
  const entries = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const request = entries.find((entry) => entry["req"] !== undefined)?.[
    "req"
  ] as Record<string, unknown> | undefined;
  assert.ok(request);
  assert.equal(request["method"], "GET");
  assert.equal(typeof request["path"], "string");
  assert.equal(typeof request["remoteAddress"], "string");
  const response = entries.find((entry) => entry["res"] !== undefined)?.[
    "res"
  ] as Record<string, unknown> | undefined;
  assert.ok(response);
  assert.equal(response["statusCode"], 404);
});
