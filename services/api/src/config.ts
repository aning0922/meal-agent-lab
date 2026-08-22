import { z } from "zod";

import { resolveDatabaseUrlSource, type SecretOrigin } from "./config-source.js";
import {
  isOfficialWechatCode2SessionUrl,
  officialWechatCode2SessionUrl,
  officialWechatCode2SessionUrlMessage,
} from "./wechat/endpoint.js";

const integerFromEnvironment = (fallback: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : Number(value)),
    z.int().positive(),
  );

/**
 * 环境文件惯例是「保留空值示例」（见 `.env.example`），因此空字符串必须等价于
 * 「没有设置」。否则 `WECHAT_APP_ID=` 会以一条与事实无关的长度错误失败，而
 * local-test「不得携带真实凭据」这条真正的判据反而永远走不到。
 */
const optionalFromEnvironment = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const code2SessionUrlSchema = z
  .preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .refine(isOfficialWechatCode2SessionUrl, {
        message: officialWechatCode2SessionUrlMessage,
      })
      .default(officialWechatCode2SessionUrl),
  );

/**
 * 部署阶段与暴露级别是**两个互相独立的维度**，都没有默认值。
 *
 * 没有默认值是刻意的：一个「猜出来的」部署身份正是 fake 登录最危险的失败方式。
 * 两者也不由 `NODE_ENV` 推导——`NODE_ENV` 描述的是 Node 运行模式，回答不了
 * 「这台机器被谁访问得到」。三条防线各自独立，任何一条都不能覆盖另一条。
 */
const deploymentStages = ["local-test", "staging", "production"] as const;
const deploymentExposures = ["loopback", "private-network", "public"] as const;

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DEPLOYMENT_STAGE: z.enum(deploymentStages),
    DEPLOYMENT_EXPOSURE: z.enum(deploymentExposures),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: integerFromEnvironment(3000).pipe(z.int().max(65_535)),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    // 取值由 config-source.ts 在 schema 之外解析（DATABASE_URL / DATABASE_URL_FILE
    // 互斥），这里只校验解析结果的格式。
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
    // Fail closed: the fake adapter mints sessions for any caller, so the
    // adapter choice must always be an explicit deployment decision.
    WECHAT_ADAPTER: z.enum(["fake", "real"]),
    WECHAT_APP_ID: optionalFromEnvironment,
    WECHAT_APP_SECRET: optionalFromEnvironment,
    WECHAT_CODE2SESSION_URL: code2SessionUrlSchema,
    SESSION_ABSOLUTE_TTL_DAYS: integerFromEnvironment(30).pipe(
      z.int().max(90),
    ),
    SESSION_IDLE_TTL_DAYS: integerFromEnvironment(7).pipe(z.int().max(30)),
  })
  .superRefine((config, context) => {
    if (
      config.NODE_ENV === "production" &&
      config.WECHAT_ADAPTER !== "real"
    ) {
      context.addIssue({
        code: "custom",
        path: ["WECHAT_ADAPTER"],
        message: "production requires the real WeChat adapter",
      });
    }

    // fake adapter 为任意调用者签发内部身份，因此它只允许出现在**同时**满足
    // 三条独立判据的部署里。任何一条不满足都必须在启动前失败。
    if (config.WECHAT_ADAPTER === "fake") {
      if (config.DEPLOYMENT_STAGE !== "local-test") {
        context.addIssue({
          code: "custom",
          path: ["WECHAT_ADAPTER"],
          message:
            `the fake WeChat adapter is only allowed at DEPLOYMENT_STAGE ` +
            `local-test, not ${config.DEPLOYMENT_STAGE}`,
        });
      }
      if (config.DEPLOYMENT_EXPOSURE !== "loopback") {
        context.addIssue({
          code: "custom",
          path: ["WECHAT_ADAPTER"],
          message:
            `the fake WeChat adapter is only allowed at DEPLOYMENT_EXPOSURE ` +
            `loopback, not ${config.DEPLOYMENT_EXPOSURE}`,
        });
      }
      if (config.NODE_ENV === "production") {
        context.addIssue({
          code: "custom",
          path: ["WECHAT_ADAPTER"],
          message: "the fake WeChat adapter is not allowed in production",
        });
      }
    }

    // local-test 不得携带真实凭据：把 AppID/AppSecret 放进一个使用合成身份的
    // 部署没有任何用途，只会让真实 Secret 出现在最不该出现的地方。
    if (config.DEPLOYMENT_STAGE === "local-test") {
      if (config.WECHAT_APP_ID !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["WECHAT_APP_ID"],
          message: "local-test must not carry a WeChat AppID",
        });
      }
      if (config.WECHAT_APP_SECRET !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["WECHAT_APP_SECRET"],
          message: "local-test must not carry a WeChat AppSecret",
        });
      }
    }

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

export type DeploymentStage = (typeof deploymentStages)[number];
export type DeploymentExposure = (typeof deploymentExposures)[number];

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly deploymentStage: DeploymentStage;
  readonly deploymentExposure: DeploymentExposure;
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
  /** 连接串实际来自哪一个来源。它同时是「没有发生来源回落」的证据。 */
  readonly databaseUrlOrigin: SecretOrigin;
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
  // 顺序是显式的：先解析 Secret 来源（互斥判定 + 文件安全判据），再做配置校验。
  // 反过来会让「文件权限不对」与「连接串格式不对」在同一个 ZodError 里混在一起。
  const databaseUrl = resolveDatabaseUrlSource(environment);
  const parsed = configSchema.parse({
    ...environment,
    DATABASE_URL: databaseUrl.value,
  });

  return {
    nodeEnv: parsed.NODE_ENV,
    deploymentStage: parsed.DEPLOYMENT_STAGE,
    deploymentExposure: parsed.DEPLOYMENT_EXPOSURE,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    databaseUrlOrigin: databaseUrl.origin,
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
