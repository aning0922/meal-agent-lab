// 必须先于任何 @meal-agent/contracts schema 构造（见 zod-runtime-config）：
// 关闭 Zod JIT，否则对象 schema 的 safeParse 在小程序沙箱里会崩。
import '../zod-runtime-config'

import type {
  Cursor,
  IdempotencyKey
} from '@meal-agent/contracts/api'
import type {
  CreateHouseholdRequest,
  WechatLoginExchangeRequest
} from '@meal-agent/contracts/identity'
import type {
  ConsumeInventoryLotRequest,
  CreateInventoryLotRequest
} from '@meal-agent/contracts/inventory'
import type {
  AddDietaryConstraintRequest,
  CreateHouseholdInviteRequest,
  CreatePersonProfileRequest,
  JoinHouseholdRequest,
  PatchPersonProfileRequest,
  RemoveDietaryConstraintRequest
} from '@meal-agent/contracts/members'
import {
  consumeInventoryLotSuccessSchema,
  createHouseholdInviteSuccessSchema,
  createHouseholdSuccessSchema,
  createInventoryLotSuccessSchema,
  householdInvitePageSuccessSchema,
  householdPageSuccessSchema,
  inventoryLotPageSuccessSchema,
  joinHouseholdSuccessSchema,
  listHouseholdMembersSuccessSchema,
  meSuccessSchema,
  personProfileSuccessSchema,
  removeMembershipSuccessSchema,
  revokeHouseholdInviteSuccessSchema,
  sessionRevokedSuccessSchema,
  wechatLoginExchangeSuccessSchema
} from '@meal-agent/contracts/http'
import type {
  HouseholdId,
  HouseholdInviteId,
  InventoryLotId,
  MembershipId,
  PersonProfileId
} from '@meal-agent/contracts'

import type { ApiClient } from './api-client'

export interface PageQuery {
  readonly cursor?: Cursor
  readonly limit?: number
}

/** 阶段 06 已验证端点的类型化封装；路径与 services/api 路由一一对应。 */
export const createApiEndpoints = (client: ApiClient) => ({
  exchangeWechatLogin: (body: WechatLoginExchangeRequest) =>
    client.call({
      method: 'POST',
      path: '/api/v1/auth/wechat/exchange',
      envelope: wechatLoginExchangeSuccessSchema,
      body
    }),

  revokeSession: () =>
    client.call({
      method: 'DELETE',
      path: '/api/v1/session',
      envelope: sessionRevokedSuccessSchema
    }),

  getMe: () =>
    client.call({
      method: 'GET',
      path: '/api/v1/me',
      envelope: meSuccessSchema
    }),

  createHousehold: (
    body: CreateHouseholdRequest,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'POST',
      path: '/api/v1/households',
      envelope: createHouseholdSuccessSchema,
      body,
      idempotencyKey
    }),

  listHouseholds: (query: PageQuery = {}) =>
    client.call({
      method: 'GET',
      path: '/api/v1/households',
      envelope: householdPageSuccessSchema,
      query: { cursor: query.cursor, limit: query.limit }
    }),

  listInventoryLots: (
    householdId: HouseholdId,
    query: PageQuery = {}
  ) =>
    client.call({
      method: 'GET',
      path: `/api/v1/households/${householdId}/inventory-lots`,
      envelope: inventoryLotPageSuccessSchema,
      query: { cursor: query.cursor, limit: query.limit }
    }),

  createInventoryLot: (
    householdId: HouseholdId,
    body: CreateInventoryLotRequest,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'POST',
      path: `/api/v1/households/${householdId}/inventory-lots`,
      envelope: createInventoryLotSuccessSchema,
      body,
      idempotencyKey
    }),

  consumeInventoryLot: (
    householdId: HouseholdId,
    lotId: InventoryLotId,
    body: ConsumeInventoryLotRequest,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'POST',
      path: `/api/v1/households/${householdId}/inventory-lots/${lotId}/events/consumed`,
      envelope: consumeInventoryLotSuccessSchema,
      body,
      idempotencyKey
    }),

  // 阶段 08：家庭成员、邀请、用餐档案与饮食约束。
  createHouseholdInvite: (
    householdId: HouseholdId,
    body: CreateHouseholdInviteRequest,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'POST',
      path: `/api/v1/households/${householdId}/invites`,
      envelope: createHouseholdInviteSuccessSchema,
      body,
      idempotencyKey
    }),

  listHouseholdInvites: (householdId: HouseholdId, query: PageQuery = {}) =>
    client.call({
      method: 'GET',
      path: `/api/v1/households/${householdId}/invites`,
      envelope: householdInvitePageSuccessSchema,
      query: { cursor: query.cursor, limit: query.limit }
    }),

  revokeHouseholdInvite: (
    householdId: HouseholdId,
    inviteId: HouseholdInviteId,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'DELETE',
      path: `/api/v1/households/${householdId}/invites/${inviteId}`,
      envelope: revokeHouseholdInviteSuccessSchema,
      idempotencyKey
    }),

  joinHousehold: (
    body: JoinHouseholdRequest,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'POST',
      path: '/api/v1/households/join',
      envelope: joinHouseholdSuccessSchema,
      body,
      idempotencyKey
    }),

  listHouseholdMembers: (householdId: HouseholdId) =>
    client.call({
      method: 'GET',
      path: `/api/v1/households/${householdId}/members`,
      envelope: listHouseholdMembersSuccessSchema
    }),

  removeMembership: (
    householdId: HouseholdId,
    membershipId: MembershipId,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'DELETE',
      path: `/api/v1/households/${householdId}/memberships/${membershipId}`,
      envelope: removeMembershipSuccessSchema,
      idempotencyKey
    }),

  createPersonProfile: (
    householdId: HouseholdId,
    body: CreatePersonProfileRequest,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'POST',
      path: `/api/v1/households/${householdId}/person-profiles`,
      envelope: personProfileSuccessSchema,
      body,
      idempotencyKey
    }),

  patchPersonProfile: (
    householdId: HouseholdId,
    profileId: PersonProfileId,
    body: PatchPersonProfileRequest,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'PATCH',
      path: `/api/v1/households/${householdId}/person-profiles/${profileId}`,
      envelope: personProfileSuccessSchema,
      body,
      idempotencyKey
    }),

  addDietaryConstraint: (
    householdId: HouseholdId,
    profileId: PersonProfileId,
    body: AddDietaryConstraintRequest,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'POST',
      path: `/api/v1/households/${householdId}/person-profiles/${profileId}/dietary-constraints`,
      envelope: personProfileSuccessSchema,
      body,
      idempotencyKey
    }),

  removeDietaryConstraint: (
    householdId: HouseholdId,
    profileId: PersonProfileId,
    body: RemoveDietaryConstraintRequest,
    idempotencyKey: IdempotencyKey
  ) =>
    client.call({
      method: 'DELETE',
      path: `/api/v1/households/${householdId}/person-profiles/${profileId}/dietary-constraints`,
      envelope: personProfileSuccessSchema,
      body,
      idempotencyKey
    })
})

export type ApiEndpoints = ReturnType<typeof createApiEndpoints>
