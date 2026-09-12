// 必须先于任何 @meal-agent/contracts schema 构造（见 zod-runtime-config）。
import '../zod-runtime-config'

import type { IdempotencyKey } from '@meal-agent/contracts/api'
import type { HouseholdId, PersonProfileId } from '@meal-agent/contracts'
import {
  generateRecommendationRequestSchema,
  type Recommendation,
  type GenerateRecommendationRequest
} from '@meal-agent/contracts/meals'

import type { AppServices } from './app-services'
import {
  describeApiError,
  MALFORMED_RESPONSE_TEXT,
  TRANSPORT_ERROR_TEXT
} from './error-text'

const HOUSEHOLD_MISSING_TEXT =
  '当前家庭不存在或你已不是成员，请重新选择家庭。'
const FORBIDDEN_TEXT = '当前身份没有生成推荐的权限（需要 meal:write）。'

export interface RecommendationDraft {
  readonly participantProfileIds: readonly PersonProfileId[]
  readonly cookProfileId: PersonProfileId
  readonly maximumTotalMinutes: number
  readonly purchaseTolerance: 'none' | 'limited' | 'allowed'
  readonly suggestedDishCount: number
}

/**
 * 推荐生成是**成功写命令**：受约束家庭得到 `outcome === "no_feasible_option"`
 * 也走同一个 `generated` 分支——阻断是正确结果，不是错误屏幕（冻结 §3.3、§5.6）。
 */
export type GenerateRecommendationOutcome =
  | {
      readonly kind: 'generated'
      readonly recommendation: Recommendation
      readonly replayed: boolean
    }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'householdMissing'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
      readonly executionUnknown: boolean
    }

export const generateRecommendation = async (
  services: AppServices,
  householdId: HouseholdId,
  draft: RecommendationDraft,
  idempotencyKey: IdempotencyKey
): Promise<GenerateRecommendationOutcome> => {
  const candidate: GenerateRecommendationRequest = {
    participantProfileIds: [...draft.participantProfileIds],
    cookProfileId: draft.cookProfileId,
    maximumTotalMinutes: draft.maximumTotalMinutes,
    purchaseTolerance: draft.purchaseTolerance,
    suggestedDishCount: draft.suggestedDishCount
  }
  const parsed = generateRecommendationRequestSchema.safeParse(candidate)
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

  const outcome = await services.api.generateRecommendation(
    householdId,
    parsed.data,
    idempotencyKey
  )
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'generated',
        recommendation: outcome.data,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    case 'apiError':
      switch (outcome.error.code) {
        case 'FORBIDDEN':
          return { kind: 'forbidden', message: FORBIDDEN_TEXT }
        case 'RESOURCE_NOT_FOUND':
          return { kind: 'householdMissing', message: HOUSEHOLD_MISSING_TEXT }
        default:
          return {
            kind: 'failed',
            message: describeApiError(outcome.error),
            retryable: outcome.error.retryable,
            executionUnknown: outcome.error.status >= 500
          }
      }
    case 'transportError':
      return {
        kind: 'failed',
        message: TRANSPORT_ERROR_TEXT,
        retryable: true,
        executionUnknown: true
      }
    case 'malformedResponse':
      return {
        kind: 'failed',
        message: MALFORMED_RESPONSE_TEXT,
        retryable: false,
        executionUnknown: true
      }
  }
}
