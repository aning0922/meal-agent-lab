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
  } catch (error) {
    // 日志关不干净（flush 报错 / flush 回调超时 / 目的地没排空）。能用来记录这件事
    // 的东西正好就是坏掉的那个，所以往 stderr 写**一行固定文本 + 归一化类型名**
    // （不是取值），并留一个确定的非零退出码。
    //
    // 不这么做的话，`void shutdown(…)` 会把这个 rejection 丢掉，最终只剩 Node 对
    // 未处理拒绝的默认行为——退出码对不对取决于运行时开关，而不是我们的选择。
    process.stderr.write(
      `shutdown: log close failed (${eventErrorType(error)})\n`,
    );
    process.exitCode = 1;
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
