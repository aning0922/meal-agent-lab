# ADR-0006：阶段 09A 外部证据与资源所有权协议

- 状态：Proposed
- 日期：2026-08-16
- 范围：阶段 09A M5 的 Docker/Compose、进程组、生命周期、备份与恢复门禁

实施注记（2026-08-20，M5.7）：M5.6 候选的审计 A 证明初版 production guard 仍可由
dead expression、假 main guard、重复 registry path 与 `process.exit` alias 绕过；审计 B
因平台 cybersecurity `systemError` 无有效报告。当前 consumer 与 protected-entrypoint
registry 均钉住精确集合；main guard/直接 await 按 AST 结构判定；两次 event-loop turn
和 delivered-signal settlement 有独立 mutation oracle。`stage09a-gate-registry.mjs` 成为
真实聚合器与动态审计报告的唯一 14 步事实源；`pnpm stage09a:audit-b` 固定 Node、单次
完整链、零 retry，并只 exclusive 发布闭集 JSON。scripts tests 为 182/182；完整候选
门禁尚待提交后运行。M5.7 当前仅为 Implementation complete — pending deterministic
full gate and independent A/B review；本 ADR 保持 Proposed。

## 背景

M5 Round 12 的两个有界审计周期都证明了同一类问题：正常路径可以连续通过
`stage09a:check`，但实现仍会在名字、tag、路径或一次 status-0 输出之间拼接证据，
从而把不同 generation、不同对象或不完整字节误认为同一次操作。继续为每个形状
追加局部判断，不能证明判别面闭合。

本 ADR 不扩大产品或部署范围，不购买云资源，不接入真实微信配置，也不改变 M1—M4
既有业务语义。它只规定 M5 如何取得、传递、发布和清理本地部署证据。

## 决策

### 1. 外部证据必须先闭合解析

Docker、Compose、Git 与 PostgreSQL CLI 的 stdout/stderr 均是不可信输入。成功退出
不是有效证据的充分条件。每类成功 payload 必须由版本化、闭集 parser 校验：

- Compose 根、服务和嵌套 capability 拒绝未知键；每次 resolved 调用都绑定同一个
  project identity；
- image metadata、inspect 和 history 绑定 canonical immutable image ID、build claim
  与完整结构；
- container inspect 绑定 immutable ID、project、service、image、generation 与时间；
- `pg_restore --create --list` 的有界预检必须包含规范的目标 database 创建项；database
  properties 若出现只能属于同一目标，且 declared/visible 条目计数必须符合 PostgreSQL
  18 的固定头部差值。其余 object description 由固定 PostgreSQL 18 自己解析，本 helper
  不宣称是通用 archive verifier。

失败诊断只能使用固定错误码、可信 registry 名称和计数；不得回显外部键、路径、
stdout/stderr 或异常文本。

### 2. 所有权只来自不可变证据

名字、tag 和文件路径只是 locator，不是 ownership。一次操作在副作用前生成不可猜的
claim/generation；取得 immutable ID 后，后续检查、清理和发布只使用该 ID，并再次
验证 claim 与 scope。名字漂移只能导致保留外部对象并报告 residue，不能导致按名字
删除，也不能把 registry 条目静默退休。

无 immutable identity、claim、scope 或 provenance 任一项的记录都是不完整证据；
清理不得从可变 tag/path 重新推导所有权。

这里有两个必须写明的本地平台边界：

- BuildKit 启动前登记一个不可猜的 per-run tag，目的是让信号落在 iidfile/metadata
  尚未写完的窗口时仍有恢复 locator。tag 本身不是 ownership；只有随后 inspect 同时
  证明 immutable image ID、build claim 与**唯一且精确**的该 tag，才允许删除。
- Docker named volume API 没有可供本地 CLI 持有的 immutable object ID，删除只能按
  name 发起。因此本基线要求同一 Docker daemon 上的 M3B/M4/M5 动态门禁由一个操作者
  串行执行；另一个拥有 Docker daemon 权限的主体若在最后一次 label/claim inspect 与
  `docker volume rm` 之间删卷并创建同名替身，属于本地单操作者基线之外。若将这种并发
  对手纳入威胁模型，必须引入 daemon 侧 lease/插件或提供 immutable volume handle 的
  平台，不能用更多一次按名 inspect 假装原子化。

### 3. 正式 artifact 采用验证后发布

备份在私有 staging 中产生。容器源 digest、宿主字节、archive TOC、正式 dump 与
sidecar 必须绑定同一 Buffer/digest。正式 artifact 先在**同目录隐藏 staging 名**上以
`O_EXCL|O_NOFOLLOW` 创建，并在同一 fd 完成写入、复核、file fsync 与 close；随后以
`link(2)` no-replace promotion 产生正式名，验证 staging 与正式名为同一 dev/ino 且
`nlink 1→2`，移除 staging 后再验证正式名 `nlink=1` 并 fsync 父目录。`link`/`unlink`
primitive 无论如何返回都必须重新观察目录项：只有与 fork 前登记 staging inode 精确
相同的名字才取得 rollback ownership；替换 inode 和外部 hardlink 保留并固定失败。
dump 先持久化，sidecar 最后持久化并作为 commit marker；成功前最后复核 dev/ino、
`nlink=1`、size、digest 和 sidecar 字节。任一 sync、cleanup 或复核失败都不能返回成功。

恢复必须在第一次数据库查询/创建之前，对已经 checksum 绑定的同一 Buffer 完成
archive TOC 预检。坏 archive 不得创建目标数据库；恢复阶段继续使用同一 Buffer，
不得重新按路径读取。

### 4. 进程与 lifecycle 采用 generation 状态机

PGID probe 只有 ESRCH 表示消失；EPERM 表示仍存在；其他异常是独立的 primitive
failure，必须保留到最终 settlement。one-shot 和常驻服务都在启动前拍 baseline，
启动后绑定 ID/image/project/service/StartedAt；旧 exited 对象或 foreign replacement
不能与本轮 status 0 拼成成功。

### 5. mutation 证据与生产 guard 同源

字符串 needle、调用点计数和文档登记不构成 mutation 证据。每个关键 guard 必须有
可执行最小反例和期望固定理由。测试必须证明：

1. 正常实现命中指定 guard；
2. 删除或弱化该 guard 后，对应反例因“缺少指定 guard”失败；
3. earlier guard、未捕获异常或可同步改写的总计数不能冒充判别力。

### 6. 本地操作者与 builder 身份边界

本阶段的目标是可重复的**本地/私有测试部署证据**，不是在不可信同机多租户上建立
强隔离：

- 运行门禁的同 EUID 进程和同一 Docker daemon 的管理员被视为受信操作者；它们本来
  就能读本轮 Secret、改写临时目录或删除 daemon 对象。代码不得在异步窗口后递归删除
  未登记 child，未知 child 会使 `rmdir` 失败；但主动把已登记目录 rename 到任意新名字
  并隐藏起来的同 EUID 对手不在本基线内。
- 本地 Docker Engine/BuildKit 的 SLSA statement 实测 `builder.id` 可以是空字符串。
  本门禁把 provenance 当作 exported descriptor、selected manifest 和 statement subject
  的**字节/引用一致性证据**；empty subject 只允许由 attestation descriptor reference
  绑定，非空 subject 必须与该 reference 一致。它不把空 `builder.id` 写成已认证 builder，
  也不声称证明远端构建者身份。
- 上述边界只缩窄主动同权限篡改者，不豁免本仓库自身的信号、timeout、旧 generation、
  status-0 畸形输出、路径替换或 cleanup 失败；这些仍须 fail closed/failure-safe。

### 7. Runtime 文件系统证据采用 daemon materialization

在本 ADR 的本地单操作者、受信 Docker daemon 边界内，runtime image 的最终文件系统只
接受一个事实源：由 canonical immutable image ID 创建的受控 scratch container。M5 不再
自行 replay OCI/PAX/whiteout/hardlink 形成第二份 materializer 语义。

Config、history、provenance、scratch container 与导出必须绑定同一个 immutable image
ID；container inspect 还必须证明 claim 与 `.Image`。root probe 只证明 owner/mode 与固定
入口类型；另一个明确以 runtime UID/GID 运行的 read-only/no-network probe 必须证明目录
可遍历、固定入口可读。daemon 导出的最终文件树用于内容、link、migration、依赖闭包与
Secret containment 比对。该决定不宣称可以验证不可信 builder 或 daemon；若扩大威胁
模型，必须另立阶段。

### 8. destructive cleanup 与正式路径不得有旁路

文件、目录、container、image、volume 与 PGID 都必须经共享所有权账本登记、校验和退休；
递归删除、按名字删除或从当前路径重新推导所有权不能作为旁路。backup 输出目录必须在
动作前存在并以目录 identity 绑定，不再接受 missing-tail 后由 `mkdir -p` 创建。service 与
one-shot generation 统一调用同一个 validator；mutation 必须真实执行生产 guard，而不是
只检查文本 needle 或同步计数。

## 后果

- M5 在本 ADR 实施完成并经两个全新独立 A/B 审计 CLEAN 前保持“已实现、待复核，
  未 Accepted”；阶段 09A 保持 In Progress。
- 共享 parser 与 ownership helper 会增加少量代码，但减少各入口独立解释同一外部
  证据的分叉。
- 同 EUID 或具有 Docker daemon 权限的主动并发篡改者不在 local-test 单操作者威胁
  模型内；本仓库自身产生的所有异步等待窗口、tag/identity 漂移与 cleanup 失败仍须覆盖。
- 本地 14/14 正向门禁不再单独构成 Accepted 证据；独立反例的判别力属于验收条件。

## 实施注记

截至 2026-08-17，候选 `ea9a6fd` 的最近四轮两路审计仍反复确认相同根因族：双重
OCI/materializer 语义、分叉的 ownership/generation、cleanup 旁路、backup/TOC 开放文法
与文本式 mutation 证明。最近一轮正式链在第 10 步因 build-evidence residue 停止，只完成
10/14；两路审计均为 BLOCK。此前各轮 14/14 是历史正向证据，不能覆盖这些反例。

因此 M5 转入“架构收缩与收敛”，实施细节以
[`2026-08-m5-architecture-convergence.md`](../../plans/2026-08-m5-architecture-convergence.md)
为准。该收敛实现已于 2026-08-17 落在 `eec3e0d`，并从第 1 步重新通过本地
`pnpm stage09a:check` 14/14：生产 runtime image 只接受 immutable image ID → claimed
scratch container → Docker daemon export 这一份最终文件系统事实源；build evidence、
Secret、镜像与多栈 cleanup 使用显式 owner claim；service/one-shot generation 与进程
settlement 也统一到共享协议。其后候选 `59f8eef` 的两路独立审计再次确认 recovery
locator、runtime UID access、正式文件 durability 与字符串计数式 mutation 证据未闭合，
旧任务的停止条件已经触发。后续由
[`2026-08-m5-1-evidence-protocol-remediation.md`](../../plans/2026-08-m5-1-evidence-protocol-remediation.md)
承接。实现提交 `952d3e3` 已从步骤 1 串行通过本地 `stage09a:check` **14/14**；M5.1
当前 Implementation complete — pending independent A/B review，M5 仍未 Accepted，
阶段 09A 保持 In Progress，远端 CI 真实 run 与阶段总验收均未完成。

M5.1 的后续独立审计又确认：producer 在非零退出前写出的 iidfile/metadata、正式文件名
的可见时点、sidecar 之前尚未完成的清理，以及 recovery build 的 signal settlement，仍未
被同一个原子协议约束。该整改由
[`2026-08-m5-2-publication-settlement-remediation.md`](../../plans/2026-08-m5-2-publication-settlement-remediation.md)
承接。实现提交 `afe8deb` 与基线同步提交 `38c72d9` 将输出声明前移到 fork 之前；正式
artifact 经同目录 staging 的 write/fstat/fsync/close 后 no-replace promotion 并 fsync
父目录；backup sidecar 只在 transient cleanup 和 dump 发布之后提交；runtime image
入口的 recovery-build 信号由共享 handler 完成 cleanup 与同信号重投。实现 HEAD 已从
步骤 1 串行通过本地 `stage09a:check` **14/14**，scripts tests **139/139**，最终 scoped
资源零残留。M5.2 当前仍只是 Implementation complete — pending independent A/B review；
M5 未 Accepted，阶段 09A 保持 In Progress，远端 CI 真实 run 与阶段总验收均未完成。

M5.2 候选 `429b248` 的后续独立审计结果为 A=BLOCK、B=CLEAN。动态正常路径 14/14
与零残留成立，但 A 的 after-effect/producer/cleanup-race 反例确认：正式 hardlink 与
backup partial 的 ownership 仍取得过晚，普通 cleanup 会被 signal sweep 杀死，且
恢复源的早期失败会在 exact fallback 成功后永久 latch residue。M5.3 由
[`2026-08-m5-3-atomic-settlement-convergence.md`](../../plans/2026-08-m5-3-atomic-settlement-convergence.md)
承接，实施提交 `c69b977`：publication 在所有 link settlement 后按 staging inode 重新
取得回滚权；backup partial 在 `docker cp` 前声明；runtime cleanup 使用独立、memoized
进程组 lifecycle；pre-evidence recovery 只接受 exact tag + claim + immutable ID 的最终
结算；production guard mutants 直接从生产源码构造。固定 Node.js `v24.18.0` 的 scripts
tests 为 **148/148**。M5.3 当前仍只是 Implementation complete — pending independent
A/B review；M5 未 Accepted、阶段 09A 未 Pass、远端 CI 无真实 run。

M5.3 候选 `6552384` 的两个后续独立审计均为 BLOCK，并确认三项仍未被上述协议完整
执行：runtime image/container recovery 仍会永久锁存 destructive command status，而不是
用最终 identity 事实结算；cleanup 后已投递但尚待 JS 分发的信号会被同步退出抢先；若
mutation 没有删除真实生产调用点的 guard，则字符串或相似 helper 的反例仍可能假绿。
M5.4 由
[`2026-08-m5-4-final-state-signal-guard-convergence.md`](../../plans/2026-08-m5-4-final-state-signal-guard-convergence.md)
承接。实现提交 `ec14771` 让两个 runtime-image 入口共享最终状态 settlement，以 build
claim 在 pre-evidence 路径恢复唯一 immutable ID；cleanup 后经原生 event-loop turn 再交付
signal winner；正式 backup producer 直接进入 pre-fork owned-tree protocol；六个 critical
guard 由机器 registry 与活调用点 mutant 逐项证明。固定 Node.js `v24.18.0` 的 scripts
tests 为 **157/157**，runtime image 正向门禁与 **1 baseline + 17 built + 2 static-only**
mutation 已通过；同一候选也已从步骤 1 串行通过完整 `stage09a:check` **14/14**。第一次
完整运行的一次 Stage08 audit ownership-channel 失败未在独立 audit 或第二次完整重跑
复现，仍交由独立审计判断。A/B 审计尚待本候选收尾；M5 未 Accepted、阶段
09A 未 Pass、远端 CI 无真实 run。
