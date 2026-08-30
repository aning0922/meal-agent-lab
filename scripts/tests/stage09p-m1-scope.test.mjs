import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STAGE09P_M1_ADDED_PATHS,
  STAGE09P_M1_ALLOWED_PATHS,
  STAGE09P_M1_BASE_HEAD,
  STAGE09P_M1_DOMAIN_MODULES,
  STAGE09P_M1_M0_TCB,
  STAGE09P_M1_MODIFIED_PATHS,
  STAGE09P_M1_PRIVATE_SEAMS,
  STAGE09P_M1_PRODUCTION_IMPORT_SPECIFIERS,
  assertStage09pM1DiffProjection,
  assertStage09pM1DraftBoundary,
  assertStage09pM1FileMode,
  assertStage09pM1PackageProjection,
  assertStage09pM1PrivateSeamLocations,
  assertStage09pM1ProductionImports,
  assertStage09pM1PublicBoundary,
  checkStage09pM1Scope,
  collectStage09pM1DiffEntries,
  collectStage09pM1TextSources,
  extractStage09pM1ImportSpecifiers,
} from "../check-stage09p-m1-scope.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(repositoryRoot, path), "utf8");
const clone = (value) => structuredClone(value);
const lineCount = (source) =>
  source === "" ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(join(repositoryRoot, path))).digest("hex");

const moduleSources = new Map(
  STAGE09P_M1_DOMAIN_MODULES.map((module) => [
    module,
    read("packages/domain/src/" + module),
  ]),
);
const indexSource = moduleSources.get("index.ts");
const resolutionSource = moduleSources.get("resolution.ts");
const pack = JSON.parse(
  read("data/reference/ingredients/stage09p-m1-household-safety-source-pack.json"),
);

test("boundary checker accepts the exact dirty-base projection", () => {
  const result = checkStage09pM1Scope(repositoryRoot, {
    expectedBase: STAGE09P_M1_BASE_HEAD,
  });
  assert.deepStrictEqual(result, { failures: [], ok: true });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.failures), true);
});

test("write set is exactly 14 modified plus 9 added paths", () => {
  assert.equal(STAGE09P_M1_MODIFIED_PATHS.length, 14);
  assert.equal(STAGE09P_M1_ADDED_PATHS.length, 9);
  assert.equal(STAGE09P_M1_ALLOWED_PATHS.length, 23);
  assert.equal(new Set(STAGE09P_M1_ALLOWED_PATHS).size, 23);
  const entries = collectStage09pM1DiffEntries(repositoryRoot);
  assert.doesNotThrow(() => assertStage09pM1DiffProjection(entries));
  assert.throws(() =>
    assertStage09pM1DiffProjection([
      ...entries,
      { path: "packages/domain/src/eighth.ts", status: "A" },
    ]),
  );
  assert.throws(() =>
    assertStage09pM1DiffProjection(
      entries.map((entry, index) =>
        index === 0 ? { ...entry, status: "A" } : entry,
      ),
    ),
  );
});

test("mode and type projection rejects executable, symlink, and non-file records", () => {
  assert.doesNotThrow(() =>
    assertStage09pM1FileMode({
      isFile: true,
      mode: 0o100644,
      path: "ordinary.mjs",
    }),
  );
  for (const record of [
    { isFile: true, mode: 0o100755, path: "executable.mjs" },
    { isFile: false, mode: 0o120777, path: "link.mjs" },
    { isFile: false, mode: 0o040755, path: "directory" },
  ]) {
    assert.throws(() => assertStage09pM1FileMode(record));
  }
});

test("root package is one exact raw line and one complete-object key", () => {
  const baseline = spawnSync(
    "git",
    ["show", STAGE09P_M1_BASE_HEAD + ":package.json"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(baseline.status, 0);
  const current = read("package.json");
  assert.doesNotThrow(() =>
    assertStage09pM1PackageProjection(baseline.stdout, current),
  );
  assert.throws(() =>
    assertStage09pM1PackageProjection(
      baseline.stdout,
      current.replace('"private": true', '"private": false'),
    ),
  );
  assert.throws(() =>
    assertStage09pM1PackageProjection(
      baseline.stdout,
      current.replace(
        "node scripts/run-stage09p-m1-check.mjs",
        "node scripts/other.mjs",
      ),
    ),
  );
});

test("seven production modules use only the exact import-specifier set", () => {
  assert.equal(moduleSources.size, 7);
  assert.doesNotThrow(() => assertStage09pM1ProductionImports(moduleSources));
  const actual = new Set(
    [...moduleSources.values()].flatMap(extractStage09pM1ImportSpecifiers),
  );
  assert.deepStrictEqual(
    [...actual].sort(),
    [...STAGE09P_M1_PRODUCTION_IMPORT_SPECIFIERS].sort(),
  );
  const hostImport = new Map(moduleSources);
  hostImport.set(
    "canonical.ts",
    hostImport.get("canonical.ts") + '\nimport value from "node:module";\n',
  );
  assert.throws(() => assertStage09pM1ProductionImports(hostImport));
  const dynamicImport = new Map(moduleSources);
  dynamicImport.set(
    "types.ts",
    dynamicImport.get("types.ts") + '\nvoid import("./eighth.js");\n',
  );
  assert.throws(() => assertStage09pM1ProductionImports(dynamicImport));
});

test("public root remains private-seam-free and trust allowlist remains empty", () => {
  assert.doesNotThrow(() =>
    assertStage09pM1PublicBoundary(indexSource, resolutionSource),
  );
  assert.throws(() =>
    assertStage09pM1PublicBoundary(
      indexSource + "\nexport { " + STAGE09P_M1_PRIVATE_SEAMS[0] + ' } from "./resolution.js";\n',
      resolutionSource,
    ),
  );
  const trustName = "TRUSTED_ACTIVE_" + "HOUSEHOLD_SAFETY_PACK_DIGESTS";
  const empty = "const " + trustName + ": readonly Digest[] = Object.freeze([]);";
  assert.throws(() =>
    assertStage09pM1PublicBoundary(
      indexSource,
      resolutionSource.replace(
        empty,
        "const " + trustName + ': readonly Digest[] = Object.freeze(["sha256:bad"]);',
      ),
    ),
  );
});

test("three private seams are confined to resolution and one household test", () => {
  assert.equal(STAGE09P_M1_PRIVATE_SEAMS.length, 3);
  const sources = collectStage09pM1TextSources(repositoryRoot);
  assert.doesNotThrow(() => assertStage09pM1PrivateSeamLocations(sources));
  const leaked = new Map(sources);
  leaked.set("docs/leak.md", STAGE09P_M1_PRIVATE_SEAMS[0]);
  assert.throws(() => assertStage09pM1PrivateSeamLocations(leaked));
  const fourth = new Map(sources);
  fourth.set(
    "packages/domain/src/resolution.ts",
    fourth.get("packages/domain/src/resolution.ts") +
      "\nexport const __test" + "OnlyFourthSeam = () => undefined;\n",
  );
  assert.throws(() => assertStage09pM1PrivateSeamLocations(fourth));
});

test("draft pack cannot become active, trusted, reviewed-clear, or user-bearing", () => {
  assert.doesNotThrow(() => assertStage09pM1DraftBoundary(pack));
  const mutations = [
    (value) => {
      value.lifecycleStatus = "active";
    },
    (value) => {
      value.catalog.hardMappings.push({});
    },
    (value) => {
      value.catalog.releases[0].envelopes[0].licenseStatus = "approved";
    },
    (value) => {
      value.catalog.releases[0].envelopes[0].officialEvidence.factDisposition =
        "REVIEWED_CLEAR";
    },
    (value) => {
      value.catalog.releases[0].envelopes[0].officialEvidence.containsRealUserData =
        true;
    },
  ];
  for (const mutate of mutations) {
    const value = clone(pack);
    mutate(value);
    assert.throws(() => assertStage09pM1DraftBoundary(value));
  }
});

test("frozen M0 runner and dedicated tests retain exact hashes", () => {
  assert.equal(Object.keys(STAGE09P_M1_M0_TCB).length, 4);
  for (const [path, expected] of Object.entries(STAGE09P_M1_M0_TCB)) {
    assert.equal(sha256(path), expected, path);
  }
});

test("checker and dedicated test stay readable and mechanism-bounded", () => {
  const checker = read("scripts/check-stage09p-m1-scope.mjs");
  const dedicatedTest = read("scripts/tests/stage09p-m1-scope.test.mjs");
  assert(lineCount(checker) <= 600);
  assert(lineCount(dedicatedTest) <= 300);
  for (const token of [
    "node:" + "module",
    "create" + "Require",
    "type" + "script",
    "parse" + "ManifestRows",
    "checkGuest" + "MatrixSources",
    "checkContext" + "OracleSources",
  ]) {
    assert.equal(checker.includes(token), false, token);
  }
  for (const seam of STAGE09P_M1_PRIVATE_SEAMS) {
    assert.equal(checker.includes(seam), false, seam);
    assert.equal(dedicatedTest.includes(seam), false, seam);
  }
});

test("wrong base fails closed without weakening other evidence", () => {
  const result = checkStage09pM1Scope(repositoryRoot, {
    expectedBase: "0000000000000000000000000000000000000000",
  });
  assert.deepStrictEqual(result, { failures: ["identity"], ok: false });
});
