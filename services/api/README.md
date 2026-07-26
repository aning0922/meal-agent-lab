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

两条命令都**不接受任何参数**：`db:bootstrap` 的语义是固定的（只应用
`0000_stage_06.sql`、不切换 role），`db:migrate` 会显式 `SET ROLE
meal_agent_migrator`。`pnpm run <script> -- --flag` 会把字面量 `--` 一并传给脚本，
因此不提供需要转发参数的入口；未知参数、重复参数和组合参数一律失败。

`db:bootstrap` 在执行任何 DDL 之前用真实连接核对目标库名、admin 能力和数据库
状态（必须是空库，或恰好只正确应用了 `0000`）。指向 `postgres`、`template1` 或
任何非项目库时立即失败，且不会留下 `drizzle` schema、migration ledger 或 `0000`
的任何对象。

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
