# PostgreSQL bootstrap（阶段 09A / M2A）

本目录建立数据库身份边界：cluster 角色、登录身份和对象归属。它**不是**业务
migration，不新增也不修改任何业务表结构，因此不进入
[`services/api/migrations/`](../../../services/api/migrations/)，也不写 migration ledger。

已冻结的 `0000`—`0004` 不得修改。业务结构如需变化，只能追加新 migration。

## 身份模型

登录身份与数据库内 NOLOGIN 角色分离。三个登录角色都是
`LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`，
并带显式 connection limit 与 `VALID UNTIL 'infinity'`。它们**除目标数据库的
`CONNECT` 外，没有任何直接授予的 schema/table/sequence/function 权限**，必须显式
`SET ROLE` 才能取得对应角色的权限。

三个 managed schema（`public`、`drizzle`、`meal_agent_private`）采用**严格基线**：
`PUBLIC` 的 `USAGE`/`CREATE` 被显式收回，只显式授予必要的 `USAGE`，`migrator`
作为 schema owner 无需授予。因此三个登录角色在 `SET ROLE` 之前对任何 managed
schema 都没有有效访问，基线也不再依赖 template 的默认 ACL。

| schema | `PUBLIC` | `meal_agent_app` | `meal_agent_backup` | 三个 login |
| --- | --- | --- | --- | --- |
| `public` | 无 | `USAGE`（无 `CREATE`） | `USAGE`（无 `CREATE`） | 无 |
| `drizzle` | 无 | `USAGE`（无 `CREATE`） | `USAGE`（无 `CREATE`） | 无 |
| `meal_agent_private` | 无 | `USAGE`（无 `CREATE`） | **无** | 无 |

`meal_agent_private` 是受控状态转换函数（`SECURITY DEFINER`）所在的 schema。app
只拿到 `USAGE`，因此**不能在其中创建任何对象**；backup 连 schema 都进不去——它是
敏感的全库导出角色，没有任何理由以 migrator 身份执行函数。

| 登录角色 | 可进入 | connection limit | 用途 |
| --- | --- | --- | --- |
| `meal_agent_migration_login` | `meal_agent_migrator` | 4 | 应用 `0001`—最新 migration |
| `meal_agent_runtime_login` | `meal_agent_app` | 40 | API runtime 与 readiness |
| `meal_agent_backup_login` | `meal_agent_backup` | 8 | 完整导出（M4 落地生命周期） |

| NOLOGIN 角色 | BYPASSRLS | 能力 |
| --- | --- | --- |
| `meal_agent_migrator` | 是 | database owner，DDL |
| `meal_agent_app` | 否 | 受 RLS 约束的业务读写 |
| `meal_agent_backup` | 是 | 全库只读，不能写业务表或 DDL |

membership 恰好三条边，全部 `WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`。

`meal_agent_migrator` 与 `meal_agent_backup` 都是敏感的高权限角色：前者有 DDL 与
`BYPASSRLS`，后者能越过 FORCE RLS 读取全部家庭数据。二者都不得借用 API runtime
身份，也不得进入 API container。

目标数据库上 `PUBLIC` 的 `CONNECT` 与 `TEMPORARY` 已被收回；`meal_agent_app` 与
`meal_agent_backup` 都不持有 `TEMPORARY`。

## 两个作用域

- **cluster scope**（`cluster`、`logins`）连接明确的 maintenance/control 数据库
  （默认 `postgres`），只处理六个 cluster 角色、role config、membership 与口令。
  **不要求目标数据库存在**，也不修改任何目标数据库 ACL。
- **database scope**（`handoff`、`acl`、`grants`）只在目标 `meal_agent*` 数据库
  存在后运行，处理数据库 ACL、schema ACL、owner 交接与对象权限。

这样拆开之后，恢复路径可以复用 cluster scope 与 ACL 基线，而不必碰 `0000` 或
owner handoff。

## 执行顺序

全新安装：

```text
1. admin      bootstrap.sh cluster                              角色 + membership（早于 createdb）
2. admin      bootstrap.sh logins                               SCRAM 口令
3. admin      createdb meal_agent
4. admin      pnpm --filter @meal-agent/api db:bootstrap        原子应用冻结的 0000
5. admin      bootstrap.sh handoff --dbname meal_agent          owner 交接（0000-only）
6. admin      bootstrap.sh acl     --dbname meal_agent          ACL 基线
7. migration  pnpm --filter @meal-agent/api db:migrate          SET ROLE 应用 0001—最新
8. admin      bootstrap.sh grants  --dbname meal_agent          备份角色补授
9. runtime    readiness                                         SET LOCAL ROLE meal_agent_app
```

`cluster` 与 `logins` 刻意排在 `createdb` **之前**：它们连 maintenance 数据库，
不要求目标库存在。

恢复（M4 实现，本轮只登记约束）：

```text
1. admin      bootstrap.sh cluster
2. admin      bootstrap.sh logins
3. admin      createdb --owner=meal_agent_migrator meal_agent
4. operator   pg_restore
5. admin      bootstrap.sh acl     --dbname meal_agent
6. migration  pnpm db:migrate                       应用备份之后新增的 migration
7. admin      bootstrap.sh grants  --dbname meal_agent
8. 验证       readiness / owner / GRANT / RLS / checksum
```

恢复路径**不**执行 `0000`，也**不**执行 owner handoff：dump 已经带着正确的
owner，重跑只会制造漂移。

第 4 步必须由 cluster admin 执行：冻结的 `0000` 自身要 `CREATE ROLE` 并设置
`BYPASSRLS`，此时切换到 `meal_agent_migrator` 还拿不到这些能力。这是如实记录的
cluster-admin 边界，不伪装成最小权限步骤。

第 5 步是硬前置：`0002_stage_08_audit_closeout.sql` 含
`REVOKE CREATE ON SCHEMA public FROM PUBLIC`，只有 `public` schema 的 owner 才能
执行。未做 owner 交接时，migration login 无法应用到 `0002`。

## 授权：containment 与 final 两个阶段

`acl` 与 `grants` 不再各写一份 GRANT/REVOKE 清单。授权的唯一事实源是
[`services/api/src/database/authorization-manifest.ts`](../../../services/api/src/database/authorization-manifest.ts)，
它按 `(ledger, phase)` 描述 `PUBLIC`/app/backup/三个 login 的 catalog ACL、
`pg_default_acl` 的**有效**默认权限、`has_*_privilege` 的**有效**权限，以及受控
routine 的 identity/owner/`SECURITY DEFINER`/`proconfig`/正文摘要。

| 阶段 | 命令 | 时机 | 备份角色表级 SELECT |
| --- | --- | --- | --- |
| containment | `bootstrap.sh acl` | migration 之前 / `pg_restore` 之后 | **无** |
| final | `bootstrap.sh grants` | migration 之后 | 有（含 default privileges） |

containment 刻意不给备份角色表级 `SELECT`：migration 期间没有理由存在一份可读
全库的授权。final 阶段才建立最终 ACL，并且**同时验证 PUBLIC、app、backup 与三个
login**——只检查备份角色会漏掉「migration 顺手把某张新表授给了 PUBLIC」。

两个阶段执行同一段生成的收敛块（`generated/authorization-converge.generated.sql`），
顺序固定且可复核：**先执行全部致命前置条件**（managed schema 齐全、六个项目角色
存在、归属正确、登录角色不拥有任何对象、routine 指纹与未知 routine、manifest 要求
的对象存在、未知 `defaclobjtype`、**任意** Large Object、无法由 ACL mutation 修复
的 membership 漂移），再按真实 grantor 撤销一切策略不允许的授权与可再授予标志（含
列级授权），然后以 canonical grantor `meal_agent_migrator` 重建允许项，最后按
`pg_default_acl` 的**物理行**收敛默认权限；随后由只读断言块
（`generated/authorization-verify.generated.sql`）同时比对**完整元组**的 catalog
ACL、default privilege 的物理行与有效叠加，以及 `has_*_privilege` 有效权限。
未登记的 `(ledger, phase)` 组合一律 fail closed。

「先改、再靠事务回滚冒充 preflight」被明确排除：回滚只让命令失败，中途已经产生过
真实变更，权限本身也仍留在数据库里。`acl` 与 `grants` 因此对同一批漂移给出**逐字
相同**的问题清单。

产品声明禁用 Large Object。R8B 起顺序是**先判定、后收敛**：

1. 目标库里出现**任意** `pg_largeobject_metadata` 对象时，两个阶段都在**任何
   ACL / default ACL mutation 之前** fail closed。此时**绝不**修改 `lomacl`、
   **绝不**解除链接、**绝不**接管归属、**绝不**删除数据——只报告 OID 与 owner，
   而且 OID 不进入任何固定允许集合。
2. 只有在**确实没有** Large Object 时，收敛才会处理与 LO 相关的权限面：
   `pg_default_acl` 中 `defaclobjtype = 'L'` 的异常默认权限，以及 20 个
   `pg_catalog` LO 入口点（`lo_create` / `lo_creat` / `lo_from_bytea` /
   `lo_put` / `lo_import` …）上除函数 owner 之外的 `EXECUTE`。只封堵已有 LO 的
   对象权限而放着创建入口，等于允许 runtime 自己造一个不受 schema ACL 与 RLS
   约束的存储面。

## canonical projector（R8A Accepted；R8B 已接入 verify/converge，待总控复验）

`generated/authorization-projection.generated.sql` 是**第四个** generated adapter：
一段**单条只读 SELECT**，不含 `GRANT`/`REVOKE`/`ALTER`/`SET ROLE`/`SET`/
`set_config`。R8A 已由项目总控 **Accepted**（验收落点 `ca65275`）。

R8B 把它上面那一整段 CTE 变成**共享的结构化 projector**：

```text
PostgreSQL catalog
  → 共享结构化 projector CTE
      → 公开只读 projection adapter（本文件，对外三列，R8A 语义不回归）
      → 可移植策略匹配器 → generated/authorization-verify.generated.sql
      → 可移植策略匹配器 → generated/authorization-converge.generated.sql
```

**共享的是事实采集**，不是把动态投影冻结成跨环境快照：本文件仍然只观察，一条
期望值都没有；期望值在 `authorization-manifest.ts`，策略在
`authorization-policy-sql.ts`。

它按五类事实观察目标库，每类只声称自己实际证明的事：**规范化的直接授权语义**
（`acl`，`NULL` ACL 展开为隐式内建默认，因此不是「物理 ACL 行」）、
**`pg_default_acl` 物理行**（`default-row`，含 `empty` 标志）、
**有效权限**（`effective`，`has_*_privilege`，含 `PUBLIC` 派生与角色继承）、
**归属**（`owner` / `large-object`）与 **role coverage**（`role`，是覆盖面证据，
不是允许角色白名单）。语义细节与 PostgreSQL 18.4 实测结论见
[`services/api/README.md`](../../../services/api/README.md)。

**R8B 已统一替换的缺陷**：旧 `authorization-manifest-sql.ts` 的
`currentDefaultCte` 有三个互相独立的错误——`COALESCE(schema, global, builtin)` 三选一
冒充叠加语义、把「空 global 行」与「没有这一行」混为一谈、把
`pg_default_acl.defaclobjtype` 直接喂给 `acldefault`（sequence 的 `S` 被当成 FOREIGN
SERVER）。它同时被两个 adapter 引用，因此三条同时影响 `acl` 的**收敛**与 `grants`
的**断言**。该 CTE 连同 `currentAclCte`（第二份 catalog 枚举）与 `watchedGrantees`
观察过滤一并删除，两个 adapter 已重新生成并在真实 PostgreSQL 18.4 上复验。

R8B 还补上了一个只有收敛侧才会暴露的语义：默认权限语句的**起算点**是 global 从
内建 `acldefault` 起算、schema 从空起算。因此「内容是内建默认真子集」的 global 行
（本基线的 `f@global`）只能靠**撤销**得到——只补授缺失项时，结果恰好等于内建默认，
PostgreSQL 会直接把行删掉，那一行永远造不出来。

类型与 Large Object 的策略**已决定**，R8B 已落实：managed 非数组类型只保留
owner/`meal_agent_migrator` 的 `USAGE`，`PUBLIC`、app、backup 与三个 login 无
`USAGE`——这一条同时落在对象 ACL 与 `T@global` 的默认权限物理行上，因此新建类型
**出生即干净**；数组类型只记录向元素类型的委托，既不进入收敛目标也不该有独立 ACL；产品
禁用 Large Object，**任意** LO 对象在任何 mutation 之前 fail closed，**只报告、不
解除链接、不删数据、不接管归属、不改 `lomacl`**，LO 的 OID 不进入任何固定允许集合。

## 收敛性

每个阶段都可重复执行。`cluster` 阶段每次都把六个项目角色**完整规范化**回基线：
属性、role-level GUC 配置与 membership 图；`acl` 阶段收敛数据库/schema/对象权限。越界 membership 被逐条
撤销后重新授予目标边。因此重复 bootstrap 只会收敛权限，不会叠加权限。

几个容易踩空的地方已被显式处理：

- `ALTER ROLE x RESET ALL` 只清全局设置，不清 `ALTER ROLE x IN DATABASE d SET ...`
  留下的每库设置，因此按 catalog 逐条清理；
- `pg_auth_members` 的键是 `(roleid, member, grantor)`，不带 `GRANTED BY` 的
  `REVOKE` 只会删掉「由执行者授予」的那一行，因此按 catalog 逐行撤销并显式指定
  `GRANTED BY`；
- 对象与数据库权限同理：普通 `REVOKE` 只撤销「由执行者授予」的那一份，第三方
  grantor 授予的授权会残留。**`PUBLIC` 也是如此**——数据库级与 schema 级的
  `PUBLIC` 授权按真实 grantor 逐条 `SET LOCAL ROLE` 后撤销，是**真正撤销**，
  而不是等后置校验失败再整体回滚（回滚只让命令失败，权限仍留在库里）；
- Large Object 不受 schema ACL 与 RLS 约束。当前产品不使用 LO，因此
  `pg_largeobject_metadata.lomacl` 中指向项目角色或 `PUBLIC` 的权限、以及
  `pg_default_acl` 中 `defaclobjtype = 'L'` 的非 owner 默认权限一律收敛并断言为
  空；项目角色**拥有** LO 属于异常状态，只报告并失败，不删数据；
- routine 权限按**有效权限**（`has_function_privilege`）验证而不是只看直接
  grantee：`GRANT EXECUTE ... TO PUBLIC` 会派生给每个角色，恢复路径带进来的这类
  授权只查直接授权是看不见的。`public` 与 `drizzle` 中不允许存在任何 routine，
  出现即 fail closed——dump 可以把任意 `SECURITY DEFINER` 函数带进 `drizzle`。

## 用法

```bash
infra/docker/postgres/bootstrap.sh cluster
infra/docker/postgres/bootstrap.sh logins
infra/docker/postgres/bootstrap.sh handoff --dbname meal_agent
infra/docker/postgres/bootstrap.sh acl     --dbname meal_agent
infra/docker/postgres/bootstrap.sh grants  --dbname meal_agent
```

`--dbname` 只接受严格的 `meal_agent` 或 `meal_agent_<suffix>` 标识符；URI、
conninfo `key=value`、引号和大写一律拒绝。cluster scope 用 `--maintenance-db`
（默认 `postgres`）。每个阶段执行前都会核对 `current_database()` 与 admin 能力，
并检查所处的 migration ledger/owner 状态；连错库或顺序错误时 fail closed。

`acl` 与 `grants` 都在任何 mutation 之前先确认三个 managed schema 都存在（缺任何
一个都说明这不是一个可以安全收敛的目标：新安装漏了 `0000`，或恢复只恢复了一部分），
再验证 database / 三个 schema / 全部被管理 relation、routine 与 type 的 owner 都是
`meal_agent_migrator`；不符合时 fail closed，绝不在恢复路径上偷偷接管归属。这两段
SQL 本身是**薄入口**，只固定阶段 GUC 与事务边界——前置条件由 generated 收敛块统一
承担，因此两个阶段的判据完全一致。

`handoff` 是 **fresh-install 的 0000-only 步骤**：ledger 必须恰好只有 checksum
正确的 `0000_stage_06.sql`。`0001+`、断档、未知条目或错误 checksum 全部 fail
closed，因此它不支持「最新 migration 之后重跑」——可复用的是 `acl` 与 `grants`。

它的全部状态检查都先于任何归属变更，且**不再手写对象清单**：ledger 与 database
owner 由 `01-owner-handoff.sql` 自己检查，对象与安全属性由事务内用相对路径
`\ir` 加载的 [`sql/database/generated/0000-object-manifest.generated.sql`](sql/database/generated/0000-object-manifest.generated.sql)
判定。业务表与 `meal_agent_private` 函数的 owner 只验证、不接管。

### 冻结 0000 的对象与安全属性 manifest

generated adapter 是**生成文件，禁止手改**。事实源是
[`services/api/src/database/stage06-manifest.ts`](../../../services/api/src/database/stage06-manifest.ts)
的 typed manifest，由 `pnpm --filter @meal-agent/api manifest:generate` 生成，
`manifest:check` 逐字节保证它与内存渲染结果一致（只读门禁，不会自动改写文件）。
`services/api` 的 `db:bootstrap` 幂等重跑预检执行的是**同一段文本**，因此两个
入口对同一批漂移给出逐字相同的拒绝理由。

它覆盖 database/schema 归属与「没有多余 schema」、relation 的
`relkind`/owner/persistence/`RLS`/`FORCE RLS`、**每一列**的序号/类型/NOT NULL/
默认值/存储/排序规则、index 与 constraint 的规范化定义、routine 的
identity args/owner/`SECURITY DEFINER`/language/`proconfig`（固定 `search_path`
与 `row_security=off`）/正文 `sha256` 摘要、policy 的
command/roles/permissive/`USING`/`WITH CHECK`、**managed schema 内的用户 type**
（当前 10 条**全部是每张表的数组类型**，**不含行类型**：投影排除 `typrelid` 指向
真实 relation 的行类型，而 `0000` 没有建 shell / base / enum / domain）、trigger、
**外键背后内部 constraint trigger 的启用状态**、rule，以及
operator / opclass / opfamily / collation / conversion / 扩展统计 / 文本搜索 /
extension 这些明确枚举的 namespace 类别——当前 408 条规范化行。它是纯 SQL、只读：
不匹配时 `RAISE EXCEPTION`，不做任何变更。

`handoff-pending` 的 owner 归一化**与阶段绑定**：只有目标 database 的 owner 还不是
`meal_agent_migrator` 时才放行 bootstrap admin；handoff 完成之后 admin 重新夺回
`public` 或 ledger 的 owner 会被判为漂移。投影在事务内固定 `search_path` 与
`quote_all_identifiers`，因此不同会话得到同一份规范化文本。

manifest 不是从 `0000_stage_06.sql` 正则推导的，也不与 SQL 侧各写一份：它是在
真实 PostgreSQL 18 上执行冻结 `0000` 之后从 catalog 采集并冻结的规范化投影，
数据库测试在 owner handoff 前后各做一次逐行 parity 比对。

每个 phase 的参数语法是精确的：不相关的 option、重复 option、缺 value 和多余
位置参数一律拒绝，不静默忽略也不「最后一个覆盖」。

连接参数走标准 `PG*` 环境变量。`logins` 阶段要求三个非空密码环境变量
（`MEAL_AGENT_MIGRATION_PASSWORD`、`MEAL_AGENT_RUNTIME_PASSWORD`、
`MEAL_AGENT_BACKUP_PASSWORD`）。

## 口令处理

口令由 psql 的 `\password` 在**客户端**生成 SCRAM-SHA-256 verifier，只把 verifier
放进 `ALTER USER`。原始口令不进入 SQL 文本、命令行参数、仓库、shell 历史或服务端
日志（已在开启 `log_statement=all` 的集群上用随机 sentinel 验证）。

两个 `\password` 的陷阱已被处理：

- 它的提示先尝试打开 `/dev/tty`，只有失败才回落到 stdin。因此在有控制终端的
  交互式 shell 里用管道喂口令会**永久阻塞且无任何错误**（macOS 普通 Terminal
  正是这种情况，且系统不带 `setsid`）。脚本因此统一在「无控制终端」的会话里
  执行 `\password`：优先用 util-linux 的 `setsid`，否则用仓库内的
  [`no-ctty.mjs`](no-ctty.mjs)——它只用 Node 标准库，`spawn(..., { detached: true })`
  在 POSIX 上即 `setsid(2)`，并透传子进程退出码。两者都没有时明确失败而不是挂死。
- 连接本身也用 `--no-password`：缺少 admin 凭据时立即失败，不会等待交互输入
  （连接口令提示有同样的 `/dev/tty` 缺陷）。
- 进入 `logins` 分支后、**第一次读取口令变量之前**就保存并关闭 xtrace，
  三个变量 `unset` 之后才恢复；有 `bash -x` + 合成 sentinel + 注定失败的 PSQL
  的回归测试，断言合并后的 stdout/stderr 零命中。
- 口令为空字符串时服务端会**清空**该角色口令并且 psql 仍退出 0，因此设置后强制
  回查 `pg_authid`，确认三个角色都真的持有 SCRAM verifier。

本目录不含任何真实凭据。Compose 服务、端口发布、secret file 注入和备份恢复生命
周期分别属于 M2B、M3 和 M4，本轮不实现。

## 验证

真实 PostgreSQL 18 的正向与反向验证见
[`stage09a.roles.database.test.ts`](../../../services/api/tests/database/stage09a.roles.database.test.ts)，
由 `pnpm --filter @meal-agent/api test:db` 执行。该测试启动**专用**集群，
`local` 走 trust、所有 TCP 登录强制 `scram-sha-256`，并开启服务端语句日志，
以便验证口令认证与日志中不出现明文。
