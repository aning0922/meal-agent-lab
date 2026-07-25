import {
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    status: varchar("status", { length: 32 }).notNull(),
    displayName: varchar("display_name", { length: 80 }),
    locale: varchar("locale", { length: 35 }).notNull(),
    ...timestamps,
    version: integer("version").notNull().default(0),
  },
  (table) => [
    check(
      "users_status_check",
      sql`${table.status} IN ('active', 'disabled', 'deletion_pending')`,
    ),
    check("users_version_check", sql`${table.version} >= 0`),
  ],
);

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerTenantKey: varchar("provider_tenant_key", {
      length: 128,
    }).notNull(),
    providerSubject: varchar("provider_subject", { length: 255 }).notNull(),
    providerUnionSubject: varchar("provider_union_subject", { length: 255 }),
    status: varchar("status", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    unique("auth_identities_provider_subject_unique").on(
      table.provider,
      table.providerTenantKey,
      table.providerSubject,
    ),
    unique("auth_identities_id_user_unique").on(table.id, table.userId),
    check(
      "auth_identities_provider_check",
      sql`${table.provider} IN ('wechat_miniprogram', 'phone', 'apple', 'huawei')`,
    ),
    check(
      "auth_identities_status_check",
      sql`${table.status} IN ('active', 'disabled')`,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    authIdentityId: uuid("auth_identity_id").notNull(),
    tokenDigest: char("token_digest", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    issuedAt: timestamp("issued_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    idleExpiresAt: timestamp("idle_expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    tokenVersion: integer("token_version").notNull().default(1),
  },
  (table) => [
    unique("sessions_token_digest_unique").on(table.tokenDigest),
    foreignKey({
      name: "sessions_identity_user_foreign",
      columns: [table.authIdentityId, table.userId],
      foreignColumns: [authIdentities.id, authIdentities.userId],
    }),
    check(
      "sessions_status_check",
      sql`${table.status} IN ('active', 'expired', 'revoked')`,
    ),
    check(
      "sessions_expiry_check",
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.idleExpiresAt} > ${table.issuedAt}`,
    ),
    check(
      "sessions_revoked_at_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)`,
    ),
    check("sessions_token_version_check", sql`${table.tokenVersion} > 0`),
  ],
);

export const households = pgTable(
  "households",
  {
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 80 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    locale: varchar("locale", { length: 35 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    ...timestamps,
    version: integer("version").notNull().default(0),
  },
  (table) => [
    check(
      "households_status_check",
      sql`${table.status} IN ('active', 'deletion_pending', 'deleted')`,
    ),
    check("households_version_check", sql`${table.version} >= 0`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: varchar("role", { length: 32 }).notNull(),
    capabilities: jsonb("capabilities").$type<readonly string[]>().notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    joinedAt: timestamp("joined_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    unique("memberships_household_user_unique").on(
      table.householdId,
      table.userId,
    ),
    unique("memberships_household_id_unique").on(
      table.householdId,
      table.id,
    ),
    check(
      "memberships_role_check",
      sql`${table.role} IN ('owner', 'member')`,
    ),
    check(
      "memberships_status_check",
      sql`${table.status} IN ('active', 'left', 'removed')`,
    ),
    check(
      "memberships_capabilities_check",
      sql`jsonb_typeof(${table.capabilities}) = 'array'`,
    ),
    check("memberships_version_check", sql`${table.version} >= 0`),
    index("memberships_user_active_index")
      .on(table.userId, table.householdId)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const householdInvites = pgTable(
  "household_invites",
  {
    id: uuid("id").primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    createdByUserId: uuid("created_by_user_id").notNull(),
    codeDigest: char("code_digest", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    maxUses: integer("max_uses").notNull(),
    usedCount: integer("used_count").notNull().default(0),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    unique("household_invites_code_digest_unique").on(table.codeDigest),
    foreignKey({
      name: "household_invites_creator_membership_foreign",
      columns: [table.householdId, table.createdByUserId],
      foreignColumns: [memberships.householdId, memberships.userId],
    }),
    check(
      "household_invites_status_check",
      sql`${table.status} IN ('active', 'revoked', 'exhausted', 'expired')`,
    ),
    check(
      "household_invites_max_uses_check",
      sql`${table.maxUses} BETWEEN 1 AND 10`,
    ),
    check(
      "household_invites_used_count_check",
      sql`${table.usedCount} >= 0 AND ${table.usedCount} <= ${table.maxUses}`,
    ),
    check(
      "household_invites_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '7 days'`,
    ),
    check("household_invites_version_check", sql`${table.version} >= 0`),
    index("household_invites_household_status_index").on(
      table.householdId,
      table.status,
    ),
  ],
);

export const personProfiles = pgTable(
  "person_profiles",
  {
    id: uuid("id").primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    linkedMembershipId: uuid("linked_membership_id"),
    displayName: varchar("display_name", { length: 80 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    defaultParticipation: integer("default_participation"),
    defaultPortionScale: numeric("default_portion_scale", {
      precision: 6,
      scale: 3,
      mode: "number",
    }),
    cookingSkill: varchar("cooking_skill", { length: 32 }),
    dietaryConstraints: jsonb("dietary_constraints")
      .$type<readonly unknown[]>()
      .notNull(),
    ...timestamps,
    version: integer("version").notNull().default(0),
  },
  (table) => [
    unique("person_profiles_household_id_unique").on(
      table.householdId,
      table.id,
    ),
    uniqueIndex("person_profiles_linked_membership_unique")
      .on(table.householdId, table.linkedMembershipId)
      .where(sql`${table.linkedMembershipId} IS NOT NULL`),
    foreignKey({
      name: "person_profiles_membership_foreign",
      columns: [table.householdId, table.linkedMembershipId],
      foreignColumns: [memberships.householdId, memberships.id],
    }),
    check(
      "person_profiles_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    check(
      "person_profiles_default_participation_check",
      sql`${table.defaultParticipation} IS NULL OR ${table.defaultParticipation} IN (0, 1)`,
    ),
    check(
      "person_profiles_default_portion_scale_check",
      sql`${table.defaultPortionScale} IS NULL OR ${table.defaultPortionScale} BETWEEN 0.25 AND 4`,
    ),
    check(
      "person_profiles_cooking_skill_check",
      sql`${table.cookingSkill} IS NULL OR ${table.cookingSkill} IN ('none', 'beginner', 'intermediate', 'advanced')`,
    ),
    check(
      "person_profiles_dietary_constraints_check",
      sql`jsonb_typeof(${table.dietaryConstraints}) = 'array'`,
    ),
    check(
      "person_profiles_hard_mapping_status_check",
      sql`meal_agent_private.stage08_constraints_are_safe(${table.dietaryConstraints})`,
    ),
    check("person_profiles_version_check", sql`${table.version} >= 0`),
  ],
);

export const personProfileLinkRequests = pgTable(
  "person_profile_link_requests",
  {
    id: uuid("id").primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    profileId: uuid("profile_id").notNull(),
    targetMembershipId: uuid("target_membership_id").notNull(),
    initiatedByUserId: uuid("initiated_by_user_id").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    confirmedAt: timestamp("confirmed_at", {
      withTimezone: true,
      mode: "date",
    }),
    terminalReason: varchar("terminal_reason", { length: 64 }),
    disclosureStatus: varchar("disclosure_status", {
      length: 32,
    }).notNull(),
    disclosureVersion: integer("disclosure_version"),
    profileVersionAtRequest: integer(
      "profile_version_at_request",
    ),
    disclosedProfileName: varchar("disclosed_profile_name", {
      length: 80,
    }),
    disclosedHouseholdHardCount: integer(
      "disclosed_household_hard_count",
    ),
    disclosedHouseholdSoftCount: integer(
      "disclosed_household_soft_count",
    ),
    disclosedPrivateConstraintCount: integer(
      "disclosed_private_constraint_count",
    ),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: "person_profile_link_requests_profile_foreign",
      columns: [table.householdId, table.profileId],
      foreignColumns: [personProfiles.householdId, personProfiles.id],
    }),
    foreignKey({
      name: "person_profile_link_requests_membership_foreign",
      columns: [table.householdId, table.targetMembershipId],
      foreignColumns: [memberships.householdId, memberships.id],
    }),
    foreignKey({
      name: "person_profile_link_requests_initiator_foreign",
      columns: [table.householdId, table.initiatedByUserId],
      foreignColumns: [memberships.householdId, memberships.userId],
    }),
    check(
      "person_profile_link_requests_status_check",
      sql`${table.status} IN ('pending', 'accepted', 'cancelled', 'expired')`,
    ),
    check(
      "person_profile_link_requests_time_check",
      sql`${table.expiresAt} > ${table.createdAt}
        AND ${table.expiresAt} <= ${table.createdAt} + interval '7 days'`,
    ),
    check(
      "person_profile_link_requests_terminal_reason_check",
      sql`(
          ${table.status} = 'pending'
          AND ${table.confirmedAt} IS NULL
          AND ${table.terminalReason} IS NULL
        )
        OR (
          ${table.status} = 'accepted'
          AND ${table.confirmedAt} IS NOT NULL
          AND ${table.terminalReason} IS NULL
        )
        OR (
          ${table.status} = 'expired'
          AND ${table.confirmedAt} IS NULL
          AND ${table.terminalReason} = 'expired'
        )
        OR (
          ${table.status} = 'cancelled'
          AND ${table.confirmedAt} IS NULL
          AND ${table.terminalReason} IN (
            'target_membership_inactive',
            'profile_unavailable',
            'target_membership_has_profile',
            'profile_changed'
          )
        )`,
    ),
    check(
      "person_profile_link_requests_disclosure_check",
      sql`(
          ${table.disclosureStatus} = 'legacy_unavailable'
          AND ${table.disclosureVersion} IS NULL
          AND ${table.profileVersionAtRequest} IS NULL
          AND ${table.disclosedProfileName} IS NULL
          AND ${table.disclosedHouseholdHardCount} IS NULL
          AND ${table.disclosedHouseholdSoftCount} IS NULL
          AND ${table.disclosedPrivateConstraintCount} IS NULL
        ) OR (
          ${table.disclosureStatus} = 'available'
          AND ${table.disclosureVersion} = 1
          AND ${table.profileVersionAtRequest} >= 0
          AND length(${table.disclosedProfileName}) BETWEEN 1 AND 80
          AND ${table.disclosedHouseholdHardCount} >= 0
          AND ${table.disclosedHouseholdSoftCount} >= 0
          AND ${table.disclosedPrivateConstraintCount} >= 0
        )`,
    ),
    check(
      "person_profile_link_requests_version_check",
      sql`${table.version} >= 0`,
    ),
    uniqueIndex("person_profile_link_requests_pending_profile_unique")
      .on(table.householdId, table.profileId)
      .where(sql`${table.status} = 'pending'`),
    index("person_profile_link_requests_target_status_index").on(
      table.householdId,
      table.targetMembershipId,
      table.status,
    ),
  ],
);

export const inventoryLots = pgTable(
  "inventory_lots",
  {
    id: uuid("id").primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    foodConceptId: uuid("food_concept_id"),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    state: varchar("state", { length: 32 }).notNull(),
    storageLocation: varchar("storage_location", { length: 32 }).notNull(),
    currentQuantityKind: varchar("current_quantity_kind", {
      length: 32,
    }).notNull(),
    currentQuantityAmount: numeric("current_quantity_amount", {
      precision: 15,
      scale: 6,
    }),
    currentQuantityUnit: varchar("current_quantity_unit", { length: 32 }),
    currentQuantityOriginalText: varchar("current_quantity_original_text", {
      length: 200,
    }),
    currentQuantityConfidence: varchar("current_quantity_confidence", {
      length: 16,
    }),
    currentQuantityLevel: varchar("current_quantity_level", { length: 16 }),
    dates: jsonb("dates").$type<readonly unknown[]>().notNull(),
    safetyStatus: varchar("safety_status", { length: 32 }).notNull(),
    safetyReasonCodes: jsonb("safety_reason_codes")
      .$type<readonly string[]>()
      .notNull(),
    safetyPolicyVersion: varchar("safety_policy_version", {
      length: 100,
    }).notNull(),
    safetyEvaluatedAt: timestamp("safety_evaluated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    origin: varchar("origin", { length: 32 }).notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    ...timestamps,
    version: integer("version").notNull(),
  },
  (table) => [
    unique("inventory_lots_household_id_unique").on(
      table.householdId,
      table.id,
    ),
    foreignKey({
      name: "inventory_lots_creator_membership_foreign",
      columns: [table.householdId, table.createdByUserId],
      foreignColumns: [memberships.householdId, memberships.userId],
    }),
    check(
      "inventory_lots_state_check",
      sql`${table.state} IN ('active', 'depleted', 'discarded')`,
    ),
    check(
      "inventory_lots_storage_location_check",
      sql`${table.storageLocation} IN ('pantry', 'refrigerated', 'frozen', 'other')`,
    ),
    check(
      "inventory_lots_quantity_shape_check",
      sql`(
        (${table.currentQuantityKind} = 'exact'
          AND ${table.currentQuantityAmount} IS NOT NULL
          AND ${table.currentQuantityAmount} >= 0
          AND ${table.currentQuantityUnit} IS NOT NULL
          AND ${table.currentQuantityConfidence} IS NULL
          AND ${table.currentQuantityLevel} IS NULL)
        OR
        (${table.currentQuantityKind} = 'approximate'
          AND ${table.currentQuantityAmount} IS NOT NULL
          AND ${table.currentQuantityAmount} >= 0
          AND ${table.currentQuantityUnit} IS NOT NULL
          AND ${table.currentQuantityConfidence} IN ('high', 'medium', 'low')
          AND ${table.currentQuantityOriginalText} IS NOT NULL
          AND ${table.currentQuantityLevel} IS NULL)
        OR
        (${table.currentQuantityKind} = 'qualitative'
          AND ${table.currentQuantityAmount} IS NULL
          AND ${table.currentQuantityUnit} IS NULL
          AND ${table.currentQuantityConfidence} IS NULL
          AND ${table.currentQuantityLevel} IN ('plenty', 'some', 'low', 'empty', 'unknown'))
      )`,
    ),
    check(
      "inventory_lots_state_quantity_check",
      sql`(
        (${table.state} = 'active' AND (
          (${table.currentQuantityKind} IN ('exact', 'approximate') AND ${table.currentQuantityAmount} > 0)
          OR (${table.currentQuantityKind} = 'qualitative' AND ${table.currentQuantityLevel} <> 'empty')
        ))
        OR
        (${table.state} IN ('depleted', 'discarded') AND (
          (${table.currentQuantityKind} = 'exact' AND ${table.currentQuantityAmount} = 0)
          OR (${table.currentQuantityKind} = 'qualitative' AND ${table.currentQuantityLevel} = 'empty')
        ))
      )`,
    ),
    check(
      "inventory_lots_dates_check",
      sql`jsonb_typeof(${table.dates}) = 'array' AND jsonb_array_length(${table.dates}) <= 9`,
    ),
    check(
      "inventory_lots_safety_status_check",
      sql`${table.safetyStatus} IN ('eligible', 'blocked', 'unknown')`,
    ),
    check(
      "inventory_lots_safety_reason_codes_check",
      sql`jsonb_typeof(${table.safetyReasonCodes}) = 'array'`,
    ),
    check(
      "inventory_lots_origin_check",
      sql`${table.origin} IN ('manual', 'shopping_confirmation', 'leftover', 'confirmed_import')`,
    ),
    check("inventory_lots_version_check", sql`${table.version} > 0`),
    index("inventory_lots_household_created_index").on(
      table.householdId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const inventoryEvents = pgTable(
  "inventory_events",
  {
    id: uuid("id").primaryKey(),
    householdId: uuid("household_id").notNull(),
    inventoryLotId: uuid("inventory_lot_id").notNull(),
    type: varchar("type", { length: 32 }).notNull(),
    quantityChangeKind: varchar("quantity_change_kind", { length: 32 }),
    quantityChangeAmount: numeric("quantity_change_amount", {
      precision: 15,
      scale: 6,
    }),
    quantityChangeUnit: varchar("quantity_change_unit", { length: 32 }),
    quantityChangePrecision: varchar("quantity_change_precision", {
      length: 16,
    }),
    quantityChangeConfidence: varchar("quantity_change_confidence", {
      length: 16,
    }),
    quantityChangeOriginalText: varchar(
      "quantity_change_original_text",
      { length: 200 },
    ),
    quantityFromLevel: varchar("quantity_from_level", { length: 16 }),
    quantityToLevel: varchar("quantity_to_level", { length: 16 }),
    fromStorageLocation: varchar("from_storage_location", { length: 32 }),
    toStorageLocation: varchar("to_storage_location", { length: 32 }),
    correctionOfEventId: uuid("correction_of_event_id"),
    actorUserId: uuid("actor_user_id").notNull(),
    source: varchar("source", { length: 48 }).notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    recordedAt: timestamp("recorded_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    normalizedRoute: varchar("normalized_route", { length: 255 }).notNull(),
    expectedLotVersion: integer("expected_lot_version").notNull(),
    resultingLotVersion: integer("resulting_lot_version").notNull(),
    note: text("note"),
  },
  (table) => [
    unique("inventory_events_household_id_unique").on(
      table.householdId,
      table.id,
    ),
    unique(
      "inventory_events_household_actor_route_idempotency_unique",
    ).on(
      table.householdId,
      table.actorUserId,
      table.normalizedRoute,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "inventory_events_lot_foreign",
      columns: [table.householdId, table.inventoryLotId],
      foreignColumns: [inventoryLots.householdId, inventoryLots.id],
    }),
    foreignKey({
      name: "inventory_events_actor_membership_foreign",
      columns: [table.householdId, table.actorUserId],
      foreignColumns: [memberships.householdId, memberships.userId],
    }),
    foreignKey({
      name: "inventory_events_correction_foreign",
      columns: [table.householdId, table.correctionOfEventId],
      foreignColumns: [table.householdId, table.id],
    }),
    check(
      "inventory_events_version_check",
      sql`${table.expectedLotVersion} >= 0 AND ${table.resultingLotVersion} = ${table.expectedLotVersion} + 1`,
    ),
    check(
      "inventory_events_quantity_shape_check",
      sql`(
        (${table.quantityChangeKind} IS NULL
          AND ${table.quantityChangeAmount} IS NULL
          AND ${table.quantityFromLevel} IS NULL
          AND ${table.quantityToLevel} IS NULL)
        OR
        (${table.quantityChangeKind} = 'numeric'
          AND ${table.quantityChangeAmount} IS NOT NULL
          AND ${table.quantityChangeAmount} <> 0
          AND ${table.quantityChangeUnit} IS NOT NULL
          AND ${table.quantityChangePrecision} IN ('exact', 'estimated')
          AND ${table.quantityFromLevel} IS NULL
          AND ${table.quantityToLevel} IS NULL
          AND (
            (${table.quantityChangePrecision} = 'exact' AND ${table.quantityChangeConfidence} IS NULL)
            OR
            (${table.quantityChangePrecision} = 'estimated'
              AND ${table.quantityChangeConfidence} IN ('high', 'medium', 'low')
              AND ${table.quantityChangeOriginalText} IS NOT NULL)
          ))
        OR
        (${table.quantityChangeKind} = 'qualitative'
          AND ${table.quantityChangeAmount} IS NULL
          AND ${table.quantityChangeUnit} IS NULL
          AND ${table.quantityChangePrecision} IS NULL
          AND ${table.quantityFromLevel} IN ('plenty', 'some', 'low', 'empty', 'unknown')
          AND ${table.quantityToLevel} IN ('plenty', 'some', 'low', 'empty', 'unknown')
          AND ${table.quantityFromLevel} <> ${table.quantityToLevel})
      )`,
    ),
    index("inventory_events_lot_recorded_index").on(
      table.householdId,
      table.inventoryLotId,
      table.recordedAt,
      table.id,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").primaryKey(),
    scopeKind: varchar("scope_kind", { length: 16 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    householdId: uuid("household_id"),
    method: varchar("method", { length: 16 }).notNull(),
    normalizedRoute: varchar("normalized_route", { length: 255 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    statusCode: integer("status_code"),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    originalRequestId: uuid("original_request_id").notNull(),
    firstProcessedAt: timestamp("first_processed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    foreignKey({
      name: "idempotency_records_membership_foreign",
      columns: [table.householdId, table.userId],
      foreignColumns: [memberships.householdId, memberships.userId],
    }),
    check(
      "idempotency_records_scope_check",
      sql`(${table.scopeKind} = 'user' AND ${table.householdId} IS NULL)
        OR (${table.scopeKind} = 'household' AND ${table.householdId} IS NOT NULL)`,
    ),
    check(
      "idempotency_records_completion_check",
      sql`(${table.statusCode} IS NULL) = (${table.responseBody} IS NULL)`,
    ),
    check(
      "idempotency_records_status_check",
      sql`${table.statusCode} IS NULL
        OR (${table.statusCode} BETWEEN 200 AND 299) IS TRUE
        OR (
          (${table.statusCode} = 409) IS TRUE
          AND (
            ${table.normalizedRoute} IN (
              '/api/v1/households/{id}/person-profiles/{profileId}/link-requests',
              '/api/v1/households/{id}/person-profile-link-requests/{requestId}/confirm'
            )
          ) IS TRUE
          AND (jsonb_typeof(${table.responseBody}) = 'object') IS TRUE
          AND (${table.responseBody}->'ok' = 'false'::jsonb) IS TRUE
          AND (
            jsonb_typeof(${table.responseBody}->'error') = 'object'
          ) IS TRUE
          AND (
            ${table.responseBody}->'error'->>'code' = 'CONFLICT'
          ) IS TRUE
        )`,
    ),
    unique("idempotency_records_scope_unique")
      .on(
        table.userId,
        table.householdId,
        table.method,
        table.normalizedRoute,
        table.idempotencyKey,
      )
      .nullsNotDistinct(),
  ],
);

export const stage06Tables = {
  users,
  authIdentities,
  sessions,
  households,
  memberships,
  householdInvites,
  personProfiles,
  personProfileLinkRequests,
  inventoryLots,
  inventoryEvents,
  idempotencyRecords,
} as const;
