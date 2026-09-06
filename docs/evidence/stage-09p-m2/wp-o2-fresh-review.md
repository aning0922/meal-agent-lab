WP-O2_FRESH_REVIEW: CLEAN

# Stage 09P-M2 / WP-O2 Fresh Review

日期：2026-09-06（Asia/Shanghai）。角色：全新独立 Fresh Reviewer。

本次审查对象是两份固定字节的 WP-O2 候选材料，而不是作者的 `READY_FOR_FRESH_REVIEW`
自评或历史 reviewer 结论。审查只读；未修改候选、仓库或 Git，未运行产品测试、数据库、
网络、Docker、Taro、generator、migration 或任何会改变外部状态的命令。

## 1. Verdict、severity 与 claim ceiling

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |

结论为 CLEAN。候选对 WP-O1 Q01、Q02、Q08 给出的联合逻辑是完整、安全且内部一致的：
command key namespace 与不可变 request binding 分开；logical equality 仍是 exact octet
equality，`length+SHA-256` 只作查找/相关；`Attempts(C)` 不由当前内存、attempt count 或
receipt miss 穷尽；handoff 后只有 E01/E02/E03 可以终结 command；original principal、
current authentication、execute entitlement、receipt entitlement 与 callback auth generation
分别建模；execute 与 receipt release 各自具有和 revocation 可排序的 authorization point。

本 CLEAN 的最高含义仅为：SHA-256 分别为
`239e82c2a800cbff7e3044b41d09f41bed305b1f072cc759527197c9ac25bd1d` 与
`33c98949913b8cdce3a9ddbb0e62d9312d469c8ac9f5fead77bf9f7f6e9fb92f` 的两份
WP-O2 DESIGN_ONLY 材料在本次范围内没有发现 P0/P1/P2。它不表示
`CONTRACT_FROZEN`、implementation admission、Implemented、M1/M2 Accepted 或 G2 admitted。

## 2. PRE baseline 与 material stopline

所有语义审查前先从任务指定的权威 worktree 独立核验。当前 Reviewer 自己的工作目录是
`/Users/aipuli/.codex/worktrees/06b1/meal-agent-lab`；它不参与 source baseline 判定，也未因
独立 worktree 状态被误报为失败。

| PRE 项 | 实际观察 | 期望 | 结果 |
| --- | --- | --- | --- |
| authoritative worktree | `/Users/aipuli/.codex/worktrees/50c9/meal-agent-lab` | 同值 | PASS |
| branch | `codex/stage-09p-m2-inventory` | 同值 | PASS |
| HEAD | `41c2e7b5013051201c10365b9f41af00b643fae8` | 同值 | PASS |
| named branch ref | `41c2e7b5013051201c10365b9f41af00b643fae8` | 同值 | PASS |
| tree | `a80c61d4e780cadaad23f7c42b4dea996880b0ad` | 同值 | PASS |
| unique parent | `062fc9c5007b9bbf866b6dfa3b1e14309314a451` | 同值 | PASS |
| `git status --porcelain=v1 --untracked-files=all` | 空输出 | clean | PASS |

候选材料 stopline：

| 文件 | Lines | Bytes | SHA-256 | 结果 |
| --- | ---: | ---: | --- | --- |
| `WP-O2-command-boundary-entitlement-decision-pack.md` | 438 | 29,516 | `239e82c2a800cbff7e3044b41d09f41bed305b1f072cc759527197c9ac25bd1d` | PASS |
| `WP-O2-command-boundary-entitlement-evidence.md` | 142 | 8,435 | `33c98949913b8cdce3a9ddbb0e62d9312d469c8ac9f5fead77bf9f7f6e9fb92f` | PASS |

未触发 baseline/material stopline；只有全部身份项精确通过后才开始语义审查。

## 3. Actual read-set 与证据层级

### 3.1 完整逐行阅读

1. 候选 decision pack 438 行与 evidence 142 行。
2. 根 `AGENTS.md`、`README.md`、`docs/README.md`、`docs/project-status.md` 全文。
3. `docs/evidence/stage-09p-m2/README.md` 全文。
4. `r7b-shadow-design.md` 424 行与 `r7b-shadow-fresh-review.md` 139 行。
5. `r7c-shadow-design-r1.md` 409 行与 `r7c-r1-fresh-review.md` 216 行。
6. `m2-post-r7-gap-gate.md` 323 行。
7. `wp-o1-outcome-evidence-scope-decision-pack.md.raw` 363 行与
   `wp-o1-fresh-review.md` 285 行。
8. ADR-0003 279 行、ADR-0004 153 行。
9. `docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md` 707 行。

### 3.2 当前源码独立静态检查

完整读取 `packages/contracts/src/api.ts`；客户端 `idempotency.ts`、
`command-registry.ts`、`command-dispatcher.ts`、`api-client.ts`、`session-store.ts`、
`platform/ports.ts` 与 `platform/taro-adapter.ts`。定向读取两域 contracts parser/result/
checkpoint 段、server legacy idempotency 的 schema/repository/auth/hash 段。

只读定位包括：

- `packages/contracts/src/inventory-v2.ts:580–760`；
- `packages/contracts/src/seasoning-v1.ts:210–365`；
- `services/api/src/utils.ts` 全文；
- `services/api/src/database/schema.ts:711–797`；
- `services/api/src/database/repository.ts:500–630,680–940`。

静态源码只用于验证现有形状与能力缺口；没有把源码、注释、schema 名称或历史测试数字冒充
Taro exact-wire、Fastify raw target/body、DB commit/cancel、revocation race、receipt retention
或任何动态证据。

## 4. Independent current-source facts

| 观察 | 独立源码依据 | 对 WP-O2 的结论 |
| --- | --- | --- |
| stable principal 来源 | ADR-0003:27–49 将 `AuthIdentity → User → Session/Membership` 分层；client session context 取 `session.user.id`（`session-store.ts:67–77`） | `User.id` 可作为逻辑主体；session/token/generation 不应成为 command identity |
| 两域 parser 独立 | `inventory-v2.ts:616–621,745–760` 与 `seasoning-v1.ts:235–241,330–344` 分别公开 raw parser，并明确跨请求 authority 仍属 R7-B | 候选使用两个无 alias 的 semantic parser ID，未把 schema shape 当 authority |
| public API 现状 | `api.ts:9–50,59–83,99–127` 只有既有 problem/status/success/meta 形状 | 现有 `status`、`ok`、`retryable`、`replayed` 不承载 WP-O2 command-final 范围 |
| legacy hash | `utils.ts:13–34` 对对象键排序、`JSON.stringify` 后 SHA-256 | 这是 canonical object hash，不是 exact entity-body octets |
| legacy DB namespace | `schema.ts:711–781` 与 `repository.ts:690–729,809–872` 绑定 user/household/method/normalized route/key，并比较 `requestHash` | 不能冒充 M2 operation/policy namespace、raw binding 或 attempt closure |
| legacy committed failure | `repository.ts:750–787,875–905` 可重放已提交 domain failure/tombstone | HTTP 4xx/CONFLICT 不等于数据库无写入，也不能普遍外推为 M2 E03 |
| current auth helper 有副作用 | `repository.ts:522–618` 锁 session 并更新 `last_seen_at`/idle expiry | 不能作为已存在的无副作用 pre-B auth 或 revocation fence |
| client snapshot 是对象且仅内存 | `idempotency.ts:23–33,98–109,139–193` canonicalize command object，coordinator 只驻内存 | 不证明 once-serialized bytes、restart history 或完整 `Attempts(C)` |
| current settlement 过宽 | `idempotency.ts:246–268,371–410` 清理非-unknown；普通 4xx/default 归 definite failure | 不满足旧 U 只能由 E01/E02/E03 终结的 M2 规则 |
| current CAS/single-flight 是局部控制 | `idempotency.ts:241–298,312–345` 有 commandId CAS、unknown→in-flight 和 principal/generation guard | 有助于 current-process 安全，但不证明跨进程 attempt 全集、receipt entitlement 或 handoff latch |
| dispatcher 分开 backend/local | `command-dispatcher.ts:75–150` 先 settle，再做 local transition；本地失败不重发写 | 支持 local completion 与 command outcome 分轴，但 generic disposition 不能直接复用到 M2 |
| API 重序列化且可带 query | `api-client.ts:31–40,50–63,82–97` 每次 call 再 `JSON.stringify` 并拼 `query` | 当前不具 once-serialized exact bytes/no-query operation binding |
| Network/Taro 上限 | `ports.ts:22–25,59–63` 只有 Promise 且 token 注释为非密码学；`taro-adapter.ts:15–24,36–53,66–77` 有 15s timeout 与 fallback random | Promise/timeout/reject 不产生 dispatch/no-effect authority；当前生成/adapter 不能自证 M2 freshness/exact send |

## 5. Q01 review：identity namespace 与 immutable request binding

候选 44–67 将 key namespace 精确限定为
`identityPolicyVersion + originalPrincipalUserId + household scope/id + operationId + idempotencyKey`，
并把 `bodyProfileVersion + exactEntityBodyOctets + parserContractId + routePolicyId` 作为不可替换
request binding。两者没有混成一个随 body 改变的 namespace。body 中的 session、aggregate、kind、
ordinal、claim、events、count/digest 等虽仍需 B 与受保护状态逐项复核，却不能替代完整 body。

候选 174–186 的冲突表保持：same key namespace + 任一 binding 差异只能成为 conflict attempt；
different key 是不同 command identity，但仍必须经 R7-B session/order/persisted-prefix fence，不能重复
业务效果。stable `User.id` 来自 server verified session；openid、token、membership、role、body actor
和 auth generation 均被排除，符合 ADR-0003 的身份分层。

审查结果：CLEAN。

## 6. Exact octets、fingerprint 与 semantic identifiers

候选 149–172 明确把 entity body 定义为 framing 去除后、decode/parse/normalize 之前封存的 bytes；
属性顺序、空白、escape、数字文本等任一 byte 差异均不等价，retry 也不得再次 stringify。
`exactEntityBodyOctetLength + sha256:<lowercase hex>` 只用于 lookup/correlation；候选反复声明逻辑
binding 是 bytes 本身、摘要不是 authentication/authorization，也不能把 equality 降成 hash equality。

W01 的 `digest不同` 只能作为未来选定普通 fixture 的观测项，不能成为冲突 authority；即使摘要比较
出现实现错误或极端碰撞，D03 和 160–172 仍要求以 exact bytes/fail-closed 机制处理。raw-body retention、
collision handling、DB 表示、算法/编码验证均诚实留给 Q03/Q04/Q11，候选没有依赖尚未选择的机制宣布
可实现或 gate closed。

候选 102–121 的 7 个 exact ASCII identifier 是逻辑 semantic identifier，不是 URL、DB 列或 public
operationId。禁止 trim/case-fold/Unicode normalization/alias/fallback；语义改变需要新 identifier，
旧 unknown 的 N-1/兼容验证留 Q10/Q11。候选 138–147 又要求 operation/no-query authority 只能来自
可信 method+route chain，body、normalized path、删 query 后路径或 caller Boolean 均不能补造；实际
URL/method/header/proof carrier 仍由 G-ROUTE/G-ENV 阻断。因此没有越过 R7-C no-query joint gate。

审查结果：CLEAN。

## 7. Q02 review：`Attempts(C)`、handoff 与本地取消

候选 192–215 将 local draft、transport handoff 与 trusted dispatch 三条边界分开。dispatcher 必须在
任何 `NetworkPort.request`、Taro/socket/queue/worker 或外部 execution-owner API 前单调登记
`handoffStarted`；登记后同步 throw/进程崩溃也不能恢复成 never-sent。

`Attempts(C)` 覆盖客户端所有已 handoff transport attempts、服务端识别出的入口、排队/dispatch/
取消中/后台仍持 commit capability 的工作、retry/recovery、迟到或已失去观察者的请求，以及任何获准
中间层重放。attempt ID/ordinal/count、requestId、worker/transaction ID、auth generation、当前内存与
receipt miss 全部只可 correlation，不能证明全集。未能证明中间层不重放时 baseline 直接阻断。

L01–L08 是足够窄的唯一 local-only 例外：全新唯一 owner、monotonic latch=false、所有发送能力仍由
同一 owner 控制、没有第二 dispatcher/outbox/device、先撤销 tickets 后销毁 body/key、不生成 server
terminal claim、新用户意图重新确认并使用新 envelope，且 restart 后无法重证就禁用例外。候选 232–233
准确承认现有 in-memory coordinator、fallback token 与 call-time stringify 不满足它。

handoff 后 E04/E05 只关闭当前 attempt；若已有 U，任何 parser/query/auth/admission/4xx/429 rejection、
known rollback、timeout、abort、receipt miss 或 retry deadline 都不能覆盖旧 U。只有 E01/E02/E03
终结 command，E03 又必须覆盖历史、在途和未来 commit capability。具体怎样建立 command-final fence
仍是 Q03，不被当前文档伪装为现存能力。

审查结果：CLEAN。

## 8. Q08 review：principal、entitlement 与 revocation ordering

候选 264–287 分离 original principal、current authenticated principal、per-attempt execute entitlement
和 per-release receipt entitlement；auth generation 只控制 callback consumer，不改变 logical identity。
receipt 默认只向 original `User.id` 开放，并要求当前有效 session、原家庭 active membership、精确
operation 的 read-own capability、全部 immutable receipt 字段当前可见，以及完整 identity/binding/
receipt correlation。owner、同户成员、知道 key/UUID 均无默认资格；无法机械判定就保持 G-AUTH 阻断。

候选 300–312 对 same principal reauth、membership 撤回、role 降级/恢复、different principal、owner
读取他人 receipt、logout/restart 均 fail closed。换账号销毁/隔离本地 secret 不被写成 server no-effect；
同 principal 也必须重验 membership 和两类 entitlement。401/403/404 与不披露结果均不得反推出原命令
不存在、未 commit 或可换 key。ADR-0004 的 self-exit/特定 Members 4xx 例外没有被普遍外推。

候选 313–333 为 execution 和 receipt release 设置两个独立线性化点：B authorization 必须在业务效果前
观察撤权，并以同一事务/fence 保持到 commit；receipt release 则在复制到 request-owned immutable value
前重验 entitlement/correlation/field visibility，并与撤权取得单一可审查顺序。revoke-before-release 不取
receipt bytes；release-before-revoke 只允许该已授权 immutable response attempt 完成，后续请求仍重验。
候选明确禁止持 DB 锁跨慢网络，也禁止 lease 跨 request/auth generation/principal，具体 SQL/RLS/lock/
safe denial 仍留后续 owner。

审查结果：CLEAN。

## 9. Matrices、oracles 与上游一致性

机械枚举确认：L01–L08、W01–W18、D01–D18 均连续，无缺号或重复定义。联合状态矩阵覆盖 N/U/C/F、
原 principal/不同 principal、execute/read capability、撤权、C/F 冲突隔离；它是 Q01/Q02/Q08 的安全
decision matrix，不冒充新的 public state enum，也不替换 WP-O1 的完整 4×7 settlement 表。

- W01–W04 覆盖 exact bytes、route/query、same-key binding conflict、different-key order fence；
- W05–W10 覆盖旧 handoff、latch 写入顺序、attempt-local rejection/rollback、miss/deadline 与 late callback；
- W11–W17 覆盖 same/different principal、membership/role、owner receipt、revocation/release 与 account switch；
- W18 保持 retention 与 identity non-reuse 分开，明确 Q09 未闭合；
- D01–D18 将上述规则压成无冲突的 invariant ledger，D18 保留机制与证据 claim ceiling。

这些规则与 WP-O1 E01–E19、N/U/C/F × 7、O01–O16；R7-B principal/scope/body、事务/锁序、unknown/
receipt 方向；R7-C r1 no-query、once-only handoff、T29–T50；ADR-0003 transaction-scoped authorization；
ADR-0004 principal/generation/CAS/restart/local completion；以及 09P 计划的 household product-flow 总序
一致。没有路径让 attempt-local 事实终结旧 U、让 auth denial 变 no-effect、让新 principal 消费旧 receipt、
让 canonical JSON 代替 raw bytes，或让 body 改变 key namespace。

审查结果：CLEAN。

## 10. Findings

| ID | Severity | 精确位置 | Finding | 最小修订建议 |
| --- | --- | --- | --- | --- |
| — | — | — | 没有 P0/P1/P2 finding | — |

没有把明确留给后续 owner 的 raw retention、DB/RLS/lock、public carrier、client storage/restart、真实
runtime/adapter evidence 当作本轮缺陷，因为候选没有依赖这些未决机制得出实现或准入结论。

## 11. Residual unresolved items（非 findings）

1. Q03/Q04/Q06/Q09：B command record、commit/no-effect authority、same-identity lookup/re-execution、
   cancellation/commit fence、retention 后 non-reuse 与冲突终局治理。
2. Q05：attempt-local/U/C/F/auth suspension 的 public G-OUT/G-ENV 语义与载体；当前没有 DTO/status/
   reason/route freeze。
3. Q07/Q10：durable client locator、once-serialized bytes、restart、callback verifier 与 parser/identity/
   operation 版本兼容。
4. Q11/Q12：真实 Node/Fastify/Taro/PostgreSQL、revocation race、RLS/permission、N-1、budget/logging 和
   项目 admission evidence。

这些未决项继续阻断 implementation；它们不是把当前逻辑候选降级为 BLOCK 的理由。

## 12. Claim ceiling 与未执行事项

候选没有冻结 public DTO/status/reason/route/header、数据库 table/column/schema/SQL/RLS/lock/isolation/
retention、client storage/API/port、Fastify/Taro hook 或实现。7 个 exact logical identifier 只冻结本
decision candidate 的语义名称，不是 public URL/DTO 或已接线 runtime。

G-ROUTE/G-ENV/G-OUT/G-ID/G-CLIENT/G-AUTH/G-LIFE/G-BUDGET/G-LOG/G-BACKEND 全部保持开放；
T01–T50 执行数保持 0；R7-B/R7-C 仍为 `SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`；
M1=`M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`、G2=`G2_NOT_ADMITTED`、M2=`In Progress`。

本轮未运行任何产品测试或动态 gate，未写代码/fixture/manifest/evidence，未联网，未接触真实用户、家庭、
健康、消费、食品或凭据数据；未 commit、push、merge、PR、branch、checkout/switch、stash 或修改 Git admin。

## 13. Semantic-review closure POST

语义审查完成、写入本报告前重复了与 PRE 相同的只读封口检查：权威 worktree branch/HEAD/ref/tree/
parent 仍逐字等于 §2；porcelain 仍为空；候选仍为 438 行 / 29,516 bytes /
`239e82c2a800cbff7e3044b41d09f41bed305b1f072cc759527197c9ac25bd1d`，evidence 仍为
142 行 / 8,435 bytes / `33c98949913b8cdce3a9ddbb0e62d9312d469c8ac9f5fead77bf9f7f6e9fb92f`。

Reviewer 输出目录为 `/private/tmp/meal-agent-wp-o2-fresh-review.DLC53T`，创建后实测 mode `0700` 且
起初为空。本报告是该目录唯一允许的文件。报告封口后还会再次做同组只读 POST；最终 report lines/
bytes/SHA-256 只在封口后的工具输出和交付消息登记，避免把 full-file hash 写回自身造成自引用。

最终精确 verdict：`WP-O2_FRESH_REVIEW: CLEAN`。
