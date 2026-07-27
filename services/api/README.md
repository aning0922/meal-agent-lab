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
| `type` | 10 | **全部用户 type，含 shell 与 base**（每张表的数组类型也在内） |
| `constraint-trigger` | 60 | 外键背后的内部触发器**启用状态** |
| `trigger` / `rule` / operator / opclass / opfamily / collation / conversion / statistics / text-search / extension | 0 | 0000 一个都不建，出现即 `unexpected` |

`constraint-trigger` 是容易被忽略的一类：`ALTER TABLE … DISABLE TRIGGER ALL` 会
把外键背后的内部触发器一起置为禁用，从此外键不再强制，而表结构、约束定义与 RLS
全都看不出任何变化。它们的名字里带 OID，因此按「表 + 约束 + 触发器函数」定位。

owner 判定与 handoff 阶段绑定：`handoff-pending` 只在目标 database 的 owner 还不是
`meal_agent_migrator` 时才放行 bootstrap admin；handoff 完成之后这些对象必须精确
属于 migrator。规范化投影在事务内固定 `search_path` 与 `quote_all_identifiers`，
因此 `pg_get_indexdef` / `pg_get_constraintdef` / `pg_get_expr` 的输出不随会话变化。

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

`manifest:check` 已并入 `pnpm --filter @meal-agent/api check`，它一次校验**三个**
generated adapter。generated 文件带 do-not-edit 标记、manifest 版本与 canonical
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
