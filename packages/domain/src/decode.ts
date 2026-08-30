import {
  constraintBases,
  constraintMappingStatuses,
  datasetKinds,
  dietaryRuleKinds,
  dishExposureKinds,
  householdProfileStatuses,
  householdSafetyReasonCodes,
  householdSafetyReasonScopes,
  licenseStatuses,
  lifecycleStatuses,
  mappingReviewStatuses,
  sourceTiers,
  sourceFactDispositions,
  subjectKinds,
  withdrawalStates,
  type CanonicalInstant,
  type DecodeIssueCode,
  type DecodeResult,
  type DecodedGovernanceCatalog,
  type DecodedGovernanceRelease,
  type DietaryRuleFact,
  type DishExposure,
  type DishSafetyFacts,
  type GuestParticipantSafetyFacts,
  type GovernanceActor,
  type GovernanceAlias,
  type GovernanceCatalog,
  type GovernanceEnvelope,
  type GovernanceRelease,
  type GovernedReference,
  type HardMapping,
  type HouseholdDishSafetyInput,
  type HouseholdProfileSafetyFacts,
  type HouseholdSafetyInputDecodeResult,
  type HouseholdSafetyInputIssueCode,
  type HouseholdSafetyReason,
  type HouseholdSafetySourcePack,
  type InternalSyntheticAnalyzedScenario,
  type InternalSyntheticEndpointFact,
  type InternalSyntheticGovernedGraph,
  type JsonValue,
  type MappingReview,
  type MappingSelection,
  type OfficialSourceEvidence,
  type ReleaseBinding,
  type SourcePackSnapshotRef,
  type SourceReference,
  type SourceSnapshot,
  type SourceVersionWindow,
  type SubjectRef,
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
const identifierPattern = /^[a-z0-9](?:[a-z0-9:._-]{0,127})$/;

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

class HouseholdInputSignal extends Error {
  readonly code: HouseholdSafetyInputIssueCode;
  readonly path: string;

  constructor(code: HouseholdSafetyInputIssueCode, path: string) {
    super("decode_failed");
    this.code = code;
    this.path = path;
  }
}

const fail = (code: DecodeIssueCode, path: string): never => {
  throw new DecodeSignal(code, path);
};

const failHouseholdInput = (code: HouseholdSafetyInputIssueCode, path: string): never => {
  throw new HouseholdInputSignal(code, path);
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

const boundedArray = <T>(
  value: JsonValue | undefined,
  path: string,
  decodeItem: (item: JsonValue, itemPath: string) => T,
  minimum: number,
  maximum: number,
): readonly T[] => {
  if (!Array.isArray(value) || value.length < minimum) return fail("INVALID_SHAPE", path);
  if (value.length > maximum) return fail("RESOURCE_LIMIT_EXCEEDED", path);
  return Object.freeze(
    (value as readonly JsonValue[]).map((item, index) =>
      decodeItem(item, childPath(path, index)),
    ),
  );
};

const identifier = (value: JsonValue | undefined, path: string): string =>
  patternedString(value, path, identifierPattern);

const canonicalInstant = (value: JsonValue | undefined, path: string): CanonicalInstant => {
  const decoded = patternedString(value, path, timestampPattern);
  const instant = new Date(decoded);
  if (!Number.isFinite(instant.valueOf()) || instant.toISOString() !== decoded) {
    fail("INVALID_SHAPE", path);
  }
  return decoded;
};

const uniqueValues = (
  values: readonly string[],
  path: string,
  code: HouseholdSafetyInputIssueCode,
): void => {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (seen.has(value)) failHouseholdInput(code, childPath(path, index));
    seen.add(value);
  }
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

const decodeOfficialEvidence = (
  value: JsonValue | undefined,
  path: string,
): OfficialSourceEvidence => {
  const keys = [
    "classification",
    "containsRealFoodFacts",
    "containsRealUserData",
    "fullTextCopied",
    "purpose",
    "factDisposition",
    "usageStatus",
  ];
  const record = recordValue(value, keys, keys, path);
  if (
    record["classification"] !== "official_source_projection" ||
    record["containsRealFoodFacts"] !== true ||
    record["containsRealUserData"] !== false ||
    record["fullTextCopied"] !== false ||
    record["purpose"] !== "household-safety-provenance-only"
  ) {
    fail("INVALID_SHAPE", path);
  }
  return Object.freeze({
    classification: "official_source_projection",
    containsRealFoodFacts: true,
    containsRealUserData: false,
    fullTextCopied: false,
    purpose: "household-safety-provenance-only",
    factDisposition: enumValue(
      record["factDisposition"],
      sourceFactDispositions,
      childPath(path, "factDisposition"),
    ),
    usageStatus: enumValue(
      record["usageStatus"],
      ["pending", "approved"] as const,
      childPath(path, "usageStatus"),
    ),
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
  "officialEvidence",
] as const;

const decodeEnvelope = (value: JsonValue, path: string): GovernanceEnvelope => {
  const required = envelopeKeys.filter(
    (key) => key !== "syntheticEvidence" && key !== "officialEvidence",
  );
  const record = recordValue(value, envelopeKeys, required, path);
  if (record["schemaVersion"] !== 1) fail("INVALID_SHAPE", childPath(path, "schemaVersion"));
  const hasSyntheticEvidence = Object.hasOwn(record, "syntheticEvidence");
  const hasOfficialEvidence = Object.hasOwn(record, "officialEvidence");
  if (hasSyntheticEvidence === hasOfficialEvidence) {
    fail("INVALID_SHAPE", childPath(path, "officialEvidence"));
  }
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
    approvers: arrayValue(
      record["approvers"],
      childPath(path, "approvers"),
      decodeActor,
      hasOfficialEvidence ? 0 : 1,
    ),
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
    ...(Object.hasOwn(record, "officialEvidence")
      ? {
          officialEvidence: decodeOfficialEvidence(
            record["officialEvidence"],
            childPath(path, "officialEvidence"),
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

const decodeCatalogValue = (value: JsonValue, path = ""): DecodedGovernanceCatalog => {
  const keys = ["schemaVersion", "releases", "hardMappings"];
  const record = recordValue(value, keys, keys, path);
  if (record["schemaVersion"] !== 1) {
    fail("INVALID_SHAPE", childPath(path, "schemaVersion"));
  }
  const catalog: GovernanceCatalog = {
    schemaVersion: 1,
    releases: arrayValue(
      record["releases"],
      childPath(path, "releases"),
      decodeReleaseValue,
      1,
    ),
    hardMappings: arrayValue(
      record["hardMappings"],
      childPath(path, "hardMappings"),
      decodeHardMapping,
    ),
  };
  return Object.freeze(catalog) as DecodedGovernanceCatalog;
};

const decodeMappingSelection = (value: JsonValue | undefined, path: string): MappingSelection => {
  const probe = recordValue(
    value,
    ["status", "mappingIds", "candidateMappingIds"],
    ["status"],
    path,
  );
  if (
    typeof probe["status"] !== "string" ||
    !(constraintMappingStatuses as readonly string[]).includes(probe["status"])
  ) {
    failHouseholdInput("UNKNOWN_DISCRIMINATOR", childPath(path, "status"));
  }
  if (probe["status"] === "mapped") {
    const record = recordValue(value, ["status", "mappingIds"], ["status", "mappingIds"], path);
    const mappingIds = boundedArray(
      record["mappingIds"],
      childPath(path, "mappingIds"),
      identifier,
      1,
      64,
    );
    uniqueValues(mappingIds, childPath(path, "mappingIds"), "DUPLICATE_MAPPING_ID");
    return Object.freeze({ status: "mapped", mappingIds });
  }
  if (probe["status"] === "ambiguous") {
    const record = recordValue(
      value,
      ["status", "candidateMappingIds"],
      ["status", "candidateMappingIds"],
      path,
    );
    const candidateMappingIds = boundedArray(
      record["candidateMappingIds"],
      childPath(path, "candidateMappingIds"),
      identifier,
      2,
      64,
    );
    uniqueValues(
      candidateMappingIds,
      childPath(path, "candidateMappingIds"),
      "DUPLICATE_MAPPING_ID",
    );
    return Object.freeze({ status: "ambiguous", candidateMappingIds });
  }
  recordValue(value, ["status"], ["status"], path);
  return Object.freeze({ status: "unknown" });
};

const decodeDietaryRuleFact = (value: JsonValue, path: string): DietaryRuleFact => {
  const keys = ["constraintId", "kind", "basis", "mapping"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    constraintId: identifier(record["constraintId"], childPath(path, "constraintId")),
    kind: enumValue(record["kind"], dietaryRuleKinds, childPath(path, "kind")),
    basis: enumValue(record["basis"], constraintBases, childPath(path, "basis")),
    mapping: decodeMappingSelection(record["mapping"], childPath(path, "mapping")),
  });
};

const decodeConstraints = (value: JsonValue | undefined, path: string): readonly DietaryRuleFact[] => {
  const constraints = boundedArray(value, path, decodeDietaryRuleFact, 0, 64);
  uniqueValues(
    constraints.map((constraint) => constraint.constraintId),
    path,
    "DUPLICATE_CONSTRAINT_ID",
  );
  return constraints;
};

const decodeHouseholdProfile = (
  value: JsonValue,
  path: string,
): HouseholdProfileSafetyFacts => {
  const keys = ["profileId", "status", "constraints"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    profileId: identifier(record["profileId"], childPath(path, "profileId")),
    status: enumValue(record["status"], householdProfileStatuses, childPath(path, "status")),
    constraints: decodeConstraints(record["constraints"], childPath(path, "constraints")),
  });
};

const decodeGuest = (value: JsonValue, path: string): GuestParticipantSafetyFacts => {
  const keys = ["guestId", "constraints"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    guestId: identifier(record["guestId"], childPath(path, "guestId")),
    constraints: decodeConstraints(record["constraints"], childPath(path, "constraints")),
  });
};

const decodeDishExposure = (value: JsonValue, path: string): DishExposure => {
  const keys = ["exposureId", "kind", "mapping"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    exposureId: identifier(record["exposureId"], childPath(path, "exposureId")),
    kind: enumValue(record["kind"], dishExposureKinds, childPath(path, "kind")),
    mapping: decodeMappingSelection(record["mapping"], childPath(path, "mapping")),
  });
};

const decodeDish = (value: JsonValue | undefined, path: string): DishSafetyFacts => {
  const keys = ["dishId", "dishRevision", "contentDigest", "exposures"];
  const record = recordValue(value, keys, keys, path);
  const exposures = boundedArray(
    record["exposures"],
    childPath(path, "exposures"),
    decodeDishExposure,
    0,
    512,
  );
  uniqueValues(
    exposures.map((exposure) => exposure.exposureId),
    childPath(path, "exposures"),
    "DUPLICATE_EXPOSURE_ID",
  );
  return Object.freeze({
    dishId: identifier(record["dishId"], childPath(path, "dishId")),
    dishRevision: positiveRevision(record["dishRevision"], childPath(path, "dishRevision")),
    contentDigest: patternedString(
      record["contentDigest"],
      childPath(path, "contentDigest"),
      digestPattern,
    ),
    exposures: exposures as DishSafetyFacts["exposures"],
  });
};

const decodeSourcePackSnapshotRef = (
  value: JsonValue | undefined,
  path: string,
): SourcePackSnapshotRef => {
  const keys = ["packId", "packRevision", "contentDigest"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    packId: identifier(record["packId"], childPath(path, "packId")),
    packRevision: positiveRevision(record["packRevision"], childPath(path, "packRevision")),
    contentDigest: patternedString(
      record["contentDigest"],
      childPath(path, "contentDigest"),
      digestPattern,
    ),
  });
};

const decodeHouseholdDishSafetyInputValue = (value: JsonValue): HouseholdDishSafetyInput => {
  const keys = [
    "schemaVersion",
    "asOf",
    "household",
    "expectedSourcePack",
    "householdProfiles",
    "mealParticipantProfileIds",
    "guestParticipants",
    "dish",
  ];
  const record = recordValue(value, keys, keys, "");
  if (record["schemaVersion"] !== 2) fail("INVALID_SHAPE", "/schemaVersion");
  const household = recordValue(
    record["household"],
    ["country", "foodRuleRegion"],
    ["country", "foodRuleRegion"],
    "/household",
  );
  const householdProfiles = boundedArray(
    record["householdProfiles"],
    "/householdProfiles",
    decodeHouseholdProfile,
    0,
    64,
  );
  uniqueValues(
    householdProfiles.map((profile) => profile.profileId),
    "/householdProfiles",
    "DUPLICATE_PROFILE_ID",
  );
  const mealParticipantProfileIds = boundedArray(
    record["mealParticipantProfileIds"],
    "/mealParticipantProfileIds",
    identifier,
    0,
    64,
  );
  uniqueValues(
    mealParticipantProfileIds,
    "/mealParticipantProfileIds",
    "DUPLICATE_PARTICIPANT_ID",
  );
  const guestParticipants = boundedArray(
    record["guestParticipants"],
    "/guestParticipants",
    decodeGuest,
    0,
    32,
  );
  uniqueValues(
    guestParticipants.map((guest) => guest.guestId),
    "/guestParticipants",
    "DUPLICATE_GUEST_ID",
  );
  return Object.freeze({
    schemaVersion: 2,
    asOf: canonicalInstant(record["asOf"], "/asOf"),
    household: Object.freeze({
      country: enumValue(household["country"], ["CN"] as const, "/household/country"),
      foodRuleRegion: enumValue(
        household["foodRuleRegion"],
        ["CN"] as const,
        "/household/foodRuleRegion",
      ),
    }),
    expectedSourcePack: decodeSourcePackSnapshotRef(
      record["expectedSourcePack"],
      "/expectedSourcePack",
    ),
    householdProfiles,
    mealParticipantProfileIds,
    guestParticipants,
    dish: decodeDish(record["dish"], "/dish"),
  });
};

const decodeReleaseBinding = (value: JsonValue, path: string): ReleaseBinding => {
  const keys = [
    "bindingId",
    "datasetId",
    "datasetKind",
    "releaseId",
    "releaseRevision",
    "releaseDigest",
    "sourceReferenceId",
    "sourceReferenceRevision",
    "sourceVersion",
  ];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    bindingId: identifier(record["bindingId"], childPath(path, "bindingId")),
    datasetId: identifier(record["datasetId"], childPath(path, "datasetId")),
    datasetKind: enumValue(
      record["datasetKind"],
      ["food_concept", "allergen", "religious_ethical"] as const,
      childPath(path, "datasetKind"),
    ),
    releaseId: identifier(record["releaseId"], childPath(path, "releaseId")),
    releaseRevision: positiveRevision(
      record["releaseRevision"],
      childPath(path, "releaseRevision"),
    ),
    releaseDigest: patternedString(
      record["releaseDigest"],
      childPath(path, "releaseDigest"),
      digestPattern,
    ),
    sourceReferenceId: identifier(
      record["sourceReferenceId"],
      childPath(path, "sourceReferenceId"),
    ),
    sourceReferenceRevision: identifier(
      record["sourceReferenceRevision"],
      childPath(path, "sourceReferenceRevision"),
    ),
    sourceVersion: enumValue(
      record["sourceVersion"],
      ["2011", "2025"] as const,
      childPath(path, "sourceVersion"),
    ),
  });
};

const decodeSourceVersionWindow = (value: JsonValue, path: string): SourceVersionWindow => {
  const keys = [
    "bindingId",
    "jurisdictionTimeZone",
    "sourceCivilEffectiveDate",
    "effectiveFrom",
    "effectiveUntil",
  ];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    bindingId: identifier(record["bindingId"], childPath(path, "bindingId")),
    jurisdictionTimeZone: enumValue(
      record["jurisdictionTimeZone"],
      ["Asia/Shanghai"] as const,
      childPath(path, "jurisdictionTimeZone"),
    ),
    sourceCivilEffectiveDate: enumValue(
      record["sourceCivilEffectiveDate"],
      ["2012-04-20", "2027-03-16"] as const,
      childPath(path, "sourceCivilEffectiveDate"),
    ),
    effectiveFrom: canonicalInstant(record["effectiveFrom"], childPath(path, "effectiveFrom")),
    effectiveUntil:
      record["effectiveUntil"] === null
        ? null
        : canonicalInstant(record["effectiveUntil"], childPath(path, "effectiveUntil")),
  });
};

const decodeMappingReview = (value: JsonValue, path: string): MappingReview => {
  const keys = [
    "mappingId",
    "reviewRevision",
    "contentDigest",
    "sourceBindingId",
    "targetBindingId",
    "source",
    "target",
    "required",
    "reviewStatus",
    "effectiveFrom",
    "effectiveUntil",
  ];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    mappingId: identifier(record["mappingId"], childPath(path, "mappingId")),
    reviewRevision: positiveRevision(
      record["reviewRevision"],
      childPath(path, "reviewRevision"),
    ),
    contentDigest: patternedString(
      record["contentDigest"],
      childPath(path, "contentDigest"),
      digestPattern,
    ),
    sourceBindingId: identifier(
      record["sourceBindingId"],
      childPath(path, "sourceBindingId"),
    ),
    targetBindingId: identifier(
      record["targetBindingId"],
      childPath(path, "targetBindingId"),
    ),
    source: decodeReference(record["source"], childPath(path, "source")),
    target: decodeReference(record["target"], childPath(path, "target")),
    required: booleanValue(record["required"], childPath(path, "required")),
    reviewStatus: enumValue(
      record["reviewStatus"],
      mappingReviewStatuses,
      childPath(path, "reviewStatus"),
    ),
    effectiveFrom:
      record["effectiveFrom"] === null
        ? null
        : canonicalInstant(record["effectiveFrom"], childPath(path, "effectiveFrom")),
    effectiveUntil:
      record["effectiveUntil"] === null
        ? null
        : canonicalInstant(record["effectiveUntil"], childPath(path, "effectiveUntil")),
  });
};

const decodeHouseholdSafetySourcePackValue = (value: JsonValue): HouseholdSafetySourcePack => {
  const keys = [
    "schemaVersion",
    "packId",
    "packRevision",
    "contentDigest",
    "lifecycleStatus",
    "country",
    "foodRuleRegion",
    "ruleLanguage",
    "releaseBindings",
    "sourceVersionWindows",
    "mappingReviews",
    "catalog",
  ];
  const record = recordValue(value, keys, keys, "");
  if (record["schemaVersion"] !== 2) fail("INVALID_SHAPE", "/schemaVersion");
  return Object.freeze({
    schemaVersion: 2,
    packId: identifier(record["packId"], "/packId"),
    packRevision: positiveRevision(record["packRevision"], "/packRevision"),
    contentDigest: patternedString(record["contentDigest"], "/contentDigest", digestPattern),
    lifecycleStatus: enumValue(record["lifecycleStatus"], lifecycleStatuses, "/lifecycleStatus"),
    country: enumValue(record["country"], ["CN"] as const, "/country"),
    foodRuleRegion: enumValue(record["foodRuleRegion"], ["CN"] as const, "/foodRuleRegion"),
    ruleLanguage: enumValue(record["ruleLanguage"], ["zh-CN"] as const, "/ruleLanguage"),
    releaseBindings: boundedArray(
      record["releaseBindings"],
      "/releaseBindings",
      decodeReleaseBinding,
      0,
      64,
    ),
    sourceVersionWindows: boundedArray(
      record["sourceVersionWindows"],
      "/sourceVersionWindows",
      decodeSourceVersionWindow,
      0,
      64,
    ),
    mappingReviews: boundedArray(
      record["mappingReviews"],
      "/mappingReviews",
      decodeMappingReview,
      0,
      1_024,
    ),
    catalog: decodeCatalogValue(record["catalog"]!, "/catalog"),
  });
};

const nullableIdentifier = (value: JsonValue | undefined, path: string): string | null =>
  value === null ? null : identifier(value, path);

const decodeSubjectRef = (value: JsonValue | undefined, path: string): SubjectRef => {
  const keys = ["kind", "id"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    kind: enumValue(record["kind"], subjectKinds, childPath(path, "kind")),
    id: identifier(record["id"], childPath(path, "id")),
  });
};

const decodeHouseholdSafetyReason = (
  value: JsonValue,
  path: string,
): HouseholdSafetyReason => {
  const keys = [
    "code",
    "constraintId",
    "constraintMappingId",
    "exposureId",
    "exposureKind",
    "exposureMappingId",
    "mappingEndpoint",
    "mappingId",
    "scope",
    "subject",
  ];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    code: enumValue(record["code"], householdSafetyReasonCodes, childPath(path, "code")),
    constraintId: nullableIdentifier(record["constraintId"], childPath(path, "constraintId")),
    constraintMappingId: nullableIdentifier(
      record["constraintMappingId"],
      childPath(path, "constraintMappingId"),
    ),
    exposureId: nullableIdentifier(record["exposureId"], childPath(path, "exposureId")),
    exposureKind:
      record["exposureKind"] === null
        ? null
        : enumValue(record["exposureKind"], dishExposureKinds, childPath(path, "exposureKind")),
    exposureMappingId: nullableIdentifier(
      record["exposureMappingId"],
      childPath(path, "exposureMappingId"),
    ),
    mappingEndpoint:
      record["mappingEndpoint"] === null
        ? null
        : enumValue(
            record["mappingEndpoint"],
            ["source", "target"] as const,
            childPath(path, "mappingEndpoint"),
          ),
    mappingId: nullableIdentifier(record["mappingId"], childPath(path, "mappingId")),
    scope: enumValue(
      record["scope"],
      householdSafetyReasonScopes,
      childPath(path, "scope"),
    ),
    subject:
      record["subject"] === null
        ? null
        : decodeSubjectRef(record["subject"], childPath(path, "subject")),
  });
};

const analyzedScenarioKeys = [
  "schemaVersion",
  "subjects",
  "tableKnownHardReasons",
  "tableUncertaintyReasons",
  "subjectKnownHardReasons",
  "subjectUncertaintyReasons",
  "softReasons",
] as const;

const decodeInternalSyntheticAnalyzedScenarioValue = (
  value: JsonValue,
  path = "",
): InternalSyntheticAnalyzedScenario => {
  const record = recordValue(value, analyzedScenarioKeys, analyzedScenarioKeys, path);
  if (record["schemaVersion"] !== 1) {
    fail("INVALID_SHAPE", childPath(path, "schemaVersion"));
  }
  const subjectsPath = childPath(path, "subjects");
  const subjects = boundedArray(record["subjects"], subjectsPath, decodeSubjectRef, 1, 96);
  const subjectTokens = subjects.map((subject) => `${subject.kind}\u0000${subject.id}`);
  if (new Set(subjectTokens).size !== subjectTokens.length) fail("INVALID_SHAPE", subjectsPath);
  const subjectSet = new Set(subjectTokens);
  const decodeReasonArray = (key: (typeof analyzedScenarioKeys)[number]) =>
    boundedArray(record[key], childPath(path, key), decodeHouseholdSafetyReason, 0, 4_096);
  const tableKnownHardReasons = decodeReasonArray("tableKnownHardReasons");
  const tableUncertaintyReasons = decodeReasonArray("tableUncertaintyReasons");
  const subjectKnownHardReasons = decodeReasonArray("subjectKnownHardReasons");
  const subjectUncertaintyReasons = decodeReasonArray("subjectUncertaintyReasons");
  const softReasons = decodeReasonArray("softReasons");
  const tableKnownCodes = new Set(["household_allergy_match", "guest_allergy_match"]);
  const subjectKnownCodes = new Set([
    "personal_religious_match",
    "personal_ethical_match",
    "personal_strict_avoid_match",
  ]);
  const softCodes = new Set([
    "soft_ordinary_avoid_match",
    "soft_dislike_match",
    "soft_reduce_match",
  ]);
  const uncertaintyCodes = new Set([
    "source_fact_unknown",
    "source_fact_candidate_clear",
    "mapping_unknown",
    "mapping_ambiguous",
    "mapping_invalid",
    "mapping_withdrawn",
    "mapping_version_mismatch",
    "mapping_unapproved",
    "mapping_required_false",
    "mapping_target_kind_mismatch",
    "mapping_source_unbound",
    "mapping_source_multiple_bindings",
    "mapping_target_unbound",
    "mapping_target_multiple_bindings",
    "mapping_endpoint_not_current",
    "mapping_review_missing",
    "mapping_review_mismatch",
    "mapping_review_not_current",
  ]);
  const selectorStateCodes = new Set(["mapping_unknown", "mapping_ambiguous"]);
  const endpointCodes = new Set([
    "source_fact_unknown",
    "source_fact_candidate_clear",
    "mapping_source_unbound",
    "mapping_source_multiple_bindings",
    "mapping_target_unbound",
    "mapping_target_multiple_bindings",
    "mapping_endpoint_not_current",
  ]);
  type AnalyzedArrayName =
    | "tableKnownHardReasons"
    | "tableUncertaintyReasons"
    | "subjectKnownHardReasons"
    | "subjectUncertaintyReasons"
    | "softReasons";
  const validateReasonContext = (
    arrayName: AnalyzedArrayName,
    value: HouseholdSafetyReason,
    index: number,
  ): void => {
    const base = childPath(childPath(path, arrayName), index);
    const isTableKnown = arrayName === "tableKnownHardReasons";
    const isTableUncertainty = arrayName === "tableUncertaintyReasons";
    const isSubjectKnown = arrayName === "subjectKnownHardReasons";
    const isSubjectUncertainty = arrayName === "subjectUncertaintyReasons";
    const validCode = isTableKnown
      ? tableKnownCodes.has(value.code)
      : isSubjectKnown
        ? subjectKnownCodes.has(value.code)
        : arrayName === "softReasons"
          ? softCodes.has(value.code) || uncertaintyCodes.has(value.code)
          : uncertaintyCodes.has(value.code);
    if (!validCode) fail("INVALID_SHAPE", childPath(base, "code"));
    const expectedScope = isTableKnown || isTableUncertainty
      ? "table"
      : arrayName === "softReasons"
        ? "soft"
        : "subject";
    if (value.scope !== expectedScope) fail("INVALID_SHAPE", childPath(base, "scope"));
    const needsSubject = isSubjectKnown || isSubjectUncertainty || arrayName === "softReasons";
    if (needsSubject && value.subject === null) fail("INVALID_SHAPE", childPath(base, "subject"));
    if (!needsSubject && value.subject !== null) fail("INVALID_SHAPE", childPath(base, "subject"));
    if (
      value.subject !== null &&
      !subjectSet.has(`${value.subject.kind}\u0000${value.subject.id}`)
    ) {
      fail("INVALID_SHAPE", `${childPath(base, "subject")}/id`);
    }

    const known = isTableKnown || isSubjectKnown || softCodes.has(value.code);
    const expectConstraintId = isSubjectKnown || isSubjectUncertainty || arrayName === "softReasons";
    if ((value.constraintId !== null) !== expectConstraintId) {
      fail("INVALID_SHAPE", childPath(base, "constraintId"));
    }
    if ((value.constraintMappingId !== null) !== known) {
      fail("INVALID_SHAPE", childPath(base, "constraintMappingId"));
    }

    const tableFailure = isTableUncertainty;
    const dishOrigin = tableFailure && value.exposureId !== null;
    const expectExposure = known || dishOrigin;
    if ((value.exposureId !== null) !== expectExposure) {
      fail("INVALID_SHAPE", childPath(base, "exposureId"));
    }
    if ((value.exposureKind !== null) !== expectExposure) {
      fail("INVALID_SHAPE", childPath(base, "exposureKind"));
    }
    const factCode = value.code === "source_fact_unknown" || value.code === "source_fact_candidate_clear";
    const expectExposureMapping = known || (dishOrigin && factCode);
    if ((value.exposureMappingId !== null) !== expectExposureMapping) {
      fail("INVALID_SHAPE", childPath(base, "exposureMappingId"));
    }

    const expectEndpoint = !known && endpointCodes.has(value.code);
    if ((value.mappingEndpoint !== null) !== expectEndpoint) {
      fail("INVALID_SHAPE", childPath(base, "mappingEndpoint"));
    }
    if (
      value.code === "mapping_source_unbound" ||
      value.code === "mapping_source_multiple_bindings"
    ) {
      if (value.mappingEndpoint !== "source") {
        fail("INVALID_SHAPE", childPath(base, "mappingEndpoint"));
      }
    }
    if (
      value.code === "mapping_target_unbound" ||
      value.code === "mapping_target_multiple_bindings"
    ) {
      if (value.mappingEndpoint !== "target") {
        fail("INVALID_SHAPE", childPath(base, "mappingEndpoint"));
      }
    }
    const expectMappingId =
      !known && !selectorStateCodes.has(value.code) && !(dishOrigin && factCode);
    if ((value.mappingId !== null) !== expectMappingId) {
      fail("INVALID_SHAPE", childPath(base, "mappingId"));
    }
  };
  tableKnownHardReasons.forEach((value, index) =>
    validateReasonContext("tableKnownHardReasons", value, index));
  tableUncertaintyReasons.forEach((value, index) =>
    validateReasonContext("tableUncertaintyReasons", value, index));
  subjectKnownHardReasons.forEach((value, index) =>
    validateReasonContext("subjectKnownHardReasons", value, index));
  subjectUncertaintyReasons.forEach((value, index) =>
    validateReasonContext("subjectUncertaintyReasons", value, index));
  softReasons.forEach((value, index) =>
    validateReasonContext("softReasons", value, index));
  return Object.freeze({
    schemaVersion: 1,
    subjects,
    tableKnownHardReasons,
    tableUncertaintyReasons,
    subjectKnownHardReasons,
    subjectUncertaintyReasons,
    softReasons,
  });
};

const decodeInternalSyntheticEndpointFact = (
  value: JsonValue,
  path: string,
): InternalSyntheticEndpointFact => {
  const keys = ["reference", "syntheticDisposition"];
  const record = recordValue(value, keys, keys, path);
  return Object.freeze({
    reference: decodeReference(record["reference"], childPath(path, "reference")),
    syntheticDisposition: enumValue(
      record["syntheticDisposition"],
      sourceFactDispositions,
      childPath(path, "syntheticDisposition"),
    ),
  });
};

const decodeInternalSyntheticGovernedGraphValue = (
  value: JsonValue,
): InternalSyntheticGovernedGraph => {
  const keys = [
    "schemaVersion",
    "packId",
    "packRevision",
    "country",
    "foodRuleRegion",
    "ruleLanguage",
    "syntheticSourceUsageStatus",
    "releaseBindings",
    "sourceVersionWindows",
    "mappingReviews",
    "catalog",
    "endpointFacts",
  ];
  const record = recordValue(value, keys, keys, "");
  if (record["schemaVersion"] !== 2) fail("INVALID_SHAPE", "/schemaVersion");
  const catalog = decodeCatalogValue(record["catalog"]!, "/catalog");
  for (let releaseIndex = 0; releaseIndex < catalog.releases.length; releaseIndex += 1) {
    const release = catalog.releases[releaseIndex]!;
    for (let envelopeIndex = 0; envelopeIndex < release.envelopes.length; envelopeIndex += 1) {
      const envelope = release.envelopes[envelopeIndex]!;
      if (envelope.syntheticEvidence === undefined || envelope.officialEvidence !== undefined) {
        fail(
          "INVALID_SHAPE",
          `/catalog/releases/${releaseIndex}/envelopes/${envelopeIndex}/syntheticEvidence`,
        );
      }
    }
  }
  return Object.freeze({
    schemaVersion: 2,
    packId: identifier(record["packId"], "/packId"),
    packRevision: positiveRevision(record["packRevision"], "/packRevision"),
    country: enumValue(record["country"], ["CN"] as const, "/country"),
    foodRuleRegion: enumValue(record["foodRuleRegion"], ["CN"] as const, "/foodRuleRegion"),
    ruleLanguage: enumValue(record["ruleLanguage"], ["zh-CN"] as const, "/ruleLanguage"),
    syntheticSourceUsageStatus: enumValue(
      record["syntheticSourceUsageStatus"],
      ["pending", "approved"] as const,
      "/syntheticSourceUsageStatus",
    ),
    releaseBindings: boundedArray(
      record["releaseBindings"],
      "/releaseBindings",
      decodeReleaseBinding,
      0,
      64,
    ),
    sourceVersionWindows: boundedArray(
      record["sourceVersionWindows"],
      "/sourceVersionWindows",
      decodeSourceVersionWindow,
      0,
      64,
    ),
    mappingReviews: boundedArray(
      record["mappingReviews"],
      "/mappingReviews",
      decodeMappingReview,
      0,
      1_024,
    ),
    catalog,
    endpointFacts: boundedArray(
      record["endpointFacts"],
      "/endpointFacts",
      decodeInternalSyntheticEndpointFact,
      0,
      1_024,
    ),
  });
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

function captureHouseholdInput(
  operation: () => HouseholdDishSafetyInput,
): HouseholdSafetyInputDecodeResult {
  try {
    return Object.freeze({ ok: true, value: operation() });
  } catch (error: unknown) {
    const code =
      error instanceof HouseholdInputSignal
        ? error.code
        : error instanceof DecodeSignal
          ? error.code
          : "INVALID_SHAPE";
    const path =
      error instanceof HouseholdInputSignal || error instanceof DecodeSignal ? error.path : "";
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

const prepareHouseholdBoundary = (value: unknown): JsonValue =>
  typeof value === "string" ? prepareRaw(value) : prepareObject(value);

export const decodeHouseholdDishSafetyInput = (
  value: unknown,
): HouseholdSafetyInputDecodeResult =>
  captureHouseholdInput(() => decodeHouseholdDishSafetyInputValue(prepareHouseholdBoundary(value)));

export const decodeHouseholdSafetySourcePack = (
  value: unknown,
): DecodeResult<HouseholdSafetySourcePack> =>
  capture(() => decodeHouseholdSafetySourcePackValue(prepareHouseholdBoundary(value)));

export const decodeInternalSyntheticAnalyzedScenario = (
  value: unknown,
): DecodeResult<InternalSyntheticAnalyzedScenario> =>
  capture(() => decodeInternalSyntheticAnalyzedScenarioValue(prepareObject(value)));

export const decodeInternalSyntheticGovernedGraph = (
  value: unknown,
): DecodeResult<InternalSyntheticGovernedGraph> =>
  capture(() => decodeInternalSyntheticGovernedGraphValue(prepareObject(value)));

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
