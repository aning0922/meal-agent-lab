# local-test secret file 契约（阶段 09A）

[`../compose.local-test.yaml`](../compose.local-test.yaml) 的全部凭据都通过本目录
下的 secret file 注入。仓库里**只有**本说明与 `.gitignore` 是跟踪文件；任何真实
凭据都不得进入 Git，也不得作为 Compose 的 environment value 出现。

目录位置可以用 `MEAL_AGENT_SECRETS_DIR` 覆盖，指向仓库之外的受限目录。

| secret 名 | 文件名 | 消费者 | 现状 |
| --- | --- | --- | --- |
| `postgres_superuser_password` | `postgres_superuser_password` | `postgres` | **已可用**：官方镜像自带 `POSTGRES_PASSWORD_FILE` |
| `postgres_admin_pgpass` | `postgres_admin.pgpass` | 六个 `bootstrap-*` psql 任务 | **已可用**：libpq 自带 `PGPASSFILE` |
| `meal_agent_migration_password` | `meal_agent_migration_password` | `bootstrap-logins` | **M3A 已实现**：`postgres/secret-source.sh` |
| `meal_agent_runtime_password` | `meal_agent_runtime_password` | `bootstrap-logins` | **M3A 已实现**：同上 |
| `meal_agent_backup_password` | `meal_agent_backup_password` | `bootstrap-logins` | **M3A 已实现**：同上 |
| `meal_agent_admin_database_url` | `meal_agent_admin_database_url` | `bootstrap-schema` | **M3A 已实现**：`src/config-source.ts` |
| `meal_agent_migration_database_url` | `meal_agent_migration_database_url` | `migrate` | **M3A 已实现**：同上 |
| `meal_agent_runtime_database_url` | `meal_agent_runtime_database_url` | `api` | **M3A 已实现**：同上 |

## 文件判据（M3A，fail closed）

Node 侧的 [`services/api/src/config-source.ts`](../../../services/api/src/config-source.ts)
与 shell 侧的 [`../postgres/secret-source.sh`](../postgres/secret-source.sh) 使用
**同一套**判据，任何一条不满足都拒绝，且**绝不**回落到另一个来源：

- 路径必须是绝对路径；
- 不接受 symlink，必须是普通文件（目录、FIFO、socket、设备一律拒绝）；
- 链接数必须为 1——同一份内容存在第二个名字即拒绝；
- 属主必须等于当前进程的 effective UID；
- 权限只允许 owner read/write（`0600`）：group/world 的任何位、owner 的执行位、
  setuid/setgid/sticky 全部拒绝；
- 不超过 4096 字节；
- 内容非空、合法 UTF-8、无 NUL、无 BOM、无 CR、单行；
- **最多移除一个末尾 LF，除此之外不做任何 trim**：前后空格与
  `:` `\` `@` `/` `#` `%` 都逐字节保留。

`<NAME>` 与 `<NAME>_FILE` 互斥：两者都缺、两者同时出现（**内容相同也拒绝，从不
比较取值**）、空的 `<NAME>`、空的 `<NAME>_FILE` 一律 fail closed。

生成这些文件：

```bash
umask 077
printf '%s' "$value" > infra/docker/secrets/meal_agent_runtime_password
chmod 600 infra/docker/secrets/*
```

`printf '%s'`（而不是 `echo`）可以避免多写一个末尾换行；写一个末尾 LF 也被接受，
写两个会被拒绝。

## 权限

secret file 必须只对创建者可读：

```bash
chmod 600 infra/docker/secrets/*
```

Compose 在非 swarm 模式下把 secret 直接 bind mount 进容器，宿主文件权限原样带入。
因此**属主必须与容器内消费进程的 UID 一致**：`postgres` 相关的文件由容器内的
`postgres`(999) 读取，API 镜像的文件由 `10001` 读取。`postgres_admin.pgpass` 还额外
受 libpq 自身的 mode 检查约束。八份 secret 的**属主/UID 编排与交叉一致性预检**
（三个 URL、三个口令与 pgpass 必须描述同一个数据库与同一批角色）属于 **M3B**，
本轮尚未实现。

## 备份与恢复

备份与恢复使用的独立 operator 凭据属于 M4，本目录与 Compose 当前都不声明。
