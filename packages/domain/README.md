# `@meal-agent/domain`

阶段 09P-M0 的纯 TypeScript 确定性领域边界。当前只实现五类知识数据共用的治理信封、
release canonical digest、引用解析和 hard mapping 的 fail-closed 校验；不包含
Recipe、Recommendation、Meal、Shopping、库存写入或运行时安全决策。

## 边界

- 生产源码唯一运行时依赖是纯 JavaScript 的 `@noble/hashes`；
- 不依赖 Fastify、Drizzle、Taro、React、数据库、Node I/O 或模型 SDK；
- 不定义 HTTP DTO、数据库 row、repository、adapter 或副作用接口；
- 文件读取只存在于 tests，用于验证仓库内完全合成 fixture，不进入 `dist`。

公开入口为 [`src/index.ts`](src/index.ts)，包括：

- `GovernanceEnvelope` / `GovernanceRelease` / `GovernanceCatalog`；
- `decodeGovernanceReleaseJson()` / `decodeGovernanceCatalogJson()` 与 descriptor-safe
  object 解码入口；
- `validateGovernanceRelease()` / `validateGovernanceCatalog()`；
- `canonicalReleaseText()` / `canonicalReleaseDigest()`；
- `resolveGovernedReference()`；
- 稳定闭集 `mapped / unmapped / withdrawn / version_mismatch / unapproved`。

raw object 不被视为治理事实。唯一解码层逐层只复制 own data descriptor，要求 exact
string keys、标准 prototype 与致密数组，拒绝 accessor、symbol、额外数组属性、循环、
`undefined`、Date、非有限 number、`-0`、null/custom prototype 和非法 Unicode scalar，并生成 deep-frozen
品牌快照。JSON text 公共入口先拒绝所有非 primitive string，不执行调用方 `toString`、
`valueOf` 或 `Symbol.toPrimitive`；内部 failure identity 为模块私有，不从 hostile exception
读取属性。任意合法 JSON key（含 `__proto__`、空串、NUL 与 astral scalar）均以 own data
property 无损复制。JS 对 Proxy 的反射操作仍可能触发 trap；这里不声称“零 trap”，只保证
trap 抛错或异常 shape 被折叠为固定 `INVALID_SHAPE`，不回显调用方异常。正式外部入口优先
使用 JSON text → `JSON.parse` → strict decode；两个 JSON 入口均为不抛出的 total boundary。

职责分层是显式的：decoder 只证明 shape、own-property 与安全物化边界；Draft 2020-12
Schema 证明 type/enum/pattern/UUID/digest/timestamp 等词法与结构约束；最终 runtime
validator 闭合跨字段时序、digest、lifecycle、catalog identity 和 hard mapping 语义。
因此证据不会要求 decoder 与 Schema 对 UUID、digest、timestamp 或 mapping namespace
产生相同结论；对外可接受集合由 Schema 与最终 validator 对齐。

alias identity 先拒绝 C0/C1 控制字符，再执行 NFC、Unicode `trim()` 和不带 locale 的
`toLowerCase()`；region、language 与精确 `sourceReferenceId + sourceReferenceRevision`
共同约束来源。规范化冲突和同实体重复 alias 都 fail closed。

## Canonical digest

release digest 是 `sha256:` 加 64 位小写十六进制。canonical payload 排除信封中声明的
`contentDigest`，避免自引用；其余治理字段和 `content` 全部参与摘要。对象键、实体和
具有集合语义的数组按 UTF-8 字节序排序，不使用对象插入顺序或 `localeCompare`；内容中
具有顺序语义的普通数组保持原顺序。集合排序逐字段比较 UTF-8，并用完整 canonical
element 作 tie-break，不使用 NUL 拼接键或调用方 iterator。`$schema` 等已声明 release
字段也进入摘要；只有 `contentDigest` 因自引用被排除。canonicalizer 先复用同一严格
解码层，unknown field 不会被静默忽略。

## Validated catalog

`validateGovernanceCatalog()` 成功时返回运行时认证的 `ValidatedCatalogIndex`。重复 release
identity、重复 entity revision、跨 dataset 复用 entity ID、多 exact candidate、无效 digest
或 lifecycle/source/license 失败都会阻止索引发布。`resolveGovernedReference()` 可接收该
品牌索引；兼容 raw catalog 时会先完整 strict decode+validate。`required: false` 的 hard
mapping 只作描述，不阻断 catalog；`required: true` 的 source/target 必须精确 mapped。
所有 hard mapping 的 `mappingId` 在最终 validation 中也必须满足 `^syn:mapping:`，不能
仅凭 decoder 的 non-empty shape 进入 validated catalog。

每个 `sourceSnapshot.retrievedAt` 必须不晚于对应 envelope 的 `reviewedAt`，并继续要求
`reviewedAt <= reviewDueAt`；相等边界允许。JSON Schema 负责 canonical UTC timestamp 的
字符串 shape，跨字段 chronology 由 runtime validator fail closed 执行，不能把 Schema
shape 当作时序证明。

## 校验与反例

五份 valid release 和十份单一原因 invalid fixture 位于
[`data/samples/stage09p-m0`](../../data/samples/stage09p-m0/)。invalid fixture 从受控
valid release 做单一 allowlisted 变异；除 digest mismatch 用例外，其余都会先重算
release digest。因此删除对应的来源、许可、地区、语言、别名、ID、revision、撤回或
hard mapping 校验，会让该用例不再产生唯一预期错误码并直接转红，不会被顺带的 digest
错误掩盖。

`pnpm stage09p:m0:check` 还真实编译并执行两份 Draft 2020-12 JSON Schema，以 15 项 fixture
matrix、精确 30 项 JSON boundary matrix 和 51 项治理字符串分层 matrix 对照 runtime。
Schema 中所有字符串定义族先复用同一 Unicode scalar base，再叠加 enum、pattern、format
或长度语义；Ajv raw/parsed 与 runtime raw/text 一致拒绝 lone surrogate、接受合法
surrogate pair/astral scalar。valid/invalid/schema/source/test surface 由同一递归 inventory 派生；
nested file、directory、symlink 与特殊节点不能绕过 manifest、synthetic registry、Schema
compile 或 AST/module graph。scope suite 对 content matrix 分别硬钉 case count、ID
distinct、material-input distinct、声明的 layering policy 和 oracle completeness；治理
字符串 matrix 另以固定 51-case ordered ID registry 将 ID uniqueness 与 stable
registration 分开，总计六轴，并为每个 guard 执行独立删除 witness。Schema closure
递归覆盖对象与数组中的 `$ref`、`allOf`、`oneOf`、`items`、
`additionalProperties`、`propertyNames`、string `const` 与 string `enum`，八类各有固定理由。
生产源码能力检查使用 TypeScript declaration identity、值来源/provenance 与精确 public
export registry，只允许静态模块和已盘点纯计算调用；`any`/`unknown`/不兼容 assertion
不能伪装审核过的 lib receiver，Reflect 的直接/别名/element access 均按声明来源识别，
property descriptor 读取仅放行 decoder/canonicalizer 中精确登记的调用位置、参数来源、
key 和 result consumption。动态模块、未审核反射取得、类型擦除冒充、
原型链能力、未批准 global、敏感 computed key、未登记 re-export 与无法归类的
call/new/tagged template 均 fail closed，字符串和注释中的敏感词不会造成假判。

```bash
PATH=/Users/aipuli/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm --filter @meal-agent/domain check
```
