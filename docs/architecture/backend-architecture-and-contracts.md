# 阶段 05：后端架构与共享契约定稿

- 日期：2026-07-23
- 结论状态：架构边界与契约基线 `Accepted`；服务端纵切、真实微信登录和生产环境均尚未验证
- 正式决策：[ADR-0002](decisions/0002-backend-runtime-framework-and-persistence.md)、[ADR-0003](decisions/0003-identity-tenancy-and-api-semantics.md)
- 契约包：[`packages/contracts`](../../packages/contracts/)

## 1. 范围与结论口径

本阶段只确定正式工程的后端边界并建立共享契约，不实现完整 API、正式客户端、Agent 服务或生产基础设施。

本文严格区分：

| 标记 | 含义 |
| --- | --- |
| **已决定** | 已通过 ADR 接受，可作为阶段 06 的实现输入 |
| **待验证** | 路线已选，但本项目还没有运行或集成证据 |
| **外部依赖** | 需要账号、域名、设备、云资源或平台配置，当前不能形成 Pass |
| **仅为假设** | 为估算或计划采用的临时前提，不是产品/技术承诺 |

阶段 04 的 `Deferred — 外部依赖` 与 `Not applicable` 项不因本阶段完成而改变。特别是测试号真机、真实微信登录、合法域名、分享、体验版、审核/发布、原生平台、离线队列和跨设备业务幂等仍没有 Pass 证据。

## 2. 已决定的正式基线

| 维度 | 选择 | 边界 |
| --- | --- | --- |
| 后端运行时 | Node.js 24 LTS + TypeScript 5.9.3 | 使用受支持 24.x patch；不采用多运行时 |
| Web 框架 | Fastify 5.x，阶段 06 初始 5.10.0 | 只在 `services/api` 适配层出现 |
| 数据库 | PostgreSQL 18.x | 唯一事务事实库；不引入向量数据库 |
| 数据访问 | Drizzle ORM 0.45.x + `pg` 8.x | SQL migration 进入版本控制并审查 |
| 契约 | Zod 4.4.3 + TypeScript 5.9.3 | `packages/contracts` 不依赖框架、数据库或 Taro |
| 部署形态 | 模块化单体 | P0 只部署 API；异步 worker 按实际 P1 需求再启用 |
| API | HTTPS JSON REST `/api/v1` | 统一 result/problem、cursor、幂等和乐观版本 |
| 鉴权 | 微信 code 服务端换码 → opaque internal session | `openid` 不作为 User ID；当前不使用 JWT |
| 租户隔离 | 应用授权 + 复合外键 + PostgreSQL RLS | 每个家庭请求显式携带 `householdId` |

版本号是阶段 06 的初始 lockfile 基线。安全 patch 可以在同一 major/minor 约束内升级，但必须重新运行检查；major 升级需要复审。

## 3. 系统与模块边界

```text
微信小程序 / 未来 App
        │
        │ HTTPS REST /api/v1
        ▼
services/api（一个部署单元）
├─ transport       Fastify、schema adapter、错误/日志
├─ identity        微信换码、User、AuthIdentity、Session
├─ households      Household、Membership、PersonProfile、授权
├─ inventory       InventoryLot、InventoryEvent、投影和并发
├─ meals           Meal、Recipe 引用、完成确认
├─ recommendations 确定性约束、候选排序、模型适配端口
├─ shopping        ShoppingItem 状态与买后入库
└─ persistence     Drizzle、transaction、RLS context、migration
        │
        ▼
PostgreSQL 18（唯一事实库）
```

依赖方向：

```text
transport → application modules → domain rules → ports
                    │                    │
                    └──── adapters ──────┘

packages/contracts ← transport mapper → internal domain / database rows
```

约束：

1. route handler 不写 SQL，不直接调用微信或模型 SDK。
2. 业务模块不依赖 Fastify request/reply。
3. `packages/contracts` 不依赖 Drizzle、Fastify、Taro、Node 内建模块或平台 SDK。
4. Drizzle row、领域聚合和 API response 是三种类型，不用类型断言把它们混为一体。
5. Agent 只能调用 application service 工具；工具执行同样的会话、家庭、权限、幂等和安全校验。
6. 模型不能决定过敏、食品安全、权限或库存最终写入。

`services/agent` 和 `services/worker` 当前只是预留目录，不是阶段 06 的独立部署单元。推荐编排先作为 API 内模块；P1 OCR、通知或长任务出现明确隔离需求后再建立 worker。

## 4. 身份、用户、家庭成员与会话

### 4.1 映射

| 实体 | 范围 | 职责 | 不能替代 |
| --- | --- | --- | --- |
| `AuthIdentity` | provider 全局 | 保存微信 AppID 范围内的 `openid` 等登录入口 | 不能作为 User、Membership 或 PersonProfile |
| `User` | 系统全局 | 内部可登录用户和账号生命周期 | 不直接表达家庭权限或实际用餐者 |
| `Session` | 单次登录/设备 | 可撤销、可过期的内部会话 | 不缓存家庭授权事实 |
| `Household` | 家庭租户 | 共享数据和协作边界 | 不等同于创建者 User |
| `Membership` | User × Household | role、capability、成员状态 | 不必代表实际参与用餐 |
| `PersonProfile` | Household 内 | 实际用餐者、饭量、厨艺和约束 | 可以没有登录 User |

唯一性与关联：

- `AuthIdentity(provider, providerTenantKey, providerSubject)` 唯一；
- `Membership(householdId, userId)` 唯一；
- 一个 Membership 最多关联一个 PersonProfile；
- 所有者也是普通的 Membership，只是 role 为 `owner`；
- 用户可以有多个 Membership，普通产品界面仍默认一个家庭；
- `providerUnionSubject` 可为空，只供显式账号关联流程参考。

### 4.2 登录与 session

客户端只把 `wx.login()` code 发送给服务端。服务端使用对应环境的 Secret 调用 code2Session，然后在事务内解析/创建 AuthIdentity 和 User，签发高熵 opaque token。数据库只保存 digest。

初始 session 策略：

- 最长 30 天；
- 连续 7 天未使用失效；
- 用户退出、禁用、成员安全事件或 token 疑似泄漏时可立即撤销；
- 客户端在安全存储中保存 token，通过 `Authorization: Bearer` 使用；
- session 不携带 role、capability 或当前 Household 权限快照。

这些时长是**已决定的初始安全配置**，可在不改变 contract 的前提下收紧。真实换码和多设备恢复仍为**外部依赖**。

## 5. API、错误与版本

### 5.1 请求

- Content-Type 为 `application/json`；错误为 `application/problem+json`。
- 每个请求产生 `requestId`，响应和结构化日志都携带它。
- 家庭资源使用 `/api/v1/households/{householdId}/...`。
- 输入在 transport 边界用共享 schema 校验；数据库查验、权限和安全规则不放进同步 schema refinement。
- 客户端不得发送 `createdByUserId`、`actorUserId`、`householdId` 之外的服务端派生审计字段；它们从 session/route context 产生。

### 5.2 响应

成功：

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "requestId": "opaque-uuid"
  }
}
```

错误：

```json
{
  "ok": false,
  "type": "https://api.example.invalid/problems/inventory-version-conflict",
  "title": "库存已被其他成员修改",
  "status": 409,
  "code": "INVENTORY_VERSION_CONFLICT",
  "requestId": "opaque-uuid",
  "retryable": true
}
```

`title/detail` 可本地化，客户端逻辑只依赖 HTTP status 和稳定 `code`。禁止返回数据库堆栈、SQL、微信响应正文、模型提示或敏感 provider identifier。

### 5.3 版本与分页

- v1 内允许新增 optional 字段、新 endpoint 和客户端声明可忽略的新 error code。
- 删除/重命名字段、把 optional 改 required、改变状态机或 ID 含义时建立 v2。
- cursor 是服务端签发的 opaque token，最多 512 字符；客户端不得解析。
- 公开内测后，废弃 endpoint 至少提前 90 天发布 `Deprecation`/`Sunset` 信息；此前内部阶段仍需同步升级客户端和 contract。

## 6. 家庭隔离、权限与敏感字段

### 6.1 应用层

统一 `HouseholdContext` 只能由 auth middleware 构造，至少包含：

```text
requestId
sessionId
userId
householdId
membershipId
role
capabilities
```

业务方法接受该 context，不接受客户端自行声明的 actor。所有者管理成员和家庭；普通成员只使用固定 capability，不在 P0 建立自定义角色编辑器。

### 6.2 数据库层

家庭私有表必须：

- 有 non-null `household_id`；
- 主键之外提供 `(household_id, id)` unique key；
- 子表使用 `(household_id, parent_id)` 复合外键；
- 开启并强制 RLS；
- policy 读取事务局部 `app.user_id` / `app.household_id`；
- 使用不拥有表、不具备 `BYPASSRLS` 的应用角色。

连接池只能在事务内用 `set_config(..., true)` 设置上下文，不能使用跨请求残留的 session-level `SET`。

### 6.3 响应 redaction

RLS 只解决家庭行隔离，不解决同一家庭内的敏感字段。`subject_and_owner` 饮食约束：

- 约束内容只对本人和所有者展示；
- 推荐/安全服务始终获得确定性检查所需信息；
- 其他成员只能看到“存在不可绕过的限制”及必要的安全阻断，不返回敏感原文；
- 日志、分析和模型 prompt 不默认包含成员姓名和完整限制。

## 7. 幂等、库存事件与并发

### 7.1 幂等记录

创建领域事件或推进业务状态的 write command 使用 `Idempotency-Key`，服务端记录：

```text
scope_hash
request_hash
state (processing/completed/failed)
http_status
response_body
first_request_id
created_at / expires_at
```

幂等记录和业务写入同事务提交。相同 key/相同 body 重放第一次结果；相同 key/不同 body 返回 `IDEMPOTENCY_KEY_REUSED`。库存和采购事件自身长期保存 key 的唯一约束，通用 response cache 至少保留 30 天。

登录 token 签发和 session 撤销不使用通用 response replay，避免为重放持久化明文 token。登录网络失败时客户端重新取得微信 code；User/AuthIdentity 唯一映射阻止重复账号，旧 session 可按安全策略回收。幂等 response cache 禁止保存 token、provider identifier 和私有约束。

### 7.2 库存事实

```text
InventoryLot（批次元数据 + 当前投影 + version）
       ▲
       │ reduce
InventoryEvent（不可变事实 + actor + source + idempotencyKey）
```

- acquired/produced/consumed/discarded/adjusted/corrected 等数量事件保存 numeric delta 或 qualitative change；
- opened/moved/frozen/thawed 是状态事件；
- `currentQuantity` 是可重建投影，不是覆盖历史的事实；
- `expectedLotVersion` 必须与当前 version 相同；
- `resultingLotVersion = expectedLotVersion + 1`；
- 数字扣减不能产生负库存；
- 模糊数量保持原始表达和置信度，不伪造精确值；
- 纠错追加 `corrected` 事件并引用原事件，不修改历史。

日期使用独立 `kind` 和来源：

- `purchase_date` 不能被解释为 `production_date`；
- 标签日期、用户输入、审核规则估算和已确认识别结果分开；
- `estimated_use_by_date` 必须带审核规则版本；
- OCR/模型识别只有用户确认后才可进入正式 lot/event。

## 8. 环境边界

环境不是一个 `APP_ENV` 开关下共享数据库，而是独立身份、网络、数据和 Secret 边界。

| 维度 | local | test | staging | production |
| --- | --- | --- | --- | --- |
| 用途 | 人工开发 | 自动化验证 | 发布前集成/真机 | 真实用户 |
| API | 本机 HTTP/HTTPS | 进程内或临时端口 | 独立 HTTPS 域名 | 独立生产域名 |
| PostgreSQL | 本地 PostgreSQL 18 容器 | 每套件临时 PostgreSQL 18 | 独立实例/数据库 | 独立实例、备份与恢复 |
| 微信 | 默认 fake adapter；可选测试号 | deterministic fake，禁止外呼 | 测试/专用 AppID，外部依赖 | 正式 AppID，外部依赖 |
| 数据 | 合成 seed | 合成 fixture，测试后销毁 | 合成/授权测试数据，禁止生产复制 | 真实数据 |
| Secret | 本机忽略文件/临时注入 | CI 临时 Secret | 独立 Secret 项目 | 独立生产 Secret 项目 |
| migration | 开发 migration | 从空库完整执行 | 发布 job，先备份/演练 | 独立最小权限 job |
| 日志 | 可读调试，仍需脱敏 | 测试捕获 | 结构化、脱敏、短保留 | 结构化、审计、告警 |
| 外部模型/OCR | 默认 fake/off | fake/off | 明确 allowlist | 另行 ADR 后才启用 |

强制规则：

1. 四个环境不共享数据库、对象存储 bucket、加密 key、session signing/digest secret 或微信 Secret。
2. staging/production 使用不同云账号或至少不同项目、网络和 IAM 边界。
3. production 数据不得复制到 local/test；故障复现使用匿名化后仍经授权的数据或合成样本。
4. 配置在进程启动时用 schema 校验；缺少必需项立即失败，不使用隐式 production default。
5. 云厂商和具体部署产品**待验证**，本阶段不预选。

## 9. 共享契约基线

`@meal-agent/contracts` 0.1.0 已包含：

| 文件 | 主要 contract |
| --- | --- |
| `primitives.ts` | opaque IDs、日期/来源/置信度、精确/模糊数量 |
| `identity.ts` | User、AuthIdentity、Session、Household、Membership、PersonProfile、DietaryConstraint、登录/创建家庭请求 |
| `inventory.ts` | InventoryLot、InventoryEvent、创建批次请求/结果 |
| `meals.ts` | Meal、Recipe、Recommendation 及候选 |
| `shopping.ts` | ShoppingItem 与来源/状态 |
| `api.ts` | ApiResult、ApiError、Pagination、Idempotency、ExpectedVersion |

contract 设计规则：

- runtime schema 与 TypeScript type 同源；
- object 默认 strict，拒绝未声明字段；
- ID 使用 nominal brand，JSON 仍是 opaque UUID string；
- API input 不包含 actor、审计、版本结果等服务端字段；
- entity snapshot 不等同于数据库表；
- endpoint 新增 input/output 优先在本包演进，不在客户端或服务内复制。

当前自动验证包括：

- 类型检查与 nominal ID 编译期隔离；
- 全部核心实体可组合解析；
- 过敏等硬约束不能降级为软偏好；
- 日期来源和规则估算要求；
- 库存事件方向、版本递增和纠错引用；
- 推荐候选必须有 hard constraint pass；
- 已买与已入库状态分离；
- API error/status、pagination 和 idempotency；
- trust boundary 拒绝额外字段；
- declaration/JavaScript 构建。

## 10. 阶段 06：最小服务端纵切

### 10.1 必须实施

阶段 06 只实现“登录 → 创建/读取家庭 → 手工新增一个库存批次 → 重试得到同一结果”的最小纵切。

工程：

- 建立 `services/api` Node.js 24/Fastify 5 工程；
- 接入 `@meal-agent/contracts`，不得复制 DTO；
- 建立统一 config、request ID、日志脱敏、error mapper、graceful shutdown；
- 生成 OpenAPI，证明 schema 只有一个事实源；
- 提供 deterministic fake WeChat adapter 和正式 code2Session adapter 端口。

数据库 migration：

- `users`
- `auth_identities`
- `sessions`
- `households`
- `memberships`
- `person_profiles`
- `inventory_lots`
- `inventory_events`
- `idempotency_records`

路由：

| 路由 | 最小行为 |
| --- | --- |
| `GET /healthz` | 进程存活，不探测外部依赖 |
| `GET /readyz` | 数据库和 migration ready |
| `POST /api/v1/auth/wechat/exchange` | fake/真实 adapter 换码，创建或恢复 User/Session |
| `DELETE /api/v1/session` | 撤销当前 session |
| `GET /api/v1/me` | 返回内部 User 与可访问家庭摘要 |
| `POST /api/v1/households` | 同事务创建 Household、owner Membership 和 owner PersonProfile |
| `GET /api/v1/households` | 只列出当前 User 的 active Membership |
| `GET /api/v1/households/{id}/inventory-lots` | cursor list，仅当前家庭 |
| `POST /api/v1/households/{id}/inventory-lots` | 创建 lot、初始 event、幂等记录和 projection |

测试门禁：

1. PostgreSQL 18 从空库执行全部 migration。
2. fake 微信 code 能首次创建、再次恢复同一 User，provider subject 不进入 response/log。
3. 两个 User、两个 Household 的正向访问通过，四种交叉访问均被拒绝。
4. RLS 在故意漏写 household filter 的测试查询中仍阻止跨家庭读取。
5. 相同 idempotency key/body 只创建一个 lot 和一个 event，并重放原响应。
6. 相同 key/不同 body 返回 409。
7. 并发扣减或版本更新只有一个成功；不产生负库存或静默覆盖。
8. session 过期、撤销和成员移除立即失效。
9. contract、类型检查、单元、HTTP integration 和数据库 integration 全部通过。
10. 日志扫描不含 login code、token、openid、unionid、AppSecret、成员敏感约束。

### 10.2 明确不做

- 完整菜单推荐、菜谱内容导入、模型调用或 Agent 对话；
- OCR、语音、条码、图片、外部通知和异步 worker；
- 采购、做饭、餐后扣减和剩菜回库的完整 API；
- Redis、消息队列、向量数据库或微服务拆分；
- 正式 App、真实生产域名、生产云资源或真实家庭数据；
- 体验版上传、审核、发布和 Android/iOS/HarmonyOS；
- 复杂自定义角色、账号自动合并、完整邀请/数据导出/删除。

### 10.3 阶段 06 外部补证

如果具备测试 AppID/AppSecret、测试号真机和 HTTPS 合法域名，追加验证真实 `wx.login` → code2Session → internal session → `NetworkPort`。条件不具备时，代码 adapter 和自动测试可以完成，但结果继续标记为 `Deferred — 外部依赖`，不能以 fake adapter 代替真实 Pass。

## 11. 风险与复审

| 风险 | 当前处理 | 复审点 |
| --- | --- | --- |
| Fastify/Zod 出现双 schema | route 只引用共享 schema/adapter | 阶段 06 OpenAPI/contract test |
| Drizzle 0.x 升级变化 | 精确锁版、SQL migration 审查 | 每次依赖升级 |
| RLS 连接上下文泄漏 | transaction-local config + 独立 app role | 阶段 06 并发/连接复用测试 |
| 私有约束被成员或模型看到 | response redaction + prompt allowlist | 推荐纵切前安全测试 |
| 模糊数量无法正确扣减 | event 支持 numeric/qualitative change | 餐后扣减纵切 |
| 微信身份误合并 | openid scope unique，UnionID 不自动合并 | 多 AppID/新 provider 前 |
| 幂等缓存过期后重复事件 | 事件长期唯一 key | 数据量和归档策略 |
| 云平台不支持所需边界 | 不提前绑定供应商 | 预发布环境选型 |

## 12. 本阶段完成证据

- ADR-0002 与 ADR-0003 状态为 `Accepted`；
- `packages/contracts` 类型检查、8 个运行时测试和构建通过；
- 本文给出环境隔离和阶段 06 endpoint/migration/test 清单；
- 系统概览、领域模型、ADR 导航、文档导航和项目状态已同步；
- 阶段 04 Deferred 项未改为 Pass。
