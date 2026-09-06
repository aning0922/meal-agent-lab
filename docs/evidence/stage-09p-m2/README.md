# Stage 09P-M2 设计与审查证据归档

状态：**字节级归档副本**。本目录保存 R7-A、R7-B 与 R7-C 在准入/设计收口时使用的
十二份材料，以及 Post-R7 Gap Gate、WP-O1 outcome evidence scope 决策包与其 Fresh
Review 三份材料，解决原始 `/private/tmp` 目录会被系统清理、后续任务无法重新执行
hash stopline 的问题。归档动作不生成新的实现授权。

2026-09-06，原临时目录在 R7-C Entry Gate 完成后被系统清理。六份内容随后从对应
Codex 任务日志中的结构化 `FileChange` 事件恢复：先重放 `add` 的完整内容，再按原顺序
重放全部 `update` unified diff。每个最终文件都重新计算 SHA-256，并与清理前已登记值
逐字节一致。恢复过程中没有从聊天摘要、截断终端输出或人工转写重建正文。

R7-C 的六份材料在对应临时目录仍存在时由总控直接复制；复制前后均核对 bytes、lines
与 SHA-256。r0 设计及其 `BLOCK` review 作为审计谱系保留；r1 是只回应该 P1 的完整候选，
随后取得全新独立 Fresh Design Re-review `CLEAN`。归档没有把 r0 的历史 `BLOCK` 改写为
`CLEAN`，也没有把 r1 的设计审查结论外推为实现证据。

| 持久归档 | 来源任务 | 原临时文件 | Lines | Bytes | SHA-256 |
| --- | --- | --- | ---: | ---: | --- |
| [R7-A-r6 design](r7a-r6-design.md) | Designer `01a06728-8d13-78e3-9eb3-bec73776cd25` | `R7-A-r6-design.md` | 75 | 5,417 | `179b4b7066e6bc82d3d99518abe595c6348bb6f26c23b248bc6df2182351e825` |
| [R7-A-r6 evidence](r7a-r6-evidence.md) | Designer `01a06728-8d13-78e3-9eb3-bec73776cd25` | `R7-A-r6-evidence.md` | 76 | 4,889 | `d9c2b1e41bd87ca9236c5a41c6f29a1350713d304852ba83463152afc996f339` |
| [R7-A-r6 Fresh Review](r7a-r6-fresh-review.md) | Reviewer `01a071dc-6e23-7d62-ba89-bfdf6e45930f` | `root-audit/report.md` | 187 | 8,833 | `1ad22c7258159e2ceba4aa398acf16c62422f17e8536717ab30988ca731c0ebe` |
| [R7-B shadow design](r7b-shadow-design.md) | Designer `01a07243-c177-7c80-a809-81d41c478968` | `R7-B-shadow-design.md` | 424 | 50,408 | `24e1f2496df347a0215041835f45d79ba577256d13d1d6f8e7557e2b53d98d3f` |
| [R7-B shadow evidence](r7b-shadow-evidence.md) | Designer `01a07243-c177-7c80-a809-81d41c478968` | `R7-B-shadow-evidence.md` | 152 | 13,556 | `93605e6893e53d8472ccde8a6213f258b7769c22b4a0fbb4e6d4ddb624136b68` |
| [R7-B Fresh Design Review](r7b-shadow-fresh-review.md) | Reviewer `01a07270-f6c5-7152-b122-c59e143a2788` | `R7-B-shadow-design-review.md` | 139 | 18,444 | `7e77977e86cf4b03483f04efb1810c37a4357cc46f97eff54689b4a6b65b1b57` |
| [R7-C r0 shadow design](r7c-shadow-design-r0.md) | Designer `01a07544-750c-7c63-93ff-509aec093337` | `R7-C-shadow-design.md` | 369 | 62,531 | `51bf086ce3b8df727f96bb45c3e4724dbb6a12ad1e418079d4c56786306d556e` |
| [R7-C r0 shadow evidence](r7c-shadow-evidence-r0.md) | Designer `01a07544-750c-7c63-93ff-509aec093337` | `R7-C-shadow-evidence.md` | 198 | 19,876 | `e7550b9f3120e59957ec02605244011e0d28ed95dc65843a8bcb117c6c2860b9` |
| [R7-C r0 Fresh Review — BLOCK](r7c-r0-fresh-review-block.md) | Reviewer `01a0755e-aa9c-7740-95d2-a2b97ad4f2b9` | `R7-C-fresh-review.md` | 161 | 18,349 | `6cacf04593bced1b878a6145590fbe7be7e0d306e1a04f00cba70195bbb7d9d1` |
| [R7-C r1 shadow design](r7c-shadow-design-r1.md) | Designer `01a07544-750c-7c63-93ff-509aec093337` | `R7-C-shadow-design-r1.md` | 409 | 79,559 | `4884b06081d009d84461b263e03bfe5c90e82035e325788fcd5b25bb53ad0627` |
| [R7-C r1 shadow evidence](r7c-shadow-evidence-r1.md) | Designer `01a07544-750c-7c63-93ff-509aec093337` | `R7-C-shadow-evidence-r1.md` | 159 | 18,891 | `b592d6aefb17a952b636d5812cd7a01351c78f33d1de2e46ee2a36946b1b1580` |
| [R7-C r1 Fresh Design Re-review — CLEAN](r7c-r1-fresh-review.md) | Reviewer `01a0758c-b51c-79b1-9351-a2b97ad4f2b9` | `R7-C-r1-fresh-review.md` | 216 | 25,473 | `ca6535848a1bb8d88c9e80ba3eff1f5047d900eeb9fc8889cde37ca94efbec4f` |

## Post-R7 Gap Gate 与 WP-O1

R7-C 设计收口后，Post-R7 Gap Gate 任务 `01a075a6-05db-7961-89a2-11972ee4ba25`
判定 `M2_POST_R7_GAP_GATE: DESIGN_ONLY_NEXT_AVAILABLE`，并建议先完成原始命令 outcome
evidence scope 的设计准备。WP-O1 Designer 任务 `01a075cd-6a4c-7171-bb62-fd0ae963df4f`
交付精确候选；其有效第二轮结论为 `WP-O1_OUTCOME_EVIDENCE_SCOPE: READY_FOR_REVIEW`。
Fresh Review 任务 `01a07643-3a88-7bf3-8b22-67f3b63d408f` 对该精确候选给出
`WP-O1_FRESH_REVIEW: CLEAN`，P0/P1/P2=`0/0/0`。三份原件均在临时目录仍存在时由总控
直接复制，复制后重新核对 lines、bytes、SHA-256，并与原件执行逐字节比较。

| 持久归档 | 来源任务 | 原临时文件 | Lines | Bytes | SHA-256 |
| --- | --- | --- | ---: | ---: | --- |
| [M2 Post-R7 Gap Gate](m2-post-r7-gap-gate.md) | Gate `01a075a6-05db-7961-89a2-11972ee4ba25` | `M2-post-r7-gap-gate.md` | 323 | 45,917 | `0fc31a5787689f1b1683b07fb9aa19eff4ceb81deaa155e4d5ad7e415b17f535` |
| [WP-O1 outcome evidence scope decision pack](wp-o1-outcome-evidence-scope-decision-pack.md.raw) | Designer `01a075cd-6a4c-7171-bb62-fd0ae963df4f` | `WP-O1-outcome-evidence-scope-decision-pack.md` | 363 | 63,296 | `68945d9f1566687d7d57c7cc9b7411e74a7f7d7bb46ba71ef1e9dcf54bd90eca` |
| [WP-O1 Fresh Review — CLEAN](wp-o1-fresh-review.md) | Reviewer `01a07643-3a88-7bf3-8b22-67f3b63d408f` | `WP-O1-fresh-review.md` | 285 | 25,102 | `fe8e1b7045ee973a1e8df26f970ae1f493a94dec4aac53192647c8de7ad0f6ab` |

归档文件保留原始字节，因此正文中历史性的绝对 `/private/tmp` 或 worktree 链接也原样
保留；它们不再是当前导航入口。WP-O1 决策包使用 `.md.raw` 后缀，使其九个历史绝对
worktree 链接不进入当前仓库 Markdown 链接门禁；这只隔离不可改写的归档原件，不给
普通 Markdown 文件增加忽略规则。R7-A/R7-B 六份文件来自结构化事件恢复，R7-C 六份
文件及本轮三份文件来自仍存在原件的逐字节复制；两种路径都以表中 SHA-256 为身份。
后续任务应从本索引进入持久文件，并在新的任务书中使用当前 Git commit/tree 重新签发
PRE stopline。

状态上限保持不变：

- R7-A contracts 已 Accepted，实施落点为 `63d2a0668df3e1291cb3a863327bd5aeed6dd034`。
- R7-B 仅为 `SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`。
- R7-C r0 的 Fresh Review 保持 `BLOCK`；精确 r1 候选获独立 Re-review `CLEAN`，总控据此
  将 R7-C 记为 `SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`。该接受只覆盖设计，
  T01–T50 均未执行，G-ROUTE/G-ENV/G-OUT/G-ID/G-CLIENT/G-AUTH/G-LIFE/G-BUDGET/G-LOG/
  G-BACKEND 十个实施阻断均未解除。
- WP-O1 的精确候选经 Fresh Review `CLEAN` 后由总控接纳为**后续冻结问题的设计准备
  材料**。该接纳不等于 `CONTRACT_FROZEN`，不关闭 G-OUT，不批准 public DTO/status/
  reason、DB schema、算法、HTTP/client 行为或实现准入；Q01–Q12 仍全部开放且未执行。
- M1 仍是 `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`，G2 仍是
  `G2_NOT_ADMITTED`。
- M2 仍为 `In Progress`；R7-C 的设计接受不构成 R7-C implementation admission 或 M2
  Accepted。
- 本归档不授权 SQL、migration、DB/RLS、API、stream、client、source activation、
  B-r4、G2 或任何实现。
