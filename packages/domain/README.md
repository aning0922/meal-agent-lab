# `@meal-agent/domain`

这是 Stage 09P-M0 Recovery 的纯 TypeScript 领域包。完整 acceptance candidate
`186bd2f43695e1136a3a1fc43faa6d6088d9ce54` 已获 Cycle 2 独立 Audit A/B 双 CLEAN，
ADR-0008 与 M0 已由总控 Accepted；09P 仍为 `In Progress`，本次 M0 收口时 M1 尚未开始。

## M0 Accepted 边界

- production 精确为 `types.ts`、`decode.ts`、`canonical.ts`、`validation.ts`、
  `catalog.ts`、`resolution.ts`、`index.ts`；
- 不执行文件、网络、数据库或模型调用，不依赖 Node 专属 I/O；
- raw JSON 与 intentional object input 共用 `decode.ts` recursive scalar closure；
- `-0` 的唯一 authority 是该 scalar closure 的 `Object.is(value, -0)` 检查；标准 Schema
  和 Ajv 不使用 custom keyword，也不声称能区分 `0` 与 `-0`；
- canonical object key 使用 UTF-8 byte order；release digest 只排除其自身
  `contentDigest` 字段。
- catalog/lifecycle/source identity 与 resolver 使用确定性、fail-closed 的普通 domain 规则；
  unknown mapping、许可/地区/语言/版本/审核/撤回不满足时不得 mapped。

五份 valid 与十份 invalid fixture 都是显式标记的合成测试材料，不是权威真实 release、真实
食品事实或用户数据。机器检查不能在一般
意义上证明任意自由文本都不是现实食品事实；synthetic-only 的剩余责任仍属于 Git review、
固定 lockfile 和独立审计 TCB。

## 命令

```bash
pnpm --filter @meal-agent/domain typecheck
pnpm --filter @meal-agent/domain test
pnpm --filter @meal-agent/domain test:schema
pnpm --filter @meal-agent/domain build
```

M0 checker 只聚合普通命令并传播失败，不自证 loader/compiler/runner/worker/supply-chain；
这些能力继续由 frozen lockfile、Git review、CI/09A、固定 Node 与独立审计组成的 TCB 承担。
M0 Accepted 不改变 09P 的 `In Progress` 状态，也不启动 M1。
