# M5.5 最终结算与活生产消费者 guard 收敛

- 日期：2026-08-19
- 开工基线：`a084723`
- 实现提交：`5b3f9b3`
- 状态：Implementation complete — pending independent A/B review
- 范围：M5 聚合门禁、runtime scratch cleanup、M3B/M4 CLI 最终退出、备份 producer 与 production guard registry

## 背景与裁定

M5.4 候选 `a084723` 的两个全新独立审计均为 **BLOCK**。共同根因不是 14 步正常链
不能完成，而是三个最终交付边界未闭合：runtime scanner 仍用 destructive command status
退休 tracking record；cleanup 后普通退出可能抢先于已投递 signal，timer primitive 异常也
可能延迟 settlement；guard registry 的 consumer 元数据未参与门禁，删除真实调用点仍可绿。

本轮只关闭这三个共同根因，不进入 M5 Accepted、09A Pass、push/merge/PR 或远端 CI。

## 实现

1. `settleOwnedScratchContainer()` 以 immutable ID 和 mutable name 的最终观察裁决。删除
   命令非零但两者最终 absent 可成功；owned ID 仍在、unreadable 或 name 被 foreign 对象
   重绑均固定失败。`scanImage()` 的两个生产分支统一经 `settleTrackedRuntimeProbe()`，
   tracking record 只能在共享结算干净后退休。
2. `settleCliExitCode()` 在自然退出前让出两个原生 event-loop turn；backup、restore、
   lifecycle、smoke 均使用该出口。聚合器保留 SIGINT/SIGTERM/SIGHUP handler 到最终
   settlement，普通非零统一为 exit 1，信号 winner 只在 PGID/scoped cleanup 最终收敛后
   重投同名信号。timer create/clear 异常走唯一固定出口，未清除 timer 会被 `unref()`。
3. 备份 fork 前声明封装为生产函数 `runBackupCopyWithDeclaredOutput()`。registry 机器绑定
   consumer path、exact anchor 与基数，覆盖备份、四个 CLI、聚合器最终 settlement 与
   runtime scanner 两个 scratch settlement 调用点；删除/旁路真实消费者会转红。

## 本地证据

- Node.js `v24.18.0`；pnpm `11.9.0`。
- scripts tests `167/167`；M5 定点组合 `44/44`。
- `pnpm stage09a:check` 从步骤 1 串行 **14/14 PASS**。
- runtime image：78 packages、76 top-level links、5 migrations；mutation suite 为
  `1 baseline + 17 built + 2 static-only`。
- topology `45/45`；local-test `75/75`；targeted `69/69`；signal
  `5/5 deterministic + 6/6 real windows`。
- fresh smoke、8 份 Secret identity、lifecycle、same-ledger restore 均 PASS；各演练
  报告 scoped Docker、临时文件与 PGID residue 为零。

## 下一门禁

两个**全新、用户可见、互相独立**的 Codex 会话审计同一候选：A 做静态/结构/变异
判别且禁止 Docker；B 做动态/信号/真实 Docker并独占 daemon。报告分别写入
`.local/audit-reports/m5-5-<sha>-a.md` 与 `-b.md`。只有两路均 CLEAN 且总控独立核对后
才进入 M5 Accepted 裁定。本地 14/14 不等于远端 CI PASS。
