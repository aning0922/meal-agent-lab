import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  canonicalJson,
  canonicalReleaseDigest,
  resolveGovernedReference,
  validateGovernanceCatalog,
  validateGovernanceRelease,
  type GovernanceCatalog,
  type GovernanceRelease,
  type MappingStatus,
} from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const validDirectory = resolve(repositoryRoot, "data/samples/stage09p-m0/valid");
const invalidDirectory = resolve(repositoryRoot, "data/samples/stage09p-m0/invalid");

const validFiles = [
  "food-concept.json",
  "allergen.json",
  "religious-ethical.json",
  "food-safety.json",
  "cooking-technique.json",
] as const;

const invalidCases = [
  ["missing-source.json", "MISSING_SOURCE"],
  ["missing-license.json", "MISSING_LICENSE"],
  ["missing-region.json", "MISSING_REGION"],
  ["missing-language.json", "MISSING_LANGUAGE"],
  ["alias-conflict.json", "ALIAS_CONFLICT"],
  ["reused-id.json", "REUSED_ENTITY_ID"],
  ["unknown-revision.json", "UNKNOWN_REVISION"],
  ["withdrawn-reference.json", "WITHDRAWN_REFERENCE"],
  ["release-digest-mismatch.json", "RELEASE_DIGEST_MISMATCH"],
  ["hard-mapping-unresolved.json", "HARD_MAPPING_UNRESOLVED"],
] as const;

const parseJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

interface InvalidFixture {
  readonly syntheticFixture: "fully_synthetic_mutation";
  readonly baseValidFiles: readonly (typeof validFiles)[number][];
  readonly mutations: readonly (
    | {
        readonly operation: "set";
        readonly releaseIndex: number;
        readonly envelopeIndex: number;
        readonly field: string;
        readonly value: unknown;
      }
    | {
        readonly operation: "duplicate_envelope";
        readonly releaseIndex: number;
        readonly envelopeIndex: number;
        readonly entityId: string;
        readonly syntheticToken: string;
        readonly aliasValue: string;
      }
  )[];
  readonly hardMappings: GovernanceCatalog["hardMappings"];
  readonly recomputeReleaseDigests: boolean;
  readonly expectedIssueCodes: string[];
}

const materializeInvalidFixture = (fixture: InvalidFixture): GovernanceCatalog => {
  assert.equal(fixture.syntheticFixture, "fully_synthetic_mutation");
  const releases = fixture.baseValidFiles.map((file) =>
    structuredClone(parseJson<GovernanceRelease>(resolve(validDirectory, file))),
  ) as GovernanceRelease[];
  for (const mutation of fixture.mutations) {
    const release = releases[mutation.releaseIndex];
    const envelope = release?.envelopes[mutation.envelopeIndex];
    assert.ok(release !== undefined && envelope !== undefined);
    if (mutation.operation === "set") {
      (envelope as unknown as Record<string, unknown>)[mutation.field] = mutation.value;
    } else {
      const duplicate = structuredClone(envelope) as unknown as Record<string, unknown>;
      duplicate["entityId"] = mutation.entityId;
      duplicate["content"] = { syntheticToken: mutation.syntheticToken };
      duplicate["aliases"] = (duplicate["aliases"] as { value: string }[]).map((alias) => ({
        ...alias,
        value: mutation.aliasValue,
      }));
      (release.envelopes as GovernanceRelease["envelopes"][number][]).push(
        duplicate as unknown as GovernanceRelease["envelopes"][number],
      );
    }
  }
  if (fixture.recomputeReleaseDigests) {
    for (const release of releases) {
      const digest = canonicalReleaseDigest(release);
      for (const envelope of release.envelopes) {
        (envelope as unknown as Record<string, unknown>)["contentDigest"] = digest;
      }
    }
  }
  return { releases, hardMappings: fixture.hardMappings };
};

const validReleases = (): GovernanceRelease[] =>
  validFiles.map((file) => parseJson<GovernanceRelease>(resolve(validDirectory, file)));

test("all five fully synthetic governance releases validate", () => {
  const releases = validReleases();
  assert.equal(releases.length, 5);
  for (const release of releases) {
    const result = validateGovernanceRelease(release);
    assert.deepEqual(result.issues, [], JSON.stringify(result.issues));
    assert.equal(result.ok, true);
    assert.equal(release.envelopes[0]?.syntheticEvidence?.classification, "fully_synthetic");
    assert.equal(release.envelopes[0]?.syntheticEvidence?.containsRealUserData, false);
    assert.equal(release.envelopes[0]?.syntheticEvidence?.containsRealFoodFacts, false);
  }
});

test("canonical release bytes and digest ignore insertion and set ordering", () => {
  const release = validReleases()[0];
  assert.ok(release !== undefined);
  const envelope = release.envelopes[0];
  assert.ok(envelope !== undefined);
  const syntheticEvidence = envelope.syntheticEvidence;
  assert.ok(syntheticEvidence !== undefined);

  const reordered = {
    envelopes: [
      {
        content: envelope.content,
        withdrawalReason: envelope.withdrawalReason,
        withdrawnAt: envelope.withdrawnAt,
        withdrawalState: envelope.withdrawalState,
        supersededBy: envelope.supersededBy,
        aliases: [...envelope.aliases].reverse(),
        reviewDueAt: envelope.reviewDueAt,
        reviewedAt: envelope.reviewedAt,
        retrievedAt: envelope.retrievedAt,
        licenseReference: envelope.licenseReference,
        licenseStatus: envelope.licenseStatus,
        languages: [...envelope.languages].reverse(),
        applicableRegions: [...envelope.applicableRegions].reverse(),
        sourceSnapshots: [...envelope.sourceSnapshots].reverse(),
        sourceReferences: [...envelope.sourceReferences].reverse(),
        sourceTier: envelope.sourceTier,
        approvers: [...envelope.approvers].reverse(),
        owner: envelope.owner,
        lifecycleStatus: envelope.lifecycleStatus,
        entityRevision: envelope.entityRevision,
        entityId: envelope.entityId,
        contentDigest: envelope.contentDigest,
        releaseRevision: envelope.releaseRevision,
        releaseId: envelope.releaseId,
        datasetKind: envelope.datasetKind,
        datasetId: envelope.datasetId,
        syntheticEvidence,
        schemaVersion: envelope.schemaVersion,
      },
    ],
  } satisfies GovernanceRelease;

  assert.equal(canonicalReleaseDigest(reordered), canonicalReleaseDigest(release));
  assert.equal(
    canonicalReleaseDigest(release),
    envelope.contentDigest,
    "fixture digest must be byte-for-byte canonical",
  );
  assert.equal(canonicalJson({ z: 1, a: 2 }), canonicalJson({ a: 2, z: 1 }));
});

test("canonical release digest is stable across entity and multi-value set order", () => {
  const base = structuredClone(validReleases()[0]);
  assert.ok(base !== undefined);
  const first = base.envelopes[0];
  assert.ok(first !== undefined);
  const second = structuredClone(first);
  Object.assign(second, {
    entityId: "01900000-7000-7000-8000-000000000011",
    content: { syntheticToken: "SYNTHETIC_FOOD_CONCEPT_BETA" },
    aliases: first.aliases.map((alias) => ({ ...alias, value: "SYNTHETIC_FOOD_CONCEPT_BETA" })),
  });
  const extraApprover = { actorId: "syn:actor:food-concept-approver-2", role: "safety-approver" };
  Object.assign(first, {
    approvers: [...first.approvers, extraApprover],
    applicableRegions: [...first.applicableRegions, "SYNTHETIC-REGION-2"],
    languages: [...first.languages, "x-synthetic-alt"],
  });
  Object.assign(second, {
    approvers: [...second.approvers, extraApprover],
    applicableRegions: [...second.applicableRegions, "SYNTHETIC-REGION-2"],
    languages: [...second.languages, "x-synthetic-alt"],
  });
  const ordered: GovernanceRelease = { envelopes: [first, second] };
  const reversed = structuredClone(ordered);
  (reversed.envelopes as GovernanceRelease["envelopes"][number][]).reverse();
  for (const envelope of reversed.envelopes) {
    Object.assign(envelope, {
      approvers: [...envelope.approvers].reverse(),
      applicableRegions: [...envelope.applicableRegions].reverse(),
      languages: [...envelope.languages].reverse(),
      aliases: [...envelope.aliases].reverse(),
      sourceReferences: [...envelope.sourceReferences].reverse(),
      sourceSnapshots: [...envelope.sourceSnapshots].reverse(),
    });
  }
  assert.equal(canonicalReleaseDigest(reversed), canonicalReleaseDigest(ordered));
});

test("each invalid fixture has one exclusive failure reason", () => {
  for (const [file, expectedCode] of invalidCases) {
    const fixture = parseJson<InvalidFixture>(resolve(invalidDirectory, file));
    assert.deepEqual(fixture.expectedIssueCodes, [expectedCode]);
    const result = validateGovernanceCatalog(materializeInvalidFixture(fixture));
    assert.equal(result.ok, false, file);
    assert.deepEqual(
      [...new Set(result.issues.map(({ code }) => code))],
      [expectedCode],
      `${file} must be discriminating: removing its named check must make it fail the test`,
    );
  }
});

test("reference resolution returns only the stable closed result set", () => {
  const releases = validReleases();
  const withdrawnRelease = structuredClone(releases[1]);
  const unapprovedRelease = structuredClone(releases[2]);
  assert.ok(withdrawnRelease !== undefined && unapprovedRelease !== undefined);
  const withdrawn = withdrawnRelease.envelopes[0];
  const unapproved = unapprovedRelease.envelopes[0];
  assert.ok(withdrawn !== undefined && unapproved !== undefined);
  Object.assign(withdrawn, {
    lifecycleStatus: "withdrawn",
    withdrawalState: "withdrawn",
    withdrawalReason: "SYNTHETIC_WITHDRAWAL_REASON",
    withdrawnAt: "2000-01-03T00:00:00.000Z",
  });
  Object.assign(unapproved, { lifecycleStatus: "under_review" });
  const catalog: GovernanceCatalog = {
    releases: [releases[0] as GovernanceRelease, withdrawnRelease, unapprovedRelease],
    hardMappings: [],
  };
  const entity = releases[0]?.envelopes[0];
  assert.ok(entity !== undefined);

  const results = [
    resolveGovernedReference(catalog, {
      datasetId: entity.datasetId,
      entityId: entity.entityId,
      entityRevision: entity.entityRevision,
    }),
    resolveGovernedReference(catalog, {
      datasetId: "syn:dataset:missing",
      entityId: "01900000-7000-7000-8000-000000000099",
      entityRevision: 1,
    }),
    resolveGovernedReference(catalog, {
      datasetId: entity.datasetId,
      entityId: entity.entityId,
      entityRevision: entity.entityRevision + 1,
    }),
    resolveGovernedReference(catalog, {
      datasetId: withdrawn.datasetId,
      entityId: withdrawn.entityId,
      entityRevision: withdrawn.entityRevision,
    }),
    resolveGovernedReference(catalog, {
      datasetId: unapproved.datasetId,
      entityId: unapproved.entityId,
      entityRevision: unapproved.entityRevision,
    }),
  ];
  const allowed: ReadonlySet<MappingStatus> = new Set([
    "mapped",
    "unmapped",
    "withdrawn",
    "version_mismatch",
    "unapproved",
  ]);
  assert.deepEqual(results.map(({ status }) => status), [
    "mapped",
    "unmapped",
    "version_mismatch",
    "withdrawn",
    "unapproved",
  ]);
  assert.equal(results.every(({ status }) => allowed.has(status)), true);
});

test("canonicalization rejects environment-sensitive or non-JSON values", () => {
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /canonical JSON/);
  assert.throws(() => canonicalJson({ bad: -0 }), /canonical JSON/);
  assert.throws(() => canonicalJson({ bad: undefined }), /canonical JSON/);
  assert.throws(() => canonicalJson({ bad: new Date(0) }), /canonical JSON/);
});

test("malformed nested input fails closed without throwing", () => {
  const malformed = {
    releases: [{ envelopes: [{ ...validReleases()[0]?.envelopes[0], sourceReferences: [null] }] }],
    hardMappings: [{ mappingId: "syn:bad", source: null, target: null, required: true }],
  };
  assert.doesNotThrow(() => validateGovernanceCatalog(malformed));
  const result = validateGovernanceCatalog(malformed);
  assert.equal(result.ok, false);
  assert.equal(result.issues.some(({ code }) => code === "INVALID_SHAPE"), true);
});
