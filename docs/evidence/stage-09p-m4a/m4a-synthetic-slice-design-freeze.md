# M-4a 有界合成纵切 — 设计冻结

- 日期：2026-09-12
- 性质：**设计冻结（design freeze）**，不是实现、不是合同冻结落库、不是 migration 执行。
- 适用设计门禁：[ADR-0009：设计门禁的停止谓词与延迟项纪律](../../architecture/decisions/0009-review-acceptance-and-deferral-discipline.md)（`Accepted`，2026-09-12）§1。
- 对应执行里程碑：开发计划 [09P：开发计划](../../plans/2026-09-stage-09p-development-plan.md) **M-4（有界合成纵切）**的**设计面 M-4a**。
- 上位计划（of record）：[阶段 09P：安全知识治理与确定性产品核心闭环](../../plans/2026-08-stage-09p-safe-deterministic-product-core.md)（Planning Accepted）。两者冲突时以 of record 为准。
- 证据：同目录 [`m4a-synthetic-slice-design-freeze-evidence.md`](m4a-synthetic-slice-design-freeze-evidence.md)。
- 冻结对象：**仅**本纵切需要的四类面——推荐请求契约、两个 HTTP 成功信封、`0005` migration 的 schema、确定性引擎的输出契约——外加三项强制修正的设计落点。其余数据类保持 inactive。

---

## 1. 权限、范围与结论上限

**这是一份为「有界合成纵切」冻结不可并行实现面的设计文件。** 它冻结的是计划 §9.1 点名的、契约/迁移冻结前禁止并行实现的面（`packages/contracts` 公共 DTO、`0005` migration 与 authorization manifest、RLS/复合外键/锁序、稳定 reason/blocker code），范围仅限该纵切。

### 1.1 本文件授权了什么

- 把该纵切的**推荐请求契约**、**meal/recommendation HTTP 成功信封**、**`0005` migration 的 schema（列/键/约束/RLS/ledger-manifest 义务）**、**确定性引擎输出契约**在**设计层**一次定死，使后续实现可以单线写入、不再并行发明形状。

### 1.2 本文件**不**授权什么（结论上限）

本文件**不**构成、也**不得**被读作：

1. **任何真实数据释放**。不激活真实 FoodConcept/allergen/宗教伦理/食品安全/cooking-technique 词表，不导入真实食品事实（[food-safety.md:12-15](../../safety/food-safety.md)）。
2. **任何 source activation**。`0005` 只建**合成**参考表与合成行；不改变 public trust allowlist（其固定为空是安全边界，见 `packages/domain/src/resolution.ts:311`）。
3. **任何 G2 admission**。G2 状态不变。
4. **纵切范围之外的实施准入**。本文件不授权 Shopping（采购）、InventoryEvent 消费路径、做饭/消耗/剩菜、guest 参与者、模型/Agent、计时器、偏好学习；也不授权 `0000`—`0004` 的任何改写。
5. **任何里程碑 Accepted**。实施者只能报 `Implemented`；`Accepted` 只由总控在同一精确 SHA 上复验后给出（ADR-0009 §7；of record §3.5）。
6. **owner 对 ADR-0009 §8 第 2 项的裁定**。有界合成纵切的授权是**产品负责人的决定**，本文件是在该授权下产出的设计准备物；**本文件不自行取得该授权**。若该授权被拒，按开发计划 §4 第 1 项**停止并重新规划**，不得默认前进。
7. **对「产品核心已完成」的任何陈述**。合成纵切通过**不等于**产品核心工作完成（开发计划 §4 第 6 项）。

### 1.3 命名与计数纪律

- 「M-4a」是开发计划的**执行分解标签**，不是新的里程碑。它**不产生**任何 ADR-0009 §4 意义上的新轮次计数起点；本设计线的轮次按 **of-record 里程碑身份（M0—M6）**计数，同一设计线同一里程碑内至多 **3 轮**（ADR-0009 §4；of record §12.3）。
- 本文件中的「约 30 项开放义务」是**工作计数**，不是验收条件；确切计数以各收口记录的逐条登记为准（开发计划 §2；§6 末段）。

---

## 2. PRE 与输入

### 2.1 工作树身份（本文件产出地）

| 项 | 值 |
| --- | --- |
| worktree | `/Users/aipuli/Documents/Projects/meal-agent-lab/.local/worktrees/wp-o3` |
| branch | `codex/stage-09p-wp-o3` |
| HEAD | `62f23bb3d47960f8c875534576b352c64774f4a5` |
| tree | `029069ba3eff6c8d973f2f481184dc7d7f9f2226` |
| 工作树状态 | clean（`git status --short` 为空） |

### 2.2 第二事实源分支身份

| 项 | 值 |
| --- | --- |
| branch | `codex/stage-09p-m2-inventory` |
| HEAD | `41d47ebfa02313e2f388ae1749b54f4cec3f97d8` |
| tree | `ec66e80cec1c89bb1ea6369df2ac7bcdf3d87ead` |
| parent | `41c2e7b5013051201c10365b9f41af00b643fae8` |

该分支未合并、未推送；其 `docs/evidence/stage-09p-m2/` 有 19 个文件，其中本设计读取的两份列为 §2.3。

### 2.3 实际读取的材料（真实行数，按路径）

契约层：

| 路径 | 行数 |
| --- | ---: |
| `packages/contracts/src/meals.ts` | 268 |
| `packages/contracts/src/http.ts` | 134 |
| `packages/contracts/src/api.ts` | 172 |
| `packages/contracts/src/primitives.ts` | 557 |
| `packages/contracts/src/identity.ts` | 341 |
| `packages/contracts/src/members.ts` | 674 |
| `packages/contracts/src/shopping.ts` | 112 |
| `packages/contracts/src/refinement-rules.ts` | 232 |
| `packages/contracts/src/index.ts` | 10 |

服务层：

| 路径 | 行数 |
| --- | ---: |
| `services/api/src/database/schema.ts` | 797 |
| `services/api/src/database/repository.ts` | 2907 |
| `services/api/src/database/mappers.ts` | 390 |
| `services/api/src/database/authorization-manifest.ts` | 2292 |
| `services/api/src/database/authorization-identity.ts` | 206 |
| `services/api/src/database/authorization-projection-sql.ts` | 842 |
| `services/api/src/routes.ts` | 861 |
| `services/api/scripts/stage06-manifest-adapter.ts` | 144 |
| `services/api/migrations/0000_stage_06.sql`（RLS/授权段） | 555（全文） |
| `services/api/migrations/0004_stage_08_final_closeout.sql`（头注释） | 1324（全文） |

领域包：

| 路径 | 行数 |
| --- | ---: |
| `packages/domain/src/index.ts` | 107 |
| `packages/domain/src/canonical.ts` | 367 |
| `packages/domain/src/resolution.ts` | 1969 |
| `packages/domain/src/types.ts` | 665 |

客户端与门禁：

| 路径 | 行数 |
| --- | ---: |
| `apps/client/src/core/command-registry.ts` | 554 |
| `apps/client/src/core/endpoints.ts` | 325 |
| `scripts/check-stage09p-m0-scope.mjs` | 262 |
| `scripts/check-stage09p-m1-scope.mjs` | 599 |
| `infra/docker/run-local-test-smoke.mjs` | 1185 |
| `scripts/stage09a-gate-registry.mjs` | 95 |

文档：

| 路径 | 行数 |
| --- | ---: |
| `docs/product/mvp.md` | 101 |
| `docs/product/capability-inventory.md` | 258 |
| `docs/safety/food-safety.md` | 85 |
| `docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md` | 734 |
| `docs/plans/2026-09-stage-09p-development-plan.md` | 227 |
| `docs/architecture/decisions/0009-review-acceptance-and-deferral-discipline.md` | 252 |
| `docs/governance/deferral-register.json` | 22 笔 `entries`（`schemaVersion: 1`） |

第二事实源分支（`git show codex/stage-09p-m2-inventory:<path>`）：

| 路径 | 行数 | bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `docs/evidence/stage-09p-m2/m2-post-r7-gap-gate.md` | 323 | 45917 | `0fc31a5787689f1b1683b07fb9aa19eff4ceb81deaa155e4d5ad7e415b17f535` |
| `docs/evidence/stage-09p-m2/wp-o2-command-boundary-entitlement-decision-pack.md` | 438 | 29516 | `239e82c2a800cbff7e3044b41d09f41bed305b1f072cc759527197c9ac25bd1d` |

### 2.4 本文件未做的事

- 未运行 Docker、未运行任何重测试套件、未执行任何 migration、未连接数据库。
- **未修改任何源码**，未新增契约、未创建 `0005`、未改动 authorization manifest、未生成 adapter。
- 未创建 commit / branch / stash / push / PR / merge。
- 未读取 `.local/` 以外的外部资料；未读取真实用户、健康、家庭或食品数据。
- 未修改独立本地看板。

---

## 3. 本纵切冻结的契约

### 3.0 冻结原则（先定边界，再定形状）

现有仓库在这四类面上是「半成品」：**实体 DTO 已存在，请求契约与信封不存在**。

- `packages/contracts/src/meals.ts` 全文（1—268）只有实体 schema（`recipeIngredientSchema`、`recipeSchema`、`mealRecipeSelectionSchema`、`mealSchema`、`recommendationCandidateSchema`、`recommendationSchema`），**没有任何 `*RequestSchema`**；全仓 `RecommendationRequest` / `createRecommendation` / `generateRecommendation` 命中 0。对照同类域文件（`packages/contracts/src/inventory.ts:154` 的 `createInventoryLotRequestSchema`、`packages/contracts/src/members.ts:659` 的 `addDietaryConstraintRequestSchema`）均在各自域文件内声明请求。
- `packages/contracts/src/http.ts`（1—134）逐路由导出 `createApiSuccessSchema(...)`，但**没有** meal/recommendation 的成功信封。

因此本节的形状全部**复用既有约定**，不新造包络：

- 成功信封只能经 `createApiSuccessSchema` 生成 `{ ok: true, data, meta }`，`meta` 经 `apiMetaSchema`（`packages/contracts/src/api.ts:110-127`）。
- 新 schema 落在**域文件内**并经既有子路径导出（`packages/contracts/src/index.ts:6` 已 `export * from "./meals.js"`；`packages/contracts/package.json` 的 `exports` 是封闭清单，`./meals` 已登记）。
- 任何新增 refinement 必须登记进 `contractRuleManifest` 并由 `ruleSuperRefine` 绑定（`packages/contracts/src/refinement-rules.ts:14`；`packages/contracts/tests/refinement-rules.test.ts:193-195` 校验绑定集合与 manifest 逐条相等，当前断言 `contractRuleManifest.length === 35`、`contractRuleSchemaBindings.length === 34`、`boundIds.length === 35`）。

以下形状为**设计冻结**，不落库；实现时逐字落地。

### 3.1 推荐请求契约 `generateRecommendationRequestSchema`（落 `packages/contracts/src/meals.ts`）

字段级形状（house Zod 风格，`ruleSuperRefine` 包裹）：

| 字段 | 形状 | 依据 |
| --- | --- | --- |
| `participantProfileIds` | `z.array(personProfileIdSchema).min(1)` | 与 `recommendationSchema.participantProfileIds`（`meals.ts:165`）同形；本餐实际用餐者 |
| `cookProfileId` | `personProfileIdSchema` | 同 `meals.ts:166` |
| `maximumTotalMinutes` | `z.int().positive()` | 同 `meals.ts:167` |
| `purchaseTolerance` | `z.enum(["none", "limited", "allowed"])` | 同 `meals.ts:168` |
| `suggestedDishCount` | `z.int().min(1).max(3)` | 同 `meals.ts:169` |

`strictObject`。**不新增字段**（尤其**不**加入 `inventorySnapshotVersion` 之类的客户端快照断言——快照由服务端在生成时读取并冻结，见 §3.4）。

绑定 refinement（**必须登记**）：

- rule id：`meal.recommendation-request.participants-unique.v1`
- boundary：`generateRecommendationRequestSchema.participantProfileIds`
- enforcement：`runtime-only`
- 语义：`participantProfileIds` 内 `personProfileId` 不得重复。

登记义务（实现级，必须做）：把该 rule 写入 `packages/contracts/src/refinement-rules.ts` 的 `contractRuleManifest`（当前 35 条）并用 `ruleSuperRefine` 绑定，同时把 `packages/contracts/tests/refinement-rules.test.ts:193-195` 的三个断言更新为新的精确计数（**manifest 37 / bindings 36 / boundIds 37**——本节与 §3.2 各新增一条 refinement，共两条，二者都须登记）。**不登记即门禁转红。**

### 3.2 meal 请求契约 `createMealRequestSchema`（落 `packages/contracts/src/meals.ts`）

该纵切有两条路由（§3.5），meal 信封必须可达，因此 meal 请求一并冻结。它是**既有 schema 的薄组合**，不引入新实体：

| 字段 | 形状 | 依据 |
| --- | --- | --- |
| `recommendationId` | `recommendationIdSchema` | `meals.ts:94` |
| `participantProfileIds` | `z.array(personProfileIdSchema).min(1)` | `meals.ts:95` |
| `cookProfileId` | `personProfileIdSchema` | `meals.ts:96` |
| `recipes` | `z.array(mealRecipeSelectionSchema).min(1).max(3)` | `meals.ts:97`、`:83-88` |
| `scheduledFor` | `utcDateTimeSchema` | `meals.ts:107` |
| `expectedSnapshotDigest` | `canonicalSha256DigestSchema`（见 `3.4`） | 确认菜单时重验快照（of record §5.4 末段、§5.5） |

`strictObject` + 一个 refinement：`participantProfileIds` 唯一，rule id `meal.create-request.participants-unique.v1`（同样登记入 manifest 与测试计数；与 §3.1 合计新增两条 refinement，故 §3.1 的精确计数为 manifest 37 / bindings 36 / boundIds 37）。

服务端在确认时重验：请求携带的 `expectedSnapshotDigest` 必须等于已持久化 Recommendation 的 `snapshot.snapshotDigest`，且四段 revision 与当前事实一致，否则返回稳定冲突（`409 CONFLICT`，见 `packages/contracts/src/api.ts:31-50`），**不**创建 Meal。

### 3.3 两个 HTTP 成功信封（落 `packages/contracts/src/http.ts`）

```text
recommendationSuccessSchema = createApiSuccessSchema(recommendationSchema)
mealSuccessSchema           = createApiSuccessSchema(mealSchema)
```

- 二者均从既有实体 schema 生成，`meta` 经 `apiMetaSchema`（`api.ts:110-127`），**不自造包络**。
- 写命令的成功信封**不**内嵌 idempotency 元数据以外的自定义字段；idempotency 元数据仅在幂等写命令出现（`api.ts:99-113`）。
- 错误响应继续复用 `apiErrorSchema`（`api.ts:59-83`）与 routes 的 `commonErrorResponses`（`routes.ts:141-152`）。**注意**：受约束家庭的「阻断」**不是**错误——它是 `ok: true` 的成功结果（`outcome: "no_feasible_option"`），见 §5.7。

### 3.4 `recommendationSchema` 的快照字段（更正 c 的落点）

**决定：采用 of record §5.4 的四段快照 digest，替换两个单值字段。**

- 现状是反模式：`packages/contracts/src/meals.ts:176-177` 只有单值 `inventorySnapshotVersion` / `constraintSnapshotVersion`（`versionSchema = z.int().nonnegative()`，`primitives.ts:140`）。of record **明列**「单值 `inventorySnapshotVersion`、单值 `constraintSnapshotVersion`」为**要替换的反模式**（`2026-08-...core.md:262`），并在 §5.4（`:311-340`）规定统一四段快照。
- 因此 **`recommendationSchema` 删除** `inventorySnapshotVersion` / `constraintSnapshotVersion` 两个字段，**新增** `snapshot: recommendationSnapshotSchema`。

`recommendationSnapshotSchema` 形状（四段 + 汇总 digest）：

| 段 | 形状 |
| --- | --- |
| `inventory` | `{ lots: [{ lotId, lotVersion, foodConceptRevision, safetyAssessmentRevision }]（按 lotId 排序）, inventoryDigest }` |
| `constraints` | `{ profiles: [{ participantProfileId, profileVersion, constraintSetDigest }]（按 participantProfileId 排序）, mappingReleaseId, constraintDigest }` |
| `recipes` | `{ recipes: [{ recipeId, recipeVersion, contentDigest, datasetReleaseId }]（按 recipeId 排序）, recipeDigest }` |
| `policies` | `{ foodConceptReleaseId, allergenReleaseId, religiousEthicalReleaseId, foodSafetyReleaseId, techniqueReleaseId, recommendationEngineVersion, policyDigest }` |
| `snapshotDigest` | `canonicalSha256DigestSchema` |

- `canonicalSha256DigestSchema`：新增于 `packages/contracts/src/primitives.ts`，形状 `z.string().regex(/^sha256:[0-9a-f]{64}$/)`。该格式与仓库既有口径一致（`packages/domain/src/canonical.ts:58`、`scripts/check-stage09p-m1-source-pack.mjs:28`）。
- 规范化：**四段与汇总**一律使用既有 `canonicalJson`（`packages/domain/src/canonical.ts:70`，对象键按 UTF-8 字节序排序，`compareUtf8` `canonical.ts:24`），再以 `sha256:` 前缀小写十六进制输出。**不另造 canonical 规则。**
- `constraintSetDigest` **必须**对成员的**未脱敏**约束集计算（见 §6(a)）；它绑定私密约束而**不暴露**其原文——这与 of record §5.3「推荐只保存 constraint digest 和必要 blocker code」（`2026-08-...core.md:305`）一致。

实现义务：`packages/contracts/tests/contracts.test.ts:1243-1244` 现以两个单值字段构造 Recommendation，必须同步改写；`services/api/openapi/stage-08.openapi.json:5238-5278` 含这两个字段，必须 `pnpm --filter @meal-agent/api openapi:generate` 重生成（`services/api/package.json:22-23`）。

> **为什么不选「登记为延迟」**：of record §5.1 已把单值形态列为**要替换**的反模式（`2026-08-...core.md:262`），§5.4 是其规范替代；ADR-0009 §3 的硬边界禁止把**已知的、未修复的**规范性缺陷递延，且 §5.4 四段的 canonical 形式可由既有 `canonicalJson` 完整确定，不存在「冻结错误规范化」的风险。故本轮**采纳**，不作递延。

### 3.5 路由（落 `services/api/src/routes.ts`）

| 路由 | method | 状态码 | 信封 | 契约 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/households/{id}/recommendations` | POST | 201 | `recommendationSuccessSchema` | `generateRecommendationRequestSchema` |
| `POST /api/v1/households/{id}/meals` | POST | 201 | `mealSuccessSchema` | `createMealRequestSchema` |

两条都是幂等写路由，因此**两条都**必须：

1. 在 `services/api/src/database/repository.ts` 的 `normalizedRoutes`（`:233-253`）与 `idempotencyPolicies`（`:258-289`）**双登记**，策略均为 `{ kind: "full" }`（理由：response 不含成员私密约束原文，只含 digest 与 blocker code，见 §3.4），并在 `#runIdempotent` 传 `statusCode: 201`（对照 `:1202-1214`、`:938`）。
2. 加入 `services/api/src/routes.ts:67-92` 的 `ApiOperations` `Pick<ApiRepository, ...>` 白名单，并按 `routes.ts:316-340` 的形状声明（`...protectedRoute`、`params`、`headers: idempotencyHeadersSchema`、`body`、`response: { 201, ...commonErrorResponses }`）。
3. 在 `apps/client/src/core/endpoints.ts`（`:67-323`）逐路由类型化封装（envelope 直接引用 `@meal-agent/contracts/http` 的新 `*SuccessSchema`），并在 `apps/client/src/core/app-services.ts` 暴露。
4. **约束读路径（结构性安全控制）**：`POST .../recommendations` 构造 `MenuGenerationInput` 时，档案约束**必须**经 §6(a) 指定的**全量未脱敏批量读**取得，**不得**经成员脱敏投影构造——即**不得**复用 `listPersonProfiles` / `listHouseholdMembers`（member 视角对非本人成员返回 `mapRedactedPersonProfile` 的投影，`repository.ts:2066`、`:1886`）或任何 `mapRedactedPersonProfile`（`mappers.ts:245-259`）的输出。两条路由只要求 `meal:write`（角色可为 member，非 owner），而 `#loadAuthorizedProfile`（`repository.ts:1496-1520`）仅授权 owner/本人、仓库**当前没有**「全部 active 档案未脱敏」的批量读方法，故**必须新增**一条按 `meal:write` 授权、返回**全部 active 档案未脱敏约束**的仓储读方法，并以其作为唯一允许的约束来源。脱敏投影会被 §6(a) 的类型商标在类型层挡下。

**能力（capability）**：两条路由均要求既有 capability **`meal:write`**（`packages/contracts/src/identity.ts:186-193`；`repository.ts:624,643-651` 的 `#bootstrapHousehold(..., requiredCapability)`）——**本纵切不新增 capability 枚举成员**。是否需要专用 `recommendation:write` 登记为未决（§10）。

`normalizedRoutes` 建议键名与值：

```text
generateRecommendation: "/api/v1/households/{id}/recommendations"
confirmMeal:            "/api/v1/households/{id}/meals"
```

### 3.6 客户端

- 新增**第 16 条 typed 写命令**：`recommendation.generate`，落在 `apps/client/src/core/command-registry.ts` 的 `ClientCommandDefinitions`（`:57-175`），按同一形状（`payload` + `outcome`）追加，须同时注册 handler + reconciler + commandLabel（对照 `:228-320`、`:364-472`）。
- 新增**第六页**：现 `apps/client/src/pages/` 有 5 个（households / inventory / login / members / profile），第 6 页为「今天吃什么」（提交本餐条件 → 展示候选、缺少项与 blocker）。
- **meal 两条路由的客户端接线不在本纵切**：`POST .../meals` 在本纵切内作为服务端路由存在（供 HTTP/E2E 与 `meals`/`meal_recipes` 建表路径使用），其 typed 客户端命令的接线登记为未决（§10），因此客户端 registry 的增量恰好为 **1 条（第 16 条）**。这与开发计划 M-4 的「第十六条 typed 写命令」（`2026-09-...development-plan.md:124`）一致。

### 3.7 命名不冲突核实

对拟新增标识符逐一全仓检索（`packages`、`services`、`apps`、`scripts`、`docs`），命中数均为 **0**：`generateRecommendationRequestSchema`、`createMealRequestSchema`、`recommendationSnapshotSchema`、`recommendationSuccessSchema`、`mealSuccessSchema`、`canonicalSha256DigestSchema`、`generateMenuCandidates`、`menuCandidateReasonCodes`、`menuBlockerCodes`、`recommendationSnapshot`。**不重名、不覆盖。**

---

## 4. `0005` migration 的 schema

### 4.1 文件名与追加纪律

- 冻结文件名：**`0005_stage_09p_synthetic_slice.sql`**（落 `services/api/migrations/`）。
- of record §6（`2026-08-...core.md:384-390`）登记文件名模式 `0005_stage_09p_*.sql`，并给出候选名 `0005_stage_09p_knowledge_inventory.sql`；**该候选名是 M2 提案期的占位**，只命名了本纵切五族表中的两族。of record 明定：「文件名和精确内容必须在 **M1 Accepted、inventory/domain/contracts 设计冻结后由总控确认**」（`2026-08-...core.md:388`）。本冻结据此把文件名**精确字节提案**定为 `0005_stage_09p_synthetic_slice.sql`（此名是 manifest ledger state key 的组成字节，`authorization-manifest.ts:1752-1758`）。该提案的**最终确认权在总控**，且前置为 M1 已 Accepted、inventory/domain/contracts 设计冻结；在该确认落地前不得写入该文件，确认后其精确字节即冻结、实现时不得再改。
- `0000`—`0004` **永久冻结、字节不得改动**：migrate 按 SHA-256 比对已应用文件，漂移即抛错（`migrate.ts:453-459`、`:511-531`；`0004_stage_08_final_closeout.sql:3-4` 头注释自陈）。
- `0005` 在**单一事务**内执行（`migrate.ts:472-484`）：**不得**含 `BEGIN`/`COMMIT`/`ROLLBACK`，**不得**用 `CREATE INDEX CONCURRENTLY`。
- 以 `SET ROLE meal_agent_migrator` 执行（`migrate.ts:57-58,421-424`）：新建对象 owner 自动为 `meal_agent_migrator`。

### 4.2 表清单（7 张新表 + 1 条 FK 绑定）

本纵切**只**建下列表；其余数据类保持 inactive。

**A. 全局只读参考表（与 `users`/`auth_identities`/`sessions` 同姿态：不开 RLS）**

| 表 | 范围 | 依据 |
| --- | --- | --- |
| `food_concepts` | 全局只读 | of record §5.3「FoodConcept…全局只读参考数据」（`:303`）；`inventory_lots.food_concept_id` 早已存在但**无目标表也无 FK**（`schema.ts:476`；`0000_stage_06.sql:117-120`） |
| `recipes` | 全局只读（Recipe revision） | of record §5.1、§5.3（`:260`,`:303`）；`meals.ts:28-81` 的实体形状 |
| `recipe_ingredients` | 全局只读 | `meals.ts:18-25` 的 `recipeIngredientSchema` |

**B. household 私有表（ENABLE + FORCE RLS + household 策略）**

| 表 | 依据 |
| --- | --- |
| `recommendations` | of record §5.3（`:304`）；`meals.ts:160-268` |
| `recommendation_candidates` | `meals.ts:138-155` |
| `meals` | `meals.ts:90-136` |
| `meal_recipes` | `meals.ts:83-88` |

**C. 既有表上的绑定（additive，不改写 `0000`—`0004` 字节）**

- `ALTER TABLE inventory_lots ADD CONSTRAINT inventory_lots_food_concept_foreign FOREIGN KEY (food_concept_id) REFERENCES food_concepts(id)`。
- 依据：of record §6 明定 `0005` 候选范围覆盖「FoodConcept 绑定和必要 inventory 扩展」（`:390`）；`food_concept_id` 列已存在（`schema.ts:476`），本纵切**只加 FK**，不重写 `inventory_lots`。

### 4.3 列的冻结（键与约束级；类型细节属实现级，见 §4.7）

**`food_concepts`（全局只读）**

- 键：`id uuid PRIMARY KEY`（小写 UUIDv7，`primitives.ts:77-82`；DB 侧实现 `check` 以保证小写）。
- 列：`display_name varchar(120) NOT NULL`、`revision integer NOT NULL`（`DEFAULT 1`，`check ≥ 1`）、`allergen_codes jsonb NOT NULL`（`jsonb_typeof = 'array'`）、`may_contain_allergen_codes jsonb NOT NULL`、`created_at`、`updated_at`。

**`recipes`（全局只读）**

- 键：`id uuid PRIMARY KEY`；`unique (id, version)`（供 `meal_recipes`/`recipe_ingredients` 复合 FK）。
- 列（镜像 `meals.ts:28-81`）：`version integer NOT NULL CHECK > 0`、`status varchar(32) CHECK IN ('draft','reviewed','retired')`、`title varchar(160)`、`description varchar(1000) NULL`、`servings numeric NOT NULL CHECK > 0`、`dish_role varchar(32) CHECK IN ('staple','main','vegetable','soup','side')`、`steps jsonb`、`required_equipment jsonb`、`active_minutes integer CHECK ≥ 0`、`total_minutes integer CHECK > 0`、`difficulty varchar(32) CHECK IN ('beginner','intermediate','advanced')`、`source jsonb`、`reviewed_at timestamptz NULL`、`created_at`、`updated_at`。

**`recipe_ingredients`（全局只读；更正 b 的结构落点）**

- 键：`id uuid PRIMARY KEY`；`unique (recipe_id, recipe_version, id)`；`foreignKey (recipe_id, recipe_version) → recipes(id, version)`。
- 列（镜像 `meals.ts:18-25`）：**`food_concept_id uuid NOT NULL`** + `foreignKey → food_concepts(id)`、`display_name varchar(120) NOT NULL`、`quantity jsonb NOT NULL`、`optional boolean NOT NULL`、`allergen_codes jsonb NOT NULL`、`may_contain_allergen_codes jsonb NOT NULL`、`position integer NOT NULL CHECK ≥ 1`。
- **这是强制更正 (b) 的**结构**落点**：`food_concept_id` **NOT NULL 且有 FK**，使「按 `displayName` 匹配库存」在 schema 层不可达；`display_name` 仅作展示文本，非权威。

**`recommendations`（household 私有）**

- 键：`id uuid PRIMARY KEY`；`unique (household_id, id)`（供复合 FK）；`household_id uuid NOT NULL REFERENCES households(id)`。
- 列（镜像 `meals.ts:160-181` + §3.4）：`outcome varchar(32) CHECK IN ('options','no_feasible_option')`、`participant_profile_ids jsonb NOT NULL`、`cook_profile_id uuid NOT NULL`、`maximum_total_minutes integer NOT NULL CHECK > 0`、`purchase_tolerance varchar(16) CHECK IN ('none','limited','allowed')`、`suggested_dish_count integer NOT NULL CHECK BETWEEN 1 AND 3`、`blocker_codes jsonb NOT NULL`、`assumptions jsonb NOT NULL`、`preselected_candidate_ids jsonb NOT NULL`（镜像 `meals.ts:171-173` 的 `preselectedCandidateIds: z.array(recommendationCandidateIdSchema).max(3)`，`CHECK jsonb_array_length ≤ 3`；候选经 `recommendation_candidates` 子表持久化，此列**单独保存**顺序化预选 id 数组，回读时原样还原该必填字段，**不**由 `recommendation_candidates.position` 推导）、`snapshot jsonb NOT NULL`（四段 + `snapshotDigest`，替代原两个单值列）、`recommendation_policy_version varchar(100) NOT NULL`、`created_at`、`expires_at`、`version integer NOT NULL CHECK ≥ 0`。

**`recommendation_candidates`（household 私有）**

- 键：`id uuid PRIMARY KEY`；`unique (household_id, id)`；`foreignKey (household_id, recommendation_id) → recommendations(household_id, id)`。
- 列（镜像 `meals.ts:138-155`）：`recommendation_id uuid NOT NULL`、`recipe_id uuid NOT NULL`、`recipe_version integer NOT NULL`、`servings numeric NOT NULL`、`dish_role varchar(32) NOT NULL`、`active_minutes integer NOT NULL CHECK ≥ 0`、`total_minutes integer NOT NULL CHECK > 0`、`missing_food_concept_ids jsonb NOT NULL`（`foodConceptId` 数组）、`planned_inventory_lot_ids jsonb NOT NULL`、**`reason_codes jsonb NOT NULL` + `CHECK jsonb_array_length(reason_codes) ≥ 1`**、`assumptions jsonb NOT NULL`、**`hard_constraint_check jsonb NOT NULL`**（`CHECK hard_constraint_check->>'status' = 'passed'`）、`position integer NOT NULL`。

**`meals`（household 私有）**

- 键：`id uuid PRIMARY KEY`；`unique (household_id, id)`；`household_id uuid NOT NULL REFERENCES households(id)`；`recommendation_id uuid NULL`。
- 列（镜像 `meals.ts:90-136`）：`participant_profile_ids jsonb NOT NULL`、`cook_profile_id uuid NOT NULL`、`status varchar(32) CHECK IN ('draft','confirmed','shopping_required','ready','cooking','completed','cancelled')`、`scheduled_for timestamptz NOT NULL`、`snapshot jsonb NOT NULL`（确认时的四段快照）、`created_at`、`updated_at`、`version integer NOT NULL CHECK ≥ 0`。

**`meal_recipes`（household 私有）**

- 键：`id uuid PRIMARY KEY`；`unique (household_id, id)`；`foreignKey (household_id, meal_id) → meals(household_id, id)`。
- 列（镜像 `meals.ts:83-88`）：`meal_id uuid NOT NULL`、`recipe_id uuid NOT NULL`、`recipe_version integer NOT NULL`、`servings numeric NOT NULL`、`position integer NOT NULL`。

### 4.4 RLS 姿态

沿用仓库既有两姿态（`0000_stage_06.sql:392-403` 对 6 张 household 表 `ENABLE` + `FORCE ROW LEVEL SECURITY`；`:405-544` 以 `meal_agent_private.app_household_id()` / `app_user_id()` / `has_active_membership()` 为谓词建策略；`users`/`auth_identities`/`sessions` 无 RLS，靠 app 授权与代码过滤，见 `capability-inventory.md:193`）：

- **全局只读表 `food_concepts` / `recipes` / `recipe_ingredients`：不 `ENABLE ROW LEVEL SECURITY`**（与 `users` 同姿态），仅由 app 表级 SELECT 授权与代码过滤保护。
- **household 私有表 `recommendations` / `recommendation_candidates` / `meals` / `meal_recipes`：`ENABLE` + `FORCE ROW LEVEL SECURITY`**，并按 `0000` 样例（`:455-476` 的 `inventory_lots_*`）逐表建策略：
  - SELECT / INSERT：`USING / WITH CHECK (household_id = meal_agent_private.app_household_id() AND meal_agent_private.has_active_membership(household_id))`；
  - `meals` 另加 UPDATE 策略（状态迁移）；`recommendations` / `recommendation_candidates` / `meal_recipes` 本纵切只读+插入，不加 UPDATE。

### 4.5 `0005` 的 ledger 与 authorization manifest 义务（完整清单）

授权由 **ledger 感知、`(ledger, phase)` 键控**的 manifest 描述（`authorization-manifest.ts:15-57`；state key = 按 UTF-8 字节序排序的 migration 文件名数组 + `phase`，`authorizationStateKey` `:1752-1758`）。创建任何 relation 都同时触发下列**全部**义务：

1. **新增 ledger 行**：`0005_stage_09p_synthetic_slice.sql` 作为唯一新文件；migrate 对其字节取 SHA-256 并写入 `drizzle.__meal_agent_migrations(name, hash)`（`migrate.ts:34-41,464-469`）。**不手工写库**——文件落盘后由 migrate 写入。
2. **新增两个 exact-`(ledger, phase)` state，并原样保留两个旧 state**：
   - 保留 `[0000…0004] × containment`（`authorization-manifest.ts:795-802`）与 `[0000…0004] × final`（`:1219-1226`）；
   - 新增 `[0000…0005] × containment` 与 `[0000…0005] × final`。**只加一个即 fail closed**（of record §6 第 3、4 条，`2026-08-...core.md:396-397`）。
3. **逐条登记新 relation 的固定授权**：
   - `containment`：**只有 app 的 relation 授权**，**不得**出现任何表级 backup SELECT（`authorization-manifest.ts:943-1041` 对 `:1357-1501`）。
   - `final`：上述 + **每个新 relation 一条 `meal_agent_backup` SELECT**（`authorization-manifest.ts:1373-1438` 的每表两行模式）。
   - 全局只读表给 app **仅 SELECT**；household 私有表给 app SELECT + INSERT（`meals` 另加 UPDATE）。权限取值必须是闭集内的子集（relation 九项、routine 仅 EXECUTE，`authorization-identity.ts:74-79,149-166`）。
   - **每个 state 另有第五个数组 `effective`**（四个 state 各一，`authorization-manifest.ts:407,695,1107,1585`），必须**逐条**为新 relation 补期望：`containment` 每张新表一条 `meal_agent_app` 有效权限行；`final` 每张新表再各加一条 `meal_agent_backup` 的 `SELECT` 行（对照 `:1116-1152` 与 `:1590-1625` 的每表两行模式）。缺任何一条即落到 verify 的 `unexpected effective` 分支 fail closed（`authorization-manifest-sql.ts:309-335` 的 `allowed_effective` 与 `effective_regulated` 全外连接）。
4. **routine 指纹**：本纵切**不新增任何 `SECURITY DEFINER` routine**（引擎是应用侧纯 TS，不在 DB），因此两个新 state 的 `routines` 必须是 `meal_agent_private` 现有 routine 集合的**逐条精确副本**（owner/`SECURITY DEFINER`/`proconfig`/`bodyDigest`；对照 `authorization-manifest.ts:1227-1355`）。漏登/漂移在任何 mutation 之前 fail closed（`authorization-policy-sql.ts:466-504`）。
5. **`defaults` / `defaultEffective`**：`final` 的 defaults 块（`authorization-manifest.ts:1503-1521`）含 `{"objtype":"r","scope":"public","grantee":"meal_agent_backup","privileges":["SELECT"]}` 物理行，会使新建 public 表**自动**带上 backup SELECT；因此**必须**把每条新 public 表的 backup SELECT 逐条登进 `final.grants`，否则 verify 的全外连接判 `unexpected drift`（`authorization-manifest-sql.ts:281-345`）。
6. **重生成 4 个 generated adapter** 并过 `manifest:check`：其中**只有** `infra/docker/postgres/sql/database/generated/authorization-converge.generated.sql` 与 `authorization-verify.generated.sql` 会变（二者按 `(ledger, phase)` state 渲染）；`authorization-projection.generated.sql` **不变**——投影 adapter 只取 manifest 的 `managedSchemas`/`deniedRoutines`/`principals.owner`，完全不含 states/grants（`authorization-projection-sql.ts:335-347,743-803`）；`0000-object-manifest.generated.sql` 同样保持不动（它只在 0000-only 状态运行，`stage06-manifest-sql.ts:487-571`；`migrate.ts:189-203,544-549`）。四个 adapter 清单见 `stage06-manifest-adapter.ts:40-64`。命令：`pnpm --filter @meal-agent/api manifest:generate` 后 `manifest:check`（`services/api/package.json:20-21`）。
7. **更新硬编码 ledger 的单测**：`services/api/tests/unit/stage06-manifest.test.ts` 现断言 `states.length === 4` 与 `len(ledger) === 5` 的 mutation，须改为 6 / 6（对照 `:338-352`、`:1199-1223`）。
8. **`0000` 对象 manifest 保持不动**：它是对 0000-only 的精确集合比对，`0005` 不得扩展它，也不得让它在 `0005` 之后再被运行（`stage06-manifest-sql.ts:547-571`）。

### 4.6 N-1 恢复边界

- **N-1 = `0004` 的全合成 archive**。固定流程（of record §6，`2026-08-...core.md:392-414`）：
  ```text
  校验 archive SHA/TOC
  → pg_restore(0004)
  → containment(0004)
  → db:migrate(0005)
  → final grants(0005)
  → ready / catalog / RLS / ACL / data final verify
  ```
- `state_key` 由**已应用 ledger**（`drizzle.__meal_agent_migrations`）与 phase 推导（`authorization-converge.generated.sql:38-42`、`authorization-verify.generated.sql:39-42`）。因此**真正的 N-1 验证**（`0004` archive）恢复后、migrate 之前的 containment 相见到的 ledger 是 `[0000…0004]`（命中既有 `[0000…0004] × containment` state），migrate 应用 `0005` 之后 final 相见到的 ledger 是 `[0000…0005]`（命中新增 `[0000…0005] × final`）。而 `[0000…0005] × containment` state 之所以也必需，是因为存在 **ledger 已到 `[0000…0005]` 时先跑 containment** 的路径（例如备份取自应用 `0005` 之后的最新安装、再做同 ledger round-trip，`run-local-test-restore-drill.mjs:266-294`）。of record §6 第 3、4 条要求**两个**新 state 同时存在，二者不可互相替代。
- **实现义务（真实 `0004` N-1 archive 的产出）**：要得到 `0004` 的 N-1 archive，备份必须在 ledger 恰为 `[0000…0004]` 时进行（即写入 `0005` **之前**）；`state_key` 取自已应用 ledger，故**在应用 `0005` 之后**做的备份永远产生不出 `0004` 的 containment 相。当前演练以 `runFreshInstallChain` → `performBackup` 备份**最新安装**（`run-local-test-restore-drill.mjs:75`、`:186`），`0005` 期会得到 `[0000…0005]` 而非 `[0000…0004]`，因此该演练必须改造为在 `0004` 处取备份，否则不构成 of record §6 第 5、6 条要求的 `0004` N-1 证据。
- checksum 漂移、缺 ledger 状态、缺 containment manifest 或多余权限**全部 fail closed**；失败整体回滚；**不提供 down migration**，只允许 roll-forward（`2026-08-...core.md:410-412`）。
- 后续每个 migration 重建自己的 N-1 证据，不得只沿用 `0005` 的报告（`2026-08-...core.md:414`）。

### 4.7 设计级冻结 / 实现级不冻结（分界）

**本冻结固定**：`0005` 文件名、两个新 `(ledger, phase)` state 的存在与相对 `[0000…0004]` 的保留、各新表的 RLS 姿态（§4.4）、app/backup 授权集合的**语义**（哪些表给 SELECT / INSERT / UPDATE，backup 仅 final）、是否新增 routine（否）、`0000` 对象 manifest 不动、N-1 以 `0004` 为基准。

**不进入冻结（实现级必需动作）**：精确列类型/长度/约束字面量、索引集合、`check` 表达式的写法、`manifest:generate` 重生成（§4.5 第 6 条）、把硬编码 ledger 单测从 4/5 更新为 6/6（§4.5 第 7 条）、同步 `services/api/src/database/schema.ts` 镜像（现镜像全部 11 张表，见 `schema.ts:785-797`；新表须加进同一聚合，否则 ORM/类型层与库不一致）。

### 4.8 实现级门禁副作用（必须记录）

- `0005` 建了 public 表后，`infra/docker/m4-lifecycle.mjs:414-426` 的 `expectedLedgerFromDisk` 与本机恢复演练会看到新 ledger 项；`0005` 的 N-1 证据必须随之重建。
- `infra/docker/run-local-test-smoke.mjs:166-179` 的 `expectedRowSecurity` 是对 `public`/`drizzle`/`meal_agent_private` 全部 relation 的**精确集合 + enable/force** 比对（`:748-751` 现场读取、`:761-768` `JSON.stringify` 全等才 pass），并写死日志 `all 12 tables`（`:770`）。`0005` 新建 7 张表后该映射必须同步扩展——4 张 household 私有表 → `true:true`、3 张全局只读表 → `false:false`（共 19 键），否则已注册的 09A 门禁 `local-test-smoke`（`scripts/stage09a-gate-registry.mjs:66-72`）必然转红；日志表数亦须同步。
- 本纵切**不触碰** `check-stage09p-m0-scope.mjs` 的 `0000` 对象 manifest 路径。

---

## 5. 引擎的输出契约

### 5.1 引擎位置与纯函数边界

- 落点：**新增 `packages/domain/src/menu.ts`**，经 `packages/domain/src/index.ts` 导出。依据：of record §5.2 明定 `packages/domain` 负责「hard constraint 与食品安全确定性评估」「菜谱份量缩放、候选组合和排序」「稳定 reason/blocker code」（`2026-08-...core.md:271-286`），且 §9.1 把 `packages/domain` public API 与 reason code 列为**必须单线冻结**面（`:470-471`）。
- 纯函数：`generateMenuCandidates(input: MenuGenerationInput): MenuGenerationResult`——**无 I/O、无 Fastify、无 Drizzle、无 Taro、无模型 SDK、无副作用**（`2026-08-...core.md:280-286`）。

**门禁义务（实现级，必须做；这是一次需评审的门禁变更，不是自由新增）**：

- `scripts/check-stage09p-m0-scope.mjs:5-13` 的 `MODULES` 是 domain `src/` 的**精确集合比对**（`:105`），新增 `menu.ts` 必须把 `"menu.ts"` 加入该白名单。
- `packages/domain/src/index.ts` 被 `scripts/check-stage09p-m1-scope.mjs:78` 的 `NON_REPAIR_SNAPSHOT` **SHA-256 钉死**；domain package.json 的 `exports` 只允许单一 `.` 子路径（被 `check-stage09p-m0-scope.mjs:148` 钉死），因此引擎**必须**经 `index.ts` 导出 → 该钉死值须随之更新。
- `scripts/check-stage09p-m1-scope.mjs:61` 的 `STAGE09P_M1_M0_TCB` 又钉死了 `scripts/check-stage09p-m0-scope.mjs` 自身的 SHA-256 → 上一条 `MODULES` 变更会连带触发该 TCB 钉死的更新。
- **引擎不得修改 `types.ts` 与 `resolution.ts`**：二者分别被 `check-stage09p-m1-scope.mjs:79`（`NON_REPAIR_SNAPSHOT`）与 `:85`（`REPAIRED_SHA256`）钉死。reason/blocker code 的新闭集因此放 `menu.ts`，**不**放 `types.ts`。
- 若新增 domain 测试文件，还须同步 `check-stage09p-m1-scope.mjs` 的钉死集合与 domain package.json 的 `scripts`。

### 5.2 输入（`MenuGenerationInput`，domain 内部值，非 DTO）

| 输入 | 内容 |
| --- | --- |
| 参与者与厨师 | `participantProfileIds`、`cookProfileId`、`cookSkill ∈ {none,beginner,intermediate,advanced}` |
| 条件 | `maximumTotalMinutes`、`purchaseTolerance`、`suggestedDishCount` |
| 库存 | 只含 household 的 active lots：`{ lotId, foodConceptId \| null, quantity, safetyStatus ∈ {eligible,blocked,unknown}, version, safetyPolicyVersion }` |
| 食谱 | active recipe revisions + 其 ingredients：`{ recipeId, recipeVersion, totalMinutes, activeMinutes, difficulty, servings, contentDigest, ingredients:[{ foodConceptId \| null, displayName, optional, allergenCodes, mayContainAllergenCodes }] }` |
| 约束 | **全部 active 档案**的**未脱敏**约束：`{ profileId, status, constraints:[{ kind, enforcement, mappingStatus, allergenCodes, foodConceptIds }] }`（`mappingStatus` 取值同 `identity.ts:230`；其未映射的 fail-closed 语义见 §5.5 第 5 条） |
| 版本 | `recommendationEngineVersion`、合成 release 标识 |

**输入类型刻意不含 `visibility` 字段**（引擎自身不做可见性判断，也不得据此过滤）。**但该省略本身不是安全控制**：脱敏发生在**调用方的服务端读路径**上，输入里没有 `visibility` 既不能阻止上游先做脱敏投影，也不会让引擎察觉约束集不完整。**真正的结构性控制是读路径**：调用方**必须**经 §6(a) 指定的**全量未脱敏批量读**构造约束集，**不得**经成员脱敏投影（`listPersonProfiles` / `listHouseholdMembers` 的 member 视图、`mapRedactedPersonProfile`）构造（见 §3.5 第 4 条、§6(a)）；§6(a) 另以**类型商标（brand）**使脱敏投影在**类型层**不可喂入引擎。引擎内部对 `status !== "active"` 的档案按既有语义排除（对照 `resolution.ts:732,772`）。引擎另做完整性 fail-closed：任一 `status === "active"` 档案的 `constraints` 缺失（非数组）即记 `menu.blocked.input_invalid`，**不得**当作「无约束」放行。

### 5.3 输出

输出**就是** `recommendationSchema` 的形状（`meals.ts:160-181`，快照字段改按 §3.4）。逐字段落点：

| 字段 | 引擎语义 |
| --- | --- |
| `outcome` | `"options"` 当且仅当通过全部硬过滤的候选数 ≥ `suggestedDishCount`；否则 `"no_feasible_option"` |
| `participantProfileIds` / `cookProfileId` / `maximumTotalMinutes` / `purchaseTolerance` / `suggestedDishCount` | 原样回写请求 |
| `candidates` | §5.5/§5.6 产出的候选，`outcome: "no_feasible_option"` 时必须为空 |
| `preselectedCandidateIds` | `outcome: "options"` 时 = 排序后前 `suggestedDishCount` 个候选 id，且长度**必须**等于 `suggestedDishCount`（实体 refinement 强制，`meals.ts:196-207`） |
| `blockerCodes` | `outcome: "no_feasible_option"` 时非空（`meals.ts:220-231`） |
| `assumptions` | 引擎的确定性假设（如「未知日期 lot 按不可覆盖处理」） |
| `snapshot` | §3.4 四段 + `snapshotDigest` |
| `recommendationPolicyVersion` | = 引擎的冻结版本常量 |

**候选形状（`recommendationCandidateSchema`，`meals.ts:138-155`）**逐字段：

| 字段 | 引擎语义 |
| --- | --- |
| `id` | 新生成的 `recommendationCandidateIdSchema` |
| `recipeId` / `recipeVersion` / `servings` / `dishRole` / `activeMinutes` / `totalMinutes` | 取自 recipe revision |
| `missingFoodConceptIds` | §5.4 的缺项（`foodConceptId` 数组，已排序去重） |
| `plannedInventoryLotIds` | 覆盖该食谱所需项的 lot id（已排序） |
| `reasonCodes` | §5.6 的候选 reason 闭集，**min 1**（实体已强制，`meals.ts:148`） |
| `assumptions` | 该候选的假设 |
| `hardConstraintCheck` | `{ status: "passed", policyVersion, checkedAt }`——**`status` 是 `z.literal("passed")`**（`meals.ts:150-154`）：引擎**只在硬检查确证通过时**才构造候选 |

### 5.4 缺项计算（仅经 `foodConceptId`）

- 对食谱的**每个** ingredient：覆盖当且仅当 household 存在 active lot 满足 `lot.foodConceptId === ingredient.foodConceptId` **且** `lot.safetyStatus === "eligible"` **且**数量满足需求量。`unknown`/`blocked` 的 lot **不计覆盖**（fail closed，与 [food-safety.md:35](../../safety/food-safety.md) 的「已过期或状态未知的高风险食材默认不进入候选」一致）。
- `missingFoodConceptIds` = 未被覆盖的 ingredient `foodConceptId` 集合，**按 UTF-8 字节序排序去重**。
- **任何 ingredient 的 `foodConceptId` 为空 → fail closed**：该食谱**不产生候选**，记 blocker `menu.blocked.food_concept_unresolved`。**禁止**退化为 `displayName` 字符串匹配（见 §6(b)）。

### 5.5 硬约束检查（更正 a 的落点）

引擎对每道候选食谱、在读取**未脱敏**约束的前提下执行：

1. **全桌 allergy（table scope）**：对**所有 active 档案**的 `kind === "allergy"` 硬约束（`enforcement === "hard"`），匹配该食谱**八类 exposure 中的全部**的相关项（至少覆盖主料/辅料/调味品/替代品）：命中当 `constraint.allergenCodes ∩ (ingredient.allergenCodes ∪ ingredient.mayContainAllergenCodes) ≠ ∅` **或** `ingredient.foodConceptId ∈ constraint.foodConceptIds`。**不论该成员是否参加本餐**。依据 [food-safety.md:41-42](../../safety/food-safety.md)、[mvp.md:50](../../product/mvp.md)。
2. **参与者个人硬约束（subject scope）**：仅当 `profileId ∈ participantProfileIds` 时，对 `kind ∈ {religious, ethical, explicit_avoid, food_safety_exclusion}` 的硬约束做同款匹配。依据 [food-safety.md:43](../../safety/food-safety.md)。
3. 任一命中 → **该食谱不产生候选**；按 `kind` 记 blocker（§5.6）。**不得**构造 `hardConstraintCheck.status !== "passed"` 的候选对象——该字段是字面量（`meals.ts:151`）。
4. **多命中必须聚合**：不得因先见一个命中就跳过其余校验（[food-safety.md:51-55](../../safety/food-safety.md)）。
5. **未映射硬约束必须 fail closed**：任一 `enforcement === "hard"` 的约束，若其 `allergenCodes` 与 `foodConceptIds` **皆为空**，则该约束**无法被证明已满足**——本食谱**不产生候选**，记 blocker `menu.blocked.hard_constraint_unmapped`。**不得**因结构化代码为空而视为「无风险」放行（[food-safety.md:51-55](../../safety/food-safety.md)「unknown/ambiguous mapping…均 fail closed」；对照生产求值器按 `constraint.mapping` 判定、未映射即 `mapping_unknown` 阻断，`packages/domain/src/resolution.ts:733-749`、`:1568-1572`）。注意：契约把持久化硬约束的 `mappingStatus` 固定为 `needs_structured_mapping`（`identity.ts:230`），故本切片**不**把 `allergenCodes`/`foodConceptIds` 当作权威映射，只在**合成**范围内以其非空集合作为「存在可执行代码」的代理（§5.8）；**空集一律 fail closed**，这正是本条的落点。此规则在 §5.8 的接管点由 `evaluateHouseholdDishSafety` 的 mapping 判定取代。

### 5.6 reason / blocker code 闭集（新增于 `packages/domain/src/menu.ts`）

**候选 `reasonCodes`（≥1）**：

| code | 语义 |
| --- | --- |
| `menu.candidate.within_time_budget` | `recipe.totalMinutes ≤ maximumTotalMinutes` |
| `menu.candidate.cook_skill_satisfied` | recipe `difficulty` ≤ 厨艺映射上限 |
| `menu.candidate.hard_constraints_clear` | §5.5 全清 |
| `menu.candidate.fully_stocked` | `missingFoodConceptIds` 为空 |
| `menu.candidate.missing_items_within_tolerance` | 有缺项但在采购容忍度内 |

**recommendation `blockerCodes`（`no_feasible_option` 时 ≥1）**：

| code | 语义 |
| --- | --- |
| `menu.blocked.hard_constraint_allergy` | 全桌 allergy 命中（table scope） |
| `menu.blocked.hard_constraint_personal` | 参与者个人硬约束命中 |
| `menu.blocked.food_concept_unresolved` | ingredient 或 lot 缺 `foodConceptId`（fail closed） |
| `menu.blocked.hard_constraint_unmapped` | 硬约束无结构化代码（`allergenCodes` 与 `foodConceptIds` 皆空），无法证明已满足（fail closed，§5.5 第 5 条） |
| `menu.blocked.no_recipe_within_time_budget` | 无 `totalMinutes` 合格的 active recipe |
| `menu.blocked.cook_skill_insufficient` | 合格食谱全部超出厨艺上限 |
| `menu.blocked.purchase_tolerance_exceeded` | 缺项超出采购容忍度 |
| `menu.blocked.insufficient_suggested_dishes` | 合格候选数 < `suggestedDishCount` |
| `menu.blocked.no_active_recipe` | 根本无 active recipe revision |
| `menu.blocked.input_invalid` | 输入自身不合法（含空参与者） |

- `menu.blocked.hard_constraint_*` 与 `menu.blocked.food_concept_unresolved` **均为诚实阻断**：受限家庭得到 blocker 而非菜单，是**安全结果**（[mvp.md:46-57](../../product/mvp.md)）。**不得**被当作待修复缺陷。
- 这些 code 是**冻结字符串**，实现逐字使用；它们是 §9.1 的 reason code 面。

### 5.7 排序、采购容忍度与 outcome

- **采购容忍度（确定性规则）**：`none` = `missingFoodConceptIds` 必须为空；`limited` = 缺失项必须全部是 `optional: true` 的 ingredient；`allowed` = 任何缺项均可（并如实列出）。
- **厨艺**：`cookingSkill` 映射难度上限 `none→beginner, beginner→beginner, intermediate→intermediate, advanced→advanced`；超限即硬过滤。这一「普通难度是硬阻断还是软排序」是**显式规则**（[food-safety.md:73](../../safety/food-safety.md)），本冻结取**硬阻断**。
- **排序（确定性）**：候选按 `(missingFoodConceptIds.length asc, totalMinutes asc, recipeId asc)` 排序；`preselectedCandidateIds` = 前 `suggestedDishCount` 个。
- **outcome**：见 §5.3；`options` 的一致性由既有 refinement `meal.recommendation.outcome-consistency.v1`（`meals.ts:182-266`；登记于 `refinement-rules.ts:106-110`）继续强制。

### 5.8 为何**不**复用 `evaluateHouseholdDishSafety` 作为本纵切的正路径

`packages/domain` 已有 `evaluateHouseholdDishSafety`（`packages/domain/src/index.ts:15-20`；`resolution.ts:1871-1968`）与闭集 `HouseholdSafetyReasonCode`（`types.ts:90-122`）。它已正确实现「全桌 allergy + 参与者个人硬约束」（`resolution.ts:731-750` 对**所有** active 档案判 allergy、`:770-799` 仅对参与者判 religious/ethical/explicit_strict_avoid），因此**语义上正是**更正 (a) 的目标。

但它**被 provenance 门控**：`TRUSTED_ACTIVE_HOUSEHOLD_SAFETY_PACK_DIGESTS` 固定为空数组（`resolution.ts:311`），故任何语法合法的 active pack 都在 `:1957-1965` 落 `source_pack_untrusted`——**恒返回 blocked，永不返回 allowed**。这与 `capability-inventory.md:205` 一致：对真实数据恒不返回 `allowed`，只有 `__testOnly*` 合成 seam 能走到结论。

**结论**：本纵切（纯合成、零真实 source）的正路径**不**委托该 production 求值器（否则永远零候选，纵切无法「拿到候选菜品」），而是用 §5.1 的 `menu.ts` 切片本地确定性规则；该规则与 `evaluateHouseholdDishSafety` 的**作用域语义一致**（allergy 全桌、其余参与者），并复用其**闭集词汇的语义**，但不引入 provenance。当 M-5 激活真实 source、M-6 上线受限家庭路径时，本切片规则的 hard filter 位置应由 `evaluateHouseholdDishSafety` 接管。**这是有意的、记录在案的设计决定，不是遗漏。**

---

## 6. 三处强制修正的设计落点

### (a) 引擎必须读**未脱敏**饮食约束

- **设计做了什么**：§5.2 规定引擎输入携带**全部 active 档案的未脱敏约束**，**并且**（§5.2、§3.5 第 4 条）把「经哪条读路径取得约束」钉死为**唯一允许的全量未脱敏批量读**，同时以**类型商标**使脱敏投影在**类型层**不可喂入引擎、并对缺失的 `constraints` 数组做 `input_invalid` fail-closed；§5.4/§5.5 的全桌 allergy 规则覆盖**所有** active 档案（含非参与者），§5.5 第 5 条对无结构化代码的硬约束 fail closed；§3.4 的 `constraintSetDigest` 对**未脱敏**约束集计算。**「输入类型不含 `visibility`」不是本项的保障**——脱敏在调用方的读路径发生，输入缺 `visibility` 不能阻止上游先过滤，保障来自被钉死的读路径与类型商标，**不是**输入形状。
- **为何必需（证据）**：
  - 脱敏投影结构性丢弃私密约束：`mapRedactedPersonProfile` 只保留 `visibility === "household"` 的约束，其余整体 filter 掉（`services/api/src/database/mappers.ts:245-259`）；
  - `safeOwnerProfileResponseSchema` 在**类型层**排除 `subject_and_owner`（`packages/contracts/src/identity.ts:274-287`），成员脱敏视图同（`packages/contracts/src/members.ts:243-249`），故损失**不可能**靠运行时补字段恢复；
  - `visibility` 是二值枚举、两值皆合法（`identity.ts:232`），`household` 只是客户端默认值；migration `0004` 分别统计两种可见性，证明 `subject_and_owner` 是并存合法态；
  - 食品安全硬规则：**所有 active 家庭档案的 allergy 都是全桌硬约束，即使该成员不参加本餐**（[food-safety.md:41-42](../../safety/food-safety.md)）；
  - 漏检私密过敏原即命中发布阻断条件第 1、2 条（[mvp.md:50-51](../../product/mvp.md)）。
- **未脱敏读的构件已存在、但仓库尚无批量方法**：`mapPersonProfile` 直接以 `row.dietary_constraints` 全量解析（`mappers.ts:233-238`），仓储层对 owner/本人用完整读取、仅对「其他成员」才脱敏（`repository.ts:1854-1886,2056-2066,2109-2117` 区段；`schema.ts:289-291`）——证明完整读取是既有服务端能力、脱敏只属对外投影层。**但仓库当前没有「全部 active 档案未脱敏」的批量读方法**：`#loadAuthorizedProfile`（`repository.ts:1496-1520`）只按 owner/本人授权，`listPersonProfiles`/`listHouseholdMembers` 的 member 视角对非本人成员返回 `mapRedactedPersonProfile` 投影（`repository.ts:2066`、`:1886`）。故本冻结**要求新增**该全量未脱敏批量读方法（§3.5 第 4 条），并以其作为**唯一**允许的约束来源。

### (b) recipe 与库存**只经 `foodConceptId`** join

- **设计做了什么**：`recipe_ingredients.food_concept_id` **NOT NULL + FK**（§4.3）；§5.4 的覆盖判定**只**比较 `foodConceptId`；缺 `foodConceptId` **fail closed**（不降级为名称匹配）；纵切两侧都种 `foodConceptId` 才有非空结果。
- **为何必需（证据）**：
  - `recipeIngredientSchema.foodConceptId` 是**必填**的 lowercase UUIDv7（`packages/contracts/src/meals.ts:19`；`packages/contracts/src/primitives.ts:77-82`）；
  - 设计层明令：形状正确的字符串或 UUID **不是**机器可执行映射（`packages/contracts/src/identity.ts:228-230` 的 `mappingStatus: needs_structured_mapping`），故按 `displayName` 匹配被禁止；
  - 实践中 `foodConceptId` 是「死」的：仓储 INSERT 永远写 `request.foodConceptId ?? null`（`repository.ts:1273`），请求字段可选（`inventory.ts:155`），读回时列为空即**整体省略**（`mappers.ts:310-312`），drizzle 列可空（`schema.ts:476`）；不显式种数据时按 `foodConceptId` join 恒空——这正是必须两端种值的原因。

### (c) 快照 digest：**采用四段**（不作递延）

- **设计做了什么**：§3.4 用 `recommendationSnapshotSchema`（inventory/constraints/recipes/policies 四段 + `snapshotDigest`）**替换** `meals.ts:176-177` 的两个单值字段；规范化复用 `canonicalJson`（`packages/domain/src/canonical.ts:70`），digest 形如 `sha256:<64hex>`（`canonical.ts:58`）。
- **为何必需（证据）**：of record §5.4 规定统一四段快照（`2026-08-...core.md:311-340`），并在 §5.1 line 262 **点名**「单值 `inventorySnapshotVersion`、单值 `constraintSnapshotVersion`」为要替换的反模式；ADR-0009 §3 的硬边界禁止把已知的、未修复的规范性缺陷递延；四段的 canonical 形式由既有 `canonicalJson` 完全确定，不存在「冻结错误规范化」的风险。故本轮**采纳**。

---

## 7. 本纵切明确**不**包含什么（及为何）

| 不包含 | 为何（避免被误读为遗漏） |
| --- | --- |
| 真实食物源 / 真实词表 / source activation / G2 admission | 纵切是**纯合成**；public trust allowlist 固定为空是安全边界（`resolution.ts:311`）。纵切不得被读作释放其中任何一项。 |
| 采购（ShoppingItem）、入库、做饭、消耗、剩菜回库 | M-4 的范围是「今天吃什么」；Shopping / Completion 属后续里程碑。本纵切**不**写 `inventory_events`，**不**建 Shopping 表，事务/锁序面因此不触及（见 §8）。 |
| guest 参与者（`guestParticipants`） | 引擎输入保留空 guest 集；guest 的**全桌 allergy** 规则（[food-safety.md:41-42](../../safety/food-safety.md)）在 guest 输入出现前无法被完整行使。登记为未决（§10）。 |
| 模型 / Agent / OCR / 语音 / 图片 | 引擎是**纯确定性规则**，模型不得改变结果（[food-safety.md:66-67](../../safety/food-safety.md)）。 |
| 份量缩放与替代食材重算 | 本纵切按 recipe revision 的 `servings` 原样；§food-safety 要求替换/缩放后重算（[food-safety.md:48](../../safety/food-safety.md)）属后续。登记为未决（§10）。 |
| `0000`—`0004` 的任何改写、新的 `SECURITY DEFINER` routine | `0000`—`0004` 字节永久冻结；引擎在应用侧，DB 无新 routine（§4.5 第 4 条）。 |
| 新的 `membershipCapability` 枚举成员 | 复用既有 `meal:write`（`identity.ts:186-193`）；扩展闭集枚举超出本纵切需要。是否需专用 entitlement 登记为未决（§10）。 |
| meal 路由的客户端接线 | §3.6：第 6 页只做生成+展示，客户端 registry 增量恰为 1 条（第 16 条）。登记为未决（§10）。 |
| 任何可能违反 [mvp.md:50-57](../../product/mvp.md) 的推荐路径 | 受限家庭得到带诚实 blocker 的 `no_feasible_option`；引擎只在硬检查确证通过时才发候选（`meals.ts:150-154`）。 |
| 说明性候选数量 `24/4/3/8/8/12` | 只是说明，**不得**进入任何验收条件或看板百分比（开发计划 §5；`:143-144,207`）。 |

---

## 8. 验收条件与门禁

### 8.1 设计门禁停止谓词（ADR-0009 §2）

本轮设计门禁可停止，**当且仅当**：`P0 = 0` 且 `P1 = 0`，且**每一条**残余 P2 要么**本轮修复**、要么**已登记入延迟项登记表**（§10）。「本轮修复」须由一条**独立于修复者**的 lens 对修订后文本做确认性回读，不得自证（ADR-0009 §2、§5）。

- 轮次上限：**3**，按 **of-record 里程碑身份**计数，不按任务/阶段/子里程碑重置（ADR-0009 §4；本文件 §1.3）。
- 延迟准入：只允许 `bookkeeping` / `open-design-question` / `evidence-obligation` 三类，逐笔声明 `admissionBasis`；**不得**用任一类递延已知的、未修复的规范性缺陷（ADR-0009 §3）。

### 8.2 触及的 §12.1 A/B 双审计面

本纵切**触及**以下三面，实现后须 A/B 双审计（of record §12.1，`2026-08-...core.md:562-566`）：

1. **migration/RLS**（`0005` + authorization manifest + RLS 姿态）；
2. **hard-constraint 引擎**（§5.5，**更正 a**）；
3. **Recommendation 安全快照**（§3.4/§5.4，**更正 c**）。

**不触及**：active 食品安全/allergen 数据（无激活）、Meal completion/leftover 事务（纵切不做做饭/消耗）、M6 最终候选。故本纵切**不**自动升级为「全部 §12.1 面」。

### 8.3 分层门禁（进入实现后）

| 层 | 本纵切的必测项 |
| --- | --- |
| Contract | 新 schema 的 Zod/TS/OpenAPI parity；新 refinement 的稳定 rule id 与绑定（`refinement-rules.test.ts` 计数）；strict object；`canonicalSha256DigestSchema` 格式 |
| Domain | 引擎确定性（同输入逐字节同输出）；排序稳定；缺项经 `foodConceptId`；空 `foodConceptId` fail closed；无结构化代码的硬约束 fail closed；§5.6 全部 blocker code（含 `menu.blocked.hard_constraint_unmapped`）各自可达 |
| Database | 空库 `0000→…→0005`；真实 `0004→0005` 增量；`0004` N-1 archive 恢复全流程（备份须取自 ledger `[0000…0004]`，§4.6）；checksum；ACL/RLS；`run-local-test-smoke` 的 `expectedRowSecurity` 扩展至新表集（§4.8）；复合 FK；`0000` 对象 manifest 不动；`manifest:check` 逐字节 |
| HTTP | session/household/capability（`meal:write`）；幂等 same/different body；受约束家庭返回 **200/201 + `ok:true` + `no_feasible_option`**，**非** 4xx；跨家庭反向测试 |
| Client | 第 6 页 空/加载/未知/失败/无权限/安全阻断 状态；第 16 条命令的 command snapshot/key；离页恢复 |
| Safety | **负例语料**：全桌 allergy（含**私密** `subject_and_owner` 过敏原）零漏放；调味品路径；`mayContain`；映射 unknown 时**不**产生候选；多命聚合。私密约束负例**必须**经真实路由/仓储读路径驱动（§8.4(a)），**不得**以手工喂入未脱敏输入的 domain 单测代替 |
| Docs/audit | 来源/许可/版本、HEAD/run、回滚边界、链接、Secret/真实数据扫描 |

### 8.4 三条强制修正的**专门**负例（进入实现后必须各有测试）

- (a)：构造一条 `visibility === "subject_and_owner"` 的 allergy 硬约束，其 `allergenCodes` 命中某食谱主料——断言该食谱**不产生候选**、推荐落 `no_feasible_option` + `menu.blocked.hard_constraint_allergy`。这是「读投影会漏检」的判别测试，**测试层级必须是驱动真实建议路由（含其约束读路径）的 HTTP/route（或仓储）集成测试**：实现若走了脱敏读路径（§6(a)），该测试必须失败。**不得**以「在 domain 单测里手工喂入未脱敏输入」代替——那样的单测无论读路径是否正确都会通过，不构成结构性排除。另加：一条无结构化代码（`allergenCodes`/`foodConceptIds` 皆空）的硬约束——断言**不产生候选** + `menu.blocked.hard_constraint_unmapped`（§5.5 第 5 条）。
- (b)：构造一条 ingredient 缺 `foodConceptId`——断言 fail closed（无候选 + `menu.blocked.food_concept_unresolved`），且**不**发生任何名称匹配；再构造两侧都种 `foodConceptId` 的同名/异名数据，断言覆盖判定只随 `foodConceptId` 变化。
- (c)：断言 Recommendation 的 `snapshot.snapshotDigest` 覆盖四段，且改动任一段（如某 lot 的 version、某档案的约束集）后 digest 必变；确认菜单时 `expectedSnapshotDigest` 漂移返回稳定 409。

---

## 9. Owner contract 与后续顺序

### 9.1 需要 owner 授权的内容

- **ADR-0009 §8 第 2 项的有界合成纵切授权**：本设计门禁的产物**不**自行取得它。授权必须**钉死范围、精确 SHA 与单一交付边界**，并**显式以该合成范围取代**入口评估对 contracts/API/DB/client/migration 的禁令（**仅限该合成范围**）（开发计划 §M-4）。
- **M-2 前提**：M-4 依赖 M-2（开发计划 §3.2、§4）。M-2 未 CLEAN 前不进入实现。
- 本文件是**设计**交付；实现提交只能报 `Implemented`。

### 9.2 固定顺序（不得重排）

```text
本设计门禁收口（frozen）
→ 0005 单写者 migration（含 manifest/RLS/复合外键/锁序）
→ packages/contracts（新请求契约 + 两信封 + 快照四段 + refinement 登记）
→ packages/domain menu.ts（引擎 + reason/blocker code）
→ services/api（repository 双登记 + routes + 幂等）
→ apps/client（第 16 条命令 + 第 6 页）
→ E2E
→ 文档/状态/看板 → 独立审计 → 总控 Accepted
```

### 9.3 单写者与禁止交叉写入面

- **migration 只有 migration owner 可写**（of record §9.2，`2026-08-...core.md:484-485`）。
- 禁止交叉写入面：`packages/contracts/**`、`packages/domain` public exports、migration、authorization manifest、`docs/safety/**`、root lockfile 与 generated OpenAPI（`2026-08-...core.md:494-495`）。
- 本设计门禁冻结前，禁止多个 Agent 并行实现上述共享面（`2026-08-...core.md:476`）。

---

## 10. 明确未决与准入 stopline

### 10.1 需登记的延迟项（`docs/governance/deferral-register.json`）

下列条目为**未作出的设计决定**（`admissionBasis: open-design-question`），须按 ADR-0009 §6 的六字段登记（键名 camelCase；`expiry` 为完整 ISO 8601 **带时区偏移**——ADR-0009 §6.1 禁止裸 `unassigned`；具体日期取纵切授权窗口的收口日，由总控在签发授权时写入）：

| id（建议） | owner（责任角色） | closesAtModule | evidenceNeeded / closeTrigger 要点 |
| --- | --- | --- | --- |
| `m4a-recommendation-entitlement` | auth / HTTP contract owner | `m4a/entitlement` | 是否需专用 `recommendation:write` capability（vs 复用 `meal:write`）；WP-O2 command boundary/entitlement 落定后关闭 |
| `m4a-guest-participants` | 食品安全 / domain owner | `m4a/guest-facts` | guest 的 `GuestParticipantSafetyFacts` 输入与其全桌 allergy 规则的行使；guest 输入进入引擎时关闭 |
| `m4a-recipe-serving-substitution` | culinary/domain owner | `m4a/serving-substitution` | recipe 份量缩放与替代食材后的重算；替代组/份量进入食谱模型时关闭 |
| `m4a-meal-confirm-client-wiring` | client / API owner | `m4a/client-meal-confirm` | `POST .../meals` 的 typed 客户端命令与页面接线；M-4 采购/确认闭环开始时关闭 |

登记动作本身是**实现级**（登记表由 `scripts/check-deferral-register.mjs` 机械核验：`schemaVersion`、字段齐备、无重复键、`expiry` 合法）；登记时须把顶层 `expectedEntryCount` 从 22 更新为相应值。**本轮不修改登记表**（本文件是设计冻结，不改仓库）。

### 10.2 明确未决（不在本轮裁定）

- 有界合成纵切的**授权本身**（ADR-0009 §8 第 2 项；属产品负责人）。
- 精确列类型/约束字面量/索引、`manifest:generate` 重生成、硬编码 ledger 单测 4/5→6/6、`schema.ts` 镜像（§4.7，实现级）。
- `menu.ts` 的 reason/blocker 字符串在与 `evaluateHouseholdDishSafety` 接管时的**映射表**（§5.8；M-6 前不需要）。

### 10.3 准入 stopline

> **STOPLINE。** 本文件是**合成纵切的设计冻结**。它**不**释放任何真实数据、**不**激活任何 source、**不**取得任何 G2 admission、**不**授权纵切范围之外的实现、**不**构成任何里程碑的 `Accepted`。它**只**在 ADR-0009 §8 第 2 项的有界合成纵切授权（且 M-2 已闭合）成立后，作为该纵切不可并行实现面（契约 / `0005` / RLS+manifest / 引擎输出契约）的**单线冻结**生效。若该授权未获或 M-2 未闭合，本文件**保持设计准备物**，不得据此开始实现；若纵切证明引擎无法读未脱敏约束、或无法经 `foodConceptId` join，则**任何**推荐路径不得发布（开发计划 §4 第 5 项）。约 30 项开放义务的**工作计数**不是验收条件。
