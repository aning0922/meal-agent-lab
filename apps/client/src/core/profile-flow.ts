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
  hardConstraintConfirmationFingerprint,
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
  readonly defaultParticipation: boolean | null
  readonly defaultPortionScale: number | null
  readonly cookingSkill: CookingSkill | null
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
    case 'success': {
      const loaded = await services.api.getPersonProfile(
        householdId,
        outcome.data.profileId
      )
      if (loaded.kind !== 'success' || loaded.data.access !== 'owner_or_self') {
        return {
          kind: 'failed',
          message: '写入已完成，但读取最新档案失败，请返回后重新进入对账。',
          retryable: true
        }
      }
      return {
        kind: 'created',
        profile: loaded.data.profile,
        replayed: outcome.meta.idempotency?.replayed === true
      }
    }
    case 'apiError':
      switch (outcome.error.code) {
        case 'FORBIDDEN':
          return { kind: 'forbidden', message: FORBIDDEN_TEXT }
        case 'CONFLICT':
        case 'PERSON_PROFILE_ARCHIVED':
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
  readonly defaultParticipation?: boolean | null
  readonly defaultPortionScale?: number | null
  readonly cookingSkill?: CookingSkill | null
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

const mapProfileMutation = async (
  services: AppServices,
  householdId: HouseholdId,
  outcome: Awaited<ReturnType<AppServices['api']['patchPersonProfile']>>
): Promise<ProfileMutationOutcome> => {
  switch (outcome.kind) {
    case 'success': {
      const loaded = await services.api.getPersonProfile(
        householdId,
        outcome.data.profileId
      )
      if (loaded.kind !== 'success' || loaded.data.access !== 'owner_or_self') {
        return {
          kind: 'failed',
          message: '写入已完成，但读取最新档案失败，请重新进入页面对账。',
          retryable: true
        }
      }
      return {
        kind: 'updated',
        profile: loaded.data.profile,
        replayed: outcome.meta.idempotency?.replayed === true
      }
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
    services,
    householdId,
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
    services,
    householdId,
    await services.api.patchPersonProfile(
      householdId,
      profileId,
      { operation: 'archive', expectedVersion },
      idempotencyKey
    )
  )

/** 恢复原 ID 的 archived profile；不复制档案或私人约束。 */
export const restoreProfile = async (
  services: AppServices,
  householdId: HouseholdId,
  profileId: PersonProfileId,
  expectedVersion: number,
  idempotencyKey: IdempotencyKey
): Promise<ProfileMutationOutcome> =>
  mapProfileMutation(
    services,
    householdId,
    await services.api.patchPersonProfile(
      householdId,
      profileId,
      { operation: 'restore', expectedVersion },
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
    const fingerprintFields = {
      ...shared,
      kind: draft.kind,
      enforcement: 'hard' as const,
      allergenCodes: draft.allergenCodes ?? []
    }
    return {
      ...fingerprintFields,
      // 确认绑定全部字段；visibility/notes/结构化 ID 任一变化都会失效。
      confirmation: {
        acknowledged: draft.acknowledged,
        fingerprint:
          hardConstraintConfirmationFingerprint(fingerprintFields)
      }
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
    case 'success': {
      const loaded = await services.api.getPersonProfile(
        householdId,
        outcome.data.profileId
      )
      if (loaded.kind !== 'success' || loaded.data.access !== 'owner_or_self') {
        return {
          kind: 'failed',
          message: '约束写入已完成，但读取最新档案失败，请重新进入页面对账。',
          retryable: true
        }
      }
      return {
        kind: 'added',
        profile: loaded.data.profile,
        replayed: outcome.meta.idempotency?.replayed === true
      }
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
    case 'success': {
      const loaded = await services.api.getPersonProfile(
        householdId,
        outcome.data.profileId
      )
      if (loaded.kind !== 'success' || loaded.data.access !== 'owner_or_self') {
        return {
          kind: 'failed',
          message: '约束移除已完成，但读取最新档案失败，请重新进入页面对账。',
          retryable: true
        }
      }
      return {
        kind: 'removed',
        profile: loaded.data.profile,
        replayed: outcome.meta.idempotency?.replayed === true
      }
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
