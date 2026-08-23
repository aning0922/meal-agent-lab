import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type {
  GovernanceAlias,
  GovernanceEnvelope,
  GovernanceRelease,
  JsonValue,
} from "./types.js";

const invalidUnicodeScalar = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const assertString = (value: string): void => {
  if (invalidUnicodeScalar.test(value)) {
    throw new TypeError("canonical JSON requires Unicode scalar strings");
  }
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

const canonicalValue = (value: unknown, seen: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("canonical JSON requires finite non-negative-zero numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("canonical JSON accepts JSON values only");
  }
  if (seen.has(value)) throw new TypeError("canonical JSON rejects cyclic values");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key) => !/^(?:0|[1-9][0-9]*)$/.test(key))) {
        throw new TypeError("canonical JSON rejects arrays with extra properties");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("canonical JSON rejects sparse arrays");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError("canonical JSON rejects accessors");
        }
        items.push(canonicalValue(descriptor.value, seen));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON requires plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError("canonical JSON rejects symbol keys");
    }
    const entries: string[] = [];
    for (const key of Object.keys(value).sort(compareUtf8)) {
      assertString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("canonical JSON rejects accessors");
      }
      entries.push(`${JSON.stringify(key)}:${canonicalValue(descriptor.value, seen)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
};

export const canonicalJson = (value: unknown): string => canonicalValue(value, new Set());

const stringKey = (...values: readonly string[]): string => values.join("\u0000");

const sortStrings = (values: readonly string[]): string[] => [...values].sort(compareUtf8);

const sortAliases = (aliases: readonly GovernanceAlias[]): GovernanceAlias[] =>
  [...aliases].sort((left, right) =>
    compareUtf8(
      stringKey(left.region, left.language, left.value, left.sourceReferenceId),
      stringKey(right.region, right.language, right.value, right.sourceReferenceId),
    ),
  );

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
  approvers: [...envelope.approvers].sort((left, right) =>
    compareUtf8(stringKey(left.actorId, left.role), stringKey(right.actorId, right.role)),
  ),
  sourceTier: envelope.sourceTier,
  sourceReferences: [...envelope.sourceReferences].sort((left, right) =>
    compareUtf8(
      stringKey(left.referenceId, left.referenceRevision, left.locator),
      stringKey(right.referenceId, right.referenceRevision, right.locator),
    ),
  ),
  sourceSnapshots: [...envelope.sourceSnapshots].sort((left, right) =>
    compareUtf8(
      stringKey(left.referenceId, left.referenceRevision, left.snapshotId),
      stringKey(right.referenceId, right.referenceRevision, right.snapshotId),
    ),
  ),
  applicableRegions: sortStrings(envelope.applicableRegions),
  languages: sortStrings(envelope.languages),
  licenseStatus: envelope.licenseStatus,
  licenseReference: envelope.licenseReference,
  retrievedAt: envelope.retrievedAt,
  reviewedAt: envelope.reviewedAt,
  reviewDueAt: envelope.reviewDueAt,
  aliases: sortAliases(envelope.aliases),
  supersededBy: envelope.supersededBy,
  withdrawalState: envelope.withdrawalState,
  withdrawalReason: envelope.withdrawalReason,
  withdrawnAt: envelope.withdrawnAt,
  content: envelope.content,
  ...(envelope.syntheticEvidence === undefined
    ? {}
    : { syntheticEvidence: envelope.syntheticEvidence }),
}) as unknown as JsonValue;

/** The declared contentDigest is excluded to avoid a circular self-reference. */
export const canonicalReleaseText = (release: GovernanceRelease): string =>
  canonicalJson({
    envelopes: [...release.envelopes]
      .sort((left, right) =>
        compareUtf8(
          stringKey(left.datasetId, left.entityId, String(left.entityRevision)),
          stringKey(right.datasetId, right.entityId, String(right.entityRevision)),
        ),
      )
      .map(canonicalEnvelopeMaterial),
  });

export const canonicalReleaseDigest = (release: GovernanceRelease): string =>
  `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalReleaseText(release))))}`;
