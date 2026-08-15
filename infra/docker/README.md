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
`no-new-privileges:true`、`restart: "no"` 与有界的 json-file 日志轮转；长期运行的
API/PostgreSQL 与业务 one-shot 使用声明的非 root UID，唯一 `secret-materializer`
以 root + 最小 `CHOWN` capability 把 host source 物化为消费 UID 所有的 0600 文件。
全拓扑不使用 privileged、`network_mode: host`、Docker socket，也没有任何
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

M3B 的**完整门禁清单**（共 9 条，全部要跑，缺一条就不构成本里程碑的证据。这个条数
与下表行数、以及仓库里真实的 `check-*.mjs` 集合，由
[`check-m3b-registry-integrity.mjs`](check-m3b-registry-integrity.mjs) 机械比对——
此前这里写「七条」而表里有 8 行，整整一轮无人发现）：

| 命令 | 作用 |
| --- | --- |
| `node infra/docker/check-compose-topology.mjs` | 解析后 Compose 配置的静态门禁（14 服务、8 secret source、10 volume、2 网络、project scope） |
| `node infra/docker/check-compose-topology-mutations.mjs` | **29 项**拓扑变异反例，全部要求以指定理由被拒；只变异仓库外临时副本，不改写 tracked Compose；除已登记 API build 与 postgres/API healthcheck 外，其他服务新增这两类可执行能力同样拒绝 |
| `node infra/docker/check-local-test-negatives.mjs` | **75 cases = 1 个正向 baseline + 74 个反例/边界检查**；baseline 必须通过，其余 74 条必须以指定理由失败 |
| `node infra/docker/check-m3b-template-surface-sweep.mjs` | **tracked 模板绝对面普查**：以 `node --env-file` 为唯一 oracle，不问「这一轮改了什么」，只问「凡是会真的建立活键且取值非空的写法，扫描器看得见吗」。8 族 × 6 视图 = 48 格 + 一条 pathspec 检查。**它不声称扫描器干净**，而是把当前表面钉死：3 族登记为命中、5 族**登记为开着且逐族附原因**，两份扫描面外的 tracked 模板登记为已披露边界；另有 4 族门禁结构上表达不了（缺渲染面，见 [`m3b-surface-registry.mjs`](m3b-surface-registry.mjs) 的 `unguardedFamilies`），**零看守**。未登记族变沉默（新 fail-open）与已登记族被捕获（覆盖变好但登记失真）**同样转红**。登记表在 [`m3b-surface-registry.mjs`](m3b-surface-registry.mjs)，普查前先过一遍自校验；上面这一整组数字由 [`check-m3b-registry-integrity.mjs`](check-m3b-registry-integrity.mjs) 从登记表导出后与本行比对——**删掉一整族或一个视图时普查门禁自己是发现不了的**（它把一切都从登记表导出，少掉一族之后剩下的 42 格同样自洽），只有这条仓库外的形状声明能发现覆盖面缩水 |
| `node infra/docker/check-m3b-round2-negatives.mjs` | **M3B targeted negative suite：69 cases**；在既有 promotion / cleanup / Git index / Docker 证据 / dotenv、URL 与 Node oracle 门禁上，覆盖 active/nested/quoted/prose/comment 多视图的 split-stem（**含 split-stem 与 `=` 之间带 ASCII 空白的 140 格交叉维度**，以及 quoted 空占位在 compact/legacy 两条路径上的一致结论；运算符尾 `>=`/`+=` 的残留单列登记为当前行为）、slash-crossing 与 path 对照、ambient 与 repository-local Git replacement view（含 preflight 后竞态）、Docker container/image/history 的 envelope、深层元素 shape、immutable identity、history 完整性、失败 logs 的非物化、resolved Compose config 的非空证据、固定输出与精确 argv。collector 子门禁为 **51 个**唯一向量，resolved-config 子门禁为 **5 个**唯一向量。文件名保留旧入口名，**套件名称不带轮次** |
| `node infra/docker/check-m3b-registry-integrity.mjs` | **登记完整性**：把已发表的话钉到已提交的数据上。逐节 fail closed，检查包括：登记表自校验 + **18 条畸形登记表合成用例**（逐条断言**指定理由**，而非只断言「被拒了」——白名单与三态计数是同外延规则，只断言被拒时单删一条仍然全绿）与三态漂移判别力（`mixed` 由此覆盖，不是死代码）；ADR/project-status 里的族名列表 ↔ [`m3b-surface-registry.mjs`](m3b-surface-registry.mjs) 的 `families`/`unguardedFamilies` **逐 id 比对**；计划文档表面表格**逐格**用真实 `scanTrackedTemplates` 按行内声明的角色复跑断言，合计数由门禁数出来再比对，非注释例均须经 `node --env-file` 确认建立非空活键；已发表的反引号行数 ↔ 真实文件行数；已发表的 tracked 文件数 ↔ `git ls-files`；本清单 ↔ 真实门禁脚本集合。**规则一句话：任何进入文档的计数、比例或族名列表，要么由脚本对已提交的数据导出，要么删掉** |
| `node infra/docker/check-m3b-signal-windows.mjs` | **5 个**不依赖 Docker 的确定性进程组回归（leader close 与孤儿整组收敛、timeout 不依赖 close、同号 PGID generation 隔离、终止原语/scoped cleanup fail closed、第二次 sweep 期间新增组的 mutation-closed 有界收敛）+ **6 个**真实信号窗口（pre-baseline / pre-override / build / chain / probe / local-test negative daemon-container）的 failure-safe 取证；announced pgid 按有界轮询确认消失 |
| `node infra/docker/run-local-test-smoke.mjs` | 从空 volume 起的完整链 smoke：`secret-materializer` 加原十步的 11 步链、migrate/grants 幂等重跑、`/healthz`/`/readyz`、数据库证据、containment 扫描、动态网络隔离、scoped cleanup（`--keep-failure` 保留失败现场） |
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

### M4：生命周期、备份与恢复

操作顺序、全新安装与恢复的差异（`pg_dump` 不含 cluster roles）以及各入口的
硬边界见 [runbook](../../docs/operations/stage-09a-local-test-lifecycle.md)。
两条**运维**命令（针对长驻的默认部署）：

| 命令 | 作用 |
| --- | --- |
| `node infra/docker/backup-local-test.mjs` | `pg_dump --format=custom` 备份（backup 角色 BYPASSRLS，FORCE RLS 不截断；写入被 Git 忽略的 [`backups/`](backups/README.md)，将要写入的 dump 与 sidecar **文件路径**在仓库内且未被 Git 忽略即拒绝；生成 `*.sha256` sidecar；前后打印环境与数据库标识，不打印口令或连接串） |
| `node infra/docker/restore-local-test.mjs` | 恢复到**全新** `meal_agent` 库（`--dump <path>`；checksum sidecar 以 `O_NOFOLLOW|O_NONBLOCK` 有界读取，只接受单链接普通文件与严格 UTF-8；不匹配即拒绝且不调用 `pg_restore`；`createdb --owner=meal_agent_migrator` 后单事务 `pg_restore`；前置 `cluster`/`logins` 与后续 `acl → migrate → grants` 见 runbook） |

两条**演练**命令（每轮唯一 project/image tag/合成 Secret，零残留复查，逐阶段
打印本地耗时；均支持 `--keep-failure`）：

| 命令 | 作用 |
| --- | --- |
| `node infra/docker/run-local-test-lifecycle.mjs` | 生命周期演练：构建 → 空 volume 初始化 → migration → 启动 → `/healthz`/`/readyz` → 合成数据授权读取 → `stop`/`start` 与 `down`/再起两种重启后数据仍在（SIGTERM 优雅退出的容器侧退出码一并断言）→ 销毁归零 |
| `node infra/docker/run-local-test-restore-drill.mjs` | 备份/恢复演练：栈 A 全链 + 两个合成家庭 sentinel + 授权面快照 → 备份 + sidecar → 栈 B 重建角色（不在 dump 里）→ 篡改反例在 `pg_restore` 之前被拒 → 单事务恢复 → `acl → migrate → grants → api` → ledger/readiness/授权读取/runtime 反向探针/owner-GRANT-RLS 快照逐字一致 |

`pg_dump`/`pg_restore` one-shot 容器使用每轮高熵名称和 ownership label；只有 inspect
得到 canonical container ID 且 label token 精确属于本轮时才按 immutable ID 删除。
同名 foreign 容器、inspect 失败或非规范「不存在」证据一律不盲删，并作为 residue
失败。该所有权边界与 sidecar 的有界普通文件读取均有无 Docker 回归。

这两张表是**登记**（`check-m3b-registry-integrity.mjs` §7 会把 README 记录的
脚本集合与仓库里真实的可执行脚本集合机械比对），不是 M3B 门禁清单的一部分；
两条演练已并入 M5 的 `pnpm stage09a:check`（见下节）。

### M5：阶段聚合门禁与 API runtime image 扫描

**阶段级聚合命令**（入口在 `scripts/run-stage09a-check.mjs`，不在本目录）：

```bash
pnpm stage09a:check                    # stage08 → 静态检查 → 镜像扫描 → 9 条 M3B 门禁 → 两条 M4 演练
pnpm stage09a:check -- --keep-failure  # 失败时保留支持该开关的门禁现场（显式 opt-in）
```

它**只做串联**，不实现新检查：按计划文档 M5 的链路顺序执行 `pnpm stage08:check`、
Compose 静态门禁与变异反例、下面两条 M5 镜像门禁、其余 M3B 门禁（相互之间保持
上方门禁表的既有顺序）、smoke 与 Secret 身份探针、两条 M4 演练。fail fast，逐步
状态在结尾汇总表如实列出；Docker CLI / Compose v2 / daemon / git / pnpm 任一缺失
时在执行任何检查之前明确失败为「缺少前置工具」，不降级成静态检查后宣称通过。
每个动态门禁/演练自带 scoped cleanup 与零残留复查，`--keep-failure` 逐层透传。
前置探针与每个步骤都以独立进程组登记；子门禁及其确定性夹具再派生的 detached
process group 通过聚合器专用的机器可读所有权通道登记。GROUP frame 绑定
producer、PGID 与严格递增 generation；通道要求 LF 完整帧，cleanup
ACK 以 producer PID 区分并发 owner；partial/malformed/缺失 ACK 均 fail closed。
SIGINT/SIGTERM/SIGHUP 或兜底超时会先给子门禁
有限时间完成 scoped cleanup，再对所有已登记组执行 TERM → grace → KILL 并有界确认
ESRCH。直接子进程退出但后代仍存活同样判失败；该边界有不依赖 Docker 的真实 CLI
回归，且明确断言聚合器退出前 scoped cleanup 已完成、嵌套进程组已消失。

**M5 新增的两条镜像门禁**（指向验收门禁 #13 的 BLOCK 级风险——客户端依赖泄漏
进 runtime image；不属于冻结的 M3B 门禁清单）：

| 命令 | 作用 |
| --- | --- |
| `node infra/docker/check-api-runtime-image.mjs` | API runtime image 依赖与组件扫描：本轮唯一 tag 只用于第一次解析 immutable image ID，后续 Config/history/save/`docker create`/export 全部绑定该 ID；scratch container name 在 create 前先证明不存在并预登记，create 使用 immutable ID + ownership label，随后 `.Image` 必须精确一致。宿主用与 Dockerfile runtime-closure **完全相同**的 `pnpm deploy --prod --legacy` 派生期望闭包，同一个 walker 走两棵树，`.pnpm` store key / 顶层链接 / name@version 与 dependency payload 精确相等；普通 package 文件、所有 README 与 `.bin` 都比较路径、类型、mode、长度和 SHA-256/symlink target，只跳过明确的 host-specific pnpm metadata，且仅归一化传入的 deploy root。history 同时验证 CLI JSON-lines 与 `docker image save` 的 content-addressed config blob；OCI index/manifest/config/layer/provenance media type 按角色精确固定，provenance 绑定 selected platform manifest，每层验证 compressed digest、uncompressed diff ID 与内层 tar framing。镜像 Config（User/Entrypoint/Cmd/Env/ExposedPorts/Volumes/Healthcheck）逐项固定；`/app` 顶层恰好四项、migrations 与仓库逐字节一致、无构建阶段残留、无第二个依赖树、无包管理器；再叠一层**显名 denylist**（Taro、Swiper、webpack-dev-server 等客户端/构建工具族）。`--keep-failure` 只说明存在 owned 临时目录，不输出物理路径 |
| `node infra/docker/check-api-runtime-image-mutations.mjs` | 上一条门禁**自身的变异反例套件**：先跑正向 baseline，再执行硬钉的 **11 个 built + 2 个 static-only** 变异。built 变异覆盖 denylist 包、构建阶段残留、`.bin/webpack`、既有 package payload 植入、被跳过 README 路径替换为目录、普通文件 mode 漂移、history-only secret、EXPOSE、secret 形态 ENV、root 用户与 provenance 丢失；static-only 覆盖浮动基础镜像与在密钥排除之后追加宽泛 `.dockerignore` negation。每项都必须**以指定理由**被拒——只失败不够。Dockerfile 变异经 `docker build --file -`（stdin）构建，**不改写任何 tracked 文件**；两项 static-only 不构建 |

共享扫描核心在 [`api-image-scan.mjs`](api-image-scan.mjs)（库模块，非入口）。
期望闭包推导对 lockfile 逐字节只读；实测 `pnpm deploy` 会改写 pnpm 的工作区
deps 状态记录，仓库因此在 `pnpm-workspace.yaml` 显式声明
`verifyDepsBeforeRun: false`（本地与 CI 都只用显式的
`pnpm install --frozen-lockfile`，门禁仓库不允许隐式 install）。
Docker image/container identity 只接受 canonical immutable 形态；命令失败与 Config
不一致只输出固定类别，不回显 runner stderr 或镜像内实际值。

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
上面那条门禁**自身的反向测试**：它把 Compose 复制到仓库外私有临时目录，只变异
该副本，再要求每一项都**以指定理由**失败（只失败不够——一条无关报错也能让脚本
变绿）。tracked Compose 从不进入写路径。当前 **29 项全部以指定理由捕获、0 漏网**；
除未登记的 `post_start`/`pre_stop` 执行能力外，新增反例还明确拒绝 build host
network、无条件成功 healthcheck，并证明 source/resolved sentinel 不会进入门禁诊断。

Docker CLI 或 git 缺失、或它们非零退出时，它一律以「缺少前置工具 / 无法判定」
失败退出，不降级成纯文本检查后宣称通过。

它已并入 M5 的 `pnpm stage09a:check`；运行期 Secret 与暴露级别断言已由 M3 落地。

## 当前状态与边界

M2B 已由项目总控 **Accepted**，验收落点 `d0f2219`。**M3A（配置与 Secret file
消费核心）已由项目总控 Accepted**，验收落点 `a839df1`。**M3B（环境模板、八份
Secret 的生成与交叉一致性、完整 bootstrap 链、`/readyz=200` 与网络隔离实证）
已于 2026-08-11 Accepted，验收落点 `cf43452`**。
**M4（生命周期、备份和恢复）已于 2026-08-11 Accepted**，验收落点 `f671c51`
（见上方 M4 一节）。第九轮候选 `4a72218` 的两路独立审计仍为 BLOCK；第十轮实现落点
`3849bbd` 已闭合同步 primitive cleanup-before-settlement、backup formal artifact 回滚/
promotion inode、build/healthcheck 能力与 topology/Group E/Secret probe 输出边界；runtime
image mutation 保持 1 baseline + 11 built + 2 static-only，topology mutation 29/29，纯
Node 脚本回归 83/83，targeted 69/69、local-test 75/75、signal 5+6、Secret identity 与
restore drill 已通过。含文档候选 `a8ad0b2` 的新 HEAD 已从头通过完整 14/14，之后仍须两个全新独立只读 A/B 审计；M5 仍未 Accepted
（见计划文档 M5 实施记录）；
[ADR-0005](../../docs/architecture/decisions/0005-local-private-deployment-baseline.md)
已凭真实容器证据转为 `Accepted`。**09A 总验收未完成**，阶段仍为 In Progress；
GitHub Actions workflow 复用同一命令但**尚无真实远端 run**，真实 run 成功之前
只登记「已配置」。

**M2B 的 Accepted 只覆盖 Compose 拓扑本身**；`DATABASE_URL_FILE` 与
`MEAL_AGENT_*_PASSWORD_FILE` 在 M2B 只是本拓扑**声明**的契约，**M3A 已实现
消费**（`services/api/src/config-source.ts` 与 `postgres/secret-source.sh`）。
**M3B 已取得**：真实 Compose Secret 的容器内 UID/mode 证据、八份 Secret 的单一
来源生成与部署前预检，以及验收时点从空 volume 起的十步链（8 个 one-shot 读真实 `docker inspect` 退出码，postgres 与 api 两个服务以健康检查通过计 healthy）。第五轮当前架构在链首增加 `secret-materializer`，形成 11 步；migrate/grants
二次运行幂等、`/healthz=200`/`/readyz=200`、runtime 最小权限与 readiness 连接
身份、逐服务 secret 可见面、containment 扫描零命中与宿主动态网络隔离，以及
75 cases = 1 positive baseline + 74 negative/boundary cases、M3B targeted negative suite 的 69 cases、
当前 29 项拓扑变异反例（M3B 验收时为 15 项）、当前 5 个确定性进程组回归与 6 个真实信号窗口的零残留取证（M3B 验收时为 5 + 5；证据见[阶段 09A 计划的 M3B 实施记录](../../docs/plans/2026-07-stage-09a-local-deployability-baseline.md)）。
M3B **已于 2026-08-11 Accepted，验收落点 `cf43452`**；M4 与 M5 均已在同日交付
（M4 已 Accepted，M5 候选待审）。阶段 09A 总验收未完成，阶段仍为 In Progress。

`08da379` 的两路独立复验再次给出 **BLOCK**；Round 19 候选 `c8d7236` 又由项目总控
第一阶段只读裁定为 **BLOCK**（crossing stem 与 `=` 之间有 ASCII 空白时 5 个非
active 视图 140 格全漏；外层 closing quote 的空占位在 legacy 路径未生效）。Round 20 候选 `f9997b0` 又由两路独立审计与项目总控**三方同指**判为 **BLOCK**，
且是**新回退**：搬到 legacy 路径的空占位规则没有证明「键前面那个引号是本赋值的
**开**引号」，`# psql "dbname=meal"PGPASSWORD="<值>"` 整行零 problem，净新增 280 格
fail-open 漏检。Round 18
的共享 canonical Git 边界使已 Accepted 的 M2B topology checker 出现一处受控修订；
Round 19 至 Round 23 都没有再次修改该 checker。该历史例外
必须单列披露，不能写成整个 M3B 对全阶段冻结面零改动。

### 模板扫描的候选边界来自 dotenv，不来自 URL 字符表

一个取值在哪里结束是 **dotenv 语法**的问题：quoted 值以配对引号为界（内部的
空格与制表符原样保留），unquoted 值到行尾，行首 `#` 注释剥离后照扫，引号未闭合
或闭合后跟着非空白非注释内容一律 **fail closed**。URL 里哪个字符算分隔符则完全
交给 WHATWG 解析器——扫描器**不维护任何标点或空白字符表**。每个 `scheme://`
起点给出一个独立、可重叠、延伸到逻辑取值末尾的候选视图；内层起点只计数与独立
检查，不截断外层候选。

解析成功之后 **userinfo、query parameter 与 fragment 同时判定**。判定顺序如实
记录：原始文本正则**先跑**（它仍是它能覆盖的那些形态的主判据），解析器给出的
userinfo 是**补漏**——正则要求 `@` 前无空白，引号内合法保留的空格/制表符会绕过
它。`unscannable`（有一段没扫到）**优先于**任何「扫到的那段是什么」的结论。

tokenizer 返回**带角色**的片段（主取值 / 行内注释 / 非赋值整行）。整行按锚定的
dotenv 文法判定；**每个片段**再用**非锚定**扫描过同一份敏感赋值判据——片段是自由
文本，赋值不一定出现在开头。DSN 判据覆盖全部片段，但 unquoted 行的注释片段是主
取值的**子串**，因此不重复参与 `scheme://` 起点计数。行尾 CR 在切行时去掉，否则
CRLF 模板会让整条敏感键判据失效。敏感赋值消息**不含任何输入派生的键名或取值**——只有固定类别、文件标签与行号
（启发式判断「这个键名像不像 Secret」只能缩小泄漏面，不能关掉它）。赋值取值按
**引号**定界解析，引号内的 `#` 与空白原样保留；**只有长度精确为 0 的 quoted 取值
才是空占位**（`PASSWORD=" "` 是写进去的内容，不能用 `trim()` 抹掉），闭合引号
之后只允许「输入结束 / 水平空白后结束 / 注释」，其余收尾一律 fail closed，且
顶层与片段走同一份判据得同一结论。

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

M4（生命周期、备份与恢复）的入口与演练见上方 M4 一节与
[runbook](../../docs/operations/stage-09a-local-test-lifecycle.md)：停止/重启
持久化、`pg_dump` 自定义格式备份 + SHA-256 校验 + 单事务恢复、恢复后的
owner/GRANT/RLS 与授权读取验证、SIGTERM 限时强制退出，已于 2026-08-11
**Accepted**（验收落点 `f671c51`）。M5 已交付 `pnpm stage09a:check` 聚合门禁并
取得历史本地全绿证据；第十轮实现落点 `3849bbd` 与文档候选 `a8ad0b2` 已从头通过
完整 14/14，之后仍须两个全新独立只读 A/B 审计；远端 CI
workflow 复用同一命令但尚无真实 run，真实 run 成功
之前只登记「已配置」、不记录 CI Pass。09A 总验收完成之前，阶段状态不变。
