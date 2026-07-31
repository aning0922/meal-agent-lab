import { writeSync } from "node:fs";
import { Writable } from "node:stream";

import { createLoggingContext } from "../../src/log-events.js";
import { createLogger } from "../../src/logging.js";

/**
 * 阶段 09A / M3A：「flush 回调永远不来」的**独立进程**复现。
 *
 * 为什么必须另起一个进程：`node --test` 的 runner 自己吊着事件循环，所以在它里面
 * 跑，一个 `unref()` 过的超时定时器**照样**会触发——用例通过，可真实关机时不会。
 * 关机恰恰是「循环里已经没有别的 handle」的那一刻：监听 socket 已关、连接池已
 * end、信号监听器本身也不 ref 循环。那时进程会直接退出，`close()` 永不 settle，
 * 退出码还是 0，最后几条审计日志静默消失。
 *
 * 这个脚本刻意**不留**任何别的 ref 住循环的东西：两个目的地都是普通的内存
 * `Writable`，没有 SonicBoom、没有 socket、没有别的定时器。因此它的输出直接回答
 * 一个问题——超时到底会不会到。
 */

const stalledFlush = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
// pino 只在 `typeof stream.flush === "function"` 时才把回调交出去
// （pino 10.3.1 `lib/proto.js:253`）。这个 flush 收下回调之后**永不**调用它。
Object.defineProperty(stalledFlush, "flush", {
  value: () => undefined,
  writable: false,
  enumerable: true,
  configurable: false,
});

const quiet = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

const context = createLoggingContext(
  "info",
  createLogger("info", quiet),
  stalledFlush,
);
context.eventLog.emit("shutdown.started", { signal: "SIGTERM" });

let outcome = "NEVER-SETTLED";
process.on("exit", () => {
  // `process.stdout.write` 对管道是异步的，退出钩子里可能丢。写 fd 1 是同步的。
  writeSync(1, `OUTCOME=${outcome}\n`);
});

// 从一个回调里发起，而不是 top-level await：真实关机就是这样——信号处理器里调用
// `app.close()`，此刻循环里没有别的 ref 住的 handle。
setImmediate(() => {
  void context.close().then(
    () => {
      outcome = "RESOLVED";
    },
    () => {
      outcome = "REJECTED";
    },
  );
});
