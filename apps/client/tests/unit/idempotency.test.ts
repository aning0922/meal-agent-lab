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

  it('同一进行中动作字段变化被拒绝，显式放弃后才可开启新命令', () => {
    const pending = new PendingActionIdempotency(new FakePlatform().runtime)
    const first = pending.acquire('constraint:add:1', {
      label: '虚构过敏',
      visibility: 'household'
    })
    assert.throws(
      () =>
        pending.acquire('constraint:add:1', {
          label: '虚构过敏',
          visibility: 'subject_and_owner'
        }),
      /payload changed/
    )
    pending.abandon('constraint:add:1')
    assert.notEqual(
      pending.acquire('constraint:add:1', {
        label: '虚构过敏',
        visibility: 'subject_and_owner'
      }),
      first
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
        key: first,
        payload,
        phase: 'unknown'
      }
    )
    assert.throws(
      () =>
        pending.acquire('inventory:consume:lot-1', {
          ...payload,
          amount: '3'
        }),
      /payload changed/
    )
    assert.equal(
      pending.acquire('inventory:consume:lot-1', {
        amount: '2',
        expectedVersion: 3,
        lotId: 'lot-1'
      }),
      first
    )
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
