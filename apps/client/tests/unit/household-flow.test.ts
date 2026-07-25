import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { idempotencyKeySchema } from '@meal-agent/contracts/api'

import { createAppServices } from '../../src/core/app-services'
import {
  createHousehold,
  loadHouseholds
} from '../../src/core/household-flow'
import { FakePlatform } from '../support/fake-platform'
import {
  apiErrorBody,
  createHouseholdResultFixture,
  householdFixture,
  replayedIdempotencyMeta,
  successEnvelope
} from '../support/fixtures'

const BASE_URL = 'http://127.0.0.1:3000'
const KEY = idempotencyKeySchema.parse('c07-fake-token-000001')

describe('loadHouseholds', () => {
  it('成功加载家庭分页', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      200,
      successEnvelope({
        items: [householdFixture(10), householdFixture(11)],
        pageInfo: { nextCursor: null, hasMore: false }
      })
    )

    const result = await loadHouseholds(services)

    assert.equal(result.kind, 'loaded')
    if (result.kind !== 'loaded') {
      return
    }
    assert.equal(result.page.items.length, 2)
    assert.match(platform.lastRequest.url, /limit=50$/)
  })

  it('403 映射为不可重试失败', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(403, apiErrorBody('FORBIDDEN'))

    const result = await loadHouseholds(services)

    assert.equal(result.kind, 'failed')
    if (result.kind !== 'failed') {
      return
    }
    assert.equal(result.retryable, false)
    assert.match(result.message, /权限/)
  })
})

describe('createHousehold', () => {
  it('本地校验失败不发请求', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)

    const outcome = await createHousehold(
      services,
      { name: '   ', ownerDisplayName: '小明' },
      KEY
    )

    assert.equal(outcome.kind, 'invalid')
    assert.equal(platform.sentRequests.length, 0)
  })

  it('创建成功携带幂等键，但由获准导航统一切换家庭上下文', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    const result = createHouseholdResultFixture()
    platform.enqueueJson(201, successEnvelope(result))

    const outcome = await createHousehold(
      services,
      { name: '我家', ownerDisplayName: '小明' },
      KEY
    )

    assert.equal(outcome.kind, 'created')
    if (outcome.kind !== 'created') {
      return
    }
    assert.equal(outcome.replayed, false)
    assert.equal(platform.lastRequest.headers['idempotency-key'], KEY)
    assert.deepEqual(JSON.parse(platform.lastRequest.body ?? '{}'), {
      name: '我家',
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      ownerProfile: {
        displayName: '小明',
        defaultParticipation: null,
        defaultPortionScale: null,
        cookingSkill: null
      }
    })
    assert.equal(services.session.restoreCurrentHouseholdId(), null)
  })

  it('幂等重放（replayed=true）被识别', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      201,
      successEnvelope(
        createHouseholdResultFixture(),
        replayedIdempotencyMeta(KEY)
      )
    )

    const outcome = await createHousehold(
      services,
      { name: '我家', ownerDisplayName: '小明' },
      KEY
    )

    assert.equal(outcome.kind === 'created' && outcome.replayed, true)
  })

  it('503 失败可重试且不设当前家庭', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      503,
      apiErrorBody('EXTERNAL_DEPENDENCY_UNAVAILABLE', { retryable: true })
    )

    const outcome = await createHousehold(
      services,
      { name: '我家', ownerDisplayName: '小明' },
      KEY
    )

    assert.equal(outcome.kind === 'failed' && outcome.retryable, true)
    assert.equal(services.session.restoreCurrentHouseholdId(), null)
  })
})
