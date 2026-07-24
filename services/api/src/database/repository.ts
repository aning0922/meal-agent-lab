import {
  authenticatedSessionSchema,
  createHouseholdResultSchema,
  type AuthenticatedSession,
  type CreateHouseholdRequest,
  type CreateHouseholdResult,
  type Household,
  type Membership,
  type User,
} from "@meal-agent/contracts/identity";
import {
  consumeInventoryLotResultSchema,
  createInventoryLotResultSchema,
  type ConsumeInventoryLotRequest,
  type ConsumeInventoryLotResult,
  type CreateInventoryLotRequest,
  type CreateInventoryLotResult,
  type InventoryEvent,
  type InventoryLot,
} from "@meal-agent/contracts/inventory";
import {
  idempotencyKeySchema,
  requestIdSchema,
  sessionTokenSchema,
  type Cursor,
  type IdempotencyKey,
  type RequestId,
} from "@meal-agent/contracts";
import type { PoolClient } from "pg";

import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import {
  decodeCursor,
  digestSessionToken,
  encodeCursor,
  issueSessionToken,
  newEntityId,
  requestHash,
  toDatabaseApproximateQuantityDecimal,
  toDatabaseQuantityDecimal,
} from "../utils.js";
import type { WechatAdapter } from "../wechat/adapter.js";
import {
  mapHousehold,
  mapInventoryEvent,
  mapInventoryLot,
  mapMembership,
  mapPersonProfile,
  mapSession,
  mapUser,
  type HouseholdRow,
  type InventoryEventRow,
  type InventoryLotRow,
  type MembershipRow,
  type PersonProfileRow,
  type SessionRow,
  type UserRow,
} from "./mappers.js";
import {
  setHouseholdContext,
  setUserContext,
  withAppTransaction,
  type Persistence,
} from "./pool.js";

export interface AuthenticatedUserContext {
  readonly requestId: RequestId;
  readonly sessionId: string;
  readonly userId: string;
}

export interface HouseholdContext extends AuthenticatedUserContext {
  readonly householdId: string;
  readonly membershipId: string;
  readonly role: "owner" | "member";
  readonly capabilities: readonly string[];
}

export interface Page<T> {
  readonly items: T[];
  readonly pageInfo:
    | {
        readonly nextCursor: Cursor;
        readonly hasMore: true;
      }
    | {
        readonly nextCursor: null;
        readonly hasMore: false;
      };
}

export interface IdempotentResponse<T> {
  readonly statusCode: number;
  readonly body: {
    readonly ok: true;
    readonly data: T;
    readonly meta: {
      readonly requestId: RequestId;
      readonly idempotency: {
        readonly key: IdempotencyKey;
        readonly scope: "user" | "household";
        readonly replayed: boolean;
        readonly firstProcessedAt: string;
        readonly originalRequestId: RequestId;
      };
    };
  };
}

interface AuthenticatedRows extends SessionRow, UserRow {
  readonly session_id: string;
  readonly session_user_id: string;
  readonly session_status: string;
  readonly session_issued_at: Date;
  readonly session_expires_at: Date;
  readonly session_idle_expires_at: Date;
  readonly session_last_seen_at: Date;
  readonly session_revoked_at: Date | null;
  readonly session_token_version: number;
  readonly session_auth_identity_id: string;
  readonly user_id_value: string;
  readonly user_status: string;
  readonly user_display_name: string | null;
  readonly user_locale: string;
  readonly user_created_at: Date;
  readonly user_updated_at: Date;
  readonly user_version: number;
}

interface IdempotencyRow {
  readonly request_hash: string;
  readonly status_code: number | null;
  readonly response_body: unknown;
  readonly original_request_id: string;
  readonly first_processed_at: Date;
}

const normalizedRoutes = {
  createHousehold: "/api/v1/households",
  createInventoryLot: "/api/v1/households/{id}/inventory-lots",
  consumeInventoryLot:
    "/api/v1/households/{id}/inventory-lots/{lotId}/events/consumed",
} as const;

const plusDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);

const sessionRowFromAuthenticated = (
  row: AuthenticatedRows,
): SessionRow => ({
  id: row.session_id,
  user_id: row.session_user_id,
  auth_identity_id: row.session_auth_identity_id,
  status: row.session_status,
  issued_at: row.session_issued_at,
  expires_at: row.session_expires_at,
  idle_expires_at: row.session_idle_expires_at,
  last_seen_at: row.session_last_seen_at,
  revoked_at: row.session_revoked_at,
  token_version: row.session_token_version,
});

const userRowFromAuthenticated = (row: AuthenticatedRows): UserRow => ({
  id: row.user_id_value,
  status: row.user_status,
  display_name: row.user_display_name,
  locale: row.user_locale,
  created_at: row.user_created_at,
  updated_at: row.user_updated_at,
  version: row.user_version,
});

const safeCursorId = (cursor: string | undefined): string | undefined => {
  if (cursor === undefined) {
    return undefined;
  }
  const id = decodeCursor(cursor);
  const parsed = id.match(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  if (parsed === null) {
    throw new AppError("VALIDATION_FAILED", "cursor is invalid");
  }
  return id;
};

export class ApiRepository {
  readonly #persistence: Persistence;
  readonly #config: AppConfig;
  readonly #wechatAdapter: WechatAdapter;

  public constructor(
    persistence: Persistence,
    config: AppConfig,
    wechatAdapter: WechatAdapter,
  ) {
    this.#persistence = persistence;
    this.#config = config;
    this.#wechatAdapter = wechatAdapter;
  }

  public async exchangeWechatCode(
    loginCode: string,
  ): Promise<AuthenticatedSession> {
    const providerIdentity = await this.#wechatAdapter.exchange(loginCode);
    const accessToken = issueSessionToken();
    const tokenDigest = digestSessionToken(accessToken);
    const now = new Date();

    return withAppTransaction(this.#persistence, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          `wechat_miniprogram:${providerIdentity.providerTenantKey}:${providerIdentity.providerSubject}`,
        ],
      );

      const identityResult = await client.query<{
        id: string;
        user_id: string;
        status: string;
      }>(
        `SELECT id, user_id, status
         FROM auth_identities
         WHERE provider = 'wechat_miniprogram'
           AND provider_tenant_key = $1
           AND provider_subject = $2
         FOR UPDATE`,
        [
          providerIdentity.providerTenantKey,
          providerIdentity.providerSubject,
        ],
      );

      let userId: string;
      let authIdentityId: string;

      if (identityResult.rowCount === 0) {
        userId = newEntityId();
        authIdentityId = newEntityId();
        await client.query(
          `INSERT INTO users (
             id, status, locale, created_at, updated_at, version
           ) VALUES ($1, 'active', 'zh-CN', $2, $2, 0)`,
          [userId, now],
        );
        await client.query(
          `INSERT INTO auth_identities (
             id, user_id, provider, provider_tenant_key, provider_subject,
             provider_union_subject, status, created_at, last_authenticated_at
           ) VALUES (
             $1, $2, 'wechat_miniprogram', $3, $4, $5, 'active', $6, $6
           )`,
          [
            authIdentityId,
            userId,
            providerIdentity.providerTenantKey,
            providerIdentity.providerSubject,
            providerIdentity.providerUnionSubject ?? null,
            now,
          ],
        );
      } else {
        const identity = identityResult.rows[0];
        if (identity === undefined || identity.status !== "active") {
          throw new AppError(
            "AUTHENTICATION_REQUIRED",
            "Login is not available",
          );
        }
        userId = identity.user_id;
        authIdentityId = identity.id;
        await client.query(
          `UPDATE auth_identities
           SET last_authenticated_at = $2,
               provider_union_subject =
                 COALESCE(provider_union_subject, $3)
           WHERE id = $1`,
          [
            authIdentityId,
            now,
            providerIdentity.providerUnionSubject ?? null,
          ],
        );
      }

      const userResult = await client.query<UserRow>(
        "SELECT * FROM users WHERE id = $1 FOR SHARE",
        [userId],
      );
      const userRow = userResult.rows[0];
      if (userRow === undefined || userRow.status !== "active") {
        throw new AppError(
          "AUTHENTICATION_REQUIRED",
          "Login is not available",
        );
      }

      const sessionId = newEntityId();
      const expiresAt = plusDays(
        now,
        this.#config.sessionAbsoluteTtlDays,
      );
      const idleExpiresAt = plusDays(
        now,
        this.#config.sessionIdleTtlDays,
      );
      const sessionResult = await client.query<SessionRow>(
        `INSERT INTO sessions (
           id, user_id, auth_identity_id, token_digest, status,
           issued_at, expires_at, idle_expires_at, last_seen_at, token_version
         ) VALUES (
           $1, $2, $3, $4, 'active', $5, $6, $7, $5, 1
         )
         RETURNING *`,
        [
          sessionId,
          userId,
          authIdentityId,
          tokenDigest,
          now,
          expiresAt,
          idleExpiresAt,
        ],
      );
      const sessionRow = sessionResult.rows[0];
      if (sessionRow === undefined) {
        throw new AppError("INTERNAL_ERROR", "Session could not be created");
      }

      return authenticatedSessionSchema.parse({
        accessToken,
        session: mapSession(sessionRow),
        user: mapUser(userRow),
      });
    });
  }

  async #withAuthenticated<T>(
    accessTokenInput: string | undefined,
    requestId: RequestId,
    operation: (
      client: PoolClient,
      context: AuthenticatedUserContext,
      user: User,
    ) => Promise<T>,
  ): Promise<T> {
    const parsedToken = sessionTokenSchema.safeParse(accessTokenInput);
    if (!parsedToken.success) {
      throw new AppError(
        "AUTHENTICATION_REQUIRED",
        "A valid bearer session is required",
      );
    }
    const accessToken = parsedToken.data;
    const tokenDigest = digestSessionToken(accessToken);

    return withAppTransaction(this.#persistence, async (client) => {
      const result = await client.query<AuthenticatedRows>(
        `SELECT
           s.id AS session_id,
           s.user_id AS session_user_id,
           s.auth_identity_id AS session_auth_identity_id,
           s.status AS session_status,
           s.issued_at AS session_issued_at,
           s.expires_at AS session_expires_at,
           s.idle_expires_at AS session_idle_expires_at,
           s.last_seen_at AS session_last_seen_at,
           s.revoked_at AS session_revoked_at,
           s.token_version AS session_token_version,
           u.id AS user_id_value,
           u.status AS user_status,
           u.display_name AS user_display_name,
           u.locale AS user_locale,
           u.created_at AS user_created_at,
           u.updated_at AS user_updated_at,
           u.version AS user_version
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_digest = $1
         FOR UPDATE OF s
         FOR SHARE OF u`,
        [tokenDigest],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new AppError(
          "AUTHENTICATION_REQUIRED",
          "A valid bearer session is required",
        );
      }

      const now = new Date();
      if (
        row.session_status !== "active" ||
        row.user_status !== "active" ||
        row.session_expires_at.getTime() <= now.getTime() ||
        row.session_idle_expires_at.getTime() <= now.getTime() ||
        row.session_user_id !== row.user_id_value
      ) {
        throw new AppError(
          "SESSION_EXPIRED",
          "The session is expired or revoked",
        );
      }

      const session = mapSession(sessionRowFromAuthenticated(row));
      const user = mapUser(userRowFromAuthenticated(row));
      authenticatedSessionSchema.parse({ accessToken, session, user });

      const nextIdleExpiry = new Date(
        Math.min(
          row.session_expires_at.getTime(),
          plusDays(now, this.#config.sessionIdleTtlDays).getTime(),
        ),
      );
      await client.query(
        `UPDATE sessions
         SET last_seen_at = $2, idle_expires_at = $3
         WHERE id = $1`,
        [row.session_id, now, nextIdleExpiry],
      );
      await setUserContext(client, row.user_id_value);

      return operation(
        client,
        {
          requestId,
          sessionId: row.session_id,
          userId: row.user_id_value,
        },
        user,
      );
    });
  }

  async #bootstrapHousehold(
    client: PoolClient,
    context: AuthenticatedUserContext,
    householdId: string,
    requiredCapability?: string,
  ): Promise<HouseholdContext> {
    await setHouseholdContext(client, householdId);
    const result = await client.query<MembershipRow>(
      `SELECT *
       FROM memberships
       WHERE household_id = $1
         AND user_id = $2
         AND status = 'active'`,
      [householdId, context.userId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "Household resource was not found",
      );
    }
    const membership = mapMembership(row);
    if (
      requiredCapability !== undefined &&
      membership.role !== "owner" &&
      !membership.capabilities.includes(
        requiredCapability as (typeof membership.capabilities)[number],
      )
    ) {
      throw new AppError("FORBIDDEN", "Household capability is required");
    }

    return {
      ...context,
      householdId,
      membershipId: membership.id,
      role: membership.role,
      capabilities: membership.capabilities,
    };
  }

  async #runIdempotent<T>(
    client: PoolClient,
    input: {
      readonly scope: "user" | "household";
      readonly userId: string;
      readonly householdId?: string;
      readonly method: string;
      readonly normalizedRoute: string;
      readonly key: string;
      readonly resourceTarget?: unknown;
      readonly payload: unknown;
      readonly requestId: RequestId;
      readonly statusCode: number;
    },
    operation: () => Promise<T>,
  ): Promise<IdempotentResponse<T>> {
    const key = idempotencyKeySchema.parse(input.key);
    const hash = requestHash({
      resourceTarget: input.resourceTarget ?? null,
      payload: input.payload,
    });
    const now = new Date();
    const recordId = newEntityId();
    const insert = await client.query<{ id: string }>(
      `INSERT INTO idempotency_records (
         id, scope_kind, user_id, household_id, method, normalized_route,
         idempotency_key, request_hash, original_request_id,
         first_processed_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       )
       ON CONFLICT (
         user_id, household_id, method, normalized_route, idempotency_key
       ) DO NOTHING
       RETURNING id`,
      [
        recordId,
        input.scope,
        input.userId,
        input.householdId ?? null,
        input.method,
        input.normalizedRoute,
        key,
        hash,
        input.requestId,
        now,
        plusDays(now, 30),
      ],
    );

    if (insert.rowCount === 0) {
      const existingResult = await client.query<IdempotencyRow>(
        `SELECT request_hash, status_code, response_body,
                original_request_id, first_processed_at
         FROM idempotency_records
         WHERE user_id = $1
           AND household_id IS NOT DISTINCT FROM $2
           AND method = $3
           AND normalized_route = $4
           AND idempotency_key = $5
         FOR UPDATE`,
        [
          input.userId,
          input.householdId ?? null,
          input.method,
          input.normalizedRoute,
          key,
        ],
      );
      const existing = existingResult.rows[0];
      if (existing === undefined) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Idempotency record could not be loaded",
        );
      }
      if (existing.request_hash !== hash) {
        throw new AppError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key was already used with a different request",
        );
      }
      if (
        existing.status_code === null ||
        existing.response_body === null ||
        typeof existing.response_body !== "object"
      ) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Idempotency record is incomplete",
        );
      }
      const stored = existing.response_body as {
        readonly ok: true;
        readonly data: T;
      };
      return {
        statusCode: existing.status_code,
        body: {
          ok: true,
          data: stored.data,
          meta: {
            requestId: input.requestId,
            idempotency: {
              key,
              scope: input.scope,
              replayed: true,
              firstProcessedAt:
                existing.first_processed_at.toISOString(),
              originalRequestId: requestIdSchema.parse(
                existing.original_request_id,
              ),
            },
          },
        },
      };
    }

    const data = await operation();
    const body = {
      ok: true as const,
      data,
      meta: {
        requestId: input.requestId,
        idempotency: {
          key,
          scope: input.scope,
          replayed: false,
          firstProcessedAt: now.toISOString(),
          originalRequestId: input.requestId,
        },
      },
    };
    await client.query(
      `UPDATE idempotency_records
       SET status_code = $2, response_body = $3::jsonb
       WHERE id = $1`,
      [recordId, input.statusCode, JSON.stringify(body)],
    );

    return { statusCode: input.statusCode, body };
  }

  public async revokeSession(
    accessToken: string | undefined,
    requestId: RequestId,
  ): Promise<{ readonly revoked: true }> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, context) => {
        const result = await client.query(
          `UPDATE sessions
           SET status = 'revoked', revoked_at = clock_timestamp()
           WHERE id = $1 AND status = 'active'`,
          [context.sessionId],
        );
        if (result.rowCount !== 1) {
          throw new AppError("SESSION_EXPIRED", "Session is no longer active");
        }
        return { revoked: true as const };
      },
    );
  }

  public async getMe(
    accessToken: string | undefined,
    requestId: RequestId,
  ): Promise<{ readonly user: User; readonly households: Household[] }> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, context, user) => {
        const households = await client.query<HouseholdRow>(
          `SELECT h.*
           FROM households h
           JOIN memberships m
             ON m.household_id = h.id
            AND m.user_id = $1
            AND m.status = 'active'
           WHERE h.status = 'active'
           ORDER BY h.id`,
          [context.userId],
        );
        return {
          user,
          households: households.rows.map(mapHousehold),
        };
      },
    );
  }

  public async listHouseholds(
    accessToken: string | undefined,
    requestId: RequestId,
    options: { readonly cursor?: string; readonly limit: number },
  ): Promise<Page<Household>> {
    const cursorId = safeCursorId(options.cursor);
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, context) => {
        const result = await client.query<HouseholdRow>(
          `SELECT h.*
           FROM households h
           JOIN memberships m
             ON m.household_id = h.id
            AND m.user_id = $1
            AND m.status = 'active'
           WHERE h.status = 'active'
             AND ($2::uuid IS NULL OR h.id > $2::uuid)
           ORDER BY h.id
           LIMIT $3`,
          [context.userId, cursorId ?? null, options.limit + 1],
        );
        const hasMore = result.rows.length > options.limit;
        const visibleRows = result.rows.slice(0, options.limit);
        const last = visibleRows.at(-1);
        return {
          items: visibleRows.map(mapHousehold),
          pageInfo:
            hasMore && last !== undefined
              ? {
                  hasMore: true,
                  nextCursor: encodeCursor(last.id),
                }
              : { hasMore: false, nextCursor: null },
        };
      },
    );
  }

  public async createHousehold(
    accessToken: string | undefined,
    requestId: RequestId,
    idempotencyKey: string,
    request: CreateHouseholdRequest,
  ): Promise<IdempotentResponse<CreateHouseholdResult>> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, context) =>
        this.#runIdempotent(
          client,
          {
            scope: "user",
            userId: context.userId,
            method: "POST",
            normalizedRoute: normalizedRoutes.createHousehold,
            key: idempotencyKey,
            payload: request,
            requestId,
            statusCode: 201,
          },
          async () => {
            const householdId = newEntityId();
            const membershipId = newEntityId();
            const profileId = newEntityId();
            const now = new Date();
            await setHouseholdContext(client, householdId);

            await client.query(
              `INSERT INTO households (
                 id, name, timezone, locale, status, created_by_user_id,
                 created_at, updated_at, version
               ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $6, 0)
              `,
              [
                householdId,
                request.name,
                request.timezone,
                request.locale,
                context.userId,
                now,
              ],
            );
            const membershipResult = await client.query<MembershipRow>(
              `INSERT INTO memberships (
                 id, household_id, user_id, role, capabilities, status,
                 joined_at, updated_at, version
               ) VALUES (
                 $1, $2, $3, 'owner', $4::jsonb, 'active', $5, $5, 0
               )
               RETURNING *`,
              [
                membershipId,
                householdId,
                context.userId,
                JSON.stringify([
                  "inventory:write",
                  "meal:write",
                  "shopping:write",
                ]),
                now,
              ],
            );
            const profileResult = await client.query<PersonProfileRow>(
              `INSERT INTO person_profiles (
                 id, household_id, linked_membership_id, display_name,
                 status, default_participation, default_portion_scale,
                 cooking_skill, dietary_constraints, created_at, updated_at,
                 version
               ) VALUES (
                 $1, $2, $3, $4, 'active', 1, $5, $6, '[]'::jsonb,
                 $7, $7, 0
               )
               RETURNING *`,
              [
                profileId,
                householdId,
                membershipId,
                request.ownerProfile.displayName,
                request.ownerProfile.defaultPortionScale,
                request.ownerProfile.cookingSkill,
                now,
              ],
            );
            const householdResult = await client.query<HouseholdRow>(
              "SELECT * FROM households WHERE id = $1",
              [householdId],
            );
            const householdRow = householdResult.rows[0];
            const membershipRow = membershipResult.rows[0];
            const profileRow = profileResult.rows[0];
            if (
              householdRow === undefined ||
              membershipRow === undefined ||
              profileRow === undefined
            ) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Household could not be created",
              );
            }
            return createHouseholdResultSchema.parse({
              household: mapHousehold(householdRow),
              membership: mapMembership(membershipRow),
              ownerProfile: mapPersonProfile(profileRow),
            });
          },
        ),
    );
  }

  public async listInventoryLots(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    options: { readonly cursor?: string; readonly limit: number },
  ): Promise<Page<InventoryLot>> {
    const cursorId = safeCursorId(options.cursor);
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, context) => {
        await this.#bootstrapHousehold(client, context, householdId);
        const result = await client.query<InventoryLotRow>(
          `SELECT *
           FROM inventory_lots
           WHERE household_id = $1
             AND ($2::uuid IS NULL OR id > $2::uuid)
           ORDER BY id
           LIMIT $3`,
          [householdId, cursorId ?? null, options.limit + 1],
        );
        const hasMore = result.rows.length > options.limit;
        const visibleRows = result.rows.slice(0, options.limit);
        const last = visibleRows.at(-1);
        return {
          items: visibleRows.map(mapInventoryLot),
          pageInfo:
            hasMore && last !== undefined
              ? {
                  hasMore: true,
                  nextCursor: encodeCursor(last.id),
                }
              : { hasMore: false, nextCursor: null },
        };
      },
    );
  }

  public async createInventoryLot(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    idempotencyKey: string,
    request: CreateInventoryLotRequest,
  ): Promise<IdempotentResponse<CreateInventoryLotResult>> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
          "inventory:write",
        );
        return this.#runIdempotent(
          client,
          {
            scope: "household",
            userId: context.userId,
            householdId,
            method: "POST",
            normalizedRoute: normalizedRoutes.createInventoryLot,
            key: idempotencyKey,
            payload: request,
            requestId,
            statusCode: 201,
          },
          async () => {
            const lotId = newEntityId();
            const eventId = newEntityId();
            const now = new Date();
            const capturedAt = now.toISOString();
            const dates = request.dates.map((date) => ({
              kind: date.kind,
              value: date.value,
              source: {
                ...date.source,
                capturedAt,
                ...(date.source.kind === "confirmed_recognition"
                  ? { confirmedByUserId: context.userId }
                  : {}),
              },
            }));
            const quantity = request.initialQuantity;
            const isQualitative = quantity.kind === "qualitative";
            const quantityAmount =
              quantity.kind === "qualitative"
                ? null
                : quantity.kind === "exact"
                  ? toDatabaseQuantityDecimal(quantity.amount)
                  : toDatabaseApproximateQuantityDecimal(
                      quantity.amount,
                    );
            const quantityUnit = isQualitative ? null : quantity.unit;
            const quantityOriginalText = quantity.originalText ?? null;
            const quantityConfidence =
              quantity.kind === "approximate" ? quantity.confidence : null;
            const quantityLevel = isQualitative ? quantity.level : null;
            const changeKind = isQualitative ? "qualitative" : "numeric";
            const changePrecision =
              quantity.kind === "exact"
                ? "exact"
                : quantity.kind === "approximate"
                  ? "estimated"
                  : null;

            const lotResult = await client.query<InventoryLotRow>(
              `INSERT INTO inventory_lots (
                 id, household_id, food_concept_id, display_name, state,
                 storage_location, current_quantity_kind,
                 current_quantity_amount, current_quantity_unit,
                 current_quantity_original_text,
                 current_quantity_confidence, current_quantity_level,
                 dates, safety_status, safety_reason_codes,
                 safety_policy_version, safety_evaluated_at, origin,
                 created_by_user_id, created_at, updated_at, version
               ) VALUES (
                 $1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11,
                 $12::jsonb, 'unknown', '[]'::jsonb,
                 'stage-06-manual-v1', $13, 'manual', $14, $13, $13, 1
               )
               RETURNING *`,
              [
                lotId,
                householdId,
                request.foodConceptId ?? null,
                request.displayName,
                request.storageLocation,
                quantity.kind,
                quantityAmount,
                quantityUnit,
                quantityOriginalText,
                quantityConfidence,
                quantityLevel,
                JSON.stringify(dates),
                now,
                context.userId,
              ],
            );

            const eventResult = await client.query<InventoryEventRow>(
              `INSERT INTO inventory_events (
                 id, household_id, inventory_lot_id, type,
                 quantity_change_kind, quantity_change_amount,
                 quantity_change_unit, quantity_change_precision,
                 quantity_change_confidence, quantity_change_original_text,
                 quantity_from_level, quantity_to_level, actor_user_id,
                 source, occurred_at, recorded_at, idempotency_key,
                 normalized_route, expected_lot_version,
                 resulting_lot_version
               ) VALUES (
                 $1, $2, $3, 'acquired', $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, 'manual_confirmation', $13, $13, $14, $15, 0, 1
               )
               RETURNING *`,
              [
                eventId,
                householdId,
                lotId,
                changeKind,
                quantityAmount,
                quantityUnit,
                changePrecision,
                quantityConfidence,
                quantityOriginalText,
                isQualitative ? "empty" : null,
                quantityLevel,
                context.userId,
                now,
                idempotencyKey,
                normalizedRoutes.createInventoryLot,
              ],
            );
            const lotRow = lotResult.rows[0];
            const eventRow = eventResult.rows[0];
            if (lotRow === undefined || eventRow === undefined) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Inventory lot could not be created",
              );
            }
            return createInventoryLotResultSchema.parse({
              lot: mapInventoryLot(lotRow),
              event: mapInventoryEvent(eventRow),
            });
          },
        );
      },
    );
  }

  public async consumeInventoryLot(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    lotId: string,
    idempotencyKey: string,
    request: ConsumeInventoryLotRequest,
  ): Promise<IdempotentResponse<ConsumeInventoryLotResult>> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
          "inventory:write",
        );
        return this.#runIdempotent(
          client,
          {
            scope: "household",
            userId: context.userId,
            householdId,
            method: "POST",
            normalizedRoute: normalizedRoutes.consumeInventoryLot,
            key: idempotencyKey,
            resourceTarget: { inventoryLotId: lotId },
            payload: request,
            requestId,
            statusCode: 201,
          },
          async () => {
            const locked = await client.query<InventoryLotRow>(
              `SELECT *
               FROM inventory_lots
               WHERE household_id = $1 AND id = $2
               FOR UPDATE`,
              [householdId, lotId],
            );
            const before = locked.rows[0];
            if (before === undefined) {
              throw new AppError(
                "RESOURCE_NOT_FOUND",
                "Inventory lot was not found",
              );
            }
            if (before.version !== request.expectedVersion) {
              throw new AppError(
                "INVENTORY_VERSION_CONFLICT",
                `Inventory lot is at version ${before.version}`,
              );
            }
            if (
              before.current_quantity_kind !== "exact" ||
              before.current_quantity_unit !==
                request.consumedQuantity.unit
            ) {
              throw new AppError(
                "CONFLICT",
                "Consumed quantity unit must match an exact inventory lot",
              );
            }
            const consumedAmount = toDatabaseQuantityDecimal(
              request.consumedQuantity.amount,
            );
            const resultingVersion = before.version + 1;
            const now = new Date();
            const lotResult = await client.query<InventoryLotRow>(
              `UPDATE inventory_lots
               SET current_quantity_amount =
                     current_quantity_amount - $3::numeric(15, 6),
                   current_quantity_original_text = NULL,
                   state = CASE
                     WHEN current_quantity_amount - $3::numeric(15, 6) = 0
                                THEN 'depleted' ELSE 'active' END,
                   updated_at = $4,
                   version = $5
               WHERE household_id = $1
                 AND id = $2
                 AND version = $6
                 AND current_quantity_amount >= $3::numeric(15, 6)
               RETURNING *`,
              [
                householdId,
                lotId,
                consumedAmount,
                now,
                resultingVersion,
                request.expectedVersion,
              ],
            );
            if (lotResult.rowCount !== 1) {
              throw new AppError(
                "INVENTORY_INSUFFICIENT",
                "Consumed quantity exceeds available inventory",
              );
            }

            const eventResult = await client.query<InventoryEventRow>(
              `INSERT INTO inventory_events (
                 id, household_id, inventory_lot_id, type,
                 quantity_change_kind, quantity_change_amount,
                 quantity_change_unit, quantity_change_precision,
                 quantity_change_original_text, actor_user_id, source,
                 occurred_at, recorded_at, idempotency_key,
                 normalized_route, expected_lot_version,
                 resulting_lot_version, note
               ) VALUES (
                 $1, $2, $3, 'consumed', 'numeric',
                 -$4::numeric(15, 6), $5, 'exact', $6,
                 $7, 'manual_confirmation', $8, $8, $9, $10, $11, $12, $13
               )
               RETURNING *`,
              [
                newEntityId(),
                householdId,
                lotId,
                consumedAmount,
                request.consumedQuantity.unit,
                request.consumedQuantity.originalText ?? null,
                context.userId,
                now,
                idempotencyKey,
                normalizedRoutes.consumeInventoryLot,
                request.expectedVersion,
                resultingVersion,
                request.note ?? null,
              ],
            );
            const lotRow = lotResult.rows[0];
            const eventRow = eventResult.rows[0];
            if (lotRow === undefined || eventRow === undefined) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Consumed event could not be recorded",
              );
            }
            return consumeInventoryLotResultSchema.parse({
              lot: mapInventoryLot(lotRow),
              event: mapInventoryEvent(eventRow),
            });
          },
        );
      },
    );
  }
}
