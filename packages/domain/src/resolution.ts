import { entityIdentityText } from "./catalog.js";
import { decodeJsonScalarClosure } from "./decode.js";
import type {
  ContextDecodeResult,
  DecodedActivationContext,
  GovernanceEnvelope,
  GovernedReference,
  HardMappingResolution,
  ReferenceResolution,
} from "./types.js";
import { analyzeGovernanceCatalog, type CatalogAnalysis } from "./validation.js";

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
