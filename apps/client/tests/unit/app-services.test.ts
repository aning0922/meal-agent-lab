import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { authenticatedSessionSchema } from '@meal-agent/contracts/identity'

import { createAppServices } from '../../src/core/app-services'
import { LOGIN_ROUTE } from '../../src/platform/ports'
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
})
