# ADR-0003：身份、家庭租户与 API 语义

- 状态：Accepted
- 日期：2026-07-23
- 负责人：产品负责人、服务端工程、安全
- 支撑材料：[阶段 05：后端架构与共享契约定稿](../backend-architecture-and-contracts.md)

## 背景

微信小程序提供的是一个登录入口，不是 Meal Agent 的内部用户、家庭成员或用餐者模型。产品还需要支持一个用户属于多个家庭、家庭内无登录用餐档案、未来增加 Apple/华为/手机号身份，以及退出、移除、换设备和会话撤销。

如果直接把微信 `openid` 当作用户或家庭主键，会造成：

- 多 AppID、多登录方式或账号关联时无法稳定映射；
- 登录身份、家庭权限和用餐档案耦合；
- provider identifier 外泄到客户端和日志；
- 会话撤销、成员移除和跨家庭隔离难以独立执行。

库存写入还需要跨网络重试、多人并发和 Agent 工具重试下保持只产生一次事件。

## 决策

### 四层身份映射

身份关系固定为：

```text
WeChat provider identity
  └─ AuthIdentity (provider + providerTenantKey + providerSubject)
       └─ User (全局内部登录用户)
            ├─ Session (可撤销的内部会话)
            └─ Membership (User 在某个 Household 的权限)
                  └─ 可关联一个 PersonProfile

Household
  └─ PersonProfile (实际用餐者；可以没有 Membership)
```

规则：

1. `User.id`、`Household.id` 等内部 ID 使用 UUIDv7，由服务端生成。
2. `AuthIdentity` 以 `(provider, provider_tenant_key, provider_subject)` 唯一；微信小程序的 `provider_subject` 是对应 AppID 下的 `openid`。
3. `unionid` 只作为经过验证的辅助关联信号，不是主键，不自动合并现有 User。
4. `PersonProfile` 必须属于一个 Household；登录成员的 profile 通过 `linkedMembershipId` 关联，无登录档案保持为空。
5. 同一 Membership 最多关联一个 PersonProfile；关联已有档案需要家庭所有者权限和被关联用户确认。
6. Session 关联 User 和本次 AuthIdentity，但不把“当前家庭”当作授权事实。
7. `openid`、`unionid`、微信 code、AppSecret 和 session token 不出现在业务日志、分析事件或家庭 API response。

### 微信登录交换

正式流程为：

```text
wx.login()
  → 一次性 code
  → POST /api/v1/auth/wechat/exchange
  → 服务端调用 code2Session
  → 事务内解析/创建 AuthIdentity 与 User
  → 签发内部 opaque Session token
```

- AppSecret 只存在服务端 Secret 管理中，绝不进入客户端、仓库或共享 contract。
- 客户端使用 `Authorization: Bearer <opaque-token>`；不使用微信 code 作为会话。
- token 使用加密安全随机数，数据库只保存不可逆 digest；原 token 只在签发时返回。
- Session 支持服务端撤销、绝对过期和不活跃过期；初始策略为最长 30 天、连续 7 天未使用失效，具体阈值可由非敏感配置收紧。
- 登录、权限变更、退出、用户禁用或安全事件可以轮换/撤销会话。
- 当前不使用 JWT：单体服务不需要离线验证，opaque session 更易立即撤销并避免把家庭权限快照固化在 token 中。

真实 `wx.login`、code2Session、AppID/AppSecret 和合法域名仍是阶段 06 的 `Deferred — 外部依赖` 验证项；本阶段只确定映射和接口语义。

### 家庭授权与数据隔离

所有家庭路由显式带 `householdId`，例如：

```text
/api/v1/households/{householdId}/inventory-lots
```

每个请求按顺序执行：

1. 从 opaque session 解析内部 `User.id`；
2. 检查该 User 在目标 Household 的 active Membership；
3. 检查固定 role/capability；
4. 在数据库事务内设置 request-scoped `app.user_id` 和 `app.household_id`；
5. 执行带 `household_id` 的查询/写入；
6. 提交后清除事务局部上下文。

数据库约束：

- 所有家庭私有表都有 non-null `household_id`；
- 跨表引用使用 `(household_id, id)` 复合外键，阻止跨家庭关联；
- RLS 是应用层授权之外的 defense in depth；
- 应用数据库角色不能拥有 `BYPASSRLS`，家庭私有表使用 `FORCE ROW LEVEL SECURITY`；
- migration owner 与应用运行角色分离；
- 全局审核菜谱不绑定 household，但推荐、菜单、库存和采购均绑定 household。

对其他家庭资源统一返回 `404 RESOURCE_NOT_FOUND`，避免确认资源是否存在；已确认在当前家庭内但缺少操作权限时返回 `403 FORBIDDEN`。成员私有饮食约束在家庭隔离之外继续执行字段级授权和 response redaction。

### API 风格与版本

- 使用 HTTPS JSON REST API，路径前缀 `/api/v1`。
- 资源查询使用 `GET`，创建使用 `POST`，局部更新使用 `PATCH`；状态迁移可使用明确 command 子资源。
- 成功响应为 `{ ok: true, data, meta }`，`meta` 至少含 `requestId`。
- 错误使用 RFC 9457 风格的 `application/problem+json` 根对象，并增加稳定的 `code`、`requestId`、`retryable` 和 `ok: false`。
- 列表使用 opaque cursor pagination，不使用跨更新易漂移的 page number/offset 作为正式契约。
- 同一 v1 内只做兼容性新增；字段删除、重命名、必填性收紧、状态语义改变或 ID 语义改变进入 `/api/v2`。
- `@meal-agent/contracts` 独立按 semantic versioning 发布；API major 和 package major 分别管理，但 breaking API change 必须提升两者相应 major。
- OpenAPI 在阶段 06 从路由和共享 schema 生成，不维护平行手写 DTO。

### 鉴权错误与稳定语义

稳定错误码和 HTTP status 映射由 `packages/contracts/src/api.ts` 管理。关键映射：

| 场景 | HTTP | code |
| --- | --- | --- |
| 请求结构不合法 | 400 | `VALIDATION_FAILED` |
| 无会话 / 会话失效 | 401 | `AUTHENTICATION_REQUIRED` / `SESSION_EXPIRED` |
| 家庭内权限不足 | 403 | `FORBIDDEN` |
| 资源不存在或属于其他家庭 | 404 | `RESOURCE_NOT_FOUND` |
| 版本、数量或幂等冲突 | 409 | 对应稳定 conflict code |
| 安全规则阻断 | 422 | `SAFETY_BLOCKED` |
| 外部微信/模型等依赖不可用 | 503 | `EXTERNAL_DEPENDENCY_UNAVAILABLE` |

数据库、微信和模型原始错误不得原样返回。批量操作只有在 contract 明确逐项结果时才能返回部分成功；任何未完成操作都不能显示为完整成功。

### 幂等与并发

所有可能创建领域事件或推进业务状态的写 command 必须带 `Idempotency-Key`。token 签发和撤销不使用通用 response replay：服务端不为重放而持久化明文 token；登录网络失败时客户端重新调用 `wx.login` 获取新 code，User/AuthIdentity 映射仍保持唯一。服务端把业务幂等的以下值作为作用域：

```text
user_id + household_id + HTTP method + normalized route + idempotency_key
```

行为：

1. 同作用域、同 key、同 request hash：返回第一次的 status/body，并标记 `meta.idempotency.replayed = true`。
2. 同作用域、同 key、不同 request hash：返回 `409 IDEMPOTENCY_KEY_REUSED`。
3. 首次请求的幂等记录、领域写入、InventoryEvent 和投影更新在同一事务提交。
4. 并发相同 key 只能有一个执行者，其他请求等待并重放结果。
5. 通用幂等响应记录不得包含 token、provider identifier 或私有约束，至少保留 30 天；库存和采购事件上的幂等唯一约束随事件长期保留。
6. 客户端重试必须复用原 key，不得为同一用户动作生成新 key。

实体并发使用 `expectedVersion` 乐观锁。库存事件只有在当前 lot version 与 `expectedLotVersion` 相同、且扣减后不会为负时才追加；冲突返回最新版本摘要，由客户端重新确认。纠错通过新的 `corrected` 事件引用原事件，不改写或删除历史事件。

## 备选方案

### 直接使用 `openid` 作为 User ID：拒绝

它只在特定 AppID 范围内稳定，不能表达多 provider、多 AppID、账号关联或独立内部生命周期，也会把平台标识传播到所有业务表。

### `unionid` 自动合并账号：拒绝

UnionID 的可用条件依赖微信开放平台配置。错误或不完整信号造成的账号误合并难以逆转，必须走显式、可审计的关联流程。

### JWT access token：暂不采用

JWT 适合多个服务离线验证，但当前是单体。把角色/家庭放入 JWT 会造成撤销和权限陈旧；只放 user ID 又没有减少 session store。未来若出现独立服务可通过新 ADR选择短期 JWT + 中央撤销策略。

### 只做应用层 `WHERE household_id = ?`：拒绝

应用过滤仍是主授权路径，但一次漏写即可越权。复合外键和 RLS 提供独立防御，代价由统一事务/context helper 和集成测试控制。

### GraphQL：暂不采用

当前 P0 是明确的资源和 command 流程，REST 更容易表达 HTTP status、幂等、缓存和审计。没有复杂跨图查询证据支持引入 GraphQL schema 和 resolver 权限面。

## 影响

### 收益

- 平台身份、内部用户、家庭权限、用餐档案和会话各自有清晰生命周期；
- 多家庭和未来登录方式不需要更换核心主键；
- 家庭隔离由应用授权、复合约束和 RLS 多层执行；
- 重试、重复点击和工具调用不会重复创建库存事件；
- 客户端能依赖稳定错误码而不解析文案。

### 成本与风险

- RLS 与连接池必须在事务中正确设置和清理上下文；
- opaque session 需要数据库查询或受控缓存；
- 字段级敏感约束不能只依赖 household RLS，需要显式 response policy；
- 30 天幂等记录会占用存储，需要按域设计归档而不能删除事件唯一性；
- 未来跨服务时可能需要重新设计 token 和服务身份。

## 已决定、待验证与外部依赖

### 已决定

- `AuthIdentity → User → Session/Membership → PersonProfile` 映射；
- opaque session、Bearer 鉴权、显式 Household 路由上下文；
- 应用授权 + 复合外键 + PostgreSQL RLS；
- REST `/api/v1`、统一 result/error、cursor、幂等和乐观版本；
- 库存事件不可变，纠错追加新事件。

### 待验证

- RLS policy、连接池事务上下文和 migration/app role 分离；
- session digest、轮换、过期、撤销和并发登录；
- 幂等表锁、request hash、重放和 30 天清理；
- API contract 到 Fastify/OpenAPI 的单一事实源；
- 私有饮食约束的字段级 redaction。

### 外部依赖

- 测试或正式微信 AppID/AppSecret、code2Session、UnionID 条件和 HTTPS 合法域名；
- 邀请分享落地、测试号真机和多设备会话证据；
- Secret 管理、WAF/限流和生产可观测平台。

## 验证与复审

阶段 06 至少用两个用户、两个家庭证明正向访问和跨家庭拒绝，并覆盖会话过期、成员移除、相同幂等 key 重放、key/body 冲突、库存 version 冲突和负库存阻断。

以下情况触发复审：

1. 新增登录 provider 或多个微信 AppID；
2. 引入独立服务，需要服务间鉴权或离线 token 验证；
3. RLS 导致无法接受的连接池/运维复杂度且有等价隔离证据；
4. API v1 出现不可兼容的字段或状态语义；
5. 法规、微信平台政策或隐私要求改变身份与保留策略。

## 依据

以下资料于 2026-07-23 获取：

- [微信小程序 `wx.login`](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)
- [微信小程序 code2Session](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)
- [微信小程序 UnionID 机制](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/union-id.html)
- [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
