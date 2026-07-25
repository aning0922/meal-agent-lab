import assert from "node:assert/strict";
import { Writable } from "node:stream";
import {
  after,
  before,
  beforeEach,
  test,
} from "node:test";

import {
  apiErrorSchema,
  authenticatedSessionSchema,
  consumeInventoryLotSuccessSchema,
  createHouseholdSuccessSchema,
  createInventoryLotSuccessSchema,
  householdPageSuccessSchema,
  inventoryLotPageSuccessSchema,
  meSuccessSchema,
  quantityDecimalMax,
  serviceReadinessSuccessSchema,
  sessionRevokedSuccessSchema,
  wechatLoginExchangeSuccessSchema,
  type AuthenticatedSession,
  type CreateHouseholdRequest,
  type CreateInventoryLotRequest,
} from "@meal-agent/contracts";
import { sql } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import {
  createPersistence,
  setHouseholdContext,
  setUserContext,
  withAppTransaction,
  type Persistence,
} from "../../src/database/pool.js";
import { createLogger } from "../../src/logging.js";
import { FakeWechatAdapter } from "../../src/wechat/fake.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL is required");
}

const config = loadConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "info",
  DATABASE_URL: databaseUrl,
  DATABASE_APP_ROLE: "meal_agent_app",
  WECHAT_ADAPTER: "fake",
  SESSION_ABSOLUTE_TTL_DAYS: "30",
  SESSION_IDLE_TTL_DAYS: "7",
});

let logs = "";
const logStream = new Writable({
  write(chunk, _encoding, callback) {
    logs += chunk.toString();
    callback();
  },
});
let persistence: Persistence;
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  persistence = createPersistence(config);
  app = await buildApp({
    config,
    persistence,
    wechatAdapter: new FakeWechatAdapter(),
    logger: createLogger("info", logStream),
    closePersistence: true,
  });
  await app.ready();
});

beforeEach(async () => {
  logs = "";
  await persistence.pool.query(`
    TRUNCATE TABLE
      idempotency_records,
      inventory_events,
      inventory_lots,
      person_profiles,
      household_invites,
      memberships,
      households,
      sessions,
      auth_identities,
      users
    CASCADE
  `);
});

after(async () => {
  await app.close();
});

const login = async (
  code: string,
): Promise<AuthenticatedSession> => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat/exchange",
    payload: { loginCode: code },
  });
  assert.equal(response.statusCode, 200, response.body);
  return wechatLoginExchangeSuccessSchema.parse(response.json()).data;
};

const authHeaders = (session: AuthenticatedSession) => ({
  authorization: `Bearer ${session.accessToken}`,
});

const householdRequest = (
  name: string,
): CreateHouseholdRequest => ({
  name,
  timezone: "Asia/Shanghai",
  locale: "zh-CN",
  ownerProfile: {
    displayName: `${name}创建者`,
    defaultParticipation: null,
    defaultPortionScale: 1,
    cookingSkill: "beginner",
  },
});

const createHousehold = async (
  session: AuthenticatedSession,
  key: string,
  request = householdRequest("测试家庭"),
) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/households",
    headers: {
      ...authHeaders(session),
      "idempotency-key": key,
    },
    payload: request,
  });
  assert.equal(response.statusCode, 201, response.body);
  return createHouseholdSuccessSchema.parse(response.json());
};

const exactLotRequest = (
  name: string,
  amount = "5",
  unit = "kg",
): CreateInventoryLotRequest => ({
  displayName: name,
  storageLocation: "refrigerated",
  initialQuantity: {
    kind: "exact",
    amount,
    unit,
    originalText: `${String(amount)} ${unit}`,
  },
  dates: [
    {
      kind: "purchase_date",
      value: "2026-07-23",
      source: {
        kind: "user_input",
        confidence: "high",
      },
    },
  ],
});

const createLot = async (
  session: AuthenticatedSession,
  householdId: string,
  key: string,
  request = exactLotRequest("鸡蛋"),
) => {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/households/${householdId}/inventory-lots`,
    headers: {
      ...authHeaders(session),
      "idempotency-key": key,
    },
    payload: request,
  });
  assert.equal(response.statusCode, 201, response.body);
  return createInventoryLotSuccessSchema.parse(response.json());
};

const consume = async (
  session: AuthenticatedSession,
  householdId: string,
  lotId: string,
  key: string,
  amount: string,
  expectedVersion: number,
  unit = "kg",
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}` +
      `/inventory-lots/${lotId}/events/consumed`,
    headers: {
      ...authHeaders(session),
      "idempotency-key": key,
    },
    payload: {
      consumedQuantity: {
        kind: "exact",
        amount,
        unit,
        originalText: `${String(amount)} ${unit}`,
      },
      expectedVersion,
    },
  });

test("PostgreSQL 18 migration creates eleven tables, separated roles, FORCE RLS and composite foreign keys", async () => {
  const version = await persistence.pool.query<{ server_version: string }>(
    "SHOW server_version",
  );
  assert.match(version.rows[0]?.server_version ?? "", /^18\./);

  const tables = await persistence.pool.query<{
    tablename: string;
    tableowner: string;
  }>(
    `SELECT tablename, tableowner
     FROM pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename`,
  );
  assert.equal(tables.rows.length, 11);
  assert.equal(
    tables.rows.some((row) => row.tablename === "household_invites"),
    true,
  );
  assert.equal(
    tables.rows.every((row) => row.tableowner === "meal_agent_migrator"),
    true,
  );

  const roles = await persistence.pool.query<{
    rolname: string;
    rolbypassrls: boolean;
  }>(
    `SELECT rolname, rolbypassrls
     FROM pg_roles
     WHERE rolname IN ('meal_agent_app', 'meal_agent_migrator')
     ORDER BY rolname`,
  );
  assert.deepEqual(
    roles.rows,
    [
      { rolname: "meal_agent_app", rolbypassrls: false },
      { rolname: "meal_agent_migrator", rolbypassrls: true },
    ],
  );

  const quantityColumns = await persistence.pool.query<{
    column_name: string;
    numeric_precision: number;
    numeric_scale: number;
  }>(
    `SELECT column_name, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'inventory_lots'
          AND column_name = 'current_quantity_amount')
         OR
         (table_name = 'inventory_events'
          AND column_name = 'quantity_change_amount')
       )
     ORDER BY column_name`,
  );
  assert.deepEqual(quantityColumns.rows, [
    {
      column_name: "current_quantity_amount",
      numeric_precision: 15,
      numeric_scale: 6,
    },
    {
      column_name: "quantity_change_amount",
      numeric_precision: 15,
      numeric_scale: 6,
    },
  ]);

  const forced = await persistence.pool.query<{
    relname: string;
    relforcerowsecurity: boolean;
  }>(
    `SELECT relname, relforcerowsecurity
     FROM pg_class
     WHERE relname IN (
       'households', 'memberships', 'household_invites',
       'person_profiles', 'person_profile_link_requests',
       'inventory_lots', 'inventory_events',
       'idempotency_records'
     )
     ORDER BY relname`,
  );
  assert.equal(forced.rows.length, 8);
  assert.equal(forced.rows.every((row) => row.relforcerowsecurity), true);

  // 邀请表：digest 唯一约束存在、明文/绑定成员的复合外键成立。
  const inviteConstraints = await persistence.pool.query<{
    conname: string;
  }>(
    `SELECT conname
     FROM pg_constraint
     WHERE conrelid = 'public.household_invites'::regclass
     ORDER BY conname`,
  );
  const inviteConstraintNames = inviteConstraints.rows.map(
    (row) => row.conname,
  );
  for (const expected of [
    "household_invites_code_digest_unique",
    "household_invites_creator_membership_foreign",
    "household_invites_status_check",
    "household_invites_max_uses_check",
    "household_invites_used_count_check",
    "household_invites_expiry_check",
    "household_invites_version_check",
  ]) {
    assert.equal(
      inviteConstraintNames.includes(expected),
      true,
      `missing constraint ${expected}`,
    );
  }

  const compositeForeignKeys = await persistence.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_constraint
     WHERE contype = 'f'
       AND array_length(conkey, 1) > 1`,
  );
  assert.ok(Number(compositeForeignKeys.rows[0]?.count) >= 5);

  const idempotencyUnique = await persistence.pool.query<{
    contype: string;
    condef: string;
  }>(
    `SELECT contype, pg_get_constraintdef(oid) AS condef
     FROM pg_constraint
     WHERE conname = 'idempotency_records_scope_unique'`,
  );
  assert.equal(idempotencyUnique.rows[0]?.contype, "u");
  assert.match(idempotencyUnique.rows[0]?.condef ?? "", /NULLS NOT DISTINCT/);

  const lotQuantityShape = await persistence.pool.query<{ condef: string }>(
    `SELECT pg_get_constraintdef(oid) AS condef
     FROM pg_constraint
     WHERE conname = 'inventory_lots_quantity_shape_check'`,
  );
  assert.match(
    lotQuantityShape.rows[0]?.condef ?? "",
    /current_quantity_confidence/,
  );
  assert.match(
    lotQuantityShape.rows[0]?.condef ?? "",
    /current_quantity_original_text IS NOT NULL/,
  );

  const drizzleProbe = await persistence.drizzle.execute(
    sql`SELECT count(*)::int AS count FROM users`,
  );
  assert.equal(drizzleProbe.rows[0]?.["count"], 0);

  const readiness = await app.inject({
    method: "GET",
    url: "/readyz",
  });
  assert.equal(readiness.statusCode, 200, readiness.body);
  serviceReadinessSuccessSchema.parse(readiness.json());
});

test("deterministic fake WeChat login creates then restores one internal user without provider leakage", async () => {
  const loginCode = "LOGIN-CODE-DB-SENTINEL";
  const first = await login(loginCode);
  const second = await login(loginCode);

  assert.equal(first.user.id, second.user.id);
  assert.notEqual(first.session.id, second.session.id);
  assert.notEqual(first.accessToken, second.accessToken);

  const counts = await persistence.pool.query<{
    users: number;
    identities: number;
    sessions: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM users) AS users,
       (SELECT count(*)::int FROM auth_identities) AS identities,
       (SELECT count(*)::int FROM sessions) AS sessions`,
  );
  assert.deepEqual(counts.rows[0], {
    users: 1,
    identities: 1,
    sessions: 2,
  });
  const identity = await persistence.pool.query<{
    provider_subject: string;
  }>("SELECT provider_subject FROM auth_identities");
  const providerSubject = identity.rows[0]?.provider_subject;
  assert.ok(providerSubject);
  assert.equal(providerSubject.includes(loginCode), false);

  const responses = JSON.stringify([first, second]);
  assert.equal(responses.includes("providerSubject"), false);
  assert.equal(responses.includes("providerUnionSubject"), false);
  for (const secret of [
    loginCode,
    first.accessToken,
    second.accessToken,
    providerSubject,
  ]) {
    assert.equal(logs.includes(secret), false);
  }
});

test("disabled identity or user cannot exchange the same login code for another session", async () => {
  const disabledIdentityCode = "disabled-login-identity";
  const identityLogin = await login(disabledIdentityCode);
  await persistence.pool.query(
    `UPDATE auth_identities
     SET status = 'disabled'
     WHERE user_id = $1`,
    [identityLogin.user.id],
  );
  const identityRetry = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat/exchange",
    payload: { loginCode: disabledIdentityCode },
  });
  assert.equal(identityRetry.statusCode, 401, identityRetry.body);
  assert.equal(
    identityRetry.headers["content-type"]?.includes(
      "application/problem+json",
    ),
    true,
  );
  assert.equal(
    apiErrorSchema.parse(identityRetry.json()).code,
    "AUTHENTICATION_REQUIRED",
  );

  const disabledUserCode = "disabled-login-user";
  const userLogin = await login(disabledUserCode);
  await persistence.pool.query(
    "UPDATE users SET status = 'disabled' WHERE id = $1",
    [userLogin.user.id],
  );
  const userRetry = await app.inject({
    method: "POST",
    url: "/api/v1/auth/wechat/exchange",
    payload: { loginCode: disabledUserCode },
  });
  assert.equal(userRetry.statusCode, 401, userRetry.body);
  assert.equal(
    userRetry.headers["content-type"]?.includes(
      "application/problem+json",
    ),
    true,
  );
  assert.equal(
    apiErrorSchema.parse(userRetry.json()).code,
    "AUTHENTICATION_REQUIRED",
  );

  const sessionCounts = await persistence.pool.query<{
    user_id: string;
    sessions: number;
  }>(
    `SELECT user_id, count(*)::int AS sessions
     FROM sessions
     WHERE user_id IN ($1, $2)
     GROUP BY user_id
     ORDER BY user_id`,
    [identityLogin.user.id, userLogin.user.id],
  );
  assert.deepEqual(
    sessionCounts.rows.map((row) => row.sessions),
    [1, 1],
  );
});

test("auth service rejects disabled users, expired/revoked sessions and database-level identity mismatch", async () => {
  const disabled = await login("disabled-user");
  await persistence.pool.query(
    "UPDATE users SET status = 'disabled' WHERE id = $1",
    [disabled.user.id],
  );
  const disabledResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: authHeaders(disabled),
  });
  assert.equal(disabledResponse.statusCode, 401);
  assert.equal(
    apiErrorSchema.parse(disabledResponse.json()).code,
    "SESSION_EXPIRED",
  );

  const expired = await login("expired-session");
  await persistence.pool.query(
    `UPDATE sessions
     SET issued_at = clock_timestamp() - interval '3 days',
         expires_at = clock_timestamp() - interval '2 days',
         idle_expires_at = clock_timestamp() + interval '1 day'
     WHERE id = $1`,
    [expired.session.id],
  );
  const expiredResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: authHeaders(expired),
  });
  assert.equal(expiredResponse.statusCode, 401);
  assert.equal(
    apiErrorSchema.parse(expiredResponse.json()).code,
    "SESSION_EXPIRED",
  );

  const idleExpired = await login("idle-expired-session");
  await persistence.pool.query(
    `UPDATE sessions
     SET issued_at = clock_timestamp() - interval '3 days',
         expires_at = clock_timestamp() + interval '10 days',
         idle_expires_at = clock_timestamp() - interval '1 day'
     WHERE id = $1`,
    [idleExpired.session.id],
  );
  const idleExpiredResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: authHeaders(idleExpired),
  });
  assert.equal(idleExpiredResponse.statusCode, 401);
  assert.equal(
    apiErrorSchema.parse(idleExpiredResponse.json()).code,
    "SESSION_EXPIRED",
  );

  const revoked = await login("revoked-session");
  await persistence.pool.query(
    `UPDATE sessions
     SET status = 'revoked', revoked_at = clock_timestamp()
     WHERE id = $1`,
    [revoked.session.id],
  );
  const revokedResponse = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: authHeaders(revoked),
  });
  assert.equal(revokedResponse.statusCode, 401);

  const other = await login("mismatch-other-user");
  await assert.rejects(
    persistence.pool.query(
      "UPDATE sessions SET user_id = $1 WHERE id = $2",
      [other.user.id, revoked.session.id],
    ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23503",
  );
  assert.equal(
    authenticatedSessionSchema.safeParse({
      ...other,
      session: { ...other.session, userId: revoked.user.id },
    }).success,
    false,
  );
});

test("user-scope household idempotency replays one household and rejects a changed body", async () => {
  const session = await login("household-idempotency-user");
  const key = "household-create-0001";
  const request = householdRequest("幂等家庭");
  const first = await createHousehold(session, key, request);
  const replay = await createHousehold(session, key, request);

  assert.equal(first.data.household.id, replay.data.household.id);
  assert.equal(first.meta.idempotency?.scope, "user");
  assert.equal(first.meta.idempotency?.replayed, false);
  assert.equal(replay.meta.idempotency?.replayed, true);

  const changed = await app.inject({
    method: "POST",
    url: "/api/v1/households",
    headers: {
      ...authHeaders(session),
      "idempotency-key": key,
    },
    payload: householdRequest("不同家庭"),
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(
    apiErrorSchema.parse(changed.json()).code,
    "IDEMPOTENCY_KEY_REUSED",
  );

  const counts = await persistence.pool.query<{
    households: number;
    memberships: number;
    profiles: number;
    records: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM households) AS households,
       (SELECT count(*)::int FROM memberships) AS memberships,
       (SELECT count(*)::int FROM person_profiles) AS profiles,
       (SELECT count(*)::int FROM idempotency_records) AS records`,
  );
  assert.deepEqual(counts.rows[0], {
    households: 1,
    memberships: 1,
    profiles: 1,
    records: 1,
  });
  const storedResponse = await persistence.pool.query<{
    response_body: unknown;
  }>("SELECT response_body FROM idempotency_records");
  const cached = JSON.stringify(storedResponse.rows[0]?.response_body);
  assert.equal(cached.includes("accessToken"), false);
  assert.equal(cached.includes("providerSubject"), false);
  assert.equal(cached.includes("subject_and_owner"), false);
});

test("two users and two households have positive access and four cross-household denials", async () => {
  const userA = await login("isolation-user-a");
  const userB = await login("isolation-user-b");
  const householdA = await createHousehold(
    userA,
    "isolation-house-a",
    householdRequest("甲家庭"),
  );
  const householdB = await createHousehold(
    userB,
    "isolation-house-b",
    householdRequest("乙家庭"),
  );
  await createLot(
    userA,
    householdA.data.household.id,
    "isolation-lot-a01",
    exactLotRequest("甲库存"),
  );
  await createLot(
    userB,
    householdB.data.household.id,
    "isolation-lot-b01",
    exactLotRequest("乙库存"),
  );

  const listA = householdPageSuccessSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/households",
        headers: authHeaders(userA),
      })
    ).json(),
  );
  const listB = householdPageSuccessSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/households",
        headers: authHeaders(userB),
      })
    ).json(),
  );
  assert.deepEqual(
    listA.data.items.map((household) => household.id),
    [householdA.data.household.id],
  );
  assert.deepEqual(
    listB.data.items.map((household) => household.id),
    [householdB.data.household.id],
  );

  for (const [session, householdId] of [
    [userA, householdB.data.household.id],
    [userB, householdA.data.household.id],
  ] as const) {
    const cross = await app.inject({
      method: "GET",
      url: `/api/v1/households/${householdId}/inventory-lots`,
      headers: authHeaders(session),
    });
    assert.equal(cross.statusCode, 404);
    assert.equal(
      apiErrorSchema.parse(cross.json()).code,
      "RESOURCE_NOT_FOUND",
    );
  }

  const ownA = await app.inject({
    method: "GET",
    url:
      `/api/v1/households/${householdA.data.household.id}` +
      "/inventory-lots",
    headers: authHeaders(userA),
  });
  const ownB = await app.inject({
    method: "GET",
    url:
      `/api/v1/households/${householdB.data.household.id}` +
      "/inventory-lots",
    headers: authHeaders(userB),
  });
  assert.equal(inventoryLotPageSuccessSchema.parse(ownA.json()).data.items.length, 1);
  assert.equal(inventoryLotPageSuccessSchema.parse(ownB.json()).data.items.length, 1);
});

test("household bootstrap plus FORCE RLS blocks a query that deliberately omits the household filter", async () => {
  const userA = await login("rls-user-a");
  const userB = await login("rls-user-b");
  const householdA = await createHousehold(
    userA,
    "rls-household-a01",
    householdRequest("RLS 甲"),
  );
  const householdB = await createHousehold(
    userB,
    "rls-household-b01",
    householdRequest("RLS 乙"),
  );
  const lotA = await createLot(
    userA,
    householdA.data.household.id,
    "rls-lot-create-a",
    exactLotRequest("RLS 甲库存"),
  );
  const lotB = await createLot(
    userB,
    householdB.data.household.id,
    "rls-lot-create-b",
    exactLotRequest("RLS 乙库存"),
  );

  const visible = await withAppTransaction(persistence, async (client) => {
    await setUserContext(client, userA.user.id);
    await setHouseholdContext(client, householdA.data.household.id);
    return client.query<{ id: string; household_id: string }>(
      "SELECT id, household_id FROM inventory_lots ORDER BY id",
    );
  });
  assert.deepEqual(visible.rows, [
    {
      id: lotA.data.lot.id,
      household_id: householdA.data.household.id,
    },
  ]);
  assert.equal(
    visible.rows.some((row) => row.id === lotB.data.lot.id),
    false,
  );
});

test("same household-scope key and body concurrently create one lot and one acquired event", async () => {
  const firstSession = await login("lot-concurrency-user");
  const secondSession = await login("lot-concurrency-user");
  const household = await createHousehold(
    firstSession,
    "lot-concurrency-house",
  );
  const householdId = household.data.household.id;
  const key = "lot-concurrent-key1";
  const request = exactLotRequest("并发批次", "6", "piece");

  const send = (session: AuthenticatedSession) =>
    app.inject({
      method: "POST",
      url: `/api/v1/households/${householdId}/inventory-lots`,
      headers: {
        ...authHeaders(session),
        "idempotency-key": key,
      },
      payload: request,
    });
  const [left, right] = await Promise.all([
    send(firstSession),
    send(secondSession),
  ]);
  assert.equal(left.statusCode, 201, left.body);
  assert.equal(right.statusCode, 201, right.body);
  const results = [
    createInventoryLotSuccessSchema.parse(left.json()),
    createInventoryLotSuccessSchema.parse(right.json()),
  ];
  assert.equal(results[0]?.data.lot.id, results[1]?.data.lot.id);
  assert.deepEqual(
    results.map((result) => result.meta.idempotency?.replayed).sort(),
    [false, true],
  );
  for (const result of results) {
    assert.equal(result.data.event.expectedLotVersion, 0);
    assert.equal(result.data.event.resultingLotVersion, 1);
    assert.equal(result.data.lot.version, 1);
  }

  const counts = await persistence.pool.query<{
    lots: number;
    events: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM inventory_lots) AS lots,
       (SELECT count(*)::int FROM inventory_events) AS events`,
  );
  assert.deepEqual(counts.rows[0], { lots: 1, events: 1 });
});

test("exact consumed event preserves delta arithmetic, units, non-negative projection and depleted state", async () => {
  const session = await login("consumed-invariants-user");
  const household = await createHousehold(
    session,
    "consumed-invariant-house",
  );
  const created = await createLot(
    session,
    household.data.household.id,
    "consumed-invariant-lot",
    exactLotRequest("牛奶", "5", "L"),
  );
  const beforeAmount = created.data.lot.currentQuantity.kind === "exact"
    ? created.data.lot.currentQuantity.amount
    : Number.NaN;

  const firstResponse = await consume(
    session,
    household.data.household.id,
    created.data.lot.id,
    "consumed-invariant-1",
    "2",
    1,
    "L",
  );
  assert.equal(firstResponse.statusCode, 201, firstResponse.body);
  const first = consumeInventoryLotSuccessSchema.parse(firstResponse.json());
  assert.equal(first.data.event.quantityChange?.kind, "numeric");
  if (
    first.data.event.quantityChange?.kind !== "numeric" ||
    first.data.lot.currentQuantity.kind !== "exact"
  ) {
    assert.fail("expected exact numeric consumed result");
  }
  assert.equal(first.data.event.quantityChange.precision, "exact");
  assert.equal(first.data.event.quantityChange.amount, "-2");
  assert.equal(first.data.event.quantityChange.unit, "L");
  assert.equal(first.data.lot.currentQuantity.unit, "L");
  assert.equal(beforeAmount, "5");
  assert.equal(first.data.lot.currentQuantity.amount, "3");
  assert.equal(first.data.lot.state, "active");

  const depletionResponse = await consume(
    session,
    household.data.household.id,
    created.data.lot.id,
    "consumed-invariant-2",
    "3",
    2,
    "L",
  );
  const depleted = consumeInventoryLotSuccessSchema.parse(
    depletionResponse.json(),
  );
  assert.equal(depleted.data.lot.currentQuantity.kind, "exact");
  if (depleted.data.lot.currentQuantity.kind === "exact") {
    assert.equal(depleted.data.lot.currentQuantity.amount, "0");
  }
  assert.equal(depleted.data.lot.state, "depleted");

  const estimated = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${household.data.household.id}` +
      `/inventory-lots/${created.data.lot.id}/events/consumed`,
    headers: {
      ...authHeaders(session),
      "idempotency-key": "consumed-estimated1",
    },
    payload: {
      consumedQuantity: {
        kind: "approximate",
        amount: 1,
        unit: "L",
        originalText: "约 1 L",
        confidence: "high",
      },
      expectedVersion: 3,
    },
  });
  assert.equal(estimated.statusCode, 400);
  assert.equal(
    apiErrorSchema.parse(estimated.json()).code,
    "VALIDATION_FAILED",
  );
});

test("insufficient consumed request returns 409 without writing an event or projection", async () => {
  const session = await login("insufficient-user");
  const household = await createHousehold(session, "insufficient-house");
  const created = await createLot(
    session,
    household.data.household.id,
    "insufficient-lot",
    exactLotRequest("少量盐", "1", "kg"),
  );

  const response = await consume(
    session,
    household.data.household.id,
    created.data.lot.id,
    "insufficient-event",
    "2",
    1,
  );
  assert.equal(response.statusCode, 409);
  assert.equal(
    apiErrorSchema.parse(response.json()).code,
    "INVENTORY_INSUFFICIENT",
  );
  const state = await persistence.pool.query<{
    amount: string;
    version: number;
    events: number;
  }>(
    `SELECT
       l.current_quantity_amount::text AS amount,
       l.version,
       (SELECT count(*)::int
        FROM inventory_events e
        WHERE e.inventory_lot_id = l.id) AS events
     FROM inventory_lots l
     WHERE l.id = $1`,
    [created.data.lot.id],
  );
  assert.deepEqual(state.rows[0], {
    amount: "1.000000",
    version: 1,
    events: 1,
  });

  const wrongUnit = await consume(
    session,
    household.data.household.id,
    created.data.lot.id,
    "wrong-unit-event01",
    "1",
    1,
    "g",
  );
  assert.equal(wrongUnit.statusCode, 409);
  assert.equal(apiErrorSchema.parse(wrongUnit.json()).code, "CONFLICT");
  const unchanged = await persistence.pool.query<{
    amount: string;
    version: number;
    events: number;
  }>(
    `SELECT
       l.current_quantity_amount::text AS amount,
       l.version,
       (SELECT count(*)::int
        FROM inventory_events e
        WHERE e.inventory_lot_id = l.id) AS events
     FROM inventory_lots l
     WHERE l.id = $1`,
    [created.data.lot.id],
  );
  assert.deepEqual(unchanged.rows[0], {
    amount: "1.000000",
    version: 1,
    events: 1,
  });
});

test("PostgreSQL numeric arithmetic preserves six-decimal exact quantities", async () => {
  const session = await login("decimal-arithmetic-user");
  const household = await createHousehold(session, "decimal-household");
  const created = await createLot(
    session,
    household.data.household.id,
    "decimal-lot-key01",
    exactLotRequest("小数库存", "0.3", "kg"),
  );

  const first = await consume(
    session,
    household.data.household.id,
    created.data.lot.id,
    "decimal-consume-1",
    "0.1",
    1,
  );
  assert.equal(first.statusCode, 201, first.body);
  const second = await consume(
    session,
    household.data.household.id,
    created.data.lot.id,
    "decimal-consume-2",
    "0.2",
    2,
  );
  assert.equal(second.statusCode, 201, second.body);

  const state = await persistence.pool.query<{
    amount: string;
    state: string;
    deltas: string[];
  }>(
    `SELECT
       l.current_quantity_amount::text AS amount,
       l.state,
       ARRAY(
         SELECT e.quantity_change_amount::text
         FROM inventory_events e
         WHERE e.inventory_lot_id = l.id
           AND e.type = 'consumed'
         ORDER BY e.resulting_lot_version
       ) AS deltas
     FROM inventory_lots l
     WHERE l.id = $1`,
    [created.data.lot.id],
  );
  assert.deepEqual(state.rows[0], {
    amount: "0.000000",
    state: "depleted",
    deltas: ["-0.100000", "-0.200000"],
  });
});

test("HTTP and PostgreSQL preserve the exact upper bound and reject a seventh decimal without rounding", async () => {
  const session = await login("upper-bound-decimal-user");
  const household = await createHousehold(
    session,
    "upper-bound-decimal-house",
  );
  const created = await createLot(
    session,
    household.data.household.id,
    "upper-bound-lot-key",
    exactLotRequest("上限库存", quantityDecimalMax, "kg"),
  );
  assert.equal(created.data.lot.currentQuantity.kind, "exact");
  if (created.data.lot.currentQuantity.kind === "exact") {
    assert.equal(created.data.lot.currentQuantity.amount, quantityDecimalMax);
  }

  for (const [index, invalidAmount] of [
    "999999999.9999991",
    "900000000.00000001",
    "1e-6",
    "9E8",
  ].entries()) {
    const invalid = await app.inject({
      method: "POST",
      url:
        `/api/v1/households/${household.data.household.id}` +
        "/inventory-lots",
      headers: {
        ...authHeaders(session),
        "content-type": "application/json",
        "idempotency-key": `upper-bound-invalid-${index}`,
      },
      payload: JSON.stringify(
        exactLotRequest("不得舍入", invalidAmount, "kg"),
      ),
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(
      apiErrorSchema.parse(invalid.json()).code,
      "VALIDATION_FAILED",
    );
  }

  const consumed = await consume(
    session,
    household.data.household.id,
    created.data.lot.id,
    "upper-bound-consume",
    "0.000001",
    1,
  );
  assert.equal(consumed.statusCode, 201, consumed.body);

  const state = await persistence.pool.query<{
    amount: string;
    delta: string;
    lots: number;
  }>(
    `SELECT
       l.current_quantity_amount::text AS amount,
       (
         SELECT e.quantity_change_amount::text
         FROM inventory_events e
         WHERE e.inventory_lot_id = l.id
           AND e.type = 'consumed'
       ) AS delta,
       (SELECT count(*)::int FROM inventory_lots) AS lots
     FROM inventory_lots l
     WHERE l.id = $1`,
    [created.data.lot.id],
  );
  assert.deepEqual(state.rows[0], {
    amount: "999999999.999998",
    delta: "-0.000001",
    lots: 1,
  });
});

test("decimal string aliases share idempotency hashes and one PostgreSQL write", async () => {
  const session = await login("decimal-alias-user");
  const household = await createHousehold(session, "decimal-alias-house");
  const householdId = household.data.household.id;
  const createKey = "decimal-alias-create";
  const baseRequest = {
    displayName: "别名库存",
    storageLocation: "refrigerated" as const,
    dates: [],
  };
  const firstCreate = await createLot(
    session,
    householdId,
    createKey,
    {
      ...baseRequest,
      initialQuantity: {
        kind: "exact",
        amount: "1.0",
        unit: "kg",
      },
    },
  );
  const replayCreateResponse = await app.inject({
    method: "POST",
    url: `/api/v1/households/${householdId}/inventory-lots`,
    headers: {
      ...authHeaders(session),
      "idempotency-key": createKey,
    },
    payload: {
      ...baseRequest,
      initialQuantity: {
        kind: "exact",
        amount: "1.000000",
        unit: "kg",
      },
    },
  });
  assert.equal(replayCreateResponse.statusCode, 201, replayCreateResponse.body);
  const replayCreate = createInventoryLotSuccessSchema.parse(
    replayCreateResponse.json(),
  );
  assert.equal(replayCreate.data.lot.id, firstCreate.data.lot.id);
  assert.equal(replayCreate.meta.idempotency?.replayed, true);
  assert.equal(replayCreate.data.lot.currentQuantity.kind, "exact");
  if (replayCreate.data.lot.currentQuantity.kind === "exact") {
    assert.equal(replayCreate.data.lot.currentQuantity.amount, "1");
  }

  const consumeKey = "decimal-alias-consume";
  const sendConsumeAlias = (amount: string) =>
    app.inject({
      method: "POST",
      url:
        `/api/v1/households/${householdId}` +
        `/inventory-lots/${firstCreate.data.lot.id}/events/consumed`,
      headers: {
        ...authHeaders(session),
        "idempotency-key": consumeKey,
      },
      payload: {
        consumedQuantity: {
          kind: "exact",
          amount,
          unit: "kg",
        },
        expectedVersion: 1,
      },
    });
  const firstConsumeResponse = await sendConsumeAlias("0.1");
  const replayConsumeResponse = await sendConsumeAlias("0.100000");
  assert.equal(firstConsumeResponse.statusCode, 201, firstConsumeResponse.body);
  assert.equal(
    replayConsumeResponse.statusCode,
    201,
    replayConsumeResponse.body,
  );
  const firstConsume = consumeInventoryLotSuccessSchema.parse(
    firstConsumeResponse.json(),
  );
  const replayConsume = consumeInventoryLotSuccessSchema.parse(
    replayConsumeResponse.json(),
  );
  assert.equal(replayConsume.data.event.id, firstConsume.data.event.id);
  assert.equal(replayConsume.meta.idempotency?.replayed, true);

  const state = await persistence.pool.query<{
    amount: string;
    events: number;
    idempotency_records: number;
  }>(
    `SELECT
       l.current_quantity_amount::text AS amount,
       (SELECT count(*)::int
        FROM inventory_events e
        WHERE e.inventory_lot_id = l.id) AS events,
       (SELECT count(*)::int
        FROM idempotency_records i
        WHERE i.idempotency_key IN ($2, $3)) AS idempotency_records
     FROM inventory_lots l
     WHERE l.id = $1`,
    [firstCreate.data.lot.id, createKey, consumeKey],
  );
  assert.deepEqual(state.rows[0], {
    amount: "0.900000",
    events: 2,
    idempotency_records: 2,
  });
});

test("reusing a consumed idempotency key for another lot returns conflict instead of replaying", async () => {
  const session = await login("cross-lot-key-user");
  const household = await createHousehold(session, "cross-lot-key-house");
  const firstLot = await createLot(
    session,
    household.data.household.id,
    "cross-lot-create-1",
    exactLotRequest("批次一", "2", "kg"),
  );
  const secondLot = await createLot(
    session,
    household.data.household.id,
    "cross-lot-create-2",
    exactLotRequest("批次二", "2", "kg"),
  );
  const key = "cross-lot-consume-key";

  const first = await consume(
    session,
    household.data.household.id,
    firstLot.data.lot.id,
    key,
    "1",
    1,
  );
  assert.equal(first.statusCode, 201, first.body);
  const crossLot = await consume(
    session,
    household.data.household.id,
    secondLot.data.lot.id,
    key,
    "1",
    1,
  );
  assert.equal(crossLot.statusCode, 409);
  assert.equal(
    apiErrorSchema.parse(crossLot.json()).code,
    "IDEMPOTENCY_KEY_REUSED",
  );

  const state = await persistence.pool.query<{
    id: string;
    amount: string;
    events: number;
  }>(
    `SELECT
       l.id,
       l.current_quantity_amount::text AS amount,
       (SELECT count(*)::int
        FROM inventory_events e
        WHERE e.inventory_lot_id = l.id) AS events
     FROM inventory_lots l
     WHERE l.id IN ($1, $2)
     ORDER BY l.id`,
    [firstLot.data.lot.id, secondLot.data.lot.id],
  );
  const firstState = state.rows.find((row) => row.id === firstLot.data.lot.id);
  const secondState = state.rows.find((row) => row.id === secondLot.data.lot.id);
  assert.deepEqual(firstState, {
    id: firstLot.data.lot.id,
    amount: "1.000000",
    events: 2,
  });
  assert.deepEqual(secondState, {
    id: secondLot.data.lot.id,
    amount: "2.000000",
    events: 1,
  });
});

test("different idempotency keys with one expectedVersion yield one success and one version conflict", async () => {
  const firstSession = await login("version-conflict-user");
  const secondSession = await login("version-conflict-user");
  const household = await createHousehold(
    firstSession,
    "version-conflict-house",
  );
  const lot = await createLot(
    firstSession,
    household.data.household.id,
    "version-conflict-lot",
    exactLotRequest("并发米", "5", "kg"),
  );

  const responses = await Promise.all([
    consume(
      firstSession,
      household.data.household.id,
      lot.data.lot.id,
      "version-conflict-a",
      "1",
      1,
    ),
    consume(
      secondSession,
      household.data.household.id,
      lot.data.lot.id,
      "version-conflict-b",
      "1",
      1,
    ),
  ]);
  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [201, 409],
  );
  const conflict = responses.find((response) => response.statusCode === 409);
  assert.equal(
    apiErrorSchema.parse(conflict?.json()).code,
    "INVENTORY_VERSION_CONFLICT",
  );

  const state = await persistence.pool.query<{
    amount: string;
    version: number;
    events: number;
  }>(
    `SELECT
       l.current_quantity_amount::text AS amount,
       l.version,
       (SELECT count(*)::int
        FROM inventory_events e
        WHERE e.inventory_lot_id = l.id) AS events
     FROM inventory_lots l
     WHERE l.id = $1`,
    [lot.data.lot.id],
  );
  assert.deepEqual(state.rows[0], {
    amount: "4.000000",
    version: 2,
    events: 2,
  });
});

test("same idempotency key and body concurrently execute consumed exactly once and replay the result", async () => {
  const firstSession = await login("same-key-consumed-user");
  const secondSession = await login("same-key-consumed-user");
  const household = await createHousehold(
    firstSession,
    "same-key-consumed-house",
  );
  const lot = await createLot(
    firstSession,
    household.data.household.id,
    "same-key-consumed-lot",
    exactLotRequest("并发油", "5", "L"),
  );
  const key = "same-key-consumed-1";

  const responses = await Promise.all([
    consume(
      firstSession,
      household.data.household.id,
      lot.data.lot.id,
      key,
      "1",
      1,
      "L",
    ),
    consume(
      secondSession,
      household.data.household.id,
      lot.data.lot.id,
      key,
      "1",
      1,
      "L",
    ),
  ]);
  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [201, 201],
  );
  const results = responses.map((response) =>
    consumeInventoryLotSuccessSchema.parse(response.json()),
  );
  assert.equal(results[0]?.data.event.id, results[1]?.data.event.id);
  assert.deepEqual(
    results.map((result) => result.meta.idempotency?.replayed).sort(),
    [false, true],
  );

  const state = await persistence.pool.query<{
    amount: string;
    version: number;
    events: number;
  }>(
    `SELECT
       l.current_quantity_amount::text AS amount,
       l.version,
       (SELECT count(*)::int
        FROM inventory_events e
        WHERE e.inventory_lot_id = l.id) AS events
     FROM inventory_lots l
     WHERE l.id = $1`,
    [lot.data.lot.id],
  );
  assert.deepEqual(state.rows[0], {
    amount: "4.000000",
    version: 2,
    events: 2,
  });
});

test("session expiry, revocation and membership removal take effect immediately", async () => {
  const session = await login("lifecycle-user");
  const household = await createHousehold(session, "lifecycle-household");
  const revoked = await app.inject({
    method: "DELETE",
    url: "/api/v1/session",
    headers: authHeaders(session),
  });
  assert.equal(revoked.statusCode, 200);
  sessionRevokedSuccessSchema.parse(revoked.json());
  const afterRevoke = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: authHeaders(session),
  });
  assert.equal(afterRevoke.statusCode, 401);

  const restored = await login("lifecycle-user");
  await persistence.pool.query(
    `UPDATE memberships
     SET status = 'removed', updated_at = clock_timestamp(), version = version + 1
     WHERE household_id = $1 AND user_id = $2`,
    [household.data.household.id, restored.user.id],
  );
  const resource = await app.inject({
    method: "GET",
    url:
      `/api/v1/households/${household.data.household.id}` +
      "/inventory-lots",
    headers: authHeaders(restored),
  });
  assert.equal(resource.statusCode, 404);
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: authHeaders(restored),
  });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(meSuccessSchema.parse(me.json()).data.households, []);
});

test("transaction-local user and household settings do not remain on a pooled connection", async () => {
  const session = await login("connection-context-user");
  const household = await createHousehold(
    session,
    "connection-context-house",
  );
  const client = await persistence.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE meal_agent_app");
    await client.query("SELECT set_config('app.user_id', $1, true)", [
      session.user.id,
    ]);
    await client.query("SELECT set_config('app.household_id', $1, true)", [
      household.data.household.id,
    ]);
    await client.query("COMMIT");
    const settings = await client.query<{
      user_id: string | null;
      household_id: string | null;
      role_name: string;
    }>(
      `SELECT
         NULLIF(current_setting('app.user_id', true), '') AS user_id,
         NULLIF(current_setting('app.household_id', true), '') AS household_id,
         current_user AS role_name`,
    );
    assert.deepEqual(settings.rows[0], {
      user_id: null,
      household_id: null,
      role_name: "postgres",
    });
  } finally {
    client.release();
  }
});

test("database-backed HTTP logs omit codes, tokens, provider identifiers, secrets and private constraints", async () => {
  const code = "LOG-CODE-SENTINEL";
  const session = await login(code);
  const household = await createHousehold(session, "log-household-key");
  await persistence.pool.query(
    `UPDATE person_profiles
     SET dietary_constraints = $2::jsonb
     WHERE household_id = $1`,
    [
      household.data.household.id,
      JSON.stringify([
        {
          visibility: "subject_and_owner",
          notes: "PRIVATE-CONSTRAINT-SENTINEL",
        },
      ]),
    ],
  );
  await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: authHeaders(session),
  });
  const identity = await persistence.pool.query<{
    provider_subject: string;
    provider_union_subject: string | null;
  }>("SELECT provider_subject, provider_union_subject FROM auth_identities");

  for (const secret of [
    code,
    session.accessToken,
    identity.rows[0]?.provider_subject,
    identity.rows[0]?.provider_union_subject,
    "APPSECRET-SENTINEL",
    "PRIVATE-CONSTRAINT-SENTINEL",
  ]) {
    if (secret !== null && secret !== undefined) {
      assert.equal(logs.includes(secret), false);
    }
  }
});
