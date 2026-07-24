import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { authenticatedSessionSchema } from '@meal-agent/contracts/identity'

import { createAppServices } from '../../src/core/app-services'
import { signIn, signOut } from '../../src/core/auth-flow'
import { FakePlatform } from '../support/fake-platform'
import {
  apiErrorBody,
  authenticatedSessionFixture,
  successEnvelope
} from '../support/fixtures'

const BASE_URL = 'http://127.0.0.1:3000'

describe('signIn', () => {
  it('登录成功后持久化会话', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.loginCodeQueue.push('login-code-1')
    platform.enqueueJson(
      200,
      successEnvelope(authenticatedSessionFixture())
    )

    const result = await signIn(services)

    assert.deepEqual(result, { kind: 'success' })
    assert.notEqual(services.session.restore(), null)
    assert.equal(
      platform.lastRequest.body,
      '{"loginCode":"login-code-1"}'
    )
  })

  it('登录凭证获取失败可重试，不产生请求', async () => {
    const platform = new FakePlatform()
    platform.auth.getLoginCode = async () => {
      throw new Error('wx.login failed')
    }
    const services = createAppServices(platform, BASE_URL)

    const result = await signIn(services)

    assert.equal(result.kind, 'failed')
    if (result.kind !== 'failed') {
      return
    }
    assert.equal(result.retryable, true)
    assert.equal(platform.sentRequests.length, 0)
    assert.equal(services.session.restore(), null)
  })

  it('依赖不可用（503）标记为可重试且不写会话', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueJson(
      503,
      apiErrorBody('EXTERNAL_DEPENDENCY_UNAVAILABLE', { retryable: true })
    )

    const result = await signIn(services)

    assert.equal(result.kind, 'failed')
    if (result.kind !== 'failed') {
      return
    }
    assert.equal(result.retryable, true)
    assert.equal(services.session.restore(), null)
  })

  it('传输失败可重试，不合契约响应不可重试', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    platform.enqueueResponse(new Error('network down'))
    platform.enqueueResponse({ statusCode: 200, body: 'not json' })

    const transport = await signIn(services)
    const malformed = await signIn(services)

    assert.equal(transport.kind === 'failed' && transport.retryable, true)
    assert.equal(
      malformed.kind === 'failed' && malformed.retryable,
      false
    )
  })
})

describe('signOut', () => {
  it('撤销成功后清除本地会话', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    services.session.save(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    platform.enqueueJson(200, successEnvelope({ revoked: true }))

    await signOut(services)

    assert.equal(services.session.restore(), null)
    assert.equal(platform.lastRequest.method, 'DELETE')
  })

  it('撤销失败（网络中断）仍清除本地会话', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, BASE_URL)
    services.session.save(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    platform.enqueueResponse(new Error('network down'))

    await signOut(services)

    assert.equal(services.session.restore(), null)
  })
})
