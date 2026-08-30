import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const stage09pM1Steps = Object.freeze([
  Object.freeze({
    args: ["stage09p:m0:check"],
    command: "pnpm",
    id: "m0-check",
  }),
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
    args: [
      "--filter",
      "@meal-agent/domain",
      "exec",
      "node",
      "--import",
      "tsx",
      "--test",
      "tests/household-safety.test.ts",
    ],
    command: "pnpm",
    id: "household-safety-tests",
  }),
  Object.freeze({
    args: [
      "--test",
      "scripts/tests/stage09p-m1-check.test.mjs",
      "scripts/tests/stage09p-m1-scope.test.mjs",
      "scripts/tests/stage09p-m1-source-pack.test.mjs",
    ],
    command: process.execPath,
    id: "m1-checker-tests",
  }),
  Object.freeze({
    args: [
      "scripts/check-stage09p-m1-source-pack.mjs",
      "--as-of=2026-08-29T00:00:00.000Z",
    ],
    command: process.execPath,
    id: "source-pack-check",
  }),
  Object.freeze({
    args: [
      "scripts/check-stage09p-m1-scope.mjs",
      "--expected-base=1a66015e63ac84c6257be46a36c5c5967ee53f20",
    ],
    command: process.execPath,
    id: "scope-check",
  }),
  Object.freeze({
    args: ["diff", "--check"],
    command: "git",
    id: "diff-check",
  }),
]);

export const commandSucceeded = (result) =>
  result !== null &&
  result.error === undefined &&
  result.signal === null &&
  result.status === 0;

export const fixedFailureMessage = (step) =>
  `stage09p:m1 check FAIL ${step.id}\n`;

const run = () => {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (const [index, step] of stage09pM1Steps.entries()) {
    process.stdout.write(
      `stage09p:m1 check step ${index + 1}/${stage09pM1Steps.length} ${step.id}\n`,
    );
    const result = spawnSync(step.command, step.args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    if (!commandSucceeded(result)) {
      process.stderr.write(fixedFailureMessage(step));
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write("stage09p:m1 check COMPLETE (candidate only)\n");
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run();
}
