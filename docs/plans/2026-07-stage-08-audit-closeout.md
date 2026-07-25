# 阶段 08：审计整改与架构收口计划

- 日期：2026-07-25
- 实际分支：`codex/stage-08-audit-closeout`
- 实际 worktree：`/Users/aipuli/.codex/worktrees/39f9/meal-agent-lab`
- 仓库主 worktree：`/Users/aipuli/Documents/Projects/meal-agent-lab`
- 审核基线：`main@6e4fc11607d34f4c30f8bfccf449bf5dfbbddabd`
- 与要求基线 `main@6e4fc116` 的差异：无；编写本计划时本地 `main` 未继续前进
- 远端状态：仓库未配置 `remote` 或 `upstream`，没有可核验的远端 CI 证据
- 状态：**Proposed — 等待项目总控“实施前评审”**

## 1. 结论与边界

阶段 08 当前只能记为“纵切已实现、审计整改未完成”，不能记为完整验收，且在本计划全部合并前门禁通过前不得开始阶段 09。现有自动化通过证明了阶段 08 的基本正向路径，但不能抵消幂等缓存中的敏感数据副本、数据库角色越权面、不可读取/不可恢复的 PersonProfile 生命周期、运行时与 OpenAPI 不一致，以及客户端未完成冻结 P0 范围等问题。

本轮只形成整改方案、架构分析和实施计划：

- 只新增本计划文档，不修改业务代码、共享契约、migration、测试、ADR 或既有事实源；
- 不合并、修改或改写 `main`；
- 不回到 `codex/stage-06-backend-vertical-slice` 或旧阶段 08 分支修改；
- 不扩大到菜单推荐、菜谱、采购、做饭或 Agent；
- 延续 Node.js/Fastify 模块化单体、PostgreSQL/Drizzle、Taro/React 和共享 contracts；不拆微服务，不引入向量数据库、第二数据库或第二份 DTO；
- 真实 AppID、AppSecret、用户数据、健康数据和真实家庭数据不得进入代码、测试、日志或本文档。

实施阶段必须先由项目总控批准本计划中的开放决策，再从本分支继续或另建经总控指定的实施分支。任何实现提交仍不得自行合并 `main`。

## 2. 审计基线与已核事实

依据 [MVP 范围](../product/mvp.md)、[App 功能规格](../product/app-functional-spec.md)、[食品安全边界](../safety/food-safety.md)、[系统概览](../architecture/system-overview.md)、[ADR-0003](../architecture/decisions/0003-identity-tenancy-and-api-semantics.md) 和[原阶段 08 计划](2026-07-stage-08-members-and-constraints.md)，当前实现存在以下架构事实：

1. 通用幂等执行器默认把完整成功响应写入 `idempotency_records.response_body`，只给创建邀请码临时提供了可选 `redactStoredData` 回调。档案更新、约束新增和约束删除仍会复制完整 PersonProfile，包括 `subject_and_owner` 约束。
2. `memberships_manage_update` 的 RLS 允许普通成员更新本人行，`meal_agent_app` 同时拥有 `memberships` 整表 `UPDATE`。HTTP repository 目前只更新状态，但数据库角色本身仍能更新本人 `role`、`capabilities` 等列。
3. `GET /members` 只读取 `linked_membership_id IS NOT NULL AND status = 'active'` 的档案；仅用餐档案及 archived 档案没有独立 list/get 读取资源。
4. `person_profiles_linked_membership_unique` 不区分 active/archived。归档后该行仍正确占用唯一身份，但当前客户端把成员解释为“没有档案”，并尝试重新创建；服务端没有 restore，因此进入永久 409/不可恢复状态。
5. consumed request 的正数要求由 `exactQuantityAmountSchema.refine(amount !== "0")` 实现。Zod 运行时执行该谓词，当前 OpenAPI 生成只看到允许 `"0"` 的基础 pattern；`x-zod-refinements` 只是说明文字，不是可执行约束。
6. 客户端页面把 hard constraint 固定构造成 `kind: "allergy"`，档案创建把 `defaultParticipation=true`、`defaultPortionScale=1`、`cookingSkill="beginner"` 固定为默认值，且没有仅用餐档案管理或档案编辑入口。
7. 创建邀请持有待重试 key，其余多项阶段 08 写操作在 handler 每次调用时重新生成 key；网络超时后的同动作重试可能成为第二个逻辑 command。
8. owner 成员视图把每行 `isSelf` 固定为 false；当前单 owner 场景被“最后 owner 不可退出”遮住，但多 owner 时会把本人当作他人移除。
9. `pnpm audit --prod` 于 2026-07-25 实测退出码为 1：**1 critical、1 high、8 moderate**。critical 是 `swiper`（GHSA-hmx5-qpq5-p643），high 是 `brace-expansion`（GHSA-mh99-v99m-4gvg）；moderate 为 `esbuild`（GHSA-67mh-4wv8-2f99）、`uuid`（GHSA-w5hq-g745-h8pq）和六条 `webpack-dev-server` 通告（GHSA-9jgg-88mc-972h、GHSA-4v9v-hfq4-rm2v、GHSA-79cf-xcqc-c78w、GHSA-mx8g-39q3-5c79、GHSA-f5vj-f2hx-8m93、GHSA-m28w-2pqf-7qgj），均来自 Taro 传递路径。现有 CI 未执行依赖审计。
10. 当前测试声明数量已经漂移：源码中的数据库测试与客户端单测条目多于状态文档记录；根 README、项目状态、系统概览、API README、Client README、原阶段 08 计划对“完成状态、路由、客户端范围、GUI 证据、漏洞数量”的描述互不一致。
11. `main@6e4fc116` 是模拟器走查后修复提交，修复了 Zod jitless import 顺序和本人退出后的错误刷新；当前仓库没有该修复后的完整 GUI happy-path 复跑记录，也没有覆盖实际页面入口的自动回归门禁。

## 3. 架构收口总览

本计划推荐以下组合方案：

| 领域 | 推荐方案 | 不采用 |
| --- | --- | --- |
| 幂等与敏感数据 | 按 normalized route 集中登记 `full`、`one-time-secret`、`receipt`、`forbidden` 四类持久化策略；敏感资源写 command 首次和重放都返回最小 receipt，资源内容经 GET 读取 | 各 endpoint 自行选择可选 `redactStoredData`；在缓存里加密或继续保存完整私密档案 |
| Membership 授权 | 撤销应用角色对 `memberships` 的表级 UPDATE，使用窄参数、固定 `search_path` 的受控数据库状态迁移函数；HTTP 仍先做 capability 检查 | 只依赖 repository 约定；继续使用当前宽表 UPDATE |
| PersonProfile 读取 | 新增独立 profile list/get，统一返回登录成员档案和仅用餐档案；`/members` 保持 membership 目录语义 | 把仅用餐档案伪装成 membership 塞进 `/members` |
| 生命周期 | archive 可逆、restore 原行；登录成员永远复用同一个 profile id，archived 不允许重新创建 | 归档后另建新行；把 archived 行从唯一索引排除 |
| 契约生成 | 能表达的规则直接生成 JSON Schema；不能表达的规则必须通过统一 helper 登记稳定 rule id 和结构化 OpenAPI 扩展，禁止裸 `.refine`/`.superRefine` | 手工编辑生成的 OpenAPI JSON；仅保留无法验证的自然语言说明 |
| 客户端 | 完成 FAM-003/004/005 冻结范围，并用“动作指纹 + 持久 pending key”的状态机统一幂等重试 | 继续用“本阶段固定”隐藏饭量、参与状态、厨艺和约束类型 |
| 依赖审计 | critical/high 默认阻断合并；moderate 只能按 advisory、路径、范围、期限显式接受；任何新增或过期接受项阻断 | 只比较“是否比上次新增”；无到期日的永久接受 |
| 远端 CI | 真实 remote/upstream、受保护合并入口和一次绿色远端 CI 作为合并 `main` 前门禁 | 把本地 workflow 文件存在等同于远端 CI Pass |

## 4. 审计问题追踪矩阵

| ID | 问题 | 修复任务 | 主要影响面 | 必需证据 | 关闭条件 |
| --- | --- | --- | --- | --- | --- |
| P1-01 | PersonProfile 私密约束进入 30 天幂等记录 | IDEM-01～04：集中策略注册表、receipt 响应、旧记录安全投影/清理、持久化扫描 | contracts、migration、API、client、DB/HTTP test、ADR 提案 | 私密 sentinel 不出现在任何 `response_body`；新 route 未登记策略时编译/测试失败 | 首次/重放兼容语义通过，现存记录已处理 |
| P1-02 | 普通成员可在数据库层把本人 role 更新为 owner | AUTH-01～04：撤销表级 UPDATE、受控 membership transition 函数、收窄 RLS/EXECUTE、反向测试 | migration、repository、DB test、ADR 提案 | `SET ROLE meal_agent_app` 直接改 role/capabilities 被拒；受控正向路径通过 | HTTP 和数据库两层都不能提权 |
| P1-03 | 仅用餐档案创建后不可读取管理 | PROF-01～03：独立 list/get、统一 profile 视图、客户端管理入口 | contracts、API、client、HTTP/E2E | owner 能创建、再次列出、读取、编辑仅用餐档案；member 只能看到安全投影 | 仅用餐档案形成完整 CRUD 读取闭环 |
| P1-04 | archive 后重新创建与唯一索引冲突，无 restore | PROF-04～06：restore command、active/archived 过滤、客户端恢复入口 | contracts、API、client、DB/E2E | archive 后 active 列表隐藏、archived 列表可见、restore 同 id/version 前进 | 不存在不可恢复死路 |
| P1-05 | runtime 拒绝 exact `"0"`，OpenAPI pattern 接受 | CONT-01～04：正数 decimal 原生 pattern、统一 refinement helper、OpenAPI parity 测试 | contracts、OpenAPI generator/check、HTTP test | `"0"`、`"0.0"`、`"0.000000"` 在 runtime/OpenAPI/HTTP 三层一致拒绝 | 生成产物不再接受数学零 |
| P1-06 | 客户端硬约束和档案字段范围不完整 | CLI-01～05：FAM-003/004/005 表单、完整 hard kind、编辑、仅用餐档案、archive/restore | contracts、可选 migration、client、unit/E2E | 每个 hard kind、饭量、参与状态、厨艺和不愿执行技术都有正反例 | 冻结 P0 范围可操作、可恢复 |
| P1-07 | 模拟器修复后缺完整复跑和入口回归 | ACC-01～03：实际入口自动回归、GUI 脚本、证据模板 | client test、E2E、docs | 基于目标 commit 的完整 GUI 记录；实际成员/档案入口自动测试 | 未复跑不得记 GUI Pass |
| P2-01 | 同一用户用两个邀请码并发加入同一家庭可能 500 | JOIN-01～02：按 user+household 串行化或冲突归一、双码并发测试 | migration function、API、DB/HTTP test | 一个请求 joined，另一个稳定 409 already-member；无 500，邀请码计数正确 | 并发唯一冲突被业务语义吸收 |
| P2-02 | 日志脱敏器不识别 `inviteCode` | LOG-01：键归一规则加入 invite code，并覆盖嵌套、大小写和下划线 | API logging、unit/DB log sentinel | `inviteCode`/`invite_code`/嵌套值均为 `[Redacted]` | 明文码不出现在结构化日志 |
| P2-03 | 已过期邀请仍以 active 返回 | INVITE-01：统一 effective status 投影，列表按同一时钟计算 | API mapper/query、contract/DB test | 过期且库内 raw active 的邀请对客户端返回 expired | 列表、兑换、上限统计语义一致 |
| P2-04 | 客户端同动作重试换 key | IDEM-05 / CLI-06：动作级 pending key 状态机 | client core/pages、unit/E2E | timeout/5xx/手动重试复用 key；修改 payload 或取消后才换 key | 所有阶段 08 command 通过同一组件 |
| P2-05 | owner 视图 `isSelf=false` | CLI-07：按 session user id 计算 self，不按 viewerRole 猜测 | client、unit/E2E | 多 owner fixture 下本人只能走退出；移除他人路径不误用 | owner/member 两种响应均正确识别本人 |
| P2-06 | 依赖审计 1 critical、1 high、8 moderate，CI 缺审计 | DEP-01～04：机器可读审计、阻断/期限接受、升级验证、CI gate | root scripts、CI、risk record、docs | 当前 advisory 逐条处置；新增/过期项令 gate 失败 | 总控批准且 CI 执行策略 |
| P2-07 | 文档与测试数量事实源漂移 | DOC-01～03：同步事实源、生成验证摘要、不手填易漂移计数 | README、status、system/API/client README、stage 08 plan | 链接检查、术语扫描、脚本输出与文档一致 | 只保留一个当前验收结论 |
| P2-08 | 无 remote/upstream/远端 CI 证据 | DEL-01～02：配置受控 remote、真实 PR CI 与保护规则 | Git hosting、CI、交付记录 | `git remote -v`、目标 PR/commit、绿色 CI URL/ID 可核验 | 作为合并 main 前门禁完成 |

## 5. A — 幂等与敏感数据

### 5.1 集中式策略

把 normalized route 从普通字符串提升为受控枚举，并要求每个使用通用幂等层的 route 在一个注册表中声明响应持久化策略。建议类型语义如下：

```text
full
  首次返回完整响应；缓存同一完整 data；重放返回同一 data。

one-time-secret
  首次响应可附带一次性秘密；缓存前转换为公开/安全投影；
  重放只返回安全投影，contract 明确一次性字段 optional。

receipt
  首次和重放都只返回不含资源敏感字段的 mutation receipt；
  客户端按 resource id 走授权 GET 读取最新表示。

forbidden
  禁止进入通用 response replay；用于 token/session secret 等命令。
```

注册表必须同时声明：

- normalized route、HTTP method、scope；
- 首次 response schema；
- stored response schema；
- replay response schema；
- 策略 id 与 representation version；
- 对应的敏感数据分类；
- 是否允许首次/重放响应存在明确差异。

`#runIdempotent` 不再接受可选 endpoint 回调。未登记的幂等 route、策略 schema 不匹配、或 `full` 响应包含被禁止字段时必须在类型检查或测试中失败。数据库记录建议增加 `response_policy` 与 `representation_version`，便于旧记录迁移和未来安全策略升级。

### 5.2 当前 endpoint 分类

| Endpoint | 策略 | 可存内容 | 首次/重放语义 |
| --- | --- | --- | --- |
| `POST /api/v1/households` | `full` | household、membership、安全 owner profile；继续由 safe schema 保证不含私密约束 | data 相同；只改变 requestId 和 replay meta |
| `POST .../inventory-lots` | `full` | 当前阶段库存批次与 acquired event | data 相同 |
| `POST .../events/consumed` | `full` | lot 与 consumed event | data 相同 |
| `POST .../invites` | `one-time-secret` | 只存 invite 实体，不存 `inviteCode` | 首次可能有 code；重放无 code；contract 必须显式表达 |
| `DELETE .../invites/:inviteId` | `full` | 已撤销 invite 实体，不含 code/digest | data 相同 |
| `POST /api/v1/households/join` | `full` | membership 与 household 摘要 | data 相同 |
| `DELETE .../memberships/:membershipId` | `full` 或最小 receipt | membership 不含 provider/token/私密约束；优先在同一轮统一为 receipt | 已选策略内 data 相同 |
| `POST .../person-profiles` | `receipt` | `profileId`、`resultingVersion`、`status`、operation | 首次/重放 receipt 完全相同；随后 GET |
| `PATCH .../person-profiles/:profileId` | `receipt` | 同上，不存显示名、约束或其他 profile 字段 | 首次/重放 receipt 完全相同；随后 GET |
| `POST/DELETE .../dietary-constraints` | `receipt` | `profileId`、`resultingVersion`、operation、可选 constraint id | 首次/重放 receipt 完全相同；随后 GET |
| 微信登录交换、session token 签发/撤销 | `forbidden` | 不进入通用 replay | 沿用 ADR-0003 的专用语义 |

普通库存数据仍受 household RLS 保护，当前可按 ADR 的 30 天策略存完整响应；以后如确定更严格的数据最小化要求，可单独把库存 command 提升为 receipt，而不能让 endpoint 临时覆盖全局默认。

### 5.3 首次响应与重放兼容

兼容定义不是“所有 endpoint 必须逐字节相同”，而是“相同用户动作只执行一次，且首次/重放差异由 contract 明确、客户端不会把安全投影误认为完整资源”：

- `full`：领域 data 相同；
- `one-time-secret`：秘密只在首次成功响应出现，非秘密字段相同；客户端不得声称可从列表重新读取明文码；
- `receipt`：首次与重放都返回相同 receipt，不存在“首次完整、重放被静默删字段”的歧义；
- 任何资源最新状态统一通过 GET 获取，GET 再按 owner/self/household 视图做 redaction。

当前 PersonProfile 写响应从完整实体改为 receipt 会改变既有 v1 success data 语义。严格遵守 ADR-0003 时应进入 `/api/v2`；考虑项目尚未发布、阶段 08 尚未验收，也可由总控批准一次“验收前纠正 v1”的窄例外，并在 ADR 中记录。实施前必须二选一，不能用无标记的删字段规避版本决策。

### 5.4 已存在记录的处置

新增 migration 必须在不打印 response body 的前提下：

1. 统计受影响 normalized route、行数和时间范围；
2. 将档案相关完整 response 原地改写成最小 receipt，保留 key、request hash、status、原始 request id 和 first processed time；
3. 删除任何无法构造安全 receipt 的异常记录，而不是继续保留私密副本；
4. 断言 `response_body` 不再包含 `dietaryConstraints`、`subject_and_owner`、私密 sentinel 或 `inviteCode`；
5. 记录仅含计数和 migration checksum 的证据，不导出原始内容。

安全清理不可逆；回滚不得重新生成被清除的私密数据。

## 6. B — 授权与 RLS

### 6.1 三种方案比较

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 列级 GRANT | 改动小；撤销整表 UPDATE 后只允许 `status`、`updated_at`、`version`，可直接阻断 role/capabilities 更新 | 仍允许应用角色直接发起任意状态迁移；最后 owner、合法 old→new 状态和操作者语义主要留在应用层 | 可接受的最小补丁，但不是推荐收口 |
| 受控数据库函数 | 应用角色无任何 memberships 表 UPDATE；函数只暴露“退出/移除”业务状态迁移，可同时固定 role 不变、检查 owner/self、最后 owner、并发和版本 | SECURITY DEFINER 需要固定 `search_path`、撤销 PUBLIC EXECUTE、显式 owner、严格测试；数据库中会保留少量关键业务不变量 | **推荐** |
| 现有 repository UPDATE + 表级 UPDATE | 代码直观，已有 HTTP 正向测试 | RLS/GRANT 允许本人整行更新，数据库 defense-in-depth 失效；SQL 注入或未来错误 query 可直接提权 | 拒绝 |

### 6.2 推荐的最小权限路径

新增 `meal_agent_private.transition_membership_status(...)`（最终命名由实现确定）：

- 输入只含 target membership id、期望状态/动作和 expected version；不接受 role、capabilities、user id 或 household id 作为可任意写值；
- household/user 从 transaction-local context 取得；
- 只允许 active→left（本人退出）或 active→removed（owner 移除他人）；
- 锁定家庭成员变更，数据库层再次执行最后 active owner 保护；
- 固定 `SECURITY DEFINER`、`search_path = pg_catalog, public`、`row_security = off`，owner 为 migration role；
- `REVOKE ALL ... FROM PUBLIC`，只给 `meal_agent_app` EXECUTE；
- 撤销 `meal_agent_app` 对 `memberships` 的表级/列级 UPDATE，并移除已无用途的宽 UPDATE policy；
- 返回稳定 result code，由 repository 映射为既有 403/404/409 problem；不得把数据库原始错误返回 HTTP。

HTTP 层仍必须先 bootstrap HouseholdContext、检查 owner/self capability，并对不属于家庭的 target 返回 404。数据库函数不是替代 HTTP 授权，而是在 repository 写错或直接 SQL 路径出现时继续阻断越权。

邀请赎回函数仍是唯一允许创建/重新激活 membership 的数据库路径。它应同时处理 P2-01：在确认 invite 可用后按 `(user_id, household_id)` 串行化，再读取/写入 membership；两个不同邀请码并发加入时，一个成功，另一个返回 already-member，第二个邀请码不得错误增加 `used_count`，更不能泄露唯一约束为 500。

### 6.3 必增数据库反向越权测试

在真实 PostgreSQL 18、`SET ROLE meal_agent_app` 下至少覆盖：

1. 普通成员直接把本人 `role` 改为 owner：permission denied；
2. 普通成员直接改本人 capabilities、user_id、household_id：permission denied；
3. 普通成员直接改他人 status：RLS/权限拒绝；
4. 普通成员通过受控函数退出本人：成功且 role/capabilities 不变；
5. 普通成员通过受控函数移除他人：forbidden；
6. owner 通过受控函数移除普通成员：成功；
7. owner 移除/退出最后一位 active owner：单请求和并发请求都被拒；
8. 多 owner fixture 中 owner 退出本人：只把本人变为 left；
9. 跨家庭 target、缺 user context、缺 household context、inactive caller：全部拒绝且不泄露行存在性；
10. `meal_agent_app` 没有 memberships UPDATE privilege，PUBLIC 没有函数 EXECUTE；
11. 应用角色不能利用 creator insert policy 给既有家庭任意插入 owner；
12. 两个不同邀请码并发加入同一 user/household：稳定得到 201 + 409，无 500，两个 invite 的计数符合实际消费。

## 7. C — PersonProfile 资源模型

### 7.1 资源职责

`Membership` 表示登录用户在家庭中的权限；`PersonProfile` 表示实际用餐者。仅用餐档案没有 Membership，因此 `/members` 不应被扩展成混合资源集合。

推荐新增：

```text
GET /api/v1/households/{householdId}/person-profiles
    ?status=active|archived|all&cursor=...&limit=...

GET /api/v1/households/{householdId}/person-profiles/{profileId}
```

现有 `GET /members` 保持“登录成员目录 + 可选关联档案视图”的兼容语义，不把仅用餐档案伪造成成员。客户端成员管理页同时使用 membership 目录与 profile 目录；本餐参与者的未来读取以 profile collection 为准。

### 7.2 统一读取与 redaction

profile list/get 同时覆盖：

- linked login profile；
- `linkedMembershipId` 为空的 dining-only profile；
- 经显式 status filter 读取的 archived profile。

响应必须使用结构性区分，而不是先返回完整对象再删字段：

| 请求者与资源关系 | active profile | archived profile | 约束可见性 |
| --- | --- | --- | --- |
| owner | 可 list/get | 可 list/get | 完整，包括 `subject_and_owner` |
| linked profile 本人 | 可 list/get 本人；他人只读安全投影 | 可 list/get 本人 archived | 本人完整；他人只含 household |
| 普通成员查看他人 linked profile | 可读安全投影 | 默认 404/不列出 | 只含 household |
| 普通成员查看 dining-only profile | 可读安全投影 | 默认 404/不列出 | 只含 household |
| dining-only profile 的“本人” | 无登录身份，不存在 self 授权路径 | 无 | 私密约束只有 owner 可见 |

服务端推荐/安全校验未来可以在内部读取完整硬约束，但客户端 redaction 不改变硬约束的强制执行；模型不得参与可见性或安全判定。

### 7.3 生命周期与唯一索引

生命周期固定为：

```text
active --archive(expectedVersion)--> archived
archived --restore(expectedVersion)--> active
```

- archive 是可逆停用，不是删除；保留 id、linkedMembershipId、约束、确认来源和版本；
- restore 更新同一行、同一 id，version 递增；
- linked profile 无论 active/archived 都只允许一个，因此保留现有唯一索引，不改为 `WHERE status='active'`；
- 对已有 archived linked profile 的 create 返回稳定 409（建议新增 `PERSON_PROFILE_ARCHIVED` code），并由客户端展示“恢复档案”，不提示重新创建；
- dining-only profile 也优先 restore 原档案；因其没有可证明的外部身份，不用 displayName 做唯一键，也不以同名自动合并；
- active 列表默认供正常参与者选择；archived 只出现在管理/恢复视图。

PATCH 的 operation union 增加 `restore`，或使用明确的 restore command 子资源；推荐沿用现有 PATCH 状态迁移以减少路由分裂，但必须使用 expectedVersion 和幂等 key。

### 7.4 migration、契约版本与兼容

- PersonProfile 生命周期本身不需要修改唯一索引；
- FAM-005 若补充“不愿/不会执行的烹饪技术”，需要 additive column（建议版本化 code array、空数组 backfill、NOT NULL）或等价的可审计结构，不能塞入客户端本地状态；
- membership 受控函数、幂等策略字段和历史缓存清理需要新的 additive migration，建议顺序名为 `0002_stage_08_audit_closeout.sql`；
- list/get、restore、稳定错误码和字段新增需要升级 `@meal-agent/contracts`，建议 0.4.0；
- profile mutation 从完整实体改为 receipt 涉及 response 语义。项目总控必须在“严格新增 `/api/v2`”和“尚未发布前原位纠正 `/api/v1` + ADR 窄例外”之间决定。不得假称纯 additive。

## 8. D — 契约单一事实源

### 8.1 根因

Zod `.refine`/`.superRefine` 接收任意 JavaScript 谓词。JSON Schema/OpenAPI 生成器无法通用反编译该函数，只能转换基础 string pattern、min/max、union 等可表达部分。当前 `.meta({"x-zod-refinements": [...]})` 保存了人类说明，但 OpenAPI validator 不会执行说明，所以“同一个 Zod schema 生成 OpenAPI”不等于“两个边界行为相同”。

exact `"0"` 的具体丢失路径是：

```text
允许非负数的 base pattern
  → overwrite 规范化 decimal alias
  → refine(amount !== "0")
  → OpenAPI 只生成 base pattern，故 "0" 仍合法
```

### 8.2 通用修复规则

1. **可直接表达的约束必须原生表达。** 正数 decimal 使用一个可复用 pattern，同时拒绝 `"0"`、`"0.0"`、`"0.000000"` 等数学零；不要再靠 `.refine` 补正数语义。oneOf、const、not、min/max、uniqueItems 等同理。
2. **禁止业务 schema 直接调用裸 `.refine`/`.superRefine`。** 在 contracts 中提供统一 helper，要求每条规则登记稳定 `ruleId`、版本、作用路径、运行时函数和 OpenAPI 表达模式。
3. **无法直接表达的规则使用结构化扩展。** 将现有自然语言数组替换/补充为例如 `x-meal-agent-runtime-rules`，每项至少含 `id`、`version`、`scope`、`enforcement=runtime-only` 和说明。它明确告诉生成器/SDK：该规则只能由服务端 runtime 保证，不能宣称 OpenAPI validator 已等价执行。
4. **生成器做覆盖校验。** 每个已登记 rule 要么生成原生 JSON Schema 片段，要么出现在结构化 runtime-only 扩展；遗漏、重复 id、无版本或既非 native 也非 runtime-only 时 `openapi:check` 失败。
5. **AST/源码门禁禁止绕过 helper。** 用 TypeScript AST 或等价静态检查禁止 contracts 业务文件新增裸 refine；不依赖人工 code review 搜索。
6. **生成 JSON 永远只由脚本写入。** `services/api/openapi/*.json` 仍是审查产物，不允许手工补 pattern 或 extension。

### 8.3 runtime/OpenAPI 一致性测试

建立共享 case matrix，对每个路由 request 同时执行：

- Zod runtime `safeParse`；
- 从生成 OpenAPI 中抽取的 request schema validator；
- 真实 Fastify HTTP request（关键安全/数值规则）。

exact consumed amount 至少覆盖：

| 输入 | Runtime | OpenAPI validator | HTTP |
| --- | --- | --- | --- |
| `"0"`、`"0.0"`、`"0.000000"` | reject | reject | 400 |
| `"0.000001"`、`"1"`、`"1.000000"` | accept 并按既有规则规范化 | accept | accept |
| `0`、`1` JSON number | reject | reject | 400 |
| `"1e0"`、负数、7 位小数、超上限 | reject | reject | 400 |

对于跨字段、结果一致性等 runtime-only rule，OpenAPI 测试必须断言稳定 rule id 存在，HTTP/contract 反例必须证明服务端执行了该规则。扩展存在不能替代行为测试。

## 9. E — 客户端冻结范围

### 9.1 FAM-003

阶段 08 必须完成：

- owner 创建、查看、编辑、归档、恢复仅用餐档案；
- 登录成员创建/管理本人 linked profile；
- displayName、default portion scale、default participation 均可编辑；
- active/archived 分区与 restore；
- owner/member 两种成员响应下都按 `membership.userId === session.user.id` 识别本人；
- 空、加载、失败、无权限、版本冲突、重复提交、取消与恢复状态。

不得把上述能力继续写成“本阶段固定”。本餐临时参与者选择（FAM-007）仍属于后续推荐纵切，但 default participation 的档案维护属于本阶段。

### 9.2 FAM-004

hard kind 必须全部可选择和回显：

- `allergy`
- `religious`
- `ethical`
- `explicit_avoid`
- `food_safety_exclusion`

soft preference 保持独立流程。二次确认必须绑定表单动作指纹：确认后若 kind、label、结构化目标或 visibility 任一变化，原确认立即失效。

标签只用于展示，不能成为未来确定性匹配的唯一依据。建议在 contracts 中补齐类型化结构目标：

- allergy：`allergenCodes` 或 `foodConceptIds`；
- explicit avoid：`foodConceptIds`；
- religious/ethical/food safety：版本化、审核过的 rule codes，必要时再关联 food concepts。

在确定性映射未就绪前，相关档案进入“约束待结构化”的安全状态，后续推荐必须阻断或要求确认，不能把自然语言 label 交给模型猜测。rule code 的最小词表和版本归属需总控在实施前确认，但“完整 hard kind UI + 双确认 + 可见性”不能推迟到阶段 09。

### 9.3 FAM-005

阶段 08 必须让用户编辑：

- `cookingSkill`；
- 不会或不愿执行的烹饪技术 code 集合。

技术 code 必须来自版本化确定性词表，客户端不得自由生成内部 code。阶段 08 只负责档案记录与读取；按本餐厨师过滤菜谱属于后续推荐阶段。

### 9.4 同动作幂等重试

在 client core 提供统一 pending action 状态机，不让每个页面自行管理 ref：

```text
idle
  → confirmed(payload fingerprint, idempotency key)
  → submitting
  → retryable-failure（保留同 key 和原 payload）
  → submitting（同 key）
  → succeeded / explicitly-cancelled（释放 key）
```

- transport error、timeout、retryable 5xx、页面短暂卸载后重试均复用同 key；
- 用户修改会影响 request hash 的字段时，明确取消旧动作并为新 payload 生成新 key；
- version conflict 刷新后因 expectedVersion 改变，必须重新确认并生成新动作/key；
- pending key 与 payload fingerprint 可持久化在本地非敏感存储，不能持久化邀请码、约束内容或 token；
- 加入家庭、撤销邀请、移除/退出、档案创建/编辑/归档/恢复、约束增删全部使用同一机制；
- 单测必须模拟“服务端已成功但客户端丢失响应”，第二次请求仍用原 key 并得到 replay。

## 10. F — 验收与交付门禁

### 10.1 分层门禁

| 层级 | 必需验收 |
| --- | --- |
| 安全 | 幂等表无私密约束/邀请码；日志 inviteCode 脱敏；敏感响应策略全 route 覆盖；无真实数据/密钥 |
| 契约 | contracts 0.4.0（或总控批准版本）runtime tests；所有 native/runtime-only rule 有稳定登记；OpenAPI parity |
| 数据库 | 0000→0001→0002 增量、空库全量、checksum、旧幂等记录安全改写、GRANT/RLS/SECURITY DEFINER 反向测试 |
| HTTP | profile list/get/restore、redaction、过期邀请 effective status、双邀请码并发 201+409、稳定 problem code |
| 客户端 | FAM-003/004/005 表单与状态；动作级幂等；owner isSelf；archive/restore；实际入口测试 |
| 双用户 E2E | A owner、B member、C observer；仅用餐档案、私密约束、并发 join、归档恢复、本人退出、跨家庭 404 |
| weapp | typecheck、单测、生产构建、Zod jitless 入口回归；构建产物扫描 |
| GUI 模拟器 | 基于待合并 commit 的完整 happy-path，记录版本、commit、步骤、结果与非敏感截图；修复后重跑 |
| 依赖 | 机器可读 audit gate；critical/high 处置；moderate 逐条期限接受；新增/过期项失败 |
| 交付 | `pnpm stage08:check` 继续通过且包含新增回归；本地文档链接；真实远端 PR CI；`git diff --check` |

### 10.2 `stage08:check`

保留根命令名称，不创建平行的“看起来更绿”的弱门禁。实现后它至少串联：

1. environment check；
2. migration 增量/空库/checksum；
3. contracts typecheck/runtime/build；
4. API unit/HTTP/PostgreSQL/OpenAPI/build；
5. client typecheck/unit/weapp build；
6. 阶段 07 与阶段 08 E2E；
7. 敏感缓存/日志 sentinel；
8. runtime/OpenAPI parity；
9. 依赖审计策略检查；
10. Markdown 本地链接检查。

测试数量应从 test runner 输出或验证摘要生成，不再手工复制到多个 README。

### 10.3 GUI happy-path

自动化必须覆盖实际入口“家庭列表 → 成员 → 我的档案/档案管理”，不能只测 core function。GUI 至少复跑：

1. A 登录并创建/选择家庭；
2. A 从成员页创建邀请；
3. B 通过实际加入入口加入；
4. A 创建一个仅用餐档案，编辑饭量、常参与和厨艺；
5. B 创建/编辑本人档案；
6. 录入不同 hard kind，验证双确认和 visibility；
7. archive 后从 archived 管理页 restore，确认同 id 恢复；
8. 多 owner fixture/受控测试环境验证 owner 本人标记；单 owner 退出被保护；
9. B 退出后清当前家庭并回到家庭列表，不再请求已退出家庭；
10. 网络丢失响应后点击重试，服务端显示 replay 且无重复写。

GUI 只可使用本机 gitignored 测试号配置和合成数据。记录中写“使用本机测试配置”，不得写 AppID/AppSecret。该模拟器 Pass 也不等于真实微信、真机或发布 Pass。

### 10.4 依赖审计决策

推荐默认策略：

- critical/high：**阻断合并 main**，先评估受支持的 Taro/transitive 升级或最小 override，并重跑 weapp、E2E、GUI；
- moderate：只有确认路径、可达性、运行环境、缓解措施、负责人和到期日后才可期限接受；
- 当前 `swiper` 虽位于 Taro H5 路径，不能只凭人工观察永久接受；需用 weapp 构建产物扫描证明未打包，并由总控决定是否给不超过 14 天的临时例外；
- 当前 `brace-expansion`、`webpack-dev-server`、`esbuild`、`uuid` 路径需证明只在受控本地构建/开发环境使用，开发服务器不得对不可信网络开放；
- 新增 `audit:prod:check` 读取 `pnpm audit --prod --json`，按 advisory id 和精确路径匹配版本化 allowlist；任何新 advisory、严重度上升、路径变化或到期项令 CI 失败；
- critical/high 即使获短期例外，也继续阻断 H5 部署、外部内测和正式发布。

最终选择“全部阻断”还是“对当前 critical/high 作短期例外”属于项目总控的显式风险接受，不能由实施者自行决定。

### 10.5 远端 Git/CI

远端 Git/CI 定义为**合并 main 前门禁**，不是可以在合并后补做的近期交付项：

- 配置项目总控认可的 remote/upstream；
- 将实现分支推送到受控远端并创建 PR；
- 远端 CI 在目标 commit 上执行完整 `stage08:check` 和 audit policy；
- 分支保护禁止未通过检查直接合并；
- 交付记录保存 PR、commit、workflow run 和结论。

本地实现与验证可以在没有 remote 时继续，但在远端证据出现前只能报告“本地 Pass / 远端 Deferred”，不得合并 `main`。

## 11. 影响范围

| 层 | 计划影响 | 兼容性关注 |
| --- | --- | --- |
| contracts | profile list/get view、restore、mutation receipt、稳定 archived error、烹饪技术 codes、结构化 hard rule、refinement registry、HTTP envelope | mutation response 可能 breaking；需 v2 或总控批准验收前纠正 |
| migration | 新 `0002`；幂等 policy/version 字段和旧记录清理；membership privilege/function；可选 cooking technique column | 安全清理不可逆；必须验证 0000/0001 已应用库 |
| API | 集中幂等 policy、profile repository/routes、restore、redaction mapper、invite effective status、并发 join、日志脱敏 | v1/v2 路由决策；旧客户端 strict schema |
| client | profile collection、仅用餐档案、编辑/恢复、完整 hard kind、厨艺/技术、pending action state machine、isSelf | 不复制 DTO；只消费 contracts |
| tests | contracts parity、migration/RLS、HTTP、日志、DB 并发、client unit、双用户 E2E、weapp 入口、GUI | 使用虚构数据；不把 fake 微信记为真实 Pass |
| docs | 根 README、docs/project-status、system overview、API README、Client README、原阶段 08 计划、plans 导航、CHANGELOG、ADR 修改提案 | 先统一“未完整验收”；测试数量由命令生成 |
| CI/交付 | audit policy、完整 stage08 gate、远端 PR 证据 | 当前无 remote，不能伪造 |

实施阶段若需修改 ADR-0003，只提出并经总控批准以下修改点后另行提交：

1. 幂等由“所有 command 完整返回第一次 body”细化为 full/one-time-secret/receipt/forbidden 四类；
2. 私密资源 command 使用 receipt，资源读取通过授权 GET；
3. memberships 状态迁移使用受控数据库函数作为 defense-in-depth；
4. profile active/archive/restore 与仅用餐档案 redaction；
5. 如果选择原位纠正 v1，记录尚未发布阶段的窄例外及触发条件。

本轮不直接修改 ADR。

## 12. 数据兼容与回滚

### 12.1 migration 顺序

```text
0000_stage_06
  → 0001_stage_08
  → 0002_stage_08_audit_closeout
```

`0002` 必须同时在“已应用 0000+0001 的库”和空库全量序列验证。禁止修改已登记 checksum 的 0000/0001。

### 12.2 数据兼容

- 已有 profile id、linkedMembershipId、status、约束和 version 原样保留；
- 新 cooking technique code 字段若获批，以空数组 backfill；未知不得由模型或 migration 猜测；
- 已有 label-only hard constraint 只做可追溯的 `needs_structured_mapping` 标记或等价安全处理，不自动生成 rule code；
- archived linked profile 保持占用唯一索引，并通过 restore 恢复；
- 已存在幂等记录改写为 receipt 或删除不安全记录；不延长原 expiresAt；
- invite raw status 不要求批量写回 expired，API effective status 必须按同一时钟正确投影；若选择物化状态，需单独证明并发和定时任务，不在本方案默认引入 worker。

### 12.3 部署与回滚

推荐 expand-and-contract：

1. 先发布能读取 legacy/full 与新 receipt 两种幂等记录、但只写安全策略的新 API；
2. 执行 `0002` 权限收窄和旧记录安全改写；
3. 验证数据库 privilege、sentinel、profile GET；
4. 发布使用 receipt + GET 的客户端；
5. 完成 E2E、weapp、GUI 和远端 CI 后再移除 legacy reader。

回滚原则：

- 不回滚到重新写入完整私密 profile 的代码；
- 不恢复 `meal_agent_app` 的 memberships 表级 UPDATE；
- 不恢复被清除的敏感幂等 response；
- 如客户端回滚，API 至少在一个兼容窗口内保留总控批准的旧读取形状；
- migration 失败在事务内整体回滚；已成功完成的安全清理以 roll-forward 修复，不执行反向数据恢复；
- 尚无生产环境证据，不能假设线上数据为空；实施前需由总控确认实际环境清单。

## 13. 分批提交计划

每批保持可审查、可回滚，不把全部安全与客户端改动压成一个提交：

1. `docs(stage-08): approve audit closeout architecture`

   经总控评审后记录 ADR 修改提案和版本路线；只含文档。
2. `fix(contracts): make runtime and openapi rules verifiable`

   refinement helper/registry、positive decimal 原生约束、parity tests、生成 OpenAPI；不手改 JSON。
3. `fix(db): enforce membership least privilege and sanitize idempotency`

   `0002`、受控函数、GRANT/RLS 收窄、旧记录 receipt 改写、migration/反向测试。
4. `fix(api): centralize idempotency response policies`

   route policy registry、receipt、profile list/get/restore、统一 redaction mapper。
5. `fix(api): harden invite redemption and logging`

   双邀请码并发、effective status、inviteCode 脱敏及回归。
6. `feat(client): close profile and constraint scope`

   仅用餐档案、编辑、hard kinds、FAM-005、archive/restore、isSelf。
7. `fix(client): preserve idempotency across action retries`

   pending action 状态机及 timeout/replay 单测。
8. `test(stage-08): add audit closeout gates`

   DB/HTTP/client/双用户 E2E、weapp actual-entry、audit 和文档链接门禁。
9. `docs(stage-08): reconcile acceptance evidence`

   同步所有事实源，只记录实际 Pass/Deferred 和命令证据。

每批提交前运行对应最小门禁；第 8、9 批完成后运行完整门禁。推送、PR 和合并需项目总控授权与远端条件。

## 14. 完整验收命令

以下是实施完成后的目标命令；新增 script 名在实现时可微调，但根 `stage08:check` 必须保留：

```bash
corepack enable
pnpm install --frozen-lockfile

pnpm --filter @meal-agent/contracts check

pnpm --filter @meal-agent/api environment:check
pnpm --filter @meal-agent/api db:migrate:test
pnpm --filter @meal-agent/api test:unit
pnpm --filter @meal-agent/api test:http
pnpm --filter @meal-agent/api test:db
pnpm --filter @meal-agent/api openapi:check
pnpm --filter @meal-agent/api build

pnpm --filter @meal-agent/client typecheck
pnpm --filter @meal-agent/client test
pnpm --filter @meal-agent/client build:weapp
pnpm --filter @meal-agent/client test:e2e

pnpm audit:prod:check
pnpm docs:links:check
pnpm stage08:check

git diff --check
git status --short
```

GUI 联调命令：

```bash
MEAL_AGENT_DEV_API_PORT=3000 pnpm --filter @meal-agent/client dev:stack
pnpm --filter @meal-agent/client build:weapp
```

GUI 步骤必须按第 10.3 节执行并在目标 commit 上记录。真实微信链、真机和发布不在这些命令的 Pass 含义内。

## 15. Deferred

以下继续明确为 `Deferred — 外部依赖`，不得伪造或改记 Pass：

- 真实微信 AppID/AppSecret、`wx.login`/code2Session 和 HTTPS 合法域名；
- 真机扫码、真机存储、真机网络、多设备真实会话；
- 微信分享卡片、体验版、审核、发布和 CI 上传凭据；
- 生产云、托管数据库、正式 Secret 管理、WAF、备份恢复和可观测平台；
- Android、iOS、HarmonyOS 工具链、签名、实机和发布；
- 菜单推荐、菜谱、采购、做饭、Agent、报餐/投票；
- 所有权转移与家庭解散 UI。多 owner 只用合成数据库 fixture 验证本次 `isSelf` 和最后 owner 路径，不借机扩展 FAM-010。

远端 Git/CI **不列在上述长期 Deferred**：它是本轮实现完成后合并 `main` 前必须补齐的交付门禁。

## 16. 风险与仍需项目总控决定的问题

| 决策 | 推荐 | 不决策的后果 |
| --- | --- | --- |
| PersonProfile mutation receipt 是原位纠正 v1 还是新开 v2 | 若确认从未部署消费者，批准验收前原位纠正 v1，并在 ADR 记录窄例外；否则严格新开 v2 | 无法同时满足缓存安全、明确重放语义和 ADR 版本承诺 |
| Membership 使用受控函数还是列级 GRANT | 采用受控函数，列级 GRANT 只作回退 | 数据库层最后 owner/状态迁移仍可能被直接 SQL 绕过 |
| hard constraint 的 rule code 最小词表与所有者 | 在阶段 08 内确定版本化最小词表；label 仅展示 | FAM-004 虽能录入类型，但后续无法确定性执行，阶段 09 仍被阻断 |
| FAM-005 烹饪技术 code 字段 | 阶段 08 加 additive 持久字段和最小词表 | 继续只记录总级别，不满足冻结 P0 |
| 当前 critical/high dependency advisory | 默认阻断；若短期例外，必须由总控签署、限定 weapp/local、最长 14 天并禁止 H5/发布 | 无证据永久接受 critical/high，或实现分支长期无法合并 |
| 既有环境中的敏感幂等记录 | 对所有实际环境执行计数 + receipt 改写/删除，不假设为空 | 私密副本继续保留 30 天 |
| remote/upstream 与分支保护 | 由总控提供受控远端，真实 CI 作为 main 合并门禁 | 只能有本地证据，不能完成交付验收 |
| dining-only 的私密约束主体权限 | 无登录主体时只有 owner 看 `subject_and_owner`，普通成员只看安全投影 | 若另有监护人/代理读取需求，需要新授权模型，不能靠名称推断 |

## 17. 实施前评审检查点

项目总控批准实施前，应明确回复：

1. v1 原位纠正或 `/api/v2`；
2. 是否批准受控 membership transition 函数；
3. hard constraint rule code 与 cooking technique code 的最小词表/归属；
4. dependency critical/high 采用阻断还是具体到期的短期接受；
5. 实际数据环境清单及敏感幂等记录清理授权；
6. 远端仓库、目标 PR 和必需检查。

在这些决策完成前，本计划可以接受文档评审，但不开始业务实现。计划提交后本任务停止，等待项目总控“实施前评审”。
