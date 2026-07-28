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
 * libpq 的 key/value conninfo（`host=… password=…`）不是 URL，单独覆盖一次。
 */
const connectionStringPattern = /postgres(?:ql)?:\/\/\S*/gi;
const conninfoPasswordPattern = /\bpass(?:word|file)\s*=\s*\S+/gi;

export const redactText = (value: string): string =>
  value
    .replace(connectionStringPattern, "[Redacted]")
    .replace(conninfoPasswordPattern, "password=[Redacted]");

/** Error 归一化后的固定 message：内部细节永远不进入日志。 */
export const safeErrorMessage = "request failed";

export const redactSensitive = (
  value: unknown,
  seen = new WeakSet<object>(),
): unknown => {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }

  // Error 的 message / stack 是不可枚举属性，`Object.entries` 看不到它们，因此
  // 「按属性递归」会把一条含连接串的错误静默变成 `{}`，既不脱敏也不留信息。
  // 这里显式归一化成与 err serializer 完全相同的安全形状。
  if (value instanceof Error) {
    return { type: value.name, message: safeErrorMessage };
  }

  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveKey(key) ? "[Redacted]" : redactSensitive(entry, seen),
      ]),
    );
  }

  return value;
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
      return [key, isSensitiveKey(key) ? "[Redacted]" : redactSensitive(value, seen)];
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
 * 阶段 09A / M3A：脱敏落在**中央 logger 边界**，不再依赖每个调用方主动调用
 * `redactSensitive`。
 *
 * 两个 hook 分工明确，缺一不可：
 *   - `formatters.log` 处理结构化字段（任意嵌套层级的对象与数组）；
 *   - `hooks.logMethod` 处理**消息串本身**——`logger.info({}, `连接 ${url}`)`
 *     的 message 不会经过 `formatters.log`。
 * 保留原有的 `redact.paths` 作为第三层：它作用在最终对象上，与前两层独立。
 */
export const createLogger = (
  level: string,
  stream?: Writable,
): Logger =>
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
          const safe = (args as readonly unknown[]).map((argument) =>
            typeof argument === "string" ? redactText(argument) : argument,
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
        }) => ({
          requestId: request.id,
          method: request.method,
          path: request.url?.split("?")[0],
          remoteAddress: request.remoteAddress,
        }),
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
  );
