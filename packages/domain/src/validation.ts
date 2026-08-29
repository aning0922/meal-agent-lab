import {
  canonicalJson,
  canonicalJsonDigest,
  compareUtf8,
  verifyGovernanceReleaseDigest,
} from "./canonical.js";
import {
  canonicalEntityHistoryText,
  entityIdentityText,
  forwardSourceMaterial,
  governedReferenceText,
  reverseSnapshotMaterial,
  sourceKeyText,
} from "./catalog.js";
import { DECODE_LIMITS, decodeGovernanceCatalog, decodeJsonScalarClosure } from "./decode.js";
import {
  lifecycleStatuses,
  type DecodedGovernanceCatalog,
  type GovernanceEnvelope,
  type GovernedReference,
  type JsonValue,
  type LifecycleStatus,
  type M1AuthorityEvidence,
  type M1BoundReceipt,
  type M1ReadinessAssessment,
  type M1ReadinessEvidence,
  type M1ReadinessReason,
  type M1ReadinessTarget,
  type M1ReviewDecisionEvidence,
  type M1SourceEvidence,
  m1ReadinessReasons,
  m1ReceiptKinds,
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

type M1JsonRecord = Readonly<Record<string, JsonValue>>;

const exactRecordValue = (value: JsonValue | undefined, keys: readonly string[]): M1JsonRecord | null => {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as M1JsonRecord;
  const ownKeys = Object.keys(record).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  return ownKeys.length === expected.length && ownKeys.every((key, index) => key === expected[index])
    ? record
    : null;
};

const fieldsAreStrings = (record: M1JsonRecord, keys: readonly string[]): boolean =>
  keys.every((key) => typeof record[key] === "string");
const fieldsAreIntegers = (record: M1JsonRecord, keys: readonly string[]): boolean =>
  keys.every((key) => Number.isSafeInteger(record[key]));
const fieldsAreBooleans = (record: M1JsonRecord, keys: readonly string[]): boolean =>
  keys.every((key) => typeof record[key] === "boolean");
const stringListValue = (value: JsonValue | undefined): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const recordListValue = (
  value: JsonValue | undefined,
  check: (item: JsonValue) => boolean,
): boolean => Array.isArray(value) && value.every(check);

const sourceKeyShape = (value: JsonValue | undefined): boolean => {
  const record = exactRecordValue(value, ["referenceId", "referenceRevision"]);
  return record !== null && fieldsAreStrings(record, ["referenceId", "referenceRevision"]);
};

const targetShape = (value: JsonValue | undefined): boolean => {
  const record = exactRecordValue(value, [
    "candidateCommitSha", "datasetId", "releaseId", "releaseRevision",
    "releaseContentDigest", "region", "language", "evaluationTime",
  ]);
  return record !== null && fieldsAreStrings(record, [
    "candidateCommitSha", "datasetId", "releaseId", "releaseContentDigest",
    "region", "language", "evaluationTime",
  ]) && fieldsAreIntegers(record, ["releaseRevision"]);
};

const authorityShape = (value: JsonValue): boolean => {
  const record = exactRecordValue(value, [
    "authorityRecordId", "assignmentRevision", "assignmentDigest", "role", "dataKinds",
    "naturalPersonIdentity", "affiliation", "identityVerificationReference", "jurisdictions",
    "languages", "qualificationReference", "acceptedResponsibilities", "acceptedAt",
    "acceptanceEvidenceDigest", "independent", "independenceDeclaration", "disclosedConflicts",
    "assignmentKind", "substitutesFor", "equivalentQualification", "status", "revokedAt",
    "revocationReason",
  ]);
  return record !== null && fieldsAreStrings(record, [
    "authorityRecordId", "assignmentDigest", "role", "naturalPersonIdentity", "affiliation",
    "identityVerificationReference", "qualificationReference", "acceptedAt",
    "acceptanceEvidenceDigest", "independenceDeclaration", "assignmentKind", "substitutesFor",
    "status", "revokedAt", "revocationReason",
  ]) && fieldsAreIntegers(record, ["assignmentRevision"]) &&
    fieldsAreBooleans(record, ["independent", "equivalentQualification"]) &&
    ["dataKinds", "jurisdictions", "languages", "acceptedResponsibilities", "disclosedConflicts"]
      .every((key) => stringListValue(record[key]));
};

const minimalSnapshotShape = (value: JsonValue | undefined): boolean => {
  const record = exactRecordValue(value, [
    "locator", "mediaType", "byteLength", "hashAlgorithm", "contentHash", "capturedAt",
  ]);
  return record !== null && fieldsAreStrings(record, [
    "locator", "mediaType", "hashAlgorithm", "contentHash", "capturedAt",
  ]) && fieldsAreIntegers(record, ["byteLength"]);
};

const monitoringShape = (value: JsonValue | undefined): boolean => {
  const record = exactRecordValue(value, [
    "accountableRole", "method", "cadence", "lastCheckedAt", "nextDueAt", "state",
    "evidenceReference",
  ]);
  return record !== null && fieldsAreStrings(record, [
    "accountableRole", "method", "cadence", "lastCheckedAt", "nextDueAt", "state",
    "evidenceReference",
  ]);
};

const sourceShape = (value: JsonValue): boolean => {
  const record = exactRecordValue(value, [
    "sourceInventoryId", "materialDigest", "datasetKind", "datasetId", "releaseId",
    "releaseRevision", "releaseContentDigest", "entityId", "entityRevision", "factOrRuleId",
    "sourceKey", "snapshotId", "sourceSnapshotContentDigest", "sourceOrganization",
    "sourceLocator", "sourceVersion", "publicationDate", "retrievedAt", "minimalSnapshot",
    "applicableRegions", "sourceLanguage", "candidateSourceTier", "licenseTermsLocator",
    "rightsHolder", "licenseStatus", "copyConclusion", "transformationConclusion",
    "redistributionConclusion", "attributionRequirements", "provenanceReviewStatus",
    "licenseReviewStatus", "domainReviewStatus", "reviewEvidenceReferences",
    "withdrawalMonitoring",
  ]);
  return record !== null && fieldsAreStrings(record, [
    "sourceInventoryId", "materialDigest", "datasetKind", "datasetId", "releaseId",
    "releaseContentDigest", "entityId", "factOrRuleId", "snapshotId",
    "sourceSnapshotContentDigest", "sourceOrganization", "sourceLocator", "sourceVersion",
    "publicationDate", "retrievedAt", "sourceLanguage", "candidateSourceTier",
    "licenseTermsLocator", "rightsHolder", "licenseStatus", "copyConclusion",
    "transformationConclusion", "redistributionConclusion", "provenanceReviewStatus",
    "licenseReviewStatus", "domainReviewStatus",
  ]) && fieldsAreIntegers(record, ["releaseRevision", "entityRevision"]) &&
    sourceKeyShape(record["sourceKey"]) && minimalSnapshotShape(record["minimalSnapshot"]) &&
    monitoringShape(record["withdrawalMonitoring"]) &&
    ["applicableRegions", "attributionRequirements", "reviewEvidenceReferences"]
      .every((key) => stringListValue(record[key]));
};

const entityRevisionShape = (value: JsonValue): boolean => {
  const record = exactRecordValue(value, ["entityId", "entityRevision"]);
  return record !== null && fieldsAreStrings(record, ["entityId"]) &&
    fieldsAreIntegers(record, ["entityRevision"]);
};

const inventoryBindingShape = (value: JsonValue): boolean => {
  const record = exactRecordValue(value, ["sourceInventoryId", "materialDigest"]);
  return record !== null && fieldsAreStrings(record, ["sourceInventoryId", "materialDigest"]);
};

const reviewScopeShape = (value: JsonValue | undefined): boolean => {
  const record = exactRecordValue(value, [
    "entityRevisions", "factOrRuleIds", "sourceInventoryBindings", "sourceKeys",
    "applicableRegions", "languages",
  ]);
  return record !== null && recordListValue(record["entityRevisions"], entityRevisionShape) &&
    stringListValue(record["factOrRuleIds"]) &&
    recordListValue(record["sourceInventoryBindings"], inventoryBindingShape) &&
    recordListValue(record["sourceKeys"], sourceKeyShape) &&
    stringListValue(record["applicableRegions"]) && stringListValue(record["languages"]);
};

const reviewDecisionShape = (value: JsonValue): boolean => {
  const record = exactRecordValue(value, [
    "reviewDecisionId", "authorityRecordId", "authorityAssignmentRevision",
    "authorityAssignmentDigest", "assignmentAcceptanceDigest", "role", "datasetId",
    "releaseId", "releaseRevision", "releaseContentDigest", "scope", "decision", "decidedAt",
    "evidenceDigest", "independenceEvidenceDigest", "conflictDisclosureDigest",
    "supersedesReviewDecisionId", "revokedAt", "revocationReason",
  ]);
  return record !== null && fieldsAreStrings(record, [
    "reviewDecisionId", "authorityRecordId", "authorityAssignmentDigest",
    "assignmentAcceptanceDigest", "role", "datasetId", "releaseId", "releaseContentDigest",
    "decision", "decidedAt", "evidenceDigest", "independenceEvidenceDigest",
    "conflictDisclosureDigest", "supersedesReviewDecisionId", "revokedAt", "revocationReason",
  ]) && fieldsAreIntegers(record, ["authorityAssignmentRevision", "releaseRevision"]) &&
    reviewScopeShape(record["scope"]);
};

const receiptShape = (value: JsonValue): boolean => {
  const record = exactRecordValue(value, [
    "receiptId", "receiptDigest", "kind", "candidateCommitSha", "datasetId", "releaseId",
    "releaseRevision", "releaseContentDigest", "evaluationTime", "observedAt", "result",
    "reportDigest", "upstreamReceiptDigests",
  ]);
  return record !== null && fieldsAreStrings(record, [
    "receiptId", "receiptDigest", "kind", "candidateCommitSha", "datasetId", "releaseId",
    "releaseContentDigest", "evaluationTime", "observedAt", "result", "reportDigest",
  ]) && fieldsAreIntegers(record, ["releaseRevision"]) &&
    stringListValue(record["upstreamReceiptDigests"]);
};

const decodeM1EvidenceText = (input: unknown): M1ReadinessEvidence | null => {
  if (typeof input !== "string" || input.length > DECODE_LIMITS.maxTextLength) return null;
  try {
    const scalar = decodeJsonScalarClosure(JSON.parse(input) as unknown);
    if (!scalar.ok) return null;
    const record = exactRecordValue(scalar.value, [
      "schemaVersion", "classification", "target", "authorities", "sources",
      "reviewDecisions", "receipts",
    ]);
    if (record === null || !fieldsAreIntegers(record, ["schemaVersion"]) ||
      !fieldsAreStrings(record, ["classification"]) || !targetShape(record["target"]) ||
      !recordListValue(record["authorities"], authorityShape) ||
      !recordListValue(record["sources"], sourceShape) ||
      !recordListValue(record["reviewDecisions"], reviewDecisionShape) ||
      !recordListValue(record["receipts"], receiptShape)) return null;
    return scalar.value as unknown as M1ReadinessEvidence;
  } catch {
    return null;
  }
};

const invalidEvidenceAssessment = Object.freeze({
  status: "BLOCKED" as const,
  primaryReason: "SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT" as const,
  reasons: Object.freeze(["SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT" as const]),
});
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const hasSyntheticPrefix = (value: string): boolean => value.startsWith("syn:");
const hasCanonicalDigest = (value: string): boolean => digestPattern.test(value);
const exactSetEquals = (left: readonly unknown[], right: readonly unknown[]): boolean => {
  const leftValues = left.map(canonicalJson).sort(compareUtf8);
  const rightValues = right.map(canonicalJson).sort(compareUtf8);
  return new Set(leftValues).size === leftValues.length &&
    new Set(rightValues).size === rightValues.length &&
    canonicalJson(leftValues) === canonicalJson(rightValues);
};
const uniqueValues = <T>(values: readonly T[]): readonly T[] => {
  const unique = new Map<string, T>();
  for (const value of values) unique.set(canonicalJson(value), value);
  return Object.freeze([...unique.values()]);
};
const duplicated = (values: readonly string[]): ReadonlySet<string> => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) (seen.has(value) ? duplicates : seen).add(value);
  return duplicates;
};

export const m1SourceInventoryDigest = (source: M1SourceEvidence): string => {
  const { materialDigest: _materialDigest, ...material } = source;
  return canonicalJsonDigest({ domain: "M1_SOURCE_INVENTORY_V1", material });
};

const authorityDigestMaterial = (authority: M1AuthorityEvidence): unknown => {
  const {
    assignmentDigest: _assignmentDigest,
    acceptanceEvidenceDigest: _acceptanceEvidenceDigest,
    ...material
  } = authority;
  return material;
};

export const m1AuthorityAssignmentDigest = (authority: M1AuthorityEvidence): string =>
  canonicalJsonDigest({
    domain: "M1_AUTHORITY_ASSIGNMENT_V1",
    material: authorityDigestMaterial(authority),
  });

export const m1AuthorityAcceptanceDigest = (authority: M1AuthorityEvidence): string =>
  canonicalJsonDigest({
    domain: "M1_AUTHORITY_ACCEPTANCE_V1",
    material: authorityDigestMaterial(authority),
  });

export const m1ReviewDecisionDigests = (
  decision: M1ReviewDecisionEvidence,
  authority: M1AuthorityEvidence,
): Readonly<{
  evidenceDigest: string;
  independenceEvidenceDigest: string;
  conflictDisclosureDigest: string;
}> => {
  const {
    evidenceDigest: _evidenceDigest,
    independenceEvidenceDigest: _independenceEvidenceDigest,
    conflictDisclosureDigest: _conflictDisclosureDigest,
    ...material
  } = decision;
  return Object.freeze({
    evidenceDigest: canonicalJsonDigest({ domain: "M1_REVIEW_DECISION_V1", material }),
    independenceEvidenceDigest: canonicalJsonDigest({
      domain: "M1_REVIEW_INDEPENDENCE_V1",
      reviewDecisionId: decision.reviewDecisionId,
      authorityRecordId: authority.authorityRecordId,
      role: authority.role,
      naturalPersonIdentity: authority.naturalPersonIdentity,
      independent: authority.independent,
      independenceDeclaration: authority.independenceDeclaration,
    }),
    conflictDisclosureDigest: canonicalJsonDigest({
      domain: "M1_REVIEW_CONFLICT_V1",
      reviewDecisionId: decision.reviewDecisionId,
      authorityRecordId: authority.authorityRecordId,
      disclosedConflicts: authority.disclosedConflicts,
    }),
  });
};

export const m1ReceiptDigest = (receipt: M1BoundReceipt): string => {
  const { receiptDigest: _receiptDigest, ...material } = receipt;
  return canonicalJsonDigest({ domain: "M1_BOUND_RECEIPT_V1", material });
};

interface M1SourceOccurrence {
  readonly envelope: GovernanceEnvelope;
  readonly reference: GovernanceEnvelope["sourceReferences"][number];
  readonly snapshot: GovernanceEnvelope["sourceSnapshots"][number] | undefined;
}

const occurrenceMatches = (source: M1SourceEvidence, occurrence: M1SourceOccurrence): boolean =>
  source.datasetId === occurrence.envelope.datasetId &&
  source.entityId === occurrence.envelope.entityId &&
  source.entityRevision === occurrence.envelope.entityRevision &&
  source.sourceKey.referenceId === occurrence.reference.referenceId &&
  source.sourceKey.referenceRevision === occurrence.reference.referenceRevision;

const receiptReason = (kind: string): M1ReadinessReason => {
  if (kind === "audit_a" || kind === "audit_b") return "INDEPENDENT_A_B_NOT_CLEAN";
  if (kind === "total_control") return "TOTAL_CONTROL_NOT_ACCEPTED";
  return "READINESS_GATE_FAILED";
};

const receiptTargetMatches = (receipt: M1BoundReceipt, target: M1ReadinessTarget): boolean =>
  receipt.candidateCommitSha === target.candidateCommitSha &&
  receipt.datasetId === target.datasetId && receipt.releaseId === target.releaseId &&
  receipt.releaseRevision === target.releaseRevision &&
  receipt.releaseContentDigest === target.releaseContentDigest &&
  receipt.evaluationTime === target.evaluationTime;

/**
 * S1-only derived gate. Evidence is accepted only as raw JSON text, so hostile objects, accessors,
 * and proxies are rejected before any property/meta-object operation. It never mutates M0 input.
 */
export const assessM1Readiness = (
  catalogInput: unknown,
  evidenceInput: unknown,
): M1ReadinessAssessment => {
  try {
    const evidence = decodeM1EvidenceText(evidenceInput);
    if (evidence === null) return invalidEvidenceAssessment;
    const reasons = new Set<M1ReadinessReason>();
    const add = (reason: M1ReadinessReason): void => void reasons.add(reason);
    const { target, authorities, sources, reviewDecisions: decisions, receipts } = evidence;
    const evaluationTimeValid = canonicalTimestamp(target.evaluationTime);
    if (evidence.schemaVersion !== 1 || evidence.classification !== "fully_synthetic" ||
      !commitPattern.test(target.candidateCommitSha) || !evaluationTimeValid) {
      add("READINESS_GATE_FAILED");
    }

    const analysis = analyzeGovernanceCatalog(catalogInput);
    if (analysis.catalog === null || analysis.issues.length > 0) {
      add("SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT");
    }
    const release = analysis.catalog?.releases.find((candidate) =>
      candidate.releaseId === target.releaseId &&
      candidate.releaseRevision === target.releaseRevision &&
      candidate.contentDigest === target.releaseContentDigest);
    const relevantEnvelopes = (release?.envelopes ?? []).filter(
      (envelope) => envelope.datasetId === target.datasetId,
    );
    if (release === undefined || relevantEnvelopes.length === 0) {
      add("SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT");
    }
    for (const envelope of relevantEnvelopes) {
      const identity = entityIdentityText(envelope);
      const revisions = analysis.catalog?.releases.flatMap((candidate) =>
        candidate.envelopes.filter((item) => entityIdentityText(item) === identity)) ?? [];
      const latestRevision = revisions.length === 0
        ? -1
        : Math.max(...revisions.map(({ entityRevision }) => entityRevision));
      if (envelope.entityRevision !== latestRevision) {
        add("SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT");
      }
      if (envelope.lifecycleStatus === "withdrawn" || envelope.withdrawalState === "withdrawn") {
        add("SOURCE_WITHDRAWN");
      } else if (envelope.lifecycleStatus !== "approved") {
        add("DOMAIN_REVIEW_MISSING_OR_EXPIRED");
      }
      if (!envelope.applicableRegions.includes(target.region)) add("REGION_NOT_APPLICABLE");
      if (!envelope.languages.includes(target.language)) add("LANGUAGE_NOT_APPLICABLE");
      if (!evaluationTimeValid || !canonicalTimestamp(envelope.reviewedAt) ||
        !canonicalTimestamp(envelope.reviewDueAt) || target.evaluationTime < envelope.reviewedAt ||
        target.evaluationTime >= envelope.reviewDueAt) {
        add("DOMAIN_REVIEW_MISSING_OR_EXPIRED");
      }
    }

    const authorityByRole = new Map<string, M1AuthorityEvidence[]>();
    const duplicateAuthorityIds = duplicated(authorities.map(({ authorityRecordId }) => authorityRecordId));
    const duplicateAssignmentDigests = duplicated(authorities.map(({ assignmentDigest }) => assignmentDigest));
    const duplicatePeople = duplicated(authorities.map(({ naturalPersonIdentity }) => naturalPersonIdentity));
    const duplicateAcceptanceDigests = duplicated(
      authorities.map(({ acceptanceEvidenceDigest }) => acceptanceEvidenceDigest),
    );
    const datasetKind = relevantEnvelopes[0]?.datasetKind;
    for (const authority of authorities) {
      const grouped = authorityByRole.get(authority.role) ?? [];
      grouped.push(authority);
      authorityByRole.set(authority.role, grouped);
      if (authority.status === "revoked" || authority.status === "suspended" ||
        !hasSyntheticPrefix(authority.naturalPersonIdentity) ||
        !hasSyntheticPrefix(authority.identityVerificationReference)) {
        add("FORGED_OR_REVOKED_AUTHORITY");
      }
      if (authority.status !== "confirmed" || !m1ReadinessRoles.includes(authority.role) ||
        !["primary", "substitute"].includes(authority.assignmentKind) ||
        !hasSyntheticPrefix(authority.authorityRecordId) || authority.assignmentRevision < 1 ||
        authority.assignmentDigest !== m1AuthorityAssignmentDigest(authority) ||
        authority.acceptanceEvidenceDigest !== m1AuthorityAcceptanceDigest(authority) ||
        !hasSyntheticPrefix(authority.affiliation) ||
        !hasSyntheticPrefix(authority.qualificationReference) ||
        authority.acceptedResponsibilities.length === 0 ||
        authority.acceptedResponsibilities.some((item) => !hasSyntheticPrefix(item)) ||
        !canonicalTimestamp(authority.acceptedAt) ||
        (evaluationTimeValid && authority.acceptedAt > target.evaluationTime) ||
        datasetKind === undefined || !exactSetEquals(authority.dataKinds, [datasetKind]) ||
        !exactSetEquals(authority.jurisdictions, [target.region]) ||
        !exactSetEquals(authority.languages, [target.language]) ||
        (authority.assignmentKind === "substitute" &&
          (!authority.equivalentQualification || !hasSyntheticPrefix(authority.substitutesFor)))) {
        add("UNASSIGNED_OR_UNACCEPTED_AUTHORITY");
      }
      if (!authority.independent || !hasSyntheticPrefix(authority.independenceDeclaration) ||
        authority.disclosedConflicts.length > 0 ||
        duplicateAuthorityIds.has(authority.authorityRecordId) ||
        duplicateAssignmentDigests.has(authority.assignmentDigest) ||
        duplicatePeople.has(authority.naturalPersonIdentity) ||
        duplicateAcceptanceDigests.has(authority.acceptanceEvidenceDigest)) {
        add("CONFLICTED_OR_DUPLICATE_APPROVER");
      }
    }
    for (const role of m1ReadinessRoles) {
      const count = authorityByRole.get(role)?.length ?? 0;
      if (count !== 1) {
        add(count > 1
          ? "CONFLICTED_OR_DUPLICATE_APPROVER"
          : "UNASSIGNED_OR_UNACCEPTED_AUTHORITY");
      }
    }

    const occurrences: M1SourceOccurrence[] = relevantEnvelopes.flatMap((envelope) =>
      envelope.sourceReferences.map((reference) => ({
        envelope,
        reference,
        snapshot: envelope.sourceSnapshots.find((candidate) =>
          candidate.referenceId === reference.referenceId &&
          candidate.referenceRevision === reference.referenceRevision),
      })));
    if (occurrences.length === 0 || sources.length === 0 ||
      occurrences.some((occurrence) => !sources.some((source) => occurrenceMatches(source, occurrence))) ||
      sources.some((source) => !occurrences.some((occurrence) => occurrenceMatches(source, occurrence)))) {
      add("SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT");
    }
    const duplicateInventoryIds = duplicated(sources.map(({ sourceInventoryId }) => sourceInventoryId));
    const duplicateMaterialDigests = duplicated(sources.map(({ materialDigest }) => materialDigest));
    const occurrenceFacts = duplicated(sources.map((source) => canonicalJson({
      datasetId: source.datasetId,
      entityId: source.entityId,
      entityRevision: source.entityRevision,
      sourceKey: source.sourceKey,
      factOrRuleId: source.factOrRuleId,
    })));
    for (const source of sources) {
      const occurrence = occurrences.find((candidate) => occurrenceMatches(source, candidate));
      const { envelope, reference, snapshot } = occurrence ?? {};
      const occurrenceFact = canonicalJson({
        datasetId: source.datasetId,
        entityId: source.entityId,
        entityRevision: source.entityRevision,
        sourceKey: source.sourceKey,
        factOrRuleId: source.factOrRuleId,
      });
      if (envelope === undefined || reference === undefined || snapshot === undefined ||
        source.datasetKind !== envelope.datasetKind || source.releaseId !== release?.releaseId ||
        source.releaseRevision !== release?.releaseRevision ||
        source.releaseContentDigest !== release?.contentDigest ||
        source.snapshotId !== snapshot.snapshotId ||
        source.sourceSnapshotContentDigest !== snapshot.contentDigest ||
        source.sourceLocator !== reference.locator || source.retrievedAt !== snapshot.retrievedAt ||
        source.minimalSnapshot.locator !== reference.locator ||
        source.minimalSnapshot.contentHash !== snapshot.contentDigest ||
        source.minimalSnapshot.capturedAt !== snapshot.retrievedAt ||
        source.minimalSnapshot.hashAlgorithm !== "sha256" ||
        source.minimalSnapshot.byteLength < 1 || source.minimalSnapshot.mediaType.length === 0 ||
        !hasSyntheticPrefix(source.sourceInventoryId) || !hasSyntheticPrefix(source.factOrRuleId) ||
        !hasSyntheticPrefix(source.sourceOrganization) || !hasSyntheticPrefix(source.sourceVersion) ||
        !hasSyntheticPrefix(source.licenseTermsLocator) || !hasSyntheticPrefix(source.rightsHolder) ||
        source.attributionRequirements.length === 0 ||
        source.attributionRequirements.some((item) => !hasSyntheticPrefix(item)) ||
        source.reviewEvidenceReferences.length === 0 ||
        source.reviewEvidenceReferences.some((item) => !hasSyntheticPrefix(item)) ||
        source.candidateSourceTier !== envelope?.sourceTier || source.candidateSourceTier === "L4" ||
        !canonicalTimestamp(source.publicationDate) ||
        source.publicationDate > source.retrievedAt ||
        source.materialDigest !== m1SourceInventoryDigest(source) ||
        duplicateInventoryIds.has(source.sourceInventoryId) ||
        duplicateMaterialDigests.has(source.materialDigest) || occurrenceFacts.has(occurrenceFact)) {
        add("SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT");
      }
      const monitoring = source.withdrawalMonitoring;
      if (monitoring.state !== "current" || !m1ReadinessRoles.includes(monitoring.accountableRole) ||
        !hasSyntheticPrefix(monitoring.method) || !hasSyntheticPrefix(monitoring.cadence) ||
        !hasSyntheticPrefix(monitoring.evidenceReference) ||
        !canonicalTimestamp(monitoring.lastCheckedAt) || !canonicalTimestamp(monitoring.nextDueAt) ||
        !evaluationTimeValid || monitoring.lastCheckedAt > target.evaluationTime ||
        monitoring.nextDueAt <= target.evaluationTime) {
        add("SOURCE_WITHDRAWN");
      }
      if (source.licenseStatus !== "approved" || source.licenseReviewStatus !== "approved" ||
        source.copyConclusion !== "permitted" ||
        source.transformationConclusion !== "permitted" ||
        source.redistributionConclusion !== "permitted") {
        add("LICENSE_NOT_APPROVED");
      }
      if (!source.applicableRegions.includes(target.region)) add("REGION_NOT_APPLICABLE");
      if (source.sourceLanguage !== target.language) add("LANGUAGE_NOT_APPLICABLE");
      if (source.provenanceReviewStatus !== "approved" || source.domainReviewStatus !== "approved") {
        add("DOMAIN_REVIEW_MISSING_OR_EXPIRED");
      }
    }

    const expectedEntityRevisions = uniqueValues(relevantEnvelopes.map(
      ({ entityId, entityRevision }) => ({ entityId, entityRevision }),
    ));
    const expectedFacts = uniqueValues(sources.map(({ factOrRuleId }) => factOrRuleId));
    const expectedInventoryBindings = uniqueValues(sources.map(
      ({ sourceInventoryId, materialDigest }) => ({ sourceInventoryId, materialDigest }),
    ));
    const expectedSourceKeys = uniqueValues(occurrences.map(({ reference }) => ({
      referenceId: reference.referenceId,
      referenceRevision: reference.referenceRevision,
    })));
    const duplicateDecisionIds = duplicated(decisions.map(({ reviewDecisionId }) => reviewDecisionId));
    const duplicateEvidenceDigests = duplicated(decisions.map(({ evidenceDigest }) => evidenceDigest));
    const duplicateIndependenceDigests = duplicated(
      decisions.map(({ independenceEvidenceDigest }) => independenceEvidenceDigest),
    );
    const duplicateConflictDigests = duplicated(
      decisions.map(({ conflictDisclosureDigest }) => conflictDisclosureDigest),
    );
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
      if (duplicateDecisionIds.has(decision.reviewDecisionId) ||
        duplicateEvidenceDigests.has(decision.evidenceDigest) ||
        duplicateIndependenceDigests.has(decision.independenceEvidenceDigest) ||
        duplicateConflictDigests.has(decision.conflictDisclosureDigest)) {
        add("CONFLICTED_OR_DUPLICATE_APPROVER");
      }
      const expectedDigests = authority === undefined
        ? null
        : m1ReviewDecisionDigests(decision, authority);
      if (authority === undefined || decision.authorityRecordId !== authority.authorityRecordId ||
        decision.authorityAssignmentRevision !== authority.assignmentRevision ||
        decision.authorityAssignmentDigest !== authority.assignmentDigest ||
        decision.assignmentAcceptanceDigest !== authority.acceptanceEvidenceDigest ||
        decision.datasetId !== target.datasetId || decision.releaseId !== target.releaseId ||
        decision.releaseRevision !== target.releaseRevision ||
        decision.releaseContentDigest !== target.releaseContentDigest ||
        decision.decision !== "approve" || !canonicalTimestamp(decision.decidedAt) ||
        !evaluationTimeValid || decision.decidedAt > target.evaluationTime ||
        decision.decidedAt < authority.acceptedAt ||
        sources.some((source) => decision.decidedAt < source.publicationDate ||
          decision.decidedAt < source.retrievedAt) ||
        decision.revokedAt.length > 0 || decision.revocationReason.length > 0 ||
        decision.supersedesReviewDecisionId.length > 0 ||
        !hasSyntheticPrefix(decision.reviewDecisionId) || expectedDigests === null ||
        decision.evidenceDigest !== expectedDigests.evidenceDigest ||
        decision.independenceEvidenceDigest !== expectedDigests.independenceEvidenceDigest ||
        decision.conflictDisclosureDigest !== expectedDigests.conflictDisclosureDigest ||
        !exactSetEquals(decision.scope.entityRevisions, expectedEntityRevisions) ||
        !exactSetEquals(decision.scope.factOrRuleIds, expectedFacts) ||
        !exactSetEquals(decision.scope.sourceInventoryBindings, expectedInventoryBindings) ||
        !exactSetEquals(decision.scope.sourceKeys, expectedSourceKeys) ||
        !exactSetEquals(decision.scope.applicableRegions, [target.region]) ||
        !exactSetEquals(decision.scope.languages, [target.language])) {
        add("DOMAIN_REVIEW_MISSING_OR_EXPIRED");
      }
    }

    const receiptGroups = new Map<string, M1BoundReceipt[]>();
    for (const receipt of receipts) {
      const grouped = receiptGroups.get(receipt.kind) ?? [];
      grouped.push(receipt);
      receiptGroups.set(receipt.kind, grouped);
    }
    const duplicateReceiptIds = duplicated(receipts.map(({ receiptId }) => receiptId));
    const duplicateReceiptDigests = duplicated(receipts.map(({ receiptDigest }) => receiptDigest));
    const duplicateReportDigests = duplicated(receipts.map(({ reportDigest }) => reportDigest));
    for (const kind of m1ReceiptKinds) {
      const grouped = receiptGroups.get(kind) ?? [];
      if (grouped.length !== 1) add(receiptReason(kind));
    }
    const evaluationReceipt = receiptGroups.get("evaluation_time")?.[0];
    const readinessReceipt = receiptGroups.get("readiness_gate")?.[0];
    const auditAReceipt = receiptGroups.get("audit_a")?.[0];
    const auditBReceipt = receiptGroups.get("audit_b")?.[0];
    const totalControlReceipt = receiptGroups.get("total_control")?.[0];
    const expectedResults = new Map<string, string>([
      ["evaluation_time", "BOUND"], ["readiness_gate", "PASS"],
      ["audit_a", "CLEAN"], ["audit_b", "CLEAN"], ["total_control", "ACCEPTED"],
    ]);
    const expectedUpstreams = new Map<string, readonly string[]>([
      ["evaluation_time", []],
      ["readiness_gate", evaluationReceipt === undefined ? [] : [evaluationReceipt.receiptDigest]],
      ["audit_a", readinessReceipt === undefined ? [] : [readinessReceipt.receiptDigest]],
      ["audit_b", readinessReceipt === undefined ? [] : [readinessReceipt.receiptDigest]],
      ["total_control", [evaluationReceipt, readinessReceipt, auditAReceipt, auditBReceipt]
        .filter((receipt): receipt is M1BoundReceipt => receipt !== undefined)
        .map(({ receiptDigest }) => receiptDigest)],
    ]);
    for (const receipt of receipts) {
      const knownKind = m1ReceiptKinds.includes(receipt.kind);
      const reason = receiptReason(receipt.kind);
      if (!knownKind || !receiptTargetMatches(receipt, target) ||
        !hasSyntheticPrefix(receipt.receiptId) || !hasCanonicalDigest(receipt.reportDigest) ||
        receipt.receiptDigest !== m1ReceiptDigest(receipt) ||
        duplicateReceiptIds.has(receipt.receiptId) ||
        duplicateReceiptDigests.has(receipt.receiptDigest) ||
        duplicateReportDigests.has(receipt.reportDigest) ||
        !canonicalTimestamp(receipt.observedAt) || !evaluationTimeValid ||
        receipt.observedAt > target.evaluationTime ||
        receipt.result !== expectedResults.get(receipt.kind) ||
        !exactSetEquals(receipt.upstreamReceiptDigests, expectedUpstreams.get(receipt.kind) ?? [])) {
        add(reason);
      }
    }
    if (evaluationReceipt === undefined || evaluationReceipt.observedAt !== target.evaluationTime) {
      add("READINESS_GATE_FAILED");
    }
    if (readinessReceipt !== undefined && auditAReceipt !== undefined &&
      readinessReceipt.observedAt > auditAReceipt.observedAt) add("INDEPENDENT_A_B_NOT_CLEAN");
    if (readinessReceipt !== undefined && auditBReceipt !== undefined &&
      readinessReceipt.observedAt > auditBReceipt.observedAt) add("INDEPENDENT_A_B_NOT_CLEAN");
    if (totalControlReceipt !== undefined &&
      ((auditAReceipt !== undefined && auditAReceipt.observedAt > totalControlReceipt.observedAt) ||
        (auditBReceipt !== undefined && auditBReceipt.observedAt > totalControlReceipt.observedAt))) {
      add("TOTAL_CONTROL_NOT_ACCEPTED");
    }

    const ordered = Object.freeze(m1ReadinessReasons.filter((reason) => reasons.has(reason)));
    return Object.freeze({
      status: ordered.length === 0 ? "ACTIVATION_ELIGIBLE" : "BLOCKED",
      primaryReason: ordered[0] ?? null,
      reasons: ordered,
    });
  } catch {
    return invalidEvidenceAssessment;
  }
};
