# `@meal-agent/client`

正式 Taro 4.2.1 + React 18.3.1 客户端，当前目标为微信小程序。页面只编排状态与视图，HTTP/契约映射、幂等动作和平台能力分别位于 core 与 adapter；核心 DTO 全部来自 `@meal-agent/contracts` `0.4.0`。

## 阶段 08 页面能力

- HouseholdsPage：fake 登录后的家庭列表、创建、邀请码加入；新建 owner profile 的饭量、默认参与和厨艺保持 unknown/null；
- MembersPage：成员目录、owner/self 标识、邀请、退出/移除、active/archived dining-only profile 管理；
- ProfilePage：linked/dining-only profile 查看编辑、archive/restore、全部现有 hard constraint kind、待权威映射的 allergen/food concept 标识、双确认与阻断状态；
- InventoryPage：批次新增和 exact-only 最小消耗。

FAM-003 已覆盖。FAM-004 的页面登记、确认与隐私范围已覆盖，但权威映射词表和推荐安全闭环尚未完成，因此仍为部分完成。FAM-005 当前支持已有 cooking skill 的 unknown/查看/编辑，正式 cooking-technique 词表尚未建立。

## 关键语义

- PersonProfile/constraint mutation 只接收 receipt，成功或重放后 GET 最新资源；
- Households create/join、Inventory、Members 与 Profile 共用 app 级 pending-command 协调器；transport、5xx 或 malformed success 后保留完整不可变 command snapshot + 原 idempotency key 并冻结输入，刷新后的 lot/profile 不得用于重建重试；确定 400/403/404/409 才释放；
- 任一 pending 存在时只允许对应原动作重试，其他写入口和离页全部禁用；普通 GET 只能记录绑定 action/key 的观察，不能开放“已完成”或“未执行并放弃”，GET 失败不产生证据；
- pending 只跨页面保存在当前应用进程内，不在本地持久化邀请码、敏感约束请求体或 token。进程重启后的安全恢复尚未实现；未来只能使用非敏感 command locator + 服务端 command-status/receipt 或原子 fence，普通 GET 不能代替；
- link 确认使用发起时保存的安全名称、约束计数和后果披露；历史 `legacy_unavailable` 请求不可确认，profile 变化 409 表示旧请求已终态，必须由 owner 重新发起后再 GET、展示和确认；
- owner/self 依据当前 session user 判断，不根据 viewer role 猜测；
- `subject_and_owner` 只在 owner/self 完整视图出现；
- 未经权威映射的 hard constraint 一律为 `needs_structured_mapping` 并显示阻断状态，不能交给模型猜测；
- 页面源码不直接调用 `wx.*`，微信能力由 platform adapter 隔离。

## 命令

```bash
pnpm --filter @meal-agent/client typecheck
pnpm --filter @meal-agent/client test
pnpm --filter @meal-agent/client build:weapp
pnpm --filter @meal-agent/client test:e2e
```

单测会实际渲染 HouseholdsPage、InventoryPage、MembersPage 和 ProfilePage，并覆盖 unknown 默认、owner/self、五类 hard kind、confirmation fingerprint、安全关联披露、不可恢复原因、草稿隔离、archive/restore、跨动作/离页阻断、GET 观察和原快照同 key 重试。E2E 使用本机 fake adapter 与临时 PostgreSQL，不是实时微信链。

本地联调：

```bash
MEAL_AGENT_DEV_API_PORT=3000 pnpm --filter @meal-agent/client dev:stack
pnpm --filter @meal-agent/client build:weapp
```

开发者工具导入 `apps/client/dist`。仓库 `project.config.json` 固定为 `touristappid`；真实 AppID/AppSecret 只能存在本机 gitignored 配置或密钥服务。完整走查证据见[阶段 08 GUI 记录](../../docs/evidence/stage-08-gui/README.md)。

依赖例外仅允许本地 weapp 构建；截至例外关闭前，H5、外部测试、体验版与发布全部阻断。真实登录、合法域名、真机和发布仍为 Deferred。
