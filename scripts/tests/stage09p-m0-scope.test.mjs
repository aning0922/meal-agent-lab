import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkStage09pM0Scope } from "../check-stage09p-m0-scope.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const copiedPaths = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "packages/domain/package.json",
  "packages/domain/src",
  "data/schemas/governance-release.schema.json",
  "data/schemas/governance-catalog.schema.json",
  "data/samples/stage09p-m0",
  "scripts/check-stage09p-m0-scope.mjs",
  "scripts/run-stage09p-m0-check.mjs",
  "scripts/tests/stage09p-m0-scope.test.mjs",
  "scripts/tests/stage09p-m0-check.test.mjs",
]);

const makeInertCopy = () => {
  const root = mkdtempSync(join(tmpdir(), "stage09p-m0-scope-"));
  for (const path of copiedPaths) {
    const source = join(repositoryRoot, path);
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  return root;
};

const withCopy = (mutate, expectedFailures) => {
  const root = makeInertCopy();
  try {
    mutate(root);
    const result = checkStage09pM0Scope(root);
    assert.deepStrictEqual(result, {
      failures: expectedFailures,
      ok: expectedFailures.length === 0,
    });
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.failures));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

test("candidate surface passes in an inert temporary copy", () => {
  withCopy(() => {}, []);
});

test("production-files rejects an eighth production module", () => {
  withCopy((root) => writeFileSync(join(root, "packages/domain/src/extra.ts"), "export {};\n"), [
    "production-files",
  ]);
});

test("production-imports rejects Node and undeclared runtime edges", () => {
  withCopy(
    (root) => appendFileSync(join(root, "packages/domain/src/types.ts"), '\nimport "node:fs";\n'),
    ["production-imports"],
  );
});

test("workspace-wiring rejects workspace, package, root, and lock drift", async (t) => {
  const cases = [
    ["workspace", (root) => writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n")],
    [
      "domain package",
      (root) => {
        const path = join(root, "packages/domain/package.json");
        const value = JSON.parse(readFileSync(path, "utf8"));
        value.dependencies["second-authority"] = "1.0.0";
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      },
    ],
    [
      "root wiring",
      (root) => {
        const path = join(root, "package.json");
        const value = JSON.parse(readFileSync(path, "utf8"));
        value.scripts.typecheck = "true";
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      },
    ],
    [
      "lock importer",
      (root) => {
        const path = join(root, "pnpm-lock.yaml");
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(
            "  packages/domain:\n    dependencies:\n      '@noble/hashes':\n        specifier: 2.0.1",
            "  packages/domain:\n    dependencies:\n      '@noble/hashes':\n        specifier: 2.0.0",
          ),
        );
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => withCopy(mutate, ["workspace-wiring"]));
  }
});

test("schema-boundary rejects a custom schema authority", () => {
  withCopy((root) => {
    const path = join(root, "data/schemas/governance-release.schema.json");
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.negativeZeroAuthority = true;
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }, ["schema-boundary"]);
});

test("schema-boundary rejects loss of decode.ts negative-zero ownership", () => {
  withCopy((root) => {
    const path = join(root, "packages/domain/src/decode.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace("Object.is(value, -0)", "value === 0"));
  }, ["schema-boundary"]);
});

test("fixture-inventory rejects count and synthetic-namespace drift", async (t) => {
  await t.test("5 + 10 inventory", () =>
    withCopy(
      (root) => unlinkSync(join(root, "data/samples/stage09p-m0/invalid/negative-zero.json")),
      ["fixture-inventory"],
    ),
  );
  await t.test("synthetic namespace", () =>
    withCopy((root) => {
      const path = join(root, "data/samples/stage09p-m0/valid/allergen.json");
      writeFileSync(path, readFileSync(path, "utf8").replaceAll("syn:", "fixture:").replaceAll("synthetic", "inert"));
    }, ["fixture-inventory"]),
  );
});

test("legacy-meta rejects a returned mutation or guard registry", () => {
  withCopy((root) => writeFileSync(join(root, "scripts/stage09p-mutant-registry.mjs"), "export {};\n"), [
    "legacy-meta",
  ]);
});

test("small-surface rejects a gate that grows beyond its bounded role", () => {
  withCopy(
    (root) => appendFileSync(join(root, "scripts/run-stage09p-m0-check.mjs"), "\n".repeat(121)),
    ["small-surface"],
  );
});
