import assert from "node:assert/strict";
import test from "node:test";

import {
  addDietaryConstraintRequestSchema,
  archivePersonProfileRequestSchema,
  contractVersion,
  createHouseholdInviteRequestSchema,
  createHouseholdInviteResultSchema,
  createPersonProfileRequestSchema,
  dietaryConstraintSchema,
  householdInviteCodeSchema,
  householdInviteSchema,
  householdMemberRedactedViewSchema,
  joinHouseholdResultSchema,
  listHouseholdMembersResultSchema,
  patchPersonProfileRequestSchema,
  personProfileSchema,
  removeDietaryConstraintRequestSchema,
  safeOwnerProfileResponseSchema,
  updatePersonProfileRequestSchema,
} from "../src/index.js";

// 全部为虚构样例（过敏/宗教）；不含任何真实个人数据。
const ids = {
  user: "018f0000-0000-7000-8000-000000000001",
  user2: "018f0000-0000-7000-8000-000000000002",
  household: "018f0000-0000-7000-8000-000000000003",
  household2: "018f0000-0000-7000-8000-000000000004",
  invite: "018f0000-0000-7000-8000-000000000005",
  membership: "018f0000-0000-7000-8000-000000000006",
  membership2: "018f0000-0000-7000-8000-000000000007",
  profile: "018f0000-0000-7000-8000-000000000008",
  profile2: "018f0000-0000-7000-8000-000000000009",
  constraint: "018f0000-0000-7000-8000-00000000000a",
} as const;
const now = "2026-07-24T12:00:00Z";
const later = "2026-07-31T12:00:00Z";
const inviteCode = "A".repeat(32);

test("contract version tracks the 0.3.0 package bump", () => {
  assert.equal(contractVersion, "0.3.0");
});

test("household invite entity hides secrets and bounds its counters", () => {
  const invite = {
    id: ids.invite,
    householdId: ids.household,
    createdByUserId: ids.user,
    status: "active" as const,
    expiresAt: later,
    maxUses: 5,
    usedCount: 2,
    createdAt: now,
    version: 0,
  };
  assert.equal(householdInviteSchema.safeParse(invite).success, true);

  // 实体绝不携带明文码或 digest（strict object 拒绝额外字段）。
  assert.equal(
    householdInviteSchema.safeParse({ ...invite, code: inviteCode }).success,
    false,
  );
  assert.equal(
    householdInviteSchema.safeParse({ ...invite, codeDigest: "x".repeat(64) })
      .success,
    false,
  );
  // usedCount 不得超过 maxUses。
  assert.equal(
    householdInviteSchema.safeParse({ ...invite, usedCount: 6 }).success,
    false,
  );
  // 过期时间必须晚于创建时间。
  assert.equal(
    householdInviteSchema.safeParse({ ...invite, expiresAt: now }).success,
    false,
  );
  // maxUses 上限 10、下限 1。
  assert.equal(
    householdInviteSchema.safeParse({ ...invite, maxUses: 11 }).success,
    false,
  );
  assert.equal(
    householdInviteSchema.safeParse({ ...invite, maxUses: 0 }).success,
    false,
  );
});

test("invite codes are high-entropy url-safe strings within 22-128 chars", () => {
  assert.equal(householdInviteCodeSchema.safeParse(inviteCode).success, true);
  assert.equal(
    householdInviteCodeSchema.safeParse("short").success,
    false,
  );
  assert.equal(
    householdInviteCodeSchema.safeParse(`${"A".repeat(21)}`).success,
    false,
  );
  assert.equal(
    householdInviteCodeSchema.safeParse(`${"A".repeat(129)}`).success,
    false,
  );
  // 非 URL-safe 字符被拒绝。
  assert.equal(
    householdInviteCodeSchema.safeParse(`${"A".repeat(31)}!`).success,
    false,
  );
});

test("invite creation defaults to a single use and one week", () => {
  const parsed = createHouseholdInviteRequestSchema.parse({});
  assert.deepEqual(parsed, { maxUses: 1, expiresInHours: 168 });
  // 有效期上限 7 天。
  assert.equal(
    createHouseholdInviteRequestSchema.safeParse({ expiresInHours: 169 })
      .success,
    false,
  );

  const result = {
    invite: {
      id: ids.invite,
      householdId: ids.household,
      createdByUserId: ids.user,
      status: "active" as const,
      expiresAt: later,
      maxUses: 1,
      usedCount: 0,
      createdAt: now,
      version: 0,
    },
    inviteCode,
  };
  assert.equal(
    createHouseholdInviteResultSchema.safeParse(result).success,
    true,
  );
  // 新建邀请必须 active 且 usedCount 为 0。
  assert.equal(
    createHouseholdInviteResultSchema.safeParse({
      ...result,
      invite: { ...result.invite, status: "revoked", version: 1 },
    }).success,
    false,
  );
  assert.equal(
    createHouseholdInviteResultSchema.safeParse({
      ...result,
      invite: { ...result.invite, usedCount: 1 },
    }).success,
    false,
  );
  // 幂等重放响应不含明文码（inviteCode optional）：仍应通过校验。
  const { inviteCode: _omitted, ...replayShape } = result;
  void _omitted;
  assert.equal(
    createHouseholdInviteResultSchema.safeParse(replayShape).success,
    true,
  );
});

const membership = {
  id: ids.membership,
  householdId: ids.household,
  userId: ids.user2,
  role: "member" as const,
  capabilities: [],
  status: "active" as const,
  joinedAt: now,
  updatedAt: now,
  version: 0,
};
const household = {
  id: ids.household,
  name: "测试家庭",
  timezone: "Asia/Shanghai",
  locale: "zh-CN",
  status: "active" as const,
  createdByUserId: ids.user,
  createdAt: now,
  updatedAt: now,
  version: 0,
};

test("join result binds an active member to the returned household", () => {
  assert.equal(
    joinHouseholdResultSchema.safeParse({ membership, household }).success,
    true,
  );
  // membership 与 household 的家庭 id 必须一致。
  assert.equal(
    joinHouseholdResultSchema.safeParse({
      membership: { ...membership, householdId: ids.household2 },
      household,
    }).success,
    false,
  );
  // 凭邀请加入只产出 member 角色，绝不是 owner。
  assert.equal(
    joinHouseholdResultSchema.safeParse({
      membership: { ...membership, role: "owner" },
      household,
    }).success,
    false,
  );
});

const privateConstraint = {
  id: ids.constraint,
  kind: "religious" as const,
  enforcement: "hard" as const,
  label: "虚构宗教忌口",
  foodConceptIds: [],
  allergenCodes: [],
  visibility: "subject_and_owner" as const,
  confirmedAt: now,
  confirmedByUserId: ids.user,
};
const householdConstraint = {
  ...privateConstraint,
  visibility: "household" as const,
};
const fullProfile = {
  id: ids.profile,
  householdId: ids.household,
  linkedMembershipId: ids.membership,
  displayName: "成员甲",
  status: "active" as const,
  defaultParticipation: true,
  defaultPortionScale: 1,
  cookingSkill: "beginner" as const,
  dietaryConstraints: [privateConstraint],
  createdAt: now,
  updatedAt: now,
  version: 0,
};

test("member list redaction is structural, not a runtime field deletion", () => {
  // 完整档案（含私密约束）本身是合法的 personProfile。
  assert.equal(personProfileSchema.safeParse(fullProfile).success, true);

  // 但 household 视图（脱敏投影）结构上不可能携带 subject_and_owner 约束。
  assert.equal(
    safeOwnerProfileResponseSchema.safeParse(fullProfile).success,
    false,
  );
  assert.equal(
    householdMemberRedactedViewSchema.safeParse({
      membership,
      profile: fullProfile,
    }).success,
    false,
  );
  // 只含 household 可见约束的投影可通过。
  assert.equal(
    householdMemberRedactedViewSchema.safeParse({
      membership,
      profile: { ...fullProfile, dietaryConstraints: [householdConstraint] },
    }).success,
    true,
  );

  // owner 视图：每条成员携带完整档案。
  assert.equal(
    listHouseholdMembersResultSchema.safeParse({
      viewerRole: "owner",
      members: [{ membership, profile: fullProfile }],
    }).success,
    true,
  );
  // member 视图：本人完整，其他成员脱敏；若把私密约束塞进 others 会被拒绝。
  assert.equal(
    listHouseholdMembersResultSchema.safeParse({
      viewerRole: "member",
      self: { membership, profile: fullProfile },
      others: [
        {
          membership: { ...membership, id: ids.membership2, userId: ids.user },
          profile: { ...fullProfile, dietaryConstraints: [householdConstraint] },
        },
      ],
    }).success,
    true,
  );
  assert.equal(
    listHouseholdMembersResultSchema.safeParse({
      viewerRole: "member",
      self: { membership, profile: fullProfile },
      others: [{ membership: { ...membership, id: ids.membership2 }, profile: fullProfile }],
    }).success,
    false,
  );
  // 尚未建立档案的成员条目允许 profile 为 null。
  assert.equal(
    listHouseholdMembersResultSchema.safeParse({
      viewerRole: "owner",
      members: [{ membership, profile: null }],
    }).success,
    true,
  );
});

test("person profile create/update/archive commands enforce their shapes", () => {
  // 关联登录成员的档案。
  assert.equal(
    createPersonProfileRequestSchema.safeParse({
      linkedMembershipId: ids.membership,
      displayName: "成员乙",
      defaultParticipation: true,
      defaultPortionScale: 1,
      cookingSkill: "none",
    }).success,
    true,
  );
  // 仅用餐档案（无 membership 关联）。
  assert.equal(
    createPersonProfileRequestSchema.safeParse({
      displayName: "孩子",
      defaultParticipation: false,
      defaultPortionScale: 0.5,
      cookingSkill: "none",
    }).success,
    true,
  );
  // 创建请求不接受直接写入约束（约束走独立双确认路由）。
  assert.equal(
    createPersonProfileRequestSchema.safeParse({
      displayName: "孩子",
      defaultParticipation: false,
      defaultPortionScale: 0.5,
      cookingSkill: "none",
      dietaryConstraints: [],
    }).success,
    false,
  );

  // 更新必须至少改一个字段。
  assert.equal(
    updatePersonProfileRequestSchema.safeParse({
      operation: "update",
      expectedVersion: 3,
      displayName: "新名字",
    }).success,
    true,
  );
  assert.equal(
    updatePersonProfileRequestSchema.safeParse({
      operation: "update",
      expectedVersion: 3,
    }).success,
    false,
  );

  // 归档只需 expectedVersion。
  assert.equal(
    archivePersonProfileRequestSchema.safeParse({
      operation: "archive",
      expectedVersion: 4,
    }).success,
    true,
  );

  // PATCH 请求体：update / archive 二选一（判别式）。
  assert.equal(
    patchPersonProfileRequestSchema.safeParse({
      operation: "archive",
      expectedVersion: 4,
    }).success,
    true,
  );
  assert.equal(
    patchPersonProfileRequestSchema.safeParse({
      operation: "delete",
      expectedVersion: 4,
    }).success,
    false,
  );
});

test("hard dietary constraints require explicit confirmation; soft ones forbid it", () => {
  const hardBody = {
    expectedVersion: 0,
    constraint: {
      kind: "allergy" as const,
      enforcement: "hard" as const,
      label: "虚构花生过敏",
      allergenCodes: ["FICTION_PEANUT"],
      visibility: "subject_and_owner" as const,
      confirmation: { acknowledged: true as const },
    },
  };
  assert.equal(
    addDietaryConstraintRequestSchema.safeParse(hardBody).success,
    true,
  );
  // 缺少 confirmation 的硬约束被拒绝（→ 服务端 400）。
  assert.equal(
    addDietaryConstraintRequestSchema.safeParse({
      ...hardBody,
      constraint: {
        kind: "allergy",
        enforcement: "hard",
        label: "虚构花生过敏",
        allergenCodes: ["FICTION_PEANUT"],
        visibility: "subject_and_owner",
      },
    }).success,
    false,
  );
  // acknowledged 只接受字面 true。
  assert.equal(
    addDietaryConstraintRequestSchema.safeParse({
      ...hardBody,
      constraint: { ...hardBody.constraint, confirmation: { acknowledged: false } },
    }).success,
    false,
  );
  // allergy 缺少结构化编码/概念被拒绝（复用契约不变量）。
  assert.equal(
    addDietaryConstraintRequestSchema.safeParse({
      ...hardBody,
      constraint: { ...hardBody.constraint, allergenCodes: [], foodConceptIds: [] },
    }).success,
    false,
  );
  // 请求体不接受客户端伪造的 confirmedByUserId / id。
  assert.equal(
    addDietaryConstraintRequestSchema.safeParse({
      ...hardBody,
      constraint: { ...hardBody.constraint, confirmedByUserId: ids.user2 },
    }).success,
    false,
  );

  // 软约束（偏好）无需也不接受 confirmation。
  const softBody = {
    expectedVersion: 0,
    constraint: {
      kind: "preference" as const,
      enforcement: "soft" as const,
      label: "少放辣",
      preference: "dislike" as const,
      visibility: "household" as const,
    },
  };
  assert.equal(
    addDietaryConstraintRequestSchema.safeParse(softBody).success,
    true,
  );
  assert.equal(
    addDietaryConstraintRequestSchema.safeParse({
      ...softBody,
      constraint: { ...softBody.constraint, confirmation: { acknowledged: true } },
    }).success,
    false,
  );

  // 删除按 constraintId + 档案 expectedVersion。
  assert.equal(
    removeDietaryConstraintRequestSchema.safeParse({
      constraintId: ids.constraint,
      expectedVersion: 2,
    }).success,
    true,
  );
  assert.equal(
    removeDietaryConstraintRequestSchema.safeParse({
      expectedVersion: 2,
    }).success,
    false,
  );
});

test("0.2.0 dietary constraint consumers keep working (additive change)", () => {
  // 既有 dietaryConstraintSchema 未被破坏：完整硬约束仍然解析通过。
  assert.equal(
    dietaryConstraintSchema.safeParse(privateConstraint).success,
    true,
  );
});
