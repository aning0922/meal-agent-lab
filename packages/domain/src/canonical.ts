import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { decodeGovernanceRelease, decodeJsonScalarClosure } from "./decode.js";
import type {
  DecodedGovernanceRelease,
  Digest,
  DishExposure,
  DishSafetyFacts,
  HouseholdDishSafetyEvaluation,
  HouseholdDishSafetyInput,
  HouseholdProfileSafetyFacts,
  HouseholdSafetyReason,
  HouseholdSafetySourcePack,
  InternalSyntheticAnalyzedScenario,
  InternalSyntheticGovernedGraph,
  JsonValue,
  MappingReview,
  MappingSelection,
  ReleaseDigestResult,
  SubjectSuitability,
} from "./types.js";

export const compareUtf8 = (left: string, right: string): number => {
  const decodedLeft = decodeJsonScalarClosure(left);
  const decodedRight = decodeJsonScalarClosure(right);
  if (
    !decodedLeft.ok ||
    typeof decodedLeft.value !== "string" ||
    !decodedRight.ok ||
    typeof decodedRight.value !== "string"
  ) {
    throw new TypeError("INVALID_CANONICAL_INPUT");
  }
  const leftBytes = utf8ToBytes(decodedLeft.value);
  const rightBytes = utf8ToBytes(decodedRight.value);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

const canonicalValue = (value: JsonValue): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(record).sort(compareUtf8);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key] as JsonValue)}`)
    .join(",")}}`;
};

const digestText = (text: string): Digest =>
  `sha256:${bytesToHex(sha256(utf8ToBytes(text)))}`;

export const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
};

/** Canonicalizes only values accepted by decode.ts's shared scalar closure. */
export const canonicalJson = (value: unknown): string => {
  const decoded = decodeJsonScalarClosure(value);
  if (!decoded.ok) throw new TypeError("INVALID_CANONICAL_INPUT");
  return canonicalValue(decoded.value);
};

const releaseMaterial = (release: DecodedGovernanceRelease): JsonValue =>
  ({
    ...(release.$schema === undefined ? {} : { $schema: release.$schema }),
    schemaVersion: release.schemaVersion,
    releaseId: release.releaseId,
    releaseRevision: release.releaseRevision,
    envelopes: release.envelopes,
  }) as unknown as JsonValue;

const canonicalReleaseTextFromDecoded = (release: DecodedGovernanceRelease): string =>
  canonicalValue(releaseMaterial(release));

/** The release's own contentDigest is the sole excluded field, preventing self-reference. */
export const canonicalReleaseText = (value: unknown): string => {
  const decoded = decodeGovernanceRelease(value);
  if (!decoded.ok) throw new TypeError("INVALID_RELEASE");
  return canonicalReleaseTextFromDecoded(decoded.value);
};

const digestDecodedRelease = (release: DecodedGovernanceRelease): string =>
  digestText(canonicalReleaseTextFromDecoded(release));

export const canonicalReleaseDigest = (value: unknown): string => {
  const decoded = decodeGovernanceRelease(value);
  if (!decoded.ok) throw new TypeError("INVALID_RELEASE");
  return digestDecodedRelease(decoded.value);
};

export const verifyGovernanceReleaseDigest = (value: unknown): ReleaseDigestResult => {
  const decoded = decodeGovernanceRelease(value);
  if (!decoded.ok) return Object.freeze({ ok: false, code: "INVALID_SHAPE" });
  const digest = digestDecodedRelease(decoded.value);
  return digest === decoded.value.contentDigest
    ? Object.freeze({ ok: true, digest })
    : Object.freeze({ ok: false, code: "RELEASE_DIGEST_MISMATCH" });
};

const byIdentifier = <T>(read: (value: T) => string) => (left: T, right: T): number =>
  compareUtf8(read(left), read(right));

const framedDigest = (domainTag: string, material: unknown): Digest => {
  const domain = utf8ToBytes(domainTag);
  const text = utf8ToBytes(canonicalJson(material));
  const framed = new Uint8Array(domain.length + 1 + text.length);
  framed.set(domain, 0);
  framed[domain.length] = 0;
  framed.set(text, domain.length + 1);
  return `sha256:${bytesToHex(sha256(framed))}`;
};

const normalizedMappingSelection = (selection: MappingSelection): unknown => {
  if (selection.status === "mapped") {
    return { status: "mapped", mappingIds: [...selection.mappingIds].sort(compareUtf8) };
  }
  if (selection.status === "ambiguous") {
    return {
      status: "ambiguous",
      candidateMappingIds: [...selection.candidateMappingIds].sort(compareUtf8),
    };
  }
  return { status: "unknown" };
};

const normalizedConstraints = (profile: HouseholdProfileSafetyFacts): readonly unknown[] =>
  [...profile.constraints]
    .sort(byIdentifier((constraint) => constraint.constraintId))
    .map((constraint) => ({
      constraintId: constraint.constraintId,
      kind: constraint.kind,
      basis: constraint.basis,
      mapping: normalizedMappingSelection(constraint.mapping),
    }));

const normalizedExposure = (exposure: DishExposure): unknown => ({
  exposureId: exposure.exposureId,
  kind: exposure.kind,
  mapping: normalizedMappingSelection(exposure.mapping),
});

export const canonicalDishMaterial = (dish: DishSafetyFacts): unknown => ({
  dishId: dish.dishId,
  dishRevision: dish.dishRevision,
  exposures: [...dish.exposures]
    .sort(byIdentifier((exposure) => exposure.exposureId))
    .map(normalizedExposure),
});

export const canonicalDishDigest = (dish: DishSafetyFacts): Digest =>
  framedDigest("stage09p-m1-household-safety-dish-v1", canonicalDishMaterial(dish));

export const canonicalHouseholdRequestMaterial = (input: HouseholdDishSafetyInput): unknown => ({
  schemaVersion: input.schemaVersion,
  asOf: input.asOf,
  household: {
    country: input.household.country,
    foodRuleRegion: input.household.foodRuleRegion,
  },
  expectedSourcePack: {
    packId: input.expectedSourcePack.packId,
    packRevision: input.expectedSourcePack.packRevision,
    contentDigest: input.expectedSourcePack.contentDigest,
  },
  householdProfiles: [...input.householdProfiles]
    .sort(byIdentifier((profile) => profile.profileId))
    .map((profile) => ({
      profileId: profile.profileId,
      status: profile.status,
      constraints: normalizedConstraints(profile),
    })),
  mealParticipantProfileIds: [...input.mealParticipantProfileIds].sort(compareUtf8),
  guestParticipants: [...input.guestParticipants]
    .sort(byIdentifier((guest) => guest.guestId))
    .map((guest) => ({
      guestId: guest.guestId,
      constraints: [...guest.constraints]
        .sort(byIdentifier((constraint) => constraint.constraintId))
        .map((constraint) => ({
          constraintId: constraint.constraintId,
          kind: constraint.kind,
          basis: constraint.basis,
          mapping: normalizedMappingSelection(constraint.mapping),
        })),
    })),
  dish: {
    dishId: input.dish.dishId,
    dishRevision: input.dish.dishRevision,
    contentDigest: input.dish.contentDigest,
    exposures: [...input.dish.exposures]
      .sort(byIdentifier((exposure) => exposure.exposureId))
      .map(normalizedExposure),
  },
});

export const canonicalHouseholdRequestDigest = (input: HouseholdDishSafetyInput): Digest =>
  framedDigest(
    "stage09p-m1-household-safety-request-v2",
    canonicalHouseholdRequestMaterial(input),
  );

export const canonicalMappingReviewMaterial = (review: MappingReview): unknown => ({
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
});

export const canonicalMappingReviewDigest = (review: MappingReview): Digest =>
  framedDigest(
    "stage09p-m1-household-safety-mapping-review-v1",
    canonicalMappingReviewMaterial(review),
  );

const nullableTextCompare = (left: string | null, right: string | null): number => {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareUtf8(left, right);
};

const canonicalRowCompare = (left: unknown, right: unknown): number =>
  compareUtf8(canonicalJson(left), canonicalJson(right));

const normalizedBindings = <T extends HouseholdSafetySourcePack | InternalSyntheticGovernedGraph>(
  value: T,
) => [...value.releaseBindings].sort(byIdentifier((binding) => binding.bindingId));

const normalizedWindows = <T extends HouseholdSafetySourcePack | InternalSyntheticGovernedGraph>(
  value: T,
) => [...value.sourceVersionWindows].sort((left, right) => {
  const bindingOrder = compareUtf8(left.bindingId, right.bindingId);
  if (bindingOrder !== 0) return bindingOrder;
  const fromOrder = compareUtf8(left.effectiveFrom, right.effectiveFrom);
  if (fromOrder !== 0) return fromOrder;
  const untilOrder = nullableTextCompare(left.effectiveUntil, right.effectiveUntil);
  return untilOrder !== 0 ? untilOrder : canonicalRowCompare(left, right);
});

const normalizedReviews = <T extends HouseholdSafetySourcePack | InternalSyntheticGovernedGraph>(
  value: T,
) => [...value.mappingReviews].sort((left, right) => {
  const mappingOrder = compareUtf8(left.mappingId, right.mappingId);
  if (mappingOrder !== 0) return mappingOrder;
  const revisionOrder = left.reviewRevision - right.reviewRevision;
  return revisionOrder !== 0 ? revisionOrder : canonicalRowCompare(left, right);
});

export const canonicalHouseholdSafetyPackMaterial = (
  pack: HouseholdSafetySourcePack,
): unknown => ({
  schemaVersion: pack.schemaVersion,
  packId: pack.packId,
  packRevision: pack.packRevision,
  lifecycleStatus: pack.lifecycleStatus,
  country: pack.country,
  foodRuleRegion: pack.foodRuleRegion,
  ruleLanguage: pack.ruleLanguage,
  releaseBindings: normalizedBindings(pack),
  sourceVersionWindows: normalizedWindows(pack),
  mappingReviews: normalizedReviews(pack),
  catalog: pack.catalog,
});

export const canonicalHouseholdSafetyPackDigest = (pack: HouseholdSafetySourcePack): Digest =>
  framedDigest(
    "stage09p-m1-household-safety-official-pack-v2",
    canonicalHouseholdSafetyPackMaterial(pack),
  );

export const canonicalSyntheticGovernedGraphMaterial = (
  graph: InternalSyntheticGovernedGraph,
): unknown => ({
  schemaVersion: graph.schemaVersion,
  packId: graph.packId,
  packRevision: graph.packRevision,
  country: graph.country,
  foodRuleRegion: graph.foodRuleRegion,
  ruleLanguage: graph.ruleLanguage,
  syntheticSourceUsageStatus: graph.syntheticSourceUsageStatus,
  releaseBindings: normalizedBindings(graph),
  sourceVersionWindows: normalizedWindows(graph),
  mappingReviews: normalizedReviews(graph),
  catalog: graph.catalog,
  endpointFacts: [...graph.endpointFacts].sort((left, right) => {
    const datasetOrder = compareUtf8(left.reference.datasetId, right.reference.datasetId);
    if (datasetOrder !== 0) return datasetOrder;
    const entityOrder = compareUtf8(left.reference.entityId, right.reference.entityId);
    if (entityOrder !== 0) return entityOrder;
    const revisionOrder = left.reference.entityRevision - right.reference.entityRevision;
    return revisionOrder !== 0
      ? revisionOrder
      : compareUtf8(left.syntheticDisposition, right.syntheticDisposition);
  }),
});

export const canonicalSyntheticGovernedGraphDigest = (
  graph: InternalSyntheticGovernedGraph,
): Digest => framedDigest(
  "stage09p-m1-internal-synthetic-pipeline-v2",
  canonicalSyntheticGovernedGraphMaterial(graph),
);

export const canonicalHouseholdSafetyEvaluationMaterial = (
  evaluation: Omit<HouseholdDishSafetyEvaluation, "evaluationDigest">,
): unknown => evaluation;

export const canonicalHouseholdSafetyEvaluationDigest = (
  evaluation: Omit<HouseholdDishSafetyEvaluation, "evaluationDigest">,
): Digest => framedDigest(
  "stage09p-m1-household-safety-evaluation-v2",
  canonicalHouseholdSafetyEvaluationMaterial(evaluation),
);

export const canonicalAnalyzedHouseholdRequestMaterial = (
  scenario: InternalSyntheticAnalyzedScenario,
): unknown => ({ schemaVersion: scenario.schemaVersion, subjects: scenario.subjects });

export const canonicalAnalyzedHouseholdSourceMaterial = (
  scenario: InternalSyntheticAnalyzedScenario,
): unknown => ({
  schemaVersion: scenario.schemaVersion,
  tableKnownHardReasons: scenario.tableKnownHardReasons,
  tableUncertaintyReasons: scenario.tableUncertaintyReasons,
  subjectKnownHardReasons: scenario.subjectKnownHardReasons,
  subjectUncertaintyReasons: scenario.subjectUncertaintyReasons,
  softReasons: scenario.softReasons,
});

export const canonicalAnalyzedHouseholdRequestDigest = (
  scenario: InternalSyntheticAnalyzedScenario,
): Digest => framedDigest(
  "stage09p-m1-internal-synthetic-kernel-request-v1",
  canonicalAnalyzedHouseholdRequestMaterial(scenario),
);

export const canonicalAnalyzedHouseholdSourceDigest = (
  scenario: InternalSyntheticAnalyzedScenario,
): Digest => framedDigest(
  "stage09p-m1-internal-synthetic-kernel-source-v1",
  canonicalAnalyzedHouseholdSourceMaterial(scenario),
);

export const canonicalReasonText = (reason: HouseholdSafetyReason): string =>
  canonicalJson(reason);

export const canonicalSubjectSuitabilityText = (subject: SubjectSuitability): string =>
  canonicalJson(subject);
