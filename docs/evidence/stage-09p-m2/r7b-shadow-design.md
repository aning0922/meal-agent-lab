READY_FOR_REVIEW

# 1. Scope and non-authority statement

任务：Stage 09P-M2 / R7-B Cross-request Replay Shadow Design。事实基准/任务开始：2026-09-05；交付日期：2026-09-06（Asia/Shanghai）。
角色：独立 Designer；此材料只有 shadow design 权限，供后续独立 Design Review。
READY_FOR_REVIEW 只表示设计材料可审阅，不表示 Implemented、CLEAN、Accepted、G2 admitted、M1 Accepted 或 M2 Accepted。

本任务固定事实：

- M1 = `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`，不是 Accepted。
- G2 = `G2_NOT_ADMITTED`；source pack 不 active，public trust allowlist 为空。
- M2 = In Progress，整体未 Accepted。
- R7-A 仅 contracts Accepted；R7-B/R7-C 均未 admitted。
- Entry Gate 任务 `01a07230-0bb2-7332-aec8-f5ba7824908d` 的 DESIGN_ONLY 来自任务书；本任务未打开该任务或另行核验其报告。

此设计覆盖 checkpoint authentication、persisted replay prevention、跨请求 gap/order、final-after rejection、atomic persistence、idempotency/locking/transaction invariants、failure mapping、resource/timeout allocation 八面。
下文“必须”表示本候选需要满足的逻辑安全不变量，不代表具体机制获批。新增机制、操作策略和所有不可逆选择均为 Proposed 或未决。
不实现、不修复、不测试产品行为、不修改仓库/Git、不运行 gate、不创建 source、migration、SQL、schema、route、service、client 或 fixture。
任务书的两文件写入限制覆盖 AGENTS.md 的阶段完成后更新 project-status 通用约定；因此本任务不更新仓库文档。

# 2. Baseline/read-set/write-set

仓库：`/Users/aipuli/.codex/worktrees/5483/meal-agent-lab`。

| 身份 | PRE 观察值及期望值，两者一致 |
| --- | --- |
| HEAD | `e9d80b00c71bd041efdb7c5487ba1c5fb0b92e91` |
| tree | `634f1a8e855f99743e267aacf9d3d09e26eb0107` |
| 唯一 parent | `63d2a0668df3e1291cb3a863327bd5aeed6dd034` |
| `refs/heads/codex/stage-09p-m2-inventory` | `e9d80b00c71bd041efdb7c5487ba1c5fb0b92e91` |
| status | 空输出，clean，包含 untracked 检查 |

R7-A implementation parent `8a69bc2435e1b7ebb3667d6bbea39ef5dffe81b8` 是上游 R7-A 材料中的历史基线，不与本 worktree 的唯一 parent 混同。
当前事实优先使用 `docs/project-status.md` 的 2026-09-05 段落；README、规划和 ADR 的历史“M1 尚未开始”句子不覆盖当前事实。

指定 read-set（只读）：

1. `AGENTS.md`、`README.md`、`docs/README.md`。
2. `docs/project-status.md`，重点第 11 行及 999–1011 行的 2026-09-05 事实。
3. `docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md`，尤其 §5.5、§6、§7、§12。
4. `docs/architecture/decisions/0007-food-knowledge-governance-and-domain-core.md`。
5. `docs/architecture/decisions/0008-stage09p-m0-evidence-boundary.md`。
6. `packages/contracts/src/stage09p-input.ts`、`inventory-v2.ts`、`seasoning-v1.ts`。
7. `packages/contracts/tests/stage09p-contracts.test.ts`，只读源文件，未执行测试。
8. `/private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-design.md`。
9. `/private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-evidence.md`。
10. `/private/tmp/meal-agent-r7a-r6-fresh-review.gsUbH9/root-audit/report.md`。

上游报告的测试/CLEAN 是引用的历史证据，不是本任务的测试或结论。两个并行只读助手仅做材料提取，没有独立 Design Review 权限，也没有文件写入权限。

write-set 仅为 mktemp 新建的 0700 私有目录内两个文件：

- `/private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-design.md`
- `/private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-evidence.md`

所有文件内容写入只用 apply_patch。PRE/POST、实际命令、尺寸与摘要见同目录 evidence。

# 3. Threat model

| 威胁/边界 | 攻击或故障 | 所需约束 |
| --- | --- | --- |
| 恶意 caller | 伪造事件、计数、before、digest，提交局部自洽历史 | parser 成功仅产生不可信 DTO；服务端重新验证授权、来源边界、状态和确定性计算 |
| 伪造 checkpoint | 自造 checkpointId/digest，或把 caller_claim 改为 server_verified | authority 只从服务端受保护持久记录取得；shape/tag/digest 都不是认证 |
| 跨 household | 以自己 principal 引用另一户 checkpoint/receipt | 所有 lookup 绑定认证主体和授权 household；不得通过查找结果泄漏其存在 |
| 跨 session/aggregate/domain | 在同户复用他会话/另一 lot/seasoning 的值 | 绑定 domain、session、aggregate 全范围；Inventory/Seasoning 即使 UUID 相同也不同域 |
| stale state | 使用历史 checkpoint；锁等待时状态改变 | 锁前预读无决策权；锁后重新读取完整状态并重验 |
| 重复/乱序 | 重发 ordinal、换 key、改 body、跳过 chunk 或倒序 | 持久 accepted-chunk 与完整前缀约束；新 key 不能重新接受已完成 ordinal |
| 并发 | 两个 next、final/continuation 或两个 final 竞争 | 共同 household 总序、marker、session/checkpoint、aggregate/event 锁及原子 commit |
| 响应丢失 | commit 成功但调用方不知道结果 | 原 key/原 body 查询不可变已完成 receipt，不再执行事件或推进 checkpoint |
| 进程崩溃 | marker 后、事件写入中、checkpoint 后、commit 前后退出 | commit 前全部回滚；commit 结果不明先查 receipt，不能擅自换 key |
| 存储耗尽/拖延 | 大量小 chunk、abandoned sessions、锁等待 | 冻结解析上限，加 Proposed 持久配额和有界等待；配额/GC 不能破坏 replay fence |
| 生命周期/权限变化 | 被移除成员、GC、其他产品命令和回放交错 | 授权在决策点有效；GC/其他写路径遵守同一总序和版本/fence；不能依赖进程内锁 |

不信任 caller 提供的 actor、household、session 标识、checkpoint、食品绑定或安全资格。模型不能补造未知日期/来源，不能把购买日当生产日，也不能绕过 hard constraints 或确认机制。
数据库服务和已批准的应用身份验证链属于设计 TCB；数据库特权主体被攻破不由一个摘要字段解决。运行时、canonical/hash 实现和后续并发证据仍需独立取证。

# 4. Authority model

## 4.1 五种不同保证

| 保证 | trusted input / 来源 | 不提供该保证的值 |
| --- | --- | --- |
| Authentication | 既有认证链验证后的 principal；checkpoint 来自受保护服务端记录 | caller actorUserId、UUID、kind 字符串、普通 SHA-256 |
| Authorization | 服务端 principal→household 权限及该 replay/receipt 操作许可 | householdId 路由/body 值、有效 MAC、知道 checkpointId |
| Integrity | 原子保存的服务端前缀、重新计算的事件/投影/历史摘要和状态约束 | 只比较 caller 两处相同 digest，或只通过 Zod |
| Correlation | 已验证 scope 下的 checkpointId/digest、session、完整请求身份与持久 receipt | correlation 不可升级成 authenticity 或权限 |
| Secrecy | 最小 receipt、受作用域约束的查询和固定错误输出 | digest 不是加密；MAC 不是加密；不回显不代表时间侧信道已被证明消除 |

`priorCheckpointClaim` 永远只用于比对，永远不能创建 server authority。server_verified schema 只验证服务端 DTO 的形状，本身不证明某对象真实来自服务端。
初始 only/first 没有 prior claim。它们的 session 创建许可来自认证/授权 context 与服务端目标/来源状态；caller 提供的 replaySessionId 仅是申请绑定的关联标识，服务端在锁内认领且不得复用已有会话身份。
原始事件只因 parser 合法而获得“可检查输入”资格，不获得真实食品事实、approved source、可写 live aggregate 或 eligible 资格。

## 4.2 完整比对集合

下表是逻辑比对清单，不是数据库列设计；aggregateId 映射 Inventory→inventoryLotId，Seasoning→seasoningId。

| 字段 | caller 有该字段时的用途 | 服务端决策来源/必验关系 |
| --- | --- | --- |
| checkpointId | 受限 lookup 线索，不能创建记录 | 指向本会话当前 checkpoint；历史已完成回执重放使用原 checkpoint 快照 |
| checkpointDigest | correlation claim | 等于所取服务端 checkpoint 的摘要，且服务端编码/内容完整性可验证 |
| replaySessionId | 与 envelope/claim 比对 | 服务端 session 身份及其不可变 scope |
| householdId | 与认证 household 比对 | 认证/授权 context 与持久记录完全一致 |
| aggregateId | 与 envelope/events 比对 | 服务端目标 aggregate 身份及 domain 完全一致 |
| nextChunkOrdinal | 比对 incoming chunkOrdinal | 服务端 accepted prefix 的下一 ordinal，不由 claim 决定 |
| processedEventCount | 比对 processedEventCountBefore | 服务端实际已接受且验证事件数 |
| nextEventSequence | 比对 chunkStartSequence | 服务端 processed count + 1，关联 aggregate candidate 的末版本 |
| terminalEventDigest | 比对 previousChunkTerminalEventDigest | 服务端前缀实际 terminal digest，连接新 chunk 首事件 |
| declaredTotalEventCount | 比对 envelope 和 claim | 服务端首次接受时绑定的总数，跨请求不可修改且不超过 10,000 |
| status | caller claim **没有此字段** | 锁后服务端 session/current checkpoint 一致；新 continuation/final 要求 open |
| verifiedHistoryDigest | caller claim **没有此字段** | open 必须 null；非空 finalized 必须为服务端已验证历史 digest；空 finalized 必须 null |

不向冻结 claim 添加 status/verifiedHistoryDigest，也不从 caller 填入缺失字段。后两项参与“服务端 session ↔ current checkpoint ↔ 本次合法转换/receipt”比对；其余 claim 字段逐一与锁后服务端值比较。
完成结果重放比对的是 receipt 中不可变历史 checkpoint；不能拿当前推进后的 checkpoint 替换旧 receipt，也不能让旧 receipt 的返回把当前状态倒退。

## 4.3 请求身份与 digest 边界（Proposed）

逻辑幂等命令身份至少绑定认证 principal、household、操作/domain、session、aggregate、idempotency key 与完整 body 身份；key 所属命名空间不能由 body 的 session/aggregate 变化绕过 same-key conflict。
Proposed 以“认证 principal + household + replay operation/domain + key”为 key 比较范围，session/aggregate/kind/ordinal/claim/events/全部计数/摘要均属于不可变 body 身份。具体复用现有 command ledger 的方式未决。
same body 的候选策略是保留并比较原始、已通过 frozen raw parser 的 UTF-8 请求字节；hash 仅作索引/关联，不用语义字段子集代替完整 body。不同 JSON 属性顺序若造成字节不同，按此 Proposed 策略视为不同 body。
body 编码、checkpoint canonical bytes、事件/历史摘要算法及域隔离版本仍需正式冻结；不能推定 R7-A 的 canonical token 规则已经定义全部对象字段顺序或 checkpoint 签名协议。
在上述身份冻结前，不实现 fingerprint、token 或第二份 DTO；任何 MAC 方案均不得偷偷塞入 strict claim 的新字段。

# 5. State machine

## 5.1 状态定义及前置分流

absent/open/finalized 指 **replay session**，不代表 live InventoryLot/Seasoning 是否存在。live aggregate 的存在性、版本和写权限另行验证。
absent 指服务端确认该会话未创建且未被保留的 terminal fence 使用；GC 删除 payload 不能把已使用 session/key 变回可接受的 absent。
open 表示已有完整提交的接受前缀与可恢复 candidate，尚未完成全历史。
finalized 表示终态 checkpoint、最终 receipt 与获准的最终物化已原子提交，不允许重新 open。

先走 completed idempotency replay：只有同一已认证/获准 receipt 主体、同 scope、原 key、完整同 body 且已完成的安全 receipt，才能零写入返回原结果。此分流先于下表，不是新状态转换。
同 key 不同 body 在可见自己的 marker 时为 body conflict；不存在匹配 completed receipt 的请求进入锁内状态机。

定义初始 G0：授权创建本 replay session；ordinal=1、before=0、start=1、previous tip=null、prior claim=null；declared total 经服务端绑定，目标/来源与版本前置成立。
定义后续 G1：持久 session=open，完整 §4.2 比对通过；ordinal=next ordinal；start=next sequence；before=processed；首事件前链及领域 before 与服务端 candidate 一致。
所有非空 chunk 还须 actual n 在本域上限内、逐事件顺序/身份/摘要/领域转换有效；“相同 digest 字符串”不能替代重算。

| 锁后 session | only | first | continuation | final |
| --- | --- | --- | --- | --- |
| absent | G0；n=total；非空全历史验证或严格空 only；成功直接 finalized | G0；0<n<total；成功 open | 拒绝：无可信前缀；若带无法认证 claim 为 untrusted checkpoint，否则 order；零写入 | 拒绝：无可信前缀；同左；零写入 |
| open | 拒绝：不能重新开始；已接受 ordinal 归 duplicate/conflict，否则 order；零写入 | 拒绝：同左；零写入 | G1；processed+n<total；成功仍 open | G1；processed+n=total 且 claimedFinalHistoryDigest 与服务端全历史计算一致；成功 finalized |
| finalized | 无 completed replay 时 already-finalized；零写入 | 同左 | 同左 | 同左；不会第二次完成 |

每个成功转换的 trusted state 为认证/授权 context、锁后的 marker/session/checkpoint/candidate/目标 base；每个拒绝保留进入本事务前的全部已提交状态。不能为非法 first 先创建 session，再返回失败。

## 5.2 转换值与异常顺序

对于合法非空 chunk，以服务端旧 processed=p、incoming actual events=n、ordinal=k 计算：新 processed=p+n、nextEventSequence=p+n+1、nextChunkOrdinal=k+1；terminal 来自服务端验证的最后事件。
非终 chunk 保持 status=open、verifiedHistoryDigest=null，且 p+n<declared total。
终 chunk 为 status=finalized，p+n=declared total，verifiedHistoryDigest 为服务端验证值；checkpointDigest、checkpointId 的产生机制未决，必须是服务端产生/维护。
未完成 chunk 的计数至少增加 1；禁止空 first/continuation/final 延长 session。只接受连续 ordinal；不要求 chunk 装满，不新增冻结契约没有的 packing 限制。

exact replay：原 key/body/receipt 命中返回原结果，无新 marker、checkpoint、事件或配额消耗。
different-body replay：同 key 不同 body 拒绝；不同 key 的旧 ordinal/payload 无自动幂等特权。
gap：k 大于 next ordinal；duplicate/reverse：k 小于 next ordinal。同 ordinal 不同持久 payload 归冲突；同 payload 且新 key 归 duplicate。两者均不接受。
持久化的事件 eventId、commandId 还需跨 chunk 防重；不能只依赖每 chunk 的 Set。已存在 live ledger 的原事件可只读核验，不得再 append 一遍。
status=finalized 在有效 scope 内优先于新请求的旧 claim/order 分类；伪造/跨 scope 请求先走权限/认证失败，不泄漏 finalized 是否存在。

## 5.3 严格 empty-only

只允许 absent→finalized，且服务器确认本次获准 replay 的历史为空；不能用空请求清空已有非空目标或覆盖 projection。
输入为 only、ordinal 1、start 1/end 0、四个 count 为 0、events=[]、prior claim/previous/terminal/final digest 均 null，精确遵守 R7-A strict branch。
输出 checkpoint 为 server_verified/finalized、next ordinal 2、processed 0、next sequence 1、declared total 0、terminal/history digest null，保留服务端 checkpointId/checkpointDigest 和 scope。
同事务写已接受的空 chunk 记录、终态 session/checkpoint、success receipt；无事件 append、无库存数量或 live projection 变动。空结果不是 open checkpoint，也不需要增加 claim 分支。
原 key/原空 body 重试返回原 finalized receipt；新 key 的重复 empty-only 为 already-finalized；原 key 改成非空为 body conflict。

## 5.4 Invariant ledger

记 T=认证/授权 context，I=持久幂等 marker/receipt，S=持久 session/current checkpoint，A=获准目标及 base，P=隔离 candidate 前缀/事件/投影，Q=服务端配额与生命周期状态。
“Z”统一表示：拒绝/已知回滚后，I/S/A/P/Q 的本请求持久变化全为零，包括 pending marker、success receipt、更新时间/TTL 延长和配额预留。此前已提交 chunk 保留，竞争者独立提交的变化不算本请求写入。
允许的临时副作用只有读、锁、内存计算及事务内可回滚的暂存；释放锁不是业务写入。失败计数若未来需要持久化须另行批准，不能成为本候选“零写入”例外。

| ID / invariant | Trusted inputs；precondition | 锁前检查 | 锁后重验 | 成功状态/允许提交 side effects | 拒绝状态/失败不变项 |
| --- | --- | --- | --- | --- | --- |
| I01 principal/scope | T；当前主体有 replay 或 receipt 权利 | 验证认证上下文、请求 scope | household/目标权限及 revocation fence 在决策点仍有效 | 只在自身授权范围推进；无授权表修改 | AUTH/SCOPE；Z，零他户数据 |
| I02 完成重放 | T+I；原 key/完整 body、completed | read-only scoped receipt lookup；不能先锁 marker | fast-path 未返回时在规定 marker 锁后再次查；权限策略仍有效 | 原 receipt 原样返回；所有持久状态零写入 | conflict/无资格则不重放；Z |
| I03 body 不可替换 | T+I；同 key 绑定唯一完整请求 | 预读只作线索 | 锁 marker 后重验完整 scope/body 和完成态 | 首次成功绑定一次；不得另建新 key alias 绕过冲突 | IDEMPOTENCY_BODY_CONFLICT；Z，保留原 I |
| I04 bootstrap | T+S+A+Q；only/first且授权初始态 | 检查 G0 与 shape | 锁后确认 session 未使用/无 fence、base和容量仍成立 | 初始 session、P、checkpoint、receipt 同事务 | untrusted/order/base冲突；Z，仍 absent |
| I05 checkpoint authority | T+S；后续 G1 | claim 仅 lookup/比对候选 | 逐项 §4.2；scope/current/status/history、服务端记录完整性 | 仅在服务端前缀上产生下一 checkpoint | untrusted/stale/integrity；Z，claim 不创建 S |
| I06 ordinal/count/total | S+P；连续 next，固定 total | parser 局部计数与四项上限 | 锁后 actual prefix + n；total不可漂移；start/end/versions一致 | p→p+n、k→k+1；不跳过不重复 | gap/duplicate/reverse/capacity；Z |
| I07 跨 chunk identity | S+P+A；事件/command 身份无冲突 | 本 chunk 内重复检查 | 与持久完整 prefix/目标身份比对，不只 tip | 每个获准事件只进入 candidate一次；现有live事件不重插 | duplicate/payload conflict；Z |
| I08 确定性 before/digest | P+A；受准来源及可验证领域规则 | 原输入只做局部检查 | 首事件 before、binding/日期来源、全链、projection/event摘要重算 | P 只包含验证前缀；不升级食品或绑定 trust | before/digest/source failure；Z |
| I09 final fence | S+P+A；open且全历史完成，或严格初始only | kind/count/final claim 只作候选 | 锁后状态、total、完整历史digest和目标base再次核对 | finalized与最终物化/receipt同事务；永不回open | already-finalized/final invalid；Z |
| I10 empty closure | T+S+A；获准空历史且session absent | strict empty only | 锁后确认目标不能被空请求清空 | 空accepted记录+final checkpoint+receipt，无event/live变动 | 非法empty/base冲突；Z |
| I11 锁总序 | T+I+S+A；所有相交写路径共享协议 | 不持反向锁；预读非authority | household→marker→session/checkpoint→aggregate/event | 单次可线性化commit；无进程锁替代 | lock timeout/deadlock/abort；Z |
| I12 全事务原子性 | I+S+P+A+Q；验证全部成功 | 不提前公布success | commit前校验写集合完整、结果schema和基线有效 | accepted chunk/event+projection/checkpoint/receipt+配额同事务 | 任一异常整体rollback；Z，无半receipt |
| I13 丢响应恢复 | T+I；original immutable request | 不用普通GET或当前projection猜结果 | 已知abort可重试；unknown先确定原事务终态 | committed仅返原receipt；未commit重做一次 | 不明时保持unknown，不以新key写入 |
| I14 storage/lifecycle | Q+S+I；有效会话和预算 | 有界资源预检 | 配额/expiry按锁后服务端时间；GC共享fence协议 | 成功时原子占用；旧terminal fence不能被重新认领 | capacity/expired；Z，拒绝不延TTL |
| I15 target drift | T+A+S；会话绑定获准目标基线 | 预读target revision/权限 | 最终物化与每次依赖目标的验证重验base；其他writer遵守同序 | 仅按获准语义物化；不覆盖更新后的live state | TARGET_BASE_CONFLICT；Z，不自动重base |

# 6. Transaction and lock order

固定逻辑顺序（来自任务书；具体锁机制仍未决）：

```text
completed idempotency replay
→ authenticated bootstrap
→ household product-flow advisory
→ idempotency marker
→ replay session/checkpoint
→ aggregate/event state
→ checkpoint/result receipt
→ commit
```

0. 进入该顺序之前只允许边界准备：R7-C 提供有界请求与认证主体，R7-A raw parser 产生深冻结 DTO。任何失败直接返回安全分类，没有数据库业务写入。这里的认证主体建立不等于下面的 household bootstrap。
1. **completed idempotency replay**：只读查询本 principal 的安全 completed receipt，先验证自身 receipt 读取资格、命令作用域和完整 body。命中即可零写入返回原结果，不读取别户状态，不取 marker 行锁。未命中不允许提前插入 pending marker。
2. **authenticated bootstrap**：从服务端 context 建立 household 与本操作授权。bootstrap 不能先持有稍后顺序中的 marker/session/aggregate 锁；需要额外授权锁/fence 时其相容性必须单独冻结。前置 replay 资格无法独立证明时，不走 fast-path，进入 bootstrap 后依次锁并重查。
3. **household product-flow advisory**：取得该户产品流事务级串行权；具体 key 编码、隔离级别和 timeout 未決。不按 caller 随意选择另一个 lock namespace。获得锁后重验可能已改变的 membership/权限、配额/到期与目标适用性，读取锁后服务端时间。
4. **idempotency marker**：household 锁之后才取 marker 锁/认领未存在 marker 的排他权；无行场景也必须被同等串行化。重读 completed 状态和完整请求身份；等待者发现同 key/body 已完成则返原 receipt，不继续推进 session。发现异 body 回滚退出。
5. **replay session/checkpoint**：固定为 session 身份/当前指针，再 current checkpoint；历史只作为不可变比较材料。无 session 行不等于可自由并发插入，初始创建同样受 household 串行与持久非复用约束保护。scope可见性确认后先判finalized，再判claim真实性/current性及order。
6. **aggregate/event state**：取得本域目标及candidate/fence，再按事件逻辑 sequence、稳定身份序处理所需事件状态；重验 target base、已接受prefix、跨chunk before/identity/digest。不能先取 aggregate 后回取 session 或 household。此次没有 meal/profile/shopping 写入；未来复用总序必须证明与规划§5.5其它路径兼容。
7. **checkpoint/result receipt**：验证通过才在同一事务形成 accepted chunk、候选事件/投影、下一checkpoint、完成receipt、预算占用；final 时还包括获准的最终物化。success receipt 的 kind 与 checkpoint status 必须符合 frozen result schema。事务中形成不等于对外宣布成功。
8. **commit**：commit 是唯一接受线性化点。只有明确提交成功才能交付新 success；数据库/连接返回不确定结果时进入 outcome unknown，按原 key 查询恢复，不能宣称已回滚。

所有错误路径整体 rollback，不用 catch-and-commit 保存半个状态。不持锁跨 HTTP 请求，不把超时后的后台任务放任为另一条提交路径。
completed replay 与新命令写事务使用相同 receipt 身份。fast-path miss 后必须锁内重查，避免两请求都 miss 而各自创建成功结果。
授权撤回、其他产品写入、GC 与 replay 是否共享足够的锁/fence，是后续实现 admission 的必要证据；只在 R7-B 内部使用 advisory 并不能证明与现有系统并发安全。

# 7. Replay/idempotency/concurrency matrix

下表均假定 raw parser 通过且有权限查看自身作用域；跨 scope 先安全拒绝。没有 completed exact replay 的新请求按 §5 和 §9 总序分类。

| 情景 | 持久化判据与处理 | 可见结果/写入 |
| --- | --- | --- |
| same key / same body，completed | 认证主体、scope、完整字节与安全receipt相同 | 原结果，包括旧open/final/empty receipt；零写入，不返回当前checkpoint替代 |
| same key / same body，in flight | household后marker串行等待；锁后重查 | 前者commit→原receipt；前者rollback→从原状态处理；超时→retry，不重复应用 |
| same key / different body | 在自身key范围内发现完整body不同，包含session/aggregate/claim改变 | idempotency-body conflict；零写入，不返回原body或digest细节 |
| same ordinal / same payload，同原key/body | 已完成I证明是同一命令 | 仅作completed replay，零写入 |
| same ordinal / same payload，新key | 已接受prefix中同ordinal存在；不自动创建receipt alias | open时duplicate；finalized时already-finalized；零写入，要求原key恢复 |
| same ordinal / different payload，新key | open内匹配持久accepted ordinal但内容不同 | persisted-payload conflict；finalized优先already-finalized；零写入 |
| 两个 next chunk，同next ordinal不同key | 锁后仅第一位仍满足G1 | 一个commit；另一看到旧ordinal→duplicate/conflict或finalized；不能两次推进 |
| 先送k+1再送k | 无可信k checkpoint，不满足next/claim | 先到k+1拒绝；k可正常接受；无等待未来chunk的pending成功记录 |
| gap / reverse order | ordinal >next为gap；小于next为duplicate/reverse | 零写入；不自行重排序、补造中间chunk或重置total |
| final 与 continuation 竞争 | 同旧checkpoint/ordinal下，final填满total，continuation未填满；不同body | final先commit→后者already-finalized；continuation先commit→旧final stale/order，需新的合法命令，不能原样再接受 |
| 两个 concurrent final | 原key同body可回执重放；不同key只能一个终态转换 | winner finalized；loser已完成same-key replay或already-finalized；不双写 |
| continuation after final | 无completed exact receipt、服务端已finalized | already-finalized；不再open、不写event/checkpoint |
| commit 前崩溃 | 新marker、accepted chunk、event/projection、checkpoint、receipt全部在未提交事务 | 全部撤销；此前前缀不变；原key/body可重试 |
| commit 后丢响应 | 数据库已有完整成功receipt及其配套状态 | 原key/body恢复原result；不重放事件，不再创建checkpoint |
| cross household/session/aggregate/domain | principal scope和持久绑定必须全匹配；session/aggregate改动同key也是异body | 安全scope/body拒绝；不泄漏他户或他会话是否存在，零写入 |
| empty-only final replay | 同原key/空body/terminal receipt | 原finalized-empty；新key拒绝already-finalized；改body原key拒绝conflict |
| 同aggregate的两个不同session | 各session仍绑定服务端目标base；household串行只保证每次请求，不能跨请求预约live状态 | final锁后重验base；禁止后一会话覆盖已变更目标；另记target-base conflict |

“同payload”不是仅比较 terminalEventDigest；需要完整已接受 chunk 身份，包含事件内容、scope、count、kind、prior claim和final claim。某个事件在前缀中重复但换ordinal，也由跨chunk eventId/commandId/sequence检查拒绝。

# 8. Atomicity and crash recovery

## 8.1 Proposed 原子单元

采用 §11 的 Proposed per-chunk staging 时，每次接受的原子单元为：幂等成功标记与不可变result receipt + accepted chunk身份/内容证据 + session进度/current checkpoint + 隔离的候选event/projection状态 + 本次存储配额变化。
非final候选投影只供该session继续验证，不能被产品库存/推荐读取为live状态。receipt 的 accepted_chunk 仅说明该前缀已持久接受。
final事务除上述内容外，还必须包含全部获准的最终event/projection物化及finalized fence；不能先发final receipt、再异步补写live投影。
已有live事件的重建不能再次append相同事件；若只是验证既有历史或重建派生投影，event写集合可为空，但同一事务必须锁定/验证其权威基线。
本文不授权将caller上传历史作为全新live事件导入。精确 replay 操作是验证、派生投影重建还是受控导入，及相应源记录/目标base策略须在 admission 前冻结。没有服务端来源和写权限证明时不能live物化，不能以此设计补造该权限。

## 8.2 崩溃窗口

| 窗口 | 数据库允许的终态 | 恢复约束 |
| --- | --- | --- |
| 已parse/预读，尚未marker | 本请求无持久状态 | 原key/body重新进入固定顺序 |
| marker/session创建后，event前 | 整个事务回滚；无孤立pending marker/session | 不保留可冒充成功的checkpoint |
| 部分candidate事件/投影已写 | 本次chunk全部回滚；前次已提交前缀保留 | 不依靠逐事件补偿删除已提交live事件 |
| checkpoint或receipt形成后，commit前 | 本次全部回滚 | 不把内存receipt向外宣布为成功 |
| 发出commit后结果不明 | 可能完整提交，也可能全部回滚 | 先确认原事务不再可能提交，再判断无receipt是否可重做；DB不可达时保持unknown |
| commit成功，响应丢失 | 完整chunk/checkpoint/event/projection/receipt一次提交 | 原key/完整body读回原receipt；不能生成新checkpointId |
| response已送达，稍后重试 | 同上 | 历史receipt仍受主体/范围权限保护；不因current session推进重写receipt |
| GC与恢复交错 | 不能出现receipt声称成功但所需checkpoint/fence已被复用 | 保留策略/可恢复窗口必须共同批准；无法恢复时安全终态，不静默当新请求 |

成功是“原子效果至多一次且结果可关联恢复”，不是保证网络响应必达或无限期可重放。保留期未冻结前，不声称无限期same-result replay。
普通GET显示当前库存不证明某次命令是否提交；客户端进程重启后的locator/command-status协议仍是既有未完成边界，本设计不宣称已补齐。

# 9. Failure mapping

## 9.1 语义及优先级

以下 `R7B.*` 仅为本设计稳定 internal category 名称，**不是新增 public reason code、ordinal、DTO 或已接受合同**。同一可信状态、相同输入和相同基础设施结果使用同一分类。
terminal 表示这个已观察请求/冲突不能自动继续应用，不等于永久撤销用户操作；修改业务意图须形成新的合法命令。retriable 只允许原key/不可变body并先排除已有commit。
新失败不保存completed failure receipt：其全部持久side effect为零。将来若要复用既有安全失败receipt策略，必须另行冻结，不偷用旧接口语义。

Proposed 分类总序：

1. R7-C准备/认证和R7-A parser失败沿各自已有边界返回，不查他人存储。
2. 有资格读取自己的completed marker时，先exact replay，再same-key异body冲突。
3. authenticated bootstrap/receipt entitlement失败→AUTH_CONTEXT或SCOPE；不得查询并回显未授权checkpoint状态。
4. 等待/获取锁若失败，只返回实际基础设施分类，不能伪称完成后续语义检查；marker锁后再次执行第2步。
5. 在已授权范围内定位session/checkpoint；跨session/aggregate相关性不符→SCOPE；无法确认来源/伪造记录→UNTRUSTED_CHECKPOINT；持久记录自身矛盾→PERSISTED_STATE_INVALID。
6. 对真实session的新请求，finalized→ALREADY_FINALIZED；open内有效但历史checkpoint→STALE_CHECKPOINT。
7. 已接受ordinal异body→PERSISTED_PAYLOAD_CONFLICT；同body新key→DUPLICATE；其余gap/reverse/kind/order→ORDER。
8. 持久total/预算/生命周期→CAPACITY或SESSION_UNAVAILABLE；再检验target base、跨chunk before/identity/digest与final closure，失败按下表。
9. 准备写集合/结果验证和commit失败→已知ABORT或OUTCOME_UNKNOWN。未获commit证据绝不返回新success。

raw parser同时命中多问题时保留其冻结precedence，不用这个R7-B总序覆盖它。基础设施中断反映停止位置，不伪装成与竞态无关的业务确定性。

## 9.2 分类矩阵

所有类别的“零泄漏”均包含：不回显raw body/claim、食品或家庭私有字段、他户存在性、数据库异常/SQL/stack、stored body、服务端预期digest/token/key。内部遥测也只用经批准的固定分类；side-channel数值证据未建立。

| Stable internal category | 触发 | Retry 属性 | same-result replay | 冻结 contract 情况 |
| --- | --- | --- | --- | --- |
| R7B.MALFORMED | raw语法、token、shape、descriptor、局部事件形状失败 | terminal | 无新失败receipt；重复解析仅可同类拒绝 | 使用现有域parser reason，不发R7B字面值 |
| R7B.AUTH_CONTEXT | 缺失/失效认证、无法证明receipt entitlement | terminal于当前context；可重新认证 | 重新认证且有权限后才可能读既有receipt | R7-B replay contract gap；不冒用shape code |
| R7B.UNTRUSTED_CHECKPOINT | 无服务端来源、伪造ID/digest、认证机制验证失败 | terminal | 只有先行匹配原completed receipt才不进入本失败 | 跨请求authenticity gap；CHECKPOINT_MISMATCH现仅局部相关性 |
| R7B.SCOPE | principal/household/session/aggregate/domain不匹配 | terminal | 禁止跨scope读回receipt | 现有REPLAY_SCOPE_MISMATCH用于局部scope；权限/持久scope映射待冻结 |
| R7B.STALE_CHECKPOINT | 真实旧checkpoint不是current | terminal于该命令 | 先行原key/body completed replay允许；新失败不缓存 | 跨请求稳定code gap |
| R7B.ORDER | gap、reverse、非法kind、count/next关系或跨请求顺序失配 | terminal于观察状态；修复前缀后需重新判定 | 无新失败receipt；不能伪造success | 现有CHUNK_SEQUENCE_OR_ORDER_INVALID仅局部边界；扩用需批准 |
| R7B.DUPLICATE | 已接受ordinal/事件身份再次作为新命令提交 | terminal | 只允许原key/body对应的completed receipt | persisted duplicate gap |
| R7B.PERSISTED_PAYLOAD_CONFLICT | 已接受ordinal/event/command身份对应不同内容 | terminal | 不返回冲突内容或其原receipt | 新稳定code gap |
| R7B.ALREADY_FINALIZED | 有效scope的真实session已final，新请求无completed匹配 | terminal | 原completed final或历史chunk仍可按优先分流返回 | FINALIZATION_INVALID不等于已冻结final-after code；gap |
| R7B.IDEMPOTENCY_BODY_CONFLICT | 本主体key被不同完整body使用 | terminal | 不允许以冲突body读原success | 与command ledger整合及replay reason gap |
| R7B.CAPACITY | frozen四上限，或后续批准的存储/session配额 | 请求固有上限terminal；临时配额耗尽retriable | 已完成原receipt不重复收费；拒绝不缓存 | parser容量已有code；持久预算子类gap，不能共称冻结 |
| R7B.SESSION_UNAVAILABLE | 已过期/abandoned/fence存在且不可续传 | terminal于该session | 仅在批准保留期内原completed receipt可返 | TTL/生命周期与code均未决；不自动回absent |
| R7B.TARGET_BASE_CONFLICT | live目标在session期间变化或不符获准初始态 | terminal于原base | 既有completed receipt可返，不掩盖当前变化 | 不能借command code越过replay result union；gap |
| R7B.HISTORY_INTEGRITY | 跨chunk before/binding/来源、实际event/projection/history digest或final闭合失败 | terminal | 无新失败receipt | existing BEFORE/PREVIOUS/TERMINAL/FINALIZATION仅部分局部语义；跨请求范围待冻结 |
| R7B.PERSISTED_STATE_INVALID | 服务端session/checkpoint/receipt/candidate内部矛盾或损坏 | terminal且需维护处理 | 不返回无法验证的receipt | 新code gap；不把错误记录当caller错误修复 |
| R7B.LOCK_TIMEOUT | 规定锁等待超时 | retriable，原key/body | 重试先查是否已有completed，失败本身无receipt | 新code gap；timeout数值未决 |
| R7B.TRANSACTION_ABORT | 已确认事务回滚，如deadlock/serialization/cancel | retriable，原key/body且有界次数待定 | 后续只重放实际completed；当前失败无success | 新code gap；不能映射SQL细节 |
| R7B.OUTCOME_UNKNOWN | commit结果不可知/连接断开，尚不能证明rollback | 只允许恢复查询；确认原事务终态后才重试写 | 找到原completed→原结果；仍不明→保持unknown | 新code/恢复协议gap；不是terminal业务失败 |

现有两域 replay reasons 是固定 code+ordinal 对：Inventory `22000–22016`，Seasoning `25000–25016`。两域对应 suffix 集合为 INPUT_DESCRIPTOR_INVALID、INPUT_SHAPE_INVALID、HISTORY_CAPACITY_EXCEEDED、EVENT_SHAPE_INVALID、SCOPE_MISMATCH、BEFORE_MISMATCH、INPUT_RESOURCE_LIMIT_EXCEEDED、WIRE_BYTE_CAPACITY_EXCEEDED、CHUNK_EVENT_CAPACITY_EXCEEDED、TOTAL_HISTORY_CAPACITY_EXCEEDED、CHUNK_SEQUENCE_OR_ORDER_INVALID、PREVIOUS_EVENT_DIGEST_MISMATCH、CHECKPOINT_MISMATCH、FINALIZATION_INVALID、TERMINAL_EVENT_DIGEST_MISMATCH、CANONICAL_NUMBER_INVALID、JSON_SYNTAX_INVALID。
不得新增ordinal、扩union、把unknown outcome挤入现有invalid shape，或声称以上gap已Accepted。HTTP status/problem格式、route层401/403/404/409等映射全部留给R7-C/后续contract freeze，本设计不指定HTTP状态。

# 10. Resource/timeout boundaries

| 边界 | 已冻结值 | Owner/设计责任 |
| --- | --- | --- |
| 单chunk wire cap | 1,048,576 UTF-8 bytes | R7-A parser复核已materialized string；R7-C必须在stream materialization前执法 |
| logical history | 10,000 events | R7-A局部声明校验；R7-B按持久actual prefix+n重验并固定total |
| Inventory events/chunk | 17 | 保留R7-A public parser/resource proof，不把超量分片藏进R7-B |
| Seasoning events/chunk | 388 | 同上，不提高上限 |

这四项保持不变。单chunk合规不证明session存储、最终事务内存或服务并发资源合规。

| 资源面 | R7-B内的责任 | 未决/外部边界 |
| --- | --- | --- |
| parser | 消费冻结raw parser的结果，不用仅DTO safeParse代替raw入口；不执行调用方对象getter | frozen深度/节点/字符串等随现有parser；不在本任务改值 |
| 跨chunk计算 | 有界读取已验证prefix/candidate，跨chunk身份集合和摘要计算需要持久/可恢复依据 | final history digest不能简单hash(chunk hashes)冒充原算法；增量算法与内存预算待验证 |
| transaction | 每chunk原子接受；final物化必须整体提交或整体拒绝 | transaction timeout、cancel与commit竞态、重试次数/退避未决 |
| lock wait | 遵守总序，锁后重验时钟/权限/状态，timeout整体rollback | advisory key、lock wait数值、isolation level待冻结 |
| session storage | 对accepted payload、事件、candidate、receipt、checkpoint/fence计费；成功原子占用，拒绝不留配额 | 每户/每主体活跃session数、单session/总存储上限、receipt bytes预算均Proposed/待验证 |
| GC/abandoned | GC不能与final/replay竞争删除恢复依据；须保留不可复用fence/明确过期语义 | session TTL、GC周期/批量、审计保留、如何终止abandoned均未决 |
| request stream/route | 无R7-B实现职责 | R7-C拥有materialization前byte enforcement、route、content-type、request event-loop timeout/concurrency |

17/388是每chunk最大事件数，不是必须装满。10,000事件按满chunk发送分别是589和26个chunk，但这不是会话chunk数量的上界；合法小chunk可达10,000个非空chunk，空历史仅1个only。
因此不能用589/26估算最坏receipt/checkpoint存储。按wire cap乘10,000所得10,485,760,000 bytes仅是很松的派生wire累计上界，不是冻结持久storage quota、内存配置或性能实测。
Proposed per-chunk candidate有助于恢复但仍可能保存大量历史和receipt；final事务不得靠一次构造无限字符串解决，若预算不足应整体拒绝，不能降采样、丢事件或部分final。
会话TTL、认证token有效期、idempotency receipt保留期及terminal fence保留期必须协同。禁止“GC后查不到就当新session/新命令”的重放旁路；终态识别失效时应fail closed。

# 11. Proposed choices

## 11.1 Persistence alternatives

下列是逻辑持久化方式比较，不是表/列/索引/约束/RLS/DDL设计。两方案都不能把成功checkpoint仅存在进程内，也不能只信caller带回prefix。

| 方案 | 逻辑方式 | 安全/恢复 | 复杂度/资源 |
| --- | --- | --- | --- |
| A：per-chunk staging（Proposed推荐） | 每个accepted chunk原子保存验证前缀、完整请求身份、candidate事件/投影、checkpoint和receipt；最终验证后同事务完成获准物化与finalized | crash后有持久prefix，跨chunk before/duplicate可检查；产品live状态在final前不暴露candidate | 需要隔离candidate与live读取，存储/GC更复杂；可避免每次从头构造全部projection，但final仍需预算 |
| B：final-only materialization | 每次仍持久保存接受身份、checkpoint、receipt与足够的不可变历史恢复依据；event/projection的完整派生/物化延后至final | 没有半个live aggregate；final时重新验证全部历史；仅保存digest且既无payload也无server source的版本不可接受 | 临时derived状态可能更少，但final读/计算/事务压力较大；没有持久恢复来源就无法续传，不能用caller重送代替authority |

A中的“staging”保存的是受服务端验证的回放候选前缀，不能把其中caller来源事实升级为approved。B仍需每chunk事务保存协议状态；所谓“final前什么也不持久化”的变体不能满足本任务跨请求replay/order，排除。
两方案都可以在final才使live projection可见。真正取舍是每chunk是否持久维护可继续验证的事件/投影candidate，而不是final-only可以省略session/checkpoint/receipt。
Proposed推荐A：更清楚地保存跨chunk before和恢复依据，便于保证accepted receipt与candidate状态同事务；代价是必须明确隔离、预算、GC和最终物化协议。
若未来选择每chunk直接修改live aggregate，这会产生部分历史对产品可见的新范围，需另行批准；本shadow设计不作此选择。
最终选择、live目标操作语义、事件来源验证、具体schema/DDL/列/索引/唯一约束/RLS/migration/retention全部未决；没有SQL。

## 11.2 Checkpoint authentication alternatives

| 方案 | 提供什么 | 不提供什么 | 取舍 |
| --- | --- | --- | --- |
| opaque persisted lookup（Proposed推荐基底） | 已认证principal/授权scope内从受保护服务端存储取回真实checkpoint；服务端来源提供authority | opaque ID自身不证明持有者权限；UUIDv7不等于secret；不防旧合法checkpoint重放 | 无需把新增token塞入frozen claim；仍需持久current pointer、完整比对及访问隔离 |
| digest correlation | 可把caller声称的值与真实server记录/重新计算内容关联，发现不一致 | 无authenticity、无authorization、无secrecy、无防重放；自洽伪造可任意重算digest | 可作为附加integrity/correlation，不能独立接受checkpoint |
| MAC/authenticated token | 使用受控密钥与经过冻结的编码正确验证时，可证明token为合法issuer签发且未被篡改 | MAC不是加密，不授权household，不证明token是current，不能独立防重放 | key rotation/version/泄漏处置和token承载有复杂度；仍须查询持久session并拒绝过期前缀 |

Proposed：以认证后、严格作用域约束的persisted lookup为authority；checkpointDigest仅作correlation与内容完整性比较。opaque是“无客户端自解释权”的逻辑handle，不依赖不可猜测性作为权限控制。
MAC暂不作为必需机制，也不排除后续审查选择它；任何token不改变persisted replay/order/atomicity责任。
checkpoint canonical bytes、域隔离、key management/rotation、token version/格式/承载、有效期、泄漏撤销和replay处置均未决。opaque ID或MAC泄漏也不能直接让另一principal/household获得receipt或写入权。

## 11.3 其它候选策略

- 新key重复旧ordinal一律拒绝，不创建alias receipt；same-result仅承认原key/完整body的completed记录。
- 对新失败保持持久零写入，不缓存失败receipt、不续TTL、不留下pending marker。
- 最保守的receipt读取资格来自当前已认证主体及服务端批准策略；成员撤回后是否允许读取原安全receipt没有照搬现有self-exit特例，留待批准。
- 采用每household产品流串行逻辑方向，符合既有规划；物理锁key/范围/isolation不能在没有证据时自行冻结。

# 12. Mandatory unresolved decisions

下列全部保留为未决/后续admission blockers；不阻止材料接受独立Design Review，但阻止直接实施或宣称准入。

1. checkpoint authentication最终机制、checkpoint canonical bytes、域隔离、key management/rotation、token version/泄漏撤销/重放处置。
2. per-chunk staging或final-only materialization最终批准；candidate隔离和live可见性；精确replay用途/来源授权以及target base与最终物化语义。
3. 具体表、列、索引、唯一约束、RLS policy、受控权限、migration拆分与内容；没有预写SQL/Drizzle。
4. isolation level、advisory-lock key、无行认领协议、完整锁总序与现有writer/权限撤回/GC的相容性。
5. lock wait、transaction timeout、取消/commit竞态、retry预算和deadline数值；均需实证。
6. idempotency与现有command ledger的复用、key命名空间、完整body encoding/version、receipt读取/重放资格、撤回成员政策。
7. R7-B新failure code/ordinal/contract gap、compound failure precedence、outcome-unknown及恢复协议；现有reason不得擅自扩用。
8. HTTP status/problem、route、content-type、stream、materialization前byte enforcement、request event-loop timeout/concurrency；属于R7-C/后续freeze。
9. session TTL、GC、abandoned session、审计/receipt/checkpoint/fence保留；终态身份不能失忆复用。
10. 活跃session数量、单session/总storage预算、final物化资源界、checkpoint/receipt累计体积与过载公平性。
11. 全历史canonical/digest和跨chunk增量计算、事件before/projection确定性重算；不能把shape/correlation当domain已实现。
12. N-1、rollback、permission manifest、空库/增量/恢复证据计划；`0000–0004`冻结，任何未来`0005`需重新总控签发。
13. **M1 Accepted、G2 admission、总控对`0005`首次migration的正式确认**均未满足；不把ADR-0005这个既有部署ADR的Accepted与migration `0005`批准混淆。
14. 独立Design Review、后续实施任务书和范围授权、精确候选的独立静态/动态证据；R7-A历史CLEAN不能替代。
15. 客户端进程重启后的unknown command恢复与兼容发布边界，仍是项目未完成项。

# 13. Admission prerequisites

当前Entry Gate仅DESIGN_ONLY，本任务终点为交付两份shadow材料。下一步只能由另行授权的独立Design Review评估本候选，Designer不继续review或实施。
实现前需总控批准§12相应逻辑/契约/存储/权限决策并重新签发精确baseline与允许write-set；需要contract变更必须单独冻结，不能临时改R7-A。
M1仍受限、G2未admitted、M2未Accepted、R7-B/R7-C未准入。任何真实source pack、public trust digest或食品/用户数据均不由本文件批准。
未来若准入持久化，须在授权环境取得真实事务/锁/恢复/RLS/权限/N-1及相应产品证据，覆盖§5–§9的并发、final、empty、lost-response和crash invariants，并由独立主体判定；本任务没有执行这些检查。
HTTP/stream整合须由R7-C另行冻结取证；Stage09A、G2、B-r4、compatibility或任何产品gate均未在本任务运行。
只有总控可以基于后续独立证据变更admission/Accepted状态；READY_FOR_REVIEW不跨越任何这些门槛。

# 14. Residual risks

- 这是一份可推理的逻辑设计，没有数据库、资源或并发实证；物理锁/隔离/权限若不能提供这里要求的线性化与原子性，必须阻断后续实施。
- canonical bytes和source/target操作语义未最终批准；在批准前不能通过digest比较获得真实性，不能让caller历史变成live事实。
- 每户串行降低并发推理复杂度，但可能造成锁等待和公平性问题；不能凭设计声称达到延迟目标。
- 10,000逻辑events不等于小存储；小chunk和重复receipt恢复会放大资源压力，TTL/GC需与replay fence协同。
- checkpoint/receipt一旦泄漏，scope控制仍须有效；错误内容可最小化，时间侧信道尚未取证，不宣称密码学常时。
- 数据库特权篡改、工具链、hash/canonical实现和授权撤回协议仍是TCB/后续验证责任；本材料不自证这些执行载体。
- evidence文件自身最终全文SHA-256不能无自引用地嵌入同一字节流；evidence明确区分规范化自摘要与最终全文摘要，最终全文摘要在交付消息和只读命令输出中记录，不虚构自指固定点。
- repo PRE/POST身份与clean状态一致只能证明所观察Git状态；不把上游审计数字、本任务只读材料提取或shadow设计READY外推为R7-B/M2 CLEAN。
