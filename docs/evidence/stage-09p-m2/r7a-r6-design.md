# Stage 09P-M2 R7-A-r6 设计冻结

状态：已决定。此文件冻结 r6 的修复范围；只修改新的 shadow candidate，原仓库与 r1-r5 均不修改。

## 输入与基线

- repo HEAD: `8a69bc2435e1b7ebb3667d6bbea39ef5dffe81b8`
- repo tree: `bfa8d2901e099982de5f0f9ec218fb4562ac7839`
- r5: `/private/tmp/meal-agent-r7a-r5.mAIndD/contracts`
- r6: `/private/tmp/meal-agent-r7a-r6.9CetDE/contracts`
- r6 初始内容是 r5 的机械复制，排除 `dist`、`node_modules` 后无差异。
- 维持 `version` / `contractVersion` `0.4.0`、1 MiB wire cap、10,000 logical cap、Inventory 17/chunk、Seasoning 388/chunk。

## A：最终 public schema 直接绑定

每个 M2 域有三个独立 runtime rule 和最终 public boundary：

1. 保留 `*.replay-chunk-consistency.v1`，只校验 caller replay input；
2. 新增 `*.replay-server-checkpoint-consistency.v1`，只校验 server-verified checkpoint；
3. 新增 `*.replay-chunk-result-consistency.v1`，实际校验 `accepted_chunk <-> open` 与 `finalized <-> finalized`。

三个导出均以 `ruleSuperRefine(rawUnion, id, exactBoundary, callback)` 作为最终构造步骤。绑定中的 `schema` 必须与导出的对象严格同一，根 metadata 必须精确对应自身 rule；之后不得再用 intersection、union 或 meta clone 包装。caller claim、server checkpoint 与 result authority 继续严格分离。

## B：parser 深只读与递归冻结

在 `stage09p-input.ts` 提供品牌字符串安全的 `DeepReadonly<T>` 与仅供 Zod-owned ordinary data 使用的 descriptor-only deep freezer。实现使用 `Reflect.ownKeys` 和 `Object.getOwnPropertyDescriptor`，不读取 getter；只接受 Array/Object/null-prototype 数据图，拒绝 symbol key、accessor、非 data descriptor 与循环，子对象先冻结、根对象最后冻结。

两个 raw replay parser 的 success value 类型改为 `DeepReadonly<...DTO>`，运行时返回完整递归冻结的数据。该 helper 不是 arbitrary object/proxy sanitizer，不直接用于未经过 parser/Zod 的外部对象。

## C：严格空历史终态

不增加新的 wire discriminator；复用 `chunkKind: "only"`，用独立 strict literal branch 表示空历史。raw empty input 精确字段为：

- schema/scope/session 字段；
- `chunkKind: "only"`、`chunkOrdinal: "1"`；
- `chunkStartSequence: "1"`、`chunkEndSequence: "0"`；
- `previousChunkTerminalEventDigest: null`、`terminalEventDigest: null`；
- `processedEventCountBefore`、`chunkEventCount`、`claimedProcessedEventCount`、`declaredTotalEventCount` 均为 `"0"`；
- `priorCheckpointClaim: null`、`events: []`、`claimedFinalHistoryDigest: null`。

它先与 nonempty branch 组成 raw input union，再由同一个最终 public input rule 一次绑定；empty callback 早退，精确语义由 strict/literal schema 闭合。

server finalized-empty checkpoint 仍是 `kind: "server_verified"`、`status: "finalized"`，保留 checkpoint/scope/session 与 envelope digest；`nextChunkOrdinal: "2"`、`processedEventCount: "0"`、`nextEventSequence: "1"`、`terminalEventDigest: null`、`declaredTotalEventCount: "0"`、`verifiedHistoryDigest: null`。result 使用既有 `kind: "finalized"` 携带此 checkpoint；`accepted_chunk` 只允许 open。caller claim 不扩展为零计数或 null tip。

empty 不新增 rule、reason 或 ordinal。它受现有 wire/decoded resource limits 约束，且 envelope 小于现有 proof 预算。

## D：root 发布隔离与 scoped registry

新增内部纯工厂 `contract-rule-registry.ts`。每次调用持有私有 manifest lookup 与 schema-binding map，并保留 r5 的 fail-closed 校验：重复 manifest ID/boundary、metadata 数量/顺序/内容偏差、重复 rule 绑定、缺失 binding 均拒绝。

- `contract-rule-schema.ts` 只实例化 legacy registry，并维持既有 root helper/API 名称。
- `refinement-rules.ts` 只保留 35 条 legacy rule。
- `refinement-bindings.ts` 不再导入 M2 模块，只导出 legacy registry snapshot。
- `inventory-v2.ts` 与 `seasoning-v1.ts` 分别定义、实例化、验证并从既有 package subpath 导出各自 manifest/schema bindings/serializable bindings/types。
- `src/index.ts` 保持字节不变；root 不直接或间接暴露、解析或加载 M2 schema/rule objects。
- 不使用 prefix filter、共享 global map 清理或 import-order-sensitive snapshot。

精确计数：

| scope | manifest | schema bindings | bound rule IDs |
| --- | ---: | ---: | ---: |
| legacy root | 35 | 34 | 35 |
| Inventory V2 | 15 | 15 | 15 |
| Seasoning V1 | 11 | 11 | 11 |
| unique aggregate | 61 | 60 | 61 |

## 验收矩阵

- 六个 M2 public input/checkpoint/result schemas：binding identity、精确根 metadata、acceptance equality。
- caller claim、server checkpoint、nonempty/empty input、open/finalized/finalized-empty result 的正反矩阵。
- parser 深层 `events/event/payload/binding/priorCheckpointClaim` 的 runtime frozen 断言与 strict consumer readonly compile assertions。
- empty raw parser、checkpoint、result、near-miss、extra field、resource accounting。
- root manifest/bindings 不含 M2 ID/schema；fresh-process 的 root-only、M2-first、root-first、两域交错 import-order smokes。
- built package exports 与 strict NodeNext `skipLibCheck:false` consumer smoke。
- 完整 build、typecheck、test 与原资源/canonical parser 回归。
