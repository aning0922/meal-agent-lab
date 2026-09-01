import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import test from "node:test";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

import {
  decodeGovernanceCatalog,
  decodeGovernanceReleaseJson,
  verifyGovernanceReleaseDigest,
} from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const schemaDirectory = resolve(repositoryRoot, "data/schemas");
const fixtureDirectory = resolve(repositoryRoot, "data/samples/stage09p-m0");

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
const releaseSchema = readJson(
  resolve(schemaDirectory, "governance-release.schema.json"),
) as AnySchema;
const catalogSchema = readJson(
  resolve(schemaDirectory, "governance-catalog.schema.json"),
) as AnySchema;

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(releaseSchema);
const validateRelease = ajv.getSchema(
  "synthetic://meal-agent/stage09p-m0/governance-release.schema.json",
);
const validateCatalog = ajv.compile(catalogSchema);
assert.ok(validateRelease);

const fixtureFiles = (section: "valid" | "invalid"): string[] =>
  readdirSync(resolve(fixtureDirectory, section))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => resolve(fixtureDirectory, section, name));

const officialEvidence = Object.freeze({
  classification: "official_source_projection",
  containsRealFoodFacts: true,
  containsRealUserData: false,
  fullTextCopied: false,
  purpose: "household-safety-provenance-only",
  factDisposition: "UNKNOWN_BLOCK",
  usageStatus: "pending",
});

test("schemas use only standard 2020-12 vocabulary and declare decode.ts -0 ownership", () => {
  const releaseText = JSON.stringify(releaseSchema);
  const catalogText = JSON.stringify(catalogSchema);
  assert.match(releaseText, /runtime-owned: decode\.ts scalar closure/);
  assert.match(catalogText, /runtime-owned: decode\.ts scalar closure/);
  assert.doesNotMatch(releaseText, /notNegativeZero|customKeyword|unicode-scalar/);
  assert.doesNotMatch(catalogText, /notNegativeZero|customKeyword|unicode-scalar/);
});

test("five synthetic dataset-kind fixtures satisfy schema, strict decode, and digest", () => {
  const files = fixtureFiles("valid");
  assert.equal(files.length, 5);
  const kinds = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const value = JSON.parse(text) as {
      envelopes: Array<{
        datasetKind: string;
        syntheticEvidence?: {
          classification?: string;
          containsRealFoodFacts?: boolean;
          containsRealUserData?: boolean;
        };
      }>;
    };
    assert.equal(validateRelease(value), true, `${basename(file)}: ${ajv.errorsText(validateRelease.errors)}`);
    assert.equal(decodeGovernanceReleaseJson(text).ok, true, basename(file));
    assert.equal(verifyGovernanceReleaseDigest(value).ok, true, basename(file));
    const envelope = value.envelopes[0];
    assert.ok(envelope);
    kinds.add(envelope.datasetKind);
    assert.deepEqual(envelope.syntheticEvidence, {
      classification: "fully_synthetic",
      generator: "stage09p-m0-fixture-v1",
      containsRealUserData: false,
      containsRealFoodFacts: false,
      purpose: "governance-format-and-fail-closed-testing-only",
    });
  }
  assert.deepEqual(
    [...kinds].sort(),
    ["allergen", "cooking_technique", "food_concept", "food_safety", "religious_ethical"],
  );
});

test("governance evidence branches are a symmetric exclusive XOR", () => {
  const release = readJson(fixtureFiles("valid")[0]!) as {
    envelopes: Array<Record<string, unknown>>;
  };
  const synthetic = structuredClone(release);
  const official = structuredClone(release);
  official.envelopes[0]!["approvers"] = [];
  delete official.envelopes[0]!["syntheticEvidence"];
  official.envelopes[0]!["officialEvidence"] = officialEvidence;
  const bothEmpty = structuredClone(official);
  bothEmpty.envelopes[0]!["syntheticEvidence"] = synthetic.envelopes[0]!["syntheticEvidence"];
  const bothNonempty = structuredClone(synthetic);
  bothNonempty.envelopes[0]!["officialEvidence"] = officialEvidence;
  const neither = structuredClone(official);
  delete neither.envelopes[0]!["officialEvidence"];
  const syntheticEmpty = structuredClone(synthetic);
  syntheticEmpty.envelopes[0]!["approvers"] = [];
  const cases = [
    ["XOR-SYNTHETIC-POSITIVE", synthetic, true],
    ["XOR-OFFICIAL-POSITIVE", official, true],
    ["XOR-BOTH-EMPTY", bothEmpty, false],
    ["XOR-BOTH-NONEMPTY", bothNonempty, false],
    ["XOR-NEITHER", neither, false],
    ["XOR-SYNTHETIC-EMPTY", syntheticEmpty, false],
  ] as const;
  for (const [id, value, expected] of cases) {
    assert.equal(validateRelease(value), expected, `${id}: ${ajv.errorsText(validateRelease.errors)}`);
  }
});

test("R1 invalid fixtures fail standard schema or decode at the declared capability boundary", () => {
  const schemaAcceptsNegativeZero = new Map<string, boolean>([["negative-zero.json", true]]);
  const files = fixtureFiles("invalid");
  assert.equal(files.length >= 7, true);
  for (const file of files) {
    const name = basename(file);
    const text = readFileSync(file, "utf8");
    const value = JSON.parse(text) as unknown;
    const expectedSchemaResult = schemaAcceptsNegativeZero.get(name) ?? false;
    assert.equal(validateRelease(value), expectedSchemaResult, name);
    assert.equal(decodeGovernanceReleaseJson(text).ok, false, name);
  }
});

test("catalog schema and strict decoder accept a frozen-lockfile R1 structural catalog", () => {
  const releases = fixtureFiles("valid").map((file) => readJson(file));
  const catalog = { schemaVersion: 1, releases, hardMappings: [] };
  assert.equal(validateCatalog(catalog), true, ajv.errorsText(validateCatalog.errors));
  assert.equal(decodeGovernanceCatalog(catalog).ok, true);
});

test("synthetic marker checks are structural evidence, not semantic exhaustiveness", () => {
  const invalidMarker = readJson(resolve(fixtureDirectory, "invalid/invalid-synthetic-marker.json"));
  assert.equal(validateRelease(invalidMarker), false);
  // Whether arbitrary prose encodes a real-world fact remains in Git review / independent-audit TCB.
});
