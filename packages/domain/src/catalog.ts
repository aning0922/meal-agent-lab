import { canonicalJson } from "./canonical.js";
import type {
  GovernanceEnvelope,
  GovernedReference,
  JsonValue,
  SourceReference,
  SourceSnapshot,
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
  "syntheticEvidence"
>;

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

export const entityIdentityText = (
  value: Pick<GovernanceEnvelope | GovernedReference, "datasetId" | "entityId">,
): string => canonicalJson({ datasetId: value.datasetId, entityId: value.entityId });

export const governedReferenceText = (reference: GovernedReference): string =>
  canonicalJson({
    datasetId: reference.datasetId,
    entityId: reference.entityId,
    entityRevision: reference.entityRevision,
  });
