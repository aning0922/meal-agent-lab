import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const steps = Object.freeze([
  ["domain-typecheck", "pnpm", ["--filter", "@meal-agent/domain", "typecheck"]],
  ["domain-build", "pnpm", ["--filter", "@meal-agent/domain", "build"]],
  ["targeted-readiness-test", "pnpm", ["--filter", "@meal-agent/domain", "exec", "node",
    "--import", "tsx", "--test", "tests/m1-readiness.test.ts"]],
  ["m0-regression", "pnpm", ["stage09p:m0:check"]],
  ["s1-scope", process.execPath, ["scripts/check-stage09p-m1-readiness-scope.mjs"]],
]);

for (const [index, [id, command, args]] of steps.entries()) {
  process.stdout.write(`stage09p:m1 readiness step ${index + 1}/${steps.length} ${id}\n`);
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    process.stderr.write(`stage09p:m1 readiness FAIL ${id}\n`);
    process.exit(1);
  }
}
process.stdout.write("stage09p:m1 readiness COMPLETE (preparation candidate only)\n");
