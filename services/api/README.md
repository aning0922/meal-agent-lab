# `@meal-agent/api`

阶段 06 的最小服务端纵切。它是 Node.js 24 + Fastify 5 模块化单体的第一个部署单元，使用 PostgreSQL 18、Drizzle schema/迁移映射和 `pg` 事务。

## 已实施范围

- deterministic fake WeChat 登录交换，以及真实 code2Session adapter 边界；
- opaque session 签发、digest 持久化、绝对/不活跃过期和撤销；
- 家庭创建/列表、库存批次创建/列表、exact-only consumed command；
- user-scope 与 household-scope 幂等、目标资源指纹、expected version、负库存阻断；
- 九张业务表、复合外键、migration/app role 分离、`FORCE RLS`；
- creator、user-list、household-resource 三类 transaction-local bootstrap；
- exact quantity 的 `numeric(15, 6)` 存储、无容差小数位检查和数据库 decimal 扣减；数据库字符串只补零、不舍入，不用 JavaScript 浮点运算更新库存；
- request ID、日志脱敏、malformed JSON/404/413/超长 URL/415 的统一 problem response、就绪检查和 graceful shutdown；
- 从 `@meal-agent/contracts` Zod schema 生成的 OpenAPI，包括 `application/problem+json` 和 refinement 元数据。

不包含菜单推荐、Agent、OCR、通知、采购、完整做饭流程、Redis、消息队列、向量数据库、微服务、正式 App 或生产部署。

## 运行要求

- Node.js `>=24.14.0 <25`
- pnpm `11.9.0`
- PostgreSQL 18

Docker 不是本阶段测试前提。`test:db` 会创建并清理一次性 PostgreSQL 18 cluster；若二进制不在 `PATH`，设置 `PG_BIN` 指向 PostgreSQL 18 的 `bin` 目录。

```bash
export PATH="/path/to/node-v24/bin:$PATH"
export PG_BIN="/path/to/postgresql-18/bin"
pnpm install --frozen-lockfile
pnpm stage06:check
```

`stage06:check` 先验证 Node.js `>=24.14.0 <25` 和完整 PostgreSQL 18 工具链，再运行 contracts/API 类型检查、单元测试、HTTP integration、PostgreSQL integration、OpenAPI 一致性检查和构建。数据库测试不以 SQLite 或 mock 代替 PostgreSQL；Apple Silicon/Intel Homebrew 的 PostgreSQL 18 会自动发现，其他位置显式设置 `PG_BIN`。

## 本地启动

复制 `.env.example` 的键到本地 `.env` 或运行环境；不要提交填入凭据的文件。先用 migration owner 权限执行：

```bash
DATABASE_URL=postgresql://... pnpm --filter @meal-agent/api db:migrate
```

运行时连接角色必须能 `SET ROLE meal_agent_app`，且不能拥有 `BYPASSRLS`。服务端只在事务内设置 `app.user_id` / `app.household_id`，事务结束后由 PostgreSQL 清除。

本地默认使用：

```text
WECHAT_ADAPTER=fake
```

fake adapter 把 login code 单向散列为 deterministic provider subject，只用于验证内部身份、session 和 API。`NODE_ENV=production` 强制 `WECHAT_ADAPTER=real`；real adapter 必须同时从运行环境提供 `WECHAT_APP_ID`、`WECHAT_APP_SECRET` 与 HTTPS code2Session URL，配置层和 adapter 构造边界都会拒绝明文 HTTP。没有真实凭据、合法域名和真机证据时，真实微信链保持 `Deferred — 外部依赖`。

## OpenAPI

路由 request/response 直接引用 `@meal-agent/contracts` schema，再由 Fastify Zod adapter 生成：

```bash
pnpm --filter @meal-agent/api openapi:generate
pnpm --filter @meal-agent/api openapi:check
```

审查产物为 [`openapi/stage-06.openapi.json`](openapi/stage-06.openapi.json)。不得手工编辑该文件或维护第二套 DTO。

## 路由

```text
GET    /healthz
GET    /readyz
POST   /api/v1/auth/wechat/exchange
DELETE /api/v1/session
GET    /api/v1/me
POST   /api/v1/households
GET    /api/v1/households
GET    /api/v1/households/{id}/inventory-lots
POST   /api/v1/households/{id}/inventory-lots
POST   /api/v1/households/{id}/inventory-lots/{lotId}/events/consumed
```

业务写 command 必须带 `Idempotency-Key`。request fingerprint 绑定目标资源与规范化 body：相同作用域/key/目标/body 重放第一次结果；同 key 改变目标 lot 或 body 返回 `409 IDEMPOTENCY_KEY_REUSED`，不会跨 lot 回放结果。
