import { requestIdSchema } from "@meal-agent/contracts";
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
  | "consumeInventoryLot"
  | "createHousehold"
  | "createInventoryLot"
  | "exchangeWechatCode"
  | "getMe"
  | "listHouseholds"
  | "listInventoryLots"
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

export const buildApp = async (
  options: BuildAppOptions,
): Promise<FastifyInstance<any, any, any, Logger>> => {
  const logger =
    options.logger ??
    createLogger(options.config.logLevel);
  const app = Fastify({
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
        description: "Stage 06 minimum backend vertical slice",
        version: "0.1.0",
      },
      servers: [],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
    },
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
    const mapped =
      error instanceof AppError
        ? error
        : hasZodFastifySchemaValidationErrors(error)
          ? validationError(error)
          : new AppError("INTERNAL_ERROR", "Internal server error");

    if (mapped.code === "INTERNAL_ERROR") {
      request.log.error({ err: error }, "request failed");
    } else {
      request.log.warn(
        { errorCode: mapped.code, statusCode: mapped.status },
        "request rejected",
      );
    }
    const problem = problemFromError(mapped, request.id, request.url);
    return reply
      .code(mapped.status)
      .type("application/problem+json")
      .send(problem);
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
