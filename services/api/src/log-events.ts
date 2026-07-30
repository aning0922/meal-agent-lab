import type { FastifyBaseLogger } from "fastify";

import { errorTypeOf } from "./logging.js";

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
 * 每个事件的字段是**显式声明**的，字段类型只允许 `string | number | boolean |
 * null`。原始 Error / Request / Reply / Config / Secret 在类型上就进不来——不是
 * 「进来之后会被净化」，是**编译期就不可表达**。
 *
 * 静态门禁（`tests/unit/production-log-arguments.test.ts`）用 TypeScript 的
 * type checker 保证 `src/` 里除了本文件之外**没有任何**直接的 logger 调用，因此
 * 这条收窄不是靠自觉。
 *
 * ## 保留的纵深防御
 *
 * `logging.ts` 里的 `req`/`res`/`err` 固定 serializer **保留**，但它的职责收窄成
 * 一件事：Fastify **自己**打的那几条请求日志（`incoming request`、
 * `request completed`、defaultErrorLog）是框架直接调 logger 的，绕不过这一层
 * facade。那条路径上仍然需要投影与脱敏。业务代码不再依赖它。
 */

/** 事件字段只允许这些原始类型——对象、数组、函数在类型上就传不进来。 */
export type LogFieldValue = string | number | boolean | null;

/**
 * 事件闭集。新增事件必须改这里，因此「日志里会出现什么」是一份可以逐条复核的
 * 清单，而不是散落在调用点的自由发挥。
 */
export interface LogEventFields {
  readonly "request.failed": {
    /** 已经归一化过的错误类型名（来自 allowlist），不是原始 Error。 */
    readonly errorType: string;
  };
  readonly "request.rejected": {
    readonly errorCode: string;
    readonly statusCode: number;
  };
  readonly "shutdown.started": {
    readonly signal: string;
  };
  readonly "shutdown.timed-out": Record<string, never>;
  readonly "startup.failed": {
    readonly errorType: string;
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

/**
 * 业务代码记录日志的**唯一**入口。
 *
 * 字段被类型钉死，msg 来自事件目录，级别也来自事件目录——调用点没有任何自由拼接
 * 的余地，因此也就没有「不小心把一个对象拼进去」的可能。
 */
export const logEvent = <Event extends LogEventName>(
  logger: FastifyBaseLogger,
  event: Event,
  fields: LogEventFields[Event] & Readonly<Record<string, LogFieldValue>>,
): void => {
  const { level, message } = eventCatalogue[event];
  // 只从**声明过的**字段里取值，逐个复制成新对象：调用点即使传进来一个带额外
  // 属性的对象（TypeScript 的多余属性检查只在字面量上生效），多出来的那些也
  // 到不了 logger。
  const payload: Record<string, LogFieldValue> = { event };
  for (const key of Object.keys(fields).sort()) {
    const value = (fields as Record<string, unknown>)[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      payload[key] = value;
    }
  }
  logger[level](payload, message);
};

/**
 * 从一个 Error 取出**已归一化的类型名**，供 `errorType` 字段使用。
 *
 * 这是原始 Error 与业务日志之间唯一的桥：它返回一个 allowlist 里的字符串，
 * 原始对象本身到不了 logger。
 */
export const eventErrorType = (error: unknown): string => errorTypeOf(error);
