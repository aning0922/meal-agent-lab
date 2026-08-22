# M5.15 runtime capability source 闭包整改任务书

- 日期：2026-08-22
- 实施基线：`3523ebe6a53bc3f33f1ac8e88ddec87ff0956153`
- 代码与回归落点：`5b4474c`
- 状态：Implementation complete — narrow gates PASS, committed-candidate 14-step gate pending；M5 未 Accepted；阶段 09A 未 Pass
- 范围：同步 module-loader 的 runtime capability source、固定安全诊断、Windows module identity 规则归属

## 1. 审计输入与证据等级

M5.14 审计 B 有正式报告并给出有效 `BLOCK`：精确候选 `3523ebe` 的本地提交态
`stage09a:check` 为 14/14，终态会计为零残留，但 production guard 可先对真实 `process`
调用 `Object.getOwnPropertyDescriptors()`，再从失去 Node 声明身份的 descriptor map 取得
`getBuiltinModule` 与 `createRequire`。真实 Node.js `v24.18.0` 证明该路径最终取得的函数与
`process.exit` 相同；完整影子 production guard 为 33 PASS / 1 FAIL，因此是确认级 P1。

审计 A 的用户可见任务被平台 safeguard 中断，没有生成正式报告，结论必须记为
`INVALID`，不能写成 CLEAN 或 BLOCK。其 worktree 留下了只读探针；总控在固定 Node
`v24.18.0` 下独立重跑后，确认以下事实，但只把它们作为总控复现输入：

- JSDoc `any`、`Object(process)`、optional-any、generic forwarding 与 bind-after-erasure
  五种形态均返回零问题；
- `process.dlopen` 返回零问题；
- static namespace、dynamic import 与 re-export 三类 capability 诊断都原样拼入了注入的
  module specifier sentinel；
- POSIX absolute witness 由 absolute rule 独立拥有，但 `C:/...` 与 `C:\\...` 仍由其他
  rule 代偿，原“POSIX/Windows absolute”口径与逐规则 mutation 证据不一致。

## 2. 根因

M5.14 在最终 property 仍带 Node 类型时读取 declaration identity。descriptor map、
`Object()`、JSDoc cast、generic forwarding 或 holder 会在读取 property **之前**抹掉类型；
此后再增加 `getBuiltinModule`/`createRequire` 的属性形态只是开放枚举。相同问题也出现在
全局对象先被转交、再从其上取得 `process` 的路径。

诊断边界另有一个独立根因：用于定位 protected declaration 的 module specifier 属于可被
源码变异的输入，却被直接拼进错误字符串。门禁失败虽正确，输出安全声明仍不成立。

## 3. 有界架构策略

production surface 没有合法的同步 module-loader consumer，也没有合法需求把真实
`process` 或 `globalThis` 根对象交给 descriptor、generic、holder 或 callback。因此本轮
把闭包前移到**能力来源最后仍可证明身份的位置**：

1. `node:module` namespace、`createRequire`、`process.getBuiltinModule` 与
   `process.dlopen` 仍按 Node 声明身份固定拒绝；
2. canonical `process`、`globalThis.process`、`global.process`、Node `Process` import alias
   一旦进入 descriptor map、`Object()`、JSDoc cast、generic、holder、callback 或动态
   computed access，立即固定拒绝；
3. canonical `globalThis`/`global` 若被整体反射、转交或持有，同样在身份丢失点拒绝；
4. production 现有的直接静态 property 读取保持允许；`process.kill.bind(process)` 与
   `globalThis.setTimeout/clearTimeout/setImmediate.bind(globalThis)` 是明确的反向正例；
5. 同名本地 `process`、`globalThis`、`createRequire` 与 `getBuiltinModule` 必须保持允许，
   判据不能退化成名字扫描。

这仍是工程 guard，不是对任意 JavaScript 元编程的形式化安全证明。新增 production 若确需
传递 runtime root，必须先登记窄能力投影、唯一消费者与 deletion/weakening witness，不能
直接给现有闭包加通配豁免。

## 4. 修复前/后证据

只改测试、未改判据时，production guard 精确为 29 PASS / 6 FAIL：三条旧诊断期望改成
固定安全原因后变红；Windows drive witness 证明 absolute rule 不独立；descriptor-map
反例未被同步 loader 原因拒绝；sentinel 诊断矩阵失败。五种 erasure 与 `dlopen` 的独立
修复前事实由上一节所述总控重跑探针取得。

实现后，固定 Node.js `v24.18.0`：

- production guard：35/35；
- 全部 scripts tests：215/215；
- descriptor map、JSDoc any、`Object(process)`、optional/generic/bind erasure、
  `globalThis` descriptor/Reflect/holder、`node:process` import 与两种 `dlopen` 入口均以
  同一固定 loader 原因拒绝；
- 同名本地 runtime roots 保持允许；
- namespace/dynamic/re-export 三类 capability 诊断只包含可信文件标签与固定类别，
  注入 specifier sentinel 命中为零；
- Windows `C:/...` 由 absolute rule 自己拥有，non-node scheme 不再代偿该 witness。

## 5. 交付与状态纪律

包含本任务书的提交会使 `git ls-files` baseline 增加 1；登记完整性 baseline 只能按实际
tracked 文件数机械同步。随后必须在同一 committed tree、固定 Node.js `v24.18.0` 上从
步骤 1 串行运行 `pnpm stage09a:check` 14/14，再运行 Markdown links、`git diff --check`
与 scoped 零残留复核。任何门禁为红时不得创建审计。

全绿以后仍只能写成 committed-candidate gate PASS，下一门禁是两个**全新、用户可见、
彼此独立**的 A/B 审计任务：A 只读静态且禁止 Docker，B 只读动态且独占 Docker。两路
均 CLEAN 后才回到项目总控做 Accepted 裁定；本任务不 push、不 merge、不创建 PR，
不把本地 14/14 冒充远端 GitHub Actions PASS。
