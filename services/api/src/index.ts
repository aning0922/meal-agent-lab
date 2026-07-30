import { buildApp } from "./app.js";
import { safeErrorRecord } from "./logging.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ config });

let closing = false;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (closing) {
    return;
  }
  closing = true;
  app.log.info({ signal }, "graceful shutdown started");

  const forceClose = setTimeout(() => {
    app.log.fatal("graceful shutdown timed out");
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
  app.log.fatal(safeErrorRecord(error), "API startup failed");
  await app.close();
  process.exitCode = 1;
}
