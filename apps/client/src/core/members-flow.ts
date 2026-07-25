// 必须先于任何 @meal-agent/contracts schema 构造（见 zod-runtime-config）：
// 关闭 Zod JIT，否则对象 schema 的 safeParse 在小程序沙箱里会崩。
import '../zod-runtime-config'

import type { IdempotencyKey } from '@meal-agent/contracts/api'
import type {
  HouseholdId,
  HouseholdInviteId,
  MembershipId
} from '@meal-agent/contracts'
import type { HouseholdInvitePage } from '@meal-agent/contracts/http'
import {
  joinHouseholdRequestSchema,
  type CreateHouseholdInviteResult,
  type JoinHouseholdResult,
  type ListHouseholdMembersResult,
  type RemoveMembershipResult
} from '@meal-agent/contracts/members'

import type { AppServices } from './app-services'
import {
  describeApiError,
  MALFORMED_RESPONSE_TEXT,
  TRANSPORT_ERROR_TEXT
} from './error-text'

const HOUSEHOLD_MISSING_TEXT =
  '当前家庭不存在或你已不是成员，请重新选择家庭。'
// 无效/过期/撤销/用尽一律同一文案，不透露邀请或家庭的存在性。
const INVITE_INVALID_TEXT = '邀请码无效或已失效，请向家庭所有者确认。'

// ---------------------------------------------------------------------------
// 加入家庭
// ---------------------------------------------------------------------------

export type JoinHouseholdOutcome =
  | {
      readonly kind: 'joined'
      readonly result: JoinHouseholdResult
      readonly replayed: boolean
    }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  | { readonly kind: 'inviteInvalid'; readonly message: string }
  | { readonly kind: 'alreadyMember'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
      readonly executionUnknown: boolean
    }

export const joinHousehold = async (
  services: AppServices,
  inviteCode: string,
  idempotencyKey: IdempotencyKey
): Promise<JoinHouseholdOutcome> => {
  const parsed = joinHouseholdRequestSchema.safeParse({
    inviteCode: inviteCode.trim()
  })
  if (!parsed.success) {
    return {
      kind: 'invalid',
      messages: parsed.error.issues.map((issue) => issue.message)
    }
  }

  const outcome = await services.api.joinHousehold(parsed.data, idempotencyKey)
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'joined',
        result: outcome.data,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    case 'apiError':
      if (outcome.error.code === 'RESOURCE_NOT_FOUND') {
        return { kind: 'inviteInvalid', message: INVITE_INVALID_TEXT }
      }
      if (outcome.error.code === 'CONFLICT') {
        return {
          kind: 'alreadyMember',
          message: '你已经是该家庭的成员，无需重复加入。'
        }
      }
      return {
        kind: 'failed',
        message: describeApiError(outcome.error),
        retryable: outcome.error.retryable,
        executionUnknown: outcome.error.status >= 500
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

// ---------------------------------------------------------------------------
// 成员列表（redacted 视图）
// ---------------------------------------------------------------------------

export type LoadMembersResult =
  | { readonly kind: 'loaded'; readonly view: ListHouseholdMembersResult }
  | { readonly kind: 'householdMissing'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
      readonly executionUnknown: boolean
    }

export const loadMembers = async (
  services: AppServices,
  householdId: HouseholdId
): Promise<LoadMembersResult> => {
  const outcome = await services.api.listHouseholdMembers(householdId)
  switch (outcome.kind) {
    case 'success':
      return { kind: 'loaded', view: outcome.data }
    case 'apiError':
      if (outcome.error.code === 'RESOURCE_NOT_FOUND') {
        return { kind: 'householdMissing', message: HOUSEHOLD_MISSING_TEXT }
      }
      return {
        kind: 'failed',
        message: describeApiError(outcome.error),
        retryable: outcome.error.retryable,
        executionUnknown: outcome.error.status >= 500
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

// ---------------------------------------------------------------------------
// 邀请：签发 / 列表 / 撤销
// ---------------------------------------------------------------------------

export type CreateInviteOutcome =
  | {
      readonly kind: 'created'
      readonly result: CreateHouseholdInviteResult
      readonly replayed: boolean
    }
  | { readonly kind: 'forbidden'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
      readonly executionUnknown: boolean
    }

export interface CreateInviteDraft {
  readonly maxUses: number
  readonly expiresInHours: number
}

export const createInvite = async (
  services: AppServices,
  householdId: HouseholdId,
  draft: CreateInviteDraft,
  idempotencyKey: IdempotencyKey
): Promise<CreateInviteOutcome> => {
  const outcome = await services.api.createHouseholdInvite(
    householdId,
    { maxUses: draft.maxUses, expiresInHours: draft.expiresInHours },
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
      if (outcome.error.code === 'FORBIDDEN') {
        return {
          kind: 'forbidden',
          message: '只有家庭所有者可以生成邀请码。'
        }
      }
      return {
        kind: 'failed',
        message: describeApiError(outcome.error),
        retryable: outcome.error.retryable,
        executionUnknown: outcome.error.status >= 500
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

export type LoadInvitesResult =
  | { readonly kind: 'loaded'; readonly page: HouseholdInvitePage }
  | { readonly kind: 'forbidden'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
      readonly executionUnknown: boolean
    }

export const loadInvites = async (
  services: AppServices,
  householdId: HouseholdId
): Promise<LoadInvitesResult> => {
  const outcome = await services.api.listHouseholdInvites(householdId, {
    limit: 50
  })
  switch (outcome.kind) {
    case 'success':
      return { kind: 'loaded', page: outcome.data }
    case 'apiError':
      if (outcome.error.code === 'FORBIDDEN') {
        return { kind: 'forbidden', message: '只有家庭所有者可以查看邀请。' }
      }
      return {
        kind: 'failed',
        message: describeApiError(outcome.error),
        retryable: outcome.error.retryable,
        executionUnknown: outcome.error.status >= 500
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

export type RevokeInviteOutcome =
  | { readonly kind: 'revoked' }
  /** 重复撤销或已失效：把结果视为"已撤销"，由页面刷新列表反映真实态。 */
  | { readonly kind: 'alreadyInactive'; readonly message: string }
  | { readonly kind: 'forbidden'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

export const revokeInvite = async (
  services: AppServices,
  householdId: HouseholdId,
  inviteId: HouseholdInviteId,
  idempotencyKey: IdempotencyKey
): Promise<RevokeInviteOutcome> => {
  const outcome = await services.api.revokeHouseholdInvite(
    householdId,
    inviteId,
    idempotencyKey
  )
  switch (outcome.kind) {
    case 'success':
      return { kind: 'revoked' }
    case 'apiError':
      if (outcome.error.code === 'FORBIDDEN') {
        return { kind: 'forbidden', message: '只有家庭所有者可以撤销邀请。' }
      }
      if (
        outcome.error.code === 'CONFLICT' ||
        outcome.error.code === 'RESOURCE_NOT_FOUND'
      ) {
        return {
          kind: 'alreadyInactive',
          message: '该邀请已不可用（可能已撤销或用尽）。'
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

// ---------------------------------------------------------------------------
// 移除成员 / 退出
// ---------------------------------------------------------------------------

export type RemoveMembershipOutcome =
  | {
      readonly kind: 'removed'
      readonly result: RemoveMembershipResult
      readonly replayed: boolean
    }
  | { readonly kind: 'forbidden'; readonly message: string }
  /** 最后一位 owner 不可移除/退出，或并发变更：均返回 409。 */
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'notFound'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

export const removeMembership = async (
  services: AppServices,
  householdId: HouseholdId,
  membershipId: MembershipId,
  idempotencyKey: IdempotencyKey
): Promise<RemoveMembershipOutcome> => {
  const outcome = await services.api.removeMembership(
    householdId,
    membershipId,
    idempotencyKey
  )
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'removed',
        result: outcome.data,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    case 'apiError':
      if (outcome.error.code === 'FORBIDDEN') {
        return {
          kind: 'forbidden',
          message: '普通成员只能退出自己，不能移除他人。'
        }
      }
      if (outcome.error.code === 'CONFLICT') {
        return {
          kind: 'conflict',
          message:
            '操作与当前状态冲突：家庭必须至少保留一位所有者，或成员状态已变化。'
        }
      }
      if (outcome.error.code === 'RESOURCE_NOT_FOUND') {
        return { kind: 'notFound', message: HOUSEHOLD_MISSING_TEXT }
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
