# M5.8 声明身份与动态审计证据闭合任务书

- 日期：2026-08-20
- 基线：`174ff45b6b51749a7427445a558b1d7fc181ed09`
- 实现提交：`de62e5e`
- 状态：Implementation complete — pending independent A/B review；M5 未 Accepted
- 范围：M5 production guard 的声明身份/入口发现，以及 Audit-B 单次动态证据协议

## 一、审计输入与总控裁定

M5.7 审计 A 的报告
`.local/audit-reports/m5-174ff45-a.md` 是有效 `BLOCK`，确认七项 P1：main guard
使用文本而非声明身份、backup consumer 未绑定精确 owner、新 CLI 无法被 registry 反向发现、
`node:process` named import 可取得 `process.exit`、Audit-B 的调用计数为硬编码、报告未绑定
运行前后 HEAD/clean 状态、signal ownership 未覆盖 wrapper 全生命周期。

审计 B 的报告 `.local/audit-reports/m5-174ff45-b.md` 不作为候选缺陷归因：任务书错误地把
绝对路径传给只接受 basename 的 `--report`，生产入口按既有协议在任何门禁或 Docker
启动前 fail closed。该执行只能证明审计派工无效，不能把 0/14 记为候选动态 `BLOCK`。
M5.8 把正确调用形状写入仓库，避免再次由人工拼接参数：

```bash
pnpm stage09a:audit-b -- \
  --expected-head <40-hex-candidate-sha> \
  --report m5-<candidate>-b.json
```

`--report` 仍只接受 basename，报告固定写入 `.local/audit-reports/`；这是目录穿越防线，
不是缺陷。

## 二、结构门禁整改

### 2.1 main guard 与 owner

- `fileURLToPath` 必须解析到 `node:url` 的真实 export declaration；同名本地函数不再能
  冒充入口判断。
- `process.argv[1]` 必须解析到 Node ambient `process` 的声明；`import.meta.url` 的 AST
  形状必须精确。
- backup handoff 调用绑定精确 owner chain `beforeRemove → performBackup`，不是“任意最近
  函数”。runtime scratch 的六个调用同样绑定 `scanImage`。

### 2.2 从生产可达性反向发现

mutation gate 先从 canonical Git tracked 的 `infra/docker/*.mjs` 与 `scripts/*.mjs` 生产
模块集合建立 TypeScript program，再按目标 declaration identity 反向枚举调用：

- 每个 target 的已发现 `path × count` 必须与 registry 相等；
- protected CLI 集合由 `runSignalSettledCli` 的生产引用与根 `stage09a:*` package scripts
  共同派生；
- 新增但未登记的 CLI 会同时让 consumer registry 与 protected-entrypoint gate 转红，
  不再依赖测试中的第二份手写 expected list。

共享库 `m4-lifecycle.mjs` 单列为 protected module；它不是 CLI，不再混入 entrypoint
集合。

### 2.3 `process.exit` 能力

protected 文件使用 TypeScript symbol identity 追踪 ambient `process`、变量 alias、default/
namespace `node:process` import；named import `exit` 在取得能力时即失败。property、element、
destructuring 与 `Reflect.get` 既有形态继续保留。门禁明确覆盖：

```js
import { exit as exitNow } from 'node:process'
```

## 三、Audit-B 动态证据整改

### 3.1 候选与调用会计

- `--expected-head` 为必填 40 位 SHA；preflight HEAD 必须精确相等。
- 报告同时记录 `candidateHeadBefore/After`、`worktreeCleanBefore/After`；post-run drift 固定
  为 `repository-state-drift`。
- `invocationCount` 在真实 aggregate 调用前递增，`retries` 从实际计数派生。Node mismatch、
  dirty worktree 或 preflight signal 的 `gate-not-started` 报告为 `0/0`，不再伪造 `1/0`。
- 报告继续固定 `remoteCiVerified=false` 与 `verdict=evidence-only-not-acceptance`。

### 3.2 wrapper 全生命周期 signal ownership

INT/TERM/HUP handlers 在参数和 Git preflight 前安装，贯穿 aggregate close、post-run Git
复查和 exclusive report publication。信号在 child attach 前到达会阻止 aggregate 启动；
在 child 活跃时到达会转发同名信号；`child.kill()` 返回 false 或抛出时固定失败并尝试强制
结束 child。PASS 报告发布后仍保留两个 event-loop checkpoint；若此窗口捕获 signal，
只撤回本轮精确 inode，再发布 `audit-signaled` 的失败证据。最后才卸载 handlers 并重投
同名信号。任何底层异常文本都不进入报告或诊断。

## 四、修复前/后回归

| 反例 | `174ff45` | M5.8 |
| --- | --- | --- |
| 本地假 `fileURLToPath` | 假绿 | declaration identity 拒绝 |
| backup 调用移入错误 owner | 假绿 | exact owner chain 拒绝 |
| 新 CLI 调用 `runSignalSettledCli` 且 named-import exit | 两个 registry 均看不见 | consumer + entrypoint + exit 三路拒绝 |
| `import { exit as exitNow } from 'node:process'` | 假绿 | 拒绝 |
| gate 未启动 | 报告硬写 `invocationCount=1` | `0/0` |
| 运行后 HEAD/dirty 漂移 | 不复查、仍可 PASS | `repository-state-drift` |
| preflight / publication signal | handler 不在场 | INT/TERM/HUP 全生命周期持有 |
| child signal primitive 返回 false | 可先生成 PASS | fixed failure，不可形成 PASS |

固定 Node.js `v24.18.0` 的 scripts tests 当前为 **191/191**，其中 production guard
mutation 为 18/18、Audit-B 协议为 11/11。最终候选仍必须从头串行通过唯一 14 步
`stage09a:check`、docs links、`git diff --check` 和 scoped 零残留；这些证据不代替两份
全新、互不读取的独立 A/B 只读审计。

## 五、验收边界

M5.8 只收敛本任务列出的 declaration/registry/Audit-B evidence 根因。不改 contracts、
API/client 业务、migrations、Compose 产品拓扑、M3B/M4 动态实现、lockfile 或安全例外。
本地 14/14 不等于 GitHub Actions 远端 run；两路审计 CLEAN 也只进入总控 Accepted 裁定，
不得自行标记 M5 Accepted 或 09A Pass。
