# M5.14 同步 module-loader 能力闭包整改任务书

- 日期：2026-08-21
- 实施基线：`e78c5b7a4f33e3c421ec3859a1bbf184dec9c611`
- 代码与回归落点：`2ab43dc`
- 状态：Implementation complete — narrow gate PASS, committed-candidate gate pending；M5 未 Accepted；阶段 09A 未 Pass
- 范围：production module-loader 根能力、module identity grammar 的逐分支 mutation 判别力，以及 M5.13 当前状态矛盾

## 1. 独立审计输入与总控裁定

M5.13 候选 `e78c5b7` 的审计 A 是有效 `BLOCK`：确认两项 P1 与一项 P2。第一项 P1
证明 identity grammar 新增的 whitespace/Cf、backslash、absolute path 与 arbitrary scheme
分支没有独立 mutation witness；删除或定点弱化后仓库回归仍可全绿。第二项 P1 证明
`node:module#createRequire()` 可同步取得受保护 ESM namespace，也可从 `node:process`
重获 `process.exit`；现有 static/dynamic import 与 declaration-identity consumer guard 均返回
空问题集。P2 是 `docs/project-status.md` 同时声称提交态 14/14 已完成和仍待执行。

审计 B 的结论是 `INVALID`，不是 `CLEAN` 或代码 `BLOCK`：独立 worktree 没有 workspace
依赖，正式 `stage09a:check` 在第 1/14 步以 `tsx: command not found` 失败，终态为
0 PASS / 1 FAIL / 13 SKIP。其后单项动态结果不能补成正式全链。由于 A 已给出确定性 P1，
总控不在旧候选上浪费一次 B 重跑，先整改共同根因；下一轮 B 任务书必须明确允许缺依赖时
先执行一次 `pnpm install --frozen-lockfile`。

## 2. 根因与闭集策略

M5.13 封闭了 `ImportExpression` 和多身份说明符，但把“模块取得方式”误等同于 import
语法。Node.js v24.18.0 默认允许 `createRequire(import.meta.url)` 同步加载 ESM；
`process.getBuiltinModule()` 又能不经 import 取得同一 builtin namespace。只追踪载入后的 alias、
holder、reflection 和 namespace 会继续形成开放枚举。

当前 production `scripts/**/*.mjs` 与 `infra/docker/**/*.mjs` 没有合法 `node:module`
消费者，因此本轮采用能力根闭集：production surface 不允许同步 module-loader 根能力。
这不是按变量名做文本扫描；判据绑定 TypeScript 解析后的 Node 声明身份：

- static import/re-export 若解析到 `@types/node/module.d.ts`，固定拒绝；
- 任一 identifier/property 若解析到 `module.d.ts#createRequire` 或
  `process.d.ts#getBuiltinModule`，固定拒绝；
- computed property 与 reflection 从持有者的类型解析相同声明身份；
- 相同名称的本地函数和对象是明确允许的反向对照。

因此 named alias、namespace/default import、computed access、destructuring、`Reflect.get`、
higher-order pass-through、legacy `module` re-export、`process.getBuiltinModule()` 和
`createRequire()` → `require(esm)` 共用一个固定安全原因。未来若 production 确实需要
`node:module`，必须先登记窄化导出、消费者位置、settlement 边界与独立反例，不能直接放宽
整个 module namespace。

## 3. Identity grammar mutation 闭合

原来的复合正则拆成九条冻结规则：empty、query、fragment、percent、backslash、Unicode
White_Space、Unicode Cf、absolute path、non-`node:` scheme。每条规则有一个只归属于自身的
mutation witness；删除该规则后 witness 必须立刻变为未拒绝。端到端 static import、dynamic
import、re-export 矩阵同时增加 backslash、POSIX/Windows absolute、tab、U+200B、HTTPS 与
custom scheme；普通 relative、bare package、scoped package 和 `node:` 保持允许。

这使“当前实现能拒绝”与“删除任一校验仍会被测试发现”成为两份独立证据，不再用一组五项
样例概括九条生产判据。

## 4. 回归证据

修复前，新增两条 loader-capability 回归精确为 31 PASS / 2 FAIL：普通 production
consumer 取得 `createRequire` 未被拒绝，protected entrypoint 经同步 loader 重获
`process.exit` 也未被拒绝；扩展后的 identity grammar 矩阵保持通过，证明失败不是接线噪声。

修复后固定 Node.js `v24.18.0`：

- production guard：34/34；
- 全部 scripts tests：214/214；
- loader acquisition 覆盖 14 种 alias/namespace/computed/destructure/reflection/holder 形态；
- 相同名称的本地声明保持允许；
- 九条 identity grammar rule 的独立 witness 全部成立。

## 5. 提交态门禁与状态纪律

新增本任务书会改变 committed tracked-file baseline。文档提交后必须先从步骤 1 串行运行
`pnpm stage09a:check`；若登记完整性按旧计数 fail closed，只能机械同步实际计数、追加提交，
再从步骤 1 重跑，不能把失败前缀或此前 M5.13 的 14/14 冒充当前候选证据。

完整 14/14、Markdown links、diff check 与零残留都通过后，才能把状态改成
`committed-candidate gate PASS, pending independent A/B review`。之后仍需创建两个全新、
独立、用户可见的 A/B 审计任务；不得复用 M5.13 任务，不得自行标记 M5 Accepted、09A Pass
或远端 CI PASS，不 push、不 merge、不创建 PR。
