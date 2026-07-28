import type { Writable } from "node:stream";

import pino, { type LogFn, type Logger } from "pino";

const sensitiveKeys = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "code",
  "invitecode",
  "logincode",
  "token",
  "accesstoken",
  "sessiontoken",
  "tokendigest",
  "openid",
  "unionid",
  "providersubject",
  "providerunionsubject",
  "session_key",
  "sessionkey",
  "appsecret",
  "wechatappsecret",
  "dietaryconstraints",
  "memberprivateconstraints",
  // 阶段 09A / M3A：数据库凭据与连接串的常见命名。归一化会去掉分隔符并转小写，
  // 因此 `database_url`、`databaseUrl`、`DATABASE-URL` 都落在同一个键上。
  "databaseurl",
  "connectionstring",
  "connectionuri",
  "conninfo",
  "dsn",
  "password",
  "dbpassword",
  "pgpassword",
]);

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    sensitiveKeys.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("openid") ||
    normalized.endsWith("unionid") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("databaseurl") ||
    normalized.endsWith("connectionstring") ||
    normalized.endsWith("connectionuri") ||
    normalized.endsWith("dsn")
  );
};

/**
 * 按**取值**脱敏，与按键名脱敏互补。
 *
 * 只按键名不够：`{ note: "postgresql://app:pw@db/meal_agent" }` 的键完全无害，
 * 值却是一整条带口令的连接串。整条连接串一次性替换掉，因此口令的原值与
 * URL 百分号编码形态（`p%40ss`）会**同时**消失——只脱敏原值会漏掉编码形态。
 *
 * libpq 的 key/value conninfo 不是 URL，单独覆盖一次，并且是**保守**的：
 * `password=' 带空格且被引号包起来的值'` 这类形态无法用一条正则可靠地找到
 * 结束位置，因此一旦看到 `password=` 就把**其后的全部文本**删掉。宁可多脱敏
 * 一段无害的尾巴，也不能漏掉一个口令。
 */
const connectionStringPattern = /postgres(?:ql)?:\/\/\S*/gi;
const conninfoPasswordPattern = /pass(?:word|file)\s*=[\s\S]*$/i;

export const redactText = (value: string): string =>
  value
    .replace(connectionStringPattern, "[Redacted]")
    .replace(conninfoPasswordPattern, "password=[Redacted]");

/** Error 归一化后的固定 message：内部细节永远不进入日志。 */
export const safeErrorMessage = "request failed";

/**
 * 递归安全化。它同时是**脱敏器**与 **canonicalizer**：返回值一定是由字符串、
 * 数字、布尔、null、数组和**纯对象**构成的树，因此后续的 `JSON.stringify`
 * 阶段不可能再执行任何用户代码。
 *
 * 具体地：
 *   - 函数值（包括 own enumerable 的 `toJSON` / `toString`）被替换成占位串，
 *     否则 `JSON.stringify` 会调用 `toJSON` 把刚刚脱敏掉的取值**重新生成**出来；
 *   - `Error` 的 `message`/`stack` 是不可枚举属性，按属性递归看不见它们，因此
 *     显式归一化成与 err serializer 完全相同的安全形状；
 *   - 循环引用防护对**对象与数组共用**同一个 WeakSet，并且是按**路径**记录
 *     （递归返回后移除），所以同一个对象作为兄弟节点出现两次不会被误判为循环。
 */
export const redactSensitive = (
  value: unknown,
  seen = new WeakSet<object>(),
): unknown => {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  if (value instanceof Error) {
    return { type: value.name, message: safeErrorMessage };
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactSensitive(item, seen));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveKey(key) ? "[Redacted]" : redactSensitive(entry, seen),
      ]),
    );
  } finally {
    seen.delete(value);
  }
};

/**
 * `req` / `res` / `err` 由各自的 serializer 投影成固定的安全形状，因此中央
 * 脱敏跳过它们：把 Fastify 的 request 实例递归成普通对象反而会让 serializer
 * 读不到 `request.url` 这类原型上的取值器，日志质量下降而安全性没有提升。
 */
const serializedKeys = new Set(["req", "res", "err"]);

const redactLogObject = (
  object: Record<string, unknown>,
): Record<string, unknown> => {
  const seen = new WeakSet<object>();
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => {
      if (serializedKeys.has(key)) {
        return [key, value];
      }
      return [
        key,
        isSensitiveKey(key) ? "[Redacted]" : redactSensitive(value, seen),
      ];
    }),
  );
};

const isNormalizedError = (
  error: unknown,
): error is { type: string; message: string } =>
  typeof error === "object" &&
  error !== null &&
  Object.keys(error).length === 2 &&
  typeof (error as { type?: unknown }).type === "string" &&
  (error as { message?: unknown }).message === safeErrorMessage;

const safeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: safeErrorMessage,
    };
  }
  // 中央脱敏已经把它归一化过时，保留它给出的具体 type，不要退化成通用 "Error"。
  if (isNormalizedError(error)) {
    return error;
  }
  return { type: "Error", message: safeErrorMessage };
};

/**
 * `child()` 的 bindings 走的是 pino 的 chindings 路径，**不经过**
 * `formatters.log`——它在建立子 logger 时就被序列化并缓存下来。因此这里覆盖
 * `child`，让 bindings 也过一遍同一个 canonicalizer，并且让返回的子 logger
 * 继续带着这个覆盖（否则孙 logger 又会漏掉）。
 */
const withRedactedChild = (logger: Logger): Logger => {
  // pino 的 `child` 是泛型重载，直接 as 会因为 custom-levels 类型参数不兼容而
  // 报错；这里只需要「bindings 进、Logger 出」这一层契约。
  const createChild = logger.child.bind(logger) as unknown as (
    bindings: Record<string, unknown>,
    options?: unknown,
  ) => Logger;
  Object.defineProperty(logger, "child", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: (bindings: Record<string, unknown>, options?: unknown): Logger =>
      withRedactedChild(createChild(redactLogObject(bindings ?? {}), options)),
  });
  return logger;
};

/**
 * 阶段 09A / M3A：脱敏落在**中央 logger 边界**，不再依赖每个调用方主动调用
 * `redactSensitive`。四层各管一段，缺一不可：
 *
 *   - `hooks.logMethod`：在 pino 做 printf 插值**之前**处理全部参数，因此
 *     `%s` 的字符串、`%j` / `%o` 的对象都已经安全；
 *   - `formatters.log`：处理合并对象里任意嵌套层级的结构化字段；
 *   - `child()` 覆盖：处理子 logger 的 bindings；
 *   - `redact.paths`：作用在最终对象上的第四层，与前三层独立。
 */
export const createLogger = (
  level: string,
  stream?: Writable,
): Logger =>
  withRedactedChild(
    pino(
      {
        level,
        base: null,
        formatters: {
          log: redactLogObject,
        },
        hooks: {
          logMethod(
            this: Logger,
            args: Parameters<LogFn>,
            method: LogFn,
          ): void {
            const safe = (args as readonly unknown[]).map(
              (argument, index) => {
                if (typeof argument === "string") {
                  return redactText(argument);
                }
                // 第一个参数如果是 Error，交给 err serializer——它给出的形状比
                // 通用 canonicalizer 更有信息量（保留具体 type）。
                if (index === 0 && argument instanceof Error) {
                  return argument;
                }
                return redactSensitive(argument);
              },
            ) as Parameters<LogFn>;
            method.apply(this, safe);
          },
        },
        serializers: {
          req: (request: {
            id?: string;
            method?: string;
            url?: string;
            remoteAddress?: string;
          }) => {
            const path = request.url?.split("?")[0];
            return {
              requestId: request.id,
              method: request.method,
              // 请求目标是调用方完全可控的文本，因此它也要过一遍取值脱敏。
              path: path === undefined ? undefined : redactText(path),
              remoteAddress: request.remoteAddress,
            };
          },
          res: (response: { statusCode?: number }) => ({
            statusCode: response.statusCode,
          }),
          err: safeError,
        },
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers.set-cookie",
            "*.authorization",
            "*.loginCode",
            "*.inviteCode",
            "*.accessToken",
            "*.providerSubject",
            "*.providerUnionSubject",
            "*.wechatAppSecret",
            "*.dietaryConstraints",
          ],
          censor: "[Redacted]",
        },
      },
      stream,
    ),
  );
