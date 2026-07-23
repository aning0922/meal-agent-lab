import { z } from "zod";

const integerFromEnvironment = (fallback: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : Number(value)),
    z.int().positive(),
  );

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: integerFromEnvironment(3000).pipe(z.int().max(65_535)),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.startsWith("postgres://") ||
          value.startsWith("postgresql://"),
        { message: "DATABASE_URL must use PostgreSQL" },
      ),
    DATABASE_APP_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).default(
      "meal_agent_app",
    ),
    WECHAT_ADAPTER: z.enum(["fake", "real"]).default("fake"),
    WECHAT_APP_ID: z.string().min(1).optional(),
    WECHAT_APP_SECRET: z.string().min(1).optional(),
    WECHAT_CODE2SESSION_URL: z
      .url()
      .default("https://api.weixin.qq.com/sns/jscode2session"),
    SESSION_ABSOLUTE_TTL_DAYS: integerFromEnvironment(30).pipe(
      z.int().max(90),
    ),
    SESSION_IDLE_TTL_DAYS: integerFromEnvironment(7).pipe(z.int().max(30)),
  })
  .superRefine((config, context) => {
    if (config.WECHAT_ADAPTER === "real") {
      if (config.WECHAT_APP_ID === undefined) {
        context.addIssue({
          code: "custom",
          path: ["WECHAT_APP_ID"],
          message: "real WeChat adapter requires WECHAT_APP_ID",
        });
      }
      if (config.WECHAT_APP_SECRET === undefined) {
        context.addIssue({
          code: "custom",
          path: ["WECHAT_APP_SECRET"],
          message: "real WeChat adapter requires WECHAT_APP_SECRET",
        });
      }
    }

    if (
      config.SESSION_IDLE_TTL_DAYS >
      config.SESSION_ABSOLUTE_TTL_DAYS
    ) {
      context.addIssue({
        code: "custom",
        path: ["SESSION_IDLE_TTL_DAYS"],
        message: "session idle TTL cannot exceed absolute TTL",
      });
    }
  });

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel:
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace"
    | "silent";
  readonly databaseUrl: string;
  readonly databaseAppRole: string;
  readonly wechatAdapter: "fake" | "real";
  readonly wechatAppId?: string;
  readonly wechatAppSecret?: string;
  readonly wechatCode2SessionUrl: string;
  readonly sessionAbsoluteTtlDays: number;
  readonly sessionIdleTtlDays: number;
}

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig => {
  const parsed = configSchema.parse(environment);

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    databaseAppRole: parsed.DATABASE_APP_ROLE,
    wechatAdapter: parsed.WECHAT_ADAPTER,
    ...(parsed.WECHAT_APP_ID === undefined
      ? {}
      : { wechatAppId: parsed.WECHAT_APP_ID }),
    ...(parsed.WECHAT_APP_SECRET === undefined
      ? {}
      : { wechatAppSecret: parsed.WECHAT_APP_SECRET }),
    wechatCode2SessionUrl: parsed.WECHAT_CODE2SESSION_URL,
    sessionAbsoluteTtlDays: parsed.SESSION_ABSOLUTE_TTL_DAYS,
    sessionIdleTtlDays: parsed.SESSION_IDLE_TTL_DAYS,
  };
};
