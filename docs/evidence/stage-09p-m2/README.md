# Stage 09P-M2 设计与审查证据归档

状态：**字节级归档副本**。本目录保存 R7-A 与 R7-B 在准入/设计收口时使用的六份
材料，解决原始 `/private/tmp` 目录会被系统清理、后续任务无法重新执行 hash stopline
的问题。归档动作不生成新的设计结论、审查结论或实现授权。

2026-09-06，原临时目录在 R7-C Entry Gate 完成后被系统清理。六份内容随后从对应
Codex 任务日志中的结构化 `FileChange` 事件恢复：先重放 `add` 的完整内容，再按原顺序
重放全部 `update` unified diff。每个最终文件都重新计算 SHA-256，并与清理前已登记值
逐字节一致。恢复过程中没有从聊天摘要、截断终端输出或人工转写重建正文。

| 持久归档 | 来源任务 | 原临时文件 | Lines | Bytes | SHA-256 |
| --- | --- | --- | ---: | ---: | --- |
| [R7-A-r6 design](r7a-r6-design.md) | Designer `01a06728-8d13-78e3-9eb3-bec73776cd25` | `R7-A-r6-design.md` | 75 | 5,417 | `179b4b7066e6bc82d3d99518abe595c6348bb6f26c23b248bc6df2182351e825` |
| [R7-A-r6 evidence](r7a-r6-evidence.md) | Designer `01a06728-8d13-78e3-9eb3-bec73776cd25` | `R7-A-r6-evidence.md` | 76 | 4,889 | `d9c2b1e41bd87ca9236c5a41c6f29a1350713d304852ba83463152afc996f339` |
| [R7-A-r6 Fresh Review](r7a-r6-fresh-review.md) | Reviewer `01a071dc-6e23-7d62-ba89-bfdf6e45930f` | `root-audit/report.md` | 187 | 8,833 | `1ad22c7258159e2ceba4aa398acf16c62422f17e8536717ab30988ca731c0ebe` |
| [R7-B shadow design](r7b-shadow-design.md) | Designer `01a07243-c177-7c80-a809-81d41c478968` | `R7-B-shadow-design.md` | 424 | 50,408 | `24e1f2496df347a0215041835f45d79ba577256d13d1d6f8e7557e2b53d98d3f` |
| [R7-B shadow evidence](r7b-shadow-evidence.md) | Designer `01a07243-c177-7c80-a809-81d41c478968` | `R7-B-shadow-evidence.md` | 152 | 13,556 | `93605e6893e53d8472ccde8a6213f258b7769c22b4a0fbb4e6d4ddb624136b68` |
| [R7-B Fresh Design Review](r7b-shadow-fresh-review.md) | Reviewer `01a07270-f6c5-7152-b122-c59e143a2788` | `R7-B-shadow-design-review.md` | 139 | 18,444 | `7e77977e86cf4b03483f04efb1810c37a4357cc46f97eff54689b4a6b65b1b57` |

归档文件保留原始字节，因此正文中历史性的绝对 `/private/tmp` 链接也原样保留；它们
不再是当前导航入口。后续任务应从本索引进入持久文件，并在新的任务书中使用当前 Git
commit/tree 重新签发 PRE stopline。

状态上限保持不变：

- R7-A contracts 已 Accepted，实施落点为 `63d2a0668df3e1291cb3a863327bd5aeed6dd034`。
- R7-B 仅为 `SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`。
- M1 仍是 `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`，G2 仍是
  `G2_NOT_ADMITTED`。
- M2 仍为 `In Progress`，R7-C 仅获 Entry Gate 的 `DESIGN_ONLY` 裁定。
- 本归档不授权 SQL、migration、DB/RLS、API、stream、client、source activation、
  B-r4、G2 或任何实现。
