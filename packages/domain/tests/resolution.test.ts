import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalReleaseDigest } from "../src/canonical.js";
import { decodeGovernanceCatalog } from "../src/decode.js";
import { sourceTiers } from "../src/index.js";
import {
  decodeActivationContext,
  resolveGovernedReference,
  resolveHardMapping,
} from "../src/resolution.js";
import type {
  DecodedActivationContext,
  GovernanceCatalog,
  GovernanceRelease,
  GovernedReference,
  HardMapping,
} from "../src/types.js";

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [P in keyof T]: Mutable<T[P]> }
    : T;

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../data/samples/stage09p-m0/valid/food-concept.json", import.meta.url),
    "utf8",
  ),
) as GovernanceRelease;
const cloneRelease = (): Mutable<GovernanceRelease> => structuredClone(fixture) as Mutable<GovernanceRelease>;
const sign = (release: Mutable<GovernanceRelease>): GovernanceRelease => {
  release.contentDigest = `sha256:${"0".repeat(64)}`;
  release.contentDigest = canonicalReleaseDigest(release);
  return release as GovernanceRelease;
};

const makeCatalog = (): GovernanceCatalog => {
  const release = cloneRelease();
  const target = structuredClone(release.envelopes[0]!);
  target.entityId = "01900000-7000-7000-8000-000000000066";
  target.sourceReferences[0]!.referenceId = "syn:source:resolver-target";
  target.sourceReferences[0]!.locator = "synthetic://stage09p-m0/resolver-target";
  target.sourceSnapshots[0]!.snapshotId = "syn:snapshot:resolver-target:1";
  target.sourceSnapshots[0]!.referenceId = "syn:source:resolver-target";
  target.sourceSnapshots[0]!.locator = "synthetic://stage09p-m0/resolver-target";
  target.aliases[0]!.sourceReferenceId = "syn:source:resolver-target";
  target.content = { syntheticToken: "SYNTHETIC_RESOLVER_TARGET" };
  release.envelopes.push(target);
  const mapping: HardMapping = {
    mappingId: "syn:mapping:alpha",
    source: {
      datasetId: release.envelopes[0]!.datasetId,
      entityId: release.envelopes[0]!.entityId,
      entityRevision: 1,
    },
    target: { datasetId: target.datasetId, entityId: target.entityId, entityRevision: 1 },
    required: true,
  };
  return { schemaVersion: 1, releases: [sign(release)], hardMappings: [mapping] };
};

const decodeContext = (overrides: Partial<{ asOf: string; language: string; region: string }> = {}) => {
  const decoded = decodeActivationContext({
    asOf: "2001-01-01T00:00:00.000Z",
    language: "x-synthetic",
    region: "SYNTHETIC-REGION-1",
    ...overrides,
  });
  assert.equal(decoded.ok, true);
  if (!decoded.ok) throw new Error("unreachable");
  return decoded.value;
};

const sourceReference = (catalog: GovernanceCatalog): GovernedReference => {
  const envelope = catalog.releases[0]!.envelopes[0]!;
  return {
    datasetId: envelope.datasetId,
    entityId: envelope.entityId,
    entityRevision: envelope.entityRevision,
  };
};

const assertFrozenDeep = (value: unknown): void => {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozenDeep(child);
};

const assertExactFailure = (actual: unknown, expected: { reason: string; status: string }): void => {
  assert.deepStrictEqual(actual, expected);
  assert.deepStrictEqual(Object.keys(actual as object), ["reason", "status"]);
  assert.equal(Object.isFrozen(actual), true);
  assert.equal(JSON.stringify(actual).includes("RAW_"), false);
};

test("activation context strict-decodes exact keys and rejects forged identity", () => {
  const decoded = decodeActivationContext({
    region: "SYNTHETIC-REGION-1",
    language: "x-synthetic",
    asOf: "2001-01-01T00:00:00.000Z",
  });
  assert.equal(decoded.ok, true);
  if (!decoded.ok) throw new Error("unreachable");
  assert.deepStrictEqual(Object.keys(decoded.value), ["asOf", "language", "region"]);
  assertFrozenDeep(decoded.value);
  assert.deepStrictEqual(decodeActivationContext({ ...decoded.value, extra: "raw" }), {
    ok: false,
    code: "INVALID_ACTIVATION_CONTEXT",
  });
});

test("R01 reference and hard mapping return exact frozen mapped whole objects", () => {
  const input = makeCatalog();
  const context = decodeContext();
  const decoded = decodeGovernanceCatalog(input);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) throw new Error("unreachable");
  const source = decoded.value.releases[0]!.envelopes[0]!;
  const target = decoded.value.releases[0]!.envelopes[1]!;
  const referenceResult = resolveGovernedReference(input, sourceReference(input), context);
  assert.deepStrictEqual(referenceResult, { envelope: source, reason: "mapped", status: "mapped" });
  assert.deepStrictEqual(Object.keys(referenceResult), ["envelope", "reason", "status"]);
  assertFrozenDeep(referenceResult);

  const hardResult = resolveHardMapping(input, "syn:mapping:alpha", context);
  assert.deepStrictEqual(hardResult, {
    mappingId: "syn:mapping:alpha",
    reason: "mapped",
    source,
    status: "mapped",
    target,
  });
  assert.deepStrictEqual(Object.keys(hardResult), ["mappingId", "reason", "source", "status", "target"]);
  assertFrozenDeep(hardResult);
});

test("public enum mutation cannot extend resolver authority", () => {
  assert.equal(Object.isFrozen(sourceTiers), true);
  assert.throws(() => (sourceTiers as unknown as string[]).push("L5"), TypeError);
  const input = structuredClone(makeCatalog()) as Mutable<GovernanceCatalog>;
  input.releases[0]!.envelopes[0]!.sourceTier = "L5" as never;
  assert.equal(decodeGovernanceCatalog(input).ok, false);
  assert.deepStrictEqual(resolveGovernedReference(input, sourceReference(input), decodeContext()), {
    reason: "invalid_catalog",
    status: "unmapped",
  });
});

test("R02 forged and missing context have one exact zero-raw failure for both APIs", () => {
  const input = makeCatalog();
  const reference = sourceReference(input);
  const forged = Object.freeze({
    asOf: "2001-01-01T00:00:00.000Z",
    language: "x-synthetic",
    region: "synthetic-region-1",
  }) as DecodedActivationContext;
  const expected = { reason: "invalid_activation_context", status: "unmapped" };
  const results = [
    resolveGovernedReference(input, reference, forged),
    resolveGovernedReference(input, reference, undefined as unknown as DecodedActivationContext),
    resolveHardMapping(input, "syn:mapping:alpha", forged),
    resolveHardMapping(input, "syn:mapping:alpha", undefined as unknown as DecodedActivationContext),
  ];
  for (const result of results) {
    assert.deepStrictEqual(result, expected);
    assert.deepStrictEqual(Object.keys(result), ["reason", "status"]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(JSON.stringify(result).includes("SYNTHETIC-REGION"), false);
  }
});

test("resolver total precedence starts context -> query shape -> catalog safe sink", () => {
  const input = makeCatalog();
  const reference = sourceReference(input);
  const context = decodeContext();
  assert.deepStrictEqual(
    resolveGovernedReference("RAW_CATALOG", { raw: "RAW_REFERENCE" }, {} as DecodedActivationContext),
    { reason: "invalid_activation_context", status: "unmapped" },
  );
  assert.deepStrictEqual(resolveGovernedReference("RAW_CATALOG", { raw: "RAW_REFERENCE" }, context), {
    reason: "invalid_reference",
    status: "unmapped",
  });
  assert.deepStrictEqual(resolveGovernedReference("RAW_CATALOG", reference, context), {
    reason: "invalid_catalog",
    status: "unmapped",
  });
  assert.deepStrictEqual(resolveHardMapping("RAW_CATALOG", {}, context), {
    reason: "invalid_mapping_id",
    status: "unmapped",
  });
});

test("reference identity/revision/status/context precedence is unique", () => {
  const input = makeCatalog();
  const context = decodeContext();
  const reference = sourceReference(input);
  assert.deepStrictEqual(
    resolveGovernedReference(input, { ...reference, entityId: "syn:entity:unknown" }, context),
    { reason: "unknown_identity", status: "unmapped" },
  );
  assert.deepStrictEqual(
    resolveGovernedReference(input, { ...reference, entityRevision: 9 }, context),
    { reason: "unknown_revision", status: "version_mismatch" },
  );

  const later = cloneRelease();
  later.releaseId = "syn:release:food-concept:2";
  later.releaseRevision = 2;
  later.envelopes[0]!.entityRevision = 2;
  later.envelopes[0]!.sourceReferences[0]!.referenceRevision = "syn-revision-2";
  later.envelopes[0]!.sourceSnapshots[0]!.referenceRevision = "syn-revision-2";
  later.envelopes[0]!.sourceSnapshots[0]!.snapshotId = "syn:snapshot:food-concept:2";
  later.envelopes[0]!.aliases[0]!.sourceReferenceRevision = "syn-revision-2";
  const history: GovernanceCatalog = { schemaVersion: 1, releases: [fixture, sign(later)], hardMappings: [] };
  assert.deepStrictEqual(resolveGovernedReference(history, reference, context), {
    reason: "not_latest_revision",
    status: "version_mismatch",
  });

  const withdrawn = makeCatalog();
  const mutableWithdrawn = structuredClone(withdrawn.releases[0]!) as Mutable<GovernanceRelease>;
  mutableWithdrawn.envelopes[0]!.lifecycleStatus = "withdrawn";
  mutableWithdrawn.envelopes[0]!.withdrawalState = "withdrawn";
  mutableWithdrawn.envelopes[0]!.withdrawalReason = "SYNTHETIC_WITHDRAWAL";
  mutableWithdrawn.envelopes[0]!.withdrawnAt = "2000-03-01T00:00:00.000Z";
  const withdrawnInput: GovernanceCatalog = { ...withdrawn, releases: [sign(mutableWithdrawn)] };
  assert.deepStrictEqual(resolveGovernedReference(withdrawnInput, reference, context), {
    reason: "current_revision_withdrawn",
    status: "withdrawn",
  });
});

test("R03 mapping cardinality is 0 unknown and 2 invalid_catalog", () => {
  const input = makeCatalog();
  const context = decodeContext();
  assert.deepStrictEqual(resolveHardMapping(input, "syn:mapping:missing", context), {
    reason: "hard_mapping_unknown",
    status: "unmapped",
  });
  const duplicate = structuredClone(input) as Mutable<GovernanceCatalog>;
  duplicate.hardMappings.push(structuredClone(duplicate.hardMappings[0]!));
  assert.deepStrictEqual(resolveHardMapping(duplicate, "syn:mapping:alpha", context), {
    reason: "invalid_catalog",
    status: "unmapped",
  });
});

test("R04 one query-local endpoint issue plus an unrelated issue safe-sinks", () => {
  const input = structuredClone(makeCatalog()) as Mutable<GovernanceCatalog>;
  input.hardMappings[0]!.target.entityId = "syn:entity:unknown-target";
  input.hardMappings.push({
    mappingId: "syn:mapping:unrelated",
    source: {
      datasetId: "syn:dataset:food-concept",
      entityId: "syn:entity:unknown-source",
      entityRevision: 1,
    },
    target: structuredClone(input.hardMappings[0]!.source),
    required: true,
  });
  assert.deepStrictEqual(resolveHardMapping(input, "syn:mapping:alpha", decodeContext()), {
    reason: "invalid_catalog",
    status: "unmapped",
  });
});

test("R05 and H01 hard target unknown/version/withdrawn/unapproved fail closed", () => {
  const context = decodeContext();
  const unknown = structuredClone(makeCatalog()) as Mutable<GovernanceCatalog>;
  unknown.hardMappings[0]!.target.entityId = "syn:entity:unknown-target";
  assert.deepStrictEqual(resolveHardMapping(unknown, "syn:mapping:alpha", context), {
    reason: "hard_mapping_target_unmapped",
    status: "unmapped",
  });

  const version = structuredClone(makeCatalog()) as Mutable<GovernanceCatalog>;
  version.hardMappings[0]!.target.entityRevision = 2;
  assert.deepStrictEqual(resolveHardMapping(version, "syn:mapping:alpha", context), {
    reason: "hard_mapping_target_version_mismatch",
    status: "version_mismatch",
  });

  const withdrawn = structuredClone(makeCatalog()) as Mutable<GovernanceCatalog>;
  const withdrawnRelease = withdrawn.releases[0]!;
  withdrawnRelease.envelopes[1]!.lifecycleStatus = "withdrawn";
  withdrawnRelease.envelopes[1]!.withdrawalState = "withdrawn";
  withdrawnRelease.envelopes[1]!.withdrawalReason = "SYNTHETIC_WITHDRAWAL";
  withdrawnRelease.envelopes[1]!.withdrawnAt = "2000-03-01T00:00:00.000Z";
  withdrawn.releases = [sign(withdrawnRelease) as Mutable<GovernanceRelease>];
  assert.deepStrictEqual(resolveHardMapping(withdrawn, "syn:mapping:alpha", context), {
    reason: "hard_mapping_target_withdrawn",
    status: "withdrawn",
  });

  const draft = structuredClone(makeCatalog()) as Mutable<GovernanceCatalog>;
  draft.releases[0]!.envelopes[1]!.lifecycleStatus = "draft";
  draft.releases = [sign(draft.releases[0]!) as Mutable<GovernanceRelease>];
  assert.deepStrictEqual(resolveHardMapping(draft, "syn:mapping:alpha", context), {
    reason: "hard_mapping_target_lifecycle_not_active",
    status: "unapproved",
  });
});

test("R06 reference compound context returns region before language/review", () => {
  const input = makeCatalog();
  const result = resolveGovernedReference(
    input,
    sourceReference(input),
    decodeContext({ region: "synthetic-region-other", language: "x-other", asOf: "2099-12-01T00:00:00.000Z" }),
  );
  assert.deepStrictEqual(result, { reason: "region_not_applicable", status: "unapproved" });
  assert.deepStrictEqual(Object.keys(result), ["reason", "status"]);
  assert.equal(Object.isFrozen(result), true);
});

test("R07 hard evaluates the entire source before any target defect", () => {
  const input = structuredClone(makeCatalog()) as Mutable<GovernanceCatalog>;
  input.releases[0]!.envelopes[1]!.lifecycleStatus = "withdrawn";
  input.releases[0]!.envelopes[1]!.withdrawalState = "withdrawn";
  input.releases[0]!.envelopes[1]!.withdrawalReason = "SYNTHETIC_WITHDRAWAL";
  input.releases[0]!.envelopes[1]!.withdrawnAt = "2000-03-01T00:00:00.000Z";
  input.releases = [sign(input.releases[0]!) as Mutable<GovernanceRelease>];
  const result = resolveHardMapping(
    input,
    "syn:mapping:alpha",
    decodeContext({ region: "synthetic-region-other", language: "x-other", asOf: "2099-12-01T00:00:00.000Z" }),
  );
  assert.deepStrictEqual(result, {
    reason: "hard_mapping_source_region_not_applicable",
    status: "unapproved",
  });
  assert.deepStrictEqual(Object.keys(result), ["reason", "status"]);
  assert.equal(Object.isFrozen(result), true);
});

test("reference endpoint order covers lifecycle, region, language, effective time, and expiry", () => {
  const cases = [
    {
      mutate: (input: Mutable<GovernanceCatalog>) => {
        input.releases[0]!.envelopes[0]!.lifecycleStatus = "draft";
      },
      context: {},
      expected: { reason: "lifecycle_not_active", status: "unapproved" },
    },
    {
      mutate: (_input: Mutable<GovernanceCatalog>) => {},
      context: { region: "SYNTHETIC-REGION-OTHER" },
      expected: { reason: "region_not_applicable", status: "unapproved" },
    },
    {
      mutate: (_input: Mutable<GovernanceCatalog>) => {},
      context: { language: "x-other" },
      expected: { reason: "language_not_applicable", status: "unapproved" },
    },
    {
      mutate: (_input: Mutable<GovernanceCatalog>) => {},
      context: { asOf: "1999-01-01T00:00:00.000Z" },
      expected: { reason: "review_not_effective", status: "unapproved" },
    },
    {
      mutate: (_input: Mutable<GovernanceCatalog>) => {},
      context: { asOf: "2099-12-01T00:00:00.000Z" },
      expected: { reason: "review_expired", status: "unapproved" },
    },
  ] as const;
  for (const item of cases) {
    const input = structuredClone(makeCatalog()) as Mutable<GovernanceCatalog>;
    item.mutate(input);
    input.releases = [sign(input.releases[0]!) as Mutable<GovernanceRelease>];
    assertExactFailure(
      resolveGovernedReference(input, sourceReference(input), decodeContext(item.context)),
      item.expected,
    );
  }
});

test("all eight hard context literals are reachable with source-before-target precedence", () => {
  const sourceCases = [
    [{ region: "SYNTHETIC-REGION-OTHER" }, "hard_mapping_source_region_not_applicable"],
    [{ language: "x-other" }, "hard_mapping_source_language_not_applicable"],
    [{ asOf: "1999-01-01T00:00:00.000Z" }, "hard_mapping_source_review_not_effective"],
    [{ asOf: "2099-12-01T00:00:00.000Z" }, "hard_mapping_source_review_expired"],
  ] as const;
  for (const [context, reason] of sourceCases) {
    assertExactFailure(resolveHardMapping(makeCatalog(), "syn:mapping:alpha", decodeContext(context)), {
      reason,
      status: "unapproved",
    });
  }

  const targetCases = [
    {
      reason: "hard_mapping_target_region_not_applicable",
      mutate: (target: Mutable<GovernanceRelease>["envelopes"][number]) => {
        target.applicableRegions = ["SYNTHETIC-REGION-OTHER"];
      },
    },
    {
      reason: "hard_mapping_target_language_not_applicable",
      mutate: (target: Mutable<GovernanceRelease>["envelopes"][number]) => {
        target.languages = ["x-other"];
      },
    },
    {
      reason: "hard_mapping_target_review_not_effective",
      mutate: (target: Mutable<GovernanceRelease>["envelopes"][number]) => {
        target.reviewedAt = "2002-01-01T00:00:00.000Z";
      },
    },
    {
      reason: "hard_mapping_target_review_expired",
      mutate: (target: Mutable<GovernanceRelease>["envelopes"][number]) => {
        target.reviewDueAt = "2000-12-01T00:00:00.000Z";
      },
    },
  ] as const;
  for (const item of targetCases) {
    const input = structuredClone(makeCatalog()) as Mutable<GovernanceCatalog>;
    item.mutate(input.releases[0]!.envelopes[1]!);
    input.releases = [sign(input.releases[0]!) as Mutable<GovernanceRelease>];
    assertExactFailure(resolveHardMapping(input, "syn:mapping:alpha", decodeContext()), {
      reason: item.reason,
      status: "unapproved",
    });
  }
});
