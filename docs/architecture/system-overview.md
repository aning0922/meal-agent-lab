# 系统概览

## 状态

客户端平台决策已由 [ADR-0001](decisions/0001-client-platform-and-cross-platform-framework.md) 接受：微信小程序首发，使用 Taro 4.2.1、React 18.3.1 和 TypeScript 5.9.3。Android、iOS、HarmonyOS 仍需逐端 spike。

后端基线已由 [ADR-0002](decisions/0002-backend-runtime-framework-and-persistence.md) 和 [ADR-0003](decisions/0003-identity-tenancy-and-api-semantics.md) 接受：Node.js 24 LTS + Fastify 5 模块化单体，PostgreSQL 18 + Drizzle/`pg`，使用 opaque session、显式家庭上下文、复合外键与 RLS。

当前没有完整业务服务或正式 `apps/client`。正式代码只有 [`packages/contracts`](../../packages/contracts/) 共享契约基线；[`apps/meal-agent-client-spike/`](../../apps/meal-agent-client-spike/) 仍是一次性阶段 04 实验。

## 逻辑边界

```text
客户端页面 / view-model ── 上下文 Agent 入口
          │
    语义化平台端口
          │
微信 Taro Runtime / 后续原生 Runtime
          │
   HTTPS REST /api/v1
          │
services/api（模块化单体）
├─ 身份与会话
├─ 家庭、成员与权限
├─ 库存批次与事件
├─ 餐食、菜谱与推荐
├─ 采购清单
└─ 受限 Agent 工具
          │
 PostgreSQL 18（唯一事实库）
```

## 工程边界

```text
apps/*                  客户端与运营界面
    │
    ├── consume ──> packages/contracts <── consume ──┐
    │                                                │
    └── platform ports                        services/api
                                             ├─ transport
                                             ├─ application modules
                                             ├─ deterministic domain rules
                                             └─ persistence adapters
```

- `packages/contracts` 导出运行时 schema 和推导类型，不依赖 Taro、Fastify、Drizzle 或 Node 内建模块。
- 服务端数据库 row、内部领域聚合和 API contract 分开，通过显式 mapper 转换。
- 业务模块不依赖 Fastify request/reply；route handler 不直接写 SQL。
- Agent 不直接连接数据库，只能调用复用同一鉴权、权限、幂等与安全校验的应用服务。
- `services/agent` 和 `services/worker` 当前不是独立部署单元。

## 核心数据与安全原则

- `AuthIdentity → User → Session/Membership → PersonProfile` 分层；微信 `openid` 不是内部 User ID。
- 已认证但未绑定家庭的路由使用 `AuthenticatedUserContext`；家庭资源只能在事务内通过 active Membership bootstrap 为 `HouseholdContext`。
- Household 是数据隔离边界，每个家庭资源同时使用应用授权、`household_id`、复合外键和 PostgreSQL RLS。
- 成员私有饮食约束另做字段级 response redaction，不能只依赖家庭 RLS。
- 创建家庭结果使用安全 owner profile 契约，`subject_and_owner` 约束不得进入响应或幂等缓存。
- InventoryLot 是批次与当前投影，InventoryEvent 是不可变库存事实；纠错追加事件。
- 初始 `acquired` 事件按 canonical quantity mapping 保存 kind、amount/unit 与置信信息，必须能重建批次当前数量。
- 日期保留类型、来源、置信度和规则版本；购买日期不能替代生产日期。
- 创建家庭使用用户级幂等，家庭资源使用家庭级幂等；幂等记录、领域写入、库存事件和投影在同一事务提交。
- 过敏、权限、食品安全和库存一致性由确定性规则、应用服务和数据库约束执行。

## 环境

local、test、staging 和 production 使用独立数据库、Secret、微信配置、域名和数据集。local/test 默认 fake 外部适配器和合成数据；staging/production 禁止共享凭据或复制真实用户数据到低环境。

云厂商、托管数据库、域名、Secret 管理和可观测产品仍**待验证**。具体矩阵见[阶段 05 后端架构与共享契约](backend-architecture-and-contracts.md#8-环境边界)。

## 当前验证证据

### 已验证

- 阶段 04：Taro 4.2.1 微信小程序构建、开发者工具模拟器页面/导航、本地写入和本机 Mock API；
- 阶段 04：`AuthPort`、`StoragePort`、`NetworkPort` 自动测试与 Mock 登录；
- 阶段 05：`@meal-agent/contracts` 类型检查、10 个运行时契约测试和声明/JavaScript 构建；
- 阶段 05：User、Household、Membership、PersonProfile、InventoryLot/Event、Meal/Recipe/Recommendation、ShoppingItem 和通用 API 契约已形成同一事实源。

### 待验证

- Node.js 24 + Fastify 5 + Drizzle + PostgreSQL 18 的本项目服务纵切；
- session digest/撤销、RLS、复合外键、幂等重放和库存并发；
- shared contract 到 Fastify/OpenAPI 的单一 schema 适配；
- 四环境实际基础设施、migration、备份恢复和监控。

### Deferred — 外部依赖

- 微信测试号真机、真实登录、合法域名、邀请分享；
- 体验版、审核、发布和 CI 上传凭据；
- Android、iOS、HarmonyOS 构建与实机；
- 生产云资源、正式 AppID/AppSecret 和生产域名。

上述 Deferred 项均保持阶段 04 原状态，没有因架构定稿而转为 Pass。

## 下一纵切

阶段 06 只实施：登录 → 创建/读取家庭 → 手工新增一个库存批次 → 相同幂等请求返回同一结果 → 追加一个 exact-only 最小 consumed 事件。最后一步只用于验证乐观锁与负库存阻断，不接受 estimated 数量，也不是完整做饭扣减流程。明确 endpoint、migration、测试门禁和非范围见[阶段 06 最小服务端纵切](backend-architecture-and-contracts.md#10-阶段-06最小服务端纵切)。
