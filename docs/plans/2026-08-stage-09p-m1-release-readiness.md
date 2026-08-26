# Stage 09P-M1：外部审核与首发就绪计划

- 状态：Preparation design candidate；等待独立 M1 Design Review
- 日期：2026-08-27
- 冻结基线：`1a66015e63ac84c6257be46a36c5c5967ee53f20`
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

本轮只允许：

```text
docs/architecture/decisions/0009-stage09p-m1-release-authority-boundary.md
docs/plans/2026-08-stage-09p-m1-release-readiness.md
docs/architecture/decisions/README.md
docs/plans/README.md
docs/README.md
docs/project-status.md
```

除上述 6 个文件外全部 frozen。不得写 `data/**` 模板、scripts、tests、product、contracts、
domain、API、DB、migration、client、OpenAPI、lockfile、09A 冻结面或看板；不得建立真实
authority/source record、`licenseStatus=approved` 记录、active release 或 M2 资产。

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
撤回监控。只给数据集写一个 URL、只保存搜索结果、缺具体版本或用整页复制代替最小
snapshot 都不合格。

### 2.3 Activation readiness

Design Review 检查 ADR-0009 §4—§5 的 fail-closed 状态机、10 项 activation checklist
与唯一总序是否无旁路。Preparation 通过只允许进入 synthetic implementation proposal，
不能进入 `ACTIVATION_ELIGIBLE` 或 `ACTIVE`。

## 3. 完全合成的未来可执行证据

未来 synthetic-only readiness implementation 必须使用 `syn:` 前缀的抽象 dataset、actor、
source、rule 和 recipe ID；不得出现真实机构、真实食品/过敏原/宗教伦理/食品安全阈值、
真实 technique/Recipe 内容或真实许可结论。正向用例只证明结构可满足，不代表真实内容
合格。普通 table-driven/unit/regression tests 直接比较稳定结构化结果，不建立巨型 checker、
guard registry、source mutation 自证或 compiler/runner/supply-chain 自证。

### 3.1 数据类与 hard/safety matrix

| ID | 完全合成场景 | 未来直接证据 |
| --- | --- | --- |
| K01 | `syn:food-concept` envelope 字段齐全但 authority/source 均为合成 | readiness shape 可满足；不得 active |
| K02 | `syn:allergen` 映射结构 | owner、外审、Safety Approver 三个不同槽位均被要求 |
| K03 | `syn:religious-ethical` 原子 hard rule | 只处理显式用户规则；不推断身份；缺文化审核阻断 |
| K04 | `syn:food-safety` rule | 地区、版本、review due、撤回监控任一缺失均阻断 |
| K05 | `syn:cooking-technique` | safety-critical 标记要求 Safety Approver；普通难度不冒充安全资格 |
| K06 | `syn:recipe` | Recipe QA 与 Culinary Content Steward 独立，安全关键字段另审 |
| H01 | 冲突只位于调味品 concept | hard check 阻断，不只检查主料/辅料 |
| H02 | 替代品引入合成 hard conflict | 替代后完整重算并阻断 |
| H03 | 合成 `mayContain` + strict rule | 稳定 blocked reason；不得降级软提示 |
| H04 | mapping unknown / 多义 / revision unknown | `unmapped`，不产生可通过候选 |
| H05 | Recipe 缺 safety checkpoint、设备或关键 technique | Recipe 不可执行；Recipe QA 不能替代 Safety Approver |

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
| A01 | owner 与自己的 approver 为同一人 | `CONFLICTED_OR_DUPLICATE_APPROVER` |
| A02 | 外部食品安全审核人与 Safety Approver 重复 | 同上；一份签名不计两份独立证据 |
| A03 | 一个签名被复制到多个必需槽位 | 同上；digest 重复不构成独立性 |
| A04 | 身份伪造、无法验证或已撤销 | `FORGED_OR_REVOKED_AUTHORITY` |
| A05 | 替补未重新接受责任或资格/地区不等价 | `UNASSIGNED_OR_UNACCEPTED_AUTHORITY` |
| A06 | owner/审核人槽位缺失 | 同上；脚本、writer、总控、模型不得补位 |
| T01 | 同时伪造身份、withdrawn、license pending、地区不符 | 记录全部缺陷，稳定主因必须为 `FORGED_OR_REVOKED_AUTHORITY` |
| T02 | A/B 未双 CLEAN，但其余合成 readiness 通过 | `INDEPENDENT_A_B_NOT_CLEAN` |
| T03 | 外部证据齐全但总控未 Accepted | `TOTAL_CONTROL_NOT_ACCEPTED` |

每行必须对同一结构化状态运行，而不是只搜索错误文案。compound case 证明 ADR-0009
总序，不能用 projection/tag 丢失其他阻断。测试日志只输出合成 case ID 和稳定 reason，
不回显未来真实来源片段、个人身份或许可材料。

## 4. M1 后续最小增量与签发顺序

严格顺序如下；前一项未由对应 authority 接受时，不得开始下一项：

1. **Authority/source inventory（draft only）**：只在另行批准的 docs/data-draft 范围
   登记候选 identity/source，全部 non-active；不升级 tier，不写批准许可。
2. **独立 Design Review**：只读检查 ADR-0009 与本计划；报告 CLEAN/BLOCK，不改候选。
3. **Synthetic-only readiness implementation/gate**：另行签发小范围任务，以普通测试
   实现 §3；不得读取/导入真实内容。
4. **外部 authority 到位后单独签发 real-content data task**：明确具体人类、来源、
   首发地区/语言、allowed files 和责任证据后，才可录入真实 draft。
5. **双独立 A/B**：A 静态核对来源、许可、authority、范围和内容差异；B 动态重放
   provenance/hard/safety/withdrawal/determinism gate。两者针对同一完整 SHA，均只读。
6. **总控 Accepted**：复核外部专业证据与 A/B 后决定是否接受精确 M1 候选；activation
   仍需总控单独授权。writer、审计者和脚本不得自行 Accepted。

不得把第 1 步的 draft 或第 3 步的 synthetic PASS 解释成第 4 步已获授权。任一 BLOCK
后的新 SHA 必须重新取得所需外部签名和 A/B，不沿用旧候选结论。

## 5. 固定工具链、门禁与 TCB

本 preparation docs 候选固定：

```text
PATH=/Users/aipuli/.nvm/versions/node/v24.18.0/bin:$PATH
node --version                         # 必须为 v24.18.0
pnpm docs:links:check
git diff --check
git diff --name-only <baseline>...HEAD # 精确等于本计划 §1 的 6 文件
git status --short --branch
```

本轮不得运行 Docker/Compose、网络、凭据、`pnpm stage09a:check` 或 `pnpm check`。固定
Node、frozen lockfile、Git review、既有 CI/09A、独立 Design Review，以及未来具体外部
authority 与 A/B 共同构成外部 TCB。docs links 或未来小型 runner 只传播普通命令失败，
不自证 Node、compiler、test runner、lockfile、reviewer、外部来源或 supply chain。

未来 synthetic gate 应保持小而可读：普通 unit/table/regression + 一个短聚合入口即可；
若需要约 1:1 复制产品规则的 checker、mutation registry、网络抓取或“自证 reviewer”，
立即 `ARCHITECTURE BLOCKED`，回到独立设计审查。

## 6. 外部依赖与状态边界

`externalAuthorityNeeded` 当前至少包括：五类具体 owner 与 Domain Owner；具体外部食品
安全审核人和 Safety Approver；具体法律/合规/许可审核人；具体文化/伦理审核人；具体
Recipe QA；逐事实/规则真实来源 inventory；首发地区、`zh-CN` 适用性和 Proposed
`24/4/8/8/12` 是否采用。全部为 `PENDING_EXTERNAL_CONFIRMATION`。

09P 保持 `In Progress`；M0 保持 `Accepted`；M1 本轮只有 preparation/design candidate，
未 Implemented、未 Accepted、未激活。阶段 09B、云、公网、真实微信、合法域名、真机、
体验版、审核和发布继续 `Deferred — 外部依赖`，不得由本地文档或合成门禁替代。
