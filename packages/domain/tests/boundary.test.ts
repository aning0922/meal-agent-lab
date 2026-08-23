import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const packageRoot = resolve(import.meta.dirname, "..");

test("domain production source remains pure and framework-free", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), ["@noble/hashes"]);

  for (const file of ["canonical.ts", "index.ts", "resolution.ts", "types.ts", "validation.ts"]) {
    const source = readFileSync(resolve(packageRoot, "src", file), "utf8");
    const executableSource = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(
      executableSource,
      /(?:from|import\s*\()["'](?:node:|fastify|drizzle|@tarojs|react|zod|openai|@anthropic-ai|pg(?:\/|["']))/,
      file,
    );
    assert.doesNotMatch(
      executableSource,
      /\b(?:Request|Response|Dto|DTO|DatabaseRow|Repository|Adapter)\b/,
      file,
    );
  }
});
