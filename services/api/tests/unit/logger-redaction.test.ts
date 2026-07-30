import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import {
  captureRequestLogSnapshot,
  createLogger,
} from "../../src/logging.js";

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

  // 4. redact：第八轮起整条拒绝，不再包装 censor（见下面那条专门的用例）。
  //    这里只确认「拒绝」这件事本身不会把已经写出去的日志弄脏。
  for (const censor of [() => dsn, encodedDsn]) {
    assert.throws(
      () =>
        capture.logger.child(
          { component: "censor" },
          { redact: { paths: ["secretish"], censor } } as never,
        ),
      /child loggers may not configure redact/,
    );
  }

  // 5. msgPrefix：它是在我们的 logMethod 之后才拼到 msg 前面的。
  const withPrefix = capture.logger.child(
    { component: "prefix" },
    { msgPrefix: `[${dsn}] ` },
  );
  withPrefix.info("child msgPrefix");

  assertClean(capture.output(), "child options");
  for (const marker of ["serializer", "formatter", "bindings", "prefix"]) {
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

test("child redact is rejected whatever shape its censor has", () => {
  const capture = capturingLogger();

  // 第七轮的做法是「按 Pino 契约检查 censor 形态、合法的就包装」。第八轮改成
  // **整条拒绝**：路径语义本身就能决定哪些键走 pino 的 redactor，而那条路径会先
  // 克隆再序列化克隆体，克隆体带不上容器的 `toJSON` 遮蔽。因此不再区分形态。
  for (const censor of [
    { leaked: dsn },
    [dsn],
    42,
    true,
    null,
    () => dsn,
    "[Redacted]",
    undefined,
  ]) {
    assert.throws(
      () =>
        childWithOptions(
          capture.logger,
          { component: "censor" },
          { redact: { paths: ["secretish"], censor } },
        ),
      /child loggers may not configure redact/,
      `censor ${JSON.stringify(censor)} must still be rejected`,
    );
  }

  // 数组形态的 redact（纯路径列表）同样拒绝。
  assert.throws(
    () =>
      childWithOptions(
        capture.logger,
        { component: "paths" },
        { redact: ["secretish"] },
      ),
    /child loggers may not configure redact/,
  );

  assert.equal(capture.output(), "", "no rejected child may emit anything");
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

// ---------------------------------------------------------------------------
// 信任上下文：只有真正的顶层 log record 能把 req/res/err 延后给固定 serializer
// ---------------------------------------------------------------------------

test("no untrusted path inherits the req/res/err exemption", () => {
  const capture = capturingLogger();

  // 1. formatters.level 的返回值。
  childWithOptions(
    capture.logger,
    { component: "level" },
    {
      formatters: {
        level: (label: string, number: number) => ({
          level: number,
          req: dsn,
          res: { statusCode: dsn },
        }),
      },
    },
  ).info("level formatter");

  // 2. 普通 log object 里伪造的 req/res/err。
  capture.logger.info({ req: dsn }, "fake req string");
  capture.logger.info({ req: { method: dsn, url: dsn } }, "fake req object");
  capture.logger.info({ res: { statusCode: dsn } }, "fake res");
  capture.logger.info(
    { err: { type: dsn, message: "request failed" } },
    "fake err",
  );

  // 3. child binding 里伪造的 req。
  capture.logger.child({ req: dsn, component: "child-req" }).info("child req");
  capture.logger
    .child({ req: { method: dsn }, component: "child-req-object" })
    .info("child req object");

  // 4. formatters.bindings 的返回值。
  childWithOptions(
    capture.logger,
    { component: "bindings" },
    {
      formatters: {
        bindings: (bindings: object) => ({ ...bindings, req: dsn }),
      },
    },
  ).info("bindings formatter");

  // 5. 调用方 serializer 的返回值。
  childWithOptions(
    capture.logger,
    { component: "serializer" },
    { serializers: { payload: () => ({ req: dsn, res: { statusCode: dsn } }) } },
  ).info({ payload: {} }, "child serializer");

  assertClean(capture.output(), "req/res/err exemption");
  for (const marker of [
    "level",
    "child-req",
    "child-req-object",
    "bindings",
    "serializer",
  ]) {
    assert.equal(
      capture.output().includes(marker),
      true,
      `${marker} must still be emitted`,
    );
  }
});

test("an error type can never carry caller-controlled text", () => {
  const capture = capturingLogger();

  // 真实 Error，但 name 被写成一整条连接串。
  const named = new Error("boom");
  named.name = dsn;
  capture.logger.error({ err: named }, "named error");
  capture.logger.error(named, "named error as first argument");
  capture.logger.info({ nested: { cause: named } }, "nested named error");

  // 伪造的「已归一化」形状：不能借它把任意 type 送进输出。
  capture.logger.error(
    { err: { type: dsn, message: "request failed" } },
    "forged normalized error",
  );
  capture.logger.error(
    { err: { type: `${quoted}`, message: "request failed" } },
    "forged normalized error 2",
  );

  // 合法类名仍然保留，诊断价值不丢。
  const typed = new Error("boom");
  typed.name = "MigrationLockTimeoutError";
  capture.logger.error({ err: typed }, "typed error");

  assertClean(capture.output(), "error type");
  assert.equal(
    capture.output().includes('"type":"MigrationLockTimeoutError"'),
    true,
    "a well-formed error class name must survive",
  );
  assert.equal(capture.output().includes("request failed"), true);
});

test("secrets used as property names are redacted, collisions included", () => {
  const capture = capturingLogger();
  const conninfo = `host=db user=app password='${quoted}'`;

  capture.logger.info(
    {
      [dsn]: "first",
      [encodedDsn]: "second",
      [conninfo]: "third",
      [encodeURIComponent(encodeURIComponent(dsn))]: "fourth",
      safe: "visible",
    },
    "secret keys",
  );
  capture.logger.child({ [dsn]: "binding" }).info("secret key binding");
  capture.logger.info({ nested: { [dsn]: "deep" } }, "nested secret key");

  assertClean(capture.output(), "secret property names");
  assert.equal(capture.output().includes("visible"), true);

  // 塌缩到同一个占位名的键必须确定地编号，而不是互相覆盖。
  const record = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry["msg"] === "secret keys");
  assert.ok(record);
  const placeholders = Object.keys(record).filter((key) =>
    key.startsWith("[RedactedKey]"),
  );
  assert.equal(placeholders.length, 4);
  assert.deepEqual(
    [...placeholders].sort(),
    ["[RedactedKey]", "[RedactedKey]:2", "[RedactedKey]:3", "[RedactedKey]:4"],
  );
});

test("percent-decoding is bounded and fails closed at its limit", () => {
  const capture = capturingLogger();
  const conninfo = `host=db user=app password='${quoted}'`;
  const layered = (value: string, layers: number): string => {
    let encoded = value;
    for (let round = 0; round < layers; round += 1) {
      encoded = encodeURIComponent(encoded);
    }
    return encoded;
  };

  const started = Date.now();
  for (const layers of [1, 2, 3, 4, 5, 8]) {
    capture.logger.info({ note: layered(dsn, layers) }, `dsn x${String(layers)}`);
    capture.logger.info({}, `interpolated ${layered(dsn, layers)}`);
  }
  capture.logger.info({ note: layered(conninfo, 5) }, "conninfo x5");
  capture.logger.info({ note: `%ZZ${layered(dsn, 3)}` }, "malformed prefix");
  capture.logger.info({ note: `%ZZ${layered(dsn, 6)}` }, "malformed deep");
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 2_000,
    `bounded re-decoding must stay fast, took ${String(elapsed)}ms`,
  );

  assertClean(capture.output(), "layered encodings");

  // 无害的百分号文本不得被误伤。
  const benign = capturingLogger();
  const harmless = ["100% done", "50%25 complete", "%", "%%%%", "a%b%c", "100%"];
  for (const value of harmless) {
    benign.logger.info({ progress: value }, "benign");
  }
  for (const value of harmless) {
    assert.equal(
      benign.output().includes(value),
      true,
      `${value} must survive untouched`,
    );
  }
});

test("layered encodings are also stopped in the real Fastify request log", async () => {
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
    const layered = (value: string, layers: number): string => {
      let encoded = value;
      for (let round = 0; round < layers; round += 1) {
        encoded = encodeURIComponent(encoded);
      }
      return encoded;
    };
    for (const layers of [1, 2, 3, 4, 5, 8]) {
      await app.inject({
        method: "GET",
        url: `/api/v1/not-a-route/${layered(dsn, layers)}`,
      });
    }
    await app.inject({
      method: "GET",
      url: `/api/v1/not-a-route/${layered(`host=db password='${quoted}'`, 5)}`,
    });
    await app.inject({ method: "GET", url: "/healthz" });
  } finally {
    await app.close();
  }

  assertClean(capture.output(), "layered request targets");

  // 正常请求字段必须继续存在。
  const entries = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const healthRequest = entries
    .map((entry) => entry["req"] as Record<string, unknown> | undefined)
    .find((request) => request?.["path"] === "/healthz");
  assert.ok(healthRequest, "the untouched request must keep its real path");
  assert.equal(healthRequest["method"], "GET");
  assert.equal(typeof healthRequest["requestId"], "string");
  assert.equal(typeof healthRequest["remoteAddress"], "string");
  const response = entries.find((entry) => entry["res"] !== undefined)?.[
    "res"
  ] as Record<string, unknown> | undefined;
  assert.ok(response);
  assert.equal(typeof response["statusCode"], "number");
});

// ---------------------------------------------------------------------------
// Pino 会从 Error.message 自动生成顶层 msg——那条路径绕过 serializer
// ---------------------------------------------------------------------------

test("an error message never becomes the automatic top-level msg", () => {
  const shapes: readonly [string, (logger: ReturnType<typeof createLogger>) => void][] =
    [
      ["error(new Error(dsn))", (logger) => logger.error(new Error(dsn))],
      [
        "error(new Error(dsn), undefined)",
        (logger) => logger.error(new Error(dsn), undefined),
      ],
      [
        "error({ err: new Error(dsn) })",
        (logger) => logger.error({ err: new Error(dsn) }),
      ],
      [
        "error({ err: new Error(dsn) }, undefined)",
        (logger) => logger.error({ err: new Error(dsn) }, undefined),
      ],
      [
        "error(new Error(encodedDsn))",
        (logger) => logger.error(new Error(encodedDsn)),
      ],
      [
        "error({ err: new Error(conninfo) })",
        (logger) =>
          logger.error({ err: new Error(`host=db password='${quoted}'`) }),
      ],
      [
        "warn({ err: new Error(dsn) }) without a message",
        (logger) => logger.warn({ err: new Error(dsn) }),
      ],
    ];

  for (const [label, emit] of shapes) {
    const capture = capturingLogger();
    emit(capture.logger);
    assertClean(capture.output(), label);

    // 顶层 msg 只可能是固定安全串，绝不是 Error.message。
    const record = JSON.parse(capture.output().trim()) as Record<
      string,
      unknown
    >;
    assert.equal(
      record["msg"],
      "request failed",
      `${label}: msg must be the fixed safe string`,
    );
    assert.deepEqual(record["err"], {
      type: "Error",
      message: "request failed",
    });
  }
});

test("the error type comes from an exact allowlist, not a name pattern", () => {
  const capture = capturingLogger();

  // 完全符合类名文法、却是攻击面可写的自由文本：必须降级为 Error。
  const unlisted = [
    "SimplePasswordSecret123",
    "NotOnTheList",
    "PostgresqlConnectionString",
    "",
  ];
  unlisted.forEach((name, index) => {
    const error = new Error("boom");
    error.name = name;
    // msg 里**不能**回显 name，否则下面「名字不得出现在输出里」的断言会被
    // 用例自己写进去的字符串满足，等于白测。
    capture.logger.error({ err: error }, `unlisted ${index}`);
  });

  // 本仓库真实定义的错误类与内建类型仍按明确策略保留。
  const listed = [
    "SecretSourceError",
    "MigrationLockTimeoutError",
    "AppError",
    "TypeError",
  ];
  listed.forEach((name, index) => {
    const error = new Error("boom");
    error.name = name;
    capture.logger.error({ err: error }, `listed ${index}`);
  });

  const types = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        (JSON.parse(line) as { err: { type: string } }).err.type,
    );
  assert.deepEqual(types, [
    "Error",
    "Error",
    "Error",
    "Error",
    "SecretSourceError",
    "MigrationLockTimeoutError",
    "AppError",
    "TypeError",
  ]);
  assert.equal(
    capture.output().includes("SimplePasswordSecret123"),
    false,
    "an unlisted name must not reach the output at all",
  );
  assertClean(capture.output(), "error type allowlist");
});

// ---------------------------------------------------------------------------
// strict canonicalizer 不得执行输入自带的转换方法
// ---------------------------------------------------------------------------

test("the canonicalizer never runs input-supplied conversion methods", () => {
  const capture = capturingLogger();

  // 1. 数组的 `map`：必须**一次都不被调用**。
  let mapCalls = 0;
  const hostileArray: unknown[] = ["first", "second"];
  Object.defineProperty(hostileArray, "map", {
    value: () => {
      mapCalls += 1;
      return [{ toJSON: () => dsn }];
    },
    configurable: true,
    writable: true,
  });
  // 迭代器同样不可信。
  Object.defineProperty(hostileArray, Symbol.iterator, {
    value: () => {
      mapCalls += 1;
      return [{ toJSON: () => dsn }][Symbol.iterator]();
    },
    configurable: true,
    writable: true,
  });

  capture.logger.info({ hostileArray }, "hostile array in a log record");
  capture.logger.child({ hostileArray }).info("hostile array in a binding");
  capture.logger.setBindings({ hostileArray });
  capture.logger.info("hostile array after setBindings");
  childWithOptions(
    capture.logger,
    { component: "serializer" },
    { serializers: { payload: () => hostileArray } },
  ).info({ payload: {} }, "hostile array from a serializer");
  childWithOptions(
    capture.logger,
    { component: "formatter" },
    { formatters: { bindings: () => ({ hostileArray }) } },
  ).info("hostile array from a bindings formatter");

  assert.equal(
    mapCalls,
    0,
    "the canonicalizer must not call map or the iterator on untrusted input",
  );
  assertClean(capture.output(), "hostile array");
  assert.equal(capture.output().includes("first"), true);

  // 2. BigInt：不得调用可覆写的 BigInt.prototype.toString。
  const originalToString = BigInt.prototype.toString;
  const bigIntCapture = capturingLogger();
  Object.defineProperty(BigInt.prototype, "toString", {
    value: () => dsn,
    configurable: true,
    writable: true,
  });
  try {
    bigIntCapture.logger.info({ big: 10n }, "bigint in a log record");
    bigIntCapture.logger.child({ big: 11n }).info("bigint in a binding");
    bigIntCapture.logger.setBindings({ big: 12n });
    bigIntCapture.logger.info("bigint after setBindings");
  } finally {
    Object.defineProperty(BigInt.prototype, "toString", {
      value: originalToString,
      configurable: true,
      writable: true,
    });
  }
  assertClean(bigIntCapture.output(), "overridden BigInt.prototype.toString");
  assert.equal(bigIntCapture.output().includes('"big":"10"'), true);

  // 3. 结构键不能让 pino 崩溃，也不能触发原型 setter。
  const structural = capturingLogger();
  const shadowed = JSON.parse(
    '{"hasOwnProperty":"shadowed","safe":"x"}',
  ) as Record<string, unknown>;
  structural.logger.info(shadowed, "shadowed hasOwnProperty");
  structural.logger.child(shadowed).info("shadowed binding");
  const polluting = JSON.parse(
    '{"__proto__":{"polluted":true},"safe":"y"}',
  ) as Record<string, unknown>;
  structural.logger.info(polluting, "proto key");
  structural.logger.child(polluting).info("proto key binding");
  structural.logger.setBindings(polluting);
  structural.logger.info("proto key after setBindings");

  assert.equal(
    ({} as Record<string, unknown>)["polluted"],
    undefined,
    "Object.prototype must not be polluted",
  );
  assert.equal(structural.output().includes("shadowed"), true);
  assert.equal(structural.output().includes('"safe":"x"'), true);
  // 结构键被改名，因此 pino 自己的 `bindings.hasOwnProperty(key)` 不会被遮蔽。
  assert.equal(
    structural.output().includes("[Structural]hasOwnProperty"),
    true,
  );
  assert.equal(structural.output().includes("[Structural]__proto__"), true);

  // 4. getter 只被记录、绝不被调用。
  const accessor = capturingLogger();
  let getterCalls = 0;
  accessor.logger.info(
    {
      get sneaky() {
        getterCalls += 1;
        return dsn;
      },
      safe: "visible",
    },
    "accessor",
  );
  assert.equal(getterCalls, 0, "an untrusted getter must never be invoked");
  assertClean(accessor.output(), "accessor");
  assert.equal(accessor.output().includes("[Getter]"), true);
  assert.equal(accessor.output().includes("visible"), true);
});

// ---------------------------------------------------------------------------
// 第七轮：descriptor-safe 读取
// ---------------------------------------------------------------------------

test("array indices are read by descriptor, never by invoking them", () => {
  const capture = capturingLogger();
  let getterCalls = 0;

  // 1. 索引访问器返回 Secret。
  const leaking: unknown[] = ["visible"];
  leaking.length = 3;
  Object.defineProperty(leaking, 1, {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return dsn;
    },
  });

  // 2. 索引访问器抛错——日志调用绝不能因此炸掉。
  Object.defineProperty(leaking, 2, {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error(`index getter exploded ${password}`);
    },
  });

  // 3. 索引访问器篡改 Array/Object 的 prototype.toJSON——如果它被执行，
  //    后面的 JSON.stringify 阶段就会替攻击者把 Secret 写出来。
  const hostile: unknown[] = [];
  hostile.length = 1;
  Object.defineProperty(hostile, 0, {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      (Array.prototype as unknown as { toJSON?: unknown }).toJSON = () => dsn;
      (Object.prototype as unknown as { toJSON?: unknown }).toJSON = () => dsn;
      return "unused";
    },
  });

  try {
    capture.logger.info({ leaking }, "index accessors in a log record");
    capture.logger.child({ leaking }).info("index accessors in a binding");
    capture.logger.setBindings({ leaking });
    capture.logger.info("index accessors after setBindings");
    childWithOptions(
      capture.logger,
      { component: "index-serializer" },
      { serializers: { payload: () => leaking } },
    ).info({ payload: {} }, "index accessors from a serializer");
    capture.logger.info({ hostile }, "prototype-poisoning index accessor");
  } finally {
    delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON;
    delete (Object.prototype as unknown as { toJSON?: unknown }).toJSON;
  }

  assert.equal(
    getterCalls,
    0,
    "an array index accessor must never be invoked by the logger",
  );
  assertClean(capture.output(), "array index accessors");
  assert.equal(capture.output().includes("visible"), true);
  assert.equal(
    capture.output().includes("[Getter]"),
    true,
    "an index accessor must still be reported as present",
  );
  assert.equal(
    (Array.prototype as unknown as { toJSON?: unknown }).toJSON,
    undefined,
    "Array.prototype must not have been touched",
  );
});

test("the error type is read by descriptor, inherited accessors included", () => {
  const capture = capturingLogger();
  let getterCalls = 0;

  // 1. 自身访问器。
  const own = new Error("boom");
  Object.defineProperty(own, "name", {
    configurable: true,
    get() {
      getterCalls += 1;
      return "SecretSourceError";
    },
  });

  // 2. **继承**访问器：getOwnPropertyDescriptor(instance, "name") 是 undefined，
  //    但 `value.name` 照样会把原型上的 getter 执行掉。
  class InheritedAccessorError extends Error {
    override get name(): string {
      getterCalls += 1;
      return "SecretSourceError";
    }
  }

  // 3. 抛错的访问器：日志调用不得被它带走。
  class ThrowingNameError extends Error {
    override get name(): string {
      getterCalls += 1;
      throw new Error(`name getter exploded ${password}`);
    }
  }

  // 4. 伪造的归一化形状，type 是访问器。
  const forgedNormalized = {
    message: "request failed",
    get type() {
      getterCalls += 1;
      return "SecretSourceError";
    },
  };

  capture.logger.error({ err: own }, "own name accessor");
  capture.logger.error({ err: new InheritedAccessorError("boom") }, "inherited");
  capture.logger.error({ err: new ThrowingNameError("boom") }, "throwing");
  capture.logger.error({ err: forgedNormalized }, "forged normalized");

  assert.equal(
    getterCalls,
    0,
    "an error name/type accessor must never be invoked",
  );

  const types = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { err: { type: string } }).err.type);
  assert.deepEqual(
    types,
    ["Error", "Error", "Error", "Error"],
    "an accessor-backed name proves nothing, so it must fail closed to Error",
  );
  assertClean(capture.output(), "error name accessors");

  // 数据属性形态的真实类型仍然保留——降级不能靠把所有类型都抹掉来实现。
  const kept = capturingLogger();
  const real = new Error("boom");
  real.name = "Stage06ManifestError";
  kept.logger.error({ err: real }, "data property name");
  assert.equal(
    (JSON.parse(kept.output().trim()) as { err: { type: string } }).err.type,
    "Stage06ManifestError",
  );
});

test("a forged req or res gets no serializer trust, a real one keeps its fields", async () => {
  const capture = capturingLogger();
  let getterCalls = 0;

  const forgedRequest = {
    get id() {
      getterCalls += 1;
      return dsn;
    },
    get method() {
      getterCalls += 1;
      return dsn;
    },
    get url() {
      getterCalls += 1;
      throw new Error(`url getter exploded ${password}`);
    },
    get ip() {
      getterCalls += 1;
      return dsn;
    },
    get socket() {
      getterCalls += 1;
      return { remoteAddress: dsn };
    },
    get raw() {
      getterCalls += 1;
      return { url: dsn, method: dsn, socket: { remoteAddress: dsn } };
    },
  };
  const forgedResponse = {
    get statusCode() {
      getterCalls += 1;
      return dsn;
    },
  };

  capture.logger.info({ req: forgedRequest }, "forged req");
  capture.logger.info({ res: forgedResponse }, "forged res");
  capture.logger.child({ req: forgedRequest }).info("forged req binding");
  childWithOptions(
    capture.logger,
    { component: "forged-serializer" },
    { serializers: { payload: () => ({ req: forgedRequest }) } },
  ).info({ payload: {} }, "forged req from a serializer");

  assert.equal(
    getterCalls,
    0,
    "a forged req/res accessor must never be invoked by the fixed serializers",
  );
  assertClean(capture.output(), "forged req/res");

  // 真实请求这一侧不能因为收紧而被掏空。
  const config = loadConfig({
    NODE_ENV: "test",
    DEPLOYMENT_STAGE: "local-test",
    DEPLOYMENT_EXPOSURE: "loopback",
    DATABASE_URL:
      "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent",
    WECHAT_ADAPTER: "fake",
    LOG_LEVEL: "info",
  });
  const genuine = capturingLogger();
  const unavailable = async (): Promise<never> => {
    throw new Error("operation should not be called");
  };
  const app = await buildApp({
    config,
    logger: genuine.logger,
    operations: new Proxy({}, { get: () => unavailable }) as never,
    readiness: async () => true,
  });
  try {
    await app.inject({ method: "GET", url: "/healthz?trace=1" });
  } finally {
    await app.close();
  }
  const entries = genuine
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const request = entries.find((entry) => entry["req"] !== undefined)?.[
    "req"
  ] as Record<string, unknown> | undefined;
  assert.ok(request, "a genuine request entry must still exist");
  assert.equal(request["method"], "GET");
  assert.equal(request["path"], "/healthz");
  assert.equal(typeof request["requestId"], "string");
  assert.equal(typeof request["remoteAddress"], "string");
  assert.notEqual(request["remoteAddress"], "");
  const response = entries.find((entry) => entry["res"] !== undefined)?.[
    "res"
  ] as Record<string, unknown> | undefined;
  assert.equal(response?.["statusCode"], 200);
});

test("an explicitly passed error message never becomes the top-level msg", () => {
  const capture = capturingLogger();

  // Fastify 的 defaultErrorLog 走的正是这个形状：
  //   reply.log.error({ req, res, err }, error?.message)
  // msg 是**显式传入的字符串**，因此绕开了「pino 从 err.message 自动生成 msg」
  // 那条已经封掉的路径。
  const failure = new Error(`upstream refused ${password}`);
  capture.logger.error({ err: failure }, failure.message);
  capture.logger.error(failure, failure.message);

  assertClean(capture.output(), "explicitly passed error message");
  for (const line of capture.output().split("\n").filter(Boolean)) {
    const record = JSON.parse(line) as Record<string, unknown>;
    assert.equal(record["msg"], "request failed");
  }
});

// ---------------------------------------------------------------------------
// 第七轮自查：对抗性复核找出来的绕过，逐条钉死
// ---------------------------------------------------------------------------

test("prototype pollution cannot re-materialise a secret at stringify time", () => {
  // canonicalizer 造出来的 `{}` / `[]` 仍然继承 Object/Array.prototype。往那上面
  // 挂一个 toJSON，`JSON.stringify` 阶段就会调用它，整棵已经脱敏干净的树被一句
  // 返回值替换掉。索引访问器那条路已经堵上，但 Proxy 的 trap 仍能在枚举过程中
  // 完成污染，所以拦截点必须在**新建容器**那一侧。
  for (const target of [Object.prototype, Array.prototype]) {
    const capture = capturingLogger();
    (target as unknown as { toJSON?: unknown }).toJSON = () => dsn;
    try {
      capture.logger.info({ nested: { a: 1 }, items: [1, 2, 3] }, "polluted");
      capture.logger.child({ nested: { b: 2 } }).info("polluted binding");
      capture.logger.setBindings({ nested: { c: 3 } });
      capture.logger.info("polluted after setBindings");
    } finally {
      delete (target as unknown as { toJSON?: unknown }).toJSON;
    }
    assertClean(capture.output(), "prototype toJSON pollution");
    assert.equal(capture.output().includes('"a":1'), true, capture.output());
  }

  // Proxy 的 ownKeys trap 在我们枚举的过程中污染原型——这是文件头明确承认
  // 「trap 会执行」的那条路径，但它**不能**因此拿到「把 Secret 原样写出去」。
  const capture = capturingLogger();
  const payload = new Proxy(
    {},
    {
      ownKeys(target) {
        (Object.prototype as unknown as { toJSON?: unknown }).toJSON = () => dsn;
        return Reflect.ownKeys(target);
      },
    },
  );
  try {
    capture.logger.info({ payload }, "ownKeys trap pollution");
  } finally {
    delete (Object.prototype as unknown as { toJSON?: unknown }).toJSON;
  }
  assertClean(capture.output(), "proxy ownKeys prototype pollution");
});

test("carrying a genuine raw request does not buy a forged wrapper any trust", async () => {
  // 上一版把「自身数据属性 `raw` 指向已登记的原始请求」当身份证明。`raw` 在
  // Fastify 5 的 Request 上就是**自身可枚举数据属性**，所以 `{ ...request }`、
  // `{ raw: request.raw, get ip() {…} }`、`Object.create(request, …)` 全都能过，
  // 随后又被当成可信对象做普通成员读取——调用方的 getter 照样执行。
  const config = loadConfig({
    NODE_ENV: "test",
    DEPLOYMENT_STAGE: "local-test",
    DEPLOYMENT_EXPOSURE: "loopback",
    DATABASE_URL:
      "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent",
    WECHAT_ADAPTER: "fake",
    LOG_LEVEL: "info",
  });
  const capture = capturingLogger();
  let getterCalls = 0;
  const unavailable = async (): Promise<never> => {
    throw new Error("operation should not be called");
  };
  const app = await buildApp({
    config,
    logger: capture.logger,
    operations: new Proxy({}, { get: () => unavailable }) as never,
    readiness: async () => true,
  });
  app.get("/probe", async (request, reply) => {
    const raw = (request as unknown as { raw: object }).raw;
    const forged = {
      raw,
      get id() {
        getterCalls += 1;
        return "FORGED-ID-SENTINEL";
      },
      get method() {
        getterCalls += 1;
        return "FORGED-METHOD-SENTINEL";
      },
      get ip() {
        getterCalls += 1;
        return "FORGED-IP-SENTINEL";
      },
      get url() {
        getterCalls += 1;
        return "/FORGED-URL-SENTINEL";
      },
      get socket() {
        getterCalls += 1;
        return { remoteAddress: "FORGED-ADDR-SENTINEL" };
      },
    };
    const spread = {
      ...(request as unknown as Record<string, unknown>),
      get ip() {
        getterCalls += 1;
        return "SPREAD-SENTINEL";
      },
    };
    const derived = Object.create(request as unknown as object, {
      ip: {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "PROTO-SENTINEL";
        },
      },
    }) as object;
    request.log.info({ req: forged }, "forged carrying a genuine raw");
    request.log.info({ req: spread }, "spread of a genuine request");
    request.log.info({ req: derived }, "prototype-derived request");
    request.log.info(
      {
        res: {
          request: { raw },
          get statusCode() {
            getterCalls += 1;
            return "FORGED-STATUS-SENTINEL";
          },
        },
      },
      "forged res carrying a genuine raw",
    );
    // 整个 raw 记在一个非 `req` 的键下面：rawHeaders 是扁平字符串数组，逐键规则
    // 看不见里面的 authorization / cookie。
    request.log.info({ ctx: raw }, "raw request under a non-req key");
    return reply.send({ ok: true });
  });
  try {
    await app.inject({
      method: "GET",
      url: "/probe",
      headers: {
        authorization: "Bearer TOKEN-SENTINEL",
        cookie: "session=COOKIE-SENTINEL",
      },
    });
  } finally {
    await app.close();
  }

  assert.equal(
    getterCalls,
    0,
    "carrying a genuine raw must not let a forged wrapper's accessors run",
  );
  for (const forgedValue of [
    "FORGED-ID-SENTINEL",
    "FORGED-METHOD-SENTINEL",
    "FORGED-IP-SENTINEL",
    "FORGED-URL-SENTINEL",
    "FORGED-ADDR-SENTINEL",
    "FORGED-STATUS-SENTINEL",
    "SPREAD-SENTINEL",
    "PROTO-SENTINEL",
  ]) {
    assert.equal(
      capture.output().includes(forgedValue),
      false,
      `${forgedValue} must never reach the log stream\n${capture.output()}`,
    );
  }
  assert.equal(
    capture.output().includes("TOKEN-SENTINEL"),
    false,
    `rawHeaders must not leak the Authorization header\n${capture.output()}`,
  );
  assert.equal(
    capture.output().includes("COOKIE-SENTINEL"),
    false,
    `rawHeaders must not leak the Cookie header\n${capture.output()}`,
  );

  // 真实请求日志仍然完整。
  const entries = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const incoming = entries.find((entry) => entry["msg"] === "incoming request")?.[
    "req"
  ] as Record<string, unknown> | undefined;
  assert.ok(incoming, "the genuine incoming-request entry must exist");
  assert.equal(incoming["method"], "GET");
  assert.equal(incoming["path"], "/probe");
  assert.equal(typeof incoming["requestId"], "string");
  assert.notEqual(incoming["requestId"], "");
  assert.equal(typeof incoming["remoteAddress"], "string");
  const completed = entries.find(
    (entry) => entry["msg"] === "request completed",
  )?.["res"] as Record<string, unknown> | undefined;
  assert.equal(completed?.["statusCode"], 200);
});

test("DOMException abort errors keep their type instead of collapsing", () => {
  // `AbortError` / `TimeoutError` 是 DOMException，它的 `name` 是
  // `DOMException.prototype` 上的**访问器**。纯数据属性规则会把它们全部折成
  // `Error`，那样 allowlist 里的这两条就成了永远打不出来的死条目。
  const capture = capturingLogger();
  capture.logger.error({ err: new DOMException("x", "AbortError") }, "abort");
  capture.logger.error({ err: new DOMException("x", "TimeoutError") }, "timeout");
  const controller = new AbortController();
  controller.abort();
  capture.logger.error({ err: controller.signal.reason }, "abort reason");
  // 名单之外的 DOMException 仍然降级。
  capture.logger.error({ err: new DOMException("x", "NotAllowedError") }, "other");

  const types = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { err: { type: string } }).err.type);
  assert.deepEqual(types, [
    "AbortError",
    "TimeoutError",
    "AbortError",
    "Error",
  ]);
  assertClean(capture.output(), "DOMException types");

  // 豁免只认 `DOMException.prototype` 这一个持有者身份，伪造的同名访问器仍然
  // 一律降级，且**不被执行**。
  const forged = capturingLogger();
  let getterCalls = 0;
  class FakeAbort extends Error {
    override get name(): string {
      getterCalls += 1;
      return "AbortError";
    }
  }
  forged.logger.error({ err: new FakeAbort("x") }, "forged abort");
  assert.equal(getterCalls, 0);
  assert.equal(
    (JSON.parse(forged.output().trim()) as { err: { type: string } }).err.type,
    "Error",
  );
});

// ---------------------------------------------------------------------------
// 第八轮：总控点名的六条现场反例
// ---------------------------------------------------------------------------

/** 不是连接串、也不含 `password=`，因此只能靠**键名规则**拦住。 */
const opaqueSecret = "OPAQUE-VALUE-SENTINEL";

test("an err record folds the explicit msg unconditionally", () => {
  const capture = capturingLogger();

  // 上一轮只在 msg 与 `err.message` **逐字相同**时才折叠。那条判据是可以绕开的：
  // 包装一层、截一段、加个前缀，msg 就不再相等，而它携带的仍然是同一段内部细节。
  // 现在只要 record 带 `err`，显式 msg 一律折成固定串。
  const failure = new Error(`upstream refused ${password}`);
  const shapes: readonly [string, () => void][] = [
    ["exact message", () => { capture.logger.error({ err: failure }, failure.message); }],
    ["wrapped message", () => { capture.logger.error({ err: failure }, `handler: ${failure.message}`); }],
    ["truncated message", () => { capture.logger.error({ err: failure }, failure.message.slice(0, 24)); }],
    ["unrelated message", () => { capture.logger.error({ err: failure }, `boom ${opaqueSecret}`); }],
    ["error as the record", () => { capture.logger.error(failure, `handler: ${failure.message}`); }],
    ["warn level", () => { capture.logger.warn({ err: failure }, `warn: ${failure.message}`); }],
  ];
  for (const [, emit] of shapes) {
    emit();
  }

  assertClean(capture.output(), "unconditional err msg folding");
  assert.equal(
    capture.output().includes(opaqueSecret),
    false,
    `an unrelated msg on an err record must not survive\n${capture.output()}`,
  );
  const messages = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { msg: string }).msg);
  assert.deepEqual(messages, shapes.map(() => "request failed"));

  // 不带 `err` 的普通日志不受影响——折叠不能靠把所有 msg 都抹掉来实现。
  const plain = capturingLogger();
  plain.logger.info({ component: "probe" }, "a perfectly ordinary message");
  assert.equal(
    (JSON.parse(plain.output().trim()) as { msg: string }).msg,
    "a perfectly ordinary message",
  );
});

test("a child logger may not bring its own redact at all", () => {
  const capture = capturingLogger();

  // 包装 censor 是不够的：`redact` 的路径语义本身就能决定**哪些键**被送进
  // pino 的 redactor，而那条路径会先克隆再序列化克隆体，克隆体带不上我们给容器
  // 加的 `toJSON` 遮蔽。根 logger 的 `redact` 已经整条移除，子 logger 也不能再
  // 把它带回来。Fastify 只会把 `serializers` 再传一遍（lib/logger-pino.js:34），
  // 从不传 `redact`，所以拒绝不影响兼容面。
  for (const redact of [
    { paths: ["*.authorization"], censor: "[Redacted]" },
    { paths: ["req.headers.cookie"] },
    ["*.token"],
    {},
  ]) {
    assert.throws(
      () => childWithOptions(capture.logger, { component: "child" }, { redact }),
      /child loggers may not configure redact/,
      `child redact ${JSON.stringify(redact)} must be rejected outright`,
    );
  }

  // 其它 options 不受影响。
  const child = childWithOptions(
    capture.logger,
    { component: "ok" },
    { level: "info" },
  );
  child.info("child without redact still works");
  assert.equal(capture.output().includes("ok"), true);
});

test("normalised header key names are redacted, set-cookie included", () => {
  const capture = capturingLogger();

  // `isSensitiveKey` 会先去掉分隔符再小写，所以名单里写 `"set-cookie"` 是永远
  // 匹配不上的——它归一化之后是 `setcookie`。同理，`rawTrailers` 与 `rawHeaders`
  // 一样是**扁平字符串数组**，逐键规则看不见里面的取值。
  capture.logger.info(
    {
      "set-cookie": opaqueSecret,
      setCookie: opaqueSecret,
      Set_Cookie: opaqueSecret,
      rawTrailers: ["authorization", opaqueSecret, "cookie", opaqueSecret],
      rawHeaders: ["authorization", opaqueSecret],
      safe: "visible",
    },
    "header shaped keys",
  );
  capture.logger
    .child({ "set-cookie": opaqueSecret, rawTrailers: [opaqueSecret] })
    .info("header shaped bindings");
  capture.logger.setBindings({ setCookie: opaqueSecret });
  capture.logger.info("header shaped after setBindings");

  assert.equal(
    capture.output().includes(opaqueSecret),
    false,
    `a normalised sensitive key must be redacted\n${capture.output()}`,
  );
  assert.equal(capture.output().includes("visible"), true);
});

test("the request identity is an immutable snapshot, not a read privilege", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DEPLOYMENT_STAGE: "local-test",
    DEPLOYMENT_EXPOSURE: "loopback",
    DATABASE_URL:
      "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent",
    WECHAT_ADAPTER: "fake",
    LOG_LEVEL: "info",
  });
  const capture = capturingLogger();
  let getterCalls = 0;
  const unavailable = async (): Promise<never> => {
    throw new Error("operation should not be called");
  };
  const app = await buildApp({
    config,
    logger: capture.logger,
    operations: new Proxy({}, { get: () => unavailable }) as never,
    readiness: async () => true,
  });
  app.get("/probe", async (request, reply) => {
    // 登记点捕获的是**不可变快照**，不是「以后可以读你的访问器」这项权利。因此
    // 即便有人把一个自造对象喂进登记入口，也只能得到一份用数据属性读出来的快照，
    // 换不来任何执行访问器的机会。
    const hostile = {
      get method() {
        getterCalls += 1;
        return "HOSTILE-METHOD-SENTINEL";
      },
      get url() {
        getterCalls += 1;
        return "/HOSTILE-URL-SENTINEL";
      },
      // `socket` 是**数据属性**，它里面的 `remoteAddress` 才是访问器。登记之后
      // 若还保留「可以在这个对象上做普通成员读取」这项权利，这个 getter 就会被
      // 执行——这正是公开 registrar 的实际危险，不只是架构洁癖。
      socket: {
        get remoteAddress() {
          getterCalls += 1;
          return "HOSTILE-ADDR-SENTINEL";
        },
      },
    };
    captureRequestLogSnapshot(hostile, "HOSTILE-ID-SENTINEL");
    request.log.info({ req: hostile }, "self-registered hostile object");
    request.log.info(
      { req: { raw: hostile } },
      "wrapper around a self-registered object",
    );

    // 真实请求的那份快照仍然完整。
    request.log.info({ req: request }, "genuine request relogged");
    return reply.send({ ok: true });
  });
  try {
    await app.inject({ method: "GET", url: "/probe?trace=1" });
  } finally {
    await app.close();
  }

  assert.equal(
    getterCalls,
    0,
    "registering an object must never let its accessors run",
  );
  for (const sentinel of [
    "HOSTILE-METHOD-SENTINEL",
    "HOSTILE-URL-SENTINEL",
    "HOSTILE-ADDR-SENTINEL",
  ]) {
    assert.equal(
      capture.output().includes(sentinel),
      false,
      `${sentinel} must never reach the log stream\n${capture.output()}`,
    );
  }

  const entries = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const genuine = entries.find(
    (entry) => entry["msg"] === "genuine request relogged",
  )?.["req"] as Record<string, unknown> | undefined;
  assert.ok(genuine, "the genuine request entry must exist");
  assert.equal(genuine["method"], "GET");
  assert.equal(genuine["path"], "/probe");
  assert.equal(typeof genuine["requestId"], "string");
  assert.equal(typeof genuine["remoteAddress"], "string");
});

test("a cyclic req wrapper is bounded instead of overflowing the stack", () => {
  const capture = capturingLogger();

  // `trustedRawOf` 会沿 `request` 往下找已登记的原始请求。两个互指的对象让它
  // 无限递归——一次日志调用就能把整个进程的栈耗光。
  const first: Record<string, unknown> = {};
  const second: Record<string, unknown> = { request: first };
  first["request"] = second;

  const selfReferential: Record<string, unknown> = {};
  selfReferential["request"] = { request: selfReferential };

  capture.logger.info({ req: first }, "two-cycle req");
  capture.logger.info({ res: second }, "two-cycle res");
  capture.logger.info({ req: selfReferential }, "self-referential req");

  // 深链同样必须有界，而不是靠「反正没人会写那么深」。
  let deep: Record<string, unknown> = { url: "/deep" };
  for (let level = 0; level < 5_000; level += 1) {
    deep = { request: deep };
  }
  capture.logger.info({ req: deep }, "deeply nested req");

  assert.equal(
    capture.output().split("\n").filter(Boolean).length,
    4,
    `every cyclic shape must still produce a log line\n${capture.output()}`,
  );
  assertClean(capture.output(), "cyclic req wrapper");
});

test("a mutated DOMException prototype getter is never executed", () => {
  const capture = capturingLogger();
  let getterCalls = 0;

  // `DOMException.prototype` 是可变的。只检查「持有者是 DOMException.prototype」
  // 而后调用**当时解析出来的** getter，等于把执行权交给了任何能改写那个原型的人。
  const original = Object.getOwnPropertyDescriptor(
    DOMException.prototype,
    "name",
  );
  assert.ok(original, "DOMException.prototype.name must be an accessor");
  Object.defineProperty(DOMException.prototype, "name", {
    configurable: true,
    get() {
      getterCalls += 1;
      return `AbortError${dsn}`;
    },
  });
  try {
    capture.logger.error({ err: new DOMException("x", "AbortError") }, "abort");
    capture.logger.error({ err: new Error("x") }, "plain error");
  } finally {
    Object.defineProperty(DOMException.prototype, "name", original);
  }

  assert.equal(
    getterCalls,
    0,
    "a replaced DOMException name getter must never be executed",
  );
  assertClean(capture.output(), "mutated DOMException prototype");
  const types = capture
    .output()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { err: { type: string } }).err.type);
  assert.deepEqual(types, ["Error", "Error"]);

  // 原型没有被改写时，真实的 AbortError 仍然如实输出。
  const intact = capturingLogger();
  intact.logger.error({ err: new DOMException("x", "AbortError") }, "abort");
  assert.equal(
    (JSON.parse(intact.output().trim()) as { err: { type: string } }).err.type,
    "AbortError",
  );
});
