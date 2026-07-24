import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import type { IdempotencyKey } from '@meal-agent/contracts/api'
import type { HouseholdId } from '@meal-agent/contracts'
import { authenticatedSessionSchema } from '@meal-agent/contracts/identity'
import type { InventoryLot } from '@meal-agent/contracts/inventory'

import {
  createAppServices,
  type AppServices
} from '../../src/core/app-services'
import { signIn, signOut } from '../../src/core/auth-flow'
import { createHousehold, loadHouseholds } from '../../src/core/household-flow'
import {
  consumeInventoryLot,
  createInventoryLot,
  loadInventoryLots
} from '../../src/core/inventory-flow'
import { createIdempotencyKey } from '../../src/core/idempotency'
import { LOGIN_ROUTE } from '../../src/platform/ports'
import { NodePlatform } from './support/node-platform'
import { startE2eStack, type E2eStack } from './support/stack'

/**
 * 阶段 07 端到端闭环：真实 services/api + 临时 PostgreSQL 18 +
 * fake 微信适配器。链路：登录 → 创建家庭 → 新增批次 → 列表 →
 * exact 消耗，覆盖幂等重放、版本冲突、401 引导与跨家庭 404。
 * fake 适配器结果不得记为真实微信链路 Pass。
 */
describe('stage 07 client closed loop (real API + PostgreSQL 18)', () => {
  let stack: E2eStack
  let platformA: NodePlatform
  let servicesA: AppServices
  let householdId: HouseholdId
  let lotV1: InventoryLot
  let lotV2: InventoryLot

  const newKey = (): IdempotencyKey =>
    createIdempotencyKey(platformA.runtime)

  before(async () => {
    stack = await startE2eStack()
    platformA = new NodePlatform('e2e-login-code-user-a')
    servicesA = createAppServices(platformA, stack.baseUrl)
  })

  after(async () => {
    await stack.stop()
  })

  it('登录成功并持久化会话', async () => {
    const result = await signIn(servicesA)
    assert.deepEqual(result, { kind: 'success' })
    assert.notEqual(servicesA.session.restore(), null)
  })

  it('登录前无家庭', async () => {
    const me = await servicesA.api.getMe()
    assert.equal(me.kind, 'success')
    if (me.kind !== 'success') {
      return
    }
    assert.equal(me.data.households.length, 0)
  })

  it('创建家庭；同键重复提交幂等重放同一家庭', async () => {
    const key = newKey()
    const draft = { name: 'E2E 家庭', ownerDisplayName: '户主A' }

    const first = await createHousehold(servicesA, draft, key)
    assert.equal(first.kind, 'created')
    if (first.kind !== 'created') {
      return
    }
    assert.equal(first.replayed, false)
    householdId = first.result.household.id

    const replay = await createHousehold(servicesA, draft, key)
    assert.equal(replay.kind, 'created')
    if (replay.kind !== 'created') {
      return
    }
    assert.equal(replay.replayed, true)
    assert.equal(replay.result.household.id, householdId)

    const list = await loadHouseholds(servicesA)
    assert.equal(list.kind === 'loaded' && list.page.items.length, 1)
  })

  it('新增 exact 批次；同键重复提交不产生第二个批次', async () => {
    const key = newKey()
    const draft = {
      displayName: '鸡蛋',
      storageLocation: 'refrigerated' as const,
      quantity: { kind: 'exact' as const, amount: '12', unit: '个' }
    }

    const first = await createInventoryLot(
      servicesA,
      householdId,
      draft,
      key
    )
    assert.equal(first.kind, 'created')
    if (first.kind !== 'created') {
      return
    }
    assert.equal(first.replayed, false)
    lotV1 = first.result.lot
    assert.equal(lotV1.version, 1)

    const replay = await createInventoryLot(
      servicesA,
      householdId,
      draft,
      key
    )
    assert.equal(replay.kind === 'created' && replay.replayed, true)
    if (replay.kind !== 'created') {
      return
    }
    assert.equal(replay.result.lot.id, lotV1.id)

    const list = await loadInventoryLots(servicesA, householdId)
    assert.equal(list.kind, 'loaded')
    if (list.kind !== 'loaded') {
      return
    }
    assert.equal(list.page.items.length, 1)
  })

  it('approximate 与 qualitative 初始数量端到端保真', async () => {
    const approx = await createInventoryLot(
      servicesA,
      householdId,
      {
        displayName: '面粉',
        storageLocation: 'pantry',
        quantity: {
          kind: 'approximate',
          amount: '0.5',
          unit: '袋',
          confidence: 'low',
          originalText: '大概半袋'
        }
      },
      newKey()
    )
    assert.equal(approx.kind, 'created')
    if (approx.kind !== 'created') {
      return
    }
    assert.deepEqual(approx.result.lot.currentQuantity, {
      kind: 'approximate',
      amount: 0.5,
      unit: '袋',
      confidence: 'low',
      originalText: '大概半袋'
    })

    const qualitative = await createInventoryLot(
      servicesA,
      householdId,
      {
        displayName: '青菜',
        storageLocation: 'refrigerated',
        quantity: { kind: 'qualitative', level: 'some', originalText: '' }
      },
      newKey()
    )
    assert.equal(qualitative.kind, 'created')
    if (qualitative.kind !== 'created') {
      return
    }
    assert.deepEqual(qualitative.result.lot.currentQuantity, {
      kind: 'qualitative',
      level: 'some'
    })

    const list = await loadInventoryLots(servicesA, householdId)
    assert.equal(list.kind === 'loaded' && list.page.items.length, 3)
  })

  it('exact 消耗成功；同键重放不重复扣减', async () => {
    const key = newKey()

    const first = await consumeInventoryLot(
      servicesA,
      householdId,
      lotV1,
      '2.5',
      key
    )
    assert.equal(first.kind, 'consumed')
    if (first.kind !== 'consumed') {
      return
    }
    assert.equal(first.replayed, false)
    lotV2 = first.result.lot
    assert.equal(lotV2.version, 2)
    assert.deepEqual(lotV2.currentQuantity, {
      kind: 'exact',
      amount: '9.5',
      unit: '个'
    })

    const replay = await consumeInventoryLot(
      servicesA,
      householdId,
      lotV1,
      '2.5',
      key
    )
    assert.equal(replay.kind === 'consumed' && replay.replayed, true)
    if (replay.kind !== 'consumed') {
      return
    }
    assert.equal(replay.result.event.id, first.result.event.id)

    const list = await loadInventoryLots(servicesA, householdId)
    assert.equal(list.kind, 'loaded')
    if (list.kind !== 'loaded') {
      return
    }
    const lot = list.page.items.find((item) => item.id === lotV1.id)
    assert.deepEqual(lot?.currentQuantity, {
      kind: 'exact',
      amount: '9.5',
      unit: '个'
    })
  })

  it('过期版本消耗返回版本冲突，不静默覆盖', async () => {
    const stale = await consumeInventoryLot(
      servicesA,
      householdId,
      lotV1,
      '1',
      newKey()
    )
    assert.equal(stale.kind, 'versionConflict')
  })

  it('超量消耗返回库存不足', async () => {
    const outcome = await consumeInventoryLot(
      servicesA,
      householdId,
      lotV2,
      '999',
      newKey()
    )
    assert.equal(outcome.kind, 'failed')
    if (outcome.kind !== 'failed') {
      return
    }
    assert.match(outcome.message, /数量不足/)
  })

  it('非 exact 批次的消耗被本地拒绝', async () => {
    const list = await loadInventoryLots(servicesA, householdId)
    assert.equal(list.kind, 'loaded')
    if (list.kind !== 'loaded') {
      return
    }
    const qualitativeLot = list.page.items.find(
      (item) => item.currentQuantity.kind === 'qualitative'
    )
    assert.notEqual(qualitativeLot, undefined)
    if (qualitativeLot === undefined) {
      return
    }
    const outcome = await consumeInventoryLot(
      servicesA,
      householdId,
      qualitativeLot,
      '1',
      newKey()
    )
    assert.equal(outcome.kind, 'invalid')
  })

  it('跨家庭访问返回 404 语义，不泄露存在性', async () => {
    const platformB = new NodePlatform('e2e-login-code-user-b')
    const servicesB = createAppServices(platformB, stack.baseUrl)
    const login = await signIn(servicesB)
    assert.deepEqual(login, { kind: 'success' })

    const lots = await loadInventoryLots(servicesB, householdId)
    assert.equal(lots.kind, 'householdMissing')

    const consume = await consumeInventoryLot(
      servicesB,
      householdId,
      lotV2,
      '1',
      createIdempotencyKey(platformB.runtime)
    )
    assert.equal(consume.kind, 'notFound')
  })

  it('微信依赖不可用时登录失败且可重试', async () => {
    const platformC = new NodePlatform('fake-dependency-unavailable')
    const servicesC = createAppServices(platformC, stack.baseUrl)
    const result = await signIn(servicesC)
    assert.equal(result.kind === 'failed' && result.retryable, true)
    assert.equal(servicesC.session.restore(), null)
  })

  it('登出撤销会话后旧 token 触发 401 重新登录引导', async () => {
    const stale = servicesA.session.restore()
    assert.notEqual(stale, null)
    if (stale === null) {
      return
    }
    await signOut(servicesA)
    assert.equal(servicesA.session.restore(), null)

    servicesA.session.save(stale)
    const me = await servicesA.api.getMe()
    assert.equal(me.kind, 'apiError')
    if (me.kind !== 'apiError') {
      return
    }
    assert.equal(me.error.status, 401)
    assert.equal(servicesA.session.restore(), null)
    assert.deepEqual(platformA.navigations.at(-1), {
      kind: 'reLaunch',
      route: LOGIN_ROUTE
    })
    assert.notEqual(servicesA.consumeUnauthorizedNotice(), null)
  })

  it('伪造 token 同样走 401 引导', async () => {
    const login = await signIn(servicesA)
    assert.deepEqual(login, { kind: 'success' })
    const real = servicesA.session.restore()
    assert.notEqual(real, null)
    if (real === null) {
      return
    }
    servicesA.session.save(
      authenticatedSessionSchema.parse({
        ...real,
        accessToken: 'b'.repeat(43)
      })
    )

    const me = await servicesA.api.getMe()
    assert.equal(me.kind, 'apiError')
    if (me.kind !== 'apiError') {
      return
    }
    assert.equal(me.error.status, 401)
    assert.equal(servicesA.session.restore(), null)
  })
})
