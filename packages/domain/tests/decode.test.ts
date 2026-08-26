import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  DECODE_LIMITS,
  decodeGovernanceCatalog,
  decodeGovernanceCatalogJson,
  decodeGovernanceRelease,
  decodeGovernanceReleaseJson,
  type DecodeIssueCode,
} from "../src/index.js";

const fixturePath = (section: "valid" | "invalid", name: string): string =>
  resolve(import.meta.dirname, `../../../data/samples/stage09p-m0/${section}/${name}.json`);

const fixtureText = (section: "valid" | "invalid", name: string): string =>
  readFileSync(fixturePath(section, name), "utf8");

const validRelease = (): Record<string, unknown> =>
  JSON.parse(fixtureText("valid", "food-concept")) as Record<string, unknown>;

const expectFailure = (
  result: ReturnType<typeof decodeGovernanceRelease>,
  code: DecodeIssueCode,
  path?: string,
): void => {
  assert.deepEqual(Object.keys(result).sort(), ["issue", "ok", "reason"]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "decode_failed");
  assert.equal(result.issue.code, code);
  if (path !== undefined) assert.equal(result.issue.path, path);
  assert.deepEqual(Object.keys(result.issue).sort(), ["code", "path"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.issue), true);
};

const assertDeepFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) assertDeepFrozen(descriptor.value, seen);
  }
};

test("object and raw release entry points return the same deep-frozen value", () => {
  const objectResult = decodeGovernanceRelease(validRelease());
  const rawResult = decodeGovernanceReleaseJson(fixtureText("valid", "food-concept"));
  assert.equal(objectResult.ok, true);
  assert.equal(rawResult.ok, true);
  if (!objectResult.ok || !rawResult.ok) return;
  assert.deepEqual(objectResult.value, rawResult.value);
  assertDeepFrozen(objectResult.value);
  assertDeepFrozen(rawResult.value);
});

test("raw parser rejects duplicate decoded keys and trailing input deterministically", () => {
  expectFailure(
    decodeGovernanceReleaseJson('{"releaseId":"one","\\u0072eleaseId":"two"}'),
    "DUPLICATE_KEY",
    "/releaseId",
  );
  expectFailure(
    decodeGovernanceReleaseJson(`${fixtureText("valid", "food-concept")} SYNTHETIC_TRAILING`),
    "TRAILING_INPUT",
    "",
  );
  expectFailure(decodeGovernanceReleaseJson('{"schemaVersion":1,,}'), "INVALID_JSON");
});

test("raw and object negative zero share decode.ts scalar-closure ownership", () => {
  expectFailure(
    decodeGovernanceReleaseJson(fixtureText("invalid", "negative-zero")),
    "INVALID_SCALAR",
    "/envelopes/0/content/syntheticNumber",
  );

  const release = validRelease();
  const envelope = (release["envelopes"] as Array<Record<string, unknown>>)[0] as Record<
    string,
    unknown
  >;
  envelope["content"] = { syntheticNumber: -0 };
  expectFailure(
    decodeGovernanceRelease(release),
    "INVALID_SCALAR",
    "/envelopes/0/content/syntheticNumber",
  );
});

test("unsafe numbers and invalid Unicode scalars fail with safe fixed output", () => {
  expectFailure(
    decodeGovernanceReleaseJson(fixtureText("invalid", "unsafe-integer")),
    "INVALID_SCALAR",
    "/releaseRevision",
  );
  expectFailure(
    decodeGovernanceReleaseJson(fixtureText("invalid", "lone-surrogate")),
    "INVALID_SCALAR",
    "/envelopes/0/content/syntheticToken",
  );

  for (const unsafe of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const release = validRelease();
    const envelope = (release["envelopes"] as Array<Record<string, unknown>>)[0] as Record<
      string,
      unknown
    >;
    envelope["content"] = { syntheticNumber: unsafe };
    const result = decodeGovernanceRelease(release);
    expectFailure(result, "INVALID_SCALAR", "/envelopes/0/content/syntheticNumber");
    assert.doesNotMatch(JSON.stringify(result), /NaN|Infinity|SYNTHETIC_FOOD_CONCEPT_ALPHA/);
  }
});

test("intentional object input never invokes getters and rejects hostile shapes", () => {
  let getterCalls = 0;
  const accessorContent = {};
  Object.defineProperty(accessorContent, "syntheticToken", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "SYNTHETIC_ACCESSOR";
    },
  });
  const accessorRelease = validRelease();
  ((accessorRelease["envelopes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
    "content"
  ] = accessorContent;
  expectFailure(
    decodeGovernanceRelease(accessorRelease),
    "INVALID_SHAPE",
    "/envelopes/0/content/syntheticToken",
  );
  assert.equal(getterCalls, 0);

  const sparseRelease = validRelease();
  const sparse = new Array(2);
  sparse[0] = "SYNTHETIC_PRESENT";
  ((sparseRelease["envelopes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
    "content"
  ] = sparse;
  expectFailure(decodeGovernanceRelease(sparseRelease), "INVALID_SHAPE", "/envelopes/0/content");

  const cyclicRelease = validRelease();
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  ((cyclicRelease["envelopes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
    "content"
  ] = cyclic;
  expectFailure(
    decodeGovernanceRelease(cyclicRelease),
    "INVALID_SHAPE",
    "/envelopes/0/content/self",
  );

  const prototypeRelease = validRelease();
  ((prototypeRelease["envelopes"] as Array<Record<string, unknown>>)[0] as Record<
    string,
    unknown
  >)["content"] = Object.create(null) as object;
  expectFailure(
    decodeGovernanceRelease(prototypeRelease),
    "INVALID_SHAPE",
    "/envelopes/0/content",
  );
});

test("unknown own keys and resource boundaries fail closed", () => {
  const extra = validRelease();
  extra["unexpected"] = "SYNTHETIC_EXTRA";
  expectFailure(decodeGovernanceRelease(extra), "INVALID_SHAPE", "/unexpected");

  const atLimit = validRelease();
  ((atLimit["envelopes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
    "content"
  ] = Array.from({ length: DECODE_LIMITS.maxArrayLength }, () => null);
  assert.equal(decodeGovernanceRelease(atLimit).ok, true);

  const beyondLimit = validRelease();
  ((beyondLimit["envelopes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
    "content"
  ] = Array.from({ length: DECODE_LIMITS.maxArrayLength + 1 }, () => null);
  expectFailure(
    decodeGovernanceRelease(beyondLimit),
    "RESOURCE_LIMIT_EXCEEDED",
    "/envelopes/0/content",
  );

  expectFailure(
    decodeGovernanceReleaseJson(" ".repeat(DECODE_LIMITS.maxTextLength + 1)),
    "RESOURCE_LIMIT_EXCEEDED",
    "",
  );

  const nestedContent = (levels: number): unknown => {
    let value: unknown = null;
    for (let index = 0; index < levels; index += 1) value = { nested: value };
    return value;
  };
  const atDepth = validRelease();
  ((atDepth["envelopes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
    "content"
  ] = nestedContent(DECODE_LIMITS.maxDepth - 3);
  assert.equal(decodeGovernanceRelease(atDepth).ok, true);

  const beyondDepth = validRelease();
  ((beyondDepth["envelopes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
    "content"
  ] = nestedContent(DECODE_LIMITS.maxDepth - 2);
  expectFailure(decodeGovernanceRelease(beyondDepth), "RESOURCE_LIMIT_EXCEEDED");
});

test("catalog object and raw entry points decode only structural R1 data", () => {
  const catalog = { schemaVersion: 1, releases: [validRelease()], hardMappings: [] };
  const objectResult = decodeGovernanceCatalog(catalog);
  const rawResult = decodeGovernanceCatalogJson(JSON.stringify(catalog));
  assert.equal(objectResult.ok, true);
  assert.equal(rawResult.ok, true);
  if (!objectResult.ok || !rawResult.ok) return;
  assert.deepEqual(objectResult.value, rawResult.value);
  assertDeepFrozen(objectResult.value);
});
