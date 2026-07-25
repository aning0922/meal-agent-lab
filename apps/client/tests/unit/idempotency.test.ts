import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { idempotencyKeySchema } from '@meal-agent/contracts/api'

import {
  createIdempotencyKey,
  dispositionForOutcome,
  PendingActionIdempotency
} from '../../src/core/idempotency'
import { FakePlatform } from '../support/fake-platform'

describe('createIdempotencyKey', () => {
  it('生成的键满足契约且互不相同', () => {
    const platform = new FakePlatform()
    const first = createIdempotencyKey(platform.runtime)
    const second = createIdempotencyKey(platform.runtime)

    assert.doesNotThrow(() => idempotencyKeySchema.parse(first))
    assert.doesNotThrow(() => idempotencyKeySchema.parse(second))
    assert.notEqual(first, second)
  })
})

describe('PendingActionIdempotency', () => {
  it('同一进行中动作的重试复用 key，完成后新动作换 key', () => {
    const pending = new PendingActionIdempotency(new FakePlatform().runtime)
    const first = pending.acquire('profile:update:1', {
      version: 2,
      displayName: '成员甲'
    })
    const retry = pending.acquire('profile:update:1', {
      displayName: '成员甲',
      version: 2
    })
    assert.equal(retry, first)

    pending.complete('profile:update:1')
    assert.notEqual(
      pending.acquire('profile:update:1', {
        version: 2,
        displayName: '成员甲'
      }),
      first
    )
  })

  it('同一进行中动作忽略刷新后的候选值，普通 GET 不能放弃未知命令', () => {
    const pending = new PendingActionIdempotency(new FakePlatform().runtime)
    const original = {
      label: '虚构过敏',
      visibility: 'household'
    }
    const first = pending.acquireSnapshot('constraint:add:1', original)
    const retry = pending.acquireSnapshot('constraint:add:1', {
      label: '刷新后名称',
      visibility: 'subject_and_owner'
    })
    assert.equal(retry.key, first.key)
    assert.deepEqual(retry.payload, original)
    assert.equal(
      typeof (
        pending as unknown as {
          readonly abandon?: unknown
        }
      ).abandon,
      'undefined',
      'ordinary resource GET cannot authorize abandoning an unknown command'
    )
  })

  it('一个 app 级未知命令阻止任何其他写 action', () => {
    const pending = new PendingActionIdempotency(new FakePlatform().runtime)
    pending.acquire('household:create', { name: '家庭甲' })
    pending.markUnknown('household:create')
    assert.throws(
      () =>
        pending.acquire('household:join', {
          inviteCode: 'sensitive-invite-code'
        }),
      /pending command/i
    )
  })

  it('结果未知时冻结不可变 payload，并只允许用原 key 重试', () => {
    const pending = new PendingActionIdempotency(new FakePlatform().runtime)
    const payload = { lotId: 'lot-1', expectedVersion: 3, amount: '2' }
    const first = pending.acquire('inventory:consume:lot-1', payload)
    pending.markUnknown('inventory:consume:lot-1')

    assert.deepEqual(
      pending.snapshot('inventory:consume:lot-1'),
      {
        action: 'inventory:consume:lot-1',
        key: first,
        payload,
        phase: 'unknown'
      }
    )
    const retry = pending.acquireSnapshot(
      'inventory:consume:lot-1',
      { ...payload, amount: '3', expectedVersion: 4 }
    )
    assert.equal(retry.key, first)
    assert.deepEqual(retry.payload, payload)
  })

  it('明确 409 释放旧动作，刷新版本后的新命令使用新 key', () => {
    const pending = new PendingActionIdempotency(new FakePlatform().runtime)
    const first = pending.acquire('profile:update:1', {
      expectedVersion: 1,
      displayName: '旧名称'
    })
    pending.settle('profile:update:1', 'definite-failure')
    const next = pending.acquire('profile:update:1', {
      expectedVersion: 2,
      displayName: '新名称'
    })
    assert.notEqual(next, first)
  })

  it('GET 观察绑定 action/key，retry 再次 unknown 时不继承旧观察', () => {
    const pending = new PendingActionIdempotency(new FakePlatform().runtime)
    const action = 'inventory:consume:lot-1'
    const first = pending.acquireSnapshot(action, {
      lotId: 'lot-1',
      expectedVersion: 1,
      amount: '2'
    })
    pending.markUnknown(action)
    pending.recordObservation(action, first.key, {
      kind: 'resource-get',
      observedAt: '2026-07-25T12:00:00.000Z',
      summary: 'inventory refreshed'
    })
    assert.equal(pending.snapshot(action)?.observation?.key, first.key)

    const retry = pending.acquireSnapshot(action, {
      lotId: 'lot-1',
      expectedVersion: 9,
      amount: '3'
    })
    assert.equal(retry.key, first.key)
    assert.equal(retry.observation, undefined)
    pending.markUnknown(action)
    assert.equal(pending.snapshot(action)?.observation, undefined)
  })

  it('成功或确定失败清除观察，下一动作不会继承旧对账状态', () => {
    const pending = new PendingActionIdempotency(new FakePlatform().runtime)
    const first = pending.acquireSnapshot('profile:update:1', {
      expectedVersion: 1
    })
    pending.markUnknown(first.action)
    pending.recordObservation(first.action, first.key, {
      kind: 'resource-get',
      observedAt: '2026-07-25T12:00:00.000Z',
      summary: 'profile refreshed'
    })
    pending.complete(first.action)

    const next = pending.acquireSnapshot('profile:archive:1', {
      expectedVersion: 2
    })
    assert.notEqual(next.key, first.key)
    assert.equal(next.observation, undefined)
  })

  it('只把 transport、5xx 和 malformed success 视为结果未知', () => {
    for (const status of [400, 403, 404, 409]) {
      assert.equal(
        dispositionForOutcome({
          kind: 'apiError',
          error: { status }
        }),
        'definite-failure'
      )
    }
    assert.equal(
      dispositionForOutcome({
        kind: 'apiError',
        error: { status: 503 }
      }),
      'unknown'
    )
    assert.equal(
      dispositionForOutcome({ kind: 'transportError' }),
      'unknown'
    )
    assert.equal(
      dispositionForOutcome({ kind: 'malformedResponse' }),
      'unknown'
    )
    assert.equal(
      dispositionForOutcome({
        kind: 'failed',
        executionUnknown: false
      }),
      'definite-failure'
    )
    assert.equal(
      dispositionForOutcome({
        kind: 'failed',
        executionUnknown: true
      }),
      'unknown'
    )
  })
})
