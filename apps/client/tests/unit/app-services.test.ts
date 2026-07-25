import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { authenticatedSessionSchema } from '@meal-agent/contracts/identity'

import { createAppServices } from '../../src/core/app-services'
import {
  INVENTORY_ROUTE,
  LOGIN_ROUTE
} from '../../src/platform/ports'
import { FakePlatform } from '../support/fake-platform'
import {
  apiErrorBody,
  authenticatedSessionFixture
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
    const coordinated = services as unknown as {
      readonly pendingCommands: {
        acquire(action: string, payload: unknown): string
        markUnknown(action: string): void
      }
      readonly navigation: {
        navigateTo(route: typeof INVENTORY_ROUTE): Promise<void>
      }
    }
    assert.ok(coordinated.pendingCommands)
    coordinated.pendingCommands.acquire('household:join', {
      inviteCode: 'never-persist-this-invite'
    })
    coordinated.pendingCommands.markUnknown('household:join')
    await coordinated.navigation.navigateTo(INVENTORY_ROUTE)
    assert.deepEqual(platform.navigations, [])
    assert.equal(
      JSON.stringify([...platform.storageMap.entries()]).includes(
        'never-persist-this-invite'
      ),
      false
    )
  })
})
