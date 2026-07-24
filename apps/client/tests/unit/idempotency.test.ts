import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { idempotencyKeySchema } from '@meal-agent/contracts/api'

import { createIdempotencyKey } from '../../src/core/idempotency'
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
