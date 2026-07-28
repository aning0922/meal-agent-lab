# 项目状态

最后更新：2026-07-28

## 当前结论

阶段 08 最终审计整改已完成本地实现与标准门禁，并于 2026-07-26 由项目总控以 fast-forward 合并至 `main`（实现落点 `df8107c`）。阶段 08 已收口。[阶段 09A](plans/2026-07-stage-09a-local-deployability-baseline.md)**实施中**：先建立 Docker Compose 本地可部署性、数据库账号隔离、迁移、健康检查与备份恢复基线，不购买服务器、不接真实微信配置、不开放公网。M1 已 Accepted；M2A 的 **R8A 只读 projector** 已由项目总控 Accepted（验收落点 `ca65275`）；**R8B 已由项目总控 Accepted**；**M2A 整体已 Accepted**，验收落点 `5e480803`；**M2B（Compose 拓扑）In Progress**，M3—M5 未开始。详见本文末的阶段 09A 小节。整改遵循 [ADR-0004](architecture/decisions/0004-stage-08-pre-release-audit-closeout.md) 的预发布窄例外：仓库没有已部署生产/测试消费者，因此 contracts 保持 `0.4.0` 并在 `/api/v1` 原地修正；若发现真实环境或外部消费者，该例外立即失效。

当前仍采用 Node.js 24 + Fastify 5 模块化单体、PostgreSQL 18 + Drizzle/`pg`、共享 Zod contracts 和 Taro/React，不拆微服务、不换数据库/客户端框架、不引入向量数据库。

## 阶段 08 整改结果

### 幂等与隐私

- 所有通用幂等写 route 由规范化路由注册表穷尽选择 `full`、`one-time-secret` 或 `receipt`，endpoint 不再传临时 redact 回调。
- PersonProfile 与 constraint 写操作首次和重放都只返回 receipt；完整资源只能通过授权 GET 获取。邀请码只在首次响应出现，缓存和重放使用安全投影。
- `0002_stage_08_audit_closeout.sql` 把历史敏感 profile 响应转为 receipt 或 `nonReplayable` tombstone；`0003_stage_08_secondary_closeout.sql` 保留并加固相同完成标识，成员自退出在 active membership 消失后仍可先于 bootstrap 重放，最终写入必须命中一行。
- `0004_stage_08_final_closeout.sql` 不回改 0000—0003：它先删除不认识新终态的旧 CHECK，再把历史 pending 终态化为明确的 `legacy_unavailable`，最后建立新约束；同时增加提交后映射 409 的事务语义、统一 household 关联锁、锁后 expiry 重验、严格安全 409 JSON CHECK 和完整 constraint JSONB/UUIDv7 数据库校验。
- `inviteCode` 的 camelCase、snake_case、大小写与嵌套日志键都进入脱敏边界。

### 数据库权限与并发

- `meal_agent_app` 不再拥有 `memberships UPDATE` 或 `person_profiles UPDATE`；档案身份字段不能由应用角色直接更改，初始 status/version/constraints 和 linked/dining-only 创建者均受 RLS 约束。
- 成员退出/移除、邀请赎回、profile 字段/状态/约束、link request 创建和关联确认通过窄参数 `SECURITY DEFINER` 函数执行，固定 `search_path`、完整限定对象、内部时钟、安全默认 capabilities、NULL version 拒绝并撤销 PUBLIC EXECUTE。应用角色不能直接 INSERT link request 或伪造 disclosure。
- HTTP capability 与跨家庭 404 仍是第一层授权，数据库函数和 FORCE RLS 是 defense-in-depth。
- 两个不同邀请码并发加入同一家庭按 household+user 串行化：一个成功，另一个稳定返回 already-member，不泄漏唯一约束为 500。

### PersonProfile 与成员

- 独立 profile list/get 覆盖 linked 与 dining-only profile，并支持 `active`、`archived`、`all`。
- archive 与 restore 始终复用原 profile ID；退出或移除成员时原子归档 linked profile，重新加入不自动恢复，也不复制私人约束。
- dining-only profile 关联成员由 owner 调用受控函数创建请求，数据库在锁内计算披露；目标用户确认时再次验证 membership active。不按姓名合并。直接创建 linked profile 只能由其本人执行，并与 create/list/confirm、remove/archive/restore 共享 household link advisory 和行锁总序；并发无死锁、无 500。
- pending link request 在同一 household 锁内把过期、目标成员退出、档案归档、profile 变化和目标已有档案物化为终态，过期后可对不同目标重新发起；HTTP 409 只在事务提交终态后映射。
- link 409 的安全失败回执也在同一事务完成幂等记录并断言命中一行；同 key 重放同一失败，不删除完成 marker 或重新执行。
- membership DELETE 和 link confirm 在 household bootstrap 前只查询同 key 已完成记录：自退出或 target inactive 后仍可重放，未命中的 foreign DELETE 继续授权并返回 404，不再因提前插入 marker 的 membership 外键变成 500。
- link confirm 在 household advisory 等待后重新取得 `clock_timestamp()`，materialize 与 accepted 写入前都在锁内重验 `expires_at`，`confirmed_at` 使用锁后时间；两个真实数据库 session 的 barrier 测试证明等待期间跨过 expiry 只能提交 `expired`。
- repository 把 replay/bootstrap、household link advisory、idempotency marker 和 domain row locks 固化为单一总序；remove、linked self-create、create-link、confirm、archive/restore 共用同一 advisory helper。同一 principal 的两个真实 session 与数据库 barrier 覆盖 self-exit vs confirm、linked self-create vs confirm，均无 `40P01` 或 HTTP 500。
- link request 固化发起时的 profile version、名称、家庭可见 hard/soft 数量和私密约束数量；确认不披露私密内容，披露后 profile 任一版本变化均要求重新 GET、展示和确认。历史请求没有快照证据时只返回 `legacy_unavailable`，不会用迁移时当前数据冒充。
- owner/self 能读取完整字段；其他家庭成员只读安全投影，结构上排除 `subject_and_owner`。
- owner 行的 `isSelf` 已按实际登录用户计算并有页面级回归。

### 未知事实与硬约束

- `defaultParticipation`、`defaultPortionScale`、`cookingSkill` 均支持 `null`；新家庭和新档案不再猜测“参与/不参与”、饭量或厨艺，旧数据也不做推测性迁移。
- 客户端支持 allergy、religious、ethical、explicit avoid 和 food safety exclusion；在没有权威词表时，label-only allergy 也能诚实登记，不要求用户编造内部 code。
- 当前没有权威映射词表；字符串或 UUID 形状校验不构成 structured mapping。迁移、运行时、契约和客户端统一把全部 hard constraint 标为 `needs_structured_mapping`，后续推荐必须阻断。
- hard confirmation fingerprint 包含全部字段和 visibility，任一字段变化都会使旧确认失效。
- `foodConceptIds` 和 `allergenCodes` 的公共/数据库边界统一为最多 100 项且不得重复；food concept ID 只接受小写 UUIDv7。非法 HTTP 输入为 400，nil/v4 或畸形 app-role 输入不会改变 profile/version。
- FAM-003 已完成。FAM-004 的登记、双确认、隐私和五类页面能力已实现，但在权威映射与推荐安全闭环完成前仍为部分完成。FAM-005 当前只完成厨艺等级与未知值的查看/编辑，仍为部分完成。

### 契约与 OpenAPI

- `@meal-agent/contracts` 为 `0.4.0`，客户端、API、测试和 OpenAPI 共用同一事实源。
- 会进入 PostgreSQL `text`/`varchar`/`jsonb` 的公共字符串使用共享 PostgreSQL-safe primitive：HTTP contract 层拒绝 U+0000 和全部孤立 high/low surrogate；pair-first pattern 在无 flag、`u` flag 与 Ajv 8 默认配置下都接受合法 supplementary scalar，并由 contract/OpenAPI 验证 80/81 emoji 长度。PostgreSQL JSONB 回归只证明编码层接受合法 emoji、拒绝孤立 surrogate，不冒充字段长度证据。
- 当前公共边界的 33 条 refine/superRefine 与 2 条原生 schema 规则在 schema 定义处通过统一 helper 绑定；节点的 `x-meal-agent-contract-rule-ids` 承载全部绑定 ID，根 manifest classification 区分 native/runtime-only。binding 及 OpenAPI component 从实际 Zod metadata 派生，contracts 构建显式保留注册模块的 side effects，故意错绑会使门禁失败。
- 创建库存 initial amount、消耗 amount 必须为正数；inventory event delta 必须非零，lot `currentQuantity` 可以为零。运行时、生成 schema、OpenAPI 和关键 HTTP 行为有一致性测试。
- 生成产物为 [`services/api/openapi/stage-08.openapi.json`](../services/api/openapi/stage-08.openapi.json)，覆盖 19 个 path、25 个 method operation；生成器只转换 numeric exclusive bound、保留 boolean 形式且二次转换幂等。标准 validator、关键字扫描以及 approximate amount、tokenVersion、resultingLotVersion 三个 zero 语义测试共同禁止 `const`、数值型 exclusive bound、`type: null` 和 runtime/OpenAPI 漂移；禁止手工维护第二份 OpenAPI。

### 客户端与 GUI

- MembersPage、ProfilePage 和 HouseholdsPage 均有真实 React 页面渲染测试，不以 core/API 调用冒充页面测试。
- Households create/join、Inventory、Members 与 Profile 的全部写操作使用集中 typed command registry、retry dispatcher 和 app 级 pending-command coordinator。同一次动作保留完整不可变 command snapshot、原 idempotency key 与 `commandId`；结算执行 commandId CAS，跨用户或同用户新 key 后延迟返回的旧 attempt 不能清除/污染新 envelope。retry 只允许原子 `unknown → in-flight`，并发点击不会发送第二个 HTTP 请求。
- envelope 绑定 principal、household、owner route 与认证 generation；401 只进入 `auth-suspended`，同一用户重新认证后恢复 envelope 的 household context 并从全局入口重试原 snapshot/key；若 household storage 恢复失败，只能进入不依赖家庭上下文的家庭选择/恢复页。不同用户会同时清除旧 envelope 和旧家庭上下文，不能读取或执行旧命令。主动登出在 service 层 fail-closed。
- 全局恢复在 CAS 成功后执行 typed reconciliation：家庭 create/join 设置上下文并导航，self-exit 清上下文并离开，一次性邀请码明文只在内存中展示，安全重放无明文时保留撤销重建引导；确定失败、仍未知和认证暂停都有可见状态。页面订阅 coordinator，pending 清除后重新渲染并解除禁用。
- 服务端命令 outcome 与本地 reconciliation 分开结算。成功或确定失败先释放 envelope/key；后续 storage、`reLaunch` 或 `navigateTo` 失败只显示“命令已完成，但本地页面切换失败”并提供不发写请求、绑定原 principal 的本地恢复入口，不会重新标记 unknown、宣称原 key 仍保留或让换账号会话继承旧家庭。
- 协调器只在当前应用进程内跨页面存活，不持久化邀请码或私密约束请求体。进程重启后的安全命令恢复尚未实现；未来必须使用非敏感 locator + 服务端 command-status/receipt 或原子 fence，普通 GET 不能替代。
- 关联确认显示安全档案名称、可见约束摘要、权限和归档/保留后果，不只显示 UUID；不可恢复档案禁用恢复按钮并解释原因，切换档案会清除档案级草稿。
- weapp 生产构建已通过。微信开发者工具 RC `2.02.2607171` 的二次复跑绑定前一轮已提交的页面实现子树，覆盖 fake 登录、合成家庭、owner/self、五类 hard constraint 入口、未经权威映射的阻断态和 archive/restore 同 ID；本轮新增的结果未知状态机与关联 TOCTOU 由实际页面渲染、API 和 PostgreSQL 测试验证，未伪造新的 GUI Pass。截图仅保留模拟器区域并清理敏感元数据，证据边界见 [GUI 记录](evidence/stage-08-gui/README.md)。

## 本地验收

项目标准 Codex runtime 直接执行 `pnpm stage08:check`，退出码为 `0`；没有临时注入 `rg` 或改写 PATH。当前门禁包含：

下表是 **2026-07-28 阶段 09A / M2A R8B 之后**的实际计数（阶段 08 收口时为
contracts 28、API unit 12、API HTTP 6、PostgreSQL 50；差额来自阶段 09A 的 M2A 各轮
新增测试，业务语义未变）：

| 层 | 通过数量/结果 |
| --- | --- |
| contracts | 28/28 |
| API unit | 49/49 |
| API HTTP | 7/7 |
| PostgreSQL migration/RLS/concurrency/身份边界 | 128/128 |
| client unit + page rendering | 129/129 |
| stage 07 + stage 08 双用户 E2E | 21/21 |
| audit gate 与 transport 反向单测 | 11/11 |
| generated adapter 只读门禁 | 4/4 逐字节一致 |
| OpenAPI | 19 paths / 25 operations，生成一致 |
| weapp | production build Pass |
| Markdown links | 56 files / 149 local links Pass |

标准 `pnpm audit` 报告的合法漏洞退出语义仍为退出码 `1`、1 critical、1 high、8 moderate。机器门禁使用 loopback transport normalizer 转发 npm 官方 HTTPS bulk endpoint，不自动跟随 redirect，任何 3xx 都失败；原始响应流和 gzip 解压流分别实施 16 MiB 上限。normalizer 只兼容直接 JSON 或通过 gzip magic/CRC 校验的 JSON，仍由 `pnpm audit` 生成实际依赖路径；损坏压缩、非 JSON、非 200、registry/network 错误和缺 metadata 均失败。门禁只接受 [`security/audit-exceptions.json`](../security/audit-exceptions.json) 中精确、截至 2026-08-08 的 local/weapp-only 例外，并扫描构建产物；任何新增、变化、过期或已消失但未清理的 advisory 均失败。证据见 [weapp advisory scan](evidence/stage-08-audit/weapp-advisory-scan.json)。例外期间 H5、外部测试、体验版和发布被阻断，不能把 gate Pass 表述为漏洞修复。

## 阶段 09A 计划与下一门禁

### 阶段 09A 当前状态（目标设计 vs 已实现事实）

**已实现的事实**

| 里程碑 | 状态 |
| --- | --- |
| M1 API 容器构建基线 | 总控 **Accepted** |
| M2A R8A（只读 canonical projector） | 总控 **Accepted**，验收落点 `ca65275` |
| M2A R8B（把 projector 接入 verify/converge） | 总控 **Accepted** |
| M2A 整体 | 总控 **Accepted**，验收落点 `5e480803` |
| M2B Compose 拓扑 | **In Progress** |
| M3 / M4 / M5 | **未开始** |

**R8A 实际交付的**（全部属于**可观察性**，不含任何收敛）

- **sequence default ACL 的真实缺陷已修复**：`pg_default_acl.defaclobjtype` 与
  `acldefault()` 是两套 objtype 编码，sequence 分别是 `S` 与 `s`，而
  `acldefault('S', …)` 是 FOREIGN SERVER。修复前 projector 把 sequence 的内建
  默认**低报**为只剩 `USAGE`（PostgreSQL 18.4 实测：真实新 sequence 的
  `SELECT`/`UPDATE`/`USAGE` 全为 true，修复前投影只给出 `USAGE`）。现在由显式
  映射表承载，六种 objtype 穷尽，未知 objtype 以 `default-unmapped` fail closed。
- **default ACL 的三条真实语义已固化为自动化 parity 测试**，每条都由**独立
  catalog 查询**与真实新建对象复现，不由 projector 自证：非空 global 行替换内建
  默认；空 global 行等价于没有行，但 `default-row` 仍能区分两者；global 非
  grantable `SELECT` 叠加 schema `WITH GRANT OPTION` 后恰好一行且 `grantable=t`。
- **canonical projector 的运行时性质已证明**：三列结构化读取（不再用 psql 的
  `|` 文本拼接）、每个 identity 都 JSON 往返且 Node 与 PostgreSQL 编码逐字节
  相同、两组不同 `search_path`/`quote_all_identifiers` 下结果逐行相同且调用方
  会话 GUC 不被修改、含 `#`/`@`/`|`/引号的合法名字不碰撞也不错位、两个合法
  `meal_agent_<suffix>` 库的 database identity 都是 `["database", "<current>"]`。
- **effective 分支反例已补齐**：无表级授权的列级 ACL、language 的
  implicit/raw/effective、Large Object 的直接与继承权限，以及外部 NOLOGIN 的
  边界（raw 直接 ACL 可见，但它不在 effective 探测集合内）。
- **language 的一处错误语义已更正**：`acldefault('l', …)` 对受信与非受信语言完全
  相同，非受信语言的限制在建函数时按 superuser 判定、不体现在 ACL 上。原先按
  `lanpltrusted` 过滤 raw 层会让 raw 说「没人有 USAGE」而 effective 说「所有人
  都有」，两层自相矛盾。

**R8B 实际交付的**（总控 **Accepted**，M2A 整体验收落点 `5e480803`）

- **结构**：`PostgreSQL catalog → 共享结构化 projector CTE → 公开只读 projection
  adapter / verify 的可移植策略匹配器 / converge 的可移植策略匹配器`。共享的是
  **事实采集**：期望值在 `authorization-manifest.ts`（版本 2），可移植策略在新增的
  `authorization-policy-sql.ts`，projector 一条期望值都没有。对外三列投影的行集与
  R8A **逐行相同**（四个状态下实测）。
- **删除的重复逻辑**：`watchedGrantees` 观察过滤、`currentAclCte` 的第二份 catalog
  枚举、`currentDefaultCte` 的整套 default privilege 缺陷，以及 verify/converge 各自
  维护的权限观察。
- **完整元组比较**：object + grantee + grantor + privilege + grantable。固定允许授权的
  canonical grantor 恒为 `meal_agent_migrator`，因此权限集合看起来合规但 grantor 错误、
  存在重复授权或可再授予，都会被发现并精确收敛。
- **default privilege**：`default_raw`（物理行）决定执行哪条语句，`default_effective`
  只做最终语义验证，禁止反推。另补上只有收敛侧才暴露的起算点语义——global 从内建
  `acldefault` 起算、schema 从空起算，因此「内容是内建默认真子集」的 global 行只能靠
  撤销得到。外部 defaclowner/grantee/grantor 与可再授予全部动态发现；空的、已知
  objtype 物理行作为无效应状态被容忍；`default-unmapped` 在 mutation 前 fail closed。
- **类型与 Large Object**：managed 非数组类型只保留 owner 的 `USAGE`，并且这一条同时
  落在对象 ACL 与 `T@global` 的 `pg_default_acl` 物理行上——新建 enum / domain /
  composite **出生即干净**，不需要「先漂移、再收敛一次」；数组类型只记录委托，既不
  进入收敛目标也不持有独立 ACL；**任意** Large Object 在任何 ACL / default ACL
  mutation 之前 fail closed，只报告、不解除链接、不删数据、不接管归属、不改
  `lomacl`，OID 不进入任何固定允许集合，只有在确实没有 LO 时收敛才会处理
  `defaclobjtype = 'L'` 与 20 个入口点的多余 `EXECUTE`。
- **language**：内建的 owner 与 `PUBLIC USAGE` 是**必需项**（owner 从 catalog 动态
  取得），缺失时 verify 拒绝、converge 以 language owner 的身份恢复。
- **继承而来的越权**：外部角色经外部 NOLOGIN 或 predefined role（如
  `pg_read_all_data`）拿到受监管有效权限时，在任何 mutation 之前 fail closed——
  database scope 按设计不修改 membership。canonical membership 图按**精确**判据
  校验：总边数正确、每条 canonical pair 恰好一行（不同 grantor 造成的重复边同样
  被拒）。
- **exact-ledger 不放宽**：`pg_default_acl` 只保护创建窗口；新增 migration 创建
  relation 或 sequence 时，必须同时新增 ledger 状态并登记该对象的固定授权。
- **统一校验入口**：`validateAuthorizationManifest()` 是唯一、公开、完整的校验
  入口，**每一个**导出的 renderer（projection / policy / shared / preflight /
  converge / verify 与两个 adapter）都在渲染之前调用它，没有任何 raw renderer
  旁路能绕过 canonicalizer。它校验受支持的正安全整数版本、全部会进入 SQL 的
  标量（privilege / identity / routine / ledger / phase / principal / schema），
  并要求 `defaults` 与 `defaultEffective` 的 grantee 必须属于 owner 或已登记的
  项目主体——外部角色一律 fail closed。
- **digest 覆盖 state key 集合**：新增一个五类数组全空的 `(ledger, phase)` 一行
  内容都不产生，但它实质放宽了 fail-closed 判定，因此 canonical digest 必须
  跟着变。
- **mutation 前致命前置条件**：未登记 ledger/phase、managed schema 缺失、项目角色
  缺失、owner 漂移、登录角色拥有对象、routine 指纹漂移/未知 routine、manifest 要求的
  对象缺失、未知 `defaclobjtype`、任意 Large Object，以及无法由 ACL mutation 修复的
  membership 漂移。`02-acl-baseline.sql` 与 `03-backup-grants.sql` 因此收成薄入口，
  两个阶段对同一批漂移给出**逐字相同**的问题清单。
- **真实 PostgreSQL 18.4 证据**：四个状态各自干净断言且连跑两遍独立快照不变；
  adapter 生成后才创建的角色被动态发现并收敛（generated SQL 不含该角色名）；八类
  受监管对象的未知 grantee、第三方 grantor、重复授权与可再授予一次收敛回基线；外部
  LOGIN 的直接授权、经外部 NOLOGIN 的继承、异常 membership 与 superuser 对照；空
  `f@global` / 空 `S@global` / schema 可再授予三种 default 场景与新建真实对象的 tuple
  parity；enum/domain/composite 的异常 `USAGE`、owner 权限保留、数组拒绝授权与改属、
  runtime CRUD 照常通过；三种归属的 Large Object 在 mutation 前失败且前后逐字节不变。

**R8B 之前的已知缺陷（现已修复，保留为历史记录）**

| 项 | R8B 之前 | 现状 |
| --- | --- | --- |
| ACL 全主体覆盖 | 收敛与断言使用 `watchedGrantees` 静态名单，canonical projector 未接入 | 静态名单已删除；收敛与断言都从共享 projector 读同一套事实 |
| 旧 `currentDefaultCte` 的**整套** default privilege 缺陷 | ①`COALESCE(schema, global, builtin)` 三选一冒充叠加语义；②把「空 global 行」与「没有这一行」混为一谈；③把 `pg_default_acl.defaclobjtype` 直接喂给 `acldefault`（sequence 的 `S` 被当成 FOREIGN SERVER，默认权限低报为只剩 `USAGE`）。该 CTE 同时被 converge 与 verify 引用，三条同时影响收敛与断言 | 该 CTE 连同 `currentAclCte` 一并删除；真实并集语义、行存在性与 `S→s` 映射由共享 projector 同时供给收敛与断言，两个 adapter 已重新生成并复验 |
| type / Large Object | 策略已决定但未落实 | 已落实：managed 非数组类型只保留 owner 的 `USAGE`；数组类型只记录委托，既不进入收敛目标也不持有独立 ACL；**任意** LO 对象在任何 mutation 之前 fail closed，只报告不删数据，OID 不进任何固定允许集合 |

**「ACL 全主体覆盖」的准确含义**（避免被读成「枚举了所有角色的所有权限」）：

- **normalized raw ACL**：在**受监管对象类别**（database、三个 managed schema 及
  其中的 relation/sequence/column/routine/非数组 type、language、Large Object，以及
  20 个 `pg_catalog` LO 入口点）内，动态枚举**全部 grantee 与 grantor**，不使用
  任何静态名单；
- **effective**：只覆盖 `PUBLIC`、项目角色（`meal_agent` 前缀）与目标库内**全部
  非 superuser LOGIN**。它**不是**对集群所有角色的枚举，外部 NOLOGIN 角色不在
  探测集合内（它们的直接授权仍由 raw 层可见）；
- 未覆盖的对象类别也不声称覆盖：FDW/foreign server/user mapping、tablespace、
  event trigger、subscription、publication、parameter ACL 均不在投影内。

**证据边界**：数据库身份与授权这条线，R8B 之后已经同时覆盖**观察、策略判断与
收敛**三层——canonical projector 采集事实，可移植策略判定允许项，收敛按真实
grantor 执行并由只读断言复验（R8A 当时只交付其中的观察层）。仍然**未覆盖**的是
本阶段的其余部分：Compose 拓扑、端口发布、secret file 注入、备份恢复与阶段总门禁
均未实现，也未取得证据；`pnpm stage09a:check` 尚未创建。

**Large Object 的口径**（两句都不可省略）：只要目标库里存在**任意**真实 LO
对象，两个阶段都在**任何 ACL / default ACL mutation 之前** fail closed，并且
**绝不修改 `lomacl`**、绝不改 `lomowner`、绝不改 LO 数据、绝不解除链接——只报告
OID 与 owner。只有在**确实零 LO** 时，收敛才处理 `pg_default_acl` 中
`defaclobjtype = 'L'` 的异常默认权限与 20 个 `pg_catalog` LO 入口函数上除函数
owner 之外的 `EXECUTE`。

**exact-ledger 的 state identity 是结构化的**：`[[按 C 序排序的 migration 文件名],
phase]`，Node 与 PostgreSQL 现场逐字节相同。排序语义只有一份：Node 侧的 ledger
排序与 migration 文件排序共用同一个 **UTF-8 字节序** comparator，PostgreSQL 现场
用等价的 `ORDER BY name COLLATE "C"`（JavaScript 默认的 UTF-16 码元序对补充平面
字符会给出不同顺序）。旧的 `join(",") + "|" + phase` 拼接有歧义——一个合法文件名
`0000_stage_06.sql,0001_stage_08.sql` 拼出的 key 与两个真实文件完全相同，一行
伪造的 ledger 就能冒充已登记状态。

- 阶段 09A 状态：**In Progress**。M1「API 容器构建基线」已由项目总控 Accepted；M2A「数据库身份、bootstrap、migration 与 readiness 权限边界」的 **R8A 只读 projector** 已由项目总控 Accepted（验收落点 `ca65275`）；**R8B 已由项目总控 Accepted**（projector 已接入 verify/converge、静态 grantee 名单已删除、旧 `currentDefaultCte` 的整套 default privilege 缺陷已统一替换、两个 adapter 已重新生成并复验、类型与 Large Object 策略已落实）；**M2A 整体已由项目总控 Accepted，验收落点 `5e480803`**；**M2B（Compose 拓扑）In Progress**；M3（配置与 Secret）、M4（生命周期与备份恢复）、M5（门禁/CI/文档）未开始。ADR-0005 保持 `Proposed`，阶段 09A 未标记完成。PR #1 保持 Draft。
- 当前实现落点：`services/api/Dockerfile` + 根 `.dockerignore`（Node 24.18.0 固定 digest、非 root `10001:10001`、runtime 无包管理器/客户端依赖）；`infra/docker/postgres/` 的 cluster/database 两作用域 bootstrap（六个项目角色、SCRAM 口令、owner 交接、ACL 基线、备份只读补授）；`db:bootstrap` 与 `db:migrate` 两个零参数运维入口。
- **两个固定 manifest + 一份动态只读 projector**。前两者是**冻结的期望值**，逐字节
  受 `manifest:check` 约束；第三者是对**当前环境**的动态观察，不含任何期望值，也
  不得被冻结成跨 cluster 快照。①冻结 `0000` 的对象与安全属性投影：`services/api/src/database/stage06-manifest.ts`，**408 条规范化行**，覆盖 database/schema 归属、relation、**每一列**、index、constraint、routine、policy、**managed schema 内的用户 type**（当前 10 条**全部是每张表的数组类型**，**不含行类型**：投影排除 `typrelid` 指向真实 relation 的行类型，而 `0000` 没有建 shell/base/enum/domain；`pg_catalog` 等系统 schema 不在范围内）、trigger、**外键内部 constraint trigger 的启用状态**、rule，以及 operator/opclass/opfamily/collation/conversion/统计/文本搜索/extension 等明确 namespace 类别。owner handoff 的阶段由**整组 owner** 判定：整组未交接或整组属于 migrator 才合法，任何混合态直接拒绝。投影在事务内固定 `search_path` 与 `quote_all_identifiers`，并在块结束时**显式还原**（`set_config(..., true)` 只在事务结束时恢复，不会在 DO 结束时恢复）。**对象 catalog 基线绑定 PostgreSQL 18.4**，patch 升级必须重新 capture 与 rebaseline。②**ledger 感知的授权 manifest**：`services/api/src/database/authorization-manifest.ts`，按 `(ledger, phase)` 登记 4 个状态、**408 条规范化行**（manifest 版本 2；`grant` 138、`effective` 138、`default-effective` 78、`routine` 40、`default` 14），只登记**固定允许项**：固定授权、`pg_default_acl` 的**物理行**、叠加后的**有效**默认权限、`has_*_privilege` 有效权限，以及受控 routine 的 identity/owner/`SECURITY DEFINER`/`proconfig`（结构化 JSON）/正文摘要；未登记的 `(ledger, phase)` fail closed。canonical digest 覆盖全部顶层字段（version、principals、managedSchemas、deniedRoutines、states）。③**canonical projector**：`services/api/src/database/authorization-projection-sql.ts`。它被拆成「可复用的结构化 projector CTE renderer」与「对外三列只读 SELECT」两层；R8B 起前者同时供给 verify 与 converge，后者仍是不被任何 bootstrap 阶段加载的只读观察出口。可移植策略在 `authorization-policy-sql.ts`。**四个** generated adapter 由只读 `manifest:check` 逐字节校验，真实 PostgreSQL 18.4 上还做 catalog↔manifest 逐行 parity，两个入口对同一批漂移给出逐字相同的拒绝理由。
- **恢复/安装流程分为两个阶段**：`bootstrap.sh acl` 是 containment（migration 之前 / `pg_restore` 之后收敛，刻意不给备份角色表级 `SELECT`），`bootstrap.sh grants` 是 final（migration 之后建立最终 ACL，并**同时**验证 PUBLIC、app、backup 与三个 login）。两个阶段执行同一段生成的收敛块：按真实 grantor 撤销一切不在 manifest 内的授权（含 grant option 与列级授权），再只重建允许项，后验同时比对 catalog ACL 与 `has_*_privilege` 有效权限。
- 产品声明禁用 Large Object，收敛口径与上面的「Large Object 的口径」完全一致：**只有在目标库确实零真实 LO 时**，收敛才把 `pg_default_acl` 中 `defaclobjtype='L'` 的多余默认权限收敛为空，并收回 `pg_catalog` 中 20 个 LO 入口点（`lo_create`/`lo_creat`/`lo_from_bytea`/`lo_put`/`lo_import` …）上除函数 owner 之外的 `EXECUTE`；runtime login 与 backup 的真实反向测试证明创建入口已关闭。一旦库里存在**任意**真实 LO 对象，两个阶段都在**任何 ACL / default ACL mutation 之前** fail closed，只报告 OID 与 owner——**绝不修改它的 `lomacl`**、绝不改归属、绝不改数据、绝不解除链接，LO 的 OID 也不进入任何固定允许 manifest。`meal_agent_private` 的受控 routine 按 identity 精确匹配，没有 schema 级通配豁免。
- 恢复的**受支持 ledger 窗口至少覆盖 N-1**：窗口内每个已发布 ledger 都必须保留对应的 containment manifest 状态；该约束已同步进阶段 09A 计划的 M4 与验收门禁第 14 条。当前只有一个 ledger，因此 M4 验证的是同一 ledger 的 round-trip。
- 计划分支：`claude/stage-09a-api-container-baseline-9f286c`（PR #1，保持 Draft），从最新本地 `main` 建立独立 worktree。
- 当前目标只覆盖本地/私有测试部署包；腾讯云广州仅为未来阶段 09B 的默认候选，没有创建或购买任何云资源。
- API 已有 health/readiness、迁移校验和 production 拒绝 fake adapter。Dockerfile 与数据库身份隔离已实现；仍缺 Compose 拓扑、Secret 文件注入、备份恢复证据与阶段总门禁。
- 总控机器现已具备 Docker（Engine 29.6.2 / Compose v5.3.1）与 PostgreSQL 18.4；容器构建、隔离 smoke test 与真实 PostgreSQL 18 权限测试均已本地执行。阶段 09A 仍未记录为 Pass。
- GitHub `origin` 与 `main` upstream 已配置，仓库已有 CI workflow；当前只确认配置存在，没有在本次规划中读取或伪造远端 run Pass。

### Deferred — 外部依赖

以下项目没有被本地 fake adapter 或模拟器改记为 Pass：

- 真实 AppID/AppSecret、真实 `wx.login`/code2Session、合法 HTTPS 域名；
- 真机、多设备真实会话、体验版、审核、发布与 CI 上传凭据；
- 云 API、托管 PostgreSQL、正式 Secret 管理、WAF、备份恢复和可观测平台；
- Android、iOS、HarmonyOS 工具链、签名、实机和发布。

### 内部后续范围 / 发布阻断

- 应用进程重启后的未知命令恢复协议尚未实现；必须使用非敏感 locator + 服务端 command-status/receipt 或原子 fence，普通 GET 不构成恢复证据。该项不是外部依赖，并在完成前阻断发布。

菜单推荐、菜谱、采购、完整做饭、Agent、报餐/投票也不在阶段 08 范围。

仓库已配置受控 remote/upstream；远端 CI 仍需由阶段 09A 的真实 GitHub Actions run 提供证据。M2A 的 R8A、R8B 与 M2A 整体均已由总控 Accepted（M2A 验收落点 `5e480803`），M2B（Compose 拓扑）In Progress。所有外部 Deferred 项保持原状态。菜单推荐开始前仍需单独完成 cooking-technique、allergen、food concept、宗教/伦理及食品安全规则词表的数据治理；该产品安全工作不与本地容器化混成同一个提交。
