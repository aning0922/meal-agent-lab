import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { householdIdSchema } from '@meal-agent/contracts'
import { authenticatedSessionSchema } from '@meal-agent/contracts/identity'

import { createAppServices } from '../../src/core/app-services'
import { signOut } from '../../src/core/auth-flow'
import {
  HOUSEHOLDS_ROUTE,
  INVENTORY_ROUTE,
  LOGIN_ROUTE,
  type HttpResponse
} from '../../src/platform/ports'
import { FakePlatform } from '../support/fake-platform'
import {
  apiErrorBody,
  authenticatedSessionFixture,
  createHouseholdInviteResultFixture,
  createHouseholdResultFixture,
  joinHouseholdResultFixture,
  replayedIdempotencyMeta,
  successEnvelope,
  userFixture,
  uuidV7
} from '../support/fixtures'

const BASE_URL = 'http://127.0.0.1:3000'

const deferredResponse = () => {
  let resolve!: (response: HttpResponse) => void
  const promise = new Promise<HttpResponse>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('createAppServices', () => {
  it('401 会话过期：清会话、跳登录页、提示可被消费一次', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    services.session.save(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    platform.enqueueJson(401, apiErrorBody('SESSION_EXPIRED'))

    const outcome = await services.api.getMe()

    assert.equal(outcome.kind, 'apiError')
    assert.equal(services.session.restore(), null)
    assert.deepEqual(platform.navigations, [
      { kind: 'reLaunch', route: LOGIN_ROUTE }
    ])
    assert.equal(
      services.consumeUnauthorizedNotice(),
      '会话已过期，请重新登录。'
    )
    assert.equal(services.consumeUnauthorizedNotice(), null)
  })

  it('已登录请求自动携带 bearer token', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    const session = authenticatedSessionSchema.parse(
      authenticatedSessionFixture()
    )
    services.session.save(session)
    platform.enqueueJson(401, apiErrorBody('AUTHENTICATION_REQUIRED'))

    await services.api.getMe()

    assert.equal(
      platform.lastRequest.headers['authorization'],
      `Bearer ${session.accessToken}`
    )
  })

  it('app 级 pending coordinator 跨页面存活并阻止离页，且不持久化敏感 payload', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    services.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    const envelope = services.pendingCommands.acquireCommand(
      'household:join',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.join',
        payload: { inviteCode: 'never-persist-this-invite' }
      }
    )
    services.pendingCommands.markUnknown(envelope)
    const decision = await services.navigation.navigateTo(INVENTORY_ROUTE)
    assert.equal(decision.kind, 'denied')
    assert.deepEqual(platform.navigations, [])
    assert.equal(
      JSON.stringify([...platform.storageMap.entries()]).includes(
        'never-persist-this-invite'
      ),
      false
    )
  })

  it('401 将 pending 置为 auth-suspended；同一 principal 重登后才可用原 envelope 重试', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    const session = authenticatedSessionSchema.parse(
      authenticatedSessionFixture()
    )
    services.authenticate(session)
    platform.enqueueResponse(new Error('lost create response'))

    await services.commands.execute(
      'household:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '测试家庭', ownerDisplayName: '成员甲' }
      }
    )
    const before401 = services.pendingCommands.activeSnapshot()
    assert.ok(before401)

    platform.enqueueJson(401, apiErrorBody('SESSION_EXPIRED'))
    await services.api.getMe()
    assert.equal(services.pendingCommands.status().phase, 'auth-suspended')
    assert.equal(services.pendingCommands.activeSnapshot(), null)

    const renewed = authenticatedSessionSchema.parse({
      ...session,
      accessToken: 'r'.repeat(43),
      session: {
        ...session.session,
        id: uuidV7(50)
      }
    })
    assert.equal(services.authenticate(renewed), 'resumed')
    platform.enqueueJson(201, successEnvelope(createHouseholdResultFixture()))
    await services.commands.retryActive()

    const requests = platform.sentRequests.filter(
      (request) =>
        request.method === 'POST' && request.url.endsWith('/households')
    )
    assert.equal(requests.length, 2)
    assert.equal(
      requests[0]?.headers['idempotency-key'],
      requests[1]?.headers['idempotency-key']
    )
    assert.equal(requests[0]?.body, requests[1]?.body)
  })

  it('household-scoped pending 在 401 后为同一 principal 恢复家庭上下文并收口成功或确定失败', async () => {
    for (const serverResult of ['success', 'forbidden'] as const) {
      const platform = new FakePlatform()
      const services = createAppServices(platform, BASE_URL)
      const session = authenticatedSessionSchema.parse(
        authenticatedSessionFixture()
      )
      const householdId = householdIdSchema.parse(uuidV7(10))
      services.authenticate(session)
      services.session.saveCurrentHouseholdId(householdId)
      platform.enqueueResponse(new Error('lost invite response'))
      await services.commands.execute(
        `invite:create:${serverResult}`,
        '/pages/members/index',
        {
          kind: 'invite.create',
          payload: {
            householdId,
            draft: { maxUses: 1, expiresInHours: 24 }
          }
        }
      )

      platform.enqueueJson(401, apiErrorBody('SESSION_EXPIRED'))
      await services.api.getMe()
      assert.equal(
        services.pendingCommands.status().phase,
        'auth-suspended'
      )
      assert.equal(services.session.restoreCurrentHouseholdId(), null)

      const renewed = authenticatedSessionSchema.parse({
        ...session,
        accessToken: `${serverResult === 'success' ? 'u' : 'v'}`.repeat(43),
        session: {
          ...session.session,
          id: uuidV7(serverResult === 'success' ? 51 : 52)
        }
      })
      assert.equal(services.authenticate(renewed), 'resumed')
      assert.equal(
        services.session.restoreCurrentHouseholdId(),
        householdId
      )
      assert.equal(
        services.pendingRecoveryRoute(),
        '/pages/members/index'
      )

      if (serverResult === 'success') {
        platform.enqueueJson(
          201,
          successEnvelope(createHouseholdInviteResultFixture())
        )
      } else {
        platform.enqueueJson(403, apiErrorBody('FORBIDDEN'))
      }
      const result = await services.commands.retryActive()
      assert.equal(result.kind, 'reconciled')
      if (result.kind === 'reconciled') {
        assert.equal(
          result.presentation.tone,
          serverResult === 'success' ? 'success' : 'error'
        )
      }
      assert.equal(services.pendingCommands.status().phase, 'idle')
      assert.equal(
        services.session.restoreCurrentHouseholdId(),
        householdId
      )
    }
  })

  it('同一 principal 重登时若家庭 storage 恢复失败，只能进入不依赖家庭上下文的恢复页', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    const session = authenticatedSessionSchema.parse(
      authenticatedSessionFixture()
    )
    const householdId = householdIdSchema.parse(uuidV7(10))
    services.authenticate(session)
    services.session.saveCurrentHouseholdId(householdId)
    platform.enqueueResponse(new Error('lost invite response'))
    await services.commands.execute(
      'invite:create:storage-context-failure',
      '/pages/members/index',
      {
        kind: 'invite.create',
        payload: {
          householdId,
          draft: { maxUses: 1, expiresInHours: 24 }
        }
      }
    )
    platform.enqueueJson(401, apiErrorBody('SESSION_EXPIRED'))
    await services.api.getMe()

    const originalStorageSet = platform.storage.set
    platform.storage.set = (key, value) => {
      if (key.includes('current-household')) {
        throw new Error('current household storage unavailable')
      }
      originalStorageSet(key, value)
    }
    const renewed = authenticatedSessionSchema.parse({
      ...session,
      accessToken: 'w'.repeat(43),
      session: {
        ...session.session,
        id: uuidV7(53)
      }
    })
    assert.equal(services.authenticate(renewed), 'resumed')
    assert.equal(services.session.restoreCurrentHouseholdId(), null)
    assert.equal(services.pendingRecoveryRoute(), HOUSEHOLDS_ROUTE)
    assert.equal(
      (
        await services.navigation.reLaunch('/pages/members/index')
      ).kind,
      'denied'
    )
    assert.equal(
      (await services.navigation.reLaunch(HOUSEHOLDS_ROUTE)).kind,
      'allowed'
    )
    assert.deepEqual(platform.navigations.at(-1), {
      kind: 'reLaunch',
      route: HOUSEHOLDS_ROUTE
    })
    platform.storage.set = originalStorageSet
  })

  it('不同 principal 登录会销毁不可访问的旧 envelope，且主动登出在 service 层 fail-closed', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    const first = authenticatedSessionSchema.parse(
      authenticatedSessionFixture()
    )
    services.authenticate(first)
    services.session.saveCurrentHouseholdId(
      householdIdSchema.parse(uuidV7(10))
    )
    platform.enqueueResponse(new Error('lost join response'))
    await services.commands.execute(
      'household:join',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.join',
        payload: { inviteCode: 'SENSITIVE-INVITE-CODE-00000001' }
      }
    )

    const blocked = await signOut(services)
    assert.equal(blocked.kind, 'blocked')
    assert.notEqual(services.session.restore(), null)
    assert.equal(
      platform.sentRequests.some((request) =>
        request.url.endsWith('/session')
      ),
      false
    )

    services.pendingCommands.suspendForAuthentication()
    services.session.clear()
    const secondUser = userFixture(70)
    const second = authenticatedSessionSchema.parse({
      ...authenticatedSessionFixture(),
      accessToken: 's'.repeat(43),
      user: secondUser,
      session: {
        ...authenticatedSessionFixture().session,
        id: uuidV7(71),
        userId: secondUser.id,
        authIdentityId: uuidV7(72)
      }
    })
    assert.equal(services.authenticate(second), 'replaced')
    assert.equal(services.pendingCommands.status().phase, 'idle')
    assert.equal(services.pendingCommands.activeSnapshot(), null)
    assert.equal(services.session.restoreCurrentHouseholdId(), null)
    assert.equal(services.pendingRecoveryRoute(), HOUSEHOLDS_ROUTE)
    assert.equal(
      JSON.stringify(services.pendingCommands.status()).includes(
        'SENSITIVE-INVITE-CODE'
      ),
      false
    )
  })

  it('导航返回 allowed/denied，只有获准后才执行家庭上下文变更', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    services.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    const householdId = householdIdSchema.parse(
      uuidV7(80)
    )
    const envelope = services.pendingCommands.acquireCommand(
      'household:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '待重试', ownerDisplayName: '成员甲' }
      }
    )
    services.pendingCommands.markUnknown(envelope)

    const denied = await services.navigation.reLaunch(
      INVENTORY_ROUTE,
      () => services.session.saveCurrentHouseholdId(householdId)
    )
    assert.equal(denied.kind, 'denied')
    assert.equal(services.session.restoreCurrentHouseholdId(), null)

    services.pendingCommands.complete(envelope)
    const allowed = await services.navigation.reLaunch(
      INVENTORY_ROUTE,
      () => services.session.saveCurrentHouseholdId(householdId)
    )
    assert.equal(allowed.kind, 'allowed')
    assert.equal(services.session.restoreCurrentHouseholdId(), householdId)
  })

  it('旧 HTTP attempt 延迟成功不能清除同用户同 action 的新 key envelope', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    services.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    const delayed = deferredResponse()
    platform.enqueueResponse(delayed.promise)
    const oldAttempt = services.commands.execute(
      'household:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '旧家庭', ownerDisplayName: '旧成员' }
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    const oldEnvelope = services.pendingCommands.activeSnapshot()
    assert.ok(oldEnvelope)
    services.pendingCommands.complete(oldEnvelope)

    platform.enqueueResponse(new Error('new command response lost'))
    await services.commands.execute(
      'household:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '新家庭', ownerDisplayName: '新成员' }
      }
    )
    const current = services.pendingCommands.activeSnapshot()
    assert.ok(current)
    assert.notEqual(current.commandId, oldEnvelope.commandId)
    assert.notEqual(current.key, oldEnvelope.key)
    assert.equal(current.phase, 'unknown')

    delayed.resolve({
      statusCode: 201,
      body: JSON.stringify(
        successEnvelope(createHouseholdResultFixture())
      )
    })
    await assert.rejects(oldAttempt, /stale command attempt/)
    assert.equal(
      services.pendingCommands.activeSnapshot()?.commandId,
      current.commandId
    )
    assert.equal(services.pendingCommands.status().phase, 'unknown')
  })

  it('前一用户旧 HTTP attempt 延迟失败不能污染后一用户同 action envelope', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    services.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    const delayed = deferredResponse()
    platform.enqueueResponse(delayed.promise)
    const oldAttempt = services.commands.execute(
      'household:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '用户一家庭', ownerDisplayName: '用户一' }
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    const oldEnvelope = services.pendingCommands.activeSnapshot()
    assert.ok(oldEnvelope)

    services.pendingCommands.suspendForAuthentication()
    services.session.clear()
    const secondUser = userFixture(90)
    services.authenticate(
      authenticatedSessionSchema.parse({
        ...authenticatedSessionFixture(),
        accessToken: 't'.repeat(43),
        user: secondUser,
        session: {
          ...authenticatedSessionFixture().session,
          id: uuidV7(91),
          userId: secondUser.id,
          authIdentityId: uuidV7(92)
        }
      })
    )
    platform.enqueueResponse(new Error('new user response lost'))
    await services.commands.execute(
      'household:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '用户二家庭', ownerDisplayName: '用户二' }
      }
    )
    const current = services.pendingCommands.activeSnapshot()
    assert.ok(current)
    assert.notEqual(current.principalId, oldEnvelope.principalId)
    assert.notEqual(current.commandId, oldEnvelope.commandId)

    delayed.resolve({
      statusCode: 403,
      body: JSON.stringify(apiErrorBody('FORBIDDEN'))
    })
    await assert.rejects(oldAttempt, /stale command attempt/)
    assert.equal(
      services.pendingCommands.activeSnapshot()?.commandId,
      current.commandId
    )
    assert.equal(services.pendingCommands.status().phase, 'unknown')
  })

  it('retryActive 仅从 unknown 单次起飞，并发点击不产生第二个 HTTP 请求', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    services.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    platform.enqueueResponse(new Error('first response lost'))
    await services.commands.execute(
      'household:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '待恢复家庭', ownerDisplayName: '成员甲' }
      }
    )
    assert.equal(services.pendingCommands.status().phase, 'unknown')

    const delayed = deferredResponse()
    platform.enqueueResponse(delayed.promise)
    const firstRetry = services.commands.retryActive()
    const secondRetry = await services.commands.retryActive()
    assert.equal(secondRetry.kind, 'in-flight')
    assert.equal(
      platform.sentRequests.filter((request) =>
        request.url.endsWith('/households')
      ).length,
      2
    )

    const created = createHouseholdResultFixture()
    delayed.resolve({
      statusCode: 201,
      body: JSON.stringify(successEnvelope(created))
    })
    const result = await firstRetry
    assert.equal(result.kind, 'reconciled')
    assert.equal(
      services.session.restoreCurrentHouseholdId(),
      created.household.id
    )
    assert.deepEqual(platform.navigations.at(-1), {
      kind: 'reLaunch',
      route: INVENTORY_ROUTE
    })
    assert.equal(services.pendingCommands.status().phase, 'idle')
  })

  it('服务端成功后 navigation/storage 失败只进入本地恢复，绝不重发写命令', async () => {
    const cases = [
      {
        label: 'reLaunch',
        command: {
          kind: 'household.create' as const,
          payload: { name: '创建家庭', ownerDisplayName: '成员甲' }
        },
        action: 'household:create:local-recovery',
        fail(platform: FakePlatform) {
          const original = platform.navigation.reLaunch
          platform.navigation.reLaunch = async () => {
            throw new Error('reLaunch failed')
          }
          return () => {
            platform.navigation.reLaunch = original
          }
        },
        enqueueSuccess(platform: FakePlatform, key: string) {
          platform.enqueueJson(
            201,
            successEnvelope(
              createHouseholdResultFixture(),
              replayedIdempotencyMeta(key)
            )
          )
        }
      },
      {
        label: 'navigateTo',
        command: {
          kind: 'household.join' as const,
          payload: { inviteCode: 'A'.repeat(24) }
        },
        action: 'household:join:local-recovery',
        fail(platform: FakePlatform) {
          const original = platform.navigation.navigateTo
          platform.navigation.navigateTo = async () => {
            throw new Error('navigateTo failed')
          }
          return () => {
            platform.navigation.navigateTo = original
          }
        },
        enqueueSuccess(platform: FakePlatform, key: string) {
          platform.enqueueJson(
            200,
            successEnvelope(
              joinHouseholdResultFixture(),
              replayedIdempotencyMeta(key)
            )
          )
        }
      },
      {
        label: 'storage',
        command: {
          kind: 'household.create' as const,
          payload: { name: '存储失败家庭', ownerDisplayName: '成员乙' }
        },
        action: 'household:create:storage-recovery',
        fail(platform: FakePlatform) {
          const original = platform.storage.set
          platform.storage.set = (key, value) => {
            if (key.includes('current-household')) {
              throw new Error('storage set failed')
            }
            original(key, value)
          }
          return () => {
            platform.storage.set = original
          }
        },
        enqueueSuccess(platform: FakePlatform, key: string) {
          platform.enqueueJson(
            201,
            successEnvelope(
              createHouseholdResultFixture(),
              replayedIdempotencyMeta(key)
            )
          )
        }
      }
    ]

    for (const testCase of cases) {
      const platform = new FakePlatform()
      const services = createAppServices(platform, BASE_URL)
      services.authenticate(
        authenticatedSessionSchema.parse(authenticatedSessionFixture())
      )
      platform.enqueueResponse(new Error(`lost ${testCase.label} response`))
      await services.commands.execute(
        testCase.action,
        HOUSEHOLDS_ROUTE,
        testCase.command
      )
      const pending = services.pendingCommands.activeSnapshot()
      assert.ok(pending)
      const restoreLocalPort = testCase.fail(platform)
      testCase.enqueueSuccess(platform, pending.key)

      const result = await services.commands.retryActive()
      assert.equal(result.kind, 'local-recovery-required')
      assert.equal(services.pendingCommands.status().phase, 'idle')
      assert.equal(
        result.kind === 'local-recovery-required'
          ? result.presentation.message
          : '',
        '命令已完成，但本地页面切换失败。请使用安全恢复入口重试本地切换；不会再次发送写命令。'
      )
      const writesAfterServerResult = platform.sentRequests.length
      assert.deepEqual(await services.commands.retryActive(), {
        kind: 'idle'
      })
      assert.equal(platform.sentRequests.length, writesAfterServerResult)

      restoreLocalPort()
      assert.equal(result.kind, 'local-recovery-required')
      if (result.kind === 'local-recovery-required') {
        const localResult =
          await services.commands.retryLocalRecovery(result.recovery)
        assert.equal(localResult.kind, 'reconciled')
      }
      assert.equal(platform.sentRequests.length, writesAfterServerResult)
    }
  })

  it('不同 principal 不能执行上一用户已完成命令留下的本地恢复计划', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    services.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    platform.enqueueResponse(new Error('lost create response'))
    await services.commands.execute(
      'household:create:principal-bound-recovery',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '用户一家庭', ownerDisplayName: '用户一' }
      }
    )
    const pending = services.pendingCommands.activeSnapshot()
    assert.ok(pending)
    platform.enqueueJson(
      201,
      successEnvelope(
        createHouseholdResultFixture(),
        replayedIdempotencyMeta(pending.key)
      )
    )
    const originalReLaunch = platform.navigation.reLaunch
    platform.navigation.reLaunch = async () => {
      throw new Error('local navigation failed')
    }
    const completed = await services.commands.retryActive()
    assert.equal(completed.kind, 'local-recovery-required')
    assert.equal(services.pendingCommands.status().phase, 'idle')
    platform.navigation.reLaunch = originalReLaunch
    services.session.clear()

    const secondUser = userFixture(95)
    services.authenticate(
      authenticatedSessionSchema.parse({
        ...authenticatedSessionFixture(),
        accessToken: 'x'.repeat(43),
        user: secondUser,
        session: {
          ...authenticatedSessionFixture().session,
          id: uuidV7(96),
          userId: secondUser.id,
          authIdentityId: uuidV7(97)
        }
      })
    )
    const writesAfterCompletion = platform.sentRequests.length
    assert.equal(completed.kind, 'local-recovery-required')
    if (completed.kind === 'local-recovery-required') {
      const localResult =
        await services.commands.retryLocalRecovery(completed.recovery)
      assert.equal(localResult.kind, 'local-recovery-forbidden')
    }
    assert.equal(platform.sentRequests.length, writesAfterCompletion)
    assert.equal(services.session.restoreCurrentHouseholdId(), null)
  })
})
