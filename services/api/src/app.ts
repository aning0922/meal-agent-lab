import {
  contractRuleBindings,
  contractRuleManifest,
  contractVersion,
  requestIdSchema,
} from "@meal-agent/contracts";
import fastifySwagger from "@fastify/swagger";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Logger } from "pino";
import type { OpenAPIV3 } from "openapi-types";

import type { AppConfig } from "./config.js";
import { ApiRepository } from "./database/repository.js";
import {
  checkReadiness,
  createPersistence,
  type Persistence,
} from "./database/pool.js";
import { AppError, problemFromError } from "./errors.js";
import { createLogger } from "./logging.js";
import { registerRoutes } from "./routes.js";
import { newEntityId } from "./utils.js";
import {
  createWechatAdapter,
  type WechatAdapter,
} from "./wechat/adapter.js";

type ApiOperations = Pick<
  ApiRepository,
  | "addDietaryConstraint"
  | "confirmPersonProfileLinkRequest"
  | "consumeInventoryLot"
  | "createHousehold"
  | "createHouseholdInvite"
  | "createInventoryLot"
  | "createPersonProfileLinkRequest"
  | "createPersonProfile"
  | "exchangeWechatCode"
  | "getMe"
  | "getPersonProfile"
  | "joinHousehold"
  | "listHouseholdInvites"
  | "listHouseholdMembers"
  | "listHouseholds"
  | "listInventoryLots"
  | "listPersonProfileLinkRequests"
  | "listPersonProfiles"
  | "patchPersonProfile"
  | "removeDietaryConstraint"
  | "removeMembership"
  | "revokeHouseholdInvite"
  | "revokeSession"
>;

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly logger?: Logger;
  readonly persistence?: Persistence;
  readonly wechatAdapter?: WechatAdapter;
  readonly operations?: ApiOperations;
  readonly readiness?: () => Promise<boolean>;
  readonly closePersistence?: boolean;
}

const validationError = (error: FastifyError): AppError => {
  if (!hasZodFastifySchemaValidationErrors(error)) {
    return new AppError("INTERNAL_ERROR", "Internal server error");
  }
  return new AppError("VALIDATION_FAILED", "Request does not match schema");
};

const isMalformedJson = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "FST_ERR_CTP_INVALID_JSON_BODY";

export const maximumRequestTargetBytes = 2_048;
export const maximumRequestBodyBytes = 1_048_576;

const fastifyContentError = (error: unknown): AppError | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = "code" in error ? error.code : undefined;
  const statusCode = "statusCode" in error ? error.statusCode : undefined;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413) {
    return new AppError(
      "PAYLOAD_TOO_LARGE",
      `Request body exceeds ${maximumRequestBodyBytes} bytes`,
    );
  }
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || statusCode === 415) {
    return new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Request content type is not supported",
    );
  }
  return undefined;
};

const mapRequestError = (error: unknown): AppError => {
  if (error instanceof AppError) {
    return error;
  }
  if (isMalformedJson(error)) {
    return new AppError(
      "VALIDATION_FAILED",
      "Request body is malformed JSON",
    );
  }
  const contentError = fastifyContentError(error);
  if (contentError !== undefined) {
    return contentError;
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    return validationError(error);
  }
  return new AppError("INTERNAL_ERROR", "Internal server error");
};

export const buildApp = async (
  options: BuildAppOptions,
): Promise<FastifyInstance<any, any, any, Logger>> => {
  const logger =
    options.logger ??
    createLogger(options.config.logLevel);
  const app = Fastify({
    bodyLimit: maximumRequestBodyBytes,
    loggerInstance: logger,
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      if (
        typeof supplied === "string" &&
        requestIdSchema.safeParse(supplied).success
      ) {
        return supplied;
      }
      return newEntityId();
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Meal Agent API",
        description: "Stage 08 audited modular-monolith API",
        version: contractVersion,
      },
      "x-meal-agent-contract-rules": contractRuleManifest,
      "x-meal-agent-contract-rule-bindings": contractRuleBindings,
      servers: [],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
    } as Partial<OpenAPIV3.Document>,
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  const persistence =
    options.persistence ??
    (options.operations === undefined
      ? createPersistence(options.config)
      : undefined);
  const wechatAdapter =
    options.wechatAdapter ??
    (options.operations === undefined
      ? createWechatAdapter(options.config)
      : undefined);
  const operations =
    options.operations ??
    (persistence !== undefined && wechatAdapter !== undefined
      ? new ApiRepository(persistence, options.config, wechatAdapter)
      : undefined);
  if (operations === undefined) {
    throw new Error("API operations are required");
  }
  const readiness =
    options.readiness ??
    (persistence === undefined
      ? async () => false
      : async () => checkReadiness(persistence));

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapRequestError(error);

    if (mapped.code === "INTERNAL_ERROR") {
      request.log.error({ err: error }, "request failed");
    } else {
      request.log.warn(
        { errorCode: mapped.code, statusCode: mapped.status },
        "request rejected",
      );
    }
    const problemInstance =
      request.url.split("?", 1)[0]?.slice(0, 500) || "/";
    const problem = problemFromError(mapped, request.id, problemInstance);
    return reply
      .code(mapped.status)
      .type("application/problem+json")
      .send(problem);
  });

  app.addHook("onRequest", async (request) => {
    if (
      Buffer.byteLength(request.raw.url ?? "", "utf8") >
      maximumRequestTargetBytes
    ) {
      throw new AppError(
        "URI_TOO_LONG",
        `Request target exceeds ${maximumRequestTargetBytes} bytes`,
      );
    }
  });

  app.setNotFoundHandler(async () => {
    throw new AppError("RESOURCE_NOT_FOUND", "Route was not found");
  });

  await registerRoutes(app, operations, readiness);

  if (
    persistence !== undefined &&
    (options.closePersistence ?? options.persistence === undefined)
  ) {
    app.addHook("onClose", async () => {
      await persistence.pool.end();
    });
  }

  return app;
};
