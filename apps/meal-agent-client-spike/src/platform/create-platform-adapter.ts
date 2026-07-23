import {
  INVENTORY_ROUTE,
  TODAY_ROUTE,
  type CapabilityRecord,
  type MockAuthSession,
  type PlatformAdapter,
  type RuntimePort,
  type SpikeApiResult,
  type SpikeDraft
} from './contracts'

const DRAFT_STORAGE_KEY = 'meal-agent-client-spike:draft:v1'
const MOCK_AUTH_STORAGE_KEY = 'meal-agent-client-spike:mock-auth:v1'

const CAPABILITIES: readonly CapabilityRecord[] = [
  { name: '本地存储', result: 'Pass' },
  { name: 'Mock API 网络', result: 'Pass' },
  { name: '页面导航', result: 'Pass' },
  { name: 'Mock 登录', result: 'Pass' },
  { name: '真实微信登录', result: 'Deferred — 外部依赖' },
  { name: '分享', result: 'Deferred — 外部依赖' },
  { name: '相机', result: 'Not applicable' },
  { name: '外部通知', result: 'Not applicable' }
]

const EMPTY_DRAFT: SpikeDraft = {
  note: '',
  updatedAt: null
}

function isMockAuthSession(value: unknown): value is MockAuthSession {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<MockAuthSession>
  return (
    candidate.createdAt !== undefined &&
    typeof candidate.createdAt === 'string' &&
    candidate.displayName === '阶段 04 Mock 用户' &&
    candidate.source === 'mock' &&
    candidate.userId === 'stage-04-mock-user'
  )
}

function isSpikeDraft(value: unknown): value is SpikeDraft {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<SpikeDraft>
  return (
    typeof candidate.note === 'string' &&
    (candidate.updatedAt === null || typeof candidate.updatedAt === 'string')
  )
}

export function createPlatformAdapter(
  runtime: RuntimePort,
  mockApiBaseUrl = 'http://127.0.0.1:8787'
): PlatformAdapter {
  return {
    capabilities: CAPABILITIES,
    auth: {
      async login() {
        const session: MockAuthSession = {
          createdAt: new Date().toISOString(),
          displayName: '阶段 04 Mock 用户',
          source: 'mock',
          userId: 'stage-04-mock-user'
        }
        runtime.setStorage(MOCK_AUTH_STORAGE_KEY, session)
        return session
      },
      logout() {
        runtime.setStorage(MOCK_AUTH_STORAGE_KEY, null)
      },
      restore() {
        const stored = runtime.getStorage(MOCK_AUTH_STORAGE_KEY)
        return isMockAuthSession(stored) ? stored : null
      }
    },
    network: {
      async loadTodaySignal() {
        const response = await runtime.request<SpikeApiResult>(
          `${mockApiBaseUrl}/spike/today`
        )

        if (response.statusCode !== 200) {
          throw new Error(`模拟 API 返回 ${response.statusCode}`)
        }
        if (response.data.source !== 'local-mock') {
          throw new Error('模拟 API 响应来源不符合契约')
        }

        return response.data
      }
    },
    navigation: {
      openInventory: () => runtime.switchTab(INVENTORY_ROUTE),
      openToday: () => runtime.switchTab(TODAY_ROUTE)
    },
    storage: {
      loadDraft() {
        const stored = runtime.getStorage(DRAFT_STORAGE_KEY)
        return isSpikeDraft(stored) ? stored : EMPTY_DRAFT
      },
      saveDraft(note) {
        const draft: SpikeDraft = {
          note,
          updatedAt: new Date().toISOString()
        }
        runtime.setStorage(DRAFT_STORAGE_KEY, draft)
        return draft
      }
    }
  }
}
