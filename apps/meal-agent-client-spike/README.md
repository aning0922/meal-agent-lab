# Meal Agent 客户端技术实验

这是阶段 04 用于 ADR-0001 的一次性 Taro 技术实验，不是正式客户端工程，也不实现家庭、库存、推荐或 Agent 业务。

## 验证范围

- “今天”和“库存”两个页面壳及 Tab 导航；
- 先定义 `AuthPort`、`StoragePort`、`NetworkPort`，页面不直接调用平台 API；
- 通过平台适配层完成 Mock 登录、本地状态和模拟 HTTP API；
- 统一使用 `Pass`、`Fail`、`Deferred — 外部依赖`、`Not applicable`；
- 构建并在微信开发者工具模拟器运行；
- 为微信测试号和真机预览生成独立本地目录，不把测试 AppID 提交到仓库。

本轮不以正式主体、正式 AppID、真实登录闭环、正式合法域名、体验版上传、审核或发布为验收条件。

## 固定版本

- Node.js 24.14.0；`package.json` 允许 22.13.0 至 24.x；
- pnpm 11.9.0；
- Taro 4.2.1、React 18.3.1、TypeScript 5.9.3；
- 微信开发者工具 Stable 2.01.2510290 完成了本次模拟器人工预览。

依赖使用精确版本和锁文件。`pnpm-workspace.yaml` 中的 `allowBuilds` 是 pnpm 安装脚本的最小白名单；新增带安装脚本的依赖时必须单独审查，不要扩大为通配规则。

## 安装与检查

先保证 `node --version` 和 `pnpm --version` 符合上述范围，然后运行：

```bash
cd apps/meal-agent-client-spike
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 依次执行 TypeScript 静态检查、适配层测试和微信小程序生产构建。输出目录为 `dist/`，不会提交到仓库。

## 模拟器运行

1. 运行 `pnpm build:weapp`。
2. 打开微信开发者工具，导入本目录；`project.config.json` 已把小程序根目录指向 `dist/`。
3. 没有测试号时可用游客模式。游客模式只适合模拟器验证，不能作为真机预览证据。
4. 如需验证模拟 API，另开终端运行 `pnpm mock:api`，然后在“今天”页点击“调用模拟 API”。
5. 点击“Mock 登录”，验证 Mock 会话写入、恢复和退出。该操作不会调用 `wx.login`。
6. 当前实验默认使用 `http://127.0.0.1:8787` 并关闭开发阶段域名校验，不能沿用到正式工程。

可选的 `pnpm preview:weapp` 会尝试用命令行打开项目。它要求先在微信开发者工具的“设置 → 安全”中启用服务端口；该端口不是构建或手工导入所必需，本次验证没有为了自动化而打开它。

开发时可用 `pnpm dev:weapp` 持续构建。模拟 API 默认只监听回环地址，不接收外部网络连接，也不保存请求数据。

## 微信测试号与真机预览

准备一个微信测试号 AppID，不需要正式主体或正式 AppID。AppID 只通过本机环境变量传入：

```bash
WECHAT_TEST_APP_ID=wx0000000000000000 pnpm prepare:test-account
```

命令会重新构建，并生成被 Git 忽略的 `.wechat-test-preview/`。在微信开发者工具中导入该目录后使用“预览”二维码进行真机检查。

如需让同一局域网内的手机访问本机 Mock API，需要显式开放监听并把构建地址改为 Mac 的局域网地址：

```bash
MEAL_AGENT_MOCK_API_HOST=0.0.0.0 pnpm mock:api
WECHAT_TEST_APP_ID=wx0000000000000000 \
MEAL_AGENT_MOCK_API_BASE_URL=http://192.168.x.x:8787 \
pnpm prepare:test-account
```

`0.0.0.0` 会把无鉴权的 Mock 服务暴露给当前网络，只能在可信局域网临时使用，验证后立即停止。测试号、手机、同网访问或扫码条件不具备时，真机预览必须记录为 `Deferred — 外部依赖`，不能记录为 `Pass`。

## 代码边界

```text
页面壳
  └─ PlatformAdapter
      ├─ navigation
      ├─ AuthPort（阶段 04：Mock）
      ├─ StoragePort
      ├─ NetworkPort（阶段 04：Mock API）
      └─ capability registry
           └─ Taro Runtime（当前仅微信小程序）
```

页面不能直接调用 `wx.*`。未来 Android、iOS 和 HarmonyOS 的运行时实现应保持同一端口语义，但页面和原生能力是否复用，必须分别经过后续 spike，不能由本实验推定。

## 已知限制

- `project.config.json` 使用 `touristappid`，不含真实账号、密钥或不可共享的本机配置；
- `project.private.config.json`、`.wechat-test-preview/`、构建结果、依赖和编译缓存均被忽略；
- Mock 登录为 `Pass`；真实微信登录和分享为 `Deferred — 外部依赖`；
- 相机、语音、条码、OCR 和外部通知不在阶段 04 范围，记为 `Not applicable`；
- 正式合法域名延后到 06 最小服务端，体验版上传延后到家庭内测前，审核和发布链延后到发布候选阶段；
- 真机预览只有实际使用测试号扫码运行后才能标记 `Pass`；
- 没有验证离线队列、深链、签名、商店构建或 CI 凭据；
- 该目录在正式客户端骨架建立后可以整体删除，不应迁移任何演示文案或临时业务状态。
