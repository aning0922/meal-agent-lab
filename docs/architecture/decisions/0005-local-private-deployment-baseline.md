# ADR-0005：本地与私有测试部署基线

- 状态：Accepted
- 日期：2026-07-26（**2026-08-11 由 `Proposed` 转 `Accepted`**：M4「生命周期、备份和恢复」已 Accepted（验收落点 `f671c51`），M5 交付 `pnpm stage09a:check` 聚合门禁并取得本地完整证据——主工作树与干净 checkout 各一次全绿，满足下方「验证与接受条件」全部七项；09A 总验收与远端 CI 真实 run 仍未完成，见文末注记）
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

#### 2.1 冻结 `0000` 的安全 manifest 只有一个事实源

migration runner 与 bootstrap 的 owner handoff 都需要回答同一个问题：「这个库
是不是恰好处于冻结 `0000` 应用之后的状态」。两边各写一份手写对象清单会独立
漂移，而且只能回答「对象在不在」，回答不了 RLS、policy、`proconfig`、约束定义
这些真正决定安全边界的问题。

因此：typed readonly manifest 是唯一事实源，确定性 renderer 把它渲染成纯 SQL；
`migrate.ts` 直接执行内存渲染结果，bootstrap 的 `01-owner-handoff.sql` 在
mutation 之前、事务之内用相对路径 `\ir` 加载 generated 出的同一段文本。渲染结果
只读——不匹配时 `RAISE EXCEPTION`，不做任何 ownership/ACL/DDL 变更。

adapter 必须**提前生成**而不能现场渲染，理由是执行环境：PostgreSQL 服务器进程
不执行 Node；`bootstrap.sh` 的 SQL 阶段只调用 `psql`（只有 `logins` 阶段在缺少
`setsid` 时会用仓库内的 `no-ctty.mjs` 包装器，那是一个 Node 标准库脚本），而
`db:bootstrap` / `db:migrate` 本身就是 Node 入口。因此 Node 只在开发机/CI 上生成
adapter，运行时链路上没有任何一步依赖它现场渲染。

一致性由三道互相独立的锁保证，缺一不可：

1. **TS ↔ generated SQL**：只读 `manifest:check` 逐字节比对，不自动改写文件；
   generated 文件带 do-not-edit 标记、版本与 canonical digest，不含时间戳、
   绝对路径、locale 或随机值。
2. **manifest ↔ 真实 catalog**：在真实 PostgreSQL 18 上干净执行冻结 `0000` 之后，
   catalog 的规范化安全投影必须与 TypeScript manifest 逐行相同（owner handoff
   前后各一次）。只证明第 1 条是不够的——两份自洽的错误仍然是错误。
3. **两个入口一致**：同一批漂移在 `db:bootstrap` 与 `bootstrap.sh handoff` 上
   给出逐字相同的拒绝理由。

manifest 覆盖：database 与 schema 的存在性与归属、「没有多余 schema」、relation 的
relkind/owner/persistence/`relrowsecurity`/`relforcerowsecurity`、**每一列**的序号
/类型/NOT NULL/默认值/identity/generated/存储与排序规则、index 与 constraint 的
规范化定义、routine 的 identity args/prokind/owner/`prosecdef`/language/
`proconfig`/正文摘要、policy 的 command/roles/permissive/`USING`/`WITH CHECK`、
**managed schema 内的用户 type**（当前 10 条全部是每张表的数组类型，**不含行
类型**：投影排除 `typrelid` 指向真实 relation 的行类型，而 `0000` 没有建 shell /
base / enum / domain）、trigger 与**外键背后的内部 constraint
trigger 启用状态**（`ALTER TABLE … DISABLE TRIGGER ALL` 会让外键静默失效，而表
结构、约束定义与 RLS 全都看不出变化）、rule，以及 operator / opclass / opfamily /
collation / conversion / 扩展统计 / 文本搜索四件套 / extension 这些明确枚举的
namespace 类别，并强制唯一键、固定排序与重复 identity 拒绝。

owner handoff 的阶段由**整组 owner** 判定，而不是 database owner 单字段：
database、`public`/`drizzle` schema、drizzle ledger 及其数组类型要么整组尚未交接，
要么整组属于 `meal_agent_migrator`。任何混合态直接拒绝——单字段判据会被一次局部
改动整体带偏。

规范化投影在事务内固定 `search_path` 与 `quote_all_identifiers` 并在块结束时
**显式还原**：`set_config(..., true)` 只在**事务**结束时恢复，而这些块是在
`BEGIN…COMMIT` 里被 `\ir` 进来的，不还原就会让同一事务的后续语句继承被改过的
GUC。

对象 catalog 基线实际绑定 **PostgreSQL 18.4**，且判据是 exact-patch 的，并覆盖
整套工具链：`createdb`、`initdb`、`pg_ctl`、`postgres`、`psql` 逐个按标准 banner 的
主版本字段锚定解析，五个都必须是 18.4；混装（例如只有 server 是 18.4）与 `18.3`
一律拒绝，并有自动化测试。M2B 已按此要求**解析真实镜像仓库**固定 18.4 的 exact
image digest：`docker.io/library/postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296`，
由 `docker buildx imagetools inspect` 取得的 OCI image index 摘要，内含
`linux/amd64` 与 `linux/arm64/v8`，容器内五个工具的 banner 均为 18.4。它不是猜测、
搜索结果或本地未推送镜像的 RepoDigest。patch 升级必须重新 capture manifest、重跑
parity 并显式 rebaseline，不能只改 tag 或 digest。

#### 2.2 授权状态由第二个 ledger 感知 manifest 描述

对象 manifest 只描述冻结 `0000` 之后的**结构**，回答不了「0001—0004 应用之后 app
应该有哪些表权限」。因此授权另立一个 manifest，按 `(ledger, phase)` 精确描述
`PUBLIC` / app / backup / 三个 login 的 catalog ACL、`pg_default_acl` 的**有效**
默认权限、`has_*_privilege` 的**有效**权限，以及受控 routine 的
identity/owner/`SECURITY DEFINER`/`proconfig`/正文摘要与允许的 `EXECUTE` 授权。
未登记的 `(ledger, phase)` 一律 fail closed。

阶段分成两段，对应恢复/安装流程的两个真实时刻：

- **containment**（`02-acl-baseline.sql`）：migration 之前 / `pg_restore` 之后
  立即收敛。此刻刻意**不**给备份角色任何表级 `SELECT`——migration 期间没有理由
  存在一份可读全库的授权。
- **final**（`03-backup-grants.sql`）：migration 之后建立最终 ACL，并且**同时**
  验证 `PUBLIC`、app、backup 与三个 login，而不是只看备份角色。

两个阶段都执行同一段生成的收敛块：按真实 grantor 撤销一切不在 manifest 内的授权
（含 grant option 与列级授权），再只重建 manifest 允许的项，最后由只读断言块同时
比对 catalog ACL 与 `has_*_privilege` 有效权限。

#### 2.2.1 授权状态的观察层与收敛层分开（R8A / R8B）

收敛正确的前提是**先能把权限状态完整、确定地看见**。因此 R8A 只交付一个 canonical
projector：`authorization-projection-sql.ts` 渲染出的**单条只读 SELECT**（第四个
generated adapter），不含任何 mutation，也**尚未接入** `02-acl-baseline.sql` /
`03-backup-grants.sql`。R8A 已由项目总控 **Accepted**（验收落点 `ca65275`）。
R8B（总控 **Accepted**）把它接入了 verify/converge，结构是「PostgreSQL
catalog → 共享结构化 projector CTE → 公开只读 projection adapter / verify 的可移植
策略匹配器 / converge 的可移植策略匹配器」：**共享的是事实采集**，不是把动态投影
冻结成跨环境快照。`watchedGrantees` 静态名单已删除，收敛与断言按完整元组
（object + grantee + grantor + privilege + grantable）判定，固定允许授权的 canonical
grantor 恒为 `meal_agent_migrator`。M2A 整体已由总控 **Accepted**（验收落点
`5e480803`）；**M2B（Compose 拓扑）也已由总控 Accepted，验收落点 `d0f2219`**。
**M3A（配置与 Secret file 消费核心）已由项目总控 Accepted，验收落点 `a839df1`**：§3 的部署暴露级别、fake 边界与官方 endpoint 收紧，以及
§4 的 `_FILE` 互斥注入、日志脱敏与响应头都已落地并有反向测试（见
[§4 的实施注记](#4-secret日志与镜像边界)）。**M3B（环境模板、八份 Secret、
完整 bootstrap 链、`/readyz=200` 与网络隔离实证）已于 2026-08-11 Accepted，验收落点 `cf43452`**（见 §4 的 M3B 注记）。**M4（生命周期、备份和恢复）
已于 2026-08-11 Accepted（验收落点 `f671c51`），M5 交付了 `pnpm stage09a:check`
聚合门禁与 API runtime image 扫描并取得本地完整证据**，本 ADR 据此转
`Accepted`；09A 总验收与远端 CI 真实 run 仍未完成。

投影的五类事实各自独立定义，不得混用：**规范化的直接授权语义**（`NULL` ACL 按
PostgreSQL 语义展开为隐式内建默认，因此它不是「物理 ACL 行」）、
**`pg_default_acl` 的物理行存在性**（空 ACL 展开为零行，与「没有这一行」无法区分，
所以存在性只能由这一层承载）、**`has_*_privilege` 有效权限**、**归属**，以及
**role coverage**（参与探测的角色集合，是覆盖面证据，**不是允许角色白名单**）。

PostgreSQL 18.4 实测确定并已固化为测试的语义：非空 global `pg_default_acl` 行
**替换**内建默认；空行等价于没有行；`pg_default_acl.defaclobjtype` 与
`acldefault()` 是两套 objtype 编码——sequence 分别是 `S` 与 `s`，而
`acldefault('S', …)` 是 FOREIGN SERVER，直接混用会把 sequence 的内建默认**低报**
成只剩 `USAGE`。另外 `acldefault('l', …)` 对受信与非受信语言完全相同，非受信语言
的限制在建函数时按 superuser 判定，不体现在 ACL 上。

「ACL 全主体覆盖」限定为两件互不等同的事：**normalized raw ACL** 在受监管对象类别
内动态枚举**全部 grantee 与 grantor**；**effective** 只覆盖 `PUBLIC`、项目角色与
目标库内**全部非 superuser LOGIN**，不是对集群所有角色的枚举。

**R8B 已统一替换的缺陷**：旧 `authorization-manifest-sql.ts` 的
`currentDefaultCte` 有三个互相独立的错误——`COALESCE(schema, global, builtin)` 三选一
冒充叠加语义、把「空 global 行」与「没有这一行」混为一谈、把
`pg_default_acl.defaclobjtype` 直接喂给 `acldefault`（sequence 的 `S` 被当成 FOREIGN
SERVER）。它**同时被 converge 与 verify 两个块引用**，因此这三条同时影响 containment
与 final 两个阶段的**收敛**与**断言**，不是只有断言受影响。R8B 已一次性替换，并
重新生成、在真实 PostgreSQL 18.4 上复验了两个 generated adapter。另有一条只有收敛
侧才会暴露的语义同时补上：`ALTER DEFAULT PRIVILEGES` 的**起算点**是 global 从内建
`acldefault` 起算、schema 从空起算，因此「内容是内建默认真子集」的 global 行只能靠
**撤销**得到——只补授缺失项时结果恰好等于内建默认，PostgreSQL 会直接把行删掉。

边界仍然成立：投影结果**必然反映当前环境**（动态 LOGIN 角色、`pg_default_acl` 里
出现过的 owner、Large Object 的 OID），因此整份投影**没有**被冻结成跨 cluster 的固定
快照。只有 database identity 是可移植的逻辑键；外部角色一律用策略匹配。类型与
Large Object 的策略见 §2.3，**已决定**，R8B 已落实。

#### 2.3 私有 schema、恢复路径与 Large Object

- `meal_agent_private` 是受控 `SECURITY DEFINER` 函数所在的 schema：`PUBLIC` 无
  `USAGE`/`CREATE`，app 只有 `USAGE`（因此不能在其中建对象），backup 与三个
  login 没有任何有效访问。缺失任一 managed schema 时，ACL 基线在任何 mutation
  之前失败。
- 恢复路径的对象全部来自 dump：`drizzle` 中出现任何 routine（尤其
  `SECURITY DEFINER`）必须 fail closed；routine 权限按**有效权限**验证，把
  `GRANT EXECUTE ... TO PUBLIC` 派生给 app/backup 的那一份也算在内。
- **managed 非数组类型**：owner（`meal_agent_migrator`）保留必要 `USAGE`；
  `PUBLIC`、app、backup 与三个 login 无 `USAGE`。R8B 把这一条同时落在两层：
  对象 ACL 由收敛保证，`T@global` 的 `pg_default_acl` 物理行去掉 `PUBLIC` 的内建
  `TYPES USAGE`，因此新建 enum / domain / composite **出生即干净**。
- **language**：PostgreSQL 内建的 owner 与 `PUBLIC USAGE` 是**必需项**——owner 从
  catalog 动态取得，缺失时 verify 拒绝、converge 以 language owner 的身份恢复。
- **数组类型**只记录「向元素类型委托」，既不建立也不撤销独立 ACL：PostgreSQL 对
  数组类型直接拒绝授权与改属（`cannot set privileges of array types`）。
- Large Object 不受 schema ACL 与 RLS 约束，当前产品不使用它。R8B 起的口径是
  **先判定、后收敛**，两句都不可省略：
  1. 只要目标库里存在**任意** LO 对象（不限于项目角色拥有的），两个阶段都在
     **任何 ACL / default ACL mutation 之前** fail closed，且**绝不**修改
     `lomowner` / `lomacl` / LO 数据，也**绝不**解除链接——只报告 OID 与 owner，
     OID 不进入任何固定允许 manifest；
  2. 只有在**确实一个 LO 都没有**时，收敛才处理 `pg_default_acl` 中
     `defaclobjtype = 'L'` 的异常默认权限与 20 个入口点上多余的 `EXECUTE`。
  「存在 LO 权限就地收敛」是 R8A 之前的旧口径，已经作废——它会在收敛过程中改写
  一份来历不明的数据的权限。**并且**：既然产品
  声明禁用 LO，就必须同时关闭 `pg_catalog` 的创建/读写入口（`lo_create`、
  `lo_creat`、`lo_from_bytea`、`lo_put`、`lo_import` 等 20 个函数默认对 `PUBLIC`
  开放 `EXECUTE`）——只封堵已有 LO 的对象权限，等于允许 runtime 自己造一个新的
  不受约束的存储面。
- 数据库级与 schema 级的 `PUBLIC` 授权可能来自任意第三方 grantor。普通 `REVOKE`
  只撤销「由执行者授予」的那一份，因此必须按真实 grantor 逐条撤销——**真正收敛**，
  而不是等后置校验失败后整体回滚：回滚只让命令失败，权限仍然留在数据库里。

#### 2.3.1 exact-ledger 不因默认权限而放宽

`pg_default_acl` 只保护**创建窗口**：它决定新对象出生时带什么权限，**不代表**那个
对象已经被授权 manifest 登记。因此任何新增 migration 一旦创建 relation 或
sequence，都必须同时**新增一个 ledger 状态**并在其中登记该对象的固定授权——否则新
对象会以「未登记对象」的身份进入策略判定，收敛会把默认权限带来的授权当作漂移
撤掉。默认权限与 exact-ledger 是互补的两层，不能互相顶替。

#### 2.4 恢复契约与受支持的 ledger 窗口

当前**没有任何历史部署**，因此也不存在需要兼容的历史 dump。据此明确：

- 首个受支持的 backup ledger 是 **`0000—0004`**。`0001`—`0003` 的中间态 dump
  从未被产出过，也不声称受支持。
- **本阶段（M4）验证的是同一 ledger 的 round-trip**：`0000—0004` 备份 →
  恢复 → 仍是 `0000—0004`。此刻不存在第二个 ledger，跨-ledger 演练无从谈起。
- **跨-ledger 门禁在首次出现 `0005` 时启用**：那一刻起，恢复演练必须覆盖
  `cluster` → `createdb --owner=meal_agent_migrator` → `pg_restore`（`0000—0004`）
  → containment → `db:migrate`（补齐到当前 ledger）→ final → 验证。
- 支持窗口**至少覆盖上一个已发布 ledger（N-1）**：每新增一个 migration，都必须
  为窗口内的旧 ledger 保留对应的 containment manifest 状态。删除旧状态等于宣布
  该窗口的 dump 不再可恢复，属于需要显式决策的破坏性变更。

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

**M3A 实施注记**（**已由项目总控 Accepted，验收落点 `a839df1`**；只覆盖代码侧消费能力，**不是**阶段完成证据）：`_FILE` 互斥注入由 `services/api/src/config-source.ts`（API、
`db:migrate`、`db:bootstrap` 三个入口共用）与 `infra/docker/postgres/secret-source.sh`
（三对 `MEAL_AGENT_*_PASSWORD`）实现，两侧的互斥语义与内容判据**按条对齐**
（不是逐字节等价的同一实现，机制差异见 `infra/docker/postgres/README.md`）：绝对路径、
非 symlink、普通文件、单链接、属主为当前 EUID、只允许 owner-only 的 `0400` 或
`0600`、≤4096 字节、非空、
合法 UTF-8、无 NUL/BOM/CR、单行、最多一个末尾 LF 且不 trim；两个来源同时出现
（含内容相同）一律拒绝，选中来源失败时不回落。shell 侧三份口令全部在任何 psql
调用之前解析，任一不合格时 psql 调用次数实测为 0；该读取是**有界**的（无写端
FIFO 会让 shell 的 open() 永久阻塞，因此 open+校验+复制跑在 5 秒有界的子进程里）。
连接串另有专用校验：五个核心字段必须显式来自 URL，且连接串无法覆盖的那一批
、URL 无法覆盖的那 8 个 ambient `PG*` 变量逐条拒绝（五个核心字段对应的 `PG*`
不在其中，URL 已经决定了它们）。业务日志走 `src/log-events.ts` 的窄化 typed
facade（闭集事件 + 固定 runtime projector + 专用安全字段类型，原始
Error/Request/Reply/Config/Secret 在类型上进不来），并由基于 TypeScript type
checker 的静态门禁限制整项 logger capability（按**声明身份**判定，`LogFn` 只允许
出现在边界文件里，mutation API 只有 `logging.ts` 可碰，组装根只有三个精确上下文
可以命名 logger；能力被装进容器、mapped/indexed type、接口重声明或解构里带出去
同样命中；「组装根持有的容器」只认 `createLoggingContext` 与 fastify 自己那两个
**工厂的声明身份**，不是「initializer 恰好是一个调用」；工厂符号本身也计入能力，
只允许在组装根那一次合法工厂调用的 callee 位置出现，`logging.ts` 的 root 工厂更严、
边界之外一处都不许出现；形参没有通行证，只能作为成员访问的基出现，工厂注入槽还要求
那个基是组装根自己的 options 对象）——该门禁是工程护栏，不是形式化安全证明；中央 logger 边界（含 child()/setBindings() 与子 logger options
的安全包装）保留为**纵深防御**，覆盖 Fastify 自己打的请求日志。event logger 的
raw `Logger` 只存在于模块词法作用域，`app.eventLog` 不可写不可重定义；日志关机在
**受信、合作式接口**前提下对**异步拖延**与**有限的同步阻塞** **fail closed 且
failure-safe**：close 是一个阶段收集器，每个适用阶段
（event flush、自建时的 framework flush 与 drain、event drain）都会跑到，一个阶段
失败不跳过后面的阶段，最后聚合成 `AggregateError` 让 `app.close()` 失败；失败原因
只由固定文本与归一化错误类型名拼成，取类型名这一步本身也兜了底（敌意的自指 Proxy
会让归一化再抛一次）；`flush()` 在回调之后同步 throw 同样算失败。时限只对**异步**
拖延有效——同一个 JS 线程无法抢占不返回的同步调用，因此调用方的 `Writable`/`flush`
被定义为**受信的合作式接口**，只保证**有限**的同步阻塞会 fail closed（同步调用返回
后用 `performance.now()` 重新量一次）。进程级关机契约在 `src/shutdown.ts`，两条失败
路径有 subprocess 回归。自建的 logger 才 flush，调用方注入的 logger
不碰，调用方的 `Writable` 绝不 `end`/`destroy`/写入，只读 `writableLength` 等它
排空。`index.ts` 把失败落成 stderr 上固定中性文本 `shutdown: close failed` 与
非零退出码。
覆盖 database URL、connection string、password、DSN 的命名变体与按取值识别的
连接串/conninfo，口令的原值与 URL 编码形态同时消失；全部响应统一携带
`Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`，仓库内不存在任何
`Access-Control-Allow-Origin`。

**M3B 实施注记**（**已于 2026-08-11 Accepted，验收落点 `cf43452`；M3B 验收时点尚未完成 M4/M5 与 09A 总验收**；完整证据见
[阶段 09A 计划的 M3B 实施记录](../../plans/2026-07-stage-09a-local-deployability-baseline.md)）：
八份 Secret 的单一来源生成（四个原始 CSPRNG 口令派生八个固定文件，generator 与
preflight 共用 `infra/docker/local-test-secrets-contract.mjs` 一份事实源）与部署
前交叉一致性预检已落地并有 75 cases（1 个正向 baseline + 74 个反例/边界检查）、M3B targeted negative suite 的 69 cases、15 项拓扑变异反例、5 个不依赖 Docker 的确定性进程组回归与 5 个真实信号窗口的零残留取证；总控审计阻断整改已把 tracked template / 全仓 containment / Compose topology 三条生产路径的 ambient Git repository-view override 与空 canonical index、split-stem 的 nested/prose/comment 视图、空壳/截断/对象身份不符的 Docker inspect/image/history 与 resolved Compose config 证据、scoped cleanup residue/非法返回/异常及受控进程组的 mutation-closed 有界收敛统一改为 fail closed；真实 Compose Secret 在容器内实测
owner==消费进程 EUID、mode 0600、普通文件、nlink=1、非 symlink、可读（UID 999
与 10001 两侧，宿主 stat 不作数）；从空 volume 起的完整链
`cluster → logins → createdb → 0000 → handoff → acl → migrate → grants → api`
十步真实退出码全 0，migrate/grants 二次运行幂等，`/healthz=200`、`/readyz=200`，
readiness 只以 runtime login 连接；`docker compose config`、全部容器 inspect
（Config.Env/Cmd/Args/Mounts）、image inspect 与 `history --no-trunc`、全部容器
logs、tracked files 与 smoke 自身输出的 sentinel 扫描零命中；`::1` 与宿主全部非
loopback 地址逐一连接失败，postgres 无 PublishedPort，api 只有一个
`127.0.0.1` binding。停止/重启持久化与备份恢复已由 M4 取得（Accepted，验收落点
`f671c51`）；`pnpm stage09a:check` 聚合门禁与 API runtime image 扫描已由 M5
交付并取得本地全绿证据（见计划文档 M5 实施记录）。**仍未取得**：远端 CI 真实
run（仓库未推送远端，workflow 仅登记「已配置」）。

这里的深层 shape、identity 与完整性只描述 Docker inspect/image/history；resolved
Compose config helper 只验证成功状态、stdout 为字符串且非空，结构与拓扑另由专门
门禁负责。

`08da379` 的两路独立复验再次给出 **BLOCK**。Round 19 候选进一步收紧 scanner
跨视图 crossing 判据、Docker evidence 深层 shape/物化边界、空 resolved Compose
config 与进程组 mutation-closed 收敛；该候选 `c8d7236` 随后由项目总控第一阶段
只读裁定为 **BLOCK**——crossing 判据与键/`=` 之间的 gap 文法分居两条路径，
**交叉处零覆盖**（140 格全漏），另有外层 closing quote 空占位在 legacy 路径未
生效的误报。Round 20 候选闭合了这两项并新增 2 条注册 case（targeted 58 → 60），
同时把 `compoundOperatorTail` 造成的运算符尾残留单列登记。该候选 `f9997b0` 随后由
两路独立审计与项目总控**三方同指**判为 **BLOCK**，且是**新回退**：搬到 legacy
路径的空占位规则没有证明「键前面那个引号是本赋值的**开**引号」，于是上一段取值的
闭引号被当成开引号，`# psql "dbname=meal"PGPASSWORD="<值>"` 整行零 problem，净新增
280 格 fail-open 漏检。Round 21 候选抽出两条路径**共用的**开引号判据闭合它，另收窄
crossing gap 的包装标点吸收、把 gap 越界改为 fail closed，targeted 60 → 64 且四条
新 case 均经变异判别力验证；它仍须同样两路复验，
不能据此把 M3B 或本 ADR 标为 Accepted。既定 `1PASSWORDOLD2` 无分隔 scanner 边界及无 pidfd 平台的极端
OS PGID 复用 TOCTOU 仍按已知边界记录，不作形式化闭合声称。

**M3B 的 tracked 模板扫描器是尽力而为的第二层网**：Round 24 的绝对面普查（`node --env-file` 为唯一 oracle）实测主面存在**已登记的未闭合族**，分两级登记——

**（甲）由 `check-m3b-template-surface-sweep.mjs` 逐族钉死并附原因的 5 族**：大小写扩张码点（`open/case-expanding-codepoint`）、数字开头粘连词干（`open/digit-leading-glued-stem`）、结合处数字（`open/glued-stem-joint-digit`）、benign 白名单反向注入（`open/benign-allowlist-injection`）、运算符尾键（`open/operator-tail-key`）；另有两份扫描 pathspec 之外的 tracked dotenv 模板由该门禁的 pathspec 检查钉住。

**（乙）已进族/视图登记表但门禁无对应格的 4 族**：嵌套 `hashIsComment`（`unguarded/nested-hash-is-comment`）、反引号引号族（`unguarded/backtick-quote`）、URL 前缀嵌套（`unguarded/url-prefix-nesting`）、prose 角色活行（`unguarded/prose-role-live-line`）。门禁的六个视图模板**结构上表达不了**它们——0/6 含反引号、0/6 含 `://`、0/6 含「`=` 后空白再接 `#`」。**这 4 族目前没有任何门禁看守。**Round 26 已把 `expect` 的第三态 `mixed` 实现出来（登记表不再表达不了逐视图混合），但那 4 族仍然落不了格：缺的是**渲染面**而不是状态，要钉住它们必须先扩视图模板，属独立里程碑。

上面两份族名列表由 [`check-m3b-registry-integrity.mjs`](../../../infra/docker/check-m3b-registry-integrity.mjs) 与 [`m3b-surface-registry.mjs`](../../../infra/docker/m3b-surface-registry.mjs) 的 `families` / `unguardedFamilies` **机械比对**——多一个、少一个、拼错一个都转红。此前它是手抄的，于是「9 族全部已由门禁钉死」这句假话活过了一整轮审计。

**其中反引号面是本轮已披露的最大未守面**：实测一个「整行含反引号即豁免敏感判据」的回归，surface sweep、69 格 targeted、75 格 local-test **三张网全部为绿**；而真实模板里 `infra/environments/local-test/README.md` 有 22/72 行、`infra/environments/README.md` 有 3/21 行含反引号（分母是文件真实行数，由同一门禁数出来比对；此前写作 73/22 是误用了 `content.split('\n').length` 的口径——尾随换行会多出一个空元素）。

**M3B 的验收范围不得表述为「环境模板已覆盖」，也不得表述为「已登记族全部由门禁钉死」。**第一层控制（八份 Secret 从不进仓库、`.gitignore`、全仓 containment 扫描）**与键名判据零共享**（`local-test-containment.mjs` 对 `isSensitiveKeyName` / `scanTrackedTemplates` / `sensitiveKeySuffixes` / `sensitiveCompactAssignments` 的引用数为 0，needle 按真实 Secret 取值构造），未受影响；真实 tracked 模板实测 0 problem。

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

- 最终验收需要兼容 Docker Compose v2 的容器引擎；总控机器已安装 Docker Engine 29.6.2 与 Docker Compose v5.3.1（2026-07-27 核实），该前置不再阻塞；
- 既有 `0000` 导致空库 bootstrap 仍有一个显式高权限步骤；
- 单机 Compose 不提供生产高可用、正式 Secret 服务、WAF 或生产监控；
- fake 登录环境只能用于合成数据和内部验证；
- 当前依赖审计例外截至 2026-11-08（2026-08-06 显式续期、2026-08-11 M5 复核不续期，见 ADR-0004）且阻断 external-test，阶段 09B 不能借本 ADR 绕过该限制。此处原写「截至 2026-08-08」，是续期后未同步的失真，2026-08-11 修正。

## 验证与接受条件

本 ADR 在以下证据全部通过后由 `Proposed` 改为 `Accepted`：

1. 阶段 09A 完整门禁从干净 checkout 通过；
2. bootstrap、migration 和 runtime 权限反向测试通过；
3. IPv4/IPv6 监听、非 loopback 访问和数据库无端口检查通过；
4. API image、日志、Compose 配置和 tracked files Secret 扫描通过；
5. 停止重启、SIGTERM、migration 超时、备份 checksum 与全新 volume 恢复通过；
6. `pnpm stage08:check` 保持通过；
7. 文档没有把本地证据写成云、真实微信、外部测试或生产 Pass。

**接受注记（2026-08-11）**：七项全部满足——条件 1 由 M5 的 `pnpm stage09a:check`
从候选提交的干净 checkout（仓库外 `git clone` + `pnpm install --frozen-lockfile`）
完整通过取得；条件 2—4 由链内的 smoke（runtime 最小权限与 readiness 连接身份、
`::1` 与非 loopback 逐一失败、containment 扫描）与 M5 镜像扫描（image 依赖/组件
与 Config 逐项固定）取得；条件 5 由 M4 两演练取得（Accepted，验收落点
`f671c51`）；条件 6 是同一聚合链的第一步；条件 7 由 M5 文档收口维持——远端 CI
只登记「workflow 已配置」，无真实 run，不记 CI Pass。本 ADR 的 `Accepted` 指
**本地与私有测试部署基线成立**；它不等于 09A 总验收（计划文档「## 验收门禁」
全表），更不等于任何云、公网或发布判定。

**M5 总控复核注记（2026-08-12）**：ADR 的部署决策与 M1—M4 已验收证据不变，
但 M5 自身尚未 Accepted。候选 `929e50b` 经两路独立审计均为 BLOCK；对应 P1 已在
`4ada983` 定点整改：聚合入口接管 SIGINT/SIGTERM/SIGHUP，并在 termination primitive
异常时有界失败；runtime image 的 Config/history/create/export 全部绑定 immutable ID，
container identity 精确复核，dependency payload 覆盖 `.bin` 与 package 文件字节；
production audit 失败只输出固定类别。Actions 也已固定到 commit SHA。主工作树已重新
通过 `stage09a:check` 14/14，但新候选独立复审、远端 CI 真实 run 与 09A 总验收仍未
完成；不得把该注记解释成 M5 或 09A Pass。

**M5 第二轮独立复审注记（2026-08-12）**：后续候选 `38f172d` 的两路独立复审
仍为 BLOCK。实现落点 `1689f1b` 继续收口：聚合器通过专用所有权通道掌握子门禁
派生的 detached process group，先等待 scoped cleanup，再以原生 primitive 做有界
TERM/KILL/ESRCH 兜底；runtime image 的 dependency payload 比对覆盖普通文件内容、
`.bin` mode/归一化内容与被跳过路径的 filesystem type，history 增加 framing、固定字段
和 RootFS layer 行数下界；production audit 的 CLI 最终输出固定化并拒绝重复 advisory
identity；CI workflow 的权限、immutable action、单次 frozen install/aggregate invocation
由 mutation 回归钉住。主工作树已重新通过 `stage09a:check` 14/14，runtime image
变异计数为 1 baseline + 9 built + 2 static-only。该结果仍只是整改候选证据；新一轮
A/B 复审、远端 CI 真实 run 与 09A 总验收均未完成，M5 不得标记 Accepted。

**M5 最新独立复审与第三轮整改注记（2026-08-13）**：固定候选 `cce8a79` 的两路
独立复审仍为 BLOCK。实现落点 `90f5a8a` 进一步收口：聚合 ownership frame 要求
完整 LF，partial/malformed/缺 ACK 均失败，cleanup START/DONE 由 producer PID 区分；
runtime image history 绑定 `docker image save` 的 content-addressed config blob、完整
history 与 RootFS diff IDs，dependency payload 只归一化声明的 deploy root 并绑定
self-link；production audit、M4 one-shot ownership 与 checksum sidecar 均改成固定输出、
确切对象身份和有界文件证据。主工作树已从头通过 `stage09a:check` 14/14；该结果仍
只是整改候选，本轮新 SHA 的 A/B 复审、远端 CI 真实 run 与 09A 总验收尚未完成，
不得据此把 M5 或 09A 标记为 Accepted/Pass。

**M5 第四轮整改注记（2026-08-13）**：后续固定候选 `c44c579` 的两路复审仍为
BLOCK。实现落点 `8ca4e8c` 进一步把 ownership 通道定义成完整生命周期协议：空
EOF、partial/malformed frame、raw detached controller 未同步公告、cleanup START 后
缺 DONE 均 fail closed；DONE 只确认清理生命周期结束，不掩盖 residue/throw 的固定
exit 1。runtime image save 证据同时绑定 immutable inspect 的 config/history/rootfs
语义、tar layer blob digest 与解压后的 diff ID，dependency payload 只在 pnpm 生成
shim 的声明行归一化 deploy root。Docker absence 与 checksum sidecar 也改为严格单行
framing，tracked-file 计数改为 Git 现场派生。无 Docker 脚本测试 46/46、runtime
image 正向 78 packages / 76 links / 5 migrations、1 baseline + 9 built + 2 static-only
变异均通过；主工作树 `stage09a:check` 从头通过 14/14。该证据仍须形成文档候选并
交给两个全新独立只读会话复审；M5 未 Accepted、远端 CI 无真实 run、09A 未 Pass。

**M5 第五轮整改注记（2026-08-13）**：后续独立审计继续判定 BLOCK。实现候选
`9fcd503` 将聚合步骤收敛为 controller-owned process group，并把 runtime image 的
Config/history/layer 与不可变 OCI archive 绑定；同时修订 Secret 架构以满足原生
Linux：八份 host file-backed Secret 只进入唯一 `secret-materializer`，再分别物化为
消费 UID 999/10001 所有、mode 0600 的只读 named-volume 文件。backup 与 restore
使用独立最小凭据，dump 经 UID 999 transfer volume 在宿主 checksum 边界两侧搬运，
不再复用 `bootstrap-logins`。本轮受控改动了既有 M2B/M3B/M4 基础设施，全部修订均
纳入 M5 候选复审；ADR 的 Accepted 表示既有本地私有部署决策已经有真实容器证据，
不等于第五轮候选、M5 或 09A 已通过。远端 CI 仍无真实 run。

以下条件触发复审：

- 购买或创建远程测试环境；
- 引入真实 AppID/AppSecret、合法域名或公网入口；
- 迁移到托管 PostgreSQL；
- 增加第二个部署服务或后台 worker；
- 需要多机高可用、正式 RPO/RTO 或生产发布。
