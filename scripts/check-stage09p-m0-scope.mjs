import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULES = Object.freeze([
  "canonical.ts",
  "catalog.ts",
  "decode.ts",
  "index.ts",
  "resolution.ts",
  "types.ts",
  "validation.ts",
]);
const VALID_FIXTURES = Object.freeze([
  "allergen.json",
  "cooking-technique.json",
  "food-concept.json",
  "food-safety.json",
  "religious-ethical.json",
]);
const INVALID_FIXTURES = Object.freeze([
  "duplicate-hard-mapping.json",
  "empty-catalog.json",
  "hard-mapping-unresolved.json",
  "invalid-digest.json",
  "invalid-synthetic-marker.json",
  "lone-surrogate.json",
  "missing-required.json",
  "negative-zero.json",
  "unknown-own-key.json",
  "unsafe-integer.json",
]);
const SCHEMA_COMMENT =
  "runtime-owned: decode.ts scalar closure; standard JSON Schema/Ajv does not claim negative-zero distinction";
const SCHEMA_KEYWORDS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "const",
  "enum",
  "items",
  "maxItems",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "propertyNames",
  "required",
  "title",
  "type",
  "uniqueItems",
]);
const EXPECTED_DOMAIN_SCRIPTS = Object.freeze({
  build: "tsc -p tsconfig.build.json",
  check: "pnpm run typecheck && pnpm run test && pnpm run test:schema && pnpm run build",
  test: "node --import tsx --test tests/decode.test.ts tests/canonical.test.ts",
  "test:schema": "node --import tsx --test tests/schema.test.ts",
  typecheck: "tsc -p tsconfig.json --noEmit",
});
const EXPECTED_ROOT_WIRING = Object.freeze({
  build:
    "pnpm --filter @meal-agent/domain build && pnpm --filter @meal-agent/contracts build && pnpm --filter @meal-agent/api build",
  check:
    "pnpm --filter @meal-agent/domain check && pnpm --filter @meal-agent/contracts check && pnpm --filter @meal-agent/api check && pnpm --filter @meal-agent/client check",
  test:
    "pnpm --filter @meal-agent/domain test && pnpm --filter @meal-agent/contracts test && pnpm --filter @meal-agent/api test && pnpm --filter @meal-agent/client test",
  typecheck:
    "pnpm --filter @meal-agent/domain typecheck && pnpm --filter @meal-agent/contracts typecheck && pnpm --filter @meal-agent/api typecheck && pnpm --filter @meal-agent/client typecheck",
});
const EXPECTED_LOCK_IMPORTER = `    dependencies:
      '@noble/hashes':
        specifier: 2.0.1
        version: 2.0.1
    devDependencies:
      '@types/node':
        specifier: 24.13.3
        version: 24.13.3
      ajv:
        specifier: 8.20.0
        version: 8.20.0
      tsx:
        specifier: 4.23.1
        version: 4.23.1
      typescript:
        specifier: 5.9.3
        version: 5.9.3`;

const text = (root, path) => readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n");
const json = (root, path) => JSON.parse(text(root, path));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sortedFiles = (root, path) =>
  readdirSync(join(root, path), { withFileTypes: true })
    .map((entry) => (entry.isFile() ? entry.name : `${entry.name}/`))
    .sort();

const checkProductionFiles = (root) => {
  if (!same(sortedFiles(root, "packages/domain/src"), MODULES)) throw new Error("surface");
};

const checkProductionImports = (root) => {
  const external = new Map([
    ["@noble/hashes/sha2.js", "canonical.ts"],
    ["@noble/hashes/utils.js", "canonical.ts"],
  ]);
  const unsafeRuntime = /\b(?:process|console|globalThis)\s*\.|\b(?:fetch|WebSocket|setTimeout|setInterval)\s*\(|\b(?:Date\.now|Math\.random)\s*\(/;
  for (const file of MODULES) {
    const source = text(root, `packages/domain/src/${file}`);
    if (/\b(?:import|require)\s*\(|\bimport\s*["']/.test(source) || unsafeRuntime.test(source)) {
      throw new Error("runtime");
    }
    const specifiers = source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g);
    for (const [, specifier] of specifiers) {
      if (specifier.startsWith("./")) {
        const target = `${specifier.slice(2, -3)}.ts`;
        if (!specifier.endsWith(".js") || !MODULES.includes(target)) throw new Error("relative");
      } else if (external.get(specifier) !== file) {
        throw new Error("external");
      }
    }
  }
};

const checkWorkspaceWiring = (root) => {
  const workspace = text(root, "pnpm-workspace.yaml");
  if (
    (workspace.match(/^  - packages\/domain$/gm) ?? []).length !== 1 ||
    (workspace.match(/^verifyDepsBeforeRun: false$/gm) ?? []).length !== 1
  ) throw new Error("workspace");

  const domain = json(root, "packages/domain/package.json");
  if (
    domain.name !== "@meal-agent/domain" ||
    domain.version !== "0.1.0" ||
    domain.private !== true ||
    domain.type !== "module" ||
    domain.sideEffects !== false ||
    !same(domain.files, ["dist"]) ||
    domain.main !== "./dist/index.js" ||
    domain.types !== "./dist/index.d.ts" ||
    !same(domain.exports, { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }) ||
    !same(domain.scripts, EXPECTED_DOMAIN_SCRIPTS) ||
    !same(domain.dependencies, { "@noble/hashes": "2.0.1" }) ||
    !same(domain.devDependencies, {
      "@types/node": "24.13.3",
      ajv: "8.20.0",
      tsx: "4.23.1",
      typescript: "5.9.3",
    })
  ) {
    throw new Error("package");
  }

  const rootPackage = json(root, "package.json");
  if (rootPackage.packageManager !== "pnpm@11.9.0" || rootPackage.engines?.node !== ">=24.14.0 <25") {
    throw new Error("root");
  }
  for (const [name, command] of Object.entries(EXPECTED_ROOT_WIRING)) {
    if (rootPackage.scripts?.[name] !== command) throw new Error("root");
  }

  const lock = text(root, "pnpm-lock.yaml");
  const importer = lock.split("\n  packages/domain:\n")[1]?.split(/\n  \S/)[0]?.trimEnd();
  if (importer !== EXPECTED_LOCK_IMPORTER) throw new Error("lock");
};

const checkSchemaNode = (value, names = false) => {
  if (Array.isArray(value)) {
    for (const item of value) checkSchemaNode(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (!names && !SCHEMA_KEYWORDS.has(key)) throw new Error("keyword");
    checkSchemaNode(child, key === "properties" || key === "$defs");
  }
};

const checkSchemaBoundary = (root) => {
  for (const file of ["governance-release.schema.json", "governance-catalog.schema.json"]) {
    const schema = json(root, `data/schemas/${file}`);
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.$comment !== SCHEMA_COMMENT) {
      throw new Error("declaration");
    }
    checkSchemaNode(schema);
  }
  const owner = text(root, "packages/domain/src/decode.ts");
  if ((owner.match(/Object\.is\(value,\s*-0\)/g) ?? []).length !== 1) throw new Error("owner");
};

const checkFixtures = (root) => {
  if (!same(sortedFiles(root, "data/samples/stage09p-m0/valid"), VALID_FIXTURES)) throw new Error("valid");
  if (!same(sortedFiles(root, "data/samples/stage09p-m0/invalid"), INVALID_FIXTURES)) throw new Error("invalid");
  for (const file of [...VALID_FIXTURES, ...INVALID_FIXTURES]) {
    const group = VALID_FIXTURES.includes(file) ? "valid" : "invalid";
    const source = text(root, `data/samples/stage09p-m0/${group}/${file}`);
    JSON.parse(source);
    const structuralOnly = group === "invalid" && ["empty-catalog.json", "missing-required.json"].includes(file);
    if (!structuralOnly && !source.includes("syn:")) {
      throw new Error("synthetic");
    }
  }
};

const checkLegacyMeta = (root) => {
  const forbiddenName = /stage09p.*(?:guard|material|mutant|mutation)/i;
  for (const directory of ["scripts", "scripts/tests"]) {
    if (sortedFiles(root, directory).some((name) => forbiddenName.test(name))) throw new Error("legacy");
  }
};

const checkSmallSurface = (root) => {
  const limits = new Map([
    ["scripts/check-stage09p-m0-scope.mjs", 280],
    ["scripts/run-stage09p-m0-check.mjs", 120],
    ["scripts/tests/stage09p-m0-scope.test.mjs", 360],
    ["scripts/tests/stage09p-m0-check.test.mjs", 160],
  ]);
  for (const [path, limit] of limits) {
    if (!statSync(join(root, path)).isFile() || text(root, path).split("\n").length > limit) throw new Error("size");
  }
};

const RULES = Object.freeze([
  ["production-files", checkProductionFiles],
  ["production-imports", checkProductionImports],
  ["workspace-wiring", checkWorkspaceWiring],
  ["schema-boundary", checkSchemaBoundary],
  ["fixture-inventory", checkFixtures],
  ["legacy-meta", checkLegacyMeta],
  ["small-surface", checkSmallSurface],
]);

export const checkStage09pM0Scope = (repositoryRoot) => {
  const failures = [];
  for (const [id, check] of RULES) {
    try {
      check(repositoryRoot);
    } catch {
      failures.push(id);
    }
  }
  return Object.freeze({ failures: Object.freeze(failures), ok: failures.length === 0 });
};

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = checkStage09pM0Scope(resolve(dirname(scriptPath), ".."));
  if (result.ok) {
    process.stdout.write("stage09p:m0 scope COMPLETE (candidate only)\n");
  } else {
    for (const id of result.failures) process.stderr.write(`stage09p:m0 scope FAIL ${id}\n`);
    process.exitCode = 1;
  }
}
