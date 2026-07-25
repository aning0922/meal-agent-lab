import type {
  DietaryConstraintId,
  HouseholdId,
  HouseholdInviteId,
  MembershipId,
  PersonProfileId,
  PersonProfileLinkRequestId
} from '@meal-agent/contracts'
import type { IdempotencyKey } from '@meal-agent/contracts/api'
import type { InventoryLot } from '@meal-agent/contracts/inventory'
import type {
  ConfirmPersonProfileLinkRequest,
  CreatePersonProfileLinkRequest
} from '@meal-agent/contracts/members'

import type { AppServices } from './app-services'
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

type CommandHandler<K extends ClientCommandKind> = (
  services: AppServices,
  payload: ClientCommandDefinitions[K]['payload'],
  key: IdempotencyKey
) => Promise<ClientCommandDefinitions[K]['outcome']>

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
