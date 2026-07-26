# 文档导航

文档默认使用中文，并区分“已决定”“已本地验证”“待验证”和 `Deferred — 外部依赖`。

阶段 08 最终审计整改已合并 `main`；FAM-003 已完成，FAM-004/FAM-005 仍为部分完成。阶段 09A **进行中**：M1 容器构建基线已 Accepted，M2A 数据库身份边界待总控复验，M2B—M5 未开始；ADR-0005 仍为 `Proposed`。真实微信、真机、云环境、体验版、发布和远端 CI 不得由本地自动化或模拟器证据替代。

## 当前状态与计划

- [项目状态](project-status.md)
- [阶段 08 原始实施记录](plans/2026-07-stage-08-members-and-constraints.md)
- [阶段 08 审计整改记录](plans/2026-07-stage-08-audit-closeout.md)
- [阶段 09A 本地可部署性计划](plans/2026-07-stage-09a-local-deployability-baseline.md)
- [计划索引](plans/README.md)
- [微信开发者工具走查证据](evidence/stage-08-gui/README.md)
- [依赖例外产物扫描证据](evidence/stage-08-audit/weapp-advisory-scan.json)

## 产品与安全

- [产品简述](product/product-brief.md)
- [MVP 范围](product/mvp.md)
- [App 功能规格](product/app-functional-spec.md)
- [核心用户流程](product/core-user-flows.md)
- [开放决策](product/open-decisions.md)
- [食品安全边界](safety/food-safety.md)

## 设计与架构

- [系统概览](architecture/system-overview.md)
- [后端架构与共享契约](architecture/backend-architecture-and-contracts.md)
- [ADR 索引](architecture/decisions/README.md)
- [ADR-0003：身份、家庭租户与 API 语义](architecture/decisions/0003-identity-tenancy-and-api-semantics.md)
- [ADR-0004：阶段 08 预发布审计整改例外](architecture/decisions/0004-stage-08-pre-release-audit-closeout.md)
- [ADR-0005：本地与私有测试部署基线](architecture/decisions/0005-local-private-deployment-baseline.md)
- [领域数据模型](domain/data-model.md)
- [信息架构](design/information-architecture.md)
- [P0 页面状态基线](design/p0-page-state-baseline.md)

## 工程入口

- [API 工程](../services/api/README.md)
- [客户端工程](../apps/client/README.md)
- [运维说明](operations/README.md)
- [研究资料](research/README.md)
- [Agent 设计](agent/agent-design.md)
