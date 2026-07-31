import {
  contractRuleBindings,
  contractRuleManifest,
  contractVersion,
  requestIdSchema,
} from "@meal-agent/contracts";
import fastifySwagger from "@fastify/swagger";
import type { Writable } from "node:stream";

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
import {
  createLoggingContext,
  eventErrorType,
  eventRequestId,
  type EventLogSink,
} from "./log-events.js";
import { registerRequestLogFields } from "./logging.js";
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

declare module "fastify" {
  interface FastifyInstance {
    /**
     * 业务代码唯一持有的日志能力。它由**组装根**从 root logger 创建，内部闭包
     * 持有那个 logger；实例上没有任何取回它的入口，也没有 `child()`。
     */
    readonly eventLog: EventLogSink;
  }
}

export interface BuildAppOptions {
  readonly config: AppConfig;
  /**
   * **框架** logger（Fastify 的 `loggerInstance`）。测试用它捕获框架请求日志。
   *
   * 它**不是**业务事件的底座：业务事件走 `LoggingContext` 里那个已经包好的
   * `EventLogSink`，它的 root 由 `createLoggingContext()` 新建，调用方没有任何
   * 入口把一个预绑定的 logger 塞进去。
   *
   * 注入进来的这一棵归**调用方**所有：`app.close` 既不 flush 它也不 `end` 它。
   * 只有在**没有**注入时由我们自己建的那一棵才进关机 flush 名单。
   */
  readonly logger?: Logger;
  /**
   * 业务事件的**目的地**。测试用它捕获业务事件行。
   *
   * 注意这里给的是一个 `Writable`，不是一个现成的 sink，更不是一个 logger：
   * event root 仍然由组装根自己新建、当场包成 sink，调用方拿不到它。上一版的
   * `eventSink?: EventLogSink` 让测试可以整个替掉 sink，于是「预绑定 framework
   * 不会污染业务事件」那条集成测试其实没走生产接线。
   */
  readonly eventLogDestination?: Writable;
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

/**
 * 阶段 09A / M3A：全部响应统一携带的安全响应头。
 *
 * 逐路由添加会漏：真正需要 `no-store` 的恰恰是登录、家庭私有数据与错误响应，
 * 而错误响应由 error handler、404 handler 与 schema 校验失败三条不同路径产生，
 * 没有一条经过业务 handler。因此这里挂在全局 `onSend` 上——它是所有响应
 * （含 problem+json）唯一的公共出口。
 *
 * 阶段 09A 不引入 CORS：仓库里没有任何 `Access-Control-Allow-Origin`，
 * 因此也不存在 wildcard CORS。
 */
export const securityResponseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

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
  // 框架 logger 与业务事件 logger 是**两个独立的 pino 根**，只是写向同一个目的地。
  // `options.logger` 只能注入 framework 那一侧。
  const logging = createLoggingContext(
    options.config.logLevel,
    options.logger,
    options.eventLogDestination,
  );
  // 业务事件的 sink 只从**词法闭包**里取。下面虽然也 decorate 到实例上（给
  // index.ts 用），但错误处理器**不**去读那个属性——读一个可替换的属性等于把
  // 「谁来处理业务事件」交给任何拿得到实例的人。
  const eventLog = logging.eventLog;
  const app = Fastify({
    bodyLimit: maximumRequestBodyBytes,
    loggerInstance: logging.framework,
    genReqId: (request) => {
      // 这里是能拿到「这一条请求确实来自 Fastify」的**最早**的点：Fastify 在
      // 构造它的 Request、也在打出 "incoming request" 之前调用 genReqId。登记
      // 之后，logger 的固定 serializer 才敢去读 Request 原型上的访问器
      // （method/url/ip/socket），而伪造对象拿不到这个标识。
      const supplied = request.headers["x-request-id"];
      const id =
        typeof supplied === "string" &&
        requestIdSchema.safeParse(supplied).success
          ? supplied
          : newEntityId();
      // 请求字段在**这里**读——Fastify 刚把 raw request 交给我们、还没经过任何
      // 调用方之手的唯一一刻，读的是平台自己的对象。读完物化成四个字符串传给
      // logger；logger 那一侧的登记函数不读任何属性，也不调用任何访问器。
      registerRequestLogFields(request, {
        requestId: id,
        method: request.method,
        path: (request.url ?? "").split("?")[0],
        remoteAddress: request.socket?.remoteAddress,
      });
      return id;
    },
  });

  // sink 的底座是 `createLoggingContext()` 在**它自己的模块词法作用域**里新建的
  // 那个 event root——它**从不**出现在 `LoggingContext`、`app.log` / `request.log`
  // 或任何公开返回值上。业务代码此后只持有 `app.eventLog`。
  app.decorate("eventLog", eventLog);
  // `decorate` 只是普通赋值，属性仍然可写可配置。钉成只读且不可重定义：赋值与
  // `Object.defineProperty` 都会失败，业务事件永远走上面那个词法闭包里的 sink。
  Object.defineProperty(app, "eventLog", {
    value: eventLog,
    writable: false,
    enumerable: true,
    configurable: false,
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

    // 用 sink，不用 `request.log`：请求作用域的子 logger 可能带着任意 binding，
    // 而 binding 里的取值不受事件字段那套类型约束。requestId 作为**声明过的字段**
    // 显式带上，因此相关性没有丢。
    if (mapped.code === "INTERNAL_ERROR") {
      eventLog.emit("request.failed", {
        requestId: eventRequestId(request.id),
        errorType: eventErrorType(error),
      });
    } else {
      eventLog.emit("request.rejected", {
        requestId: eventRequestId(request.id),
        errorCode: mapped.code,
      });
    }
    const problemInstance =
      request.url.split("?", 1)[0]?.slice(0, 500) || "/";
    const problem = problemFromError(mapped, request.id, problemInstance);
    return reply
      .code(mapped.status)
      .type("application/problem+json")
      .send(problem);
  });

  // onSend 是全部响应的公共出口：成功、validation 失败、404 与 problem+json
  // 都会经过它，因此安全响应头不可能因为新增一条路由而漏掉。
  app.addHook("onSend", async (_request, reply) => {
    for (const [header, value] of Object.entries(securityResponseHeaders)) {
      reply.header(header, value);
    }
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

  // 生命周期：flush **自有**的那些 logger（event root，以及没被注入时我们自己建的
  // framework root），再等自有 logger 写进去的字节排空。调用方注入的 framework
  // logger 与所有 `Writable` 都归调用方所有，我们既不 flush 也不 end。
  //
  // `close` 是**有界且 fail closed** 的：flush 报错、flush 回调超时、排空超时都会
  // reject，并经由这个 hook 让 `app.close()` 一起失败。关机时悄悄丢掉最后几条日志，
  // 事后与「根本没写过」分不清。
  app.addHook("onClose", async () => {
    await logging.close();
  });

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
