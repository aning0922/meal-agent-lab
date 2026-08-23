# ADR-0007：食品知识治理与确定性领域核心

- 状态：Proposed
- 日期：2026-08-23
- 负责人：产品负责人、领域架构、食品安全与数据治理
- 规划：[阶段 09P：安全知识治理与确定性产品核心闭环](../../plans/2026-08-stage-09p-safe-deterministic-product-core.md)

本 ADR 是阶段 09P 的候选架构决策。文档落库不表示本 ADR 已 Accepted，也不授权
创建 `packages/domain`、导入真实数据、创建 migration 或开始产品实现。

## 背景

当前系统已经实现家庭、成员/PersonProfile、hard constraint 登记、字段级 redaction、
幂等命令和最小 exact-only 库存纵切，但尚无权威 FoodConcept、allergen、宗教/伦理、
食品安全或 cooking-technique 数据。字符串和 UUID 形状校验不构成结构化映射，因此
所有 hard constraint 继续处于 `needs_structured_mapping`，推荐边界必须阻断。

`packages/contracts` 已定义 Meal、Recipe、Recommendation 和 Shopping 的初步网络 DTO，
但这些 schema 不应承担库存 reducer、hard filter、份量换算、候选组合、事务状态迁移等
领域职责。模型或外部自然语言内容同样不能承担这些职责：它们没有稳定版本、许可、
地区适用性或可复验的 fail-closed 语义，也无权绕过安全、权限和用户确认。

阶段 09A 已建立可重复本地部署与恢复基线并由总控记为 `Accepted / Pass`，但部署成熟度
没有形成“库存 → 菜单 → 采购 → 做饭 → 库存事件”的产品闭环。项目需要先建立受治理的
知识事实和确定性领域核心，再扩展基础设施。

## 决定

### 1. 采用 09P / 09B 双轨命名

- `阶段 09P：安全知识治理与确定性产品核心闭环` 是 P0 产品 workstream。
- `阶段 09B：私有测试服务器` 是 P1 conditional 基础设施 workstream；触发条件未满足
  前不实施。
- 云、公网、合法域名、真实微信、真机、体验版、审核与发布继续 Deferred。
- 两条线分别维护 Decision state、Delivery state、证据与回滚边界，不能把服务器进度
  写成产品进度。

### 2. 目标架构新增纯确定性 `packages/domain`

阶段 09P 的目标架构允许未来新增 `@meal-agent/domain`。它负责：

- FoodConcept、Allergen、Technique、Policy 的内部值对象和解析结果；
- InventoryEvent reducer、lot allocation、Meal/Shopping/Cooking 状态机；
- hard constraint 与食品安全确定性评估；
- Recipe 份量缩放、候选组合和排序；
- 稳定 reason/blocker code。

明确禁区：

- 不定义或复制 HTTP request/response DTO；
- 不定义 Drizzle row、SQL、migration 或数据库 adapter；
- 不依赖 Fastify、Taro、微信、数据库、Node I/O 或模型 SDK；
- 不执行网络、文件或数据库副作用；
- 不持有家庭私有数据或绕过 application service；
- 不把 Zod DTO schema、模型输出或外部自由文本当成领域引擎。

依赖方向必须是：

```text
data release → packages/domain 纯规则
                        ↑
services/api application / mapper ← packages/contracts 网络 DTO
                        ↓
                   persistence
```

`packages/contracts` 继续是客户端、API、OpenAPI 和跨端测试的唯一网络契约事实源；
Drizzle row、领域对象和 API snapshot 保持三种不同类型，通过显式 mapper 转换。

本 ADR 只接受目标职责，不在本规划批次创建 package 或修改 workspace。其 public API、
依赖和测试必须在 09P-M0 独立候选中接受审查。

### 3. 五类数据使用统一治理信封

FoodConcept、allergen、宗教/伦理、食品安全和 cooking-technique 均必须至少记录：

```text
datasetId / datasetKind
releaseId / releaseRevision / contentDigest
entityId / entityRevision
lifecycleStatus
owner / approvers
sourceTier / sourceReferences / sourceSnapshots
applicableRegions / languages
licenseStatus / licenseReference
retrievedAt / reviewedAt / reviewDueAt
aliases / supersededBy
withdrawalState / withdrawalReason / withdrawnAt
```

生命周期固定为：

```text
draft → under_review → approved → active
                         ├→ superseded
                         └→ withdrawn
```

只有 `active` revision 可以进入正式推荐。`draft`、许可待定、审核未完成、来源地区
不适用、引用版本不存在或 withdrawn 时必须 fail closed。

### 4. 来源、许可、地区和语言是运行时事实

来源分级：

| 等级 | 来源 | 运行时资格 |
| --- | --- | --- |
| L1 | 官方监管机构、适用标准、原厂/包装的具体声明 | 经地区、版本和许可审核后可作为安全事实 |
| L2 | 经确认的专业机构、行业标准或专业资料 | 需 Safety Approver 批准，不覆盖 L1 |
| L3 | 有许可内容或内部原创并经双人审核的菜谱/烹饪资料 | 可用于内容；安全关键字段另审 |
| L4 | 用户输入、模型生成、搜索结果、未审网页 | 只能作为待确认输入或研究线索 |

地区、语言、来源 revision、审核时间和许可状态不能只存在于说明文档；它们必须参与
release 激活、Recommendation policy snapshot 和撤回判断。引用快照只保存验证事实
所需的最小内容、定位信息、获取时间和 hash，不默认复制完整版权内容。

### 5. 稳定 ID、别名、版本和撤回

- FoodConcept 延续小写 UUIDv7；其他治理实体使用不可变内部 ID，并可附带外部
  namespaced code。
- `entityRevision` 和 `releaseRevision` 单调递增；相同 canonical 内容产生相同 digest。
- alias 必须带地区、语言和来源；规范化搜索 alias 不产生新的安全类别。
- ID 永不复用；弃用通过 `supersededBy` 表达，不删除历史 revision。
- 紧急撤回发布更高 release revision；受影响 Recommendation 在确认时因 policy
  snapshot 漂移失败。
- 恢复撤回内容同样发布新 revision，不能静默重新激活旧 release。

### 6. 五类数据的 fail-closed 语义

| 类型 | Fail-closed 边界 |
| --- | --- |
| FoodConcept | 未映射文本可在库存显示，但不得进入需要 hard 判定的推荐 |
| allergen | 明确含有、`mayContain`、严格交叉接触、映射 unknown 或版本失配时阻断相关候选 |
| 宗教/伦理 | 用户声明为 hard 的规则未映射时阻断；不按姓名、地区或历史行为推断身份 |
| 食品安全 | 高风险且储存、开封、冷链、来源或 policy version unknown 时不进入候选 |
| cooking-technique | 缺安全关键能力、设备或步骤时不标记为可执行；普通难度只按显式规则处理 |

模型不得改变上述结果。模型只能解释经过确定性规则产生的候选或 blocker，并且不能
直接提交库存、采购、Meal 或成员约束写入。

### 7. 全局参考数据与 Household 私有数据分离

- FoodConcept、Allergen、Technique、Safety Policy 和 Recipe revision 是全局只读、
  immutable 参考数据；发布使用受控导入或 migration 身份，不由普通 runtime 写入。
- Recommendation、Meal、Shopping、InventoryLot/Event 属于 Household，必须有
  non-null household ID、复合外键、FORCE RLS、actor、idempotency 和 version。
- PersonProfile constraint 原文保持 Household 私有和字段级受限；Recommendation
  只保存必要的 constraint digest、规则 ID 和 blocker code。
- 全局 Recipe 不能包含家庭、成员、消费、偏好或推荐数据；历史 Meal 固化所选
  Recipe revision，后续内容更新不能改写历史。

### 8. 真实数据内容和数量留到 M1

本 ADR 不决定任何具体 allergen 名录、宗教/伦理预设、食品安全数值、FoodConcept
内容、technique 词表或 Recipe 文本。它们必须在 M1 提交来源、地区、语言、许可、
审核和安全反例证据后单独接受。

规划中的“24 concepts / 4 allergen 类别 / 8 safety 规则族 / 8 techniques /
12 recipes”只是 Proposed 候选覆盖规模，不是本 ADR 的决定，也不是 Accepted 数据范围。
M0 只允许完全合成数据。

## 为什么不采用其他方案

### 继续把规则写进 DTO schema

DTO schema 适合校验网络 shape、基础 refine 和 OpenAPI 一致性，不适合承担跨聚合快照、
库存 reducer、候选组合、权限上下文和事务状态迁移。把它当领域引擎会把网络兼容性、
持久化和业务规则绑死，也无法清楚测试副作用边界。因此不采用。

### 让模型或 Agent 直接判断

模型输出不具备稳定版本、地区适用性、许可证、确定性重放或可审计撤回语义，还可能
忽略调味品、替代品、`mayContain` 和多人约束。模型无权决定过敏、食品安全、权限和
库存最终写入。因此不采用。

### 直接使用外部自由文本

网页、菜谱或自然语言规则可能改变、下线、地区不适用或无再发布许可。没有 canonical
snapshot、review 和 withdrawal 的自由文本不能成为运行时安全事实。因此不采用。

### 在 M0 一次导入完整数据集

外部高准确性审查、许可和规则覆盖尚未完成。一次导入大量数据会把范围和事实质量混在
一起，难以撤回和审计。因此 M0 只建立合成治理内核，M1 再以小型覆盖 release 取证。

### 先建设阶段 09B 私服

09A 已经证明本地/私有部署基线，但产品核心闭环仍不存在。服务器不能替代数据治理、
确定性规则和用户价值证据；依赖审计例外也仍阻断 external-test。因此 09B 保持
conditional，直到 09P 本地闭环、远端 CI、外部测试安全条件和资源授权全部满足。

## 影响

- 未来新增 `packages/domain` 是跨模块架构变化，需要 M0 独立实施、测试和总控接受。
- `packages/contracts` 中 Recipe/Meal/Recommendation/Shopping 的初步 schema 可能在
  无外部消费者的预发布边界内同步升级；精确变更留给里程碑冻结。
- 第一个数据库变化只能追加 `0005`，不得修改 `0000`—`0004`；一旦 `0005` 存在，
  必须执行 `0004 → pg_restore → containment → 0005 migrate → final → verify`
  的 N-1 跨 ledger 证据。
- active 数据 release 必须支持紧急撤回；旧 Recommendation 不能跨 policy drift
  静默确认。
- 数据与安全规则的发布需要明确 owner、外部审核和许可证责任，不能由实现 Agent
  自行批准。
- 本 ADR 保持 `Proposed`，直到规划候选和目标边界由总控复核；在此之前 09P-M0
  仍为 `Not started`。

## 接受本 ADR 前的必要证据

1. 阶段 09P 计划完整覆盖 M0—M6、门禁、回滚、A/B 和 09B 触发条件；
2. `packages/domain` 职责与 contracts/database/application 的禁止交叉面清楚；
3. 五类治理信封、source tier、许可、地区、语言、版本和 withdrawal 可机械实现；
4. M0 任务书只使用合成数据，并由总控在规划 Accepted 后重签精确基线；
5. 没有把 Proposed 数据数量或外部能力写成已决定/已实现；
6. 项目总控在精确规划提交上复核并显式把本 ADR 从 `Proposed` 转为 `Accepted`。
