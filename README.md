# Meal Agent Lab

面向家庭的餐食决策与厨房库存 Agent。项目目标不是单纯生成菜谱，而是围绕家庭成员、食材批次、保质状态、菜单推荐、采购协作和烹饪反馈形成闭环。

## 当前阶段

项目已完成阶段 05 后端架构与共享契约定稿。客户端由 [ADR-0001](docs/architecture/decisions/0001-client-platform-and-cross-platform-framework.md) 确定微信小程序优先，采用 Taro 4.2.1 + React 18.3.1 + TypeScript 5.9.3；后端由 [ADR-0002](docs/architecture/decisions/0002-backend-runtime-framework-and-persistence.md) 和 [ADR-0003](docs/architecture/decisions/0003-identity-tenancy-and-api-semantics.md) 确定 Node.js 24/Fastify 模块化单体、PostgreSQL 18/Drizzle、内部身份与家庭租户边界。

仓库已有正式 [`@meal-agent/contracts`](packages/contracts/) 契约基线，但尚未实现完整业务服务或正式 App。阶段 04 的真实微信登录、合法域名、真机、体验版/发布和原生平台项仍保持 `Deferred — 外部依赖`。

优先验证的核心闭环：

1. 创建家庭并录入必要的成员约束。
2. 快速记录 5–10 个当前食材。
3. 根据人数、时间、厨艺和临期状态给出可执行菜单。
4. 把缺少的食材加入共享采购清单。
5. 做完后确认消耗并更新库存。

## 仓库结构

```text
apps/        面向用户或运营人员的客户端
services/    API、Agent 编排和异步任务服务
packages/    跨应用共享的领域、契约、配置与 UI 包
ai/          可版本化的提示词、策略、评测和合成样本
docs/        产品、架构、领域、安全、设计和运维文档
assets/      品牌、图标、图片与原型等非代码资源
data/        食材、菜谱、保质期等可追溯数据资产
infra/       本地开发、部署和环境基础设施
scripts/     可重复执行的开发与数据脚本
tests/       跨模块、端到端、安全与固定测试数据
```

详细导航见 [docs/README.md](docs/README.md)，协作规则见 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发原则

- 先验证产品闭环，再扩大平台和功能范围。
- 共享业务规则，不强求所有平台 100% 共用 UI 代码。
- 大模型负责理解和解释；库存、权限、过敏与日期判断由确定性系统负责。
- 提示词、模型策略和评测用例与代码一样进行版本管理和审查。
- 食材日期和推荐结果必须保存来源、假设和置信度。
- 不提交个人数据、密钥、未确认授权或来源不明的数据集。

## 下一步

阶段 06 只实施“登录 → 创建/读取家庭 → 手工新增库存批次 → 幂等重放”的最小服务端纵切，验证 session、家庭隔离、RLS、批次事件、冲突与日志脱敏。明确范围见[阶段 05 报告](docs/architecture/backend-architecture-and-contracts.md#10-阶段-06最小服务端纵切)。

账号、域名和设备条件具备时补证真实微信登录与 HTTPS 合法域名；家庭内测前验证体验版，发布候选阶段验证审核和发布链。Android、iOS、HarmonyOS 在各自开发开始前单独实验。
