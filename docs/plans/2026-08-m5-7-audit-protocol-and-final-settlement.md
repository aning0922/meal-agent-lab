# M5.7 审计协议与最终 settlement 收敛任务书

- 日期：2026-08-20
- 实施分支：`claude/stage-09a-m5-gates`
- 输入候选：`d90a81eb95045800bba71fa3a0cde89d916c3b97`
- 状态：Implementation complete — pending deterministic full gate and independent A/B review；M5 未 Accepted；阶段 09A 未 Pass
- 写入纪律：总控单 writer；只追加本地提交，不推送、不合并、不创建 PR

## 一、为什么不是继续补审计提示词

M5.6 审计 A 给出 BLOCK；动态审计 B 在平台侧触发 cybersecurity `systemError`，没有
形成有效 CLEAN/BLOCK 报告。总控对 A 的最小反例和 B 已完成的定点证据独立复核后，
把问题归并为两类：

1. 生产 guard 的消费者集合、main guard、直接 await 和 `process.exit` 能力仍有一部分
   依赖测试文件中的手写/文本判据；dead branch、假 main guard、重复路径和别名能力可以
   让证据与真实生产出口分离。
2. 动态 B 每次自由组合完整链、重试和自造高风险进程/容器探针，既重复消耗资源，又
   容易触发平台安全拦截。那是审计执行协议缺失，不是多开几个会话能解决的问题。

本轮因此同时收敛生产结构与审计入口。它不减少 A/B 独立性：A 仍只读审代码与 mutation
判别力；B 仍在独立新会话独占 Docker，但动态证据只能由一条受控命令产生。

## 二、必须关闭的生产结构

1. `source-direct` 必须是源文件顶层的单变量声明，initializer 必须直接是目标 call 的
   `await`；不能藏在 conditional、短路表达式、`.catch()` 或 wrapper 中。
2. `main-guard-direct` 必须精确匹配顶层
   `process.argv[1] === fileURLToPath(import.meta.url)`、无 else，且 then block 中是直接
   `await runSignalSettledCli(...)` 语句。
3. consumer registry 与 protected-entrypoint registry 都必须匹配精确路径集合、数量与
   唯一性；重复一个入口不能掩盖漏掉另一个入口。
4. protected entrypoint 对 `process.exit` 的 property/element access、process alias、
   destructuring 和 `Reflect.get` 均转红，不能再靠 `process.exit(` 文本正则。
5. cleanup settlement 的两个 native event-loop turn 是协议常量：第二 turn 单独失败必须
   fail closed；`turn < 1` mutant 必须被定向 oracle 杀死。
6. delivered signal 的 handler settlement 是调用方的最后所有者。普通
   `runSignalSettledCli` 在 cleanup 完成并重投同名信号前不得恢复；重投 primitive 失败只
   给固定非零结论。

## 三、动态审计 B 的唯一入口

```bash
pnpm stage09a:audit-b -- --report m5-<candidate>-b.json
```

协议固定为：

- 精确读取 `.node-version`，Node 不相等时不启动聚合链；
- 工作树不干净时不启动聚合链；
- 14 步顺序只从 `stage09a-gate-registry.mjs` 读取，与真实聚合器共用一份事实源；
- 每次命令恰好启动一次 `run-stage09a-check.mjs`，无 retry、无续跑、无第二份完整链；
- JSON 报告只登记闭集原因、可信 step id、exit/signal、候选 SHA 与固定版本，不复制
  外部原始错误；
- 报告只以 exclusive publication 写入 `.local/audit-reports/`，已有同名报告即拒绝；
- SIGINT/SIGTERM/SIGHUP 只转交真实聚合器，等待它完成受控子树 cleanup 后发布一份
  interrupted 报告，再重投同名信号；
- 报告是**动态证据**，不是 CLEAN/Accepted 裁定，也不冒充远端 CI run。

审计 B 的新会话不得再启动子智能体、不得自行重跑完整链、不得新增 custom security
probe。它只核对候选、运行上面一条命令一次、读取结构化报告与最终零残留，然后基于
既定任务书给出 CLEAN/BLOCK。若平台在命令外部直接终止会话而没有报告，该次审计无效，
总控只允许创建一个新的 B 会话消费同一候选；不得在原会话内无限重试。

## 四、回归与判别力

- dead conditional、假 main guard、`.catch()`、非直接 await、重复 registry path；
- `process.exit` direct/bracket/alias/destructuring/Reflect 能力；
- 第二 turn 失败与 one-turn mutant；
- signal cleanup 未完成前的 `RETURNED` sentinel；
- aggregate settlement mutant 必须真实送进声明/位置 checker；
- audit-B transcript 缺 step、乱序、重复 final PASS、零退出但不完整、超长 framing；
- Node mismatch、dirty worktree、非可信失败文本与一次调用/零 retry 报告形状。

固定 Node.js `v24.18.0` 的 scripts tests 当前为 **182/182**。完整 14 步门禁与最终候选
报告必须在提交后从步骤 1 串行执行；未取得该报告前，本轮状态仍是待门禁，不能启动
独立 A/B 审计。

## 五、范围、状态与下一步

允许修改：M3B shared subprocess settlement、M5 aggregate/registry/测试、审计 B 执行
入口、状态文档与本地看板。不得修改 contracts、API/client 业务实现、数据库迁移、
Compose 产品拓扑、PostgreSQL bootstrap/SQL、Secret 格式或 M1—M4 的 Accepted 语义。

只有最终 committed HEAD 的 `stage09a:audit-b` 报告为 pass、docs links、diff check 与
零残留都通过后，才创建两个**全新用户可见 Codex 会话**：A=静态只读且禁止 Docker；
B=动态只读、独占 Docker、只运行一次 `stage09a:audit-b`。两路都 CLEAN 后仍只进入总控
Accepted 裁定；M5 Accepted、09A Pass、push/merge 与远端 CI 仍分别需要证据和授权。
