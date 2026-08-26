import { canonicalJson, compareUtf8, verifyGovernanceReleaseDigest } from "./canonical.js";
import {
  canonicalEntityHistoryText,
  entityIdentityText,
  forwardSourceMaterial,
  governedReferenceText,
  reverseSnapshotMaterial,
  sourceKeyText,
} from "./catalog.js";
import { decodeGovernanceCatalog } from "./decode.js";
import {
  lifecycleStatuses,
  type DecodedGovernanceCatalog,
  type GovernanceEnvelope,
  type GovernedReference,
  type LifecycleStatus,
  type M1AuthorityEvidence,
  type M1ReadinessAssessment,
  type M1ReadinessEvidence,
  type M1ReadinessReason,
  m1ReadinessReasons,
  m1ReadinessRoles,
  type ValidationIssue,
  type ValidationIssueCode,
} from "./types.js";

type LifecycleRow = Readonly<Record<LifecycleStatus, boolean>>;

const row = (
  draft: boolean,
  underReview: boolean,
  approved: boolean,
  active: boolean,
  superseded: boolean,
  withdrawn: boolean,
): LifecycleRow =>
  Object.freeze({
    draft,
    under_review: underReview,
    approved,
    active,
    superseded,
    withdrawn,
  });

/** The sole executable form of ADR-0008's literal 6 x 6 lifecycle oracle. */
export const lifecycleTransitionOracle: Readonly<Record<LifecycleStatus, LifecycleRow>> =
  Object.freeze({
    draft: row(true, true, false, false, false, false),
    under_review: row(false, true, true, false, false, false),
    approved: row(false, false, true, true, true, true),
    active: row(false, false, false, true, true, true),
    superseded: row(false, false, false, false, false, false),
    withdrawn: row(false, false, false, true, false, true),
  });

export const isLifecycleTransitionAllowed = (
  previous: LifecycleStatus,
  next: LifecycleStatus,
): boolean => lifecycleTransitionOracle[previous][next];

interface MutableFinding {
  readonly code: ValidationIssueCode;
  readonly path: string;
  readonly scope: "global" | "mapping";
  readonly mappingId?: string;
}

export interface CatalogFinding {
  readonly issue: ValidationIssue;
  readonly scope: "global" | "mapping";
  readonly mappingId?: string;
}

export interface CatalogAnalysis {
  readonly catalog: DecodedGovernanceCatalog | null;
  readonly findings: readonly CatalogFinding[];
  readonly issues: readonly ValidationIssue[];
}

const pointer = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");

const issueCompare = (left: ValidationIssue, right: ValidationIssue): number => {
  const codeOrder = compareUtf8(left.code, right.code);
  return codeOrder === 0 ? compareUtf8(left.path, right.path) : codeOrder;
};

const freezeFindings = (values: readonly MutableFinding[]): readonly CatalogFinding[] => {
  const unique = new Map<string, MutableFinding>();
  for (const value of values) unique.set(`${value.code}\u0000${value.path}`, value);
  return Object.freeze(
    [...unique.values()]
      .sort(issueCompare)
      .map((value) => {
        const issue = Object.freeze({ code: value.code, path: value.path });
        return Object.freeze({
          issue,
          scope: value.scope,
          ...(value.mappingId === undefined ? {} : { mappingId: value.mappingId }),
        });
      }),
  );
};

const translatedShapeCode = (path: string): ValidationIssueCode => {
  if (/\/source(?:References|Snapshots)$/.test(path)) return "MISSING_SOURCE";
  if (/\/applicableRegions$/.test(path)) return "MISSING_REGION";
  if (/\/languages$/.test(path)) return "MISSING_LANGUAGE";
  if (/\/approvers$/.test(path)) return "MISSING_APPROVER";
  return "INVALID_SHAPE";
};

const containsExternalFactMarker = (
  value: unknown,
  path: string,
): string | null => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = containsExternalFactMarker(value[index], `${path}/${index}`);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const key of Object.keys(value)) {
    const child = `${path}/${pointer(key)}`;
    if (key === "externalFact") return child;
    const found = containsExternalFactMarker((value as Record<string, unknown>)[key], child);
    if (found !== null) return found;
  }
  return null;
};

const canonicalTimestamp = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const sourceGraphToken = (envelope: GovernanceEnvelope): string | null => {
  if (envelope.sourceReferences.length === 0 || envelope.sourceSnapshots.length === 0) {
    return null;
  }

  const snapshotsBySourceKey = new Map<
    string,
    GovernanceEnvelope["sourceSnapshots"][number]
  >();
  const snapshotIds = new Set<string>();
  for (const snapshot of envelope.sourceSnapshots) {
    const key = sourceKeyText(snapshot);
    if (
      snapshotsBySourceKey.has(key) ||
      snapshotIds.has(snapshot.snapshotId) ||
      !canonicalTimestamp(snapshot.retrievedAt)
    ) {
      return null;
    }
    snapshotsBySourceKey.set(key, snapshot);
    snapshotIds.add(snapshot.snapshotId);
  }

  const referenceKeys = new Set<string>();
  const forward = [];
  for (const reference of envelope.sourceReferences) {
    const key = sourceKeyText(reference);
    if (referenceKeys.has(key)) return null;
    referenceKeys.add(key);
    const pairedSnapshot = snapshotsBySourceKey.get(key);
    if (pairedSnapshot === undefined || pairedSnapshot.locator !== reference.locator) {
      return null;
    }
    forward.push({
      sourceKey: sourceKeyText(reference),
      material: forwardSourceMaterial(reference, pairedSnapshot),
    });
  }

  if (
    referenceKeys.size !== snapshotsBySourceKey.size ||
    [...snapshotsBySourceKey.keys()].some((key) => !referenceKeys.has(key))
  ) {
    return null;
  }

  forward.sort((left, right) => compareUtf8(left.sourceKey, right.sourceKey));
  const reverse = envelope.sourceSnapshots
    .map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      material: reverseSnapshotMaterial(snapshot),
    }))
    .sort((left, right) => compareUtf8(left.snapshotId, right.snapshotId));

  return canonicalJson({ forward, reverse });
};

const envelopeUsableWithoutContext = (envelope: GovernanceEnvelope): boolean =>
  envelope.owner.actorId.length > 0 &&
  envelope.approvers.length > 0 &&
  envelope.sourceReferences.length > 0 &&
  envelope.sourceSnapshots.length > 0 &&
  envelope.applicableRegions.length > 0 &&
  envelope.languages.length > 0 &&
  envelope.licenseStatus === "approved" &&
  envelope.licenseReference !== null &&
  envelope.sourceTier !== "L4";

const endpointExists = (
  catalog: DecodedGovernanceCatalog,
  reference: GovernedReference,
): boolean =>
  catalog.releases.some((release) =>
    release.envelopes.some(
      (envelope) => governedReferenceText(envelope) === governedReferenceText(reference),
    ),
  );

export const analyzeGovernanceCatalog = (input: unknown): CatalogAnalysis => {
  const decoded = decodeGovernanceCatalog(input);
  if (!decoded.ok) {
    const finding = freezeFindings([
      {
        code: translatedShapeCode(decoded.issue.path),
        path: decoded.issue.path,
        scope: "global",
      },
    ]);
    return Object.freeze({
      catalog: null,
      findings: finding,
      issues: Object.freeze(finding.map(({ issue }) => issue)),
    });
  }

  const catalog = decoded.value;
  const findings: MutableFinding[] = [];
  const add = (
    code: ValidationIssueCode,
    path: string,
    scope: "global" | "mapping" = "global",
    mappingId?: string,
  ): void => {
    findings.push({ code, path, scope, ...(mappingId === undefined ? {} : { mappingId }) });
  };

  const releaseIds = new Set<string>();
  const lastReleaseRevisionByDataset = new Map<string, number>();
  const datasetKindsByDataset = new Map<string, GovernanceEnvelope["datasetKind"]>();
  const priorIdentitiesByDataset = new Map<string, ReadonlySet<string>>();
  const history = new Map<
    string,
    { readonly envelope: GovernanceEnvelope; readonly material: string }
  >();
  const forwardByKey = new Map<string, string>();
  const reverseBySnapshotId = new Map<string, string>();

  for (let releaseIndex = 0; releaseIndex < catalog.releases.length; releaseIndex += 1) {
    const release = catalog.releases[releaseIndex];
    if (release === undefined) continue;
    const releasePath = `/releases/${releaseIndex}`;
    if (releaseIds.has(release.releaseId)) add("DUPLICATE_RELEASE", `${releasePath}/releaseId`);
    releaseIds.add(release.releaseId);
    if (!verifyGovernanceReleaseDigest(release).ok) {
      add("RELEASE_DIGEST_MISMATCH", `${releasePath}/contentDigest`);
    }

    const datasets = new Set(release.envelopes.map(({ datasetId }) => datasetId));
    for (const datasetId of datasets) {
      const previous = lastReleaseRevisionByDataset.get(datasetId);
      if (previous !== undefined && release.releaseRevision <= previous) {
        add("RELEASE_REVISION_NOT_INCREASING", `${releasePath}/releaseRevision`);
      }
      lastReleaseRevisionByDataset.set(datasetId, release.releaseRevision);
    }

    const releaseEntities = new Map<string, number>();
    const currentIdentitiesByDataset = new Map<string, Set<string>>();
    for (let envelopeIndex = 0; envelopeIndex < release.envelopes.length; envelopeIndex += 1) {
      const envelope = release.envelopes[envelopeIndex];
      if (envelope === undefined) continue;
      const envelopePath = `${releasePath}/envelopes/${envelopeIndex}`;
      const identity = entityIdentityText(envelope);
      const knownDatasetKind = datasetKindsByDataset.get(envelope.datasetId);
      if (knownDatasetKind !== undefined && knownDatasetKind !== envelope.datasetKind) {
        add("INVALID_SHAPE", `${envelopePath}/datasetKind`);
      } else if (knownDatasetKind === undefined) {
        datasetKindsByDataset.set(envelope.datasetId, envelope.datasetKind);
      }
      const currentIdentities = currentIdentitiesByDataset.get(envelope.datasetId) ?? new Set<string>();
      currentIdentities.add(identity);
      currentIdentitiesByDataset.set(envelope.datasetId, currentIdentities);
      if (releaseEntities.has(identity)) add("DUPLICATE_ENTITY", `${envelopePath}/entityId`);
      releaseEntities.set(identity, envelopeIndex);

      if (envelope.owner.actorId.length === 0) add("MISSING_OWNER", `${envelopePath}/owner`);
      if (envelope.approvers.length === 0) add("MISSING_APPROVER", `${envelopePath}/approvers`);
      if (envelope.sourceReferences.length === 0 || envelope.sourceSnapshots.length === 0) {
        add("MISSING_SOURCE", `${envelopePath}/sourceReferences`);
      }
      if (envelope.applicableRegions.length === 0) {
        add("MISSING_REGION", `${envelopePath}/applicableRegions`);
      }
      if (envelope.languages.length === 0) add("MISSING_LANGUAGE", `${envelopePath}/languages`);
      if (envelope.sourceTier === "L4") add("MISSING_SOURCE", `${envelopePath}/sourceTier`);
      if (envelope.licenseStatus !== "approved" || envelope.licenseReference === null) {
        add("MISSING_LICENSE", `${envelopePath}/licenseStatus`);
      }
      if (!canonicalTimestamp(envelope.retrievedAt)) {
        add("INVALID_SHAPE", `${envelopePath}/retrievedAt`);
      }
      if (!canonicalTimestamp(envelope.reviewedAt)) {
        add("INVALID_SHAPE", `${envelopePath}/reviewedAt`);
      }
      if (!canonicalTimestamp(envelope.reviewDueAt) || envelope.reviewDueAt < envelope.reviewedAt) {
        add("INVALID_SHAPE", `${envelopePath}/reviewDueAt`);
      }
      if (envelope.syntheticEvidence === undefined) {
        add("INVALID_SYNTHETIC_EVIDENCE", `${envelopePath}/syntheticEvidence`);
      }
      const externalFactPath = containsExternalFactMarker(envelope.content, `${envelopePath}/content`);
      if (externalFactPath !== null) add("INVALID_SYNTHETIC_EVIDENCE", externalFactPath);

      const isWithdrawn = envelope.lifecycleStatus === "withdrawn";
      const hasWithdrawal =
        envelope.withdrawalState === "withdrawn" &&
        envelope.withdrawalReason !== null &&
        envelope.withdrawnAt !== null;
      if (isWithdrawn !== hasWithdrawal) {
        add("INVALID_WITHDRAWAL_STATE", `${envelopePath}/withdrawalState`);
      }

      const snapshotIndexes = new Map<string, number[]>();
      for (let snapshotIndex = 0; snapshotIndex < envelope.sourceSnapshots.length; snapshotIndex += 1) {
        const snapshot = envelope.sourceSnapshots[snapshotIndex];
        if (snapshot === undefined) continue;
        if (!canonicalTimestamp(snapshot.retrievedAt)) {
          add("INVALID_SHAPE", `${envelopePath}/sourceSnapshots/${snapshotIndex}/retrievedAt`);
        }
        const key = sourceKeyText(snapshot);
        const indexes = snapshotIndexes.get(key) ?? [];
        indexes.push(snapshotIndex);
        snapshotIndexes.set(key, indexes);
        const reverse = canonicalJson(reverseSnapshotMaterial(snapshot));
        const priorReverse = reverseBySnapshotId.get(snapshot.snapshotId);
        if (priorReverse !== undefined && priorReverse !== reverse) {
          add(
            "SOURCE_SNAPSHOT_ID_EQUIVOCATION",
            `${envelopePath}/sourceSnapshots/${snapshotIndex}`,
          );
        } else if (priorReverse === undefined) {
          reverseBySnapshotId.set(snapshot.snapshotId, reverse);
        }
      }
      const referenceIndexes = new Map<string, number[]>();
      for (let referenceIndex = 0; referenceIndex < envelope.sourceReferences.length; referenceIndex += 1) {
        const reference = envelope.sourceReferences[referenceIndex];
        if (reference === undefined) continue;
        const key = sourceKeyText(reference);
        const indexes = referenceIndexes.get(key) ?? [];
        indexes.push(referenceIndex);
        referenceIndexes.set(key, indexes);
        const matchingSnapshots = snapshotIndexes.get(key) ?? [];
        const referencePath = `${envelopePath}/sourceReferences/${referenceIndex}`;
        if (matchingSnapshots.length !== 1) {
          add("SOURCE_SNAPSHOT_MISMATCH", referencePath);
        } else {
          const snapshotIndex = matchingSnapshots[0];
          const snapshot = envelope.sourceSnapshots[snapshotIndex ?? -1];
          if (snapshot === undefined) {
            add("SOURCE_SNAPSHOT_MISMATCH", referencePath);
          } else {
            if (snapshot.locator !== reference.locator) {
              add("SOURCE_SNAPSHOT_MISMATCH", referencePath);
              add("SOURCE_SNAPSHOT_MISMATCH", `${envelopePath}/sourceSnapshots/${snapshotIndex}`);
            }
            const forward = canonicalJson(forwardSourceMaterial(reference, snapshot));
            const priorForward = forwardByKey.get(key);
            if (priorForward !== undefined && priorForward !== forward) {
              add("SOURCE_REFERENCE_EQUIVOCATION", referencePath);
            } else if (priorForward === undefined) {
              forwardByKey.set(key, forward);
            }
          }
        }
      }
      for (let snapshotIndex = 0; snapshotIndex < envelope.sourceSnapshots.length; snapshotIndex += 1) {
        const snapshot = envelope.sourceSnapshots[snapshotIndex];
        if (snapshot === undefined) continue;
        if ((referenceIndexes.get(sourceKeyText(snapshot)) ?? []).length !== 1) {
          add("SOURCE_SNAPSHOT_MISMATCH", `${envelopePath}/sourceSnapshots/${snapshotIndex}`);
        }
      }
      for (let aliasIndex = 0; aliasIndex < envelope.aliases.length; aliasIndex += 1) {
        const alias = envelope.aliases[aliasIndex];
        if (alias === undefined) continue;
        const aliasKey = canonicalJson({
          referenceId: alias.sourceReferenceId,
          referenceRevision: alias.sourceReferenceRevision,
        });
        if (!referenceIndexes.has(aliasKey)) {
          add("MISSING_SOURCE", `${envelopePath}/aliases/${aliasIndex}`);
        }
      }

      const material = canonicalEntityHistoryText(envelope);
      const previous = history.get(identity);
      if (previous !== undefined) {
        if (envelope.datasetKind !== previous.envelope.datasetKind) {
          add("INVALID_SHAPE", `${envelopePath}/datasetKind`);
        } else if (envelope.entityRevision < previous.envelope.entityRevision) {
          add("ENTITY_REVISION_REGRESSION", `${envelopePath}/entityRevision`);
        } else if (envelope.entityRevision === previous.envelope.entityRevision) {
          if (material !== previous.material) {
            add("ENTITY_REVISION_EQUIVOCATION", `${envelopePath}/entityRevision`);
          }
        } else {
          const oracleAllows = isLifecycleTransitionAllowed(
            previous.envelope.lifecycleStatus,
            envelope.lifecycleStatus,
          );
          const isReactivation =
            previous.envelope.lifecycleStatus === "withdrawn" &&
            envelope.lifecycleStatus === "active";
          let reactivationFresh = true;
          if (isReactivation) {
            const previousToken = sourceGraphToken(previous.envelope);
            const currentToken = sourceGraphToken(envelope);
            const graphFresh =
              previousToken !== null &&
              currentToken !== null &&
              previousToken !== currentToken;
            const retrievalFresh =
              canonicalTimestamp(previous.envelope.retrievedAt) &&
              canonicalTimestamp(envelope.retrievedAt) &&
              envelope.retrievedAt > previous.envelope.retrievedAt;
            const reviewFresh =
              canonicalTimestamp(previous.envelope.reviewedAt) &&
              canonicalTimestamp(envelope.reviewedAt) &&
              envelope.reviewedAt > previous.envelope.reviewedAt;
            reactivationFresh = graphFresh && retrievalFresh && reviewFresh;
          }
          if (!oracleAllows || !reactivationFresh) {
            add("INVALID_LIFECYCLE_TRANSITION", `${envelopePath}/lifecycleStatus`);
          }
        }
      }
      history.set(identity, { envelope, material });
    }

    for (const [datasetId, currentIdentities] of currentIdentitiesByDataset) {
      const priorIdentities = priorIdentitiesByDataset.get(datasetId);
      if (
        priorIdentities !== undefined &&
        [...priorIdentities].some((identity) => !currentIdentities.has(identity))
      ) {
        add("ENTITY_MISSING_FROM_SNAPSHOT", `${releasePath}/envelopes`);
      }
      priorIdentitiesByDataset.set(datasetId, currentIdentities);
    }

    const currentByIdentity = new Map<string, GovernanceEnvelope>();
    for (const envelope of release.envelopes) currentByIdentity.set(entityIdentityText(envelope), envelope);
    const edgeByIdentity = new Map<string, string>();
    for (let envelopeIndex = 0; envelopeIndex < release.envelopes.length; envelopeIndex += 1) {
      const envelope = release.envelopes[envelopeIndex];
      if (envelope === undefined) continue;
      const path = `${releasePath}/envelopes/${envelopeIndex}/supersededBy`;
      if (envelope.lifecycleStatus === "superseded" && envelope.supersededBy === null) {
        add("INVALID_SUPERSESSION_TARGET", path);
        continue;
      }
      if (envelope.supersededBy === null) continue;
      const sourceIdentity = entityIdentityText(envelope);
      const targetIdentity = entityIdentityText(envelope.supersededBy);
      edgeByIdentity.set(sourceIdentity, targetIdentity);
      if (sourceIdentity === targetIdentity) add("INVALID_SUPERSESSION_SELF", path);
      const target = currentByIdentity.get(targetIdentity);
      if (target === undefined) {
        add("INVALID_SUPERSESSION_TARGET", path);
        continue;
      }
      if (target.datasetId !== envelope.datasetId) add("INVALID_SUPERSESSION_DATASET", path);
      if (target.datasetKind !== envelope.datasetKind) add("INVALID_SUPERSESSION_KIND", path);
      if (target.entityRevision !== envelope.supersededBy.entityRevision) {
        add("INVALID_SUPERSESSION_TARGET_REVISION", path);
      }
      if (target.lifecycleStatus !== "active") {
        add("INVALID_SUPERSESSION_TARGET_LIFECYCLE", path);
      }
      if (!envelopeUsableWithoutContext(target)) add("INVALID_SUPERSESSION_TARGET", path);
      if (envelope.lifecycleStatus !== "superseded") add("INVALID_SUPERSESSION_TARGET", path);
    }
    for (const [source, firstTarget] of edgeByIdentity) {
      const seen = new Set([source]);
      let target: string | undefined = firstTarget;
      while (target !== undefined) {
        if (seen.has(target)) {
          const sourceIndex = release.envelopes.findIndex(
            (envelope) => entityIdentityText(envelope) === source,
          );
          add("INVALID_SUPERSESSION_CYCLE", `${releasePath}/envelopes/${sourceIndex}/supersededBy`);
          break;
        }
        seen.add(target);
        target = edgeByIdentity.get(target);
      }
    }
  }

  const mappingIndexes = new Map<string, number[]>();
  for (let index = 0; index < catalog.hardMappings.length; index += 1) {
    const mapping = catalog.hardMappings[index];
    if (mapping === undefined) continue;
    const indexes = mappingIndexes.get(mapping.mappingId) ?? [];
    if (indexes.length > 0) {
      add("DUPLICATE_HARD_MAPPING", `/hardMappings/${index}/mappingId`, "mapping", mapping.mappingId);
    }
    indexes.push(index);
    mappingIndexes.set(mapping.mappingId, indexes);
    if (!endpointExists(catalog, mapping.source)) {
      add(
        "HARD_MAPPING_SOURCE_UNRESOLVED",
        `/hardMappings/${index}/source`,
        "mapping",
        mapping.mappingId,
      );
    }
    if (!endpointExists(catalog, mapping.target)) {
      add(
        "HARD_MAPPING_TARGET_UNRESOLVED",
        `/hardMappings/${index}/target`,
        "mapping",
        mapping.mappingId,
      );
    }
  }

  const frozenFindings = freezeFindings(findings);
  return Object.freeze({
    catalog,
    findings: frozenFindings,
    issues: Object.freeze(frozenFindings.map(({ issue }) => issue)),
  });
};

export const validateGovernanceCatalog = (input: unknown): readonly ValidationIssue[] =>
  analyzeGovernanceCatalog(input).issues;

export const lifecycleOracleCardinality = (): Readonly<{ accepted: number; rejected: number }> => {
  let accepted = 0;
  for (const previous of lifecycleStatuses) {
    for (const next of lifecycleStatuses) {
      if (isLifecycleTransitionAllowed(previous, next)) accepted += 1;
    }
  }
  return Object.freeze({ accepted, rejected: 36 - accepted });
};

const sortedSetEquals = (left: readonly string[], right: readonly string[]): boolean => {
  const normalize = (values: readonly string[]): string[] => [...new Set(values)].sort(compareUtf8);
  return canonicalJson(normalize(left)) === canonicalJson(normalize(right));
};
const hasSyntheticPrefix = (value: string): boolean => value.startsWith("syn:");
/** S1-only derived gate. It never mutates M0 input or performs a lifecycle transition. */
export const assessM1Readiness = (
  catalogInput: unknown,
  evidenceInput: unknown,
): M1ReadinessAssessment => {
  const reasons = new Set<M1ReadinessReason>();
  const add = (reason: M1ReadinessReason): void => void reasons.add(reason);
  const evidence = evidenceInput as Partial<M1ReadinessEvidence>;
  const target = evidence.target;
  const authorities = Array.isArray(evidence.authorities) ? evidence.authorities : [];
  const sources = Array.isArray(evidence.sources) ? evidence.sources : [];
  const decisions = Array.isArray(evidence.reviewDecisions) ? evidence.reviewDecisions : [];
  const analysis = analyzeGovernanceCatalog(catalogInput);
  if (analysis.catalog === null || analysis.issues.length > 0) {
    add("SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT");
  }
  const release = analysis.catalog?.releases.find(
    (candidate) =>
      candidate.releaseId === target?.releaseId &&
      candidate.releaseRevision === target.releaseRevision &&
      candidate.contentDigest === target.releaseContentDigest,
  );
  if (release === undefined) add("SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT");
  for (const envelope of release?.envelopes ?? []) {
    if (envelope.lifecycleStatus === "withdrawn") add("SOURCE_WITHDRAWN");
    else if (envelope.lifecycleStatus !== "approved") add("DOMAIN_REVIEW_MISSING_OR_EXPIRED");
    if (!canonicalTimestamp(envelope.reviewDueAt) || Date.parse(envelope.reviewDueAt) <= Date.parse(target?.asOf ?? "")) add("DOMAIN_REVIEW_MISSING_OR_EXPIRED");
  }
  const authorityByRole = new Map<string, M1AuthorityEvidence[]>();
  const identities = new Set<string>();
  const acceptanceDigests = new Set<string>();
  for (const authority of authorities) {
    const grouped = authorityByRole.get(authority.role) ?? [];
    grouped.push(authority);
    authorityByRole.set(authority.role, grouped);
    if (
      authority.status === "revoked" ||
      (authority.naturalPersonIdentity.length > 0 &&
        (!authority.identityVerified || !hasSyntheticPrefix(authority.naturalPersonIdentity)))
    ) add("FORGED_OR_REVOKED_AUTHORITY");
    if (
      authority.status !== "confirmed" || authority.naturalPersonIdentity.length === 0 ||
      !authority.acceptedResponsibilities || !hasSyntheticPrefix(authority.authorityRecordId) ||
      !hasSyntheticPrefix(authority.assignmentDigest) ||
      !hasSyntheticPrefix(authority.acceptanceEvidenceDigest) ||
      (authority.assignmentKind === "substitute" &&
        (!authority.equivalentQualification || !hasSyntheticPrefix(authority.substitutesFor)))
    ) add("UNASSIGNED_OR_UNACCEPTED_AUTHORITY");
    if (
      !authority.independent || authority.disclosedConflicts.length > 0 ||
      identities.has(authority.naturalPersonIdentity) ||
      acceptanceDigests.has(authority.acceptanceEvidenceDigest)
    ) add("CONFLICTED_OR_DUPLICATE_APPROVER");
    if (authority.naturalPersonIdentity.length > 0) identities.add(authority.naturalPersonIdentity);
    if (authority.acceptanceEvidenceDigest.length > 0) {
      acceptanceDigests.add(authority.acceptanceEvidenceDigest);
    }
  }
  for (const role of m1ReadinessRoles) {
    const count = authorityByRole.get(role)?.length ?? 0;
    if (count !== 1) add(count > 1
      ? "CONFLICTED_OR_DUPLICATE_APPROVER"
      : "UNASSIGNED_OR_UNACCEPTED_AUTHORITY");
  }
  const expectedEntityRevisions = (release?.envelopes ?? []).map(
    ({ entityId, entityRevision }) => `${entityId}@${entityRevision}`,
  );
  const expectedSourceKeys = (release?.envelopes ?? []).flatMap(({ sourceReferences }) =>
    sourceReferences.map(sourceKeyText));
  if (sources.length !== expectedSourceKeys.length || sources.length === 0 || !sortedSetEquals(
    sources.map(({ referenceId, referenceRevision }) => canonicalJson({ referenceId, referenceRevision })), expectedSourceKeys)) {
    add("SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT");
  }
  for (const source of sources) {
    const envelope = release?.envelopes.find(
      (candidate) => candidate.datasetId === source.datasetId &&
        candidate.entityId === source.entityId && candidate.entityRevision === source.entityRevision,
    );
    const reference = envelope?.sourceReferences.find(
      (candidate) => candidate.referenceId === source.referenceId &&
        candidate.referenceRevision === source.referenceRevision,
    );
    const snapshot = envelope?.sourceSnapshots.find(
      (candidate) => candidate.referenceId === source.referenceId &&
        candidate.referenceRevision === source.referenceRevision,
    );
    if (
      envelope === undefined || reference === undefined || snapshot === undefined ||
      source.releaseId !== release?.releaseId || source.releaseRevision !== release?.releaseRevision ||
      source.releaseContentDigest !== release?.contentDigest || source.snapshotId !== snapshot.snapshotId ||
      source.sourceSnapshotContentDigest !== snapshot.contentDigest ||
      source.sourceLocator !== reference.locator || source.retrievedAt !== snapshot.retrievedAt ||
      !hasSyntheticPrefix(source.sourceInventoryId) || !hasSyntheticPrefix(source.factOrRuleId) ||
      !hasSyntheticPrefix(source.referenceId) || !hasSyntheticPrefix(source.sourceOrganization) ||
      source.candidateSourceTier !== envelope?.sourceTier || source.candidateSourceTier === "L4" ||
      source.sourceVersion.length === 0 || !canonicalTimestamp(source.publicationDate) || Date.parse(source.publicationDate) > Date.parse(source.retrievedAt) ||
      !hasSyntheticPrefix(source.minimalSnapshotDigest)
    ) add("SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT");
    if (
      source.monitoringState !== "current" || !canonicalTimestamp(source.monitoringNextDueAt) ||
      !canonicalTimestamp(target?.asOf ?? "") ||
      Date.parse(source.monitoringNextDueAt) <= Date.parse(target?.asOf ?? "")
    ) add("SOURCE_WITHDRAWN");
    if (
      source.licenseStatus !== "approved" || source.licenseReviewStatus !== "approved" ||
      !source.copyPermitted || !source.transformationPermitted || !source.redistributionPermitted
    ) add("LICENSE_NOT_APPROVED");
    if (!source.applicableRegions.includes(target?.region ?? "")) add("REGION_NOT_APPLICABLE");
    if (source.sourceLanguage !== target?.language) add("LANGUAGE_NOT_APPLICABLE");
    if (source.provenanceReviewStatus !== "approved" || source.domainReviewStatus !== "approved") {
      add("DOMAIN_REVIEW_MISSING_OR_EXPIRED");
    }
  }
  const expectedFacts = sources.map(({ factOrRuleId }) => factOrRuleId);
  const expectedInventories = sources.map(({ sourceInventoryId }) => sourceInventoryId);
  for (const role of m1ReadinessRoles) {
    const roleDecisions = decisions.filter((decision) => decision.role === role);
    if (roleDecisions.length !== 1) {
      add(roleDecisions.length > 1
        ? "CONFLICTED_OR_DUPLICATE_APPROVER"
        : "DOMAIN_REVIEW_MISSING_OR_EXPIRED");
      continue;
    }
    const decision = roleDecisions[0]!;
    const authority = authorityByRole.get(role)?.[0];
    if (
      authority === undefined || decision.authorityRecordId !== authority.authorityRecordId ||
      decision.authorityAssignmentRevision !== authority.assignmentRevision ||
      decision.authorityAssignmentDigest !== authority.assignmentDigest ||
      decision.assignmentAcceptanceDigest !== authority.acceptanceEvidenceDigest ||
      decision.releaseId !== target?.releaseId || decision.releaseRevision !== target?.releaseRevision ||
      decision.releaseContentDigest !== target?.releaseContentDigest || decision.decision !== "approve" || !canonicalTimestamp(decision.decidedAt) || Date.parse(decision.decidedAt) > Date.parse(target?.asOf ?? "") ||
      decision.revokedAt.length > 0 || !hasSyntheticPrefix(decision.reviewDecisionId) ||
      !hasSyntheticPrefix(decision.evidenceDigest) ||
      !hasSyntheticPrefix(decision.independenceEvidenceDigest) ||
      !hasSyntheticPrefix(decision.conflictDisclosureDigest) ||
      !sortedSetEquals(decision.entityRevisions, expectedEntityRevisions) ||
      !sortedSetEquals(decision.factOrRuleIds, expectedFacts) ||
      !sortedSetEquals(decision.sourceInventoryIds, expectedInventories) ||
      !sortedSetEquals(decision.sourceKeys, expectedSourceKeys) ||
      !sortedSetEquals(decision.applicableRegions, [target?.region ?? ""]) ||
      !sortedSetEquals(decision.languages, [target?.language ?? ""])
    ) add("DOMAIN_REVIEW_MISSING_OR_EXPIRED");
  }
  if (!evidence.readinessGatePassed) add("READINESS_GATE_FAILED");
  if (evidence.auditAResult !== "CLEAN" || evidence.auditBResult !== "CLEAN") {
    add("INDEPENDENT_A_B_NOT_CLEAN");
  }
  if (!evidence.totalControlAccepted) add("TOTAL_CONTROL_NOT_ACCEPTED");
  const ordered = Object.freeze(m1ReadinessReasons.filter((reason) => reasons.has(reason)));
  return Object.freeze({
    status: ordered.length === 0 ? "ACTIVATION_ELIGIBLE" : "BLOCKED",
    primaryReason: ordered[0] ?? null,
    reasons: ordered,
  });
};
