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

> `public` schema 的 `USAGE` 来自 PostgreSQL 对 `PUBLIC` 的默认授予，对所有角色
> 一视同仁，不是对登录角色的直接授予。本阶段没有改动该默认。

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

## 执行顺序

```text
1. admin      createdb
2. admin      bootstrap.sh roles              角色基线（可在冻结 0000 之前执行）
3. admin      bootstrap.sh logins             SCRAM 口令
4. admin      db:migrate -- --bootstrap-0000  应用冻结的 0000
5. admin      bootstrap.sh handoff            database/public/drizzle/ledger owner 交接
6. migration  db:migrate                      显式 SET ROLE meal_agent_migrator 应用 0001—最新
7. admin      bootstrap.sh grants             备份角色只读补授
8. runtime    readiness                       事务内 SET LOCAL ROLE meal_agent_app
```

第 4 步必须由 cluster admin 执行：冻结的 `0000` 自身要 `CREATE ROLE` 并设置
`BYPASSRLS`，此时切换到 `meal_agent_migrator` 还拿不到这些能力。这是如实记录的
cluster-admin 边界，不伪装成最小权限步骤。

第 5 步是硬前置：`0001` 起包含 `REVOKE CREATE ON SCHEMA public FROM PUBLIC`，
只有 `public` schema 的 owner 才能执行。未做 owner 交接时，migration login 无法
应用 `0001`。

`roles` 阶段刻意可以独立、提前执行。M4 的恢复流程将复用它来预建 dump 引用的
角色；恢复时**不得**在已有 dump 目标上重跑 `0000`，也不得对 dump 已经建立的
对象重跑 owner handoff。本轮不实现任何恢复流程。

## 收敛性

每个阶段都可重复执行。`roles` 阶段每次都把六个项目角色**完整规范化**回基线：
属性、role-level GUC 配置、membership 图和数据库级权限；越界 membership 被逐条
撤销后重新授予目标边。因此重复 bootstrap 只会收敛权限，不会叠加权限。

两个容易踩空的地方已被显式处理：

- `ALTER ROLE x RESET ALL` 只清全局设置，不清 `ALTER ROLE x IN DATABASE d SET ...`
  留下的每库设置，因此按 catalog 逐条清理；
- `pg_auth_members` 的键是 `(roleid, member, grantor)`，不带 `GRANTED BY` 的
  `REVOKE` 只会删掉「由执行者授予」的那一行，因此按 catalog 逐行撤销并显式指定
  `GRANTED BY`。

## 用法

```bash
infra/docker/postgres/bootstrap.sh roles   --dbname meal_agent
infra/docker/postgres/bootstrap.sh logins  --dbname meal_agent
infra/docker/postgres/bootstrap.sh handoff --dbname meal_agent
infra/docker/postgres/bootstrap.sh grants  --dbname meal_agent
```

`--dbname` 只接受严格的 `meal_agent` 或 `meal_agent_<suffix>` 标识符；URI、
conninfo `key=value`、引号和大写一律拒绝。每个阶段执行前都会核对
`current_database()` 与 admin 能力，并检查所处的 migration ledger/owner 状态；
连错库或顺序错误时 fail closed。

连接参数走标准 `PG*` 环境变量。`logins` 阶段要求三个非空密码环境变量
（`MEAL_AGENT_MIGRATION_PASSWORD`、`MEAL_AGENT_RUNTIME_PASSWORD`、
`MEAL_AGENT_BACKUP_PASSWORD`）。

## 口令处理

口令由 psql 的 `\password` 在**客户端**生成 SCRAM-SHA-256 verifier，只把 verifier
放进 `ALTER USER`。原始口令不进入 SQL 文本、命令行参数、仓库、shell 历史或服务端
日志（已在开启 `log_statement=all` 的集群上用随机 sentinel 验证）。

两个 `\password` 的陷阱已被处理：

- 它的提示先尝试打开 `/dev/tty`，只有失败才回落到 stdin。因此在有控制终端的
  交互式 shell 里用管道喂口令会**永久阻塞且无任何错误**。容器与 CI 没有控制
  终端，是正常路径；有控制终端时脚本优先用 `setsid` 脱离，没有 `setsid` 则明确
  失败而不是挂死。
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
