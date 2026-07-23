import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlatformAdapter } from '../src/platform/create-platform-adapter'
import {
  INVENTORY_ROUTE,
  TODAY_ROUTE,
  type RuntimePort,
  type RuntimeResponse
} from '../src/platform/contracts'

function createFakeRuntime() {
  const storage = new Map<string, unknown>()
  const requestedUrls: string[] = []
  const navigationUrls: string[] = []

  const runtime: RuntimePort = {
    getStorage: (key) => storage.get(key),
    async request<T>(url: string): Promise<RuntimeResponse<T>> {
      requestedUrls.push(url)
      return {
        data: {
          generatedAt: '2026-07-23T00:00:00.000Z',
          message: 'ok',
          source: 'local-mock'
        } as T,
        statusCode: 200
      }
    },
    setStorage: (key, value) => {
      storage.set(key, value)
    },
    async switchTab(url) {
      navigationUrls.push(url)
    }
  }

  return { navigationUrls, requestedUrls, runtime }
}

test('persists and reloads a spike draft through the storage port', () => {
  const { runtime } = createFakeRuntime()
  const adapter = createPlatformAdapter(runtime)

  assert.deepEqual(adapter.storage.loadDraft(), { note: '', updatedAt: null })

  const saved = adapter.storage.saveDraft('adapter boundary')
  assert.equal(saved.note, 'adapter boundary')
  assert.match(saved.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(adapter.storage.loadDraft(), saved)
})

test('calls the configured mock API through the request port', async () => {
  const { requestedUrls, runtime } = createFakeRuntime()
  const adapter = createPlatformAdapter(runtime, 'http://example.test')

  const result = await adapter.network.loadTodaySignal()

  assert.equal(result.source, 'local-mock')
  assert.deepEqual(requestedUrls, ['http://example.test/spike/today'])
})

test('routes both tab pages through the navigation port', async () => {
  const { navigationUrls, runtime } = createFakeRuntime()
  const adapter = createPlatformAdapter(runtime)

  await adapter.navigation.openInventory()
  await adapter.navigation.openToday()

  assert.deepEqual(navigationUrls, [INVENTORY_ROUTE, TODAY_ROUTE])
})

test('persists and clears a mock session through the auth port', async () => {
  const { runtime } = createFakeRuntime()
  const adapter = createPlatformAdapter(runtime)

  assert.equal(adapter.auth.restore(), null)

  const session = await adapter.auth.login()
  assert.equal(session.source, 'mock')
  assert.equal(session.userId, 'stage-04-mock-user')
  assert.deepEqual(adapter.auth.restore(), session)

  adapter.auth.logout()
  assert.equal(adapter.auth.restore(), null)
})

test('uses the four allowed verification results without overstating deferred work', () => {
  const { runtime } = createFakeRuntime()
  const adapter = createPlatformAdapter(runtime)
  const byName = new Map(
    adapter.capabilities.map(({ name, result }) => [name, result])
  )

  assert.equal(byName.get('本地存储'), 'Pass')
  assert.equal(byName.get('Mock API 网络'), 'Pass')
  assert.equal(byName.get('Mock 登录'), 'Pass')
  assert.equal(byName.get('真实微信登录'), 'Deferred — 外部依赖')
  assert.equal(byName.get('分享'), 'Deferred — 外部依赖')
  assert.equal(byName.get('相机'), 'Not applicable')
  assert.equal(byName.get('外部通知'), 'Not applicable')
  assert.equal(
    adapter.capabilities.some(
      ({ name, result }) =>
        name === '真实微信登录' && result === 'Pass'
    ),
    false
  )
})
