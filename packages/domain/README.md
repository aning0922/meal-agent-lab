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
- `validateGovernanceRelease()` / `validateGovernanceCatalog()`；
- `canonicalReleaseText()` / `canonicalReleaseDigest()`；
- `resolveGovernedReference()`；
- 稳定闭集 `mapped / unmapped / withdrawn / version_mismatch / unapproved`。

## Canonical digest

release digest 是 `sha256:` 加 64 位小写十六进制。canonical payload 排除信封中声明的
`contentDigest`，避免自引用；其余治理字段和 `content` 全部参与摘要。对象键、实体和
具有集合语义的数组按 UTF-8 字节序排序，不使用对象插入顺序或 `localeCompare`；内容中
具有顺序语义的普通数组保持原顺序。canonicalizer 只接受无环 plain JSON、Unicode
scalar string、有限且非负零的 number，拒绝 accessor、稀疏数组、symbol key、Date、
`undefined` 和非有限数。

## 校验与反例

五份 valid release 和十份单一原因 invalid fixture 位于
[`data/samples/stage09p-m0`](../../data/samples/stage09p-m0/)。invalid fixture 从受控
valid release 做单一 allowlisted 变异；除 digest mismatch 用例外，其余都会先重算
release digest。因此删除对应的来源、许可、地区、语言、别名、ID、revision、撤回或
hard mapping 校验，会让该用例不再产生唯一预期错误码并直接转红，不会被顺带的 digest
错误掩盖。

```bash
PATH=/Users/aipuli/.nvm/versions/node/v24.18.0/bin:$PATH \
  pnpm --filter @meal-agent/domain check
```
