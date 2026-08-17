# M5.1 架构级证据协议整改任务书

- 状态：In Progress（未 Accepted）
- 日期：2026-08-17
- 基线：`59f8eef27148be4c3ac5d237bcb877df260f62db`
- 范围：M5 runtime image、正式备份制品、cleanup recovery 与 mutation 证据
- 审计输入：`.local/audit-reports/m5-59f8eef-a.md`（SHA-256
  `dfa56b63597cf2d46cdb8d44bcc231aa4f0f76750872bb048251bfc8d96cb36b`）与
  `.local/audit-reports/m5-59f8eef-b.md`（SHA-256
  `2c9f6e1cb0690a8311e53c5bc44f7257cb2ee9c47ea875c795ebe5900c3a618c`）

## 为什么重新划为 M5.1

`59f8eef` 的两路独立审计均为 BLOCK。发现不再是一个局部解析分支，而是四条协议承诺
没有落到可执行证据：镜像在构建证据落盘前没有恢复 locator；root 身份 probe 不能证明
真实 runtime UID 可读；正式备份只保证 close、没有 fsync 的崩溃一致性；所谓 critical
guard mutation 仍可仅凭源代码 needle 数量变绿。此前的架构收敛任务书明确把最后一项列为
停止条件，因此不继续按 Round 编号补洞，而把它重划为一个有界的 M5.1 协议整改。

M5.1 不扩大产品、云、微信或公网范围，不改变 M1—M4 已 Accepted 的业务语义。它只修复
以下五个确认级问题：

1. runtime owner probe 以 root 运行，不能证明 `10001:10001` 可遍历和读取固定入口；
2. `writeExclusiveEvidenceFile` 没有 file fsync 与 parent-directory fsync；
3. critical-guard registry 的“变异”只是字符串计数，语义弱化可继续绿；
4. runtime build 在 iidfile/metadata 写入前没有可恢复 locator，失败会留下镜像和证据目录；
5. committed tracked-file baseline 漂移使正式聚合链在步骤 9 fail closed。

## 架构决策

### 1. 构建前登记 recovery tag，所有权仍由 immutable identity + claim 产生

- 在启动 `docker build` 前生成每轮唯一 recovery tag，并先登记到 cleanup 状态。
- tag 只是 locator，不是 ownership。成功或失败恢复后都必须 inspect 证明 canonical image
  ID、不可猜 claim，以及 RepoTags **恰好只有**该 recovery tag。
- Config、history、scratch container、export 与内容扫描全部继续绑定恢复出的 immutable ID。
- cleanup 先删除 recovery tag，再按 immutable ID 复核并删除变成 untagged 的本轮镜像；
  任何 foreign tag、identity/claim 漂移或畸形 evidence 都保留对象并固定失败。
- 无论 image identity 能否恢复，本轮已登记的 temporary tree 都必须独立退休；不得为了
  “人工恢复”留下几十 MiB 的本地证据目录。

### 2. 两个 scratch probe，各自只证明一件事

- root probe 继续证明 `/app` payload 的 root owner、不可写 mode 与固定入口不是 symlink。
- 第二个 scratch container 明确以 `10001:10001`、`--network none`、`--read-only` 运行，
  证明 `/app`、`/app/dist`、`/app/dist/database` 可遍历，且两个固定 JavaScript 入口可读。
- 两个 container 都绑定同一 immutable image ID、唯一 claim 与 canonical container ID；
  依次登记和退休，不共享可变名字。
- 真实 Docker mutation 至少包含入口 `0600` 与目录 `0700` 两种反例，并以 runtime-access
  固定理由失败。

### 3. 正式备份发布采用 crash-consistent commit marker

- `writeExclusiveEvidenceFile` 在同一 fd 上完成 write、fstat、**file fsync**、close，随后
  对父目录执行 **directory fsync**；任一步失败都只按 O_EXCL 时登记的 dev/ino 回滚。
- 成功返回前必须证明 file fsync 与 parent-directory fsync 均已完成；测试通过注入同步
  capability 观察调用次数与失败回滚，不能通过搜索函数名字证明。
- 备份先发布并持久化 dump，最后发布并持久化 sidecar；sidecar 是正式提交标记。
  sidecar 不存在时备份不完整，任何失败回滚本轮两个精确 inode。

### 4. 删除 needle registry，关键 guard 只接受行为证据

- 删除 `m5-critical-guard-registry.mjs` 及其字符串出现次数测试。
- runtime access 由真实构建变异证明；fsync 由注入 capability 的行为测试证明；backup TOC
  与发布顺序由真实 parser/performBackup 反例证明；cleanup 与 generation 继续由既有动态
  生命周期测试证明。
- 文档可登记反例名称和固定理由，但登记表本身不再被称作 mutation 判别力。

### 5. committed-data baseline 与最终 HEAD

- tracked-file baseline 只在全部预定新增/删除文件完成后更新，并由 registry-integrity
  对 Git committed view 复核。
- 先完成实现提交，再完成文档提交；最后在**不再改 tracked 文件**的精确候选 HEAD 上从
  步骤 1 串行运行 `pnpm stage09a:check` 14/14、文档链接、`git diff --check` 与资源残留复核。
- 任一门禁红时不得创建审计会话；全绿后才交给两个全新的只读 A/B 会话。

## 停止条件

本任务只允许一个实现轮次。若新审计再次确认以下任一同源问题，停止本地补洞并请求重新
划分 M5 范围：

- recovery locator 仍不能在 iidfile/metadata 前窗口收回本轮镜像；
- runtime UID 可访问性仍由 root probe 或静态文字代替；
- 正式制品 durability 仍没有真实 fsync 行为证据；
- 任何关键 mutation 仍只检查文本 needle、同步计数或文档登记；
- 最终报告所称 14/14 不是在报告对应的精确 HEAD 上取得。

## 当前状态边界

- M5.1：In Progress，未 Accepted；
- M5：保持 BLOCK / 未 Accepted；
- 阶段 09A：In Progress，不得标记 Pass；
- ADR-0006：Proposed；
- 远端 GitHub Actions：无真实成功 run；
- 不推送、不合并、不创建新 PR，也不进入云/真实微信/公网范围。
