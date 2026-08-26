# ADR-0008：Stage 09P-M0 产品证据边界

- 状态：Proposed
- 日期：2026-08-26
- 负责人：产品负责人、领域架构、食品安全与数据治理
- 基线：`2c2ccd9015268fe44db4bb5446f3340e551914be`
- 上位决策：[ADR-0007：食品知识治理与确定性领域核心](0007-food-knowledge-governance-and-domain-core.md)
- 实施候选：[Stage 09P-M0 Recovery 实施计划](../../plans/2026-08-stage-09p-m0-recovery.md)

本 ADR 是恢复设计候选，不表示 ADR 已 Accepted，也不表示 M0、09P 或任何实现已
Implemented / Accepted / Pass。M1 未开始。

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
| raw JSON 无歧义、资源有界、`-0` 拒绝 | strict raw decoder | unit/property 边界测试 | `decode_failed` + 固定 code/path | Node 字符串、loader |
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
  | { status: 'unapproved'; reason: HardMappingContextFailureReason }
```

`HardMappingContextFailureReason` 是 source/target × region/language/review-not-effective/
review-expired 的封闭八值 union，source precedence 先于 target。reference mapped 的 exact
sorted own keys 为 `envelope,reason,status`，hard mapped 为
`mappingId,reason,source,status,target`，所有 failure 均为 `reason,status`。每个分支固定
字段类型、冻结状态和 precedence；whole-object 直接 `deepStrictEqual`，不得用
projection/tag 代替。
public failure 只返回固定 status/reason/code 和必要的安全 ID；不得返回 catalog、context、
reference、mapping、mappingId、raw input、异常 message 或其片段。missing/forged context、mapping
数量异常、compound catalog issues 或 issue 与 query 无关时统一安全降级为
`invalid_catalog`，不能挑一个看似相关的细分 reason。

### 4. Source identity 与 entity history 使用显式 canonical projection

reference/snapshot 必须一一配对，`referenceId + referenceRevision` 双向指向匹配的
snapshot；同一 SourceKey 的 forward material 和同一 `snapshotId` 的 reverse material
都不得 equivocate。一个 compound input 可同时报告 pairing、forward 和 reverse issues。

固定 projection：

```text
CanonicalSourceReference = { referenceId, referenceRevision, locator }
CanonicalSourceSnapshot  = { snapshotId, referenceId, referenceRevision,
                             contentDigest, retrievedAt }
CanonicalEntityHistoryMaterial = {
  schemaVersion, datasetId, datasetKind, entityId, entityRevision,
  lifecycleStatus, owner, approvers, sourceTier, sourceReferences,
  sourceSnapshots, applicableRegions, languages, licenseStatus,
  licenseReference, retrievedAt, reviewedAt, reviewDueAt, aliases,
  supersededBy, withdrawalState, withdrawalReason, withdrawnAt, content
}
```

上述 own keys 和顺序是完整集合。release root 拥有 `releaseId`、`releaseRevision`、release
`contentDigest` 与 fixture-only evidence；它们明确不进入 entity history material，因此
full snapshot 重复相同 entity revision 时不会被 release-scoped metadata 污染。相同
entity revision 的上述 material 必须逐字节相同；变更 entity-local 内容必须提升 revision。
生命周期 36 格、终态、supersession target/dataset/kind/revision/cycle 必须存在至少一条
合法正向历史，不能只证明拒绝路径。

### 5. Schema 对 `-0` 的能力必须诚实分层

标准 JSON Schema/Ajv 若不能把 `-0` 与 `0` 区分，该不变量由 strict raw decoder 或
runtime validator 唯一拥有，schema manifest 标成 `runtime-owned`。禁止新增 custom
keyword 后再用同一 Ajv/compiler 路径证明 keyword 自身；schema 只声明和测试标准能力。

### 6. 使用普通测试，不建立自证合同

M0 使用 unit、seeded property、table-driven lifecycle 和 regression tests。scope gate
只检查允许文件、七模块、synthetic-only、依赖和禁止 imports，保持短小可读；它不扫描
compiler callback、不修改源代码执行 mutation，也不登记逐 predicate guard registry。

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
- 本 ADR 不授权实现、真实数据、migration、contracts/API/client 变化或 M1。

## 验证与接受边界

实施候选按 Recovery 计划分 M0-R1/R2/R3。最终同一精确 SHA 必须完成 domain
check/build/tests、`pnpm stage09p:m0:check`、范围要求时的 `pnpm check`、文档链接、
完整 `pnpm stage09a:check` 14/14、diff/status/零残留；再由独立 Audit A 静态审查和
Audit B 纯 domain 动态审查。实施者只能交付候选并请求复核，不能把本 ADR、M0 或 09P
写成 Accepted / Pass。
