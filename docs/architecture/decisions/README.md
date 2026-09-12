# 架构决策记录

ADR 用于记录影响范围大、迁移成本高或存在明显权衡的技术决定。

## 命名

使用递增编号和短标题，例如：

```text
0001-first-client-platform.md
0002-cross-platform-framework.md
0003-backend-runtime.md
```

状态使用 `Proposed`、`Accepted`、`Superseded` 或 `Rejected`。新决策替代旧决策时保留旧文件并相互链接。

## 当前决策

Stage 09P-M0 的完整 acceptance candidate 为 `186bd2f43695e1136a3a1fc43faa6d6088d9ce54`，ADR-0008 与 M0 已由总控 Accepted；09P 仍为 `In Progress`，本次 M0 收口时 M1 尚未开始。其七模块纯 domain 候选与数据保持完全合成，不包含权威真实 release、真实用户/食品事实或外部能力；Route A TCB 仍由 frozen lockfile、Git review、CI/09A、固定 Node 与独立审计承担，M0 checker 不自证 loader/compiler/runner/worker/supply-chain。

- [ADR-0001：首发客户端平台与跨端框架](0001-client-platform-and-cross-platform-framework.md) — `Accepted`，2026-07-23
- [ADR-0002：后端运行时、Web 框架与持久化基线](0002-backend-runtime-framework-and-persistence.md) — `Accepted`，2026-07-23
- [ADR-0003：身份、家庭租户与 API 语义](0003-identity-tenancy-and-api-semantics.md) — `Accepted`，2026-07-23
- [ADR-0004：阶段 08 预发布审计整改例外](0004-stage-08-pre-release-audit-closeout.md) — `Accepted`，2026-07-25
- [ADR-0005：本地与私有测试部署基线](0005-local-private-deployment-baseline.md) — `Accepted`，2026-08-11
- [ADR-0006：阶段 09A 外部证据与资源所有权协议](0006-stage09a-evidence-ownership-protocol.md) — `Accepted`，2026-08-22
- [ADR-0007：食品知识治理与确定性领域核心](0007-food-knowledge-governance-and-domain-core.md) — `Accepted`（仅规划/架构方向），2026-08-23
- [ADR-0008：Stage 09P-M0 产品证据边界](0008-stage09p-m0-evidence-boundary.md) — `Accepted`（M0 acceptance candidate `186bd2f43695e1136a3a1fc43faa6d6088d9ce54`），2026-08-27
- [ADR-0009：设计门禁的停止谓词与延迟项纪律](0009-review-acceptance-and-deferral-discipline.md) — `Accepted`（停止谓词、内容制延迟准入、里程碑级轮次上限 3 轮/设计线/里程碑、延迟项登记表 `docs/governance/deferral-register.json`），2026-09-12
