# R7-B Shadow Evidence

角色：Designer；范围为只读材料提取和两个临时Markdown文件。任务事实基准/开始为2026-09-05，交付为2026-09-06（Asia/Shanghai）。
本文件不提供实现、CLEAN、Accepted或admission判定；设计文件READY_FOR_REVIEW仅表示可交后续独立Design Review。

## 1. PRE / POST 身份

仓库绝对路径：`/Users/aipuli/.codex/worktrees/5483/meal-agent-lab`。

| 检查 | PRE | POST | 对账 |
| --- | --- | --- | --- |
| git status --porcelain=v1 --untracked-files=all | 空输出 | 空输出 | 完全相同、clean |
| HEAD | e9d80b00c71bd041efdb7c5487ba1c5fb0b92e91 | e9d80b00c71bd041efdb7c5487ba1c5fb0b92e91 | 符合expected HEAD |
| HEAD tree | 634f1a8e855f99743e267aacf9d3d09e26eb0107 | 634f1a8e855f99743e267aacf9d3d09e26eb0107 | 符合expected tree |
| 唯一 parent | 63d2a0668df3e1291cb3a863327bd5aeed6dd034 | 63d2a0668df3e1291cb3a863327bd5aeed6dd034 | rev-list仅一个parent |
| refs/heads/codex/stage-09p-m2-inventory | e9d80b00c71bd041efdb7c5487ba1c5fb0b92e91 | e9d80b00c71bd041efdb7c5487ba1c5fb0b92e91 | 符合expected ref |

PRE命令退出码0；status部分没有条目，其后的四行依次为HEAD、tree、HEAD+唯一parent、branch ref。POST在设计成稿后及最终文件封口时重复同组只读查询；后续status显式使用--no-optional-locks。
历史R7-A implementation parent `8a69bc2435e1b7ebb3667d6bbea39ef5dffe81b8` 来自任务书与R7-A材料，不与本候选parent混淆。
本任务未主动创建branch/worktree；是否detached不作为身份替代，以上commit/tree/parent/ref为核对依据。

## 2. Read-set、实际读取内容与来源摘要

所有下列文件均可读取；无权限拒绝、缺失或不可读取的指定文件。根Designer直接读取指定文件的内容或相关范围，并由两个只读助手并行提取契约和authority材料。
部分大段cat/sed的工具展示被截断；随后按任务相关范围补读。这里不把截断输出冒充完整逐行审计，也不把checksum读取冒充语义阅读。
当前project-status重点读取开头当前事实和980–1041行；其余历史段落不是本轮状态authority。
契约助手报告已阅读四个contract/test文件；根Designer直接补读parser limits/reasons、Inventory 440–762 replay边界、Seasoning 1–130及205–335边界、test标题及904–1120 replay/empty案例。
测试文件只作为设计证据阅读；测试从未运行。上游report记载的72/72或CLEAN等只属于上游历史，不是本任务结果。

以下路径除三个/private/tmp绝对路径外，均相对于上述仓库绝对路径；SHA-256是本轮实际shasum读取值。

| 已读文件 | SHA-256 |
| --- | --- |
| AGENTS.md | 192ce3ae3a2c00b85320bf8dc616f087c5f32d112faa960ab6d5a4bcc8704bbf |
| README.md | 16d1104dec3e6d6adb3096332a0fb73dddb3e72b8ba2bfe3e73fdb341455c06e |
| docs/README.md | 7b5d067b6ba368c7eb2f8a4f0be8ec65b6b721f624e7fa39adee15472c96ccf2 |
| docs/project-status.md | c303cbe5e00154e82199f1ef242b9283d5194bcef5d156117e48764a729b07a0 |
| docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md | c25b27a66f8c55856c70cae45ec9b46c1eed242562c80c53bb0026f1221d2339 |
| docs/architecture/decisions/0007-food-knowledge-governance-and-domain-core.md | 5f03882f9bf2d3cc23ef7834bd4e2a5af481696fb1e887cca16df08a0711ee85 |
| docs/architecture/decisions/0008-stage09p-m0-evidence-boundary.md | dd5d38597c067b07cfa80da1e66a58658a0ee0d7cec3cc81df518c5609c2484a |
| packages/contracts/src/stage09p-input.ts | 5d5fae06d5c4f6786b1f4c085ecab94f65891d107d9f294a15716148e453e7d4 |
| packages/contracts/src/inventory-v2.ts | ee0e3a11d8b0177a3de9c5c4961f3025d0b9267053b67cfa6268dd0528836fce |
| packages/contracts/src/seasoning-v1.ts | e5b5513348b4e422e511f754030706aafb7bb765f0ad40d2056f7d9e24229c59 |
| packages/contracts/tests/stage09p-contracts.test.ts | a4dab36a48a888ba5164878d1a96f19949177a2dfbe337dd2ab004ae3e8bad11 |
| /private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-design.md | 179b4b7066e6bc82d3d99518abe595c6348bb6f26c23b248bc6df2182351e825 |
| /private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-evidence.md | d9c2b1e41bd87ca9236c5a41c6f29a1350713d304852ba83463152afc996f339 |
| /private/tmp/meal-agent-r7a-r6-fresh-review.gsUbH9/root-audit/report.md | 1ad22c7258159e2ceba4aa398acf16c62422f17e8536717ab30988ca731c0ebe |

未读取Entry Gate任务本体，其DESIGN_ONLY是任务书给定输入；未访问README中的网页/CI链接、上游报告引用的辅助脚本、数据库或真实source。没有虚构这些未取证内容。

## 3. 根Designer实际只读命令

以下保留执行过的shell命令文本；同组命令在一个exec中按换行顺序运行。文件内容写入仅见§4的apply_patch，不在此列为只读。

```sh
git status --porcelain=v1 --untracked-files=all
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
git rev-list --parents -n 1 HEAD
git rev-parse refs/heads/codex/stage-09p-m2-inventory
cat AGENTS.md README.md docs/README.md
wc -l docs/project-status.md docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md docs/architecture/decisions/0007-food-knowledge-governance-and-domain-core.md docs/architecture/decisions/0008-stage09p-m0-evidence-boundary.md packages/contracts/src/stage09p-input.ts packages/contracts/src/inventory-v2.ts packages/contracts/src/seasoning-v1.ts packages/contracts/tests/stage09p-contracts.test.ts /private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-design.md /private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-evidence.md /private/tmp/meal-agent-r7a-r6-fresh-review.gsUbH9/root-audit/report.md
sed -n '1,280p' docs/project-status.md
cat /private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-design.md /private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-evidence.md /private/tmp/meal-agent-r7a-r6-fresh-review.gsUbH9/root-audit/report.md
cat docs/architecture/decisions/0007-food-knowledge-governance-and-domain-core.md docs/architecture/decisions/0008-stage09p-m0-evidence-boundary.md
cat docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md
sed -n '220,475p' docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md
rg -n 'REPLAY|Replay|Checkpoint|Chunk|LIMIT|CAP|Code|code|Reason|reason' packages/contracts/src/stage09p-input.ts
sed -n '1,250p' packages/contracts/src/stage09p-input.ts
sed -n '425,485p' packages/contracts/src/stage09p-input.ts
sed -n '700,742p' packages/contracts/src/stage09p-input.ts
rg -n 'Checkpoint|Replay|replay|Chunk|chunk|Reason|reason' packages/contracts/src/inventory-v2.ts packages/contracts/src/seasoning-v1.ts
sed -n '440,620p' packages/contracts/src/inventory-v2.ts
sed -n '690,762p' packages/contracts/src/inventory-v2.ts
sed -n '980,1041p' docs/project-status.md
sed -n '1,130p' packages/contracts/src/seasoning-v1.ts
sed -n '85,145p' packages/contracts/src/inventory-v2.ts
rg -n '^test\(' packages/contracts/tests/stage09p-contracts.test.ts
sed -n '205,335p' packages/contracts/src/seasoning-v1.ts
sed -n '904,1120p' packages/contracts/tests/stage09p-contracts.test.ts
git --no-optional-locks status --porcelain=v1 --untracked-files=all
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
git rev-list --parents -n 1 HEAD
git rev-parse refs/heads/codex/stage-09p-m2-inventory
stat -f '%Sp %Lp %N' /private/tmp/meal-agent-r7b-shadow-design.9DhyHy
wc -l -c /private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-design.md
shasum -a 256 /private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-design.md
shasum -a 256 AGENTS.md README.md docs/README.md docs/project-status.md docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md docs/architecture/decisions/0007-food-knowledge-governance-and-domain-core.md docs/architecture/decisions/0008-stage09p-m0-evidence-boundary.md packages/contracts/src/stage09p-input.ts packages/contracts/src/inventory-v2.ts packages/contracts/src/seasoning-v1.ts packages/contracts/tests/stage09p-contracts.test.ts /private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-design.md /private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-evidence.md /private/tmp/meal-agent-r7a-r6-fresh-review.gsUbH9/root-audit/report.md
```

两位只读助手 `/root/contract_reading` 和 `/root/authority_material` 的辅助命令族为pwd、git status/rev-parse/rev-list或show/show-ref、wc、rg、sed。其回报使用了省略范围的命令摘要，因此此处不把它们伪造成完整逐字shell日志；完整调用保留在本任务工具记录。它们只阅读上面read-set及相应契约范围，未创建文件、目录或测试进程，已停止。

最终只读封口命令包括下列两文件计数/全文hash、规范化自摘要，以及重复上方POST身份查询。它们仅输出到工具记录，不用重定向创建第三个文件。

```sh
wc -l -c /private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-design.md /private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-evidence.md
shasum -a 256 /private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-design.md /private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-evidence.md
LC_ALL=C sed -E 's/^(SELF_SHA256_NORMALIZED: )[0-9a-f]{64}$/\10000000000000000000000000000000000000000000000000000000000000000/' /private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-evidence.md | shasum -a 256
ls -la /private/tmp/meal-agent-r7b-shadow-design.9DhyHy
```

## 4. 唯一write-set及文件清单

唯一目录创建命令：`mktemp -d /private/tmp/meal-agent-r7b-shadow-design.XXXXXX`。
实际返回：`/private/tmp/meal-agent-r7b-shadow-design.9DhyHy`。
stat实际返回：`drwx------ 700 /private/tmp/meal-agent-r7b-shadow-design.9DhyHy`。
该目录在本任务之前不存在，由mktemp新建；没有chmod、第二次mktemp、旧目录写入或其它输出位置。
只用apply_patch创建/补齐这两个Markdown文件；没有脚本、generator、下载或重定向输出文件。

| 文件absolute path | Byte count | Line count | SHA-256 |
| --- | ---: | ---: | --- |
| /private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-design.md | 50408 | 424 | 24e1f2496df347a0215041835f45d79ba577256d13d1d6f8e7557e2b53d98d3f（最终全文） |
| /private/tmp/meal-agent-r7b-shadow-design.9DhyHy/R7-B-shadow-evidence.md | 见SELF_BYTES | 见SELF_LINES | 见SELF_SHA256_NORMALIZED；最终全文hash在最终交付消息和shasum工具输出中 |

SELF_BYTES: 000000013556
SELF_LINES: 000000000152
SELF_SHA256_NORMALIZED: 12946bd0e133b33002ec0bef1a45485e6ac824158e3d743bf4ed27532576f67c

SELF_BYTES/SELF_LINES为本文件最终实际字节/换行数，采用12位十进制补零定宽记录。设计文件hash为普通全文SHA-256。
本文件自摘要采用明确的规范化规则：只把唯一以`SELF_SHA256_NORMALIZED: `开头、后接64位十六进制hash的记录行之hash替换为64个ASCII零，其余字节（包括最终真实byte/line count）保持不变，然后计算SHA-256。上方sed命令就是该规则；代码块内引用不匹配行首锚点。
该值是本文件的规范化自摘要，不是假称包含自身hash后的全文hash。任意更改其它内容或尺寸都会改变它。
最终原始全文SHA-256在本文件封口后由shasum -a 256计算，记录于只读工具输出和最终交付消息，不写回本文件造成自引用循环。本任务不虚构可以可靠得到自身全文SHA-256固定点的证据。

## 5. 设计覆盖定位与剩余边界

| 必须设计的面 | 设计文件位置 |
| --- | --- |
| checkpoint authentication | §3、§4.1–4.3、§11.2 |
| persisted replay prevention | §5.1–5.4、§7、§8 |
| cross-request gap/order | §5状态机/I05–I08、§7 |
| final-after rejection | §5.1–5.3/I09、§7 |
| atomic persistence | §6、§8/I12 |
| idempotency/locking/transactions | §5.4 invariant ledger、§6、§7 |
| deterministic failure mapping | §9分类/总序/contract gaps |
| resource/timeout allocation | §10及§12未决事项 |

设计包含absent/open/finalized × only/first/continuation/final的12格状态矩阵、严格empty-only、15条invariant ledger及其trusted input/锁前锁后/成功失败side effects、并发矩阵、固定八步逻辑顺序、两类持久化与三类checkpoint认证选择。
不可逆机制均Proposed/未决。缺失R7-B稳定public code只登记gap，没有改contracts。未写任何SQL、migration、table/index/约束/RLS/grant，未创建产品代码或测试。
repo clean和身份对账是实测；设计内容覆盖是Designer交付范围陈述，不是独立Design Review或运行验证。

## 6. 零修改与未执行声明

- repo文件零修改；Git state零修改；外部系统state零修改。唯一有意写入是上面新建0700目录和其两个Markdown文件。
- 未写Git admin、已有/private/tmp evidence、任何.local、data、docs、packages、services、apps、root package、workspace、lockfile、OpenAPI。
- 未reset、checkout、switch、stash、clean、rebase、commit、branch、worktree、PR、push或merge。
- 未运行Node/pnpm、测试、产品行为验证、generator、依赖安装、网络、真实外部服务、DB或Docker。
- 未运行G2、B-r4、Stage09A、compatibility或任何产品gate；未启用source pack、未添加public trust digest、未引入真实食品或用户数据。
- 未变更M1/G2/M2状态；R7-A CLEAN/Accepted不外推到R7-B、R7-C或M2。
- PRE/POST只声称所记录的工作树/commit/tree/parent/ref完全相同，不声称扫描了整个机器或自证工具链。

此交付完成后立即停止，不继续review、implementation、admission或修复。
