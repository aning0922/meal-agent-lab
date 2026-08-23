# 阶段 09P：安全知识治理与确定性产品核心闭环

- 日期：2026-08-23
- 优先级：P0
- 状态：**Planning Accepted（2026-08-23），规划验收落点 `cff32929916592fa79d40c980564d3cc9a93fbeb`；implementation not started**
- 规划基线：`23450a1f3508e8030d753748291d265ad308df05`
- 关联决策：[ADR-0007：食品知识治理与确定性领域核心](../architecture/decisions/0007-food-knowledge-governance-and-domain-core.md)（`Accepted`，仅规划/架构方向）
- 前置阶段：[阶段 09A：本地可部署性与私有测试基线](2026-07-stage-09a-local-deployability-baseline.md)（`Accepted / Pass`）

本文件固化阶段 09P 的范围、依赖、门禁和实施顺序。规划已由总控 Accepted，ADR-0007
的规划/架构方向同时被接受；这**不表示阶段 09P 实施、任何里程碑或外部能力已
Accepted / Pass**。首个未来实施里程碑 09P-M0 当前仍为 `Not started`。

## 1. 事实基线与双轨命名

### 1.1 当前 Git 与阶段事实

- 当前 `HEAD`、本地 `main` 与 `origin/main` 的事实源都是
  `23450a1f3508e8030d753748291d265ad308df05`。
- `8b77ce311777b7be374aa5ed486bee8a40028ccc` 只是 PR #1 的普通 merge
  **集成落点**，不是当前 `main`。
- 阶段 09A 已于 2026-08-22 由项目总控记为 `Accepted / Pass`；M5 验收落点
  `efd186f`，最终 facts closeout run `32583959281` 在精确 HEAD `23450a1…`
  完成 `stage09a:check` 14/14、scripts tests 222/222、docs links 80 files /
  318 links。
- 09A 的计划、ADR、验收落点和历史证据均为冻结面，本阶段不重开、不改写。
- 当前只有家庭、成员/PersonProfile、hard constraint 登记和最小 exact-only
  库存纵切；没有权威食品映射、审核菜谱、菜单推荐、采购、完整做饭或 Agent 闭环。

### 1.2 双轨命名

总控已决定使用两个独立 workstream：

| Workstream | 名称 | 优先级 | 当前状态 |
| --- | --- | --- | --- |
| 阶段 09P | 安全知识治理与确定性产品核心闭环 | P0 | Planning Accepted；implementation not started |
| 阶段 09B | 私有测试服务器 | P1 conditional | Conditional / Not started；触发条件未满足 |

`09P` 的 `P` 表示 Product workstream，不表示它必须排在 09B 之后。两条线的
Decision state、Delivery state、证据和回滚边界必须分别维护，不再使用“09B/产品核心”
这种会混淆服务器交付与产品价值的合并状态。

云服务器、公网、合法域名、真实微信 AppID/AppSecret、真机、体验版、审核和发布
继续保持 `Deferred — 外部依赖`。09A 的本地部署成熟度不能替代这些证据，也不能
替代产品核心闭环进度。

## 2. 状态口径

| 状态 | 本计划中的含义 |
| --- | --- |
| **已决定** | 已由项目总控裁定，可作为规划约束；不等同于已经实现 |
| **Proposed** | 候选方案，必须经对应里程碑审查和总控接受后才能实施或激活 |
| **待验证** | 方向已形成，但没有运行、外部审查或用户证据 |
| **Deferred** | 明确不进入当前阶段，需要单独授权或外部条件 |
| **已知边界** | 已知未完成或存在限制，不能被门禁通过或管理估算掩盖 |

### 2.1 已决定

- 09P 是当前 P0，09B 是 P1 conditional。
- 先完成食品安全知识治理和确定性闭环，再讨论外部测试基础设施。
- 目标架构允许新增 `packages/domain`；本规划批次不创建该 package。
- `packages/contracts` 继续只表示跨端网络 DTO 和契约规则，不成为领域引擎。
- FoodConcept、allergen、宗教/伦理、食品安全和 cooking-technique 五类数据必须
  接受统一治理，不得由模型或临时自由文本代替。
- 过敏、宗教/伦理 hard rule、明确不可食用项和食品安全规则是硬约束；普通口味是
  软偏好。
- 首个未来实施里程碑是 09P-M0“数据治理契约与合成 fail-closed 内核”。
- M0 只使用完全合成数据，不导入真实食品事实，不创建 migration。

### 2.2 Proposed

- `packages/domain` 的具体 public API、依赖和实现设计。
- 首批验证数据的确切内容、地区适用范围、来源和审核人。
- “24 个 FoodConcept、4 个 allergen 类别、8 个 safety 规则族、8 个
  cooking techniques、12 道 recipes”仅是 **Proposed 候选覆盖规模**；它不是
  Accepted 数据范围，也不修改 PD-004 对完整 MVP 内容规模的长期决定。
- Meal/Recipe/Recommendation/Shopping 契约的精确字段变更和 migration 拆分。

### 2.3 待验证

- 外部食品安全、法律、文化/伦理和许可证审核角色能否到位。
- 候选数据源对首发地区和 `zh-CN` 用户界面的适用性。
- 候选规模能否覆盖零采购、有限采购、无可行结果、替代后重算等场景。
- 确定性组合、份量和 lot allocation 的实际可用性与性能。
- 新事务和锁序在真实 PostgreSQL 18 上的并发、恢复和 RLS 证据。
- 目标用户是否能以可接受成本维护库存并完成餐后确认。

### 2.4 Deferred

- 阶段 09B 私有测试服务器的实施。
- 云账号与服务器购买、托管 PostgreSQL、正式 Secret 管理、WAF 和监控。
- 公网、合法 HTTPS 域名、真实微信登录、真机、体验版、审核与发布。
- Agent、LLM、OCR、语音、图片识别、向量数据库和无人确认的写操作。
- 医疗营养、疾病治疗、食品外观/气味安全判断、完整营养跟踪。
- 100–300 道完整菜谱内容的批量交付；本阶段先证明小而受控的覆盖子集。

### 2.5 已知边界

- 当前所有 hard constraint 仍是 `needs_structured_mapping`；字符串或 UUID 形状
  校验不是权威映射。
- 应用进程重启后的未知命令恢复协议尚未完成，继续作为内部发布阻断项。
- 依赖审计的 local/weapp-only 例外仍阻断 H5、external-test、experience 和 release。
- “产品总体能力 25%–35%”只是管理/规划估算，**不是可审计验收指标**。
- 当前 `packages/contracts` 中的 Meal/Recipe/Recommendation/Shopping 主要是设计
  基线，尚无对应完整数据库、HTTP 与客户端纵切。

## 3. 阶段目标、用户价值与验收边界

### 3.1 目标

在完全本地、仅使用合成家庭和经过审查的第一批数据 release 的条件下，形成可重复、
可审计的确定性闭环：

```text
参与者与 hard constraints
  → 库存批次与事件
  → 经审查菜谱候选
  → 确定性安全过滤与组合
  → 用户确认本餐
  → 缺货进入采购
  → 已买待入库 / 确认入库
  → 做饭全部 / 部分 / 没做
  → 具体批次消耗
  → 剩菜形成新批次
  → 更新后的库存
```

### 3.2 用户价值

- 少量录入后获得不违反 hard constraints 的可执行菜单。
- 看见推荐依据、缺少项、库存覆盖和关键不确定性。
- 采购、入库、做饭、消耗和剩菜回库使用一条连续产品流。
- 多人并发、重复点击或丢响应不会重复入库、重复扣减或产生负库存。
- 无可行结果时显示明确 blocker 和可恢复动作，不编造菜谱。

### 3.3 非目标

- 不一次交付完整 100–300 道菜。
- 不引入微服务、消息队列、Redis、向量数据库或第二事实库。
- 不让模型决定过敏、宗教/伦理、食品安全、权限或库存最终写入。
- 不做公网、云、真实微信、真机或发布。
- 不把模拟器、本地 Docker 或远端 CI 冒充外部能力证据。
- 不修改阶段 09A 的冻结 migration、计划、ADR 和验收面。

### 3.4 成功定义

1. 第一批 active 数据 release 有来源、地区、语言、版本、许可、审核和撤回记录。
2. 本阶段固定 hard-constraint 反例语料中零漏放；这是语料验收，不宣称现实世界
   “绝对零风险”。
3. Recommendation 绑定库存、约束、菜谱和政策快照；任一事实漂移后旧推荐不能
   静默确认。
4. 采购入库、做饭消耗和剩菜回库均由幂等事务追加库存事件，不覆盖历史。
5. 一个 2–5 人合成家庭可以在本地完成连续 E2E。
6. `0005` 及后续 migration 延续 09A 的 checksum、权限、恢复和 N-1 门禁。
7. M0—M6 分别获得总控 Accepted，阶段总门禁在精确提交上通过。
8. 阶段 Pass 不包含任何云、公网、真实微信或发布能力声明。

### 3.5 验收边界

- 测试数据只允许完全合成或已确认授权的正式参考数据，不使用真实家庭数据。
- 本地产品 E2E 是 09P 的核心证据；外部测试不是本阶段成功条件。
- 实施提交只能报告 `Implemented`，不能自行写成 `Accepted`。
- 09P 本地 Accepted、阶段 Pass、Remote CI Pass 和外部能力 Pass 分开取证，见 §12。

## 4. 数据与安全治理

### 4.1 统一治理信封

五类正式数据必须使用同一份治理信封：

```text
datasetId
datasetKind
releaseId / releaseRevision / contentDigest
entityId / entityRevision
lifecycleStatus
owner
approvers[]
sourceTier
sourceReferences[]
sourceSnapshots[]
applicableRegions[]
languages[]
licenseStatus / licenseReference
retrievedAt / reviewedAt / reviewDueAt
aliases[]
supersededBy
withdrawalState / withdrawalReason / withdrawnAt
```

生命周期固定为：

```text
draft → under_review → approved → active
                         ├→ superseded
                         └→ withdrawn
```

只有 `active` revision 可用于正式推荐。`draft`、许可待定、审核未完成、引用版本
不存在、已撤回或来源地区不适用时必须 fail closed。

### 4.2 来源等级

| 等级 | 来源 | 运行时资格 |
| --- | --- | --- |
| L1 | 官方监管机构、适用标准、原厂/包装对具体产品的明确声明 | 经地区、版本和许可审核后可作为安全事实 |
| L2 | 经确认的专业机构、行业标准或专业资料 | 需 Safety Approver 批准，不能覆盖更高等级事实 |
| L3 | 有许可内容、内部原创且经双人审核的菜谱/烹饪资料 | 可用于内容；安全关键字段仍需专门审核 |
| L4 | 用户输入、模型生成、搜索结果、未审网页或探索资料 | 只能作为待确认输入或研究线索，不能成为权威规则 |

### 4.3 五类治理责任

所有 owner 和 approver 在进入 M1 前必须落实到具体责任人；角色名本身不构成审核证据。

| 数据类 | Owner | 批准人 | ID、别名和弃用 | 紧急撤回与 fail-closed |
| --- | --- | --- | --- | --- |
| FoodConcept | Knowledge Data Steward；技术保管人为 Domain Owner | Product Owner；涉及 allergen/safety 时还需 Safety Approver | 保留小写 UUIDv7；revision 单调递增；别名带地区/语言/来源；只用 `supersededBy`，ID 永不复用 | 撤回发布更高 release revision；未映射食材可显示在库存，但不得进入需要 hard 判定的推荐 |
| allergen | Allergen/Safety Data Steward | 外部食品安全审核人；法律/合规确认地区适用性 | 内部 UUIDv7 + 外部 namespaced code；外部代码变化不改内部 ID | 明确含有、`mayContain`、严格交叉接触、映射未知或版本失配时阻断相关候选 |
| 宗教/伦理 | Product Policy Steward | Product Owner + 文化/伦理审核人；必要时法律审核 | 保存可计算的原子规则；群体预设只能是用户确认的建议，不推断身份 | 用户声明为 hard 的规则未映射时阻断；撤回有争议预设，不删除历史用户事实 |
| 食品安全 | Food Safety Steward | 外部合格食品安全审核人；法规宣传由法律审核 | 稳定 policy rule ID + revision；地区、储存条件、事件前提和有效期属于规则 | 高风险且储存/开封/冷链/版本未知时不进入候选；包装/厂家明确说明优先 |
| cooking-technique | Culinary Content Steward | Recipe QA；安全关键技术另需 Safety Approver | 稳定 technique UUIDv7；名称/别名带语言；设备与安全关键标记独立版本 | 缺少安全关键能力、设备或步骤时不得标记可执行；普通难度只按已决定规则处理 |

引用快照只保存验证事实所需的最小内容、定位信息、获取时间和 hash，不因网页可访问
就复制整份版权内容。`licenseStatus` 至少区分 `approved`、`restricted`、`pending`、
`rejected`；后两者不能 active。撤回和恢复都通过新 release 发布，不静默改写历史。

### 4.4 Proposed 第一批覆盖规模

以下数字只用于 M1 评估工作量和覆盖度，**不是已决定或 Accepted 的数据范围**：

| 数据 | Proposed 候选规模 | 候选覆盖目标 |
| --- | ---: | --- |
| FoodConcept | 24 | 覆盖候选 recipes 的主料、辅料、调味品、E2E 五个 lot 和至少一个替代关系 |
| allergen | 4 个经外审批准的类别 | 调味品隐藏路径、`mayContain` 和 unknown mapping；类别名称在外审前不锁死 |
| 宗教/伦理 | 3 类原子规则 | 食材排除、来源未知阻断、交叉接触严格度；不发布身份推断预设 |
| 食品安全 | 8 个规则族 | 包装日期、用户录入、unknown、过期高风险、开封、冻融、制作/剩菜、冷链存疑 |
| cooking-technique | 8 | 至少一个安全关键技术、unknown 能力和非安全软难度场景 |
| Recipe | 12 | 1—3 道组合；零采购、有限采购、无可行结果和替代后重算 |

M0 不使用上述真实内容，只使用完全合成 ID、来源、许可和规则样本。M1 必须根据
外部审查结论重新提交精确内容和数量供总控裁定。

### 4.5 必须外部高准确性审查的内容

- allergen 的适用分类、标签语义、`mayContain` 和交叉接触解释；
- 开封、储存、冷冻、解冻、制作和剩菜规则；
- 食品安全宣传措辞、地区法规适用性和中文解释；
- 宗教/伦理预设的文化准确性；用户自定义原子排除不替用户作身份判断；
- 外部菜谱、图片、标准文本和知识数据的复制、转换和再发布许可；
- 任何可能被理解为医疗、疾病治疗或儿童专项建议的内容；本阶段默认不纳入。

## 5. 领域与目标架构

### 5.1 现有 contracts 的保留、修改和废弃候选

这些变更均为 Proposed，必须在对应里程碑冻结后才实施。

| 契约 | 保留 | 修改候选 | 废弃/替换候选 |
| --- | --- | --- | --- |
| Recipe | ID、正整数 version、审核/退役状态、份数、dish role、步骤、时间、难度、来源 | release/content digest、reviewer、地区/语言、technique/equipment concept ID、安全控制点、替代组和撤回状态 | free-string `requiredEquipment`；把手填 `allergenCodes` 当第二权威来源 |
| Meal | Household 私有、参与者、厨师、1—3 道菜、状态、version | recommendation/recipe/constraint snapshot、execution/completion receipt 和显式状态命令 | 仅凭状态字符串推进流程的隐式更新 |
| Recommendation | `options/no_feasible_option`、候选、blocker、assumption、时间/采购容忍度 | 完整 inventory/constraint/recipe/policy snapshot、lot allocation、规则回执 | 单值 `inventorySnapshotVersion`、单值 `constraintSnapshotVersion`、不可审计的 `status: passed` |
| ShoppingItem | Household 私有、来源、已买待入库/已入库分离、version | 来源数量拆分、merge group、expectedVersion、入库 receipt | 无冲突语义的隐式合并和自由数量覆盖 |

当前没有已部署消费者时，可以按既有预发布例外同步升级仓库内 contracts/API/client，
但 package version、OpenAPI 和所有消费者必须在同一冻结点更新；发现外部消费者时必须
立即复审 API 版本策略。

### 5.2 `packages/domain` 目标职责

ADR-0007 已接受未来新增 `@meal-agent/domain` 的目标职责；该 package 当前尚未创建：

- FoodConcept/Allergen/Technique/Policy 内部值对象和解析结果；
- 库存事件 reducer、lot allocation 和状态机；
- hard constraint 与食品安全确定性评估；
- 菜谱份量缩放、候选组合和排序；
- Meal、Shopping、Cooking 状态迁移；
- 稳定 reason/blocker code。

明确禁区：

- 不定义 HTTP request/response DTO；
- 不定义 Drizzle row 或 SQL；
- 不依赖 Fastify、Taro、微信、数据库、Node I/O 或模型 SDK；
- 不持有家庭私有数据或执行网络/文件/数据库副作用；
- 不把 Zod DTO schema、模型输出或外部自由文本当作领域引擎。

依赖方向：

```text
data release ──> packages/domain 纯规则
                         │
packages/contracts <─ mapper ─> services/api application/persistence
                                        │
                                        └──> PostgreSQL
apps/client <──────── HTTPS DTO ────────┘
```

### 5.3 全局与 Household 私有边界

| 数据 | 范围 | 版本和审计边界 |
| --- | --- | --- |
| FoodConcept、Allergen、Technique、Safety Policy、Recipe revision | 全局只读参考数据 | immutable revision；active release pointer；发布由受控导入/migration 身份完成 |
| Recommendation、Meal、Shopping、InventoryLot/Event | Household 私有 | non-null householdId、复合外键、FORCE RLS、actor、idempotency、version |
| PersonProfile constraints | Household 私有且字段敏感 | 原文留在 profile 边界；推荐只保存 constraint digest 和必要 blocker code |
| Recommendation evidence | Household 私有 | 可保存规则 ID、数据版本和结果；不记录成员姓名或私密约束原文 |

全局 Recipe 不能包含家庭、成员、消费或推荐数据。Meal 固化所选 Recipe revision，
后续 Recipe 更新不能改写历史餐次。

### 5.4 Recommendation 快照

建议形成统一 snapshot reference：

```text
inventory:
  sorted [{ lotId, lotVersion, foodConceptRevision, safetyAssessmentRevision }]
  inventoryDigest

constraints:
  sorted [{ participantProfileId, profileVersion, constraintSetDigest }]
  mappingReleaseId
  constraintDigest

recipes:
  sorted [{ recipeId, recipeVersion, contentDigest, datasetReleaseId }]
  recipeDigest

policies:
  foodConceptReleaseId
  allergenReleaseId
  religiousEthicalReleaseId
  foodSafetyReleaseId
  techniqueReleaseId
  recommendationEngineVersion
  policyDigest

snapshotDigest:
  canonical SHA-256 of the four sections
```

确认菜单时重新读取并比较全部 revision/digest。lot、成员约束、Recipe、撤回清单或
安全政策任一变化都返回稳定 conflict 并要求重算。

### 5.5 事务、幂等、锁序与恢复

所有核心产品写入采用统一锁序：

```text
completed idempotency replay
→ session / household bootstrap
→ household product-flow advisory
→ idempotency marker
→ participant profile rows，按 ID 排序，FOR SHARE
→ recommendation / meal row
→ shopping rows，按 ID 排序
→ inventory lot rows，按 ID 排序
→ append InventoryEvent / create leftover lots
→ projection + receipt
→ commit idempotency result
```

任一写路径不得先锁 inventory 再回头锁 meal/profile。MVP 先采用“每家庭产品流写命令
串行”的保守边界；只有出现真实性能证据后才允许细分锁。

| 命令 | 事务边界 | 幂等和恢复 |
| --- | --- | --- |
| 生成推荐 | 读取一致快照，不写库存 | 保存 snapshot digest；失败不产生半个 Recommendation |
| 确认菜单 | 重验四类快照，创建/推进 Meal | 同 key/body 回放同一 Meal；漂移返回 409 并重算 |
| 加入采购 | 缺少项转 Shopping sources；合并保留来源拆分 | 同来源只能加一次；key 换 body 返回冲突 |
| 标记已买 | 只推进 Shopping 状态，不隐式入库 | 乐观 version；多人同时勾选只成功一次 |
| 确认入库 | lot + acquired event + shopping receipt 同事务 | 任一失败整体回滚，不显示已入库 |
| 开始/恢复做饭 | 更新 execution 状态，不扣库存 | 进度 versioned；退出不隐式完成 |
| 完成一餐 | completion + consume events + leftover lots/events 同事务 | “没做”零消耗；lot 冲突时整体回滚并重算 |

客户端继续保存不可变 command snapshot 和原 idempotency key。进程内丢响应通过同 key
重试恢复；应用进程重启后的 non-sensitive locator + command status/receipt 若未实现，
继续登记为内部发布阻断，普通 GET 不能证明命令结果。

## 6. `0005` migration 与 N-1 恢复责任

`0000`—`0004` 永久冻结。M2 首次需要数据库变化时只追加 Proposed 文件：

```text
0005_stage_09p_knowledge_inventory.sql
```

文件名和精确内容必须在 M1 Accepted、inventory/domain/contracts 设计冻结后由总控确认；
本规划不提前创建 SQL。候选范围只应覆盖已冻结的全局 knowledge release/revision 边界、
FoodConcept 绑定和必要 inventory 扩展，不提前创建尚未冻结的 Meal/Shopping 表。

`0005` 一旦存在，必须同时取得：

1. 空库 `0000 → … → 0005` 证据；
2. 真实 `0004 → 0005` 增量升级证据；
3. 保留 `[0000…0004] × containment/final` manifest；
4. 新增 `[0000…0005] × containment/final` manifest；
5. 用完全合成数据生成 `0004` N-1 archive；
6. 执行并记录：

```text
校验 archive SHA/TOC
→ pg_restore(0004)
→ containment(0004)
→ db:migrate(0005)
→ final grants(0005)
→ ready / catalog / RLS / ACL / data final verify
```

7. checksum 漂移、缺 ledger 状态、缺 containment manifest 或多余权限全部 fail closed；
8. migration 事务失败整体回滚；候选发布后不提供恢复旧不安全状态的 down migration，
   只允许追加 roll-forward 修复。

后续每个 migration 都重新建立自己的 N-1 跨 ledger 证据，不得只沿用 `0005` 的报告。

## 7. M0—M6 有序里程碑

### 7.1 范围与冻结面

| 里程碑 | 输入依赖 | 范围与交付物 | 非目标 | 冻结面 |
| --- | --- | --- | --- | --- |
| **09P-M0 治理契约与合成 fail-closed 内核** | 本计划与 ADR-0007 经总控 Accepted | `packages/domain` 纯规则边界；治理 schema；五类完全合成样本；ID/version/alias/withdrawal/snapshot 校验；M0 gate | 不导入真实食品事实；不改 contracts/API/DB/client；不建 migration | 治理信封、source tier、生命周期、fail-closed 结果类型、domain 职责 |
| **M1 首批知识发布与安全规则** | M0 Accepted；外部审核角色/来源确认 | 首批知识 release、经审查 recipes、release digest、确定性 hard filter | 不完成 100—300 道菜；不做 UI/库存写入/菜单组合 | active release、规则 ID、审核/撤回语义、安全反例语料 |
| **M2 完整库存批次/事件与 0005** | M1 Accepted；inventory/domain/contracts 设计冻结 | FoodConcept 绑定、模糊/精确数量、日期来源、开封/冻融/produced、调味品；DB/API/client；0005/N-1 | 不做菜单组合、采购或做饭 | Inventory DTO、event reducer、锁序、0005 checksum/manifest |
| **M3 菜谱与确定性菜单候选** | M2 Accepted；首批 Recipe active | Recipe revision；snapshot-bound Recommendation；零采购/有限采购/no-feasible；API/client 候选页 | 不写采购、不扣库存、不调用模型 | Recipe/Recommendation DTO、snapshot digest、blocker/reason code |
| **M4 菜单确认与采购闭环** | M3 Accepted | Meal 确认；Shopping source/merge；已买待入库；确认入库生成 lot/event；API/client/E2E | 不推进做饭或消耗 | Meal/Shopping 状态机、merge、入库 receipt、事务/锁序 |
| **M5 做饭、消耗与剩菜回库** | M4 Accepted | 做饭进度；全部/部分/没做；逐 lot 确认；consume events；leftover lot；冲突重算 | 不做 Agent、语音、计时器或偏好学习 | Completion command、原子事务、leftover provenance、恢复边界 |
| **M6 完整本地 E2E 与收口** | M0—M5 Accepted | 2—5 人合成家庭连续 E2E；客户端状态；安全/并发/未知结果；总门禁、文档、看板证据 | 不创建私服、不接真实微信、不宣称发布 | 全阶段契约；只允许缺陷修复，不加新范围 |

### 7.2 门禁、回滚与 Accepted 条件

| 里程碑 | 门禁 | 失败/回滚边界 | 总控 Accepted 条件 |
| --- | --- | --- | --- |
| **M0** | domain unit、治理 schema、canonical digest、invalid fixtures、docs links、09A 回归 | 未集成 branch/worktree 可丢弃；合成 release 未发布可替换 | 精确 SHA、clean tree、范围零漂移；独立静态 A CLEAN；总控复验 |
| **M1** | provenance/license、active 数据双审、hard matrix、withdrawal/version mutation、determinism | 失败数据保持 draft/rejected；已发布 release 只用新 revision 更正 | 外部安全/许可审查完成；独立 A 静态 + B 动态 CLEAN |
| **M2** | contracts、DB、HTTP、client、RLS、concurrency、0004→restore→0005、stage09a 回归 | migration 事务失败回滚；候选发布后只 roll-forward | N-1/权限 manifest 有真实 PostgreSQL 证据；A/B CLEAN |
| **M3** | Recipe provenance、snapshot drift、no-feasible、hard negatives、HTTP/client | 旧 Recommendation 只失效，不回写库存或降级自由文本 | 每个候选可追溯四类快照；安全 A/B CLEAN |
| **M4** | Meal/Shopping contract、并发、幂等、跨家庭隔离、入库原子性 | 任一入库失败整体回滚；不把已买冒充已入库 | API/DB/client/E2E 全绿；独立并发/权限审计 CLEAN |
| **M5** | completion matrix、逐 lot 冲突、负库存、lost response、leftover provenance | 任一事件失败整餐不提交；同 key 安全重放 | 事务、并发、幂等和安全 A/B CLEAN |
| **M6** | unit→E2E 全层 gate、合成完整旅程、文档链接、Secret/真实数据扫描、clean checkout | 未集成候选可丢弃；已接受 migration/release 只追加修复 | M0—M5 Accepted；精确 HEAD 全门禁；总控 Accepted；远端/main 后才可阶段 Pass |

### 7.3 第一个可实施里程碑

M0 是第一项可实施工作，而不是 `0005` 或批量菜谱。它不需要真实食品事实、数据库、
API、客户端、云或凭据，却能机械阻断无来源、无许可、无版本、已撤回和无法映射的
数据，为后续 contracts、migration 和多 Agent 并行建立可冻结边界。

## 8. 阶段 09B 私服重新入队条件

以下条件必须全部满足：

1. M6 已本地 Accepted，产品闭环确实需要跨设备或长时运行验证；
2. 09P 候选已在远端 CI 的精确 HEAD 通过；
3. 当前依赖审计例外已关闭，或被新的正式决策明确允许 `external-test`；仅“未到期”
   不构成允许；
4. 测试对象、期限、数据类型、操作人、预算上限和销毁日期明确；
5. 云账号/IAM、地区、网络暴露、SSH 隧道、Secret、备份和销毁方案完成安全审核；
6. 用户单独授权创建资源和费用；
7. 09B 仍为私有、非公网；真实微信/域名需另开外部能力任务。

任一条件缺失，09B 保持 `Conditional / Not started`，不影响 09P 状态。

## 9. 单线、多 Agent 与 worktree 策略

### 9.1 必须单线/总控完成

- 阶段范围、状态和 ADR；
- 五类治理契约、source tier、active/withdrawn 语义；
- `packages/contracts` 公共 DTO；
- `packages/domain` public API 和 reason code；
- migration、authorization manifest、RLS、复合外键和锁序；
- 食品安全总规则和 hard-constraint 反例矩阵；
- root workspace/lockfile、generated OpenAPI、阶段总门禁；
- Accepted、集成顺序、main/PR/远端 CI 和看板状态。

这些共享面未冻结前，禁止多个 Agent 并行实现。

### 9.2 契约冻结后可并行

| 任务 | 最早开始点 | 建议分支 | 允许文件范围 | 禁止交叉写入 |
| --- | --- | --- | --- | --- |
| M1 数据整理 | M0 Accepted | `codex/stage-09p-m1-data` | `data/reference/**`、数据 tests | domain public API、contracts、migration |
| M1 规则测试 | M0 Accepted | `codex/stage-09p-m1-domain-tests` | `packages/domain/tests/**`、synthetic fixtures | active 数据、public exports |
| M2 库存纵切 | M1 Accepted、0005 设计冻结 | `codex/stage-09p-m2-inventory` | 指定 inventory contracts/domain/API/client/tests | migration 只有 migration owner 可写 |
| M3 菜谱内容 | M1 Accepted | `codex/stage-09p-m3-recipes` | `data/reference/recipes/**`、provenance | Recommendation schema/engine |
| M3 推荐实现 | contracts 冻结 | `codex/stage-09p-m3-recommendation` | 指定 domain/API/client/tests | 治理 schema、migration、safety policy |
| M4 采购客户端 | HTTP contract Accepted | `codex/stage-09p-m4-shopping-client` | Shopping client/page tests | DB schema、API command contract |
| M5 做饭客户端 | Completion contract Accepted | `codex/stage-09p-m5-cooking-client` | Cooking client/page tests | settlement transaction、event 语义 |
| 独立审计 | 候选 SHA 冻结 | 不写实现分支 | 只读；报告独立输出 | 不修代码、不改候选 HEAD |

每个任务使用独立 worktree，从最近一个总控 Accepted 的精确 SHA 创建。分支统一
`codex/` 前缀；实施者不自行 Accepted，不 push/merge/PR，除非用户另行授权。

禁止交叉写入面包括：`packages/contracts/**`、`packages/domain` public exports、
migration、authorization manifest、`docs/safety/**`、root lockfile 和 generated OpenAPI。

固定集成顺序：

```text
ADR / 治理契约
→ domain public boundary
→ contracts
→ data release
→ migration / DB
→ API
→ client
→ E2E
→ docs / status / dashboard
→ 独立审计
→ 总控 Accepted
```

## 10. 分层门禁

| 层 | 必须验证 |
| --- | --- |
| Unit/domain | ID/version/alias、release digest、规则解析、inventory reducer、份量、lot allocation、状态机、排序确定性 |
| Contract | Zod runtime/TS/OpenAPI parity、stable rule ID、fixed decimal、strict object、unknown/withdrawn、consumer sync |
| Database | empty/incremental migrate、N-1 restore、checksum、ACL/RLS、复合 FK、immutable revision、event projection、locks、无负库存、跨家庭反向测试 |
| HTTP | session/household/capability、redaction、idempotency same/different body、expectedVersion、snapshot conflict、atomic failure、stable problem code |
| Client | 空/加载/未知/失败/无权限/冲突/安全阻断、command snapshot/key、全部/部分/没做、离页恢复、无隐式写入 |
| E2E | 2—5 人合成家庭、至少五个 lot、hard constraint、菜单、采购、入库、做饭、消耗、剩菜、最终库存、并发、丢响应 |
| Safety | 主料/辅料/调味品/替代品/`mayContain`、高风险 unknown、withdrawal、policy drift、冻融/开封/剩菜、模型绕过 |
| Docs/audit | 来源/许可/地区/版本、状态、HEAD/run、回滚边界、链接、Secret/真实用户数据扫描 |

建议逐级建立 `stage09p:m0:check`、`stage09p:m1:check` 至 `stage09p:check`。新增
门禁不得削弱 `stage09a:check`；涉及 workspace、依赖、Docker、migration 或权限时，
最终候选仍需跑完整 09A 回归。

## 11. 食品安全与 hard constraint 反例矩阵

| 反例 | 预期 |
| --- | --- |
| 任一实际参与者有明确冲突 | 阻断；不能只检查创建者 |
| 冲突出现在主料或辅料 | 阻断 |
| 冲突出现在调味品 | 阻断 |
| 替代食材引入冲突 | 替代后重算并阻断 |
| `mayContain` 命中严格规则 | 阻断并返回稳定 reason code |
| FoodConcept/allergen 映射 unknown | 不产生通过 hard check 的候选 |
| 映射或政策 withdrawn | 旧推荐确认失败并重算 |
| 用户确认的宗教/伦理 hard rule 命中 | 阻断；模型不能解释或放宽 |
| 来源地区或政策版本不适用 | unknown/blocked，不套用 |
| 高风险 lot 储存、开封或冷链 unknown | 不进入候选 |
| 冻结/解冻/开封事件顺序非法 | 写入拒绝或安全评估 blocked |
| 剩菜缺 producedAt/storage/provenance | 不允许 eligible 回库 |
| 缺安全关键 technique/equipment | 不标记为可执行 |
| 参与者、inventory、Recipe 或 policy 在确认前变化 | snapshot conflict，重算 |
| 两成员同时消耗同一 lot | 一方成功，另一方冲突；不负库存 |
| 完成事务中一个 lot 失败 | 整体回滚，不能显示完整成功 |
| 丢响应后同 key 重试 | 回放同一结果，不重复事件 |
| 模型/Agent 试图绕过规则 | application/domain 再次阻断；模型无权限 |

## 12. A/B 审计与证据口径

### 12.1 审计触发条件

- Audit A：静态审查架构、数据治理、来源/许可、contracts、migration、权限、锁序
  和隐私边界。
- Audit B：在精确 HEAD 动态执行 gate、mutation、恢复、RLS、并发、lost-response
  和 E2E。

active 食品安全/allergen 数据、hard-constraint 引擎、migration/RLS、Recommendation
安全快照、Meal completion/leftover 事务以及 M6 最终候选必须 A/B 双审计。

纯规划文档、不改变规则的看板/文案、完全合成且未激活的 M0 格式样本不需要双审计；
M0 至少需要一次独立静态 A。若 M0 扩大到运行时安全决策，自动升级为 A/B。

两个审计必须针对同一完整 40 位 SHA、与实施者独立、只读候选，并报告
`CLEAN/BLOCK`、范围、实际命令和证据位置。BLOCK 后的新提交必须重新审计。

### 12.2 状态与证据差异

| 状态 | 必需真实证据 |
| --- | --- |
| Implemented | 精确提交、clean worktree、范围内 tests；实施者可报告但不能 Accepted |
| Milestone Accepted | 总控复验精确 SHA；所需 A/B CLEAN；交付、gate 和回滚边界完整 |
| 09P 本地 Accepted | M0—M6 Accepted；完整 `stage09p:check` 在 clean checkout 通过；文档/状态收口 |
| 09P 阶段 Pass | 本地 Accepted 后获授权集成 main；远端 CI 在精确 main SHA 成功；事实源收口 |
| Remote CI Pass | 真实 run ID、head SHA、job conclusion 和日志；不能由本地 gate 推断 |
| 外部能力 Pass | 云、网络、域名、微信、真机、体验版等分别提供真实外部证据；本地/CI 不能替代 |

## 13. 本地总控看板的后续独立更新映射

看板事实源位于主工作树 `.local/project-progress-dashboard/`，是独立本地 Git 仓库，
不依赖 GitHub Projects 或 `read:project` scope。本规划批次不得修改、提交、stash 或
清理它；看板更新必须在本候选总控复核后单独授权，并保留其现有用户未提交内容。

| 需要字段 | 现有结构 | 后续修改性质 |
| --- | --- | --- |
| Workstream | `productTrack` / `deliveryTrack` | 扩展为 09P product-core 与 09B private-server |
| Milestone | `Milestone.name/summary` | 扩展 M0—M6，保留 09A 历史 |
| Decision state | 当前与 `Status` 混合 | 新增 decided/proposed/needs-validation/deferred |
| Delivery state | 当前 `Status` | 拆出 not-started/in-progress/implemented/review/accepted/blocked |
| Safety criticality | 无 | 新增 hard-safety/data-integrity/privacy/normal |
| External dependency | deferred/gaps/track 文本 | 结构化 dependency kind/state/owner/evidence |
| Evidence HEAD/run | `sha` / `gitTracks` / `phaseEvidence` | 扩展完整 HEAD、run、gate/result/scope |
| Data provenance/license | 无 | 新增 dataset release、license/source/review state |
| Owner/reviewer | `parallelLanes.agent` | 扩展每项 owner/approvers/auditors |
| Rollback boundary | 无 | 新增 code/data/migration/external rollback |

看板中的 25%—35% 必须继续标记为管理估算，不得改成阶段门禁或 Accepted 百分比。

## 14. 09P-M0 可复制实施任务书

```text
任务名称：
阶段 09P-M0 / 数据治理契约与合成 fail-closed 内核

实施基线：
<PENDING_TOTAL_CONTROL_ACCEPTED_PLANNING_SHA>

基线规则：
- 当前规划事实基线 23450a1f3508e8030d753748291d265ad308df05 不能直接
  作为 M0 的最终实施基线。
- 本规划已在 `cff32929916592fa79d40c980564d3cc9a93fbeb` 上 Accepted；总控将在
  新建 M0 会话时以上述规划的状态收口后精确 HEAD 替换占位符，并重新签发任务书。
- 未取得该精确 SHA 前不得创建 M0 worktree 或开始实现。
- 不得自行 rebase 到未验收 HEAD。

建议分支：
codex/stage-09p-m0-governance-contract

目标：
建立 FoodConcept、allergen、宗教/伦理、食品安全、cooking-technique 五类数据共用的、
可执行的治理信封，并建立纯 TypeScript 的 packages/domain 边界。M0 只用完全合成数据
证明：缺来源、缺许可、缺地区/语言、版本不一致、别名冲突、引用已撤回实体或无法
映射时确定性 fail closed。

允许范围：
- 新增 packages/domain/**
- 新增 data/schemas/**
- 新增 data/samples/** 中的完全合成样本和反例
- 修改 data/README.md、packages/README.md
- 为接入 workspace，允许修改 package.json、pnpm-workspace.yaml、pnpm-lock.yaml
- 允许新增 stage09p:m0:check 及其 scripts/tests
- 交付末尾只把 docs/project-status.md 更新为 Implemented / pending review，不写 Accepted

必须交付：
1. @meal-agent/domain 纯 TypeScript package；不依赖 Fastify、Drizzle、Taro、Node I/O
   或模型 SDK，不定义 HTTP DTO 或数据库 row。
2. GovernanceEnvelope：owner/approvers、source tier/reference/snapshot、regions/languages、
   license、stable ID/revision、release/digest、aliases/supersededBy、lifecycle/withdrawal。
3. 五类完全合成 valid samples。
4. Invalid fixtures：missing source/license/region/language、alias conflict、reused ID、
   unknown revision、withdrawn reference、release digest mismatch、hard mapping unresolved。
5. 稳定结果：mapped/unmapped/withdrawn/version_mismatch/unapproved。
6. 相同输入产生逐字节相同 canonical release digest。
7. pnpm stage09p:m0:check。

禁止：
- 不导入真实食品、allergen、宗教/伦理、安全或菜谱事实。
- 不修改 packages/contracts、services/api、apps/client、migration、schema、authorization
  manifest、OpenAPI 或 generated 文件。
- 不开始 Recipe/Recommendation/Meal/Shopping 实现。
- 不修改 09A 计划、ADR-0004/0005/0006 或验收证据。
- 不创建云资源，不请求/写入真实 Secret，不开放公网，不 push/merge/PR。
- 不把实施结果自行写成 Accepted。

测试：
- pnpm --filter @meal-agent/domain check
- pnpm stage09p:m0:check
- pnpm check
- pnpm docs:links:check
- pnpm stage09a:check
- git diff --check
- 在精确提交后的 clean worktree 重跑；不得 skip/todo/放宽断言或伪造计数。

提交纪律：
- 独立 worktree；分支 codex/stage-09p-m0-governance-contract。
- 1—3 个内聚 append-only 提交；审计候选冻结后不得 amend，整改追加新提交。
- 保留不属于本任务的用户改动；未经授权不 push/merge/PR。

审计：
- 至少一个独立静态 Audit A；只读检查 package 边界、治理语义和 fail-closed。
- 若范围扩大到运行时安全决策，自动升级为 A/B。

总控 Accepted 条件：
- 范围零漂移、final HEAD clean、实际测试全部通过、样本完全合成、无外部变化、
  Audit A CLEAN；只有总控在同一 SHA 上复验后才可 Accepted。

交付报告：
1. baseline / final SHA
2. branch / worktree 绝对路径
3. commits / changed files
4. 已完成、未完成、Deferred
5. 每条测试命令、退出码和实际计数
6. safety negative results / synthetic-data proof
7. git status --short
8. 外部状态变化必须为“无”
9. 建议审计范围
10. 只能请求总控复验，不得自行 Accepted
```

## 15. 本规划 Accepted 的完成边界

本规划固化批次完成时：

- 09P 状态为 `Planning Accepted（2026-08-23）/ implementation not started`，规划
  验收落点为 `cff32929916592fa79d40c980564d3cc9a93fbeb`；
- ADR-0007 的规划/架构方向为 `Accepted`，不授权实施；
- 09P-M0 保持 `Not started`；
- 09B 保持 `Conditional / Not started`；
- 外部能力保持 `Deferred`；
- 09A 保持 `Accepted / Pass` 且冻结；
- 不创建 `packages/domain`、migration、数据 release、服务器或凭据；
- 不修改独立本地看板；
- 只有总控新建 M0 会话并重新签发状态收口后的精确实施基线，才能开始 M0。
