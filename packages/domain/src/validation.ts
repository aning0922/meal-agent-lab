import { canonicalReleaseDigest, compareUtf8 } from "./canonical.js";
import {
  datasetKinds,
  type GovernanceAlias,
  type GovernanceCatalog,
  type GovernanceEnvelope,
  type GovernanceRelease,
  type ValidationIssue,
  type ValidationIssueCode,
  type ValidationResult,
} from "./types.js";
import { resolveGovernedReference } from "./resolution.js";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isPositiveRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const actorShape = (value: unknown): boolean =>
  isRecord(value) && isNonEmptyString(value["actorId"]) && isNonEmptyString(value["role"]);
const governedReferenceShape = (value: unknown): boolean =>
  isRecord(value) &&
  isNonEmptyString(value["datasetId"]) &&
  isNonEmptyString(value["entityId"]) &&
  isPositiveRevision(value["entityRevision"]);
const sourceReferenceShape = (value: unknown): boolean =>
  isRecord(value) &&
  isNonEmptyString(value["referenceId"]) &&
  isNonEmptyString(value["referenceRevision"]) &&
  isNonEmptyString(value["locator"]);
const sourceSnapshotShape = (value: unknown): boolean =>
  isRecord(value) &&
  isNonEmptyString(value["snapshotId"]) &&
  isNonEmptyString(value["referenceId"]) &&
  isNonEmptyString(value["referenceRevision"]) &&
  isNonEmptyString(value["contentDigest"]) &&
  isNonEmptyString(value["retrievedAt"]);
const aliasShape = (value: unknown): boolean =>
  isRecord(value) &&
  isNonEmptyString(value["value"]) &&
  isNonEmptyString(value["region"]) &&
  isNonEmptyString(value["language"]) &&
  isNonEmptyString(value["sourceReferenceId"]);
const syntheticEvidenceShape = (value: unknown): boolean =>
  isRecord(value) &&
  value["classification"] === "fully_synthetic" &&
  value["generator"] === "stage09p-m0-fixture-v1" &&
  value["containsRealUserData"] === false &&
  value["containsRealFoodFacts"] === false &&
  value["purpose"] === "governance-format-and-fail-closed-testing-only";

const issue = (code: ValidationIssueCode, path: string): ValidationIssue => ({ code, path });

const sortedResult = (issues: ValidationIssue[]): ValidationResult => {
  issues.sort((left, right) => {
    const pathOrder = compareUtf8(left.path, right.path);
    return pathOrder === 0 ? compareUtf8(left.code, right.code) : pathOrder;
  });
  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
};

const aliasKey = (alias: GovernanceAlias): string => {
  const canonicalValue = alias.value
    .replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return `${alias.region}\u0000${alias.language}\u0000${canonicalValue}`;
};

const envelopeShape = (value: unknown): value is GovernanceEnvelope => {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value["schemaVersion"]) &&
    isNonEmptyString(value["datasetId"]) &&
    datasetKinds.includes(value["datasetKind"] as never) &&
    isNonEmptyString(value["releaseId"]) &&
    Number.isSafeInteger(value["releaseRevision"]) &&
    isNonEmptyString(value["contentDigest"]) &&
    isNonEmptyString(value["entityId"]) &&
    Number.isSafeInteger(value["entityRevision"]) &&
    ["draft", "under_review", "approved", "active", "superseded", "withdrawn"].includes(
      value["lifecycleStatus"] as string,
    ) &&
    actorShape(value["owner"]) &&
    Array.isArray(value["approvers"]) && value["approvers"].every(actorShape) &&
    ["L1", "L2", "L3", "L4"].includes(value["sourceTier"] as string) &&
    Array.isArray(value["sourceReferences"]) && value["sourceReferences"].every(sourceReferenceShape) &&
    Array.isArray(value["sourceSnapshots"]) && value["sourceSnapshots"].every(sourceSnapshotShape) &&
    isStringArray(value["applicableRegions"]) &&
    isStringArray(value["languages"]) &&
    ["approved", "restricted", "pending", "rejected"].includes(value["licenseStatus"] as string) &&
    isNullableString(value["licenseReference"]) &&
    isNonEmptyString(value["retrievedAt"]) &&
    isNonEmptyString(value["reviewedAt"]) &&
    isNonEmptyString(value["reviewDueAt"]) &&
    Array.isArray(value["aliases"]) && value["aliases"].every(aliasShape) &&
    (value["supersededBy"] === null || governedReferenceShape(value["supersededBy"])) &&
    ["not_withdrawn", "withdrawn"].includes(value["withdrawalState"] as string) &&
    isNullableString(value["withdrawalReason"]) &&
    isNullableString(value["withdrawnAt"]) &&
    Object.hasOwn(value, "content") &&
    (!Object.hasOwn(value, "syntheticEvidence") || syntheticEvidenceShape(value["syntheticEvidence"]))
  );
};

const validateEnvelope = (
  envelope: GovernanceEnvelope,
  index: number,
  issues: ValidationIssue[],
): void => {
  const base = `envelopes/${index}`;
  if (envelope.schemaVersion !== 1) issues.push(issue("UNSUPPORTED_SCHEMA_VERSION", `${base}/schemaVersion`));
  if (!isPositiveRevision(envelope.releaseRevision) || !isPositiveRevision(envelope.entityRevision)) {
    issues.push(issue("INVALID_REVISION", base));
  }
  if (!uuidV7Pattern.test(envelope.entityId)) issues.push(issue("INVALID_SHAPE", `${base}/entityId`));
  if (!isNonEmptyString(envelope.owner.actorId) || !isNonEmptyString(envelope.owner.role)) {
    issues.push(issue("MISSING_OWNER", `${base}/owner`));
  }
  if (
    envelope.approvers.length === 0 ||
    envelope.approvers.some(
      (actor) => !isNonEmptyString(actor?.actorId) || !isNonEmptyString(actor?.role),
    )
  ) {
    issues.push(issue("MISSING_APPROVER", `${base}/approvers`));
  }
  if (
    new Set(envelope.approvers.map(({ actorId }) => actorId)).size !== envelope.approvers.length ||
    envelope.approvers.some(({ actorId }) => actorId === envelope.owner.actorId)
  ) {
    issues.push(issue("INVALID_SHAPE", `${base}/approvers`));
  }
  if (envelope.sourceReferences.length === 0 || envelope.sourceSnapshots.length === 0) {
    issues.push(issue("MISSING_SOURCE", `${base}/sourceReferences`));
  } else {
    const references = new Set(
      envelope.sourceReferences.map(({ referenceId, referenceRevision }) =>
        `${referenceId}\u0000${referenceRevision}`,
      ),
    );
    const snapshots = new Set(
      envelope.sourceSnapshots.map(({ referenceId, referenceRevision }) =>
        `${referenceId}\u0000${referenceRevision}`,
      ),
    );
    if (
      references.size !== envelope.sourceReferences.length ||
      snapshots.size !== envelope.sourceSnapshots.length ||
      references.size !== snapshots.size ||
      [...references].some((key) => !snapshots.has(key)) ||
      envelope.sourceReferences.some(
        (reference) =>
          !isNonEmptyString(reference.referenceId) ||
          !isNonEmptyString(reference.referenceRevision) ||
          !isNonEmptyString(reference.locator),
      ) ||
      envelope.sourceSnapshots.some(
        (snapshot) =>
          !isNonEmptyString(snapshot.snapshotId) ||
          !digestPattern.test(snapshot.contentDigest) ||
          !timestampPattern.test(snapshot.retrievedAt),
      )
    ) {
      issues.push(issue("SOURCE_SNAPSHOT_MISMATCH", `${base}/sourceSnapshots`));
    }
  }
  if (envelope.licenseStatus !== "approved" || !isNonEmptyString(envelope.licenseReference)) {
    issues.push(issue("MISSING_LICENSE", `${base}/licenseStatus`));
  }
  if (!isStringArray(envelope.applicableRegions) || envelope.applicableRegions.length === 0) {
    issues.push(issue("MISSING_REGION", `${base}/applicableRegions`));
  } else if (new Set(envelope.applicableRegions).size !== envelope.applicableRegions.length) {
    issues.push(issue("INVALID_SHAPE", `${base}/applicableRegions`));
  }
  if (!isStringArray(envelope.languages) || envelope.languages.length === 0) {
    issues.push(issue("MISSING_LANGUAGE", `${base}/languages`));
  } else if (new Set(envelope.languages).size !== envelope.languages.length) {
    issues.push(issue("INVALID_SHAPE", `${base}/languages`));
  }
  if (
    !timestampPattern.test(envelope.retrievedAt) ||
    !timestampPattern.test(envelope.reviewedAt) ||
    !timestampPattern.test(envelope.reviewDueAt) ||
    envelope.retrievedAt > envelope.reviewedAt ||
    envelope.reviewedAt > envelope.reviewDueAt
  ) {
    issues.push(issue("INVALID_SHAPE", `${base}/reviewedAt`));
  }

  const lifecycleValid =
    (envelope.lifecycleStatus === "withdrawn" &&
      envelope.withdrawalState === "withdrawn" &&
      isNonEmptyString(envelope.withdrawalReason) &&
      typeof envelope.withdrawnAt === "string" &&
      timestampPattern.test(envelope.withdrawnAt)) ||
    (envelope.lifecycleStatus === "superseded" &&
      envelope.withdrawalState === "not_withdrawn" &&
      envelope.supersededBy !== null &&
      envelope.withdrawalReason === null &&
      envelope.withdrawnAt === null) ||
    (["draft", "under_review", "approved", "active"] as const).includes(
      envelope.lifecycleStatus as "draft",
    ) &&
      envelope.withdrawalState === "not_withdrawn" &&
      envelope.supersededBy === null &&
      envelope.withdrawalReason === null &&
      envelope.withdrawnAt === null;
  if (!lifecycleValid) issues.push(issue("INVALID_LIFECYCLE", `${base}/lifecycleStatus`));

  const sourceIds = new Set(envelope.sourceReferences.map(({ referenceId }) => referenceId));
  if (
    envelope.aliases.some(
      (alias) =>
        !isNonEmptyString(alias?.value) ||
        !envelope.applicableRegions.includes(alias.region) ||
        !envelope.languages.includes(alias.language) ||
        !sourceIds.has(alias.sourceReferenceId),
    )
  ) {
    issues.push(issue("INVALID_SHAPE", `${base}/aliases`));
  }
};

export const validateGovernanceRelease = (value: unknown): ValidationResult => {
  if (!isRecord(value) || !Array.isArray(value["envelopes"]) || value["envelopes"].length === 0) {
    return sortedResult([issue("INVALID_SHAPE", "envelopes")]);
  }
  if (!value["envelopes"].every(envelopeShape)) {
    return sortedResult([issue("INVALID_SHAPE", "envelopes")]);
  }
  const release: GovernanceRelease = { envelopes: value["envelopes"] };
  const issues: ValidationIssue[] = [];
  const first = release.envelopes[0];
  if (first === undefined) return sortedResult([issue("INVALID_SHAPE", "envelopes")]);

  for (const [index, envelope] of release.envelopes.entries()) {
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
  }

  const seenIds = new Set<string>();
  const aliases = new Map<string, string>();
  for (const [index, envelope] of release.envelopes.entries()) {
    if (seenIds.has(envelope.entityId)) {
      issues.push(issue("REUSED_ENTITY_ID", `envelopes/${index}/entityId`));
    }
    seenIds.add(envelope.entityId);
    for (const alias of envelope.aliases) {
      const key = aliasKey(alias);
      const existing = aliases.get(key);
      if (existing !== undefined && existing !== envelope.entityId) {
        issues.push(issue("ALIAS_CONFLICT", `envelopes/${index}/aliases`));
      } else {
        aliases.set(key, envelope.entityId);
      }
    }
  }

  try {
    if (!digestPattern.test(first.contentDigest) || canonicalReleaseDigest(release) !== first.contentDigest) {
      issues.push(issue("RELEASE_DIGEST_MISMATCH", "contentDigest"));
    }
  } catch {
    issues.push(issue("INVALID_SHAPE", "envelopes"));
  }
  return sortedResult(issues);
};

export const validateGovernanceCatalog = (value: unknown): ValidationResult => {
  if (
    !isRecord(value) ||
    !Array.isArray(value["releases"]) ||
    !Array.isArray(value["hardMappings"])
  ) {
    return sortedResult([issue("INVALID_SHAPE", "catalog")]);
  }
  const catalog = value as unknown as GovernanceCatalog;
  const issues: ValidationIssue[] = [];
  const shapedReleases: GovernanceRelease[] = [];
  for (const [index, release] of catalog.releases.entries()) {
    const result = validateGovernanceRelease(release);
    for (const child of result.issues) {
      issues.push(issue(child.code, `releases/${index}/${child.path}`));
    }
    if (
      isRecord(release) &&
      Array.isArray(release["envelopes"]) &&
      release["envelopes"].every(envelopeShape)
    ) {
      shapedReleases.push(release as unknown as GovernanceRelease);
    }
  }

  const seen = new Map<string, string>();
  for (const [releaseIndex, release] of shapedReleases.entries()) {
    for (const envelope of release.envelopes) {
      const existingDataset = seen.get(envelope.entityId);
      if (existingDataset !== undefined && existingDataset !== envelope.datasetId) {
        issues.push(issue("REUSED_ENTITY_ID", `releases/${releaseIndex}/entityId`));
      } else {
        seen.set(envelope.entityId, envelope.datasetId);
      }
    }
  }

  const mappingShape = (mapping: unknown): mapping is GovernanceCatalog["hardMappings"][number] =>
    isRecord(mapping) &&
    isNonEmptyString(mapping["mappingId"]) &&
    governedReferenceShape(mapping["source"]) &&
    governedReferenceShape(mapping["target"]) &&
    typeof mapping["required"] === "boolean";
  if (!catalog.hardMappings.every(mappingShape)) {
    issues.push(issue("INVALID_SHAPE", "hardMappings"));
    return sortedResult(issues);
  }
  const safeCatalog: GovernanceCatalog = {
    releases: shapedReleases,
    hardMappings: catalog.hardMappings,
  };
  for (const [index, mapping] of catalog.hardMappings.entries()) {
    if (!mapping.required) continue;
    const source = resolveGovernedReference(safeCatalog, mapping.source);
    const target = resolveGovernedReference(safeCatalog, mapping.target);
    if (source.status !== "mapped") {
      issues.push(issue("HARD_MAPPING_UNRESOLVED", `hardMappings/${index}/source`));
    } else if (target.status === "version_mismatch") {
      issues.push(issue("UNKNOWN_REVISION", `hardMappings/${index}/target`));
    } else if (target.status === "withdrawn") {
      issues.push(issue("WITHDRAWN_REFERENCE", `hardMappings/${index}/target`));
    } else if (target.status !== "mapped") {
      issues.push(issue("HARD_MAPPING_UNRESOLVED", `hardMappings/${index}/target`));
    }
  }
  return sortedResult(issues);
};
