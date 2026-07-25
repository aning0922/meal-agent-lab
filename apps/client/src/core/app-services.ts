import type { ApiError } from '@meal-agent/contracts/api'
import type { AuthenticatedSession } from '@meal-agent/contracts/identity'

import {
  LOGIN_ROUTE,
  type AppRoute,
  type PlatformAdapter
} from '../platform/ports'
import { ApiClient } from './api-client'
import { PendingCommandDispatcher } from './command-dispatcher'
import { createApiEndpoints, type ApiEndpoints } from './endpoints'
import { PendingActionIdempotency } from './idempotency'
import { SessionStore } from './session-store'

export type NavigationDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'denied'
      readonly reason: 'pending-command'
      readonly ownerRoute: AppRoute
    }

export interface CoordinatedNavigation {
  reLaunch(
    route: AppRoute,
    onAllowed?: () => void
  ): Promise<NavigationDecision>
  navigateTo(
    route: AppRoute,
    onAllowed?: () => void
  ): Promise<NavigationDecision>
  navigateBack(): Promise<NavigationDecision>
}

export interface AppServices {
  readonly adapter: PlatformAdapter
  readonly session: SessionStore
  readonly api: ApiEndpoints
  readonly pendingCommands: PendingActionIdempotency
  readonly commands: PendingCommandDispatcher
  /**
   * 所有程序化导航的集中决策点。返回明确 allowed/denied；家庭上下文
   * 修改只能放在 onAllowed 中，不能先改 storage 再发现导航被拒绝。
   */
  readonly navigation: CoordinatedNavigation
  authenticate(
    session: AuthenticatedSession
  ): 'fresh' | 'resumed' | 'replaced'
  canSignOut(): boolean
  consumeUnauthorizedNotice(): string | null
}

export const createAppServices = (
  adapter: PlatformAdapter,
  baseUrl: string
): AppServices => {
  const session = new SessionStore(adapter.storage, adapter.runtime)
  const pendingCommands = new PendingActionIdempotency(
    adapter.runtime,
    () => session.authenticationContext()
  )

  const authorizeNavigation = (
    route: AppRoute,
    hasContextMutation: boolean
  ): NavigationDecision => {
    const status = pendingCommands.status()
    if (status.phase === 'idle') return { kind: 'allowed' }
    // 仅允许回到命令 owner route 展示全局恢复入口；存在 pending 时不
    // 允许同时改变 session/currentHousehold。
    if (route === status.ownerRoute && !hasContextMutation) {
      return { kind: 'allowed' }
    }
    return {
      kind: 'denied',
      reason: 'pending-command',
      ownerRoute: status.ownerRoute
    }
  }

  const navigation: CoordinatedNavigation = {
    async reLaunch(route, onAllowed) {
      const decision = authorizeNavigation(
        route,
        onAllowed !== undefined
      )
      if (decision.kind === 'denied') return decision
      onAllowed?.()
      await adapter.navigation.reLaunch(route)
      return decision
    },
    async navigateTo(route, onAllowed) {
      const decision = authorizeNavigation(
        route,
        onAllowed !== undefined
      )
      if (decision.kind === 'denied') return decision
      onAllowed?.()
      await adapter.navigation.navigateTo(route)
      return decision
    },
    async navigateBack() {
      const status = pendingCommands.status()
      if (status.phase !== 'idle') {
        return {
          kind: 'denied',
          reason: 'pending-command',
          ownerRoute: status.ownerRoute
        }
      }
      await adapter.navigation.navigateBack()
      return { kind: 'allowed' }
    }
  }

  let unauthorizedNotice: string | null = null
  let redirectingToLogin = false

  const handleUnauthorized = (error: ApiError): void => {
    // 401 不是“命令未执行”的证明。先 suspend 保留 envelope，再清会话；
    // 请求栈稍后的 settle 也不能删除 auth-suspended 命令。
    const hadPendingCommand = pendingCommands.hasAnyPending()
    pendingCommands.suspendForAuthentication()
    session.clear()
    unauthorizedNotice =
      error.code === 'SESSION_EXPIRED'
        ? hadPendingCommand
          ? '会话已过期。请使用同一账号重新登录后恢复未决命令。'
          : '会话已过期，请重新登录。'
        : hadPendingCommand
          ? '需要使用原账号登录后才能继续未决命令。'
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

  let services: AppServices
  const commands = new PendingCommandDispatcher(
    () => services,
    pendingCommands
  )
  services = {
    adapter,
    session,
    api: createApiEndpoints(client),
    pendingCommands,
    commands,
    navigation,
    authenticate(authenticatedSession) {
      const generation = session.save(authenticatedSession)
      return pendingCommands.resumeAuthentication({
        principalId: authenticatedSession.user.id,
        generation
      })
    },
    canSignOut() {
      return !pendingCommands.hasAnyPending()
    },
    consumeUnauthorizedNotice() {
      const notice = unauthorizedNotice
      unauthorizedNotice = null
      return notice
    }
  }
  return services
}
