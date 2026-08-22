import { buildApp } from "./app.js";
import { eventErrorType } from "./log-events.js";
import { loadConfig } from "./config.js";
import {
  closeAfterStartupFailure,
  installShutdownHandlers,
} from "./shutdown.js";

const config = loadConfig();
const app = await buildApp({ config });

// 关机契约在 `shutdown.ts` 里，不在这个文件：subprocess 回归因此跑的是**生产代码
// 本身**，而不是一份形状相同的抄件。
installShutdownHandlers(app);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.eventLog.emit("startup.failed", { errorType: eventErrorType(error) });
  await closeAfterStartupFailure(app);
  process.exitCode = 1;
}
