# 阶段 09P 外部班底委托简令（M-3）

- 文档编号：09P-OPS-BENCH-M3
- 日期：2026-09-12
- 上位依据：[阶段 09P 计划](../plans/2026-08-stage-09p-safe-deterministic-product-core.md) §3.4、§4.1、§4.2、§4.3、§4.4、§4.5；
  ADR-0009；冻结的 M1 就绪契约 `stage09p-m1-minimal-deterministic-readiness-contract-r4`
  （版本 `M1-MINIMAL-1R4`）§3.3 的十二角色闭字面量、§5.1 角色队列、§5.3 身份互异
  （§5.1/§5.3 只存在于 r4 修订版：无版本后缀的基础版 `M1-MINIMAL-1` §5 为
  「Reason owning predicates」，不含 §5.1/§5.3）
- 对象：把冻结契约 r4 §3.3 的**十二个角色**落到**具名自然人**，并据此订立 §4.5 的**外部高准确性审查**
- 用途：本文件是实际**去委托这些人**时使用的作业文件；它列出每个角色审什么/批什么、归哪一类数据、内外部归属、独立性约束、以及每个外部方要交什么

## 0. 硬约束声明（先读这一节）

第一，**角色落实是首次发布的唯一关键路径**，且**不在代码路径上、无界**。推荐与菜单本身可以从零到一，
但“给过敏家庭一份不违规的菜单”这件事，瓶颈不是代码，而是这条组织/外部链：
**权威食物知识源 → 十二名具名角色的授权 → §4.5 外部高准确性审查 → G2 admission**。

第二，**没有角色落实，就不允许激活任何真实食品数据**。具体地：

- 只要十二个角色中任何一个无具名、经确认、独立、无冲突、且已接受责任的自然人，
  任何真实（非合成）allergen / 食品概念 / 宗教伦理 / 食品安全 / 技艺数据都**不得进入 active**；
- 因此**推荐主干无法合法化**——它读不到权威词表，硬约束恒为
  `needs_structured_mapping`，安全评估恒为 `unknown`，只能 fail closed；
- 「存了但不执行」的现状是**刻意的 fail-closed**，不是缺陷；但它意味着在角色落实之前，
  产品**不能对外声称**任何过敏原/禁忌可被机器执行地阻断。

第三，**不得以任何内部产物冒充外部链**：不得伪造词表、不得以内部审计替代 §4.5 审查、
不得以内部审计替代 G2 admission、不得以内部角色替代必须独立的外部角色。角色名本身不构成审核证据。

## 1. 十二角色总表

来源：冻结的 M1 就绪契约 r4 §3.3 `role` 闭字面量的**精确顺序**；治理数据类与审/批职责来自计划 §4.3。

| # | 角色（契约闭字面量） | 必须审阅或批准什么（一行） | 治理数据类（§4.3） |
| --- | --- | --- | --- |
| 1 | `knowledge_data_steward` | 建立并维护 FoodConcept 权威概念：小写 UUIDv7、单调 revision、带地区/语言的别名、只用 `supersededBy` 且 ID 永不复用 | FoodConcept（owner） |
| 2 | `allergen_safety_data_steward` | 建立并维护 allergen 分类与「内部 UUIDv7 ↔ 外部 namespaced code」绑定；外部代码变化不改内部 ID | allergen（owner） |
| 3 | `product_policy_steward` | 把宗教/伦理诉求编码为**可计算的原子规则**；群体预设只能是用户确认的建议，不得推断身份 | 宗教 / 伦理（owner） |
| 4 | `food_safety_steward` | 维护食品安全 policy rule 的稳定 ID + revision（包装日期、用户录入、unknown、过期高风险、开封、冻融、制作/剩菜、冷链存疑） | 食品安全（owner） |
| 5 | `culinary_content_steward` | 维护 cooking-technique 稳定 UUIDv7、名称/别名语言、设备与安全关键标记独立版本 | cooking-technique（owner） |
| 6 | `domain_owner` | FoodConcept 的**技术保管人**：保管 domain 边界与消费；不构成安全批准 | FoodConcept（技术保管） |
| 7 | `product_owner` | 批准 FoodConcept 发布；批准宗教/伦理预设；涉 allergen/safety 时须与 Safety Approver 联署 | FoodConcept + 宗教/伦理（批准人） |
| 8 | `external_food_safety_reviewer` | 外部权威审查 allergen 适用分类、标签语义、`mayContain` 与交叉接触解释；审查储存/加工规则 | allergen + 食品安全（批准人，外部） |
| 9 | `safety_approver` | 对安全关键内容作最终批准：涉 allergen/safety 的 FoodConcept、安全关键 cooking-technique、L2 来源不得覆盖更高等级事实 | 跨类安全闸（批准人） |
| 10 | `legal_compliance_license_reviewer` | 确认地区适用性、许可（复制/转换/再发布）、食品安全宣传措辞与法规引用 | 跨类法律/合规（批准人，外部） |
| 11 | `cultural_ethical_reviewer` | 审查宗教/伦理预设的**文化准确性**；用户自定义原子排除不替用户作身份判断 | 宗教 / 伦理（批准人，外部） |
| 12 | `recipe_qa` | 菜谱与技艺内容的双人审核中担纲 QA 侧；安全关键技艺另需 Safety Approver | cooking-technique（批准人） |

契约侧要求（r4 §5.1、§5.3）：十二个角色**每个**只允许两种队列形态之一——
「恰好一个 `primary`」或「恰好一个 `primary` + 恰好一个 `substitute`（有效的替代关系）」；
有效队列里的每条 authority 记录必须是 `confirmed`、`identityVerified=true`、
`acceptedResponsibilities=true`、`independent=true`、`disclosedConflicts` 为空；
十二个角色的**有效自然人身份必须两两互异**。任何缺角色、重复、冲突或不独立都会触发
`UNASSIGNED_OR_UNACCEPTED_AUTHORITY` / `CONFLICTED_OR_DUPLICATE_APPROVER`。

## 2. 内外部归属

计划 M-3 的原文是「**内部七个（六个 steward/owner 加产品负责人 `product_owner`）** 由现有角色
承担；**计划 §4.5 的外部审查方（三至四方）** 完成委任」。据此精确落位如下：

### 2.1 可由现有工程/产品角色承担（内部）

- 六个 steward/owner：`knowledge_data_steward`、`allergen_safety_data_steward`、`product_policy_steward`、
  `food_safety_steward`、`culinary_content_steward`、`domain_owner`。
- 另：`product_owner` 本就由现有产品角色承担，亦属内部。

严格数来，内部共 **7 名**，其中 **6 名**是计划所称的 steward/owner，1 名是产品负责人。
内部角色同样必须**具名到人**：角色名不是责任人，不能以「团队」或「岗位」代替。

### 2.2 必须外部（§4.5 审查方）

- `external_food_safety_reviewer`（外部合格食品安全审核人）
- `legal_compliance_license_reviewer`（法律/合规/许可审核人）
- `cultural_ethical_reviewer`（文化/伦理审核人）

这三个是计划 §4.3 明确点名的外部批准方，也是 §4.5 高准确性审查的执行者。`safety_approver`
（安全批准人）在计划 §4.3 中**未**被标注为外部，故其外部归属不在此钉死，列入 §2.3 待裁定。

### 2.3 待产品负责人裁定

- `recipe_qa`（第 12 名）：内部还是外部？计划 §4.4 要求 12 道 L3 菜谱**双人审核**，
  其中安全关键字段另需 Safety Approver；但 `recipe_qa` 本身是否必须是外部方，计划未钉死。
- `safety_approver` 是否**也必须为外部方**（即须与 §2.2 三方同列，独立于项目实施者与内容
  生产者）：两者都触碰 allergen/食品安全；若安全批准人由**项目内部**担任，则「外部食品安全
  审核」与「安全批准」会失去第二双眼睛。**角色身份层面已在契约层裁定**：契约 r4 §5.3 强制十二个角色
  的有效自然人身份**两两互异**（"Effective natural-person identities must be pairwise distinct
  across all twelve roles."），故 `safety_approver` 与 `external_food_safety_reviewer` 必为
  不同自然人。仍未关闭的是**组织/利益独立性**问题——安全批准人是否也必须来自项目外部。
  此项须由产品负责人裁定，不得由项目自行默认。

### 2.4 独立性与利益冲突要求（对所有角色）

- 每个角色的有效自然人必须 `independent=true`，`disclosedConflicts` 为空集；有冲突者不满足资格。
- 外部方必须与**项目的实施者、Audit A/B 的执行者、以及被审数据的内容生产者**相互独立。
- 十二名有效自然人身份**两两互异**（r4 §5.3）；不得以角色名、化名或合成标记冒充自然人。
- 替代（substitute）仅在有有效 primary 时成立，且替代者是**唯一**有效记录与唯一被决策绑定的记录；
  被保留的 primary 不是第二个批准人。

## 3. §4.5 外部高准确性审查必须覆盖的内容（原文类别）

计划 §4.5 逐条列举如下，外部审查的结论必须**逐类**给出：

1. allergen 的适用分类、标签语义、`mayContain` 和交叉接触解释；
2. 开封、储存、冷冻、解冻、制作和剩菜规则；
3. 食品安全宣传措辞、地区法规适用性和中文解释；
4. 宗教/伦理预设的文化准确性；用户自定义原子排除**不替用户作身份判断**；
5. 外部菜谱、图片、标准文本和知识数据的**复制、转换和再发布许可**；
6. 任何可能被理解为**医疗、疾病治疗或儿童专项建议**的内容——本阶段默认**不纳入**。

以上六类中，第 1–2 类由 `external_food_safety_reviewer` 把关（安全关键字段另需
`safety_approver` 联署，见 §2.3）；第 3、5 类由 `legal_compliance_license_reviewer` 把关；
第 4 类由 `cultural_ethical_reviewer` 把关；第 6 类本阶段默认排除。

## 4. 对各审查方的具体委托（外部三方 + 待裁定的 `safety_approver`）

每一方都必须交付一份**绑定了 release/revision/contentDigest** 的 `ReviewDecisionEvidence`
（冻结契约 r4 §3.3 形状：`decision`、`decidedAt`、`reviewValidUntil`、`evidenceDigest`、
`independenceEvidenceDigest`、`conflictDisclosureDigest`、`entityRevisions`、`factOrRuleIds`、
`sourceInventoryIds`、`applicableRegions`、`languages`），并由 `authorityRecordId` 绑定到其具名 authority。

### 4.1 `external_food_safety_reviewer`

- **交付物**：对 allergen 适用分类/标签语义/`mayContain`/交叉接触解释的审查结论；对食品安全规则族
  （开封、储存、冷冻、解冻、制作、剩菜、冷链存疑、包装日期优先）的审查结论；每条结论绑定精确
  entity revision 与 fact/rule ID。
- **独立性证据**：签名或可验证的独立性声明 + 利益冲突披露（空）+ 资质证明；
  `independenceEvidenceDigest` 与 `conflictDisclosureDigest` 入证。
- **工作量（粗估，按计划 §4.4 的 Proposed 规模）**：约 4 个经外审批准的 allergen 类别；
  约 8 个食品安全规则族；约 12 道 L3 菜谱的过敏原声明须覆盖全部 8 个暴露类。
  （以上数字**只用于估工作量**，不是 Accepted 的数据范围，也不得写入任何验收条件或看板百分比。）
- **不得委托给项目自身**：审查结论本身；`mayContain`/交叉接触的判定；
  以内部审计替代该外审；以「allowlist 写非空」冒充真实来源治理。

### 4.2 `safety_approver`

- **交付物**：对安全关键内容的最终批准——涉 allergen/safety 的 FoodConcept 发布、
  安全关键 cooking-technique、以及 L2 来源不得覆盖更高等级事实的裁定。
- **独立性证据**：同上；并须解决 §2.3 的开放问题（是否也必须为外部方，即独立于项目实施者与
  内容生产者）。
- **工作量（粗估）**：与 4.1 的安全关键条目对齐，逐条联署；量级为「对已审安全关键字段的第二道签字」。
- **不得委托给项目自身**：安全批准；不得由实施者自批准。

### 4.3 `legal_compliance_license_reviewer`

- **交付物**：对每个来源的许可结论（`licenseStatus` 至少区分 `approved`/`restricted`/`pending`/`rejected`；
  后两者不得 active）；复制/转换/再发布许可的逐来源判定；地区适用性；食品安全宣传措辞的合规审查；
  每源的 `SourceEvidence` 字段（`licenseReference`、`applicableRegions`、`sourceLocator`、`sourceVersion`、
  `publicationDate`、`retrievedAt`、`minimalSnapshotDigest` 等）。
- **独立性证据**：同上。
- **工作量（粗估）**：逐来源（每个 `sourceOrganization` 一份），并覆盖 §4.4 的 5 个数据类；
  含中英文解释的法规适用性判断。
- **不得委托给项目自身**：许可判定；地区法规适用性；不得用「网页可访问」代替许可。

### 4.4 `cultural_ethical_reviewer`

- **交付物**：对宗教/伦理预设的文化准确性审查；确认「用户自定义原子排除**不替用户作身份判断**」；
  对撤回有争议预设、不删除历史用户事实的规则确认。
- **独立性证据**：同上。
- **工作量（粗估）**：计划 §4.4 的约 3 类原子规则（食材排除、来源未知阻断、交叉接触严格度）；
  不发布身份推断预设。
- **不得委托给项目自身**：文化准确性判定；不得由项目推断用户的宗教/伦理身份。

## 5. 未落实角色的后果

- 任一角色未具名、未确认、未独立、有冲突或未接受责任 → 该角色的队列不成立 →
  契约判定 `UNASSIGNED_OR_UNACCEPTED_AUTHORITY`；重复/冲突则 `CONFLICTED_OR_DUPLICATE_APPROVER`。
- 相应地，对应的数据类**不得 active**：没有权威 allergen 词表与绑定、没有经审的安全规则族，
  就没有任何一条过敏原/禁忌能被机器执行地阻断推荐。
- 因此：**推荐主干无法合法化**，对受限家庭只能恒返回 `no_feasible_option`（诚实的 fail-closed）。
- 延缓登记：`docs/governance/deferral-register.json` 的条目 `plan-4.3-named-roles`
  当前 `expiry` 为 `unassigned:待具名责任人与外部审核结论`，`admissionBasis` 为 `evidence-obligation`，
  且 `closeTrigger` 写明 **admission blocker**。只有当十二名角色全部具名且 §4.5 审查结论登记后，
  该条目才可能移出 `unassigned`；依 ADR-0009 §6.1，`unassigned:<理由>` 条目**不得跨过**
  `reviewByMilestone`（当前 `M2`）收口仍不转期或关闭。

## 6. 待产品负责人裁定（对应决策 4、5）

1. 十二个角色中，哪些由现有工程/产品角色承担，哪些必须**采购外部**？
2. `safety_approver` 是否**也必须为外部方**（契约 r4 §5.3 已强制其与
   `external_food_safety_reviewer` 必为不同自然人；此处问的是组织/利益独立性）？
3. `recipe_qa` 是否必须是外部方？
4. 外部预算与可用窗口是多少？（外部方无法在有界窗口内到位时，首次发布必须被正式收窄。）

以上四条在本简令中只提出问题与约束，不予自行裁定。
