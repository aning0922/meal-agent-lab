import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import {
  createEventLogSink,
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
  return { sink: createEventLogSink(root), root, output: () => output };
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

  // 每一个 ApiErrorCode 都必须派生出与 contracts 一致的状态码。
  const derived = capturingSink();
  for (const code of [
    "VALIDATION_FAILED",
    "AUTHENTICATION_REQUIRED",
    "SESSION_EXPIRED",
    "FORBIDDEN",
    "RESOURCE_NOT_FOUND",
    "CONFLICT",
    "SAFETY_BLOCKED",
    "RATE_LIMITED",
    "EXTERNAL_DEPENDENCY_UNAVAILABLE",
    "INTERNAL_ERROR",
  ] as const) {
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
    [
      ["VALIDATION_FAILED", 400],
      ["AUTHENTICATION_REQUIRED", 401],
      ["SESSION_EXPIRED", 401],
      ["FORBIDDEN", 403],
      ["RESOURCE_NOT_FOUND", 404],
      ["CONFLICT", 409],
      ["SAFETY_BLOCKED", 422],
      ["RATE_LIMITED", 429],
      ["EXTERNAL_DEPENDENCY_UNAVAILABLE", 503],
      ["INTERNAL_ERROR", 500],
    ],
  );
});

test("a declared string field cannot smuggle an opaque secret", () => {
  const capture = capturingSink();

  for (const [event, fields, field] of [
    ["request.failed", { requestId, errorType: opaqueSecret }, "errorType"],
    ["startup.failed", { errorType: `AppError${opaqueSecret}` }, "errorType"],
    [
      "request.rejected",
      { requestId, errorCode: opaqueSecret },
      "errorCode",
    ],
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
