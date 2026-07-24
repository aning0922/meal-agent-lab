import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SessionStore } from '../../src/core/session-store'
import { FakePlatform } from '../support/fake-platform'
import {
  authenticatedSessionFixture,
  uuidV7
} from '../support/fixtures'
import { authenticatedSessionSchema } from '@meal-agent/contracts/identity'
import { householdIdSchema } from '@meal-agent/contracts'

const createStore = (platform: FakePlatform) =>
  new SessionStore(platform.storage, platform.runtime)

describe('SessionStore', () => {
  it('保存后可恢复同一会话', () => {
    const platform = new FakePlatform()
    const store = createStore(platform)
    const session = authenticatedSessionSchema.parse(
      authenticatedSessionFixture()
    )

    store.save(session)
    const restored = store.restore()

    assert.notEqual(restored, null)
    assert.equal(restored?.accessToken, session.accessToken)
    assert.equal(restored?.user.id, session.user.id)
  })

  it('过期会话恢复时被清除', () => {
    const platform = new FakePlatform()
    const store = createStore(platform)
    const session = authenticatedSessionSchema.parse(
      authenticatedSessionFixture({ expiresAt: '2026-07-25T00:00:00.000Z' })
    )
    // 存入时尚未过期，恢复时按当前时间判断过期并清除。
    platform.currentTimeMs = Date.parse('2026-07-24T12:00:00.000Z')
    store.save(session)

    platform.currentTimeMs = Date.parse('2026-07-26T00:00:00.000Z')
    assert.equal(store.restore(), null)
    assert.equal(platform.storageMap.size, 0)
  })

  it('损坏的存量数据被清除并按未登录处理', () => {
    const platform = new FakePlatform()
    platform.storageMap.set('meal-agent.session.v1', { garbage: true })
    const store = createStore(platform)

    assert.equal(store.restore(), null)
    assert.equal(platform.storageMap.has('meal-agent.session.v1'), false)
  })

  it('clear 同时清除会话与当前家庭', () => {
    const platform = new FakePlatform()
    const store = createStore(platform)
    store.save(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    assert.equal(store.restoreCurrentHouseholdId(), null)
    store.saveCurrentHouseholdId(householdIdSchema.parse(uuidV7(10)))

    assert.notEqual(store.restoreCurrentHouseholdId(), null)
    store.clear()
    assert.equal(store.restore(), null)
    assert.equal(store.restoreCurrentHouseholdId(), null)
  })

  it('非法的当前家庭 id 被清除', () => {
    const platform = new FakePlatform()
    platform.storageMap.set('meal-agent.current-household.v1', 'not-a-uuid')
    const store = createStore(platform)

    assert.equal(store.restoreCurrentHouseholdId(), null)
    assert.equal(
      platform.storageMap.has('meal-agent.current-household.v1'),
      false
    )
  })
})
