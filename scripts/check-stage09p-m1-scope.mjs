import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const STAGE09P_M1_BASE_HEAD = "1a66015e63ac84c6257be46a36c5c5967ee53f20";
export const STAGE09P_M1_BASE_TREE = "3e205fd3dc600ad1d0853ae7c475bbf916f055bd";
export const STAGE09P_M1_BASE_TRACKED_FILES = 417;
export const STAGE09P_M1_CANDIDATE_TRACKED_FILES = 426;
const STAGE09P_M1_FAILED_HEAD = "1da720143c584a2326d640b882bbee75ac494941";
const STAGE09P_M1_FAILED_TREE = "6d8ab75a0b6f9445f402f74ba23411a387b7eaa0";
const STAGE09P_M1_EVIDENCE_HEAD = "3bd91a00b953d0949095fc534306fcaa3039d416";
const STAGE09P_M1_EVIDENCE_TREE = "8239cbef4e370a8ed6cc9ca81543017f6dbec5e8";
const STAGE09P_M1_C1_HEAD = "0734aa885cb12ffce86a014c8c3dc58cf06d4ed5";
const STAGE09P_M1_C1_TREE = "c9261b6fadb5044cdc53d3ac7269946327111946";
const STAGE09P_M1_FAILED_REPAIR_PATHS = Object.freeze([
  "packages/domain/src/resolution.ts", "packages/domain/tests/household-safety.test.ts",
  "scripts/check-stage09p-m1-scope.mjs",
]);
const STAGE09P_M1_REPAIR_PATHS = Object.freeze([
  "data/schemas/governance-release.schema.json", "packages/domain/tests/schema.test.ts",
  "packages/domain/tests/household-safety.test.ts", "scripts/check-stage09p-m1-scope.mjs",
  "scripts/check-stage09p-m1-source-pack.mjs", "scripts/tests/stage09p-m1-scope.test.mjs",
  "scripts/tests/stage09p-m1-source-pack.test.mjs",
]);
const STAGE09P_M1_CORRECTION_PATHS = Object.freeze([
  "packages/domain/src/resolution.ts", "packages/domain/tests/household-safety.test.ts",
  "scripts/check-stage09p-m1-scope.mjs", "scripts/tests/stage09p-m1-scope.test.mjs",
  "scripts/tests/stage09p-m1-source-pack.test.mjs",
]);
export const STAGE09P_M1_MODIFIED_PATHS = Object.freeze([
  "data/README.md", "data/schemas/governance-release.schema.json",
  "docs/domain/data-model.md", "docs/product/app-functional-spec.md",
  "docs/safety/food-safety.md", "package.json", "packages/domain/README.md",
  "packages/domain/src/canonical.ts", "packages/domain/src/catalog.ts",
  "packages/domain/src/decode.ts", "packages/domain/src/index.ts",
  "packages/domain/src/resolution.ts", "packages/domain/src/types.ts",
  "packages/domain/src/validation.ts",
  "packages/domain/tests/schema.test.ts",
]);
export const STAGE09P_M1_ADDED_PATHS = Object.freeze([
  "data/reference/ingredients/stage09p-m1-household-safety-source-pack.json",
  "data/schemas/household-safety-source-pack.schema.json", "packages/domain/tests/household-safety.test.ts",
  "scripts/check-stage09p-m1-scope.mjs", "scripts/check-stage09p-m1-source-pack.mjs",
  "scripts/run-stage09p-m1-check.mjs", "scripts/tests/stage09p-m1-check.test.mjs",
  "scripts/tests/stage09p-m1-scope.test.mjs",
  "scripts/tests/stage09p-m1-source-pack.test.mjs",
]);
export const STAGE09P_M1_ALLOWED_PATHS = Object.freeze(
  [...STAGE09P_M1_MODIFIED_PATHS, ...STAGE09P_M1_ADDED_PATHS].sort(),
);
export const STAGE09P_M1_DOMAIN_MODULES = Object.freeze([
  "canonical.ts", "catalog.ts", "decode.ts", "index.ts",
  "resolution.ts", "types.ts", "validation.ts",
]);
export const STAGE09P_M1_PRODUCTION_IMPORT_SPECIFIERS = Object.freeze([
  "./canonical.js", "./catalog.js", "./decode.js", "./resolution.js",
  "./types.js", "./validation.js", "@noble/hashes/sha2.js", "@noble/hashes/utils.js",
]);
export const STAGE09P_M1_M0_TCB = Object.freeze({
  "scripts/check-stage09p-m0-scope.mjs": "5ac0c5915ab08170efee63c563fff1f1d68081aa2b8b840e9b01ebed02359766",
  "scripts/run-stage09p-m0-check.mjs": "a35c719f8d0570cc146d524cd8e09a4db7b6d1dc2c02026d527afe360ce6cda5",
  "scripts/tests/stage09p-m0-check.test.mjs": "008e0d25d290e724a5f054f440c45bca3b83b572cf156599eb0f516bdfb7c9c4",
  "scripts/tests/stage09p-m0-scope.test.mjs": "739c85ac412eb54bca0b41836bafbf9d946097dbf2345a17c1405d7f4d16b580",
});
const NON_REPAIR_SNAPSHOT = Object.freeze({
  "data/README.md": "cc28bba2af1e97c967f755d63093df6b21912afbe0251751222304c8528fe68d",
  "data/reference/ingredients/stage09p-m1-household-safety-source-pack.json": "4ae7b21a1e4f37207e1279e5c1e902390d5998496048f32fe9f5a650870b4959",
  "data/schemas/household-safety-source-pack.schema.json": "5fcb2e7d24a37692fbdde603d1ce0bcf32fe8fa818ee71034e12300b9cea5d58",
  "docs/domain/data-model.md": "38dc786d52cd0e125f1fd1d46bfd1150f17d9f38ac5cf2bf04e2422a596c37f0",
  "docs/product/app-functional-spec.md": "dcd5a08ca58d8263a3e2ac8c00701020d2641f1b64e1b6e88753251e5b3e1a3c",
  "docs/safety/food-safety.md": "b836bd63a4e23d89b9e1d4b162a77569257141ce5c35d60348cbb5e19f778d44",
  "package.json": "1c24b24aa0cef24a37c8d7fc9709861f6b490042f75fdd4eb80cd6bf4d64512d",
  "packages/domain/README.md": "08b57b95b5f873a8900f77cfbcc4a1b02c527d3db747f6d2f972248aeebdd7aa",
  "packages/domain/src/canonical.ts": "db90644577aa27763424157f766f104bbae492caceeeed603809a8c01c103711",
  "packages/domain/src/catalog.ts": "0b95511dfe4b83c7fa5f3c8a7f805886721d63b65942b5d6cfadc795d23eb490",
  "packages/domain/src/decode.ts": "fc6f25179d4feb48b2a4768bb204e7446da17278431edbdb9ab84570e1bd8390",
  "packages/domain/src/index.ts": "3a0a68ac4e0db1ea80eead336bfe58ac192473c6523ccfef648087b64cde51b1",
  "packages/domain/src/types.ts": "a645f28ffcbdb702a6a8263f317337a8448c77575441c4feedab23764c20f7f6",
  "packages/domain/src/validation.ts": "dacfb90f3ca43b52500f1f266119c3972090915cde2e20899a80a41973bda086",
  "scripts/run-stage09p-m1-check.mjs": "b88059751348f54b963c8acfe6712d589aba8be35c1180938bfef65fe71bfaa8",
  "scripts/tests/stage09p-m1-check.test.mjs": "1522545ca676bb77d428195488d60e825cf7e12b0fdf0c61a3c6cb5a2cf025a5",
});
const REPAIRED_SHA256 = Object.freeze({
  "packages/domain/src/resolution.ts": "1b16173d5aee5290eab17dd12aba63f5f350ca9d910909f07b755cdd9f42f2d0",
  "packages/domain/tests/household-safety.test.ts": "a4cf28d175d6337d30fec4a15b378054d02ad67caed487888025acd20d2c58dc",
  "scripts/tests/stage09p-m1-scope.test.mjs": "e8c2443b013467a4dad2181f7fb32c9be9e5c5b2454bf8fc9013fb529ec6ce10",
  "scripts/tests/stage09p-m1-source-pack.test.mjs": "314db222cbf577983264ec2b73c8491a08d173aeb337f61093f6cb9c625bf9e6",
});
export const STAGE09P_M1_PRIVATE_SEAMS = Object.freeze([
  "__test" + "OnlyAnalyzeSyntheticHouseholdSafety", "__test" + "OnlyEvaluateAnalyzedHouseholdSafety",
  "__test" + "OnlyEvaluateGovernedHouseholdSafetyScenario",
]);
const EXPECTED_PATH_LIST_SHA = "3cbd274cb9e358e962e193c05f678d3ee54973b8927fe65aa26241984a2bc9c0";
const SCOPE_TEST_PATH = "scripts/tests/stage09p-m1-scope.test.mjs";
const SCOPE_CHECKER_PATH = "scripts/check-stage09p-m1-scope.mjs";
const HOUSEHOLD_TEST_PATH = "packages/domain/tests/household-safety.test.ts";
const RESOLUTION_PATH = "packages/domain/src/resolution.ts";
const INDEX_PATH = "packages/domain/src/index.ts";
const PACK_PATH = "data/reference/ingredients/stage09p-m1-household-safety-source-pack.json";
const fail = (id, detail = "") => { throw new Error(detail === "" ? id : id + ": " + detail); };
const lines = (value) => value === "" ? [] : value.replace(/\n$/u, "").split("\n");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const read = (root, path) => readFileSync(join(root, path), "utf8");
const json = (root, path) => JSON.parse(read(root, path));
const git = (root, args) => {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    fail("git", (args.join(" ") + " " + (result.stderr ?? "")).trim());
  }
  return result.stdout;
};
const sameStrings = (actual, expected) =>
  JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const stableJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const entries = Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ":" + stableJson(value[key]));
  return "{" + entries.join(",") + "}";
};
export const collectStage09pM1DiffEntries = (root, base = STAGE09P_M1_BASE_HEAD) => {
  const entries = [];
  for (const line of lines(
    git(root, ["diff", "--name-status", "--no-renames", base, "--"]),
  )) {
    const fields = line.split("\t");
    if (fields.length !== 2) fail("write-set", line);
    entries.push(Object.freeze({ path: fields[1], status: fields[0] }));
  }
  for (const line of lines(git(root, ["status", "--porcelain=v1", "-uall"]))) {
    if (line.startsWith("?? ")) {
      entries.push(Object.freeze({ path: line.slice(3), status: "A" }));
    }
  }
  return Object.freeze(entries);
};
export const assertStage09pM1DiffProjection = (entries) => {
  const expected = new Map([
    ...STAGE09P_M1_MODIFIED_PATHS.map((path) => [path, "M"]),
    ...STAGE09P_M1_ADDED_PATHS.map((path) => [path, "A"]),
  ]);
  if (entries.length !== expected.size) fail("write-set", "cardinality");
  const seen = new Set();
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.path !== "string" ||
      typeof entry.status !== "string" ||
      seen.has(entry.path) ||
      expected.get(entry.path) !== entry.status
    ) {
      fail("write-set", JSON.stringify(entry));
    }
    seen.add(entry.path);
  }
  const pathBytes = Buffer.from([...seen].sort().join("\n") + "\n");
  if (sha256(pathBytes) !== EXPECTED_PATH_LIST_SHA) {
    fail("write-set", "path-list");
  }
};
const assertCommitAnchor = (root, head, tree, parent, paths, detail) => {
  const nameStatus = paths === undefined ? [] : lines(git(root,
    ["diff", "--name-status", "--no-renames", parent, head]));
  if (
    git(root, ["rev-parse", head + "^{tree}"]).trim() !== tree ||
    git(root, ["rev-list", "--parents", "-n", "1", head]).trim() !== head + " " + parent ||
    (paths !== undefined && !sameStrings(nameStatus, paths.map((path) => "M\t" + path)))
  ) fail("identity", detail);
};
const assertIdentity = (root, expectedBase) => {
  if (expectedBase !== STAGE09P_M1_BASE_HEAD) fail("identity", "base argument");
  if (
    git(root, ["rev-parse", expectedBase]).trim() !== expectedBase ||
    git(root, ["rev-parse", expectedBase + "^{tree}"]).trim() !== STAGE09P_M1_BASE_TREE
  ) {
    fail("identity", "base commit/tree");
  }
  if (
    lines(git(root, ["ls-tree", "-r", "--name-only", expectedBase])).length !==
    STAGE09P_M1_BASE_TRACKED_FILES
  ) {
    fail("identity", "base tracked count");
  }
  if (git(root, ["diff", "--cached", "--name-only"]).trim() !== "") {
    fail("identity", "staged changes");
  }
  assertCommitAnchor(root, STAGE09P_M1_FAILED_HEAD, STAGE09P_M1_FAILED_TREE,
    STAGE09P_M1_BASE_HEAD, undefined, "failed anchor");
  assertCommitAnchor(root, STAGE09P_M1_EVIDENCE_HEAD, STAGE09P_M1_EVIDENCE_TREE,
    STAGE09P_M1_FAILED_HEAD, STAGE09P_M1_FAILED_REPAIR_PATHS, "evidence anchor");
  assertCommitAnchor(root, STAGE09P_M1_C1_HEAD, STAGE09P_M1_C1_TREE,
    STAGE09P_M1_EVIDENCE_HEAD, STAGE09P_M1_REPAIR_PATHS, "C1 anchor");
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const status = git(root, ["status", "--porcelain=v1", "-uall"]);
  const tracked = lines(git(root, ["ls-files"])).length;
  if (tracked !== STAGE09P_M1_CANDIDATE_TRACKED_FILES) {
    fail("identity", "tracked count");
  }
  if (head === STAGE09P_M1_C1_HEAD) {
    const expectedStatus = STAGE09P_M1_CORRECTION_PATHS.map((path) => " M " + path);
    if (!sameStrings(lines(status), expectedStatus)) fail("identity", "correction status");
  } else {
    const parents = git(root, ["rev-list", "--parents", "-n", "1", head])
      .trim()
      .split(" ");
    const repairDiff = lines(
      git(root, ["diff", "--name-status", "--no-renames", STAGE09P_M1_C1_HEAD, head]),
    );
    if (
      parents.length !== 2 ||
      parents[0] !== head ||
      parents[1] !== STAGE09P_M1_C1_HEAD ||
      status !== "" ||
      !sameStrings(
        repairDiff,
        STAGE09P_M1_CORRECTION_PATHS.map((path) => "M\t" + path),
      )
    ) {
      fail("identity", "correction commit");
    }
  }
};
const parseTree = (text, indexFormat) => {
  const result = new Map();
  for (const line of lines(text)) {
    const match = indexFormat
      ? /^(100644|100755|120000) [0-9a-f]{40} 0\t(.+)$/u.exec(line)
      : /^(100644|100755|120000) blob [0-9a-f]{40}\t(.+)$/u.exec(line);
    if (match === null) fail("mode-type", line);
    result.set(match[2], match[1]);
  }
  return result;
};
export const assertStage09pM1FileMode = ({ isFile, mode, path }) => {
  if (!isFile || (mode & 0o177777) !== 0o100644) fail("mode-type", path);
};
const assertModesAndTypes = (root) => {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const baseTree = parseTree(git(root, ["ls-tree", "-r", STAGE09P_M1_BASE_HEAD]), false);
  const index = parseTree(git(root, ["ls-files", "--stage"]), true);
  for (const path of STAGE09P_M1_ALLOWED_PATHS) {
    const stat = lstatSync(join(root, path));
    assertStage09pM1FileMode({ isFile: stat.isFile(), mode: stat.mode, path });
    if (STAGE09P_M1_MODIFIED_PATHS.includes(path)) {
      if (baseTree.get(path) !== "100644" || index.get(path) !== "100644") {
        fail("mode-type", path);
      }
    } else if (
      baseTree.has(path) ||
      (head === STAGE09P_M1_BASE_HEAD
        ? index.has(path)
        : index.get(path) !== "100644")
    ) {
      fail("mode-type", path);
    }
  }
};
const assertNonRepairSnapshot = (root) => {
  if (Object.keys(NON_REPAIR_SNAPSHOT).length !== 16 ||
      Object.keys(REPAIRED_SHA256).length !== 4) {
    fail("snapshot", "cardinality");
  }
  for (const [path, expected] of Object.entries({
    ...NON_REPAIR_SNAPSHOT,
    ...REPAIRED_SHA256,
  })) {
    if (sha256(readFileSync(join(root, path))) !== expected) {
      fail("snapshot", path);
    }
  }
};
export const assertStage09pM1PackageProjection = (baseRaw, currentRaw) => {
  const addedLine =
    '    "stage09p:m1:check": "node scripts/run-stage09p-m1-check.mjs",\n';
  if (currentRaw.split(addedLine).length - 1 !== 1) {
    fail("package", "raw line");
  }
  if (currentRaw.replace(addedLine, "") !== baseRaw) {
    fail("package", "raw projection");
  }
  const base = JSON.parse(baseRaw);
  const current = JSON.parse(currentRaw);
  if (
    Object.hasOwn(base.scripts, "stage09p:m1:check") ||
    current.scripts?.["stage09p:m1:check"] !==
      "node scripts/run-stage09p-m1-check.mjs"
  ) {
    fail("package", "script key");
  }
  const projected = { ...current, scripts: { ...current.scripts } };
  delete projected.scripts["stage09p:m1:check"];
  if (stableJson(projected) !== stableJson(base)) {
    fail("package", "object projection");
  }
};
export const extractStage09pM1ImportSpecifiers = (source) => {
  const specifiers = [];
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s+["']([^"']+)["']/gu,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return Object.freeze(specifiers);
};
export const assertStage09pM1ProductionImports = (moduleSources) => {
  const combined = [...moduleSources.values()].join("\n");
  const forbidden = [
    "node:" + "module",
    "create" + "Require",
    "type" + "script",
    "ts-" + "morph",
    "ac" + "orn",
    "@ba" + "bel",
  ];
  if (
    forbidden.some((token) => combined.includes(token)) ||
    /\bimport\s*\(/u.test(combined) ||
    /\brequire\s*\(/u.test(combined)
  ) {
    fail("imports", "loader");
  }
  const actual = new Set();
  for (const source of moduleSources.values()) {
    for (const specifier of extractStage09pM1ImportSpecifiers(source)) {
      if (!STAGE09P_M1_PRODUCTION_IMPORT_SPECIFIERS.includes(specifier)) {
        fail("imports", specifier);
      }
      actual.add(specifier);
    }
  }
  if (!sameStrings(actual, STAGE09P_M1_PRODUCTION_IMPORT_SPECIFIERS)) {
    fail("imports", "closed set");
  }
};
const collectModuleSources = (root) => {
  const directory = join(root, "packages/domain/src");
  const modules = readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
  if (!sameStrings(modules, STAGE09P_M1_DOMAIN_MODULES)) {
    fail("modules", "seven-module set");
  }
  return new Map(
    modules.map((module) => [module, readFileSync(join(directory, module), "utf8")]),
  );
};
const assertM0Tcb = (root) => {
  for (const [path, expected] of Object.entries(STAGE09P_M1_M0_TCB)) {
    if (sha256(readFileSync(join(root, path))) !== expected) {
      fail("m0-tcb", path);
    }
  }
};
const occurrenceCount = (source, token) => source.split(token).length - 1;
export const assertStage09pM1PublicBoundary = (indexSource, resolutionSource) => {
  const trustName = "TRUSTED_ACTIVE_" + "HOUSEHOLD_SAFETY_PACK_DIGESTS";
  const privateRootTokens = [
    ...STAGE09P_M1_PRIVATE_SEAMS,
    trustName,
    "Internal" + "SyntheticGovernedGraph",
    "Internal" + "SyntheticAnalyzedScenario",
    "Internal" + "AnalyzedHouseholdSafetyState",
  ];
  if (privateRootTokens.some((token) => indexSource.includes(token))) {
    fail("public-boundary", "private export");
  }
  for (const publicName of [
    "decodeActivationContext",
    "evaluateHouseholdDishSafety",
    "resolveGovernedReference",
    "resolveHardMapping",
  ]) {
    if (occurrenceCount(indexSource, publicName) !== 1) {
      fail("public-boundary", publicName);
    }
  }
  const emptyDeclaration =
    "const " + trustName + ": readonly Digest[] = [];";
  const helperName = "isTrustedActiveHouseholdSafetyPackDigest";
  const helper = [
    emptyDeclaration, "", "const " + helperName + " = (", "  candidate: Digest,",
    "): boolean => {", "  let index = 0;",
    "  while (index < " + trustName + ".length) {",
    "    if (" + trustName + "[index] === candidate) return true;",
    "    index += 1;", "  }", "  return false;", "};",
  ].join("\n");
  if (
    occurrenceCount(resolutionSource, trustName) !== 3 ||
    occurrenceCount(resolutionSource, helperName) !== 2 ||
    !resolutionSource.includes(helper) ||
    !resolutionSource.includes("if (!" + helperName + "(sourcePackDigest)) {") ||
    resolutionSource.includes("export " + emptyDeclaration)
  ) {
    fail("zero-trust", "allowlist");
  }
};
export const assertStage09pM1CorrectionSources = (
  sourceTest,
  c1Household,
  household,
) => {
  const staticImport = 'import { createHash } from "node:crypto";';
  const digestCall = 'createHash("sha256").update(value).digest("hex")';
  const forbidden = ["process." + "getBuiltinModule", "create" + "Require", "node:" + "module"];
  if (
    occurrenceCount(sourceTest, staticImport) !== 1 ||
    occurrenceCount(sourceTest, digestCall) !== 1 ||
    forbidden.some((token) => sourceTest.includes(token)) ||
    /\bimport\s*\(/u.test(sourceTest) || /\brequire\s*\(/u.test(sourceTest) ||
    /\b(?:eval|Function)\s*\(/u.test(sourceTest)
  ) fail("correction-source", "loader");
  const c1 = Buffer.from(c1Household);
  const current = Buffer.from(household);
  if (current.length <= c1.length || !current.subarray(0, c1.length).equals(c1)) {
    fail("correction-source", "household prefix");
  }
  const suffix = current.subarray(c1.length);
  if (suffix.length > 4096 || suffix.filter((byte) => byte === 0x0a).length > 48) {
    fail("correction-source", "household suffix");
  }
};
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".js", ".json", ".md", ".mjs", ".ts", ".tsx", ".yaml", ".yml",
]);
export const collectStage09pM1TextSources = (root) => {
  const paths = new Set([
    ...lines(git(root, ["ls-files"])),
    ...STAGE09P_M1_ALLOWED_PATHS,
  ]);
  const sources = new Map();
  for (const path of paths) {
    const absolute = join(root, path);
    if (
      TEXT_EXTENSIONS.has(extname(path)) &&
      existsSync(absolute) &&
      lstatSync(absolute).isFile()
    ) {
      sources.set(path, readFileSync(absolute, "utf8"));
    }
  }
  return sources;
};
export const assertStage09pM1PrivateSeamLocations = (sources) => {
  const expectedPaths = [HOUSEHOLD_TEST_PATH, RESOLUTION_PATH];
  for (const seam of STAGE09P_M1_PRIVATE_SEAMS) {
    const paths = [...sources]
      .filter(([, source]) => source.includes(seam))
      .map(([path]) => path);
    if (!sameStrings(paths, expectedPaths)) fail("private-seams", seam);
  }
  const resolution = sources.get(RESOLUTION_PATH) ?? "";
  const exports = [
    ...resolution.matchAll(/\bexport const (__testOnly[A-Za-z0-9_]+)\s*=/gu),
  ].map((match) => match[1]);
  if (!sameStrings(exports, STAGE09P_M1_PRIVATE_SEAMS)) {
    fail("private-seams", "export set");
  }
};
export const assertStage09pM1DraftBoundary = (pack) => {
  if (
    pack?.schemaVersion !== 2 ||
    pack?.lifecycleStatus !== "draft" ||
    !Array.isArray(pack?.mappingReviews) ||
    pack.mappingReviews.length !== 0 ||
    !Array.isArray(pack?.catalog?.hardMappings) ||
    pack.catalog.hardMappings.length !== 0 ||
    !Array.isArray(pack?.catalog?.releases)
  ) {
    fail("draft-boundary", "pack");
  }
  const envelopes = pack.catalog.releases.flatMap((release) =>
    Array.isArray(release.envelopes) ? release.envelopes : [],
  );
  if (envelopes.length === 0) fail("draft-boundary", "envelopes");
  for (const envelope of envelopes) {
    const evidence = envelope.officialEvidence;
    if (
      envelope.lifecycleStatus === "active" ||
      !Array.isArray(envelope.approvers) ||
      envelope.approvers.length !== 0 ||
      envelope.licenseStatus !== "pending" ||
      envelope.syntheticEvidence !== undefined ||
      evidence?.classification !== "official_source_projection" ||
      evidence?.containsRealUserData !== false ||
      evidence?.usageStatus !== "pending" ||
      evidence?.factDisposition === "REVIEWED_CLEAR"
    ) {
      fail("draft-boundary", "envelope");
    }
  }
};
const physicalLines = (source) =>
  source === "" ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
const assertCheckerShape = (root) => {
  const checker = read(root, SCOPE_CHECKER_PATH);
  const dedicatedTest = read(root, SCOPE_TEST_PATH);
  const sourceChecker = read(root, "scripts/check-stage09p-m1-source-pack.mjs");
  const sourceTest = read(root, "scripts/tests/stage09p-m1-source-pack.test.mjs");
  assertStage09pM1CorrectionSources(
    sourceTest,
    git(root, ["show", STAGE09P_M1_C1_HEAD + ":" + HOUSEHOLD_TEST_PATH]),
    read(root, HOUSEHOLD_TEST_PATH),
  );
  if (physicalLines(checker) > 600 || physicalLines(dedicatedTest) > 300 ||
      physicalLines(sourceChecker) > 430 || physicalLines(sourceTest) > 260) {
    fail("line-caps");
  }
  const forbidden = [
    "node:" + "module", "create" + "Require", "parse" + "ManifestRows",
    "checkGuest" + "MatrixSources", "checkContext" + "OracleSources",
    "checkManifest" + "Sources", "EXPECTED_ROUTE_" + "HISTOGRAM",
  ];
  if (
    forbidden.some((token) => checker.includes(token)) ||
    /\b(?:eval|Function)\s*\(/u.test(checker) ||
    /\bimport\s*\(/u.test(checker)
  ) {
    fail("checker-shape");
  }
};
const assertForbiddenSurfaces = () => {
  const prefixes = [
    ".github/", "apps/", "infra/", "packages/contracts/",
    "packages/domain/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "services/",
  ];
  if (
    STAGE09P_M1_ALLOWED_PATHS.some((path) =>
      prefixes.some((prefix) => path === prefix || path.startsWith(prefix)),
    ) ||
    STAGE09P_M1_ALLOWED_PATHS.some(
      (path) => path.includes("stage09a") || path.includes("stage09p-m0"),
    )
  ) {
    fail("forbidden-surfaces");
  }
};
const RULES = Object.freeze([
  ["identity", (root, options) => assertIdentity(root, options.expectedBase ?? "")],
  ["write-set", (root) => assertStage09pM1DiffProjection(collectStage09pM1DiffEntries(root))],
  ["mode-type", (root) => assertModesAndTypes(root)],
  ["snapshot", (root) => assertNonRepairSnapshot(root)],
  ["package", (root) => assertStage09pM1PackageProjection(
    git(root, ["show", STAGE09P_M1_BASE_HEAD + ":package.json"]),
    read(root, "package.json"),
  )],
  ["modules-imports", (root) => assertStage09pM1ProductionImports(collectModuleSources(root))],
  ["m0-tcb", (root) => assertM0Tcb(root)],
  ["public-zero-trust", (root) => assertStage09pM1PublicBoundary(
    read(root, INDEX_PATH), read(root, RESOLUTION_PATH),
  )],
  ["private-seams", (root) => assertStage09pM1PrivateSeamLocations(
    collectStage09pM1TextSources(root),
  )],
  ["draft-boundary", (root) => assertStage09pM1DraftBoundary(json(root, PACK_PATH))],
  ["forbidden-surfaces", () => assertForbiddenSurfaces()],
  ["checker-shape", (root) => assertCheckerShape(root)],
].map(Object.freeze));
export const checkStage09pM1Scope = (repositoryRoot, options = {}) => {
  const failures = [];
  for (const [id, rule] of RULES) {
    try {
      rule(repositoryRoot, options);
    } catch {
      failures.push(id);
    }
  }
  return Object.freeze({ failures: Object.freeze(failures), ok: failures.length === 0 });
};
const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const prefix = "--expected-base=";
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  const expectedBase = argument?.slice(prefix.length) ?? "";
  if (!/^[0-9a-f]{40}$/u.test(expectedBase)) {
    process.stderr.write("stage09p:m1 scope FAIL expected-base\n");
    process.exitCode = 1;
  } else {
    const result = checkStage09pM1Scope(resolve(dirname(scriptPath), ".."), {
      expectedBase,
    });
    if (result.ok) {
      process.stdout.write("stage09p:m1 boundary scope COMPLETE\n");
    } else {
      for (const id of result.failures) {
        process.stderr.write("stage09p:m1 scope FAIL " + id + "\n");
      }
      process.exitCode = 1;
    }
  }
}
