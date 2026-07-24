import {
  authenticatedSessionSchema,
  type AuthenticatedSession
} from '@meal-agent/contracts/identity'
import { householdIdSchema, type HouseholdId } from '@meal-agent/contracts'

import type { RuntimePort, StoragePort } from '../platform/ports'

const SESSION_STORAGE_KEY = 'meal-agent.session.v1'
const CURRENT_HOUSEHOLD_STORAGE_KEY = 'meal-agent.current-household.v1'

/**
 * 会话与当前家庭的持久化。恢复时经契约模式校验：损坏或过期的存量
 * 数据一律清除并按未登录处理；expiresAt 只是本地提示，服务端 401 才是
 * 会话失效的最终事实。
 */
export class SessionStore {
  public constructor(
    private readonly storage: StoragePort,
    private readonly runtime: RuntimePort
  ) {}

  public save(session: AuthenticatedSession): void {
    this.storage.set(SESSION_STORAGE_KEY, session)
  }

  public restore(): AuthenticatedSession | null {
    const raw = this.storage.get(SESSION_STORAGE_KEY)
    if (raw === undefined) {
      return null
    }

    const parsed = authenticatedSessionSchema.safeParse(raw)
    if (!parsed.success) {
      this.clear()
      return null
    }

    if (
      Date.parse(parsed.data.session.expiresAt) <= this.runtime.nowMs()
    ) {
      this.clear()
      return null
    }

    return parsed.data
  }

  public clear(): void {
    this.storage.remove(SESSION_STORAGE_KEY)
    this.storage.remove(CURRENT_HOUSEHOLD_STORAGE_KEY)
  }

  public saveCurrentHouseholdId(householdId: HouseholdId): void {
    this.storage.set(CURRENT_HOUSEHOLD_STORAGE_KEY, householdId)
  }

  public restoreCurrentHouseholdId(): HouseholdId | null {
    const raw = this.storage.get(CURRENT_HOUSEHOLD_STORAGE_KEY)
    if (raw === undefined) {
      return null
    }
    const parsed = householdIdSchema.safeParse(raw)
    if (!parsed.success) {
      this.storage.remove(CURRENT_HOUSEHOLD_STORAGE_KEY)
      return null
    }
    return parsed.data
  }

  public clearCurrentHouseholdId(): void {
    this.storage.remove(CURRENT_HOUSEHOLD_STORAGE_KEY)
  }
}
