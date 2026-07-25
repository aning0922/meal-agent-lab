import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  householdIdSchema,
  idempotencyKeySchema,
  userIdSchema
} from '@meal-agent/contracts'

import {
  createIdempotencyKey,
  dispositionForOutcome,
  PendingActionIdempotency
} from '../../src/core/idempotency'
import { HOUSEHOLDS_ROUTE } from '../../src/platform/ports'
import { FakePlatform } from '../support/fake-platform'
import { uuidV7 } from '../support/fixtures'

const createPending = () => {
  const platform = new FakePlatform()
  let context = {
    principalId: userIdSchema.parse(uuidV7(1)),
    generation: 1
  }
  return {
    pending: new PendingActionIdempotency(
      platform.runtime,
      () => context
    ),
    setContext(next: typeof context) {
      context = next
    }
  }
}

const householdCommand = (name: string) => ({
  kind: 'household.create' as const,
  payload: { name, ownerDisplayName: '成员甲' }
})

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
  it('同一进行中动作复用 key/完整 command，完成后新动作换 key', () => {
    const { pending } = createPending()
    const first = pending.acquireCommand(
      'household:create',
      HOUSEHOLDS_ROUTE,
      householdCommand('家庭甲')
    )
    const retry = pending.acquireCommand(
      'household:create',
      HOUSEHOLDS_ROUTE,
      householdCommand('刷新后的家庭名')
    )
    assert.equal(retry.key, first.key)
    assert.deepEqual(retry.command, first.command)

    pending.complete('household:create')
    assert.notEqual(
      pending.acquireCommand(
        'household:create',
        HOUSEHOLDS_ROUTE,
        householdCommand('家庭甲')
      ).key,
      first.key
    )
  })

  it('一个 app 级未知命令阻止任何其他写 action', () => {
    const { pending } = createPending()
    pending.acquireCommand(
      'household:create',
      HOUSEHOLDS_ROUTE,
      householdCommand('家庭甲')
    )
    pending.markUnknown('household:create')
    assert.throws(
      () =>
        pending.acquireCommand(
          'household:join',
          HOUSEHOLDS_ROUTE,
          {
            kind: 'household.join',
            payload: { inviteCode: 'sensitive-invite-code' }
          }
        ),
      /pending command/i
    )
  })

  it('envelope 绑定 principal、household、ownerRoute 与认证 generation', () => {
    const { pending } = createPending()
    const envelope = pending.acquireCommand(
      'invite:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'invite.create',
        payload: {
          householdId: householdIdSchema.parse(uuidV7(10)),
          draft: { maxUses: 1, expiresInHours: 24 }
        }
      }
    )
    assert.equal(envelope.principalId, uuidV7(1))
    assert.equal(envelope.householdId, uuidV7(10))
    assert.equal(envelope.ownerRoute, HOUSEHOLDS_ROUTE)
    assert.equal(envelope.authGeneration, 1)
  })

  it('401 suspend 不删除；同 principal 新 generation 恢复，不同 principal 替换', () => {
    const first = createPending()
    first.pending.acquireCommand(
      'household:create',
      HOUSEHOLDS_ROUTE,
      householdCommand('家庭甲')
    )
    first.pending.markUnknown('household:create')
    first.pending.suspendForAuthentication()
    assert.equal(first.pending.status().phase, 'auth-suspended')
    assert.equal(first.pending.activeSnapshot(), null)

    first.setContext({
      principalId: userIdSchema.parse(uuidV7(1)),
      generation: 2
    })
    assert.equal(
      first.pending.resumeAuthentication({
        principalId: userIdSchema.parse(uuidV7(1)),
        generation: 2
      }),
      'resumed'
    )
    assert.equal(first.pending.activeSnapshot()?.authGeneration, 2)

    first.pending.suspendForAuthentication()
    first.setContext({
      principalId: userIdSchema.parse(uuidV7(2)),
      generation: 3
    })
    assert.equal(
      first.pending.resumeAuthentication({
        principalId: userIdSchema.parse(uuidV7(2)),
        generation: 3
      }),
      'replaced'
    )
    assert.deepEqual(first.pending.status(), { phase: 'idle' })
  })

  it('GET 观察绑定 action/key，retry 再次 unknown 时不继承旧观察', () => {
    const { pending } = createPending()
    const first = pending.acquireCommand(
      'household:create',
      HOUSEHOLDS_ROUTE,
      householdCommand('家庭甲')
    )
    pending.markUnknown(first.action)
    pending.recordObservation(first.action, first.key, {
      kind: 'resource-get',
      observedAt: '2026-07-25T12:00:00.000Z',
      summary: 'households refreshed'
    })
    assert.equal(pending.snapshot(first.action)?.observation?.key, first.key)

    const retry = pending.acquireCommand(
      first.action,
      HOUSEHOLDS_ROUTE,
      householdCommand('不同草稿')
    )
    assert.equal(retry.key, first.key)
    assert.equal(retry.observation, undefined)
    assert.deepEqual(retry.command, first.command)
    pending.markUnknown(first.action)
    assert.equal(pending.snapshot(first.action)?.observation, undefined)
  })

  it('成功或确定失败清除观察，下一动作不会继承旧状态', () => {
    const { pending } = createPending()
    const first = pending.acquireCommand(
      'household:create',
      HOUSEHOLDS_ROUTE,
      householdCommand('家庭甲')
    )
    pending.markUnknown(first.action)
    pending.recordObservation(first.action, first.key, {
      kind: 'resource-get',
      observedAt: '2026-07-25T12:00:00.000Z',
      summary: 'households refreshed'
    })
    pending.complete(first.action)
    const next = pending.acquireCommand(
      'household:create',
      HOUSEHOLDS_ROUTE,
      householdCommand('家庭乙')
    )
    assert.notEqual(next.key, first.key)
    assert.equal(next.observation, undefined)
  })

  it('只把 transport、5xx 和 malformed success 视为结果未知', () => {
    for (const status of [400, 403, 404, 409]) {
      assert.equal(
        dispositionForOutcome({ kind: 'apiError', error: { status } }),
        'definite-failure'
      )
    }
    assert.equal(
      dispositionForOutcome({ kind: 'apiError', error: { status: 503 } }),
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
      dispositionForOutcome({ kind: 'failed', executionUnknown: false }),
      'definite-failure'
    )
    assert.equal(
      dispositionForOutcome({ kind: 'failed', executionUnknown: true }),
      'unknown'
    )
  })
})
