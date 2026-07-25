import {
  idempotencyKeySchema,
  type IdempotencyKey
} from '@meal-agent/contracts/api'

import type { RuntimePort } from '../platform/ports'

/**
 * 每个"逻辑写操作"生成一次幂等键；同一操作的自动或手动重试必须复用
 * 同一个键（由页面状态持有，成功或用户放弃后才丢弃）。
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

export interface PendingActionSnapshot {
  readonly key: IdempotencyKey
  readonly payload: unknown
  readonly phase: 'in-flight' | 'unknown'
}

/**
 * 仅驻留内存的“同一次进行中动作”键仓库。同 action + 同 payload 的重试
 * 复用 key；进行中动作的字段不得漂移，必须先完成或显式放弃。应用重启
 * 后仓库自然清空，页面先 GET 对账，不持久化请求体或敏感字段。
 */
export class PendingActionIdempotency {
  readonly #runtime: RuntimePort
  readonly #pending = new Map<
    string,
    {
      readonly fingerprint: string
      readonly key: IdempotencyKey
      readonly payload: unknown
      phase: 'in-flight' | 'unknown'
    }
  >()

  public constructor(runtime: RuntimePort) {
    this.#runtime = runtime
  }

  public acquire(action: string, payload: unknown): IdempotencyKey {
    const snapshot = canonicalize(payload)
    const fingerprint = JSON.stringify(snapshot)
    const existing = this.#pending.get(action)
    if (existing?.fingerprint === fingerprint) {
      existing.phase = 'in-flight'
      return existing.key
    }
    if (existing !== undefined) {
      throw new Error(
        `pending idempotent action payload changed: ${action}`
      )
    }
    const key = createIdempotencyKey(this.#runtime)
    this.#pending.set(action, {
      fingerprint,
      key,
      payload: snapshot,
      phase: 'in-flight'
    })
    return key
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

  public snapshot(action: string): PendingActionSnapshot | null {
    const pending = this.#pending.get(action)
    return pending === undefined
      ? null
      : {
          key: pending.key,
          payload: pending.payload,
          phase: pending.phase
        }
  }

  public complete(action: string): void {
    this.settle(action, 'completed')
  }

  /**
   * 只可在 GET 对账或服务端明确给出“未执行”后调用。它不应由 onInput
   * 隐式触发，否则结果未知的命令会换 key 重复执行。
   */
  public abandon(action: string): void {
    this.settle(action, 'definite-failure')
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
