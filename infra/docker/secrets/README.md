# local-test secret file 契约（阶段 09A）

[`../compose.local-test.yaml`](../compose.local-test.yaml) 的全部凭据都通过本目录
下的 secret file 注入。仓库里**只有**本说明与 `.gitignore` 是跟踪文件；任何真实
凭据都不得进入 Git，也不得作为 Compose 的 environment value 出现。

目录位置可以用 `MEAL_AGENT_SECRETS_DIR` 覆盖，指向仓库之外的受限目录。

| secret 名 | 文件名 | 消费者 | 现状 |
| --- | --- | --- | --- |
| `postgres_superuser_password` | `postgres_superuser_password` | `postgres` | **已可用**：官方镜像自带 `POSTGRES_PASSWORD_FILE` |
| `postgres_admin_pgpass` | `postgres_admin.pgpass` | 六个 `bootstrap-*` psql 任务 | **已可用**：libpq 自带 `PGPASSFILE` |
| `meal_agent_migration_password` | `meal_agent_migration_password` | `bootstrap-logins` | **待 M3**：`bootstrap.sh` 目前只读 `MEAL_AGENT_MIGRATION_PASSWORD` |
| `meal_agent_runtime_password` | `meal_agent_runtime_password` | `bootstrap-logins` | **待 M3**：同上 |
| `meal_agent_backup_password` | `meal_agent_backup_password` | `bootstrap-logins` | **待 M3**：同上 |
| `meal_agent_admin_database_url` | `meal_agent_admin_database_url` | `bootstrap-schema` | **待 M3**：`config.ts` 目前只读 `DATABASE_URL` |
| `meal_agent_migration_database_url` | `meal_agent_migration_database_url` | `migrate` | **待 M3**：同上 |
| `meal_agent_runtime_database_url` | `meal_agent_runtime_database_url` | `api` | **待 M3**：同上 |

「待 M3」表示 Compose 已经声明该契约，但被消费的代码尚未实现 `_FILE` 读取。
M2B **不**为了让这些服务跑起来而写入临时明文，也不修改 M1/M2A 已冻结的
`services/api/src/config.ts` 与 `postgres/bootstrap.sh`；因此这些服务当前会
fail closed。互斥注入（`DATABASE_URL` 与 `DATABASE_URL_FILE` 同时出现即失败）
同样属于 M3。

## 权限

secret file 必须只对创建者可读：

```bash
chmod 600 infra/docker/secrets/*
```

已知的 M3 事项：Compose 在非 swarm 模式下把 secret 直接 bind mount 进容器，
宿主文件权限原样带入。`postgres_admin.pgpass` 由容器内的 `postgres`(999) 读取，
而 libpq 会拒绝 group/world 可读的 `.pgpass`，因此 M3 必须一并确定这类 secret
的属主与 mode 方案（例如改用容器内可读的专用属主，或改走 conninfo service file）。

## 备份与恢复

备份与恢复使用的独立 operator 凭据属于 M4，本目录与 Compose 当前都不声明。
