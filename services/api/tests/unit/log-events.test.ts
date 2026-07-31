import assert from "node:assert/strict";
import { apiErrorStatus } from "@meal-agent/contracts/api";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import {
  createLoggingContext,
  eventErrorType,
  eventRequestId,
  type EventLogSink,
  type LogEventFields,
  type LogEventName,
} from "../../src/log-events.js";
import { createLogger } from "../../src/logging.js";

/**
 * 阶段 09A / M3A：typed facade 的反向测试，**全部走真实 `createLogger`**。
 *
 * 只断言「projector 返回了什么」是不够的——那证明不了最终写进流里的那一行是什么。
 * 这里每一条都扫描真实 Pino 的最终输出，sentinel 命中必须为 0。
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const opaqueSecret = "OPAQUE-FACADE-SENTINEL";
const sentinels = [opaqueSecret, "SENTINEL"] as const;
const requestId = "3f1d1a2c-9b4e-4f6a-8c1d-2e5b7a9c0d31";

interface Capture {
  readonly sink: EventLogSink;
  readonly root: ReturnType<typeof createLogger>;
  output: () => string;
}

const capturingSink = (): Capture => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const root = createLogger("info", stream);
  // 直接用生产工厂：event root 由它自己建，测试只提供目的地。
  const context = createLoggingContext("info", root, stream);
  return { sink: context.eventLog, root, output: () => output };
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

const lines = (output: string): readonly Record<string, unknown>[] =>
  output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** 绕过类型检查递交字段——模拟「有人用 `as` 硬塞」。 */
const emitUnchecked = (
  capture: Capture,
  event: LogEventName,
  fields: unknown,
): void => {
  capture.sink.emit(
    event as "request.rejected",
    fields as LogEventFields["request.rejected"],
  );
};

test("an extra primitive field never reaches the log line", () => {
  const capture = capturingSink();

  // projector 逐个字段按名字取值，因此多传的字段连读都不会被读到。
  emitUnchecked(capture, "request.rejected", {
    requestId,
    errorCode: "VALIDATION_FAILED",
    smuggled: opaqueSecret,
    anotherOne: 12345,
    flag: true,
  });

  assertClean(capture.output(), "extra primitive field");
  const [emitted] = lines(capture.output());
  assert.deepEqual(emitted, {
    level: 40,
    time: emitted?.["time"],
    requestId,
    errorCode: "VALIDATION_FAILED",
    statusCode: 400,
    event: "request.rejected",
    msg: "request rejected",
  });
});

test("a caller can never override the reserved event field", () => {
  const capture = capturingSink();

  emitUnchecked(capture, "request.rejected", {
    requestId,
    errorCode: "CONFLICT",
    event: `forged.${opaqueSecret}`,
  });

  assertClean(capture.output(), "event override");
  assert.equal(lines(capture.output())[0]?.["event"], "request.rejected");
});

test("statusCode is derived, so a contradictory pair cannot be built", () => {
  const capture = capturingSink();

  // 调用方连表达都表达不出「SESSION_EXPIRED 配 599」——字段里没有 statusCode。
  // 硬塞进去也没用：projector 根本不读它，statusCode 一律由 errorCode 派生。
  emitUnchecked(capture, "request.rejected", {
    requestId,
    errorCode: "SESSION_EXPIRED",
    statusCode: 599,
  });

  const [emitted] = lines(capture.output());
  assert.equal(emitted?.["errorCode"], "SESSION_EXPIRED");
  assert.equal(
    emitted?.["statusCode"],
    401,
    `statusCode must come from apiErrorStatus, not from the caller\n${capture.output()}`,
  );

  // **全量**覆盖：从 `apiErrorStatus` 自己生成用例，不再手写十个样例。手写样例
  // 只能证明被写下的那几个，而漏掉的恰恰是没人想到的那个。
  const derived = capturingSink();
  const codes = Object.keys(apiErrorStatus) as (keyof typeof apiErrorStatus)[];
  assert.ok(
    codes.length >= 18,
    `expected the full code table, got ${String(codes.length)}`,
  );
  for (const code of codes) {
    derived.sink.emit("request.rejected", {
      requestId: eventRequestId(requestId),
      errorCode: code,
    });
  }
  assert.deepEqual(
    lines(derived.output()).map((entry) => [
      entry["errorCode"],
      entry["statusCode"],
    ]),
    codes.map((code) => [code, apiErrorStatus[code]]),
  );
});

test("a declared string field cannot smuggle an opaque secret", () => {
  const capture = capturingSink();

  for (const [event, fields, field] of [
    ["request.failed", { requestId, errorType: opaqueSecret }, "errorType"],
    ["startup.failed", { errorType: `AppError${opaqueSecret}` }, "errorType"],
    ["request.rejected", { requestId, errorCode: opaqueSecret }, "errorCode"],
    [
      "request.rejected",
      { requestId: opaqueSecret, errorCode: "CONFLICT" },
      "requestId",
    ],
    ["shutdown.started", { signal: opaqueSecret }, "signal"],
  ] as const) {
    assert.throws(
      () => {
        emitUnchecked(capture, event, fields);
      },
      new RegExp(`field ${field} is not acceptable`),
      `${event}.${field} must fail closed on free text`,
    );
  }

  // 一条都没写出去。
  assert.equal(capture.output(), "");

  // 合法取值仍然如实输出。
  const ok = capturingSink();
  ok.sink.emit("request.failed", {
    requestId: eventRequestId(requestId),
    errorType: eventErrorType(new TypeError("boom")),
  });
  ok.sink.emit("shutdown.started", { signal: "SIGTERM" });
  const emitted = lines(ok.output());
  assert.equal(emitted[0]?.["errorType"], "TypeError");
  assert.equal(emitted[1]?.["signal"], "SIGTERM");
  assertClean(ok.output(), "legitimate fields");
});

test("a neutral-key opaque child binding can never reach a business event", () => {
  const capture = capturingSink();

  // 这是 sink 存在的**核心理由**。`traceContext` 是一个中性键——它不在敏感键名单
  // 里，也不可能在：中性键上的 Secret 在键名上看不出任何线索，靠黑名单补不完。
  //
  // 上一版的 `logEvent(logger, …)` 接受任意 logger，因此业务代码可以把这样一个
  // 带 binding 的子 logger 递进来，binding 里的取值就跟着每一条业务事件走。
  // 现在 sink 由 root logger 创建、闭包持有，业务代码根本没有把子 logger 递进去
  // 的入口。
  const child = capture.root.child({
    traceContext: opaqueSecret,
    correlation: opaqueSecret,
    tenantHint: opaqueSecret,
    component: "visible",
  });

  // 子 logger 自己打的一行确实带着那些中性键——中央边界对它们**没有**兜底，
  // 这一点必须如实承认（它属于框架日志那条路径，不属于业务事件）。
  child.info("framework style line");
  assert.equal(
    capture.output().includes(opaqueSecret),
    true,
    "a neutral-key binding is genuinely not covered by the key-name rules",
  );

  // 而业务事件走 sink，一条都带不上。
  const business = capturingSink();
  const businessChild = business.root.child({ traceContext: opaqueSecret });
  void businessChild;
  business.sink.emit("request.rejected", {
    requestId: eventRequestId(requestId),
    errorCode: "RATE_LIMITED",
  });
  assertClean(business.output(), "business event after a neutral-key child");
  assert.deepEqual(Object.keys(lines(business.output())[0] ?? {}).sort(), [
    "errorCode",
    "event",
    "level",
    "msg",
    "requestId",
    "statusCode",
    "time",
  ]);
});

test("every declared event round-trips through the real logger", () => {
  const capture = capturingSink();

  capture.sink.emit("request.failed", {
    requestId: eventRequestId(requestId),
    errorType: eventErrorType(new Error("boom")),
  });
  capture.sink.emit("request.rejected", {
    requestId: eventRequestId(requestId),
    errorCode: "SESSION_EXPIRED",
  });
  capture.sink.emit("shutdown.started", { signal: "SIGINT" });
  capture.sink.emit("shutdown.timed-out", {});
  capture.sink.emit("startup.failed", {
    errorType: eventErrorType(new RangeError("boom")),
  });

  assert.deepEqual(
    lines(capture.output()).map((entry) => [
      entry["event"],
      entry["msg"],
      entry["level"],
    ]),
    [
      ["request.failed", "request failed", 50],
      ["request.rejected", "request rejected", 40],
      ["shutdown.started", "graceful shutdown started", 30],
      ["shutdown.timed-out", "graceful shutdown timed out", 60],
      ["startup.failed", "API startup failed", 60],
    ],
  );
  assertClean(capture.output(), "declared events");
});

test("the sink exposes nothing but emit", () => {
  const capture = capturingSink();
  assert.deepEqual(Object.keys(capture.sink), ["emit"]);
  for (const escape of ["child", "setBindings", "logger", "root", "level"]) {
    assert.equal(
      (capture.sink as unknown as Record<string, unknown>)[escape],
      undefined,
      `the sink must not expose ${escape}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 第十三轮：EventLogSink 的可信边界
// ---------------------------------------------------------------------------

test("a pre-bound framework logger cannot pollute business events", async () => {
  // 组装根收到的 `options.logger` 只进 framework 那一侧。业务事件的底座由
  // `createLoggingContext()` 新建，调用方没有入口把预绑定的 logger 塞进去。
  let frameworkOutput = "";
  const frameworkStream = new Writable({
    write(chunk, _encoding, callback) {
      frameworkOutput += chunk.toString();
      callback();
    },
  });
  const preBound = createLogger("info", frameworkStream).child({
    traceContext: opaqueSecret,
    tenantHint: opaqueSecret,
  });

  let eventOutput = "";
  const eventStream = new Writable({
    write(chunk, _encoding, callback) {
      eventOutput += chunk.toString();
      callback();
    },
  });
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
    logger: preBound,
    eventLogDestination: eventStream,
    operations: new Proxy({}, { get: () => unavailable }) as never,
    readiness: async () => true,
  });
  try {
    // 触发一条业务事件（404 走 request.rejected）。
    await app.inject({ method: "GET", url: "/no-such-route" });
  } finally {
    await app.close();
  }

  // 框架日志确实带着预绑定的 binding——那是它自己的树，如实承认。
  assert.equal(
    frameworkOutput.includes(opaqueSecret),
    true,
    "the pre-bound framework binding is genuinely present on framework lines",
  );
  // 业务事件一条都没沾上。
  assert.equal(
    eventOutput.includes(opaqueSecret),
    false,
    `a pre-bound framework binding must never reach a business event\n${eventOutput}`,
  );
  const events = eventOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(events.length > 0, "a business event must have been emitted");
  assert.deepEqual(Object.keys(events[0] ?? {}).sort(), [
    "errorCode",
    "event",
    "level",
    "msg",
    "requestId",
    "statusCode",
    "time",
  ]);

  // 框架请求日志的字段仍然正常。
  const frameworkLines = frameworkOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const incoming = frameworkLines.find((line) => line["req"] !== undefined)?.[
    "req"
  ] as Record<string, unknown> | undefined;
  assert.ok(incoming, "the framework request log must still exist");
  assert.equal(incoming["method"], "GET");
  assert.equal(incoming["path"], "/no-such-route");
  assert.equal(typeof incoming["requestId"], "string");
  const completed = frameworkLines.find((line) => line["res"] !== undefined)?.[
    "res"
  ] as Record<string, unknown> | undefined;
  assert.equal(completed?.["statusCode"], 404);
});

test("mutating the framework root after sink creation cannot pollute events", () => {
  let frameworkOutput = "";
  const frameworkStream = new Writable({
    write(chunk, _encoding, callback) {
      frameworkOutput += chunk.toString();
      callback();
    },
  });
  let eventOutput = "";
  const eventStream = new Writable({
    write(chunk, _encoding, callback) {
      eventOutput += chunk.toString();
      callback();
    },
  });

  const context = createLoggingContext(
    "info",
    createLogger("info", frameworkStream),
    eventStream,
  );
  const sink = context.eventLog;

  // sink 建好之后再去改 framework root 的 bindings。
  context.framework.setBindings({ traceContext: opaqueSecret });
  context.framework.info("framework line after setBindings");

  sink.emit("request.rejected", {
    requestId: eventRequestId(requestId),
    errorCode: "FORBIDDEN",
  });

  assert.equal(
    frameworkOutput.includes(opaqueSecret),
    true,
    "the framework root genuinely picked up the new binding",
  );
  assert.equal(
    eventOutput.includes(opaqueSecret),
    false,
    `a later framework setBindings must never reach a business event\n${eventOutput}`,
  );
});

test("sink.emit cannot be replaced", () => {
  const capture = capturingSink();
  const sink = capture.sink as unknown as Record<string, unknown>;

  assert.equal(Object.isFrozen(sink), true, "the sink must be frozen");
  const descriptor = Object.getOwnPropertyDescriptor(sink, "emit");
  assert.equal(descriptor?.writable, false);
  assert.equal(descriptor?.configurable, false);

  // 直接赋值：非严格模式静默失败，严格模式抛错——两种都不能换掉它。
  try {
    sink["emit"] = (): void => {
      throw new Error("replaced emit must never run");
    };
  } catch {
    // 冻结对象在严格模式下抛错，这正是期望。
  }
  assert.throws(() => {
    Object.defineProperty(sink, "emit", {
      value: () => undefined,
      configurable: true,
    });
  });

  // 原来的 emit 仍然工作。
  capture.sink.emit("shutdown.timed-out", {});
  assert.equal(
    lines(capture.output())[0]?.["event"],
    "shutdown.timed-out",
    capture.output(),
  );
});

// ---------------------------------------------------------------------------
// 第十四轮：app.eventLog 的替换入口与日志生命周期
// ---------------------------------------------------------------------------

interface WiredApp {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly frameworkLines: () => string;
  readonly eventLines: () => string;
  readonly frameworkEnded: () => boolean;
  readonly eventWrites: () => number;
}

/** 用**默认生产接线**建一个 app：只注入 framework logger 与业务事件目的地。 */
const wireApp = async (options: { readonly delayWrites?: boolean } = {}): Promise<WiredApp> => {
  let frameworkOut = "";
  let ended = false;
  const frameworkStream = new Writable({
    write(chunk, _encoding, callback) {
      frameworkOut += chunk.toString();
      callback();
    },
    final(callback) {
      ended = true;
      callback();
    },
  });
  let eventOut = "";
  let writes = 0;
  const eventStream = new Writable({
    write(chunk, _encoding, callback) {
      writes += 1;
      const persist = (): void => {
        eventOut += chunk.toString();
        callback();
      };
      if (options.delayWrites === true) {
        // 迟到的写入：回调被推到下一个 tick 之后才完成。
        setTimeout(persist, 5);
        return;
      }
      persist();
    },
  });

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
    logger: createLogger("info", frameworkStream),
    eventLogDestination: eventStream,
    operations: new Proxy({}, { get: () => unavailable }) as never,
    readiness: async () => true,
  });
  return {
    app,
    frameworkLines: () => frameworkOut,
    eventLines: () => eventOut,
    frameworkEnded: () => ended,
    eventWrites: () => writes,
  };
};

test("app.eventLog is read-only and the error handler never reads it", async () => {
  const wired = await wireApp();
  const app = wired.app as unknown as Record<string, unknown>;

  const descriptor = Object.getOwnPropertyDescriptor(app, "eventLog");
  assert.equal(descriptor?.writable, false, "eventLog must not be writable");
  assert.equal(
    descriptor?.configurable,
    false,
    "eventLog must not be configurable",
  );

  // 1. 直接赋值：非严格模式静默失败，严格模式抛错——两种都不能换掉它。
  let replacementRan = false;
  const replacement = {
    emit: (): void => {
      replacementRan = true;
    },
  };
  try {
    app["eventLog"] = replacement;
  } catch {
    // 只读属性在严格模式下抛错，这正是期望。
  }
  assert.notEqual(app["eventLog"], replacement, "assignment must not take");

  // 2. defineProperty 同样失败。
  assert.throws(() => {
    Object.defineProperty(app, "eventLog", {
      value: replacement,
      configurable: true,
    });
  });

  // 3. 业务事件仍然走原来的 sink——错误处理器读的是词法闭包，不是这个属性。
  try {
    await wired.app.inject({ method: "GET", url: "/no-such-route" });
  } finally {
    await wired.app.close();
  }
  assert.equal(replacementRan, false, "the replacement sink must never run");
  const events = wired
    .eventLines()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events[0]?.["event"], "request.rejected");
  assert.equal(events[0]?.["statusCode"], 404);
});

test("close flushes the owned event logger exactly once and never ends the injected stream", async () => {
  const wired = await wireApp({ delayWrites: true });
  await wired.app.inject({ method: "GET", url: "/no-such-route" });

  // 迟到的写入：close 返回之后，业务事件必须已经落到目的地。
  await wired.app.close();
  assert.ok(
    wired.eventLines().includes('"event":"request.rejected"'),
    `a delayed write must have landed before close resolved\n${wired.eventLines()}`,
  );
  const writesAfterClose = wired.eventWrites();

  // 再关一次：exactly-once——不会再产生任何写入。
  await wired.app.close();
  assert.equal(
    wired.eventWrites(),
    writesAfterClose,
    "closing twice must not flush or write again",
  );

  // 调用方注入的 Writable 归调用方所有：我们既不 end 它也不 final 它。
  assert.equal(
    wired.frameworkEnded(),
    false,
    "an injected framework stream must never be ended by us",
  );
});

test("the logging context close is idempotent by identity", async () => {
  const context = createLoggingContext("info", createLogger("info"), new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }));
  const first = context.close();
  const second = context.close();
  assert.equal(first, second, "close must return the very same promise");
  await first;
  await second;
});

// ---------------------------------------------------------------------------
// 第十四轮收尾：close 必须有界且 fail closed
// ---------------------------------------------------------------------------

/**
 * 一个可观测的目的地。
 *
 * pino 只在目的地的 `flush` 是**函数**时才把回调交出去（`lib/proto.js:253`:
 * `typeof stream.flush === 'function'`），所以这里显式挂一个 `flush`，才谈得上
 * 「flush 报错」与「flush 回调不来」这两种收场。
 */
interface ProbeDestination {
  readonly stream: Writable;
  flushes: () => number;
  ended: () => boolean;
}

const probeDestination = (
  behaviour: "ok" | "error" | "hang",
  options: { readonly stallWrites?: boolean } = {},
): ProbeDestination => {
  let flushes = 0;
  let ended = false;
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      if (options.stallWrites === true) {
        // 永远不回调：目的地卡住，`writableLength` 一直不降。
        return;
      }
      callback();
    },
    final(callback) {
      ended = true;
      callback();
    },
  });
  Object.defineProperty(stream, "flush", {
    value: (callback: (error?: Error | null) => void): void => {
      flushes += 1;
      if (behaviour === "hang") {
        return;
      }
      callback(
        behaviour === "error"
          ? new Error(`flush failed: ${opaqueSecret}`)
          : null,
      );
    },
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return {
    stream,
    flushes: () => flushes,
    ended: () => ended,
  };
};

test("close rejects when the owned event logger fails to flush", async () => {
  const destination = probeDestination("error");
  const context = createLoggingContext(
    "info",
    createLogger("info"),
    destination.stream,
  );
  context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });

  const failure = await context.close().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(
    failure instanceof Error,
    "a failing flush must reject, not resolve quietly",
  );
  assert.match(failure.message, /log flush failed \(event\)/);
  // 目的地的 error message 是不可信文本：只保留归一化的类型名。
  assert.ok(
    !failure.message.includes(opaqueSecret),
    `the rejection must not carry the destination's message\n${failure.message}`,
  );
  assert.equal(
    destination.ended(),
    false,
    "a caller-owned destination must never be ended",
  );
});

test("close rejects when the flush callback never fires", async () => {
  const destination = probeDestination("hang");
  const context = createLoggingContext(
    "info",
    createLogger("info"),
    destination.stream,
  );
  context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });

  await assert.rejects(
    context.close(),
    /log flush timed out after 2000ms \(event\)/,
    "a flush callback that never fires must reject, not hang forever",
  );
  assert.equal(destination.flushes(), 1);
  assert.equal(destination.ended(), false);
});

test("close rejects when the destination never drains", async () => {
  const destination = probeDestination("ok", { stallWrites: true });
  const context = createLoggingContext(
    "info",
    createLogger("info"),
    destination.stream,
  );
  context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });

  await assert.rejects(
    context.close(),
    /log destination did not drain within 2000ms \(event\)/,
    "an un-drained destination means the log really was lost; it must reject",
  );
  assert.equal(destination.ended(), false);
});

test("a failed close is remembered: every caller gets the same rejection", async () => {
  const destination = probeDestination("error");
  const context = createLoggingContext(
    "info",
    createLogger("info"),
    destination.stream,
  );
  context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });

  const first = context.close();
  const second = context.close();
  assert.equal(first, second, "close must return the very same promise");
  await assert.rejects(first, /log flush failed \(event\)/);
  await assert.rejects(second, /log flush failed \(event\)/);
  assert.equal(
    destination.flushes(),
    1,
    "a second close must not run the flush again",
  );
});

test("the internally created framework root is flushed", async () => {
  const events = probeDestination("ok");
  const framework = probeDestination("error");
  // 没有注入 framework logger：这一棵是**我们建的**，因此归我们，必须进 flush。
  const context = createLoggingContext(
    "info",
    undefined,
    events.stream,
    framework.stream,
  );

  await assert.rejects(
    context.close(),
    /log flush failed \(framework\)/,
    "an internally created framework root must be part of close",
  );
  assert.equal(framework.flushes(), 1);
  assert.equal(framework.ended(), false);
});

test("an injected framework logger is never flushed or ended", async () => {
  const events = probeDestination("ok");
  const framework = probeDestination("error");
  // 注入进来的这一棵归**调用方**所有。它的目的地 flush 会报错——如果我们碰它，
  // close 就会 reject。
  const context = createLoggingContext(
    "info",
    createLogger("info", framework.stream),
    events.stream,
  );
  context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });

  await context.close();
  assert.equal(
    framework.flushes(),
    0,
    "an injected framework logger must never be flushed by us",
  );
  assert.equal(framework.ended(), false);
});

test("an injected framework logger and a framework destination cannot be combined", () => {
  const framework = probeDestination("ok");
  const events = probeDestination("ok");
  assert.throws(
    () =>
      createLoggingContext(
        "info",
        createLogger("info", framework.stream),
        events.stream,
        framework.stream,
      ),
    /an injected framework logger already owns its destination/,
    "a contradictory wiring must fail closed, not silently ignore one side",
  );
});

test("the flush timeout fires even when nothing else holds the event loop open", () => {
  // 这条**必须**另起进程。`node --test` 的 runner 自己吊着事件循环，因此上面那条
  // 「flush 回调不来」的用例在 runner 里是通过的——哪怕超时定时器被 `unref()` 掉。
  // 真实关机没有 runner：那一刻循环里没有别的 handle，unref 过的定时器不会到，
  // `close()` 永不 settle，进程以 **0** 退出并静默丢掉最后几条日志。
  const script = join(packageRoot, "tests", "fixtures", "stalled-flush-shutdown.ts");
  const run = spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(run.status, 0, `the probe process failed:\n${run.stderr}`);
  assert.match(
    run.stdout,
    /OUTCOME=REJECTED/,
    "outside the test runner the flush timeout must still reject; " +
      `an unref'd timer lets the process exit 0 with close() unsettled\n${run.stdout}\n${run.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// 第十四轮收尾追加：close 必须是 failure-safe 的阶段收集器
// ---------------------------------------------------------------------------

/** 把 close 的失败原因拆成一条条，逐条断言「这个阶段确实跑过了」。 */
const closeFailure = async (context: {
  close: () => Promise<void>;
}): Promise<string> => {
  const error = await context.close().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof Error, "close must reject with an Error");
  return error.message;
};

test("an event flush failure does not skip the framework flush", async () => {
  const events = probeDestination("error");
  const framework = probeDestination("error");
  const context = createLoggingContext("info", undefined, events.stream, framework.stream);
  context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });

  const message = await closeFailure(context);
  // 上一版是一串 `await`：event flush 一失败，framework 那棵**根本没 flush**。
  assert.equal(
    framework.flushes(),
    1,
    `the framework flush must still run after the event flush failed\n${message}`,
  );
  assert.match(message, /log flush failed \(event\)/);
  assert.match(message, /log flush failed \(framework\)/);
  assert.match(message, /log close failed in 2 of 4 stage\(s\)/);
  assert.ok(!message.includes(opaqueSecret), message);
});

test("a framework flush failure does not skip the event drain", async () => {
  const events = probeDestination("ok", { stallWrites: true });
  const framework = probeDestination("error");
  const context = createLoggingContext("info", undefined, events.stream, framework.stream);
  context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });

  const message = await closeFailure(context);
  // event drain 排在 framework flush 之后：前面失败不得让它被跳过。
  assert.match(message, /log flush failed \(framework\)/);
  assert.match(
    message,
    /log destination did not drain within 2000ms \(event\)/,
    `the event drain must still run after the framework flush failed\n${message}`,
  );
  assert.equal(events.ended(), false);
  assert.equal(framework.ended(), false);
});

test("one failing drain does not block the other drain", async () => {
  const events = probeDestination("ok", { stallWrites: true });
  const framework = probeDestination("ok", { stallWrites: true });
  const context = createLoggingContext("info", undefined, events.stream, framework.stream);
  context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });
  // framework root 自己也写一行，好让它的目的地真的有东西排不掉。
  context.framework.info("keeping the framework destination busy");

  const message = await closeFailure(context);
  assert.match(
    message,
    /log destination did not drain within 2000ms \(framework\)/,
    message,
  );
  assert.match(
    message,
    /log destination did not drain within 2000ms \(event\)/,
    `a failing framework drain must not skip the event drain\n${message}`,
  );
  assert.match(message, /log close failed in 2 of 4 stage\(s\)/);
  assert.equal(events.ended(), false);
  assert.equal(framework.ended(), false);
});

test("every close caller gets the same aggregated failure", async () => {
  const events = probeDestination("error");
  const framework = probeDestination("error");
  const context = createLoggingContext("info", undefined, events.stream, framework.stream);
  context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });

  const first = context.close();
  const second = context.close();
  assert.equal(first, second, "close must return the very same promise");
  const message = await closeFailure(context);
  await assert.rejects(second, /log close failed in 2 of 4 stage\(s\)/);
  assert.equal(events.flushes(), 1, "a second close must not flush again");
  assert.equal(framework.flushes(), 1, "a second close must not flush again");
  assert.ok(!message.includes(opaqueSecret), message);
});

test("a hostile throw from the destination cannot escape close, nor skip a stage", async () => {
  // `errorTypeOf` 自己会读输入的原型与属性描述符，所以一个**自指** Proxy 能让它
  // 再抛一次。没兜住的话，抛出来的就是调用方的原始对象：它穿过阶段收集器，
  // close() 用调用方的值拒绝，剩下的阶段全被跳过——本轮两条保证一起没了。
  const hostile: unknown = new Proxy(
    { leaked: opaqueSecret },
    {
      getPrototypeOf: () => {
        throw hostile;
      },
      getOwnPropertyDescriptor: () => {
        throw hostile;
      },
    },
  );
  const framework = probeDestination("ok");
  Object.defineProperty(framework.stream, "writableLength", {
    get: () => {
      throw hostile;
    },
    configurable: true,
  });
  // event 目的地卡住：它排在 framework drain **之后**，因此「后续阶段没被跳过」
  // 这件事是可观测的——它必须真的等满 2 秒才报排空超时。
  const events = probeDestination("ok", { stallWrites: true });
  const context = createLoggingContext(
    "info",
    undefined,
    events.stream,
    framework.stream,
  );
  context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });

  const started = Date.now();
  const failure = await context.close().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(
    failure instanceof AggregateError,
    "close must reject with our own aggregate, never with the caller's value",
  );
  assert.ok(
    !failure.message.includes(opaqueSecret),
    `the rejection must not carry the caller's object\n${failure.message}`,
  );
  assert.match(failure.message, /log drain check failed \(framework\): UnreadableError/);
  assert.match(
    failure.message,
    /log destination did not drain within 2000ms \(event\)/,
    `the event drain must still run after a hostile framework drain\n${failure.message}`,
  );
  assert.ok(
    Date.now() - started >= 1_900,
    "the event drain stage must actually have run, not been skipped",
  );
  assert.equal(events.ended(), false);
  assert.equal(framework.ended(), false);
});
