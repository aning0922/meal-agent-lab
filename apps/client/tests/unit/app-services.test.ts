import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { householdIdSchema } from '@meal-agent/contracts'
import { authenticatedSessionSchema } from '@meal-agent/contracts/identity'

import { createAppServices } from '../../src/core/app-services'
import { signOut } from '../../src/core/auth-flow'
import {
  HOUSEHOLDS_ROUTE,
  INVENTORY_ROUTE,
  LOGIN_ROUTE
} from '../../src/platform/ports'
import { FakePlatform } from '../support/fake-platform'
import {
  apiErrorBody,
  authenticatedSessionFixture,
  createHouseholdResultFixture,
  successEnvelope,
  userFixture,
  uuidV7
} from '../support/fixtures'

const BASE_URL = 'http://127.0.0.1:3000'

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
    services.pendingCommands.acquireCommand(
      'household:join',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.join',
        payload: { inviteCode: 'never-persist-this-invite' }
      }
    )
    services.pendingCommands.markUnknown('household:join')
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

  it('不同 principal 登录会销毁不可访问的旧 envelope，且主动登出在 service 层 fail-closed', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    const first = authenticatedSessionSchema.parse(
      authenticatedSessionFixture()
    )
    services.authenticate(first)
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
    services.pendingCommands.acquireCommand(
      'household:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '待重试', ownerDisplayName: '成员甲' }
      }
    )
    services.pendingCommands.markUnknown('household:create')

    const denied = await services.navigation.reLaunch(
      INVENTORY_ROUTE,
      () => services.session.saveCurrentHouseholdId(householdId)
    )
    assert.equal(denied.kind, 'denied')
    assert.equal(services.session.restoreCurrentHouseholdId(), null)

    services.pendingCommands.complete('household:create')
    const allowed = await services.navigation.reLaunch(
      INVENTORY_ROUTE,
      () => services.session.saveCurrentHouseholdId(householdId)
    )
    assert.equal(allowed.kind, 'allowed')
    assert.equal(services.session.restoreCurrentHouseholdId(), householdId)
  })
})
