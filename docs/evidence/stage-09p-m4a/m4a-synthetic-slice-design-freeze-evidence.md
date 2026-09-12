# M-4a 有界合成纵切 — 设计冻结证据

- 日期：2026-09-12
- 性质：**证据记录（evidence）**，与 [`m4a-synthetic-slice-design-freeze.md`](m4a-synthetic-slice-design-freeze.md) 同批。
- 用途：记录设计冻结所依据的**真实 PRE 身份**、**实际读取的材料与行数**、以及**显式 stopline**，使后续任一读者可在同一起点上复算。
- 本文件**不**授予任何实现、合同冻结落库、migration、DB/RLS、API/client、外部能力或里程碑状态；它记录一次**只读**的设计准备。

---

## 1. 工作树 PRE 身份

| 项 | 值 |
| --- | --- |
| 绝对路径 | `/Users/aipuli/Documents/Projects/meal-agent-lab/.local/worktrees/wp-o3` |
| branch | `codex/stage-09p-wp-o3` |
| HEAD | `62f23bb3d47960f8c875534576b352c64774f4a5` |
| tree | `029069ba3eff6c8d973f2f481184dc7d7f9f2226` |
| parent（HEAD~1） | `976d4ee`（`fix(docs): correct relative plan and ADR links under docs/operations`） |
| HEAD 提交标题 | `docs(stage09p): record the M1 dynamic leg as closed (audit M1D-3)` |
| 工作树状态 | clean（`git status --short` 为空） |
| 远端跟踪 | `refs/remotes/origin/codex/stage-09p-wp-o3` 存在（本设计未 push） |

### 1.1 关键冻结文件的 PRE 摘要（SHA-256）

这些摘要是「本设计阅读的确切字节」的绑定；实现时若这些文件已变，须重新在改动前的字节上复算本设计的引用。

| 路径 | SHA-256 |
| --- | --- |
| `packages/contracts/src/meals.ts` | `b6da9bfa770c8a81c76a9090cc3455fe3e1774eca04a671685a2b4dfc6fcf723` |
| `packages/contracts/src/http.ts` | `61a423d987e142c8043eca4bd1a9b9a86bf798f46e8af0bbf81a1725eb04c9e4` |
| `packages/contracts/src/api.ts` | `c00763ecf31e956aaf2dc22c48fe94b0e754c2f45bf126207e1c531296a58543` |
| `services/api/src/database/schema.ts` | `7510801271b41123f9c05f65524a1025ed07bba1412751024a5e09537823c8de` |
| `services/api/src/database/authorization-manifest.ts` | `704c73c1a5f25f416eb549d8d70d6539e744aafb8a96dccc3425de0a741084f0` |
| `services/api/migrations/0004_stage_08_final_closeout.sql` | `e0981ce6330edabeffab3993c76208df7d831a24826f1a6bdddf25dab5641074` |

### 1.2 仓库静态事实（本设计据以做出的判断）

| 事实 | 值 | 复核位置 |
| --- | --- | --- |
| migration 新建的表总数 | `CREATE TABLE` × **11** | `grep -c '^CREATE TABLE' services/api/migrations/*.sql` = 11 |
| migration 文件 | `0000`—`0004`（5 个） | `ls services/api/migrations/` |
| `schema.ts` 镜像表 | 11（`stage06Tables`） | `services/api/src/database/schema.ts:785-797` |
| meal/recommendation 请求 schema | **0** | `packages/contracts/src/meals.ts:1-268` 无 `*RequestSchema` |
| meal/recommendation HTTP 信封 | **0** | `packages/contracts/src/http.ts:1-134` 无对应 `*SuccessSchema` |
| recommendation/meal 写路由 | **0** | `services/api/src/routes.ts:193-861` 的 operationId 无 recommendation/meal |
| normalizedRoutes / idempotencyPolicies 条目 | 12 / 12 | `services/api/src/database/repository.ts:233-253`、`:258-289` |
| authorization manifest 已登记 state | **4**（`[0000]×2`、`[0000..0004]×2`） | `services/api/src/database/authorization-manifest.ts:235`、`:477`、`:795`、`:1219` |
| 客户端 typed 写命令 | 15 | `apps/client/src/core/command-registry.ts:57-175` |
| 客户端页面 | 5 | `apps/client/src/pages/` = households/inventory/login/members/profile |
| membership capability 枚举 | 3（`inventory:write`/`meal:write`/`shopping:write`） | `packages/contracts/src/identity.ts:186-193` |
| refinement manifest 条目 | 35 | `packages/contracts/src/refinement-rules.ts`；断言 `packages/contracts/tests/refinement-rules.test.ts:193-195` |
| `packages/domain` 生产模块集 | 7（精确集合） | `scripts/check-stage09p-m0-scope.mjs:5-13`、`:105` |
| domain `index.ts`/`types.ts`/`resolution.ts` | 被 SHA-256 钉死 | `scripts/check-stage09p-m1-scope.mjs:78`、`:79`、`:85` |
| public trust allowlist | 固定为空（恒 fail closed） | `packages/domain/src/resolution.ts:311` |

---

## 2. 第二事实源分支 PRE 身份

| 项 | 值 |
| --- | --- |
| branch | `codex/stage-09p-m2-inventory` |
| HEAD | `41d47ebfa02313e2f388ae1749b54f4cec3f97d8` |
| tree | `ec66e80cec1c89bb1ea6369df2ac7bcdf3d87ead` |
| parent | `41c2e7b5013051201c10365b9f41af00b643fae8` |
| HEAD 提交标题 | `docs(stage09p): accept and archive WP-O2 decisions` |
| HEAD 提交时间 | `2026-09-06 21:43:47 +0800` |
| 相对 `main` 的 diff | 95 files changed, 42677 insertions(+), 178 deletions(-) |
| `docs/evidence/stage-09p-m2/` 文件数 | 19 |
| 推送状态 | **未推送**（仅本地 ref） |

读取方式：`git -C .local/worktrees/wp-o3 show codex/stage-09p-m2-inventory:<path>`（只读，未 checkout、未改动该分支）。

---

## 3. 实际读取的材料（真实行数）

### 3.1 契约层

| 路径 | 行数 |
| --- | ---: |
| `packages/contracts/src/meals.ts` | 268 |
| `packages/contracts/src/http.ts` | 134 |
| `packages/contracts/src/api.ts` | 172 |
| `packages/contracts/src/primitives.ts` | 557 |
| `packages/contracts/src/identity.ts` | 341 |
| `packages/contracts/src/members.ts`（`230-379` 段全文） | 674 |
| `packages/contracts/src/shopping.ts`（头段） | 112 |
| `packages/contracts/src/refinement-rules.ts` | 232 |
| `packages/contracts/src/index.ts` | 10 |
| `packages/contracts/tests/refinement-rules.test.ts`（`180-200` 段） | — |
| `packages/contracts/tests/contracts.test.ts`（`1243-1244` 命中） | — |

### 3.2 服务层

| 路径 | 行数 |
| --- | ---: |
| `services/api/src/database/schema.ts` | 797 |
| `services/api/src/database/repository.ts` | 2907 |
| `services/api/src/database/mappers.ts` | 390 |
| `services/api/src/database/authorization-manifest.ts` | 2292 |
| `services/api/src/database/authorization-identity.ts` | 206 |
| `services/api/src/database/authorization-manifest-sql.ts`（`281-345` 区段） | 571 |
| `services/api/src/database/authorization-policy-sql.ts`（`466-504` 区段） | 608 |
| `services/api/src/database/authorization-projection-sql.ts`（`335-347`、`743-803` 区段） | 842 |
| `services/api/src/database/stage06-manifest-sql.ts`（`487-571` 区段） | 631 |
| `services/api/scripts/stage06-manifest-adapter.ts`（`40-64` 区段） | 144 |
| `services/api/src/database/migrate.ts`（`34-58`、`189-203`、`453-484`、`544-549` 区段） | 580 |
| `services/api/src/routes.ts` | 861 |
| `services/api/migrations/0000_stage_06.sql`（`380-553` 区段） | 555 |
| `services/api/migrations/0004_stage_08_final_closeout.sql`（`1-12` 头注释） | 1324 |
| `services/api/package.json`（`14`、`20-23`） | — |
| `services/api/tests/unit/stage06-manifest.test.ts`（`261`、`340`、`1199-1223`） | — |
| `services/api/openapi/stage-08.openapi.json`（`5238-5278` 命中） | — |

### 3.3 领域包

| 路径 | 行数 |
| --- | ---: |
| `packages/domain/src/index.ts` | 107 |
| `packages/domain/src/canonical.ts` | 367 |
| `packages/domain/src/resolution.ts` | 1969 |
| `packages/domain/src/types.ts` | 665 |
| `packages/domain/package.json` | — |
| `packages/domain/README.md`（头段） | — |

### 3.4 客户端与门禁

| 路径 | 行数 |
| --- | ---: |
| `apps/client/src/core/command-registry.ts` | 554 |
| `apps/client/src/core/endpoints.ts` | 325 |
| `scripts/check-stage09p-m0-scope.mjs` | 262 |
| `scripts/check-stage09p-m1-scope.mjs` | 599 |
| `infra/docker/m4-lifecycle.mjs`（`414-426` 区段） | 1583 |
| `infra/docker/run-local-test-restore-drill.mjs`（`266-276` 区段） | 353 |
| `infra/docker/run-local-test-smoke.mjs`（`166-179`、`748-751`、`761-770` 区段） | 1185 |
| `scripts/stage09a-gate-registry.mjs`（`66-72` 区段） | 95 |

### 3.5 文档

| 路径 | 行数 |
| --- | ---: |
| `docs/product/mvp.md` | 101 |
| `docs/product/capability-inventory.md` | 258 |
| `docs/safety/food-safety.md` | 85 |
| `docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md`（of record） | 734 |
| `docs/plans/2026-09-stage-09p-development-plan.md` | 227 |
| `docs/architecture/decisions/0009-review-acceptance-and-deferral-discipline.md` | 252 |
| `docs/governance/deferral-register.json` | `entries` 22 笔；`schemaVersion: 1` |

### 3.6 第二事实源分支材料（经 `git show`，未 checkout）

| 路径 | 行数 | bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `docs/evidence/stage-09p-m2/m2-post-r7-gap-gate.md` | 323 | 45917 | `0fc31a5787689f1b1683b07fb9aa19eff4ceb81deaa155e4d5ad7e415b17f535` |
| `docs/evidence/stage-09p-m2/wp-o2-command-boundary-entitlement-decision-pack.md` | 438 | 29516 | `239e82c2a800cbff7e3044b41d09f41bed305b1f072cc759527197c9ac25bd1d` |

（两行的行数/bytes/SHA-256 与两份材料各自的归档表登记值一致：gap gate 的 `REPORT_BYTES: 000000045917`、`REPORT_LINES: 000000000323`。）

---

## 4. 未读取 / 未运行（诚实边界）

- **未运行**：Docker、任何重测试套件、任何 migration、任何数据库连接、`manifest:generate`/`manifest:check`、`openapi:generate`、Node/pnpm 产品测试、typecheck/build、Taro/adapter、联网。
- **未修改**：任何源码、任何契约、任何 migration、authorization manifest、generated adapter、OpenAPI、登记表、看板。
- **未创建**：commit / branch / stash / checkout / switch / worktree / push / PR / merge。
- **未读取**：真实用户、健康、家庭、食品或凭据数据；外部网页；`.local/` 以外的过程输入。
- **本批唯一写入**：`docs/evidence/stage-09p-m4a/` 目录与本目录下两份文件（冻结 + 本证据）。

---

## 5. 本设计据以成立的三条硬事实（逐条复算）

1. **脱敏投影结构性丢弃私密硬约束**：`mapRedactedPersonProfile` 只保留 `visibility === "household"`（`services/api/src/database/mappers.ts:245-259`）；`safeOwnerProfileResponseSchema` 类型层排除 `subject_and_owner`（`packages/contracts/src/identity.ts:274-287`）；`householdMemberRedactedViewSchema` 同（`packages/contracts/src/members.ts:243-249`）。**且仓库当前没有「全部 active 档案未脱敏」的批量读方法**（`#loadAuthorizedProfile` 仅 owner/本人，`listPersonProfiles`/`listHouseholdMembers` 在 member 视角对非本人成员返回脱敏投影；`repository.ts:1496-1520,1886,2066`），故冻结要求新增该批量读并以其为唯一约束来源。→ 冻结 §3.5 第 4 条、§6(a)。
2. **`foodConceptId` 是唯一权威 join 键、且实务上为死值**：契约必填（`packages/contracts/src/meals.ts:19`）；仓储写 `?? null`（`repository.ts:1273`）；读回为空即省略（`mappers.ts:310-312`）；列可空（`schema.ts:476`）；按显示名匹配被设计层禁止（`identity.ts:228-230`）。→ 冻结 §6(b)。
3. **快照现状正是被点名的反模式**：`meals.ts:176-177` 的两个单值 vs of record §5.4（`2026-08-...core.md:311-340`）与 line 262 的替换清单；`canonicalJson` 已存在使四段可确定规范化（`packages/domain/src/canonical.ts:70`、`:58`）。→ 冻结 §6(c)，**采纳**四段。

另两条决定冻结形状的硬事实：候选 `hardConstraintCheck.status` 是 `z.literal("passed")`（`meals.ts:150-154`），阻断只能走 `recommendation.outcome = "no_feasible_option"` + 非空 blocker（`meals.ts:220-231`）；生产域求值器 `evaluateHouseholdDishSafety` 因 trust allowlist 为空**恒返回 blocked**（`resolution.ts:311`、`:1957-1965`），故纵切正路径用切片本地确定性规则（冻结 §5.8）。

---

## 6. STOPLINE

> **STOPLINE。** 本证据与其配套冻结文档描述的是**一个尚未获授权的有界合成纵切**的设计面。本批**不**释放真实数据、**不**激活 source、**不**取得 G2 admission、**不**授权纵切范围之外的实现、**不**构成任何里程碑 `Accepted`。
>
> 进入实现的前置：ADR-0009 §8 第 2 项的**有界合成纵切授权**（钉死范围、精确 SHA 与单一交付边界）**且** M-2 已闭合（开发计划 §3.2、§4 第 1 项）。在该授权未签发前，本批保持**设计准备物**；**不得**据此创建 `0005`、改动 authorization manifest、改 contracts/API/client 或开始并行实现。
>
> 若纵切证明引擎无法读未脱敏约束、或无法经 `foodConceptId` join，则**任何**推荐路径不得发布（开发计划 §4 第 5 项）。
>
> 本批「约 30 项开放义务」是**工作计数**，不是验收条件；`24/4/3/8/8/12` 是**说明性候选数量**，不得进入任何验收条件或看板百分比。

---

## 7. POST 记录

- 本批只读 Git 身份核对：`git rev-parse`（HEAD、tree）、`git status --short`（空）、`git cat-file -p`（第二事实源分支）、`wc -l`（材料行数）、`shasum -a 256`（关键文件摘要）、`git show`（第二事实源分支材料，未 checkout）。
- 未做：任何写库、任何测试执行、任何生成物重写、任何分支/提交操作。
- 若后续任一 PRE 身份、材料 hash 或本目录文件内容与本文记录不符，本批交付改报 `BLOCK`，不得继续实施。
