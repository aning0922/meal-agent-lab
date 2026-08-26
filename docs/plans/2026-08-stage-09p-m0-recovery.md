# Stage 09P-M0 Recovery：Evidence Boundary 实施计划

- 状态：Proposed / recovery design candidate；未实施、未 Accepted
- 设计修订：Revision 1（关闭 Design Review A 的四项 P1）
- 日期：2026-08-26
- 恢复基线：`2c2ccd9015268fe44db4bb5446f3340e551914be`
- 设计分支：`codex/stage-09p-m0-recovery`
- 关联决策：[ADR-0008：Stage 09P-M0 产品证据边界](../architecture/decisions/0008-stage09p-m0-evidence-boundary.md)
- 上位规划：[阶段 09P：安全知识治理与确定性产品核心闭环](2026-08-stage-09p-safe-deterministic-product-core.md)

本计划只设计 M0 恢复实施，不创建 `packages/domain`、schema、fixtures、scripts/tests、
依赖或产品实现。旧候选 `5f7caa437de379dbb2db5706549198b052f210cf` 及其 23 个提交
仅为只读研究证据；不得 reset、rebase、cherry-pick 或覆盖本恢复分支。M1 未开始。

## 1. 目标与非目标

目标是以短而可执行的产品证据边界实现 ADR-0007 已决定的 M0：五类完全合成治理数据、
strict decode、标准 schema 能力、deterministic digest、release/catalog/lifecycle/source
identity、fail-closed resolver，以及纯 domain 七模块边界。

以下底线不变：食品安全；过敏/宗教伦理 hard constraint；unknown mapping fail closed；
来源、许可、地区、语言、版本、审核和撤回；完全合成数据；固定七模块；不让 DTO、模型、
自由文本或 schema 单独承担领域安全决策。

非目标：真实食品/allergen/宗教伦理/食品安全/technique 数据，M1 hard filter，Recipe、
Recommendation、Meal、Shopping、inventory、migration、contracts/API/client、云、公网、
真实微信、Agent 或外部能力。Node loader/preload、TypeScript/compiler、worker、runner 和
supply-chain 保留为 TCB，不由 M0 checker 自证。

## 2. 允许资产与明确禁复用

旧候选只能按当前基线重新设计、手工重写或选择性移植以下产品资产：

- `types/decode/canonical/validation/catalog/resolution/index` 七模块划分；
- 普通 domain unit tests 中仍成立的输入/输出关系；
- 两份 schema 的标准 JSON Schema 部分；
- 5 个 valid、10 个 invalid 的完全合成 fixture 主题；
- 终态复核中的真实反例，尤其 whole-object、source pairing/双向 identity、entity history、
  lifecycle/supersession、generic `invalid_catalog`、budget wrapper 和 `-0` owner。

明确禁止复用或改名搬运：`scripts/check-stage09p-m0-scope.mjs` 的 3129 行 checker、
`scripts/tests/stage09p-m0-scope.test.mjs` 的 2013 行 mutation suite、223 项 guard registry、
compiler callback/source mutation、loader/preload/worker self-certification、逐 predicate
deletion meta-proof，以及把多个 API 归一化成 projection/tag 的 oracle。

任何移植必须在 diff review 中能追溯为“产品行为仍适用”，不能以旧候选曾全绿作为证据。

## 3. 产品不变量到证据的执行规则

1. 每条产品不变量按 ADR-0008 映射到唯一 owning layer；layered defense 可以重复拒绝。
2. public 证据直接调用公开 API，比较完整 structured value、exact own keys 和冻结状态。
3. validation 对 compound invalid input 返回按 `code → path` UTF-8 字节序排序的多个 issue；
   普通测试断言完整数组，不强迫 issue singleton。
4. catalog graph 的 source pairing、`SourceKey`/`ForwardSourceMaterial`/
   `ReverseSnapshotMaterial`、entity history、ADR literal lifecycle 表与 supersession 分别写
   普通 regression；既有正向可满足历史，也有组合反例。
5. standard schema 只证明标准能力；`-0` 唯一交给 `decode.ts` recursive scalar closure，
   同时覆盖 raw JSON 解析结果与 intentional object input。
6. property tests 使用固定 seed，并在失败时打印最小安全 case ID；不打印 raw fixture。
7. scope gate 只做 surface 检查和命令聚合，不维护 guard registry，不修改 compiler 回调。

## 4. 三个小增量

每个增量独立 review、独立提交、前一增量通过后才进入下一增量。任何停止条件命中时保留
失败证据并停止，不扩大范围补洞。

### M0-R1：strict decode / schema / digest

**输入**

- 精确基线、本 ADR/计划；五类 synthetic envelope 最小字段；标准 JSON Schema 2020-12；
- raw JSON、scalar closure、资源边界、canonical projection 与 digest 反例。

**输出**

- 七模块中的 `types.ts`、`decode.ts`、`canonical.ts`、最小 `index.ts`；
- governance release/catalog schema；5 valid + 与 R1 有关的 invalid synthetic fixtures；
- ordinary decode/schema/digest unit/property/regression；domain package build/check/test。

**关键反例**

- duplicate key、trailing input、raw/lone surrogate、non-finite/unsafe integer、raw `-0`、
  object `-0`、accessor/sparse/cycle/depth/budget、unknown own key、canonical reorder、digest
  field mutation。

**允许文件**

```text
packages/domain/{package.json,tsconfig.json,tsconfig.build.json,README.md}
packages/domain/src/{types.ts,decode.ts,canonical.ts,index.ts}
packages/domain/tests/{decode.test.ts,canonical.test.ts}
data/schemas/{governance-release.schema.json,governance-catalog.schema.json}
data/samples/stage09p-m0/**
```

**停止条件**

- schema/custom keyword、独立 raw `-0` scanner 或第二 runtime validator 与 `decode.ts`
  scalar closure 争夺 `-0` authority；
- canonical bytes 依赖 object insertion order、locale、clock 或 entropy；
- 任一 invalid fixture 含真实食品事实/用户数据；
- 为使测试通过需要 loader/compiler mutation、custom keyword 自证或新增依赖。

### M0-R2：catalog / lifecycle / resolver

**输入**

- 已 review 的 R1 types/decoded values/digest；ADR-0008 exact projections、三个 source
  material、literal 6×6 lifecycle oracle 与 resolver signatures；source graph、三条合法
  history、supersession 和 unknown mapping 反例。

**输出**

- `validation.ts`、`catalog.ts`、`resolution.ts` 与相应 `types.ts/index.ts` 扩展；
- 全部 10 个 invalid synthetic fixtures；逐格 lifecycle 与普通 catalog/resolver tests；
- exact union、whole-object + exact own-key/frozen assertions、安全失败零 raw input。

**关键反例**

- reference/snapshot mismatch；同 SourceKey 的 locator/snapshotId/digest/retrievedAt 单字段
  forward 漂移；不同 SourceKey 复用 snapshotId；same-release duplicate entity、release
  revision gap、same entity revision equivocation；ADR 36 格与三条合法 history；missing/
  historical/unusable/cross-dataset/self/cycle supersession；reference/hard forged context；
  query mapping 0/2 条、unrelated/compound issue、unknown/withdrawn/unapproved mapping。

**允许文件**

```text
packages/domain/src/{types.ts,validation.ts,catalog.ts,resolution.ts,index.ts}
packages/domain/tests/{catalog.test.ts,lifecycle.test.ts,resolution.test.ts,fixtures.test.ts}
data/samples/stage09p-m0/**
```

**停止条件**

- 除 ADR 三个固定 public signatures 为 strict decode 明确声明的 intentional `unknown`
  boundary 外，resolver 新增 compatibility overload、旁路、第二 authority、raw catalog
  或 exception text；
- entity history projection 未精确排除 release-scoped metadata；
- source material/code/path 偏离 ADR exact 定义，或合法 lifecycle/supersession 历史无法构造；
- compound invalid input 的排序不确定，或只能靠有损 tag/projection 测试；
- 需要放宽食品安全、hard constraint、unknown、provenance/license/region/language/version/
  withdrawal 任一边界。

### M0-R3：simple scope gate / docs

**输入**

- 已 review 的 R1/R2 package 和 tests；允许路径、七模块、依赖/禁止 import、synthetic-only
  清单；既有 root workspace 与 09A gate。

**输出**

- 一个短小、只读、fail-closed 的 M0 scope/gate script 及普通 script tests；
- workspace/package scripts 与必要 lockfile 变化；package/data/docs/status 同步；
- `pnpm stage09p:m0:check` 只串联 domain build/check/tests、schema/fixtures 和 scope checks。

**允许文件**

```text
scripts/{check-stage09p-m0-scope.mjs,run-stage09p-m0-check.mjs}
scripts/tests/{stage09p-m0-scope.test.mjs,stage09p-m0-check.test.mjs}
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
packages/README.md
data/README.md
docs/{README.md,project-status.md}
docs/architecture/decisions/{0008-stage09p-m0-evidence-boundary.md,README.md}
docs/plans/{2026-08-stage-09p-m0-recovery.md,README.md}
```

**停止条件**

- checker 接近产品实现规模或需要 guard/material/mutant registry；
- gate 解析 compiler callback、注入 preload/loader/worker 或按 test event 数自证；
- root 依赖变化不是七模块实现所必需；
- 需要修改 contracts、services、apps、migration、OpenAPI、09A 冻结面或 M1 内容。

## 5. 普通 inert 反例矩阵

下表是合同内产品反例，不是 mutation registry。每行是普通 unit/property/regression；
compound case 允许多个确定性 issue。

| 组 | ID | inert 变换 | 直接预期 |
| --- | --- | --- | --- |
| Decode/schema | D01 | raw JSON 重复 own key | decode 固定失败 |
| Decode/schema | D02 | 合法值后 trailing token | decode 固定失败 |
| Decode/schema | D03 | escaped lone surrogate | scalar closure 失败 |
| Decode/schema | D04a | raw JSON 中的 `-0` | `decode.ts` scalar closure 在 parse 后拒绝 |
| Decode/schema | D04b | intentional object input 中的 `-0` | 同一 owner 以 `Object.is(value,-0)` 拒绝 |
| Decode/schema | D05 | unsafe integer | decode 固定失败 |
| Decode/schema | D06 | sparse/accessor/cycle object 入口 | 不执行 getter；固定失败 |
| Decode/schema | D07 | B/B+1 depth 或 input budget | B 接受、B+1 固定失败 |
| Digest | G01 | object key insertion order 变化 | canonical bytes/digest 相同 |
| Digest | G02 | release field 单值变化 | digest 改变 |
| Digest | G03 | fixture 声称的 digest 不匹配 | `RELEASE_DIGEST_MISMATCH` |
| Provenance | P01 | source 缺失 | `MISSING_SOURCE` |
| Provenance | P02 | license 缺失/pending | `MISSING_LICENSE` |
| Provenance | P03 | region 或 language 缺失 | 对应两个稳定 issue |
| Source identity | S01 | reference rev1 配 snapshot rev2 | `SOURCE_SNAPSHOT_MISMATCH` + ADR pairing pointer |
| Source identity | S02a | 同 SourceKey 仅改 locator | `SOURCE_REFERENCE_EQUIVOCATION` + 后出现 reference pointer |
| Source identity | S02b | 同 SourceKey 仅改 snapshotId | `SOURCE_REFERENCE_EQUIVOCATION` + 后出现 reference pointer |
| Source identity | S02c | 同 SourceKey 仅改 snapshot digest | `SOURCE_REFERENCE_EQUIVOCATION` + 后出现 reference pointer |
| Source identity | S02d | 同 SourceKey 仅改 retrievedAt | `SOURCE_REFERENCE_EQUIVOCATION` + 后出现 reference pointer |
| Source identity | S03 | 不同 SourceKey 复用 snapshotId | `SOURCE_SNAPSHOT_ID_EQUIVOCATION` + 后出现 snapshot pointer |
| Entity history | E01 | same release 重复 entityId | duplicate entity issue |
| Entity history | E02 | same revision 改 entity-local content | entity equivocation |
| Entity history | E03 | same entity material 仅换 release metadata | 合法，history bytes 相同 |
| Lifecycle | L00 | 相邻、严格递增 revision 的全部 36 格 | 逐格等于 ADR literal A/R 表 |
| Lifecycle | L01 | `draft → under_review → approved → active` | whole-release 历史合法 |
| Lifecycle | L02 | `active → superseded` 指向同 dataset/kind latest active target | whole-release 历史合法 |
| Lifecycle | L03 | `active → withdrawn → active` 且 entity/release revision 提升 | 新 evidence 恢复合法 |
| Supersession | U01 | target 不存在或是历史 revision | unknown/version issues |
| Supersession | U02 | target 为 draft 或 self/cycle | unusable，cycle 按 path 排序 |
| Supersession | U03 | same-kind cross-dataset target | dataset mismatch |
| Resolver | R01 | valid mapping + exact context | exact frozen `mapped` whole object |
| Resolver | R02a | reference forged/missing context | frozen `{status:'unmapped',reason:'invalid_activation_context'}`；own keys=`reason,status`，零 raw |
| Resolver | R02b | hard forged/missing context | frozen `{status:'unmapped',reason:'invalid_activation_context'}`；own keys=`reason,status`，零 raw |
| Resolver | R03 | mappingId 为 0 条或 2 条 | exact `invalid_catalog` |
| Resolver | R04 | endpoint issue + unrelated issue | exact `invalid_catalog`，不挑 issue |
| Resolver | R05 | unknown/withdrawn/unapproved target | 对应封闭 reason，不泄露 envelope |
| Synthetic | Y01 | valid fixture 深层嵌入 external fact 标记 | synthetic proof 固定失败 |
| Hard constraint | H01 | required hard mapping unresolved | fail closed，不产生 mapped |
| Layering | C01 | pairing + forward + reverse 同时失效 | 完整多 issue 数组与稳定排序 |

实施时可以添加发现的真实产品反例，但不得把 case 数、guard 数或 mutation 数当作完备性
证明，也不得建立超过产品代码规模的验收合同。

## 6. 提交、验证与独立审计

### 6.1 提交状态机

- 从总控重新签发的 Accepted 精确基线创建独立 worktree；初始提交按 R1、R2、R3 三个
  append-only 内聚提交。
- 候选冻结后只允许最多一次 bounded remediation：一个追加提交，只修独立审查已确认的
  M0 根因，不加能力、不扩 allowed files。
- 同一根因重复、修复需要第二次 remediation、命中任一停止条件或范围越界时立即停止并
  报告 BLOCK；不得 amend/rebase/reset/cherry-pick 旧候选规避历史。

### 6.2 同一精确 SHA 的最终命令

固定 PATH 首项为 `/Users/aipuli/.nvm/versions/node/v24.18.0/bin`，先确认：

```text
node --version                                      # v24.18.0
command -v node                                    # 固定绝对路径
pnpm --filter @meal-agent/domain check
pnpm --filter @meal-agent/domain build
pnpm --filter @meal-agent/domain test
pnpm stage09p:m0:check
pnpm check                                          # workspace/范围要求时必须
pnpm docs:links:check
pnpm stage09a:check                                 # 完整 14/14
git diff --check
git status --short
```

最终候选必须是同一完整 40 位 SHA、clean worktree；无 skip/todo、无测试临时文件、无
Docker/Compose/project/volume/container/image/scoped process 残留。命令失败不得用旧 SHA、
旧 09A run 或局部重跑冒充完整证据。

### 6.3 审计与接受边界

冻结后创建两个全新、独立、只读审计，针对同一精确 SHA：

- Audit A：静态检查产品 ownership、七模块/import/export、schema 能力分层、source/entity
  projection、resolver signatures/result unions、synthetic-only、allowed/frozen diff 与 TCB。
- Audit B：仅纯 domain 动态执行 build/tests/M0 gate，重放本计划反例，核对 whole-object、
  issue 排序、digest determinism 和零 raw 输出；不做 Docker、网络、外部数据或 M1。

任一 `BLOCK` 或 SHA 变化使两份结论失效。一次 bounded remediation 后必须对新 SHA
重新执行 A/B；相同根因再次出现则停止，不再补第四层 checker。只有总控可决定 ADR/M0/
09P 状态；实施者与审计者不得写 Accepted / Pass。

## 7. 本设计批次的完成边界

本批次只交付 ADR-0008 与本 Recovery 计划及必要索引。没有创建/修改 `packages/domain`、
scripts/tests、schema、fixtures、依赖或产品实现；没有运行实施门禁；没有创建 Design
Review 或 Audit；没有实施、没有 Accepted，M1 未开始。下一步仅是等待总控独立设计复核。
