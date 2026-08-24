import { canonicalJson, canonicalReleaseDigest, compareUtf8 } from "./canonical.js";
import { createValidatedCatalogIndex, resolveValidatedReference } from "./catalog.js";
import { decodeGovernanceCatalog, decodeGovernanceRelease } from "./decode.js";
import type {
  CatalogValidationResult,
  DecodedGovernanceCatalog,
  DecodedGovernanceRelease,
  GovernanceAlias,
  GovernanceEnvelope,
  ReleaseValidationResult,
  ValidationIssue,
  ValidationIssueCode,
} from "./types.js";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ambiguousControl = /[\u0000-\u001F\u007F-\u009F]/u;

const issue = (code: ValidationIssueCode, path: string): ValidationIssue => ({ code, path });
const keyOf = (values: readonly (string | number)[]): string => canonicalJson(values);

const sortedIssues = (issues: ValidationIssue[]): readonly ValidationIssue[] => {
  const unique = new Map<string, ValidationIssue>();
  for (const item of issues) unique.set(keyOf([item.path, item.code]), item);
  return [...unique.values()].sort((left, right) => {
    const pathOrder = compareUtf8(left.path, right.path);
    return pathOrder === 0 ? compareUtf8(left.code, right.code) : pathOrder;
  });
};

const isCanonicalInstant = (value: string): boolean => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  try {
    return new Date(milliseconds).toISOString() === value;
  } catch {
    return false;
  }
};

const normalizeAlias = (alias: GovernanceAlias): string | null => {
  if (ambiguousControl.test(alias.value)) return null;
  const normalized = alias.value.normalize("NFC").trim().toLowerCase();
  return normalized.length === 0 || ambiguousControl.test(normalized) ? null : normalized;
};

const validateEnvelope = (
  envelope: GovernanceEnvelope,
  index: number,
  issues: ValidationIssue[],
): void => {
  const base = `envelopes/${index}`;
  if (!uuidV7Pattern.test(envelope.entityId)) issues.push(issue("INVALID_SHAPE", `${base}/entityId`));

  if (envelope.owner.actorId.length === 0 || envelope.owner.role.length === 0) {
    issues.push(issue("MISSING_OWNER", `${base}/owner`));
  }
  if (envelope.approvers.length === 0) issues.push(issue("MISSING_APPROVER", `${base}/approvers`));
  const actors = new Set<string>([envelope.owner.actorId]);
  for (const actor of envelope.approvers) {
    if (actors.has(actor.actorId)) issues.push(issue("INVALID_SHAPE", `${base}/approvers`));
    actors.add(actor.actorId);
  }

  if (envelope.sourceReferences.length === 0 || envelope.sourceSnapshots.length === 0) {
    issues.push(issue("MISSING_SOURCE", `${base}/sourceReferences`));
  } else {
    const references = new Set<string>();
    for (const reference of envelope.sourceReferences) {
      const identity = keyOf([reference.referenceId, reference.referenceRevision]);
      if (references.has(identity)) {
        issues.push(issue("SOURCE_SNAPSHOT_MISMATCH", `${base}/sourceReferences`));
      }
      references.add(identity);
    }
    const snapshots = new Set<string>();
    const snapshotIds = new Set<string>();
    for (const snapshot of envelope.sourceSnapshots) {
      const identity = keyOf([snapshot.referenceId, snapshot.referenceRevision]);
      if (
        snapshots.has(identity) ||
        snapshotIds.has(snapshot.snapshotId) ||
        !digestPattern.test(snapshot.contentDigest) ||
        !isCanonicalInstant(snapshot.retrievedAt)
      ) {
        issues.push(issue("SOURCE_SNAPSHOT_MISMATCH", `${base}/sourceSnapshots`));
      }
      snapshots.add(identity);
      snapshotIds.add(snapshot.snapshotId);
    }
    if (
      references.size !== snapshots.size ||
      [...references].some((identity) => !snapshots.has(identity))
    ) {
      issues.push(issue("SOURCE_SNAPSHOT_MISMATCH", `${base}/sourceSnapshots`));
    }
  }
  if (envelope.sourceTier === "L4") {
    issues.push(issue("UNAPPROVED_SOURCE", `${base}/sourceTier`));
  }
  if (envelope.licenseStatus !== "approved" || envelope.licenseReference === null) {
    issues.push(issue("MISSING_LICENSE", `${base}/licenseStatus`));
  }

  if (envelope.applicableRegions.length === 0) {
    issues.push(issue("MISSING_REGION", `${base}/applicableRegions`));
  } else if (new Set(envelope.applicableRegions).size !== envelope.applicableRegions.length) {
    issues.push(issue("INVALID_SHAPE", `${base}/applicableRegions`));
  }
  if (envelope.languages.length === 0) {
    issues.push(issue("MISSING_LANGUAGE", `${base}/languages`));
  } else if (new Set(envelope.languages).size !== envelope.languages.length) {
    issues.push(issue("INVALID_SHAPE", `${base}/languages`));
  }

  if (
    !isCanonicalInstant(envelope.retrievedAt) ||
    !isCanonicalInstant(envelope.reviewedAt) ||
    !isCanonicalInstant(envelope.reviewDueAt) ||
    envelope.retrievedAt > envelope.reviewedAt ||
    envelope.reviewedAt > envelope.reviewDueAt
  ) {
    issues.push(issue("INVALID_SHAPE", `${base}/reviewedAt`));
  }

  const target = envelope.supersededBy;
  const targetShape =
    target !== null &&
    uuidV7Pattern.test(target.entityId) &&
    !(
      target.datasetId === envelope.datasetId &&
      target.entityId === envelope.entityId &&
      target.entityRevision === envelope.entityRevision
    );
  const lifecycleValid =
    (envelope.lifecycleStatus === "withdrawn" &&
      envelope.withdrawalState === "withdrawn" &&
      envelope.withdrawalReason !== null &&
      envelope.withdrawnAt !== null &&
      isCanonicalInstant(envelope.withdrawnAt) &&
      envelope.withdrawnAt >= envelope.reviewedAt &&
      target === null) ||
    (envelope.lifecycleStatus === "superseded" &&
      envelope.withdrawalState === "not_withdrawn" &&
      targetShape &&
      envelope.withdrawalReason === null &&
      envelope.withdrawnAt === null) ||
    (["draft", "under_review", "approved", "active"] as const).includes(
      envelope.lifecycleStatus as "draft",
    ) &&
      envelope.withdrawalState === "not_withdrawn" &&
      target === null &&
      envelope.withdrawalReason === null &&
      envelope.withdrawnAt === null;
  if (!lifecycleValid) issues.push(issue("INVALID_LIFECYCLE", `${base}/lifecycleStatus`));

  const sourceIdentities = new Set(
    envelope.sourceReferences.map((reference) =>
      keyOf([reference.referenceId, reference.referenceRevision]),
    ),
  );
  for (const alias of envelope.aliases) {
    if (
      normalizeAlias(alias) === null ||
      !envelope.applicableRegions.includes(alias.region) ||
      !envelope.languages.includes(alias.language) ||
      !sourceIdentities.has(keyOf([alias.sourceReferenceId, alias.sourceReferenceRevision]))
    ) {
      issues.push(issue("INVALID_SHAPE", `${base}/aliases`));
    }
  }
};

const validateDecodedRelease = (
  release: DecodedGovernanceRelease,
): readonly ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const first = release.envelopes[0];
  if (first === undefined) return [issue("INVALID_SHAPE", "envelopes")];
  const seenIds = new Set<string>();
  const aliases = new Set<string>();
  for (let index = 0; index < release.envelopes.length; index += 1) {
    const envelope = release.envelopes[index] as GovernanceEnvelope;
    validateEnvelope(envelope, index, issues);
    if (
      envelope.datasetId !== first.datasetId ||
      envelope.datasetKind !== first.datasetKind ||
      envelope.releaseId !== first.releaseId ||
      envelope.releaseRevision !== first.releaseRevision ||
      envelope.contentDigest !== first.contentDigest
    ) {
      issues.push(issue("INCONSISTENT_RELEASE", `envelopes/${index}`));
    }
    if (seenIds.has(envelope.entityId)) {
      issues.push(issue("REUSED_ENTITY_ID", `envelopes/${index}/entityId`));
    }
    seenIds.add(envelope.entityId);
    for (const alias of envelope.aliases) {
      const normalized = normalizeAlias(alias);
      if (normalized === null) continue;
      const identity = keyOf([alias.region.normalize("NFC"), alias.language.normalize("NFC"), normalized]);
      if (aliases.has(identity)) issues.push(issue("ALIAS_CONFLICT", `envelopes/${index}/aliases`));
      aliases.add(identity);
    }
  }
  try {
    if (!digestPattern.test(first.contentDigest) || canonicalReleaseDigest(release) !== first.contentDigest) {
      issues.push(issue("RELEASE_DIGEST_MISMATCH", "contentDigest"));
    }
  } catch {
    issues.push(issue("INVALID_SHAPE", "envelopes"));
  }
  return sortedIssues(issues);
};

const decodedFailure = (path: string): ReleaseValidationResult => ({
  ok: false,
  issues: [{ code: "INVALID_SHAPE", path: path.replace(/^release\//, "") }],
});

export const validateGovernanceRelease = (value: unknown): ReleaseValidationResult => {
  const decoded = decodeGovernanceRelease(value);
  if (!decoded.ok) return decodedFailure(decoded.issue.path);
  const issues = validateDecodedRelease(decoded.value);
  return issues.length === 0
    ? { ok: true, issues: [], release: decoded.value }
    : { ok: false, issues };
};

const referenceShape = (reference: { readonly entityId: string }): boolean =>
  uuidV7Pattern.test(reference.entityId);

export const validateGovernanceCatalog = (value: unknown): CatalogValidationResult => {
  const decoded = decodeGovernanceCatalog(value);
  if (!decoded.ok) {
    return { ok: false, issues: [{ code: "INVALID_SHAPE", path: decoded.issue.path }] };
  }
  const catalog: DecodedGovernanceCatalog = decoded.value;
  const issues: ValidationIssue[] = [];
  const releaseIdentities = new Set<string>();
  const releaseIds = new Map<string, string>();
  const entityRevisions = new Set<string>();
  const entityDatasets = new Map<string, string>();

  for (let releaseIndex = 0; releaseIndex < catalog.releases.length; releaseIndex += 1) {
    const release = catalog.releases[releaseIndex] as DecodedGovernanceRelease;
    for (const child of validateDecodedRelease(release)) {
      issues.push(issue(child.code, `releases/${releaseIndex}/${child.path}`));
    }
    const first = release.envelopes[0];
    if (first === undefined) continue;
    const releaseIdentity = keyOf([first.datasetId, first.releaseId, first.releaseRevision]);
    if (releaseIdentities.has(releaseIdentity)) {
      issues.push(issue("DUPLICATE_RELEASE", `releases/${releaseIndex}`));
    }
    releaseIdentities.add(releaseIdentity);
    const releaseDataset = releaseIds.get(first.releaseId);
    if (releaseDataset !== undefined && releaseDataset !== first.datasetId) {
      issues.push(issue("DUPLICATE_RELEASE", `releases/${releaseIndex}`));
    }
    releaseIds.set(first.releaseId, first.datasetId);

    for (const envelope of release.envelopes) {
      const revisionIdentity = keyOf([
        envelope.datasetId,
        envelope.entityId,
        envelope.entityRevision,
      ]);
      if (entityRevisions.has(revisionIdentity)) {
        issues.push(issue("DUPLICATE_ENTITY_REVISION", `releases/${releaseIndex}/entityRevision`));
      }
      entityRevisions.add(revisionIdentity);
      const dataset = entityDatasets.get(envelope.entityId);
      if (dataset !== undefined && dataset !== envelope.datasetId) {
        issues.push(issue("REUSED_ENTITY_ID", `releases/${releaseIndex}/entityId`));
      }
      entityDatasets.set(envelope.entityId, envelope.datasetId);
    }
  }

  const mappingIds = new Set<string>();
  for (let index = 0; index < catalog.hardMappings.length; index += 1) {
    const mapping = catalog.hardMappings[index];
    if (mapping === undefined) continue;
    if (mappingIds.has(mapping.mappingId)) issues.push(issue("INVALID_SHAPE", `hardMappings/${index}/mappingId`));
    mappingIds.add(mapping.mappingId);
    if (!referenceShape(mapping.source) || !referenceShape(mapping.target)) {
      issues.push(issue("INVALID_SHAPE", `hardMappings/${index}`));
    }
  }

  if (issues.length === 0) {
    const index = createValidatedCatalogIndex(catalog);
    for (let releaseIndex = 0; releaseIndex < catalog.releases.length; releaseIndex += 1) {
      for (const envelope of catalog.releases[releaseIndex]?.envelopes ?? []) {
        if (envelope.lifecycleStatus !== "superseded" || envelope.supersededBy === null) continue;
        if (resolveValidatedReference(index, envelope.supersededBy).status !== "mapped") {
          issues.push(issue("INVALID_LIFECYCLE", `releases/${releaseIndex}/supersededBy`));
        }
      }
    }
    for (let mappingIndex = 0; mappingIndex < catalog.hardMappings.length; mappingIndex += 1) {
      const mapping = catalog.hardMappings[mappingIndex];
      if (mapping === undefined || !mapping.required) continue;
      const source = resolveValidatedReference(index, mapping.source);
      const target = resolveValidatedReference(index, mapping.target);
      if (source.status !== "mapped") {
        issues.push(issue("HARD_MAPPING_UNRESOLVED", `hardMappings/${mappingIndex}/source`));
      } else if (target.status === "version_mismatch") {
        issues.push(issue("UNKNOWN_REVISION", `hardMappings/${mappingIndex}/target`));
      } else if (target.status === "withdrawn") {
        issues.push(issue("WITHDRAWN_REFERENCE", `hardMappings/${mappingIndex}/target`));
      } else if (target.status !== "mapped") {
        issues.push(issue("HARD_MAPPING_UNRESOLVED", `hardMappings/${mappingIndex}/target`));
      }
    }
    if (issues.length === 0) return { ok: true, issues: [], catalog: index };
  }
  return { ok: false, issues: sortedIssues(issues) };
};
