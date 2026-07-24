import type { IdempotencyKey } from '@meal-agent/contracts/api'
import type { Confidence, HouseholdId } from '@meal-agent/contracts'
import type { InventoryLotPage } from '@meal-agent/contracts/http'
import {
  consumeInventoryLotRequestSchema,
  createInventoryLotRequestSchema,
  type ConsumeInventoryLotResult,
  type CreateInventoryLotResult,
  type InventoryLot,
  type StorageLocation
} from '@meal-agent/contracts/inventory'

import type { AppServices } from './app-services'
import type { RuntimePort } from '../platform/ports'
import {
  describeApiError,
  MALFORMED_RESPONSE_TEXT,
  TRANSPORT_ERROR_TEXT
} from './error-text'
import { createIdempotencyKey } from './idempotency'

const HOUSEHOLD_MISSING_TEXT =
  '当前家庭不存在或已无法访问，请重新选择家庭。'

export type LoadLotsResult =
  | { readonly kind: 'loaded'; readonly page: InventoryLotPage }
  | { readonly kind: 'householdMissing'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

export const loadInventoryLots = async (
  services: AppServices,
  householdId: HouseholdId
): Promise<LoadLotsResult> => {
  const outcome = await services.api.listInventoryLots(householdId, {
    limit: 50
  })
  switch (outcome.kind) {
    case 'success':
      return { kind: 'loaded', page: outcome.data }
    case 'apiError':
      if (outcome.error.code === 'RESOURCE_NOT_FOUND') {
        return { kind: 'householdMissing', message: HOUSEHOLD_MISSING_TEXT }
      }
      return {
        kind: 'failed',
        message: describeApiError(outcome.error),
        retryable: outcome.error.retryable
      }
    case 'transportError':
      return { kind: 'failed', message: TRANSPORT_ERROR_TEXT, retryable: true }
    case 'malformedResponse':
      return {
        kind: 'failed',
        message: MALFORMED_RESPONSE_TEXT,
        retryable: false
      }
  }
}

export type CreateLotQuantityDraft =
  | {
      readonly kind: 'exact'
      readonly amount: string
      readonly unit: string
    }
  | {
      readonly kind: 'approximate'
      readonly amount: string
      readonly unit: string
      readonly confidence: Confidence
      readonly originalText: string
    }
  | {
      readonly kind: 'qualitative'
      readonly level: 'plenty' | 'some' | 'low' | 'unknown'
      readonly originalText: string
    }

export interface CreateLotDraft {
  readonly displayName: string
  readonly storageLocation: StorageLocation
  readonly quantity: CreateLotQuantityDraft
}

export type CreateLotOutcome =
  | {
      readonly kind: 'created'
      readonly result: CreateInventoryLotResult
      readonly replayed: boolean
    }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  | { readonly kind: 'householdMissing'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

/**
 * 与 contracts 的 exact 数量同形的平实十进制正则：估算数量输入先按
 * 此模式校验再 Number() 转换，拒绝 '0x10'、'5e2'、'12.' 等 JS Number
 * 能解析但与用户键入字面意图可能相差数量级的形式。
 */
const plainDecimalPattern = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/

const draftQuantityToRequest = (
  quantity: CreateLotQuantityDraft
): unknown => {
  switch (quantity.kind) {
    case 'exact':
      return {
        kind: 'exact',
        amount: quantity.amount.trim(),
        unit: quantity.unit.trim()
      }
    case 'approximate': {
      const raw = quantity.amount.trim()
      // 非平实十进制给出 NaN，由 zod 在 initialQuantity.amount 处报错。
      const amount = plainDecimalPattern.test(raw)
        ? Number(raw)
        : Number.NaN
      return {
        kind: 'approximate',
        amount,
        unit: quantity.unit.trim(),
        confidence: quantity.confidence,
        originalText: quantity.originalText.trim()
      }
    }
    case 'qualitative': {
      const originalText = quantity.originalText.trim()
      return {
        kind: 'qualitative',
        level: quantity.level,
        ...(originalText === '' ? {} : { originalText })
      }
    }
  }
}

export const createInventoryLot = async (
  services: AppServices,
  householdId: HouseholdId,
  draft: CreateLotDraft,
  idempotencyKey: IdempotencyKey
): Promise<CreateLotOutcome> => {
  const candidate = {
    displayName: draft.displayName.trim(),
    storageLocation: draft.storageLocation,
    initialQuantity: draftQuantityToRequest(draft.quantity),
    dates: []
  }

  const parsed = createInventoryLotRequestSchema.safeParse(candidate)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      messages: parsed.error.issues.map((issue) =>
        issue.path.length === 0
          ? issue.message
          : `${issue.path.join('.')}：${issue.message}`
      )
    }
  }

  const outcome = await services.api.createInventoryLot(
    householdId,
    parsed.data,
    idempotencyKey
  )
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'created',
        result: outcome.data,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    case 'apiError':
      if (outcome.error.code === 'RESOURCE_NOT_FOUND') {
        return { kind: 'householdMissing', message: HOUSEHOLD_MISSING_TEXT }
      }
      return {
        kind: 'failed',
        message: describeApiError(outcome.error),
        retryable: outcome.error.retryable
      }
    case 'transportError':
      return { kind: 'failed', message: TRANSPORT_ERROR_TEXT, retryable: true }
    case 'malformedResponse':
      return {
        kind: 'failed',
        message: MALFORMED_RESPONSE_TEXT,
        retryable: false
      }
  }
}

/**
 * 消耗操作的"逻辑身份"= (批次, 期望版本, 数量)。同一身份的重试复用
 * 同一幂等键；任一要素变化（含刷新后批次版本变化）即换新键，保证
 * 同键永远同 body，杜绝 IDEMPOTENCY_KEY_REUSED。
 */
export interface PendingConsume {
  readonly key: IdempotencyKey
  readonly lotId: string
  readonly version: number
  readonly amount: string
}

export const nextPendingConsume = (
  previous: PendingConsume | null,
  lot: InventoryLot,
  amount: string,
  runtime: RuntimePort
): PendingConsume =>
  previous !== null &&
  previous.lotId === lot.id &&
  previous.version === lot.version &&
  previous.amount === amount
    ? previous
    : {
        key: createIdempotencyKey(runtime),
        lotId: lot.id,
        version: lot.version,
        amount
      }

export type ConsumeLotOutcome =
  | {
      readonly kind: 'consumed'
      readonly result: ConsumeInventoryLotResult
      readonly replayed: boolean
    }
  | { readonly kind: 'versionConflict'; readonly message: string }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  /** 404 不泄露存在性：可能是批次也可能是家庭不可访问，由页面刷新后判定。 */
  | { readonly kind: 'notFound'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

/**
 * exact-only 消耗：数量单位固定取批次当前单位，expectedVersion 取调用时
 * 页面看到的批次版本；版本冲突时由页面刷新列表后让用户基于最新状态重试。
 */
export const consumeInventoryLot = async (
  services: AppServices,
  householdId: HouseholdId,
  lot: InventoryLot,
  amount: string,
  idempotencyKey: IdempotencyKey
): Promise<ConsumeLotOutcome> => {
  if (lot.currentQuantity.kind !== 'exact') {
    return {
      kind: 'invalid',
      messages: ['本阶段仅支持精确数量批次的消耗。']
    }
  }

  const candidate = {
    consumedQuantity: {
      kind: 'exact',
      amount: amount.trim(),
      unit: lot.currentQuantity.unit
    },
    expectedVersion: lot.version
  }

  const parsed = consumeInventoryLotRequestSchema.safeParse(candidate)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      messages: parsed.error.issues.map((issue) =>
        issue.path.length === 0
          ? issue.message
          : `${issue.path.join('.')}：${issue.message}`
      )
    }
  }

  const outcome = await services.api.consumeInventoryLot(
    householdId,
    lot.id,
    parsed.data,
    idempotencyKey
  )
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'consumed',
        result: outcome.data,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    case 'apiError':
      if (outcome.error.code === 'INVENTORY_VERSION_CONFLICT') {
        return {
          kind: 'versionConflict',
          message: describeApiError(outcome.error)
        }
      }
      if (outcome.error.code === 'RESOURCE_NOT_FOUND') {
        return {
          kind: 'notFound',
          message: '批次或家庭已无法访问，已为你刷新最新列表。'
        }
      }
      return {
        kind: 'failed',
        message: describeApiError(outcome.error),
        retryable: outcome.error.retryable
      }
    case 'transportError':
      return { kind: 'failed', message: TRANSPORT_ERROR_TEXT, retryable: true }
    case 'malformedResponse':
      return {
        kind: 'failed',
        message: MALFORMED_RESPONSE_TEXT,
        retryable: false
      }
  }
}
