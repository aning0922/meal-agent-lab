export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const frozenLiterals = <const T extends string[]>(...values: T): Readonly<T> =>
  Object.freeze(values);

export const datasetKinds = frozenLiterals(
  "food_concept",
  "allergen",
  "religious_ethical",
  "food_safety",
  "cooking_technique",
);
export const sourceTiers = frozenLiterals("L1", "L2", "L3", "L4");
export const licenseStatuses = frozenLiterals("approved", "restricted", "pending", "rejected");
export const lifecycleStatuses = frozenLiterals(
  "draft",
  "under_review",
  "approved",
  "active",
  "superseded",
  "withdrawn",
);
export const withdrawalStates = frozenLiterals("not_withdrawn", "withdrawn");

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

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly path: string;
}

export type ValidationIssueCode =
  | "DUPLICATE_ENTITY"
  | "DUPLICATE_HARD_MAPPING"
  | "DUPLICATE_RELEASE"
  | "ENTITY_MISSING_FROM_SNAPSHOT"
  | "ENTITY_REVISION_EQUIVOCATION"
  | "ENTITY_REVISION_REGRESSION"
  | "HARD_MAPPING_SOURCE_UNRESOLVED"
  | "HARD_MAPPING_TARGET_UNRESOLVED"
  | "INVALID_LIFECYCLE_TRANSITION"
  | "INVALID_SHAPE"
  | "INVALID_SUPERSESSION_CYCLE"
  | "INVALID_SUPERSESSION_DATASET"
  | "INVALID_SUPERSESSION_KIND"
  | "INVALID_SUPERSESSION_SELF"
  | "INVALID_SUPERSESSION_TARGET"
  | "INVALID_SUPERSESSION_TARGET_LIFECYCLE"
  | "INVALID_SUPERSESSION_TARGET_REVISION"
  | "INVALID_SYNTHETIC_EVIDENCE"
  | "INVALID_WITHDRAWAL_STATE"
  | "MISSING_APPROVER"
  | "MISSING_LANGUAGE"
  | "MISSING_LICENSE"
  | "MISSING_OWNER"
  | "MISSING_REGION"
  | "MISSING_SOURCE"
  | "RELEASE_DIGEST_MISMATCH"
  | "RELEASE_REVISION_NOT_INCREASING"
  | "SOURCE_REFERENCE_EQUIVOCATION"
  | "SOURCE_SNAPSHOT_ID_EQUIVOCATION"
  | "SOURCE_SNAPSHOT_MISMATCH";

export const m1ReadinessRoles = frozenLiterals(
  "knowledge_data_steward",
  "allergen_safety_data_steward",
  "product_policy_steward",
  "food_safety_steward",
  "culinary_content_steward",
  "domain_owner",
  "product_owner",
  "external_food_safety_reviewer",
  "safety_approver",
  "legal_compliance_license_reviewer",
  "cultural_ethical_reviewer",
  "recipe_qa",
);
export const m1ReadinessReasons = frozenLiterals(
  "FORGED_OR_REVOKED_AUTHORITY",
  "UNASSIGNED_OR_UNACCEPTED_AUTHORITY",
  "CONFLICTED_OR_DUPLICATE_APPROVER",
  "SOURCE_WITHDRAWN",
  "SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT",
  "LICENSE_NOT_APPROVED",
  "REGION_NOT_APPLICABLE",
  "LANGUAGE_NOT_APPLICABLE",
  "DOMAIN_REVIEW_MISSING_OR_EXPIRED",
  "READINESS_GATE_FAILED",
  "INDEPENDENT_A_B_NOT_CLEAN",
  "TOTAL_CONTROL_NOT_ACCEPTED",
);
export type M1ReadinessRole = (typeof m1ReadinessRoles)[number]; export type M1ReadinessReason = (typeof m1ReadinessReasons)[number];
export interface M1AuthorityEvidence {
  readonly authorityRecordId: string;
  readonly assignmentRevision: number;
  readonly assignmentDigest: string;
  readonly role: M1ReadinessRole;
  readonly naturalPersonIdentity: string;
  readonly identityVerified: boolean;
  readonly acceptedResponsibilities: boolean;
  readonly acceptanceEvidenceDigest: string;
  readonly independent: boolean;
  readonly disclosedConflicts: readonly string[];
  readonly assignmentKind: "primary" | "substitute";
  readonly substitutesFor: string;
  readonly equivalentQualification: boolean;
  readonly status: "confirmed" | "pending_external_confirmation" | "revoked" | "unassigned";
}
export interface M1SourceEvidence {
  readonly sourceInventoryId: string;
  readonly datasetId: string;
  readonly releaseId: string;
  readonly releaseRevision: number;
  readonly releaseContentDigest: string;
  readonly entityId: string;
  readonly entityRevision: number;
  readonly factOrRuleId: string;
  readonly referenceId: string;
  readonly referenceRevision: string;
  readonly snapshotId: string;
  readonly sourceSnapshotContentDigest: string;
  readonly sourceOrganization: string;
  readonly sourceLocator: string;
  readonly sourceVersion: string;
  readonly publicationDate: string;
  readonly retrievedAt: string;
  readonly minimalSnapshotDigest: string;
  readonly applicableRegions: readonly string[];
  readonly sourceLanguage: string;
  readonly candidateSourceTier: SourceTier;
  readonly licenseStatus: "approved" | "pending" | "rejected" | "restricted" | "unknown";
  readonly copyPermitted: boolean;
  readonly transformationPermitted: boolean;
  readonly redistributionPermitted: boolean;
  readonly provenanceReviewStatus: "approved" | "pending" | "rejected" | "revoked" | "unreviewed";
  readonly licenseReviewStatus: "approved" | "pending" | "rejected" | "revoked" | "unreviewed";
  readonly domainReviewStatus: "approved" | "pending" | "rejected" | "revoked" | "unreviewed";
  readonly monitoringState: "current" | "overdue" | "unknown" | "withdrawn";
  readonly monitoringNextDueAt: string;
}
export interface M1ReviewDecisionEvidence {
  readonly reviewDecisionId: string;
  readonly authorityRecordId: string;
  readonly authorityAssignmentRevision: number;
  readonly authorityAssignmentDigest: string;
  readonly assignmentAcceptanceDigest: string;
  readonly role: M1ReadinessRole;
  readonly releaseId: string;
  readonly releaseRevision: number;
  readonly releaseContentDigest: string;
  readonly entityRevisions: readonly string[];
  readonly factOrRuleIds: readonly string[];
  readonly sourceInventoryIds: readonly string[];
  readonly sourceKeys: readonly string[];
  readonly applicableRegions: readonly string[];
  readonly languages: readonly string[];
  readonly decision: "approve" | "reject";
  readonly decidedAt: string;
  readonly evidenceDigest: string;
  readonly independenceEvidenceDigest: string;
  readonly conflictDisclosureDigest: string;
  readonly revokedAt: string;
}
export interface M1ReadinessEvidence {
  readonly schemaVersion: 1;
  readonly classification: "fully_synthetic" | "fully_synthetic_empty_template";
  readonly target: {
    readonly releaseId: string;
    readonly releaseRevision: number;
    readonly releaseContentDigest: string;
    readonly region: string;
    readonly language: string;
    readonly asOf: string;
  };
  readonly authorities: readonly M1AuthorityEvidence[];
  readonly sources: readonly M1SourceEvidence[];
  readonly reviewDecisions: readonly M1ReviewDecisionEvidence[];
  readonly readinessGatePassed: boolean;
  readonly auditAResult: "CLEAN" | "PENDING" | "BLOCK";
  readonly auditBResult: "CLEAN" | "PENDING" | "BLOCK";
  readonly totalControlAccepted: boolean;
}
export interface M1ReadinessAssessment {
  readonly status: "BLOCKED" | "ACTIVATION_ELIGIBLE";
  readonly primaryReason: M1ReadinessReason | null;
  readonly reasons: readonly M1ReadinessReason[];
}

declare const activationContextBrand: unique symbol;

export interface DecodedActivationContext {
  readonly asOf: string;
  readonly language: string;
  readonly region: string;
  readonly [activationContextBrand]: true;
}

export type ContextDecodeResult =
  | { readonly ok: true; readonly value: DecodedActivationContext }
  | { readonly ok: false; readonly code: "INVALID_ACTIVATION_CONTEXT" };

export type ReferenceResolution =
  | {
      readonly envelope: GovernanceEnvelope;
      readonly reason: "mapped";
      readonly status: "mapped";
    }
  | {
      readonly reason:
        | "invalid_activation_context"
        | "invalid_catalog"
        | "invalid_reference"
        | "unknown_identity";
      readonly status: "unmapped";
    }
  | { readonly reason: "current_revision_withdrawn"; readonly status: "withdrawn" }
  | {
      readonly reason: "not_latest_revision" | "unknown_revision";
      readonly status: "version_mismatch";
    }
  | {
      readonly reason:
        | "language_not_applicable"
        | "lifecycle_not_active"
        | "region_not_applicable"
        | "review_expired"
        | "review_not_effective";
      readonly status: "unapproved";
    };

export type HardMappingContextFailureReason =
  | "hard_mapping_source_region_not_applicable"
  | "hard_mapping_source_language_not_applicable"
  | "hard_mapping_source_review_not_effective"
  | "hard_mapping_source_review_expired"
  | "hard_mapping_target_region_not_applicable"
  | "hard_mapping_target_language_not_applicable"
  | "hard_mapping_target_review_not_effective"
  | "hard_mapping_target_review_expired";

export type HardMappingResolution =
  | {
      readonly mappingId: string;
      readonly reason: "mapped";
      readonly source: GovernanceEnvelope;
      readonly status: "mapped";
      readonly target: GovernanceEnvelope;
    }
  | {
      readonly reason:
        | "hard_mapping_source_unmapped"
        | "hard_mapping_target_unmapped"
        | "hard_mapping_unknown"
        | "invalid_activation_context"
        | "invalid_catalog"
        | "invalid_mapping_id";
      readonly status: "unmapped";
    }
  | {
      readonly reason: "hard_mapping_source_withdrawn" | "hard_mapping_target_withdrawn";
      readonly status: "withdrawn";
    }
  | {
      readonly reason:
        | "hard_mapping_source_version_mismatch"
        | "hard_mapping_target_version_mismatch";
      readonly status: "version_mismatch";
    }
  | {
      readonly reason:
        | "hard_mapping_source_lifecycle_not_active"
        | "hard_mapping_target_lifecycle_not_active"
        | HardMappingContextFailureReason;
      readonly status: "unapproved";
    };
