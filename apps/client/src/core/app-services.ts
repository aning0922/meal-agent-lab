import type { ApiError } from '@meal-agent/contracts/api'

import {
  LOGIN_ROUTE,
  type NavigationPort,
  type PlatformAdapter
} from '../platform/ports'
import { ApiClient } from './api-client'
import { createApiEndpoints, type ApiEndpoints } from './endpoints'
import { PendingActionIdempotency } from './idempotency'
import { SessionStore } from './session-store'

export interface AppServices {
  readonly adapter: PlatformAdapter
  readonly session: SessionStore
  readonly api: ApiEndpoints
  /** 全应用唯一的内存命令协调器；任何时刻最多允许一个未决写命令。 */
  readonly pendingCommands: PendingActionIdempotency
  /** 未决命令存在时 fail-closed 的页面导航；认证失效跳登录由组合根直达。 */
  readonly navigation: NavigationPort
  /** 读取并清除最近一次 401 引导的提示文案（登录页展示用）。 */
  consumeUnauthorizedNotice(): string | null
}

/**
 * 组合根：本文件不依赖 Taro，可在 Node 测试中用 fake 平台适配器组装。
 * 401（未认证 / 会话过期）统一在这里清会话并重定向到登录页。
 */
export const createAppServices = (
  adapter: PlatformAdapter,
  baseUrl: string
): AppServices => {
  const session = new SessionStore(adapter.storage, adapter.runtime)
  const pendingCommands = new PendingActionIdempotency(adapter.runtime)
  const navigation: NavigationPort = {
    async reLaunch(route) {
      if (!pendingCommands.hasAnyPending()) {
        await adapter.navigation.reLaunch(route)
      }
    },
    async navigateTo(route) {
      if (!pendingCommands.hasAnyPending()) {
        await adapter.navigation.navigateTo(route)
      }
    },
    async navigateBack() {
      if (!pendingCommands.hasAnyPending()) {
        await adapter.navigation.navigateBack()
      }
    }
  }
  let unauthorizedNotice: string | null = null
  let redirectingToLogin = false

  const handleUnauthorized = (error: ApiError): void => {
    session.clear()
    unauthorizedNotice =
      error.code === 'SESSION_EXPIRED'
        ? '会话已过期，请重新登录。'
        : '需要登录后才能继续。'
    if (!redirectingToLogin) {
      redirectingToLogin = true
      void adapter.navigation
        .reLaunch(LOGIN_ROUTE)
        .catch(() => undefined)
        .then(() => {
          redirectingToLogin = false
        })
    }
  }

  const client = new ApiClient({
    baseUrl,
    network: adapter.network,
    getAccessToken: () => session.restore()?.accessToken,
    onUnauthorized: handleUnauthorized
  })

  return {
    adapter,
    session,
    api: createApiEndpoints(client),
    pendingCommands,
    navigation,
    consumeUnauthorizedNotice() {
      const notice = unauthorizedNotice
      unauthorizedNotice = null
      return notice
    }
  }
}
