import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { after, before, beforeEach, test } from "node:test";

import {
  authenticatedSessionSchema,
  createHouseholdInviteSuccessSchema,
  createHouseholdSuccessSchema,
  getPersonProfileSuccessSchema,
  hardConstraintConfirmationFingerprint,
  householdInvitePageSuccessSchema,
  joinHouseholdSuccessSchema,
  listHouseholdMembersSuccessSchema,
  listPersonProfilesSuccessSchema,
  personProfileLinkRequestSuccessSchema,
  confirmPersonProfileLinkSuccessSchema,
  personProfileMutationSuccessSchema,
  removeMembershipSuccessSchema,
  revokeHouseholdInviteSuccessSchema,
  wechatLoginExchangeSuccessSchema,
  type AuthenticatedSession,
} from "@meal-agent/contracts";
import type { LightMyRequestResponse } from "fastify";
import { v7 as uuidv7 } from "uuid";

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

const login = async (code: string): Promise<AuthenticatedSession> => {
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

// 幂等键契约要求 16–128 字符；测试里用短名做键，这里统一补齐到合法长度
// （确定性变换，保证重放用同名仍命中同一条幂等记录）。
const normalizeKey = (key: string): string =>
  `s08-${key}`.padEnd(16, "0").slice(0, 128);

const waitForAdvisoryWaiters = async (
  minimum: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await persistence.pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM pg_catalog.pg_locks
       WHERE locktype = 'advisory' AND NOT granted`,
    );
    if ((result.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected at least ${minimum} advisory lock waiters`);
};

const idempotent = (session: AuthenticatedSession, key: string) => ({
  ...authHeaders(session),
  "idempotency-key": normalizeKey(key),
});

const createHousehold = async (
  session: AuthenticatedSession,
  key: string,
  name = "测试家庭",
) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/households",
    headers: idempotent(session, key),
    payload: {
      name,
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      ownerProfile: {
        displayName: `${name}户主`,
        defaultPortionScale: 1,
        cookingSkill: "beginner",
      },
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return createHouseholdSuccessSchema.parse(response.json()).data;
};

const createInvite = (
  session: AuthenticatedSession,
  householdId: string,
  key: string,
  body: { maxUses?: number; expiresInHours?: number } = {},
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: "POST",
    url: `/api/v1/households/${householdId}/invites`,
    headers: idempotent(session, key),
    payload: body,
  });

const issueInvite = async (
  session: AuthenticatedSession,
  householdId: string,
  key: string,
  body: { maxUses?: number; expiresInHours?: number } = {},
) => {
  const response = await createInvite(session, householdId, key, body);
  assert.equal(response.statusCode, 201, response.body);
  const data = createHouseholdInviteSuccessSchema.parse(response.json()).data;
  // 首次签发必然返回明文码；收窄类型以便下游 join 使用（重放场景请用
  // 底层 createInvite 手动解析，那时 inviteCode 才可能缺失）。
  if (data.inviteCode === undefined) {
    throw new Error("a freshly issued invite must return a plaintext code");
  }
  return { ...data, inviteCode: data.inviteCode };
};

const join = (
  session: AuthenticatedSession,
  inviteCode: string,
  key: string,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: "POST",
    url: "/api/v1/households/join",
    headers: idempotent(session, key),
    payload: { inviteCode },
  });

const listMembers = (
  session: AuthenticatedSession,
  householdId: string,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: "GET",
    url: `/api/v1/households/${householdId}/members`,
    headers: authHeaders(session),
  });

const createProfile = (
  session: AuthenticatedSession,
  householdId: string,
  key: string,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: "POST",
    url: `/api/v1/households/${householdId}/person-profiles`,
    headers: idempotent(session, key),
    payload: body,
  });

const getProfile = async (
  session: AuthenticatedSession,
  householdId: string,
  profileId: string,
) => {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/households/${householdId}/person-profiles/${profileId}`,
    headers: authHeaders(session),
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = getPersonProfileSuccessSchema.parse(response.json()).data;
  assert.equal(data.access, "owner_or_self");
  return data.profile;
};

const addConstraint = (
  session: AuthenticatedSession,
  householdId: string,
  profileId: string,
  key: string,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: "POST",
    url: `/api/v1/households/${householdId}/person-profiles/${profileId}/dietary-constraints`,
    headers: idempotent(session, key),
    payload: body,
  });

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

// 虚构的敏感样例，供 redaction 测试使用（非真实个人数据）。
const privateHardConstraint = (label: string) => {
  const fields = {
    kind: "allergy" as const,
    enforcement: "hard" as const,
    label,
    foodConceptIds: [],
    allergenCodes: ["FICTION_TREE_NUT"],
    visibility: "subject_and_owner" as const,
  };
  return {
    expectedVersion: 0,
    constraint: {
      ...fields,
      confirmation: {
        acknowledged: true as const,
        fingerprint: hardConstraintConfirmationFingerprint(fields),
      },
    },
  };
};

test("invite stores only a digest, returns plaintext once, and lists without secrets", async () => {
  const owner = await login("invite-owner");
  const household = await createHousehold(owner, "invite-owner-hh");
  const householdId = household.household.id;

  const created = await issueInvite(owner, householdId, "invite-key-1", {
    maxUses: 3,
  });
  assert.match(created.inviteCode, /^[A-Za-z0-9_-]{22,128}$/);
  assert.equal(created.invite.status, "active");
  assert.equal(created.invite.usedCount, 0);
  assert.equal(created.invite.maxUses, 3);
  // 实体不含明文或 digest 字段（strict schema 已保证；这里再断言运行时）。
  assert.equal("code" in created.invite, false);
  assert.equal("codeDigest" in created.invite, false);

  // 库里只有 digest，且等于明文码的 sha256。
  const stored = await persistence.pool.query<{
    code_digest: string;
    plaintext: string | null;
  }>(
    `SELECT code_digest,
            to_jsonb(household_invites) ->> 'code' AS plaintext
     FROM household_invites WHERE id = $1`,
    [created.invite.id],
  );
  assert.equal(stored.rows[0]?.code_digest, sha256Hex(created.inviteCode));
  assert.equal(stored.rows[0]?.plaintext, null);

  // 列表响应不泄露明文/digest。
  const listResponse = await app.inject({
    method: "GET",
    url: `/api/v1/households/${householdId}/invites`,
    headers: authHeaders(owner),
  });
  assert.equal(listResponse.statusCode, 200, listResponse.body);
  const page = householdInvitePageSuccessSchema.parse(listResponse.json());
  assert.equal(page.data.items.length, 1);
  assert.equal(JSON.stringify(page.data).includes(created.inviteCode), false);

  // 明文邀请码不得进入日志。
  assert.equal(logs.includes(created.inviteCode), false);

  // 幂等记录的 response_body 落库前已剔除明文码：备份/dump 不泄露可兑换码。
  // 按 household + 路由定位（此刻该家庭仅一条邀请创建记录），避免依赖
  // Idempotency-Key 的规范化形态。
  const idempotencyStored = await persistence.pool.query<{
    response_body: unknown;
  }>(
    `SELECT response_body
     FROM idempotency_records
     WHERE household_id = $1 AND normalized_route = $2`,
    [householdId, "/api/v1/households/{id}/invites"],
  );
  assert.equal(idempotencyStored.rowCount, 1);
  assert.equal(
    JSON.stringify(idempotencyStored.rows[0]?.response_body ?? {}).includes(
      created.inviteCode,
    ),
    false,
  );

  // 幂等重放（同 key）返回同一 invite 实体，但不再携带明文码（仅一次语义）。
  // 用底层 createInvite 手动解析，因为重放响应的 inviteCode 合法地缺失。
  const replayResponse = await createInvite(owner, householdId, "invite-key-1", {
    maxUses: 3,
  });
  assert.equal(replayResponse.statusCode, 201, replayResponse.body);
  const replayParsed = createHouseholdInviteSuccessSchema.parse(
    replayResponse.json(),
  );
  assert.equal(replayParsed.meta.idempotency?.replayed, true);
  assert.equal(replayParsed.data.invite.id, created.invite.id);
  assert.equal(replayParsed.data.inviteCode, undefined);
});

test("all four invalid invite states are rejected with a 404 that hides the household", async () => {
  const owner = await login("invite-reject-owner");
  const household = await createHousehold(owner, "invite-reject-hh");
  const householdId = household.household.id;
  const outsider = await login("invite-reject-outsider");

  // 无效码。
  const invalid = await join(outsider, "Z".repeat(32), "join-invalid");
  assert.equal(invalid.statusCode, 404, invalid.body);

  // 撤销。
  const revokedInvite = await issueInvite(owner, householdId, "inv-rev");
  const revokeResponse = await app.inject({
    method: "DELETE",
    url: `/api/v1/households/${householdId}/invites/${revokedInvite.invite.id}`,
    headers: idempotent(owner, "revoke-key-1"),
  });
  assert.equal(revokeResponse.statusCode, 200, revokeResponse.body);
  revokeHouseholdInviteSuccessSchema.parse(revokeResponse.json());
  const revokedJoin = await join(
    outsider,
    revokedInvite.inviteCode,
    "join-revoked",
  );
  assert.equal(revokedJoin.statusCode, 404);

  // 过期：把 created_at/expires_at 一起挪到过去（CHECK 要求 expires_at >
  // created_at，故不能只改 expires_at 到 created_at 之前）。
  const expiredInvite = await issueInvite(owner, householdId, "inv-exp");
  await persistence.pool.query(
    `UPDATE household_invites
     SET created_at = clock_timestamp() - interval '2 days',
         expires_at = clock_timestamp() - interval '1 day'
     WHERE id = $1`,
    [expiredInvite.invite.id],
  );
  const expiredJoin = await join(
    outsider,
    expiredInvite.inviteCode,
    "join-expired",
  );
  assert.equal(expiredJoin.statusCode, 404);

  // 用尽（maxUses=1，先让一人用掉）。
  const exhaustInvite = await issueInvite(owner, householdId, "inv-exh", {
    maxUses: 1,
  });
  const firstUser = await login("invite-exhaust-first");
  const firstJoin = await join(
    firstUser,
    exhaustInvite.inviteCode,
    "join-exhaust-1",
  );
  assert.equal(firstJoin.statusCode, 201, firstJoin.body);
  const secondUser = await login("invite-exhaust-second");
  const secondJoin = await join(
    secondUser,
    exhaustInvite.inviteCode,
    "join-exhaust-2",
  );
  assert.equal(secondJoin.statusCode, 404);

  // 全部失败态返回体一律不含 householdId，不泄露家庭存在性。
  for (const response of [invalid, revokedJoin, expiredJoin, secondJoin]) {
    assert.equal(response.body.includes(householdId), false);
  }
});

test("join is user-idempotent, rejects a repeat member, and never over-issues under concurrency", async () => {
  const owner = await login("join-owner");
  const household = await createHousehold(owner, "join-owner-hh");
  const invite = await issueInvite(owner, household.household.id, "join-inv", {
    maxUses: 2,
  });

  const member = await login("join-member");
  const first = await join(member, invite.inviteCode, "join-key-a");
  assert.equal(first.statusCode, 201, first.body);
  const firstResult = joinHouseholdSuccessSchema.parse(first.json());
  assert.equal(firstResult.data.membership.role, "member");
  assert.equal(firstResult.meta.idempotency?.replayed, false);
  const membershipId = firstResult.data.membership.id;

  // 同键同体重放 → 同一 membership。
  const replay = await join(member, invite.inviteCode, "join-key-a");
  assert.equal(replay.statusCode, 201, replay.body);
  const replayResult = joinHouseholdSuccessSchema.parse(replay.json());
  assert.equal(replayResult.meta.idempotency?.replayed, true);
  assert.equal(replayResult.data.membership.id, membershipId);

  // 新键再加入 → 已是成员 409。
  const repeat = await join(member, invite.inviteCode, "join-key-b");
  assert.equal(repeat.statusCode, 409);

  // 并发：maxUses=1 的邀请被两个不同用户同时消费，恰好一个成功。
  const soleInvite = await issueInvite(
    owner,
    household.household.id,
    "sole-inv",
    { maxUses: 1 },
  );
  const racerB = await login("join-racer-b");
  const racerC = await login("join-racer-c");
  const [raceB, raceC] = await Promise.all([
    join(racerB, soleInvite.inviteCode, "race-b"),
    join(racerC, soleInvite.inviteCode, "race-c"),
  ]);
  const statuses = [raceB.statusCode, raceC.statusCode].sort();
  assert.deepEqual(statuses, [201, 404]);
  const usage = await persistence.pool.query<{
    used_count: number;
    status: string;
  }>("SELECT used_count, status FROM household_invites WHERE id = $1", [
    soleInvite.invite.id,
  ]);
  assert.equal(usage.rows[0]?.used_count, 1);
  assert.equal(usage.rows[0]?.status, "exhausted");
});

test("authorization matrix: members cannot manage invites, other members, or foreign households", async () => {
  const owner = await login("authz-owner");
  const household = await createHousehold(owner, "authz-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "authz-inv", {
    maxUses: 5,
  });
  const member = await login("authz-member");
  const joinResponse = await join(member, invite.inviteCode, "authz-join");
  assert.equal(joinResponse.statusCode, 201, joinResponse.body);
  const memberMembershipId = joinHouseholdSuccessSchema.parse(
    joinResponse.json(),
  ).data.membership.id;

  // member 不能签发邀请。
  const memberInvite = await createInvite(member, householdId, "m-inv");
  assert.equal(memberInvite.statusCode, 403);

  // member 不能撤销邀请。
  const memberRevoke = await app.inject({
    method: "DELETE",
    url: `/api/v1/households/${householdId}/invites/${invite.invite.id}`,
    headers: idempotent(member, "m-revoke"),
  });
  assert.equal(memberRevoke.statusCode, 403);

  // member 不能移除他人（这里尝试移除 owner）。
  const ownerMembershipId = household.membership.id;
  const memberRemovesOwner = await app.inject({
    method: "DELETE",
    url: `/api/v1/households/${householdId}/memberships/${ownerMembershipId}`,
    headers: idempotent(member, "m-remove-owner"),
  });
  assert.equal(memberRemovesOwner.statusCode, 403);

  // 跨家庭：member 访问一个自己不属于的家庭 → 404（不泄露存在性）。
  const otherOwner = await login("authz-other-owner");
  const otherHousehold = await createHousehold(otherOwner, "authz-other-hh");
  const crossMembers = await listMembers(
    member,
    otherHousehold.household.id,
  );
  assert.equal(crossMembers.statusCode, 404);

  // owner 移除 member 成功；被移除者下一请求立即 404。
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/v1/households/${householdId}/memberships/${memberMembershipId}`,
    headers: idempotent(owner, "owner-remove-member"),
  });
  assert.equal(removed.statusCode, 200, removed.body);
  removeMembershipSuccessSchema.parse(removed.json());
  const afterRemoval = await listMembers(member, householdId);
  assert.equal(afterRemoval.statusCode, 404);

  // 最后一位 owner 不可被移除。
  const lastOwner = await app.inject({
    method: "DELETE",
    url: `/api/v1/households/${householdId}/memberships/${ownerMembershipId}`,
    headers: idempotent(owner, "owner-remove-self"),
  });
  assert.equal(lastOwner.statusCode, 409);
});

test("foreign membership DELETE returns 404 before a household idempotency insert", async () => {
  const owner = await login("foreign-delete-owner");
  const household = await createHousehold(
    owner,
    "foreign-delete-household",
  );
  const outsider = await login("foreign-delete-outsider");
  const response = await app.inject({
    method: "DELETE",
    url:
      `/api/v1/households/${household.household.id}/memberships/` +
      `${household.membership.id}`,
    headers: idempotent(outsider, "foreign-delete-key"),
  });
  assert.equal(response.statusCode, 404, response.body);
});

test("hard dietary constraints demand confirmation and record who confirmed; soft ones do not", async () => {
  const owner = await login("confirm-owner");
  const household = await createHousehold(owner, "confirm-hh");
  const householdId = household.household.id;
  const profileId = household.ownerProfile.id;

  // 无 confirmation 的硬约束 → 400（契约层拒绝）。
  const missingConfirmation = await addConstraint(
    owner,
    householdId,
    profileId,
    "hard-noconfirm",
    {
      expectedVersion: 0,
      constraint: {
        kind: "allergy",
        enforcement: "hard",
        label: "虚构花生过敏",
        allergenCodes: ["FICTION_PEANUT"],
        visibility: "household",
      },
    },
  );
  assert.equal(missingConfirmation.statusCode, 400);

  // confirmation 缺少全字段指纹 → 400；这不否定 label-only allergy。
  const noCode = await addConstraint(
    owner,
    householdId,
    profileId,
    "hard-nocode",
    {
      expectedVersion: 0,
      constraint: {
        kind: "allergy",
        enforcement: "hard",
        label: "缺编码过敏",
        visibility: "household",
        confirmation: { acknowledged: true },
      },
    },
  );
  assert.equal(noCode.statusCode, 400);

  const invalidIdentifierFields = [
    {
      foodConceptIds: [
        "018f0000-0000-7000-8000-00000000000A",
      ],
      allergenCodes: [],
    },
    {
      foodConceptIds: [],
      allergenCodes: ["DUPLICATE", "DUPLICATE"],
    },
    {
      foodConceptIds: Array.from(
        { length: 101 },
        () => "018f0000-0000-7000-8000-00000000000a",
      ),
      allergenCodes: [],
    },
  ];
  for (const [index, identifiers] of invalidIdentifierFields.entries()) {
    const fields = {
      kind: "allergy" as const,
      enforcement: "hard" as const,
      label: `非法标识-${index}`,
      ...identifiers,
      visibility: "household" as const,
    };
    const response = await addConstraint(
      owner,
      householdId,
      profileId,
      `hard-invalid-identifiers-${index}`,
      {
        expectedVersion: 0,
        constraint: {
          ...fields,
          confirmation: {
            acknowledged: true,
            fingerprint: hardConstraintConfirmationFingerprint(fields),
          },
        },
      },
    );
    assert.equal(response.statusCode, 400, response.body);
  }

  // 合法硬约束 → 201，服务端写入 confirmedAt + confirmedByUserId=操作者。
  const hardFields = {
    kind: "allergy" as const,
    enforcement: "hard" as const,
    label: "虚构花生过敏",
    foodConceptIds: [],
    allergenCodes: ["FICTION_PEANUT"],
    visibility: "household" as const,
  };
  const added = await addConstraint(
    owner,
    householdId,
    profileId,
    "hard-ok",
    {
      expectedVersion: 0,
      constraint: {
        ...hardFields,
        confirmation: {
          acknowledged: true,
          fingerprint: hardConstraintConfirmationFingerprint(hardFields),
        },
      },
    },
  );
  assert.equal(added.statusCode, 201, added.body);
  const receipt = personProfileMutationSuccessSchema.parse(added.json()).data;
  const profile = await getProfile(owner, householdId, receipt.profileId);
  assert.equal(profile.dietaryConstraints.length, 1);
  const constraint = profile.dietaryConstraints[0];
  assert.equal(constraint?.confirmedByUserId, owner.user.id);
  assert.equal(typeof constraint?.confirmedAt, "string");
  assert.equal(profile.version, 1);
});

test("all five hard constraint kinds persist as needs_structured_mapping until an authoritative vocabulary exists", async () => {
  const owner = await login("hard-matrix-owner");
  const household = await createHousehold(owner, "hard-matrix-hh");
  const householdId = household.household.id;
  const profileId = household.ownerProfile.id;
  const kinds = [
    "allergy",
    "religious",
    "ethical",
    "explicit_avoid",
    "food_safety_exclusion",
  ] as const;

  for (const [version, kind] of kinds.entries()) {
    const fields = {
      kind,
      enforcement: "hard" as const,
      label: `矩阵-${kind}`,
      foodConceptIds: [],
      allergenCodes: kind === "allergy" ? ["SHAPE_ONLY"] : [],
      visibility: "household" as const,
    };
    const response = await addConstraint(
      owner,
      householdId,
      profileId,
      `hard-matrix-${kind}`,
      {
        expectedVersion: version,
        constraint: {
          ...fields,
          confirmation: {
            acknowledged: true,
            fingerprint: hardConstraintConfirmationFingerprint(fields),
          },
        },
      },
    );
    assert.equal(response.statusCode, 201, response.body);
  }

  const profile = await getProfile(owner, householdId, profileId);
  assert.deepEqual(
    profile.dietaryConstraints.map((constraint) => [
      constraint.kind,
      constraint.enforcement === "hard"
        ? constraint.mappingStatus
        : undefined,
    ]),
    kinds.map((kind) => [kind, "needs_structured_mapping"]),
  );
});

test("household view is structurally free of subject_and_owner constraints; owner and self still see them", async () => {
  const owner = await login("redact-owner");
  const household = await createHousehold(owner, "redact-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "redact-inv", {
    maxUses: 5,
  });

  // 成员 B 加入并建立自己的档案，录入 subject_and_owner 硬约束（双确认）。
  const memberB = await login("redact-member-b");
  const joinB = joinHouseholdSuccessSchema.parse(
    (await join(memberB, invite.inviteCode, "redact-join-b")).json(),
  );
  const profileResponse = await createProfile(
    memberB,
    householdId,
    "redact-b-profile",
    {
      linkedMembershipId: joinB.data.membership.id,
      displayName: "成员B",
      defaultParticipation: true,
      defaultPortionScale: 1,
      cookingSkill: "beginner",
    },
  );
  assert.equal(profileResponse.statusCode, 201, profileResponse.body);
  const profileReceipt = personProfileMutationSuccessSchema.parse(
    profileResponse.json(),
  ).data;
  const profileB = await getProfile(
    memberB,
    householdId,
    profileReceipt.profileId,
  );
  const privateAdd = await addConstraint(
    memberB,
    householdId,
    profileB.id,
    "redact-b-constraint",
    privateHardConstraint("虚构坚果忌口"),
  );
  assert.equal(privateAdd.statusCode, 201, privateAdd.body);
  const cached = await persistence.pool.query<{ response_body: unknown }>(
    `SELECT response_body
     FROM idempotency_records
     WHERE idempotency_key = $1`,
    [normalizeKey("redact-b-constraint")],
  );
  const cachedJson = JSON.stringify(cached.rows[0]?.response_body);
  assert.equal(cachedJson.includes("虚构坚果忌口"), false);
  assert.equal(cachedJson.includes("dietaryConstraints"), false);

  // 第三成员 C 加入。
  const memberC = await login("redact-member-c");
  const joinC = await join(memberC, invite.inviteCode, "redact-join-c");
  assert.equal(joinC.statusCode, 201, joinC.body);

  // owner 视图：能看到 B 的私密约束。
  const ownerView = listHouseholdMembersSuccessSchema.parse(
    (await listMembers(owner, householdId)).json(),
  ).data;
  assert.equal(ownerView.viewerRole, "owner");
  if (ownerView.viewerRole !== "owner") {
    return;
  }
  const ownerSeesB = ownerView.members.find(
    (entry) => entry.membership.id === joinB.data.membership.id,
  );
  assert.equal(
    ownerSeesB?.profile?.dietaryConstraints.some(
      (constraint) => constraint.visibility === "subject_and_owner",
    ),
    true,
  );

  // C 的 member 视图：本人在 self，其余在 others；others 结构上不含私密约束。
  const cView = listHouseholdMembersSuccessSchema.parse(
    (await listMembers(memberC, householdId)).json(),
  ).data;
  assert.equal(cView.viewerRole, "member");
  if (cView.viewerRole !== "member") {
    return;
  }
  const cSeesB = cView.others.find(
    (entry) => entry.membership.id === joinB.data.membership.id,
  );
  assert.notEqual(cSeesB, undefined);
  for (const entry of cView.others) {
    for (const constraint of entry.profile?.dietaryConstraints ?? []) {
      assert.equal(constraint.visibility, "household");
    }
  }
  // 序列化后整个 others 里不出现私密约束的标签。
  assert.equal(JSON.stringify(cView.others).includes("虚构坚果忌口"), false);

  // 日志不泄露私密约束标签。
  assert.equal(logs.includes("虚构坚果忌口"), false);
});

test("profile edits enforce optimistic concurrency and idempotent replay", async () => {
  const owner = await login("concurrency-owner");
  const household = await createHousehold(owner, "concurrency-hh");
  const householdId = household.household.id;
  const profileId = household.ownerProfile.id;

  // 过期 expectedVersion → 409。
  const stale = await app.inject({
    method: "PATCH",
    url: `/api/v1/households/${householdId}/person-profiles/${profileId}`,
    headers: idempotent(owner, "patch-stale"),
    payload: { operation: "update", expectedVersion: 5, displayName: "改名" },
  });
  assert.equal(stale.statusCode, 409);

  // 正确版本 → 200，version 递增。
  const updated = await app.inject({
    method: "PATCH",
    url: `/api/v1/households/${householdId}/person-profiles/${profileId}`,
    headers: idempotent(owner, "patch-ok"),
    payload: { operation: "update", expectedVersion: 0, displayName: "新户主名" },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  const updatedReceipt = personProfileMutationSuccessSchema.parse(
    updated.json(),
  ).data;
  const updatedProfile = await getProfile(
    owner,
    householdId,
    updatedReceipt.profileId,
  );
  assert.equal(updatedProfile.displayName, "新户主名");
  assert.equal(updatedProfile.version, 1);

  // 加约束后同键重放 → 同一结果、不重复追加。
  const addKey = "add-idem";
  const addBody = {
    expectedVersion: 1,
    constraint: {
      kind: "preference" as const,
      enforcement: "soft" as const,
      label: "少油",
      preference: "dislike" as const,
      visibility: "household" as const,
    },
  };
  const firstAdd = await addConstraint(
    owner,
    householdId,
    profileId,
    addKey,
    addBody,
  );
  assert.equal(firstAdd.statusCode, 201, firstAdd.body);
  const firstReceipt =
    personProfileMutationSuccessSchema.parse(firstAdd.json()).data;
  const afterFirst = await getProfile(
    owner,
    householdId,
    firstReceipt.profileId,
  );
  assert.equal(afterFirst.dietaryConstraints.length, 1);
  assert.equal(afterFirst.version, 2);

  const replayAdd = await addConstraint(
    owner,
    householdId,
    profileId,
    addKey,
    addBody,
  );
  assert.equal(replayAdd.statusCode, 201, replayAdd.body);
  const replayReceipt =
    personProfileMutationSuccessSchema.parse(replayAdd.json()).data;
  const afterReplay = await getProfile(
    owner,
    householdId,
    replayReceipt.profileId,
  );
  assert.deepEqual(replayReceipt, firstReceipt);
  assert.equal(afterReplay.dietaryConstraints.length, 1);
  assert.equal(afterReplay.version, 2);
});

test("member RLS: second member works, and each missing bootstrap context is denied", async () => {
  const owner = await login("rls-owner");
  const household = await createHousehold(owner, "rls-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "rls-inv");
  const member = await login("rls-member");
  const joinResult = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "rls-join")).json(),
  );
  const memberUserId = member.user.id;
  const memberMembershipId = joinResult.data.membership.id;

  // 第二成员真实用例：member 能读取成员列表（member 视图）。
  const memberList = await listMembers(member, householdId);
  assert.equal(memberList.statusCode, 200, memberList.body);
  const view = listHouseholdMembersSuccessSchema.parse(memberList.json()).data;
  assert.equal(view.viewerRole, "member");

  // 反向：三类 bootstrap 单独缺失，直接以 meal_agent_app 角色查询都应 0 行。
  const outsider = await login("rls-outsider");

  const missingUser = await withAppTransaction(persistence, async (client) => {
    // 只设 household，不设 user。
    await setHouseholdContext(client, householdId);
    return client.query("SELECT id FROM memberships WHERE household_id = $1", [
      householdId,
    ]);
  });
  assert.equal(missingUser.rowCount, 0);

  const missingHousehold = await withAppTransaction(
    persistence,
    async (client) => {
      // 只设 user，不设 household：household 作用域策略要求匹配 household。
      await setUserContext(client, memberUserId);
      return client.query(
        "SELECT id FROM person_profiles WHERE household_id = $1",
        [householdId],
      );
    },
  );
  assert.equal(missingHousehold.rowCount, 0);

  const missingMembership = await withAppTransaction(
    persistence,
    async (client) => {
      // user + household 都设，但该 user 不是成员。
      await setUserContext(client, outsider.user.id);
      await setHouseholdContext(client, householdId);
      return client.query(
        "SELECT id FROM person_profiles WHERE household_id = $1",
        [householdId],
      );
    },
  );
  assert.equal(missingMembership.rowCount, 0);

  // 正向对照：成员 + household 上下文齐全时能看到成员行。
  const present = await withAppTransaction(persistence, async (client) => {
    await setUserContext(client, memberUserId);
    await setHouseholdContext(client, householdId);
    return client.query(
      "SELECT id FROM memberships WHERE household_id = $1 AND id = $2",
      [householdId, memberMembershipId],
    );
  });
  assert.equal(present.rowCount, 1);
});

test("expired invites do not count toward the active-invite cap", async () => {
  const owner = await login("cap-owner");
  const household = await createHousehold(owner, "cap-hh");
  const householdId = household.household.id;

  // 建满 10 个活跃邀请，第 11 个触发上限 409。
  for (let i = 0; i < 10; i += 1) {
    await issueInvite(owner, householdId, `cap-key-${i}`);
  }
  const overCap = await createInvite(owner, householdId, "cap-key-over");
  assert.equal(overCap.statusCode, 409, overCap.body);

  // 把其中一个整体前移到过去：满足 expires_at > created_at 的 CHECK，
  // 同时 expires_at 已早于当前时间（模拟自然过期，状态仍是 active）。
  await persistence.pool.query(
    `UPDATE household_invites
     SET created_at = now() - interval '2 hours',
         expires_at = now() - interval '1 hour'
     WHERE id = (
       SELECT id FROM household_invites
       WHERE household_id = $1
       ORDER BY created_at
       LIMIT 1
     )`,
    [householdId],
  );

  // 过期项不再占坑：可再签发一个新邀请。
  const afterExpiry = await issueInvite(owner, householdId, "cap-key-after");
  assert.equal(afterExpiry.invite.status, "active");
});

test("concurrent profile creation for the same member returns 409, not 500", async () => {
  const owner = await login("pp-race-owner");
  const household = await createHousehold(owner, "pp-race-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "pp-race-inv");
  const member = await login("pp-race-member");
  const joinResult = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "pp-race-join")).json(),
  );
  const membershipId = joinResult.data.membership.id;

  const body = {
    linkedMembershipId: membershipId,
    displayName: "赛跑档案",
    defaultParticipation: true,
    defaultPortionScale: 1,
    cookingSkill: "beginner",
  };
  // 两个不同幂等键、同一 linkedMembershipId 并发：advisory 锁串行化后，
  // 落败者读到已存在返回 409，而不是撞唯一索引变 500。
  const [a, b] = await Promise.all([
    createProfile(member, householdId, "pp-race-a", body),
    createProfile(member, householdId, "pp-race-b", body),
  ]);
  const statuses = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(statuses, [201, 409]);

  const count = await persistence.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM person_profiles
     WHERE household_id = $1 AND linked_membership_id = $2`,
    [householdId, membershipId],
  );
  assert.equal(count.rows[0]?.count, 1);
});

test("membership privilege boundary blocks direct escalation and exposes only controlled transitions", async () => {
  const owner = await login("privilege-owner");
  const household = await createHousehold(owner, "privilege-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "privilege-invite");
  const member = await login("privilege-member");
  const joined = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "privilege-join")).json(),
  ).data.membership;

  await assert.rejects(
    withAppTransaction(persistence, async (client) => {
      await setUserContext(client, member.user.id);
      await setHouseholdContext(client, householdId);
      await client.query(
        "UPDATE memberships SET role = 'owner' WHERE id = $1",
        [joined.id],
      );
    }),
    /permission denied for table memberships/,
  );

  const forbidden = await withAppTransaction(
    persistence,
    async (client) => {
      await setUserContext(client, member.user.id);
      await setHouseholdContext(client, householdId);
      return client.query<{ result_code: string }>(
         `SELECT result_code
         FROM meal_agent_private.transition_membership_status(
           $1::uuid, $2::integer
         )`,
        [household.membership.id, household.membership.version],
      );
    },
  );
  assert.equal(forbidden.rows[0]?.result_code, "forbidden");

  const privileges = await persistence.pool.query<{
    app_table_update: boolean;
    app_function_execute: boolean;
    public_function_execute: boolean;
    app_schema_create: boolean;
    public_schema_create: boolean;
  }>(
    `SELECT
       has_table_privilege(
         'meal_agent_app', 'public.memberships', 'UPDATE'
       ) AS app_table_update,
       has_function_privilege(
         'meal_agent_app',
         'meal_agent_private.transition_membership_status(uuid,integer)',
         'EXECUTE'
       ) AS app_function_execute,
       EXISTS (
         SELECT 1
         FROM pg_proc AS procedure
         CROSS JOIN LATERAL aclexplode(
           COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
         ) AS privilege
         WHERE procedure.oid =
           'meal_agent_private.transition_membership_status(uuid,integer)'::regprocedure
           AND privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
       ) AS public_function_execute,
       has_schema_privilege(
         'meal_agent_app', 'public', 'CREATE'
       ) AS app_schema_create,
       EXISTS (
         SELECT 1
         FROM pg_namespace AS namespace
         CROSS JOIN LATERAL aclexplode(
           COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
         ) AS privilege
         WHERE namespace.oid = 'public'::regnamespace
           AND privilege.grantee = 0
           AND privilege.privilege_type = 'CREATE'
       ) AS public_schema_create`,
  );
  assert.deepEqual(privileges.rows[0], {
    app_table_update: false,
    app_function_execute: true,
    public_function_execute: false,
    app_schema_create: false,
    public_schema_create: false,
  });

  const functionSecurity = await persistence.pool.query<{
    prosecdef: boolean;
    owner: string;
    proconfig: string[];
  }>(
    `SELECT p.prosecdef,
            pg_get_userbyid(p.proowner) AS owner,
            p.proconfig
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'meal_agent_private'
       AND p.proname = 'transition_membership_status'`,
  );
  assert.equal(functionSecurity.rows[0]?.prosecdef, true);
  assert.equal(functionSecurity.rows[0]?.owner, "meal_agent_migrator");
  assert.deepEqual(
    new Set(functionSecurity.rows[0]?.proconfig),
    new Set(["search_path=pg_catalog, public", "row_security=off"]),
  );

  const signatures = await persistence.pool.query<{
    old_redeem_removed: boolean;
    old_transition_removed: boolean;
    old_confirm_removed: boolean;
    app_redeem_execute: boolean;
    app_transition_execute: boolean;
    app_confirm_execute: boolean;
    app_materialize_execute: boolean;
    app_link_create_execute: boolean;
    app_profile_transition_execute: boolean;
    app_constraint_execute: boolean;
    public_execute_count: number;
  }>(
    `SELECT
       to_regprocedure(
         'meal_agent_private.redeem_household_invite(character,uuid,jsonb,timestamptz)'
       ) IS NULL AS old_redeem_removed,
       to_regprocedure(
         'meal_agent_private.transition_membership_status(uuid,integer,timestamptz)'
       ) IS NULL AS old_transition_removed,
       to_regprocedure(
         'meal_agent_private.confirm_person_profile_link(uuid,integer,timestamptz)'
       ) IS NULL AS old_confirm_removed,
       has_function_privilege(
         'meal_agent_app',
         'meal_agent_private.redeem_household_invite(character,uuid)',
         'EXECUTE'
       ) AS app_redeem_execute,
       has_function_privilege(
         'meal_agent_app',
         'meal_agent_private.transition_membership_status(uuid,integer)',
         'EXECUTE'
       ) AS app_transition_execute,
       has_function_privilege(
         'meal_agent_app',
         'meal_agent_private.confirm_person_profile_link(uuid,integer)',
         'EXECUTE'
       ) AS app_confirm_execute,
       has_function_privilege(
         'meal_agent_app',
         'meal_agent_private.materialize_person_profile_link_requests(uuid,uuid,uuid)',
         'EXECUTE'
       ) AS app_materialize_execute,
       has_function_privilege(
         'meal_agent_app',
         'meal_agent_private.create_person_profile_link_request(uuid,uuid,uuid,integer)',
         'EXECUTE'
       ) AS app_link_create_execute,
       has_function_privilege(
         'meal_agent_app',
         'meal_agent_private.transition_person_profile_status(uuid,integer,text)',
         'EXECUTE'
       ) AS app_profile_transition_execute,
       has_function_privilege(
         'meal_agent_app',
         'meal_agent_private.add_person_profile_constraint(uuid,integer,uuid,jsonb,boolean)',
         'EXECUTE'
       ) AS app_constraint_execute,
       (
         SELECT count(*)::int
         FROM pg_proc AS procedure
         JOIN pg_namespace AS namespace
           ON namespace.oid = procedure.pronamespace
         CROSS JOIN LATERAL aclexplode(
           COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
         ) AS privilege
         WHERE namespace.nspname = 'meal_agent_private'
           AND procedure.proname IN (
             'redeem_household_invite',
             'transition_membership_status',
             'confirm_person_profile_link',
             'materialize_person_profile_link_requests',
             'create_person_profile_link_request',
             'transition_person_profile_status',
             'add_person_profile_constraint'
           )
           AND privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
       ) AS public_execute_count`,
  );
  assert.deepEqual(signatures.rows[0], {
    old_redeem_removed: true,
    old_transition_removed: true,
    old_confirm_removed: true,
    app_redeem_execute: true,
    app_transition_execute: true,
    app_confirm_execute: true,
    app_materialize_execute: true,
    app_link_create_execute: true,
    app_profile_transition_execute: true,
    app_constraint_execute: true,
    public_execute_count: 0,
  });

  const nullVersion = await withAppTransaction(
    persistence,
    async (client) => {
      await setUserContext(client, owner.user.id);
      await setHouseholdContext(client, householdId);
      return client.query<{ result_code: string }>(
        `SELECT result_code
         FROM meal_agent_private.transition_membership_status(
           $1::uuid, NULL::integer
         )`,
        [joined.id],
      );
    },
  );
  assert.equal(
    nullVersion.rows[0]?.result_code,
    "invalid_expected_version",
  );
});

test("app-role PersonProfile SQL cannot bypass ownership, initial-state, identity, or confirmation rules", async () => {
  const owner = await login("profile-sql-owner");
  const household = await createHousehold(owner, "profile-sql-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "profile-sql-invite");
  const member = await login("profile-sql-member");
  const membership = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "profile-sql-join")).json(),
  ).data.membership;

  const directInsert = (
    linkedMembershipId: string | null,
    status: "active" | "archived",
    version: number,
    constraints: unknown[],
  ) =>
    withAppTransaction(persistence, async (client) => {
      await setUserContext(client, member.user.id);
      await setHouseholdContext(client, householdId);
      return client.query(
        `INSERT INTO person_profiles (
           id, household_id, linked_membership_id, display_name, status,
           default_participation, default_portion_scale, cooking_skill,
           dietary_constraints, created_at, updated_at, version
         ) VALUES (
           $1, $2, $3, '直接 SQL 档案', $4, NULL, NULL, NULL, $5::jsonb,
           clock_timestamp(), clock_timestamp(), $6
         )`,
        [
          randomUUID(),
          householdId,
          linkedMembershipId,
          status,
          JSON.stringify(constraints),
          version,
        ],
      );
    });

  await assert.rejects(
    directInsert(null, "active", 0, []),
    /row-level security policy/,
  );
  await assert.rejects(
    directInsert(household.membership.id, "active", 0, []),
    /row-level security policy/,
  );
  await assert.rejects(
    directInsert(membership.id, "archived", 0, []),
    /row-level security policy/,
  );
  await assert.rejects(
    directInsert(membership.id, "active", 1, []),
    /row-level security policy/,
  );
  await assert.rejects(
    directInsert(membership.id, "active", 0, [
      {
        id: randomUUID(),
        kind: "religious",
        enforcement: "hard",
        label: "绕过确认",
        foodConceptIds: [],
        allergenCodes: [],
        mappingStatus: "needs_structured_mapping",
        visibility: "household",
        confirmedAt: new Date().toISOString(),
        confirmedByUserId: member.user.id,
      },
    ]),
    /row-level security policy/,
  );

  const created = await createProfile(
    member,
    householdId,
    "profile-sql-own",
    {
      linkedMembershipId: membership.id,
      displayName: "本人档案",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  assert.equal(created.statusCode, 201, created.body);
  const profileId =
    personProfileMutationSuccessSchema.parse(created.json()).data.profileId;

  await assert.rejects(
    withAppTransaction(persistence, async (client) => {
      await setUserContext(client, member.user.id);
      await setHouseholdContext(client, householdId);
      await client.query(
        `UPDATE person_profiles
         SET linked_membership_id = $1, household_id = $2
         WHERE id = $3`,
        [household.membership.id, householdId, profileId],
      );
    }),
    /permission denied for table person_profiles/,
  );

  const unconfirmed = await withAppTransaction(
    persistence,
    async (client) => {
      await setUserContext(client, member.user.id);
      await setHouseholdContext(client, householdId);
      return client.query<{ result_code: string }>(
        `SELECT result_code
         FROM meal_agent_private.add_person_profile_constraint(
           $1::uuid, 0, $2::uuid, $3::jsonb, false
         )`,
        [
          profileId,
          uuidv7(),
          JSON.stringify({
            kind: "religious",
            enforcement: "hard",
            label: "未确认宗教约束",
            foodConceptIds: [],
            allergenCodes: [],
            visibility: "household",
          }),
        ],
      );
    },
  );
  assert.equal(unconfirmed.rows[0]?.result_code, "confirmation_required");

  const validConstraintShape = {
    kind: "allergy",
    enforcement: "hard",
    label: "反向测试约束",
    foodConceptIds: [],
    allergenCodes: [],
    visibility: "household",
  };
  const duplicateFoodConceptId = uuidv7();
  const malformedConstraints = [
    {
      id: uuidv7(),
      input: {
        ...validConstraintShape,
        label: "错误 foodConcept",
        foodConceptIds: [123],
      },
    },
    {
      id: uuidv7(),
      input: {
        ...validConstraintShape,
        label: "错误 allergen",
        allergenCodes: [{}],
      },
    },
    {
      id: uuidv7(),
      input: {
        ...validConstraintShape,
        label: "错误 notes null",
        notes: null,
      },
    },
    {
      id: uuidv7(),
      input: {
        ...validConstraintShape,
        label: "错误 notes 超长",
        notes: "x".repeat(501),
      },
    },
    { id: randomUUID(), input: validConstraintShape },
    {
      id: "00000000-0000-0000-0000-000000000000",
      input: validConstraintShape,
    },
    {
      id: uuidv7(),
      input: {
        ...validConstraintShape,
        foodConceptIds: [
          duplicateFoodConceptId,
          duplicateFoodConceptId,
        ],
      },
    },
    {
      id: uuidv7(),
      input: {
        ...validConstraintShape,
        foodConceptIds: [uuidv7().toUpperCase()],
      },
    },
    {
      id: uuidv7(),
      input: {
        ...validConstraintShape,
        foodConceptIds: Array.from({ length: 101 }, () => uuidv7()),
      },
    },
    {
      id: uuidv7(),
      input: {
        ...validConstraintShape,
        allergenCodes: ["X-CODE", "X-CODE"],
      },
    },
    {
      id: uuidv7(),
      input: {
        ...validConstraintShape,
        allergenCodes: Array.from(
          { length: 101 },
          (_, item) => `CODE-${item}`,
        ),
      },
    },
  ];
  for (const [index, malformed] of malformedConstraints.entries()) {
    const rejected = await withAppTransaction(
      persistence,
      async (client) => {
        await setUserContext(client, member.user.id);
        await setHouseholdContext(client, householdId);
        return client.query<{ result_code: string }>(
          `SELECT result_code
           FROM meal_agent_private.add_person_profile_constraint(
             $1::uuid, 0, $2::uuid, $3::jsonb, true
           )`,
          [profileId, malformed.id, JSON.stringify(malformed.input)],
        );
      },
    );
    assert.equal(
      rejected.rows[0]?.result_code,
      "invalid_constraint",
      `malformed constraint ${index} must fail closed`,
    );
    const unchanged = await persistence.pool.query<{
      version: number;
      dietary_constraints: unknown[];
    }>(
      `SELECT version, dietary_constraints
       FROM person_profiles WHERE id = $1`,
      [profileId],
    );
    assert.deepEqual(unchanged.rows[0], {
      version: 0,
      dietary_constraints: [],
    });
  }

  const dining = await createProfile(
    owner,
    householdId,
    "profile-sql-dining",
    {
      displayName: "仅用餐档案",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  const diningId =
    personProfileMutationSuccessSchema.parse(dining.json()).data.profileId;
  await assert.rejects(
    withAppTransaction(persistence, async (client) => {
      await setUserContext(client, member.user.id);
      await setHouseholdContext(client, householdId);
      await client.query(
        `INSERT INTO person_profile_link_requests (
           id, household_id, profile_id, target_membership_id,
           initiated_by_user_id, status, created_at, expires_at,
           confirmed_at, terminal_reason, disclosure_status,
           disclosure_version,
           profile_version_at_request, disclosed_profile_name,
           disclosed_household_hard_count, disclosed_household_soft_count,
           disclosed_private_constraint_count, version
         ) VALUES (
           $1, $2, $3, $4, $5, 'pending', clock_timestamp(),
           clock_timestamp() + interval '1 hour', NULL, NULL,
           'available', 1, 0, '越权关联', 0, 0, 0, 0
         )`,
        [
          randomUUID(),
          householdId,
          diningId,
          membership.id,
          member.user.id,
        ],
      );
    }),
    /permission denied for table person_profile_link_requests/,
  );

  const privileges = await persistence.pool.query<{
    app_update: boolean;
    app_insert: boolean;
    app_link_insert: boolean;
  }>(
    `SELECT
       has_table_privilege(
         'meal_agent_app', 'public.person_profiles', 'UPDATE'
       ) AS app_update,
       has_table_privilege(
         'meal_agent_app', 'public.person_profiles', 'INSERT'
       ) AS app_insert,
       has_table_privilege(
         'meal_agent_app', 'public.person_profile_link_requests', 'INSERT'
       ) AS app_link_insert`,
  );
  assert.deepEqual(privileges.rows[0], {
    app_update: false,
    app_insert: true,
    app_link_insert: false,
  });
});

test("self-exit replays after a lost response and leaves exactly one completed idempotency record", async () => {
  const owner = await login("lost-exit-owner");
  const household = await createHousehold(owner, "lost-exit-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "lost-exit-invite");
  const member = await login("lost-exit-member");
  const joined = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "lost-exit-join")).json(),
  ).data.membership;
  const key = "lost-exit-command";
  const request = {
    method: "DELETE" as const,
    url: `/api/v1/households/${householdId}/memberships/${joined.id}`,
    headers: idempotent(member, key),
  };

  // 第一次响应被调用方丢弃；数据库事务已经提交。
  const lostResponse = await app.inject(request);
  assert.equal(lostResponse.statusCode, 200, lostResponse.body);

  // 相同会话已经没有 active membership；replay 必须发生在 bootstrap 之前。
  const replay = await app.inject(request);
  assert.equal(replay.statusCode, 200, replay.body);
  const firstBody = removeMembershipSuccessSchema.parse(
    lostResponse.json(),
  );
  const replayBody = removeMembershipSuccessSchema.parse(replay.json());
  const firstIdempotency = firstBody.meta.idempotency;
  const replayIdempotency = replayBody.meta.idempotency;
  assert.ok(firstIdempotency);
  assert.ok(replayIdempotency);
  assert.deepEqual(replayBody.data, firstBody.data);
  assert.equal(replayIdempotency.replayed, true);
  assert.equal(
    replayIdempotency.originalRequestId,
    firstIdempotency.originalRequestId,
  );

  const records = await persistence.pool.query<{
    count: number;
    incomplete: number;
  }>(
    `SELECT count(*)::int AS count,
            count(*) FILTER (
              WHERE status_code IS NULL OR response_body IS NULL
            )::int AS incomplete
     FROM idempotency_records
     WHERE user_id = $1
       AND household_id = $2
       AND normalized_route =
         '/api/v1/households/{id}/memberships/{membershipId}'
       AND idempotency_key = $3`,
    [member.user.id, householdId, normalizeKey(key)],
  );
  assert.deepEqual(records.rows[0], { count: 1, incomplete: 0 });
});

test("membership removal archives the linked profile; rejoin requires explicit restore of the same id", async () => {
  const owner = await login("lifecycle-owner");
  const household = await createHousehold(owner, "lifecycle-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "lifecycle-invite");
  const member = await login("lifecycle-member");
  const joined = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "lifecycle-join")).json(),
  ).data.membership;
  const created = await createProfile(
    member,
    householdId,
    "lifecycle-profile",
    {
      linkedMembershipId: joined.id,
      displayName: "生命周期成员",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  const profileReceipt =
    personProfileMutationSuccessSchema.parse(created.json()).data;
  const privateAdd = await addConstraint(
    member,
    householdId,
    profileReceipt.profileId,
    "lifecycle-constraint",
    privateHardConstraint("虚构私密忌口"),
  );
  assert.equal(privateAdd.statusCode, 201, privateAdd.body);

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/v1/households/${householdId}/memberships/${joined.id}`,
    headers: idempotent(owner, "lifecycle-remove"),
  });
  assert.equal(removed.statusCode, 200, removed.body);

  const archived = await persistence.pool.query<{
    id: string;
    status: string;
    linked_membership_id: string | null;
    version: number;
  }>(
    `SELECT id, status, linked_membership_id, version
     FROM person_profiles WHERE id = $1`,
    [profileReceipt.profileId],
  );
  assert.deepEqual(archived.rows[0], {
    id: profileReceipt.profileId,
    status: "archived",
    linked_membership_id: joined.id,
    version: 2,
  });

  const ownerCannotBypassLink = await createProfile(
    owner,
    householdId,
    "lifecycle-duplicate",
    {
      linkedMembershipId: joined.id,
      displayName: "错误复制",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  assert.equal(ownerCannotBypassLink.statusCode, 403);

  const secondInvite = await issueInvite(
    owner,
    householdId,
    "lifecycle-rejoin-invite",
  );
  const rejoined = await join(
    member,
    secondInvite.inviteCode,
    "lifecycle-rejoin",
  );
  assert.equal(rejoined.statusCode, 201, rejoined.body);

  const duplicate = await createProfile(
    member,
    householdId,
    "lifecycle-duplicate-after-rejoin",
    {
      linkedMembershipId: joined.id,
      displayName: "错误复制",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  assert.equal(duplicate.statusCode, 409);

  const listArchived = listPersonProfilesSuccessSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: `/api/v1/households/${householdId}/person-profiles?status=archived`,
        headers: authHeaders(member),
      })
    ).json(),
  ).data;
  assert.equal(listArchived.viewerRole, "member");
  if (listArchived.viewerRole !== "member") return;
  assert.equal(listArchived.self?.id, profileReceipt.profileId);

  const restored = await app.inject({
    method: "PATCH",
    url:
      `/api/v1/households/${householdId}` +
      `/person-profiles/${profileReceipt.profileId}`,
    headers: idempotent(member, "lifecycle-restore"),
    payload: { operation: "restore", expectedVersion: 2 },
  });
  assert.equal(restored.statusCode, 200, restored.body);
  const restoredProfile = await getProfile(
    member,
    householdId,
    profileReceipt.profileId,
  );
  assert.equal(restoredProfile.id, profileReceipt.profileId);
  assert.equal(restoredProfile.status, "active");
  assert.equal(restoredProfile.dietaryConstraints.length, 1);
});

test("dining-only profile link requires owner initiation and target-member confirmation", async () => {
  const owner = await login("link-owner");
  const household = await createHousehold(owner, "link-hh");
  const householdId = household.household.id;
  const dining = await createProfile(owner, householdId, "link-dining", {
    displayName: "仅用餐成员",
    defaultParticipation: null,
    defaultPortionScale: null,
    cookingSkill: null,
  });
  const diningReceipt =
    personProfileMutationSuccessSchema.parse(dining.json()).data;
  const invite = await issueInvite(owner, householdId, "link-invite");
  const member = await login("link-member");
  const joined = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "link-join")).json(),
  ).data.membership;

  const requested = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profiles/` +
      `${diningReceipt.profileId}/link-requests`,
    headers: idempotent(owner, "link-request"),
    payload: {
      targetMembershipId: joined.id,
      expiresInHours: 24,
      ownerConfirmation: { acknowledged: true },
    },
  });
  assert.equal(requested.statusCode, 201, requested.body);
  const linkRequest =
    personProfileLinkRequestSuccessSchema.parse(requested.json()).data.request;

  const nullExpectedVersion = await withAppTransaction(
    persistence,
    async (client) => {
      await setUserContext(client, member.user.id);
      await setHouseholdContext(client, householdId);
      return client.query<{ result_code: string }>(
        `SELECT result_code
         FROM meal_agent_private.confirm_person_profile_link(
           $1::uuid, NULL::integer
         )`,
        [linkRequest.id],
      );
    },
  );
  assert.equal(
    nullExpectedVersion.rows[0]?.result_code,
    "invalid_expected_version",
  );

  const ownerCannotConfirm = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profile-link-requests/` +
      `${linkRequest.id}/confirm`,
    headers: idempotent(owner, "link-owner-confirm"),
    payload: {
      expectedVersion: linkRequest.version,
      subjectConfirmation: { acknowledged: true },
    },
  });
  assert.equal(ownerCannotConfirm.statusCode, 403);

  const staleVersion = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profile-link-requests/` +
      `${linkRequest.id}/confirm`,
    headers: idempotent(member, "link-member-stale-confirm"),
    payload: {
      expectedVersion: linkRequest.version + 1,
      subjectConfirmation: { acknowledged: true },
    },
  });
  assert.equal(staleVersion.statusCode, 409, staleVersion.body);
  const stillPending = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
  }>(
    `SELECT status, terminal_reason
     FROM person_profile_link_requests WHERE id = $1`,
    [linkRequest.id],
  );
  assert.deepEqual(stillPending.rows[0], {
    status: "pending",
    terminal_reason: null,
  });

  const confirmed = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profile-link-requests/` +
      `${linkRequest.id}/confirm`,
    headers: idempotent(member, "link-member-confirm"),
    payload: {
      expectedVersion: linkRequest.version,
      subjectConfirmation: { acknowledged: true },
    },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const linkResult =
    confirmPersonProfileLinkSuccessSchema.parse(confirmed.json()).data;
  assert.equal(linkResult.receipt.profileId, diningReceipt.profileId);
  const linked = await getProfile(member, householdId, diningReceipt.profileId);
  assert.equal(linked.linkedMembershipId, joined.id);
});

test("link disclosure is snapshotted and profile changes commit profile_changed before HTTP 409", async () => {
  const owner = await login("link-disclosure-owner");
  const household = await createHousehold(owner, "link-disclosure-hh");
  const householdId = household.household.id;
  const dining = await createProfile(
    owner,
    householdId,
    "link-disclosure-profile",
    {
      displayName: "披露时名称",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  const profileId =
    personProfileMutationSuccessSchema.parse(dining.json()).data.profileId;
  const invite = await issueInvite(
    owner,
    householdId,
    "link-disclosure-invite",
  );
  const member = await login("link-disclosure-member");
  const membership = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "link-disclosure-join")).json(),
  ).data.membership;
  const requested = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profiles/` +
      `${profileId}/link-requests`,
    headers: idempotent(owner, "link-disclosure-request"),
    payload: {
      targetMembershipId: membership.id,
      expiresInHours: 24,
      ownerConfirmation: { acknowledged: true },
    },
  });
  assert.equal(requested.statusCode, 201, requested.body);
  const linkRequest =
    personProfileLinkRequestSuccessSchema.parse(requested.json()).data.request;
  assert.deepEqual(linkRequest.disclosure, {
    availability: "available",
    disclosureVersion: 1,
    profileVersion: 0,
    profileDisplayName: "披露时名称",
    householdVisibleHardConstraintCount: 0,
    householdVisibleSoftConstraintCount: 0,
    privateConstraintCount: 0,
    subjectWillGainProfileAccess: true,
    membershipExitArchivesProfile: true,
    rejoinRestoresAutomatically: false,
    privateConstraintContentsRemainPrivate: true,
  });

  const renamed = await app.inject({
    method: "PATCH",
    url:
      `/api/v1/households/${householdId}/person-profiles/${profileId}`,
    headers: idempotent(owner, "link-disclosure-rename"),
    payload: {
      operation: "update",
      expectedVersion: 0,
      displayName: "确认前新名称",
    },
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  const privateFields = {
    kind: "allergy" as const,
    enforcement: "hard" as const,
    label: "仅自然语言登记的私密过敏",
    foodConceptIds: [],
    allergenCodes: [],
    visibility: "subject_and_owner" as const,
  };
  const privateAdded = await addConstraint(
    owner,
    householdId,
    profileId,
    "link-disclosure-private",
    {
      expectedVersion: 1,
      constraint: {
        ...privateFields,
        confirmation: {
          acknowledged: true,
          fingerprint:
            hardConstraintConfirmationFingerprint(privateFields),
        },
      },
    },
  );
  assert.equal(privateAdded.statusCode, 201, privateAdded.body);

  const confirmKey = "link-disclosure-confirm";
  const confirmed = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profile-link-requests/` +
      `${linkRequest.id}/confirm`,
    headers: idempotent(member, confirmKey),
    payload: {
      expectedVersion: linkRequest.version,
      subjectConfirmation: { acknowledged: true },
    },
  });
  assert.equal(confirmed.statusCode, 409, confirmed.body);
  const raw = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
    profile_version_at_request: number;
    disclosed_profile_name: string;
    disclosed_private_constraint_count: number;
  }>(
    `SELECT status, terminal_reason, profile_version_at_request,
            disclosed_profile_name, disclosed_private_constraint_count
     FROM person_profile_link_requests WHERE id = $1`,
    [linkRequest.id],
  );
  assert.deepEqual(raw.rows[0], {
    status: "cancelled",
    terminal_reason: "profile_changed",
    profile_version_at_request: 0,
    disclosed_profile_name: "披露时名称",
    disclosed_private_constraint_count: 0,
  });
  const replayedConflict = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profile-link-requests/` +
      `${linkRequest.id}/confirm`,
    headers: idempotent(member, confirmKey),
    payload: {
      expectedVersion: linkRequest.version,
      subjectConfirmation: { acknowledged: true },
    },
  });
  assert.equal(replayedConflict.statusCode, 409, replayedConflict.body);
  const completedFailure = await persistence.pool.query<{
    status_code: number | null;
    response_ok: string | null;
    error_code: string | null;
  }>(
    `SELECT status_code,
            response_body->>'ok' AS response_ok,
            response_body->'error'->>'code' AS error_code
     FROM idempotency_records
     WHERE normalized_route =
       '/api/v1/households/{id}/person-profile-link-requests/{requestId}/confirm'
       AND idempotency_key = $1`,
    [normalizeKey(confirmKey)],
  );
  assert.equal(completedFailure.rowCount, 1);
  assert.deepEqual(completedFailure.rows[0], {
    status_code: 409,
    response_ok: "false",
    error_code: "CONFLICT",
  });
});

test("self-created linked profile immediately terminalizes every pending request for the target", async () => {
  const owner = await login("link-self-owner");
  const household = await createHousehold(owner, "link-self-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "link-self-invite");
  const member = await login("link-self-member");
  const membership = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "link-self-join")).json(),
  ).data.membership;
  const dining = await createProfile(owner, householdId, "link-self-dining", {
    displayName: "待关联档案",
    defaultParticipation: null,
    defaultPortionScale: null,
    cookingSkill: null,
  });
  const profileId =
    personProfileMutationSuccessSchema.parse(dining.json()).data.profileId;
  const requested = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profiles/` +
      `${profileId}/link-requests`,
    headers: idempotent(owner, "link-self-request"),
    payload: {
      targetMembershipId: membership.id,
      expiresInHours: 24,
      ownerConfirmation: { acknowledged: true },
    },
  });
  const request =
    personProfileLinkRequestSuccessSchema.parse(requested.json()).data.request;

  const created = await createProfile(
    member,
    householdId,
    "link-self-create",
    {
      linkedMembershipId: membership.id,
      displayName: "成员自建档案",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  assert.equal(created.statusCode, 201, created.body);
  const raw = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
  }>(
    `SELECT status, terminal_reason
     FROM person_profile_link_requests WHERE id = $1`,
    [request.id],
  );
  assert.deepEqual(raw.rows[0], {
    status: "cancelled",
    terminal_reason: "target_membership_has_profile",
  });
});

test("linked profile creation racing link confirmation yields one success and one 409", async () => {
  const owner = await login("link-race-owner");
  const household = await createHousehold(owner, "link-race-hh");
  const householdId = household.household.id;
  const dining = await createProfile(owner, householdId, "link-race-dining", {
    displayName: "待关联档案",
    defaultParticipation: null,
    defaultPortionScale: null,
    cookingSkill: null,
  });
  const diningId =
    personProfileMutationSuccessSchema.parse(dining.json()).data.profileId;
  const invite = await issueInvite(owner, householdId, "link-race-invite");
  const member = await login("link-race-member");
  const membership = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "link-race-join")).json(),
  ).data.membership;
  const requested = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profiles/` +
      `${diningId}/link-requests`,
    headers: idempotent(owner, "link-race-request"),
    payload: {
      targetMembershipId: membership.id,
      expiresInHours: 24,
      ownerConfirmation: { acknowledged: true },
    },
  });
  const linkRequest =
    personProfileLinkRequestSuccessSchema.parse(requested.json()).data.request;

  const [created, confirmed] = await Promise.all([
    createProfile(member, householdId, "link-race-create", {
      linkedMembershipId: membership.id,
      displayName: "成员自建档案",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    }),
    app.inject({
      method: "POST",
      url:
        `/api/v1/households/${householdId}/person-profile-link-requests/` +
        `${linkRequest.id}/confirm`,
      headers: idempotent(member, "link-race-confirm"),
      payload: {
        expectedVersion: linkRequest.version,
        subjectConfirmation: { acknowledged: true },
      },
    }),
  ]);
  assert.equal(created.statusCode === 500, false, created.body);
  assert.equal(confirmed.statusCode === 500, false, confirmed.body);
  assert.equal(
    [created.statusCode, confirmed.statusCode].filter(
      (status) => status >= 200 && status < 300,
    ).length,
    1,
  );
  assert.equal(
    [created.statusCode, confirmed.statusCode].filter(
      (status) => status === 409,
    ).length,
    1,
  );

  const linked = await persistence.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM person_profiles
     WHERE household_id = $1 AND linked_membership_id = $2`,
    [householdId, membership.id],
  );
  assert.equal(linked.rows[0]?.count, 1);
  const terminal = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
  }>(
    `SELECT status, terminal_reason
     FROM person_profile_link_requests WHERE id = $1`,
    [linkRequest.id],
  );
  assert.equal(
    terminal.rows[0]?.status === "accepted" ||
      (terminal.rows[0]?.status === "cancelled" &&
        terminal.rows[0]?.terminal_reason ===
          "target_membership_has_profile"),
    true,
  );
});

test("profile link requests materialize duplicate, expiry, member-exit, and profile-archive terminal states", async () => {
  const owner = await login("link-life-owner");
  const household = await createHousehold(owner, "link-life-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "link-life-invite");
  const member = await login("link-life-member");
  const membership = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "link-life-join")).json(),
  ).data.membership;
  const dining = await createProfile(owner, householdId, "link-life-profile", {
    displayName: "关联生命周期档案",
    defaultParticipation: null,
    defaultPortionScale: null,
    cookingSkill: null,
  });
  const diningId =
    personProfileMutationSuccessSchema.parse(dining.json()).data.profileId;
  const requestLink = (key: string, profileId = diningId) =>
    app.inject({
      method: "POST",
      url:
        `/api/v1/households/${householdId}/person-profiles/` +
        `${profileId}/link-requests`,
      headers: idempotent(owner, key),
      payload: {
        targetMembershipId: membership.id,
        expiresInHours: 24,
        ownerConfirmation: { acknowledged: true },
      },
    });

  const first = await requestLink("link-life-first");
  assert.equal(first.statusCode, 201, first.body);
  const firstId =
    personProfileLinkRequestSuccessSchema.parse(first.json()).data.request.id;
  const duplicate = await requestLink("link-life-duplicate");
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  const duplicateRaw = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
  }>(
    `SELECT status, terminal_reason
     FROM person_profile_link_requests WHERE id = $1`,
    [firstId],
  );
  assert.deepEqual(duplicateRaw.rows[0], {
    status: "pending",
    terminal_reason: null,
  });

  await persistence.pool.query(
    `UPDATE person_profile_link_requests
     SET created_at = clock_timestamp() - interval '2 hours',
         expires_at = clock_timestamp() - interval '1 hour'
     WHERE id = $1`,
    [firstId],
  );
  const expiredConfirm = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profile-link-requests/` +
      `${firstId}/confirm`,
    headers: idempotent(member, "link-life-expired-confirm"),
    payload: {
      expectedVersion: 0,
      subjectConfirmation: { acknowledged: true },
    },
  });
  assert.equal(expiredConfirm.statusCode, 409, expiredConfirm.body);
  const rebuilt = await requestLink("link-life-rebuilt");
  assert.equal(rebuilt.statusCode, 201, rebuilt.body);
  const rebuiltId =
    personProfileLinkRequestSuccessSchema.parse(rebuilt.json()).data.request.id;
  const expired = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
  }>(
    `SELECT status, terminal_reason
     FROM person_profile_link_requests WHERE id = $1`,
    [firstId],
  );
  assert.deepEqual(expired.rows[0], {
    status: "expired",
    terminal_reason: "expired",
  });

  const left = await app.inject({
    method: "DELETE",
    url: `/api/v1/households/${householdId}/memberships/${membership.id}`,
    headers: idempotent(member, "link-life-exit"),
  });
  assert.equal(left.statusCode, 200, left.body);
  const cancelledForExit = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
  }>(
    `SELECT status, terminal_reason
     FROM person_profile_link_requests WHERE id = $1`,
    [rebuiltId],
  );
  assert.deepEqual(cancelledForExit.rows[0], {
    status: "cancelled",
    terminal_reason: "target_membership_inactive",
  });

  const rejoinInvite = await issueInvite(
    owner,
    householdId,
    "link-life-rejoin-invite",
  );
  const rejoined = await join(
    member,
    rejoinInvite.inviteCode,
    "link-life-rejoin",
  );
  assert.equal(rejoined.statusCode, 201, rejoined.body);
  const secondDining = await createProfile(
    owner,
    householdId,
    "link-life-second-profile",
    {
      displayName: "将归档档案",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  const secondDiningId =
    personProfileMutationSuccessSchema.parse(secondDining.json()).data.profileId;
  const beforeArchive = await requestLink(
    "link-life-before-archive",
    secondDiningId,
  );
  assert.equal(beforeArchive.statusCode, 201, beforeArchive.body);
  const beforeArchiveId =
    personProfileLinkRequestSuccessSchema.parse(
      beforeArchive.json(),
    ).data.request.id;
  const archived = await app.inject({
    method: "PATCH",
    url:
      `/api/v1/households/${householdId}/person-profiles/` +
      `${secondDiningId}`,
    headers: idempotent(owner, "link-life-archive"),
    payload: { operation: "archive", expectedVersion: 0 },
  });
  assert.equal(archived.statusCode, 200, archived.body);
  const cancelledForArchive = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
  }>(
    `SELECT status, terminal_reason
     FROM person_profile_link_requests WHERE id = $1`,
    [beforeArchiveId],
  );
  assert.deepEqual(cancelledForArchive.rows[0], {
    status: "cancelled",
    terminal_reason: "profile_unavailable",
  });
});

test("an expired T1 request is materialized before the same profile is reissued to T2", async () => {
  const owner = await login("link-retarget-owner");
  const household = await createHousehold(owner, "link-retarget-hh");
  const householdId = household.household.id;
  const dining = await createProfile(
    owner,
    householdId,
    "link-retarget-profile",
    {
      displayName: "改发目标档案",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  const profileId =
    personProfileMutationSuccessSchema.parse(dining.json()).data.profileId;
  const joinTarget = async (suffix: string) => {
    const invite = await issueInvite(
      owner,
      householdId,
      `link-retarget-invite-${suffix}`,
    );
    const member = await login(`link-retarget-member-${suffix}`);
    const joined = await join(
      member,
      invite.inviteCode,
      `link-retarget-join-${suffix}`,
    );
    return joinHouseholdSuccessSchema.parse(joined.json()).data.membership;
  };
  const targetOne = await joinTarget("one");
  const targetTwo = await joinTarget("two");
  const requestFor = (targetMembershipId: string, key: string) =>
    app.inject({
      method: "POST",
      url:
        `/api/v1/households/${householdId}/person-profiles/` +
        `${profileId}/link-requests`,
      headers: idempotent(owner, key),
      payload: {
        targetMembershipId,
        expiresInHours: 24,
        ownerConfirmation: { acknowledged: true },
      },
    });

  const first = await requestFor(targetOne.id, "link-retarget-first");
  assert.equal(first.statusCode, 201, first.body);
  const firstId =
    personProfileLinkRequestSuccessSchema.parse(first.json()).data.request.id;
  await persistence.pool.query(
    `UPDATE person_profile_link_requests
     SET created_at = clock_timestamp() - interval '2 hours',
         expires_at = clock_timestamp() - interval '1 hour'
     WHERE id = $1`,
    [firstId],
  );
  const second = await requestFor(targetTwo.id, "link-retarget-second");
  assert.equal(second.statusCode, 201, second.body);
  const raw = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
  }>(
    `SELECT status, terminal_reason
     FROM person_profile_link_requests WHERE id = $1`,
    [firstId],
  );
  assert.deepEqual(raw.rows[0], {
    status: "expired",
    terminal_reason: "expired",
  });
});

test("link confirmation crossing expires_at while waiting on the household advisory can only expire", { timeout: 10_000 }, async () => {
  const owner = await login("link-expiry-barrier-owner");
  const household = await createHousehold(
    owner,
    "link-expiry-barrier-household",
  );
  const householdId = household.household.id;
  const invite = await issueInvite(
    owner,
    householdId,
    "link-expiry-barrier-invite",
  );
  const member = await login("link-expiry-barrier-member");
  const membership = joinHouseholdSuccessSchema.parse(
    (
      await join(
        member,
        invite.inviteCode,
        "link-expiry-barrier-join",
      )
    ).json(),
  ).data.membership;
  const profile = await createProfile(
    owner,
    householdId,
    "link-expiry-barrier-profile",
    {
      displayName: "过期屏障档案",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  const profileId =
    personProfileMutationSuccessSchema.parse(profile.json()).data.profileId;
  const requested = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profiles/` +
      `${profileId}/link-requests`,
    headers: idempotent(owner, "link-expiry-barrier-request"),
    payload: {
      targetMembershipId: membership.id,
      expiresInHours: 24,
      ownerConfirmation: { acknowledged: true },
    },
  });
  const request =
    personProfileLinkRequestSuccessSchema.parse(requested.json()).data.request;

  const blocker = await persistence.pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'person-profile-links:' || $1::text,
           0
         )
       )`,
      [householdId],
    );
    await blocker.query(
      `UPDATE person_profile_link_requests
       SET expires_at = clock_timestamp() + interval '250 milliseconds'
       WHERE id = $1`,
      [request.id],
    );
    const confirmation = app.inject({
      method: "POST",
      url:
        `/api/v1/households/${householdId}` +
        `/person-profile-link-requests/${request.id}/confirm`,
      headers: idempotent(member, "link-expiry-barrier-confirm"),
      payload: {
        expectedVersion: request.version,
        subjectConfirmation: { acknowledged: true },
      },
    });
    await waitForAdvisoryWaiters(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await blocker.query("COMMIT");
    const response = await confirmation;
    assert.equal(response.statusCode, 409, response.body);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }

  const raw = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
    expired: boolean;
  }>(
    `SELECT status, terminal_reason,
            expires_at <= clock_timestamp() AS expired
     FROM person_profile_link_requests
     WHERE id = $1`,
    [request.id],
  );
  assert.deepEqual(raw.rows[0], {
    status: "expired",
    terminal_reason: "expired",
    expired: true,
  });
});

test("controlled link creation rejects inactive targets and confirm revalidates activity", async () => {
  const owner = await login("link-inactive-owner");
  const household = await createHousehold(owner, "link-inactive-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(
    owner,
    householdId,
    "link-inactive-invite",
  );
  const member = await login("link-inactive-member");
  const membership = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "link-inactive-join")).json(),
  ).data.membership;
  const dining = await createProfile(
    owner,
    householdId,
    "link-inactive-profile",
    {
      displayName: "失效目标档案",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  const profileId =
    personProfileMutationSuccessSchema.parse(dining.json()).data.profileId;
  const requested = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profiles/` +
      `${profileId}/link-requests`,
    headers: idempotent(owner, "link-inactive-request"),
    payload: {
      targetMembershipId: membership.id,
      expiresInHours: 24,
      ownerConfirmation: { acknowledged: true },
    },
  });
  assert.equal(requested.statusCode, 201, requested.body);
  const linkRequest =
    personProfileLinkRequestSuccessSchema.parse(requested.json()).data.request;

  // 模拟 bootstrap 与 confirm 之间目标失效；函数必须在同一锁内再次验证。
  await persistence.pool.query(
    `UPDATE memberships
     SET status = 'removed', version = version + 1
     WHERE id = $1`,
    [membership.id],
  );
  const confirm = await withAppTransaction(
    persistence,
    async (client) => {
      await setUserContext(client, member.user.id);
      await setHouseholdContext(client, householdId);
      return client.query<{ result_code: string }>(
        `SELECT result_code
         FROM meal_agent_private.confirm_person_profile_link(
           $1::uuid, $2::integer
         )`,
        [linkRequest.id, linkRequest.version],
      );
    },
  );
  assert.equal(
    confirm.rows[0]?.result_code,
    "target_membership_inactive",
  );
  const terminal = await persistence.pool.query<{
    status: string;
    terminal_reason: string | null;
  }>(
    `SELECT status, terminal_reason
     FROM person_profile_link_requests WHERE id = $1`,
    [linkRequest.id],
  );
  assert.deepEqual(terminal.rows[0], {
    status: "cancelled",
    terminal_reason: "target_membership_inactive",
  });

  const rejectedCreate = await withAppTransaction(
    persistence,
    async (client) => {
      await setUserContext(client, owner.user.id);
      await setHouseholdContext(client, householdId);
      return client.query<{ result_code: string }>(
        `SELECT result_code
         FROM meal_agent_private.create_person_profile_link_request(
           $1::uuid, $2::uuid, $3::uuid, 24
         )`,
        [uuidv7(), profileId, membership.id],
      );
    },
  );
  assert.equal(rejectedCreate.rows[0]?.result_code, "target_not_found");
});

test("link create/list/confirm serialize with archive/remove without deadlock or 500", { timeout: 10_000 }, async () => {
  const owner = await login("link-lock-owner");
  const ownerSecondSession = await login("link-lock-owner");
  assert.equal(ownerSecondSession.user.id, owner.user.id);
  const household = await createHousehold(owner, "link-lock-hh");
  const householdId = household.household.id;
  const invite = await issueInvite(owner, householdId, "link-lock-invite");
  const member = await login("link-lock-member");
  const membership = joinHouseholdSuccessSchema.parse(
    (await join(member, invite.inviteCode, "link-lock-join")).json(),
  ).data.membership;
  const createDining = async (key: string, displayName: string) => {
    const response = await createProfile(owner, householdId, key, {
      displayName,
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    });
    return personProfileMutationSuccessSchema.parse(response.json()).data;
  };
  const requestLink = (
    profileId: string,
    key: string,
    targetMembershipId = membership.id,
  ) => app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profiles/` +
      `${profileId}/link-requests`,
    headers: idempotent(owner, key),
    payload: {
      targetMembershipId,
      expiresInHours: 24,
      ownerConfirmation: { acknowledged: true },
    },
  });

  const confirmProfile = await createDining(
    "link-lock-confirm-profile",
    "确认竞态档案",
  );
  const requested = await requestLink(
    confirmProfile.profileId,
    "link-lock-confirm-request",
  );
  const linkRequest =
    personProfileLinkRequestSuccessSchema.parse(requested.json()).data.request;
  const [confirmed, removed] = await Promise.all([
    app.inject({
      method: "POST",
      url:
        `/api/v1/households/${householdId}/person-profile-link-requests/` +
        `${linkRequest.id}/confirm`,
      headers: idempotent(member, "link-lock-confirm"),
      payload: {
        expectedVersion: linkRequest.version,
        subjectConfirmation: { acknowledged: true },
      },
    }),
    app.inject({
      method: "DELETE",
      url:
        `/api/v1/households/${householdId}/memberships/${membership.id}`,
      headers: idempotent(owner, "link-lock-remove"),
    }),
  ]);
  assert.notEqual(confirmed.statusCode, 500, confirmed.body);
  assert.notEqual(removed.statusCode, 500, removed.body);

  const secondInvite = await issueInvite(
    owner,
    householdId,
    "link-lock-second-invite",
  );
  const secondMember = await login("link-lock-second-member");
  const secondMembership = joinHouseholdSuccessSchema.parse(
    (await join(
      secondMember,
      secondInvite.inviteCode,
      "link-lock-second-join",
    )).json(),
  ).data.membership;

  const listProfile = await createDining(
    "link-lock-list-profile",
    "列表归档竞态",
  );
  const listRequested = await requestLink(
    listProfile.profileId,
    "link-lock-list-request",
    secondMembership.id,
  );
  assert.equal(listRequested.statusCode, 201, listRequested.body);
  const [listed, archived] = await Promise.all([
    app.inject({
      method: "GET",
      url:
        `/api/v1/households/${householdId}` +
        "/person-profile-link-requests",
      headers: authHeaders(owner),
    }),
    app.inject({
      method: "PATCH",
      url:
        `/api/v1/households/${householdId}/person-profiles/` +
        `${listProfile.profileId}`,
      headers: idempotent(ownerSecondSession, "link-lock-list-archive"),
      payload: { operation: "archive", expectedVersion: 0 },
    }),
  ]);
  assert.notEqual(listed.statusCode, 500, listed.body);
  assert.equal(archived.statusCode, 200, archived.body);

  const createProfileRace = await createDining(
    "link-lock-create-profile",
    "创建归档竞态",
  );
  const [created, createArchived] = await Promise.all([
    requestLink(
      createProfileRace.profileId,
      "link-lock-create-request",
      secondMembership.id,
    ),
    app.inject({
      method: "PATCH",
      url:
        `/api/v1/households/${householdId}/person-profiles/` +
        `${createProfileRace.profileId}`,
      headers: idempotent(ownerSecondSession, "link-lock-create-archive"),
      payload: { operation: "archive", expectedVersion: 0 },
    }),
  ]);
  assert.notEqual(created.statusCode, 500, created.body);
  assert.equal(createArchived.statusCode, 200, createArchived.body);
});

test("confirm/remove 409 replays with the same key after the target becomes inactive", { timeout: 10_000 }, async () => {
  const owner = await login("link-replay-race-owner");
  const household = await createHousehold(
    owner,
    "link-replay-race-household",
  );
  const householdId = household.household.id;
  const invite = await issueInvite(
    owner,
    householdId,
    "link-replay-race-invite",
  );
  const member = await login("link-replay-race-member");
  const membership = joinHouseholdSuccessSchema.parse(
    (
      await join(
        member,
        invite.inviteCode,
        "link-replay-race-join",
      )
    ).json(),
  ).data.membership;
  const profile = await createProfile(
    owner,
    householdId,
    "link-replay-race-profile",
    {
      displayName: "重放竞态档案",
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null,
    },
  );
  const profileId =
    personProfileMutationSuccessSchema.parse(profile.json()).data.profileId;
  const requested = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}/person-profiles/` +
      `${profileId}/link-requests`,
    headers: idempotent(owner, "link-replay-race-request"),
    payload: {
      targetMembershipId: membership.id,
      expiresInHours: 24,
      ownerConfirmation: { acknowledged: true },
    },
  });
  const request =
    personProfileLinkRequestSuccessSchema.parse(requested.json()).data.request;
  const confirmKey = "link-replay-race-confirm";

  const blocker = await persistence.pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'person-profile-links:' || $1::text,
           0
         )
       )`,
      [householdId],
    );
    const removal = app.inject({
      method: "DELETE",
      url:
        `/api/v1/households/${householdId}/memberships/` +
        `${membership.id}`,
      headers: idempotent(owner, "link-replay-race-remove"),
    });
    await waitForAdvisoryWaiters(1);
    const confirmation = app.inject({
      method: "POST",
      url:
        `/api/v1/households/${householdId}` +
        `/person-profile-link-requests/${request.id}/confirm`,
      headers: idempotent(member, confirmKey),
      payload: {
        expectedVersion: request.version,
        subjectConfirmation: { acknowledged: true },
      },
    });
    await waitForAdvisoryWaiters(2);
    await blocker.query("COMMIT");
    const [removed, conflicted] = await Promise.all([
      removal,
      confirmation,
    ]);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(conflicted.statusCode, 409, conflicted.body);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }

  const replay = await app.inject({
    method: "POST",
    url:
      `/api/v1/households/${householdId}` +
      `/person-profile-link-requests/${request.id}/confirm`,
    headers: idempotent(member, confirmKey),
    payload: {
      expectedVersion: request.version,
      subjectConfirmation: { acknowledged: true },
    },
  });
  assert.equal(replay.statusCode, 409, replay.body);
  assert.equal(replay.json().code, "CONFLICT");
});

test("malformed safe-409 idempotency bodies are rejected by the database", async () => {
  const owner = await login("malformed-409-owner");
  const household = await createHousehold(
    owner,
    "malformed-409-household",
  );
  for (const [index, body] of [
    {},
    null,
    { ok: false },
    { ok: false, error: {} },
  ].entries()) {
    await assert.rejects(
      persistence.pool.query(
        `INSERT INTO idempotency_records (
           id, scope_kind, user_id, household_id, method,
           normalized_route, idempotency_key, request_hash,
           status_code, response_body, original_request_id,
           first_processed_at, expires_at
         ) VALUES (
           $1, 'household', $2, $3, 'POST',
           '/api/v1/households/{id}/person-profile-link-requests/{requestId}/confirm',
           $4, $5, 409, $6::jsonb, $7, clock_timestamp(),
           clock_timestamp() + interval '30 days'
         )`,
        [
          uuidv7(),
          owner.user.id,
          household.household.id,
          normalizeKey(`malformed-409-${index}`),
          "0".repeat(64),
          JSON.stringify(body),
          uuidv7(),
        ],
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514",
    );
  }
});

test("two different invites concurrently joining the same household yield one join and one conflict, never 500", async () => {
  const owner = await login("two-code-owner");
  const household = await createHousehold(owner, "two-code-hh");
  const householdId = household.household.id;
  const first = await issueInvite(owner, householdId, "two-code-first");
  const second = await issueInvite(owner, householdId, "two-code-second");
  const member = await login("two-code-member");

  const [left, right] = await Promise.all([
    join(member, first.inviteCode, "two-code-join-left"),
    join(member, second.inviteCode, "two-code-join-right"),
  ]);
  assert.deepEqual(
    [left.statusCode, right.statusCode].sort((a, b) => a - b),
    [201, 409],
  );
  assert.equal(left.statusCode === 500 || right.statusCode === 500, false);
  const membershipCount = await persistence.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM memberships
     WHERE household_id = $1 AND user_id = $2`,
    [householdId, member.user.id],
  );
  assert.equal(membershipCount.rows[0]?.count, 1);
});
