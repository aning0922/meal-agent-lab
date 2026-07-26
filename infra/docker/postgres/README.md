# PostgreSQL bootstrap（阶段 09A / M2A）

本目录建立数据库身份边界：cluster 角色、登录身份和对象归属。它**不是**业务
migration，不新增也不修改任何业务表结构，因此不进入
[`services/api/migrations/`](../../../services/api/migrations/)，也不写 migration ledger。

已冻结的 `0000`—`0004` 不得修改。业务结构如需变化，只能追加新 migration。

## 身份模型

登录身份与数据库内 NOLOGIN 角色分离。三个登录角色都是
`LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`，
自身不持有任何业务对象权限，必须显式 `SET ROLE` 才能取得对应角色的权限。

| 登录角色 | 可进入 | 用途 |
| --- | --- | --- |
| `meal_agent_migration_login` | `meal_agent_migrator` | 应用 `0001`—最新 migration |
| `meal_agent_runtime_login` | `meal_agent_app` | API runtime 与 readiness |
| `meal_agent_backup_login` | `meal_agent_backup` | 完整导出（M4 落地生命周期） |

| NOLOGIN 角色 | BYPASSRLS | 能力 |
| --- | --- | --- |
| `meal_agent_migrator` | 是 | database owner，DDL；由 `0000` 创建 |
| `meal_agent_app` | 否 | 受 RLS 约束的业务读写；由 `0000` 创建 |
| `meal_agent_backup` | 是 | 全库只读，不能写业务表或 DDL；由本目录创建 |

`meal_agent_migrator` 与 `meal_agent_backup` 都是敏感的高权限角色：前者有 DDL 与
`BYPASSRLS`，后者能越过 FORCE RLS 读取全部家庭数据。二者都不得借用 API runtime
身份，也不得进入 API container。

## 执行顺序

```text
1. admin      createdb
2. admin      apply 0000            （migration runner，不切换 role）
3. admin      bootstrap.sh handoff  （database/public/drizzle/ledger owner 交接）
4. admin      bootstrap.sh logins   （建立登录角色）
5. migration  apply 0001—最新       （显式 SET ROLE meal_agent_migrator）
6. admin      bootstrap.sh grants   （备份角色只读补授）
7. runtime    readiness             （显式 SET LOCAL ROLE meal_agent_app）
```

第 3 步是硬前置：`0001` 起包含 `REVOKE CREATE ON SCHEMA public FROM PUBLIC`，
只有 `public` schema 的 owner 才能执行。未做 owner 交接时，migration login 无法
应用 `0001`。

第 2 步必须由 cluster admin 执行：冻结的 `0000` 自身要 `CREATE ROLE` 并设置
`BYPASSRLS`，此时 `meal_agent_migrator` 尚不存在，无法先切换过去。这是如实记录的
cluster-admin 边界，不伪装成最小权限步骤。

全部阶段可重复执行：角色属性与 membership 每次都被重申为基线，越界 membership
被显式收回，因此重复 bootstrap 只会收敛权限，不会扩大权限。

## 用法

```bash
infra/docker/postgres/bootstrap.sh handoff --dbname meal_agent
infra/docker/postgres/bootstrap.sh logins  --dbname meal_agent
infra/docker/postgres/bootstrap.sh grants  --dbname meal_agent
```

连接参数走标准 `PG*` 环境变量。`logins` 阶段要求三个非空密码环境变量
（`MEAL_AGENT_MIGRATION_PASSWORD`、`MEAL_AGENT_RUNTIME_PASSWORD`、
`MEAL_AGENT_BACKUP_PASSWORD`）。密码只经环境传入，不进入命令行、仓库或 psql
历史；本目录不含任何真实凭据。

Compose 服务、端口发布、secret file 注入和备份恢复生命周期分别属于 M2B、M3 和
M4，本轮不实现。

## 验证

真实 PostgreSQL 18 的正向与反向验证见
[`stage09a.roles.database.test.ts`](../../../services/api/tests/database/stage09a.roles.database.test.ts)，
由 `pnpm --filter @meal-agent/api test:db` 执行。
