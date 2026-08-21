# M5.11 能力引用闭包与 Audit-B 静默边界整改任务书

- 日期：2026-08-21
- 实施基线：`d8e0e9b9ebe71c5f5c362f0e3e00015a4ed038d7`
- 状态：Implementation complete — pending committed-candidate gate and independent A/B review；M5 未 Accepted；阶段 09A 未 Pass
- 范围：M5 生产能力引用闭包、Audit-B scalar/stdio/receipt 边界、聚合器退出能力与 post-fork PGID 所有权

## 一、进入条件与裁定

M5.10 候选 `d8e0e9b` 的两个全新独立审计均为 **BLOCK**。审计 A 确认 2 项 P1；
审计 B 确认 4 项 P1，其中能力消费者闭包与审计 A 是同一根因。审计 B 的正式
Audit-B 运行因独立 worktree 缺少 `node_modules`，在第 1 步以 `tsx` 不存在失败，
只能记为基础设施无效的 0/14，不能作为候选 finding，也不能冒充 14/14 证据；其余
四项 P1 来自可独立复现的纯 Node/结构探针，仍然有效。

去重后本轮处理五个架构根因：

1. declaration-identity 扫描只看 identifier callee，无法覆盖 namespace/computed、
   解构、包装、回调和普通 value flow；
2. schema v3 对 candidate 做隐式字符串强制转换，负 invocation/retry 也会进入报告；
3. Audit-B 继承共享核心与子命令 stdout/stderr，所谓固定发布输出并不成立；
4. `process.exit` 门禁不能沿 immutable `const` key 与 capability value flow 判定；
5. detached controller fork 后先执行可抛 `closeSync`、后登记 PGID，留下无 owner 窗口。

## 二、架构整改

### 2.1 从“调用形状”升级为“能力引用闭包”

生产 guard 以 TypeScript declaration identity 找到每个受保护声明的**全部运行时引用**，
而不是只统计直接 identifier call。命名 import 的声明位置不算消费；其余 alias、参数、
回调、wrapper、projector、computed/property access 都必须进入精确 registry，或由门禁拒绝。
namespace import、dynamic import 和 re-export 只要指向含受保护能力的模块，直接固定失败。

回归同时覆盖 namespace/property/computed、解构、identity wrapper、callback、report
builder/projector 和跨文件转交。把任一形态放进 tracked 生产模块都必须以 capability
consumer drift 的指定理由转红；不能依靠未捕获异常或不相关失败证明判别力。

### 2.2 canonical scalar 与 receipt 时效

candidate SHA 只接受 primitive string，再运行 canonical 40-hex validator；不执行
`toString`、`Symbol.toPrimitive` 或 `toJSON`。invocation/retry 复用同一 nonnegative
safe-integer predicate，非法值只投影为 `null`。hostile object 不能成为 PASS，也不能把
调用方文本带进 JSON。

receipt ledger 额外绑定签发时的 aggregate invocation generation。签发后若又发生一次
核心调用，旧 receipt 立即失效；因此“取得合法 receipt 后再偷偷执行一条额外 aggregate”
不能沿用旧证据发布成功报告。

### 2.3 Audit-B 静默执行边界

共享核心内部定义两个私有 presentation capability：human 模式继承现有人类输出；audit
模式丢弃核心 diagnostic，并把每个 gate child 的 stdio 固定为 `ignore`。公开
`runStage09aCheck()` 不接受调用方伪造的 audit sink；只有模块私有 identity 能进入静默模式。
Audit-B CLI 因此只允许输出 wrapper 自己的固定 publication 行，核心、runner 和子进程
stdout/stderr 都不能穿透。

动态回归用一条真实 fake gate 同时向 stdout/stderr 写 sentinel，证明 audit 核心两路字节
都为空；另证明 receipt 在第二次 aggregate invocation 后不可再读取。

### 2.4 `process.exit` capability value flow

guard 的 constant evaluator 沿 immutable `const` declaration 与 literal concatenation 解析
computed key，因此 `const key = "ex" + "it"; const exitNow = process[key]; exitNow(0)`
与直接调用同样被拒绝。
canonical `process` 对象本身不得被传参、存储、包装、解构或经 `Reflect.get` 取走；只允许
精确评审过的 property access，以及既有 `process.kill.bind(process)` 这类已登记上下文。

### 2.5 fork 成功即取得 PGID 所有权

controller spawn 一返回，就先建立并登记 lifecycle handle，再执行任何可能抛出的 fd close。
若 close primitive 失败，固定归为 aggregate/lifecycle/ownership failure，并使用已经登记的
PGID 完成 TERM → grace → KILL → bounded ESRCH。测试记录真实 controller PGID，令 close
primitive 抛错，要求固定 exit 1、安全输出、没有后续步骤且该组有界到达 ESRCH。

## 三、回归与反馈门禁

固定 Node.js `v24.18.0`：

- scripts tests：**203/203**；
- Audit-B/schema/receipt：16/16；
- 聚合器与 settlement：45/45；
- production guard mutation：23/23；
- Markdown links：75 files / 308 local links；
- `node --check` 与 `git diff --check`：通过。

提交前反馈用的 `pnpm stage09a:check` 已从第 1 步串行跑完 **14/14**，其中 topology
mutation 45/45、runtime image 为 1 baseline + 18 built + 2 static-only mutations、
local-test 75/75、targeted 69/69、signal 5+6、fresh smoke、八份 Secret identity、生命周期
和恢复演练均通过。该结果只用于实现反馈；**最终候选证据必须在本任务书和实现提交后，
对精确 committed HEAD 从第 1 步重新运行**，不得把本段冒充候选验收。

## 四、范围、审计与状态边界

本轮受控修改 M5 聚合器、Audit-B、production guard 测试，以及 M3B targeted suite 中两处
同一受保护模块的 dynamic import 接线；不修改 contracts、API/client 业务实现、数据库迁移、
Dockerfile、Compose/Secret contract、M3A signal、M3B/M4 动态语义、lockfile、依赖例外或
GitHub Actions workflow。

形成 committed candidate 且完整门禁全绿后，下一步是两个**全新、用户可见、互相独立**
的只读审计会话：A 禁止 Docker，B 独占 Docker。B 的 worktree 必须在消费唯一正式
Audit-B invocation **之前**确认固定 Node 与依赖可用；缺依赖应直接判任务基础设施无效，
不得消耗候选的唯一报告后再补装重跑。任一路确认 P0/P1，候选继续 BLOCK。

本轮不 push、merge、建 PR，不写远端 CI PASS，不自行标记 M5 Accepted 或 09A Pass。
