import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  canonicalJson,
  canonicalReleaseDigest,
  canonicalReleaseText,
  compareUtf8,
  verifyGovernanceReleaseDigest,
} from "../src/index.js";

const validRelease = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../data/samples/stage09p-m0/valid/food-concept.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

test("canonical JSON uses UTF-8 byte ordering independent of insertion order", () => {
  const first = { z: 1, "𐀀": 2, "": 3, a: { second: true, first: false } };
  const second = { a: { first: false, second: true }, "": 3, "𐀀": 2, z: 1 };
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(canonicalJson(first), '{"a":{"first":false,"second":true},"z":1,"":3,"𐀀":2}');
  assert.equal(compareUtf8("", "𐀀") < 0, true);
  assert.throws(() => compareUtf8("\ud800", "x"), {
    name: "TypeError",
    message: "INVALID_CANONICAL_INPUT",
  });
});

test("canonical release digest is deterministic and excludes only its own digest", () => {
  const release = validRelease();
  const first = canonicalReleaseDigest(release);
  const second = canonicalReleaseDigest(release);
  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);

  const changedDigestOnly = structuredClone(release);
  changedDigestOnly["contentDigest"] = `sha256:${"f".repeat(64)}`;
  assert.equal(canonicalReleaseDigest(changedDigestOnly), first);
  assert.equal(canonicalReleaseText(changedDigestOnly), canonicalReleaseText(release));

  const changedReleaseRevision = structuredClone(release);
  changedReleaseRevision["releaseRevision"] = 2;
  assert.notEqual(canonicalReleaseDigest(changedReleaseRevision), first);

  const changedContent = structuredClone(release);
  const envelope = (changedContent["envelopes"] as Array<Record<string, unknown>>)[0] as Record<
    string,
    unknown
  >;
  envelope["content"] = { syntheticToken: "SYNTHETIC_FOOD_CONCEPT_BETA" };
  assert.notEqual(canonicalReleaseDigest(changedContent), first);
});

test("digest verification returns a frozen stable relation without raw input", () => {
  const release = validRelease();
  release["contentDigest"] = `sha256:${"0".repeat(64)}`;
  const mismatch = verifyGovernanceReleaseDigest(release);
  assert.deepEqual(mismatch, { ok: false, code: "RELEASE_DIGEST_MISMATCH" });
  assert.equal(Object.isFrozen(mismatch), true);

  release["contentDigest"] = canonicalReleaseDigest(release);
  const verified = verifyGovernanceReleaseDigest(release);
  assert.deepEqual(verified, { ok: true, digest: release["contentDigest"] });
  assert.equal(Object.isFrozen(verified), true);
});

test("canonical entry point delegates scalar rejection to decode.ts", () => {
  assert.throws(() => canonicalJson({ syntheticNumber: -0 }), {
    name: "TypeError",
    message: "INVALID_CANONICAL_INPUT",
  });

  let getterCalls = 0;
  const input = {};
  Object.defineProperty(input, "syntheticToken", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "SYNTHETIC_SECRET";
    },
  });
  assert.throws(() => canonicalJson(input), {
    name: "TypeError",
    message: "INVALID_CANONICAL_INPUT",
  });
  assert.equal(getterCalls, 0);
});
