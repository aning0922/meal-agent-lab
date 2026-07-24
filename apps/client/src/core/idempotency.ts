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
