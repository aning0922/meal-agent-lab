import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const stage09pM0Steps = Object.freeze([
  Object.freeze({
    args: ["--filter", "@meal-agent/domain", "typecheck"],
    command: "pnpm",
    id: "domain-typecheck",
  }),
  Object.freeze({
    args: ["--filter", "@meal-agent/domain", "build"],
    command: "pnpm",
    id: "domain-build",
  }),
  Object.freeze({
    args: ["--filter", "@meal-agent/domain", "test"],
    command: "pnpm",
    id: "r1-tests",
  }),
  Object.freeze({
    args: ["--filter", "@meal-agent/domain", "test:schema"],
    command: "pnpm",
    id: "schema-tests",
  }),
  Object.freeze({
    args: [
      "--filter",
      "@meal-agent/domain",
      "exec",
      "node",
      "--import",
      "tsx",
      "--test",
      "tests/catalog.test.ts",
      "tests/lifecycle.test.ts",
      "tests/resolution.test.ts",
      "tests/fixtures.test.ts",
    ],
    command: "pnpm",
    id: "r2-direct-tests",
  }),
  Object.freeze({
    args: ["scripts/check-stage09p-m0-scope.mjs"],
    command: process.execPath,
    id: "scope-and-fixtures",
  }),
]);

export const commandSucceeded = (result) =>
  result !== null && result.error === undefined && result.signal === null && result.status === 0;

export const fixedFailureMessage = (step) => `stage09p:m0 check FAIL ${step.id}\n`;

const run = () => {
  for (const [index, step] of stage09pM0Steps.entries()) {
    process.stdout.write(`stage09p:m0 check step ${index + 1}/${stage09pM0Steps.length} ${step.id}\n`);
    const result = spawnSync(step.command, step.args, {
      cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
      env: process.env,
      stdio: "inherit",
    });
    if (!commandSucceeded(result)) {
      process.stderr.write(fixedFailureMessage(step));
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write("stage09p:m0 check COMPLETE (candidate only)\n");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
