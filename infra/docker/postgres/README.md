# PostgreSQL bootstrap（阶段 09A / M2A）

本目录建立数据库身份边界：cluster 角色、登录身份和对象归属。它**不是**业务
migration，不新增也不修改任何业务表结构，因此不进入
[`services/api/migrations/`](../../../services/api/migrations/)，也不写 migration ledger。

已冻结的 `0000`—`0004` 不得修改。业务结构如需变化，只能追加新 migration。

## 身份模型

登录身份与数据库内 NOLOGIN 角色分离。三个登录角色都是
`LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`，
并带显式 connection limit 与 `VALID UNTIL 'infinity'`。它们**除目标数据库的
`CONNECT` 外，没有任何直接授予的 schema/table/sequence/function 权限**，必须显式
`SET ROLE` 才能取得对应角色的权限。

`public` 与 `drizzle` schema 采用**严格基线**：`PUBLIC` 的 `USAGE`/`CREATE` 被显式
收回，`USAGE` 只显式授予 `meal_agent_app` 与 `meal_agent_backup`，`migrator` 作为
schema owner 无需授予。因此三个登录角色在 `SET ROLE` 之前对 `public` 没有有效
`USAGE`，基线也不再依赖 template 的默认 ACL。

| 登录角色 | 可进入 | connection limit | 用途 |
| --- | --- | --- | --- |
| `meal_agent_migration_login` | `meal_agent_migrator` | 4 | 应用 `0001`—最新 migration |
| `meal_agent_runtime_login` | `meal_agent_app` | 40 | API runtime 与 readiness |
| `meal_agent_backup_login` | `meal_agent_backup` | 8 | 完整导出（M4 落地生命周期） |

| NOLOGIN 角色 | BYPASSRLS | 能力 |
| --- | --- | --- |
| `meal_agent_migrator` | 是 | database owner，DDL |
| `meal_agent_app` | 否 | 受 RLS 约束的业务读写 |
| `meal_agent_backup` | 是 | 全库只读，不能写业务表或 DDL |

membership 恰好三条边，全部 `WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`。

`meal_agent_migrator` 与 `meal_agent_backup` 都是敏感的高权限角色：前者有 DDL 与
`BYPASSRLS`，后者能越过 FORCE RLS 读取全部家庭数据。二者都不得借用 API runtime
身份，也不得进入 API container。

目标数据库上 `PUBLIC` 的 `CONNECT` 与 `TEMPORARY` 已被收回；`meal_agent_app` 与
`meal_agent_backup` 都不持有 `TEMPORARY`。

## 两个作用域

- **cluster scope**（`cluster`、`logins`）连接明确的 maintenance/control 数据库
  （默认 `postgres`），只处理六个 cluster 角色、role config、membership 与口令。
  **不要求目标数据库存在**，也不修改任何目标数据库 ACL。
- **database scope**（`handoff`、`acl`、`grants`）只在目标 `meal_agent*` 数据库
  存在后运行，处理数据库 ACL、schema ACL、owner 交接与对象权限。

这样拆开之后，恢复路径可以复用 cluster scope 与 ACL 基线，而不必碰 `0000` 或
owner handoff。

## 执行顺序

全新安装：

```text
1. admin      bootstrap.sh cluster                              角色 + membership（早于 createdb）
2. admin      bootstrap.sh logins                               SCRAM 口令
3. admin      createdb meal_agent
4. admin      pnpm --filter @meal-agent/api db:bootstrap        原子应用冻结的 0000
5. admin      bootstrap.sh handoff --dbname meal_agent          owner 交接（0000-only）
6. admin      bootstrap.sh acl     --dbname meal_agent          ACL 基线
7. migration  pnpm --filter @meal-agent/api db:migrate          SET ROLE 应用 0001—最新
8. admin      bootstrap.sh grants  --dbname meal_agent          备份角色补授
9. runtime    readiness                                         SET LOCAL ROLE meal_agent_app
```

`cluster` 与 `logins` 刻意排在 `createdb` **之前**：它们连 maintenance 数据库，
不要求目标库存在。

恢复（M4 实现，本轮只登记约束）：

```text
1. admin      bootstrap.sh cluster
2. admin      bootstrap.sh logins
3. admin      createdb --owner=meal_agent_migrator meal_agent
4. operator   pg_restore
5. admin      bootstrap.sh acl     --dbname meal_agent
6. migration  pnpm db:migrate                       应用备份之后新增的 migration
7. admin      bootstrap.sh grants  --dbname meal_agent
8. 验证       readiness / owner / GRANT / RLS / checksum
```

恢复路径**不**执行 `0000`，也**不**执行 owner handoff：dump 已经带着正确的
owner，重跑只会制造漂移。

第 4 步必须由 cluster admin 执行：冻结的 `0000` 自身要 `CREATE ROLE` 并设置
`BYPASSRLS`，此时切换到 `meal_agent_migrator` 还拿不到这些能力。这是如实记录的
cluster-admin 边界，不伪装成最小权限步骤。

第 5 步是硬前置：`0002_stage_08_audit_closeout.sql` 含
`REVOKE CREATE ON SCHEMA public FROM PUBLIC`，只有 `public` schema 的 owner 才能
执行。未做 owner 交接时，migration login 无法应用到 `0002`。

## 收敛性

每个阶段都可重复执行。`cluster` 阶段每次都把六个项目角色**完整规范化**回基线：
属性、role-level GUC 配置与 membership 图；`acl` 阶段收敛数据库/schema/对象权限。越界 membership 被逐条
撤销后重新授予目标边。因此重复 bootstrap 只会收敛权限，不会叠加权限。

两个容易踩空的地方已被显式处理：

- `ALTER ROLE x RESET ALL` 只清全局设置，不清 `ALTER ROLE x IN DATABASE d SET ...`
  留下的每库设置，因此按 catalog 逐条清理；
- `pg_auth_members` 的键是 `(roleid, member, grantor)`，不带 `GRANTED BY` 的
  `REVOKE` 只会删掉「由执行者授予」的那一行，因此按 catalog 逐行撤销并显式指定
  `GRANTED BY`。

## 用法

```bash
infra/docker/postgres/bootstrap.sh cluster
infra/docker/postgres/bootstrap.sh logins
infra/docker/postgres/bootstrap.sh handoff --dbname meal_agent
infra/docker/postgres/bootstrap.sh acl     --dbname meal_agent
infra/docker/postgres/bootstrap.sh grants  --dbname meal_agent
```

`--dbname` 只接受严格的 `meal_agent` 或 `meal_agent_<suffix>` 标识符；URI、
conninfo `key=value`、引号和大写一律拒绝。cluster scope 用 `--maintenance-db`
（默认 `postgres`）。每个阶段执行前都会核对 `current_database()` 与 admin 能力，
并检查所处的 migration ledger/owner 状态；连错库或顺序错误时 fail closed。

`acl` 在任何 mutation 之前验证 database / 三个 schema / 全部被管理 relation 与
routine 的 owner 都是 `meal_agent_migrator`；不符合时 fail closed，绝不在恢复路径
上偷偷接管归属。

`handoff` 是 **fresh-install 的 0000-only 步骤**：ledger 必须恰好只有 checksum
正确的 `0000_stage_06.sql`。`0001+`、断档、未知条目或错误 checksum 全部 fail
closed，因此它不支持「最新 migration 之后重跑」——可复用的是 `acl` 与 `grants`。

它的全部状态检查都先于任何归属变更：ledger 异常、异常 database owner、缺少
`0000` 建立的表、出现未管理的表/视图/序列/routine/类型、自定义 schema、
被管理对象归属未知角色，都会在**没有做过任何 ownership 变更**的情况下失败。
业务表与 `meal_agent_private` 函数的 owner 只验证、不接管。

每个 phase 的参数语法是精确的：不相关的 option、重复 option、缺 value 和多余
位置参数一律拒绝，不静默忽略也不「最后一个覆盖」。

连接参数走标准 `PG*` 环境变量。`logins` 阶段要求三个非空密码环境变量
（`MEAL_AGENT_MIGRATION_PASSWORD`、`MEAL_AGENT_RUNTIME_PASSWORD`、
`MEAL_AGENT_BACKUP_PASSWORD`）。

## 口令处理

口令由 psql 的 `\password` 在**客户端**生成 SCRAM-SHA-256 verifier，只把 verifier
放进 `ALTER USER`。原始口令不进入 SQL 文本、命令行参数、仓库、shell 历史或服务端
日志（已在开启 `log_statement=all` 的集群上用随机 sentinel 验证）。

两个 `\password` 的陷阱已被处理：

- 它的提示先尝试打开 `/dev/tty`，只有失败才回落到 stdin。因此在有控制终端的
  交互式 shell 里用管道喂口令会**永久阻塞且无任何错误**（macOS 普通 Terminal
  正是这种情况，且系统不带 `setsid`）。脚本因此统一在「无控制终端」的会话里
  执行 `\password`：优先用 util-linux 的 `setsid`，否则用仓库内的
  [`no-ctty.mjs`](no-ctty.mjs)——它只用 Node 标准库，`spawn(..., { detached: true })`
  在 POSIX 上即 `setsid(2)`，并透传子进程退出码。两者都没有时明确失败而不是挂死。
- 连接本身也用 `--no-password`：缺少 admin 凭据时立即失败，不会等待交互输入
  （连接口令提示有同样的 `/dev/tty` 缺陷）。
- 进入 `logins` 分支后、**第一次读取口令变量之前**就保存并关闭 xtrace，
  三个变量 `unset` 之后才恢复；有 `bash -x` + 合成 sentinel + 注定失败的 PSQL
  的回归测试，断言合并后的 stdout/stderr 零命中。
- 口令为空字符串时服务端会**清空**该角色口令并且 psql 仍退出 0，因此设置后强制
  回查 `pg_authid`，确认三个角色都真的持有 SCRAM verifier。

本目录不含任何真实凭据。Compose 服务、端口发布、secret file 注入和备份恢复生命
周期分别属于 M2B、M3 和 M4，本轮不实现。

## 验证

真实 PostgreSQL 18 的正向与反向验证见
[`stage09a.roles.database.test.ts`](../../../services/api/tests/database/stage09a.roles.database.test.ts)，
由 `pnpm --filter @meal-agent/api test:db` 执行。该测试启动**专用**集群，
`local` 走 trust、所有 TCP 登录强制 `scram-sha-256`，并开启服务端语句日志，
以便验证口令认证与日志中不出现明文。
