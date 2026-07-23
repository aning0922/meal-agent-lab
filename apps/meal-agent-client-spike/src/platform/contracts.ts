export const TODAY_ROUTE = '/pages/today/index'
export const INVENTORY_ROUTE = '/pages/inventory/index'

export interface SpikeDraft {
  note: string
  updatedAt: string | null
}

export interface SpikeApiResult {
  generatedAt: string
  message: string
  source: 'local-mock'
}

export interface RuntimeResponse<T> {
  data: T
  statusCode: number
}

export interface RuntimePort {
  getStorage(key: string): unknown
  request<T>(url: string): Promise<RuntimeResponse<T>>
  setStorage(key: string, value: unknown): void
  switchTab(url: string): Promise<void>
}

export type CapabilityVerification = 'implemented' | 'boundary-only'

export interface CapabilityRecord {
  name: '本地存储' | '网络请求' | '页面导航' | '登录' | '相机' | '分享' | '通知'
  verification: CapabilityVerification
}

export interface PlatformAdapter {
  capabilities: readonly CapabilityRecord[]
  draft: {
    load(): SpikeDraft
    save(note: string): SpikeDraft
  }
  mockApi: {
    loadTodaySignal(): Promise<SpikeApiResult>
  }
  navigation: {
    openInventory(): Promise<void>
    openToday(): Promise<void>
  }
}
