# ADR-0009：Stage 09P-M1 发布权限与外部审核边界

- 状态：Proposed（M1 preparation design candidate；等待独立 M1 Design Review）
- 日期：2026-08-27
- 基线：`1a66015e63ac84c6257be46a36c5c5967ee53f20`
- 有界修订 anchor：`915f8bf5a207211155aecda448be52b36bd0072a`
- 上位决策：[ADR-0007：食品知识治理与确定性领域核心](0007-food-knowledge-governance-and-domain-core.md)
- M0 边界：[ADR-0008：Stage 09P-M0 产品证据边界](0008-stage09p-m0-evidence-boundary.md)
- 准备计划：[Stage 09P-M1 外部审核与首发就绪计划](../../plans/2026-08-stage-09p-m1-release-readiness.md)

本 ADR 只设计 M1 的外部审核、来源与激活权限合同。它不发布知识，不导入真实食品事实，
不创建 active release，也不表示 M1 已 Implemented 或 Accepted。仓库当前没有已确认的
具体外部审核责任人或真实来源/许可 inventory；用户的自动驾驶授权、角色名称、AI 输出
或实现者声明均不能替代外部专业、文化、法律或许可审核。

## 1. 两层状态：readiness 不等于 activation

M1 固定分为两层，证据不得跨层代用：

1. **Preparation / readiness**：定义角色槽位、来源字段、状态机、合成矩阵、门禁和未来
   证据格式。允许状态为 `DESIGN_DRAFT`、`READY_FOR_INDEPENDENT_DESIGN_REVIEW` 或
   `DESIGN_BLOCKED`；不得产生运行时知识资格。
2. **Real-content release activation**：只在另行签发的 real-content data task 中收集
   真实来源和具体自然人责任证据，经外部审核、双独立 A/B 与总控 Accepted 后，才可对
   一个精确 release revision 执行激活。本 ADR 不授权该任务。

当前所有真实角色槽位必须为 `UNASSIGNED`，所有外部确认状态必须为
`PENDING_EXTERNAL_CONFIRMATION`。不得把 readiness 的文档完整性写成某个来源、规则、
数据量、地区、语言、审核人或 release 已获批准。

## 2. 外部 authority registry 合同

未来 authority registry 的每个槽位必须记录以下字段；本轮只定义字段，不创建真实记录：

```text
authorityRecordId
assignmentRevision
assignmentDigest
role
dataKinds[]
naturalPersonIdentity
affiliation
identityVerificationReference
jurisdictions[]
languages[]
qualificationReference
acceptedResponsibilities[]
acceptedAt
acceptanceEvidenceDigest
independenceDeclaration
disclosedConflicts[]
assignmentKind               # primary | substitute
substitutesFor
status                       # unassigned | pending_external_confirmation |
                             # confirmed | suspended | revoked
revokedAt
revocationReason
```

`naturalPersonIdentity` 必须指向可验证的具体人类；组织名、岗位名、群聊、AI、脚本、writer、
总控或“用户已授权”都不是身份。`acceptedResponsibilities` 必须逐项覆盖该人实际签署的
责任，只有姓名或角色标签不构成接受责任的证据。身份与资格证据只保存验证所需的最小
引用和 digest，不把证件、凭据或不必要个人信息提交仓库。

### 2.1 五类 owner

| 数据类 | 必需 owner | 责任 | 当前身份 | 当前确认 |
| --- | --- | --- | --- | --- |
| FoodConcept | Knowledge Data Steward | 稳定 ID、别名、来源映射、弃用和撤回编排 | `UNASSIGNED` | `PENDING_EXTERNAL_CONFIRMATION` |
| allergen | Allergen/Safety Data Steward | 标签语义、映射、`mayContain` / 交叉接触材料与升级 | `UNASSIGNED` | `PENDING_EXTERNAL_CONFIRMATION` |
| 宗教/伦理 | Product Policy Steward | 原子规则、用户自我声明边界、争议与撤回处理 | `UNASSIGNED` | `PENDING_EXTERNAL_CONFIRMATION` |
| 食品安全 | Food Safety Steward | 规则前提、地区/版本、复核周期、紧急撤回 | `UNASSIGNED` | `PENDING_EXTERNAL_CONFIRMATION` |
| cooking-technique / Recipe | Culinary Content Steward | 技术与 Recipe 内容、步骤、设备、安全检查点的版本管理 | `UNASSIGNED` | `PENDING_EXTERNAL_CONFIRMATION` |

技术 `Domain Owner` 只负责 schema、ID、digest 和运行时接线，当前同样为
`UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION`；它不能替代任一数据 owner 或外部审核。

### 2.2 必需审核角色

| 角色 | 必须接受的责任 | 独立性要求 | 当前状态 |
| --- | --- | --- | --- |
| Product Owner | 批准首发产品范围；对 FoodConcept 作必需产品批准；与文化/伦理审核人共同批准宗教/伦理材料 | 必须是已核验并接受精确 release 责任的具体人类；不得与相关数据 owner、材料作者或同一批准链的文化/伦理审核人为同一人 | `UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION` |
| 外部食品安全审核人 | 核验安全事实、适用前提、标签/交叉接触解释与证据版本 | 必须是 owner、作者、writer、模型和总控之外的具体合格人类 | `UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION` |
| Safety Approver | 对安全关键字段、fail-closed 语义和首发安全范围签署最终专业责任 | 不得与该材料的外部食品安全审核人或 owner 为同一人 | `UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION` |
| 法律/合规/许可审核人 | 核验地区适用性及复制、转换、再发布和归属结论 | 不得由内容 owner、writer、搜索或模型代签 | `UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION` |
| 文化/伦理审核人 | 核验措辞、原子规则和不推断身份边界 | 必须独立于 Product Policy Steward 和材料作者 | `UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION` |
| Recipe QA | 核验结构、份量、步骤、设备、替代关系和每个 safety checkpoint | 必须独立于 Culinary Content Steward 和 Recipe 作者；安全关键项另需 Safety Approver | `UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION` |

必要批准关系不可降级：FoodConcept 必须同时有 Knowledge Data Steward 的 ownership 与
Product Owner 的 per-release 批准，涉及 allergen/safety 时再叠加 Safety Approver；宗教/
伦理必须同时有 Product Policy Steward 的 ownership、Product Owner 的 per-release 批准和
独立文化/伦理审核。Product Owner 的角色 assignment 不等于批准，必须另有 §3.1 的精确
review decision。缺 Product Owner、由 owner/作者自批、与文化审核人重复或有未处置冲突时，
相关候选保持 non-active。

一个人即使具备多项资格，也不能用同一份签名填充两个必须独立的证据槽位。任何 owner
不得批准自己拥有或编写的材料。重复身份、未披露冲突、伪造身份或资格无法验证时，相关
release 必须保持 non-active。

替补只有在以下条件全部满足后才有效：与主角色同等适用资格；完成独立身份/冲突核验；
显式接受同一精确责任和 release revision；留下新的 acceptance evidence；不追溯继承
旧签名。主角色撤回、离任、资格失效或证据被撤销时，替补不会自动生效，当前候选立即
回到 blocked，直至替补重新签署。任何替补都不能消除“审核人与批准人必须不同”的要求。

## 3. Source inventory 精确字段

未来 inventory 必须按“一个事实/规则 ID × 一个来源 revision”建立记录；聚合数据集级
说明不能替代逐事实/规则可追溯性。每条记录精确包含：

```text
sourceInventoryId
datasetKind                 # FoodConcept | allergen | religious_ethical |
                            # food_safety | cooking_technique | recipe
datasetId
releaseId
releaseRevision
releaseContentDigest
entityId
entityRevision
factOrRuleId
sourceKey: {
  referenceId, referenceRevision
}
snapshotId
sourceSnapshotContentDigest
sourceOrganization
sourceLocator
applicableRegions[]
sourceLanguage
sourceVersion
publicationDate
retrievedAt
minimalSnapshot: {
  locator, mediaType, byteLength,
  hashAlgorithm, contentHash, capturedAt
}
candidateSourceTier         # L1 | L2 | L3 | L4；审核前仅为 candidate
licenseTermsLocator
rightsHolder
licenseStatus               # unknown | pending | restricted | approved | rejected
copyConclusion              # unknown | permitted | conditional | prohibited
transformationConclusion    # unknown | permitted | conditional | prohibited
redistributionConclusion    # unknown | permitted | conditional | prohibited
attributionRequirements[]
licenseReviewStatus         # unreviewed | pending | approved | rejected | revoked
provenanceReviewStatus      # unreviewed | pending | approved | rejected | revoked
domainReviewStatus          # unreviewed | pending | approved | rejected | revoked
reviewEvidenceReferences[]
withdrawalMonitoring: {
  accountableRole, method, cadence,
  lastCheckedAt, nextDueAt,
  state,                    # unknown | current | overdue | withdrawn
  evidenceReference
}
```

`datasetId/releaseId/releaseRevision/releaseContentDigest` 必须指向同一个精确 M0 release；
`entityId/entityRevision` 必须是该 release 中的精确 entity revision。`sourceKey` 精确复用
M0 的 `{referenceId, referenceRevision}`，`snapshotId` 与 `sourceSnapshotContentDigest`
必须绑定该 SourceKey 的成对 snapshot；`sourceLocator`、`retrievedAt` 和 snapshot material
必须与 M0 catalog 对同一 SourceKey 的 canonical material 逐字节一致。任一 ID、revision、
digest、pairing 或 material 漂移都使 readiness blocked。

本 inventory 只引用 M0 已解码/校验的 source identity，不复制 pairing、forward/reverse
equivocation、entity history 或 digest 的 authority。ADR-0008 的 catalog validator 仍是这些
M0 不变量的唯一 owning layer；M1 readiness 只能消费其完整结果并 fail closed，不能建立
第二份 source identity validator 或以 inventory 字段覆盖 M0 issue。

`sourceLocator` 必须能定位被审核的确切版本；只有首页、搜索结果或模型摘要不合格。最小
snapshot 仅保存验证事实所需的最小片段与 hash，不默认复制完整版权内容。`candidateSourceTier`
不会把搜索、模型输出、用户输入或未审网页从 L4 自动升级为 L1/L2/L3。
`licenseStatus = approved` 只是未来状态机允许的字面量；本轮没有任何真实记录取得该状态。

### 3.1 Per-release review decision 证据

authority assignment 只证明某人被核验并接受某类责任，不构成对任何 release 的批准。
每个必需批准/审核槽位都必须另有一条不可变 review decision：

```text
reviewDecisionId
authorityRecordId
authorityAssignmentRevision
authorityAssignmentDigest
role
assignmentAcceptanceDigest
datasetId
releaseId
releaseRevision
releaseContentDigest
scope: {
  entityRevisions: [{ entityId, entityRevision }],
  factOrRuleIds[], sourceInventoryIds[], sourceKeys[],
  applicableRegions[], languages[]
}
decision                     # approve | reject
decidedAt
evidenceDigest
independenceEvidenceDigest
conflictDisclosureDigest
supersedesReviewDecisionId
revokedAt
revocationReason
```

`authorityRecordId/authorityAssignmentRevision/authorityAssignmentDigest/role` 与
`assignmentAcceptanceDigest` 必须解析到当时有效的具体人类 assignment；
`scope` 不允许隐式通配到未列 entity、事实、来源、地区或语言。decision 只适用于逐字节相同的
`datasetId/releaseId/releaseRevision/releaseContentDigest` 和列明 scope；release revision、
digest、entity revision、SourceKey 或 scope 任一变化，都必须产生新 decision。旧签名、
角色 assignment、替补关系或相同姓名不得跨 revision 复用。替补必须以自己的 assignment
和新 evidence 重新签署；撤销、冲突或 assignment 失效立即使 decision 不合格。Product
Owner、外部食品安全、Safety Approver、法律/许可、文化/伦理和 Recipe QA 等各自 decision
不能互相替代。

撤回监控必须有具体 accountable role、周期和证据。`lastCheckedAt` 缺失、监控过期、
locator 失效、内容 hash 漂移或上游撤回，都使当前 revision 失去激活资格；恢复只能以
更高 revision 和新证据重新评审，不能静默恢复旧 release。

## 4. License / provenance fail-closed 派生 gate

M0 的 literal lifecycle 是唯一 lifecycle authority，本 ADR 不新增、重命名或替换它：

```text
draft → under_review → approved → active
                         ├→ superseded
                         └→ withdrawn
```

并继续受 ADR-0008 literal 6×6 oracle、严格 revision、same-revision material identity 和
full-snapshot history 约束。M1 readiness 只计算派生的
`activationGateDecision = BLOCKED | ACTIVATION_ELIGIBLE`；该值不是 `lifecycleStatus`，
不能写回 envelope，也不形成 `ACTIVATION_ELIGIBLE → ACTIVE` 的第二条状态边。

`ACTIVATION_ELIGIBLE` 只能针对一个同一精确 M0 candidate 计算：其
`datasetId/releaseId/releaseRevision/releaseContentDigest` 完整绑定（其中
`releaseContentDigest` 只是对 M0 release root `contentDigest` 的明确命名，不产生第二个
digest authority），且该 candidate 中相关
entity revision 的 literal `lifecycleStatus` 已为 `approved`。在此前提下还必须同时满足：
具体 authority 已验证并接受责任；所有必需角色都有 §3.1 绑定该精确 candidate/scope 的
未撤销 `approve` decision；来源版本与 snapshot/hash 一致；candidate tier 已由适格人类
确认；`licenseStatus` 为经证据支持的 `approved`；复制/转换/再发布结论覆盖实际使用方式；
地区、语言和版本与首发范围精确匹配；领域审核、Product Owner、文化/伦理、Recipe QA 与
Safety Approver 等适用审核齐全且未过期；withdrawal 监控有效；合成 readiness gate 通过。

即使派生结果为 `ACTIVATION_ELIGIBLE`，activation 也必须由单独授权执行 M0 的合法
`approved → active` transition，并按 ADR-0008 提升所需 entity/release revision、重签
release digest，禁止原地改写已 approved revision。activation receipt 必须绑定 eligible
predecessor 的 exact release revision/digest、全部 review decision ID，以及 active successor
的 exact release/entity revision/digest 和 M0 transition proof。旧 decision 不复制、不改绑到
successor；receipt 只证明它们被一次性消费来授权这一条精确 transition。activation successor
必须证明除获准的 lifecycle/release metadata 变化外，受审内容、SourceKey 和 scope 与 eligible
candidate 一致；否则所有 review decision 失效并回到新 revision 审核。`superseded` /
`withdrawn` 仍完全遵循 M0 literal oracle；撤回后的恢复必须是带新来源/审核证据的更高
revision，不能静默恢复旧 release。

任何 `unknown`、`pending`、`restricted`、`rejected`，或来源/许可/地区/语言/版本/
snapshot/hash/审核/独立性/撤回监控的缺失与不符，均不得进入 `ACTIVATION_ELIGIBLE` 或
`ACTIVE`。多个缺陷同时存在时全部保留为内部证据，对外稳定主因按 §5 的总序返回；不得
挑一个较弱理由绕过更高优先级阻断。

## 5. First-release activation checklist 与总序

第一个真实 release 的每个精确 revision 必须逐项满足：

1. 五类 owner、Domain Owner、Product Owner 和全部适用审核角色均是已核验、已接受
   责任的具体人类；
2. independence / conflict / substitute 检查通过，重复身份不冒充双重独立证据；
3. 每个事实/规则 ID 有完整 source inventory，并精确绑定 M0 release/entity revision、
   SourceKey、snapshot、release/source content digest；
4. 来源未撤回且 version/hash/locator 未漂移，withdrawal monitoring 未过期；
5. 许可、复制、转换、再发布和 attribution 结论与实际数据用法一致；
6. 首发地区、source language、产品语言和版本适用范围由外部 authority 明确确认；
7. FoodConcept 与宗教/伦理的 Product Owner 必需批准关系成立；allergen / 食品安全 /
   文化伦理 / Recipe QA / safety checkpoint 的适用审核齐全；每个决定均以 §3.1 绑定同一
   精确 release revision/digest 和 scope；
8. synthetic-only readiness implementation/gate 在固定 Node 上通过，不接触真实内容；
9. 针对同一精确候选的独立 Audit A 与 Audit B 均 CLEAN；
10. 总控核对外部证据、候选 SHA、范围和门禁后明确 Accepted，并单独授权 activation。

若同一候选有多个问题，阻断主因使用以下唯一总序：

```text
FORGED_OR_REVOKED_AUTHORITY
→ UNASSIGNED_OR_UNACCEPTED_AUTHORITY
→ CONFLICTED_OR_DUPLICATE_APPROVER
→ SOURCE_WITHDRAWN
→ SOURCE_MISSING_OR_SNAPSHOT_VERSION_DRIFT
→ LICENSE_NOT_APPROVED
→ REGION_NOT_APPLICABLE
→ LANGUAGE_NOT_APPLICABLE
→ DOMAIN_REVIEW_MISSING_OR_EXPIRED
→ READINESS_GATE_FAILED
→ INDEPENDENT_A_B_NOT_CLEAN
→ TOTAL_CONTROL_NOT_ACCEPTED
→ ACTIVATION_ELIGIBLE
```

该总序只稳定诊断，不削弱其他阻断。外部具体人类 authority 的独立证据负责解锁对应
专业槽位；脚本、writer、模型、实施 Agent 和总控都不能自造或替代这些证据。总控只在
全部外部槽位真实满足后执行最终 Accepted/activation 决定，不能自行批准专业、文化、
法律或许可事实。

## 6. 影响与接受边界

- Proposed 规模 `24 FoodConcept / 4 allergen 类别 / 8 safety 规则族 / 8 techniques /
  12 recipes` 仍未 Accepted；首发地区与 `zh-CN` 范围仍为
  `PENDING_EXTERNAL_CONFIRMATION`。
- M1 后续只能按 readiness 计划的小增量顺序推进；real-content task 必须另行签发。
- Product Owner 具体人类槽位与其他真实 authority 一样仍为
  `UNASSIGNED / PENDING_EXTERNAL_CONFIRMATION`，本 ADR 没有填充或批准该角色。
- 任何已激活 release 的证据失效都 fail closed 并发布 withdrawn/new revision，不覆盖历史。
- 本 ADR 的文档提交只可请求独立 M1 Design Review；实施者、脚本、模型和本文件均无权
  将 ADR、M1 或 09P 写成 Accepted / Pass。
- 09P 仍为 `In Progress`；M0 保持 `Accepted`；M1 仅 preparation/design，尚未
  Implemented/Accepted。09B、云、公网、真实微信、真机、体验版、审核和发布继续 Deferred。
