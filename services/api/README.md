# `@meal-agent/api`

Node.js 24 + Fastify 5 模块化单体，使用 PostgreSQL 18、Drizzle schema 映射和 `pg` 事务。当前实现阶段 06 的登录/家庭/最小库存与阶段 08 的邀请、成员、PersonProfile、硬约束审计收口。

## 安全边界

- 业务 request/response 只复用 `@meal-agent/contracts` `0.4.0`；持久化公共字符串统一拒绝 U+0000 和孤立 surrogate，并按 Unicode scalar value 与 PostgreSQL 计算相同长度，合法 emoji 允许写入；
- opaque session、transaction-local user/household context、FORCE RLS 和复合外键共同隔离家庭；
- `meal_agent_app` 无 `memberships UPDATE` 或 `person_profiles UPDATE`，成员与档案状态/字段变更只走受控 `SECURITY DEFINER` 函数；
- PersonProfile/constraint 写入只缓存 receipt，邀请码重放不含明文；
- owner/self 与 household 视图使用不同 allowlist schema，后者结构性排除 `subject_and_owner`；
- 日志脱敏 token、微信 code/provider 标识、inviteCode 及常见命名变体；
- production 配置拒绝 fake WeChat adapter。

## 迁移

顺序固定为：

```text
0000_stage_06.sql
  → 0001_stage_08.sql
  → 0002_stage_08_audit_closeout.sql
  → 0003_stage_08_secondary_closeout.sql
  → 0004_stage_08_final_closeout.sql
```

`0000`—`0004` 现已全部冻结，不得修改任何字节或其 checksum。`0004` 在单一事务内先移除旧终态 CHECK、转换旧 pending、再建立新约束，并固化关联安全披露、统一 household 锁顺序、撤销 link request 直接 INSERT、让 409 终态先提交再映射 HTTP，收紧 constraint JSONB/UUIDv7 数据库边界。最终版本还在 advisory 锁后重取时钟并重验 expiry，封闭安全 409 CHECK 的 SQL UNKNOWN，并允许自退出/关联冲突在 bootstrap 前读取同 key 完成记录，同时让无完成记录的 foreign membership DELETE 稳定返回 404。历史 link 披露明确为 `legacy_unavailable`，历史敏感幂等响应保留命令标识并变为 receipt 或 non-replayable tombstone。

## 本地运行

复制 `.env.example` 到本机未提交配置并提供 `DATABASE_URL`。开发环境可以显式使用 fake adapter；不得写入真实密钥。

```bash
pnpm --filter @meal-agent/api environment:check
pnpm --filter @meal-agent/api db:migrate
pnpm --filter @meal-agent/api dev
```

### 数据库身份与迁移入口

阶段 09A / M2A 起，迁移按数据库身份分成两条命令，`DATABASE_URL` 决定用哪个登录角色：

```bash
# 全新空库：cluster admin 应用冻结的 0000（它自身要 CREATE ROLE 并设置 BYPASSRLS）
pnpm --filter @meal-agent/api db:bootstrap

# 常规迁移：migration login 显式进入 meal_agent_migrator 应用 0001—最新
pnpm --filter @meal-agent/api db:migrate
```

两条命令是**两个独立的入口程序**，都不接受任何参数。`db:bootstrap`
（`src/database/bootstrap-0000.ts`）语义固定：只应用 `0000_stage_06.sql`、不切换
role；`db:migrate`（`src/database/migrate.ts`）总是显式 `SET ROLE
meal_agent_migrator`。admin 路径不是 `db:migrate` 的一个 flag：一旦存在这样的 flag，误敲一次就可能让
常规迁移进入 admin 模式，因此它被拆成独立入口程序。两个入口都在**建立连接之前**
拒绝任何参数。

`db:bootstrap` 在执行任何 DDL 之前用真实连接核对目标库名、admin 能力和数据库
状态。「空库」的判定是严格的：除了没有业务表，也不能有任何用户 schema、
`public` 里的 view/matview/sequence/routine/用户类型。指向 `postgres`、
`template1`、任何非项目库或任何非空库时立即失败。

metadata schema、ledger、`0000` 与 ledger 写入在**同一个事务**内完成：`0000`
失败时整批回滚，不会留下 `drizzle` schema 或空 ledger。

### 阶段 09A / M2A 当前状态

M1 已 Accepted；M2A 的 **R8A 只读 projector 最终修订**已完成，待总控复验。R8B
（把 projector 接入 verify/converge）**未开始**；M2B—M5 未开始，且在 M2A 通过
复验前禁止进入。

R8A 只交付**可观察性**：canonical projector 是一段纯 SELECT，尚未接入任何收敛或
断言阶段。因此 **ACL 全主体覆盖**与 **default privilege 叠加语义**目前只做到
「能被完整、确定地观察」，收敛仍由旧的 `watchedGrantees` 静态名单与
`authorization-manifest-sql.ts` 承担。下面的「目标设计」与「已实现事实」分开写，
不要把前者当成后者。

「ACL 全主体覆盖」指两件互不等同的事：**normalized raw ACL** 在受监管对象类别内
动态枚举**全部 grantee 与 grantor**；**effective** 只覆盖 `PUBLIC`、项目角色
（`meal_agent` 前缀）与目标库内**全部非 superuser LOGIN**——它不是对集群所有角色的
枚举，外部 NOLOGIN 角色的直接授权由 raw 层可见但不进入 effective 探测。

**R8B 必须替换的已知缺陷**：`authorization-manifest-sql.ts` 的 `currentDefaultCte`
同样把 `pg_default_acl.defaclobjtype` 直接喂给 `acldefault`，sequence 的默认权限因此
被低报为只剩 `USAGE`。该 CTE **同时被 converge 与 verify 两个块引用**（
`renderAuthorizationConvergeAdapter` 与 `renderAuthorizationVerifySql`），替换后必须
重新生成并复验两个 generated adapter。R8A 属冻结路径，未改动它。

### 冻结 0000 的安全 manifest

已经应用过 `0000` 的库（幂等重跑，以及 bootstrap 侧的 owner handoff）不再各自
维护一份手写对象清单。唯一事实源是
[`src/database/stage06-manifest.ts`](src/database/stage06-manifest.ts) 的 typed
readonly manifest：它描述冻结 `0000`（外加 migration runner 建立的 drizzle
ledger）执行完毕后，catalog 中与安全相关的规范化投影——**当前共 408 条规范化行**：

| kind | 条数 | 覆盖 |
| --- | --- | --- |
| `database` / `schema` | 1 / 3 | 归属，以及「没有多余 schema」 |
| `relation` | 10 | `relkind`/owner/persistence/RLS/FORCE RLS |
| `column` | 119 | 序号、类型、NOT NULL、默认值、identity/generated、存储与排序规则 |
| `index` / `constraint` | 24 / 163 | 规范化定义（PostgreSQL 18 把 NOT NULL 也登记为约束） |
| `routine` | 4 | identity args/owner/`SECURITY DEFINER`/language/`proconfig`（固定 `search_path` 与 `row_security=off`）/正文 `sha256` 摘要 |
| `policy` | 14 | command/roles/permissive/`USING`/`WITH CHECK` |
| `type` | 10 | managed schema 内的用户 type。**当前这 10 条全部是每张表的数组类型**（10 张表 → 10 个 `_<表名>` 数组类型），**不含行类型**：投影排除了 `typrelid` 指向真实 relation 的行类型，`0000` 也没有建 shell / base / enum / domain。`pg_catalog` 等系统 schema 不在范围内 |
| `constraint-trigger` | 60 | 外键背后的内部触发器**启用状态** |
| `trigger` / `rule` / operator / opclass / opfamily / collation / conversion / statistics / text-search / extension | 0 | 0000 一个都不建，出现即 `unexpected` |

`constraint-trigger` 是容易被忽略的一类：`ALTER TABLE … DISABLE TRIGGER ALL` 会
把外键背后的内部触发器一起置为禁用，从此外键不再强制，而表结构、约束定义与 RLS
全都看不出任何变化。它们的名字里带 OID，因此按「表 + 约束 + 触发器函数」定位。

owner handoff 的阶段由**整组 owner** 判定，而不是 database owner 单字段：整组
（database、`public`/`drizzle` schema、drizzle ledger 及其数组类型）要么全部尚未
交接，要么全部属于 `meal_agent_migrator`；任何混合态——例如 handoff 之后只把
database owner 夺回给 admin——都直接拒绝，因为单字段判据会被一次局部改动整体
带偏。

规范化投影在事务内固定 `search_path` 与 `quote_all_identifiers`，因此
`pg_get_indexdef` / `pg_get_constraintdef` / `pg_get_expr` 的输出不随会话变化；
块结束时两个 GUC 都会**显式还原**——`set_config(..., true)` 只在**事务**结束时
恢复，不会在 `DO` 块结束时恢复，而这些块是在 `BEGIN…COMMIT` 里被 `\ir` 进来的。

对象 catalog 基线实际绑定 **PostgreSQL 18.4**：约束/索引/表达式的规范化文本、
PostgreSQL 18 把 NOT NULL 登记为约束的方式、`acldefault` 的取值都由具体 patch
版本决定。判据是 exact-patch 的，并且覆盖**整套工具链**：`pnpm --filter
@meal-agent/api environment:check` 对 `createdb`、`initdb`、`pg_ctl`、`postgres`、
`psql` 逐个执行 `--version`，按标准 banner 的**主版本字段**严格解析（锚定文法，
不做任何 `includes` / 子串判断），五个都必须是 exact 18.4。混装会被拒绝：任一工具
是 18.3、banner 报的是别的工具名、或缺失/不可执行，即使 `postgres` 自己是 18.4 也
失败；`psql (PostgreSQL) 18.3 (Ubuntu 18.4-1…)` 这种「主版本 18.3、vendor suffix
含 18.4」的形态也会被拒绝。M2B 落 Compose 时必须**解析真实仓库**得到 18.4 的
exact image digest 再固定，当前文档不得写入任何编造的 digest；patch 升级要重新
capture manifest、重跑 parity 并显式 rebaseline。

[`src/database/stage06-manifest-sql.ts`](src/database/stage06-manifest-sql.ts)
把它渲染成一段**纯 SQL**：单条 `DO` 语句，不含 psql 元命令，不做任何
ownership/ACL/DDL 变更，只在不匹配时 `RAISE EXCEPTION`。`migrate.ts` 直接执行
内存渲染结果；`infra/docker/postgres/sql/database/01-owner-handoff.sql` 通过相对
路径 `\ir` 加载 generated 出的同一段文本。因此两个入口对同一批漂移给出**逐字
相同**的拒绝理由。

```bash
# 开发期重新生成 generated adapter（会覆盖 tracked 文件）
pnpm --filter @meal-agent/api manifest:generate

# 只读门禁：内存渲染与 tracked 文件逐字节比较，不会自动改写
pnpm --filter @meal-agent/api manifest:check
```

`manifest:check` 已并入 `pnpm --filter @meal-agent/api check`，它一次校验**四个**
generated adapter（对象 manifest、授权收敛、授权断言，以及 R8A 的只读授权投影）。
generated 文件带 do-not-edit 标记、manifest 版本与 canonical
digest，不含时间戳、绝对路径、locale 或随机值。「TS manifest ↔ generated SQL
一致」只是其中一环：数据库测试还在真实 PostgreSQL 18 上执行冻结 `0000`，把 catalog
的规范化投影与 TypeScript manifest 逐行比对（owner handoff 前后各一次），因此
manifest 不可能只是自洽而与事实脱节。

### ledger 感知的授权 manifest

对象 manifest 只描述冻结 `0000` 之后的**结构**，回答不了「0001—0004 应用之后 app
应该有哪些表权限」。授权因此另立一个事实源
[`src/database/authorization-manifest.ts`](src/database/authorization-manifest.ts)，
按 `(ledger, phase)` 精确描述 `PUBLIC` / `meal_agent_app` / `meal_agent_backup` /
三个 login 的：

- `grant`：catalog 里的直接授权（含隐式默认 ACL 展开）；
- `default`：`pg_default_acl` 的**有效**默认权限，按 objtype × schema/global 逐槽位；
- `effective`：`has_*_privilege` 的**有效**权限——`PUBLIC` 派生与角色继承都算在内；
- `routine`：受控 routine 的 identity/owner/`SECURITY DEFINER`/`proconfig`/正文摘要，
  **按 identity 精确匹配，没有 schema 级通配豁免**。

当前登记 4 个状态（`0000` 与 `0000—0004` 两个 ledger × containment / final 两个
阶段），共 382 条规范化行；未登记的 `(ledger, phase)` 一律 fail closed。

阶段划分对应恢复/安装流程的两个真实时刻：`bootstrap.sh acl` 是 **containment**
（migration 之前 / `pg_restore` 之后收敛，刻意不给备份角色表级 `SELECT`），
`bootstrap.sh grants` 是 **final**（migration 之后建立最终 ACL，并同时验证 PUBLIC、
app、backup 与三个 login）。两个阶段执行同一段生成的收敛块：按真实 grantor 撤销
一切不在 manifest 内的授权，再只重建允许项。

产品声明禁用 Large Object，因此收敛块还会收回 `pg_catalog` 中 20 个 LO 入口点
（`lo_create`、`lo_creat`、`lo_from_bytea`、`lo_put` …）的 `PUBLIC EXECUTE`：
只封堵已有 LO 的对象权限，等于允许 runtime 自己造一个新的不受约束的存储面。

### 只读授权投影（R8A，尚未接入 verify/converge）

[`src/database/authorization-projection-sql.ts`](src/database/authorization-projection-sql.ts)
渲染出**单条只读 SELECT**（`generated/authorization-projection.generated.sql`）：
不含 `GRANT`/`REVOKE`/`ALTER`/`SET ROLE`/`SET`/`set_config`，既不改数据也不改调用
方会话。它是 R8B 要接入的 canonical projector，**本轮只用于观察与反向测试**。

每个 kind 只声称自己实际证明的事：

| kind | 含义 |
| --- | --- |
| `acl` | **规范化的直接授权语义**：`NULL` ACL 按 PostgreSQL 语义展开为隐式内建默认权限。它**不是**「物理 catalog 里存在的 ACL 行」——`relacl IS NULL` 的表物理上一条 aclitem 都没有，投影仍会给出 owner 的内建默认权限。唯一例外是列级 `attacl`：它没有内建默认值 |
| `default-row` | `pg_default_acl` 的**物理行**存在性（含 `empty` 标志）。空 ACL 展开是零行，与「没有这一行」无法区分，因此存在性只能由这一层承载 |
| `default-global` / `default-schema` | 物理行展开后的条目 |
| `default-effective` | 按 PostgreSQL 真实语义叠加出的有效默认权限 |
| `default-unmapped` | 未知 `defaclobjtype` 的 fail-closed 标记，健康库恒为空 |
| `effective` | `has_*_privilege` 探测结果，含 `PUBLIC` 派生与角色继承 |
| `owner` / `large-object` | 归属 |
| `type-class` | 类型分类与数组类型的委托关系 |
| `role` | 参与 effective 探测的角色集合——**覆盖面证据，不是允许角色白名单** |

三条由真实 PostgreSQL 18.4 实测确定、并已固化为自动化测试的语义：

1. **非空** global `pg_default_acl` 行**替换**内建默认，而不是与之合并；
2. **空** global 行等价于「没有行」（新对象落回内建默认），但 `default-row` 仍能
   区分两者；
3. `pg_default_acl.defaclobjtype` 与 `acldefault()` 是**两套 objtype 编码**：
   sequence 在前者是 `S`、在后者是 `s`，而 `acldefault('S', …)` 是
   **FOREIGN SERVER**（只有 `USAGE`）。直接把 `defaclobjtype` 喂给 `acldefault`
   会把 sequence 的内建默认从 `SELECT`/`UPDATE`/`USAGE` **低报**成只剩 `USAGE`。
   现在由显式映射表承载，六种 objtype 穷尽，未知 objtype fail closed。

另一条实测更正：`acldefault('l', owner)` 对**受信与非受信语言完全相同**，都是
`{=U/owner, owner=U/owner}`；非受信语言的限制在建函数时按 superuser 判定，不体现
在 ACL 上。因此投影不再按 `lanpltrusted` 过滤 raw 层——否则 raw 说「没人有
USAGE」而 effective 说「所有人都有」，两层自相矛盾。

类型与 Large Object 的策略**已决定**（R8A 只报告，R8B 负责落实，不再裁定）：

- **managed 非数组类型**：owner（`meal_agent_migrator`）保留必要 `USAGE`；
  `PUBLIC`、app、backup 与三个 login 默认无 `USAGE`。全新安装后 row type 的
  `typacl` 已经是 `{meal_agent_migrator=U/meal_agent_migrator}`，投影如实报告；
- **数组类型**：只记录「向元素类型委托」，既不建立也不撤销独立 ACL——PostgreSQL
  对数组类型直接拒绝授权与改属（`cannot set privileges of array types`）；
- **Large Object**：产品声明禁用。R8B 对**任意** LO 对象必须 fail closed，且
  **只报告、不自动删除未知数据**；创建/读写入口、项目角色权限与异常 default ACL
  必须关闭。LO 的 OID 不进入任何固定允许 manifest。

R8B 的边界：投影结果**必然反映当前环境**（动态 LOGIN 角色、`pg_default_acl` 里
出现过的 owner、LO 的 OID），因此**不得**把整份投影冻结成跨 cluster 的固定快照。
只有 database identity 是可移植的逻辑键 `["database", "<current>"]`；外部角色只能
用策略匹配，不能逐个登记角色名。

连接、advisory lock 与 DDL 取锁都有界（默认 10s / 30s / 30s，上限分别为 60s 与
600s），另一会话持锁时在限定时间内明确失败，不会无限等待。上限存在的原因是
Node 定时器超过 2^31-1 毫秒会溢出并退化为约 1ms，"超大超时"会静默变成"几乎不
等待"。

角色基线、口令、owner 交接与备份授权由
[`infra/docker/postgres/`](../../infra/docker/postgres/) 的 bootstrap 完成，
完整顺序见该目录的 README。

测试与构建：

```bash
pnpm --filter @meal-agent/api test:unit
pnpm --filter @meal-agent/api test:http
pnpm --filter @meal-agent/api test:db
pnpm --filter @meal-agent/api openapi:check
pnpm --filter @meal-agent/api build
```

数据库测试使用临时 PostgreSQL 18 cluster，覆盖空库及“0003 + pending → 0004”增量 migration、checksum、RLS、应用角色直接 SQL、函数签名/权限、丢响应自退出重放、foreign DELETE 404、并发 join、两个真实 session 的 link expiry barrier、create/list/confirm 与 remove/archive 竞态、同一 principal 的 self-exit vs confirm 及 linked self-create vs confirm barrier、inactive target 同 key 409 重放、关联披露 TOCTOU、畸形 409 body 拒绝、JSONB 编码层接受合法 emoji/拒绝孤立 surrogate，以及敏感幂等历史转换。80/81 emoji 是 contract/OpenAPI 字段长度证据，不由裸 JSONB 测试证明。

## OpenAPI 与路由

OpenAPI 3.0.3 只能由 contracts/runtime schema 生成。生成器只把 JSON Schema 数值型 exclusive bound 转为 OpenAPI 3.0 boolean 形式，保留已有 boolean exclusive bound，且连续转换两次与一次完全相同。`@apidevtools/swagger-parser` 标准验证、禁用关键字扫描、approximate amount/tokenVersion/resultingLotVersion 三个 zero boundary，以及 PostgreSQL-safe string 在无 flag、`u` flag 和 Ajv 8 默认配置下的全部孤立 surrogate、合法 supplementary scalar 与 80/81 emoji parity，共同阻止方言或行为漂移。

[`openapi/stage-08.openapi.json`](openapi/stage-08.openapi.json) 由 route schema 和共享 contracts 生成，覆盖 19 个 path、25 个 method operation；节点扩展 `x-meal-agent-contract-rule-ids` 承载全部绑定规则 ID，根 manifest 的 classification 准确区分原生与 runtime-only。不得手工编辑生成 JSON。

业务路由：

```text
POST   /api/v1/auth/wechat/exchange
DELETE /api/v1/session
GET    /api/v1/me
GET    /api/v1/households
POST   /api/v1/households
GET    /api/v1/households/{id}/inventory-lots
POST   /api/v1/households/{id}/inventory-lots
POST   /api/v1/households/{id}/inventory-lots/{lotId}/events/consumed
GET    /api/v1/households/{id}/invites
POST   /api/v1/households/{id}/invites
DELETE /api/v1/households/{id}/invites/{inviteId}
POST   /api/v1/households/join
GET    /api/v1/households/{id}/members
DELETE /api/v1/households/{id}/memberships/{membershipId}
GET    /api/v1/households/{id}/person-profiles
POST   /api/v1/households/{id}/person-profiles
GET    /api/v1/households/{id}/person-profiles/{profileId}
PATCH  /api/v1/households/{id}/person-profiles/{profileId}
GET    /api/v1/households/{id}/person-profile-link-requests
POST   /api/v1/households/{id}/person-profiles/{profileId}/link-requests
POST   /api/v1/households/{id}/person-profile-link-requests/{requestId}/confirm
POST   /api/v1/households/{id}/person-profiles/{profileId}/dietary-constraints
DELETE /api/v1/households/{id}/person-profiles/{profileId}/dietary-constraints
```

另有 `GET /healthz` 和 `GET /readyz`。这些路由只证明本地实现；真实微信和云部署仍见[项目状态](../../docs/project-status.md)。
