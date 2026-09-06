R7-C_R1_FRESH_DESIGN_REVIEW: CLEAN

# 1. Verdict、scope 与 claim ceiling

本次是 Stage 09P-M2 / R7-C Shadow Design r1 的独立 Fresh Design Re-review。Reviewer 不是 r0/r1 Designer，也不是 prior Reviewer；结论仅来自冻结候选、历史对照、持久上游材料和当前固定源码事实的独立核验。没有实施、修复或扩展产品代码。

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |

结论为 CLEAN。prior P1 已在本 r1 候选的设计层闭合：两个 replay operation 统一采用“任何 syntactic query component 均不准入”的 no-query 不变量，明确覆盖裸问号；该资格位于 body collector/decode、R7-A parse、认证/调度和 R7-B dispatch 之前，并被绑定到同一 attempt/operation/policy version、C→B bundle、B 入口以及客户端首次发送/retry/recovery 的不可变 operation binding。query 不是未绑定但可忽略的自由维度；未来若允许 query，必须改变 operation/identity/policy version 并重新设计和独立评审。

CLEAN 只表示 SHA-256 为 `4884b06081d009d84461b263e03bfe5c90e82035e325788fcd5b25bb53ad0627` / `b592d6aefb17a952b636d5812cd7a01351c78f33d1de2e46ee2a36946b1b1580` 的 r1 design/evidence 在本次 DESIGN_ONLY 审查范围内没有发现 P0/P1/P2。它不表示 `DESIGN_ACCEPTED`、implementation admission、Implemented、G2 admitted、M1 Accepted 或 M2 Accepted；不解除 R7-B `IMPLEMENTATION_BLOCKED`，也不解除 G-ROUTE/G-ENV/G-OUT/G-ID/G-CLIENT/G-AUTH/G-LIFE/G-BUDGET/G-LOG/G-BACKEND 十个实施阻断。

永久状态上限保持：M1=`M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`（不是 Accepted）；M1 Fresh Audit A=CLEAN；household-safety 292/292 仅为 LIMITED dynamic evidence，不是 Fresh Audit B；B-r1/r2/r3=BLOCK，B-r4 未运行；G2=`G2_NOT_ADMITTED`；source pack draft/inactive；public trust allowlist empty；M2=In Progress、整体未 Accepted；R7-A contracts=Accepted；R7-B=`R7-B_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`；R7-C Entry Gate=`DESIGN_ONLY`，implementation 未准入。

# 2. PRE baseline 与 material stopline

PRE 在任何写入前完成，未触发 `BASELINE_BLOCK` 或 `MATERIAL_BLOCK`。根 `AGENTS.md`、`README.md`、`docs/README.md` 已先完整阅读；repository status 的 porcelain 输出为空。

| Git identity | Observed | Expected | Result |
| --- | --- | --- | --- |
| HEAD | `261f0e3307f4fd9b5134e24b01ae6f461a61b727` | same | PASS |
| HEAD tree | `714aab8e9c44d4155344ea70cf48d0ee209a6cdc` | same | PASS |
| unique parent | `4cec2a9499ac71df2ca5f6537aac2aaa262af444`，且仅一个 parent | same | PASS |
| `refs/heads/codex/stage-09p-m2-inventory` | `261f0e3307f4fd9b5134e24b01ae6f461a61b727` | same | PASS |
| `status --porcelain=v1 --untracked-files=all` | 空输出 | clean | PASS |

候选和历史对照材料均存在，bytes/lines/SHA-256 逐字匹配：

| Material | Bytes | Lines | SHA-256 | Result |
| --- | ---: | ---: | --- | --- |
| r1 design | 79,559 | 409 | `4884b06081d009d84461b263e03bfe5c90e82035e325788fcd5b25bb53ad0627` | PASS |
| r1 evidence | 18,891 | 159 | `b592d6aefb17a952b636d5812cd7a01351c78f33d1de2e46ee2a36946b1b1580` | PASS |
| r0 design | 62,531 | 369 | `51bf086ce3b8df727f96bb45c3e4724dbb6a12ad1e418079d4c56786306d556e` | PASS |
| r0 evidence | 19,876 | 198 | `e7550b9f3120e59957ec02605244011e0d28ed95dc65843a8bcb117c6c2860b9` | PASS |
| prior BLOCK report | 18,349 | 161 | `6cacf04593bced1b878a6145590fbe7be7e0d306e1a04f00cba70195bbb7d9d1` | PASS |

六份持久材料从 `docs/evidence/stage-09p-m2/README.md` 进入；索引全文已读，文件身份全部通过：

| Persistent material | SHA-256 | Result |
| --- | --- | --- |
| `r7a-r6-design.md` | `179b4b7066e6bc82d3d99518abe595c6348bb6f26c23b248bc6df2182351e825` | PASS |
| `r7a-r6-evidence.md` | `d9c2b1e41bd87ca9236c5a41c6f29a1350713d304852ba83463152afc996f339` | PASS |
| `r7a-r6-fresh-review.md` | `1ad22c7258159e2ceba4aa398acf16c62422f17e8536717ab30988ca731c0ebe` | PASS |
| `r7b-shadow-design.md` | `24e1f2496df347a0215041835f45d79ba577256d13d1d6f8e7557e2b53d98d3f` | PASS |
| `r7b-shadow-evidence.md` | `93605e6893e53d8472ccde8a6213f258b7769c22b4a0fbb4e6d4ddb624136b68` | PASS |
| `r7b-shadow-fresh-review.md` | `7e77977e86cf4b03483f04efb1810c37a4357cc46f97eff54689b4a6b65b1b57` | PASS |

PRE 全部通过后，才以 `umask 077` + `mktemp -d /private/tmp/meal-agent-r7c-r1-fresh-review.XXXXXX` 创建唯一输出目录 `/private/tmp/meal-agent-r7c-r1-fresh-review.L5KGCy`。创建后实测 mode 为 `drwx------ / 700`，目录起初为空。

# 3. Actual read-set 与证据层级

以下是本 Reviewer 的实际读取范围；hash 读取不冒充语义阅读，历史测试结果不冒充本轮动态证据。

1. 完整逐行阅读 r1 design 409 行与 r1 evidence 159 行。
2. 完整逐行阅读 prior BLOCK report 161 行，独立重建唯一 P1 的冲突证据、影响和三项最小补清要求；未依赖 r1 自称 closure。
3. 完整逐行阅读 r0 design 369 行和 r0 evidence 198 行，并对 r0→r1 做零上下文 diff、T 行枚举及关键 section 摘要比对。
4. 从持久索引进入并完整阅读 R7-A design/evidence/Fresh Review 和 R7-B design/evidence/Fresh Review 六份材料；它们的历史 CLEAN/测试数字仅作为上游事实边界。
5. 完整阅读根 `AGENTS.md`、`README.md`、`docs/README.md`；定向读取 `docs/project-status.md` 当前 09P-M1/M2/R7-A/R7-B/R7-C 段、阶段 09P 计划的事务/幂等/锁序、M2 prerequisite/门禁段，以及 ADR-0003 的现有幂等身份段。
6. 定向读取/检索 `packages/contracts/src/stage09p-input.ts`、`inventory-v2.ts`、`seasoning-v1.ts` 的 parser、byte cap、deep-freeze、reason/ordinal 和两域入口；当前三文件 SHA-256 与 R7-A evidence 记录一致。
7. 定向读取 `services/api/src/app.ts`、`routes.ts`、`errors.ts`、`database/repository.ts`、`database/pool.ts`、`utils.ts`；检索 `logging.ts`、`log-events.ts` 和 OpenAPI generator/checker/committed document 的相关符号。
8. 定向读取 `apps/client/src/core/api-client.ts`、`idempotency.ts`、`command-registry.ts`、`platform/ports.ts`、`platform/taro-adapter.ts`；对 API/client/logging 相关测试源码只做静态标题、断言面和定位检索，未执行测试。

没有读取外部网页或用框架文档推断 Node/Fastify/Taro 行为。源码和测试源码只能证明当前静态形状与历史断言面，不能证明 r1 未来 runtime guard、真实 socket、adapter 或 B 集成行为。

# 4. Independent source-fact verification

| Candidate statement / boundary | Independent observation | Review result |
| --- | --- | --- |
| R7-A 只在已物化字符串上复核 B | `stage09p-input.ts:80–103,459–475,715–724` 明确注释 R7-C 需在构造 string 前执法；parser 对 `string` 计算 UTF-8 bytes，再进入 bounded raw JSON parser | accurate; not stream evidence |
| 两域 limits/reasons | 当前源码固定 B=1,048,576、logical=10,000、Inventory=17、Seasoning=388；Inventory `22000–22016`、Seasoning `25000–25016` 与候选表一致 | accurate |
| 当前 request-target/body 配置 | `app.ts:125–126,199–224,322–332` 有 2,048 target 与 1,048,576 body 配置，但 URL 已进入 Fastify request/genReqId 后才到 `onRequest` guard | accurate; cannot prove pre-materialization bound |
| 当前日志/problem 风险 | `app.ts:202–223` 接受合法 caller `x-request-id` 并从处理后的 URL 取 path；`app.ts:288–311` 从 URL 生成 `problem.instance`。这不能证明 raw query 或 query-derived 值在 guard 前零泄漏 | accurate; G-LOG/G-LIFE remains blocked |
| 当前通用 client 可携 query | `api-client.ts:31–40,50–63,88–97` 暴露 `ApiRequestSpec.query`、编码并拼入最终 URL；现有类型不构成 replay no-query binding | accurate risk fact |
| 当前 client 会重复序列化 body | `api-client.ts:82–97` 每次 call 执行 `JSON.stringify(spec.body)`；直接传 raw string 会再加 JSON string 引号 | accurate; formal replay API still absent |
| 当前 unknown disposition 不足 | `idempotency.ts:371–409` 将 transport/malformed/5xx 视为 unknown，但 generic 4xx 归 definite-failure；不能满足“既有 unknown 不被后续 query predispatch rejection 清除” | accurate; G-OUT/G-CLIENT remains blocked |
| 当前 port/Taro ceiling | `NetworkPort` 只有 Promise request；Taro adapter 配置 15,000ms，没有取消确认、exact-wire 或 query 不增补证明 | accurate; historical source only |
| legacy idempotency 不绑定 query/raw bytes | `repository.ts:690–729,826–872` 以 user/household+method+normalized route+key 查 marker，用 `requestHash(resourceTarget,payload)`；`utils.ts:13–34` 排序对象后 JSON.stringify | accurate; cannot be reused as R7-C identity proof |
| 当前认证 helper 有业务副作用 | `repository.ts:522–618` 在事务中锁 session 并更新 last_seen/idle expiry | accurate; cannot be assumed side-effect-free pre-B scheduling auth |
| COMMIT unknown 未被 wrapper 排除 | `pool.ts:30–49` 的 COMMIT 抛错后尝试 ROLLBACK，不能证明前一个 COMMIT 未完成 | accurate |
| HTTP candidate codes | `api.ts:9–50` 已有 VALIDATION_FAILED=400、RESOURCE_NOT_FOUND=404、PAYLOAD_TOO_LARGE=413、UNSUPPORTED_MEDIA_TYPE=415、RATE_LIMITED=429 等；r1 未新增 code/replay reason/ordinal | accurate |
| OpenAPI ceiling | committed document 是 3.0.3，现有 generator/checker 对 schema/metadata/committed artifact 做对账；缺 query parameter declaration 不构成 runtime rejection proof | accurate |

# 5. Prior P1 point-by-point closure audit

## 5.1 Route policy、裸问号与 earliest trustworthy boundary

Prior finding 指出 r0 只声明攻击者控制 query，却未选择 reject/non-semantic/schema+identity 三种安全结果之一。r1 design `§6:63–81` 现已选择最小 fail-closed baseline：两个 replay operation 的首次发送、retry、receipt recovery 和任何 alias 均禁止任何 syntactic query component；`?`、`?&`、空 key/value、普通参数、重复/重排与编码变体均不准入。裸 `?` 不能先解析为空对象再视作缺席。

拒绝顺序也已闭合：`§5:58` 与 `§6:77` 要求在最早仍能观察原始 request-target 语法的可信边界完成有界 framing/target 检查和 absent 判定；存在 query 或无法证明 absent 时，不开启 C owned-body collector，不进入 body decode、R7-A parse、认证/调度 scope 或 R7-B dispatch。底层可能已经接收/缓冲 octets 的事实被保留并独立计费，没有误称“物理读取为零”。

`§6:78–80` 明确排除从 `request.query`、`URL.search`、去 `?` 后 path、normalized route 或 middleware/proxy 转换后的 URL 推导 absent；proxy 已删除 query 时，应用所见 no-query 不足。caller 的 `X-Original-URL`、forwarded header 或 boolean 没有 authority。无法观察原始语法或无法证明受信入口已拒绝时，G-ROUTE/G-LIFE/G-LOG 保持阻断。

百分号编码与 component reinterpretation 没有被假装解决：`§6:79` 与 T44/T45 将 query 内编码、path 中 `%3F/%253F`、proxy/Node/Fastify/middleware 转换分开；只有未来冻结的无歧义 replay path binding 可准入，转换链不确定就安全拒绝。它既不把 path 内所有百分号错误归为 query，也不声称当前 runtime 已验证。

结论：prior 最小要求 1 已在设计层闭合。

## 5.2 Command identity 与 C→B handoff

`§11:189` 将 query 缺席定义为完整 command identity 的前置安全不变量，而不是可以 normalize、忽略或未来复用的自由维度。由于有 query 的请求没有准入资格，query 不进入 raw-body digest 或接受后的 semantic identity；这不是“同 identity 下忽略 query”。未来允许 query 必须改变 operation/identity/no-query policy version 并重新评审 client/B/receipt compatibility。

`§8:123–124`、`§11:191–202` 要求 no-query policy/version 与 verified-absent proof 绑定同一 ticket/generation、attempt、可信 operation binding 和不可变 target 资格；bundle 还把 bytes、DTO、domain、key 与 attempt 绑定到同一受控 route→collector→decode→parser 来源。body/claim/query、middleware boolean、caller header 和普通 TypeScript brand 均不能伪造运行期 authority，也不能跨 attempt 混搭。

B 只接受其批准的 policy/version 与可信来源匹配的 bundle；missing/wrong-version/stale/mixed proof 在业务处理和 identity/receipt lookup 前 fail closed。该要求只是 B 抽象接口前置条件，没有选择 DB schema、SQL、MAC、persisted lookup、lock、receipt 或 cancel 实现。

结论：prior 最小要求 2 已在设计层闭合。

## 5.3 Client immutable snapshot 与 cross-attempt unknown

`§11:221–228` 明确承认现有 client API 不支持该能力，并要求正式 replay client API 在类型、typed registry、operation binding 三层不提供 query 输入；不能把通用 `ApiRequestSpec.query` 交给 replay operation。运行期还必须捕获 cast/动态调用、`baseUrl`/`path` 夹 `?`、adapter/middleware 附加 query 与 retry 换 binding；发现后拒绝，不能“删除 query 再发送”。

首次发送及所有 retry/recovery 固定同一 no-query operation binding、policy/identity version、serialized body、key 与 scope；旧 unknown command 不得被 latest registry 静默重绑到新 policy。客户端自身的 boolean 不构成 absent proof，最终 wire 仍由 server 早边界独立验证。

原 attempt 已 unknown 时，query 变体无论本地阻断、得到 400/404/其它 predispatch rejection，还是安全关闭，都不能把原命令结算为 definite failure。`§11:224,227–228` 与 same-key/query 行明确保留原 no-query binding/body/key/unknown latch；只有 B 针对原身份的权威 receipt，或覆盖全部相关 attempts 且证明不再可能 commit 的最终零效果证据，才能解除 unknown。

结论：prior client snapshot/cross-attempt 要求已在设计层闭合。

## 5.4 Joint gates、budget、logging、HTTP 与 OpenAPI

`§12:277–287` 不再把 G-ROUTE/G-ID/G-CLIENT/G-BACKEND 分开即可关闭。解除条件要求同一 candidate、operation 集合和 no-query policy/version 的完整链：raw target→可信 early rejection/absent proof→同源 C bundle→B restricted entry→client first/retry/recovery binding；G-LIFE/G-LOG/G-BUDGET 必须用同一部署链证明可见性、时序、早期 sink 与资源账。任一连接或版本不一致，相关 gates 均不能整体解除。

`§7:92` 将 request-line/request-target/query octets 与 body B 分账，纳入独立 header/native/global/scan/log budget；无 body 的超长 target 也受控。候选诚实指出当前 2,048 配置不是 pre-materialization proof，禁止创建无界 query Map/decode work，数值与实测仍由 G-BUDGET/G-LIFE 阻断。

`§13:293–299` 要求 raw/decoded query、参数名值、query digest 以及由 query 派生的 path/requestId/problem.instance/error/label 在 proxy/Node/framework/application/client 全部早期与终态 sink 中零泄漏；handler 内修补不能覆盖 guard 前泄漏。固定 operation/path template 不能由 query 选择。

`§12:232–249` 只候选复用现有 400 VALIDATION_FAILED、实际 route 未匹配时的 404 RESOURCE_NOT_FOUND，或底层安全关闭；不新增 ApiErrorCode、replay reason 或 ordinal，不把未发生的 R7-A parse 伪造成 JSON/replay reason。`§14:301–315` 明确 OpenAPI 不声明 query 参数不等于 runtime 禁止 query，且把 middleware 消费后删除 query 的接线列为必备 mutant。

结论：gate/budget/logging/HTTP/OpenAPI 的 prior P1 连接已在设计层闭合；所有 runtime 能力仍明确未实测。

## 5.5 Attack matrix and oracle

r1 `§15` 的完整矩阵为 T01–T50，编号连续、无缺号、无重复；执行数明确为 0。T42–T50 分别覆盖：无 query 与裸 `?`/空形态；duplicate/reordered/case；percent encoding/非法 encoding；path 编码分隔符与 component reinterpretation；same-key/body 仅改变 query 并试图选择业务分支；unknown 后 query retry；client query/type/registry/baseUrl/path/adapter 误接线；guard omission/parse-empty/middleware-delete 及 missing/wrong/mixed/caller proof；部署链 raw-target 可见性、早日志、derived value 与独立 target budget。

query 组共同 oracle 明确要求 body decode/R7-A parse/认证调度/B dispatch 均为 0，client 本地拦截时 network=0；既有 unknown latch 与原 binding/body/key 保持；raw 与 derived 值零泄漏。T49 又把网络 query 请求的 `B call=0` 与“绕开网络直接向 B 接口注入非法 bundle”的负例分开，后者要求 B business processing/effect=0，避免混用 oracle。

结论：prior 最小要求 3 已在设计层闭合。

# 6. r0 regression and core-axis challenge

机械保持结果：

| Compared content | r0 SHA-256 | r1 SHA-256 | Result |
| --- | --- | --- | --- |
| T01–T41 exact table rows | `7f7010b8709481caa09a5abd5f6fdcdf11281601ec8333e74688f4059d3aa612` | same | byte-identical |
| complete `§9 Deadline ownership and cancellation ladder` extraction | `e4677d3138ce23ad0042a2ee6e71bf98131f69fd3091886aa92dfa6772cec2a6` | same | byte-identical |
| complete `§10 Concurrency/backpressure/fairness model` extraction | `95bd32d0ea62bde0d405ffdaaa1f9cfbdafc04594d8914dec9a9b173334c63f9` | same | byte-identical |
| complete `§16 R7-B forbidden responsibilities` extraction | `3dfc743b8b56eae34ec58e3cb596ba2b4b6d6fe45d2afba0006a9c219bab52e5` | same | byte-identical |

零上下文 diff 的删除项仅是 r1 verdict/header、Proposed 说明、表头、handoff 来源链、十个 gate 条目及 evidence 文件名等被有意增强后的旧行；其余为 query 定向新增。完整逐行对照没有发现 r0 的 byte/media/stream/lifecycle/outcome 约束被删除、弱化或矛盾化。

| Core axis | Independent challenge | Result |
| --- | --- | --- |
| Media/framing/encoding | Content-Type/charset/Content-Encoding/CL/TE/trailer/Expect/BOM 仍分轴；duplicate raw header、CL smuggling、HTTP/2/proxy 与挂点能力仍要求真实证据 | CLEAN as unresolved design |
| Pre-string byte cap | actual octets、`m≤B−n` before copy/string/hash、B−1/B/B+1、不截断、strict UTF-8 与 R7-A string recheck 保持；overshoot borrowed allocation 独立承认 | CLEAN |
| Memory ownership | owned immutable range、禁止巨大 backing buffer 小 view、R/S/W/P/D/O/H/U 同峰、owner/reservation transfer、global formula 保持 | CLEAN as G-BUDGET blocker |
| Lifecycle/settlement | input/execution/response/cleanup 四轴、ticket/generation、late callbacks、close-after-end、abort-after-dispatch、one dispatch/response/release 保持；no-query proof 只增加 waiting→collecting 前置资格 | CLEAN |
| Deadline/cancellation | transport/parser/request/B lock/statement/transaction/commit/client/retry 仍分开；same-loop timer 不能抢占 sync parser、commit timeout 不等于 rollback、unknown work 继续计费 | CLEAN as unresolved |
| Concurrency/fairness | preauth/global 与可信 scoped leases、all-or-none admission、bucket cardinality、无应用等待队列、rate/bytes/work fairness、multi-instance scope 保持 | CLEAN as unresolved |
| Identity/outcome | raw-byte identity仍为 Proposed；legacy semantic hash不可替代；known-commit/known-no-effect/unknown 证据范围与 same-result receipt 不被 query 补丁弱化 | CLEAN as unresolved |
| HTTP/result | transport problem、R7-A rejected result 与 R7-B outcome 继续分轴；没有把 unknown 塞入 INTERNAL_ERROR/409/replay reason | CLEAN as unresolved |
| Logging | 原 body/key/claim/checkpoint/digest/path/requestId/error sinks 保持，并新增 raw/derived query 全链零泄漏；没有把 hash 当脱敏 | CLEAN as unresolved |
| OpenAPI | schema 可表达面与 runtime guard/bytes/framing/deadline/authority 不可证明面保持，新增 no-query 缺 guard mutant | CLEAN |
| R7-B authority boundary | 没有选择或授权 schema/DDL/SQL/RLS/GRANT/index/lock key/isolation/staging/live materialization/MAC/persisted lookup/TTL/receipt retention/cancel implementation | CLEAN; R7-B remains IMPLEMENTATION_BLOCKED |

# 7. Findings

没有 P0、P1 或 P2 finding。

prior P1 的历史 verdict 仍是 `R7-C_FRESH_DESIGN_REVIEW: BLOCK`，不能被改写；本报告只判定其指出的设计缺口已由新的精确 r1 candidate 在设计层闭合。该 closure 不证明未来实现能满足 raw-target observation、trusted proof provenance、client exact send、B restricted entry、zero-leak logging 或 bounded budgets。

# 8. Residual unresolved items / implementation blockers

以下均未因 CLEAN 获得选择、批准或动态证据：

1. 两域实际 URL/method/operationId/version/media/header contract，以及可在 body/auth/B 前观察 syntactic query presence 的精确 Node/Fastify/proxy hook；裸 `?`、absolute/origin form、编码 path 与部署转换链的真实 socket 行为。
2. no-query policy/version、verified-absent proof 和 immutable bundle 的具体运行期表示、跨 execution-domain source authenticity、attempt/ticket binding 与 B entry enforcement；普通 brand、header 或 caller boolean 不足。
3. pre-string collector 的物理挂点、duplicate raw header、CL/TE smuggling、Expect/trailers、HTTP/2、close/abort/event order、overshoot allocation 与 bounded cleanup。
4. 单请求/全局 heap/native/socket/header/request-target/log/response 预算、同步 parser CPU bound、concurrency/rate/fairness 数值、multi-instance 协调和 residual unknown work cap。
5. parse 后无副作用 authentication/scheduling scope；现有 `#withAuthenticated` 不能直接复用；B 决策点的独立 authorization/revocation fence。
6. raw-byte identity 的最终 version/encoding/domain separation、legacy ledger namespace compatibility、receipt/tombstone identity 与 parser-version migration。
7. 正式 replay client 类型/API/registry/ports、final URL guard、once-serialized exact octets、真实 Taro header/charset/query/timeout/abort 行为、进程重启 locator/status recovery。
8. B 的 known-no-effect/commit/unknown/cancel/ownership/receipt recovery 抽象 contract 及所有 persistence/transaction/lock/retention 机制；R7-C 不代选任何一项。
9. HTTP success/rejected/problem/unknown envelope、evidence scope（本 attempt 或整个 command）、client disposition 与 no-response recovery；后续 predispatch 4xx 不得清除旧 unknown。
10. proxy/framework/application/client 的 guard 前后日志投影、caller requestId、path/problem.instance/error/label/query-derived 值和 sink/native buffers 的全链 sentinel 证据。
11. OpenAPI 接入、runtime binding、缺 guard/错误 middleware mutant、真实 adapter/socket 矩阵，以及 T01–T50 的全部未来证据。当前 50 组执行数均为 0。
12. M1 Accepted、G2 admission、B-r4、source activation、public trust allowlist、migration/DB/RLS/SQL/N-1 和 M2 总验收均不在本报告权限内。

# 9. Work explicitly not executed

- 未运行 Node/pnpm 产品测试、Fastify/app.inject/真实 socket/Taro 实验、typecheck/build、generator、checker 或任何 gate。
- 未运行 T01–T50；没有把任何未来 case 写成 passed。
- 未运行 DB、SQL、migration、RLS/GRANT、PostgreSQL、Docker、N-1、backup/restore、B-r4、G2、Stage09A 或 Stage09P 产品门禁。
- 未联网、未查询外部框架文档或外部服务，未接触真实用户/家庭/健康/食品/凭据数据。
- 未修改 repository、Git admin、r1/r0/prior review、六份持久材料、source、tests、fixtures、manifest、OpenAPI 或 `docs/project-status.md`。
- 未创建 commit、branch、stash、checkout/switch、worktree、push、PR 或 merge；未创建子任务或委派。
- 唯一写入是 PRE 后创建的 0700 临时目录及其中这一份 Markdown 报告。

# 10. POST、non-modification 与 delivery identity

语义审查完成、报告落笔前的封口对账已通过：repository status 仍为空；HEAD/tree/唯一 parent/branch ref 仍分别为 `261f0e3307f4fd9b5134e24b01ae6f461a61b727` / `714aab8e9c44d4155344ea70cf48d0ee209a6cdc` / `4cec2a9499ac71df2ca5f6537aac2aaa262af444` / `261f0e3307f4fd9b5134e24b01ae6f461a61b727`。六份持久材料、r1 两份、r0 两份和 prior report 的 SHA-256、bytes/lines 均与 PRE 完全相同；输出目录仍为 0700 且当时为空。

本报告定稿后还将重复同一组只读最终 POST，并核对该目录只含本报告。为避免自引用伪证，最终 raw full-file SHA-256 不写回自身字节流；封口后的 raw bytes/lines/SHA-256 记录在只读工具输出及最终交付消息。下列固定宽度字段用于本文件内部完整性记录；规范化摘要仅把唯一 `SELF_SHA256_NORMALIZED` 值替换为 64 个 ASCII `0` 后计算，其余字节（包括真实 bytes/lines）保持不变。

- directory: `/private/tmp/meal-agent-r7c-r1-fresh-review.L5KGCy`
- directory mode: `0700`
- report: `/private/tmp/meal-agent-r7c-r1-fresh-review.L5KGCy/R7-C-r1-fresh-review.md`
- files in directory after seal: exactly 1

SELF_BYTES: 000000025473
SELF_LINES: 000000000216
SELF_SHA256_NORMALIZED: d179d08597bba3b2f8e51915fe34de20e65f0c63593489a2684a420c0be4893f

封口后不再修改本报告。
