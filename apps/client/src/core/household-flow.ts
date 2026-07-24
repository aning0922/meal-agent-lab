import type { IdempotencyKey } from '@meal-agent/contracts/api'
import {
  createHouseholdRequestSchema,
  type CreateHouseholdResult
} from '@meal-agent/contracts/identity'
import type { HouseholdPage } from '@meal-agent/contracts/http'

import type { AppServices } from './app-services'
import {
  describeApiError,
  MALFORMED_RESPONSE_TEXT,
  TRANSPORT_ERROR_TEXT
} from './error-text'

export type LoadHouseholdsResult =
  | { readonly kind: 'loaded'; readonly page: HouseholdPage }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

export const loadHouseholds = async (
  services: AppServices
): Promise<LoadHouseholdsResult> => {
  const outcome = await services.api.listHouseholds({ limit: 50 })
  switch (outcome.kind) {
    case 'success':
      return { kind: 'loaded', page: outcome.data }
    case 'apiError':
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

export interface CreateHouseholdDraft {
  readonly name: string
  readonly ownerDisplayName: string
}

/** 阶段 07 表单未暴露的字段使用固定默认值（低保真原型 O-01 范围）。 */
export const HOUSEHOLD_DEFAULTS = {
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  defaultPortionScale: 1,
  cookingSkill: 'beginner'
} as const

export type CreateHouseholdOutcome =
  | {
      readonly kind: 'created'
      readonly result: CreateHouseholdResult
      readonly replayed: boolean
    }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

/**
 * 创建家庭。幂等键由调用方（页面）持有：同一次逻辑提交的重试必须
 * 传同一个键；修改表单后应换新键。成功后把新家庭设为当前家庭。
 */
export const createHousehold = async (
  services: AppServices,
  draft: CreateHouseholdDraft,
  idempotencyKey: IdempotencyKey
): Promise<CreateHouseholdOutcome> => {
  const candidate = {
    name: draft.name.trim(),
    timezone: HOUSEHOLD_DEFAULTS.timezone,
    locale: HOUSEHOLD_DEFAULTS.locale,
    ownerProfile: {
      displayName: draft.ownerDisplayName.trim(),
      defaultPortionScale: HOUSEHOLD_DEFAULTS.defaultPortionScale,
      cookingSkill: HOUSEHOLD_DEFAULTS.cookingSkill
    }
  }

  const parsed = createHouseholdRequestSchema.safeParse(candidate)
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

  const outcome = await services.api.createHousehold(
    parsed.data,
    idempotencyKey
  )
  switch (outcome.kind) {
    case 'success': {
      services.session.saveCurrentHouseholdId(
        outcome.data.household.id
      )
      return {
        kind: 'created',
        result: outcome.data,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    }
    case 'apiError':
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
