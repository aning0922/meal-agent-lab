import type { AppConfig } from "../config.js";
import { FakeWechatAdapter } from "./fake.js";
import { RealWechatAdapter, type FetchLike } from "./real.js";

export interface WechatIdentity {
  readonly providerTenantKey: string;
  readonly providerSubject: string;
  readonly providerUnionSubject?: string;
}

export interface WechatAdapter {
  exchange(loginCode: string): Promise<WechatIdentity>;
}

export const createWechatAdapter = (
  config: AppConfig,
  fetchImplementation?: FetchLike,
): WechatAdapter => {
  if (config.wechatAdapter === "fake") {
    return new FakeWechatAdapter();
  }

  if (
    config.wechatAppId === undefined ||
    config.wechatAppSecret === undefined
  ) {
    throw new Error("real WeChat adapter is missing credentials");
  }

  return new RealWechatAdapter(
    {
      appId: config.wechatAppId,
      appSecret: config.wechatAppSecret,
      endpoint: config.wechatCode2SessionUrl,
    },
    fetchImplementation,
  );
};
