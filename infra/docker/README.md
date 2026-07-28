# local-test Compose 拓扑（阶段 09A / M2B）

[`compose.local-test.yaml`](compose.local-test.yaml) 是单机 local-test 部署拓扑。
它是可重复交付与私有测试的载体，**不是生产拓扑声明**；没有真实微信配置时，也不
得把它改名或表述为 staging/production（[ADR-0005](../../docs/architecture/decisions/0005-local-private-deployment-baseline.md) §1、§3）。

数据库身份边界本身属于 M2A，见[该目录 README](postgres/README.md)。

## 拓扑

```text
本机浏览器 / 客户端 / SSH tunnel
  └─ 127.0.0.1:<host port>
       └─ api（非 root 10001:10001，容器内 HOST=0.0.0.0）
            └─ meal-agent-local-test-internal（internal: true）
                 └─ postgres 18.4（named volume、healthcheck、无 host port）

postgres healthy
  ├─ bootstrap-*：只能显式调用的一次性 cluster-admin 任务
  └─ migrate：可重复运行的一次性 migration 任务
       └─ api 只在 migrate 成功退出后启动
```

两张网络的分工是刻意的：`meal-agent-local-test-internal` 声明 `internal: true`，
Compose 因此不为它接入网关——挂在上面的 postgres 与全部一次性任务既没有 host
port，也没有出站路径。`meal-agent-local-test-edge` 只承载 api 的那一个 loopback
publish。

## 服务

| 服务 | 镜像 | profile | 角色 |
| --- | --- | --- | --- |
| `postgres` | PostgreSQL 18.4（固定 digest） | 默认 | 数据库，named volume，不发布端口 |
| `bootstrap-cluster` | 同上 | `bootstrap` | `bootstrap.sh cluster`：六个角色与 membership |
| `bootstrap-logins` | 同上 | `bootstrap` | `bootstrap.sh logins`：三个登录角色的 SCRAM 口令 |
| `bootstrap-createdb` | 同上 | `bootstrap` | `createdb`：建立目标数据库 |
| `bootstrap-schema` | API 镜像 | `bootstrap` | `dist/database/bootstrap-0000.js`：原子应用冻结的 `0000` |
| `bootstrap-handoff` | PostgreSQL 18.4 | `bootstrap` | `bootstrap.sh handoff`：0000-only owner 交接 |
| `bootstrap-acl` | 同上 | `bootstrap` | `bootstrap.sh acl`：containment 阶段 ACL 基线 |
| `bootstrap-grants` | 同上 | `bootstrap` | `bootstrap.sh grants`：final 阶段备份补授 |
| `migrate` | API 镜像 | 默认 | `dist/database/migrate.js`：`SET ROLE` 应用 `0001`—最新 |
| `api` | API 镜像 | 默认 | Fastify 服务，只发布到 `127.0.0.1` |

bootstrap 全部挂在 `bootstrap` profile 下，因此 `docker compose up` 与任何普通
重启都**不会**再次执行它们。`migrate` 不在该 profile 内：它按 migration ledger
幂等，重复执行只补齐缺口，等锁与连接超时由 `migrate.ts` 的 `migrationLimits`
约束，因此是有界的。

### 为什么 bootstrap 是七个容器而不是一个

M2A 的全新安装顺序在 `bootstrap.sh`（psql）与 `db:bootstrap`（Node）之间来回
切换：`cluster` → `logins` → `createdb` 用 psql，`0000` 用 Node，`handoff` →
`acl` 又回到 psql。单个 bootstrap 容器因此必须同时具备 Node 与 psql。M2B **不**
为此构建混合高权限镜像，而是把每个阶段放进一个只用现成镜像的一次性容器：psql
阶段用固定 digest 的 PostgreSQL 官方镜像，`0000` 阶段用已 Accepted 的 API 镜像。
每个容器只拿它那一阶段需要的凭据，`depends_on: service_completed_successfully`
保证顺序，恢复路径（M4）也可以只复用其中的 `cluster` / `logins` / `acl`。

## 镜像固定

PostgreSQL 同时固定 exact patch tag 与不可变的多架构 manifest digest：

```text
docker.io/library/postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296
```

该 digest 由 `docker buildx imagetools inspect docker.io/library/postgres:18.4-bookworm`
解析真实镜像仓库得到，**不是**猜测值、搜索结果或本地未推送镜像的 RepoDigest。
它是 OCI image index 的摘要，index 内含 `linux/amd64`
（`sha256:16fa100a…`）与 `linux/arm64/v8`（`sha256:5803d5d7…`）。复核命令：

```bash
docker buildx imagetools inspect docker.io/library/postgres:18.4-bookworm --raw | shasum -a 256
```

版本判据是 exact-patch 的，覆盖整套工具链——容器内 `createdb`、`initdb`、
`pg_ctl`、`postgres`、`psql` 五个 banner 必须都是 18.4，混装一律拒绝。任何 patch
升级都必须重新 capture manifest、重跑 parity 并显式 rebaseline，不能只改 tag。

API 镜像由已 Accepted 的 [`services/api/Dockerfile`](../../services/api/Dockerfile)
以 monorepo 根为上下文构建，M2B 不修改它的安全基线。健康检查只用镜像自带的
`node`（Node 24 自带 `fetch`），不在运行期安装 `curl` 或任何软件包。

## 安全边界

所有服务统一 `read_only` 根文件系统、`cap_drop: [ALL]`、
`no-new-privileges:true`、非 root 用户、`restart: "no"` 与有界的 json-file 日志
轮转。全拓扑不使用 privileged、`network_mode: host`、Docker socket，也没有任何
宿主目录数据库 bind mount——唯一的 bind 是只读挂载仓库内 M2A bootstrap 资产。

PostgreSQL 直接以镜像自带的 `postgres`(999:999) 运行，因此 entrypoint 不需要 root，
也不需要 `CAP_SETUID`/`CAP_SETGID`/`CAP_CHOWN` 去降权；TCP 与 local 登录都强制
`scram-sha-256`。

## 凭据

Compose 里不出现任何口令或完整连接串的 environment value。全部凭据走 secret
file，契约见 [`secrets/README.md`](secrets/README.md)。

## 用法

```bash
node infra/docker/check-compose-topology.mjs
docker compose --file infra/docker/compose.local-test.yaml config
docker compose --file infra/docker/compose.local-test.yaml up -d postgres
```

全新安装（`bootstrap` 必须显式调用）：

```bash
docker compose --file infra/docker/compose.local-test.yaml --profile bootstrap up bootstrap-acl
docker compose --file infra/docker/compose.local-test.yaml up migrate
docker compose --file infra/docker/compose.local-test.yaml --profile bootstrap up bootstrap-grants
docker compose --file infra/docker/compose.local-test.yaml up -d api
```

`MEAL_AGENT_API_HOST_PORT` 可以改 host 端口，`MEAL_AGENT_DATABASE` 可以改目标
数据库名，`MEAL_AGENT_SECRETS_DIR` 可以把 secret 目录移到仓库之外。host publish
地址固定为 `127.0.0.1`，不接受变量覆盖。

## 静态门禁

[`check-compose-topology.mjs`](check-compose-topology.mjs) 断言的是
`docker compose config` **解析后**的配置：anchor、profile 与变量插值都已展开。
它覆盖服务集合与 profile 边界、一次性任务顺序、镜像固定、容器权限与逃逸面、
挂载、端口发布、网络隔离、健康检查依赖，以及「Compose 里不出现口令或完整连接
串、secret 文件未被 Git 跟踪且不可被 group/world 读取」。凭据按**最小权限**逐条
固定：`api` 只拿 runtime 连接串，`migrate` 只拿 migration 连接串，
`bootstrap-schema` 只拿 admin 连接串，`bootstrap-logins` 是唯一接触三个登录口令
的服务；api 一旦被塞进 admin / migration / backup 凭据即失败。Docker CLI 缺失时
它以「缺少前置工具」失败退出，不降级成纯文本检查后宣称通过。

把它并入 `pnpm stage09a:check` 属于 M5；M3 会再补运行期 Secret 与暴露级别断言。

## 当前边界

**拓扑已验证，完整 Secret 注入与全栈启动待 M3。**

`DATABASE_URL_FILE` 与 `MEAL_AGENT_*_PASSWORD_FILE` 是本拓扑**声明**的 M3 契约：
`services/api/src/config.ts` 目前只接受 `DATABASE_URL`，`postgres/bootstrap.sh`
目前只接受 `MEAL_AGENT_*_PASSWORD` 三个 environment value。M2B 不为了让这些
服务跑起来而写入临时明文，也不修改 M1/M2A 已冻结的实现，因此 `api`、`migrate`、
`bootstrap-schema` 与 `bootstrap-logins` 现在会 fail closed。

备份与恢复命令属于 M4，本拓扑不声明。`infra/environments/` 配置模板属于 M3。
