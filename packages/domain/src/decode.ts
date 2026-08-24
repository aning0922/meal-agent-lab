import {
  datasetKinds,
  licenseStatuses,
  lifecycleStatuses,
  sourceTiers,
  withdrawalStates,
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

const invalidUnicodeScalar =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const arrayIndex = /^(?:0|[1-9][0-9]*)$/;

class DecodeFailure {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
}
const fail = (path: string): never => {
  throw new DecodeFailure(path);
};
const scalarString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || invalidUnicodeScalar.test(value)) fail(path);
  return value as string;
};
const nonEmptyString = (value: unknown, path: string): string => {
  const decoded = scalarString(value, path);
  if (decoded.length === 0) fail(path);
  return decoded;
};
const finiteNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) fail(path);
  return value as number;
};
const positiveRevision = (value: unknown, path: string): number => {
  const decoded = finiteNumber(value, path);
  if (!Number.isSafeInteger(decoded) || decoded < 1) fail(path);
  return decoded;
};
const booleanValue = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") fail(path);
  return value as boolean;
};
const enumValue = <T extends string>(value: unknown, allowed: readonly T[], path: string): T => {
  const decoded = scalarString(value, path);
  if (!(allowed as readonly string[]).includes(decoded)) fail(path);
  return decoded as T;
};

const dataObject = (
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path);
  const objectValue = value as object;
  const prototype = Object.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype) fail(path);
  const allowedSet = new Set(allowed);
  const keys = Reflect.ownKeys(objectValue);
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || invalidUnicodeScalar.test(key) || !allowedSet.has(key)) {
      fail(typeof key === "string" ? `${path}/${key}` : path);
    }
    const stringKey = key as string;
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, stringKey);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(`${path}/${stringKey}`);
    }
    values[stringKey] = (descriptor as PropertyDescriptor & { value: unknown }).value;
  }
  for (const key of required) {
    if (!Object.hasOwn(values, key)) fail(`${path}/${key}`);
  }
  return values;
};

const dataArray = <T>(
  value: unknown,
  path: string,
  decodeItem: (item: unknown, itemPath: string) => T,
): readonly T[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(path);
  const arrayValue = value as unknown[];
  const keys = Reflect.ownKeys(arrayValue);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(arrayValue, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    fail(`${path}/length`);
  }
  const length = (lengthDescriptor as PropertyDescriptor & { value: number }).value;
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !arrayIndex.test(key) || Number(key) >= length) fail(path);
  }
  if (keys.length !== length + 1) fail(path);
  const decoded: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(arrayValue, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(`${path}/${index}`);
    }
    decoded.push(
      decodeItem(
        (descriptor as PropertyDescriptor & { value: unknown }).value,
        `${path}/${index}`,
      ),
    );
  }
  return Object.freeze(decoded);
};

const decodeJsonValue = (value: unknown, path: string, ancestors: Set<object>): JsonValue => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return scalarString(value, path);
  if (typeof value === "number") return finiteNumber(value, path);
  if (typeof value !== "object" || value === undefined) fail(path);
  const objectValue = value as object;
  if (ancestors.has(objectValue)) fail(path);
  ancestors.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      return dataArray(objectValue, path, (item, itemPath) =>
        decodeJsonValue(item, itemPath, ancestors),
      );
    }
    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype) fail(path);
    const decoded: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(objectValue)) {
      if (typeof key !== "string" || invalidUnicodeScalar.test(key)) fail(path);
      const stringKey = key as string;
      const descriptor = Object.getOwnPropertyDescriptor(objectValue, stringKey);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        fail(`${path}/${stringKey}`);
      }
      decoded[stringKey] = decodeJsonValue(
        (descriptor as PropertyDescriptor & { value: unknown }).value,
        `${path}/${stringKey}`,
        ancestors,
      );
    }
    return Object.freeze(decoded);
  } finally {
    ancestors.delete(objectValue);
  }
};

const decodeActor = (value: unknown, path: string): GovernanceActor => {
  const object = dataObject(value, ["actorId", "role"], ["actorId", "role"], path);
  return Object.freeze({
    actorId: nonEmptyString(object["actorId"], `${path}/actorId`),
    role: nonEmptyString(object["role"], `${path}/role`),
  });
};
const decodeReference = (value: unknown, path: string): GovernedReference => {
  const keys = ["datasetId", "entityId", "entityRevision"];
  const object = dataObject(value, keys, keys, path);
  return Object.freeze({
    datasetId: nonEmptyString(object["datasetId"], `${path}/datasetId`),
    entityId: nonEmptyString(object["entityId"], `${path}/entityId`),
    entityRevision: positiveRevision(object["entityRevision"], `${path}/entityRevision`),
  });
};
const decodeSourceReference = (value: unknown, path: string): SourceReference => {
  const keys = ["referenceId", "referenceRevision", "locator"];
  const object = dataObject(value, keys, keys, path);
  return Object.freeze({
    referenceId: nonEmptyString(object["referenceId"], `${path}/referenceId`),
    referenceRevision: nonEmptyString(object["referenceRevision"], `${path}/referenceRevision`),
    locator: nonEmptyString(object["locator"], `${path}/locator`),
  });
};
const decodeSourceSnapshot = (value: unknown, path: string): SourceSnapshot => {
  const keys = ["snapshotId", "referenceId", "referenceRevision", "contentDigest", "retrievedAt"];
  const object = dataObject(value, keys, keys, path);
  return Object.freeze({
    snapshotId: nonEmptyString(object["snapshotId"], `${path}/snapshotId`),
    referenceId: nonEmptyString(object["referenceId"], `${path}/referenceId`),
    referenceRevision: nonEmptyString(object["referenceRevision"], `${path}/referenceRevision`),
    contentDigest: nonEmptyString(object["contentDigest"], `${path}/contentDigest`),
    retrievedAt: nonEmptyString(object["retrievedAt"], `${path}/retrievedAt`),
  });
};
const decodeAlias = (value: unknown, path: string): GovernanceAlias => {
  const keys = ["value", "region", "language", "sourceReferenceId", "sourceReferenceRevision"];
  const object = dataObject(value, keys, keys, path);
  return Object.freeze({
    value: nonEmptyString(object["value"], `${path}/value`),
    region: nonEmptyString(object["region"], `${path}/region`),
    language: nonEmptyString(object["language"], `${path}/language`),
    sourceReferenceId: nonEmptyString(object["sourceReferenceId"], `${path}/sourceReferenceId`),
    sourceReferenceRevision: nonEmptyString(
      object["sourceReferenceRevision"],
      `${path}/sourceReferenceRevision`,
    ),
  });
};
const decodeSyntheticEvidence = (value: unknown, path: string): SyntheticEvidence => {
  const keys = [
    "classification",
    "generator",
    "containsRealUserData",
    "containsRealFoodFacts",
    "purpose",
  ];
  const object = dataObject(value, keys, keys, path);
  if (
    object["classification"] !== "fully_synthetic" ||
    object["generator"] !== "stage09p-m0-fixture-v1" ||
    object["containsRealUserData"] !== false ||
    object["containsRealFoodFacts"] !== false ||
    object["purpose"] !== "governance-format-and-fail-closed-testing-only"
  ) {
    fail(path);
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
  "releaseId",
  "releaseRevision",
  "contentDigest",
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

const decodeEnvelope = (value: unknown, path: string): GovernanceEnvelope => {
  const object = dataObject(value, envelopeKeys, envelopeKeys.slice(0, -1), path);
  const nullableString = (key: string): string | null =>
    object[key] === null ? null : nonEmptyString(object[key], `${path}/${key}`);
  const schemaVersion = positiveRevision(object["schemaVersion"], `${path}/schemaVersion`);
  if (schemaVersion !== 1) fail(`${path}/schemaVersion`);
  return Object.freeze({
    schemaVersion: 1,
    datasetId: nonEmptyString(object["datasetId"], `${path}/datasetId`),
    datasetKind: enumValue(object["datasetKind"], datasetKinds, `${path}/datasetKind`),
    releaseId: nonEmptyString(object["releaseId"], `${path}/releaseId`),
    releaseRevision: positiveRevision(object["releaseRevision"], `${path}/releaseRevision`),
    contentDigest: nonEmptyString(object["contentDigest"], `${path}/contentDigest`),
    entityId: nonEmptyString(object["entityId"], `${path}/entityId`),
    entityRevision: positiveRevision(object["entityRevision"], `${path}/entityRevision`),
    lifecycleStatus: enumValue(
      object["lifecycleStatus"],
      lifecycleStatuses,
      `${path}/lifecycleStatus`,
    ),
    owner: decodeActor(object["owner"], `${path}/owner`),
    approvers: dataArray(object["approvers"], `${path}/approvers`, decodeActor),
    sourceTier: enumValue(object["sourceTier"], sourceTiers, `${path}/sourceTier`),
    sourceReferences: dataArray(
      object["sourceReferences"],
      `${path}/sourceReferences`,
      decodeSourceReference,
    ),
    sourceSnapshots: dataArray(
      object["sourceSnapshots"],
      `${path}/sourceSnapshots`,
      decodeSourceSnapshot,
    ),
    applicableRegions: dataArray(
      object["applicableRegions"],
      `${path}/applicableRegions`,
      nonEmptyString,
    ),
    languages: dataArray(object["languages"], `${path}/languages`, nonEmptyString),
    licenseStatus: enumValue(object["licenseStatus"], licenseStatuses, `${path}/licenseStatus`),
    licenseReference: nullableString("licenseReference"),
    retrievedAt: nonEmptyString(object["retrievedAt"], `${path}/retrievedAt`),
    reviewedAt: nonEmptyString(object["reviewedAt"], `${path}/reviewedAt`),
    reviewDueAt: nonEmptyString(object["reviewDueAt"], `${path}/reviewDueAt`),
    aliases: dataArray(object["aliases"], `${path}/aliases`, decodeAlias),
    supersededBy:
      object["supersededBy"] === null
        ? null
        : decodeReference(object["supersededBy"], `${path}/supersededBy`),
    withdrawalState: enumValue(
      object["withdrawalState"],
      withdrawalStates,
      `${path}/withdrawalState`,
    ),
    withdrawalReason: nullableString("withdrawalReason"),
    withdrawnAt: nullableString("withdrawnAt"),
    content: decodeJsonValue(object["content"], `${path}/content`, new Set()),
    ...(Object.hasOwn(object, "syntheticEvidence")
      ? {
          syntheticEvidence: decodeSyntheticEvidence(
            object["syntheticEvidence"],
            `${path}/syntheticEvidence`,
          ),
        }
      : {}),
  });
};

const decodeReleaseUnsafe = (value: unknown, path: string): DecodedGovernanceRelease => {
  const object = dataObject(value, ["$schema", "envelopes"], ["envelopes"], path);
  const release: GovernanceRelease = {
    ...(Object.hasOwn(object, "$schema")
      ? { $schema: nonEmptyString(object["$schema"], `${path}/$schema`) }
      : {}),
    envelopes: dataArray(object["envelopes"], `${path}/envelopes`, decodeEnvelope),
  };
  return Object.freeze(release) as DecodedGovernanceRelease;
};

const decodeHardMapping = (value: unknown, path: string): HardMapping => {
  const keys = ["mappingId", "source", "target", "required"];
  const object = dataObject(value, keys, keys, path);
  return Object.freeze({
    mappingId: nonEmptyString(object["mappingId"], `${path}/mappingId`),
    source: decodeReference(object["source"], `${path}/source`),
    target: decodeReference(object["target"], `${path}/target`),
    required: booleanValue(object["required"], `${path}/required`),
  });
};

const decodeCatalogUnsafe = (value: unknown): DecodedGovernanceCatalog => {
  const object = dataObject(
    value,
    ["releases", "hardMappings"],
    ["releases", "hardMappings"],
    "catalog",
  );
  const catalog: GovernanceCatalog = {
    releases: dataArray(object["releases"], "catalog/releases", decodeReleaseUnsafe),
    hardMappings: dataArray(object["hardMappings"], "catalog/hardMappings", decodeHardMapping),
  };
  return Object.freeze(catalog) as DecodedGovernanceCatalog;
};

const result = <T>(operation: () => T, rootPath: string): DecodeResult<T> => {
  try {
    return { ok: true, value: operation() };
  } catch (error: unknown) {
    return {
      ok: false,
      issue: {
        code: "INVALID_SHAPE",
        path: error instanceof DecodeFailure ? error.path : rootPath,
      },
    };
  }
};

export const decodeGovernanceRelease = (value: unknown): DecodeResult<DecodedGovernanceRelease> =>
  result(() => decodeReleaseUnsafe(value, "release"), "release");

export const decodeGovernanceReleaseJson = (
  text: string,
): DecodeResult<DecodedGovernanceRelease> =>
  result(() => decodeReleaseUnsafe(JSON.parse(text) as unknown, "release"), "release");

export const decodeGovernedReference = (value: unknown): DecodeResult<GovernedReference> =>
  result(() => decodeReference(value, "reference"), "reference");

export const decodeGovernanceCatalog = (value: unknown): DecodeResult<DecodedGovernanceCatalog> =>
  result(() => decodeCatalogUnsafe(value), "catalog");

export const decodeGovernanceCatalogJson = (
  text: string,
): DecodeResult<DecodedGovernanceCatalog> =>
  result(() => decodeCatalogUnsafe(JSON.parse(text) as unknown), "catalog");
