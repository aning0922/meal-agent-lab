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

  assert.deepEqual(adapter.draft.load(), { note: '', updatedAt: null })

  const saved = adapter.draft.save('adapter boundary')
  assert.equal(saved.note, 'adapter boundary')
  assert.match(saved.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(adapter.draft.load(), saved)
})

test('calls the configured mock API through the request port', async () => {
  const { requestedUrls, runtime } = createFakeRuntime()
  const adapter = createPlatformAdapter(runtime, 'http://example.test')

  const result = await adapter.mockApi.loadTodaySignal()

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

test('marks P0 spike capabilities separately from future boundaries', () => {
  const { runtime } = createFakeRuntime()
  const adapter = createPlatformAdapter(runtime)
  const implemented = adapter.capabilities
    .filter(({ verification }) => verification === 'implemented')
    .map(({ name }) => name)

  assert.deepEqual(implemented, ['本地存储', '网络请求', '页面导航'])
})
