import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalReleaseDigest } from "../src/canonical.js";
import { sourceKeyText } from "../src/catalog.js";
import {
  m1ReadinessRoles,
  type GovernanceCatalog,
  type GovernanceRelease,
  type M1ReadinessEvidence,
} from "../src/types.js";
import { assessM1Readiness } from "../src/validation.js";

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object ? { -readonly [P in keyof T]: Mutable<T[P]> } : T;

const m0Root = new URL("../../../data/samples/stage09p-m0/", import.meta.url);
const m1Root = new URL("../../../data/samples/stage09p-m1/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("valid/food-concept.json", m0Root), "utf8")) as GovernanceRelease;
const sign = (release: Mutable<GovernanceRelease>): GovernanceRelease => {
  release.contentDigest = `sha256:${"0".repeat(64)}`;
  release.contentDigest = canonicalReleaseDigest(release);
  return release as GovernanceRelease;
};
const approvedCatalog = (): GovernanceCatalog => {
  const release = structuredClone(fixture) as Mutable<GovernanceRelease>;
  release.envelopes[0]!.lifecycleStatus = "approved";
  return { schemaVersion: 1, releases: [sign(release)], hardMappings: [] };
};

const eligibleEvidence = (catalog: GovernanceCatalog): M1ReadinessEvidence => {
  const release = catalog.releases[0]!;
  const envelope = release.envelopes[0]!;
  const reference = envelope.sourceReferences[0]!;
  const snapshot = envelope.sourceSnapshots[0]!;
  const authorities = m1ReadinessRoles.map((role, index) => ({
    authorityRecordId: `syn:authority:${index}`,
    assignmentRevision: 1,
    assignmentDigest: `syn:digest:assignment:${index}`,
    role,
    naturalPersonIdentity: `syn:person:${index}`,
    identityVerified: true,
    acceptedResponsibilities: true,
    acceptanceEvidenceDigest: `syn:digest:acceptance:${index}`,
    independent: true,
    disclosedConflicts: [],
    assignmentKind: "primary" as const,
    substitutesFor: "",
    equivalentQualification: true,
    status: "confirmed" as const,
  }));
  const sources = [{
    sourceInventoryId: "syn:inventory:1",
    datasetId: envelope.datasetId,
    releaseId: release.releaseId,
    releaseRevision: release.releaseRevision,
    releaseContentDigest: release.contentDigest,
    entityId: envelope.entityId,
    entityRevision: envelope.entityRevision,
    factOrRuleId: "syn:fact:1",
    referenceId: reference.referenceId,
    referenceRevision: reference.referenceRevision,
    snapshotId: snapshot.snapshotId,
    sourceSnapshotContentDigest: snapshot.contentDigest,
    sourceOrganization: "syn:organization:1",
    sourceLocator: reference.locator,
    sourceVersion: "syn:version:1",
    publicationDate: "2000-01-01T00:00:00.000Z",
    retrievedAt: snapshot.retrievedAt,
    minimalSnapshotDigest: "syn:digest:snapshot:1",
    applicableRegions: [envelope.applicableRegions[0]!],
    sourceLanguage: envelope.languages[0]!,
    candidateSourceTier: envelope.sourceTier,
    licenseStatus: "approved" as const,
    copyPermitted: true,
    transformationPermitted: true,
    redistributionPermitted: true,
    provenanceReviewStatus: "approved" as const,
    licenseReviewStatus: "approved" as const,
    domainReviewStatus: "approved" as const,
    monitoringState: "current" as const,
    monitoringNextDueAt: "2099-01-01T00:00:00.000Z",
  }];
  const target = {
    releaseId: release.releaseId,
    releaseRevision: release.releaseRevision,
    releaseContentDigest: release.contentDigest,
    region: envelope.applicableRegions[0]!,
    language: envelope.languages[0]!,
    asOf: "2001-01-01T00:00:00.000Z",
  };
  const reviewDecisions = authorities.map((authority, index) => ({
    reviewDecisionId: `syn:decision:${index}`,
    authorityRecordId: authority.authorityRecordId,
    authorityAssignmentRevision: authority.assignmentRevision,
    authorityAssignmentDigest: authority.assignmentDigest,
    assignmentAcceptanceDigest: authority.acceptanceEvidenceDigest,
    role: authority.role,
    releaseId: release.releaseId,
    releaseRevision: release.releaseRevision,
    releaseContentDigest: release.contentDigest,
    entityRevisions: [`${envelope.entityId}@${envelope.entityRevision}`],
    factOrRuleIds: [sources[0]!.factOrRuleId],
    sourceInventoryIds: [sources[0]!.sourceInventoryId],
    sourceKeys: [sourceKeyText(reference)],
    applicableRegions: [target.region],
    languages: [target.language],
    decision: "approve" as const,
    decidedAt: "2000-01-03T00:00:00.000Z",
    evidenceDigest: `syn:digest:decision:${index}`,
    independenceEvidenceDigest: `syn:digest:independence:${index}`,
    conflictDisclosureDigest: `syn:digest:conflict:${index}`,
    revokedAt: "",
  }));
  return {
    schemaVersion: 1,
    classification: "fully_synthetic",
    target,
    authorities,
    sources,
    reviewDecisions,
    readinessGatePassed: true,
    auditAResult: "CLEAN",
    auditBResult: "CLEAN",
    totalControlAccepted: true,
  };
};
const candidate = () => {
  const catalog = approvedCatalog();
  return { catalog, evidence: structuredClone(eligibleEvidence(catalog)) as Mutable<M1ReadinessEvidence> };
};
const primary = (mutate: (value: ReturnType<typeof candidate>) => void) => {
  const value = candidate();
  mutate(value);
  return assessM1Readiness(value.catalog, value.evidence).primaryReason;
};
const setUnknown = (value: object, key: string, replacement: unknown): void => {
  (value as Record<string, unknown>)[key] = replacement;
};

test("L02 fully synthetic exact approved predecessor is derived eligible and deep-frozen", () => {
  const { catalog, evidence } = candidate();
  const before = structuredClone(catalog);
  const result = assessM1Readiness(catalog, evidence);
  assert.deepStrictEqual(result, { status: "ACTIVATION_ELIGIBLE", primaryReason: null, reasons: [] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.reasons), true);
  assert.deepStrictEqual(catalog, before);
  assert.equal(catalog.releases[0]!.envelopes[0]!.lifecycleStatus, "approved");
});

test("L01/L03/L04 lifecycle remains M0-owned and no derived status becomes a transition", () => {
  for (const status of ["draft", "under_review", "active"] as const) {
    assert.equal(primary(({ catalog, evidence }) => {
      const release = catalog.releases[0] as Mutable<GovernanceRelease>;
      release.envelopes[0]!.lifecycleStatus = status;
      sign(release);
      evidence.target.releaseContentDigest = release.contentDigest;
      evidence.sources[0]!.releaseContentDigest = release.contentDigest;
      for (const decision of evidence.reviewDecisions) decision.releaseContentDigest = release.contentDigest;
    }), "DOMAIN_REVIEW_MISSING_OR_EXPIRED");
  }
  assert.equal(primary(({ catalog, evidence }) => {
    const release = catalog.releases[0] as Mutable<GovernanceRelease>;
    release.envelopes[0]!.lifecycleStatus = "withdrawn";
    release.envelopes[0]!.withdrawalState = "withdrawn";
    release.envelopes[0]!.withdrawalReason = "syn:withdrawal:1";
    release.envelopes[0]!.withdrawnAt = "2000-01-04T00:00:00.000Z";
    sign(release);
    evidence.target.releaseContentDigest = release.contentDigest;
    evidence.sources[0]!.releaseContentDigest = release.contentDigest;
    for (const decision of evidence.reviewDecisions) decision.releaseContentDigest = release.contentDigest;
  }), "SOURCE_WITHDRAWN");
});

test("P01-P11 provenance/license/binding mutations fail closed", () => {
  const cases: readonly [string, (value: ReturnType<typeof candidate>) => void, string][] = [
    ["P01", ({ evidence }) => { evidence.sources[0]!.sourceOrganization = ""; }, "SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT"],
    ["P02", ({ evidence }) => { evidence.sources[0]!.minimalSnapshotDigest = ""; }, "SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT"],
    ["P03", ({ evidence }) => { evidence.sources[0]!.sourceVersion = ""; }, "SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT"],
    ["P04", ({ evidence }) => { evidence.sources[0]!.monitoringState = "withdrawn"; }, "SOURCE_WITHDRAWN"],
    ["P05", ({ evidence }) => { evidence.sources[0]!.licenseStatus = "pending"; }, "LICENSE_NOT_APPROVED"],
    ["P06", ({ evidence }) => { evidence.sources[0]!.redistributionPermitted = false; }, "LICENSE_NOT_APPROVED"],
    ["P07", ({ evidence }) => { evidence.sources[0]!.applicableRegions = []; }, "REGION_NOT_APPLICABLE"],
    ["P08", ({ evidence }) => { evidence.sources[0]!.sourceLanguage = "x-synthetic-drift"; }, "LANGUAGE_NOT_APPLICABLE"],
    ["P09", ({ evidence }) => { evidence.target.asOf = "2100-01-01T00:00:00.000Z"; evidence.sources[0]!.monitoringNextDueAt = "2101-01-01T00:00:00.000Z"; }, "DOMAIN_REVIEW_MISSING_OR_EXPIRED"],
    ["P10", ({ evidence }) => { evidence.sources[0]!.referenceRevision = "syn:revision:drift"; }, "SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT"],
    ["P11", ({ evidence }) => { evidence.sources[0]!.releaseContentDigest = "syn:digest:drift"; }, "SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT"],
  ];
  for (const [id, mutate, reason] of cases) assert.equal(primary(mutate), reason, id);
});

test("A01-A08 identity, independence, substitute and signature drift fail closed", () => {
  const cases: readonly [string, (value: ReturnType<typeof candidate>) => void, string][] = [
    ["A01", ({ evidence }) => { evidence.authorities[1]!.naturalPersonIdentity = evidence.authorities[0]!.naturalPersonIdentity; }, "CONFLICTED_OR_DUPLICATE_APPROVER"],
    ["A02", ({ evidence }) => { evidence.authorities[8]!.naturalPersonIdentity = evidence.authorities[7]!.naturalPersonIdentity; }, "CONFLICTED_OR_DUPLICATE_APPROVER"],
    ["A03", ({ evidence }) => { evidence.authorities[1]!.acceptanceEvidenceDigest = evidence.authorities[0]!.acceptanceEvidenceDigest; }, "CONFLICTED_OR_DUPLICATE_APPROVER"],
    ["A04", ({ evidence }) => { evidence.authorities[0]!.identityVerified = false; }, "FORGED_OR_REVOKED_AUTHORITY"],
    ["A05", ({ evidence }) => { evidence.authorities[0]!.assignmentKind = "substitute"; evidence.authorities[0]!.equivalentQualification = false; }, "UNASSIGNED_OR_UNACCEPTED_AUTHORITY"],
    ["A06", ({ evidence }) => { evidence.authorities.pop(); }, "UNASSIGNED_OR_UNACCEPTED_AUTHORITY"],
    ["A07", ({ evidence }) => { evidence.authorities[6]!.naturalPersonIdentity = evidence.authorities[0]!.naturalPersonIdentity; }, "CONFLICTED_OR_DUPLICATE_APPROVER"],
    ["A08", ({ evidence }) => { evidence.reviewDecisions[0]!.releaseRevision += 1; }, "DOMAIN_REVIEW_MISSING_OR_EXPIRED"],
  ];
  for (const [id, mutate, reason] of cases) assert.equal(primary(mutate), reason, id);
});

test("T01 preserves complete precedence; T02/T03 remain independent terminal gates", () => {
  const value = candidate();
  value.evidence.authorities[0]!.identityVerified = false;
  value.evidence.sources[0]!.monitoringState = "withdrawn";
  value.evidence.sources[0]!.licenseStatus = "pending";
  value.evidence.sources[0]!.applicableRegions = [];
  const compound = assessM1Readiness(value.catalog, value.evidence);
  assert.deepStrictEqual(compound.reasons.slice(0, 4), [
    "FORGED_OR_REVOKED_AUTHORITY", "SOURCE_WITHDRAWN", "LICENSE_NOT_APPROVED", "REGION_NOT_APPLICABLE",
  ]);
  assert.equal(compound.primaryReason, "FORGED_OR_REVOKED_AUTHORITY");
  assert.equal(JSON.stringify(compound).includes("syn:"), false);
  assert.equal(primary(({ evidence }) => { evidence.auditBResult = "PENDING"; }), "INDEPENDENT_A_B_NOT_CLEAN");
  assert.equal(primary(({ evidence }) => { evidence.totalControlAccepted = false; }), "TOTAL_CONTROL_NOT_ACCEPTED");
});

test("input array/key order is irrelevant and empty preparation template is blocked", () => {
  const { catalog, evidence } = candidate();
  const expected = assessM1Readiness(catalog, evidence);
  evidence.authorities.reverse();
  evidence.reviewDecisions.reverse();
  evidence.sources.reverse();
  assert.deepStrictEqual(assessM1Readiness(catalog, evidence), expected);
  const empty = JSON.parse(readFileSync(new URL("readiness-empty-template.json", m1Root), "utf8"));
  const blocked = assessM1Readiness(catalog, empty);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.primaryReason, "UNASSIGNED_OR_UNACCEPTED_AUTHORITY");
});

test("malformed unknown evidence is stable, frozen, blocked and zero-raw", () => {
  const { catalog, evidence } = candidate();
  setUnknown(evidence, "readinessGatePassed", "true");
  const malformed: unknown[] = [null, undefined, [], new Date(0), new Proxy({}, { getPrototypeOf: () => { throw new Error("syn:hostile"); } }), evidence];
  for (const input of malformed) {
    let result: ReturnType<typeof assessM1Readiness> | undefined;
    assert.doesNotThrow(() => { result = assessM1Readiness(catalog, input); });
    assert.deepStrictEqual(result, {
      status: "BLOCKED", primaryReason: "SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT",
      reasons: ["SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT"],
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result!.reasons), true);
    assert.equal(JSON.stringify(result).includes("syn:"), false);
  }
});

test("schema v1 and fully-synthetic classification are mandatory", () => {
  assert.equal(primary(({ evidence }) => { setUnknown(evidence, "schemaVersion", 2); }), "READINESS_GATE_FAILED");
  assert.equal(primary(({ evidence }) => {
    setUnknown(evidence, "classification", "fully_synthetic_empty_template");
  }), "READINESS_GATE_FAILED");
});

test("every readiness enum family is closed under one-field unknown mutations", () => {
  const cases: readonly [string, (evidence: Mutable<M1ReadinessEvidence>) => void][] = [
    ["role", (e) => { setUnknown(e.authorities[0]!, "role", "unknown"); }],
    ["authority status", (e) => { setUnknown(e.authorities[0]!, "status", "unknown"); }],
    ["assignment kind", (e) => { setUnknown(e.authorities[0]!, "assignmentKind", "unknown"); }],
    ["source tier", (e) => { setUnknown(e.sources[0]!, "candidateSourceTier", "unknown"); }],
    ["license", (e) => { setUnknown(e.sources[0]!, "licenseStatus", "unknown-enum"); }],
    ["provenance review", (e) => { setUnknown(e.sources[0]!, "provenanceReviewStatus", "unknown"); }],
    ["license review", (e) => { setUnknown(e.sources[0]!, "licenseReviewStatus", "unknown"); }],
    ["domain review", (e) => { setUnknown(e.sources[0]!, "domainReviewStatus", "unknown"); }],
    ["monitoring", (e) => { setUnknown(e.sources[0]!, "monitoringState", "unknown-enum"); }],
    ["decision role", (e) => { setUnknown(e.reviewDecisions[0]!, "role", "unknown"); }],
    ["decision", (e) => { setUnknown(e.reviewDecisions[0]!, "decision", "unknown"); }],
    ["audit A", (e) => { setUnknown(e, "auditAResult", "unknown"); }],
    ["audit B", (e) => { setUnknown(e, "auditBResult", "unknown"); }],
  ];
  for (const [label, mutate] of cases) {
    const { catalog, evidence } = candidate(); mutate(evidence);
    assert.equal(assessM1Readiness(catalog, evidence).status, "BLOCKED", label);
  }
});

test("every exact decision scope array rejects a duplicate", () => {
  for (const field of ["entityRevisions", "factOrRuleIds", "sourceInventoryIds", "sourceKeys", "applicableRegions", "languages"] as const) {
    const { catalog, evidence } = candidate();
    const entries = evidence.reviewDecisions[0]![field]; entries.push(entries[0]!);
    assert.equal(assessM1Readiness(catalog, evidence).status, "BLOCKED", field);
  }
});

test("decision time covers source publication/retrieval and never exceeds asOf", () => {
  assert.equal(primary(({ evidence }) => {
    evidence.sources[0]!.publicationDate = "1999-12-30T00:00:00.000Z";
    evidence.reviewDecisions[0]!.decidedAt = "1999-12-31T00:00:00.000Z";
  }), "DOMAIN_REVIEW_MISSING_OR_EXPIRED");
  assert.equal(primary(({ evidence }) => {
    evidence.reviewDecisions[0]!.decidedAt = "2002-01-01T00:00:00.000Z";
  }), "DOMAIN_REVIEW_MISSING_OR_EXPIRED");
  const { catalog, evidence } = candidate();
  evidence.sources[0]!.publicationDate = "2000-01-04T00:00:00.000Z";
  assert.equal(assessM1Readiness(catalog, evidence).reasons.includes("DOMAIN_REVIEW_MISSING_OR_EXPIRED"), true);
});

test("H01-H05 and K01-K06 content matrices are intentionally deferred to S2", () => {
  assert.equal(typeof assessM1Readiness, "function");
});
