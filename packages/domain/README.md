# `@meal-agent/domain`

这是 Stage 09P 的纯 TypeScript 领域包。完整 M0 acceptance candidate
`186bd2f43695e1136a3a1fc43faa6d6088d9ce54` 已获 Cycle 2 独立 Audit A/B 双 CLEAN，
ADR-0008 与 M0 已由总控 Accepted；09P 仍为 `In Progress`。M1 在同一七模块内增加家庭餐桌
安全求值，但不授予任何真实 source pack 激活或 public trust。

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
M0 Accepted 不改变 09P 的 `In Progress` 状态。

## M1 家庭餐桌安全边界

- public evaluator 接受结构化 input 和 official source pack，但 trust allowlist 固定为空；
  draft、withdrawn、untrusted、版本漂移或来源治理不完整均 fail closed，public 结果永不
  `allowed`；
- 非空 dish exposure 覆盖 primary、secondary、seasoning、garnish、substitute、contains、
  may_contain 与 cross_contact 八类；空 exposure 在读取 source pack 或 synthetic graph 前
  以 `EMPTY_DISH_EXPOSURES` 拒绝；
- 所有 active household profile 的 allergy（即使不是本餐参与者）及所有 guest allergy 是
  全桌 hard constraint；参与者的 religious、ethical、explicit strict avoid 是个人 hard
  constraint；ordinary avoid、dislike、reduce 只产生 soft reason；
- mapping、binding/current window、M0 resolution、review、endpoint fact 与 known-match 按固定
  phase 归约；unknown、ambiguous、future、expired、unapproved、unlicensed、缺 review/fact 或
  缺 `REVIEWED_CLEAR` 时均不允许推断安全；
- 三个非 root-export test seam 只接受严格的全合成 graph/analyzed state，并由两个私有 brand
  阻止 caller 构造最终 reason 或治理结论；production 仍无文件、网络、时钟、loader、数据库
  或模型 I/O。

仓库中的 M1 reference pack 仅是 official-source provenance draft：zero active mappings、zero
mapping reviews、zero `REVIEWED_CLEAR`、许可/usage 均 pending。它不能进入 public trust，也
不能作为真实家庭、食材或推荐数据。

```bash
pnpm stage09p:m1:check
```

该命令只是 candidate gate；它和 source/scope checker 都不自行宣布 Accepted、可发布或可激活。
