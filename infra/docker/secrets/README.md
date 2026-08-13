# local-test secret file 契约（阶段 09A）

[`../compose.local-test.yaml`](../compose.local-test.yaml) 的全部凭据都通过本目录
下的 secret file 注入。仓库里**只有**本说明与 `.gitignore` 是跟踪文件；任何真实
凭据都不得进入 Git，也不得作为 Compose 的 environment value 出现。

目录位置可以用 `MEAL_AGENT_SECRETS_DIR` 覆盖，指向仓库之外的受限目录。

| secret 名 | 文件名 | 消费者 | 现状 |
| --- | --- | --- | --- |
| `postgres_superuser_password` | `postgres_superuser_password` | `secret-materializer` → `postgres` | 官方镜像通过物化后的 `POSTGRES_PASSWORD_FILE` 消费 |
| `postgres_admin_pgpass` | `postgres_admin.pgpass` | `secret-materializer` → 所需 `bootstrap-*` | libpq 通过物化后的 `PGPASSFILE` 消费 |
| `meal_agent_migration_password` | `meal_agent_migration_password` | `secret-materializer` → `bootstrap-logins` | `postgres/secret-source.sh` |
| `meal_agent_runtime_password` | `meal_agent_runtime_password` | `secret-materializer` → `bootstrap-logins` | 同上 |
| `meal_agent_backup_password` | `meal_agent_backup_password` | `secret-materializer` → `bootstrap-logins` / `backup` | 登录创建与专用备份服务分别最小可见 |
| `meal_agent_admin_database_url` | `meal_agent_admin_database_url` | `secret-materializer` → `bootstrap-schema` / `restore` | schema 与专用 restore service 分别消费 |
| `meal_agent_migration_database_url` | `meal_agent_migration_database_url` | `secret-materializer` → `migrate` | `src/config-source.ts` |
| `meal_agent_runtime_database_url` | `meal_agent_runtime_database_url` | `secret-materializer` → `api` | 同上 |

## 文件判据（M3A，fail closed）

Node 侧的 [`services/api/src/config-source.ts`](../../../services/api/src/config-source.ts)
与 shell 侧的 [`../postgres/secret-source.sh`](../postgres/secret-source.sh) 使用
**同一套**判据，任何一条不满足都拒绝，且**绝不**回落到另一个来源：

- 路径必须是绝对路径；
- 不接受 symlink，必须是普通文件（目录、FIFO、socket、设备一律拒绝）；
- 链接数必须为 1——同一份内容存在第二个名字即拒绝；
- 属主必须等于当前进程的 effective UID；
- 权限只允许 owner-only 的 `0400`（只读）或 `0600`（读写）：group/world 的任何位、owner 的执行位、
  setuid/setgid/sticky 全部拒绝；
- 不超过 4096 字节；
- 内容非空、合法 UTF-8、无 NUL、无 BOM、无 CR、单行；
- **最多移除一个末尾 LF，除此之外不做任何 trim**：前后空格与
  `:` `\` `@` `/` `#` `%` 都逐字节保留。

`<NAME>` 与 `<NAME>_FILE` 互斥：两者都缺、两者同时出现（**内容相同也拒绝，从不
比较取值**）、空的 `<NAME>`、空的 `<NAME>_FILE` 一律 fail closed。

生成这些文件（M3B）：**只用 generator，不再手写**——它只生成四个原始 CSPRNG
口令，八个文件由同一份事实源
[`../local-test-secrets-contract.mjs`](../local-test-secrets-contract.mjs)
派生，避免 URL/pgpass 与口令文件互相漂移：

```bash
node infra/docker/generate-local-test-secrets.mjs
```

部署（任何数据库容器启动）之前必须通过交叉一致性预检：

```bash
node infra/docker/preflight-local-test-secrets.mjs
```

两条命令都接受 `--directory <绝对路径>`。如确需手工修补（不推荐），用
`printf '%s'` 避免多写末尾换行——一个末尾 LF 被接受，两个会被拒绝——改完必须
重新过预检。

## 权限

secret file 必须只对创建者可读：

```bash
chmod 600 infra/docker/secrets/*
```

Compose 非 swarm 的 file-backed secret 本质是 bind mount，不能依赖 Desktop 的 UID
呈现作为原生 Linux 契约。当前拓扑让唯一 `secret-materializer` 读取八份 raw source，
再把每份内容写入独立 named volume 的 `value`：PostgreSQL/运维侧 owner UID 999，API
侧 owner UID 10001，mode 0600、普通文件、nlink=1、非 symlink。其余服务只读挂载
自己需要的 materialized volume，不再直接看到宿主 file source。容器内证据由
`node infra/docker/probe-compose-secret-identity.mjs` 对八份文件逐一取得；宿主 stat
不作数。`postgres_admin.pgpass` 还额外受 libpq 自身的 mode 检查约束。
八份 secret 的**交叉一致性预检**（三个 URL、三个口令与 pgpass 必须描述同一个
数据库与同一批角色）由 `preflight-local-test-secrets.mjs` 承担（M3B，
M3B 已于 2026-08-11 Accepted，验收落点 `cf43452`；M3B 验收时点尚未完成 M4/M5 与 09A 总验收）。

## 备份与恢复

备份由专用 `backup` service 执行，只挂载 backup 口令；dump 先写入 UID 999 所有的
`backup-transfer` volume，再由 scoped one-shot 通过 `docker cp` 交给宿主写入 partial
文件并原子完成。恢复时先在宿主校验 SHA-256，再把字节经 stdin 送入无网络的
`backup-transfer-loader`，最后由只挂 admin URL 的专用 `restore` service 执行。
这条链不复用 `bootstrap-logins`，也不把 admin/migration/runtime 口令交给 backup。
