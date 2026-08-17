# 项目状态

最后更新：2026-08-17

## 当前结论

**当前 M5 架构收敛事实（2026-08-17，覆盖下方历史轮次）**：候选 `ea9a6fd` 的两路独立审计均为 BLOCK 后，总控按 [M5 架构收缩与收敛任务书](plans/2026-08-m5-architecture-convergence.md) 完成一次结构性改造。生产 runtime image 扫描已删除自写 OCI/PAX layer replay 这份第二事实源，改为 immutable image ID → claimed scratch container → Docker daemon export 的单一路径；build evidence、Secret、镜像与多栈 cleanup 使用显式 owner claim；service/one-shot generation、backup 输出目录与进程 settlement 也收敛到共享协议。实现落点 `eec3e0d` 已从头通过本地 `pnpm stage09a:check` **14/14**（runtime image：78 packages / 76 top-level links / 5 migrations；变异：1 baseline + 15 built + 2 static-only；local-test 75/75；targeted 69/69；signal 5+6），等待两个全新的独立只读 A/B 审计。**M5 为 Implemented — pending independent A/B review，未 Accepted；09A 未 Pass；远端 CI 无真实 run。**

阶段 08 最终审计整改已完成本地实现与标准门禁，并于 2026-07-26 由项目总控以 fast-forward 合并至 `main`（实现落点 `df8107c`）。阶段 08 已收口。[阶段 09A](plans/2026-07-stage-09a-local-deployability-baseline.md)**实施中**：先建立 Docker Compose 本地可部署性、数据库账号隔离、迁移、健康检查与备份恢复基线，不购买服务器、不接真实微信配置、不开放公网。M1、M2A、M2B、M3A、M3B 与 M4 均已 Accepted；M5 架构收敛实现已完成并通过本地完整 14/14，当前等待两个全新的独立只读 A/B 审计，未 Accepted。远端 CI 只登记 workflow 已配置、无真实 run，ADR-0005 已转 `Accepted`，ADR-0006 保持 `Proposed`。**09A 总验收未完成，阶段 09A 仍不得记为 Pass。**详见本文末的阶段 09A 小节。整改遵循 [ADR-0004](architecture/decisions/0004-stage-08-pre-release-audit-closeout.md) 的预发布窄例外：仓库没有已部署生产/测试消费者，因此 contracts 保持 `0.4.0` 并在 `/api/v1` 原地修正；若发现真实环境或外部消费者，该例外立即失效。

**当前 M5 更新（2026-08-15，覆盖上段历史句）**：第九轮候选 `4a72218` 的两路独立
审计仍为 BLOCK；第十轮实现落点 `3849bbd` 已关闭同步 spawn/stdin/timer-clear primitive
失败的 cleanup-before-settlement、backup cleanup 失败后的正式制品回滚与 promotion inode
所有权、Compose nested build/healthcheck 能力，以及 topology、Group E image evidence、
Secret identity probe 的固定安全诊断。脚本测试 83/83、topology 27/27、targeted 69/69、
local-test 75/75、signal 5+6、八份 Secret identity 与真实 restore drill 已通过；含文档
候选 `a8ad0b2` 的新 HEAD 已从头通过完整 `stage09a:check` 14/14。M5 未 Accepted，
远端 CI 无真实 run，09A 仍为 In Progress；下一门禁是全新 A/B 独立只读复审。

**Round 10 完整门禁更新（2026-08-15，当前事实）**：含文档候选
`a8ad0b2` 的新 HEAD 已从头串行通过 `pnpm stage09a:check` **14/14**；fresh smoke、
八份 Secret identity、lifecycle、restore 和最终 scoped cleanup 均 PASS。当前下一门禁
是两个全新独立只读 A/B 复审；M5 未 Accepted、09A 未 Pass、远端 CI 无真实 run。

**Round 11 完整门禁更新（2026-08-15，当前事实，覆盖上段）**：Round 10 候选
`df4a378` 的 A/B 审计均为 BLOCK。Round 11 实现落点 `9469bc9` 关闭逐服务 Compose
能力、canonical image ID、Secret identity 闭合成功协议与 settle 当下 PGID=ESRCH
证据边界，并把 mutation 计数接入 registry integrity。脚本测试 **85/85**、topology
mutation **29/29**；同一落点已串行通过 `pnpm stage09a:check` **14/14**，fresh smoke、
八份 Secret identity、lifecycle、restore 与最终 scoped cleanup 均 PASS。当前下一门禁
是两个全新独立只读 A/B 审计；M5 未 Accepted、09A 未 Pass、远端 CI 无真实 run。

**Round 12 cycle 1 完整门禁更新（2026-08-16，当前事实，覆盖上段）**：候选
`09d883f` 的 A/B 独立审计均为 BLOCK。整改实现截至 `03e5e41` 已闭合 resolved
Compose 的 project/network/volume/logging 能力、Docker build/scan/cleanup identity、
M4 容器身份、backup/restore byte binding 与进程组 settlement。完整链先后暴露中断
build tag 所有权和退出后 `docker exec` 取 backup 源摘要两项真实缺陷，均先形成回归再
重跑。脚本测试 **99/99**、topology mutation **39/39**、runtime image mutation
**1 baseline + 12 built + 2 static-only**；最终同一落点从步骤 1 串行通过
`pnpm stage09a:check` **14/14**，fresh smoke、八份 Secret identity、lifecycle、restore
与最终 scoped cleanup 均 PASS。当前下一门禁是 cycle 2 的两个全新独立只读 A/B
审计；M5 未 Accepted、09A 未 Pass、远端 CI 无真实 run。

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

项目标准 Codex runtime 直接执行 `pnpm stage08:check`，退出码为 `0`；没有临时注入 `rg` 或改写 PATH。

> **阶段 09A / M3A 第七轮起新增前置条件：`pnpm --filter @meal-agent/api check`
> （因而 `pnpm check` 与 `pnpm stage08:check`）需要能运行 Docker**。
> `tests/unit/bootstrap-signal-matrix.test.ts` 要把信号矩阵放进钉住 digest 的
> `postgres:18.4-bookworm` 里以 uid 999 跑一遍，并且**刻意不做静默跳过**——一条会
> 自动跳过的安全用例等于没有。没有 Docker 的 runtime 会在这一条上确定地失败，
> 而不是悄悄少跑一项。

当前门禁包含：

下表是 **2026-08-13（阶段 09A / M5 第五轮独立审计整改）之后**的实际计数（阶段 08 收口时为
contracts 28、API unit 12、API HTTP 6、PostgreSQL 50；差额来自阶段 09A 的 M2A/M3A
各轮新增测试，业务语义未变）：

| 层 | 通过数量/结果 |
| --- | --- |
| contracts | 28/28 |
| API unit | 182/182 |
| API HTTP | 8/8 |
| PostgreSQL migration/RLS/concurrency/身份边界 | 128/128 |
| client unit + page rendering | 129/129 |
| stage 07 + stage 08 双用户 E2E | 21/21 |
| audit、runtime image、M4 remediation 与聚合器/CI 脚本单测 | 131/131 |
| generated adapter 只读门禁 | 4/4 逐字节一致 |
| OpenAPI | 19 paths / 25 operations，生成一致 |
| weapp | production build Pass |
| Markdown links | 63 files / 260 local links PASS |
| Compose 拓扑静态门禁 | PASS（14 服务 / 8 host Secret source / 10 named volume / 2 网络） |
| Compose 拓扑变异反向测试 | 当前 45/45 以指定理由捕获，0 漏网；历史 15/15、39/39、44/44 仅代表更早拓扑 |

标准 `pnpm audit` 报告的合法漏洞退出语义仍为退出码 `1`、1 critical、8 moderate。机器门禁使用 loopback transport normalizer 转发 npm 官方 HTTPS bulk endpoint，不自动跟随 redirect，任何 3xx 都失败；原始响应流和 gzip 解压流分别实施 16 MiB 上限。normalizer 只兼容直接 JSON 或通过 gzip magic/CRC 校验的 JSON，仍由 `pnpm audit` 生成实际依赖路径；损坏压缩、非 JSON、非 200、registry/network 错误和缺 metadata 均失败。门禁只接受 [`security/audit-exceptions.json`](../security/audit-exceptions.json) 中精确、截至 2026-11-08 的 local/weapp-only 例外（2026-08-06 第二次授予，逐条对账后显式续期，依据与条件见 ADR-0004），并扫描构建产物；任何新增、变化、过期或已消失但未清理的 advisory 均失败。2026-08-04 的实时门禁先后发现 PostCSS、`fast-uri` 与 `brace-expansion` 新公告；`f3e3099` 已把它们升级到修复版本，并删除随之失效的旧 `brace-expansion` 例外，未新增审计例外。证据见 [weapp advisory scan](evidence/stage-08-audit/weapp-advisory-scan.json)。例外期间 H5、外部测试、体验版和发布被阻断，不能把 gate Pass 表述为漏洞修复。

## 阶段 09A 计划与下一门禁

### 阶段 09A 当前状态（目标设计 vs 已实现事实）

**已实现的事实**

| 里程碑 | 状态 |
| --- | --- |
| M1 API 容器构建基线 | 总控 **Accepted** |
| M2A R8A（只读 canonical projector） | 总控 **Accepted**，验收落点 `ca65275` |
| M2A R8B（把 projector 接入 verify/converge） | 总控 **Accepted** |
| M2A 整体 | 总控 **Accepted**，验收落点 `5e480803` |
| M2B Compose 拓扑 | 总控 **Accepted**，验收落点 `d0f2219` |
| M3A 配置与 Secret file 消费核心 | 总控 **Accepted**，验收落点 `a839df1` |
| M3B 环境模板、八份 Secret 与完整 bootstrap 链实证 | **已于 2026-08-11 Accepted，验收落点 `cf43452`**。扫描器范围与已登记的未闭合族见下方专节 |
| M4 生命周期、备份和恢复 | **已于 2026-08-11 Accepted，验收落点 `f671c51`**（停止/重启持久化、`pg_dump` + SHA-256 + 单事务恢复、授权面逐字一致、SIGTERM 限时强制退出，均有演练实证） |
| M5 门禁、CI 与文档 | **当前工作分支的不可变证据协议候选已从头通过完整 `pnpm stage09a:check` 14/14，仍待两个全新 A/B 独立只读审计，未 Accepted**。GitHub Actions 复用同一命令，但**无真实远端 run，只登记已配置**。见计划文档 M5 实施记录与 ADR-0006 |
| 09A 总验收 | **未完成**（「## 验收门禁」全表 + 远端 CI 条件） |

#### M3B 扫描器范围与已登记的未闭合族

**M3B 的 tracked 模板扫描器是尽力而为的第二层网**：Round 24 的绝对面普查（`node --env-file` 为唯一 oracle）实测主面存在**已登记的未闭合族**，分两级登记——

**（甲）由 `check-m3b-template-surface-sweep.mjs` 逐族钉死并附原因的 5 族**：大小写扩张码点（`open/case-expanding-codepoint`）、数字开头粘连词干（`open/digit-leading-glued-stem`）、结合处数字（`open/glued-stem-joint-digit`）、benign 白名单反向注入（`open/benign-allowlist-injection`）、运算符尾键（`open/operator-tail-key`）；另有两份扫描 pathspec 之外的 tracked dotenv 模板由该门禁的 pathspec 检查钉住。

**（乙）已进族/视图登记表但门禁无对应格的 4 族**：嵌套 `hashIsComment`（`unguarded/nested-hash-is-comment`）、反引号引号族（`unguarded/backtick-quote`）、URL 前缀嵌套（`unguarded/url-prefix-nesting`）、prose 角色活行（`unguarded/prose-role-live-line`）。门禁的六个视图模板**结构上表达不了**它们——0/6 含反引号、0/6 含 `://`、0/6 含「`=` 后空白再接 `#`」。**这 4 族目前没有任何门禁看守。**（Round 26 已把 `expect` 的第三态 `mixed` 实现出来，登记表不再表达不了逐视图混合；但那 4 族仍然落不了格，因为缺的是**渲染面**而不是状态——要钉住它们必须先扩视图模板，属独立里程碑。）

上面两份族名列表不再是手抄的：括号里的 id 由 [`check-m3b-registry-integrity.mjs`](../infra/docker/check-m3b-registry-integrity.mjs) 与 [`m3b-surface-registry.mjs`](../infra/docker/m3b-surface-registry.mjs) 的 `families` / `unguardedFamilies` **机械比对**，多一个、少一个、拼错一个都转红。

**其中反引号面是本轮已披露的最大未守面**：实测一个「整行含反引号即豁免敏感判据」的回归，surface sweep、69 格 targeted、75 格 local-test **三张网全部为绿**；而真实模板里 `infra/environments/local-test/README.md` 有 23/73 行、`infra/environments/README.md` 有 3/22 行含反引号（分母为文件真实行数，同样由登记完整性门禁数出来比对；计数由登记完整性门禁按当前已提交文件逐行复核）。

**M3B 的验收范围不得表述为「环境模板已覆盖」，也不得表述为「已登记族全部由门禁钉死」。**第一层控制（八份 Secret 从不进仓库、`.gitignore`、全仓 containment 扫描）**与键名判据零共享**（`local-test-containment.mjs` 对 `isSensitiveKeyName` / `scanTrackedTemplates` / `sensitiveKeySuffixes` / `sensitiveCompactAssignments` 的引用数为 0，needle 按真实 Secret 取值构造），未受影响；真实 tracked 模板实测 0 problem。

**M3A 实际交付的**（详见[阶段 09A 计划的 M3A 实施记录](plans/2026-07-stage-09a-local-deployability-baseline.md)）

- **一个 Secret 来源解析器，三个 Node 入口共用**：`loadConfig()`、`db:migrate`、
  `db:bootstrap` 都调用 `services/api/src/config-source.ts` 的
  `resolveDatabaseUrlSource()`，三处都不再直接读 `process.env["DATABASE_URL"]`
  （有结构性测试断言）。`DATABASE_URL` 与 `DATABASE_URL_FILE` 互斥：两者都缺、
  两者同时出现（**内容相同也拒绝，从不比较取值**）、空 direct、空 `_FILE` 一律
  失败，选中来源失败时**不回落**到另一来源。
- **连接串的核心字段必须全部来自 URL，且拒绝 URL 无法覆盖的那 8 个 `PG*`**：node-postgres 实测会在字段缺失时静默
  回落到 `PG*` 环境变量（`postgresql://` 会让 host/port/user/password/database
  五项全部来自环境变量；`?host=/tmp` 与 `%2Ftmp` 会把目标换成 unix socket）。
  因此 validator 放在**三个入口共用的那一层**：拒绝原始串里的 CR/LF/NUL/BOM 与
  未编码空白、只接受 `postgresql://`/`postgres://`、要求 username/password/
  hostname/port 显式非空且 database 是单一 path segment、拒绝 query/fragment/
  多 host/Unix socket/`options` 覆盖、对百分号解码后的 username/password/database
  再查一次 NUL/CR/LF，并**原样返回**输入串。真实 `pg.Client.connectionParameters`
  在注入 ambient sentinel 的条件下逐字段验证。
  连接串**无法覆盖**的那一批 ambient 变量（`PGOPTIONS`、`PGSSLMODE`、
  `PGSSLNEGOTIATION`、`PGBINARY`、`PGREPLICATION`、`PGCLIENT_ENCODING`、
  `PGAPPNAME`、`PGCONNECT_TIMEOUT`，共 8 个）在同一层逐条拒绝。`PGHOST`/`PGPORT`/
  `PGUSER`/`PGPASSWORD`/`PGDATABASE` **不在**拒绝表里——URL 已经决定了它们，有
  正面用例证明它们即使存在也不生效——它们能改协议协商、会话
  参数与传输格式，实测在修复前确实会落进 `connectionParameters`。检查同时覆盖
  传入的 environment 与 `process.env`（node-postgres 读的永远是后者），错误只列
  变量名、不回显取值。拒绝表按 `pg@8.22.0` 源码逐条列出并把版本钉在断言里。
- **secret file 判据 fail closed**：绝对路径、`O_NOFOLLOW|O_NONBLOCK` 打开后
  **fstat**（不是先 stat 路径再 open）、普通文件、链接数为 1、属主等于当前
  effective UID、只允许 owner-only 的 `0400` 或 `0600`、≤4096 字节、非空、合法 UTF-8、
  无 NUL、无 BOM、单行、最多移除一个末尾 LF 且**不做 trim**。含空格、`:`、`\`、
  `@`、`/`、`#`、`%` 的取值逐字节保留。错误信息只含变量名、路径与原因。
- **bootstrap 的 shell 侧按条对齐**（不是逐字节等价的同一实现，差异见下）：`infra/docker/postgres/secret-source.sh` 覆盖
  三对 `MEAL_AGENT_*_PASSWORD` / `*_FILE`；**三份口令全部在任何 psql 调用之前
  解析**，任一不合格时 psql 调用次数实测为 **0**（23 个失败来源逐条断言）。口令
  不进入 argv、生成 SQL、日志，也不进入 psql 子进程的 environ（`export -n`），
  `bash -x` 下不泄漏。GNU（Debian 容器，uid 999）与 BSD（macOS）两个 `stat`
  分支都已实测。
- **shell 侧的信号处置是一台显式状态机**（第六轮重做）：
  `idle / starting / running / terminating`。`starting` 覆盖「`( … ) &` 与
  `worker=$!` 之间」那段窗口——顺序改成**先装 trap、后起 worker**，因此不再存在
  「worker 已跑、trap 未装」时按默认处置杀掉父进程、把受控子树留成孤儿的竞态。
  trap 里**只登记**信号，清理一律回主流程做（bash 只在命令边界分发 trap，在
  handler 内部再 `kill -SIG $$` 会让「调用方 handler 何时跑」变成依赖 bash 版本
  的嵌套细节）。worker PID 保留到 TERM、KILL、`wait` 三步**全部**完成才清空，
  因此清理途中到达的第二个信号只登记 pending，既不重入也不让父进程提前退出。
  清理完先把调用方**全部**原有 trap 还回去，再重投决胜信号——装了 handler 就跑
  handler（实测 71/72/73 三个退出码各自生效）、没装走默认处置（128+signo）、
  `trap '' SIG` 就真的什么都不发生（此时秘密没读成，按失败收场）。并发信号明确
  为**先到者胜**（first-wins），代码注释与用例都写死：TERM 之后 0.1s 补一发 HUP，
  退出语义仍是 SIGTERM，且 worker/head/孙进程（三者都忽略 TERM/INT/HUP）全部消失。
- **信号矩阵已经是门禁，不再只是文档**（第七轮）：
  `infra/docker/postgres/signal-matrix.sh` 覆盖「四种调用方处置（默认处置 /
  handler 自杀 / handler 只返回不退出 / `trap '' SIG` 忽略）× TERM/INT/HUP ×
  none / terminating / handler / storm / post-worker / **pre-worker** 六个投递窗口、
  first-wins、EXIT trap 链式执行与退出状态回传」，共 **150 项断言**。
  **150 是断言条数，不是 4×3×窗口的全组合覆盖**——每个窗口只挑与它相关的处置组合
  （例如 pre-worker 与 post-worker 各跑 default/exit/ignore/return 四种处置、只用
  TERM），断言数远小于全组合。这个数字在门禁里是**精确相等**而不是下界，改动必须
  同时改门禁与本表；
  `tests/unit/bootstrap-signal-matrix.test.ts` 让它在本机 bash 3.2 与
  **钉住 digest 的 postgres:18.4-bookworm 容器内以 uid 999** 各跑一遍，两侧都进
  `pnpm --filter @meal-agent/api check`。**因此这条门禁新增了 Docker 前置条件**，
  并且刻意**不做静默跳过**——会自动跳过的安全用例等于没有。
- **窗口投递是确定的，而且观察点全在测试侧**（第八轮改）：上一版靠生产代码里的
  marker 文件 + 阻塞等待来命中窗口，那等于在生产路径上留了一个可写文件的测试
  入口——已经**整条删除**（`MEAL_AGENT_SECRET_WINDOW_MARKER_DIR` 与它的两个函数
  在 `secret-source.sh` 里已不存在）。现在：
  - `terminating` 窗口由受控 `head` 自己 trap 住 TERM 并写 marker 来定位——那是
    实现「对整个 worker 进程组发 TERM」的真实外部效果；
  - `post-worker` 窗口由 PATH 影子 `rm` 定位——`meal_agent_discard_snapshot` 用的
    就是 `rm -rf`，所以那一刻 worker 已结束、快照验证与取值复制都已完成；
  - `starting` 窗口（trap 已装、`worker=$!` 未赋值）**没有任何外部可观测副作用，
    因此无法被真实确定地命中**。它现在只由代码顺序保证（先装 trap、后 fork），
    矩阵与文档都**不再声称它被证明过**。
- **信号 trap 的作用域是整个 resolve**（第八轮）：上一版在 worker 结束后立刻归还，
  于是「快照验证 → 取值复制 → 删除快照」三步全都跑在调用方的处置之下。实测：在
  删除快照那一步发一个 TERM，调用方 `trap '' TERM` 或 handler 只返回时，
  `1855aec` 会**照常成功并打出 RESOLVED**——被中断了却装作读到了。现在 trap 一直
  保持到快照删除完成之后才归还，同样场景下 fail closed（exit 2，
  "interrupted by a signal"，没有 RESOLVED）。
- **调用方的 EXIT trap 不再被顶掉**（第七轮）：`secret-source.sh` 是被 `source`
  进 bootstrap.sh 的，此前一句裸的 `trap '…' EXIT` 会把调用方的 EXIT 处置整条
  换掉（实测：调用方的 marker 在全部 9 个场景里都没出现）。现在改成保存 → 链式
  执行 → 解析结束归还。
- **first-wins 从概率性变成结构性**：重投 winner 之前先把另外两个信号换成「只登记
  pending」的抑制 handler，只归还 winner 那一个处置。此前是「先恢复全部 trap、
  再重投 winner」，落在中间的 loser 会命中调用方的 handler——实测退出码由 loser
  决定（期望 71，实得 73）。
  bash 3.2/macOS 与 pinned Debian bookworm/bash 5.2/uid 999 两侧同一组场景实测
  全通过。
- **部署身份是两个无默认值的独立维度**：`DEPLOYMENT_STAGE` 与
  `DEPLOYMENT_EXPOSURE`。fake adapter 只在 `local-test` + `loopback` + 非
  production 三者同时成立时被接受——27 个组合穷尽测试里只有 2 个通过；
  `local-test` 携带非空 AppID/AppSecret 在启动前失败。`NODE_ENV` 与两个部署维度
  互不覆盖。Compose 的 `api` 固定 `local-test` + `loopback`。
- **真实 code2Session endpoint** 收紧为逐字节相同的官方地址，配置层与 adapter
  层各判一次，24 个反例（HTTP、相似域名/子域名、userinfo、端口含 `:443`、尾
  斜杠、query、fragment、空白）全部拒绝。fake adapter 在注入「一调用即抛错」的
  fetch 并替换 `globalThis.fetch` 的条件下，成功与失败两条分支的外部调用次数
  都是 0。**本轮没有接入真实 AppID/AppSecret，也没有调用真实微信服务。**
- **脱敏落在中央 logger 边界**（`hooks.logMethod` + `formatters.log` + `child()`
  与 `setBindings()` 覆盖 + 子 logger options 的安全包装）。**pino 的 `redact`
  已经整条不用**：根 logger 不配置它，子 logger 传了直接抛错。调用方无需主动调用
  `redactSensitive`；覆盖任意
  嵌套层级的连接串/口令/DSN 命名变体、按取值识别的 PostgreSQL 连接串与 libpq
  conninfo（含带引号/空格的形态：看到 `password=` 即删除其后全部文本）、Error 与
  嵌套 cause、printf `%j`/`%o`/`%s` 参数、`child()` 与孙 logger 的 bindings、
  own enumerable `toJSON`/`toString`（一律换成占位串，`JSON.stringify` 阶段不会
  再碰到调用方提供的这两个方法），对象与数组共用的循环引用防护，`setBindings()`（root/child/
  grandchild），子 logger 的 `serializers`/`formatters.log`/`formatters.bindings`/
  `msgPrefix`，以及**百分号编码**的连接串（请求目标完全由调用方
  控制，可以把整条 DSN 编码进 path）。口令的原值与 URL 编码形态同时消失。
  41 组用例全部扫描**真实 Pino 最终输出**，并**正向**断言请求日志仍然保留
  method、脱敏后的 path、remoteAddress 与 statusCode——脱敏不能靠把请求信息
  一起丢掉来「通过」。
- **Error 与不可信输入的两条额外边界**（第六轮补上）：`Error.message` 会被 pino
  的 `write()` 直接取成顶层 `msg`，那条路径**绕过 serializer**，因此 Error 的
  折叠改在交给 pino **之前**完成；`Error.name` 改成**精确 allowlist**，名单之外
  一律输出 `Error`（`SimplePasswordSecret123` 这种完全符合类名文法的自由文本
  不再被当成类型名）。strict canonicalizer 不再执行输入自带的任何转换方法：数组
  按下标新建递归（不走 `map`、不走迭代器）、BigInt 走原始值转换（覆写
  `BigInt.prototype.toString` 无效）、访问器只记成 `[Getter]` 而不读取、
  遮蔽 `Object.prototype` 成员的结构键统一改名（`hasOwnProperty` 此前会让 pino
  的 `asChindings()` 自己抛 `TypeError`，`__proto__` 则不再有机会触及原型
  访问器）。
- **业务事件走独立的 `EventLogSink`**（第十二轮建立，Round 13/14 收口）。口径写实：
  **Fastify 仍然暴露 `app.log` / `request.log`**——那是框架的 API，仓库改不掉。
  真正成立的是两件事：**本仓库的业务调用点由 capability gate 约束**，而**业务事件
  通过独立的 `EventLogSink`**。
  Round 13 把 sink 的底座从「组装根手里的那个 logger」换成
  `createLoggingContext()` 新建的、与 framework **分开的另一个 pino 根**：
  `options.logger` 只能注入 framework 那一侧，业务事件底座调用方碰不到；sink 本身
  `Object.freeze`，`emit` 不可写也不可重定义。
  三条反例都有修复前对照（复刻 Round 12 接线实测）：预绑定 child →
  `"traceContext":"OPAQUE-…"` 出现在业务事件行；建好 sink 之后 `setBindings` →
  同样出现；`sink.emit = …` → `REPLACED-EMIT-RAN`。修复后三条全部不再发生，且框架
  请求日志的 method/path/requestId/statusCode 仍然正常。
- **event logger 的原始能力不再有公开出口**（Round 14）。Round 13 之后
  `createLoggingContext()` 仍然把 event 那棵树的 **raw `Logger`** 放在返回值上，
  拿到 context 的人可以直接 `context.events.setBindings(…)` 绕过 sink；
  `createEventLogSink` 也还是一个**接受任意 Logger** 的公开工厂。Round 14 把
  raw logger 关进模块词法作用域：event root 建出来立刻包成 `EventLogSink`，
  `LoggingContext` 上只有 `framework`、`eventLog` 与 `close`，
  `createEventLogSink` 不再导出。测试注入口从 `eventSink`（可以塞任意 sink）
  换成 `eventLogDestination?: Writable`（只能换目的地），因此预绑定 framework
  的集成用例走的是 **buildApp 的默认生产接线**，不是测试自己搭的一套。
- **`app.eventLog` 不可替换**（Round 14）：`decorate` 只是普通赋值，属性可写可
  配置；现在用 `Object.defineProperty` 钉成 `writable: false, configurable: false`。
  错误处理器也不读这个属性，改从**词法闭包**里取 sink——读一个可替换的属性等于把
  「谁来处理业务事件」交给任何拿得到实例的人。反例实测：直接赋值与
  `Object.defineProperty` 均失败，业务事件仍走原 sink。
- **日志关机 fail closed**（Round 14）：`close()` 先 flush **自建的**那些
  logger（event root，以及没被注入时我们自己建的 framework root），再等自有 logger
  写进去的字节排空。调用方注入的 `Logger` 我们不碰，任何 `Writable` 都**绝不
  `end`**；口径写实的部分是——flush 自有 root 时 pino 会把回调转交给**目的地自己
  的** `flush`（`lib/proto.js:253`，判据是 `typeof stream.flush === "function"`），
  所以调用方给的目的地会因此被调用一次 `flush`，它报错同样会让 `close()` 失败。
  三条失败路径全部 **reject**、不静默放行：flush 报错、flush 回调不来、目的地排空
  超时、以及 flush **同步 throw**（回调先报成功、`flush()` 随后抛，上一版把那个
  throw 整个吃掉，一次失败的 flush 报告成功）。时限只**对异步拖延有效**：同一个 JS
  线程里没有办法抢占一个不返回的同步调用，因此调用方给的 `Writable` 与它的 `flush`
  被明确定义为**受信的、合作式的**接口——死循环的 `flush` 这一层挡不住，也不为此
  引入 worker/子进程改造。能保证的是**有限**的同步阻塞会被 fail closed：同步调用
  返回之后重新量一次已用时间（用 `performance.now()`，不是 `Date.now()`），超了就
  算超时，哪怕它最终「成功」返回。重复调用拿到的是**同一个** promise，成功失败都
  一样。修复前实测：flush 报错
  → close 静默 resolve；flush 回调不来 → 用例**永不返回**（仓库的 `test:unit` 没有
  超时；加 `--test-timeout=8000` 跑才会在 8 秒后被判超时）；排空超时 → 静默
  resolve；自建的 framework root 根本不在 flush 名单里。错误消息只保留**归一化的
  错误类型名**，不带目的地的原始 message。
- **超时定时器刻意不 `unref()`**（Round 14 收尾复评）：第一版写了 `timer.unref()`。
  unref 过的定时器不 ref 事件循环，而关机正是「循环里已经没有别的 handle」的那一
  刻——avvio 的 onClose 是 LIFO，监听 socket 已关、连接池已 end、
  `process.once("SIGTERM", …)` 的监听器本身也不 ref 循环。于是超时永远不到、
  `close()` 永不 settle、进程以 **0** 退出并静默丢日志，比静默 resolve 更糟。
  这条**在 `node --test` 里测不出来**：runner 自己吊着事件循环，用例照样通过。
  因此回归改成**另起一个进程**跑
  `tests/fixtures/stalled-flush-shutdown.ts`：修复前输出 `OUTCOME=NEVER-SETTLED`
  且退出码 0，修复后输出 `OUTCOME=REJECTED`。`src/index.ts` 也补上了 `catch`——
  `void shutdown(…)` 会把这个 rejection 丢掉，最终只剩 Node 对未处理拒绝的默认
  行为；现在落成 stderr 上一行**完全固定的中性文本** `shutdown: close failed`
  （不带阶段、不带类型名、不带任何来自错误对象的东西），以及确定的非零退出码。
- **close 是 failure-safe 的阶段收集器**（Round 14 收尾追加）：上一版是一串
  `await`，第一处失败就把后面的阶段全跳过了——「event flush 报错，于是 framework
  那棵**根本没 flush**」。关机路径上这恰好是最坏的顺序：一个坏掉的目的地会连累
  另一个好的目的地一起丢日志。现在四个适用阶段（event flush →（自建时的）
  framework flush → framework drain → event drain）**每个都会跑到**，失败在最后
  一次性聚合成 `AggregateError` 抛出。阶段函数**不抛**，只返回本模块自己写的安全
  原因字符串，因此错误里在结构上就不可能出现调用方的文本。三条反例修复前全部
  失败、修复后全部通过：event flush 失败后 framework flush 仍执行
  （`framework.flushes() === 1`）；framework flush 失败后 event drain 仍执行；
  一个 drain 失败不阻断另一个 drain（两条 `did not drain` 同时出现在聚合消息里）。
- **调用方的 `Writable` 只读不写**（Round 14 收尾追加）：绝不 `end`、绝不
  `destroy`、也绝不往里写关机标记，只读 `writableLength` 等它排空。口径还要补一句
  写实的：flush **自有 root** 时 pino 会把回调转交给目的地自己的 `flush`。
- **关机契约抽成 `src/shutdown.ts`**（Round 14 定点追加）：`index.ts` 里那两段
  handler 挪进一个只依赖 `{ eventLog, close }` 的窄接口模块。这样两条失败路径
  （SIGTERM 关机失败、listen 失败后再关又失败）的 **subprocess 回归**跑的是**生产
  函数本身**而不是抄件——抄件跑绿不代表生产那份还在。两条回归都断言 stderr 恰好是
  `shutdown: close failed`、退出码 1、目的地抛出的敌意文本一个字都不出现；把
  `catch` 去掉之后两条同时失败。文案是**应用**关闭失败，不归因到日志 flush：
  `app.close()` 会跑完所有 onClose hook，连接池与插件清理同样可能失败。
- **敌意抛出物兜到固定串**（Round 14 收尾复评二）：`errorTypeOf` 自己要读输入的
  原型与属性描述符，因此一个**自指** Proxy 能让它再抛一次。三个调用点都没兜的
  后果不是少一句诊断，而是抛出来的**就是调用方的原始对象**：它穿过阶段收集器，
  close() 用调用方的值拒绝、后续阶段全被跳过。实测修复前 close 在 2ms 内以调用方
  对象拒绝（正常应 ≥2000ms），修复后 2003ms、以 `AggregateError` 拒绝、消息不含
  sentinel。统一走 `safeErrorType()`，兜底 `"UnreadableError"`。
- **`allowedErrorTypes` 改为模块私有**（第十二轮）：上一版导出的是
  `ReadonlySet<string>`，那只是类型上的只读——`(x as Set<string>).add("EVIL")` 在
  运行期照样成功。现在对外只有一个**冻结的 canonical 数组**与一个 **predicate**；
  反例实测：篡改导出的快照之后，`isAllowedErrorType("EVIL_TYPE_SENTINEL")` 仍为
  false。
- **`statusCode` 由 `errorCode` 派生**（第十二轮）：字段里根本没有它，
  `apiErrorStatus[errorCode]` 是唯一来源。反例：硬塞
  `SESSION_EXPIRED + 599` 进去，输出仍是 401；另有一条用例从
  `Object.keys(apiErrorStatus)` **动态生成**，把 contracts 里全部 **18/18** 个错误码
  逐条比对——手写样例只能证明被写下的那几个。
- **业务日志走窄化 typed facade**（第十轮建立，第十一/十二轮收口）：
  `src/log-events.ts` 定义**闭集事件**与每个事件的**显式字段**。第十一轮把参数上
  那个开放的 `Record<string, LogFieldValue>` 删掉了——它等于把「随便加一个原始
  类型字段」又放了回来。现在每个事件有**固定的 runtime projector**：逐个字段
  **按名字**取值，**不遍历** `Object.keys(fields)`，因此未声明的字段在结构上就到
  不了 payload（不是「遍历时被过滤掉」，是根本没被读过）。
- **字段是专用安全类型，不是自由字符串**（第十一轮）：`errorType` 带 brand，
  **只能**由 `eventErrorType()` 产生，运行期还要在 `allowedErrorTypes` 里验一次；
  `errorCode` 用项目真实的 `ApiErrorCode` union 并用 contracts 的 schema 验；
  `signal` 只允许 SIGINT / SIGTERM。任何一项验不过就**抛错**（fail closed），
  而不是写一个占位串。`event` 是保留字段，projector 产不出它、assemble 时它最后
  写入，调用方没有任何路径能覆盖。
- **静态门禁限制的是整项 logger capability**（第十轮建立，第十一轮扩到能力层）：
  第十轮只看 `CallExpression` 的 callee，因此 `Reflect.apply(logger.error, …)`、
  把 `LogFn` 当参数传出去的高阶转发、以及「先 `as unknown as` 擦掉类型再调用」
  三种写法都溜过去了（实测逐条 MISSED）。现在的判据是**任何类型为 `LogFn` 的
  表达式**——调用与否无关紧要，拿到了就是拿到了；`child`/`setBindings` 这类
  mutation API 只有 `logging.ts` 可以碰；组装根 `src/app.ts` 只能**传递** logger，
  一旦在它上面做成员访问就变红（实测注入 `logger.child({…})` + `audit.info(…)`
  立刻报出两条）。`tests/fixtures/log-escape-shapes.ts` 把 **23 种**写法逐条摆出来；
  第九轮那条正则扫描器仍逐字保留在测试里跑对照，它对整份 fixture 报告 **0 条违规**。
  Round 13 起 mutation API 按**成员声明身份**识别；Round 14 再把「能力被装进别的
  壳子里带出去」补齐：容器（`readonly Logger[]`）、mapped type
  （`{ [K in "setBindings"] : Logger[K] }`）、indexed access
  （`LoggingContext["framework"]`）、接口重声明（`readonly mutate: Logger["setBindings"]`）
  与解构（`const { framework } = …`）逐条命中。判据仍是**声明身份**，因此第三方
  框架类型（`FastifyRequest` 的第七个类型参数正好就是 `Logger`）不会被误报。
  组装根白名单绑的是**真实变量符号 + 声明来源 + factory initializer**，不是名字或
  类型文本；「组装根持有的容器」只认 `createLoggingContext` 与 **fastify 自己的**
  工厂这两个**声明身份**。`createLoggingContext` **这个符号本身也算能力**（拿到它
  就能凭空造一个 context，`.framework` 跟着到手），只允许出现在组装根那一次合法
  工厂调用的 callee 位置——取别名或交给别人一律报红。形参也**没有**通行证：上一版
  无条件放行「任何解析到形参的标识符」，于是
  `passthrough(logger: Logger): Logger => logger` 整条是绿的；现在形参只能作为
  **成员访问的基**出现（`options.logger` 可以）。工厂注入槽还要再钉一层：那个成员
  访问的**基**必须是组装根**自己的 options 对象**（第一个形参）——只判「是不是成员
  访问」的话，`createLoggingContext(level, app.log)` 与
  `createLoggingContext(level, foreign.logger)` 都是绿的（实测）。`logging.ts` 的
  `createLogger` 同样计入能力，而且比 `createLoggingContext` 更严：它直接返回 raw
  `Logger`，因此在两个边界文件之外**一处都不许出现**。注入槽的**基**按**声明身份**
  登记：必须解析到组装根入口函数（生产里的 `buildApp`）第一个形参的那条 parameter
  声明。上一版判的是「任何 FunctionLike 的第一个形参」——那还是形状，随手写一个
  helper，它自己的首参就成了合法注入源（`violatingNestedHelperInput` 修复前实测
  **0 report**）。收尾修订前这条写的是「initializer 是不是一个
  `CallExpression`」——**任何**调用的返回值都算，于是
  `const held = externalRelay(logging)` 之后 `held` 怎么用都放行，一个中继函数就能
  把整个 context 带出边界（实测假绿）。Round 13 的 app.ts 假绿是**手工改文件**验证
  的，跑完就没了；现在二十二种违规接线固定在
  `tests/fixtures/app-wiring-variants.ts` 里，测试把 fixture **当作组装根**喂给
  收集器，白名单从此有自动化回归。
- **logging.ts 的净化器降级为纵深防御**（第十轮起）：它不再是业务日志的安全依据，
  只覆盖 Fastify **自己**打的那几条请求日志（`incoming request`、
  `request completed`、defaultErrorLog）——那条路径绕不过 facade。因此**不再为
  「任意对象 / Proxy」增补特例**；真正的边界在类型系统那一侧。
- **请求字段在 Fastify 可信边界读、logger 只登记纯数据**（第九轮）：`app.ts` 的
  `genReqId(rawRequest)` 是 Fastify 刚把 request 交给我们、还没经过任何调用方之手
  的唯一一刻。四个字段在那里读完、物化成字符串传给 logger；`registerRequestLogFields`
  **不读任何属性、不调用任何访问器**。上一版的登记函数会去读传进来的对象，把
  `socket` 写成数据属性、`socket.remoteAddress` 写成 `net.Socket.prototype` 上的
  访问器就能拿到执行权（实测 1 次）。方向是收窄，不是继续扩展任意对象/Proxy 净化器。
- **顶层 record 只抓一次描述符快照**（第九轮）：`carriesError` 与 canonicalization
  共用同一份。分两次探测有洞——一个有状态的 Proxy 可以第一次报「没有 err」（msg
  因此不折叠）、第二次再把 `err` 交出来，产出一条**自相矛盾**的记录（带 err、配
  一条未折叠的 msg）。
- **msg 折叠不看类型**（第九轮）：`new String("…")` 的 `typeof` 是 "object"，
  上一版「只折 typeof === 'string'」的判据把它整条放过去——实测那条 msg 被拍成了
  一个逐字符的对象，秘密完整可读。现在 index 1 只要 record 带 `err` 就折。
- **生产代码不得把原始对象塞进 log record**（第九轮）：新增静态门禁
  `tests/unit/production-log-arguments.test.ts`，扫描 `src/` 里所有
  `log.<level>(` 的第一个实参，禁止裸 `request`/`reply`/`raw`/`error`/`config`/
  `secret`/`password`/`token`。生产调用点改用 `safeErrorRecord(error)`，在调用点
  就折成纯数据。扫描器自带正反两组自检。
- **err record 的显式 msg 无条件折叠**（第八轮）：上一版只在 msg 与 `err.message`
  **逐字相同**时才折。那条判据可以靠包装一层、截一段、加个前缀绕开，而携带的仍
  然是同一段内部细节（实测 sentinel 直接进日志流）。现在判据只有一条——这条记录
  带不带 `err`。代价是明确的：`log.error({ err }, "API startup failed")` 这类
  调用方自己写的 msg 也会变成固定串，诊断信息改从 `err.type` 走；不带 `err` 的
  普通日志完全不受影响。
- **子 logger 一律不得自带 `redact`**（第八轮）：包装 censor 不够——路径语义本身
  就决定了哪些键会走 pino 的克隆式 redactor。根 logger 的 `redact` 第七轮已移除，
  子 logger 这一侧第八轮整条拒绝。Fastify 只会把 `serializers` 再传一遍
  （`lib/logger-pino.js`），从不传 `redact`，兼容面不受影响。
- **敏感键名单的口径（不夸大）**：它是一份人工维护的名单，只对**已登记的键族**
  提供纵深防御，**不**声称对任意第三方键或中性键（`traceContext`、`correlation`
  之类）里的 Secret 有任何兜底——那类取值在键名上看不出线索，靠黑名单补不完
  （第十一轮就是被裸的 `apiKey` 抓出来的）。业务日志的安全性**不依赖**它：业务
  代码只持有 `EventLogSink`，binding 根本挂不上去。它覆盖的是 Fastify 框架自己
  打的请求日志那条绕不过 facade 的路径。
- **归一化之后的敏感键名**（第八轮）：`isSensitiveKey` 先去分隔符再小写，所以名单
  里原来写的 `"set-cookie"` 归一化成 `setcookie`，**永远匹配不上自己**——一条从来
  没生效过的规则。同时补上 `rawTrailers`（与 `rawHeaders` 一样是扁平字符串数组）。
- **请求身份是登记点的不可变快照，不是读取权限**（第八轮）：上一版导出的是一个
  公开 registrar，任何人都能登记任意对象，之后投影会在它身上做普通成员读取。实测
  把 `socket` 写成数据属性、`socket.remoteAddress` 写成访问器，登记之后那个 getter
  会被执行。现在 `genReqId` 一次性把 requestId/method/path/remoteAddress 冻结成
  快照，serializer **只查快照、不碰候选对象**。
- **平台访问器只认函数身份**（第八轮）：`DOMException.prototype` 是可变的，只检查
  「持有者是那个原型」就调用当时解析出来的 getter，等于把执行权交给任何能改写它
  的人（实测改写后 getter 被执行）。现在比对的是模块加载时抓下来的**原始函数
  引用**，`net.Socket.prototype.remoteAddress` 同理。
- **descriptor-safe 读取推到每一个入口**（第七轮）：数组**下标**也按描述符读
  （`Object.defineProperty(a, 0, { get })` 是合法的，`a[0]` 会把它执行掉）；
  `Error.name` 与伪造归一化形状的 `type` 沿**原型链**解析描述符，自身访问器、
  子类原型上的继承访问器、解析不出数据属性——一律降级为 `Error`（`TypeError`
  这类内建类型仍然保留，因为它们的 `name` 是原型上的数据属性）；
  `req`/`res` 的 serializer 豁免不再只看键名：只有经 `genReqId` 登记过原始
  `IncomingMessage` 的**真 Fastify 对象**才拿得到，伪造对象走「只读数据属性」的
  安全投影。实测（fastify 5.10.0）真实 Request 的 `method`/`url`/`ip`/`socket`
  都是原型访问器，因此这条区分是必要的：既不能对伪造对象执行它们，也不能因为
  收紧而把真实请求日志掏空。Fastify 的 defaultErrorLog 会把 `error.message`
  **显式**当 msg 传进来，那条路径也补上了。
- **allowlist 防漂移是静态测试，不是注释里的承诺**：
  `tests/unit/error-type-allowlist.test.ts` 直接扫 `src/` 的
  `this.name = "X"` 与 `class X extends Error`，任何未登记的错误类都会让门禁变
  红。第六轮就是这么漏掉 `Stage06ManifestError` 的——它一直被折成 `Error`，而
  没有任何用例会失败。
- **保证的边界（不夸大）**：这一层保证的是「**不读取访问器**」，不是「绝不执行
  任何调用方代码」。`Proxy` 会让 `Object.keys`、`getOwnPropertyDescriptor`、
  `getPrototypeOf`（`instanceof` 用它）各自触发 trap，`Array.isArray` 对包着数组
  的 Proxy 也返回 true；那是 JavaScript 语言层面的性质。trap 的返回值仍然要走同
  一套描述符规则与文本脱敏。
- **递归深度也有硬上界**（第八轮）：`seen` 只挡得住环，挡不住深度——一条 5000 层
  的普通嵌套链就能让一次日志调用把进程的栈耗光（实测
  `RangeError: Maximum call stack size exceeded`）。canonicalizer 现在到 64 层
  换成固定占位串；`req`/`res` 的快照查找链另有 4 跳上界（真实形状最多两跳）。
- **原型污染那条路径已经堵上**：canonicalizer 新建的 `{}` / `[]` 仍然继承
  `Object.prototype` / `Array.prototype`，只要有人（包括 Proxy 的 `ownKeys` trap
  在我们枚举的过程中）往那上面挂一个 `toJSON`，`JSON.stringify` 阶段就会调用它，
  把整棵已经脱敏干净的树换成一句返回值——实测泄漏过完整连接串。现在每个新建容器
  都带一条不可枚举的自身 `toJSON: undefined` 遮蔽。
  同时**移除了根 logger 的 `redact` 选项**：它的路径要么已被固定 serializer 的
  4 字段投影覆盖（`req.headers.*`），要么已被 canonicalizer 的任意深度键名脱敏
  覆盖（`*.authorization` 等），而 `@pinojs/redact` 会先做一次**选择性克隆**再
  序列化克隆体，克隆体带不上上面那条遮蔽；又因为存在 `*` 通配路径，pino 会把
  **每一个键**都送进这个 redactor。去掉之后遮蔽才真正生效。子 logger **也不能**
  把它带回来：第八轮起 `hardenChildOptions` 见到 `redact` 直接抛错，不再按形态
  包装 censor。
- **仍然成立的残余**：Proxy 的 trap 返回一段普通字符串时，它就是普通数据——除了
  连接串/conninfo 的文本规则与键名规则之外没有别的过滤。这与任何调用方直接传一段
  文本进来是同一件事，不是脱敏漏洞。
- **全部响应**统一携带 `Cache-Control: no-store` 与
  `X-Content-Type-Options: nosniff`（挂在唯一公共出口 `onSend` 上），且不存在
  任何 `Access-Control-Allow-Origin`；liveness、readiness、登录、家庭私有成功
  与 validation/404 problem 响应逐条实测。
- **静态门禁的变异反向测试**：新增
  `infra/docker/check-compose-topology-mutations.mjs`，**M3A 当时的 15 项变异全部以
  指定理由被捕获、0 漏网**；第五轮架构修订后的当前门禁为 22/22，并且只变异
  仓库外临时副本。

**M3A 的边界（不得写成 Pass）**：这一轮只覆盖**代码侧的消费能力**。
`infra/environments/` 模板、八份 Secret 的生成与交叉一致性预检、database name
与三个 URL/pgpass 的部署级一致性、完整 Compose bootstrap 链
（`0000 → handoff → acl → migrate → grants`）与 `/readyz=200` 实证、容器级
sentinel 扫描，以及宿主全部非 loopback 地址的动态隔离证明，**都属于 M3B**
（**当时状态：尚未取得运行证据**；这些证据现已由 M3B 取得，状态为
M3B 已于 2026-08-11 Accepted，验收落点 `cf43452`，见本文档的 M3B 段）。
M4 已于 2026-08-11 Accepted（验收落点 `f671c51`）；M5 第九轮候选 `4a72218` 的两路
独立审计仍为 BLOCK，第十轮实现落点 `3849bbd` 与文档候选 `a8ad0b2` 已从头通过
完整聚合门禁 14/14；仍须全新 A/B 独立只读复审，M5 仍未 Accepted。

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

**M2B 实际交付的**（总控 **Accepted**，验收落点 `d0f2219`）

- **拓扑**：[`infra/docker/compose.local-test.yaml`](../infra/docker/compose.local-test.yaml)
  共十个服务——`postgres`、七个只能显式调用的 `bootstrap-*` 一次性任务、
  `migrate` 与 `api`。默认 profile **恰好**是 `postgres`/`migrate`/`api`，因此
  `docker compose up` 与任何普通重启都不会再次执行 bootstrap（实测：重启
  `postgres` 之后项目内仍然只有一个容器）。说明见
  [`infra/docker/README.md`](../infra/docker/README.md)。
- **bootstrap 拆成七个容器而不是一个**：M2A 的安装顺序在 `bootstrap.sh`（psql）
  与 `db:bootstrap`（Node）之间来回切换，单个 bootstrap 容器必须同时具备 Node
  与 psql。本轮**不**为此构建混合高权限镜像，而是让每个阶段用现成镜像各起一个
  一次性容器，由 `depends_on: service_completed_successfully` 固定顺序；恢复路径
  （M4）因此可以只复用其中的 `cluster` / `logins` / `acl`。
- **PostgreSQL 镜像固定**：exact tag `18.4-bookworm` + OCI image index digest
  `sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296`，由
  `docker buildx imagetools inspect` **解析真实镜像仓库**取得，不是猜测、搜索
  结果或本地未推送镜像的 RepoDigest。index 内含 `linux/amd64`
  （`sha256:16fa100a…`）与 `linux/arm64/v8`（`sha256:5803d5d7…`）。容器内
  `createdb`/`initdb`/`pg_ctl`/`postgres`/`psql` 五个 banner 与
  `current_setting('server_version')` 全部为 **18.4**。
- **数据库无 host 端口**（实测）：`docker inspect` 的 `HostConfig.PortBindings`
  为 `{}`，`NetworkSettings.Ports` 为 `{"5432/tcp":null}`——只 expose、未
  publish；宿主没有 5432 监听套接字。数据库落在 named volume 上，**没有**任何
  宿主目录 bind mount。
- **postgres 真实达到 healthy**（实测）：在 `read_only` 根文件系统、
  `user 999:999`、`cap_drop: [ALL]`、`no-new-privileges` 与 `internal: true`
  网络下 6 秒内 healthy，重启后 6 秒再次 healthy；TCP 与 local 登录都强制
  `scram-sha-256`，`pg_authid` 中持有 `SCRAM-SHA-256$` verifier。
- **API 只绑定 IPv4 loopback**（实测）：容器的 `HostConfig.PortBindings` 恰好是
  `{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"3000"}]}`。用**同一个 api
  服务定义**（`--service-ports`）跑一个最小 HTTP listener 时，宿主只出现
  **一个** `TCP 127.0.0.1:3000 (LISTEN)` 套接字：`127.0.0.1:3000` 返回 200，
  `[::1]:3000` 与宿主 LAN 地址均连接失败。（本机另有一个 TUN 接口对**任意**
  端口都返回 empty reply，对照未占用端口结果逐字相同，且该地址上没有任何监听
  进程，因此与本拓扑无关。）针对真实 API 进程的动态非 loopback 门禁属于 M3。
- **容器逃逸面**（实测 + 静态断言）：全拓扑无 privileged、无
  `network_mode: host`、无 host pid/ipc/uts/cgroup/userns、无 Docker socket、
  无数据库 bind mount。全拓扑只有**两类只读仓库 bind**：M2A 的 bootstrap 资产
  目录，以及**仅 `bootstrap-handoff` 可见**的那一个 exact `0000` 文件；数据库
  数据落在 named volume 上，没有任何 host bind。
  统一 `read_only` 根文件系统、`cap_drop: [ALL]`、`cap_add` 为空、
  `no-new-privileges:true`、非 root 用户、`restart: "no"` 与有界 json-file 日志
  轮转。API 镜像仍是 `10001:10001`，M2B 不修改已 Accepted 的 Dockerfile。
- **静态门禁**：[`infra/docker/check-compose-topology.mjs`](../infra/docker/check-compose-topology.mjs)
  断言 `docker compose config` **解析后**的配置。它自身经过**当时的** 16 项变异测试（M2B 期针对 `check-compose-topology.mjs` 的临时演练，不是现在常设的 15 项门禁）——
  数据库发布端口、未限定的 `3000:3000`、明文连接串、明文口令、privileged、
  `network_mode: host`、Docker socket、丢失 digest、bootstrap 脱离 profile、
  api 不再等待 migration、数据库改成 bind mount、`internal` 丢失、加回
  capability、healthcheck 依赖 curl、root 用户、日志失去轮转——**当时的 16 项全部被
  捕获，0 项漏网**。Docker CLI 缺失时它以「缺少前置工具」失败退出，不降级成
  纯文本检查后宣称通过。已并入 M5 的 `pnpm stage09a:check`。
- **Compose 中没有凭据**：解析后的配置与 `docker inspect` 的 `Config.Env` 里
  都不存在口令或完整连接串，只有 secret file 路径。`POSTGRES_PASSWORD_FILE` 与
  `PGPASSFILE` 走镜像与 libpq 自带能力；`DATABASE_URL_FILE` 与
  `MEAL_AGENT_*_PASSWORD_FILE` 在 M2B 是**声明**的契约，已由 M3A 真正实现消费。
- **凭据按最小权限分配**（静态断言，逐条固定每个服务的 secret 集合）：`api` 只
  拿 runtime 连接串，`migrate` 只拿 migration 连接串，`bootstrap-schema` 只拿
  admin 连接串，`bootstrap-logins` 是唯一接触三个登录口令的服务。api 一旦被塞进
  admin / migration / backup 凭据，门禁立即失败（已用两次变异实测）——对应阶段
  09A 验收门禁第 4 条「API runtime 不持有 bootstrap/migration 凭据」。

**M2B 首轮总控复核 Not Accepted 后的定点修订**（修订后已由总控 **Accepted**，
验收落点 `d0f2219`）

- **handoff 的真实挂载阻断已修**：`bootstrap.sh handoff` 固定按
  `${script_directory}/../../../services/api/migrations/0000_stage_06.sql` 求冻结
  `0000` 的磁盘 sha256，容器内即 `/services/api/migrations/0000_stage_06.sql`；
  首轮只挂了 `/opt/meal-agent/bootstrap`，该文件根本不存在。现在**只给
  `bootstrap-handoff`** 追加这**一个文件**的只读 bind，并在同一处重述 anchor 的
  bootstrap 挂载（服务级 `volumes` 会整体覆盖 anchor，不做深合并）。实测：容器内
  按同一相对路径解析得到的 sha256 与宿主一致
  （`6db9bdac…b27a`），写入被只读文件系统拒绝，`/services/api/migrations/` 内只有
  这 1 个文件；`bootstrap-acl` 看不到它；真实 `bootstrap.sh handoff` 已越过文件
  检查，止于数据库层（凭据待 M3）。
- **数据库 identity 暂时固定**：`createdb`/`handoff`/`acl`/`grants` 的数据库名
  一律是字面量 `meal_agent`，不再有 `MEAL_AGENT_DATABASE` 插值；`createdb` 的
  argv 精确固定并用 `--` 结束选项解析。门禁用三个投毒值重解析配置并要求输出
  逐字节不变——修订前 `MEAL_AGENT_DATABASE=--host=evil` 会把参数变成
  `["acl","--dbname","--host=evil"]`。数据库名可配置能力归 M3（届时先由统一配置
  schema 校验 `^meal_agent(_[a-z0-9_]+)?$` 与 63 字节上限，再同时生成 URL 与
  Compose 参数）。
- **静态门禁加固**：十个服务的 image/user/profile/entrypoint/command/networks/
  挂载/depends_on/environment **逐项固定**；三个 API 镜像服务必须声明 build（缺失
  即失败，不再 `continue`）；secret 检查升级为 source + target + 对应
  `*_FILE`/`PGPASSFILE` 路径的**精确映射**；仓库内判断改用 `path.relative` 而非
  裸 `startsWith`（相邻同前缀目录不再能绕过）；`git ls-files` 非零退出不再被当作
  「未跟踪」静默通过，仓库外 secret 目录作为显式分支处理。
- **worktree 资源隔离**：删除 network 与 volume 的显式全局 `name`，改由 Compose
  project scope 命名，`--project-name`/`-p` 可覆盖。门禁用两个 project name 解析
  配置并要求 network 与 volume 的真实名称无交集。
- **顶层 secret / 挂载 / tmpfs 的机械收口**：八个顶层 secret 的
  name → 文件名映射逐项固定（只有 `postgres_admin_pgpass` 对应
  `postgres_admin.pgpass`），解析后的绝对路径必须等于 effective secret 目录 +
  期望文件名，默认目录与 `MEAL_AGENT_SECRETS_DIR` 覆盖两条路径都校验且**只比
  路径、不读内容**；顶层 `networks`/`volumes`/`secrets` 键集合逐项固定；每个
  服务的 tmpfs 进入 expectation；bind 与 volume **都**比较 `read_only`，数据卷
  被改成只读会被发现。其中「新增一个没人引用的顶层声明」是**唯一**从 Compose
  源文本判定的一条——`docker compose config` 会把未被引用的顶层
  network/volume/secret 直接裁掉（`--no-normalize` 同样如此），解析后的配置对它
  结构性失明，脚本里对此有显式注释。
- **当时的变异测试 41 项全部以指定理由捕获、0 漏网**（27 项回归 + 14 项本轮新增；
  同为 M2B 期计数，现在常设的门禁是 `check-compose-topology-mutations.mjs` 的 15 项），
  含总控先后点名的九项：删除 API build、修改 `bootstrap-acl` command、交换
  API/migrate 的 `DATABASE_URL_FILE`、删除或扩大 handoff 的 `0000` 挂载、
  bind source 指向与仓库同前缀的相邻目录、把 runtime 连接串指向 admin 文件、
  数据卷改成只读、删除 `/var/run/postgresql` tmpfs、修改该 tmpfs 的
  mode/uid/gid。

**M2B 的边界（Accepted 只覆盖拓扑本身）**：M2B 落地时 `services/api/src/config.ts`
只接受 `DATABASE_URL`、`infra/docker/postgres/bootstrap.sh` 只接受
`MEAL_AGENT_*_PASSWORD` 三个 environment value，因此 `api`、`migrate`、
`bootstrap-schema` 与 `bootstrap-logins` 当时必然 fail closed（实测：`api` 容器
以 `DATABASE_URL` 缺失的 `ZodError` 退出）。**M3A 之后这四个服务的 `_FILE`
契约已被真正消费**；**M3B 已取得
`postgres → cluster → logins → createdb → 0000 → handoff → acl →
migrate → grants → api` 的整链运行证据（已于 2026-08-11 Accepted，验收落点
`cf43452`，见下方 M3B 段）**。备份恢复（M4，Accepted `f671c51`）与阶段聚合门禁
（M5 的 `pnpm stage09a:check`，本地全绿）也已取得运行证据；**09A 总验收未完成**，
阶段仍不得记为 Pass。

**证据边界**：数据库身份与授权这条线，R8B 之后已经同时覆盖**观察、策略判断与
收敛**三层——canonical projector 采集事实，可移植策略判定允许项，收敛按真实
grantor 执行并由只读断言复验（R8A 当时只交付其中的观察层）。M2B 之后，Compose
拓扑、镜像固定、端口发布与容器隔离已有实测证据。M3A 之后，secret file 的读取判据、部署暴露级别、endpoint 收紧、中央脱敏与响应
安全头也有了单元/HTTP 级证据。M3B 之后，环境模板、八份 Secret 的生成与交叉
一致性、完整 bootstrap 链、`/healthz`/`/readyz`、runtime 最小权限、Secret
containment 扫描与动态网络隔离也有了真实 Compose 运行证据（已于
2026-08-11 Accepted，验收落点 `cf43452`）。M4 之后，停止/重启持久化与备份恢复
也有了演练证据（Accepted，验收落点 `f671c51`）。M5 之后，`pnpm stage09a:check`
把上述全部门禁与演练串成一条命令并已本地全绿，另新增 API runtime image 依赖
扫描及其变异反例。仍然**未覆盖**的是：远端 CI 真实 run 与 09A 总验收。

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

- 阶段 09A 状态：**In Progress**。M1、M2A、M2B、M3A、M3B 与 M4 已 Accepted（各验收落点见上表）；**M5 当前不可变证据协议候选已从头通过完整 14/14，仍待两个全新 A/B 独立只读审计，未 Accepted**。GitHub Actions 复用同一命令（无真实远端 run，只登记已配置）、依赖例外保持 9 条并修复新披露的 nanoid 公告（到期 2026-11-08，见 ADR-0004）。本轮受控修改了 M2B/M3B/M4 基础设施，不能声称冻结面零改动。ADR-0005 已凭既有真实容器证据转 `Accepted`；ADR-0006 保持 `Proposed`；09A 总验收未完成，阶段 09A 未标记完成。PR #1 保持 Draft。
- 当前实现落点：`services/api/Dockerfile` + 根 `.dockerignore`（Node 24.18.0 固定 digest、非 root `10001:10001`、runtime 无包管理器/客户端依赖）；`infra/docker/postgres/` 的 cluster/database 两作用域 bootstrap（六个项目角色、SCRAM 口令、owner 交接、ACL 基线、备份只读补授）；`db:bootstrap` 与 `db:migrate` 两个零参数运维入口；`infra/docker/compose.local-test.yaml` 的 local-test Compose 拓扑与 `infra/docker/check-compose-topology.mjs` 的解析后配置静态门禁（另有 `infra/docker/check-compose-topology-mutations.mjs` 的变异反向测试）；`services/api/src/config-source.ts` 与 `infra/docker/postgres/secret-source.sh` 这一对按条对齐的 Secret 来源解析器。M3B 新增（已于 2026-08-11 Accepted）：`infra/docker/local-test-secrets-contract.mjs`（八份 Secret 的唯一事实源）、`generate-local-test-secrets.mjs` / `preflight-local-test-secrets.mjs`（单一来源生成与部署前交叉一致性预检）、`probe-compose-secret-identity.mjs`（Compose Secret 容器内 UID/mode 探针）、`run-local-test-smoke.mjs` + `local-test-containment.mjs`（完整 fresh 链 smoke、containment 扫描与动态网络隔离）、`check-local-test-negatives.mjs`（75 cases：1 个正向 baseline + 74 个反例/边界检查）、`check-m3b-round2-negatives.mjs`（M3B targeted negative suite，69 cases）、`check-m3b-signal-windows.mjs`（M3B Accepted 时为 5 个确定性进程组回归 + 5 个真实信号窗口；当前 M5 第七轮门禁为 5 + 6）、`m3b-docker.mjs` / `m3b-subprocess.mjs`（唯一 image tag、fail-closed Docker 证据、异步 spawn 与信号处置）、`m3b-safe-output.mjs`（门禁输出边界）、`fixtures/preflight-signal-window.mjs`（preflight 信号窗口测试夹具）与 `infra/environments/local-test/` 配置模板。
- **两个固定 manifest + 一份动态只读 projector**。前两者是**冻结的期望值**，逐字节
  受 `manifest:check` 约束；第三者是对**当前环境**的动态观察，不含任何期望值，也
  不得被冻结成跨 cluster 快照。①冻结 `0000` 的对象与安全属性投影：`services/api/src/database/stage06-manifest.ts`，**408 条规范化行**，覆盖 database/schema 归属、relation、**每一列**、index、constraint、routine、policy、**managed schema 内的用户 type**（当前 10 条**全部是每张表的数组类型**，**不含行类型**：投影排除 `typrelid` 指向真实 relation 的行类型，而 `0000` 没有建 shell/base/enum/domain；`pg_catalog` 等系统 schema 不在范围内）、trigger、**外键内部 constraint trigger 的启用状态**、rule，以及 operator/opclass/opfamily/collation/conversion/统计/文本搜索/extension 等明确 namespace 类别。owner handoff 的阶段由**整组 owner** 判定：整组未交接或整组属于 migrator 才合法，任何混合态直接拒绝。投影在事务内固定 `search_path` 与 `quote_all_identifiers`，并在块结束时**显式还原**（`set_config(..., true)` 只在事务结束时恢复，不会在 DO 结束时恢复）。**对象 catalog 基线绑定 PostgreSQL 18.4**，patch 升级必须重新 capture 与 rebaseline。②**ledger 感知的授权 manifest**：`services/api/src/database/authorization-manifest.ts`，按 `(ledger, phase)` 登记 4 个状态、**408 条规范化行**（manifest 版本 2；`grant` 138、`effective` 138、`default-effective` 78、`routine` 40、`default` 14），只登记**固定允许项**：固定授权、`pg_default_acl` 的**物理行**、叠加后的**有效**默认权限、`has_*_privilege` 有效权限，以及受控 routine 的 identity/owner/`SECURITY DEFINER`/`proconfig`（结构化 JSON）/正文摘要；未登记的 `(ledger, phase)` fail closed。canonical digest 覆盖全部顶层字段（version、principals、managedSchemas、deniedRoutines、states）。③**canonical projector**：`services/api/src/database/authorization-projection-sql.ts`。它被拆成「可复用的结构化 projector CTE renderer」与「对外三列只读 SELECT」两层；R8B 起前者同时供给 verify 与 converge，后者仍是不被任何 bootstrap 阶段加载的只读观察出口。可移植策略在 `authorization-policy-sql.ts`。**四个** generated adapter 由只读 `manifest:check` 逐字节校验，真实 PostgreSQL 18.4 上还做 catalog↔manifest 逐行 parity，两个入口对同一批漂移给出逐字相同的拒绝理由。
- **恢复/安装流程分为两个阶段**：`bootstrap.sh acl` 是 containment（migration 之前 / `pg_restore` 之后收敛，刻意不给备份角色表级 `SELECT`），`bootstrap.sh grants` 是 final（migration 之后建立最终 ACL，并**同时**验证 PUBLIC、app、backup 与三个 login）。两个阶段执行同一段生成的收敛块：按真实 grantor 撤销一切不在 manifest 内的授权（含 grant option 与列级授权），再只重建允许项，后验同时比对 catalog ACL 与 `has_*_privilege` 有效权限。
- 产品声明禁用 Large Object，收敛口径与上面的「Large Object 的口径」完全一致：**只有在目标库确实零真实 LO 时**，收敛才把 `pg_default_acl` 中 `defaclobjtype='L'` 的多余默认权限收敛为空，并收回 `pg_catalog` 中 20 个 LO 入口点（`lo_create`/`lo_creat`/`lo_from_bytea`/`lo_put`/`lo_import` …）上除函数 owner 之外的 `EXECUTE`；runtime login 与 backup 的真实反向测试证明创建入口已关闭。一旦库里存在**任意**真实 LO 对象，两个阶段都在**任何 ACL / default ACL mutation 之前** fail closed，只报告 OID 与 owner——**绝不修改它的 `lomacl`**、绝不改归属、绝不改数据、绝不解除链接，LO 的 OID 也不进入任何固定允许 manifest。`meal_agent_private` 的受控 routine 按 identity 精确匹配，没有 schema 级通配豁免。
- 恢复的**受支持 ledger 窗口至少覆盖 N-1**：窗口内每个已发布 ledger 都必须保留对应的 containment manifest 状态；该约束已同步进阶段 09A 计划的 M4 与验收门禁第 14 条。当前只有一个 ledger，因此 M4 验证的是同一 ledger 的 round-trip。
- 计划分支：`claude/stage-09a-api-container-baseline-9f286c`（PR #1，保持 Draft）。M3A、M3B、M4 的基线与 Accepted 落点见上表。M5 在 `claude/stage-09a-m5-gates` 上实施，基线 `5281482`；当前不可变证据协议候选已从头通过完整 14/14，仍待两个全新 A/B 独立只读审计，未 Accepted。
- 当前目标只覆盖本地/私有测试部署包；腾讯云广州仅为未来阶段 09B 的默认候选，没有创建或购买任何云资源。
- API 已有 health/readiness、迁移校验和 production 拒绝 fake adapter。Dockerfile、数据库身份隔离、local-test Compose 拓扑与 Secret file 消费能力已实现（M2B 与 M3A 均已 Accepted，M3A 验收落点 `a839df1`）；环境模板、八份 Secret、完整 bootstrap 链、`/healthz=200`/`/readyz=200`、containment 扫描与网络隔离实证已由 M3B 交付（已于 2026-08-11 Accepted，验收落点 `cf43452`）；停止/重启持久化与备份恢复证据已由 M4 交付（Accepted，验收落点 `f671c51`）。阶段聚合门禁 `pnpm stage09a:check` 已由 M5 交付；Round 12 cycle 1 整改候选已从头通过完整 14/14，仍缺新的独立 A/B 复审、远端 CI 真实 run 与 09A 总验收。
- 总控机器现已具备 Docker（Engine 29.6.2 / Compose v5.3.1）与 PostgreSQL 18.4；容器构建、隔离 smoke test 与真实 PostgreSQL 18 权限测试均已本地执行。阶段 09A 仍未记录为 Pass。
- GitHub `origin` 与 `main` upstream 已配置，仓库已有 CI workflow；当前只确认配置存在，没有在本次规划中读取或伪造远端 run Pass。

**M3B 实际交付的**（已于 2026-08-11 Accepted，验收落点 `cf43452`；详见
[阶段 09A 计划的 M3B 实施记录](plans/2026-07-stage-09a-local-deployability-baseline.md)）：

- **Compose Secret 的容器内 UID/mode 证据先行**：八份真实 Compose Secret 挂进
  各自消费服务后，在容器内实测 owner==消费进程 EUID（999/10001）、mode 0600、
  普通文件、nlink=1、非 symlink、可读（`probe-compose-secret-identity.mjs`，
  宿主 stat 不作数）。M3A 的 fail-closed 文件判据因此在真实 Compose Secret 上
  成立。
- **八份 Secret 单一来源**：只生成四个原始 CSPRNG 口令（48 字符 `[A-Za-z0-9]`，
  URL/pgpass 双安全），八个文件由 `local-test-secrets-contract.mjs` 的同一份
  常量派生（host=postgres、port=5432、database=meal_agent、migration/runtime
  用户名带 `_login`；pgpass 只覆盖两个精确 endpoint）。generator 与 preflight
  共用该事实源；目录 0700、文件 0600、默认拒绝覆盖、failure-safe；口令不进
  stdout/argv/环境变量/Git。
- **部署前交叉一致性预检 fail closed**：文件形态（缺失/未知/symlink/hardlink/
  弱权限/错属主/多行/CR/NUL/BOM/非法 UTF-8/超限/空）、URL 与 pgpass 的
  identity 精确匹配与口令逐字节一致（canonical 全等兜底）、四口令互异、
  Git 跟踪与 tracked 模板扫描。
- **完整 fresh Compose 链**：唯一 project name、全新 volume、临时合成 Secret、
  随机 host port；十步链全部 exit=0/healthy，退出码由 `docker inspect` 独立
  读取；migrate 与 grants 二次运行幂等；`/healthz=200`、`/readyz=200`；
  ledger 精确 `0000—0004`、owner/RLS/角色属性/runtime 最小权限/readiness
  连接身份/逐服务 secret 可见面逐项断言。
- **containment 扫描与动态网络隔离**：18 条随机 needle + scanner sentinel
  先自检再扫 config/inspect/image history/logs/tracked files/transcript 零命
  中；`::1` 与宿主全部非 loopback 地址逐一失败（Docker Desktop 自有
  accept-all utun 以对照端口取证并按 HTTP 层判定）；postgres 零
  PublishedPort；api 单一 `127.0.0.1` binding；scoped cleanup 零残留。
- **Round 17 总控双审计阻断整改（历史记录）**：当时声称 `XPASS-WORD` scanner
  回退与 ambient
  Git repository-view override 与 canonical index 零覆盖在 tracked template、全仓
  containment、Compose topology 三条生产路径统一 fail closed；container/image
  inspect 与结构化 history 的空、截断、错 identity 成功输出不得物化成证据；scoped
  cleanup residue、非法返回或异常都会在第二次进程组 sweep 后固定 exit 1，不再
  伪装成正常信号退出。随后对 `9995212` 的两路独立复验再次给出 **BLOCK**，证明
  这些结论只覆盖了浅层形态，不能当作当前验收结论。
- **Round 18 定点整改候选（历史记录）**：当时把 scanner 的 prefix/suffix × 标点/
  下划线 split-stem、Git replace-object view、Docker evidence 与最终 self-signal 原语
  作为收口面，并用 42 个 collector 向量与 54 个 targeted cases 取证。
  `08da379` 的两路独立复验随后再次给出 **BLOCK**：nested/prose/comment 视图仍可漏掉
  split-stem，failed logs 仍被物化，image Config 深层 shape 与空 resolved Compose
  config 仍可形成假证据，第二次进程组 sweep 也不是 mutation-closed。因此 Round 18
  的全绿结论只能作为当时证据，不能作为当前验收结论。
- **Round 19 定点整改候选**：split-stem 判据复用到 nested/quoted/prose/comment 视图，
  slash-crossing 凭据与 URL/path/Markdown 对照分开裁决；collector 对 image Config
  的 `Env`/`Cmd`/可选 `Entrypoint` 深层 shape、失败 logs 与 resolved Compose config
  的非空成功证据 fail closed，坏证据不再计入已扫描 artifact；51 个唯一 collector
  向量与 5 个 resolved-config 向量钉住固定理由、精确 argv 与零原始输出回显。受控
  进程组反复收敛到连续两个空快照，有上限且越界固定失败，新增 mutation-closed
  确定性回归。`check-compose-topology.mjs` 的 canonical Git 修订仍只是 Round 18 的
  受控 M2B 例外，本轮没有再次扩大冻结例外。M3B 仍须由同样两路只读审计复验，
  未标记 Accepted。
- **Round 20 定点整改候选**：`c8d7236` 经项目总控第一阶段只读裁定为 **BLOCK**，
  两项确认级发现都是 `08da379` 即已存在、Round 19 未闭合的历史缺口，不是新回退。
  P1：crossing 判据在 compact 路径、键/`=` 之间的 gap 文法在 legacy 路径，**两个
  维度各自完备而交叉处零覆盖**，`NOTES=XPA-SSWORD =<value>` 在 nested/quoted/
  whole-comment/inline-comment/prose 五个视图共 140 格全漏；修复是让 compact 逆扫
  先吃掉一段有界 ASCII 水平间隔（上界复用 `readAssignmentGap` 的
  `maximumAssignmentGap`，只认 SPACE/TAB，且**只在 crossing 判据下开启**，否则
  注释体那条通路会把 `` # - `POSTGRES_PASSWORD` = 数据库密码 `` 这类注册散文
  写法判成赋值）。P2：外层 closing quote 的空占位规则只写在 compact 路径上，
  `OUTER="PASS_WORD="` 被误报而 `OUTER="XPA-SSWORD="` 干净；修复是把同一条规则
  搬到 legacy 分支。targeted suite 从 58 精确增加到 **60**（新增 crossing × gap
  与 quoted 空占位两条注册 case）。**新登记不修**：run 以复合运算符结尾时
  `compoundOperatorTail` 短路，`XPA-SSWORD>=v` / `XPA-SSWORD+=v` 在非 active 视图
  仍不命中——它与保护 `# POSTGRES_PASSWORD >= 32 chars`、`# keys += 1` 的规则
  结构性耦合，已把该 84 行钉成当前行为。本轮**零跨冻结例外**。M3B 仍须由同样两路
  独立只读审计对新 SHA 重新给出结论，未标记 Accepted。
- **Round 21 定点整改候选**：`f9997b0` 经两路独立审计与项目总控**三方同指**判为
  **BLOCK**，且是**新回退**。Round 20 把外层 closing quote 空占位规则搬到 legacy
  路径时，**连同 compact 那个未验证的假设一起搬了**——只验证「键前面是引号」，
  没有证明那是本赋值的**开**引号。键 run 往前扫到 空白/`=`/`"`/`'` 为止，停下的
  引号完全可能是**上一段取值的闭引号**，此时 `=` 后面那个引号是一段真实非空取值的
  开引号，却被判成空占位：`# psql "dbname=meal"PGPASSWORD="<值>"` 整行零 problem，
  实测净新增 **280 格**漏检，方向为 **fail-open**。修复是抽出两条路径**共用的**
  `closesEnclosingQuotedValue`，用两条各自具备判别力的判据证明它确实是本赋值的
  开引号：① 必须是这段文本里同种引号的**第一个**（比奇偶更严——奇偶证明不了配对
  关系没有被外层包装引号移位）；② 闭合引号之后只允许输入结束 / ASCII 水平空白 /
  `#`。同轮另处理两个裁定项：crossing gap 反向吸收把包装标点吞进键，导致
  `` - `API_KEY` = 说明 `` 这类**本仓库在用的**文档写法误报（选择收窄——吸收间隔
  时要求间隔左边仍是键字符）；gap 越界得到空 key 就静默放行（选择 fail closed——
  取值非空且整段文本跨过敏感边界时转红，不无条件转红以免把空占位一起判成命中）。
  targeted suite 从 60 精确增加到 **64**，四条新 case 全部经**变异判别力验证**
  （删除对应生产校验后以指定理由转红，非未捕获异常）。**新登记取舍**：同一段文本
  里第二个同种引号包裹的空占位会被判成非空，方向 fail closed。本轮**零跨冻结
  例外**。M3B 仍须由同样两路独立只读审计对新 SHA 重新给出结论，未标记 Accepted。
- **Round 22 定点整改候选**：`77d5997` 经两路独立审计与项目总控三方复核判为
  **BLOCK**（2 项确认级 P1）。**F1（区间内新回退）**：`70476a6` 的 wrapper 守卫把
  字符类写成 ASCII-only `[A-Za-z0-9_]`，而本文件对 identifier 的定义是
  `\p{L}\p{N}_`；于是 Node 真实会建立的活键（`PASSWORD密码`/`PASSWORDé`/
  `PASSWORD٣`/`PASSWORDд`）一旦键与 `=` 之间有间隔就整族放行——判据自述"键以
  identifier 字符收尾"，用的却是与本文件定义不一致的字符类。**F2（历史缺口）**：
  非跨越的标点/续字符敏感键在注释体+间隔、活取值内嵌套两个面上四个 SHA 一致漏检，
  根因是两道**理由已失效**的冗余限制（间隔吸收锁在 `crossingOnly`；非 crossing 的
  compact 判据只作用于注释体）。修复即拿掉这两道限制并把字符类改为复用
  `isWordCharacter`；实测 1890 格 benign × 6 视图、1890 格 benign × gap 维度、
  全部注册散文/URL/path 对照与真实 tracked 模板保持干净（**更正**：原文写「一格未动」
  是过强断言，已被证伪——该轮实际引入 3 处新误报，根因是 `gapExhausted` 按整段文本
  判敏感，Round 23 已修）。targeted suite 从 64
  精确增加到 **67**，六个变异逐条验证判别力（含总控指出的三个**存活变异**，
  其判别力只存在于精确边界：取值恰好一个字符 / 闭合引号后是 NBSP / `#` 在取值中间）。
  **新登记两族已披露边界**：run 以包装标点收尾（与 `- (API_KEY) = 说明` 不可区分）、
  prose 角色不跑 role-agnostic 的 compact 判据（接通会让三个既有注册面误报）。
  另更正 Round 21 的「整行被放行」指错族、wrapper 收窄"无代价"表述及六处文档数字。
  **审计区间教训**：两份任务书都锚定 `70476a6..77d5997`，而 F1 就在 `70476a6` 里，
  唯一的阻断项恰好落在任务书盲区——后续审计区间应以**上一个被 Accepted 的 SHA**
  为起点。本轮**零跨冻结例外**。M3B 仍须由同样两路独立只读审计对新 SHA 重新给出
  结论，未标记 Accepted。
- **Round 26：把已发表的话钉到已提交的数据上**。Round 25 是唯一目的为文档更正的一轮，
  仍被判 BLOCK，且往它被派去修的两份文档里**新注入了两处缺陷**（写坏的里程碑表、
  错的反引号分母）。总控诊断：「让完整性声明从断言变成推导」是必要的，但**推导必须
  跑在已提交的数据上**——概括「不在仓库里的枚举」的数字错误率一点没降，只换了形状。
  本轮因此新增常驻门禁 `check-m3b-registry-integrity.mjs`（逐节 fail closed），
  执行一条规则：**任何进入文档的计数、比例或族名列表，要么由脚本对已提交的数据导出，
  要么删掉**；并把族/视图登记表抽成 `m3b-surface-registry.mjs` 供文档比对而非各自手抄。
  同轮修掉 sweep 登记表**零自校验**（`expect` 拼错/删族/删视图/`why` 置空四种变异
  此前实测全绿，拼错还会让「命中族数」凭空 +1，因为那个数是减出来的）、把 `mixed`
  第三态从注释里的幽灵标识符转为真正实现并被合成用例覆盖、pathspec 检查加 `-z`
  并放宽覆盖枚举正则（此前 `docs/配置.env` 与 `apps/client/app.env.local` 两类带凭据
  的 tracked 模板都能整份逃过检查）。撤回不可复核的「19 格」头条，按实测改正表格里
  的反引号那一格与两处反引号分母，修好写坏的里程碑表。**动态证据本轮真跑**：两轮
  fresh full-stack smoke 均 exit 0、containment 各自 18 needles × 86 artifacts ×
  **324** tracked files 零命中，与发表数字同源。M3B 仍须由同样两路独立只读审计对新
  SHA 重新给出结论，未标记 Accepted。
- **Round 24 绝对面普查与范围收窄**：前五轮都是**差分向**定点整改，每轮全绿、每轮
  被下一轮判 BLOCK。本轮改用**绝对向**方法（`node --env-file` 为唯一 oracle，枚举
  空间由四个互不可见的独立镜头设计后取并集）。**Round 26 撤回了此处原有的「19 格
  定向复现里 16 格沉默、3 格命中」头条**（更早一版写作 17 沉默）：它概括的探针语料
  从未进入仓库，不可复核，两次修正后仍不可验证；现在只保留计划文档里那张**被门禁
  逐格断言**的表。根因已量化：四条部分重叠的判定路径，覆盖面是
  它们特性的**并集**而非一份被规定的文法——prose 角色下三条独立判据只有一条在跑，
  `readAssignmentGap` 的 strict 分支是死代码，Round 23 的嵌套守卫只加在
  `closesEnclosingQuotedValue` 上而多数嵌套形态走 `readAssignmentValue`。另有两份
  tracked dotenv 模板（根 `.env.example`、`services/api/.env.example`）在扫描
  pathspec 之外、一遍都不扫（今天内容干净，但无强制力）。**处置：不继续逐轮修，
  改为登记**——新增常驻门禁 `check-m3b-template-surface-sweep.mjs`（8 族 × 6 视图
  48 格 + pathspec 检查），未登记族变沉默与已登记族被捕获**同样转红**，三个方向均
  经变异验证；同时收窄 M3B 的验收表述；扫描器重构单列里程碑放在 09A 收口之后。
  本轮**零跨冻结例外**。M3B 仍须由同样两路独立只读审计对新 SHA 重新给出结论，
  未标记 Accepted。
- **Round 23 定点整改候选**：`76025a3` 两路审计**分裂**（一路 CLEAN、一路 BLOCK），
  项目总控双向独立复现后判 **BLOCK**（2 项确认级 P1）。**P1-1**：「闭合引号之后 `#`
  起注释」只在 dotenv 行顶层成立，键被另一种引号包在外层字符串里时那个 `#` 只是
  字面量；`NOTES="x'PASSWORD='#<值>"` 整行零 problem，864 格，`d1201bc` 起放行、
  `70476a6` 只补回不带 `#` 的一半，跨三轮未闭合。**P1-2**（历史缺口，早于区间起点）：
  `isSensitiveKeyName` 对整键做 `endsWith`、对词元只做 `startsWith`，于是
  `PGPASSWORD=` 命中而 `PGPASSWORD_OLD=` 整族放行，连字符兄弟却照常命中——strict
  活行是主面，56 条活凭据漏 30 条。修复：词元层补 `endsWith`，**只对强后缀**；排除
  weak stem 是因为实测无条件补会让 13 个普通英文词中 10 个转红（`SURPASS`/`BYPASS`/
  `COMPASS`/`MONKEY`/`HOCKEY` 等），那是开放类，只能靠扩白名单堵，而本文件明确写过
  这条路走不通。同轮修掉 Round 22 自身引入的 3 处误报（`gapExhausted` 按整段文本判
  敏感）。targeted suite 从 67 精确增加到 **69**，四个变异逐条验证判别力。**新登记
  残留**：weak stem 粘进词干再加后缀（`MYAPIKEY_OLD=` 等）仍不命中，已在 case 两侧
  钉死。**审计方法论**：差分锚点结构性看不见「一直就是错的」那一类（P1-2 早于区间
  起点 24 个提交），后续须补一条不依赖区间的绝对面普查（`--env-file` oracle × 键构造
  × 分隔符 × 后缀笛卡尔积）。本轮**零跨冻结例外**。M3B 仍须由同样两路独立只读审计对
  新 SHA 重新给出结论，未标记 Accepted。
- **75 cases：1 个正向 baseline + 74 个反例/边界检查**，baseline 必须通过、
  其余 74 条全部以指定理由捕获、0 漏网（`check-local-test-negatives.mjs`）；
  另有 **M3B targeted negative suite 的 69 cases**（`check-m3b-round2-negatives.mjs`）、
  **15 项**拓扑变异反例、**5 个**确定性进程组回归与 **5 个**
  真实信号窗口（`check-m3b-signal-windows.mjs`）。失败消息不含任何 Secret 取值：
  wrong-reason 分支只输出期望判据与条目计数，不回显 raw problems/residue。

### Deferred — 外部依赖

以下项目没有被本地 fake adapter 或模拟器改记为 Pass：

- 真实 AppID/AppSecret、真实 `wx.login`/code2Session、合法 HTTPS 域名；
- 真机、多设备真实会话、体验版、审核、发布与 CI 上传凭据；
- 云 API、托管 PostgreSQL、正式 Secret 管理、WAF、备份恢复和可观测平台；
- Android、iOS、HarmonyOS 工具链、签名、实机和发布。

### 内部后续范围 / 发布阻断

- 应用进程重启后的未知命令恢复协议尚未实现；必须使用非敏感 locator + 服务端 command-status/receipt 或原子 fence，普通 GET 不构成恢复证据。该项不是外部依赖，并在完成前阻断发布。

菜单推荐、菜谱、采购、完整做饭、Agent、报餐/投票也不在阶段 08 范围。

仓库已配置受控 remote/upstream；远端 CI 仍需由阶段 09A 的真实 GitHub Actions run 提供证据。M1—M4 已 Accepted；**M5 当前不可变证据协议候选已通过完整 14/14，仍待两个全新 A/B 独立只读审计、未 Accepted；GitHub Actions workflow 已配置但无真实 run**；09A 总验收未完成。所有外部 Deferred 项保持原状态。菜单推荐开始前仍需单独完成 cooking-technique、allergen、food concept、宗教/伦理及食品安全规则词表的数据治理；该产品安全工作不与本地容器化混成同一个提交。
