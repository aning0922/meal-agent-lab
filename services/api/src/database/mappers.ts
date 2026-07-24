import {
  householdSchema,
  membershipSchema,
  personProfileSchema,
  sessionSchema,
  userSchema,
  type Household,
  type Membership,
  type PersonProfile,
  type Session,
  type User,
} from "@meal-agent/contracts/identity";
import {
  inventoryEventSchema,
  inventoryLotSchema,
  type InventoryEvent,
  type InventoryLot,
} from "@meal-agent/contracts/inventory";

import { toIsoString } from "../utils.js";

type TimestampValue = Date | string;

export interface UserRow {
  readonly id: string;
  readonly status: string;
  readonly display_name: string | null;
  readonly locale: string;
  readonly created_at: TimestampValue;
  readonly updated_at: TimestampValue;
  readonly version: number;
}

export interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly auth_identity_id: string;
  readonly status: string;
  readonly issued_at: TimestampValue;
  readonly expires_at: TimestampValue;
  readonly idle_expires_at: TimestampValue;
  readonly last_seen_at: TimestampValue;
  readonly revoked_at: TimestampValue | null;
  readonly token_version: number;
}

export interface HouseholdRow {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly locale: string;
  readonly status: string;
  readonly created_by_user_id: string;
  readonly created_at: TimestampValue;
  readonly updated_at: TimestampValue;
  readonly version: number;
}

export interface MembershipRow {
  readonly id: string;
  readonly household_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly capabilities: unknown;
  readonly status: string;
  readonly joined_at: TimestampValue;
  readonly updated_at: TimestampValue;
  readonly version: number;
}

export interface PersonProfileRow {
  readonly id: string;
  readonly household_id: string;
  readonly linked_membership_id: string | null;
  readonly display_name: string;
  readonly status: string;
  readonly default_participation: number;
  readonly default_portion_scale: string | number;
  readonly cooking_skill: string;
  readonly dietary_constraints: unknown;
  readonly created_at: TimestampValue;
  readonly updated_at: TimestampValue;
  readonly version: number;
}

export interface InventoryLotRow {
  readonly id: string;
  readonly household_id: string;
  readonly food_concept_id: string | null;
  readonly display_name: string;
  readonly state: string;
  readonly storage_location: string;
  readonly current_quantity_kind: string;
  readonly current_quantity_amount: string | number | null;
  readonly current_quantity_unit: string | null;
  readonly current_quantity_original_text: string | null;
  readonly current_quantity_confidence: string | null;
  readonly current_quantity_level: string | null;
  readonly dates: unknown;
  readonly safety_status: string;
  readonly safety_reason_codes: unknown;
  readonly safety_policy_version: string;
  readonly safety_evaluated_at: TimestampValue;
  readonly origin: string;
  readonly created_by_user_id: string;
  readonly created_at: TimestampValue;
  readonly updated_at: TimestampValue;
  readonly version: number;
}

export interface InventoryEventRow {
  readonly id: string;
  readonly household_id: string;
  readonly inventory_lot_id: string;
  readonly type: string;
  readonly quantity_change_kind: string | null;
  readonly quantity_change_amount: string | number | null;
  readonly quantity_change_unit: string | null;
  readonly quantity_change_precision: string | null;
  readonly quantity_change_confidence: string | null;
  readonly quantity_change_original_text: string | null;
  readonly quantity_from_level: string | null;
  readonly quantity_to_level: string | null;
  readonly from_storage_location: string | null;
  readonly to_storage_location: string | null;
  readonly correction_of_event_id: string | null;
  readonly actor_user_id: string;
  readonly source: string;
  readonly occurred_at: TimestampValue;
  readonly recorded_at: TimestampValue;
  readonly idempotency_key: string;
  readonly expected_lot_version: number;
  readonly resulting_lot_version: number;
  readonly note: string | null;
}

export const mapUser = (row: UserRow): User =>
  userSchema.parse({
    id: row.id,
    status: row.status,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    locale: row.locale,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    version: row.version,
  });

export const mapSession = (row: SessionRow): Session =>
  sessionSchema.parse({
    id: row.id,
    userId: row.user_id,
    authIdentityId: row.auth_identity_id,
    status: row.status,
    issuedAt: toIsoString(row.issued_at),
    expiresAt: toIsoString(row.expires_at),
    lastSeenAt: toIsoString(row.last_seen_at),
    ...(row.revoked_at === null
      ? {}
      : { revokedAt: toIsoString(row.revoked_at) }),
    tokenVersion: row.token_version,
  });

export const mapHousehold = (row: HouseholdRow): Household =>
  householdSchema.parse({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    locale: row.locale,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    version: row.version,
  });

export const mapMembership = (row: MembershipRow): Membership =>
  membershipSchema.parse({
    id: row.id,
    householdId: row.household_id,
    userId: row.user_id,
    role: row.role,
    capabilities: row.capabilities,
    status: row.status,
    joinedAt: toIsoString(row.joined_at),
    updatedAt: toIsoString(row.updated_at),
    version: row.version,
  });

export const mapPersonProfile = (
  row: PersonProfileRow,
): PersonProfile =>
  personProfileSchema.parse({
    id: row.id,
    householdId: row.household_id,
    ...(row.linked_membership_id === null
      ? {}
      : { linkedMembershipId: row.linked_membership_id }),
    displayName: row.display_name,
    status: row.status,
    defaultParticipation: row.default_participation === 1,
    defaultPortionScale: Number(row.default_portion_scale),
    cookingSkill: row.cooking_skill,
    dietaryConstraints: row.dietary_constraints,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    version: row.version,
  });

const mapCurrentQuantity = (row: InventoryLotRow): unknown => {
  if (row.current_quantity_kind === "exact") {
    return {
      kind: "exact",
      amount: String(row.current_quantity_amount),
      unit: row.current_quantity_unit,
      ...(row.current_quantity_original_text === null
        ? {}
        : { originalText: row.current_quantity_original_text }),
    };
  }
  if (row.current_quantity_kind === "approximate") {
    return {
      kind: "approximate",
      amount: Number(row.current_quantity_amount),
      unit: row.current_quantity_unit,
      originalText: row.current_quantity_original_text,
      confidence: row.current_quantity_confidence,
    };
  }
  return {
    kind: "qualitative",
    level: row.current_quantity_level,
    ...(row.current_quantity_original_text === null
      ? {}
      : { originalText: row.current_quantity_original_text }),
  };
};

export const mapInventoryLot = (row: InventoryLotRow): InventoryLot =>
  inventoryLotSchema.parse({
    id: row.id,
    householdId: row.household_id,
    ...(row.food_concept_id === null
      ? {}
      : { foodConceptId: row.food_concept_id }),
    displayName: row.display_name,
    state: row.state,
    storageLocation: row.storage_location,
    currentQuantity: mapCurrentQuantity(row),
    dates: row.dates,
    safetyAssessment: {
      status: row.safety_status,
      reasonCodes: row.safety_reason_codes,
      policyVersion: row.safety_policy_version,
      evaluatedAt: toIsoString(row.safety_evaluated_at),
    },
    origin: row.origin,
    createdByUserId: row.created_by_user_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    version: row.version,
  });

const mapQuantityChange = (row: InventoryEventRow): unknown => {
  if (row.quantity_change_kind === null) {
    return undefined;
  }
  if (row.quantity_change_kind === "qualitative") {
    return {
      kind: "qualitative",
      fromLevel: row.quantity_from_level,
      toLevel: row.quantity_to_level,
      ...(row.quantity_change_original_text === null
        ? {}
        : { originalText: row.quantity_change_original_text }),
    };
  }
  return {
    kind: "numeric",
    amount:
      row.quantity_change_precision === "exact"
        ? String(row.quantity_change_amount)
        : Number(row.quantity_change_amount),
    unit: row.quantity_change_unit,
    precision: row.quantity_change_precision,
    ...(row.quantity_change_confidence === null
      ? {}
      : { confidence: row.quantity_change_confidence }),
    ...(row.quantity_change_original_text === null
      ? {}
      : { originalText: row.quantity_change_original_text }),
  };
};

export const mapInventoryEvent = (
  row: InventoryEventRow,
): InventoryEvent => {
  const quantityChange = mapQuantityChange(row);
  return inventoryEventSchema.parse({
    id: row.id,
    householdId: row.household_id,
    inventoryLotId: row.inventory_lot_id,
    type: row.type,
    ...(quantityChange === undefined ? {} : { quantityChange }),
    ...(row.from_storage_location === null
      ? {}
      : { fromStorageLocation: row.from_storage_location }),
    ...(row.to_storage_location === null
      ? {}
      : { toStorageLocation: row.to_storage_location }),
    ...(row.correction_of_event_id === null
      ? {}
      : { correctionOfEventId: row.correction_of_event_id }),
    actorUserId: row.actor_user_id,
    source: row.source,
    occurredAt: toIsoString(row.occurred_at),
    recordedAt: toIsoString(row.recorded_at),
    idempotencyKey: row.idempotency_key,
    expectedLotVersion: row.expected_lot_version,
    resultingLotVersion: row.resulting_lot_version,
    ...(row.note === null ? {} : { note: row.note }),
  });
};
