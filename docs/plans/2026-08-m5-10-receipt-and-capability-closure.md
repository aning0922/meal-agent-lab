# M5.10 运行 receipt、能力面与安全诊断闭合任务书

- 日期：2026-08-21
- 实施基线：`36987d8057f48101ff5781c67b3f31c0a80e769d`
- 状态：Implementation complete — pending independent A/B review；M5 未 Accepted；阶段 09A 未 Pass
- 范围：M5 本地聚合门禁、Audit-B 结构化证据、生产消费者闭包、备份 pre-fork 证明与固定失败诊断

## 一、进入条件与审计结论

M5.9 候选 `36987d8` 的独立审计 A 是有效 **BLOCK**：确认 7 项 P1、1 项 P2。
审计 B 被平台 cybersecurity safeguard 以 `systemError` 中断，没有 Markdown/JSON
最终报告，因此只记为 **INVALID**，不能写成 CLEAN 或 BLOCK，也不能抵消 A 的结论。

审计 A 还推翻了 M5.9 的候选证据：任务书提交后 tracked 文件从 366 变成 367，
但 `m3b-evidence-baseline.json` 仍登记 366；提交态的 registry integrity 门禁确定失败。
因此本轮规定：完整 14 步门禁只能在最终候选提交产生后执行。提交前的工作树结果只可
用作实现反馈，不得冒充候选验收证据。

## 二、共同根因

七项 P1 归并为四个结构性根因：

1. Audit-B 消费者仍能接触 `gate`、invocation 与 retry 的可替换字段，mutation 只统计
   源码文本，不能证明报告绑定真实核心结果；
2. 显式 CLI manifest 没有与关键声明的全部真实消费者反向闭合；新增生产调用方可落在
   manifest 外；
3. backup mutation 修改共享 helper 而非真实 `performBackup` pre-fork 调用点，且接受
   泛化失败理由；
4. 失败报告 scalar、报告 basename/path 与 Git stderr 会进入输出，闭合集合 validator
   仍接受核心不可能产生的矛盾 failure/signal 形状。

## 三、架构整改

### 3.1 核心签发 opaque receipt

`runStage09aCheckForAudit()` 在 `run-stage09a-check.mjs` 内部包住唯一一次真实
`runStage09aCheck()` 调用。核心以模块私有 `WeakMap` 签发空冻结对象作为 receipt，
receipt 绑定同一次 gate、requested signal 与调用会计。Audit-B 只拿 receipt；它不再
导入 invocation snapshot，也不读取或重新组装 `outcome.gate`。

报告发布路径必须经 `createStage09aAuditBReportFromReceipt()` 与私有 receipt projector。
普通对象、伪 gate 和硬编码计数均只能得到固定 `run-evidence-invalid`，不能成为 PASS。
低层 report builder、receipt projector、receipt consumer 与共享核心的全部声明身份调用
均进入同一消费者 registry；增加别名、额外调用或旁路 builder 都造成 registry drift。

### 3.2 生产能力面反向闭合

`m5ProductionGuards` 恢复并扩展真实 consumer 声明：

- 三处 `runWithDeclaredOwnedTreeOutputs`；
- 五个 `runSignalSettledCli` 根入口；
- 人类 CLI 与审计 receipt 对共享核心的两处调用；
- Audit-B 对 receipt、projector 与 report builder 的唯一调用。

TypeScript declaration identity 从 canonical tracked `infra/docker/*.mjs` 与 `scripts/*.mjs`
反向发现目标调用并与 registry 精确比较。新的 Stage09A step 或任意 tracked 生产模块一旦
取得这些能力但未登记，门禁固定转红；非 canonical `stage09a:*` script 只产生固定 problem，
不再用测试进程未捕获异常冒充判别力。

### 3.3 backup 真调用点 mutation

backup 正向反例先让外部 producer 在返回前写出 partial，并证明已声明的输出可由 signal
cleanup 收养和删除，residue 为零。变异随后直接删除 `performBackup()` 内真实
`runWithDeclaredOwnedTreeOutputs(...)` 调用点；同一竞态只能得到
`backup artifact cleanup failed` 和一个精确 residue。共享 helper 不再被改写，
`one-off container handoff failed` 也不再作为可接受的替代理由。

### 3.4 闭合 schema 与固定输出

- Audit-B schema 升至 v3；普通 failure 必须有非零 exit，signaled failure 的 failed step
  必须是已完成前缀的下一步，gate signal 必须等于 receipt 的 requested signal；
- 非法 Node version 等 scalar 序列化为 `null`，不得回显原始字符串；
- 报告成功或失败只输出固定 `structured report published`，不打印调用方 report basename；
- Markdown/Git spawn、非零退出和链接失败只输出固定类别与可信计数，不回显 Git stderr、
  exception message、tracked target 或输入路径。

## 四、回归证据

固定 Node.js `v24.18.0` 的 scripts tests 为 **196/196**。新增/改写的判别力包括：

- forged receipt、非法 scalar、矛盾 failure/signal schema；
- 每个登记 consumer 移入 `if (false)`、新增 manifest 外声明身份调用、Stage09A 真实 step
  获取 settlement 能力；
- 直接删除核心调用、receipt consumer、projector、report builder 与 backup 真调用点；
- Git stderr/spawn error sentinel 零回显；
- backup 同一竞态的正向零 residue 与真调用点删除后的固定失败。

本节只登记提交前的纯 Node 实现反馈。`pnpm stage09a:check` 14/14、文档链接、diff check
与零残留必须在最终提交态重新执行；结果不得提前写入本任务书。

## 五、范围与状态边界

本轮不修改 contracts、API/client 业务实现、数据库迁移、Compose/Secret/M3B/M4 动态实现、
Dockerfile、lockfile、依赖例外或远端 workflow。不 push、merge、建 PR，不写远端 CI PASS，
不自行标记 M5 Accepted 或 09A Pass。

最终候选只有在提交态完整门禁全绿后才可交给两个**全新、互相独立**的只读 A/B 会话。
A 禁止 Docker；B 独占 Docker并使用结构化 `stage09a:audit-b` 入口。任一路确认 P0/P1，
候选继续 BLOCK。
