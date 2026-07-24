import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { idempotencyKeySchema } from '@meal-agent/contracts/api'
import {
  householdIdSchema,
  householdInviteIdSchema,
  membershipIdSchema
} from '@meal-agent/contracts'

import { createAppServices } from '../../src/core/app-services'
import {
  createInvite,
  joinHousehold,
  loadMembers,
  removeMembership,
  revokeInvite
} from '../../src/core/members-flow'
import { FakePlatform } from '../support/fake-platform'
import {
  apiErrorBody,
  createHouseholdInviteResultFixture,
  hardConstraintFixture,
  INVITE_CODE,
  joinHouseholdResultFixture,
  memberMembersViewFixture,
  membershipFixture,
  ownerMembersViewFixture,
  personProfileFixture,
  removeMembershipResultFixture,
  replayedIdempotencyMeta,
  revokeHouseholdInviteResultFixture,
  successEnvelope,
  uuidV7
} from '../support/fixtures'

const BASE_URL = 'http://127.0.0.1:3000'
const KEY = idempotencyKeySchema.parse('c07-fake-token-000001')
const HOUSEHOLD_ID = householdIdSchema.parse(uuidV7(10))
const MEMBERSHIP_ID = membershipIdSchema.parse(uuidV7(22))
const INVITE_ID = householdInviteIdSchema.parse(uuidV7(50))

const servicesWith = () => {
  const platform = new FakePlatform()
  return { platform, services: createAppServices(platform, BASE_URL) }
}

describe('joinHousehold', () => {
  it('本地校验拒绝过短邀请码，不发请求', async () => {
    const { platform, services } = servicesWith()
    const outcome = await joinHousehold(services, 'short', KEY)
    assert.equal(outcome.kind, 'invalid')
    assert.equal(platform.sentRequests.length, 0)
  })

  it('加入成功后切换当前家庭上下文', async () => {
    const { platform, services } = servicesWith()
    const result = joinHouseholdResultFixture()
    platform.enqueueJson(201, successEnvelope(result))

    const outcome = await joinHousehold(services, INVITE_CODE, KEY)

    assert.equal(outcome.kind, 'joined')
    if (outcome.kind !== 'joined') {
      return
    }
    assert.equal(outcome.replayed, false)
    assert.equal(
      services.session.restoreCurrentHouseholdId(),
      result.household.id
    )
    assert.equal(platform.lastRequest.headers['idempotency-key'], KEY)
  })

  it('幂等重放被识别', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(
      201,
      successEnvelope(joinHouseholdResultFixture(), replayedIdempotencyMeta(KEY))
    )
    const outcome = await joinHousehold(services, INVITE_CODE, KEY)
    assert.equal(outcome.kind === 'joined' && outcome.replayed, true)
  })

  it('无效码 404 映射为 inviteInvalid 且不泄露家庭', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(404, apiErrorBody('RESOURCE_NOT_FOUND'))
    const outcome = await joinHousehold(services, INVITE_CODE, KEY)
    assert.equal(outcome.kind, 'inviteInvalid')
    if (outcome.kind !== 'inviteInvalid') {
      return
    }
    assert.equal(/家庭|invite/i.test(outcome.message), true)
    assert.equal(services.session.restoreCurrentHouseholdId(), null)
  })

  it('已是成员 409 映射为 alreadyMember', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(409, apiErrorBody('CONFLICT'))
    const outcome = await joinHousehold(services, INVITE_CODE, KEY)
    assert.equal(outcome.kind, 'alreadyMember')
  })

  it('503 失败可重试', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(
      503,
      apiErrorBody('EXTERNAL_DEPENDENCY_UNAVAILABLE', { retryable: true })
    )
    const outcome = await joinHousehold(services, INVITE_CODE, KEY)
    assert.equal(outcome.kind === 'failed' && outcome.retryable, true)
  })
})

describe('loadMembers', () => {
  it('加载 owner 视图', async () => {
    const { platform, services } = servicesWith()
    const view = ownerMembersViewFixture([
      {
        membership: membershipFixture({ role: 'owner', sequence: 20 }),
        profile: personProfileFixture({
          dietaryConstraints: [
            hardConstraintFixture({ visibility: 'subject_and_owner' })
          ]
        })
      }
    ])
    platform.enqueueJson(200, successEnvelope(view))

    const result = await loadMembers(services, HOUSEHOLD_ID)
    assert.equal(result.kind, 'loaded')
    if (result.kind !== 'loaded') {
      return
    }
    assert.equal(result.view.viewerRole, 'owner')
  })

  it('member 视图：他人档案结构上不含私密约束', async () => {
    const { platform, services } = servicesWith()
    // 若把 subject_and_owner 约束放进 others 会被 envelope 拒绝 → malformedResponse。
    const view = memberMembersViewFixture(
      {
        membership: membershipFixture({ role: 'member', sequence: 22 }),
        profile: personProfileFixture({ membershipSeq: 22 })
      },
      [
        {
          membership: membershipFixture({ role: 'owner', sequence: 20 }),
          profile: personProfileFixture({
            membershipSeq: 20,
            dietaryConstraints: [
              hardConstraintFixture({ visibility: 'household' })
            ]
          })
        }
      ]
    )
    platform.enqueueJson(200, successEnvelope(view))

    const result = await loadMembers(services, HOUSEHOLD_ID)
    assert.equal(result.kind, 'loaded')
  })

  it('404 映射为 householdMissing', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(404, apiErrorBody('RESOURCE_NOT_FOUND'))
    const result = await loadMembers(services, HOUSEHOLD_ID)
    assert.equal(result.kind, 'householdMissing')
  })
})

describe('createInvite / revokeInvite', () => {
  it('签发成功返回一次性明文码', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(
      201,
      successEnvelope(createHouseholdInviteResultFixture())
    )
    const outcome = await createInvite(
      services,
      HOUSEHOLD_ID,
      { maxUses: 1, expiresInHours: 168 },
      KEY
    )
    assert.equal(outcome.kind, 'created')
    if (outcome.kind !== 'created') {
      return
    }
    assert.equal(outcome.result.inviteCode, INVITE_CODE)
  })

  it('member 签发被 403 拒绝', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(403, apiErrorBody('FORBIDDEN'))
    const outcome = await createInvite(
      services,
      HOUSEHOLD_ID,
      { maxUses: 1, expiresInHours: 168 },
      KEY
    )
    assert.equal(outcome.kind, 'forbidden')
  })

  it('撤销成功', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(
      200,
      successEnvelope(revokeHouseholdInviteResultFixture())
    )
    const outcome = await revokeInvite(services, HOUSEHOLD_ID, INVITE_ID, KEY)
    assert.equal(outcome.kind, 'revoked')
  })

  it('重复撤销 409 视为已失效', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(409, apiErrorBody('CONFLICT'))
    const outcome = await revokeInvite(services, HOUSEHOLD_ID, INVITE_ID, KEY)
    assert.equal(outcome.kind, 'alreadyInactive')
  })
})

describe('removeMembership', () => {
  it('移除成功', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(200, successEnvelope(removeMembershipResultFixture()))
    const outcome = await removeMembership(
      services,
      HOUSEHOLD_ID,
      MEMBERSHIP_ID,
      KEY
    )
    assert.equal(outcome.kind, 'removed')
  })

  it('普通成员移除他人 403', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(403, apiErrorBody('FORBIDDEN'))
    const outcome = await removeMembership(
      services,
      HOUSEHOLD_ID,
      MEMBERSHIP_ID,
      KEY
    )
    assert.equal(outcome.kind, 'forbidden')
  })

  it('最后一位 owner 保护 409 映射为 conflict', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(409, apiErrorBody('CONFLICT'))
    const outcome = await removeMembership(
      services,
      HOUSEHOLD_ID,
      MEMBERSHIP_ID,
      KEY
    )
    assert.equal(outcome.kind, 'conflict')
  })

  it('被移除者随后 404', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(404, apiErrorBody('RESOURCE_NOT_FOUND'))
    const outcome = await removeMembership(
      services,
      HOUSEHOLD_ID,
      MEMBERSHIP_ID,
      KEY
    )
    assert.equal(outcome.kind, 'notFound')
  })
})
