import {
  apiErrorStatus,
  type ApiErrorCode
} from '@meal-agent/contracts/api'

/** 构造符合 uuidv7 模式的确定性测试 id。 */
export const uuidV7 = (sequence: number): string => {
  const tail = sequence.toString(16).padStart(12, '0')
  return `01900000-0000-7000-8000-${tail}`
}

export const T0 = '2026-07-24T00:00:00.000Z'
export const T_EXPIRES = '2026-08-23T00:00:00.000Z'

export const FAKE_ACCESS_TOKEN = 'a'.repeat(43)

export const REQUEST_ID = '3f2b8c1d-9e4a-4c6b-8d7e-5a1b2c3d4e5f'

export const userFixture = (sequence = 1) => ({
  id: uuidV7(sequence),
  status: 'active' as const,
  displayName: '测试用户',
  locale: 'zh-CN',
  createdAt: T0,
  updatedAt: T0,
  version: 1
})

export const authenticatedSessionFixture = (
  overrides: { expiresAt?: string; accessToken?: string } = {}
) => {
  const user = userFixture(1)
  return {
    accessToken: overrides.accessToken ?? FAKE_ACCESS_TOKEN,
    session: {
      id: uuidV7(2),
      userId: user.id,
      authIdentityId: uuidV7(3),
      status: 'active' as const,
      issuedAt: T0,
      expiresAt: overrides.expiresAt ?? T_EXPIRES,
      lastSeenAt: T0,
      tokenVersion: 1
    },
    user
  }
}

export const householdFixture = (sequence = 10) => ({
  id: uuidV7(sequence),
  name: `测试家庭 ${sequence}`,
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  status: 'active' as const,
  createdByUserId: uuidV7(1),
  createdAt: T0,
  updatedAt: T0,
  version: 1
})

export const successEnvelope = (
  data: unknown,
  meta: Record<string, unknown> = {}
) => ({
  ok: true,
  data,
  meta: { requestId: REQUEST_ID, ...meta }
})

export const replayedIdempotencyMeta = (key: string) => ({
  idempotency: {
    key,
    scope: 'user',
    replayed: true,
    firstProcessedAt: T0,
    originalRequestId: REQUEST_ID
  }
})

export const createHouseholdResultFixture = () => {
  const household = householdFixture(10)
  const membership = {
    id: uuidV7(20),
    householdId: household.id,
    userId: household.createdByUserId,
    role: 'owner' as const,
    capabilities: [
      'inventory:write' as const,
      'meal:write' as const,
      'shopping:write' as const
    ],
    status: 'active' as const,
    joinedAt: T0,
    updatedAt: T0,
    version: 1
  }
  const ownerProfile = {
    id: uuidV7(21),
    householdId: household.id,
    linkedMembershipId: membership.id,
    displayName: '小明',
    status: 'active' as const,
    defaultParticipation: true,
    defaultPortionScale: 1,
    cookingSkill: 'beginner' as const,
    dietaryConstraints: [],
    createdAt: T0,
    updatedAt: T0,
    version: 1
  }
  return { household, membership, ownerProfile }
}

export const inventoryLotFixture = (
  overrides: {
    sequence?: number
    amount?: string
    unit?: string
    version?: number
    currentQuantity?: Record<string, unknown>
  } = {}
) => ({
  id: uuidV7(overrides.sequence ?? 30),
  householdId: uuidV7(10),
  displayName: '鸡蛋',
  state: 'active' as const,
  storageLocation: 'refrigerated' as const,
  currentQuantity: overrides.currentQuantity ?? {
    kind: 'exact' as const,
    amount: overrides.amount ?? '12',
    unit: overrides.unit ?? '个'
  },
  dates: [],
  safetyAssessment: {
    status: 'unknown' as const,
    reasonCodes: [],
    policyVersion: 'stage-06-safety-policy-v1',
    evaluatedAt: T0
  },
  origin: 'manual' as const,
  createdByUserId: uuidV7(1),
  createdAt: T0,
  updatedAt: T0,
  version: overrides.version ?? 1
})

export const createInventoryLotResultFixture = (
  idempotencyKey = 'c07-fake-token-000001'
) => {
  const lot = inventoryLotFixture()
  return {
    lot,
    event: {
      id: uuidV7(40),
      householdId: lot.householdId,
      inventoryLotId: lot.id,
      type: 'acquired' as const,
      quantityChange: {
        kind: 'numeric' as const,
        amount: '12',
        unit: '个',
        precision: 'exact' as const
      },
      actorUserId: lot.createdByUserId,
      source: 'manual_confirmation' as const,
      occurredAt: T0,
      recordedAt: T0,
      idempotencyKey,
      expectedLotVersion: 0,
      resultingLotVersion: 1
    }
  }
}

export const consumeInventoryLotResultFixture = (
  idempotencyKey = 'c07-fake-token-000001'
) => {
  const lot = inventoryLotFixture({ amount: '10', version: 2 })
  return {
    lot,
    event: {
      id: uuidV7(41),
      householdId: lot.householdId,
      inventoryLotId: lot.id,
      type: 'consumed' as const,
      quantityChange: {
        kind: 'numeric' as const,
        amount: '-2',
        unit: '个',
        precision: 'exact' as const
      },
      actorUserId: lot.createdByUserId,
      source: 'manual_confirmation' as const,
      occurredAt: T0,
      recordedAt: T0,
      idempotencyKey,
      expectedLotVersion: 1,
      resultingLotVersion: 2
    }
  }
}

export const apiErrorBody = (
  code: ApiErrorCode,
  overrides: { detail?: string; retryable?: boolean } = {}
) => ({
  ok: false,
  type: 'https://meal-agent.example/problems/' + code.toLowerCase(),
  title: code,
  status: apiErrorStatus[code],
  code,
  detail: overrides.detail ?? `${code} detail`,
  requestId: REQUEST_ID,
  retryable: overrides.retryable ?? false
})

// --- 阶段 08：成员、邀请、档案、约束 ---

// 全部为虚构样例，不含真实个人数据。
export const INVITE_CODE = 'A'.repeat(32)

export const householdInviteFixture = (
  overrides: {
    sequence?: number
    status?: 'active' | 'revoked' | 'exhausted' | 'expired'
    maxUses?: number
    usedCount?: number
  } = {}
) => ({
  id: uuidV7(overrides.sequence ?? 50),
  householdId: uuidV7(10),
  createdByUserId: uuidV7(1),
  status: overrides.status ?? ('active' as const),
  maxUses: overrides.maxUses ?? 1,
  usedCount: overrides.usedCount ?? 0,
  expiresAt: T_EXPIRES,
  createdAt: T0,
  version: 0
})

export const createHouseholdInviteResultFixture = (code = INVITE_CODE) => ({
  invite: householdInviteFixture(),
  inviteCode: code
})

export const revokeHouseholdInviteResultFixture = () => ({
  invite: householdInviteFixture({ status: 'revoked' })
})

export const membershipFixture = (
  overrides: {
    sequence?: number
    userSeq?: number
    role?: 'owner' | 'member'
    status?: 'active' | 'left' | 'removed'
  } = {}
) => ({
  id: uuidV7(overrides.sequence ?? 20),
  householdId: uuidV7(10),
  userId: uuidV7(overrides.userSeq ?? 1),
  role: overrides.role ?? ('member' as const),
  capabilities: [],
  status: overrides.status ?? ('active' as const),
  joinedAt: T0,
  updatedAt: T0,
  version: 0
})

export const joinHouseholdResultFixture = () => ({
  membership: membershipFixture({ role: 'member', userSeq: 2, sequence: 22 }),
  household: householdFixture(10)
})

export const removeMembershipResultFixture = (
  status: 'left' | 'removed' = 'removed'
) => ({
  membership: membershipFixture({ status, sequence: 22, userSeq: 2 })
})

export const hardConstraintFixture = (
  overrides: {
    sequence?: number
    visibility?: 'household' | 'subject_and_owner'
    label?: string
    kind?:
      | 'allergy'
      | 'religious'
      | 'ethical'
      | 'explicit_avoid'
      | 'food_safety_exclusion'
    mappingStatus?: 'needs_structured_mapping'
    allergenCodes?: readonly string[]
    foodConceptIds?: readonly string[]
  } = {}
) => ({
  id: uuidV7(overrides.sequence ?? 60),
  kind: overrides.kind ?? ('allergy' as const),
  enforcement: 'hard' as const,
  label: overrides.label ?? '虚构花生过敏',
  foodConceptIds: overrides.foodConceptIds ?? [],
  allergenCodes: overrides.allergenCodes ?? ['FICTION_PEANUT'],
  mappingStatus:
    overrides.mappingStatus ?? ('needs_structured_mapping' as const),
  visibility: overrides.visibility ?? ('household' as const),
  confirmedAt: T0,
  confirmedByUserId: uuidV7(1)
})

export const personProfileFixture = (
  overrides: {
    sequence?: number
    membershipSeq?: number
    displayName?: string
    status?: 'active' | 'archived'
    version?: number
    dietaryConstraints?: readonly unknown[]
  } = {}
) => ({
  id: uuidV7(overrides.sequence ?? 21),
  householdId: uuidV7(10),
  linkedMembershipId: uuidV7(overrides.membershipSeq ?? 20),
  displayName: overrides.displayName ?? '成员甲',
  status: overrides.status ?? ('active' as const),
  defaultParticipation: true,
  defaultPortionScale: 1,
  cookingSkill: 'beginner' as const,
  dietaryConstraints: overrides.dietaryConstraints ?? [],
  createdAt: T0,
  updatedAt: T0,
  version: overrides.version ?? 0
})

export const personProfileResultFixture = (
  profile: unknown = personProfileFixture()
) => ({ profile })

export const personProfileMutationReceiptFixture = (
  overrides: {
    operation?:
      | 'create'
      | 'update'
      | 'archive'
      | 'restore'
      | 'add_constraint'
      | 'remove_constraint'
      | 'link'
    status?: 'active' | 'archived'
    resultingVersion?: number
  } = {}
) => ({
  householdId: uuidV7(10),
  profileId: uuidV7(21),
  operation: overrides.operation ?? ('update' as const),
  status: overrides.status ?? ('active' as const),
  resultingVersion: overrides.resultingVersion ?? 1
})

export const getPersonProfileResultFixture = (
  profile: unknown = personProfileFixture()
) => ({
  access: 'owner_or_self' as const,
  profile
})

export const ownerMembersViewFixture = (members: readonly unknown[]) => ({
  viewerRole: 'owner' as const,
  members
})

export const memberMembersViewFixture = (
  self: unknown,
  others: readonly unknown[]
) => ({
  viewerRole: 'member' as const,
  self,
  others
})
