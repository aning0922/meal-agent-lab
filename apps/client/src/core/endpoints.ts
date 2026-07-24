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
import {
  consumeInventoryLotSuccessSchema,
  createHouseholdSuccessSchema,
  createInventoryLotSuccessSchema,
  householdPageSuccessSchema,
  inventoryLotPageSuccessSchema,
  meSuccessSchema,
  sessionRevokedSuccessSchema,
  wechatLoginExchangeSuccessSchema
} from '@meal-agent/contracts/http'
import type {
  HouseholdId,
  InventoryLotId
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
    })
})

export type ApiEndpoints = ReturnType<typeof createApiEndpoints>
