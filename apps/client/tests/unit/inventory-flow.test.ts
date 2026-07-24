import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { idempotencyKeySchema } from '@meal-agent/contracts/api'
import { householdIdSchema } from '@meal-agent/contracts'
import { inventoryLotSchema } from '@meal-agent/contracts/inventory'

import { createAppServices } from '../../src/core/app-services'
import {
  consumeInventoryLot,
  createInventoryLot,
  loadInventoryLots
} from '../../src/core/inventory-flow'
import { FakePlatform } from '../support/fake-platform'
import {
  apiErrorBody,
  consumeInventoryLotResultFixture,
  createInventoryLotResultFixture,
  inventoryLotFixture,
  replayedIdempotencyMeta,
  successEnvelope,
  uuidV7
} from '../support/fixtures'

const BASE_URL = 'http://127.0.0.1:3000'
const HOUSEHOLD_ID = householdIdSchema.parse(uuidV7(10))
const KEY = idempotencyKeySchema.parse('c07-fake-token-000001')

const parseLot = (value: unknown) => inventoryLotSchema.parse(value)

describe('loadInventoryLots', () => {
  it('成功加载批次分页', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      200,
      successEnvelope({
        items: [inventoryLotFixture()],
        pageInfo: { nextCursor: null, hasMore: false }
      })
    )

    const result = await loadInventoryLots(services, HOUSEHOLD_ID)

    assert.equal(result.kind, 'loaded')
    if (result.kind !== 'loaded') {
      return
    }
    assert.equal(result.page.items[0]?.displayName, '鸡蛋')
    assert.match(
      platform.lastRequest.url,
      /households\/[0-9a-f-]+\/inventory-lots\?limit=50$/
    )
  })

  it('404 视为家庭不可访问（不泄露存在性）', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(404, apiErrorBody('RESOURCE_NOT_FOUND'))

    const result = await loadInventoryLots(services, HOUSEHOLD_ID)

    assert.equal(result.kind, 'householdMissing')
  })
})

describe('createInventoryLot', () => {
  it('exact 数量创建成功并携带幂等键', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      201,
      successEnvelope(createInventoryLotResultFixture())
    )

    const outcome = await createInventoryLot(
      services,
      HOUSEHOLD_ID,
      {
        displayName: ' 鸡蛋 ',
        storageLocation: 'refrigerated',
        quantity: { kind: 'exact', amount: '12', unit: '个' }
      },
      KEY
    )

    assert.equal(outcome.kind, 'created')
    assert.equal(platform.lastRequest.headers['idempotency-key'], KEY)
    const sentBody = JSON.parse(platform.lastRequest.body ?? '{}')
    assert.deepEqual(sentBody.initialQuantity, {
      kind: 'exact',
      amount: '12',
      unit: '个'
    })
    assert.equal(sentBody.displayName, '鸡蛋')
  })

  it('approximate 数量非法（非数字）本地拦截，不发请求', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)

    const outcome = await createInventoryLot(
      services,
      HOUSEHOLD_ID,
      {
        displayName: '面粉',
        storageLocation: 'pantry',
        quantity: {
          kind: 'approximate',
          amount: '大概半袋',
          unit: '袋',
          confidence: 'low',
          originalText: '大概半袋'
        }
      },
      KEY
    )

    assert.equal(outcome.kind, 'invalid')
    assert.equal(platform.sentRequests.length, 0)
  })

  it('approximate 缺原始描述本地拦截', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)

    const outcome = await createInventoryLot(
      services,
      HOUSEHOLD_ID,
      {
        displayName: '面粉',
        storageLocation: 'pantry',
        quantity: {
          kind: 'approximate',
          amount: '0.5',
          unit: '袋',
          confidence: 'low',
          originalText: '   '
        }
      },
      KEY
    )

    assert.equal(outcome.kind, 'invalid')
    assert.equal(platform.sentRequests.length, 0)
  })

  it('qualitative 空原始描述省略该字段', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      500,
      apiErrorBody('INTERNAL_ERROR', { retryable: true })
    )

    const outcome = await createInventoryLot(
      services,
      HOUSEHOLD_ID,
      {
        displayName: '青菜',
        storageLocation: 'refrigerated',
        quantity: { kind: 'qualitative', level: 'some', originalText: '' }
      },
      KEY
    )

    assert.equal(outcome.kind, 'failed')
    const sentBody = JSON.parse(platform.lastRequest.body ?? '{}')
    assert.deepEqual(sentBody.initialQuantity, {
      kind: 'qualitative',
      level: 'some'
    })
  })

  it('幂等重放被识别', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      201,
      successEnvelope(
        createInventoryLotResultFixture(),
        replayedIdempotencyMeta(KEY)
      )
    )

    const outcome = await createInventoryLot(
      services,
      HOUSEHOLD_ID,
      {
        displayName: '鸡蛋',
        storageLocation: 'refrigerated',
        quantity: { kind: 'exact', amount: '12', unit: '个' }
      },
      KEY
    )

    assert.equal(outcome.kind === 'created' && outcome.replayed, true)
  })
})

describe('consumeInventoryLot', () => {
  it('exact 消耗成功：单位取批次单位、金额归一化、版本取批次版本', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      201,
      successEnvelope(consumeInventoryLotResultFixture())
    )
    const lot = parseLot(inventoryLotFixture())

    const outcome = await consumeInventoryLot(
      services,
      HOUSEHOLD_ID,
      lot,
      '2.50',
      KEY
    )

    assert.equal(outcome.kind, 'consumed')
    const sentBody = JSON.parse(platform.lastRequest.body ?? '{}')
    assert.deepEqual(sentBody.consumedQuantity, {
      kind: 'exact',
      amount: '2.5',
      unit: '个'
    })
    assert.equal(sentBody.expectedVersion, 1)
  })

  it('非 exact 批次拒绝消耗，不发请求', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    const lot = parseLot(
      inventoryLotFixture({
        currentQuantity: { kind: 'qualitative', level: 'some' }
      })
    )

    const outcome = await consumeInventoryLot(
      services,
      HOUSEHOLD_ID,
      lot,
      '1',
      KEY
    )

    assert.equal(outcome.kind, 'invalid')
    assert.equal(platform.sentRequests.length, 0)
  })

  it('零数量本地拦截', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    const lot = parseLot(inventoryLotFixture())

    const outcome = await consumeInventoryLot(
      services,
      HOUSEHOLD_ID,
      lot,
      '0',
      KEY
    )

    assert.equal(outcome.kind, 'invalid')
    assert.equal(platform.sentRequests.length, 0)
  })

  it('版本冲突返回 versionConflict', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      409,
      apiErrorBody('INVENTORY_VERSION_CONFLICT')
    )
    const lot = parseLot(inventoryLotFixture())

    const outcome = await consumeInventoryLot(
      services,
      HOUSEHOLD_ID,
      lot,
      '2',
      KEY
    )

    assert.equal(outcome.kind, 'versionConflict')
  })

  it('库存不足映射为失败文案', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(409, apiErrorBody('INVENTORY_INSUFFICIENT'))
    const lot = parseLot(inventoryLotFixture())

    const outcome = await consumeInventoryLot(
      services,
      HOUSEHOLD_ID,
      lot,
      '99',
      KEY
    )

    assert.equal(outcome.kind, 'failed')
    if (outcome.kind !== 'failed') {
      return
    }
    assert.match(outcome.message, /数量不足/)
  })

  it('重复提交的重放被识别且不改变语义', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      201,
      successEnvelope(
        consumeInventoryLotResultFixture(),
        replayedIdempotencyMeta(KEY)
      )
    )
    const lot = parseLot(inventoryLotFixture())

    const outcome = await consumeInventoryLot(
      services,
      HOUSEHOLD_ID,
      lot,
      '2',
      KEY
    )

    assert.equal(outcome.kind === 'consumed' && outcome.replayed, true)
  })

  it('404 返回 notFound 由页面刷新判定', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(404, apiErrorBody('RESOURCE_NOT_FOUND'))
    const lot = parseLot(inventoryLotFixture())

    const outcome = await consumeInventoryLot(
      services,
      HOUSEHOLD_ID,
      lot,
      '2',
      KEY
    )

    assert.equal(outcome.kind, 'notFound')
  })
})
