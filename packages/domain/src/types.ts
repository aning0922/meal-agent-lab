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
export const householdProfileStatuses = frozenLiterals("active", "archived");
export const dietaryRuleKinds = frozenLiterals(
  "allergy",
  "religious",
  "ethical",
  "explicit_strict_avoid",
  "ordinary_avoid",
  "dislike",
  "reduce",
);
export const constraintBases = frozenLiterals("explicit_declaration");
export const constraintMappingStatuses = frozenLiterals("mapped", "unknown", "ambiguous");
export const dishExposureKinds = frozenLiterals(
  "primary",
  "secondary",
  "seasoning",
  "garnish",
  "substitute",
  "contains",
  "may_contain",
  "cross_contact",
);
export const householdTableSafetyStatuses = frozenLiterals("allowed", "blocked");
export const subjectSuitabilityStatuses = frozenLiterals(
  "suitable",
  "indeterminate",
  "unsuitable",
);
export const subjectKinds = frozenLiterals("household_profile", "guest");
export const householdSafetyReasonScopes = frozenLiterals(
  "input",
  "source_pack",
  "table",
  "subject",
  "soft",
);
export const sourceFactDispositions = frozenLiterals(
  "POSITIVE_BLOCK",
  "UNKNOWN_BLOCK",
  "CANDIDATE_CLEAR",
  "REVIEWED_CLEAR",
);
export const mappingReviewStatuses = frozenLiterals("pending", "reviewed", "withdrawn");
export const supportedHouseholdCountries = frozenLiterals("CN");
export const supportedFoodRuleRegions = frozenLiterals("CN");
export const supportedRuleLanguages = frozenLiterals("zh-CN");

export const householdSafetyInputIssueCodes = frozenLiterals(
  "DISH_DIGEST_MISMATCH",
  "DUPLICATE_CONSTRAINT_ID",
  "DUPLICATE_EXPOSURE_ID",
  "DUPLICATE_GUEST_ID",
  "DUPLICATE_MAPPING_ID",
  "DUPLICATE_PARTICIPANT_ID",
  "DUPLICATE_PROFILE_ID",
  "EMPTY_DISH_EXPOSURES",
  "EMPTY_PARTICIPANTS",
  "ARCHIVED_PROFILE_REFERENCE",
  "UNKNOWN_DISCRIMINATOR",
  "UNKNOWN_PROFILE_REFERENCE",
);

export const householdSafetyReasonCodes = frozenLiterals(
  "input_invalid",
  "source_pack_missing",
  "source_pack_invalid",
  "source_pack_withdrawn",
  "source_pack_not_active",
  "source_pack_untrusted",
  "source_pack_version_drift",
  "source_pack_region_not_applicable",
  "source_pack_language_not_applicable",
  "source_version_window_missing",
  "source_version_window_ambiguous",
  "source_license_not_approved",
  "source_fact_unknown",
  "source_fact_candidate_clear",
  "source_reviewed_clear_missing",
  "mapping_unknown",
  "mapping_ambiguous",
  "mapping_invalid",
  "mapping_withdrawn",
  "mapping_version_mismatch",
  "mapping_unapproved",
  "mapping_required_false",
  "mapping_target_kind_mismatch",
  "mapping_source_unbound",
  "mapping_source_multiple_bindings",
  "mapping_target_unbound",
  "mapping_target_multiple_bindings",
  "mapping_endpoint_not_current",
  "mapping_review_missing",
  "mapping_review_mismatch",
  "mapping_review_not_current",
  "household_allergy_match",
  "guest_allergy_match",
  "personal_religious_match",
  "personal_ethical_match",
  "personal_strict_avoid_match",
  "no_suitable_participant",
  "soft_ordinary_avoid_match",
  "soft_dislike_match",
  "soft_reduce_match",
);

export type DatasetKind = (typeof datasetKinds)[number];
export type SourceTier = (typeof sourceTiers)[number];
export type LicenseStatus = (typeof licenseStatuses)[number];
export type LifecycleStatus = (typeof lifecycleStatuses)[number];
export type WithdrawalState = (typeof withdrawalStates)[number];
export type Identifier = string;
export type CanonicalInstant = string;
export type Digest = string;
export type HouseholdProfileStatus = (typeof householdProfileStatuses)[number];
export type DietaryRuleKind = (typeof dietaryRuleKinds)[number];
export type ConstraintBasis = (typeof constraintBases)[number];
export type ConstraintMappingStatus = (typeof constraintMappingStatuses)[number];
export type DishExposureKind = (typeof dishExposureKinds)[number];
export type HouseholdTableSafetyStatus = (typeof householdTableSafetyStatuses)[number];
export type SubjectSuitabilityStatus = (typeof subjectSuitabilityStatuses)[number];
export type SubjectKind = (typeof subjectKinds)[number];
export type HouseholdSafetyReasonScope = (typeof householdSafetyReasonScopes)[number];
export type SourceFactDisposition = (typeof sourceFactDispositions)[number];
export type MappingReviewStatus = (typeof mappingReviewStatuses)[number];
export type HouseholdCountry = (typeof supportedHouseholdCountries)[number];
export type FoodRuleRegion = (typeof supportedFoodRuleRegions)[number];
export type RuleLanguage = (typeof supportedRuleLanguages)[number];

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

export interface OfficialSourceEvidence {
  readonly classification: "official_source_projection";
  readonly containsRealFoodFacts: true;
  readonly containsRealUserData: false;
  readonly fullTextCopied: false;
  readonly purpose: "household-safety-provenance-only";
  readonly factDisposition: SourceFactDisposition;
  readonly usageStatus: "pending" | "approved";
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
  readonly officialEvidence?: OfficialSourceEvidence;
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

export type MappingSelection =
  | {
      readonly status: "mapped";
      readonly mappingIds: readonly Identifier[];
    }
  | { readonly status: "unknown" }
  | {
      readonly status: "ambiguous";
      readonly candidateMappingIds: readonly Identifier[];
    };

export interface DietaryRuleFact {
  readonly constraintId: Identifier;
  readonly kind: DietaryRuleKind;
  readonly basis: ConstraintBasis;
  readonly mapping: MappingSelection;
}

export interface HouseholdProfileSafetyFacts {
  readonly profileId: Identifier;
  readonly status: HouseholdProfileStatus;
  readonly constraints: readonly DietaryRuleFact[];
}

export interface GuestParticipantSafetyFacts {
  readonly guestId: Identifier;
  readonly constraints: readonly DietaryRuleFact[];
}

export interface DishExposure {
  readonly exposureId: Identifier;
  readonly kind: DishExposureKind;
  readonly mapping: MappingSelection;
}

export interface DishSafetyFacts {
  readonly dishId: Identifier;
  readonly dishRevision: number;
  readonly contentDigest: Digest;
  readonly exposures: readonly [DishExposure, ...DishExposure[]];
}

export interface SourcePackSnapshotRef {
  readonly packId: Identifier;
  readonly packRevision: number;
  readonly contentDigest: Digest;
}

export interface HouseholdDishSafetyInput {
  readonly schemaVersion: 2;
  readonly asOf: CanonicalInstant;
  readonly household: {
    readonly country: HouseholdCountry;
    readonly foodRuleRegion: FoodRuleRegion;
  };
  readonly expectedSourcePack: SourcePackSnapshotRef;
  readonly householdProfiles: readonly HouseholdProfileSafetyFacts[];
  readonly mealParticipantProfileIds: readonly Identifier[];
  readonly guestParticipants: readonly GuestParticipantSafetyFacts[];
  readonly dish: DishSafetyFacts;
}

export interface ReleaseBinding {
  readonly bindingId: Identifier;
  readonly datasetId: Identifier;
  readonly datasetKind: "food_concept" | "allergen" | "religious_ethical";
  readonly releaseId: Identifier;
  readonly releaseRevision: number;
  readonly releaseDigest: Digest;
  readonly sourceReferenceId: Identifier;
  readonly sourceReferenceRevision: Identifier;
  readonly sourceVersion: "2011" | "2025";
}

export interface SourceVersionWindow {
  readonly bindingId: Identifier;
  readonly jurisdictionTimeZone: "Asia/Shanghai";
  readonly sourceCivilEffectiveDate: "2012-04-20" | "2027-03-16";
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
}

export interface MappingReview {
  readonly mappingId: Identifier;
  readonly reviewRevision: number;
  readonly contentDigest: Digest;
  readonly sourceBindingId: Identifier;
  readonly targetBindingId: Identifier;
  readonly source: GovernedReference;
  readonly target: GovernedReference;
  readonly required: boolean;
  readonly reviewStatus: MappingReviewStatus;
  readonly effectiveFrom: CanonicalInstant | null;
  readonly effectiveUntil: CanonicalInstant | null;
}

export interface HouseholdSafetySourcePack {
  readonly schemaVersion: 2;
  readonly packId: Identifier;
  readonly packRevision: number;
  readonly contentDigest: Digest;
  readonly lifecycleStatus: LifecycleStatus;
  readonly country: HouseholdCountry;
  readonly foodRuleRegion: FoodRuleRegion;
  readonly ruleLanguage: RuleLanguage;
  readonly releaseBindings: readonly ReleaseBinding[];
  readonly sourceVersionWindows: readonly SourceVersionWindow[];
  readonly mappingReviews: readonly MappingReview[];
  readonly catalog: GovernanceCatalog;
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

export type HouseholdSafetyInputIssueCode =
  | DecodeIssueCode
  | (typeof householdSafetyInputIssueCodes)[number];

export type HouseholdSafetyInputDecodeResult =
  | { readonly ok: true; readonly value: HouseholdDishSafetyInput }
  | {
      readonly ok: false;
      readonly reason: "decode_failed";
      readonly issue: {
        readonly code: HouseholdSafetyInputIssueCode;
        readonly path: string;
      };
    };

export type HouseholdSafetyReasonCode = (typeof householdSafetyReasonCodes)[number];

export interface SubjectRef {
  readonly kind: SubjectKind;
  readonly id: Identifier;
}

export interface HouseholdSafetyReason {
  readonly code: HouseholdSafetyReasonCode;
  readonly constraintId: Identifier | null;
  readonly constraintMappingId: Identifier | null;
  readonly exposureId: Identifier | null;
  readonly exposureKind: DishExposureKind | null;
  readonly exposureMappingId: Identifier | null;
  readonly mappingEndpoint: "source" | "target" | null;
  readonly mappingId: Identifier | null;
  readonly scope: HouseholdSafetyReasonScope;
  readonly subject: SubjectRef | null;
}

export interface SubjectSuitability {
  readonly reasons: readonly HouseholdSafetyReason[];
  readonly status: SubjectSuitabilityStatus;
  readonly subject: SubjectRef;
}

export interface HouseholdDishSafetyEvaluation {
  readonly evaluationDigest: Digest;
  readonly inputIssue: {
    readonly code: HouseholdSafetyInputIssueCode;
    readonly path: string;
  } | null;
  readonly requestDigest: Digest | null;
  readonly schemaVersion: 2;
  readonly sourcePackDigest: Digest | null;
  readonly subjects: readonly SubjectSuitability[];
  readonly tableReasons: readonly HouseholdSafetyReason[];
  readonly tableStatus: HouseholdTableSafetyStatus;
}

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: "decode_failed";
      readonly issue: DecodeIssue;
    };

export type InternalFactState =
  | "positive"
  | "unknown"
  | "candidate_clear"
  | "reviewed_clear";

export type InternalM0MappingState =
  | "mapped"
  | "unmapped"
  | "withdrawn"
  | "version_mismatch"
  | "unapproved";

export interface InternalNormalizedSourcePair {
  readonly sourceReferenceId: Identifier;
  readonly sourceReferenceRevision: Identifier;
  readonly locator: string;
  readonly snapshotDigest: Digest;
}

export interface InternalNormalizedReleaseEnvelope {
  readonly datasetKind: "food_concept" | "allergen" | "religious_ethical";
  readonly reference: GovernedReference;
  readonly applicableRegions: readonly string[];
  readonly languages: readonly string[];
  readonly sourcePairs: readonly InternalNormalizedSourcePair[];
}

export interface InternalNormalizedRelease {
  readonly releaseId: Identifier;
  readonly releaseRevision: number;
  readonly releaseDigest: Digest;
  readonly envelopes: readonly InternalNormalizedReleaseEnvelope[];
}

export interface InternalSyntheticAnalyzedScenario {
  readonly schemaVersion: 1;
  readonly subjects: readonly SubjectRef[];
  readonly tableKnownHardReasons: readonly HouseholdSafetyReason[];
  readonly tableUncertaintyReasons: readonly HouseholdSafetyReason[];
  readonly subjectKnownHardReasons: readonly HouseholdSafetyReason[];
  readonly subjectUncertaintyReasons: readonly HouseholdSafetyReason[];
  readonly softReasons: readonly HouseholdSafetyReason[];
}

export interface InternalSyntheticEndpointFact {
  readonly reference: GovernedReference;
  readonly syntheticDisposition: SourceFactDisposition;
}

export interface InternalSyntheticGovernedGraph {
  readonly schemaVersion: 2;
  readonly packId: Identifier;
  readonly packRevision: number;
  readonly country: HouseholdCountry;
  readonly foodRuleRegion: FoodRuleRegion;
  readonly ruleLanguage: RuleLanguage;
  readonly syntheticSourceUsageStatus: "pending" | "approved";
  readonly releaseBindings: readonly ReleaseBinding[];
  readonly sourceVersionWindows: readonly SourceVersionWindow[];
  readonly mappingReviews: readonly MappingReview[];
  readonly catalog: GovernanceCatalog;
  readonly endpointFacts: readonly InternalSyntheticEndpointFact[];
}

export interface InternalAnalyzedHouseholdSafetyState
  extends InternalSyntheticAnalyzedScenario {
  readonly requestDigest: Digest;
  readonly sourcePackDigest: Digest;
}

export type InternalAnalyzedStateResult =
  | { readonly ok: true; readonly state: InternalAnalyzedHouseholdSafetyState }
  | { readonly ok: false; readonly issue: DecodeIssue };

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
  | "INVALID_OFFICIAL_EVIDENCE"
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
