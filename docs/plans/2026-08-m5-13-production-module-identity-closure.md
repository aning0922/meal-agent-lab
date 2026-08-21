# M5.13 production module identity 闭包整改任务书

- 日期：2026-08-21
- 实施基线：`22b30eab074eea3d9d6ee0810f3c5e405fff0111`
- 代码与回归落点：`fe0cd1002a3ec365c134c95566d27e0de71c8812`
- 状态：Implementation complete — narrow gates PASS, committed-candidate full gate pending；M5 未 Accepted；阶段 09A 未 Pass
- 范围：M5 production module surface 的 `ImportExpression` 参数文法、模块身份闭包与 `node:process` 能力重获

## 1. 审计输入与总控裁定

M5.12 的审计 A、B 都因平台 cybersecurity safeguard 以 `systemError` 终止，没有写出
正式最终报告，因此两项任务都不能记为有效 CLEAN/BLOCK 审计。不过，两路任务在终止前
分别从精确候选、独立 worktree 与 Node.js `v24.18.0` 复现了同一个确定性反例：

```js
const hiddenCore = await import('./run-stage09a-check.mjs', {})
const stolenCore = Reflect.get(hiddenCore, 'runStage09aCheck')

const runtimeProcess = await import('node:process', {})
const stolenExit = Reflect.get(runtimeProcess, 'exit')
```

两条生产 guard 的问题列表都为空，Node 运行期取得的 capability 均为函数。总控据此将
`22b30ea` 判为 BLOCK；该裁定依赖可重复反例，不把平台终止或中间评论冒充正式审计报告。
审计 B 被终止后遗留的正式聚合器由总控向精确 PID 发送 TERM，经自身 cleanup 协议收敛；
候选/审计工作树保持干净，B 自建 Docker 资源与相关 PGID 均归零。

## 2. 根因

M5.12 在同一个门禁文件里维护了两份
`ImportKeyword && arguments.length === 1`：一份保护 production capability module，另一份
保护 `node:process.exit`。Node 24 支持第二个 import options 参数，因此两份判断同时漏掉
双参数调用。

进一步按 Node 24 取得地面真相后，确认“允许静态可求值的 dynamic import”本身会打开第二套
模块身份系统。同一受保护模块可通过 `?query`、`#fragment`、百分号编码、绝对 `file:` URL，
甚至由 `data:` 模块再导出；五种形态都能在运行期取得 `runStage09aCheck`。继续逐个规范化
说明符不能封闭 `data:` 中转，因此本轮不增加分隔符特例。

## 3. 实现边界

1. `dynamicImportModuleSpecifier()` 是唯一 `ImportExpression` 入口；合法参数数量固定为
   1—2，第一个参数必须是 immutable const / literal concatenation 可求值的字符串。
2. production module surface 当前没有合法 dynamic import，因此任何静态可求值的 dynamic
   import 也固定拒绝；非静态说明符与非法参数数量保持独立 fail-closed 理由。
3. capability registry 与 protected `node:process` guard 共同消费该入口；后者独立拒绝
   非静态 module specifier，双参数 `node:process` 不再成为别名入口。
4. 静态 import/re-export 的身份文法只接受普通 relative、bare-package 与 `node:` specifier；
   `data:`/`file:`/其他 URL scheme、绝对路径、query、fragment、percent encoding、backslash
   与空白/format 字符固定拒绝。错误只含可信文件标签与固定类别，不回显说明符。
5. import options 不是不透明区域：第二参数里的受保护 capability 使用仍由完整 AST 遍历命中。

这是 production scripts/infra 的工程语法闭集，不宣称为任意 JavaScript 的形式化沙箱；
M5.12 已登记的动态代码生成等范围外边界不因本轮扩大。若未来确需 production dynamic
import，必须先登记精确消费者、模块身份协议与反例，再修改闭集。

## 4. 回归与判别力

新增三个注册测试：

- 双参数 protected module + `Reflect.get`，以及双参数非静态说明符；
- query/hash/percent/file/data 五种身份在 dynamic import、static import 与 re-export 三个
  视图逐格拒绝，并断言 sentinel 不进入问题文本；
- 双参数 `node:process` + `Reflect.get`，以及 import options 内的 `process.exit`。

另锁定 0 参数和 3 参数两个非法 arity。修复前两条原始审计反例和模块身份矩阵真实转红；
修复后 production guard 为 31/31，全部 scripts tests 为 211/211。将共享入口重新收窄为
单参数、删除 dynamic-import 总禁令，或删除静态 import/re-export 身份判据，都会分别使对应
注册反例转红，不能由 declaration drift 等无关理由代偿。

## 5. 状态纪律

代码与窄门禁完成不等于最终候选证据。本轮文档提交后必须从步骤 1 串行重跑
`pnpm stage09a:check` 14/14、Markdown links、`git diff --check` 与 scoped 零残留；只有该
提交态全链通过后才能把状态改为 committed-candidate gate PASS。随后仍需两个全新、独立、
用户可见的 A/B 审计任务；任一路确认 P0/P1 都继续 BLOCK。不得自行标记 M5 Accepted、
09A Pass 或远端 CI PASS，不 push、不 merge、不创建 PR。
