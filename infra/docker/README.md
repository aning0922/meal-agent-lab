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
            └─ <project>_internal（internal: true）
                 └─ postgres 18.4（named volume、healthcheck、无 host port）

postgres healthy
  ├─ bootstrap-*：只能显式调用的一次性 cluster-admin 任务
  └─ migrate：可重复运行的一次性 migration 任务
       └─ api 只在 migrate 成功退出后启动
```

两张网络的分工是刻意的：`internal` 声明 `internal: true`，Compose 因此不为它接入
网关——挂在上面的 postgres 与全部一次性任务既没有 host port，也没有出站路径。
`edge` 只承载 api 的那一个 loopback publish。两张网络与数据卷的真实名称都由
Compose 的 project scope 决定（`<project>_internal` 等），见下方「并行 worktree」。

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
宿主目录数据库 bind mount。全拓扑只有**两类只读仓库 bind**：M2A 的 bootstrap
资产目录，以及**仅 `bootstrap-handoff` 可见**的那一个 exact `0000` 文件；数据库
数据落在 named volume 上，没有任何 host bind。

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

`MEAL_AGENT_API_HOST_PORT` 可以改 host 端口，`MEAL_AGENT_SECRETS_DIR` 可以把
secret 目录移到仓库之外。host publish 地址固定为 `127.0.0.1`，不接受变量覆盖。
非敏感配置模板见 [`infra/environments/local-test/`](../environments/local-test/README.md)。

### M3B：八份 Secret 与完整链的一条命令验证

两条**运维**命令：

| 命令 | 作用 |
| --- | --- |
| `node infra/docker/generate-local-test-secrets.mjs` | 生成八份 Secret（四个原始 CSPRNG 口令派生；默认拒绝覆盖；口令不进 stdout/argv/环境变量/Git） |
| `node infra/docker/preflight-local-test-secrets.mjs` | 部署前交叉一致性预检（任何数据库容器启动之前必须通过） |

M3B 的**完整门禁清单**（七条，全部要跑，缺一条就不构成本里程碑的证据）：

| 命令 | 作用 |
| --- | --- |
| `node infra/docker/check-compose-topology.mjs` | 解析后 Compose 配置的静态门禁（10 服务、8 secret 文件、2 网络、project scope） |
| `node infra/docker/check-compose-topology-mutations.mjs` | **15 项**拓扑变异反例，全部要求以指定理由被拒，并逐字节还原被变异的 tracked 文件 |
| `node infra/docker/check-local-test-negatives.mjs` | **75 cases = 1 个正向 baseline + 74 个反例/边界检查**；baseline 必须通过，其余 74 条必须以指定理由失败 |
| `node infra/docker/check-m3b-round2-negatives.mjs` | **M3B targeted negative suite：26 cases**（原子 promotion、cleanup collector 与 inode ownership、staging 与 final 两侧的 promotion 身份复核、preflight 信号窗口与已删除的忙等钩子、全仓 index containment、PGID 生命周期、one-shot ExitCode fail-closed（含真实调用链）、整串 stderr 的「不存在」判据与内嵌换行拒绝、解码后的 credential query key、连接串候选按 `scheme://` 起点独立枚举、只以空白与长度上限定界、以及 fail-closed 的解析失败与资源上限）。文件名保留旧入口名，**套件名称不带轮次** |
| `node infra/docker/check-m3b-signal-windows.mjs` | **5 个**真实信号窗口（pre-baseline / pre-override / build / chain / probe）的 failure-safe 取证 |
| `node infra/docker/run-local-test-smoke.mjs` | 从空 volume 起的完整链 smoke：十步真实退出码、migrate/grants 幂等重跑、`/healthz`/`/readyz`、数据库证据、containment 扫描、动态网络隔离、scoped cleanup（`--keep-failure` 保留失败现场） |
| `node infra/docker/probe-compose-secret-identity.mjs` | 真实 Compose Secret 在容器内的 UID/mode 证据（999 与 10001 两侧） |

正向 baseline 是 `check-local-test-negatives.mjs` 里**唯一**一条正向 case，它
同时断言三件事：刚生成的 bundle 预检零问题、**当前真实 tracked 模板**扫描零
问题、Git index 与工作树逐字节一致。没有它，「一律判失败」的回归会让其余
74 条全部恒绿。

[`fixtures/preflight-signal-window.mjs`](fixtures/preflight-signal-window.mjs)
是**测试夹具**，不是运维入口：它通过库级 `preflight` 注入 seam 制造一段确定性
的同步 preflight 窗口，跑的是真实的 `runGeneratorCli` 与真实 signal handler。
生产 generator **不认识**任何用于改变时序的环境变量。

八份 Secret 的文件清单、角色与固定部署 identity 只有一个事实源：
[`local-test-secrets-contract.mjs`](local-test-secrets-contract.mjs)。

**数据库名在 M2B 是固定的 `meal_agent`**，不接受环境变量插值：未经校验的插值会
直接落进 `createdb` / `bootstrap.sh` 的 argv（例如 `--host=evil` 会被当成连接
选项）。可配置能力归 M3——届时先由统一配置 schema 校验
`^meal_agent(_[a-z0-9_]+)?$` 与 63 字节上限，再同时生成连接 URL 与 Compose 参数。
`createdb` 的 argv 因此精确固定，并用 `--` 结束选项解析。

### 并行 worktree

网络与卷**不写死全局 name**，真实名称由 Compose 的 project scope 决定（默认取
Compose 文件里的 `name:`）。因此**多个 worktree 同时起栈时必须各自指定不同的
project name**，否则会抢占同一张网络和同一个数据卷：

```bash
docker compose --file infra/docker/compose.local-test.yaml --project-name meal-agent-wt-a up -d postgres
```

### handoff 独有的挂载

`bootstrap.sh handoff` 需要冻结 `0000` 的磁盘 sha256，并且固定按
`${script_directory}/../../../services/api/migrations/0000_stage_06.sql` 解析——
`script_directory` 是 `/opt/meal-agent/bootstrap`，因此容器内的绝对路径是
`/services/api/migrations/0000_stage_06.sql`。`bootstrap-handoff` 因此比其它
bootstrap 服务多**一个文件**的只读 bind；不暴露整个 `migrations/` 目录，也不给
其它服务。注意服务级 `volumes` 会**整体覆盖** anchor 的 `volumes`（YAML merge key
不做深合并），所以 `bootstrap-handoff` 必须同时重述 `/opt/meal-agent/bootstrap`
那一条。

## 静态门禁

[`check-compose-topology.mjs`](check-compose-topology.mjs) 断言的是
`docker compose config` **解析后**的配置：anchor、profile 与变量插值都已展开。
它对十个服务的 image、user、profile、**entrypoint、command**、networks、挂载、
`depends_on` 与 environment **逐项固定**，另外覆盖：

- 镜像固定与来源——PostgreSQL 必须是那一个 exact tag + digest；三个 API 镜像
  服务**必须**声明 build 且精确指向 monorepo 根与 `services/api/Dockerfile`，
  build 缺失即失败；
- 容器逃逸面——privileged、host pid/ipc/uts/cgroup/userns/network、unconfined
  `security_opt`、`cap_add`、device 透传、root 用户一律拒绝；
- 挂载——Docker socket 拒绝，bind 必须只读，仓库内判断用 `path.relative`
  而不是裸 `startsWith`（与仓库同前缀的相邻目录不能绕过），数据库必须是 named
  volume，`bootstrap-handoff` 的两条挂载逐条精确匹配；
- 端口与网络——`postgres` 与全部一次性任务不得发布端口，`api` 只能有一个
  `127.0.0.1` 的 tcp 发布，`internal` 网络必须 `internal: true`；
- 数据库 identity——用三个投毒值重解析配置并要求输出逐字节不变，因此
  `MEAL_AGENT_DATABASE` 无法改写任何数据库参数；
- project scope——network 与 volume 不得写死全局 name，且两个不同 project name
  解析出的真实名称必须无交集；
- 凭据最小权限与 **secret ↔ 环境变量精确映射**——每个服务的 secret source、
  容器内 target 与指向它的 `*_FILE` / `PGPASSFILE` 路径三者必须一一对应；`api`
  只拿 runtime 连接串，一旦被塞进 admin / migration / backup 凭据即失败；
- **顶层 secret 的 backing file 身份**——八个 secret 的 name → 文件名映射逐项
  固定（只有 `postgres_admin_pgpass` 对应 `postgres_admin.pgpass`，其余七项与
  secret 同名），解析后的绝对路径必须等于 effective secret 目录 + 期望文件名。
  默认分支显式用 `MEAL_AGENT_SECRETS_DIR=''` 解析并要求回落到
  `<compose 目录>/secrets/`，override 分支显式用一个非空 probe 目录解析；两条
  路径都不依赖调用时的宿主环境，并且额外断言「空字符串」与「未设置」解析结果
  完全一致。全程**只比路径、不读取内容**；
- **tmpfs 与挂载可写性**——每个服务的 tmpfs 逐项固定（`postgres` 额外持有
  `/var/run/postgresql:mode=0700,uid=999,gid=999`），bind 与 volume **都**比较
  `read_only`，数据卷被改成只读会被发现；
- Secret 边界——Compose 里不出现口令或完整连接串；secret 文件必须未被 Git
  跟踪（`git ls-files` 非零退出不会被当作「未跟踪」静默放过）且不可被
  group/world 读取，仓库之外的 secret 目录作为显式分支处理；
- **部署身份（M3A）**——`api` 必须显式声明 `DEPLOYMENT_STAGE: local-test` 与
  `DEPLOYMENT_EXPOSURE: loopback`（config.ts 没有默认值，因此「删掉」和「改成
  别的值」是两种不同的篡改，两种都失败）；fake adapter 只允许出现在
  local-test + loopback + 非 production 上；只有 `api` 可以携带部署身份；全拓扑
  不得出现 `WECHAT_APP_ID` / `WECHAT_APP_SECRET`；
- 健康检查只依赖镜像已有能力，不得引用 curl/wget/包管理器。

[`check-compose-topology-mutations.mjs`](check-compose-topology-mutations.mjs) 是
上面那条门禁**自身的反向测试**：它临时改写 tracked 的 compose 文件再运行门禁，
要求每一项变异都**以指定理由**失败（只失败不够——一条无关报错也能让脚本变绿）。
它在文件不干净时拒绝运行，每次变异后立即写回原始字节，并在结束时逐字节复核。
当前 **15 项全部以指定理由捕获、0 漏网**。

Docker CLI 或 git 缺失、或它们非零退出时，它一律以「缺少前置工具 / 无法判定」
失败退出，不降级成纯文本检查后宣称通过。

把它并入 `pnpm stage09a:check` 属于 M5；M3 会再补运行期 Secret 与暴露级别断言。

## 当前状态与边界

M2B 已由项目总控 **Accepted**，验收落点 `d0f2219`。**M3A（配置与 Secret file
消费核心）已由项目总控 Accepted**，验收落点 `a839df1`。**M3B（环境模板、八份
Secret 的生成与交叉一致性、完整 bootstrap 链、`/readyz=200` 与网络隔离实证）为
已取得完整 bootstrap/full-stack 本地证据，但尚未 Accepted；未完成的是 M4/M5 与 09A 总验收**。
M4、M5 未开始；
[ADR-0005](../../docs/architecture/decisions/0005-local-private-deployment-baseline.md)
仍为 `Proposed`，阶段 09A 仍为 In Progress。

**M2B 的 Accepted 只覆盖 Compose 拓扑本身**；`DATABASE_URL_FILE` 与
`MEAL_AGENT_*_PASSWORD_FILE` 在 M2B 只是本拓扑**声明**的契约，**M3A 已实现
消费**（`services/api/src/config-source.ts` 与 `postgres/secret-source.sh`）。
**M3B 已取得**：真实 Compose Secret 的容器内 UID/mode 证据、八份 Secret 的单一
来源生成与部署前预检、从空 volume 起的十步链真实退出码全 0、migrate/grants
二次运行幂等、`/healthz=200`/`/readyz=200`、runtime 最小权限与 readiness 连接
身份、逐服务 secret 可见面、containment 扫描零命中与宿主动态网络隔离，以及
75 cases = 1 positive baseline + 74 negative/boundary cases、M3B targeted negative suite 的 26 cases、
15 项拓扑变异反例与 5 个信号窗口的零残留取证（证据见[阶段 09A 计划的 M3B 实施记录](../../docs/plans/2026-07-stage-09a-local-deployability-baseline.md)）。
M3B **已取得完整 bootstrap/full-stack 本地证据，但尚未 Accepted**；未完成的是
M4/M5 与 09A 总验收。阶段 09A 仍为 In Progress，ADR-0005 仍为 `Proposed`。

### 本轮的威胁模型（写清边界，避免过度声称）

M3B 的判据面向**运维事故与实现回归**，不面向本机上的敌手：

- **本地同 EUID 进程受信**。同一个 EUID 的进程本来就能读写这些文件、连接
  Docker socket、并替换 PATH 上的任何二进制；把它当作攻击者会让每一条判据
  都无法收敛；
- 因此以下三类**不作为当前 M3B blocker**：目录被恶意替换、外部对 Secret 文件
  建硬链接、同 EUID 进程抢占临时 Compose override；
- 已落地的 inode 身份复核、`no-replace` promotion 与 scoped cleanup 的定位是
  **不误删他人文件、不把读取失败读成阴性证据**，而不是抵御同 EUID 敌手；
- 真实的凭据隔离仍然只靠：未跟踪的 secret file、0700/0600 权限、容器内
  UID/mode 实证、以及「Secret 不进入 Git / 模板 / environment / argv /
  inspect / image history / logs」这条扫描线。

每次 smoke/probe 运行使用**每轮唯一的 image tag**（`meal-agent-api:m3b-<run id>`，
经临时 Compose override 注入），并断言三个 API 镜像服务容器的 `.Image` 等于本轮
build 出的 immutable image ID；cleanup 只删本轮 tag。因此并行 worktree/project
不会互相覆盖镜像。

备份与恢复命令、停止/重启持久化属于 M4；`pnpm stage09a:check` 聚合门禁与远端
CI 属于 M5——两者仍未取得证据，阶段 09A **不得记为 Pass**。
