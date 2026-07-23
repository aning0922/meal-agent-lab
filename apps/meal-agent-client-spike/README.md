# Meal Agent 客户端技术实验

这是用于 ADR-0001 的一次性 Taro 技术实验，不是正式客户端工程，也不实现家庭、库存、推荐或 Agent 业务。

## 验证范围

- “今天”和“库存”两个页面壳及 Tab 导航；
- 通过平台适配层读写本地状态；
- 调用运行在本机的模拟 HTTP API；
- 将登录、相机、分享和通知显式保留为未实现的平台边界；
- 构建并在微信开发者工具中预览微信小程序。

## 固定版本

- Node.js 24.14.0；`package.json` 允许 22.13.0 至 24.x；
- pnpm 11.9.0；
- Taro 4.2.1、React 18.3.1、TypeScript 5.9.3；
- 微信开发者工具 Stable 2.01.2510290 完成了本次人工预览。

依赖使用精确版本和锁文件。`pnpm-workspace.yaml` 中的 `allowBuilds` 是 pnpm 安装脚本的最小白名单；新增带安装脚本的依赖时必须单独审查，不要扩大为通配规则。

## 安装与检查

先保证 `node --version` 和 `pnpm --version` 符合上述范围，然后运行：

```bash
cd apps/meal-agent-client-spike
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 依次执行 TypeScript 静态检查、适配层测试和微信小程序生产构建。输出目录为 `dist/`，不会提交到仓库。

## 在微信开发者工具中运行

1. 运行 `pnpm build:weapp`。
2. 打开微信开发者工具，导入本目录；`project.config.json` 已把小程序根目录指向 `dist/`。
3. 没有真实 AppID 时可用游客模式。游客模式只适合本地验证，不能证明登录、上传、订阅消息、合法域名或真机行为。
4. 如需验证模拟 API，另开终端运行 `pnpm mock:api`，然后在“今天”页点击“调用模拟 API”。
5. 当前实验使用 `http://127.0.0.1:8787` 并关闭开发阶段的域名校验，不能沿用到正式工程。

可选的 `pnpm preview:weapp` 会尝试用命令行打开项目。它要求先在微信开发者工具的“设置 → 安全”中启用服务端口；该端口不是构建或手工导入所必需，本次验证没有为了自动化而打开它。

开发时可用 `pnpm dev:weapp` 持续构建。模拟 API 只监听回环地址，不接收外部网络连接，也不保存请求数据。

## 代码边界

```text
页面壳
  └─ PlatformAdapter
      ├─ navigation
      ├─ draft storage
      ├─ mock API
      └─ capability registry
           └─ Taro Runtime（当前仅微信小程序）
```

页面不能直接调用 `wx.*`。未来 Android、iOS 和 HarmonyOS 的运行时实现应保持同一端口语义，但页面和原生能力是否复用，必须分别经过后续 spike，不能由本实验推定。

## 已知限制

- `project.config.json` 使用 `touristappid`，不含真实账号、密钥或不可共享的本机配置；
- `project.private.config.json`、构建结果、依赖和编译缓存均被忽略；
- 登录、相机、分享和通知只定义了能力状态，没有调用；
- 没有验证真机、离线队列、深链、签名、上传、商店构建或 CI 凭据；
- 该目录在正式客户端骨架建立后可以整体删除，不应迁移任何演示文案或临时业务状态。
