import type {
  DietaryConstraintId,
  HouseholdId,
  HouseholdInviteId,
  MembershipId,
  PersonProfileId,
  PersonProfileLinkRequestId,
  UserId
} from '@meal-agent/contracts'
import type { IdempotencyKey } from '@meal-agent/contracts/api'
import type { InventoryLot } from '@meal-agent/contracts/inventory'
import type {
  ConfirmPersonProfileLinkRequest,
  CreatePersonProfileLinkRequest
} from '@meal-agent/contracts/members'

import type { AppServices } from './app-services'
import {
  HOUSEHOLDS_ROUTE,
  INVENTORY_ROUTE,
  MEMBERS_ROUTE,
  type AppRoute
} from '../platform/ports'
import {
  createHousehold,
  type CreateHouseholdDraft
} from './household-flow'
import {
  consumeInventoryLot,
  createInventoryLot,
  type CreateLotDraft
} from './inventory-flow'
import {
  createInvite,
  joinHousehold,
  removeMembership,
  revokeInvite,
  type CreateInviteDraft
} from './members-flow'
import {
  addDietaryConstraint,
  archiveProfile,
  createProfile,
  removeDietaryConstraint,
  restoreProfile,
  updateProfile,
  type ConstraintDraft,
  type CreateProfileDraft,
  type UpdateProfileDraft
} from './profile-flow'

/**
 * 所有客户端写命令的单一 typed registry。pending envelope 保存的是此
 * union 的完整不可变 snapshot；页面卸载后，dispatcher 仍可仅凭 kind、
 * payload 与原 key 重放，不能回读页面 draft 或普通 GET 拼装请求。
 */
export interface ClientCommandDefinitions {
  readonly 'household.create': {
    readonly payload: CreateHouseholdDraft
    readonly outcome: Awaited<ReturnType<typeof createHousehold>>
  }
  readonly 'household.join': {
    readonly payload: { readonly inviteCode: string }
    readonly outcome: Awaited<ReturnType<typeof joinHousehold>>
  }
  readonly 'inventory.create': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly draft: CreateLotDraft
    }
    readonly outcome: Awaited<ReturnType<typeof createInventoryLot>>
  }
  readonly 'inventory.consume': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly lot: InventoryLot
      readonly amount: string
    }
    readonly outcome: Awaited<ReturnType<typeof consumeInventoryLot>>
  }
  readonly 'invite.create': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly draft: CreateInviteDraft
    }
    readonly outcome: Awaited<ReturnType<typeof createInvite>>
  }
  readonly 'invite.revoke': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly inviteId: HouseholdInviteId
    }
    readonly outcome: Awaited<ReturnType<typeof revokeInvite>>
  }
  readonly 'membership.remove': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly membershipId: MembershipId
      readonly isSelf: boolean
    }
    readonly outcome: Awaited<ReturnType<typeof removeMembership>>
  }
  readonly 'profile.create': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly draft: CreateProfileDraft
    }
    readonly outcome: Awaited<ReturnType<typeof createProfile>>
  }
  readonly 'profile.update': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly profileId: PersonProfileId
      readonly draft: UpdateProfileDraft
      readonly expectedVersion: number
    }
    readonly outcome: Awaited<ReturnType<typeof updateProfile>>
  }
  readonly 'profile.archive': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly profileId: PersonProfileId
      readonly expectedVersion: number
    }
    readonly outcome: Awaited<ReturnType<typeof archiveProfile>>
  }
  readonly 'profile.restore': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly profileId: PersonProfileId
      readonly expectedVersion: number
    }
    readonly outcome: Awaited<ReturnType<typeof restoreProfile>>
  }
  readonly 'constraint.add': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly profileId: PersonProfileId
      readonly draft: ConstraintDraft
      readonly expectedVersion: number
    }
    readonly outcome: Awaited<ReturnType<typeof addDietaryConstraint>>
  }
  readonly 'constraint.remove': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly profileId: PersonProfileId
      readonly constraintId: DietaryConstraintId
      readonly expectedVersion: number
    }
    readonly outcome: Awaited<ReturnType<typeof removeDietaryConstraint>>
  }
  readonly 'profile.link-request': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly profileId: PersonProfileId
      readonly request: CreatePersonProfileLinkRequest
    }
    readonly outcome: Awaited<
      ReturnType<AppServices['api']['createPersonProfileLinkRequest']>
    >
  }
  readonly 'profile.link-confirm': {
    readonly payload: {
      readonly householdId: HouseholdId
      readonly requestId: PersonProfileLinkRequestId
      readonly request: ConfirmPersonProfileLinkRequest
    }
    readonly outcome: Awaited<
      ReturnType<AppServices['api']['confirmPersonProfileLinkRequest']>
    >
  }
}

export type ClientCommandKind = keyof ClientCommandDefinitions

export type RegisteredCommand<K extends ClientCommandKind> = {
  readonly kind: K
  readonly payload: ClientCommandDefinitions[K]['payload']
}

export type AnyRegisteredCommand = {
  readonly [K in ClientCommandKind]: RegisteredCommand<K>
}[ClientCommandKind]

export type RegisteredCommandOutcome<K extends ClientCommandKind> =
  ClientCommandDefinitions[K]['outcome']

export interface CommandReconciliation {
  readonly tone: 'success' | 'warning' | 'error'
  readonly message: string
  /** 一次性秘密只驻留在全局恢复组件的内存 state，不进入 storage。 */
  readonly secret?: {
    readonly label: '邀请码'
    readonly value: string
  }
  readonly localTransition?: CommandLocalTransition
}

export interface CommandLocalTransition {
  readonly navigation: 'reLaunch' | 'navigateTo'
  readonly route: AppRoute
  readonly householdContext:
    | {
        readonly kind: 'set'
        readonly householdId: HouseholdId
      }
    | { readonly kind: 'clear' }
}

export interface CommandLocalRecovery {
  readonly principalId: UserId
  readonly completedPresentation: CommandReconciliation
  readonly transition: CommandLocalTransition
}

type CommandHandler<K extends ClientCommandKind> = (
  services: AppServices,
  payload: ClientCommandDefinitions[K]['payload'],
  key: IdempotencyKey
) => Promise<ClientCommandDefinitions[K]['outcome']>

type CommandReconciler<K extends ClientCommandKind> = (
  payload: ClientCommandDefinitions[K]['payload'],
  outcome: ClientCommandDefinitions[K]['outcome']
) => CommandReconciliation

const commandRegistry: {
  readonly [K in ClientCommandKind]: CommandHandler<K>
} = {
  'household.create': (services, payload, key) =>
    createHousehold(services, payload, key),
  'household.join': (services, payload, key) =>
    joinHousehold(services, payload.inviteCode, key),
  'inventory.create': (services, payload, key) =>
    createInventoryLot(
      services,
      payload.householdId,
      payload.draft,
      key
    ),
  'inventory.consume': (services, payload, key) =>
    consumeInventoryLot(
      services,
      payload.householdId,
      payload.lot,
      payload.amount,
      key
    ),
  'invite.create': (services, payload, key) =>
    createInvite(services, payload.householdId, payload.draft, key),
  'invite.revoke': (services, payload, key) =>
    revokeInvite(services, payload.householdId, payload.inviteId, key),
  'membership.remove': (services, payload, key) =>
    removeMembership(
      services,
      payload.householdId,
      payload.membershipId,
      key
    ),
  'profile.create': (services, payload, key) =>
    createProfile(services, payload.householdId, payload.draft, key),
  'profile.update': (services, payload, key) =>
    updateProfile(
      services,
      payload.householdId,
      payload.profileId,
      payload.draft,
      payload.expectedVersion,
      key
    ),
  'profile.archive': (services, payload, key) =>
    archiveProfile(
      services,
      payload.householdId,
      payload.profileId,
      payload.expectedVersion,
      key
    ),
  'profile.restore': (services, payload, key) =>
    restoreProfile(
      services,
      payload.householdId,
      payload.profileId,
      payload.expectedVersion,
      key
    ),
  'constraint.add': (services, payload, key) =>
    addDietaryConstraint(
      services,
      payload.householdId,
      payload.profileId,
      payload.draft,
      payload.expectedVersion,
      key
    ),
  'constraint.remove': (services, payload, key) =>
    removeDietaryConstraint(
      services,
      payload.householdId,
      payload.profileId,
      payload.constraintId,
      payload.expectedVersion,
      key
    ),
  'profile.link-request': (services, payload, key) =>
    services.api.createPersonProfileLinkRequest(
      payload.householdId,
      payload.profileId,
      payload.request,
      key
    ),
  'profile.link-confirm': (services, payload, key) =>
    services.api.confirmPersonProfileLinkRequest(
      payload.householdId,
      payload.requestId,
      payload.request,
      key
    )
}

const messageFromOutcome = (
  outcome: unknown,
  fallback: string
): string => {
  if (outcome !== null && typeof outcome === 'object') {
    const record = outcome as {
      readonly message?: unknown
      readonly messages?: unknown
      readonly error?: { readonly message?: unknown }
    }
    if (typeof record.message === 'string') return record.message
    if (
      Array.isArray(record.messages) &&
      record.messages.every((message) => typeof message === 'string')
    ) {
      return record.messages.join('；')
    }
    if (typeof record.error?.message === 'string') {
      return record.error.message
    }
  }
  return fallback
}

const success = (message: string): CommandReconciliation => ({
  tone: 'success',
  message
})

const failure = (
  outcome: unknown,
  fallback = '命令已收到确定失败，旧幂等动作已释放。'
): CommandReconciliation => ({
  tone: 'error',
  message: messageFromOutcome(outcome, fallback)
})

/**
 * 全局恢复后的 typed 业务收口。每个 command kind 必须有对应 handler；
 * dispatcher 只有在 commandId CAS 成功后才调用。reconciler 本身只生成
 * presentation 与本地 transition 计划，不能直接导航或修改 session。
 */
const commandReconciliationRegistry: {
  readonly [K in ClientCommandKind]: CommandReconciler<K>
} = {
  'household.create': (_payload, outcome) => {
    if (outcome.kind !== 'created') return failure(outcome)
    return {
      ...success('家庭已创建，已切换到该家庭。'),
      localTransition: {
        navigation: 'reLaunch',
        route: INVENTORY_ROUTE,
        householdContext: {
          kind: 'set',
          householdId: outcome.result.household.id
        }
      }
    }
  },
  'household.join': (_payload, outcome) => {
    if (outcome.kind !== 'joined') return failure(outcome)
    return {
      ...success('已加入家庭并切换到成员页。'),
      localTransition: {
        navigation: 'navigateTo',
        route: MEMBERS_ROUTE,
        householdContext: {
          kind: 'set',
          householdId: outcome.result.household.id
        }
      }
    }
  },
  'inventory.create': (_payload, outcome) =>
    outcome.kind === 'created'
      ? success('库存批次已创建，请刷新页面查看最新库存。')
      : failure(outcome),
  'inventory.consume': (_payload, outcome) =>
    outcome.kind === 'consumed'
      ? success('库存消耗已确认，请刷新页面查看最新数量。')
      : failure(outcome),
  'invite.create': (_payload, outcome) => {
    if (outcome.kind !== 'created') return failure(outcome)
    const inviteCode = outcome.result.inviteCode
    if (inviteCode === undefined) {
      return {
        tone: 'warning',
        message:
          '邀请已创建，但安全重放不会再次返回明文邀请码。请返回成员页撤销该邀请，再明确创建一个新邀请。'
      }
    }
    return {
      tone: 'success',
      message:
        '邀请已创建。邀请码只显示这一次，请立即安全地交付给受邀成员。',
      secret: { label: '邀请码', value: inviteCode }
    }
  },
  'invite.revoke': (_payload, outcome) =>
    outcome.kind === 'revoked'
      ? success('邀请已撤销。')
      : failure(outcome),
  'membership.remove': (payload, outcome) => {
    if (outcome.kind !== 'removed') return failure(outcome)
    if (payload.isSelf) {
      return {
        ...success(
          '你已退出家庭；关联档案已归档并保留，重新加入不会自动恢复。'
        ),
        localTransition: {
          navigation: 'reLaunch',
          route: HOUSEHOLDS_ROUTE,
          householdContext: { kind: 'clear' }
        }
      }
    }
    return success('成员已移除，其关联档案已归档并保留。')
  },
  'profile.create': (_payload, outcome) =>
    outcome.kind === 'created'
      ? success('档案已创建，请刷新页面查看。')
      : failure(outcome),
  'profile.update': (_payload, outcome) =>
    outcome.kind === 'updated'
      ? success('档案已更新，请刷新页面查看。')
      : failure(outcome),
  'profile.archive': (_payload, outcome) =>
    outcome.kind === 'updated'
      ? success('档案已归档。')
      : failure(outcome),
  'profile.restore': (_payload, outcome) =>
    outcome.kind === 'updated'
      ? success('档案已恢复。')
      : failure(outcome),
  'constraint.add': (_payload, outcome) =>
    outcome.kind === 'added'
      ? success('饮食约束已登记，请刷新档案查看。')
      : failure(outcome),
  'constraint.remove': (_payload, outcome) =>
    outcome.kind === 'removed'
      ? success('饮食约束已移除，请刷新档案查看。')
      : failure(outcome),
  'profile.link-request': (_payload, outcome) =>
    outcome.kind === 'success'
      ? success('档案关联请求已发起，等待目标成员确认。')
      : failure(outcome),
  'profile.link-confirm': (_payload, outcome) =>
    outcome.kind === 'success'
      ? success('档案关联已确认，请重新加载最新档案。')
      : failure(outcome)
}

export const registeredCommandKinds = Object.freeze(
  Object.keys(commandRegistry) as ClientCommandKind[]
)

export const householdIdForCommand = (
  command: AnyRegisteredCommand
): HouseholdId | null =>
  'householdId' in command.payload
    ? command.payload.householdId
    : null

export const dispatchRegisteredCommand = async <
  K extends ClientCommandKind
>(
  services: AppServices,
  command: RegisteredCommand<K>,
  key: IdempotencyKey
): Promise<RegisteredCommandOutcome<K>> =>
  commandRegistry[command.kind](
    services,
    command.payload,
    key
  )

export const reconcileRegisteredCommand = <
  K extends ClientCommandKind
>(
  command: RegisteredCommand<K>,
  outcome: RegisteredCommandOutcome<K>
): CommandReconciliation =>
  commandReconciliationRegistry[command.kind](
    command.payload,
    outcome
  )

export const applyCommandLocalTransition = async (
  services: AppServices,
  transition: CommandLocalTransition
): Promise<void> => {
  const updateHouseholdContext = (): void => {
    if (transition.householdContext.kind === 'set') {
      services.session.saveCurrentHouseholdId(
        transition.householdContext.householdId
      )
    } else {
      services.session.clearCurrentHouseholdId()
    }
  }
  const decision =
    transition.navigation === 'reLaunch'
      ? await services.navigation.reLaunch(
          transition.route,
          updateHouseholdContext
        )
      : await services.navigation.navigateTo(
          transition.route,
          updateHouseholdContext
        )
  if (decision.kind === 'denied') {
    throw new Error('local navigation was denied')
  }
}

export const commandLabel = (kind: ClientCommandKind): string =>
  ({
    'household.create': '创建家庭',
    'household.join': '加入家庭',
    'inventory.create': '创建库存批次',
    'inventory.consume': '消耗库存',
    'invite.create': '生成邀请码',
    'invite.revoke': '撤销邀请码',
    'membership.remove': '退出或移除成员',
    'profile.create': '创建档案',
    'profile.update': '更新档案',
    'profile.archive': '归档档案',
    'profile.restore': '恢复档案',
    'constraint.add': '登记饮食约束',
    'constraint.remove': '移除饮食约束',
    'profile.link-request': '发起档案关联',
    'profile.link-confirm': '确认档案关联'
  })[kind]
