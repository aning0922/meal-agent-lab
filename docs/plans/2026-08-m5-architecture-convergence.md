# M5 架构收缩与收敛任务书

- 状态：Implemented — pending independent A/B review（未 Accepted）
- 日期：2026-08-17
- 基线：`ea9a6fd0b20dc1b4bcd6ea0e023d6225df895255`
- 实现落点：`eec3e0d`（本地完整门禁 14/14；待独立 A/B 审计）
- 范围：阶段 09A M5 的 runtime image、外部证据、资源所有权、备份恢复与 mutation 门禁

## 为什么停止逐条补洞

最近四轮两路独立审计虽然持续关闭了具体反例，但确认级问题仍反复落在同一组根因：

1. 自写 OCI/PAX/layer replay 同时承担解析器与 materializer，状态空间过大；
2. image/container/volume/PGID 的 locator、identity、claim 与 generation 在不同入口各自解释；
3. cleanup 既有登记式删除，又有递归目录删除等旁路；
4. backup 路径、restore TOC 与 mutation registry 存在多份局部文法；
5. 正向 14/14 可以证明主路径可运行，但不能证明以上判别面闭合。

因此本轮不再增加一个分支来修一个样例，而是先收缩承诺，再统一实现。

## 验收威胁模型

阶段 09A 只验收**本地、单操作者、固定 Dockerfile/基础镜像 digest、受信本地 Docker
daemon** 下的私有测试部署。它仍必须处理：

- 本仓库自身的异常、signal、timeout、旧 generation、状态码与 payload 不一致；
- 可变 locator 漂移、资源 identity 不匹配、路径 inode 被替换；
- cleanup、flush、publish、restore 任一步失败；
- CLI 成功输出为空、畸形、截断或属于错误对象；
- mutation 用 wrong reason、未捕获异常或静态总计数冒充判别力。

本阶段不再声称自己是通用 hostile-OCI verifier，也不为同 EUID 或 Docker daemon
管理员的主动并发攻击提供隔离保证。扩大到不可信 builder/daemon 时必须另立阶段与 ADR。

## 收敛决策

### 1. Runtime image 只保留一个最终文件系统事实源

- 首次取得 canonical immutable image ID 后，Config、history、provenance、scratch
  container 与导出都只绑定该 ID；可变 tag 不再参与后续证据。
- Docker daemon 对 immutable image ID 的最终 materialization 是 runtime rootfs 的唯一
  事实源。M5 不再自行 replay OCI whiteout/hardlink/PAX 形成第二份 rootfs 语义。
- scratch container 必须绑定唯一 claim；inspect 必须证明 `.Image`、claim 与 immutable
  image ID 一致。扫描结束或失败后按 immutable container ID 清理并确认不存在。
- runtime owner/mode 与固定入口由受控容器内只读 probe 验证；最终导出的文件树用于内容、
  link、migration、依赖闭包和 Secret containment 比对。

### 2. 单一所有权账本

- 文件、目录、container、image、volume、PGID 都只经共享 registry 登记、校验、退休。
- destructive cleanup 不得绕过 registry；未知 child、identity drift 或 residue 必须保留并失败。
- 名称和路径只是 locator，不能自行赋予删除权。

### 3. 单一 generation validator

- service 与 one-shot 统一使用同一份 immutable ID/project/service/image/StartedAt 判据。
- 旧 exited container、同 StartedAt replacement 或 foreign image 都不能与本轮 exit 0
  拼接成成功。

### 4. Backup 正式路径必须预先存在且可证明

- 输出目录必须在动作前存在、为真实目录、非 symlink，并由同一 fd/inode 证据持续绑定；
  不再允许 missing-tail 解析后由 `mkdir -p` 补出路径。
- dump/sidecar 使用 `O_EXCL|O_NOFOLLOW`；创建成功立即登记 identity，写入、fsync、close、
  publish 与 rollback 使用同一记录。

### 5. Restore TOC 降低为有界前置能力

- helper 只绑定 framing、format/version、目标 database identity 与 declared/visible 计数关系；
  database identity 漂移或结构异常一律拒绝。
- 其余 object description 交给固定 PostgreSQL 18 的 `pg_restore` 自身解析；验收声明明确
  降低为 checksum + database-bound preflight，不把开放式行解析器写成完整 archive verifier。

### 6. 进程 settlement 以 ESRCH 为终态

- signal、timeout、普通失败与 primitive failure 共享 TERM → grace → KILL → bounded ESRCH。
- caller 只有在所有已登记 generation 退休或明确报告 survivor 后才能 settle。

### 7. Mutation 必须执行，不接受文本占位

- 每个关键 guard 的 mutation 必须实际改写/替换生产路径并运行最小反例；
- 删除 guard 后必须因缺失的指定理由失败；未捕获异常、earlier guard 或总数变化不算命中。

## 本轮停止条件

本任务只允许一个实现轮次。实现后从零串行运行完整 `stage09a:check`、文档链接、
`git diff --check` 与资源残留复核。全部通过后才创建两个全新的只读 A/B 审计会话。

若下一轮审计再次确认以下任一同源根因，则停止 M5 循环并请求重新划阶段，而不是继续补洞：

- 自写 OCI/PAX/layer materialization；
- cleanup registry 之外的删除旁路；
- service/one-shot 各自维护 generation 语义；
- backup missing-tail 或开放式 TOC 文法；
- 仅靠字符串/计数登记 mutation。

## 当前状态

- M5：**Implemented — pending independent A/B review**，未 Accepted；
- 阶段 09A：**In Progress**，不得标记 Pass；
- M1—M4 的历史 Accepted 不因本轮扩大；
- ADR-0006：Proposed；
- 远端 GitHub Actions：无真实成功 run，不能写 CI Pass；
- 未推送、未合并、未创建新的 PR。

## 实施结果（2026-08-17）

- production runtime image 不再调用仓库自写的 OCI/PAX layer replay；以 canonical
  immutable image ID 创建带唯一 claim 的 scratch container，严格复核 container
  identity，再由 Docker daemon export 最终 rootfs。容器内只读 probe 绑定 `/app`
  owner/mode 与固定入口，host 侧继续复用既有依赖、迁移与 Secret containment 判据。
- runtime mutation 扩成 **1 个未变异 baseline + 15 个真实 built mutation + 2 个
  static-only mutation**，新增 `.bin`、package payload/mode、root ownership、两类 symlink、
  README→directory 与 history-only Secret 反例；正向结果为 78 packages、76 top-level
  links、5 migrations。
- build evidence 在 Docker 调用前以 `runClaimToken` 登记；cleanup 只有在显式收到
  `buildEvidenceClaimToken` 时才能恢复/删除。多栈 M4 把共享 build evidence 的清理权只
  交给最后一个栈，避免第一个栈提前删除仍被第二个栈使用的镜像。
- operational one-shot 复用共享 generation validator；backup 输出目录必须预先存在、
  非 symlink，TOC 的承诺收窄为有界 database-bound preflight；进程组 probe/signal
  使用模块加载时冻结的原生 capability。
- 窄回归：scripts tests **133/133**、local-test **75/75**、targeted **69/69**、signal
  **5/5 deterministic + 6/6 real windows**。完整本地 `pnpm stage09a:check` 从第 1 步
  重新运行并 **14/14 PASS**；远端 CI 仍无真实 run。
- 一条测试 fixture 曾把当前 `docker build` 误当作旧 `docker compose build api`，并让
  cleanup 收到 status-0 空 inspect。生产 cleanup 正确拒绝猜测 absence，独立终态复查
  因而发现空 build-evidence 目录。fixture 已改成当前 argv，并为 cleanup 返回规范的
  exact absence 证据；同一测试 42/42 后独立复查为零目录。最终候选仍须再跑完整链并
  由两个全新 A/B 会话独立复核。
