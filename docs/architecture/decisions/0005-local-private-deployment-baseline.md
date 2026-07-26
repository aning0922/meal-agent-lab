# ADR-0005：本地与私有测试部署基线

- 状态：Proposed
- 日期：2026-07-26
- 负责人：产品负责人、基础设施、安全
- 实施计划：[阶段 09A：本地可部署性与私有测试基线](../../plans/2026-07-stage-09a-local-deployability-baseline.md)

## 背景

阶段 08 已完成本地 API、PostgreSQL 和微信小程序纵切，但仓库没有可重复部署包。当前没有云服务器、真实微信 AppID/AppSecret、合法 HTTPS 域名或外部测试条件。首批用户主要在深圳，云厂商没有既有偏好。

现有实现已经具备：

- Node.js 24 + Fastify 模块化单体；
- PostgreSQL 18、SQL migration checksum、RLS 和受控数据库函数；
- `/healthz`、`/readyz` 与 graceful shutdown；
- production 配置拒绝 fake WeChat adapter；
- 日志递归脱敏和合成测试数据边界。

但直接把当前本地进程放到服务器上存在不可接受的缺口：

- 没有 Dockerfile、Compose、网络发布约束或容器运行证据；
- API 与 migration 尚未以真实的不同数据库登录账号验证；
- `0000_stage_06.sql` 会创建角色并设置 `BYPASSRLS`，空库初始化不能伪装成普通最小权限 migration；
- fake adapter 会为任意调用者创建内部身份，只禁止 `NODE_ENV=production + fake` 不能证明服务没有公网入口；
- 没有备份恢复、迁移等待超时、容器退出或镜像 Secret 证据。

## 决策

### 1. 先建立单机、私有、可迁移的部署包

阶段 09A 使用标准 Dockerfile 和 Docker Compose v2 建立本地部署基线：

```text
loopback client
  → 127.0.0.1 published API
      → private Compose network
          → PostgreSQL 18
```

- API 只发布到 host loopback；
- PostgreSQL 不发布 host port；
- 不引入 Kubernetes、服务网格、Redis、消息队列、向量数据库或第二事实库；
- Compose 是可重复交付与私有测试载体，不是生产拓扑声明；
- 镜像、数据库和备份格式保持标准，后续可迁移到腾讯云、阿里云或其他平台。

腾讯云广州只是阶段 09B 的默认评估候选。阶段 09A 不创建云账号资源，也不把候选写成已选择供应商。

### 2. 数据库采用两阶段权限模型

数据库登录身份与数据库内 NOLOGIN 角色分离：

0. **cluster role baseline**：连接 maintenance/control 数据库（默认 `postgres`）
   建立并规范化六个 cluster 角色、role config、membership 与 SCRAM 口令。它
   **不要求目标数据库存在**，也不修改目标数据库 ACL，因此新安装与恢复共用同一
   阶段：恢复路径为 cluster baseline → `createdb --owner=meal_agent_migrator`
   → `pg_restore` → 目标数据库 ACL 基线，**不**执行 `0000`，也**不**执行 owner
   handoff。目标数据库的 ACL、schema 权限、owner 交接和对象权限属于独立的
   database scope 阶段。

1. **bootstrap/admin**：只在空实例初始化或全库恢复前出现。由于冻结的 `0000` 包含角色创建和 `BYPASSRLS` 设置，新安装路径由 bootstrap/admin 执行 `0000`，再把目标 database owner 设为 `meal_agent_migrator`，保证 `public` schema 的 owner/grantor 权限足以执行后续 `CREATE`/`REVOKE`，并把 `drizzle` schema 和 migration ledger 所有权交给该角色，最后建立后续登录角色；它是如实记录的 cluster-admin 边界。恢复路径预建 dump 引用的固定 NOLOGIN roles、登录角色，并直接创建由 `meal_agent_migrator` 拥有的空数据库，不先执行会与 dump 冲突的业务 migration。
2. **migration login**：自身是非 superuser、`NOINHERIT`，但可显式 `SET ROLE meal_agent_migrator` 执行 `0001` 及以后 migration。`meal_agent_migrator` 是 database owner、具有 DDL 和 `BYPASSRLS` 的高权限数据库角色；因此 migration job 仍属于敏感高权限操作，只是没有 cluster superuser/角色管理权限。它不得进入 API container，advisory lock 必须有有界等待。
3. **runtime login**：非 superuser、`NOINHERIT`、无 `CREATEDB`、无 `CREATEROLE`、无 `BYPASSRLS`，只能显式 `SET ROLE meal_agent_app`；不得设置或继承 `meal_agent_migrator`。
4. **backup login**：自身 `NOINHERIT`，只允许进入一个无写权限但具有 `BYPASSRLS`/全库读取能力的专用备份角色，以便完整导出 FORCE RLS 下的多个家庭。它是敏感数据导出权限，不得被描述为普通家庭只读账号。
5. **restore operator**：恢复使用显式高权限 operator。backup/restore 身份都不是 API runtime 身份。

不得改写已冻结的 `0000`—`0004`。阶段 09A 通过 bootstrap orchestration 和 migration runner 边界兼容既有 migration；如果数据库对象确需变化，只追加新 migration。

API readiness 必须在与真实 runtime 相同的权限边界下检查数据库和 migration ledger，不能依赖测试时期的超级用户连接偶然通过。

### 3. fake 登录需要配置与网络双重防线

- local/private Compose 明确使用 fake adapter 和合成身份；
- 配置独立表达部署暴露级别，不能只依赖 `NODE_ENV`；public、staging 或 production 暴露级别必须拒绝 fake；
- Compose API host publish 必须精确为 IPv4 loopback，并验证没有 IPv6 或其他 host listener；
- 从宿主非 loopback 地址访问必须失败；
- PostgreSQL 不得发布端口；
- `HOST=0.0.0.0` 只表示容器内部监听，不能作为允许公网的依据；
- fake 模式发现非空 AppID/AppSecret 时启动失败，避免真实 Secret 被无意义加载。

真实 code2Session 配置在使用真实 Secret 前必须限制为微信官方 HTTPS origin/path。测试替身只能在没有真实 Secret 的自动化环境使用。

### 4. Secret、日志与镜像边界

- Compose 中的 bootstrap、migration、runtime、backup 和 restore 数据库凭据全部通过未跟踪、权限受限的 secret file 注入，不作为 environment value 出现在 `docker inspect`；非 Compose 运行才允许通过进程环境注入；
- API 与 migration 配置支持 `_FILE` 形式读取数据库凭据；环境变量与文件形式互斥，缺失或同时提供时 fail closed。备份恢复使用权限受限的 password/connection file，不把完整连接串放入命令行或环境；
- API image 只包含 API、共享 contracts、生产运行依赖和 SQL migration，不包含客户端/Taro 构建依赖；
- 日志脱敏覆盖 database URL、connection string、password、DSN、token、微信 Secret 和既有隐私字段；
- 镜像、运行日志、解析后的 Compose 配置和 tracked files 均执行 sentinel/Secret 扫描；
- 私有和认证响应使用 `Cache-Control: no-store`，响应增加 `X-Content-Type-Options: nosniff`，不启用 wildcard CORS。

### 5. 运行、迁移和恢复均需有界

- migration advisory lock、数据库连接和容器启动必须有超时；
- SIGTERM 后服务在规定时间内退出，超时必须真正终止进程，而不只设置 `process.exitCode`；
- Compose 日志设置本地轮转上限；
- 备份使用 PostgreSQL custom format 并生成 SHA-256；
- 恢复到全新 PostgreSQL 18 volume 时，先以 bootstrap/admin 建立 dump 依赖的 cluster roles、登录角色，并创建 owner 为 `meal_agent_migrator` 的空数据库，不预建业务 schema；restore operator 以受控高权限连接恢复但不得改变目标 database owner。校验备份 SHA-256 后才允许单事务恢复，再由 migration login 应用备份之后新增的 migration，并验证 database/schema/table/function owner、`SECURITY DEFINER` owner、GRANT、RLS、migration checksum、readiness、跨家庭合成数据和 runtime 隔离；
- 阶段 09A 只记录演练耗时，不声明生产 RPO/RTO。

## 备选方案

### 直接购买云服务器后手工部署

当前没有公网登录条件或外部测试需求，手工部署会在缺少可重复构建、安全账号和恢复证据时提前引入公网与运维风险，因此不采用。

### 本机直接运行 Node.js 与 PostgreSQL

现有门禁继续保留这种快速开发路径，但它不能证明镜像内容、容器网络、账号注入或异机可重复性，不能作为阶段 09A 的唯一交付方式。

### 立即使用托管 PostgreSQL

托管数据库能提供备份、监控和恢复能力，但当前没有云账号或持续远程测试需求。先验证标准 PostgreSQL 18 部署与恢复包，阶段 09B 再比较托管产品。

### Kubernetes 或微服务

当前只有一个 API 部署单元，没有独立扩缩容和故障隔离证据。引入编排集群只会增加密钥、网络和运维面，不采用。

## 影响

### 收益

- 在购买服务器前获得可重复构建、启动、迁移和恢复证据；
- API runtime 与高权限数据库操作真实隔离；
- fake adapter 即使在容器内监听所有接口，也没有 host 公网入口；
- 后续私有测试服务器可以复用相同镜像和 Compose 边界；
- 不绑定云厂商，保留标准容器与 PostgreSQL 的迁移能力。

### 成本和限制

- 总控机器必须先安装兼容 Docker Compose v2 的容器引擎才能完成最终验收；
- 既有 `0000` 导致空库 bootstrap 仍有一个显式高权限步骤；
- 单机 Compose 不提供生产高可用、正式 Secret 服务、WAF 或生产监控；
- fake 登录环境只能用于合成数据和内部验证；
- 当前依赖审计例外截至 2026-08-08 且阻断 external-test，阶段 09B 不能借本 ADR 绕过该限制。

## 验证与接受条件

本 ADR 在以下证据全部通过后由 `Proposed` 改为 `Accepted`：

1. 阶段 09A 完整门禁从干净 checkout 通过；
2. bootstrap、migration 和 runtime 权限反向测试通过；
3. IPv4/IPv6 监听、非 loopback 访问和数据库无端口检查通过；
4. API image、日志、Compose 配置和 tracked files Secret 扫描通过；
5. 停止重启、SIGTERM、migration 超时、备份 checksum 与全新 volume 恢复通过；
6. `pnpm stage08:check` 保持通过；
7. 文档没有把本地证据写成云、真实微信、外部测试或生产 Pass。

以下条件触发复审：

- 购买或创建远程测试环境；
- 引入真实 AppID/AppSecret、合法域名或公网入口；
- 迁移到托管 PostgreSQL；
- 增加第二个部署服务或后台 worker；
- 需要多机高可用、正式 RPO/RTO 或生产发布。
