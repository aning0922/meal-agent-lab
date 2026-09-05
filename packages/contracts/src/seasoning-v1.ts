import { z } from "zod";

import { foodConceptIdSchema, householdIdSchema, inventoryEventIdSchema, postgresTextSchema, userIdSchema } from "./primitives.js";
import {
  createContractRuleSchemaRegistry,
  type ContractRuleSchemaBinding,
} from "./contract-rule-registry.js";
import type { ContractRule } from "./refinement-rules.js";
import { canonicalizeStage09pInstant, copyStage09pInput, deepFreezeStage09pOwnedData, type DeepReadonly, isSafeRecord, isStage09pCanonicalInstant, isStage09pPgInt, isStage09pPgIntSuccessor, isStage09pRawInstant, isStage09pSchemaInputDataGraph, maxReplayChunkUtf8Bytes, maxSeasoningReplayEventsPerChunk, maxTotalReplayEvents, parseStage09pReplayChunkJsonText, readSafeOwn } from "./stage09p-input.js";

export const seasoningV1ContractRuleManifest = [
  { id: "seasoning.v1.pgint-range.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Seasoning V1 PgInt does not exceed the PostgreSQL bigint maximum" },
  { id: "seasoning.v1.positive-pgint-range.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Seasoning V1 positive PgInt does not exceed the PostgreSQL bigint maximum" },
  { id: "seasoning.v1.raw-instant-components.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Seasoning V1 raw instants have valid components and normalize inside UTC years 0001 through 9999" },
  { id: "seasoning.v1.canonical-instant.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Seasoning V1 canonical instants use exact UTC millisecond text in years 0001 through 9999" },
  { id: "seasoning.v1.stored-event-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Seasoning V1 stored event counters and before semantics are consistent" },
  { id: "seasoning.v1.history-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Seasoning V1 history has one scope, one binding and a contiguous before chain" },
  { id: "seasoning.v1.aggregate-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Seasoning V1 aggregate correlates observation metadata and history tip" },
  { id: "seasoning.v1.decision-correlation.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "Seasoning V1 decisions correlate core, event, receipt, projection and history" },
  { id: "seasoning.v1.replay-chunk-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "one caller-supplied Seasoning V1 replay chunk has locally consistent scope, order, count, digest and finalization; it does not attest cross-request truth" },
  { id: "seasoning.v1.replay-server-checkpoint-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "a Seasoning V1 server-verified replay checkpoint has locally consistent count, continuation and finalization state" },
  { id: "seasoning.v1.replay-chunk-result-consistency.v1", sourceKind: "refinement", enforcement: "runtime-only", description: "a Seasoning V1 replay result kind agrees with the status of its server-verified checkpoint" },
] as const satisfies readonly ContractRule[];

export type SeasoningV1ContractRuleId = (typeof seasoningV1ContractRuleManifest)[number]["id"];
const seasoningV1ContractRuleRegistry = createContractRuleSchemaRegistry(seasoningV1ContractRuleManifest);
const { ruleRefine, ruleSuperRefine } = seasoningV1ContractRuleRegistry;

export const seasoningContractSchemaVersion = "seasoning-v1" as const;
export const SEASONING_HISTORY_MAX_V1 = 10_000 as const;
export const seasoningMaxReplayChunkUtf8BytesV1 = maxReplayChunkUtf8Bytes;
export const seasoningMaxEventsPerChunkV1 = maxSeasoningReplayEventsPerChunk;
export const seasoningMaxTotalReplayEventsV1 = maxTotalReplayEvents;
export const seasoningReplayChunkLimitsV1 = Object.freeze({
  maxReplayChunkUtf8Bytes: seasoningMaxReplayChunkUtf8BytesV1,
  maxEventsPerChunk: seasoningMaxEventsPerChunkV1,
  maxTotalReplayEvents: seasoningMaxTotalReplayEventsV1,
});
type Row<C extends string = string, O extends number = number> = Readonly<{ code: C; ordinal: O }>;
const schemaFor = <const R extends readonly [Row, Row, ...Row[]]>(rows: R): z.ZodType<R[number]> => {
  const first = rows[0]; const second = rows[1];
  const tail = rows.slice(2).map((row) => z.strictObject({ code: z.literal(row.code), ordinal: z.literal(row.ordinal) }));
  return z.union([z.strictObject({ code: z.literal(first.code), ordinal: z.literal(first.ordinal) }), z.strictObject({ code: z.literal(second.code), ordinal: z.literal(second.ordinal) }), ...tail] as [z.ZodType<R[number]>, z.ZodType<R[number]>, ...z.ZodType<R[number]>[]]);
};
const reason = <R extends readonly Row[]>(rows: R, code: R[number]["code"]): R[number] => { const found = rows.find((row) => row.code === code); if (found === undefined) throw new TypeError("UNKNOWN_SEASONING_REASON"); return found; };

export const seasoningNormalizationReasonRows = Object.freeze([
  { code: "SEASONING_NORMALIZE_INPUT_DESCRIPTOR_INVALID", ordinal: 19_000 },
  { code: "SEASONING_NORMALIZE_BODY_NOT_OBJECT", ordinal: 19_001 },
  { code: "SEASONING_NORMALIZE_UNKNOWN_KEY", ordinal: 19_002 },
  { code: "SEASONING_NORMALIZE_SCHEMA_VERSION_INVALID", ordinal: 19_003 },
  { code: "SEASONING_NORMALIZE_TYPE_INVALID", ordinal: 19_004 },
  { code: "SEASONING_NORMALIZE_SOURCE_INVALID", ordinal: 19_005 },
  { code: "SEASONING_NORMALIZE_HOUSEHOLD_ID_INVALID", ordinal: 19_006 },
  { code: "SEASONING_NORMALIZE_ID_INVALID", ordinal: 19_007 },
  { code: "SEASONING_NORMALIZE_VERSION_INVALID", ordinal: 19_008 },
  { code: "SEASONING_NORMALIZE_OBSERVED_AT_INVALID", ordinal: 19_009 },
  { code: "SEASONING_NORMALIZE_BINDING_INVALID", ordinal: 19_010 },
  { code: "SEASONING_NORMALIZE_OBSERVATION_INVALID", ordinal: 19_011 },
  { code: "SEASONING_NORMALIZE_INPUT_RESOURCE_LIMIT_EXCEEDED", ordinal: 19_012 },
] as const);
export const seasoningCommandReasonRows = Object.freeze([
  { code: "SEASONING_COMMAND_SCOPE_MISMATCH", ordinal: 23_000 },
  { code: "SEASONING_COMMAND_VERSION_CONFLICT", ordinal: 23_001 },
  { code: "SEASONING_COMMAND_AUTHORITY_UNSUPPORTED", ordinal: 23_002 },
  { code: "SEASONING_COMMAND_LEGACY_BINDING_READ_ONLY", ordinal: 23_003 },
  { code: "SEASONING_COMMAND_BINDING_MISMATCH", ordinal: 23_004 },
  { code: "SEASONING_COMMAND_HISTORY_CAPACITY_EXCEEDED", ordinal: 23_005 },
  { code: "SEASONING_COMMAND_COUNTER_OVERFLOW", ordinal: 23_006 },
] as const);
export const seasoningHistoryReasonRows = Object.freeze([
  { code: "SEASONING_HISTORY_SHAPE_INVALID", ordinal: 24_000 },
  { code: "SEASONING_HISTORY_FIRST_EVENT_INVALID", ordinal: 24_001 },
  { code: "SEASONING_HISTORY_SCOPE_MISMATCH", ordinal: 24_002 },
  { code: "SEASONING_HISTORY_SEQUENCE_BREAK", ordinal: 24_003 },
  { code: "SEASONING_HISTORY_VERSION_BREAK", ordinal: 24_004 },
  { code: "SEASONING_HISTORY_DIGEST_CHAIN_BREAK", ordinal: 24_005 },
  { code: "SEASONING_HISTORY_BEFORE_CHAIN_BREAK", ordinal: 24_006 },
  { code: "SEASONING_HISTORY_BINDING_CHANGED", ordinal: 24_007 },
  { code: "SEASONING_HISTORY_CAPACITY_EXCEEDED", ordinal: 24_008 },
  { code: "SEASONING_HISTORY_PROJECTION_MISMATCH", ordinal: 24_009 },
] as const);
export const seasoningReplayReasonRows = Object.freeze([
  { code: "SEASONING_REPLAY_INPUT_DESCRIPTOR_INVALID", ordinal: 25_000 },
  { code: "SEASONING_REPLAY_INPUT_SHAPE_INVALID", ordinal: 25_001 },
  { code: "SEASONING_REPLAY_HISTORY_CAPACITY_EXCEEDED", ordinal: 25_002 },
  { code: "SEASONING_REPLAY_EVENT_SHAPE_INVALID", ordinal: 25_003 },
  { code: "SEASONING_REPLAY_SCOPE_MISMATCH", ordinal: 25_004 },
  { code: "SEASONING_REPLAY_BEFORE_MISMATCH", ordinal: 25_005 },
  { code: "SEASONING_REPLAY_INPUT_RESOURCE_LIMIT_EXCEEDED", ordinal: 25_006 },
  { code: "SEASONING_REPLAY_WIRE_BYTE_CAPACITY_EXCEEDED", ordinal: 25_007 },
  { code: "SEASONING_REPLAY_CHUNK_EVENT_CAPACITY_EXCEEDED", ordinal: 25_008 },
  { code: "SEASONING_REPLAY_TOTAL_HISTORY_CAPACITY_EXCEEDED", ordinal: 25_009 },
  { code: "SEASONING_REPLAY_CHUNK_SEQUENCE_OR_ORDER_INVALID", ordinal: 25_010 },
  { code: "SEASONING_REPLAY_PREVIOUS_EVENT_DIGEST_MISMATCH", ordinal: 25_011 },
  { code: "SEASONING_REPLAY_CHECKPOINT_MISMATCH", ordinal: 25_012 },
  { code: "SEASONING_REPLAY_FINALIZATION_INVALID", ordinal: 25_013 },
  { code: "SEASONING_REPLAY_TERMINAL_EVENT_DIGEST_MISMATCH", ordinal: 25_014 },
  { code: "SEASONING_REPLAY_CANONICAL_NUMBER_INVALID", ordinal: 25_015 },
  { code: "SEASONING_REPLAY_JSON_SYNTAX_INVALID", ordinal: 25_016 },
] as const);
export const seasoningV1ReasonRows = Object.freeze([...seasoningNormalizationReasonRows, ...seasoningCommandReasonRows, ...seasoningHistoryReasonRows, ...seasoningReplayReasonRows] as const);
for (const row of seasoningV1ReasonRows) Object.freeze(row);
if (new Set(seasoningV1ReasonRows.map((row) => row.code)).size !== seasoningV1ReasonRows.length || new Set(seasoningV1ReasonRows.map((row) => row.ordinal)).size !== seasoningV1ReasonRows.length) throw new TypeError("DUPLICATE_SEASONING_REASON");
export const seasoningNormalizationReasonV1Schema = schemaFor(seasoningNormalizationReasonRows);
export const seasoningCommandReasonV1Schema = schemaFor(seasoningCommandReasonRows);
export const seasoningHistoryReasonV1Schema = schemaFor(seasoningHistoryReasonRows);
export const seasoningReplayReasonV1Schema = schemaFor(seasoningReplayReasonRows);
export type SeasoningNormalizationReasonV1DTO = z.infer<typeof seasoningNormalizationReasonV1Schema>;
export type SeasoningCommandReasonV1DTO = z.infer<typeof seasoningCommandReasonV1Schema>;
export type SeasoningHistoryReasonV1DTO = z.infer<typeof seasoningHistoryReasonV1Schema>;
export type SeasoningReplayReasonV1DTO = z.infer<typeof seasoningReplayReasonV1Schema>;

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const commandId = z.uuidv7().brand<"SeasoningCommandIdV1">();
const seasoningId = z.uuidv7().brand<"SeasoningIdV1">();
const pgInt = ruleRefine(z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/), "seasoning.v1.pgint-range.v1", "seasoningPgIntV1Schema", (v) => isStage09pPgInt(v));
const positivePgInt = ruleRefine(z.string().regex(/^[1-9][0-9]{0,18}$/), "seasoning.v1.positive-pgint-range.v1", "seasoningPositivePgIntV1Schema", (v) => isStage09pPgInt(v, true));
const rawInstant = ruleRefine(z.iso.datetime({ offset: true }), "seasoning.v1.raw-instant-components.v1", "seasoningRawInstantV1Schema", isStage09pRawInstant);
const canonicalInstant = ruleRefine(z.iso.datetime(), "seasoning.v1.canonical-instant.v1", "seasoningCanonicalInstantV1Schema", isStage09pCanonicalInstant);
const occurrence = <S extends z.ZodType>(s: S) => z.union([z.strictObject({ mode: z.literal("server_time") }), z.strictObject({ mode: z.literal("observed"), value: s })]);
const concept = z.strictObject({ datasetId: postgresTextSchema(1, 120), foodConceptId: foodConceptIdSchema, entityRevision: positivePgInt, releaseDigest: digest });
const inputBinding = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("unbound"), bindingDisplayLabel: postgresTextSchema(1, 120) }), z.strictObject({ kind: z.literal("bound"), bindingDisplayLabel: postgresTextSchema(1, 120), concept })]);
const storedBinding = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("unbound"), bindingDisplayLabel: postgresTextSchema(1, 120) }), z.strictObject({ kind: z.literal("bound"), bindingDisplayLabel: postgresTextSchema(1, 120), concept, authority: z.enum(["caller_claimed", "legacy_unverified"]) })]);
const observation = z.enum(["have", "low", "none", "unknown"]);

export const rawSeasoningCommandBodyV1Schema = z.strictObject({ schemaVersion: z.literal(1), type: z.literal("observe_seasoning"), source: z.literal("manual_confirmation"), householdId: householdIdSchema, seasoningId, expectedVersion: pgInt, observedAt: occurrence(rawInstant), binding: inputBinding, observation });
export const normalizedSeasoningCommandBodyV1Schema = z.strictObject({ schemaVersion: z.literal(1), type: z.literal("observe_seasoning"), source: z.literal("manual_confirmation"), householdId: householdIdSchema, seasoningId, expectedVersion: pgInt, observedAt: occurrence(canonicalInstant), binding: inputBinding, observation });
export type RawSeasoningCommandBodyV1DTO = z.infer<typeof rawSeasoningCommandBodyV1Schema>;
export type NormalizedSeasoningCommandBodyV1DTO = z.infer<typeof normalizedSeasoningCommandBodyV1Schema>;

export const seasoningProjectionV1Schema = z.strictObject({ schemaVersion: z.literal(1), householdId: householdIdSchema, seasoningId, binding: storedBinding, presence: observation, observedAt: canonicalInstant, observedByUserId: userIdSchema, version: positivePgInt, lastEventSequence: positivePgInt, projectionDigest: digest });
export const seasoningEventCoreV1Schema = z.strictObject({ schemaVersion: z.literal(1), eventId: inventoryEventIdSchema, commandId, type: z.literal("seasoning_observed"), source: z.literal("manual_confirmation"), householdId: householdIdSchema, seasoningId, actorUserId: userIdSchema, observedAt: canonicalInstant, payload: z.strictObject({ binding: storedBinding, before: observation.nullable(), after: observation }) });
const storedEventBase = seasoningEventCoreV1Schema.extend({ eventCoreDigest: digest, sequence: positivePgInt, expectedVersion: pgInt, resultingVersion: positivePgInt, recordedAt: canonicalInstant, previousEventDigest: digest.nullable(), resultingProjectionDigest: digest, eventDigest: digest });
export const storedSeasoningEventV1Schema = ruleSuperRefine(storedEventBase, "seasoning.v1.stored-event-consistency.v1", "storedSeasoningEventV1Schema", (e, ctx) => { if (!isStage09pPgIntSuccessor(e.expectedVersion, e.resultingVersion)) ctx.addIssue({ code: "custom", path: ["resultingVersion"], message: "VERSION_BREAK" }); if ((e.expectedVersion === "0") !== (e.previousEventDigest === null)) ctx.addIssue({ code: "custom", path: ["previousEventDigest"], message: "CHAIN_NULLABILITY" }); if (e.expectedVersion === "0" && e.payload.before !== null) ctx.addIssue({ code: "custom", path: ["payload", "before"], message: "FIRST_BEFORE" }); });
export type StoredSeasoningEventV1DTO = z.infer<typeof storedSeasoningEventV1Schema>;

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  if (!isSafeRecord(left) || !isSafeRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && equal(readSafeOwn(left, key), readSafeOwn(right, key)));
};
const emptyHistory = z.strictObject({ kind: z.literal("empty"), events: z.tuple([]), historyDigest: z.null() });
const historyBase = z.strictObject({ kind: z.literal("nonempty"), events: z.array(storedSeasoningEventV1Schema).min(1).max(SEASONING_HISTORY_MAX_V1), historyDigest: digest });
const refinedHistory = ruleSuperRefine(historyBase, "seasoning.v1.history-consistency.v1", "refinedNonemptySeasoningHistoryV1Schema", (h, ctx) => { const eventIds = new Set<string>(); const commandIds = new Set<string>(); h.events.forEach((e, i) => { if (eventIds.has(e.eventId) || commandIds.has(e.commandId)) ctx.addIssue({ code: "custom", path: ["events", i], message: "DUPLICATE_ID" }); eventIds.add(e.eventId); commandIds.add(e.commandId); if (i === 0) { if (e.sequence !== "1" || e.expectedVersion !== "0" || e.previousEventDigest !== null || e.payload.before !== null) ctx.addIssue({ code: "custom", path: ["events", 0], message: "FIRST_EVENT" }); return; } const p = h.events[i - 1]; if (p === undefined) return; if (e.householdId !== p.householdId || e.seasoningId !== p.seasoningId || !isStage09pPgIntSuccessor(p.sequence, e.sequence) || e.expectedVersion !== p.resultingVersion || e.previousEventDigest !== p.eventDigest) ctx.addIssue({ code: "custom", path: ["events", i], message: "CHAIN" }); if (e.payload.before !== p.payload.after) ctx.addIssue({ code: "custom", path: ["events", i, "payload", "before"], message: "BEFORE" }); if (!equal(e.payload.binding, p.payload.binding)) ctx.addIssue({ code: "custom", path: ["events", i, "payload", "binding"], message: "BINDING" }); }); });
export const seasoningHistoryV1Schema = z.union([emptyHistory, refinedHistory]);
const absent = z.strictObject({ presence: z.literal("absent"), householdId: householdIdSchema, seasoningId, projection: z.null(), history: emptyHistory });
const presentBase = z.strictObject({ presence: z.literal("present"), householdId: householdIdSchema, seasoningId, projection: seasoningProjectionV1Schema, history: refinedHistory });
const present = ruleSuperRefine(presentBase, "seasoning.v1.aggregate-consistency.v1", "refinedPresentSeasoningAggregateV1Schema", (a, ctx) => { a.history.events.forEach((e, i) => { if (e.householdId !== a.householdId || e.seasoningId !== a.seasoningId) ctx.addIssue({ code: "custom", path: ["history", "events", i], message: "SCOPE" }); }); const tip = a.history.events.at(-1); if (tip === undefined || !equal(a.projection.binding, tip.payload.binding) || a.projection.presence !== tip.payload.after || a.projection.observedAt !== tip.observedAt || a.projection.observedByUserId !== tip.actorUserId || a.projection.version !== tip.resultingVersion || a.projection.lastEventSequence !== tip.sequence || a.projection.projectionDigest !== tip.resultingProjectionDigest) ctx.addIssue({ code: "custom", path: ["projection"], message: "TIP" }); });
export const seasoningAggregateV1Schema = z.union([absent, present]); export type SeasoningAggregateV1DTO = z.infer<typeof seasoningAggregateV1Schema>;
const acceptedReceipt = <const Outcome extends "accepted_created" | "accepted_updated">(outcome: Outcome) => z.strictObject({ outcome: z.literal(outcome), commandId, eventId: inventoryEventIdSchema, resultingVersion: positivePgInt, eventCoreDigest: digest, eventDigest: digest, projectionDigest: digest, historyDigest: digest });
const decisionBase = z.union([z.strictObject({ kind: z.literal("accepted_created"), eventCore: seasoningEventCoreV1Schema, event: storedSeasoningEventV1Schema, next: present, receipt: acceptedReceipt("accepted_created") }), z.strictObject({ kind: z.literal("accepted_updated"), eventCore: seasoningEventCoreV1Schema, event: storedSeasoningEventV1Schema, next: present, receipt: acceptedReceipt("accepted_updated") }), z.strictObject({ kind: z.literal("unchanged_absent"), current: absent }), z.strictObject({ kind: z.literal("unchanged_present"), current: present }), z.strictObject({ kind: z.literal("invalid_aggregate"), reason: seasoningHistoryReasonV1Schema }), z.strictObject({ kind: z.literal("rejected"), reason: seasoningCommandReasonV1Schema })]);
const seasoningEventCoreOf = (event: z.infer<typeof storedEventBase>): Record<string, unknown> => ({ schemaVersion: event.schemaVersion, eventId: event.eventId, commandId: event.commandId, type: event.type, source: event.source, householdId: event.householdId, seasoningId: event.seasoningId, actorUserId: event.actorUserId, observedAt: event.observedAt, payload: event.payload });
export const seasoningDecisionResultV1Schema: typeof decisionBase = ruleSuperRefine(decisionBase, "seasoning.v1.decision-correlation.v1", "seasoningDecisionResultV1Schema", (r, ctx) => {
  if (r.kind !== "accepted_created" && r.kind !== "accepted_updated") return;
  const tip = r.next.history.events.at(-1);
  if (!equal(r.eventCore, seasoningEventCoreOf(r.event))) ctx.addIssue({ code: "custom", path: ["eventCore"], message: "CORRELATION" });
  if (tip === undefined || !equal(r.event, tip)) ctx.addIssue({ code: "custom", path: ["event"], message: "CORRELATION" });
  if (r.receipt.commandId !== r.event.commandId || r.receipt.eventId !== r.event.eventId || r.receipt.resultingVersion !== r.event.resultingVersion || r.receipt.resultingVersion !== r.next.projection.version || r.receipt.eventCoreDigest !== r.event.eventCoreDigest || r.receipt.eventDigest !== r.event.eventDigest || r.receipt.projectionDigest !== r.event.resultingProjectionDigest || r.receipt.projectionDigest !== r.next.projection.projectionDigest || r.receipt.historyDigest !== r.next.history.historyDigest) ctx.addIssue({ code: "custom", path: ["receipt"], message: "CORRELATION" });
  const created = r.event.expectedVersion === "0" && r.event.sequence === "1" && r.next.history.events.length === 1;
  const updated = r.event.expectedVersion !== "0" && r.event.sequence !== "1" && r.next.history.events.length >= 2;
  if ((r.kind === "accepted_created" && !created) || (r.kind === "accepted_updated" && !updated)) ctx.addIssue({ code: "custom", path: ["kind"], message: "CORRELATION" });
});
export const seasoningSingleReplayResultV1Schema = z.union([z.strictObject({ kind: z.literal("applied"), next: present }), z.strictObject({ kind: z.literal("invalid_aggregate"), reason: seasoningHistoryReasonV1Schema }), z.strictObject({ kind: z.literal("rejected"), reason: seasoningReplayReasonV1Schema })]);
export const seasoningFullHistoryReplayResultV1Schema = z.union([z.strictObject({ kind: z.literal("replayed"), aggregate: seasoningAggregateV1Schema }), z.strictObject({ kind: z.literal("invalid_history_claim"), eventIndex: z.null(), reason: seasoningHistoryReasonV1Schema }), z.strictObject({ kind: z.literal("invalid_history_event"), eventIndex: z.int().nonnegative(), reason: z.union([seasoningHistoryReasonV1Schema, seasoningReplayReasonV1Schema]) })]);

const replaySessionId = z.uuidv7().brand<"SeasoningReplaySessionIdV1">();
const replayCheckpointId = z.uuidv7().brand<"SeasoningReplayCheckpointIdV1">();
const replayChunkKind = z.enum(["only", "first", "continuation", "final"]);
const replayCount = positivePgInt;
const positiveReplayLogicalCount = z.string().regex(/^(?:[1-9][0-9]{0,3}|10000)$/);
const seasoningReplayInputDataGraphSchema = z.custom<unknown>(
  isStage09pSchemaInputDataGraph,
  { message: "REPLAY_INPUT_DATA_GRAPH" },
);

/** Untrusted continuation claim; R7-B must compare it with persisted server state. */
export const seasoningCallerReplayCheckpointClaimV1Schema = seasoningReplayInputDataGraphSchema.pipe(z.strictObject({
  kind: z.literal("caller_claim"), checkpointId: replayCheckpointId, checkpointDigest: digest,
  replaySessionId, householdId: householdIdSchema, seasoningId,
  nextChunkOrdinal: replayCount, processedEventCount: pgInt, nextEventSequence: replayCount,
  terminalEventDigest: digest, declaredTotalEventCount: replayCount,
}));
const serverVerifiedOpenCheckpoint = z.strictObject({
  kind: z.literal("server_verified"), status: z.literal("open"), checkpointId: replayCheckpointId,
  checkpointDigest: digest, replaySessionId, householdId: householdIdSchema, seasoningId,
  nextChunkOrdinal: replayCount, processedEventCount: positiveReplayLogicalCount, nextEventSequence: replayCount,
  terminalEventDigest: digest, declaredTotalEventCount: positiveReplayLogicalCount, verifiedHistoryDigest: z.null(),
});
const serverVerifiedFinalizedCheckpoint = z.strictObject({
  kind: z.literal("server_verified"), status: z.literal("finalized"), checkpointId: replayCheckpointId,
  checkpointDigest: digest, replaySessionId, householdId: householdIdSchema, seasoningId,
  nextChunkOrdinal: replayCount, processedEventCount: positiveReplayLogicalCount, nextEventSequence: replayCount,
  terminalEventDigest: digest, declaredTotalEventCount: positiveReplayLogicalCount, verifiedHistoryDigest: digest,
});
const serverVerifiedEmptyCheckpoint = z.strictObject({
  kind: z.literal("server_verified"), status: z.literal("finalized"), checkpointId: replayCheckpointId,
  checkpointDigest: digest, replaySessionId, householdId: householdIdSchema, seasoningId,
  nextChunkOrdinal: z.literal("2"), processedEventCount: z.literal("0"), nextEventSequence: z.literal("1"),
  terminalEventDigest: z.null(), declaredTotalEventCount: z.literal("0"), verifiedHistoryDigest: z.null(),
});
const rawServerVerifiedReplayCheckpoint = seasoningReplayInputDataGraphSchema.pipe(
  z.union([
    serverVerifiedOpenCheckpoint,
    serverVerifiedFinalizedCheckpoint,
    serverVerifiedEmptyCheckpoint,
  ]),
);

const nonemptyReplayChunkBase = z.strictObject({
  schemaVersion: z.literal(1), householdId: householdIdSchema, seasoningId, replaySessionId,
  chunkKind: replayChunkKind, chunkOrdinal: replayCount, chunkStartSequence: replayCount,
  chunkEndSequence: replayCount, previousChunkTerminalEventDigest: digest.nullable(),
  terminalEventDigest: digest, processedEventCountBefore: pgInt, chunkEventCount: replayCount,
  claimedProcessedEventCount: replayCount, declaredTotalEventCount: replayCount,
  priorCheckpointClaim: seasoningCallerReplayCheckpointClaimV1Schema.nullable(),
  events: z.array(storedSeasoningEventV1Schema).min(1).max(seasoningMaxEventsPerChunkV1),
  claimedFinalHistoryDigest: digest.nullable(),
});
const emptyReplayChunkBase = z.strictObject({
  schemaVersion: z.literal(1), householdId: householdIdSchema, seasoningId, replaySessionId,
  chunkKind: z.literal("only"), chunkOrdinal: z.literal("1"), chunkStartSequence: z.literal("1"),
  chunkEndSequence: z.literal("0"), previousChunkTerminalEventDigest: z.null(),
  terminalEventDigest: z.null(), processedEventCountBefore: z.literal("0"), chunkEventCount: z.literal("0"),
  claimedProcessedEventCount: z.literal("0"), declaredTotalEventCount: z.literal("0"),
  priorCheckpointClaim: z.null(), events: z.tuple([]), claimedFinalHistoryDigest: z.null(),
});
const rawReplayChunkInput = seasoningReplayInputDataGraphSchema.pipe(
  z.union([nonemptyReplayChunkBase, emptyReplayChunkBase]),
);
const replayIssue = (ctx: z.RefinementCtx, path: (string | number)[], message: string): void => ctx.addIssue({ code: "custom", path, message });
const decimal = (value: string): number => Number(value);
/**
 * DTO validation only. Raw replay text must enter through
 * parseSeasoningReplayChunkInputV1. This closes one chunk locally; R7-B must
 * authenticate checkpoint state and reject replayed, gapped, out-of-order or
 * post-final chunks across requests.
 */
export const seasoningReplayChunkInputV1Schema = ruleSuperRefine(rawReplayChunkInput, "seasoning.v1.replay-chunk-consistency.v1", "seasoningReplayChunkInputV1Schema", (chunk, ctx) => {
  if (chunk.events.length === 0) return;
  const before = decimal(chunk.processedEventCountBefore); const count = decimal(chunk.chunkEventCount);
  const after = decimal(chunk.claimedProcessedEventCount); const total = decimal(chunk.declaredTotalEventCount);
  const start = decimal(chunk.chunkStartSequence); const end = decimal(chunk.chunkEndSequence);
  const ordinal = decimal(chunk.chunkOrdinal);
  if ([before, count, after, total].some((value) => value > seasoningMaxTotalReplayEventsV1) || before + chunk.events.length > seasoningMaxTotalReplayEventsV1) replayIssue(ctx, ["claimedProcessedEventCount"], "TOTAL_CAPACITY");
  if (count !== chunk.events.length || before + chunk.events.length !== after || total < after) replayIssue(ctx, ["chunkEventCount"], "CHUNK_ORDER");
  if (ordinal > seasoningMaxTotalReplayEventsV1) replayIssue(ctx, ["chunkOrdinal"], "CHUNK_ORDER");
  if (start !== before + 1 || end !== before + chunk.events.length) replayIssue(ctx, ["chunkStartSequence"], "CHUNK_SEQUENCE");
  const isInitial = chunk.chunkKind === "only" || chunk.chunkKind === "first";
  const isFinal = chunk.chunkKind === "only" || chunk.chunkKind === "final";
  if ((chunk.chunkKind === "only" || chunk.chunkKind === "first") && ordinal !== 1) replayIssue(ctx, ["chunkOrdinal"], "CHUNK_ORDER");
  if ((chunk.chunkKind === "continuation" || chunk.chunkKind === "final") && ordinal <= 1) replayIssue(ctx, ["chunkOrdinal"], "CHUNK_ORDER");
  if (isInitial !== (chunk.previousChunkTerminalEventDigest === null) || isInitial !== (chunk.priorCheckpointClaim === null) || (isInitial && before !== 0)) replayIssue(ctx, ["previousChunkTerminalEventDigest"], "CHUNK_ORDER");
  if (isFinal !== (chunk.claimedFinalHistoryDigest !== null) || (isFinal && total !== after) || (!isFinal && total <= after)) replayIssue(ctx, ["claimedFinalHistoryDigest"], "FINALIZATION");
  const claim = chunk.priorCheckpointClaim;
  if (claim !== null && (decimal(claim.nextChunkOrdinal) > seasoningMaxTotalReplayEventsV1 || decimal(claim.processedEventCount) > seasoningMaxTotalReplayEventsV1 || decimal(claim.nextEventSequence) > seasoningMaxTotalReplayEventsV1 || decimal(claim.declaredTotalEventCount) > seasoningMaxTotalReplayEventsV1 || claim.replaySessionId !== chunk.replaySessionId || claim.householdId !== chunk.householdId || claim.seasoningId !== chunk.seasoningId || decimal(claim.nextChunkOrdinal) !== ordinal || decimal(claim.processedEventCount) !== before || decimal(claim.nextEventSequence) !== start || claim.terminalEventDigest !== chunk.previousChunkTerminalEventDigest || claim.declaredTotalEventCount !== chunk.declaredTotalEventCount)) replayIssue(ctx, ["priorCheckpointClaim"], "CHECKPOINT");
  const eventIds = new Set<string>(); const commandIds = new Set<string>();
  chunk.events.forEach((event, index) => {
    if (eventIds.has(event.eventId) || commandIds.has(event.commandId)) replayIssue(ctx, ["events", index], "DUPLICATE_ID");
    eventIds.add(event.eventId); commandIds.add(event.commandId);
    if (event.householdId !== chunk.householdId || event.seasoningId !== chunk.seasoningId) replayIssue(ctx, ["events", index], "SCOPE");
    const expectedSequence = String(before + index + 1);
    if (event.sequence !== expectedSequence || event.expectedVersion !== String(before + index) || event.resultingVersion !== expectedSequence) replayIssue(ctx, ["events", index], "EVENT_SEQUENCE");
    if (index === 0) {
      if (isInitial && (event.expectedVersion !== "0" || event.previousEventDigest !== null || event.payload.before !== null)) replayIssue(ctx, ["events", 0], "FIRST_EVENT");
      if (!isInitial && event.previousEventDigest !== chunk.previousChunkTerminalEventDigest) replayIssue(ctx, ["events", 0, "previousEventDigest"], "PREVIOUS_DIGEST");
      return;
    }
    const previous = chunk.events[index - 1];
    if (previous === undefined) return;
    if (event.previousEventDigest !== previous.eventDigest) replayIssue(ctx, ["events", index, "previousEventDigest"], "PREVIOUS_DIGEST");
    if (event.payload.before !== previous.payload.after) replayIssue(ctx, ["events", index, "payload", "before"], "BEFORE");
    if (!equal(event.payload.binding, previous.payload.binding)) replayIssue(ctx, ["events", index, "payload", "binding"], "BINDING");
  });
  const tip = chunk.events.at(-1);
  if (tip === undefined || tip.eventDigest !== chunk.terminalEventDigest) replayIssue(ctx, ["terminalEventDigest"], "TERMINAL_DIGEST");
});
export type SeasoningReplayChunkInputV1DTO = z.infer<typeof seasoningReplayChunkInputV1Schema>;
export type SeasoningCallerReplayCheckpointClaimV1DTO = z.infer<typeof seasoningCallerReplayCheckpointClaimV1Schema>;
export type SeasoningReplayChunkParseResultV1 = { readonly ok: true; readonly value: DeepReadonly<SeasoningReplayChunkInputV1DTO> } | { readonly ok: false; readonly reason: SeasoningReplayReasonV1DTO };
/** Server result/persisted-state shape; the raw client parser cannot produce this authority kind. */
export const seasoningServerVerifiedReplayCheckpointV1Schema = ruleSuperRefine(
  rawServerVerifiedReplayCheckpoint,
  "seasoning.v1.replay-server-checkpoint-consistency.v1",
  "seasoningServerVerifiedReplayCheckpointV1Schema",
  (checkpoint, ctx) => {
    if (checkpoint.processedEventCount === "0") return;
    const processed = decimal(checkpoint.processedEventCount); const total = decimal(checkpoint.declaredTotalEventCount);
    const nextOrdinal = decimal(checkpoint.nextChunkOrdinal);
    if (!Number.isSafeInteger(nextOrdinal) || nextOrdinal < 2 || nextOrdinal > processed + 1 || checkpoint.nextEventSequence !== String(processed + 1) || (checkpoint.status === "open" ? processed >= total : processed !== total)) replayIssue(ctx, ["processedEventCount"], "SERVER_CHECKPOINT");
  },
);
export type SeasoningServerVerifiedReplayCheckpointV1DTO = z.infer<typeof seasoningServerVerifiedReplayCheckpointV1Schema>;
const rawSeasoningReplayChunkResultV1Schema = seasoningReplayInputDataGraphSchema.pipe(
  z.union([
    z.strictObject({ kind: z.enum(["accepted_chunk", "finalized"]), checkpoint: seasoningServerVerifiedReplayCheckpointV1Schema }),
    z.strictObject({ kind: z.literal("rejected"), reason: seasoningReplayReasonV1Schema }),
  ]),
);
export const seasoningReplayChunkResultV1Schema = ruleSuperRefine(
  rawSeasoningReplayChunkResultV1Schema,
  "seasoning.v1.replay-chunk-result-consistency.v1",
  "seasoningReplayChunkResultV1Schema",
  (result, ctx) => {
    if (result.kind === "rejected") return;
    if ((result.kind === "accepted_chunk") !== (result.checkpoint.status === "open")) replayIssue(ctx, ["checkpoint", "status"], "RESULT_CHECKPOINT_STATUS");
  },
);
export type SeasoningReplayChunkResultV1DTO = z.infer<typeof seasoningReplayChunkResultV1Schema>;
const seasoningReplayIssuesContainEventPath = (issues: readonly z.ZodIssue[]): boolean =>
  issues.some((issue) =>
    (issue.path[0] === "events" && typeof issue.path[1] === "number") ||
    (issue.code === "invalid_union" && issue.errors.some(seasoningReplayIssuesContainEventPath))
  );
const replayReasonFromChunkIssue = (issues: readonly z.ZodIssue[]): SeasoningReplayReasonV1DTO => {
  const messages = new Set(issues.map((issue) => issue.message));
  if (messages.has("TOTAL_CAPACITY")) return reason(seasoningReplayReasonRows, "SEASONING_REPLAY_TOTAL_HISTORY_CAPACITY_EXCEEDED");
  if (messages.has("SCOPE")) return reason(seasoningReplayReasonRows, "SEASONING_REPLAY_SCOPE_MISMATCH");
  if (messages.has("BEFORE") || messages.has("BINDING")) return reason(seasoningReplayReasonRows, "SEASONING_REPLAY_BEFORE_MISMATCH");
  if (messages.has("PREVIOUS_DIGEST")) return reason(seasoningReplayReasonRows, "SEASONING_REPLAY_PREVIOUS_EVENT_DIGEST_MISMATCH");
  if (messages.has("CHECKPOINT")) return reason(seasoningReplayReasonRows, "SEASONING_REPLAY_CHECKPOINT_MISMATCH");
  if (messages.has("FINALIZATION")) return reason(seasoningReplayReasonRows, "SEASONING_REPLAY_FINALIZATION_INVALID");
  if (messages.has("TERMINAL_DIGEST")) return reason(seasoningReplayReasonRows, "SEASONING_REPLAY_TERMINAL_EVENT_DIGEST_MISMATCH");
  if (messages.has("CHUNK_SEQUENCE") || messages.has("CHUNK_ORDER") || messages.has("EVENT_SEQUENCE") || messages.has("FIRST_EVENT") || messages.has("DUPLICATE_ID")) return reason(seasoningReplayReasonRows, "SEASONING_REPLAY_CHUNK_SEQUENCE_OR_ORDER_INVALID");
  if (seasoningReplayIssuesContainEventPath(issues)) return reason(seasoningReplayReasonRows, "SEASONING_REPLAY_EVENT_SHAPE_INVALID");
  return reason(seasoningReplayReasonRows, "SEASONING_REPLAY_INPUT_SHAPE_INVALID");
};
/** Parses canonical, bounded chunk JSON; caller checkpoint fields remain claims, not attestations. */
export const parseSeasoningReplayChunkInputV1 = (input: string): SeasoningReplayChunkParseResultV1 => {
  const copied = parseStage09pReplayChunkJsonText(input, "seasoning");
  if (!copied.ok) {
    const code = copied.reason === "INPUT_JSON_SYNTAX_INVALID" ? "SEASONING_REPLAY_JSON_SYNTAX_INVALID"
      : copied.reason === "INPUT_CANONICAL_NUMBER_INVALID" ? "SEASONING_REPLAY_CANONICAL_NUMBER_INVALID"
        : copied.reason === "INPUT_WIRE_BYTE_CAPACITY_EXCEEDED" ? "SEASONING_REPLAY_WIRE_BYTE_CAPACITY_EXCEEDED"
          : copied.reason === "INPUT_DECODED_RESOURCE_LIMIT_EXCEEDED" ? "SEASONING_REPLAY_INPUT_RESOURCE_LIMIT_EXCEEDED"
            : copied.reason === "INPUT_CHUNK_EVENT_CAPACITY_EXCEEDED" ? "SEASONING_REPLAY_CHUNK_EVENT_CAPACITY_EXCEEDED"
              : "SEASONING_REPLAY_INPUT_DESCRIPTOR_INVALID";
    return { ok: false, reason: reason(seasoningReplayReasonRows, code) };
  }
  const parsed = seasoningReplayChunkInputV1Schema.safeParse(copied.value);
  return parsed.success ? { ok: true, value: deepFreezeStage09pOwnedData(parsed.data) } : { ok: false, reason: replayReasonFromChunkIssue(parsed.error.issues) };
};

export type SeasoningNormalizationResultV1 = { readonly ok: true; readonly value: NormalizedSeasoningCommandBodyV1DTO } | { readonly ok: false; readonly reason: SeasoningNormalizationReasonV1DTO };
export const normalizeSeasoningCommandBodyV1 = (input: unknown): SeasoningNormalizationResultV1 => {
  const copied = copyStage09pInput(input);
  const reject = (code: SeasoningNormalizationReasonV1DTO["code"]): SeasoningNormalizationResultV1 => ({ ok: false, reason: reason(seasoningNormalizationReasonRows, code) });
  if (!copied.ok) return reject(copied.reason === "INPUT_RESOURCE_LIMIT_EXCEEDED" ? "SEASONING_NORMALIZE_INPUT_RESOURCE_LIMIT_EXCEEDED" : "SEASONING_NORMALIZE_INPUT_DESCRIPTOR_INVALID");
  if (!isSafeRecord(copied.value)) return reject("SEASONING_NORMALIZE_BODY_NOT_OBJECT");
  const allowed = new Set(["schemaVersion", "type", "source", "householdId", "seasoningId", "expectedVersion", "observedAt", "binding", "observation"]);
  if (Object.keys(copied.value).some((key) => !allowed.has(key))) return reject("SEASONING_NORMALIZE_UNKNOWN_KEY");
  if (readSafeOwn(copied.value, "schemaVersion") !== 1) return reject("SEASONING_NORMALIZE_SCHEMA_VERSION_INVALID");
  if (readSafeOwn(copied.value, "type") !== "observe_seasoning") return reject("SEASONING_NORMALIZE_TYPE_INVALID");
  if (readSafeOwn(copied.value, "source") !== "manual_confirmation") return reject("SEASONING_NORMALIZE_SOURCE_INVALID");
  if (!householdIdSchema.safeParse(readSafeOwn(copied.value, "householdId")).success) return reject("SEASONING_NORMALIZE_HOUSEHOLD_ID_INVALID");
  if (!seasoningId.safeParse(readSafeOwn(copied.value, "seasoningId")).success) return reject("SEASONING_NORMALIZE_ID_INVALID");
  if (!pgInt.safeParse(readSafeOwn(copied.value, "expectedVersion")).success) return reject("SEASONING_NORMALIZE_VERSION_INVALID");
  if (!occurrence(rawInstant).safeParse(readSafeOwn(copied.value, "observedAt")).success) return reject("SEASONING_NORMALIZE_OBSERVED_AT_INVALID");
  if (!inputBinding.safeParse(readSafeOwn(copied.value, "binding")).success) return reject("SEASONING_NORMALIZE_BINDING_INVALID");
  if (!observation.safeParse(readSafeOwn(copied.value, "observation")).success) return reject("SEASONING_NORMALIZE_OBSERVATION_INVALID");
  const raw = rawSeasoningCommandBodyV1Schema.safeParse(copied.value);
  if (!raw.success) return reject("SEASONING_NORMALIZE_UNKNOWN_KEY");
  const observedAt = raw.data.observedAt.mode === "server_time" ? raw.data.observedAt : canonicalizeStage09pInstant(raw.data.observedAt.value);
  if (observedAt === null) return reject("SEASONING_NORMALIZE_OBSERVED_AT_INVALID");
  const candidate = { ...raw.data, observedAt: typeof observedAt === "string" ? { mode: "observed" as const, value: observedAt } : observedAt };
  const normalized = normalizedSeasoningCommandBodyV1Schema.safeParse(candidate);
  return normalized.success ? { ok: true, value: Object.freeze(normalized.data) } : reject("SEASONING_NORMALIZE_OBSERVED_AT_INVALID");
};

export type SeasoningDecisionResultV1DTO = z.infer<typeof seasoningDecisionResultV1Schema>;
export type SeasoningSingleReplayResultV1DTO = z.infer<typeof seasoningSingleReplayResultV1Schema>;
export type SeasoningFullHistoryReplayResultV1DTO = z.infer<typeof seasoningFullHistoryReplayResultV1Schema>;

export type SeasoningV1ContractRuleSchemaBinding = ContractRuleSchemaBinding<SeasoningV1ContractRuleId>;
export type SeasoningV1ContractRuleBinding = Omit<SeasoningV1ContractRuleSchemaBinding, "schema">;
export const seasoningV1ContractRuleSchemaBindings = seasoningV1ContractRuleRegistry.getContractRuleSchemaBindings();
export const validateSeasoningV1ContractRuleSchemaBindings = seasoningV1ContractRuleRegistry.validateContractRuleSchemaBindings;
validateSeasoningV1ContractRuleSchemaBindings(seasoningV1ContractRuleSchemaBindings);
export const seasoningV1ContractRuleBindings: readonly SeasoningV1ContractRuleBinding[] =
  seasoningV1ContractRuleSchemaBindings.map(({ boundary, ruleIds }) => ({ boundary, ruleIds }));
