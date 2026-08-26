# 数据资产

## 目录

- `raw/`：本地导入的原始数据，默认不提交。
- `schemas/`：机器可读数据格式和校验规则。
- `reference/ingredients/`：食材标准名、别名、分类、单位和过敏原映射。
- `reference/recipes/`：经过审核的结构化菜谱。
- `reference/shelf-life/`：带来源、地区和版本的期限规则。
- `seeds/`：开发环境可重复导入的最小种子数据。
- `samples/`：脱敏或完全合成的格式示例，不用于正式推荐。

## 数据要求

每个可提交数据集都应附带元数据：来源、许可证、适用地区、版本、获取日期、审核人和字段说明。事实数据、用户输入和模型生成内容必须能够区分。

严禁提交真实家庭信息、用户图片、访问令牌或无法确认授权的数据。菜谱文本和图片不能通过无许可抓取进入正式数据集。

## 阶段 09P 已接受的治理边界

[ADR-0007](../docs/architecture/decisions/0007-food-knowledge-governance-and-domain-core.md)
已于 2026-08-23 Accepted，但只接受治理与架构方向。M0 Recovery 当前只有 R3 audit
candidate：`samples/stage09p-m0/` 固定为 5 个 valid 与 10 个 invalid 完全合成 fixtures，
不构成真实数据 release，也不表示 M0 Accepted。FoodConcept、allergen、宗教/伦理、
食品安全和 cooking-technique 未来必须共用以下治理信封：

- dataset/release ID、单调 revision 和 canonical content digest；
- stable entity ID、entity revision、alias、`supersededBy`；
- lifecycle：draft / under_review / approved / active / superseded / withdrawn；
- owner、approvers、source tier、source reference 和最小引用快照；
- applicable region、language、license status/reference；
- retrieved/reviewed/review-due 时间；
- emergency withdrawal 状态、原因和时间。

只有 `active` revision 可以用于正式推荐。许可待定、来源或地区未知、审核未完成、
引用版本不存在或 withdrawn 时必须 fail closed。撤回和恢复均发布新 release，不静默
改写历史。

阶段 09P-M0 只允许在 `samples/` 中提交完全合成数据，用于验证格式、版本、别名、
撤回和 fail-closed；它不得向 `reference/` 导入真实食品事实。规划中的 24 concepts、
4 allergen 类别、8 safety 规则族、8 techniques 和 12 recipes 只是 M1 的 Proposed
候选覆盖规模，不是 Accepted 数据范围。

真实 allergen、食品安全、宗教/伦理预设、外部菜谱和许可内容必须在 M1 取得对应的
食品安全、文化/伦理、法律/合规和许可证审查，才能从 draft 进入 active。
