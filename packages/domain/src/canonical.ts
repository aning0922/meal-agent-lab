import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { decodeGovernanceRelease } from "./decode.js";
import type {
  DecodedGovernanceRelease,
  GovernanceAlias,
  GovernanceEnvelope,
  JsonValue,
} from "./types.js";

const invalidUnicodeScalar =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const assertString = (value: string): void => {
  if (invalidUnicodeScalar.test(value)) throw new TypeError("INVALID_SHAPE");
};

export const compareUtf8 = (left: string, right: string): number => {
  assertString(left);
  assertString(right);
  const leftBytes = utf8ToBytes(left);
  const rightBytes = utf8ToBytes(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

const canonicalValue = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("INVALID_SHAPE");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) throw new TypeError("INVALID_SHAPE");
  if (ancestors.has(value)) throw new TypeError("INVALID_SHAPE");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("INVALID_SHAPE");
      const keys = Reflect.ownKeys(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
        throw new TypeError("INVALID_SHAPE");
      }
      const length = lengthDescriptor.value as number;
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
        throw new TypeError("INVALID_SHAPE");
      }
      const items: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("INVALID_SHAPE");
        items.push(canonicalValue(descriptor.value, ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("INVALID_SHAPE");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new TypeError("INVALID_SHAPE");
    const stringKeys = keys as string[];
    stringKeys.sort(compareUtf8);
    const entries: string[] = [];
    for (const key of stringKeys) {
      assertString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("INVALID_SHAPE");
      entries.push(`${JSON.stringify(key)}:${canonicalValue(descriptor.value, ancestors)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalJson = (value: unknown): string => {
  try {
    return canonicalValue(value, new Set());
  } catch {
    throw new TypeError("INVALID_SHAPE");
  }
};

const copyArray = <T>(values: readonly T[]): T[] => {
  const copy: T[] = [];
  for (let index = 0; index < values.length; index += 1) copy.push(values[index] as T);
  return copy;
};

const compareStructural = <T>(
  left: T,
  right: T,
  fields: (value: T) => readonly string[],
  material: (value: T) => JsonValue = (value) => value as JsonValue,
): number => {
  const leftFields = fields(left);
  const rightFields = fields(right);
  const length = Math.max(leftFields.length, rightFields.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareUtf8(leftFields[index] ?? "", rightFields[index] ?? "");
    if (comparison !== 0) return comparison;
  }
  return compareUtf8(canonicalJson(material(left)), canonicalJson(material(right)));
};

const sorted = <T>(
  values: readonly T[],
  fields: (value: T) => readonly string[],
  material?: (value: T) => JsonValue,
): T[] => copyArray(values).sort((left, right) => compareStructural(left, right, fields, material));

const sortedStrings = (values: readonly string[]): string[] =>
  copyArray(values).sort((left, right) => {
    const comparison = compareUtf8(left, right);
    return comparison === 0 ? compareUtf8(canonicalJson(left), canonicalJson(right)) : comparison;
  });

const sortedAliases = (aliases: readonly GovernanceAlias[]): GovernanceAlias[] =>
  sorted(aliases, (alias) => [
    alias.region,
    alias.language,
    alias.value,
    alias.sourceReferenceId,
    alias.sourceReferenceRevision,
  ]);

const canonicalEnvelopeMaterial = (envelope: GovernanceEnvelope): JsonValue => ({
  schemaVersion: envelope.schemaVersion,
  datasetId: envelope.datasetId,
  datasetKind: envelope.datasetKind,
  releaseId: envelope.releaseId,
  releaseRevision: envelope.releaseRevision,
  entityId: envelope.entityId,
  entityRevision: envelope.entityRevision,
  lifecycleStatus: envelope.lifecycleStatus,
  owner: envelope.owner,
  approvers: sorted(envelope.approvers, (actor) => [actor.actorId, actor.role]),
  sourceTier: envelope.sourceTier,
  sourceReferences: sorted(envelope.sourceReferences, (reference) => [
    reference.referenceId,
    reference.referenceRevision,
    reference.locator,
  ]),
  sourceSnapshots: sorted(envelope.sourceSnapshots, (snapshot) => [
    snapshot.referenceId,
    snapshot.referenceRevision,
    snapshot.snapshotId,
    snapshot.contentDigest,
    snapshot.retrievedAt,
  ]),
  applicableRegions: sortedStrings(envelope.applicableRegions),
  languages: sortedStrings(envelope.languages),
  licenseStatus: envelope.licenseStatus,
  licenseReference: envelope.licenseReference,
  retrievedAt: envelope.retrievedAt,
  reviewedAt: envelope.reviewedAt,
  reviewDueAt: envelope.reviewDueAt,
  aliases: sortedAliases(envelope.aliases),
  supersededBy: envelope.supersededBy,
  withdrawalState: envelope.withdrawalState,
  withdrawalReason: envelope.withdrawalReason,
  withdrawnAt: envelope.withdrawnAt,
  content: envelope.content,
  ...(envelope.syntheticEvidence === undefined
    ? {}
    : { syntheticEvidence: envelope.syntheticEvidence }),
}) as unknown as JsonValue;

const decodedReleaseText = (release: DecodedGovernanceRelease): string => {
  const materials = release.envelopes.map(canonicalEnvelopeMaterial);
  const ordered = sorted(materials, (material) => {
    const envelope = material as Record<string, JsonValue>;
    return [
      String(envelope["datasetId"]),
      String(envelope["entityId"]),
      String(envelope["entityRevision"]),
    ];
  });
  return canonicalJson({
    ...(release.$schema === undefined ? {} : { $schema: release.$schema }),
    envelopes: ordered,
  });
};

/** The declared contentDigest is the only excluded field, preventing self-reference. */
export const canonicalReleaseText = (value: unknown): string => {
  const decoded = decodeGovernanceRelease(value);
  if (!decoded.ok) throw new TypeError("INVALID_SHAPE");
  return decodedReleaseText(decoded.value);
};

export const canonicalReleaseDigest = (value: unknown): string =>
  `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalReleaseText(value))))}`;
