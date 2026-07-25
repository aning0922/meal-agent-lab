# ADR-0004：阶段 08 预发布审计整改例外

- 状态：Accepted
- 日期：2026-07-25
- 负责人：产品负责人、技术负责人、安全
- 关联：[ADR-0003](0003-identity-tenancy-and-api-semantics.md)、[阶段 08 审计整改记录](../../plans/2026-07-stage-08-audit-closeout.md)

## 背景

阶段 08 的首版成员与 PersonProfile 纵切尚未部署到生产、测试环境，也没有仓库外消费者。验收审计发现：敏感 PersonProfile 响应进入 30 天幂等缓存、`memberships` 表权限过宽、档案读取与归档生命周期不闭合、运行时 Zod 与生成 OpenAPI 的部分约束不一致，以及客户端没有完整覆盖已冻结的 FAM-003、FAM-004 和阶段 08 内的 FAM-005。

正常情况下，改变 `/api/v1` 写响应形状需要新 API 版本和 expand/contract 部署。当前不存在已部署消费者，继续保留不安全形状反而会固化安全缺陷。因此本 ADR 记录一个只适用于预发布整改的窄范围例外。

## 决策

### 预发布原地纠正

1. `@meal-agent/contracts` 升级为 `0.4.0`，在 `/api/v1` 原地修正 PersonProfile 写响应、档案生命周期、未知值和硬约束映射语义。
2. 例外只在“没有已部署环境和外部消费者”这一事实成立时有效。若出现相反证据，必须停止发布并重新设计版本与迁移策略。
3. 不编写虚构的双版本 reader、expand/contract 流程或兼容窗口；当前仓库只有修正后的单一事实源。
4. 已有 migration 及 checksum 保持不变。首轮整改通过单一事务 `0002_stage_08_audit_closeout.sql` 完成，二次审计新增 `0003_stage_08_secondary_closeout.sql`；最终收口在 0000—0003 已纳入 checksum 后只新增单一事务 `0004_stage_08_final_closeout.sql`，不回改历史迁移。

### 集中式幂等与敏感响应

所有使用通用幂等执行器的规范化写路由必须在同一注册表中选择：

- `full`：可长期重放且不含秘密或 PersonProfile 私密字段的完整响应；
- `one-time-secret`：首次可返回一次性秘密，缓存与重放只包含安全投影；
- `receipt`：首次和重放都只返回稳定、安全的变更回执，客户端随后走授权 GET 获取最新资源。

PersonProfile 与 dietary constraint 写操作固定使用 `receipt`。邀请码创建使用 `one-time-secret`。当前不含敏感字段的家庭、库存、邀请撤销、加入、成员退出/移除及档案关联命令使用 `full`。登录交换不进入该通用响应缓存。

注册表由规范化路由类型穷尽约束，不允许 endpoint 传入临时 redact 回调。现阶段不增加 `response_policy` 或 `representation_version` 数据库列：策略由代码注册表确定，历史记录按 route 转换。能安全识别的历史 PersonProfile 响应改为 receipt；无法安全恢复语义的响应改为 `nonReplayable` tombstone；两者都保留幂等 key、请求哈希和已完成命令标识，避免重复执行。历史邀请码只移除秘密字段。

### 最小数据库权限

撤销 `meal_agent_app` 对 `memberships` 和 `person_profiles` 的直接 `UPDATE`，删除宽 UPDATE RLS policy。成员退出/移除、档案字段/状态/约束、邀请赎回和 dining-only profile 关联只通过窄参数的 `SECURITY DEFINER` 函数执行。

这些函数固定 `search_path`、完整限定对象、关闭函数内 RLS、归 migration role 所有，并撤销 `PUBLIC` 的执行权限后仅授予应用角色。时间只由函数内 `clock_timestamp()` 取得，redeem 不接收调用方 capabilities，加入和重新加入固定安全默认值，expectedVersion 的 NULL 明确拒绝。另执行 `REVOKE CREATE ON SCHEMA public FROM PUBLIC`。HTTP capability 检查继续存在，数据库函数作为 defense-in-depth，不替代 HTTP 授权。

### PersonProfile 资源与生命周期

- `/members` 继续表示登录成员目录；独立 profile list/get 统一读取 linked 与 dining-only profile，并支持 `active`、`archived`、`all`。
- owner 或 profile 本人可读完整字段；其他家庭成员只读安全投影，结构上排除 `subject_and_owner` 约束。
- archive 保留原 ID 和唯一身份；restore 恢复同一行，不通过复制创建新档案。
- 成员退出或被移除时，在同一事务归档其 linked profile；重新加入不自动恢复，也不复制私人约束。
- dining-only profile 关联登录成员必须由 owner 发起并由被关联用户确认；禁止按姓名自动合并。转回 dining-only 需要未来独立确认命令，本阶段不隐式执行。

### 未知事实、硬约束与生成契约

`defaultParticipation`、`defaultPortionScale`、`cookingSkill` 支持 `null`，新建和旧数据迁移都不得猜测默认值。阶段 08 提供这些已有字段的查看和编辑；正式 cooking-technique 词表留作阶段 09 数据治理前置，因此 FAM-005 仍为部分完成。

客户端覆盖全部现有 hard constraint kind并采集 allergen/food concept 标识符。当前没有权威映射词表，字符串或 UUID 形状校验不构成 structured mapping；所有 hard constraint 固定为 `needs_structured_mapping`，推荐边界必须阻断，模型不得猜测。确认指纹包含 kind、enforcement、label、food concept、allergen、notes 和 visibility，任一字段变化都会使旧确认失效。因此 FAM-004 的登记、确认和隐私范围已实现，但在权威映射和推荐安全闭环前仍为部分完成。

公共 Zod 边界上的所有 refine/superRefine 进入稳定 rule manifest，并逐 schema 绑定：可表达规则生成原生 JSON Schema，其他规则以稳定 rule ID 的 runtime-only 扩展公开，并有运行时、生成 schema 与 OpenAPI 一致性门禁。生成 OpenAPI 是唯一产物，不手工维护第二份 JSON。

### 二次收口的不变量

- 自退出的幂等结果必须在事务提交前完成且 UPDATE 恰好一行；同 key 可在 active membership 消失后、household bootstrap 之前重放，不允许遗留 incomplete record。
- linked profile 直接创建只能由其本人执行；dining-only 仍仅 owner 可建。直接创建与关联确认共享 household advisory lock，并在其后按稳定 request/profile/membership 行锁顺序执行，竞态稳定为一方成功、另一方 409。
- pending link request 的过期、目标退出、档案归档或目标已有档案在同一锁内物化为终态；过期后可以重新发起。
- 页面关联确认必须披露安全名称、可见约束摘要、权限和归档/保留后果；不可恢复时禁用操作，切换档案清空档案级草稿，请求进行中冻结相关输入。

### 最终收口的不变量

- link request 保存发起时的 profile version、名称、家庭可见 hard/soft 数量和私密约束数量，但不保存或披露私密内容；名称或任一约束变化使确认稳定提交 `profile_changed` 终态并返回 409，客户端必须重新 GET、展示和确认。旧请求没有发起时证据，`0004` 只标记为 `legacy_unavailable` 并终态化，绝不拿迁移时的当前值冒充历史快照。
- `meal_agent_app` 不再直接 `INSERT person_profile_link_requests`。owner 只能调用受控 `SECURITY DEFINER` 创建函数，由数据库在锁内读取 profile、重新验证 active target 并计算安全披露；confirm 也必须重新验证 target active，调用方不能提交自制快照。
- create/list/confirm、linked self-create、membership remove 和 profile archive/restore 使用同一 household link advisory 作为生命周期写路径的第一把锁，再按稳定 request/profile/membership 顺序加行锁；创建新请求会物化同 profile 的全部旧 pending，不受旧 target 限制，直接创建 linked profile 会终态化该 target 的其他 pending。
- repository 的事务 callback 用 tagged domain outcome 表示“终态已写入但 HTTP 应返回 409”；同一事务把安全失败回执写入幂等记录并断言 UPDATE 恰好命中一行，提交后才抛 HTTP 错误。同 key 重放同一失败，不删除完成 marker，也不会因外部状态变化重新执行。
- `add_person_profile_constraint` 在任何 profile 更新前校验 constraint ID 为小写 UUIDv7，并校验 JSONB 对象键、数组元素、字符串、notes 长度与唯一性；nil、UUIDv4 或其他畸形 app-role 输入返回 `invalid_constraint`，profile 内容和 version 不变。公共 `foodConceptIds`、`allergenCodes` 均最多 100 项且不得重复，food concept ID 统一为小写 UUIDv7；没有权威词表时允许 label-only allergy，不能迫使用户编造 code。
- 客户端不再用单一 `busy` 代表命令状态。transport、5xx 与 malformed success 都是结果未知，必须保留包括资源版本在内的完整不可变 command snapshot 与原 key，重试不得从刷新后的 lot/profile 重建；确定未执行的 400/403/404/409 才释放，应用重启后通过 GET 对账。Profile 有 pending 时只开放原动作重试及完成/放弃对账，其他写操作全部冻结。
- rule schema binding 的 boundary 与 rule ID 在 schema/refinement 定义处写入 Zod metadata；binding 和 OpenAPI schema component 从实际 metadata 派生，不维护第二份手写 boundary map。绕过 helper 或故意错绑都使门禁失败。
- OpenAPI 3.0.3 由生成器把 Zod JSON Schema 方言确定性降级：`const`、数值型 `exclusiveMinimum`/`exclusiveMaximum` 和 `type: null` 不得进入产物；标准 OpenAPI validator、方言扫描和 committed/generated 深比较共同 fail closed。contracts 包显式声明会注册 schema metadata 的模块具有 side effects，避免构建优化静默丢失 binding。
- production audit gate 严格校验例外 policy、有限可解析到期时间、完整 advisory metadata 和退出语义；仅 exit 0/1 的合法审计报告可继续，signal、exit 2、registry/network 错误及 advisory 新增、变化或消失均失败。

### 依赖审计和交付边界

截至 2026-07-25，`pnpm audit --prod` 报告 1 critical、1 high、8 moderate，均来自 Taro 传递依赖路径。接受一个截至 2026-08-08 的机器可读 `local-weapp` 限时例外；门禁精确匹配 advisory、版本和依赖路径，并扫描 weapp 产物。新增、变化、消失但未清理或过期的 advisory 都会失败。例外期间禁止 H5、外部测试、体验版和发布。

远端 Git/CI 不是本轮本地实现的阻断项；应在阶段 08 合并 main 后、阶段 09 开发前配置。没有远端证据时不得声称远端 CI Pass。

## 备选方案

### 新开 `/api/v2`

在已有消费者时是正确方案；当前会制造没有真实消费者的双版本维护，因此不采用。若部署事实改变，本 ADR 的例外立即失效。

### 列级 `GRANT UPDATE(status, ...)`

可以阻断角色列提权，但仍允许应用角色直接执行不合法状态迁移，最后 owner 和 actor/target 关系主要停留在应用层，不足以完成 defense-in-depth，因此不采用。

### 每个 endpoint 单独 redact

容易遗漏新路由或新字段，也不能提供穷尽性检查，因此不采用。

### 为宗教、伦理和烹饪技术临时发明词表

缺少治理来源和版本责任人，会把未经审定的标签误当作机器规则，因此不采用。未映射 hard constraint 以阻断状态保守处理。

## 影响

- PersonProfile mutation 的 `0.3.0` 响应消费者必须升级到 `0.4.0` receipt + GET 语义；仓库内客户端已同步，没有仓库外消费者。
- `0002`/`0003`/`0004` 的敏感响应清理、权限收窄与关联披露不提供恢复旧不安全状态的 down migration；失败时各自事务整体回滚，成功后只允许 roll-forward。
- 本地 Stage 08 可以形成完整安全、契约、数据库、HTTP、客户端、E2E、weapp 和 GUI 证据，但真实微信、真机、体验版、发布、云环境和远端 CI 仍按各自门禁单独验收。
- 阶段 09 在正式 cooking-technique 与宗教/伦理规则词表完成治理前不得把自然语言约束交给模型执行。
