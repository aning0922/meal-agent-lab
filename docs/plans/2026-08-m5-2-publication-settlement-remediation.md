# M5.2 发布与收场协议整改任务书

- 状态：Implementation complete — pending independent A/B review（未 Accepted）
- 日期：2026-08-17
- 基线：`152400077504d184c74b81445b32f6b8b2e95104`
- 范围：BuildKit 输出账本、正式备份发布、sidecar commit marker、runtime probe capability 与信号收场
- 审计输入：`.local/audit-reports/m5-1-1524000-a.md`（SHA-256
  `823aa9caea63e78c475163620812fd1e62a3a7bf94aa653c456ec73e86905ec9`）

## 为什么从 M5.1 转入 M5.2

M5.1 的停止条件已触发：独立审计 A 确认构建失败时的 iidfile/metadata 仍可能成为未登记
child，正式路径在 file fsync/close 之前已经可见，sidecar commit marker 又早于仍会失败的
transient cleanup；既有测试还无法区分 production fsync/close 次序与 no-op/reordered mutant。
审计 B 因平台 system error 未形成正式报告，不能被记作 CLEAN 或 BLOCK；但其完成前的仓库外
探针另提示 signal 可在 recovery build 窗口被普通 exit 1 抢先，这一项一并纳入收场协议。

这不是继续给 M5.1 增加 Round 编号。M5.2 只重新划分同一证据协议的两个原子边界：
**外部生产者的输出所有权**，以及**正式 artifact 的可见提交点**。不扩大产品、云、微信、
公网或 M1—M4 的业务范围。

## 决策

### 1. 外部生产者的输出在 fork 前声明

- iidfile 与 metadata 的精确路径在 `docker build` 启动前写入 owned-tree journal；声明只允许
  私有、已登记目录中的一个普通单链接文件，不授予任意 sibling 删除权。
- build 无论成功、非零、signal 或 timeout，受控 PGID 到达 ESRCH 后都从同一声明槽位捕获
  实际 inode；cleanup 也只允许采用这些预声明名字。未知 child 与 inode replacement 继续
  fail closed 并保留。
- 正向与 mutation 两个 build 入口必须共用同一协议；回归必须让真实 CLI shim 写出两份
  evidence 后以指定 build failure 退出，并证明 build 分支确实到达、临时树与 claimed image
  均被回收。

### 2. 正式文件采用不可见 staging 后原子 no-replace promotion

- 在目标目录内创建不可猜 staging 名，使用同一 fd 完成 write、fstat 与 file fsync，然后
  close；在此之前正式名字必须不存在。
- close 成功后以 `link(2)` 将 staging inode 原子、不可覆盖地发布到正式名，验证两名字指向
  同一 inode 且 `nlink=2`；删除 staging 后再次验证正式名 `nlink=1`，最后 fsync 父目录。
- 任一步失败只能按本轮已登记 dev/ino 回滚 staging/正式名字；外部 replacement 保留并把
  cleanup 置红。测试直接观察 production `fs.fsyncSync`、`fs.closeSync`、`fs.linkSync`、
  `fs.unlinkSync` 的调用次序，不再只测可替换的默认参数。

### 3. sidecar 是全部 transient cleanup 之后的最后提交点

- `docker cp`、archive TOC、源字节快照、one-off container removal、transfer loader 清理与
  private partial 目录退休全部完成前，dump 与 sidecar 两个正式名字都不得出现。
- cleanup 完成后先按上面的协议发布 dump 并复核，再发布 sidecar。sidecar 之后不得再有
  Docker/Compose/异步 cleanup 边界；它是恢复入口唯一认可的 committed marker。
- cleanup 失败的行为反例必须证明 publish callback 一次也没有被调用；成功路径必须证明
  顺序为 transient-clean → dump → sidecar。

### 4. capability 与信号 settlement 属于同一证据

- runtime scratch inspect 在 identity/claim 之外必须验证生产 create 所声明的
  `Config.User`、`HostConfig.NetworkMode=none` 与 `ReadonlyRootfs=true`；root probe 与
  `10001:10001` probe 分别绑定自己的预期。
- runtime image 两个入口收到 INT/TERM/HUP 后不得用普通 `exit 1` 抢走共享 handler；共享
  handler 完成最终 PGID sweep、scoped cleanup 与同信号重投前，入口不得打印 PASS/FAIL
  终态。

## 行为验收与 mutant 判别

至少覆盖以下反例，并要求固定安全理由、不回显 runner/文件内容：

1. build 写出 iidfile + metadata 后返回非零；删掉 fork 前声明时必须留下可检测 residue；
2. production file fsync 变 no-op、close 移到 promotion 后、directory fsync 移到 promotion 前；
3. transient cleanup 失败时 dump/sidecar 均不可见；把发布移回 cleanup 前时测试必须转红；
4. scratch inspect 的 User、NetworkMode、ReadonlyRootfs 各自漂移；
5. recovery build 窗口收到信号，最终必须保留真实信号语义且每个 announced PGID 为 ESRCH。

只检查源码 needle、调用次数常量或文档登记不算上述判别力。

## 停止条件

M5.2 只允许一个实现候选。若后续独立审计仍确认以下任一同源 P1，不再进行第 N 轮局部
补洞，立即停止并请求重新裁剪 M5 的发布/恢复功能边界：

- 外部 producer 仍可在已声明输出之外留下本仓库创建的未知 child；
- 正式名字仍能在 bytes fsync + close 之前被观察到；
- sidecar 仍早于任一会失败的清理边界；
- production fsync/close/promotion 次序仍只能靠文本或注入副本证明；
- signal handler 仍可被入口普通退出码抢先。

## 交付纪律

- 单 writer、append-only 本地提交；不 amend/rebase/reset/push/merge，不创建 PR。
- 固定 Node.js `v24.18.0`；先跑窄反例，再跑 scripts tests，最后在实现 HEAD 与文档 HEAD
  分别从步骤 1 串行运行 `pnpm stage09a:check` 14/14、docs links、`git diff --check` 与
  精确零残留复核。
- 门禁全绿后才可创建两个全新的用户可见只读审计会话；M5 仍未 Accepted，09A 仍为
  In Progress，ADR-0006 仍为 Proposed，远端 CI 无真实 run。

## 实施落点与本地证据（2026-08-17）

- 实现提交：`afe8deb`；M3B committed evidence baseline 同步：`38c72d9`（tracked
  文件数 `351 → 352`，对应本任务书新增文件）。两者均为 append-only 本地提交，未推送、
  未合并、未创建 PR。
- production helper 的回归直接观察真实 `fsync` / `close` / `link` / `unlink` 次序、
  正式名字在 close 前不可见、父目录 fsync，以及 failure rollback；另覆盖 in-tree hardlink
  删除后 `nlink` 的预期递减，避免把自身清理误判为外部 drift。
- build 失败夹具会真实写出 iidfile + metadata 后非零退出；正向与 mutation 两个入口都在
  recovery build 窗口接收真实 `SIGTERM`，最终由共享 handler 收敛，无普通 PASS/FAIL
  抢先、无 build evidence residue。
- backup 行为测试固定 `transient cleanup → dump → sidecar`，cleanup 失败时两个正式名字
  都不可见；sidecar 发布后不再运行可能失败的 async/Docker cleanup。
- 固定 Node.js `v24.18.0` 下，scripts tests `139/139`，runtime image 正向扫描 PASS，
  mutation `1 baseline + 17 built + 2 static-only` 全部按指定理由拒绝，restore drill PASS。
- 实现 HEAD `38c72d9` 已从步骤 1 串行通过 `pnpm stage09a:check` **14/14**；随后精确检查
  M3B/M4/M5 容器、网络、卷、镜像标签、临时目录、override、相关进程与 Git 工作树，
  均为零残留/clean。

该证据只支持“实现完成、等待独立审计”。两个全新的用户可见只读 A/B 审计均给出
CLEAN 之前，不得把 M5 标为 Accepted；远端 GitHub Actions 尚无真实 run，09A 仍为
In Progress，ADR-0006 仍为 Proposed。
