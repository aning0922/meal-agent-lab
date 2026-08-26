import {
  datasetKinds,
  licenseStatuses,
  lifecycleStatuses,
  sourceTiers,
  withdrawalStates,
  type DecodeIssueCode,
  type DecodeResult,
  type DecodedGovernanceCatalog,
  type DecodedGovernanceRelease,
  type GovernanceActor,
  type GovernanceAlias,
  type GovernanceCatalog,
  type GovernanceEnvelope,
  type GovernanceRelease,
  type GovernedReference,
  type HardMapping,
  type JsonValue,
  type SourceReference,
  type SourceSnapshot,
  type SyntheticEvidence,
} from "./types.js";

export const DECODE_LIMITS = Object.freeze({
  maxArrayLength: 4_096,
  maxDepth: 64,
  maxNodes: 10_000,
  maxObjectKeys: 4_096,
  maxStringLength: 65_536,
  maxTextLength: 262_144,
});

const invalidUnicodeScalar =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const arrayIndex = /^(?:0|[1-9][0-9]*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const timestampPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

const pointerToken = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");
const childPath = (path: string, token: string | number): string =>
  `${path}/${pointerToken(String(token))}`;

class DecodeSignal extends Error {
  readonly code: DecodeIssueCode;
  readonly path: string;

  constructor(code: DecodeIssueCode, path: string) {
    super("decode_failed");
    this.code = code;
    this.path = path;
  }
}

const fail = (code: DecodeIssueCode, path: string): never => {
  throw new DecodeSignal(code, path);
};

class RawJsonParser {
  readonly #text: string;
  #index = 0;
  #nodes = 0;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): unknown {
    if (this.#text.length > DECODE_LIMITS.maxTextLength) {
      fail("RESOURCE_LIMIT_EXCEEDED", "");
    }
    this.#skipWhitespace();
    const value = this.#parseValue("", 0);
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) fail("TRAILING_INPUT", "");
    return value;
  }

  #bump(path: string, depth: number): void {
    this.#nodes += 1;
    if (depth > DECODE_LIMITS.maxDepth || this.#nodes > DECODE_LIMITS.maxNodes) {
      fail("RESOURCE_LIMIT_EXCEEDED", path);
    }
  }

  #skipWhitespace(): void {
    while (this.#index < this.#text.length && /[\u0009\u000a\u000d\u0020]/.test(this.#text[this.#index] ?? "")) {
      this.#index += 1;
    }
  }

  #parseValue(path: string, depth: number): unknown {
    this.#bump(path, depth);
    const token = this.#text[this.#index];
    if (token === "{") return this.#parseObject(path, depth);
    if (token === "[") return this.#parseArray(path, depth);
    if (token === '"') return this.#parseString(path);
    if (token === "t") return this.#parseLiteral("true", true, path);
    if (token === "f") return this.#parseLiteral("false", false, path);
    if (token === "n") return this.#parseLiteral("null", null, path);
    if (token === "-" || (token !== undefined && token >= "0" && token <= "9")) {
      return this.#parseNumber(path);
    }
    return fail("INVALID_JSON", path);
  }

  #parseObject(path: string, depth: number): Record<string, unknown> {
    this.#index += 1;
    this.#skipWhitespace();
    const object: Record<string, unknown> = {};
    const seen = new Set<string>();
    let count = 0;
    if (this.#text[this.#index] === "}") {
      this.#index += 1;
      return object;
    }
    while (this.#index < this.#text.length) {
      if (this.#text[this.#index] !== '"') fail("INVALID_JSON", path);
      const key = this.#parseString(path);
      const keyPath = childPath(path, key);
      if (seen.has(key)) fail("DUPLICATE_KEY", keyPath);
      seen.add(key);
      count += 1;
      if (count > DECODE_LIMITS.maxObjectKeys) fail("RESOURCE_LIMIT_EXCEEDED", path);
      this.#skipWhitespace();
      if (this.#text[this.#index] !== ":") fail("INVALID_JSON", keyPath);
      this.#index += 1;
      this.#skipWhitespace();
      const value = this.#parseValue(keyPath, depth + 1);
      Object.defineProperty(object, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      this.#skipWhitespace();
      const separator = this.#text[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return object;
      }
      if (separator !== ",") fail("INVALID_JSON", path);
      this.#index += 1;
      this.#skipWhitespace();
    }
    return fail("INVALID_JSON", path);
  }

  #parseArray(path: string, depth: number): unknown[] {
    this.#index += 1;
    this.#skipWhitespace();
    const array: unknown[] = [];
    if (this.#text[this.#index] === "]") {
      this.#index += 1;
      return array;
    }
    while (this.#index < this.#text.length) {
      if (array.length >= DECODE_LIMITS.maxArrayLength) {
        fail("RESOURCE_LIMIT_EXCEEDED", path);
      }
      array.push(this.#parseValue(childPath(path, array.length), depth + 1));
      this.#skipWhitespace();
      const separator = this.#text[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return array;
      }
      if (separator !== ",") fail("INVALID_JSON", path);
      this.#index += 1;
      this.#skipWhitespace();
    }
    return fail("INVALID_JSON", path);
  }

  #parseString(path: string): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#text.length) {
      const code = this.#text.charCodeAt(this.#index);
      if (code === 0x22) {
        this.#index += 1;
        try {
          return JSON.parse(this.#text.slice(start, this.#index)) as string;
        } catch {
          return fail("INVALID_JSON", path);
        }
      }
      if (code < 0x20) fail("INVALID_JSON", path);
      if (code === 0x5c) {
        const escape = this.#text[this.#index + 1];
        if (escape === "u") {
          const digits = this.#text.slice(this.#index + 2, this.#index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail("INVALID_JSON", path);
          this.#index += 6;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) fail("INVALID_JSON", path);
        this.#index += 2;
        continue;
      }
      this.#index += 1;
    }
    return fail("INVALID_JSON", path);
  }

  #parseLiteral(token: string, value: unknown, path: string): unknown {
    if (!this.#text.startsWith(token, this.#index)) fail("INVALID_JSON", path);
    this.#index += token.length;
    return value;
  }

  #parseNumber(path: string): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.#text.slice(this.#index),
    );
    if (match === null) return fail("INVALID_JSON", path);
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("INVALID_SCALAR", path);
    return value;
  }
}

interface ScalarState {
  readonly ancestors: Set<object>;
  nodes: number;
}

const scalarClosure = (
  value: unknown,
  path: string,
  depth: number,
  state: ScalarState,
): JsonValue => {
  state.nodes += 1;
  if (depth > DECODE_LIMITS.maxDepth || state.nodes > DECODE_LIMITS.maxNodes) {
    fail("RESOURCE_LIMIT_EXCEEDED", path);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > DECODE_LIMITS.maxStringLength) fail("RESOURCE_LIMIT_EXCEEDED", path);
    if (invalidUnicodeScalar.test(value)) fail("INVALID_SCALAR", path);
    return value;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      fail("INVALID_SCALAR", path);
    }
    return value;
  }
  if (typeof value !== "object" || value === null) return fail("INVALID_SCALAR", path);
  if (state.ancestors.has(value)) fail("INVALID_SHAPE", path);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail("INVALID_SHAPE", path);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor?.value;
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > DECODE_LIMITS.maxArrayLength
      ) {
        return fail("RESOURCE_LIMIT_EXCEEDED", path);
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1) fail("INVALID_SHAPE", path);
      const decoded: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (!arrayIndex.test(key)) fail("INVALID_SHAPE", path);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          return fail("INVALID_SHAPE", childPath(path, index));
        }
        decoded.push(scalarClosure(descriptor.value, childPath(path, index), depth + 1, state));
      }
      return Object.freeze(decoded);
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) fail("INVALID_SHAPE", path);
    const keys = Reflect.ownKeys(value);
    if (keys.length > DECODE_LIMITS.maxObjectKeys) fail("RESOURCE_LIMIT_EXCEEDED", path);
    const decoded: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (typeof key !== "string" || invalidUnicodeScalar.test(key)) {
        return fail("INVALID_SHAPE", path);
      }
      if (key.length > DECODE_LIMITS.maxStringLength) {
        return fail("RESOURCE_LIMIT_EXCEEDED", path);
      }
      const keyPath = childPath(path, key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return fail("INVALID_SHAPE", keyPath);
      }
      Object.defineProperty(decoded, key, {
        configurable: false,
        enumerable: true,
        value: scalarClosure(descriptor.value, keyPath, depth + 1, state),
        writable: false,
      });
    }
    return Object.freeze(decoded);
  } finally {
    state.ancestors.delete(value);
  }
};

/** The single recursive scalar-closure authority used by raw and object entry points. */
export const decodeJsonScalarClosure = (value: unknown): DecodeResult<JsonValue> =>
  capture(() => scalarClosure(value, "", 0, { ancestors: new Set(), nodes: 0 }));

const scalarString = (value: JsonValue | undefined, path: string): string => {
  if (typeof value !== "string" || value.length === 0) return fail("INVALID_SHAPE", path);
  return value;
};

const patternedString = (value: JsonValue | undefined, path: string, pattern: RegExp): string => {
  const decoded = scalarString(value, path);
  if (!pattern.test(decoded)) fail("INVALID_SHAPE", path);
  return decoded;
};

const positiveRevision = (value: JsonValue | undefined, path: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail("INVALID_SHAPE", path);
  }
  return value;
};

const booleanValue = (value: JsonValue | undefined, path: string): boolean => {
  if (typeof value !== "boolean") return fail("INVALID_SHAPE", path);
  return value;
};

const enumValue = <T extends string>(
  value: JsonValue | undefined,
  allowed: readonly T[],
  path: string,
): T => {
  const decoded = scalarString(value, path);
  if (!(allowed as readonly string[]).includes(decoded)) fail("INVALID_SHAPE", path);
  return decoded as T;
};

const recordValue = (
  value: JsonValue | undefined,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): Readonly<Record<string, JsonValue>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("INVALID_SHAPE", path);
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(record);
  const allowedSet = new Set(allowed);
  for (const key of keys) if (!allowedSet.has(key)) fail("INVALID_SHAPE", childPath(path, key));
  for (const key of required) if (!Object.hasOwn(record, key)) fail("INVALID_SHAPE", childPath(path, key));
  return record;
};

const arrayValue = <T>(
  value: JsonValue | undefined,
  path: string,
  decodeItem: (item: JsonValue, itemPath: string) => T,
  minimum = 0,
): readonly T[] => {
  if (!Array.isArray(value) || value.length < minimum) return fail("INVALID_SHAPE", path);
  const items = value as readonly JsonValue[];
  return Object.freeze(items.map((item, index) => decodeItem(item, childPath(path, index))));
};

const decodeActor = (value: JsonValue | undefined, path: string): GovernanceActor => {
  const keys = ["actorId", "role"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    actorId: scalarString(record["actorId"], childPath(path, "actorId")),
    role: scalarString(record["role"], childPath(path, "role")),
  });
};

const decodeReference = (value: JsonValue | undefined, path: string): GovernedReference => {
  const keys = ["datasetId", "entityId", "entityRevision"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    datasetId: scalarString(record["datasetId"], childPath(path, "datasetId")),
    entityId: scalarString(record["entityId"], childPath(path, "entityId")),
    entityRevision: positiveRevision(record["entityRevision"], childPath(path, "entityRevision")),
  });
};

const decodeSourceReference = (value: JsonValue, path: string): SourceReference => {
  const keys = ["referenceId", "referenceRevision", "locator"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    referenceId: scalarString(record["referenceId"], childPath(path, "referenceId")),
    referenceRevision: scalarString(
      record["referenceRevision"],
      childPath(path, "referenceRevision"),
    ),
    locator: scalarString(record["locator"], childPath(path, "locator")),
  });
};

const decodeSourceSnapshot = (value: JsonValue, path: string): SourceSnapshot => {
  const keys = [
    "snapshotId",
    "referenceId",
    "referenceRevision",
    "locator",
    "contentDigest",
    "retrievedAt",
  ];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    snapshotId: scalarString(record["snapshotId"], childPath(path, "snapshotId")),
    referenceId: scalarString(record["referenceId"], childPath(path, "referenceId")),
    referenceRevision: scalarString(
      record["referenceRevision"],
      childPath(path, "referenceRevision"),
    ),
    locator: scalarString(record["locator"], childPath(path, "locator")),
    contentDigest: patternedString(
      record["contentDigest"],
      childPath(path, "contentDigest"),
      digestPattern,
    ),
    retrievedAt: patternedString(
      record["retrievedAt"],
      childPath(path, "retrievedAt"),
      timestampPattern,
    ),
  });
};

const decodeAlias = (value: JsonValue, path: string): GovernanceAlias => {
  const keys = ["value", "region", "language", "sourceReferenceId", "sourceReferenceRevision"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    value: scalarString(record["value"], childPath(path, "value")),
    region: scalarString(record["region"], childPath(path, "region")),
    language: scalarString(record["language"], childPath(path, "language")),
    sourceReferenceId: scalarString(
      record["sourceReferenceId"],
      childPath(path, "sourceReferenceId"),
    ),
    sourceReferenceRevision: scalarString(
      record["sourceReferenceRevision"],
      childPath(path, "sourceReferenceRevision"),
    ),
  });
};

const decodeSyntheticEvidence = (value: JsonValue | undefined, path: string): SyntheticEvidence => {
  const keys = [
    "classification",
    "generator",
    "containsRealUserData",
    "containsRealFoodFacts",
    "purpose",
  ];
  const record = recordValue(value, keys, keys, path);
  if (
    record["classification"] !== "fully_synthetic" ||
    record["generator"] !== "stage09p-m0-fixture-v1" ||
    record["containsRealUserData"] !== false ||
    record["containsRealFoodFacts"] !== false ||
    record["purpose"] !== "governance-format-and-fail-closed-testing-only"
  ) {
    fail("INVALID_SHAPE", path);
  }
  return Object.freeze({
    classification: "fully_synthetic",
    generator: "stage09p-m0-fixture-v1",
    containsRealUserData: false,
    containsRealFoodFacts: false,
    purpose: "governance-format-and-fail-closed-testing-only",
  });
};

const envelopeKeys = [
  "schemaVersion",
  "datasetId",
  "datasetKind",
  "entityId",
  "entityRevision",
  "lifecycleStatus",
  "owner",
  "approvers",
  "sourceTier",
  "sourceReferences",
  "sourceSnapshots",
  "applicableRegions",
  "languages",
  "licenseStatus",
  "licenseReference",
  "retrievedAt",
  "reviewedAt",
  "reviewDueAt",
  "aliases",
  "supersededBy",
  "withdrawalState",
  "withdrawalReason",
  "withdrawnAt",
  "content",
  "syntheticEvidence",
] as const;

const decodeEnvelope = (value: JsonValue, path: string): GovernanceEnvelope => {
  const required = envelopeKeys.filter((key) => key !== "syntheticEvidence");
  const record = recordValue(value, envelopeKeys, required, path);
  if (record["schemaVersion"] !== 1) fail("INVALID_SHAPE", childPath(path, "schemaVersion"));
  const nullableString = (key: "licenseReference" | "withdrawalReason" | "withdrawnAt") =>
    record[key] === null ? null : scalarString(record[key], childPath(path, key));
  return Object.freeze({
    schemaVersion: 1,
    datasetId: scalarString(record["datasetId"], childPath(path, "datasetId")),
    datasetKind: enumValue(record["datasetKind"], datasetKinds, childPath(path, "datasetKind")),
    entityId: scalarString(record["entityId"], childPath(path, "entityId")),
    entityRevision: positiveRevision(
      record["entityRevision"],
      childPath(path, "entityRevision"),
    ),
    lifecycleStatus: enumValue(
      record["lifecycleStatus"],
      lifecycleStatuses,
      childPath(path, "lifecycleStatus"),
    ),
    owner: decodeActor(record["owner"], childPath(path, "owner")),
    approvers: arrayValue(record["approvers"], childPath(path, "approvers"), decodeActor, 1),
    sourceTier: enumValue(record["sourceTier"], sourceTiers, childPath(path, "sourceTier")),
    sourceReferences: arrayValue(
      record["sourceReferences"],
      childPath(path, "sourceReferences"),
      decodeSourceReference,
      1,
    ),
    sourceSnapshots: arrayValue(
      record["sourceSnapshots"],
      childPath(path, "sourceSnapshots"),
      decodeSourceSnapshot,
      1,
    ),
    applicableRegions: arrayValue(
      record["applicableRegions"],
      childPath(path, "applicableRegions"),
      scalarString,
      1,
    ),
    languages: arrayValue(record["languages"], childPath(path, "languages"), scalarString, 1),
    licenseStatus: enumValue(
      record["licenseStatus"],
      licenseStatuses,
      childPath(path, "licenseStatus"),
    ),
    licenseReference: nullableString("licenseReference"),
    retrievedAt: patternedString(
      record["retrievedAt"],
      childPath(path, "retrievedAt"),
      timestampPattern,
    ),
    reviewedAt: patternedString(
      record["reviewedAt"],
      childPath(path, "reviewedAt"),
      timestampPattern,
    ),
    reviewDueAt: patternedString(
      record["reviewDueAt"],
      childPath(path, "reviewDueAt"),
      timestampPattern,
    ),
    aliases: arrayValue(record["aliases"], childPath(path, "aliases"), decodeAlias),
    supersededBy:
      record["supersededBy"] === null
        ? null
        : decodeReference(record["supersededBy"], childPath(path, "supersededBy")),
    withdrawalState: enumValue(
      record["withdrawalState"],
      withdrawalStates,
      childPath(path, "withdrawalState"),
    ),
    withdrawalReason: nullableString("withdrawalReason"),
    withdrawnAt:
      record["withdrawnAt"] === null
        ? null
        : patternedString(record["withdrawnAt"], childPath(path, "withdrawnAt"), timestampPattern),
    content: record["content"] as JsonValue,
    ...(Object.hasOwn(record, "syntheticEvidence")
      ? {
          syntheticEvidence: decodeSyntheticEvidence(
            record["syntheticEvidence"],
            childPath(path, "syntheticEvidence"),
          ),
        }
      : {}),
  });
};

const releaseKeys = [
  "$schema",
  "schemaVersion",
  "releaseId",
  "releaseRevision",
  "contentDigest",
  "envelopes",
] as const;

const decodeReleaseValue = (value: JsonValue, path: string): DecodedGovernanceRelease => {
  const required = releaseKeys.filter((key) => key !== "$schema");
  const record = recordValue(value, releaseKeys, required, path);
  if (record["schemaVersion"] !== 1) fail("INVALID_SHAPE", childPath(path, "schemaVersion"));
  const release: GovernanceRelease = {
    ...(Object.hasOwn(record, "$schema")
      ? { $schema: scalarString(record["$schema"], childPath(path, "$schema")) }
      : {}),
    schemaVersion: 1,
    releaseId: scalarString(record["releaseId"], childPath(path, "releaseId")),
    releaseRevision: positiveRevision(
      record["releaseRevision"],
      childPath(path, "releaseRevision"),
    ),
    contentDigest: patternedString(
      record["contentDigest"],
      childPath(path, "contentDigest"),
      digestPattern,
    ),
    envelopes: arrayValue(record["envelopes"], childPath(path, "envelopes"), decodeEnvelope, 1),
  };
  return Object.freeze(release) as DecodedGovernanceRelease;
};

const decodeHardMapping = (value: JsonValue, path: string): HardMapping => {
  const keys = ["mappingId", "source", "target", "required"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    mappingId: scalarString(record["mappingId"], childPath(path, "mappingId")),
    source: decodeReference(record["source"], childPath(path, "source")),
    target: decodeReference(record["target"], childPath(path, "target")),
    required: booleanValue(record["required"], childPath(path, "required")),
  });
};

const decodeCatalogValue = (value: JsonValue): DecodedGovernanceCatalog => {
  const keys = ["schemaVersion", "releases", "hardMappings"];
  const record = recordValue(value, keys, keys, "");
  if (record["schemaVersion"] !== 1) fail("INVALID_SHAPE", "/schemaVersion");
  const catalog: GovernanceCatalog = {
    schemaVersion: 1,
    releases: arrayValue(record["releases"], "/releases", decodeReleaseValue, 1),
    hardMappings: arrayValue(record["hardMappings"], "/hardMappings", decodeHardMapping),
  };
  return Object.freeze(catalog) as DecodedGovernanceCatalog;
};

function capture<T>(operation: () => T): DecodeResult<T> {
  try {
    return Object.freeze({ ok: true, value: operation() });
  } catch (error: unknown) {
    const code = error instanceof DecodeSignal ? error.code : "INVALID_SHAPE";
    const path = error instanceof DecodeSignal ? error.path : "";
    return Object.freeze({
      ok: false,
      reason: "decode_failed",
      issue: Object.freeze({ code, path }),
    });
  }
}

const prepareObject = (value: unknown): JsonValue => {
  const result = decodeJsonScalarClosure(value);
  if (!result.ok) return fail(result.issue.code, result.issue.path);
  return result.value;
};

const prepareRaw = (text: unknown): JsonValue => {
  if (typeof text !== "string") return fail("INVALID_SHAPE", "");
  const parsed = new RawJsonParser(text).parse();
  return prepareObject(parsed);
};

export const decodeGovernanceRelease = (value: unknown): DecodeResult<DecodedGovernanceRelease> =>
  capture(() => decodeReleaseValue(prepareObject(value), ""));

export const decodeGovernanceReleaseJson = (
  text: unknown,
): DecodeResult<DecodedGovernanceRelease> =>
  capture(() => decodeReleaseValue(prepareRaw(text), ""));

export const decodeGovernanceCatalog = (value: unknown): DecodeResult<DecodedGovernanceCatalog> =>
  capture(() => decodeCatalogValue(prepareObject(value)));

export const decodeGovernanceCatalogJson = (
  text: unknown,
): DecodeResult<DecodedGovernanceCatalog> => capture(() => decodeCatalogValue(prepareRaw(text)));
