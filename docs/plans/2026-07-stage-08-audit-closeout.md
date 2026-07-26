# 阶段 08：审计整改与架构收口实施记录

- 日期：2026-07-25
- 分支：`codex/stage-08-audit-closeout`
- worktree：`/Users/aipuli/.codex/worktrees/39f9/meal-agent-lab`
- 审核基线：`main@6e4fc11607d34f4c30f8bfccf449bf5dfbbddabd`
- 基线差异：无；本地 main 未前进
- 最终收口基线：`c68217ed5771252f54cb62e8b8e37d5f67d57269`
- 本轮增量整改基线：`17f50ddb0efd5acc01b94f41d121b0532558810b`
- 合并前复审整改基线：`85cc5b664254ceeb3d49be8b4ed4460b2f8b266c`
- 远端状态：未配置 remote/upstream，没有远端 CI 证据
- 状态：**Implemented — 最终整改本地验收完成，等待项目总控合并前评审；未合并 main**

## 1. 最终决策与边界

技术负责人已确认仓库不存在已部署生产/测试消费者，允许在 `/api/v1` 进行预发布原地纠正并将 contracts 升级为 `0.4.0`。该窄例外记录在 [ADR-0004](../architecture/decisions/0004-stage-08-pre-release-audit-closeout.md)。若发现真实环境或外部消费者，必须停止，不能继续沿用本方案。

本次只延续模块化单体、PostgreSQL/Drizzle、共享 contracts 和 Taro/React，不拆微服务、不换数据库/客户端框架、不复制 DTO、不引入向量数据库。安全规则由确定性代码、数据库和测试保证，不交给模型。菜单推荐、菜谱、采购、完整做饭与 Agent 均未扩大进入阶段 08。

## 2. 审计追踪矩阵

| ID | 审计问题 | 已实施整改 | 证据/关闭条件 | 状态 |
| --- | --- | --- | --- | --- |
| P1-01 | PersonProfile 私密字段进入 30 天幂等缓存 | 集中注册 `full` / `one-time-secret` / `receipt`；profile/constraint 首次和重放只返回 receipt；`0002` 转换历史记录 | registry 穷尽测试；DB sentinel；历史 receipt/tombstone 保留 command key | Closed |
| P1-02 | 普通成员可能直接更新本人 role | 撤销 `memberships UPDATE`、删除宽 policy、使用受控 transition 函数、收紧 schema/function 权限 | 应用角色直接更新 role 被拒；owner/self 正向与 PUBLIC 边界测试 | Closed |
| P1-03 | dining-only profile 创建后不可读 | 新增独立 profile list/get，统一 linked 与 dining-only | owner/member redaction、list/get、HTTP/E2E | Closed |
| P1-04 | archive 后无 restore，形成死路 | active/archived/all + 同 ID restore；不复制身份 | archive→GET archived→restore 同 ID/version 前进 | Closed |
| P1-05 | exact 正数 runtime/OpenAPI 不一致 | initial/consume 正数；event delta 非零；lot current quantity 可为零；逐 schema rule binding 和 parity | runtime/generated/OpenAPI/HTTP case matrix | Closed |
| P1-06 | 客户端 hard kind 和 profile 字段不完整 | 全部 hard kind、标识符输入、饭量/参与/厨艺 unknown 与编辑、dining-only 管理；未经权威映射一律阻断 | core + 实际页面渲染 + E2E；FAM-004 映射闭环仍 Partial | Partial |
| P1-07 | 模拟器修复后无完整复跑/入口门禁 | 渲染真实页面；开发者工具 happy path；GUI 中发现默认值 bug 后修复再跑 | [GUI 证据](../evidence/stage-08-gui/README.md) | Closed |
| P2-01 | 双邀请码并发加入可能 500 | household+user advisory transaction lock；已成员稳定业务结果 | DB 并发测试无 500、计数正确 | Closed |
| P2-02 | 日志未识别 inviteCode | camel/snake/case/nested 键统一脱敏 | 单元与日志 sentinel | Closed |
| P2-03 | 过期邀请仍显示 active | migration 物化既有过期邀请；读取统一 effective status | mapper/DB/HTTP 反例 | Closed |
| P2-04 | 同动作重试换 idempotency key | app 级协调器保存完整不可变 snapshot + 原 key；普通 GET 不释放未知命令，跨动作/离页被阻断 | Households/Inventory/Members/Profile 页面与 core 测试；进程重启恢复未冒充 Pass | Closed；重启恢复是内部发布阻断 |
| P2-05 | owner 视图 `isSelf=false` | 按 session user ID 判断 self | 多 owner/实际 MembersPage 测试与 GUI | Closed |
| P2-06 | audit 1 critical、1 high、8 moderate，无门禁 | 精确 advisory/path/version allowlist + 到期日 + weapp 产物扫描 | 新增、变化、消失未清理、过期或受禁 target 均失败 | Time-boxed |
| P2-07 | 文档、路由和测试数量漂移 | 同步 README、状态、架构、API/client、ADR、两份阶段 08 记录 | Markdown link gate；OpenAPI 生成 route count | Closed |
| P2-08 | 无 remote/upstream/远端 CI | 本轮不伪造；记录为合并 main 后、阶段 09 前门禁 | 未来受控 remote 与真实 CI URL/ID | Deferred |

二次整改关闭项：

| ID | 整改 | 关键证据 | 状态 |
| --- | --- | --- | --- |
| S2-01 | 自退出完成 UPDATE 必须命中一行；丢响应后先于 bootstrap 重放 | 真实 PostgreSQL 同 key 丢响应重试，无 incomplete record | Closed |
| S2-02 | 撤销 PersonProfile 表级 UPDATE，收紧 linked/dining-only 和初始状态 RLS | app-role 直接 SQL 反向测试 | Closed |
| S2-03 | redeem/transition/confirm 删除调用方时间与 capabilities，拒绝 NULL version | 新旧签名、GRANT/REVOKE、安全默认值测试 | Closed |
| S2-04 | linked create 与 confirm 共用成员不变量锁和锁顺序 | 两路径并发只能成功 + 409 | Closed |
| S2-05 | link request 过期/退出/归档/已有档案物化终态并允许过期重建 | duplicate、expiry rebuild、exit、archive 数据库测试 | Closed |
| S2-06 | 未经权威映射的五类 hard constraint 全部阻断 | migration/runtime/contracts/client 五类矩阵 | Closed；FAM-004 仍 Partial |
| S2-07 | 安全关联披露、退出后果、不可恢复原因、草稿隔离和输入冻结 | 实际 ProfilePage/MembersPage 交互测试 | Closed |
| S2-08 | rule ID 统一并建立逐 schema binding | contracts/OpenAPI binding 与行为门禁 | Closed |
| S2-09 | 可移植 Markdown、subprocess/audit 分类和库存/React 文档统一 | 本地 gate 与文档检查 | Closed |
| S2-10 | GUI 证据裁剪/遮盖、清元数据、重算 hash 并绑定实现树/构建摘要 | [GUI 证据](../evidence/stage-08-gui/README.md) | Closed |

最终收口关闭项：

| ID | 整改 | 关键证据 | 状态 |
| --- | --- | --- | --- |
| S3-01 | link 409 终态使用 tagged outcome，事务提交后再映射 HTTP | 每条 409 后查询 raw status/terminal_reason；安全失败回执完成落库并可同 key 重放 | Closed |
| S3-02 | 新请求物化同 profile 全部旧 pending；self-create 终态化 target 其他 pending | T1→T2、self-create、create/confirm 并发成功 + 409 | Closed |
| S3-03 | 保存 version + 安全披露快照并阻断 TOCTOU | owner 改名/新增私密约束后 confirm 409，raw `profile_changed` 已提交；API/page 回归 | Closed |
| S3-04 | Households/Join/Inventory/Profile 统一结果未知幂等状态机 | 请求中编辑、transport 后重试、409 刷新版本页面测试 | Closed |
| S3-05 | constraint JSONB 在 UPDATE 前完整校验 | app-role 畸形数组/notes 反向测试，内容/version 不变 | Closed |
| S3-06 | label-only allergy 与隐藏字段清理、五类阻断确认 | contracts/client 五类矩阵与实际页面确认展示 | Closed；FAM-004 仍 Partial |
| S3-07 | schema 定义处 metadata binding，OpenAPI 对应节点携带 rule ID | 无直接 refine 扫描、故意错绑失败、逐 component 检查 | Closed |
| S3-08 | production audit policy/退出语义 fail-closed | invalid expiry、signal、exit 2、registry、metadata、新增/消失 advisory，以及官方 registry JSON/gzip transport 正反例 9/9 | Closed |

0004 未部署前的增量整改关闭项：

| ID | 整改 | 关键证据 | 状态 |
| --- | --- | --- | --- |
| S4-01 | 先删除旧 terminal reason CHECK，再转换 0003 pending，最后建立新约束 | 仅迁移到 0003、插入 pending、再升级 0004 的真实 PostgreSQL 增量测试 | Closed |
| S4-02 | 替换 membership/profile transition，统一 household link advisory 和 request/profile/membership 行锁总序 | confirm/list/create 与 remove/archive 并发无死锁、无 500 | Closed |
| S4-03 | 撤销 link request 直接 INSERT，以受控函数锁内计算 disclosure 并重验 target active | 伪造披露 SQL 被拒、inactive target create/confirm 反向测试 | Closed |
| S4-04 | constraint ID 在任何 UPDATE 前严格校验小写 UUIDv7 | v4/nil 返回 `invalid_constraint`，profile/version 不变 | Closed |
| S4-05 | 生成合法 OpenAPI 3.0.3 而非类型强转 | 标准 validator + const/exclusive/null 方言反向扫描 + 生成产物深比较 | Closed |
| S4-06 | food concept/allergen 数组统一 max 100、去重与小写 UUID 语义 | runtime/OpenAPI/DB/HTTP 矩阵；非法 HTTP 为 400 | Closed |
| S4-07 | Inventory 重试执行保存的完整 snapshot | 刷新、切批次和原 key 重试页面测试证明未采用新 lot/version | Closed |
| S4-08 | Profile pending 仅允许原动作重试；普通 GET 不得开放完成/放弃 | 实际 ProfilePage 输入冻结、GET 观察与多写入口反向测试 | Closed；原 GET 放弃方案已撤销 |
| S4-09 | link 409 遵循“旧请求终态、owner 重新发起”真实生命周期 | 页面测试不注入虚构新请求 | Closed |
| S4-10 | 历史 link disclosure 明确 `legacy_unavailable` | 增量 migration、contract 与 repository 映射测试 | Closed |
| S4-11 | Drizzle、rule side effects、ADR/计划/状态同步 | schema/checksum、contracts build、Markdown link gate | Closed |

合并前复审关闭项：

| ID | 整改 | 关键证据 | 状态 |
| --- | --- | --- | --- |
| S5-01 | `toOpenApi30` 只转换 numeric exclusive bound、保留 boolean 且二次转换幂等 | boolean/numeric/idempotence 反向测试；approximate amount、tokenVersion、resultingLotVersion zero runtime ↔ OpenAPI parity | Closed |
| S5-02 | 持久化公共字符串统一 PostgreSQL-safe primitive | profile/constraint/household/inventory 的 U+0000 拒绝与 emoji code-point 边界；HTTP 400 不触达 handler | Closed |
| S5-03 | link confirm 在 household advisory 后重取时钟并在 accepted 前重验 expiry | 两个真实 session 的 barrier 跨越 expires_at，只能提交 raw `expired` + HTTP 409 | Closed |
| S5-04 | membership DELETE 与 link 409 在 bootstrap 前只读同 key 完成记录 | foreign DELETE 404；自退出与 inactive target 同 key 重放原结果 | Closed |
| S5-05 | 安全 409 migration/Drizzle CHECK 封闭 SQL UNKNOWN | object + `ok=false` + `error.code=CONFLICT`；`{}`、JSON null、缺字段均 23514 | Closed |
| S5-06 | Households create/join、Inventory、Members、Profile 统一 app 级 pending coordinator | GET 失败不开放 abandon、GET→retry→unknown 清观察、下一动作不继承、跨动作/离页与邀请丢响应页面测试 | Closed；重启恢复是内部发布阻断 |

合并前根因整改关闭项：

| ID | 整改 | 关键证据 | 状态 |
| --- | --- | --- | --- |
| S6-01 | pending envelope 绑定 principal/household/owner route/auth generation；401 suspend | 同用户重登复用原 snapshot/key；换用户不可读/不可执行；主动登出 service fail-closed | Closed |
| S6-02 | 集中 typed command registry、retry dispatcher、订阅与全局恢复入口 | GET/资源消失/页面卸载/宿主 Back 后从原 snapshot 重试；导航显式 allowed/denied 后才改家庭上下文 | Closed；重启恢复是内部发布阻断 |
| S6-03 | repository 统一 link 生命周期锁总序 | 同一 principal 两个真实 session + DB barrier 覆盖 self-exit vs confirm、linked self-create vs confirm，无 `40P01`/500 | Closed |
| S6-04 | PostgreSQL-safe primitive 拒绝孤立 surrogate 且允许合法 emoji | contracts/raw JSON HTTP/OpenAPI 验证 80/81 字段长度；JSONB 独立验证编码层接受合法 emoji、拒绝孤立 surrogate | Closed |
| S6-05 | Members 4xx disposition 与真实页面交互断言 | 403 释放旧 action；按钮存在且两次点击均使请求数增加，新动作使用新 key | Closed |

最终合并前复审关闭项：

| ID | 整改 | 关键证据 | 状态 |
| --- | --- | --- | --- |
| S7-01 | pending 结算改为不可变 commandId CAS | 同用户新 key 的旧 HTTP 延迟成功、跨用户的旧 HTTP 延迟失败均不能清除或污染新 envelope | Closed |
| S7-02 | retry 仅允许原子 unknown → in-flight | 两次并发 `retryActive` 只有一次 HTTP，第二次返回 in-flight | Closed |
| S7-03 | 全局恢复执行 typed 业务 reconciliation | 真实组件覆盖 invite 明文/无明文引导、self-exit、household create/join、确定失败/未知/认证暂停及页面解锁 | Closed |
| S7-04 | PostgreSQL-safe pattern 跨正则执行器一致 | 无 flag、u flag、Ajv 8 默认配置遍历全部 surrogate；合法 supplementary 与 80/81 emoji parity | Closed |
| S7-05 | schema rule 扩展名与范围一致 | `x-meal-agent-contract-rule-ids` 承载全部节点绑定，classification 区分 native/runtime-only | Closed |

## 3. A — 幂等与敏感数据

### 集中式策略

`ApiRepository` 的规范化路由类型和单一策略注册表形成穷尽边界：

- `full`：家庭、库存、邀请撤销、加入、成员退出/移除及不含敏感字段的关联命令；
- `one-time-secret`：创建邀请；首次可带 `inviteCode`，缓存与重放只保留 invite 安全投影；
- `receipt`：PersonProfile 创建/更新/archive/restore 与 constraint 增删；首次和重放都只返回 `householdId`、`profileId`、operation、status、resultingVersion 和可选 constraintId。

登录/session token 不进入通用 response cache。endpoint 不能再提供临时 `redactStoredData`；新增规范化 route 若没有登记会在类型/测试边界失败。当前没有必要增加 `response_policy` 或 `representation_version` 列。

### 首次、重放与历史数据

`full` 的领域 data 相同；`one-time-secret` 明确允许首次有秘密、重放无秘密；`receipt` 首次和重放完全使用安全回执。客户端处理 receipt 后 GET 最新授权表示。

`0002` 对旧 profile/constraint response：

1. 可识别 ID/status/version 的转换为 receipt；
2. 无法安全识别的转换为 `nonReplayable: true` tombstone；
3. 邀请响应只移除 `inviteCode`；
4. 不删除幂等 key、请求哈希或完成标识，不延长 expiry，也不导出原始敏感内容。

membership DELETE 和 link confirm 在 household bootstrap 前只做精确 user/household/method/route/key/hash 的完成记录查询：命中才重放，未命中必须继续当前授权。这样自退出和已提交安全 409 可在 membership 变 inactive 后重放，而从未属于目标家庭的用户不会先插入带 membership 外键的 marker，最终稳定得到 404。

## 4. B — 授权与 RLS

### 方案比较

| 方案 | 防护能力 | 决策 |
| --- | --- | --- |
| 列级 GRANT | 可阻止 role 列更新，但仍允许应用角色自由拼接状态迁移 | 不采用 |
| 受控数据库函数 | 窄参数、actor/target/最后 owner/并发均可在数据库再次验证 | **采用** |
| 现有 repository UPDATE + 整表权限 | repository 一旦写错即可提权 | 拒绝 |

`transition_membership_status` 只接受 target ID 和 expected version，actor/household 来自 transaction-local context，时间由函数内部 `clock_timestamp()` 取得；NULL version 明确拒绝。邀请赎回不接受调用方 capabilities，加入/重新加入固定安全默认值。它按家庭串行化，检查 owner/self、version 和最后 owner，并把成员状态变更与 linked profile 归档放在同一事务。

数据库门禁覆盖：

- 普通成员不能自行提权或改他人角色；
- 非 owner 不能移除他人；
- owner 合法移除与多 owner self 退出；
- 最后 owner 被阻断；
- 并发成员状态与双 invite join；
- 应用角色无 table UPDATE / schema CREATE；
- PUBLIC 无私有函数 EXECUTE，应用角色只拥有指定函数；
- 缺 user/household/membership context 与跨家庭路径被拒。

## 5. C — PersonProfile 资源模型

`/members` 保持登录成员目录职责；新增独立 profile list/get，避免把 dining-only profile 伪装成 membership。查询支持 `active`、`archived`、`all`：

- owner：得到家庭 profiles 完整视图；
- member：self 完整视图，others 为安全投影；
- get：owner/self 为完整 profile，其他 active household member 为安全投影。

archive 保留唯一索引占位和原 ID；restore 原行。linked member 离开时 profile 原子归档，不自动变为 dining-only。重新加入只恢复 membership，profile 仍需显式 restore，不复制约束。

dining-only → linked 使用两步明确命令：owner 发起 link request，目标 membership 对应用户确认。禁止按姓名自动合并。linked → dining-only 没有隐式路径，未来必须设计独立双确认命令。

数据兼容使用 additive `person_profile_link_requests` 表；既有 profile ID、唯一索引和约束保持。`defaultParticipation`、`defaultPortionScale`、`cookingSkill` 放宽为 nullable，migration 不推测旧值。

## 6. D — 契约单一事实源

根因是 Zod 的任意 `.refine()` 谓词无法自动还原为 JSON Schema。旧 exact amount 先允许非负 fixed decimal，再用 runtime refine 拒绝数学零，生成器只能看到允许零的 base pattern。

整改后：

- 可表达的正数与零值规则直接生成原生 JSON Schema；
- 所有公共 refine/superRefine 进入稳定 rule manifest，并逐 schema 绑定；
- 每个 schema 节点生成 `x-meal-agent-contract-rule-ids`，承载该节点全部绑定规则；根 manifest classification 区分 native 与 runtime-only，只有 runtime-only 需要消费者额外执行；
- 生成器校验源码扫描、manifest 覆盖、ID 唯一性和 native/runtime-only 分类；
- OpenAPI 只由脚本生成，不手工编辑 JSON。

当前 manifest 覆盖 33 条 refine/superRefine 和 2 条原生 schema 规则。rule ID 与 boundary 在 schema 定义处写入 metadata，binding 和 OpenAPI schema component 从该 metadata 派生；contracts 包显式保留注册模块的 side effects，不存在平行手写 boundary map。`toOpenApi30` 只转换 numeric exclusive bound、保留既有 boolean 形式，二次转换必须与一次完全相同。等价性矩阵至少覆盖：

| 边界 | `"0"` | 正数 | 负数/指数/超精度 |
| --- | --- | --- | --- |
| create inventory `initialQuantity.amount` | reject | accept | reject |
| consumed `quantity.amount` | reject | accept | reject |
| inventory event delta `quantity.amount` | reject | accept | 超范围/指数 reject；合法负数 accept |
| inventory lot `currentQuantity.amount` | accept | accept | 依 contract reject |

runtime、生成 schema、OpenAPI 与关键 HTTP 请求共同验证，不把扩展元数据存在等同为 runtime 行为通过。

另有三个显式 zero 语义反例：approximate amount、session tokenVersion 与 inventory event resultingLotVersion 在 runtime 和 OpenAPI 中都拒绝 0。所有会持久化到 PostgreSQL text/varchar/jsonb 的公共字符串使用共享 primitive，在 HTTP 前拒绝 U+0000 与全部孤立 high/low surrogate。pair-first pattern 在无 flag、`u` flag 与 Ajv 8 默认配置下均接受合法 supplementary scalar；contract/OpenAPI 验证 80/81 emoji 长度。裸 PostgreSQL JSONB 测试只证明 Unicode 编码接受合法 emoji、拒绝孤立 surrogate，不证明字段长度。

## 7. E — 客户端范围

### 阶段 08 必须完成

- FAM-003：linked/dining-only profile list/get/edit/archive/restore；饭量、参与和厨艺 unknown/null；
- FAM-004 当前实现范围：全部 hard kinds、allergen/food concept 标识符、visibility、全字段指纹双确认和未映射阻断；权威映射与推荐闭环未完成；
- FAM-005 当前范围：cooking skill unknown/查看/编辑；
- MembersPage owner/self 正确；
- Households create/join、Inventory、Members、Profile 的全部写操作使用集中 typed command registry、retry dispatcher 和 app 级协调器；同动作 transport/5xx/malformed 重试复用 key，进行中 payload/version 不得变化，相关输入冻结，其他写入与带上下文变更的离页被阻断；
- envelope 绑定 principal、household、owner route、认证 generation 与不可变 commandId；401 进入 `auth-suspended`，同用户重登恢复，换用户不可读/不可执行。结算使用 commandId CAS，旧 attempt 不能影响同 action 新 envelope；
- retry 只允许 coordinator 原子执行 `unknown → in-flight`；typed reconciliation 处理 household create/join、self-exit、invite 一次性明文/无明文引导和可见结果状态。coordinator 订阅驱动全局入口及页面解锁；
- 程序化导航显式返回 `allowed`/`denied`，`currentHousehold` 只在导航获准后写入；主动登出由 service/coordinator fail-closed；
- 普通 GET 只能记录绑定 action/key 的 observation，不能证明命令执行与否；GET 失败不产生证据，retry、新动作、成功或确定失败清除旧 observation；
- 不持久化邀请码、私密约束或其他敏感请求体。应用进程重启后的命令恢复当前不支持；未来需要非敏感 locator + 服务端 command-status/receipt 或原子 fence，普通 GET 不得代替。该项是内部后续范围并阻断发布，不是外部依赖。

### 明确后续

正式 cooking-technique、allergen、food concept、宗教、伦理和食品安全规则词表不在本阶段发明。FAM-004 与 FAM-005 均仍为部分完成。未来推荐边界遇到 `needs_structured_mapping` 必须阻断，不能调用模型解释自然语言标签。

页面测试实际渲染 HouseholdsPage、MembersPage 和 ProfilePage，并通过 Taro stub 验证用户入口、按钮和显示状态；core/API 测试不再冒充页面测试。

## 8. F — 验收与交付

`pnpm stage08:check` 串联：

1. Node/PostgreSQL environment；
2. `0000→0001→0002→0003→0004` 空库与增量 migration/checksum；
3. contracts typecheck/tests/build；
4. API unit/HTTP/PostgreSQL/OpenAPI/build；
5. client typecheck/unit/page rendering/weapp build；
6. stage 07 + stage 08 双用户 E2E；
7. 精确依赖例外和 weapp 产物扫描；
8. Markdown 本地链接。

本次准确结果：

| 门禁 | 结果 |
| --- | --- |
| contracts | 28/28 |
| API unit | 12/12 |
| API HTTP | 6/6 |
| PostgreSQL/RLS/concurrency | 50/50 |
| client unit/page | 124/124 |
| E2E | 21/21 |
| audit gate 与 transport 反向单测 | 9/9 |
| OpenAPI | 19 paths / 25 operations |
| weapp build | Pass |
| GUI | `c68217ed` 页面视觉范围 Pass；0004 增量由页面/API/DB 自动化验证，未伪造新 GUI Pass |
| links / diff check | Pass |

### 依赖 audit 决策

经 npm 官方 HTTPS bulk endpoint 取得、由 `pnpm audit --prod --json` 生成路径的有效报告为 1 critical、1 high、8 moderate。精确路径都属于 Taro 传递链。机器可读例外位于 [`security/audit-exceptions.json`](../../security/audit-exceptions.json)，截至 2026-08-08T23:59:59+08:00，只允许 `local-weapp`：

- loopback transport normalizer 只兼容直接 JSON 或通过 gzip magic/CRC 校验的 JSON；损坏压缩、非 JSON、非 200、超限、registry/network 错误和缺 metadata 均失败；
- 精确匹配 advisory ID、module、severity、version、path count 和 path-set hash；
- 扫描构建产物禁止已知 vulnerable dependency signature；
- 新增/变更 advisory、旧项消失但例外未清理、到期、缺产物或目标为 H5/external-test/experience/release 都失败；
- 证据只记录数量、hash 和产物统计，不记录密钥或用户数据。

该决定不是漏洞已修复。到期前必须升级/替换依赖或重新进行有证据的风险评审；例外期间禁止 H5、外部测试、体验版和发布。

### GUI

微信开发者工具 RC `2.02.2607171` 的二次复跑绑定前一轮已提交页面实现子树，覆盖 fake 登录、合成家庭、owner/self、五类 hard constraint 入口、未经权威映射的阻断态、archive 和同 ID restore。证据裁剪为模拟器区域、移除相机/GPS/创建时间元数据，并绑定实现 tree、构建摘要和 SHA-256。本轮新增的结果未知状态机与 link TOCTOU 由实际页面、API 和 PostgreSQL 自动化验证，没有伪造新的 GUI Pass；环境与非范围见 [GUI 证据](../evidence/stage-08-gui/README.md)。

## 9. 影响范围

| 层 | 已修改 |
| --- | --- |
| contracts | 0.4.0；receipt、profile collection/lifecycle/link、nullable facts、hard mapping 阻断、逐 schema rule binding、decimal parity |
| migration | 单事务 `0002` + `0003` + `0004`；link 披露/终态、nullable facts、受控函数、严格 JSONB/UUIDv7 边界、旧数据转换、PersonProfile/成员/link request 权限撤销 |
| API | 幂等 registry、profile routes/redaction、member/invite 并发和状态、日志脱敏、OpenAPI |
| client | endpoint/flow/page、同动作 key、完整 hard kind、unknown facts、archive/restore、page tests |
| tests | contracts、runtime/OpenAPI、DB/RLS/concurrency、HTTP、页面、双用户 E2E |
| docs/ADR | 根/docs/status/system/API/client、ADR-0003 注记、ADR-0004、原阶段 08 与本记录、GUI/audit evidence |
| gates | production audit、Markdown link、stage08 aggregate |

没有修改 `0000`/`0001`、没有添加真实密钥/用户/健康数据、没有实现阶段 09 业务。

## 10. 数据兼容与回滚

迁移顺序固定为：

```text
0000_stage_06
  → 0001_stage_08
  → 0002_stage_08_audit_closeout
  → 0003_stage_08_secondary_closeout
  → 0004_stage_08_final_closeout
```

`0002`、`0003` 与 `0004` 都是单一事务。`0003` 严格按“新增终态/函数与约束 → 转换历史 hard mapping → 撤销表级权限和旧函数签名”执行；`0004` 按“新增 nullable 披露列 → 删除不认识新终态的旧 CHECK → 把旧 pending 终态化并标记 `legacy_unavailable` → 建立新 CHECK → 替换 lifecycle/constraint 函数与权限”执行。空库路径和“仅应用到 0003、存在 pending、再升级 0004”的增量路径都在临时 PostgreSQL 中验证。失败时整笔回滚；成功后只允许 roll-forward：

- 不恢复含私密 profile 的幂等响应；
- 不删除命令标识，也不允许同 key 重新执行；
- 不恢复应用角色的 memberships UPDATE；
- 不恢复应用角色的 person_profiles UPDATE 或调用方时间/capabilities 参数；
- 不恢复 PUBLIC schema CREATE/function EXECUTE；
- 不把 unknown 迁移为猜测值；
- 不自动为 label-only hard constraint 生成宗教/伦理规则。

因为没有已部署消费者，不维护虚构的 expand/contract 双版本。若部署事实改变，停止并重新决策，不自行套用本节。

## 11. 分批提交计划

实现按以下逻辑批次提交，所有提交只进入当前分支：

1. contracts/OpenAPI 规则和 `0.4.0`；
2. API、单事务 migration、RLS/并发/HTTP 测试；
3. 客户端页面、动作幂等和真实页面测试；
4. audit gate、ADR、状态文档与 GUI/audit 证据。

不得合并 main；提交后等待项目总控合并前评审。

## 12. 完整验收命令

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

pnpm audit --prod
pnpm audit:prod:check
pnpm docs:links:check
pnpm stage08:check

git diff --check
git status --short
```

原始 audit 非零是已知事实；`audit:prod:check` 才执行精确、限时的本地例外决策。两者都必须报告。

## 13. Deferred 与内部发布阻断

### Deferred — 外部依赖

以下没有 Pass 证据：

- 真实 AppID/AppSecret、真实 `wx.login`/code2Session、合法 HTTPS 域名；
- 真机、真实多设备会话、微信分享、体验版、审核、发布和 CI 上传；
- 云 API、托管数据库、正式 Secret 管理、WAF、备份恢复和可观测平台；
- Android、iOS、HarmonyOS 构建、签名、实机和发布；
- H5 和外部测试（依赖例外期间明确阻断）；
- 菜单推荐、菜谱、采购、完整做饭、Agent、报餐/投票；
- cooking-technique 与宗教/伦理/食品安全正式规则词表；
- linked profile 转 dining-only 的独立双确认命令。

### 内部后续范围 / 发布阻断

- 应用进程重启后的未知命令恢复协议（非敏感 locator + 服务端 command-status/receipt 或原子 fence）尚未实现；普通 GET 不能代替。该项在发布前必须关闭或形成新的、明确的产品范围决策，不能归因于外部环境。

远端 Git/CI 不阻断本轮本地实现。项目总控合并阶段 08 到 main 后、阶段 09 开发前必须配置受控 remote/upstream 和真实 CI；当前不得伪造远端 Pass。

## 14. 仍需总控处理

1. 审阅本分支实现与本地证据，决定是否合并 main；
2. 在 2026-08-08 前关闭或重新评审 Taro advisory 例外；
3. 合并后、阶段 09 前配置远端仓库与真实 CI；
4. 为阶段 09 指定 cooking-technique 及宗教/伦理/食品安全规则词表的数据治理责任人；
5. 外部环境出现前保持真实微信、域名、真机、云和发布为 Deferred。
