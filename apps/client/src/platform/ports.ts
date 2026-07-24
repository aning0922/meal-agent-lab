/**
 * 平台端口：页面与核心逻辑只依赖这些接口，唯一的 Taro/wx 触点在
 * `taro-adapter.ts`。测试注入 fake 实现（见 tests/support）。
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface HttpRequest {
  readonly method: HttpMethod
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** 已序列化的 JSON 请求体；无请求体时省略。 */
  readonly body?: string
}

export interface HttpResponse {
  readonly statusCode: number
  /** 原始响应体文本；JSON 解析由核心层负责，保证各端行为一致。 */
  readonly body: string
}

/** 传输失败（无 HTTP 状态码）时 reject；任何 HTTP 状态码都 resolve。 */
export interface NetworkPort {
  request(request: HttpRequest): Promise<HttpResponse>
}

export interface StoragePort {
  /** 键不存在时返回 undefined。 */
  get(key: string): unknown
  set(key: string, value: unknown): void
  remove(key: string): void
}

/** 获取平台登录凭证（微信 wx.login code）。 */
export interface AuthPort {
  getLoginCode(): Promise<string>
}

export const LOGIN_ROUTE = '/pages/login/index'
export const HOUSEHOLDS_ROUTE = '/pages/households/index'
export const INVENTORY_ROUTE = '/pages/inventory/index'
export const MEMBERS_ROUTE = '/pages/members/index'
export const PROFILE_ROUTE = '/pages/profile/index'

export type AppRoute =
  | typeof LOGIN_ROUTE
  | typeof HOUSEHOLDS_ROUTE
  | typeof INVENTORY_ROUTE
  | typeof MEMBERS_ROUTE
  | typeof PROFILE_ROUTE

export interface NavigationPort {
  /** 清空页面栈并跳转（用于登录态变化）。 */
  reLaunch(route: AppRoute): Promise<void>
  navigateTo(route: AppRoute): Promise<void>
  navigateBack(): Promise<void>
}

export interface RuntimePort {
  /** 当前 Unix 毫秒时间。 */
  nowMs(): number
  /** 每次调用返回不同的 [A-Za-z0-9-] 随机串（用于幂等键，非密码学用途）。 */
  randomToken(): string
}

export interface PlatformAdapter {
  readonly auth: AuthPort
  readonly network: NetworkPort
  readonly storage: StoragePort
  readonly navigation: NavigationPort
  readonly runtime: RuntimePort
}
