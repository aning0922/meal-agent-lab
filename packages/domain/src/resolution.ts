import {
  canonicalAnalyzedHouseholdRequestDigest,
  canonicalAnalyzedHouseholdSourceDigest,
  canonicalDishDigest,
  canonicalHouseholdRequestDigest,
  canonicalHouseholdSafetyEvaluationDigest,
  canonicalHouseholdSafetyPackDigest,
  canonicalMappingReviewDigest,
  canonicalReasonText,
  canonicalSyntheticGovernedGraphDigest,
  compareUtf8,
  deepFreeze,
} from "./canonical.js";
import { entityIdentityText, governedReferenceText } from "./catalog.js";
import {
  dishExposureKinds,
  householdSafetyReasonCodes,
  householdSafetyReasonScopes,
} from "./types.js";
import {
  decodeHouseholdDishSafetyInput,
  decodeHouseholdSafetySourcePack,
  decodeInternalSyntheticAnalyzedScenario,
  decodeInternalSyntheticGovernedGraph,
  decodeJsonScalarClosure,
} from "./decode.js";
import type {
  CanonicalInstant,
  ContextDecodeResult,
  DatasetKind,
  DecodedActivationContext,
  Digest,
  DietaryRuleFact,
  DishExposure,
  DishExposureKind,
  GovernanceEnvelope,
  GovernanceCatalog,
  GovernedReference,
  HardMappingResolution,
  HouseholdDishSafetyEvaluation,
  HouseholdDishSafetyInput,
  HouseholdSafetyInputIssueCode,
  HouseholdSafetyReason,
  HouseholdSafetyReasonCode,
  HouseholdSafetyReasonScope,
  HouseholdSafetySourcePack,
  InternalAnalyzedHouseholdSafetyState,
  InternalAnalyzedStateResult,
  InternalSyntheticAnalyzedScenario,
  InternalSyntheticGovernedGraph,
  LifecycleStatus,
  MappingReview,
  MappingSelection,
  ReferenceResolution,
  ReleaseBinding,
  SourceVersionWindow,
  SourceFactDisposition,
  SubjectRef,
  SubjectSuitability,
} from "./types.js";
import {
  analyzeGovernanceCatalog,
  analyzeHouseholdSafetyOfficialCatalogFindings,
  analyzeHouseholdSafetySourcePackStructure,
  type CatalogAnalysis,
  type CatalogFinding,
} from "./validation.js";

const contexts = new WeakSet<object>();
const timestampPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const identifierPattern = /^[a-z0-9](?:[a-z0-9:._-]{0,127})$/;
const contextTokenPattern = /^[A-Za-z0-9](?:[A-Za-z0-9:._-]{0,127})$/;

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null => {
  const decoded = decodeJsonScalarClosure(value);
  if (!decoded.ok || decoded.value === null || Array.isArray(decoded.value) || typeof decoded.value !== "object") {
    return null;
  }
  const record = decoded.value as Readonly<Record<string, unknown>>;
  const ownKeys = Object.keys(record).sort();
  return ownKeys.length === keys.length && ownKeys.every((key, index) => key === keys[index])
    ? record
    : null;
};

const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  timestampPattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const validIdentifier = (value: unknown): value is string =>
  typeof value === "string" && identifierPattern.test(value);

const validContextToken = (value: unknown): value is string =>
  typeof value === "string" && contextTokenPattern.test(value);

export const decodeActivationContext = (input: unknown): ContextDecodeResult => {
  const record = exactRecord(input, ["asOf", "language", "region"]);
  if (
    record === null ||
    !validTimestamp(record["asOf"]) ||
    !validContextToken(record["language"]) ||
    !validContextToken(record["region"])
  ) {
    return Object.freeze({ ok: false, code: "INVALID_ACTIVATION_CONTEXT" });
  }
  const value = Object.freeze({
    asOf: record["asOf"],
    language: record["language"],
    region: record["region"],
  }) as DecodedActivationContext;
  contexts.add(value);
  return Object.freeze({ ok: true, value });
};

const isRegisteredContext = (value: unknown): value is DecodedActivationContext =>
  typeof value === "object" && value !== null && contexts.has(value);

const decodeReference = (input: unknown): GovernedReference | null => {
  const record = exactRecord(input, ["datasetId", "entityId", "entityRevision"]);
  if (
    record === null ||
    !validIdentifier(record["datasetId"]) ||
    !validIdentifier(record["entityId"]) ||
    !Number.isSafeInteger(record["entityRevision"]) ||
    (record["entityRevision"] as number) <= 0
  ) {
    return null;
  }
  return Object.freeze({
    datasetId: record["datasetId"],
    entityId: record["entityId"],
    entityRevision: record["entityRevision"],
  }) as GovernedReference;
};

const failure = <TReason extends string, TStatus extends string>(
  reason: TReason,
  status: TStatus,
): Readonly<{ reason: TReason; status: TStatus }> => Object.freeze({ reason, status });

const catalogSafeForReference = (analysis: CatalogAnalysis): boolean =>
  analysis.catalog !== null && analysis.findings.length === 0;

const allowedLocalCodes = new Set([
  "DUPLICATE_HARD_MAPPING",
  "HARD_MAPPING_SOURCE_UNRESOLVED",
  "HARD_MAPPING_TARGET_UNRESOLVED",
]);

const catalogSafeForMapping = (analysis: CatalogAnalysis, mappingId: string): boolean => {
  if (analysis.catalog === null) return false;
  if (analysis.findings.length === 0) return true;
  if (analysis.findings.length !== 1) return false;
  const finding = analysis.findings[0];
  return (
    finding !== undefined &&
    finding.scope === "mapping" &&
    finding.mappingId === mappingId &&
    allowedLocalCodes.has(finding.issue.code)
  );
};

const allIdentityRevisions = (
  analysis: CatalogAnalysis,
  reference: GovernedReference,
): readonly GovernanceEnvelope[] => {
  if (analysis.catalog === null) return [];
  const identity = entityIdentityText(reference);
  return analysis.catalog.releases.flatMap((release) =>
    release.envelopes.filter((envelope) => entityIdentityText(envelope) === identity),
  );
};

type EndpointResult =
  | { readonly kind: "usable"; readonly envelope: GovernanceEnvelope }
  | {
      readonly kind:
        | "language"
        | "lifecycle"
        | "region"
        | "review_expired"
        | "review_not_effective"
        | "unknown"
        | "version"
        | "withdrawn";
    };

const evaluateEndpoint = (
  analysis: CatalogAnalysis,
  reference: GovernedReference,
  context: DecodedActivationContext,
): EndpointResult => {
  const revisions = allIdentityRevisions(analysis, reference);
  if (revisions.length === 0) return { kind: "unknown" };
  const requested = revisions.find(({ entityRevision }) => entityRevision === reference.entityRevision);
  if (requested === undefined) return { kind: "version" };
  const latestRevision = Math.max(...revisions.map(({ entityRevision }) => entityRevision));
  if (requested.entityRevision !== latestRevision) return { kind: "version" };
  if (requested.lifecycleStatus === "withdrawn" || requested.withdrawalState === "withdrawn") {
    return { kind: "withdrawn" };
  }
  if (requested.lifecycleStatus !== "active") return { kind: "lifecycle" };
  if (!requested.applicableRegions.includes(context.region)) return { kind: "region" };
  if (!requested.languages.includes(context.language)) return { kind: "language" };
  if (context.asOf < requested.reviewedAt) return { kind: "review_not_effective" };
  if (context.asOf > requested.reviewDueAt) return { kind: "review_expired" };
  return { kind: "usable", envelope: requested };
};

export const resolveGovernedReference = (
  catalog: unknown,
  reference: unknown,
  context: DecodedActivationContext,
): ReferenceResolution => {
  if (!isRegisteredContext(context)) return failure("invalid_activation_context", "unmapped");
  const decodedReference = decodeReference(reference);
  if (decodedReference === null) return failure("invalid_reference", "unmapped");
  const analysis = analyzeGovernanceCatalog(catalog);
  if (!catalogSafeForReference(analysis)) return failure("invalid_catalog", "unmapped");
  const revisions = allIdentityRevisions(analysis, decodedReference);
  if (revisions.length === 0) return failure("unknown_identity", "unmapped");
  const requested = revisions.find(
    ({ entityRevision }) => entityRevision === decodedReference.entityRevision,
  );
  if (requested === undefined) return failure("unknown_revision", "version_mismatch");
  const latestRevision = Math.max(...revisions.map(({ entityRevision }) => entityRevision));
  if (requested.entityRevision !== latestRevision) {
    return failure("not_latest_revision", "version_mismatch");
  }
  const endpoint = evaluateEndpoint(analysis, decodedReference, context);
  if (endpoint.kind === "withdrawn") return failure("current_revision_withdrawn", "withdrawn");
  if (endpoint.kind === "lifecycle") return failure("lifecycle_not_active", "unapproved");
  if (endpoint.kind === "region") return failure("region_not_applicable", "unapproved");
  if (endpoint.kind === "language") return failure("language_not_applicable", "unapproved");
  if (endpoint.kind === "review_not_effective") {
    return failure("review_not_effective", "unapproved");
  }
  if (endpoint.kind === "review_expired") return failure("review_expired", "unapproved");
  if (endpoint.kind !== "usable") return failure("invalid_catalog", "unmapped");
  return Object.freeze({ envelope: endpoint.envelope, reason: "mapped", status: "mapped" });
};

const hardEndpointFailure = (
  endpoint: EndpointResult,
  side: "source" | "target",
): HardMappingResolution | null => {
  if (endpoint.kind === "usable") return null;
  if (endpoint.kind === "unknown") {
    return failure(`hard_mapping_${side}_unmapped` as const, "unmapped");
  }
  if (endpoint.kind === "version") {
    return failure(`hard_mapping_${side}_version_mismatch` as const, "version_mismatch");
  }
  if (endpoint.kind === "withdrawn") {
    return failure(`hard_mapping_${side}_withdrawn` as const, "withdrawn");
  }
  if (endpoint.kind === "lifecycle") {
    return failure(`hard_mapping_${side}_lifecycle_not_active` as const, "unapproved");
  }
  if (endpoint.kind === "region") {
    return failure(`hard_mapping_${side}_region_not_applicable` as const, "unapproved");
  }
  if (endpoint.kind === "language") {
    return failure(`hard_mapping_${side}_language_not_applicable` as const, "unapproved");
  }
  if (endpoint.kind === "review_not_effective") {
    return failure(`hard_mapping_${side}_review_not_effective` as const, "unapproved");
  }
  return failure(`hard_mapping_${side}_review_expired` as const, "unapproved");
};

export const resolveHardMapping = (
  catalog: unknown,
  mappingId: unknown,
  context: DecodedActivationContext,
): HardMappingResolution => {
  if (!isRegisteredContext(context)) return failure("invalid_activation_context", "unmapped");
  if (!validIdentifier(mappingId)) return failure("invalid_mapping_id", "unmapped");
  const analysis = analyzeGovernanceCatalog(catalog);
  if (!catalogSafeForMapping(analysis, mappingId)) return failure("invalid_catalog", "unmapped");
  if (analysis.catalog === null) return failure("invalid_catalog", "unmapped");
  const mappings = analysis.catalog.hardMappings.filter((mapping) => mapping.mappingId === mappingId);
  if (mappings.length === 0) return failure("hard_mapping_unknown", "unmapped");
  if (mappings.length !== 1) return failure("invalid_catalog", "unmapped");
  const mapping = mappings[0];
  if (mapping === undefined) return failure("invalid_catalog", "unmapped");

  const source = evaluateEndpoint(analysis, mapping.source, context);
  const sourceFailure = hardEndpointFailure(source, "source");
  if (sourceFailure !== null) return sourceFailure;
  const target = evaluateEndpoint(analysis, mapping.target, context);
  const targetFailure = hardEndpointFailure(target, "target");
  if (targetFailure !== null) return targetFailure;
  if (source.kind !== "usable" || target.kind !== "usable") {
    return failure("invalid_catalog", "unmapped");
  }
  return Object.freeze({
    mappingId,
    reason: "mapped",
    source: source.envelope,
    status: "mapped",
    target: target.envelope,
  });
};

const TRUSTED_ACTIVE_HOUSEHOLD_SAFETY_PACK_DIGESTS: readonly Digest[] = Object.freeze([]);

const INTERNAL_SYNTHETIC_CLASSIFIER_LIFECYCLE: LifecycleStatus = "active";

const internalAnalyzedHouseholdSafetyBrand: unique symbol = Symbol(
  "internalAnalyzedHouseholdSafetyBrand",
);
const internalGovernedAnalyzerBrand: unique symbol = Symbol("internalGovernedAnalyzerBrand");
const analyzedHouseholdSafetyStates = new WeakSet<object>();
const governedHouseholdSafetyStates = new WeakSet<object>();

const reasonCodeRank = new Map<HouseholdSafetyReasonCode, number>(
  householdSafetyReasonCodes.map((code, index) => [code, index]),
);
const scopeRank = new Map<HouseholdSafetyReasonScope, number>(
  householdSafetyReasonScopes.map((scope, index) => [scope, index]),
);
const exposureKindRank = new Map<DishExposureKind, number>(
  dishExposureKinds.map((kind, index) => [kind, index]),
);

const nullableCompare = (left: string | null, right: string | null): number => {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareUtf8(left, right);
};

const subjectCompare = (left: SubjectRef | null, right: SubjectRef | null): number => {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  const kindOrder =
    (left.kind === "household_profile" ? 0 : 1) -
    (right.kind === "household_profile" ? 0 : 1);
  return kindOrder !== 0 ? kindOrder : compareUtf8(left.id, right.id);
};

const reasonCompare = (left: HouseholdSafetyReason, right: HouseholdSafetyReason): number => {
  const comparisons = [
    (reasonCodeRank.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
      (reasonCodeRank.get(right.code) ?? Number.MAX_SAFE_INTEGER),
    (scopeRank.get(left.scope) ?? Number.MAX_SAFE_INTEGER) -
      (scopeRank.get(right.scope) ?? Number.MAX_SAFE_INTEGER),
    subjectCompare(left.subject, right.subject),
    nullableCompare(left.constraintId, right.constraintId),
    nullableCompare(left.constraintMappingId, right.constraintMappingId),
    (left.exposureKind === null ? -1 : (exposureKindRank.get(left.exposureKind) ?? 99)) -
      (right.exposureKind === null ? -1 : (exposureKindRank.get(right.exposureKind) ?? 99)),
    nullableCompare(left.exposureId, right.exposureId),
    nullableCompare(left.exposureMappingId, right.exposureMappingId),
    (left.mappingEndpoint === null ? 0 : left.mappingEndpoint === "source" ? 1 : 2) -
      (right.mappingEndpoint === null ? 0 : right.mappingEndpoint === "source" ? 1 : 2),
    nullableCompare(left.mappingId, right.mappingId),
  ];
  return comparisons.find((comparison) => comparison !== 0) ?? 0;
};

const reason = (
  code: HouseholdSafetyReasonCode,
  scope: HouseholdSafetyReasonScope,
  values: Partial<Omit<HouseholdSafetyReason, "code" | "scope">> = {},
): HouseholdSafetyReason =>
  Object.freeze({
    code,
    constraintId: values.constraintId ?? null,
    constraintMappingId: values.constraintMappingId ?? null,
    exposureId: values.exposureId ?? null,
    exposureKind: values.exposureKind ?? null,
    exposureMappingId: values.exposureMappingId ?? null,
    mappingEndpoint: values.mappingEndpoint ?? null,
    mappingId: values.mappingId ?? null,
    scope,
    subject: values.subject ?? null,
  });

const sortedReasons = (
  values: readonly HouseholdSafetyReason[],
): readonly HouseholdSafetyReason[] => {
  const unique = new Map<string, HouseholdSafetyReason>();
  for (const value of values) unique.set(canonicalReasonText(value), value);
  return Object.freeze([...unique.values()].sort(reasonCompare));
};

const sortedSubjects = (subjects: readonly SubjectRef[]): readonly SubjectRef[] =>
  Object.freeze([...subjects].sort(subjectCompare));

const finalizeHouseholdSafetyEvaluation = (values: {
  readonly inputIssue: {
    readonly code: HouseholdSafetyInputIssueCode;
    readonly path: string;
  } | null;
  readonly requestDigest: Digest | null;
  readonly sourcePackDigest: Digest | null;
  readonly subjects: readonly SubjectSuitability[];
  readonly tableReasons: readonly HouseholdSafetyReason[];
  readonly tableStatus: "allowed" | "blocked";
}): HouseholdDishSafetyEvaluation => {
  const material = {
    inputIssue: values.inputIssue,
    requestDigest: values.requestDigest,
    schemaVersion: 2 as const,
    sourcePackDigest: values.sourcePackDigest,
    subjects: values.subjects,
    tableReasons: sortedReasons(values.tableReasons),
    tableStatus: values.tableStatus,
  };
  return deepFreeze({
    evaluationDigest: canonicalHouseholdSafetyEvaluationDigest(material),
    ...material,
  });
};

const terminalEvaluation = (
  code: HouseholdSafetyReasonCode,
  scope: "input" | "source_pack",
  requestDigest: Digest | null,
  sourcePackDigest: Digest | null,
  subjects: readonly SubjectRef[],
  inputIssue: {
    readonly code: HouseholdSafetyInputIssueCode;
    readonly path: string;
  } | null = null,
): HouseholdDishSafetyEvaluation =>
  finalizeHouseholdSafetyEvaluation({
    inputIssue,
    requestDigest,
    sourcePackDigest,
    subjects: Object.freeze(
      sortedSubjects(subjects).map((subject) =>
        Object.freeze({ reasons: Object.freeze([]), status: "indeterminate", subject }),
      ),
    ),
    tableReasons: [reason(code, scope)],
    tableStatus: "blocked",
  });

const evaluateAnalyzedHouseholdSafety = (
  scenario: InternalSyntheticAnalyzedScenario,
  requestDigest: Digest,
  sourcePackDigest: Digest,
): HouseholdDishSafetyEvaluation => {
  const tableKnown = sortedReasons(scenario.tableKnownHardReasons);
  const tableUncertainty = sortedReasons(scenario.tableUncertaintyReasons);
  const tableBlocked = tableKnown.length > 0 || tableUncertainty.length > 0;
  const subjects = sortedSubjects(scenario.subjects).map((subject) => {
    const sameSubject = (candidate: HouseholdSafetyReason): boolean =>
      candidate.subject?.kind === subject.kind && candidate.subject.id === subject.id;
    const known = scenario.subjectKnownHardReasons.filter(sameSubject);
    const uncertainty = scenario.subjectUncertaintyReasons.filter(sameSubject);
    const soft = scenario.softReasons.filter(sameSubject);
    const status =
      tableKnown.length > 0 || known.length > 0
        ? "unsuitable"
        : tableUncertainty.length > 0 || uncertainty.length > 0
          ? "indeterminate"
          : "suitable";
    return Object.freeze({
      reasons: sortedReasons([...known, ...uncertainty, ...soft]),
      status,
      subject,
    });
  });
  const noSuitable = subjects.every((subject) => subject.status !== "suitable");
  const tableReasons = [...tableKnown, ...tableUncertainty];
  if (!tableBlocked && noSuitable) {
    tableReasons.push(reason("no_suitable_participant", "table"));
  }
  return finalizeHouseholdSafetyEvaluation({
    inputIssue: null,
    requestDigest,
    sourcePackDigest,
    subjects: Object.freeze(subjects),
    tableReasons,
    tableStatus: tableBlocked || noSuitable ? "blocked" : "allowed",
  });
};

const normalizeAnalyzedScenario = (
  scenario: InternalSyntheticAnalyzedScenario,
): InternalSyntheticAnalyzedScenario =>
  Object.freeze({
    schemaVersion: 1,
    subjects: sortedSubjects(scenario.subjects),
    tableKnownHardReasons: sortedReasons(scenario.tableKnownHardReasons),
    tableUncertaintyReasons: sortedReasons(scenario.tableUncertaintyReasons),
    subjectKnownHardReasons: sortedReasons(scenario.subjectKnownHardReasons),
    subjectUncertaintyReasons: sortedReasons(scenario.subjectUncertaintyReasons),
    softReasons: sortedReasons(scenario.softReasons),
  });

export const __testOnlyAnalyzeSyntheticHouseholdSafety = (
  scenario: unknown,
): InternalAnalyzedStateResult => {
  const decoded = decodeInternalSyntheticAnalyzedScenario(scenario);
  if (!decoded.ok) return Object.freeze({ ok: false, issue: decoded.issue });
  const normalized = normalizeAnalyzedScenario(decoded.value);
  const state = {
    ...normalized,
    requestDigest: canonicalAnalyzedHouseholdRequestDigest(normalized),
    sourcePackDigest: canonicalAnalyzedHouseholdSourceDigest(normalized),
  };
  Object.defineProperty(state, internalAnalyzedHouseholdSafetyBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  const frozen = deepFreeze(state) as InternalAnalyzedHouseholdSafetyState;
  analyzedHouseholdSafetyStates.add(frozen);
  return Object.freeze({ ok: true, state: frozen });
};

export const __testOnlyEvaluateAnalyzedHouseholdSafety = (
  state: InternalAnalyzedHouseholdSafetyState,
): HouseholdDishSafetyEvaluation => {
  if (
    typeof state !== "object" ||
    state === null ||
    !analyzedHouseholdSafetyStates.has(state) ||
    Reflect.get(state, internalAnalyzedHouseholdSafetyBrand) !== true
  ) {
    throw new TypeError("Invalid internal analyzed household safety state");
  }
  return evaluateAnalyzedHouseholdSafety(state, state.requestDigest, state.sourcePackDigest);
};

type InternalCoverageUnitKey =
  | {
      readonly kind: "dish_exposure";
      readonly exposureId: string;
    }
  | {
      readonly kind: "household_allergy";
      readonly profileId: string;
      readonly constraintId: string;
    }
  | {
      readonly kind: "guest_allergy";
      readonly guestId: string;
      readonly constraintId: string;
    }
  | {
      readonly kind: "personal_hard";
      readonly subject: SubjectRef;
      readonly constraintId: string;
    };

interface InternalCoverageResolution {
  readonly unit: InternalCoverageUnitKey;
  clearSupported: boolean;
  readonly ownFailures: HouseholdSafetyReason[];
  knownHardAccounted: boolean;
}

type SelectorLocation =
  | "dish_exposure"
  | "household_allergy"
  | "guest_allergy"
  | "personal_hard"
  | "soft";

interface InputSelectorContext {
  readonly constraint: DietaryRuleFact | null;
  readonly coverageUnitKey: InternalCoverageUnitKey | null;
  readonly exposure: DishExposure | null;
  readonly location: SelectorLocation;
  readonly selection: MappingSelection;
  readonly subject: SubjectRef | null;
}

interface InternalNormalizedEndpointFact {
  readonly reference: GovernedReference;
  readonly disposition: SourceFactDisposition;
}

interface InternalNormalizedGovernedGraph {
  readonly packId: string;
  readonly packRevision: number;
  readonly sourcePackDigest: Digest;
  readonly country: "CN";
  readonly foodRuleRegion: "CN";
  readonly ruleLanguage: "zh-CN";
  readonly sourceUsageApproved: boolean;
  readonly releaseBindings: readonly ReleaseBinding[];
  readonly sourceVersionWindows: readonly SourceVersionWindow[];
  readonly mappingReviews: readonly MappingReview[];
  readonly catalog: GovernanceCatalog;
  readonly endpointFacts: readonly InternalNormalizedEndpointFact[];
}

type HouseholdCatalogAnalysis =
  ReturnType<typeof analyzeHouseholdSafetyOfficialCatalogFindings>;

interface GovernedAnalyzerState {
  readonly input: HouseholdDishSafetyInput;
  readonly graph: InternalNormalizedGovernedGraph;
  readonly catalogAnalysis: HouseholdCatalogAnalysis;
  readonly requestDigest: Digest;
  readonly sourcePackDigest: Digest;
  readonly [internalGovernedAnalyzerBrand]: true;
}

function buildProductionGovernedState(
  input: HouseholdDishSafetyInput,
  graph: InternalNormalizedGovernedGraph,
  catalogAnalysis: HouseholdCatalogAnalysis,
): GovernedAnalyzerState {
  const state = {
    input,
    graph,
    catalogAnalysis,
    requestDigest: canonicalHouseholdRequestDigest(input),
    sourcePackDigest: graph.sourcePackDigest,
  };
  Object.defineProperty(state, internalGovernedAnalyzerBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  const frozen = deepFreeze(state) as GovernedAnalyzerState;
  governedHouseholdSafetyStates.add(frozen);
  return frozen;
}

const inputSubjects = (input: HouseholdDishSafetyInput): readonly SubjectRef[] =>
  sortedSubjects([
    ...input.mealParticipantProfileIds.map((id) =>
      Object.freeze({ kind: "household_profile" as const, id }),
    ),
    ...input.guestParticipants.map((guest) =>
      Object.freeze({ kind: "guest" as const, id: guest.guestId }),
    ),
  ]);

const semanticInputIssue = (
  input: HouseholdDishSafetyInput,
): { readonly code: HouseholdSafetyInputIssueCode; readonly path: string } | null => {
  if (canonicalDishDigest(input.dish) !== input.dish.contentDigest) {
    return Object.freeze({ code: "DISH_DIGEST_MISMATCH", path: "/dish/contentDigest" });
  }
  if (input.dish.exposures.length === 0) {
    return Object.freeze({ code: "EMPTY_DISH_EXPOSURES", path: "/dish/exposures" });
  }
  if (
    input.mealParticipantProfileIds.length === 0 &&
    input.guestParticipants.length === 0
  ) {
    return Object.freeze({ code: "EMPTY_PARTICIPANTS", path: "/mealParticipantProfileIds" });
  }
  const profiles = new Map(input.householdProfiles.map((profile) => [profile.profileId, profile]));
  for (let index = 0; index < input.mealParticipantProfileIds.length; index += 1) {
    const profile = profiles.get(input.mealParticipantProfileIds[index]!);
    if (profile?.status === "archived") {
      return Object.freeze({
        code: "ARCHIVED_PROFILE_REFERENCE",
        path: "/mealParticipantProfileIds/" + index,
      });
    }
  }
  for (let index = 0; index < input.mealParticipantProfileIds.length; index += 1) {
    if (!profiles.has(input.mealParticipantProfileIds[index]!)) {
      return Object.freeze({
        code: "UNKNOWN_PROFILE_REFERENCE",
        path: "/mealParticipantProfileIds/" + index,
      });
    }
  }
  return null;
};

const coverageUnitToken = (unit: InternalCoverageUnitKey): string => {
  if (unit.kind === "dish_exposure") return "0\u0000" + unit.exposureId;
  if (unit.kind === "household_allergy") {
    return "1\u0000" + unit.profileId + "\u0000" + unit.constraintId;
  }
  if (unit.kind === "guest_allergy") {
    return "2\u0000" + unit.guestId + "\u0000" + unit.constraintId;
  }
  return (
    "3\u0000" +
    (unit.subject.kind === "household_profile" ? "0" : "1") +
    "\u0000" +
    unit.subject.id +
    "\u0000" +
    unit.constraintId
  );
};

const buildProductionSelectors = (
  input: HouseholdDishSafetyInput,
): readonly InputSelectorContext[] => {
  const selectors: InputSelectorContext[] = [];
  for (const exposure of input.dish.exposures) {
    selectors.push(
      Object.freeze({
        constraint: null,
        coverageUnitKey: deepFreeze({
          kind: "dish_exposure" as const,
          exposureId: exposure.exposureId,
        }),
        exposure,
        location: "dish_exposure" as const,
        selection: exposure.mapping,
        subject: null,
      }),
    );
  }
  for (const profile of input.householdProfiles) {
    if (profile.status !== "active") continue;
    for (const constraint of profile.constraints) {
      if (constraint.kind !== "allergy") continue;
      selectors.push(
        Object.freeze({
          constraint,
          coverageUnitKey: deepFreeze({
            kind: "household_allergy" as const,
            profileId: profile.profileId,
            constraintId: constraint.constraintId,
          }),
          exposure: null,
          location: "household_allergy" as const,
          selection: constraint.mapping,
          subject: null,
        }),
      );
    }
  }
  for (const guest of input.guestParticipants) {
    for (const constraint of guest.constraints) {
      if (constraint.kind !== "allergy") continue;
      selectors.push(
        Object.freeze({
          constraint,
          coverageUnitKey: deepFreeze({
            kind: "guest_allergy" as const,
            guestId: guest.guestId,
            constraintId: constraint.constraintId,
          }),
          exposure: null,
          location: "guest_allergy" as const,
          selection: constraint.mapping,
          subject: null,
        }),
      );
    }
  }
  const participants = new Set(input.mealParticipantProfileIds);
  for (const profile of input.householdProfiles) {
    if (profile.status !== "active" || !participants.has(profile.profileId)) continue;
    const subject = Object.freeze({
      kind: "household_profile" as const,
      id: profile.profileId,
    });
    for (const constraint of profile.constraints) {
      if (constraint.kind === "allergy") continue;
      const hard =
        constraint.kind === "religious" ||
        constraint.kind === "ethical" ||
        constraint.kind === "explicit_strict_avoid";
      selectors.push(
        Object.freeze({
          constraint,
          coverageUnitKey: hard
            ? deepFreeze({
                kind: "personal_hard" as const,
                subject,
                constraintId: constraint.constraintId,
              })
            : null,
          exposure: null,
          location: hard ? ("personal_hard" as const) : ("soft" as const),
          selection: constraint.mapping,
          subject,
        }),
      );
    }
  }
  for (const guest of input.guestParticipants) {
    const subject = Object.freeze({ kind: "guest" as const, id: guest.guestId });
    for (const constraint of guest.constraints) {
      if (constraint.kind === "allergy") continue;
      const hard =
        constraint.kind === "religious" ||
        constraint.kind === "ethical" ||
        constraint.kind === "explicit_strict_avoid";
      selectors.push(
        Object.freeze({
          constraint,
          coverageUnitKey: hard
            ? deepFreeze({
                kind: "personal_hard" as const,
                subject,
                constraintId: constraint.constraintId,
              })
            : null,
          exposure: null,
          location: hard ? ("personal_hard" as const) : ("soft" as const),
          selection: constraint.mapping,
          subject,
        }),
      );
    }
  }
  return Object.freeze(selectors);
};

const mappedIds = (selection: MappingSelection): readonly string[] =>
  selection.status === "mapped" ? selection.mappingIds : Object.freeze([]);

const referenceEqual = (left: GovernedReference, right: GovernedReference): boolean =>
  governedReferenceText(left) === governedReferenceText(right);

const referenceKey = (reference: GovernedReference): string =>
  governedReferenceText(reference);

const endpointEnvelopes = (
  catalog: GovernanceCatalog,
  endpoint: GovernedReference,
): readonly GovernanceEnvelope[] =>
  catalog.releases.flatMap((release) =>
    release.envelopes.filter(
      (envelope) =>
        envelope.datasetId === endpoint.datasetId &&
        envelope.entityId === endpoint.entityId &&
        envelope.entityRevision === endpoint.entityRevision,
    ),
  );

interface EndpointBindingCandidates {
  readonly structural: readonly ReleaseBinding[];
  readonly current: readonly ReleaseBinding[];
}

type EndpointBindingReduction =
  | { readonly status: "unbound" }
  | { readonly status: "not_current" }
  | { readonly status: "multiple_current" }
  | { readonly status: "selected"; readonly binding: ReleaseBinding };

function structurallyMatchingBindings(
  endpoint: GovernedReference,
  endpointKind: DatasetKind,
  releases: GovernanceCatalog["releases"],
  bindings: readonly ReleaseBinding[],
): readonly ReleaseBinding[] {
  const candidates = bindings.filter((binding) => {
    if (
      binding.datasetId !== endpoint.datasetId ||
      binding.datasetKind !== endpointKind
    ) {
      return false;
    }
    const matchingReleases = releases.filter(
      (release) =>
        release.releaseId === binding.releaseId &&
        release.releaseRevision === binding.releaseRevision &&
        release.contentDigest === binding.releaseDigest,
    );
    if (matchingReleases.length !== 1) return false;
    const envelopes = matchingReleases[0]!.envelopes.filter(
      (envelope) =>
        envelope.datasetId === endpoint.datasetId &&
        envelope.entityId === endpoint.entityId &&
        envelope.entityRevision === endpoint.entityRevision &&
        envelope.datasetKind === endpointKind,
    );
    if (envelopes.length !== 1) return false;
    const envelope = envelopes[0]!;
    const references = envelope.sourceReferences.filter(
      (reference) =>
        reference.referenceId === binding.sourceReferenceId &&
        reference.referenceRevision === binding.sourceReferenceRevision,
    );
    const snapshots = envelope.sourceSnapshots.filter(
      (snapshot) =>
        snapshot.referenceId === binding.sourceReferenceId &&
        snapshot.referenceRevision === binding.sourceReferenceRevision,
    );
    return (
      references.length === 1 &&
      snapshots.length === 1 &&
      references[0]!.locator === snapshots[0]!.locator
    );
  });
  return Object.freeze([...candidates].sort((left, right) => compareUtf8(left.bindingId, right.bindingId)));
}

function currentBindings(
  structural: readonly ReleaseBinding[],
  windows: readonly SourceVersionWindow[],
  asOf: CanonicalInstant,
): EndpointBindingCandidates {
  const current = structural.filter((binding) => {
    const window = windows.find((candidate) => candidate.bindingId === binding.bindingId);
    return (
      window !== undefined &&
      window.effectiveFrom <= asOf &&
      (window.effectiveUntil === null || asOf < window.effectiveUntil)
    );
  });
  return deepFreeze({ structural: [...structural], current });
}

function reduceEndpointBinding(
  candidates: EndpointBindingCandidates,
): EndpointBindingReduction {
  if (candidates.structural.length === 0) return Object.freeze({ status: "unbound" });
  if (candidates.current.length === 0) return Object.freeze({ status: "not_current" });
  if (candidates.current.length > 1) return Object.freeze({ status: "multiple_current" });
  return Object.freeze({ status: "selected", binding: candidates.current[0]! });
}

const selectedEnvelope = (
  graph: InternalNormalizedGovernedGraph,
  endpoint: GovernedReference,
  reduction: EndpointBindingReduction,
): GovernanceEnvelope | null => {
  if (reduction.status !== "selected") return null;
  const release = graph.catalog.releases.find(
    (candidate) =>
      candidate.releaseId === reduction.binding.releaseId &&
      candidate.releaseRevision === reduction.binding.releaseRevision &&
      candidate.contentDigest === reduction.binding.releaseDigest,
  );
  return (
    release?.envelopes.find(
      (envelope) =>
        envelope.datasetId === endpoint.datasetId &&
        envelope.entityId === endpoint.entityId &&
        envelope.entityRevision === endpoint.entityRevision,
    ) ?? null
  );
};

interface MappingEndpointPrecomputation {
  readonly mappingId: string;
  readonly source: EndpointBindingReduction;
  readonly sourceEnvelope: GovernanceEnvelope | null;
  readonly target: EndpointBindingReduction;
  readonly targetEnvelope: GovernanceEnvelope | null;
}

const precomputeMappingEndpoints = (
  graph: InternalNormalizedGovernedGraph,
  mappingId: string,
): MappingEndpointPrecomputation | null => {
  const mappings = graph.catalog.hardMappings.filter((mapping) => mapping.mappingId === mappingId);
  if (mappings.length !== 1) return null;
  const mapping = mappings[0]!;
  const sourceEnvelope = endpointEnvelopes(graph.catalog, mapping.source)[0];
  const targetEnvelope = endpointEnvelopes(graph.catalog, mapping.target)[0];
  if (sourceEnvelope === undefined || targetEnvelope === undefined) return null;
  const source = reduceEndpointBinding(
    currentBindings(
      structurallyMatchingBindings(
        mapping.source,
        sourceEnvelope.datasetKind,
        graph.catalog.releases,
        graph.releaseBindings,
      ),
      graph.sourceVersionWindows,
      graphAsOf.get(graph)!,
    ),
  );
  const target = reduceEndpointBinding(
    currentBindings(
      structurallyMatchingBindings(
        mapping.target,
        targetEnvelope.datasetKind,
        graph.catalog.releases,
        graph.releaseBindings,
      ),
      graph.sourceVersionWindows,
      graphAsOf.get(graph)!,
    ),
  );
  return Object.freeze({
    mappingId,
    source,
    sourceEnvelope: selectedEnvelope(graph, mapping.source, source),
    target,
    targetEnvelope: selectedEnvelope(graph, mapping.target, target),
  });
};

const graphAsOf = new WeakMap<InternalNormalizedGovernedGraph, CanonicalInstant>();

const selectorReason = (
  selector: InputSelectorContext,
  code: HouseholdSafetyReasonCode,
  mappingId: string | null = null,
  endpoint: "source" | "target" | null = null,
  fact = false,
): HouseholdSafetyReason => {
  if (selector.location === "dish_exposure") {
    return reason(code, "table", {
      exposureId: selector.exposure!.exposureId,
      exposureKind: selector.exposure!.kind,
      exposureMappingId: fact ? mappingId : null,
      mappingEndpoint: endpoint,
      mappingId: fact ? null : mappingId,
    });
  }
  if (
    selector.location === "household_allergy" ||
    selector.location === "guest_allergy"
  ) {
    return reason(code, "table", {
      mappingEndpoint: endpoint,
      mappingId,
    });
  }
  return reason(code, selector.location === "soft" ? "soft" : "subject", {
    constraintId: selector.constraint!.constraintId,
    mappingEndpoint: endpoint,
    mappingId,
    subject: selector.subject,
  });
};

const endpointBindingReason = (
  selector: InputSelectorContext,
  mappingId: string,
  endpoint: "source" | "target",
  reduction: EndpointBindingReduction,
): HouseholdSafetyReason | null => {
  if (reduction.status === "selected") return null;
  if (reduction.status === "not_current") {
    return selectorReason(
      selector,
      "mapping_endpoint_not_current",
      mappingId,
      endpoint,
    );
  }
  if (reduction.status === "multiple_current") {
    return selectorReason(
      selector,
      endpoint === "source"
        ? "mapping_source_multiple_bindings"
        : "mapping_target_multiple_bindings",
      mappingId,
      endpoint,
    );
  }
  return selectorReason(
    selector,
    endpoint === "source" ? "mapping_source_unbound" : "mapping_target_unbound",
    mappingId,
    endpoint,
  );
};

const selectorTargetKindValid = (
  selector: InputSelectorContext,
  targetKind: DatasetKind,
): boolean => {
  if (selector.location === "dish_exposure") {
    return (
      targetKind === "food_concept" ||
      targetKind === "allergen" ||
      targetKind === "religious_ethical"
    );
  }
  if (
    selector.location === "household_allergy" ||
    selector.location === "guest_allergy"
  ) {
    return targetKind === "allergen";
  }
  const kind = selector.constraint!.kind;
  if (kind === "religious" || kind === "ethical") {
    return targetKind === "food_concept" || targetKind === "religious_ethical";
  }
  return targetKind === "food_concept";
};

const mappingFindingIndex = (
  analysis: HouseholdCatalogAnalysis,
): ReadonlyMap<string, readonly CatalogFinding[]> | null => {
  const grouped = new Map<string, CatalogFinding[]>();
  for (const finding of analysis.mappingFindings) {
    if (
      finding.scope !== "mapping" ||
      finding.mappingId === undefined ||
      !identifierPattern.test(finding.mappingId)
    ) {
      return null;
    }
    const values = grouped.get(finding.mappingId) ?? [];
    values.push(finding);
    grouped.set(finding.mappingId, values);
  }
  return grouped;
};

const packStructureCarrier = (
  graph: InternalNormalizedGovernedGraph,
  lifecycleStatus: LifecycleStatus,
): HouseholdSafetySourcePack =>
  deepFreeze({
    schemaVersion: 2 as const,
    packId: graph.packId,
    packRevision: graph.packRevision,
    contentDigest: graph.sourcePackDigest,
    lifecycleStatus,
    country: graph.country,
    foodRuleRegion: graph.foodRuleRegion,
    ruleLanguage: graph.ruleLanguage,
    releaseBindings: graph.releaseBindings,
    sourceVersionWindows: graph.sourceVersionWindows,
    mappingReviews: graph.mappingReviews,
    catalog: graph.catalog,
  });

const syntheticGraphFactClosure = (
  graph: InternalSyntheticGovernedGraph,
  analysis: HouseholdCatalogAnalysis,
): ReadonlyMap<string, SourceFactDisposition> | null => {
  const badIds = new Set(analysis.mappingFindings.map((finding) => finding.mappingId));
  const required = new Set<string>();
  for (const mapping of graph.catalog.hardMappings) {
    if (badIds.has(mapping.mappingId)) continue;
    required.add(referenceKey(mapping.source));
    required.add(referenceKey(mapping.target));
  }
  const facts = new Map<string, SourceFactDisposition>();
  for (const fact of graph.endpointFacts) {
    const key = referenceKey(fact.reference);
    if (facts.has(key)) return null;
    facts.set(key, fact.syntheticDisposition);
  }
  if (facts.size !== required.size) return null;
  for (const key of required) if (!facts.has(key)) return null;
  for (const key of facts.keys()) if (!required.has(key)) return null;
  return facts;
};

const normalizeSyntheticGraph = (
  graph: InternalSyntheticGovernedGraph,
  sourcePackDigest: Digest,
): InternalNormalizedGovernedGraph =>
  deepFreeze({
    packId: graph.packId,
    packRevision: graph.packRevision,
    sourcePackDigest,
    country: graph.country,
    foodRuleRegion: graph.foodRuleRegion,
    ruleLanguage: graph.ruleLanguage,
    sourceUsageApproved: graph.syntheticSourceUsageStatus === "approved",
    releaseBindings: graph.releaseBindings,
    sourceVersionWindows: graph.sourceVersionWindows,
    mappingReviews: graph.mappingReviews,
    catalog: graph.catalog,
    endpointFacts: graph.endpointFacts.map((fact) =>
      Object.freeze({
        reference: fact.reference,
        disposition: fact.syntheticDisposition,
      }),
    ),
  });

const normalizeOfficialPack = (
  pack: HouseholdSafetySourcePack,
  sourcePackDigest: Digest,
): InternalNormalizedGovernedGraph => {
  const facts = new Map<string, InternalNormalizedEndpointFact>();
  for (const release of pack.catalog.releases) {
    for (const envelope of release.envelopes) {
      const official = envelope.officialEvidence;
      if (official === undefined) continue;
      const reference = Object.freeze({
        datasetId: envelope.datasetId,
        entityId: envelope.entityId,
        entityRevision: envelope.entityRevision,
      });
      const key = referenceKey(reference);
      if (!facts.has(key)) {
        facts.set(
          key,
          Object.freeze({ reference, disposition: official.factDisposition }),
        );
      }
    }
  }
  return deepFreeze({
    packId: pack.packId,
    packRevision: pack.packRevision,
    sourcePackDigest,
    country: pack.country,
    foodRuleRegion: pack.foodRuleRegion,
    ruleLanguage: pack.ruleLanguage,
    sourceUsageApproved: true,
    releaseBindings: pack.releaseBindings,
    sourceVersionWindows: pack.sourceVersionWindows,
    mappingReviews: pack.mappingReviews,
    catalog: pack.catalog,
    endpointFacts: [...facts.values()],
  });
};

const exactWindowCardinalityReason = (
  graph: InternalNormalizedGovernedGraph,
): "source_version_window_missing" | "source_version_window_ambiguous" | null => {
  let missing = false;
  let ambiguous = false;
  for (const binding of graph.releaseBindings) {
    const count = graph.sourceVersionWindows.filter(
      (window) => window.bindingId === binding.bindingId,
    ).length;
    if (count === 0) missing = true;
    if (count > 1) ambiguous = true;
  }
  if (missing) return "source_version_window_missing";
  return ambiguous ? "source_version_window_ambiguous" : null;
};

const requestedMappingIds = (
  selectors: readonly InputSelectorContext[],
): readonly string[] => {
  const ids = new Set<string>();
  for (const selector of selectors) {
    if (selector.selection.status !== "mapped") continue;
    for (const mappingId of selector.selection.mappingIds) ids.add(mappingId);
  }
  return Object.freeze([...ids].sort(compareUtf8));
};

const reduceSelectedEndpointApplicability = (
  computations: ReadonlyMap<string, MappingEndpointPrecomputation>,
  region: string,
  language: string,
): "applicable" | "region_not_applicable" | "language_not_applicable" => {
  const selected: GovernanceEnvelope[] = [];
  for (const mappingId of [...computations.keys()].sort(compareUtf8)) {
    const value = computations.get(mappingId)!;
    if (value.source.status === "selected" && value.sourceEnvelope !== null) {
      selected.push(value.sourceEnvelope);
    }
    if (value.target.status === "selected" && value.targetEnvelope !== null) {
      selected.push(value.targetEnvelope);
    }
  }
  if (selected.some((envelope) => !envelope.applicableRegions.includes(region))) {
    return "region_not_applicable";
  }
  if (selected.some((envelope) => !envelope.languages.includes(language))) {
    return "language_not_applicable";
  }
  return "applicable";
};

const factDisposition = (
  graph: InternalNormalizedGovernedGraph,
  reference: GovernedReference,
): SourceFactDisposition | null =>
  graph.endpointFacts.find((fact) => referenceEqual(fact.reference, reference))
    ?.disposition ?? null;

interface EvaluationReasonBuckets {
  readonly tableKnownHardReasons: HouseholdSafetyReason[];
  readonly tableUncertaintyReasons: HouseholdSafetyReason[];
  readonly subjectKnownHardReasons: HouseholdSafetyReason[];
  readonly subjectUncertaintyReasons: HouseholdSafetyReason[];
  readonly softReasons: HouseholdSafetyReason[];
}

const addSelectorFailure = (
  buckets: EvaluationReasonBuckets,
  coverage: Map<string, InternalCoverageResolution>,
  selector: InputSelectorContext,
  value: HouseholdSafetyReason,
): void => {
  if (value.scope === "table") buckets.tableUncertaintyReasons.push(value);
  else if (value.scope === "subject") buckets.subjectUncertaintyReasons.push(value);
  else buckets.softReasons.push(value);
  if (selector.coverageUnitKey !== null) {
    coverage.get(coverageUnitToken(selector.coverageUnitKey))!.ownFailures.push(value);
  }
};

const mapM0Failure = (
  status: HardMappingResolution["status"],
): HouseholdSafetyReasonCode => {
  if (status === "withdrawn") return "mapping_withdrawn";
  if (status === "version_mismatch") return "mapping_version_mismatch";
  if (status === "unapproved") return "mapping_unapproved";
  return "mapping_invalid";
};

const reviewReduction = (
  selector: InputSelectorContext,
  mappingId: string,
  mapping: GovernanceCatalog["hardMappings"][number],
  precomputation: MappingEndpointPrecomputation,
  reviews: readonly MappingReview[],
  asOf: CanonicalInstant,
): { readonly reasons: readonly HouseholdSafetyReason[]; readonly usable: boolean } => {
  const findings: HouseholdSafetyReason[] = [];
  if (reviews.length === 0) {
    findings.push(selectorReason(selector, "mapping_review_missing", mappingId));
    return Object.freeze({ reasons: Object.freeze(findings), usable: false });
  }
  const maxRevision = Math.max(...reviews.map((review) => review.reviewRevision));
  const latest = reviews.filter((review) => review.reviewRevision === maxRevision);
  if (latest.length !== 1) {
    findings.push(selectorReason(selector, "mapping_review_mismatch", mappingId));
    return Object.freeze({ reasons: Object.freeze(findings), usable: false });
  }
  const review = latest[0]!;
  let mismatch =
    review.contentDigest !== canonicalMappingReviewDigest(review) ||
    !referenceEqual(review.source, mapping.source) ||
    !referenceEqual(review.target, mapping.target) ||
    review.required !== mapping.required;
  if (
    precomputation.source.status === "selected" &&
    precomputation.target.status === "selected"
  ) {
    mismatch =
      mismatch ||
      review.sourceBindingId !== precomputation.source.binding.bindingId ||
      review.targetBindingId !== precomputation.target.binding.bindingId;
  }
  if (mismatch) {
    findings.push(selectorReason(selector, "mapping_review_mismatch", mappingId));
  }
  const current =
    review.reviewStatus === "reviewed" &&
    review.effectiveFrom !== null &&
    review.effectiveFrom <= asOf &&
    (review.effectiveUntil === null || asOf < review.effectiveUntil);
  if (!current) {
    findings.push(selectorReason(selector, "mapping_review_not_current", mappingId));
  }
  return Object.freeze({
    reasons: Object.freeze(findings),
    usable: !mismatch && current,
  });
};

interface PositiveSelectorContribution {
  readonly selector: InputSelectorContext;
  readonly mappingId: string;
  readonly target: GovernedReference;
}

const knownMatchReason = (
  constraintContribution: PositiveSelectorContribution,
  exposureContribution: PositiveSelectorContribution,
): HouseholdSafetyReason => {
  const selector = constraintContribution.selector;
  const exposure = exposureContribution.selector.exposure!;
  const common = {
    constraintId:
      selector.location === "household_allergy" || selector.location === "guest_allergy"
        ? null
        : selector.constraint!.constraintId,
    constraintMappingId: constraintContribution.mappingId,
    exposureId: exposure.exposureId,
    exposureKind: exposure.kind,
    exposureMappingId: exposureContribution.mappingId,
    subject: selector.subject,
  };
  if (selector.location === "household_allergy") {
    return reason("household_allergy_match", "table", common);
  }
  if (selector.location === "guest_allergy") {
    return reason("guest_allergy_match", "table", common);
  }
  if (selector.location === "personal_hard") {
    const code =
      selector.constraint!.kind === "religious"
        ? "personal_religious_match"
        : selector.constraint!.kind === "ethical"
          ? "personal_ethical_match"
          : "personal_strict_avoid_match";
    return reason(code, "subject", common);
  }
  const code =
    selector.constraint!.kind === "ordinary_avoid"
      ? "soft_ordinary_avoid_match"
      : selector.constraint!.kind === "dislike"
        ? "soft_dislike_match"
        : "soft_reduce_match";
  return reason(code, "soft", common);
};

const evaluateGovernedAnalyzer = (
  state: GovernedAnalyzerState,
): HouseholdDishSafetyEvaluation => {
  if (
    !governedHouseholdSafetyStates.has(state) ||
    Reflect.get(state, internalGovernedAnalyzerBrand) !== true
  ) {
    throw new TypeError("Invalid internal governed household safety graph");
  }
  const { input, graph, catalogAnalysis } = state;
  const subjects = inputSubjects(input);
  if (
    input.expectedSourcePack.packId !== graph.packId ||
    input.expectedSourcePack.packRevision !== graph.packRevision ||
    input.expectedSourcePack.contentDigest !== graph.sourcePackDigest
  ) {
    return terminalEvaluation(
      "source_pack_version_drift",
      "source_pack",
      state.requestDigest,
      state.sourcePackDigest,
      subjects,
    );
  }
  const windowReason = exactWindowCardinalityReason(graph);
  if (windowReason !== null) {
    return terminalEvaluation(
      windowReason,
      "source_pack",
      state.requestDigest,
      state.sourcePackDigest,
      subjects,
    );
  }
  const findingIndex = mappingFindingIndex(catalogAnalysis);
  if (findingIndex === null) {
    return terminalEvaluation(
      "source_pack_invalid",
      "source_pack",
      state.requestDigest,
      state.sourcePackDigest,
      subjects,
    );
  }
  const selectors = buildProductionSelectors(input);
  const computations = new Map<string, MappingEndpointPrecomputation>();
  graphAsOf.set(graph, input.asOf);
  for (const mappingId of requestedMappingIds(selectors)) {
    if ((findingIndex.get(mappingId)?.length ?? 0) > 0) continue;
    const matches = graph.catalog.hardMappings.filter(
      (mapping) => mapping.mappingId === mappingId,
    );
    if (matches.length !== 1) continue;
    const computed = precomputeMappingEndpoints(graph, mappingId);
    if (computed !== null) computations.set(mappingId, computed);
  }
  const applicability = reduceSelectedEndpointApplicability(
    computations,
    graph.foodRuleRegion,
    graph.ruleLanguage,
  );
  if (applicability === "region_not_applicable") {
    return terminalEvaluation(
      "source_pack_region_not_applicable",
      "source_pack",
      state.requestDigest,
      state.sourcePackDigest,
      subjects,
    );
  }
  if (applicability === "language_not_applicable") {
    return terminalEvaluation(
      "source_pack_language_not_applicable",
      "source_pack",
      state.requestDigest,
      state.sourcePackDigest,
      subjects,
    );
  }
  if (catalogAnalysis.sourceLicenseNotApproved || !graph.sourceUsageApproved) {
    return terminalEvaluation(
      "source_license_not_approved",
      "source_pack",
      state.requestDigest,
      state.sourcePackDigest,
      subjects,
    );
  }

  const contextResult = decodeActivationContext({
    asOf: input.asOf,
    language: graph.ruleLanguage,
    region: graph.foodRuleRegion,
  });
  if (!contextResult.ok) {
    return terminalEvaluation(
      "source_pack_invalid",
      "source_pack",
      state.requestDigest,
      state.sourcePackDigest,
      subjects,
    );
  }
  const m0Resolutions = new Map<string, HardMappingResolution>();
  for (const mappingId of requestedMappingIds(selectors)) {
    if ((findingIndex.get(mappingId)?.length ?? 0) > 0) continue;
    if (
      graph.catalog.hardMappings.filter((mapping) => mapping.mappingId === mappingId)
        .length !== 1
    ) {
      continue;
    }
    m0Resolutions.set(
      mappingId,
      resolveHardMapping(graph.catalog, mappingId, contextResult.value),
    );
  }

  const coverage = new Map<string, InternalCoverageResolution>();
  for (const selector of selectors) {
    if (selector.coverageUnitKey === null) continue;
    const token = coverageUnitToken(selector.coverageUnitKey);
    coverage.set(token, {
      unit: selector.coverageUnitKey,
      clearSupported: false,
      ownFailures: [],
      knownHardAccounted: false,
    });
  }
  const buckets: EvaluationReasonBuckets = {
    tableKnownHardReasons: [],
    tableUncertaintyReasons: [],
    subjectKnownHardReasons: [],
    subjectUncertaintyReasons: [],
    softReasons: [],
  };
  const positiveContributions: PositiveSelectorContribution[] = [];

  for (const selector of selectors) {
    if (selector.selection.status === "unknown") {
      addSelectorFailure(
        buckets,
        coverage,
        selector,
        selectorReason(selector, "mapping_unknown"),
      );
      continue;
    }
    if (selector.selection.status === "ambiguous") {
      addSelectorFailure(
        buckets,
        coverage,
        selector,
        selectorReason(selector, "mapping_ambiguous"),
      );
      continue;
    }
    for (const mappingId of selector.selection.mappingIds) {
      const classifierFindings = findingIndex.get(mappingId) ?? Object.freeze([]);
      const mappings = graph.catalog.hardMappings.filter(
        (mapping) => mapping.mappingId === mappingId,
      );
      if (classifierFindings.length > 0 || mappings.length !== 1) {
        addSelectorFailure(
          buckets,
          coverage,
          selector,
          selectorReason(selector, "mapping_invalid", mappingId),
        );
        continue;
      }
      const mapping = mappings[0]!;
      const m0 = m0Resolutions.get(mappingId);
      if (m0 === undefined || m0.status !== "mapped") {
        addSelectorFailure(
          buckets,
          coverage,
          selector,
          selectorReason(
            selector,
            mapM0Failure(m0?.status ?? "unmapped"),
            mappingId,
          ),
        );
        continue;
      }
      const precomputation = computations.get(mappingId);
      if (precomputation === undefined) {
        addSelectorFailure(
          buckets,
          coverage,
          selector,
          selectorReason(selector, "mapping_invalid", mappingId),
        );
        continue;
      }

      const prerequisiteReasons: HouseholdSafetyReason[] = [];
      if (!mapping.required) {
        prerequisiteReasons.push(
          selectorReason(selector, "mapping_required_false", mappingId),
        );
      }
      if (!selectorTargetKindValid(selector, m0.target.datasetKind)) {
        prerequisiteReasons.push(
          selectorReason(selector, "mapping_target_kind_mismatch", mappingId),
        );
      }
      const sourceBindingFinding = endpointBindingReason(
        selector,
        mappingId,
        "source",
        precomputation.source,
      );
      const targetBindingFinding = endpointBindingReason(
        selector,
        mappingId,
        "target",
        precomputation.target,
      );
      if (sourceBindingFinding !== null) prerequisiteReasons.push(sourceBindingFinding);
      if (targetBindingFinding !== null) prerequisiteReasons.push(targetBindingFinding);
      const review = reviewReduction(
        selector,
        mappingId,
        mapping,
        precomputation,
        graph.mappingReviews.filter((value) => value.mappingId === mappingId),
        input.asOf,
      );
      prerequisiteReasons.push(...review.reasons);

      const sourceDisposition = factDisposition(graph, mapping.source);
      const targetDisposition = factDisposition(graph, mapping.target);
      const factReasons: HouseholdSafetyReason[] = [];
      if (sourceDisposition === null || sourceDisposition === "UNKNOWN_BLOCK") {
        factReasons.push(
          selectorReason(selector, "source_fact_unknown", mappingId, "source", true),
        );
      } else if (sourceDisposition === "CANDIDATE_CLEAR") {
        factReasons.push(
          selectorReason(
            selector,
            "source_fact_candidate_clear",
            mappingId,
            "source",
            true,
          ),
        );
      }
      if (targetDisposition === null || targetDisposition === "UNKNOWN_BLOCK") {
        factReasons.push(
          selectorReason(selector, "source_fact_unknown", mappingId, "target", true),
        );
      } else if (targetDisposition === "CANDIDATE_CLEAR") {
        factReasons.push(
          selectorReason(
            selector,
            "source_fact_candidate_clear",
            mappingId,
            "target",
            true,
          ),
        );
      }
      for (const value of [...prerequisiteReasons, ...factReasons]) {
        addSelectorFailure(buckets, coverage, selector, value);
      }
      const prerequisitesUsable =
        prerequisiteReasons.length === 0 &&
        precomputation.source.status === "selected" &&
        precomputation.target.status === "selected" &&
        review.usable;
      if (!prerequisitesUsable || factReasons.length > 0) continue;
      if (
        sourceDisposition === "REVIEWED_CLEAR" &&
        targetDisposition === "REVIEWED_CLEAR" &&
        selector.coverageUnitKey !== null
      ) {
        coverage.get(coverageUnitToken(selector.coverageUnitKey))!.clearSupported = true;
      }
      if (
        sourceDisposition === "POSITIVE_BLOCK" ||
        targetDisposition === "POSITIVE_BLOCK"
      ) {
        positiveContributions.push(
          Object.freeze({ selector, mappingId, target: mapping.target }),
        );
      }
    }
  }

  const exposureContributions = positiveContributions.filter(
    (value) => value.selector.location === "dish_exposure",
  );
  for (const constraintContribution of positiveContributions) {
    if (constraintContribution.selector.location === "dish_exposure") continue;
    for (const exposureContribution of exposureContributions) {
      if (!referenceEqual(constraintContribution.target, exposureContribution.target)) {
        continue;
      }
      const value = knownMatchReason(constraintContribution, exposureContribution);
      if (value.scope === "table") buckets.tableKnownHardReasons.push(value);
      else if (value.scope === "subject") buckets.subjectKnownHardReasons.push(value);
      else buckets.softReasons.push(value);
      if (constraintContribution.selector.location !== "soft") {
        for (const selector of [
          constraintContribution.selector,
          exposureContribution.selector,
        ]) {
          if (selector.coverageUnitKey !== null) {
            coverage.get(coverageUnitToken(selector.coverageUnitKey))!
              .knownHardAccounted = true;
          }
        }
      }
    }
  }

  const scenario = (): InternalSyntheticAnalyzedScenario =>
    Object.freeze({
      schemaVersion: 1,
      subjects,
      tableKnownHardReasons: sortedReasons(buckets.tableKnownHardReasons),
      tableUncertaintyReasons: sortedReasons(buckets.tableUncertaintyReasons),
      subjectKnownHardReasons: sortedReasons(buckets.subjectKnownHardReasons),
      subjectUncertaintyReasons: sortedReasons(buckets.subjectUncertaintyReasons),
      softReasons: sortedReasons(buckets.softReasons),
    });
  const provisional = evaluateAnalyzedHouseholdSafety(
    scenario(),
    state.requestDigest,
    state.sourcePackDigest,
  );
  if (provisional.tableStatus === "allowed") {
    const unresolved = [...coverage.values()]
      .filter(
        (entry) =>
          !entry.clearSupported &&
          entry.ownFailures.length === 0 &&
          !entry.knownHardAccounted,
      )
      .sort((left, right) =>
        compareUtf8(coverageUnitToken(left.unit), coverageUnitToken(right.unit)),
      );
    if (unresolved.some((entry) => entry.unit.kind !== "personal_hard")) {
      buckets.tableUncertaintyReasons.push(
        reason("source_reviewed_clear_missing", "source_pack"),
      );
    }
    for (const entry of unresolved) {
      if (entry.unit.kind !== "personal_hard") continue;
      buckets.subjectUncertaintyReasons.push(
        reason("source_reviewed_clear_missing", "subject", {
          constraintId: entry.unit.constraintId,
          subject: entry.unit.subject,
        }),
      );
    }
  }
  return evaluateAnalyzedHouseholdSafety(
    scenario(),
    state.requestDigest,
    state.sourcePackDigest,
  );
};

const inputFailureEvaluation = (
  input: unknown,
): {
  readonly evaluation: HouseholdDishSafetyEvaluation | null;
  readonly input: HouseholdDishSafetyInput | null;
} => {
  const decoded = decodeHouseholdDishSafetyInput(input);
  if (!decoded.ok) {
    return Object.freeze({
      evaluation: terminalEvaluation(
        "input_invalid",
        "input",
        null,
        null,
        [],
        decoded.issue,
      ),
      input: null,
    });
  }
  const issue = semanticInputIssue(decoded.value);
  if (issue !== null) {
    return Object.freeze({
      evaluation: terminalEvaluation(
        "input_invalid",
        "input",
        null,
        null,
        [],
        issue,
      ),
      input: null,
    });
  }
  return Object.freeze({ evaluation: null, input: decoded.value });
};

export const __testOnlyEvaluateGovernedHouseholdSafetyScenario = (
  input: unknown,
  graph: unknown,
): HouseholdDishSafetyEvaluation => {
  const inputBoundary = inputFailureEvaluation(input);
  if (inputBoundary.evaluation !== null) return inputBoundary.evaluation;
  const normalizedInput = inputBoundary.input!;
  const decodedGraph = decodeInternalSyntheticGovernedGraph(graph);
  if (!decodedGraph.ok) {
    throw new TypeError("Invalid internal governed household safety graph");
  }
  const sourcePackDigest = canonicalSyntheticGovernedGraphDigest(decodedGraph.value);
  const normalizedGraph = normalizeSyntheticGraph(decodedGraph.value, sourcePackDigest);
  const catalogAnalysis = analyzeHouseholdSafetyOfficialCatalogFindings(
    INTERNAL_SYNTHETIC_CLASSIFIER_LIFECYCLE,
    decodedGraph.value.catalog,
  );
  const subjects = inputSubjects(normalizedInput);
  if (
    catalogAnalysis.fatalFindings.length > 0 ||
    mappingFindingIndex(catalogAnalysis) === null ||
    analyzeHouseholdSafetySourcePackStructure(
      packStructureCarrier(normalizedGraph, INTERNAL_SYNTHETIC_CLASSIFIER_LIFECYCLE),
    ).length > 0 ||
    syntheticGraphFactClosure(decodedGraph.value, catalogAnalysis) === null
  ) {
    return terminalEvaluation(
      "source_pack_invalid",
      "source_pack",
      canonicalHouseholdRequestDigest(normalizedInput),
      sourcePackDigest,
      subjects,
    );
  }
  return evaluateGovernedAnalyzer(
    buildProductionGovernedState(normalizedInput, normalizedGraph, catalogAnalysis),
  );
};

export function evaluateHouseholdDishSafety(
  input: unknown,
  sourcePack: unknown,
): HouseholdDishSafetyEvaluation {
  const inputBoundary = inputFailureEvaluation(input);
  if (inputBoundary.evaluation !== null) return inputBoundary.evaluation;
  const normalizedInput = inputBoundary.input!;
  const requestDigest = canonicalHouseholdRequestDigest(normalizedInput);
  const subjects = inputSubjects(normalizedInput);
  if (sourcePack === null) {
    return terminalEvaluation(
      "source_pack_missing",
      "source_pack",
      requestDigest,
      null,
      subjects,
    );
  }
  const decodedPack = decodeHouseholdSafetySourcePack(sourcePack);
  if (!decodedPack.ok) {
    return terminalEvaluation(
      "source_pack_invalid",
      "source_pack",
      requestDigest,
      null,
      subjects,
    );
  }
  const pack = decodedPack.value;
  let sourcePackDigest: Digest;
  try {
    sourcePackDigest = canonicalHouseholdSafetyPackDigest(pack);
  } catch {
    return terminalEvaluation(
      "source_pack_invalid",
      "source_pack",
      requestDigest,
      null,
      subjects,
    );
  }
  if (sourcePackDigest !== pack.contentDigest) {
    return terminalEvaluation(
      "source_pack_invalid",
      "source_pack",
      requestDigest,
      null,
      subjects,
    );
  }
  const catalogAnalysis = analyzeHouseholdSafetyOfficialCatalogFindings(
    pack.lifecycleStatus,
    pack.catalog,
  );
  const normalizedGraph = normalizeOfficialPack(pack, sourcePackDigest);
  if (
    catalogAnalysis.fatalFindings.length > 0 ||
    mappingFindingIndex(catalogAnalysis) === null ||
    analyzeHouseholdSafetySourcePackStructure(pack).length > 0
  ) {
    return terminalEvaluation(
      "source_pack_invalid",
      "source_pack",
      requestDigest,
      sourcePackDigest,
      subjects,
    );
  }
  if (pack.lifecycleStatus === "withdrawn") {
    return terminalEvaluation(
      "source_pack_withdrawn",
      "source_pack",
      requestDigest,
      sourcePackDigest,
      subjects,
    );
  }
  if (pack.lifecycleStatus !== "active") {
    return terminalEvaluation(
      "source_pack_not_active",
      "source_pack",
      requestDigest,
      sourcePackDigest,
      subjects,
    );
  }
  if (!TRUSTED_ACTIVE_HOUSEHOLD_SAFETY_PACK_DIGESTS.includes(sourcePackDigest)) {
    return terminalEvaluation(
      "source_pack_untrusted",
      "source_pack",
      requestDigest,
      sourcePackDigest,
      subjects,
    );
  }
  return evaluateGovernedAnalyzer(
    buildProductionGovernedState(normalizedInput, normalizedGraph, catalogAnalysis),
  );
}
