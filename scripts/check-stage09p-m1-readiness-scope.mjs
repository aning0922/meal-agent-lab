import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const anchor = "07839f11ba3466bcc9fd1981df844df5359b4887";
const baselineR2Parent = "6247960045344e9427ac40df0e4b9b1414086a4d";
const allowed = Object.freeze([
  "data/samples/stage09p-m1/readiness-empty-template.json",
  "docs/architecture/decisions/0009-stage09p-m1-release-authority-boundary.md",
  "docs/plans/2026-08-stage-09p-m1-release-readiness.md",
  "docs/project-status.md",
  "infra/docker/m3b-evidence-baseline.json",
  "package.json",
  "packages/domain/src/index.ts",
  "packages/domain/src/types.ts",
  "packages/domain/src/validation.ts",
  "packages/domain/tests/m1-readiness.test.ts",
  "scripts/check-stage09p-m1-readiness-scope.mjs",
  "scripts/run-stage09p-m1-readiness-check.mjs",
]);
const fail = (reason) => {
  process.stderr.write(`stage09p:m1 scope FAIL ${reason}\n`);
  process.exit(1);
};
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const changed = [...new Set([
  ...git("diff", "--name-only", anchor).split("\n"),
  ...git("ls-files", "--others", "--exclude-standard").split("\n"),
])].filter(Boolean).sort();
if (JSON.stringify(changed) !== JSON.stringify([...allowed].sort())) fail("changed-files");

const baselineR2Matches = () => {
  try {
    const path = "infra/docker/m3b-evidence-baseline.json";
    const before = execFileSync("git", ["show", `${baselineR2Parent}:${path}`], { cwd: root });
    const from = Buffer.from('"trackedFileCount": 417');
    const to = Buffer.from('"trackedFileCount": 423');
    const offset = before.indexOf(from);
    if (offset < 0 || before.indexOf(from, offset + from.length) >= 0) return false;
    const expected = Buffer.concat([
      before.subarray(0, offset), to, before.subarray(offset + from.length),
    ]);
    return expected.equals(readFileSync(resolve(root, path)));
  } catch {
    return false;
  }
};
if (!baselineR2Matches()) fail("baseline-r2");

const modules = readdirSync(resolve(root, "packages/domain/src"))
  .filter((name) => name.endsWith(".ts")).sort();
if (JSON.stringify(modules) !== JSON.stringify([
  "canonical.ts", "catalog.ts", "decode.ts", "index.ts", "resolution.ts", "types.ts", "validation.ts",
])) fail("production-modules");

const additions = new Map(git("diff", "--numstat", anchor).split("\n").filter(Boolean)
  .map((line) => { const [added, , path] = line.split("\t"); return [path, Number(added)]; }));
const added = (path) => additions.get(path) ??
  readFileSync(resolve(root, path), "utf8").split("\n").length - 1;
const productionDelta = ["types.ts", "validation.ts", "index.ts"]
  .reduce((sum, name) => sum + added(`packages/domain/src/${name}`), 0);
if (productionDelta > 300) fail("production-line-budget");
if (added("packages/domain/tests/m1-readiness.test.ts") > 420) fail("test-line-budget");
for (const name of ["check-stage09p-m1-readiness-scope.mjs", "run-stage09p-m1-readiness-check.mjs"]) {
  if (added(`scripts/${name}`) > 140) fail("script-line-budget");
}
if (added("data/samples/stage09p-m1/readiness-empty-template.json") > 100) {
  fail("template-line-budget");
}

const template = JSON.parse(readFileSync(resolve(root,
  "data/samples/stage09p-m1/readiness-empty-template.json"), "utf8"));
if (template.classification !== "fully_synthetic_empty_template" ||
  template.authorities.length !== 0 || template.sources.length !== 0 ||
  template.reviewDecisions.length !== 0 || Object.values(template.target).some(Boolean)) {
  fail("empty-template");
}
const production = ["types.ts", "validation.ts", "index.ts"]
  .map((name) => readFileSync(resolve(root, `packages/domain/src/${name}`), "utf8")).join("\n");
if (/from ["'](?:node:|https?:)|\bfetch\s*\(|child_process|ACTIVATION_ELIGIBLE\s*->\s*active/.test(production)) {
  fail("forbidden-production-capability");
}
const preparation = readFileSync(resolve(root,
  "data/samples/stage09p-m1/readiness-empty-template.json"), "utf8");
if (/https?:\/\/|zh-CN|@(?:gmail|outlook)|licenseStatus\s*:\s*"approved"/.test(preparation)) {
  fail("real-content-marker");
}
process.stdout.write("stage09p:m1 scope PASS\n");
