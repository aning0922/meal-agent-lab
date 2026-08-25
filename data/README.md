# 数据资产

## 目录

- `raw/`：本地导入的原始数据，默认不提交。
- [`schemas/`](schemas/)：机器可读数据格式和校验规则；阶段 09P-M0 新增治理 release
  与合成 invalid fixture schema。
- `reference/ingredients/`：食材标准名、别名、分类、单位和过敏原映射。
- `reference/recipes/`：经过审核的结构化菜谱。
- `reference/shelf-life/`：带来源、地区和版本的期限规则。
- `seeds/`：开发环境可重复导入的最小种子数据。
- [`samples/`](samples/)：脱敏或完全合成的格式示例，不用于正式推荐；M0 样本位于
  [`samples/stage09p-m0/`](samples/stage09p-m0/)。

## 数据要求

每个可提交数据集都应附带元数据：来源、许可证、适用地区、版本、获取日期、审核人和字段说明。事实数据、用户输入和模型生成内容必须能够区分。

严禁提交真实家庭信息、用户图片、访问令牌或无法确认授权的数据。菜谱文本和图片不能通过无许可抓取进入正式数据集。

## 阶段 09P 已接受的治理边界

[ADR-0007](../docs/architecture/decisions/0007-food-knowledge-governance-and-domain-core.md)
已于 2026-08-23 Accepted，但只接受治理与架构方向。09P-M0 治理内核当前为
**M0 Round 5.3 implementation complete, pending total-control review**，不是 Accepted；真实知识数据 release
仍未开始。FoodConcept、allergen、宗教/伦理、食品安全和 cooking-technique 必须共用
以下治理信封：

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

阶段 09P-M0 只在 `samples/stage09p-m0/` 中提交完全合成数据，用于验证格式、版本、
别名、撤回和 fail-closed；没有向 `reference/` 导入真实食品事实。规划中的 24 concepts、
4 allergen 类别、8 safety 规则族、8 techniques 和 12 recipes 只是 M1 的 Proposed
候选覆盖规模，不是 Accepted 数据范围。

真实 allergen、食品安全、宗教/伦理预设、外部菜谱和许可内容必须在 M1 取得对应的
食品安全、文化/伦理、法律/合规和许可证审查，才能从 draft 进入 active。

## M0 合成数据机械证明

M0 不是靠文件名或人工声明证明 synthetic。`pnpm stage09p:m0:check` 会机械断言：

- valid manifest 精确为五份、各覆盖一种 `datasetKind`，每份只有一个 envelope；
- 每个 envelope 都携带逐字段固定的 `syntheticEvidence`，ID/actor/source/snapshot/
  license 使用保留的 `syn:`、`synthetic://`、`synthetic-license://` namespace；
- entity ID 位于本门禁保留的合成 UUIDv7 区间，region/language/alias/content 只能使用
  `SYNTHETIC-*`、`x-synthetic` 和 `SYNTHETIC_*` token；
- 十份 invalid fixture 只能引用五份 valid base，只能执行固定 mutation allowlist；
  hard mapping 也必须使用保留合成 namespace；
- manifest 多一项、少一项、出现未允许的 mutation、真实数据标志变化或 namespace
  逸出都会使门禁失败。
- valid envelope、owner/approver、source/snapshot、alias、synthetic evidence 与 content
  都有 exact key/leaf registry；M0 content 只能是单键 `{ "syntheticToken": "SYNTHETIC_*" }`。
  增加 `uncheckedExternalFact` 或任何未登记叶值，即使保留 synthetic 自报字段，也会转红。
- 两份 Schema 由独立 Ajv 2020-12 validator 编译执行；5 valid、10 materialized invalid
  与 domain runtime 形成 15-case fixture matrix；精确 30 项 JSON boundary matrix 保持
  30 个 distinct ID / 30 个 distinct material input；另有 51 项治理字符串词法 matrix，
  分别记录 Ajv raw/parsed、shape decoder raw/JSON 与 final runtime validator。decoder 只证明
  可安全物化，UUID/digest/timestamp/pattern 等 Schema 词法与最终语义不会伪装成 decoder
  职责；51 项的 exact count、ID uniqueness、冻结 ordered ID registry、unique material、
  layering 与 oracle 六个门分别取证，不能用“51 个唯一 ID”替代稳定登记证明。
  valid/invalid/schema/source/test surface 统一递归枚举，nested file、directory、symlink
  或特殊节点均 fail closed；正式 17-test scope suite 含 manifest、synthetic、受限 AST
  capability provenance/public export、Schema 八类递归 closure、parity 独立 guard
  与 domain 关键 guard 的真实删除/
  弱化反例。

这些样本只证明治理格式和 fail-closed 行为，不含真实家庭、健康、儿童、消费、食品、
allergen、宗教/伦理、安全、烹饪或菜谱事实，也不授权 M1 数据发布。
