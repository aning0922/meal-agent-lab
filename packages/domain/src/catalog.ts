import type {
  DecodedGovernanceCatalog,
  GovernedReference,
  GovernanceEnvelope,
  MappingResolution,
  ValidatedCatalogIndex,
} from "./types.js";

const authenticIndexes = new WeakSet<object>();

export const createValidatedCatalogIndex = (
  catalog: DecodedGovernanceCatalog,
): ValidatedCatalogIndex => {
  const envelopes: GovernanceEnvelope[] = [];
  for (const release of catalog.releases) {
    for (let index = 0; index < release.envelopes.length; index += 1) {
      envelopes.push(release.envelopes[index] as GovernanceEnvelope);
    }
  }
  const index = Object.freeze({
    releases: catalog.releases,
    hardMappings: catalog.hardMappings,
    envelopes: Object.freeze(envelopes),
  }) as ValidatedCatalogIndex;
  authenticIndexes.add(index);
  return index;
};

export const isValidatedCatalogIndex = (value: unknown): value is ValidatedCatalogIndex =>
  typeof value === "object" && value !== null && authenticIndexes.has(value);

const usable = (envelope: GovernanceEnvelope): boolean =>
  envelope.lifecycleStatus === "active" &&
  envelope.withdrawalState === "not_withdrawn" &&
  envelope.sourceTier !== "L4" &&
  envelope.licenseStatus === "approved" &&
  envelope.sourceReferences.length > 0 &&
  envelope.sourceSnapshots.length > 0 &&
  envelope.applicableRegions.length > 0 &&
  envelope.languages.length > 0;

export const resolveValidatedReference = (
  catalog: ValidatedCatalogIndex,
  reference: GovernedReference,
): MappingResolution => {
  if (!isValidatedCatalogIndex(catalog)) return { status: "unmapped", reference };
  const sameIdentity: GovernanceEnvelope[] = [];
  for (const envelope of catalog.envelopes) {
    if (envelope.datasetId === reference.datasetId && envelope.entityId === reference.entityId) {
      sameIdentity.push(envelope);
    }
  }
  let exact: GovernanceEnvelope | undefined;
  for (const envelope of sameIdentity) {
    if (envelope.entityRevision === reference.entityRevision) {
      if (exact !== undefined) return { status: "unmapped", reference };
      exact = envelope;
    }
  }
  if (exact === undefined) {
    return sameIdentity.length === 0
      ? { status: "unmapped", reference }
      : { status: "version_mismatch", reference };
  }
  if (exact.lifecycleStatus === "withdrawn" || exact.withdrawalState === "withdrawn") {
    return { status: "withdrawn", reference };
  }
  return usable(exact) ? { status: "mapped", envelope: exact } : { status: "unapproved", reference };
};
