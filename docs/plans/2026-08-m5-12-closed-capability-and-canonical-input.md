# M5.12 封闭能力入口与 canonical report input 整改任务书

- 日期：2026-08-21
- 实施基线：`8bfbf547e0303e1f9a3c6cf259496cfb9d47aa90`
- 代码实现落点：`d4bdf2b33176a6c087ec1a66a691b166f5f1d447`
- 状态：Implementation complete — committed-candidate gate PASS, pending independent A/B review；M5 未 Accepted；阶段 09A 未 Pass
- 范围：M5 production capability 的模块入口闭包、`process`/global capability、Audit-B canonical input 与 mutation 判别力

## 一、进入条件与裁定

M5.11 候选 `8bfbf54` 的两个全新独立审计均有效：审计 B 为 **CLEAN**，正式
Audit-B 恰好一次、0 retry，并对精确候选取得本地 14/14 与零残留；审计 A 为
**BLOCK**，确认 4 个 P1 与 1 个 P2。动态主路径通过不能覆盖静态能力逃逸，因此总控
裁定 M5.11 继续 BLOCK，不标记 Accepted。

四个 P1 去重为三组共同根因：

1. 受保护模块的身份恢复只接受字面量 dynamic import，且 production module 清单只覆盖
   一层目录；`import("./run-stage09a-check.mjs" + "")` 能取得真实能力但不进门禁。
2. `process.exit` guard 只从 canonical `process` identifier 播种，允许从
   `globalThis["pro" + "cess"]`、拼接 `node:process` dynamic import 或
   `process.getBuiltinModule()` 重新取得能力；同一 mutant 又把 namespace import 与七类
   value flow 混在一起，弱化核心扫描后仍会因错误理由绿灯。
3. report builder 在函数参数处解构任意对象；accessor 与 Proxy trap 会在 canonical scalar
   validator 之前执行，并可返回合法 primitive 形成 PASS。`-0` 同时被 nonnegative
   safe-integer predicate 接受、再被 JSON 改写为 `0`。

## 二、架构整改

### 2.1 production module 与 module specifier 同时闭合

production module surface 由 canonical Git tracked set 递归覆盖 `infra/docker/**/*.mjs` 与
`scripts/**/*.mjs`，明确排除测试 fixture 和 `scripts/tests`，并用嵌套生产入口
`infra/docker/postgres/no-ctty.mjs` 作正向守卫。dynamic import specifier 先通过同一
immutable-const/literal-concatenation evaluator 求值：若能静态得到受保护模块，固定按该模块
能力拒绝；若不能静态求值，则整个 production dynamic import 直接 fail closed。动态模块名
不再成为静态门禁的未知盲区。

### 2.2 从 identifier 播种改成封闭的 process/global 使用面

受保护 CLI 与共享模块只允许已经逐项评审的 `process` 属性：argv、env、execPath、
exitCode、kill、on、pid、removeListener、stderr、stdout、versions。`globalThis` 只允许取得
三个已经在聚合器冻结的 timer primitive，并允许同一 primitive 的精确 `bind(globalThis)`。
把 process/global 对象本身转交、取得未登记属性、从 global 重新取得 process、拼接
`node:process` dynamic import、`getBuiltinModule("node:process")` 与 constructor 链均固定
拒绝。该策略是受保护模块的工程语法闭集，不宣称为任意 JavaScript 的形式化沙箱。

### 2.3 Audit-B 只接受 opaque receipt 与位置固定 primitive

公开 report 入口不再接受 object-shaped environment record，也不接受调用方提供的 gate、
invocation 或 retry。唯一入口为：opaque `runReceipt` 加七个位置固定的环境 primitive；
receipt projector 在模块内部取得 gate/signal/调用会计，再交给私有 report builder。对 receipt
使用私有 WeakMap identity，不读取调用方属性；candidate/Node/clean 值只做 primitive type 与
canonical pattern 判定。计数策略显式拒绝 `-0`。

### 2.4 mutation 一形态一理由

namespace import 单独断言 namespace 固定拒绝；wrapper、callback、holder、computed、
destructure、builder、projector 七种 value flow 分别构造只有 named import 的独立 mutant，
且每条必须精确命中 declaration-identity drift，不允许 namespace/wrong-reason 代偿。拼接
dynamic import、非静态 specifier、递归 production surface 与四类 process 重获路径都有独立
注册回归。

## 三、修复前后证据

四条新增窄反例先在 `8bfbf54` 真实运行并得到 4 fail：拼接 dynamic import 未命中、
`globalThis` process 重获未命中、顶层 accessor 执行一次、`-0` 得到非 canonical 报告。
整改后同一组与扩展矩阵全绿：

- Audit-B/schema/receipt：16/16；
- production guard mutation：28/28；
- scripts tests：208/208；
- Markdown links：76 files / 311 local links（任务书进入 Git 后的 committed candidate 实测）；
- `node --check` 与 `git diff --check`：通过。

提交态反馈候选 `866cf11` 已从步骤 1 完成 `pnpm stage09a:check` 14/14、Markdown
links 76/311、Git clean 与 scoped 零残留复核。最终证据仍只承认对应最终提交后的重新实测，
本任务书不把本地门禁写成远端 GitHub Actions PASS。

## 四、范围与下一门禁

代码改动只涉及 `scripts/stage09a-audit-b.mjs`、Audit-B wrapper 和两份 scripts 回归；不修改
contracts、API/client 业务、migration、Dockerfile、Compose/Secret contract、M3A/M3B/M4
动态实现、lockfile、依赖例外或 GitHub Actions workflow。文档同步根 README、infra README、
project-status、阶段 09A 总计划、ADR-0006、导航与本地项目看板。

最终 committed candidate 完整门禁全绿；下一步仍是两个**全新、用户可见、彼此独立**的
只读审计会话：A 禁止 Docker，B 独占 Docker；不得复用 M5.11 审计会话。任一路确认 P0/P1，
M5.12 继续 BLOCK。本轮不 push、merge、建 PR，不自行标记 M5 Accepted、09A Pass 或远端
CI Pass。
