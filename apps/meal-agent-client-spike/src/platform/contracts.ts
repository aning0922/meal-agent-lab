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

export interface MockAuthSession {
  createdAt: string
  displayName: '阶段 04 Mock 用户'
  source: 'mock'
  userId: 'stage-04-mock-user'
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

export type VerificationResult =
  | 'Pass'
  | 'Fail'
  | 'Deferred — 外部依赖'
  | 'Not applicable'

export interface CapabilityRecord {
  name:
    | '本地存储'
    | 'Mock API 网络'
    | '页面导航'
    | 'Mock 登录'
    | '真实微信登录'
    | '相机'
    | '分享'
    | '外部通知'
  result: VerificationResult
}

export interface AuthPort {
  login(): Promise<MockAuthSession>
  logout(): void
  restore(): MockAuthSession | null
}

export interface StoragePort {
  loadDraft(): SpikeDraft
  saveDraft(note: string): SpikeDraft
}

export interface NetworkPort {
  loadTodaySignal(): Promise<SpikeApiResult>
}

export interface PlatformAdapter {
  capabilities: readonly CapabilityRecord[]
  auth: AuthPort
  network: NetworkPort
  navigation: {
    openInventory(): Promise<void>
    openToday(): Promise<void>
  }
  storage: StoragePort
}
