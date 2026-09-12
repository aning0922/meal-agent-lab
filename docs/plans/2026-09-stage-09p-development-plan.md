# 阶段 09P：开发计划（外部关键路径与有界工程）

- 日期：2026-09-12
- 优先级：P0
- 状态：**执行层开发计划。本文件不构成任何里程碑 Accepted，不冻结任何合同/迁移/数据，
  不授权实现，也不改变任何既有门禁结论。**
- 事实基线：`main` @ `23450a1f3508e8030d753748291d265ad308df05`（Git 索引事实源）。
- 能力现状：[功能盘点（按能力逐项）](../product/capability-inventory.md)。
- 关联决策：[ADR-0009：设计门禁的停止谓词与延迟项纪律](../architecture/decisions/0009-review-acceptance-and-deferral-discipline.md)
  （`Accepted`，2026-09-12）、[ADR-0007](../architecture/decisions/0007-food-knowledge-governance-and-domain-core.md)、
  [ADR-0008](../architecture/decisions/0008-stage09p-m0-evidence-boundary.md)。
- 计划事实源（of record）：[阶段 09P：安全知识治理与确定性产品核心闭环](2026-08-stage-09p-safe-deterministic-product-core.md)
  （Planning Accepted）。本文件是它的**执行层展开**，不是替代；两者冲突时以 of record 为准。
- 配套一页决策请求：[2026-09-stage-09p-owner-decision-request.md](2026-09-stage-09p-owner-decision-request.md)。

## 1. 背景与瓶颈

### 1.1 绑定约束：首个 release 的瓶颈不是代码

首个 release 的目标是：让受过敏/硬约束限制的家庭拿到一份**不违反其硬约束**的菜单
（`docs/product/mvp.md:50`，「发布阻断条件」第 1 条）。今天卡住这件事的**不是**代码
工作量，而是一条**组织/外部链路**——它不在代码路径上，且**无界**：

- 一个权威的食品知识来源（allergen 词表、FoodConcept、食品安全规则族）；
- 十二个角色各自落到具名自然人并接受责任（计划 §4.3；递延登记表条目
  `plan-4.3-named-roles`；闭集见冻结的 M1 就绪契约
  `stage09p-m1-minimal-deterministic-readiness-contract-r4`（`M1-MINIMAL-1R4`）§3.3）；
- 计划 §4.5 的**外部高准确性审查**（allergen 分类/标签语义、开封/储存/冷冻/解冻/剩菜
  规则、法规适用性与中文措辞、文化/伦理准确性、复制/再发布许可）；
- **G2 admission**（真实 source 治理/许可/版本/激活的正式批准事实）。

这条链路**不能由内部审计、合成数据或工程替代**（计划 §4.5 的「必须外部高准确性审查」；
计划的 §12 亦把外部能力列为与本地/CI 分开取证的独立一腿）。
本计划因此把「外部班底落实」列为**最早启动**的真关键路径（见 §3），并诚实地承认：
关键路径的很大一部分**不是工程**。

### 1.2 杀死「无词表增量」这条捷径的三条已核验理由

一个看似安全的捷径是：先给**没有硬约束**的家庭构建推荐器，把过敏过滤器保持 fail-closed。
**它不是安全捷径**，有三条互相独立的、可复核的理由：

1. **`foodConceptId` 是菜谱与库存之间唯一的 join key，而它在真实数据上是死的。**
   契约要求它（`packages/contracts/src/meals.ts:19`，`recipeIngredientSchema` 的
   `foodConceptId: foodConceptIdSchema`），但仓储层永远写
   `request.foodConceptId ?? null`（`services/api/src/database/repository.ts:1273`），
   客户端从不发送它，读回时 mapper 在为空时**整体省略**该字段
   （`services/api/src/database/mappers.ts:310-312`）。于是「按库存计算缺少项」只能退化为
   **`displayName` 字符串匹配**，而设计层已判定字符串/UUID 形状不构成机器可执行映射、
   不得作为权威依据（`packages/contracts/src/identity.ts:228-230`）。这同时触及
   `docs/product/mvp.md:51`「漏检主料/辅料/调味品/替代品中的硬约束」。
2. **私有硬约束被从可见性投影中剔除。** 脱敏投影 `mapRedactedPersonProfile` 只保留
   `visibility === "household"` 的约束，其余（`subject_and_owner`，即仅本人与 owner
   可见的私有约束）被整体丢弃（`services/api/src/database/mappers.ts:245-259`；函数注释亦
   写作「先剔除 subject_and_owner 约束」）。`visibility` 在契约上是二值枚举、两值皆合法
   （`packages/contracts/src/identity.ts:232`），且 `household` 是客户端默认值
   （`apps/client/src/pages/profile/index.tsx:94`）；migration `0004` 亦分别统计
   `household`+`hard` 与 `subject_and_owner`，证明前者是合法态
   （`services/api/migrations/0004_stage_08_final_closeout.sql:488-492` 统计 `household`+`hard`、
   `:497-499` 统计 `subject_and_owner`，两者被分别计数）。因此推荐器若读该
   脱敏投影，`household` 硬约束**通常仍可见**，被隐藏的是**取 `subject_and_owner` 的硬约束**
   ——一个把过敏原设为私有的成员会在投影中「隐形」，其过敏原被漏检，从而命中发布阻断
   条件第 1 条（`docs/product/mvp.md:50`）。
3. **候选合同把硬约束检查钉死为字面量 `"passed"`。**
   `recommendationCandidateSchema.hardConstraintCheck.status` 是
   `z.literal("passed")`（`packages/contracts/src/meals.ts:150-153`）。因此**只要发出任何
   候选，就等于断言硬约束检查已通过**；而在无权威词表时该断言不能成立（与
   `packages/contracts/src/identity.ts:228-230` 的 fail-closed 一致）。

**结论：无词表时不存在可安全发布的推荐增量。** 受限家庭在当前边界下只能得到
`no_feasible_option` 式的**诚实阻断**，而不是一份看似可用的菜单。

## 2. 里程碑 M-0 至 M-6

以下里程碑是本计划的**执行分解**。每个里程碑固定四项：交付物 / 验收条件 / 适用门禁 /
需要什么授权。任何一项未取得授权时，该里程碑**保持未开始**，不得默认前进。

### M-0 决策请求包 + 今天已授权的纯设计工作

- **交付物**：一页 owner 决策请求（本计划的配套文件 B）；外加今天**已授权**的纯设计推理。
- **验收条件**：ADR-0009 停止谓词（`P0 = 0` ∧ `P1 = 0` ∧ 每条残余 P2 非本轮修复即登记）；
  **不冻结任何合同、迁移或数据**。
- **适用门禁**：设计门禁（ADR-0009 §1）。
- **需要什么授权**：无新授权。

### M-1 治理落地进索引事实源

- **交付物**：把 09P 治理——本开发计划、ADR-0007/0008/0009、递延项登记表
  （`docs/governance/deferral-register.json`，22 笔）、功能盘点、`@meal-agent/domain`——
  落到 `main` 或**至少**推到 `origin`；并把 `main` 的 `docs/project-status.md` 拉到与治理
  一致的当前口径。
- **验收条件**：`main` HEAD 含这些文件；登记表闸门（`scripts/check-deferral-register.mjs`）
  通过；**旧的 BLOCK 报告作为历史保留**，不删除、不改写。
- **适用门禁**：文档/链接门禁 + 登记表闸门；**不涉及**产品门禁。
- **需要什么授权**：产品负责人的 push/merge 授权。当前 09P 的本地分支均**未推送远端**，
  过程目录 `.local/` 又被 `.git/info/exclude` 排除——单机丢失即同时失去工作副本与过程记录。

### M-2 B 腿闭合（命名全新的 M1 动态审计）

- **交付物**：修复三处审计工装自伤缺陷；签发一份**全新命名**的有界动态审计
  （**不叫 B-r4，不是旧 BLOCK 的重试**）。
- **验收条件**：B 腿 CLEAN，且 household-safety `292` 被**实际运行**；A 腿保持 CLEAN；
  旧的 r1/r2/r3 **永久保持 BLOCK**；**B CLEAN 明确不等于 M1 Accepted**。
- **适用门禁**：实施审计轨道（ADR-0009 §1）。
- **需要什么授权**：一次有界的、运行独立审计的授权（并指定执行者与范围签发方式）。

### M-3 外部班底落实（真关键路径，最早启动）

- **交付物**：十二个角色各自落到一名具名自然人，每人恰好一项**确认的、独立的、无利益
  冲突的、已接受责任**的权限 + 一项绑定的决定；其中内部七个（六个 Steward/Owner 加产品
  负责人 `product_owner`）由现有角色填实；计划 §4.5 的外部审查方（三至四方）完成委任。
- **验收条件**：冻结的 M1 就绪契约 `stage09p-m1-minimal-deterministic-readiness-contract-r4`
  （`M1-MINIMAL-1R4`）**§3.3 逐字节满足**（`EvidenceInput` 的
  `AuthorityEvidence`/`ReviewDecisionEvidence` 形状与十二角色闭集）；登记表
  `plan-4.3-named-roles` 条目离开 `unassigned`。
- **适用门禁**：设计门禁 + 外部证据（**角色名本身不构成审核证据**）。
- **需要什么授权**：产品负责人的任命 + 外部预算 + 外部可得性。

### M-4 有界合成纵切（仅合成数据、仅本地 E2E）

- **交付物**：一个**有界**合成纵切——合成 FoodConcept 全局只读参考表 + `recipes`/
  `recipe_ingredients` + `recommendations`/`recommendation_candidates` + `meals`/
  `meal_recipes` + 单写者 `0005` migration；推荐请求 schema 与 meal/recommendation HTTP
  envelope；确定性规则引擎（参与者、厨艺、总时长、经 `foodConceptId` 计算的缺少项、
  候选 reason code、**无模型**）；两条路由；客户端第六页；第十六条 typed 写命令。
  **三项强制设计更正**：(a) 引擎必须读**未脱敏**的饮食约束；(b) 菜谱只经 `foodConceptId`
  join 库存；(c) 计划 §5.4 的四段快照 digest，或把单值快照**显式登记为延迟**。
- **验收条件**：设计门禁停止谓词；对每个列明面（migration/RLS、hard-constraint 引擎、
  Recommendation 安全快照，以及**若**纵切含 confirm-then-consume 则 Meal completion/
  leftover）的[计划 §12.1](2026-08-stage-09p-safe-deterministic-product-core.md) A/B 双审计；
  约 31 项 evidence-obligation 类开放义务各自取得其动态证据。
- **适用门禁**：设计门禁（进入）+ §12.1 A/B 双审计。
- **需要什么授权**：一次有界的 owner 授权，**钉死范围、精确 SHA 与单一交付边界**；并
  **显式以该合成范围取代**入口评估对 contracts/API/DB/client/migration 的禁令（仅限该
  合成范围）；且需要 M-2。

### M-5 首批 active 数据 release（窄而受控）

- **交付物**：经外部审查的权威 allergen 词表 + FoodConcept→allergen 绑定 + 约十二道
  L3 双人复核菜谱（声明全部八类暴露类别）+ 一小族高风险食品安全规则；每个实体 17 字段
  治理信封（计划 §4.1）+ 每来源 `SourceEvidence`；licence、region、minimum snapshot hash
  与 withdrawal 作为**运行时**字段。
- **验收条件**：计划 §3.4 的成功定义 1 与 2；§4.5 审查结论被登记；active 数据的 §12.1
  A/B。**拟议候选数量（24/4/3/8/8/12，依次为 FoodConcept/allergen/宗教伦理/食品安全/
  cooking-technique/Recipe）只是说明，不得进入任何验收条件或看板百分比。**
- **适用门禁**：设计门禁 + §12.1 A/B + 外部证据。
- **需要什么授权**：M-3 + 正式 **G2 admission**。

### M-6 受限家庭路径上线 + M2 收口硬裁定

- **交付物**：过敏/宗教/伦理过滤器**真正上线**，使受约束家庭得到真实安全菜单而非一刀切
  阻断；M2 收口时，每条 `unassigned` 登记项转为真实日期或被**明确关闭**。
- **验收条件**：ADR-0009 §6.1（**无 `unassigned` 条目可跨过
  `reviewByMilestone = M2`**）；`plan-4.3-named-roles`、`P-G2`、`P-M1` 三个条目成为**硬
  裁定点**。
- **适用门禁**：设计门禁 + §12.1 A/B + 收口裁定。
- **需要什么授权**：M-5 + owner 的**逐项裁定**。

## 3. 真串行与真并行

### 3.1 真正的串行

- **(a) 工程串行**：ADR-0009 §8 第 2 项（有界合成纵切）授权 → `0005` 单写者 migration
  → 数据模型 → 引擎/路由/客户端。
  计划把这些面**冻结为不可并行实现**；顺序不得重排，也不得用多个 Agent 同时写同一面。
- **(b) 外部串行**：外部班底落实 → M-5（active 数据 release）→ M-6（受限家庭路径上线）。
  外部审查不能由内部审计替代，因此这条链**无法在代码侧提速**。

### 3.2 真并行

除 §3.1 的两条串行链外，**其余全部可并行**。具体地：

- M-1（治理落地进事实源）、M-2（B 腿闭合）、M-3（外部班底落实）**互不依赖**，可同时推进；
- M-3 不依赖任何代码，**是最早可启动的真关键路径**；
- M-4 只依赖 ADR-0009 §8 第 2 项（有界合成纵切）的授权与 M-2，不依赖 M-3；M-5 只依赖
  M-3 与 G2。

### 3.3 今天就能开始

- **M-0**：今天已授权的纯设计工作 + 一页决策请求。
- **M-3**：一旦获得任命/预算/可得性，外部接触即可开始（这是真关键路径）。
- **M-1**：只差一个 push/merge 授权。
- **M-2**：只差一次有界的独立审计授权。

**诚实陈述**：M-1 与 M-2 是工程侧可自足的工作，但它们**推不动** M-5/M-6；首个 release 的
到达时间由 §3.1(b) 的外部链决定，而不是由工程吞吐决定。

## 4. 停止条件

出现下列任一情形即**停止并按停止条件处置**，不得默认前进：

1. **ADR-0009 §8 第 2 项的有界合成纵切授权被拒**：M-4 不能开始，约 31 项开放义务失去其
   唯一共享解锁点——**重新规划**，不得默认前进。
2. **外部方无法在有界窗口内落实**：M1 Accepted 永不到来，首个 release 必须**正式缩窄**。
3. **权威词表无法取得许可**：推荐主干被**结构性阻断**，必须重新评估产品可行性。
4. **新一轮审计再次因工装（而非已确证的运行时缺陷）阻断**：零重试规则必须通过一份
   **有记录的决定**修订。
5. **纵切证明引擎无法读未脱敏约束、或无法经 `foodConceptId` join**：**任何**推荐路径不得
   发布。
6. **任何把 B CLEAN 当作 M1 Accepted、或把合成纵切当作产品核心工作已完成的陈述**：
   属**语义缺陷**，必须停止。

## 5. 明确不做的事

- 不发布任何可能违反 `docs/product/mvp.md:50-57` 的推荐路径。
- 不用 `displayName` 字符串把菜谱匹配到库存。
- 不伪造词表，不以内部审计替代 §4.5 外部审查、G2 admission 或十二个具名角色。
- 不把拟议候选数量（24/4/3/8/8/12）写进任何验收条件或看板百分比。
- 不解封旧的 r1/r2/r3，也不把新审计叫 B-r4。
- 不通过登记表的准入类别，递延任何已知未修复的规范性缺陷。

## 6. 与既有文档的关系

- **ADR-0009**：本计划所有「停止谓词」「残余 P2 非修复即登记」「轮次上限」「登记表」均以
  ADR-0009 为准，本文件不重复其规则、也不放宽它。
  **命名纪律**：本计划的 M-0…M-6 是**执行分解**，**不得**被用来为任一条在飞设计线取得新
  的轮次计数起点；ADR-0009 §4 的里程碑身份（计划 of record 的 M0—M6 顶层集合、同一设计线
  同一里程碑至多 3 轮）继续有效，重新命名或增补顶层里程碑**不**产生新计数起点。
- **功能盘点**：`docs/product/capability-inventory.md` 是「今天真实存在什么」的唯一口径；
  本计划是「打算做什么」。两者不互相改写。
- **计划 of record**：`docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md` 仍是
  阶段范围、冻结面与 A/B 审计清单的事实源；本文件引用其 §4.3/§4.5/§5.4/§12.1。合成纵切的
  授权决定**不在** of-record 计划内（其 §8 是「阶段 09B 私服重新入队条件」），见 ADR-0009
  §8 第 2 项。
- **递延项登记表**：`docs/governance/deferral-register.json` 是本计划所依赖开放义务的机器
  可读子集（当前 22 笔，其中 17 笔标 `evidence-obligation`）；其余证据义务散见于 M1 就绪
  契约、WP-O1 证据范围材料与 gap inventory。M-4 所称「约 31 项」是本计划的**工作计数**，
  不是验收条件；确切计数以各收口记录的逐条登记为准。
