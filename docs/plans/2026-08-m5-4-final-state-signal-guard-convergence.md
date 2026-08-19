# M5.4 最终状态、信号交付与生产 guard 收敛

- 日期：2026-08-19
- 状态：Implementation complete — pending independent A/B review
- 基线候选：`6552384`
- 实现提交：`ec14771`
- 范围：阶段 09A / M5；不扩大产品、云资源、真实微信或发布范围

## 背景

M5.3 候选 `6552384` 的两个全新独立审计均为 **BLOCK**。正常路径、完整 14 步链和
零残留可以成立，同时下面三类最小反例仍然失败：

1. `docker image rm` / container cleanup 的命令状态会被永久记为失败，而没有以最后一次
   immutable-ID、tag、claim 与 container identity 观察结算；反过来，tag 已消失但
   iid/metadata 不可用时，门禁也可能丢失已经创建的 claimed image；
2. scoped cleanup 完成后，操作系统已投递但 Node 尚未分发给 JS handler 的信号，会被
   同步 `process.exit` 抢先，最终错误地返回普通退出；
3. mutation 回归改了“相似 helper”或同步计数，而没有删除真正保护生产调用点的 guard，
   因而无法证明 backup pre-fork declaration、cleanup memoization、信号交付屏障和
   runtime cleanup capability 的判别力。

这些不是三组孤立的条件分支，而是同一个协议缺口：**命令返回值、可变 locator 与测试
注册表都不是最终事实**。

## 决策

### 1. Runtime image/container cleanup 只由最终状态结算

新增 `m5-runtime-settlement.mjs`，正向 runtime-image 入口与 mutation 入口共享同一实现：

- destructive primitive 的非零状态本身不永久锁存；若最终 immutable image、mutable tag
  与 claimed scratch container 均被证明不存在，cleanup 成功；
- 删除后再次 inspect。tag 或 container 名被外部对象重绑时保留外部对象并固定失败，
  不按名字二次删除；
- iid/metadata 尚不可用但 recovery tag 已消失时，按不可猜 build claim 枚举唯一的
  canonical immutable image ID。零个表示没有 claimed image；一个取得后只按 immutable
  ID 结算；多个固定失败；
- claimed image 出现外部 tag、wrong claim 或非 canonical identity 时不取得删除权。

### 2. Signal 的最终语义在 cleanup 后让出事件循环再决定

`m3b-subprocess.mjs` 提供统一的 cleanup 后信号交付屏障：使用模块加载时保存的原生
`setImmediate` 连续让出两个 turn，再读取 handler 已登记的 winner。两个 runtime-image
入口都先完成 scoped settlement，再经过该屏障决定是否重投信号；普通失败只设置
`process.exitCode=1`，不再用同步 `process.exit(1)` 抢在 pending signal 之前结束进程。

这不是任意时长 sleep，也不声称可以观察尚未交给进程的信号；它只关闭“操作系统已经
投递、事件循环还没把 handler 回调分发”的本进程窗口。

### 3. Backup 生产调用点本身进入 pre-fork owned-tree protocol

正式 `docker cp` producer 现在由 `runWithDeclaredOwnedTreeOutputs` 包裹；private partial
在 fork 前登记，producer settle 后按既有 inode journal 取得或拒绝 cleanup ownership。
测试不再只验证声明 helper，而是执行复制后的生产 `performBackup` 调用点，并在 producer
仍运行时触发 cleanup oracle。

### 4. Critical guard 使用机器 registry + 活调用点 mutant

新增 `m5-production-guard-registry.mjs`，登记六个必须由可执行 mutation 覆盖的生产 guard：

- backup pre-fork declaration；
- publication link-count；
- cleanup memoization；
- cleanup signal-delivery barrier；
- runtime-image claim settlement；
- scratch capability。

每个 guard 的测试必须执行一次；缺项、重复或 registry 漂移会使测试失败。mutant 直接
修改复制后的生产模块/调用点，并由独立最小 oracle 判定，不能用字符串出现次数、相似
helper 或未捕获异常冒充命中。

## 回归矩阵

- image/tag/container destructive command 非零但最终均 absent：应成功；
- tagless claimed image：由 claim 恢复唯一 immutable ID 并删除；
- 删除后 tag/container 被 foreign object 重绑：保留 foreign object 并固定失败；
- claimed image 带 foreign tag：保留并失败；
- cleanup 后 self-SIGTERM、handler 尚待分发：最终保留真实 SIGTERM 语义；
- memoized cleanup：并发调用取得同一个 Promise，producer 只运行一次；
- 六个 production guard：正常实现命中，删除真正 guard 后以该 guard 的指定理由转红。

固定 Node.js `v24.18.0` 下，scripts tests **157/157**；runtime image 正向门禁通过，
runtime image mutation 为 **1 baseline + 17 built + 2 static-only**。完整 14 步链、docs
links 与最终资源清理由本候选的收尾门禁登记，不由上述窄门禁替代。

## 边界与状态

- 同 EUID 与同 Docker daemon 管理员仍是受信的本地单操作者；本协议不对抗该主体主动
  伪造 claim 或并发篡改 daemon 对象；
- 信号交付屏障只覆盖已投递到本进程、尚待 JS 分发的事件循环窗口；
- 本轮不声称 GitHub Actions 远端 run 已通过；
- M5 保持未 Accepted，阶段 09A 保持 In Progress，ADR-0006 保持 `Proposed`；
- 下一门禁是两个全新、用户可见、独立 worktree 的 A/B 只读审计：A 禁止 Docker，B
  独占 Docker。两路均 CLEAN 后才回到项目总控裁定。
