import { isValidatedCatalogIndex, resolveValidatedReference } from "./catalog.js";
import { decodeGovernedReference } from "./decode.js";
import { validateGovernanceCatalog } from "./validation.js";
import type {
  GovernedReference,
  MappingResolution,
  ValidatedCatalogIndex,
} from "./types.js";

const invalidReference: GovernedReference = Object.freeze({
  datasetId: "",
  entityId: "00000000-0000-7000-8000-000000000000",
  entityRevision: 1,
});

/**
 * A branded validated index is consumed directly. The compatibility object entry always performs
 * the same strict decode and complete validation first; invalid input deterministically unmapped.
 */
export const resolveGovernedReference = (
  catalog: ValidatedCatalogIndex | unknown,
  reference: GovernedReference | unknown,
): MappingResolution => {
  const decodedReference = decodeGovernedReference(reference);
  if (!decodedReference.ok) return { status: "unmapped", reference: invalidReference };
  if (isValidatedCatalogIndex(catalog)) {
    return resolveValidatedReference(catalog, decodedReference.value);
  }
  const validated = validateGovernanceCatalog(catalog);
  if (!validated.ok) return { status: "unmapped", reference: decodedReference.value };
  return resolveValidatedReference(validated.catalog, decodedReference.value);
};
