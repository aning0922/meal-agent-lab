import { z } from "zod";

import { AppError } from "../errors.js";
import type { WechatAdapter, WechatIdentity } from "./adapter.js";
import {
  isOfficialWechatCode2SessionUrl,
  officialWechatCode2SessionUrlMessage,
} from "./endpoint.js";

export type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

const realWechatConfigSchema = z.strictObject({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  // 与 config.ts 同一个判据，在 adapter 边界再执行一次：AppID/AppSecret 会作为
  // query 参数发到这个地址，因此「送去哪台服务器」不能只由上游配置层保证。
  endpoint: z.string().refine(isOfficialWechatCode2SessionUrl, {
    message: officialWechatCode2SessionUrlMessage,
  }),
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

// code2Session may include errcode 0 ("ok") in success bodies; only a
// non-zero errcode is a provider rejection. 40029 (invalid js_code),
// 40163 (js_code already used) and 40226 (high-risk user blocked) are
// rejections of the caller — authentication failures, not provider
// outages. -1 ("system busy") and 45011 (per-minute quota) are transient.
const callerRejectionErrcodes: ReadonlySet<number> = new Set([
  40_029, 40_163, 40_226,
]);
const transientErrcodes: ReadonlySet<number> = new Set([-1, 45_011]);

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
    if (providerError.success && providerError.data.errcode !== 0) {
      if (callerRejectionErrcodes.has(providerError.data.errcode)) {
        throw new AppError(
          "AUTHENTICATION_REQUIRED",
          "WeChat rejected the login",
          { retryable: false },
        );
      }
      throw new AppError(
        "EXTERNAL_DEPENDENCY_UNAVAILABLE",
        "WeChat rejected the login exchange",
        { retryable: transientErrcodes.has(providerError.data.errcode) },
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
