import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { inventoryLotSchema } from "../src/inventory.js";
import * as inventoryV2Public from "../src/inventory-v2.js";
import {
  inventoryAggregateV2Schema,
  inventoryCallerReplayCheckpointClaimV2Schema,
  inventoryDecisionResultV2Schema,
  inventoryEventCoreV2Schema,
  inventoryHistoryV2Schema,
  inventoryLotV2Schema,
  inventoryMaxEventsPerChunkV2,
  inventoryMaxReplayChunkUtf8BytesV2,
  inventoryV2ReasonRows,
  normalizeInventoryCommandBodyV2,
  normalizedInventoryCommandBodyV2Schema,
  inventoryReplayChunkInputV2Schema,
  inventoryReplayChunkResultV2Schema,
  inventoryServerVerifiedReplayCheckpointV2Schema,
  inventoryV2ContractRuleBindings,
  inventoryV2ContractRuleManifest,
  inventoryV2ContractRuleSchemaBindings,
  parseInventoryReplayChunkInputV2,
  rawInventoryCommandBodyV2Schema,
  storedInventoryEventV2Schema,
  type InventoryReplayChunkParseResultV2,
} from "../src/inventory-v2.js";
import * as seasoningV1Public from "../src/seasoning-v1.js";
import {
  normalizeSeasoningCommandBodyV1,
  normalizedSeasoningCommandBodyV1Schema,
  rawSeasoningCommandBodyV1Schema,
  seasoningAggregateV1Schema,
  seasoningCallerReplayCheckpointClaimV1Schema,
  seasoningDecisionResultV1Schema,
  seasoningEventCoreV1Schema,
  parseSeasoningReplayChunkInputV1,
  seasoningReplayChunkInputV1Schema,
  seasoningReplayChunkResultV1Schema,
  seasoningServerVerifiedReplayCheckpointV1Schema,
  seasoningV1ContractRuleBindings,
  seasoningV1ContractRuleManifest,
  seasoningV1ContractRuleSchemaBindings,
  seasoningHistoryV1Schema,
  seasoningMaxEventsPerChunkV1,
  seasoningMaxReplayChunkUtf8BytesV1,
  seasoningProjectionV1Schema,
  storedSeasoningEventV1Schema,
  seasoningV1ReasonRows,
  type SeasoningReplayChunkParseResultV1,
} from "../src/seasoning-v1.js";
import { contractRuleManifest } from "../src/refinement-rules.js";
import { contractRuleBindings, contractRuleSchemaBindings } from "../src/refinement-bindings.js";
import {
  copyStage09pInput,
  copyStage09pReplayChunkInput,
  deepFreezeStage09pOwnedData,
  isStage09pSchemaInputDataGraph,
  parseStage09pReplayChunkJsonText,
  STAGE09P_INPUT_LIMITS,
  STAGE09P_REPLAY_CHUNK_LIMITS,
} from "../src/stage09p-input.js";

const uuid = (suffix: number): string =>
  `018f1f10-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const instant = "2026-09-04T00:00:00.000Z";
const replayJson = (value: unknown): string => JSON.stringify(value);

const compileTimeInventoryReplayDeepReadonly = (result: InventoryReplayChunkParseResultV2): void => {
  if (!result.ok) return;
  // @ts-expect-error parser roots are readonly
  result.value.chunkKind = "first";
  // @ts-expect-error parser arrays are readonly
  result.value.events.push(result.value.events[0]);
  const event = result.value.events[0];
  if (event !== undefined) {
    // @ts-expect-error parser event objects are readonly
    event.eventDigest = event.eventDigest;
    // @ts-expect-error parser payload references are readonly
    event.payload = event.payload;
  }
  const claim = result.value.priorCheckpointClaim;
  if (claim !== null) {
    // @ts-expect-error nested caller claims are readonly
    claim.checkpointDigest = claim.checkpointDigest;
  }
};
void compileTimeInventoryReplayDeepReadonly;

const compileTimeSeasoningReplayDeepReadonly = (result: SeasoningReplayChunkParseResultV1): void => {
  if (!result.ok) return;
  // @ts-expect-error parser roots are readonly
  result.value.chunkKind = "first";
  // @ts-expect-error parser arrays are readonly
  result.value.events.push(result.value.events[0]);
  const event = result.value.events[0];
  if (event !== undefined) {
    // @ts-expect-error nested payload facts are readonly
    event.payload.after = event.payload.after;
    // @ts-expect-error nested binding objects are readonly
    event.payload.binding.bindingDisplayLabel = event.payload.binding.bindingDisplayLabel;
  }
  const claim = result.value.priorCheckpointClaim;
  if (claim !== null) {
    // @ts-expect-error nested caller claims are readonly
    claim.checkpointDigest = claim.checkpointDigest;
  }
};
void compileTimeSeasoningReplayDeepReadonly;

test("descriptor copier catches traps, accessors, cycle, sparse and proto", () => {
  const proxy = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });
  assert.equal(copyStage09pInput(proxy).ok, false);
  let called = false;
  const getter = {};
  Object.defineProperty(getter, "x", { enumerable: true, get: () => { called = true; return 1; } });
  assert.deepEqual(copyStage09pInput(getter), { ok: false, reason: "INPUT_DESCRIPTOR_INVALID" });
  assert.equal(called, false);
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  assert.equal(copyStage09pInput(cycle).ok, false);
  const sparse = new Array(2); sparse[1] = 1;
  assert.equal(copyStage09pInput(sparse).ok, false);
  const proto = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(proto, "__proto__", { enumerable: true, value: "safe" });
  const copied = copyStage09pInput(proto);
  assert.equal(copied.ok, true);
  if (copied.ok) {
    assert.equal(Object.getPrototypeOf(copied.value), null);
    assert.equal(Object.getOwnPropertyDescriptor(copied.value, "__proto__")?.value, "safe");
    assert.equal(Object.isFrozen(copied.value), true);
  }
});

test("descriptor copier catches prototype and descriptor traps", () => {
  const prototypeProxy = new Proxy({}, {
    getPrototypeOf() { throw new Error("prototype"); },
  });
  assert.deepEqual(copyStage09pInput(prototypeProxy), {
    ok: false,
    reason: "INPUT_DESCRIPTOR_INVALID",
  });
  const descriptorProxy = new Proxy({ value: 1 }, {
    getOwnPropertyDescriptor() { throw new Error("descriptor"); },
  });
  assert.deepEqual(copyStage09pInput(descriptorProxy), {
    ok: false,
    reason: "INPUT_DESCRIPTOR_INVALID",
  });
});

test("owned-data deep freeze is recursive, descriptor-only and atomic on rejection", () => {
  const valid = { events: [{ payload: { binding: { label: "salt" } } }] };
  const frozen = deepFreezeStage09pOwnedData(valid);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.events), true);
  assert.equal(Object.isFrozen(frozen.events[0]), true);
  assert.equal(Object.isFrozen(frozen.events[0]?.payload), true);
  assert.equal(Object.isFrozen(frozen.events[0]?.payload.binding), true);
  assert.throws(() => { (frozen.events[0]!.payload.binding as any).label = "pepper"; }, TypeError);

  let getterReads = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "secret", { enumerable: true, get() { getterReads += 1; return "read"; } });
  const safeSibling = { untouched: true };
  const invalid = { safeSibling, accessor };
  assert.throws(() => deepFreezeStage09pOwnedData(invalid), /STAGE09P_OWNED_DATA_DESCRIPTOR_INVALID/);
  assert.equal(getterReads, 0);
  assert.equal(Object.isFrozen(invalid), false);
  assert.equal(Object.isFrozen(safeSibling), false);

  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => deepFreezeStage09pOwnedData(cycle), /STAGE09P_OWNED_DATA_DESCRIPTOR_INVALID/);
  assert.equal(Object.isFrozen(cycle), false);

  const shared = { value: "shared" };
  const aliased = deepFreezeStage09pOwnedData({ left: shared, right: shared });
  assert.strictEqual(aliased.left, aliased.right);
  assert.equal(Object.isFrozen(aliased.left), true);
});

test("pre-Zod replay graph guard rejects erased or non-JSON structure without reading getters", () => {
  assert.equal(isStage09pSchemaInputDataGraph({ nested: [null, "value", 1, true] }), true);
  const polluted = { safe: true };
  Object.defineProperty(polluted, "__proto__", { enumerable: true, value: null });
  assert.equal(isStage09pSchemaInputDataGraph(polluted), false);
  const extended: unknown[] = [];
  Object.defineProperty(extended, "extra", { enumerable: true, value: null });
  assert.equal(isStage09pSchemaInputDataGraph(extended), false);
  const sparse = new Array(1);
  assert.equal(isStage09pSchemaInputDataGraph(sparse), false);
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  assert.equal(isStage09pSchemaInputDataGraph(cycle), false);
  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get() { getterReads += 1; return "read"; } });
  assert.equal(isStage09pSchemaInputDataGraph(accessor), false);
  assert.equal(getterReads, 0);
});

test("descriptor copier enforces exact resource boundaries and same realm", () => {
  assert.equal(copyStage09pInput("x".repeat(STAGE09P_INPUT_LIMITS.maxStringScalars)).ok, true);
  assert.deepEqual(copyStage09pInput("x".repeat(STAGE09P_INPUT_LIMITS.maxStringScalars + 1)), { ok: false, reason: "INPUT_RESOURCE_LIMIT_EXCEEDED" });
  const crossRealm = vm.runInNewContext("({ value: 1 })") as unknown;
  assert.deepEqual(copyStage09pInput(crossRealm), { ok: false, reason: "INPUT_DESCRIPTOR_INVALID" });
});

test("descriptor copier accepts B and rejects B+1 for depth, keys and arrays", () => {
  const nest = (depth: number): unknown => {
    let value: unknown = null;
    for (let index = 0; index < depth; index += 1) value = { child: value };
    return value;
  };
  assert.equal(copyStage09pInput(nest(STAGE09P_INPUT_LIMITS.maxDepth)).ok, true);
  assert.deepEqual(copyStage09pInput(nest(STAGE09P_INPUT_LIMITS.maxDepth + 1)), { ok: false, reason: "INPUT_RESOURCE_LIMIT_EXCEEDED" });

  const keysAtLimit = Object.fromEntries(Array.from({ length: STAGE09P_INPUT_LIMITS.maxObjectKeys }, (_, index) => [`k${index}`, null]));
  assert.equal(copyStage09pInput(keysAtLimit).ok, true);
  const keysOverLimit = { ...keysAtLimit, overflow: null };
  assert.deepEqual(copyStage09pInput(keysOverLimit), { ok: false, reason: "INPUT_RESOURCE_LIMIT_EXCEEDED" });

  assert.equal(copyStage09pInput(Array.from({ length: STAGE09P_INPUT_LIMITS.maxArrayLength }, () => null)).ok, true);
  assert.deepEqual(copyStage09pInput(Array.from({ length: STAGE09P_INPUT_LIMITS.maxArrayLength + 1 }, () => null)), { ok: false, reason: "INPUT_RESOURCE_LIMIT_EXCEEDED" });
});

test("descriptor copier enforces the node B/B+1 boundary", () => {
  const tree = (firstLength: number): unknown[] => Array.from(
    { length: 19_999 },
    (_, index) => Array.from({ length: index === 0 ? firstLength : 49 }, () => null),
  );
  assert.equal(copyStage09pInput(tree(98)).ok, true);
  assert.deepEqual(copyStage09pInput(tree(99)), { ok: false, reason: "INPUT_RESOURCE_LIMIT_EXCEEDED" });
});

test("reason identities are globally unique", () => {
  const rows = [...inventoryV2ReasonRows, ...seasoningV1ReasonRows];
  const rules = [...inventoryV2ContractRuleManifest, ...seasoningV1ContractRuleManifest];
  assert.equal(rows.length, 123);
  assert.equal(inventoryV2ReasonRows.length, 76);
  assert.equal(seasoningV1ReasonRows.length, 47);
  assert.equal(rules.length, 26);
  assert.equal(inventoryV2Public.inventoryNormalizationReasonRows.length, 45);
  assert.equal(seasoningV1Public.seasoningNormalizationReasonRows.length, 13);
  assert.equal(inventoryV2Public.inventoryReplayReasonRows.length, 17);
  assert.equal(seasoningV1Public.seasoningReplayReasonRows.length, 17);
  assert.deepEqual(inventoryV2Public.inventoryReplayReasonRows.at(-1), { code: "INVENTORY_REPLAY_JSON_SYNTAX_INVALID", ordinal: 22_016 });
  assert.deepEqual(seasoningV1Public.seasoningReplayReasonRows.at(-1), { code: "SEASONING_REPLAY_JSON_SYNTAX_INVALID", ordinal: 25_016 });
  assert.deepEqual(inventoryV2Public.inventoryNormalizationReasonRows.at(-1), { code: "INVENTORY_NORMALIZE_INPUT_RESOURCE_LIMIT_EXCEEDED", ordinal: 18_044 });
  assert.deepEqual(seasoningV1Public.seasoningNormalizationReasonRows.at(-1), { code: "SEASONING_NORMALIZE_INPUT_RESOURCE_LIMIT_EXCEEDED", ordinal: 19_012 });
  assert.deepEqual(inventoryV2Public.inventoryNormalizationReasonRows.map((row) => row.ordinal), Array.from({ length: 45 }, (_, index) => 18_000 + index));
  assert.deepEqual(seasoningV1Public.seasoningNormalizationReasonRows.map((row) => row.ordinal), Array.from({ length: 13 }, (_, index) => 19_000 + index));
  assert.equal(new Set(rows.map((row) => row.code)).size, rows.length);
  assert.equal(new Set(rows.map((row) => row.ordinal)).size, rows.length);
  assert.equal(rows.every(Object.isFrozen), true);
});

test("legacy and M2 contract-rule registries are isolated and exactly covered", () => {
  const scopes = [
    { prefix: null, manifest: contractRuleManifest, schemas: contractRuleSchemaBindings, bindings: contractRuleBindings, expected: [35, 34, 35] },
    { prefix: "inventory.v2.", manifest: inventoryV2ContractRuleManifest, schemas: inventoryV2ContractRuleSchemaBindings, bindings: inventoryV2ContractRuleBindings, expected: [15, 15, 15] },
    { prefix: "seasoning.v1.", manifest: seasoningV1ContractRuleManifest, schemas: seasoningV1ContractRuleSchemaBindings, bindings: seasoningV1ContractRuleBindings, expected: [11, 11, 11] },
  ] as const;
  for (const scope of scopes) {
    const boundIds = scope.bindings.flatMap((binding) => binding.ruleIds);
    assert.deepEqual([scope.manifest.length, scope.schemas.length, boundIds.length], scope.expected);
    assert.deepEqual(scope.schemas.map(({ boundary, ruleIds }) => ({ boundary, ruleIds })), scope.bindings);
    assert.deepEqual([...boundIds].sort(), scope.manifest.map((rule) => rule.id).sort());
    assert.equal(new Set(boundIds).size, boundIds.length);
    if (scope.prefix !== null) {
      assert.equal(scope.manifest.every((rule) => rule.id.startsWith(scope.prefix!)), true);
      assert.equal(scope.bindings.every((binding) => binding.ruleIds.every((id) => id.startsWith(scope.prefix!))), true);
    }
  }
  assert.equal(contractRuleManifest.some((rule) => rule.id.startsWith("inventory.v2.") || rule.id.startsWith("seasoning.v1.")), false);
  assert.equal(contractRuleBindings.some((binding) => binding.ruleIds.some((id) => id.startsWith("inventory.v2.") || id.startsWith("seasoning.v1."))), false);
  const m2SchemaObjects = new Set([
    ...inventoryV2ContractRuleSchemaBindings.map((binding) => binding.schema),
    ...seasoningV1ContractRuleSchemaBindings.map((binding) => binding.schema),
  ]);
  assert.equal(contractRuleSchemaBindings.some((binding) => m2SchemaObjects.has(binding.schema)), false);

  const allRules = scopes.flatMap((scope) => [...scope.manifest]);
  const allBindings = scopes.flatMap((scope) => [...scope.schemas]);
  const allBoundIds = allBindings.flatMap((binding) => binding.ruleIds);
  assert.deepEqual([allRules.length, allBindings.length, allBoundIds.length], [61, 60, 61]);
  assert.equal(new Set(allRules.map((rule) => rule.id)).size, 61);
  assert.equal(new Set(allBindings.map((binding) => binding.boundary)).size, 60);
  assert.equal(new Set(allBoundIds).size, 61);
});

test("each M2 replay binding is the exact final public schema object", () => {
  const cases = [
    [inventoryV2ContractRuleSchemaBindings, "inventoryReplayChunkInputV2Schema", "inventory.v2.replay-chunk-consistency.v1", inventoryReplayChunkInputV2Schema],
    [inventoryV2ContractRuleSchemaBindings, "inventoryServerVerifiedReplayCheckpointV2Schema", "inventory.v2.replay-server-checkpoint-consistency.v1", inventoryServerVerifiedReplayCheckpointV2Schema],
    [inventoryV2ContractRuleSchemaBindings, "inventoryReplayChunkResultV2Schema", "inventory.v2.replay-chunk-result-consistency.v1", inventoryReplayChunkResultV2Schema],
    [seasoningV1ContractRuleSchemaBindings, "seasoningReplayChunkInputV1Schema", "seasoning.v1.replay-chunk-consistency.v1", seasoningReplayChunkInputV1Schema],
    [seasoningV1ContractRuleSchemaBindings, "seasoningServerVerifiedReplayCheckpointV1Schema", "seasoning.v1.replay-server-checkpoint-consistency.v1", seasoningServerVerifiedReplayCheckpointV1Schema],
    [seasoningV1ContractRuleSchemaBindings, "seasoningReplayChunkResultV1Schema", "seasoning.v1.replay-chunk-result-consistency.v1", seasoningReplayChunkResultV1Schema],
  ] as const;
  for (const [bindings, boundary, ruleId, schema] of cases) {
    const binding = bindings.find((candidate) => candidate.boundary === boundary);
    assert.notEqual(binding, undefined);
    assert.strictEqual(binding?.schema, schema);
    assert.deepEqual(schema.meta()?.["x-meal-agent-contract-rule-ids"], [ruleId]);
    assert.equal(schema.meta()?.["x-meal-agent-rule-boundary"], boundary);
  }
});


test("estimated date wins over limit and duplicate", () => {
  const dates = Array.from({ length: 9 }, (_, index) => ({ kind: index === 0 ? "estimated_use_by_date" : "purchase_date", value: "2026-09-04", source: { kind: "user_input", confidence: "high", reference: null } }));
  const result = normalizeInventoryCommandBodyV2({ schemaVersion: 2, type: "acquire", source: "manual_confirmation", householdId: uuid(1), inventoryLotId: uuid(2), expectedVersion: "0", observedAt: { mode: "server_time" }, note: null, payload: { lotDisplayName: "rice", binding: { kind: "unbound", bindingDisplayLabel: "rice" }, storageLocation: "pantry", quantity: { kind: "exact", amount: "1", unit: "kg", originalText: null }, dates, initialOpened: { state: "sealed" }, initialFrozen: { state: "not_frozen" } } });
  assert.deepEqual(result, { ok: false, reason: { code: "INVENTORY_NORMALIZE_DATE_KIND_UNSUPPORTED_CURRENT_VERSION", ordinal: 18_024 } });
});

const baseAcquire = (): Record<string, unknown> => ({
  schemaVersion: 2,
  type: "acquire",
  source: "manual_confirmation",
  householdId: uuid(1),
  inventoryLotId: uuid(2),
  expectedVersion: "0",
  observedAt: { mode: "server_time" },
  note: null,
  payload: {
    lotDisplayName: "rice",
    binding: { kind: "unbound", bindingDisplayLabel: "rice" },
    storageLocation: "pantry",
    quantity: { kind: "exact", amount: "1", unit: "kg", originalText: null },
    dates: [],
    initialOpened: { state: "sealed" },
    initialFrozen: { state: "not_frozen" },
  },
});

const changed = (mutate: (value: any) => void): unknown => {
  const value: any = structuredClone(baseAcquire());
  mutate(value);
  return value;
};

test("Inventory normalization predicates produce their dedicated reasons", () => {
  const userDate = () => ({ kind: "purchase_date", value: "2026-09-04", source: { kind: "user_input", confidence: "high", reference: null } });
  const validGuard = (axis: string) => ({ axis, currentMaterialDigest: digest("a") });
  const cases: readonly [string, unknown][] = [
    ["INVENTORY_NORMALIZE_INPUT_DESCRIPTOR_INVALID", new Proxy({}, { ownKeys() { throw new Error("trap"); } })],
    ["INVENTORY_NORMALIZE_BODY_NOT_OBJECT", null],
    ["INVENTORY_NORMALIZE_TOP_LEVEL_UNKNOWN_KEY", changed((v) => { v.extra = true; })],
    ["INVENTORY_NORMALIZE_SCHEMA_VERSION_INVALID", changed((v) => { v.schemaVersion = 3; })],
    ["INVENTORY_NORMALIZE_COMMAND_TYPE_MISSING", changed((v) => { delete v.type; })],
    ["INVENTORY_NORMALIZE_COMMAND_TYPE_UNSUPPORTED", changed((v) => { v.type = "rename"; })],
    ["INVENTORY_NORMALIZE_SOURCE_INVALID", changed((v) => { v.source = "system_event"; })],
    ["INVENTORY_NORMALIZE_SCOPE_INVALID", changed((v) => { v.householdId = "bad"; })],
    ["INVENTORY_NORMALIZE_VERSION_INVALID", changed((v) => { v.expectedVersion = "01"; })],
    ["INVENTORY_NORMALIZE_OCCURRENCE_INVALID", changed((v) => { v.observedAt = { mode: "observed", value: "2026-02-30T00:00:00Z" }; })],
    ["INVENTORY_NORMALIZE_NOTE_INVALID", changed((v) => { v.note = 1; })],
    ["INVENTORY_NORMALIZE_PAYLOAD_NOT_OBJECT", changed((v) => { v.payload = null; })],
    ["INVENTORY_NORMALIZE_PAYLOAD_UNKNOWN_KEY", changed((v) => { v.payload.extra = true; })],
    ["INVENTORY_NORMALIZE_REQUIRED_FIELD_MISSING", changed((v) => { delete v.payload.quantity; })],
    ["INVENTORY_NORMALIZE_NULL_NOT_ALLOWED", changed((v) => { v.payload.quantity = null; })],
    ["INVENTORY_NORMALIZE_TEXT_INVALID", changed((v) => { v.payload.lotDisplayName = ""; })],
    ["INVENTORY_NORMALIZE_QUANTITY_KIND_INVALID", changed((v) => { v.payload.quantity.kind = "numeric"; })],
    ["INVENTORY_NORMALIZE_DECIMAL_NONFINITE", changed((v) => { v.payload.quantity.amount = Number.NaN; })],
    ["INVENTORY_NORMALIZE_DECIMAL_TYPE_INVALID", changed((v) => { v.payload.quantity.amount = -0; })],
    ["INVENTORY_NORMALIZE_DECIMAL_SYNTAX_INVALID", changed((v) => { v.payload.quantity.amount = "1e2"; })],
    ["INVENTORY_NORMALIZE_DECIMAL_ZERO_FORBIDDEN", changed((v) => { v.payload.quantity.amount = "0.0"; })],
    ["INVENTORY_NORMALIZE_DECIMAL_RANGE_EXCEEDED", changed((v) => { v.payload.quantity.amount = "1000000000"; })],
    ["INVENTORY_NORMALIZE_UNIT_INVALID", changed((v) => { v.payload.quantity.unit = ""; })],
    ["INVENTORY_NORMALIZE_CONFIDENCE_INVALID", changed((v) => { v.payload.quantity = { kind: "approximate", amount: "1", unit: "kg", confidence: "certain", originalText: "one" }; })],
    ["INVENTORY_NORMALIZE_DATE_KIND_UNSUPPORTED_CURRENT_VERSION", changed((v) => { v.payload.dates = [{ ...userDate(), kind: "estimated_use_by_date" }]; })],
    ["INVENTORY_NORMALIZE_DATE_OPERATION_LIMIT_EXCEEDED", changed((v) => { v.payload.dates = [userDate(), { ...userDate(), kind: "production_date" }, { ...userDate(), kind: "best_before_date" }, { ...userDate(), kind: "use_by_date" }, { ...userDate(), kind: "prepared_at" }]; })],
    ["INVENTORY_NORMALIZE_DATE_OPERATION_DUPLICATE", changed((v) => { v.payload.dates = [userDate(), userDate()]; })],
    ["INVENTORY_NORMALIZE_DATE_KIND_INVALID", changed((v) => { v.payload.dates = [{ ...userDate(), kind: "harvest_date" }]; })],
    ["INVENTORY_NORMALIZE_DATE_KIND_NOT_ALLOWED_FOR_COMMAND", changed((v) => { v.type = "produce"; v.payload.preparedAt = { knowledge: "unknown" }; v.payload.dates = [userDate()]; })],
    ["INVENTORY_NORMALIZE_DATE_VALUE_INVALID", changed((v) => { v.payload.dates = [{ ...userDate(), value: "2026-02-30" }]; })],
    ["INVENTORY_NORMALIZE_DATE_SOURCE_INVALID", changed((v) => { v.payload.dates = [{ ...userDate(), source: { kind: "package_label", confidence: "high", reference: "label" } }]; })],
    ["INVENTORY_NORMALIZE_DATE_REFERENCE_INVALID", changed((v) => { v.payload.dates = [{ ...userDate(), source: { kind: "user_input", confidence: "high", reference: 1 } }]; })],
    ["INVENTORY_NORMALIZE_ARRAY_ITEM_INVALID", changed((v) => { v.payload.dates = [null]; })],
    ["INVENTORY_NORMALIZE_INITIAL_OBSERVATION_INVALID", changed((v) => { v.payload.initialFrozen = { state: "maybe" }; })],
    ["INVENTORY_NORMALIZE_INITIAL_STATE_CONFLICT", changed((v) => { v.payload.storageLocation = "frozen"; })],
    ["INVENTORY_NORMALIZE_BINDING_INVALID", changed((v) => { v.payload.binding = { kind: "trusted_active" }; })],
    ["INVENTORY_NORMALIZE_CORRECTION_TARGET_INVALID", changed((v) => { v.type = "correct"; v.payload = { targetEventId: "bad", intents: [{ axis: "state", guard: validGuard("state"), after: "active" }] }; })],
    ["INVENTORY_NORMALIZE_CORRECTION_INTENTS_EMPTY", changed((v) => { v.type = "correct"; v.payload = { targetEventId: uuid(9), intents: [] }; })],
    ["INVENTORY_NORMALIZE_CORRECTION_INTENT_LIMIT_EXCEEDED", changed((v) => { v.type = "correct"; v.payload = { targetEventId: uuid(9), intents: Array.from({ length: 7 }, () => ({ axis: "state", guard: validGuard("state"), after: "active" })) }; })],
    ["INVENTORY_NORMALIZE_CORRECTION_AXIS_DUPLICATE", changed((v) => { v.type = "correct"; v.payload = { targetEventId: uuid(9), intents: [{ axis: "state", guard: validGuard("state"), after: "active" }, { axis: "state", guard: validGuard("state"), after: "depleted" }] }; })],
    ["INVENTORY_NORMALIZE_CORRECTION_AXIS_INVALID", changed((v) => { v.type = "correct"; v.payload = { targetEventId: uuid(9), intents: [{ axis: "safety", guard: validGuard("safety"), after: "active" }] }; })],
    ["INVENTORY_NORMALIZE_CORRECTION_GUARD_INVALID", changed((v) => { v.type = "correct"; v.payload = { targetEventId: uuid(9), intents: [{ axis: "state", guard: null, after: "active" }] }; })],
    ["INVENTORY_NORMALIZE_CORRECTION_AFTER_INVALID", changed((v) => { v.type = "correct"; v.payload = { targetEventId: uuid(9), intents: [{ axis: "state", guard: validGuard("state"), after: null }] }; })],
    ["INVENTORY_NORMALIZE_QUALITATIVE_LEVEL_INVALID", changed((v) => { v.payload.quantity = { kind: "qualitative", level: "empty", originalText: null }; })],
    ["INVENTORY_NORMALIZE_INPUT_RESOURCE_LIMIT_EXCEEDED", changed((v) => { v.expectedVersion = "9".repeat(100_000); })],
  ];
  assert.equal(cases.length, inventoryV2ReasonRows.filter((row) => row.code.startsWith("INVENTORY_NORMALIZE_")).length);
  for (const [expected, input] of cases) {
    const result = normalizeInventoryCommandBodyV2(input);
    assert.equal(result.ok, false, expected);
    if (!result.ok) assert.equal(result.reason.code, expected);
  }
});

test("Seasoning normalization predicates cover every reason row", () => {
  const base = () => ({ schemaVersion: 1, type: "observe_seasoning", source: "manual_confirmation", householdId: uuid(1), seasoningId: uuid(3), expectedVersion: "0", observedAt: { mode: "server_time" }, binding: { kind: "unbound", bindingDisplayLabel: "salt" }, observation: "have" });
  const mutate = (change: (value: any) => void): unknown => { const value: any = base(); change(value); return value; };
  const cases: readonly [string, unknown][] = [
    ["SEASONING_NORMALIZE_INPUT_DESCRIPTOR_INVALID", new Proxy({}, { ownKeys() { throw new Error("trap"); } })],
    ["SEASONING_NORMALIZE_BODY_NOT_OBJECT", null],
    ["SEASONING_NORMALIZE_UNKNOWN_KEY", mutate((v) => { v.extra = 1; })],
    ["SEASONING_NORMALIZE_SCHEMA_VERSION_INVALID", mutate((v) => { v.schemaVersion = 2; })],
    ["SEASONING_NORMALIZE_TYPE_INVALID", mutate((v) => { v.type = "observe"; })],
    ["SEASONING_NORMALIZE_SOURCE_INVALID", mutate((v) => { v.source = "system"; })],
    ["SEASONING_NORMALIZE_HOUSEHOLD_ID_INVALID", mutate((v) => { v.householdId = "bad"; })],
    ["SEASONING_NORMALIZE_ID_INVALID", mutate((v) => { v.seasoningId = "bad"; })],
    ["SEASONING_NORMALIZE_VERSION_INVALID", mutate((v) => { v.expectedVersion = "01"; })],
    ["SEASONING_NORMALIZE_OBSERVED_AT_INVALID", mutate((v) => { v.observedAt = { mode: "observed", value: "bad" }; })],
    ["SEASONING_NORMALIZE_BINDING_INVALID", mutate((v) => { v.binding = { kind: "trusted_active" }; })],
    ["SEASONING_NORMALIZE_OBSERVATION_INVALID", mutate((v) => { v.observation = "plenty"; })],
    ["SEASONING_NORMALIZE_INPUT_RESOURCE_LIMIT_EXCEEDED", mutate((v) => { v.expectedVersion = "9".repeat(100_000); })],
  ];
  assert.equal(cases.length, seasoningV1ReasonRows.filter((row) => row.code.startsWith("SEASONING_NORMALIZE_")).length);
  for (const [expected, input] of cases) {
    const result = normalizeSeasoningCommandBodyV1(input);
    assert.equal(result.ok, false, expected);
    if (!result.ok) assert.equal(result.reason.code, expected);
  }
});

test("normalizers distinguish resource, descriptor and semantic version failures", () => {
  const seasoningBase = () => ({ schemaVersion: 1, type: "observe_seasoning", source: "manual_confirmation", householdId: uuid(1), seasoningId: uuid(3), expectedVersion: "0", observedAt: { mode: "server_time" }, binding: { kind: "unbound", bindingDisplayLabel: "salt" }, observation: "have" });
  const long = "x".repeat(STAGE09P_INPUT_LIMITS.maxStringScalars + 1);
  const shared = "s".repeat(STAGE09P_INPUT_LIMITS.maxStringScalars);
  const cumulative = (base: Record<string, unknown>): Record<string, unknown> => {
    for (let index = 0; index < 245; index += 1) base[`extra${index}`] = shared;
    return base;
  };
  const withLongKey = (base: Record<string, unknown>): Record<string, unknown> => {
    base[long] = null;
    return base;
  };

  const inventoryCases: unknown[] = [
    changed((value) => { value.expectedVersion = "9".repeat(100_000); }),
    changed((value) => { value.note = long; }),
    changed((value) => { value.payload.lotDisplayName = long; }),
    withLongKey(structuredClone(baseAcquire())),
    cumulative(structuredClone(baseAcquire())),
  ];
  for (const value of inventoryCases) {
    assert.doesNotThrow(() => rawInventoryCommandBodyV2Schema.safeParse(value));
    assert.deepEqual(normalizeInventoryCommandBodyV2(value), { ok: false, reason: { code: "INVENTORY_NORMALIZE_INPUT_RESOURCE_LIMIT_EXCEEDED", ordinal: 18_044 } });
  }

  const seasoningCases: unknown[] = [
    (() => { const value = seasoningBase(); value.expectedVersion = "9".repeat(100_000); return value; })(),
    (() => { const value = seasoningBase(); value.binding.bindingDisplayLabel = long; return value; })(),
    withLongKey(seasoningBase()),
    cumulative(seasoningBase()),
  ];
  for (const value of seasoningCases) {
    assert.doesNotThrow(() => rawSeasoningCommandBodyV1Schema.safeParse(value));
    assert.deepEqual(normalizeSeasoningCommandBodyV1(value), { ok: false, reason: { code: "SEASONING_NORMALIZE_INPUT_RESOURCE_LIMIT_EXCEEDED", ordinal: 19_012 } });
  }

  assert.deepEqual(normalizeInventoryCommandBodyV2(changed((value) => { value.expectedVersion = "01"; })), { ok: false, reason: { code: "INVENTORY_NORMALIZE_VERSION_INVALID", ordinal: 18_008 } });
  assert.deepEqual(normalizeSeasoningCommandBodyV1({ ...seasoningBase(), expectedVersion: "01" }), { ok: false, reason: { code: "SEASONING_NORMALIZE_VERSION_INVALID", ordinal: 19_008 } });
});

test("V2 rejects eligible while legacy compatibility remains unchanged", () => {
  const v2 = { schemaVersion: 2, id: uuid(2), householdId: uuid(1), lotDisplayName: "rice", foodConceptBinding: { kind: "unbound", bindingDisplayLabel: "rice" }, state: "active", sealState: "sealed", storageLocation: "pantry", currentQuantity: { kind: "exact", amount: "1", unit: "kg", originalText: null }, dates: [], safetyAssessment: { status: "eligible", revision: "1", safetyFactsDigest: digest("a"), reasonCodes: [], policyDigest: null, evaluatedAt: instant }, origin: "manual", createdByUserId: uuid(4), createdAt: instant, updatedAt: instant, version: "1", lastEventSequence: "1", projectionDigest: digest("b") };
  assert.equal(inventoryLotV2Schema.safeParse(v2).success, false);
  assert.equal(typeof inventoryLotSchema.safeParse, "function");
});

test("seasoning aggregate compares every binding field", () => {
  const binding = { kind: "bound", bindingDisplayLabel: "salt", concept: { datasetId: "dataset", foodConceptId: uuid(5), entityRevision: "1", releaseDigest: digest("c") }, authority: "caller_claimed" };
  const event = { schemaVersion: 1, eventId: uuid(6), commandId: uuid(7), type: "seasoning_observed", source: "manual_confirmation", householdId: uuid(1), seasoningId: uuid(3), actorUserId: uuid(4), observedAt: instant, payload: { binding, before: null, after: "have" }, eventCoreDigest: digest("d"), sequence: "1", expectedVersion: "0", resultingVersion: "1", recordedAt: instant, previousEventDigest: null, resultingProjectionDigest: digest("e"), eventDigest: digest("f") };
  const aggregate = { presence: "present", householdId: uuid(1), seasoningId: uuid(3), projection: { schemaVersion: 1, householdId: uuid(1), seasoningId: uuid(3), binding, presence: "have", observedAt: instant, observedByUserId: uuid(4), version: "1", lastEventSequence: "1", projectionDigest: digest("e") }, history: { kind: "nonempty", events: [event], historyDigest: digest("f") } };
  assert.equal(seasoningAggregateV1Schema.safeParse(aggregate).success, true);
  const changed = structuredClone(aggregate);
  changed.projection.binding = {
    ...changed.projection.binding,
    bindingDisplayLabel: "pepper",
  };
  assert.equal(seasoningAggregateV1Schema.safeParse(changed).success, false);
  const mutations: readonly ((value: any) => void)[] = [
    (value) => { value.projection.binding.concept.datasetId = "other"; },
    (value) => { value.projection.binding.concept.foodConceptId = uuid(99); },
    (value) => { value.projection.binding.concept.entityRevision = "2"; },
    (value) => { value.projection.binding.concept.releaseDigest = digest("9"); },
    (value) => { value.projection.binding.authority = "legacy_unverified"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const candidate: any = structuredClone(aggregate);
    candidate.projection.binding = structuredClone(candidate.projection.binding);
    mutate(candidate);
    assert.equal(seasoningAggregateV1Schema.safeParse(candidate).success, false, `binding mutation ${index}`);
  }
});

const storedSource = (kind: "package_label" | "user_input" | "confirmed_recognition" | "system_event" = "user_input") => ({
  kind,
  confidence: kind === "system_event" ? "high" : "high",
  reference: kind === "user_input" || kind === "system_event" ? null : "label",
  capturedAt: instant,
  confirmedByUserId: uuid(4),
  sourceCommandId: uuid(11),
  sourceEventId: uuid(10),
  sourceExpectedLotVersion: "0",
  sourceResultingLotVersion: "1",
});

const storedDate = (kind: "purchase_date" | "production_date" | "best_before_date" | "use_by_date" | "prepared_at" | "opened_at" | "frozen_at" | "thawed_at", sourceKind: "package_label" | "user_input" | "confirmed_recognition" | "system_event" = "user_input") => ({
  kind,
  value: kind.endsWith("_at") ? instant : "2026-09-04",
  source: storedSource(sourceKind),
});

const inventoryFixture = (dates: readonly unknown[] = []) => {
  const quantity = { kind: "exact", amount: "1", unit: "kg", originalText: null };
  const event: any = {
    schemaVersion: 2, eventId: uuid(10), commandId: uuid(11), householdId: uuid(1), inventoryLotId: uuid(2), type: "acquired", source: "manual_confirmation", actorUserId: uuid(4), occurredAt: instant,
    payload: { payloadKind: "acquired", lotDisplayName: "rice", foodConceptBinding: { kind: "unbound", bindingDisplayLabel: "rice" }, state: "active", sealState: "sealed", storageLocation: "pantry", currentQuantity: quantity, dates: structuredClone(dates) },
    note: null, eventCoreDigest: digest("c"), sequence: "1", expectedVersion: "0", resultingVersion: "1", recordedAt: instant, previousEventDigest: null, resultingProjectionDigest: digest("e"), eventDigest: digest("f"),
  };
  const eventCore = { schemaVersion: event.schemaVersion, eventId: event.eventId, commandId: event.commandId, householdId: event.householdId, inventoryLotId: event.inventoryLotId, type: event.type, source: event.source, actorUserId: event.actorUserId, occurredAt: event.occurredAt, payload: structuredClone(event.payload), note: event.note };
  const projection = {
    schemaVersion: 2, id: uuid(2), householdId: uuid(1), lotDisplayName: "rice", foodConceptBinding: { kind: "unbound", bindingDisplayLabel: "rice" }, state: "active", sealState: "sealed", storageLocation: "pantry", currentQuantity: quantity, dates: structuredClone(dates),
    safetyAssessment: { status: "unknown", revision: "1", safetyFactsDigest: digest("b"), reasonCodes: ["SAFETY_AUTHORITY_EMPTY", "FOOD_CONCEPT_UNBOUND"], policyDigest: null, evaluatedAt: instant },
    origin: "manual", createdByUserId: uuid(4), createdAt: instant, updatedAt: instant, version: "1", lastEventSequence: "1", projectionDigest: digest("e"),
  };
  const history = { kind: "nonempty", events: [structuredClone(event)], historyDigest: digest("a") };
  const aggregate = { presence: "present", householdId: uuid(1), inventoryLotId: uuid(2), projection, history };
  const decision = { kind: "accepted", eventCore, event: structuredClone(event), next: aggregate, receipt: { outcome: "accepted", commandType: "acquire", eventType: "acquired", commandId: uuid(11), eventId: uuid(10), resultingVersion: "1", eventCoreDigest: digest("c"), eventDigest: digest("f"), projectionDigest: digest("e"), historyDigest: digest("a") } };
  return { event, eventCore, projection, history, aggregate, decision };
};

test("stored Inventory dates correlate kind, value and source and reject duplicate kinds at every public boundary", () => {
  const validDate = storedDate("purchase_date");
  const valid = inventoryFixture([validDate]);
  assert.equal(inventoryEventCoreV2Schema.safeParse(valid.eventCore).success, true);
  assert.equal(storedInventoryEventV2Schema.safeParse(valid.event).success, true);
  assert.equal(inventoryLotV2Schema.safeParse(valid.projection).success, true);
  assert.equal(inventoryHistoryV2Schema.safeParse(valid.history).success, true);
  assert.equal(inventoryAggregateV2Schema.safeParse(valid.aggregate).success, true);

  const invalidDates = [
    { ...storedDate("purchase_date", "package_label") },
    { ...storedDate("purchase_date"), value: instant },
    { ...storedDate("opened_at"), value: "2026-09-04" },
    { ...storedDate("best_before_date", "system_event") },
  ];
  for (const [index, date] of invalidDates.entries()) {
    const fixture = inventoryFixture([date]);
    assert.equal(inventoryEventCoreV2Schema.safeParse(fixture.eventCore).success, false, `event core cross product ${index}`);
    assert.equal(storedInventoryEventV2Schema.safeParse(fixture.event).success, false, `stored event cross product ${index}`);
    assert.equal(inventoryLotV2Schema.safeParse(fixture.projection).success, false, `lot cross product ${index}`);
  }

  const duplicate = inventoryFixture([validDate, structuredClone(validDate)]);
  assert.equal(inventoryEventCoreV2Schema.safeParse(duplicate.eventCore).success, false);
  assert.equal(storedInventoryEventV2Schema.safeParse(duplicate.event).success, false);
  assert.equal(inventoryLotV2Schema.safeParse(duplicate.projection).success, false);
  assert.equal(inventoryHistoryV2Schema.safeParse(duplicate.history).success, false);

  for (const slot of ["beforeDates", "afterDates"] as const) {
    const transitionEvent: any = { ...structuredClone(valid.event), eventId: uuid(12), commandId: uuid(13), type: "dates_changed", payload: { payloadKind: "dates_changed", beforeDates: [validDate], afterDates: [validDate] }, sequence: "2", expectedVersion: "1", resultingVersion: "2", previousEventDigest: digest("f") };
    transitionEvent.payload[slot] = [validDate, structuredClone(validDate)];
    const transitionCore: any = { schemaVersion: transitionEvent.schemaVersion, eventId: transitionEvent.eventId, commandId: transitionEvent.commandId, householdId: transitionEvent.householdId, inventoryLotId: transitionEvent.inventoryLotId, type: transitionEvent.type, source: transitionEvent.source, actorUserId: transitionEvent.actorUserId, occurredAt: transitionEvent.occurredAt, payload: transitionEvent.payload, note: transitionEvent.note };
    assert.equal(inventoryEventCoreV2Schema.safeParse(transitionCore).success, false, `${slot} event core duplicate`);
    assert.equal(storedInventoryEventV2Schema.safeParse(transitionEvent).success, false, `${slot} stored event duplicate`);
  }
});

test("Inventory aggregate validates stored-date provenance against its history", () => {
  const baseline = inventoryFixture([storedDate("purchase_date")]);
  assert.equal(inventoryAggregateV2Schema.safeParse(baseline.aggregate).success, true);
  const mutations: readonly ((value: any) => void)[] = [
    (value) => { value.projection.dates[0].source.sourceEventId = uuid(99); },
    (value) => { value.projection.dates[0].source.sourceCommandId = uuid(99); },
    (value) => { value.projection.dates[0].source.sourceExpectedLotVersion = "1"; },
    (value) => { value.projection.dates[0].source.sourceResultingLotVersion = "2"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const candidate: any = structuredClone(baseline.aggregate); mutate(candidate);
    assert.equal(inventoryAggregateV2Schema.safeParse(candidate).success, false, `date provenance ${index}`);
  }
  const futureSource: any = structuredClone(baseline.aggregate);
  const quantity = futureSource.projection.currentQuantity;
  const second = { ...structuredClone(futureSource.history.events[0]), eventId: uuid(12), commandId: uuid(13), type: "adjusted", payload: { payloadKind: "adjusted", beforeQuantity: quantity, afterQuantity: quantity }, sequence: "2", expectedVersion: "1", resultingVersion: "2", previousEventDigest: digest("f"), resultingProjectionDigest: digest("d"), eventDigest: digest("b") };
  futureSource.history.events.push(second);
  futureSource.projection.version = "2"; futureSource.projection.lastEventSequence = "2"; futureSource.projection.projectionDigest = digest("d");
  for (const date of [futureSource.history.events[0].payload.dates[0], futureSource.projection.dates[0]]) {
    date.source.sourceEventId = uuid(12); date.source.sourceCommandId = uuid(13); date.source.sourceExpectedLotVersion = "1"; date.source.sourceResultingLotVersion = "2";
  }
  assert.equal(inventoryAggregateV2Schema.safeParse(futureSource).success, false, "an earlier snapshot cannot cite a future event");
});

test("Inventory accepted and unchanged decisions are fully correlated", () => {
  const baseline = inventoryFixture();
  assert.equal(inventoryDecisionResultV2Schema.safeParse(baseline.decision).success, true);
  const mutations: readonly ((value: any) => void)[] = [
    (value) => { value.eventCore.eventId = uuid(98); },
    (value) => { value.eventCore.commandId = uuid(98); },
    (value) => { value.eventCore.householdId = uuid(98); },
    (value) => { value.eventCore.inventoryLotId = uuid(98); },
    (value) => { value.eventCore.actorUserId = uuid(98); },
    (value) => { value.eventCore.occurredAt = "2026-09-04T00:01:00.000Z"; },
    (value) => { value.eventCore.payload.lotDisplayName = "other"; },
    (value) => { value.eventCore.note = "other"; },
    (value) => { value.event.eventId = uuid(97); },
    (value) => { value.event.commandId = uuid(97); },
    (value) => { value.event.householdId = uuid(97); },
    (value) => { value.event.inventoryLotId = uuid(97); },
    (value) => { value.event.actorUserId = uuid(97); },
    (value) => { value.event.occurredAt = "2026-09-04T00:01:00.000Z"; },
    (value) => { value.event.payload.lotDisplayName = "returned-only"; },
    (value) => { value.event.note = "returned-only"; },
    (value) => { value.event.recordedAt = "2026-09-04T00:01:00.000Z"; },
    (value) => { value.event.eventCoreDigest = digest("b"); },
    (value) => { value.event.sequence = "2"; },
    (value) => { value.event.expectedVersion = "1"; },
    (value) => { value.event.resultingVersion = "2"; },
    (value) => { value.event.previousEventDigest = digest("b"); },
    (value) => { value.event.resultingProjectionDigest = digest("b"); },
    (value) => { value.event.eventDigest = digest("b"); },
    (value) => { value.receipt.commandType = "produce"; },
    (value) => { value.receipt.eventType = "produced"; },
    (value) => { value.receipt.commandId = uuid(96); },
    (value) => { value.receipt.eventId = uuid(96); },
    (value) => { value.receipt.resultingVersion = "2"; },
    (value) => { value.receipt.eventCoreDigest = digest("b"); },
    (value) => { value.receipt.eventDigest = digest("b"); },
    (value) => { value.receipt.projectionDigest = digest("b"); },
    (value) => { value.receipt.historyDigest = digest("b"); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const candidate: any = structuredClone(baseline.decision); mutate(candidate);
    assert.equal(inventoryDecisionResultV2Schema.safeParse(candidate).success, false, `accepted correlation ${index}`);
  }
  for (const commandType of ["open", "move", "freeze", "adjust", "change_dates", "change_food_concept_binding"] as const) {
    const unchanged: any = { kind: "unchanged", current: baseline.aggregate, receipt: { outcome: "unchanged", commandType, resultingVersion: "1", projectionDigest: digest("e"), historyDigest: digest("a") } };
    assert.equal(inventoryDecisionResultV2Schema.safeParse(unchanged).success, true, `unchanged ${commandType} baseline`);
    for (const [field, value] of [["resultingVersion", "2"], ["projectionDigest", digest("b")], ["historyDigest", digest("b")]] as const) {
      const candidate: any = structuredClone(unchanged); candidate.receipt[field] = value;
      assert.equal(inventoryDecisionResultV2Schema.safeParse(candidate).success, false, `unchanged ${commandType} ${field}`);
    }
  }
});

const rawCommandBase = (type: "change_dates" | "correct", payload: unknown) => ({ schemaVersion: 2, type, source: "manual_confirmation", householdId: uuid(1), inventoryLotId: uuid(2), expectedVersion: "0", observedAt: { mode: "server_time" }, payload, note: null });
const rawSetDate = (kind: "production_date" | "best_before_date") => ({ operation: "set", date: { kind, value: "2026-09-04", source: { kind: "user_input", confidence: "high", reference: null } } });
const correctionGuard = (axis: string) => ({ axis, currentMaterialDigest: digest("a") });

test("Inventory raw schema, normalizer and normalized schema agree on date and correction axes", () => {
  const duplicateChanges = rawCommandBase("change_dates", { changes: [rawSetDate("production_date"), rawSetDate("production_date")] });
  assert.equal(rawInventoryCommandBodyV2Schema.safeParse(duplicateChanges).success, false);
  assert.equal(normalizedInventoryCommandBodyV2Schema.safeParse(duplicateChanges).success, false);
  const duplicateResult = normalizeInventoryCommandBodyV2(duplicateChanges);
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) assert.equal(duplicateResult.reason.code, "INVENTORY_NORMALIZE_DATE_OPERATION_DUPLICATE");

  const unorderedChanges = rawCommandBase("change_dates", { changes: [rawSetDate("best_before_date"), rawSetDate("production_date")] });
  assert.equal(rawInventoryCommandBodyV2Schema.safeParse(unorderedChanges).success, true);
  assert.equal(normalizedInventoryCommandBodyV2Schema.safeParse(unorderedChanges).success, false);
  const normalizedChanges = normalizeInventoryCommandBodyV2(unorderedChanges);
  assert.equal(normalizedChanges.ok, true);
  if (normalizedChanges.ok) {
    assert.equal(rawInventoryCommandBodyV2Schema.safeParse(normalizedChanges.value).success, true);
    assert.equal(normalizedInventoryCommandBodyV2Schema.safeParse(normalizedChanges.value).success, true);
    assert.deepEqual((normalizedChanges.value as any).payload.changes.map((change: any) => change.date.kind), ["production_date", "best_before_date"]);
  }

  const duplicateAxes = rawCommandBase("correct", { targetEventId: uuid(10), intents: [{ axis: "state", guard: correctionGuard("state"), after: "active" }, { axis: "state", guard: correctionGuard("state"), after: "depleted" }] });
  assert.equal(rawInventoryCommandBodyV2Schema.safeParse(duplicateAxes).success, false);
  assert.equal(normalizedInventoryCommandBodyV2Schema.safeParse(duplicateAxes).success, false);
  const duplicateAxesResult = normalizeInventoryCommandBodyV2(duplicateAxes);
  assert.equal(duplicateAxesResult.ok, false);
  if (!duplicateAxesResult.ok) assert.equal(duplicateAxesResult.reason.code, "INVENTORY_NORMALIZE_CORRECTION_AXIS_DUPLICATE");

  const duplicateNested = rawCommandBase("correct", { targetEventId: uuid(10), intents: [{ axis: "dates", guard: correctionGuard("dates"), changes: [rawSetDate("production_date"), rawSetDate("production_date")] }] });
  assert.equal(rawInventoryCommandBodyV2Schema.safeParse(duplicateNested).success, false);
  assert.equal(normalizedInventoryCommandBodyV2Schema.safeParse(duplicateNested).success, false);
  const duplicateNestedResult = normalizeInventoryCommandBodyV2(duplicateNested);
  assert.equal(duplicateNestedResult.ok, false);
  if (!duplicateNestedResult.ok) assert.equal(duplicateNestedResult.reason.code, "INVENTORY_NORMALIZE_DATE_OPERATION_DUPLICATE");

  const unorderedCorrection = rawCommandBase("correct", { targetEventId: uuid(10), intents: [
    { axis: "storage", guard: correctionGuard("storage"), after: "pantry" },
    { axis: "dates", guard: correctionGuard("dates"), changes: [rawSetDate("best_before_date"), rawSetDate("production_date")] },
    { axis: "binding", guard: correctionGuard("binding"), after: { kind: "unbound", bindingDisplayLabel: "rice" } },
  ] });
  assert.equal(rawInventoryCommandBodyV2Schema.safeParse(unorderedCorrection).success, true);
  assert.equal(normalizedInventoryCommandBodyV2Schema.safeParse(unorderedCorrection).success, false);
  const normalizedCorrection = normalizeInventoryCommandBodyV2(unorderedCorrection);
  assert.equal(normalizedCorrection.ok, true);
  if (normalizedCorrection.ok) {
    assert.equal(rawInventoryCommandBodyV2Schema.safeParse(normalizedCorrection.value).success, true);
    assert.equal(normalizedInventoryCommandBodyV2Schema.safeParse(normalizedCorrection.value).success, true);
    assert.deepEqual((normalizedCorrection.value as any).payload.intents.map((intent: any) => intent.axis), ["binding", "dates", "storage"]);
    assert.deepEqual((normalizedCorrection.value as any).payload.intents[1].changes.map((change: any) => change.date.kind), ["production_date", "best_before_date"]);
  }
});

const seasoningDecisionFixture = (updated: boolean) => {
  const binding = { kind: "unbound", bindingDisplayLabel: "salt" };
  const first: any = { schemaVersion: 1, eventId: uuid(20), commandId: uuid(21), type: "seasoning_observed", source: "manual_confirmation", householdId: uuid(1), seasoningId: uuid(3), actorUserId: uuid(4), observedAt: instant, payload: { binding, before: null, after: "have" }, eventCoreDigest: digest("c"), sequence: "1", expectedVersion: "0", resultingVersion: "1", recordedAt: instant, previousEventDigest: null, resultingProjectionDigest: digest("d"), eventDigest: digest("b") };
  const second: any = { ...structuredClone(first), eventId: uuid(22), commandId: uuid(23), observedAt: "2026-09-04T00:01:00.000Z", payload: { binding, before: "have", after: "low" }, sequence: "2", expectedVersion: "1", resultingVersion: "2", recordedAt: "2026-09-04T00:01:00.000Z", previousEventDigest: digest("b"), resultingProjectionDigest: digest("e"), eventDigest: digest("f") };
  const event = updated ? second : first;
  const events = updated ? [first, second] : [first];
  const projectionDigest = updated ? digest("e") : digest("d");
  const eventCore = { schemaVersion: event.schemaVersion, eventId: event.eventId, commandId: event.commandId, type: event.type, source: event.source, householdId: event.householdId, seasoningId: event.seasoningId, actorUserId: event.actorUserId, observedAt: event.observedAt, payload: structuredClone(event.payload) };
  const next = { presence: "present", householdId: uuid(1), seasoningId: uuid(3), projection: { schemaVersion: 1, householdId: uuid(1), seasoningId: uuid(3), binding, presence: event.payload.after, observedAt: event.observedAt, observedByUserId: uuid(4), version: event.resultingVersion, lastEventSequence: event.sequence, projectionDigest }, history: { kind: "nonempty", events: structuredClone(events), historyDigest: digest("a") } };
  const kind = updated ? "accepted_updated" : "accepted_created";
  return { kind, eventCore, event: structuredClone(event), next, receipt: { outcome: kind, commandId: event.commandId, eventId: event.eventId, resultingVersion: event.resultingVersion, eventCoreDigest: event.eventCoreDigest, eventDigest: event.eventDigest, projectionDigest, historyDigest: digest("a") } };
};

test("Seasoning accepted decisions bind branch, lifecycle, core, event, tip and receipt", () => {
  const created: any = seasoningDecisionFixture(false);
  const updated: any = seasoningDecisionFixture(true);
  assert.equal(seasoningDecisionResultV1Schema.safeParse(created).success, true);
  assert.equal(seasoningDecisionResultV1Schema.safeParse(updated).success, true);
  const mutations: readonly ((value: any) => void)[] = [
    (value) => { value.eventCore.eventId = uuid(90); },
    (value) => { value.eventCore.commandId = uuid(90); },
    (value) => { value.eventCore.householdId = uuid(90); },
    (value) => { value.eventCore.seasoningId = uuid(90); },
    (value) => { value.eventCore.actorUserId = uuid(90); },
    (value) => { value.eventCore.observedAt = "2026-09-04T00:02:00.000Z"; },
    (value) => { value.eventCore.payload.binding.bindingDisplayLabel = "pepper"; },
    (value) => { value.eventCore.payload.after = "low"; },
    (value) => { value.event.eventId = uuid(91); },
    (value) => { value.event.commandId = uuid(91); },
    (value) => { value.event.householdId = uuid(91); },
    (value) => { value.event.seasoningId = uuid(91); },
    (value) => { value.event.actorUserId = uuid(91); },
    (value) => { value.event.observedAt = "2026-09-04T00:02:00.000Z"; },
    (value) => { value.event.payload.after = "low"; },
    (value) => { value.event.recordedAt = "2026-09-04T00:02:00.000Z"; },
    (value) => { value.event.eventCoreDigest = digest("a"); },
    (value) => { value.event.sequence = "2"; },
    (value) => { value.event.resultingProjectionDigest = digest("a"); },
    (value) => { value.event.eventDigest = digest("a"); },
    (value) => { value.receipt.commandId = uuid(90); },
    (value) => { value.receipt.eventId = uuid(90); },
    (value) => { value.receipt.resultingVersion = "2"; },
    (value) => { value.receipt.eventCoreDigest = digest("a"); },
    (value) => { value.receipt.eventDigest = digest("a"); },
    (value) => { value.receipt.projectionDigest = digest("a"); },
    (value) => { value.receipt.historyDigest = digest("b"); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const candidate: any = structuredClone(created); mutate(candidate);
    assert.equal(seasoningDecisionResultV1Schema.safeParse(candidate).success, false, `seasoning correlation ${index}`);
  }
  const wrongCreatedOutcome: any = structuredClone(created); wrongCreatedOutcome.receipt.outcome = "accepted_updated";
  const wrongUpdatedOutcome: any = structuredClone(updated); wrongUpdatedOutcome.receipt.outcome = "accepted_created";
  assert.equal(seasoningDecisionResultV1Schema.safeParse(wrongCreatedOutcome).success, false);
  assert.equal(seasoningDecisionResultV1Schema.safeParse(wrongUpdatedOutcome).success, false);
  const createdAsUpdated: any = structuredClone(created); createdAsUpdated.kind = "accepted_updated"; createdAsUpdated.receipt.outcome = "accepted_updated";
  const updatedAsCreated: any = structuredClone(updated); updatedAsCreated.kind = "accepted_created"; updatedAsCreated.receipt.outcome = "accepted_created";
  assert.equal(seasoningDecisionResultV1Schema.safeParse(createdAsUpdated).success, false);
  assert.equal(seasoningDecisionResultV1Schema.safeParse(updatedAsCreated).success, false);
  const absent = { presence: "absent", householdId: uuid(1), seasoningId: uuid(3), projection: null, history: { kind: "empty", events: [], historyDigest: null } };
  assert.equal(seasoningDecisionResultV1Schema.safeParse({ kind: "unchanged_absent", current: absent }).success, true);
  assert.equal(seasoningDecisionResultV1Schema.safeParse({ kind: "unchanged_present", current: created.next }).success, true);
  assert.equal(seasoningDecisionResultV1Schema.safeParse({ kind: "invalid_aggregate", reason: { code: "SEASONING_HISTORY_SHAPE_INVALID", ordinal: 24_000 } }).success, true);
  assert.equal(seasoningDecisionResultV1Schema.safeParse({ kind: "rejected", reason: { code: "SEASONING_COMMAND_SCOPE_MISMATCH", ordinal: 23_000 } }).success, true);
});

test("descriptor copier charges property names and cumulative aliased strings at exact boundaries", () => {
  const keyAtLimit = "k".repeat(STAGE09P_INPUT_LIMITS.maxStringScalars);
  const keyOverLimit = "k".repeat(STAGE09P_INPUT_LIMITS.maxStringScalars + 1);
  assert.equal(copyStage09pInput({ [keyAtLimit]: null }).ok, true);
  assert.deepEqual(copyStage09pInput({ [keyOverLimit]: null }), { ok: false, reason: "INPUT_RESOURCE_LIMIT_EXCEEDED" });

  const cumulative = (extra: number): Record<string, unknown> => {
    const value = "v".repeat(STAGE09P_INPUT_LIMITS.maxStringScalars);
    const output = Object.create(null) as Record<string, unknown>;
    let charged = 0;
    for (let index = 0; index < 244; index += 1) { const key = `k${index}`; output[key] = value; charged += [...key].length + STAGE09P_INPUT_LIMITS.maxStringScalars; }
    const tailKey = "tail"; const tailLength = STAGE09P_INPUT_LIMITS.maxTotalStringScalars - charged - tailKey.length + extra;
    assert.ok(tailLength > 0 && tailLength <= STAGE09P_INPUT_LIMITS.maxStringScalars);
    output[tailKey] = "t".repeat(tailLength);
    return output;
  };
  assert.equal(copyStage09pInput(cumulative(0)).ok, true);
  assert.deepEqual(copyStage09pInput(cumulative(1)), { ok: false, reason: "INPUT_RESOURCE_LIMIT_EXCEEDED" });
  const shared = "s".repeat(STAGE09P_INPUT_LIMITS.maxStringScalars);
  const aliases = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`a${index}`, shared]));
  assert.deepEqual(copyStage09pInput(aliases), { ok: false, reason: "INPUT_RESOURCE_LIMIT_EXCEEDED" });
});

const replaySessionId = uuid(70);
const replayCheckpointId = uuid(71);
const eventDigestFor = (sequence: number): string => digest("abcdef"[sequence % 6] ?? "a");

const inventoryChunk = (kind: "only" | "first" | "continuation" | "final", before: number, count: number, declared = before + count, previous: string | null = null): any => {
  const householdId = uuid(1); const inventoryLotId = uuid(2);
  const events = Array.from({ length: count }, (_, index) => {
    const sequence = before + index + 1;
    const initial = sequence === 1;
    const fixture: any = inventoryFixture().event;
    return {
      ...fixture,
      eventId: uuid(1_000 + sequence), commandId: uuid(2_000 + sequence), householdId, inventoryLotId,
      type: initial ? "acquired" : "adjusted",
      payload: initial ? fixture.payload : { payloadKind: "adjusted", beforeQuantity: fixture.payload.currentQuantity, afterQuantity: fixture.payload.currentQuantity },
      sequence: String(sequence), expectedVersion: String(sequence - 1), resultingVersion: String(sequence),
      previousEventDigest: index === 0 ? previous : eventDigestFor(sequence - 1), eventDigest: eventDigestFor(sequence),
    };
  });
  const terminal = eventDigestFor(before + count);
  const claim = previous === null ? null : {
    kind: "caller_claim", checkpointId: replayCheckpointId, checkpointDigest: digest("9"), replaySessionId,
    householdId, inventoryLotId, nextChunkOrdinal: String(Math.floor(before / Math.max(count, 1)) + 1),
    processedEventCount: String(before), nextEventSequence: String(before + 1), terminalEventDigest: previous,
    declaredTotalEventCount: String(declared),
  };
  return {
    schemaVersion: 2, householdId, inventoryLotId, replaySessionId, chunkKind: kind,
    chunkOrdinal: previous === null ? "1" : String(Math.floor(before / Math.max(count, 1)) + 1),
    chunkStartSequence: String(before + 1), chunkEndSequence: String(before + count),
    previousChunkTerminalEventDigest: previous, terminalEventDigest: terminal,
    processedEventCountBefore: String(before), chunkEventCount: String(count), claimedProcessedEventCount: String(before + count),
    declaredTotalEventCount: String(declared), priorCheckpointClaim: claim, events,
    claimedFinalHistoryDigest: kind === "only" || kind === "final" ? digest("a") : null,
  };
};

const seasoningChunk = (kind: "only" | "first" | "continuation" | "final", before: number, count: number, declared = before + count, previous: string | null = null): any => {
  const householdId = uuid(1); const seasoningId = uuid(3); const binding = { kind: "unbound", bindingDisplayLabel: "salt" };
  const events = Array.from({ length: count }, (_, index) => {
    const sequence = before + index + 1; const initial = sequence === 1; const after = index % 2 === 0 ? "have" : "low";
    const priorAfter = index === 0 ? (initial ? null : "have") : (index % 2 === 1 ? "have" : "low");
    return {
      schemaVersion: 1, eventId: uuid(3_000 + sequence), commandId: uuid(4_000 + sequence), type: "seasoning_observed", source: "manual_confirmation", householdId, seasoningId, actorUserId: uuid(4), observedAt: instant,
      payload: { binding, before: priorAfter, after }, eventCoreDigest: digest("c"), sequence: String(sequence), expectedVersion: String(sequence - 1), resultingVersion: String(sequence), recordedAt: instant,
      previousEventDigest: index === 0 ? previous : eventDigestFor(sequence - 1), resultingProjectionDigest: digest("e"), eventDigest: eventDigestFor(sequence),
    };
  });
  const terminal = eventDigestFor(before + count);
  const claim = previous === null ? null : { kind: "caller_claim", checkpointId: replayCheckpointId, checkpointDigest: digest("9"), replaySessionId, householdId, seasoningId, nextChunkOrdinal: String(Math.floor(before / Math.max(count, 1)) + 1), processedEventCount: String(before), nextEventSequence: String(before + 1), terminalEventDigest: previous, declaredTotalEventCount: String(declared) };
  return { schemaVersion: 1, householdId, seasoningId, replaySessionId, chunkKind: kind, chunkOrdinal: previous === null ? "1" : String(Math.floor(before / Math.max(count, 1)) + 1), chunkStartSequence: String(before + 1), chunkEndSequence: String(before + count), previousChunkTerminalEventDigest: previous, terminalEventDigest: terminal, processedEventCountBefore: String(before), chunkEventCount: String(count), claimedProcessedEventCount: String(before + count), declaredTotalEventCount: String(declared), priorCheckpointClaim: claim, events, claimedFinalHistoryDigest: kind === "only" || kind === "final" ? digest("a") : null };
};

const emptyReplayChunk = (domain: "inventory" | "seasoning"): any => ({
  schemaVersion: domain === "inventory" ? 2 : 1,
  householdId: uuid(1),
  ...(domain === "inventory" ? { inventoryLotId: uuid(2) } : { seasoningId: uuid(3) }),
  replaySessionId,
  chunkKind: "only",
  chunkOrdinal: "1",
  chunkStartSequence: "1",
  chunkEndSequence: "0",
  previousChunkTerminalEventDigest: null,
  terminalEventDigest: null,
  processedEventCountBefore: "0",
  chunkEventCount: "0",
  claimedProcessedEventCount: "0",
  declaredTotalEventCount: "0",
  priorCheckpointClaim: null,
  events: [],
  claimedFinalHistoryDigest: null,
});

const emptyServerCheckpoint = (domain: "inventory" | "seasoning"): any => ({
  kind: "server_verified",
  status: "finalized",
  checkpointId: replayCheckpointId,
  checkpointDigest: digest("0"),
  replaySessionId,
  householdId: uuid(1),
  ...(domain === "inventory" ? { inventoryLotId: uuid(2) } : { seasoningId: uuid(3) }),
  nextChunkOrdinal: "2",
  processedEventCount: "0",
  nextEventSequence: "1",
  terminalEventDigest: null,
  declaredTotalEventCount: "0",
  verifiedHistoryDigest: null,
});

const withOwnProto = <T extends object>(value: T, payload: unknown = { polluted: true }): T => {
  const copy = structuredClone(value);
  Object.defineProperty(copy, "__proto__", {
    configurable: true,
    enumerable: true,
    value: payload,
    writable: true,
  });
  return copy;
};

const expectReplayCode = (result: any, code: string): void => {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.reason.code, code);
};
const jsonNumberPaths = (value: unknown, path: readonly (string | number)[] = []): readonly { readonly path: readonly (string | number)[]; readonly value: number }[] => {
  if (typeof value === "number") return [{ path, value }];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => jsonNumberPaths(child, [...path, key]));
};

test("r5 replay chunk limits, DTOs and canonical raw parser agree", () => {
  assert.equal(inventoryMaxReplayChunkUtf8BytesV2, 1_048_576);
  assert.equal(seasoningMaxReplayChunkUtf8BytesV1, 1_048_576);
  assert.equal(inventoryMaxEventsPerChunkV2, 17);
  assert.equal(seasoningMaxEventsPerChunkV1, 388);
  assert.equal(STAGE09P_REPLAY_CHUNK_LIMITS.inventory.maxTotalEvents, 10_000);
  assert.equal(STAGE09P_REPLAY_CHUNK_LIMITS.inventory.maxRawUtf8Bytes, 1_048_576);
  assert.equal(STAGE09P_REPLAY_CHUNK_LIMITS.inventory.maxRawCodeUnits, 1_048_576);
  assert.equal(STAGE09P_REPLAY_CHUNK_LIMITS.inventory.maxStringScalars, 65_536);
  assert.equal(parseInventoryReplayChunkInputV2(replayJson(inventoryChunk("only", 0, 1))).ok, true);
  assert.equal(parseSeasoningReplayChunkInputV1(replayJson(seasoningChunk("only", 0, 1))).ok, true);
  assert.equal(copyStage09pReplayChunkInput(inventoryChunk("only", 0, 1), "inventory").ok, true);
  assert.equal(inventoryReplayChunkInputV2Schema.safeParse(inventoryChunk("only", 0, 1)).success, true);
  assert.equal(seasoningReplayChunkInputV1Schema.safeParse(seasoningChunk("only", 0, 1)).success, true);
  for (const [version, chunk] of [[2, inventoryChunk("only", 0, 1)], [1, seasoningChunk("only", 0, 1)]] as const) {
    const numbers = jsonNumberPaths(chunk);
    assert.equal(numbers.length, 2);
    assert.equal(numbers.every((entry) => entry.path.at(-1) === "schemaVersion" && entry.value === version), true);
  }
});

test("r5 accepts locally complete first continuation final chunk flows", () => {
  const inventoryFirst = inventoryChunk("first", 0, 1, 2);
  const inventoryFinal = inventoryChunk("final", 1, 1, 2, inventoryFirst.terminalEventDigest);
  const seasoningFirst = seasoningChunk("first", 0, 1, 2);
  const seasoningFinal = seasoningChunk("final", 1, 1, 2, seasoningFirst.terminalEventDigest);
  assert.equal(parseInventoryReplayChunkInputV2(replayJson(inventoryFirst)).ok, true);
  assert.equal(parseInventoryReplayChunkInputV2(replayJson(inventoryFinal)).ok, true);
  assert.equal(parseSeasoningReplayChunkInputV1(replayJson(seasoningFirst)).ok, true);
  assert.equal(parseSeasoningReplayChunkInputV1(replayJson(seasoningFinal)).ok, true);
});

test("r5 parser distinguishes canonical number, canonical string and JSON syntax", () => {
  for (const [domain, chunk, parse] of [
    ["inventory", inventoryChunk("only", 0, 1), parseInventoryReplayChunkInputV2],
    ["seasoning", seasoningChunk("only", 0, 1), parseSeasoningReplayChunkInputV1],
  ] as const) {
    const text = replayJson(chunk);
    const expectedPrefix = domain === "inventory" ? "INVENTORY_REPLAY_" : "SEASONING_REPLAY_";
    for (const token of [domain === "inventory" ? "2.0" : "1.0", domain === "inventory" ? "2e0" : "1e0", "-0"]) expectReplayCode(parse(text.replace(/"schemaVersion":(?:1|2)/, `"schemaVersion":${token}`)), `${expectedPrefix}CANONICAL_NUMBER_INVALID`);
    const longEquivalent = `${domain === "inventory" ? "2" : "1"}.${"0".repeat(65_536)}`;
    expectReplayCode(parse(text.replace(/"schemaVersion":(?:1|2)/, `"schemaVersion":${longEquivalent}`)), `${expectedPrefix}CANONICAL_NUMBER_INVALID`);
    const exactVersionToken = domain === "inventory" ? "2" : "1";
    expectReplayCode(parse(text.replace('"chunkKind":', `"unexpectedNumber":${exactVersionToken},"chunkKind":`)), `${expectedPrefix}CANONICAL_NUMBER_INVALID`);
    expectReplayCode(parse(text.replace('"events":[{', `"events":[${exactVersionToken},{`)), `${expectedPrefix}CANONICAL_NUMBER_INVALID`);
    expectReplayCode(parse(` ${text}`), `${expectedPrefix}JSON_SYNTAX_INVALID`);
    expectReplayCode(parse(text.replace("chunkKind", "chunk\\u004bind")), `${expectedPrefix}JSON_SYNTAX_INVALID`);
    expectReplayCode(parse(text.replace("{", "{\"schemaVersion\":" + (domain === "inventory" ? "2," : "1,"))), `${expectedPrefix}JSON_SYNTAX_INVALID`);
    expectReplayCode(parse(`${text}x`), `${expectedPrefix}JSON_SYNTAX_INVALID`);
  }
});

test("r5 raw parser is descriptor-safe and wire-cap bounded", () => {
  let traps = 0; const proxy = new Proxy({}, { get() { traps += 1; throw new Error("trap"); }, ownKeys() { traps += 1; throw new Error("trap"); } });
  assert.deepEqual(parseStage09pReplayChunkJsonText(proxy, "inventory"), { ok: false, reason: "INPUT_DESCRIPTOR_INVALID" });
  expectReplayCode(parseInventoryReplayChunkInputV2(proxy as unknown as string), "INVENTORY_REPLAY_INPUT_DESCRIPTOR_INVALID");
  expectReplayCode(parseSeasoningReplayChunkInputV1(proxy as unknown as string), "SEASONING_REPLAY_INPUT_DESCRIPTOR_INVALID");
  assert.equal(traps, 0);
  assert.deepEqual(parseStage09pReplayChunkJsonText('"\\ud800"', "inventory"), { ok: false, reason: "INPUT_JSON_SYNTAX_INVALID" });
  const rawAt = (bytes: number): string => JSON.stringify({ padding: "a".repeat(bytes - '{"padding":""}'.length) });
  const at = rawAt(1_048_576); const over = rawAt(1_048_577);
  assert.equal(Buffer.byteLength(at), 1_048_576);
  assert.equal(Buffer.byteLength(over), 1_048_577);
  const atResult = parseStage09pReplayChunkJsonText(at, "inventory");
  assert.equal(atResult.ok || atResult.reason !== "INPUT_WIRE_BYTE_CAPACITY_EXCEEDED", true);
  assert.deepEqual(parseStage09pReplayChunkJsonText(over, "inventory"), { ok: false, reason: "INPUT_WIRE_BYTE_CAPACITY_EXCEEDED" });
  expectReplayCode(parseInventoryReplayChunkInputV2(over), "INVENTORY_REPLAY_WIRE_BYTE_CAPACITY_EXCEEDED");
  const stringEnvelopeBytes = Buffer.byteLength('{"padding":""}');
  const multibytePayloadBytes = 1_048_576 - stringEnvelopeBytes;
  const multibyteAt = replayJson({ padding: "😀".repeat(Math.floor(multibytePayloadBytes / 4)) + "a".repeat(multibytePayloadBytes % 4) });
  const multibyteOver = multibyteAt.replace(/"}$/, 'a"}');
  assert.equal(Buffer.byteLength(multibyteAt), 1_048_576);
  assert.ok(multibyteAt.length < 1_048_576);
  const multibyteAtResult = parseStage09pReplayChunkJsonText(multibyteAt, "seasoning");
  assert.equal(multibyteAtResult.ok || multibyteAtResult.reason !== "INPUT_WIRE_BYTE_CAPACITY_EXCEEDED", true);
  assert.deepEqual(parseStage09pReplayChunkJsonText(multibyteOver, "seasoning"), { ok: false, reason: "INPUT_WIRE_BYTE_CAPACITY_EXCEEDED" });
  const inventoryResource = { ...inventoryChunk("only", 0, 1), oversized: "x".repeat(STAGE09P_INPUT_LIMITS.maxStringScalars + 1) };
  const seasoningResource = { ...seasoningChunk("only", 0, 1), oversized: "x".repeat(STAGE09P_INPUT_LIMITS.maxStringScalars + 1) };
  expectReplayCode(parseInventoryReplayChunkInputV2(replayJson(inventoryResource)), "INVENTORY_REPLAY_INPUT_RESOURCE_LIMIT_EXCEEDED");
  expectReplayCode(parseSeasoningReplayChunkInputV1(replayJson(seasoningResource)), "SEASONING_REPLAY_INPUT_RESOURCE_LIMIT_EXCEEDED");
});

test("r5 enforces events-per-chunk before event shape", () => {
  const inventory = inventoryChunk("only", 0, inventoryMaxEventsPerChunkV2 + 1);
  const seasoning = seasoningChunk("only", 0, seasoningMaxEventsPerChunkV1 + 1);
  expectReplayCode(parseInventoryReplayChunkInputV2(replayJson(inventory)), "INVENTORY_REPLAY_CHUNK_EVENT_CAPACITY_EXCEEDED");
  expectReplayCode(parseSeasoningReplayChunkInputV1(replayJson(seasoning)), "SEASONING_REPLAY_CHUNK_EVENT_CAPACITY_EXCEEDED");
});

test("r5 chunk validation exposes checkpoint scope order digest finalization and total reasons", () => {
  const cases: readonly [string, (chunk: any) => void, string][] = [
    ["scope", (chunk) => { chunk.events[0].householdId = uuid(99); }, "INVENTORY_REPLAY_SCOPE_MISMATCH"],
    ["order", (chunk) => { chunk.chunkStartSequence = "2"; }, "INVENTORY_REPLAY_CHUNK_SEQUENCE_OR_ORDER_INVALID"],
    ["previous", (chunk) => { chunk.events[0].previousEventDigest = digest("b"); }, "INVENTORY_REPLAY_PREVIOUS_EVENT_DIGEST_MISMATCH"],
    ["terminal", (chunk) => { chunk.terminalEventDigest = digest("c"); }, "INVENTORY_REPLAY_TERMINAL_EVENT_DIGEST_MISMATCH"],
    ["final", (chunk) => { chunk.claimedFinalHistoryDigest = null; }, "INVENTORY_REPLAY_FINALIZATION_INVALID"],
    ["total", (chunk) => { chunk.declaredTotalEventCount = "10001"; }, "INVENTORY_REPLAY_TOTAL_HISTORY_CAPACITY_EXCEEDED"],
  ];
  for (const [, mutate, code] of cases) { const chunk = inventoryChunk("only", 0, 1); mutate(chunk); expectReplayCode(parseInventoryReplayChunkInputV2(replayJson(chunk)), code); }
  const continuation = seasoningChunk("continuation", 1, 1, 3, digest("a")); continuation.priorCheckpointClaim.nextEventSequence = "9";
  expectReplayCode(parseSeasoningReplayChunkInputV1(replayJson(continuation)), "SEASONING_REPLAY_CHECKPOINT_MISMATCH");
  const beforeMismatch = seasoningChunk("only", 0, 2); beforeMismatch.events[1].payload.before = "none";
  expectReplayCode(parseSeasoningReplayChunkInputV1(replayJson(beforeMismatch)), "SEASONING_REPLAY_BEFORE_MISMATCH");
  const duplicate = seasoningChunk("only", 0, 2); duplicate.events[1].eventId = duplicate.events[0].eventId;
  expectReplayCode(parseSeasoningReplayChunkInputV1(replayJson(duplicate)), "SEASONING_REPLAY_CHUNK_SEQUENCE_OR_ORDER_INVALID");
  const unreachableOrdinal = inventoryChunk("continuation", 1, 1, 3, digest("a"));
  unreachableOrdinal.chunkOrdinal = "10001"; unreachableOrdinal.priorCheckpointClaim.nextChunkOrdinal = "10001";
  expectReplayCode(parseInventoryReplayChunkInputV2(replayJson(unreachableOrdinal)), "INVENTORY_REPLAY_CHUNK_SEQUENCE_OR_ORDER_INVALID");
  const malformedEvent = inventoryChunk("only", 0, 1); delete malformedEvent.events[0].eventId;
  expectReplayCode(parseInventoryReplayChunkInputV2(replayJson(malformedEvent)), "INVENTORY_REPLAY_EVENT_SHAPE_INVALID");
});

test("server verified checkpoints occur only in replay results", () => {
  const inventoryCheckpoint: any = { kind: "server_verified", status: "open", checkpointId: replayCheckpointId, checkpointDigest: digest("a"), replaySessionId, householdId: uuid(1), inventoryLotId: uuid(2), nextChunkOrdinal: "2", processedEventCount: "1", nextEventSequence: "2", terminalEventDigest: digest("a"), declaredTotalEventCount: "2", verifiedHistoryDigest: null };
  const seasoningCheckpoint: any = { kind: "server_verified", status: "open", checkpointId: replayCheckpointId, checkpointDigest: digest("a"), replaySessionId, householdId: uuid(1), seasoningId: uuid(3), nextChunkOrdinal: "2", processedEventCount: "1", nextEventSequence: "2", terminalEventDigest: digest("a"), declaredTotalEventCount: "2", verifiedHistoryDigest: null };
  assert.equal(inventoryServerVerifiedReplayCheckpointV2Schema.safeParse(inventoryCheckpoint).success, true);
  assert.equal(seasoningServerVerifiedReplayCheckpointV1Schema.safeParse(seasoningCheckpoint).success, true);
  assert.equal(inventoryCallerReplayCheckpointClaimV2Schema.safeParse(inventoryCheckpoint).success, false);
  assert.equal(seasoningCallerReplayCheckpointClaimV1Schema.safeParse(seasoningCheckpoint).success, false);
  expectReplayCode(parseInventoryReplayChunkInputV2(replayJson(inventoryCheckpoint)), "INVENTORY_REPLAY_INPUT_SHAPE_INVALID");
  expectReplayCode(parseSeasoningReplayChunkInputV1(replayJson(seasoningCheckpoint)), "SEASONING_REPLAY_INPUT_SHAPE_INVALID");
  assert.equal(inventoryReplayChunkResultV2Schema.safeParse({ kind: "accepted_chunk", checkpoint: inventoryCheckpoint }).success, true);
  assert.equal(seasoningReplayChunkResultV1Schema.safeParse({ kind: "accepted_chunk", checkpoint: seasoningCheckpoint }).success, true);
  const inventoryFinalized = { ...inventoryCheckpoint, status: "finalized", nextChunkOrdinal: "3", processedEventCount: "2", nextEventSequence: "3", declaredTotalEventCount: "2", verifiedHistoryDigest: digest("f") };
  const seasoningFinalized = { ...seasoningCheckpoint, status: "finalized", nextChunkOrdinal: "3", processedEventCount: "2", nextEventSequence: "3", declaredTotalEventCount: "2", verifiedHistoryDigest: digest("f") };
  assert.equal(inventoryReplayChunkResultV2Schema.safeParse({ kind: "finalized", checkpoint: inventoryFinalized }).success, true);
  assert.equal(seasoningReplayChunkResultV1Schema.safeParse({ kind: "finalized", checkpoint: seasoningFinalized }).success, true);
  assert.equal(inventoryReplayChunkResultV2Schema.safeParse({ kind: "accepted_chunk", checkpoint: inventoryFinalized }).success, false);
  const raw = inventoryChunk("only", 0, 1); raw.priorCheckpointClaim = inventoryCheckpoint;
  expectReplayCode(parseInventoryReplayChunkInputV2(replayJson(raw)), "INVENTORY_REPLAY_INPUT_SHAPE_INVALID");
  for (const impossible of [
    { processedEventCount: "10000", declaredTotalEventCount: "1" },
    { nextChunkOrdinal: "999999999999" },
    { nextEventSequence: "9" },
  ]) {
    assert.equal(inventoryServerVerifiedReplayCheckpointV2Schema.safeParse({ ...inventoryCheckpoint, ...impossible }).success, false);
    assert.equal(seasoningServerVerifiedReplayCheckpointV1Schema.safeParse({ ...seasoningCheckpoint, ...impossible }).success, false);
  }
});

test("empty replay history is strict, finalized and resource-bounded in both domains", () => {
  const inventory = emptyReplayChunk("inventory");
  const seasoning = emptyReplayChunk("seasoning");
  const inventoryText = replayJson(inventory);
  const seasoningText = replayJson(seasoning);
  assert.equal(Buffer.byteLength(inventoryText), 528);
  assert.equal(Buffer.byteLength(seasoningText), 525);
  assert.ok(Buffer.byteLength(inventoryText) < STAGE09P_REPLAY_CHUNK_LIMITS.inventory.proof.maxEnvelopeUtf8Bytes);
  assert.ok(Buffer.byteLength(seasoningText) < STAGE09P_REPLAY_CHUNK_LIMITS.seasoning.proof.maxEnvelopeUtf8Bytes);

  const parsedInventory = parseInventoryReplayChunkInputV2(inventoryText);
  const parsedSeasoning = parseSeasoningReplayChunkInputV1(seasoningText);
  assert.equal(parsedInventory.ok, true);
  assert.equal(parsedSeasoning.ok, true);
  assert.equal(inventoryReplayChunkInputV2Schema.safeParse(inventory).success, true);
  assert.equal(seasoningReplayChunkInputV1Schema.safeParse(seasoning).success, true);

  const inventoryCheckpoint = emptyServerCheckpoint("inventory");
  const seasoningCheckpoint = emptyServerCheckpoint("seasoning");
  assert.equal(inventoryServerVerifiedReplayCheckpointV2Schema.safeParse(inventoryCheckpoint).success, true);
  assert.equal(seasoningServerVerifiedReplayCheckpointV1Schema.safeParse(seasoningCheckpoint).success, true);
  assert.equal(inventoryCallerReplayCheckpointClaimV2Schema.safeParse(inventoryCheckpoint).success, false);
  assert.equal(seasoningCallerReplayCheckpointClaimV1Schema.safeParse(seasoningCheckpoint).success, false);
  expectReplayCode(parseInventoryReplayChunkInputV2(replayJson(inventoryCheckpoint)), "INVENTORY_REPLAY_INPUT_SHAPE_INVALID");
  expectReplayCode(parseSeasoningReplayChunkInputV1(replayJson(seasoningCheckpoint)), "SEASONING_REPLAY_INPUT_SHAPE_INVALID");
  assert.equal(inventoryReplayChunkResultV2Schema.safeParse({ kind: "finalized", checkpoint: inventoryCheckpoint }).success, true);
  assert.equal(seasoningReplayChunkResultV1Schema.safeParse({ kind: "finalized", checkpoint: seasoningCheckpoint }).success, true);
  assert.equal(inventoryReplayChunkResultV2Schema.safeParse({ kind: "accepted_chunk", checkpoint: inventoryCheckpoint }).success, false);
  assert.equal(seasoningReplayChunkResultV1Schema.safeParse({ kind: "accepted_chunk", checkpoint: seasoningCheckpoint }).success, false);

  for (const [schema, valid] of [
    [inventoryServerVerifiedReplayCheckpointV2Schema, inventoryCheckpoint],
    [seasoningServerVerifiedReplayCheckpointV1Schema, seasoningCheckpoint],
  ] as const) {
    for (const mutate of [
      (value: any) => { value.status = "open"; },
      (value: any) => { value.nextChunkOrdinal = "1"; },
      (value: any) => { value.processedEventCount = "1"; },
      (value: any) => { value.nextEventSequence = "2"; },
      (value: any) => { value.terminalEventDigest = digest("a"); },
      (value: any) => { value.declaredTotalEventCount = "1"; },
      (value: any) => { value.verifiedHistoryDigest = digest("a"); },
      (value: any) => { value.extra = null; },
    ]) {
      const nearMiss = structuredClone(valid); mutate(nearMiss);
      assert.equal(schema.safeParse(nearMiss).success, false);
    }
  }

  for (const [schema, parse, valid] of [
    [inventoryReplayChunkInputV2Schema, parseInventoryReplayChunkInputV2, inventory],
    [seasoningReplayChunkInputV1Schema, parseSeasoningReplayChunkInputV1, seasoning],
  ] as const) {
    for (const mutate of [
      (value: any) => { value.chunkKind = "first"; },
      (value: any) => { value.chunkOrdinal = "2"; },
      (value: any) => { value.chunkStartSequence = "2"; },
      (value: any) => { value.chunkEndSequence = "1"; },
      (value: any) => { value.previousChunkTerminalEventDigest = digest("a"); },
      (value: any) => { value.chunkEventCount = "1"; },
      (value: any) => { value.processedEventCountBefore = "1"; },
      (value: any) => { value.claimedProcessedEventCount = "1"; },
      (value: any) => { value.declaredTotalEventCount = "1"; },
      (value: any) => { value.priorCheckpointClaim = {}; },
      (value: any) => { value.events = [{}]; },
      (value: any) => { value.terminalEventDigest = digest("a"); },
      (value: any) => { value.claimedFinalHistoryDigest = digest("a"); },
      (value: any) => { delete value.claimedFinalHistoryDigest; },
      (value: any) => { value.extra = null; },
    ]) {
      const nearMiss = structuredClone(valid); mutate(nearMiss);
      assert.equal(schema.safeParse(nearMiss).success, false);
      assert.equal(parse(replayJson(nearMiss)).ok, false);
    }
  }
});

test("all six replay boundaries reject own __proto__ fields before Zod can erase them", () => {
  const inventoryInput = emptyReplayChunk("inventory");
  const seasoningInput = emptyReplayChunk("seasoning");
  const inventoryCheckpoint = emptyServerCheckpoint("inventory");
  const seasoningCheckpoint = emptyServerCheckpoint("seasoning");
  const inventoryResult = { kind: "finalized", checkpoint: inventoryCheckpoint };
  const seasoningResult = { kind: "finalized", checkpoint: seasoningCheckpoint };

  for (const [schema, valid] of [
    [inventoryReplayChunkInputV2Schema, inventoryInput],
    [inventoryServerVerifiedReplayCheckpointV2Schema, inventoryCheckpoint],
    [inventoryReplayChunkResultV2Schema, inventoryResult],
    [seasoningReplayChunkInputV1Schema, seasoningInput],
    [seasoningServerVerifiedReplayCheckpointV1Schema, seasoningCheckpoint],
    [seasoningReplayChunkResultV1Schema, seasoningResult],
  ] as const) {
    assert.equal(schema.safeParse(withOwnProto(valid)).success, false);
  }
  assert.equal(inventoryReplayChunkResultV2Schema.safeParse({ ...inventoryResult, checkpoint: withOwnProto(inventoryCheckpoint) }).success, false);
  assert.equal(seasoningReplayChunkResultV1Schema.safeParse({ ...seasoningResult, checkpoint: withOwnProto(seasoningCheckpoint) }).success, false);

  const inventoryContinuation = inventoryChunk("continuation", 1, 1, 3, digest("a"));
  const seasoningContinuation = seasoningChunk("continuation", 1, 1, 3, digest("a"));
  inventoryContinuation.priorCheckpointClaim = withOwnProto(inventoryContinuation.priorCheckpointClaim);
  seasoningContinuation.priorCheckpointClaim = withOwnProto(seasoningContinuation.priorCheckpointClaim);
  assert.equal(inventoryCallerReplayCheckpointClaimV2Schema.safeParse(inventoryContinuation.priorCheckpointClaim).success, false);
  assert.equal(seasoningCallerReplayCheckpointClaimV1Schema.safeParse(seasoningContinuation.priorCheckpointClaim).success, false);
  assert.equal(inventoryReplayChunkInputV2Schema.safeParse(inventoryContinuation).success, false);
  assert.equal(seasoningReplayChunkInputV1Schema.safeParse(seasoningContinuation).success, false);

  const largeErasedField = {
    a: "\u0001".repeat(55_000),
    b: "\u0001".repeat(55_000),
    c: "\u0001".repeat(55_000),
  };
  const inventoryText = replayJson(withOwnProto(inventoryInput, largeErasedField));
  const seasoningText = replayJson(withOwnProto(seasoningInput, largeErasedField));
  assert.ok(Buffer.byteLength(inventoryText) > STAGE09P_REPLAY_CHUNK_LIMITS.inventory.proof.maxEnvelopeUtf8Bytes);
  assert.ok(Buffer.byteLength(seasoningText) > STAGE09P_REPLAY_CHUNK_LIMITS.seasoning.proof.maxEnvelopeUtf8Bytes);
  assert.ok(Buffer.byteLength(inventoryText) < 1_048_576);
  assert.ok(Buffer.byteLength(seasoningText) < 1_048_576);
  expectReplayCode(parseInventoryReplayChunkInputV2(inventoryText), "INVENTORY_REPLAY_INPUT_SHAPE_INVALID");
  expectReplayCode(parseSeasoningReplayChunkInputV1(seasoningText), "SEASONING_REPLAY_INPUT_SHAPE_INVALID");
});

test("M2 replay public schemas and bindings have identical authority acceptance", () => {
  const inventoryInputBinding = inventoryV2ContractRuleSchemaBindings.find((binding) => binding.boundary === "inventoryReplayChunkInputV2Schema")!;
  const inventoryCheckpointBinding = inventoryV2ContractRuleSchemaBindings.find((binding) => binding.boundary === "inventoryServerVerifiedReplayCheckpointV2Schema")!;
  const inventoryResultBinding = inventoryV2ContractRuleSchemaBindings.find((binding) => binding.boundary === "inventoryReplayChunkResultV2Schema")!;
  const seasoningInputBinding = seasoningV1ContractRuleSchemaBindings.find((binding) => binding.boundary === "seasoningReplayChunkInputV1Schema")!;
  const seasoningCheckpointBinding = seasoningV1ContractRuleSchemaBindings.find((binding) => binding.boundary === "seasoningServerVerifiedReplayCheckpointV1Schema")!;
  const seasoningResultBinding = seasoningV1ContractRuleSchemaBindings.find((binding) => binding.boundary === "seasoningReplayChunkResultV1Schema")!;
  const inventoryOpen = { kind: "server_verified", status: "open", checkpointId: replayCheckpointId, checkpointDigest: digest("a"), replaySessionId, householdId: uuid(1), inventoryLotId: uuid(2), nextChunkOrdinal: "2", processedEventCount: "1", nextEventSequence: "2", terminalEventDigest: digest("a"), declaredTotalEventCount: "2", verifiedHistoryDigest: null };
  const seasoningOpen = { kind: "server_verified", status: "open", checkpointId: replayCheckpointId, checkpointDigest: digest("a"), replaySessionId, householdId: uuid(1), seasoningId: uuid(3), nextChunkOrdinal: "2", processedEventCount: "1", nextEventSequence: "2", terminalEventDigest: digest("a"), declaredTotalEventCount: "2", verifiedHistoryDigest: null };

  for (const [schema, binding, samples] of [
    [inventoryReplayChunkInputV2Schema, inventoryInputBinding, [inventoryChunk("only", 0, 1), emptyReplayChunk("inventory"), inventoryOpen, emptyServerCheckpoint("inventory")]],
    [inventoryServerVerifiedReplayCheckpointV2Schema, inventoryCheckpointBinding, [inventoryOpen, emptyServerCheckpoint("inventory"), inventoryChunk("only", 0, 1), inventoryChunk("continuation", 1, 1, 3, digest("a")).priorCheckpointClaim]],
    [inventoryReplayChunkResultV2Schema, inventoryResultBinding, [{ kind: "accepted_chunk", checkpoint: inventoryOpen }, { kind: "finalized", checkpoint: emptyServerCheckpoint("inventory") }, { kind: "accepted_chunk", checkpoint: emptyServerCheckpoint("inventory") }]],
    [seasoningReplayChunkInputV1Schema, seasoningInputBinding, [seasoningChunk("only", 0, 1), emptyReplayChunk("seasoning"), seasoningOpen, emptyServerCheckpoint("seasoning")]],
    [seasoningServerVerifiedReplayCheckpointV1Schema, seasoningCheckpointBinding, [seasoningOpen, emptyServerCheckpoint("seasoning"), seasoningChunk("only", 0, 1), seasoningChunk("continuation", 1, 1, 3, digest("a")).priorCheckpointClaim]],
    [seasoningReplayChunkResultV1Schema, seasoningResultBinding, [{ kind: "accepted_chunk", checkpoint: seasoningOpen }, { kind: "finalized", checkpoint: emptyServerCheckpoint("seasoning") }, { kind: "accepted_chunk", checkpoint: emptyServerCheckpoint("seasoning") }]],
  ] as const) {
    assert.strictEqual(binding.schema, schema);
    for (const sample of samples) assert.equal(binding.schema.safeParse(sample).success, schema.safeParse(sample).success);
  }
  assert.equal(inventoryReplayChunkInputV2Schema.safeParse(inventoryOpen).success, false);
  assert.equal(inventoryServerVerifiedReplayCheckpointV2Schema.safeParse(inventoryChunk("only", 0, 1)).success, false);
  assert.equal(seasoningReplayChunkInputV1Schema.safeParse(seasoningOpen).success, false);
  assert.equal(seasoningServerVerifiedReplayCheckpointV1Schema.safeParse(seasoningChunk("only", 0, 1)).success, false);
});

test("successful raw replay parses are deeply frozen", () => {
  const assertFrozenGraph = (value: unknown, seen = new WeakSet<object>()): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    assert.equal(Object.isFrozen(value), true);
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assert.notEqual(descriptor, undefined);
      assert.equal(descriptor !== undefined && "value" in descriptor, true);
      if (descriptor !== undefined && "value" in descriptor) assertFrozenGraph(descriptor.value, seen);
    }
  };
  for (const parsed of [
    parseInventoryReplayChunkInputV2(replayJson(inventoryChunk("continuation", 1, 1, 3, digest("a")))),
    parseSeasoningReplayChunkInputV1(replayJson(seasoningChunk("continuation", 1, 1, 3, digest("a")))),
    parseInventoryReplayChunkInputV2(replayJson(emptyReplayChunk("inventory"))),
    parseSeasoningReplayChunkInputV1(replayJson(emptyReplayChunk("seasoning"))),
  ]) {
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    assertFrozenGraph(parsed.value);
    assert.throws(() => { (parsed.value.events as unknown[]).push(null); }, TypeError);
    assert.throws(() => { (parsed.value as any).chunkKind = "first"; }, TypeError);
    if (parsed.value.events.length > 0) {
      assert.throws(() => { (parsed.value.events[0] as any).eventDigest = digest("f"); }, TypeError);
      assert.throws(() => { (parsed.value.events[0] as any).payload = null; }, TypeError);
    }
    if (parsed.value.priorCheckpointClaim !== null) {
      assert.throws(() => { (parsed.value.priorCheckpointClaim as any).checkpointDigest = digest("f"); }, TypeError);
    }
  }
});

test("r5 composes the 10000-event logical history through bounded chunks", { timeout: 30_000 }, () => {
  const compose = (limit: number, make: (kind: "first" | "continuation" | "final", before: number, count: number, declared: number, previous: string | null) => any, parse: (text: string) => any): void => {
    let before = 0; let previous: string | null = null; let chunks = 0;
    while (before < 10_000) {
      const count = Math.min(limit, 10_000 - before); const kind = before === 0 ? "first" : before + count === 10_000 ? "final" : "continuation";
      const chunk = make(kind, before, count, 10_000, previous);
      chunk.chunkOrdinal = String(chunks + 1);
      if (chunk.priorCheckpointClaim !== null) chunk.priorCheckpointClaim.nextChunkOrdinal = chunk.chunkOrdinal;
      const parsed = parse(replayJson(chunk));
      assert.equal(parsed.ok, true, JSON.stringify(parsed)); previous = chunk.terminalEventDigest; before += count; chunks += 1;
    }
    assert.ok(chunks > 1);
  };
  compose(inventoryMaxEventsPerChunkV2, inventoryChunk, parseInventoryReplayChunkInputV2);
  compose(seasoningMaxEventsPerChunkV1, seasoningChunk, parseSeasoningReplayChunkInputV1);
});

test("r5 wire proof covers canonical C0 worst-case events and maximal valid chunks", { timeout: 30_000 }, () => {
  const scalar = "\u0001";
  const maximum = "9223372036854775807";
  const beforeMaximum = "9223372036854775806";
  const proofInstant = "9999-12-31T23:59:59.999Z";
  const replayProofDateKinds = ["purchase_date", "production_date", "best_before_date", "use_by_date", "prepared_at", "opened_at", "frozen_at", "thawed_at"] as const;
  const dates = replayProofDateKinds.map((kind) => ({
    kind,
    value: kind.endsWith("_at") ? proofInstant : "9999-12-31",
    source: {
      kind: "confirmed_recognition", confidence: "medium", reference: scalar.repeat(500), capturedAt: proofInstant,
      confirmedByUserId: uuid(4), sourceCommandId: uuid(51), sourceEventId: uuid(50),
      sourceExpectedLotVersion: beforeMaximum, sourceResultingLotVersion: maximum,
    },
  }));
  const binding = {
    kind: "bound", bindingDisplayLabel: scalar.repeat(120),
    concept: { datasetId: scalar.repeat(120), foodConceptId: uuid(5), entityRevision: maximum, releaseDigest: digest("c") },
    authority: "legacy_unverified",
  };
  const maximalInventoryEvent: any = {
    schemaVersion: 2, eventId: uuid(50), commandId: uuid(51), householdId: uuid(1), inventoryLotId: uuid(2), type: "corrected", source: "manual_confirmation", actorUserId: uuid(4), occurredAt: proofInstant,
    payload: { payloadKind: "corrected", targetEventId: uuid(52), rootEventId: uuid(53), changedAxes: ["binding", "quantity", "state", "dates", "seal_state", "storage", "safety"], beforeDates: dates, afterDates: dates },
    note: scalar.repeat(500), eventCoreDigest: digest("a"), sequence: maximum, expectedVersion: beforeMaximum, resultingVersion: maximum, recordedAt: proofInstant,
    previousEventDigest: digest("b"), resultingProjectionDigest: digest("d"), eventDigest: digest("e"),
  };
  const maximalSeasoningEvent: any = {
    schemaVersion: 1, eventId: uuid(50), commandId: uuid(54), type: "seasoning_observed", source: "manual_confirmation", householdId: uuid(1), seasoningId: uuid(3), actorUserId: uuid(4), observedAt: proofInstant,
    payload: { binding, before: "unknown", after: "unknown" }, eventCoreDigest: digest("a"), sequence: maximum, expectedVersion: beforeMaximum, resultingVersion: maximum, recordedAt: proofInstant,
    previousEventDigest: digest("b"), resultingProjectionDigest: digest("d"), eventDigest: digest("e"),
  };
  assert.equal(storedInventoryEventV2Schema.safeParse(maximalInventoryEvent).success, true);
  assert.equal(storedSeasoningEventV1Schema.safeParse(maximalSeasoningEvent).success, true);
  assert.equal(Buffer.byteLength(replayJson(maximalInventoryEvent)), STAGE09P_REPLAY_CHUNK_LIMITS.inventory.proof.maxCanonicalEventUtf8Bytes);
  assert.equal(Buffer.byteLength(replayJson(maximalSeasoningEvent)), STAGE09P_REPLAY_CHUNK_LIMITS.seasoning.proof.maxCanonicalEventUtf8Bytes);

  const inventoryBefore = 10_000 - inventoryMaxEventsPerChunkV2;
  const inventory = inventoryChunk("final", inventoryBefore, inventoryMaxEventsPerChunkV2, 10_000, digest("b"));
  inventory.events = Array.from({ length: inventoryMaxEventsPerChunkV2 }, (_, index) => {
    const sequence = inventoryBefore + index + 1;
    const event = structuredClone(maximalInventoryEvent);
    event.eventId = uuid(10_000 + index); event.commandId = uuid(20_000 + index);
    event.sequence = String(sequence); event.expectedVersion = String(sequence - 1); event.resultingVersion = String(sequence);
    event.previousEventDigest = index === 0 ? digest("b") : eventDigestFor(sequence - 1); event.eventDigest = eventDigestFor(sequence);
    return event;
  });
  inventory.terminalEventDigest = inventory.events.at(-1).eventDigest;
  const seasoningBefore = 10_000 - seasoningMaxEventsPerChunkV1;
  const seasoning = seasoningChunk("final", seasoningBefore, seasoningMaxEventsPerChunkV1, 10_000, digest("b"));
  seasoning.events = Array.from({ length: seasoningMaxEventsPerChunkV1 }, (_, index) => {
    const event = structuredClone(maximalSeasoningEvent); const sequence = seasoningBefore + index + 1;
    event.eventId = uuid(30_000 + index); event.commandId = uuid(50_000 + index);
    event.sequence = String(sequence); event.expectedVersion = String(sequence - 1); event.resultingVersion = String(sequence);
    event.previousEventDigest = index === 0 ? digest("b") : eventDigestFor(sequence - 1); event.eventDigest = eventDigestFor(sequence);
    return event;
  });
  seasoning.terminalEventDigest = seasoning.events.at(-1).eventDigest;

  for (const [domain, chunk, parse] of [
    ["inventory", inventory, parseInventoryReplayChunkInputV2],
    ["seasoning", seasoning, parseSeasoningReplayChunkInputV1],
  ] as const) {
    const text = replayJson(chunk);
    const eventArrayBytes = Buffer.byteLength(replayJson(chunk.events));
    const limits = STAGE09P_REPLAY_CHUNK_LIMITS[domain];
    assert.ok(Buffer.byteLength(text) <= limits.maxRawUtf8Bytes, `${domain} maximal chunk bytes`);
    assert.ok(Buffer.byteLength(text) >= 950_000, `${domain} proof must exercise a realistic near-cap chunk`);
    assert.ok(Buffer.byteLength(text) - eventArrayBytes <= limits.proof.maxEnvelopeUtf8Bytes, `${domain} envelope bytes`);
    assert.equal(jsonNumberPaths(chunk).every((entry) => entry.path.at(-1) === "schemaVersion"), true, `${domain} numeric field locations`);
    assert.equal(parse(text).ok, true, domain);
  }
});

const inventoryCoreFrom = (event: any): Record<string, unknown> => ({ schemaVersion: event.schemaVersion, eventId: event.eventId, commandId: event.commandId, householdId: event.householdId, inventoryLotId: event.inventoryLotId, type: event.type, source: event.source, actorUserId: event.actorUserId, occurredAt: event.occurredAt, payload: structuredClone(event.payload), note: event.note });

const dateTransitionFixture = () => {
  const firstDate = storedDate("purchase_date");
  const first = inventoryFixture([firstDate]);
  const nextDate: any = storedDate("purchase_date");
  nextDate.value = "2026-09-05";
  Object.assign(nextDate.source, { sourceCommandId: uuid(13), sourceEventId: uuid(12), sourceExpectedLotVersion: "1", sourceResultingLotVersion: "2" });
  const second: any = { ...structuredClone(first.event), eventId: uuid(12), commandId: uuid(13), type: "dates_changed", payload: { payloadKind: "dates_changed", beforeDates: [structuredClone(firstDate)], afterDates: [structuredClone(nextDate)] }, sequence: "2", expectedVersion: "1", resultingVersion: "2", previousEventDigest: digest("f"), resultingProjectionDigest: digest("d"), eventDigest: digest("b") };
  const aggregate: any = structuredClone(first.aggregate);
  aggregate.history.events.push(second);
  aggregate.projection.dates = [structuredClone(nextDate)]; aggregate.projection.version = "2"; aggregate.projection.lastEventSequence = "2"; aggregate.projection.projectionDigest = digest("d");
  return { first, firstDate, nextDate, second, aggregate };
};

test("Inventory date provenance closes every repeated field and deterministic date state", () => {
  const baseline = inventoryFixture([storedDate("production_date", "confirmed_recognition")]);
  assert.equal(inventoryAggregateV2Schema.safeParse(baseline.aggregate).success, true);
  const mutations: readonly [string, (date: any) => void][] = [
    ["kind", (date) => { date.kind = "best_before_date"; }],
    ["value", (date) => { date.value = "2099-12-31"; }],
    ["source.kind", (date) => { date.source.kind = "package_label"; }],
    ["source.confidence", (date) => { date.source.confidence = "medium"; }],
    ["source.reference", (date) => { date.source.reference = "other package"; }],
    ["source.capturedAt", (date) => { date.source.capturedAt = "2026-09-04T00:01:00.000Z"; }],
    ["source.confirmedByUserId", (date) => { date.source.confirmedByUserId = uuid(99); }],
    ["source.sourceCommandId", (date) => { date.source.sourceCommandId = uuid(99); }],
    ["source.sourceEventId", (date) => { date.source.sourceEventId = uuid(99); }],
    ["source.sourceExpectedLotVersion", (date) => { date.source.sourceExpectedLotVersion = "1"; }],
    ["source.sourceResultingLotVersion", (date) => { date.source.sourceResultingLotVersion = "2"; }],
  ];
  for (const [name, mutate] of mutations) {
    const candidate: any = structuredClone(baseline.aggregate); mutate(candidate.projection.dates[0]);
    assert.equal(inventoryAggregateV2Schema.safeParse(candidate).success, false, name);
  }

  const transition = dateTransitionFixture();
  assert.equal(inventoryHistoryV2Schema.safeParse(transition.aggregate.history).success, true);
  assert.equal(inventoryAggregateV2Schema.safeParse(transition.aggregate).success, true);
  const beforeMismatch: any = structuredClone(transition.aggregate.history); beforeMismatch.events[1].payload.beforeDates[0].value = "2026-09-03";
  assert.equal(inventoryHistoryV2Schema.safeParse(beforeMismatch).success, false);
  const afterOnly: any = structuredClone(transition.aggregate); afterOnly.history.events[1].payload.afterDates[0].value = "2026-09-06";
  assert.equal(inventoryHistoryV2Schema.safeParse(afterOnly.history).success, true);
  assert.equal(inventoryAggregateV2Schema.safeParse(afterOnly).success, false);
  const projectionOnly: any = structuredClone(transition.aggregate); projectionOnly.projection.dates[0].value = "2026-09-06";
  assert.equal(inventoryAggregateV2Schema.safeParse(projectionOnly).success, false);
  const removedButProjected: any = structuredClone(transition.aggregate); removedButProjected.history.events[1].payload.afterDates = [];
  assert.equal(inventoryHistoryV2Schema.safeParse(removedButProjected.history).success, true);
  assert.equal(inventoryAggregateV2Schema.safeParse(removedButProjected).success, false);
  removedButProjected.projection.dates = [];
  assert.equal(inventoryAggregateV2Schema.safeParse(removedButProjected).success, true);

  const decision: any = structuredClone(transition.first.decision);
  decision.eventCore = inventoryCoreFrom(transition.second); decision.event = structuredClone(transition.second); decision.next = structuredClone(transition.aggregate);
  Object.assign(decision.receipt, { commandType: "change_dates", eventType: "dates_changed", commandId: uuid(13), eventId: uuid(12), resultingVersion: "2", eventCoreDigest: digest("c"), eventDigest: digest("b"), projectionDigest: digest("d") });
  assert.equal(inventoryDecisionResultV2Schema.safeParse(decision).success, true);
  decision.next.projection.dates[0].value = "2099-12-31";
  assert.equal(inventoryDecisionResultV2Schema.safeParse(decision).success, false);
});

test("date-corrected events require and close explicit before/after snapshots", () => {
  const transition = dateTransitionFixture();
  const correctedDate: any = structuredClone(transition.nextDate);
  correctedDate.value = "2026-09-06";
  Object.assign(correctedDate.source, { sourceCommandId: uuid(15), sourceEventId: uuid(14), sourceExpectedLotVersion: "2", sourceResultingLotVersion: "3" });
  const corrected: any = { ...structuredClone(transition.second), eventId: uuid(14), commandId: uuid(15), type: "corrected", payload: { payloadKind: "corrected", targetEventId: uuid(12), rootEventId: uuid(12), changedAxes: ["dates"], beforeDates: [structuredClone(transition.nextDate)], afterDates: [structuredClone(correctedDate)] }, sequence: "3", expectedVersion: "2", resultingVersion: "3", previousEventDigest: digest("b"), resultingProjectionDigest: digest("c"), eventDigest: digest("d") };
  const aggregate: any = structuredClone(transition.aggregate); aggregate.history.events.push(corrected); aggregate.projection.dates = [structuredClone(correctedDate)]; aggregate.projection.version = "3"; aggregate.projection.lastEventSequence = "3"; aggregate.projection.projectionDigest = digest("c");
  assert.equal(inventoryHistoryV2Schema.safeParse(aggregate.history).success, true);
  assert.equal(inventoryAggregateV2Schema.safeParse(aggregate).success, true);

  for (const slot of ["beforeDates", "afterDates"] as const) {
    const missing: any = inventoryCoreFrom(corrected); delete missing.payload[slot];
    assert.equal(inventoryEventCoreV2Schema.safeParse(missing).success, false, `missing ${slot}`);
  }
  const undeclared: any = inventoryCoreFrom(corrected); undeclared.payload.changedAxes = ["quantity"];
  assert.equal(inventoryEventCoreV2Schema.safeParse(undeclared).success, false);
  const mismatch: any = structuredClone(aggregate.history); mismatch.events[2].payload.beforeDates[0].value = "2026-09-01";
  assert.equal(inventoryHistoryV2Schema.safeParse(mismatch).success, false);
});

const inventoryVersionInput = (value: unknown): Record<string, unknown> => ({ ...baseAcquire(), expectedVersion: value });
const seasoningVersionInput = (value: unknown) => ({ schemaVersion: 1, type: "observe_seasoning", source: "manual_confirmation", householdId: uuid(1), seasoningId: uuid(3), expectedVersion: value, observedAt: { mode: "server_time" }, binding: { kind: "unbound", bindingDisplayLabel: "salt" }, observation: "have" });

test("PgInt validation is total, bounded and preserves exact normalizer reasons", () => {
  const malformed: readonly unknown[] = ["not-a-number", "", "+1", "-1", "01", "1.0", "1e3", " 1", "1 ", "9".repeat(20), "9223372036854775808", 1, {}, null];
  for (const value of malformed) {
    assert.doesNotThrow(() => rawInventoryCommandBodyV2Schema.safeParse(inventoryVersionInput(value)));
    assert.doesNotThrow(() => rawSeasoningCommandBodyV1Schema.safeParse(seasoningVersionInput(value)));
    assert.equal(rawInventoryCommandBodyV2Schema.safeParse(inventoryVersionInput(value)).success, false);
    assert.equal(rawSeasoningCommandBodyV1Schema.safeParse(seasoningVersionInput(value)).success, false);
    assert.deepEqual(normalizeInventoryCommandBodyV2(inventoryVersionInput(value)), { ok: false, reason: { code: "INVENTORY_NORMALIZE_VERSION_INVALID", ordinal: 18_008 } });
    assert.deepEqual(normalizeSeasoningCommandBodyV1(seasoningVersionInput(value)), { ok: false, reason: { code: "SEASONING_NORMALIZE_VERSION_INVALID", ordinal: 19_008 } });

    const inventoryEvent: any = inventoryFixture().event;
    const seasoningDecision: any = seasoningDecisionFixture(false);
    for (const field of ["sequence", "expectedVersion", "resultingVersion"] as const) {
      const candidate = structuredClone(inventoryEvent); candidate[field] = value;
      assert.doesNotThrow(() => storedInventoryEventV2Schema.safeParse(candidate));
      assert.equal(storedInventoryEventV2Schema.safeParse(candidate).success, false);
      const seasoningCandidate = structuredClone(seasoningDecision.event); seasoningCandidate[field] = value;
      assert.doesNotThrow(() => storedSeasoningEventV1Schema.safeParse(seasoningCandidate));
      assert.equal(storedSeasoningEventV1Schema.safeParse(seasoningCandidate).success, false);
    }
    const lot: any = structuredClone(inventoryFixture().projection); lot.version = value;
    assert.doesNotThrow(() => inventoryLotV2Schema.safeParse(lot)); assert.equal(inventoryLotV2Schema.safeParse(lot).success, false);
    const seasoningProjection: any = structuredClone(seasoningDecision.next.projection); seasoningProjection.version = value;
    assert.doesNotThrow(() => seasoningProjectionV1Schema.safeParse(seasoningProjection)); assert.equal(seasoningProjectionV1Schema.safeParse(seasoningProjection).success, false);
    const inventoryBound: any = structuredClone(inventoryEvent); inventoryBound.payload.foodConceptBinding = { kind: "bound", bindingDisplayLabel: "rice", concept: { datasetId: "dataset", foodConceptId: uuid(5), entityRevision: value, releaseDigest: digest("a") }, authority: "caller_claimed" };
    assert.doesNotThrow(() => storedInventoryEventV2Schema.safeParse(inventoryBound)); assert.equal(storedInventoryEventV2Schema.safeParse(inventoryBound).success, false);
    const seasoningBound: any = structuredClone(seasoningDecision.event); seasoningBound.payload.binding = { kind: "bound", bindingDisplayLabel: "salt", concept: { datasetId: "dataset", foodConceptId: uuid(5), entityRevision: value, releaseDigest: digest("a") }, authority: "caller_claimed" };
    assert.doesNotThrow(() => storedSeasoningEventV1Schema.safeParse(seasoningBound)); assert.equal(storedSeasoningEventV1Schema.safeParse(seasoningBound).success, false);
    const inventoryReceipt: any = structuredClone(inventoryFixture().decision); inventoryReceipt.receipt.resultingVersion = value;
    assert.doesNotThrow(() => inventoryDecisionResultV2Schema.safeParse(inventoryReceipt)); assert.equal(inventoryDecisionResultV2Schema.safeParse(inventoryReceipt).success, false);
    const seasoningReceipt: any = structuredClone(seasoningDecision); seasoningReceipt.receipt.resultingVersion = value;
    assert.doesNotThrow(() => seasoningDecisionResultV1Schema.safeParse(seasoningReceipt)); assert.equal(seasoningDecisionResultV1Schema.safeParse(seasoningReceipt).success, false);
  }

  const maximum = "9223372036854775807"; const beforeMaximum = "9223372036854775806";
  assert.equal(rawInventoryCommandBodyV2Schema.safeParse(inventoryVersionInput(maximum)).success, true);
  assert.equal(rawSeasoningCommandBodyV1Schema.safeParse(seasoningVersionInput(maximum)).success, true);
  const event: any = inventoryFixture().event; Object.assign(event, { expectedVersion: beforeMaximum, resultingVersion: maximum, previousEventDigest: digest("a") });
  assert.equal(storedInventoryEventV2Schema.safeParse(event).success, true);
  Object.assign(event, { expectedVersion: maximum, resultingVersion: "9223372036854775808" });
  assert.doesNotThrow(() => storedInventoryEventV2Schema.safeParse(event)); assert.equal(storedInventoryEventV2Schema.safeParse(event).success, false);
  const zeroLot: any = structuredClone(inventoryFixture().projection); zeroLot.version = "0";
  const maxLot: any = structuredClone(inventoryFixture().projection); maxLot.version = maximum;
  assert.equal(inventoryLotV2Schema.safeParse(zeroLot).success, false); assert.equal(inventoryLotV2Schema.safeParse(maxLot).success, true);
});

test("every public M2 schema and both normalizers are no-throw for representative unknown inputs", () => {
  const entries: readonly [string, unknown][] = [...Object.entries(inventoryV2Public), ...Object.entries(seasoningV1Public)];
  const schemas = entries.flatMap(([name, value]) => name.endsWith("Schema") && typeof (value as { safeParse?: unknown })?.safeParse === "function" ? [[name, value as { safeParse: (input: unknown) => unknown }] as const] : []);
  const unknowns: readonly unknown[] = [undefined, null, false, 0, -0, Number.NaN, "", "not-a-number", [], {}, { expectedVersion: "not-a-number" }, { sequence: "1e3", resultingVersion: "+2" }];
  for (const [name, schema] of schemas) for (const value of unknowns) assert.doesNotThrow(() => schema.safeParse(value), `${name} on ${String(value)}`);
  for (const value of unknowns) {
    assert.doesNotThrow(() => normalizeInventoryCommandBodyV2(value));
    assert.doesNotThrow(() => normalizeSeasoningCommandBodyV1(value));
  }
});

const inventoryObservedAt = (value: string): Record<string, unknown> => ({ ...baseAcquire(), observedAt: { mode: "observed", value } });
const seasoningObservedAt = (value: string) => ({ ...seasoningVersionInput("0"), observedAt: { mode: "observed", value } });

test("raw and canonical instants share the closed UTC year 0001 through 9999", () => {
  const lowerCrossing = "0001-01-01T00:00:00+01:00"; const upperCrossing = "9999-12-31T23:59:59-01:00";
  for (const value of [lowerCrossing, upperCrossing]) {
    assert.equal(rawInventoryCommandBodyV2Schema.safeParse(inventoryObservedAt(value)).success, false);
    assert.equal(rawSeasoningCommandBodyV1Schema.safeParse(seasoningObservedAt(value)).success, false);
    assert.deepEqual(normalizeInventoryCommandBodyV2(inventoryObservedAt(value)), { ok: false, reason: { code: "INVENTORY_NORMALIZE_OCCURRENCE_INVALID", ordinal: 18_009 } });
    assert.deepEqual(normalizeSeasoningCommandBodyV1(seasoningObservedAt(value)), { ok: false, reason: { code: "SEASONING_NORMALIZE_OBSERVED_AT_INVALID", ordinal: 19_009 } });
  }
  for (const value of ["0000-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z", "10000-01-01T00:00:00.000Z", "2025-02-29T00:00:00.000Z", "2026-01-01T00:00:00Z"]) {
    assert.equal(normalizedInventoryCommandBodyV2Schema.safeParse(inventoryObservedAt(value)).success, false, value);
    assert.equal(normalizedSeasoningCommandBodyV1Schema.safeParse(seasoningObservedAt(value)).success, false, value);
  }
  const inventoryStored: any = inventoryFixture().event; inventoryStored.occurredAt = "0000-01-01T00:00:00.000Z";
  const inventoryLot: any = inventoryFixture().projection; inventoryLot.createdAt = "10000-01-01T00:00:00.000Z";
  const seasoningStored: any = seasoningDecisionFixture(false).event; seasoningStored.observedAt = "0000-01-01T00:00:00.000Z";
  const seasoningProjection: any = seasoningDecisionFixture(false).next.projection; seasoningProjection.observedAt = "10000-01-01T00:00:00.000Z";
  assert.equal(storedInventoryEventV2Schema.safeParse(inventoryStored).success, false);
  assert.equal(inventoryLotV2Schema.safeParse(inventoryLot).success, false);
  assert.equal(storedSeasoningEventV1Schema.safeParse(seasoningStored).success, false);
  assert.equal(seasoningProjectionV1Schema.safeParse(seasoningProjection).success, false);
  const valid: readonly [string, string][] = [
    ["0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000Z"],
    ["9999-12-31T23:59:59Z", "9999-12-31T23:59:59.000Z"],
    ["2000-03-01T00:00:00+23:59", "2000-02-29T00:01:00.000Z"],
    ["2026-09-04T00:00:00.1Z", "2026-09-04T00:00:00.100Z"],
  ];
  for (const [rawValue, canonical] of valid) {
    const inventory = normalizeInventoryCommandBodyV2(inventoryObservedAt(rawValue)); const seasoning = normalizeSeasoningCommandBodyV1(seasoningObservedAt(rawValue));
    assert.equal(inventory.ok, true, rawValue); assert.equal(seasoning.ok, true, rawValue);
    if (inventory.ok && inventory.value.observedAt.mode === "observed") assert.equal(inventory.value.observedAt.value, canonical);
    if (seasoning.ok && seasoning.value.observedAt.mode === "observed") assert.equal(seasoning.value.observedAt.value, canonical);
  }
  const dateOperation = rawCommandBase("change_dates", { changes: [{ operation: "set", date: { kind: "opened_at", value: upperCrossing, source: { kind: "user_input", confidence: "high", reference: null } } }] });
  assert.deepEqual(normalizeInventoryCommandBodyV2(dateOperation), { ok: false, reason: { code: "INVENTORY_NORMALIZE_DATE_VALUE_INVALID", ordinal: 18_029 } });
});
