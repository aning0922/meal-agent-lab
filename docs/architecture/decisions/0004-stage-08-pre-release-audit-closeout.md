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
4. 已有 `0000`、`0001` 及 checksum 保持不变。整改只通过单一事务迁移 `0002_stage_08_audit_closeout.sql` 完成。

### 集中式幂等与敏感响应

所有使用通用幂等执行器的规范化写路由必须在同一注册表中选择：

- `full`：可长期重放且不含秘密或 PersonProfile 私密字段的完整响应；
- `one-time-secret`：首次可返回一次性秘密，缓存与重放只包含安全投影；
- `receipt`：首次和重放都只返回稳定、安全的变更回执，客户端随后走授权 GET 获取最新资源。

PersonProfile 与 dietary constraint 写操作固定使用 `receipt`。邀请码创建使用 `one-time-secret`。当前不含敏感字段的家庭、库存、邀请撤销、加入、成员退出/移除及档案关联命令使用 `full`。登录交换不进入该通用响应缓存。

注册表由规范化路由类型穷尽约束，不允许 endpoint 传入临时 redact 回调。现阶段不增加 `response_policy` 或 `representation_version` 数据库列：策略由代码注册表确定，历史记录按 route 转换。能安全识别的历史 PersonProfile 响应改为 receipt；无法安全恢复语义的响应改为 `nonReplayable` tombstone；两者都保留幂等 key、请求哈希和已完成命令标识，避免重复执行。历史邀请码只移除秘密字段。

### 最小数据库权限

撤销 `meal_agent_app` 对 `memberships` 的直接 `UPDATE`，删除宽 UPDATE RLS policy。成员退出/移除只通过 `meal_agent_private.transition_membership_status` 执行；邀请赎回和 dining-only profile 关联也只通过窄参数的 `SECURITY DEFINER` 函数执行。

这些函数固定 `search_path`、完整限定对象、关闭函数内 RLS、归 migration role 所有，并撤销 `PUBLIC` 的执行权限后仅授予应用角色。另执行 `REVOKE CREATE ON SCHEMA public FROM PUBLIC`。HTTP capability 检查继续存在，数据库函数作为 defense-in-depth，不替代 HTTP 授权。

### PersonProfile 资源与生命周期

- `/members` 继续表示登录成员目录；独立 profile list/get 统一读取 linked 与 dining-only profile，并支持 `active`、`archived`、`all`。
- owner 或 profile 本人可读完整字段；其他家庭成员只读安全投影，结构上排除 `subject_and_owner` 约束。
- archive 保留原 ID 和唯一身份；restore 恢复同一行，不通过复制创建新档案。
- 成员退出或被移除时，在同一事务归档其 linked profile；重新加入不自动恢复，也不复制私人约束。
- dining-only profile 关联登录成员必须由 owner 发起并由被关联用户确认；禁止按姓名自动合并。转回 dining-only 需要未来独立确认命令，本阶段不隐式执行。

### 未知事实、硬约束与生成契约

`defaultParticipation`、`defaultPortionScale`、`cookingSkill` 支持 `null`，新建和旧数据迁移都不得猜测默认值。阶段 08 提供这些已有字段的查看和编辑；正式 cooking-technique 词表留作阶段 09 数据治理前置，因此 FAM-005 仍为部分完成。

客户端覆盖全部现有 hard constraint kind。allergy/food concept 使用结构化标识；没有确定性规则映射的 hard constraint 标记 `needs_structured_mapping`，推荐边界必须阻断，模型不得猜测。确认指纹包含 kind、enforcement、label、food concept、allergen、notes 和 visibility，任一字段变化都会使旧确认失效。

公共 Zod 边界上的所有 refine/superRefine 进入稳定 rule manifest：可表达规则生成原生 JSON Schema，其他规则以稳定 rule ID 的 runtime-only 扩展公开，并有运行时、生成 schema 与 OpenAPI 一致性门禁。生成 OpenAPI 是唯一产物，不手工维护第二份 JSON。

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
- `0002` 的敏感响应清理与权限收窄不提供恢复旧不安全状态的 down migration；失败时事务整体回滚，成功后只允许 roll-forward。
- 本地 Stage 08 可以形成完整安全、契约、数据库、HTTP、客户端、E2E、weapp 和 GUI 证据，但真实微信、真机、体验版、发布、云环境和远端 CI 仍按各自门禁单独验收。
- 阶段 09 在正式 cooking-technique 与宗教/伦理规则词表完成治理前不得把自然语言约束交给模型执行。
