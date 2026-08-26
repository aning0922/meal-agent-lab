# 食品安全边界

本文件描述产品必须执行的安全底线，不替代专业食品安全或医疗建议。

阶段 09P 规划已于 2026-08-23 Accepted，规划验收落点为
`cff32929916592fa79d40c980564d3cc9a93fbeb`；关联
[ADR-0007](../architecture/decisions/0007-food-knowledge-governance-and-domain-core.md)
的规划/架构方向已 `Accepted`。固定七模块 M0 acceptance candidate
`186bd2f43695e1136a3a1fc43faa6d6088d9ce54` 已获 Cycle 2 独立 Audit A/B 双 CLEAN，
M0/ADR-0008 已由总控 Accepted；09P 仍为 In Progress，本次 M0 收口时 M1 尚未开始。
M0 数据仍完全合成且无外部能力；尚未发布任何权威食品安全、allergen、宗教/伦理或
cooking-technique 数据 release，也未导入真实食品事实或用户数据。M0 checker 不自证
loader/compiler/runner/worker/supply-chain，其 TCB 仍由 frozen lockfile、Git review、CI/09A、
固定 Node 与独立审计承担。

## 数据治理与审核

- FoodConcept、allergen、宗教/伦理、食品安全和 cooking-technique 必须记录稳定 ID、
  entity/release revision、来源等级、适用地区、语言、许可、审核人与撤回状态。
- 只有 `active` revision 可进入正式推荐；draft、许可待定、地区不适用、引用不存在、
  审核未完成或 withdrawn 时 fail closed。
- 官方监管/适用标准/厂家具体说明优先于专业二级资料；用户输入和模型输出只能作为
  待确认输入，不能成为权威规则。
- 食品安全与 allergen 规则必须接受外部高准确性审核；法规适用性和许可分别由法律/
  合规与许可证审核责任人确认。
- 引用快照保存验证事实所需的最小内容、定位、获取时间和 hash，不默认复制无许可全文。
- 紧急撤回发布新的 release revision；旧 Recommendation 在确认时必须因 policy
  snapshot 漂移失败，不能静默沿用或静默恢复旧 release。

## 日期与储存

- 优先级为包装或厂家明确说明、用户明确录入、经审核的分类规则；模型不得猜测。
- 储存条件未知、标签模糊或冷链状态存疑时，明确显示状态未知。
- 已过期或状态未知的高风险食材默认不进入推荐候选。
- 开封、加工、冷冻和解冻会改变适用期限，需要产生新的状态事件。
- 图片和气味描述不能被用来证明食材安全。

## 过敏与禁忌

- 对每位本餐参与者执行硬约束检查。
- 菜谱主料、辅料、调味品、替代品和“可能含有”信息都要纳入检查。
- 发生食材替换或份量调整后重新执行最终校验。
- 不从历史行为自动推断过敏或疾病信息。

## 模型行为

模型必须如实表达未知、假设和低置信度信息。不得建议利用已明确过期的高风险食材，不得给出疾病治疗或医疗级营养结论，不能绕过服务端安全校验。

DTO schema、模型结论和外部自由文本都不是领域安全引擎。最终 hard filter 必须由
带版本的确定性领域规则执行；模型只能解释已经通过的候选或 blocker，不能改变结果。

## 烹饪技术与可执行性

- 安全关键 cooking-technique、必要设备和关键步骤必须使用受治理的稳定概念与版本。
- 缺少安全关键技术能力、设备或明确步骤时，菜谱不得标记为可直接执行。
- 普通厨艺难度是软排序还是硬阻断必须由显式规则定义，模型不能临时决定。
- Recipe 替代食材、份量或参与者变化后必须重新执行 technique、allergen 和安全检查。

## 测试要求

安全回归至少覆盖：隐藏在调味品中的过敏原、`mayContain`、主料/辅料/替代品、同食材
不同批次、开封后期限、冷冻与解冻、剩菜 provenance、模糊日期、高风险状态未知、
家庭成员约束冲突、宗教/伦理 hard rule、withdrawn/policy drift、缺少安全关键技术或
设备、并发库存修改、原子事务失败、丢响应同 key 重试以及模型/工具试图绕过规则。

active 食品安全/allergen 数据、hard-constraint 规则引擎、Recommendation 安全快照和
Meal completion/leftover 事务必须进行独立静态 Audit A 与动态 Audit B。M0 只使用完全
合成、未激活数据时至少需要一次独立静态 A；若范围扩大到运行时安全决策则升级为 A/B。
