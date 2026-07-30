import { apiErrorCodeSchema, type ApiErrorCode } from "@meal-agent/contracts/api";
import type { FastifyBaseLogger } from "fastify";

import { allowedErrorTypes, errorTypeOf } from "./logging.js";

/**
 * 阶段 09A / M3A：业务代码的**窄化 typed logging facade**。
 *
 * ## 为什么要有这一层
 *
 * 前九轮的路子是「让 logger 能安全地吃下任意对象」——净化器一轮补一个洞：原型
 * 污染、有状态 Proxy、装箱字符串、继承访问器、结构键、索引访问器……每一轮都还能
 * 再找出一个。那条路走不到头，因为它试图在**出口**证明一个关于任意输入的全称
 * 命题。
 *
 * 这一层换方向：**业务代码根本不把任意对象交给 logger**。能记的事件是**闭集**，
 * 每个事件的字段是**显式声明**的，而且每个字段都有自己的**专用安全类型**——
 * 不是「任意字符串」。原始 Error / Request / Reply / Config / Secret 在类型上就
 * 进不来。
 *
 * ## 第十一轮收口的三件事
 *
 * 1. **参数类型上没有开放的 `Record<string, LogFieldValue>`**。上一版为了让
 *    `logEvent` 能遍历字段，在参数上交了一个开放索引签名——那等于把「随便加一个
 *    原始类型字段」重新放了进来。现在参数就是 `LogEventFields[Event]` 本身。
 * 2. **每个事件有固定的 runtime projector**：逐个字段**按名字**取值，不遍历
 *    `Object.keys(fields)`。因此未声明的字段在结构上就到不了 payload——不是
 *    「遍历时被过滤掉」，是根本没被读过。
 * 3. **字段类型是专用安全类型，不是自由字符串**：
 *    - `errorType` 是 branded 类型，只能由 `eventErrorType()` 产生，运行期还要在
 *      `allowedErrorTypes` 里验一次；
 *    - `errorCode` 用项目真实的 `ApiErrorCode` union，运行期用 contracts 的
 *      schema 验一次；
 *    - `signal` 只允许 `SIGINT` / `SIGTERM`。
 *    任何一项验不过就**抛错**（fail closed），而不是「写一个占位串进去」。
 *
 * `event` 是保留字段：projector 产出的对象里不可能有它，assemble 时它最后写入，
 * 调用方没有任何路径能覆盖。
 *
 * ## 保留的纵深防御
 *
 * `logging.ts` 里的 `req`/`res`/`err` 固定 serializer **保留**，职责收窄成一件事：
 * Fastify **自己**打的那几条请求日志（`incoming request`、`request completed`、
 * defaultErrorLog）是框架直接调 logger 的，绕不过这一层 facade。业务代码不再
 * 依赖它。
 */

/** 事件字段的取值域。对象、数组、函数在类型上就传不进来。 */
export type LogFieldValue = string | number | boolean | null;

declare const safeErrorTypeBrand: unique symbol;

/**
 * 已归一化的错误类型名。
 *
 * brand 让它**只能**由 `eventErrorType()` 产生：随便一个字符串字面量赋不进来，
 * 因此「自由文本冒充安全字段」在类型上就不成立。运行期还会再验一次。
 */
export type SafeErrorType = string & { readonly [safeErrorTypeBrand]: true };

/** 优雅停机只可能由这两个信号触发。 */
export type ShutdownSignal = "SIGINT" | "SIGTERM";

/**
 * 事件闭集。新增事件必须同时改这里、改 `eventCatalogue`、改 `projectors`——
 * 三处都是穷尽映射，漏一处就编译不过。
 */
export interface LogEventFields {
  readonly "request.failed": {
    readonly errorType: SafeErrorType;
  };
  readonly "request.rejected": {
    readonly errorCode: ApiErrorCode;
    readonly statusCode: number;
  };
  readonly "shutdown.started": {
    readonly signal: ShutdownSignal;
  };
  readonly "shutdown.timed-out": Record<never, never>;
  readonly "startup.failed": {
    readonly errorType: SafeErrorType;
  };
}

export type LogEventName = keyof LogEventFields;

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/** 每个事件的级别与固定 msg。msg 是**常量**，不由调用点拼接。 */
const eventCatalogue: {
  readonly [Event in LogEventName]: {
    readonly level: LogLevel;
    readonly message: string;
  };
} = {
  "request.failed": { level: "error", message: "request failed" },
  "request.rejected": { level: "warn", message: "request rejected" },
  "shutdown.started": { level: "info", message: "graceful shutdown started" },
  "shutdown.timed-out": {
    level: "fatal",
    message: "graceful shutdown timed out",
  },
  "startup.failed": { level: "fatal", message: "API startup failed" },
};

/** 运行期验证：验不过就抛，绝不降级成占位串。 */
const rejectField = (event: string, field: string, why: string): never => {
  throw new Error(
    `log event ${event}: field ${field} is not acceptable (${why})`,
  );
};

const checkedErrorType = (event: string, value: unknown): string => {
  if (typeof value !== "string" || !allowedErrorTypes.has(value)) {
    return rejectField(
      event,
      "errorType",
      "must come from eventErrorType() and be a registered error type",
    );
  }
  return value;
};

const checkedErrorCode = (event: string, value: unknown): ApiErrorCode => {
  const parsed = apiErrorCodeSchema.safeParse(value);
  if (!parsed.success) {
    return rejectField(event, "errorCode", "must be a declared ApiErrorCode");
  }
  return parsed.data;
};

const checkedStatusCode = (event: string, value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 100 ||
    value > 599
  ) {
    return rejectField(event, "statusCode", "must be an integer HTTP status");
  }
  return value;
};

const checkedSignal = (event: string, value: unknown): ShutdownSignal => {
  if (value !== "SIGINT" && value !== "SIGTERM") {
    return rejectField(event, "signal", "must be SIGINT or SIGTERM");
  }
  return value;
};

/**
 * 每个事件的**固定 projector**：逐个字段按名字取值。
 *
 * 这里刻意**不**遍历 `Object.keys(fields)`——遍历意味着「先看看传进来了什么，
 * 再决定留哪些」，而未声明的字段应该在结构上就到不了 payload，不是被过滤掉。
 * 多传一个字段在这里连读都不会被读到。
 */
const projectors: {
  readonly [Event in LogEventName]: (
    fields: LogEventFields[Event],
  ) => Readonly<Record<string, LogFieldValue>>;
} = {
  "request.failed": (fields) => ({
    errorType: checkedErrorType("request.failed", fields.errorType),
  }),
  "request.rejected": (fields) => ({
    errorCode: checkedErrorCode("request.rejected", fields.errorCode),
    statusCode: checkedStatusCode("request.rejected", fields.statusCode),
  }),
  "shutdown.started": (fields) => ({
    signal: checkedSignal("shutdown.started", fields.signal),
  }),
  "shutdown.timed-out": () => ({}),
  "startup.failed": (fields) => ({
    errorType: checkedErrorType("startup.failed", fields.errorType),
  }),
};

/** `event` 是保留字段，任何 projector 都不得产出它。 */
const reservedField = "event";

/**
 * 业务代码记录日志的**唯一**入口。
 *
 * 字段、级别、msg 全部来自事件目录，调用点没有任何自由拼接的余地。
 */
export const logEvent = <Event extends LogEventName>(
  logger: FastifyBaseLogger,
  event: Event,
  fields: LogEventFields[Event],
): void => {
  const { level, message } = eventCatalogue[event];
  const projected = projectors[event](fields);
  if (Object.hasOwn(projected, reservedField)) {
    // 只可能是有人给 projector 加了一个叫 `event` 的字段。fail closed。
    throw new Error(`log event ${event}: ${reservedField} is reserved`);
  }
  // `event` **最后**写入，调用方没有任何路径能覆盖它。
  logger[level]({ ...projected, [reservedField]: event }, message);
};

/**
 * 从一个 Error 取出**已归一化的类型名**，供 `errorType` 字段使用。
 *
 * 这是原始 Error 与业务日志之间唯一的桥：返回值带 brand，因此 `errorType` 字段
 * 只能由它产生；返回的字符串一定在 `allowedErrorTypes` 里。
 */
export const eventErrorType = (error: unknown): SafeErrorType =>
  errorTypeOf(error) as SafeErrorType;
