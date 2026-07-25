import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { idempotencyKeySchema } from '@meal-agent/contracts/api'
import {
  dietaryConstraintIdSchema,
  householdIdSchema,
  membershipIdSchema,
  personProfileIdSchema
} from '@meal-agent/contracts'

import { createAppServices } from '../../src/core/app-services'
import {
  addDietaryConstraint,
  archiveProfile,
  createProfile,
  removeDietaryConstraint,
  updateProfile,
  type ConstraintDraft
} from '../../src/core/profile-flow'
import { FakePlatform } from '../support/fake-platform'
import {
  apiErrorBody,
  getPersonProfileResultFixture,
  hardConstraintFixture,
  personProfileFixture,
  personProfileMutationReceiptFixture,
  successEnvelope,
  uuidV7
} from '../support/fixtures'

const BASE_URL = 'http://127.0.0.1:3000'
const KEY = idempotencyKeySchema.parse('c07-fake-token-000001')
const HOUSEHOLD_ID = householdIdSchema.parse(uuidV7(10))
const MEMBERSHIP_ID = membershipIdSchema.parse(uuidV7(22))
const PROFILE_ID = personProfileIdSchema.parse(uuidV7(21))
const CONSTRAINT_ID = dietaryConstraintIdSchema.parse(uuidV7(60))

const servicesWith = () => {
  const platform = new FakePlatform()
  return { platform, services: createAppServices(platform, BASE_URL) }
}

const hardDraft = (acknowledged: boolean): ConstraintDraft => ({
  enforcement: 'hard',
  kind: 'allergy',
  label: '虚构花生过敏',
  allergenCodes: ['FICTION_PEANUT'],
  visibility: 'subject_and_owner',
  acknowledged
})

describe('createProfile', () => {
  it('空称呼本地校验失败，不发请求', async () => {
    const { platform, services } = servicesWith()
    const outcome = await createProfile(
      services,
      HOUSEHOLD_ID,
      {
        linkedMembershipId: MEMBERSHIP_ID,
        displayName: '   ',
        defaultParticipation: true,
        defaultPortionScale: 1,
        cookingSkill: 'beginner'
      },
      KEY
    )
    assert.equal(outcome.kind, 'invalid')
    assert.equal(platform.sentRequests.length, 0)
  })

  it('创建成功', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(
      201,
      successEnvelope(
        personProfileMutationReceiptFixture({ operation: 'create' })
      )
    )
    platform.enqueueJson(
      200,
      successEnvelope(getPersonProfileResultFixture(personProfileFixture()))
    )
    const outcome = await createProfile(
      services,
      HOUSEHOLD_ID,
      {
        linkedMembershipId: MEMBERSHIP_ID,
        displayName: '成员甲',
        defaultParticipation: true,
        defaultPortionScale: 1,
        cookingSkill: 'beginner'
      },
      KEY
    )
    assert.equal(outcome.kind, 'created')
  })

  it('非本人档案 403', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(403, apiErrorBody('FORBIDDEN'))
    const outcome = await createProfile(
      services,
      HOUSEHOLD_ID,
      {
        linkedMembershipId: MEMBERSHIP_ID,
        displayName: '别人',
        defaultParticipation: true,
        defaultPortionScale: 1,
        cookingSkill: 'beginner'
      },
      KEY
    )
    assert.equal(outcome.kind, 'forbidden')
  })

  it('重复档案 409', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(409, apiErrorBody('CONFLICT'))
    const outcome = await createProfile(
      services,
      HOUSEHOLD_ID,
      {
        linkedMembershipId: MEMBERSHIP_ID,
        displayName: '成员甲',
        defaultParticipation: true,
        defaultPortionScale: 1,
        cookingSkill: 'beginner'
      },
      KEY
    )
    assert.equal(outcome.kind, 'conflict')
  })
})

describe('addDietaryConstraint（硬约束双确认）', () => {
  it('未确认的硬约束在本地即被拒绝，不发请求', async () => {
    const { platform, services } = servicesWith()
    const outcome = await addDietaryConstraint(
      services,
      HOUSEHOLD_ID,
      PROFILE_ID,
      hardDraft(false),
      0,
      KEY
    )
    assert.equal(outcome.kind, 'invalid')
    assert.equal(platform.sentRequests.length, 0)
  })

  it('无权威词表时允许只用自然语言登记过敏并保持映射阻断', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(
      201,
      successEnvelope(
        personProfileMutationReceiptFixture({ operation: 'add_constraint' })
      )
    )
    platform.enqueueJson(
      200,
      successEnvelope(
        getPersonProfileResultFixture(personProfileFixture())
      )
    )
    const outcome = await addDietaryConstraint(
      services,
      HOUSEHOLD_ID,
      PROFILE_ID,
      {
        enforcement: 'hard',
        kind: 'allergy',
        label: '缺编码',
        allergenCodes: [],
        foodConceptIds: [],
        visibility: 'household',
        acknowledged: true
      },
      0,
      KEY
    )
    assert.equal(outcome.kind, 'added')
    const body = JSON.parse(platform.sentRequests[0]?.body ?? '{}')
    assert.deepEqual(body.constraint.allergenCodes, [])
    assert.deepEqual(body.constraint.foodConceptIds, [])
  })

  it('已确认的硬约束提交成功', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(
      201,
      successEnvelope(
        personProfileMutationReceiptFixture({ operation: 'add_constraint' })
      )
    )
    platform.enqueueJson(
      200,
      successEnvelope(
        getPersonProfileResultFixture(
          personProfileFixture({
              version: 1,
              dietaryConstraints: [
                hardConstraintFixture({ visibility: 'subject_and_owner' })
              ]
            })
        )
      )
    )
    const outcome = await addDietaryConstraint(
      services,
      HOUSEHOLD_ID,
      PROFILE_ID,
      hardDraft(true),
      0,
      KEY
    )
    assert.equal(outcome.kind, 'added')
    if (outcome.kind !== 'added') {
      return
    }
    // 请求体携带 confirmation.acknowledged=true。
    const body = JSON.parse(platform.sentRequests[0]?.body ?? '{}')
    assert.equal(body.constraint.confirmation.acknowledged, true)
  })

  it('软偏好无需确认即可提交', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(
      201,
      successEnvelope(
        personProfileMutationReceiptFixture({ operation: 'add_constraint' })
      )
    )
    platform.enqueueJson(
      200,
      successEnvelope(getPersonProfileResultFixture(personProfileFixture()))
    )
    const outcome = await addDietaryConstraint(
      services,
      HOUSEHOLD_ID,
      PROFILE_ID,
      {
        enforcement: 'soft',
        label: '少油',
        preference: 'dislike',
        visibility: 'household'
      },
      0,
      KEY
    )
    assert.equal(outcome.kind, 'added')
  })

  it('过期版本 409 映射为 versionConflict', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(409, apiErrorBody('CONFLICT'))
    const outcome = await addDietaryConstraint(
      services,
      HOUSEHOLD_ID,
      PROFILE_ID,
      hardDraft(true),
      0,
      KEY
    )
    assert.equal(outcome.kind, 'versionConflict')
  })
})

describe('removeDietaryConstraint / updateProfile / archiveProfile', () => {
  it('移除约束成功', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(
      200,
      successEnvelope(
        personProfileMutationReceiptFixture({
          operation: 'remove_constraint',
          resultingVersion: 2
        })
      )
    )
    platform.enqueueJson(
      200,
      successEnvelope(
        getPersonProfileResultFixture(personProfileFixture({ version: 2 }))
      )
    )
    const outcome = await removeDietaryConstraint(
      services,
      HOUSEHOLD_ID,
      PROFILE_ID,
      CONSTRAINT_ID,
      1,
      KEY
    )
    assert.equal(outcome.kind, 'removed')
  })

  it('移除时约束已不存在 404', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(404, apiErrorBody('RESOURCE_NOT_FOUND'))
    const outcome = await removeDietaryConstraint(
      services,
      HOUSEHOLD_ID,
      PROFILE_ID,
      CONSTRAINT_ID,
      1,
      KEY
    )
    assert.equal(outcome.kind, 'notFound')
  })

  it('更新档案：无变更字段本地拒绝', async () => {
    const { platform, services } = servicesWith()
    const outcome = await updateProfile(
      services,
      HOUSEHOLD_ID,
      PROFILE_ID,
      {},
      0,
      KEY
    )
    assert.equal(outcome.kind, 'invalid')
    assert.equal(platform.sentRequests.length, 0)
  })

  it('归档成功', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(
      200,
      successEnvelope(
        personProfileMutationReceiptFixture({
          operation: 'archive',
          status: 'archived'
        })
      )
    )
    platform.enqueueJson(
      200,
      successEnvelope(
        getPersonProfileResultFixture(
          personProfileFixture({ status: 'archived', version: 1 })
        )
      )
    )
    const outcome = await archiveProfile(services, HOUSEHOLD_ID, PROFILE_ID, 0, KEY)
    assert.equal(outcome.kind, 'updated')
    assert.equal(
      JSON.parse(platform.sentRequests[0]?.body ?? '{}').operation,
      'archive'
    )
  })

  it('归档过期版本 409 映射为 versionConflict', async () => {
    const { platform, services } = servicesWith()
    platform.enqueueJson(409, apiErrorBody('CONFLICT'))
    const outcome = await archiveProfile(services, HOUSEHOLD_ID, PROFILE_ID, 0, KEY)
    assert.equal(outcome.kind, 'versionConflict')
  })
})
