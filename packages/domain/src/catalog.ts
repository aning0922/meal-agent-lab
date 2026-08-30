import { canonicalJson } from "./canonical.js";
import type {
  GovernanceEnvelope,
  GovernedReference,
  JsonValue,
  MappingReview,
  OfficialSourceEvidence,
  ReleaseBinding,
  SourceReference,
  SourceSnapshot,
  SourceVersionWindow,
} from "./types.js";

export interface SourceKey {
  readonly referenceId: string;
  readonly referenceRevision: string;
}

export interface ForwardSourceMaterial {
  readonly locator: string;
  readonly snapshotId: string;
  readonly contentDigest: string;
  readonly retrievedAt: string;
}

export interface ReverseSnapshotMaterial {
  readonly referenceId: string;
  readonly referenceRevision: string;
  readonly locator: string;
  readonly contentDigest: string;
  readonly retrievedAt: string;
}

export type CanonicalEntityHistoryMaterial = Omit<
  GovernanceEnvelope,
  "syntheticEvidence" | "officialEvidence"
>;

export interface CanonicalOfficialEntityHistoryMaterial {
  readonly datasetId: string;
  readonly entityId: string;
  readonly entityRevision: number;
  readonly officialEvidence: OfficialSourceEvidence;
}

export interface CanonicalRelationHistoryMaterial {
  readonly mappingId: string;
  readonly reviewRevision: number;
  readonly sourceBindingId: string;
  readonly targetBindingId: string;
  readonly source: GovernedReference;
  readonly target: GovernedReference;
  readonly required: boolean;
  readonly reviewStatus: MappingReview["reviewStatus"];
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly sourceBinding: ReleaseBinding | null;
  readonly targetBinding: ReleaseBinding | null;
  readonly sourceWindows: readonly SourceVersionWindow[];
  readonly targetWindows: readonly SourceVersionWindow[];
}

export const sourceKey = (source: SourceReference | SourceSnapshot): SourceKey =>
  Object.freeze({
    referenceId: source.referenceId,
    referenceRevision: source.referenceRevision,
  });

export const sourceKeyText = (source: SourceReference | SourceSnapshot): string =>
  canonicalJson(sourceKey(source));

export const forwardSourceMaterial = (
  reference: SourceReference,
  snapshot: SourceSnapshot,
): ForwardSourceMaterial =>
  Object.freeze({
    locator: reference.locator,
    snapshotId: snapshot.snapshotId,
    contentDigest: snapshot.contentDigest,
    retrievedAt: snapshot.retrievedAt,
  });

export const reverseSnapshotMaterial = (
  snapshot: SourceSnapshot,
): ReverseSnapshotMaterial =>
  Object.freeze({
    referenceId: snapshot.referenceId,
    referenceRevision: snapshot.referenceRevision,
    locator: snapshot.locator,
    contentDigest: snapshot.contentDigest,
    retrievedAt: snapshot.retrievedAt,
  });

export const canonicalEntityHistoryMaterial = (
  envelope: GovernanceEnvelope,
): CanonicalEntityHistoryMaterial =>
  Object.freeze({
    schemaVersion: envelope.schemaVersion,
    datasetId: envelope.datasetId,
    datasetKind: envelope.datasetKind,
    entityId: envelope.entityId,
    entityRevision: envelope.entityRevision,
    lifecycleStatus: envelope.lifecycleStatus,
    owner: envelope.owner,
    approvers: envelope.approvers,
    sourceTier: envelope.sourceTier,
    sourceReferences: envelope.sourceReferences,
    sourceSnapshots: envelope.sourceSnapshots,
    applicableRegions: envelope.applicableRegions,
    languages: envelope.languages,
    licenseStatus: envelope.licenseStatus,
    licenseReference: envelope.licenseReference,
    retrievedAt: envelope.retrievedAt,
    reviewedAt: envelope.reviewedAt,
    reviewDueAt: envelope.reviewDueAt,
    aliases: envelope.aliases,
    supersededBy: envelope.supersededBy,
    withdrawalState: envelope.withdrawalState,
    withdrawalReason: envelope.withdrawalReason,
    withdrawnAt: envelope.withdrawnAt,
    content: envelope.content,
  });

export const canonicalEntityHistoryText = (envelope: GovernanceEnvelope): string =>
  canonicalJson(canonicalEntityHistoryMaterial(envelope) as unknown as JsonValue);

export const canonicalOfficialEntityHistoryMaterial = (
  envelope: GovernanceEnvelope,
): CanonicalOfficialEntityHistoryMaterial => {
  if (envelope.officialEvidence === undefined) {
    throw new TypeError("INVALID_OFFICIAL_EVIDENCE");
  }
  return Object.freeze({
    datasetId: envelope.datasetId,
    entityId: envelope.entityId,
    entityRevision: envelope.entityRevision,
    officialEvidence: envelope.officialEvidence,
  });
};

export const canonicalOfficialEntityHistoryText = (
  envelope: GovernanceEnvelope,
): string => canonicalJson(canonicalOfficialEntityHistoryMaterial(envelope));

export const canonicalRelationHistoryMaterial = (
  review: MappingReview,
  sourceBinding: ReleaseBinding | null,
  targetBinding: ReleaseBinding | null,
  sourceWindows: readonly SourceVersionWindow[],
  targetWindows: readonly SourceVersionWindow[],
): CanonicalRelationHistoryMaterial =>
  Object.freeze({
    mappingId: review.mappingId,
    reviewRevision: review.reviewRevision,
    sourceBindingId: review.sourceBindingId,
    targetBindingId: review.targetBindingId,
    source: review.source,
    target: review.target,
    required: review.required,
    reviewStatus: review.reviewStatus,
    effectiveFrom: review.effectiveFrom,
    effectiveUntil: review.effectiveUntil,
    sourceBinding,
    targetBinding,
    sourceWindows: Object.freeze([...sourceWindows]),
    targetWindows: Object.freeze([...targetWindows]),
  });

export const canonicalRelationHistoryText = (
  review: MappingReview,
  sourceBinding: ReleaseBinding | null,
  targetBinding: ReleaseBinding | null,
  sourceWindows: readonly SourceVersionWindow[],
  targetWindows: readonly SourceVersionWindow[],
): string =>
  canonicalJson(
    canonicalRelationHistoryMaterial(
      review,
      sourceBinding,
      targetBinding,
      sourceWindows,
      targetWindows,
    ),
  );

export const entityIdentityText = (
  value: Pick<GovernanceEnvelope | GovernedReference, "datasetId" | "entityId">,
): string => canonicalJson({ datasetId: value.datasetId, entityId: value.entityId });

export const governedReferenceText = (reference: GovernedReference): string =>
  canonicalJson({
    datasetId: reference.datasetId,
    entityId: reference.entityId,
    entityRevision: reference.entityRevision,
  });
