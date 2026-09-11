# WP-O4 公开语义与载体（Q05）— evidence record

## 1. 权限、范围与结论上限

角色：WP-O4 的 **evidence author**（provenance 与 reproducibility 记录者）。本材料不是 Designer，
不是独立 Fresh Reviewer，不是 Gate Analyst，也不是项目总控的接受裁定。

本 evidence 只记录 WP-O4 的 PRE 身份、实际 read-set、语义阅读范围、上游 authority chain，以及本
记录**不建立**什么。它是 WP-O4 decision pack 的伴随出处记录，**不是 decision pack 的第二份副本**，
因此不复制、不新增、也不冻结任何设计决定。

WP-O4 的**范围来源**：上游已接受材料声明的“下一设计组”指向 **Q05 公开语义与载体**（G-OUT 语义与
G-ENV 表达互校）。原句出处为

- `docs/evidence/stage-09p-m2/wp-o3-command-record-authority-decision-pack.md` §12（本机读取时为
  第 669–673 行）「**Q05 公开语义与载体（G-OUT/G-ENV）**：attempt-local / U / C / F / auth-suspension /
  recovery-unavailable / result-unrecoverable 的 public 语义与载体；不冻结 DTO/status/field；
  B internal category 不得入 public 字段；无可靠载体 route 不准入。」；
- `docs/project-status.md`（wp-o3 worktree，本机读取时为第 23 段）「Q05/Q07/Q10/Q11/Q12 继续开放；
  下一设计组按 WP-O1 §10 为 **Q05**（公开语义与载体，与 G-ENV 表达互校）」；
- `docs/evidence/stage-09p-m2/wp-o1-outcome-evidence-scope-decision-pack.md.raw` §10 第 304 行的 Q05
  问题行（owner「OUT→ENV，HTTP/client/B共同」；前置「先语义覆盖再载体，再 consumer 对账；不冻结
  DTO/status/field，不把 B internal category 放 public 字段。无可靠载体 route 不准入」）与第 313 行
  的推荐推进顺序「→ Q05 定义 G-OUT 语义并与 G-ENV 表达互校 →」；
- `docs/evidence/stage-09p-m2/wp-o2-command-boundary-entitlement-decision-pack.md` §11 第 432 行
  「Q05：attempt-local、U、C、F、auth suspension 的 public 语义与载体」与 §8 第 365 行 owner 表
  「HTTP / G-OUT·ENV … 本轮不决定：public DTO/status/reason/route，均留 Q05」；
- `docs/evidence/stage-09p-m2/m2-post-r7-gap-gate.md` §4.1 的 G-ENV / G-OUT 两行（第 91–92 行）。

**重要的诚实边界**：WP-O4 decision pack 本身不是本记录的产物。在本记录所观测的权威 ref
`codex/stage-09p-m2-inventory`（tip `41d47eb`）与 worktree 分支 `codex/stage-09p-wp-o3`（tip `17c579d`）
的 tree 中，**不存在**任何 WP-O4 命名的候选文件；`git grep -i "wp-o4"` 在 main 工作树与 m2inventory
分支上均**零命中**。因此本 evidence 不认证某个精确 WP-O4 候选的身份或正确性；该候选（若存在）必须
由 decision pack 自身的标题、bytes/lines/SHA-256 与随后的独立 Fresh Review 单独登记。本记录只在
需要处转引上游已接受范围，未把一个尚不存在的候选写成既定事实。

**伴随输出文件登记（r5 更新；原 r1/r2/r3/r4 边界如实保留）**：本记录**编写时**输出目录 `.local/wp-o4/` 为
空（`ls -A` 条目数 = 0），故当时未登记任何伴随 decision pack 的字节身份——这是原诚实边界。pack 作者
随后产出了候选（r1），并已过三轮 Fresh Review；本记录现**补登记** pack 的字节身份，以闭合 provenance
缺口（对应 r0 Fresh Review 的 **ADV-08**）。登记如下（均为实际计算的字节身份，非从其他文档抄录）：

- **r1（历史现场身份；亦见 r0 Fresh Review §1 登记）**：**490 行 / 48,207 bytes / SHA-256
  `0f87591d63e42de7e760aeb2a16a1c32e6c05b8c4f4297b44abe4dd2843e7e59`**。
- **r2（历史现场身份，以 `wc -l` / `wc -c` / `shasum -a 256` 实算）**：**592 行 / 66,616 bytes / SHA-256
  `fbbef8dabc2aeb0bd032aa17b936d48178f60290c809f3018b742075ba9b58a7`**。
- **r3（历史现场身份，以 `wc -l` / `wc -c` / `shasum -a 256` 实算）**：**697 行 / 82,459 bytes / SHA-256
  `e799ff33baa0d8a876f36dac1095e6fda19b1221710f93f47bb0e9ecb48a0dae`**。
- **r4（历史现场身份，以 `wc -l` / `wc -c` / `shasum -a 256` 实算）**：**775 行 / 94,972 bytes / SHA-256
  `8fc6a66522463ab3e6ab1456b602d030969b78746a13d78e91f75337b82f251f`**。
- **r5（本记录本次以 `wc -l` / `wc -c` / `shasum -a 256` 实算）**：**821 行 / 103,587 bytes / SHA-256
  `1bbca74b56b7aa5969c77357d5718fa7cef86a41b54b72313f87f7c0d7680f6e`**。

pack 作者按 r0 Fresh Review 的 11 条残余 P2 把同一文件修订为 **r2**（新增 §4.1.1 与 §14「修订说明
(r2)」）；r2 经第二轮独立三 lens 复评（三 lens `CLEAN`、`P0=0/P1=0`，对抗性 lens 达 `0/0/0`）后残余
**6 条 P2**（`FC-R2-01…FC-R2-05`、`WP-O4-R2-AUTH-01`），pack 作者据此再修订为 **r3**（新增 §15「修订
说明 (r3)」，并改 §2.1/§4/§5/§6.3/§8/§11/§13 对应处）；r3 经第三轮独立三 lens 复评（三 lens `CLEAN`、
`P0=0/P1=0`，fail-closed lens 达 `0/0/0`）后残余 **7 条 P2**（`WP-O4-R3-AUTH-01…04`、`ADV-R3-01…03`），
pack 作者据此再修订为 **r4**（新增 §16「修订说明 (r4)」，并改 §1/§2/§2.1/§4/§4.1/§4.1.1/§5.2/§8.2/§9.1/
§12/§13 对应处）。r4 的 §2 读取清单**新增两项定向（非通读）读取的源码**：`services/api/src/app.ts`
（366 行 / 13,073 bytes / `cbb8d4d198e0010118412c32ca2f5e24ced4e9d1630457b30c0f45db74a27895`）与
`services/api/src/database/repository.ts`（2,907 行 / 97,037 bytes /
`b354cd20e9d71bb7f1e323cb86332d2208a8e146a40f26cb09cf26704b52c669`）；此二项**仍是本 evidence §4.3 所列
“未通读的源码”**（r4 只定向读相关段落，未改变本 evidence 的 §3.3/§4.3 读取范围）。
pack 作者据此再修订为 **r5**（新增 §17「修订说明 (r5)」，并改 §2/§2.1/§3.3/§4.1.1/§6.3/§10/§11/§13
对应处）。r5 的 §2 读取清单**新增两项定向（非通读）读取的上游 design/review**：
`docs/evidence/stage-09p-m2/r7c-shadow-design-r1.md`（409 行 / 79,559 bytes / `4884b06081…53ad0627`）与
`docs/evidence/stage-09p-m2/r7c-r1-fresh-review.md`（216 行 / 25,473 bytes / `ca6535848a…bec4f`，与 §2 PRE
钉住材料 ref `41d47eb` 上的同名文件逐字节相等）；此二项**仍是本 evidence §4.3 所列“未通读的上游设计/审查
输入”**（r5 只按行号定向读相关段落，未改变本 evidence 的读取范围）。本记录**未读取 r2/r3/r4/r5 正文**，
不认证其设计正确性或 finding 处置——r5 的审查仍须由随后的独立 Fresh Review 单独完成。
上述 r1/r2/r3/r4/r5 身份作为历史观测保留，不删除。

本 evidence 没有执行产品测试、数据库、网络、Fastify、Taro、Docker、migration、gate 或任何 M2 runtime
检查；没有切换分支，没有修改任何 tracked 文件；唯一写入是本文档。

## 2. PRE identity（实际观察）

本记录实际观察的是**当前工作树（branch `main`）**、**材料权威 ref**、以及**WP-O3 材料 worktree**三
部分；三者分开登记，不混同。

### 2.1 当前工作树身份

| 项 | 实际观察值 |
| --- | --- |
| 当前分支 | `main` |
| HEAD | `23450a1f3508e8030d753748291d265ad308df05` |
| HEAD tree | `1cfbc2564b1c5e923f078fdb0436a66a28b90690` |
| HEAD subject | `docs(stage09a): record final acceptance and main integration` |
| `git status --porcelain=v1 --untracked-files=all` | ` M AGENTS.md`（仅一处未提交改动，见 §4.3） |

### 2.2 材料权威 ref 身份

| 项 | 实际观察值 |
| --- | --- |
| 权威 branch ref | `refs/heads/codex/stage-09p-m2-inventory` |
| ref tip | `41d47ebfa02313e2f388ae1749b54f4cec3f97d8` |
| ref tip tree | `ec66e80cec1c89bb1ea6369df2ac7bcdf3d87ead` |
| ref tip subject | `docs(stage09p): accept and archive WP-O2 decisions` |
| upstream | 无（`%(upstream:short)` 为空；该分支只有本地引用、从未推送） |

### 2.3 WP-O3 材料 worktree 身份（本记录读取 WP-O3 与 Q05 上游材料之处）

| 项 | 实际观察值 |
| --- | --- |
| worktree 路径 | `/Users/aipuli/Documents/Projects/meal-agent-lab/.local/worktrees/wp-o3` |
| 当前分支 | `codex/stage-09p-wp-o3` |
| HEAD | `17c579dc57f54c65800d23ee9def3d98210de0c5` |
| HEAD tree | `cd4ee332bda51e0e99a19531f65a26384fb1a70b` |
| HEAD subject | `docs(stage09p): record the WP-O3 acceptance point and the un-pushed 09P risk` |
| 唯一 parent | `e41a441f9c8b4788aadbba7a963182c11798bc54`（恰好一个） |
| upstream | 无（只有本地引用、从未推送） |
| `git status --porcelain=v1 --untracked-files=all` | 空输出（clean，含 untracked 检查） |

**登记口径**：本记录中，**WP-O3 的四份材料**（decision pack、evidence、Fresh Review、评审谱系 r0–r2）
以及**归档 README / project-status** 读自该 worktree（branch `codex/stage-09p-wp-o3` @ `17c579d`）；
**其余一切 Stage 09P 上游材料**（WP-O1、WP-O2、Gap Gate、源码）读自 ref `codex/stage-09p-m2-inventory`
（tip `41d47eb`），即 `git show codex/stage-09p-m2-inventory:<path>`，或读自上述 worktree 中与其
**字节相同**的副本（见 §3.3 注）。

### 2.4 WP-O3 接受落点与谱系（用于 §5）

| 项 | 实际观察值 |
| --- | --- |
| WP-O3 接受提交 | `e41a441f9c8b4788aadbba7a963182c11798bc54` |
| WP-O3 接受提交 subject | `docs(stage09p): accept WP-O3 command record and authority decisions` |
| 接受提交的 parent | `41d47ebfa02313e2f388ae1749b54f4cec3f97d8`（即 §2.2 的 m2inventory tip） |
| 接受点记提交 | `17c579dc57f54c65800d23ee9def3d98210de0c5`（即 §2.3 的 worktree HEAD） |
| 上游既有落点 | R7-A contracts 实施落点 `63d2a0668df3e1291cb3a863327bd5aeed6dd034`，subject `feat(contracts): add M2 inventory replay boundaries` |

**关键拓扑事实**：WP-O3 的接受落点 `e41a441`（及其接受点记 `17c579d`）位于分支
`codex/stage-09p-wp-o3`，**尚未 ff 集成进** `codex/stage-09p-m2-inventory`（§2.2 的 tip 仍停在
`41d47eb`，其 tree 中不含 WP-O3 命名文件）。因此本记录明确区分：WP-O3 的**材料**在 worktree 上，
WP-O3 的**接受落点**在 `codex/stage-09p-wp-o3` 上，二者均不在 m2inventory ref 的 tree 内。

### 2.5 实际执行的只读命令

```text
git -C /Users/aipuli/Documents/Projects/meal-agent-lab rev-parse HEAD
git -C /Users/aipuli/Documents/Projects/meal-agent-lab rev-parse 'HEAD^{tree}'
git -C /Users/aipuli/Documents/Projects/meal-agent-lab branch --show-current
git -C /Users/aipuli/Documents/Projects/meal-agent-lab status --porcelain=v1 --untracked-files=all
git -C /Users/aipuli/Documents/Projects/meal-agent-lab rev-parse codex/stage-09p-m2-inventory
git -C /Users/aipuli/Documents/Projects/meal-agent-lab rev-parse 'codex/stage-09p-m2-inventory^{tree}'
git -C /Users/aipuli/Documents/Projects/meal-agent-lab rev-parse codex/stage-09p-wp-o3
git -C /Users/aipuli/Documents/Projects/meal-agent-lab rev-list --parents -n 1 codex/stage-09p-wp-o3
git -C /Users/aipuli/Documents/Projects/meal-agent-lab rev-list --parents -n 1 e41a441f9c8b4788aadbba7a963182c11798bc54
git -C /Users/aipuli/Documents/Projects/meal-agent-lab/.local/worktrees/wp-o3 rev-parse HEAD
git -C /Users/aipuli/Documents/Projects/meal-agent-lab/.local/worktrees/wp-o3 rev-parse 'HEAD^{tree}'
git -C /Users/aipuli/Documents/Projects/meal-agent-lab/.local/worktrees/wp-o3 branch --show-current
git -C /Users/aipuli/Documents/Projects/meal-agent-lab log -1 --format='%H %s' <sha-or-ref>
git -C /Users/aipuli/Documents/Projects/meal-agent-lab branch --list 'codex/stage-09p-*'
git -C /Users/aipuli/Documents/Projects/meal-agent-lab for-each-ref --format='...' refs/heads/codex/stage-09p-wp-o3 refs/heads/codex/stage-09p-m2-inventory
git -C /Users/aipuli/Documents/Projects/meal-agent-lab remote -v
git -C /Users/aipuli/Documents/Projects/meal-agent-lab diff --stat codex/stage-09p-m2-inventory 17c579d -- packages services apps
git -C /Users/aipuli/Documents/Projects/meal-agent-lab show <ref>:<path> | wc -l / wc -c / shasum -a 256
git -C /Users/aipuli/Documents/Projects/meal-agent-lab grep -in 'wp-o4'
git -C /Users/aipuli/Documents/Projects/meal-agent-lab grep -n '<symbol>' codex/stage-09p-m2-inventory
wc -l <file> ; wc -c <file> ; shasum -a 256 <file>
```

以上是只读身份观察，不是产品 checker、gate 或动态测试。没有 checkout/switch/branch/stash。

## 3. Read-set（完整输入材料清单与行数）

行数用 `wc -l`（对 worktree 文件）或
`git show codex/stage-09p-m2-inventory:<path> | wc -l`（对 ref 文件）实际计算；`wc -l` 计的是换行符
终止的行数。字节数用 `wc -c` 一并计算。SHA-256 由本次以 `shasum -a 256`（worktree 文件）或
`git show <ref>:<path> | shasum -a 256`（ref 文件）**重新计算**，不是从其他文档抄录。状态列区分
**通读**（全文逐行）与**定向**（只读相关段落/符号定位，见 §4）。

### 3.1 权限与范围事实源（3 项）

| 输入材料 | Lines | Bytes | SHA-256（本次计算） | 阅读状态 |
| --- | ---: | ---: | --- | --- |
| `docs/project-status.md`（wp-o3 worktree） | 1060 | 125702 | `45b24d532497ca338fde7d63acd4e2a6df3b9177a9c46195989714ddc2aca1cd` | 定向 |
| `docs/evidence/stage-09p-m2/README.md`（wp-o3 worktree） | 127 | 12812 | `060d70cbe6859b2419ec2e004f88d83edd69d82a321b30173cc21a447f78535a` | 通读 |
| `codex/stage-09p-m2-inventory:docs/evidence/stage-09p-m2/README.md` | 96 | 9511 | `10e2d5ec5c0dceb16fb42b6bd97abf6b37302bb67cc016ed62807144fdba32fe` | 通读 |

两份 README 为同一归档索引的不同修订：m2inventory 版（96 行）止于 WP-O2；wp-o3 worktree 版（127 行）
在其上新增「WP-O3 command record 与 authority」一节。二者均逐字节与 `codex/stage-09p-m2-inventory`
上的对应版本一致（§2 口径）。

### 3.2 设计与审查输入（8 项）

| 输入材料 | Lines | Bytes | SHA-256（本次计算） | 阅读状态 |
| --- | ---: | ---: | --- | --- |
| `wp-o3-command-record-authority-decision-pack.md` | 793 | 83548 | `6e2775f4cceef14e83f73ce44ed3b4c4ca52ce91d7522260114fd663b5f5d754` | 通读 |
| `wp-o3-command-record-authority-evidence.md` | 291 | 22456 | `1bc922786ae16bb9f4c72230ab11c464a75297ab535e16d8418122c6b62047cb` | 通读 |
| `wp-o3-fresh-review.md` | 119 | 10000 | `d6bed0651495147647a603219113bae21f34c7b8e54041c3af7feaae6d37e416` | 通读 |
| `wp-o3-review-history-r0-r2.md` | 72 | 6135 | `5a7c29c36b9b1a3e2057839fa3615a934abe103e689ac33104a0f5ae29470e87` | 通读 |
| `wp-o2-command-boundary-entitlement-decision-pack.md` | 438 | 29516 | `239e82c2a800cbff7e3044b41d09f41bed305b1f072cc759527197c9ac25bd1d` | 通读 |
| `wp-o2-command-boundary-entitlement-evidence.md` | 142 | 8435 | `33c98949913b8cdce3a9ddbb0e62d9312d469c8ac9f5fead77bf9f7f6e9fb92f` | 通读 |
| `m2-post-r7-gap-gate.md` | 323 | 45917 | `0fc31a5787689f1b1683b07fb9aa19eff4ceb81deaa155e4d5ad7e415b17f535` | 定向 |
| `wp-o1-outcome-evidence-scope-decision-pack.md.raw` | 363 | 63296 | `68945d9f1566687d7d57c7cc9b7411e74a7f7d7bb46ba71ef1e9dcf54bd90eca` | 定向 |

前四项为 WP-O3 材料，读自 §2.3 的 worktree（`codex/stage-09p-wp-o3` @ `17c579d`）；后四项读自
`codex/stage-09p-m2-inventory`（tip `41d47eb`）。表中 SHA-256 与上游归档 README / project-status 登记
值一致，均由本次独立重算确认。

### 3.3 当前源码静态对照（4 项）

源码只用于确认 legacy 公开载体（Q05/G-OUT/G-ENV 相关）的静态形状与缺口，不把静态阅读当成动态
证据，也不据此主张任何机制已实现。

| 输入材料 | Lines | Bytes | SHA-256（本次计算） | 阅读状态 |
| --- | ---: | ---: | --- | --- |
| `packages/contracts/src/api.ts` | 172 | 4690 | `c00763ecf31e956aaf2dc22c48fe94b0e754c2f45bf126207e1c531296a58543` | 通读 |
| `services/api/src/routes.ts` | 861 | 22623 | `d156d44ad505d8a74ba38f9ae6d6e2957efbe187eb133bc68f7c57717d0e4b22` | 通读 |
| `apps/client/src/core/api-client.ts` | 163 | 4915 | `ad960d37ec0f34f3c7e224c558e6b80f29317cc0bc281a5bbc46442fe4d87a66` | 通读 |
| `apps/client/src/core/command-registry.ts` | 554 | 16733 | `5ce62fa9d2b0483d2ae86a6853f13c5c2b6f5bd552245f20c410489846c6207a` | 通读 |

**注（读取位置与同源确认）**：上表四项读自 §2.3 的 worktree 文件；`git diff --stat codex/stage-09p-m2-inventory 17c579d -- packages services apps` 输出为**空**，即 worktree 分支与
`codex/stage-09p-m2-inventory` 在 `packages/`、`services/`、`apps/` 三棵树上的字节**完全相同**；
因此上述源码身份对两个 ref 同时成立。

read-set 合计 **15** 项：权限与范围事实源 3 项、设计与审查输入 8 项、当前源码静态对照 4 项。

## 4. 语义阅读范围与明确未读

### 4.1 通读范围

以下材料被逐行通读（工具输出分段覆盖全文）：

- §3.1 的两份 `docs/evidence/stage-09p-m2/README.md`（127 / 96 行）；
- §3.2 的 WP-O3 四份材料（pack 793、evidence 291、Fresh Review 119、评审谱系 72）与 WP-O2 的
  decision pack（438）、evidence（142）；
- §3.3 的四份源码（`api.ts`、`routes.ts`、`api-client.ts`、`command-registry.ts`）。

### 4.2 定向范围

以下按任务允许只读相关段落/符号，未把定位输出冒充全文语义重审：

- `docs/project-status.md`（wp-o3 worktree）：第 1–18 行（当前结论头）、第 23 段（WP-O3 接受收口与
  「下一设计组为 Q05」）、第 1018–1060 行（M2 现状、Deferred、内部发布阻断），并以
  `grep -n 'Q05|G-OUT|G-ENV|WP-O3|公开语义|载体'` 定位相关行。历史 09A/09P-M0 长段不作为本轮 Q05
  authority。
- `m2-post-r7-gap-gate.md`：第 1–134 行（§1 Scope/authority、§2 PRE 与材料、§3 状态上限、§4 统一
  gap inventory 与 §4.1 十个 G-*、§4.2 R7-B 剩余项），并以 `grep -n 'G-OUT|G-ENV'` 定位；未通读
  §6–§9 的排序与任务书其余段落。
- `wp-o1-outcome-evidence-scope-decision-pack.md.raw`：§10 的 Q05 问题行（第 304 行）、Q03/Q04/Q06/
  Q07/Q09/Q10/Q11/Q12 相邻问题行（第 302–311 行）与推荐推进顺序（第 313 行）；未通读 E01–E19 全表、
  4×7 矩阵与 O01–O16 反例正文。

以上源码只证明当前公开载体与缺口的静态形状；不能证明 Fastify 真实 target/header、Taro 真实发送
字节、数据库 commit/cancel、权限撤回竞态、receipt retention、真实 route 接线或任何动态 budget。

### 4.3 明确（有意或实际）未读

- 未通读的**项目规则与事实源**：`AGENTS.md`、根 `README.md`、`docs/README.md`、阶段 09P 计划
  `docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md`、ADR-0003、ADR-0004 及全部其它
  ADR。本记录未把它们计入 §3 read-set；其行数虽在定位时观测过，但未作语义阅读，故不在此登记为
  输入。
- 未通读的**上游设计/审查输入**：`wp-o1-fresh-review.md`、`wp-o2-fresh-review.md`、`r7a-r6-design.md`、
  `r7a-r6-evidence.md`、`r7a-r6-fresh-review.md`、`r7b-shadow-design.md`、`r7b-shadow-evidence.md`、
  `r7b-shadow-fresh-review.md`、`r7c-shadow-design-r0.md`、`r7c-shadow-design-r1.md`、
  `r7c-shadow-evidence-r0.md`、`r7c-shadow-evidence-r1.md`、`r7c-r0-fresh-review-block.md`、
  `r7c-r1-fresh-review.md`。这些属于上游谱系，可在需要时从归档索引重取；本记录只通过其登记身份
  （§5）与下游转引引用它们，未把它们登记为本次重新完成的语义审查。
- 未通读的**源码**：`packages/contracts/src/inventory-v2.ts`、`seasoning-v1.ts`、`services/api/src/app.ts`、
  `errors.ts`、`logging.ts`、`log-events.ts`、`utils.ts`、`database/*`、`authorization-*.ts`、`wechat/*`、
  `apps/client/src/core/idempotency.ts`、`command-dispatcher.ts`、`session-store.ts`、`app-services.ts`、
  `platform/*`、其余页面/核心模块、全部 tests、OpenAPI 产物、Dockerfile、infra 与 scripts。
- **工作树 `AGENTS.md` 的未提交改动**：`main` 工作树存在 ` M AGENTS.md`。该改动未提交、不属于
  `codex/stage-09p-m2-inventory` 的 read-set，也不在本记录中作为 authority 使用；本记录未读取其
  diff 正文。
- 未打开任何历史 `/private/tmp` 或 `.codex/worktrees` 路径，未联网，未读取外部网页或真实用户/家庭/
  健康/食品/凭据数据。

### 4.4 未执行的检查

未运行 Node/pnpm 产品测试、Fastify/app.inject/真实 socket/Taro 实验、typecheck/build、generator、
checker、gate、DB、SQL、migration、RLS、Docker、N-1、B-r4、G2 或任何 M2 门禁；`T01–T50` 执行数保持
0。没有把上游历史 `CLEAN` 或测试数字当作本次结论。

## 5. Authority chain（既有 Accept 谱系）

下列材料在 WP-O4 之前已由各自 review 与项目总控处理。**材料身份 SHA-256 均由本次从相应 ref
重新计算**（§3）；任务/角色身份来自 `docs/evidence/stage-09p-m2/README.md` 与 `docs/project-status.md`
的登记。

| 上游材料 | 已登记的结论 | 处理者 / 任务身份 | 材料身份（本次计算的全文 SHA-256） |
| --- | --- | --- | --- |
| R7-A r6 contracts | **Accepted**（只冻结 contracts，不代表 M2 Accepted）；实施落点 `63d2a0668df3e1291cb3a863327bd5aeed6dd034` | 独立 Fresh Review `01a071dc-6e23-7d62-ba89-bfdf6e45930f` 给 `CLEAN`，P0/P1/P2=`0/0/0`；总控接受 | 8 路径 contracts（本记录未重算 contracts 全文 SHA） |
| R7-B shadow design/evidence | `R7-B_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED` | Designer `01a07243-c177-7c80-a809-81d41c478968`；Fresh Design Review `01a07270-f6c5-7152-b122-c59e143a2788` 给 `CLEAN`，P0/P1/P2=`0/0/0`；总控接受 | 归档登记：design 424 行 / 50,408 bytes `24e1f249…b53d98d3f`；review 139 行 / 18,444 bytes `7e77977e…5a7f25f`（本记录未通读、未重算） |
| R7-C r0 shadow design | 历史 `BLOCK`（保留，未改写） | Reviewer `01a0755e-aa9c-7740-95d2-a2b97ad4f2b9`，P0/P1/P2=`0/1/0` | 归档登记见 README（本记录未通读、未重算） |
| R7-C r1 shadow design/evidence | `R7-C_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED` | Designer `01a07544-750c-7c63-93ff-509aec093337`；全新独立 Re-review `01a0758c-b51c-79b1-9351-a2b97ad4f2b9` 给 `CLEAN`，P0/P1/P2=`0/0/0`；总控接受 | 归档登记：design 409 行 / 79,559 bytes `4884b06081…53ad0627`；review 216 行 / 25,473 bytes `ca6535848a…bec4f`（本记录未通读、未重算） |
| Post-R7 Gap Gate | 判定 `M2_POST_R7_GAP_GATE: DESIGN_ONLY_NEXT_AVAILABLE`；**关闭的实施 blockers 为 0** | 独立 Gate Analyst 任务 `01a075a6-05db-7961-89a2-11972ee4ba25` | `0fc31a5787…b17f535`（323 lines / 45,917 bytes，本次重算） |
| WP-O1 decision pack | `WP-O1_OUTCOME_EVIDENCE_SCOPE: READY_FOR_REVIEW`；总控接纳为**后续冻结问题的设计准备材料**（不等于 `CONTRACT_FROZEN`，不关闭 G-OUT，不批准 public DTO/status/reason） | Designer `01a075cd-6a4c-7171-bb62-fd0ae963df4f`（有效第二轮）；Fresh Review `01a07643-3a88-7bf3-8b22-67f3b63d408f` 给 `CLEAN`，P0/P1/P2=`0/0/0` | pack（`.raw`）`68945d9f15…f54bd90eca`（363 lines / 63,296 bytes，本次重算） |
| WP-O2 decision pack/evidence | `WP-O2_FRESH_REVIEW: CLEAN`；总控接纳为 **Q01/Q02/Q08 的逻辑决策基线**（不等于 `CONTRACT_FROZEN`，不关闭任何 G-*） | 总控任务 `01a065a2-45d8-7570-a284-9c3a668b319b`，基线 `41c2e7b5013051201c10365b9f41af00b643fae8`；Fresh Review `01a076e2-fb96-7523-bfff-ef08db7d139c` 给 `CLEAN`，P0/P1/P2=`0/0/0` | pack `239e82c2a8…ac25bd1d`（438 lines / 29,516 bytes）；evidence `33c9894913…6e9fb92f`（142 lines / 8,435 bytes）；均本次重算 |
| WP-O3 decision pack/evidence | 四轮独立三 lens 评审：r0/r1 各出 1 条真实 fail-open 判 **BLOCK**，r2 三 lens CLEAN（残余 5 P2），**r3 三 lens CLEAN 且 P0/P1/P2=`0/0/0`**；总控据此接纳为 **Q03/Q04/Q06/Q09 的逻辑决策基线**（不等于 `CONTRACT_FROZEN`，不关闭任何 G-*；O9-5 在 Q10 关闭前保持 admission blocker） | 总控在 `codex/stage-09p-m2-inventory` 的接受落点（tip `41d47eb`）之上、以 `.local/wp-o3/` 形成；接受落点 `e41a441`（parent `41d47eb`），接受点记 `17c579d` | pack `6e2775f4cc…b5f5d754`（793 lines / 83,548 bytes）；evidence `1bc922786a…c6b62047`（291 lines / 22,456 bytes）；Fresh Review `d6bed06514…6d37e416`（119 lines / 10,000 bytes）；评审谱系 `5a7c29c36b…29470e87`（72 lines / 6,135 bytes）；均本次重算 |

### 5.1 持续有效的状态上限（转引，非本记录裁定）

- M1 = `M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`，**不是 Accepted**；Fresh Audit A = `CLEAN`；
  household-safety `292/292` 只构成 LIMITED dynamic evidence，不是 Fresh Audit B；B-r1/r2/r3 = `BLOCK`，
  B-r4 未运行。
- G2 = `G2_NOT_ADMITTED`；source pack draft/inactive；public trust allowlist empty。
- M2 = `In Progress`，整体未 Accepted。R7-A contracts `Accepted`；R7-B 与 R7-C 均
  `SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED`。
- R7-C `T01–T50` 全部未执行；十个实施阻断 `G-ROUTE`/`G-ENV`/`G-OUT`/`G-ID`/`G-CLIENT`/`G-AUTH`/
  `G-LIFE`/`G-BUDGET`/`G-LOG`/`G-BACKEND` 全部未解除。其中 **G-OUT 与 G-ENV 属于本 WP-O4（Q05）的
  直接对象**，按 §1 的范围来源仍 open。
- WP-O3 之后，**下一设计组为 Q05**（即本 WP-O4 的来源范围）；Q07/Q10/Q11/Q12 仍开放。
- WP-O3 的接受落点 `e41a441` 只在本地分支 `codex/stage-09p-wp-o3` 上，**尚未 ff 集成进**
  `codex/stage-09p-m2-inventory`；两条分支均**无 upstream、从未推送**。

## 6. 明确未决与准入 stopline

本 evidence **不建立**、也不得被读成建立了以下任何一项：

1. **不产出、不认证 WP-O4 候选**。本记录是出处记录，不是 decision pack，也不是其 Review；在 §2 观测
   的 refs/tree 中均无 WP-O4 命名文件。r2 起本记录在 §1「伴随输出文件登记（r5 更新）」中**登记 pack 的
   字节身份**（r1/r2/r3/r4/r5 的 lines/bytes/SHA-256，实算），但该登记**仅是 provenance 锚定**，**不**认证 pack
   的设计正确性或 finding 处置；候选身份的正确性仍须由 pack 自身与随后的独立 Fresh Review 单独裁定。
   `BLOCK` 是正常结果，须如实报告；本记录不预判其结果。
2. **不实施、不冻结任何设计**。没有新增或修改 public DTO/status/reason/route/operationId、公开
   envelope、problem/receipt 关联载体、SQL/RLS/migration、lock/isolation/timeout、retention/TTL/GC、
   capability name 或 client storage/API/port。Q05 要求的“公开语义覆盖”与“可靠载体 route”均未被本
   记录定义。
3. **不关闭任何 gate、不改变任何状态**。十个 `G-*`（含本 WP-O4 直接相关的 `G-OUT`、`G-ENV`）全部
   保持开放；M1 limited、G2 not admitted、M2 `In Progress`、R7-B/R7-C `IMPLEMENTATION_BLOCKED` 均不变；
   不授予任何 implementation、route 接线、source activation 或 G2 admission 资格。
4. **不批准 Q05 的答案**。本记录只登记 Q05（公开语义与载体）为 WP-O4 的范围来源；Q05 仍未决——
   attempt-local / U / C / F / auth-suspension / recovery-unavailable / result-unrecoverable 的 public
   语义、domain `rejected` 的获准 envelope、problem 与 receipt 的关联证明、无 response 的 consumer
   约束，均不在本记录权限内。
5. **不含动态证据**。没有运行任何测试、gate、数据库、网络、Taro、Docker 或 migration；`T01–T50` 与
   全部书面 oracle 执行数为 0；上游 `CLEAN` 与历史测试数字不被外推为 WP-O4 或 M2 的动态结论。
6. **不声称字节级完备**。SHA-256/行数只对所读的这些字节成立；本记录未重算 §4.3 明确未读的材料，
   也未重算未列入 §3 的任何文件。Git `clean` 与 hash 对账只证明所观察的 tracked/untracked 状态与
   所读字节身份。
7. **不主张 WP-O3 接受已进入结构基线**。WP-O3 的接受落点 `e41a441` 仅存在于本地分支
   `codex/stage-09p-wp-o3`，尚未集成进 `codex/stage-09p-m2-inventory`，两分支均未推送；本记录只
   如实登记该拓扑，不把它读成已被 m2inventory 的 tree 接纳。
8. **不替代上游 owner 与 Fresh Review**。本记录不代替 G-OUT/G-ENV 的 HTTP contract owner、B/client/
   identity/auth 责任方的裁定，也不代替 WP-O4 的独立 Fresh Review 与总控接受流程。
