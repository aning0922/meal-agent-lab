// 必须先于任何 @meal-agent/contracts schema 构造（见 zod-runtime-config）：
// 关闭 Zod JIT，否则对象 schema 的 safeParse 在小程序沙箱里会崩。
import '../zod-runtime-config'

import type { IdempotencyKey } from '@meal-agent/contracts/api'
import type {
  DietaryConstraintId,
  HouseholdId,
  MembershipId,
  PersonProfileId
} from '@meal-agent/contracts'
import type { PersonProfile } from '@meal-agent/contracts/identity'
import {
  addDietaryConstraintRequestSchema,
  createPersonProfileRequestSchema,
  patchPersonProfileRequestSchema,
  removeDietaryConstraintRequestSchema
} from '@meal-agent/contracts/members'

import type { AppServices } from './app-services'
import {
  describeApiError,
  MALFORMED_RESPONSE_TEXT,
  TRANSPORT_ERROR_TEXT
} from './error-text'

const HOUSEHOLD_MISSING_TEXT =
  '当前家庭不存在或你已不是成员，请重新选择家庭。'
const FORBIDDEN_TEXT = '你只能编辑本人或（作为所有者）家庭成员的档案。'

type CookingSkill = 'none' | 'beginner' | 'intermediate' | 'advanced'
type Visibility = 'household' | 'subject_and_owner'
type HardConstraintKind =
  | 'allergy'
  | 'religious'
  | 'ethical'
  | 'explicit_avoid'
  | 'food_safety_exclusion'

const issuesToMessages = (
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]
): readonly string[] =>
  issues.map((issue) =>
    issue.path.length === 0
      ? issue.message
      : `${issue.path.map(String).join('.')}：${issue.message}`
  )

// ---------------------------------------------------------------------------
// 创建用餐档案（登录成员关联档案 / 仅用餐档案）
// ---------------------------------------------------------------------------

export interface CreateProfileDraft {
  /** 关联登录成员的 membership；缺省表示仅用餐档案（仅所有者可建）。 */
  readonly linkedMembershipId?: MembershipId
  readonly displayName: string
  readonly defaultParticipation: boolean
  readonly defaultPortionScale: number
  readonly cookingSkill: CookingSkill
}

export type CreateProfileOutcome =
  | {
      readonly kind: 'created'
      readonly profile: PersonProfile
      readonly replayed: boolean
    }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'householdMissing'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

export const createProfile = async (
  services: AppServices,
  householdId: HouseholdId,
  draft: CreateProfileDraft,
  idempotencyKey: IdempotencyKey
): Promise<CreateProfileOutcome> => {
  const candidate = {
    ...(draft.linkedMembershipId === undefined
      ? {}
      : { linkedMembershipId: draft.linkedMembershipId }),
    displayName: draft.displayName.trim(),
    defaultParticipation: draft.defaultParticipation,
    defaultPortionScale: draft.defaultPortionScale,
    cookingSkill: draft.cookingSkill
  }
  const parsed = createPersonProfileRequestSchema.safeParse(candidate)
  if (!parsed.success) {
    return { kind: 'invalid', messages: issuesToMessages(parsed.error.issues) }
  }

  const outcome = await services.api.createPersonProfile(
    householdId,
    parsed.data,
    idempotencyKey
  )
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'created',
        profile: outcome.data.profile,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    case 'apiError':
      switch (outcome.error.code) {
        case 'FORBIDDEN':
          return { kind: 'forbidden', message: FORBIDDEN_TEXT }
        case 'CONFLICT':
          return {
            kind: 'conflict',
            message: '该成员已有档案，或提交与当前状态冲突。'
          }
        case 'RESOURCE_NOT_FOUND':
          return { kind: 'householdMissing', message: HOUSEHOLD_MISSING_TEXT }
        default:
          return {
            kind: 'failed',
            message: describeApiError(outcome.error),
            retryable: outcome.error.retryable
          }
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
// 编辑 / 归档档案（乐观并发）
// ---------------------------------------------------------------------------

export interface UpdateProfileDraft {
  readonly displayName?: string
  readonly defaultParticipation?: boolean
  readonly defaultPortionScale?: number
  readonly cookingSkill?: CookingSkill
}

export type ProfileMutationOutcome =
  | {
      readonly kind: 'updated'
      readonly profile: PersonProfile
      readonly replayed: boolean
    }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'versionConflict'; readonly message: string }
  | { readonly kind: 'notFound'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

const mapProfileMutation = (
  outcome: Awaited<ReturnType<AppServices['api']['patchPersonProfile']>>
): ProfileMutationOutcome => {
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'updated',
        profile: outcome.data.profile,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    case 'apiError':
      switch (outcome.error.code) {
        case 'FORBIDDEN':
          return { kind: 'forbidden', message: FORBIDDEN_TEXT }
        case 'CONFLICT':
          return {
            kind: 'versionConflict',
            message: '档案刚被更新，已为你刷新最新版本，请基于最新状态重试。'
          }
        case 'RESOURCE_NOT_FOUND':
          return { kind: 'notFound', message: HOUSEHOLD_MISSING_TEXT }
        default:
          return {
            kind: 'failed',
            message: describeApiError(outcome.error),
            retryable: outcome.error.retryable
          }
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

export const updateProfile = async (
  services: AppServices,
  householdId: HouseholdId,
  profileId: PersonProfileId,
  draft: UpdateProfileDraft,
  expectedVersion: number,
  idempotencyKey: IdempotencyKey
): Promise<ProfileMutationOutcome> => {
  const candidate = {
    operation: 'update' as const,
    expectedVersion,
    ...(draft.displayName === undefined
      ? {}
      : { displayName: draft.displayName.trim() }),
    ...(draft.defaultParticipation === undefined
      ? {}
      : { defaultParticipation: draft.defaultParticipation }),
    ...(draft.defaultPortionScale === undefined
      ? {}
      : { defaultPortionScale: draft.defaultPortionScale }),
    ...(draft.cookingSkill === undefined
      ? {}
      : { cookingSkill: draft.cookingSkill })
  }
  const parsed = patchPersonProfileRequestSchema.safeParse(candidate)
  if (!parsed.success) {
    return { kind: 'invalid', messages: issuesToMessages(parsed.error.issues) }
  }
  return mapProfileMutation(
    await services.api.patchPersonProfile(
      householdId,
      profileId,
      parsed.data,
      idempotencyKey
    )
  )
}

/** 归档（"移除"用餐档案）。 */
export const archiveProfile = async (
  services: AppServices,
  householdId: HouseholdId,
  profileId: PersonProfileId,
  expectedVersion: number,
  idempotencyKey: IdempotencyKey
): Promise<ProfileMutationOutcome> =>
  mapProfileMutation(
    await services.api.patchPersonProfile(
      householdId,
      profileId,
      { operation: 'archive', expectedVersion },
      idempotencyKey
    )
  )

// ---------------------------------------------------------------------------
// 饮食约束增删（硬约束双确认）
// ---------------------------------------------------------------------------

export interface HardConstraintDraft {
  readonly enforcement: 'hard'
  readonly kind: HardConstraintKind
  readonly label: string
  readonly allergenCodes?: readonly string[]
  readonly foodConceptIds?: readonly string[]
  readonly notes?: string
  readonly visibility: Visibility
  /**
   * 硬约束二次确认标记：仅当用户在独立确认屏上确认后果后置为 true。
   * 为 false 时请求携带 acknowledged=false，被契约层拒绝（→ invalid）。
   */
  readonly acknowledged: boolean
}

export interface SoftConstraintDraft {
  readonly enforcement: 'soft'
  readonly label: string
  readonly preference: 'prefer' | 'dislike'
  readonly foodConceptIds?: readonly string[]
  readonly notes?: string
  readonly visibility: Visibility
}

export type ConstraintDraft = HardConstraintDraft | SoftConstraintDraft

export type AddConstraintOutcome =
  | {
      readonly kind: 'added'
      readonly profile: PersonProfile
      readonly replayed: boolean
    }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'versionConflict'; readonly message: string }
  | { readonly kind: 'notFound'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

const buildConstraint = (draft: ConstraintDraft): unknown => {
  const shared = {
    label: draft.label.trim(),
    foodConceptIds: draft.foodConceptIds ?? [],
    visibility: draft.visibility,
    ...(draft.notes === undefined || draft.notes.trim() === ''
      ? {}
      : { notes: draft.notes.trim() })
  }
  if (draft.enforcement === 'hard') {
    return {
      ...shared,
      kind: draft.kind,
      enforcement: 'hard',
      allergenCodes: draft.allergenCodes ?? [],
      // 双确认：acknowledged 为 false 时契约层的 literal(true) 会拒绝。
      confirmation: { acknowledged: draft.acknowledged }
    }
  }
  return {
    ...shared,
    kind: 'preference',
    enforcement: 'soft',
    preference: draft.preference
  }
}

export const addDietaryConstraint = async (
  services: AppServices,
  householdId: HouseholdId,
  profileId: PersonProfileId,
  draft: ConstraintDraft,
  expectedVersion: number,
  idempotencyKey: IdempotencyKey
): Promise<AddConstraintOutcome> => {
  const parsed = addDietaryConstraintRequestSchema.safeParse({
    expectedVersion,
    constraint: buildConstraint(draft)
  })
  if (!parsed.success) {
    return { kind: 'invalid', messages: issuesToMessages(parsed.error.issues) }
  }

  const outcome = await services.api.addDietaryConstraint(
    householdId,
    profileId,
    parsed.data,
    idempotencyKey
  )
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'added',
        profile: outcome.data.profile,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    case 'apiError':
      switch (outcome.error.code) {
        case 'FORBIDDEN':
          return { kind: 'forbidden', message: FORBIDDEN_TEXT }
        case 'CONFLICT':
          return {
            kind: 'versionConflict',
            message: '档案刚被更新，已为你刷新最新版本，请基于最新状态重试。'
          }
        case 'RESOURCE_NOT_FOUND':
          return { kind: 'notFound', message: HOUSEHOLD_MISSING_TEXT }
        case 'VALIDATION_FAILED':
          return {
            kind: 'invalid',
            messages: ['提交内容未通过服务端校验（硬约束需二次确认）。']
          }
        default:
          return {
            kind: 'failed',
            message: describeApiError(outcome.error),
            retryable: outcome.error.retryable
          }
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

export type RemoveConstraintOutcome =
  | {
      readonly kind: 'removed'
      readonly profile: PersonProfile
      readonly replayed: boolean
    }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'versionConflict'; readonly message: string }
  | { readonly kind: 'notFound'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

export const removeDietaryConstraint = async (
  services: AppServices,
  householdId: HouseholdId,
  profileId: PersonProfileId,
  constraintId: DietaryConstraintId,
  expectedVersion: number,
  idempotencyKey: IdempotencyKey
): Promise<RemoveConstraintOutcome> => {
  const parsed = removeDietaryConstraintRequestSchema.safeParse({
    constraintId,
    expectedVersion
  })
  if (!parsed.success) {
    return { kind: 'invalid', messages: issuesToMessages(parsed.error.issues) }
  }

  const outcome = await services.api.removeDietaryConstraint(
    householdId,
    profileId,
    parsed.data,
    idempotencyKey
  )
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'removed',
        profile: outcome.data.profile,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    case 'apiError':
      switch (outcome.error.code) {
        case 'FORBIDDEN':
          return { kind: 'forbidden', message: FORBIDDEN_TEXT }
        case 'CONFLICT':
          return {
            kind: 'versionConflict',
            message: '档案刚被更新，已为你刷新最新版本，请基于最新状态重试。'
          }
        case 'RESOURCE_NOT_FOUND':
          return {
            kind: 'notFound',
            message: '约束或档案已不存在，已为你刷新最新状态。'
          }
        default:
          return {
            kind: 'failed',
            message: describeApiError(outcome.error),
            retryable: outcome.error.retryable
          }
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
