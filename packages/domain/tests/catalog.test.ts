import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalReleaseDigest } from "../src/canonical.js";
import {
  canonicalEntityHistoryMaterial,
  forwardSourceMaterial,
  reverseSnapshotMaterial,
  sourceKey,
} from "../src/catalog.js";
import type { GovernanceCatalog, GovernanceEnvelope, GovernanceRelease } from "../src/types.js";
import { validateGovernanceCatalog } from "../src/validation.js";

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [P in keyof T]: Mutable<T[P]> }
    : T;

const fixtureRoot = new URL("../../../data/samples/stage09p-m0/", import.meta.url);
const baseRelease = JSON.parse(
  readFileSync(new URL("valid/food-concept.json", fixtureRoot), "utf8"),
) as GovernanceRelease;
const cloneRelease = (): Mutable<GovernanceRelease> => structuredClone(baseRelease) as Mutable<GovernanceRelease>;
const sign = (release: Mutable<GovernanceRelease>): GovernanceRelease => {
  release.contentDigest = `sha256:${"0".repeat(64)}`;
  release.contentDigest = canonicalReleaseDigest(release);
  return release as GovernanceRelease;
};
const catalog = (
  releases: readonly GovernanceRelease[],
  hardMappings: GovernanceCatalog["hardMappings"] = [],
): GovernanceCatalog => ({ schemaVersion: 1, releases, hardMappings });
const secondEntityRelease = (): Mutable<GovernanceRelease> => {
  const release = cloneRelease();
  release.releaseId = "syn:release:food-concept:2";
  release.releaseRevision = 2;
  release.envelopes[0]!.entityId = "01900000-7000-7000-8000-000000000099";
  release.envelopes[0]!.content = { syntheticToken: "SYNTHETIC_FOOD_CONCEPT_BETA" };
  release.envelopes.push(
    structuredClone(baseRelease.envelopes[0]!) as Mutable<GovernanceRelease>["envelopes"][number],
  );
  return release;
};

test("catalog projections freeze the ADR exact own-key order", () => {
  const envelope = baseRelease.envelopes[0]!;
  const reference = envelope.sourceReferences[0]!;
  const snapshot = envelope.sourceSnapshots[0]!;
  const projections = [
    [sourceKey(reference), ["referenceId", "referenceRevision"]],
    [forwardSourceMaterial(reference, snapshot), ["locator", "snapshotId", "contentDigest", "retrievedAt"]],
    [reverseSnapshotMaterial(snapshot), ["referenceId", "referenceRevision", "locator", "contentDigest", "retrievedAt"]],
    [
      canonicalEntityHistoryMaterial(envelope),
      [
        "schemaVersion", "datasetId", "datasetKind", "entityId", "entityRevision",
        "lifecycleStatus", "owner", "approvers", "sourceTier", "sourceReferences",
        "sourceSnapshots", "applicableRegions", "languages", "licenseStatus",
        "licenseReference", "retrievedAt", "reviewedAt", "reviewDueAt", "aliases",
        "supersededBy", "withdrawalState", "withdrawalReason", "withdrawnAt", "content",
      ],
    ],
  ] as const;
  for (const [projection, keys] of projections) {
    assert.deepStrictEqual(Object.keys(projection), keys);
    assert.equal(Object.isFrozen(projection), true);
  }
});

test("P01-P03 provenance, license, region, and language failures are stable", () => {
  const missingSource = cloneRelease();
  missingSource.envelopes[0]!.sourceReferences = [];
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([missingSource as GovernanceRelease])), [
    { code: "MISSING_SOURCE", path: "/releases/0/envelopes/0/sourceReferences" },
  ]);

  const missingLicense = cloneRelease();
  missingLicense.envelopes[0]!.licenseStatus = "pending";
  missingLicense.envelopes[0]!.licenseReference = null;
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([sign(missingLicense)])), [
    { code: "MISSING_LICENSE", path: "/releases/0/envelopes/0/licenseStatus" },
  ]);

  const missingRegion = cloneRelease();
  missingRegion.envelopes[0]!.applicableRegions = [];
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([missingRegion as GovernanceRelease])), [
    { code: "MISSING_REGION", path: "/releases/0/envelopes/0/applicableRegions" },
  ]);

  const missingLanguage = cloneRelease();
  missingLanguage.envelopes[0]!.languages = [];
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([missingLanguage as GovernanceRelease])), [
    { code: "MISSING_LANGUAGE", path: "/releases/0/envelopes/0/languages" },
  ]);
});

test("S01 pairing mismatch reports the two mechanically-derived pointers", () => {
  const release = cloneRelease();
  release.envelopes[0]!.sourceSnapshots[0]!.referenceRevision = "syn-revision-2";
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([sign(release)])), [
    { code: "SOURCE_SNAPSHOT_MISMATCH", path: "/releases/0/envelopes/0/sourceReferences/0" },
    { code: "SOURCE_SNAPSHOT_MISMATCH", path: "/releases/0/envelopes/0/sourceSnapshots/0" },
  ]);
});

const sourceRelationCase = (
  mutate: (release: Mutable<GovernanceRelease>) => void,
): readonly GovernanceRelease[] => {
  const later = secondEntityRelease();
  mutate(later);
  return [baseRelease, sign(later)];
};

test("S02 locator, digest, retrievedAt and snapshotId drift have complete arrays", () => {
  const locator = sourceRelationCase((release) => {
    release.envelopes[0]!.sourceReferences[0]!.locator += "/drift";
    release.envelopes[0]!.sourceSnapshots[0]!.locator += "/drift";
  });
  assert.deepStrictEqual(validateGovernanceCatalog(catalog(locator)), [
    { code: "SOURCE_REFERENCE_EQUIVOCATION", path: "/releases/1/envelopes/0/sourceReferences/0" },
    { code: "SOURCE_SNAPSHOT_ID_EQUIVOCATION", path: "/releases/1/envelopes/0/sourceSnapshots/0" },
  ]);

  const digest = sourceRelationCase((release) => {
    release.envelopes[0]!.sourceSnapshots[0]!.contentDigest = `sha256:${"8".repeat(64)}`;
  });
  assert.deepStrictEqual(validateGovernanceCatalog(catalog(digest)), [
    { code: "SOURCE_REFERENCE_EQUIVOCATION", path: "/releases/1/envelopes/0/sourceReferences/0" },
    { code: "SOURCE_SNAPSHOT_ID_EQUIVOCATION", path: "/releases/1/envelopes/0/sourceSnapshots/0" },
  ]);

  const retrievedAt = sourceRelationCase((release) => {
    release.envelopes[0]!.sourceSnapshots[0]!.retrievedAt = "2000-01-03T00:00:00.000Z";
  });
  assert.deepStrictEqual(validateGovernanceCatalog(catalog(retrievedAt)), [
    { code: "SOURCE_REFERENCE_EQUIVOCATION", path: "/releases/1/envelopes/0/sourceReferences/0" },
    { code: "SOURCE_SNAPSHOT_ID_EQUIVOCATION", path: "/releases/1/envelopes/0/sourceSnapshots/0" },
  ]);

  const snapshotId = sourceRelationCase((release) => {
    release.envelopes[0]!.sourceSnapshots[0]!.snapshotId = "syn:snapshot:food-concept:2";
  });
  assert.deepStrictEqual(validateGovernanceCatalog(catalog(snapshotId)), [
    { code: "SOURCE_REFERENCE_EQUIVOCATION", path: "/releases/1/envelopes/0/sourceReferences/0" },
  ]);
});

test("S03 reverse identity rejects one snapshotId shared by different SourceKeys", () => {
  const releases = sourceRelationCase((release) => {
    release.envelopes[0]!.sourceReferences[0]!.referenceId = "syn:source:food-concept:other";
    release.envelopes[0]!.sourceReferences[0]!.referenceRevision = "syn-revision-2";
    release.envelopes[0]!.sourceSnapshots[0]!.referenceId = "syn:source:food-concept:other";
    release.envelopes[0]!.sourceSnapshots[0]!.referenceRevision = "syn-revision-2";
    release.envelopes[0]!.aliases[0]!.sourceReferenceId = "syn:source:food-concept:other";
    release.envelopes[0]!.aliases[0]!.sourceReferenceRevision = "syn-revision-2";
  });
  assert.deepStrictEqual(validateGovernanceCatalog(catalog(releases)), [
    { code: "SOURCE_SNAPSHOT_ID_EQUIVOCATION", path: "/releases/1/envelopes/0/sourceSnapshots/0" },
  ]);
});

test("E01-E03 and V01 distinguish duplicate/equivocation from release metadata gaps", () => {
  const duplicate = cloneRelease();
  duplicate.envelopes.push(structuredClone(duplicate.envelopes[0]!));
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([sign(duplicate)])), [
    { code: "DUPLICATE_ENTITY", path: "/releases/0/envelopes/1/entityId" },
  ]);

  const changed = cloneRelease();
  changed.releaseId = "syn:release:food-concept:2";
  changed.releaseRevision = 2;
  changed.envelopes[0]!.content = { syntheticToken: "SYNTHETIC_CHANGED_LOCAL_MATERIAL" };
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([baseRelease, sign(changed)])), [
    { code: "ENTITY_REVISION_EQUIVOCATION", path: "/releases/1/envelopes/0/entityRevision" },
  ]);

  const metadataOnly = cloneRelease();
  metadataOnly.releaseId = "syn:release:food-concept:3";
  metadataOnly.releaseRevision = 3;
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([baseRelease, sign(metadataOnly)])), []);

  const silentDeletion = secondEntityRelease();
  silentDeletion.envelopes.pop();
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([baseRelease, sign(silentDeletion)])), [
    { code: "ENTITY_MISSING_FROM_SNAPSHOT", path: "/releases/1/envelopes" },
  ]);
});

const supersessionRelease = (): Mutable<GovernanceRelease> => {
  const release = cloneRelease();
  const source = release.envelopes[0]!;
  const target = structuredClone(source);
  target.entityId = "01900000-7000-7000-8000-000000000088";
  target.sourceReferences[0]!.referenceId = "syn:source:food-concept:target";
  target.sourceReferences[0]!.locator = "synthetic://stage09p-m0/food-concept-target";
  target.sourceSnapshots[0]!.snapshotId = "syn:snapshot:food-concept:target:1";
  target.sourceSnapshots[0]!.referenceId = "syn:source:food-concept:target";
  target.sourceSnapshots[0]!.locator = "synthetic://stage09p-m0/food-concept-target";
  target.aliases[0]!.sourceReferenceId = "syn:source:food-concept:target";
  target.content = { syntheticToken: "SYNTHETIC_TARGET" };
  source.lifecycleStatus = "superseded";
  source.supersededBy = {
    datasetId: target.datasetId,
    entityId: target.entityId,
    entityRevision: target.entityRevision,
  };
  release.envelopes.push(target);
  return release;
};

test("U01-U03 supersession target/revision/lifecycle/self/cycle/dataset fail closed", () => {
  const missing = supersessionRelease();
  missing.envelopes.pop();
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([sign(missing)])), [
    { code: "INVALID_SUPERSESSION_TARGET", path: "/releases/0/envelopes/0/supersededBy" },
  ]);

  const historical = supersessionRelease();
  historical.envelopes[0]!.supersededBy!.entityRevision = 2;
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([sign(historical)])), [
    { code: "INVALID_SUPERSESSION_TARGET_REVISION", path: "/releases/0/envelopes/0/supersededBy" },
  ]);

  const draft = supersessionRelease();
  draft.envelopes[1]!.lifecycleStatus = "draft";
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([sign(draft)])), [
    { code: "INVALID_SUPERSESSION_TARGET_LIFECYCLE", path: "/releases/0/envelopes/0/supersededBy" },
  ]);

  const self = supersessionRelease();
  self.envelopes.pop();
  self.envelopes[0]!.supersededBy = {
    datasetId: self.envelopes[0]!.datasetId,
    entityId: self.envelopes[0]!.entityId,
    entityRevision: self.envelopes[0]!.entityRevision,
  };
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([sign(self)])), [
    { code: "INVALID_SUPERSESSION_CYCLE", path: "/releases/0/envelopes/0/supersededBy" },
    { code: "INVALID_SUPERSESSION_SELF", path: "/releases/0/envelopes/0/supersededBy" },
    { code: "INVALID_SUPERSESSION_TARGET_LIFECYCLE", path: "/releases/0/envelopes/0/supersededBy" },
  ]);

  const crossDataset = supersessionRelease();
  crossDataset.envelopes[1]!.datasetId = "syn:dataset:food-concept:other";
  crossDataset.envelopes[0]!.supersededBy!.datasetId = "syn:dataset:food-concept:other";
  assert.deepStrictEqual(validateGovernanceCatalog(catalog([sign(crossDataset)])), [
    { code: "INVALID_SUPERSESSION_DATASET", path: "/releases/0/envelopes/0/supersededBy" },
  ]);
});

test("C01 compound pairing/forward/reverse failures remain complete, sorted and frozen", () => {
  const later = secondEntityRelease();
  const envelope = later.envelopes[0]!;
  envelope.sourceReferences.push({
    referenceId: "syn:source:unpaired",
    referenceRevision: "syn-revision-1",
    locator: "synthetic://stage09p-m0/unpaired-reference",
  });
  envelope.sourceSnapshots.push({
    snapshotId: "syn:snapshot:unpaired",
    referenceId: "syn:source:unpaired",
    referenceRevision: "syn-revision-2",
    locator: "synthetic://stage09p-m0/unpaired-snapshot",
    contentDigest: `sha256:${"9".repeat(64)}`,
    retrievedAt: "2000-01-01T00:00:00.000Z",
  });
  envelope.sourceReferences[0]!.locator += "/drift";
  envelope.sourceSnapshots[0]!.locator += "/drift";
  const issues = validateGovernanceCatalog(catalog([baseRelease, sign(later)]));
  assert.deepStrictEqual(issues, [
    { code: "SOURCE_REFERENCE_EQUIVOCATION", path: "/releases/1/envelopes/0/sourceReferences/0" },
    { code: "SOURCE_SNAPSHOT_ID_EQUIVOCATION", path: "/releases/1/envelopes/0/sourceSnapshots/0" },
    { code: "SOURCE_SNAPSHOT_MISMATCH", path: "/releases/1/envelopes/0/sourceReferences/1" },
    { code: "SOURCE_SNAPSHOT_MISMATCH", path: "/releases/1/envelopes/0/sourceSnapshots/1" },
  ]);
  assert.equal(Object.isFrozen(issues), true);
  for (const issue of issues) {
    assert.deepStrictEqual(Object.keys(issue), ["code", "path"]);
    assert.equal(Object.isFrozen(issue), true);
  }
});
