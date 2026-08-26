# Stage 09P-M1：外部审核与首发就绪计划

- 状态：Preparation S1-R1 candidate；独立 Design Review 已对 exact anchor
  `07839f11ba3466bcc9fd1981df844df5359b4887` 报告 CLEAN，等待 tracked-file 总控复核
- 日期：2026-08-27
- 冻结基线：`1a66015e63ac84c6257be46a36c5c5967ee53f20`
- 有界修订 anchor：`915f8bf5a207211155aecda448be52b36bd0072a`
- 分支：`codex/stage-09p-m1-readiness`
- 决策：[ADR-0009：Stage 09P-M1 发布权限与外部审核边界](../architecture/decisions/0009-stage09p-m1-release-authority-boundary.md)
- 上位规划：[阶段 09P：安全知识治理与确定性产品核心闭环](2026-08-stage-09p-safe-deterministic-product-core.md)

本计划只交付可独立审查的 readiness contract 和 preparation pack，不发布真实知识。
当前没有具体外部 authority 或真实 source/license inventory，因此所有真实槽位保持
`UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION`，M1 尚未 Implemented/Accepted。

## 1. 本轮目标与停止面

本轮目标是让下一位独立 Design Reviewer 能机械回答：谁有权签署、每条来源必须记录
什么、何时 fail closed、首发 activation 由哪些独立证据解锁，以及未来 synthetic gate
需要证明什么。

首轮 preparation design 只允许：

```text
docs/architecture/decisions/0009-stage09p-m1-release-authority-boundary.md
docs/plans/2026-08-stage-09p-m1-release-readiness.md
docs/architecture/decisions/README.md
docs/plans/README.md
docs/README.md
docs/project-status.md
```

本次有界合同修订只允许：

```text
docs/architecture/decisions/0009-stage09p-m1-release-authority-boundary.md
docs/plans/2026-08-stage-09p-m1-release-readiness.md
```

除上述 6 个文件外全部 frozen。不得写 `data/**` 模板、scripts、tests、product、contracts、
domain、API、DB、migration、client、OpenAPI、lockfile、09A 冻结面或看板；不得建立真实
authority/source record、`licenseStatus=approved` 记录、active release 或 M2 资产。
对本次有界修订，上述 6 文件中的其余 4 个索引/状态文件也 frozen，不得写入。

Design Review CLEAN 后的 S1-R1 由单独 authority 精确允许 11 个文件：根脚本入口；domain
既有 `types/validation/index` 三模块；一份 targeted test；一份 empty template；两支短脚本；
ADR、本计划与项目状态。其余文件仍 frozen，production 仍严格只有七模块。S1-R1 不改变
上述历史 docs-only 两轮的范围事实，也不授权 09A baseline、真实内容或 activation。

禁止网络搜索/抓取、Docker/Compose、凭据、云/公网/真实微信、付费资源、push/merge/PR，
也不得用模型/搜索结果升级 source tier。命中范围扩大、需要不同 docs-only 文件集合或
无法保持外部角色为空时，结论必须为 `M1 ARCHITECTURE BLOCKED`，停止写入。

## 2. Readiness pack（仅合同）

### 2.1 Authority registry readiness

按 ADR-0009 §2 审核字段完整性，并保持以下首发槽位全空：

```text
Knowledge Data Steward              UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
Allergen/Safety Data Steward        UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
Product Policy Steward              UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
Food Safety Steward                 UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
Culinary Content Steward            UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
Domain Owner                        UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
Product Owner                       UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
External Food Safety Reviewer       UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
Safety Approver                     UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
Legal/Compliance/License Reviewer   UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
Cultural/Ethical Reviewer           UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
Recipe QA                           UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION
```

Design Review 只检查槽位、责任、独立性、冲突和替补规则是否完整，不得把空槽位当成
“审核已完成”。任何身份、资格或责任接受证据都必须在未来单独任务中由具体人类提供。

### 2.2 Source inventory readiness

Design Review 逐字段核对 ADR-0009 §3；未来 inventory 必须覆盖五类治理数据与 Recipe，
并按单个 `factOrRuleId` 追溯到机构、locator、地区、语言、版本/发布日期、`retrievedAt`、
最小 snapshot/hash、candidate source tier、许可条款、复制/转换/再发布结论、审核状态和
撤回监控；同时必须绑定 M0 的 `datasetId/releaseId/releaseRevision/releaseContentDigest`、
`entityId/entityRevision`、SourceKey `{referenceId,referenceRevision}`、`snapshotId` 与 source
snapshot content digest。只给数据集写一个 URL、只保存搜索结果、缺具体版本、跨 revision
复用字段或用整页复制代替最小 snapshot 都不合格。inventory 不得复制或取代 M0 catalog
validator 的 source pairing/identity authority。

每个必需角色还须产生 ADR-0009 §3.1 的独立 per-release review decision，绑定具体人类
assignment、role、同一精确 release revision/digest、entity/fact/source/region/language scope、
decision、时间、evidence/independence/conflict digest 与撤销状态。assignment、旧签名、替补
关系或相同姓名不得跨 revision/digest 漂移复用。

### 2.3 Activation readiness

Design Review 检查 ADR-0009 §4—§5 的 fail-closed 派生 gate、10 项 activation checklist
与唯一总序是否无旁路。readiness 不得成为第二套 lifecycle：只有同一精确 M0 revision
已经是 literal `approved` 且全部 gate 满足，派生 decision 才可为 `ACTIVATION_ELIGIBLE`；
activation 仍须另行授权并执行合法 M0 `approved → active` transition。Preparation 通过只
允许进入 synthetic-only/empty-template readiness preparation，不能进入真实内容、Accepted
或 active。

## 3. 完全合成的未来可执行证据

未来 synthetic-only readiness implementation 必须使用 `syn:` 前缀的抽象 dataset、actor、
source、rule 和 recipe ID；不得出现真实机构、真实食品/过敏原/宗教伦理/食品安全阈值、
真实 technique/Recipe 内容或真实许可结论。正向用例只证明结构可满足，不代表真实内容
合格。普通 table-driven/unit/regression tests 直接比较稳定结构化结果，不建立巨型 checker、
guard registry、source mutation 自证或 compiler/runner/supply-chain 自证。

### 3.1 数据类与 hard/safety matrix

| ID | 完全合成场景 | 未来直接证据 |
| --- | --- | --- |
| K01 | `syn:food-concept` envelope 字段齐全但 authority/source 均为合成 | Knowledge Data Steward 与独立 Product Owner 槽位均被要求；不得 active |
| K02 | `syn:allergen` 映射结构 | owner、外审、Safety Approver 三个不同槽位均被要求 |
| K03 | `syn:religious-ethical` 原子 hard rule | 只处理显式用户规则；Product Policy Steward + 独立 Product Owner + 文化审核缺一即阻断 |
| K04 | `syn:food-safety` rule | 地区、版本、review due、撤回监控任一缺失均阻断 |
| K05 | `syn:cooking-technique` | safety-critical 标记要求 Safety Approver；普通难度不冒充安全资格 |
| K06 | `syn:recipe` | Recipe QA 与 Culinary Content Steward 独立，安全关键字段另审 |
| H01 | 冲突只位于调味品 concept | hard check 阻断，不只检查主料/辅料 |
| H02 | 替代品引入合成 hard conflict | 替代后完整重算并阻断 |
| H03 | 合成 `mayContain` + strict rule | 稳定 blocked reason；不得降级软提示 |
| H04 | mapping unknown / 多义 / revision unknown | `unmapped`，不产生可通过候选 |
| H05 | Recipe 缺 safety checkpoint、设备或关键 technique | Recipe 不可执行；Recipe QA 不能替代 Safety Approver |
| L01 | 全部 readiness gate 看似满足，但 M0 lifecycle 是 draft/under_review | 派生 decision 仍为 `BLOCKED` |
| L02 | 同一 exact M0 approved revision 且全部 gate 满足 | 只产生派生 `ACTIVATION_ELIGIBLE`；不写 lifecycle |
| L03 | 试图执行 `ACTIVATION_ELIGIBLE → active` | 拒绝；它不是状态边，只允许另行授权的 M0 `approved → active` |
| L04 | superseded/withdrawn，或撤回后试图复用旧 revision | fail closed；恢复必须更高 revision、新 evidence 与新 review decisions |

### 3.2 Provenance / license / authority matrix

| ID | inert 变换 | 未来预期 |
| --- | --- | --- |
| P01 | 缺 source organization 或 locator | `SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT` |
| P02 | 缺 minimal snapshot/hash，或 hash 改变 | 同上；candidate non-active |
| P03 | source version/发布日期与 snapshot 不一致 | 同上；不得沿用旧审核 |
| P04 | source withdrawn 或监控过期 | `SOURCE_WITHDRAWN`；恢复必须新 revision |
| P05 | `licenseStatus` 为 unknown/pending/restricted/rejected | `LICENSE_NOT_APPROVED` |
| P06 | copy/transform/redistribution 任一结论缺失或不覆盖实际用法 | `LICENSE_NOT_APPROVED` |
| P07 | 首发地区缺失或与来源不匹配 | `REGION_NOT_APPLICABLE` |
| P08 | source/product language 缺失或不匹配 | `LANGUAGE_NOT_APPLICABLE` |
| P09 | domain review 缺失、过期或针对另一 revision | `DOMAIN_REVIEW_MISSING_OR_EXPIRED` |
| P10 | SourceKey/referenceRevision/snapshotId 与 M0 catalog 不配对 | source identity 仍由 M0 拒绝；readiness 只消费并阻断 |
| P11 | dataset/release/entity revision 或 release/source content digest 漂移 | `SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT`；旧 evidence 不复用 |
| A01 | owner 与自己的 approver 为同一人 | `CONFLICTED_OR_DUPLICATE_APPROVER` |
| A02 | 外部食品安全审核人与 Safety Approver 重复 | 同上；一份签名不计两份独立证据 |
| A03 | 一个签名被复制到多个必需槽位 | 同上；digest 重复不构成独立性 |
| A04 | 身份伪造、无法验证或已撤销 | `FORGED_OR_REVOKED_AUTHORITY` |
| A05 | 替补未重新接受责任或资格/地区不等价 | `UNASSIGNED_OR_UNACCEPTED_AUTHORITY` |
| A06 | owner/审核人槽位缺失 | 同上；脚本、writer、总控、模型不得补位 |
| A07 | Product Owner 缺失、与相关 owner/作者/文化审核人重复，或未作所需联合批准 | unassigned 或 conflict 主因；FoodConcept/宗教伦理不得 eligible |
| A08 | assignment 或旧 review decision 被复用到不同 release revision/digest/scope | `DOMAIN_REVIEW_MISSING_OR_EXPIRED`；必须由具体人类重新签署 |
| T01 | 同时伪造身份、withdrawn、license pending、地区不符 | 记录全部缺陷，稳定主因必须为 `FORGED_OR_REVOKED_AUTHORITY` |
| T02 | A/B 未双 CLEAN，但其余合成 readiness 通过 | `INDEPENDENT_A_B_NOT_CLEAN` |
| T03 | 外部证据齐全但总控未 Accepted | `TOTAL_CONTROL_NOT_ACCEPTED` |

每行必须对同一结构化状态运行，而不是只搜索错误文案。compound case 证明 ADR-0009
总序，不能用 projection/tag 丢失其他阻断。测试日志只输出合成 case ID 和稳定 reason，
不回显未来真实来源片段、个人身份或许可材料。

## 4. M1 后续最小增量与签发顺序

严格顺序如下；外部 authority/source 缺失不阻断前两项，但严格阻断第 3 项完成核验及其后
所有真实内容、Accepted 与 activation：

1. **当前合同的独立 Design Review**：只读检查 ADR-0009 与本计划；报告 CLEAN/BLOCK，
   不改候选，也不把总控定点复核冒充独立结论。
2. **Synthetic-only / empty-template readiness preparation**：在另行签发的小范围任务中，
   以普通测试实现 §3 与空模板/shape；全部 identity/source 保持合成或空值，不读取、抓取、
   导入真实内容。没有外部 authority 时可以完成并审查本项。
3. **等待并核验外部 authority / source / scope**：具体人类身份、资格、接受责任、独立性，
   Product Owner 必需关系，逐事实来源/许可，以及首发地区/语言/数量范围全部得到外部确认；
   任一仍 pending 时停在此处。
4. **另签 real-content draft task**：只在第 3 项全满足后，由总控签发精确 baseline、allowed
   files、source inventory 和责任证据，录入 non-active draft；不得由 preparation 授权推断。
5. **同一候选双独立 A/B**：A 静态核对来源、许可、authority、per-release decisions、范围
   与内容差异；B 动态重放 provenance/hard/safety/withdrawal/determinism gate。两者针对同一
   完整 SHA/release revision/digest，均只读；候选变化使两份结论失效。
6. **总控 Accepted**：复核外部专业证据与 A/B 后，决定是否接受精确 M1 候选；writer、
   审计者和脚本不得自行 Accepted。
7. **单独 activation**：只有 M1 Accepted 后，另行授权执行 M0 合法 `approved → active`；
   `ACTIVATION_ELIGIBLE` 只是派生 gate decision，不是 lifecycle transition。

不得把第 2 项的 empty/synthetic PASS 解释成第 3/4 项已满足。任一 BLOCK、新 revision、
digest/scope 变化或 authority decision 撤销，都必须按受影响步骤重新取证，不沿用旧签名或
A/B。

## 5. 固定工具链、门禁与 TCB

S1-R1 preparation candidate 固定：

```text
PATH=/Users/aipuli/.nvm/versions/node/v24.18.0/bin:$PATH
node --version                         # 必须为 v24.18.0
pnpm install --frozen-lockfile
pnpm stage09p:m1:readiness:check       # typecheck/build/target test/M0/scope
pnpm --filter @meal-agent/domain check
pnpm stage09p:m0:check
pnpm docs:links:check
pnpm check
node infra/docker/check-m3b-registry-integrity.mjs
                                      # 仅允许 423 != frozen 417 的预期 fail closed
git diff --check
git diff --name-status 07839f11ba3466bcc9fd1981df844df5359b4887..HEAD
git status --short --branch
```

S1-R1 不运行 Docker/Compose 或完整 `stage09a:check`，不得使用网络抓取、凭据或外部写入；
09A baseline 保持 frozen，待总控核验 423 后另签机械 R2。固定 Node、frozen lockfile、Git
review、既有 CI/09A、独立 Design Review，以及未来具体外部 authority 与 A/B 共同构成
外部 TCB。短 runner 只传播普通命令失败，
不自证 Node、compiler、test runner、lockfile、reviewer、外部来源或 supply chain。

S1 synthetic gate 保持小而可读：普通 unit/table/regression + 一个短聚合入口；
若需要约 1:1 复制产品规则的 checker、mutation registry、网络抓取或“自证 reviewer”，
立即 `ARCHITECTURE BLOCKED`，回到独立设计审查。

## 6. 外部依赖与状态边界

`externalAuthorityNeeded` 当前至少包括：五类具体 owner 与 Domain Owner；具体 Product
Owner 及其对 FoodConcept、宗教/伦理的必需 per-release 批准关系；具体外部食品安全审核人
和 Safety Approver；具体法律/合规/许可审核人；具体文化/伦理审核人；具体 Recipe QA；
逐事实/规则真实来源 inventory；首发地区、`zh-CN` 适用性和 Proposed `24/4/8/8/12`
是否采用。全部为 `PENDING_EXTERNAL_CONFIRMATION`。

09P 保持 `In Progress`；M0 保持 `Accepted`；M1 本轮只有 preparation S1-R1 candidate，
H01—H05/K01—K06 留给 S2，M1 未 Implemented、未 Accepted、未激活。阶段 09B、云、公网、真实微信、合法域名、真机、
体验版、审核和发布继续 `Deferred — 外部依赖`，不得由本地文档或合成门禁替代。
