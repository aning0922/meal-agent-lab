# WP-O2 command boundary / entitlement — evidence record

## 1. Authority and result

角色：项目总控形成 design candidate，不是独立 Reviewer。

交付结论：`READY_FOR_FRESH_REVIEW`。

本 evidence 只记录 WP-O2 的 PRE、read-set、静态事实、候选一致性检查和 artifact identity。
没有执行产品测试、数据库、网络、Taro、Docker 或任何 M2 runtime gate；没有修改仓库。

## 2. PRE stopline

| 项 | 值 |
| --- | --- |
| worktree | `/Users/aipuli/.codex/worktrees/50c9/meal-agent-lab` |
| branch | `codex/stage-09p-m2-inventory` |
| HEAD | `41c2e7b5013051201c10365b9f41af00b643fae8` |
| tree | `a80c61d4e780cadaad23f7c42b4dea996880b0ad` |
| parent | `062fc9c5007b9bbf866b6dfa3b1e14309314a451` |
| named branch ref | `41c2e7b5013051201c10365b9f41af00b643fae8` |
| `git status --porcelain=v1 --untracked-files=all` | 空输出 |

检查命令：

```text
git status --short --branch
git rev-parse HEAD
git rev-parse HEAD^{tree}
git rev-parse HEAD^
git rev-parse refs/heads/codex/stage-09p-m2-inventory
git status --porcelain=v1 --untracked-files=all
```

## 3. Read-set

项目规则与事实源：

- `AGENTS.md`
- `README.md`
- `docs/README.md`
- `docs/project-status.md`
- `docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md`
- `docs/architecture/decisions/0003-identity-tenancy-and-api-semantics.md`
- `docs/architecture/decisions/0004-stage-08-pre-release-audit-closeout.md`

持久设计与审查输入：

- `docs/evidence/stage-09p-m2/README.md`
- `docs/evidence/stage-09p-m2/r7b-shadow-design.md`
- `docs/evidence/stage-09p-m2/r7b-shadow-fresh-review.md`
- `docs/evidence/stage-09p-m2/r7c-shadow-design-r1.md`
- `docs/evidence/stage-09p-m2/r7c-r1-fresh-review.md`
- `docs/evidence/stage-09p-m2/m2-post-r7-gap-gate.md`
- `docs/evidence/stage-09p-m2/wp-o1-outcome-evidence-scope-decision-pack.md.raw`
- `docs/evidence/stage-09p-m2/wp-o1-fresh-review.md`

当前源码静态对照：

- `packages/contracts/src/inventory-v2.ts`
- `packages/contracts/src/seasoning-v1.ts`
- `packages/contracts/src/api.ts`
- `services/api/src/database/repository.ts`
- `services/api/src/database/schema.ts`
- `services/api/src/utils.ts`
- `apps/client/src/core/idempotency.ts`
- `apps/client/src/core/command-registry.ts`
- `apps/client/src/core/command-dispatcher.ts`
- `apps/client/src/core/api-client.ts`
- `apps/client/src/core/session-store.ts`
- `apps/client/src/platform/ports.ts`
- `apps/client/src/platform/taro-adapter.ts`

使用 `rg`、`sed`、`nl`、`git`、`wc`、`stat` 与 `shasum` 只读定位；没有执行或修改源码。

## 4. Current-code facts independently observed by controller

| 观察 | 静态位置 | 对 WP-O2 的约束 |
| --- | --- | --- |
| client key 由 `RuntimePort.randomToken()` 生成，port 注释明确是非密码学用途 | `apps/client/src/core/idempotency.ts:19-21`；`apps/client/src/platform/ports.ts:59-63` | 当前 key 生成不能自证 M2 fresh/exclusive identity |
| client 先按对象键排序保存 command object | `apps/client/src/core/idempotency.ts:23-33,148-180` | current snapshot 是 semantic object，不是 once-serialized raw bytes |
| pending coordinator 只驻内存 | `apps/client/src/core/idempotency.ts:98-109` | restart 后无法证明 attempt history 或恢复原 unknown |
| `settle` 对非 unknown disposition 直接清 pending | `apps/client/src/core/idempotency.ts:246-268` | M2 不能沿用普通 disposition 终结旧 U |
| ordinary API error <500 被归 definite failure | `apps/client/src/core/idempotency.ts:371-392` | 400/401/403/404/409/413/415/429 不能直接接 WP-O1 outcome |
| current retry 有单进程同步 single-flight 和 stale commandId guard | `apps/client/src/core/idempotency.ts:242-297` | 是有用局部控制，但不证明跨进程/服务端 `Attempts(C)` 完整 |
| 401 suspend、same principal generation update、different principal delete 已存在 | `apps/client/src/core/idempotency.ts:312-345` | 可作为方向事实，但 current membership/receipt entitlement 未验证 |
| ApiClient 每次 call 从 object 执行 `JSON.stringify`，然后调用 NetworkPort | `apps/client/src/core/api-client.ts:82-98` | 没有 once-serialized identity 或 handoff-before-call latch |
| ApiRequestSpec 允许 query 并由 helper拼入 URL | `apps/client/src/core/api-client.ts:35-39,50-63,90-94` | M2 operation 必须另有 no-query typed/runtime guard，不可复用默认能力 |
| NetworkPort 只返回 Promise，没有 dispatch/no-effect/attempt authority | `apps/client/src/platform/ports.ts:22-25` | promise result 不能定义 command outcome 或 attempt closure |
| Taro adapter 在无 crypto.randomUUID 时回退 Date/计数/Math.random | `apps/client/src/platform/taro-adapter.ts:36-53` | 当前 fallback 不满足 WP-O2 本地新鲜性候选 |
| session generation 是 client-local counter，principal 是 session.user.id | `apps/client/src/core/session-store.ts:54-77` | generation 适合 callback consumer，不适合 logical command identity |
| server legacy request hash 是 canonical JSON 后 SHA-256 | `services/api/src/utils.ts:13-34` | 不能冒充 WP-O2 exact entity octets identity |
| legacy DB namespace 是 user/household/method/normalized route/key | `services/api/src/database/schema.ts:711-781`；`repository.ts:702-719,833-844` | 仅为 legacy事实；M2 abstract operation/policy与raw binding尚未实现 |
| legacy replay 要求 active household membership/RLS first hop | `ADR-0003:95-122` 与 repository bootstrap | 支持每次授权的方向，但不证明 receipt release point/revocation order |
| R7-A 已有两个 distinct parser contract | `parseInventoryReplayChunkInputV2`、`parseSeasoningReplayChunkInputV1` | WP-O2 为两个 operation 固定不同 parser contract，不建立跨域 alias |

这些静态事实不能证明 Taro 真实发送字节、Fastify 原始 target/body、数据库 commit/cancel、权限撤回竞态、
receipt retention 或任何动态 budget。WP-O2 保持 Q03/Q04/Q05/Q06/Q07/Q09/Q10/Q11/Q12 开放。

## 5. Candidate completeness checks

候选机械计数：

- exact logical identifiers：7 个；
- local-only release 条件：L01–L08，共 8 条；
- owner rows：6 行；
- written counterexamples：W01–W18，共 18 条；
- invariant ledger：D01–D18，共 18 条；
- joint state rows：10 行；
- Q01/Q02/Q08 三项均有明确候选答案与 unresolved mechanism boundary。

人工方向对照：

1. 与 WP-O1 一致：U 只由 E01/E02 或 E03 终结；E04/E05 是 attempt-local。
2. 与 R7-B 一致：principal/household/operation/key + 完整 body binding，不信 caller claim；具体 DB 机制仍 Proposed。
3. 与 R7-C r1 一致：no-query、sealed raw body、once-only handoff、attempt 与 logical command 分离。
4. 与 ADR-0003 一致：stable internal User.id、transaction 内 household membership/capability、跨户不披露。
5. 与 ADR-0004/current client safety direction 一致：401 suspend、different principal 隔离、local completion 与 backend fact 分离。
6. 未新增 public status/reason/field、route、SQL、migration、capability name 或 retention 数值。

Fresh Review 仍须独立检查：

- logical exact body equality 与 `length+SHA-256` fingerprint 的描述是否没有偷换；
- route 未定时 exact operation/no-query policy 是否足以作为 Q01 逻辑决定而不越过 G-ROUTE/G-ENV；
- handoff 后一律不释放 envelope 的保守 baseline 是否与所有 WP-O1 N/U 行一致；
- execute entitlement 与 receipt entitlement 分离是否会意外披露撤权后的 household data；
- release authorization point 的 before/after revoke 顺序是否明确且不要求持锁跨网络；
- current owner 不能读取其他 principal receipt 是否与既有业务范围冲突；
- W01–W18、D01–D18 是否完整覆盖 Q01/Q02/Q08。

## 6. Artifact identity and output boundary

私有输出目录：`/private/tmp/meal-agent-wp-o2-command-boundary.IbNlMv`，mode `0700`。

当前候选身份：

| 文件 | Lines | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `WP-O2-command-boundary-entitlement-decision-pack.md` | 438 | 29,516 | `239e82c2a800cbff7e3044b41d09f41bed305b1f072cc759527197c9ac25bd1d` |

本 evidence 文件写入后须重新执行 `wc -lc`、`shasum -a 256`、目录枚举、mode、仓库 status 与
candidate 标题/计数检查；最终 POST 以该重验输出为准。本 evidence 不自评 `CLEAN`。
