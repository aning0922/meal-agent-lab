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
- `AuthenticatedUserContext` 与 `HouseholdContext` 分离；后者只能在事务内通过 active Membership bootstrap。
- 家庭隔离同时依赖应用授权、复合外键、RLS 和敏感字段 redaction。
- 创建家庭使用用户级幂等，家庭内 command 使用家庭级幂等；库存并发使用 expected version，纠错追加事件。
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
- 拆分已认证用户与家庭上下文，固定家庭创建、家庭列表和家庭资源三类 RLS bootstrap/事务顺序。
- Household 路由显式带 household ID；跨家庭资源返回 404，家庭内权限不足返回 403。
- 定义 REST `/api/v1`、成功 envelope、RFC 9457 风格错误、stable error code、cursor pagination 和版本策略。
- 定义用户级/家庭级幂等作用域、创建家庭重放、request hash、key/body 冲突和 30 天通用记录保留。
- 定义 InventoryEvent 追加、numeric/qualitative quantity change、乐观版本和负库存阻断。

### 共享契约

- 覆盖 User、AuthIdentity、Session、Household、Membership、PersonProfile、DietaryConstraint、安全 owner profile 响应和创建家庭关联结果。
- 覆盖 InventoryLot、InventoryEvent、日期来源、置信度、专用可持久化初始数量、创建批次和 exact-only 最小 consumed command 请求/结果。
- 覆盖 Meal、Recipe、Recommendation 和必须通过 hard constraint check 的候选。
- 覆盖 ShoppingItem 的待购买、已买待入库、已入库和取消状态。
- 覆盖 ApiResult、ApiError、Pagination、Idempotency 和 ExpectedVersion。
- schema 默认 strict；实体 ID 使用 UUIDv7 运行时校验和 nominal brand；API 泛型与类型全部从 Zod schema 推导。
- 类型检查、10 个运行时测试和 declaration/JavaScript 构建通过。

### 收尾验收

- ADR-0001/0002/0003、系统概览、领域模型、阶段 05 报告和共享 contract 已逐项核对；客户端边界、运行时、数据层、身份映射、家庭隔离、错误码/status、幂等作用域和库存事件规则一致。
- `apps/`、`services/` 和 `packages/` 中不存在第二份同名核心 DTO。低保真原型的局部采购展示类型已明确命名为 `PrototypeShoppingItem`；阶段 04 spike 只保留 `SpikeDraft`、`SpikeApiResult`、`MockAuthSession` 等一次性平台验证类型。`services/` 尚无正式业务实现。
- contract 额外固定 active/matching authenticated session、实体 UUIDv7、食品安全阻断原因、私密 owner constraint redaction、日期上限/类型唯一、正式初始数量结构、初始事件可重建批次数量、estimated/exact delta 判别、exact-only consumed、库存状态/数量、追加纠错、推荐预选、采购状态和 pageInfo 不变量，并增加反例断言。
- 根工作区 contracts 检查通过：TypeScript、10/10 运行时测试和 declaration/JavaScript 构建；阶段 04 客户端 spike 检查通过：TypeScript、5/5 测试和微信小程序构建；低保真原型通过 TypeScript、2/2 渲染测试、构建和 ESLint。
- 74/74 个本地 Markdown 链接可解析，18/18 个阶段 06 必需 contract export 可从构建产物加载，`git diff --check` 通过。
- 提交范围扫描未发现密钥签名、非空 Secret、真实邮箱/手机号或真实用户夹具；`.env.example` 只有空值/假适配器配置。依赖目录、构建目录、日志和 TypeScript 增量缓存均被忽略，没有生成物进入阶段 05 提交。

## 当前验证状态

### Pass

- 阶段 04 已有的小程序构建、开发者工具模拟器、Mock 登录/存储/网络与适配层测试；
- 阶段 05 `packages/contracts` 的类型检查、运行时测试和构建；
- 阶段 05 收尾的一致性、重复核心类型、提交范围、文档链接和静态检查。

### 依赖审计

- 正式 Stage 05 根工作区/contracts 的 `pnpm audit --prod` 为 0 个已知漏洞。
- 一次性阶段 04 Taro spike 的独立依赖树命中 12 个通告（1 critical、9 moderate、2 low），来自 Taro 4.2.1 固定的 swiper/esbuild/webpack/webpack-dev-server/uuid 范围。
- 低保真原型的独立依赖树命中 11 个通告（5 high、6 moderate），来自 Next/PostCSS/Sharp 范围。
- 两个应用都不是正式 App 或 Stage 05 运行时，不得部署或复用到正式工程。消除通告需要升级并重新验证对应实验技术栈，不能用跨不兼容版本的 override 伪装为已修复。

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
    → 追加一个 exact-only 最小 consumed 事件
```

阶段 06 必须建立 `services/api`、九张最小表、健康检查、微信 fake/real adapter 端口、session、家庭创建/列表、库存批次创建/列表和 exact-only 单批次 consumed command，并验证两层 context、三类 RLS bootstrap、用户级/家庭级幂等、两个用户/两个家庭隔离、estimated 请求拒绝、负库存、并发、会话撤销与日志脱敏。

完整 endpoint、migration、测试门禁和明确非范围见[阶段 05 报告第 10 节](architecture/backend-architecture-and-contracts.md#10-阶段-06最小服务端纵切)。

阶段 06 不实现完整推荐、Agent 对话、OCR/通知、采购/做饭闭环、微服务、向量数据库、正式 App 或生产部署；最小 consumed command 不关联 Meal、不接受 estimated 数量。真实微信条件不具备时继续标记 `Deferred — 外部依赖`，fake adapter 不能代替真实 Pass。
