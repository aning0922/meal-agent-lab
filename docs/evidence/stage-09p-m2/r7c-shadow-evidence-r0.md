# R7-C Shadow Evidence

2026-09-06；独立 Designer；任务：Stage 09P-M2 / R7-C Request-Stream and Route Integration Shadow Design。
仅交付两份临时Markdown，供独立Fresh Design Review。READY_FOR_REVIEW是材料状态，不是CLEAN、DESIGN_ACCEPTED、Implemented、Accepted或implementation admission。

## PRE / POST 身份与stopline

仓库绝对路径：`/Users/aipuli/.codex/worktrees/a85e/meal-agent-lab`。

| 检查项 | PRE实测 | POST实测 | 结论 |
| --- | --- | --- | --- |
| status --porcelain=v1 --untracked-files=all | 空输出 | 空输出 | 无tracked/untracked状态条目 |
| HEAD | 261f0e3307f4fd9b5134e24b01ae6f461a61b727 | 261f0e3307f4fd9b5134e24b01ae6f461a61b727 | 与expected逐字一致 |
| HEAD tree | 714aab8e9c44d4155344ea70cf48d0ee209a6cdc | 714aab8e9c44d4155344ea70cf48d0ee209a6cdc | 与expected逐字一致 |
| 唯一parent | 4cec2a9499ac71df2ca5f6537aac2aaa262af444 | 4cec2a9499ac71df2ca5f6537aac2aaa262af444 | show的%P恰好一个40-hex parent |
| refs/heads/codex/stage-09p-m2-inventory | 261f0e3307f4fd9b5134e24b01ae6f461a61b727 | 261f0e3307f4fd9b5134e24b01ae6f461a61b727 | 与expected ref逐字一致 |

PRE先于所有目录创建完成，六份持久材料的路径/hash及索引均通过，故没有触发PRE stopline。第一次只读命令组exit 0；后续POST在design完成后执行，同样exit 0；git diff --exit-code HEAD --亦为空。证据自身封口后重复相同POST并在交付消息记录最终全文identity，若不一致则不得交付READY。
HEAD/ref核对不依赖当前是否detached；没有切换分支或创建worktree。R7-A实施落点63d2a0668df3e1291cb3a863327bd5aeed6dd034是既定历史输入，不与本轮HEAD/parent混同。

## 六份persistent material SHA-256

全部为仓库持久路径；PRE与POST对每份重新执行shasum，值均与任务书相同。

| 路径（相对上述仓库） | PRE SHA-256 = POST SHA-256 = expected |
| --- | --- |
| docs/evidence/stage-09p-m2/r7a-r6-design.md | 179b4b7066e6bc82d3d99518abe595c6348bb6f26c23b248bc6df2182351e825 |
| docs/evidence/stage-09p-m2/r7a-r6-evidence.md | d9c2b1e41bd87ca9236c5a41c6f29a1350713d304852ba83463152afc996f339 |
| docs/evidence/stage-09p-m2/r7a-r6-fresh-review.md | 1ad22c7258159e2ceba4aa398acf16c62422f17e8536717ab30988ca731c0ebe |
| docs/evidence/stage-09p-m2/r7b-shadow-design.md | 24e1f2496df347a0215041835f45d79ba577256d13d1d6f8e7557e2b53d98d3f |
| docs/evidence/stage-09p-m2/r7b-shadow-evidence.md | 93605e6893e53d8472ccde8a6213f258b7769c22b4a0fbb4e6d4ddb624136b68 |
| docs/evidence/stage-09p-m2/r7b-shadow-fresh-review.md | 7e77977e86cf4b03483f04efb1810c37a4357cc46f97eff54689b4a6b65b1b57 |

索引docs/evidence/stage-09p-m2/README.md明确说明：六份是从对应任务日志结构化FileChange恢复的精确副本，add完整内容后按序重放全部update；不是聊天摘要、截断终端输出或人工转写。原字节与hash一致，设计/审查claim ceiling不变。此事实来自索引读取及任务指定hash对账；本轮没有访问原日志或历史临时目录重做恢复。

## 当前固定状态

M1 = M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS；不是Accepted。M1 Fresh Audit A = CLEAN；household-safety 292/292仅LIMITED dynamic evidence，不是Fresh Audit B。B-r1/r2/r3 = BLOCK；B-r4未运行。G2 = G2_NOT_ADMITTED；source pack draft/inactive；public trust allowlist empty。M2 In Progress、整体未Accepted。R7-A contracts Accepted；R7-B = R7-B_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED；R7-C Entry Gate任务01a07283-f43f-7831-a87c-c52a5b997f71 = DESIGN_ONLY；R7-C implementation未准入。
Entry Gate任务本体没有打开；其状态来自任务书及当前project-status耐久性收口段。没有借上游CLEAN/Accepted或本轮设计READY扩大状态。

## 实际read-set

以下为实际读取或在限定文件中执行内容检索的范围，不是把允许清单全部冒充已逐行审计。所有路径相对上述仓库；没有读取不必要的直接import，没有访问文档中的外部URL。
部分大cat/rg输出被工具截断，后续针对边界补读；下面明确区分全文请求、范围阅读与符号检索。checksum读取不替代语义阅读；历史测试断言/报告不算本轮动态验证。

| 文件/文件组 | 实际读取方式与重点 |
| --- | --- |
| AGENTS.md、README.md、docs/README.md | cat；docs/README.md另补读100–132；根约定、当前阶段/导航与历史证据边界 |
| docs/project-status.md | cat请求全文（展示截断），标题/状态词rg，1–18补读；当前11/13/15段的M1/M2/R7-A/R7-B/R7-C与恢复事实优先 |
| docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md | cat请求全文（展示截断），标题/相关关键词rg；345–380、416–440、553–581补读，锁序/客户端恢复/里程碑/证据口径 |
| docs/architecture/decisions/0002-backend-runtime-framework-and-persistence.md | cat/标题rg；23–71补读，Node/Fastify、共享contracts与模块职责 |
| docs/architecture/decisions/0003-identity-tenancy-and-api-semantics.md | cat/标题rg；74–181补读，事务内HouseholdContext、HTTP、幂等语义 |
| docs/architecture/decisions/0004-stage-08-pre-release-audit-closeout.md | cat/标题rg；14–100补读，幂等/unknown/client与版本边界 |
| docs/architecture/decisions/0005-local-private-deployment-baseline.md | cat/标题rg；279–299、381–389补读，日志/安全头/有界操作；没有选择DB机制 |
| docs/architecture/decisions/0007-food-knowledge-governance-and-domain-core.md | cat/标题rg；41–76补读，纯domain/contract职责与食品authority |
| docs/architecture/decisions/0008-stage09p-m0-evidence-boundary.md | cat/标题rg；29–64、238–254补读，owner与TCB不能自证 |
| docs/evidence/stage-09p-m2/README.md及上述六份材料 | 索引和R7-A三份cat；R7-B design分1–150、151–310、311–424；B evidence cat；B review cat并补读20–30、30–79；六份PRE/POST全文hash |
| packages/contracts/src/stage09p-input.ts | rg；1–190初读，1–165、420–490、490–745补读，资源/UTF-8复核/canonical raw parser/freeze入口 |
| packages/contracts/src/inventory-v2.ts | replay/parser/reason相关符号rg；85–143、689–731；确认raw parser→Zod→deepFreeze和result authority形状 |
| packages/contracts/src/seasoning-v1.ts | replay/parser/reason相关符号rg；55–107、283–335；确认冻结reason与result/parse边界 |
| packages/contracts/src/api.ts | cat，ApiErrorCode/status、problem、Idempotency-Key与ok/data/meta |
| packages/contracts/src/http.ts | 1–125，legacy HTTP envelope/import边界 |
| packages/contracts/tests/stage09p-contracts.test.ts | test标题rg；904–985、1044–1120补读，string byte上限/多字节/empty/canonical；未运行 |
| services/api/src/app.ts、errors.ts、utils.ts、database/pool.ts | cat，bodyLimit/错误映射/日志入口/安全头、semantic requestHash、transaction wrapper；pool另完整补读 |
| services/api/src/routes.ts | 1–180及idempotency/request.body/safeParse/preHandler/onRequest/replay/bodyLimit rg；只理解既有route接线 |
| services/api/src/database/repository.ts | 上述接线rg；520–585、585–616、640–810；认证会写session、现有hash/replay与边界；没有运行任何SQL |
| services/api/src/database/schema.ts | 仅idempotency相关符号rg与路径/行号；未作schema设计 |
| services/api/src/config.ts、index.ts | timeout/limit/listen/body/stream rg；config 1–55、index cat；没有执行启动 |
| services/api/src/logging.ts、log-events.ts | body/headers/path/requestId/digest/errorCode/errorType/redact/request事件rg；logging 930–972补读；固定日志能力及path风险 |
| services/api/tests/http/routes.test.ts | test/stream/inject/413/415/content-type等rg；416–490补读；旧HTTP边界和日志sentinel断言 |
| services/api/tests/unit/log-events.test.ts、logger-redaction.test.ts、config-logging-wechat.test.ts | 相关test标题rg；包含logger/semantic hash与timeout断言名；不把标题检索当完整测试审计 |
| services/api/scripts/openapi.ts、generate-openapi.ts、check-openapi.ts | cat请求全文，部分展示截断；3.0.3转换/root registry/required routes/committed对账与status声明；未运行 |
| services/api/openapi/stage-08.openapi.json | openapi/paths/replay/Inventory/Seasoning/Idempotency/413/415关键词rg；只读当前committed声明，未生成 |
| apps/client/src/core/api-client.ts、idempotency.ts、command-dispatcher.ts | cat请求全文，部分展示截断；api-client完整显示；dispatcher另133–215补读；serialize/unknown/attempt/CAS边界 |
| apps/client/src/core/command-registry.ts | unknown/pending/body/snapshot/clear/retry/payload rg和1–110；typed legacy registry，没有新增command |
| apps/client/src/platform/ports.ts、taro-adapter.ts | cat完整，serialized body/Promise-only network/15,000ms配置；未调用Taro |
| apps/client/tests/unit/api-client.test.ts、idempotency.test.ts | 相关test/unknown/timeout等rg；api-client150–220；idempotency1–120、260–330；fake平台断言 |
| package.json、services/api/package.json | cat，既有runtime/dependency/scripts，只理解未执行 |
| scripts/stage09a-gate-registry.mjs、run-stage09a-check.mjs | 1–110、1–90，14步registry与runner职责，未运行 |
| scripts/run-stage09p-m0-check.mjs、run-stage09p-m1-check.mjs | 1–100、1–120，各自内嵌registry/runner，只读 |

另外用rg --files在services/api、apps/client/src/core、apps/client/src/platform、apps/client/tests、packages/contracts、scripts中筛选相关文件名。这是文件名inventory，没有读取筛选输出中无关fixture/E2E/gate实现的内容。未读取node_modules、实际运行时库源码、.local、Git admin文件内容、旧/private/tmp、凭据、真实食品/用户数据。对本轮新建两份报告的wc/shasum/stat/ls/rg与规范化hash读取只用于交付机械核验。

## 实际只读命令记录

下面记录PRE/POST精确命令，以及语义阅读命令及范围表。换行表示独立shell命令；没有通过这些命令运行代码。全量工具调用文本保留在本任务记录；重复cat/rg范围合并登记，不声称此处是一份重新执行过的审计脚本。

```sh
git status --porcelain=v1 --untracked-files=all
git rev-parse HEAD HEAD^{tree}
git show -s --format=%P HEAD
git rev-parse refs/heads/codex/stage-09p-m2-inventory
shasum -a 256 docs/evidence/stage-09p-m2/r7a-r6-design.md docs/evidence/stage-09p-m2/r7a-r6-evidence.md docs/evidence/stage-09p-m2/r7a-r6-fresh-review.md docs/evidence/stage-09p-m2/r7b-shadow-design.md docs/evidence/stage-09p-m2/r7b-shadow-evidence.md docs/evidence/stage-09p-m2/r7b-shadow-fresh-review.md
cat docs/evidence/stage-09p-m2/README.md
cat AGENTS.md README.md docs/README.md
cat docs/architecture/decisions/0002* docs/architecture/decisions/0003* docs/architecture/decisions/0004* docs/architecture/decisions/0005* docs/architecture/decisions/0007* docs/architecture/decisions/0008*
cat docs/project-status.md
cat docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md
cat docs/evidence/stage-09p-m2/r7a-r6-design.md docs/evidence/stage-09p-m2/r7a-r6-evidence.md docs/evidence/stage-09p-m2/r7a-r6-fresh-review.md
cat docs/evidence/stage-09p-m2/r7b-shadow-evidence.md
cat docs/evidence/stage-09p-m2/r7b-shadow-fresh-review.md
cat services/api/src/app.ts services/api/src/errors.ts services/api/src/utils.ts services/api/src/database/pool.ts
cat packages/contracts/src/api.ts
cat services/api/src/database/pool.ts
cat apps/client/src/core/api-client.ts apps/client/src/platform/ports.ts apps/client/src/platform/taro-adapter.ts
cat apps/client/src/core/idempotency.ts apps/client/src/core/command-dispatcher.ts
cat services/api/scripts/openapi.ts services/api/scripts/generate-openapi.ts services/api/scripts/check-openapi.ts package.json services/api/package.json
cat services/api/src/index.ts
GIT_OPTIONAL_LOCKS=0 git status --porcelain=v1 --untracked-files=all
git --no-optional-locks diff --exit-code HEAD --
stat -f '%Sp %Lp %N' /private/tmp/meal-agent-r7c-shadow-design.Aphs0x
wc -l -c /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md
shasum -a 256 /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md
rg -n '^# |^\| T[0-9]+ |^\| G-' /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md
```

范围读取实际使用sed -n '起行,末行p' 路径，所有范围/路径已逐项登记在read-set表；未使用sed写回文件。初始wc -l覆盖根README、docs/README、project-status、09P计划及上述六个ADR，只为分段读取。rg -n的实际表达式族如下，与read-set表指定文件对应：

```text
^#{1,4} |R7-|M1_LIMITED|G2_NOT|292/292|B-r[1-4]|draft|allowlist
idempoten|request.body|safeParse|preHandler|onRequest|replay|bodyLimit
unknown|pending|body|snapshot|clear|retry|payload
decode|raw|utf8|UTF|parse.*Replay|Reason|reason|reject|deepFreeze
body|headers|path|requestId|digest|errorCode|errorType|redact|request.failed|request.rejected
timeout|Timeout|limit|Limit|listen|body|stream
"openapi"|"paths"|replay|inventory.v2|seasoning.v1|Idempotency|idempotency-key|413|415
^test\(|bodyLimit|413|415|UTF|utf|stream|inject|malformed|content-type
^test\(|unknown|timeout|mutat|serializ
^test\(|it\(
```

文件名查找实际命令：

```sh
rg --files services/api apps/client/src/core apps/client/src/platform apps/client/tests packages/contracts scripts | rg '(test|stage09[aApP]|gate|openapi|package.json|logging|log-events|routes.ts|errors.ts|app.ts|config.ts|pool.ts|repository.ts|schema.ts|utils.ts|api-client|idempotency|command-dispatcher|command-registry|ports.ts|taro-adapter)'
```

封口使用以下只读命令，并重复前述Git身份与六份hash查询；所有输出仅写入工具记录，不重定向为第三个文件：

```sh
wc -l -c /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-evidence.md
shasum -a 256 /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-evidence.md
ls -la /private/tmp/meal-agent-r7c-shadow-design.Aphs0x
```

规范化自摘要以python3 -c的一次性只读标准库命令计算：Path.read_bytes读取本文件，hashlib.sha256计算全文和规范化字节摘要；re.sub只将唯一SELF_SHA256_NORMALIZED记录行中的64位值置为64个ASCII零。Python不import产品、不执行Node、不创建脚本/pycache/其他文件、不运行测试。此机械摘要读取不构成产品行为验证。

## 唯一write-set与交付identity

在PRE通过后执行的唯一目录创建命令：`mktemp -d /private/tmp/meal-agent-r7c-shadow-design.XXXXXX`。
返回：`/private/tmp/meal-agent-r7c-shadow-design.Aphs0x`。stat实测：`drwx------ 700 /private/tmp/meal-agent-r7c-shadow-design.Aphs0x`。
没有第二个mktemp、chmod、脚本、fixture、测试副本、node_modules、第三份报告或任何既有目录写入。内容创建/补充仅通过apply_patch，且仅限这两个新文件。

| 文件绝对路径 | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md | 62531 | 369 | 51bf086ce3b8df727f96bb45c3e4724dbb6a12ad1e418079d4c56786306d556e（最终全文） |
| /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-evidence.md | 见SELF_BYTES | 见SELF_LINES | 见SELF_SHA256_NORMALIZED；最终原始全文摘要见封口工具输出及最终交付消息 |

SELF_BYTES: 000000019876
SELF_LINES: 000000000198
SELF_SHA256_NORMALIZED: f44eb67a4ef3e40ad9bcf6a3fc80827ae87a45692bc9abbb1da20305964e0856

SELF_BYTES/SELF_LINES是最终文件实际byte/换行数，用12位十进制定宽记录。规范化摘要只置零唯一以SELF_SHA256_NORMALIZED开头的记录行之64位值，其余字节（含实际bytes/lines）保持原样。它不是原始全文hash；包含自身最终全文hash的字节流会改变自身摘要，不能虚构自指固定点。与R7-B evidence相同，本文件最终原始全文SHA-256仅在封口后输出于工具记录与交付消息，不再写回，不创建第三个manifest文件。

## 覆盖定位与未决项

| 交付要求 | design位置 |
| --- | --- |
| scope/baseline/历史证据与未实测能力 | 首行及§2–5 |
| route/media/charset/Content-Encoding/BOM/framing | §6、T05–T14、T35 |
| pre-string实际UTF-8 bytes、B−1/B/B+1、overshoot、内存 | §7、T01–T04、T10、T27–T28 |
| stream一次settlement、close-after-end、abort/duplicate callbacks | §8、T17–T21、T26 |
| parser/event-loop/transport/B/client deadline与cancellation | §9、T19–T22、T32–T34 |
| global/principal/household/session admission、公平/背压 | §10、T23–T28 |
| immutable raw identity、key、R7-B handoff、client serializedbody/unknown | §11、T29–T36、T39–T41 |
| 既有problem与replay reason映射、public contract gaps | §12；10项G-*全部保留未决 |
| 全终态logging sentinel、path/requestId旁路 | §13、T37 |
| OpenAPI能表达/不能表达、声明有而runtime guard无 | §14、T38 |
| 完整未来攻击矩阵、完整责任矩阵 | §15，共T01–T41；测试执行数0 |
| R7-B禁止吸收、独立不变量与Proposed/未决、admission/residual | §16–18 |

覆盖计数是Designer材料索引，不是独立Fresh Review结论。设计不选择R7-B任何未决机制、不增加public reason/ordinal/DTO、不要求先修R7-A。现有合同的缺口可通过条件handoff描述为“能力未闭合则不dispatch/route不准入”，不存在需要强塞旧reason才能继续描述的安全状态。
特别保留：R7-A上限仅string复核；Fastify bodyLimit不替代collector；invalidUTF-8禁止替换；非identity禁止解压；10,000非空小chunks；同步parser timer不可抢占；clientabort可无response；commitunknown不可确定失败；retry单次零效果不能解除原命令unknown；日志既有path/自带requestId不自动保证零泄漏。

## 未执行及零修改声明

- 未运行任何Node/pnpm产品测试、Fastify实验、真实socket实验、Taro实验、typecheck/build或依赖安装。
- 未运行OpenAPI generator/checker、Stage09A、Stage09P、B-r4、G2或任何产品gate。
- 未联网、未浏览外部文档、未访问真实账号/服务、未发送消息给其他人或任务。
- 未运行DB、SQL、migration、Docker、RLS/GRANT/备份恢复操作。
- 未实施或修复route、handler、parser、collector、timeout controller、limiter、client、contract；未写任何产品代码/测试/脚本/fixture。
- 未激活source pack、未改public trust allowlist、未引入真实食品/用户/家庭数据。
- 未reset、checkout、switch、stash、clean、rebase、commit、branch、worktree、push、PR、merge；未创建子任务或委派。
- 仓库/Git/已有evidence零主动修改；唯一有意写入为新0700目录与其两个Markdown。POST的HEAD/tree/parent/ref、status、diff和六份hash均与PRE相符；未写Git admin、.local或已有/private/tmp。
- 不把以上观察外推为扫描全机器所有ignored文件或证明工具链无副作用；零修改声明的直接可核查依据是写入调用范围、Git状态对账与受控持久材料hash。
- 当前行为观察来自源码、现有app.inject/fake-platform测试断言和持久历史报告。Fastify/Node/Taro的stream、timeout、backpressure、header normalization具体能力均未实测；对应真实socket/adapter证据计划见design§15/18。

交付终点为这两份shadow文件；后续独立Fresh Design Review须另行授权。本任务不自行改变任何claim ceiling或admission状态。
