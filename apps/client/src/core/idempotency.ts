import {
  idempotencyKeySchema,
  type IdempotencyKey
} from '@meal-agent/contracts/api'

import type { RuntimePort } from '../platform/ports'

/**
 * 每个"逻辑写操作"生成一次幂等键；同一操作的自动或手动重试必须复用
 * 同一个键（由 app 级内存协调器持有，成功或确定失败后才丢弃）。
 */
export const createIdempotencyKey = (
  runtime: RuntimePort
): IdempotencyKey => idempotencyKeySchema.parse(`c07-${runtime.randomToken()}`)

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
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

export interface PendingActionSnapshot<T = unknown> {
  readonly action: string
  readonly key: IdempotencyKey
  readonly payload: T
  readonly phase: 'in-flight' | 'unknown'
  readonly observation?: PendingCommandObservation
}

export interface PendingCommandObservation {
  readonly action: string
  readonly key: IdempotencyKey
  readonly kind: 'resource-get'
  readonly observedAt: string
  readonly summary: string
}

/**
 * 仅驻留内存的“同一次进行中动作”键仓库。同 action + 同 payload 的重试
 * 复用 key；进行中动作的字段不得漂移。普通资源 GET 只可记录观察证据，
 * 不能证明命令已执行或未执行，也不能释放未知命令。应用重启后仓库自然
 * 清空，不持久化请求体、邀请码或私密约束。
 */
export class PendingActionIdempotency {
  readonly #runtime: RuntimePort
  readonly #pending = new Map<
    string,
    {
      readonly key: IdempotencyKey
      readonly payload: unknown
      phase: 'in-flight' | 'unknown'
      observation?: PendingCommandObservation
    }
  >()

  public constructor(runtime: RuntimePort) {
    this.#runtime = runtime
  }

  public acquire(action: string, payload: unknown): IdempotencyKey {
    return this.acquireSnapshot(action, payload).key
  }

  /**
   * 首次调用保存完整规范化命令；同 action 重试永远返回原快照，即使 GET
   * 刷新改变了页面中的 lot/profile。调用方必须从返回的 payload 执行请求。
   */
  public acquireSnapshot<T>(
    action: string,
    payload: T
  ): PendingActionSnapshot<T> {
    const snapshot = canonicalize(payload)
    const existing = this.#pending.get(action)
    if (existing !== undefined) {
      existing.phase = 'in-flight'
      delete existing.observation
      return {
        action,
        key: existing.key,
        payload: existing.payload as T,
        phase: existing.phase
      }
    }
    if (this.#pending.size > 0) {
      throw new Error(
        'another pending command must be retried before starting a new action'
      )
    }
    const key = createIdempotencyKey(this.#runtime)
    this.#pending.set(action, {
      key,
      payload: snapshot,
      phase: 'in-flight'
    })
    return {
      action,
      key,
      payload: snapshot as T,
      phase: 'in-flight'
    }
  }

  public settle(action: string, disposition: CommandDisposition): void {
    if (disposition === 'unknown') {
      const pending = this.#pending.get(action)
      if (pending !== undefined) {
        pending.phase = 'unknown'
      }
      return
    }
    this.#pending.delete(action)
  }

  public markUnknown(action: string): void {
    this.settle(action, 'unknown')
  }

  public hasPending(action: string): boolean {
    return this.#pending.has(action)
  }

  public hasAnyPending(): boolean {
    return this.#pending.size > 0
  }

  public snapshot<T = unknown>(
    action: string
  ): PendingActionSnapshot<T> | null {
    const pending = this.#pending.get(action)
    return pending === undefined
      ? null
      : {
          action,
          key: pending.key,
          payload: pending.payload as T,
          phase: pending.phase,
          ...(pending.observation === undefined
            ? {}
            : { observation: pending.observation })
        }
  }

  public activeSnapshot<T = unknown>(): PendingActionSnapshot<T> | null {
    const entry = this.#pending.entries().next()
    if (entry.done) return null
    const [action, pending] = entry.value
    return {
      action,
      key: pending.key,
      payload: pending.payload as T,
      phase: pending.phase,
      ...(pending.observation === undefined
        ? {}
        : { observation: pending.observation })
    }
  }

  public hasOtherPending(action: string): boolean {
    return [...this.#pending.keys()].some((key) => key !== action)
  }

  public complete(action: string): void {
    this.settle(action, 'completed')
  }

  /**
   * 普通 GET 观察严格绑定当前 action + key，但它不是 command-status，
   * 不开放 complete/abandon。下一次 retry 会先清除此观察。
   */
  public recordObservation(
    action: string,
    key: IdempotencyKey,
    observation: Omit<
      PendingCommandObservation,
      'action' | 'key'
    >
  ): void {
    const pending = this.#pending.get(action)
    if (
      pending === undefined ||
      pending.key !== key ||
      pending.phase !== 'unknown'
    ) {
      throw new Error('observation does not match the pending command')
    }
    pending.observation = { action, key, ...observation }
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
    outcome.kind === 'removed'
  ) {
    return 'completed'
  }
  // 本地 invalid 以及服务端 400/403/404/409 都是确定结果。
  return 'definite-failure'
}
