# 阶段 06：最小服务端纵切实施计划

- 日期：2026-07-23
- 分支：`codex/stage-06-backend-vertical-slice`
- 基线：本地 `main` `1cc2ecc02e8c0da31d90daa2395238dda4815830`
- 状态：已完成

## 范围与依据

本阶段严格实施“微信登录交换 → 创建/读取家庭 → 手工新增库存批次 → 幂等重放 → exact-only consumed 事件”的最小服务端纵切。依据：

- [阶段 05 报告第 10 节](../architecture/backend-architecture-and-contracts.md#10-阶段-06最小服务端纵切)
- [ADR-0002](../architecture/decisions/0002-backend-runtime-framework-and-persistence.md)
- [ADR-0003](../architecture/decisions/0003-identity-tenancy-and-api-semantics.md)
- [领域数据模型](../domain/data-model.md)
- [`@meal-agent/contracts`](../../packages/contracts/README.md)

不实施菜单推荐、Agent 对话、OCR、通知、采购、完整做饭流程、Redis、消息队列、向量数据库、微服务、正式 App 或生产部署。

## 验证环境基线

开始实施前的检查结果：

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| Git `main` | 可用 | 仓库未配置 remote；本地 `main` 干净，故以本地 `main` `1cc2ecc` 作为可取得的最新基线 |
| Node.js 24 | 可用 | Codex 工作区运行时 `/Users/aipuli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` 为 `v24.14.0`；默认 shell 尚未把该目录加入 `PATH` |
| pnpm | 可用 | `11.9.0` |
| Docker / Docker Compose | 不可用 | 默认 `PATH`、Docker Desktop 和 OrbStack 常见安装位置均未发现可执行文件 |
| PostgreSQL 18 | 不可用 | `psql`、`pg_isready` 不在默认 `PATH`，Homebrew `postgresql@18` 尚未安装 |

实施时使用 Node.js 24 工作区运行时。数据库门禁优先补齐本机 PostgreSQL 18 并创建一次性测试 cluster；Docker 不是通过门禁的必要条件。任何未实际执行的数据库检查不得记录为 Pass。

实施期间通过 Homebrew 安装 PostgreSQL 18.4。全部数据库门禁使用脚本创建、迁移并清理一次性空 cluster；没有启动常驻服务，也没有使用 SQLite、mock 数据库或 fake migration 结果。Docker 仍不可用，但不是本阶段实现或验证的前提。

## 实施步骤

1. 把 `services/api` 加入 pnpm workspace，锁定 Node.js 24、Fastify 5.10.0、Drizzle ORM 0.45.2、Drizzle Kit 0.31.10、`pg` 8.22.0、Zod/Fastify OpenAPI adapter 与测试依赖。
2. 在 `@meal-agent/contracts` 补充阶段 06 HTTP response/list schema；路由只引用共享 Zod schema，类型全部由 schema 推导。
3. 建立配置校验、request ID、结构化日志及递归脱敏、统一错误映射、健康/就绪检查和 graceful shutdown。
4. 建立 WeChat adapter port、deterministic fake adapter 与 real code2Session adapter 边界；real adapter 只有配置和调用边界，不用 fake 结果声称真实链通过。
5. 建立 Drizzle schema 和人工审查 SQL migration，创建九张最小表、复合外键、角色分离、`FORCE ROW LEVEL SECURITY`、creator/user-list/household-resource bootstrap policy。
6. 统一在数据库事务中设置 transaction-local `app.user_id` / `app.household_id`，实现认证用户和家庭 context bootstrap，验证连接池归还后不残留 context。
7. 实现阶段 06 的 10 个路由、用户级/家庭级幂等、库存事件和 expected-version 并发控制。
8. 覆盖阶段 05 报告第 10.1 节全部 13 项门禁，并生成/检查 OpenAPI。
9. 更新 README、项目状态和本计划，执行密钥、真实用户数据和生成物扫描。
10. 仅提交当前阶段分支，不合并 `main`。

## 计划验证命令

最终以实际执行结果为准：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm --filter @meal-agent/api openapi:check
pnpm --filter @meal-agent/api db:migrate:test
git diff --check
```

数据库 integration 测试将使用 PostgreSQL 18 的 migration owner 与无 `BYPASSRLS` 应用角色，覆盖空库 migration、两个用户/两个家庭隔离、三类 bootstrap、连接复用、会话失效、幂等与库存并发。

## Deferred — 外部依赖

以下条件不等待、不以 fake 结果替代，完成阶段 06 时仍保持 `Deferred — 外部依赖`：

- 真实微信 AppID/AppSecret、`wx.login`、code2Session、UnionID 条件和合法 HTTPS 域名；
- 微信测试号真机、真机网络与存储、体验版、审核和发布链；
- 正式云账号、生产域名/证书、托管 PostgreSQL、Secret 管理、WAF、备份恢复和可观测平台；
- Android、iOS、HarmonyOS 工具链、签名、实机和发布。

deterministic fake WeChat adapter 只验证内部身份映射、session 和 HTTP 边界。real adapter 在无凭据时只接受编译、单元和边界测试，不记为真实微信链 Pass。

## 验证结果

### 阶段 05 第 10.1 节的 13 项门禁

| # | 结果 | 证据 |
| --- | --- | --- |
| 1 | Pass | PostgreSQL 18.4 一次性空 cluster 执行全部 migration；public schema 恰好九张业务表；migration/app role、FORCE RLS 和复合外键检查通过 |
| 2 | Pass | deterministic fake code 首次创建、再次恢复同一 User；身份表只有一条映射，provider subject 不在 response/application log |
| 3 | Pass | 共享 `authenticatedSessionSchema` 与数据库 auth service 拒绝 disabled User、expired/revoked Session 和 User/Session 错配；复合外键额外阻止错配写入 |
| 4 | Pass | 创建家庭不构造 `HouseholdContext`；user-scope 同 key/body 重放同一 Household ID，key/body 冲突返回 `409 IDEMPOTENCY_KEY_REUSED` |
| 5 | Pass | 家庭列表只设置 `app.user_id`；两个 User、两个 Household 的正向列表/资源访问和四种交叉隔离结果通过 |
| 6 | Pass | 家庭资源在事务内 bootstrap active Membership；故意删除 SQL household filter 后，RLS 仍只返回当前家庭 |
| 7 | Pass | household-scope 同 key/body 并发创建一个 lot 和一个 acquired event，另一请求重放；版本为 `0/1/1` |
| 8 | Pass | consumed 只接受 exact；delta、before/after、单位、非负、active/depleted 全部断言；estimated 在 HTTP contract 边界拒绝，负库存返回 409 且不写事件/投影 |
| 9 | Pass | 不同 key、相同 expectedVersion 的并发 consumed 为一个 201、一个 `409 INVENTORY_VERSION_CONFLICT` |
| 10 | Pass | 相同 key/body、两个独立 session 的并发 consumed 返回同一 event；只有一次执行，另一请求为 replay |
| 11 | Pass | session 绝对过期、撤销和 Membership 移除均在下一请求即时失效；不活跃过期路径与绝对过期使用同一 auth service 判断 |
| 12 | Pass | contract 类型/11 个运行时测试、API 类型/5 个单元测试/3 个 HTTP integration/14 个 PostgreSQL integration、OpenAPI 检查和两个构建全部通过 |
| 13 | Pass | 单元、HTTP 和数据库日志 sentinel 扫描不含 login code、opaque token、provider subject、UnionID、AppSecret 或成员私密约束 |

### 最终命令

以下命令于 2026-07-23 实际执行并通过：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @meal-agent/api db:migrate:test
pnpm audit --prod
git diff --check
```

- `pnpm audit --prod`：`No known vulnerabilities found`
- OpenAPI：8 个 path、10 个 route method 均存在；consumed request 只生成 exact schema，提交产物与实时生成结果一致
- 本地 Markdown：45 个文件中的 85 个本地链接全部可解析
- 提交范围扫描：未发现私钥签名、常见 access token、非空 `.env.example` Secret/数据库 URL、真实手机号/邮箱或第二份核心 DTO
- 生成物扫描：没有跟踪 `node_modules`、`dist`、coverage、日志或 TypeScript 增量缓存；提交的 OpenAPI 是可复现审查产物

### Deferred — 外部依赖

真实 `wx.login` → code2Session → internal session → 合法 HTTPS 域名/真机链仍为 `Deferred — 外部依赖`。真实 AppID/AppSecret、测试号、合法域名、真机、体验版/审核/发布、生产云、托管 PostgreSQL、证书、Secret 管理、备份和可观测平台均未验证。fake adapter 的 Pass 只适用于内部身份与 session 纵切。

### 未解决问题

- 当前默认 shell 未把 Codex Node.js 24 运行时加入 `PATH`；验证命令显式使用该运行时。仓库的 `engines` 已阻止跨 major 漂移。
- Docker/Docker Compose 仍不可用；本阶段用本机 PostgreSQL 18.4 完成全部数据库门禁，不影响已声明范围。
- Drizzle ORM 0.45.2 的声明包会加载未安装数据库引擎的可选类型并产生上游 declaration 错误；`services/api` 只对第三方声明启用 `skipLibCheck`，项目源码仍为 strict typecheck，实际 Drizzle/`pg`/PostgreSQL integration 已通过。后续升级 Drizzle 时复审。
- staging/production 的连接角色授予、migration job、限流、备份恢复和可观测性仍待部署平台确定后验证。

阶段 06 范围内没有未解决的功能或测试失败。
