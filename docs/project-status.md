# 项目状态

更新时间：2026-07-23

## 当前阶段

阶段 05“后端架构与共享契约定稿”已完成。后端正式基线为 Node.js 24 LTS + Fastify 5 模块化单体、PostgreSQL 18 + Drizzle/`pg`；身份、家庭租户、API、鉴权、RLS、幂等、错误和版本策略已经由 [ADR-0002](architecture/decisions/0002-backend-runtime-framework-and-persistence.md) 与 [ADR-0003](architecture/decisions/0003-identity-tenancy-and-api-semantics.md) 接受。

[`@meal-agent/contracts`](../packages/contracts/) 0.1.0 已成为客户端、未来服务端和测试的共享契约事实源。当前仍没有完整业务服务或正式 App；下一阶段是严格受限的阶段 06 最小服务端纵切。

阶段 04 的微信测试号真机预览、真实登录、合法域名、邀请分享、体验版/审核/发布、离线队列和三个原生平台仍保持 `Deferred — 外部依赖`；相机、语音、条码、OCR 和外部通知保持原阶段 `Not applicable`。本阶段没有把任何 Deferred 项写为 Pass。

## 已形成的共识

- 产品定位为家庭餐食决策与厨房库存系统，Agent 是入口而不是唯一界面。
- 首要风险是库存维护成本，而不是模型生成能力。
- 库存必须按批次和追加事件管理；当前数量是可重建投影。
- 过敏、日期、权限、食品安全和库存一致性使用确定性校验。
- 微信小程序作为首发目标，正式客户端采用 Taro 4.2.1 + React 18.3.1 + TypeScript 5.9.3。
- 后端从 Node.js/Fastify 模块化单体开始，不提前拆微服务。
- PostgreSQL 18 是唯一事务事实库，不引入向量数据库、Redis 或第二事实库。
- 微信 `openid` 映射到 `AuthIdentity`，不能作为内部 `User.id`。
- `User`、`Session`、`Membership` 和 `PersonProfile` 生命周期分离；无登录档案不需要 User。
- 家庭隔离同时依赖应用授权、复合外键、RLS 和敏感字段 redaction。
- 写 command 使用幂等 key，库存并发使用 expected version；纠错追加事件。
- 客户端与服务端共享 `packages/contracts`，不重复定义核心 DTO。
- 一级入口采用“今天、库存、采购、我的”，Agent 作为上下文入口而非独立 Tab。
- P0 采用手动搜索、最近项、常用模板和文本录入；语音、条码及 OCR 放入 P1。
- 菜单采用“建议数量 + 预选组合 + 可选菜增减”，支持单道主食或 1–3 道菜。
- 完成状态与库存扣减同页渐进披露，最终确认前不写库存。

## 阶段 05 完成

### 架构与 ADR

- 比较 Node.js、Go、Bun/Deno，选择 Node.js 24 LTS + TypeScript。
- 比较 Fastify、NestJS、Hono 和 Express，选择 Fastify 5。
- 比较 PostgreSQL、MySQL、SQLite 和文档数据库，选择 PostgreSQL 18。
- 比较 Drizzle、Prisma、Kysely/原生 SQL 和 Active Record，选择 Drizzle + `pg`，使用可审查 SQL migration。
- 确定 P0 只有 `services/api` 一个部署单元；Agent 编排先是内部模块，worker 按 P1 真实需求启用。
- 确定 local、test、staging、production 的数据库、Secret、微信配置、域名和数据强隔离。

### 身份、安全与 API

- 确定 `AuthIdentity → User → Session/Membership → PersonProfile` 映射。
- 选择高熵 opaque bearer session，数据库只存 digest；不使用 JWT 固化家庭权限。
- Household 路由显式带 household ID；跨家庭资源返回 404，家庭内权限不足返回 403。
- 定义 REST `/api/v1`、成功 envelope、RFC 9457 风格错误、stable error code、cursor pagination 和版本策略。
- 定义幂等作用域、request hash、结果重放、key/body 冲突和 30 天通用记录保留。
- 定义 InventoryEvent 追加、numeric/qualitative quantity change、乐观版本和负库存阻断。

### 共享契约

- 覆盖 User、AuthIdentity、Session、Household、Membership、PersonProfile 和 DietaryConstraint。
- 覆盖 InventoryLot、InventoryEvent、日期来源、置信度、数量与创建批次请求/结果。
- 覆盖 Meal、Recipe、Recommendation 和必须通过 hard constraint check 的候选。
- 覆盖 ShoppingItem 的待购买、已买待入库、已入库和取消状态。
- 覆盖 ApiResult、ApiError、Pagination、Idempotency 和 ExpectedVersion。
- schema 默认 strict；ID 使用 nominal brand；类型全部从 Zod schema 推导。
- 类型检查、8 个运行时测试和 declaration/JavaScript 构建通过。

## 当前验证状态

### Pass

- 阶段 04 已有的小程序构建、开发者工具模拟器、Mock 登录/存储/网络与适配层测试；
- 阶段 05 `packages/contracts` 的类型检查、运行时测试和构建。

### 待验证

- Node.js 24 + Fastify 5 + Drizzle + PostgreSQL 18 的实际服务纵切；
- session 过期/撤销、RLS 连接上下文、复合外键和字段级 redaction；
- 幂等事务、并发相同 key、库存 version conflict 和负库存；
- contract → Fastify → OpenAPI 的单一事实源；
- staging/production 的具体云平台、备份恢复、migration 和可观测性。

### Deferred — 外部依赖

- 微信测试号真机扫码、真机存储和真机网络；
- 真实 `wx.login`/code2Session、AppID/AppSecret 和 HTTPS 合法域名；
- 邀请分享、体验版、审核、发布和 CI 上传凭据；
- Android、iOS、HarmonyOS 工具链、构建、实机、签名和发布；
- 生产云账号、域名、证书和托管数据库。

## 阶段 06 最小服务端纵切

只实施：

```text
登录 → 创建/读取家庭 → 手工新增一个库存批次
    → 相同幂等请求重放同一结果
```

阶段 06 必须建立 `services/api`、九张最小表、健康检查、微信 fake/real adapter 端口、session、家庭创建/列表和库存批次创建/列表，并验证两个用户/两个家庭隔离、RLS、幂等、并发、会话撤销与日志脱敏。

完整 endpoint、migration、测试门禁和明确非范围见[阶段 05 报告第 10 节](architecture/backend-architecture-and-contracts.md#10-阶段-06最小服务端纵切)。

阶段 06 不实现完整推荐、Agent 对话、OCR/通知、采购/做饭闭环、微服务、向量数据库、正式 App 或生产部署。真实微信条件不具备时继续标记 `Deferred — 外部依赖`，fake adapter 不能代替真实 Pass。
