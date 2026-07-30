import { buildApp } from "./app.js";
import { eventErrorType, type ShutdownSignal } from "./log-events.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ config });

let closing = false;
// 参数类型收窄成 facade 的 `ShutdownSignal`：这个进程只为这两个信号安装 handler，
// 而日志字段也只接受这两个。用 `NodeJS.Signals` 就等于把「任意信号名」这条自由
// 字符串又放了回来。
const shutdown = async (signal: ShutdownSignal): Promise<void> => {
  if (closing) {
    return;
  }
  closing = true;
  app.eventLog.emit("shutdown.started", { signal });

  const forceClose = setTimeout(() => {
    app.eventLog.emit("shutdown.timed-out", {});
    process.exitCode = 1;
  }, 10_000);
  forceClose.unref();

  try {
    await app.close();
  } finally {
    clearTimeout(forceClose);
  }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.eventLog.emit("startup.failed", { errorType: eventErrorType(error) });
  await app.close();
  process.exitCode = 1;
}
