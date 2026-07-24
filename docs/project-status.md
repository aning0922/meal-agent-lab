# 项目状态

更新时间：2026-07-24

## 当前阶段

阶段 06“最小服务端纵切”已完成，并已在 `b9b149b`、`d37781f` 两轮修订中补强边界。后端正式基线为 Node.js 24 LTS + Fastify 5 模块化单体、PostgreSQL 18 + Drizzle/`pg`；身份、家庭租户、API、鉴权、RLS、幂等、错误和版本策略由 [ADR-0002](architecture/decisions/0002-backend-runtime-framework-and-persistence.md) 与 [ADR-0003](architecture/decisions/0003-identity-tenancy-and-api-semantics.md) 接受，并已经在 [`services/api`](../services/api/) 完成第一次实际纵切。

[`@meal-agent/contracts`](../packages/contracts/) 0.1.0 是客户端、服务端、测试和 OpenAPI 的共享契约事实源。当前已有登录、session、家庭和库存一致性最小服务，但仍没有菜单推荐、Agent、采购/完整做饭流程或正式 App；下一阶段产品范围尚未决定。

阶段 04 的微信测试号真机预览、真实登录、合法域名、邀请分享、体验版/审核/发布、离线队列和三个原生平台仍保持 `Deferred — 外部依赖`；生产云、托管数据库、Secret 管理和可观测平台也未在本阶段验证。相机、语音、条码、OCR 和外部通知保持原阶段 `Not applicable`。deterministic fake WeChat adapter 没有被当作真实微信链 Pass。

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
- 家庭隔离同时依赖应用授权、复合外键、RLS 和敏感字段 redaction；通用字段级 response redaction 尚未进入阶段 06 读取端点，保持 `Deferred — 后续范围`。
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
- contract 额外固定 active/matching authenticated session、实体 UUIDv7、食品安全阻断原因、私密 owner constraint redaction、日期上限/类型唯一、正式初始数量结构、初始事件可重建批次数量、estimated/exact delta 判别、exact-only consumed 请求/event，以及 consumed 响应的 exact lot、同单位、人工确认来源和 exact 0/depleted 正例；库存状态/数量、追加纠错、推荐预选、采购状态和 pageInfo 不变量均有反例断言。
- 根工作区 contracts 检查通过：TypeScript、10/10 运行时测试和 declaration/JavaScript 构建；阶段 04 客户端 spike 检查通过：TypeScript、5/5 测试和微信小程序构建；低保真原型通过 TypeScript、2/2 渲染测试、构建和 ESLint。
- 74/74 个本地 Markdown 链接可解析，18/18 个阶段 06 必需 contract export 可从构建产物加载，`git diff --check` 通过。
- 提交范围扫描未发现密钥签名、非空 Secret、真实邮箱/手机号或真实用户夹具；`.env.example` 只有空值/假适配器配置。依赖目录、构建目录、日志和 TypeScript 增量缓存均被忽略，没有生成物进入阶段 05 提交。

## 阶段 06 完成

### 工程与契约

- 建立 Node.js 24/Fastify 5 的 `services/api`，配置、request ID、日志脱敏、统一错误映射和 graceful shutdown 已接入。
- 建立 deterministic fake WeChat adapter 和真实 code2Session adapter port；production 配置强制 real adapter、运行时凭据和 HTTPS code2Session URL，`RealWechatAdapter` 构造边界也独立拒绝明文 HTTP。真实 adapter 仍只有调用和安全错误边界，没有虚假真实链验证。
- 所有业务 request/response 复用 `@meal-agent/contracts`；阶段 06 HTTP envelope 也在共享包组合，OpenAPI 从同一批 Zod schema 和路由生成。错误响应声明为 `application/problem+json`，跨字段 refinement 使用可表达的 `oneOf` 或 `x-zod-refinements` 保留。
- 健康、就绪、登录、session、`me`、家庭和库存共 10 个 route method 已实现；`readyz` 同时检查数据库与 migration checksum。malformed JSON、404、登录交换 401、413 payload too large、超长 request target 和 415 unsupported media type 进入同一 problem 边界。

### 数据库与隔离

- PostgreSQL 18 空库 migration 建立 `users`、`auth_identities`、`sessions`、`households`、`memberships`、`person_profiles`、`inventory_lots`、`inventory_events`、`idempotency_records` 九张业务表。
- migration owner 与无 `BYPASSRLS` 应用角色分离；六张家庭/幂等表启用并强制 `FORCE ROW LEVEL SECURITY`。
- PersonProfile→Membership、InventoryLot→Membership、InventoryEvent→Lot/Membership/Event 和 Idempotency→Membership 使用家庭复合外键。
- creator、只设置 `app.user_id` 的 user-list、以及先 bootstrap active Membership 的 household-resource 三类事务顺序已实现；`app.user_id` / `app.household_id` 只用 transaction-local 设置。
- 故意漏写 household filter 的查询仍被 RLS 限制；连接复用验证事务结束后 user/household context 和 local role 均不残留。
- exact 数量 contract 使用 plain fixed-point decimal string，并与两列数据库金额统一为最多六位小数的 `numeric(15, 6)`；JSON number、指数形式和超精度字符串在 IEEE-754 转换前拒绝，等值字符串 alias 在幂等哈希前规范化。数据库格式化只补零、不舍入；扣减、负库存判断和 depleted 投影使用 PostgreSQL decimal 运算。

### 会话、幂等与库存

- fake code 首次创建、再次恢复同一 User；opaque token 只在签发响应出现，数据库只存 SHA-256 digest。
- disabled AuthIdentity/User 不能重新登录或新增 session；disabled User、绝对/不活跃过期、撤销 session 和成员移除都会在下一请求即时失效；Session、AuthIdentity、User 复合关系阻止错配。
- 创建家庭使用 user-scope 幂等，家庭库存 command 使用 household-scope 幂等；request fingerprint 绑定目标资源和 schema 规范化后的 body，相同 key/目标/body 顺序或并发重放第一次结果，不重复创建家庭、批次或事件；等值 exact decimal alias 重放原结果，同 key 改变目标 lot 或其他语义字段返回 409，不跨 lot 回放。
- exact-only consumed 生成同单位 exact 负 delta，满足 `after = before + delta` 且 `after >= 0`；0 进入 `depleted`，非 0 保持 `active`。
- 不同 key/相同 expectedVersion 的并发 consumed 只有一个成功；相同 key/body 的并发 consumed 只执行一次并重放；负库存不写事件或投影。

### 门禁证据

- `@meal-agent/contracts` 类型检查、11 个运行时测试和 declaration/JavaScript 构建通过。
- `services/api` 类型检查、8 个单元测试、5 个 HTTP integration、19 个 PostgreSQL integration、空库 migration、环境前置检查、OpenAPI 一致性检查和构建通过。
- PostgreSQL integration 使用实际 18.4 一次性空 cluster，不用 SQLite、mock 数据库或 fake migration 结果代替。
- 两个 User、两个 Household 的正向访问、家庭列表交叉隔离和资源交叉 404 均通过。
- 应用日志 sentinel 扫描未发现 login code、token、provider subject、UnionID、AppSecret 或成员私密约束。
- 详细环境、命令和 Deferred 条件见[阶段 06 实施记录](plans/2026-07-stage-06-backend-vertical-slice.md)。

## 当前验证状态

### Pass

- 阶段 04 已有的小程序构建、开发者工具模拟器、Mock 登录/存储/网络与适配层测试；
- 阶段 05 `packages/contracts` 的类型检查、运行时测试和构建；
- 阶段 05 收尾的一致性、重复核心类型、提交范围、文档链接和静态检查；
- 阶段 06 Node/Fastify/Drizzle/`pg` 服务、PostgreSQL 18 migration、三类 RLS bootstrap、会话、幂等、库存并发与 OpenAPI 门禁。

### 依赖审计

- 正式 Stage 05 根工作区/contracts 的 `pnpm audit --prod` 为 0 个已知漏洞。
- 阶段 06 根工作区、contracts 和正式 `services/api` 的 `pnpm audit --prod` 为 0 个已知漏洞。
- 一次性阶段 04 Taro spike 的独立依赖树命中 12 个通告（1 critical、9 moderate、2 low），来自 Taro 4.2.1 固定的 swiper/esbuild/webpack/webpack-dev-server/uuid 范围。
- 低保真原型的独立依赖树命中 11 个通告（5 high、6 moderate），来自 Next/PostCSS/Sharp 范围。
- 两个应用都不是正式 App 或 Stage 05 运行时，不得部署或复用到正式工程。消除通告需要升级并重新验证对应实验技术栈，不能用跨不兼容版本的 override 伪装为已修复。

### 待验证

- staging/production 的具体云平台、连接池边界、备份恢复、migration job、Secret 管理和可观测性；
- 内测负载下的连接池容量、超时、限流和慢查询阈值；
- 后续产品阶段是否扩展菜单、Agent、采购或完整做饭流程，尚未决定。

### Deferred — 后续范围

- 通用成员/PersonProfile 读取响应的字段级 redaction 与角色矩阵。阶段 06 只验证创建家庭的安全 owner response schema、幂等缓存 allowlist 和日志脱敏，没有成员/档案读取端点，因此不得记为 Pass。

### Deferred — 外部依赖

- 微信测试号真机扫码、真机存储和真机网络；
- 真实 `wx.login`/code2Session、AppID/AppSecret 和 HTTPS 合法域名；
- 邀请分享、体验版、审核、发布和 CI 上传凭据；
- Android、iOS、HarmonyOS 工具链、构建、实机、签名和发布；
- 生产云账号、域名、证书和托管数据库。

## 阶段 06 范围边界

只实施：

```text
登录 → 创建/读取家庭 → 手工新增一个库存批次
    → 相同幂等请求重放同一结果
    → 追加一个 exact-only 最小 consumed 事件
```

以上纵切已经实现并通过本地自动门禁。它只证明最小服务端架构、身份、租户和库存一致性边界可运行，不代表通用字段级 response redaction、完整 MVP、正式 App 或生产部署已经完成。

完整 endpoint、migration、测试门禁和明确非范围见[阶段 05 报告第 10 节](architecture/backend-architecture-and-contracts.md#10-阶段-06最小服务端纵切)。

本阶段没有实现完整推荐、Agent 对话、OCR/通知、采购/做饭闭环、微服务、向量数据库、正式 App 或生产部署；最小 consumed command 不关联 Meal、不接受 estimated 数量。真实微信条件仍为 `Deferred — 外部依赖`，fake adapter 不能代替真实 Pass。
