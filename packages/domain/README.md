# `@meal-agent/domain`

这是 Stage 09P-M0 Recovery 的纯 TypeScript 领域包。当前只实现 M0-R1：strict decode、
标准 JSON Schema 2020-12、canonical JSON 与 deterministic SHA-256 digest。

## R1 边界

- production 仅有 `types.ts`、`decode.ts`、`canonical.ts`、`index.ts`；
- 不执行文件、网络、数据库或模型调用，不依赖 Node 专属 I/O；
- raw JSON 与 intentional object input 共用 `decode.ts` recursive scalar closure；
- `-0` 的唯一 authority 是该 scalar closure 的 `Object.is(value, -0)` 检查；标准 Schema
  和 Ajv 不使用 custom keyword，也不声称能区分 `0` 与 `-0`；
- canonical object key 使用 UTF-8 byte order；release digest 只排除其自身
  `contentDigest` 字段。

五份 valid fixture 与 R1 invalid fixture 都是显式标记的合成测试材料。机器检查不能在一般
意义上证明任意自由文本都不是现实食品事实；synthetic-only 的剩余责任仍属于 Git review、
固定 lockfile 和后续独立审计 TCB。

## 命令

```bash
pnpm --filter @meal-agent/domain typecheck
pnpm --filter @meal-agent/domain test
pnpm --filter @meal-agent/domain test:schema
pnpm --filter @meal-agent/domain build
```

M0-R2 的 `validation.ts`、`catalog.ts`、`resolution.ts` 及其测试尚未开始；M0-R3 与 M1
也未开始。本包当前未 Accepted。
