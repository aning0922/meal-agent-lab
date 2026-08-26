import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalReleaseDigest } from "../src/canonical.js";
import { lifecycleStatuses, type GovernanceCatalog, type GovernanceRelease, type LifecycleStatus } from "../src/types.js";
import {
  isLifecycleTransitionAllowed,
  lifecycleOracleCardinality,
  validateGovernanceCatalog,
} from "../src/validation.js";

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [P in keyof T]: Mutable<T[P]> }
    : T;

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../data/samples/stage09p-m0/valid/food-concept.json", import.meta.url),
    "utf8",
  ),
) as GovernanceRelease;
const cloneRelease = (): Mutable<GovernanceRelease> => structuredClone(fixture) as Mutable<GovernanceRelease>;
const sign = (release: Mutable<GovernanceRelease>): GovernanceRelease => {
  release.contentDigest = `sha256:${"0".repeat(64)}`;
  release.contentDigest = canonicalReleaseDigest(release);
  return release as GovernanceRelease;
};
const asCatalog = (releases: readonly GovernanceRelease[]): GovernanceCatalog => ({
  schemaVersion: 1,
  releases,
  hardMappings: [],
});
const setEvidence = (release: Mutable<GovernanceRelease>, revision: number): void => {
  const envelope = release.envelopes[0]!;
  envelope.sourceReferences[0]!.referenceRevision = `syn-revision-${revision}`;
  envelope.sourceSnapshots[0]!.referenceRevision = `syn-revision-${revision}`;
  envelope.sourceSnapshots[0]!.snapshotId = `syn:snapshot:food-concept:${revision}`;
  envelope.sourceSnapshots[0]!.contentDigest = `sha256:${String(revision).repeat(64)}`;
  envelope.aliases[0]!.sourceReferenceRevision = `syn-revision-${revision}`;
  envelope.retrievedAt = `2000-01-${String(revision).padStart(2, "0")}T00:00:00.000Z`;
  envelope.reviewedAt = `2000-02-${String(revision).padStart(2, "0")}T00:00:00.000Z`;
};
const historyRelease = (
  releaseRevision: number,
  entityRevision: number,
  lifecycleStatus: LifecycleStatus,
): GovernanceRelease => {
  const release = cloneRelease();
  release.releaseId = `syn:release:lifecycle:${releaseRevision}`;
  release.releaseRevision = releaseRevision;
  const envelope = release.envelopes[0]!;
  envelope.entityRevision = entityRevision;
  envelope.lifecycleStatus = lifecycleStatus;
  envelope.supersededBy = null;
  envelope.withdrawalState = lifecycleStatus === "withdrawn" ? "withdrawn" : "not_withdrawn";
  envelope.withdrawalReason = lifecycleStatus === "withdrawn" ? "SYNTHETIC_WITHDRAWAL" : null;
  envelope.withdrawnAt = lifecycleStatus === "withdrawn" ? "2000-03-01T00:00:00.000Z" : null;
  setEvidence(release, entityRevision);
  return sign(release);
};

const expectedLifecycleOracle: Readonly<
  Record<LifecycleStatus, Readonly<Record<LifecycleStatus, boolean>>>
> = {
  draft: {
    draft: true, under_review: true, approved: false, active: false,
    superseded: false, withdrawn: false,
  },
  under_review: {
    draft: false, under_review: true, approved: true, active: false,
    superseded: false, withdrawn: false,
  },
  approved: {
    draft: false, under_review: false, approved: true, active: true,
    superseded: true, withdrawn: true,
  },
  active: {
    draft: false, under_review: false, approved: false, active: true,
    superseded: true, withdrawn: true,
  },
  superseded: {
    draft: false, under_review: false, approved: false, active: false,
    superseded: false, withdrawn: false,
  },
  withdrawn: {
    draft: false, under_review: false, approved: false, active: true,
    superseded: false, withdrawn: true,
  },
};

for (const previous of lifecycleStatuses) {
  for (const next of lifecycleStatuses) {
    test(`L00 oracle cell ${previous} -> ${next}`, () => {
      assert.equal(
        isLifecycleTransitionAllowed(previous, next),
        expectedLifecycleOracle[previous][next],
      );
    });
  }
}

test("L00 oracle cardinality is exactly 13 A / 23 R", () => {
  assert.deepStrictEqual(lifecycleOracleCardinality(), { accepted: 13, rejected: 23 });
});

test("L01 whole-release draft -> under_review -> approved -> active history is legal", () => {
  const releases = [
    historyRelease(1, 1, "draft"),
    historyRelease(2, 2, "under_review"),
    historyRelease(3, 3, "approved"),
    historyRelease(4, 4, "active"),
  ];
  assert.deepStrictEqual(validateGovernanceCatalog(asCatalog(releases)), []);
});

test("L02 whole-release active -> superseded history has a same-dataset/kind active target", () => {
  const active = historyRelease(4, 3, "active");
  const superseded = cloneRelease();
  superseded.releaseId = "syn:release:lifecycle:5";
  superseded.releaseRevision = 5;
  const source = superseded.envelopes[0]!;
  source.entityRevision = 4;
  source.lifecycleStatus = "superseded";
  setEvidence(superseded, 4);
  const target = structuredClone(source);
  target.entityId = "01900000-7000-7000-8000-000000000077";
  target.entityRevision = 1;
  target.lifecycleStatus = "active";
  target.supersededBy = null;
  target.sourceReferences[0]!.referenceId = "syn:source:supersession-target";
  target.sourceReferences[0]!.locator = "synthetic://stage09p-m0/supersession-target";
  target.sourceSnapshots[0]!.referenceId = "syn:source:supersession-target";
  target.sourceSnapshots[0]!.snapshotId = "syn:snapshot:supersession-target:1";
  target.sourceSnapshots[0]!.locator = "synthetic://stage09p-m0/supersession-target";
  target.aliases[0]!.sourceReferenceId = "syn:source:supersession-target";
  target.content = { syntheticToken: "SYNTHETIC_SUPERSESSION_TARGET" };
  source.supersededBy = {
    datasetId: target.datasetId,
    entityId: target.entityId,
    entityRevision: target.entityRevision,
  };
  superseded.envelopes.push(target);
  assert.deepStrictEqual(validateGovernanceCatalog(asCatalog([active, sign(superseded)])), []);
});

test("L03 whole-release active -> withdrawn -> active recovery uses higher revisions/evidence", () => {
  const releases = [
    historyRelease(5, 5, "active"),
    historyRelease(6, 6, "withdrawn"),
    historyRelease(7, 7, "active"),
  ];
  assert.deepStrictEqual(validateGovernanceCatalog(asCatalog(releases)), []);
});

test("withdrawn -> active requires fresh source and strictly newer review evidence", () => {
  const previous = historyRelease(6, 6, "withdrawn");
  const previousEnvelope = previous.envelopes[0]!;
  const invalidCases = [
    {
      name: "neither source nor review is fresh",
      keepSource: true,
      keepReview: true,
    },
    {
      name: "only review is fresh",
      keepSource: true,
      keepReview: false,
    },
    {
      name: "only source is fresh",
      keepSource: false,
      keepReview: true,
    },
  ] as const;

  for (const item of invalidCases) {
    const next = structuredClone(historyRelease(7, 7, "active")) as Mutable<GovernanceRelease>;
    const nextEnvelope = next.envelopes[0]!;
    if (item.keepSource) {
      nextEnvelope.sourceReferences = previousEnvelope.sourceReferences.map((reference) => ({
        ...reference,
      }));
      nextEnvelope.sourceSnapshots = previousEnvelope.sourceSnapshots.map((snapshot) => ({
        ...snapshot,
      }));
      nextEnvelope.retrievedAt = previousEnvelope.retrievedAt;
      nextEnvelope.aliases = previousEnvelope.aliases.map((alias) => ({ ...alias }));
    }
    if (item.keepReview) nextEnvelope.reviewedAt = previousEnvelope.reviewedAt;
    assert.deepStrictEqual(
      validateGovernanceCatalog(asCatalog([previous, sign(next)])),
      [
        {
          code: "INVALID_LIFECYCLE_TRANSITION",
          path: "/releases/1/envelopes/0/lifecycleStatus",
        },
      ],
      item.name,
    );
  }
});
