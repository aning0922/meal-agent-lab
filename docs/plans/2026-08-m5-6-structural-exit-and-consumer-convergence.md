# M5.6 结构化退出与生产消费者收敛任务书

- 日期：2026-08-20
- 实施分支：`claude/stage-09a-m5-gates`
- 输入候选：`72b75db00434176667983d247202580849f0f6e5`
- 状态：Implementation complete — pending independent A/B review；M5 未 Accepted；阶段 09A 未 Pass
- 写入纪律：总控单 writer；本轮只追加本地提交，不推送、不合并、不创建 PR

## 一、为什么进入架构级整改

M5.5 两路独立审计均为 **BLOCK**。正常路径与多数反例已经通过，但剩余 P1
不是再补一个字符串或一个命令状态判断可以关闭的局部漏点：

1. `m5-production-guard-registry.mjs` 只登记 `path + anchor + count`；把真实调用
   原样移进 `if (false)` 后，anchor 数量不变，门禁仍绿。它证明的是文本存在，
   不是生产出口真的受 guard 支配。
2. runtime scratch 记录以 `id: null` 开始时，cleanup 能从 name inspect 学到
   immutable ID，却没有把该 ID 带进最终复查；name 消失就可能形成假绿。
3. cleanup 后 signal delivery barrier 直接调用捕获的 `setImmediate`。同步异常会让
   原始异常越过固定诊断边界。
4. backup、restore、smoke、两个 M4 drill 与聚合器仍有 `process.exit()` 或各自的
   普通退出接线；usage/error 分支没有被同一个最终裁决能力结构性包住。
5. 候选形成后又新增计划文件，导致 committed tracked-file 基线从 358 变 359；
   先前 14/14 运行不再是最终 HEAD 的完整证据。

因此 M5.6 的目标不是增加 anchor，而是让最终裁决成为唯一可表达的生产出口，
再由声明身份、AST 位置与动态反例共同证明。

## 二、必须先红的反例

实施前在 `72b75db` 固定以下反例：

1. runtime scratch `id:null`：name inspect 返回受控 immutable ID，删除命令返回
   成功但 immutable ID 仍存在、name 已消失；必须拒绝为 immutable identity 未消失。
2. signal delivery primitive：两次 event-loop turn 的任一次 primitive 同步抛出
   带 sentinel 的异常；最终只能固定 exit 1，stderr 不得含 sentinel 或 stack。
3. protected CLI 直接退出：backup、restore、smoke、lifecycle、restore drill 与
   stage09a aggregator 的普通/usage 分支不得出现 `process.exit()`。
4. dead consumer：把每个已登记生产调用原样放入 `if (false)`，声明身份与文本均
   不变；门禁必须因其不再处于规定的直接可达 AST 位置而转红。
5. mutation 判别力：删除统一 CLI wrapper、把 runtime settlement 移入死分支、
   或改写最终 aggregate settlement 时，必须按对应 guard ID 失败，不能靠未捕获
   异常或 anchor 漂移冒充成功。

## 三、目标结构

### 3.1 一个普通 CLI 出口

`m3b-subprocess.mjs` 提供 `runSignalSettledCli(operation)`：

- operation 只返回 `0..255`；未知异常折叠成固定失败；
- 普通退出只能经 `settleCliExitCode` 在两次受控 event-loop turn 后发布；
- 任一 turn primitive 失败只产生固定诊断和 exit 1；
- 已登记信号仍由 signal handler 独占 cleanup 与同名信号重投；
- protected CLI 不再直接调用 `process.exit()`。

backup、restore、smoke、lifecycle 与 restore drill 的 main guard 都必须以一个
**直接的顶层 await** 调用该 wrapper；业务函数返回 exit code，不自行终结进程。
stage09a aggregator 保留自己的 PGID/ownership 协议，但最终发布同样只能经过一个
直接顶层 `settleAggregateProcess` 调用。

### 3.2 生产消费者按声明身份与 AST 位置登记

registry 不再保存可满足于注释/死分支的 anchor count。每个 consumer 登记：

- consumer 文件；
- guard 的真实导出声明（文件 + export 名）；
- 所在函数或 main guard；
- 允许的直接 AST 位置与精确调用次数。

门禁解析 JavaScript AST，解析本地声明与 named import 的真实来源，要求 call 是
规定函数体或 main guard 的**直接语句**。额外 mutation 把同一调用移入
`if (false)`；若仍绿，门禁自身失败。

### 3.3 runtime ownership 学到即持有

`settleOwnedScratchContainer` 用一个本地 immutable identity 变量贯穿观察、验证、
删除与最终复查：初始 record ID 与由 name inspect 学到的 `owned.Id` 都必须进入
最终 immutable-ID absence 判定；tracking 只能在 immutable ID 与 mutable name
两个 locator 都得出可信 absent 后退休。

## 四、证据发布纪律

1. 先完成代码、回归、文档和 committed baseline 更新；之后不再新增 tracked 文件。
2. 形成最终候选提交后，从步骤 1 串行运行固定 Node.js `v24.18.0` 的
   `pnpm stage09a:check`，必须 14/14。
3. 同一最终 HEAD 再运行 `pnpm docs:links:check`、`git diff --check`、工作区与
   Docker/PGID/临时目录零残留检查。
4. 任一门禁红时不得写 Implementation complete，不得启动独立审计。
5. 本地全绿不等于远端 CI PASS；没有真实 run URL/ID 时仍只写 workflow 已配置。

## 五、范围与冻结面

允许修改：M5 runtime settlement、M3B shared CLI settlement、五个受保护 CLI、
stage09a aggregator、production guard registry/测试、M5 状态与证据文档、被计数的
committed baseline。不得修改 contracts、API/client 业务实现、数据库迁移、Compose
业务拓扑、PostgreSQL bootstrap/SQL、Secret 格式、M3B/M4 的 Accepted 产品语义。

## 六、验收口径

本轮完成只可写：**M5.6 Implementation complete — pending independent A/B
review**。只有两个全新独立只读审计都 CLEAN，且总控另行裁定后，才可考虑 M5
Accepted；阶段 09A Pass、push/merge、远端 CI 仍是后续独立授权与证据。

## 七、实现与候选证据

- 结构实现提交：`b2780aa`；committed evidence baseline 与文档起点：`2e2af96`。
- 固定 Node.js `v24.18.0` 的 scripts tests：**173/173**。
- `2e2af96` 从步骤 1 串行执行 `pnpm stage09a:check`：**14/14**；总耗时
  936 秒。包含 45/45 Compose 变异、runtime image 1 baseline + 17 built +
  2 static-only mutations、75/75 local-test、69/69 targeted、5+6 signal、fresh
  smoke、八份 Secret identity、生命周期与备份恢复。
- committed tracked-file baseline：360；Markdown links：70 files / 288 links。
- 本节发布的最终状态仍只是 **Implementation complete — pending independent A/B
  review**；本地门禁不等于两个独立审计 CLEAN，不等于远端 CI PASS，也不授权
  push/merge/PR 或 M5 Accepted。

## 八、后续审计结论（历史收口）

最终候选 `d90a81e` 的独立审计 A 为 **BLOCK**：初版结构 checker 可被 dead
expression、假 main guard、重复 consumer path 与 `process.exit` alias 绕过；two-turn
协议缺少第二 turn 的专属 mutation，aggregate 专属 mutant 也没有真正送入 checker。
独立审计 B 因平台 cybersecurity `systemError` 未形成有效 CLEAN/BLOCK 报告，不能被
记作通过或候选缺陷。后续处置与当前状态已移交
[M5.7 任务书](2026-08-m5-7-audit-protocol-and-final-settlement.md)；本文件上方状态仅为
M5.6 当时记录，不再代表当前候选。
