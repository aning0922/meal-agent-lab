export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

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
  readonly locator: string;
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
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly releaseRevision: number;
  readonly contentDigest: string;
  readonly envelopes: readonly GovernanceEnvelope[];
}

export interface HardMapping {
  readonly mappingId: string;
  readonly source: GovernedReference;
  readonly target: GovernedReference;
  readonly required: boolean;
}

export interface GovernanceCatalog {
  readonly schemaVersion: 1;
  readonly releases: readonly GovernanceRelease[];
  readonly hardMappings: readonly HardMapping[];
}

declare const decodedReleaseBrand: unique symbol;
declare const decodedCatalogBrand: unique symbol;

export type DecodedGovernanceRelease = GovernanceRelease & {
  readonly [decodedReleaseBrand]: true;
};

export type DecodedGovernanceCatalog = Omit<GovernanceCatalog, "releases"> & {
  readonly releases: readonly DecodedGovernanceRelease[];
  readonly [decodedCatalogBrand]: true;
};

export type DecodeIssueCode =
  | "DUPLICATE_KEY"
  | "INVALID_JSON"
  | "INVALID_SCALAR"
  | "INVALID_SHAPE"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "TRAILING_INPUT";

export interface DecodeIssue {
  readonly code: DecodeIssueCode;
  readonly path: string;
}

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: "decode_failed";
      readonly issue: DecodeIssue;
    };

export type ReleaseDigestResult =
  | { readonly ok: true; readonly digest: string }
  | {
      readonly ok: false;
      readonly code: "INVALID_SHAPE" | "RELEASE_DIGEST_MISMATCH";
    };
