import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  checkStage09pM1SourcePackContract,
  classifySourceInventoryProjection,
} from "../check-stage09p-m1-source-pack.mjs";

const root = resolve(import.meta.dirname, "../..");
const realPack = JSON.parse(
  readFileSync(
    resolve(
      root,
      "data/reference/ingredients/stage09p-m1-household-safety-source-pack.json",
    ),
    "utf8",
  ),
);
const asOf = "2026-08-29T00:00:00.000Z";
const clone = (value) => structuredClone(value);

test("closed source inventory projections return exact frozen three-key objects", () => {
  const positive = [
    "explicit_ingredient",
    "explicit_contains",
    "explicit_may_contain",
    "explicit_shared_line",
    "explicit_shared_equipment",
  ];
  const unknown = [
    "warning_absent",
    "negative_free_from_claim",
    "compound_unexpanded",
    "extraction_uncertain",
    "outside_prepackaged_scope",
  ];
  for (const projectionKind of positive) {
    const actual = classifySourceInventoryProjection(projectionKind);
    assert.deepStrictEqual(actual, {
      schemaVersion: 1,
      projectionKind,
      factDisposition: "POSITIVE_BLOCK",
    });
    assert.equal(Object.isFrozen(actual), true);
  }
  for (const projectionKind of unknown) {
    const actual = classifySourceInventoryProjection(projectionKind);
    assert.deepStrictEqual(actual, {
      schemaVersion: 1,
      projectionKind,
      factDisposition: "UNKNOWN_BLOCK",
    });
    assert.equal(Object.isFrozen(actual), true);
  }
});

test("unknown and non-string projections fail closed without default clear", () => {
  const expected = {
    ok: false,
    issue: { code: "UNKNOWN_PROJECTION_KIND", path: "/projectionKind" },
  };
  for (const value of ["unexpected_kind", 1, null, undefined]) {
    const actual = classifySourceInventoryProjection(value);
    assert.deepStrictEqual(actual, expected);
    assert.equal(Object.isFrozen(actual), true);
    assert.equal(Object.isFrozen(actual.issue), true);
  }
});

test("real draft passes the complete source-pack contract", () => {
  assert.deepStrictEqual(checkStage09pM1SourcePackContract(realPack, asOf), {
    ok: true,
    issues: [],
  });
});

test("wrong civil date, effective boundary and source class are rejected", () => {
  const wrongCivil = clone(realPack);
  wrongCivil.sourceVersionWindows[0].sourceCivilEffectiveDate = "2027-03-16";
  assert.equal(checkStage09pM1SourcePackContract(wrongCivil, asOf).ok, false);

  const wrongFrom = clone(realPack);
  wrongFrom.sourceVersionWindows[0].effectiveFrom = "2012-04-20T00:00:00.000Z";
  assert.equal(checkStage09pM1SourcePackContract(wrongFrom, asOf).ok, false);

  const wrongUntil = clone(realPack);
  wrongUntil.sourceVersionWindows[0].effectiveUntil = null;
  assert.equal(checkStage09pM1SourcePackContract(wrongUntil, asOf).ok, false);

  const synthetic = clone(realPack);
  synthetic.catalog.releases[0].envelopes[0].syntheticEvidence = {
    classification: "fully_synthetic",
  };
  assert.equal(checkStage09pM1SourcePackContract(synthetic, asOf).ok, false);
});

test("activation, reviewed clear, license, usage and user-data mutants fail", () => {
  const mapping = clone(realPack);
  mapping.catalog.hardMappings.push({
    mappingId: "mapping:forbidden",
    source: { datasetId: "x", entityId: "x", entityRevision: 1 },
    target: { datasetId: "y", entityId: "y", entityRevision: 1 },
    required: true,
  });
  assert.equal(checkStage09pM1SourcePackContract(mapping, asOf).ok, false);

  const reviewedClear = clone(realPack);
  reviewedClear.catalog.releases[0].envelopes[0].officialEvidence.factDisposition =
    "REVIEWED_CLEAR";
  assert.equal(checkStage09pM1SourcePackContract(reviewedClear, asOf).ok, false);

  const license = clone(realPack);
  license.catalog.releases[0].envelopes[0].licenseStatus = "approved";
  assert.equal(checkStage09pM1SourcePackContract(license, asOf).ok, false);

  const usage = clone(realPack);
  usage.catalog.releases[0].envelopes[0].officialEvidence.usageStatus = "approved";
  assert.equal(checkStage09pM1SourcePackContract(usage, asOf).ok, false);

  const userData = clone(realPack);
  userData.catalog.releases[0].envelopes[0].officialEvidence.containsRealUserData = true;
  assert.equal(checkStage09pM1SourcePackContract(userData, asOf).ok, false);
});
