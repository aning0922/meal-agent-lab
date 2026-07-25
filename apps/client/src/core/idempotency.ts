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

/**
 * 仅驻留内存的“同一次进行中动作”键仓库。同 action + 同 payload 的重试
 * 复用 key；字段变化会开启新命令。应用重启后仓库自然清空，页面先 GET
 * 对账，不持久化请求体或敏感字段。
 */
export class PendingActionIdempotency {
  readonly #runtime: RuntimePort
  readonly #pending = new Map<
    string,
    { readonly fingerprint: string; readonly key: IdempotencyKey }
  >()

  public constructor(runtime: RuntimePort) {
    this.#runtime = runtime
  }

  public acquire(action: string, payload: unknown): IdempotencyKey {
    const fingerprint = JSON.stringify(canonicalize(payload))
    const existing = this.#pending.get(action)
    if (existing?.fingerprint === fingerprint) {
      return existing.key
    }
    const key = createIdempotencyKey(this.#runtime)
    this.#pending.set(action, { fingerprint, key })
    return key
  }

  public complete(action: string): void {
    this.#pending.delete(action)
  }

  public abandon(action: string): void {
    this.#pending.delete(action)
  }
}
