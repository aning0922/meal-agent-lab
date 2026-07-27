# 项目状态

最后更新：2026-07-26

## 当前结论

阶段 08 最终审计整改已完成本地实现与标准门禁，并于 2026-07-26 由项目总控以 fast-forward 合并至 `main`（实现落点 `df8107c`）。阶段 08 已收口。[阶段 09A](plans/2026-07-stage-09a-local-deployability-baseline.md)**实施中**：先建立 Docker Compose 本地可部署性、数据库账号隔离、迁移、健康检查与备份恢复基线，不购买服务器、不接真实微信配置、不开放公网。M1 已 Accepted，M2A 待总控复验，M2B—M5 未开始；详见本文末的阶段 09A 小节。整改遵循 [ADR-0004](architecture/decisions/0004-stage-08-pre-release-audit-closeout.md) 的预发布窄例外：仓库没有已部署生产/测试消费者，因此 contracts 保持 `0.4.0` 并在 `/api/v1` 原地修正；若发现真实环境或外部消费者，该例外立即失效。

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

| 层 | 通过数量/结果 |
| --- | --- |
| contracts | 28/28 |
| API unit | 12/12 |
| API HTTP | 6/6 |
| PostgreSQL migration/RLS/concurrency | 50/50 |
| client unit + page rendering | 129/129 |
| stage 07 + stage 08 双用户 E2E | 21/21 |
| audit gate 与 transport 反向单测 | 11/11 |
| OpenAPI | 19 paths / 25 operations，生成一致 |
| weapp | production build Pass |
| Markdown links | Pass |

标准 `pnpm audit` 报告的合法漏洞退出语义仍为退出码 `1`、1 critical、1 high、8 moderate。机器门禁使用 loopback transport normalizer 转发 npm 官方 HTTPS bulk endpoint，不自动跟随 redirect，任何 3xx 都失败；原始响应流和 gzip 解压流分别实施 16 MiB 上限。normalizer 只兼容直接 JSON 或通过 gzip magic/CRC 校验的 JSON，仍由 `pnpm audit` 生成实际依赖路径；损坏压缩、非 JSON、非 200、registry/network 错误和缺 metadata 均失败。门禁只接受 [`security/audit-exceptions.json`](../security/audit-exceptions.json) 中精确、截至 2026-08-08 的 local/weapp-only 例外，并扫描构建产物；任何新增、变化、过期或已消失但未清理的 advisory 均失败。证据见 [weapp advisory scan](evidence/stage-08-audit/weapp-advisory-scan.json)。例外期间 H5、外部测试、体验版和发布被阻断，不能把 gate Pass 表述为漏洞修复。

## 阶段 09A 计划与下一门禁

- 阶段 09A 状态：**In Progress**。M1「API 容器构建基线」已由项目总控 Accepted；M2A「数据库身份、bootstrap、migration 与 readiness 权限边界」第六轮整改完成、待总控复验（第五轮 `5ed406c` 未通过复验）；M2B（Compose 拓扑）、M3（配置与 Secret）、M4（生命周期与备份恢复）、M5（门禁/CI/文档）未开始。ADR-0005 保持 `Proposed`，阶段 09A 未标记完成。
- 当前实现落点：`services/api/Dockerfile` + 根 `.dockerignore`（Node 24.18.0 固定 digest、非 root `10001:10001`、runtime 无包管理器/客户端依赖）；`infra/docker/postgres/` 的 cluster/database 两作用域 bootstrap（六个项目角色、SCRAM 口令、owner 交接、ACL 基线、备份只读补授）；`db:bootstrap` 与 `db:migrate` 两个零参数运维入口。
- **两个阶段感知的事实源**。①冻结 `0000` 的对象与安全属性投影：`services/api/src/database/stage06-manifest.ts`，**408 条规范化行**，覆盖 database/schema 归属、relation、**每一列**、index、constraint、routine、policy、**managed schema 内的用户 type**（含 shell、base 与每张表的行类型/数组类型；`pg_catalog` 等系统 schema 不在范围内）、trigger、**外键内部 constraint trigger 的启用状态**、rule，以及 operator/opclass/opfamily/collation/conversion/统计/文本搜索/extension 等明确 namespace 类别。owner handoff 的阶段由**整组 owner** 判定：整组未交接或整组属于 migrator 才合法，任何混合态直接拒绝。投影在事务内固定 `search_path` 与 `quote_all_identifiers`，并在块结束时**显式还原**（`set_config(..., true)` 只在事务结束时恢复，不会在 DO 结束时恢复）。**对象 catalog 基线绑定 PostgreSQL 18.4**，patch 升级必须重新 capture 与 rebaseline。②**ledger 感知的授权 manifest**：`services/api/src/database/authorization-manifest.ts`，按 `(ledger, phase)` 登记 4 个状态、**382 条规范化行**，描述 PUBLIC/app/backup/三个 login 的 catalog ACL、`pg_default_acl` 有效默认权限、`has_*_privilege` 有效权限，以及受控 routine 的 identity/owner/`SECURITY DEFINER`/`proconfig`/正文摘要；未登记的 `(ledger, phase)` fail closed。三个 generated adapter 由只读 `manifest:check` 逐字节校验，真实 PostgreSQL 18 上还做 catalog↔manifest 逐行 parity，两个入口对同一批漂移给出逐字相同的拒绝理由。
- **恢复/安装流程分为两个阶段**：`bootstrap.sh acl` 是 containment（migration 之前 / `pg_restore` 之后收敛，刻意不给备份角色表级 `SELECT`），`bootstrap.sh grants` 是 final（migration 之后建立最终 ACL，并**同时**验证 PUBLIC、app、backup 与三个 login）。两个阶段执行同一段生成的收敛块：按真实 grantor 撤销一切不在 manifest 内的授权（含 grant option 与列级授权），再只重建允许项，后验同时比对 catalog ACL 与 `has_*_privilege` 有效权限。
- 产品声明禁用 Large Object，因此除 `lomacl` 与 `defaclobjtype='L'` 收敛为空外，还收回 `pg_catalog` 中 20 个 LO 入口点（`lo_create`/`lo_creat`/`lo_from_bytea`/`lo_put`/`lo_import` …）的 `PUBLIC EXECUTE`；runtime login 与 backup 的真实反向测试证明创建入口已关闭。`meal_agent_private` 的受控 routine 按 identity 精确匹配，没有 schema 级通配豁免。
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

仓库已配置受控 remote/upstream；远端 CI 仍需由阶段 09A 的真实 GitHub Actions run 提供证据。下一步是总控复验 M2A，然后进入 M2B（Compose 拓扑），并保持所有外部 Deferred 项原状态。菜单推荐开始前仍需单独完成 cooking-technique、allergen、food concept、宗教/伦理及食品安全规则词表的数据治理；该产品安全工作不与本地容器化混成同一个提交。
