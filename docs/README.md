# 文档导航

文档默认使用中文，并区分“已决定”“已本地验证”“待验证”和 `Deferred — 外部依赖`。

**当前 M5.12 封闭能力入口/canonical report input 整改（2026-08-21，覆盖下方历史轮次）**：M5.11 候选 `8bfbf54` 的独立审计 A=BLOCK、B=CLEAN；动态 14/14 有效，但 A 的 4 个 P1 与 1 个 P2 命中同轮声明的静态能力和输入边界，因此综合仍为 BLOCK。总控按 [M5.12 任务书](plans/2026-08-m5-12-closed-capability-and-canonical-input.md)把 production module/dynamic import 改成封闭面，限制受保护模块的 process/global 属性，删除 object-shaped report environment 与调用方 gate/accounting 输入，并把七类 value flow mutation 拆成精确理由反例。固定 Node.js `v24.18.0` 的 scripts tests 为 **208/208**、production guard 28/28、Audit-B 16/16；提交态候选已从步骤 1 通过 `stage09a:check` **14/14**、Markdown links 76/311 与 scoped 零残留复核。**M5.12 Implementation complete — committed-candidate gate PASS, pending independent A/B review；M5 未 Accepted；09A 未 Pass；远端 CI 无真实 run。**完整门禁只承认对应最终提交产生后的实测。

**历史 M5.6（2026-08-20，已被 M5.7 覆盖）**：[M5.6 任务书](plans/2026-08-m5-6-structural-exit-and-consumer-convergence.md)的 runtime learned ID 与初版结构化退出实现仍保留；其最终独立审计结论为 A=BLOCK，B 因平台 cybersecurity `systemError` 无有效报告，不能作为 CLEAN。

**历史 M5.5（2026-08-19，已被 M5.6 覆盖）**：[M5.5 任务书](plans/2026-08-m5-5-final-settlement-and-live-consumer-guards.md)的实现提交 `5b3f9b3` 曾通过 scripts tests 167/167；最终文档候选 `72b75db` 的 A/B 审计均为 BLOCK，且其 committed tracked-file baseline 不匹配，所以不能沿用当时的 14/14 作为最终候选证据。

**历史 M5.4（2026-08-19，已被 M5.5/M5.6 覆盖）**：[M5.4 任务书](plans/2026-08-m5-4-final-state-signal-guard-convergence.md)保留当时的实现与正向证据；后续审计结论和当前状态以上方 M5.6 段落为准。

阶段 08 最终审计整改已合并 `main`；FAM-003 已完成，FAM-004/FAM-005 仍为部分完成。阶段 09A **进行中**：M1 容器构建基线已 Accepted；M2A 数据库身份边界的 **R8A 只读 projector** 已由项目总控 **Accepted**，验收落点 `ca65275`。R8A 只交付可观察性——canonical projector 是纯 SELECT，因此 ACL 全主体覆盖、default privilege 叠加语义与类型/Large Object 三项在 R8A **只做到可观察，收敛属于 R8B**。**R8B 已由项目总控 Accepted**：类型/Large Object 的既定策略已落实，projector 已接入 verify/converge，静态 grantee 名单已删除，`currentDefaultCte` 的整套 default privilege 缺陷（COALESCE 伪叠加、空 global 行语义、S→s）已统一替换，两个 adapter 已重新生成并复验。**M2A 整体已由项目总控 Accepted，验收落点 `5e480803`**；**M2B（Compose 拓扑）已由项目总控 Accepted，验收落点 `d0f2219`**——local-test Compose 拓扑与静态门禁已实现并取得实测证据（**M2B 的 Accepted 只覆盖拓扑本身**；完整 bootstrap 链与全栈启动的证据由 M3B 交付，见下）。**M3A（配置与 Secret file 消费核心）已由项目总控 Accepted，验收落点 `a839df1`**：`DATABASE_URL`/`DATABASE_URL_FILE` 与三对 `MEAL_AGENT_*_PASSWORD` 的互斥来源解析、fail-closed 的 secret file 判据、连接串核心字段必须全部来自 URL、URL 无法覆盖的 8 个 ambient `PG*` 逐条拒绝、无默认值的部署阶段与暴露级别、官方 code2Session endpoint 收紧、中央 logger 脱敏边界与全响应安全头均已落地并有反向测试。**M3B（环境模板、八份 Secret 的生成与交叉一致性、完整 bootstrap 链、`/readyz=200` 与网络隔离实证）已于 2026-08-11 Accepted，验收落点 `cf43452`**：Compose Secret 的容器内 UID/mode 探针、单一来源生成与部署前预检、从空 volume 起的十步链（8 个 one-shot 真实退出码 0，postgres 与 api 两个服务 healthy）、migrate/grants 二次运行幂等、`/healthz=200`/`/readyz=200`、runtime 最小权限、containment 扫描与宿主动态隔离均取得实证并有 75 cases（1 个正向 baseline + 74 个反例/边界检查）、M3B targeted negative suite 的 69 cases、15 项拓扑变异反例、5 个确定性进程组回归与 5 个真实信号窗口（经多轮对抗审计与总控整改后的定点修复：每轮唯一 image tag 与 immutable ID 绑定、真实信号窗口的零残留、Docker inspect/image/history 与 Compose resolved config 成功证据的深层 shape、identity、完整性与非空判据，以及 tracked template / 全仓 containment / Compose topology 三条生产路径的 canonical Git 扫描面 fail closed、nested/prose/comment 视图的 split-stem 扫描、带 zone 的 IPv6 实证、cleanup 的 inode ownership 与 scoped cleanup residue/非法返回/异常语义、受控进程组的 mutation-closed 有界收敛、生产忙等钩子删除、任意 scheme 与解码后 query key 的模板凭据扫描、one-shot ExitCode fail-closed、整串 stderr 的「不存在」判据、门禁输出边界）。**M4（生命周期、备份和恢复）已于 2026-08-11 Accepted，验收落点 `f671c51`；M5（门禁、CI 与文档）候选 `38f172d` 经两路独立复审仍为 BLOCK，第二轮定点整改已落在 `1689f1b` 并通过主工作树 `pnpm stage09a:check` 14/14，当前等待该新候选独立 A/B 复审，仍未 Accepted；API runtime image 扫描与 9 built + 2 static-only 变异反例已包含在同一聚合链内，GitHub Actions action 固定到 commit SHA 并复用同一命令（无真实远端 run，只登记已配置），依赖例外显式复核不续期。**阶段 09A 仍为 In Progress，ADR-0005 已凭真实容器证据转 `Accepted`，PR #1 保持 Draft。**09A 总验收未完成，阶段 09A 不得记为 Pass。**文档中的「目标设计」与「已实现事实」分节表述，不得互相冒充。真实微信、真机、云环境、体验版、发布和远端 CI 不得由本地自动化或模拟器证据替代。

**当前 M5 更新（2026-08-15，覆盖上段旧 M5 句）**：第九轮候选 `4a72218` 的 A/B
独立审计仍为 BLOCK；第十轮实现落点 `3849bbd` 已关闭同步 spawn/stdin/timer-clear
primitive 的 cleanup-before-settlement、backup transfer cleanup 失败后的 formal artifact 回滚、
promotion link→lstat inode 所有权、Compose nested build/healthcheck 能力，以及 topology、
Group E image evidence 与 Secret identity probe 的非可信输出边界。纯 Node 脚本回归
83/83、topology 27/27、M3B targeted 69/69、local-test 75/75、signal 5 个确定性 +
6 个真实窗口、八份 Secret identity 与真实 restore drill 已通过；含文档候选
`a8ad0b2` 的新 HEAD 已从头通过完整 `pnpm stage09a:check` **14/14**。M5 未 Accepted、
09A 未 Pass、远端 CI 无真实 run；下一门禁仍是全新 A/B 独立只读复审。

**Round 11 当前更新（2026-08-15，覆盖上段 Round 10 状态）**：Round 10 候选
`df4a378` 的两路独立审计均为 BLOCK；Round 11 实现落点 `9469bc9` 已将 Compose
`build`/`healthcheck` 收紧到逐服务能力闭集、将 `imageIdOf` 收紧到单行 canonical
SHA-256、将 Secret identity stdout 收紧为精确 record/path/字段协议，并把
cleanup-before-settlement 断言移到 rejection settle 的当下（另有 early-settlement mutant
证明判别力）。README 的 topology/runtime-image mutation 数现在由 registry integrity
与可执行脚本硬计数机械比对。脚本测试 **85/85**、topology mutation **29/29**，同一
实现落点已串行通过 `pnpm stage09a:check` **14/14**。M5 仍未 Accepted、09A 未 Pass、
远端 CI 无真实 run；下一门禁是两个全新独立只读 A/B 审计。

**Round 12 cycle 1 整改更新（2026-08-16，覆盖上段 Round 11 状态）**：候选
`09d883f` 的两个全新独立 A/B 审计均为 BLOCK；当前总控按生产根因归并后只追加
`cd86c12`、`67c3aad` 与 `03e5e41`。resolved Compose 现在固定 project name、
network/volume/logging 与逐服务能力闭集；Docker build/scan/cleanup、M4 one-shot/stop、
backup/restore 和信号窗口均绑定 immutable identity 与有界 settlement。完整链第一次抓到
中断 build 的 tag 所有权缺口，第二次又抓到“退出后再 `docker exec` 取源摘要”这一不成立
的 backup 证据；两项都先修回归再从步骤 1 重跑。最终脚本测试 **99/99**、topology
mutation **39/39**、runtime image mutation **1 baseline + 12 built + 2 static-only**、
targeted **69/69**、local-test **75/75**、signal **5+6** 均通过；同一落点已从头串行
通过 `pnpm stage09a:check` **14/14**。M5 仍未 Accepted、09A 未 Pass、远端 CI 无
真实 run；下一门禁是 cycle 2 的两个全新独立只读 A/B 审计。

上段所称 Docker 证据的“深层 shape、identity 与完整性”只适用于
inspect/image/history；resolved Compose config helper 只证明命令成功且 stdout 是
非空字符串，结构与拓扑语义仍由独立 Compose 门禁验证。

> `08da379`、`c8d7236` 与 `f9997b0` 的复验都给出 **BLOCK**。`f9997b0` 由两路独立
> 审计与项目总控三方同指：Round 20 修复外层 closing quote 空占位时，把 compact
> 路径**未验证的假设**（只看「键前面是引号」，没证明那是本赋值的**开**引号）
> 一起搬到了 legacy 路径，造成 280 格 fail-open 净新增漏检。`77d5997` 又被三方判
> **BLOCK**：wrapper 守卫的字符类写成 ASCII-only，与本文件对 identifier 的定义
> （`\p{L}\p{N}_`）不一致，Node 真实会建立的非 ASCII 尾活键整族放行；另有两道
> 理由已失效的冗余限制造成非跨越标点键漏检。`76025a3` 两路审计分裂（一路 CLEAN、一路 BLOCK），总控双向复现后仍判
> **BLOCK**：嵌套引号内的 `#` 被当成注释起点（864 格，跨三轮未闭合），以及词元层
> 缺 `endsWith` 导致 `PGPASSWORD_OLD=` 这类主面活凭据整族漏检。Round 24 改用**绝对面普查**
> （`node --env-file` 为唯一 oracle），根因是四条部分
> 重叠的判定路径，覆盖面是它们特性的并集而非一份被规定的文法。处置是**登记而不是
> 假装闭合**：新增常驻普查门禁把当前表面逐族钉死，并**收窄 M3B 的验收表述**——
> tracked 模板扫描器是尽力而为的第二层网，主面存在已登记的未闭合族；扫描器重构
> 单列里程碑放在 09A 收口之后。M3B 已于 2026-08-11 Accepted，验收落点 `cf43452`。

## 当前状态与计划

- [项目状态](project-status.md)
- [阶段 08 原始实施记录](plans/2026-07-stage-08-members-and-constraints.md)
- [阶段 08 审计整改记录](plans/2026-07-stage-08-audit-closeout.md)
- [阶段 09A 本地可部署性计划](plans/2026-07-stage-09a-local-deployability-baseline.md)
- [阶段 09A M5.4 最终状态、信号交付与生产 guard 收敛](plans/2026-08-m5-4-final-state-signal-guard-convergence.md)
- [阶段 09A M5.5 最终结算与活生产消费者 guard 收敛](plans/2026-08-m5-5-final-settlement-and-live-consumer-guards.md)
- [阶段 09A M5.6 结构化退出与生产消费者收敛](plans/2026-08-m5-6-structural-exit-and-consumer-convergence.md)
- [阶段 09A M5.7 审计协议与最终 settlement 收敛](plans/2026-08-m5-7-audit-protocol-and-final-settlement.md)
- [阶段 09A M5.8 声明身份与动态审计证据闭合](plans/2026-08-m5-8-declaration-and-audit-evidence-closure.md)
- [阶段 09A M5.9 结构化阶段门禁核心与显式命令面整改](plans/2026-08-m5-9-structured-stage-gate-core.md)
- [阶段 09A M5.10 运行 receipt、能力面与安全诊断闭合](plans/2026-08-m5-10-receipt-and-capability-closure.md)
- [阶段 09A M5.11 能力引用闭包与 Audit-B 静默边界整改](plans/2026-08-m5-11-capability-and-audit-boundary-convergence.md)
- [阶段 09A M5.12 封闭能力入口与 canonical report input 整改](plans/2026-08-m5-12-closed-capability-and-canonical-input.md)
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
- [ADR-0006：阶段 09A 外部证据与资源所有权协议](architecture/decisions/0006-stage09a-evidence-ownership-protocol.md)
- [领域数据模型](domain/data-model.md)
- [信息架构](design/information-architecture.md)
- [P0 页面状态基线](design/p0-page-state-baseline.md)

## 工程入口

- [API 工程](../services/api/README.md)
- [客户端工程](../apps/client/README.md)
- [运维说明](operations/README.md)
- [研究资料](research/README.md)
- [Agent 设计](agent/agent-design.md)
