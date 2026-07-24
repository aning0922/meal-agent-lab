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
import {
  describeApiError,
  MALFORMED_RESPONSE_TEXT,
  TRANSPORT_ERROR_TEXT
} from './error-text'

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
      const amount = Number(quantity.amount.trim())
      return {
        kind: 'approximate',
        // NaN 交给 zod 报错，避免本地重复实现数值规则。
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
