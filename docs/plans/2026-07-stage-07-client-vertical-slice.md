# 阶段 07：正式客户端纵切实施计划

- 日期：2026-07-24
- 分支：`codex/stage-07-client-vertical-slice`
- 基线：`main` `b7a76ea`（阶段 06 后端纵切与合并前审核修复已合并）
- 状态：已实施（2026-07-24 完成 M1–M5；验收记录见文末；本项目主要决策由 AI 主负责人完成）

## 范围与依据

本阶段建立正式客户端 `apps/client`，并与阶段 06 的 `services/api` 打通第一条端到端真实闭环：

```text
登录（fake adapter）→ 创建/选择家庭 → 库存批次列表 → 手工新增批次
    → exact-only 消耗（含幂等重放与版本冲突处理）
```

依据：

- [ADR-0001](../architecture/decisions/0001-client-platform-and-cross-platform-framework.md)：Taro 4.2.1 + React 18.3.1 + TypeScript 5.9.3，微信小程序优先
- [ADR-0003](../architecture/decisions/0003-identity-tenancy-and-api-semantics.md)：API 语义、幂等、错误契约
- [`@meal-agent/contracts`](../../packages/contracts/README.md) 0.2.0：唯一 DTO 事实源
- [阶段 06 计划](2026-07-stage-06-backend-vertical-slice.md)与 [`services/api`](../../services/api/README.md)：10 个已验证端点
- [P0 页面状态基线](../design/p0-page-state-baseline.md)：本阶段覆盖其适用子集（loading、failure、duplicate submit、conflict、成功回退）

## 实施内容

1. **工程接入**：`apps/client` 加入根 pnpm workspace（区别于阶段 04 spike 的独立锁文件），直接依赖 `@meal-agent/contracts`，禁止出现第二份核心 DTO；CI 扩展覆盖 `apps/client` 的 typecheck/测试/weapp 构建。
2. **平台适配层**：沿用 spike 验证过的端口模式（`AuthPort`/`StoragePort`/`NetworkPort`/导航；页面不直接调用 `wx.*`），但代码全部新写，不从 spike 复制。
3. **业务页面（最小集）**：登录页、家庭创建/切换、库存列表、新增批次表单（exact/approximate/qualitative 三种初始数量）、批次消耗操作。UI 以低保真原型 I-01/I-02、O-01 为参照，不追求视觉完成度。
4. **API 集成语义**：bearer session 存储与过期处理；写操作生成幂等键并在重试时复用；`INVENTORY_VERSION_CONFLICT` 时刷新批次并提示；401/403/404/409/422 按 problem+json 呈现；网络失败可重试。
5. **联调验证**：本地 `services/api`（fake adapter + 临时 PostgreSQL 18）跑通全闭环的自动化集成测试与开发者工具模拟器手工验证。

## 实施顺序

1. **M1 工程接入**：`apps/client` 骨架进根 workspace，依赖 contracts 0.2.0，CI 扩展；平台适配层端口与 fake 实现，页面零直接 `wx.*`。
2. **M2 登录与会话**：对接 `/api/v1/auth/wechat/exchange`（后端 fake adapter），session 存储、过期与 401 重新登录引导。
3. **M3 家庭**：创建（含幂等键）/列表/切换，403/404 语义呈现。
4. **M4 库存**：批次列表、三种初始数量的新增表单、exact-only 消耗，幂等重放与 `INVENTORY_VERSION_CONFLICT` 刷新提示。
5. **M5 收口**：端到端集成测试（本地 `services/api` + 临时 PostgreSQL 18）、删除 `apps/meal-agent-client-spike`、文档与验收记录。

每个里程碑保持可独立提交、可独立验证；M1-M2 完成前不开始 M3+。

## 验收门禁

| # | 门禁 |
| --- | --- |
| 1 | `apps/client` 在根 workspace 内 typecheck/测试/weapp 生产构建全绿，CI 覆盖 |
| 2 | 不存在与 contracts 重复的核心 DTO（复用阶段 05 的一致性扫描） |
| 3 | 页面层零直接 `wx.*`/Taro API 调用（适配层单一触点） |
| 4 | 端到端：登录 → 创建家庭 → 新增批次 → 列表可见 → 消耗成功、重复提交幂等重放、过期版本冲突提示 |
| 5 | 401 会话过期引导重新登录；跨家庭资源 404 不泄露存在性 |
| 6 | 删除 `apps/meal-agent-client-spike`（兑现 ADR-0001 承诺） |
| 7 | 微信真机、真实登录、合法域名继续 `Deferred — 外部依赖`，fake 结果不得记为真实链路 Pass |

## 非范围

菜单推荐、Agent 对话、采购清单、完整做饭流程、成员邀请、语音/条码/OCR、原生平台（Android/iOS/HarmonyOS）、体验版/审核/发布、生产部署。

## 风险

- Taro 4.2.1 固定依赖树带有已知通告（阶段 04 记录）；正式 `apps/client` 需重新评估依赖版本而非照搬 spike 锁文件。
- 小程序网络层与幂等键重试语义需在真机前先以模拟器 + 集成测试验证，真机差异保持 Deferred。

## 验收记录（2026-07-24）

实现提交：M1 `07ef793`（工程接入与平台端口）→ M2 `ce51843`（登录与会话）→ M3 `30f0b91`（家庭）→ M4 `4c45281`（库存）→ M5（E2E、删除 spike、文档）。实现决策：`apps/client` 采用 `core/`（纯 TypeScript 业务流程 + 端口注入，Node 可测）+ `pages/`（薄 UI）+ `platform/`（端口定义与唯一 Taro 触点）分层；直接依赖锁定 ADR-0001 版本，传递依赖由根 lockfile 重新解析，未复用 spike 锁文件。

### 门禁结果

| # | 结果 | 证据 |
| --- | --- | --- |
| 1 | Pass | `pnpm stage07:check` 全绿：contracts/api 全套门禁 + client typecheck、46 个单元测试、weapp 生产构建、13 个 E2E 场景；CI 工作流改为单一 `stage07-check` 作业（Ubuntu + PGDG PostgreSQL 18） |
| 2 | Pass | `apps/client/src` 零 zod schema 定义、零本地核心 DTO；请求/响应模式全部 import 自 `@meal-agent/contracts`（0.2.0），响应含 problem+json 均经契约模式验证 |
| 3 | Pass | `@tarojs/taro` import 仅存在于 `src/platform/taro-adapter.ts`；页面仅依赖 `@tarojs/components`、React 与 core/app-runtime；扫描无 `wx.*` 直接调用 |
| 4 | Pass | E2E（真实 `services/api` + 临时 PostgreSQL 18.4 + fake 微信适配器）：登录 → 创建家庭 → 新增批次 → 列表可见 → exact 消耗成功；创建家庭/新增批次/消耗三处同键重复提交均 `replayed=true` 且不产生第二条记录；`expectedVersion` 过期返回 `INVENTORY_VERSION_CONFLICT` 并由页面刷新提示，超量消耗返回 `INVENTORY_INSUFFICIENT` |
| 5 | Pass | E2E：撤销后旧 token 与伪造 token 均触发 401 → 清会话 + reLaunch 登录页 + 过期提示可消费一次；用户 B 访问用户 A 家庭的批次列表/消耗均得到 404 语义（`householdMissing`/`notFound`），无存在性泄露、无 403 差异化 |
| 6 | Pass | `apps/meal-agent-client-spike` 已随本阶段删除（`git rm`），apps/README 同步更新 |
| 7 | Pass（保持 Deferred） | 微信真机、真实登录、合法域名未验证，保持 `Deferred — 外部依赖`；E2E 与本地联调均为 fake 适配器，未记为真实微信链路 Pass |

### 补充验证

- 三种初始数量端到端保真：exact 十进制字符串金额（`2.50`→`2.5` 归一化）、approximate 数值/单位/置信度/原始描述、qualitative 等级在“客户端 → API → PostgreSQL → 客户端”往返中不丢失、不改精度。
- 非 exact 批次的消耗在客户端本地拒绝，不发请求；approximate 非数字/缺原始描述在本地经契约模式拦截。
- 登录依赖不可用（`fake-dependency-unavailable` → 503）返回可重试失败且不写会话。
- 微信开发者工具模拟器手工验证：本机 IDE 服务端口处于关闭状态（属用户安全设置，AI 不越权修改），CLI/自动化不可用；已提供 `dev:stack` 一键本地栈与手工步骤（见 `apps/client/README.md`），待产品负责人自行执行；该项不影响门禁 1–6 的自动化证据。

### 未解决问题

- 开发者工具模拟器手工走查待产品负责人在开启服务端口后执行（步骤已文档化）。
- 页面层未做 React 渲染级测试：页面保持薄 UI，逻辑全部下沉 `core/`（单元 + E2E 覆盖），weapp 生产构建作为编译门禁；如后续页面复杂化再引入渲染测试。
- Taro 4.2.1 固定依赖树已知通告（阶段 04 已记录）经重新评估处理如下：客户端直接 devDependency `webpack` 升至 5.104.1（构建验证通过；Taro 内部 loader 仍声明 5.91.0 peer，仅告警）。`pnpm audit --prod` 余 9 项（8 moderate + 1 critical）全部位于 Taro 自身锁定路径：moderate 为 webpack-dev-server/esbuild 等本地开发服务器通告（不进入产物）；critical 为 `@tarojs/components>swiper`（GHSA-hmx5-qpq5-p643，H5 端依赖）——已核对 weapp 产物：`dist/taro.js` 仅含微信原生 `<swiper>` 组件名映射，npm `swiper` 包代码未被打包。接受为构建期风险，升级窗口待 Taro 4.3 评估。
