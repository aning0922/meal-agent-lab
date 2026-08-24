import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  canonicalReleaseText,
  canonicalReleaseDigest,
  decodeGovernanceCatalogJson,
  decodeGovernanceRelease,
  decodeGovernanceReleaseJson,
  resolveGovernedReference,
  validateGovernanceCatalog,
  validateGovernanceRelease,
  type GovernanceCatalog,
  type GovernanceRelease,
  type GovernedReference,
} from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const validPath = resolve(
  repositoryRoot,
  "data/samples/stage09p-m0/valid/food-concept.json",
);

const validRelease = (): GovernanceRelease =>
  JSON.parse(readFileSync(validPath, "utf8")) as GovernanceRelease;

const setDigest = (release: GovernanceRelease): void => {
  const digest = canonicalReleaseDigest(release);
  for (const envelope of release.envelopes) {
    (envelope as unknown as Record<string, unknown>)["contentDigest"] = digest;
  }
};

const referenceOf = (release: GovernanceRelease): GovernedReference => {
  const envelope = release.envelopes[0];
  assert.ok(envelope !== undefined);
  return {
    datasetId: envelope.datasetId,
    entityId: envelope.entityId,
    entityRevision: envelope.entityRevision,
  };
};

test("F1 raw objects fail closed without executing accessors or accepting hidden shape", () => {
  const getterRelease = structuredClone(validRelease()) as unknown as Record<string, unknown>;
  const envelopes = getterRelease["envelopes"] as Record<string, unknown>[];
  const envelope = envelopes[0];
  assert.ok(envelope !== undefined);
  let getterCalls = 0;
  Object.defineProperty(envelope, "sourceTier", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return "L3";
    },
  });
  const accessorResult = validateGovernanceRelease(getterRelease);
  assert.equal(getterCalls, 0);
  assert.deepEqual(accessorResult, {
    ok: false,
    issues: [{ code: "INVALID_SHAPE", path: "envelopes/0/sourceTier" }],
  });

  const unknownField = structuredClone(validRelease()) as unknown as Record<string, unknown>;
  const unknownEnvelope = (unknownField["envelopes"] as Record<string, unknown>[])[0];
  assert.ok(unknownEnvelope !== undefined);
  unknownEnvelope["uncheckedExternalFact"] = "SYNTHETIC_UNCHECKED";
  assert.equal(validateGovernanceRelease(unknownField).ok, false);

  const arrayExtra = structuredClone(validRelease());
  (arrayExtra.envelopes as unknown as Record<string, unknown>)["unchecked"] = true;
  assert.equal(validateGovernanceRelease(arrayExtra).ok, false);

  const customPrototype = structuredClone(validRelease()) as unknown as Record<string, unknown>;
  Object.setPrototypeOf(customPrototype, { unchecked: true });
  assert.equal(validateGovernanceRelease(customPrototype).ok, false);
});

test("F2 canonical collection ordering is structural and never invokes caller iteration", () => {
  const collision = structuredClone(validRelease());
  const envelope = collision.envelopes[0];
  assert.ok(envelope !== undefined);
  (envelope as unknown as Record<string, unknown>)["approvers"] = [
    { actorId: "syn:a", role: "syn:b\u0000syn:c" },
    { actorId: "syn:a\u0000syn:b", role: "syn:c" },
  ];
  const reversed = structuredClone(collision);
  (reversed.envelopes[0]?.approvers as unknown as unknown[]).reverse();
  assert.equal(canonicalReleaseDigest(collision), canonicalReleaseDigest(reversed));

  const hostile = structuredClone(validRelease());
  const approvers = hostile.envelopes[0]?.approvers;
  assert.ok(approvers !== undefined);
  let iteratorCalls = 0;
  Object.defineProperty(approvers, Symbol.iterator, {
    configurable: true,
    value() {
      iteratorCalls += 1;
      return [][Symbol.iterator]();
    },
  });
  assert.throws(() => canonicalReleaseDigest(hostile), /INVALID_SHAPE/);
  assert.equal(iteratorCalls, 0);
});

test("F3 duplicate revisions and invalid releases can never resolve mapped", () => {
  const original = validRelease();
  const duplicateCatalog: GovernanceCatalog = {
    releases: [original, structuredClone(original)],
    hardMappings: [],
  };
  assert.equal(validateGovernanceCatalog(duplicateCatalog).ok, false);

  const invalidDigest = structuredClone(original);
  const invalidEnvelope = invalidDigest.envelopes[0];
  assert.ok(invalidEnvelope !== undefined);
  (invalidEnvelope.content as Record<string, unknown>)["syntheticToken"] =
    "SYNTHETIC_FOOD_CONCEPT_CHANGED";
  const invalidCatalog: GovernanceCatalog = { releases: [invalidDigest], hardMappings: [] };
  assert.notEqual(resolveGovernedReference(invalidCatalog, referenceOf(original)).status, "mapped");

  const withdrawn = structuredClone(original);
  const withdrawnEnvelope = withdrawn.envelopes[0];
  assert.ok(withdrawnEnvelope !== undefined);
  Object.assign(withdrawnEnvelope, {
    releaseId: "syn:release:food-concept:2",
    releaseRevision: 2,
    lifecycleStatus: "withdrawn",
    withdrawalState: "withdrawn",
    withdrawalReason: "SYNTHETIC_WITHDRAWAL_REASON",
    withdrawnAt: "2000-01-03T00:00:00.000Z",
  });
  setDigest(withdrawn);
  const forward: GovernanceCatalog = { releases: [original, withdrawn], hardMappings: [] };
  const reverse: GovernanceCatalog = { releases: [withdrawn, original], hardMappings: [] };
  const reference = referenceOf(original);
  assert.deepEqual(
    resolveGovernedReference(forward, reference),
    resolveGovernedReference(reverse, reference),
  );
});

test("F4 lifecycle targets, canonical aliases, source revisions, and instants are closed", () => {
  const withdrawnWithTarget = structuredClone(validRelease());
  const withdrawnEnvelope = withdrawnWithTarget.envelopes[0];
  assert.ok(withdrawnEnvelope !== undefined);
  Object.assign(withdrawnEnvelope, {
    lifecycleStatus: "withdrawn",
    withdrawalState: "withdrawn",
    withdrawalReason: "SYNTHETIC_WITHDRAWAL_REASON",
    withdrawnAt: "2000-01-03T00:00:00.000Z",
    supersededBy: {
      datasetId: withdrawnEnvelope.datasetId,
      entityId: "01900000-7000-7000-8000-000000000011",
      entityRevision: 1,
    },
  });
  setDigest(withdrawnWithTarget);
  assert.equal(validateGovernanceRelease(withdrawnWithTarget).ok, false);

  const invalidTimestamp = structuredClone(validRelease());
  const timestampEnvelope = invalidTimestamp.envelopes[0];
  assert.ok(timestampEnvelope !== undefined);
  (timestampEnvelope as unknown as Record<string, unknown>)["reviewedAt"] =
    "2000-97-01T00:00:00.000Z";
  setDigest(invalidTimestamp);
  assert.equal(validateGovernanceRelease(invalidTimestamp).ok, false);

  const unicodeAliases = structuredClone(validRelease());
  const first = unicodeAliases.envelopes[0];
  assert.ok(first !== undefined);
  (first.aliases[0] as unknown as Record<string, unknown>)["value"] = "SYNTHETIC_É";
  const second = structuredClone(first);
  Object.assign(second, {
    entityId: "01900000-7000-7000-8000-000000000011",
    content: { syntheticToken: "SYNTHETIC_ALIAS_BETA" },
  });
  (second.aliases[0] as unknown as Record<string, unknown>)["value"] = "SYNTHETIC_E\u0301";
  (unicodeAliases.envelopes as unknown as typeof second[]).push(second);
  setDigest(unicodeAliases);
  assert.equal(validateGovernanceRelease(unicodeAliases).ok, false);
});

test("reflection failures collapse to a fixed safe issue without leaking caller errors", () => {
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("SECRET_CALLER_MESSAGE");
      },
    },
  );
  assert.doesNotThrow(() => validateGovernanceRelease(hostile));
  assert.deepEqual(validateGovernanceRelease(hostile), {
    ok: false,
    issues: [{ code: "INVALID_SHAPE", path: "release" }],
  });
  assert.doesNotMatch(JSON.stringify(validateGovernanceRelease(hostile)), /SECRET_CALLER_MESSAGE/);
});

test("JSON text entrypoints are total and never coerce hostile non-strings", () => {
  const releaseText = readFileSync(validPath, "utf8");
  const catalogText = JSON.stringify({ releases: [JSON.parse(releaseText)], hardMappings: [] });
  const methods = {
    calls: 0,
    toString() {
      this.calls += 1;
      return releaseText;
    },
    valueOf() {
      this.calls += 1;
      return releaseText;
    },
    [Symbol.toPrimitive]() {
      this.calls += 1;
      return releaseText;
    },
  };
  const boxed = new String(releaseText) as String & { calls: number };
  boxed.calls = 0;
  Object.defineProperties(boxed, {
    toString: { value: () => { boxed.calls += 1; return releaseText; } },
    valueOf: { value: () => { boxed.calls += 1; return releaseText; } },
    [Symbol.toPrimitive]: { value: () => { boxed.calls += 1; return releaseText; } },
  });
  let proxyTraps = 0;
  const hostileProxy = new Proxy({}, {
    getPrototypeOf() {
      proxyTraps += 1;
      throw new Error("SECRET_CALLER_MESSAGE");
    },
    get() {
      proxyTraps += 1;
      throw new Error("SECRET_CALLER_MESSAGE");
    },
  });

  for (const candidate of [methods, boxed, hostileProxy, null, true, 1, Symbol("hostile")]) {
    assert.deepEqual(decodeGovernanceReleaseJson(candidate as unknown as string), {
      ok: false,
      issue: { code: "INVALID_SHAPE", path: "release" },
    });
    assert.deepEqual(decodeGovernanceCatalogJson(candidate as unknown as string), {
      ok: false,
      issue: { code: "INVALID_SHAPE", path: "catalog" },
    });
  }
  assert.equal(methods.calls, 0);
  assert.equal(boxed.calls, 0);
  assert.equal(proxyTraps, 0);
  assert.equal(decodeGovernanceReleaseJson(releaseText).ok, true);
  assert.equal(decodeGovernanceCatalogJson(catalogText).ok, true);
});

test("hostile thrown values cannot forge or escape the private decode failure identity", () => {
  const callerException = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("SECRET_CALLER_MESSAGE");
    },
    get() {
      throw new Error("SECRET_CALLER_MESSAGE");
    },
  });
  const hostileInput = new Proxy({}, {
    getPrototypeOf() {
      throw callerException;
    },
  });
  let result: ReturnType<typeof decodeGovernanceRelease> | undefined;
  assert.doesNotThrow(() => {
    result = decodeGovernanceRelease(hostileInput);
  });
  assert.deepEqual(result, {
    ok: false,
    issue: { code: "INVALID_SHAPE", path: "release" },
  });
  assert.doesNotMatch(JSON.stringify(result), /SECRET_CALLER_MESSAGE/);
});

test("strict decoding rejects every non-JSON or non-exact shape and deep-freezes snapshots", () => {
  let toJsonCalls = 0;
  const cases: unknown[] = [];
  const symbolKey = structuredClone(validRelease());
  Object.defineProperty(symbolKey, Symbol("hidden"), { value: true });
  cases.push(symbolKey);

  const nullPrototype = structuredClone(validRelease()) as unknown as object;
  Object.setPrototypeOf(nullPrototype, null);
  cases.push(nullPrototype);

  const sparse = structuredClone(validRelease());
  delete (sparse.envelopes as unknown as Record<number, unknown>)[0];
  cases.push(sparse);

  for (const badValue of [undefined, new Date(0), Number.NaN, Number.POSITIVE_INFINITY, -0]) {
    const release = structuredClone(validRelease());
    (release.envelopes[0]?.content as Record<string, unknown>)["bad"] = badValue;
    cases.push(release);
  }

  const invalidScalar = structuredClone(validRelease());
  (invalidScalar.envelopes[0]?.content as Record<string, unknown>)["bad"] = "\uD800";
  cases.push(invalidScalar);

  const cyclic = structuredClone(validRelease());
  const cyclicContent = cyclic.envelopes[0]?.content as Record<string, unknown>;
  cyclicContent["cycle"] = cyclicContent;
  cases.push(cyclic);

  const toJson = structuredClone(validRelease());
  (toJson.envelopes[0]?.content as Record<string, unknown>)["toJSON"] = () => {
    toJsonCalls += 1;
    return {};
  };
  cases.push(toJson);

  for (const candidate of cases) {
    const decoded = decodeGovernanceRelease(candidate);
    assert.equal(decoded.ok, false);
    if (!decoded.ok) assert.equal(decoded.issue.code, "INVALID_SHAPE");
  }
  assert.equal(toJsonCalls, 0);

  const decoded = decodeGovernanceReleaseJson(readFileSync(validPath, "utf8"));
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(Object.isFrozen(decoded.value), true);
    assert.equal(Object.isFrozen(decoded.value.envelopes), true);
    assert.equal(Object.isFrozen(decoded.value.envelopes[0]?.owner), true);
    assert.equal(Object.isFrozen(decoded.value.envelopes[0]?.content), true);
  }
  assert.deepEqual(decodeGovernanceReleaseJson("{"), {
    ok: false,
    issue: { code: "INVALID_SHAPE", path: "release" },
  });
});

test("canonical digest covers declared fields, preserves content order, and permits shared JSON values", () => {
  const base = validRelease();
  const changedSchema = structuredClone(base) as GovernanceRelease & { $schema: string };
  changedSchema.$schema = "synthetic://different-schema";
  assert.notEqual(canonicalReleaseDigest(base), canonicalReleaseDigest(changedSchema));

  const withOrderedContent = structuredClone(base);
  (withOrderedContent.envelopes[0]?.content as Record<string, unknown>)["sequence"] = ["A", "B"];
  const reversedContent = structuredClone(withOrderedContent);
  ((reversedContent.envelopes[0]?.content as Record<string, unknown>)["sequence"] as string[]).reverse();
  assert.notEqual(canonicalReleaseDigest(withOrderedContent), canonicalReleaseDigest(reversedContent));

  const shared = structuredClone(base);
  const sharedValue = { alpha: "SYNTHETIC_SHARED" };
  Object.assign(shared.envelopes[0]?.content as Record<string, unknown>, {
    first: sharedValue,
    second: sharedValue,
  });
  const separated = structuredClone(shared);
  assert.equal(canonicalReleaseText(shared), canonicalReleaseText(separated));
  assert.throws(() => canonicalReleaseText({ ...base, unknown: true }), /INVALID_SHAPE/);
});

test("lossless snapshots preserve every legal JSON key across object and text entrypoints", () => {
  const withSpecialKeys = structuredClone(validRelease());
  const content = JSON.parse(
    '{"__proto__":"SYNTHETIC_PROTO","constructor":"SYNTHETIC_CONSTRUCTOR",' +
      '"prototype":"SYNTHETIC_PROTOTYPE","":"SYNTHETIC_EMPTY",' +
      '"\\u0000":"SYNTHETIC_NUL","😀":"SYNTHETIC_ASTRAL"}',
  ) as Record<string, unknown>;
  (withSpecialKeys.envelopes[0] as unknown as Record<string, unknown>)["content"] = content;
  setDigest(withSpecialKeys);

  const objectDecoded = decodeGovernanceRelease(withSpecialKeys);
  const textDecoded = decodeGovernanceReleaseJson(JSON.stringify(withSpecialKeys));
  assert.equal(objectDecoded.ok, true);
  assert.equal(textDecoded.ok, true);
  if (!objectDecoded.ok || !textDecoded.ok) return;
  const expectedKeys = ["", "\u0000", "__proto__", "constructor", "prototype", "😀"].sort();
  assert.deepEqual(Object.keys(objectDecoded.value.envelopes[0]?.content ?? {}).sort(), expectedKeys);
  assert.deepEqual(Object.keys(textDecoded.value.envelopes[0]?.content ?? {}).sort(), expectedKeys);
  assert.equal(Object.isFrozen(objectDecoded.value.envelopes[0]?.content), true);
  assert.equal(Object.isFrozen(textDecoded.value.envelopes[0]?.content), true);
  assert.equal(canonicalReleaseText(objectDecoded.value), canonicalReleaseText(textDecoded.value));
  assert.equal(canonicalReleaseDigest(objectDecoded.value), canonicalReleaseDigest(textDecoded.value));
  assert.equal(validateGovernanceRelease(withSpecialKeys).ok, true);

  const empty = structuredClone(withSpecialKeys);
  (empty.envelopes[0] as unknown as Record<string, unknown>)["content"] = {};
  assert.notEqual(canonicalReleaseDigest(withSpecialKeys), canonicalReleaseDigest(empty));
});

test("full canonical material is the deterministic tie-break for equal envelope identities", () => {
  const release = structuredClone(validRelease());
  const first = release.envelopes[0];
  assert.ok(first !== undefined);
  const second = structuredClone(first);
  (second as unknown as Record<string, unknown>)["content"] = {
    syntheticToken: "SYNTHETIC_TIE_BREAK_SECOND",
  };
  (release.envelopes as unknown as typeof second[]).push(second);
  const reversed = structuredClone(release);
  (reversed.envelopes as unknown as typeof second[]).reverse();
  assert.equal(canonicalReleaseText(release), canonicalReleaseText(reversed));
  assert.equal(canonicalReleaseDigest(release), canonicalReleaseDigest(reversed));
});

test("collection identities, source revisions, and actor ownership are mechanically unique", () => {
  const duplicateApprover = structuredClone(validRelease());
  const approverEnvelope = duplicateApprover.envelopes[0];
  assert.ok(approverEnvelope !== undefined);
  (approverEnvelope as unknown as Record<string, unknown>)["approvers"] = [
    approverEnvelope.owner,
  ];
  setDigest(duplicateApprover);
  assert.equal(validateGovernanceRelease(duplicateApprover).ok, false);

  for (const field of ["applicableRegions", "languages"] as const) {
    const duplicate = structuredClone(validRelease());
    const envelope = duplicate.envelopes[0];
    assert.ok(envelope !== undefined);
    (envelope as unknown as Record<string, unknown>)[field] = [envelope[field][0], envelope[field][0]];
    setDigest(duplicate);
    assert.equal(validateGovernanceRelease(duplicate).ok, false);
  }

  const preciseSource = structuredClone(validRelease());
  const sourceEnvelope = preciseSource.envelopes[0];
  assert.ok(sourceEnvelope !== undefined);
  (sourceEnvelope as unknown as Record<string, unknown>)["sourceReferences"] = [
    sourceEnvelope.sourceReferences[0],
    {
      referenceId: sourceEnvelope.sourceReferences[0]?.referenceId,
      referenceRevision: "syn-revision-2",
      locator: "synthetic://stage09p-m0/food-concept/revision-2",
    },
  ];
  (sourceEnvelope as unknown as Record<string, unknown>)["sourceSnapshots"] = [
    sourceEnvelope.sourceSnapshots[0],
    {
      snapshotId: "syn:snapshot:food-concept:2",
      referenceId: sourceEnvelope.sourceReferences[0]?.referenceId,
      referenceRevision: "syn-revision-2",
      contentDigest: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      retrievedAt: "2000-01-01T00:00:00.000Z",
    },
  ];
  setDigest(preciseSource);
  assert.equal(validateGovernanceRelease(preciseSource).ok, true);

  const ambiguousAlias = structuredClone(preciseSource);
  delete (ambiguousAlias.envelopes[0]?.aliases[0] as unknown as Record<string, unknown>)[
    "sourceReferenceRevision"
  ];
  assert.equal(validateGovernanceRelease(ambiguousAlias).ok, false);
});

test("lifecycle supersession is exact, known, non-self, and points to a usable revision", () => {
  const oldRelease = structuredClone(validRelease());
  const oldEnvelope = oldRelease.envelopes[0];
  assert.ok(oldEnvelope !== undefined);
  const newRelease = structuredClone(validRelease());
  const newEnvelope = newRelease.envelopes[0];
  assert.ok(newEnvelope !== undefined);
  Object.assign(newEnvelope, {
    releaseId: "syn:release:food-concept:2",
    releaseRevision: 2,
    entityRevision: 2,
    content: { syntheticToken: "SYNTHETIC_FOOD_CONCEPT_REVISION_2" },
  });
  Object.assign(oldEnvelope, {
    lifecycleStatus: "superseded",
    supersededBy: {
      datasetId: oldEnvelope.datasetId,
      entityId: oldEnvelope.entityId,
      entityRevision: 2,
    },
  });
  setDigest(oldRelease);
  setDigest(newRelease);
  const validCatalog = validateGovernanceCatalog({
    releases: [oldRelease, newRelease],
    hardMappings: [],
  });
  assert.equal(validCatalog.ok, true);

  const unknownTarget = structuredClone(oldRelease);
  (unknownTarget.envelopes[0]?.supersededBy as unknown as Record<string, unknown>)[
    "entityRevision"
  ] = 3;
  setDigest(unknownTarget);
  const invalid = validateGovernanceCatalog({ releases: [unknownTarget, newRelease], hardMappings: [] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues.some(({ code }) => code === "INVALID_LIFECYCLE"), true);

  const selfTarget = structuredClone(oldRelease);
  (selfTarget.envelopes[0]?.supersededBy as unknown as Record<string, unknown>)[
    "entityRevision"
  ] = 1;
  setDigest(selfTarget);
  assert.equal(validateGovernanceRelease(selfTarget).ok, false);
});

test("optional hard mappings are descriptive while required mappings fail closed", () => {
  const release = validRelease();
  const source = referenceOf(release);
  const target = {
    datasetId: "syn:dataset:missing",
    entityId: "01900000-7000-7000-8000-000000000099",
    entityRevision: 1,
  };
  const optional = validateGovernanceCatalog({
    releases: [release],
    hardMappings: [{ mappingId: "syn:mapping:optional", source, target, required: false }],
  });
  assert.equal(optional.ok, true);
  if (optional.ok) {
    assert.equal(resolveGovernedReference(optional.catalog, source).status, "mapped");
    assert.equal(resolveGovernedReference(optional.catalog, target).status, "unmapped");
  }
  const required = validateGovernanceCatalog({
    releases: [release],
    hardMappings: [{ mappingId: "syn:mapping:required", source, target, required: true }],
  });
  assert.equal(required.ok, false);
  assert.equal(required.issues.some(({ code }) => code === "HARD_MAPPING_UNRESOLVED"), true);
});

test("hard mapping identifiers satisfy the governed synthetic namespace at final validation", () => {
  const release = validRelease();
  const envelope = release.envelopes[0]!;
  const reference = {
    datasetId: envelope.datasetId,
    entityId: envelope.entityId,
    entityRevision: envelope.entityRevision,
  };
  const result = validateGovernanceCatalog({
    releases: [release],
    hardMappings: [{
      mappingId: "not-a-mapping-id",
      source: reference,
      target: reference,
      required: true,
    }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, [{
    code: "INVALID_SHAPE",
    path: "hardMappings/0/mappingId",
  }]);
});

test("independent governance negatives retain safe stable codes and paths", () => {
  const assertOnlyIssue = (
    release: GovernanceRelease,
    code: string,
    path: string,
  ): void => {
    setDigest(release);
    const result = validateGovernanceRelease(release);
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues, [{ code, path }]);
  };

  const unapprovedSource = structuredClone(validRelease());
  (unapprovedSource.envelopes[0] as unknown as Record<string, unknown>)["sourceTier"] = "L4";
  assertOnlyIssue(unapprovedSource, "UNAPPROVED_SOURCE", "envelopes/0/sourceTier");

  const ownerApproverCollision = structuredClone(validRelease());
  const collisionEnvelope = ownerApproverCollision.envelopes[0];
  assert.ok(collisionEnvelope !== undefined);
  (collisionEnvelope.approvers[0] as unknown as Record<string, unknown>)["actorId"] =
    collisionEnvelope.owner.actorId;
  assertOnlyIssue(ownerApproverCollision, "INVALID_SHAPE", "envelopes/0/approvers");

  const missingWithdrawalReason = structuredClone(validRelease());
  const withdrawalEnvelope = missingWithdrawalReason.envelopes[0];
  assert.ok(withdrawalEnvelope !== undefined);
  Object.assign(withdrawalEnvelope, {
    lifecycleStatus: "withdrawn",
    withdrawalState: "withdrawn",
    withdrawalReason: null,
    withdrawnAt: "2000-01-03T00:00:00.000Z",
  });
  assertOnlyIssue(missingWithdrawalReason, "INVALID_LIFECYCLE", "envelopes/0/lifecycleStatus");

  const invalidSupersededTarget = structuredClone(validRelease());
  const supersededEnvelope = invalidSupersededTarget.envelopes[0];
  assert.ok(supersededEnvelope !== undefined);
  Object.assign(supersededEnvelope, {
    lifecycleStatus: "superseded",
    supersededBy: {
      datasetId: "syn:dataset:food-concept",
      entityId: "not-a-uuid-v7",
      entityRevision: 2,
    },
  });
  assertOnlyIssue(invalidSupersededTarget, "INVALID_LIFECYCLE", "envelopes/0/lifecycleStatus");

  const ambiguousAlias = structuredClone(validRelease());
  (ambiguousAlias.envelopes[0]?.aliases[0] as unknown as Record<string, unknown>)["value"] =
    "SYNTHETIC_ALIAS\u0000CONTROL";
  assertOnlyIssue(ambiguousAlias, "INVALID_SHAPE", "envelopes/0/aliases");

  const reversedReviewWindow = structuredClone(validRelease());
  (reversedReviewWindow.envelopes[0] as unknown as Record<string, unknown>)["reviewedAt"] =
    "2099-01-02T00:00:00.000Z";
  assertOnlyIssue(reversedReviewWindow, "INVALID_SHAPE", "envelopes/0/reviewedAt");
});

test("source snapshot chronology is closed over review and due-time boundaries", () => {
  const equalBoundary = structuredClone(validRelease());
  const equalEnvelope = equalBoundary.envelopes[0];
  assert.ok(equalEnvelope !== undefined);
  Object.assign(equalEnvelope, {
    retrievedAt: "2000-01-02T00:00:00.000Z",
    reviewedAt: "2000-01-02T00:00:00.000Z",
    reviewDueAt: "2000-01-02T00:00:00.000Z",
  });
  (equalEnvelope.sourceSnapshots[0] as unknown as Record<string, unknown>)["retrievedAt"] =
    "2000-01-02T00:00:00.000Z";
  setDigest(equalBoundary);
  assert.equal(validateGovernanceRelease(equalBoundary).ok, true);

  const multipleSnapshots = structuredClone(validRelease());
  const multipleEnvelope = multipleSnapshots.envelopes[0];
  assert.ok(multipleEnvelope !== undefined);
  (multipleEnvelope as unknown as Record<string, unknown>)["sourceReferences"] = [
    multipleEnvelope.sourceReferences[0],
    {
      referenceId: "syn:source:food-concept:second",
      referenceRevision: "syn-revision-2",
      locator: "synthetic://stage09p-m0/food-concept/second",
    },
  ];
  (multipleEnvelope as unknown as Record<string, unknown>)["sourceSnapshots"] = [
    multipleEnvelope.sourceSnapshots[0],
    {
      snapshotId: "syn:snapshot:food-concept:second",
      referenceId: "syn:source:food-concept:second",
      referenceRevision: "syn-revision-2",
      contentDigest: `sha256:${"9".repeat(64)}`,
      retrievedAt: multipleEnvelope.reviewedAt,
    },
  ];
  setDigest(multipleSnapshots);
  assert.equal(validateGovernanceRelease(multipleSnapshots).ok, true);

  for (const retrievedAt of [
    "2000-01-02T00:00:00.001Z",
    "2099-01-02T00:00:00.000Z",
  ]) {
    const invalid = structuredClone(validRelease());
    const envelope = invalid.envelopes[0];
    assert.ok(envelope !== undefined);
    (envelope.sourceSnapshots[0] as unknown as Record<string, unknown>)["retrievedAt"] =
      retrievedAt;
    setDigest(invalid);
    assert.deepEqual(validateGovernanceRelease(invalid), {
      ok: false,
      issues: [{ code: "SOURCE_SNAPSHOT_MISMATCH", path: "envelopes/0/sourceSnapshots" }],
    });
  }
});
