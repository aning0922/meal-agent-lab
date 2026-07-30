import { buildApp } from "./app.js";
import { eventErrorType, logEvent } from "./log-events.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ config });

let closing = false;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (closing) {
    return;
  }
  closing = true;
  logEvent(app.log, "shutdown.started", { signal });

  const forceClose = setTimeout(() => {
    logEvent(app.log, "shutdown.timed-out", {});
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
  logEvent(app.log, "startup.failed", { errorType: eventErrorType(error) });
  await app.close();
  process.exitCode = 1;
}
