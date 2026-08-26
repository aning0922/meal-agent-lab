# 领域数据模型

- 状态：阶段 05 共享契约基线已接受；阶段 09P 规划于 2026-08-23 Accepted；当前为完全合成的 M0-R3 audit candidate，M0/ADR-0008 未 Accepted，09P In Progress，M1 未开始
- 代码事实源：[`packages/contracts`](../../packages/contracts/)
- 领域核心：[ADR-0007](../architecture/decisions/0007-food-knowledge-governance-and-domain-core.md) 的规划/架构方向已 Accepted；当前 [`packages/domain`](../../packages/domain/) 固定为 `types/decode/canonical/validation/catalog/resolution/index` 七模块候选，不含权威真实 release、真实数据或外部能力

## 核心实体

| 实体 | 职责 |
| --- | --- |
| User | 可登录的系统身份 |
| AuthIdentity | 微信、手机号、Apple、华为等登录入口 |
| Household | 家庭数据和协作边界 |
| Membership | 用户在家庭中的角色与权限 |
| PersonProfile | 参与用餐但不一定拥有登录账号的成员 |
| DietaryConstraint | 过敏、宗教/伦理限制、明确忌口或软偏好 |
| FoodConcept | 标准食材、别名、分类、默认单位和过敏原映射 |
| Product | 品牌商品、条码、规格、配料和标签信息 |
| InventoryLot | 一次购入或制作形成的独立食材批次 |
| InventoryEvent | 购入、开封、使用、移动、冷冻、解冻、丢弃和纠正 |
| Recipe | 结构化菜谱、份数、食材、步骤、时间、设备和难度 |
| MealRecommendation | 推荐时的参与者、库存快照、结果、理由和安全检查 |
| ShoppingListItem | 缺少量、购买量、归属菜单和协作状态 |
| Feedback | 做了、没做、喜欢、太难、太慢等显式反馈 |

## 身份与家庭映射

```text
AuthIdentity ──> User ──> Session
                   │
                   └──> Membership ──> Household
                              │             │
                              └── link ─> PersonProfile
                                            └─ 也可为无登录用餐档案
```

- `AuthIdentity` 以 provider、provider tenant（微信 AppID 范围）和 provider subject（微信 `openid`）唯一。
- provider identity 不能作为内部 `User.id`；UnionID 不能自动合并 User。
- `Membership` 表示 User 在 Household 的权限；`PersonProfile` 表示实际用餐者。
- 一个 User 可加入多个 Household，一个无登录 PersonProfile 不需要 User 或 Session。
- Session 只关联 User/AuthIdentity，不把当前 Household 或权限快照作为授权事实。
- `AuthenticatedUserContext` 只在 active User、active Session 且二者 User ID 一致时成立；`HouseholdContext` 必须在事务内读取 active Membership 后从前者扩展。
- 详细生命周期和安全约束见 [ADR-0003](../architecture/decisions/0003-identity-tenancy-and-api-semantics.md)。

## 家庭租户

所有家庭私有实体都必须有 `householdId`。数据库实现同时使用：

1. 应用层 active Membership/role/capability 校验；
2. `(household_id, id)` 和跨表复合外键；
3. PostgreSQL Row Level Security；
4. 成员私有约束的字段级 response redaction。

Recipe 可以是全局审核内容；Meal、Recommendation、InventoryLot/Event 和 ShoppingItem 必须属于 Household。

## 阶段 09P 已接受的全局参考数据治理方向

FoodConcept、Allergen、CookingTechnique、SafetyPolicy 与 RecipeRevision 作为全局
immutable 参考数据；每个实体必须绑定 dataset release、entity revision、来源、适用
地区、语言、许可、审核状态和 withdrawal 状态。全局实体不得包含家庭、成员、消费或
推荐数据，普通 runtime 只读，发布只能通过受控导入或 migration 身份。

五类数据共用的治理信封、source tier、生命周期和 fail-closed 语义见
[ADR-0007](../architecture/decisions/0007-food-knowledge-governance-and-domain-core.md)。具体
真实内容和数量留给阶段 09P-M1 审查；规划中的 24 concepts、4 allergen 类别、8 个
safety 规则族、8 个 techniques 和 12 recipes 只是 Proposed 覆盖规模，不是 Accepted
数据范围。09P-M0 只允许完全合成数据。

## Recommendation 快照与历史边界

Recommendation 必须绑定四类 immutable snapshot：

1. 按 ID 排序的 `(lotId, lotVersion, foodConceptRevision, safetyAssessmentRevision)`
   及 inventory digest；
2. 按参与者排序的 `(profileId, profileVersion, constraintSetDigest)`、mapping release
   及 constraint digest；
3. 按 Recipe 排序的 `(recipeId, recipeVersion, contentDigest, datasetReleaseId)`；
4. FoodConcept、allergen、宗教/伦理、食品安全、technique release 与推荐引擎版本。

确认 Meal 前重新读取并比较全部 revision/digest。库存、参与者约束、Recipe、撤回清单
或 policy 任一变化都返回稳定 conflict 并重新计算，不允许静默接受旧 Recommendation。
Meal 固化所选 Recipe revision 和 Recommendation snapshot，后续全局内容更新不能改写
历史餐次。

私密 PersonProfile constraint 原文只保留在 Household 私有边界；Recommendation 只
保存必要的 digest、rule ID 和 blocker code，日志、全局数据和模型 prompt 不默认包含
成员姓名或完整私密约束。

## 批次原则

同一种食材的不同购买批次必须分开保存，因为到期日、开封状态和储存条件可能不同。当前库存由事件聚合得到，事件至少包含家庭、批次、操作者、发生时间、幂等键、来源、期望版本和结果版本。

`InventoryLot.currentQuantity` 是可重建投影；`InventoryEvent` 是不可变事实。事件可保存 numeric delta 或 qualitative change，以支持“半盒”“不多”等表达。纠错追加引用原事件的 `corrected` 事件，不修改历史。

## 日期与期限

需要区分：

- 购买日期；
- 生产或制作日期；
- 包装明确到期日；
- 开封时间和厂家开封后要求；
- 冷冻、解冻及加工时间；
- 基于审核规则得到的建议使用期。

每个推导值保存规则版本、来源和置信度。购买日期不得替代生产日期，估算不得展示成包装明确日期。

已确认识别结果还需记录确认人；`estimated_use_by_date` 只能来自带版本的审核规则。未填写表示未知，不生成虚构日期。

`InventoryLot.dates` 是当前日期事实/推导快照，同一 `kind` 最多一项，最多九项；重复冷冻、解冻、开封等历史仍保存在 `InventoryEvent`。创建批次输入只允许四种包装/录入日期，最多四项且 `kind` 不重复。

## 数量

同时保留用户原始表达和可选的标准化数量，例如“半颗白菜”和估算标准单位。系统应允许“充足、不多、快没了”等模糊状态，避免制造虚假的精度。

批次初始 `acquired` 事件必须能重建当前数量：

- exact 写入必须有正数 amount 和 unit，使用同 amount/unit/originalText 的 exact numeric change；跨进程 JSON 的 exact amount 使用 plain fixed-point decimal string，不使用会先经过 IEEE-754 的 JSON number，也不接受指数形式；
- approximate 写入必须同时有正数 amount、unit、confidence 和 originalText，使用字段完全相同的 estimated numeric change；
- 原始文本解析结果必须由确认界面转换成结构化 approximate，或由用户明确选择非 empty qualitative level，再提交正式写入；没有 amount/unit 的 approximate 不能提交；
- qualitative 写入必须显式提供非 empty level，事件使用 `empty → 当前 level` 并保留 originalText。

调用方提交用户确认后的最终结构；服务端、模型或未确认识别不能决定 qualitative level，也不能补造 amount/unit。阶段 06 的最小 consumed command 只接受 exact 正数 decimal string 并产生 exact 负 delta string；等值 fixed-point alias 先规范化，再参与幂等哈希。通用 estimated delta 必须同时保存 confidence 和 originalText，exact delta 禁止 confidence。

## 幂等与版本

- 创建事件或推进状态的 command 必须有 `Idempotency-Key`。
- 创建家庭使用 `userId + method + route + key` 的用户级作用域；家庭内 command 增加 `householdId` 使用家庭级作用域。
- 相同作用域/key/body 重放第一次结果；相同 key/不同 body 返回冲突。
- 聚合使用 non-negative integer `version`；写入携带 `expectedVersion`。
- 新批次以逻辑 pre-version 0 开始，初始 `acquired` 事件和 lot projection 在同一事务发布为 version 1。
- 库存事件满足 `resultingLotVersion = expectedLotVersion + 1`，且数字扣减不得产生负库存。
- 幂等记录、事件和投影在同一事务提交。

阶段 09P 的产品流写命令 Proposed 锁序为：completed replay → session/household
bootstrap → household product-flow advisory → idempotency marker → 按 ID 排序的
participant profile rows → recommendation/meal → shopping rows → inventory lots →
append events/create leftover lots → projection/receipt。任一路径不得先锁 inventory 再
回头锁 meal/profile。精确 SQL 和并发证据必须在对应里程碑接受后才能成为实现事实。

## 契约与数据库的关系

共享 contract 是客户端与服务端的网络边界，不是数据库表定义。Drizzle row、领域聚合和 API entity snapshot 分开，服务端使用显式 mapper；客户端和服务端都不得复制一套同名核心类型。

阶段 09P 的 Proposed `packages/domain` 只承载纯确定性领域值、reducer、hard filter、
份量/候选组合和状态机；它不定义 HTTP DTO、Drizzle row、SQL 或 I/O。DTO schema、模型
输出和外部自由文本均不能替代领域引擎。
