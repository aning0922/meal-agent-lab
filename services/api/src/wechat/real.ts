import { z } from "zod";

import { AppError } from "../errors.js";
import type { WechatAdapter, WechatIdentity } from "./adapter.js";

export type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

const realWechatConfigSchema = z.strictObject({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  endpoint: z.url().refine(
    (value) => new URL(value).protocol === "https:",
    { message: "WeChat code2Session endpoint must use HTTPS" },
  ),
});
type RealWechatConfig = z.infer<typeof realWechatConfigSchema>;

const successResponseSchema = z.object({
  openid: z.string().min(1),
  unionid: z.string().min(1).optional(),
  session_key: z.string().min(1),
});

const errorResponseSchema = z.object({
  errcode: z.number(),
  errmsg: z.string().optional(),
});

export class RealWechatAdapter implements WechatAdapter {
  readonly #config: RealWechatConfig;
  readonly #fetch: FetchLike;

  public constructor(
    config: RealWechatConfig,
    fetchImplementation: FetchLike = fetch,
  ) {
    this.#config = realWechatConfigSchema.parse(config);
    this.#fetch = fetchImplementation;
  }

  public async exchange(loginCode: string): Promise<WechatIdentity> {
    const url = new URL(this.#config.endpoint);
    url.searchParams.set("appid", this.#config.appId);
    url.searchParams.set("secret", this.#config.appSecret);
    url.searchParams.set("js_code", loginCode);
    url.searchParams.set("grant_type", "authorization_code");

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new AppError(
        "EXTERNAL_DEPENDENCY_UNAVAILABLE",
        "WeChat identity service is unavailable",
        { retryable: true },
      );
    }

    if (!response.ok) {
      throw new AppError(
        "EXTERNAL_DEPENDENCY_UNAVAILABLE",
        "WeChat identity service is unavailable",
        { retryable: response.status >= 500 },
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AppError(
        "EXTERNAL_DEPENDENCY_UNAVAILABLE",
        "WeChat returned an invalid identity response",
        { retryable: true },
      );
    }
    const providerError = errorResponseSchema.safeParse(body);
    if (providerError.success) {
      throw new AppError(
        "EXTERNAL_DEPENDENCY_UNAVAILABLE",
        "WeChat rejected the login exchange",
        { retryable: false },
      );
    }

    const providerIdentity = successResponseSchema.safeParse(body);
    if (!providerIdentity.success) {
      throw new AppError(
        "EXTERNAL_DEPENDENCY_UNAVAILABLE",
        "WeChat returned an invalid identity response",
        { retryable: true },
      );
    }

    return {
      providerTenantKey: this.#config.appId,
      providerSubject: providerIdentity.data.openid,
      ...(providerIdentity.data.unionid === undefined
        ? {}
        : { providerUnionSubject: providerIdentity.data.unionid }),
    };
  }
}
