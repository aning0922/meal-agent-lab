# 阶段 09A：本地可部署性与私有测试基线

- 日期：2026-07-26（2026-07-29 更新实施状态）
- 状态：In Progress（M1 Accepted；M2A 的 R8A 只读 projector 已由总控 Accepted，验收落点 `ca65275`；R8B 已由总控 Accepted；**M2A 整体已由总控 Accepted，验收落点 `5e480803`**；**M2B 已由总控 Accepted，验收落点 `d0f2219`**；**M3A「配置与 Secret file 消费核心」implementation complete, pending total-control review**；M3B、M4、M5 未开始）
- 计划分支：`claude/stage-09a-api-container-baseline-9f286c`（PR #1，保持 Draft）；R8B 实施分支 `claude/stage-09a-m2a-r8b`，基线 `ca65275`，验收落点 `5e480803`；M2B 实施分支 `claude/stage-09a-m2b-compose-topology`（本地 worktree 的分支名带工具生成后缀 `-e463dc`，目录名沿用更早的 `stage-07-…`），基线 `0ca4ca2`；M3A 实施分支 `claude/stage-09a-m3-config-secret-consumption`，基线 `8c99c46`
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
但 `0000 → handoff → acl → migrate → grants` 的完整链路、备份恢复与阶段总门禁
**仍未取得运行证据**，属于 M3B 与 M4。备份/恢复服务属于 M4，本轮不在 Compose
中声明。

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

### M3A 实施记录（实现完成，待总控复核）

M3 被拆成 **M3A（配置与 Secret file 消费核心）**与 **M3B（环境模板、八份 Secret 的
生成与交叉一致性、完整 Compose bootstrap 链实证）**两轮。M3A 覆盖上面第 2、3、6、
7、8、9 条的**代码侧**，状态是 **implementation complete, pending total-control
review**——**不是 Accepted**。

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

**M3A 仍为 implementation complete, pending total-control review，未标记 Accepted。**

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

M3A **不覆盖**，属于 **M3B**：`infra/environments/` 的完整 local-test 模板
（第 1 条）、八份 Secret 的生成/派生/交叉一致性预检、database name 与三个
URL/pgpass 的部署级一致性、完整 Compose bootstrap 链
（`0000 → handoff → acl → migrate → grants`）与 `/readyz=200` 实证、
`config`/`inspect`/`history`/`logs` 的容器级 sentinel 扫描，以及宿主全部非
loopback 地址的动态隔离证明（第 5 条）。**M4、M5 未开始。**

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

`pnpm stage09a:check` **尚未创建**（属于 M5）。在它存在之前，本阶段的本地证据由
`pnpm stage08:check` 与上面三条命令给出，不得把 `stage08:check` 通过表述为阶段
09A 通过，也不得把 M2B 的静态断言与 postgres 单服务启动表述为全栈通过。

Compose 运行未完成或备份恢复未验证时，只能记录对应里程碑 `未开始`/`未验证`，不能把阶段状态改为已完成。容器引擎已就绪，`Blocked — 缺少本地容器引擎` 不再适用。
