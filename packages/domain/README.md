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
品牌快照。JS 对 Proxy 的反射操作仍可能触发 trap；这里不声称“零 trap”，只保证 trap
抛错或异常 shape 被折叠为固定 `INVALID_SHAPE`，不回显调用方异常。正式外部入口优先
使用 JSON text → `JSON.parse` → strict decode。

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

## 校验与反例

五份 valid release 和十份单一原因 invalid fixture 位于
[`data/samples/stage09p-m0`](../../data/samples/stage09p-m0/)。invalid fixture 从受控
valid release 做单一 allowlisted 变异；除 digest mismatch 用例外，其余都会先重算
release digest。因此删除对应的来源、许可、地区、语言、别名、ID、revision、撤回或
hard mapping 校验，会让该用例不再产生唯一预期错误码并直接转红，不会被顺带的 digest
错误掩盖。

`pnpm stage09p:m0:check` 还真实编译并执行两份 Draft 2020-12 JSON Schema，并以仓库外
临时副本运行 scope/schema/synthetic/capability/manifest 五类 mutation witness。生产
源码能力检查使用 TypeScript AST 与相对模块图，字符串和注释中的敏感词不会造成假判。

```bash
PATH=/Users/aipuli/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm --filter @meal-agent/domain check
```
