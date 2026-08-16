# local-test 生命周期、备份与恢复 runbook（阶段 09A / M4）

本文是 local-test 单机 Compose 部署的操作手册：生命周期命令、备份、恢复与
销毁。拓扑与安全边界见 [`infra/docker/README.md`](../../infra/docker/README.md)，
数据库身份边界见 [`infra/docker/postgres/README.md`](../../infra/docker/postgres/README.md)。
以下命令全部在仓库根目录执行；`docker compose` 命令默认作用于 compose 文件
自带的 project（`meal-agent-local-test`），并行 worktree 必须换 `--project-name`。

本文只描述 local-test。它不是生产 runbook：**只记录本地演练的真实耗时**（由两
个演练脚本逐阶段打印），**不声明任何 RPO/RTO**——那属于未来真实部署环境的
工作。

阶段级验证入口是 M5 的 `pnpm stage09a:check`（一条命令串联 stage08、全部容器
门禁、镜像扫描与本文的两条演练；`-- --keep-failure` 显式保留失败现场）。本文
的价值在**运维**：单独执行某条命令做诊断、备份或恢复时按下文操作。

## 1. 生命周期命令

### 构建镜像

```bash
docker compose --file infra/docker/compose.local-test.yaml build api
```

### 从空 volume 初始化（全新安装）

前置：先生成八份 Secret 并通过预检（已有 bundle 时跳过生成）：

```bash
node infra/docker/generate-local-test-secrets.mjs
node infra/docker/preflight-local-test-secrets.mjs
```

全新安装链（`bootstrap` profile 必须显式调用；顺序即依赖）:

```bash
docker compose --file infra/docker/compose.local-test.yaml --profile materialize up secret-materializer
docker compose --file infra/docker/compose.local-test.yaml up -d postgres
docker compose --file infra/docker/compose.local-test.yaml --profile bootstrap up bootstrap-acl
docker compose --file infra/docker/compose.local-test.yaml up migrate
docker compose --file infra/docker/compose.local-test.yaml --profile bootstrap up bootstrap-grants
```

`secret-materializer` 是八份 host file-backed Secret 的唯一直接消费者；它先把每份
内容写成消费 UID 999/10001 所有、mode 0600 的独立 named-volume 文件。之后
`bootstrap-acl` 会经 `depends_on` 依次拉起 `cluster → logins → createdb →
schema(0000) → handoff`；`migrate` 按 ledger 幂等应用 `0001`—最新。

### 启动 API 与健康检查

```bash
docker compose --file infra/docker/compose.local-test.yaml up -d api
```

```bash
curl -sS http://127.0.0.1:3000/healthz
```

```bash
curl -sS http://127.0.0.1:3000/readyz
```

`/healthz` 只证明进程存活；`/readyz` 才检查数据库、migration ledger 与
checksum。host 端口可用 `MEAL_AGENT_API_HOST_PORT` 改。

### 停止并重启（数据仍在）

```bash
docker compose --file infra/docker/compose.local-test.yaml stop --timeout 30
```

```bash
docker start meal-agent-local-test-postgres-1 meal-agent-local-test-api-1
```

`stop` 发 SIGTERM：API 的优雅关机在时限内完不成时会**真正强制退出**（退出码
1，见 `services/api/src/shutdown.ts`；容器侧优雅路径应为退出码 0）。这里刻意对
两个**已经存在的常驻容器**执行精确 `docker start`；不能使用
`docker compose start postgres api`，因为 Compose 会沿 `depends_on` 重新启动已
成功退出的 one-shot `secret-materializer`。数据落在
named volume 上，`stop`/`start` 与 `down`（不带 `--volumes`）都不会动它：

```bash
docker compose --file infra/docker/compose.local-test.yaml down
```

之后重新 `up -d postgres`、`up migrate`（幂等 no-op）、`up -d api` 即可恢复
服务，数据仍在。

注意：PostgreSQL 镜像声明了 `VOLUME /var/lib/postgresql`，因此**用该镜像的**
一次性容器（psql 类 bootstrap 阶段；API 镜像的 `bootstrap-schema` 与 `migrate`
不在内）每个都会带一个**匿名**卷；裸 `down` 删容器时会把这些匿名卷孤儿化
（named 数据卷不受影响）。要 down 而不留孤儿，先删容器再收网络：

```bash
docker compose --file infra/docker/compose.local-test.yaml stop --timeout 30
```

```bash
docker ps -aq --filter label=com.docker.compose.project=meal-agent-local-test | xargs docker rm -v
```

```bash
docker compose --file infra/docker/compose.local-test.yaml down
```

已经产生的孤儿匿名卷用 `docker volume ls -f dangling=true` 查看后逐个删除。

### 销毁本阶段专用测试资源

```bash
docker compose --file infra/docker/compose.local-test.yaml down --volumes --remove-orphans
```

`--volumes` 会删除数据卷——这是**销毁**，不是重启。Secret 目录与备份目录不归
Compose 管，需要时单独删除。

### 一条命令的自动化演练

上述整个生命周期（含停止/重启后的数据保留断言与销毁后的零残留复查）由演练
脚本自动化，逐阶段打印真实耗时：

```bash
node infra/docker/run-local-test-lifecycle.mjs
```

## 2. 备份

```bash
node infra/docker/backup-local-test.mjs
```

- 以 `meal_agent_backup_login` 连接、`--role=meal_agent_backup` 执行
  `pg_dump --format=custom`。备份角色带 `BYPASSRLS`，因此 FORCE RLS 表被完整
  导出；权限不足的角色去 dump 会**响亮失败**（服务器的 row-level security
  错误），不会拿到一份被静默截断的备份。
- `backup` 是专用 one-shot，只挂载 backup Secret。dump 先写入 UID 999 所有的
  `backup-transfer` volume，再由带 ownership label 的 stopped one-shot 经
  `docker cp` 复制到宿主 partial 文件；不会复用 `bootstrap-logins`，也不会接触
  admin/migration/runtime 口令。
- 输出落在 [`infra/docker/backups/`](../../infra/docker/backups/README.md)
  （被 `.gitignore` 排除；`--output-dir` 可改，目录必须在仓库外或被 Git 忽略，
  否则拒绝执行）。
- 备份完成后写 `<dump>.sha256` sidecar（`shasum -a 256 -c` 兼容）。
- 执行前后打印目标环境与数据库标识；口令与连接串不出现在任何输出里。

## 3. 恢复

**`pg_dump` 不包含 cluster roles**：六个项目角色、role config、membership 与
SCRAM 口令都属于 cluster，不在 dump 里。因此「从 dump 恢复」与「全新安装」的
bootstrap 顺序不同——恢复路径必须先由 bootstrap 重建角色，然后**跳过**
`0000`（schema）与 owner handoff（dump 自带正确 owner，重跑只会制造漂移）：

| 步骤 | 全新安装 | 从 dump 恢复 |
| --- | --- | --- |
| Secret 物化 | `secret-materializer` | `secret-materializer` |
| cluster 角色 + membership | `bootstrap-cluster` | `bootstrap-cluster` |
| 登录角色 SCRAM 口令 | `bootstrap-logins` | `bootstrap-logins` |
| 建库 | `bootstrap-createdb`（owner 为 admin） | `createdb --owner=meal_agent_migrator`（由恢复入口执行） |
| schema | `bootstrap-schema`（冻结 `0000`） | **跳过**——内容来自 `pg_restore` |
| owner 交接 | `bootstrap-handoff` | **跳过**——dump 自带 owner |
| ACL 基线 | `bootstrap-acl` | `bootstrap-acl` |
| migration | `migrate`（`0001`—最新） | `migrate`（补齐备份之后新增的 migration；同一 ledger 时为 no-op） |
| 备份角色补授 | `bootstrap-grants` | `bootstrap-grants` |
| 验证 | readiness | readiness / owner / GRANT / RLS / checksum |

在**全新 cluster**（新的空 volume）上：

```bash
docker compose --file infra/docker/compose.local-test.yaml --profile materialize up secret-materializer
docker compose --file infra/docker/compose.local-test.yaml up -d postgres
docker compose --file infra/docker/compose.local-test.yaml --profile bootstrap up bootstrap-cluster
docker compose --file infra/docker/compose.local-test.yaml --profile bootstrap up bootstrap-logins
```

```bash
node infra/docker/restore-local-test.mjs --dump infra/docker/backups/<name>.dump
```

恢复入口的硬边界：

- **恢复前先校验 SHA-256 sidecar**：dump 路径解析不到普通文件、sidecar 缺失、
  sidecar 格式不可解析、sidecar 记载的文件名不配对、摘要不匹配、文件不带
  `pg_dump` 自定义格式魔数——任一情形都以各自的固定理由拒绝（理由清单见
  `infra/docker/restore-local-test.mjs` 导出的常量），此时 `pg_restore` 根本
  不会被调用；
- checksum 与 archive/TOC 判据通过后，宿主持有同一份已验证字节快照，并直接把它经
  stdin 送给专用 `restore` service 的 `pg_restore`；恢复路径不会重新打开调用方路径，
  也不会把 `backup-transfer` volume 当作恢复证据源。`restore` 只使用物化后的
  `postgres_admin.pgpass` 连接目标库，宿主路径不会直接 bind 进 PostgreSQL 工具容器。
  `backup-transfer-loader` 与 transfer volume 仍是备份链的无凭据 ferry/声明兼容面，
  不是当前恢复实现的数据来源；
- 目标数据库必须不存在（恢复只进全新库，绝不覆盖既有数据）；
- `createdb --owner=meal_agent_migrator` 后执行
  `pg_restore --single-transaction --exit-on-error`：恢复内容要么全部提交，
  要么整体回滚。`createdb` 在该事务**之外**——pg_restore 失败时留下的是一个
  空的 `meal_agent` 库（无业务对象），重跑会被「已存在」响亮拒绝，按 §4 的
  指引销毁后重来。template 带来的 `public` schema **保留不删**：PostgreSQL
  15+ 的 `pg_dump` 对 `public` 刻意不发 `CREATE SCHEMA`（假定 initdb 已建），
  只发 `ALTER SCHEMA public OWNER TO meal_agent_migrator` 与 ACL——删掉它会让
  恢复在 ALTER OWNER 上直接失败。

然后补齐恢复路径其余阶段并验证。`bootstrap-acl` 必须带 `--no-deps`：它的
`depends_on` 直通 `handoff → schema → createdb`，裸 `up` 会把上表声明**跳过**
的步骤拉起来（实测响亮失败——`createdb` 撞上已存在的库；演练跑一次性服务
一律用 `--no-deps` 形态）：

```bash
docker compose --file infra/docker/compose.local-test.yaml --profile bootstrap up --no-deps bootstrap-acl
docker compose --file infra/docker/compose.local-test.yaml up migrate
docker compose --file infra/docker/compose.local-test.yaml --profile bootstrap up bootstrap-grants
docker compose --file infra/docker/compose.local-test.yaml up -d api
```

```bash
curl -sS http://127.0.0.1:3000/readyz
```

### 恢复演练（自动化证据）

```bash
node infra/docker/run-local-test-restore-drill.mjs
```

演练在两个每轮唯一的栈上做同一 ledger 的完整 round-trip，并逐条断言计划书
M4 的恢复判据：合成 sentinel（含两个家庭）授权可读、篡改过的备份在
`pg_restore` 之前被拒、恢复后 ledger/checksum 与磁盘一致、`/readyz` 通过、
runtime 不能绕 RLS 或 DDL、database owner 为 `meal_agent_migrator` 且全部
owner / `SECURITY DEFINER` / GRANT / RLS / policy / 角色属性 / membership 与
备份前逐字一致。

### 受支持的恢复 ledger 窗口

授权 manifest 按 `(ledger, phase)` 登记 containment / final 两个阶段的期望
（[ADR-0005 §2.4](../architecture/decisions/0005-local-private-deployment-baseline.md)）。
**受支持的恢复窗口至少覆盖 N-1**：窗口内每个已发布 ledger 都必须在 manifest
里保留对应的 containment 状态——删除旧状态等于宣布该窗口的 dump 不再可恢复
（`bootstrap-acl` 会在 `pg_restore` 之后对着旧 ledger fail closed），属于需要
显式决策的破坏性变更。当前只存在一个已发布 ledger（`0000`—`0004`），演练验证
的是它自己的 round-trip；`0005` 出现后，演练必须扩展为
`cluster → createdb --owner → pg_restore`（N-1 ledger）`→ containment →
db:migrate`（补齐到当前 ledger）`→ final → 验证`。

## 4. 故障与残留

- 两个演练脚本在正常、失败、信号三条路径上共用同一套 scoped cleanup 与独立
  residue 复查；`--keep-failure` 只在失败时保留现场（含合成凭据的临时 Secret
  目录，检查完必须手工删除）。
- 备份/恢复入口操作的是**长驻**部署，不做自动清理；恢复失败时单事务已整体
  回滚（留下的空 `meal_agent` 库见 §3），重跑前先用 `psql` 确认 `meal_agent`
  是否存在，存在即按销毁流程处理后重来。
- 备份先把 handoff 写入备份目录内本轮独占的 0700
  `.meal-agent-backup-*/<name>.partial`，再按 inode 身份用 no-replace 发布 dump 和
  sidecar；普通失败会删除本轮 partial/dump/sidecar。进程被强杀（SIGKILL）时清理
  不会执行，发现残留的 `.meal-agent-backup-*` 目录应按精确路径删除——其中可能是
  **含真实数据的半份导出**，不得提交、上传或打开回显。
- 入口的 SIGINT/SIGTERM 处置会先终止 client 子进程，再强制移除 daemon 侧仍在
  跑的一次性容器（连同匿名卷）；信号在飞时主流程不自行 exit，处置完成后按原
  信号语义退出（`128+signo`）。因此被取消的备份/恢复不会在后台悄悄跑完——
  唯一的例外是移除本身失败，此时残留会以 residue 警告打印出来，按打印的容器
  名手工 `docker rm -f -v`。正常失败路径 exit 前也会补一次同样的清扫。
- Docker 不可用时所有入口都以「缺少前置工具」失败，不降级成静态检查。
