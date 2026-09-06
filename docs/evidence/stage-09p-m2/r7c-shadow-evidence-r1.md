# R7-C Shadow Evidence r1

2026-09-06；Stage 09P-M2 / R7-C Shadow Design r1；独立Designer的定向修订证据。仅交付完整、自包含的r1 design/evidence，未执行产品行为。
候选状态：R7-C_SHADOW_DESIGN_R1: READY_FOR_REVIEW。它只表示可送独立复审，不是CLEAN、DESIGN_ACCEPTED、Implemented、Accepted或implementation admission。

## 1. 修订来源、权限与claim ceiling

本轮仅回应review任务01a0755e-aa9c-7740-95d2-a2b97ad4f2b9的P1-1：攻击者可控query未被route policy、command/idempotency identity、C→B handoff、client immutable retry snapshot及未来矩阵共同闭合。review原verdict为R7-C_FRESH_DESIGN_REVIEW: BLOCK，P0=0/P1=1/P2=0，保持不变。
总控已裁定no-query baseline：两个未来replay operation禁止任何syntactic query component，包括裸问号，须在body decode/parse、认证调度和B dispatch前拒绝。query缺席作为身份前置安全不变量，query不进入raw body digest或接受后的semantic identity；其独立target预算、最早可信证明、client binding、B handoff与跨gate证据必须闭合。
此裁定只补逻辑设计，不批准public合同/URL/version取值、具体runtime挂点、数值预算或R7-B实现。保留r0已评审的其他轴，不创建子任务或委派。原r0两份、review报告与仓库均为不可写输入。
固定状态：M1=M1_LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS（不是Accepted）；M1 Fresh Audit A=CLEAN；household-safety 292/292仅LIMITED dynamic evidence，不是Fresh Audit B；B-r1/r2/r3=BLOCK，B-r4未运行；G2=G2_NOT_ADMITTED；source pack=draft/inactive；public trust allowlist empty；M2=In Progress、整体未Accepted；R7-A contracts=Accepted；R7-B=R7-B_SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED；R7-C Entry Gate=DESIGN_ONLY、implementation未准入。本轮不改变任何状态上限。
AGENTS.md等根约定在同一原Designer任务已读；本次更窄write-set继续覆盖更新docs/project-status.md的通用约定，不修改仓库文档。

## 2. PRE/POST Git baseline

仓库：/Users/aipuli/.codex/worktrees/a85e/meal-agent-lab。

| 身份 | PRE实测 | POST实测 | 对账 |
| --- | --- | --- | --- |
| status --porcelain=v1 --untracked-files=all | 空输出 | 空输出 | 无tracked/untracked状态条目 |
| HEAD | 261f0e3307f4fd9b5134e24b01ae6f461a61b727 | 261f0e3307f4fd9b5134e24b01ae6f461a61b727 | 与expected一致 |
| HEAD tree | 714aab8e9c44d4155344ea70cf48d0ee209a6cdc | 714aab8e9c44d4155344ea70cf48d0ee209a6cdc | 与expected一致 |
| unique parent | 4cec2a9499ac71df2ca5f6537aac2aaa262af444 | 4cec2a9499ac71df2ca5f6537aac2aaa262af444 | show %P恰好一个parent |
| refs/heads/codex/stage-09p-m2-inventory | 261f0e3307f4fd9b5134e24b01ae6f461a61b727 | 261f0e3307f4fd9b5134e24b01ae6f461a61b727 | 与expected ref一致 |

PRE在任何新目录/文件写入前完成；Git四项身份、clean、六份persistent hash、r0两份bytes/lines/hash和review bytes/lines/hash全部逐字符合任务书。随后完整阅读review报告，才建立r1新目录。
design定稿后已执行POST首轮：同组身份/status全部不变；git --no-optional-locks diff --exit-code HEAD --为空、exit 0；六份材料、r0与review hash全部不变。两份r1封口后再执行同组POST及输入尺寸对账，最终工具结果与交付消息为最终封口记录。任一不符必须BLOCKED，不修复输入、不继续实施。
R7-A实施落点63d2a0668df3e1291cb3a863327bd5aeed6dd034仅为既定历史状态，不与本轮HEAD/parent混淆。未依赖当前checkout名称替代指定branch ref验证。

## 3. 冻结输入identity

下表的PRE与POST均实测相同；bytes是实际文件字节数，lines是换行数，hash是原始全文SHA-256。

| 输入绝对路径 | Bytes | Lines | PRE SHA-256 = POST SHA-256 = expected |
| --- | ---: | ---: | --- |
| /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md | 62531 | 369 | 51bf086ce3b8df727f96bb45c3e4724dbb6a12ad1e418079d4c56786306d556e |
| /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-evidence.md | 19876 | 198 | e7550b9f3120e59957ec02605244011e0d28ed95dc65843a8bcb117c6c2860b9 |
| /private/tmp/meal-agent-r7c-fresh-review.4zjwuE/R7-C-fresh-review.md | 18349 | 161 | 6cacf04593bced1b878a6145590fbe7be7e0d306e1a04f00cba70195bbb7d9d1 |

六份persistent材料（相对上述仓库）：

| 路径 | PRE SHA-256 = POST SHA-256 = expected |
| --- | --- |
| docs/evidence/stage-09p-m2/r7a-r6-design.md | 179b4b7066e6bc82d3d99518abe595c6348bb6f26c23b248bc6df2182351e825 |
| docs/evidence/stage-09p-m2/r7a-r6-evidence.md | d9c2b1e41bd87ca9236c5a41c6f29a1350713d304852ba83463152afc996f339 |
| docs/evidence/stage-09p-m2/r7a-r6-fresh-review.md | 1ad22c7258159e2ceba4aa398acf16c62422f17e8536717ab30988ca731c0ebe |
| docs/evidence/stage-09p-m2/r7b-shadow-design.md | 24e1f2496df347a0215041835f45d79ba577256d13d1d6f8e7557e2b53d98d3f |
| docs/evidence/stage-09p-m2/r7b-shadow-evidence.md | 93605e6893e53d8472ccde8a6213f258b7769c22b4a0fbb4e6d4ddb624136b68 |
| docs/evidence/stage-09p-m2/r7b-shadow-fresh-review.md | 7e77977e86cf4b03483f04efb1810c37a4357cc46f97eff54689b4a6b65b1b57 |

本轮重读docs/evidence/stage-09p-m2/README.md，确认其仍说明六份文件从结构化FileChange按add及全部update恢复精确副本、hash逐字节一致、claim ceiling未变。没有访问原任务日志或重放恢复，没有读取/写入其他旧临时目录。

## 4. 本轮实际read-set与证据层级

| 本轮实际读取文件 | 方式/范围 | 用途与限制 |
| --- | --- | --- |
| 上表review report | cat完整161行，工具完整返回并逐项阅读 | 唯一P1、其他轴的review边界及最小设计要求；不改写其BLOCK |
| 上表r0 design | cat完整369行进入工具内存，模型重读query相关段；同任务原设计正文已知 | 作为r1完整正文底本；只插入/替换query相关内容，不重设计其他轴 |
| 上表r0 evidence | cat请求全文、核对identity与历史read/test说明；合并展示有截断 | 区分r0实际读取/历史动态证据和本轮范围，不把原read-set冒充r1新阅读 |
| docs/evidence/stage-09p-m2/README.md | cat完整 | 归档provenance和状态上限 |
| 六份persistent材料 | PRE/POST shasum全文读取 | 本轮仅重核hash，语义事实继承原r0阅读与固定任务输入，未重复全部语义审查 |
| apps/client/src/core/api-client.ts | sed 24–103，合并输出后单独补读 | ApiRequestSpec.query、buildQueryString、每次body序列化及URL拼接源码事实；未运行client |
| services/api/src/app.ts | sed 199–224、288–341，合并输出后单独补读 | genReqId/path snapshot、problem.instance和request-target guard接线；不把源码注释当真实框架时序实测 |
| services/api/src/routes.ts | rg -n query/normalizedRoute/resourceTarget | 现有query消费点/route schema定位；只读符号，不扩展为route实现 |
| apps/client/src/core/command-registry.ts、idempotency.ts | 同组rg -n | query/身份相关符号定位；无匹配不证明未来类型/运行期安全 |
| 新r1 design/evidence及其新目录 | cat/rg/wc/shasum/stat/ls与只读规范化摘要 | 交付内容/差异机械核验；不算产品测试或Fresh Review |

没有新增读取其他repo正文、测试fixture、node_modules、DB、运行时库、外部网页或凭据。r1 design§4保留的其余源码事实表来自r0；对应read-set和历史app.inject/fake-platform断言属于r0证据层，不是本轮新运行/新审计。原测试数字、R7-A历史CLEAN、R7-B设计接受均未被外推。
真实Node/Fastify/proxy/Taro的raw target可见性、query归一化、日志时点、exact bytes、timeout/backpressure/abort能力全部未实测；本轮新增的所有query结论是总控逻辑裁定、源码风险事实或未来证据要求，绝非runtime通过记录。

## 5. 实际命令与唯一write-set

PRE、POST及定稿封口使用下列只读命令；重复同组时没有改变参数语义。所有输出仅在工具记录中，无shell重定向输出文件。

```sh
GIT_OPTIONAL_LOCKS=0 git status --porcelain=v1 --untracked-files=all
git rev-parse HEAD HEAD^{tree}
git show -s --format=%P HEAD
git rev-parse refs/heads/codex/stage-09p-m2-inventory
git --no-optional-locks diff --exit-code HEAD --
shasum -a 256 docs/evidence/stage-09p-m2/r7a-r6-design.md docs/evidence/stage-09p-m2/r7a-r6-evidence.md docs/evidence/stage-09p-m2/r7a-r6-fresh-review.md docs/evidence/stage-09p-m2/r7b-shadow-design.md docs/evidence/stage-09p-m2/r7b-shadow-evidence.md docs/evidence/stage-09p-m2/r7b-shadow-fresh-review.md
wc -l -c /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-evidence.md /private/tmp/meal-agent-r7c-fresh-review.4zjwuE/R7-C-fresh-review.md
shasum -a 256 /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-evidence.md /private/tmp/meal-agent-r7c-fresh-review.4zjwuE/R7-C-fresh-review.md
cat /private/tmp/meal-agent-r7c-fresh-review.4zjwuE/R7-C-fresh-review.md
cat /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-design.md
cat /private/tmp/meal-agent-r7c-shadow-design.Aphs0x/R7-C-shadow-evidence.md
sed -n '24,103p' apps/client/src/core/api-client.ts
sed -n '199,224p' services/api/src/app.ts
sed -n '288,341p' services/api/src/app.ts
rg -n 'query|normalizedRoute|resourceTarget' services/api/src/routes.ts apps/client/src/core/command-registry.ts apps/client/src/core/idempotency.ts
cat docs/evidence/stage-09p-m2/README.md
stat -f '%Sp %Lp %N' /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM
cat /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-design-r1.md
wc -l -c /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-design-r1.md
shasum -a 256 /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-design-r1.md
rg -n '^# |^## r0|^\| T4[2-9]|^\| T50|^\| G-|no-query是|正式replay client API|no-query拒绝顺序|request-target/query bytes' /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-design-r1.md
rg -n '^# |^## r0|^\| T4[2-9]|^\| T50|^\| G-' /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-design-r1.md
wc -l -c /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-design-r1.md /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-evidence-r1.md
shasum -a 256 /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-design-r1.md /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-evidence-r1.md
ls -la /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM
```

工具内存中的JavaScript只用于保存完整r0文本、按唯一文本锚点组装r1完整文档并调用apply_patch；没有在仓库运行Node、import产品或创建脚本。对比读取的新r1正文与组装文本相等，原41条T行逐条原样保留；§9 deadline、§10 concurrency、§16 R7-B禁止职责的完整section文本与r0相等。这是文档机械比对，不是产品回归、独立审查或其他轴的重新设计。
封口规范化自摘要通过python3 -c的只读标准库Path.read_bytes/re/hashlib计算；只读两份r1及原r0做尺寸/摘要/文本比较，不import产品、不生成pycache、不创建脚本/fixture/第三文件。完整一次性命令文本保留在工具记录；该步骤不执行产品行为。
唯一目录创建命令为mktemp -d /private/tmp/meal-agent-r7c-shadow-design-r1.XXXXXX，发生在PRE通过且review完整读取之后；返回/private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM。stat实测drwx------ 700。未创建第二目录、未chmod任何目录。
唯一write-set：该新目录中的R7-C-shadow-design-r1.md与R7-C-shadow-evidence-r1.md。仅apply_patch创建/定向补充这两份Markdown，没有cp写旧材料、没有脚本/fixture/manifest/第三报告/代码。封口POST后不再修改文件。

## 6. r0→r1完整定向变更定位

下列行号均为最终r1 design定位；r0位置使用§编号及review引用，不要求Reviewer重建补丁才能阅读r1。r1包含所有原有层次和完整矩阵。

| 定向变化 | r0缺口位置 | r1定位/处置 |
| --- | --- | --- |
| verdict/修订来源与权限 | 首行、§2 | 1、3、10：r1严格首行；唯一P1来源/裁定/差异清单；no-query逻辑已裁定与具体合同/实现未决分开 |
| evidence层级 | §4 | 33：保留r0事实表，明确r1实际复读范围，不把原测试/源码审查冒充本轮 |
| threat与输入顺序 | §5 | 52：raw request-target/query独立预算，可信no-query资格先于collector/decode/parse/auth/B |
| route no-query | §6 | 60：禁止裸?及全部参数/编码形式；不parse query后判空，不允许丢query；无歧义path binding、可信最早入口/转换链，不用caller original-url/boolean；可安全关闭无problem |
| target预算 | §7 | 87：body B不含target/query，早拒绝路径独立header/request-line/native/global账，不能靠现有2,048源码配置冒领pre-materialization能力 |
| lifecycle资格 | §8 | 112：no-query proof与attempt/ticket/operation/policy绑定；missing/stale/mixed proof不进入collector/dispatch；不改变四轴结算 |
| identity与C→B | §11 | 184：query缺席是身份前置条件而非被忽略输入；内部policy/version+absent proof不可混搭；B仅接收符合policy的bundle，future query必须变更identity/version并重新评审 |
| immutable client与unknown | §11 | 184：类型/registry/operation层禁止ApiRequestSpec.query通路，动态/path/baseUrl/adapter守卫；首次/retry/recovery固定binding；query拒绝不清原unknown |
| HTTP候选映射 | §12 | 230：仅候选现有400 VALIDATION_FAILED、实际未匹配route的404 RESOURCE_NOT_FOUND或安全关闭；零decode/parse/auth/B；不新增public码/reason/ordinal |
| gates联合闭合 | §12 | 277、280、281、283–286：更新G-ROUTE/G-ID/G-CLIENT/G-BACKEND及G-LIFE/G-LOG/G-BUDGET的owner和解除证据；288要求同candidate/policy/version跨边界整链，不许局部单独关闭留缝 |
| logging | §13 | 291：raw/decoded/query-derived值不得搬到path/requestId/problem.instance/error/labels；早于guard的proxy/Node/framework日志仍阻断 |
| OpenAPI | §14 | 301：无query声明不证明额外参数拒绝；文档一致但middleware消费/删除query仍是缺guard反例 |
| 完整攻击矩阵 | §15 | 317：原T01–T41原文保留；366–374为T42–T50；共同oracle拒query变体的decode/parse/auth/B=0、unknown保留、输入零泄漏；共50组、执行0 |
| 完整责任矩阵 | §15 | 原矩阵末尾新增no-query owner联动行，其他责任行保留 |
| 独立/未决与admission | §17–18 | 394、402：记录唯一逻辑裁定，policy表示/版本/runtime仍未决；追加query联合证据，不替代原41组或解除其他gate |

新增query组逐项覆盖：T42无query/裸?/普通/空key-value；T43duplicate/reordered/case；T44query百分号、解码/编码等价与非法形式；T45path编码分隔符和component重解释；T46same-key/body只变query与业务分支注入；T47原unknown后query变体retry；T48当前ApiRequestSpec.query/client误接线；T49guard omission/middleware消费query以及内部proof伪造；T50proxy/Node/Fastify归一化、最早日志泄漏与独立target预算。
所有含query变体要求在C dispatch之前拒绝且B调用0；直接对B内部接口注入无效bundle的独立负例不是网络query请求，要求B业务处理/效果0，不混淆两种oracle。无query对照只是能继续原守卫，不是自动success。
原T01–T41、已物化string的B、17/388/10,000、owned bytes、strict UTF-8/identity encoding、stream settlement、deadline/取消、全局公平、跨attemptunknown、日志/OpenAPI边界及R7-B禁止面均保留。没有选择DB schema/SQL/locks/retention/MAC/persisted lookup/staging等机制，没有新增public DTO。

## 7. 输出identity与自摘要规则

目录：/private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM；mode 0700；最终目录仅含这两份文件。

| 输出绝对路径 | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-design-r1.md | 79559 | 409 | 4884b06081d009d84461b263e03bfe5c90e82035e325788fcd5b25bb53ad0627（最终全文） |
| /private/tmp/meal-agent-r7c-shadow-design-r1.IHezIM/R7-C-shadow-evidence-r1.md | 见SELF_BYTES | 见SELF_LINES | 见SELF_SHA256_NORMALIZED；最终原始全文SHA-256记录在封口工具输出及交付消息 |

SELF_BYTES: 000000018891
SELF_LINES: 000000000159
SELF_SHA256_NORMALIZED: 7e98be13e787147f09e4a4c8b34b687d87907c0002d482cfa66004d64a13e2a1

SELF_BYTES/SELF_LINES为最终byte/换行数，用12位十进制定宽记录。规范化摘要仅把唯一SELF_SHA256_NORMALIZED记录行中的64位hash置为64个ASCII零，其余全部字节（包含实际bytes/lines）保持不变，再作SHA-256。该值不是原始全文摘要；不能把包含自身最终全文hash的字节流冒充一个稳定自指固定点。最终原始全文hash只在封口后计算并记录于工具输出和最终消息，不再写回，不创建第三manifest。

## 8. 未执行、零修改与交付结论上限

- 未运行Node/pnpm产品测试、Fastify/socket/Taro实验、typecheck/build、generator、任何checker或gate；T01–T50执行数均为0，没有写成通过。
- 未运行Stage09A、Stage09P、B-r4、G2、DB/SQL/migration/RLS/GRANT、Docker、备份恢复或依赖安装；未联网或外部服务验证。
- 未实施产品route/handler/parser/collector/timeout/limiter/client/contract；未新增ApiErrorCode、replay reason、ordinal、DTO或OpenAPI。
- 未commit/branch/stash/reset/checkout/switch/clean/rebase/worktree/push/PR/merge；未创建子任务或委派，未联系reviewer。
- 未修改原r0两份、review报告、六份持久材料、仓库/Git admin、已有/private/tmp、.local或其他文件；唯一写入是新0700目录内两份r1 Markdown。POST hash/status/ref/diff与PRE相同；不把Git clean外推为扫描整个机器的ignored内容或自证工具链。
- 未激活source pack、未改public trust allowlist、未引入真实食品/用户/家庭数据，未改变M1/G2/M2及R7-B/R7-C状态。
- Node/Fastify/proxy/Taro具体行为仍待真实实测；本候选补的是no-query设计链，缺任何可信原target/guard前日志/身份binding证据则相关gate继续阻断。

唯一P1已在候选层定向回应：选择总控裁定的no-query baseline，并把route、identity、handoff、client、联合gates、HTTP/OpenAPI/logging和完整未来矩阵闭合为同一个条件不变量。是否足以解除独立review的BLOCK只能由后续独立复审判定；本Designer不自行宣布CLEAN或设计接受，也不转入实施。
