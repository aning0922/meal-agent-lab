# 阶段 07：正式客户端纵切实施计划

- 日期：2026-07-24
- 分支：`codex/stage-07-client-vertical-slice`（待建）
- 基线：`main` `b7a76ea`（阶段 06 后端纵切与合并前审核修复已合并）
- 状态：**草案 — 待产品负责人批准后冻结**

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

## 验收门禁（草案）

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
