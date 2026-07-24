import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ApiError } from '@meal-agent/contracts/api'
import {
  householdPageSuccessSchema,
  wechatLoginExchangeSuccessSchema
} from '@meal-agent/contracts/http'

import { ApiClient } from '../../src/core/api-client'
import { FakePlatform } from '../support/fake-platform'
import {
  apiErrorBody,
  authenticatedSessionFixture,
  householdFixture,
  successEnvelope,
  FAKE_ACCESS_TOKEN,
  REQUEST_ID
} from '../support/fixtures'

const BASE_URL = 'http://127.0.0.1:3000'

const createClient = (
  platform: FakePlatform,
  options: {
    accessToken?: string
    onUnauthorized?: (error: ApiError) => void
  } = {}
) =>
  new ApiClient({
    baseUrl: BASE_URL,
    network: platform.network,
    getAccessToken: () => options.accessToken,
    onUnauthorized: options.onUnauthorized ?? (() => undefined)
  })

describe('ApiClient', () => {
  it('成功响应经契约校验后返回 data 与 meta', async () => {
    const platform = new FakePlatform()
    platform.enqueueJson(
      200,
      successEnvelope({
        items: [householdFixture(10)],
        pageInfo: { nextCursor: null, hasMore: false }
      })
    )

    const outcome = await createClient(platform, {
      accessToken: FAKE_ACCESS_TOKEN
    }).call({
      method: 'GET',
      path: '/api/v1/households',
      envelope: householdPageSuccessSchema,
      query: { limit: 20, cursor: undefined }
    })

    assert.equal(outcome.kind, 'success')
    if (outcome.kind !== 'success') {
      return
    }
    assert.equal(outcome.data.items.length, 1)
    assert.equal(outcome.data.items[0]?.name, '测试家庭 10')
    assert.equal(outcome.meta.requestId, REQUEST_ID)
    assert.equal(
      platform.lastRequest.url,
      `${BASE_URL}/api/v1/households?limit=20`
    )
    assert.equal(
      platform.lastRequest.headers['authorization'],
      `Bearer ${FAKE_ACCESS_TOKEN}`
    )
  })

  it('无 token 时不携带 authorization 头', async () => {
    const platform = new FakePlatform()
    platform.enqueueJson(
      200,
      successEnvelope(authenticatedSessionFixture())
    )

    const outcome = await createClient(platform).call({
      method: 'POST',
      path: '/api/v1/auth/wechat/exchange',
      envelope: wechatLoginExchangeSuccessSchema,
      body: { loginCode: 'code-1' }
    })

    assert.equal(outcome.kind, 'success')
    assert.equal(platform.lastRequest.headers['authorization'], undefined)
    assert.equal(
      platform.lastRequest.headers['content-type'],
      'application/json'
    )
    assert.equal(platform.lastRequest.body, '{"loginCode":"code-1"}')
  })

  it('幂等键作为 idempotency-key 头发送', async () => {
    const platform = new FakePlatform()
    platform.enqueueJson(
      200,
      successEnvelope({
        items: [],
        pageInfo: { nextCursor: null, hasMore: false }
      })
    )

    await createClient(platform).call({
      method: 'GET',
      path: '/api/v1/households',
      envelope: householdPageSuccessSchema,
      idempotencyKey: 'c07-fake-token-000001'
    })

    assert.equal(
      platform.lastRequest.headers['idempotency-key'],
      'c07-fake-token-000001'
    )
  })

  it('problem+json 错误返回 apiError，403 不触发 onUnauthorized', async () => {
    const platform = new FakePlatform()
    platform.enqueueJson(403, apiErrorBody('FORBIDDEN'))
    let unauthorizedCalls = 0

    const outcome = await createClient(platform, {
      accessToken: FAKE_ACCESS_TOKEN,
      onUnauthorized: () => {
        unauthorizedCalls += 1
      }
    }).call({
      method: 'GET',
      path: '/api/v1/households',
      envelope: householdPageSuccessSchema
    })

    assert.equal(outcome.kind, 'apiError')
    if (outcome.kind !== 'apiError') {
      return
    }
    assert.equal(outcome.error.code, 'FORBIDDEN')
    assert.equal(outcome.error.status, 403)
    assert.equal(unauthorizedCalls, 0)
  })

  it('SESSION_EXPIRED 触发 onUnauthorized', async () => {
    const platform = new FakePlatform()
    platform.enqueueJson(401, apiErrorBody('SESSION_EXPIRED'))
    const unauthorized: ApiError[] = []

    const outcome = await createClient(platform, {
      accessToken: FAKE_ACCESS_TOKEN,
      onUnauthorized: (error) => {
        unauthorized.push(error)
      }
    }).call({
      method: 'GET',
      path: '/api/v1/me',
      envelope: householdPageSuccessSchema
    })

    assert.equal(outcome.kind, 'apiError')
    assert.equal(unauthorized.length, 1)
    assert.equal(unauthorized[0]?.code, 'SESSION_EXPIRED')
  })

  it('传输失败返回 transportError', async () => {
    const platform = new FakePlatform()
    platform.enqueueResponse(new Error('network request failed: timeout'))

    const outcome = await createClient(platform).call({
      method: 'GET',
      path: '/api/v1/households',
      envelope: householdPageSuccessSchema
    })

    assert.equal(outcome.kind, 'transportError')
    if (outcome.kind !== 'transportError') {
      return
    }
    assert.match(outcome.message, /timeout/)
  })

  it('非 JSON 响应与不合契约的成功响应都归为 malformedResponse', async () => {
    const platform = new FakePlatform()
    platform.enqueueResponse({ statusCode: 200, body: '<html></html>' })
    platform.enqueueJson(200, { ok: true, data: { wrong: true } })

    const client = createClient(platform)
    const first = await client.call({
      method: 'GET',
      path: '/api/v1/households',
      envelope: householdPageSuccessSchema
    })
    const second = await client.call({
      method: 'GET',
      path: '/api/v1/households',
      envelope: householdPageSuccessSchema
    })

    assert.equal(first.kind, 'malformedResponse')
    assert.equal(second.kind, 'malformedResponse')
  })

  it('不合 problem+json 契约的错误响应归为 malformedResponse', async () => {
    const platform = new FakePlatform()
    platform.enqueueJson(500, { message: 'boom' })

    const outcome = await createClient(platform).call({
      method: 'GET',
      path: '/api/v1/households',
      envelope: householdPageSuccessSchema
    })

    assert.equal(outcome.kind, 'malformedResponse')
  })
})
