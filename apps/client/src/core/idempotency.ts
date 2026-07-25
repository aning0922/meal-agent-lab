import type { HouseholdId, UserId } from '@meal-agent/contracts'
import {
  idempotencyKeySchema,
  type IdempotencyKey
} from '@meal-agent/contracts/api'

import type { AppRoute, RuntimePort } from '../platform/ports'
import {
  householdIdForCommand,
  type AnyRegisteredCommand,
  type ClientCommandKind,
  type RegisteredCommand
} from './command-registry'

/**
 * 每个逻辑写操作只生成一次幂等键。同一次自动或手动重试必须复用
 * envelope 中的不可变 command snapshot 与 key。
 */
export const createIdempotencyKey = (
  runtime: RuntimePort
): IdempotencyKey => idempotencyKeySchema.parse(`c07-${runtime.randomToken()}`)

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    )
  }
  return value
}

export type CommandDisposition =
  | 'completed'
  | 'definite-failure'
  | 'unknown'

export interface PendingAuthenticationContext {
  readonly principalId: UserId
  readonly generation: number
}

export interface PendingCommandObservation {
  readonly action: string
  readonly key: IdempotencyKey
  readonly kind: 'resource-get'
  readonly observedAt: string
  readonly summary: string
}

export interface PendingCommandEnvelope<
  C = AnyRegisteredCommand
> {
  readonly action: string
  readonly key: IdempotencyKey
  readonly command: C
  readonly principalId: UserId
  readonly householdId: HouseholdId | null
  readonly ownerRoute: AppRoute
  readonly authGeneration: number
  readonly phase: 'in-flight' | 'unknown'
  readonly observation?: PendingCommandObservation
}

export type PendingCommandStatus =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'in-flight' | 'unknown' | 'auth-suspended'
      readonly action: string
      readonly commandKind: ClientCommandKind
      readonly ownerRoute: AppRoute
      readonly householdId: HouseholdId | null
    }

type StoredPending = {
  readonly action: string
  readonly key: IdempotencyKey
  readonly command: AnyRegisteredCommand
  readonly principalId: UserId
  readonly householdId: HouseholdId | null
  readonly ownerRoute: AppRoute
  authGeneration: number
  phase: 'in-flight' | 'unknown' | 'auth-suspended'
  resumePhase: 'in-flight' | 'unknown'
  observation?: PendingCommandObservation
}

/**
 * 全应用唯一、仅驻内存的 pending command coordinator。
 *
 * - envelope 同时绑定 principal、household、owner route 与认证 generation；
 * - 401 只 suspend，不删除未知命令；
 * - 同 principal 重登更新 generation 后恢复；不同 principal 登录销毁旧
 *   envelope，且新用户从未获得旧 payload/key 的读取或执行能力；
 * - 对外 status 是脱敏视图，payload 只在当前认证上下文严格匹配时可取。
 */
export class PendingActionIdempotency {
  readonly #listeners = new Set<() => void>()
  #pending: StoredPending | null = null

  public constructor(
    private readonly runtime: RuntimePort,
    private readonly authenticationContext: () =>
      PendingAuthenticationContext | null
  ) {}

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }

  public status(): PendingCommandStatus {
    const pending = this.#pending
    return pending === null
      ? { phase: 'idle' }
      : {
          phase: pending.phase,
          action: pending.action,
          commandKind: pending.command.kind,
          ownerRoute: pending.ownerRoute,
          householdId: pending.householdId
        }
  }

  public acquireCommand<K extends ClientCommandKind>(
    action: string,
    ownerRoute: AppRoute,
    command: RegisteredCommand<K>
  ): PendingCommandEnvelope<RegisteredCommand<K>> {
    const context = this.authenticationContext()
    if (context === null) {
      throw new Error('an authenticated principal is required')
    }
    const canonicalCommand = canonicalize(command) as RegisteredCommand<K>
    const householdId = householdIdForCommand(
      canonicalCommand as AnyRegisteredCommand
    )
    const existing = this.#pending
    if (existing !== null) {
      if (
        existing.action !== action ||
        existing.principalId !== context.principalId ||
        existing.authGeneration !== context.generation ||
        existing.phase === 'auth-suspended'
      ) {
        throw new Error(
          'another pending command must be resumed before starting a new action'
        )
      }
      existing.phase = 'in-flight'
      existing.resumePhase = 'in-flight'
      delete existing.observation
      this.#emit()
      return this.#visibleEnvelope(
        existing
      ) as PendingCommandEnvelope<RegisteredCommand<K>>
    }

    const pending: StoredPending = {
      action,
      key: createIdempotencyKey(this.runtime),
      command: canonicalCommand as AnyRegisteredCommand,
      principalId: context.principalId,
      householdId,
      ownerRoute,
      authGeneration: context.generation,
      phase: 'in-flight',
      resumePhase: 'in-flight'
    }
    this.#pending = pending
    this.#emit()
    return this.#visibleEnvelope(
      pending
    ) as PendingCommandEnvelope<RegisteredCommand<K>>
  }

  #visibleEnvelope(pending: StoredPending): PendingCommandEnvelope {
    if (pending.phase === 'auth-suspended') {
      throw new Error('authentication must resume before reading command')
    }
    return {
      action: pending.action,
      key: pending.key,
      command: pending.command,
      principalId: pending.principalId,
      householdId: pending.householdId,
      ownerRoute: pending.ownerRoute,
      authGeneration: pending.authGeneration,
      phase: pending.phase,
      ...(pending.observation === undefined
        ? {}
        : { observation: pending.observation })
    }
  }

  #isCurrent(pending: StoredPending): boolean {
    const context = this.authenticationContext()
    return (
      context !== null &&
      pending.phase !== 'auth-suspended' &&
      context.principalId === pending.principalId &&
      context.generation === pending.authGeneration
    )
  }

  public activeSnapshot(): PendingCommandEnvelope | null {
    const pending = this.#pending
    return pending !== null && this.#isCurrent(pending)
      ? this.#visibleEnvelope(pending)
      : null
  }

  public snapshot(action: string): PendingCommandEnvelope | null {
    const pending = this.#pending
    return pending !== null &&
      pending.action === action &&
      this.#isCurrent(pending)
      ? this.#visibleEnvelope(pending)
      : null
  }

  public settle(action: string, disposition: CommandDisposition): void {
    const pending = this.#pending
    if (pending === null || pending.action !== action) return
    // 401 handler may suspend while the request is unwinding. Never let the
    // later page/dispatcher disposition erase that unknown command.
    if (pending.phase === 'auth-suspended') return
    if (disposition === 'unknown') {
      pending.phase = 'unknown'
      pending.resumePhase = 'unknown'
      this.#emit()
      return
    }
    this.#pending = null
    this.#emit()
  }

  public markUnknown(action: string): void {
    this.settle(action, 'unknown')
  }

  public complete(action: string): void {
    this.settle(action, 'completed')
  }

  public hasPending(action: string): boolean {
    return this.#pending?.action === action
  }

  public hasAnyPending(): boolean {
    return this.#pending !== null
  }

  public hasOtherPending(action: string): boolean {
    return this.#pending !== null && this.#pending.action !== action
  }

  public suspendForAuthentication(): void {
    const pending = this.#pending
    if (pending === null || pending.phase === 'auth-suspended') return
    pending.resumePhase =
      pending.phase === 'in-flight' ? 'unknown' : pending.phase
    pending.phase = 'auth-suspended'
    delete pending.observation
    this.#emit()
  }

  public resumeAuthentication(
    context: PendingAuthenticationContext
  ): 'fresh' | 'resumed' | 'replaced' {
    const pending = this.#pending
    if (pending === null) return 'fresh'
    if (pending.principalId !== context.principalId) {
      // Fail closed: do not retain a sensitive payload/key in a process now
      // controlled by another authenticated principal.
      this.#pending = null
      this.#emit()
      return 'replaced'
    }
    if (pending.phase !== 'auth-suspended') {
      if (pending.authGeneration !== context.generation) {
        this.#pending = null
        this.#emit()
        return 'replaced'
      }
      return 'resumed'
    }
    pending.authGeneration = context.generation
    pending.phase = pending.resumePhase
    this.#emit()
    return 'resumed'
  }

  /**
   * 普通 GET 只记录观察，不能释放未知命令；观察严格绑定 action+key。
   */
  public recordObservation(
    action: string,
    key: IdempotencyKey,
    observation: Omit<PendingCommandObservation, 'action' | 'key'>
  ): void {
    const pending = this.#pending
    if (
      pending === null ||
      !this.#isCurrent(pending) ||
      pending.action !== action ||
      pending.key !== key ||
      pending.phase !== 'unknown'
    ) {
      throw new Error('observation does not match the pending command')
    }
    pending.observation = { action, key, ...observation }
    this.#emit()
  }
}

export const dispositionForOutcome = (
  outcome: {
    readonly kind: string
    readonly executionUnknown?: boolean
    readonly error?: { readonly status?: number }
  }
): CommandDisposition => {
  if (
    outcome.kind === 'transportError' ||
    outcome.kind === 'malformedResponse'
  ) {
    return 'unknown'
  }
  if (outcome.kind === 'apiError') {
    return (outcome.error?.status ?? 500) >= 500
      ? 'unknown'
      : 'definite-failure'
  }
  if (outcome.kind === 'failed') {
    return outcome.executionUnknown === false
      ? 'definite-failure'
      : 'unknown'
  }
  if (
    outcome.kind === 'created' ||
    outcome.kind === 'success' ||
    outcome.kind === 'consumed' ||
    outcome.kind === 'joined' ||
    outcome.kind === 'updated' ||
    outcome.kind === 'changed' ||
    outcome.kind === 'linked' ||
    outcome.kind === 'archived' ||
    outcome.kind === 'restored' ||
    outcome.kind === 'removed' ||
    outcome.kind === 'revoked'
  ) {
    return 'completed'
  }
  return 'definite-failure'
}
