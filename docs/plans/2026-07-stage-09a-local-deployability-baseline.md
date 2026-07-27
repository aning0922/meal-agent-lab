# 阶段 09A：本地可部署性与私有测试基线

- 日期：2026-07-26（2026-07-27 更新实施状态）
- 状态：In Progress（M1 Accepted；M2A 的 R8A 只读 projector 已由总控 Accepted，验收落点 `ca65275`；R8B In Progress；M2A 整体仍为 In Progress；M2B—M5 未开始，且在 M2A 通过验收前禁止进入）
- 计划分支：`claude/stage-09a-api-container-baseline-9f286c`（PR #1，保持 Draft）；R8B 实施分支 `claude/stage-09a-m2a-r8b`，基线 `ca65275`
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
- （规划时的事实）`infra/docker/` 与 `infra/environments/` 为空骨架。**现状**：M1 已交付 `services/api/Dockerfile` 与根 `.dockerignore`；M2A 已交付 `infra/docker/postgres/` 的 bootstrap 与**四个** generated adapter（对象 manifest、授权收敛、授权断言，以及 R8A 新增的**只读**授权投影——投影尚未被任何 bootstrap 阶段加载）。仍然缺席的是 Compose 拓扑、`infra/environments/` 配置模板、容器 smoke test、备份恢复脚本与部署运行手册。
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
13. `meal_agent_private`：`PUBLIC` 无 `USAGE`/`CREATE`；app 只有所需 `USAGE`、无 `CREATE`；backup 与三个 login 无有效访问；按真实 grantor 收敛；缺失任一 managed schema 时在任何 mutation 之前失败。恢复路径上 `drizzle` 出现未知 routine 或 `SECURITY DEFINER` 必须 fail closed，`PUBLIC` 派生的 `EXECUTE` 必须纳入 app/backup 的**有效**权限验证。Large Object 同时处理 `pg_largeobject_metadata.lomacl` 与 `pg_default_acl` 的 `defaclobjtype='L'`：当前产品不使用 LO，因此采用「存在项目角色 LO 权限或异常默认权限即收敛并断言为空」，不借此扩展业务能力。数据库级 `PUBLIC` 的跨 grantor ACL 必须**真正收敛**，不能只在后置校验失败后整体回滚。

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
    - **R8B（In Progress）**才把 projector 接入 verify/converge、去掉
      `watchedGrantees` 静态名单，并**落实**（不是再裁定）下面第 15 条已决定的
      类型与 Large Object 策略。正确结构是「PostgreSQL catalog → 共享结构化
      projector CTE → 公开只读 projection adapter / verify 的可移植策略匹配器 /
      converge 的可移植策略匹配器」：**共享的是事实采集，不是把动态投影冻结成
      跨环境快照**。R8B 还必须**统一替换**
      `authorization-manifest-sql.ts` 的 `currentDefaultCte`，它有三个互相独立的
      错误：`COALESCE(schema, global, builtin)` 三选一冒充叠加语义、把「空 global
      行」与「没有这一行」混为一谈、把 `pg_default_acl.defaclobjtype` 直接喂给
      `acldefault`（sequence 的 `S` 被当成 FOREIGN SERVER）。该 CTE **同时被
      converge 与 verify 两个块引用**，因此这三条同时影响收敛与断言；替换后必须
      重新生成并复验 `authorization-converge.generated.sql` 与
      `authorization-verify.generated.sql`。R8B **不得**把动态投影冻结成跨 cluster
      的固定快照：`role` 行是覆盖面证据而非允许角色白名单，外部角色按策略匹配，
      任意 LO 对象按政策判为异常且只报告不删数据，LO 的 OID 不进入固定允许
      manifest。
    - 「ACL 全主体覆盖」的准确含义：**normalized raw ACL** 在受监管对象类别内
      动态枚举全部 grantee 与 grantor；**effective** 只覆盖 `PUBLIC`、项目角色与
      目标库内全部非 superuser LOGIN，不是对集群所有角色的枚举。
15. 类型与 Large Object 的策略**已决定**（R8A 只报告，R8B 负责落实，不再裁定）：managed 非数组类型由
    owner/`meal_agent_migrator` 保留必要 `USAGE`，`PUBLIC`、app、backup 与三个
    login 默认无 `USAGE`；数组类型只记录向元素类型的委托，不建立也不撤销独立
    ACL（PostgreSQL 直接拒绝对数组类型授权与改属）；产品禁用 Large Object，创建/
    读写入口、项目角色权限与异常 default ACL 必须关闭。

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

`pnpm stage09a:check` **尚未创建**（属于 M5）。在它存在之前，本阶段的本地证据由
`pnpm stage08:check` 与上面两条命令给出，不得把 `stage08:check` 通过表述为阶段
09A 通过。

Compose 运行未完成或备份恢复未验证时，只能记录对应里程碑 `未开始`/`未验证`，不能把阶段状态改为已完成。容器引擎已就绪，`Blocked — 缺少本地容器引擎` 不再适用。
