import { z } from "zod";

import {
  foodConceptIdSchema,
  householdIdSchema,
  inventoryEventIdSchema,
  inventoryLotIdSchema,
  postgresTextSchema,
  userIdSchema,
} from "./primitives.js";
import {
  createContractRuleSchemaRegistry,
  type ContractRuleSchemaBinding,
} from "./contract-rule-registry.js";
import type { ContractRule } from "./refinement-rules.js";
import { canonicalizeStage09pInstant, copyStage09pInput, deepFreezeStage09pOwnedData, type DeepReadonly, isSafeRecord, isStage09pGregorianDate, isStage09pPgInt, isStage09pPgIntSuccessor, isStage09pRawInstant, isStage09pSchemaInputDataGraph, maxInventoryReplayEventsPerChunk, maxReplayChunkUtf8Bytes, maxTotalReplayEvents, parseStage09pReplayChunkJsonText, readSafeOwn } from "./stage09p-input.js";

export const inventoryV2ContractRuleManifest = [
  { id: "inventory.v2.pgint-range.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 PgInt does not exceed the PostgreSQL bigint maximum" },
  { id: "inventory.v2.positive-pgint-range.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 positive PgInt does not exceed the PostgreSQL bigint maximum" },
  { id: "inventory.v2.local-date-gregorian.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 local dates are real Gregorian calendar dates" },
  { id: "inventory.v2.raw-instant-components.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 raw instants have valid components and normalize inside UTC years 0001 through 9999" },
  { id: "inventory.v2.event-core-date-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 event cores carry unique date kinds and explicit snapshots for date corrections" },
  { id: "inventory.v2.raw-command-cross-field.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 raw commands obey date, creation and correction relations" },
  { id: "inventory.v2.normalized-command-cross-field.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 normalized commands use canonical array order" },
  { id: "inventory.v2.lot-invariants.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 lots obey quantity, lifecycle and fail-closed safety invariants" },
  { id: "inventory.v2.stored-event-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 stored event counters and chain nullability are consistent" },
  { id: "inventory.v2.history-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 history has contiguous links and closed date-state provenance" },
  { id: "inventory.v2.aggregate-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 present aggregate correlates scope, projection tip and current date facts" },
  { id: "inventory.v2.decision-correlation.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Inventory V2 decisions correlate core, event, receipt, projection and history" },
  { id: "inventory.v2.replay-chunk-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "one caller-supplied Inventory V2 replay chunk has locally consistent scope, order, count, digest and finalization; it does not attest cross-request truth" },
  { id: "inventory.v2.replay-server-checkpoint-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "an Inventory V2 server-verified replay checkpoint has locally consistent count, continuation and finalization state" },
  { id: "inventory.v2.replay-chunk-result-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "an Inventory V2 replay result kind agrees with the status of its server-verified checkpoint" },
] as const satisfies readonly ContractRule[];

export type InventoryV2ContractRuleId = (typeof inventoryV2ContractRuleManifest)[number]["id"];
const inventoryV2ContractRuleRegistry = createContractRuleSchemaRegistry(inventoryV2ContractRuleManifest);
const { ruleRefine, ruleSuperRefine } = inventoryV2ContractRuleRegistry;

export const m2ContractSchemaVersion = "inventory-v2" as const;
export const INVENTORY_HISTORY_MAX_V2 = 10_000 as const;
export const inventoryMaxReplayChunkUtf8BytesV2 = maxReplayChunkUtf8Bytes;
export const inventoryMaxEventsPerChunkV2 = maxInventoryReplayEventsPerChunk;
export const inventoryMaxTotalReplayEventsV2 = maxTotalReplayEvents;
export const inventoryReplayChunkLimitsV2 = Object.freeze({ maxReplayChunkUtf8Bytes: inventoryMaxReplayChunkUtf8BytesV2, maxEventsPerChunk: inventoryMaxEventsPerChunkV2, maxTotalReplayEvents: inventoryMaxTotalReplayEventsV2 });

type ReasonRow<C extends string = string, O extends number = number> =
  Readonly<{ code: C; ordinal: O }>;
const makeReasonSchema = <const R extends readonly [ReasonRow, ReasonRow, ...ReasonRow[]]>(
  rows: R,
): z.ZodType<R[number]> => {
  const first = rows[0];
  const second = rows[1];
  const tail = rows.slice(2).map((row) => z.strictObject({ code: z.literal(row.code), ordinal: z.literal(row.ordinal) }));
  const options = [
    z.strictObject({ code: z.literal(first.code), ordinal: z.literal(first.ordinal) }),
    z.strictObject({ code: z.literal(second.code), ordinal: z.literal(second.ordinal) }),
    ...tail,
  ] as [z.ZodType<R[number]>, z.ZodType<R[number]>, ...z.ZodType<R[number]>[]];
  return z.union(options);
};

export const inventoryNormalizationReasonRows = Object.freeze([
  { code: "INVENTORY_NORMALIZE_INPUT_DESCRIPTOR_INVALID", ordinal: 18_000 },
  { code: "INVENTORY_NORMALIZE_BODY_NOT_OBJECT", ordinal: 18_001 },
  { code: "INVENTORY_NORMALIZE_TOP_LEVEL_UNKNOWN_KEY", ordinal: 18_002 },
  { code: "INVENTORY_NORMALIZE_SCHEMA_VERSION_INVALID", ordinal: 18_003 },
  { code: "INVENTORY_NORMALIZE_COMMAND_TYPE_MISSING", ordinal: 18_004 },
  { code: "INVENTORY_NORMALIZE_COMMAND_TYPE_UNSUPPORTED", ordinal: 18_005 },
  { code: "INVENTORY_NORMALIZE_SOURCE_INVALID", ordinal: 18_006 },
  { code: "INVENTORY_NORMALIZE_SCOPE_INVALID", ordinal: 18_007 },
  { code: "INVENTORY_NORMALIZE_VERSION_INVALID", ordinal: 18_008 },
  { code: "INVENTORY_NORMALIZE_OCCURRENCE_INVALID", ordinal: 18_009 },
  { code: "INVENTORY_NORMALIZE_NOTE_INVALID", ordinal: 18_010 },
  { code: "INVENTORY_NORMALIZE_PAYLOAD_NOT_OBJECT", ordinal: 18_011 },
  { code: "INVENTORY_NORMALIZE_PAYLOAD_UNKNOWN_KEY", ordinal: 18_012 },
  { code: "INVENTORY_NORMALIZE_REQUIRED_FIELD_MISSING", ordinal: 18_013 },
  { code: "INVENTORY_NORMALIZE_NULL_NOT_ALLOWED", ordinal: 18_014 },
  { code: "INVENTORY_NORMALIZE_TEXT_INVALID", ordinal: 18_015 },
  { code: "INVENTORY_NORMALIZE_QUANTITY_KIND_INVALID", ordinal: 18_016 },
  { code: "INVENTORY_NORMALIZE_DECIMAL_NONFINITE", ordinal: 18_017 },
  { code: "INVENTORY_NORMALIZE_DECIMAL_TYPE_INVALID", ordinal: 18_018 },
  { code: "INVENTORY_NORMALIZE_DECIMAL_SYNTAX_INVALID", ordinal: 18_019 },
  { code: "INVENTORY_NORMALIZE_DECIMAL_ZERO_FORBIDDEN", ordinal: 18_020 },
  { code: "INVENTORY_NORMALIZE_DECIMAL_RANGE_EXCEEDED", ordinal: 18_021 },
  { code: "INVENTORY_NORMALIZE_UNIT_INVALID", ordinal: 18_022 },
  { code: "INVENTORY_NORMALIZE_CONFIDENCE_INVALID", ordinal: 18_023 },
  { code: "INVENTORY_NORMALIZE_DATE_KIND_UNSUPPORTED_CURRENT_VERSION", ordinal: 18_024 },
  { code: "INVENTORY_NORMALIZE_DATE_OPERATION_LIMIT_EXCEEDED", ordinal: 18_025 },
  { code: "INVENTORY_NORMALIZE_DATE_OPERATION_DUPLICATE", ordinal: 18_026 },
  { code: "INVENTORY_NORMALIZE_DATE_KIND_INVALID", ordinal: 18_027 },
  { code: "INVENTORY_NORMALIZE_DATE_KIND_NOT_ALLOWED_FOR_COMMAND", ordinal: 18_028 },
  { code: "INVENTORY_NORMALIZE_DATE_VALUE_INVALID", ordinal: 18_029 },
  { code: "INVENTORY_NORMALIZE_DATE_SOURCE_INVALID", ordinal: 18_030 },
  { code: "INVENTORY_NORMALIZE_DATE_REFERENCE_INVALID", ordinal: 18_031 },
  { code: "INVENTORY_NORMALIZE_ARRAY_ITEM_INVALID", ordinal: 18_032 },
  { code: "INVENTORY_NORMALIZE_INITIAL_OBSERVATION_INVALID", ordinal: 18_033 },
  { code: "INVENTORY_NORMALIZE_INITIAL_STATE_CONFLICT", ordinal: 18_034 },
  { code: "INVENTORY_NORMALIZE_BINDING_INVALID", ordinal: 18_035 },
  { code: "INVENTORY_NORMALIZE_CORRECTION_TARGET_INVALID", ordinal: 18_036 },
  { code: "INVENTORY_NORMALIZE_CORRECTION_INTENTS_EMPTY", ordinal: 18_037 },
  { code: "INVENTORY_NORMALIZE_CORRECTION_INTENT_LIMIT_EXCEEDED", ordinal: 18_038 },
  { code: "INVENTORY_NORMALIZE_CORRECTION_AXIS_DUPLICATE", ordinal: 18_039 },
  { code: "INVENTORY_NORMALIZE_CORRECTION_AXIS_INVALID", ordinal: 18_040 },
  { code: "INVENTORY_NORMALIZE_CORRECTION_GUARD_INVALID", ordinal: 18_041 },
  { code: "INVENTORY_NORMALIZE_CORRECTION_AFTER_INVALID", ordinal: 18_042 },
  { code: "INVENTORY_NORMALIZE_QUALITATIVE_LEVEL_INVALID", ordinal: 18_043 },
  { code: "INVENTORY_NORMALIZE_INPUT_RESOURCE_LIMIT_EXCEEDED", ordinal: 18_044 },
] as const);
export const inventoryCommandReasonRows = Object.freeze([
  { code: "INVENTORY_COMMAND_EXPECTED_ABSENT", ordinal: 20_000 },
  { code: "INVENTORY_COMMAND_EXPECTED_PRESENT", ordinal: 20_001 },
  { code: "INVENTORY_COMMAND_SCOPE_MISMATCH", ordinal: 20_002 },
  { code: "INVENTORY_COMMAND_VERSION_CONFLICT", ordinal: 20_003 },
  { code: "INVENTORY_COMMAND_HISTORY_CAPACITY_EXCEEDED", ordinal: 20_004 },
  { code: "INVENTORY_COMMAND_COUNTER_OVERFLOW", ordinal: 20_005 },
] as const);
export const inventoryHistoryReasonRows = Object.freeze([
  { code: "INVENTORY_HISTORY_SHAPE_INVALID", ordinal: 21_000 },
  { code: "INVENTORY_HISTORY_FIRST_EVENT_INVALID", ordinal: 21_001 },
  { code: "INVENTORY_HISTORY_SCOPE_MISMATCH", ordinal: 21_002 },
  { code: "INVENTORY_HISTORY_SEQUENCE_BREAK", ordinal: 21_003 },
  { code: "INVENTORY_HISTORY_VERSION_BREAK", ordinal: 21_004 },
  { code: "INVENTORY_HISTORY_DIGEST_CHAIN_BREAK", ordinal: 21_005 },
  { code: "INVENTORY_HISTORY_CAPACITY_EXCEEDED", ordinal: 21_006 },
  { code: "INVENTORY_HISTORY_PROJECTION_MISMATCH", ordinal: 21_007 },
] as const);
export const inventoryReplayReasonRows = Object.freeze([
  { code: "INVENTORY_REPLAY_INPUT_DESCRIPTOR_INVALID", ordinal: 22_000 },
  { code: "INVENTORY_REPLAY_INPUT_SHAPE_INVALID", ordinal: 22_001 },
  { code: "INVENTORY_REPLAY_HISTORY_CAPACITY_EXCEEDED", ordinal: 22_002 },
  { code: "INVENTORY_REPLAY_EVENT_SHAPE_INVALID", ordinal: 22_003 },
  { code: "INVENTORY_REPLAY_SCOPE_MISMATCH", ordinal: 22_004 },
  { code: "INVENTORY_REPLAY_BEFORE_MISMATCH", ordinal: 22_005 },
  { code: "INVENTORY_REPLAY_INPUT_RESOURCE_LIMIT_EXCEEDED", ordinal: 22_006 },
  { code: "INVENTORY_REPLAY_WIRE_BYTE_CAPACITY_EXCEEDED", ordinal: 22_007 },
  { code: "INVENTORY_REPLAY_CHUNK_EVENT_CAPACITY_EXCEEDED", ordinal: 22_008 },
  { code: "INVENTORY_REPLAY_TOTAL_HISTORY_CAPACITY_EXCEEDED", ordinal: 22_009 },
  { code: "INVENTORY_REPLAY_CHUNK_SEQUENCE_OR_ORDER_INVALID", ordinal: 22_010 },
  { code: "INVENTORY_REPLAY_PREVIOUS_EVENT_DIGEST_MISMATCH", ordinal: 22_011 },
  { code: "INVENTORY_REPLAY_CHECKPOINT_MISMATCH", ordinal: 22_012 },
  { code: "INVENTORY_REPLAY_FINALIZATION_INVALID", ordinal: 22_013 },
  { code: "INVENTORY_REPLAY_TERMINAL_EVENT_DIGEST_MISMATCH", ordinal: 22_014 },
  { code: "INVENTORY_REPLAY_CANONICAL_NUMBER_INVALID", ordinal: 22_015 },
  { code: "INVENTORY_REPLAY_JSON_SYNTAX_INVALID", ordinal: 22_016 },
] as const);

export const inventoryV2ReasonRows = Object.freeze([
  ...inventoryNormalizationReasonRows,
  ...inventoryCommandReasonRows,
  ...inventoryHistoryReasonRows,
  ...inventoryReplayReasonRows,
] as const);
for (const row of inventoryV2ReasonRows) Object.freeze(row);
const assertUniqueReasons = (rows: readonly ReasonRow[]): void => {
  if (new Set(rows.map((row) => row.code)).size !== rows.length) throw new TypeError("DUPLICATE_REASON_CODE");
  if (new Set(rows.map((row) => row.ordinal)).size !== rows.length) throw new TypeError("DUPLICATE_REASON_ORDINAL");
};
assertUniqueReasons(inventoryV2ReasonRows);

export const inventoryNormalizationReasonV2Schema = makeReasonSchema(inventoryNormalizationReasonRows);
export const inventoryCommandReasonV2Schema = makeReasonSchema(inventoryCommandReasonRows);
export const inventoryHistoryReasonV2Schema = makeReasonSchema(inventoryHistoryReasonRows);
export const inventoryReplayReasonV2Schema = makeReasonSchema(inventoryReplayReasonRows);
export type InventoryNormalizationReasonV2DTO = z.infer<typeof inventoryNormalizationReasonV2Schema>;
export type InventoryCommandReasonV2DTO = z.infer<typeof inventoryCommandReasonV2Schema>;
export type InventoryHistoryReasonV2DTO = z.infer<typeof inventoryHistoryReasonV2Schema>;
export type InventoryReplayReasonV2DTO = z.infer<typeof inventoryReplayReasonV2Schema>;
const inventoryReason = <R extends readonly ReasonRow[]>(rows: R, code: R[number]["code"]): R[number] => {
  const found = rows.find((row) => row.code === code);
  if (found === undefined) throw new TypeError("UNKNOWN_INVENTORY_REASON");
  return found;
};

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const commandIdSchema = z.uuidv7().brand<"InventoryCommandIdV2">();
const pgIntSchema = ruleRefine(z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/), "inventory.v2.pgint-range.v1", "pgIntV2Schema", (v) => isStage09pPgInt(v));
const positivePgIntSchema = ruleRefine(z.string().regex(/^[1-9][0-9]{0,18}$/), "inventory.v2.positive-pgint-range.v1", "positivePgIntV2Schema", (v) => isStage09pPgInt(v, true));
const rawPositiveDecimal = z.string().regex(/^(?!0(?:\.0{1,6})?$)(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,6})?$/);
const rawNonnegativeDecimal = z.string().regex(/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,6})?$/);
const canonicalPositiveDecimal = z.string().regex(/^(?:[1-9][0-9]{0,8}|0\.[0-9]{0,5}[1-9]|[1-9][0-9]{0,8}\.[0-9]{0,5}[1-9])$/);
const canonicalNonnegativeDecimal = z.union([z.literal("0"), canonicalPositiveDecimal]);
const confidence = z.enum(["high", "medium", "low"]);
const storage = z.enum(["pantry", "refrigerated", "frozen", "other"]);
const nonFrozenStorage = z.enum(["pantry", "refrigerated", "other"]);
const unit = postgresTextSchema(1, 32);
const original = postgresTextSchema(1, 200);
const dateReference = postgresTextSchema(1, 500);

const localDate = ruleRefine(z.iso.date(), "inventory.v2.local-date-gregorian.v1", "strictLocalDateV2Schema", isStage09pGregorianDate);
const rawInstant = ruleRefine(z.iso.datetime({ offset: true }), "inventory.v2.raw-instant-components.v1", "rawInstantV2Schema", isStage09pRawInstant);
const canonicalInstant = z.iso.datetime().regex(/^(?!0000-)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const occurrence = <S extends z.ZodType>(s: S) => z.union([z.strictObject({ mode: z.literal("server_time") }), z.strictObject({ mode: z.literal("observed"), value: s })]);
const rawOccurrence = occurrence(rawInstant);
const normalizedOccurrence = occurrence(canonicalInstant);

const concept = z.strictObject({ datasetId: postgresTextSchema(1, 120), foodConceptId: foodConceptIdSchema, entityRevision: positivePgIntSchema, releaseDigest: digestSchema });
const binding = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("unbound"), bindingDisplayLabel: postgresTextSchema(1, 120) }), z.strictObject({ kind: z.literal("bound"), bindingDisplayLabel: postgresTextSchema(1, 120), concept })]);
const storedBinding = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("unbound"), bindingDisplayLabel: postgresTextSchema(1, 120) }), z.strictObject({ kind: z.literal("bound"), bindingDisplayLabel: postgresTextSchema(1, 120), concept, authority: z.enum(["caller_claimed", "legacy_unverified"]) })]);

const writable = <S extends z.ZodType>(amount: S) => z.union([z.strictObject({ kind: z.literal("exact"), amount, unit, originalText: original.nullable() }), z.strictObject({ kind: z.literal("approximate"), amount, unit, confidence, originalText: original }), z.strictObject({ kind: z.literal("qualitative"), level: z.enum(["plenty", "some", "low", "unknown"]), originalText: original.nullable() })]);
const projectionQuantity = <S extends z.ZodType>(amount: S) => z.union([z.strictObject({ kind: z.literal("exact"), amount, unit, originalText: original.nullable() }), z.strictObject({ kind: z.literal("approximate"), amount, unit, confidence, originalText: original }), z.strictObject({ kind: z.literal("qualitative"), level: z.enum(["plenty", "some", "low", "empty", "unknown"]), originalText: original.nullable() })]);
const rawWritable = writable(rawPositiveDecimal); const normalizedWritable = writable(canonicalPositiveDecimal); const normalizedProjectionQuantity = projectionQuantity(canonicalNonnegativeDecimal);
const consumption = <S extends z.ZodType>(amount: S) => z.union([z.strictObject({ kind: z.literal("exact"), amount, unit, originalText: original.nullable() }), z.strictObject({ kind: z.literal("approximate"), amount, unit, confidence, originalText: original }), z.strictObject({ kind: z.literal("qualitative"), mode: z.literal("remaining_level"), remainingLevel: z.enum(["plenty", "some", "low", "unknown"]), originalText: original.nullable() }), z.strictObject({ kind: z.literal("qualitative"), mode: z.literal("all"), originalText: original.nullable() })]);
const rawConsumption = consumption(rawPositiveDecimal); const normalizedConsumption = consumption(canonicalPositiveDecimal);

const packageSource = z.strictObject({ kind: z.literal("package_label"), confidence, reference: dateReference });
const userSource = z.strictObject({ kind: z.literal("user_input"), confidence, reference: dateReference.nullable() });
const recognitionSource = z.strictObject({ kind: z.literal("confirmed_recognition"), confidence, reference: dateReference });
const dateBranch = <const K extends string, V extends z.ZodType, S extends z.ZodType>(kind: K, value: V, source: S) => z.strictObject({ kind: z.literal(kind), value, source });
const callerDate = <I extends z.ZodType>(inst: I) => ({ purchase_date: dateBranch("purchase_date", localDate, z.union([userSource, recognitionSource])), production_date: dateBranch("production_date", localDate, z.union([packageSource, userSource, recognitionSource])), best_before_date: dateBranch("best_before_date", localDate, z.union([packageSource, userSource, recognitionSource])), use_by_date: dateBranch("use_by_date", localDate, z.union([packageSource, userSource, recognitionSource])), prepared_at: dateBranch("prepared_at", inst, z.union([userSource, recognitionSource])), opened_at: dateBranch("opened_at", inst, z.union([userSource, recognitionSource])), frozen_at: dateBranch("frozen_at", inst, z.union([userSource, recognitionSource])), thawed_at: dateBranch("thawed_at", inst, z.union([userSource, recognitionSource])) });
const rawDates = callerDate(rawInstant); const normalizedDates = callerDate(canonicalInstant);
const rawCallerDate = z.union(Object.values(rawDates) as [typeof rawDates.purchase_date, typeof rawDates.production_date, ...z.ZodType[]]);
const normalizedCallerDate = z.union(Object.values(normalizedDates) as [typeof normalizedDates.purchase_date, typeof normalizedDates.production_date, ...z.ZodType[]]);
const observation = <S extends z.ZodType>(date: S) => z.union([z.strictObject({ knowledge: z.literal("unknown") }), z.strictObject({ knowledge: z.literal("known"), mode: z.literal("command_time") }), z.strictObject({ knowledge: z.literal("known"), mode: z.literal("observed"), date })]);
const rawObs = { prepared: observation(rawDates.prepared_at), opened: observation(rawDates.opened_at), frozen: observation(rawDates.frozen_at), thawed: observation(rawDates.thawed_at) };
const normObs = { prepared: observation(normalizedDates.prepared_at), opened: observation(normalizedDates.opened_at), frozen: observation(normalizedDates.frozen_at), thawed: observation(normalizedDates.thawed_at) };
const initialOpened = <S extends z.ZodType>(o: S) => z.union([z.strictObject({ state: z.literal("sealed") }), z.strictObject({ state: z.literal("opened"), at: o })]);
const initialFrozen = <S extends z.ZodType>(o: S) => z.union([z.strictObject({ state: z.literal("not_frozen") }), z.strictObject({ state: z.literal("frozen"), at: o })]);
const dateKind = z.enum(["purchase_date", "production_date", "best_before_date", "use_by_date", "prepared_at", "opened_at", "frozen_at", "thawed_at"]);
const metadataChange = <S extends z.ZodType>(setDate: S) => z.union([z.strictObject({ operation: z.literal("set"), date: setDate }), z.strictObject({ operation: z.literal("remove"), kind: dateKind })]);
const rawMeta = metadataChange(z.union([rawDates.purchase_date, rawDates.production_date, rawDates.best_before_date, rawDates.use_by_date, rawDates.prepared_at]));
const normMeta = metadataChange(z.union([normalizedDates.purchase_date, normalizedDates.production_date, normalizedDates.best_before_date, normalizedDates.use_by_date, normalizedDates.prepared_at]));
const guard = <const A extends string>(axis: A) => z.strictObject({ axis: z.literal(axis), currentMaterialDigest: digestSchema });
const correctionIntent = <Q extends z.ZodType, D extends z.ZodType>(quantity: Q, date: D) => z.union([z.strictObject({ axis: z.literal("binding"), guard: guard("binding"), after: binding }), z.strictObject({ axis: z.literal("quantity"), guard: guard("quantity"), after: quantity }), z.strictObject({ axis: z.literal("state"), guard: guard("state"), after: z.enum(["active", "depleted", "discarded"]) }), z.strictObject({ axis: z.literal("dates"), guard: guard("dates"), changes: z.array(metadataChange(date)).min(1).max(8) }), z.strictObject({ axis: z.literal("seal_state"), guard: guard("seal_state"), after: z.enum(["sealed", "opened"]) }), z.strictObject({ axis: z.literal("storage"), guard: guard("storage"), after: storage })]);
const rawCorrectionIntent = correctionIntent(projectionQuantity(rawNonnegativeDecimal), rawCallerDate); const normCorrectionIntent = correctionIntent(normalizedProjectionQuantity, normalizedCallerDate);

const rawPayload = { acquire: z.strictObject({ lotDisplayName: postgresTextSchema(1, 120), binding, storageLocation: storage, quantity: rawWritable, dates: z.array(z.union([rawDates.purchase_date, rawDates.production_date, rawDates.best_before_date, rawDates.use_by_date])).max(4), initialOpened: initialOpened(rawObs.opened), initialFrozen: initialFrozen(rawObs.frozen) }), produce: z.strictObject({ lotDisplayName: postgresTextSchema(1, 120), binding, storageLocation: storage, quantity: rawWritable, dates: z.array(z.union([rawDates.production_date, rawDates.best_before_date, rawDates.use_by_date])).max(3), preparedAt: rawObs.prepared, initialOpened: initialOpened(rawObs.opened), initialFrozen: initialFrozen(rawObs.frozen) }), open: z.strictObject({ openedAt: rawObs.opened }), consume: z.strictObject({ consumption: rawConsumption }), discard: z.strictObject({ reason: postgresTextSchema(1, 500).nullable() }), move: z.strictObject({ destination: nonFrozenStorage }), freeze: z.strictObject({ frozenAt: rawObs.frozen }), thaw: z.strictObject({ destination: nonFrozenStorage, thawedAt: rawObs.thawed }), adjust: z.strictObject({ quantity: rawWritable }), change_dates: z.strictObject({ changes: z.array(rawMeta).min(1).max(8) }), change_food_concept_binding: z.strictObject({ binding }), correct: z.strictObject({ targetEventId: inventoryEventIdSchema, intents: z.array(rawCorrectionIntent).min(1).max(6) }) };
const normalizedPayload = { acquire: z.strictObject({ lotDisplayName: postgresTextSchema(1, 120), binding, storageLocation: storage, quantity: normalizedWritable, dates: z.array(z.union([normalizedDates.purchase_date, normalizedDates.production_date, normalizedDates.best_before_date, normalizedDates.use_by_date])).max(4), initialOpened: initialOpened(normObs.opened), initialFrozen: initialFrozen(normObs.frozen) }), produce: z.strictObject({ lotDisplayName: postgresTextSchema(1, 120), binding, storageLocation: storage, quantity: normalizedWritable, dates: z.array(z.union([normalizedDates.production_date, normalizedDates.best_before_date, normalizedDates.use_by_date])).max(3), preparedAt: normObs.prepared, initialOpened: initialOpened(normObs.opened), initialFrozen: initialFrozen(normObs.frozen) }), open: z.strictObject({ openedAt: normObs.opened }), consume: z.strictObject({ consumption: normalizedConsumption }), discard: rawPayload.discard, move: rawPayload.move, freeze: z.strictObject({ frozenAt: normObs.frozen }), thaw: z.strictObject({ destination: nonFrozenStorage, thawedAt: normObs.thawed }), adjust: z.strictObject({ quantity: normalizedWritable }), change_dates: z.strictObject({ changes: z.array(normMeta).min(1).max(8) }), change_food_concept_binding: rawPayload.change_food_concept_binding, correct: z.strictObject({ targetEventId: inventoryEventIdSchema, intents: z.array(normCorrectionIntent).min(1).max(6) }) };
type CommandType = keyof typeof rawPayload;
const commandBranch = <const T extends CommandType, P extends z.ZodType, O extends z.ZodType>(type: T, payload: P, observedAt: O) => z.strictObject({ schemaVersion: z.literal(2), type: z.literal(type), source: z.literal("manual_confirmation"), householdId: householdIdSchema, inventoryLotId: inventoryLotIdSchema, expectedVersion: pgIntSchema, observedAt, payload, note: postgresTextSchema(0, 500).nullable() });
const rawBranches = {
  acquire: commandBranch("acquire", rawPayload.acquire, rawOccurrence),
  produce: commandBranch("produce", rawPayload.produce, rawOccurrence),
  open: commandBranch("open", rawPayload.open, rawOccurrence),
  consume: commandBranch("consume", rawPayload.consume, rawOccurrence),
  discard: commandBranch("discard", rawPayload.discard, rawOccurrence),
  move: commandBranch("move", rawPayload.move, rawOccurrence),
  freeze: commandBranch("freeze", rawPayload.freeze, rawOccurrence),
  thaw: commandBranch("thaw", rawPayload.thaw, rawOccurrence),
  adjust: commandBranch("adjust", rawPayload.adjust, rawOccurrence),
  change_dates: commandBranch("change_dates", rawPayload.change_dates, rawOccurrence),
  change_food_concept_binding: commandBranch("change_food_concept_binding", rawPayload.change_food_concept_binding, rawOccurrence),
  correct: commandBranch("correct", rawPayload.correct, rawOccurrence),
} as const;
const normBranches = {
  acquire: commandBranch("acquire", normalizedPayload.acquire, normalizedOccurrence),
  produce: commandBranch("produce", normalizedPayload.produce, normalizedOccurrence),
  open: commandBranch("open", normalizedPayload.open, normalizedOccurrence),
  consume: commandBranch("consume", normalizedPayload.consume, normalizedOccurrence),
  discard: commandBranch("discard", normalizedPayload.discard, normalizedOccurrence),
  move: commandBranch("move", normalizedPayload.move, normalizedOccurrence),
  freeze: commandBranch("freeze", normalizedPayload.freeze, normalizedOccurrence),
  thaw: commandBranch("thaw", normalizedPayload.thaw, normalizedOccurrence),
  adjust: commandBranch("adjust", normalizedPayload.adjust, normalizedOccurrence),
  change_dates: commandBranch("change_dates", normalizedPayload.change_dates, normalizedOccurrence),
  change_food_concept_binding: commandBranch("change_food_concept_binding", normalizedPayload.change_food_concept_binding, normalizedOccurrence),
  correct: commandBranch("correct", normalizedPayload.correct, normalizedOccurrence),
} as const;
const rawUnion = z.union([rawBranches.acquire, rawBranches.produce, rawBranches.open, rawBranches.consume, rawBranches.discard, rawBranches.move, rawBranches.freeze, rawBranches.thaw, rawBranches.adjust, rawBranches.change_dates, rawBranches.change_food_concept_binding, rawBranches.correct]);
const normUnion = z.union([normBranches.acquire, normBranches.produce, normBranches.open, normBranches.consume, normBranches.discard, normBranches.move, normBranches.freeze, normBranches.thaw, normBranches.adjust, normBranches.change_dates, normBranches.change_food_concept_binding, normBranches.correct]);
const dateOrder = ["purchase_date", "production_date", "best_before_date", "use_by_date", "prepared_at", "opened_at", "frozen_at", "thawed_at"] as const;
const correctionAxisOrder = ["binding", "quantity", "state", "dates", "seal_state", "storage"] as const;
const metadataChangeKind = (change: unknown): string => readSafeOwn(change, "operation") === "set" ? String(readSafeOwn(readSafeOwn(change, "date"), "kind")) : String(readSafeOwn(change, "kind"));
const validateMetadataChanges = (changes: readonly unknown[], ctx: z.RefinementCtx, path: readonly PropertyKey[], ordered: boolean): void => {
  const seen = new Set<string>(); let previous = -1;
  changes.forEach((change, index) => {
    const kind = metadataChangeKind(change);
    if (seen.has(kind)) ctx.addIssue({ code: "custom", path: [...path, index], message: "DATE_DUPLICATE" });
    const current = dateOrder.indexOf(kind as (typeof dateOrder)[number]);
    if (ordered && current <= previous) ctx.addIssue({ code: "custom", path: [...path, index], message: "DATE_ORDER" });
    seen.add(kind); previous = current;
  });
};
const cross = (v: z.infer<typeof rawUnion> | z.infer<typeof normUnion>, ctx: z.RefinementCtx, ordered: boolean): void => {
  if (v.type === "acquire" || v.type === "produce") {
    if ((v.payload.storageLocation === "frozen") !== (v.payload.initialFrozen.state === "frozen")) ctx.addIssue({ code: "custom", path: ["payload", "initialFrozen"], message: "INITIAL_STATE_CONFLICT" });
    const seen = new Set<string>(); let previous = -1;
    v.payload.dates.forEach((d, i) => { if (seen.has(d.kind)) ctx.addIssue({ code: "custom", path: ["payload", "dates", i], message: "DATE_DUPLICATE" }); const current = dateOrder.indexOf(d.kind); if (ordered && current <= previous) ctx.addIssue({ code: "custom", path: ["payload", "dates", i], message: "DATE_ORDER" }); seen.add(d.kind); previous = current; });
  } else if (v.type === "change_dates") {
    validateMetadataChanges(v.payload.changes, ctx, ["payload", "changes"], ordered);
  } else if (v.type === "correct") {
    const seen = new Set<string>(); let previous = -1;
    v.payload.intents.forEach((intent, index) => {
      if (seen.has(intent.axis)) ctx.addIssue({ code: "custom", path: ["payload", "intents", index], message: "CORRECTION_AXIS_DUPLICATE" });
      const current = correctionAxisOrder.indexOf(intent.axis);
      if (ordered && current <= previous) ctx.addIssue({ code: "custom", path: ["payload", "intents", index], message: "CORRECTION_AXIS_ORDER" });
      seen.add(intent.axis); previous = current;
      if (intent.axis === "dates") validateMetadataChanges(intent.changes, ctx, ["payload", "intents", index, "changes"], ordered);
    });
  }
};
export const rawInventoryCommandBodyV2Schema = ruleSuperRefine(rawUnion, "inventory.v2.raw-command-cross-field.v1", "rawInventoryCommandBodyV2Schema", (v, c) => cross(v, c, false));
export const normalizedInventoryCommandBodyV2Schema = ruleSuperRefine(normUnion, "inventory.v2.normalized-command-cross-field.v1", "normalizedInventoryCommandBodyV2Schema", (v, c) => cross(v, c, true));
export type RawInventoryCommandBodyV2DTO = z.infer<typeof rawInventoryCommandBodyV2Schema>;
export type NormalizedInventoryCommandBodyV2DTO = z.infer<typeof normalizedInventoryCommandBodyV2Schema>;

const storedSourceFields = { capturedAt: canonicalInstant, confirmedByUserId: userIdSchema, sourceCommandId: commandIdSchema, sourceEventId: inventoryEventIdSchema, sourceExpectedLotVersion: pgIntSchema, sourceResultingLotVersion: positivePgIntSchema } as const;
const storedPackageSource = z.strictObject({ kind: z.literal("package_label"), confidence, reference: dateReference, ...storedSourceFields });
const storedUserSource = z.strictObject({ kind: z.literal("user_input"), confidence, reference: dateReference.nullable(), ...storedSourceFields });
const storedRecognitionSource = z.strictObject({ kind: z.literal("confirmed_recognition"), confidence, reference: dateReference, ...storedSourceFields });
const storedSystemSource = z.strictObject({ kind: z.literal("system_event"), confidence: z.literal("high"), reference: z.null(), ...storedSourceFields });
const storedCalendarSource = z.union([storedPackageSource, storedUserSource, storedRecognitionSource]);
const storedPurchaseSource = z.union([storedUserSource, storedRecognitionSource]);
const storedInstantSource = z.union([storedUserSource, storedRecognitionSource, storedSystemSource]);
type StoredDateDTO =
  | Readonly<{ kind: "purchase_date"; value: z.output<typeof localDate>; source: z.output<typeof storedPurchaseSource> }>
  | Readonly<{ kind: "production_date" | "best_before_date" | "use_by_date"; value: z.output<typeof localDate>; source: z.output<typeof storedCalendarSource> }>
  | Readonly<{ kind: "prepared_at" | "opened_at" | "frozen_at" | "thawed_at"; value: z.output<typeof canonicalInstant>; source: z.output<typeof storedInstantSource> }>;
const storedDate: z.ZodType<StoredDateDTO> = z.union([
  dateBranch("purchase_date", localDate, storedPurchaseSource),
  dateBranch("production_date", localDate, storedCalendarSource),
  dateBranch("best_before_date", localDate, storedCalendarSource),
  dateBranch("use_by_date", localDate, storedCalendarSource),
  dateBranch("prepared_at", canonicalInstant, storedInstantSource),
  dateBranch("opened_at", canonicalInstant, storedInstantSource),
  dateBranch("frozen_at", canonicalInstant, storedInstantSource),
  dateBranch("thawed_at", canonicalInstant, storedInstantSource),
]);
const storedDates = z.array(storedDate).max(8);
const eventPayload = { acquired: z.strictObject({ payloadKind: z.literal("acquired"), lotDisplayName: postgresTextSchema(1, 120), foodConceptBinding: storedBinding, state: z.literal("active"), sealState: z.enum(["sealed", "opened"]), storageLocation: storage, currentQuantity: normalizedProjectionQuantity, dates: storedDates }), produced: z.strictObject({ payloadKind: z.literal("produced"), lotDisplayName: postgresTextSchema(1, 120), foodConceptBinding: storedBinding, state: z.literal("active"), sealState: z.enum(["sealed", "opened"]), storageLocation: storage, currentQuantity: normalizedProjectionQuantity, dates: storedDates }), opened: z.strictObject({ payloadKind: z.literal("opened"), beforeSealState: z.literal("sealed"), afterSealState: z.literal("opened"), beforeDates: storedDates, afterDates: storedDates }), consumed: z.strictObject({ payloadKind: z.literal("consumed"), beforeQuantity: normalizedProjectionQuantity, consumption: normalizedConsumption, afterQuantity: normalizedProjectionQuantity, beforeState: z.literal("active"), afterState: z.enum(["active", "depleted"]) }), discarded: z.strictObject({ payloadKind: z.literal("discarded"), beforeQuantity: normalizedProjectionQuantity, afterQuantity: normalizedProjectionQuantity, beforeState: z.literal("active"), afterState: z.literal("discarded"), reason: postgresTextSchema(1, 500).nullable() }), moved: z.strictObject({ payloadKind: z.literal("moved"), fromStorageLocation: nonFrozenStorage, toStorageLocation: nonFrozenStorage }), frozen: z.strictObject({ payloadKind: z.literal("frozen"), fromStorageLocation: nonFrozenStorage, toStorageLocation: z.literal("frozen"), beforeDates: storedDates, afterDates: storedDates }), thawed: z.strictObject({ payloadKind: z.literal("thawed"), fromStorageLocation: z.literal("frozen"), toStorageLocation: nonFrozenStorage, beforeDates: storedDates, afterDates: storedDates }), adjusted: z.strictObject({ payloadKind: z.literal("adjusted"), beforeQuantity: normalizedProjectionQuantity, afterQuantity: normalizedProjectionQuantity }), dates_changed: z.strictObject({ payloadKind: z.literal("dates_changed"), beforeDates: storedDates, afterDates: storedDates }), food_concept_binding_changed: z.strictObject({ payloadKind: z.literal("food_concept_binding_changed"), beforeBinding: storedBinding, afterBinding: storedBinding }), corrected: z.strictObject({ payloadKind: z.literal("corrected"), targetEventId: inventoryEventIdSchema, rootEventId: inventoryEventIdSchema, changedAxes: z.array(z.enum(["binding", "quantity", "state", "dates", "seal_state", "storage", "safety"])).min(1).max(7), beforeDates: storedDates.optional(), afterDates: storedDates.optional() }) };
type EventType = keyof typeof eventPayload;
const coreBranch = <const T extends EventType, P extends z.ZodType>(type: T, payload: P) => z.strictObject({ schemaVersion: z.literal(2), eventId: inventoryEventIdSchema, commandId: commandIdSchema, householdId: householdIdSchema, inventoryLotId: inventoryLotIdSchema, type: z.literal(type), source: z.literal("manual_confirmation"), actorUserId: userIdSchema, occurredAt: canonicalInstant, payload, note: postgresTextSchema(0, 500).nullable() });
const cores = {
  acquired: coreBranch("acquired", eventPayload.acquired),
  produced: coreBranch("produced", eventPayload.produced),
  opened: coreBranch("opened", eventPayload.opened),
  consumed: coreBranch("consumed", eventPayload.consumed),
  discarded: coreBranch("discarded", eventPayload.discarded),
  moved: coreBranch("moved", eventPayload.moved),
  frozen: coreBranch("frozen", eventPayload.frozen),
  thawed: coreBranch("thawed", eventPayload.thawed),
  adjusted: coreBranch("adjusted", eventPayload.adjusted),
  dates_changed: coreBranch("dates_changed", eventPayload.dates_changed),
  food_concept_binding_changed: coreBranch("food_concept_binding_changed", eventPayload.food_concept_binding_changed),
  corrected: coreBranch("corrected", eventPayload.corrected),
} as const;
const coreUnion = z.union([cores.acquired, cores.produced, cores.opened, cores.consumed, cores.discarded, cores.moved, cores.frozen, cores.thawed, cores.adjusted, cores.dates_changed, cores.food_concept_binding_changed, cores.corrected]);
const validateUniqueStoredDates = (dates: readonly StoredDateDTO[], ctx: z.RefinementCtx, path: readonly (string | number)[]): void => {
  const seen = new Set<string>();
  dates.forEach((date, index) => {
    if (seen.has(date.kind)) ctx.addIssue({ code: "custom", path: [...path, index], message: "STORED_DATE_DUPLICATE" });
    seen.add(date.kind);
  });
};
const validateEventStoredDates = (event: z.infer<typeof coreUnion>, ctx: z.RefinementCtx): void => {
  switch (event.type) {
    case "acquired": case "produced":
      validateUniqueStoredDates(event.payload.dates, ctx, ["payload", "dates"]); break;
    case "opened": case "frozen": case "thawed": case "dates_changed":
      validateUniqueStoredDates(event.payload.beforeDates, ctx, ["payload", "beforeDates"]);
      validateUniqueStoredDates(event.payload.afterDates, ctx, ["payload", "afterDates"]); break;
    case "corrected": {
      const changesDates = event.payload.changedAxes.includes("dates");
      const hasBefore = event.payload.beforeDates !== undefined; const hasAfter = event.payload.afterDates !== undefined;
      if (changesDates !== (hasBefore && hasAfter) || hasBefore !== hasAfter || event.payload.changedAxes.length !== new Set(event.payload.changedAxes).size) ctx.addIssue({ code: "custom", path: ["payload", "changedAxes"], message: "CORRECTED_DATE_SNAPSHOTS" });
      if (event.payload.beforeDates !== undefined) validateUniqueStoredDates(event.payload.beforeDates, ctx, ["payload", "beforeDates"]);
      if (event.payload.afterDates !== undefined) validateUniqueStoredDates(event.payload.afterDates, ctx, ["payload", "afterDates"]);
      break;
    }
    default: break;
  }
};
export const inventoryEventCoreV2Schema = ruleSuperRefine(coreUnion, "inventory.v2.event-core-date-consistency.v1", "inventoryEventCoreV2Schema", validateEventStoredDates);
const tail = { eventCoreDigest: digestSchema, sequence: positivePgIntSchema, expectedVersion: pgIntSchema, resultingVersion: positivePgIntSchema, recordedAt: canonicalInstant, previousEventDigest: digestSchema.nullable(), resultingProjectionDigest: digestSchema, eventDigest: digestSchema };
const stored = {
  acquired: cores.acquired.extend(tail),
  produced: cores.produced.extend(tail),
  opened: cores.opened.extend(tail),
  consumed: cores.consumed.extend(tail),
  discarded: cores.discarded.extend(tail),
  moved: cores.moved.extend(tail),
  frozen: cores.frozen.extend(tail),
  thawed: cores.thawed.extend(tail),
  adjusted: cores.adjusted.extend(tail),
  dates_changed: cores.dates_changed.extend(tail),
  food_concept_binding_changed: cores.food_concept_binding_changed.extend(tail),
  corrected: cores.corrected.extend(tail),
} as const;
const storedUnion = z.union([stored.acquired, stored.produced, stored.opened, stored.consumed, stored.discarded, stored.moved, stored.frozen, stored.thawed, stored.adjusted, stored.dates_changed, stored.food_concept_binding_changed, stored.corrected]);
export const storedInventoryEventV2Schema = ruleSuperRefine(storedUnion, "inventory.v2.stored-event-consistency.v1", "storedInventoryEventV2Schema", (e, ctx) => { validateEventStoredDates(e, ctx); if (!isStage09pPgIntSuccessor(e.expectedVersion, e.resultingVersion)) ctx.addIssue({ code: "custom", path: ["resultingVersion"], message: "VERSION_BREAK" }); if ((e.expectedVersion === "0") !== (e.previousEventDigest === null)) ctx.addIssue({ code: "custom", path: ["previousEventDigest"], message: "CHAIN_NULLABILITY" }); });
export type InventoryEventCoreV2DTO = z.infer<typeof inventoryEventCoreV2Schema>; export type StoredInventoryEventV2DTO = z.infer<typeof storedInventoryEventV2Schema>;

const safety = z.union([z.strictObject({ status: z.literal("blocked"), revision: positivePgIntSchema, safetyFactsDigest: digestSchema, reasonCodes: z.tuple([z.literal("LOT_DISCARDED")]), policyDigest: z.null(), evaluatedAt: canonicalInstant }), z.strictObject({ status: z.literal("unknown"), revision: positivePgIntSchema, safetyFactsDigest: digestSchema, reasonCodes: z.array(z.enum(["SAFETY_AUTHORITY_EMPTY", "FOOD_CONCEPT_UNBOUND", "FOOD_CONCEPT_UNTRUSTED", "QUANTITY_PRECISION_UNCERTAIN"])).min(2).max(3), policyDigest: z.null(), evaluatedAt: canonicalInstant })]);
const lotBase = z.strictObject({ schemaVersion: z.literal(2), id: inventoryLotIdSchema, householdId: householdIdSchema, lotDisplayName: postgresTextSchema(1, 120), foodConceptBinding: storedBinding, state: z.enum(["active", "depleted", "discarded"]), sealState: z.enum(["sealed", "opened"]), storageLocation: storage, currentQuantity: normalizedProjectionQuantity, dates: storedDates, safetyAssessment: safety, origin: z.literal("manual"), createdByUserId: userIdSchema, createdAt: canonicalInstant, updatedAt: canonicalInstant, version: positivePgIntSchema, lastEventSequence: positivePgIntSchema, projectionDigest: digestSchema });
export const inventoryLotV2Schema = ruleSuperRefine(lotBase, "inventory.v2.lot-invariants.v1", "inventoryLotV2Schema", (lot, ctx) => { validateUniqueStoredDates(lot.dates, ctx, ["dates"]); const empty = (lot.currentQuantity.kind !== "qualitative" && lot.currentQuantity.amount === "0") || (lot.currentQuantity.kind === "qualitative" && lot.currentQuantity.level === "empty"); if ((lot.state === "active") === empty) ctx.addIssue({ code: "custom", path: ["currentQuantity"], message: "STATE_QUANTITY" }); if (lot.state === "discarded" && lot.safetyAssessment.status !== "blocked") ctx.addIssue({ code: "custom", path: ["safetyAssessment"], message: "DISCARDED_SAFETY" }); if (lot.state !== "discarded" && lot.safetyAssessment.status !== "unknown") ctx.addIssue({ code: "custom", path: ["safetyAssessment"], message: "CURRENT_SAFETY" }); });
export type InventoryLotV2DTO = z.infer<typeof inventoryLotV2Schema>;
type StoredEventInternal = z.infer<typeof storedUnion>;
const sameStoredDate = (left: StoredDateDTO, right: StoredDateDTO): boolean => left.kind === right.kind && left.value === right.value && left.source.kind === right.source.kind && left.source.confidence === right.source.confidence && left.source.reference === right.source.reference && left.source.capturedAt === right.source.capturedAt && left.source.confirmedByUserId === right.source.confirmedByUserId && left.source.sourceCommandId === right.source.sourceCommandId && left.source.sourceEventId === right.source.sourceEventId && left.source.sourceExpectedLotVersion === right.source.sourceExpectedLotVersion && left.source.sourceResultingLotVersion === right.source.sourceResultingLotVersion;
const sameStoredDateSet = (left: readonly StoredDateDTO[], right: readonly StoredDateDTO[]): boolean => left.length === right.length && left.every((date) => { const peer = right.find((candidate) => candidate.kind === date.kind); return peer !== undefined && sameStoredDate(date, peer); });
const eventDateBeforeFacts = (event: StoredEventInternal): readonly StoredDateDTO[] | null => {
  switch (event.type) {
    case "opened": case "frozen": case "thawed": case "dates_changed": return event.payload.beforeDates;
    case "corrected": return event.payload.changedAxes.includes("dates") ? event.payload.beforeDates ?? null : null;
    default: return null;
  }
};
const eventDateAfterFacts = (event: StoredEventInternal): readonly StoredDateDTO[] | null => {
  switch (event.type) {
    case "acquired": case "produced": return event.payload.dates;
    case "opened": case "frozen": case "thawed": case "dates_changed": return event.payload.afterDates;
    case "corrected": return event.payload.changedAxes.includes("dates") ? event.payload.afterDates ?? null : null;
    default: return null;
  }
};
const deriveInventoryDateState = (events: readonly StoredEventInternal[]): readonly StoredDateDTO[] => {
  let current: readonly StoredDateDTO[] = [];
  for (const event of events) { const after = eventDateAfterFacts(event); if (after !== null) current = after; }
  return current;
};
const validateInventoryDateProvenance = (dates: readonly StoredDateDTO[], maximumSourceIndex: number, eventById: ReadonlyMap<string, { readonly event: StoredEventInternal; readonly index: number }>, ctx: z.RefinementCtx, path: readonly (string | number)[]): void => {
  dates.forEach((date, dateIndex) => {
    const source = eventById.get(date.source.sourceEventId);
    const sourceFacts = source === undefined ? null : eventDateAfterFacts(source.event);
    if (source === undefined || source.index > maximumSourceIndex || date.source.sourceCommandId !== source.event.commandId || date.source.sourceExpectedLotVersion !== source.event.expectedVersion || date.source.sourceResultingLotVersion !== source.event.resultingVersion || date.source.confirmedByUserId !== source.event.actorUserId || sourceFacts === null || !sourceFacts.some((fact) => sameStoredDate(date, fact))) ctx.addIssue({ code: "custom", path: [...path, dateIndex, "source"], message: "DATE_PROVENANCE" });
  });
};
const validateInventoryDateHistory = (events: readonly StoredEventInternal[], ctx: z.RefinementCtx): void => {
  const eventById = new Map<string, { readonly event: StoredEventInternal; readonly index: number }>(events.map((event, index) => [event.eventId, { event, index }]));
  let current: readonly StoredDateDTO[] = [];
  events.forEach((event, index) => {
    const before = eventDateBeforeFacts(event); const after = eventDateAfterFacts(event);
    if (before !== null) {
      if (!sameStoredDateSet(before, current)) ctx.addIssue({ code: "custom", path: ["events", index, "payload", "beforeDates"], message: "DATE_BEFORE_STATE" });
      validateInventoryDateProvenance(before, index - 1, eventById, ctx, ["events", index, "payload", "beforeDates"]);
    }
    if (after !== null) {
      validateInventoryDateProvenance(after, index, eventById, ctx, ["events", index, "payload", event.type === "acquired" || event.type === "produced" ? "dates" : "afterDates"]);
      current = after;
    }
  });
};
const emptyHistory = z.strictObject({ kind: z.literal("empty"), events: z.tuple([]), historyDigest: z.null() });
const historyBase = z.strictObject({ kind: z.literal("nonempty"), events: z.array(storedInventoryEventV2Schema).min(1).max(INVENTORY_HISTORY_MAX_V2), historyDigest: digestSchema });
const refinedHistory = ruleSuperRefine(historyBase, "inventory.v2.history-consistency.v1", "refinedNonemptyInventoryHistoryV2Schema", (h, ctx) => { const ids = new Set<string>(); const commands = new Set<string>(); h.events.forEach((e, i) => { if (ids.has(e.eventId) || commands.has(e.commandId)) ctx.addIssue({ code: "custom", path: ["events", i], message: "DUPLICATE_ID" }); ids.add(e.eventId); commands.add(e.commandId); if (i === 0) { if (e.sequence !== "1" || e.expectedVersion !== "0" || e.previousEventDigest !== null || (e.type !== "acquired" && e.type !== "produced")) ctx.addIssue({ code: "custom", path: ["events", 0], message: "FIRST_EVENT" }); } else { const p = h.events[i - 1]; if (p !== undefined && (e.householdId !== p.householdId || e.inventoryLotId !== p.inventoryLotId || !isStage09pPgIntSuccessor(p.sequence, e.sequence) || e.expectedVersion !== p.resultingVersion || e.previousEventDigest !== p.eventDigest)) ctx.addIssue({ code: "custom", path: ["events", i], message: "CHAIN_BREAK" }); } }); validateInventoryDateHistory(h.events, ctx); });
export const inventoryHistoryV2Schema = z.union([emptyHistory, refinedHistory]); export type InventoryHistoryV2DTO = z.infer<typeof inventoryHistoryV2Schema>;
const absentAggregate = z.strictObject({ presence: z.literal("absent"), householdId: householdIdSchema, inventoryLotId: inventoryLotIdSchema, projection: z.null(), history: emptyHistory });
const presentBase = z.strictObject({ presence: z.literal("present"), householdId: householdIdSchema, inventoryLotId: inventoryLotIdSchema, projection: inventoryLotV2Schema, history: refinedHistory });
const presentAggregate = ruleSuperRefine(presentBase, "inventory.v2.aggregate-consistency.v1", "refinedPresentInventoryAggregateV2Schema", (a, ctx) => {
  const eventById = new Map<string, { readonly event: (typeof a.history.events)[number]; readonly index: number }>(a.history.events.map((event, index) => [event.eventId, { event, index }]));
  a.history.events.forEach((e, i) => {
    if (e.householdId !== a.householdId || e.inventoryLotId !== a.inventoryLotId) ctx.addIssue({ code: "custom", path: ["history", "events", i], message: "SCOPE" });
  });
  validateInventoryDateProvenance(a.projection.dates, a.history.events.length - 1, eventById, ctx, ["projection", "dates"]);
  if (!sameStoredDateSet(a.projection.dates, deriveInventoryDateState(a.history.events))) ctx.addIssue({ code: "custom", path: ["projection", "dates"], message: "DATE_STATE" });
  const tip = a.history.events.at(-1);
  if (tip === undefined || a.projection.householdId !== a.householdId || a.projection.id !== a.inventoryLotId || a.projection.version !== tip.resultingVersion || a.projection.lastEventSequence !== tip.sequence || a.projection.projectionDigest !== tip.resultingProjectionDigest) ctx.addIssue({ code: "custom", path: ["projection"], message: "TIP" });
});
export const inventoryAggregateV2Schema = z.union([absentAggregate, presentAggregate]); export type InventoryAggregateV2DTO = z.infer<typeof inventoryAggregateV2Schema>;
const receipt = <const C extends CommandType, const E extends EventType>(commandType: C, eventType: E) => z.strictObject({ outcome: z.literal("accepted"), commandType: z.literal(commandType), eventType: z.literal(eventType), commandId: commandIdSchema, eventId: inventoryEventIdSchema, resultingVersion: positivePgIntSchema, eventCoreDigest: digestSchema, eventDigest: digestSchema, projectionDigest: digestSchema, historyDigest: digestSchema });
const pairs = { acquire: "acquired", produce: "produced", open: "opened", consume: "consumed", discard: "discarded", move: "moved", freeze: "frozen", thaw: "thawed", adjust: "adjusted", change_dates: "dates_changed", change_food_concept_binding: "food_concept_binding_changed", correct: "corrected" } as const;
const acceptedBranch = <C extends CommandType, E extends EventType, CS extends z.ZodType, ES extends z.ZodType>(command: C, event: E, coreSchema: CS, eventSchema: ES) => z.strictObject({ kind: z.literal("accepted"), eventCore: coreSchema, event: eventSchema, next: presentAggregate, receipt: receipt(command, event) });
const unchangedBranch = <const C extends "open" | "move" | "freeze" | "adjust" | "change_dates" | "change_food_concept_binding">(command: C) => z.strictObject({ kind: z.literal("unchanged"), current: presentAggregate, receipt: z.strictObject({ outcome: z.literal("unchanged"), commandType: z.literal(command), resultingVersion: positivePgIntSchema, projectionDigest: digestSchema, historyDigest: digestSchema }) });
const decisionBase = z.union([
  acceptedBranch("acquire", "acquired", cores.acquired, stored.acquired),
  acceptedBranch("produce", "produced", cores.produced, stored.produced),
  acceptedBranch("open", "opened", cores.opened, stored.opened),
  acceptedBranch("consume", "consumed", cores.consumed, stored.consumed),
  acceptedBranch("discard", "discarded", cores.discarded, stored.discarded),
  acceptedBranch("move", "moved", cores.moved, stored.moved),
  acceptedBranch("freeze", "frozen", cores.frozen, stored.frozen),
  acceptedBranch("thaw", "thawed", cores.thawed, stored.thawed),
  acceptedBranch("adjust", "adjusted", cores.adjusted, stored.adjusted),
  acceptedBranch("change_dates", "dates_changed", cores.dates_changed, stored.dates_changed),
  acceptedBranch("change_food_concept_binding", "food_concept_binding_changed", cores.food_concept_binding_changed, stored.food_concept_binding_changed),
  acceptedBranch("correct", "corrected", cores.corrected, stored.corrected),
  unchangedBranch("open"), unchangedBranch("move"), unchangedBranch("freeze"), unchangedBranch("adjust"), unchangedBranch("change_dates"), unchangedBranch("change_food_concept_binding"),
  z.strictObject({ kind: z.literal("invalid_aggregate"), reason: inventoryHistoryReasonV2Schema }),
  z.strictObject({ kind: z.literal("rejected"), reason: inventoryCommandReasonV2Schema }),
]);
const structurallyEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => structurallyEqual(value, right[index]));
  }
  if (!isSafeRecord(left) || !isSafeRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(readSafeOwn(left, key), readSafeOwn(right, key)));
};
const inventoryEventCoreOf = (event: z.infer<typeof storedUnion>): Record<string, unknown> => ({
  schemaVersion: event.schemaVersion,
  eventId: event.eventId,
  commandId: event.commandId,
  householdId: event.householdId,
  inventoryLotId: event.inventoryLotId,
  type: event.type,
  source: event.source,
  actorUserId: event.actorUserId,
  occurredAt: event.occurredAt,
  payload: event.payload,
  note: event.note,
});
export const inventoryDecisionResultV2Schema: typeof decisionBase = ruleSuperRefine(decisionBase, "inventory.v2.decision-correlation.v1", "inventoryDecisionResultV2Schema", (r, ctx) => {
  if (r.kind === "accepted") {
    const tip = r.next.history.events.at(-1);
    if (!structurallyEqual(r.eventCore, inventoryEventCoreOf(r.event))) ctx.addIssue({ code: "custom", path: ["eventCore"], message: "DECISION_CORRELATION" });
    if (tip === undefined || !structurallyEqual(r.event, tip)) ctx.addIssue({ code: "custom", path: ["event"], message: "DECISION_CORRELATION" });
    if (r.receipt.eventId !== r.event.eventId || r.receipt.commandId !== r.event.commandId || r.receipt.eventType !== r.event.type || r.receipt.resultingVersion !== r.event.resultingVersion || r.receipt.resultingVersion !== r.next.projection.version || r.receipt.eventCoreDigest !== r.event.eventCoreDigest || r.receipt.eventDigest !== r.event.eventDigest || r.receipt.projectionDigest !== r.event.resultingProjectionDigest || r.receipt.projectionDigest !== r.next.projection.projectionDigest || r.receipt.historyDigest !== r.next.history.historyDigest) ctx.addIssue({ code: "custom", path: ["receipt"], message: "DECISION_CORRELATION" });
  } else if (r.kind === "unchanged" && (r.receipt.resultingVersion !== r.current.projection.version || r.receipt.projectionDigest !== r.current.projection.projectionDigest || r.receipt.historyDigest !== r.current.history.historyDigest)) {
    ctx.addIssue({ code: "custom", path: ["receipt"], message: "DECISION_CORRELATION" });
  }
});
export type InventoryDecisionResultV2DTO = z.infer<typeof inventoryDecisionResultV2Schema>;
export const inventorySingleReplayResultV2Schema = z.union([z.strictObject({ kind: z.literal("applied"), next: presentAggregate }), z.strictObject({ kind: z.literal("invalid_aggregate"), reason: inventoryHistoryReasonV2Schema }), z.strictObject({ kind: z.literal("rejected"), reason: inventoryReplayReasonV2Schema })]);
export const inventoryFullHistoryReplayResultV2Schema = z.union([z.strictObject({ kind: z.literal("replayed"), aggregate: inventoryAggregateV2Schema }), z.strictObject({ kind: z.literal("invalid_history_claim"), eventIndex: z.null(), reason: inventoryHistoryReasonV2Schema }), z.strictObject({ kind: z.literal("invalid_history_event"), eventIndex: z.int().nonnegative(), reason: z.union([inventoryHistoryReasonV2Schema, inventoryReplayReasonV2Schema]) })]);
export type InventorySingleReplayResultV2DTO = z.infer<typeof inventorySingleReplayResultV2Schema>; export type InventoryFullHistoryReplayResultV2DTO = z.infer<typeof inventoryFullHistoryReplayResultV2Schema>;

const replaySessionIdSchema = z.uuidv7().brand<"InventoryReplaySessionIdV2">();
const replayCheckpointIdSchema = z.uuidv7().brand<"InventoryReplayCheckpointIdV2">();
const replayChunkKindSchema = z.enum(["only", "first", "continuation", "final"]);
const replayCountWithinLogicalHistory = (value: string): number | null => {
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= inventoryMaxTotalReplayEventsV2 ? parsed : null;
};
const positiveReplayLogicalCountSchema = z.string().regex(/^(?:[1-9][0-9]{0,3}|10000)$/);
const inventoryReplayInputDataGraphSchema = z.custom<unknown>(
  isStage09pSchemaInputDataGraph,
  { message: "REPLAY_INPUT_DATA_GRAPH" },
);
/** Untrusted continuation claim; R7-B must compare it with persisted server state. */
export const inventoryCallerReplayCheckpointClaimV2Schema = inventoryReplayInputDataGraphSchema.pipe(z.strictObject({
  kind: z.literal("caller_claim"),
  checkpointId: replayCheckpointIdSchema,
  checkpointDigest: digestSchema,
  replaySessionId: replaySessionIdSchema,
  householdId: householdIdSchema,
  inventoryLotId: inventoryLotIdSchema,
  nextChunkOrdinal: positivePgIntSchema,
  processedEventCount: pgIntSchema,
  nextEventSequence: positivePgIntSchema,
  terminalEventDigest: digestSchema,
  declaredTotalEventCount: positivePgIntSchema,
}));

const inventoryNonemptyReplayChunkInputBase = z.strictObject({
  schemaVersion: z.literal(2),
  householdId: householdIdSchema,
  inventoryLotId: inventoryLotIdSchema,
  replaySessionId: replaySessionIdSchema,
  chunkKind: replayChunkKindSchema,
  chunkOrdinal: positivePgIntSchema,
  chunkStartSequence: positivePgIntSchema,
  chunkEndSequence: positivePgIntSchema,
  previousChunkTerminalEventDigest: digestSchema.nullable(),
  terminalEventDigest: digestSchema,
  processedEventCountBefore: pgIntSchema,
  chunkEventCount: positivePgIntSchema,
  claimedProcessedEventCount: positivePgIntSchema,
  declaredTotalEventCount: positivePgIntSchema,
  priorCheckpointClaim: inventoryCallerReplayCheckpointClaimV2Schema.nullable(),
  events: z.array(storedInventoryEventV2Schema).min(1).max(inventoryMaxEventsPerChunkV2),
  claimedFinalHistoryDigest: digestSchema.nullable(),
});
const inventoryEmptyReplayChunkInputBase = z.strictObject({
  schemaVersion: z.literal(2),
  householdId: householdIdSchema,
  inventoryLotId: inventoryLotIdSchema,
  replaySessionId: replaySessionIdSchema,
  chunkKind: z.literal("only"),
  chunkOrdinal: z.literal("1"),
  chunkStartSequence: z.literal("1"),
  chunkEndSequence: z.literal("0"),
  previousChunkTerminalEventDigest: z.null(),
  terminalEventDigest: z.null(),
  processedEventCountBefore: z.literal("0"),
  chunkEventCount: z.literal("0"),
  claimedProcessedEventCount: z.literal("0"),
  declaredTotalEventCount: z.literal("0"),
  priorCheckpointClaim: z.null(),
  events: z.tuple([]),
  claimedFinalHistoryDigest: z.null(),
});
const inventoryRawReplayChunkInputSchema = inventoryReplayInputDataGraphSchema.pipe(
  z.union([
    inventoryNonemptyReplayChunkInputBase,
    inventoryEmptyReplayChunkInputBase,
  ]),
);

const inventoryReplayChunkIssue = (ctx: z.RefinementCtx, path: readonly (string | number)[], message: string): void => {
  ctx.addIssue({ code: "custom", path: [...path], message });
};

const inventoryNonemptyServerCheckpointBase = z.strictObject({
  kind: z.literal("server_verified"), checkpointId: replayCheckpointIdSchema, checkpointDigest: digestSchema, replaySessionId: replaySessionIdSchema,
  householdId: householdIdSchema, inventoryLotId: inventoryLotIdSchema, nextChunkOrdinal: positivePgIntSchema,
  processedEventCount: positiveReplayLogicalCountSchema, nextEventSequence: positivePgIntSchema, terminalEventDigest: digestSchema,
  declaredTotalEventCount: positiveReplayLogicalCountSchema,
});
const inventoryServerVerifiedOpenCheckpoint = inventoryNonemptyServerCheckpointBase.extend({ status: z.literal("open"), verifiedHistoryDigest: z.null() });
const inventoryServerVerifiedFinalizedCheckpoint = inventoryNonemptyServerCheckpointBase.extend({ status: z.literal("finalized"), verifiedHistoryDigest: digestSchema });
const inventoryServerVerifiedEmptyCheckpoint = z.strictObject({
  kind: z.literal("server_verified"),
  status: z.literal("finalized"),
  checkpointId: replayCheckpointIdSchema,
  checkpointDigest: digestSchema,
  replaySessionId: replaySessionIdSchema,
  householdId: householdIdSchema,
  inventoryLotId: inventoryLotIdSchema,
  nextChunkOrdinal: z.literal("2"),
  processedEventCount: z.literal("0"),
  nextEventSequence: z.literal("1"),
  terminalEventDigest: z.null(),
  declaredTotalEventCount: z.literal("0"),
  verifiedHistoryDigest: z.null(),
});
const inventoryRawServerVerifiedReplayCheckpointSchema = inventoryReplayInputDataGraphSchema.pipe(
  z.union([
    inventoryServerVerifiedOpenCheckpoint,
    inventoryServerVerifiedFinalizedCheckpoint,
    inventoryServerVerifiedEmptyCheckpoint,
  ]),
);

/**
 * Object/DTO schema for documentation and trusted in-process values. It is not the
 * raw replay trust boundary; callers must use parseInventoryReplayChunkInputV2.
 * Cross-request checkpoint authenticity, replay prevention, gap/order checks,
 * final-after rejection and atomic persistence remain R7-B responsibilities.
 */
export const inventoryReplayChunkInputV2Schema = ruleSuperRefine(
  inventoryRawReplayChunkInputSchema,
  "inventory.v2.replay-chunk-consistency.v1",
  "inventoryReplayChunkInputV2Schema",
  (chunk, ctx) => {
    if (chunk.events.length === 0) return;
    const before = replayCountWithinLogicalHistory(chunk.processedEventCountBefore);
    const chunkCount = replayCountWithinLogicalHistory(chunk.chunkEventCount);
    const processed = replayCountWithinLogicalHistory(chunk.claimedProcessedEventCount);
    const declared = replayCountWithinLogicalHistory(chunk.declaredTotalEventCount);
    const ordinal = replayCountWithinLogicalHistory(chunk.chunkOrdinal);
    if (before === null || chunkCount === null || processed === null || declared === null || before + chunk.events.length > inventoryMaxTotalReplayEventsV2) {
      inventoryReplayChunkIssue(ctx, ["declaredTotalEventCount"], "REPLAY_TOTAL_CAPACITY");
      return;
    }
    if (chunkCount !== chunk.events.length || processed !== before + chunk.events.length || declared < processed) {
      inventoryReplayChunkIssue(ctx, ["claimedProcessedEventCount"], "REPLAY_CHUNK_ORDER");
    }
    if (ordinal === null || ordinal === 0) inventoryReplayChunkIssue(ctx, ["chunkOrdinal"], "REPLAY_CHUNK_ORDER");

    const first = chunk.events[0];
    const last = chunk.events.at(-1);
    const expectedStart = String(before + 1);
    const expectedEnd = String(before + chunk.events.length);
    if (chunk.chunkStartSequence !== expectedStart || chunk.chunkEndSequence !== expectedEnd) {
      inventoryReplayChunkIssue(ctx, ["chunkStartSequence"], "REPLAY_CHUNK_ORDER");
    }
    const eventIds = new Set<string>();
    const commandIds = new Set<string>();
    let knownDates: readonly StoredDateDTO[] | null = null;
    chunk.events.forEach((event, index) => {
      if (eventIds.has(event.eventId) || commandIds.has(event.commandId)) inventoryReplayChunkIssue(ctx, ["events", index], "REPLAY_CHUNK_ORDER");
      eventIds.add(event.eventId);
      commandIds.add(event.commandId);
      const sequence = before + index + 1;
      if (event.householdId !== chunk.householdId || event.inventoryLotId !== chunk.inventoryLotId) inventoryReplayChunkIssue(ctx, ["events", index], "REPLAY_SCOPE");
      if (event.sequence !== String(sequence) || event.expectedVersion !== String(sequence - 1) || event.resultingVersion !== String(sequence)) inventoryReplayChunkIssue(ctx, ["events", index], "REPLAY_CHUNK_ORDER");
      if (index > 0) {
        const previous = chunk.events[index - 1];
        if (previous !== undefined && event.previousEventDigest !== previous.eventDigest) inventoryReplayChunkIssue(ctx, ["events", index, "previousEventDigest"], "REPLAY_PREVIOUS_DIGEST");
      }
      const beforeDates = eventDateBeforeFacts(event);
      const afterDates = eventDateAfterFacts(event);
      if (beforeDates !== null && knownDates !== null && !sameStoredDateSet(beforeDates, knownDates)) inventoryReplayChunkIssue(ctx, ["events", index, "payload"], "REPLAY_BEFORE");
      if (afterDates !== null) knownDates = afterDates;
    });
    if (first !== undefined && first.previousEventDigest !== chunk.previousChunkTerminalEventDigest) inventoryReplayChunkIssue(ctx, ["previousChunkTerminalEventDigest"], "REPLAY_PREVIOUS_DIGEST");
    if (last === undefined || last.eventDigest !== chunk.terminalEventDigest) inventoryReplayChunkIssue(ctx, ["terminalEventDigest"], "REPLAY_TERMINAL_DIGEST");

    const startsHistory = chunk.chunkKind === "only" || chunk.chunkKind === "first";
    const finishesHistory = chunk.chunkKind === "only" || chunk.chunkKind === "final";
    if (startsHistory) {
      if (chunk.chunkOrdinal !== "1" || before !== 0 || chunk.chunkStartSequence !== "1" || chunk.previousChunkTerminalEventDigest !== null || chunk.priorCheckpointClaim !== null || first === undefined || first.expectedVersion !== "0" || first.previousEventDigest !== null || (first.type !== "acquired" && first.type !== "produced")) inventoryReplayChunkIssue(ctx, ["chunkKind"], "REPLAY_CHUNK_ORDER");
    } else if (chunk.chunkOrdinal === "1" || before === 0 || chunk.previousChunkTerminalEventDigest === null || chunk.priorCheckpointClaim === null) {
      inventoryReplayChunkIssue(ctx, ["chunkKind"], "REPLAY_CHUNK_ORDER");
    }
    if (finishesHistory ? chunk.claimedFinalHistoryDigest === null || declared !== processed : chunk.claimedFinalHistoryDigest !== null || declared === processed) {
      inventoryReplayChunkIssue(ctx, ["claimedFinalHistoryDigest"], "REPLAY_FINALIZATION");
    }
    const claim = chunk.priorCheckpointClaim;
    if (claim !== null && (claim.replaySessionId !== chunk.replaySessionId || claim.householdId !== chunk.householdId || claim.inventoryLotId !== chunk.inventoryLotId || claim.nextChunkOrdinal !== chunk.chunkOrdinal || claim.processedEventCount !== chunk.processedEventCountBefore || claim.nextEventSequence !== chunk.chunkStartSequence || claim.terminalEventDigest !== chunk.previousChunkTerminalEventDigest || claim.declaredTotalEventCount !== chunk.declaredTotalEventCount)) {
      inventoryReplayChunkIssue(ctx, ["priorCheckpointClaim"], "REPLAY_CHECKPOINT");
    }
  },
);
export type InventoryReplayChunkInputV2DTO = z.infer<typeof inventoryReplayChunkInputV2Schema>;
export type InventoryCallerReplayCheckpointClaimV2DTO = z.infer<typeof inventoryCallerReplayCheckpointClaimV2Schema>;
export type InventoryReplayChunkParseResultV2 = { readonly ok: true; readonly value: DeepReadonly<InventoryReplayChunkInputV2DTO> } | { readonly ok: false; readonly reason: InventoryReplayReasonV2DTO };

/** Server result/persisted-state shape; the raw client parser cannot produce this authority kind. */
export const inventoryServerVerifiedReplayCheckpointV2Schema = ruleSuperRefine(
  inventoryRawServerVerifiedReplayCheckpointSchema,
  "inventory.v2.replay-server-checkpoint-consistency.v1",
  "inventoryServerVerifiedReplayCheckpointV2Schema",
  (checkpoint, ctx) => {
    if (checkpoint.processedEventCount === "0") return;
    const processed = replayCountWithinLogicalHistory(checkpoint.processedEventCount);
    const declared = replayCountWithinLogicalHistory(checkpoint.declaredTotalEventCount);
    const nextOrdinal = Number(checkpoint.nextChunkOrdinal);
    if (processed === null || declared === null || !Number.isSafeInteger(nextOrdinal) || nextOrdinal < 2 || nextOrdinal > processed + 1 || checkpoint.nextEventSequence !== String(processed + 1) || (checkpoint.status === "open" ? processed >= declared : processed !== declared)) {
      inventoryReplayChunkIssue(ctx, ["processedEventCount"], "REPLAY_SERVER_CHECKPOINT");
    }
  },
);
export type InventoryServerVerifiedReplayCheckpointV2DTO = z.infer<typeof inventoryServerVerifiedReplayCheckpointV2Schema>;
const inventoryRawReplayChunkResultV2Schema = inventoryReplayInputDataGraphSchema.pipe(
  z.union([
    z.strictObject({ kind: z.enum(["accepted_chunk", "finalized"]), checkpoint: inventoryServerVerifiedReplayCheckpointV2Schema }),
    z.strictObject({ kind: z.literal("rejected"), reason: inventoryReplayReasonV2Schema }),
  ]),
);
export const inventoryReplayChunkResultV2Schema = ruleSuperRefine(
  inventoryRawReplayChunkResultV2Schema,
  "inventory.v2.replay-chunk-result-consistency.v1",
  "inventoryReplayChunkResultV2Schema",
  (result, ctx) => {
    if (result.kind === "rejected") return;
    if ((result.kind === "accepted_chunk") !== (result.checkpoint.status === "open")) {
      inventoryReplayChunkIssue(ctx, ["checkpoint", "status"], "REPLAY_RESULT_CHECKPOINT_STATUS");
    }
  },
);
export type InventoryReplayChunkResultV2DTO = z.infer<typeof inventoryReplayChunkResultV2Schema>;

const inventoryReplayIssuesContainEventPath = (issues: readonly z.core.$ZodIssue[]): boolean =>
  issues.some((issue) =>
    (issue.path[0] === "events" && typeof issue.path[1] === "number") ||
    (issue.code === "invalid_union" && issue.errors.some(inventoryReplayIssuesContainEventPath))
  );
const inventoryReplayIssueReason = (issues: readonly z.core.$ZodIssue[]): InventoryReplayReasonV2DTO["code"] => {
  const messages = new Set(issues.map((issue) => issue.message));
  if (messages.has("REPLAY_TOTAL_CAPACITY")) return "INVENTORY_REPLAY_TOTAL_HISTORY_CAPACITY_EXCEEDED";
  if (messages.has("REPLAY_CHUNK_CAPACITY")) return "INVENTORY_REPLAY_CHUNK_EVENT_CAPACITY_EXCEEDED";
  if (messages.has("REPLAY_SCOPE")) return "INVENTORY_REPLAY_SCOPE_MISMATCH";
  if (messages.has("REPLAY_BEFORE")) return "INVENTORY_REPLAY_BEFORE_MISMATCH";
  if (messages.has("REPLAY_PREVIOUS_DIGEST")) return "INVENTORY_REPLAY_PREVIOUS_EVENT_DIGEST_MISMATCH";
  if (messages.has("REPLAY_CHECKPOINT")) return "INVENTORY_REPLAY_CHECKPOINT_MISMATCH";
  if (messages.has("REPLAY_FINALIZATION")) return "INVENTORY_REPLAY_FINALIZATION_INVALID";
  if (messages.has("REPLAY_TERMINAL_DIGEST")) return "INVENTORY_REPLAY_TERMINAL_EVENT_DIGEST_MISMATCH";
  if (messages.has("REPLAY_CHUNK_ORDER")) return "INVENTORY_REPLAY_CHUNK_SEQUENCE_OR_ORDER_INVALID";
  return inventoryReplayIssuesContainEventPath(issues) ? "INVENTORY_REPLAY_EVENT_SHAPE_INVALID" : "INVENTORY_REPLAY_INPUT_SHAPE_INVALID";
};

/** Canonical, bounded raw-JSON replay trust boundary. */
export const parseInventoryReplayChunkInputV2 = (input: string): InventoryReplayChunkParseResultV2 => {
  const decoded = parseStage09pReplayChunkJsonText(input, "inventory");
  if (!decoded.ok) {
    const code = decoded.reason === "INPUT_DESCRIPTOR_INVALID" ? "INVENTORY_REPLAY_INPUT_DESCRIPTOR_INVALID"
      : decoded.reason === "INPUT_JSON_SYNTAX_INVALID" ? "INVENTORY_REPLAY_JSON_SYNTAX_INVALID"
        : decoded.reason === "INPUT_CANONICAL_NUMBER_INVALID" ? "INVENTORY_REPLAY_CANONICAL_NUMBER_INVALID"
          : decoded.reason === "INPUT_WIRE_BYTE_CAPACITY_EXCEEDED" ? "INVENTORY_REPLAY_WIRE_BYTE_CAPACITY_EXCEEDED"
            : decoded.reason === "INPUT_CHUNK_EVENT_CAPACITY_EXCEEDED" ? "INVENTORY_REPLAY_CHUNK_EVENT_CAPACITY_EXCEEDED"
              : "INVENTORY_REPLAY_INPUT_RESOURCE_LIMIT_EXCEEDED";
    return { ok: false, reason: inventoryReason(inventoryReplayReasonRows, code) };
  }
  const parsed = inventoryReplayChunkInputV2Schema.safeParse(decoded.value);
  if (!parsed.success) return { ok: false, reason: inventoryReason(inventoryReplayReasonRows, inventoryReplayIssueReason(parsed.error.issues)) };
  return { ok: true, value: deepFreezeStage09pOwnedData(parsed.data) };
};

const normalizeDecimal = (v: string): string => { const [whole = "0", fraction = ""] = v.split("."); const trimmed = fraction.replace(/0+$/, ""); return trimmed.length === 0 ? whole : `${whole}.${trimmed}`; };
export type InventoryNormalizationResultV2 = { readonly ok: true; readonly value: NormalizedInventoryCommandBodyV2DTO } | { readonly ok: false; readonly reason: InventoryNormalizationReasonV2DTO };
const rejectedInventoryNormalizationDraft = (input: unknown): InventoryNormalizationResultV2 => { void input; return { ok: false, reason: inventoryReason(inventoryNormalizationReasonRows, "INVENTORY_NORMALIZE_ARRAY_ITEM_INVALID") }; };

const normalizationFailure = (
  code: InventoryNormalizationReasonV2DTO["code"],
): InventoryNormalizationResultV2 => ({
  ok: false,
  reason: inventoryReason(inventoryNormalizationReasonRows, code),
});

const commandNames = new Set<string>(Object.keys(rawPayload));
const topKeys = new Set(["schemaVersion", "type", "source", "householdId", "inventoryLotId", "expectedVersion", "observedAt", "payload", "note"]);
const payloadKeys: Readonly<Record<CommandType, readonly string[]>> = {
  acquire: ["lotDisplayName", "binding", "storageLocation", "quantity", "dates", "initialOpened", "initialFrozen"],
  produce: ["lotDisplayName", "binding", "storageLocation", "quantity", "dates", "preparedAt", "initialOpened", "initialFrozen"],
  open: ["openedAt"], consume: ["consumption"], discard: ["reason"], move: ["destination"], freeze: ["frozenAt"], thaw: ["destination", "thawedAt"], adjust: ["quantity"], change_dates: ["changes"], change_food_concept_binding: ["binding"], correct: ["targetEventId", "intents"],
};
const supportedDateKinds = new Set(["purchase_date", "production_date", "best_before_date", "use_by_date", "prepared_at", "opened_at", "frozen_at", "thawed_at"]);

const decimalProblem = (value: unknown, positive: boolean): InventoryNormalizationReasonV2DTO["code"] | null => {
  if (typeof value === "number") return Number.isFinite(value) ? "INVENTORY_NORMALIZE_DECIMAL_TYPE_INVALID" : "INVENTORY_NORMALIZE_DECIMAL_NONFINITE";
  if (typeof value !== "string") return "INVENTORY_NORMALIZE_DECIMAL_TYPE_INVALID";
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return "INVENTORY_NORMALIZE_DECIMAL_SYNTAX_INVALID";
  const fields = value.split(".");
  if ((fields[0]?.length ?? 0) > 9 || (fields[1]?.length ?? 0) > 6) return "INVENTORY_NORMALIZE_DECIMAL_RANGE_EXCEEDED";
  if (positive && normalizeDecimal(value) === "0") return "INVENTORY_NORMALIZE_DECIMAL_ZERO_FORBIDDEN";
  return null;
};

const dateProblem = (items: unknown, maximum: number, allowed: ReadonlySet<string>): InventoryNormalizationReasonV2DTO["code"] | null => {
  if (!Array.isArray(items)) return "INVENTORY_NORMALIZE_ARRAY_ITEM_INVALID";
  const facts = items.map((item) => {
    if (!isSafeRecord(item)) return { item, kind: undefined, date: undefined };
    const operation = readSafeOwn(item, "operation");
    const date = operation === "set" ? readSafeOwn(item, "date") : item;
    const kind = operation === "remove" ? readSafeOwn(item, "kind") : readSafeOwn(date, "kind");
    return { item, kind, date };
  });
  if (facts.some((fact) => fact.kind === "estimated_use_by_date")) return "INVENTORY_NORMALIZE_DATE_KIND_UNSUPPORTED_CURRENT_VERSION";
  if (items.length > maximum) return "INVENTORY_NORMALIZE_DATE_OPERATION_LIMIT_EXCEEDED";
  const stringKinds = facts.map((fact) => fact.kind).filter((kind): kind is string => typeof kind === "string");
  if (new Set(stringKinds).size !== stringKinds.length) return "INVENTORY_NORMALIZE_DATE_OPERATION_DUPLICATE";
  for (const fact of facts) {
    if (!isSafeRecord(fact.item)) return "INVENTORY_NORMALIZE_ARRAY_ITEM_INVALID";
    if (typeof fact.kind !== "string" || !supportedDateKinds.has(fact.kind)) return "INVENTORY_NORMALIZE_DATE_KIND_INVALID";
    if (!allowed.has(fact.kind)) return "INVENTORY_NORMALIZE_DATE_KIND_NOT_ALLOWED_FOR_COMMAND";
    const operation = readSafeOwn(fact.item, "operation");
    if (operation === "remove") continue;
    if (!isSafeRecord(fact.date)) return "INVENTORY_NORMALIZE_ARRAY_ITEM_INVALID";
    const value = readSafeOwn(fact.date, "value");
    const timestamp = fact.kind.endsWith("_at");
    if (typeof value !== "string" || !(timestamp ? rawInstant.safeParse(value).success : localDate.safeParse(value).success)) return "INVENTORY_NORMALIZE_DATE_VALUE_INVALID";
    const source = readSafeOwn(fact.date, "source");
    if (!isSafeRecord(source) || typeof readSafeOwn(source, "kind") !== "string") return "INVENTORY_NORMALIZE_DATE_SOURCE_INVALID";
    const sourceKind = readSafeOwn(source, "kind");
    const allowedSources = fact.kind === "purchase_date"
      ? ["user_input", "confirmed_recognition"]
      : fact.kind.endsWith("_at")
        ? ["user_input", "confirmed_recognition"]
        : ["package_label", "user_input", "confirmed_recognition"];
    if (!allowedSources.includes(String(sourceKind))) return "INVENTORY_NORMALIZE_DATE_SOURCE_INVALID";
    const reference = readSafeOwn(source, "reference");
    if (reference !== null && typeof reference !== "string") return "INVENTORY_NORMALIZE_DATE_REFERENCE_INVALID";
  }
  return null;
};

const copyCanonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(copyCanonical);
  if (!isSafeRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "amount" && typeof child === "string") output[key] = normalizeDecimal(child);
    else if (key === "value" && typeof child === "string" && child.includes("T")) output[key] = canonicalizeStage09pInstant(child) ?? child;
    else output[key] = copyCanonical(child);
  }
  return output;
};

export const normalizeInventoryCommandBodyV2 = (input: unknown): InventoryNormalizationResultV2 => {
  const copied = copyStage09pInput(input);
  if (!copied.ok) return normalizationFailure(copied.reason === "INPUT_RESOURCE_LIMIT_EXCEEDED" ? "INVENTORY_NORMALIZE_INPUT_RESOURCE_LIMIT_EXCEEDED" : "INVENTORY_NORMALIZE_INPUT_DESCRIPTOR_INVALID");
  if (!isSafeRecord(copied.value)) return normalizationFailure("INVENTORY_NORMALIZE_BODY_NOT_OBJECT");
  for (const key of Object.keys(copied.value)) if (!topKeys.has(key)) return normalizationFailure("INVENTORY_NORMALIZE_TOP_LEVEL_UNKNOWN_KEY");
  if (readSafeOwn(copied.value, "schemaVersion") !== 2) return normalizationFailure("INVENTORY_NORMALIZE_SCHEMA_VERSION_INVALID");
  const rawType = readSafeOwn(copied.value, "type");
  if (rawType === undefined) return normalizationFailure("INVENTORY_NORMALIZE_COMMAND_TYPE_MISSING");
  if (typeof rawType !== "string" || !commandNames.has(rawType)) return normalizationFailure("INVENTORY_NORMALIZE_COMMAND_TYPE_UNSUPPORTED");
  const type = rawType as CommandType;
  if (readSafeOwn(copied.value, "source") !== "manual_confirmation") return normalizationFailure("INVENTORY_NORMALIZE_SOURCE_INVALID");
  if (!householdIdSchema.safeParse(readSafeOwn(copied.value, "householdId")).success || !inventoryLotIdSchema.safeParse(readSafeOwn(copied.value, "inventoryLotId")).success) return normalizationFailure("INVENTORY_NORMALIZE_SCOPE_INVALID");
  if (!pgIntSchema.safeParse(readSafeOwn(copied.value, "expectedVersion")).success) return normalizationFailure("INVENTORY_NORMALIZE_VERSION_INVALID");
  if (!rawOccurrence.safeParse(readSafeOwn(copied.value, "observedAt")).success) return normalizationFailure("INVENTORY_NORMALIZE_OCCURRENCE_INVALID");
  if (!postgresTextSchema(0, 500).nullable().safeParse(readSafeOwn(copied.value, "note")).success) return normalizationFailure("INVENTORY_NORMALIZE_NOTE_INVALID");
  const payload = readSafeOwn(copied.value, "payload");
  if (!isSafeRecord(payload)) return normalizationFailure("INVENTORY_NORMALIZE_PAYLOAD_NOT_OBJECT");
  const expectedKeys = payloadKeys[type];
  for (const key of Object.keys(payload)) if (!expectedKeys.includes(key)) return normalizationFailure("INVENTORY_NORMALIZE_PAYLOAD_UNKNOWN_KEY");
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) return normalizationFailure("INVENTORY_NORMALIZE_REQUIRED_FIELD_MISSING");
    if (readSafeOwn(payload, key) === null && !(type === "discard" && key === "reason")) return normalizationFailure("INVENTORY_NORMALIZE_NULL_NOT_ALLOWED");
  }
  if ((type === "acquire" || type === "produce") && !postgresTextSchema(1, 120).safeParse(readSafeOwn(payload, "lotDisplayName")).success) return normalizationFailure("INVENTORY_NORMALIZE_TEXT_INVALID");
  const quantity = type === "consume" ? readSafeOwn(payload, "consumption") : (type === "acquire" || type === "produce" || type === "adjust") ? readSafeOwn(payload, "quantity") : undefined;
  if (quantity !== undefined) {
    if (!isSafeRecord(quantity) || !["exact", "approximate", "qualitative"].includes(String(readSafeOwn(quantity, "kind")))) return normalizationFailure("INVENTORY_NORMALIZE_QUANTITY_KIND_INVALID");
    const kind = readSafeOwn(quantity, "kind");
    if (kind === "exact" || kind === "approximate") {
      const problem = decimalProblem(readSafeOwn(quantity, "amount"), true); if (problem !== null) return normalizationFailure(problem);
      if (!unit.safeParse(readSafeOwn(quantity, "unit")).success) return normalizationFailure("INVENTORY_NORMALIZE_UNIT_INVALID");
      if (kind === "approximate" && !confidence.safeParse(readSafeOwn(quantity, "confidence")).success) return normalizationFailure("INVENTORY_NORMALIZE_CONFIDENCE_INVALID");
    } else if (type !== "consume" && !["plenty", "some", "low", "unknown"].includes(String(readSafeOwn(quantity, "level")))) return normalizationFailure("INVENTORY_NORMALIZE_QUALITATIVE_LEVEL_INVALID");
  }
  if (type === "acquire" || type === "produce") {
    const allowed = new Set(type === "acquire" ? ["purchase_date", "production_date", "best_before_date", "use_by_date"] : ["production_date", "best_before_date", "use_by_date"]);
    const problem = dateProblem(readSafeOwn(payload, "dates"), type === "acquire" ? 4 : 3, allowed); if (problem !== null) return normalizationFailure(problem);
    const initialFrozenValue = readSafeOwn(payload, "initialFrozen");
    if (!isSafeRecord(initialFrozenValue) || !["not_frozen", "frozen"].includes(String(readSafeOwn(initialFrozenValue, "state")))) return normalizationFailure("INVENTORY_NORMALIZE_INITIAL_OBSERVATION_INVALID");
    if ((readSafeOwn(payload, "storageLocation") === "frozen") !== (readSafeOwn(initialFrozenValue, "state") === "frozen")) return normalizationFailure("INVENTORY_NORMALIZE_INITIAL_STATE_CONFLICT");
  }
  if (type === "change_dates") { const problem = dateProblem(readSafeOwn(payload, "changes"), 8, supportedDateKinds); if (problem !== null) return normalizationFailure(problem); }
  if ((type === "acquire" || type === "produce" || type === "change_food_concept_binding") && !binding.safeParse(readSafeOwn(payload, "binding")).success) return normalizationFailure("INVENTORY_NORMALIZE_BINDING_INVALID");
  if (type === "correct") {
    if (!inventoryEventIdSchema.safeParse(readSafeOwn(payload, "targetEventId")).success) return normalizationFailure("INVENTORY_NORMALIZE_CORRECTION_TARGET_INVALID");
    const intents = readSafeOwn(payload, "intents");
    if (!Array.isArray(intents)) return normalizationFailure("INVENTORY_NORMALIZE_ARRAY_ITEM_INVALID");
    if (intents.length === 0) return normalizationFailure("INVENTORY_NORMALIZE_CORRECTION_INTENTS_EMPTY");
    if (intents.length > 6) return normalizationFailure("INVENTORY_NORMALIZE_CORRECTION_INTENT_LIMIT_EXCEEDED");
    const axes = intents.map((intent) => readSafeOwn(intent, "axis"));
    const strings = axes.filter((axis): axis is string => typeof axis === "string");
    if (new Set(strings).size !== strings.length) return normalizationFailure("INVENTORY_NORMALIZE_CORRECTION_AXIS_DUPLICATE");
    if (strings.some((axis) => !["binding", "quantity", "state", "dates", "seal_state", "storage"].includes(axis))) return normalizationFailure("INVENTORY_NORMALIZE_CORRECTION_AXIS_INVALID");
    if (intents.some((intent) => !isSafeRecord(intent) || !isSafeRecord(readSafeOwn(intent, "guard")))) return normalizationFailure("INVENTORY_NORMALIZE_CORRECTION_GUARD_INVALID");
    if (intents.some((intent) => {
      if (!isSafeRecord(intent)) return true;
      const axis = readSafeOwn(intent, "axis");
      return axis === "dates"
        ? !Array.isArray(readSafeOwn(intent, "changes"))
        : readSafeOwn(intent, "after") === undefined || readSafeOwn(intent, "after") === null;
    })) return normalizationFailure("INVENTORY_NORMALIZE_CORRECTION_AFTER_INVALID");
    for (const intent of intents) {
      if (readSafeOwn(intent, "axis") !== "dates") continue;
      const problem = dateProblem(readSafeOwn(intent, "changes"), 8, supportedDateKinds);
      if (problem !== null) return normalizationFailure(problem);
    }
  }
  const raw = rawInventoryCommandBodyV2Schema.safeParse(copied.value);
  if (!raw.success) return normalizationFailure("INVENTORY_NORMALIZE_ARRAY_ITEM_INVALID");
  const candidate = copyCanonical(raw.data);
  if (isSafeRecord(candidate) && isSafeRecord(readSafeOwn(candidate, "payload"))) {
    const nextPayload = readSafeOwn(candidate, "payload") as Record<string, unknown>;
    const sortDates = (dates: unknown[]): void => { dates.sort((a, b) => dateOrder.indexOf(String(readSafeOwn(a, "kind")) as (typeof dateOrder)[number]) - dateOrder.indexOf(String(readSafeOwn(b, "kind")) as (typeof dateOrder)[number])); };
    const sortChanges = (changes: unknown[]): void => { changes.sort((a, b) => {
      const operationA = readSafeOwn(a, "operation"); const operationB = readSafeOwn(b, "operation");
      const kindA = operationA === "set" ? readSafeOwn(readSafeOwn(a, "date"), "kind") : readSafeOwn(a, "kind");
      const kindB = operationB === "set" ? readSafeOwn(readSafeOwn(b, "date"), "kind") : readSafeOwn(b, "kind");
      return dateOrder.indexOf(String(kindA) as (typeof dateOrder)[number]) - dateOrder.indexOf(String(kindB) as (typeof dateOrder)[number]);
    }); };
    const dates = readSafeOwn(nextPayload, "dates"); if (Array.isArray(dates)) sortDates(dates);
    const changes = readSafeOwn(nextPayload, "changes"); if (Array.isArray(changes)) sortChanges(changes);
    const intents = readSafeOwn(nextPayload, "intents");
    if (Array.isArray(intents)) {
      intents.sort((a, b) => correctionAxisOrder.indexOf(String(readSafeOwn(a, "axis")) as (typeof correctionAxisOrder)[number]) - correctionAxisOrder.indexOf(String(readSafeOwn(b, "axis")) as (typeof correctionAxisOrder)[number]));
      for (const intent of intents) { const nested = readSafeOwn(intent, "changes"); if (Array.isArray(nested)) sortChanges(nested); }
    }
  }
  const normalized = normalizedInventoryCommandBodyV2Schema.safeParse(candidate);
  return normalized.success ? { ok: true, value: Object.freeze(normalized.data) } : normalizationFailure("INVENTORY_NORMALIZE_ARRAY_ITEM_INVALID");
};

export type InventoryV2ContractRuleSchemaBinding = ContractRuleSchemaBinding<InventoryV2ContractRuleId>;
export type InventoryV2ContractRuleBinding = Omit<InventoryV2ContractRuleSchemaBinding, "schema">;
export const inventoryV2ContractRuleSchemaBindings = inventoryV2ContractRuleRegistry.getContractRuleSchemaBindings();
export const validateInventoryV2ContractRuleSchemaBindings = inventoryV2ContractRuleRegistry.validateContractRuleSchemaBindings;
validateInventoryV2ContractRuleSchemaBindings(inventoryV2ContractRuleSchemaBindings);
export const inventoryV2ContractRuleBindings: readonly InventoryV2ContractRuleBinding[] =
  inventoryV2ContractRuleSchemaBindings.map(({ boundary, ruleIds }) => ({ boundary, ruleIds }));
