/**
 * 阶段 09A / M3A：真实 code2Session endpoint 的唯一允许值。
 *
 * 真实 adapter 会把 AppID 与 AppSecret 作为 query 参数发出去，因此 endpoint
 * 决定了这两个 Secret 被送到**哪台服务器**。它不是一个普通的可配置 URL，而是
 * 一个信任边界，所以这里只接受**逐字节相同**的官方地址。
 *
 * 用逐字节比较而不是「解析后逐字段判断」是刻意的：`new URL()` 会规范化端口、
 * 大小写、百分号编码与相对路径，于是任何基于解析结果的宽松判断都要额外证明
 * 「规范化没有把一个不同的目标变成看起来相同的目标」。逐字节相等不需要这个
 * 证明，而且下列全部形态都因此被拒绝：
 *
 *   - 明文 HTTP；
 *   - 相似域名与子域名（`api.weixin.qq.com.evil.example`、`a.api.weixin.qq.com`）；
 *   - 另一个 endpoint（`/sns/userinfo`）；
 *   - 显式端口（含 `:443`）；
 *   - 不同 path、尾斜杠；
 *   - query、fragment 与 userinfo（`https://user:pass@…`）。
 *
 * 阶段 09A 不接入真实 AppID/AppSecret；本模块是接入之前就必须先立起来的边界。
 */
export const officialWechatCode2SessionUrl =
  "https://api.weixin.qq.com/sns/jscode2session";

export const isOfficialWechatCode2SessionUrl = (
  value: unknown,
): value is string => value === officialWechatCode2SessionUrl;

export const officialWechatCode2SessionUrlMessage =
  `WeChat code2Session endpoint must be exactly ${officialWechatCode2SessionUrl}`;
