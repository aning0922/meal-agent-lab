import type {
  GovernanceCatalog,
  GovernedReference,
  GovernanceEnvelope,
  MappingResolution,
} from "./types.js";

const allEnvelopes = (catalog: GovernanceCatalog): GovernanceEnvelope[] =>
  catalog.releases.flatMap(({ envelopes }) => [...envelopes]);

export const resolveGovernedReference = (
  catalog: GovernanceCatalog,
  reference: GovernedReference,
): MappingResolution => {
  const sameIdentity = allEnvelopes(catalog).filter(
    (envelope) =>
      envelope.datasetId === reference.datasetId && envelope.entityId === reference.entityId,
  );
  const exact = sameIdentity.find(
    (envelope) => envelope.entityRevision === reference.entityRevision,
  );
  if (exact === undefined) {
    return sameIdentity.length === 0
      ? { status: "unmapped", reference }
      : { status: "version_mismatch", reference };
  }
  if (exact.lifecycleStatus === "withdrawn" || exact.withdrawalState === "withdrawn") {
    return { status: "withdrawn", reference };
  }
  if (
    exact.lifecycleStatus !== "active" ||
    exact.sourceTier === "L4" ||
    exact.licenseStatus !== "approved" ||
    exact.sourceReferences.length === 0 ||
    exact.sourceSnapshots.length === 0 ||
    exact.applicableRegions.length === 0 ||
    exact.languages.length === 0
  ) {
    return { status: "unapproved", reference };
  }
  return { status: "mapped", envelope: exact };
};
