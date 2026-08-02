# 文档导航

文档默认使用中文，并区分“已决定”“已本地验证”“待验证”和 `Deferred — 外部依赖`。

阶段 08 最终审计整改已合并 `main`；FAM-003 已完成，FAM-004/FAM-005 仍为部分完成。阶段 09A **进行中**：M1 容器构建基线已 Accepted；M2A 数据库身份边界的 **R8A 只读 projector** 已由项目总控 **Accepted**，验收落点 `ca65275`。R8A 只交付可观察性——canonical projector 是纯 SELECT，因此 ACL 全主体覆盖、default privilege 叠加语义与类型/Large Object 三项在 R8A **只做到可观察，收敛属于 R8B**。**R8B 已由项目总控 Accepted**：类型/Large Object 的既定策略已落实，projector 已接入 verify/converge，静态 grantee 名单已删除，`currentDefaultCte` 的整套 default privilege 缺陷（COALESCE 伪叠加、空 global 行语义、S→s）已统一替换，两个 adapter 已重新生成并复验。**M2A 整体已由项目总控 Accepted，验收落点 `5e480803`**；**M2B（Compose 拓扑）已由项目总控 Accepted，验收落点 `d0f2219`**——local-test Compose 拓扑与静态门禁已实现并取得实测证据（**M2B 的 Accepted 只覆盖拓扑本身**；完整 bootstrap 链与全栈启动的证据由 M3B 交付，见下）。**M3A（配置与 Secret file 消费核心）已由项目总控 Accepted，验收落点 `a839df1`**：`DATABASE_URL`/`DATABASE_URL_FILE` 与三对 `MEAL_AGENT_*_PASSWORD` 的互斥来源解析、fail-closed 的 secret file 判据、连接串核心字段必须全部来自 URL、URL 无法覆盖的 8 个 ambient `PG*` 逐条拒绝、无默认值的部署阶段与暴露级别、官方 code2Session endpoint 收紧、中央 logger 脱敏边界与全响应安全头均已落地并有反向测试。**M3B（环境模板、八份 Secret 的生成与交叉一致性、完整 bootstrap 链、`/readyz=200` 与网络隔离实证）已取得完整 bootstrap/full-stack 本地证据，但尚未 Accepted；未完成的是 M4/M5 与 09A 总验收**：Compose Secret 的容器内 UID/mode 探针、单一来源生成与部署前预检、从空 volume 起的十步链全部真实退出码 0、migrate/grants 二次运行幂等、`/healthz=200`/`/readyz=200`、runtime 最小权限、containment 扫描与宿主动态隔离均取得实证并有 75 cases（1 个正向 baseline + 74 个反例/边界检查）、M3B targeted negative suite 的 37 cases、15 项拓扑变异反例与 5 个信号窗口（经多轮对抗审计与总控整改后的定点修复：每轮唯一 image tag 与 immutable ID 绑定、真实信号窗口的零残留、Docker 证据 fail closed、git index 扫描、带 zone 的 IPv6 实证、cleanup 的 inode ownership、生产忙等钩子删除、任意 scheme 与解码后 query key 的模板凭据扫描、one-shot ExitCode fail-closed、整串 stderr 的「不存在」判据、门禁输出边界），未自行标记 Accepted；M4、M5 未开始。阶段 09A 仍为 In Progress，ADR-0005 仍为 `Proposed`，PR #1 保持 Draft。**备份恢复与阶段总门禁仍未取得证据，阶段 09A 不得记为 Pass。**文档中的「目标设计」与「已实现事实」分节表述，不得互相冒充。真实微信、真机、云环境、体验版、发布和远端 CI 不得由本地自动化或模拟器证据替代。

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
