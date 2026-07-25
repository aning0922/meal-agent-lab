import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { idempotencyKeySchema } from '@meal-agent/contracts/api'

import {
  createIdempotencyKey,
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
})
