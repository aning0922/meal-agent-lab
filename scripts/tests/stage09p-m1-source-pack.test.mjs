import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  checkStage09pM1SourcePackContract,
  classifySourceInventoryProjection,
} from "../check-stage09p-m1-source-pack.mjs";

const root = resolve(import.meta.dirname, "../..");
const realPack = JSON.parse(readFileSync(resolve(root,
  "data/reference/ingredients/stage09p-m1-household-safety-source-pack.json"), "utf8"));
const asOf = "2026-08-29T00:00:00.000Z";
const Z = "sha256:" + "0".repeat(64);
const clone = (value) => structuredClone(value);
const compareUtf8 = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort(compareUtf8)
    .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
};
const sha = (value) => "sha256:" + process.getBuiltinModule("node:crypto")
  .createHash("sha256").update(value).digest("hex");
const RD = (release) => {
  const material = {};
  if (Object.hasOwn(release, "$schema")) material.$schema = release.$schema;
  Object.assign(material, { schemaVersion: release.schemaVersion, releaseId: release.releaseId,
    releaseRevision: release.releaseRevision, envelopes: release.envelopes });
  return sha(Buffer.from(canonicalJson(material)));
};
const PD = (pack) => {
  const material = {
    schemaVersion: pack.schemaVersion, packId: pack.packId, packRevision: pack.packRevision,
    lifecycleStatus: pack.lifecycleStatus, country: pack.country,
    foodRuleRegion: pack.foodRuleRegion, ruleLanguage: pack.ruleLanguage,
    releaseBindings: [...pack.releaseBindings].sort((a, b) => compareUtf8(a.bindingId, b.bindingId)),
    sourceVersionWindows: [...pack.sourceVersionWindows].sort((a, b) => {
      for (const key of ["bindingId", "effectiveFrom", "effectiveUntil"]) {
        const order = compareUtf8(String(a[key]), String(b[key]));
        if (order !== 0) return order;
      }
      return compareUtf8(canonicalJson(a), canonicalJson(b));
    }),
    mappingReviews: [...pack.mappingReviews].sort((a, b) =>
      compareUtf8(a.mappingId, b.mappingId) || a.reviewRevision - b.reviewRevision ||
      compareUtf8(canonicalJson(a), canonicalJson(b))),
    catalog: pack.catalog,
  };
  return sha(Buffer.concat([Buffer.from("stage09p-m1-household-safety-official-pack-v2\0"),
    Buffer.from(canonicalJson(material))]));
};
const R0 = (pack) => pack.catalog.releases[0];
const E0 = (pack) => R0(pack).envelopes[0];
const Q0 = (pack) => E0(pack).sourceReferences[0];
const S0 = (pack) => E0(pack).sourceSnapshots[0];
const B0 = (pack) => pack.releaseBindings[0];
const W0 = (pack) => pack.sourceVersionWindows[0];
const reclose = (pack, mode) => {
  if (mode === "R") {
    R0(pack).contentDigest = RD(R0(pack));
    B0(pack).releaseDigest = R0(pack).contentDigest;
  }
  if (mode === "R" || mode === "P") pack.contentDigest = PD(pack);
};
const S = (path) => ({ code: "INVALID_SHAPE", path });
const W = (path) => ({ code: "INVALID_WINDOW", path });
const P = (path) => ({ code: "INVALID_PROVENANCE", path });
const row = (id, mutation, mode, issues) => ({ id, mutation, mode, issues });
const rows = [
  row("SHAPE-ROOT-NULL", () => null, "skip", [S("")]),
  row("SHAPE-RELEASE-NULL", (p) => { p.catalog.releases[0] = null; }, "skip", [S("/catalog/releases/0")]),
  row("SHAPE-ENVELOPE-NULL", (p) => { R0(p).envelopes[0] = null; }, "skip", [S("/catalog/releases/0/envelopes/0")]),
  row("SHAPE-REFERENCE-NULL", (p) => { E0(p).sourceReferences[0] = null; }, "skip", [S("/catalog/releases/0/envelopes/0/sourceReferences/0")]),
  row("REFERENCE-EMPTY", (p) => { E0(p).sourceReferences = []; }, "skip", [P("/catalog/releases/0/envelopes/0/sourceReferences")]),
  row("REFERENCE-EXTRA", (p) => { E0(p).sourceReferences.push(clone(Q0(p))); }, "R", [P("/catalog/releases/0/envelopes/0/sourceReferences")]),
  row("SHAPE-SNAPSHOTS-NULL", (p) => { E0(p).sourceSnapshots = null; }, "skip", [S("/catalog/releases/0/envelopes/0/sourceSnapshots")]),
  row("SHAPE-SNAPSHOT-NULL", (p) => { E0(p).sourceSnapshots[0] = null; }, "skip", [S("/catalog/releases/0/envelopes/0/sourceSnapshots/0")]),
  row("SNAPSHOT-EMPTY", (p) => { E0(p).sourceSnapshots = []; }, "skip", [P("/catalog/releases/0/envelopes/0/sourceSnapshots")]),
  row("SNAPSHOT-EXTRA", (p) => { E0(p).sourceSnapshots.push(clone(S0(p))); }, "R", [P("/catalog/releases/0/envelopes/0/sourceSnapshots")]),
  row("DIGEST-PACK-WRONG", (p) => { p.contentDigest = Z; }, "none", [P("/contentDigest")]),
  row("DIGEST-RELEASE-WRONG", (p) => { R0(p).contentDigest = Z; }, "none", [P("/catalog/releases/0/contentDigest"), P("/contentDigest")]),
  row("SNAPSHOT-ID-DRIFT", (p) => { S0(p).snapshotId = "snapshot:drift:2011"; }, "R", [P("/catalog/releases/0/envelopes/0/sourceSnapshots/0/snapshotId")]),
  row("SNAPSHOT-REFERENCE-ID-DRIFT", (p) => { S0(p).referenceId = "source:drift:pdf"; }, "R", [P("/catalog/releases/0/envelopes/0/sourceSnapshots/0/referenceId")]),
  row("SNAPSHOT-REFERENCE-REVISION-DRIFT", (p) => { S0(p).referenceRevision = "2011-drift"; }, "R", [P("/catalog/releases/0/envelopes/0/sourceSnapshots/0/referenceRevision")]),
  row("SNAPSHOT-LOCATOR-DRIFT", (p) => { S0(p).locator = "https://example.invalid/stage09p-m1/source"; }, "R", [P("/catalog/releases/0/envelopes/0/sourceSnapshots/0/locator")]),
  row("SNAPSHOT-DIGEST-DRIFT", (p) => { S0(p).contentDigest = Z; }, "R", [P("/catalog/releases/0/envelopes/0/sourceSnapshots/0/contentDigest")]),
  row("SNAPSHOT-RETRIEVED-AT-DRIFT", (p) => { S0(p).retrievedAt = "2026-08-30T00:00:00.000Z"; }, "R", [P("/catalog/releases/0/envelopes/0/sourceSnapshots/0/retrievedAt")]),
  row("CATALOG-RELEASE-ID-DRIFT", (p) => { R0(p).releaseId = "release:drift:2011"; }, "R", [P("/catalog/releases/0/releaseId")]),
  row("CATALOG-RELEASE-REVISION-DRIFT", (p) => { R0(p).releaseRevision = 2; }, "R", [P("/catalog/releases/0/releaseRevision")]),
  row("CATALOG-ENVELOPE-DATASET-ID-DRIFT", (p) => { E0(p).datasetId = "cn:drift:allergen"; }, "R", [P("/catalog/releases/0/envelopes/0/datasetId")]),
  row("CATALOG-ENVELOPE-DATASET-KIND-DRIFT", (p) => { E0(p).datasetKind = "food_concept"; }, "R", [P("/catalog/releases/0/envelopes/0/datasetKind")]),
  row("CATALOG-ENVELOPE-ENTITY-ID-DRIFT", (p) => { E0(p).entityId = "label-allergen-disclosure-2011-drift"; }, "R", [P("/catalog/releases/0/envelopes/0/entityId")]),
  row("CATALOG-ENVELOPE-ENTITY-REVISION-DRIFT", (p) => { E0(p).entityRevision = 2; }, "R", [P("/catalog/releases/0/envelopes/0/entityRevision")]),
  row("CATALOG-REFERENCE-ID-DRIFT", (p) => { Q0(p).referenceId = "source:drift:pdf"; }, "R", [P("/catalog/releases/0/envelopes/0/sourceReferences/0/referenceId")]),
  row("CATALOG-REFERENCE-REVISION-DRIFT", (p) => { Q0(p).referenceRevision = "2011-drift"; }, "R", [P("/catalog/releases/0/envelopes/0/sourceReferences/0/referenceRevision")]),
  row("CATALOG-REFERENCE-LOCATOR-DRIFT", (p) => { Q0(p).locator = "https://example.invalid/stage09p-m1/source"; }, "R", [P("/catalog/releases/0/envelopes/0/sourceReferences/0/locator")]),
  row("SHAPE-BINDING-NULL", (p) => { p.releaseBindings[0] = null; }, "skip", [S("/releaseBindings/0")]),
  row("BINDING-MISSING", (p) => { p.releaseBindings.splice(1, 1); }, "P", [P("/releaseBindings")]),
  row("BINDING-EXTRA", (p) => { p.releaseBindings.push({ ...clone(B0(p)), bindingId: "binding:extra:gb7718-2011:allergen" }); }, "P", [P("/releaseBindings")]),
  row("BINDING-DUPLICATE-ROW", (p) => { p.releaseBindings[1] = clone(B0(p)); }, "P", [P("/releaseBindings/1")]),
  row("BINDING-ID-DUPLICATE", (p) => { p.releaseBindings[1].bindingId = "binding:gb7718-2011:allergen"; }, "P", [P("/releaseBindings/1/bindingId")]),
  row("BINDING-SOURCE-VERSION-DUPLICATE", (p) => { p.releaseBindings[1].sourceVersion = "2011"; }, "P", [P("/releaseBindings/1/sourceVersion")]),
  row("BINDING-RELEASE-ID-DRIFT", (p) => { B0(p).releaseId = "release:drift:2011"; }, "P", [P("/releaseBindings/0/releaseId")]),
  row("BINDING-RELEASE-REVISION-DRIFT", (p) => { B0(p).releaseRevision = 2; }, "P", [P("/releaseBindings/0/releaseRevision")]),
  row("BINDING-RELEASE-DIGEST-DRIFT", (p) => { B0(p).releaseDigest = Z; }, "P", [P("/releaseBindings/0/releaseDigest")]),
  row("BINDING-DATASET-ID-DRIFT", (p) => { B0(p).datasetId = "cn:drift:allergen"; }, "P", [P("/releaseBindings/0/datasetId")]),
  row("BINDING-DATASET-KIND-DRIFT", (p) => { B0(p).datasetKind = "food_concept"; }, "P", [P("/releaseBindings/0/datasetKind")]),
  row("BINDING-SOURCE-REFERENCE-ID-DRIFT", (p) => { B0(p).sourceReferenceId = "source:drift:pdf"; }, "P", [P("/releaseBindings/0/sourceReferenceId")]),
  row("BINDING-SOURCE-REFERENCE-REVISION-DRIFT", (p) => { B0(p).sourceReferenceRevision = "2011-drift"; }, "P", [P("/releaseBindings/0/sourceReferenceRevision")]),
  row("SHAPE-WINDOW-NULL", (p) => { p.sourceVersionWindows[0] = null; }, "skip", [S("/sourceVersionWindows/0")]),
  row("WINDOW-MISSING", (p) => { p.sourceVersionWindows.splice(1, 1); }, "P", [W("/sourceVersionWindows")]),
  row("WINDOW-EXTRA", (p) => { p.sourceVersionWindows.push(clone(W0(p))); }, "P", [W("/sourceVersionWindows")]),
  row("WINDOW-DUPLICATE-ROW", (p) => { p.sourceVersionWindows[1] = clone(W0(p)); }, "P", [W("/sourceVersionWindows/1")]),
  row("WINDOW-ORPHAN", (p) => { W0(p).bindingId = "binding:orphan:2011"; }, "P", [W("/sourceVersionWindows/0/bindingId")]),
  row("WINDOW-W0-JURISDICTION-TIME-ZONE-DRIFT", (p) => { W0(p).jurisdictionTimeZone = "UTC"; }, "P", [W("/sourceVersionWindows/0")]),
  row("WINDOW-W0-SOURCE-CIVIL-EFFECTIVE-DATE-DRIFT", (p) => { W0(p).sourceCivilEffectiveDate = "2027-03-16"; }, "P", [W("/sourceVersionWindows/0")]),
  row("WINDOW-W0-EFFECTIVE-FROM-DRIFT", (p) => { W0(p).effectiveFrom = "2012-04-20T00:00:00.000Z"; }, "P", [W("/sourceVersionWindows/0")]),
  row("WINDOW-W0-EFFECTIVE-UNTIL-DRIFT", (p) => { W0(p).effectiveUntil = null; }, "P", [W("/sourceVersionWindows/0")]),
];

const assertFrozen = (value) => {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const item of Object.values(value)) assertFrozen(item);
};
const changedPointers = (before, after, path = "") => {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object") return [path];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareUtf8);
  return keys.flatMap((key) => changedPointers(before[key], after[key], path + "/" + key));
};

test("closed source inventory projections retain exact fail-closed objects", () => {
  const positive = ["explicit_ingredient", "explicit_contains", "explicit_may_contain", "explicit_shared_line", "explicit_shared_equipment"];
  const unknown = ["warning_absent", "negative_free_from_claim", "compound_unexpanded", "extraction_uncertain", "outside_prepackaged_scope"];
  for (const projectionKind of positive) {
    const actual = classifySourceInventoryProjection(projectionKind);
    assert.deepStrictEqual(actual, { schemaVersion: 1, projectionKind, factDisposition: "POSITIVE_BLOCK" });
    assertFrozen(actual);
  }
  for (const projectionKind of unknown) {
    const actual = classifySourceInventoryProjection(projectionKind);
    assert.deepStrictEqual(actual, { schemaVersion: 1, projectionKind, factDisposition: "UNKNOWN_BLOCK" });
    assertFrozen(actual);
  }
  for (const value of ["unexpected_kind", 1, null, undefined]) {
    const actual = classifySourceInventoryProjection(value);
    assert.deepStrictEqual(actual, { ok: false, issue: { code: "UNKNOWN_PROJECTION_KIND", path: "/projectionKind" } });
    assertFrozen(actual);
  }
});

test("independent canonical RD and PD bytes bind the real draft", () => {
  assert.deepStrictEqual(realPack.catalog.releases.map(RD), realPack.catalog.releases.map((release) => release.contentDigest));
  assert.equal(PD(realPack), realPack.contentDigest);
});

test("real draft and complete closed provenance mutant matrix are total and frozen", () => {
  assert.equal(rows.length, 49);
  assert.equal(new Set(rows.map(({ id }) => id)).size, 49);
  const baselineA = checkStage09pM1SourcePackContract(realPack, asOf);
  const baselineB = checkStage09pM1SourcePackContract(realPack, asOf);
  assert.deepStrictEqual(baselineA, { ok: true, issues: [] });
  assert.deepStrictEqual(baselineB, baselineA);
  assertFrozen(baselineA);
  for (const { id, mutation, mode, issues } of rows) {
    const pristine = clone(realPack);
    let mutant = clone(realPack);
    const replacement = mutation(mutant);
    if (replacement !== undefined) mutant = replacement;
    if (mutant !== null) reclose(mutant, mode);
    if (id.startsWith("WINDOW-W0-")) {
      const semanticPointer = id.includes("JURISDICTION") ? "/sourceVersionWindows/0/jurisdictionTimeZone"
        : id.includes("CIVIL") ? "/sourceVersionWindows/0/sourceCivilEffectiveDate"
          : id.includes("FROM") ? "/sourceVersionWindows/0/effectiveFrom" : "/sourceVersionWindows/0/effectiveUntil";
      assert.deepStrictEqual(changedPointers(pristine, mutant), ["/contentDigest", semanticPointer].sort(compareUtf8), id);
    }
    const before = JSON.stringify(mutant);
    const actualA = checkStage09pM1SourcePackContract(mutant, asOf);
    const actualB = checkStage09pM1SourcePackContract(mutant, asOf);
    assert.deepStrictEqual(actualA, { ok: false, issues }, id);
    assert.deepStrictEqual(actualB, actualA, id + ":deterministic");
    assert.equal(JSON.stringify(actualA), JSON.stringify(actualB), id + ":bytes");
    assert.equal(JSON.stringify(mutant), before, id + ":input-unchanged");
    assertFrozen(actualA);
  }
});

test("activation, reviewed-clear, licence, usage and user-data safety checks remain closed", () => {
  const mutants = [clone(realPack), clone(realPack), clone(realPack), clone(realPack), clone(realPack), clone(realPack)];
  mutants[0].catalog.hardMappings.push({ mappingId: "mapping:forbidden", source: { datasetId: "x", entityId: "x", entityRevision: 1 }, target: { datasetId: "y", entityId: "y", entityRevision: 1 }, required: true });
  mutants[1].catalog.releases[0].envelopes[0].officialEvidence.factDisposition = "REVIEWED_CLEAR";
  mutants[2].catalog.releases[0].envelopes[0].licenseStatus = "approved";
  mutants[3].catalog.releases[0].envelopes[0].officialEvidence.usageStatus = "approved";
  mutants[4].catalog.releases[0].envelopes[0].officialEvidence.containsRealUserData = true;
  mutants[5].catalog.releases[0].envelopes[0].syntheticEvidence = { classification: "fully_synthetic" };
  reclose(mutants[5], "R");
  for (const mutant of mutants.slice(0, 5)) assert.equal(checkStage09pM1SourcePackContract(mutant, asOf).ok, false);
  assert.deepStrictEqual(checkStage09pM1SourcePackContract(mutants[5], asOf),
    { ok: false, issues: [{ code: "INVALID_SOURCE_CLASS", path: "/catalog/releases/0/envelopes/0/syntheticEvidence" }] });
});
