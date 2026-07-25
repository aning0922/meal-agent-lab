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
  confirmPersonProfileLinkResultSchema,
  createHouseholdInviteResultSchema,
  getPersonProfileResultSchema,
  joinHouseholdResultSchema,
  listHouseholdMembersResultSchema,
  listPersonProfilesResultSchema,
  personProfileLinkRequestListResultSchema,
  personProfileLinkRequestResultSchema,
  personProfileMutationReceiptSchema,
  removeMembershipResultSchema,
  revokeHouseholdInviteResultSchema,
  type AddDietaryConstraintRequest,
  type ConfirmPersonProfileLinkRequest,
  type ConfirmPersonProfileLinkResult,
  type CreateHouseholdInviteRequest,
  type CreateHouseholdInviteResult,
  type CreatePersonProfileLinkRequest,
  type CreatePersonProfileRequest,
  type GetPersonProfileResult,
  type HouseholdInvite,
  type JoinHouseholdRequest,
  type JoinHouseholdResult,
  type ListHouseholdMembersResult,
  type ListPersonProfilesResult,
  type PatchPersonProfileRequest,
  type PersonProfileLinkRequestListResult,
  type PersonProfileLinkRequestResult,
  type PersonProfileMutationReceipt,
  type RemoveDietaryConstraintRequest,
  type RemoveMembershipResult,
  type RevokeHouseholdInviteResult,
} from "@meal-agent/contracts/members";
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
  apiErrorCodeSchema,
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
  digestInviteCode,
  digestSessionToken,
  encodeCursor,
  issueInviteCode,
  issueSessionToken,
  newEntityId,
  requestHash,
  toDatabaseApproximateQuantityDecimal,
  toDatabaseQuantityDecimal,
} from "../utils.js";
import type { WechatAdapter } from "../wechat/adapter.js";
import {
  mapHousehold,
  mapHouseholdInvite,
  mapInventoryEvent,
  mapInventoryLot,
  mapMembership,
  mapPersonProfile,
  mapRedactedPersonProfile,
  mapSession,
  mapUser,
  type HouseholdInviteRow,
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

interface IdempotencyInput {
  readonly scope: "user" | "household";
  readonly userId: string;
  readonly householdId?: string;
  readonly method: string;
  readonly normalizedRoute: NormalizedRoute;
  readonly key: string;
  readonly resourceTarget?: unknown;
  readonly payload: unknown;
  readonly requestId: RequestId;
  readonly statusCode: number;
}

interface PersonProfileLinkRequestRow {
  readonly id: string;
  readonly household_id: string;
  readonly profile_id: string;
  readonly target_membership_id: string;
  readonly initiated_by_user_id: string;
  readonly status: string;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly confirmed_at: Date | string | null;
  readonly terminal_reason: string | null;
  readonly disclosure_status: "available" | "legacy_unavailable";
  readonly disclosure_version: number | null;
  readonly profile_version_at_request: number | null;
  readonly disclosed_profile_name: string | null;
  readonly disclosed_household_hard_count: number | null;
  readonly disclosed_household_soft_count: number | null;
  readonly disclosed_private_constraint_count: number | null;
  readonly version: number;
}

interface CommittedDomainError {
  readonly kind: "committed-domain-error";
  readonly error: AppError;
}

const committedDomainError = (
  code: ConstructorParameters<typeof AppError>[0],
  message: string,
): CommittedDomainError => ({
  kind: "committed-domain-error",
  error: new AppError(code, message),
});

const isCommittedDomainError = (
  value: unknown,
): value is CommittedDomainError =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  value.kind === "committed-domain-error";

const normalizedRoutes = {
  createHousehold: "/api/v1/households",
  createInventoryLot: "/api/v1/households/{id}/inventory-lots",
  consumeInventoryLot:
    "/api/v1/households/{id}/inventory-lots/{lotId}/events/consumed",
  createHouseholdInvite: "/api/v1/households/{id}/invites",
  revokeHouseholdInvite: "/api/v1/households/{id}/invites/{inviteId}",
  joinHousehold: "/api/v1/households/join",
  removeMembership: "/api/v1/households/{id}/memberships/{membershipId}",
  createPersonProfile: "/api/v1/households/{id}/person-profiles",
  patchPersonProfile:
    "/api/v1/households/{id}/person-profiles/{profileId}",
  addDietaryConstraint:
    "/api/v1/households/{id}/person-profiles/{profileId}/dietary-constraints",
  removeDietaryConstraint:
    "/api/v1/households/{id}/person-profiles/{profileId}/dietary-constraints",
  createPersonProfileLinkRequest:
    "/api/v1/households/{id}/person-profiles/{profileId}/link-requests",
  confirmPersonProfileLinkRequest:
    "/api/v1/households/{id}/person-profile-link-requests/{requestId}/confirm",
} as const;

type NormalizedRoute =
  (typeof normalizedRoutes)[keyof typeof normalizedRoutes];

type IdempotencyPolicy =
  | { readonly kind: "full" }
  | {
      readonly kind: "one-time-secret";
      readonly safeReplayProjection: (data: unknown) => unknown;
    }
  | { readonly kind: "receipt" };

/**
 * 所有幂等写路由必须在此注册。新增路由无法再通过 endpoint 局部传
 * redact 回调绕过安全复核；profile/constraint 写入统一限制为 receipt。
 */
const idempotencyPolicies: Record<NormalizedRoute, IdempotencyPolicy> = {
  [normalizedRoutes.createHousehold]: { kind: "full" },
  [normalizedRoutes.createInventoryLot]: { kind: "full" },
  [normalizedRoutes.consumeInventoryLot]: { kind: "full" },
  [normalizedRoutes.createHouseholdInvite]: {
    kind: "one-time-secret",
    safeReplayProjection: (data) => {
      const parsed = createHouseholdInviteResultSchema.parse(data);
      return { invite: parsed.invite };
    },
  },
  [normalizedRoutes.revokeHouseholdInvite]: { kind: "full" },
  [normalizedRoutes.joinHousehold]: { kind: "full" },
  [normalizedRoutes.removeMembership]: { kind: "full" },
  [normalizedRoutes.createPersonProfile]: { kind: "receipt" },
  [normalizedRoutes.patchPersonProfile]: { kind: "receipt" },
  [normalizedRoutes.addDietaryConstraint]: { kind: "receipt" },
  [normalizedRoutes.createPersonProfileLinkRequest]: { kind: "full" },
  [normalizedRoutes.confirmPersonProfileLinkRequest]: { kind: "full" },
};

const plusDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);

const mapPersonProfileLinkRequest = (
  row: PersonProfileLinkRequestRow,
) =>
  personProfileLinkRequestResultSchema.shape.request.parse({
    id: row.id,
    householdId: row.household_id,
    profileId: row.profile_id,
    targetMembershipId: row.target_membership_id,
    initiatedByUserId: row.initiated_by_user_id,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    ...(row.confirmed_at === null
      ? {}
      : { confirmedAt: new Date(row.confirmed_at).toISOString() }),
    disclosure:
      row.disclosure_status === "legacy_unavailable"
        ? { availability: "legacy_unavailable" }
        : {
            availability: "available",
            disclosureVersion: row.disclosure_version,
            profileVersion: row.profile_version_at_request,
            profileDisplayName: row.disclosed_profile_name,
            householdVisibleHardConstraintCount:
              row.disclosed_household_hard_count,
            householdVisibleSoftConstraintCount:
              row.disclosed_household_soft_count,
            privateConstraintCount:
              row.disclosed_private_constraint_count,
            subjectWillGainProfileAccess: true,
            membershipExitArchivesProfile: true,
            rejoinRestoresAutomatically: false,
            privateConstraintContentsRemainPrivate: true,
          },
    version: row.version,
  });

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

  async #loadIdempotentReplay<T>(
    client: PoolClient,
    input: IdempotencyInput,
    commitDomainErrors: boolean,
  ): Promise<
    IdempotentResponse<T> | CommittedDomainError | null
  > {
    const key = idempotencyKeySchema.parse(input.key);
    const hash = requestHash({
      resourceTarget: input.resourceTarget ?? null,
      payload: input.payload,
    });
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
      return null;
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
      typeof existing.response_body !== "object" ||
      Array.isArray(existing.response_body)
    ) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Idempotency record is incomplete",
      );
    }
    const stored = existing.response_body as {
      readonly ok: boolean;
      readonly data?: T;
      readonly error?: {
        readonly code?: unknown;
        readonly message?: unknown;
        readonly retryable?: unknown;
      };
    };
    if (stored.ok === false) {
      const code = apiErrorCodeSchema.safeParse(stored.error?.code);
      if (
        !code.success ||
        typeof stored.error?.message !== "string" ||
        typeof stored.error.retryable !== "boolean"
      ) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Stored idempotency failure is malformed",
        );
      }
      const replayedError = committedDomainError(
        code.data,
        stored.error.message,
      );
      if (!commitDomainErrors) {
        throw replayedError.error;
      }
      return replayedError;
    }
    if (stored.ok !== true || stored.data === undefined) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Stored idempotency success is malformed",
      );
    }
    if (
      typeof stored.data === "object" &&
      stored.data !== null &&
      "nonReplayable" in stored.data &&
      stored.data.nonReplayable === true
    ) {
      throw new AppError(
        "CONFLICT",
        "The original command completed, but its legacy sensitive response cannot be replayed; fetch current state",
      );
    }
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
            firstProcessedAt: existing.first_processed_at.toISOString(),
            originalRequestId: requestIdSchema.parse(
              existing.original_request_id,
            ),
          },
        },
      },
    };
  }

  async #runIdempotent<T>(
    client: PoolClient,
    input: IdempotencyInput,
    operation: () => Promise<T>,
  ): Promise<IdempotentResponse<T>>;
  async #runIdempotent<T>(
    client: PoolClient,
    input: IdempotencyInput,
    operation: () => Promise<T | CommittedDomainError>,
    commitDomainErrors: true,
  ): Promise<IdempotentResponse<T> | CommittedDomainError>;
  async #runIdempotent<T>(
    client: PoolClient,
    input: IdempotencyInput,
    operation: () => Promise<T | CommittedDomainError>,
    commitDomainErrors = false,
  ): Promise<IdempotentResponse<T> | CommittedDomainError> {
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
      const replay = await this.#loadIdempotentReplay<T>(
        client,
        input,
        commitDomainErrors,
      );
      if (replay === null) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Idempotency record could not be loaded",
        );
      }
      return replay;
    }

    const data = await operation();
    if (isCommittedDomainError(data)) {
      if (!commitDomainErrors) {
        throw data.error;
      }
      const storedFailure = {
        ok: false as const,
        error: {
          code: data.error.code,
          message: data.error.message,
          retryable: data.error.retryable,
        },
      };
      const completed = await client.query(
        `UPDATE idempotency_records
         SET status_code = $2, response_body = $3::jsonb
         WHERE id = $1`,
        [
          recordId,
          data.error.status,
          JSON.stringify(storedFailure),
        ],
      );
      if (completed.rowCount !== 1) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Failed command idempotency result could not be finalized",
        );
      }
      return data;
    }
    const meta = {
      requestId: input.requestId,
      idempotency: {
        key,
        scope: input.scope,
        replayed: false,
        firstProcessedAt: now.toISOString(),
        originalRequestId: input.requestId,
      },
    };
    const body = { ok: true as const, data, meta };
    const policy = idempotencyPolicies[input.normalizedRoute];
    const storedData =
      policy.kind === "one-time-secret"
        ? policy.safeReplayProjection(data)
        : policy.kind === "receipt"
          ? personProfileMutationReceiptSchema.parse(data)
          : data;
    const storedBody = { ok: true as const, data: storedData, meta };
    const completed = await client.query(
      `UPDATE idempotency_records
       SET status_code = $2, response_body = $3::jsonb
       WHERE id = $1`,
      [recordId, input.statusCode, JSON.stringify(storedBody)],
    );
    if (completed.rowCount !== 1) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Idempotency result could not be finalized",
      );
    }

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
                 $1, $2, $3, $4, 'active', $5, $6, $7, '[]'::jsonb,
                 $8, $8, 0
               )
               RETURNING *`,
              [
                profileId,
                householdId,
                membershipId,
                request.ownerProfile.displayName,
                request.ownerProfile.defaultParticipation === null
                  ? null
                  : request.ownerProfile.defaultParticipation
                    ? 1
                    : 0,
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

  #requireOwner(
    context: HouseholdContext,
    message = "An owner role is required",
  ): void {
    if (context.role !== "owner") {
      throw new AppError("FORBIDDEN", message);
    }
  }

  async #loadAuthorizedProfile(
    client: PoolClient,
    context: HouseholdContext,
    householdId: string,
    profileId: string,
  ): Promise<PersonProfileRow> {
    const result = await client.query<PersonProfileRow>(
      "SELECT * FROM person_profiles WHERE household_id = $1 AND id = $2",
      [householdId, profileId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError("RESOURCE_NOT_FOUND", "Profile was not found");
    }
    const ownsProfile =
      row.linked_membership_id !== null &&
      row.linked_membership_id === context.membershipId;
    if (context.role !== "owner" && !ownsProfile) {
      throw new AppError(
        "FORBIDDEN",
        "You may not modify another member's profile",
      );
    }
    return row;
  }

  public async createHouseholdInvite(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    idempotencyKey: string,
    request: CreateHouseholdInviteRequest,
  ): Promise<IdempotentResponse<CreateHouseholdInviteResult>> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        this.#requireOwner(context, "Only an owner may issue invites");
        return this.#runIdempotent(
          client,
          {
            scope: "household",
            userId: context.userId,
            householdId,
            method: "POST",
            normalizedRoute: normalizedRoutes.createHouseholdInvite,
            key: idempotencyKey,
            payload: request,
            requestId,
            statusCode: 201,
          },
          async () => {
            // 每家庭串行化邀请签发，让活跃邀请上限检查免于竞态。
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
              [`household-invites:${householdId}`],
            );
            const now = new Date();
            // 上限只计入仍可兑换的邀请：过期项（expires_at 已过）虽仍是
            // 'active' 状态也不占坑，避免过期邀请永久堵死签发。
            const active = await client.query<{ count: number }>(
              `SELECT count(*)::int AS count
               FROM household_invites
               WHERE household_id = $1
                 AND status = 'active'
                 AND expires_at > $2`,
              [householdId, now],
            );
            if ((active.rows[0]?.count ?? 0) >= 10) {
              throw new AppError(
                "CONFLICT",
                "Household already has the maximum number of active invites",
              );
            }
            const code = issueInviteCode();
            const expiresAt = new Date(
              now.getTime() + request.expiresInHours * 3_600_000,
            );
            const inviteResult = await client.query<HouseholdInviteRow>(
              `INSERT INTO household_invites (
                 id, household_id, created_by_user_id, code_digest, status,
                 max_uses, used_count, expires_at, created_at, version
               ) VALUES ($1, $2, $3, $4, 'active', $5, 0, $6, $7, 0)
               RETURNING *`,
              [
                newEntityId(),
                householdId,
                context.userId,
                digestInviteCode(code),
                request.maxUses,
                expiresAt,
                now,
              ],
            );
            const inviteRow = inviteResult.rows[0];
            if (inviteRow === undefined) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Invite could not be created",
              );
            }
            return createHouseholdInviteResultSchema.parse({
              invite: mapHouseholdInvite(inviteRow),
              inviteCode: code,
            });
          },
        );
      },
    );
  }

  public async listHouseholdInvites(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    options: { readonly cursor?: string; readonly limit: number },
  ): Promise<Page<HouseholdInvite>> {
    const cursorId = safeCursorId(options.cursor);
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        this.#requireOwner(context, "Only an owner may list invites");
        const result = await client.query<HouseholdInviteRow>(
          `SELECT id, household_id, created_by_user_id,
                  CASE
                    WHEN status = 'active'
                      AND expires_at <= clock_timestamp() THEN 'expired'
                    ELSE status
                  END AS status,
                  max_uses, used_count, expires_at, created_at, version
           FROM household_invites
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
          items: visibleRows.map(mapHouseholdInvite),
          pageInfo:
            hasMore && last !== undefined
              ? { hasMore: true, nextCursor: encodeCursor(last.id) }
              : { hasMore: false, nextCursor: null },
        };
      },
    );
  }

  public async revokeHouseholdInvite(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    inviteId: string,
    idempotencyKey: string,
  ): Promise<IdempotentResponse<RevokeHouseholdInviteResult>> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        this.#requireOwner(context, "Only an owner may revoke invites");
        return this.#runIdempotent(
          client,
          {
            scope: "household",
            userId: context.userId,
            householdId,
            method: "DELETE",
            normalizedRoute: normalizedRoutes.revokeHouseholdInvite,
            key: idempotencyKey,
            resourceTarget: { inviteId },
            payload: {},
            requestId,
            statusCode: 200,
          },
          async () => {
            const revoked = await client.query<HouseholdInviteRow>(
              `UPDATE household_invites
               SET status = 'revoked', version = version + 1
               WHERE household_id = $1 AND id = $2 AND status = 'active'
               RETURNING *`,
              [householdId, inviteId],
            );
            const row = revoked.rows[0];
            if (row === undefined) {
              const existing = await client.query(
                `SELECT 1
                 FROM household_invites
                 WHERE household_id = $1 AND id = $2`,
                [householdId, inviteId],
              );
              if (existing.rowCount === 0) {
                throw new AppError(
                  "RESOURCE_NOT_FOUND",
                  "Invite was not found",
                );
              }
              throw new AppError(
                "CONFLICT",
                "Invite is no longer active",
              );
            }
            return revokeHouseholdInviteResultSchema.parse({
              invite: mapHouseholdInvite(row),
            });
          },
        );
      },
    );
  }

  public async joinHousehold(
    accessToken: string | undefined,
    requestId: RequestId,
    idempotencyKey: string,
    request: JoinHouseholdRequest,
  ): Promise<IdempotentResponse<JoinHouseholdResult>> {
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
            normalizedRoute: normalizedRoutes.joinHousehold,
            key: idempotencyKey,
            payload: request,
            requestId,
            statusCode: 201,
          },
          async () => {
            const redeemed = await client.query<{
              result_code: string;
              out_household_id: string | null;
              out_membership_id: string | null;
            }>(
              `SELECT result_code, out_household_id, out_membership_id
               FROM meal_agent_private.redeem_household_invite(
                 $1, $2
               )`,
              [digestInviteCode(request.inviteCode), newEntityId()],
            );
            const outcome = redeemed.rows[0];
            if (outcome === undefined) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Invite redemption failed",
              );
            }
            if (outcome.result_code === "already_member") {
              throw new AppError(
                "CONFLICT",
                "You are already a member of this household",
              );
            }
            if (
              outcome.result_code !== "joined" ||
              outcome.out_household_id === null ||
              outcome.out_membership_id === null
            ) {
              // 无效 / 过期 / 撤销 / 用尽一律 404，不泄露家庭存在性。
              throw new AppError(
                "RESOURCE_NOT_FOUND",
                "The invite code is invalid",
              );
            }
            const joinedHouseholdId = outcome.out_household_id;
            await setHouseholdContext(client, joinedHouseholdId);
            const membershipResult = await client.query<MembershipRow>(
              "SELECT * FROM memberships WHERE household_id = $1 AND id = $2",
              [joinedHouseholdId, outcome.out_membership_id],
            );
            const householdResult = await client.query<HouseholdRow>(
              "SELECT * FROM households WHERE id = $1",
              [joinedHouseholdId],
            );
            const membershipRow = membershipResult.rows[0];
            const householdRow = householdResult.rows[0];
            if (membershipRow === undefined || householdRow === undefined) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Joined household could not be loaded",
              );
            }
            return joinHouseholdResultSchema.parse({
              membership: mapMembership(membershipRow),
              household: mapHousehold(householdRow),
            });
          },
        ),
    );
  }

  public async listHouseholdMembers(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
  ): Promise<ListHouseholdMembersResult> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        const membershipsResult = await client.query<MembershipRow>(
          `SELECT *
           FROM memberships
           WHERE household_id = $1 AND status = 'active'
           ORDER BY id`,
          [householdId],
        );
        const profilesResult = await client.query<PersonProfileRow>(
          `SELECT *
           FROM person_profiles
           WHERE household_id = $1
             AND linked_membership_id IS NOT NULL
             AND status = 'active'`,
          [householdId],
        );
        const profileByMembership = new Map<string, PersonProfileRow>();
        for (const row of profilesResult.rows) {
          if (row.linked_membership_id !== null) {
            profileByMembership.set(row.linked_membership_id, row);
          }
        }

        if (context.role === "owner") {
          const members = membershipsResult.rows.map((membershipRow) => {
            const profileRow = profileByMembership.get(membershipRow.id);
            return {
              membership: mapMembership(membershipRow),
              profile:
                profileRow === undefined
                  ? null
                  : mapPersonProfile(profileRow),
            };
          });
          return listHouseholdMembersResultSchema.parse({
            viewerRole: "owner",
            members,
          });
        }

        let self:
          | {
              readonly membership: Membership;
              readonly profile: ReturnType<typeof mapPersonProfile> | null;
            }
          | undefined;
        const others = [];
        for (const membershipRow of membershipsResult.rows) {
          const profileRow = profileByMembership.get(membershipRow.id);
          if (membershipRow.id === context.membershipId) {
            self = {
              membership: mapMembership(membershipRow),
              profile:
                profileRow === undefined
                  ? null
                  : mapPersonProfile(profileRow),
            };
          } else {
            others.push({
              membership: mapMembership(membershipRow),
              profile:
                profileRow === undefined
                  ? null
                  : mapRedactedPersonProfile(profileRow),
            });
          }
        }
        if (self === undefined) {
          throw new AppError(
            "INTERNAL_ERROR",
            "The requesting member is missing from the household",
          );
        }
        return listHouseholdMembersResultSchema.parse({
          viewerRole: "member",
          self,
          others,
        });
      },
    );
  }

  public async removeMembership(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    membershipId: string,
    idempotencyKey: string,
  ): Promise<IdempotentResponse<RemoveMembershipResult>> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        // 幂等 replay 必须先于 household bootstrap：自退出提交成功后，
        // 当前用户已不再是 active member，但同 key 仍必须读取已完成结果。
        await setHouseholdContext(client, householdId);
        const idempotencyInput: IdempotencyInput = {
          scope: "household",
          userId: authenticatedContext.userId,
          householdId,
          method: "DELETE",
          normalizedRoute: normalizedRoutes.removeMembership,
          key: idempotencyKey,
          resourceTarget: { membershipId },
          payload: {},
          requestId,
          statusCode: 200,
        };
        const replay =
          await this.#loadIdempotentReplay<RemoveMembershipResult>(
            client,
            idempotencyInput,
            false,
          );
        if (replay !== null) {
          if (isCommittedDomainError(replay)) {
            throw replay.error;
          }
          return replay;
        }
        await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        return this.#runIdempotent(
          client,
          idempotencyInput,
          async () => {
            const targetResult = await client.query<MembershipRow>(
              `SELECT *
               FROM memberships
               WHERE household_id = $1 AND id = $2`,
              [householdId, membershipId],
            );
            const target = targetResult.rows[0];
            if (target === undefined) {
              throw new AppError(
                "RESOURCE_NOT_FOUND",
                "Membership was not found",
              );
            }
            const transition = await client.query<{
              result_code: string;
              out_membership_id: string | null;
              out_status: string | null;
              out_version: number | null;
              out_updated_at: Date | null;
            }>(
              `SELECT *
               FROM meal_agent_private.transition_membership_status(
                 $1::uuid, $2::integer
               )`,
              [membershipId, target.version],
            );
            const outcome = transition.rows[0];
            if (
              outcome === undefined ||
              outcome.result_code === "not_found"
            ) {
              throw new AppError(
                "RESOURCE_NOT_FOUND",
                "Membership is not active",
              );
            }
            if (outcome.result_code === "forbidden") {
              throw new AppError(
                "FORBIDDEN",
                "Only an owner may remove other members",
              );
            }
            if (outcome.result_code === "last_owner") {
              throw new AppError(
                "CONFLICT",
                "The last owner cannot leave or be removed",
              );
            }
            if (
              outcome.result_code !== "changed" ||
              outcome.out_membership_id === null ||
              outcome.out_status === null ||
              outcome.out_version === null ||
              outcome.out_updated_at === null
            ) {
              throw new AppError(
                "CONFLICT",
                "Membership changed concurrently",
              );
            }
            // 自退出后当前用户已不再通过 memberships RLS，不能再次 SELECT
            // 本行。受控函数返回唯一可变字段；其余字段沿用加锁前读取的目标行。
            const row: MembershipRow = {
              ...target,
              status: outcome.out_status,
              updated_at: outcome.out_updated_at,
              version: outcome.out_version,
            };
            return removeMembershipResultSchema.parse({
              membership: mapMembership(row),
            });
          },
        );
      },
    );
  }

  public async listPersonProfiles(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    status: "active" | "archived" | "all",
  ): Promise<ListPersonProfilesResult> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        const result = await client.query<PersonProfileRow>(
          `SELECT *
           FROM person_profiles
           WHERE household_id = $1
             AND ($2::text = 'all' OR status = $2::text)
           ORDER BY id`,
          [householdId, status],
        );
        if (context.role === "owner") {
          return listPersonProfilesResultSchema.parse({
            viewerRole: "owner",
            profiles: result.rows.map(mapPersonProfile),
          });
        }

        let self: ReturnType<typeof mapPersonProfile> | null = null;
        const others = [];
        for (const row of result.rows) {
          if (row.linked_membership_id === context.membershipId) {
            self = mapPersonProfile(row);
          } else if (row.status === "active") {
            others.push(mapRedactedPersonProfile(row));
          }
        }
        return listPersonProfilesResultSchema.parse({
          viewerRole: "member",
          self,
          others,
        });
      },
    );
  }

  public async getPersonProfile(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    profileId: string,
  ): Promise<GetPersonProfileResult> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        const result = await client.query<PersonProfileRow>(
          `SELECT *
           FROM person_profiles
           WHERE household_id = $1 AND id = $2`,
          [householdId, profileId],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new AppError("RESOURCE_NOT_FOUND", "Profile was not found");
        }
        const isSelf =
          row.linked_membership_id !== null &&
          row.linked_membership_id === context.membershipId;
        if (context.role === "owner" || isSelf) {
          return getPersonProfileResultSchema.parse({
            access: "owner_or_self",
            profile: mapPersonProfile(row),
          });
        }
        if (row.status !== "active") {
          throw new AppError("RESOURCE_NOT_FOUND", "Profile was not found");
        }
        return getPersonProfileResultSchema.parse({
          access: "household",
          profile: mapRedactedPersonProfile(row),
        });
      },
    );
  }

  public async createPersonProfileLinkRequest(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    profileId: string,
    idempotencyKey: string,
    request: CreatePersonProfileLinkRequest,
  ): Promise<IdempotentResponse<PersonProfileLinkRequestResult>> {
    const result = await this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        this.#requireOwner(
          context,
          "Only an owner may initiate a profile link",
        );
        return this.#runIdempotent(
          client,
          {
            scope: "household",
            userId: context.userId,
            householdId,
            method: "POST",
            normalizedRoute:
              normalizedRoutes.createPersonProfileLinkRequest,
            key: idempotencyKey,
            resourceTarget: { profileId },
            payload: request,
            requestId,
            statusCode: 201,
          },
          async () => {
            const requestEntityId = newEntityId();
            const creation = await client.query<{
              result_code: string;
              out_request_id: string | null;
            }>(
              `SELECT result_code, out_request_id
               FROM meal_agent_private.create_person_profile_link_request(
                 $1::uuid, $2::uuid, $3::uuid, $4::integer
               )`,
              [
                requestEntityId,
                profileId,
                request.targetMembershipId,
                request.expiresInHours,
              ],
            );
            const outcome = creation.rows[0];
            if (
              outcome === undefined ||
              outcome.result_code === "invalid_request"
            ) {
              throw new AppError(
                "VALIDATION_FAILED",
                "Profile link request was invalid",
              );
            }
            if (outcome.result_code === "forbidden") {
              throw new AppError(
                "FORBIDDEN",
                "Only an owner may initiate a profile link",
              );
            }
            if (
              outcome.result_code === "target_not_found" ||
              outcome.result_code === "profile_not_found"
            ) {
              throw new AppError(
                "RESOURCE_NOT_FOUND",
                "Profile link resource was not found",
              );
            }
            if (
              outcome.result_code !== "created" ||
              outcome.out_request_id === null
            ) {
              return committedDomainError(
                "CONFLICT",
                "Profile link request conflicts with current lifecycle state",
              );
            }
            const inserted =
              await client.query<PersonProfileLinkRequestRow>(
                `SELECT *
                 FROM person_profile_link_requests
                 WHERE household_id = $1 AND id = $2`,
                [householdId, outcome.out_request_id],
              );
            const row = inserted.rows[0];
            if (row === undefined) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Profile link request could not be created",
              );
            }
            return personProfileLinkRequestResultSchema.parse({
              request: mapPersonProfileLinkRequest(row),
            });
          },
          true,
        );
      },
    );
    if (isCommittedDomainError(result)) {
      throw result.error;
    }
    return result;
  }

  public async listPersonProfileLinkRequests(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
  ): Promise<PersonProfileLinkRequestListResult> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        await client.query(
          `SELECT meal_agent_private.materialize_person_profile_link_requests(
             $1::uuid, NULL::uuid, NULL::uuid
           )`,
          [householdId],
        );
        const result =
          await client.query<PersonProfileLinkRequestRow>(
            `SELECT *
             FROM person_profile_link_requests
             WHERE household_id = $1
             ORDER BY id`,
            [householdId],
          );
        return personProfileLinkRequestListResultSchema.parse({
          requests: result.rows.map(mapPersonProfileLinkRequest),
        });
      },
    );
  }

  public async confirmPersonProfileLinkRequest(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    linkRequestId: string,
    idempotencyKey: string,
    request: ConfirmPersonProfileLinkRequest,
  ): Promise<IdempotentResponse<ConfirmPersonProfileLinkResult>> {
    const result = await this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        await setHouseholdContext(client, householdId);
        const idempotencyInput: IdempotencyInput = {
          scope: "household",
          userId: authenticatedContext.userId,
          householdId,
          method: "POST",
          normalizedRoute:
            normalizedRoutes.confirmPersonProfileLinkRequest,
          key: idempotencyKey,
          resourceTarget: { linkRequestId },
          payload: request,
          requestId,
          statusCode: 200,
        };
        const replay =
          await this.#loadIdempotentReplay<ConfirmPersonProfileLinkResult>(
            client,
            idempotencyInput,
            true,
          );
        if (replay !== null) {
          return replay;
        }
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        // confirm 的 idempotency marker 具有 target membership 外键。
        // 必须先取得 link household 锁，避免 remove 已持有 advisory lock
        // 时形成 “marker FK key-share ↔ membership update” 锁环。
        await client.query(
          `SELECT pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtextextended(
               'person-profile-links:' || $1::text,
               0
             )
           )`,
          [householdId],
        );
        return this.#runIdempotent(
          client,
          {
            ...idempotencyInput,
            userId: context.userId,
          },
          async () => {
            const confirmation = await client.query<{
              result_code: string;
              out_profile_id: string | null;
              out_profile_version: number | null;
            }>(
              `SELECT *
               FROM meal_agent_private.confirm_person_profile_link(
                 $1::uuid, $2::integer
               )`,
              [linkRequestId, request.expectedVersion],
            );
            const outcome = confirmation.rows[0];
            if (
              outcome === undefined ||
              outcome.result_code === "not_found"
            ) {
              throw new AppError(
                "RESOURCE_NOT_FOUND",
                "Pending link request was not found",
              );
            }
            if (outcome.result_code === "forbidden") {
              throw new AppError(
                "FORBIDDEN",
                "Only the target member may confirm this link",
              );
            }
            if (outcome.result_code !== "linked") {
              return committedDomainError(
                "CONFLICT",
                "Profile link request changed or is no longer applicable",
              );
            }
            const linked = await client.query<PersonProfileLinkRequestRow>(
              `SELECT *
               FROM person_profile_link_requests
               WHERE household_id = $1 AND id = $2`,
              [householdId, linkRequestId],
            );
            const row = linked.rows[0];
            if (
              row === undefined ||
              outcome.out_profile_id === null ||
              outcome.out_profile_version === null
            ) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Confirmed profile link could not be loaded",
              );
            }
            return confirmPersonProfileLinkResultSchema.parse({
              request: mapPersonProfileLinkRequest(row),
              receipt: {
                householdId,
                profileId: outcome.out_profile_id,
                operation: "link",
                status: "active",
                resultingVersion: outcome.out_profile_version,
              },
            });
          },
          true,
        );
      },
    );
    if (isCommittedDomainError(result)) {
      throw result.error;
    }
    return result;
  }

  public async createPersonProfile(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    idempotencyKey: string,
    request: CreatePersonProfileRequest,
  ): Promise<IdempotentResponse<PersonProfileMutationReceipt>> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        if (request.linkedMembershipId === undefined) {
          this.#requireOwner(
            context,
            "Only an owner may create a dining-only profile",
          );
        } else if (request.linkedMembershipId !== context.membershipId) {
          throw new AppError(
            "FORBIDDEN",
            "A linked profile may only be created by its subject member",
          );
        }
        return this.#runIdempotent(
          client,
          {
            scope: "household",
            userId: context.userId,
            householdId,
            method: "POST",
            normalizedRoute: normalizedRoutes.createPersonProfile,
            key: idempotencyKey,
            payload: request,
            requestId,
            statusCode: 201,
          },
          async () => {
            if (request.linkedMembershipId !== undefined) {
              // 与关联确认共享家庭级 advisory 锁；materialize 函数随后按确定性
              // 顺序锁定 request、profile 和 membership。两条路径并发时只能一方
              // 成功，另一方得到显式 409。
              await client.query(
                `SELECT meal_agent_private.materialize_person_profile_link_requests(
                   $1::uuid, NULL::uuid, $2::uuid
                 )`,
                [householdId, request.linkedMembershipId],
              );
              const membership = await client.query(
                `SELECT 1
                 FROM memberships
                 WHERE household_id = $1 AND id = $2 AND status = 'active'`,
                [householdId, request.linkedMembershipId],
              );
              if (membership.rowCount === 0) {
                throw new AppError(
                  "RESOURCE_NOT_FOUND",
                  "The linked membership was not found",
                );
              }
              const existing = await client.query<{ status: string }>(
                `SELECT status
                 FROM person_profiles
                 WHERE household_id = $1 AND linked_membership_id = $2`,
                [householdId, request.linkedMembershipId],
              );
              const existingProfile = existing.rows[0];
              if (existingProfile !== undefined) {
                if (existingProfile.status === "archived") {
                  throw new AppError(
                    "PERSON_PROFILE_ARCHIVED",
                    "This member has an archived profile that must be restored",
                  );
                }
                throw new AppError(
                  "CONFLICT",
                  "This member already has a profile",
                );
              }
            }
            const now = new Date();
            const inserted = await client.query<PersonProfileRow>(
              `INSERT INTO person_profiles (
                 id, household_id, linked_membership_id, display_name,
                 status, default_participation, default_portion_scale,
                 cooking_skill, dietary_constraints, created_at, updated_at,
                 version
               ) VALUES (
                 $1, $2, $3, $4, 'active', $5, $6, $7, '[]'::jsonb, $8, $8, 0
               )
               RETURNING *`,
              [
                newEntityId(),
                householdId,
                request.linkedMembershipId ?? null,
                request.displayName,
                request.defaultParticipation === null
                  ? null
                  : request.defaultParticipation
                    ? 1
                    : 0,
                request.defaultPortionScale,
                request.cookingSkill,
                now,
              ],
            );
            const row = inserted.rows[0];
            if (row === undefined) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Profile could not be created",
              );
            }
            if (request.linkedMembershipId !== undefined) {
              await client.query(
                `SELECT meal_agent_private.materialize_person_profile_link_requests(
                   $1::uuid, NULL::uuid, $2::uuid
                 )`,
                [householdId, request.linkedMembershipId],
              );
            }
            return personProfileMutationReceiptSchema.parse({
              householdId,
              profileId: row.id,
              operation: "create",
              status: row.status,
              resultingVersion: row.version,
            });
          },
        );
      },
    );
  }

  public async patchPersonProfile(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    profileId: string,
    idempotencyKey: string,
    request: PatchPersonProfileRequest,
  ): Promise<IdempotentResponse<PersonProfileMutationReceipt>> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        await this.#loadAuthorizedProfile(
          client,
          context,
          householdId,
          profileId,
        );
        return this.#runIdempotent(
          client,
          {
            scope: "household",
            userId: context.userId,
            householdId,
            method: "PATCH",
            normalizedRoute: normalizedRoutes.patchPersonProfile,
            key: idempotencyKey,
            resourceTarget: { profileId },
            payload: request,
            requestId,
            statusCode: 200,
          },
          async () => {
            const mutation =
              request.operation === "update"
                ? await client.query<{
                    result_code: string;
                    out_profile_id: string | null;
                    out_status: string | null;
                    out_version: number | null;
                  }>(
                    `SELECT result_code, out_profile_id, out_status, out_version
                     FROM meal_agent_private.update_person_profile_fields(
                       $1::uuid, $2::integer, $3::boolean, $4::text,
                       $5::boolean, $6::integer, $7::boolean, $8::numeric,
                       $9::boolean, $10::text
                     )`,
                    [
                      profileId,
                      request.expectedVersion,
                      request.displayName !== undefined,
                      request.displayName ?? null,
                      request.defaultParticipation !== undefined,
                      request.defaultParticipation === undefined ||
                      request.defaultParticipation === null
                        ? null
                        : request.defaultParticipation
                          ? 1
                          : 0,
                      request.defaultPortionScale !== undefined,
                      request.defaultPortionScale ?? null,
                      request.cookingSkill !== undefined,
                      request.cookingSkill ?? null,
                    ],
                  )
                : await client.query<{
                    result_code: string;
                    out_profile_id: string | null;
                    out_status: string | null;
                    out_version: number | null;
                  }>(
                    `SELECT result_code, out_profile_id, out_status, out_version
                     FROM meal_agent_private.transition_person_profile_status(
                       $1::uuid, $2::integer, $3::text
                     )`,
                    [profileId, request.expectedVersion, request.operation],
                  );
            const outcome = mutation.rows[0];
            if (
              outcome === undefined ||
              outcome.result_code === "not_found"
            ) {
              throw new AppError(
                "RESOURCE_NOT_FOUND",
                "Profile was not found",
              );
            }
            if (outcome.result_code === "forbidden") {
              throw new AppError(
                "FORBIDDEN",
                "This profile may only be changed by its subject or an owner",
              );
            }
            if (outcome.result_code === "invalid_constraint") {
              throw new AppError(
                "VALIDATION_FAILED",
                "Dietary constraint payload is invalid",
              );
            }
            if (
              outcome.result_code !== "changed" ||
              outcome.out_profile_id === null ||
              outcome.out_status === null ||
              outcome.out_version === null
            ) {
              throw new AppError(
                "CONFLICT",
                outcome.result_code === "linked_membership_inactive"
                  ? "The linked membership must rejoin before this profile can be restored"
                  : "Profile changed concurrently or cannot make this transition",
              );
            }
            return personProfileMutationReceiptSchema.parse({
              householdId,
              profileId: outcome.out_profile_id,
              operation: request.operation,
              status: outcome.out_status,
              resultingVersion: outcome.out_version,
            });
          },
        );
      },
    );
  }

  public async addDietaryConstraint(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    profileId: string,
    idempotencyKey: string,
    request: AddDietaryConstraintRequest,
  ): Promise<IdempotentResponse<PersonProfileMutationReceipt>> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        await this.#loadAuthorizedProfile(
          client,
          context,
          householdId,
          profileId,
        );
        return this.#runIdempotent(
          client,
          {
            scope: "household",
            userId: context.userId,
            householdId,
            method: "POST",
            normalizedRoute: normalizedRoutes.addDietaryConstraint,
            key: idempotencyKey,
            resourceTarget: { profileId },
            payload: request,
            requestId,
            statusCode: 201,
          },
          async () => {
            const constraintId = newEntityId();
            const input = request.constraint;
            const constraintInput =
              input.enforcement === "hard"
                ? (({ confirmation: _confirmation, ...fields }) =>
                    fields)(input)
                : input;
            const mutation = await client.query<{
              result_code: string;
              out_profile_id: string | null;
              out_status: string | null;
              out_version: number | null;
              out_constraint_id: string | null;
            }>(
              `SELECT result_code, out_profile_id, out_status, out_version,
                      out_constraint_id
               FROM meal_agent_private.add_person_profile_constraint(
                 $1::uuid, $2::integer, $3::uuid, $4::jsonb, $5::boolean
               )`,
              [
                profileId,
                request.expectedVersion,
                constraintId,
                JSON.stringify(constraintInput),
                input.enforcement === "hard"
                  ? input.confirmation.acknowledged
                  : false,
              ],
            );
            const outcome = mutation.rows[0];
            if (
              outcome === undefined ||
              outcome.result_code === "not_found"
            ) {
              throw new AppError(
                "RESOURCE_NOT_FOUND",
                "Profile was not found",
              );
            }
            if (outcome.result_code === "forbidden") {
              throw new AppError(
                "FORBIDDEN",
                "This profile may only be changed by its subject or an owner",
              );
            }
            if (
              outcome.result_code !== "changed" ||
              outcome.out_profile_id === null ||
              outcome.out_status === null ||
              outcome.out_version === null ||
              outcome.out_constraint_id === null
            ) {
              throw new AppError(
                "CONFLICT",
                outcome.result_code === "confirmation_required"
                  ? "Hard constraints require explicit confirmation"
                  : "Profile changed concurrently or cannot accept this constraint",
              );
            }
            return personProfileMutationReceiptSchema.parse({
              householdId,
              profileId: outcome.out_profile_id,
              operation: "add_constraint",
              status: outcome.out_status,
              resultingVersion: outcome.out_version,
              constraintId: outcome.out_constraint_id,
            });
          },
        );
      },
    );
  }

  public async removeDietaryConstraint(
    accessToken: string | undefined,
    requestId: RequestId,
    householdId: string,
    profileId: string,
    idempotencyKey: string,
    request: RemoveDietaryConstraintRequest,
  ): Promise<IdempotentResponse<PersonProfileMutationReceipt>> {
    return this.#withAuthenticated(
      accessToken,
      requestId,
      async (client, authenticatedContext) => {
        const context = await this.#bootstrapHousehold(
          client,
          authenticatedContext,
          householdId,
        );
        await this.#loadAuthorizedProfile(
          client,
          context,
          householdId,
          profileId,
        );
        return this.#runIdempotent(
          client,
          {
            scope: "household",
            userId: context.userId,
            householdId,
            method: "DELETE",
            normalizedRoute: normalizedRoutes.removeDietaryConstraint,
            key: idempotencyKey,
            resourceTarget: { profileId, constraintId: request.constraintId },
            payload: { expectedVersion: request.expectedVersion },
            requestId,
            statusCode: 200,
          },
          async () => {
            const mutation = await client.query<{
              result_code: string;
              out_profile_id: string | null;
              out_status: string | null;
              out_version: number | null;
            }>(
              `SELECT result_code, out_profile_id, out_status, out_version
               FROM meal_agent_private.remove_person_profile_constraint(
                 $1::uuid, $2::integer, $3::uuid
               )`,
              [
                profileId,
                request.expectedVersion,
                request.constraintId,
              ],
            );
            const outcome = mutation.rows[0];
            if (
              outcome === undefined ||
              outcome.result_code === "not_found" ||
              outcome.result_code === "constraint_not_found"
            ) {
              throw new AppError(
                "RESOURCE_NOT_FOUND",
                outcome?.result_code === "constraint_not_found"
                  ? "Dietary constraint was not found"
                  : "Profile was not found",
              );
            }
            if (outcome.result_code === "forbidden") {
              throw new AppError(
                "FORBIDDEN",
                "This profile may only be changed by its subject or an owner",
              );
            }
            if (
              outcome.result_code !== "changed" ||
              outcome.out_profile_id === null ||
              outcome.out_status === null ||
              outcome.out_version === null
            ) {
              throw new AppError(
                "CONFLICT",
                "Profile changed concurrently or cannot remove this constraint",
              );
            }
            return personProfileMutationReceiptSchema.parse({
              householdId,
              profileId: outcome.out_profile_id,
              operation: "remove_constraint",
              status: outcome.out_status,
              resultingVersion: outcome.out_version,
              constraintId: request.constraintId,
            });
          },
        );
      },
    );
  }
}
