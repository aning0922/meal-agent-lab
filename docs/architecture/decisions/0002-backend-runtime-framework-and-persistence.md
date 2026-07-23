# ADR-0002：后端运行时、Web 框架与持久化基线

- 状态：Accepted
- 日期：2026-07-23
- 负责人：产品负责人、服务端工程
- 支撑材料：[阶段 05：后端架构与共享契约定稿](../backend-architecture-and-contracts.md)

## 背景

阶段 05 需要在尚未实现完整服务端时，为阶段 06 的最小纵切确定正式工程基线。系统包含家庭权限、敏感饮食约束、库存批次与事件、菜单、采购和 Agent 工具调用；其中库存一致性、权限、过敏与食品安全必须由确定性服务和关系数据约束执行。

当前已知约束：

- 正式客户端使用 React/TypeScript，并需要与服务端共享运行时可校验的契约；
- 从模块化单体开始，不为尚未出现的扩缩容需求拆分微服务；
- 家庭、成员、库存和幂等写入需要事务、唯一约束、外键和租户隔离；
- 库存事实使用批次与追加事件，不用一个可覆盖的数量代替历史；
- 需要保留 PostgreSQL 原生约束、事务和 Row Level Security（RLS）的可见性；
- 阶段 04 没有验证真实微信登录、合法域名、离线队列或业务幂等，这些仍是 `Deferred — 外部依赖`，不能由本 ADR 推定通过。

## 决策

### 运行和部署单元

采用 **Node.js 24 LTS + TypeScript 5.9.3**。首个服务端部署单元是 `services/api` 模块化单体，内部按身份与家庭、库存、餐食与推荐、采购等模块分界。Agent 只能通过应用服务暴露的受限工具访问业务状态，不直接连接数据库。

阶段 06 的初始开发环境以本次可执行的 Node.js 24.14.0 为最低 patch 基线；生产和 CI 使用 Node.js 24 LTS 的受支持安全 patch，不跨 major 漂移。Node.js 或 TypeScript major 升级需独立变更和兼容性验证。

### Web 框架

采用 **Fastify 5.x**，阶段 06 初始锁定 5.10.0。选择它的原因是：

- 路由级输入验证和响应序列化以 schema 为核心；
- plugin encapsulation 足以支撑模块化单体，不要求建立框架自有的领域基类；
- 原生 TypeScript、日志和请求生命周期边界清晰；
- 可以在适配层接入 `@meal-agent/contracts` 的 Zod schema，同时保持共享包不依赖 Fastify。

Fastify 与 Zod 的集成方式、Node.js 24 的实际运行组合需要在阶段 06 用启动测试和 HTTP contract test 补证；当前是已接受的工程选择，不是已完成的服务验证。

### 数据库

采用 **PostgreSQL 18.x** 作为唯一事务事实库。新实体 ID 使用 UUIDv7；API 把 ID 当成 opaque string，不允许客户端依赖排序语义。

PostgreSQL 承担：

- 事务、外键、唯一约束、检查约束和乐观版本；
- 家庭数据的复合外键与 RLS 防御层；
- 用户、身份、会话、家庭、库存事件和幂等记录；
- 追加的库存事实事件及可重建的当前库存投影。

Redis、向量数据库、独立事件总线和第二事实库均不进入当前基线。只有出现经观测的缓存、队列或检索需求后才能重新评估。

### 数据访问与迁移

采用 **Drizzle ORM 0.45.x + node-postgres 8.x**；阶段 06 初始锁定 Drizzle ORM 0.45.2、Drizzle Kit 0.31.10 和 `pg` 8.22.0。

约定：

1. Drizzle schema 是服务端数据库映射，不从 `packages/contracts` 反向生成数据库表，也不导出为客户端契约。
2. Drizzle Kit 生成的 SQL migration 必须进入版本控制并人工审查。
3. 预发布和生产只执行已审查 migration，禁止使用 `drizzle-kit push` 直接同步结构。
4. RLS、复合约束、部分索引或其他框架表达不充分的能力使用显式 SQL migration。
5. 多事件写入、幂等记录和投影更新必须在同一数据库事务完成。
6. 破坏性变更采用 expand → migrate/backfill → contract，不依赖自动回滚猜测。

### 共享契约

`packages/contracts` 使用 **Zod 4.4.3 + TypeScript 5.9.3**，schema 是网络边界的事实源，类型由 schema 推导。它不依赖 Fastify、Drizzle、Taro 或数据库驱动。

服务端不得直接把 Drizzle row 当 API response；客户端和服务端不得另建同名核心 DTO。数据库映射、领域聚合和 API contract 是不同边界，通过显式 mapper 连接。

## 备选方案

### 运行时

| 方案 | 优点 | 本阶段结论 |
| --- | --- | --- |
| Node.js 24 LTS + TypeScript | 可直接消费共享 schema/type；客户端与服务端工具链一致；生态和运维成熟 | **选择** |
| Go | 单二进制、并发和静态类型边界清晰 | 当前会引入一套平行契约生成/校验链；尚无性能证据支持新增语言成本，保留为未来高隔离服务候选 |
| Bun / Deno | 启动、内置工具或 Web 标准体验有吸引力 | 不把运行时可移植性当现阶段目标；先使用依赖和团队路径更明确的 Node LTS，后续可做非生产兼容实验 |

### Web 框架

| 方案 | 优点 | 本阶段结论 |
| --- | --- | --- |
| Fastify 5 | schema 驱动、插件边界、低框架侵入 | **选择** |
| NestJS | 完整 DI、模块和常见企业能力 | decorator/class DTO 容易与共享 Zod contract 形成双重事实源；当前模块规模不需要这层框架成本 |
| Hono | 轻量且支持多运行时/edge | 本项目当前需要稳定 PostgreSQL 事务而非 edge 可移植性；保留为薄网关候选 |
| Express | 生态成熟、认知成本低 | 验证、序列化和模块边界需要额外自行组合，正式基线不选 |

### 数据库

| 方案 | 优点 | 本阶段结论 |
| --- | --- | --- |
| PostgreSQL 18 | 事务、约束、RLS、JSON、UUIDv7 与成熟运维能力 | **选择** |
| MySQL 8.4 LTS | 托管覆盖广、关系能力成熟 | 缺少与 PostgreSQL RLS 等价的原生租户防御层；当前没有迁移收益 |
| SQLite | 本地简单 | 多成员并发、RLS 和生产行为差异过大，不作为服务端事实库或集成测试替代 |
| 文档数据库 | 结构演进灵活 | 家庭复合关系、事件一致性与约束更难表达，无采用收益 |

### 数据访问

| 方案 | 优点 | 本阶段结论 |
| --- | --- | --- |
| Drizzle + `pg` | TypeScript schema、SQL-like API、可审查 migration、原生 SQL 逃生口 | **选择** |
| Prisma | 生成式 Client、迁移和开发体验完整 | Prisma schema 会增加另一层模型；RLS/复合约束仍需定制 SQL，当前抽象收益不足 |
| Kysely / 原生 SQL | SQL 控制最直接 | 需要另选完整 schema/migration 方案；如果 Drizzle 阻碍原生能力可复审 |
| Active Record ORM | 快速 CRUD | 隐式生命周期与库存事件/事务边界不匹配 |

## 影响

### 收益

- 客户端和服务端能复用同一运行时 schema 与 TypeScript 类型；
- 事务、权限、库存事件、幂等和 RLS 可以在同一关系数据库完成；
- 模块化单体降低初期部署和跨服务一致性成本；
- SQL migration 可审查，数据库原生能力不会被 ORM 隐藏。

### 成本与风险

- TypeScript 类型不等于运行时验证，所有不可信输入仍必须执行 Zod/Fastify 校验；
- Fastify、Zod 和 JSON Schema 的错误格式需要适配为项目统一错误；
- Drizzle 仍是 0.x 版本线，升级必须锁 patch、阅读变更并跑 migration/contract test；
- RLS 的连接上下文如果设置错误会造成越权或全量拒绝；阶段 06 已用连接复用和漏写 household filter 的集成测试验证事务边界；
- Node.js 24 + Fastify 5 + Drizzle + PostgreSQL 18 已完成本地最小纵切，目标部署平台仍待验证。

## 已决定、待验证与外部依赖

### 已决定

- Node.js 24 LTS、TypeScript、Fastify 5、PostgreSQL 18、Drizzle/`pg`；
- 模块化单体和单一关系事实库；
- SQL migration 审查、事务内幂等与库存事件；
- 共享契约独立于 Web 框架和数据库映射。

### 已由阶段 06 验证

- 精确依赖组合的服务启动、优雅停止和数据库连接；
- Fastify/Zod request/response adapter 与 OpenAPI 生成；
- Drizzle 表达复合外键、事务、RLS session context 和 migration；
- PostgreSQL 18 集成测试和库存并发冲突路径；

### 待验证

- Drizzle 版本升级后的长期可维护性；
- 目标部署平台的连接池、冷启动和 migration job。

### 外部依赖

- 云厂商、托管 PostgreSQL、域名、证书、Secret 管理和可观测平台尚未选择；
- 真实微信 AppID/AppSecret、测试号和合法 HTTPS 域名仍未接入；
- 阶段 04 的真机、分享、体验版、审核和原生平台项继续保持原状态。

## 验证与复审

阶段 06 已完成最小服务启动、PostgreSQL 18 migration、事务、RLS、幂等重放、冲突和 contract test。以下条件触发复审：

1. Fastify/Zod 不能在不复制 schema 的情况下提供可靠验证和序列化；
2. Drizzle 阻碍关键 PostgreSQL 约束、RLS、migration 或诊断；
3. Node.js 24 进入 EOL，或依赖不再支持该 LTS；
4. 单体模块出现明确的独立扩缩容、故障隔离或合规边界；
5. 目标托管平台无法满足 PostgreSQL 18、连接池、备份恢复或数据地域要求。

## 依据

以下资料于 2026-07-23 获取：

- [Node.js Releases](https://nodejs.org/en/about/previous-releases)
- [Fastify LTS policy](https://fastify.dev/docs/latest/Reference/LTS/)
- [Fastify Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [PostgreSQL 18 release](https://www.postgresql.org/about/news/postgresql-18-released-3142/)
- [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)
- [PostgreSQL UUID functions](https://www.postgresql.org/docs/18/functions-uuid.html)
- [Drizzle ORM overview](https://orm.drizzle.team/docs/overview)
- [Drizzle migrations](https://orm.drizzle.team/docs/migrations)
- [Drizzle transactions](https://orm.drizzle.team/docs/transactions)
- [Prisma ORM overview](https://www.prisma.io/docs/orm)
- [Zod 4](https://zod.dev/)
