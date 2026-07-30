import { requestIdSchema } from "@meal-agent/contracts";
import {
  apiErrorCodeSchema,
  apiErrorStatus,
  type ApiErrorCode,
} from "@meal-agent/contracts/api";
import type { Logger } from "pino";

import { errorTypeOf, isAllowedErrorType } from "./logging.js";

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
 * 这一层换方向：**业务代码根本不把任意对象交给 logger**，而且第十二轮起连
 * **logger 本身**都拿不到。
 *
 * ## EventLogSink：业务代码唯一持有的东西
 *
 * 上一版的 `logEvent(logger, event, fields)` 接受任意 `FastifyBaseLogger`。那意味
 * 着业务代码可以把**任何**一个 logger 递进来——包括一个带 binding 的子 logger。
 * binding 里的取值不经过事件字段那套类型约束，只能靠中央边界按**键名**脱敏；而
 * 键名规则是一份人工维护的名单，对**中性键**（`traceContext`、`correlation` 之类）
 * 本来就没有覆盖。第十一轮的 `apiKey` 缺口就是这条路上被抓出来的。
 *
 * 现在：`createEventLogSink(root)` 由**可信 root logger** 创建一个 sink，业务代码
 * 只持有 sink。sink 内部闭包持有 root logger，外部没有任何取回它的入口，也没有
 * `child()` / `setBindings()`。因此业务事件行里**只可能**出现事件目录声明过的字段。
 *
 * Fastify 框架自己打的请求日志（`incoming request`、`request completed`、
 * defaultErrorLog）仍然由 `logging.ts` 的固定 serializer 做纵深防御——那条路径绕不
 * 过 facade，也不属于业务日志。
 *
 * ## 字段是专用安全类型，不是自由字符串
 *
 *   - `errorType`：branded，只能由 `eventErrorType()` 产生，运行期再经
 *     `isAllowedErrorType()` 验一次；
 *   - `errorCode`：项目真实的 `ApiErrorCode`，运行期用 contracts 的 schema 验；
 *   - `requestId`：branded，只能由 `eventRequestId()` 产生，运行期用 contracts 的
 *     `requestIdSchema` 验；
 *   - `signal`：只允许 `SIGINT` / `SIGTERM`。
 *
 * 任何一项验不过就**抛错**（fail closed），而不是写一个占位串。
 *
 * `statusCode` **不接受调用方传值**：它由 `apiErrorStatus[errorCode]` 派生，因此
 * 「`SESSION_EXPIRED` 配 599」这种自相矛盾的组合在结构上就造不出来。
 *
 * `event` 是保留字段：projector 产出的对象里不可能有它，assemble 时它最后写入，
 * 调用方没有任何路径能覆盖。
 */

/** 事件字段的取值域。对象、数组、函数在类型上就传不进来。 */
export type LogFieldValue = string | number | boolean | null;

declare const safeErrorTypeBrand: unique symbol;
declare const safeRequestIdBrand: unique symbol;

/**
 * 已归一化的错误类型名。
 *
 * brand 让它**只能**由 `eventErrorType()` 产生：随便一个字符串字面量赋不进来，
 * 因此「自由文本冒充安全字段」在类型上就不成立。运行期还会再验一次。
 */
export type SafeErrorType = string & { readonly [safeErrorTypeBrand]: true };

/** 已校验的 request id，只能由 `eventRequestId()` 产生。 */
export type SafeRequestId = string & { readonly [safeRequestIdBrand]: true };

/** 优雅停机只可能由这两个信号触发。 */
export type ShutdownSignal = "SIGINT" | "SIGTERM";

/**
 * 事件闭集。新增事件必须同时改这里、改 `eventCatalogue`、改 `projectors`——
 * 三处都是穷尽映射，漏一处就编译不过。
 */
export interface LogEventFields {
  readonly "request.failed": {
    readonly requestId: SafeRequestId;
    readonly errorType: SafeErrorType;
  };
  readonly "request.rejected": {
    readonly requestId: SafeRequestId;
    readonly errorCode: ApiErrorCode;
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
  if (typeof value !== "string" || !isAllowedErrorType(value)) {
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

const checkedRequestId = (event: string, value: unknown): string => {
  const parsed = requestIdSchema.safeParse(value);
  if (!parsed.success) {
    return rejectField(
      event,
      "requestId",
      "must come from eventRequestId() and satisfy requestIdSchema",
    );
  }
  return parsed.data;
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
 *
 * `statusCode` 由 `errorCode` **派生**，不从 fields 里取：调用方造不出
 * 「`SESSION_EXPIRED` 配 599」这种自相矛盾的组合。
 */
const projectors: {
  readonly [Event in LogEventName]: (
    fields: LogEventFields[Event],
  ) => Readonly<Record<string, LogFieldValue>>;
} = {
  "request.failed": (fields) => ({
    requestId: checkedRequestId("request.failed", fields.requestId),
    errorType: checkedErrorType("request.failed", fields.errorType),
  }),
  "request.rejected": (fields) => {
    const errorCode = checkedErrorCode("request.rejected", fields.errorCode);
    return {
      requestId: checkedRequestId("request.rejected", fields.requestId),
      errorCode,
      statusCode: apiErrorStatus[errorCode],
    };
  },
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
 * 业务代码持有的**唯一**日志能力。
 *
 * 它只有 `emit` 一个方法。root logger 关在闭包里，外部没有取回它的入口，因此
 * 也就没有 `child()` / `setBindings()` 这类能把任意 binding 挂上去的路径。
 */
export interface EventLogSink {
  emit<Event extends LogEventName>(
    event: Event,
    fields: LogEventFields[Event],
  ): void;
}

/**
 * 从**可信 root logger** 创建一个 sink。
 *
 * 只有组装根（`buildApp`）会调用它，参数是它自己刚从 `createLogger()` 拿到的那个
 * root logger——不是任何请求作用域的子 logger。
 */
export const createEventLogSink = (root: Logger): EventLogSink => {
  const emit: EventLogSink["emit"] = (event, fields) => {
    const { level, message } = eventCatalogue[event];
    const projected = projectors[event](fields);
    if (Object.hasOwn(projected, reservedField)) {
      // 只可能是有人给 projector 加了一个叫 `event` 的字段。fail closed。
      throw new Error(`log event ${event}: ${reservedField} is reserved`);
    }
    // `event` **最后**写入，调用方没有任何路径能覆盖它。
    root[level]({ ...projected, [reservedField]: event }, message);
  };
  const sink = {} as { emit: EventLogSink["emit"] };
  // `emit` 不可替换：既不可写也不可重定义。一个被 decorate 到 Fastify 实例上的
  // 对象，任何拿得到实例的人都够得着；如果 `emit` 可以被换掉，前面所有关于字段
  // 与类型的约束都白做了。
  Object.defineProperty(sink, "emit", {
    value: emit,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return Object.freeze(sink);
};

/**
 * 从一个 Error 取出**已归一化的类型名**，供 `errorType` 字段使用。
 *
 * 这是原始 Error 与业务日志之间唯一的桥：返回值带 brand，因此 `errorType` 字段
 * 只能由它产生；返回的字符串一定通过 `isAllowedErrorType()`。
 */
export const eventErrorType = (error: unknown): SafeErrorType =>
  errorTypeOf(error) as SafeErrorType;

/**
 * 校验并 brand 一个 request id。
 *
 * 它接受 `unknown`：调用点拿到的是 Fastify 的 `request.id`，而那是一个可能来自
 * `x-request-id` 头的字符串。这里用 contracts 自己的 schema 验一次，验不过就抛。
 */
export const eventRequestId = (value: unknown): SafeRequestId => {
  const parsed = requestIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("log event: requestId does not satisfy requestIdSchema");
  }
  return parsed.data as unknown as SafeRequestId;
};
