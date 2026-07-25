import type { Writable } from "node:stream";

import pino, { type Logger } from "pino";

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
]);

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    sensitiveKeys.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("openid") ||
    normalized.endsWith("unionid")
  );
};

export const redactSensitive = (
  value: unknown,
  seen = new WeakSet<object>(),
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
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

const safeError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return { type: "Error", message: "request failed" };
  }
  return {
    type: error.name,
    message: "request failed",
  };
};

export const createLogger = (
  level: string,
  stream?: Writable,
): Logger =>
  pino(
    {
      level,
      base: null,
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
