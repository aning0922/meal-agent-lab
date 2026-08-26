# ADR-0008：Stage 09P-M0 产品证据边界

- 状态：Accepted
- Accepted 日期：2026-08-27
- 验收落点：`186bd2f43695e1136a3a1fc43faa6d6088d9ce54`
- 实施证据：Cycle 2 独立 Audit A/B 双 CLEAN；总控验收门禁通过
- 设计修订：Revision 2（最后一次 bounded revision）
- 日期：2026-08-26
- 负责人：产品负责人、领域架构、食品安全与数据治理
- 基线：`2c2ccd9015268fe44db4bb5446f3340e551914be`
- 上位决策：[ADR-0007：食品知识治理与确定性领域核心](0007-food-knowledge-governance-and-domain-core.md)
- 实施记录：[Stage 09P-M0 Recovery 实施计划](../../plans/2026-08-stage-09p-m0-recovery.md)

本 ADR 与 M0 已由总控在完整 acceptance candidate
`186bd2f43695e1136a3a1fc43faa6d6088d9ce54` 上 Accepted。该状态不代表 09P 完成：
09P 仍为 In Progress，本次 M0 收口时 M1 尚未开始。

## 背景

旧候选 `5f7caa437de379dbb2db5706549198b052f210cf` 试图用一份大型 checker、mutation
suite 和 guard registry 证明 M0 checker 自身完备。终态复核确认：whole-object 结果被
投影或 tag 有损归一化、source identity 的单谓词删除材料会触发另一层防御、entity
history 混入 release metadata，且多个 production predicate 没有独立 owner。继续增加
guard 或要求“删除一个 predicate 后整条 pipeline 必须变绿”不能证明产品行为。

恢复设计需要保留 ADR-0007 的食品安全与治理强度，同时缩短证据链，明确产品不变量、
直接行为证据和运行工具链信任边界。

## 决定

### 1. M0 只证明产品与数据不变量

M0 不削弱以下边界：食品安全；过敏、用户声明为 hard 的宗教/伦理规则和明确不可食用项；
unknown mapping fail closed；来源、许可、地区、语言、版本、审核和撤回；完全合成数据；
deterministic digest；纯 `packages/domain`；固定七个 production module：
`types.ts`、`decode.ts`、`canonical.ts`、`validation.ts`、`catalog.ts`、
`resolution.ts`、`index.ts`。

M0 不证明 Node loader/preload、`node:test`、TypeScript/compiler、Ajv、worker protocol、
runner、pnpm 或依赖字节自身正确。它们属于由精确 lockfile、已接受的 09A/CI、Git review、
固定 Node 和独立审计共同构成的 trusted computing base（TCB）。M0 checker 只聚合普通
命令并传播失败，不声称自证 checker、compiler 或 runner。

### 2. 每条产品不变量只有一个 owning layer

| 产品不变量 | 唯一 owning layer | 直接行为证据 | 稳定安全输出 | 剩余 TCB |
| --- | --- | --- | --- | --- |
| raw JSON 无歧义、资源有界、`-0` 拒绝 | `decode.ts` recursive scalar-closure decoder | raw/object unit/property 边界测试 | `decode_failed` + 固定 code/path | Node 字符串、loader |
| schema 可表达的 shape/scalar closure | 标准 JSON Schema + Ajv | valid/invalid schema regression | 标准 validation errors 仅作内部证据 | Ajv/compiler/lockfile |
| canonical bytes 与 digest 确定 | canonicalizer | 重排/重复运行/字段变换关系测试 | digest 或固定 `digest_mismatch` | UTF-8/SHA 实现、runtime |
| release/entity/source identity | catalog validator | 普通 graph regression | 排序后的 `ValidationIssue[]` | TypeScript/runtime |
| lifecycle 与 supersession 可满足 | catalog validator | 36 格 table test + graph cases | 排序后的固定 code/path | TypeScript/runtime |
| resolver fail closed 且不泄露 | resolver | public API whole-object tests | 精确 result union，无原始输入 | TypeScript/runtime |
| unknown/hard mapping 不放行 | resolver | mapping regression | `unmapped` + 固定 reason | 上游 synthetic catalog |
| fixture 完全合成 | fixture validator | 递归 fixture regression + Git review | 固定 synthetic issue | 仓库与 reviewer |

layered defense 允许同一 compound invalid input 产生多个 issue；issue 必须按
`code → path` 的 UTF-8 字节序稳定排序。测试可以隔离单一不变量，但不要求删除单一
predicate 后绕过其他防御，更不以整条 pipeline 变绿作为 meta-proof。

`ValidationIssue` 的 exact sorted own keys 是 `code,path`；`path` 必须是 RFC 6901
JSON Pointer string，issue 与数组均冻结。同一输出禁止重复的 `(code,path)` pair，排序
唯一为 UTF-8 `code`、再 UTF-8 `path`，因此没有第三排序键。

### 3. Resolver 固定公开签名与完整结果

M0-R2 冻结以下 public value signatures；不得增加 overload、可选参数、callback 或第二种
查询 authority。public boundary 接受 `unknown` 是为了执行 strict decode，不是兼容旁路；
只有 `mappingId` 能查询 hard mapping：

```ts
decodeActivationContext(input: unknown): ContextDecodeResult

resolveGovernedReference(
  catalog: unknown,
  reference: unknown,
  context: DecodedActivationContext,
): ReferenceResolution

resolveHardMapping(
  catalog: unknown,
  mappingId: unknown,
  context: DecodedActivationContext,
): HardMappingResolution
```

context 的输入 own keys 精确为 `region/language/asOf`；成功值是 module-private identity
登记过的深冻结对象。context result 只允许
`{ok:true,value:DecodedActivationContext}` 或
`{ok:false,code:'INVALID_ACTIVATION_CONTEXT'}`。两个 resolver result 是以下封闭 union：

```ts
type ReferenceResolution =
  | { status: 'mapped'; reason: 'mapped'; envelope: GovernanceEnvelope }
  | { status: 'unmapped'; reason: 'invalid_activation_context' | 'invalid_reference'
      | 'invalid_catalog' | 'unknown_identity' }
  | { status: 'withdrawn'; reason: 'current_revision_withdrawn' }
  | { status: 'version_mismatch'; reason: 'unknown_revision' | 'not_latest_revision' }
  | { status: 'unapproved'; reason: 'lifecycle_not_active' | 'region_not_applicable'
      | 'language_not_applicable' | 'review_not_effective' | 'review_expired' }

type HardMappingResolution =
  | { status: 'mapped'; reason: 'mapped'; mappingId: string;
      source: GovernanceEnvelope; target: GovernanceEnvelope }
  | { status: 'unmapped'; reason: 'invalid_activation_context' | 'invalid_mapping_id'
      | 'invalid_catalog' | 'hard_mapping_unknown' | 'hard_mapping_source_unmapped'
      | 'hard_mapping_target_unmapped' }
  | { status: 'withdrawn'; reason: 'hard_mapping_source_withdrawn'
      | 'hard_mapping_target_withdrawn' }
  | { status: 'version_mismatch'; reason: 'hard_mapping_source_version_mismatch'
      | 'hard_mapping_target_version_mismatch' }
  | { status: 'unapproved'; reason: 'hard_mapping_source_lifecycle_not_active'
      | 'hard_mapping_target_lifecycle_not_active' | HardMappingContextFailureReason }

type HardMappingContextFailureReason =
  | 'hard_mapping_source_region_not_applicable'
  | 'hard_mapping_source_language_not_applicable'
  | 'hard_mapping_source_review_not_effective'
  | 'hard_mapping_source_review_expired'
  | 'hard_mapping_target_region_not_applicable'
  | 'hard_mapping_target_language_not_applicable'
  | 'hard_mapping_target_review_not_effective'
  | 'hard_mapping_target_review_expired'
```

上述八个 context literal 是完整集合；两个 lifecycle literal 与它们共同构成 hard
endpoint 的 unapproved vocabulary。reference mapped 的 exact
sorted own keys 为 `envelope,reason,status`，hard mapped 为
`mappingId,reason,source,status,target`，所有 failure 均为 `reason,status`。每个分支固定
字段类型、冻结状态和 precedence；whole-object 直接 `deepStrictEqual`，不得用
projection/tag 代替。
public failure 只返回固定 status/reason；不得返回 catalog、context、
reference、mapping、mappingId、raw input、异常 message 或其片段。missing/forged context
对两个 resolver 都唯一返回冻结的
`{status:'unmapped',reason:'invalid_activation_context'}`。同 mappingId 多于一条、
structural/global validation issue 或任何 query-unrelated validation issue 统一安全降级为
`invalid_catalog`，不能挑一个看似相关的细分 reason；region/language/review 是 resolver
endpoint condition，不属于该总括句。

#### Resolver 唯一总序

union 的书写顺序不构成规则。两个 API 共同使用层级总序：**activation-context identity →
query input shape → catalog safe sink → query existence/cardinality → entity/reference
status/context → mapped**，命中第一项即返回：

- reference：① invalid context；② invalid reference；③ catalog safe-sink decision；
  ④ unknown identity；⑤ unknown revision；⑥ revision 不是 latest；⑦ latest withdrawn；
  ⑧ lifecycle not active；⑨ region；⑩ language；⑪ review not effective；⑫ review expired；
  ⑬ mapped。
- hard：① invalid context；② invalid primitive/pattern mappingId；③ catalog safe sink；
  ④ mappingId cardinality（0 条=`hard_mapping_unknown`，大于 1 条=`invalid_catalog`）；
  ⑤完整评估 source endpoint；⑥仅在 source usable 时完整评估 target endpoint；⑦ mapped。

catalog safe sink 对 structural/global、query-unrelated 或多于一个 query-local
`ValidationIssue` 返回 `invalid_catalog`；只有 decoded catalog 无 issue，或唯一 issue 是
queried mappingId cardinality / 唯一 query-local endpoint defect，才能继续到
cardinality/endpoint 分类，且在完整安全评估前绝不 mapped。每个 reference/hard endpoint
内部唯一顺序是：unknown identity/unresolved → unknown 或 non-latest revision → withdrawn →
lifecycle not active → region → language → review not effective → review expired → usable。
hard 的整条 source endpoint 先于整条 target endpoint。

因此一个 active reference 同时 region/language 不适用且 review expired 时唯一返回
`region_not_applicable`；hard source 出现同样 compound failure（即使 target 也失败）时唯一
返回 `hard_mapping_source_region_not_applicable`。两者均是冻结的 whole object，failure
own keys 仍精确为 `reason,status` 且零 raw。

### 4. Source identity 与 entity history 使用显式 canonical projection

reference/snapshot 必须一一配对：每个 reference 恰有一个相同 SourceKey 的 snapshot，
每个 snapshot 也恰有一个相同 SourceKey 的 reference。三类 source material 与 entity
history projection 的 exact own keys 和顺序固定为：

```text
SourceKey = { referenceId, referenceRevision }
ForwardSourceMaterial = { locator, snapshotId, contentDigest, retrievedAt }
ReverseSnapshotMaterial = {
  referenceId, referenceRevision, locator, contentDigest, retrievedAt
}
CanonicalEntityHistoryMaterial = {
  schemaVersion, datasetId, datasetKind, entityId, entityRevision,
  lifecycleStatus, owner, approvers, sourceTier, sourceReferences,
  sourceSnapshots, applicableRegions, languages, licenseStatus,
  licenseReference, retrievedAt, reviewedAt, reviewDueAt, aliases,
  supersededBy, withdrawalState, withdrawalReason, withdrawnAt, content
}
```

同一 SourceKey 的 `locator`、`snapshotId`、snapshot `contentDigest` 或 `retrievedAt` 任一
单字段漂移都产生 `SOURCE_REFERENCE_EQUIVOCATION`。不同 SourceKey 复用同一 `snapshotId`
且 reverse material 不同产生 `SOURCE_SNAPSHOT_ID_EQUIVOCATION`。pairing 不匹配独立产生
`SOURCE_SNAPSHOT_MISMATCH`；compound input 可以同时产生多个 issue，不要求 singleton。

JSON Pointer 路径按 RFC 6901 固定：未配对 reference 指向
`/releases/{r}/envelopes/{e}/sourceReferences/{i}`，未配对或错配 snapshot 指向
`/releases/{r}/envelopes/{e}/sourceSnapshots/{j}`；forward equivocation 总是指向后出现
material 的 reference 路径，reverse equivocation 总是指向后出现 material 的 snapshot
路径。`r/e/i/j` 是 catalog array 的十进制索引；第一次出现建立 material，后续不同 material
逐个报告。以上 code/path 是唯一规则。

`CanonicalEntityHistoryMaterial` 的 own keys 和顺序也是完整集合。release root 拥有
`releaseId`、`releaseRevision`、release
`contentDigest` 与 fixture-only evidence；它们明确不进入 entity history material，因此
full snapshot 重复相同 entity revision 时不会被 release-scoped metadata 污染。相同
entity revision 的上述 material 必须逐字节相同；变更 entity-local 内容必须提升 revision。
`releaseRevision` 只要求严格递增，不要求连续；例如 `1 → 3` 在 digest、full-snapshot
history 和全部治理不变量有效时合法，不产生 gap issue。

### 5. Lifecycle 使用 literal 6×6 oracle

下表只适用于相邻 full-snapshot release 中同一 entity 的**不同** `entityRevision`，且 next
revision 必须严格大于 previous；`A` 接受，`R` 拒绝：

| previous → next | draft | under_review | approved | active | superseded | withdrawn |
| --- | --- | --- | --- | --- | --- | --- |
| draft | A | A | R | R | R | R |
| under_review | R | A | A | R | R | R |
| approved | R | R | A | A | A | A |
| active | R | R | R | A | A | A |
| superseded | R | R | R | R | R | R |
| withdrawn | R | R | R | A | R | A |

相同 `entityRevision` 跨 full-snapshot release 不是 transition，只允许
`CanonicalEntityHistoryMaterial` 逐字节相同。M0-R2 必须直接以本表 36 格逐格运行普通
table test，不得在测试或实现中维护第二张表。以下三条 whole-release 历史必须合法，所有
未列治理字段均有效、source pairing/identity 合法且每次 release digest 重签：

1. 普通激活：同一 entity 在 release/entity revision `1/1 draft → 2/2 under_review →
   3/3 approved → 4/4 active`。
2. supersession：source 在 `4/3 active → 5/4 superseded`；`supersededBy` 精确指向同
   dataset/kind、非自身、在 release 5 中 latest 且 active 的 target revision，target 同时
   出现在该 full snapshot。
3. 撤回后恢复：同一 entity 在 `5/5 active → 6/6 withdrawn → 7/7 active`；恢复是带新
   source/review evidence 的更高 entity/release revision，不得静默重激活旧 revision。

supersession 的 target/dataset/kind/revision/self/cycle 判据继续 fail closed；上述正向历史
证明状态机可满足，而非只证明拒绝路径。

### 6. Schema 对 `-0` 的能力必须诚实分层

`-0` 的唯一 owner 是 `decode.ts` 的 recursive scalar-closure decoder。它对 raw JSON
解析后的整棵值和 intentional object input 运行同一递归闭包；number 分支使用
`Object.is(value, -0)` 语义拒绝 object `-0`，不存在第二个 runtime validator authority。
schema manifest 只标 `runtime-owned: decode.ts scalar closure`。标准 JSON Schema/Ajv
不冒领该能力，也不新增 custom keyword 后用同一 Ajv/compiler 路径自证。

### 7. 使用普通测试，不建立自证合同

M0 使用 unit、seeded property、table-driven lifecycle 和 regression tests。scope gate
只检查允许文件、七模块、synthetic-only、依赖和禁止 imports，保持短小可读；它不扫描
compiler callback、不修改源代码执行 mutation，也不登记逐 predicate guard registry。
已接受的 M0 gate 只传播普通命令失败并核对这些静态边界；loader、compiler、runner、pnpm、
Ajv 与依赖字节继续由 frozen lockfile、Git review、CI/09A、固定 Node 和独立 Audit A/B
构成的 TCB 承担，M0 checker 不自证这些执行载体或 supply-chain。

## 不采用的方案

- 不延续约 3k 行 checker、约 2k 行 mutation suite 或 223 项 guard registry；它们会把
  工具自证误当产品证据。
- 不用 compiler callback mutation、loader/preload 注入或 test-runner event 计数证明
  domain 结果。
- 不要求每个防御层被删除后 public pipeline 接受输入；layered defense 本来就可能继续拒绝。
- 不把 schema 无法表达的 `-0` 伪装成 schema-native 能力。
- 不把 release metadata 放入 entity history projection。

## 影响

- 证据量以产品不变量和真实反例为单位，不再以 guard 数量或 mutation 数量为进度。
- 多 issue 是合法的 defense-in-depth 结果，但顺序、code 和 path 必须确定。
- 工具链风险不会消失；它被诚实留在 TCB，由 lockfile、09A/CI、Git review 与独立 A/B
  审计覆盖。
- 本 ADR/M0 的 Accepted 状态不授权权威真实 release、真实用户/食品数据、migration、
  contracts/API/client 变化、外部能力或 M1。

## 验证与接受边界

Recovery 已按 M0-R1/R2/R3 与 bounded remediation 完成。acceptance candidate
`186bd2f43695e1136a3a1fc43faa6d6088d9ce54` 在同一代码候选上完成 domain
check/build/tests、`pnpm stage09p:m0:check`、无条件 `pnpm check`、文档链接、完整
`pnpm stage09a:check` 14/14、diff/status/零残留，并获得 Cycle 2 独立 Audit A 静态审查与
Audit B 纯 domain 动态审查双 CLEAN；总控据此 Accepted ADR-0008 与 M0。09P 仍为
In Progress，本次收口时 M1 尚未开始。
