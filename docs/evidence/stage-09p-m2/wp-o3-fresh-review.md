CLEAN
P0=0 / P1=0 / P2=0

# Stage 09P-M2 / WP-O3 全新独立 Fresh Design Review（r3）

- 日期：2026-09-12（Asia/Shanghai）
- 评审轮次：r3；评审对象为 r3 精确候选（决策包 + 伴随 evidence）
- 结论：**CLEAN**；finding 计数 `P0=0 / P1=0 / P2=0`（三个 lens 的 findings 均为空）
- 评审结构：三个**互盲**的独立 lens，各自只读阅读候选与上游材料，独立得出结论
  - L1 fail-closed completeness / invariant soundness
  - L2 authority and scope boundaries
  - L3 adversarial counterexample hunt
- 未执行：任何 Docker、产品测试、DB、Node 或 gate；未改写候选；未切换分支；未读取 r0/r1/r2 评审结论
  以外的任何中间产物以形成结论（r0–r2 谱系见 [WP-O3 评审谱系 r0–r2](wp-o3-review-history-r0-r2.md)）

## 1 候选与权威源身份

| 对象 | Lines | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| WP-O3 command record / authority 决策包 | 793 | 83,548 | `6e2775f4cceef14e83f73ce44ed3b4c4ca52ce91d7522260114fd663b5f5d754` |
| WP-O3 伴随 evidence | 291 | 22,456 | `1bc922786ae16bb9f4c72230ab11c464a75297ab535e16d8418122c6b62047cb` |

权威源基线（`codex/stage-09p-m2-inventory`）：tip `41d47ebfa02313e2f388ae1749b54f4cec3f97d8`，
tree `ec66e80cec1c89bb1ea6369df2ac7bcdf3d87ead`，唯一 parent
`41c2e7b5013051201c10365b9f41af00b643fae8`；评审工作树为 `main` @
`23450a1f3508e8030d753748291d265ad308df05`。三个 lens 均以只读 `git show` / `git grep` 核验，
未运行任何动态步骤。

## 2 L1 — fail-closed completeness / invariant soundness：CLEAN

- 四问均有 fail-closed 默认。Q03（§3.1/§4.2）：E03 须同时满足 P-a ∧ P-b ∧ P-c 三个合取谓词，
  E04 单独绝不开放同身份重执行写，cancel ack 单独不构成 E03。Q04（§3.2/§5.2）：成功须由唯一
  commit 线性化点的单事务原子接受证明，仅知 COMMIT / marker completed / 2xx / 内存 receipt 均不足；
  C/F 冲突隔离并暂停，禁止 last-response-wins 与多数投票。Q06（§3.3/§6.2）：handoff 之后
  receipt miss / backend unavailable / known abort 一律只查不写，重执行仅两类——
  (a) 原命令仍为 N 且有被证明的 fence（P-a ∧ P-b），或 (b) 已由 E03 终局。Q09（§3.4/§7.2）：
  non-reuse landmark 覆盖全部曾越过 handoff 的身份（N/U/C/F），不以「曾 commit」为条件。
- 无任何路径把缺失证据静默当作 no-effect 或 success：§7.2.1/§7.2.2 与 §8 的
  retention/absence 行一律 fail closed 到 U 或保留既有 C/F；r3 收窄后仍禁止由 absence/retention
  推断 no-effect，同时允许披露已由 E03 建立的 F，二者不矛盾。
- §8 投影正确且完整：逐格枚举 WP-O1 §6.3 全部 28 格对照 §8 —— §8 实列 17 格，其声明的省略清单
  （E11×{U,C,F}=3、auth suspension×{N,U,C,F}=4、C/F 的 attempt-local 与 inconclusive=4，共 11 格）
  恰为补集，无任何格既未列出又未声明省略。
- retention wrapper 与其 C 条目自洽：wrapper 为「有限、随状态而异、不超出所声明状态」；C 为
  肯定披露（曾被接受但结果不可恢复），N/U 为 UNKNOWN 否定披露；§7.4 O9-3 标题已由「否定性」
  改为「受限度（state-relative）」。
- 上游引用逐一核验为真实且内容相符：R7-C r1 §11 line 228（跨 attempt 独立 latch）、
  §9 line 167（cancellation ladder step 4，区间 162–167）；整分支 `R1-INV` 零命中，包内仅出现在
  历史更正记录中，无一处作为 live authority；三处 live 引用均为 WP-O1 §6.2(1)（非 §6.2(3)）；
  R7-B §6 / §8.2 / §10 / §12.9 与 I11/I12；WP-O1 §4.2 I-02/I-12、§5 E01–E04/E10/E11、
  §6.3（含 N|malformed 等格）、§6.4、§7.1、§10 四问、O02/O03/O04/O08/O14；WP-O2 D01/D02/D03/
  D09/D18、W01–W18、§4.4/§4.5/§5.4/§6.2/§6.4 均存在。
- 源码 grounding 行引用逐条核对无误：`repository.ts` 730–740（incomplete marker → INTERNAL_ERROR）、
  777–787（nonReplayable → CONFLICT）、788–806（replay meta 携 replayed/firstProcessedAt/
  originalRequestId）、833–873/889/926（marker 先双 NULL 插入后同事务 UPDATE）、856
  （expires_at = now + 30d）、全库无 `DELETE FROM idempotency_records`（计数 0）；
  `0000:277–304`（CREATE TABLE 与 completion_check / UNIQUE NULLS NOT DISTINCT）、
  `0002:524–566`（non_replayable tombstone）、`0004:95–116`（409 收窄 CHECK：两条 link 路由 +
  ok=false + error.code=CONFLICT）；客户端 `idempotency.ts` L40/L48/L69/L101/L184/L242、
  `session-store.ts` L54–56/L69/L76、`command-dispatcher.ts` L32/L96/L127 均与所述语义相符。

## 3 L2 — authority and scope boundaries：CLEAN

- 结论上限诚实：§1/§12/§13 一致地把本包限制为 `DESIGN_ONLY` 设计准备材料，明确不冻结
  contract/DTO/status/reason/route/SQL/RLS/lock/TTL、不关闭任何 G-*、不授权实现；§9 把 public
  DTO/status/reason/route 明确留给 Q05；§12 载明「本包不得被写成 gate closed」。
- 未重开 Q01/Q02/Q08：§4.3/§5.3/§6.3/§7.3 仅作边界引用；§6.3 明确「本问题不重开它」。
  §7.2.3 的前提（identityPolicyVersion 属 identity key 成员 → 版本变化移动 namespace）经
  WP-O2 §3.1 身份键定义与 §4.5 namespace 定义核实为准确，非曲解、非重开。
- 不违反代码现实：`schema.ts` 仅 11 张 stage-06 表，B 侧无任何 command / attempt /
  commit-capability / receipt-entitlement / no-effect 表；§2「B 侧均需新建」属实。
  requestHash = SHA-256(canonicalJson)、completion CHECK、expires_at = now + 30d、
  replay SELECT 无 expires_at 谓词、nonReplayable tombstone、0004 409 收窄两路由、
  `#withAuthenticated` 副作用续期、RLS 三策略两豁免均逐一核实一致。
- 项目事实标签全部正确：M1 limited、G2 not admitted、R7-A Accepted、R7-B/R7-C =
  `SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`、T01–T50=0、M2 In Progress、十个 G-* open、
  `0000–0004` 永久冻结。
- §4.2 指针：E04 行第 4 列已不指向表内行，而直接指向 §6.2 (a)/(b) 唯一规范定义
  （(a) 仅 P-a ∧ P-b、显式不含 P-c、不把命令升为 F），与 §3.1/§3.3/§6.2 一致。
- 两处边缘观察，核实后判定**不构成缺陷**：(1) §2 关于本候选形成地的措辞与 evidence 所述
  真实 provenance（pack 位于 main 工作树 `.local/wp-o3/` 的未跟踪伴随文件）合计无误导；
  (2) §1 称四问为「B 侧问题」，而 WP-O1 §10 标其为多 owner —— 沿用已接受的 WP-O2 §8 表述，
  且 §9 owner 表已正确分派 ID/AUTH/OUT/CLIENT。

## 4 L3 — adversarial counterexample hunt：CLEAN

对四个答案逐臂攻击，未找到任何存活反例。以下为实际发起的攻击与其被封死的位置：

- **(a) 断言 command-final no-effect 而 commit 仍可能**：攻击「cancel ack 单方建立 E03」被
  §3.1/§4.2/§4.5 + W21 挡下；攻击「§4.2 表第 4 行字面不含 P-b → 误建 E03」是**最强的一次近失**，
  由 §4.2 开头「E03 须同时满足三个合取谓词」的规范定义 + W21「三谓词须齐备」挡下（表的行文为
  示例，规范定义在谓词处，故不构成 finding）；「N|retention-unavailable 误判 F」被 §8 该行
  「可能已执行 → U（不结算）」挡下；「以 E04 升为 E03」被四处一致禁止 + W19 挡下。
- **(b) 静默消解冲突 commit receipt**：让「貌似 C + 貌似 F」或两个不同 original receipt 走
  择一 / last-response-wins / 多数投票的尝试，被 §5.2、§5.5、§8 冲突行与 W25/W26 全部显式隔离
  并暂停；用 delivery metadata 反推结果真伪以消解冲突的尝试，被 §5.2 表 + §5.5（WP-O1 E02）挡下，
  且 §5.3 要求 correlation 先于结算。
- **(c) 同身份重执行而旧 attempt 仍可能 commit**：(a) 仅 P-a ∧ P-b（显式不含 P-c），P-b 的量化域
  是 `Attempts(C)` 中每一次执行（含在途/迟到/后台），故 (a) 可证时不存在可提交旧 attempt。
  攻击「RE1 在途时复用先前 (a) 的 fence 再发 RE2 → 双提交」：RE1 属 `Attempts(C)` 且在途 →
  P-b 在 RE2 时点为假 → (a) 不可再证，被 W27 同向挡下。U 命令不可走 (a)，比上游保守，属 fail-closed。
- **(d) retained-but-unreadable identity 被当新命令**：§7.2.1/RA-25 landmark 覆盖全部曾越过
  handoff 的身份（含 N/U/C/F），唯一豁免是完整证明从未 handoff（§6.2(1)）；§7.2.2/RA-17
  GC 与恢复交错 fail closed；§8 的 N|retention、U|retention 行与 W30/W34/W36 挡下，未构造出旁路。
- **(e) 未确认命令被宣布成功**：§5.2「commit 点是唯一接受线性化点，commit 前不公布 success」；
  §5.5 排除「只知 COMMIT / marker completed / 2xx / 内存 receipt / schema 形状」；
  §7.2/§3.4 明禁把 retention 后的 N/U 披露为「曾被接受」，未构造出路径。
- **(f) identity/version 重绑绕过 non-reuse**：O9-5/RA-27/W37 明禁 non-reuse 静默依赖 namespace
  相等，要求 landmark 跨身份/版本重绑存活或由 Q10 显式边界约束，Q10 关闭前保持 admission blocker
  （§12）并列入 §13 BLOCK 判据；包未关闭亦未放行，属 fail-closed，不构成 P1。

## 5 结论与上限

三个 lens 一致判定 `CLEAN`，P0/P1/P2 = `0/0/0`，findings 为空。r3 对 r2 残余五项
（RA-P2-01 指针、R2-FC-01 wrapper、R2-ADV-01 E11 覆盖、R2-ADV-02 F 披露收窄、R2-ADV-03 O9-5）
的修正均成立，且未削弱任何 fail-closed 行为，未引入新的不一致、遗漏格或虚构上游 id/行号。

本报告**不**声称：本候选已实现、已冻结契约、已关闭任何 G-* gate 或已取得实现准入。建议维持
`DESIGN_ONLY / READY_FOR_FRESH_REVIEW` 上限；是否接纳为逻辑设计基线由项目总控独立裁定。
