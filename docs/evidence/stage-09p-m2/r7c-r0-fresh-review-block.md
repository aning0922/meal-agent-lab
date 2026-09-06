R7-C_FRESH_DESIGN_REVIEW: BLOCK

# 1. Verdict and scope

本次是 Stage 09P-M2 / R7-C Request-Stream and Route Integration 的独立 Fresh Design Review。Reviewer 未参与候选设计，不采用 Designer 的 READY_FOR_REVIEW 或覆盖结论作为审查结论；没有实施、修复或扩展产品代码。

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 1 |
| P2 | 0 |

结论为 BLOCK。唯一 P1 是：攻击者可控 query 没有被纳入 replay route 的封闭输入政策和幂等身份。候选可以继续作为 DESIGN_ONLY 材料，但在设计层补清该边界并形成新的精确候选前，不能进入设计接受或实现准入。

本结论不改变任何永久状态上限：M1 仍是 M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS；M1 Fresh Audit A 仍为 CLEAN；household-safety 292/292 仍只是 LIMITED dynamic evidence；B-r1/r2/r3 仍为 BLOCK，B-r4 未运行；G2 仍是 G2_NOT_ADMITTED；source pack 仍为 draft/inactive；public trust allowlist 仍为空；M2 仍为 In Progress 且整体未 Accepted；R7-A contracts 仍为 Accepted；R7-B 仍为 R7-B_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED；R7-C Entry Gate 仍仅 DESIGN_ONLY，R7-C implementation 未准入。

# 2. Frozen inputs and review boundary

审查对象仅为：

- /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md
- /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-evidence.md

Reviewer 完整逐行阅读两份 R7-C 输入，并从 docs/evidence/stage-09p-m2/README.md 进入、核对并阅读六份持久上游材料。R7-A/R7-B 的历史 CLEAN、测试数字和验收状态只作为既有材料，不是本轮动态证据。

实际只读核验还覆盖：根 AGENTS.md、README.md、docs/README.md 全文；docs/project-status.md 当前 09P-M1/M2/R7-A/R7-B/R7-C 段；阶段 09P 计划的事务/幂等/锁序、M2 prerequisite、门禁和证据口径；相关 ADR 定位；packages/contracts 的 replay parser、两域入口、API/problem/http contracts；services/api 的 app/routes/errors/pool/repository/utils/logging/log-events/OpenAPI 源码；apps/client 的 api-client/idempotency/dispatcher/registry/ports/Taro adapter；相关测试源码只作静态断言面参考。

没有把源码中的测试标题、历史报告或 committed OpenAPI 当成本轮运行结果。没有读取外部网页来推断 Node/Fastify/Taro 行为。

# 3. PRE material and baseline verification

PRE 在创建报告目录之前全部通过。

| Item | Observed | Expected | Result |
| --- | --- | --- | --- |
| repository status | git status --short 空输出 | clean | PASS |
| HEAD | 261f0e3307f4fd9b5134e24b01ae6f461a61b727 | same | PASS |
| HEAD tree | 714aab8e9c44d4155344ea70cf48d0ee209a6cdc | same | PASS |
| unique parent | 4cec2a9499ac71df2ca5f6537aac2aaa262af444 | same，且仅一个 parent | PASS |
| branch ref | refs/heads/codex/stage-09p-m2-inventory = 261f0e3307f4fd9b5134e24b01ae6f461a61b727 | same | PASS |
| R7-C design | 62,531 bytes / 369 lines / 51bf086ce3b8df727f96bb45c3e4724dbb6a12ad1e418079d4c56786306d556e | exact | PASS |
| R7-C evidence | 19,876 bytes / 198 lines / e7550b9f3120e59957ec02605244011e0d28ed95dc65843a8bcb117c6c2860b9 | exact | PASS |

六份持久材料 PRE SHA-256：

| Material | SHA-256 | Result |
| --- | --- | --- |
| r7a-r6-design.md | 179b4b7066e6bc82d3d99518abe595c6348bb6f26c23b248bc6df2182351e825 | PASS |
| r7a-r6-evidence.md | d9c2b1e41bd87ca9236c5a41c6f29a1350713d304852ba83463152afc996f339 | PASS |
| r7a-r6-fresh-review.md | 1ad22c7258159e2ceba4aa398acf16c62422f17e8536717ab30988ca731c0ebe | PASS |
| r7b-shadow-design.md | 24e1f2496df347a0215041835f45d79ba577256d13d1d6f8e7557e2b53d98d3f | PASS |
| r7b-shadow-evidence.md | 93605e6893e53d8472ccde8a6213f258b7769c22b4a0fbb4e6d4ddb624136b68 | PASS |
| r7b-shadow-fresh-review.md | 7e77977e86cf4b03483f04efb1810c37a4357cc46f97eff54689b4a6b65b1b57 | PASS |

PRE 没有触发 BASELINE_BLOCK 或 MATERIAL_BLOCK。Reviewer 随后仅创建 /private/tmp/meal-agent-r7c-fresh-review.4zjwuE，目录权限为 0700。

# 4. Independent source-fact verification

| Candidate claim / boundary | Independent observation | Result |
| --- | --- | --- |
| Fastify bodyLimit and current mappings | services/api/src/app.ts:125-126,199-224,144-182 确认 1,048,576 bodyLimit、现有 413/415 映射以及 request body 进入框架前后的能力不能从配置本身推出 | accurate, limited |
| R7-A is string-side, not stream-side | packages/contracts/src/stage09p-input.ts:80-103,459-475,715-725 确认 parser 对已物化 string 复核 UTF-8 bytes；它不能证明 pre-string stream cap 或非法 UTF-8 未被替换 | accurate |
| canonical/raw/deep-freeze distinction | stage09p-input.ts:480-713 与两域 parser 入口确认 duplicate JSON key、canonical token、resource guard、Zod 后 deep freeze；对象属性顺序没有被定义为 raw identity canonicalization | accurate |
| current auth helper has side effects | services/api/src/database/repository.ts:522-618 确认现有 authenticated helper 在事务内锁 session，并更新 last_seen_at/idle_expires_at；不能直接当无副作用 upload auth | accurate |
| legacy idempotency is semantic | services/api/src/utils.ts:13-34 与 repository.ts:690-729,809-872 确认 legacy hash 对对象排序后 JSON.stringify，key scope 使用 user/household + method + normalized route；不是 exact raw bytes identity | accurate |
| COMMIT unknown is not ruled out | services/api/src/database/pool.ts:30-49 确认 COMMIT 抛错后 catch 尝试 ROLLBACK，源码本身不能证明前一个 COMMIT 没完成 | accurate |
| client serializes on each call | apps/client/src/core/api-client.ts:68-97 确认每次 call 对 spec.body 再 JSON.stringify；readonly command 类型不冻结最终 transmitted bytes | accurate |
| current client unknown behavior | apps/client/src/core/idempotency.ts:371-410 确认 transport/malformed/5xx 保持 unknown，而 generic 4xx 进入 definite-failure；新跨-attempt unknown 语义确实不能直接复用现状 | accurate |
| Taro/port capability ceiling | apps/client/src/platform/ports.ts:8-25 与 taro-adapter.ts:15-33 确认 NetworkPort 没有 abort/deadline confirmation，Taro timeout 为 15,000ms；没有源码证据证明原样 bytes、header/framing 或及时取消 | accurate |
| logging bypass risk | services/api/src/app.ts:202-223,288-311 与 logging.ts:718-757,923-990 确认当前可接受合法 caller x-request-id，并保存 path；problem.instance 也来自 request URL path | accurate |
| OpenAPI ceiling | services/api/scripts/openapi.ts、generate-openapi.ts、check-openapi.ts 及 committed stage-08.openapi.json 确认当前是 OpenAPI 3.0.3、legacy root registry 和 generated/committed 对账；这些不能证明 raw collector/runtime guard | accurate |

# 5. Core invariant challenge

| Area | Review result | Independent challenge |
| --- | --- | --- |
| Pre-string byte cap | CLEAN within stated design | design 75-82 明确把 actual octets、先比较 m≤B-n、B-1/B/B+1、不截断、strict UTF-8、BOM 和 R7-A string recheck 分开；77 明确认可单个 overshoot borrowed chunk 已由平台分配，91-94 又把它放进独立 upstream/global 账。没有用 Fastify bodyLimit 冒充 collector。 |
| Media/encoding/framing | CLEAN as a blocked proposal | design 57-71 将 Content-Type/charset/Content-Encoding/Content-Length/Transfer-Encoding/trailers/BOM/framing 分开，69-71 明确 raw-header 可见性和准确挂点未经真实 socket 证据就阻断。具体 Node/Fastify 行为没有被写成已证实事实。 |
| Memory ownership | CLEAN as unresolved | design 79-94 要求 owned storage、禁止巨大 backing buffer 小 view、同一 sealed range、不可变 handle、R/S/W/P/D/O/H/U 全峰值计费和 owner/reservation 转移；数值仍在 G-BUDGET，未冒充已闭合。 |
| Lifecycle and settlement | CLEAN | design 97-126 分开 input/execution/response/cleanup 四轴，以 ticket/generation 约束 data/end/error/close/abort/timeout/late callback；最多一次 handoff/response attempt/lease release，不把 response finish 当 client receipt。 |
| Deadlines/cancellation | CLEAN as unresolved | design 128-154 正确认可同 event-loop timer/Promise.race 无法抢占同步 parser，区分 transport/parser/request/B lock/statement/transaction/commit/client/retry deadline，并要求 unknown backend work继续计费。 |
| Admission/fairness/backpressure | CLEAN as unresolved | design 156-166 区分 preauth/global 与可信 principal/household/session，要求 all-or-none lease、bucket cardinality、无应用等待队列、速率/bytes/work-time fairness、multi-instance scope 和 residual work cap；所有数值/算法仍阻断。 |
| Raw identity and R7-B boundary | BLOCK only for P1-1 below | body octet identity、legacy semantic hash冲突、client once-serialized body、B outcome authority、ownership和取消边界本身均有清楚拆分；但完整 request identity 未覆盖 query。 |
| HTTP/result/outcome | CLEAN as unresolved | design 208-265 将 transport problem、R7-A ok:false 与 R7-B known/unknown 分轴；缺 public code 时保持 gap，不把 commit unknown 塞入 INTERNAL_ERROR/409/现有 replay ordinal。 |
| Logging/telemetry | CLEAN as unresolved | design 267-274 覆盖 raw/text/DTO/key/body digest/claim/checkpoint、path/query、x-request-id、error/cause/rawPacket、framework/event/access/proxy/stderr/client telemetry；G-LOG 明确阻断当前接线。 |
| OpenAPI | CLEAN | design 276-288 明确列出可声明与不能证明的 runtime semantics，并要求缺 guard 反例；没有用文档一致性替代 raw route 证据。 |
| Future tests / G gates | BLOCK only for P1-1 below | T01-T41 实质覆盖主要 byte/stream/lifecycle/deadline/concurrency/client/B/log/OpenAPI 反例，且明确执行数为 0；十项 G-* 维持实施阻断。不过 query 只出现在日志 sentinel，不在 route/identity 攻击矩阵，G-ROUTE/G-ID/G-CLIENT 的解除条件也没有把它们联结起来。 |
| R7-B forbidden responsibilities | CLEAN | design 351-360 没有选择 schema/DDL/SQL/RLS/lock key/isolation/staging/receipt retention/cancel implementation；缺 B 能力时 route 保持未准入。 |

# 6. Findings

## P1-1 — Attacker-controlled query is absent from the command identity and route invariant

Candidate locations:

- R7-C-shadow-design.md:47 explicitly declares query attacker-controlled.
- R7-C-shadow-design.md:55-71 defines route/media/framing policy but never states whether a replay route forbids all query components, treats them as deliberately non-semantic, or validates them as semantic input.
- R7-C-shadow-design.md:170-184 defines raw identity, key scope and the C→B bundle using principal, household, operation/domain, method, normalized route, key, body, session/aggregate fields and versions; query is absent.
- R7-C-shadow-design.md:194-206 defines same-key/same-bytes retries and the client immutable snapshot; it saves operation/domain/route/scope and serialized body, but not query identity.
- R7-C-shadow-design.md:252-263 lists G-ROUTE and G-ID separately. G-ROUTE says URL is to be frozen, but neither gate requires one of the three safe query outcomes above or requires a semantics-bearing query to be included in G-ID/B/client identity. Reading URL broadly does not supply a comparison rule or cross-gate invariant.
- R7-C-shadow-design.md:295-337 has no same-key/same-body/different-query, duplicate-query-key, order, percent-decoding or query-version case. T37 mentions query only as a logging sentinel, not as execution identity.

Independent conflicting evidence:

- apps/client/src/core/api-client.ts:31-40 exposes ApiRequestSpec.query; lines 50-63 serialize it; lines 90-97 append it to the URL. Thus the repository's normal client boundary can carry query and does not make its absence a structural fact.
- services/api/src/database/repository.ts:698-710 and docs/architecture/decisions/0003-identity-tenancy-and-api-semantics.md:161-174 show the current ledger identity is method + normalized route + key plus resourceTarget/payload hash; query is not independently bound. The candidate already says this legacy mechanism cannot be assumed safe for raw identity, but it does not close the query dimension either.
- Accepted R7-B shadow design 116-122 likewise defines operation/domain/key/full body identity without a query rule. R7-C cannot assume R7-B will repair a transport/route component that was never handed off.

Why this blocks safe design acceptance:

A future route freeze could introduce or accidentally honor a query parameter for mode, version, target selection, response/receipt form, or another execution-relevant branch. Two requests could then have the same authenticated scope, method, normalized route, idempotency key and exact body bytes while differing in query semantics. Under the documented bundle, B has no value with which to distinguish them. It may replay the wrong historical receipt, suppress a distinct command, or evaluate one semantic operation under another's idempotency identity. Conversely, treating arbitrary queries as silently ignored without freezing that rule leaves later middleware or version changes able to turn a previously ignored component into command semantics without an identity-version change.

The current G-ROUTE implementation block reduces immediacy but does not remove the design defect: its stated解除条件 can be met by choosing a URL without proving how query participates in identity, while G-ID can be closed using the listed fields and still omit query. The future T01-T41 plan would not detect the cross-product.

Minimum design-layer clarification required; no implementation patch is requested:

1. Freeze one explicit invariant for both replay operations: either reject any non-empty query before parse/dispatch, or define an exact validated query schema whose canonical identity is included in operation identity. If arbitrary query is accepted but ignored, state that it is non-semantic and prove no route/middleware/B branch consumes it; rejection is the smaller fail-closed baseline.
2. If any query is semantic, define duplicate-key, ordering, percent-encoding/decoding, empty-value and Unicode/error behavior; bind the approved representation or semantic projection to C→B handoff, B key/body identity/version, receipt lookup, and the client's immutable retry snapshot. This decision must be jointly reflected in G-ROUTE, G-ID, G-CLIENT and G-BACKEND rather than inferred from normalized route.
3. Add future attack cases for no-query versus different query with the same key/body, duplicate/reordered/encoding-equivalent query forms, cross-attempt unknown followed by query variation, and a guard-omission mutant. The oracle must show at most one correctly identified effect/receipt and no cross-scope disclosure.

# 7. Non-findings and residual risks

No additional P0/P1/P2 was found. In particular, the following are not silently accepted capabilities; they remain explicit implementation blockers:

- actual Fastify/Node raw hook, duplicate-header visibility, CL/TE framing, HTTP/2/proxy behavior, Expect: 100-continue and close/abort event order;
- upstream overshoot allocation, total header/socket/native/TLS/log/response memory, global/per-scope budget values, multi-instance coordination and fairness;
- strict decoder API/BOM behavior and decode→encode identity evidence;
- synchronous decoder/parser/serializer CPU bounds and inability of same-loop timers to preempt them;
- side-effect-free authentication/scheduling scope and B's independent authorization at its decision point;
- B lock/transaction/statement/commit cancellation, known-no-effect proof, outcome-unknown recovery, retention and bounded orphan ownership;
- final raw-byte identity/version/legacy namespace, client once-serialized transport, Taro exact-send/abort semantics and restart recovery;
- public HTTP/result/unknown envelope, client response correlation, retry disposition and OpenAPI/runtime wiring;
- safe logging projection before current path/x-request-id exposure and all-sink sentinel evidence.

These residuals remain G-ROUTE/G-ENV/G-OUT/G-ID/G-CLIENT/G-AUTH/G-LIFE/G-BUDGET/G-LOG/G-BACKEND blockers. This report neither resolves nor approves them.

# 8. Work explicitly not executed

- No Node/pnpm product test, Fastify experiment, real socket experiment, Taro experiment, generator, checker, gate, typecheck or build was run.
- No DB, SQL, migration, RLS/GRANT, PostgreSQL, Docker or recovery operation was run.
- T01-T41 execution count remains 0. None is reported as passed.
- No network or external-service validation was performed.
- No repository, Git admin, existing /private/tmp material, source, test, fixture, manifest, OpenAPI, docs/project-status.md or dashboard file was modified.
- No commit, branch, stash, checkout, worktree, push, PR or merge was created.
- No implementation recommendation is represented as a code patch. The only requested follow-up is design clarification and a new review candidate.

# 9. POST and delivery identity

Final POST observation: repository status remained empty; HEAD/tree/unique parent/branch ref remained exactly 261f0e3307f4fd9b5134e24b01ae6f461a61b727 / 714aab8e9c44d4155344ea70cf48d0ee209a6cdc / 4cec2a9499ac71df2ca5f6537aac2aaa262af444 / 261f0e3307f4fd9b5134e24b01ae6f461a61b727. The six persistent-material hashes and both R7-C input hashes remained exactly equal to PRE. No BASELINE_BLOCK or MATERIAL_BLOCK occurred during POST.

Only one reviewer-created file exists in the reviewer-created directory:

- directory: /private/tmp/meal-agent-r7c-fresh-review.4zjwuE
- directory mode: 0700
- report: /private/tmp/meal-agent-r7c-fresh-review.4zjwuE/R7-C-fresh-review.md

SELF_BYTES: 000000018349
SELF_LINES: 000000000161
SELF_SHA256_NORMALIZED: d7dc266718e405a76ff6321f5236d97b5a4ad823d0e67e643b208c246a8da066

SELF_BYTES and SELF_LINES use fixed-width decimal fields. SELF_SHA256_NORMALIZED is computed after replacing the value on its unique record line with 64 ASCII zeroes; it is not the raw full-file SHA-256. The final raw bytes/lines/SHA-256 are computed after report closure and recorded in the delivery response, because embedding a raw full-file hash in the same byte stream would change that hash.
