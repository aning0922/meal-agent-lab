/**
 * Recursive readonly view for the plain scalar/object/array data emitted by the
 * Stage 09P Zod schemas. The scalar branch must precede the object branch so
 * branded primitive strings retain their nominal string type.
 */
export type DeepReadonly<T> =
  T extends string | number | boolean | bigint | symbol | null | undefined
    ? T
    : T extends (...args: never[]) => unknown
      ? T
      : T extends readonly unknown[]
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;

const STAGE09P_PGINT_MAX = "9223372036854775807";
const STAGE09P_PGINT_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
const STAGE09P_POSITIVE_PGINT_PATTERN = /^[1-9][0-9]{0,18}$/;
const STAGE09P_RAW_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const STAGE09P_CANONICAL_INSTANT_PATTERN = /^(?!0000-)(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

export const isStage09pPgInt = (value: unknown, positive = false): value is string => {
  if (typeof value !== "string" || !(positive ? STAGE09P_POSITIVE_PGINT_PATTERN : STAGE09P_PGINT_PATTERN).test(value)) return false;
  return value.length < STAGE09P_PGINT_MAX.length || (value.length === STAGE09P_PGINT_MAX.length && value <= STAGE09P_PGINT_MAX);
};

const incrementCanonicalDecimal = (value: string): string => {
  const digits = [...value];
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = Number(digits[index]);
    if (digit < 9) { digits[index] = String(digit + 1); return digits.join(""); }
    digits[index] = "0";
  }
  return `1${digits.join("")}`;
};

export const isStage09pPgIntSuccessor = (expected: unknown, resulting: unknown): boolean =>
  isStage09pPgInt(expected) && isStage09pPgInt(resulting, true) && expected !== STAGE09P_PGINT_MAX && incrementCanonicalDecimal(expected) === resulting;

export const isStage09pGregorianDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
};

export const canonicalizeStage09pInstant = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = STAGE09P_RAW_INSTANT_PATTERN.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined || match[5] === undefined || match[6] === undefined || match[8] === undefined) return null;
  if (!isStage09pGregorianDate(`${match[1]}-${match[2]}-${match[3]}`) || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  if (match[8] !== "Z" && (Number(match[8].slice(1, 3)) > 23 || Number(match[8].slice(4, 6)) > 59)) return null;
  try {
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) return null;
    const canonical = new Date(epoch).toISOString();
    return STAGE09P_CANONICAL_INSTANT_PATTERN.test(canonical) ? canonical : null;
  } catch {
    return null;
  }
};

export const isStage09pRawInstant = (value: unknown): value is string => canonicalizeStage09pInstant(value) !== null;
export const isStage09pCanonicalInstant = (value: unknown): value is string => typeof value === "string" && STAGE09P_CANONICAL_INSTANT_PATTERN.test(value) && canonicalizeStage09pInstant(value) === value;

export const STAGE09P_INPUT_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 1_000_000,
  maxArrayLength: 20_000,
  maxObjectKeys: 256,
  maxDescriptorKeys: 4_000_000,
  maxStringScalars: 65_536,
  maxTotalStringScalars: 16_000_000,
});

// Matches the currently configured Fastify bodyLimit. This parser rechecks the
// already-materialized string; R7-C must enforce the same cap while reading the
// request stream, before constructing a string.
export const maxReplayChunkUtf8Bytes = 1_048_576 as const;
export const maxTotalReplayEvents = 10_000 as const;

// Canonical JSON.stringify-compatible wire maxima include schema-valid C0
// controls, whose representation costs six ASCII bytes per decoded scalar.
const inventoryReplayChunkProof = Object.freeze({ maxEventNodes: 280, maxEventDescriptorKeys: 300, maxEventStringScalars: 20_000, maxCanonicalEventUtf8Bytes: 59_225, maxEnvelopeUtf8Bytes: 4_096, envelopeNodes: 100, envelopeDescriptorKeys: 200, envelopeStringScalars: 10_000 });
const seasoningReplayChunkProof = Object.freeze({ maxEventNodes: 40, maxEventDescriptorKeys: 40, maxEventStringScalars: 1_500, maxCanonicalEventUtf8Bytes: 2_693, maxEnvelopeUtf8Bytes: 3_000, envelopeNodes: 100, envelopeDescriptorKeys: 200, envelopeStringScalars: 10_000 });
const eventsPerChunkFromWireProof = (proof: typeof inventoryReplayChunkProof | typeof seasoningReplayChunkProof): number => Math.floor((maxReplayChunkUtf8Bytes - proof.maxEnvelopeUtf8Bytes + 1) / (proof.maxCanonicalEventUtf8Bytes + 1));
export const maxInventoryReplayEventsPerChunk = eventsPerChunkFromWireProof(inventoryReplayChunkProof);
export const maxSeasoningReplayEventsPerChunk = eventsPerChunkFromWireProof(seasoningReplayChunkProof);

const replayChunkLimitsFromProof = (proof: typeof inventoryReplayChunkProof | typeof seasoningReplayChunkProof, maxEvents: number) => {
  const maxNodes = proof.envelopeNodes + maxEvents * proof.maxEventNodes;
  const maxDescriptorKeys = proof.envelopeDescriptorKeys + maxEvents * proof.maxEventDescriptorKeys;
  const maxTotalStringScalars = proof.envelopeStringScalars + maxEvents * proof.maxEventStringScalars;
  return Object.freeze({ ...STAGE09P_INPUT_LIMITS, maxNodes, maxArrayLength: maxEvents, maxDescriptorKeys, maxTotalStringScalars, maxRawUtf8Bytes: maxReplayChunkUtf8Bytes, maxRawCodeUnits: maxReplayChunkUtf8Bytes, maxEvents, maxTotalEvents: maxTotalReplayEvents, proof });
};
export const STAGE09P_REPLAY_CHUNK_LIMITS = Object.freeze({
  inventory: replayChunkLimitsFromProof(inventoryReplayChunkProof, maxInventoryReplayEventsPerChunk),
  seasoning: replayChunkLimitsFromProof(seasoningReplayChunkProof, maxSeasoningReplayEventsPerChunk),
});

export type Stage09pInputReason =
  | "INPUT_DESCRIPTOR_INVALID"
  | "INPUT_RESOURCE_LIMIT_EXCEEDED";

export type Stage09pInputResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: Stage09pInputReason };

export type Stage09pReplayChunkInputReason =
  | "INPUT_DESCRIPTOR_INVALID"
  | "INPUT_JSON_SYNTAX_INVALID"
  | "INPUT_CANONICAL_NUMBER_INVALID"
  | "INPUT_WIRE_BYTE_CAPACITY_EXCEEDED"
  | "INPUT_DECODED_RESOURCE_LIMIT_EXCEEDED"
  | "INPUT_CHUNK_EVENT_CAPACITY_EXCEEDED";

export type Stage09pReplayChunkInputResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: Stage09pReplayChunkInputReason };

class CopyFailure extends Error {
  constructor(readonly reason: Stage09pInputReason) {
    super(reason);
  }
}

const fail = (reason: Stage09pInputReason): never => {
  throw new CopyFailure(reason);
};

const stringScalarLength = (value: string, maximum: number): number | null => {
  let count = 0;
  for (const scalar of value) {
    void scalar;
    count += 1;
    if (count > maximum) return null;
  }
  return count;
};

const readSnapshot = (value: object, chargeKeys: (keys: readonly (string | symbol)[]) => void): {
  readonly prototype: object | null;
  readonly keys: readonly (string | symbol)[];
  readonly descriptors: ReadonlyMap<string | symbol, PropertyDescriptor>;
} => {
  try {
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    chargeKeys(keys);
    const descriptors = new Map<string | symbol, PropertyDescriptor>();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return fail("INPUT_DESCRIPTOR_INVALID");
      descriptors.set(key, descriptor);
    }
    return { prototype, keys, descriptors };
  } catch (error) {
    if (error instanceof CopyFailure) throw error;
    return fail("INPUT_DESCRIPTOR_INVALID");
  }
};

const defineData = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
};

/**
 * Deep-freezes fresh, ordinary data owned by a successful Stage 09P Zod parse.
 * This is deliberately not an arbitrary-object sanitizer: callers must not pass
 * user-owned proxies or class instances. Traversal reads data descriptors only,
 * so an unexpected accessor is rejected without invoking its getter.
 */
export const deepFreezeStage09pOwnedData = <T>(
  value: T,
): DeepReadonly<T> => {
  const visiting = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const postorder: object[] = [];

  const visit = (current: unknown): void => {
    if (current === null || typeof current !== "object") return;
    if (visited.has(current)) return;
    if (visiting.has(current)) {
      throw new TypeError("STAGE09P_OWNED_DATA_DESCRIPTOR_INVALID");
    }

    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new TypeError("STAGE09P_OWNED_DATA_NOT_PLAIN");
    }

    visiting.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key === "symbol") {
        throw new TypeError("STAGE09P_OWNED_DATA_DESCRIPTOR_INVALID");
      }
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("STAGE09P_OWNED_DATA_DESCRIPTOR_INVALID");
      }
      visit(descriptor.value);
    }
    visiting.delete(current);
    visited.add(current);
    postorder.push(current);
  };

  visit(value);
  for (const current of postorder) Object.freeze(current);
  return value as DeepReadonly<T>;
};

/**
 * Pre-Zod guard for replay DTO boundaries. Zod intentionally ignores the own
 * `__proto__` key while parsing objects, so a strict object alone cannot prove
 * that an input graph contains only declared JSON fields. This descriptor-only
 * walk also prevents accessors, symbols, sparse/extended arrays, cycles and
 * exotic prototypes from being normalized away before strict schema checks.
 */
export const isStage09pSchemaInputDataGraph = (value: unknown): boolean => {
  const visiting = new WeakSet<object>();
  const visited = new WeakSet<object>();

  const visit = (current: unknown): boolean => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current !== "object") return false;
    if (visited.has(current)) return true;
    if (visiting.has(current)) return false;

    try {
      const array = Array.isArray(current);
      const prototype = Object.getPrototypeOf(current);
      if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) return false;
      const keys = Reflect.ownKeys(current);
      const lengthDescriptor = array ? Object.getOwnPropertyDescriptor(current, "length") : undefined;
      const length = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : 0;
      if (array && (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)) return false;

      visiting.add(current);
      for (const key of keys) {
        if (typeof key === "symbol" || key === "__proto__") return false;
        if (array && key === "length") continue;
        if (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
        if (!visit(descriptor.value)) return false;
      }
      if (array && keys.length !== length + 1) return false;
      visiting.delete(current);
      visited.add(current);
      return true;
    } catch {
      return false;
    }
  };

  return visit(value);
};

type Stage09pOperationalLimits = Readonly<{ maxDepth: number; maxNodes: number; maxArrayLength: number; maxObjectKeys: number; maxDescriptorKeys: number; maxStringScalars: number; maxTotalStringScalars: number }>;
const copyStage09pInputWithLimits = (input: unknown, limits: Stage09pOperationalLimits): Stage09pInputResult => {
  const active = new WeakSet<object>();
  const scalarLengthCache = new Map<string, number>();
  let nodes = 0;
  let descriptorKeys = 0;
  let totalStringScalars = 0;

  const chargeString = (value: string): void => {
    let length = scalarLengthCache.get(value);
    if (length === undefined) {
      const measured = stringScalarLength(value, limits.maxStringScalars);
      if (measured === null) {
        return fail("INPUT_RESOURCE_LIMIT_EXCEEDED");
      }
      length = measured;
      scalarLengthCache.set(value, length);
    }
    totalStringScalars += length;
    if (totalStringScalars > limits.maxTotalStringScalars) {
      return fail("INPUT_RESOURCE_LIMIT_EXCEEDED");
    }
  };

  const chargeDescriptorKeys = (keys: readonly (string | symbol)[]): void => {
    descriptorKeys += keys.length;
    if (descriptorKeys > limits.maxDescriptorKeys) {
      return fail("INPUT_RESOURCE_LIMIT_EXCEEDED");
    }
    for (const key of keys) if (typeof key === "string") chargeString(key);
  };

  const copy = (value: unknown, depth: number): unknown => {
    if (depth > limits.maxDepth) {
      return fail("INPUT_RESOURCE_LIMIT_EXCEEDED");
    }
    nodes += 1;
    if (nodes > limits.maxNodes) {
      return fail("INPUT_RESOURCE_LIMIT_EXCEEDED");
    }

    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      chargeString(value);
      return value;
    }
    // Preserve every JS number, including NaN/Infinity/-0. Field-level
    // normalizers own semantic classification of number slots.
    if (typeof value === "number") return value;
    if (
      typeof value === "undefined" ||
      typeof value === "bigint" ||
      typeof value === "symbol" ||
      typeof value === "function"
    ) {
      return fail("INPUT_DESCRIPTOR_INVALID");
    }
    if (typeof value !== "object") return fail("INPUT_DESCRIPTOR_INVALID");
    if (active.has(value)) return fail("INPUT_DESCRIPTOR_INVALID");
    active.add(value);

    try {
      const snapshot = readSnapshot(value, chargeDescriptorKeys);
      if (Array.isArray(value)) {
        const lengthDescriptor = snapshot.descriptors.get("length");
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          typeof lengthDescriptor.value !== "number" ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) {
          return fail("INPUT_DESCRIPTOR_INVALID");
        }
        const length = lengthDescriptor.value;
        if (length > limits.maxArrayLength) {
          return fail("INPUT_RESOURCE_LIMIT_EXCEEDED");
        }
        if (snapshot.keys.length !== length + 1) {
          return fail("INPUT_DESCRIPTOR_INVALID");
        }
        const output: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const key = String(index);
          const descriptor = snapshot.descriptors.get(key);
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          ) {
            return fail("INPUT_DESCRIPTOR_INVALID");
          }
          output.push(copy(descriptor.value, depth + 1));
        }
        for (const key of snapshot.keys) {
          if (typeof key === "symbol") return fail("INPUT_DESCRIPTOR_INVALID");
          if (key === "length") continue;
          if (!/^(?:0|[1-9][0-9]*)$/.test(key)) {
            return fail("INPUT_DESCRIPTOR_INVALID");
          }
          const index = Number(key);
          if (index < 0 || index >= length || String(index) !== key) {
            return fail("INPUT_DESCRIPTOR_INVALID");
          }
        }
        return Object.freeze(output);
      }

      // same-realm plain objects and null-prototype records only.
      if (snapshot.prototype !== Object.prototype && snapshot.prototype !== null) {
        return fail("INPUT_DESCRIPTOR_INVALID");
      }
      if (snapshot.keys.length > limits.maxObjectKeys) {
        return fail("INPUT_RESOURCE_LIMIT_EXCEEDED");
      }
      const output = Object.create(null) as Record<string, unknown>;
      for (const key of snapshot.keys) {
        if (typeof key === "symbol") return fail("INPUT_DESCRIPTOR_INVALID");
        const descriptor = snapshot.descriptors.get(key);
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        ) {
          return fail("INPUT_DESCRIPTOR_INVALID");
        }
        defineData(output, key, copy(descriptor.value, depth + 1));
      }
      return Object.freeze(output);
    } finally {
      active.delete(value);
    }
  };

  try {
    return { ok: true, value: copy(input, 0) };
  } catch (error) {
    if (error instanceof CopyFailure) {
      return { ok: false, reason: error.reason };
    }
    return { ok: false, reason: "INPUT_DESCRIPTOR_INVALID" };
  }
};

export const copyStage09pInput = (input: unknown): Stage09pInputResult => copyStage09pInputWithLimits(input, STAGE09P_INPUT_LIMITS);
export const copyStage09pReplayChunkInput = (input: unknown, domain: keyof typeof STAGE09P_REPLAY_CHUNK_LIMITS): Stage09pInputResult => copyStage09pInputWithLimits(input, STAGE09P_REPLAY_CHUNK_LIMITS[domain]);

type ReplayJsonRole = "root" | "events" | "event" | "other";

class ReplayJsonFailure extends Error {
  constructor(readonly reason: Stage09pReplayChunkInputReason) {
    super(reason);
  }
}

const replayJsonFail = (reason: Stage09pReplayChunkInputReason): never => {
  throw new ReplayJsonFailure(reason);
};

const hexDigitValue = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
};

const hasOnlyUnicodeScalars = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const measureUtf8Bytes = (value: string, maximum: number): Stage09pReplayChunkInputReason | number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return "INPUT_JSON_SYNTAX_INVALID";
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return "INPUT_JSON_SYNTAX_INVALID";
    } else bytes += 3;
    if (bytes > maximum) return "INPUT_WIRE_BYTE_CAPACITY_EXCEEDED";
  }
  return bytes;
};

type Stage09pReplayChunkOperationalLimits = Stage09pOperationalLimits & Readonly<{ maxRawUtf8Bytes: number; maxRawCodeUnits: number; maxEvents: number }>;

const parseBoundedReplayChunkJson = (
  input: string,
  limits: Stage09pReplayChunkOperationalLimits,
  canonicalNumberToken: "1" | "2",
): Stage09pReplayChunkInputResult => {
  let offset = 0;
  let nodes = 0;
  let descriptorKeys = 0;
  let totalStringScalars = 0;

  const syntax = (): never => replayJsonFail("INPUT_JSON_SYNTAX_INVALID");
  const resource = (): never => replayJsonFail("INPUT_DECODED_RESOURCE_LIMIT_EXCEEDED");
  const chargeNode = (depth: number): void => {
    if (depth > limits.maxDepth) resource();
    nodes += 1;
    if (nodes > limits.maxNodes) resource();
  };
  const chargeKey = (key: string): void => {
    descriptorKeys += 1;
    if (descriptorKeys > limits.maxDescriptorKeys) resource();
    const scalars = stringScalarLength(key, limits.maxStringScalars) ?? resource();
    totalStringScalars += scalars;
    if (totalStringScalars > limits.maxTotalStringScalars) resource();
  };
  const readHexCodeUnit = (): number => {
    if (offset + 4 > input.length) return syntax();
    let value = 0;
    for (let index = 0; index < 4; index += 1) {
      const digit = hexDigitValue(input.charCodeAt(offset + index));
      if (digit < 0) return syntax();
      value = value * 16 + digit;
    }
    offset += 4;
    return value;
  };
  const parseString = (): string => {
    const tokenStart = offset;
    if (input.charCodeAt(offset) !== 0x22) return syntax();
    offset += 1;
    let segmentStart = offset;
    const parts: string[] = [];
    let outputCodeUnits = 0;
    const appendDecoded = (value: string): void => {
      parts.push(value);
      outputCodeUnits += value.length;
      if (outputCodeUnits > limits.maxStringScalars * 2) resource();
    };
    const appendSegment = (end: number): void => {
      if (end > segmentStart) parts.push(input.slice(segmentStart, end));
    };
    while (offset < input.length) {
      const code = input.charCodeAt(offset);
      if (code === 0x22) {
        appendSegment(offset);
        offset += 1;
        const value = parts.join("");
        if (!hasOnlyUnicodeScalars(value)) return syntax();
        const scalars = stringScalarLength(value, limits.maxStringScalars) ?? resource();
        totalStringScalars += scalars;
        if (totalStringScalars > limits.maxTotalStringScalars) resource();
        if (JSON.stringify(value) !== input.slice(tokenStart, offset)) return syntax();
        return value;
      }
      if (code < 0x20) return syntax();
      if (code === 0x5c) {
        appendSegment(offset);
        offset += 1;
        if (offset >= input.length) return syntax();
        const escaped = input.charCodeAt(offset);
        offset += 1;
        if (escaped === 0x75) {
          const first = readHexCodeUnit();
          if (first >= 0xd800 && first <= 0xdbff && input.charCodeAt(offset) === 0x5c && input.charCodeAt(offset + 1) === 0x75) {
            const secondOffset = offset;
            offset += 2;
            const second = readHexCodeUnit();
            if (second >= 0xdc00 && second <= 0xdfff) { appendDecoded(String.fromCharCode(first, second)); segmentStart = offset; continue; }
            offset = secondOffset;
          }
          appendDecoded(String.fromCharCode(first));
          segmentStart = offset;
          continue;
        }
        const escapedValue = escaped === 0x22 ? "\"" : escaped === 0x5c ? "\\" : escaped === 0x2f ? "/" : escaped === 0x62 ? "\b" : escaped === 0x66 ? "\f" : escaped === 0x6e ? "\n" : escaped === 0x72 ? "\r" : escaped === 0x74 ? "\t" : null;
        appendDecoded(escapedValue ?? syntax());
        segmentStart = offset;
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const second = input.charCodeAt(offset + 1);
        if (second >= 0xdc00 && second <= 0xdfff) {
          outputCodeUnits += 2;
          if (outputCodeUnits > limits.maxStringScalars * 2) resource();
          offset += 2;
          continue;
        }
      }
      outputCodeUnits += 1;
      if (outputCodeUnits > limits.maxStringScalars * 2) resource();
      offset += 1;
    }
    return syntax();
  };
  const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
  const advanceDigits = (): number => {
    const start = offset;
    while (offset < input.length && isDigit(input.charCodeAt(offset))) offset += 1;
    return offset - start;
  };
  const scanNumber = (): string => {
    const start = offset;
    if (input.charCodeAt(offset) === 0x2d) offset += 1;
    if (input.charCodeAt(offset) === 0x30) { offset += 1; if (isDigit(input.charCodeAt(offset))) return syntax(); }
    else { const first = input.charCodeAt(offset); if (!(first >= 0x31 && first <= 0x39)) return syntax(); advanceDigits(); }
    if (input.charCodeAt(offset) === 0x2e) { offset += 1; if (advanceDigits() === 0) return syntax(); }
    const exponent = input.charCodeAt(offset);
    if (exponent === 0x65 || exponent === 0x45) { offset += 1; const sign = input.charCodeAt(offset); if (sign === 0x2b || sign === 0x2d) offset += 1; if (advanceDigits() === 0) return syntax(); }
    return input.slice(start, offset);
  };
  const parseNumber = (allowedSchemaVersion: boolean): number => {
    const token = scanNumber();
    if (!allowedSchemaVersion || token !== canonicalNumberToken) replayJsonFail("INPUT_CANONICAL_NUMBER_INVALID");
    return Number(token);
  };
  const skipStringSyntax = (): void => {
    if (input.charCodeAt(offset) !== 0x22) return syntax();
    offset += 1;
    while (offset < input.length) {
      const code = input.charCodeAt(offset);
      if (code === 0x22) { offset += 1; return; }
      if (code < 0x20) return syntax();
      if (code !== 0x5c) { offset += code >= 0xd800 && code <= 0xdbff && input.charCodeAt(offset + 1) >= 0xdc00 && input.charCodeAt(offset + 1) <= 0xdfff ? 2 : 1; continue; }
      offset += 1;
      const escaped = input.charCodeAt(offset);
      if (escaped === 0x75) { offset += 1; for (let index = 0; index < 4; index += 1) if (hexDigitValue(input.charCodeAt(offset + index)) < 0) return syntax(); offset += 4; continue; }
      if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escaped)) return syntax();
      offset += 1;
    }
    return syntax();
  };
  const skipValueSyntax = (depth: number): void => {
    if (depth > limits.maxDepth) return resource();
    const code = input.charCodeAt(offset);
    if (code === 0x22) return skipStringSyntax();
    if (code === 0x74 && input.startsWith("true", offset)) { offset += 4; return; }
    if (code === 0x66 && input.startsWith("false", offset)) { offset += 5; return; }
    if (code === 0x6e && input.startsWith("null", offset)) { offset += 4; return; }
    if (code === 0x2d || isDigit(code)) { scanNumber(); return; }
    if (code === 0x5b) {
      offset += 1;
      if (input.charCodeAt(offset) === 0x5d) { offset += 1; return; }
      while (true) { skipValueSyntax(depth + 1); const delimiter = input.charCodeAt(offset); if (delimiter === 0x5d) { offset += 1; return; } if (delimiter !== 0x2c) return syntax(); offset += 1; if (input.charCodeAt(offset) === 0x5d) return syntax(); }
    }
    if (code === 0x7b) {
      offset += 1;
      if (input.charCodeAt(offset) === 0x7d) { offset += 1; return; }
      while (true) { skipStringSyntax(); if (input.charCodeAt(offset) !== 0x3a) return syntax(); offset += 1; skipValueSyntax(depth + 1); const delimiter = input.charCodeAt(offset); if (delimiter === 0x7d) { offset += 1; return; } if (delimiter !== 0x2c) return syntax(); offset += 1; if (input.charCodeAt(offset) === 0x7d) return syntax(); }
    }
    return syntax();
  };
  const parseValue = (depth: number, role: ReplayJsonRole, allowedSchemaVersion = false): unknown => {
    chargeNode(depth);
    const code = input.charCodeAt(offset);
    if (code === 0x22) return parseString();
    if (code === 0x7b) return parseObject(depth, role);
    if (code === 0x5b) return parseArray(depth, role);
    if (code === 0x74 && input.startsWith("true", offset)) { offset += 4; return true; }
    if (code === 0x66 && input.startsWith("false", offset)) { offset += 5; return false; }
    if (code === 0x6e && input.startsWith("null", offset)) { offset += 4; return null; }
    if (code === 0x2d || isDigit(code)) return parseNumber(allowedSchemaVersion);
    return syntax();
  };
  const parseArray = (depth: number, role: ReplayJsonRole): readonly unknown[] => {
    offset += 1;
    chargeKey("length");
    const output: unknown[] = [];
    if (input.charCodeAt(offset) === 0x5d) { offset += 1; return Object.freeze(output); }
    while (true) {
      if (input.charCodeAt(offset) === 0x5d) return syntax();
      if (role === "events" && output.length >= limits.maxEvents) replayJsonFail("INPUT_CHUNK_EVENT_CAPACITY_EXCEEDED");
      if (output.length >= limits.maxArrayLength) return resource();
      chargeKey(String(output.length));
      output.push(parseValue(depth + 1, role === "events" ? "event" : "other"));
      const delimiter = input.charCodeAt(offset);
      if (delimiter === 0x5d) { offset += 1; return Object.freeze(output); }
      if (delimiter !== 0x2c) return syntax();
      offset += 1;
      if (role === "events" && output.length >= limits.maxEvents) replayJsonFail("INPUT_CHUNK_EVENT_CAPACITY_EXCEEDED");
    }
  };
  const parseObject = (depth: number, role: ReplayJsonRole): Readonly<Record<string, unknown>> => {
    offset += 1;
    const output = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    const entries: { key: string; start: number; end: number; nextRole: ReplayJsonRole; allowedSchemaVersion: boolean; parsed: boolean; value: unknown }[] = [];
    const priorityKey = role === "root" ? "events" : null;
    if (input.charCodeAt(offset) === 0x7d) { offset += 1; return Object.freeze(output); }
    while (true) {
      const key = parseString();
      if (keys.has(key)) return syntax();
      keys.add(key);
      if (keys.size > limits.maxObjectKeys) return resource();
      descriptorKeys += 1;
      if (descriptorKeys > limits.maxDescriptorKeys) return resource();
      if (input.charCodeAt(offset) !== 0x3a) return syntax();
      offset += 1;
      const nextRole: ReplayJsonRole = role === "root" && key === "events" ? "events" : "other";
      const allowedSchemaVersion = (role === "root" || role === "event") && key === "schemaVersion";
      const start = offset;
      const parsed = priorityKey === null || key === priorityKey;
      let value: unknown = undefined;
      if (parsed) value = parseValue(depth + 1, nextRole, allowedSchemaVersion); else skipValueSyntax(depth + 1);
      entries.push({ key, start, end: offset, nextRole, allowedSchemaVersion, parsed, value });
      const delimiter = input.charCodeAt(offset);
      if (delimiter === 0x7d) {
        offset += 1;
        const finalOffset = offset;
        for (const entry of entries) if (!entry.parsed) { offset = entry.start; entry.value = parseValue(depth + 1, entry.nextRole, entry.allowedSchemaVersion); if (offset !== entry.end) return syntax(); entry.parsed = true; }
        offset = finalOffset;
        for (const entry of entries) defineData(output, entry.key, entry.value);
        return Object.freeze(output);
      }
      if (delimiter !== 0x2c) return syntax();
      offset += 1;
    }
  };
  try {
    const value = parseValue(0, "root");
    if (offset !== input.length) return { ok: false, reason: "INPUT_JSON_SYNTAX_INVALID" };
    return { ok: true, value };
  } catch (error) {
    return error instanceof ReplayJsonFailure ? { ok: false, reason: error.reason } : { ok: false, reason: "INPUT_JSON_SYNTAX_INVALID" };
  }
};

export const parseStage09pReplayChunkJsonText = (
  input: unknown,
  domain: keyof typeof STAGE09P_REPLAY_CHUNK_LIMITS,
): Stage09pReplayChunkInputResult => {
  if (typeof input !== "string") return { ok: false, reason: "INPUT_DESCRIPTOR_INVALID" };
  const limits = STAGE09P_REPLAY_CHUNK_LIMITS[domain];
  if (input.length > limits.maxRawCodeUnits) return { ok: false, reason: "INPUT_WIRE_BYTE_CAPACITY_EXCEEDED" };
  const bytes = measureUtf8Bytes(input, limits.maxRawUtf8Bytes);
  if (typeof bytes === "string") return { ok: false, reason: bytes };
  return parseBoundedReplayChunkJson(input, limits, domain === "inventory" ? "2" : "1");
};

export const isSafeRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const readSafeOwn = (value: unknown, key: string): unknown => {
  if (!isSafeRecord(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};
