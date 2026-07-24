# @meal-agent/client

阶段 07 正式微信小程序客户端纵切（Taro 4.2.1 + React 18.3.1 + TypeScript 5.9.3，见 [ADR-0001](../../docs/architecture/decisions/0001-client-platform-and-cross-platform-framework.md)）。覆盖第一条端到端真实闭环：

```text
登录（后端 fake 微信适配器）→ 创建/选择家庭 → 库存批次列表
    → 手工新增批次（exact/approximate/qualitative）→ exact-only 消耗
    （幂等重放、版本冲突刷新、401 重新登录引导、跨家庭 404）
```

## 结构与边界

| 目录 | 职责 |
| --- | --- |
| `src/platform/` | 平台端口定义与唯一的 Taro/wx 触点（`taro-adapter.ts`） |
| `src/core/` | 业务流程（登录、家庭、库存）、API 客户端与会话存储；不依赖 Taro，可在 Node 直接测试 |
| `src/pages/` | 薄 UI 层；只依赖 `@tarojs/components`、React 与 `core`/`app-runtime`，禁止直接调用 `wx.*`/Taro API |
| `tests/unit/` | Node 单元测试（fake 平台适配器脚本化应答） |
| `tests/e2e/` | 端到端闭环：临时 PostgreSQL 18 + 真实 `services/api`（fake 微信适配器） |

所有 DTO 一律来自 [`@meal-agent/contracts`](../../packages/contracts/)：请求经契约模式本地预校验，响应（含 `application/problem+json`）经契约模式验证后才交给页面，客户端不定义第二份核心 DTO。

## 关键语义

- **幂等**：每个逻辑写操作生成一次 `Idempotency-Key`（`c07-` 前缀），失败重试复用同一键；表单内容修改后换新键；`meta.idempotency.replayed === true` 时页面明示“重复提交返回第一次结果”。
- **并发冲突**：consumed 携带 `expectedVersion`；收到 `INVENTORY_VERSION_CONFLICT` 时刷新批次列表并提示基于最新版本重试，绝不静默覆盖。
- **会话**：`AuthenticatedSession` 持久化在小程序存储，恢复时经契约校验并按 `expiresAt` 预判；服务端 401（`AUTHENTICATION_REQUIRED`/`SESSION_EXPIRED`）统一清会话、跳登录页并展示原因。
- **404 语义**：跨家庭资源访问返回 404 时按“不可访问”处理，不推断资源是否存在。
- **数量三态**：exact 金额始终是十进制字符串；approximate 保留数值/单位/置信度/原始描述；qualitative 只保留等级与原始描述——展示层不把估算量伪装成精确量。

## 常用命令

```bash
pnpm --filter @meal-agent/client check        # typecheck + 单元测试 + weapp 生产构建
pnpm --filter @meal-agent/client test:e2e     # 端到端闭环（需 PostgreSQL 18，PG_BIN 可指定）
pnpm --filter @meal-agent/client dev:stack    # 本地联调栈：临时 PG18 + services/api(fake)
pnpm --filter @meal-agent/client dev:weapp    # Taro watch 构建
```

## 微信开发者工具手工验证

1. `MEAL_AGENT_DEV_API_PORT=3000 pnpm --filter @meal-agent/client dev:stack`
2. `pnpm --filter @meal-agent/client build:weapp`（构建默认 API 基址 `http://127.0.0.1:3000`，可用 `MEAL_AGENT_API_BASE_URL` 覆盖）
3. 用微信开发者工具打开 `apps/client`（`project.config.json` 已关闭 urlCheck，tourist appid）。
4. 依次验证：登录 → 创建家庭 → 新增三种数量批次 → 消耗 → 重复点击（应显示重放而非重复扣减）→ 双开模拟并发消耗（应提示版本冲突并刷新）。

注意：开发者工具 CLI/自动化需要在 IDE“设置 → 安全设置”中开启服务端口，属于本机安全设置，由使用者自行决定。真机、真实微信登录与合法域名仍为 `Deferred — 外部依赖`；fake 适配器的通过结果不得记为真实微信链路 Pass。
