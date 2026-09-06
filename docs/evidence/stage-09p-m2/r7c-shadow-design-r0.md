READY_FOR_REVIEW

# 2. Scope/non-authority

Stage 09P-M2 / R7-C Request-Stream and Route Integration Shadow Design，2026-09-06，独立 Designer。
本文件仅提交独立 Fresh Design Review；READY_FOR_REVIEW 不是审查结论、实现准入或产品验收。没有实现、修复、产品测试、子任务或委派。
范围为 request stream、route integration、deadline/concurrency、HTTP/OpenAPI/client handoff；R7-B 只以抽象能力依赖出现。
下文“必须/禁止”是本候选的安全不变量。除明确引用的既有冻结合同和源码配置外，全部新策略、接口形状、公开映射与数值预算均为 Proposed/未决，不能据此实施。接口表是责任描述，不是 TypeScript DTO、网络协议或数据库设计。
任务书唯一 write-set 覆盖 AGENTS.md 的通用阶段完成后更新 project-status 约定：本轮只写新 0700 临时目录中这两份 Markdown，不更新仓库状态文档。

# 3. Baseline/status

仓库：`/Users/aipuli/.codex/worktrees/a85e/meal-agent-lab`。PRE 全部通过，POST 封口对账见同目录 evidence。

| 身份 | 固定期望值，PRE/POST 均须逐字相同 |
| --- | --- |
| HEAD | `261f0e3307f4fd9b5134e24b01ae6f461a61b727` |
| tree | `714aab8e9c44d4155344ea70cf48d0ee209a6cdc` |
| 唯一 parent | `4cec2a9499ac71df2ca5f6537aac2aaa262af444` |
| refs/heads/codex/stage-09p-m2-inventory | `261f0e3307f4fd9b5134e24b01ae6f461a61b727` |
| status --porcelain=v1 --untracked-files=all | 空输出 |
| R7-A contracts 实施落点 | `63d2a0668df3e1291cb3a863327bd5aeed6dd034` |

固定状态不变：M1 = `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`，不是 Accepted；M1 Fresh Audit A = CLEAN；household-safety 292/292 = LIMITED dynamic evidence，不是 Fresh Audit B；B-r1/r2/r3 = BLOCK，B-r4 未运行；G2 = `G2_NOT_ADMITTED`；source pack = draft/inactive；public trust allowlist empty；M2 = In Progress、整体未 Accepted；R7-A contracts = Accepted；R7-B = `R7-B_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`；R7-C Entry Gate 任务 `01a07283-f43f-7831-a87c-c52a5b997f71` = DESIGN_ONLY；R7-C implementation 未准入。
Entry Gate 状态来自任务书及当前 docs/project-status.md 的耐久性收口段，不声称读取过任务本体。README/ADR/上游报告中的历史状态不覆盖以上当前状态。
六份持久材料从 `docs/evidence/stage-09p-m2/README.md` 进入，路径与 SHA-256 全部对账。索引明确说明由结构化 FileChange 的 add/update 恢复精确字节，claim ceiling 不变；不再依赖历史临时路径。

# 4. Existing evidence vs untested assumptions

| 只读来源与定位 | 当前可陈述的事实 | 不能由此推导 |
| --- | --- | --- |
| services/api/src/app.ts：maximumRequestBodyBytes、Fastify 构造、mapRequestError | 配置 bodyLimit=1,048,576；现有 413/415→PAYLOAD_TOO_LARGE/UNSUPPORTED_MEDIA_TYPE；JSON 错误→VALIDATION_FAILED；兜底 INTERNAL_ERROR | 未观察真实 stream 的分块、超限分配、结束/断连/超时行为；不能认定自定义 collector 仍自动受到 bodyLimit 执法 |
| routes.ts：idempotencyHeadersSchema、bearerToken、commonErrorResponses；contracts/http.ts | legacy handlers 消费 request.body；header schema 使用归一化后的 idempotency-key；当前成功 envelope 是 ok/data/meta | 不存在由这些代码证明的 M2 raw route、duplicate-header 检查或 R7-B handoff；security 声明不是运行时认证 |
| stage09p-input.ts：maxReplayChunkUtf8Bytes、parseStage09pReplayChunkJsonText；两域 raw parser | 已物化 string 上复核 UTF-8 bytes；canonical token/duplicate key/resource guard；成功 DTO deep readonly/deep frozen | 不能防止读取 HTTP stream 时先形成巨大字符串；不能验证已经替换解码掉的非法 UTF-8；canonical token 不等于属性排序协议 |
| R7-A 三份持久证据及 contracts tests 的 replay 部分 | 上游记录 string-side B/B+1、多字节、严格 empty、deep freeze 等历史证据；两域上限 17/388、logical 10,000 | 本轮未重跑；不证明任何 HTTP 字节流、R7-B 或 Taro 行为 |
| R7-B 三份持久证据 | 接受了设计的不变量与责任边界；persisted lookup、per-chunk staging、raw-byte identity 仍 Proposed | 未批准任一持久化机制、数据库取消协议或新公开失败语义 |
| database/repository.ts：#withAuthenticated、#loadIdempotentReplay；utils.ts | 当前认证 helper 在事务内锁 session、更新 last_seen/idle expiry；legacy hash 对 object 排序后 JSON.stringify；既有 replay 查询带锁 | 不能把该 helper 当 upload 前的无副作用认证；不能将 legacy hash 作为 exact raw bytes identity；不能照搬为 R7-B fast-path |
| database/pool.ts：withAppTransaction、Pool 配置 | 当前有 BEGIN/COMMIT、catch 尝试 ROLLBACK、finally release；pool 数量与 connect/idle 参数是既有配置 | catch 中尝试 ROLLBACK 不证明前一个 COMMIT 未完成；pool connect/idle 参数不是 statement、lock 或 request timeout |
| client api-client.ts、idempotency.ts、dispatcher、registry、ports、taro-adapter.ts | 每次 call 再 JSON.stringify(spec.body)；pending 保存 command、key、principal、generation；transport/malformed/5xx 保持 unknown；Taro.request 配置 15,000 ms；NetworkPort 无 abort/deadline 参数 | command 的 readonly 类型不证明最终 serialized body 不可替换；15s 配置不证明平台准时取消或服务端回滚；内存 pending 不解决进程重启恢复 |
| HTTP/logging/client tests 源码 | HTTP 413/415 与日志用 app.inject/Writable；client 用 fake platform；可知历史测试断言面 | app.inject 或 fake adapter 不等于真实 socket、HTTP parser/header normalization、TLS、Taro/wx 网络证据 |
| openapi scripts 与 committed stage-08.openapi.json | 当前 OpenAPI 3.0.3，由 legacy 路由/root contracts 生成并做 schema/metadata/committed 对账 | 生成器一致不证明 collector、raw parser、timeout、auth、限流在 runtime 挂载 |

本轮没有联网、安装依赖、Node/pnpm、测试、Fastify/socket 实验、generator、gate、DB 或 Docker。所有 Fastify/Node/Taro 具体 stream、timeout、backpressure、header normalization 能力均为“待真实实测”；不引入凭框架文档推断的事实。

# 5. Threat/authority model

攻击者控制 method/path/query、所有 header 和 body bytes、分块大小/时序、TCP 断连与重试次数；可持有合法账户，串换 household/session/domain/aggregate、key、ordinal、claim、digest；代理或客户端可能重编码。网络、计时器、进程和 DB 可以独立故障。
HTTP message framing 由受信任传输解析边界定义；collector 计量的是该消息去除 transfer framing 后、未做 Content-Encoding 解码的实际 body octets，不是 socket/TLS 总字节。headers、chunk framing/extensions、trailers、连接和 socket buffer 有独立预算，不能藏在 B 中。
认证 principal 只能由已批准的服务端认证链证明；路由 household 是请求目标，body replaySessionId/aggregate 是关联输入。调度 ticket 不是 HouseholdContext；caller checkpoint claim、UUID、digest、`server_verified` 形状均不产生 authority。R7-B 在自己的决策点重新验证授权、服务端前缀和 receipt 资格。
collector 证明“这些受限原始字节被完整接收”；strict decode 证明合法 UTF-8；R7-A 证明局部合同；raw identity 证明相关性，不证明食品事实、权限或来源真实性。任何失败都不得补造日期、来源、checkpoint、缺失 chunk 或食品安全资格。
Proposed 顺序：最早 transport/header/global admission → 唯一 raw collector → 完整且受限 bytes → strict UTF-8 → R7-A raw parser → 受限的认证/调度 scope 解析 → scoped admission → R7-B handoff → 结果/响应。上传与同步 parser 阶段不持 DB 连接或事务锁，也不写任何业务 marker。认证拆分的可用性是 G-AUTH，未闭合不能上线。

# 6. Route/media/encoding policy

以下是 Proposed shadow baseline；实际 URL、method、operationId、认证 scope、版本兼容和 public response envelope 未冻结。仅为两域独立 replay operation 定义流程，不发布路由。不得把所有 legacy JSON 路由切到新 parser，不从 body 字段选择一个可绕过更严策略的路由。

| 输入面 | Proposed 判据与拒绝行为 |
| --- | --- |
| route/method | 只在未来明确批准的两域 route scope 安装 raw 边界；路由选定后 domain 不可改；不支持的 route 走现有 RESOURCE_NOT_FOUND，不经 replay parser。method/URL 合同未决 |
| Content-Type | 只接受单一 application/json；媒体类型 token 按已冻结后语法大小写规则识别，不对 body 做规范化。缺失、错误、text/json、任意 +json 通配、multipart 拒绝；不根据内容 sniff |
| charset | 无 charset 视作 UTF-8；若提供，只接受一个 utf-8 token（大小写等价）。拒绝重复，即使值相同；冲突、别名如 utf8、非 UTF-8、无法无歧义解析参数均拒绝。quoted value/OWS 的精确语法须与实际 parser/adapter 冻结；候选从严仅接受清楚的 token 形式，不静默剥离未知参数 |
| Content-Encoding | 缺失或单一 identity 才允许。gzip/br/deflate/stacked/comma list/重复字段，包括 identity,identity 均拒绝，拒绝发生在任何解压器之前。不能假定代理/插件透明解压安全；若上游已经转换导致原编码不可见，部署链不满足 baseline |
| Content-Length | 可缺失；存在时须为单一可无溢出比较的非负十进制字节长度。重复（同值也拒绝）、冲突、comma list、符号/指数/非法空白等拒绝；规范十进制语法及 header 长度预算待冻结。大于 B 仅凭 header 早拒绝；≤B 不提供容量或完整性 authority |
| Transfer-Encoding | baseline 仅接受已证明无歧义的 HTTP/1.1 chunked framing 或无 TE；其他 transfer coding、重复或冲突 TE、CL+TE 拒绝。HTTP/2/代理协议适配另行取证，不默认与 Node HTTP/1.1 相同 |
| trailers/Expect | 不允许 trailers 覆盖 key、length、media、encoding、身份；Proposed 拒绝带这些 late metadata 的消息。Expect:100-continue 的自动回应/拒绝顺序和预算待实测；不能在 admission 前鼓励无界上传。不支持的传输形式需在 framing 层关闭，不造新 API code |
| 空 body | count=0 为无 replay 输入，边界 VALIDATION_FAILED 候选；不得替换成 {}、[]、null 或构造 empty-history DTO。合法 empty history 是完整 strict only JSON 对象，仍必须经过所有层和 R7-B 授权，不能清空 live aggregate |
| BOM | 接收字节计数包含 BOM；UTF-8 BOM EF BB BF 即使跨 chunk 也拒绝，不能让 decoder 自动剥除。无 BOM 但 JSON 字符串字段内的 U+FEFF 由 R7-A 自身约束判断；不对合法字段做 trim/NFC/替换 |

Framing/header 问题可能在 Fastify request 建立前即被 Node 拒绝，此时可以没有应用层 problem body。header 去重、大小写折叠或 join 后才检查已经太晚；必须在首次有原始 header 多值的可信边界判别，无法观察歧义即阻断实现，不能只验证 request.headers。
Content-Length 与实际不符分两种：若 actual 由本消息 stream 暴露且 end 时 count≠声明则拒绝；若过小 CL 让余字节被底层当下一条消息，collector 不能声称看见被截去的 octets。必须未来真实 socket 验证 parser/代理无走私、截断 JSON 不交 R7-B、后续消息独立过 guard。Proposed replay 连接拒绝 pipelined 并发/异常后不复用；具体可执行连接策略待实测与准入。不能把一个长度正确的完整 JSON 后接独立合法请求误称为可由 body count 识别的 mismatch。
集成形状 Proposed：route-encapsulated 单一 binary payload owner，无 parseAs:string、setEncoding、隐式 JSON.parse、提前 Buffer.toString 或记录 body 的 hook。计数控制必须位于任何 string parser 之前；Fastify bodyLimit 保留纵深防御，不能通过两个消费者重复读取。自定义 content-type parser/preParsing/stream tap 的准确挂点及 bodyLimit 是否经过它们均未选定，须证明后才冻结。

# 7. Byte and memory accounting

B = 1,048,576 bytes 是既有 R7-A 已物化字符串复核上限；本设计要求 pre-string collector 使用相同 B，但不是声明已实现。实际累计 n 初值 0，输入块长度为 m：在保存、复制、解码、hash 或日志前检查 m≤B−n；否则本请求不可再 parse/handoff，拒绝整个消息，不截断成 B 字节合法前缀。计数是字节长度，不是 JavaScript string.length、Unicode scalar count、CL 或 chunk 个数。
B−1/B 仅表示可进入下一层，不保证 JSON 或 schema 成功；B+1 必须在任何 body string 产生前拒绝。ASCII 与多字节 UTF-8 使用完全相同 n。chunked/缺 CL 同样逐块计数。声明大于 B 时不为 body 分配 B、不读到 B 才拒绝。
单 overshoot chunk 已由平台分配的内存不能倒退抹除：collector 拒绝前不能复制该 chunk 或拼字符串，只借用长度；必须另计 upstream 已分配块、socket/highWaterMark/代理缓冲的峰值。highWaterMark 不是已证实的硬分配上限。若无法在运行组合中约束它们，全局内存准入未闭合。

Proposed owned-byte 模型：获得内存 reservation 后，collector 将合格 octets 复制到受其独占控制的有界存储，持有受限数量的段或一块 B 容量区；不能保存每个 data event 的 slice/list/closure，不能保留指向巨大外部 ArrayBuffer 的小 view。优先候选是固定容量 owned buffer、n 标记已写范围，避免最终 concat 的第二份 B；实际分配方式、复制代价、unused 尾部处置均待冻结。不得暴露可变 Buffer/Uint8Array 别名；Object.freeze(buffer) 或 readonly 类型不是字节不可变证明。
只有 validated end + framing 完整才 seal 输入。seal 之后禁止写入原 bytes，不含未初始化尾部，不拼入 CL/header/transfer framing；raw-body identity 与 strict decoder 读取同一 sealed owned 区间。immutable handle 仅开放受控读取/比较或一次所有权移交，不能给通用 hook 一个可写 view。任何 copy/transfer 均计入预算，R7-B 接管前后有明确唯一 owner。
strict UTF-8：在 n≤B 的 sealed bytes 上使用具有 fatal 语义且 BOM 策略显式的 decoder；非法首字节、isolated continuation、overlong、surrogate 编码、>U+10FFFF、truncated 均拒绝，不插 U+FFFD、不忽略尾部。可一次解码以自然跨 chunk；若未来选择 incremental decoder，必须延迟最终成功到 flush 且不得在字节上限前构建无界字符串。decoder 具体 API/options 和真实 Node 行为均待实测。
成功解码前不得进入 R7-A；成功后传入原样字符串，不能先 parse/restringify。R7-A 的 canonical JSON、string-side byte recheck、decoded resource caps 和 deep freeze 全部保持。合法 UTF-8 的 decode/encode 字节等同性需要未来证据，不能只凭编码名称代替。

| 峰值组成 | 计费原则；数值未决部分用符号表示 |
| --- | --- |
| raw owned R | R≤B 的逻辑 payload 容量；若分配 B 则从一开始按 B 预留；retained segments 数/管理对象必须有界 |
| string S | 最坏按至少 2n 字节 UTF-16 内容预算，同时计 V8 对象/rope/flatten 开销；2n 不是实际 heap 总量承诺 |
| decode/canonical 临时 W | decoder scratch、JSON.stringify 单 token、substring/parts、freeze/descriptor walk、Zod 中间图都计入；不能假定 raw/string/DTO 峰值错开 |
| decoded graph P、Zod-owned DTO D | R7-A 对象与 Zod 输出可能同时活着，event caps 17/388 不是字节预算；按冻结 node/key/scalar 上限和实际分配取证确定 M_parse |
| response O、handoff H | checkpoint/result envelope、响应序列化、R7-B 为 identity 复制或持续持有的 bytes 都纳入；如果 owner 转移，reservation 也转移而非提前释放 |
| upstream U | headers、socket/native buffers、单 overshoot borrowed chunk、代理队列、连接对象、TLS（若未来适用）独立计费；不能声称被 B 限制 |
| 全局 | M_base + Σ(M_reserved_request) + Σ(M_unsettled_backend) + M_queue + M_upstream + M_margin ≤ M_global；所有 M 数值及服务范围均 Proposed/未决 |

两个域的内存权重可不同，但任何实际最高峰未被 reservation 覆盖时不得准入。不能用 RSS 回落或 GC 请求作为及时释放保证；释放引用与实际 RSS回收不同，需余量、过载闭门和实测。
10,000 logical events 最坏可形成 10,000 个非空小 chunks；589/26 是装满时的分片数，不是最大请求数。C 每次只持当前有界 chunk，不汇聚整个 history，也不缓存一个 session 的所有 raw bodies/DTO/checkpoints。10,485,760,000 bytes = B×10,000 只是松散累计 wire 上界，不是批准的内存、持久 quota 或可用 payload 实测；重试可使传输总量更高，必须独立限速和 retry budget。R7-B persistent quota、final 计算和 checkpoint/receipt 累计存储完全未决。

# 8. Stream lifecycle + one-shot settlement state machine

不能用一个“Promise 已完成”变量同时表示 body 完整、HTTP 已结束和 DB 已回滚。还必须区分一次HTTP attempt与同key逻辑命令的历史结果：本次not-dispatched/known-no-effect不能证明之前的unknown attempt未commit。以下是 Proposed 内部状态，不是新 public discriminator：

| 状态轴 | 状态与含义 |
| --- | --- |
| input | waiting → collecting → sealed；任何错误转 input-rejected，sealed 与 input-rejected 都是一次性输入结算 |
| execution | not-dispatched → dispatched → known-committed / known-no-effect / unknown；unknown 可由 R7-B 后续权威证据解析；C 不自行作 DB 判断 |
| response | available → sending → finished，或 unavailable；只能竞争获得一次发送权；finished 不证明客户端收到 |
| cleanup | owned → cancelling/closing → released；业务处于 unresolved 时只释放已真正不再使用的资源，剩余 lease 转移给有界 backend owner |

本请求一次性 ticket/generation 绑定事件 listener、timer、parse completion、handoff completion、response completion；过期回调不能命中新请求、重新接管 buffer、释放他人 token 或再次 dispatch。所有事件只请求同一 coordinator 转换，不直接各自 reply/release。

| 事件/竞态 | 转换与 invariant |
| --- | --- |
| data，collecting | 先校验 ticket/期限/字节余量，再一次 copy/计数；任何失败 input-rejected，停止读取与后续工作。不逐块记录日志，不累积 event tasks |
| data，sealed/rejected | 不接受新输入、不重新结算；若平台允许 end 后 data，视为 transport invariant violation，禁止进一步 handoff，按实际执行轴处理且连接不复用；正常运行必须证明这种序列不会被平台交给已完整消息 |
| end，collecting | 只有已证实 framing 完整、CL一致、非空、未超时/abort 才 sealed；先完成所有完整性检查，再 decode/parse，不在最后一个 data 中提前成功 |
| end 重复/晚到 | no-op 于输入结算，不重新 decode/dispatch/释放；违反平台契约记固定分类，无输入细节 |
| error/aborted/premature close，end 前 | input-rejected，无 R7-B dispatch；响应若不可用可无 HTTP response；错误监听维持到安全关闭，不能去掉最后监听造成 unhandled error |
| close-after-end | request readable 的正常 close 不等于 client abort。不能仅靠 close 名称取消有效工作；检查实际对象、complete/end 和 writable/socket 状态。具体判据待真实 socket 验证 |
| reset/client abort，end 后 | input 保留 sealed 事实；response→unavailable；如果尚未 dispatch 禁止开始；已 dispatch 走 cancellation ladder，未知则保持 unknown；不发“确定失败” |
| timeout vs end/parse completion | 每个下一阶段入口同步重验 monotonic deadline/cancel latch；即使 timer 回调未运行，now≥deadline 也不能新 dispatch。输入失败已结算后晚到 end 不复活 |
| handler throw | dispatch 前且证实无副作用：拒绝并清理；dispatch 后不得由异常类型推断未 commit，等待 B 判定或保持 unknown；禁止 generic catch 自动包装成确定失败 |
| timeout vs B completion | 超时先发生只收回响应/继续执行许可；晚到已证实 commit 不被降成失败，只供原身份恢复；B 先给确定 commit 后网络坏掉，同样保留完成事实 |
| response send throw/serialize fail/finish 后 close | 不改变已经证实的 DB 事实；发送权不可再取，不能另写 problem；客户端可能 unknown，服务端保留 B 的恢复路径 |

一次性 cleanup 顺序约束：先关后续阶段/dispatch gate → 停止接收 body、清除/失效 timer与监听的业务回调 → 按真实传输状态停止或有界关闭输入与输出 → 等待各 owner 不再使用 bytes/DTO → 丢弃引用/归还各自 lease 一次。清理自身抛错也不跳过其它独立清理步骤；失败不触发第二次发送或第二次 B 调用。
拒绝大 body/慢流后不无界 drain 来换 keep-alive。Proposed 关闭该请求对应连接或使用证明有界的 discard，不能在共享/pipelined 连接上误杀不相关请求；baseline 并发复用能力未实测前不准入。response 错误/关闭必须有兜底界限。client abort 明确允许“无 HTTP response”。
“一次结算”保证一次输入结果、至多一次 handoff、至多一次 response attempt、每个资源 lease 归还一次；不保证网络恰好送达一次，更不承担数据库 exactly-once 机制。

# 9. Deadline ownership and cancellation ladder

所有新时长、速率、队列等待、并发预算以符号登记，均 Proposed/未决。使用服务端 monotonic clock 的绝对 deadline，不能信任 caller deadline、Date header 或墙钟变化。阶段 deadline = min(外层 deadline，阶段开始+阶段预算)，阶段切换和收到一个 byte 都不延长外层期限。

| deadline owner | 从何时到何时 | 能保证什么/不能替代什么 |
| --- | --- | --- |
| transport header/body idle/absolute | 接受连接/首 header 起的 D_header；body 开始至完整 end 的 D_body；idle/min progress 独立 | 防 slowloris/半关闭/无限小块；仅靠 idle 每滴一字节可绕过，须有总历时/速率预算。Fastify/Node timer 实際触发与连接生命周期待实测 |
| collector | 每个 data/end 检查 D_body 与外层 D_request | 超期不再保存/物化；不能阻止平台已分配一个 overshoot chunk |
| parser D_parse | 调用 R7-A 前到返回后 | 原始 parser 同步、无 abort 参数；同 event loop setTimeout/Promise.race 无法抢占。前后检查只能阻止超期结果 handoff，不能证明 CPU 硬时限 |
| request event-loop D_request | 最早可控接入到 response/资源释放交接 | 在可运行的边界收回后续阶段许可；事件循环阻塞时不能保证按时运行。硬 CPU/响应期限需已证实的有界最坏耗时或另行批准的可取消隔离边界；本设计不选择 worker/process 或改 R7-A |
| auth/scheduling | parse 后、B 前，受 D_request 剩余额度限制 | 认证读不得无限等待/更新 session；无法获取无副作用可信调度身份则不继续。G-AUTH 未决 |
| R7-B lock wait | B 决定等待界限，接收外层剩余额度 | C 取消 signal 不是已取消锁等待证据；具体 lock key/isolation/timeouts 由 B 后续批准 |
| R7-B transaction/statement/commit | 各自不同期限；commit 有不确定窗口 | statement timeout≠transaction timeout；cancel≠rollback；commit timeout≠未提交；C 不配置或实现这些判定 |
| client transport | 当前 Taro 配置 15s 每次请求 | 不是服务端 deadline、receipt retention 或总 retry deadline；实际 abort/header/body 行为待真实 adapter 取证 |
| client retry D_retry | 首次命令创建起、包含退避与所有恢复尝试 | 停止自动尝试不等于确定失败；到期仍 unknown 时保留原身份和恢复入口，不能换 key。数值与持久恢复协议未决 |

Proposed 时间预算需满足完整链的可行性关系：可接受的 transport + parse + auth/admission + B 最大操作/取消 + response 余量装进 D_request；服务端预期响应目标应考虑当前 client 15s，但不能通过写一个 D_request<15s 就证明关系成立。header 开始点、上传耗时及网络往返不同，必须真实测量；无法闭合则缩减并发/拒绝准入，不能放宽既有合同上限。

Cancellation ladder（只有逻辑交接，不设计 DB cancel 实现）：

1. 输入/parse/auth/scoped admission 失败且 not-dispatched：停止后续阶段；无 replay DB 写入。parser timeout-before-DB 的未来 oracle 是 B 调用数和认证/业务 DB 调用数均为零，使用 parse 后认证的本候选顺序。
2. handoff 入口由一次性 gate 原子核对未取消、未过期、lease有效并登记 dispatched；取消与 dispatch 谁先线性化须可取证。信号到达前登记 dispatched 后，一律按“B可能已开始”处理。
3. dispatched 后超时/abort：仅请求 B 停止后续工作，并交付外层绝对期限/取消事实；C 不自行 cancel SQL、释放连接、commit 或 rollback。B须返回权威完成事实或 unresolved；能力缺失阻断实施。
4. B 证实 known-no-effect 且原操作不再可能 commit：才可归已知中止；恢复仍先以原 key/body 经过 B 的幂等边界。仅观察不到 receipt、连接断开或请求 Promise reject 都不够。
5. B 证实 committed：只返其不可变已验证 receipt，或在响应不可用时保留恢复资格；C 不再产生确定失败。不从当前 GET 反推 receipt。
6. commit outcome unknown/取消未确认：不发确定失败、不生成新 success；没有冻结的 unknown wire envelope 时不虚构 JSON。实施被 G-OUT 阻断；抽象模型允许关闭响应让客户端保持 unknown，但这不是已批准的公开恢复协议，也不代替 B 恢复能力。
7. 取消/清理超出专属预算时，残余 B 工作必须由受限 owner 继续计入未结算并发/内存；不能响应一结束就归还执行配额并放入无限 orphan。无法证明终止或恢复能力时关闭新的 B admission，需运维/后续授权的有界处置；本文件不设计进程终止或 DB 终结机制。

# 10. Concurrency/backpressure/fairness model

所有具体 C_global、C_principal、C_household、C_session、M_global、R_rate、D_queue 和未知工作容量均 Proposed/未决。范围必须标明是单进程还是全部 API 实例；进程内 Map 不能冒充全局容量/公平性。如果未来多 worker/多实例，其总预算和协调另行准入，不自动继承此模型。
Proposed baseline 不提供应用等待队列：最早 global byte+connection+collector+parser reservation 满则 fail closed，采用现有 RATE_LIMITED 的候选过载语义或 transport close；不得接受 body 后无期限排队。系统/内核/框架隐式 backlog 仍需独立有界；“无应用队列”不等于零内存等待。
初始无法信任 principal 时由 global/preauth 预算保护 collector/parser。parse 后，已批准的无副作用认证/可见 scope 解析提供可信调度标签，才对 principal/household/replay-session 分配 scoped lease；caller header/userId 不能作为已认证桶。没有这种身份能力时无法实现真实 per-principal fairness，登记 G-AUTH 并阻断上线，不能退化成无限匿名桶。
body session 只用于有界调度关联，不能证明 session 所有权。新 session label/桶必须在已授权 household/principal 容量内创建，限制 cardinality；已有 session 的最终可见性和 scope 仍由 B验证。无法确认调度 scope时拒绝或退回受限预认证流程，不能用跨户 probe 建永久桶。
在进入 B 前，同一原子 admission 操作验证 global执行/残余容量、principal、household、session 与对应内存 reservation；全部成功才授予，失败不留下部分 token。不可在持 household lease 时等 global lease造成环；无需数据持久锁来实现 C 调度。每个请求 attempt 一个 ticket，重复 cleanup不多释放，取消在授予前后都覆盖。
候选 C_household/C_session 可以比全局更紧，数值不预设；调度互斥不代替 R7-B 持久顺序/跨进程防重放。same-key retry 不跳过 collector、内存和限流；completed receipt 恢复也会消耗传输/CPU，只有 B 决定是否零持久费用。
并发 cap 不能单独提供持续公平：反复立即重试可以霸占 slots。Proposed 还需要按可信主体/户的有界速率/累计 bytes/工作时间 admission 与受限 jitter/backoff，控制小块洪泛、10,000 小 chunks 与新 key/session 洪泛；调度算法、速率、burst、公平窗口和恢复流量预算未决，不能声称已保证无饥饿。
若未来引入队列，必须另行冻结全局/各桶队长、保存对象字节、最大等待 deadline、取消移除、fair service与防队头阻塞；禁止排队持有 DB锁、整段无预算 body 或未知任务引用。当前不选队列算法。
backpressure 只能在明确的 owner边界暂停/恢复，限流前/后状态都计入时间；pause不保证网络停止，unread buffers计入U。不以每data await产生无限 promises。重试洪泛、双principal同户、单principal多户、多session及global最后一个slot同时争抢必须未来取证。

# 11. Idempotency/raw identity/R7-B handoff

raw-byte identity 是 Proposed，未批准替换现有 semantic requestHash。候选 same-body 为完整、sealed、严格UTF-8且R7-A成功的原始body octets逐字相同，不排序、不trim、不解压、不canonicalize字段顺序、不从DTO重新构造。digest可作为非权威比较辅助，不能单独宣称无碰撞或真实性；是否用 digest、算法、版本/域隔离及持久比较机制均由后续冻结，C 不替 B选择。
headers 大小写等价不改变body；key必须先从原始header多值中确认恰好一个，再用既有 schema（16–128字符，A–Z/a–z/0–9/点/下划线/冒号/连字符）校验其值；不trim key、不接受逗号join、不在缺失时自动生成。authorization与scope必须来自可信认证链，不把 token或raw header交给通用日志。
Proposed key比较范围需要至少绑定已认证principal、授权household、operation/domain、HTTP方法/规范化route及原key；session/aggregate/kind/ordinal/claim等属于完整请求身份而不是可任意改变的key命名空间。具体与legacy ledger的兼容及operation namespace仍未决，不能只把session加入key桶来绕过同key异body冲突。

| C→B 抽象 handoff 项 | C 负责 | B/共同冻结负责；均未新增 public DTO |
| --- | --- | --- |
| attempt/operation/domain | 一次ticket、已选route/domain、截止前唯一dispatch | 同一路由身份如何进入既有command语义未决；不得由caller改domain |
| authentication evidence + scope target | 受信服务端认证证据、明确时效、解析且范围受限的请求目标；调度票据不冒充事务内HouseholdContext | B重新bootstrap与授权，receipt entitlement、撤回竞态；不能复用已结束事务的HouseholdContext |
| Idempotency-Key | 单值header验证后的原key；日志零输出 | key namespace、原记录可见性与冲突权威判定未决 |
| immutable raw body handle | exact byte length、sealed owned bytes、不可变性证明、唯一owner/lease；raw identity版本和解析策略身份待冻结 | 消费/复制时所有权确认、预算转移；raw identity持久表示/比较/retention未决 |
| R7-A parse result | 成功分支的DeepReadonly/深冻结DTO与对应同一raw handle一起交付；失败分支停在C结果映射，不调用B | 成功仅是可验证caller输入；checkpoint authenticity/order/history/食品来源由B对应领域职责验证 |
| deadline/abort context | 服务端monotonic绝对deadline、取消latch、attempt身份、dispatch是否已发生；不接受caller续期 | 跨执行域时钟语义、取消确认与commit可知性由B抽象契约提供；不得假定Signal本身终止DB |
| resource/ownership acknowledgment | raw/DTO仍被谁持有、何时可释放、残余任务配额 | B接管后仍受有界quota；不能无确认就提前归还C内存或执行slot |

handoff不是“自由组合几个字段”的接口：必须由同一受控collector→decode→parser产出bundle，bytes、DTO、domain、key和attempt不可被middleware替换/混搭；解析版本与identity版本变化不得使旧key按新body语义重新执行。brand只防静态误用，运行期的所有权来源也须证明。

| B→C 抽象 outcome | 允许C做什么 | 禁止 |
| --- | --- | --- |
| 已权威确认commit，或已完成原receipt重放 | 验证receipt对应本principal/scope/key/body/domain且符合冻结域result；按未来冻结HTTP envelope输出 | 以内存checkpoint猜commit，返回current checkpoint替换旧receipt，第二次推进状态 |
| 已权威确认本次零效果且不再可commit | 输出已有且语义准确的映射；明确其证据只覆盖本次还是整个原key命令；未有码则登记gap并不接入route | 把所有拒绝都翻成R7-A shape/order/checkpoint reason，新增ordinal；把本次零效果冒充先前unknown已解决 |
| outcome unknown/取消未确认/连接结果不明 | 保留不可变身份和恢复资格、请求原key/body恢复；无响应时客户端保持unknown | 以malformed/INTERNAL_ERROR/普通409宣布确定失败，或默认换key重做 |

不能把B未定义的result强制cast为域result union。B承诺已知中止、已知commit或unknown的证据与交接协议是实施准入条件；有gap不阻止这里描述安全交接，但任何暂缺能力都必须让route保持未准入。

| 重试/冲突 | raw-byte候选策略要求 |
| --- | --- |
| same key + same bytes | 通过同样C守卫后交B；仅B权威完成记录可返回原receipt；进行中等待/恢复由B负责 |
| same key + 只改变属性顺序的bytes | 两份都可能通过R7-A；候选身份视为不同body，不使用utils.requestHash合并；HTTP冲突语义待冻结 |
| same key + different body（含session/aggregate/claim/count/digest变化） | 不读取/回显另一body；B在合法key scope内判冲突；不创建别名 |
| new key + old ordinal | C不能认定新命令可写；原样交B持久prefix判断；无自动幂等特权、不补checkpoint |
| upload/parse超时后重试 | 对该未dispatch attempt无B写入；客户端若未获权威响应仍按unknown保留原key/body，不能从server局部事实推断client已知 |

Client handoff（Proposed/未决）：首次发送前把已验证command确定地序列化一次，保存不可变serialized body + key + operation/domain/route/scope +解析/身份版本；后续网络尝试复用同一字符串对应的UTF-8 octets，不从页面draft、GET、最新checkpoint、重新排序的object或不同版本serializer重建。raw字符串直接传现有spec.body会被JSON.stringify成带引号字符串，因此需要正式client API边界冻结，不能假装现有call已支持。
Taro是否原样发送字符串、是否添加/更改charset、encoding、CL、header大小写/多值、超时后是否仍送达server、是否能abort及其完成语义全部待真实adapter证据；当前NetworkPort Promise无法表达取消确认。传输timeout=15s仅是源码事实。
transport/malformed response/5xx、server已commit但response丢失继续unknown；不从retryable布尔值推断零效果。未知状态到retry deadline也不得释放为确定失败；已确认结果后的本地导航失败只恢复本地页面，不能再次写。
pending继续绑定principal/household/auth generation/attempt；401只suspend，同principal重认证方可恢复，换principal不得看见/执行旧payload/key。进程重启的non-sensitive locator + status/receipt恢复仍是既有未闭合内部发布阻断，本轮不设计storage机制。单chunkunknown时禁止提交下一chunk或生成新key绕过；旧HTTP回调不能清除新attempt/新principal状态。
跨attempt未知性必须是独立latch：某次结果未知后，后续重试收到400/413/415/429、parser rejected、授权拒绝、超时或其他仅覆盖本attempt的零效果信息，仍不能清除原命令unknown，因为原attempt可能已commit。只有B对原key/原body给出的权威完成receipt，或明确覆盖全部相关attempt、证明不再可能commit的最终零效果证据，才可解决该逻辑命令。当前dispositionForOutcome按4xx→definite-failure的generic路径未满足这一新边界；G-OUT/G-CLIENT必须冻结后才能接入，不修改当前legacy合同，也不借retryable布尔值偷偷表达证据范围。

# 12. HTTP problem/result mapping and contract gaps

这里只引用既有ApiErrorCode与冻结replay reasons；所有新route上的映射为Proposed，状态码与ApiErrorCode的已冻结对应不能改。transport failure、R7-A rejected result和B的持久outcome是不同轴。

| 来源/事实 | 可以诚实复用的现有边界 | gap/注意事项 |
| --- | --- | --- |
| transport实际bytes>B或CL>B | 413 PAYLOAD_TOO_LARGE，固定detail；若底层已关闭可无response | 不能假装调用过R7-A并制造域WIRE_BYTE reason；安全头在可写HTTP路径保持no-store/nosniff |
| 不支持media/charset/非identity编码 | 415 UNSUPPORTED_MEDIA_TYPE候选，固定detail | Content-Encoding政策与公开说明待冻结；底层错误不得强行塞入JSON |
| framing冲突、空body、invalid UTF-8、BOM、invalid key | 400 VALIDATION_FAILED候选，只在可安全回应且确认未dispatch时 | 不能伪造R7-A JSON_SYNTAX reason表示未发生的解码/解析；Node早拒绝不保证problem格式 |
| 缺认证/失效session | 401 AUTHENTICATION_REQUIRED/SESSION_EXPIRED | 仅认证链判定；不以bodyclaim伪造身份 |
| 他户资源/无访问可见性 | 404 RESOURCE_NOT_FOUND | 避免存在性泄漏；具体receipt政策B未决 |
| 本户已知缺权限 | 403 FORBIDDEN | 需可信授权事实；权限撤回与result恢复不可由C猜测 |
| scoped/global admission预算耗尽，尚未dispatch | 429 RATE_LIMITED候选 | 不称DB lock timeout；commonErrorResponses当前未统一列429，OpenAPI补齐需另行批准 |
| R7-A返回ok:false | 原reason code+ordinal保持；对应域result的kind=rejected可作候选载荷 | 是裸域result、2xx envelope内业务拒绝、还是HTTP问题的何种关联结构未冻结。不能自动把rejected当api success清pending，也不能用fieldErrors自由字符串偷塞新协议 |
| B确认同key异完整body | 409 IDEMPOTENCY_KEY_REUSED在语义上是候选 | legacy是semantic hash；raw比较与namespace、receipt契约需要共同批准；不能借此扩大域reason含义 |
| B持久checkpoint/order/stale/finalized/persistent quota/已知abort | 只有实际冻结并匹配语义的现有码才可输出 | R7-B shadow的internal分类不是public码；未知映射保持gap，不泛化CONFLICT或VALIDATION_FAILED |
| 真正未dispatch的内部程序错误 | 500 INTERNAL_ERROR仅可指内部故障；前提有零业务效果证据 | 不能作为commit unknown载体；客户端会保守unknown是客户端策略，不使这成为正确的unknown协议 |
| transport deadline、parser deadline、lock/transaction/commit timeout | 当前无完整、准确且已冻结的time/outcome网络表示 | 不新增408/504或timeout code；不冒用EXTERNAL_DEPENDENCY_UNAVAILABLE表示任意超时；deadline≠malformed |
| commit outcome unknown或client abort | client abort允许无HTTP response；unknown保持未决 | 明确禁止确定失败与伪success；无冻结envelope时route实施阻断，不使用INTERNAL_ERROR伪装 |

冻结replay reasons（前缀Inventory=`INVENTORY_REPLAY_`、Seasoning=`SEASONING_REPLAY_`；下表第k项ordinal分别是22000+k、25000+k；不新增/改ordinal）：

| k | 冻结suffix |
| --- | --- |
| 0 | INPUT_DESCRIPTOR_INVALID |
| 1 | INPUT_SHAPE_INVALID |
| 2 | HISTORY_CAPACITY_EXCEEDED |
| 3 | EVENT_SHAPE_INVALID |
| 4 | SCOPE_MISMATCH |
| 5 | BEFORE_MISMATCH |
| 6 | INPUT_RESOURCE_LIMIT_EXCEEDED |
| 7 | WIRE_BYTE_CAPACITY_EXCEEDED |
| 8 | CHUNK_EVENT_CAPACITY_EXCEEDED |
| 9 | TOTAL_HISTORY_CAPACITY_EXCEEDED |
| 10 | CHUNK_SEQUENCE_OR_ORDER_INVALID |
| 11 | PREVIOUS_EVENT_DIGEST_MISMATCH |
| 12 | CHECKPOINT_MISMATCH |
| 13 | FINALIZATION_INVALID |
| 14 | TERMINAL_EVENT_DIGEST_MISMATCH |
| 15 | CANONICAL_NUMBER_INVALID |
| 16 | JSON_SYNTAX_INVALID |

以下gap是实施阻断，不要求先改R7-A，不给contract patch：

| ID | 未冻结边界 | 解除条件/owner |
| --- | --- | --- |
| G-ROUTE | replay URL/method/operation/version/media/header规则 | 总控/contract owner冻结，真实路由注册证明仅目标作用域接入 |
| G-ENV | 两域result与HTTP ok/data/meta/problem关系、拒绝状态、receipt metadata | 合同独立冻结及client disposition一致性；不复制DTO、不扩现有reason |
| G-OUT | known-no-effect/timeout/unknown恢复的公开语义、证据覆盖attempt还是原命令及无response分支 | B+C+client共同定义可恢复协议和证据；必须区分commit unknown与确定拒绝，单次retry拒绝不得清除既有unknown |
| G-ID | immutable raw identity版本/编码/比较/域隔离、legacy key namespace兼容 | 正式裁定raw-byte Proposed；B身份机制与C原字节证据、client重试兼容冻结 |
| G-CLIENT | serialized body能力、response相关性校验、attempt取消/重启恢复 | 正式client/ports合同与真实Taro发送/timeout证据；pending不能因不识别分支被默认清除 |
| G-AUTH | parse后、handoff前无副作用认证和可信调度scope；B事务内授权仍独立 | 认证owner给出能提供临时调度证据且不提交session更新的能力；不能复制或复用现有#withAuthenticated作为upload auth；不在C选SQL |
| G-LIFE | raw挂点、framing/duplicate header/normal close/abort/timeout实际语义 | 精确runtime真实socket证据，双settlement和late callback均闭合 |
| G-BUDGET | memory/CPU/stream/global/scoped/rate/cancel残余容量及deadline数值 | 实测保守预算与调度证据，所有执行域/副本覆盖；必要时独立批准隔离策略 |
| G-LOG | 最早request日志、path/instance/自带requestId泄漏面 | 组装根/logging owner批准无输入标签的安全投影，覆盖早于route的失败与所有终态 |
| G-BACKEND | B抽象outcome、ownership/cancel确认、恢复资格与原identity对应 | B独立冻结与实证；C不能以超时推定回滚；不选择任何persistence机制 |

现有结构允许描述这些边界与“缺能力则不dispatch/不上线”的规则，因此本候选可送设计审查；不存在靠占用现有invalid reason才能表达安全状态的要求。任何gap未闭合都不授权实现。

# 13. Logging/redaction/telemetry

日志不接触raw body、decoded text、DTO、claim、checkpoint、digest（含raw identity摘要）、Idempotency-Key、token、其他household/session/aggregate identity；success/rejected/error/timeout/abort/cleanup失败/late callback/unknown全部一致。digest不是脱敏方式，不能用hash(key/body)作日志label。
只允许由服务器产生且不能由caller选择的request correlation，加固定operation/domain/stage/result类别与有界聚合计数/耗时bucket。任何新事件/字段均Proposed，先经过既有EventLogSink固定字段机制的独立冻结；目前request.failed/rejected只接受其已有字段，不能传任意对象或内部分类字符串冒充ApiErrorCode。
现有app.genReqId会接受合法x-request-id，serializeRequest保留path，problem.instance使用截断URL path；一个格式合法的UUID可能恰好是他户ID，一个raw path可能嵌入任意sentinel。关键词redaction不能证明这些值零泄漏。这是G-LOG，不能声称现有logger自动满足R7-C。
Proposed replay接入需在framework“incoming request”之前切断caller requestId、raw path与任意header进入日志的通路；用server-generated correlation和固定route模板/operation，未知route用固定占位，不回显path/query/原始header。problem.instance采用批准的固定模板或省略可选字段。hook具体位置待实测，不能在handler里redact已经写出的日志。
日志传输/目的地buffer本身有界，禁止每个小chunk一个日志事件；日志失败不能二次settle、无限重试日志或继续未授权dispatch。不能记录Error.message/stack/SQL/driver dump、Node clientError.rawPacket、Taro errMsg或请求对象作为诊断；未知outcome只记录固定类别及安全计数。
未来sentinel矩阵：每个敏感族分别嵌入body/key/claim/checkpoint/digest/他户ID、raw path/query、合法x-request-id、duplicate headers、error/cause、迟到回调；检查framework/event/access/proxy（若使用）/stderr/client telemetry及problem输出。要求除明确获准业务response内自身checkpoint外，日志中所有sentinel零出现；即使成功也为零。当前没有该R7-C sentinel实测，不宣称常时或无所有侧信道。

# 14. OpenAPI expressibility

当前committed OpenAPI为3.0.3，生成器读取legacy root registry；R7-A保持root隔离。未来接入两域只通过已批准subpath与明确操作schema关联，不把M2灌回legacy root或手写平行DTO。本轮未运行generator、未改committed文件。

| 可表达/声明的内容 | 表达不到或无法证明的内容 | 后续证据 |
| --- | --- | --- |
| path/method、认证scheme、必填body、application/json、idempotency header pattern/length | header实际重复/归一化、CL/TE走私、auth真的执行、charset/BOM/编码转换顺序 | 真实socket与adapter、注册/调用证据 |
| JSON对象字段、strict分支、枚举、事件数组17/388、schema counts、可表达的reason/ordinal形状 | 原JSON duplicate key、canonical number token 2 vs 2.0、对象顺序原字节身份、strict UTF-8非法序列 | frozen R7-A raw tests +实际字节发送，不能只经JSON.parse后的object测试 |
| 413/415/429等已有码的response schema、no-store/nosniff说明、版本和恢复描述 | B bytes在物化前执法、collector owned memory/overshoot、stream end完整性、取消一次结算 | pre-string探针与真实stream memory/lifecycle证据 |
| runtime rule metadata/描述性限制说明 | maxLength不是UTF-8 byte cap；扩展字段不是runtime guard；deadline/公平性/commit结果可知性 | 各owner真实负例与缺guard反例 |
| 已冻结后可声明accepted_chunk/finalized/rejected对应结果 | deep freeze、checkpoint authority、事务原子性、无HTTP response、响应丢失后的unknown | B outcome证据与client未知保存；无response只能文档说明，不能保证HTTP body |

必备反例：OpenAPI写了413且生成检查完全通过，runtime route却走parseAs:string或默认JSON parser，B+1在guard前已物化；再例是同shape的2.0被普通JSON.parse吞掉、含重复key被覆盖，schema仍合法。未来验证须证明这类错误接线不会获准，而不只比较generated与committed JSON。metadata存在/contract binding身份不替代raw路由入口证据。

# 15. Full attack/future-test matrix

以下全是未来测试计划，本轮执行数为0。S=未来真实Node/Fastify socket，A=未来真实Taro/获准adapter，U=后续授权的局部/生命周期测试，I=后续授权的B集成证据；这些不是新gate名称。每项需精确candidate/runtime版本、完全合成数据、可审计独立输入oracle。不能把app.inject结果填成S/A。
共同oracle：记录借用块尺寸、owned bytes/段数、首次string时点、parse/handoff计数、执行轴与响应轴、lease收支、取消确认和无敏感日志；观察工具自身不暴露真实数据。对B效果只消费B经授权的权威记录，不在C测试设计中规定SQL。

| ID | 攻击/故障变体 | 必须观察的不变量/期望 | 未来证据 |
| --- | --- | --- | --- |
| T01 | ASCII有效UTF-8 body长度B−1、B、B+1；已知/无CL各组 | B−1/B过byte层后仍可被schema拒绝；B+1首次超额块复制/字符串/parse/B调用均无后续；不截断前缀 | S+U，独立octet计量 |
| T02 | 多字节UTF-8对应B−1/B/B+1，2/3/4-byte scalar与ASCII补齐 | string.length<B也按bytes拒绝B+1；不得用字符数取代bytes；与T01相同边界 | S+A+U |
| T03 | 每种多字节scalar分割到所有chunk边界；每字节发送 | 合法完整UTF-8保持原字节/相同DTO；不按chunk独立替换解码 | S+A |
| T04 | invalid leading/continuation、overlong、surrogate编码、>10FFFF、最后截断；非法序列跨chunk | strict decode拒绝、不替换U+FFFD、不进入R7-A/B；字符串已物化情形不能用于证明pre-stringcap | S+U |
| T05 | BOM单块、分成1+2/2+1/1+1+1，BOM+空体；合法字段内U+FEFF | BOM计费并拒绝，不自动strip；字段内容原样给R7-A | S+A |
| T06 | CL缺失、0、B、B+1、远大安全整数；CL过大但body小 | 超B仅header早拒，不按CL分配；缺CL按实际count；0不替换empty DTO | S |
| T07 | CL过小、过大但≤B，与actual不符；end/半关闭/no end | 可见mismatch拒绝；分帧后的余字节不算当前body，必须无走私/无绕guard；截断JSON无B调用 | S，含同连接后续请求 |
| T08 | 重复同值/冲突CL、逗号list、大小写变化、invalid数值 | 在归一化消歧前拒绝；如Node早拒则允许无problem；不回显raw headers | S |
| T09 | CL+TE、重复/stacked/非法TE；chunked extensions/trailers滥用 | 早拒歧义；chunk framing/header开销独立预算；trailers不能覆盖身份 | S |
| T10 | chunked极小块洪泛、零进度、单个巨大overshoot chunk | 不存逐块列表/无限promises；owned≤B；upstream峰值单独计费；超额后不无界drain | S，RSS/native/heap采样 |
| T11 | application/json大小写、missing/wrong/+json/multipart；额外参数 | 仅批准媒体规则通过，其余415候选或安全关闭；错误不能落默认parser | S+A |
| T12 | 无charset、utf-8大小写、重复同值/冲突charset、latin1/utf16/utf8别名/quoted等 | 精确批准语法通过；歧义/非UTF-8拒绝；adapter改写不能静默接受 | S+A |
| T13 | gzip/br/deflate、stacked编码、identity混列、重复encoding、decompression bomb | 非identity在解压前拒绝；解压调用数0；代理透明解压链不准入；不以压缩后B覆盖解压内存 | S，未来代理边界若采用 |
| T14 | zero HTTP body vs合法empty-history JSON；{}、[]、null、whitespace、empty近似对象 | zero拒绝；合法strict only仍完整parse/B；空history不清live aggregate，近似值按R7-A既有reason拒绝 | S+U+I |
| T15 | duplicate key、2.0/2e0/-0、非canonical字符串escape、leading/trailing whitespace/extra field/own __proto__ | 原text直接经R7-A，保留既有reason precedence/ordinal，成功deep freeze；无预parse再stringify | S+U |
| T16 | Inventory17/18、Seasoning388/389；logical10,000/10,001 | 保留冻结parser/声明边界，跨请求actual总量由B；不放宽事件数 | U+I |
| T17 | data/end/error/aborted/close/timeout所有有效偏序，终事件前后相邻/同tick；非法顺序和重复回调 | 每轴一次结算、最多一次handoff/response尝试、每lease归还一次；不把所有排列当Node真实可发生 | U全表+S真实可达序列 |
| T18 | close-after-end、response close-before-finish、finish后close | 正常req close不误判abort；响应丢失不回滚成功事实，writable与readable分离 | S |
| T19 | slowloris headers/body、每idle截止前送一byte、永不end、半关闭 | absolute deadline/速率界限不延长；不永久占slot；socket/框架时钟实测，非单纯timer单测 | S |
| T20 | ECONNRESET/client abort在首byte前、body中、end后、parse后、B后、response中 | predispatch无B；dispatch后请求cancel并保持实际known/unknown；允许无HTTP response | S+A+I |
| T21 | handler throw、decoder/parser异常、timer race、cleanup throw、日志destination失败 | 不能第二次dispatch/send/release，错误不泄漏；B后异常无证据时unknown | U+S+I |
| T22 | parser同步阻塞至D_parse外但返回success；timer尚未触发 | 后验deadline阻止B，DB调用0；明确不能证明同步CPU及时中断；若响应/公平预算不足阻断准入 | U+S |
| T23 | global/principal/household/session最后一个slot并发争抢；取消与授予交错 | all-or-none lease，容量不超、无partial token泄漏；同户不同principal/同principal多户都受控 | U+S |
| T24 | 单用户新session/key洪泛、多用户同户、假household/scope、认证失效/撤回 | 不用caller ID建立authority；桶cardinality/速率有界；B决策点重新授权；跨scope零泄漏 | S+I |
| T25 | 排队饥饿/队头阻塞/攻击者重复抢占/重试流量压制正常户 | 当前无应用队列，拒绝有界；用公平窗口和速率证据而非cap宣称无饥饿；未来队列另准入 | S |
| T26 | 成功/失败/超时/abort/late回调每条资源路径与满容量反复循环 | token无重复归还/泄漏；unknown后台仍计费；阈值耗尽停止新B工作，不无限orphan | U+S+I |
| T27 | 单请求最大raw/string/decoded/Zod/DTO/response同时存活，overshoot borrowed backing store | 测得峰值装入预留；不能只看n≤B或仅heap；不保留巨大backing buffer的小slice | S+U |
| T28 | 全局最大并发、慢client response、日志背压、10,000一事件小chunks及重复重试 | total公式/并发/速率上界成立；C不累计整session；Bpersistent配额另取证；不能用589/26估算最坏receipt | S+I+A |
| T29 | same key+same bytes，同时/完成后/丢响应后 | raw identity不变，C不越权fast replay；B最多一次效果、原历史receipt；当前checkpoint变化不改旧receipt | S+A+I |
| T30 | same key+property-order-only不同bytes；same key+different body/scope/session | 两份局部合法也不被semantic hash混同；按冻结后identity处理；无storedbody/digest/key泄漏 | S+A+I |
| T31 | new key+old ordinal、相同payload换key、下一chunk越过unknown前缀 | C不赋新写资格；B拒重复/顺序；client不跳chunk或造checkpoint | S+A+I |
| T32 | parser timeout-before-DB；auth timeout；outer deadline在B lock wait | 前两者不dispatch；B中止仅靠B确认，timeout不冒充malformed或已回滚 | U+S+I |
| T33 | transaction/statement cancel、取消与commit交错、commit响应丢失/数据库不可达 | known-no-effect需权威证据；commit可能完成时unknown；查不到receipt不等于可重写 | I+S |
| T34 | client15s先超时、server稍后commit/response；late reply与retry/new auth generation竞态 | pending原serializedbody/key保持；late attempt不结算别人；恢复由原identity；client timeout不取消成功事实 | A+S+I |
| T35 | key缺失/短长/非法字符/重复同值/冲突/大小写重复/trailer变更 | 单一原key不trim不自动创建；拒绝发生在dispatch前；归一化行为实际取证 | S+A |
| T36 | middleware修改raw view、DTO、domain或交换另一次请求bytes/parse result | 不可变owned bytes+deepfreeze+bundle来源约束；混搭不能dispatch；原raw identity不从DTO重建 | U+S |
| T37 | success/failure/timeout/abort/unknown全路径日志sentinel，含body/claim/checkpoint/digest/key/他户和session ID | 全日志族零出现，path/合法x-request-id/错误对象也不能旁路；problem只固定信息 | S+A+U |
| T38 | OpenAPI声明存在而collector/runtime parser/auth guard缺失；生成文档仍一致 | 缺guard反例必须被真实负例识别；文档存在不能使R7-C被批准 | 后续授权静态接线挑战+S |
| T39 | malformed/不相关/跨scope success envelope、HTTP与problem.status不一致、unknown未识别分支 | client不完成/清pending、不把未知分支默认definite-failure；服务器不回未验证receipt | A+U+I |
| T40 | retry总deadline到期、页面离开/普通GET/进程重启/换principal | 不以GET证明命令结果；内存保留范围诚实；新principal无旧payload/key；重启恢复缺失仍阻断发布 | A+U+I |
| T41 | 原attempt已commit但丢响应；原key/body重试在header/collector/parser/admission被400/413/415/429或授权拒绝 | 本次无写不证明原命令失败，unknown latch保留原body/key；只有覆盖原命令的B权威证据可结算；不得走generic 4xx自动清pending | A+S+I |

完整责任矩阵（此处“负责”是逻辑owner，未选物理机制）：

| 对照 | 主要owner | 协作/不能替代 |
| --- | --- | --- |
| Fastify bodyLimit vs counted collector vs R7-A | Fastify作framework纵深防御；collector独立拥有pre-string实际byte执法；R7-A拥有string复核/局部canonical/schema | 不能用bodyLimit配置或R7-A历史string测试替代collector实际挂点/分配证据；自定义parser是否触发bodyLimit待实测 |
| transport timeout vs parser deadline vs request event-loop deadline | transport制止慢传输；parser前后预算制止过期结果；request控制阶段与响应许可 | 三者都不自动抢占同步JS或取消DB；硬CPU/总时限能力未决 |
| R7-B lock wait vs transaction/statement/commit timeout | 全属B的抽象能力和后续机制取证 | C只传外层绝对期限/abort事实；commit timeout可能unknown，不能直接回ROLLBACK或释放连接 |
| client request timeout vs retry deadline | adapter当前15s一次transport；coordinator未来D_retry涵盖全命令尝试 | 超时不清unknown、不换key、不证明server失败；重启恢复仍gap |
| per-request memory vs global memory | collector/parse/response对单请求峰值负责；C admission对所有同时活跃/残余工作总账负责 | 单请求B不保证global安全，OS/native/日志/队列额外计费 |
| per-household fairness vs R7-B persistent quota | C用经认证/可见scope做有限调度/速率与桶cardinality；B拥有持久容量和session生命周期 | C限流不变persistentquota、不续TTL；B每chunkcap不证明公平或网络资源安全 |
| HTTP problem vs R7-A rejected result vs B outcome unknown | C映射已冻结问题；A给原reason；B给持久事实；client保留未知 | 不合并轴；API problem目前没有outcome协议；缺码登记gap而非扩union/ordinal |

# 16. R7-B forbidden responsibilities

本设计没有也不授权DB schema、migration、SQL、RLS、GRANT、table/index/unique constraint；没有选择persisted lookup/MAC、per-chunk staging/final-only/live materialization；没有选择advisory key/isolation、TTL/GC/terminal fence或receipt retention；没有实现lock/transaction/cancel/commit判断。引用上游R7-B内容只用于确定依赖，不提升其Proposed机制状态。
C的global/scoped内存lease与业务持久配额不同；C的取消请求不是DB取消实现；C的sealed bytes不是持久schema或认证token。抽象handoff所需能力若B无法提供，就阻断route，不能让C越界补一个临时数据库方案。

# 17. Independent vs unresolved decisions

可独立供本轮审查的逻辑约束：actual octets与B的先计数后复制/解码、identity-only baseline、strictUTF-8/BOM拒绝、完整end前禁止parse、不可变owned bytes与同源bundle、R7-A保留原入口和reason、一次settlement/dispatch/cleanup、多轴known/unknown、无权限claim不升级、全生命周期日志不接触敏感值、token和内存守恒、unknown不变确定失败。这些是shadow设计不变量，不是实施验收。
Proposed策略：route-scoped单owner接入、固定owned容量候选、parse后无副作用认证、无应用队列/全或无scoped admission、raw-byte比较、serializedbody一次形成、拒绝非identity/严格mediaheader、非复用/异常关闭、safe日志投影。均待独立审查及正式冻结。
必须未决：G-ROUTE/G-ENV/G-OUT/G-ID/G-CLIENT/G-AUTH/G-LIFE/G-BUDGET/G-LOG/G-BACKEND全部；所有新增数值预算、Fastify挂点/Node底层行为、Taro能力、HTTP响应和重试合同；R7-B全部持久化/权限/锁/retention选择保持原状态。
安全handoff可在机制未定时描述为条件接口：无可信认证、无immutable identity或无B取消/结果承诺就不dispatch。设计可review，不意味着存在可直接执行的fallback；本轮不要求先改R7-A，也不推荐将新语义塞进现有reason。

# 18. Admission prerequisites and residual risks

下一步仅为另行授权的独立Fresh Design Review。Designer不自评CLEAN、DESIGN_ACCEPTED、Implemented、Accepted、OPEN、G2 admitted或M2 Accepted。
实施前需要总控重新签发精确baseline/write-set；闭合上述gap并正式冻结必要HTTP/client契约，R7-B依赖取得对应授权；M1 limited、G2 not admitted与其它既有准入阻断仍有效。不能用这两份文档启动migration、API/client实现、B-r4、G2或source激活。
未来证据至少包含：精确Node/Fastify真实socket和原始header/framing矩阵、pre-string分配与strictUTF-8、close/abort/timer实际偏序、CPU/memory/nativebuffer/全局并发和慢client输出、真实Taro不可变bytes/key和15s未知保存、B权威commit/abort/unknown集成、全日志sentinel、OpenAPI缺guard反例；只能在新授权中执行。
残余风险：同步parser不能被同event-loop timer抢占；平台可先分配超大borrowed chunk；底层HTTP framing/代理变换可能早于collector；当前认证helper有session更新，不能作为无副作用调度入口；current logger路径/callerrequestId可携敏感值；旧client重序列化和unknown默认分支不能直接接新协议；B取消/commit与恢复机制均未实证。任何一点无法给出守卫/预算/证据就继续阻断对应实施，不降级放行。
POST必须与PRE的identity/status/ref及六份材料hash完全一致；仅新0700目录两份文件。完整证据见 `R7-C-shadow-evidence.md`。本交付止于shadow design/evidence。
