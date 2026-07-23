import { AppError } from "../errors.js";
import { sha256 } from "../utils.js";
import type { WechatAdapter, WechatIdentity } from "./adapter.js";

export class FakeWechatAdapter implements WechatAdapter {
  public async exchange(loginCode: string): Promise<WechatIdentity> {
    if (loginCode === "fake-dependency-unavailable") {
      throw new AppError(
        "EXTERNAL_DEPENDENCY_UNAVAILABLE",
        "WeChat identity service is unavailable",
        { retryable: true },
      );
    }

    return {
      providerTenantKey: "stage-06-fake-wechat-app",
      providerSubject: `fake_${sha256(loginCode).slice(0, 48)}`,
    };
  }
}
