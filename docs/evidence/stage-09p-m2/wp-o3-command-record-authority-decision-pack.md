READY_FOR_FRESH_REVIEW

# Stage 09P-M2 / WP-O3（r3）：command-final fence、commit receipt authority、same-identity 恢复与 retention non-reuse 联合决策候选

> 本文件为 **r3**，在 r0–r2 的 Fresh Review findings 基础上修订。r1 的逐条处置见 §14「修订说明 (r1)」，
> r2 的逐条处置见 §15「修订说明 (r2)」，r3 的逐条处置见 §16「修订说明 (r3)」。
> r3 不改结论上限：仍是 `DESIGN_ONLY` 设计准备材料，`READY_FOR_FRESH_REVIEW` 不等于 `CLEAN`/`Accepted`。

## 1 权限、范围与结论上限

本候选只处理 WP-O1 §10 中仍开放的四个 B 侧（backend）问题：

1. **Q03 command-final no-effect**：B 如何建立一个权威的 command-final no-effect fence，覆盖历史 attempts、
   在途 attempts 与未来 commit 能力；以及一个已知 rollback（E04，只关本 attempt）在何种条件下才允许同一
   身份恢复、何时只有被证明的 fence 或 E03 才开放重执行写，从而与 terminal no-effect 分开。
2. **Q04 commit receipt 与终局矛盾**：commit receipt 背后的原子接受事实是什么；其哪些结果语义不可变、
   哪些只是 delivery metadata；冲突的 C/F 终局证据或不同 original receipt 如何被隔离与治理。
3. **Q06 same-identity 恢复与重新执行**：receipt miss / backend unavailable / known abort 之后，何时只允许
   查询、何时允许原身份重新执行且保证旧 attempts 不会再提交；cancel 与 commit 谁先线性化、如何证明。
4. **Q09 retention 与 non-reuse**：retention 使原结果不可恢复后，还保有哪些不可复用保证，以及哪些事实
   可以被公开知道。

本候选由项目总控在 `codex/stage-09p-m2-inventory` 分支上形成，供后续全新独立 Fresh Review。
`READY_FOR_FRESH_REVIEW` 不是 `CLEAN`、`Accepted` 或 `CONTRACT_FROZEN`。

**结论上限（claim ceiling）**：本候选至多是 `DESIGN_ONLY` 的设计准备材料，处于逻辑层。它不关闭
G-BACKEND、G-OUT、G-ID、G-AUTH、G-LIFE、G-ROUTE、G-ENV、G-BUDGET、G-LOG、G-CLIENT 中任意一项，
不冻结任何 contract，不设计 SQL / DDL / schema / 列 / 索引 / 唯一约束 / RLS / GRANT / migration / lock key /
isolation level，不确定 TTL / GC / retention 数值，不冻结 public DTO / status / reason / ordinal / route，
不新增 client port，不授权任何实现、测试夹具或 runtime 接线。它只把 Q03/Q04/Q06/Q09 从“未决”推进到
“有可独立评审的逻辑候选并附带明确证明义务”。所有涉及 DB、锁、retention、live 语义的选择在获总控
正式裁定前仍是 admission blocker。

固定项目事实（与本候选并存、不因本候选改变）：M1 仍为 `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`；
M1 Fresh Audit A = CLEAN，household-safety 292/292 仅为 LIMITED 动态证据；G2 仍为 `G2_NOT_ADMITTED`；
M2 仍为 `In Progress` 未 Accepted；B-r1/r2/r3 = BLOCK 且 B-r4 未运行；R7-A contracts = Accepted；
R7-B = `R7-B_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`；R7-C = `R7-C_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED` 且 T01–T50 全未执行；
WP-O1/WP-O2 均为 `CLEAN` 的设计准备材料，不是 wire/runtime authority。Q05/Q07/Q10/Q11/Q12 继续开放。

## 2 PRE、输入与方法

| PRE 项 | 精确值（本机实测） |
| --- | --- |
| branch | `codex/stage-09p-m2-inventory` |
| HEAD（branch tip） | `41d47ebfa02313e2f388ae1749b54f4cec3f97d8` |
| tree | `ec66e80cec1c89bb1ea6369df2ac7bcdf3d87ead` |
| worktree（另一工作树） | `main` @ `23450a1f3508e8030d753748291d265ad308df05`，仅 `AGENTS.md` 有未提交改动；本包不读取该改动 |
| 本包基线说明 | branch tip 观测为 `41d47eb`；WP-O2 自述基线为 `41c2e7b`。二者均属同一 archive 谱系；本候选不声称是其直接子提交，也不重算 WP-O1/WP-O2 的 hash stopline |

本轮实际读取的精确源材料（repo-relative path，均在 `codex/stage-09p-m2-inventory` 分支）：

| 材料 | 用途 |
| --- | --- |
| `docs/evidence/stage-09p-m2/wp-o2-command-boundary-entitlement-decision-pack.md` | 结构模板；Q01/Q02/Q08 已决项 |
| `docs/evidence/stage-09p-m2/wp-o2-command-boundary-entitlement-evidence.md` | evidence 结构模板 |
| `docs/evidence/stage-09p-m2/wp-o2-fresh-review.md` | review 结构模板与 residual 清单 |
| `docs/evidence/stage-09p-m2/wp-o1-outcome-evidence-scope-decision-pack.md.raw` | E01–E19 taxonomy、4×7 settlement 矩阵、O01–O16、§10 Q03/Q04/Q06/Q09 原文 |
| `docs/evidence/stage-09p-m2/m2-post-r7-gap-gate.md` | 十 G-* 与 B04/B05/B08、0000–0004 冻结约束 |
| `docs/evidence/stage-09p-m2/r7b-shadow-design.md` | §5.1 12 格状态机、§6 八步逻辑总序、§8.2 崩溃窗口、§9.2 失败分类、§10 资源 |
| `docs/evidence/stage-09p-m2/r7c-shadow-design-r1.md` | settlement 四轴、cancellation ladder、B→C outcome 三态、cross-attempt unknown |
| `docs/evidence/stage-09p-m2/README.md` | archive 身份与材料 stopline |
| `services/api/src/database/schema.ts` | idempotency_records 现状（本地核实） |
| `services/api/src/database/repository.ts` | 幂等读写、replay、tombstone、认证、RLS 相关调用序（本地核实） |
| `services/api/src/utils.ts` | canonicalJson / requestHash 现状（本地核实） |
| `services/api/migrations/0000_stage_06.sql` | 幂等 CHECK/RLS 初始定义（本地核实） |
| `services/api/migrations/0002_stage_08_audit_closeout.sql` | nonReplayable tombstone（本地核实） |
| `services/api/migrations/0004_stage_08_final_closeout.sql` | 409 收窄 CHECK、idempotency RLS 三策略与两处豁免（本地核实） |
| `apps/client/src/core/idempotency.ts` | `CommandId`、`generation`/`authGeneration`、attempt 结算边界（本地核实；r1 新增） |
| `apps/client/src/core/session-store.ts` | 认证 generation（auth generation）语义（本地核实；r1 新增） |
| `apps/client/src/core/command-dispatcher.ts` | stale-attempt 概念（本地核实；r1 新增） |

方法：先固定 legacy 代码的**能力与缺口事实**（§3 的 code grounding），任何逻辑候选都不得与既有机制
矛盾或声称其已存在；再按 WP-O1 的安全依赖顺序（identity → attempt closure → terminal authority →
retention）展开四个问题的候选答案，每个答案携带可被真实证据解除的证明义务。HTTP status、public field、
数据库列、锁实现和 retention 数值均不得反向定义这些语义。

**代码 grounding（本轮本地核实，是只读静态事实，不是动态证据）**：`idempotency_records` 的自然键为
`(user_id, household_id NULLS NOT DISTINCT, method, normalized_route, idempotency_key)`；“完成”没有独立标记，
精确等于 `status_code` 与 `response_body` 同时非空（`idempotency_records_completion_check`）；marker 先以双 NULL
插入、再在同事务 UPDATE 补全，与业务写原子提交，故 legacy 只持久化“已提交结果”，回滚路径不留痕；
`request_hash` 是 canonical JSON（键排序后 `JSON.stringify`）的 SHA-256，不是 Q01 要求的 exact entity body
octets；落库 409 只允许两条 link 路由且必须 `ok=false` / `error.code=CONFLICT`；`expires_at` 只写
`now+30d`、replay SELECT 不带 `expires_at` 谓词、全库无 `DELETE FROM idempotency_records` 与 GC；0002
的 nonReplayable tombstone 保留 key 与完成标识但命中即抛 CONFLICT；`#withAuthenticated` 是有副作用的会话
续期（UPDATE `last_seen_at`/`idle_expires_at` + `setUserContext`），不是 G-AUTH 所需的无副作用调度认证；
household marker 在 membership 失效后默认不可见，仅 `DELETE memberships/{membershipId}` 与 `POST confirm`
两处豁免。

**代码能力的精确边界（这是 r1 对 r0 一处绝对断言的实质更正，处置见 §14 FINDING-C/F）：**
客户端源码中**确实存在** `CommandId`、`generation`/`authGeneration`（认证 generation）与 stale-attempt
概念（`apps/client/src/core/idempotency.ts` L40/L48/L69/L184/L242、`session-store.ts` L54–L56/L69/L76、
`command-dispatcher.ts` L32/L96/L127，本轮本地核实；WP-O1/WP-O2 已把它们登记为既有源码事实）。
但这些是 **(i)** 仅驻客户端内存的 logical 概念；**(ii)** 其中 auth generation 只控制 envelope 绑定与
callback 消费资格，**不改变 logical command identity，不是可复用的 command-identity 载体**
（idempotency.ts L101「envelope 同时绑定 principal、household、owner route 与认证 generation」、
L242「只有创建 attempt 时取得的不可变 commandId 才能结算对应 envelope」）；**(iii)** B 侧**没有任何持久
command / attempt / commit-capability / receipt-entitlement / command-final no-effect 记录**。因此
Q03/Q04/Q06/Q09 要求的服务端 command record、attempt closure、terminal authority 与 non-reuse landmark
能力**均需在 B 侧新建**，不得称其为既存；也不得把客户端的 auth generation 误当同身份/新身份的判定依据、
身份复用载体或 E03 fence。r0 §2 曾笼统断言“代码中根本没有 generation 概念”，该绝对断言不成立，此处已按
本地核实的源码事实更正（并把客户端文件补入上表 read-set）。

## 3 联合决策摘要

### 3.1 Q03 候选答案

`E03 authoritative command-final no-effect` 必须由一个**持久的、单调的、覆盖原身份的 command-final fence**
承载，且只有在同时满足三个合取谓词时才可建立：(a) 不存在任何历史已提交业务效果；(b) 所有相关
`Attempts(C)`（含在途、后台、迟到、已失去观察者者）都已停止且不再持有 commit capability；
(c) 原身份在**未来**也不能再 commit（non-reuse）。一个仅覆盖“当前事务回滚”的已知 rollback 只是
`E04 current-attempt known-no-effect`：它**只关闭本 attempt**，在旧/在途/未来 attempt 状态未知时，它
**只允许原身份下的只读恢复/查询，不允许凭它重做写**；要允许同一身份**重新执行写**，必须另有一个被证明的
fence（确认无任何可提交旧 attempt，即 §6.2 (a)）或原命令已由 E03 终局为 F（§6.2 (b)）。**E04 单独
绝不等于 E03，也不单独开放重执行写。** 重执行写的唯一规范定义见 §6.2 的 (a)/(b)；(a) 仅由 P-a ∧ P-b 构成，
**不**含 P-c（r1 收敛、r2 统一；见 §14 FINDING-A/E、§15 F-2）。
cancel 确认本身不是 E03 证据，除非它证明取消在**任何 commit 之前线性化**并且关闭了未来 commit 能力。没有真实闭包/线性化
能力时不得发布全命令 no-effect 承诺，不得设临时 DTO 或 SQL。

### 3.2 Q04 候选答案

commit 的权威原子事实是**唯一的 commit 线性化点**（R7-B §6 的 commit 步）在单一事务内原子接受并留下
可被独立复验的 original receipt；`E01` 与该 receipt 的 `E02` 权威重放是唯一足以证明原 operation 成功的
证据。original receipt 的**不可变结果语义**为：命令结果 payload 的领域语义、其绑定的结果版本/状态、
以及“已提交”这一事实；**delivery metadata** 为：本次 delivery 的 requestId、`replayed` 标志、
`firstProcessedAt` 的展示、transport 时序、以及任何仅描述“这次投递”的字段。二者必须在语义上分离，且
replayed=true、当前 requestId、时序都不得被当作结果语义或结果真伪的证据。相互冲突的 C/F 候选或两个
不同 original receipt 必须**隔离并暂停依赖流程的新写/next**，交治理处置，禁止 last-response-wins 或多数
投票，禁止把它表达为正常的新业务结局，禁止新增公开异常码。

### 3.3 Q06 候选答案

越过 transport handoff 后，receipt miss / backend unavailable / known abort 一律**只允许在原身份下做
查询/只读恢复**，绝不允许凭 miss 或 timeout 重做写。原身份重新执行的许可条件只有两类：(a) 原命令仍为
`N` 且一个被证明的 fence 证明确实不存在可提交的旧 attempt，或 (b) 原命令已由 `E03` 终局为 `F`。cancel 与
commit 的线性化由**单一 commit 点**裁决：cancel 若在 commit 点之前取得获准顺序，则本次 attempt 不得产生
业务效果（可归 E04 或 E03，取决于范围与未来能力是否关闭）；cancel 若不能在 commit 点之前线性化，或
无法证明，则结果是 unknown，不是确定失败。具体 persisted lookup / 锁 / isolation / 取消机制另行授权，
本候选不选。

### 3.4 Q09 候选答案

retention 可以删除或使原结果 payload 不可恢复，但**不得**使原身份变成新命令。结果可恢复性与身份
可复用性是两个独立事实（WP-O1 §4.2 I-12）：即使 receipt 不可读，**只要该 identity 曾越过 transport handoff
（无论其后是 N/U/C/F，即“可能已 commit”），就必须保留一个不可复用 fence**（non-reuse landmark），使同
identity 的未来请求不得作为全新命令执行；**不得**以“尚未记录为 C / 未曾 E03 终局”为条件排除 U/N。
（r1 更正 r0“只要曾 commit”的过窄触发；见 §14 FINDING-H。）retention
后可以公开知道的事实是**有限、随状态而异、且不超出所声明状态的**（state-relative；不得跨状态套用同一措辞，也不得由任一状态推出该状态未声明的结论）：
`C` —— 该 identity 曾被接受（存在已提交结果），但其原结果现已**不可恢复**；`N`/`U` —— 该 identity
**是否曾存在结果属 UNKNOWN**，未确认、未结算且恢复受阻，**不得**被表述为“曾被接受”（那是把缺失证据当成功、
把 absence 当 commit 的 false-success 披露）；`F` —— 该 identity 已被**终局关闭**（E03 后），不能再以“重做
原命令”方式使用。**不得由 retention 或任何记录缺失/不可读推断**并公开为“未提交 / 无效果 / 可换 key 重做 /
从未存在”（即禁止把 absence 当成 no-effect 证明）；此禁止只约束由 absence/retention 的推断，**不**禁止披露
已由 `E03` 建立的 `F` 终局 no-effect（§4.1 明定 `F` 的逻辑含义即 E03 command-final no-effect）。本表从属于
§7.2.2（即 §7.2 第 2 条）：absence 或不可读本身**既**不构成 any no-effect 证明、**也**不构成任何“曾被接受”的
肯定证明，必须 fail closed。本包不裁定复用策略或 TTL / GC 数值。

## 4 Q03：command-final no-effect fence

### 4.1 固定逻辑常量

| 常量 | 值 / 定义（逻辑层，非 DB / 非 DTO） |
| --- | --- |
| 唯一负向终局证据 | `E03 authoritative command-final no-effect`（WP-O1 §5）；仅此可把 `U`/`N` 结算为 `F` |
| attempt-local 负向证据 | `E04 current-attempt known-no-effect`（单次 rollback/agent 中止）与 `E05 trusted predispatch rejection`；均只关闭本 attempt |
| 终局单调 | `F` 一旦建立即不可升为 success；`C` 一旦建立即不可降为 failure（WP-O1 I-03） |
| fence 覆盖维度 | (1) 历史已提交效果 (2) 在途/迟到/后台 commit capability (3) 未来 same-identity commit capability |
| fence 性质 | 持久、单调不可回退、可被任何后续请求独立复验 |
| 版本载体 | 继承 Q01 的 `identityPolicyVersion` + identity key；fence 绑定 exact identity key，不绑定 session/ordinal/requestId |

`E03` 与 `E04` 的边界是本问题的核心，必须在逻辑上完全可分：E04 是“这一次执行没有产生效果，且不排除
旧/未来 attempt”，E03 是“命令整体没有已提交效果，且所有可能产生效果的通路都已关闭”。二者不能被同一
个“回滚成功”信号混同。

### 4.2 候选答案

**建立 E03 的三个合取谓词（缺一不可）：**

```text
P-a  no historical commit
     不存在任何属于 Attempts(C) 的、已越过 commit 点并原子接受的业务效果。

P-b  all relevant attempts stopped
     Attempts(C) 中每一次执行都已确定不再持有 commit capability：
     无排队、无在途、无后台续写、无迟到工作、无客户端已失联但服务端仍在进行的提交。

P-c  future commit impossibility (identity fence)
     原 identity key 在未来也不能再 commit：任何 later attempt（同 key + 同 request binding，
     或同 key 的其它 binding）都不得绕过该 fence 重新执行原命令。
```

**关键区分（known rollback that still permits retry vs terminal no-effect）：** 下表第 4 列区分的是
**“是否允许同一身份重新执行写”**（re-execute write），与“是否允许只读恢复/查询”是**两个不同问题**。
r1 更正了 r0 该表对 E04 行的宽松读法（见 §14 FINDING-A/E）：E04（本次事务 rollback 且旧 attempt 状态未知）
**不**单独开放重执行写。

| 观察 | attempt 结论 | command 结论 | 是否允许同一身份**重新执行写**（≠ 只读恢复/查询） |
| --- | --- | --- | --- |
| 本次事务 rollback，旧 attempt 状态未知 | E04 | 保持 N（若有未排除旧 attempt 则 → U）或旧 U | **不允许**重做写；只允许原身份**只读恢复/查询**。重执行写的**唯一**规范许可是 §6.2 的 (a)/(b)，须直接满足该处定义（(a) 仅由 P-a ∧ P-b 构成、**不含** P-c，且不把命令升为 `F`）；本表任何一行（含 E03/F 行）都**不单独**构成该许可 |
| 本次事务 rollback，且已获准证明无任何其它 attempt 且未来 commit 被 fence 关闭 | (升级) E03 | F | 不允许以“重做原命令”方式；只能新建独立业务意图 |
| 取消请求得到确认，但无法证明其先于 commit 线性化 | 不足以定 E04/E03 | U | 允许只读恢复；不得重做写 |
| 取消在 commit 点之前线性化，且未来 commit 被 fence 关闭，且无历史效果 | E03 | F | 不允许 |

**唯一的两个重执行写许可（本包以 §6.2 的 (a)/(b) 为唯一定义；r2 已统一 (a) 的谓词）：** (a) 原命令仍为 `N`
**且**存在被证明的 fence 确认无任何可提交旧 attempt——**仅**由 P-a（无历史已提交效果）与 P-b（所有相关
attempt 已停、无在途/迟到/后台 commit capability）两谓词构成，**不**含 P-c；(b) 原命令已由 `E03` 终局为 `F`
后，基于独立重新校验的业务意图创建新 command。**边界区分（r2 澄清）**：P-c（未来 same-identity commit
impossibility）只是 E03 的第三谓词、只属 F 路径；(a) 只到 P-a ∧ P-b 为止，故 (a) 不是 E03、不把命令升为 F。
除这两类外，E04/E05/E07/E08/E09 的任何组合都**不**开放重执行写。

**cancel 确认是否足够：** 不足以单独构成 E03。取消确认必须携带“取消相对于 commit 点的顺序证明”以及
“未来 commit capability 已关闭”的证明；仅有“客户端/中间层已在某时刻发出 cancel 且返回 ack”不满足 P-b
与 P-c。R7-C §9 的 cancellation ladder 明确：dispatched 之后 C 只请求 B 停止，不自行 cancel SQL/释放连接/
commit/rollback；只有 B 证实 known-no-effect 才归已知中止。因此命令级终局只能由 B（而非 C 或 HTTP 层）
宣告。

**fence 与 legacy 的关系（不得越权声称）：** 现有 `idempotency_records` 的“未完成 marker”**不是** no-effect
fence——它只阻断重放（读时抛 `INTERNAL_ERROR 'Idempotency record is incomplete'`），不阻断重新执行，且事务
回滚后即消失（repository.ts:730–740, 833–873）；现有 `nonReplayable` tombstone 只保留 key 与 non-reuse、
命中即抛 CONFLICT（repository.ts:777–787；0002:524–566），它可作 Q09 的一个**局部先例**，但不是通用的
E03 fence，也不提供历史/在途覆盖证明。本候选要求在**全新机制**上实现 P-a/P-b/P-c，不得把上述任一 legacy
形态冒充为 command-final fence。

**系统当前不具备 P-b/P-c 的证据能力**：代码没有 attempt 记录、没有后台续写登记、没有取消确认、没有
未来 commit 关闭机制。因此本候选的结论是“E03 的语义边界被固定”，而**不是**“E03 现在可实现”。

### 4.3 与 Q01 · Q02 · Q08 已决项的关系

- **Q01**：fence 必须绑定 Q01 的 exact identity key；它不得因 body/session/ordinal/版本改变而移动
  namespace（否则攻击者可改 body 绕过 fence，见 WP-O2 §4.5）。fence 覆盖的是 identity key 本身。
- **Q02**：`Attempts(C)` 的全集正是 P-b 的量化域。Q02 已定“purported attempt 数量/序号/内存状态不能证明
  全集”，因此 P-b 只能由具备服务端执行侧登记能力的 owner 证明，不能由 client 自述。
- **Q08**：建立 E03 需要 auth 可见性（当前被撤权/不可见的 attempt 可能仍持有 commit capability）。
  execute entitlement 的 B 授权决策点是 P-b 的观察窗口；receipt entitlement 只影响 disclosure，不影响
  fence 的存在与单调性。

### 4.4 需要的证明义务与它如何被真实证据解除

| 义务 | 解除它的真实证据（当前均为 0） |
| --- | --- |
| O3-1 历史无 commit | 在 commit 线性化点上可复核的“无已接受效果”登记；跨所有相关 attempt 的可信查询 |
| O3-2 在途/未来能力关闭 | 服务端执行侧的 attempt/capability 登记 + 关闭协议；一个能证明“关闭先于任何后续 commit”的线性化证明 |
| O3-3 fence 持久且不可回退 | 崩溃/GC/恢复交错下 fence 不丢失、不被复用的证据（对应 R7-B §8.2 GC 与恢复交错窗口） |
| O3-4 取消与 commit 的次序证明 | E04/E03 区分所需的 cancel-race 动态证据（R7-C T33；WP-O1 O02；本包 W20/W27） |

任何一项无真实证据时，不得声明 E03 可实现，不得关闭 G-BACKEND。

### 4.5 不成立的边界

- 把单次 rollback、所有“当前可见请求”失败、无 receipt、`retryable=false`、可信 predispatch rejection、
  B call=0 或“这是唯一已知 attempt”当成 E03 → 不成立。
- 把未完成 marker 或 nonReplayable tombstone 当成 command-final fence → 不成立。
- 先返回 no-effect 再异步关闭未来 commit capability → 不成立（违反 fence 的原子与单调）。
- 用取消 ack 单独建立 E03 → 不成立。
- 用进程内锁或无持久依据的内存状态充当 fence → 不成立（无 marker/session 行也必须由持久 non-reuse
  fence 保护，R7-B §6 step4/5 与 I11）。

## 5 Q04：commit receipt 原子 authority 与终局矛盾治理

### 5.1 固定逻辑常量

| 常量 | 值 / 定义 |
| --- | --- |
| 唯一正向终局证据 | `E01 authenticated authoritative command commit receipt`；`E02` 为其原不可变 receipt 的权威重放，结算力等同 E01 |
| 原子接受点 | R7-B §6 八步逻辑总序的 **commit 步**是唯一接受线性化点；commit 前不公布 success |
| 不可变结果语义 | 领域结果 payload 语义、其绑定的结果版本/状态、以及“已提交”事实 |
| delivery metadata | 本次投递的 requestId、`replayed` 标志、`firstProcessedAt` 展示值、transport 时序，及任何仅描述“这次投递”的字段 |
| 终局互斥 | 真正的 command-final commit 与真正的 command-final no-effect 不应同时成立 |
| 矛盾处理 | 隔离证据、暂停依赖流程新写/next、交治理；不 last-response-wins，不新增公开异常码 |

### 5.2 候选答案

**哪一原子接受事实足以证明成功：** 只有当一次执行在 commit 点以单事务原子接受，并把“命令身份 +
request binding + 结果语义”作为一个不可分割的结果持久下来时，这个接受事实才足以证明原 operation 成功。
仅“知道 COMMIT 了”、仅 marker `completed`、仅 HTTP 2xx、仅一个合法 checkpoint、仅内存 receipt 或
caller `server_verified` schema 形状都**不足**（WP-O1 §5 E01 行）。原因是这些信号可能不绑定原命令的完整
identity/binding，或可能只是本次投递的产物。

**original receipt 的不可变 vs delivery metadata：**

| 维度 | 分类 | 理由 |
| --- | --- | --- |
| 领域结果 payload 语义 | 不可变结果语义 | 它描述命令产生的业务事实；不得被 current checkpoint 改写 |
| 结果绑定的版本/状态（resulting version/state） | 不可变结果语义 | 它是接受点的产物；后续状态推进不得回写它 |
| “已提交”事实 | 不可变 | C 单调（WP-O1 I-03/I-05） |
| 命令身份与 request binding 的相关性 | 不可变 | receipt 必须与原 identity/binding 精确相关（Q01） |
| requestId（本次投递） | delivery metadata | 每次投递不同；不得作为结果真伪证据 |
| `replayed` 标志 | delivery metadata | replay 是投递属性；`replayed=true` 不是证明（WP-O1 E02 行） |
| `firstProcessedAt` 展示 | delivery metadata | 面向展示；不是接受点权威 |
| 传输时序 / response attempt | delivery metadata | 不改变接受事实（WP-O1 I-05） |

与 legacy 的对照（不得越权声称）：现有 replay 返回的 `meta.idempotency` 携带 `replayed:true`、
`firstProcessedAt`、`originalRequestId`（repository.ts:788–806）——这些正是 delivery metadata；现有代码把
“原 data”和这些 metadata 混在同一个 `{ok,data,meta}` envelope 中，因此 M2 若要实现 Q04 的分离，属于**新增
语义设计**，不能声称 legacy 已有 original receipt 的不可变/投递二分。legacy 落库的 409 CONFLICT 仅两条 link
路由（0004:95–116），不是 M2 的 original receipt 终局。

**冲突 C/F 或不同 original receipt 的隔离与治理：**

1. 若同一 identity 出现“貌似权威 commit receipt”与“貌似权威 command-final no-effect”两个候选，二者都应被
   视为**证据冲突候选**，不得自动择一；暂停该流程的新写、next chunk 与自动推进。
2. 若出现两个不同内容的 original receipt（同一 identity 的两个不同结果语义），同样隔离并暂停；这是
   **一致性异常**，不是普通的新业务结局。
3. 保持此前**已验证**结果的单调性，同时阻断依赖证据的消费；查明某候选不具 authority 属治理处置，不得由
   client 自动改写事实，不得为冲突发明新的公开异常码（WP-O1 §6.3 结语、O14）。
4. 冲突未解释清楚前，相关联合准入与实施继续阻断（WP-O1 §10 Q04 阻断条件）。

### 5.3 与 Q01 · Q02 · Q08 已决项的关系

- **Q01**：original receipt 必须与 Q01 的 exact identity key + request binding 精确相关；receipt 读取资格
  不等于 execute 资格。
- **Q02**：E01 只在越过 handoff 后才有意义；attempt-local 404/409 等不得伪造 receipt。receipt 的“原样”
  语义要求重发首次封存的同一 serialized byte sequence，不得再次 `JSON.stringify`（Q01/D03）。
- **Q08**：receipt 交付受独立 receipt entitlement 与 release authorization point 约束；release point 先于 revoke
  的已释放 bytes 不可撤回；receipt entitlement 丢失不否定已提交事实（WP-O2 §6.2）。

### 5.4 需要的证明义务与它如何被真实证据解除

| 义务 | 解除它的真实证据 |
| --- | --- |
| O4-1 commit 原子性 | 多写集合（业务效果 + 结果 receipt）在同一事务/fence 内原子接受或整体拒绝的真实证据（R7-B I12；本包 W22） |
| O4-2 original receipt 的不可变结果语义与 delivery metadata 分离 | 一份获准的语义切分 + “current checkpoint 不能改写历史 receipt”的动态反例（WP-O1 O04） |
| O4-3 冲突治理流程 | 一份可审查的治理规程 + C/F 冲突动态反例（本包 W25/W26）；不能只给客户端自动规则 |
| O4-4 receipt 相关性与 entitlement | commit 后 serialize/send/finish/client-receive 任一点失败仍能凭原身份读回原 receipt 的真实证据（WP-O1 O03、W10） |

### 5.5 不成立的边界

- 只知 COMMIT 或 marker completed 就宣布成功 → 不成立。
- 把 `replayed=true`、current requestId、`firstProcessedAt` 或 transport 时序当作结果语义或结果真伪证据 →
  不成立。
- 用 current checkpoint / 最新聚合代替 original receipt → 不成立（WP-O1 I-06）。
- C/F 冲突时 last-response-wins、按响应到达顺序、或多数投票 → 不成立。
- 为冲突新增 public reason/ordinal/problem code，或把 B internal category 原样塞入 public 字段 → 不成立。
- 通过运行时删字段把 original receipt 投影成“公共安全版本”以绕过冲突 → 不成立（须由 Q05/G-OUT 另设 envelope）。

## 6 Q06：same-identity 恢复与重新执行

### 6.1 固定逻辑常量

| 常量 | 值 / 定义 |
| --- | --- |
| 只读恢复前提 | 越过 handoff 后 receipt miss / backend unavailable / known abort 一律归“只查不写” |
| 重执行许可的两类 | (a) 原命令仍为 N 且有被证明的 fence 证明确无可提交旧 attempt；(b) 原命令已终局为 F。**E04/E05/E07/E08/E09 单独都不属于这两类** |
| 单一线性化点 | commit 点是唯一接受线性化点；cancel 必须相对它有序 |
| unknown 的顽固性 | 跨 attempt 未知性是独立 latch；仅覆盖单次 attempt 的后来拒绝不能清除它（**R7-C r1 §11 正文（line 228「跨attempt未知性必须是独立latch」，无 R1-INV-* 编号）**；WP-O1 §4.2 I-02） |
| 恢复通路 | 只在原身份下、经获准通路执行；不得换 key / 改 body / 补造 checkpoint（WP-O1 I-08） |

### 6.2 候选答案

**默认（命令尚未由下方 (a) 或 (b) 关闭时）——何时只查询：** 只要命令尚未被 (a) 或 (b) 关闭，且当前观察
落在以下任一项，就只允许查询/只读恢复，不允许重新执行写：

- 当前 observation 是 `E07`（timeout/abort/cancel unconfirmed/reset/no response）；
- 当前 observation 是 `E08 receipt temporarily not found` 或 `E09 backend unavailable`；
- 当前 observation 是 `E04 current-attempt known-no-effect`（它只关闭本 attempt）；
- 当前 observation 是 `E11`（malformed / 不相关 / 跨 scope，或 wrong key/body/version/operation 的响应）：
  ignore 其结算与页面副作用，只等待本命令的权威响应；若存在未排除的执行窗口则建立 `U`（不得凭该响应重做写，
  也不得据其内容披露）；
- 既往已有 `U` latch，且新观察只覆盖本 attempt。

在这些情况下，客户端转/保持 `U`：凡存在 dispatch 或交付不明窗口（E07/E08/E09/E11，或 E04 之后仍有未排除的
旧 attempt），**必须建立 U latch，不得停留在原 `N`**（WP-O1 §6.3 `N | inconclusive/unknown` 行要求“有
dispatch/交付不明窗口则 U”；§4.2 I-02 要求 cross-attempt unknown 是不可删除的独立事实，deadline 到期也
不能删除它）。只有在能**完整证明从未越过 handoff** 时才维持 `N`（WP-O1 §6.2(1)）。恢复只在原身份下、经获准
通路执行，等待 `E01/E02` 或 `E03`；**不得**凭 miss/timeout 重做写，不得换 key，不得创建新 namespace。
（r1 删除了 r0 此处的“或原 N”宽松读法；见 §14 FINDING-G。）

**为什么上列观察本身不能开放重执行：** 上列每一项都只说明“尚未证明旧 attempt 不会 commit”，而**不是**
“已证明不存在可提交的旧 attempt”。上列中的 E07/E08/E09/E11 **不构成** (a)；它们只是“未证明”的默认。(a) 的
地位高于该默认：**当且仅当** (a) 所需的 fence 被独立证明时，命令才离开“只查询”默认并进入 (a)。因此 (a)
并未被上列封死；§6.2 三处（默认、(a)、(b)）互不冲突（r1 修复 r0“只查询列表使 (a) 不可达”的不自洽；
见 §14 FINDING-A）。**本节 (a)/(b) 是本包重执行写的唯一规范定义**：(a) 仅要求 P-a ∧ P-b，**不**含 P-c
（P-c 只属 E03/F 路径；§15 F-2）。

**何时允许原身份重新执行且保证旧 attempts 不会再提交：** 必须由 B 侧提供**两类**之一：

```text
(a) 原命令仍为 N：存在一个被证明的 fence，证明确实不存在任何可提交的旧 attempt
    （P-b 在“无历史效果”前提下成立）。此时允许在原 identity 下重新执行；
    重新执行仍须逐 attempt 重过 route/auth/budget/B admission。
(b) 原命令已为 F：由 E03 关闭原身份后，原命令不得被“重做”；
    只能基于一个独立、重新校验（必要时重新确认）的业务意图创建新 command。
```

关键约束：允许 same-identity 重试**不等于**允许跳过门禁。每次重试是新的 attempt，必须重过全部入口校验；
“same identity”不是 replay 通行证。

关键约束（r1 补充）：**E04（本次 rollback、旧 attempt 未知）单独不足以进入 (a)。** (a) 要求 P-a/P-b 级的
证明——无历史已提交效果 **且** 无任何可提交旧 attempt——而不是“本次事务回滚”这一观察。(a) 中的 `N` 指
“已被 fence 证明无旧 attempt、无历史效果的 N”，与“存在未排除 dispatch/交付窗口、因而必须为 `U` 的 N”是
两回事。(a) 的谓词到此为止——P-c 只属 E03/F 路径，不在 (a) 内（§15 F-2）。

**cancel 与 commit 谁先线性化、如何证明：**

1. commit 点是唯一接受线性化点；所有 cancel 只有相对它有序才有意义。
2. **cancel 先**：若 cancel 在 commit 点之前取得获准顺序（由 B 侧 commit 点可观察），则该 attempt 不得产生
   业务效果；结论是 E04（若仅本 attempt）或 E03（若同时满足 P-a/P-b/P-c）。
3. **commit 先**：若 commit 已原子接受，则命令事实保持 committed，之后的 cancel 不追溯改写；client 只应
   拿回原 receipt（E01/E02）。
4. **无法证明顺序**：保持 unknown，不生成确定失败，不更换 key。取消“已发出但未确认”不能由 C 推断 DB
   no-effect（**R7-C r1 §9「Cancellation ladder」step 4 正文（line 167：只有 B 证实 known-no-effect 且原操作
   不再可能 commit，才可归已知中止；无 R1-INV-* 编号）**；WP-O1 §6.3 `N | inconclusive/unknown` 与 O02 行）。
5. 证明方式：需要一个可复核的“cancel 与 commit 的相对顺序”证据（commit 点上的可观察序或等价 fence），
   而不是客户端时序或 ack。具体锁/隔离机制另行授权，本候选不选。

### 6.3 与 Q01 · Q02 · Q08 已决项的关系

- **Q01**：恢复必须使用原 exact key/body/operation；更正后的输入不得沿用原 key 改 body，也不得换 key 重做
  同一用户意图（WP-O2 D02/§5.4）。
- **Q02**：只有越过 handoff 才有“不能再提交”的问题；handoff 前若满足 L01–L08 的纯本地取消是唯一无需服务端
  command-final evidence 的例外，本问题不重开它。
- **Q08**：重新执行需要当前 execute entitlement（每 B 决策点重验）；只读 receipt replay 只需独立 receipt
  entitlement，可在 execute 已丢失时仍被允许（但不得重跑 domain operation / 延长 TTL / 写 marker）。

### 6.4 需要的证明义务与它如何被真实证据解除

| 义务 | 解除它的真实证据 |
| --- | --- |
| O6-1 “只查不写”默认在 B 侧成立 | B 入口在 miss/unavailable/abort 下拒绝一切写但允许恢复查询的真实证据 |
| O6-2 两类重执行许可的判定能力 | B 能区分 N-with-fence 与 F 的可复核状态；不能只凭 client 声明 |
| O6-3 cancel/commit 顺序证明 | cancel-race 的动态证据（R7-C T33；WP-O1 O02；本包 W20/W27） |
| O6-4 重试不跳过门禁 | same-identity retry 逐 attempt 重过 route/auth/budget/admission 的动态证据 |

### 6.5 不成立的边界

- 凭 receipt miss 或 timeout 重做写 → 不成立（Q03/Q06 直接禁止）。
- 用“当前事务已知 rollback”推出全命令 no-effect 或允许无约束重做 → 不成立。
- 把 E04（本次 rollback、旧 attempt 未知）单独当作开放**同一身份重执行写**的依据 → 不成立（E04 只关
  本 attempt；重执行写须 (a) 已证明 fence 或 (b) E03→F）。
- 在存在 dispatch/交付不明窗口时停留原 `N` 而不建立 `U` latch → 不成立（WP-O1 §6.3、I-02）。
- 换 key / 改 body / 补造 checkpoint 来“恢复” → 不成立。
- 把 cancel ack 或“客户端已超时”当作 cancel 先于 commit 的证明 → 不成立。
- 用仅覆盖本 attempt 的后来 4xx 清除既有 U → 不成立（跨 attempt unknown 是独立 latch）。
- 把 same-identity retry 当作跳过 route/auth/budget/B admission 的 replay → 不成立。

## 7 Q09：retention 与 non-reuse

### 7.1 固定逻辑常量

| 常量 | 值 / 定义 |
| --- | --- |
| 两条独立事实 | 结果可恢复性（recoverability）与身份可复用性（non-reuse）**分开**（WP-O1 I-12） |
| retention 允许 | 使原结果 payload 不可恢复（删除/过期可达性下降） |
| retention 禁止 | 使原 identity 变成新命令；由 GC/absence 开放重做 |
| 终局失忆禁止 | 终态身份不能失忆复用（R7-B §12.9） |
| 失败关闭 | 无法证明终局时不开放重做；retry deadline ≠ retention |

### 7.2 候选答案

**retention 后仍保有的不可复用保证：**

1. **non-reuse landmark 必须存活，且覆盖所有“可能已 commit”的身份**：landmark 义务附着于**任何曾越过
   transport handoff 的 identity**——无论其后处于 `N`/`U`/`C`/`F`——都必须保留一个持久、单调、不可复用的
   标记，使该 identity 的未来请求不得作为全新命令执行。**不得**以“尚未记录为 `C`”或“未曾由 E03 终局”为
   条件把 `U`/`N` 排除在 landmark 义务之外——`U`/`N` 恰是“可能已 commit 但尚未记录”的状态，正是最需要
   non-reuse 保护的情形（WP-O1 §4.2 I-12「结果可恢复性与身份可复用性分开；retention/GC 不允许旧 identity
   因失忆变新」**不以『曾 commit』为条件**；WP-O1 §6.3 `F | retention-unavailable` 行亦要求“旧 identity 仍
   不得默认为可复用”）。唯一豁免：能**完整证明**该 identity 从未越过 handoff（§6.2(1)）。这个标记只承载
   “该身份已被占用/不可作为全新命令”的事实，不承载结果 payload。（r1 更正 r0 把触发条件限定为“曾 commit（或
   曾被 E03 终局）”，从而排除 `U`/`N` 的漏洞；见 §14 FINDING-H。）
2. **禁止 GC 造成重放旁路**：GC 与恢复交错时，不得出现“查不到即新 session/新命令”的旁路；终态识别失效
   必须 fail closed（R7-B §8.2、§10、§5.1）。此 fail-closed 规则**同时覆盖“commit 结果未知”这一非终态
   失忆**，而不仅覆盖“终态识别失效”：记录/landmark 缺失不得被解释为“从未提交”或“可复用”，只应是
   “可能已 commit、按 §6.2 保持 `U` 且恢复受阻”。（r1 补充；见 §14 FINDING-H。）
3. **身份不可因版本/重新登录而重置，且 non-reuse 不得静默依赖 namespace 相等**：不同版本、重新登录、新
   session 都不得把旧 identity 当新空间；只能按 Q01 的 namespace + Q10 的版本兼容规则处理旧 unknown 的
   恢复或隔离。**独立义务（r3 新增，登记为 O9-5）**：Q01 令 `identityPolicyVersion` 属于 identity key 的成员，
   故版本变化会移动 namespace；§7.2.1 的 non-reuse landmark **不得**以“新请求的 namespace 与旧 landmark 的
   namespace 相等”为唯一门槛——否则一次版本升级/重新登录即可把同一用户意图当作全新命令执行，而原命令
   （可能已 commit 但不可读）仍为未知（即攻击面 (d) 的变体）。因此必须提供一条**可独立核验**的 non-reuse
   义务：**要么**证明该 landmark **跨越 identity/版本重绑仍然存活**（不被版本重绑清除或旁路），**要么**为该
   重绑**显式设定边界**（在 Q10 冻结的边界内，旧 unknown 未被解决前，旧身份不得被当作新空间执行）。该义务
   的机制（landmark 载体、版本边界）属 Q10，**本包不冻结任何版本值或机制**；在 Q10 关闭前，O9-5 **仍是
   admission blocker**，不得写成 gate closed。

**retention 后可以公开知道的事实（有限、随状态而异、不超出所声明状态 —— state-relative，不得跨状态套用，也不得由某一状态外推其他状态）：**

- `C`：该 identity 的原始命令**曾被接受**（存在已提交结果），但其原结果现已**不可恢复**；
- `N`/`U`：该 identity **是否曾存在结果属 UNKNOWN** —— 未确认、未结算、恢复受阻；**不得**公开为“曾被接受”
  （把缺失证据当成功、把 absence 当 commit 的肯定声明属 false-success 披露）；
- `F`：该 identity 已被**终局关闭**（E03 后），因此不能再以“重做原命令”方式使用。

**状态优先级（与 §7.2.2 的关系）**：上表按当前 command 状态择一披露；状态为 `N`/`U` 时，§7.2.2 的
“absence/不可读不构成 no-effect 证明”**同时**要求其**也不构成**任何“曾被接受”的肯定证明——两者都是 fail-closed
的否定披露，`N`/`U` 只能讲“结果未知且恢复受阻”。**不得由 retention 或任何记录缺失/不可读推断并公开/表达为**：
“未提交 / 无效果 / 可换 key 重做 / 从未存在”。结果不可读**不**产生任何 no-effect 结论，**也**不产生任何 commit
结论；此禁止针对由 retention/absence 的推断，已由 `E03` 建立的 `F` 终局 no-effect 属有据事实，仍按上表 `F`
行披露（§4.1）。无终局证据时保持 `U` 且恢复受阻；有 C/F 时保持 C/F。

**legacy 对照（不得越权声称）：** 现有 `expires_at` 只写 `now+30d`、replay 不读、无 GC、无
`DELETE FROM idempotency_records`（repository.ts:702–719, 856；0000:277–304），因此 **legacy 提供零 retention /
non-reuse 保证**；0002 的 nonReplayable tombstone 保留了 key 与完成标识且命中即抛 CONFLICT，
是“不可读 receipt 但保留 non-reuse”的一个**局部先例**，但**不是** M2 的通用 retention 策略，不得把既有 30 天
或 legacy tombstone 泛化为 M2 政策（WP-O1 O08）。Q09 的 retention 语义必须**新建**。

### 7.3 与 Q01 · Q02 · Q08 已决项的关系

- **Q01**：non-reuse 绑定 exact identity key + namespace；body/session/ordinal 改动不得移动 namespace，否则
  retention 后的“新 body 变新空间”会成为绕过 non-reuse 的旁路。
- **Q02**：retention 不改变 attempt 全集语义；retry deadline 与 automatic retry 停止**不**等于 retention，
  也不关闭 command（WP-O2 §5.4）。
- **Q08**：retention 后若 receipt entitlement 不再可满足，只影响 disclosure，不否定已提交/已终局事实，也不
  产生新的 no-effect（WP-O2 §6.2）；不同 principal 仍不得读取旧命令。

### 7.4 需要的证明义务与它如何被真实证据解除

| 义务 | 解除它的真实证据 |
| --- | --- |
| O9-1 non-reuse landmark 在 GC/恢复交错下存活 | R7-B §8.2 GC 窗口 + “查不到不复用”的反例（本包 W30/W31） |
| O9-2 结果不可恢复不产生 no-effect | retention 后恢复受阻仍维持 U/C/F 且不放行的动态证据 |
| O9-3 公开事实的受限度（state-relative）与不披露边界 | 一份获准的公开语义（须由 Q05/G-OUT 定义）+ 无 existence oracle 的反例 |
| O9-4 版本兼容不重置身份 | Q10 版本/重新登录场景下旧 identity 不被当新命令的动态证据 |
| O9-5 non-reuse 不静默依赖 namespace 相等 | 版本/重新登录移动 namespace 时旧 landmark 跨身份/版本重绑仍存活（或由 Q10 边界显式约束、旧 unknown 未被当新命令）的可复核证据（Q10；本包 W37） |

### 7.5 不成立的边界

- 把 `expires_at` 或任何 legacy 机制当成 retention / non-reuse 保证 → 不成立。
- retention 后 absence/不可读被解释成“未提交/可重做/新命令” → 不成立。
- GC 删除恢复依据导致同一命令重放或重做 → 不成立。
- 用 retry deadline 耗尽当作 retention 或 command 关闭 → 不成立。
- 让不同版本/重新登录把旧 identity 重置为新空间 → 不成立。
- 让 non-reuse 只在“namespace 相等”时成立，从而由版本升级/重新登录把同一用户意图当全新命令执行 → 不成立（O9-5）。

## 8 联合状态矩阵

状态轴沿用 WP-O1 §6.1：`N`（无已记录 unknown 且尚无终局）/ `U`（已有 unknown）/ `C`（已有权威 committed
success）/ `F`（已有 command-final no-effect），C/F 互斥。下表描述四类 B 事实与观测的交互；它只是逻辑
oracle，不是 wire 定义。

| 已有 command 事实 | 新观察 | 允许的 B 动作 | 对 C/F/U/N 的影响 | 对 receipt 的影响 | 对恢复/重执行 | 对 retention |
| --- | --- | --- | --- | --- | --- | --- |
| N | E01 authoritative commit receipt | 原子接受，仅此一次 | → C，单调 | 产出 original receipt（结果语义不可变，metadata 可分隔） | 不重跑原写 | 保留 original receipt + landmark |
| N | E04 current-attempt known-no-effect | 只关本 attempt | 保持 N（若仍有未排除旧 attempt 则 → U，见下一行） | 无 receipt | **只允许原身份只读恢复/查询；不得重做写**（重做写须 (a) 已证明 fence 或 (b) E03→F） | 不适用 |
| N | inconclusive/unknown（E07/E08/E09 timeout/miss/backend unavailable） | 有 dispatch 或交付不明窗口则建立 U；仅当完整证明从未 handoff 才回 §6.2(1) | 有不明窗口 → **U**（不得停留原 N）；已证明从未 handoff 才保持 N | 无 receipt | 只查不写；不得凭 miss/timeout 重做写 | 不适用 |
| N | malformed/unrelated response（E11） | ignore 该响应的结算与页面副作用；本命令等待权威响应；若存在未排除执行窗口则建立 U；完全未交付才维持 N | 有执行窗口 → **U**；完全未交付才保持 N | 无 receipt | 只查不写；不得凭该响应重做写 | 不适用 |
| N | retention-unavailable | 恢复受阻；`N` 不能作为无历史证明 | 可能已执行 → **U**（不结算） | 原 receipt 不可读 | 只查不写，仍不放行 | 保留 non-reuse landmark（`N`/`U` 亦适用，§7.2.1） |
| N | E03（满足 P-a/P-b/P-c） | 建立 command-final fence | → F，单调 | 无正向 receipt | 禁止“重做原命令”；只可新意图 | 保留 non-reuse landmark |
| U | E01/E02 | 返回原 receipt | U → C | 原 receipt 原样 | 不得重跑 | 保留原 receipt |
| U | E03 | 建立终局 fence | U → F | 无正向 receipt | 禁止重做 | 保留 non-reuse landmark |
| U | 仅 E04/E05/4xx/miss/timeout | 只关本 attempt 或保持 | U 保持 | 无 | 只查不写 | 不适用 |
| U | retention-unavailable | 恢复受阻 | U 保持 | 原 receipt 不可读 | 只查不写，仍不放行 | 保留 landmark（非结果；覆盖“可能已 commit”的 U 身份，§7.2.1） |
| C | E01/E02（同 receipt） | no-op / 原样返回 | C 不变 | 原 receipt | 不重跑 | 保留 |
| C | 貌似 E03 或不同 original receipt | **隔离并暂停新写/next** | 冲突候选 → 治理 | 两候选均不作数 | 暂停依赖流程 | 暂停清理该 identity 依据 |
| C | retention-unavailable | 保持已验证 C | C 不变 | 原 receipt 不可读，不补造 | 不重跑 | 保留 landmark |
| F | E03（同终局） | no-op | F 不变 | 无 | 禁止重做 | 保留 landmark |
| F | 貌似 E01 / 不同 original receipt | **隔离并暂停** | 冲突候选 → 治理 | 不作数 | 暂停 | 暂停 |
| F | retention-unavailable | 保持 F | F 不变 | 无 | 禁止重做 | 保留 landmark |
| C/F 冲突候选 | 任意 | 隔离、暂停、交治理 | 不自动改写 | 均不交付 | 暂停 | 暂停清理 |

核心不变量在矩阵上的投影：`U` 只有 `E01/E02` 或 `E03` 能终结；`C` 不因较弱/迟到/unknown 降级；`F` 不因后来
commit 候选升级；冲突 C/F 隔离且暂停，不 last-response-wins；`N/U` 不得换 key/body/version，`C/F` 后也只允许
另一个独立、重新校验的业务意图形成新 command。r1 补充两条投影：**(1)** `N` 一旦存在 dispatch 或交付不明
窗口（inconclusive/receipt miss/backend unavailable/retention-unavailable）就必须 → `U`，不得停留原 `N`；
**(2)** `N | E04` 只开放只读恢复，**不**开放同一身份重执行写。**r3 补充第三条投影**：`N | E11
malformed/unrelated response` 在存在未排除执行窗口时同样必须 → `U`（ignore 该响应，见上表新增行）。

**§8 是 WP-O1 §6.3 4×7（28 格）矩阵的投影（子集），不是重写。** 它对 `N` 补齐了 `inconclusive/unknown`、
`retention-unavailable`（r1）与 `malformed/unrelated response`（E11，r3），故 `N` 行现覆盖这三项（inconclusive/
unknown、retention-unavailable、E11）与 E01/E03/E04 等 Q03/Q04/Q06/Q09 直接相关格。§8 **未逐格列出**的单元格——`E11 malformed/unrelated
response` × {`U`,`C`,`F`}、`auth suspension` × {`N`,`U`,`C`,`F`}，以及 `C`/`F` 的 `attempt-local
rejection/no-effect` 与 `inconclusive/unknown`——一律**直接由 WP-O1 §6.3 对应格治理**（例如 `C`/`F` 保持不降级/
不升级、ignore stale/unrelated callback），本包不另立规则，也不放宽任何格。（r0 曾遗漏 `N | inconclusive`、
`N | retention`，见 §14 FINDING-F/G。）

## 9 Owner contract 与后续顺序

| owner | 本候选要求的输入/输出 | 本候选不决定 |
| --- | --- | --- |
| Identity / G-ID | 把 E03 fence 与 receipt 绑定到 exact identity key + binding；保证 body/版本改动不移动 namespace，non-reuse landmark 与 namespace 同源 | DB 列/index、raw body retention、digest 实现 |
| Auth / G-AUTH | 提供建立/观察 E03 所需的 auth 可见性；明确 execute 与 receipt 两轴在 fence/receipt 上各自的作用；撤权与 commit/release 的排序 | capability 名字、SQL/RLS、错误载体 |
| B / G-BACKEND | 提供 P-a/P-b/P-c 的可复核状态与证明；commit 点唯一线性化；original receipt 的结果语义/delivery metadata 二分；C/F 冲突的隔离入口；retention 后 non-reuse landmark 存活；只查不写默认 | schema、锁、isolation、cancel 实现、retention/GC 数值 |
| HTTP-Out / G-OUT·G-ENV | 只表达已获 authority 的事实（C/F/U/N、恢复受阻、结果不可恢复），并让 client 能验证 correlation/entitlement | public DTO/status/reason/route（留 Q05） |
| Client / G-CLIENT | once-serialized exact bytes、原身份恢复通路、cross-attempt unknown latch、不凭 miss/timeout 重做写 | storage format、adapter API、retry 时间、restart 实现 |

**最小后续顺序：**

```text
1. Q01/Q02/Q08（已决）→ 提供身份、attempt 全集与 entitlement 的边界
2. Q03 → E03 fence 的三谓词与证明义务（本包）
3. Q04 → original receipt 的原子 authority 与冲突治理（本包，依赖 Q03 的终局语义）
4. Q06 → same-identity 只查/重执行与 cancel-commit 线性化（本包，依赖 Q01/Q03/Q04/Q08）
5. Q09 → retention 后 non-reuse 与可公开事实（本包，依赖 Q01/Q04/Q08）
6. Q05 → G-OUT 语义与 G-ENV 表达互校（仍开放）
7. Q07/Q10 → client durable state、restart、版本兼容（仍开放）
8. 获新授权后 Q11 → 真实 B/runtime 联合证据
9. 总控按 Q12 独立判断准入
```

如果任何 owner 的真实证据反证本包候选，必须回到对应 owner 修订本候选，不能让 HTTP/client 猜测结果。
本包不得被写成 gate closed；没有具体 owner contract、实现与真实证据时，所有相关 G-* 保持阻断。

## 10 Written counterexamples（W-series，未执行）

以下 W19–W37 延续 WP-O2 的 W01–W18 编号，均为 Fresh Review 与未来动态测试的书面 oracle，执行数 0。
（r1 新增 W35/W36 覆盖 r0 §8 遗漏的 `N | inconclusive` / `N | retention` 两行；见 §14 FINDING-F/G。
r3 新增 W37 覆盖 O9-5 的版本/重新登录 non-reuse 义务。）

| ID / 场景 | 推荐行为 | 不得结论 |
| --- | --- | --- |
| W19 单次事务 rollback，无其它 attempt 信息 | 记 E04，保持 N（或旧 U）；**只允许原身份只读恢复/查询，不开放重做写** | 不得升级为 E03；不得称全命令 no-effect；不得凭 E04 重做写 |
| W20 cancel 请求与 commit 竞态，顺序不可证明 | 保持 U；只查不写 | 不得凭 ack 或超时宣布 no-effect 或可换 key 重做 |
| W21 cancel 在 commit 点之前线性化且无历史效果且未来能力关闭 | E03 → F；保留 non-reuse landmark | 不得因“只是取消”而轻率升级 E03；三谓词须齐备 |
| W22 commit 后 serialize/send/finish/client-receive 任一点失败 | 客户端 U；原身份读回原 receipt | 不得生成新 checkpointId、不得换 key、不得重跑写 |
| W23 current checkpoint 与旧 accepted receipt 不同 | 交付原 receipt 结果语义；checkpoint 不回写历史 | 不得用 current checkpoint 代替 original receipt |
| W24 replay 返回 `replayed:true` / 新 requestId | 视为 delivery metadata；结果语义来自 original receipt | 不得把 replayed 标志当结果真伪或成功证明 |
| W25 同 identity 出现貌似 C 与貌似 F 两个终局候选 | 隔离、暂停依赖流程新写/next、交治理 | 不得 last-response-wins / 多数投票 / 自动改写事实 |
| W26 同 identity 两个不同 original receipt 内容 | 隔离为一致性异常；暂停 | 不得择一交付、不得新增公开异常码 |
| W27 known abort 但旧 attempt 可能仍持 commit capability | 只查不写，保持 U | 不得凭“当前 abort”重做写或宣布 command 关闭 |
| W28 receipt miss + backend unavailable | 保持 U，停止不完整的自动恢复 | 不得生成 F 或 new key；不得把 miss 当无历史 |
| W29 same-identity retry 试图跳过 route/auth/budget/admission | 逐 attempt 重过全部门禁 | 不得把 same identity 当 replay 通行证 |
| W30 retention 删 receipt payload，identity 曾越过 handoff（含仍为 N/U 者） | 保留 non-reuse landmark（覆盖所有曾越过 handoff 的身份）；公开“结果不可恢复” | 不得使 identity 变新命令、不得开放重做；不得以“未曾记录为 C”为由跳过 landmark |
| W31 GC 与恢复交错，终态识别失效 | fail closed，保持 unknown/阻断 | 不得出现“查不到即新 session/新命令”旁路 |
| W32 retry deadline 耗尽 | 停止自动尝试；command 不关闭 | 不得当作 retention 或终局；不得换 key |
| W33 重新登录 / 版本升级后用新 key 恢复旧业务动作 | 旧 identity 按 Q10 处理；不得被当新空间 | 不得让版本/登录重置或接管旧 unknown |
| W34 retention 后旧 identity 被当全新命令执行 | 阻断；要求 non-reuse fence | 不得由 absence/不可读放行；fail closed |
| W35 `N` 命令出现 inconclusive/unknown（timeout/miss/backend unavailable） | 有 dispatch 或交付不明窗口则**建立 `U` latch**（不得停留原 N）；仅完整证明从未 handoff 才保持 N | 不得停留原 N 而保留同身份重执行写的入场券；不得凭 miss/timeout 重做写 |
| W36 `N`/`U` identity 的 receipt 因 retention 不可读 | 保留 non-reuse landmark；保持 `U` 且恢复受阻 | 不得把 landmark 义务限定为“曾 commit”；不得由 absence 开放重做 |
| W37 版本升级/重新登录使 namespace 移动后，用同 key 请求执行旧业务意图 | 阻断：landmark 须跨身份/版本重绑存活，或由 Q10 边界显式约束；旧 unknown 未解决前不得当新命令执行 | 不得以“namespace 不相等”为由把同一用户意图当全新命令；不得因版本/登录放行 O9-5 |

Fresh Review 必须检查 W19–W37 与 WP-O1 O01–O16、WP-O2 W01–W18、R7-C T29–T50 的方向一致性。若任何路径让
attempt-local 事实终结旧 U、让 receipt 的 delivery metadata 冒充结果语义、让 cancel/commit 无序却在无证明时
宣布 no-effect、让 retention 使旧 identity 变新命令、让 C/F 冲突 last-response-wins、让 `N` 在存在 dispatch/交付
不明窗口时停留而不建 `U`、让 E04 单独开放同身份重执行写、让 non-reuse landmark 义务排除 `U`/`N`、或让 non-reuse
静默依赖 namespace 相等而不满足 O9-5，本候选应为
BLOCK。

## 11 Invariant ledger

以下为本包本地编号（`RA`=record authority），仅用于引用。本包只承认**可核验的真实上游 id**：
Q0x、E0x、D01–D18、W01–W18（WP-O2）+ W19–W37（本包）、O01–O16、R7B.*、G-*，以及本包 `RA-*`。**R7-C r1 不存在任何 `R1-INV-*`
编号**——整分支 `git grep -n "R1-INV" codex/stage-09p-m2-inventory` 零命中；cross-attempt unknown 与
cancellation ladder 只由 R7-C r1 的**正文**（§11 line 228、§9 line 144/162–167）承载。r0 曾把它们写成
`R7-C R1-INV-CROSSATTEMPT-UNKNOWN` / `R7-C R1-INV-CANCEL-LADDER`，属**虚构的 authority 标签**，r1 已全部
改为真实出处（见 §14 FINDING-B/D）。每条标注来源与 owner。

| ID | 不变量 | 来源 | owner |
| --- | --- | --- | --- |
| RA-01 | 唯一负向全命令终局证据是 E03；E04/E05 只关本 attempt | WP-O1 §5/§7.1；WP-O2 D09 | B / OUT |
| RA-02 | E03 须同时满足 P-a 无历史效果、P-b 相关 attempts 全停、P-c 未来 commit 不可达 | 本包 §4.2 | B / ID |
| RA-03 | fence 持久、单调不可回退、绑定 exact identity key，不被 session/ordinal 影响 | 本包 §4.2；WP-O2 §4.4/4.5 | ID / B |
| RA-04 | 未完成 marker 与 nonReplayable tombstone 都不是 command-final fence | 本包 §4.2（code grounding） | B |
| RA-05 | 取消 ack 单方不构成 E03；须有相对 commit 点的顺序证明与未来能力关闭证明 | R7-C §9；本包 §4.2 | B / CLIENT |
| RA-06 | commit 点是唯一接受线性化点；commit 前不公布 success | R7-B §6；WP-O1 I-05 | B |
| RA-07 | E01 或 E02 是唯一正向终局证据；COMMIT 已知/marker completed/2xx/内存 receipt 均不足 | WP-O1 §5 E01 | B / OUT |
| RA-08 | original receipt 的不可变结果语义 = 结果 payload 语义 + 绑定版本/状态 + 已提交事实 | 本包 §5.2 | B / OUT |
| RA-09 | delivery metadata（本次 requestId、replayed、firstProcessedAt、时序）不得作结果语义或真伪证据 | 本包 §5.2；WP-O1 E02 | OUT / ENV |
| RA-10 | C/F 或两个 different original receipt 冲突时隔离并暂停，不 last-response-wins，不新增公开码 | WP-O1 I-03/§6.3；本包 §5.2 | OUT / ENV / 治理 |
| RA-11 | 越过 handoff 后 miss/unavailable/known-abort 一律只查不写 | WP-O2 §5.4；本包 §6.2 | B / CLIENT |
| RA-12 | 原身份重执行仅两类许可：N-with-fence 或 F 后新独立意图 | 本包 §6.2 | B / ID |
| RA-13 | cross-attempt unknown 是独立 latch；仅覆盖本 attempt 的后来拒绝不能清除 | R7-C r1 §11 正文（line 228「跨attempt未知性必须是独立latch」）；WP-O1 §4.2 I-02 | CLIENT / OUT |
| RA-14 | same-identity retry 不是跳过 route/auth/budget/B admission 的通行证 | WP-O2 §5.4；本包 §6.2 | B / AUTH / ROUTE |
| RA-15 | 结果可恢复性与身份可复用性分离；retention 不移除 non-reuse | WP-O1 I-12；本包 §7.2 | B / ID |
| RA-16 | retention 后 absence/不可读不产生 no-effect；不得开放重做 | WP-O1 E10/§6.4；本包 §7.2 | B / OUT |
| RA-17 | GC/恢复交错不得产生“查不到即新命令”旁路；终态识别失效 fail closed | R7-B §8.2/§10 | B / LIFE |
| RA-18 | retry deadline ≠ retention ≠ command 关闭 | WP-O2 §5.4；本包 §7.2 | CLIENT / B |
| RA-19 | receipt 交付受独立 receipt entitlement / release point 约束；丢失不否定已提交事实 | WP-O2 §6.2/§6.4 | AUTH / OUT |
| RA-20 | 不产出 SQL/RLS/migration/锁/DTO/status/reason/route；不关闭任何 G-* | 任务硬约束；WP-O2 §1/D18 | 总控 |
| RA-21 | B internal category 不得原样成为 public reason/problem/fieldErrors，也不做类别→终局映射 | WP-O1 E18/I-10 | OUT / B |
| RA-22 | 代码能力边界：客户端存在 `CommandId`/auth generation/stale-attempt（仅客户端内存、仅 callback 消费语义，**非** logical identity 载体）；B 侧持久 command/attempt/capability/receipt-entitlement/no-effect 记录不存在，需新建 | 本包 §2 code grounding（r1 更正） | B / ID |
| RA-23 | E04/E05/E07/E08/E09 单独都不开放同一身份**重新执行写**；重执行写仅 (a) N+已证明 fence 或 (b) F | 本包 §3.1/§4.2/§6.2；WP-O1 §6.1/§6.2(2)/O02；WP-O2 §5.4 | B / ID |
| RA-24 | 有 dispatch 或交付不明窗口时 `N` 必须 → `U`，不得停留原 `N` | WP-O1 §6.3 `N|inconclusive`；I-02；本包 §6.2/§8 | CLIENT / B |
| RA-25 | non-reuse landmark 覆盖所有曾越过 handoff 的 identity（含 `N`/`U`），不以『曾 commit』为条件 | WP-O1 §4.2 I-12；本包 §7.2.1/§8 | B / ID |
| RA-26 | retention 后可公开事实随状态而异（state-relative）：`C` 曾被接受但原结果不可恢复；`N`/`U` 是否曾存在结果属 UNKNOWN、未确认且恢复受阻（**不得**称“曾被接受”）；`F` 已终局关闭 | 本包 §3.4/§7.2（r2） | OUT / B |
| RA-27 | non-reuse 不得静默依赖 namespace 相等：版本/重新登录移动 namespace 时，landmark 须跨身份/版本重绑存活或由 Q10 显式边界约束；Q10 关闭前 O9-5 为 admission blocker | 本包 §7.2.3/§7.4/§10 W37（r3） | ID / B |

## 12 明确未决与准入 stopline

本包只处理 Q03/Q04/Q06/Q09，未解决或未触及其余：

- **Q05 公开语义与载体（G-OUT/G-ENV）**：attempt-local / U / C / F / auth-suspension / recovery-unavailable /
  result-unrecoverable 的 public 语义与载体；不冻结 DTO/status/field；B internal category 不得入 public 字段；
  无可靠载体 route 不准入。
- **Q07 client 状态与 callback 消费**：durable client state、once-serialized 跨首次/retry、unknown latch 独立于
  in-flight、late callback 消费与 deadline/pending 清理；不新增 client port。
- **Q10 版本与运行期兼容**：旧 parser/identity/operation 版本能否恢复原 receipt；新 registry/serializer 不得改变
  旧 unknown；future query 政策变化须独立重审。
- **命名开放义务 O9-5（Q09 内，依赖 Q10）**：版本升级/重新登录移动 namespace 时，non-reuse 不得静默依赖
  namespace 相等；须证明 landmark 跨身份/版本重绑存活，或由 Q10 显式边界约束（§7.2.3/§7.4/§10 W37）。
  **该义务在 Q10 关闭前保持 admission blocker**，不得写成 gate closed。
- **Q11 真实 B/runtime 证据**：commit-loss、cancel-race、early query rejection、no-response、exact 发送/关联、
  late callback、预算/日志/权限变化的联合证据；当前 T01–T50=0、本包 oracle=0。
- **Q12 项目准入与发布**：M1/G2、M2 prerequisites、migration 首次确认、真实权限/N-1 与独立审计；本包不运行
  B-r4/G2，不授予实施资格。

**十 G-* 全部保持阻断**：G-ROUTE / G-ENV / G-OUT / G-ID / G-CLIENT / G-AUTH / G-LIFE / G-BUDGET / G-LOG /
G-BACKEND 在 r1/WP-O1/WP-O2 与本包中**均未解除**；B04（物理锁与撤回/GC 相容）、B05（retention/GC/recovery）、
B08（0005/N-1 实现证据）全部 open。0000–0004 永久冻结，任何新增须走 0005 且经总控确认；本包不设计 SQL/RLS/
migration，也不预先批准 0005。

**固定状态上限不变**：M1 = `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`（非 Accepted）；M1 Fresh Audit
A = CLEAN，household-safety 292/292 仅 LIMITED；B-r1/r2/r3 = BLOCK 且 B-r4 未运行；G2 = `G2_NOT_ADMITTED`，
source pack draft/inactive，public trust allowlist empty；M2 = `In Progress` 未 Accepted；R7-A contracts =
Accepted；R7-B = `R7-B_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`；R7-C = `R7-C_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`；
T01–T50 执行数 = 0，无任何通过结论。

**准入 stopline**：在 M1 Accepted、G2 admitted、0005 由总控正式确认、以及相关 owner 提供本包 §4.4/§5.4/
§6.4/§7.4 列出的真实证据之前，Q03/Q04/Q06/Q09 的候选**不得**被写成 gate closed 或 implementation-ready；
任何 B/DB/retention 机制选择仍是 admission blocker。本包结论上限见 §1。

## 13 POST 与交付 identity

- **交付物**：`/Users/aipuli/Documents/Projects/meal-agent-lab/.local/wp-o3/wp-o3-command-record-authority-decision-pack.md`
  （本文件），`READY_FOR_FRESH_REVIEW`，`DESIGN_ONLY`，中文。
- **范围**：仅回答 Q03 / Q04 / Q06 / Q09；不新增也不回答 Q05/Q07/Q10/Q11/Q12。
- **authority**：设计准备材料。不关闭任何 G-*，不冻结任何 contract，不授权实现、SQL/RLS/migration、public
  DTO/status/reason/route、client port 或 runtime 接线。
- **方法边界**：只读静态阅读 + 写作；未运行任何产品测试/DB/Node/Taro/Docker，未修改仓库，未提交 git。
- **上游一致性**：本包 §8 是 WP-O1 §6.3 4×7 矩阵的**投影（子集）**，未逐格列出的单元格直接由 WP-O1 §6.3
  治理（r1 补齐 `N | inconclusive/unknown`、`N | retention-unavailable`，r3 补齐 `N | malformed/unrelated
  response` E11）、§10 W19–W37 与 WP-O1 O01–O16 / WP-O2 W01–W18 / R7-C T29–T50 方向一致。
- **id 溯源**：本包只引用可核验的真实上游 id（见 §11 前言）；r0 虚构的 `R1-INV-*` 标签已在 r1 全部移除。
- **明确的余留（给 Fresh Review）**：若本包任一候选让 attempt-local 事实终结旧 U、让 delivery metadata 冒充
  结果语义、让 cancel/commit 无序却在无证明时宣布 no-effect、让 retention 使旧 identity 变新命令、让
  C/F 冲突 last-response-wins、让 `N` 在有 dispatch/交付不明窗口时停留而不建 `U`、让 E04 单独开放同身份
  重执行写、让 non-reuse landmark 义务排除 `U`/`N`、让 non-reuse 静默依赖 namespace 相等而不满足 O9-5、
  让 retention 后 `N`/`U` 被公开为“曾被接受”（false-success
  披露）、或引用不存在/无法核验的上游 id，应判 BLOCK。

## 14 修订说明 (r1)

本节逐条登记 r0 Fresh Review 的每一项 finding 及其在 r1 的处置。**所有 finding 均已被本 Designer 独立
复核为成立**，r1 按 fail-closed 方向实质修订，未以削弱 fail-closed 行为来消除 finding。复核方法：本地
只读 `git grep` / `git show`（未运行产品测试、DB、Node、Docker）。

| finding id | severity | 摘要 | r1 处置 | 落点（r1 行内） |
| --- | --- | --- | --- | --- |
| FINDING-A | P1 | Q06 核心问题对“E04（本次 rollback、旧 attempt 状态未知）是否允许 same-identity 重试/重执行”给出互斥答案（§3.1/§4.2 第 4 列/§8 说允许；§6.2 说只查不写），且未声明何者为准 | **已实质修订，统一收敛到 fail-closed 侧**：E04 单独**只**开放只读恢复/查询，**不**开放同一身份重执行写；重执行写仅 (a) N+已证明 fence 或 (b) F。§3.1、§4.2（含列名改为“是否允许同一身份重新执行写”、E04 行改为“不允许”）、§6.2、§8（N\|E04 行、核心不变量投影）四处已互相引用并对齐；§6.5、§6.1 表补强 | §3.1、§4.2 表与新增“唯一两个重执行写许可”段、§6.1 表、“重执行许可的两类”、§6.2（默认段+“关键约束(r1 补充)”）、§6.5、§8 |
| FINDING-E | P1 | 对抗性反例指向攻击面 (c)：以同身份重执行一个旧 attempt 仍可能 commit 的命令（§4.2 E04 行、§3.1、§8 矩阵） | **已实质修订**：与 FINDING-A 同根同修——E04 行不再写“允许”，明确“旧 attempt 仍可能 commit 时不得同身份重执行”；补上“唯一两类重执行写许可”的收敛声明；W19 oracle 同步收紧 | 同上；§10 W19 |
| FINDING-B | P2 | `R7-C R1-INV-CROSSATTEMPT-UNKNOWN`、`R7-C R1-INV-CANCEL-LADDER` 为凭空构造的不变量 id；分支上无任何 `R1-INV-*` 标识 | **已修订 id 溯源**：删去全部虚构 id，改为真实出处（R7-C r1 §11 line 228 正文、§9 line 144/162–167 cancellation ladder step 4；WP-O1 §4.2 I-02、§6.3 O02 行）；§11 前言移除 `R1-INV-*` 并加显式核验说明 | §6.1 表“unknown 的顽固性”行、§6.2 point 4、§11 RA-13、§11 前言 |
| FINDING-D | P2 | authority/scope：把 `R1-INV-*` 当作既有上游正式 id 并入“正式 id”命名空间，污染可核验的 authority chain | **已修订**：与 FINDING-B 同修——§11 前言明确“本包只承认可核验真实上游 id”，并声明 `R1-INV-*` 零命中；§13 增“id 溯源”余留并纳入 BLOCK 判据 | §11 前言、§13 |
| FINDING-C | P2 | §2 断言“代码中根本没有 … generation … 概念”与 §11 RA-22 被分支源码推翻（客户端存在 `CommandId`、`generation`/`authGeneration`、stale-attempt；WP-O1/WP-O2 已登记为既有源码事实）；§2 read-set 未读 apps/client | **已实质更正**：§2 code grounding 改为精确边界（客户端确有这些概念，但仅客户端内存、auth generation 只控制 callback 消费、非 logical identity 载体；B 侧持久记录不存在、需新建）；read-set 补入三个客户端文件；RA-22 重写 | §2（read-set 表 + code grounding 段）、§11 RA-22 |
| FINDING-F | P2 | §8 矩阵 N 行不完整，缺 `N \| retention-unavailable` 与 `N \| inconclusive/unknown`（E07/E08/E09），而 WP-O1 §6.3 4×7 矩阵有 | **已修订**：§8 补齐两行（inconclusive → 有不明窗口则 U；retention → 可能已执行则 U、保留 landmark）；核心不变量投影声明已覆盖；新增 W35/W36 oracle | §8 矩阵（+2 行）、§8 投影段、§10 W35/W36 |
| FINDING-G | P2 | §6.2“客户端保持 `U`（或原 N）”弱于 WP-O1 强制 N→U（N\|inconclusive 要求有 dispatch/交付不明窗口则 U；I-02 跨 attempt unknown 不可被 deadline 删除） | **已实质修订**：删去“或原 N”宽松读法；明确凡有 dispatch/交付不明窗口**必须建立 U latch，不得停留原 N**，仅完整证明从未 handoff 才维持 N；§6.5 增边界条目 | §6.2 默认段、§6.5、§8 N 行 |
| FINDING-H | P2 | Q09 non-reuse landmark 强制范围偏窄：§7.2.1 限定“曾 commit（或曾被 E03 终局）”，排除 U/N；与 §8 U\|retention 及 I-12 不自洽 | **已实质修订**：landmark 义务改为覆盖**所有曾越过 transport handoff 的 identity（含 N/U/C/F）**，不以“曾 commit”为条件；唯一豁免是证明从未 handoff；§3.4、§7.2.1、§7.2.2、§8、W30 同步；新增 RA-25 | §3.4、§7.2.1、§7.2.2、§8（U\|retention、N\|retention）、§10 W30/W36、§11 RA-25 |

**未采信的 rebuttal：** 无。本 Designer 对上述八项 finding 全部复核为成立（`R1-INV` 在
`codex/stage-09p-m2-inventory` 全分支 `git grep` 零命中；客户端 `idempotency.ts`/`session-store.ts`/
`command-dispatcher.ts` 确有 `CommandId`/`generation`/`authGeneration`/stale-attempt），故 r1 按 fail-closed
方向修订，未保留任何与 review 相反且无据的读法。若后续 Fresh Review 认为某一项应反向裁定，请显式指出
上游出处，本包不据未经核验的 id 或断言改动 fail-closed 行为。

**r1 新增/变更的 invariant：** RA-23（E04/E05/E07/E08/E09 单独不开放重执行写）、RA-24（N→U 强制）、
RA-25（landmark 覆盖 N/U）；RA-13、RA-22 的 source/code-grounding 已按上述更正。

## 15 修订说明 (r2)

本节逐条登记 r1 Fresh Review 的每一项 finding 及其在 r2 的处置。**所有 finding 均已被本 Designer 独立复核为
成立**，r2 全部按 fail-closed 方向实质修订，未以削弱任何 fail-closed 行为来消除 finding。复核方法：本地只读
`git show` / `git grep`（未运行产品测试、DB、Node、Docker）。**r2 不改结论上限**（仍为 `DESIGN_ONLY`、
`READY_FOR_FRESH_REVIEW`）。

| finding id | severity | 摘要 | r2 处置 | 落点（r2 行内） |
| --- | --- | --- | --- | --- |
| F-1 | P1（fail-closed lens，BLOCK） | §3.4/§7.2 把“该 identity 对应的命令曾被接受”列为 retention 后**可公开知道**的事实，并套用于含 `N`/`U` 的同一身份集；对 `N`/`U` 而言 retention 只证明原结果不可恢复，**不**证明曾 commit（本包 §7.2.2 自身只允许读作“可能已 commit”；WP-O1 E10 亦指出普通 404 甚至不能证明不可恢复），构成把缺失证据当成功的 false-success 披露，且与“有限且否定性”自相矛盾 | **已实质修订（非改写措辞）**：公开事实改为 **state-relative**——`C`：曾被接受但原结果现不可恢复；`N`/`U`：**是否曾存在结果属 UNKNOWN**，未确认、未结算、恢复受阻，**明确禁止**表述为“曾被接受”；`F`：已终局关闭。并新增“状态优先级（与 §7.2.2 的关系）”段：absence/不可读**既**不构成 no-effect 证明、**也**不构成“曾被接受”的肯定证明。§13 余留与 BLOCK 判据、RA-26 同步 | §3.4、§7.2（“retention 后可以公开知道的事实”段 + 新增状态优先级段）、§11 RA-26、§13 |
| F-2 / R1-P2-1 | P2（两个 lens 同报） | §4.2 尾段把重执行写许可 (a) 定义为“无历史效果 + 无在途/未来 capability”，字面等于 P-a ∧ P-b ∧ P-c = E03（§4.2 表第 2 行据此映射为 F 并禁止重做），与 §3.1/§3.3/§6.2 的 (a)=P-a ∧ P-b 冲突；且含“四处已对齐”的失实声明 | **已实质修订**：§4.2 段改为 **§6.2 的 (a)/(b) 为唯一定义**，(a) 明示**仅**由 P-a ∧ P-b 两谓词构成、**不**含 P-c，并加“边界区分”说明 P-c 只属 E03/F 路径；§3.1、§6.2（默认段与“关键约束(r1 补充)”段）的“一致”措辞改为“以 §6.2 为唯一规范定义”，不再声称四处本已对齐 | §3.1、§4.2（“唯一的两个重执行写许可”段）、§6.2（默认段 + 关键约束段） |
| F-3 | P2 | §1 与 §12 把 R7-C 记为 `DESIGN_ONLY`，与已登记现值 `R7-C_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED` 不符 | **已更正两处标签**：`R7-C = \`R7-C_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED\``（依据 `codex/stage-09p-m2-inventory:docs/project-status.md` §17 R7-C 收口段与 evidence §5.1）。T01–T50=0、十 G-* 未解除不变 | §1、§12 |
| F-4 | P2 | §11 前言把已承认的可核验上游 oracle id 范围写成 `W01–W34`，而本包 §10 定义的是 `W19–W36`（明示延续 WP-O2 的 `W01–W18`）、§13 亦写 `W19–W36` | **已更正**为 `W01–W18（WP-O2）+ W19–W36（本包）` | §11 前言 |
| AUTH-P2-01 / R1-P2-2 | P2（两个 lens 同报） | §6.2 默认段、§7.2.1、§8 以 `WP-O1 §6.2(3)` 作为“能完整证明从未越过 handoff 才维持 `N`”的出处，但 §6.2(3) 是**相反**分支（重启/身份重绑/记录缺失 → 进 `U`）；正确权威是 §6.2(1) | **已更正三处引用**为 `WP-O1 §6.2(1)`（全新纯本地动作、在任何 transport handoff 前被拒绝且已证明无同 identity 历史/其他执行者） | §6.2 默认段、§7.2.1、§8（`N \| inconclusive` 行） |
| AUTH-P2-02 | P2 | §6.2 point 4 与 §11 前言把 R7-C r1 §9“Cancellation ladder”step 4 记为 `line 166`（区间 `162–166`），实际 step 4 在 `line 167`、`line 166` 为 step 3 | **已更正** `line 166`→`line 167`、区间 `162–166`→`162–167`（§14 的 r1 日志内同一区间亦一并更正，以免遗留错误行号） | §6.2 point 4、§11 前言、§14 FINDING-B 行 |

**说明与 rebuttal：** 本 Designer 对上述六项 finding 全部复核为成立，无未采信的 rebuttal。全部修订沿 fail-closed
方向（收紧披露与谓词边界、更正失实出处），未放松任何既有 fail-closed 行为，也未改动结论上限（§1）。F-2 的
“唯一规范定义”收敛后，(a)=P-a ∧ P-b 与 P-c=E03 第三谓词的边界在全包一致。

**r2 新增/变更的 invariant：** 新增 RA-26（retention 后可公开事实 state-relative，`N`/`U` 不得称“曾被接受”）；
RA-05/RA-12/RA-23 的 (a)/(b) 口径随之统一（(a)=P-a ∧ P-b）。§14 的 r1 历史日志除 AUTH-P2-02 的行号更正外
保持原样。

## 16 修订说明 (r3)

本节逐条登记 r2 Fresh Review 的每一项 **residual P2** finding 及其在 r3 的处置。r2 的三条 lens 均为
CLEAN、P0=0/P1=0，只余五条 P2；本房规要求 0/0/0，故 r3 仅做**精确的措辞与覆盖修正**，**未改动任何
fail-closed 行为、未改动结论上限**（仍为 `DESIGN_ONLY`、`READY_FOR_FRESH_REVIEW`，§1/§13 不变）。复核方法：
本地只读阅读本包与上游（`git show` 读取 `codex/stage-09p-m2-inventory` 上的 WP-O1 §6.2/§6.3、§10 Q09、E11 行）；
未运行任何产品测试、DB、Node、Docker，未切换分支。

| finding id | lens | 摘要 | r3 处置 | 落点（r3 行内） |
| --- | --- | --- | --- | --- |
| RA-P2-01 | authority | §4.2 联合区分表 E04 行把“same-identity 重执行写”许可指向“本表末两行的 fence/F 条件”，但末两行/ fence 行（E03/F）的结论恰是**禁止**重做原命令；本包唯一规范定义 §6.2 (a)（= P-a ∧ P-b、显式**不含** P-c、显式“不把命令升为 F”）在该表中没有对应行 | **已改指针**：E04 行末列不再指向任何表内行，直接指向 **§6.2 (a)/(b) 唯一规范定义**，并写明 (a) 仅 P-a ∧ P-b、**不含** P-c、“不把命令升为 F”；补明“本表任何一行（含 E03/F 行）都不**单独**构成该许可”。**未新增任何会暗示 (a) 需要 P-c 的行** | §4.2（E04 行第 4 列） |
| R2-FC-01 | fail-closed | §3.4/§7.2 把 retention 后可公开事实的 wrapper 写成“有限、**否定性**、且随状态而异”，但同一列表的 `C` 项是**肯定**披露（“曾被接受（存在已提交结果）”），wrapper 与自身条目矛盾 | **已修正 wrapper 措辞**为“**有限、随状态而异、不超出所声明状态**”（state-relative，不得跨状态套用，也不得由某一状态外推其他状态）；`C` 披露本身按 WP-O1 §6.3 `C \| retention-unavailable`=可展示已有获准结果**保留**，不加削弱。同步把 §7.4 义务 O9-3 标题的“否定性”改为“受限度（state-relative）”，消除包内残余不一致 | §3.4、§7.2（“retention 后可以公开知道的事实”段）、§7.4（O9-3 行） |
| R2-ADV-01 | adversarial | §6.2 默认列表与 §8 的 N→U 触发列表枚举 E07/E08/E09/E04 与 retention，却**遗漏 E11**（malformed/unrelated response；WP-O1 §6.3 `N \| malformed/unrelated response` 行覆盖“若执行窗口不能排除则 U”）；且 §8 自称是 WP-O1 §6.3 4×7 矩阵的投影（子集）却未说明省略了哪些格 | **已补 E11**：§6.2 默认列表新增 `E11` 条目（ignore 其结算与副作用、有未排除执行窗口则建 `U`、不得凭其重做写/披露），并把“dispatch 或交付不明窗口（E07/E08/E09…）”扩为 E07/E08/E09/**E11**、“E07/E08/E09 不构成 (a)”扩为含 E11；§8 新增 `N \| malformed/unrelated response（E11）` 行与第三条投影。**已声明投影关系**：§8 明写其为 WP-O1 §6.3 4×7（28 格）矩阵的投影（子集），并**逐一列出未逐格列出的单元格**——`E11`×{U,C,F}、`auth suspension`×{N,U,C,F}、以及 C/F 的 `attempt-local rejection/no-effect` 与 `inconclusive/unknown`——说明它们**直接由 WP-O1 §6.3 对应格治理**，本包不另立规则、不放宽任何格 | §6.2（默认列表 + 下方“在这些情况下”段 + “为什么…不能开放重执行”段）、§8（新增 E11 行 + 投影/省略段） |
| R2-ADV-02 | adversarial | §3.4/§7.2 的“任何状态都不能被表达为‘未提交 / 无效果 / …’”字面覆盖 `F`，而 `F` 的逻辑含义**正是** E03 command-final no-effect（§4.1），故该禁令读起来像禁止披露一个已成立的 `F` | **已收窄禁令**为“**不得由 retention 或任何记录缺失/不可读推断**并公开为‘未提交 / 无效果 / 可换 key 重做 / 从未存在’”，并显式声明：此禁令只约束由 absence/retention 的推断，**不**禁止披露已由 `E03` 建立的 `F` 终局 no-effect（§4.1）。fail-closed 语义（absence 不产生 no-effect/commit 结论）不变，反而更精确 | §3.4、§7.2（“状态优先级”段） |
| R2-ADV-03 | adversarial | Q09 明确包含子问题“不同版本/重新登录如何恢复”（WP-O1 §10 Q09）。本包把 non-reuse landmark 与 E03 fence 绑定到 exact identity key + namespace，而 Q01 令 `identityPolicyVersion` 是 identity key 成员；故版本变化会移动 namespace，旧 landmark 不再覆盖，同 key 请求可能被当作全新命令执行，而原命令（可能已 commit 但不可读）仍未知——即攻击面 (d) 的变体。原包只声明不变量“不得把旧 identity 当新空间”并把机制推给 Q10 | **已新增可独立核验的 non-reuse 义务（O9-5）**：§7.2 第 3 条增写——non-reuse **不得**以“namespace 相等”为唯一门槛，必须**要么**证明 landmark 跨 identity/版本重绑仍存活、**要么**由 Q10 冻结的边界显式约束（旧 unknown 未解决前不得当新空间执行）。**登记为命名开放义务 O9-5**：§7.4 列其解除证据（W37 动态证据）、§12 明列并声明“**在 Q10 关闭前保持 admission blocker，不得写成 gate closed**”、§10 新增 W37 oracle、§11 新增 RA-27，§7.5/§10 尾声/§13 余留补入对应 BLOCK 判据。**未冻结任何版本值或机制**（机制属 Q10） | §7.2（第 3 条）、§7.4（O9-5）、§7.5、§10（W37 + 头部/尾声）、§11（RA-27 + 前言 W 范围）、§12、§13 |

**说明与 rebuttal：** 本 Designer 对上述五项 finding 全部复核为成立，无未采信的 rebuttal。五项均为**措辞 /
覆盖精度**缺陷（方向已是 fail-closed 且 r2 三 lens CLEAN）；r3 只做精确修正，**未削弱任何 fail-closed 行为**：
RA-P2-01 把许可指针指回唯一规范定义（不放宽、不新增 P-c 行）；R2-FC-01 修正自相矛盾的 wrapper（保留 `C`
肯定披露）；R2-ADV-01 补齐 E11 覆盖并显式声明投影/省略（不放宽）；R2-ADV-02 收窄禁令以免误读为禁止披露
成立的 `F`（absence 不产生 no-effect 结论的要求不变）；R2-ADV-03 新增可独立核验义务 O9-5 并登记为 blocker
（不冻结机制）。

**r3 新增/变更的 invariant：** 新增 RA-27（non-reuse 不得静默依赖 namespace 相等；版本/重新登录移动
namespace 时 landmark 须跨重绑存活或由 Q10 边界约束；Q10 关闭前 O9-5 为 blocker）。RA-26 的
state-relative 口径与新的 wrapper 措辞一致（无行为变更）。§14/§15 的历史日志保持原样，不改写既往记录。
