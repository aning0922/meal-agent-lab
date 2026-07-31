import { requestIdSchema } from "@meal-agent/contracts";
import {
  apiErrorCodeSchema,
  apiErrorStatus,
  type ApiErrorCode,
} from "@meal-agent/contracts/api";
import type { Writable } from "node:stream";

import type { Logger } from "pino";

import { createLogger, errorTypeOf, isAllowedErrorType } from "./logging.js";

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
 * 从一个 root logger 包出 sink。
 *
 * **模块私有**。第十四轮起它不再是公开工厂：一个「接受任意 Logger」的公开入口
 * 本身就是一条能力出口——谁都能拿自己那个带 binding 的 logger 换一个 sink 出来。
 * 现在唯一的建法是 `createLoggingContext()`，它自己新建 event root、当场包成
 * sink，raw logger 只留在这个模块的词法作用域里。
 */
const createEventLogSink = (root: Logger): EventLogSink => {
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
 * 框架 logger 与业务事件 sink 的**分离容器**。
 *
 * 注意它**不**暴露 event root：`eventLog` 已经是包好的 sink。任何公开的
 * interface / factory 都不得返回 raw event `Logger`——那正是上一轮留下的口子。
 *
 * 所有权也在这里定死：
 *
 *   - `framework`：调用方注入时归**调用方**所有（测试要捕获框架日志），我们既不
 *     flush 也不 `end` 它；**没注入时由我们新建，那一棵就归我们，必须进 flush**；
 *   - event root：**永远**归我们所有，因此一定进 flush；
 *   - 目的地（`Writable`）：**永远**归调用方所有。我们**绝不 `end`**、绝不
 *     `destroy`、也绝不 `write` 关机标记——只读它的 `writableLength` 等它排空。
 *     口径要写实：flush **自有 root** 时 pino 会把回调转交给目的地自己的 `flush`
 *     （如果它有的话），所以「不碰调用方的东西」只对**调用方的 logger** 成立；
 *     调用方给的目的地会因为我们 flush 自有 root 而被调用一次 `flush`，它报错也会
 *     让 `close()` 失败——但那条失败**不会**让别的阶段被跳过。
 */
export interface LoggingContext {
  readonly framework: Logger;
  readonly eventLog: EventLogSink;
  /**
   * flush 自有的那些 logger，并等自有 logger 写进去的字节排空。
   *
   * **有界且 fail closed**：flush 报错、flush 回调超时、目的地排空超时——三者都
   * **reject**，不会静默当成关干净了。日志是审计面，「关的时候悄悄丢最后几条」
   * 与「没写过」在事后是分不清的。
   *
   * **failure-safe**：每一个适用的阶段都会跑到，一个阶段失败不跳过后面的阶段；
   * 失败在最后一次性聚合抛出（`AggregateError`），消息只由本模块自己的固定文本与
   * **归一化错误类型名**拼成，绝不带调用方或目的地的原始文本。
   *
   * **幂等**：重复调用拿到的是**同一个** promise，成功失败都一样。它不会重跑一遍
   * flush，也不会第二次调用就变成成功。
   */
  close: () => Promise<void>;
}

/**
 * 关机路径上取错误类型名的**唯一**入口。
 *
 * `errorTypeOf` 自己会读输入的原型与属性描述符，因此一个自指 Proxy
 * （`getPrototypeOf` / `getOwnPropertyDescriptor` 都抛自己）能让它**再抛一次**。
 * 那样一来抛出来的就是调用方的原始对象：它会穿过阶段收集器，close() 用调用方的值
 * 拒绝、剩下的阶段全被跳过——恰好把本轮两条保证一起打掉。
 *
 * 这里兜到一个固定串。宁可少一点诊断信息，也不能让调用方的取值出现在错误里。
 */
const safeErrorType = (error: unknown): string => {
  try {
    return errorTypeOf(error);
  } catch {
    return "UnreadableError";
  }
};

/** flush 与排空的硬上界。到点一律 reject，绝不静默放行。 */
const flushTimeoutMs = 2_000;
const drainTimeoutMs = 2_000;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * flush 一棵**我们自己建的** logger 树，有界且 fail closed。
 *
 * pino 的 `flush(cb)` 把回调直接交给目的地的 `flush`（`lib/proto.js:253`：
 * `typeof stream.flush === 'function' ? stream.flush(cb || noop) : cb && cb()`）。
 * 因此有三种收场：正常回调、带 error 的回调、以及**回调根本不来**。前一版只写了
 * `flush(() => resolve())`——后两种一个都没管：报错被吃掉，卡住则永远挂着。
 *
 * 错误消息里只保留**归一化的类型名**：目的地的 error message 是不可信文本，
 * 可能带上路径、连接串或别的取值。
 */
const flushOwned = (root: Logger, role: string): Promise<string | undefined> =>
  new Promise<string | undefined>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(
        `log flush timed out after ${String(flushTimeoutMs)}ms (${role})`,
      );
    }, flushTimeoutMs);
    // **刻意不 `unref()`**。unref 过的定时器不 ref 事件循环，而关机正是「循环里
    // 已经没有别的 handle」的那一刻：avvio 的 onClose 是 LIFO，监听 socket 已关、
    // 连接池已 end、`process.once("SIGTERM", …)` 的监听器本身也不 ref 循环。于是
    // 进程会直接退出，这条 reject 永远不会发生，退出码还是 0——比静默 resolve 更糟。
    // 它最多活 2 秒，是有界的。
    void timer;
    const done = (error?: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(
        error === undefined || error === null
          ? undefined
          : `log flush failed (${role}): ${safeErrorType(error)}`,
      );
    };
    try {
      root.flush(done);
    } catch (error) {
      done(error instanceof Error ? error : new Error("log flush threw"));
    }
  });

/**
 * 等目的地把已经交给它的字节写完。
 *
 * pino 的 `flush()` 只对它自己的 `destination` 有意义；目的地是一个普通
 * `Writable` 时它立刻回调，**不会**等 `_write` 的回调跑完。于是「关机前最后一条
 * 业务事件」在异步目的地上会丢（实测：延迟 5ms 的写入在 close 返回之后还没落地）。
 *
 * 这里只**等它排空**，绝不 `end()` 它——目的地归调用方所有。等待有硬上界，但到点
 * 是**报失败**而不是接着往下走：一个没排空的目的地意味着日志真的丢了。
 *
 * `writableLength` 是一个访问器，调用方给的对象可以让它抛。所以整段包起来，
 * 抛出来的东西只按**归一化类型名**记一笔。
 */
const awaitDrained = async (
  destination: Writable | undefined,
  role: string,
): Promise<string | undefined> => {
  if (destination === undefined) {
    return undefined;
  }
  const deadline = Date.now() + drainTimeoutMs;
  try {
    while (destination.writableLength > 0) {
      if (Date.now() >= deadline) {
        return `log destination did not drain within ${String(drainTimeoutMs)}ms (${role})`;
      }
      await sleep(1);
    }
  } catch (error) {
    return `log drain check failed (${role}): ${safeErrorType(error)}`;
  }
  return undefined;
};

/**
 * 建立分离容器。
 *
 * `framework` 允许由调用方注入；event root **永远**由这里新建、当场包成 sink，
 * 调用方没有任何入口拿到它，也没有入口把一个预绑定的 logger 塞进业务事件底座。
 *
 * 两个 `Writable` 参数都只是**目的地**，不是能力：给得进来的是「往哪写」，不是
 * 「用谁写」。`frameworkDestination` 只在**没有**注入 framework logger 时才有意义
 * ——两个一起给是矛盾的接线，直接抛错（fail closed），而不是默默忽略一个。
 */
export const createLoggingContext = (
  level: string,
  framework?: Logger,
  eventDestination?: Writable,
  frameworkDestination?: Writable,
): LoggingContext => {
  if (framework !== undefined && frameworkDestination !== undefined) {
    throw new Error(
      "logging context: an injected framework logger already owns its destination",
    );
  }
  // raw event logger 只存在于这个闭包里。它不出现在返回值上，也没有 getter。
  const eventRoot = createLogger(level, eventDestination);
  const eventLog = createEventLogSink(eventRoot);
  const frameworkLogger = framework ?? createLogger(level, frameworkDestination);
  // 注入进来的那棵归调用方所有：不 flush、不 end。只有**我们自己建的**才进名单。
  const ownedFramework = framework === undefined ? frameworkLogger : undefined;
  let closing: Promise<void> | undefined;
  /**
   * **failure-safe 的阶段收集器**：每一个适用的阶段都要跑到。
   *
   * 上一版是一串 `await`，第一处失败就把后面的阶段全跳过了——「event flush 报错，
   * 于是 framework 那棵根本没 flush」。关机路径上这正好是最坏的顺序：一个坏掉的
   * 目的地会连累另一个好的目的地一起丢日志。
   *
   * 现在每个阶段各自收成一条**本模块自己写的**安全原因（阶段函数不抛，只返回
   * 原因字符串），跑完再一次性聚合抛出。因此错误里永远不会出现调用方的文本。
   */
  const runClose = async (): Promise<void> => {
    const stages: (() => Promise<string | undefined>)[] = [
      () => flushOwned(eventRoot, "event"),
    ];
    if (ownedFramework !== undefined) {
      stages.push(() => flushOwned(ownedFramework, "framework"));
      stages.push(() => awaitDrained(frameworkDestination, "framework"));
    }
    stages.push(() => awaitDrained(eventDestination, "event"));

    const reasons: string[] = [];
    for (const stage of stages) {
      let reason: string | undefined;
      try {
        reason = await stage();
      } catch (error) {
        // 阶段函数本身不该抛；真抛了也只按归一化类型名记一笔，绝不带调用方文本。
        reason = `log close stage threw: ${safeErrorType(error)}`;
      }
      if (reason !== undefined) {
        reasons.push(reason);
      }
    }
    if (reasons.length === 0) {
      return;
    }
    throw new AggregateError(
      reasons.map((reason) => new Error(reason)),
      `log close failed in ${String(reasons.length)} of ${String(stages.length)} stage(s): ${reasons.join("; ")}`,
    );
  };
  return {
    framework: frameworkLogger,
    eventLog,
    close: () => {
      // exactly-once：第二次调用拿到的是同一个 promise，不会再 flush 一遍，失败也
      // 不会因为重试而变成成功。
      if (closing === undefined) {
        closing = runClose();
        // 记住的 promise 可能是 rejected 的。挂一个空 catch 只是为了让「没人 await
        // 第二次调用」不至于报 unhandled rejection——返回的仍然是原 promise，失败
        // 照样传播给每一个调用方。
        void closing.catch(() => undefined);
      }
      return closing;
    },
  };
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
