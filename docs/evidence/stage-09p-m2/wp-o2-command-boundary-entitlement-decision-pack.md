READY_FOR_FRESH_REVIEW

# Stage 09P-M2 / WP-O2：原命令身份、attempt 全集与 receipt entitlement 联合决策候选

## 1. 权限、范围与结论上限

本候选只处理 WP-O1 的 Q01、Q02、Q08：

1. 原始 logical command 的不可变身份与请求绑定；
2. 哪些 transport/backend executions 属于同一命令的 attempts，以及何时可以证明集合关闭；
3. 谁可以执行原命令、读取历史 receipt，以及重认证、撤权、换 principal 时如何处理。

本候选由项目总控在当前工作树上形成，供后续全新独立 Fresh Review。`READY_FOR_FRESH_REVIEW`
不是 `CLEAN`、`Accepted` 或 `CONTRACT_FROZEN`。它不关闭 G-ID、G-ROUTE、G-CLIENT、
G-AUTH、G-OUT、G-BACKEND 或其他 G-*，不授权 route、DTO、数据库、migration、SQL、RLS、
client、runtime、测试夹具或实现。Q03/Q04/Q05/Q06/Q07/Q09/Q10/Q11/Q12 继续开放。

固定项目事实：M1 仍为 `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`；G2 仍为
`G2_NOT_ADMITTED`；M2 仍为 `In Progress`；R7-A contracts Accepted；R7-B/R7-C 仍为
`SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`；T01–T50 均未执行。WP-O1 只是已接纳的
设计准备材料，不是 wire/runtime authority。

## 2. PRE、输入与方法

| PRE 项 | 精确值 |
| --- | --- |
| branch | `codex/stage-09p-m2-inventory` |
| HEAD | `41c2e7b5013051201c10365b9f41af00b643fae8` |
| tree | `a80c61d4e780cadaad23f7c42b4dea996880b0ad` |
| status | clean，含 untracked 检查 |

主要输入为持久归档中的 R7-B shadow design、R7-C r1 shadow design、WP-O1 decision pack 与
Fresh Review，以及 ADR-0003/0004、阶段 09P 计划和当前源码。源码只用于确认 legacy 能力与缺口，
不把静态阅读变成动态证据。实际 read-set、命令、定位和输出身份见同目录 evidence。

决策方法按安全依赖顺序展开：先定义 command identity，再定义 attempt membership/closure，最后
叠加 execution entitlement 与 receipt disclosure entitlement。HTTP status、public field、数据库
列、锁实现和 retention 数值均不得反向定义语义。

## 3. 联合决策摘要

### 3.1 Q01 候选答案

M2 replay logical command 的 identity key 精确为：

```text
identityPolicyVersion
+ originalPrincipalUserId
+ scopeKind=household
+ householdId
+ operationId
+ idempotencyKey
```

该 key 绑定且不可替换的 request binding 为：

```text
bodyProfileVersion
+ exactEntityBodyOctets
+ parserContractId
+ routePolicyId
```

identity key 相同但 request binding 不同，是对既有 key 的冲突 attempt，不是第二个 logical
command。`replaySessionId`、aggregate id、chunk kind/ordinal、claim、events、count、digest 和
schemaVersion 全部已经包含在完整 body octets 中；服务端还必须从 parser 结果提取并与受保护
state 逐项复核，但不得用该字段子集替代完整 body binding。

### 3.2 Q02 候选答案

“首次”不能由 client 内存为空、receipt miss、server row absence、第一次看到某 key 或
`attemptOrdinal=1` 推断。logical command 的相关 attempt set 包含所有已经越过 transport
handoff 线性化点、可能越过可信 dispatch 点或仍保留未来 commit 能力的执行，包括迟到、排队、
重试、恢复和客户端已停止观察的请求。

本候选只允许一个不需要服务端 command-final evidence 的窄例外：**纯本地、从未越过 transport
handoff 的准备动作可以被本地取消**。这不是 server command-final no-effect，也不证明世界上没有
同 key 历史。任何已经越过 handoff 的命令，只有 WP-O1 E01/E02 或 E03 才能终结；普通 4xx、
可信 predispatch rejection、B call=0、known rollback、timeout、abort、receipt miss 或“这是唯一
已知 attempt”均不得释放 logical command 身份去换 key 重做。

### 3.3 Q08 候选答案

command fact、执行资格和 disclosure 资格分为三条轴：

- 原命令事实绑定原 `User.id`，不绑定 session id、bearer token 或客户端 auth generation；
- 每个新执行/继续执行 attempt 都要在 B 决策点重新验证当前 execute entitlement；
- 每次读取/发送历史 receipt 都要在独立 release authorization point 重新验证当前
  receipt entitlement。

receipt 默认只允许原 principal 读取，并要求当前有效认证、当前 active household membership、
对 receipt 全部字段的当前可见性，以及精确 command correlation。household owner、同户其他成员、
知道 key/UUID 的人都不自动获得 receipt。当前没有获准的跨 principal audit/recovery contract。
execute entitlement 与 receipt entitlement 不互相替代；只读 replay 不因缺少写权限自动被拒，
但必须有尚待 G-AUTH 冻结的“读取自己的安全 receipt”能力。无法证明完整字段可见性时整份暂停，
不对原不可变 receipt 做临时删字段投影。

## 4. Q01：logical command identity

### 4.1 固定逻辑常量

以下字符串是本候选要求 Fresh Review 的 exact logical identifiers；它们不是数据库列名或 URL：

| 责任 | exact value |
| --- | --- |
| identity policy | `meal-agent.stage09p.m2.logical-command.v1` |
| body profile | `meal-agent.stage09p.m2.raw-json-entity-body.v1` |
| no-query route policy | `meal-agent.stage09p.m2.no-query.v1` |
| Inventory operation | `meal-agent.stage09p.m2.inventory.replay-chunk.v2` |
| Seasoning operation | `meal-agent.stage09p.m2.seasoning.replay-chunk.v1` |
| Inventory parser contract | `meal-agent.contracts.inventory.replay-chunk-input.v2` |
| Seasoning parser contract | `meal-agent.contracts.seasoning.replay-chunk-input.v1` |

identifier 逐 ASCII byte 比较，禁止 trim、case fold、Unicode normalization、别名、前缀匹配或
fallback。未来重命名必须产生新 operation/policy version，并单独设计旧 unknown 的兼容恢复；不能
让 registry alias 静默把旧命令改绑新语义。

两个 parser contract identifier 分别映射当前 R7-A Accepted 的
`parseInventoryReplayChunkInputV2` 与 `parseSeasoningReplayChunkInputV1`，但持久 identity 不使用
可重命名的 TypeScript symbol。任何改变 accepted input 语义的实现必须产生新的 semantic identifier；
只改代码而沿用旧 identifier 属于兼容性失败。如何为旧 identifier 保留 N-1/runtime verifier 属 Q10/Q11。

### 4.2 principal 与 scope

`originalPrincipalUserId` 必须来自服务端已验证 session 对应的稳定内部 `User.id`。openid、unionid、
bearer token、session id、membership id、role、capability snapshot、客户端 auth generation 和
caller body 中的 actor 都不是 command identity。

两个 M2 replay operation 都是 household scope。`householdId` 同时满足：

1. 来自受信 route/authorization context；
2. 与解析后的 body householdId 相同；
3. 与 replay session/checkpoint/aggregate 的受保护 scope 相同。

任一不一致安全拒绝，不返回他户 command/receipt 是否存在。membership 或能力变化不创建新 command；
它只改变当前 attempt 的 execution/disclosure entitlement。

### 4.3 operation 与 route

trusted route owner 必须从一个获准、无歧义的 method + route binding 产生 exact `operationId` 和
`routePolicyId`。v1 baseline 禁止 syntactic query component，也禁止多个 route/method alias 映射到
同一 operation。normalized route 字符串、删除 query 后的路径、body 内 domain/kind 或 caller Boolean
都不能生成 operation/no-query authority。

具体 URL、HTTP method、header 和内部 proof carrier 留给 G-ROUTE/G-ENV；在它们冻结并证明一条 route
只映射一个 operation 前不得接线。此处决定的是：route 表达可以后定，但不得改变或扩张 logical
operation identity。

### 4.4 exact body identity

`exactEntityBodyOctets` 指可信 collector 在 HTTP framing 去除后、任何 string decode/JSON parse/
normalization 前封存的 entity body bytes。baseline 不允许 content coding、BOM、replacement decode、
中间件重编码、proxy 重写或解析后再序列化来构造 identity。无法证明到 collector 的 byte chain 时
route 保持阻断。

body equality 是 exact octet equality：属性顺序、JSON 空白、转义写法、数字文本、对象键顺序或任何
byte 改变都不等价，即使两个 JSON 解析结果深相等。客户端 retry/recovery 必须重发首次封存的同一
serialized byte sequence，不能再次 `JSON.stringify`。

逻辑 binding 包含 `exactEntityBodyOctets` 本身，而不是只包含摘要。用于查找、持久相关和实现取证的
候选 body fingerprint 精确为：

```text
exactEntityBodyOctetLength = unsigned byte length
exactEntityBodySha256 = "sha256:" + lowercaseHex(SHA-256(exactEntityBodyOctets))
```

SHA-256 不是 authentication、authorization 或完整 request 的语义替代，`length+digest` 也不得在逻辑
定义中把 exact equality 改成 hash equality。Fresh Review 若接受本候选，只是固定“摘要覆盖完整原始 body
bytes，且长度共同参与索引/相关”的要求；如何在不无界保存 raw bytes 的情况下把持久比较实现为可接受的
collision-resistant/fail-closed 机制、怎样防止摘要实现/编码错误，属于 Q03/Q04/Q11 的机制与实证。不得
退化为现有 canonicalized object hash、字段子集 hash、R7-A DTO hash、event digest 或 checkpoint digest。

### 4.5 key namespace 与冲突

`idempotencyKey` 原文逐字节使用，通过既有/后续获准 key syntax 后也不 trim 或改写。key lookup namespace
只由 identity policy + principal + household + operation 决定。body、session、aggregate、ordinal 和
schema version 不能移动 key namespace；否则攻击者可改 body 把 same-key conflict 变成“新空间”。

| 输入关系 | logical classification |
| --- | --- |
| same identity key + same request binding | 同 logical command 的另一个 attempt |
| same identity key + different body bytes/length/digest/parser/route policy | conflict attempt；原命令不变 |
| same text key but different principal/household/operation | 不同 namespace；仍须各自授权，不互相披露 |
| different key + same body/session/ordinal | 不同 command identity；R7-B session/order fence仍可拒绝重复业务效果 |
| same key/body but wrong/stale client generation | 可能是同命令的 stale delivery；generation 无权改 identity，callback 不得消费 |

## 5. Q02：attempt membership、首次与关闭

### 5.1 三条边界

1. **local draft boundary**：还没有封存 M2 command envelope，也没有 key/body binding；本地表单校验失败
   可以普通修改，不存在需要结算的 logical command。
2. **transport handoff boundary**：exclusive dispatcher 必须在调用 `NetworkPort.request`、Taro request、
   socket/queue/worker 或任何可把请求交给另一个执行 owner 的 API **之前**，不可逆地登记
   `handoffStarted`。登记后即使调用同步抛错，也只能保守证明当前调用结果，不得恢复“从未交付”。
3. **trusted dispatch boundary**：C 将同源 immutable bundle 交给 B。越过后，timeout/cancel/exception
   不能由 C 推断 DB no-effect。

transport handoff 是客户端知识边界，trusted dispatch 是服务端执行边界。二者不互相冒充；客户端未收
response 时不知道请求停在哪一侧。

### 5.2 完整相关 attempt set

对 command C，`Attempts(C)` 至少包含：

- 所有由客户端以 C 的 exact key/body/operation 发起且已登记 handoff 的 transport attempts；
- 服务端可信入口识别为 C 的每一次请求，包括客户端已超时、页面已卸载或 callback 已过期者；
- 已排队、已 dispatch、正在取消、后台仍持有 B commit capability 的执行；
- 同身份的 retry/recovery、连接重试、迟到工作和已经失去客户端观察者的请求；
- 任何获准中间层若可能复制/重放 POST 而产生的执行；baseline 无证据时禁止这种中间层。

下列值只可作 correlation，不定义集合：client attempt ordinal/id、HTTP requestId、socket、promise、
auth generation、server worker id、DB connection/transaction id。caller 提供的 attempt list/count/last flag
均不可信。当前内存数组、单实例计数和一次 lookup miss 都不能证明全集。

### 5.3 纯本地取消的唯一窄例外

只有同时满足 L01–L08，客户端才可把一个尚未发送的准备动作从本地 coordinator 删除：

| ID | 必须证明的条件 |
| --- | --- |
| L01 | 当前 envelope 在本地由唯一 command owner 新建，不是 restart/import/recovery/旧 pending |
| L02 | exact serialized body、key、operation 已封存，但 `handoffStarted=false` 且该位单调不可回退 |
| L03 | 所有网络、queue、background、timer、auto-retry 和 late-send capability 都由同一 owner 控制且尚未取得 ticket |
| L04 | 没有第二 dispatcher、页面副本、worker、设备同步或共享 outbox 能持有该 envelope |
| L05 | discard 先不可逆撤销全部 dispatch tickets，再销毁本地敏感 body/key；两步顺序不可反转 |
| L06 | 取消只描述“此本地准备未发送”，不生成 server receipt、terminal failure 或 no-effect claim |
| L07 | 后续新的用户意图重新校验、重新确认并创建新 envelope；不得复用被丢弃 key/body |
| L08 | runtime/process restart 后无法重新证明 L01–L07 时不使用该例外；restart recovery 阻断保持 |

当前 client 的 in-memory coordinator、非密码学 fallback token 和在 `ApiClient.call` 内再次 stringify 均不足以
证明 L01–L08。本候选没有把例外写成当前已支持事实。

### 5.4 handoff 后的安全默认

一旦 `handoffStarted=true`：

- E05 trusted predispatch rejection 或 E04 current-attempt known-no-effect 只关闭该 attempt；
- 如果没有旧 unknown，可以把 UI 表达为“当前尝试未执行/可按原身份恢复”，但 command envelope 不释放；
- 如果已有 unknown，U latch 保持；后来的 400/401/403/404/409/413/415/429 或 parser/query/auth/admission
  rejection 都不能覆盖它；
- corrected input 不能沿用原 key 改 body，也不能换 key 重做同一用户意图；若产品需要纠错，必须在 handoff
  前验证，或由 Q03 的 authoritative command-final no-effect 关闭原命令后创建新的已确认意图；
- same identity retry 仍须逐 attempt 重新通过 route、auth、budget 和 B admission；它不是跳过门禁的 replay；
- automatic retry deadline 只停止自动尝试，不关闭 command。

本候选明确不采用“client 宣称只有一个 attempt + server 证明本次 B call=0，所以全命令结束”的组合；
它无法排除进程重启、并行 owner、中间层重放、旧 attempt 或迟到 commit capability。

### 5.5 attempt 与 command 状态

| attempt observation | attempt 结论 | command 结论 |
| --- | --- | --- |
| local draft rejected，未形成 envelope | 无 attempt | 无 command settlement |
| L01–L08 全满足并本地取消 | local preparation closed | 不产生 server command-final；允许新用户意图 |
| handoff 前 trusted local guard 拒绝但不能满足 L01–L08 | attempt not sent | 保留 envelope，不能声称全局首次/无历史 |
| server可信证明本 attempt 未 dispatch | attempt no-effect | N 保持未终局或旧 U 保持；原身份恢复 |
| B证明本 attempt rollback/终止 | attempt no-effect | 不能推出 command-final；原身份恢复 |
| timeout/abort/reset/no response/receipt miss | inconclusive | U 或保持 U |
| E01/E02 original authoritative receipt | committed | C；原 receipt 单调 |
| E03 authoritative command-final no-effect | 所有相关 attempts 已关闭 | F；身份被终局 fence，不能再 commit |

## 6. Q08：execution 与 receipt entitlement

### 6.1 四种不同主体/资格

| 概念 | 决策 |
| --- | --- |
| original principal | 首次命令服务端认证得到的 `User.id`；命令事实永久绑定它 |
| current authenticated principal | 当前有效 session 得到的 `User.id`；必须与 original principal exact match 才可恢复自己的命令 |
| execute entitlement | 当前 attempt 是否可创建/继续 replay session、处理 chunk 或做 B 业务写；每次 B 决策点重新验证 |
| receipt entitlement | 当前请求是否可取得原不可变 receipt 全部字段；每次 release point 重新验证，独立于 execute entitlement |

receipt entitlement 的最小 predicate 为：

```text
current user/session active
AND current User.id == originalPrincipalUserId
AND current active membership in original household
AND current policy permits read-own-command-receipt for the exact operation
AND every field in the immutable receipt is currently visible to that principal
AND command identity/request binding/receipt correlation all verify
```

具体 role/capability 名称尚未存在，不在本候选中发明。没有可机械判定的 predicate 时 G-AUTH 保持阻断，
route 不得把“active member”临时当万能 receipt 权限。

### 6.2 execute 与 read 分离

- 新 chunk/重新执行/继续 session 必须有当前 execute entitlement；旧 commit 不授予未来写权限。
- completed receipt replay 是只读交付，可在 execute entitlement 已丢失时仍被允许，但只能在独立
  receipt entitlement 成立时。它不得重新运行 domain operation、延长 session/TTL 或写 marker。
- receipt entitlement 丢失不否定已提交事实，也不产生 terminal no-effect；客户端只能
  `suspend without disclosure`。
- execute entitlement 恢复不自动授予 receipt disclosure；两者分别重验。
- 不允许为了能显示部分内容而运行时删改原 receipt。未来若需要公共安全投影，须由 Q05/G-OUT 定义为
  新的获准 envelope，并保持它不是 original receipt。

### 6.3 重认证、撤权与换 principal

| 场景 | 必须行为 |
| --- | --- |
| 401 / session expiry | 当前 attempt 若无 no-effect authority 则 U；暂停读取/发送，保留服务器事实；不把401当failure |
| 同 User.id 新 session | auth generation 更新仅允许新 callback consumer；重新计算 membership、execute/receipt entitlement；原 identity不变 |
| 同 User.id 但 membership removed/archived | 不执行、不披露 receipt，不确认其存在；原命令可能U/C/F，不由拒绝改写 |
| 同户 role/capability 降级 | 依新 predicate 分别拒绝 execute 或 receipt；已提交事实不变 |
| 同户 role/capability 恢复 | 新请求重新验证后可获得相应资格；旧 callback/lease 不复活 |
| 换 User.id / account | 客户端撤销旧 ticket并销毁或隔离敏感body/key；新 principal不能读取、执行或结算旧命令 |
| household owner 查询他人 command | 默认禁止；owner不自动成为 receipt owner；未来审计能力须新 contract/评审 |
| logout / app restart | 本地删除不等于 server no-effect；原 principal 的未来恢复依赖 Q07/Q09 非敏感 locator，当前仍是发布阻断 |

### 6.4 authorization linearization

每个业务 execute attempt 至少有一个 B authorization decision point：在可能产生业务效果之前，使用受信
principal/scope，在与 membership revocation 具有可证明顺序的状态上重验 execute entitlement。早期 route
auth 只作前置保护，不能替代 B 点；锁等待、parse、排队期间权限变化必须在 B 点被观察。

- revoke 在 B authorization/acceptance transaction 之前完成：该 attempt 不得产生业务效果；
- B transaction 先取得获准顺序并最终 commit：命令事实保持 committed，之后的 revoke 不追溯改写它；
- B 点与最终 commit 之间必须由同一事务/fence 保持该顺序，不能“查完权限即释放、稍后无保护提交”。

每个 receipt response 另有一个 release authorization point：在读取并复制原 receipt 到当前 response-owned
immutable value 之前，验证 receipt entitlement、完整 command correlation 和字段可见性，并与 membership
撤回建立单一可审查顺序。

- revoke 先于 release point：本请求不取得 receipt bytes，返回不披露存在性的安全结果；
- release point 先于 revoke：本次已授权的 immutable response attempt 可以完成发送；之后的新请求全部重验，
  revoke 不能撤回已经释放到 transport 的 bytes；
- 不能把 DB 行锁持有到慢客户端收完，也不能用“response finish”作为授权线性化点；
- release lease 只绑定 current request/ticket、original principal、command identity 和 exact receipt，不能缓存到
  下一请求、下一 auth generation 或别的 principal；
- 具体锁/fence/transaction 和 safe denial wire 由 Q03/Q04/Q05/Q11 证明，本候选不设计 SQL/RLS。

### 6.5 不披露错误的含义

auth/scope/receipt entitlement 失败必须防止跨户/跨 principal existence oracle。具体 HTTP status/problem 尚未
冻结；无论未来选择何种安全外观，consumer 都必须理解为“当前无权取得该事实”，不能理解为原命令不存在、
未提交、可换 key 或已失败。

## 7. 联合状态矩阵

| command事实 | current principal/entitlement | 允许操作 | 禁止推断 |
| --- | --- | --- | --- |
| N，纯本地且L01–L08 | original principal/current owner | 本地取消准备或首次发送 | 不生成server terminal receipt |
| N，已handoff且attempt no-effect | original principal + execute | 原identity恢复/重试 | 不换body/key，不称全命令failure |
| U | original principal + execute + receipt read | 只走原identity恢复；可取E01/E02/E03 | timeout/miss/4xx不能结算 |
| U | same User重新认证但receipt read否 | suspend without disclosure | 拒绝不等于no-effect |
| U | different User | 不读取、不重发、不消费callback | 本地销毁不改变server U |
| C | original principal + receipt read | 只读原receipt；下一新意图独立授权 | 不因缺execute降级C，不重跑原写 |
| C | entitlement revoked | 保持C但不披露 | 403/404不改成F/U |
| F | original principal + receipt read | 只读获准终局no-effect事实；新意图重新确认 | 原identity不能再次commit |
| F | entitlement revoked/different User | 保持F但不披露 | 不因不可见开放identity复用 |
| C/F矛盾候选 | 任意 | 隔离证据、暂停新写/next，交Q04 | 不last-response-wins或多数投票 |

## 8. Owner contract 与后续顺序

| owner | 本候选要求的输入/输出 | 本轮不决定 |
| --- | --- | --- |
| Client / G-CLIENT | once-serialized exact bytes、monotonic handoff latch、exclusive tickets、original key/body恢复、principal/generation消费检查 | storage format、adapter API、retry时间、restart实现 |
| Route/C / G-ROUTE/LIFE | trusted operation/no-query policy、sealed bytes、同attempt ticket、predispatch/dispatch事实 | Fastify hook、HTTP path/status/header、timeout数值 |
| Identity / G-ID | exact constants、namespace、body binding、无alias规则、stale version fail closed | DB列/index、raw body retention、digest implementation |
| Auth / G-AUTH | execute与receipt predicate分离、B/release重验、same/different principal规则 | capability名字、SQL/RLS、错误载体 |
| B / G-BACKEND | command record/fence、authoritative E01/E02/E03、attempt capability关闭、原receipt | schema、锁、isolation、cancel、retention/GC |
| HTTP / G-OUT/ENV | 只表达已获authority的事实，并让client能验证correlation/entitlement | public DTO/status/reason/route，均留Q05 |

如果 Fresh Review 接受本候选，Q01/Q02/Q08 可以被记为“逻辑决策已形成”，但所有相关 G-* 仍然开放；
没有具体 owner contract、实现和真实证据时不得写成 gate closed。下一组仍按 WP-O1：
Q03/Q04/Q06/Q09 设计 B 的 command record、commit/no-effect authority、恢复与 non-reuse；该组若证明
本候选不可实现，必须返回修订本候选，不能让 HTTP/client 猜测结果。

## 9. Written counterexamples / review oracle

以下 W01–W18 均未执行，只是 Fresh Review 与未来动态测试的书面 oracle：

| ID / 场景 | 必须结果 |
| --- | --- |
| W01 same key/body解析等价但属性顺序不同 | body digest不同，same namespace conflict；旧U保留 |
| W02 same key/body但route alias或带任意query | alias不成立；query attempt早拒，旧命令不改，B业务0 |
| W03 same key改replaySessionId/aggregate/ordinal | same namespace/different body conflict，不产生新command |
| W04 same body换key重送旧ordinal | 新identity但被session/order fence拒绝，不能重复效果 |
| W05 client记录attempt=1，旧进程实际已handoff | 不得用ordinal/当前内存证明首次；保持U |
| W06 `handoffStarted`在network调用之后才写 | 设计失败；同步throw/崩溃窗口可假装未发送 |
| W07 handoff后收到可信parser/query/429拒绝 | 只关闭本attempt；旧U保留，不清pending/换key |
| W08 handoff后B确认本事务rollback | E04，不是E03；原identity恢复，不能称terminal |
| W09 receipt miss + retry deadline耗尽 | U且停止自动恢复；不生成F或新key |
| W10 timeout后late commit receipt到旧generation | 旧callback无副作用；当前获准verifier重新验证后才可结算 |
| W11 same User重新登录、membership仍active | identity不变；新generation重新验两类entitlement后恢复 |
| W12 same User重新登录但membership已移除 | 不披露、不执行；不能从拒绝推断未commit |
| W13 owner读取另一member原receipt | 默认拒绝且不泄漏存在；owner身份不替代original principal |
| W14 original principal保留成员但失去写能力 | receipt read可独立允许；不得继续执行chunk |
| W15 revoke与receipt release竞争 | 只有单一release point胜者；不得先查auth后无界缓存再发送 |
| W16 response finish后revoke | 已授权本attempt可已发送；后续请求重验；finish不证明client receive |
| W17 account switch后旧success callback到达 | 新principal状态/导航/pending均不变，旧payload/key不可见 |
| W18 retention删receipt但terminal fence仍需non-reuse | 不可读不等于新command；Q09未闭合仍阻断 |

Fresh Review 必须检查 W01–W18 与 WP-O1 O01–O16、R7-C T29–T50 是否方向一致。若任何路径让
attempt-local 事实终结旧 U、让 auth denial 变 no-effect、让 new principal 消费旧 receipt、让 canonical
JSON 替代 exact bytes，或让 key namespace 随 body 改变，本候选应为 BLOCK。

## 10. Invariant ledger

| ID | 不变量 |
| --- | --- |
| D01 | command identity绑定stable User.id，不绑定session/token/generation/role快照 |
| D02 | household/operation/key决定namespace；body变化只能conflict，不能迁移namespace |
| D03 | body identity覆盖collector封存的全部entity octets；parse/canonicalize/reserialize不等价 |
| D04 | operation/policy/parser identifier exact且无alias；未来版本不静默接管旧U |
| D05 | no-query authority只来自trusted route chain，body/caller/normalized route不能补造 |
| D06 | handoff latch在任何外部执行API前单调登记；登记后不能回到never-sent |
| D07 | client/server attempt id与计数只作correlation，不证明完整attempt set |
| D08 | 纯本地取消只在L01–L08全满足，且不生成server terminal claim |
| D09 | handoff后只有E01/E02/E03终结command；E04/E05只关闭attempt |
| D10 | unknown跨attempt单调；generic status/error/retryable/deadline不清除 |
| D11 | execute entitlement与receipt entitlement每次独立重验，不由历史commit继承 |
| D12 | receipt只默认交付original principal；owner/同户/知道locator不自动授权 |
| D13 | auth denial不改变server fact；撤权后suspend without disclosure |
| D14 | release authorization point与revocation有可审查顺序，lease不跨request/generation |
| D15 | old callback只有经current verifier重新验证才可能消费，不能自行做页面副作用 |
| D16 | cross-principal切换销毁/隔离本地secret不等于server no-effect或identity reusable |
| D17 | original receipt不可为当前权限临时删字段；新projection必须另经G-OUT设计 |
| D18 | 本候选不冻结DB/HTTP/client机制，不把logical decision冒充gate evidence |

## 11. 明确未决与准入 stopline

仍需下一组回答：

- Q03：B 如何建立覆盖历史、在途与未来提交能力的 command-final no-effect fence；
- Q04：commit receipt 的原子 authority、矛盾终态隔离和 original receipt 内容；
- Q06：same-identity lookup 与重新执行如何线性化，何时只查不写；
- Q09：retention 后 non-reuse 和不可恢复事实如何保存；
- Q05：attempt-local、U、C、F、auth suspension 的 public 语义与载体；
- Q07/Q10：durable client state、once-serialized bytes、restart、callback 与版本兼容；
- Q11/Q12：真实 runtime/DB/adapter 证据和项目准入。

Fresh Review 前后都禁止修改产品仓库。只有精确候选取得全新独立 `CLEAN`，且总控再次核对 baseline、
全文、hash 和状态上限后，才能把本候选持久归档或标记逻辑决策接纳。即便接纳也不授权实现，不关闭
任一 G-*，不改变 M1/G2/M2 状态。
