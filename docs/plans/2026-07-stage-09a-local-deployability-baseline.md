# 阶段 09A：本地可部署性与私有测试基线

- 日期：2026-07-26（2026-07-31 更新实施状态）
- 状态：In Progress（M1 Accepted；M2A 的 R8A 只读 projector 已由总控 Accepted，验收落点 `ca65275`；R8B 已由总控 Accepted；**M2A 整体已由总控 Accepted，验收落点 `5e480803`**；**M2B 已由总控 Accepted，验收落点 `d0f2219`**；**M3A「配置与 Secret file 消费核心」已由总控 Accepted，验收落点 `a839df1`**；**M3B「环境模板、八份 Secret、完整 bootstrap 链、`/readyz=200` 与网络隔离实证」已取得完整 bootstrap/full-stack 本地证据，但尚未 Accepted；未完成的是 M4/M5 与 09A 总验收**；M4、M5 未开始）
- 计划分支：`claude/stage-09a-api-container-baseline-9f286c`（PR #1，保持 Draft）；R8B 实施分支 `claude/stage-09a-m2a-r8b`，基线 `ca65275`，验收落点 `5e480803`；M2B 实施分支 `claude/stage-09a-m2b-compose-topology`（本地 worktree 的分支名带工具生成后缀 `-e463dc`，目录名沿用更早的 `stage-07-…`），基线 `0ca4ca2`；M3A 实施分支 `claude/stage-09a-m3-config-secret-consumption`，基线 `8c99c46`，验收落点 `a839df1`；M3B 实施分支 `claude/stage-09a-m3b-bootstrap-chain`，基线 `8292df0`
- 规划基线：`main` `35ddf78`
- 负责人：项目总控、基础设施执行任务、安全复核任务

## 决策摘要

阶段 09A 先建立可重复、可审计的本地部署包，不购买云服务器，不接入真实微信配置，也不开放公网服务。完成并通过本阶段后，才评估阶段 09B 的单台私有测试服务器。

已确认的外部条件：

- 首批使用者主要在深圳；
- 当前没有云厂商偏好；
- 服务器仅按内部测试考虑，尚未购买；
- 当前没有真实微信 AppID/AppSecret、合法 HTTPS 域名或发布条件。

因此本阶段只做 Docker Compose 本地/私有测试拓扑。腾讯云广州是后续测试服务器的默认候选，不是本阶段已选择或已购买的基础设施；真正创建云资源时再记录供应商、区域、账号、网络和成本决策。

## 当前事实

- `services/api` 已有可构建的 Fastify 服务、`/healthz`、`/readyz`、graceful shutdown、PostgreSQL migration checksum 和递归日志脱敏。
- production 配置已经拒绝 fake WeChat adapter；真实 adapter 仍需要 AppID/AppSecret。
- PostgreSQL 18 的空库迁移、RLS、幂等、并发和数据库反向测试已由阶段 08 门禁覆盖。
- 仓库已有 GitHub `origin`，本地 `main` 跟踪 `origin/main`。GitHub Actions 的 `ci` workflow 已在本分支上真实运行并通过（见 PR #1 记录的 run URL 与 head SHA）；该 run 只执行 `pnpm stage08:check`，**不构建镜像、不跑容器 smoke**，因此它不构成阶段 09A 的完成证据。
- （规划时的事实）`infra/docker/` 与 `infra/environments/` 为空骨架。**现状**：M1 已交付 `services/api/Dockerfile` 与根 `.dockerignore`；M2A 已交付 `infra/docker/postgres/` 的 bootstrap 与**四个** generated adapter（对象 manifest、授权收敛、授权断言，以及 R8A 新增的只读授权投影，R8B 已把其上的共享 CTE 接入 verify/converge）；M2B 已交付 `infra/docker/compose.local-test.yaml` 与解析后配置的静态门禁 `infra/docker/check-compose-topology.mjs`；M3A 已交付 secret file 的 `_FILE` 读取实现（`services/api/src/config-source.ts` 与 `infra/docker/postgres/secret-source.sh`）、显式部署维度与响应安全边界。仍然缺席的是 `infra/environments/` 配置模板、八份 Secret 的生成与交叉一致性预检、容器 smoke test、备份恢复脚本与部署运行手册。
- 当前总控机器可用 Node.js 24.14.0（M1 镜像内固定为 Node 24.18.0）、pnpm 11.9.0、PostgreSQL 18.4，以及 Docker Engine 29.6.2 与 Docker Compose v5.3.1（规划时尚未安装，2026-07-27 已具备）。容器引擎不再是前置阻塞项，但没有实际 Compose 运行与备份恢复证据前仍不得把本阶段记为完成。
- **对象 catalog 基线绑定 PostgreSQL 18.4**：manifest 里的 `pg_get_constraintdef` / `pg_get_indexdef` / `pg_get_expr` 规范化文本、`pg_constraint` 对 NOT NULL 的登记方式、`acldefault` 的取值都由具体 patch 版本决定。判据是 exact-patch 的，且覆盖**整套工具链**：`environment:check` 对 `createdb`、`initdb`、`pg_ctl`、`postgres`、`psql` 逐个执行 `--version`，按标准 banner 的主版本字段锚定解析（不做任何 `includes` / 子串判断），五个都必须是 exact 18.4；任一工具是 18.3、banner 报了别的工具名、或缺失/不可执行时整套判定失败，「只有 server 是 18.4」的混装被明确拒绝。这些结论都有单元测试。因此 M2B 的 Compose 必须固定 PostgreSQL **18.4 的 exact image digest**，且该 digest 必须在 M2B 落地时**解析真实镜像仓库**获得——本计划与其他文档当前**不得写入任何编造的 digest**。任何 patch 升级都必须重新 capture manifest、重新跑 parity 并显式 rebaseline，不能只改 tag。
- 现有数据库测试主要使用高权限连接建立临时集群。该做法可以验证 migration 与 RLS，但不能直接作为长期测试环境的运行账号方案。
- 现有 local/weapp-only 依赖审计例外将在 2026-08-08 到期并明确阻断 external-test；阶段 09A 可以验证本地 API image，但阶段 09B 或任何外部客户端测试不能沿用该例外。

## 目标拓扑

```text
本机浏览器、客户端或 SSH tunnel
  └─ 127.0.0.1:<api-port>
       └─ API container（非 root、runtime 数据库凭据）
            └─ internal Docker network
                 └─ PostgreSQL 18（不发布 host 端口）

PostgreSQL healthy
  ├─ 一次性 bootstrap container（cluster admin，只执行空库 0000 和角色交接）
  └─ 一次性 migration container（login 非 superuser，进入高权限 migrator role）
       └─ 应用已审查的 0001 → 0004 及本阶段新增 migration

显式 backup/restore command（独立 operator 凭据）
  └─ 只处理合成测试数据和本地备份目录
```

`HOST=0.0.0.0` 只用于 API container 内监听；Compose 必须把 host publish address 固定为 `127.0.0.1`。数据库不得声明 host port。阶段 09B 若使用远程机器，仍通过 SSH tunnel 访问，不因容器内部监听地址而开放公网。

## 实施范围

### M1：容器构建基线

1. 新增适用于 monorepo 根构建上下文的 `.dockerignore`。
2. 新增 `services/api/Dockerfile`：
   - Node.js 24 LTS exact patch 或 digest 可审查；
   - multi-stage build；
   - 使用根 lockfile 和 `pnpm install --frozen-lockfile`；
   - 先构建 `@meal-agent/contracts`，再构建 API；
   - runtime image 不包含源码工具链、测试依赖或未使用 workspace；
   - 以固定非 root 用户运行；
   - 包含运行所需的 compiled files、package metadata 和 SQL migrations。
3. 镜像不得内置 `.env`、Git 元数据、私钥、AppSecret、真实账号数据、测试报告或本机路径。
4. 基础镜像必须固定到可审查的 Node 24 与 PostgreSQL 18 安全 patch；升级 patch 不改变 ADR-0002 的 major 基线，但要重新运行完整门禁。

### M2：Compose 与数据库角色

1. 在 `infra/docker/` 增加单机 local-test Compose，至少包含：
   - `postgres`：PostgreSQL 18、named volume、健康检查、无 host port；
   - `bootstrap`：仅在全新安装或恢复前显式运行的 cluster-admin job；
   - `migrate`：一次性 migration job，新安装时在 bootstrap 成功后运行；
   - `api`：migration 成功后启动，提供容器和 HTTP 健康检查；
   - 可显式调用的 `backup` / `restore` 命令或等价脚本，不常驻。
2. API host 端口只能绑定 `127.0.0.1`，不得使用未限定的 `3000:3000`。
3. bootstrap 分成 **cluster scope** 与 **database scope** 两段：cluster scope 连
   maintenance 数据库建立六个角色、membership 与口令，不要求目标数据库存在；
   database scope 在目标数据库存在后处理数据库/schema ACL、owner 交接与对象权限。
   恢复路径复用 cluster scope 与 database ACL 基线，但不重跑 `0000` 或 owner
   handoff。bootstrap、migration、runtime 和备份恢复使用显式权限边界：
   - 当前冻结的 `0000` 会创建角色并设置 `BYPASSRLS`，空库首次安装客观上需要 bootstrap/admin；新安装路径由它执行 `0000`，把目标 database owner 设为 `meal_agent_migrator`，保证 `public` schema 的 owner/grantor 权限足以执行后续 `CREATE`/`REVOKE`，把 `drizzle` schema 和 migration ledger 所有权交给该角色，再建立后续登录角色；
   - 全库恢复路径只预建 dump 引用的固定 NOLOGIN roles、登录角色，并直接创建 owner 为 `meal_agent_migrator` 的空数据库；不先执行 `0000` 或其他会与 dump 冲突的业务 migration。restore operator 受控连接恢复但不得改变 database owner，恢复完成后再由 migration login 应用备份之后新增的 migration；
   - `0001` 及以后由自身非 superuser、`NOINHERIT` 的 migration login 显式进入 `meal_agent_migrator` 执行。后者是 database owner，具有 DDL 和 `BYPASSRLS`，所以 migration job 仍是敏感的高权限数据库操作，只是没有 cluster superuser/角色管理权限；migration 凭据不进入 API container；
   - runtime login 使用 `NOINHERIT`，非 superuser、无 `CREATEDB`、无 `CREATEROLE`、无 `BYPASSRLS`，只能显式进入 `meal_agent_app` 运行角色；
   - API container 只取得 runtime login；
   - 完整备份使用独立 `NOINHERIT` login，进入一个无写权限但具有 `BYPASSRLS`/全库读取能力的专用角色；该角色是敏感数据导出权限，不得借用 API runtime，也不得笼统表述为普通只读账号；
   - 恢复使用显式高权限 operator，不进入 API container。
4. 角色初始化必须可重复执行并有数据库反向测试；API runtime 必须无法 `SET ROLE meal_agent_migrator` 或备份角色，备份角色必须不能写业务表或执行 DDL。不得修改已冻结的 `0000`—`0004`。业务数据库结构若确需变化，只能追加新 migration。
5. 容器至少使用 `no-new-privileges`、删除不需要的 Linux capabilities，并在可行时启用只读根文件系统和临时目录。
6. 不使用 privileged、host network、Docker socket mount 或宿主目录数据库 bind mount。
7. `/readyz` 必须以 runtime 真实可用的 `meal_agent_app` 权限读取 migration ledger；不能依赖登录角色继承权限或超级用户连接。
8. migration advisory lock 和数据库连接具有有界超时；另一 migration 持锁时，部署 job 必须明确失败或在限定时间内退出，不能无限等待。
9. 冻结 `0000` 的「对象与安全属性投影」只有**一个事实源**：`services/api/src/database/` 下的 typed readonly manifest。它必须覆盖三个 managed schema 的存在性与「没有多余 schema」、relation 的 schema/name/relkind/owner、index 与 constraint 的规范化定义、routine 的 schema/name/identity args/prokind/owner/`prosecdef`/language/`proconfig`（尤其固定 `search_path` 与 `row_security=off`）与关键定义摘要、`relrowsecurity`/`relforcerowsecurity`、policy 的 table/name/command/roles/permissive/`USING`/`WITH CHECK`、type 及明确允许的其他 namespace 对象，并强制唯一键、固定排序与重复 identity 拒绝。不得用正则解析 `0000_stage_06.sql` 推导，也不得继续维护 TS/SQL 两份手写 allowlist。
10. 同一模块或相邻模块提供确定性 SQL renderer：输出必须是 `pg` 与 `psql` 都能执行的纯 SQL，不含 `\ir` 等 psql-only 元命令，不执行任何 ownership/ACL mutation。`migrate.ts` 的 0000-only 重跑 preflight 直接执行渲染结果；开发期 generator 把同一 renderer 输出写入 `infra/docker/postgres/sql/database/generated/0000-object-manifest.generated.sql`；`01-owner-handoff.sql` 在 mutation 之前、事务之内用相对路径 `\ir` 加载它。
11. 只读 `manifest:check` 门禁：内存渲染后与 tracked generated SQL 逐字节比较，不得自动改写文件；generated 文件带 do-not-edit 标记、版本与 canonical manifest digest，不含时间戳、绝对路径、locale 或随机值。仅证明「TS 与 generated SQL 一致」不足够——还必须在真实 PostgreSQL 18 上干净执行冻结 `0000` 后，把 catalog 的规范化安全投影与 TypeScript manifest 逐行比对。
12. 授权状态另立一个 **ledger 感知**的 manifest，按 `(ledger, phase)` 精确描述 `PUBLIC`/app/backup/三个 login 的 catalog ACL、`pg_default_acl` 有效默认权限、`has_*_privilege` 有效权限，以及受控 routine 的 identity/owner/`SECURITY DEFINER`/`proconfig`/正文摘要与允许的 `EXECUTE` 授权；至少区分 0000-only 与 0000—0004 两个 ledger，未登记组合 fail closed。恢复/安装流程分为 migration 前 containment 与 migration 后 final ACL，final 阶段必须同时验证 PUBLIC、app 与 backup。所有异常 ACL 按真实 grantor 收敛，再只重建 manifest 允许项；后验同时检查 catalog ACL 与有效权限。产品声明禁用 Large Object 时，必须同时关闭 `lo_create`/`lo_creat`/`lo_from_bytea` 等创建入口的有效 `EXECUTE`。
13. `meal_agent_private`：`PUBLIC` 无 `USAGE`/`CREATE`；app 只有所需 `USAGE`、无 `CREATE`；backup 与三个 login 无有效访问；按真实 grantor 收敛；缺失任一 managed schema 时在任何 mutation 之前失败。恢复路径上 `drizzle` 出现未知 routine 或 `SECURITY DEFINER` 必须 fail closed，`PUBLIC` 派生的 `EXECUTE` 必须纳入 app/backup 的**有效**权限验证。Large Object 采用**先判定、后收敛**：存在任意 LO 对象时两个阶段都在任何 ACL / default ACL mutation 之前 fail closed，绝不修改 `lomowner` / `lomacl` / LO 数据、绝不解除链接；只有在确实一个 LO 都没有时，收敛才处理 `pg_default_acl` 的 `defaclobjtype='L'` 异常默认权限与 20 个入口点上多余的 `EXECUTE`。不借此扩展业务能力。数据库级 `PUBLIC` 的跨 grantor ACL 必须**真正收敛**，不能只在后置校验失败后整体回滚。

14. 授权状态的**观察层与收敛层分开推进**：
    - **R8A（已由总控 Accepted，验收落点 `ca65275`）**只交付 canonical projector——一段**单条只读
      SELECT**（第四个 generated adapter），不含任何 mutation，**不接入**
      `02-acl-baseline.sql` / `03-backup-grants.sql`，两个既有授权 adapter 保持
      字节不变。它必须证明：identity 为 JSON 数组且 Node 与 PostgreSQL 编码逐字节
      相同、结果不随 `search_path` / `quote_all_identifiers` 变化且不修改调用方
      会话、含 `#`/`@`/`|`/引号的合法名字不碰撞也不错位、`pg_default_acl` 的
      objtype 与 `acldefault()` 的 objtype 分别映射（sequence 是 `S` 与 `s`）、
      非空 global 行替换内建默认而空行等价于没有行，以及以上每一条都能被**独立
      catalog 查询**复现。
    - **R8B（总控 Accepted）**把 projector 接入了 verify/converge、删除了
      `watchedGrantees` 静态名单，并**落实**了下面第 15 条已决定的类型与 Large
      Object 策略。落地结构是「PostgreSQL catalog → 共享结构化 projector CTE →
      公开只读 projection adapter / verify 的可移植策略匹配器 / converge 的可移植
      策略匹配器」：**共享的是事实采集，不是把动态投影冻结成跨环境快照**。ACL
      比较覆盖完整元组（object + grantee + grantor + privilege + grantable），固定
      允许授权的 canonical grantor 恒为 `meal_agent_migrator`；`default_raw` 决定
      执行哪条默认权限语句、`default_effective` 只做语义验证；全部致命前置条件在
      任何 mutation 之前执行，`02`/`03` 因此收成薄入口。R8B 还**统一替换**了
      `authorization-manifest-sql.ts` 的 `currentDefaultCte`，它有三个互相独立的
      错误：`COALESCE(schema, global, builtin)` 三选一冒充叠加语义、把「空 global
      行」与「没有这一行」混为一谈、把 `pg_default_acl.defaclobjtype` 直接喂给
      `acldefault`（sequence 的 `S` 被当成 FOREIGN SERVER）。该 CTE **同时被
      converge 与 verify 两个块引用**，因此这三条同时影响收敛与断言；替换后必须
      重新生成并复验 `authorization-converge.generated.sql` 与
      `authorization-verify.generated.sql`——两者都已重新生成并在真实 PostgreSQL
      18.4 上复验。R8B **没有**把动态投影冻结成跨 cluster 的固定快照：`role` 行仍
      只是覆盖面证据而非允许角色白名单，外部角色一律按策略匹配，任意 LO 对象按
      政策判为异常且只报告不删数据，LO 的 OID 不进入固定允许 manifest。
    - 「ACL 全主体覆盖」的准确含义：**normalized raw ACL** 在受监管对象类别内
      动态枚举全部 grantee 与 grantor；**effective** 只覆盖 `PUBLIC`、项目角色与
      目标库内全部非 superuser LOGIN，不是对集群所有角色的枚举。
15. 类型与 Large Object 的策略**已决定**（R8A 只报告，R8B 已落实，不再裁定）。落实
    要点：类型策略同时落在**对象 ACL 与 `T@global` 的 default privilege 物理行**
    上，因此新建 enum / domain / composite **出生即干净**；`language` 的内建 owner
    与 `PUBLIC USAGE` 是**必需项**（owner 动态取自 catalog）；**任意** Large Object
    在任何 ACL / default ACL mutation 之前 fail closed，只报告、绝不先改 `lomacl`
    或删数据，只有在确实没有 LO 时收敛才处理 `defaclobjtype = 'L'` 与 20 个入口点
    的多余 `EXECUTE`。另外，`pg_default_acl` 只保护**创建窗口**：新增 migration 创建
    relation 或 sequence 时，必须同时新增 ledger 状态并登记该对象的固定授权，
    exact-ledger 不因默认权限而放宽。managed 非数组类型由
    owner/`meal_agent_migrator` 保留必要 `USAGE`，`PUBLIC`、app、backup 与三个
    login 默认无 `USAGE`；数组类型只记录向元素类型的委托，不建立也不撤销独立
    ACL（PostgreSQL 直接拒绝对数组类型授权与改属）；产品禁用 Large Object，创建/
    读写入口、项目角色权限与异常 default ACL 必须关闭。

### M2B 实施记录（Compose 拓扑）

已实现并取得实测证据，**已由项目总控 Accepted，验收落点 `d0f2219`**。落点：
[`infra/docker/compose.local-test.yaml`](../../infra/docker/compose.local-test.yaml)、
[`infra/docker/check-compose-topology.mjs`](../../infra/docker/check-compose-topology.mjs)、
[`infra/docker/README.md`](../../infra/docker/README.md)、
[`infra/docker/secrets/`](../../infra/docker/secrets/README.md)。

1. **十个服务**：`postgres`、七个 `bootstrap-*` 一次性任务、`migrate`、`api`。
   默认 profile 恰好是 `postgres`/`migrate`/`api`，bootstrap 全部由 `bootstrap`
   profile 显式调用，`docker compose up` 与普通重启不会再次执行它们（实测）。
2. **PostgreSQL** 固定 `18.4-bookworm` + `sha256:1961f96e…9296`（`docker buildx
   imagetools inspect` 解析真实仓库所得的 OCI index 摘要，内含 `linux/amd64` 与
   `linux/arm64/v8`）；named volume、healthcheck、只在 `internal: true` 网络上、
   不声明 `ports`。实测 6 秒达到 healthy，容器内五个工具 banner 与
   `server_version` 均为 18.4，`docker inspect` 证明没有 PublishedPort。
3. **API** 继续使用已 Accepted 的 `services/api/Dockerfile`（镜像仍为
   `10001:10001`），host publish 精确为 `127.0.0.1:<port>:3000`，容器内
   `HOST=0.0.0.0`，healthcheck 只用镜像自带的 `node`。实测宿主只出现一个
   `127.0.0.1:3000` 监听套接字，IPv6 loopback 与 LAN 地址均不可达。
4. **bootstrap 拆成七个容器**：M2A 的安装顺序在 psql 与 Node 之间来回切换，
   单容器必须同时具备两者。本轮不构建混合高权限镜像，改为每阶段一个只用现成
   镜像的一次性容器，顺序由 `service_completed_successfully` 固定。
5. **无 privileged / host network / Docker socket / 数据库 bind mount**；统一
   `read_only` 根文件系统、`cap_drop: [ALL]`、`no-new-privileges`、非 root 用户、
   有界 json-file 日志轮转。静态门禁经 16 项变异测试，全部捕获、0 项漏网。
6. **Compose 中没有口令或完整连接串**。`POSTGRES_PASSWORD_FILE` 与 `PGPASSFILE`
   走镜像与 libpq 自带能力；`DATABASE_URL_FILE` 与 `MEAL_AGENT_*_PASSWORD_FILE`
   是本轮**声明**的 M3 契约。凭据按最小权限逐条固定并由静态门禁断言：`api` 只拿
   runtime 连接串，一旦被塞进 admin / migration / backup 凭据即失败（验收门禁
   第 4 条）。

首轮总控复核 **Not Accepted**，按点名事项定点修订后**已由总控 Accepted，验收
落点 `d0f2219`**：

7. **handoff 的真实挂载阻断已修**：`bootstrap.sh handoff` 固定按
   `${script_directory}/../../../services/api/migrations/0000_stage_06.sql` 求
   冻结 `0000` 的磁盘 sha256，容器内即 `/services/api/migrations/0000_stage_06.sql`；
   首轮该文件不存在。现在**只给 `bootstrap-handoff`** 追加这一个文件的只读 bind，
   并在同处重述 anchor 的 bootstrap 挂载（服务级 `volumes` 整体覆盖 anchor）。
   实测容器内 sha256 与宿主一致，`/services/api/migrations/` 只可见这 1 个文件，
   `bootstrap-acl` 看不到它，真实 handoff 已越过文件检查止于数据库层。
8. **数据库 identity 暂时固定为 `meal_agent`**：删除 `MEAL_AGENT_DATABASE` 插值，
   `createdb` argv 精确固定并用 `--` 结束选项解析。修订前
   `MEAL_AGENT_DATABASE=--host=evil` 会把参数变成
   `["acl","--dbname","--host=evil"]`。可配置能力归 M3（先由统一配置 schema 校验
   `^meal_agent(_[a-z0-9_]+)?$` 与 63 字节上限，再同时生成 URL 与 Compose 参数）。
9. **静态门禁加固**：十个服务逐项固定 entrypoint/command 等；API 镜像服务缺
   `build` 即失败；secret 升级为 source + target + `*_FILE`/`PGPASSFILE` 精确
   映射；仓库内判断改用 `path.relative`；`git ls-files` 非零退出不再静默通过。
10. **worktree 资源隔离**：network 与 volume 改为 project scope 命名，
    `--project-name` 可覆盖，门禁用两个 project name 证明真实名称无交集。
11. **变异测试 27 项全部以指定理由捕获、0 漏网**。

**边界（M2B 的 Accepted 只覆盖拓扑本身，不得写成 Pass）**：**拓扑已验证；
完整 bootstrap 链与全栈启动尚未通过。**M2B 落地时 `config.ts` 只接受
`DATABASE_URL`、`bootstrap.sh` 只接受三个 `MEAL_AGENT_*_PASSWORD` environment
value，因此 `api`、`migrate`、`bootstrap-schema`、`bootstrap-logins` 当时必然
fail closed。**M3A 之后 `_FILE` 契约已被真正消费**（见下面的 M3A 实施记录），
但 `0000 → handoff → acl → migrate → grants` 的完整链路（**当时**未取得运行
证据，现由 M3B 交付，状态为 implementation complete, pending total-control
review）、备份恢复与阶段总门禁属于 M3B 与 M4。备份/恢复服务属于 M4，本轮不在
Compose 中声明。

### M3：配置和 fake 登录边界

1. 在 `infra/environments/` 增加 local-test 配置模板；所有密码、token 和 Secret 保持空值，由未跟踪环境文件或进程环境注入。
2. local-test 显式使用 `WECHAT_ADAPTER=fake` 和合成身份；不得写入真实 AppID/AppSecret。
3. 配置独立表达部署暴露级别；public、staging 或 production 暴露级别必须拒绝 fake，不能只依赖 `NODE_ENV`。local-test 配置发现非空 AppID/AppSecret 时也必须 fail closed。
4. 新增 Compose 配置静态门禁，至少拒绝：
   - API 绑定 `0.0.0.0` host publish 或省略 host IP；
   - API 通过 IPv6 或其他 host listener 暴露；
   - PostgreSQL 发布 host port；
   - API 获得 operator/bootstrap Secret；
   - privileged、host network 或 Docker socket；
   - 非空 Secret 出现在受版本控制模板。
5. 动态门禁从宿主非 loopback 地址访问 API 必须失败；`HOST=0.0.0.0` 只允许作为容器内部监听事实。
6. Secret 不通过 Docker build arg、image layer、命令行或 Compose environment value。bootstrap、migration、runtime、backup 和 restore 的数据库凭据全部通过未跟踪、权限受限的 secret file 注入，解析后的 Compose 配置与 `docker inspect` 不出现 Secret 值。API 与 migration 至少支持 `DATABASE_URL_FILE` 与 `DATABASE_URL` 互斥注入。
7. 日志脱敏补充 `databaseUrl`、`connectionString`、`password` 和 `dsn` 及常见命名变体，并增加包含带密码 PostgreSQL URL 的 sentinel 测试。
8. fake 模式不得调用外部微信服务。真实 adapter 在未来接入 Secret 前必须把 code2Session 限制到微信官方 HTTPS origin/path；自动化替身只允许在无真实 Secret 的测试环境使用。
9. 认证和家庭私有响应增加 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`；不启用 wildcard CORS。
10. 阶段 09A 不增加反向代理、TLS、域名、登录限流或 WAF。没有真实微信配置时，禁止把 local-test 拓扑改名或表述为 staging/production。

### M3A 实施记录（已由总控 Accepted，验收落点 `a839df1`）

M3 被拆成 **M3A（配置与 Secret file 消费核心）**与 **M3B（环境模板、八份 Secret 的
生成与交叉一致性、完整 Compose bootstrap 链实证）**两轮。M3A 覆盖上面第 2、3、6、
7、8、9 条的**代码侧**，状态是 **已由总控 Accepted（验收落点 `a839df1`）**——它只
覆盖代码侧消费能力，完整 bootstrap 链与全栈启动仍**不得记为 Pass**。

1. **统一的 Node Secret 来源解析器**
   [`services/api/src/config-source.ts`](../../services/api/src/config-source.ts)
   是唯一事实源，由三个入口共用：`loadConfig()`、`db:migrate`、`db:bootstrap`
   都调用同一个 `resolveDatabaseUrlSource()`，三处都不再直接读
   `process.env["DATABASE_URL"]`（有结构性测试断言这一点）。真值表：

   | `DATABASE_URL` | `DATABASE_URL_FILE` | 结果 |
   | --- | --- | --- |
   | 未设置 | 未设置 | 拒绝 |
   | 非空 | 未设置 | 采用进程环境 |
   | 空 | 未设置 | 拒绝 |
   | 未设置 | 非空 | 采用文件 |
   | 未设置 | 空 | 拒绝 |
   | 已出现 | 已出现 | 拒绝：冲突，**不比较内容**，相同也拒绝 |

   「已出现」只看变量是否是字符串，空字符串同样算已出现；选中来源失败时**不**
   回落到另一来源。文件判据 fail closed：绝对路径、`O_NOFOLLOW|O_NONBLOCK` 打开
   后 **fstat**（而不是先 stat 路径再 open）、普通文件、链接数为 1、属主等于当前
   effective UID、权限只允许 owner-only 的 `0400` 或 `0600`（因此 group/world 位、owner
   执行位与 setuid/setgid/sticky 全部拒绝）、≤4096 字节、非空、合法 UTF-8、无
   NUL、无 BOM、单行、最多移除**一个**末尾 LF 且**不做 trim**。CLI 参数合法性仍
   先于 Secret 文件读取与数据库连接。文件 I/O **不在** Zod 内：先解析来源拿到
   字符串，再交给配置 schema 校验格式。错误信息只含变量名、路径与原因。

2. **PostgreSQL bootstrap 的 Secret file 消费**
   [`infra/docker/postgres/secret-source.sh`](../../infra/docker/postgres/secret-source.sh)
   是上面那份实现的 shell 对应物，语义、判据与错误措辞一致，覆盖
   `MEAL_AGENT_{MIGRATION,RUNTIME,BACKUP}_PASSWORD` 三对来源。direct 形式保留给
   非 Compose 的本地测试，Compose 只走 `*_FILE`。**三份口令全部在任何 psql 调用
   之前解析**，任一不合格即 `exit 2`；反向测试用受控假 psql 逐例断言此时 psql
   调用次数为 **0**。口令只经 `$(< file)` 与 `printf -v` 流转，解析后立即
   `export -n`，因此不进入 argv、生成 SQL、日志，也不进入 psql 子进程的 environ；
   每次间接展开前关闭 `xtrace`，`bash -x` 下同样不泄漏。用完即 `unset`。
   `bootstrap.sh` 只增加这一段来源边界，M2A 的 ownership/ACL 流程一字未改。

3. **显式部署策略**：`DEPLOYMENT_STAGE`（`local-test`/`staging`/`production`）与
   `DEPLOYMENT_EXPOSURE`（`loopback`/`private-network`/`public`）**都没有默认值**。
   fake adapter 只在 `local-test` + `loopback` + 非 production 三者同时成立时被
   接受——27 个组合的穷尽测试里只有 2 个通过。`local-test` 携带非空 AppID 或
   AppSecret 必须在启动前失败，因此 `local-test` 与真实 adapter 在结构上互斥。
   `NODE_ENV` 与两个部署维度是三条**互相独立**的防线，任何一条都不替另一条放行。
   Compose 的 `api` 固定 `local-test` + `loopback`，静态门禁另立一节断言它，并有
   可重复的变异反向测试。

4. **真实 code2Session endpoint 收紧**为逐字节相同的
   `https://api.weixin.qq.com/sns/jscode2session`，配置层与 adapter 层各判一次。
   HTTP/WS、相似域名与子域名、`/sns/userinfo`、显式端口（含 `:443`）、尾斜杠、
   重复斜杠、大小写变体、query、fragment、userinfo 与前后空白共 24 个反例逐条被
   拒绝。fake adapter 在注入「一调用即抛错」的 fetch **并且**替换
   `globalThis.fetch` 的条件下，证明成功与失败两条分支的外部调用次数都是 0。
   本轮不接入任何真实 AppID/AppSecret，也没有调用真实微信服务。

5. **日志与 HTTP 安全边界**：脱敏移到中央 logger 边界
   （`formatters.log` 处理结构化字段、`hooks.logMethod` 处理消息串），不再依赖
   调用方主动调用 `redactSensitive`。覆盖任意嵌套层级的 `databaseUrl` /
   `database_url` / `connectionString` / `connection-string` / `password` /
   `dbPassword` / `dsn` 等命名变体，以及**按取值**识别的 PostgreSQL 连接串与
   libpq conninfo，因此口令的原值与 URL 百分号编码形态同时消失；Error 对象被
   归一化成固定安全形状。全部响应统一携带 `Cache-Control: no-store` 与
   `X-Content-Type-Options: nosniff`（挂在唯一公共出口 `onSend` 上，因此新增路由
   不可能漏掉），并断言不存在任何 `Access-Control-Allow-Origin`。本轮不新增反向
   代理、TLS、WAF 或限流。

#### M3A 首轮总控复验未通过后的定点修订

首轮复验点名四类问题，全部已修，并各自补齐了「修复前会发生什么」的实测对照：

1. **`DATABASE_URL` 的**五个核心字段**不再从 ambient `PG*` 回落**（其余 ambient
   变量的关闭见下面的第二轮修订）。node-postgres 在连接串缺字段
   时会静默回落：实测 `postgresql://` 让 host/port/user/password/database 五项
   全部来自 `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`；
   `?host=/tmp` 与 `%2Ftmp` 会把连接目标换成 unix socket，后者还让 port 回落。
   校验因此放在**三个入口共用的 `resolveDatabaseUrlSource()`** 上，而不是只放在
   `config.ts`——`db:migrate` 与 `db:bootstrap` 不经过 `loadConfig()`。判据：
   原始串拒绝 CR/LF/NUL/BOM 与未编码空白；只接受 `postgresql://` / `postgres://`；
   username/password/hostname/port 必须显式非空；database 必须是单一非空 path
   segment；拒绝 query、fragment、多 host、Unix socket 与 `options`/`host` 覆盖
   入口；对百分号解码后的 username/password/database 再查一次 NUL/CR/LF；
   校验后**返回原始串**，不 trim、不规范化、不重写口令。反例用真实
   `pg.Client.connectionParameters` 在注入 ambient sentinel 的条件下逐字段验证，
   direct 与 file 两条来源都覆盖。固定用户、`postgres:5432` 与 database identity
   仍属于 **M3B**。
2. **direct 与 file 的内容语义已统一**：非空、≤4096 字节、无 NUL/BOM/CR/LF、不
   trim、保留前后空格与 `\t`/`:`/`\`/`@`/`/`/`#`/`%`。file 仍允许一个末尾 LF，
   direct 一个都不允许——多行 direct 口令（尤其 `foo\nfoo`）会被 psql 的
   `\password` 读成两次相同输入而**静默**设置成 `foo`。三份口令任一失败时 psql
   调用数仍为 0。
3. **shell 的文件 TOCTOU 已消除（但当时仍是无界读取，见第二轮）**：
   `secret-source.sh` 现在只 `open` 一次，用
   `/dev/fd/N` 取得的 inode 与路径 stat 绑定，内容从**该描述符**复制到 `umask
   077` 的私有快照，之后全部检查与最终读取只针对快照，再也不碰原路径；快照用后
   即删并由 EXIT trap 兜底。反向测试用受控 `PATH` 上的 `stat` 包装器做确定性
   注入：metadata 检查完之后替换路径 → 仍然消费最初已验证的 inode；描述符已取、
   路径 stat 之前替换 → 以「was replaced while it was being validated」拒绝且
   psql 调用数为 0。生产脚本没有任何故障注入开关。
4. **中央 logger 边界补上了六处漏网（尚不完整，见第二轮）**。当时实测漏网六处：`child()` bindings、printf
   `%j`、printf `%o`、own enumerable `toJSON`、带引号的
   `password=' …'` conninfo（各自 LEAKED），以及数组循环引用（直接
   `RangeError` 栈溢出）。现在 `hooks.logMethod` 在插值**之前**处理全部参数、
   `child()` 被覆盖且子 logger 继续带着覆盖、canonicalizer 把函数值一律换成占位
   串、conninfo 采用「看到 `password=` 就删掉其后全部文本」的保守口径、循环防护
   对象与数组共用且按路径记录、`req` serializer 的 path 再做一次文本脱敏。8 组
   用例全部扫描**真实 Pino 最终输出**。

#### M3A 第二轮总控复验未通过后的定点修订

第二轮点名的四类问题同样已修，每条都有「修复前会发生什么」的实测对照。**第一轮
的表述当时超出了实际范围**：ambient 只关了五个核心字段、shell 只消除了 TOCTOU
但读取仍然无界、logger 只补了六处入口——这三条已在上面按实际范围改写。

1. **仍会影响 node-postgres 的 ambient 变量已全部关闭**。连接串只能决定五个核心
   字段；`PGOPTIONS`、`PGSSLMODE`、`PGSSLNEGOTIATION`、`PGBINARY`、
   `PGREPLICATION`、`PGCLIENT_ENCODING`、`PGAPPNAME`、`PGCONNECT_TIMEOUT` 没有
   URL 对应物，实测（`pg@8.22.0`，同一条合法 URL）会逐一落进
   `connectionParameters`。现在在共用边界逐条拒绝，错误只列变量名、不回显取值；
   检查同时覆盖传入的 environment 与 `process.env`（node-postgres 读的永远是
   后者）。direct/file、API、`db:migrate`、`db:bootstrap` 全覆盖，CLI 以校验错误
   而不是连接错误退出。拒绝表按 pg 源码逐条列出，并用一条断言把 pg 版本钉住。
2. **Pino 的公开变更入口已封闭**。修复前实测九处 LEAKED：root/child/grandchild
   的 `setBindings`、子 logger 的 `serializers`/`formatters.log`/
   `formatters.bindings`/`redact.censor`（函数与字符串）/`msgPrefix`，以及**百分号
   编码**的连接串。现在 `setBindings` 与 `child()` 都过同一个 canonicalizer，
   子 logger options 走**安全包装**而不是一刀切拒绝（Fastify 自己就带着 options
   调用 `child()`），`redactText` 增加百分号编码探测（解码只用于判断，命中即整条
   替换，绝不把解码结果写进日志）。
   同时修复了**请求日志信息丢失**：`logMethod` 此前对第一个参数用通用
   canonicalizer，把 Fastify 的 `Request` 拍平成普通对象，于是 `method`/`url`
   这些**原型取值器**全部消失、`res` 只剩空对象——日志看起来「没泄漏」，其实是
   把请求信息一起丢了。现在第一个参数走与 `formatters.log` 相同的那一层，
   `req`/`res`/`err` 留给各自的 serializer，并**正向**断言 method、脱敏后的
   path、remoteAddress 与 statusCode 全部存在。
3. **shell 读取已有界**。粗筛与 `open()` 之间路径仍可能被换成**无写端 FIFO**，
   而 shell 没有 `O_NONBLOCK`：修复前实测**永久阻塞**（20 秒后仍未退出，只能被
   外部杀死）。现在 open + 校验 + 复制跑在后台子进程里，父进程 5 秒有界等待后
   TERM 再 KILL，实测 5—7 秒内以明确理由失败、psql 调用数 0、无残留读端
   （FIFO 以 `O_WRONLY|O_NONBLOCK` 打开必然 `ENXIO`）、无快照残留。复制改用
   `head -c 4097` 而不是无界 `cat`，因此「`fstat` 之后文件增长」也是有界拒绝：
   仍在上限内报 changed size，超过上限报 grew past 4096 bytes。
4. **U+FEFF 判据已统一**。此前 file 只查开头、direct 查任何位置，同一份取值在
   两条来源上结论不同。现在两侧都按「任何位置」判定，并补了内部与结尾 U+FEFF
   的反例。

#### M3A 第三轮总控复验未通过后的定点修订

第三轮点名的三个 P1 已修，各自都有修复前实测：

1. **logger 实例隔离**。`hardenLogger` 用 `bind(logger)` 把 root 绑死，而 pino 的
   `child()` 是 `Object.create(this)`——子 logger 通过原型链继承到**已经绑定 root**
   的覆盖，于是 grandchild 从 root 派生（丢掉 parent 的 binding）、
   `child.setBindings()` 改的是 **root**、root 的输出里出现子 logger 的 binding。
   改为保留调用时的**动态 `this`**：覆盖只安装一次，每一层操作的都是它自己那个
   实例。六项断言逐条覆盖继承与隔离，并要求 binding 里的 Secret 仍被脱敏。
2. **中央 logger 输出边界补齐**。`formatters.level` 此前没有被包装，
   `customLevels` + `formatters.level` 是一条完整的注入路径；百分号编码探测只解
   一轮，双重编码与「畸形 `%ZZ` 前缀 + 合法编码」都能绕过；不符合 Pino 类型契约
   的 `redact.censor`（对象/数组/数字/布尔）被原样透传。现在三个 formatter 入口
   全部包装，解码改为**有界重复**（上限 4 轮、收敛即停、整串解码失败时回落到逐个
   `%XX` 的宽松解码），非法 censor 与非法 redact 形态 fail closed，并在**真实
   Fastify 请求日志**层补了反例。
3. **shell 后代清理**。超时此前只 kill worker 这一个 PID，被拖住的后代（复制阶段
   的 `head`）会被留成孤儿继续持有描述符——实测 worker gone、被阻塞且**忽略
   TERM** 的 head 仍 ALIVE。现在 worker 是独立进程组的组长（`set -m`），超时对
   **整个进程组** TERM 再 KILL；新增反例证明 worker 与全部后代 PID 都消失、
   FIFO 无残留 reader、快照目录为空、psql 调用数 0、输出无 sentinel。

机械收口：FIFO 与 stalled-copy 两条回归加了 12 秒外部 timeout 并断言它**没有**
触发，耗时上界从 30 秒收到 10 秒（实现自身上界 5 秒）；「FIFO 仍会永久挂起」的
旧说明已删除，改为修复后的真实边界；ambient 文案统一为「拒绝 URL 无法覆盖的 8 个
`PG*`」；Secret 权限口径统一为 owner-only 的 `0400` 或 `0600`，实现、错误措辞与
测试断言一起改。

两侧解析器的关系表述已统一改为「**按条对齐**」而不是「完全同语义」：Node 侧
`fstat` 文件描述符，shell 侧用 inode 绑定 + 私有快照。两侧的读取都是**有界**的
（Node 靠 `O_NONBLOCK`，shell 靠独立进程组 + 5 秒上界 + 整组 TERM/KILL），
机制差异登记在 `infra/docker/postgres/README.md`。

#### M3A 第四轮总控复验未通过后的定点修订

第四轮要求的不是继续逐个 sentinel 打补丁，而是把 logger 的**信任上下文**拆开。
现在只有两个，任何一处输出都必须明确属于其中之一：

1. **strict / untrusted canonicalizer**——child bindings、`setBindings()`、
   `formatters.level` / `formatters.bindings`、调用方 formatter / serializer /
   censor 的返回值全部走它。它**没有** `req`/`res`/`err` 豁免，同时处理属性名
   与属性值。
2. **log-record canonicalizer**——只有**真正的顶层 log record** 才允许把
   `req`/`res`/`err` 延后给固定 serializer；固定 serializer 一律新建纯对象，
   产物**再走一次** strict。因此「伪造一个 `req` 键」拿不到任何豁免。

同轮修掉的还有：百分号解码达到 4 轮上限时改为 **fail closed**（上一轮在上限处
返回「安全」，而那恰好是编码层数比上限还多的最可疑情形）；外部信号
（TERM/INT/HUP）与内部 5 秒超时共用同一段 worker-group 清理——修复前
bootstrap 被 SIGTERM 打断时 worker/head/sleep 三层全部留了下来。

#### M3A 第五轮总控复验未通过后的定点修订

第五轮点名的三个 P1 已修，每条都有修复前的实测输出：

1. **Error 的自动 msg 泄漏**。pino 的 `write()` 在 `msg` 缺省时直接取
   `_obj[errorKey].message` 当顶层 `msg`，那条路径**完全绕过 serializer**，所以
   「只在 serializer 里安全化」全程无效。修复前
   `logger.error(new Error(dsn))` 的真实输出是
   `"err":{"type":"Error","message":"request failed"}` 配上
   `"msg":"postgresql://app:p@ss-SENTINEL@db:5432/meal_agent"`；四种调用形状
   （`error(err)`、`error(err, undefined)`、`error({err})`、`error({err}, undefined)`）
   都覆盖。折叠改到**交给 pino 之前**完成。`Error.name` 同时改成**精确
   allowlist**——原来是「符合类名格式即可信」，而 `SimplePasswordSecret123` 完全
   符合那条正则；名单之外一律输出 `Error`，本仓库真实定义的错误类与内建类型按
   明确策略保留，用例断言未列入名单的名字一个字符都不出现在输出里。
2. **strict canonicalizer 不再执行输入自带的转换方法**。数组改为新建数组按下标
   递归（`hostileArray.map` 调用次数 1 → 0，迭代器同样不走）；BigInt 走原始值
   转换，覆写 `BigInt.prototype.toString` 无效；记录层不再用 `Object.entries`
   （那会**读**属性从而执行 getter，getter 调用次数 1 → 0），访问器一律记成
   `[Getter]` 且不给 `req`/`res`/`err` 延后豁免；遮蔽 `Object.prototype` 成员的
   结构键统一改名——修复前 `JSON.parse('{"hasOwnProperty":"shadowed"}')` 会让
   pino 的 `asChindings()` 自己抛 `TypeError: Cannot convert undefined or null to
   object`，`__proto__` 改名后下游也碰不到原型访问器。设计边界维持不变：
   Secret/键值是**非可信数据**，logger 配置回调是受信代码或被拒绝，没有引入
   「沙箱任意 JavaScript 回调」的机制。
3. **信号清理重做成显式状态机**（`idle / starting / running / terminating`）。
   修复前 PID 在清理**开始时**就被清空，于是清理途中的第二个信号看到「没有
   worker」，跳过清理直接把父进程带走——实测「TERM 之后 0.1s 补一发 HUP」会让
   用例卡满 12 秒硬上界（父进程已死，存活的 worker 组继续持有 bootstrap 的
   stdout/stderr 管道）；重投信号前做的又是 `trap - "$signal"`，即恢复**默认**
   处置，调用方自己装的 handler 根本没机会跑（实测三次都是
   `null / SIGxxx` 而不是 71/72/73）。现在：先装 trap 后起 worker（`starting`
   覆盖那段窗口）、trap 里只登记、清理回主流程做、PID 保留到 TERM/KILL/`wait`
   三步全部完成、并发裁决明确为**先到者胜**并写进注释与用例。

用例本身也改成 failure-safe：整条外部信号用例套 12 秒硬上界（没有裸
`await exited`）、等 `close` 而不是 `exit` 以保证 stdout/stderr 已排空、
`child.pid` 显式断言为正整数（`?? 0` 之后的 `kill(-0, …)` 会把信号发给测试
进程自己所在的进程组）、`finally` 无条件读取所有已出现的 PID 文件并只对**真实
PGID** 用 `kill(-pgid)`（head/sleep 不是组长，只按单个 PID 收）、文件级
`after` 不再长期堆积已死 PID。stall wrapper 的 head 与它派生的 sleep 现在都
忽略 TERM/INT/HUP，因此「TERM 就够了」这条捷径被堵死。

bash 3.2/macOS 与 pinned Debian bookworm/bash 5.2/uid 999 两侧同一组场景实测
全通过；API unit 124 / HTTP 8 全绿。**M3A 仍为 implementation complete,
pending total-control review，未标记 Accepted。**

#### M3A 第六轮总控复验未通过后的定点修订

第六轮点名的四组问题已修，每条都有修复前实测。

**Logger：descriptor-safe 推到每一个入口。**

1. **数组下标**此前是 `value[index]` 普通读取。下标同样可以是访问器
   （`Object.defineProperty(a, 0, { get })`，`Array.isArray` 仍为真），因此对象
   分支的加固对数组完全不生效。实测三种载荷：getter 返回 Secret、getter 抛错、
   getter 篡改 `Array.prototype.toJSON` 与 `Object.prototype.toJSON`——修复前
   getter 被执行且抛错**直接把整条日志调用带走**（`Error: index getter exploded …`），
   修复后调用次数 0、日志正常、输出记 `[Getter]`、两个 prototype 未被触碰。
2. **`Error.name` 与伪造归一化形状的 `type`** 改为沿**原型链**解析描述符。只看
   自身描述符是不够的：`class E extends Error { get name() { … } }` 的实例
   `getOwnPropertyDescriptor(instance, "name")` 返回 `undefined`，而
   `value.name` 照样把原型上的 getter 执行掉。现在自身访问器、继承访问器、解析
   不出数据属性——一律降级为 `Error`。`TypeError` 这类内建类型不受影响，它们的
   `name` 是原型上的**数据属性**。修复前实测：`name` getter 被执行并抛错。
3. **伪造的 `req`/`res` 不再拿到 serializer 豁免。** 此前豁免只看键名，
   `serializeRequest` 又是七层普通成员读取（`url` 还读了两次，先过
   `typeof === "string"` 再拿去 `.split`）。修复前实测：伪造 `req` 的 `url`
   getter 被执行并抛错，异常**逃出 `logger.info()`**。
   现在走两条路：`app.ts` 在 `genReqId` 里登记原始 `IncomingMessage`——那是能
   拿到「这条请求确实来自 Fastify」的**最早**的点（实测顺序是
   `incoming request` → `onRequest` hook，所以 `onRequest` 太晚，第一条请求日志
   会漏）；`raw` 指向已登记对象的才是真 Request，才允许读它的原型访问器。其余
   一律走「只读数据属性」的安全投影。实测 fastify 5.10.0 的真实 Request：
   `method`/`url`/`ip`/`socket` 全是 `Request.prototype` 上的访问器，
   `id`/`raw` 是自身数据属性，`raw.method`/`raw.url` 也是自身数据属性——所以
   收紧之后真实请求日志的 method/path/requestId/remoteAddress/statusCode 一个
   不少。
4. **`Stage06ManifestError` 补进 allowlist**，并新增
   `tests/unit/error-type-allowlist.test.ts`：直接扫 `src/` 的
   `this.name = "X"` 与 `class X extends Error`，未登记即门禁变红。它自己也被
   负向验证过——临时移除 `Stage06ManifestError` 立刻报
   `silently collapses them to "Error": Stage06ManifestError`。测试用错误类
   （`AuthorizationCleanupError`）显式排除在外，这个决定被写成断言而不是靠扫描
   范围的巧合。第一版扫描器还把 logging.ts 注释里举例的 `class Boom extends
   Error` 当成了真实类，因此改成行首锚点 + 先剥注释。

顺带修掉的两处（同一轮审计发现，不在点名清单里）：`hardenChildOptions` 用
`{ ...source }` 展开调用方 options，每个访问器至少跑两遍且两次返回值可以不同
（先给一个能过 `typeof` 校验的形状、再给真正写进输出的那个）——改成读一次的
描述符快照；Fastify 的 defaultErrorLog 会调用
`reply.log.error({ req, res, err }, error?.message)`，msg 是**显式传入的字符串**，
绕开了「pino 从 `err.message` 自动生成 msg」那条已经封掉的路径——修复前实测
sentinel 直接进了日志流，现在按描述符取出 err 的 message 并逐字比对后换成固定串。

**signal 状态机：两个真实竞态 + 一个 trap 所有权问题。**

1. **超时清理之后没有重新检查 winner。** `meal_agent_terminate_worker_group` 中间
   有 0.2 秒的 TERM→KILL 等待，信号完全可能落在那里；trap 只负责登记，主流程
   如果直接 restore + fail 就把它吞了，调用方的处置永远不生效。现在超时路径与
   有界等待的每一轮走同一条统一收尾。
2. **loser 竞态。** 此前是「恢复全部三个 trap → 重投 winner」，两条语句之间
   loser 会命中调用方的处置。实测（winner 的 handler 故意慢一点，loser 确定地落
   在它执行期间）：**期望退出码 71，实得 73**，winner 的 handler 甚至没跑完。
   现在重投前先把另外两个换成「只登记 pending」的抑制 handler，只归还 winner
   那一个，投递完成后再归还其余。正常完成之后的重投是**第二个独立出口**，也
   改成走同一条 `meal_agent_abort_on_signal`，不再各写一遍。
3. **EXIT trap 所有权。** 这个文件是被 `source` 进 bootstrap.sh 的，一句裸的
   `trap '…' EXIT` 把调用方的 EXIT 处置整条换掉。实测：调用方的 marker 在全部
   9 个场景里都没出现。现在保存 → 链式执行 → 解析结束归还，并有真实 marker 断言
   （含「归还之后 `trap -p EXIT` 里不能再有我们的 handler」）。
   `meal_agent_install_signal_traps` 也补上了幂等保护：第二次安装会把**我们自己
   的** handler 存成「调用方原有的」。

**测试证据。**

- **断言先于清理。** 上一轮 `runSignalScenario` 的 `finally` 在返回给调用方
  **之前**就 SIGKILL 了整棵子树，于是后面那句 `processIsGone(...)` 证明的是
  「测试自己把它杀了」。现在进程存活、FIFO 读端、快照残留、后代枚举全部在
  `finally` 之前采集并冻结进 outcome；`finally` 只兜底。另外补了一条**正向**
  断言：发信号之前 FIFO 确实有读端。
  说明边界：把清理函数整个掏空做变异测试时，新旧两种顺序都会失败——因为在这个
  harness 里任何存活的后代同时也持着 bootstrap 的 stdout/stderr，一定先撞上
  12 秒硬上界。也就是说旧顺序是**因果上不成立**，但并没有被实测出一次假通过；
  这里不把它写成「修复了一次假绿」。
- **hard-cap 路径能收未知 pgid。** worker 在 `set -m` 下是独立进程组的组长，
  而它的 PID 只有在跑到复制阶段之后才会被写进文件。新增用例用已有的 stat
  wrapper 在粗筛之后把常规文件换成无写端 FIFO，让 worker 卡在 `open()`——它确实
  存在、确实自成进程组、且 PID 文件永远不出现；清理改用等待期间持续采样得到的
  **真实 pgid** 集合，并有界确认最终一个后代都不剩。
- **窗口投递不再猜时间**：由实现暴露的 marker 决定。
- **四种调用方处置**（默认 / handler 自杀 / handler 只返回 / `trap '' SIG`）
  全部覆盖，见下。
- **矩阵进了容器门禁**：`infra/docker/postgres/signal-matrix.sh`（83 项断言）由
  `tests/unit/bootstrap-signal-matrix.test.ts` 在本机 bash 3.2 与**钉住 digest 的
  postgres:18.4-bookworm 内以 uid 999** 各跑一遍。**这条门禁因此新增了 Docker
  前置条件**，并且刻意不做静默跳过。

**第七轮自查（对抗性复核）又发现并修掉的问题。** 上面那些改完之后，我又对每一条
要求做了一次以「推翻它」为目标的复核，结果推翻了自己五处：

1. **`raw` 身份判据可被绕过。** `raw` 在 Fastify 5 的 Request 上是**自身可枚举
   数据属性**，所以 `{ ...request }`、`{ raw: request.raw, get ip() { … } }`、
   `Object.create(request, …)` 全都能通过检查，随后又被当成可信对象做普通成员
   读取——伪造对象的 getter 调用次数实测 5，而用例期望 0。原因是第一版用例只把
   `raw` 写成访问器，那恰好是唯一必然失败的形状。现在**可信的是那个已登记的
   `IncomingMessage` 本身**，投影只从它身上取，requestId 也取自登记时记下的那
   一个；伪造 wrapper 就算塞进真 `raw`，也只会打出那条真实请求的信息。
2. **原型污染仍能在 `JSON.stringify` 阶段重新生成 Secret。** 新建的 `{}` / `[]`
   继承 `Object.prototype` / `Array.prototype`，挂上 `toJSON` 就能把整棵脱敏干净
   的树替换掉（Proxy 的 `ownKeys` trap 可以在我们枚举的过程中完成污染）。现在每
   个新建容器都带一条不可枚举的自身 `toJSON: undefined` 遮蔽，并**移除了根
   logger 的 `redact`**——`@pinojs/redact` 会先做选择性克隆再序列化克隆体
   （`index.js:522`），克隆体带不上遮蔽，而 `*` 通配路径会让**每一个键**都走这条
   克隆路径。它的两类路径此时已分别被固定 serializer 的 4 字段投影和 canonicalizer
   的任意深度键名脱敏覆盖，因此是纯粹的冗余加风险。
3. **`rawHeaders` 泄漏。** 把整个 request 记在一个非 `req` 的键下面时，
   `rawHeaders` 是扁平字符串数组，逐键规则看不见里面的 authorization / cookie。
   现在整条数组按敏感键处理。
4. **shell 的链式 EXIT trap 丢掉了 `$?`。** `trap 'rc=$?; …' EXIT` 是最常见的写法，
   而链式执行前的两条语句已经把 `$?` 覆盖成 0（实测：真实状态 2，调用方看到 0）。
   现在先关 errexit、再用一个只做 `return` 的辅助函数置回状态、最后 eval。
5. **`meal_agent_restore_one_signal_trap` 自己留了一段 SIG_DFL 窗口。** 它先写
   `trap - "$signal"` 再 `eval "$saved"`，两条语句之间处置是默认的——重投窗口里
   再来一发同名信号就会按默认处置把进程带走，连调用方的 handler 和 EXIT trap 都
   跳过（实测：不设间隔连发 TERM，39/40 次退出 143 而不是 71）。`eval "$saved"`
   本身就是原子替换，因此只有在调用方本来就是默认处置时才需要显式复位。

测试证据侧同样被推翻两处，一并修掉：`residualDescendants` 在 bootstrap 已经死掉
之后才从它出发枚举后代，而孤儿会被 reparent 到 pid 1，所以那个检查**恒为空**；
`withHardCap` 是不取消的 `Promise.race`，两个轮询循环没有自己的 deadline，于是
断言红了之后 runner 永远不退出（实测 45 秒仍在跑）。现在残留检查改成对**采样期间
见过的每一个 PID** 逐个有界确认，两个循环各自带 deadline；那条「PID 文件不存在」
的重言式守卫也换成了「采样到的进程组里必须有一个不是 bootstrap 自己的」。
allowlist 漂移扫描补上 `override readonly name = "X"` 类字段与
`class X extends <RepoError>` 两种写法，并加了三条正向自检——否则「没有漂移」也
可能只是正则从来没匹配到任何东西。

**（当时状态：M3A 仍为整改中。M3A 已于 Round 14 收口后由总控 Accepted，验收落点
`a839df1`。）**

#### M3A 第七轮总控复验未通过后的定点修订

第七轮点名的八条，每条都先在 `1855aec` 上跑出失败，再在新实现上通过。

**Logger（六条现场反例，全部扫描真实 Pino 最终输出）**

| 反例 | `1855aec` 实测 | 现在 |
| --- | --- | --- |
| err record 的显式 msg 无条件折叠 | sentinel 进入日志流（判据是「与 err.message 逐字相同」，包装/截断即可绕开） | 六种形状的 msg 全部是固定串 |
| 子 logger 自带 `redact` | 不抛错，照常接受 | 一律 `child loggers may not configure redact` |
| 归一化后的 `setcookie` 与 `rawTrailers` | 取值原样进日志（名单里写的是 `"set-cookie"`，归一化后永不匹配） | `[Redacted]` |
| 公开 trust registrar | 登记一个自造对象后，它的 `socket.remoteAddress` getter 被执行 2 次 | 调用次数 0；登记点只捕获**不可变快照** |
| 环状 `req` wrapper | `RangeError: Maximum call stack size exceeded` | 四种环/深链都正常出日志 |
| 被改写的 `DOMException.prototype.name` | getter 被执行 1 次 | 调用次数 0，类型降级为 `Error` |

顺带：`canonicalizeUntrusted` 补了 64 层递归上界（`seen` 只挡环、不挡深度，5000
层嵌套一次调用就能耗光栈）；`net.Socket.prototype.remoteAddress` 与
`DOMException.prototype.name` 都改成比对**模块加载时抓下来的原始函数引用**，而不
是「持有者是那个原型」——后者等于把执行权交给任何能改写原型的人。

无条件折叠的代价是明确的：`log.error({ err }, "connection failed")` 这类调用方
自己写的 msg 也会变成固定串。仓库里那条既有断言已经按新语义改写，而不是删掉。

**信号（第 3、4、5 条）**

- **trap 作用域推到整个 `resolve_secret`**。上一版在 worker 结束后立刻归还，于是
  「快照验证 → 取值复制 → 删除快照」三步跑在调用方的处置之下。新增的 post-worker
  用例证明这是活的缺陷：在删除快照那一步发 TERM，调用方 `trap '' TERM` 或
  handler 只返回时，`1855aec` **照常成功并打出 RESOLVED**（exit 0）——被中断了却
  装作读到了。现在 fail closed（exit 2，"interrupted by a signal"，无 RESOLVED）。
- **生产代码里的测试入口整条删除**。`MEAL_AGENT_SECRET_WINDOW_MARKER_DIR` 与
  `meal_agent_mark_window` / `meal_agent_await_window_release` 已从
  `secret-source.sh` 移除：那是一个可写文件 + 阻塞等待的入口，不该留在生产路径上。
- **窗口改由测试侧观察定位**。`terminating` 看受控 `head` 自己 trap 到的 TERM
  （那是实现对整个 worker 进程组发 TERM 的真实外部效果）；`post-worker` 看 PATH
  影子 `rm`（`discard_snapshot` 用的就是 `rm -rf`）。
- **`starting` 窗口不再声称已被证明**。它没有任何外部可观测副作用，无法被真实
  确定地命中；现在只由代码顺序保证（先装 trap、后 fork），矩阵与文档都据实改写。
- 矩阵新增每 case 25 秒看门狗、退出时按进程组统一清理；容器侧加 `--init` 与
  `docker rm --force` 兜底（`spawnSync` 的 timeout 只杀本地客户端，容器会留下来）。
  断言条数 92 → **106**，并在门禁里改成**精确相等**而不是下界。

**测试证据（第 6 条）**

「the hard cap still collects a worker whose pid file never appeared」名不副实——它
自己发信号、自己等结束，12 秒上界一次都没到过。现在拆成两条：一条诚实改名为
「the fallback cleanup collects a worker process group with no pid file」，只声称
它真正证明的事；另一条是新加的、**真的会触发** hard cap 的用例（不发任何信号、
自带 2.5 秒上界），并断言触发之后受控子树被收干净。后者明确**不**断言「无快照
残留」：hard cap 之后是测试自己 SIGKILL 的，而 SIGKILL 不跑 EXIT trap，残留是
测试的行为不是实现的缺陷；「被信号打断时不留快照」由矩阵在**实现自己收手**的
路径上证明。

**M3A 仍为整改中，未标记 Accepted。**

#### M3A 第八轮总控复验未通过后的定点修订

**信号（第 1 条）**

| 反例 | `f67225e` 实测 | 现在 |
| --- | --- | --- |
| pre-worker metadata 阶段定点 TERM（default / exit / ignore / return 四种处置） | 四种全部 exit 0 并打出 RESOLVED——信号被静默吞掉 | 143 / 71 / 2 / 2，都没有 RESOLVED |

根因：winner 的初始化写在 `meal_agent_read_secret_file` 里、worker 起来之前，
而 trap 从 `resolve_secret` 入口就装上了。metadata 阶段（变量名校验 → `stat`
探测 → `mktemp -d` 建快照目录）收到的信号已经记进 winner，然后被那句重置**整条
抹掉**。现在初始化移到 resolve 入口、装 trap **之前**，且只做一次；
`read_secret_file` 里的那句重置删除，并在起 worker 之前加了一个 pre-worker
检查点。

「final winner check → restore traps」之间还有一个窗口：落在那里的信号由我们的
handler 记下来，却再也没人去看它。现在归还之后**再读一次**——此刻我们的 handler
已经卸掉，能被登记的信号集合到此为止是最终的，补投一次就把处置权真正交回调用方。
再之后到达的信号本来就该由调用方处置。

**Logger（第 2 条，四条现场反例）**

| 反例 | `f67225e` 实测 | 现在 |
| --- | --- | --- |
| carriesError 与 canonicalization 同一份快照 | 有状态 Proxy 让两次探测看到不同形状，产出「带 err + 未折叠 msg」的自相矛盾记录 | 一次快照，两者一致 |
| 装箱字符串 msg | msg 被拍成逐字符对象，秘密完整可读 | `request failed` |
| `Proxy-Authorization` / `X-API-Key` | 取值原样进日志 | `[Redacted]` |
| 登记函数不读任何属性 | 自造对象的 `socket.remoteAddress` getter 被执行 1 次 | 0 次 |

方向是**收窄**而不是继续扩展任意对象/Proxy 净化器：请求的四个字段改在 Fastify 的
可信边界（`genReqId`）读完、物化成字符串，logger 侧的 `registerRequestLogFields`
一个属性都不读。新增静态门禁 `production-log-arguments.test.ts`：`src/` 里任何
`log.<level>(` 的第一个实参都不得出现裸 `request`/`reply`/`raw`/`error`/`config`/
`secret`/`password`/`token`；生产调用点改用 `safeErrorRecord(error)`。把
`f67225e` 的 `app.ts` 放回去，这条门禁立刻变红。

**矩阵 failure-safe（第 3 条）**

- 看门狗改成**自己进程组的组长**并整组回收，还要**有界确认它的 `sleep` 子进程
  消失**。只 kill 看门狗自己时，实测每个 case 都会漏下一个 `sleep 25`（21 个 case
  就是 21 个），它们会一直挂到自然醒。
- 全局 EXIT 清理登记 driver、worker、watchdog **三者的真实 pgid**。
- 容器名按 `pid + worktree 摘要` 唯一，并且只删带**本次 ownership label** 的容器
  ——不按名字模糊匹配，也不碰别人的容器。
- hard-cap 复核把 **bootstrap 根进程**一起纳入：上一版只查 worker/head/sleep 三层，
  而 hard cap 之后最可能剩下的恰恰是那个还在等 close 的根进程。
- 新增「矩阵结束瞬间没有多出 `sleep 25`」的外部反例（矩阵内部也逐个断言一遍）。

断言条数 106 → **150**。**150 是断言条数，不是全组合覆盖**：每个窗口只挑与它
相关的处置组合，不是「4 种处置 × 3 个信号 × 6 个窗口」的笛卡尔积。

**M3A 仍为整改中，未标记 Accepted。**

#### M3A Logger 架构收口（第十轮）

前九轮的方向是「让中央 logger 能安全地吃下任意对象」。那条路走不到头：原型污染、
有状态 Proxy、装箱字符串、继承访问器、结构键、索引访问器——每一轮都还能再找出
一个，因为它试图在**出口**证明一个关于任意输入的全称命题。这一轮换方向。

**1. 业务代码不再把任意对象交给 logger。**

新增 `src/log-events.ts`：闭集事件（`request.failed` / `request.rejected` /
`shutdown.started` / `shutdown.timed-out` / `startup.failed`），每个事件的字段显式
声明，字段类型只允许 `string | number | boolean | null`。级别与 msg 都来自事件
目录，调用点没有自由拼接的余地。原始 Error / Request / Reply / Config / Secret
**在类型上就进不来**——不是「进来之后会被净化」，是编译期不可表达。
`logEvent()` 还会逐字段复制并丢弃非原始类型的取值，即使有人用 `as` 绕过类型也
进不了 payload（用例逐条断言）。

原来的 `safeErrorRecord` 收窄成 `errorTypeOf`：它只返回 allowlist 里的类型名，
是原始 Error 与业务日志之间**唯一**的桥。

**2. 静态门禁从正则换成 TypeScript type checker。**

第九轮的门禁是 `\blog\.(info|warn|…)\s*\(` 加一次源码文本切分，只看**第一个**
实参。它有一整类结构性漏网。`tests/fixtures/log-escape-shapes.ts` 把六种写法逐条
摆出来：别名、变量改名、元素访问、可选链、printf 后续参数、常量下标 + `call`。

现在的判据是「凡是调用一个类型为 pino `LogFn` 的表达式（无论怎么取到它），或者
对它用 `call`/`apply`/`bind`」，`src/` 里只有 `log-events.ts`（facade）与
`logging.ts`（边界本身）允许出现这种调用。

实测对照（同一段代码，两套扫描器）：

| | 第九轮正则门禁 | 第十轮 AST 门禁 |
| --- | --- | --- |
| 六种漏网写法的 fixture | 0 条违规（**全部假绿**） | 7 处调用点全部命中（别名那种被 `.bind` 与裸调用各抓一次） |
| 往 `src/index.ts` 注入 `const audit = app.log; audit["info"]({ signal, config }, …)` | **匹配到 0 个调用点、报告 0 条违规** | 直接变红 |

**3. `logging.ts` 的净化器降级为纵深防御。**

它不再是业务日志的安全依据，只覆盖两类绕不过 facade 的输入：Fastify **自己**打的
请求日志（`incoming request` / `request completed` / defaultErrorLog），以及未来
代码万一直接拿到 logger 时的兜底。`req`/`res`/`err` 三个固定 serializer 因此保留，
但**不再为「任意对象 / Proxy」增补特例**——真正的边界在类型系统那一侧。这一点写进
了 `logging.ts` 的文件头与 serializer 段落的注释。

**本轮不动**已经通过复验的 Secret 信号状态机与矩阵运行逻辑。

**M3A 仍为整改中，未标记 Accepted。**

#### M3A typed facade 最终收口（第十一轮）

**1. 参数上的开放索引签名删掉了。**

第十轮的 `logEvent` 参数是 `LogEventFields[Event] & Readonly<Record<string,
LogFieldValue>>`。那个交叉项等于把「随便加一个原始类型字段」重新放了回来，而
实现又靠 `Object.keys(fields)` 遍历——「先看看传进来了什么，再决定留哪些」。

现在参数就是 `LogEventFields[Event]`，每个事件有**固定的 runtime projector**，
逐个字段**按名字**取值。未声明的字段在结构上就到不了 payload：不是遍历时被过滤
掉，是根本没被读过。`event` 是保留字段——projector 产不出它，assemble 时它最后
写入，调用方没有任何路径能覆盖。

**2. 字段是专用安全类型，不是自由字符串。**

| 字段 | 类型 | 运行期验证 |
| --- | --- | --- |
| `errorType` | branded `SafeErrorType`，只能由 `eventErrorType()` 产生 | 必须在 `allowedErrorTypes` 里 |
| `errorCode` | 项目真实的 `ApiErrorCode` union | contracts 的 `apiErrorCodeSchema` |
| `statusCode` | `number` | 必须是 100–599 的整数 |
| `signal` | `"SIGINT" \| "SIGTERM"` | 只接受这两个值 |

验不过就**抛错**（fail closed），不写占位串。`index.ts` 的 `shutdown()` 参数也
从 `NodeJS.Signals` 收窄成 `ShutdownSignal`。

**3. 真实 `createLogger` 反例（`tests/unit/log-events.test.ts`，5 条）。**

额外 primitive 字段、`event` 覆盖、declared string 携带 opaque Secret、child
binding 携带 opaque Secret、五个事件的完整 round-trip——每条都扫描真实 Pino 最终
输出，sentinel 命中为 0。

child-binding 那条当场抓出一个真实缺口：裸的 `apiKey` 归一化成 `apikey`，而键名
规则里只登记了 `xapikey`（`X-API-Key` 的归一化形式），没有 `apikey` 后缀规则。
已补上。

**4. AST 门禁从「调用」扩到「能力」。**

第十轮只看 `CallExpression` 的 callee。用第十一轮新增的写法逐条打它：

| 写法 | 第十轮检测器 | 第十一轮 |
| --- | --- | --- |
| `Reflect.apply(logger.error, …)` | **MISSED** | `[LogFn] logger.error` |
| 高阶转发 `forward(logger.warn)` | **MISSED** | `[LogFn] logger.warn` |
| 类型擦除 `logger.fatal as unknown as …` | **MISSED** | `[LogFn] logger.fatal` |
| `logger.setBindings({…})` | **MISSED** | `[mutation] logger.setBindings` |
| `logger.child({…})` | 只抓到随后的 `child.info` | `[mutation] logger.child` |

现在的判据是**任何类型为 `LogFn` 的表达式**——调用与否无关紧要，拿到了就是拿到
了。规则三条：`LogFn` 只允许出现在 `log-events.ts` 与 `logging.ts`；
`child`/`setBindings`/`flush`/`level` 等 mutation API 只有 `logging.ts` 可以碰；
组装根 `src/app.ts` 可以**命名** logger（它得交给 Fastify），但一旦在它上面做成员
访问就变红。实测：往 `app.ts` 注入 `logger.child({…})` + `audit.info(…)`，门禁
立刻报出 `src/app.ts:182 -> [mutation] logger.child` 与
`src/app.ts:183 -> [LogFn] audit.info` 两条。

第九轮那条正则扫描器仍逐字保留在测试里跑对照：它对整份十一种写法的 fixture 报告
**0 条违规**。

**本轮不动**已经通过复验的 Secret 信号状态机与矩阵运行逻辑。

**M3A 仍为整改中，未标记 Accepted。**

#### M3A 架构定点收口（第十二轮）

本轮不再补敏感键黑名单——那条路补不完。改动全部在架构面。

**1. 业务代码连 logger 本身都拿不到。**

`logEvent(logger, event, fields)` 换成 `EventLogSink`：由组装根从 **root logger**
创建，闭包持有，只有 `emit` 一个方法，没有 `child()` / `setBindings()`，也没有
取回 logger 的入口。`app.ts` 用 `app.decorate("eventLog", createEventLogSink(logger))`
把它交给业务代码；`request.id` 作为**声明过的** `requestId` 字段显式带上，相关性
没有丢。

理由是可验证的：中性键（`traceContext`、`correlation`）上的 Secret 在键名上看不出
任何线索，键名黑名单对它**没有**覆盖。反例逐条实测——一个带 `traceContext` 的子
logger 自己打的行**确实**带着 opaque Secret（如实承认，那属于框架日志路径），而
业务事件行的键集恒为 `{errorCode, event, level, msg, requestId, statusCode, time}`。

**2. `allowedErrorTypes` 改为模块私有。**

上一版导出 `ReadonlySet<string>`——那只是类型上的只读，
`(x as Set<string>).add("EVIL")` 在运行期照样成功。现在对外只有一个**冻结的
canonical 数组**与一个 **predicate**。反例：篡改导出的快照之后
`isAllowedErrorType("EVIL_TYPE_SENTINEL")` 仍为 false；predicate 另外拒绝非字符串、
装箱字符串、以及 `constructor`/`toString`/`hasOwnProperty` 这类原型链上的名字。

**3. `statusCode` 由 `errorCode` 派生。**

字段里根本没有它，`apiErrorStatus[errorCode]` 是唯一来源。反例：硬塞
`SESSION_EXPIRED + 599`，输出仍是 401；另有十个错误码逐条比对 contracts 的映射表。

**4. capability gate 按声明身份重做。**

第十一轮的判据是**类型名字符串**，两头都错。这一轮从 program 里找出 pino 与
fastify 自己的 `.d.ts` 声明节点，之后比对节点身份；结构类型（`Pick<Logger, …>`）
再按成员看一眼。

| 形状 | 第十一轮（按名字） | 第十二轮（按声明身份） |
| --- | --- | --- |
| 泛型参数 `<T extends Logger>` | 名字是 `T` | `[Logger] T` / `[Logger] l` |
| `Pick<Logger, "warn">` | 符号名不叫 Logger，**漏报** | `[LogFn] picked.warn` |
| computed access `logger[key]` | 视表达式而定 | `[LogFn] logger[key]` |
| 本地同名工厂 `createEventLogSink` | 名字相同就放行 | `[Logger] root`，不放行 |
| **无关的同名 `LogFn`** | **误报** | 不报 |

app.ts 改成**精确上下文白名单**（`const logger = …` / `loggerInstance:` /
解析到 `log-events.ts` 真实导出的 `createEventLogSink` 调用），不再整文件放行。
实测：往 app.ts 注入 `const sidecar = logger`，门禁立刻变红。

门禁的定位写进了文件头：**它是工程护栏，不是形式化安全证明**——类型系统看不见的
东西（`any`、跨越 `JSON.parse` 的运行期值、动态 `import()` 之后的反射、用
`declare` 伪造的声明）都不在它的射程里。

**5. 敏感键名单的口径写实。**

它只对**已登记的键族**提供纵深防御，不声称对任意第三方键或中性键有兜底。业务日志
的安全性不依赖它。

**Secret 信号状态机与矩阵保持冻结**，本轮 diff 为 0 行。

**M3A 仍为整改中，未标记 Accepted。**

#### M3A Round 13 最终架构收口

**一、EventLogSink 的可信边界。**

Round 12 的 sink 建在组装根手里的那个 logger 上，而那个 logger 可以由调用方
（`options.logger`）注入——于是一个**预绑定过 binding 的 child** 就能污染每一条
业务事件。Round 13 引入 `LoggingContext`：`framework` 与 `events` 是**两个独立的
pino 根**，只是写向同一个目的地；`options.logger` 只能注入 framework 那一侧，
业务事件底座由 `createLoggingContext()` 新建，调用方没有入口碰它。sink 本身
`Object.freeze`，`emit` 既不可写也不可重定义。

修复前对照（复刻 Round 12 接线实测）：

| 反例 | Round 12 接线 | Round 13 |
| --- | --- | --- |
| 预绑定 child | `{…,"traceContext":"OPAQUE-…","errorCode":"FORBIDDEN","event":"request.rejected"}` | 业务事件键集恒为 `{errorCode,event,level,msg,requestId,statusCode,time}` |
| sink 建好后 `setBindings` | 同上，binding 照样跟进业务事件 | 不受影响（两棵树） |
| `sink.emit = …` | `REPLACED-EMIT-RAN` | 冻结 + 不可重定义，替换失败 |

同一条用例里正向断言框架请求日志仍然正常：method / path / requestId / statusCode
一个不少。

**二、capability gate。**

1. mutation API 改按 **pino 成员声明身份**识别。按名字匹配抓不到
   `Pick<Logger, "setBindings">`（接收者类型已经不是 Logger），也抓不到
   `logger["setBindings"]`（`node.name` 根本不存在）。现在先算出被访问的成员名，
   再从**接收者的类型**上取那个属性的符号，比对它的声明节点——映射类型产生的属性
   符号仍然指向原始的 `PropertySignature`。三种形状修复前全部漏网，修复后
   `[mutation] picked.setBindings` / `[mutation] logger["setBindings"]` /
   `[mutation] logger.setBindings` 逐条命中。
2. app.ts 白名单从**祖先子树**改成**精确节点 + 精确参数位置**。祖先放行等于放行
   整棵子树：`loggerInstance: externalRelay(logger)` 与
   `createEventLogSink(externalRelay(logger))` 修复前**双双假绿**（门禁只报出中继
   函数自己的参数）；修复后立刻报出
   `src/app.ts:182 -> [Logger] externalRelay(logging.framework)`。
   现在只认三个位置，且节点形状也钉死：`createLoggingContext(level, options.logger)`
   的第 1 个实参、`loggerInstance: <ctx>.framework`、
   `createEventLogSink(<ctx>.events)`。
3. 「**工程护栏，不是形式化安全证明**」这条诚实边界保留在文件头。

**三、证据与文档。**

- `statusCode` 的派生测试改成从 `Object.keys(apiErrorStatus)` **动态生成**，覆盖
  contracts 里全部 **18/18** 个错误码，不再手写十个样例——手写只能证明被写下的
  那几个。
- 清理 `logging.ts` 里已经失真的注释：`redact.paths` 的后备（早已整条不用）、
  子 logger censor 包装（第八轮起整条拒绝）、以及散落的 Proxy 说明（统一到文件头
  的一段口径）。
- 「业务代码拿不到 logger」这句**过强**的说法已改写为：Fastify 仍暴露
  `app.log` / `request.log`；仓库业务调用点由 capability gate 约束，业务事件通过
  独立 `EventLogSink`。

Round 12 已完成的 statusCode 派生、私有 error allowlist、声明身份判定全部保留。
**Secret 信号状态机与矩阵保持冻结**，本轮 diff 为 0 行。

**M3A 仍为整改中，未标记 Accepted。**

#### M3A Round 14 运行时能力边界最终收口

本轮**不动** Secret signal、数据库、Compose，也不再扩充 logger 脱敏规则。

**一、关闭 event logger 的公开能力。**

Round 13 的 `LoggingContext` 仍然把 event 那棵树的 **raw `Logger`** 摆在返回值上
（`context.events`），拿到 context 的人可以直接 `setBindings` 绕过 sink；
`createEventLogSink` 也还是一个**接受任意 `Logger`** 的公开工厂。现在 event root
建出来**立刻**包成 `EventLogSink`，raw logger 只留在模块词法作用域里；
`LoggingContext` 上只有 `framework`、`eventLog`、`close`；`createEventLogSink`
不再导出。`BuildAppOptions.eventSink` 删除，测试注入口改成
`eventLogDestination?: Writable`——只能换目的地，换不掉 sink，因此预绑定 framework
的集成用例走的是 **buildApp 的默认生产接线**。

**二、关闭 `app.eventLog` 的替换入口。**

`decorate` 只是普通赋值，属性可写可配置。现在用 `Object.defineProperty` 钉成
`writable: false, configurable: false`，错误处理器改从**词法闭包**取 sink，不读那个
属性。反例实测：赋值与 `defineProperty` 均失败，业务事件仍走原 sink。

**三、日志生命周期。**

framework root 与 event root 都归 `LoggingContext` 所有；`app.close` 经 `onClose`
等待自有 event logger flush，**调用方注入的 `Writable` / `Logger` 一律不 end**。
pino 的 `flush(cb)` 对普通 `Writable` 目的地是立即回调的，因此 close 之后再做一次
有界的 `writableLength` 排空等待。回归覆盖 delayed-write 与「flush 恰好一次」。

**四、capability gate。**

优先**减少 raw `Logger` 的暴露面**，而不是继续扩充 mutation 名单。判据补齐「能力
被装进别的壳子里带出去」：容器（`readonly Logger[]`）、mapped type、indexed
access、接口重声明（`readonly mutate: Logger["setBindings"]`）、解构。mutation
声明只从真实的 `Logger` / `BaseLogger` / `LoggerExtras` / `FastifyBaseLogger`
收集；`Logger["setBindings"]` 这种 indexed access 的落点是**成员声明身份**——字段
名已经不叫 `setBindings`，但它的类型符号仍然指回 pino 里那条声明。第三方框架类型
不往成员里走（`FastifyRequest` 的第七个类型参数正好就是 `Logger`，走进去会把每一个
request 形参都报成泄漏），类型实参只在数组/元组这类**真正的容器**上走。

组装根白名单绑的是**真实变量符号 + 声明来源 + factory initializer**，不是名字或
类型文本。Round 13 的 app.ts 假绿是**手工改文件**验证的，跑完就没了；本轮把七种
违规接线固定进 `tests/fixtures/app-wiring-variants.ts`，测试把 fixture **当作
组装根**喂给收集器：

| 变体 | 期望 |
| --- | --- |
| `allowedWiring` | 不报 |
| `violatingRelayedFramework`（`loggerInstance: externalRelay(logging.framework)`） | 报 |
| `violatingRelayedContext`（`externalRelay(createLoggingContext(…))`） | 报 |
| `violatingAliasedFramework`（`{ alias: logging.framework }`） | 报 |
| `violatingDestructuredFramework`（`const { framework } = …`） | 报 |
| `violatingContainer`（`readonly Logger[]`） | 报 |
| `violatingIndexedAccess`（`LoggingContext["framework"]`） | 报 |
| `violatingRawRoot`（`createLogger(level)`） | 报 |

修复前对照（把判据退回 Round 13：只做直接类型解析、mutation 成员不进直接集合）：
`12 generic parameter: expected \`[Logger] l\` among …` 与
`violatingRelayedContext: expected the capability gate to report it, got nothing`
两条断言双双失败；shape 20/21 也整体漏网。修复后 4/4 全绿。

**五、机械文档。**

删除 `logging.ts` 里失真的 `redact.paths` 后备与子 logger censor 包装注释（根
logger 第七轮起不配置 `redact`，子 logger 第八轮起整条拒绝，因此进程里不存在任何
一条经过 `@pinojs/redact` 的输出路径）。

**M3A 仍为整改中，未标记 Accepted。**

#### M3A Round 14 收尾修订

**一、日志关机统一成有界、fail closed。**

Round 14 的 `close()` 只写了 `flush(() => resolve())`。pino 把回调**直接交给目的地
的 `flush`**（`lib/proto.js:253`：`typeof stream.flush === 'function'` 时
`stream.flush(cb || noop)`，否则 `cb && cb()`），因此有三种收场，而那一版只管了
第一种：

| 收场 | 修复前实测 | 修复后 |
| --- | --- | --- |
| flush 带 error 回调 | close 静默 resolve | reject `log flush failed (event)` |
| flush 回调根本不来 | 用例**永不返回**（仓库的 `test:unit` 没有超时；加 `--test-timeout=8000` 才会在 8 秒后判超时） | 2 秒上界后 reject `log flush timed out` |
| 目的地排空超时 | 循环到点后**静默**往下走 | reject `log destination did not drain` |
| 自建的 framework root | 根本不在 flush 名单里 | 进名单，flush 失败同样 reject |
| 重复调用 | ——（成功路径已幂等） | 同一个 promise，成功失败都一样 |

所有权口径写进类型注释：**自建的才 flush**（event root，以及没被注入时我们自己建的
framework root）；调用方注入的 `Logger` 我们不碰，任何 `Writable` 都**绝不 `end`**。
有一处必须写实：flush 自有 root 时 pino 会把回调转交给**目的地自己的** `flush`，
所以调用方给的目的地会因此被调用一次 `flush`，它报错同样会让 `close()` 失败——
「不碰调用方的东西」只对调用方的 **logger** 成立。为了让「自建的 framework root 确实被 flush 了」成为可断言的事实，
`createLoggingContext` 增加第 4 个参数 `frameworkDestination`——它是**目的地**不是
能力（给的是「往哪写」不是「用谁写」），并且与注入 framework logger **互斥**，两个
一起给直接抛错。错误消息只保留**归一化的错误类型名**：目的地的 error message 是
不可信文本。

**二、capability gate 的 root-held 判据收窄到两个真实工厂。**

上一版是 `ts.isCallExpression(node.initializer)`——组装根里**任何**调用的返回值都
被当成「组装根持有的容器」。于是：

| 反例 | 收尾修订前 | 修订后 |
| --- | --- | --- |
| `violatingForeignFactoryHolder`（`const held = externalRelay(logging); return held;`） | 一条都不报（假绿） | 报出 |
| `violatingForeignFrameworkHolder`（自造工厂返回带 `log` 的容器） | 一条都不报（假绿） | 报出 |

现在只认两个**声明身份**：`log-events.ts` 真实导出的 `createLoggingContext`，以及
**fastify 包自己** `fastify.d.ts` 里那个 `fastify` 工厂（穿过 import alias 后按
符号名 + 声明文件比对）。认不出 fastify 的声明文件时门禁直接抛错，而不是退化成
「什么调用都放行」。fixture 的 `allowedWiring` 因此改成调用**真实的** `Fastify`，
自造工厂降级为违规变体，违规接线从七种增加到九种（收尾复评后十三种，收尾追加后
十六种，收尾复评二后二十一种，定点追加后为**二十二种**）。

#### M3A Round 14 收尾复评整改

收尾修订自己又跑了一轮四视角对抗评审（close 生命周期 / gate 判据 / 文档一致性 /
纪律与冻结面），12 条报告经独立反驳后确认 9 条。下面三类是实质缺陷：

**一、`timer.unref()` 让 flush 超时在真实关机时根本不生效（blocking）。**

unref 过的定时器不 ref 事件循环，而关机正是「循环里已经没有别的 handle」的那一刻：
avvio 的 onClose 是 LIFO，监听 socket 已关、连接池已 end、
`process.once("SIGTERM", …)` 的监听器本身也不 ref 循环，`index.ts` 自己那个 10 秒
`forceClose` 也是 unref 的。于是进程直接退出，`close()` 永不 settle，**退出码还是
0**——比静默 resolve 更糟。

这条**在 `node --test` 里测不出来**：runner 自己吊着事件循环，用例照样通过。所以
回归改成**另起一个进程**跑 `tests/fixtures/stalled-flush-shutdown.ts`：

| | 修复前 | 修复后 |
| --- | --- | --- |
| runner 内用例 `close rejects when the flush callback never fires` | ✔ 通过（假绿） | ✔ 通过 |
| 独立进程 | `OUTCOME=NEVER-SETTLED`，退出码 0 | `OUTCOME=REJECTED` |

同时给 `src/index.ts` 的 `shutdown()` 补上 `catch`：`void shutdown(…)` 会把这个
rejection 丢掉，最终只剩 Node 对未处理拒绝的默认行为。现在落成 stderr 上一行
**完全固定的中性文本** `shutdown: close failed`（不带阶段、不带类型名、不带任何
来自错误对象的东西），以及确定的非零退出码。

**二、gate 里三条「按形状放行」的规则叠加成一条完整的能力出口（blocking / major）。**

| 反例 | 收尾复评前 | 复评后 |
| --- | --- | --- |
| `frameworkFactory({ loggerInstance: logging.framework });`（结果被丢弃的裸语句） | 一条都不报 | 报出 |
| `app.register(auditPlugin, { loggerInstance: logging.framework })` | 一条都不报 | 报出 |
| `(o) => createLoggingContext(o.level, o.injected)`（直接 return 工厂结果） | 不报 | 报出 |
| `const logging = createLoggingContext(…); return logging;` | 不报 | 报出 |

根因是三条规则各自只看「形状」：丢弃的调用放行**任何** callee（可是能力顺着**实参**
出去，不是返回值）；选项对象字面量放行**任何**调用的实参；`loggerInstance:` 从不
检查外层调用是不是框架工厂。现在丢弃规则只认「callee 是**框架容器**上的成员访问」
或 `Object.defineProperty(<框架容器>, …)`（后者按 TypeScript lib 里那条声明的身份
认），选项字面量与 `loggerInstance:` 都必须落在**框架工厂自己**那次调用上。

同时把 `rootHeldSymbols` 拆成两类：`frameworkHeldSymbols` 可以被 return（那就是
`buildApp` 的契约），`contextSymbols` 只允许作为**成员访问的基**出现。违规变体从
九种增加到**十三种**。

**三、失真文档。**

`app.ts` 里还剩一条指向已删除的 `logging.events` 的注释；gate 注释里那「三个确切
位置」的第 3 条（`createEventLogSink(<ctx>.events)`）在代码里根本不存在；
「调用方注入的……**所有** `Writable` 既不 flush 也不 end」是失真的（flush 自有 root
会把回调转交给目的地自己的 `flush`）；被当作 pino 源码逐字引用的
`'flush' in stream` 在锁定的 pino 10.3.1 里其实是
`typeof stream.flush === 'function'`（差别可观测：目的地上挂一个**非函数**的 flush
属性时，两种判据的结果不一样）；「修复前实测 8 秒超时」不可复现（仓库的 `test:unit`
没有超时，挂住就是无限挂住，那个 8 秒来自 `--test-timeout=8000` 的临时探针）。以上
逐条订正。

**未采纳（写明理由）**：评审还指出 `let app; app = Fastify(…)`、三元 initializer、
`const f = Fastify; f(…)` 这些**语义等价**的接线会被门禁报红。那是**故意**的：
判据是「声明身份 + 精确 AST 位置」，放宽任何一条都会把上面刚堵住的口子重新打开。
组装根是一个文件、十来行接线，保持 canonical 写法的代价远小于放宽判据。

**四、文档与日期。**

`app.ts` 里指向已删除的 `eventSink` 的注释、gate 的 root-held 注释、ADR-0005 的
实施注记、project-status、本计划与 API README 一并同步，日期统一 **2026-07-31**。
API unit 163 → **181**。

**Secret 信号状态机、数据库、Compose、contracts、客户端与 generated 文件保持冻结**，
本轮 diff 为 0 行。

**M3A 仍为整改中，未标记 Accepted。**

#### M3A Round 14 收尾追加

**一、close 改成 failure-safe 的阶段收集器。**

上一版是一串 `await`：第一处失败就把后面的阶段全跳过。关机路径上这恰好是最坏的
顺序——「event flush 报错，于是 framework 那棵**根本没 flush**」，一个坏掉的目的地
连累另一个好的目的地一起丢日志。

现在四个适用阶段各自跑到，失败最后一次性聚合成 `AggregateError`：

| 反例 | 修复前 | 修复后 |
| --- | --- | --- |
| event flush 失败后 framework flush 仍执行 | `framework.flushes() === 0` | `=== 1`，聚合消息同时含两条 `log flush failed` |
| framework flush 失败后 event drain 仍执行 | 聚合消息里没有 `did not drain (event)` | 两条都在 |
| 一个 drain 失败不阻断另一个 drain | 只有 framework 那条 | 两条 `did not drain` 同时出现 |

阶段函数**不抛**，只返回本模块自己写的安全原因字符串（`flushOwned` /
`awaitDrained` 的签名改成 `Promise<string | undefined>`），因此聚合消息里在结构上
就不可能出现调用方或目的地的文本。`writableLength` 是访问器、调用方可以让它抛，
所以排空整段也包了起来，只按归一化类型名记一笔。同一个 promise、不 `end` 调用方
`Writable` 这两条不变，并补了一条「每个调用方拿到同一个聚合失败、第二次不重跑
flush」的回归。

**二、gate：形参不是通行证，工厂符号本身也是能力。**

| 反例 | 修复前 | 修复后 |
| --- | --- | --- |
| `passthrough(logger: Logger): Logger => logger` | 一条都不报 | 报出 |
| `externalRelay(createLoggingContext)` | 不报 | 报出 |
| `const build = createLoggingContext; return typeof build === "function";` | 不报 | 报出 |

上一版的 `isCompositionInput` 无条件放行**任何**解析到形参的标识符——那不是位置
判据，是一张通行证。现在形参只能作为**成员访问的基**出现（`options.logger` 可以，
把 `options` 或一个 `Logger` 形参整个递出去不行）。工厂符号 `createLoggingContext`
本身也计入能力：拿到它就能凭空造一个 `LoggingContext`，`.framework` 跟着到手；
它只允许出现在组装根**那一次**合法工厂调用的 callee 位置。

**三、`shutdown` 文案中性化与所有权口径。**

`index.ts` 的 stderr 文案改成**完全固定**的 `shutdown: close failed`——不带阶段、
不带类型名、不带任何来自错误对象的东西。`Writable` 的所有权口径补齐为：绝不
`end`、绝不 `destroy`、也绝不往里写关机标记，只读 `writableLength` 等它排空。

**Secret 信号状态机、数据库、Compose、contracts、客户端与 generated 文件保持冻结**，
本轮 diff 为 0 行。

**M3A 仍为整改中，未标记 Accepted。**

#### M3A Round 14 收尾复评二

阶段收集器与 gate 收紧之后又跑了一轮四视角对抗评审，确认 6 条。

**一、`errorTypeOf` 自己会抛，关机路径必须兜住（major）。**

`errorTypeOf` 要读输入的原型与属性描述符，因此一个**自指** Proxy
（`getPrototypeOf` / `getOwnPropertyDescriptor` 都抛自己）能让它再抛一次。三个调用点
（`flushOwned` 的 `done`、`awaitDrained` 的 catch、收集器的兜底 catch）都没兜。后果不是
少一句诊断，而是**抛出来的就是调用方的原始对象**：它穿过收集器，close() 用调用方的值
拒绝、剩下的阶段全被跳过——本轮两条保证一起没了。实测：目的地的 `writableLength`
访问器抛一个自指 Proxy，close 在 **2ms** 内以调用方对象拒绝（正常应 ≥2000ms，因为
event drain 还要跑）。修复后统一走 `safeErrorType()`，兜底 `"UnreadableError"`；
同一条用例修复后耗时 2003ms、以 `AggregateError` 拒绝、消息不含 sentinel。

**二、白名单第 6 条还是纯形状（major）。**

它只判「第 1 个实参是不是成员访问」，从不看**基**是什么。于是任何来源的
`X.logger` 都能无声进入 `LoggingContext.framework`：

| 反例 | 修复前 | 修复后 |
| --- | --- | --- |
| `createLoggingContext(level, app.log)`（框架容器自己的 logger 喂回工厂） | 不报 | 报出 |
| `createLoggingContext(level, foreign.logger)`（第三方对象的字段） | 不报 | 报出 |

「基是某个形参」也不够——多加一个形参就绕过去了。注入槽只有一个来源：组装根收到
的那个 options 对象，也就是它的**第一个**形参。

**三、第二个 root 工厂没被当成能力（major）。**

「工厂符号本身即能力」只实现了 `createLoggingContext`。`logging.ts` 的
`createLogger` 直接返回 **raw `Logger`**，能力严格更强，却可以随便取别名、交接。
现在它在两个边界文件之外**一处都不许出现**——连做 callee 都不行。

**四、`typeof X` 被算成运行期取用（minor）。**

`isTypePosition` 漏了 `TypeQueryNode`，于是 `(): typeof createLoggingContext => …`
的返回类型标注被记成一次能力取用。已补上。

**五、两条反例没有回归力（minor），一条表格失真（major）。**

`violatingFactoryAlias` 与第一版的 `violatingRootFactoryAlias` 在收紧**之前**就已经
是红的（报的是 `build(…)` 的返回值），对新规则没有回归力；上面那张表也据此写错了
「修复前不报」。已改成收紧前实测为 **0 报告**的写法（`typeof build === "function"`，
连调用都没有），表格同步订正。同理，`violatingForeignLoggerIntoFactory` 改成「先命名
再取 `eventLog`」，否则它会因为别的判据先红，测不到第 6 条。

**六、启动失败分支的 `app.close()` 没有 catch。**

close 现在会 reject，那条路径上 rejection 会从 top-level await 逃出去，
`process.exitCode = 1` 根本轮不到执行，整个错误对象还会被打到 stderr。已补 catch，
文案同样是固定的 `shutdown: close failed`。

**Secret 信号状态机、数据库、Compose、contracts、客户端与 generated 文件保持冻结**，
本轮 diff 为 0 行。

**M3A 仍为整改中，未标记 Accepted。**

#### M3A Round 14 定点追加

**一、回调不能盖住 `flush()` 的同步 throw。**

`root.flush()` 先把回调调成功、然后自己同步抛：上一版在回调里就把结果定死了，那个
throw 被完全吃掉——一次失败的 flush 报告成功。现在回调在 `root.flush()` 返回**之前
只暂存**结果，最终定案要等它返回，**同步 throw 优先**。

| 反例 | 修复前 | 修复后 |
| --- | --- | --- |
| 回调报成功 → `flush()` 同步 throw | 该阶段报告**成功** | `log flush failed (event): Error` |
| 同一条：后续 framework flush | —— | `framework.flushes() === 1` |
| 同一条：后续 framework drain | —— | 聚合消息含 `did not drain (framework)` |
| 同一条：聚合消息含 sentinel | —— | 不含 |

**二、超时架构的边界写实。**

计时全部改用 `performance.now()`（`Date.now()` 会跟着系统时间跳，不能量时限）。
`root.flush()` 与 `writableLength` getter **返回之后重新量一次**已用时间——同步阻塞
期间定时器根本没机会跑：

| 反例 | 修复前 | 修复后 |
| --- | --- | --- |
| `flush()` 同步阻塞 2300ms 后**成功**返回 | 报告成功 | `log flush timed out after 2000ms (event)` |
| `writableLength` getter 同步阻塞 2300ms 后返回 0 | 算「排空了」 | `did not drain within 2000ms (event)` |

同时把口径写实：**同一个 JS 线程里无法抢占一个不返回的同步调用**。调用方给的
`Writable` 与它的 `flush` 是**受信的、合作式的**接口，死循环的 `flush` 这一层挡不住；
「可对任意同步阻塞提供硬上界」的说法已从代码注释与文档里删掉。**不**为此引入
worker/子进程改造。

**三、options 注入槽按声明身份登记。**

上一版判的是「任何 FunctionLike 的第一个形参」——那还是形状。随手写一个 helper，
它自己的首参就成了合法注入源：

| 反例 | 修复前 | 修复后 |
| --- | --- | --- |
| `violatingNestedHelperInput`（helper 首参含 logger，传进 `createLoggingContext`） | **0 report** | 报出 |

现在按**声明身份**登记：生产里是 `buildApp` 的第一个 parameter 声明；fixture 扮演
组装根时**明确指定**入口为 `allowedWiring`，只有它的首参算注入源。

**四、机械收口。**

关机契约从 `index.ts` 抽进 [`src/shutdown.ts`](../../services/api/src/shutdown.ts)
（窄接口 `{ eventLog, close }`，不依赖整个 Fastify 实例），这样两条失败路径的
**subprocess 回归**跑的是**生产函数本身**而不是抄件：

| 回归 | 去掉 `catch` 后 | 现在 |
| --- | --- | --- |
| SIGTERM 关机失败 | stderr 不是那一行固定文本 | `shutdown: close failed\n`、exit 1、无 sentinel |
| listen 失败后再关又失败 | 同上 | 同上 |

`app.ts` 的注释补齐所有权：**不 `end` / 不 `destroy` / 不写入**调用方的 `Writable`，
但 flush 自有 root 时 pino 会调用**目的地自己的** `flush`。`index.ts`/`shutdown.ts`
的文案改成「**应用**关闭失败」——`app.close()` 会跑完所有 onClose hook，日志 flush
只是其中一个。M3A 的状态口径在 `docs/README.md`、project-status、本计划、ADR-0005
与 API README 里统一。（**当时**是「Round 14 整改中，未 Accepted」；总控随后
Accepted，验收落点 `a839df1`。）

**Secret 信号状态机、数据库、Compose、contracts、客户端与 generated 文件保持冻结**，
本轮 diff 为 0 行。

**M3A 状态：已由项目总控 Accepted，验收落点 `a839df1`。** 它只覆盖**代码侧**消费
能力；完整 bootstrap 链与全栈启动仍未通过，**不得记为 Pass**。上面各轮小节里的
「仍为整改中」是**当时**的状态记录，保留不改。

**下一项是 M3B**：环境模板、八份 Secret 的生成与交叉一致性、完整 Compose bootstrap
链、`/readyz=200` 与网络隔离实证。M4、M5 未开始。ADR-0005 保持 `Proposed`，
PR #1 保持 Draft。

M3A **不覆盖**，属于 **M3B**：`infra/environments/` 的完整 local-test 模板
（第 1 条）、八份 Secret 的生成/派生/交叉一致性预检、database name 与三个
URL/pgpass 的部署级一致性、完整 Compose bootstrap 链
（`0000 → handoff → acl → migrate → grants`）与 `/readyz=200` 实证、
`config`/`inspect`/`history`/`logs` 的容器级 sentinel 扫描，以及宿主全部非
loopback 地址的动态隔离证明（第 5 条）。**M4、M5 未开始。**

### M3B 实施记录（已取得完整 bootstrap/full-stack 本地证据，但尚未 Accepted；未完成的是 M4/M5 与 09A 总验收）

**状态：M3B 已取得完整 bootstrap/full-stack 本地证据，但尚未 Accepted；未完成的是 M4/M5 与 09A 总验收。**未自行标记
Accepted。落点：[`infra/docker/local-test-secrets-contract.mjs`](../../infra/docker/local-test-secrets-contract.mjs)、
[`generate-local-test-secrets.mjs`](../../infra/docker/generate-local-test-secrets.mjs)、
[`preflight-local-test-secrets.mjs`](../../infra/docker/preflight-local-test-secrets.mjs)、
[`probe-compose-secret-identity.mjs`](../../infra/docker/probe-compose-secret-identity.mjs)、
[`run-local-test-smoke.mjs`](../../infra/docker/run-local-test-smoke.mjs)、
[`local-test-containment.mjs`](../../infra/docker/local-test-containment.mjs)、
[`check-local-test-negatives.mjs`](../../infra/docker/check-local-test-negatives.mjs)、
[`infra/environments/local-test/`](../../infra/environments/local-test/README.md)。

1. **第一步先固化了 Compose Secret 的容器内 UID/mode 证据**（宿主 stat 不作数）。
   `probe-compose-secret-identity.mjs` 用真实 generator 的临时合成 bundle 与唯一
   project name，把八份 secret 逐一挂进它们真实的消费服务：UID 999 侧
   （`postgres` 的 superuser 口令；`bootstrap-logins` 的 pgpass 与三个登录口令）
   与 UID 10001 侧（`bootstrap-schema`/`migrate`/`api` 的三条 URL）在容器内实测
   全部为 owner==消费进程 EUID、mode 0600、普通文件、nlink=1、非 symlink、可读。
   Docker Desktop 把 bind 进容器的 secret 呈现为消费 UID 所有，因此 M3A 的
   fail-closed 文件判据在真实 Compose Secret 上成立，无架构阻断。
2. **八份 Secret 只有一个来源**：generator 只生成四个原始 CSPRNG 口令
   （`crypto.randomInt`，48 字符 `[A-Za-z0-9]`——URL userinfo 与 pgpass 双安全，
   无需任何转义），八个固定文件全部由
   `local-test-secrets-contract.mjs` 的同一份常量（文件清单、角色、
   host=postgres、port=5432、database=meal_agent、migration/runtime 用户名带
   `_login`）派生；generator 与 preflight 共用该事实源，不存在两套手写事实表。
   pgpass 只覆盖 maintenance 库与目标库**两个精确 endpoint**，无 `*` 通配。
   目录 0700、文件 0600、默认拒绝覆盖、failure-safe（暂存后统一 rename，失败
   清光；SIGKILL 窗口的残留会被预检当作未知条目拒绝）；口令不进入
   stdout/stderr/argv/环境变量/Git。
3. **部署前交叉一致性预检**在任何数据库容器启动或 mutation 之前 fail closed：
   缺失/未知条目/symlink/hardlink/非普通文件/弱权限/错属主/空值/超限/多行/CR/
   NUL/BOM/非法 UTF-8；URL 的 user/host/port/database 精确匹配且口令与对应口令
   文件逐字节一致（另有 canonical 全等兜底 userinfo 绕过与编码变体，拒绝
   query/fragment/unix socket）；pgpass 恰好两条 endpoint 且口令与 superuser
   一致；四个原始口令互不相同；Secret 被 Git 跟踪、tracked 模板出现非空
   password/token/AppID/AppSecret/DSN 或完整连接串一律拒绝。
4. **完整 fresh Compose 链已实证**。`run-local-test-smoke.mjs` 只用 Node 内置
   模块与 Docker CLI：唯一 project name、全新 named volume、临时合成 Secret、
   127.0.0.1/::1 双侧确认空闲的随机 host port；严格顺序
   `postgres → bootstrap-cluster → bootstrap-logins → bootstrap-createdb →
   bootstrap-schema(0000) → bootstrap-handoff → bootstrap-acl →
   migrate(0001—0004) → bootstrap-grants → api`，每个一次性容器的真实退出码由
   `docker inspect` 独立读取（全部 0），`migrate` 与 `bootstrap-grants` 重跑
   第二次仍 exit=0 且容器确实重启（幂等）；`/healthz=200`、`/readyz=200`。
5. **数据库与 API 运行证据**：ledger 精确 `0000—0004`（名称、sha256、
   `COLLATE "C"` 顺序与磁盘一致）；M2A 的 containment（`acl`）与 final
   （`grants`）verify 入口以 exit=0 通过（重跑 grants 再次通过）；database/
   3 schema/12 relation/16 routine 的 owner 全部为 `meal_agent_migrator`；RLS
   enable/force 与冻结迁移逐表一致（0000 六张 + invites + link_requests 为
   true:true，其余 false:false）；角色属性矩阵与身份模型一致；runtime login
   真实连接下不能 `CREATE TABLE`、不能 `SET ROLE meal_agent_migrator`、
   `SET ROLE meal_agent_app` 可读 ledger；readiness 触发后目标库上只有
   runtime login（与观察用 admin 连接）；16 个容器逐一只挂载所属服务声明的
   secret（api 只有 runtime URL；migrate 只有 migration URL；bootstrap 各取
   所需）。
6. **Secret containment 扫描**：18 条 needle（四口令与 16 字符前缀、三条完整
   URL、两条 pgpass 记录）加本轮随机 scanner sentinel，先在合成产物上自检逐条
   可命中，再扫 `docker compose config`、全部容器 inspect（单列 Config.Env、
   Config.Cmd/Args、Mounts）、image inspect、`image history --no-trunc`、全部
   容器 logs、全仓库 tracked files 与 smoke 自身 transcript——零命中；命中报告
   只含类别与位置。
7. **动态网络隔离**：`127.0.0.1` 的 /healthz 与 /readyz 200；`::1` 拒绝；宿主
   全部非 loopback 地址逐一连接失败（本机 19 个地址：LAN IPv4/IPv6 与
   link-local 全部 refused/unreachable；Docker Desktop 自有的两个 accept-all
   utun 地址由无监听对照端口证明其 TCP accept 与本发布无关，HTTP 层探测按要求
   失败）；postgres 无 PublishedPort/PortBinding；api 恰好一个
   `127.0.0.1:<port>→3000/tcp` binding。失败也执行按 project label 限定的
   scoped cleanup，实测零残留；`--keep-failure` 才保留现场。
8. **反向测试 47 项全部以指定理由捕获、0 漏网**（`check-local-test-negatives.mjs`；
   47 是**当时**的计数，后续几轮整改把它扩到了 75 cases = 1 正向 baseline + 74
   反例/边界检查）：
   错 user（含 `meal_agent_migration` 漏 `_login`）、错 host/port/database、
   query 走私、URL 与口令不一致、pgpass 不一致/第三 endpoint/通配、缺文件、
   多文件、弱权限 0644、错属主（经 expectedOwnerUid 注入 seam——非 root 进程
   无法真的制造错误属主文件，正向的容器内属主证据由第 1 条探针提供）、
   symlink、hardlink、tracked Secret（临时 git 仓库）、模板非空 AppSecret 与
   完整 DSN（改写-还原真实 tracked 模板）、生成器拒绝覆盖/未知条目、postgres
   发布端口、api 挂载 admin/migration Secret、api `0.0.0.0` 发布、DSN 进
   migrate argv（改写-还原 + 拓扑门禁指定理由）、sentinel 进
   environment/argv 必须被同一台扫描器命中且报告不含取值、cleanup 拒绝范围外
   project 名与范围外目录、decoy 容器存活。全部失败消息不含任何 Secret 取值。

#### M3B 首轮自查（两路只读对抗审计）与定点修复

交付后先做了两路只读对抗审计（Secret/泄漏面；Compose/网络/cleanup），确认级
发现全部在同一轮修复（`fix(stage09a): close the M3B adversarial audit findings`），
其中最重要的几条与修复前后的对照：

1. **失败路径的输出泄漏面**：一次性容器非零退出时，smoke 会把容器日志摘录
   原样打到 stdout，而该分支恰好跳过 containment 扫描。现在 bundle 生成后把
   全部敏感值（与扫描器同一个 buildNeedles）注册进输出 scrub，smoke 的**每一
   条**输出（含失败路径日志摘录与子进程 stderr）都过它。
2. **生成器的 failure-safe 缺口**：`generateAndPreflight` 只在预检返回
   problems 时清理，预检**抛出**（如 realpath 异常）会留下整套真凭据；生成器
   对 symlink 目标目录会跟随写入、对将被拒绝的目录先 chmod 再校验。三条都已
   修复（lstat 拒绝 symlink、校验先于 chmod、抛出路径同样清理）。
3. **两处 fail-open 判定**：`docker inspect` 失败被 `Number(null)===0` 读成
   「退出码 0」、被 `stdout || '{}'` 读成「postgres 没有发布端口」。全部改为
   显式失败，不允许用默认值替代读不到的证据。
4. **网络隔离证据的空转**：link-local IPv6 不带 zone id 时连接是未路由的
   EHOSTUNREACH 空转（本机 18 个非 loopback 地址里 9 个），却每次贡献
   「as required」。现在拼 `%<interface>` 后是真实路由尝试；HTTP 探针增加
   「先在 127.0.0.1 认出自家 API」的正向自检；accept-all 对照端口先验证本机
   确实无监听。
5. **匿名卷泄漏**：postgres 镜像自带 `VOLUME`，`compose run` 的一次性容器删除
   时不带 `-v` 会持续泄漏匿名卷（实测已泄漏 6 个，已按 ID 清除）。容器删除
   全部带 `-v`，并新增「悬挂匿名卷前后对照」断言（匿名卷不带 project label，
   按 label 的残留检查在原理上看不见它们）。
6. **cleanup 的异常与信号路径**：明文 Secret 目录改为**最先**删除；down 退出
   码不再静默；单类 sweep 失败不中断其余；smoke 与 probe 增加 SIGINT/SIGTERM
   清理（此前 Ctrl-C 会把容器、卷与明文 Secret 整套留下）；cleanup 范围收窄到
   `meal-agent-m3b-{smoke,neg}-*`（并发探针不可被摸到）；`--keep-failure` 只在
   链路已启动时保留现场并显式警告其中含真实合成凭据。
7. **反例套件的假绿与覆盖缺口**：decoy 反例此前只断言上界（空实现的 cleanup
   也能通过），现在同时断言下界（自己 project 的容器必须被删掉）；模板扫描补
   `KEY`/`PWD`/`PASS`/`CREDENTIAL` 后缀、注释行、无 userinfo 的 `password=`
   查询参数 DSN 与零覆盖抛错；默认目录强制 `.gitignore` 存在且八个文件名逐一
   过 `git check-ignore`；反例从 32 项扩到**当时的 47 项**（补内容卫生、口令字母表、
   fragment、tab 走私——canonical 全等的专属回归、unix socket host 等），并加
   当时的 47 项精确计数断言（该断言现为 75 cases）。

修复后全部门禁重跑：smoke PASS（18 needles、86 产物、315 tracked files 零命
中）、probe PASS、反例 47/47、拓扑门禁与 15 项变异全绿、悬挂匿名卷零新增。
（第二轮阻断整改后的最终数字见下面两节。）

#### M3B 总控阻断整改（第二轮）

总控复核点名七类阻断，全部已修，每条都有修复前实测：

1. **镜像隔离**。此前 smoke 与 probe 共用全局 tag `meal-agent-api:stage09a-local-test`，
   不同 worktree/project 会互相覆盖。现在每轮生成唯一 tag
   `meal-agent-api:m3b-<run id>`，经**临时 Compose override** 注入（M2B 已
   Accepted 的默认拓扑一字未改，override 用后即删并进 `.gitignore`）；build 之后
   读取 immutable image ID，并断言 `bootstrap-schema`/`migrate`/`api` 三个容器的
   `.Image` 逐一等于它；cleanup 只删本轮 tag 并复核已消失，拒绝任何非本轮形状的
   tag。新增交错反例实测：project A 的 tag `m3b-neg53cc2d → 7912ff5c` 在 project B
   build 之后**保持不变**，B 得到另一个 image ID；删 A 的 tag 之后 B 的仍在。
2. **子进程与信号**。`spawnSync` 全部换成异步 spawn（`detached` 自成进程组、有
   超时、超时按组 TERM→KILL 并以明确错误 reject），因此事件循环存活、信号可被
   真实处理。`installSignalHandlers` 的次序固定为「终止受控子树 → 调用方 scoped
   cleanup（residue 必被打印）→ 卸载 handler 并重投同名信号」。新增
   `check-m3b-signal-windows.mjs`，在三个真实窗口取证：

   | 窗口 | 信号 | 修复前 | 修复后 |
   | --- | --- | --- | --- |
   | smoke build（docker build 正在跑） | SIGINT | `code=1`（普通失败退出抢先，信号语义被吞） | SIGINT 语义，零残留 |
   | smoke chain（postgres healthy） | SIGTERM | —— | SIGTERM 语义，零残留 |
   | probe run（容器探测阶段） | SIGINT | `code=1` | SIGINT 语义，零残留 |

   每个窗口逐项断言：CLI 与引用该 project 的 docker 子进程全部消失、本轮
   container/network/volume 一个不剩、唯一 image tag 已删、临时 Secret 目录已删、
   临时 override 已删、tracked compose 文件在 git 里依然干净。修法是
   `terminationSignal()` 让 CLI 在信号在飞时**让位**，并把 `cleanupRun` 串行化，
   避免信号处置与主流程 finally 的两次 cleanup 并发看到彼此的中间态。
   generator 另外登记本轮已创建路径，rename 窗口被 SIGINT 打断时不留半套 bundle
   （有独立反例）。
3. **Docker 证据 fail closed**。down/list/inspect/remove/re-list/dangling 全部检查
   退出码；cleanup 改为分阶段收集器（Secret 目录 → down → 容器 → 网络 → 卷 →
   image tag → 匿名卷对照），一个阶段失败不阻断其余；cleanup 之后
   `verifyNoResidue` **独立复查**六类。反例用 PATH 影子 docker 让 `ps` /
   `volume ls` / `compose down` 分别非零退出，三条都必须进 residue；另有「注入
   compose-down 失败后容器 sweep 仍真实删掉 decoy 容器」的阶段独立性反例。
4. **Secret 可见面**。service label 与 Mounts 全部走严格 inspect（无 `null`/`[]`
   默认值）；service 必须是 `expectedSecretMounts` 的**自有键**，未知 service 立即
   失败；Mounts JSON 结构逐项验证；比较 exact source 文件名、容器内 target 与只读
   标志的**集合**，不再只筛 `/run/secrets/` 前缀。
5. **Git index 扫描**。tracked 模板扫描同时读工作树与 **git index blob**
   （`git show :path`），两者不同则各扫一遍，index 读不到即 fail closed。新增
   index-only 反例：Secret 已 `git add`、工作树随后恢复干净——只扫工作树的实现
   完全看不见它，现在以 `(git index)` 前缀的理由被抓住，且不回显取值。
6. **契约与输出边界**。bundle 目录权限精确 `(mode & 07777) === 0700`（0500/0600/
   1700 三个反例）；未知条目**只报类别与数量、不回显文件名**（generator 与
   preflight 同改，并有「Secret 被当作文件名」的回归）；口令精确 48 字符；
   negative 的 mutate 可返回 `additionalSensitiveValues`，泄漏检查覆盖变异前后
   取值；`generateAndPreflight` 增加 preflight 注入 seam 供「预检抛出时也清理」
   的回归使用。
7. **带 zone 的 IPv6 隔离证据**。探针改为**原始 socket + 手写 HTTP/1.1**——
   WHATWG URL 不接受 zone，用 `fetch` 会把「请求根本没构造出来」误判成
   `http-unreachable`。结局分为 `not-constructed` / `not-sent` / `tcp-refused` /
   `not-api` / `api-reachable`，只有后两者证明请求确实发出，才能进入隔离裁决；
   accept-all 例外要求**两个**独立的无监听对照端口都 accept；新增 link-local
   正向对照：在真实 `fe80::…%en10` 上起临时监听并用同一个探针打它，实测得到
   `HTTP/1.1 418`，证明 zoned 探针真的发包（修复前该地址只会给出未路由的空转
   结果，却被记成「as required」）。

反例套件同时改为**绝不变异真实 tracked 文件**：模板反例在临时 git 仓库的副本上
做，Compose 变异在临时副本上做（拓扑门禁新增受限的 `--compose-file <infra/docker
内路径>` seam，生产调用仍是零参数），并断言跑完后 tracked compose 文件在 git 里
依然干净。

#### M3B 阻断整改后的第二轮对抗审计与定点修复

阻断整改落地、窄反例全绿之后，按要求并行跑了两个只读审计（A：Secret/index/
输出与信号；B：runtime 证据、镜像、cleanup、网络）。确认级发现全部已修，其中
两条推翻了本轮刚写下的结论：

1. **隔离裁决被自己的分类绕过（B）**。`probeApiHttp` 把「TCP 连上但一个响应
   字节都没收到」（RST / 静默丢弃 / 超时）也判成 `not-api`，而 `not-api` 被
   `requestActuallySent()` 当作「请求确实发出并被应答」直接放行。Docker
   Desktop 的 accept-all 接口恰恰是 accept 后立刻 RST——于是「两个无监听对照
   端口」那套论证在**目标平台上是死代码**（实测：accept-then-RST → not-api →
   通过）。现在拆出独立的 `no-response` 结局，它必须由两个对照端口都 accept
   **且产生相同结局**来解释；`attemptConnect` 另区分 `unattemptable:`
   （EINVAL/ENETUNREACH/EHOSTUNREACH 等本机没试成的情形），这类结果不再算
   隔离证据，如实记为无法取证。本机实测：`utun4 198.18.0.1` 走 proven
   accept-all 分支并如实标注，其余 18 个地址逐一 refused/timeout。
2. **generator 的信号处置整段不可达，且它的反例是假绿（A）**。实测
   `kill -INT` 落在生成期间时 handler 从不执行，进程 exit=0 且八份文件全部
   落盘——Node 的信号监听器不 ref 事件循环，而生成是一整段同步代码；而那条
   「rename 窗口」反例用自造 fixture + 同步生成器，信号只可能落在生成之前或
   之后，`leftovers.length > 0` 恒不成立，**任何实现都能通过**。现在 CLI 走
   `generateAndPreflightInterruptible`（每份文件之间让出事件循环并检查
   `terminationSignal()`），反例改成驱动**真实 CLI**、轮询到第一份暂存文件
   出现才发信号，断言零残留 + SIGINT 终止 + 处置报告删了什么。

其余确认级修复：cleanup 把明文 Secret 目录排到 project 形状校验**之前**
（此前 project 名不合规会连带把凭据留在盘上）、目录守卫从无锚点 `includes`
改为「tmpdir 下该前缀开头」、二次 cleanup 先判存在性再 realpath（此前信号
路径必然产出 ENOENT 伪 residue）、override 的删除交给拥有 cleanup 的一方
（此前主流程先删会让 handler 的 `compose down` 以 no such file 失败）、
信号在飞时主流程不再把 docker 错误记成失败也不重复 cleanup、probe 补 catch
使抛错路径不再丢弃 residue 并在信号在飞时停止创建新容器、smoke 与 probe 的
信号路径补齐匿名悬挂卷对照（六类复查完整）、secret 可见面改为比对**全路径**
source 并覆盖全部 mount 与 `/run/secrets` 下的 tmpfs（此前只比 basename、只筛
前缀）、模板扫描反复剥离注释标记并把任何带 userinfo 的连接串（redis/mongodb
等）纳入拒绝。信号窗口套件自身也被硬化：只接受真实信号终止（不再接受
exit 130/143 的伪装）、检查被测 CLI 自己报出的 FAIL/residue、build 窗口改为
等 `compose … build api` 子进程**真实出现**才发信号（此前 trigger 落在拓扑
门禁期间，全部残留断言都是空真）、tracked compose 与 HEAD 逐字节比对。

反例从 47 → 62 → **67 项**：新增「干净 bundle 预检零问题」的**正向基线**
（审计实测：把 0700 判据改成拒绝一切正确目录时，33 条反例仍全绿）、双层注释
与非 postgres DSN、generator 侧不回显未知条目名、预检抛出时的清理回归。全部
以指定理由捕获、0 漏网。

#### M3B 第二轮总控阻断整改（整改中，未 Accepted）

总控第二轮复验点名七项 P1。每项都是**先写会红的窄反例、再实现、再验证**，新增
[`check-m3b-round2-negatives.mjs`](../../infra/docker/check-m3b-round2-negatives.mjs)
（**8 项**）：

1. **原子 promotion**。此前用 `renameSync`——POSIX 语义是「目标存在就静默替换」，
   并发写者或上一轮残留放好的同名 final 文件会被无声改写。改用「硬链接到 final
   名（目标已存在时 EEXIST 失败）→ 删除 staging 名」的两步，取得 no-replace
   原子性。反例注入一个恰好抢在 promotion 之前的写者：修复前 final 被覆盖，
   修复后拒绝且外部文件逐字节不变；另一条断言失败清理**只删本轮自己创建的路径**。
2. **failure-safe cleanup**。删掉全部吞错的空 catch（generator 里只剩一个纯存在性
   判断的 `lstat` catch）；共享 collector 做 continue-on-failure、聚合 residue，
   并在删除之后**独立枚举目录**复查是否还有八份清单里的条目（含 `.staging.`
   前缀）。有残留时聚合成安全错误，**绝不**再说 “was removed”。反例把目录设成
   `0500` 阻断删除，断言八条逐文件 residue + 一条独立复查 residue、`removed` 为空。
3. **preflight 信号窗口**。active scene 现在保持到 generate 与 preflight **全部**
   完成；preflight 返回后先让出事件循环、再复查 pending signal，之后才允许输出
   成功。反例用可注入的同步 preflight 忙等窗口发 SIGINT：修复前照常打印成功并
   留下八份 Secret，修复后零残留、无成功输出、以 SIGINT 语义收场。
4. **smoke/probe 最早期窗口**。临时 Secret 目录一创建就登记 cleanup scene（此前
   要到 `await danglingVolumes()` 之后才登记，那段窗口被中断会把明文目录留在盘
   上）；override 区分 absent/created，未创建时 cleanup 不引用它；override 删除
   升级为**正式 cleanup 阶段**并进入 residue 复查。信号窗口因此从 3 个增加到
   **5 个**（新增 pre-baseline 与 pre-override）。
5. **全仓 Git index containment**。新增 `scanTrackedRepositoryForNeedles`：对每个
   tracked 路径**分别**读 Git index blob 与工作树内容。反例在一个普通 tracked
   文件（`services/api/src/notes.ts`）里 `git add` 一个 Secret 后把工作树恢复
   干净——只读工作树的实现完全看不见，修复后以 `(git index)` 归因命中且不回显
   取值。
6. **子进程 PGID 生命周期**。`activeProcessGroups` 改为 `pgid → { alive }`；
   TERM 之后的 SIGKILL 升级 timer 绑定该 child，`close`/`error` 时取消，发信号前
   再确认 alive。反例：child 约 100ms 关闭、宽限 1.5 秒后**不得**出现 SIGKILL
   （修复前实测会对已关闭的 pgid 发 SIGKILL）；反向保证保留——忽略 TERM 的真实
   后代照样被 KILL 收掉。
7. **门禁收口**。runtime privilege probe 先检查容器退出码，成功证据只在
   `exit 0` 且该组零 problem 时输出；信号窗口的后代检查从全局 `pgrep -f` 改为按
   **被测 CLI 自己的进程组**查询，不再匹配其它 worktree 或本套件自身；模板扫描
   显式声明**只支持 dotenv 形态**，未知格式（YAML/JSON 等）直接拒绝并配反例
   （反例数 67 → **68**）。

本轮（第二轮）收口时的门禁数字是 local-test negatives **68**、round-two
negatives **8**、signal windows **5**；第三轮把前两项分别改成 **75 cases** 与
**12**（见下一节）。

#### 第二轮阻断整改之后的两路只读审计与定点修复

实现与窄反例落地后，按要求并行跑了两个只读审计（A：Secret / Git index / 模板
范围 / 输出泄漏；B：runtime / signal / PGID / Docker cleanup / network）。确认级
发现全部已修，其中五条推翻了刚写下的结论：

1. **信号路径仍然打印 `local-test smoke PASS`**（B）。被中断刻意不记为
   failure，于是 `failures` 为空就落到 PASS 分支，而此时 cleanup 甚至还没跑完。
   现在收尾按 `terminationSignal()` 判定，信号路径只输出
   `local-test smoke INTERRUPTED by <signal>`；信号窗口套件同时新增「信号路径
   出现 PASS 即失败」的断言——它此前只 grep `FAIL:`/`cleanup residue:`，
   属结构性假绿。
2. **后代判据结构性空真**（B）。CLI 起的每个子进程都是 `detached`、**自成
   进程组**，因此 `pgrep -g <cli pid>` 恒为空（实测：parent pid 39661 的组里
   只有它自己，子进程 PGID 等于自身）。五个窗口自述的「子进程全部消失」从未
   被真正验证。现在 `m3b-subprocess` 把每个真实派生的 pgid 以
   `m3b-descendant-pgid <pgid>` 公布到 stderr，套件按这份集合逐个
   `kill(-pgid, 0)` 确认进程组已空——既不空真，也不做会误抓其它 worktree 的
   全局 pgrep。
3. **postgres 端口断言的 fail-open**（B）。`strictInspectJson` 对**合法解析出
   的 JSON `null`** 也返回 `null`，`!== null` 守卫因此让整条断言静默消失。
   现在返回 `{ value, failed }`，只有读取失败才跳过（且那时已经 fail 过）。
4. **`enclosingGitRepository` 静默 fail-open**（A，本轮危害最高的一条）。任何
   非零退出——dubious ownership、bare 仓库、子进程被 Ctrl-C 的进程组信号杀掉
   导致 `status === null`——都被读成「不在 git 仓库里」，于是八份文件的 tracked
   检查、`.gitignore` 存在性与逐文件 `check-ignore` **整条静默跳过**且不产生
   任何 problem。现在只有「确实不是 git 仓库」允许跳过，其余 fail closed。
5. **模板格式 allowlist 被 `*.env.<任意后缀>` 绕过**（A）。实测
   `app.env.yaml` / `app.env.json` / `secrets.env.sh` 全部被当作 dotenv 放行，
   而它们一行都不匹配赋值文法 → 零 problem 静默通过，正是这条 allowlist 要
   消灭的形态。现在只认 `env` / `*.env` / `*.env.{example,sample,template}`
   与三个元文件。

其余确认级修复：pre-baseline 窗口此前不可达（smoke 的第一行输出在
`await danglingVolumes()` 之后，现已提前）；第一个资源与 baseline 查询移入
try/finally（此前 fail-closed 抛出会绕过整个 finally 把明文目录留在盘上）；
四处成功证据改为按该组 problem 计数 gating；信号在飞时**创建容器之前**就
检查（此前 probe 只在失败分支查、smoke 在创建之后查）；compose 参数里不存在的
`--file` 会被剔除（消除双重 cleanup 的假 residue）；project 形状拒绝改为记入
residue（裸 throw 会丢掉阶段 1 已收集的明文目录失败）；stray-bundle 检查从
全局 tmpdir 扫描收窄为本轮判定；成功之后收到信号不再谎报「还残留 8 份
Secret」（`.directory` 未复位）；生产失败路径补上独立目录复查并按本轮自己
创建过的名字收窄；同步失败判定前先让出事件循环，避免 `process.exit(1)` 吞掉
排队的 SIGINT；反例改为按**进程组**发信号（真实 Ctrl-C 语义）；promotion 第二
条反例校验错误身份（此前空 catch 可真空通过）；反例套件的 compose 变异副本
补进 `.gitignore`；泄漏断言覆盖变异**注入**的新取值；敏感 key 判据从纯
`endsWith` 扩为「后缀 + 词元」。

#### 第三轮阻断整改（inode ownership、忙等钩子、模板凭据、门禁自身）

四项定点整改。每一条的新窄反例都先在**未整改基线**（`22cc140`）上跑过：
11 条新判据在基线上 **11/11 全红**，随后才实现修复。

1. **cleanup 的 inode ownership**。路径不是身份：只登记路径的清理会按名字
   unlink，外部把某份成品 unlink 后放一个同名替身时，它删的是**别人的文件**
   （基线实测：`generateSecretBundle` 的失败清理与 `generateAndPreflight` 的
   真实接线**两条路径**都把替身删掉了）。现在登记 `{ path, dev, ino }`，身份
   取自**创建那一刻的 fd**（`fstat`，`wx` 保证该 inode 由本次调用创建），
   BigInt 形态以免大 inode 号在 double 上丢精度；promotion 时 final 名继承
   staging 的 dev/ino（`link(2)` 成功即同一 inode）；删除前 `lstat`（不跟随
   symlink）复核，对不上**不 unlink**、记 `ownership drift`、替身原样留下；
   读不到身份同样不删。独立目录复查刻意仍按**名字**判定（宁可多报不漏报）。
   smoke/probe 的临时 Secret 目录同样在 `mkdtemp` 后登记 inode，递归删除前
   复核。
2. **生产 preflight 忙等钩子删除**。`MEAL_AGENT_M3B_PREFLIGHT_DELAY_MS` 曾让
   生产二进制带着一个可由环境变量打开的同步忙等分支出厂（基线实测：设成
   5000ms 时真实开销 +4979ms 并打印窗口标记）。该分支已删除；CLI 的全部运行期
   接线抽成导出的 `runGeneratorCli(directory, { preflight })`，生产入口不传
   第二个参数。信号窗口回归改由 `infra/docker/fixtures/preflight-signal-window.mjs`
   驱动：它调**同一个** `runGeneratorCli`，只经**库级** seam 换上「打标记 →
   同步忙等 → 真实 `checkSecretBundle`」的预检，因此真实 handler、真实
   `generateAndPreflightInterruptible` 与真实中断判定全部照原样参与。新增反例
   同时做静态断言（十个生产源文件与 Compose 都不再提及该标识符）与动态断言
   （设置它之后相对基线运行的耗时增量远低于所请求的延时）。
3. **模板凭据扫描补全**，判据与赋值键名彻底解耦。userinfo 形改为任意 scheme、
   任意 userinfo 形态——旧式要求必须有 `:` 且两侧非空，因此 token-only
   （`https://ghp_X@host`）、password-only（`postgresql://:pw@host/db`）与退化形
   （`redis://@host`）全部漏网；credential 查询参数形从「postgres + password
   词干」放开为**任意 scheme** × {password, passwd, pwd, token, secret,
   api_key, access_token, credential}，键名允许前后缀，取值必须非空（空占位
   仍然允许）。四条新反例全部用中性键（`CACHE_ENDPOINT` / `CACHE_REPLICA` /
   `QUEUE_ENDPOINT` / `SEARCH_ENDPOINT`），基线上一条都没抓到。消息只报
   **类别 + 文件 + 行号**，绝不回显命中的串；当前真实 tracked 模板在新判据下
   仍然零 problem。
4. **门禁自身收紧**。收尾的零残留列举、Group C 的 leftover 列举、两处
   `which docker`、五处 `docker rm`、两处 `docker logs` 与 containment 的容器
   列举全部检查退出码（含 `status === null` 的信号情形），列举失败**立即返回**
   而不再让空 stdout 降级成「这里什么都没有」；新增 `containerPresence`，只有
   「退出码恰好 1 且 stderr 是**锚定整行**的 no such object」才判 absent，其余
   一律 unknown 并按失败处理（基线：一个恒定 exit 7 的 shim 就能让它判成「容器
   已被删除」）；`imageIdOf` 同样收紧为 status===1 + 锚定 `no such image: <tag>`
   （基线：一条关于**别的镜像**的错误就足以被读成「本轮 tag 不存在」）；
   `inspectJsonStrict` 与 containment 的 `strictInspectJson` 对**空 payload**
   改判读取失败，不再折叠成 JSON null。输出侧新增
   [`infra/docker/m3b-safe-output.mjs`](../../infra/docker/m3b-safe-output.mjs)：
   wrong-reason 分支一律只输出**期望判据与条目计数**，绝不拼接 raw problems /
   residue / 子进程输出；外来文本按取值 + 按形状打码。正向 baseline 扩为三项
   同时成立（干净 bundle、**当前真实 tracked 模板**、Git index/工作树逐字节
   一致）；cleanup 集成反例新增一条走 `generateAndPreflight` 真实接线的
   ownership 用例。

第三轮收口时的门禁数字是 local-test 75 cases、round-two/three negatives
**12**、signal windows **5**、topology mutations **15**；第四轮把第二项改成
**16**，第五轮再扩到 **21**（见下面两节）。

#### 第三轮整改之后的两路只读审计与定点修复

实现与窄反例落地并提交（`e6cb9fb`）后，按要求并行跑了两个只读审计（A：Secret /
inode / Git index / 模板 / 输出；B：runtime / signal / Docker cleanup / 门禁
fail-closed）。两路共提出 11 条，逐条经独立的「尽力证伪」复核：**6 条被推翻**
（其中最有价值的一条推翻理由是：`preflightNegative` 的 wrong-reason 分支之后
仍有一道**更强**的断言——把 `buildNeedles` 的全部取值逐个 `includes` 检查，
命中就判红，因此那里不打码不是漏，是比打码更硬的判据），**5 条确认并已修复**：

1. **A1（阻断级）：`link(2)` 解析的是名字，不是 inode。** 审计构造了同 uid 的
   并发写者在 promotion **之前**换掉 staging 名的场景，实测旧实现会把**外部**
   inode 链到成品名上、用**我们的** dev/ino 登记它、`unlink` 掉那个外部
   staging 文件，然后**返回成功**——同时删了别人的文件，又把别人的内容留在了
   一个规范 Secret 名上。这正是本轮要消灭的「路径不是身份」，只是换到了创建
   成品的那条路径。现在 promotion 之前先证明 staging 名仍指向本轮创建的
   inode，link 之后再证明成品名指向的也是它；对不上就拒绝，**既不链接也不
   删除**，只报 drift。新增第 12 条窄反例锁死这条路径（实测：拒绝、成品名未
   创建、外部 staging 文件逐字节不变、本轮自己的条目全部收敛）。
2. **A5：形状打码规则过宽。** pgpass 规则替换的是**整行**，且四段之间不要求
   任何形状，于是 `ts=2026-07-31T23:10:05Z:step:migrate:exit=1 …` 与
   `MEAL_AGENT_API=http://[::1]:3000/readyz` 这类完全无害的诊断被整行抹成一个
   占位符——失败信息因此丢掉了它的**指定理由**，正是本轮在别处反对的形态。
   现在 port 必须是数字、口令段必须无空白且直到行尾，且**只替换最后那一段**。
   顺带修掉 `wrongReason` 对非数组参数一律记 0 的问题。
3. **B1：目录层的 inode 守卫没有任何门禁触及。** `secretsIdentity` 只有 smoke
   与 probe 会传，四套反例一律走默认的 null，因此把那段守卫整个删掉所有门禁
   照样绿——而它守的是一次**递归删除**。新增第 75 条 case 显式构造 drift
   （同一路径换成不同 inode 的目录），断言报出 drift 且外部目录逐项存活。
4. **B2：「生产不再认识该环境变量」的静态断言是一份手写白名单。** 把同一个
   钩子加进 `check-compose-topology.mjs`（smoke 在生产路径上真的 spawn 它）或
   `postgres/` 下任何被打进镜像的脚本，白名单版本会判绿。现在改为**全仓
   tracked 文件逐个扫**，只放行本反例文件、`fixtures/` 与 Markdown 文档三处。
5. **B3：信号窗口套件里的 per-run image tag 判据没跟上。** 它仍用无锚点子串
   匹配、且不要求退出码恰好是 1，于是被信号杀掉的 docker CLI 或一条关于**别的
   镜像**的错误都会被读成「本轮 tag 已被删除」——而这是唯一一处在信号路径上
   验证 per-run tag 消失的地方。现在与 `imageIdOf` 同判据，并补上 try/catch
   （此前 spawn 失败会让进程带栈直接死掉，FAIL 汇总与 5 窗口完整性计数都不会
   打印）。

审计同时记录了若干**已确认正确**的面：inode 模型在本机上 `fstat`/`lstat` 跨
`link(2)` 给出一致的 dev+ino；happy path 恰好 8 条 owned 记录且 staging 条目
全部正确摘除；ENOENT 在 lstat 与 unlink 两侧都被正确判为「已不在，不是残留」；
四条新模板反例确实以正确的两个类别命中，而路径里的 `@`（`https://example.com/a@b`）
不被误判；正向 baseline 的模板扫描无条件先跑（不因 bundle 断言失败而被跳过）。

#### 第四轮窄修（ExitCode fail-closed、整串 stderr 判据、解码后的 query key）

三个代码缺口，每一条都先在**未整改基线**（`b3bed2c`）上跑红，再实现修复
（证据见每条的「修复前」）。

1. **one-shot ExitCode 的 fail-closed 读取**。`inspectStrict` 此前对「退出 0
   但 stdout 为空」原样返回空串，而 `runOneShot` 用的是
   `Number(text)` + `Number.isInteger`——`Number('')` 是 **0**。
   *修复前*：8/8 非规范形态（空串、空白、`+3`、`-1`、`1.0`、`1e3`、`0x10`、
   前导零）全部被接受为退出码；PATH shim 让 `docker inspect --format
   {{.State.ExitCode}}` 退出 0 且不打印时，`inspectStrict` 返回 `""`；把同一个
   shim 挂到**真实调用链**上（基线仓库的完整 clone），基线 smoke **退出 0、
   打印 `local-test smoke PASS`、并逐条记录 `chain <service>: exit=0`**——十步
   链的退出码证据整条是伪造的。
   *修复后*：`inspectStrict` 对空 stdout 抛 fail-closed 错误（需要空值的调用方
   必须显式传 `allowEmpty: true`，全仓只有一处 compose service label 判定这么
   做，且它自带具名判定）；新增 `parseInspectedExitCode`，只接受
   `^(?:0|[1-9][0-9]*)$` 且必须是安全整数。同一个 shim 下，smoke 拒绝该 payload、
   不记录任何 `exit=` 行、并以非零退出。
2. **「资源不存在」必须整串匹配**。三处判据（`imageIdOf`、
   `containerPresence`、信号窗口的 per-run tag 复查）此前各写各的正则，且都带
   `m` 标志——**按行**匹配。
   *修复前*：一条多行包装的 stderr（`warning: retrying` + 正确的
   `No such image: <tag>`，退出 1）被 `imageIdOf` 读成 **ABSENT**。
   *修复后*：三处共用 `isAbsenceMessage`，对**整串** `stderr.trim()` 做锚定
   匹配、**不带 `m` 标志**；退出码必须仍精确等于 1。实测 9 种 stderr 形态
   （精确、带首尾空白、前缀行、后缀行、行内前缀、行内后缀、另一个对象、另一个
   容器）判定全部正确；退出码 7 配一条完全正确的「不存在」消息同样 fail closed。
3. **模板扫描识别编码后的 credential query key**。此前只在**原始文本**上匹配
   词干。
   *修复前*：`pass%77ord=` 与 `%70assword=` 两种百分号编码在字节层面不含
   `password`，**完全没有被抓到**（`access%5Ftoken` 与 `X-API-KEY` 恰好因为
   仍含 `token` / `api-key` 字面量而被旧判据命中——这一点如实记录，不夸大）。
   *修复后*：在原始文本判据之外增加一层按 WHATWG `URL` + `URLSearchParams`
   **解码后**的 query key 判定（有界解析：每行最多 8 个候选、每个最长 2048
   字符），key 转小写并去掉 `-`/`_`/`.` 后与紧凑词干比对。7 种形态实测判定
   正确（四种编码/大小写/分隔符变体被抓，benign `?sslmode=require` 与空占位
   `?password=` 不误报），且失败消息只含**类别 + 文件 + 行号**，取值与整条
   连接串都不出现。

第四轮之后的门禁数字：**local-test 75 cases = 1 个正向 baseline + 74 个反例/
边界检查**、targeted negative suite（**当时**为 16）、signal windows **5**、
topology mutations **15**；**第五轮把窄反例扩到 21**（见下一节）。

M3B 的**完整命令清单（七条）**，与 [`infra/docker/README.md`](../../infra/docker/README.md)
逐条一致：

1. `node infra/docker/check-compose-topology.mjs`
2. `node infra/docker/check-compose-topology-mutations.mjs`
3. `node infra/docker/check-local-test-negatives.mjs`
4. `node infra/docker/check-m3b-round2-negatives.mjs`
5. `node infra/docker/check-m3b-signal-windows.mjs`
6. `node infra/docker/run-local-test-smoke.mjs`
7. `node infra/docker/probe-compose-secret-identity.mjs`

（另有两条**运维**命令，不属于门禁：`generate-local-test-secrets.mjs` 与
`preflight-local-test-secrets.mjs`。）

#### 冻结面与已登记的未修项

- **受控例外**：[`check-compose-topology-mutations.mjs`](../../infra/docker/check-compose-topology-mutations.mjs)
  属于已 Accepted 里程碑的门禁面。第三轮对它做了**诊断输出加固**（wrong-reason
  分支改为固定类别 + 输出行数，不再回显被变异 compose 文件的原文，因为其中几条
  变异内嵌合成 DSN 与 AppSecret）。**判据集与 15 条变异本身未改**。因此不能
  笼统声称「冻结面零触碰」——这是一处明确的、范围受控的例外。
- **已登记但本轮不修**：[`services/api/tests/unit/bootstrap-signal-matrix.test.ts`](../../services/api/tests/unit/bootstrap-signal-matrix.test.ts)
  的 `docker ps` 退出码 fail-open（失败的 `docker ps` 给出空 stdout，于是
  「没有幸存容器」这条断言真空成立）。它属于已 Accepted 的 M3A 冻结面，本轮
  **不触碰**，留到 **M5 总门禁加固**处理。

#### 本轮的威胁模型（边界，不要过度声称）

M3B 的判据面向**运维事故与实现回归**，不面向本机上的敌手：

- **本地同 EUID 进程受信**：同 EUID 的进程本来就能读写这些文件、连接 Docker
  socket、替换 PATH 上的任何二进制；
- 因此**目录被恶意替换、外部对 Secret 文件建硬链接、同 EUID 进程抢占临时
  Compose override** 三类**不作为当前 M3B blocker**；
- 已落地的 inode 身份复核、no-replace promotion 与 scoped cleanup，定位是
  **不误删他人文件、不把读取失败读成阴性证据**，不是抵御同 EUID 敌手。

#### 第五轮 bounded 窄修（absence fail closed、候选扫描不得免检）

两个代码缺陷，都先在 `230371e` 上跑红再修（5/5 全红，证据见每条）。

1. **absence 判据对内嵌换行 fail closed**。第四轮去掉了 `m` 标志，但正则里的
   `\s` 本身就跨行，于是**两行** stderr 仍然整串匹配成功。
   *修复前*（`230371e` 实测）：`Error response from daemon:\nNo such image:
   <tag>` 与 `No such image:\n<tag>` 两种形态，纯函数判据都返回 `true`，走
   **真实 `imageIdOf` + PATH shim** 也都 `read as absent`。
   *修复后*：`trim()` 之后只要还含 CR 或 LF 就直接 `false`；正则内部不再有任何
   `\s`，只保留必要的水平空白 `[ \t]*`；退出码仍必须精确等于 1；三处调用点
   （image、container presence、signal window）继续共用同一个 helper；判据只
   返回布尔值，不构造含外部内容的消息。反向保证同时断言：单行与水平制表符
   形态仍然判为 absent（否则「全判 false」也能让反例恒绿）。
2. **连接串候选扫描不得静默免检**。资源上限（最多 8 个候选、每个最长 2048
   字符）保留，但**超限不再是免检额度**。
   *修复前*（`230371e` 实测）：第 9 个候选被 `break` 跳过、超长候选被长度判断
   跳过，两者的 `pass%77ord=` 都**零 problem 静默放行**；`\S+` 还会把逗号后的
   第二条 URI 吞成第一条的 query 取值，`NOTES=https://first.invalid?mode=ok,
   redis://…?pass%77ord=…` 同样零 problem。
   *修复后*：提取改为**分隔符感知**（空白、逗号、分号、引号、尖括号、竖线、
   反斜杠都终止候选），每个 `scheme://` 起点独立识别；扫描本身有界（每个候选
   最多前进 2049 字符）；超出任一上限时以固定类别
   `unscannable connection string candidate` fail closed，且该判定**优先于**
   原始文本层的结论。三条失败消息都只含类别 + 文件 + 行号，实测不含
   `SYNTHETIC`、URL、key 或取值；八个 benign 候选与空占位 `?password=` 仍然
   干净。

窄反例套件因此从 16 扩到 **21**（每种要求的形态各一条：两种换行形态、第 9 个
候选、超长候选、逗号分隔）；**当时**的输出名还带轮次，第六轮已改为不带轮次的
稳定名称（见下一节）。

#### 第六轮 bounded 结构性窄修（候选枚举 + 解析失败 fail closed + 稳定套件名）

前几轮对「第二条 URI 被前一条吞掉」的处理是**往分隔符字符类里补字符**（先补
逗号）。这一轮改的是**结构**：

1. **独立枚举所有 `scheme://` 起点**。此前是「找到一个候选 → 从它的结束位置
   继续找下一个」，任何**落在前一个候选内部**的起点被整段跳过。
   *修复前*（`23c3953` 实测）：括号、方括号、花括号包裹第二条 URI 的三种形态
   **全部 UNCAUGHT**；把九个起点挤进同一个无空白字段时，扫描器**只看到一个
   候选**，第 9 个起点根本不存在于它的视野里。
   *修复后*：先用只匹配 `scheme://` **前缀**的正则枚举出一行里的全部起点（前缀
   很短，`matchAll` 的 lastIndex 只越过前缀本身，嵌在后面的起点照样枚举得到）；
   候选数量按**起点总数**计算，出现第 9 个立即以固定类别
   `unscannable connection string candidate` fail closed；每个候选的结束位置取
   **下一个起点 / 分隔符 / `start + 2049` 硬上界**三者中最早的一个。分隔符退回
   成三个终止条件之一，不再是唯一的那个。
2. **URL 解析失败 fail closed**。
   *修复前*（`23c3953` 实测）：`redis://[invalid?pass%77ord=…`（malformed IPv6）
   与 `redis://host:99999?pass%77ord=…`（非法端口）都让 WHATWG 解析器抛错，而
   `catch { continue }` 把它当成「这里没有凭据」——两条都是零 problem 静默放行，
   等于任何能让解析器抛错的写法都是一张免检通行证。
   *修复后*：已经被识别为 `scheme://` 候选的片段，只要 `new URL()` 失败就返回
   `unscannable connection string candidate`，不再 `continue`。反向保证同时断言
   benign URL、**2048 字符边界**与空占位 `?password=` 仍然干净，避免退化成
   「一律 fail」。

三条失败消息实测都只含类别 + 文件 + 行号，不含 `SYNTHETIC`、URL、query key 或
取值。窄套件从 21 扩到 **25**（括号矩阵、九起点同字段、malformed IPv6、非法端口
各一条），并精确钉住 25/25（**当时**的计数；第七轮扩到 26，见下一节）。

**套件名称不再带轮次。** 文件名保留 `check-m3b-round2-negatives.mjs`（不改已被
文档与流程引用的入口），但文件头与 stdout/stderr 的套件名统一为
**M3B targeted negative suite**——轮次编号会随每一次整改过期，写进当前门禁的
名字就意味着每加一轮都要改名，而且旧名字立刻变成错的。上面各轮小节里的轮次
编号是**历史实施记录**的锚点，保留不改。

#### 第七轮 bounded 候选边界窄修（标点不再是边界）

第六轮把候选枚举改成了「按 `scheme://` 起点独立枚举」，但**结束**判据里还留着
一张标点表（`,;'"\`<>|\\`）。那张表本身就是缺陷：这些字符**在合法 URL 里就是
合法的**，把它们当边界只会把一条完整 URL 拦腰截断。

*修复前*（`a486884` 实测，五种形态**全部 UNCAUGHT，且一条 problem 都不产生**）：

| 形态 | 整体是否合法 URL（`new URL()`） | 解码后的 query key | 扫描结果 |
| --- | --- | --- | --- |
| `https://host/path,rest?pass%77ord=…` | 是 | `password` | 无任何 problem |
| `https://host;path?pass%77ord=…` | 是 | `password` | 无任何 problem |
| `https://host/path\|rest?pass%77ord=…` | 是 | `password` | 无任何 problem |
| `https://host/path'rest?pass%77ord=…` | 是 | `password` | 无任何 problem |
| `https://host\?pass%77ord=…` | 是 | `password` | 无任何 problem |

候选在标点处被截断成 `https://host/path` 之类，query 连同其中的凭据一起消失，
于是既没报「有凭据」也没报「扫不完」——静默放行。

*修复后*：候选**只**由三件事结束——下一个独立枚举到的 `scheme://` 起点、一个
ASCII 水平空白（空格或制表符）、`start + 2049` 的长度上限。标点全部交给 WHATWG
URL 解析器按规范处理；解析不动的候选仍走
`unscannable connection string candidate`，第 9 个起点与超长候选也仍是固定类别
fail closed。**不再维护任何标点 allowlist/denylist。**

新增的反例先用真实 `new URL()` 逐条证明「整体合法且解码后的 query key 是
`password`」，再要求每一条都被判成 **credential query parameter**——而不是靠
`unscannable` 蒙混过关；每种形态还配了一条不含 credential query 的 benign 对照，
必须保持干净。targeted negative suite 因此从 25 精确增加到 **26/26**（**当时**的
计数；第八轮扩到 27，见下一节）。

#### 第八轮 bounded 结构性候选视图修正（边界改由 dotenv 逻辑取值决定）

前几轮一直在**字符表**上打补丁：先是标点表（`candidateDelimiter`），第七轮换成
空白表（`candidateWhitespace`）。两者都错在同一件事上——把「URL 里哪个字符是
分隔符」和「一个取值在哪里结束」混成了一个问题。前者只有 WHATWG 解析器有资格
回答，后者是 **dotenv 语法**的问题。本轮把边界判据整体搬到 dotenv 侧，两张字符
表全部删除。

*修复前*（`6e154b4` 实测，四种形态**全部 UNCAUGHT，且一条 problem 都不产生**）：

| 形态 | 完整取值的解码 query key | 扫描结果 |
| --- | --- | --- |
| `NOTES=https://first.invalid?redirect=https://second.invalid/path&pass%77ord=…` | `redirect`, `password` | 无任何 problem |
| `NOTES=https://first.invalid?redirect=redis://second:6379/path&pass%77ord=…` | `redirect`, `password` | 无任何 problem |
| `NOTES="https://host/path rest?pass%77ord=…"` | `password` | 无任何 problem |
| 同上，path 中是**真实制表符** | `password` | 无任何 problem |

前两条：外层候选在**内层起点**处被截断成 `https://first.invalid?redirect=`，
带凭据的 query 参数落在被砍掉的部分里；而内层视图 `https://second.invalid/path&…`
根本没有 `?`，于是两个视图都判不出凭据。后两条：引号内的空格/制表符被当成边界，
取值被拦腰截断。

*修复后*——`dotenvLogicalSegments()` 明确定义四类边界与异常形态：

- **注释**：行首 `#` 反复剥离后再判定，注释里的凭据照扫；
- **赋值**：`KEY=` 之后是取值；非赋值行整行作为一个片段（README 散文等）；
- **quoted**：边界是配对的同种引号，引号内的空格与制表符**原样保留**；
- **unquoted**：到行尾（去尾部空白），行内 `#` 不当注释起点，宁可多扫；
- **异常**：引号未闭合、或闭合引号后跟着非空白且非 `#` 的内容 → 取值边界不明确
  → **fail closed**；闭合引号后的 `#` 注释作为**另一个片段**继续扫描。

候选视图随之改为：在逻辑片段内枚举全部 `scheme://` 起点，**每个起点给出一个
独立、可重叠的视图，一律延伸到片段末尾**。内层起点仍然计数、仍然各自成一个
独立视图（`?mode=ok(redis://…?pass%77ord=…)` 这类要靠内层视图才抓得到），
但**不再截断外层候选**。

保留不变：最多 8 个起点、每个候选视图最多 2048 字符、第 9 个起点与超限一律
`unscannable connection string candidate`、失败消息只含类别 + 文件 + 行号。

新增反例先用真实 `new URL()` 逐条证明「完整取值可解析且解码后的 query key 是
`password`」，再要求每条都判成 **credential query parameter**（显式排除靠
`unscannable` 假通过），并各配一条只含 `mode=ok` 的 benign 对照。targeted
negative suite 从 26 精确增加到 **27/27**；既有的第 9 起点、2048/2049 边界、
malformed URL、合法标点与全部 benign 用例复跑通过。

**M3B 状态：已取得完整 bootstrap/full-stack 本地证据，但尚未 Accepted；
未完成的是 M4/M5 与 09A 总验收。阶段 09A 仍为 In Progress；ADR-0005 仍为
`Proposed`；PR #1 保持 Draft。M4、M5 未开始。**

M3B **不覆盖**（属于 M4、M5）：停止/重启持久化、`pg_dump`/`pg_restore` 备份恢复、
备份 SHA、N-1 恢复演练、API SIGTERM 生命周期、`pnpm stage09a:check` 聚合门禁与
GitHub Actions。本轮保持 fake adapter，不调用任何真实微信服务；不购买服务器、
不开放公网；ADR-0005 保持 `Proposed`，PR #1 保持 Draft；M4、M5 未开始。

### M4：生命周期、备份和恢复

1. 提供明确命令完成：
   - 构建镜像；
   - 从空 volume 初始化；
   - 执行 migration；
   - 启动 API；
   - 检查 `/healthz` 与 `/readyz`；
   - 停止并重启后验证数据仍在；
   - 销毁本阶段专用测试资源。
2. 提供 `pg_dump` 自定义格式备份和恢复到全新测试数据库的脚本或容器命令；runbook 必须说明 `pg_dump` 不包含 cluster roles，并区分“全新安装”与“从 dump 恢复”的 bootstrap 顺序。备份测试至少包含两个合成家庭，证明完整导出不受 FORCE RLS 截断。
3. 备份生成 SHA-256；恢复前先校验，不匹配时禁止调用 `pg_restore`。恢复使用单事务；备份文件写入已忽略目录，不进入 Git。执行前后打印目标环境和数据库标识，但不打印密码或完整连接串。
4. 恢复演练必须使用合成 sentinel 数据，验证：
   - migration ledger 和 checksum 完整；
   - 恢复后 `/readyz` 通过；
   - 合成家庭/库存记录可授权读取；
   - runtime role 仍不能绕过 RLS 或执行 DDL。
   - database owner 为 `meal_agent_migrator`，全部 schema/table/function owner、`SECURITY DEFINER` owner、GRANT 与 RLS 状态和备份前一致。
5. **受支持的恢复 ledger 窗口至少覆盖 N-1**（见
   [ADR-0005 §2.4](../architecture/decisions/0005-local-private-deployment-baseline.md)）。
   本阶段不存在第二个 ledger，因此 M4 验证的是同一 ledger 的 round-trip
   （`0000—0004` 备份 → 恢复 → 仍是 `0000—0004`）；但授权 manifest 必须为窗口内
   的**上一个已发布 ledger** 保留对应的 containment 状态，删除旧状态等于宣布该
   窗口的 dump 不再可恢复，属于需要显式决策的破坏性变更。首次出现 `0005` 时，
   恢复演练必须扩展为 `cluster` → `createdb --owner=meal_agent_migrator` →
   `pg_restore`（N-1 ledger）→ containment → `db:migrate`（补齐到当前 ledger）
   → final → 验证。
6. 本阶段只记录本地演练耗时，不声明生产 RPO/RTO。
7. SIGTERM 测试必须证明进程在限定时间内真正退出；当前只设置 `process.exitCode` 的超时分支不能作为强制退出证据。

### M5：门禁、CI 与文档

1. 增加根命令 `pnpm stage09a:check`，至少串联：
   - `pnpm stage08:check`；
   - Dockerfile/Compose 静态检查；
   - 镜像构建；
   - 空库启动与 migration；
   - health/readiness；
   - runtime 最小权限反向测试；
   - 持久化重启；
   - 备份恢复；
   - 日志/镜像/配置 Secret 扫描；
   - 清理。
2. 容器测试失败时保留足够诊断信息，但不得输出 Secret；无论成功失败都清理本阶段创建的 container/network，失败现场需要显式 opt-in 才保留。
3. GitHub Actions 使用同一 `stage09a:check`，不维护第二套部署逻辑。远端 run 未真实成功前只记录 workflow 已配置，不记录 CI Pass。
4. API runtime image 必须证明不包含 Taro、Swiper、webpack-dev-server 等客户端依赖，并执行适用于服务端镜像的独立依赖/组件扫描。
5. 在 2026-08-08 前复核 local/weapp-only 依赖例外：不得为了通过阶段 09A 静默续期；例外未关闭时继续阻断阶段 09B、外部测试、体验版和发布。
6. 更新根 README、API/infra/operations README、项目状态、本计划和 [ADR-0005](../architecture/decisions/0005-local-private-deployment-baseline.md)；只有真实容器证据通过后才把 ADR 从 `Proposed` 改为 `Accepted`。

## 验收门禁

| # | 必须满足 |
| --- | --- |
| 1 | 从干净 checkout 使用一条文档化命令构建并启动，不依赖本机 `node_modules`、`dist` 或全局 pnpm |
| 2 | PostgreSQL 固定为 **18.4**（exact patch，`createdb`/`initdb`/`pg_ctl`/`postgres`/`psql` 五个工具逐一按 banner 主版本字段严格校验，混装与 `18.3` 一律拒绝，均有自动化测试），migration 从空库顺序执行，第二次执行幂等，checksum 漂移 fail closed；Compose 固定的 image digest 必须由真实仓库解析获得，不得编造 |
| 3 | `/healthz` 只证明进程存活；数据库不可用、migration 缺失或 checksum 不一致时 `/readyz` 返回非 ready |
| 4 | 原生 PostgreSQL 18 空实例真实完成 `0000 → database/public/drizzle/ledger 权限交接 → migration login SET ROLE 执行 0001—最新`；migration login 自身非 superuser，但 migrator role 的 DDL/BYPASSRLS 高权限被如实记录；API runtime 不能 DDL 或进入 `meal_agent_migrator`，也不持有 bootstrap/migration 凭据 |
| 5 | PostgreSQL 无 host port；API 只发布到 `127.0.0.1`，无额外 IPv6 listener，宿主非 loopback 地址访问失败；fake 登录拓扑没有公网入口 |
| 6 | API container 非 root，未使用 privileged、host network 或 Docker socket，镜像和配置不含 Secret |
| 7 | 停止/重启后合成数据保留；备份包含两个合成家庭；SHA-256 不匹配会在 restore 前失败；合法备份可单事务恢复到 owner 为 `meal_agent_migrator` 的全新数据库，并通过 database/schema/object owner、GRANT/RLS、readiness 和授权读取验证 |
| 8 | migration 等锁和 graceful shutdown 均有界；SIGTERM 超时会真正结束进程；固定场景“写已提交但响应丢失 → API 被终止并重启 → 原 payload + 原 Idempotency-Key 重试”只存在一条领域事件并重放原结果 |
| 9 | `pnpm stage08:check` 继续全绿，不因容器化改变 contracts、API、客户端或数据库语义 |
| 10 | 本地完整门禁通过；如创建 PR，则 GitHub Actions 真实 run 通过并记录 URL/ID |
| 11 | Docker 不可用时门禁明确失败为缺少前置工具，不能降级成静态检查后宣称 Pass |
| 12 | `git diff --check`、Markdown 本地链接及密钥/真实数据/生成物扫描通过 |
| 13 | API image 不含客户端构建依赖；依赖例外未过期、未静默扩展，且 external-test 阻断保持生效 |
| 14 | 受支持的恢复 ledger 窗口**至少覆盖 N-1**：窗口内每个已发布 ledger 都有对应的 containment manifest 状态，删除任一状态必须是显式的破坏性决策；本阶段验证同一 ledger 的 round-trip，`0005` 出现后必须扩展为「`pg_restore`(N-1) → containment → `db:migrate` → final → 验证」的跨-ledger 演练 |

## 非范围

- 购买或创建腾讯云、阿里云及其他云资源；
- 公网 IP、域名、ICP、HTTPS 证书、反向代理、WAF 或 CDN；
- 托管 PostgreSQL、正式 Secret 服务、生产监控和生产备份策略；
- 真实 AppID/AppSecret、`wx.login`/code2Session、真机、体验版、审核或发布；
- Android、iOS、HarmonyOS 构建、签名或商店发布；
- 菜单推荐、菜谱、采购、Agent、OCR、通知或新的业务 API；
- 权威 allergen、food concept、宗教/伦理或 cooking-technique 词表。

最后一项仍是推荐能力的产品安全前置，但与本地部署基线是不同工作流，不应混入同一个基础设施提交。

## 工具前置

执行任务开始时先检查 Docker CLI 与 Compose v2。总控机器已安装 Docker Engine 29.6.2 与 Docker Compose v5.3.1（2026-07-27 核实），因此工具前置不再阻塞；M1 的镜像构建与 M2B—M5 的 Compose 运行都可以取得真实证据。仍然成立的是：没有真实容器运行、备份与恢复证据之前，阶段 09A 不得完成最终验收。

项目只依赖标准 `docker` / `docker compose` 接口，不在仓库中绑定某个 Mac 桌面产品。系统级安装由产品负责人确认并完成，执行任务不得静默安装桌面软件、修改系统网络或接受第三方许可。

## 实施与复核流程

1. 从最新本地 `main` 创建独立 worktree 和 `codex/stage-09a-local-deployability-baseline`。
2. 执行任务只实现本计划，保持每个里程碑独立提交，不合并 `main`。
3. 实现任务提交后，由项目总控先做部署架构、数据库最小权限和恢复证据审核。
4. 再由独立复核任务执行容器逃逸面、Secret、网络暴露、migration/restore 破坏性风险审查。
5. P0/P1 全部关闭、完整门禁通过且文档与事实一致后，才建议合并。
6. 阶段 09A 合并后再决定是否购买一个月测试服务器并启动阶段 09B；阶段 09B 必须单独记录云账号、区域、网络、防火墙、访问方式和成本。

## 计划验证命令

具体参数由实现落地，命令入口保持稳定：

```bash
pnpm install --frozen-lockfile
pnpm stage09a:check
pnpm docs:links:check
git diff --check
```

M2A 另有两条命令，其中只读门禁已并入 `pnpm --filter @meal-agent/api check`：

```bash
pnpm --filter @meal-agent/api manifest:check      # 只读门禁，一次校验四个 adapter
pnpm --filter @meal-agent/api manifest:generate   # 开发期重新生成四个 adapter
```

M2B 与 M3A 另有两条命令，尚未并入任何聚合脚本（并入 `stage09a:check` 属于 M5）：

```bash
node infra/docker/check-compose-topology.mjs             # 解析后 Compose 配置的静态门禁
node infra/docker/check-compose-topology-mutations.mjs   # 上一条门禁自身的变异反向测试
```

变异反向测试会**临时改写** tracked 的 `compose.local-test.yaml` 再运行门禁；它在
文件不干净时拒绝运行，每次变异后立即写回原始字节，并在结束时逐字节复核还原结果。

M3B 的**独立门禁命令是七条**（同样尚未并入聚合脚本，属于 M5）。这一段此前写的
是「五条命令 / 47 项反例」，那是 M3B 早期的数字，早已被后续几轮整改推翻；现按
实际实现列出：

```bash
node infra/docker/check-m3b-round2-negatives.mjs       # M3B targeted negative suite（27 cases）
node infra/docker/check-local-test-negatives.mjs       # 75 cases = 1 正向 baseline + 74 反例/边界
node infra/docker/check-m3b-signal-windows.mjs         # 5 个真实信号窗口的零残留取证
node infra/docker/check-compose-topology.mjs           # 解析后配置的静态拓扑门禁
node infra/docker/check-compose-topology-mutations.mjs # 15 项拓扑变异反例
node infra/docker/run-local-test-smoke.mjs             # 空 volume 完整链 + containment + 隔离
node infra/docker/probe-compose-secret-identity.mjs    # Compose Secret 的容器内 UID/mode 证据
```

另有两条**运维**命令，不属于门禁：

```bash
node infra/docker/generate-local-test-secrets.mjs      # 八份 Secret 的单一来源生成
node infra/docker/preflight-local-test-secrets.mjs     # 部署前交叉一致性预检
```

`pnpm stage09a:check` **尚未创建**（属于 M5）。在它存在之前，本阶段的本地证据由
`pnpm stage08:check` 与上面各条命令给出，不得把 `stage08:check` 通过表述为阶段
09A 通过，也不得把 M2B 的静态断言与 postgres 单服务启动表述为全栈通过；M3B 的
smoke 通过也只覆盖 M3B 自身的范围，不含 M4 的备份恢复与 M5 的聚合门禁。

Compose 运行未完成或备份恢复未验证时，只能记录对应里程碑 `未开始`/`未验证`，不能把阶段状态改为已完成。容器引擎已就绪，`Blocked — 缺少本地容器引擎` 不再适用。
