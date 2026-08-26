import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { canonicalReleaseDigest, verifyGovernanceReleaseDigest } from "../src/canonical.js";
import { decodeGovernanceReleaseJson } from "../src/decode.js";
import type { GovernanceCatalog, GovernanceRelease } from "../src/types.js";
import { validateGovernanceCatalog } from "../src/validation.js";

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [P in keyof T]: Mutable<T[P]> }
    : T;

const fixtureRoot = new URL("../../../data/samples/stage09p-m0/", import.meta.url);
const files = (directory: "valid" | "invalid"): readonly string[] =>
  readdirSync(new URL(`${directory}/`, fixtureRoot)).filter((name) => name.endsWith(".json")).sort();
const read = (directory: "valid" | "invalid", name: string): string =>
  readFileSync(new URL(`${directory}/${name}`, fixtureRoot), "utf8");

test("fixture inventory is exactly 5 valid and 10 invalid, with no real-user assertions", () => {
  assert.deepStrictEqual(files("valid"), [
    "allergen.json",
    "cooking-technique.json",
    "food-concept.json",
    "food-safety.json",
    "religious-ethical.json",
  ]);
  assert.deepStrictEqual(files("invalid"), [
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
  for (const directory of ["valid", "invalid"] as const) {
    for (const name of files(directory)) {
      const text = read(directory, name);
      assert.equal(/(?:real user|real household|real purchase|patient)/i.test(text), false, name);
    }
  }
});

test("all 5 valid synthetic releases remain decoded, signed and catalog-valid", () => {
  for (const name of files("valid")) {
    const text = read("valid", name);
    const decoded = decodeGovernanceReleaseJson(text);
    assert.equal(decoded.ok, true, name);
    assert.equal(verifyGovernanceReleaseDigest(JSON.parse(text)).ok, true, name);
    assert.deepStrictEqual(
      validateGovernanceCatalog({
        schemaVersion: 1,
        releases: [JSON.parse(text)],
        hardMappings: [],
      }),
      [],
      name,
    );
  }
});

test("the 7 R1 invalid fixtures remain invalid under their original direct boundary", () => {
  const shapeInvalid = [
    "invalid-digest.json",
    "invalid-synthetic-marker.json",
    "lone-surrogate.json",
    "missing-required.json",
    "negative-zero.json",
    "unknown-own-key.json",
    "unsafe-integer.json",
  ];
  for (const name of shapeInvalid) {
    assert.equal(decodeGovernanceReleaseJson(read("invalid", name)).ok, false, name);
  }
});

test("the 3 R2 invalid catalog fixtures have exact ordinary graph failures", () => {
  assert.deepStrictEqual(
    validateGovernanceCatalog(JSON.parse(read("invalid", "empty-catalog.json"))),
    [{ code: "INVALID_SHAPE", path: "/releases" }],
  );
  assert.deepStrictEqual(
    validateGovernanceCatalog(JSON.parse(read("invalid", "duplicate-hard-mapping.json"))),
    [{ code: "DUPLICATE_HARD_MAPPING", path: "/hardMappings/1/mappingId" }],
  );
  assert.deepStrictEqual(
    validateGovernanceCatalog(JSON.parse(read("invalid", "hard-mapping-unresolved.json"))),
    [{ code: "HARD_MAPPING_TARGET_UNRESOLVED", path: "/hardMappings/0/target" }],
  );
});

test("Y01 a deeply embedded externalFact marker has one fixed synthetic issue", () => {
  const release = JSON.parse(read("valid", "food-concept.json")) as Mutable<GovernanceRelease>;
  release.envelopes[0]!.content = {
    syntheticToken: "SYNTHETIC_OUTER",
    nested: [{ externalFact: "SYNTHETIC_FORBIDDEN_MARKER" }],
  };
  release.contentDigest = `sha256:${"0".repeat(64)}`;
  release.contentDigest = canonicalReleaseDigest(release);
  const input: GovernanceCatalog = {
    schemaVersion: 1,
    releases: [release as GovernanceRelease],
    hardMappings: [],
  };
  assert.deepStrictEqual(validateGovernanceCatalog(input), [
    {
      code: "INVALID_SYNTHETIC_EVIDENCE",
      path: "/releases/0/envelopes/0/content/nested/0/externalFact",
    },
  ]);
});
