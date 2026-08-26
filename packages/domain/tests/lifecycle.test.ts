import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalReleaseDigest } from "../src/canonical.js";
import {
  decodeActivationContext,
  resolveGovernedReference,
  resolveHardMapping,
} from "../src/resolution.js";
import {
  lifecycleStatuses,
  type GovernanceCatalog,
  type GovernanceEnvelope,
  type GovernanceRelease,
  type GovernedReference,
  type LifecycleStatus,
  type SourceReference,
  type SourceSnapshot,
  type ValidationIssue,
  type ValidationIssueCode,
} from "../src/types.js";
import {
  isLifecycleTransitionAllowed,
  lifecycleOracleCardinality,
  validateGovernanceCatalog,
} from "../src/validation.js";

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
const asCatalog = (releases: readonly GovernanceRelease[]): GovernanceCatalog => ({
  schemaVersion: 1,
  releases,
  hardMappings: [],
});
const setEvidence = (release: Mutable<GovernanceRelease>, revision: number): void => {
  const envelope = release.envelopes[0]!;
  envelope.sourceReferences[0]!.referenceRevision = `syn-revision-${revision}`;
  envelope.sourceSnapshots[0]!.referenceRevision = `syn-revision-${revision}`;
  envelope.sourceSnapshots[0]!.snapshotId = `syn:snapshot:food-concept:${revision}`;
  envelope.sourceSnapshots[0]!.contentDigest = `sha256:${String(revision).repeat(64)}`;
  envelope.aliases[0]!.sourceReferenceRevision = `syn-revision-${revision}`;
  envelope.retrievedAt = `2000-01-${String(revision).padStart(2, "0")}T00:00:00.000Z`;
  envelope.reviewedAt = `2000-02-${String(revision).padStart(2, "0")}T00:00:00.000Z`;
};
const historyRelease = (
  releaseRevision: number,
  entityRevision: number,
  lifecycleStatus: LifecycleStatus,
): GovernanceRelease => {
  const release = cloneRelease();
  release.releaseId = `syn:release:lifecycle:${releaseRevision}`;
  release.releaseRevision = releaseRevision;
  const envelope = release.envelopes[0]!;
  envelope.entityRevision = entityRevision;
  envelope.lifecycleStatus = lifecycleStatus;
  envelope.supersededBy = null;
  envelope.withdrawalState = lifecycleStatus === "withdrawn" ? "withdrawn" : "not_withdrawn";
  envelope.withdrawalReason = lifecycleStatus === "withdrawn" ? "SYNTHETIC_WITHDRAWAL" : null;
  envelope.withdrawnAt = lifecycleStatus === "withdrawn" ? "2000-03-01T00:00:00.000Z" : null;
  setEvidence(release, entityRevision);
  return sign(release);
};

const expectedLifecycleOracle: Readonly<
  Record<LifecycleStatus, Readonly<Record<LifecycleStatus, boolean>>>
> = {
  draft: {
    draft: true, under_review: true, approved: false, active: false,
    superseded: false, withdrawn: false,
  },
  under_review: {
    draft: false, under_review: true, approved: true, active: false,
    superseded: false, withdrawn: false,
  },
  approved: {
    draft: false, under_review: false, approved: true, active: true,
    superseded: true, withdrawn: true,
  },
  active: {
    draft: false, under_review: false, approved: false, active: true,
    superseded: true, withdrawn: true,
  },
  superseded: {
    draft: false, under_review: false, approved: false, active: false,
    superseded: false, withdrawn: false,
  },
  withdrawn: {
    draft: false, under_review: false, approved: false, active: true,
    superseded: false, withdrawn: true,
  },
};

for (const previous of lifecycleStatuses) {
  for (const next of lifecycleStatuses) {
    test(`L00 oracle cell ${previous} -> ${next}`, () => {
      assert.equal(
        isLifecycleTransitionAllowed(previous, next),
        expectedLifecycleOracle[previous][next],
      );
    });
  }
}

test("L00 oracle cardinality is exactly 13 A / 23 R", () => {
  assert.deepStrictEqual(lifecycleOracleCardinality(), { accepted: 13, rejected: 23 });
});

test("L01 whole-release draft -> under_review -> approved -> active history is legal", () => {
  const releases = [
    historyRelease(1, 1, "draft"),
    historyRelease(2, 2, "under_review"),
    historyRelease(3, 3, "approved"),
    historyRelease(4, 4, "active"),
  ];
  assert.deepStrictEqual(validateGovernanceCatalog(asCatalog(releases)), []);
});

test("L02 whole-release active -> superseded history has a same-dataset/kind active target", () => {
  const active = historyRelease(4, 3, "active");
  const superseded = cloneRelease();
  superseded.releaseId = "syn:release:lifecycle:5";
  superseded.releaseRevision = 5;
  const source = superseded.envelopes[0]!;
  source.entityRevision = 4;
  source.lifecycleStatus = "superseded";
  setEvidence(superseded, 4);
  const target = structuredClone(source);
  target.entityId = "01900000-7000-7000-8000-000000000077";
  target.entityRevision = 1;
  target.lifecycleStatus = "active";
  target.supersededBy = null;
  target.sourceReferences[0]!.referenceId = "syn:source:supersession-target";
  target.sourceReferences[0]!.locator = "synthetic://stage09p-m0/supersession-target";
  target.sourceSnapshots[0]!.referenceId = "syn:source:supersession-target";
  target.sourceSnapshots[0]!.snapshotId = "syn:snapshot:supersession-target:1";
  target.sourceSnapshots[0]!.locator = "synthetic://stage09p-m0/supersession-target";
  target.aliases[0]!.sourceReferenceId = "syn:source:supersession-target";
  target.content = { syntheticToken: "SYNTHETIC_SUPERSESSION_TARGET" };
  source.supersededBy = {
    datasetId: target.datasetId,
    entityId: target.entityId,
    entityRevision: target.entityRevision,
  };
  superseded.envelopes.push(target);
  assert.deepStrictEqual(validateGovernanceCatalog(asCatalog([active, sign(superseded)])), []);
});

test("L03 whole-release active -> withdrawn -> active recovery uses higher revisions/evidence", () => {
  const releases = [
    historyRelease(5, 5, "active"),
    historyRelease(6, 6, "withdrawn"),
    historyRelease(7, 7, "active"),
  ];
  assert.deepStrictEqual(validateGovernanceCatalog(asCatalog(releases)), []);
});

test("withdrawn -> active requires fresh source and strictly newer review evidence", () => {
  const previous = historyRelease(6, 6, "withdrawn");
  const previousEnvelope = previous.envelopes[0]!;
  const invalidCases = [
    {
      name: "neither source nor review is fresh",
      keepSource: true,
      keepReview: true,
    },
    {
      name: "only review is fresh",
      keepSource: true,
      keepReview: false,
    },
    {
      name: "only source is fresh",
      keepSource: false,
      keepReview: true,
    },
  ] as const;

  for (const item of invalidCases) {
    const next = structuredClone(historyRelease(7, 7, "active")) as Mutable<GovernanceRelease>;
    const nextEnvelope = next.envelopes[0]!;
    if (item.keepSource) {
      nextEnvelope.sourceReferences = previousEnvelope.sourceReferences.map((reference) => ({
        ...reference,
      }));
      nextEnvelope.sourceSnapshots = previousEnvelope.sourceSnapshots.map((snapshot) => ({
        ...snapshot,
      }));
      nextEnvelope.retrievedAt = previousEnvelope.retrievedAt;
      nextEnvelope.aliases = previousEnvelope.aliases.map((alias) => ({ ...alias }));
    }
    if (item.keepReview) nextEnvelope.reviewedAt = previousEnvelope.reviewedAt;
    assert.deepStrictEqual(
      validateGovernanceCatalog(asCatalog([previous, sign(next)])),
      [
        {
          code: "INVALID_LIFECYCLE_TRANSITION",
          path: "/releases/1/envelopes/0/lifecycleStatus",
        },
      ],
      item.name,
    );
  }
});

interface SourcePairSpec {
  readonly reference: SourceReference;
  readonly snapshot: SourceSnapshot;
}

const sourcePair = (
  label: string,
  snapshotId: string,
  digestDigit: string,
): SourcePairSpec => {
  const referenceId = `syn:source:equivalence:${label}`;
  const referenceRevision = `syn-revision-${label}`;
  const locator = `synthetic://stage09p-m0/equivalence/${label}`;
  return {
    reference: { referenceId, referenceRevision, locator },
    snapshot: {
      snapshotId,
      referenceId,
      referenceRevision,
      locator,
      contentDigest: `sha256:${digestDigit.repeat(64)}`,
      retrievedAt: "2000-01-10T00:00:00.000Z",
    },
  };
};

const setSourceGraph = (
  envelope: Mutable<GovernanceEnvelope>,
  pairs: readonly SourcePairSpec[],
): void => {
  envelope.sourceReferences = pairs.map(({ reference }) => ({ ...reference }));
  envelope.sourceSnapshots = pairs.map(({ snapshot }) => ({ ...snapshot }));
  envelope.aliases = pairs.map(({ reference }, index) => ({
    value: `SYNTHETIC_EQUIVALENCE_ALIAS_${index}`,
    region: "SYNTHETIC-REGION-1",
    language: "x-synthetic",
    sourceReferenceId: reference.referenceId,
    sourceReferenceRevision: reference.referenceRevision,
  }));
};

const copySourceGraph = (
  source: Mutable<GovernanceEnvelope>,
  target: Mutable<GovernanceEnvelope>,
): void => {
  target.sourceReferences = structuredClone(source.sourceReferences);
  target.sourceSnapshots = structuredClone(source.sourceSnapshots);
  target.aliases = structuredClone(source.aliases);
};

const reactivationReleases = (): readonly [
  Mutable<GovernanceRelease>,
  Mutable<GovernanceRelease>,
] => [
  structuredClone(historyRelease(6, 6, "withdrawn")) as Mutable<GovernanceRelease>,
  structuredClone(historyRelease(7, 7, "active")) as Mutable<GovernanceRelease>,
];

const governedReference = (envelope: GovernanceEnvelope): GovernedReference => ({
  datasetId: envelope.datasetId,
  entityId: envelope.entityId,
  entityRevision: envelope.entityRevision,
});

const mappingId = "syn:hard:source-equivalence";
const catalogWithMapping = (
  releases: readonly GovernanceRelease[],
  endpoint: GovernanceEnvelope,
): GovernanceCatalog => {
  const reference = governedReference(endpoint);
  return {
    schemaVersion: 1,
    releases,
    hardMappings: [
      {
        mappingId,
        source: reference,
        target: reference,
        required: true,
      },
    ],
  };
};

const contextResult = decodeActivationContext({
  asOf: "2001-01-01T00:00:00.000Z",
  language: "x-synthetic",
  region: "SYNTHETIC-REGION-1",
});
assert.equal(contextResult.ok, true);
if (!contextResult.ok) throw new Error("synthetic context must decode");
const activationContext = contextResult.value;

const issue = (code: ValidationIssueCode, path: string): ValidationIssue => ({ code, path });
const currentEnvelopePath = "/releases/1/envelopes/0";
const L = issue("INVALID_LIFECYCLE_TRANSITION", `${currentEnvelopePath}/lifecycleStatus`);
const F0 = issue("SOURCE_REFERENCE_EQUIVOCATION", `${currentEnvelopePath}/sourceReferences/0`);
const F1 = issue("SOURCE_REFERENCE_EQUIVOCATION", `${currentEnvelopePath}/sourceReferences/1`);
const R0 = issue("SOURCE_SNAPSHOT_ID_EQUIVOCATION", `${currentEnvelopePath}/sourceSnapshots/0`);
const R1 = issue("SOURCE_SNAPSHOT_ID_EQUIVOCATION", `${currentEnvelopePath}/sourceSnapshots/1`);
const PR0 = issue("SOURCE_SNAPSHOT_MISMATCH", `${currentEnvelopePath}/sourceReferences/0`);
const PR1 = issue("SOURCE_SNAPSHOT_MISMATCH", `${currentEnvelopePath}/sourceReferences/1`);
const PS0 = issue("SOURCE_SNAPSHOT_MISMATCH", `${currentEnvelopePath}/sourceSnapshots/0`);
const PS1 = issue("SOURCE_SNAPSHOT_MISMATCH", `${currentEnvelopePath}/sourceSnapshots/1`);
const rawCanary = "SYNTHETIC_RAW_CANARY_SOURCE_EQUIVALENCE";

const assertIssueContract = (actual: readonly ValidationIssue[]): void => {
  assert.equal(Object.isFrozen(actual), true);
  const pairs = new Set<string>();
  for (const actualIssue of actual) {
    assert.deepStrictEqual(Object.keys(actualIssue), ["code", "path"]);
    assert.equal(Object.isFrozen(actualIssue), true);
    const pair = `${actualIssue.code}\u0000${actualIssue.path}`;
    assert.equal(pairs.has(pair), false);
    pairs.add(pair);
  }
};

const assertInvalidCatalogResult = (actual: unknown): void => {
  const expected = { reason: "invalid_catalog", status: "unmapped" };
  assert.deepStrictEqual(actual, expected);
  assert.deepStrictEqual(Object.keys(actual as object), ["reason", "status"]);
  assert.equal(Object.isFrozen(actual), true);
  assert.equal(JSON.stringify(actual).includes(rawCanary), false);
};

const assertSeRelation = (
  releases: readonly [Mutable<GovernanceRelease>, Mutable<GovernanceRelease>],
  expectedIssues: readonly ValidationIssue[],
  expectedMapped = false,
): void => {
  const currentEnvelope = releases[1].envelopes[0]!;
  currentEnvelope.content = {
    syntheticToken: "SYNTHETIC_SOURCE_EQUIVALENCE",
    rawCanary,
  };
  const signedReleases = releases.map((release) => sign(release));
  const signedCurrent = signedReleases[1]!.envelopes[0]!;
  const catalog = catalogWithMapping(signedReleases, signedCurrent);
  const actualIssues = validateGovernanceCatalog(catalog);
  assert.deepStrictEqual(actualIssues, expectedIssues);
  assertIssueContract(actualIssues);

  const referenceResult = resolveGovernedReference(
    catalog,
    governedReference(signedCurrent),
    activationContext,
  );
  const hardResult = resolveHardMapping(catalog, mappingId, activationContext);
  if (!expectedMapped) {
    assertInvalidCatalogResult(referenceResult);
    assertInvalidCatalogResult(hardResult);
    return;
  }

  assert.deepStrictEqual(referenceResult, {
    envelope: signedCurrent,
    reason: "mapped",
    status: "mapped",
  });
  assert.deepStrictEqual(Object.keys(referenceResult), ["envelope", "reason", "status"]);
  assert.equal(Object.isFrozen(referenceResult), true);
  assert.equal(Object.isFrozen(referenceResult.envelope), true);
  assert.deepStrictEqual(hardResult, {
    mappingId,
    reason: "mapped",
    source: signedCurrent,
    status: "mapped",
    target: signedCurrent,
  });
  assert.deepStrictEqual(Object.keys(hardResult), [
    "mappingId",
    "reason",
    "source",
    "status",
    "target",
  ]);
  assert.equal(Object.isFrozen(hardResult), true);
};

const seTest = (
  name: string,
  arrange: (
    previous: Mutable<GovernanceEnvelope>,
    current: Mutable<GovernanceEnvelope>,
  ) => void,
  expectedIssues: readonly ValidationIssue[],
  expectedMapped = false,
): void => {
  test(name, () => {
    const releases = reactivationReleases();
    arrange(releases[0].envelopes[0]!, releases[1].envelopes[0]!);
    assertSeRelation(releases, expectedIssues, expectedMapped);
  });
};

seTest(
  "SE01 same-order same-value source/retrieval/review reuse is rejected",
  (previous, current) => {
    copySourceGraph(previous, current);
    current.retrievedAt = previous.retrievedAt;
    current.reviewedAt = previous.reviewedAt;
  },
  [L],
);

seTest(
  "SE02 synchronized two-pair permutation is source-equivalent",
  (previous, current) => {
    const pairs = [
      sourcePair("a", "syn:snapshot:x", "a"),
      sourcePair("b", "syn:snapshot:y", "b"),
    ];
    setSourceGraph(previous, pairs);
    setSourceGraph(current, pairs);
    current.sourceReferences.reverse();
    current.sourceSnapshots.reverse();
  },
  [L],
);

seTest(
  "SE03a reference-only three-pair cyclic permutation is source-equivalent",
  (previous, current) => {
    const pairs = [
      sourcePair("a", "syn:snapshot:x", "a"),
      sourcePair("b", "syn:snapshot:y", "b"),
      sourcePair("c", "syn:snapshot:z", "c"),
    ];
    setSourceGraph(previous, pairs);
    setSourceGraph(current, pairs);
    current.sourceReferences = [
      current.sourceReferences[1]!,
      current.sourceReferences[2]!,
      current.sourceReferences[0]!,
    ];
  },
  [L],
);

seTest(
  "SE03b snapshot-only three-pair cyclic permutation is source-equivalent",
  (previous, current) => {
    const pairs = [
      sourcePair("a", "syn:snapshot:x", "a"),
      sourcePair("b", "syn:snapshot:y", "b"),
      sourcePair("c", "syn:snapshot:z", "c"),
    ];
    setSourceGraph(previous, pairs);
    setSourceGraph(current, pairs);
    current.sourceSnapshots = [
      current.sourceSnapshots[1]!,
      current.sourceSnapshots[2]!,
      current.sourceSnapshots[0]!,
    ];
  },
  [L],
);

seTest(
  "SE04 review-only freshness is rejected",
  (previous, current) => {
    copySourceGraph(previous, current);
    current.retrievedAt = previous.retrievedAt;
  },
  [L],
);

seTest(
  "SE05 graph and retrieval freshness with equal review is rejected",
  (previous, current) => {
    current.reviewedAt = previous.reviewedAt;
  },
  [L],
);

seTest(
  "SE06 graph and retrieval freshness with earlier review is rejected",
  (_previous, current) => {
    current.reviewedAt = "2000-02-05T00:00:00.000Z";
  },
  [L],
);

seTest(
  "SE07 identity-clean graph plus retrieval and review freshness is mapped",
  () => {},
  [],
  true,
);

seTest(
  "SE08 length-two clone, object, and Map insertion order are source-equivalent",
  (previous, current) => {
    const pairs = [
      sourcePair("se08-a", "syn:snapshot:se08-x", "8"),
      sourcePair("se08-b", "syn:snapshot:se08-y", "9"),
    ];
    setSourceGraph(previous, pairs);
    setSourceGraph(current, pairs);
    current.sourceReferences = current.sourceReferences.map((reference) =>
      Object.fromEntries(Object.entries(reference).reverse()) as unknown as Mutable<SourceReference>,
    );
    current.sourceSnapshots = current.sourceSnapshots
      .map((snapshot) =>
        Object.fromEntries(Object.entries(snapshot).reverse()) as unknown as Mutable<SourceSnapshot>,
      )
      .reverse();
  },
  [L],
);

seTest(
  "SE09 envelope retrieval and review timestamps cannot self-certify unchanged graph",
  (previous, current) => {
    copySourceGraph(previous, current);
  },
  [L],
);

seTest(
  "SE09b true graph change with equal envelope retrieval is rejected",
  (previous, current) => {
    current.retrievedAt = previous.retrievedAt;
  },
  [L],
);

seTest(
  "SE09c true graph change with earlier envelope retrieval is rejected",
  (_previous, current) => {
    current.retrievedAt = "2000-01-05T00:00:00.000Z";
  },
  [L],
);

seTest(
  "SE10 duplicate SourceKey reference makes graph unavailable and preserves snapshot mismatch",
  (previous, current) => {
    copySourceGraph(previous, current);
    current.sourceReferences.push(structuredClone(current.sourceReferences[0]!));
  },
  [L, PS0],
);

seTest(
  "SE11 duplicate SourceKey snapshot makes graph unavailable and preserves reference mismatch",
  (previous, current) => {
    copySourceGraph(previous, current);
    const duplicate = structuredClone(current.sourceSnapshots[0]!);
    duplicate.snapshotId = "syn:snapshot:duplicate-source-key";
    current.sourceSnapshots.push(duplicate);
  },
  [L, PR0],
);

seTest(
  "SE12 A/X+B/Y to A/X+B/X has exact lifecycle forward and reverse findings",
  (previous, current) => {
    const pairA = sourcePair("a", "syn:snapshot:x", "a");
    const pairBPrevious = sourcePair("b", "syn:snapshot:y", "b");
    const pairBCurrent = sourcePair("b", "syn:snapshot:x", "b");
    setSourceGraph(previous, [pairA, pairBPrevious]);
    setSourceGraph(current, [pairA, pairBCurrent]);
  },
  [L, F1, R1],
);

seTest(
  "SE13 identity-clean locator mismatch preserves both pairing sides",
  (_previous, current) => {
    setSourceGraph(current, [sourcePair("replacement", "syn:snapshot:replacement", "d")]);
    current.sourceSnapshots[0]!.locator =
      "synthetic://stage09p-m0/equivalence/replacement-snapshot-mismatch";
  },
  [L, PR0, PS0],
);

seTest(
  "SE14 synchronized locator drift stays locally available and preserves forward reverse identity",
  (previous, current) => {
    copySourceGraph(previous, current);
    const locator = "synthetic://stage09p-m0/equivalence/locator-drift";
    current.sourceReferences[0]!.locator = locator;
    current.sourceSnapshots[0]!.locator = locator;
  },
  [F0, R0],
);

seTest(
  "SE15 replacing a pair while reusing snapshotId preserves reverse identity",
  (previous, current) => {
    const previousSnapshotId = previous.sourceSnapshots[0]!.snapshotId;
    setSourceGraph(current, [sourcePair("replacement", previousSnapshotId, "e")]);
  },
  [R0],
);

seTest(
  "SE16 compound source graph failure keeps the exact sorted deduplicated layered array",
  (previous, current) => {
    const pairA = sourcePair("a", "syn:snapshot:x", "a");
    const pairB = sourcePair("b", "syn:snapshot:y", "b");
    setSourceGraph(previous, [pairA, pairB]);
    current.sourceReferences = [
      {
        ...pairA.reference,
        locator: "synthetic://stage09p-m0/equivalence/a-reference-0-drift",
      },
      {
        ...pairA.reference,
        locator: "synthetic://stage09p-m0/equivalence/a-reference-1-drift",
      },
    ];
    current.sourceSnapshots = [
      {
        ...pairA.snapshot,
        locator: "synthetic://stage09p-m0/equivalence/a-snapshot-drift",
        contentDigest: `sha256:${"d".repeat(64)}`,
        retrievedAt: "2000-01-11T00:00:00.000Z",
      },
      {
        ...sourcePair("c", pairB.snapshot.snapshotId, "e").snapshot,
      },
    ];
    current.aliases = [
      {
        value: "SYNTHETIC_EQUIVALENCE_ALIAS_A",
        region: "SYNTHETIC-REGION-1",
        language: "x-synthetic",
        sourceReferenceId: pairA.reference.referenceId,
        sourceReferenceRevision: pairA.reference.referenceRevision,
      },
    ];
  },
  [L, F0, F1, R0, R1, PR0, PR1, PS0, PS1],
);

const assertHistorySafeSink = (
  releases: readonly Mutable<GovernanceRelease>[],
  endpoint: Mutable<GovernanceEnvelope>,
  expectedGlobalCode: ValidationIssueCode,
): void => {
  endpoint.content = {
    syntheticToken: "SYNTHETIC_INVALID_HISTORY_SAFE_SINK",
    rawCanary,
  };
  const signedReleases = releases.map((release) => sign(release));
  const signedEndpoint = signedReleases.at(-1)!.envelopes.find(
    (envelope) => envelope.entityId === endpoint.entityId,
  )!;
  const catalog = catalogWithMapping(signedReleases, signedEndpoint);
  const issues = validateGovernanceCatalog(catalog);
  assert.equal(issues.some(({ code }) => code === expectedGlobalCode), true);
  assertIssueContract(issues);
  assertInvalidCatalogResult(
    resolveGovernedReference(catalog, governedReference(signedEndpoint), activationContext),
  );
  assertInvalidCatalogResult(resolveHardMapping(catalog, mappingId, activationContext));
};

for (const order of ["active-withdrawn", "withdrawn-active"] as const) {
  test(`IH01 duplicate-parent order ${order} uses the existing global safe sink`, () => {
    const active = structuredClone(historyRelease(5, 5, "active")) as Mutable<GovernanceRelease>;
    const withdrawn = structuredClone(
      historyRelease(6, 6, "withdrawn"),
    ) as Mutable<GovernanceRelease>;
    const duplicateParent = structuredClone(withdrawn) as Mutable<GovernanceRelease>;
    duplicateParent.releaseId = `syn:release:duplicate-parent:${order}`;
    duplicateParent.envelopes =
      order === "active-withdrawn"
        ? [active.envelopes[0]!, withdrawn.envelopes[0]!]
        : [withdrawn.envelopes[0]!, active.envelopes[0]!];
    const current = structuredClone(historyRelease(7, 7, "active")) as Mutable<GovernanceRelease>;
    assertHistorySafeSink(
      [duplicateParent, current],
      current.envelopes[0]!,
      "DUPLICATE_ENTITY",
    );
  });
}

test("IH02 missing full-snapshot entity followed by reappearance uses existing global safe sink", () => {
  const withdrawn = structuredClone(
    historyRelease(6, 6, "withdrawn"),
  ) as Mutable<GovernanceRelease>;
  const middle = structuredClone(historyRelease(7, 1, "active")) as Mutable<GovernanceRelease>;
  const sentinel = middle.envelopes[0]!;
  sentinel.entityId = "01900000-7000-7000-8000-000000000099";
  sentinel.content = { syntheticToken: "SYNTHETIC_HISTORY_SENTINEL" };
  const reappeared = structuredClone(historyRelease(8, 7, "active")) as Mutable<GovernanceRelease>;
  reappeared.envelopes.push(structuredClone(sentinel));
  assertHistorySafeSink(
    [withdrawn, middle, reappeared],
    reappeared.envelopes[0]!,
    "ENTITY_MISSING_FROM_SNAPSHOT",
  );
});
