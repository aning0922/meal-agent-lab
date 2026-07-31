import { createServer } from "node:net";
import { Writable } from "node:stream";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { eventErrorType } from "../../src/log-events.js";
import {
  closeAfterStartupFailure,
  installShutdownHandlers,
} from "../../src/shutdown.js";

/**
 * 阶段 09A / M3A：关机失败的**独立进程**复现。
 *
 * 两种模式，都对应 `src/index.ts` 里真实存在的一条路径：
 *
 *   - `sigterm`：正常启动之后收到 SIGTERM，`app.close()` 因为日志 flush 失败而
 *     reject；
 *   - `listen`：端口被占导致 `app.listen()` 失败，随后的 `app.close()` **又**失败。
 *
 * 断言的是关机**契约**：stderr 是一行完全固定的中性文本、退出码为 1、目的地抛出的
 * 敌意文本一个字都不出现。用的是真实的 `buildApp`、真实的 `app.close()`，以及
 * `src/shutdown.ts` 里那两个**生产函数本身**——`index.ts` 没有注入目的地的入口，
 * 但关机契约已经抽到 `shutdown.ts`，所以这里跑的不是抄件。
 */

const sentinel = "OPAQUE-SHUTDOWN-SENTINEL";
const mode = process.argv[2];

const failingDestination = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
Object.defineProperty(failingDestination, "flush", {
  value: (callback: (error?: Error | null) => void): void => {
    callback(new Error(`flush failed: ${sentinel}`));
  },
  writable: false,
  enumerable: true,
  configurable: false,
});

const config = loadConfig({
  NODE_ENV: "test",
  DEPLOYMENT_STAGE: "local-test",
  DEPLOYMENT_EXPOSURE: "loopback",
  DATABASE_URL:
    "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/meal_agent",
  WECHAT_ADAPTER: "fake",
  LOG_LEVEL: "silent",
});
const unavailable = async (): Promise<never> => {
  throw new Error("operation should not be called");
};
const app = await buildApp({
  config,
  eventLogDestination: failingDestination,
  operations: new Proxy({}, { get: () => unavailable }) as never,
  readiness: async () => true,
});

// 生产函数，不是抄件。
installShutdownHandlers(app);

// --- 模式分派 ---------------------------------------------------------------

/** 先占住一个端口，好让 `app.listen` 确定性地失败。 */
const occupyPort = async (): Promise<number> =>
  new Promise((resolve) => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1", () => {
      const address = blocker.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
    blocker.unref();
  });

const port = mode === "listen" ? await occupyPort() : 0;

try {
  await app.listen({ host: "127.0.0.1", port });
  process.kill(process.pid, "SIGTERM");
} catch (error) {
  app.eventLog.emit("startup.failed", { errorType: eventErrorType(error) });
  await closeAfterStartupFailure(app);
  process.exitCode = 1;
}
