import {
  INVENTORY_ROUTE,
  TODAY_ROUTE,
  type CapabilityRecord,
  type PlatformAdapter,
  type RuntimePort,
  type SpikeApiResult,
  type SpikeDraft
} from './contracts'

const DRAFT_STORAGE_KEY = 'meal-agent-client-spike:draft:v1'

const CAPABILITIES: readonly CapabilityRecord[] = [
  { name: '本地存储', verification: 'implemented' },
  { name: '网络请求', verification: 'implemented' },
  { name: '页面导航', verification: 'implemented' },
  { name: '登录', verification: 'boundary-only' },
  { name: '相机', verification: 'boundary-only' },
  { name: '分享', verification: 'boundary-only' },
  { name: '通知', verification: 'boundary-only' }
]

const EMPTY_DRAFT: SpikeDraft = {
  note: '',
  updatedAt: null
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
    draft: {
      load() {
        const stored = runtime.getStorage(DRAFT_STORAGE_KEY)
        return isSpikeDraft(stored) ? stored : EMPTY_DRAFT
      },
      save(note) {
        const draft: SpikeDraft = {
          note,
          updatedAt: new Date().toISOString()
        }
        runtime.setStorage(DRAFT_STORAGE_KEY, draft)
        return draft
      }
    },
    mockApi: {
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
    }
  }
}
