R7-B_SHADOW_DESIGN_REVIEW: CLEAN

# 1. P0/P1/P2 counts

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |

# 2. Executive verdict

本次为从零、单人、只读的 Fresh Design Review。审查对象是冻结的 R7-B shadow design/evidence，不是 Designer 的最终消息、自评结论或实现。机械身份门禁先行通过；随后完整阅读指定仓库事实源、R7-A contracts/tests、R7-A design/evidence/Fresh Review 以及两份 R7-B shadow 文件。

结论为 CLEAN。设计没有把 caller claim、UUID、digest、`server_verified` schema 或 MAC 形状升级为真实性/权限；没有让 strict empty-only 清空 live aggregate；给出了闭合的 12 格 session/chunk 状态机、固定事务/锁顺序、锁后重验、same-key 与 cross-key replay 规则、commit/outcome-unknown 恢复边界、candidate/live 隔离、失败零持久写入和 GC terminal-fence 不失忆不变量。所有会改变数据库、公开合同、锁机制、保留策略或 live 语义的选择都保持 Proposed/mandatory unresolved，并明确阻止直接实施。

CLEAN 只表示这份 DESIGN_ONLY shadow design 的逻辑不变量足够完整、边界表述没有发现 P0/P1/P2。它不证明任何具体数据库机制能实现这些不变量，不是实现准入，也不改变 M1/G2/M2/R7-B/R7-C 状态。

# 3. A–H review matrix

| Area | Result | Independent challenge and basis |
| --- | --- | --- |
| A. Authority / security | CLEAN | 设计将 authentication/authorization/integrity/correlation/secrecy 分开（design 80–90），把 claim 永久限制为比对输入（90–92），要求 persisted lookup 绑定 principal/household/domain/session/aggregate（63–66、96–114、118–122）。digest 只作 correlation/integrity，opaque UUID 不依赖不可猜测性，MAC 也不能代替授权/currentness（367–377）。对“completed receipt 查询后、membership 撤回先于响应”的 TOCTOU 反例，设计要求授权在决策点有效（73、177），仅在读取资格可独立证明时允许快路径；否则不得走快路径，必须进入 bootstrap 后按序加锁/使用等价 fence 并重验，且该兼容性是 admission blocker（209–220、383、393、395）。`server_verified` 只验证 shape，不证明来源（90）。 |
| B. State machine completeness | CLEAN | absent/open/finalized × only/first/continuation/final 12 格全部给出（124–167）。exact replay、same-key different body、same ordinal same/different payload、新 key 旧 ordinal、gap/reverse、two-next、final/continuation、two-final、continuation-after-final 均有确定处理（155–160、222–246）。finalized 只在有效 scope 内优先，伪造/跨 scope 先安全拒绝（159、224）。历史 receipt 返回其不可变旧 checkpoint，不用 current checkpoint 改写旧结果（114、228–229、268）。 |
| C. Idempotency / atomicity | CLEAN | completed fast-path miss 后必须在 household→marker 路径锁内重查；无 marker 行也由 household 串行化；不允许非法 first 留下 pending marker（133–146、178–190、209–219）。失败定义为本请求 I/S/A/P/Q 零持久变化，包含 pending marker、TTL 与 quota（171–173）。success receipt、accepted chunk、candidate、checkpoint、quota，以及 final 的 live materialization/fence 同事务（188、215、250–256）。commit 前、commit 后丢响应、明确 rollback 与 outcome unknown 被区分（240–243、258–272）。raw bytes body identity 仅为 Proposed，明确承认 JSON 属性顺序差异和 R7-A 尚未冻结对象顺序，并在 encoding/version 冻结前禁止实现（116–122）。 |
| D. Locking / concurrency | CLEAN | 固定逻辑顺序为 completed replay→authenticated bootstrap→household→marker→session/checkpoint→aggregate/event→receipt→commit（193–219），与阶段计划的 household 总序兼容。两个 initial、无 session/marker 行、同 aggregate 不同 session、跨 chunk duplicate 与 target drift 均有持久 fence/锁后重验约束（180–191、212–215、234–245）。锁前读取没有 authority；不跨 HTTP 请求持锁、不允许后台旁路提交（218）。authorization revocation、GC 和其它 writer 必须共享该总序或等价 fence；机制未选型被明确列为实施阻断（220、393–394），没有冒充已解决。 |
| E. Persistence / live visibility | CLEAN | 推荐的 per-chunk staging 保存续传所需的 accepted identity、payload evidence、candidate event/projection、checkpoint 与 receipt，但 candidate 在 final 前不可被 live 产品读取，也不升级 caller 食品/绑定 authority（250–256、358–365）。final-only 仍必须持久保存足够的不可变恢复依据，明确排除 digest-only/caller-resend authority（354–362）。replay 究竟是验证、派生投影重建还是受控导入被列为必须先冻结的 admission blocker；本文不授权 caller history 进入 live（255–256、365、391）。target base、已有 live event、event/command duplicate 与 final materialization 均有 fail-closed 约束（158、183–191、244–256）。 |
| F. Failure mapping | CLEAN | `R7B.*` 被明确限定为 internal category，不是 public reason/ordinal/DTO（274–280）。总序覆盖 parser/auth、completed/body conflict、bootstrap/scope、lock stop point、checkpoint/source/persisted corruption、finalized/stale、duplicate/payload/order、capacity/lifecycle/base/integrity、abort/unknown（282–294）。矩阵区分 terminal/retriable/same-result/zero-write（296–320），并逐项登记 contract gaps；禁止扩用 R7-A reason、扩 union 或把 unknown 塞入 shape failure（321–322）。HTTP status/problem 留给 R7-C/后续 contract freeze（322）。 |
| G. Resource / lifecycle | CLEAN | 精确保留 1,048,576 bytes、10,000 events、Inventory 17/chunk、Seasoning 388/chunk（324–333）。明确指出 589/26 只是满 chunk 估算，最坏可有 10,000 个非空小 chunk（345–347）。session/candidate/receipt/checkpoint/fence storage、final budget、lock/transaction timeout、TTL、GC、abandoned session、公平性和 retention 全部登记为 mandatory unresolved（335–348、394、398–400）。GC 不得把旧 session/key/finalized identity 变回 absent；unknown outcome 不能因 receipt 缺失而重做写入（129、266–271、342、348）。 |
| H. Boundary integrity | CLEAN | 文件开头和 admission 结尾准确维持 M1 limited、G2 not admitted、M2 in progress、R7-A contracts-only Accepted、R7-B/R7-C not admitted（3–20、406–413）。没有 SQL/DDL/schema/migration/代码/测试/public reason/HTTP status/source activation；不可逆选择均 Proposed/未决（350–405）。`READY_FOR_REVIEW` 被明确限制为材料可审阅，不能外推 Implemented/CLEAN/Accepted/admission（5–7、413、423–424）。0005/N-1、DB/RLS、API/client 与外部 source 的职责边界清楚（401–412）。 |

# 4. Findings with exact line references and counterexamples

没有 P0、P1 或 P2 finding。

以下是重点反例的独立处置记录；它们没有计为 finding，因为设计已经给出必要不变量并把具体机制诚实保留为实施阻断：

1. **授权撤回并发反例**：caller 在 T1 通过 completed-receipt 权限预读，管理员在 T2 撤回 membership，T1 随后返回 receipt。若只是普通 SELECT，这会形成越权窗口。design 73、177 要求授权在决策点有效；209–210 只允许“读取资格可独立证明”的快路径，否则必须进入 bootstrap/锁/fence 后重验；220、383、393、395 又把撤回协议、receipt entitlement 与锁兼容性列为 admission blocker。因此设计没有批准有竞态的裸查询实现。
2. **digest-only final-only 反例**：服务端只保存 chunk digest，崩溃后让 caller 重送 payload。caller 可提交另一份自洽历史，digest/shape 不能证明 server source。design 354–362 明确要求保存足够的不可变恢复依据，并排除 digest-only 与 caller-resend authority。
3. **GC replay bypass 反例**：删除 finalized session、receipt 和 key 后，同一 replaySessionId/ordinal 重新表现为 absent。design 129、269、342、348 明确要求不可复用 terminal fence/安全终态，禁止“查不到即新请求”。
4. **属性顺序/idempotency 反例**：两个语义相同但 JSON 属性顺序不同的 body 被视为 different body。design 116–122 明确把 raw-byte identity 标为 Proposed，准确承认 R7-A parser 没有冻结对象属性顺序，并在编码/版本/consumer 重试约束冻结前禁止实现。它是待裁定 trade-off，不是暗含的已冻结语义。
5. **两个 initial session 同 aggregate 反例**：两个不同 replaySessionId 都在 live base 未改变时打开；若都 final，后一条可能覆盖前一条。design 244 与 I15（191）要求每个 final 在 household 总序内重验不可变 target base，前者改变 live state 后后者必须 `TARGET_BASE_CONFLICT`；精确 replay operation/live 语义仍由 256、391 阻断实施。
6. **receipt 被 current checkpoint 覆盖反例**：重试旧 key 时若返回 current checkpoint，会改变 same-result 并可能令旧命令看似产生新状态。design 114、155、228–229、268 明确要求返回历史 receipt 的不可变 checkpoint snapshot，零写入且不倒退 current state。

# 5. State / transaction / concurrency challenge results

## 5.1 Twelve-cell state challenge

| Session state | only | first | continuation | final |
| --- | --- | --- | --- | --- |
| absent | G0；非空 full history 或 strict empty-only；原子 finalized | G0；`0<n<total`；原子 open | 无可信 prefix，安全拒绝，零写入 | 无可信 prefix，安全拒绝，零写入 |
| open | 不能 restart；old ordinal duplicate/conflict/order，零写入 | 同 only | 仅 exact next 且 `p+n<total` 可推进 open | 仅 exact next、`p+n=total`、full digest/base 有效可 finalized |
| finalized | exact completed replay 由前置分流返回；其它请求 already-finalized | 同 only | 同 only | 同 only；不存在第二次 finalize |

该表与 design 140–167 一致。empty-only 只允许 absent→finalized，既不 append event，也不改变库存数量/live projection；现有非空目标不能被它清空。

## 5.2 Idempotency and ordering challenge

- same key/same body/completed：返回原历史 receipt，不消耗 quota，不更新 TTL。
- same key/different body：body conflict，且不回显原 body/digest。
- same ordinal/same payload/new key：duplicate，不创建 alias receipt。
- same ordinal/different payload/new key：persisted-payload conflict；finalized scope 则 finalized precedence。
- gap/reverse：不排队、不重排、不补造；拒绝零写入。
- two-next：household/marker/session 总序只允许一个观察到 current checkpoint。
- final vs continuation：先提交者推进；另一条锁后依据新 checkpoint 得到 finalized 或 stale/order，不沿旧 claim 自动成功。
- two-final：不同 key 最多一个完成终态；同 key/body 只能 replay 同一 receipt。
- post-final continuation：无 exact completed match 时 already-finalized。
- eventId/commandId：必须跨 chunk、candidate、获准 live ledger 检查，不能只靠 per-chunk Set 或 terminal digest。

## 5.3 Crash and transaction challenge

- parse/pre-read 至 commit 前的任何崩溃：本 chunk 的 marker/session/candidate/checkpoint/receipt/quota 全部回滚，已有前缀保持。
- commit 成功但 response 丢失：原 key/完整 body 读取同一 completed receipt，不重新 append/推进。
- commit 返回 unknown：不能按 rollback 处理；只能恢复查询。只有证明原事务不会再提交且不存在 completed result 后，才可在原 key/body 上重试写。
- lock timeout/deadlock/serialization/cancel：只在数据库明确 rollback 时归 known abort；基础设施在某一步停止不能伪装成后续业务判断。
- final：success receipt、accepted final chunk、candidate/current checkpoint、finalized fence、quota 以及获准 live materialization 必须同一提交；禁止先返成功再后台补投影。

## 5.4 Locking challenge

逻辑总序为 design 197–216。锁前读取只用于准备/线索；所有影响状态、scope、authorization、expiry、quota、target base、current checkpoint、prefix 和 duplicate 的判断都必须在对应 fence 后重验。无 marker/session 行由 household 锁与持久 non-reuse fence 保护。不得跨 HTTP 请求持锁，不得让取消后的后台任务成为旁路提交者。具体 isolation/advisory key/RLS/authorization-revocation/GC 协议未获批准，仍是实施前必须闭合的证据面。

# 6. Evidence identity and PRE/POST

## 6.1 Frozen input identity

| Item | Observed | Expected | Result |
| --- | --- | --- | --- |
| repository HEAD | `e9d80b00c71bd041efdb7c5487ba1c5fb0b92e91` | same | PASS |
| HEAD tree | `634f1a8e855f99743e267aacf9d3d09e26eb0107` | same | PASS |
| unique parent | `63d2a0668df3e1291cb3a863327bd5aeed6dd034` | same | PASS |
| `refs/heads/codex/stage-09p-m2-inventory` | `e9d80b00c71bd041efdb7c5487ba1c5fb0b92e91` | same | PASS |
| status | empty porcelain entries; detached HEAD description only | clean | PASS |
| shadow containing directory | mode `0700` | `0700` | PASS |
| design | 50,408 bytes / 424 lines / `24e1f2496df347a0215041835f45d79ba577256d13d1d6f8e7557e2b53d98d3f` | exact | PASS |
| evidence | 13,556 bytes / 152 lines / `93605e6893e53d8472ccde8a6213f258b7769c22b4a0fbb4e6d4ddb624136b68` | exact | PASS |

R7-B evidence 32–47 所列 14 个 read-set SHA-256 也逐项从当前固定 tree/指定 R7-A 材料重算并完全一致。没有把 hash 校验代替语义阅读。

## 6.2 PRE/POST non-modification

PRE：上述 repository identity、clean status、shadow directory mode、两份冻结文件 byte/line/hash 均已在语义阅读前核对。

POST：在报告初稿写入后重复只读封口检查；repository status 仍无 porcelain 条目，HEAD/tree/唯一 parent/branch ref 分别仍为 `e9d80b00c71bd041efdb7c5487ba1c5fb0b92e91`、`634f1a8e855f99743e267aacf9d3d09e26eb0107`、`63d2a0668df3e1291cb3a863327bd5aeed6dd034`、`e9d80b00c71bd041efdb7c5487ba1c5fb0b92e91`。shadow 目录仍为 `0700`；design/evidence 仍分别为 50,408/13,556 bytes、424/152 lines，SHA-256 仍分别为 `24e1f2496df347a0215041835f45d79ba577256d13d1d6f8e7557e2b53d98d3f` 与 `93605e6893e53d8472ccde8a6213f258b7769c22b4a0fbb4e6d4ddb624136b68`。本报告最终补记后将再做一次同组只读检查；最终 raw report identity 只记录在交付响应中。

未运行网络、依赖安装、Node/pnpm tests、数据库、Docker、B-r4、G2、Stage09A 或任何产品 gate；未联系 Shadow Designer；未使用子代理或其它任务；未修改 repository、Git admin、已有 `/private/tmp` 或 `.local` 内容。

# 7. Review report path and identity

- Path: `/private/tmp/meal-agent-r7b-shadow-review.iBMEaw/R7-B-shadow-design-review.md`
- Containing directory: reviewer-created private directory, required mode `0700`.
- This is the only file created in that directory, and all report content was written with `apply_patch`.
- Final raw bytes, line count and full-file SHA-256 are computed only after report closure and recorded in the delivery response; a raw full-file digest cannot be embedded into the same final byte stream without changing that digest.

# 8. Residual unresolved decisions

以下仍是实际 admission blockers，不因本次 CLEAN 而被选择或批准：

1. checkpoint authority 的最终 persisted-lookup/MAC 组合、canonical bytes、domain separation、key rotation、token version/泄漏/撤销策略；digest 单独永远不够。
2. current membership 与 historical safe receipt 的读取政策，以及与 membership revocation 线性化的锁或等价 fence。
3. per-chunk staging 与 final-only 的最终选择；replay 是验证、派生投影重建还是受控导入；caller history 的来源授权、target base、final live materialization。
4. DB tables/columns/indexes/unique constraints/RLS/controlled privileges/migration/permission manifest；没有预先批准 `0005`。
5. isolation level、household advisory key、missing-row claim、完整 writer/GC/revocation lock graph 及 deadlock 证据。
6. idempotency ledger 复用、key namespace、raw body encoding/version、parser-version compatibility、receipt/tombstone identity 与 consumer immutable-retry 协议。
7. R7-B public contract reason/code/ordinal、compound precedence、outcome-unknown/status recovery；当前 `R7B.*` 只允许内部设计分类。
8. lock wait、transaction timeout、cancel/commit race、retry/deadline/overload fairness 的数值与动态证据。
9. session TTL、abandoned-session terminalization、GC、audit/receipt/checkpoint/fence retention，以及 retention 后“可恢复结果”与“不可重放 tombstone”的精确响应。
10. per-household/principal active-session quota、single-session/aggregate storage、最多 10,000 receipts/checkpoints、final transaction/CPU/memory 预算。
11. full-history canonical/digest、incremental verification、before/projection recomputation 及 existing-live-event equality/conflict 语义。
12. R7-C request stream、content type、materialization 前 byte cap、route concurrency/timeout 与 HTTP problem/status mapping。
13. M1 Accepted、G2 admission、B-r4、N-1/rollback/real PostgreSQL RLS/permission/lock evidence、R7-B implementation task authorization 均未满足。
14. 客户端进程重启后的 non-sensitive locator/command-status 恢复与发布兼容边界仍未完成。

# 9. Claim ceiling and next step

本次结论的最高声明仅为：冻结的 R7-B shadow design 通过独立 Fresh Design Review，仍然是 `DESIGN_ONLY`。

它不解锁实现，不授权 SQL/DDL/schema/migration/DB/RLS/API/client/test 写入，不改变 `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`、`G2_NOT_ADMITTED`、`M2 In Progress`，也不把 R7-A contracts Accepted 外推至 R7-B/R7-C/M2。

下一步只能由项目总控决定是否接受这份 shadow design。即使总控接受设计，也必须另行冻结上面的 unresolved decisions、签发精确实施基线和 write-set、完成所需独立证据后，才可能考虑实现准入；当前不能开始实现。
