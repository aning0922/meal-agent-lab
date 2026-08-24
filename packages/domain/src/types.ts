export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const datasetKinds = [
  "food_concept",
  "allergen",
  "religious_ethical",
  "food_safety",
  "cooking_technique",
] as const;
export const sourceTiers = ["L1", "L2", "L3", "L4"] as const;
export const licenseStatuses = ["approved", "restricted", "pending", "rejected"] as const;
export const lifecycleStatuses = [
  "draft",
  "under_review",
  "approved",
  "active",
  "superseded",
  "withdrawn",
] as const;
export const withdrawalStates = ["not_withdrawn", "withdrawn"] as const;

export type DatasetKind = (typeof datasetKinds)[number];
export type SourceTier = (typeof sourceTiers)[number];
export type LicenseStatus = (typeof licenseStatuses)[number];
export type LifecycleStatus = (typeof lifecycleStatuses)[number];
export type WithdrawalState = (typeof withdrawalStates)[number];

export interface GovernanceActor {
  readonly actorId: string;
  readonly role: string;
}
export interface SourceReference {
  readonly referenceId: string;
  readonly referenceRevision: string;
  readonly locator: string;
}
export interface SourceSnapshot {
  readonly snapshotId: string;
  readonly referenceId: string;
  readonly referenceRevision: string;
  readonly contentDigest: string;
  readonly retrievedAt: string;
}
export interface GovernanceAlias {
  readonly value: string;
  readonly region: string;
  readonly language: string;
  readonly sourceReferenceId: string;
  readonly sourceReferenceRevision: string;
}
export interface GovernedReference {
  readonly datasetId: string;
  readonly entityId: string;
  readonly entityRevision: number;
}
export interface SyntheticEvidence {
  readonly classification: "fully_synthetic";
  readonly generator: "stage09p-m0-fixture-v1";
  readonly containsRealUserData: false;
  readonly containsRealFoodFacts: false;
  readonly purpose: "governance-format-and-fail-closed-testing-only";
}

/** Internal domain value; never an HTTP DTO, database row, or persistence interface. */
export interface GovernanceEnvelope<TContent extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly datasetKind: DatasetKind;
  readonly releaseId: string;
  readonly releaseRevision: number;
  readonly contentDigest: string;
  readonly entityId: string;
  readonly entityRevision: number;
  readonly lifecycleStatus: LifecycleStatus;
  readonly owner: GovernanceActor;
  readonly approvers: readonly GovernanceActor[];
  readonly sourceTier: SourceTier;
  readonly sourceReferences: readonly SourceReference[];
  readonly sourceSnapshots: readonly SourceSnapshot[];
  readonly applicableRegions: readonly string[];
  readonly languages: readonly string[];
  readonly licenseStatus: LicenseStatus;
  readonly licenseReference: string | null;
  readonly retrievedAt: string;
  readonly reviewedAt: string;
  readonly reviewDueAt: string;
  readonly aliases: readonly GovernanceAlias[];
  readonly supersededBy: GovernedReference | null;
  readonly withdrawalState: WithdrawalState;
  readonly withdrawalReason: string | null;
  readonly withdrawnAt: string | null;
  readonly content: TContent;
  readonly syntheticEvidence?: SyntheticEvidence;
}
export interface GovernanceRelease {
  readonly $schema?: string;
  readonly envelopes: readonly GovernanceEnvelope[];
}
export interface HardMapping {
  readonly mappingId: string;
  readonly source: GovernedReference;
  readonly target: GovernedReference;
  readonly required: boolean;
}
export interface GovernanceCatalog {
  readonly releases: readonly GovernanceRelease[];
  readonly hardMappings: readonly HardMapping[];
}

declare const decodedReleaseBrand: unique symbol;
declare const decodedCatalogBrand: unique symbol;
declare const validatedCatalogBrand: unique symbol;
export type DecodedGovernanceRelease = GovernanceRelease & {
  readonly [decodedReleaseBrand]: true;
};
export type DecodedGovernanceCatalog = GovernanceCatalog & {
  readonly releases: readonly DecodedGovernanceRelease[];
  readonly [decodedCatalogBrand]: true;
};
/** Created only by full catalog validation; resolver authenticity is also checked at runtime. */
export interface ValidatedCatalogIndex {
  readonly releases: readonly DecodedGovernanceRelease[];
  readonly hardMappings: readonly HardMapping[];
  readonly envelopes: readonly GovernanceEnvelope[];
  readonly [validatedCatalogBrand]: true;
}

export const mappingStatuses = [
  "mapped",
  "unmapped",
  "withdrawn",
  "version_mismatch",
  "unapproved",
] as const;
export type MappingStatus = (typeof mappingStatuses)[number];
export type MappingResolution =
  | { readonly status: "mapped"; readonly envelope: GovernanceEnvelope }
  | {
      readonly status: Exclude<MappingStatus, "mapped">;
      readonly reference: GovernedReference;
    };

export type ValidationIssueCode =
  | "INVALID_SHAPE"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INCONSISTENT_RELEASE"
  | "INVALID_REVISION"
  | "MISSING_OWNER"
  | "MISSING_APPROVER"
  | "MISSING_SOURCE"
  | "UNAPPROVED_SOURCE"
  | "SOURCE_SNAPSHOT_MISMATCH"
  | "MISSING_LICENSE"
  | "MISSING_REGION"
  | "MISSING_LANGUAGE"
  | "INVALID_LIFECYCLE"
  | "ALIAS_CONFLICT"
  | "REUSED_ENTITY_ID"
  | "DUPLICATE_ENTITY_REVISION"
  | "DUPLICATE_RELEASE"
  | "RELEASE_DIGEST_MISMATCH"
  | "UNKNOWN_REVISION"
  | "WITHDRAWN_REFERENCE"
  | "HARD_MAPPING_UNRESOLVED";
export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly path: string;
}
export type ValidationResult =
  | { readonly ok: true; readonly issues: readonly [] }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
export type ReleaseValidationResult =
  | { readonly ok: true; readonly issues: readonly []; readonly release: DecodedGovernanceRelease }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
export type CatalogValidationResult =
  | { readonly ok: true; readonly issues: readonly []; readonly catalog: ValidatedCatalogIndex }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: { readonly code: "INVALID_SHAPE"; readonly path: string } };
