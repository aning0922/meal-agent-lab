# M5.16 runtime source mutation 证据架构整改任务书

- 日期：2026-08-22
- 状态：Implementation complete — narrow gates PASS, committed-candidate gate pending
- 基线候选：`f5c9a4c7d20ff169c061c1bbad8c9af6eb502180`
- 代码与回归落点：`1e75e47e2591fe9c0edee29511629591e1f729d9`
- 范围：M5 production guard 的 runtime capability source / identity-loss mutation 证据与 focused 会计
- 不在范围：产品实现、API/contracts/client、Docker/Compose/M3B/M4 生产实现、云资源、真实微信与远端 CI

## 1. 触发原因与总控裁定

M5.15 候选 `f5c9a4c` 的替代独立审计有效完成：动态审计 B 为 **CLEAN**，单次正式
`pnpm stage09a:check` 14/14、runtime image mutation、M3B/M4 全链与零残留证据均有效；
静态审计 A 为 **BLOCK**。A 没有证明当前未变异 guard 存在新的 production 绕过，而是
证明 M5.15 声称的 deletion/weakening witness 不成立：将 dynamic computed-access source
判据精确弱化为恒允许后，完整 production guard 仍为 **35/35、exit 0**。`global`、
`globalThis.process`/`global.process` 与 canonical global-root 身份分支也能由下游类型判据
代偿，无法证明失败来自指定 source criterion。

总控在同一基线、固定 Node.js `v24.18.0` 下独立重跑 dynamic computed mutant，得到相同
的 35/35。另确认 focused `--test-name-pattern` 会被全局 `test.after()` 的“未执行全部
guard”会计以无关理由判红，存在把存活 mutant 误写成已杀死的风险。因此 M5 保持未
Accepted，进入一次 bounded 证据架构整改。

## 2. 有界设计

### 2.1 同一闭集 registry 是实现也是 mutation 面

runtime capability source 不再由一个布尔表达式混合判断，而由 production guard 实际
消费的八条闭集规则定义：

1. `canonical-process`；
2. `globalthis-process-property`；
3. `global-process-property`；
4. `globalthis-process-element`；
5. `global-process-element`；
6. `node-process-alias`；
7. `canonical-globalthis-root`；
8. `canonical-global-root`。

identity-loss 由三条互斥规则定义：`jsdoc-cast`、`dynamic-computed-access` 与
`unreviewed-value-flow`。直接静态 property、常量 computed property 以及受评审的 native
bind 继续是允许分支。canonical `process` 只接受真正的值表达式，属性名不再被错误地
当成第二个 source；这使 `globalThis.process`/`global.process` 的 ownership 不被
canonical-process 分支代偿。

### 2.2 独立 deletion witness

测试与生产 guard 消费同一份 registry。每条 source/loss 规则各有一个只能由它拥有的
fixture；测试先证明正常 policy 产生固定
`production synchronous module loader capability was forbidden`，再从实际 registry 中
删除一条规则，要求该 fixture 的固定理由消失。删除不是测试里的第二份 scanner，也不靠
总计数、未捕获异常或后续 guard 变红。

首轮新反例当场抓出一处隐藏重叠：删除 `globalthis-process-property` 后 fixture 仍被
canonical-process 捕获，因为 TypeScript 会把 property name 的 `process` 解析到全局符号。
实现随后把 canonical-process 限定到非 property-name 的值位置，8 条 source 与 3 条
identity-loss deletion witness 才全部成立。

### 2.3 focused/full-suite 会计分离

guard oracle 完整性改为**声明时登记**：每个 registry ID 必须恰好声明一个 `guardTest`，
完整 suite 仍执行全部已声明测试；focused mutation 允许只选择目标 oracle，不再因为无关
测试被过滤而由 after-hook 假红。另有正向/反向集合断言证明 registry 与声明集合相等，
删除任一声明会产生 drift。

## 3. 修复前/后证据

固定 Node.js `v24.18.0`：

- 修复前，dynamic computed 判据精确改成恒允许后：production guard **35/35**；
- 修复后，focused source/loss/accounting：**3/3**；其中实际 deletion witness 为
  **8 source + 3 loss = 11/11**；
- 完整 production guard：**38/38**，0 fail、0 skipped、0 todo；
- 全部 scripts tests：**218/218**，0 fail、0 skipped、0 todo；
- M5.15 的固定诊断、Node Process alias、两种 `dlopen`、Windows absolute ownership、
  本地同名反向对照与 native bind 对照全部保留。

## 4. 提交态门禁与状态纪律

新增本任务书后 committed tracked-file baseline 由 373 增加为 374。文档与 baseline
提交完成后，必须在同一最终 HEAD、固定 Node.js `v24.18.0` 下从步骤 1 串行执行：

```bash
pnpm stage09a:check
pnpm docs:links:check
git diff --check
git status --short
```

并独立复核 scoped Docker、进程组、临时 Secret/backup/override 与 per-run image 零残留。
任一门禁为红时不得创建审计。全绿后创建两个**全新、用户可见、彼此独立 worktree** 的
审计任务：A 使用确定性静态与 mutation adequacy 范围，禁止 Docker；B 先执行一次
`pnpm install --frozen-lockfile`，随后只执行一次正式 `pnpm stage09a:check` 并独占 Docker。

本任务不 push、不 merge、不创建 PR，不自行标记 M5 Accepted、09A Pass 或远端 CI Pass。
两路审计均 CLEAN 后才回到项目总控做 Accepted 裁定。
