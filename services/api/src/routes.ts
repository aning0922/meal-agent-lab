import {
  apiErrorSchema,
  cursorSchema,
  idempotencyKeySchema,
} from "@meal-agent/contracts/api";
import {
  householdIdSchema,
  householdInviteIdSchema,
  inventoryLotIdSchema,
  membershipIdSchema,
  personProfileIdSchema,
  requestIdSchema,
  type RequestId,
} from "@meal-agent/contracts";
import {
  createHouseholdRequestSchema,
  wechatLoginExchangeRequestSchema,
} from "@meal-agent/contracts/identity";
import {
  consumeInventoryLotRequestSchema,
  createInventoryLotRequestSchema,
} from "@meal-agent/contracts/inventory";
import {
  addDietaryConstraintRequestSchema,
  createHouseholdInviteRequestSchema,
  createPersonProfileRequestSchema,
  joinHouseholdRequestSchema,
  patchPersonProfileRequestSchema,
  removeDietaryConstraintRequestSchema,
} from "@meal-agent/contracts/members";
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
  serviceLivenessSuccessSchema,
  serviceReadinessSuccessSchema,
  sessionRevokedSuccessSchema,
  wechatLoginExchangeSuccessSchema,
} from "@meal-agent/contracts/http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Logger } from "pino";
import { z } from "zod";

import { AppError } from "./errors.js";
import type { ApiRepository } from "./database/repository.js";

type ApiOperations = Pick<
  ApiRepository,
  | "addDietaryConstraint"
  | "consumeInventoryLot"
  | "createHousehold"
  | "createHouseholdInvite"
  | "createInventoryLot"
  | "createPersonProfile"
  | "exchangeWechatCode"
  | "getMe"
  | "joinHousehold"
  | "listHouseholdInvites"
  | "listHouseholdMembers"
  | "listHouseholds"
  | "listInventoryLots"
  | "patchPersonProfile"
  | "removeDietaryConstraint"
  | "removeMembership"
  | "revokeHouseholdInvite"
  | "revokeSession"
>;

const householdParamsSchema = z.strictObject({
  id: householdIdSchema,
});

const inventoryLotParamsSchema = z.strictObject({
  id: householdIdSchema,
  lotId: inventoryLotIdSchema,
});

const inviteParamsSchema = z.strictObject({
  id: householdIdSchema,
  inviteId: householdInviteIdSchema,
});

const membershipParamsSchema = z.strictObject({
  id: householdIdSchema,
  membershipId: membershipIdSchema,
});

const personProfileParamsSchema = z.strictObject({
  id: householdIdSchema,
  profileId: personProfileIdSchema,
});

const paginationQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const idempotencyHeadersSchema = z.object({
  "idempotency-key": idempotencyKeySchema,
});

const problemResponse = {
  description: "RFC 9457 problem details",
  content: {
    "application/problem+json": {
      schema: apiErrorSchema,
    },
  },
} as const;

const commonErrorResponses = {
  400: problemResponse,
  401: problemResponse,
  403: problemResponse,
  404: problemResponse,
  409: problemResponse,
  413: problemResponse,
  414: problemResponse,
  415: problemResponse,
  500: problemResponse,
  503: problemResponse,
} as const;

const protectedRoute = {
  security: [{ bearerAuth: [] }],
} as const;

const bearerToken = (request: FastifyRequest): string | undefined => {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    return undefined;
  }
  return authorization.slice("Bearer ".length);
};

const requestIdOf = (request: FastifyRequest): RequestId =>
  requestIdSchema.parse(request.id);

const paginationOptions = (query: {
  readonly limit: number;
  readonly cursor?: string | undefined;
}) => ({
  limit: query.limit,
  ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
});

const success = <T>(requestId: RequestId, data: T) => ({
  ok: true as const,
  data,
  meta: { requestId },
});

export const registerRoutes = async (
  fastify: FastifyInstance<any, any, any, Logger>,
  operations: ApiOperations,
  readiness: () => Promise<boolean>,
): Promise<void> => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/healthz",
    {
      schema: {
        operationId: "getHealth",
        tags: ["operations"],
        response: {
          200: serviceLivenessSuccessSchema,
          413: problemResponse,
          414: problemResponse,
          415: problemResponse,
          500: problemResponse,
        },
      },
    },
    async (request) =>
      success(requestIdOf(request), { status: "ok" as const }),
  );

  app.get(
    "/readyz",
    {
      schema: {
        operationId: "getReadiness",
        tags: ["operations"],
        response: {
          200: serviceReadinessSuccessSchema,
          413: problemResponse,
          414: problemResponse,
          415: problemResponse,
          500: problemResponse,
          503: problemResponse,
        },
      },
    },
    async (request) => {
      if (!(await readiness())) {
        throw new AppError(
          "EXTERNAL_DEPENDENCY_UNAVAILABLE",
          "Database or migrations are not ready",
          { retryable: true },
        );
      }
      return success(requestIdOf(request), {
        status: "ready" as const,
        database: "ready" as const,
        migrations: "ready" as const,
      });
    },
  );

  app.post(
    "/api/v1/auth/wechat/exchange",
    {
      schema: {
        operationId: "exchangeWechatLoginCode",
        tags: ["authentication"],
        body: wechatLoginExchangeRequestSchema,
        response: {
          200: wechatLoginExchangeSuccessSchema,
          400: problemResponse,
          401: problemResponse,
          413: problemResponse,
          414: problemResponse,
          415: problemResponse,
          500: problemResponse,
          503: problemResponse,
        },
      },
    },
    async (request) =>
      success(
        requestIdOf(request),
        await operations.exchangeWechatCode(request.body.loginCode),
      ),
  );

  app.delete(
    "/api/v1/session",
    {
      schema: {
        operationId: "revokeCurrentSession",
        tags: ["authentication"],
        ...protectedRoute,
        response: {
          200: sessionRevokedSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request) =>
      success(
        requestIdOf(request),
        await operations.revokeSession(
          bearerToken(request),
          requestIdOf(request),
        ),
      ),
  );

  app.get(
    "/api/v1/me",
    {
      schema: {
        operationId: "getCurrentUser",
        tags: ["identity"],
        ...protectedRoute,
        response: {
          200: meSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request) =>
      success(
        requestIdOf(request),
        await operations.getMe(
          bearerToken(request),
          requestIdOf(request),
        ),
      ),
  );

  app.post(
    "/api/v1/households",
    {
      schema: {
        operationId: "createHousehold",
        tags: ["households"],
        ...protectedRoute,
        headers: idempotencyHeadersSchema,
        body: createHouseholdRequestSchema,
        response: {
          201: createHouseholdSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.createHousehold(
        bearerToken(request),
        requestIdOf(request),
        request.headers["idempotency-key"],
        request.body,
      );
      return reply.code(result.statusCode as 201).send(result.body);
    },
  );

  app.get(
    "/api/v1/households",
    {
      schema: {
        operationId: "listHouseholds",
        tags: ["households"],
        ...protectedRoute,
        querystring: paginationQuerySchema,
        response: {
          200: householdPageSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request) =>
      success(
        requestIdOf(request),
        await operations.listHouseholds(
          bearerToken(request),
          requestIdOf(request),
          paginationOptions(request.query),
        ),
      ),
  );

  app.get(
    "/api/v1/households/:id/inventory-lots",
    {
      schema: {
        operationId: "listInventoryLots",
        tags: ["inventory"],
        ...protectedRoute,
        params: householdParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: inventoryLotPageSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request) =>
      success(
        requestIdOf(request),
        await operations.listInventoryLots(
          bearerToken(request),
          requestIdOf(request),
          request.params["id"],
          paginationOptions(request.query),
        ),
      ),
  );

  app.post(
    "/api/v1/households/:id/inventory-lots",
    {
      schema: {
        operationId: "createInventoryLot",
        tags: ["inventory"],
        ...protectedRoute,
        params: householdParamsSchema,
        headers: idempotencyHeadersSchema,
        body: createInventoryLotRequestSchema,
        response: {
          201: createInventoryLotSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.createInventoryLot(
        bearerToken(request),
        requestIdOf(request),
        request.params["id"],
        request.headers["idempotency-key"],
        request.body,
      );
      return reply.code(result.statusCode as 201).send(result.body);
    },
  );

  app.post(
    "/api/v1/households/:id/inventory-lots/:lotId/events/consumed",
    {
      schema: {
        operationId: "consumeInventoryLot",
        tags: ["inventory"],
        ...protectedRoute,
        params: inventoryLotParamsSchema,
        headers: idempotencyHeadersSchema,
        body: consumeInventoryLotRequestSchema,
        response: {
          201: consumeInventoryLotSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.consumeInventoryLot(
        bearerToken(request),
        requestIdOf(request),
        request.params["id"],
        request.params["lotId"],
        request.headers["idempotency-key"],
        request.body,
      );
      return reply.code(result.statusCode as 201).send(result.body);
    },
  );

  app.post(
    "/api/v1/households/:id/invites",
    {
      schema: {
        operationId: "createHouseholdInvite",
        tags: ["invites"],
        ...protectedRoute,
        params: householdParamsSchema,
        headers: idempotencyHeadersSchema,
        body: createHouseholdInviteRequestSchema,
        response: {
          201: createHouseholdInviteSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.createHouseholdInvite(
        bearerToken(request),
        requestIdOf(request),
        request.params["id"],
        request.headers["idempotency-key"],
        request.body,
      );
      return reply.code(result.statusCode as 201).send(result.body);
    },
  );

  app.get(
    "/api/v1/households/:id/invites",
    {
      schema: {
        operationId: "listHouseholdInvites",
        tags: ["invites"],
        ...protectedRoute,
        params: householdParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: householdInvitePageSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request) =>
      success(
        requestIdOf(request),
        await operations.listHouseholdInvites(
          bearerToken(request),
          requestIdOf(request),
          request.params["id"],
          paginationOptions(request.query),
        ),
      ),
  );

  app.delete(
    "/api/v1/households/:id/invites/:inviteId",
    {
      schema: {
        operationId: "revokeHouseholdInvite",
        tags: ["invites"],
        ...protectedRoute,
        params: inviteParamsSchema,
        headers: idempotencyHeadersSchema,
        response: {
          200: revokeHouseholdInviteSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.revokeHouseholdInvite(
        bearerToken(request),
        requestIdOf(request),
        request.params["id"],
        request.params["inviteId"],
        request.headers["idempotency-key"],
      );
      return reply.code(result.statusCode as 200).send(result.body);
    },
  );

  app.post(
    "/api/v1/households/join",
    {
      schema: {
        operationId: "joinHousehold",
        tags: ["households"],
        ...protectedRoute,
        headers: idempotencyHeadersSchema,
        body: joinHouseholdRequestSchema,
        response: {
          201: joinHouseholdSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.joinHousehold(
        bearerToken(request),
        requestIdOf(request),
        request.headers["idempotency-key"],
        request.body,
      );
      return reply.code(result.statusCode as 201).send(result.body);
    },
  );

  app.get(
    "/api/v1/households/:id/members",
    {
      schema: {
        operationId: "listHouseholdMembers",
        tags: ["members"],
        ...protectedRoute,
        params: householdParamsSchema,
        response: {
          200: listHouseholdMembersSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request) =>
      success(
        requestIdOf(request),
        await operations.listHouseholdMembers(
          bearerToken(request),
          requestIdOf(request),
          request.params["id"],
        ),
      ),
  );

  app.delete(
    "/api/v1/households/:id/memberships/:membershipId",
    {
      schema: {
        operationId: "removeMembership",
        tags: ["members"],
        ...protectedRoute,
        params: membershipParamsSchema,
        headers: idempotencyHeadersSchema,
        response: {
          200: removeMembershipSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.removeMembership(
        bearerToken(request),
        requestIdOf(request),
        request.params["id"],
        request.params["membershipId"],
        request.headers["idempotency-key"],
      );
      return reply.code(result.statusCode as 200).send(result.body);
    },
  );

  app.post(
    "/api/v1/households/:id/person-profiles",
    {
      schema: {
        operationId: "createPersonProfile",
        tags: ["profiles"],
        ...protectedRoute,
        params: householdParamsSchema,
        headers: idempotencyHeadersSchema,
        body: createPersonProfileRequestSchema,
        response: {
          201: personProfileSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.createPersonProfile(
        bearerToken(request),
        requestIdOf(request),
        request.params["id"],
        request.headers["idempotency-key"],
        request.body,
      );
      return reply.code(result.statusCode as 201).send(result.body);
    },
  );

  app.patch(
    "/api/v1/households/:id/person-profiles/:profileId",
    {
      schema: {
        operationId: "patchPersonProfile",
        tags: ["profiles"],
        ...protectedRoute,
        params: personProfileParamsSchema,
        headers: idempotencyHeadersSchema,
        body: patchPersonProfileRequestSchema,
        response: {
          200: personProfileSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.patchPersonProfile(
        bearerToken(request),
        requestIdOf(request),
        request.params["id"],
        request.params["profileId"],
        request.headers["idempotency-key"],
        request.body,
      );
      return reply.code(result.statusCode as 200).send(result.body);
    },
  );

  app.post(
    "/api/v1/households/:id/person-profiles/:profileId/dietary-constraints",
    {
      schema: {
        operationId: "addDietaryConstraint",
        tags: ["profiles"],
        ...protectedRoute,
        params: personProfileParamsSchema,
        headers: idempotencyHeadersSchema,
        body: addDietaryConstraintRequestSchema,
        response: {
          201: personProfileSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.addDietaryConstraint(
        bearerToken(request),
        requestIdOf(request),
        request.params["id"],
        request.params["profileId"],
        request.headers["idempotency-key"],
        request.body,
      );
      return reply.code(result.statusCode as 201).send(result.body);
    },
  );

  app.delete(
    "/api/v1/households/:id/person-profiles/:profileId/dietary-constraints",
    {
      schema: {
        operationId: "removeDietaryConstraint",
        tags: ["profiles"],
        ...protectedRoute,
        params: personProfileParamsSchema,
        headers: idempotencyHeadersSchema,
        body: removeDietaryConstraintRequestSchema,
        response: {
          200: personProfileSuccessSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await operations.removeDietaryConstraint(
        bearerToken(request),
        requestIdOf(request),
        request.params["id"],
        request.params["profileId"],
        request.headers["idempotency-key"],
        request.body,
      );
      return reply.code(result.statusCode as 200).send(result.body);
    },
  );
};
