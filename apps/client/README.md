# `@meal-agent/client`

正式 Taro 4 + React 19 客户端，当前目标为微信小程序。页面只编排状态与视图，HTTP/契约映射、幂等动作和平台能力分别位于 core 与 adapter；核心 DTO 全部来自 `@meal-agent/contracts` `0.4.0`。

## 阶段 08 页面能力

- HouseholdsPage：fake 登录后的家庭列表、创建、邀请码加入；新建 owner profile 的饭量、默认参与和厨艺保持 unknown/null；
- MembersPage：成员目录、owner/self 标识、邀请、退出/移除、active/archived dining-only profile 管理；
- ProfilePage：linked/dining-only profile 查看编辑、archive/restore、全部现有 hard constraint kind、结构化 allergen/food concept、双确认与 mapping status；
- InventoryPage：批次新增和 exact-only 最小消耗。

FAM-003、FAM-004 已覆盖。FAM-005 当前支持已有 cooking skill 的 unknown/查看/编辑；尚未发明 cooking-technique 正式词表，仍是部分完成并作为阶段 09 数据治理前置。

## 关键语义

- PersonProfile/constraint mutation 只接收 receipt，成功或重放后 GET 最新资源；
- 同一次进行中动作复用 idempotency key，payload/version 变化或明确取消后才换 key；
- 应用重启通过 GET 对账，不在本地持久化邀请码、敏感约束请求体或 token；
- owner/self 依据当前 session user 判断，不根据 viewer role 猜测；
- `subject_and_owner` 只在 owner/self 完整视图出现；
- `needs_structured_mapping` hard constraint 显示阻断状态，不能交给模型猜测；
- 页面源码不直接调用 `wx.*`，微信能力由 platform adapter 隔离。

## 命令

```bash
pnpm --filter @meal-agent/client typecheck
pnpm --filter @meal-agent/client test
pnpm --filter @meal-agent/client build:weapp
pnpm --filter @meal-agent/client test:e2e
```

单测会实际渲染 HouseholdsPage、MembersPage 和 ProfilePage，并覆盖 unknown 默认、owner/self、完整 hard kind、confirmation fingerprint、archive/restore 和同动作重试。E2E 使用本机 fake adapter 与临时 PostgreSQL，不是实时微信链。

本地联调：

```bash
MEAL_AGENT_DEV_API_PORT=3000 pnpm --filter @meal-agent/client dev:stack
pnpm --filter @meal-agent/client build:weapp
```

开发者工具导入 `apps/client/dist`。仓库 `project.config.json` 固定为 `touristappid`；真实 AppID/AppSecret 只能存在本机 gitignored 配置或密钥服务。完整走查证据见[阶段 08 GUI 记录](../../docs/evidence/stage-08-gui/README.md)。

依赖例外仅允许本地 weapp 构建；截至例外关闭前，H5、外部测试、体验版与发布全部阻断。真实登录、合法域名、真机和发布仍为 Deferred。
