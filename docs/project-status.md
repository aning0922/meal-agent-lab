# 项目状态

更新时间：2026-07-25

## 当前阶段

阶段 08“家庭成员与硬约束纵切”已完成实施：在阶段 06/07 基线上补齐“凭邀请加入家庭 → 成员与用餐档案 → 饮食硬/软约束（硬约束双确认）→ 字段级 response redaction”的服务端 + 客户端纵切，把推荐引擎（后续阶段）依赖的按参与者硬约束数据面建立起来。服务端新增 8 条路由（邀请签发/列表/撤销、凭码加入、成员列表 redacted 视图、成员移除/退出、用餐档案 CRUD、约束增删），迁移 `0001_stage_08` 新增 `household_invites`（只存 digest、FORCE RLS、join 路径用 SECURITY DEFINER 赎回函数 bootstrap membership）；客户端新增成员页（M-02）、档案与约束页（O-02，硬约束独立确认屏）与加入家庭入口，页面零直接 `wx.*`。实施与验收记录见[阶段 08 计划](plans/2026-07-stage-08-members-and-constraints.md)。

后端基线不变：Node.js 24 LTS + Fastify 5 模块化单体、PostgreSQL 18 + Drizzle/`pg`（[ADR-0002](architecture/decisions/0002-backend-runtime-framework-and-persistence.md)、[ADR-0003](architecture/decisions/0003-identity-tenancy-and-api-semantics.md)）。[`@meal-agent/contracts`](../packages/contracts/) 升级 **0.3.0**（additive；0.2.0 消费者不破坏），仍是客户端、服务端、测试和 OpenAPI 的唯一契约事实源；客户端不定义第二份核心 DTO。阶段 06 遗留的“通用成员/档案读取字段级 redaction”在本阶段随成员列表端点**转正为 Pass**（见下）。当前仍没有菜单推荐、Agent、采购/完整做饭流程；下一阶段产品范围尚未决定。

微信真机预览、真实登录、合法域名、邀请分享（微信分享卡片）、体验版/审核/发布、离线队列和三个原生平台仍保持 `Deferred — 外部依赖`；生产云、托管数据库、Secret 管理和可观测平台未验证。相机、语音、条码、OCR 和外部通知保持 `Not applicable`。deterministic fake WeChat adapter 没有被当作真实微信链 Pass；邀请码本阶段通过复制文本传递，微信分享只是未来的传输渠道，不影响服务端语义。

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
- 家庭隔离同时依赖应用授权、复合外键、RLS 和敏感字段 redaction；通用字段级 response redaction 已在阶段 08 的成员列表端点落地（`subject_and_owner` 约束由响应形状结构性排除，非运行时删字段）。
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

## 阶段 07 完成

### 工程与分层

- `apps/client` 进入根 pnpm workspace（单一 lockfile），直接依赖锁定 ADR-0001 版本（Taro 4.2.1 / React 18.3.1 / TypeScript 5.9.3），传递依赖重新解析，未复用 spike 锁文件；一次性 spike `apps/meal-agent-client-spike` 已删除。
- 分层：`platform/`（端口定义 + 唯一 Taro/wx 触点）、`core/`（登录/家庭/库存业务流程、API 客户端、会话存储，纯 TypeScript、Node 可测）、`pages/`（薄 UI）。页面零直接 `wx.*`/Taro API 调用。
- 所有请求本地经契约模式预校验，所有响应（含 `application/problem+json`）经契约模式验证后才进入页面；客户端零本地 zod schema、零第二份核心 DTO。
- CI 收敛为 `stage07-check` 单一门禁：contracts/api 全套 + client typecheck、51 个单元测试（含合并前审核修复的 5 个回归）、weapp 生产构建、13 个 E2E 场景（Ubuntu + PGDG PostgreSQL 18）。

### 端到端语义

- E2E 使用真实 `services/api` + 一次性 PostgreSQL 18 集群 + fake 微信适配器，覆盖：登录会话持久化、创建家庭、三态初始数量（exact 十进制字符串 / approximate 数值+置信度+原始描述 / qualitative 等级）端到端保真、批次列表、exact-only 消耗。
- 幂等：创建家庭、新增批次、消耗三处同键重复提交均重放第一次结果（`replayed=true`），不产生第二条记录、不重复扣减；表单修改后换新幂等键。
- 并发：过期 `expectedVersion` 消耗返回 `INVENTORY_VERSION_CONFLICT`，页面刷新提示不静默覆盖；超量消耗返回 `INVENTORY_INSUFFICIENT`。
- 会话与隔离：撤销后旧 token / 伪造 token 均 401 → 清会话 + 重定向登录 + 原因提示；跨家庭批次列表与消耗均 404 语义，不泄露存在性。
- 非 exact 批次消耗在客户端本地拒绝；估算/感性数量展示保留来源与置信度，不伪装成精确量。

## 阶段 08 完成

### 契约与数据

- `@meal-agent/contracts` 升级 0.3.0（additive）：新增 `HouseholdInvite`（实体不含明文与 digest）、创建/撤销/加入邀请、成员列表 redacted 视图、用餐档案 CRUD 与硬/软约束增删的请求/响应 schema，全部 strict、含正反例不变量测试；0.2.0 消费者不破坏。
- 迁移 `0001_stage_08`（首个增量迁移）新增 `household_invites`：code digest（sha256）唯一、复合外键绑定 memberships、`expires_at ≤ created_at + 7 天`、`max_uses 1–10`、`used_count ≤ max_uses` CHECK、FORCE RLS。迁移序列在“已应用 0000 的库”上增量应用 0001 成功且 checksum 校验通过；空库两文件全量成功；Drizzle schema 与 SQL 约束/索引名对齐（数据库层断言 7 条邀请约束名）。
- join 路径二选一记录：采用 **SECURITY DEFINER 赎回函数** `meal_agent_private.redeem_household_invite`——digest 查询、`used_count` 递增与 membership 落库在一个函数内原子完成，`FOR UPDATE` 串行化同码并发，杜绝“未持有效码也能自插成员”的空档。

### 服务端语义

- 8 条新路由：邀请签发（owner，household 幂等，活跃上限 10，明文只返回一次）、邀请列表（owner，cursor 分页，无明文/digest）、邀请撤销（owner，重复撤销 409）、凭码加入（已认证，user 幂等，并发 `used_count` 恰好递增、不超 `max_uses`，无效/过期/撤销/用尽一律 404 不泄露家庭存在性，已是成员 409）、成员列表（member，owner/self 见 `subject_and_owner`、其余成员结构不可见）、成员移除/退出（owner 移除他人、member 仅退出自己、最后一位 owner 409、被移除者即时 404）、用餐档案创建/编辑/归档（乐观并发）、约束增删（硬约束缺 confirmation 400、成功写入 confirmedAt/confirmedByUserId=操作者、allergy 无结构化编码拒绝）。
- 授权矩阵：member 不能签发/撤销邀请、不能移除他人、不能改他人档案与约束（403）；owner 全能但受最后 owner 保护（409）；跨家庭一律 404。member 角色 RLS 反向测试补齐阶段 06 盲区：三类 bootstrap（缺 user context / 缺 household context / 缺 membership）单独缺失均被拒绝，并有第二成员真实用例正向对照。
- 字段级 redaction 采用“响应形状结构性排除”而非运行时删字段，杜绝漏删；数据库层脱敏投影用 `safeOwnerProfileResponseSchema` 二次解析，若过滤有漏会直接抛错。

### 客户端

- `apps/client` 新增 `members-flow`（加入并切换家庭上下文、邀请签发/列表/撤销、成员移除/退出）与 `profile-flow`（档案创建/编辑/归档乐观并发、硬约束录入的结构性双确认）覆盖新端点；M-02 成员页、O-02 档案与约束页（硬约束独立确认屏、`subject_and_owner` 可见性选择）与家庭页的加入入口。页面零直接 `wx.*`，契约类型全部来自 `@meal-agent/contracts`；84 个单元测试（阶段 07 基线 51+ 上扩展）。
- 双用户 E2E（真实 `services/api` + 一次性 PostgreSQL 18 + fake 微信）：A 建家 → 签码 → B 加入 → B 建档案并录入 `subject_and_owner` 硬约束（双确认）→ A（owner）可见、第三成员 C 结构性不可见 → A 撤销邀请码、B 退出（即时 404）、A 归档档案 → 最后 owner 保护。weapp 生产构建通过（Zod jitless 回归保持）。

### 门禁证据

- `pnpm stage08:check` 全绿：environment 前置检查 + 迁移增量/checksum 证明 + `pnpm check`（contracts 20 / api 单元 12 / api HTTP 5 / api 数据库 27 / client 84，weapp 构建）+ 两套 E2E（阶段 07 十三场景 + 阶段 08 八场景，21/21）。
- PostgreSQL integration 与 E2E 使用实际 18.4 一次性 cluster，不用 SQLite/mock/fake migration 结果代替。
- 应用日志 sentinel 扫描未发现邀请明文码、token、provider subject 或成员私密约束标签。
- 提交范围扫描未发现密钥、AppID 或真实个人数据；过敏/宗教样例一律虚构并标注（`FICTION_*` / “虚构…”）。
- GUI 模拟器 happy-path 走查（加入 → 档案 → 硬约束 → 移除）**待产品负责人手工执行**（appid 在 gitignored `project.private.config.json`）；未完成前不记为 Pass。
- 详细环境、命令、边界与逐条门禁自证见[阶段 08 计划](plans/2026-07-stage-08-members-and-constraints.md)。

## 当前验证状态

### Pass

- 阶段 05 `packages/contracts` 的类型检查、运行时测试和构建；
- 阶段 05 收尾的一致性、重复核心类型、提交范围、文档链接和静态检查；
- 阶段 06 Node/Fastify/Drizzle/`pg` 服务、PostgreSQL 18 migration、三类 RLS bootstrap、会话、幂等、库存并发与 OpenAPI 门禁；
- 阶段 07 `apps/client` typecheck、单元测试、weapp 生产构建与真实 API + PostgreSQL 18 端到端闭环（fake 微信适配器）；
- 阶段 08 成员/邀请/用餐档案/硬约束纵切：契约 0.3.0（additive）、迁移 `0001` 增量+checksum、8 条服务端路由、成员 RLS 反向测试、硬约束双确认、字段级 redaction 与双用户 E2E，`pnpm stage08:check` 全绿；
- **通用成员/PersonProfile 读取响应的字段级 redaction 与角色矩阵**（阶段 06 曾记 `Deferred — 后续范围`）在阶段 08 转正为 Pass：`GET /members` 以两种响应形状固定（owner/self 视图 vs household 视图），household 视图**结构上**不可能携带 `subject_and_owner` 约束（复用 `safeOwnerProfileResponseSchema` 的 allowlist）。证据：契约不变量正反例测试、数据库层 redaction 断言、双用户 E2E（owner 可见、第三成员结构不可见）与日志 sentinel（私密约束标签不入日志）。

### 依赖审计

- 正式 Stage 05/06 根工作区、contracts 和 `services/api` 的 `pnpm audit --prod` 为 0 个已知漏洞。
- 阶段 07 `apps/client` 并入根 workspace 后 `pnpm audit --prod` 命中 9 个通告（1 critical、8 moderate），全部位于 Taro 4.2.1 自身锁定路径：moderate 为 webpack-dev-server/esbuild 等本地开发服务器范围（不进入产物）；critical 为 `@tarojs/components>swiper`（H5 端依赖），已核对 weapp 产物只含微信原生 `<swiper>` 组件名映射、npm `swiper` 代码未打包。客户端自身直接依赖 `webpack` 已升至 5.104.1。接受为构建期风险，升级窗口待 Taro 4.3 评估。
- 阶段 08 未新增任何 npm 依赖（`pnpm install --frozen-lockfile` 无锁文件变更），`pnpm audit --prod` 通告集与阶段 07 基线一致，**无新增未记录通告**；上述 Taro 构建期风险条目继续适用。
- 低保真原型的独立依赖树命中 11 个通告（5 high、6 moderate），来自 Next/PostCSS/Sharp 范围；原型不是正式 App，不得部署或复用到正式工程。

### 待验证

- staging/production 的具体云平台、连接池边界、备份恢复、migration job、Secret 管理和可观测性；
- 内测负载下的连接池容量、超时、限流和慢查询阈值；
- 后续产品阶段是否扩展菜单、Agent、采购或完整做饭流程，尚未决定。

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

## 阶段 07 范围边界

只实施客户端侧闭环：

```text
登录（fake adapter）→ 创建/选择家庭 → 库存批次列表 → 手工新增批次
    → exact-only 消耗（幂等重放、版本冲突刷新、401 引导、跨家庭 404）
```

以上闭环已由自动化 E2E（真实 `services/api` + 一次性 PostgreSQL 18）与 weapp 生产构建门禁验证。它只证明正式客户端骨架、平台适配边界与 API 集成语义可运行，不代表完整 P0 页面、菜单推荐、Agent、采购/做饭流程或视觉完成度已经完成。菜单推荐、Agent 对话、采购清单、成员邀请、语音/条码/OCR、原生平台与发布均不在本阶段范围。微信开发者工具模拟器（服务端口已开）已用自动化验证：编译产物渲染、页面交互、失败态呈现，以及编译后客户端在真实运行时向本地 API 发出的请求构造正确（观测到真实 exchange 请求打到 fake 适配器 + 真实 PG18 并返回合法 session）；完整 happy-path 逐屏走查已由产品负责人在 GUI 手工走通（登录→创建家庭→三态批次→消耗→重复提交→版本冲突→退出，全部符合预期），其闭环行为另由 13 个 E2E 场景覆盖。走查过程中发现并修复了一个 Node 测试全过、仅在真实小程序运行时暴露的缺陷（Zod v4 对象校验 JIT 依赖 `new Function`，被小程序沙箱禁用 → 全局关闭 jitless，提交 `d54f183`），验证了模拟器走查相对纯 Node 测试的独立价值。真机、真实微信登录与合法域名仍为 `Deferred — 外部依赖`（fake 适配器链路不记为真实微信 Pass）。

## 阶段 08 范围边界

只实施成员与硬约束纵切：

```text
凭邀请码加入家庭 → 成员与用餐档案 → 饮食硬/软约束（硬约束双确认）
    → 成员列表字段级 redaction（owner/self vs household 视图）
    → 成员移除/退出（最后 owner 保护、被移除者即时 404）
```

以上纵切已由 `pnpm stage08:check`（含真实 PostgreSQL 18 数据库测试与双用户 E2E）与 weapp 生产构建验证，并把阶段 06 遗留的通用字段级 redaction 转正。它只证明按参与者的硬约束数据面与成员/邀请边界可运行，不代表菜单推荐、菜谱数据、采购、做饭流程、Agent 对话、报餐/投票（FAM-009）、所有权转移与解散家庭（FAM-010 其余子集）、成员自定义角色或限流已经完成——这些均不在本阶段范围。真实微信分享/真机链路仍为 `Deferred — 外部依赖`，fake 适配器不记为真实微信 Pass。
