# ADR-0006：阶段 09A 外部证据与资源所有权协议

- 状态：Proposed
- 日期：2026-08-16
- 范围：阶段 09A M5 的 Docker/Compose、进程组、生命周期、备份与恢复门禁

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
- `pg_restore --create --list` 必须包含规范的目标 database 创建项；database properties
  若出现只能属于同一目标，且 declared/visible 条目计数必须符合 PostgreSQL 18 的
  固定头部差值，而不是接受任意非空字符串。

失败诊断只能使用固定错误码、可信 registry 名称和计数；不得回显外部键、路径、
stdout/stderr 或异常文本。

### 2. 所有权只来自不可变证据

名字、tag 和文件路径只是 locator，不是 ownership。一次操作在副作用前生成不可猜的
claim/generation；取得 immutable ID 后，后续检查、清理和发布只使用该 ID，并再次
验证 claim 与 scope。名字漂移只能导致保留外部对象并报告 residue，不能导致按名字
删除，也不能把 registry 条目静默退休。

无 immutable identity、claim、scope 或 provenance 任一项的记录都是不完整证据；
清理不得从可变 tag/path 重新推导所有权。

### 3. 正式 artifact 采用验证后发布

备份在私有 staging 中产生。容器源 digest、宿主字节、archive TOC、正式 dump 与
sidecar 必须绑定同一 Buffer/digest。正式路径使用 `O_EXCL|O_NOFOLLOW` 创建，成功前
最后复核 dev/ino、`nlink=1`、size、digest 和 sidecar 字节。任一 cleanup 或复核失败
都不能返回成功。

恢复必须在第一次数据库查询/创建之前，对已经 checksum 绑定的同一 Buffer 完成
archive TOC 预检。坏 archive 不得创建目标数据库；恢复阶段继续使用同一 Buffer，
不得重新按路径读取。

### 4. 进程与 lifecycle 采用 generation 状态机

PGID probe 只有 ESRCH 表示消失；EPERM 表示仍存在；其他异常是独立的 primitive
failure，必须保留到最终 settlement。one-shot 和常驻服务都在启动前拍 baseline，
启动后绑定 ID/image/project/service/StartedAt；旧 exited 对象或 foreign replacement
不能与本轮 status 0 拼成成功。

### 5. mutation 证据与生产 guard 同源

每个关键 guard 有稳定 ID、最小反例和期望固定理由。测试必须证明：

1. 正常实现命中指定 guard；
2. 删除或弱化该 guard 后，对应反例因“缺少指定 guard”失败；
3. earlier guard、未捕获异常或可同步改写的总计数不能冒充判别力。

## 后果

- M5 在本 ADR 实施完成并经两个全新独立 A/B 审计 CLEAN 前保持“已实现、待复核，
  未 Accepted”；阶段 09A 保持 In Progress。
- 共享 parser 与 ownership helper 会增加少量代码，但减少各入口独立解释同一外部
  证据的分叉。
- 同 EUID、能够在同步系统调用之间任意篡改内存或内核对象的攻击者仍不在 local-test
  威胁模型内；所有异步等待窗口、路径替换、tag 重绑和已登记资源 rename 必须覆盖。
- 本地 14/14 正向门禁不再单独构成 Accepted 证据；独立反例的判别力属于验收条件。

## 实施注记

2026-08-16 的当前工作分支候选在已提交实现 `d1e0ef5` 之上继续闭合本 ADR。BuildKit
构建期不发布可变 tag；provenance descriptor、selected manifest、Config/history 与
OCI layer replay 绑定同一 immutable identity。layer blob 以持续持有的只读 fd 消费，
验证 digest/DiffID 后按 whiteout、hardlink 与 PAX 规则形成最终 rootfs，并校验 runtime
payload owner/mode。Compose 的 14 服务、2 网络、10 volume 绑定 128-bit run claim，
显式 raw Secret name 不得跨 project 共享；service/one-off 后续取证只使用第一次强观察
取得的 container ID。status 0 与 stdin EPIPE 必须在整组 PGID 到达 ESRCH 后 settle。
备份的 archive-list、dump、sidecar 与正式发布绑定同一字节快照、fd/inode、uid/gid/mode，
TOC 按 PostgreSQL 18 的真实 database/declared/visible 文法验证。15 项 registry 仍只负责
生产调用点漂移索引，不代替动态反例和 mutation 判别力。该候选从步骤 1 串行通过
`pnpm stage09a:check` 14/14；脚本测试 114/114、Compose topology mutation 45/45、
runtime image mutation 1 baseline + 13 built + 2 static-only、M3B signal 5+6，且 fresh
smoke、八份 Secret identity、lifecycle 与 same-ledger restore 均通过。该证据只证明
本地实现候选；两个全新独立 A/B 审计、M5 Accepted、远端 CI 真实 run 和 09A 总验收
均未完成。
