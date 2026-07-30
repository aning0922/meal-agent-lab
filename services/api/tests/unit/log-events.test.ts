import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import {
  eventErrorType,
  logEvent,
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
  logEvent(
    capture.logger,
    event as "request.rejected",
    fields as LogEventFields["request.rejected"],
  );
};

test("an extra primitive field never reaches the log line", () => {
  const capture = capturingLogger();

  // projector 逐个字段按名字取值，因此多传的字段连读都不会被读到。
  emitUnchecked(capture, "request.rejected", {
    errorCode: "VALIDATION_FAILED",
    statusCode: 422,
    smuggled: opaqueSecret,
    anotherOne: 12345,
    flag: true,
  });

  assertClean(capture.output(), "extra primitive field");
  const [emitted] = lines(capture.output());
  assert.deepEqual(emitted, {
    level: 40,
    time: emitted?.["time"],
    errorCode: "VALIDATION_FAILED",
    statusCode: 422,
    event: "request.rejected",
    msg: "request rejected",
  });
});

test("a caller can never override the reserved event field", () => {
  const capture = capturingLogger();

  emitUnchecked(capture, "request.rejected", {
    errorCode: "CONFLICT",
    statusCode: 409,
    event: `forged.${opaqueSecret}`,
  });

  assertClean(capture.output(), "event override");
  const [emitted] = lines(capture.output());
  assert.equal(
    emitted?.["event"],
    "request.rejected",
    `the reserved event field must win\n${capture.output()}`,
  );
});

test("a declared string field cannot smuggle an opaque secret", () => {
  const capture = capturingLogger();

  // errorType 只接受 allowlist 里的类型名；errorCode 只接受真实 ApiErrorCode；
  // signal 只接受两个值。任何自由文本都 fail closed，而不是被写成占位串。
  for (const [event, fields, field] of [
    ["request.failed", { errorType: opaqueSecret }, "errorType"],
    ["startup.failed", { errorType: `AppError${opaqueSecret}` }, "errorType"],
    [
      "request.rejected",
      { errorCode: opaqueSecret, statusCode: 500 },
      "errorCode",
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
  const ok = capturingLogger();
  logEvent(ok.logger, "request.failed", {
    errorType: eventErrorType(new TypeError("boom")),
  });
  logEvent(ok.logger, "shutdown.started", { signal: "SIGTERM" });
  const emitted = lines(ok.output());
  assert.equal(emitted[0]?.["errorType"], "TypeError");
  assert.equal(emitted[1]?.["signal"], "SIGTERM");
  assertClean(ok.output(), "legitimate fields");
});

test("an opaque secret in a child binding never reaches the log line", () => {
  const capture = capturingLogger();

  // 业务代码拿不到 child()——AST 门禁禁止它。但 facade 收到的 logger 可能**已经**
  // 是一个带 binding 的子 logger（Fastify 每条请求就是这么做的）。binding 里的
  // 不透明取值必须被中央边界按键名脱敏，而不是靠 facade。
  const child = capture.logger.child({
    password: opaqueSecret,
    apiKey: opaqueSecret,
    "Proxy-Authorization": opaqueSecret,
    component: "visible",
  });
  logEvent(child, "request.rejected", {
    errorCode: "RATE_LIMITED",
    statusCode: 429,
  });

  assertClean(capture.output(), "child binding");
  const [emitted] = lines(capture.output());
  assert.equal(emitted?.["component"], "visible");
  assert.equal(emitted?.["event"], "request.rejected");
});

test("every declared event round-trips through the real logger", () => {
  const capture = capturingLogger();

  logEvent(capture.logger, "request.failed", {
    errorType: eventErrorType(new Error("boom")),
  });
  logEvent(capture.logger, "request.rejected", {
    errorCode: "SESSION_EXPIRED",
    statusCode: 401,
  });
  logEvent(capture.logger, "shutdown.started", { signal: "SIGINT" });
  logEvent(capture.logger, "shutdown.timed-out", {});
  logEvent(capture.logger, "startup.failed", {
    errorType: eventErrorType(new RangeError("boom")),
  });

  const emitted = lines(capture.output());
  assert.deepEqual(
    emitted.map((entry) => [entry["event"], entry["msg"], entry["level"]]),
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
