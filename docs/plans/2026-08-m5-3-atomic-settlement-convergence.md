# M5.3 原子副作用与 cleanup settlement 收敛

- 日期：2026-08-19
- 状态：Implementation complete — pending local full-gate verification
- 基线候选：`429b248`
- 实现提交：`c69b977`
- 范围：阶段 09A / M5；不扩大产品、云资源、真实微信或发布范围

## 背景

M5.2 候选 `429b248` 的独立审计结果为 **A=BLOCK、B=CLEAN**。B 证明正常动态路径、
完整 `stage09a:check` 14/14、runtime image、restore 和零残留均成立；A 的 after-effect、
非零 producer 与 cleanup-in-progress 反例则确认五项 P1。两份证据并不矛盾：正常路径
通过不能覆盖“副作用已经发生、primitive 随后报告失败”或“普通 cleanup 已经启动、
随后收到信号”的结算窗口。

五项 P1 归并为三个架构根因：

1. ownership locator 在副作用之后才取得；
2. 普通退出、信号 cleanup 与 recovery 使用不同的 settlement 路径；
3. 测试未把关键生产 guard 与最小反例、guard deletion 绑定。

## 决策

### 1. 发布 primitive 只以事后 inode 事实结算

`link(2)` 的返回值不再作为“正式名是否出现”的唯一事实。无论 wrapper 成功、
before-effect throw 或 after-effect throw，发布 helper 都重新 `lstat` 正式名；只有正式名
与 fork 前登记的 staging `dev/ino` 精确相等时才取得 rollback ownership。外部既有名、
替换 inode 和额外 hardlink 均保留并固定失败；本轮 inode 则同时撤销正式名与隐藏
staging，并在目录项变化后同步父目录。

### 2. 外部 producer 输出在启动前声明

backup 的私有 `hostPartial` 在 `docker cp` 前进入 owned-tree journal。producer 完整
settle 后，无论 status 非零、SIGINT、SIGTERM、SIGHUP 或 transport failure，只允许收养
预声明路径上的 regular、`nlink=1` inode；unknown sibling、symlink、hardlink 和路径替换
继续 fail closed。正式 dump 与 sidecar 在 partial/transient cleanup 证明完成前仍不可见。

### 3. cleanup 使用独立且 memoized 的进程组生命周期

普通 workload 与 scoped cleanup 不再共享同一个 process-group registry。cleanup 由
`createSignalSafeCleanup` 建立独立 lifecycle 并 memoize 同一 Promise：若普通退出已经
进入 cleanup 后收到信号，handler 的第一轮 workload sweep 不会杀死 cleanup 自己的
inspect/rm 子命令；handler 等待同一 cleanup settle，再做最终全局 sweep，只有 scoped
residue 为零才重投原 SIGINT/SIGTERM/SIGHUP。每个 cleanup command 仍独立完成
TERM→KILL→ESRCH 并向聚合器公告 PGID。

### 4. recovery 只在最终结算时形成 failure

iidfile/metadata 是正常成功证据，不再在 cleanup 内充当一条可永久 latch failure 的恢复
分支。pre-evidence cleanup 只接受 fork 前登记的 exact recovery tag，并要求 tag、owner
claim 与 canonical immutable image ID 同时闭合。错误或截断 metadata 不会在 exact
tag/claim/ID 已成功清除对象后继续伪造 residue；错误 claim、wrong ID、extra tag 或无法
证明 absence 仍固定失败。

### 5. production guard 的 mutation 必须可执行

新增的 mutation 门禁直接从当前生产源码构造三个 mutant：删除 fork 前声明、删除正式
publication 的 `nlink` guards、删除 scratch capability 的 user/network/read-only 字段。
每个 mutant 都由同一生产 helper/parser 的最小 oracle 判为错误；anchor 缺失、重复或
parser 退回可选字段都会使门禁变红。source needle 和旧 helper 不再承担这三项证明。

## 回归矩阵

- hardlink after-effect：本轮 inode 必须撤销；外部既有名必须保留；隐藏 staging 为零；
- backup partial：status 17、SIGINT、SIGTERM、SIGHUP 四种 producer settlement 均无
  private partial、正式 dump、sidecar 或 one-off residue；
- runtime recovery build：两个真实 entrypoint × 三种信号，使用完整 iid + 截断 metadata
  + exact tag/claim/ID，必须同信号退出并清空对象；
- ordinary-cleanup race：两个真实 entrypoint × 三种信号，必须先真实进入 cleanup command，
  再发信号；同一 cleanup Promise 完成后同信号退出且零 residue；
- scratch capability：缺 user、network 或 read-only 任一项即固定拒绝；
- mutation：pre-fork declaration、publication link count 与 scratch capability 三组均使用
  生产源码生成的 mutant。

固定 Node.js `v24.18.0` 的脚本回归为 **148/148**。完整 14 步 Docker/Compose 门禁、
文档链接、diff check 与零残留结果记录在本文件后续验收段；只有全部通过后才允许创建
两个全新、用户可见、独立 worktree 的 A/B 审计会话。

## 边界与状态

- 同 EUID 与同 Docker daemon 管理员仍属于本地单操作者信任边界；
- 本轮不声称远端 GitHub Actions run 已通过；
- 本轮不把 M5 标记 Accepted，不把阶段 09A 标记 Pass；
- ADR-0006 保持 `Proposed`，由两路独立审计与项目总控后续裁定。
