import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { decodeGovernanceRelease, decodeJsonScalarClosure } from "./decode.js";
import type {
  DecodedGovernanceRelease,
  JsonValue,
  ReleaseDigestResult,
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
  `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalReleaseTextFromDecoded(release))))}`;

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
