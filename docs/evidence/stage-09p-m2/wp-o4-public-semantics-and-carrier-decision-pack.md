READY_FOR_FRESH_REVIEW

# Stage 09P-M2 / WP-O4（r5）：公开语义与载体（Q05）联合决策候选

> 本文件为 **r5（第五候选）**：r1 过首轮独立 Fresh Review（残余 11 条 P2，见 §14），r2 逐条实质处置后
> 被第二轮全新独立三 lens 复评——三 lens 均 `CLEAN`、`P0=0/P1=0`（对抗性 lens 达 `0/0/0`），但残余
> **6 条 P2**（fail-closed lens 的 FC-R2-01…FC-R2-05、authority lens 的 WP-O4-R2-AUTH-01），r3 逐条实质
> 处置这 6 条（见 §15）。第三轮全新独立三 lens 复评再次 `CLEAN`、`P0=0/P1=0`（fail-closed lens 达
> `0/0/0`），残余 **7 条 P2**（authority lens 的 WP-O4-R3-AUTH-01…04 与 adversarial lens 的 ADV-R3-01…03）。
> r4 逐条实质处置这 7 条（见 §16）。第四轮全新独立三 lens 复评再次 `CLEAN`、`P0=0/P1=0`，残余已收敛为
> **三个明确问题**（6 个 finding id：FC-R4-01/ADV-R4-02、FC-R4-02/AUTH-R4-02/ADV-R4-01、AUTH-R4-01），
> r5 逐条实质处置这三点（见 §17）。不改结论上限：仍是 `DESIGN_ONLY` 设计准备材料，
> `READY_FOR_FRESH_REVIEW` 不等于 `CLEAN` / `Accepted` / `CONTRACT_FROZEN`。

## 1 权限、范围与结论上限

本候选只处理 WP-O1 §10 中仍开放的**一个**问题：**Q05 公开语义与载体**（OUT→ENV，HTTP/client/B 共同）。
Q05 原文（WP-O1 §10）：

> 如何向获准 client 准确表达 attempt 局部与 command 终局、恢复暂不可用、结果不可恢复？域 result
> rejected 放何种获准 envelope？problem 与 receipt 关联如何证实？无 response 如何约束 consumer？
> 先语义覆盖再载体，再 consumer 对账；不冻结 DTO/status/field，不把 B internal category 放 public 字段。
> 无可靠载体 route 不准入。

按此，本候选必须回答（逻辑层）：

1. **(a) 尝试局部 vs 命令终局 / 恢复暂不可用 / 结果不可恢复**：向获准 client 如何准确、不过度声称地表达；
2. **(b) 域 result rejected 的获准 envelope**：域结果拒绝应放在何种授权载体内；
3. **(c) problem 与 receipt 的关联如何被证明**（而非被假设）；
4. **(d) 无 response 对 consumer 施加什么约束**；
5. **顺序**：语义覆盖先行，再载体，再 consumer 对账。

本候选由项目总控在 `codex/stage-09p-m2-inventory` 材料基线上形成，供后续全新独立 Fresh Review。

**结论上限（claim ceiling）**：本候选至多是 `DESIGN_ONLY` 的设计准备材料，处于逻辑层。它**不**关闭
G-OUT、G-ENV、G-ROUTE、G-ID、G-CLIENT、G-AUTH、G-LIFE、G-BUDGET、G-LOG、G-BACKEND 中任意一项，
**不**冻结任何 contract，**不**冻结或新增 public DTO / field / enum / status / reason code / ordinal /
route / operationId，**不**设计 SQL / DDL / schema / 列 / 索引 / 唯一约束 / RLS / GRANT / migration /
lock key / isolation level，**不**确定 TTL / GC / retention 数值，**不**新增 client port，**不**授权
任何实现、测试夹具或 runtime 接线。载体在本文中一律以**义务（obligation）+ 该义务的解除证据**形式表达，
不落为具体字段或状态码。它只把 Q05 从“未决”推进到“有可独立评审的语义候选与载体义务”。

固定项目事实（与本候选并存、不因本候选改变）：M1 仍为 `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`
（非 Accepted），M1 Fresh Audit A = CLEAN，household-safety 292/292 仅为 LIMITED 动态证据；B-r1/r2/r3 = BLOCK
且 B-r4 未运行；G2 = `G2_NOT_ADMITTED`，source pack draft/inactive，public trust allowlist empty；
M2 = `In Progress` 未 Accepted；R7-A contracts = Accepted；R7-B = `R7-B_SHADOW_DESIGN_ACCEPTED /
IMPLEMENTATION_BLOCKED`；R7-C = `R7-C_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED` 且 T01–T50 全未执行；
WP-O1/WP-O2/WP-O3 均为已登记 CLEAN 的设计准备材料，不是 wire/runtime authority。

**对上游递延义务的处置（WP-O3 §9/§12 交办）**：本候选逐条处置如下，不重开 Q01/Q02/Q08（WP-O2）或
Q03/Q04/Q06/Q09（WP-O3）：

- **(i) public DTO/status/reason/route 全部留 Q05**：本候选在**语义层**给出完整覆盖（§4）与载体**义务**（§5），
  并**显式再递延**具体 field/status/reason/route 的取值冻结到 G-ENV/G-OUT 的正式 contract freeze，理由见
  §5.4/§8（strict envelope 的任何字段新增都是契约变更；无真实证据前不得冻结）。本候选不把该递延写成
  “已关闭”。
- **(ii) original receipt 的“公共安全投影”必须另设 envelope**：**已答**（§5.3 CB-8、§6、§12），并明列
  禁止运行时删字段（WP-O2 D17、WP-O3 §5.5 同向）。
- **(iii) retention 后可公开事实的 state-relative 公开语义 + 无 existence oracle 反例**：**已答**
  （§4.3 P-7、§10 W39/W40/W50），并承载 WP-O3 RA-26 的 r2/r3 修正（`N`/`U` 不得被公开为“曾被接受”）。
- **(iv) Q05 四问 (a)–(d)**：**已答**（§4、§5、§6、§7）。
- **(v) WP-O3 命名开放义务 O9-5（Q09 内、依赖 Q10）**：**原样承接、不重开 Q09**——本包在 §8.2 G8 与 §12
  stopline 显式承接：版本升级/重新登录移动 namespace 时 non-reuse **不得**静默依赖 namespace 相等；**在 Q10
  关闭前该义务保持 admission blocker，不得写成 gate closed**（WP-O3 §7.2.3/§7.4/§12、RA-27、§10 W37）。

## 2 PRE、输入与方法

| PRE 项 | 精确值（本机实测） |
| --- | --- |
| 当前工作树分支 | `main` |
| 当前 HEAD | `23450a1f3508e8030d753748291d265ad308df05` |
| 当前 HEAD tree | `1cfbc2564b1c5e923f078fdb0436a66a28b90690` |
| `git status --porcelain=v1 --untracked-files=all` | ` M AGENTS.md`（仅一处未提交改动；本包不读取、不依赖该改动） |
| 材料权威 branch ref | `refs/heads/codex/stage-09p-m2-inventory` |
| 材料 ref tip | `41d47ebfa02313e2f388ae1749b54f4cec3f97d8` |
| 材料 ref tip tree | `ec66e80cec1c89bb1ea6369df2ac7bcdf3d87ead` |
| WP-O3 工件 branch ref | `refs/heads/codex/stage-09p-wp-o3` |
| WP-O3 ref tip | `17c579dc57f54c65800d23ee9def3d98210de0c5`（subject：`docs(stage09p): record the WP-O3 acceptance point and the un-pushed 09P risk`） |
| WP-O3 ref tip tree | `cd4ee332bda51e0e99a19531f65a26384fb1a70b` |
| WP-O3 包磁盘路径 | `.local/worktrees/wp-o3/docs/evidence/stage-09p-m2/wp-o3-command-record-authority-decision-pack.md`（与 `codex/stage-09p-wp-o3:` 同名文件 SHA-256 逐字相等，见下） |

本轮实际读取的精确源材料（repo-relative path；磁盘路径按绝对路径读取）：

| 材料 | Lines / Bytes / SHA-256（本次计算） | 用途 |
| --- | --- | --- |
| `.local/worktrees/wp-o3/docs/evidence/stage-09p-m2/wp-o3-command-record-authority-decision-pack.md` | 793 / 83,548 / `6e2775f4cceef14e83f73ce44ed3b4c4ca52ce91d7522260114fd663b5f5d754` | **结构模板**；被交办的 Q05 义务、owner contract、准入 stopline |
| `.local/worktrees/wp-o3/docs/evidence/stage-09p-m2/wp-o3-command-record-authority-evidence.md` | 291 / 22,456 / `1bc922786ae16bb9f4c72230ab11c463a75297ab535e16d8418122c6b62047cb` | evidence 结构模板；authority chain |
| `.local/worktrees/wp-o3/docs/evidence/stage-09p-m2/m2-post-r7-gap-gate.md` | 323 / 45,917 / `0fc31a5787689f1b1683b07fb9aa19eff4ceb81deaa155e4d5ad7e415b17f535` | 十 G-*、G-OUT/G-ENV 定义行、B04/B05/B08 |
| `codex/stage-09p-m2-inventory:docs/evidence/stage-09p-m2/wp-o1-outcome-evidence-scope-decision-pack.md.raw` | 363 / 63,296 / `68945d9f1566687d7d57c7cc9b7411e74a7f7d7bb46ba71ef1e9dcf54bd90eca` | E01–E19 taxonomy、4×7 settlement 矩阵、O01–O16、§10 Q05 原文、§8 owner projection |
| `codex/stage-09p-m2-inventory:docs/evidence/stage-09p-m2/wp-o2-command-boundary-entitlement-decision-pack.md` | 438 / 29,516 / `239e82c2a800cbff7e3044b41d09f41bed305b1f072cc759527197c9ac25bd1d` | Q01/Q02/Q08 已决项；D11–D17（entitlement/release point/projection） |
| `codex/stage-09p-m2-inventory:packages/contracts/src/api.ts` | `c00763ecf31e956aaf2dc22c48fe94b0e754c2f45bf126207e1c531296a58543` | 成功/problem envelope、18 错误码、meta.idempotency（本地核实） |
| `codex/stage-09p-m2-inventory:packages/contracts/src/inventory-v2.ts` | `ee0e3a11d8b0177a3de9c5c4961f3025d0b9267053b67cfa6268dd0528836fce` | 域 result accepted_chunk/finalized/rejected 形状、parser reason（定向） |
| `codex/stage-09p-m2-inventory:services/api/src/errors.ts` | `ca11713f743e5e17f252b961fa6b96e23d1d5a85d60dccf3489f795d74c6246f` | AppError→problem、titleByCode（本地核实） |
| `codex/stage-09p-m2-inventory:services/api/src/routes.ts` | `d156d44ad505d8a74ba38f9ae6d6e2957efbe187eb133bc68f7c57717d0e4b22` | problemResponse/content-type、commonErrorResponses（本地核实） |
| `codex/stage-09p-m2-inventory:apps/client/src/core/api-client.ts` | `ad960d37ec0f34f3c7e224c558e6b80f29317cc0bc281a5bbc46442fe4d87a66` | ApiOutcome 四态、401 分流、query 拼接（本地核实） |
| `codex/stage-09p-m2-inventory:apps/client/src/core/idempotency.ts` | `1242b6fb72b19ff26ba08da5dd65ecee1add57acabf11f7adf1d6db9d32caee2` | 相位机、dispositionForOutcome（本地核实） |
| `codex/stage-09p-m2-inventory:services/api/src/app.ts` | 366 / 13,073 / `cbb8d4d198e0010118412c32ca2f5e24ced4e9d1630457b30c0f45db74a27895` | genReqId 采纳 `x-request-id`、安全响应头、error/notFound handler（定向；**r4 新增**，闭 WP-O4-R3-AUTH-04） |
| `codex/stage-09p-m2-inventory:services/api/src/database/repository.ts` | 2,907 / 97,037 / `b354cd20e9d71bb7f1e323cb86332d2208a8e146a40f26cb09cf26704b52c669` | 重放已提交域错误裸抛、非可重放抛裸 `CONFLICT(409)`、`replayed/originalRequestId` 来源（定向；**r4 新增**，闭 WP-O4-R3-AUTH-04） |
| `.local/worktrees/wp-o3/docs/evidence/stage-09p-m2/wp-o3-fresh-review.md` | 119 / 10,000 / `d6bed0651495147647a603219113bae21f34c7b8e54041c3af7feaae6d37e416` | 审阅对象/结论登记（只读，不作为 authority） |
| `codex/stage-09p-m2-inventory:docs/evidence/stage-09p-m2/r7c-shadow-design-r1.md` | 409 / 79,559 / `4884b06081d009d84461b263e03bfe5c90e82035e325788fcd5b25bb53ad0627` | R7-C r1 shadow design；被 §5.1 CB-10、§7.1、§7.2 K-5/K-7、§11 PS-06/PS-07、§13 按行号引用（§8 line 141 / §9 line 158 / §11 line 228 / §12 line 249）（定向；**r5 新增**，闭 AUTH-R4-01） |
| `codex/stage-09p-m2-inventory:docs/evidence/stage-09p-m2/r7c-r1-fresh-review.md` | 216 / 25,473 / `ca6535848a1bb8d88c9e80ba3eff1f5047d900eeb9fc8889cde37ca94efbec4f` | R7-C r1 fresh review；被 §7.2 K-7 引用其 §4（定向；**r5 新增**，闭 AUTH-R4-01） |

**方法**：先固定 legacy 代码的**能力与缺口事实**（§2.1，只读静态事实），任何逻辑候选都不得与既有机制
矛盾、也不得声称新语义已存在；再按 Q05 要求的顺序——**语义覆盖 → 载体义务 → consumer 对账**——展开，
每个答案携带可被真实证据解除的证明义务。HTTP status、public field、数据库列、锁实现与 retention 数值
均不得反向定义这些语义。

### 2.1 代码 grounding（本轮本地只读核实，是静态事实，不是动态证据）

- **成功 envelope**：`createApiSuccessSchema = strictObject{ok:true, data, meta}`（`api.ts` **L116–123**；其
  `ApiSuccess<T>` 类型别名 L129–131），`meta = apiMetaSchema`，后者 `= strictObject{requestId 必填,
  idempotency 可选}`（`api.ts` **L110–114**）。`strictObject` 意味着**任何新增字段都是契约变更**（多余字段即
  解析失败），因此 M2 若要承载本包 §4 的新语义，属于**新增 envelope 设计**，不能声称 legacy 已承载。
  （**r3 修正 WP-O4-R2-AUTH-01**：原 r2 标 `L64–118` 未落在被归属内容上，现按 §2 PRE 钉住的 SHA
  `c00763ec…` 逐符号重核如下。）
- **错误 envelope**：`apiErrorSchema`（`api.ts` **L59–84**；`strictObject` 体 L60–71，`ruleSuperRefine`
  一致性校验 L72–83，类型别名 L84）`= strictObject{ok:false, type, title, status, code, detail?, instance?,
  requestId, retryable, fieldErrors?}`。它**没有 meta、没有 idempotency、没有任何 attempt/receipt/
  command-identity 字段**。`createApiResultSchema = union(success, apiError)`（`api.ts` **L125–127**；其
  `ApiResult<T>` 类型别名 L133–135），二者类型层互斥。
- **错误码**：`apiErrorCodeSchema`（`api.ts` **L9–29**：enum 体 L9–28、类型别名 L29，止于别名）恰好 18 个码，`apiErrorStatus`（**L31–50**）是
  code→status 全量映射（`errors.ts` `titleByCode` 同源）。实测 `PRECONDITION_FAILED`/`SAFETY_BLOCKED`/`RATE_LIMITED`
  三个码**从未被服务端抛出**（不在 `routes.ts` `commonErrorResponses`；`commonErrorResponses` 仅
  400/401/403/404/409/413/414/415/500/503），仅有声明与文案。因此**不得**把这三码当在线行为。
- **幂等元数据**：`idempotencyMetadataSchema`（`api.ts` **L99–108**）`= strictObject{key, scope, replayed,
  firstProcessedAt, originalRequestId}`，**只作为成功 envelope 的 `meta.idempotency`** 出现（经 `apiMetaSchema`
  L110–114）。problem 响应里没有 meta、没有幂等字段（§2.1 代码观察，**非上游 id**——上游 `I-02` 实为
  “unknown 跨 attempt 的独立事实”，与本句无关；r3 此处曾误挂 `I02` 标签，r4 删除）。
- **相关性**：请求相关性只靠 `requestId`（`z.uuid()`），回显在成功 `meta.requestId` 与 `problem.requestId`；
  但 `requestId` **不是**服务端强制“每次投递唯一”：`app.ts` 的 `genReqId` 会**采纳调用方提供的 `x-request-id`**
  ——该头存在且通过 `requestIdSchema` 校验时**逐字用作 `requestId`**，仅在不提供/不合法时才 `newEntityId()`
  （`app.ts` **L202–223**，尤其 L207–212）。因此 legacy 的 `requestId` 是**调用方可选指定、不保证逐次投递唯一**的
  （r4 补，修正 ADV-R3-03），§6.2/§6.3 的“只可作 correlation、不证明命令身份”结论据此**更稳**而非被加强。
  `replayed=true` 仅由成功重放给出，被重放的**已提交领域错误**以裸 problem 抛出（线上无法区分“重放的失败”
  与“新失败”，`repository.ts` **L762–769**），非可重放 legacy 敏感响应抛裸 `CONFLICT(409)`（不带任何元数据，
  `repository.ts` **L783–785**）。**响应头**不承载 requestId / idempotency / 重放标记（`app.ts` 只设
  `cache-control`/`x-content-type-options`，**L139–142**、**L316–320**；无 `Retry-After`，无 CORS，**L128–138**）
  ——注意 `x-request-id` 是**请求**头且被 `genReqId` 采纳（见上），不是响应头。
- **客户端消费**：`ApiOutcome` 四态互斥 `success | apiError | transportError | malformedResponse`
  （`api-client.ts` **L14–23** 类型；消费/映射 L98–161）；`dispositionForOutcome` 把
  transportError/malformedResponse→`unknown`、`apiError` 且 status≥500→`unknown`、status<500→`definite-failure`、
  成功类→`completed`（`idempotency.ts` **L371–410**）。即**4xx（含 409）一律被判 definite-failure**；
  **成功侧**则相反：`api-client.ts` **L115–135** 把**任何 envelope 合法的 2xx**（含 `data.kind='rejected'`
  的域结果，含未经 E01/E02 authority 校验的 2xx）分类为 `kind:'success'`（L130–135），再由
  `dispositionForOutcome` 的成功分支（`idempotency.ts` **L394–408**）→ `'completed'`。线上**没有任何
  attempt-local 与 command-terminal 的区分**，`unknown`/`completed` 纯粹是客户端启发式。
- **域结果**：`inventoryReplayChunkResultV2Schema` 的 `data` 是 `strictObject{kind∈{accepted_chunk,finalized},
  checkpoint}` 或 `strictObject{kind:"rejected", reason}`（`inventory-v2.ts` 定向）。它是**2xx `data` 载荷**，
  不是命令级 receipt，也不含时间/身份/重放语义。本包不据此冻结任何 reason 或 field。

**能力边界（不得越权声称）**：客户端确有 `CommandId`/`authGeneration`/stale-attempt，但仅驻客户端内存、
只控制 envelope 绑定与 callback 消费资格，**不是 logical identity 载体**；B 侧**没有任何**持久 command /
attempt / commit-capability / receipt-entitlement / command-final no-effect 记录（与 WP-O3 §2 RA-22 一致）。
因此 Q05 要求的“公开语义 + 授权载体”能力**均需新建**，不得称其为既存。

## 3 联合决策摘要

### 3.1 (a) 尝试局部 / 命令终局 / 恢复暂不可用 / 结果不可恢复 的公开语义

向获准 client 的公开表达必须**以证据范围为准**，把下列事实**逐类可分地**表达（§4 完整覆盖表）。**所有
陈述都须按先前状态 N/U/C/F 限定**（§4.1.1）：例如“恢复暂不可用”只在 `N`/`U` 下成立，`C`/`F` 的持有者
**不得**说出它（`C` 保持原成功、`F` 保持终局无效果）。

- **尝试局部**（E04/E05/E06）：只能说“这一次未发送 / 本次尝试未产生效果 / 本次被拒绝”，**不得**说原命令
  终局失败或终局无效果；**不得**据此开放同身份重执行写（WP-O3 RA-23）。
- **命令终局**：`C`（E01/E02）只能说“原命令已接受，结果见原 receipt”，且**限原 chunk/operation**，
  不自动等于整段历史/live 成功；`F`（E03）只能说“原命令已终局确定无业务效果”，须三谓词齐备，不夸大为
  整 session 清空。
- **恢复暂不可用**（E07/E08/E09/E11 有执行窗口）：只说“结果尚未确认 / 恢复暂不可用”，**不得**展示完成或
  确定失败，**不得**默认 `definite-failure`。
- **结果不可恢复**（retention/E10）：**state-relative**（WP-O3 RA-26）——`C`=曾被接受但原结果现已不可恢复；
  `N`/`U`=**是否曾存在结果属 UNKNOWN**、未确认、恢复受阻，**严禁**表述为“曾被接受”；`F`=已终局关闭。
- **auth 暂停**：`suspend without disclosure`——只说“需重新登录 / 当前无权取得该事实”，不猜业务成败、
  不披露 payload/receipt、不泄漏存在性。

### 3.2 (b) 域 result rejected 的获准 envelope

域 result rejected 是**尝试局部的域判定**。它必须落在**明确声明为 attempt-local、且不得被读成 command-terminal
success 或 command-terminal failure** 的授权载体内；**不得**因 `kind=rejected` 结算整条命令失败，也**不得**
因它出现在 2xx envelope 内就结算成功（WP-O1 E16）。当前 strict 成功 envelope 是 `{ok:true,data,meta}`，
`rejected` 作为 `data` 时会被通用 consumer 读成 `ok:true` 的成功；当前 problem envelope 又无法携带域判定
范围，因此**现有 envelope 不满足**该义务，须由 G-ENV 另设授权 envelope（本包不冻结其形状，见 §5）。

### 3.3 (c) problem 与 receipt 关联的证明义务

problem 与 receipt 的关联**必须被证明，不得被假设**：只能由**服务端权威绑定记录**（原命令身份 key +
request binding，r3 消歧、r5 收窄：此处的“原命令身份”即 Q01 的 exact identity key + request binding，**与
`requestId` 的相关性提示（调用方可指定、不证投递唯一；§6.3）无涉**）在**单一 release authorization point**、经**当前 receipt entitlement**
重验后建立；**requestId 回显、HTTP status、key 文本相同、时间/位置相邻、“当前只有一个 pending 命令”
都不能充当证明**（§6）。无法证明关联的响应一律按 E11 处理（无 settlement authority，不得据其内容披露）。

### 3.4 (d) 无 response 对 consumer 的约束

无 response 时，**允许没有 HTTP response**；consumer 必须**保持 unknown**，**不得**推断确定失败或成功、
**不得**换 key / 重做写 / 建新 session、**不得**以 GET/current checkpoint 反推 receipt、**不得**用后续仅覆盖
本 attempt 的 4xx/拒绝清除 unknow latch（§7）。client 本地超时 ≠ 服务端 deadline，`reply.finish` 也**不**证明
client 收到（WP-O1 I-05/§8）。

## 4 Q05 候选答案 — 语义覆盖先行

本节先把“**对获准 client 有公开意义**”的观察集列全，并对每一类给出：**可公开表达**与**不得表达**。
本表是 WP-O1 §5 taxonomy（E01–E19）在**公开语义层**的投影（**§6.3 4×7 矩阵的逐格公开投影另见 §4.1.1**，
r4 修正 ADV-R3-02），不是 wire 定义，不新增
DTO/status/reason/field。所有条目均为 **fail-closed**：无证明时公开表达取其**较弱/未确认**一侧。
**E01–E19 的投影覆盖是完备的（r3 修正 FC-R2-03）**：P-1…P-12 覆盖 E01–E14、E16、E18
（E01/E02→P-3，E03→P-4，E04/E05→P-2，E06→P-1，E07–E09→P-5，E10→P-7，E11/E12→P-9，E13→P-12，
E14→P-11，E16/E18→P-8）；**E15/E17/E19 在 §4.1 表末以显式递延声明给出（非遗漏）**。

**本表的两个轴必须合读（r2 修正 FC-01，r3 扩为 P-1…P-12；r4 修正 ADV-R3-02——P 集与 §6.3 七观察列不得
混同）**：下表 P-1…P-12 是 **E01–E19 taxonomy 的公开语义投影集**（“收到了什么观察 / 处于什么状态”），**不是**
WP-O1 §6.3 的七个观察列本身——P-10（C/F 冲突候选）与 P-12（E13 current GET/checkpoint）**不在** §6.3 的七观察
列内，P-11 是 WP-O1 §6.1 的**正交状态**（local completion）而非 §6.3 观察列；§6.3 4×7 矩阵的逐格公开投影是
**§4.1.1**。“同一条观察在不同**先前状态** N/U/C/F 下如何公开表达”是**正交的先前状态轴**，亦见 §4.1.1。
任一 P 行都**不得**脱离先前状态被单独引用：裸读会让 `C`/`F` 的持有者错误地说出“结果尚未确认 / 不得展示
完成”，与 WP-O1 §6.3 的 `C|inconclusive`（保持 C、原成功）与 `F|inconclusive`（保持 F、不重新 unknown）
直接冲突。
**投影省略声明（r2 修正 ADV-05；r3 修正 FC-R2-04——改用 WP-O1 §6.3 的真实列名）**：WP-O1 §6.3 的
4（先前状态 N/U/C/F）× 7（观察）＝28 格矩阵，其**真实表头**为**『先前状态 | 新观察 | 客户端逻辑状态/动作 |
清 pending | 新 key/body/version | 下一 chunk | 业务展示/未决 owner』**七列。本包**只**投影每格
『业务展示 / 未决 owner』列中的**业务展示**语义（“该状态下可/不可对获准 client 说什么”）；该矩阵其余列——
『客户端逻辑状态/动作』『清 pending』『新 key/body/version』『下一 chunk』——属**内部动作语义**，**不在**
本包投影范围，**直接由 WP-O1 §6.3 对应格治理**，本包不另立规则、也不放宽任何格；『未决 owner』列本包
**不重新指派**。r1 曾未声明的格——`C|inconclusive`、`F|inconclusive`、`C|attempt-local`、`F|attempt-local`、
`auth suspension × {N,U,C,F}`——现已逐格在 §4.1.1 显式列出，不再依赖读者推断。

### 4.1 公开语义覆盖表

| 编号 | 观察/状态 | 可公开表达（获准 client） | 不得表达（禁止） | 依据 |
| --- | --- | --- | --- | --- |
| P-1 | 客户端本地未交付（E06）；若 L01–L08 全满足的纯本地取消 | “这次未发送”；纯本地取消成立时“本地准备已取消”，**明确非** server 终局 | 不得称原命令终局失败/无效果；不得假设无同 identity 历史；不得把本地 network0 当同 identity B0 | WP-O1 §5 E06、§6.2(1) |
| P-2 | 服务端本 attempt 已知无效果（E04）/ 可信 predispatch 拒绝（E05） | “本次尝试未产生效果 / 本次被拒绝”；既有 unknown 保留 | 不得称原命令失败/无效果；不得据此开放同身份重执行写；B call=0 不证明同 key 历史 B call/commit=0 | WP-O1 §5 E04/E05；WP-O3 RA-23 |
| P-3 | 权威 commit receipt（E01/E02）→ `C` | “原命令已接受，结果见原 receipt”，**限原 chunk/operation** | 不得称整段历史 finalized / live 已物化；不得用 delivery metadata（replayed/requestId/时序）作结果语义或真伪证据；不得由 current checkpoint 改写 | WP-O1 §5 E01/E02、I-06；WP-O3 RA-07/RA-08/RA-09 |
| P-4 | command-final no-effect（E03）→ `F` | “原命令已终局确定无业务效果”（须 P-a ∧ P-b ∧ P-c 齐备） | 不得把单次 rollback / 可见请求全失败 / 无 receipt / retryable=false 当 no-effect；不得不夸为整 session 清空 | WP-O1 §5 E03；WP-O3 RA-01/RA-02 |
| P-5 | inconclusive/unknown（E07/E08/E09，或 E11 有未排除执行窗口）——**须按先前状态限定（§4.1.1）** | `N`/`U`：→`U`“结果尚未确认 / 恢复暂不可用”；`C`：**保持 C**“原成功”，后续交付/恢复故障不重置原结果；`F`：**保持 F**“终局无效果”，不重新 unknown | `N`/`U` 不得展示完成或确定失败、不得默认 definite-failure（WP-O1 §9 O15）；**不得**把 `C` 的后续 inconclusive 说成对原成功的新否定或确定失败；**不得**把 `F` 因后续 inconclusive 重新置为 unknown | WP-O1 §5 E07/E08/E09；§6.3 `N\|inconclusive`→U、`C\|inconclusive`（保持 C）、`F\|inconclusive`（不重新 unknown） |
| P-6 | auth 暂停（401 等授权边界）——**须按先前状态限定（§4.1.1）** | `N`：suspend without disclosure，无 dispatch 证明保留、否则 `U`；`U`：latch 不变；`C`/`F`：**保持 C/F**；统一只说“需重新登录 / 当前无权取得该事实” | 不得披露 payload/receipt；不得由 401/403/404 反推“未 commit/不存在/可换 key”；不得作 existence oracle；**不得**把 auth 暂停说成对已 `C`/已 `F` 命令的降级或升级 | WP-O1 I-09、§6.3 `N\|auth`/`C\|auth`/`F\|auth`；WP-O2 §6.5；WP-O3 §7.4 O9-3 |
| P-7 | 结果不可恢复（retention/E10）——**state-relative** | `C`：曾被接受、原结果现已**不可恢复**；`N`/`U`：结果**未知**且恢复受阻；`F`：已终局关闭 | **`N`/`U` 不得表述为“曾被接受”**（false-success 披露）；不得由 absence/retention 公开为“未提交/无效果/可换 key 重做/从未存在”；不得把 `N`/`U` 与 `C` 套用同一措辞 | WP-O1 §5 E10；WP-O3 §3.4/§7.2 RA-26/RA-16 |
| P-8 | 域 result rejected（E16） | “本次尝试的域结果为拒绝”，携带**该 attempt 的拒绝范围**；**既有 unknown 保留** | 不得因 `kind=rejected` 结算全命令 failure；不得因在 2xx envelope 内就结算 success；**不得因 2xx 内的域 result rejected 清除既有 unknown（E16“既有 unknown 不清除”）**；不得把 B internal category 原样塞入 public reason/problem/fieldErrors | WP-O1 §5 E16/E18、I-02/I-10 |
| P-9 | malformed / 不相关 / 跨 scope / wrong key/body/version/operation（E11），或旧 generation 回调（E12） | “无业务内容披露”；必要时仅提示恢复受阻 | 不显示伪/跨 scope success；不披露跨 scope 内容作诊断；不据其内容结算 | WP-O1 §5 E11/E12；§6.3 `U\|malformed` |
| P-10 | C/F 冲突候选，或两个不同 original receipt（E01 与 E03 同现） | 隔离并暂停依赖流程的自动推进；交治理 | 不得 last-response-wins / 多数投票 / 按到达顺序；不得表达为正常新业务结局；不得新增公开异常码 | WP-O1 I-03/§6.3 结语；WP-O3 RA-10 |
| P-11 | 导航 / 页面 / 本地存储成功或失败（E14，local completion，**§6.1 四项正交状态之一**） | 后端已终局（`C`/`F`）时只恢复**本地**工作（绑定原 principal）；未终局（`N`/`U`）时仍按原 pending 状态 | **不得**把导航/页面成功当作业务成功；**不得**因导航/存储失败把已提交命令（`C`/`F`）重新置 unknown 或重发；不得据本地 completion 结算原命令 | WP-O1 §5 E14、§6.1（local completion 正交）、I-05/§6.4 |
| P-12 | current GET / checkpoint / latest aggregate（E13） | 只可作**当前资源快照**展示，或已结算后的下一步重新规划 | **不得**以聚合/checkpoint 归因或结算原命令；**不得**以 current checkpoint 替代 original receipt；不得据“资源消失 / version 推进 / 数量看似正确”回退或改写原结果 | WP-O1 §5 E13、I-07；WP-O3 §5.5（与 K-3/W46 同向） |

**E15/E17/E19 的显式不投影声明（r3，修正 FC-R2-03；与本节引言的“覆盖完备”声明合读）**：

- **E15（R7-A parser accepted）**：属 caller DTO 的本地 canonical/shape/resource 合法性判断，**无 settlement
  authority**。本包**显式不新增独立 P 行**（非遗漏）：其公开语义只停在“尚须经后续授权/执行资格判断”这一
  层，无终局可表达（WP-O1 §5 E15）。
- **E17（HTTP 4xx/5xx、ApiErrorCode、retryable、Promise outcome）**：属传输/接口层分类，**不自证证据范围**。
  本包**显式不新增独立 P 行**（非遗漏）：其公开语义已被 **PS-04/CB-9**（HTTP status/media type 不代替
  evidence scope）、**P-2**（本 attempt 拒绝）、**P-5/P-9** 覆盖；E17 自身即要求“回到 E01–E16 校验证据范围，
  没有合适证据就不结算”（WP-O1 §5 E17）。
- **E19（legacy receipt/tombstone）**：WP-O1 §5 E19 明文「**对 M2 不作投射**」。本包据此**显式不投影**
  （非遗漏）；未来若要支持“已完成但安全内容不可恢复/业务未达成”，须另行冻结结果语义（WP-O1 §5 E19）。

### 4.1.1 先前状态轴（N/U/C/F）对每一观察的公开限定（r2 新增，修正 FC-01/ADV-05；r3 更新 P 范围与列名）

WP-O1 §6.3 是 4（先前状态 N/U/C/F）× 7（观察）＝28 格矩阵，`C`/`F` 互斥。上一节 P-1…P-12 给出的是各
观察/状态类**自身**的公开语义投影（不含先前状态限定）；下表把**每一观察在每一先前状态下的公开表达**逐格
给出（逻辑层，非 wire）。单元格中的 `P-x` 指回上一节。本表**只**投影每格『业务展示 / 未决 owner』列中的
**业务展示**语义，并在其上叠加 §4.1 P 行已载的 fail-closed 强化（如 `N|retention` 的“不得称『曾被接受』”按
原样保留）（**r4 修正 WP-O4-R3-AUTH-01；r5 补齐 FC-R4-02/AUTH-R4-02/ADV-R4-01：下表各格直接投影该列文本、
不再填『客户端逻辑状态/动作』内容**）；WP-O1 §6.3 的其余列
（『客户端逻辑状态/动作』『清 pending』『新 key/body/version』『下一 chunk』）属**内部动作语义**，**不在**
本包投影范围，**直接由 WP-O1 §6.3 对应格治理**，本包不另立规则、也不放宽任何格（『未决 owner』列本包
不重新指派）。

| 先前状态 ╲ 观察 | attempt-local rejection/no-effect | authoritative commit receipt | command-final no-effect | inconclusive / unknown | malformed / unrelated | auth suspension | retention-unavailable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **N** | 仅“本次未发送/被拒绝”，不称原命令终局失败（P-1/P-2） | 原 chunk/operation 成功；非整段历史自动成功（P-3） | 原命令终局无业务效果；不夸大成全 session 清空（P-4） | “结果尚未确认”；不展示完成/确定失败（P-5） | 无响应业务内容披露（P-9） | 仅登录/恢复提示，不猜业务成败（P-6） | “原结果无法恢复/仍未确认”，不是确定失败；不得称“曾被接受”（P-7） |
| **U** | 可说本次拒绝并明确原结果未确认；不能业务失败（P-2） | 原 chunk/operation 成功（P-3） | 原命令已确定无效果（P-4） | 未确认 / 恢复暂不可用（P-5） | 不显示伪/跨 scope success（P-9） | 不披露旧 payload/receipt（P-6） | “结果不可恢复，原命令未结算”；state-relative（P-7） |
| **C** | 保持原成功；可单独显示本次恢复失败（P-5/P-6 修正要点；WP-O1 §6.3 `C\|attempt-local`） | 原成功不重复提示；不同 receipt 交治理隔离（P-3/P-10） | 不将已提交显示为 failure（P-10） | 原成功；本地/交付问题单独说明（P-5） | 原成功，仅以已授权安全内容展示（P-9） | 是否仍可展示安全历史由 auth owner 定（P-6） | 可展示已有获准结果；不补造丢失 receipt 内容（P-7） |
| **F** | 原命令终局无效果（P-5 修正要点；WP-O1 §6.3 `F\|attempt-local`） | 不展示新 success（P-10） | 终局无效果不重复副作用（P-10） | 原终局无效果，不重新 unknown（P-5） | 不显示不相关成功或内容（P-9） | 仅 auth 提示；终局内容可见性待 Q08（P-6） | 已知终局与不可恢复能力分别说明（P-7） |

**本轮显式补齐的格（r1 未声明、被 FC-01/ADV-05 点名）**：`C|inconclusive`（“原成功”）、
`F|inconclusive`（“原终局无效果，不重新 unknown”）、`C|attempt-local`（“保持原成功；可单独显示本次恢复失败”）、
`F|attempt-local`（“原命令终局无效果”）、`auth suspension × {N,U,C,F}`（P-6 的四态限定）。
（**r4 修正 WP-O4-R3-AUTH-01；r5 补齐 FC-R4-02/AUTH-R4-02/ADV-R4-01**：上表各格直接投影 §6.3『业务展示』
文本、不再填『客户端逻辑状态/动作』内容，个别格叠加 §4.1 P 行 fail-closed 强化；括号内 `P-x` 指回 §4.1——
该行本身即承载相应『业务展示』语义。）冲突格
（`C|authoritative commit` 不同 receipt、`C|command-final no-effect`、`F|authoritative commit`）统一由
P-10 隔离并交治理，不 last-response-wins。

### 4.2 顶层公开语义不变量（本节的收敛）

- **范围显式（r2 修正 ADV-06；r3 修正 FC-R2-02——轴集必须与 WP-O1 §6.1/§6.3 一致且完备）**：范围**不是
  单值枚举**，而是「**结果轴** × **观察** × **正交状态**」的**组合**：
  - **结果轴**（WP-O1 §6.1 的四缩写 N/U/C/F 在结算后的终局取值）：attempt-local / command-terminal
    (`C`/`F`) / inconclusive(`U`)。
  - **观察**（WP-O1 §6.3『新观察』列，恰 7 值）：attempt-local rejection/no-effect、authoritative commit
    receipt、command-final no-effect、inconclusive/unknown、malformed/unrelated、auth suspension、
    **retention-unavailable（E10）**。**任一观察可与任一先前状态组合**；特别是 retention-unavailable 与
    auth suspension 可与任一结果状态叠加（如 `C + retention-unavailable`，见 P-7 的 state-relative 规则）。
  - **正交状态**（WP-O1 §6.1 明列的**四项**，非两项）：**auth 可用/暂停**、**attempt 活跃/结束**、
    **恢复可用/受阻**、**local completion（E14）**。这四项与结果轴**正交**，可叠加于任一结果状态。
  **注意（r3 修正 FC-R2-02）**：retention-unavailable 是 §6.3 的**观察列（E10）**，**不是** §6.1 的正交
  状态；auth suspension 同时以 §6.1 正交状态（auth 可用/暂停）与 §6.3 观察两种面目出现——本包按“观察”
  投影其公开语义，按“正交状态”要求载体可叠加表达。因此载体必须能表达上述**组合**，**不得**把 `C` 与 `U`
  压成同一个“retention-unavailable”值，也不得把某一结果状态与任一**观察/正交状态**设为互斥。任何单一
  信号（status、ok、retryable、replayed、requestId）**都不自证范围**（WP-O1 I-04）。
- **状态单调（r2 修正 FC-01(iii)）**：`C` 不因较弱/迟到/unknown 降级；`F` 不因后来 commit 候选升级；
  `N`/`U` 不得换 key/body/version（WP-O1 I-03；WP-O3 §8 投影）。补充两条 r1 遗漏的单调方向：
  (i) `F` **不得被 inconclusive/attempt-local 观察改写**——后续交付/恢复不明不重开已关闭命令
  （WP-O1 §6.3 `F|inconclusive`/`F|attempt-local`）；(ii) `C` 收到 attempt-local 拒绝时**保持 C**，只可
  “单独显示本次恢复失败”，不得把它读成原命令的降级（WP-O1 §6.3 `C|attempt-local`）。
- **`N`→`U` 强制**：存在 dispatch 或交付不明窗口时必须公开为 `U`（“结果未确认”），**不得**停留原 `N` 的
  “似乎清楚”表达（WP-O1 §6.3 `N|inconclusive`；WP-O3 RA-24）。
- **false-success 禁止**：任何状态都不得把缺失证据当成功；尤其 `N`/`U` **不得**被公开为“曾被接受”
  （WP-O3 RA-26，r2/r3 修正）。这是本包最硬的公开语义约束。

### 4.3 与已决项的关系（不重开 Q01/Q02/Q08、Q03/Q04/Q06/Q09）

- **Q01**：公开语义所引用的“原命令”必须是 exact identity key + request binding；body/版本改动不得移动
  namespace，公开表达不得把同 key 不同 binding 说成同一结果的另一投递。
- **Q02**：纯本地取消（L01–L08）是唯一不需服务端 command-final evidence 的窄例外（P-1），本包不重开其条件。
- **Q03/Q04**：`F` 的三谓词（P-a/P-b/P-c）与 `C` 的原子接受/结果语义是**已决输入**，本包只规定其**公开表达**，
  不重新裁定其成立条件。
- **Q06/Q09**：只查不写、non-reuse landmark、结果可恢复性与身份可复用性分离是已决输入，本包按其规定
  retention 公开语义（P-7）。

## 5 Q05 候选答案 — 载体义务

本节给出**任何获准载体**（envelope / route / media / 响应形态）必须满足的**性质**，并评估**当前 envelope
是否满足**。**不冻结**任何具体 DTO/field/status/reason/ordinal/route；具体取值仍归 G-ENV/G-OUT 正式冻结
（本包显式再递延，理由见 §5.4）。

### 5.1 载体义务表

| 编号 | 载体义务（property） | 解除该义务的真实证据（当前均为 0） |
| --- | --- | --- |
| CB-1 | **范围显式**：载体必须使 §4.1/§4.1.1 的 P-1…P-12 范围（**结果轴 × 观察 × 四项正交状态**，非单值）对获准 client **可区分、且不互相冒充**；没有任何单一信号可替代范围 | 一份获准的语义容器设计 + 跨范围动态反例（W38/W41/W44）证明“attempt-local 不被读成 command-terminal”，且“`C` 与 `U` 在 retention-unavailable 下不被压成同一值”，且 §6.1 四项正交状态（auth 可用/暂停、attempt 活跃/结束、恢复可用/受阻、local completion）可叠加表达 |
| CB-2 | **authority 溯源**：载体**只表达已获 authority 的事实**（结果轴 `C`/`F`/`U`/`N`；观察态恢复受阻、结果不可恢复；正交状态 auth 可用/暂停、恢复可用/受阻等）；载体不得制造/补造 authority | 一份获准的投影规则 + 证明载体字段只能由服务端权威记录派生（不得由 client 或 caller 布尔补造） |
| CB-3 | **不泄漏内部类别**：B internal category（R7B.*、TRANSACTION_ABORT、ALREADY_FINALIZED、OUTCOME_UNKNOWN 等）**不得**原样成为 public reason/problem/fieldErrors，也不做“类别→终局”映射 | 一份 public 投影映射（internal→public 语义，而非 1:1）+ **两个分别覆盖两半的**反例：**W52 覆盖前半**（内部类名不得原样上 wire），**W41 覆盖后半**（不做类别→终局映射，仅就 domain `rejected`）。r2 修正 ADV-03：单靠 W41 不足以解除 CB-3 前半 |
| CB-4 | **相关性/entitlement 可验证**：载体必须让 client **能验证** problem↔receipt↔command 的相关性与自身 entitlement；不得要求 client“信任” | 见 §6 的关联证明义务解除证据；反例 W42/W43 |
| CB-5 | **fail-closed / 不过度声称**：无证明时载体表达必须取**较弱/未确认**一侧；不得默认 definite-failure | 反例 W39（N/U 不得称“曾被接受”）、W45（no-response 不得 definite-failure） |
| CB-6 | **单调与非冲突**：载体表达必须支持 `C` 不降级、`F` 不升级、冲突候选隔离暂停 | 反例 W48/W49/W51；WP-O1 I-03；WP-O3 RA-10 |
| CB-7 | **state-relative 披露 + 无 existence oracle**：retention 后可公开事实随状态而异；auth/entitlement 失败只能“当前无权取得该事实”，不得泄漏存在性 | 一份获准的公开语义 + 无 existence oracle 反例（W40/W50）；WP-O3 §7.4 O9-3 |
| CB-8 | **original receipt 的公共安全投影须另设 envelope**：若需公共安全投影，必须是**语义上不是原 receipt** 的独立授权 envelope；**禁止运行时删字段**把原 receipt 投影成“公共安全版本”以绕过冲突 | 一份获准的独立投影 envelope 设计（非本包）+ 反例 W47 |
| CB-9 | **信号不冒充范围**：HTTP status（2xx/4xx/5xx）与 media type 不得代替 evidence scope；`reply.finish` 不得推定 client receive；不得因 B 内部类名增加 public reason | 反例 W38/W41；WP-O1 §8 HTTP contract owner 行 |
| CB-10 | **无 response 分支必须被允许并可被表达**：载体必须允许“无响应”为一个合法公开结果，且不强迫 C 伪造一个错误 enum | 反例 W44/W45；R7-C r1 **§8 正文（line 141）与 §12（line 249）**（允许无 HTTP response，client 保持 unknown）；§9（line 158）仅承载“到期仍 unknown” |

### 5.2 当前 envelope 的评估（为什么现有载体不足）

1. **范围不可分**：现有成功 envelope `{ok:true,data,meta}` 与 problem `{ok:false,…}` 是**互斥 strict union**
   （§2.1）。域 result `rejected` 作为 2xx `data` 会被通用 consumer 读成 `ok:true` 的成功；problem 则无法携带
   “域判定覆盖本 attempt”这一范围。二者**都不能**同时表达 P-3/P-4/P-5/P-8 与 attempt-local 的区别 → CB-1 不满足。
2. **相关性不可验证**：problem 无 meta、无 idempotency，只有 `requestId`（且该 `requestId` 由 `genReqId` **采纳
   调用方提供的 `x-request-id`**、**不保证逐次投递唯一**，因而它连稳定的“这次投递”标识都不成立，见 §2.1）；而
   `originalRequestId` 只在成功 `meta.idempotency` 里（两者位置均见 §2.1 对 `api.ts` 的**代码事实**，
   **非** WP-O2——WP-O2 全文不含 `originalRequestId`）。因此**problem 侧没有任何命令身份/绑定字段**供 client
   证明关联 → CB-4 不满足。注：本包**不**把「requestId 对 originalRequestId」当作一条**来自上游的二分**；
   它只是 §2.1 的代码观察，其上游承载仅 **WP-O2 §5.2 正文 + D07**（“只作 correlation，不证明完整 attempt set”）。
3. **客户端启发式违反 fail-closed（r2 修正 ADV-02；r3 补成功侧，修正 FC-R2-01）**：`dispositionForOutcome`
   （`idempotency.ts` **L371–410**）中**真正在无服务端 authority 时自行制造终局**的分支，**失败侧三条 +
   成功侧一条，共四条**，M2 **不得继承**：
   - **(a) 失败侧**：`apiError` 且 `status < 500` → `definite-failure`（L384–387，含 4xx/409）；
   - **(b) 失败侧**：`{kind:'failed', executionUnknown === false}` → `definite-failure`（L389–392，凭一个
     `executionUnknown===false` 布尔就宣布确定失败）；
   - **(c) 失败侧**：**末尾 unknown-kind fallback** `return 'definite-failure'`（L409，任何未识别的 kind
     都被默认成确定失败）；
   - **(d) 成功侧（r3 补，与 r1 ADV-02 在失败侧所指为同一类缺陷，只是落在成功侧）**：`api-client.ts`
     **L115–135** 把**任何 envelope 合法的 2xx** 分类为 `kind:'success'`；`dispositionForOutcome` 的
     **成功分支（L394–408）**又把 `kind:'success'`（连同 `created/consumed/joined/updated/changed/linked/
     archived/restored/removed/revoked` 等同族 kind）→ `'completed'`。于是 **2xx 内携带 attempt-local 域判定
     （`data.kind='rejected'`，E16）**、或**一个未经 E01/E02 authority 校验的 2xx**，都会被公开表达为
     「命令完成 / 成功」——这正是 FC-R2-01 指出的 **2xx success-disclosure** 路径。
   反之，`transportError`/`malformedResponse` → `unknown`（L378–383）**是 K-1/P-5 下正确的 fail-closed
   映射，必须保留**，不属于“自行制造终局”。r1 把它误列入“停止沿用”清单（过宽），又遗漏 (b)(c)（过窄）；
   r2 补齐失败侧三项却**漏掉成功侧**（FC-R2-01 命中）。上述四条分支同样违反 CB-5；其中 (d) 另违反
   **P-3**（非 E01/E02 authority 的 2xx 不得结算 command success）与 **P-8**（2xx 内域 `rejected` 不得结算
   success）。本包只声明 M2 不得继承，不修改 legacy 产品。
4. **无关声明码**：`PRECONDITION_FAILED`/`SAFETY_BLOCKED`/`RATE_LIMITED` 从未抛出，不能作为公开语义的承载；
   现有 18 码中**没有** recovery-unavailable / result-unrecoverable / command-terminal 的语义位 → 不得把新语义
   塞进现有码（WP-O3 §5.5 同向）。
5. **strict 契约的代价**：任何字段新增都是契约变更（strictObject 拒绝多余字段），因此 Q05 的载体内涵
   **必然**是“新增授权 envelope 或经正式 contract freeze 的语义扩展”，不能靠运行时接线补足。

### 5.3 载体方向的候选（均不冻结）

在**逻辑层**，可安全声明的是二选一（或组合）的**方向**，不落具体形状：

- **方向 A — 独立范围标记**：授权载体显式声明“本响应的证据范围”。**该范围不是单值枚举**：它由
  **结果轴**（attempt-local / command-terminal(`C`/`F`) / inconclusive(`U`)）与**观察**（含
  retention-unavailable(E10)、auth suspension 等 §6.3『新观察』7 值，可叠加于任一先前状态）、以及
  WP-O1 §6.1 的**四项正交状态**（auth 可用/暂停、attempt 活跃/结束、恢复可用/受阻、local completion）组成
  （§4.2）。载体必须能表达 `C + retention-unavailable` 之类的**组合**、且能叠加四项正交状态，不得把
  `C` 与 `U` 压成同一个“retention-unavailable”值（r2 修正 ADV-06；**r3 修正 FC-R2-02**——正交状态为四项、
  retention-unavailable 属观察列）。需解除 CB-1/CB-3/CB-5。
- **方向 B — 独立 envelope 家族**：为 attempt-local 域结果与 command-terminal 结果分别设**不同的授权 envelope**
  （例如“域判定 envelope”与“命令终局 envelope”语义分离）。需解除 CB-1/CB-8（投影另设）与 CB-9。
- **方向 C（替代 A/B）**：若无法建立可靠载体，则**保持 route 不接入**——即 WP-O1 Q05 原文“无可靠载体 route
  不准入”的诚实结论（见 §8）。

**关键禁止**：任何方向都**不得**通过运行时删改 original receipt 字段来制造“公共安全投影”（CB-8/W47）；
不得把 B internal category 直接上 wire（CB-3/W41）；不得让 HTTP status 承担范围语义（CB-9）。

### 5.4 显式再递延与其理由（被交办义务 (i)）

本包**显式再递延**具体 public DTO/field/status/reason/route 的**取值冻结**到 G-ENV/G-OUT 的正式 contract
freeze，理由：**(1)** 硬约束禁止本包冻结任何字段/状态/码/route；**(2)** strict envelope 的任何字段新增都是
契约变更，须成对更新 enum/status map/title/client 文案与 `commonErrorResponses`，否则违反
`api.problem.status-code-consistency.v1`；**(3)** 无真实 runtime/HTTP/B 证据前冻结具体形状会把设计猜测写成
合同。本包只解除 Q05 的**语义与义务**部分，**不**声称已关闭 Q05/G-ENV/G-OUT。

## 6 Q05 候选答案 — problem 与 receipt 的关联证明义务

Q05 问：“problem 与 receipt 关联如何证实？”**答：必须被证明，不得被假设。**

### 6.1 关联的定义（逻辑层）

“problem 与 receipt 关联”指：某条 problem 响应、某个 receipt（E01/E02）与**同一个原 logical command**
（Q01 的 exact identity key + request binding）**属于同一命令**，且当前请求对该事实有**当前 entitlement**。
关联不是“同一个 key 文本”“同一次投递”“同一个页面动作”，而是**服务端权威绑定**下的同一性。

### 6.2 关联的证明义务（O5-3）

| 义务 | 内容 | 解除证据（当前为 0） |
| --- | --- | --- |
| O5-3a | **来源权威**：关联只能由服务端**权威绑定记录**（原命令身份 + request binding 的持久关联）建立，不得由 caller 提供 | B 侧权威 command record 的真实证据（属 G-BACKEND，另授权） |
| O5-3b | **release point 单点**：关联必须在**单一 release authorization point**、在当前 receipt entitlement（Q08）下重验；不得“查完权限即缓存、稍后无保护发送” | 一份 release point 设计 + 并发反例（W42/W43） |
| O5-3c | **禁止替代证明**：`requestId` 回显、HTTP status、key 文本相同、时间/位置相邻、“当前只有一个 pending 命令”、`replayed` 标志**均不得**充当关联证明 | 反例 W42 证明上述任一单独出现都不足以建立关联 |
| O5-3d | **失败即 E11**：无法证明关联的响应无 settlement authority；按 E11 丢弃其结算与页面副作用，不据其内容披露 | 反例 W43（problem 与 receipt 指向不同 identity/binding） |
| O5-3e | **无 existence oracle**：关联失败（含 auth/entitlement 失败）只能表达“当前无权取得该事实”，不得泄漏某命令是否存在/是否 commit | 反例 W50；WP-O2 §6.5 |

### 6.3 证明与“假设”的分界

- **可以安全假设的仅是**：服务端会为响应回显请求侧的 `requestId`（调用方提供合法 `x-request-id` 时即为
  该值，否则为服务端生成值，§2.1）。**不能安全假设**的是该回显能标识“同一次投递”：因 `genReqId` **采纳
  调用方 `x-request-id`**（`app.ts` L202–223），调用方**可以**在多次投递上提供同一 `requestId`，故
  `requestId` 相等**既不唯一标识投递、也不证明投递**；它至多是一条**相关性提示**。（r4 已在 §2.1/§5.2(2)
  收窄此点，本节与 §3.3/§10 W42/PS-20 按同一口径统一。）
- **不得假设**的是“该响应与某原命令的 receipt 属于同一命令”——这需要 §6.2 的服务端权威关联（Q01 的
  exact identity key + request binding）与 entitlement 重验。
- 因此，**命令身份的关联证据不得由 `requestId` 的相关性提示顶替**（更不得由任何被夸大的“投递相关性”
  顶替）。其上游承载是 **WP-O2 §5.2 正文**——
  它把「HTTP requestId」（连同 client attempt ordinal/id、socket、promise、auth generation、server worker id、
  DB connection/transaction id）列为**只可作 correlation、不定义集合**——及其**投影 WP-O2 D07**
  （“client/server attempt id 与计数只作 correlation，不证明完整 attempt set”）。
  **r2 更正（ADV-01/F1）**：r1 曾误引为「WP-O2 D10 的 requestId/originalRequestId 二分」——D10 实为
  “unknown 跨 attempt 单调；generic status/error/retryable/deadline 不清除”，且 WP-O2 全文**不含**
  `originalRequestId`。**r3 收窄（FC-R2-05）**：r2 曾在此写下「本包不使用任何未在 WP-O2 出现的二分」，
  该括注**过宽**——它与本包 §5.2(2) 仍以「成功 `meta.idempotency` 的 `originalRequestId`」描述 problem
  相关缺口、且 §2.1 确实读到该字段并存。故 r3 只主张**已被更正的那一点**：本包**不把**「requestId /
  originalRequestId」**归属为来自 WP-O2 的二分**；§5.2(2) 描述的“`originalRequestId` 只在成功 `meta` 出现”
  是 §2.1 的**代码事实**（WP-O2 全文无此词），命令身份关联的上游只是 WP-O2 §5.2 正文 + D07。

## 7 Q05 候选答案 — 无 response 对 consumer 的约束

Q05 问：“无 response 如何约束 consumer？”**答：允许无 response；consumer 必须 fail-closed 地保持 unknown。**

### 7.1 无 response 情况下的公开表达

- **允许没有 HTTP response**（如 commit outcome unknown、取消未确认、连接结果不明时）。此时**不得**用一个
  伪造的错误枚举（malformed/INTERNAL_ERROR/普通 409 等）宣布确定失败。出处为 **R7-C r1 §8 正文
  （line 141：“client abort 明确允许『无 HTTP response』”）与 §12（line 249：“commit outcome unknown 或
  client abort … client abort 允许无 HTTP response；unknown 保持未决”）**；§9（line 158）只承载“到期仍
  unknown”，**不**承载“允许无 HTTP response”（r2 修正 ADV-07）。
- 公开/本地表达只能是“**结果尚未确认 / 恢复暂不可用**”（即 `U`）。

### 7.2 consumer 必须承担的约束（O5-4）

| 编号 | 约束 | 依据 |
| --- | --- | --- |
| K-1 | **默认 unknown**：无响应时保持 `U`；不得推断确定失败，也不得推断成功 | WP-O1 §5 E07、§6.3 `N\|inconclusive`→`U` |
| K-2 | **不换 key / 不重做写 / 不建新 session**：恢复只在原身份下经获准通路；不得凭 miss/timeout 重做写 | WP-O1 I-08；WP-O3 RA-11/RA-23 |
| K-3 | **不以 GET/current checkpoint 反推 receipt** | WP-O1 I-07、E13；WP-O3 §5.5 |
| K-4 | **保留原身份与原 binding**：原 key/body/version 不得变；不在无终局时换名称空间 | WP-O1 I-01/I-08；WP-O2 D02 |
| K-5 | **unknow latch 独立于 in-flight**：跨 attempt unknown 是独立 latch，后续仅覆盖本 attempt 的 400/401/403/404/409/413/415/429 或 parser/query/auth/admission 拒绝**不得**清除它；**同类地，2xx envelope 内的域 result `rejected`（E16 的 domain 半）亦不得清除既有 unknown** | WP-O1 §4.2 I-02、§5 E16；R7-C §11 正文（line 228）；WP-O3 RA-13 |
| K-6 | **absence 不产生 no-effect，也不产生 commit**：无响应/查不到既不是“未提交”也不是“曾被接受” | WP-O1 §5 E10；WP-O3 RA-16/RA-26 |
| K-7 | **本地超时 ≠ 服务端 deadline**：client 15s 超时不得当作服务端 deadline、receipt retention 或总 retry deadline | R7-C §9/§11 正文；R7-C r1 fresh review §4 |
| K-8 | **`reply.finish` 不证明 client 收到**：服务端 finish 不改变“client 未实际验收则仍 `U`” | WP-O1 I-05、§8 |
| K-9 | **latch 须能跨重启保留**：unknown latch 不得因进程重启/身份重绑而消失（否则等价于“首次”误判）；具体 durable 机制属 Q07 | WP-O1 §6.2(3)、O16 |

### 7.3 与“客户端本地未交付”的分界

只有**完整证明从未越过 transport handoff**（L01–L08，Q02）才允许把“这次未发送”作为公开表达（P-1）；
只要存在 dispatch 或交付不明窗口，即按 §7.2 保持 `U`。**不得**用“本地 network0”填补“同 identity 是否有历史
服务端执行”的空白（WP-O1 O13）。

## 8 consumer 对账与准入

Q05 的顺序是**先语义覆盖，再载体，再 consumer 对账**。对账指：consumer（client）对**同一份获准语义**给出一致
的 disposition 与关联保证，使 client 不再自行制造终局。需对账的 legacy 制造终局分支**至少四处**（失败侧
三条 + 成功侧一条，r3 修正 FC-R2-01）：`dispositionForOutcome` 的 `apiError`(status<500)→definite-failure、
`{kind:'failed', executionUnknown===false}`→definite-failure、末尾 unknown-kind fallback→definite-failure，
以及**成功侧**——`api-client.ts` 把任何 envelope 合法的 2xx 记为 `kind:'success'`、再由
`dispositionForOutcome` 成功分支→`'completed'`（使 2xx 内域 `rejected` 或未经 E01/E02 authority 的 2xx 被
公开为“命令完成/成功”）；同时 client 必须**保留** transportError/malformedResponse→unknown 这一 fail-closed
映射。对账还须覆盖 **E14 local completion**（导航/页面/本地存储）：后端已 `C`/`F` 时本地失败只恢复本地
工作，**不得**因此把已提交命令重新置 unknown 或重发、也不得据导航成功结算业务成功（P-11）。成功侧的
disposition 也必须以 §4/§5 的“结果轴 × 观察 × 正交状态”为准，不得再以 2xx/`ok:true` 单值顶替范围。

### 8.1 对账顺序与依赖

```text
1. 语义覆盖（本包 §4）：确定结果轴（attempt-local / command-terminal / inconclusive）× 观察（§6.3 七值，
   含 retention-unavailable / auth suspension）× §6.1 四项正交状态的公开范围及其 fail-closed 表达
2. 载体义务（本包 §5）：确定任何载体的 CB-1…CB-10 及解除证据
3. consumer 对账（Q07 + G-CLIENT）：client 对同一语义给 disposition/关联/unknow latch 保证；停用失败侧
   与成功侧共四条「自行制造终局」分支（§5.2(3)、§8）
4. 真实联合证据（Q11）：同 candidate/operation/policy-version 的 HTTP/runtime/B 证据
```

### 8.2 “无可靠载体 route 不准入”作为 gate 条件的精确含义

一条 replay route 的准入（G-ROUTE/G-ENV/G-OUT 的相关部分）在以下**合取**全部成立前**为否**：

- **G1 载体存在且已冻结**：存在一份**已获准并正式冻结**的载体设计，满足 CB-1…CB-10；若只有方向（§5.3 A/B）
  而无冻结，则**不准入**。
- **G2 authority 可提供**：B 能对 `C`/`F`/`U`/retention 提供可复核的权威事实（依赖 G-BACKEND、WP-O3 §5.4/§6.4/§7.4）。
- **G3 关联可验证**：problem↔receipt↔command 的关联可按 §6.2 被 client 验证（依赖 G-ID/G-AUTH）。
- **G4 entitlement 可重验**：release point 与 receipt entitlement 可在服务端重验（依赖 G-AUTH、WP-O2 §6.4）。
- **G5 无 existence oracle**：auth/entitlement/关联失败不泄漏存在性（反例 W50 通过）。
- **G6 consumer 对账完成**：client 停止自行制造终局（K-1…K-9、Q07）。
- **G7 真实证据齐备**：同 candidate/operation/policy-version 的真实 HTTP/runtime/B 证据（Q11；当前 T01–T50=0）。
- **G8 non-reuse 不静默依赖 namespace 相等（承 WP-O3 §7.2.3/§7.4/§12 的命名开放义务 O9-5 与 RA-27；r4 新增，
  修正 ADV-R3-01）**：Q01 令 `identityPolicyVersion` 是 identity key 成员，故版本升级/重新登录会**移动
  namespace**；在 Q10 关闭前，须提供 WP-O3 O9-5 的可独立核验证据——non-reuse landmark 跨 identity/版本重绑
  仍存活，**或**由 Q10 的显式边界约束（旧 unknown 未解决前，旧身份不得被当作新空间执行）。该义务未解除前，
  O9-5 **保持 admission blocker，不得写成 gate closed**。

任一未满足，即“**无可靠载体 route 不准入**”，相关 G-* 保持阻断；**不得**用“语义已写清楚”冒充载体已准入；
亦**不得**因本包已写清业务展示语义而读成 O9-5 已闭合。

## 9 Owner contract 与后续顺序

### 9.1 Owner contract（显式交叉引用 WP-O3 §9）

| owner | 本候选要求的输入/输出 | 本候选不决定 |
| --- | --- | --- |
| Identity / G-ID（承 WP-O3 §9 Identity 行；**并承接 WP-O3 O9-5**） | 使公开载体所引用的“原命令”绑定 exact identity key + binding；保证 body/版本改动不移动 namespace；**并使 non-reuse 不静默依赖 namespace 相等**（版本/重登移动 namespace 时 landmark 须跨重绑存活或由 Q10 边界约束，O9-5）；关联证明所需的服务端权威关联（O5-3a） | DB 列/index、raw body retention、digest 实现、版本/边界机制（属 Q10） |
| Auth / G-AUTH（承 WP-O3 §9 Auth 行） | 提供 release point 与 receipt entitlement 的重验能力，使关联可被 client 验证（O5-3b/O5-3e）；保证失败不泄漏存在性 | capability 名字、SQL/RLS、错误载体 |
| B / G-BACKEND（承 WP-O3 §9 B 行） | 提供可复核的 `C`/`F`/`U`/retention 权威事实与**原命令关联记录**（O5-3a），供公开载体安全派生 | schema、锁、isolation、cancel 实现、retention/GC 数值 |
| HTTP-Out / G-OUT·G-ENV（承 WP-O3 §9 该行原文） | **只表达已获 authority 的事实**（`C`/`F`/`U`/`N`、恢复受阻、结果不可恢复），并让 client 能验证 correlation/entitlement；承载 §4 按先前状态（§4.1.1）限定的“结果轴 × 观察 × 四项正交状态”可分公开语义与 §5 的 CB-1…CB-10 | public DTO/status/reason/route（本包在语义层覆盖，取值冻结仍留 G-ENV/G-OUT，见 §5.4） |
| Client / G-CLIENT（承 WP-O3 §9 该行原文） | once-serialized exact bytes、原身份恢复通路、cross-attempt unknown latch、不凭 miss/timeout 重做写；对 §4 同一语义给出 disposition 与关联保证（§7.2/§8） | storage format、adapter API、retry 时间、restart 实现 |

### 9.2 最小后续顺序（承接 WP-O3 §9 L574–588）

```text
1. Q01/Q02/Q08（已决）→ 身份、attempt 全集、entitlement 边界
2. Q03/Q04/Q06/Q09（WP-O3，已决为设计准备）→ fence/receipt/恢复/retention 语义
3. Q05（本包，P-1…P-12 语义覆盖 + CB-1…CB-10 载体义务）→ G-OUT 语义与 G-ENV 表达互校
4. G-ENV/G-OUT 正式 contract freeze → 冻结具体载体（本包不冻结，§5.4）
5. Q07/Q10 → client durable state、restart、版本兼容
6. 获新授权后 Q11 → 真实 HTTP/runtime/B 联合证据
7. 总控按 Q12 独立判断准入
```

若任何 owner 的真实证据反证本包候选，必须回到对应 owner 修订，**不能让 HTTP/client 猜测结果**。本包不得被
写成 gate closed。

## 10 Written counterexamples（W-series，未执行）

以下 W38–W52 延续 WP-O3 的 W19–W37 编号，均为 Fresh Review 与未来动态测试的**书面 oracle**，执行数 0。
（r2 新增 W52，用于覆盖 CB-3 前半——内部类名不得原样上 wire；见 ADV-03。）

| ID / 场景 | 推荐行为 | 不得结论 |
| --- | --- | --- |
| W38 attempt-local 4xx/409/413/415/429 被公开为原命令 definite-failure | 只表达“本次尝试被拒绝/未产生效果”；原命令保持原状态 | 不得把 attempt-local 拒绝当 command-terminal failure；不得清未知 latch |
| W39 `N`/`U` identity 的公开表达写成“曾被接受” | 只表达结果未知/恢复受阻（state-relative） | 不得把缺失证据当成功（false-success 披露） |
| W40 `U` 命令因 retention 不可读 | 表达“结果不可恢复/仍未确认”，保留 non-reuse landmark | 不得由 absence 推出“曾被接受”或“未提交/可重做” |
| W41 域 result `rejected` 出现在 2xx envelope | 视为 attempt-local 域判定；不据其结算命令 | 不得因在 2xx 就结算 success；不得因 `kind=rejected` 结算 command failure |
| W42 仅凭 `requestId`/status/相邻时间就把 problem 归因某命令 | 要求服务端权威关联（O5-3a/b） | 不得假设关联；不得由 `requestId`（至多一条相关性提示，调用方可指定、不证投递唯一）顶替 Q01 的 exact identity key + binding 关联 |
| W43 problem 与 receipt 指向不同 identity/binding | 按 E11 丢弃该响应的结算与副作用 | 不得择一结算；不得据其内容披露 |
| W44 无 response 后收到仅覆盖本 attempt 的 4xx | 保持 `U`；原身份只读恢复 | 不得清除既有 unknown latch；不得换 key |
| W45 无 response 被客户端默认 definite-failure | 保持 unknown（“结果尚未确认”） | 不得发明确定失败枚举；不得换 key 重做 |
| W46 客户端用 GET/current checkpoint 反推 receipt | 视为 E13，不结算原命令 | 不得以当前聚合替代 original receipt；不得回退历史 |
| W47 以运行时删字段把 original receipt 投影成“公共安全版本” | 须由 Q05/G-OUT 另设独立 envelope（CB-8） | 不得声称该投影就是原 receipt；不得借投影绕过冲突治理 |
| W48 `C` 命令收到貌似 E03 的 no-effect | 隔离并暂停，交治理 | 不得把已提交 C 降级为 failure |
| W49 `F` 命令收到貌似权威 commit | 隔离并暂停，交治理 | 不得把已终局 F 升级为 success |
| W50 auth/entitlement 失败被公开成“该命令不存在/未提交” | suspend without disclosure | 不得作 existence oracle |
| W51 C/F 冲突被公开为正常新业务结局 | 隔离、暂停依赖流程新进展 | 不得 last-response-wins / 多数投票；不得新增公开码 |
| W52 B internal category（`R7B.*`/`TRANSACTION_ABORT`/`ALREADY_FINALIZED`/`OUTCOME_UNKNOWN` 等）被原样放进 public reason/problem/fieldErrors | public 投影只表达 internal→public 的**语义**；内部类名**不出现在 wire** 的任何 public reason/problem/fieldErrors | 不得把 B 内部类名当 public 码/原因；不得以类名做类别→终局映射（CB-3 前半；W41 覆盖后半） |

Fresh Review 必须检查 W38–W52 与 WP-O1 O01–O16、WP-O2 W01–W18、WP-O3 W19–W37、R7-C T29–T50 的方向一致性。
若任何路径让 attempt-local 事实终结旧 `U`、让缺失证据被公开为“曾被接受”、让 HTTP status 或 `replayed` 冒充
证据范围、让无 response 变成 definite-failure、让 problem 关联被假设、让 B internal category 上 wire、让
original receipt 被运行时删字段投影、或让 C/F 冲突 last-response-wins，本候选应为 BLOCK。

## 11 Invariant ledger

以下为本包本地编号（`PS`=public semantics），仅用于引用。本包只承认**可核验的真实上游 id**：Q0x、E01–E19、
I-01–I-12、D01–D18、O01–O16、W01–W18（WP-O2）+ W19–W37（WP-O3）+ W38–W52（本包）、RA-01–RA-27（WP-O3）、
R7B.*、R7-C 正文出处、G-*。

| ID | 不变量 | 来源 | owner |
| --- | --- | --- | --- |
| PS-01 | 尝试局部与命令终局必须公开可分且互不冒充 | WP-O1 §6.1/§6.3；E01/E03/E04/E05 | OUT / ENV |
| PS-02 | 公开载体只表达已获 authority 的事实，不制造/补造 authority | WP-O3 §9 HTTP-Out 行 | OUT / ENV |
| PS-03 | B internal category 不得原样入 public reason/problem/fieldErrors，也不做类别→终局映射 | WP-O1 E18/I-10 | OUT / B |
| PS-04 | HTTP status 与 media type 不得代替 evidence scope | WP-O1 §8 | OUT / ENV |
| PS-05 | `reply.finish` 不证明 client 收到；delivery 不改变接受事实 | WP-O1 I-05/§8 | OUT / CLIENT |
| PS-06 | 无 response 时 client 保持 unknown；不得 definite-failure 或 success | WP-O1 E07；R7-C r1 §8（line 141）/§12（line 249）正文 | CLIENT / OUT |
| PS-07 | 跨 attempt unknown 是独立 latch；覆盖本 attempt 的后来拒绝不得清除 | WP-O1 I-02；R7-C §11 正文 line 228；WP-O3 RA-13 | CLIENT / OUT |
| PS-08 | `N`/`U` 不得被公开为“曾被接受”（false-success 禁止） | WP-O3 §3.4/§7.2 RA-26（r2/r3） | OUT / B |
| PS-09 | retention 后可公开事实 state-relative，不跨状态套用 | WP-O3 §7.2 RA-26 | OUT / B |
| PS-10 | absence/不可读既不产生 no-effect 也不产生 commit | WP-O1 E10/§6.4；WP-O3 RA-16 | OUT / B |
| PS-11 | problem↔receipt↔command 关联必须被证明，不得被假设 | 本包 §6；Q01/Q08 | ID / AUTH / OUT |
| PS-12 | 域 result rejected 是 attempt-local；不因 `kind=rejected` 结算 command failure，不因 2xx 结算 success | WP-O1 E16 | OUT / ENV / B |
| PS-13 | original receipt 公共安全投影须另设 envelope，禁止运行时删字段 | WP-O2 D17；WP-O3 §5.5 | OUT / ENV |
| PS-14 | C/F 冲突或两个不同 original receipt 隔离暂停，不 last-response-wins，不新增公开码 | WP-O1 I-03/§6.3；WP-O3 RA-10 | OUT / ENV / 治理 |
| PS-15 | auth/entitlement 失败 suspend without disclosure，无 existence oracle | WP-O2 §6.5；WP-O3 §7.4 O9-3 | AUTH / OUT |
| PS-16 | 结果可恢复性与身份可复用性分离 | WP-O1 I-12；WP-O3 RA-15 | B / ID |
| PS-17 | 本包不产出/不冻结 DTO/status/reason/route；无可靠载体 route 不准入 | Q05 原文；WP-O2 D18 | 总控 |
| PS-18 | same-identity retry 不跳门禁（route/auth/budget/B admission） | WP-O2 §5.4；WP-O3 RA-14 | B / AUTH / ROUTE |
| PS-19 | 有 dispatch/交付不明窗口时 `N` 必须公开为 `U` | WP-O1 §6.3；WP-O3 RA-24 | CLIENT / OUT |
| PS-20 | problem 关联证据不得由 `requestId` 的相关性提示（调用方可指定、不证投递唯一）顶替 Q01 的 exact identity key + request binding 关联 | WP-O2 §5.2 正文 / D07；本包 §6.3 | ID / OUT |
| PS-21 | 公开表达必须先按先前状态 N/U/C/F 限定；`C`/`F` 不被后续 inconclusive/attempt-local/auth 观察改写 | WP-O1 §6.3；本包 §4.1.1 | OUT / ENV |
| PS-22 | 与结果轴**正交**的是 WP-O1 §6.1 的**四项**状态（auth 可用/暂停、attempt 活跃/结束、恢复可用/受阻、local completion），可叠加于任一结果状态；retention-unavailable 是 §6.3『新观察』列（E10）而非正交状态，其与 auth suspension 均可与任一先前状态组合；均不得压成单值 | WP-O1 §6.1/§6.3；本包 §4.2/§5.3 | OUT / ENV |
| PS-23 | local completion（E14：导航/页面/本地存储）不是后端证据；不得据其结算，也不得把已提交命令重新置 unknown | WP-O1 §5 E14、I-05；本包 §4.1 P-11 | CLIENT / OUT |

## 12 明确未决与准入 stopline

本包只处理 Q05，未解决或未触及其余：

- **Q07 client 状态与 callback 消费**：durable client state、once-serialized 跨首次/retry、unknown latch 独立于
  in-flight、late callback 消费与 deadline/pending 清理；不新增 client port（WP-O1 §10 Q07）。
- **Q10 版本与运行期兼容**：旧 parser/identity/operation 版本能否恢复原 receipt；新 registry/serializer 不得改变
  旧 unknown；future query 政策变化须独立重审（WP-O1 §10 Q10）。
- **Q11 真实 B/runtime 证据**：commit-loss、cancel-race、early query rejection、no-response、exact 发送/关联、
  late callback、预算/日志/权限变化的联合证据；当前 T01–T50=0、本包 oracle（W38–W52）=0。
- **Q12 项目准入与发布**：M1/G2、M2 prerequisites、migration 首次确认、真实权限/N-1 与独立审计；本包不运行
  B-r4/G2，不授予实施资格。

**载体取值仍开放**：本包在语义层覆盖并给出 CB-1…CB-10，但**不冻结**任何具体 DTO/field/status/reason/route；
具体冻结仍留 G-ENV/G-OUT（§5.4 显式再递延），且**在真实证据与无 existence oracle 反例（W40/W50）通过前不得
写成已冻结**。

**十 G-* 全部保持阻断**：G-ROUTE / G-ENV / G-OUT / G-ID / G-CLIENT / G-AUTH / G-LIFE / G-BUDGET / G-LOG /
G-BACKEND 在 WP-O1/WP-O2/WP-O3 与本包中**均未解除**；B04（物理锁与撤回/GC 相容）、B05（retention/GC/recovery）、
B08（0005/N-1 实现证据）全部 open。0000–0004 永久冻结，任何新增须走 0005 且经总控确认；本包不设计 SQL/RLS/
migration。

**固定状态上限不变**：M1 = `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`（非 Accepted）；M1 Fresh Audit
A = CLEAN，household-safety 292/292 仅 LIMITED；B-r1/r2/r3 = BLOCK 且 B-r4 未运行；G2 = `G2_NOT_ADMITTED`，
source pack draft/inactive，public trust allowlist empty；M2 = `In Progress` 未 Accepted；R7-A contracts =
Accepted；R7-B = `R7-B_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`；R7-C = `R7-C_SHADOW_DESIGN_ACCEPTED /
IMPLEMENTATION_BLOCKED`；T01–T50 执行数 = 0，无任何通过结论。

**准入 stopline**：在 M1 Accepted、G2 admitted、0005 由总控正式确认、G-ENV/G-OUT 正式 contract freeze 完成、
且相关 owner 提供本包 §5.1/§6.2/§7.2 列出的真实证据之前，Q05 的候选**不得**被写成 gate closed 或
implementation-ready；任何载体字段/状态选择仍是 admission blocker。本包结论上限见 §1。

**承接 WP-O3 O9-5 的 stopline（r4 新增，修正 ADV-R3-01）**：WP-O3 登记的命名开放义务 **O9-5**（Q09 内、依赖
Q10）在本包中**原样保留、不重开 Q09**：版本升级/重新登录移动 namespace 时，non-reuse **不得**静默依赖
namespace 相等（须证明 landmark 跨身份/版本重绑仍存活，或由 Q10 显式边界约束、旧 unknown 未被当新命令执行）。
**在 Q10 关闭前，O9-5 保持 admission blocker，不得写成 gate closed**（§8.2 G8；WP-O3 §7.2.3/§7.4/§12、RA-27、
§10 W37）。

## 13 POST 与交付 identity

- **交付物**：`/Users/aipuli/Documents/Projects/meal-agent-lab/.local/wp-o4/wp-o4-public-semantics-and-carrier-decision-pack.md`
  （本文件），`READY_FOR_FRESH_REVIEW`，`DESIGN_ONLY`，中文。
- **范围**：仅回答 Q05（语义覆盖 / 载体义务 / problem↔receipt 关联证明 / 无 response 约束）；不新增也不回答
  Q07/Q10/Q11/Q12；不重开 Q01/Q02/Q08（WP-O2）与 Q03/Q04/Q06/Q09（WP-O3）。
- **authority**：设计准备材料。不关闭任何 G-*，不冻结任何 contract，不授权实现、SQL/RLS/migration、public
  DTO/status/reason/route、client port 或 runtime 接线。载体以义务（CB-1…CB-10）表达，不落具体形状。
  **r2 更新**：§4.1 现按 WP-O1 §6.3 4×7 补齐先前状态轴（§4.1.1），CB-3 增加 W52 覆盖前半，CB-10/§7.1 更正
  R7-C 出处，§5.2(3) 更正 legacy 分支清单；结论上限（§1）不变。
  **r3 更新**：§5.2(3)/§8 补成功侧「自行制造终局」分支（FC-R2-01）；§4.2/PS-22/§5.1/§5.3 正交轴集改为
  WP-O1 §6.1 的**四项**并区分观察列（FC-R2-02）；§4.1 增 P-12（E13）与 E15/E17/E19 显式递延（FC-R2-03）；
  §4.1/§4.1.1/§4 引言的投影声明改用 §6.3 真实列名（FC-R2-04）；§6.3 收窄 WP-O2 归属主张（FC-R2-05）；
  §2.1 code grounding 行号按钉住 SHA 重核（WP-O4-R2-AUTH-01）；结论上限（§1）不变。
  **r4 更新**：§4.1.1 各格改为**直接投影 §6.3『业务展示』文本**，并同步 §4 引言/§4.1 引言/§4.1.1 引言的
  P 集与 §6.3 七观察列消歧（WP-O4-R3-AUTH-01、ADV-R3-02）；§2.1 删悬空 `I02` 标签、把 `apiErrorCodeSchema`
  行号改为 `L9–29`、将 `app.ts`/`repository.ts` 纳入 §2 读取清单并按其实代码改写相关性/响应头/裸 409 断言、
  声明 `genReqId` 采纳调用方 `x-request-id`（WP-O4-R3-AUTH-02/03/04、ADV-R3-03）；§8.2 增 G8、§12 增 stopline、
  §9.1 Identity 行与 §1 递延表承接 WP-O3 O9-5（ADV-R3-01）；结论上限（§1）不变。
  **r5 更新**：§6.3/§3.3/§10 W42/PS-20 把 `requestId` 的“投递相关性”统一收窄为“**相关性提示**”（调用方可指定、
  不证投递唯一，FC-R4-01/ADV-R4-02）；§4.1.1 三格（`N\|malformed`、`N\|auth`、`F\|attempt-local`）恢复为 §6.3
  『业务展示』文本、声明同步精确化（FC-R4-02/AUTH-R4-02/ADV-R4-01）；§2 读取清单补入两份 R7-C r1 文件并附实算
  lines/bytes/SHA-256（AUTH-R4-01）；结论上限（§1）不变。
- **方法边界**：只读静态阅读 + 写作；未运行任何产品测试/DB/Node/Taro/Docker，未修改仓库，未提交 git。
- **上游一致性**：本包 §4 是 WP-O1 §5 taxonomy（E01–E19，E15/E17/E19 以显式递延声明处理）在**公开语义层**
  的投影；**§6.3 4×7 矩阵的逐格公开投影是 §4.1.1**（r4 修正 ADV-R3-02：P-1…P-12 是 E01–E19 的投影集，
  P-10/P-12 不在七观察列内、P-11 属 §6.1 正交状态）；**r2 起 §4.1.1 显式补上先前状态轴（N/U/C/F）；
  r3 起投影声明改用 §6.3 的 真实列名『先前状态 | 新观察 | 客户端逻辑状态/动作 | 清 pending | 新 key/body/version |
  下一 chunk | 业务展示/未决 owner』，并只投影其中『业务展示』语义**（内部动作列由 WP-O1 §6.3 治理）；
  §5 的 CB-1…CB-10 与 WP-O3 §9 HTTP-Out/Client 行同向，承载其交办的 Q05 义务 (i)–(iv)；另按 §1 (v) 承接
  WP-O3 的命名开放义务 O9-5（见 §8.2 G8/§12，不重开 Q09）；§10 W38–W52 与
  WP-O1 O01–O16、WP-O2 W01–W18、WP-O3 W19–W37、R7-C T29–T50 方向一致。
- **id 溯源**：只引用可核验的真实上游 id（见 §11 前言）；R7-C 的 cross-attempt unknown 只由 R7-C r1 §11
  正文（line 228）承载，「允许无 HTTP response」由 r1 §8（line 141）/§12（line 249）承载，cancellation/
  deadline 由来由 r1 §9（line 158）承载；本包不虚构 `R1-INV-*` 类标签。
- **明确的余留（给 Fresh Review）**：若本包任一候选让 attempt-local 事实终结旧 `U`、让缺失证据被公开为
  “曾被接受”、让 HTTP status 或 `replayed` 冒充证据范围、让无 response 变成 definite-failure、让 problem
  关联被假设（而非被证明）、让 B internal category 上 wire、让 original receipt 被运行时删字段投影、让 C/F
  冲突 last-response-wins、或让“语义已写清楚”被当作载体已准入，应判 BLOCK。
- **POST 核对**：本包写入前已确认输出目录 `.local/wp-o4/` 存在；写入仅为 `.local/wp-o4/` 下本文件一个普通
  文件；未修改任何 tracked 文件（`main` 工作树仍仅有既有的 ` M AGENTS.md` 未提交改动，本包不读取、不修改它）。

## 14 修订说明 (r2)

本节逐条登记 r1 Fresh Review（三 lens）的**11 条残余 P2** 及其在 r2 的处置。**所有 finding 均被本 Designer
独立复核为成立**，r2 全部沿 fail-closed 方向实质修订，**未以削弱任何 fail-closed 行为来消除 finding**。
复核方法：本地只读 `git show`（WP-O1 §5/§6.1/§6.3、WP-O2 §5.2/D07、WP-O3 §8、R7-C r1 §8/§9/§11/§12）与
只读源码（`idempotency.ts` L371–410）；未运行产品测试/DB/Node/Docker。**r2 不改结论上限**（仍为 `DESIGN_ONLY`、
`READY_FOR_FRESH_REVIEW`）。r1 现场字节身份（r0 Fresh Review §1 登记）= 490 行 / 48,207 bytes /
`0f87591d63e42de7e760aeb2a16a1c32e6c05b8c4f4297b44abe4dd2843e7e59`。

| finding id | severity / lens | 摘要 | r2 处置 | 落点（r2 行内） |
| --- | --- | --- | --- | --- |
| FC-01 | P2（fail-closed） | §4.1 自称 §6.3 4×7 投影却只有观察轴，无先前状态轴；`C`/`F` × inconclusive/malformed/attempt-local/auth 既未列也未声明省略，导致 P-5/P-6 未按状态限定、§4.2 单调不覆盖 `F` 被 inconclusive/attempt-local 改写与 `C\|attempt-local` | **已实质修订**：新增 **§4.1.1** 先前状态轴 4×7＝28 格公开投影；P-5/P-6 行改为**按 N/U/C/F 限定**；§4.2 状态单调补 (i) `F` 不被 inconclusive/attempt-local 改写、(ii) `C\|attempt-local` 保持 C 且“单独显示本次恢复失败” | §4.1.1（新增）、§4.1 P-5/P-6、§4.2 |
| FC-02 | P2（fail-closed） | 声称投影 §5 的 E01–E19，但 E14（导航/页面/本地存储 = local completion）零覆盖：无 P 行、无 PS 不变量、§8 对账只点名 4xx 分支 | **已实质修订**：新增 **P-11**（E14，正交轴）与 **PS-23**；§8.1 对账显式纳入 E14（后端已 `C`/`F` 时本地失败只恢复本地，不得重标 unknown/重发、不得据导航成功结算） | §4.1 P-11、§8.1、§11 PS-23 |
| F1 / ADV-01 | P2（authority + adversarial，同缺陷双报） | §6.3 与 PS-20 把「requestId/originalRequestId 二分」归给 **WP-O2 D10**；D10 实为“unknown 跨 attempt 单调；…不清除”，且 WP-O2 全文不含 `originalRequestId` | **已实质修订（非改写措辞）**：§6.3 与 PS-20 出处改为真实承载材料 **WP-O2 §5.2 正文（HTTP requestId 只可作 correlation）+ 投影 D07**；并注明 r1 误引、本包不使用任何未在 WP-O2 出现的二分 | §6.3、§11 PS-20 |
| ADV-02 | P2（adversarial） | §5.2(3) legacy 分支清单**过宽**（把正确的 transportError/malformedResponse→unknown 并入“制造终局”）且**过窄**（漏 `{failed, executionUnknown===false}`→definite-failure 与末尾 fallback） | **已实质修订**：§5.2(3) 重写为列全三个真正制造终局的分支（`apiError` status<500；`{kind:'failed', executionUnknown===false}`；末尾 unknown-kind fallback，均带行号），并把 transport/malformed→unknown 明确改列为**必须保留**的正确 fail-closed 映射；§8.1 同步 | §5.2(3)、§8.1 |
| ADV-03 | P2（adversarial） | CB-3 解除证据只绑 W41，W41 仅覆盖后半（不做类别→终局映射，且仅 domain `rejected`），前半“内部类名不得上 wire”无任何 oracle | **已实质修订**：CB-3 解除证据改为 **W52（前半）+ W41（后半）两枚**；§10 新增 **W52** 并同步全包 W 编号（W38–W52） | §5.1 CB-3、§10 W52、§10 前言/结语、§11 前言、§12、§13 |
| ADV-04 | P2（adversarial） | P-8「不得表达」未写自身引源要求的“既有 unknown 保留”（E16）；K-5 latch 保留清单未点名 2xx 域 `rejected`（E16 的 domain 半） | **已实质修订**：P-8 增“本 attempt 域拒绝**不清除既有 unknown**（E16）”；K-5 增列 **2xx envelope 内的域 result `rejected` 亦不得清除 latch**，并补 WP-O1 §5 E16 出处 | §4.1 P-8、§7.2 K-5 |
| ADV-05 | P2（adversarial） | §4.1 未声明省略了 §6.3 4×7 的哪些格（WP-O3 §8 曾因同一问题被判 R2-ADV-01） | **已实质修订**：§4.1 引言新增**投影省略声明**——本包只投影『可公开表达/不得表达』两列，内部动作列（清 pending/新 key/下一 chunk/B 动作/owner）由 WP-O1 §6.3 治理；§4.1.1 末尾**逐格点名** r1 未声明的格（`C\|inconclusive`、`F\|inconclusive`、`C\|attempt-local`、`F\|attempt-local`、`auth suspension × {N,U,C,F}`） | §4.1 引言、§4.1.1 |
| ADV-06 | P2（adversarial） | §4.2「范围显式」与 §5.3 方向 A 把 retention-unavailable、auth-suspended 与结果状态并列为单一“证据范围”值；二者实为正交轴，单值无法表达 `C + retention-unavailable`，会把 `C` 与 `U` 压成同一值 | **已实质修订**：§4.2 明确**结果轴 × 正交轴**的可叠加关系（retention-unavailable × {C,N/U,F}；auth × {N,U,C,F}）并要求载体表达**组合**、不得压成单值；§5.3 方向 A 同步改为“范围标记（非单值枚举）”；新增 **PS-22** | §4.2、§5.3 方向 A、§11 PS-22 |
| ADV-07 | P2（adversarial） | CB-10 与 §7.1 以「R7-C §9 正文」承载“允许无 HTTP response”，但该陈述在 r1 **§8（line 141）与 §12（line 249）**；§9（line 144 header、line 158 为 deadline/retry 行）只支持“到期仍 unknown” | **已实质修订**：CB-10、§7.1、PS-06 出处改为 **§8（line 141）/§12（line 249）**，并注明 §9（line 158）仅承载“到期仍 unknown”；§13「id 溯源」同步 | §5.1 CB-10、§7.1、§11 PS-06、§13 |
| ADV-08 | P2（adversarial） | 伴随 evidence 未登记 pack 字节身份（且显式拒登，因写时输出目录为空），弱于 WP-O3 evidence 的逐轮登记 | **已修订（在伴随 evidence 内）**：evidence 改登记 pack 的 r1 现场身份与 r2 实算身份（lines/bytes/SHA-256，`wc`/`shasum` 实算）；evidence 自身**从未**声明自身 bytes，故不自登记（避免登记即过期） | 见 `wp-o4-public-semantics-and-carrier-evidence.md` §1「伴随输出文件登记」 |

**说明与 rebuttal**：本 Designer 对上述 11 条 finding（F1 与 ADV-01 为同一缺陷，双 lens 同报）**全部复核为
成立，无未采信的 rebuttal**。全部修订沿 fail-closed 方向（补先前状态轴、补 E14、收紧 legacy 分支清单、
补 oracle、更正出处/编号），**未放松任何既有 fail-closed 行为**，也未改动结论上限（§1）。r2 新增/变更的
不变量：**PS-21/PS-22/PS-23**；新增 oracle：**W52**；CB-3 解除证据由 W41 扩为 W41+W52。

## 15 修订说明 (r3)

本节逐条登记**第二轮独立 Fresh Review（r2 复评：三 lens 均 `CLEAN`、`P0=0/P1=0`，对抗性 lens 达
`0/0/0`）**的**6 条残余 P2** 及其在 r3 的处置。**6 条全部被本 Designer 复核为成立，无未采信的
rebuttal**；r3 全部沿 fail-closed 方向实质修订，**未以削弱任何 fail-closed 行为来消除任何 finding**。
复核方法：本地只读 `git show`（按本包 §2 PRE 钉住的材料 ref `41d47eb` 读 `packages/contracts/src/api.ts`
逐符号行号、`apps/client/src/core/{api-client,idempotency}.ts`，以及 WP-O1 §5/§6.1/§6.3、WP-O2 §5.2/D07）；
未运行任何产品测试/DB/Node/Taro/Docker，未修改仓库。**r3 不改结论上限**（仍为 `DESIGN_ONLY`、
`READY_FOR_FRESH_REVIEW`）。r2 现场字节身份在伴随 evidence `wp-o4-public-semantics-and-carrier-evidence.md`
登记（本节不自嵌入本文件自身 hash）。

| finding id | severity / lens | 摘要 | r3 处置 | 落点（r3 行内） |
| --- | --- | --- | --- | --- |
| FC-R2-01 | P2（fail-closed） | §5.2(3)/§8 只列**失败侧**「自行制造终局」分支，漏掉**成功侧**：`dispositionForOutcome` 把 `kind:'success'`→`'completed'`（L394–408），`api-client.ts` 把**任何**合法 2xx 记为 `kind:'success'`（L115–135）；故 2xx 内域 `rejected`（E16）或未经 E01/E02 authority 的 2xx 被公开为“命令完成/成功” | **已实质修订**：§5.2(3) 新增成功侧分支 **(d)** 并把分支总数由三改 **四**（失败侧 a/b/c + 成功侧 d，均带行号）；§8 由“至少三处”改“**至少四处**”并点名成功侧；§8.1 对账显式纳入成功侧与“不得以 2xx/`ok:true` 单值顶替范围”；§2.1 补成功侧 2xx→`kind:'success'`→`'completed'` 事实 | §5.2(3)、§8、§8.1、§2.1 |
| FC-R2-02 | P2（fail-closed） | §4.2/PS-22 把正交轴定为 {retention-unavailable, auth-suspended} **两项**，与本包 P-11（称 local completion 为正交轴）冲突；WP-O1 §6.1 的正交状态实为**四项**，且 retention-unavailable 是 §6.3 **观察列（E10）**而非正交状态 | **已实质修订**：§4.2/§5.3 方向 A/§5.1 CB-1/CB-2/§11 PS-22 改为**结果轴 × 观察（§6.3『新观察』7 值）× §6.1 四项正交状态**（auth 可用/暂停、attempt 活跃/结束、恢复可用/受阻、local completion）；明确 retention-unavailable 属**观察列**、auth suspension 具“正交状态 + 观察”双重面目 | §4.2、§5.1 CB-1/CB-2、§5.3 方向 A、§11 PS-22、§4.1 P-11 |
| FC-R2-03 | P2（fail-closed） | §4 自称投影 E01–E19，但 **E13/E15/E17/E19** 既无 P 行也无省略声明，读者无法区分『有意不投影』与『漏掉』 | **已实质修订**：新增 **P-12**（E13，current GET/checkpoint）；**E15/E17/E19 在 §4.1 表末新增显式“不投影声明”**并给出理由与部分覆盖指向（E15 无 settlement；E17 由 PS-04/CB-9/P-2/P-5/P-9 覆盖；E19 由 WP-O1 E19 明文“对 M2 不作投射”）；§4 引言与 §13 更新完备性声明 | §4.1 P-12、§4.1 表末声明、§4 引言、§13 |
| FC-R2-04 | P2（fail-closed） | §4.1 投影省略声明使用了 **§6.3 不存在的列名**（『可公开表达/不得表达』两列、被省略的『B 动作』列）；§6.3 真实表头为**七列** | **已实质修订**：§4.1 引言/§4.1.1 引言/§13 改用 §6.3 **真实列名**『先前状态 \| 新观察 \| 客户端逻辑状态/动作 \| 清 pending \| 新 key/body/version \| 下一 chunk \| 业务展示/未决 owner』，并声明本包**只投影『业务展示』语义**、其余四列不投影、『未决 owner』列不重新指派 | §4.1 引言、§4.1.1 引言、§13 上游一致性 |
| FC-R2-05 | P2（fail-closed） | §6.3 的 r2 括注「本包不使用任何未在 WP-O2 出现的二分」**过宽**：与 §5.2(2)（仍以成功 `meta.idempotency` 的 `originalRequestId` 描述 problem 缺口）、§3.3/PS-20（仍用“delivery 维度 vs command 维度”拆分）不一致；`originalRequestId` 在 WP-O2 全文**不出现** | **已实质修订（收窄主张）**：§6.3 只主张**已更正的那一点**——不把「requestId/originalRequestId」归属为来自 WP-O2 的二分；§5.2(2) 明标 `originalRequestId` 为 §2.1 **代码事实**、上游仅 WP-O2 §5.2 正文/D07；PS-20 改写为不得由 `requestId` 投递相关性顶替 **Q01 identity key + binding**；§3.3 增消歧句 | §6.3、§5.2(2)、§11 PS-20、§3.3 |
| WP-O4-R2-AUTH-01 | P2（authority） | §2.1 对 `packages/contracts/src/api.ts` 的**四个行号归属**（`createApiSuccessSchema` L64–118、`apiErrorSchema` L52–78、`createApiResultSchema` L80–95、`idempotencyMetadataSchema` L104–118）**均未落在被归属内容上**；同一 §2 PRE 已钉住该文件 SHA `c00763ec…`，属自检可查的不一致 | **已实质修订**：按钉住 SHA 逐符号重核并改正——`apiErrorSchema` **L59–84**、`createApiSuccessSchema` **L116–123**（+ `apiMetaSchema` L110–114）、`createApiResultSchema` **L125–127**、`idempotencyMetadataSchema` **L99–108**、`apiErrorCodeSchema` **L9–30**、`apiErrorStatus` **L31–50**；§2.1 客户端行号同步校正（`api-client.ts` L14–23/L98–161、`idempotency.ts` L371–410） | §2.1 |

**rebuttal 与口径说明**：

- **FC-R2-01/02/03/04**：本 Designer 复核全部成立，逐条按 fail-closed 方向修订（补成功侧分支、改正轴集、
  补 E13–E19 显式声明、改用 §6.3 真实列名）。无 rebuttal。
- **FC-R2-05**：指控成立，已收窄 §6.3 主张并统一 §5.2(2)/PS-20。**部分驳回一句**：FC-R2-05 称 **§3.3**
  “仍以 delivery 维度 vs command 维度立法”——本 Designer 复核 §3.3 原文是以 **Q01 的 exact identity key +
  request binding** 表述关联，并未使用该二分；该二分实际只出现在 §5.2(2)/§6.3/PS-20，三者 r3 已对齐。为
  消除歧义，r3 仍在 §3.3 增一处消歧句（“此处『原命令身份』即 Q01 的 exact identity key + request binding，
  与 requestId 投递相关性无涉”），**属加强而非放松 fail-closed**。
- **WP-O4-R2-AUTH-01**：成立，已按钉住 SHA 重核改正全部行号。无 rebuttal。
- **§14 的口径被 r3 部分取代**：§14（r2 记录）中 ADV-02「列全**三个**」、ADV-05「只投影『可公开表达/
  不得表达』两列」、ADV-06「二者实为**正交轴**」三处措辞，已被 r3 的 FC-R2-01/FC-R2-04/FC-R2-02 分别取代；
  §14 作为 r2 历史记录**原样保留**，其现行有效性以本 §15 为准。
- **未新增 oracle、未改 PS 编号**：r3 **不新增** W 系列 oracle（W38–W52 不变）；PS-21/PS-22/PS-23、
  CB-1/2 的**编号不变**（仅文本被 r3 修正）；新增内容为 **P-12** 与 §4.1 表末的 E15/E17/E19 递延声明。
  r3 **未放松任何既有 fail-closed 行为**，也未改动结论上限（§1）。

## 16 修订说明 (r4)

本节逐条登记**第三轮全新独立 Fresh Review（r3 复评：三 lens 均 `CLEAN`、`P0=0/P1=0`，fail-closed lens 达
`0/0/0`）**的**7 条残余 P2** 及其在 r4 的处置。**7 条全部被本 Designer 复核为成立，无未采信的 rebuttal**；
r4 全部沿 fail-closed 方向实质修订，**未以削弱任何 fail-closed 行为来消除任何 finding**，且**每条只做能完整
闭合该条的最小改动**，改后逐条回读相邻主张，未引入新的精度缺口。复核方法：本地只读 `git show`（按本包 §2 PRE
钉住的材料 ref `41d47eb` 读 `packages/contracts/src/api.ts`、`services/api/src/app.ts`、
`services/api/src/database/repository.ts`、`apps/client/src/core/{api-client,idempotency}.ts`，以及 WP-O1
§5/§6.1/§6.3、WP-O2 §5.2/D07、WP-O3 §7.2.3/§7.4/§12）；未运行任何产品测试/DB/Node/Taro/Docker，未修改仓库。
**r4 不改结论上限**（仍为 `DESIGN_ONLY`、`READY_FOR_FRESH_REVIEW`）。r3 现场字节身份在伴随 evidence
`wp-o4-public-semantics-and-carrier-evidence.md` 登记（本节不自嵌入本文件自身 hash）。

| finding id | severity / lens | 摘要 | r4 处置 | 落点（r4 行内） |
| --- | --- | --- | --- | --- |
| WP-O4-R3-AUTH-01 | P2（authority） | §4.1 的投影范围声明称只投影 §6.3『业务展示』，但 §4.1.1 多格填入『客户端逻辑状态/动作』内容、丢弃其应投影的『业务展示』（点名 `N\|inconclusive`、`C\|auth`） | **已实质修订**：§4.1.1 全表 28 格改为**直接投影 §6.3『业务展示』文本**（如 `N\|inconclusive`→“结果尚未确认；不展示完成/确定失败”、`C\|auth`→“是否仍可展示安全历史由 auth owner 定”），`P-x` 仍指回 §4.1；表后说明同步。未放松任何 fail-closed 内容（其强化表述仍在 §4.1 各 P 行） | §4.1.1 表、§4.1.1 表后说明 |
| WP-O4-R3-AUTH-02 | P2（authority） | §2.1 用标签 `I02` 承载“problem 无 meta/幂等字段”，该 id 不在本包声明的上游 id 集（I-01–I-12 带连字符），且无上游 `I02` 匹配该内容 | **已实质修订**：删除悬空 `I02` 标签，改述为 §2.1 代码观察（**非上游 id**），并注明上游 `I-02` 实为“unknown 跨 attempt 独立事实” | §2.1 |
| WP-O4-R3-AUTH-03 | P2（authority） | §2.1 把 `apiErrorCodeSchema` 归属为 `L9–30`，但该 enum 体止于 L28、L29 为类型别名、L30 为空白；按本包约定（止于类型别名）应为 L9–29 | **已实质修订**：改为 `L9–29`（并注明 enum 体 L9–28、别名 L29） | §2.1 |
| WP-O4-R3-AUTH-04 | P2（authority） | §2.1 断言了仅能由 §2 读取清单外文件建立的代码事实：响应头事实仅在 `services/api/src/app.ts`；replayed/裸 `CONFLICT(409)` 事实仅在 `services/api/src/database/repository.ts` | **已实质修订**：把两文件**加入 §2 声明读取清单**（`app.ts` 366 行 / 13,073 bytes / `cbb8d4d1…27895`；`repository.ts` 2,907 行 / 97,037 bytes / `b354cd20…b52c669`，均本次实算），并在 §2.1 按该两文件改写断言并标注行号 | §2 读取清单、§2.1 |
| ADV-R3-01 | P2（对抗性） | §9.1 Identity 行要求“body/版本改动不移动 namespace”，但 §8.2 载体准入 gate（G1–G7）与 §12 stopline 未承接 WP-O3 登记且要求“Q10 关闭前保持 admission blocker、不得写成 gate closed”的 O9-5；因 Q01 令 `identityPolicyVersion` 属 identity key 成员，版本变化即移动 namespace（正是 O9-5 的跨版本 non-reuse 危害） | **已实质修订**：§8.2 新增 **G8**（O9-5 义务），§12 增 O9-5 stopline，§9.1 Identity 行显式承接 O9-5，§1 递延处置表增 **(v)**；明示该义务**在 Q10 关闭前保持 admission blocker、不得写成 gate closed** | §8.2 G8、§12、§9.1、§1、§13 |
| ADV-R3-02 | P2（对抗性） | §4.1 引言把 P-1…P-12 统称『观察轴』并称本表是 §6.3 4×7 矩阵的公开投影，但 P-11 属 §6.1 正交状态、P-10/P-12 不在 §6.3 七观察列内；真正的 4×7 投影是 §4.1.1（与 r3 刚在 §4.2/PS-22 修好的『观察列 vs 正交状态不得混同』同类） | **已实质修订**：§4 引言/§4.1 引言/§4.1.1 引言/§13 上游一致性一致改述——P-1…P-12 是 **E01–E19 的公开语义投影集**，非 §6.3 七观察列本身（点名 P-10/P-12 不在七列内、P-11 属 §6.1 正交状态）；§6.3 4×7 逐格投影明确为 **§4.1.1** | §4 引言、§4.1 引言、§4.1.1 引言、§13 |
| ADV-R3-03 | P2（对抗性） | §2.1/§5.2(2) 称请求相关性只靠 `requestId`（`z.uuid()`）且 problem 侧 `requestId`“仅与这次投递相关”，但服务端 `genReqId` 采纳调用方 `x-request-id`（合法 uuid 逐字用作 `requestId`），故 `requestId` **可被调用方指定、不保证投递唯一**——原文陈述了强于代码的投递相关性（朝向攻击面 (c)/(d) 的弱 fail-open） | **已实质修订**：§2.1 增述 `genReqId`（`app.ts` L202–223）采纳 `x-request-id` 的代码事实；§5.2(2) 相应改写为“`requestId` 非稳定的‘这次投递’标识”。过度声称被收窄，§6.2/§6.3 的“只可作 correlation”结论据此更稳 | §2.1、§5.2(2) |

**rebuttal 与口径说明**：

- **WP-O4-R3-AUTH-01…04、ADV-R3-01…03**：本 Designer 复核**全部成立，无 rebuttal**。逐条按 fail-closed /
  诚实溯源方向修订：AUTH-01 使 §4.1.1 各格与其声明的投影范围一致（保留 §6.3『业务展示』语义）；AUTH-02/03
  删除悬空 `I02`、把行号改为 `L9–29`；AUTH-04 把 `app.ts`/`repository.ts` 纳入声明读取清单并按其实代码改写断言；
  ADV-R3-01 将 O9-5 明列进 §8.2 G8 与 §12 stopline；ADV-R3-02 在四处消歧 P 集与 §6.3 七观察列；ADV-R3-03
  按 `genReqId` 实际行为收窄投递相关性主张。
- **未放松任何 fail-closed 行为**：AUTH-01 只是把各格换成 `P-x` 已携带的 §6.3『业务展示』语义（其强化表述
  仍在 §4.1 各 P 行）；ADV-R3-03 是**收窄**过度声称（消除弱 fail-open）；其余为补义务 / 更正溯源。结论上限
  （§1）不变。
- **未新增 oracle、未改 PS 编号**：r4 **不新增** W 系列 oracle（W38–W52 不变）、**不改** PS-1…PS-23 与
  CB-1…CB-10 编号（仅文本被修正）；新增内容为 §8.2 的 **G8** 与 §12 的 O9-5 stopline。§14/§15 作为 r2/r3
  历史记录**原样保留**，其现行有效性以本节为准。

## 17 修订说明 (r5)

本节登记**第四轮全新独立 Fresh Review（r4 复评：三 lens 均 `CLEAN`、`P0=0/P1=0`）**残余 findings 收敛后的
**三个明确问题**（共 6 个 finding id：`FC-R4-01`、`ADV-R4-02`、`FC-R4-02`、`AUTH-R4-02`、`ADV-R4-01`、
`AUTH-R4-01`）及其在 r5 的处置。**三个问题全部被本 Designer 复核为成立，无 rebuttal**；r5 全部沿 fail-closed /
诚实溯源方向做**最小外科式改动**，改后**逐条回读每一处作出同一主张的相邻句**并使其一致，**未以削弱任何
fail-closed 行为或任何禁令来消除 finding**。复核方法：本地只读 §4.1/§4.1.1/§3.3/§6.3/§7.2/§10/§11 与
WP-O1 §6.3 真实列文本、只读 `app.ts` L202–223 的 `genReqId` 事实；未运行任何产品测试/DB/Node/Taro/Docker，
未修改仓库。**r5 不改结论上限**（仍为 `DESIGN_ONLY`、`READY_FOR_FRESH_REVIEW`）。r4 现场字节身份在伴随
evidence `wp-o4-public-semantics-and-carrier-evidence.md` 登记（本节不自嵌入本文件自身 hash）。

| finding id（lens） | 问题 | r5 处置 | 落点（r5 行内） |
| --- | --- | --- | --- |
| `FC-R4-01`（fail-closed）+ `ADV-R4-02`（对抗性） | r4 已在 §2.1/§5.2(2) 收窄 `requestId`（`genReqId` 采纳调用方 `x-request-id`，非稳定“这次投递”标识），但 §6.3 仍写“**可以假设且安全**的是‘本响应是对本请求的响应’（同一次投递的相关性）”，§3.3 与 §11 PS-20 亦以“`requestId` 的投递相关性”为词，故相邻节仍给持有者强于代码的保证 | **已实质修订（统一口径，收窄至代码事实）**：§6.3 改为“**可以安全假设的仅是**服务端回显请求侧 `requestId`；**不能安全假设**该回显标识‘同一次投递’（调用方可在多次投递上提供同一 `requestId`，相等**既不唯一标识、也不证明投递**，至多为**相关性提示**）”；§3.3 的“`requestId` 的投递相关性无涉”改为“相关性提示（调用方可指定、不证投递唯一）无涉”；§10 W42、§11 PS-20 同步改为“`requestId` 的相关性提示”。全包其余“投递”措辞（§2.1 L128、§5.2(2) L341）复核为 r4 已收窄、不改。**未放宽任何禁令**——§6.2 O5-3c“`requestId` 回显不得充当关联证明”原样保留，其有效性据此更稳 | §6.3、§3.3、§10 W42、§11 PS-20 |
| `FC-R4-02`（fail-closed）+ `AUTH-R4-02`（authority）+ `ADV-R4-01`（对抗性） | §4.1.1 及其表后说明、§16 的 WP-O4-R3-AUTH-01 行均称“全表 28 格已直接投影 WP-O1 §6.3『业务展示』文本、不再填『客户端逻辑状态/动作』内容”，但至少三格仍含该动作列内容：`N\|malformed`（“完全未交付才维持 N”，且把源文本“无响应业务内容披露”改写为“无业务内容披露”）、`N\|auth`（“无 dispatch 证明保留，否则 U”）、`F\|attempt-local`（“较弱后续 no-op”） | **已实质修订（恢复为该列文本）**：三格改回 §6.3『业务展示』文本——`N\|malformed`→“无响应业务内容披露（P-9）”、`N\|auth`→“仅登录/恢复提示，不猜业务成败（P-6）”、`F\|attempt-local`→“原命令终局无效果（P-5 修正要点；…`F\|attempt-local`）”；表后说明同步删去“较弱后续 no-op”。**被移出格的内容并未丢失、且以更强形式存续**：N→U 强制在 §4.2『`N`→`U` 强制』与 PS-19；`N\|auth` 的“无 dispatch 证明保留、否则 `U`”在 §4.1 P-6；`F` 不被 attempt-local/较弱后续改写在 §4.2 状态单调 (i)。声明句同时精确化——各格在『业务展示』文本上**可叠加 §4.1 P 行已载的 fail-closed 强化**（如 `N\|retention` 的“不得称『曾被接受』”按原样保留）。§16 的 WP-O4-R3-AUTH-01 行经此修改后与其叙述一致，未改历史行 | §4.1.1 表（**N** 行、**F** 行）、§4.1.1 表后说明、§4.1.1 引言 |
| `AUTH-R4-01`（authority） | §2 声明“本轮实际读取的精确源材料”，却遗漏正文按行号引用的两份 R7-C r1 文件（`r7c-shadow-design-r1.md`、`r7c-r1-fresh-review.md`）；正文在 §5.1 CB-10、§7.1、§7.2 K-5/K-7、§11 PS-06/PS-07、§13 引用其 line 141/158/228/249 与 review §4（同 r3 的 WP-O4-R3-AUTH-04 一类） | **已实质修订**：把两份文件**加入 §2 声明读取清单**，标注**本次以 `wc`/`shasum` 实算**的 lines/bytes/SHA-256（design 409 行 / 79,559 bytes / `4884b06081…53ad0627`；review 216 行 / 25,473 bytes / `ca6535848a…bec4f`，**非抄录**），用途注明被正文按行号引用之处；**未删除任何引用**。行号 141/158/228/249 经复读仍与正文描述一致（141=允许无 HTTP response、158=到期仍 unknown、228=跨 attempt unknown latch、249=commit outcome unknown/client abort） | §2 读取清单 |

**rebuttal 与口径说明**：

- **`FC-R4-01`/`ADV-R4-02`、`FC-R4-02`/`AUTH-R4-02`/`ADV-R4-01`、`AUTH-R4-01`**：本 Designer 复核**全部成立，
  无 rebuttal**。三处分别按“收窄过度声称 / 恢复忠实投影 / 补足声明读取清单”方向最小修订。问题 2 的两个
  给定选项（恢复为该列文本、或改写声明）中，r5 取**两者并施的最小组合**：格恢复为该列文本，声明同时精确化
  其叠加口径——使声明与全部 28 格一致，而非仅与三格一致。
- **未放松任何 fail-closed 行为或禁令**：问题 1 是**收窄**过度声称（消除弱 fail-open）；问题 2 移出格的内容
  全部在 §4.2/PS-19/P-6 中以**不弱于原格**的形式存续，`N|retention` 的“不得称『曾被接受』”禁令**原样保留**；
  问题 3 只**增加**声明、未删任何引用。结论上限（§1）不变。
- **历史节的口径被 r5 部分取代**：§14（FC-R2-05 行）、§15 rebuttal 与 §16（ADV-R3-03 行、WP-O4-R3-AUTH-01 行）
  中引用的“`requestId` 投递相关性”措辞与“全表 28 格”叙述，均以本 §17 与修改后的 §3.3/§6.3/§4.1.1 为准；
  §14/§15/§16 作为 r2/r3/r4 历史记录**原样保留**。
- **未新增 oracle、未改 PS/CB 编号**：r5 **不新增** W 系列 oracle（W38–W52 不变）、**不改** PS-1…PS-23 与
  CB-1…CB-10 编号（仅文本被修正）；亦**不改结论上限**（§1）。
