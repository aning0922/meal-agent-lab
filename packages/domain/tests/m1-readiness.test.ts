import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalReleaseDigest } from "../src/canonical.js";
import type {
  GovernanceCatalog,
  GovernanceEnvelope,
  GovernanceRelease,
  M1AuthorityEvidence,
  M1BoundReceipt,
  M1ReadinessEvidence,
  M1ReviewDecisionEvidence,
  M1SourceEvidence,
} from "../src/types.js";
import {
  analyzeGovernanceCatalog,
  assessM1Readiness,
  m1AuthorityAcceptanceDigest,
  m1AuthorityAssignmentDigest,
  m1ReceiptDigest,
  m1ReviewDecisionDigests,
  m1SourceInventoryDigest,
} from "../src/validation.js";
import { m1ReadinessRoles } from "../src/types.js";

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object ? { -readonly [P in keyof T]: Mutable<T[P]> } : T;

const m0Root = new URL("../../../data/samples/stage09p-m0/", import.meta.url);
const m1Root = new URL("../../../data/samples/stage09p-m1/", import.meta.url);
const fixture = JSON.parse(
  readFileSync(new URL("valid/food-concept.json", m0Root), "utf8"),
) as GovernanceRelease;
const emptyDigest = `sha256:${"0".repeat(64)}`;
const candidateCommitSha = "1".repeat(40);
const evaluationTime = "2001-01-01T00:00:00.000Z";

const digest = (index: number): string => `sha256:${index.toString(16).padStart(64, "0")}`;
const sign = (release: Mutable<GovernanceRelease>): GovernanceRelease => {
  release.contentDigest = emptyDigest;
  release.contentDigest = canonicalReleaseDigest(release);
  return release as GovernanceRelease;
};

const approvedCatalog = (): GovernanceCatalog => {
  const release = structuredClone(fixture) as Mutable<GovernanceRelease>;
  release.envelopes[0]!.lifecycleStatus = "approved";
  return { schemaVersion: 1, releases: [sign(release)], hardMappings: [] };
};

const targetFor = (release: GovernanceRelease, envelope: GovernanceEnvelope) => ({
  candidateCommitSha,
  datasetId: envelope.datasetId,
  releaseId: release.releaseId,
  releaseRevision: release.releaseRevision,
  releaseContentDigest: release.contentDigest,
  region: envelope.applicableRegions[0]!,
  language: envelope.languages[0]!,
  evaluationTime,
});

const refreshAuthority = (authority: Mutable<M1AuthorityEvidence>): void => {
  authority.assignmentDigest = emptyDigest;
  authority.acceptanceEvidenceDigest = emptyDigest;
  authority.assignmentDigest = m1AuthorityAssignmentDigest(authority as M1AuthorityEvidence);
  authority.acceptanceEvidenceDigest = m1AuthorityAcceptanceDigest(authority as M1AuthorityEvidence);
};

const sourceFor = (
  release: GovernanceRelease,
  envelope: GovernanceEnvelope,
  sourceIndex: number,
): Mutable<M1SourceEvidence> => {
  const reference = envelope.sourceReferences[sourceIndex]!;
  const snapshot = envelope.sourceSnapshots.find((candidate) =>
    candidate.referenceId === reference.referenceId &&
    candidate.referenceRevision === reference.referenceRevision)!;
  const source: Mutable<M1SourceEvidence> = {
    sourceInventoryId: `syn:inventory:${envelope.entityId}:${sourceIndex}`,
    materialDigest: emptyDigest,
    datasetKind: envelope.datasetKind,
    datasetId: envelope.datasetId,
    releaseId: release.releaseId,
    releaseRevision: release.releaseRevision,
    releaseContentDigest: release.contentDigest,
    entityId: envelope.entityId,
    entityRevision: envelope.entityRevision,
    factOrRuleId: `syn:fact:${envelope.entityId}:${sourceIndex}`,
    sourceKey: {
      referenceId: reference.referenceId,
      referenceRevision: reference.referenceRevision,
    },
    snapshotId: snapshot.snapshotId,
    sourceSnapshotContentDigest: snapshot.contentDigest,
    sourceOrganization: `syn:organization:${sourceIndex}`,
    sourceLocator: reference.locator,
    sourceVersion: `syn:version:${sourceIndex}`,
    publicationDate: "1999-12-31T00:00:00.000Z",
    retrievedAt: snapshot.retrievedAt,
    minimalSnapshot: {
      locator: reference.locator,
      mediaType: "application/x-synthetic",
      byteLength: 1,
      hashAlgorithm: "sha256",
      contentHash: snapshot.contentDigest,
      capturedAt: snapshot.retrievedAt,
    },
    applicableRegions: [...envelope.applicableRegions],
    sourceLanguage: envelope.languages[0]!,
    candidateSourceTier: envelope.sourceTier,
    licenseTermsLocator: `syn:license:${sourceIndex}`,
    rightsHolder: `syn:rights-holder:${sourceIndex}`,
    licenseStatus: "approved",
    copyConclusion: "permitted",
    transformationConclusion: "permitted",
    redistributionConclusion: "permitted",
    attributionRequirements: [`syn:attribution:${sourceIndex}`],
    provenanceReviewStatus: "approved",
    licenseReviewStatus: "approved",
    domainReviewStatus: "approved",
    reviewEvidenceReferences: [`syn:review-reference:${sourceIndex}`],
    withdrawalMonitoring: {
      accountableRole: "knowledge_data_steward",
      method: `syn:monitor-method:${sourceIndex}`,
      cadence: `syn:monitor-cadence:${sourceIndex}`,
      lastCheckedAt: "2000-01-02T00:00:00.000Z",
      nextDueAt: "2099-01-01T00:00:00.000Z",
      state: "current",
      evidenceReference: `syn:monitor-evidence:${sourceIndex}`,
    },
  };
  source.materialDigest = m1SourceInventoryDigest(source as M1SourceEvidence);
  return source;
};

const unique = <T>(values: readonly T[]): T[] => {
  const result = new Map(values.map((value) => [JSON.stringify(value), value]));
  return [...result.values()];
};

const scopeFor = (
  envelopes: readonly GovernanceEnvelope[],
  sources: readonly Mutable<M1SourceEvidence>[],
) => ({
  entityRevisions: unique(envelopes.map(({ entityId, entityRevision }) => ({
    entityId,
    entityRevision,
  }))),
  factOrRuleIds: unique(sources.map(({ factOrRuleId }) => factOrRuleId)),
  sourceInventoryBindings: unique(sources.map(({ sourceInventoryId, materialDigest }) => ({
    sourceInventoryId,
    materialDigest,
  }))),
  sourceKeys: unique(sources.map(({ sourceKey }) => structuredClone(sourceKey))),
  applicableRegions: unique(envelopes.flatMap(({ applicableRegions }) => applicableRegions)),
  languages: unique(envelopes.flatMap(({ languages }) => languages)),
});

const refreshDecision = (
  decision: Mutable<M1ReviewDecisionEvidence>,
  authority: Mutable<M1AuthorityEvidence>,
): void => {
  decision.evidenceDigest = emptyDigest;
  decision.independenceEvidenceDigest = emptyDigest;
  decision.conflictDisclosureDigest = emptyDigest;
  Object.assign(
    decision,
    m1ReviewDecisionDigests(
      decision as M1ReviewDecisionEvidence,
      authority as M1AuthorityEvidence,
    ),
  );
};

const receipt = (
  kind: M1BoundReceipt["kind"],
  result: M1BoundReceipt["result"],
  target: M1ReadinessEvidence["target"],
  index: number,
  observedAt: string,
  upstreamReceiptDigests: readonly string[],
): Mutable<M1BoundReceipt> => {
  const value: Mutable<M1BoundReceipt> = {
    receiptId: `syn:receipt:${kind}`,
    receiptDigest: emptyDigest,
    kind,
    candidateCommitSha: target.candidateCommitSha,
    datasetId: target.datasetId,
    releaseId: target.releaseId,
    releaseRevision: target.releaseRevision,
    releaseContentDigest: target.releaseContentDigest,
    evaluationTime: target.evaluationTime,
    observedAt,
    result,
    reportDigest: digest(100 + index),
    upstreamReceiptDigests: [...upstreamReceiptDigests],
  };
  value.receiptDigest = m1ReceiptDigest(value as M1BoundReceipt);
  return value;
};

const receiptsFor = (target: M1ReadinessEvidence["target"]): Mutable<M1BoundReceipt>[] => {
  const evaluation = receipt("evaluation_time", "BOUND", target, 0, target.evaluationTime, []);
  const gate = receipt(
    "readiness_gate",
    "PASS",
    target,
    1,
    "2000-01-04T00:00:00.000Z",
    [evaluation.receiptDigest],
  );
  const auditA = receipt(
    "audit_a",
    "CLEAN",
    target,
    2,
    "2000-01-05T00:00:00.000Z",
    [gate.receiptDigest],
  );
  const auditB = receipt(
    "audit_b",
    "CLEAN",
    target,
    3,
    "2000-01-06T00:00:00.000Z",
    [gate.receiptDigest],
  );
  const total = receipt(
    "total_control",
    "ACCEPTED",
    target,
    4,
    "2000-01-07T00:00:00.000Z",
    [evaluation.receiptDigest, gate.receiptDigest, auditA.receiptDigest, auditB.receiptDigest],
  );
  return [evaluation, gate, auditA, auditB, total];
};

const eligibleEvidence = (catalog: GovernanceCatalog): Mutable<M1ReadinessEvidence> => {
  const release = catalog.releases[0]!;
  const envelopes = release.envelopes.filter(
    ({ datasetId }) => datasetId === release.envelopes[0]!.datasetId,
  );
  const target = targetFor(release, envelopes[0]!);
  const authorities = m1ReadinessRoles.map((role, index) => {
    const authority: Mutable<M1AuthorityEvidence> = {
      authorityRecordId: `syn:authority:${index}`,
      assignmentRevision: 1,
      assignmentDigest: emptyDigest,
      role,
      dataKinds: [envelopes[0]!.datasetKind],
      naturalPersonIdentity: `syn:person:${index}`,
      affiliation: `syn:affiliation:${index}`,
      identityVerificationReference: `syn:identity-verification:${index}`,
      jurisdictions: [target.region],
      languages: [target.language],
      qualificationReference: `syn:qualification:${index}`,
      acceptedResponsibilities: [`syn:responsibility:${role}`],
      acceptedAt: "1999-12-30T00:00:00.000Z",
      acceptanceEvidenceDigest: emptyDigest,
      independent: true,
      independenceDeclaration: `syn:independence:${index}`,
      disclosedConflicts: [],
      assignmentKind: "primary",
      substitutesFor: "",
      equivalentQualification: true,
      status: "confirmed",
      revokedAt: "",
      revocationReason: "",
    };
    refreshAuthority(authority);
    return authority;
  });
  const sources = envelopes.flatMap((envelope) =>
    envelope.sourceReferences.map((_reference, index) => sourceFor(release, envelope, index)));
  const scope = scopeFor(envelopes, sources);
  const reviewDecisions = authorities.map((authority, index) => {
    const decision: Mutable<M1ReviewDecisionEvidence> = {
      reviewDecisionId: `syn:decision:${index}`,
      authorityRecordId: authority.authorityRecordId,
      authorityAssignmentRevision: authority.assignmentRevision,
      authorityAssignmentDigest: authority.assignmentDigest,
      assignmentAcceptanceDigest: authority.acceptanceEvidenceDigest,
      role: authority.role,
      datasetId: target.datasetId,
      releaseId: target.releaseId,
      releaseRevision: target.releaseRevision,
      releaseContentDigest: target.releaseContentDigest,
      scope: structuredClone(scope),
      decision: "approve",
      decidedAt: "2000-01-03T00:00:00.000Z",
      evidenceDigest: emptyDigest,
      independenceEvidenceDigest: emptyDigest,
      conflictDisclosureDigest: emptyDigest,
      supersedesReviewDecisionId: "",
      revokedAt: "",
      revocationReason: "",
    };
    refreshDecision(decision, authority);
    return decision;
  });
  return {
    schemaVersion: 1,
    classification: "fully_synthetic",
    target,
    authorities,
    sources,
    reviewDecisions,
    receipts: receiptsFor(target),
  };
};

interface Candidate {
  readonly catalog: Mutable<GovernanceCatalog>;
  readonly evidence: Mutable<M1ReadinessEvidence>;
}

const candidate = (catalog: GovernanceCatalog = approvedCatalog()): Candidate => ({
  catalog: structuredClone(catalog) as Mutable<GovernanceCatalog>,
  evidence: eligibleEvidence(catalog),
});

const refreshReceipts = (evidence: Mutable<M1ReadinessEvidence>): void => {
  const byKind = new Map(evidence.receipts.map((value) => [value.kind, value]));
  const evaluation = byKind.get("evaluation_time")!;
  const gate = byKind.get("readiness_gate")!;
  const auditA = byKind.get("audit_a")!;
  const auditB = byKind.get("audit_b")!;
  const total = byKind.get("total_control")!;
  for (const value of evidence.receipts) {
    value.candidateCommitSha = evidence.target.candidateCommitSha;
    value.datasetId = evidence.target.datasetId;
    value.releaseId = evidence.target.releaseId;
    value.releaseRevision = evidence.target.releaseRevision;
    value.releaseContentDigest = evidence.target.releaseContentDigest;
    value.evaluationTime = evidence.target.evaluationTime;
  }
  evaluation.observedAt = evidence.target.evaluationTime;
  evaluation.upstreamReceiptDigests = [];
  evaluation.receiptDigest = m1ReceiptDigest(evaluation as M1BoundReceipt);
  gate.upstreamReceiptDigests = [evaluation.receiptDigest];
  gate.receiptDigest = m1ReceiptDigest(gate as M1BoundReceipt);
  auditA.upstreamReceiptDigests = [gate.receiptDigest];
  auditA.receiptDigest = m1ReceiptDigest(auditA as M1BoundReceipt);
  auditB.upstreamReceiptDigests = [gate.receiptDigest];
  auditB.receiptDigest = m1ReceiptDigest(auditB as M1BoundReceipt);
  total.upstreamReceiptDigests = [
    evaluation.receiptDigest,
    gate.receiptDigest,
    auditA.receiptDigest,
    auditB.receiptDigest,
  ];
  total.receiptDigest = m1ReceiptDigest(total as M1BoundReceipt);
};

const refreshEvidenceBindings = (value: Candidate): void => {
  const release = value.catalog.releases.find(({ releaseId }) =>
    releaseId === value.evidence.target.releaseId)!;
  value.evidence.target.releaseRevision = release.releaseRevision;
  value.evidence.target.releaseContentDigest = release.contentDigest;
  for (const authority of value.evidence.authorities) refreshAuthority(authority);
  for (const source of value.evidence.sources) {
    source.releaseRevision = release.releaseRevision;
    source.releaseContentDigest = release.contentDigest;
    source.materialDigest = m1SourceInventoryDigest(source as M1SourceEvidence);
  }
  const envelopes = release.envelopes.filter(
    ({ datasetId }) => datasetId === value.evidence.target.datasetId,
  );
  const scope = scopeFor(envelopes, value.evidence.sources);
  for (const decision of value.evidence.reviewDecisions) {
    const authority = value.evidence.authorities.find(({ role }) => role === decision.role)!;
    decision.authorityRecordId = authority.authorityRecordId;
    decision.authorityAssignmentRevision = authority.assignmentRevision;
    decision.authorityAssignmentDigest = authority.assignmentDigest;
    decision.assignmentAcceptanceDigest = authority.acceptanceEvidenceDigest;
    decision.datasetId = value.evidence.target.datasetId;
    decision.releaseRevision = release.releaseRevision;
    decision.releaseContentDigest = release.contentDigest;
    decision.scope = structuredClone(scope);
    refreshDecision(decision, authority);
  }
  refreshReceipts(value.evidence);
};

const assess = (value: Candidate) =>
  assessM1Readiness(value.catalog, JSON.stringify(value.evidence));
const reasons = (value: Candidate) => assess(value).reasons;
const reverseObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(
    ([key, child]) => [key, reverseObjectKeys(child)],
  ));
};

const twoEntityCatalog = (): GovernanceCatalog => {
  const catalog = approvedCatalog();
  const release = catalog.releases[0] as Mutable<GovernanceRelease>;
  const second = structuredClone(release.envelopes[0]!) as Mutable<GovernanceEnvelope>;
  second.entityId = "01900000-7000-7000-8000-000000000002";
  release.envelopes.push(second);
  sign(release);
  return catalog;
};

test("baseline positive is derived eligible, deep-frozen, and leaves M0 unchanged", () => {
  const value = candidate();
  const before = structuredClone(value.catalog);
  const result = assess(value);
  assert.deepStrictEqual({ result, frozen: Object.isFrozen(result) && Object.isFrozen(result.reasons), catalog: value.catalog }, {
    result: { status: "ACTIVATION_ELIGIBLE", primaryReason: null, reasons: [] },
    frozen: true,
    catalog: before,
  });
});

test("controller 1: enumerable classification getter and Proxy boundary remain zero-touch", () => {
  const value = candidate();
  let getterCalls = 0;
  let proxyCalls = 0;
  const hostile = new Proxy(Object.defineProperty({}, "classification", {
    enumerable: true,
    get: () => { getterCalls += 1; return "fully_synthetic"; },
  }), {
    getPrototypeOf: () => { proxyCalls += 1; return Object.prototype; },
    ownKeys: () => { proxyCalls += 1; return []; },
    getOwnPropertyDescriptor: () => { proxyCalls += 1; return undefined; },
  });
  const result = assessM1Readiness(value.catalog, hostile);
  assert.deepStrictEqual({ getterCalls, proxyCalls, result }, {
    getterCalls: 0,
    proxyCalls: 0,
    result: {
      status: "BLOCKED",
      primaryReason: "SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT",
      reasons: ["SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT"],
    },
  });
});

test("controller 2: self-reported region cannot exceed the M0 endpoint", () => {
  const value = candidate();
  value.evidence.target.region = "SYNTHETIC-REGION-DRIFT";
  for (const authority of value.evidence.authorities) authority.jurisdictions = [value.evidence.target.region];
  for (const source of value.evidence.sources) source.applicableRegions = [value.evidence.target.region];
  refreshEvidenceBindings(value);
  for (const decision of value.evidence.reviewDecisions) {
    decision.scope.applicableRegions = [value.evidence.target.region];
    refreshDecision(decision, value.evidence.authorities.find(({ role }) => role === decision.role)!);
  }
  assert.deepStrictEqual(reasons(value), ["REGION_NOT_APPLICABLE"]);
});

test("controller 3: self-reported language cannot exceed the M0 endpoint", () => {
  const value = candidate();
  value.evidence.target.language = "x-synthetic-drift";
  for (const authority of value.evidence.authorities) authority.languages = [value.evidence.target.language];
  for (const source of value.evidence.sources) source.sourceLanguage = value.evidence.target.language;
  refreshEvidenceBindings(value);
  for (const decision of value.evidence.reviewDecisions) {
    decision.scope.languages = [value.evidence.target.language];
    refreshDecision(decision, value.evidence.authorities.find(({ role }) => role === decision.role)!);
  }
  assert.deepStrictEqual(reasons(value), ["LANGUAGE_NOT_APPLICABLE"]);
});

test("controller 4: M0 review must already be effective at evaluation time", () => {
  const value = candidate();
  const release = value.catalog.releases[0] as Mutable<GovernanceRelease>;
  release.envelopes[0]!.reviewedAt = "2002-01-01T00:00:00.000Z";
  sign(release);
  refreshEvidenceBindings(value);
  assert.deepStrictEqual(reasons(value), ["DOMAIN_REVIEW_MISSING_OR_EXPIRED"]);
});

test("controller 5: approved envelope with withdrawalState withdrawn is blocked", () => {
  const value = candidate();
  const release = value.catalog.releases[0] as Mutable<GovernanceRelease>;
  release.envelopes[0]!.withdrawalState = "withdrawn";
  sign(release);
  refreshEvidenceBindings(value);
  assert.deepStrictEqual(reasons(value), ["SOURCE_WITHDRAWN"]);
});

test("controller 6: an old approved revision cannot replay after a higher active successor", () => {
  const value = candidate();
  const predecessor = value.catalog.releases[0]!;
  const successor = structuredClone(predecessor) as Mutable<GovernanceRelease>;
  successor.releaseId = "syn:release:food-concept:2";
  successor.releaseRevision = 2;
  successor.envelopes[0]!.entityRevision = 2;
  successor.envelopes[0]!.lifecycleStatus = "active";
  sign(successor);
  value.catalog.releases.push(successor);
  assert.deepStrictEqual(reasons(value), ["SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT"]);
});

test("controller 7: source version and snapshot material changes invalidate old decisions", () => {
  const value = candidate();
  const source = value.evidence.sources[0]!;
  source.sourceVersion = "syn:version:replacement";
  source.minimalSnapshot.mediaType = "application/x-synthetic-replacement";
  source.materialDigest = m1SourceInventoryDigest(source as M1SourceEvidence);
  assert.deepStrictEqual(reasons(value), ["DOMAIN_REVIEW_MISSING_OR_EXPIRED"]);
});

test("controller 8: one review ID and three signatures cannot fill twelve slots", () => {
  const value = candidate();
  const first = value.evidence.reviewDecisions[0]!;
  for (const decision of value.evidence.reviewDecisions.slice(1)) {
    decision.reviewDecisionId = first.reviewDecisionId;
    decision.evidenceDigest = first.evidenceDigest;
    decision.independenceEvidenceDigest = first.independenceEvidenceDigest;
    decision.conflictDisclosureDigest = first.conflictDisclosureDigest;
  }
  assert.deepStrictEqual(reasons(value), [
    "CONFLICTED_OR_DUPLICATE_APPROVER",
    "DOMAIN_REVIEW_MISSING_OR_EXPIRED",
  ]);
});

test("controller 9: two assignments cannot reuse one authorityRecordId", () => {
  const value = candidate();
  value.evidence.authorities[1]!.authorityRecordId = value.evidence.authorities[0]!.authorityRecordId;
  refreshEvidenceBindings(value);
  assert.deepStrictEqual(reasons(value), ["CONFLICTED_OR_DUPLICATE_APPROVER"]);
});

test("controller 10: caller time backfill cannot detach exact receipt time", () => {
  const value = candidate();
  const release = value.catalog.releases[0] as Mutable<GovernanceRelease>;
  release.envelopes[0]!.reviewDueAt = "2002-01-01T00:00:00.000Z";
  value.evidence.sources[0]!.withdrawalMonitoring.nextDueAt = "2002-01-01T00:00:00.000Z";
  sign(release);
  refreshEvidenceBindings(value);
  for (const receiptValue of value.evidence.receipts) receiptValue.evaluationTime = "2003-01-01T00:00:00.000Z";
  value.evidence.receipts.find(({ kind }) => kind === "evaluation_time")!.observedAt =
    "2003-01-01T00:00:00.000Z";
  for (const receiptValue of value.evidence.receipts) {
    receiptValue.receiptDigest = m1ReceiptDigest(receiptValue as M1BoundReceipt);
  }
  assert.deepStrictEqual(reasons(value), [
    "READINESS_GATE_FAILED",
    "INDEPENDENT_A_B_NOT_CLEAN",
    "TOTAL_CONTROL_NOT_ACCEPTED",
  ]);
});

test("controller 11: identical SourceKey and material may cover multiple occurrences", () => {
  const value = candidate(twoEntityCatalog());
  assert.deepStrictEqual(assess(value), {
    status: "ACTIVATION_ELIGIBLE",
    primaryReason: null,
    reasons: [],
  });
});

test("different material for the same SourceKey remains an exact M0 rejection", () => {
  const catalog = twoEntityCatalog();
  const release = catalog.releases[0] as Mutable<GovernanceRelease>;
  const second = release.envelopes[1]!;
  second.sourceSnapshots[0]!.snapshotId = "syn:snapshot:food-concept:2";
  second.sourceSnapshots[0]!.contentDigest = digest(999);
  sign(release);
  const analysis = analyzeGovernanceCatalog(catalog);
  assert.deepStrictEqual({ issues: analysis.issues, reasons: reasons(candidate(catalog)) }, {
    issues: [{ code: "SOURCE_REFERENCE_EQUIVOCATION", path: "/releases/0/envelopes/1/sourceReferences/0" }],
    reasons: ["SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT"],
  });
});

test("source version, hash, and monitoring material each invalidate old decision binding", () => {
  const cases = [
    (source: Mutable<M1SourceEvidence>) => { source.sourceVersion = "syn:version:new"; },
    (source: Mutable<M1SourceEvidence>) => {
      source.minimalSnapshot.mediaType = "application/x-synthetic-new";
    },
    (source: Mutable<M1SourceEvidence>) => {
      source.withdrawalMonitoring.method = "syn:monitor-method:new";
    },
  ];
  const observed = cases.map((mutate) => {
    const value = candidate();
    mutate(value.evidence.sources[0]!);
    value.evidence.sources[0]!.materialDigest = m1SourceInventoryDigest(
      value.evidence.sources[0]! as M1SourceEvidence,
    );
    return reasons(value);
  });
  assert.deepStrictEqual(observed, [
    ["DOMAIN_REVIEW_MISSING_OR_EXPIRED"],
    ["DOMAIN_REVIEW_MISSING_OR_EXPIRED"],
    ["DOMAIN_REVIEW_MISSING_OR_EXPIRED"],
  ]);
});

test("receipt candidate, release, report, and evaluation-time drift block independently", () => {
  const observed = [
    (value: Candidate) => {
      value.evidence.receipts.find(({ kind }) => kind === "readiness_gate")!.candidateCommitSha =
        "2".repeat(40);
    },
    (value: Candidate) => {
      value.evidence.receipts.find(({ kind }) => kind === "audit_a")!.releaseRevision += 1;
    },
    (value: Candidate) => {
      value.evidence.receipts.find(({ kind }) => kind === "audit_b")!.reportDigest = digest(777);
    },
    (value: Candidate) => {
      value.evidence.receipts.find(({ kind }) => kind === "total_control")!.evaluationTime =
        "2002-01-01T00:00:00.000Z";
    },
  ].map((mutate) => {
    const value = candidate();
    mutate(value);
    return reasons(value);
  });
  assert.deepStrictEqual(observed, [
    ["READINESS_GATE_FAILED"],
    ["INDEPENDENT_A_B_NOT_CLEAN"],
    ["INDEPENDENT_A_B_NOT_CLEAN"],
    ["TOTAL_CONTROL_NOT_ACCEPTED"],
  ]);
});

test("authority and review IDs and digests reject each duplicate family", () => {
  const mutations = [
    (value: Candidate) => {
      value.evidence.authorities[1]!.assignmentDigest = value.evidence.authorities[0]!.assignmentDigest;
    },
    (value: Candidate) => {
      value.evidence.authorities[1]!.naturalPersonIdentity =
        value.evidence.authorities[0]!.naturalPersonIdentity;
    },
    (value: Candidate) => {
      value.evidence.authorities[1]!.acceptanceEvidenceDigest =
        value.evidence.authorities[0]!.acceptanceEvidenceDigest;
    },
    (value: Candidate) => {
      value.evidence.reviewDecisions[1]!.reviewDecisionId =
        value.evidence.reviewDecisions[0]!.reviewDecisionId;
    },
    (value: Candidate) => {
      value.evidence.reviewDecisions[1]!.evidenceDigest =
        value.evidence.reviewDecisions[0]!.evidenceDigest;
    },
    (value: Candidate) => {
      value.evidence.reviewDecisions[1]!.independenceEvidenceDigest =
        value.evidence.reviewDecisions[0]!.independenceEvidenceDigest;
    },
    (value: Candidate) => {
      value.evidence.reviewDecisions[1]!.conflictDisclosureDigest =
        value.evidence.reviewDecisions[0]!.conflictDisclosureDigest;
    },
  ];
  const observed = mutations.map((mutate) => {
    const value = candidate();
    mutate(value);
    return reasons(value);
  });
  assert.deepStrictEqual(observed.map((entry) => entry.includes("CONFLICTED_OR_DUPLICATE_APPROVER")),
    [true, true, true, true, true, true, true]);
});

test("object keys and source/review arrays are order independent", () => {
  const value = candidate();
  const expected = assess(value);
  value.evidence.authorities.reverse();
  value.evidence.sources.reverse();
  value.evidence.reviewDecisions.reverse();
  for (const decision of value.evidence.reviewDecisions) {
    decision.scope.entityRevisions.reverse();
    decision.scope.factOrRuleIds.reverse();
    decision.scope.sourceInventoryBindings.reverse();
    decision.scope.sourceKeys.reverse();
  }
  const reordered = JSON.stringify(reverseObjectKeys(value.evidence));
  assert.deepStrictEqual({ arrayOrder: assess(value), objectOrder: assessM1Readiness(value.catalog, reordered) }, {
    arrayOrder: expected,
    objectOrder: expected,
  });
});

test("complete reason array preserves total order without projection", () => {
  const value = candidate();
  value.evidence.authorities[0]!.status = "revoked";
  value.evidence.sources[0]!.withdrawalMonitoring.state = "withdrawn";
  value.evidence.sources[0]!.licenseStatus = "pending";
  value.evidence.sources[0]!.applicableRegions = [];
  refreshEvidenceBindings(value);
  assert.deepStrictEqual(assess(value), {
    status: "BLOCKED",
    primaryReason: "FORGED_OR_REVOKED_AUTHORITY",
    reasons: [
      "FORGED_OR_REVOKED_AUTHORITY",
      "UNASSIGNED_OR_UNACCEPTED_AUTHORITY",
      "SOURCE_WITHDRAWN",
      "LICENSE_NOT_APPROVED",
      "REGION_NOT_APPLICABLE",
    ],
  });
});

test("empty preparation template remains structurally inert and fully blocked", () => {
  const catalog = approvedCatalog();
  const input = readFileSync(new URL("readiness-empty-template.json", m1Root), "utf8");
  assert.deepStrictEqual(assessM1Readiness(catalog, input), {
    status: "BLOCKED",
    primaryReason: "UNASSIGNED_OR_UNACCEPTED_AUTHORITY",
    reasons: [
      "UNASSIGNED_OR_UNACCEPTED_AUTHORITY",
      "SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT",
      "DOMAIN_REVIEW_MISSING_OR_EXPIRED",
      "READINESS_GATE_FAILED",
      "INDEPENDENT_A_B_NOT_CLEAN",
      "TOTAL_CONTROL_NOT_ACCEPTED",
    ],
  });
});

test("H01-H05 and K01-K06 content matrices remain explicitly deferred to S2", () => {
  assert.equal(typeof assessM1Readiness, "function");
});
