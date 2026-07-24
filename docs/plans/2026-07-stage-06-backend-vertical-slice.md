# 阶段 06：最小服务端纵切实施计划

- 日期：2026-07-23
- 最近修订：2026-07-24
- 分支：`codex/stage-06-backend-vertical-slice`
- 基线：本地 `main` `1cc2ecc02e8c0da31d90daa2395238dda4815830`
- 边界修订基线：`b9b149b790d301cd92068cca77b134169241d0fb`
- 精度与传输修订基线：`d37781f5c749450ee28f9119a24d2861e273e85d`
- 精确网络表示修订基线：`b7d79c7b7212f63e24e9458da6a3e6b2cda33034`
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

阶段命令现提供 `pnpm stage06:check` 前置检查：先强制 Node.js `>=24.14.0 <25`，再确认 `postgres`、`initdb`、`pg_ctl`、`createdb` 来自 PostgreSQL 18。Apple Silicon/Intel Homebrew 路径自动发现，其他安装位置通过 `PG_BIN` 显式指定；版本或工具不完整时在门禁开始前失败。

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
pnpm stage06:check
pnpm --filter @meal-agent/api db:migrate:test
pnpm audit --prod
git diff --check
```

数据库 integration 测试使用 PostgreSQL 18 的 migration owner 与无 `BYPASSRLS` 应用角色，覆盖空库 migration、两个用户/两个家庭隔离、三类 bootstrap、连接复用、会话失效、幂等与库存并发。

## Deferred — 外部依赖

以下条件不等待、不以 fake 结果替代，完成阶段 06 时仍保持 `Deferred — 外部依赖`：

- 真实微信 AppID/AppSecret、`wx.login`、code2Session、UnionID 条件和合法 HTTPS 域名；
- 微信测试号真机、真机网络与存储、体验版、审核和发布链；
- 正式云账号、生产域名/证书、托管 PostgreSQL、Secret 管理、WAF、备份恢复和可观测平台；
- Android、iOS、HarmonyOS 工具链、签名、实机和发布。

deterministic fake WeChat adapter 只验证内部身份映射、session 和 HTTP 边界。real adapter 在无凭据时只接受编译、单元和边界测试，不记为真实微信链 Pass。

字段级 response redaction 不是外部依赖，但也不在阶段 06 的成员/档案读取范围内。当前只验证 `createHouseholdResultSchema` 的安全 owner allowlist、幂等 response cache 不含私密约束以及日志递归脱敏；通用成员/PersonProfile 读取 redaction 保持 `Deferred — 后续范围`，不得记录为 Pass。

## 边界修订

基于首个阶段 06 提交 `b9b149b790d301cd92068cca77b134169241d0fb` 修订：

- 幂等 request fingerprint 增加目标资源 ID；同 key/body 改投另一个 lot 返回 `409 IDEMPOTENCY_KEY_REUSED`，不回放第一个 lot 的结果。
- exact amount contract 固定 `numeric(15, 6)` 范围与六位小数；创建输入转换为定标 decimal 字符串，consumed delta、after、负库存和状态由 PostgreSQL `numeric` 表达式计算。
- production 禁止缺省或显式 fake WeChat adapter，必须选择 real 并提供运行时 AppID/AppSecret；这不改变真实微信链的 Deferred 状态。
- malformed JSON、404 和超过 2048 bytes 的 request target 统一返回共享 `ApiError` 与 `application/problem+json`。
- OpenAPI 错误 response 显式使用 `application/problem+json`；pageInfo 不变量生成为 `oneOf`，其余 Zod 跨字段不变量保存在 `x-zod-refinements`。
- system overview 与项目状态恢复通用字段级 response redaction 的 Deferred 状态。

基于 `d37781f5c749450ee28f9119a24d2861e273e85d` 继续修订：

- 该中间修订移除了 exact amount 对 Zod `multipleOf` 浮点容差的运行时依赖，并停止用 `toFixed(6)` 舍入；但仍在 JavaScript Number 转换后检查。后续 `b7d79c7` 基线修订已进一步用 decimal string 取代该 Number 路径。
- production 配置和 `RealWechatAdapter` 构造边界独立要求 HTTPS code2Session URL，并固定明文 HTTP 反例。
- Fastify 413/415 映射为 `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE`，与其他错误共用 `application/problem+json`。
- 新增 `pnpm stage06:check` 环境前置，统一检查 Node 24.14+ 与完整 PostgreSQL 18 工具链。
- ADR-0002/0003 把阶段 06 已完成验证从未来时/“待验证”移入已验证状态，只保留实际未完成项。

基于 `b7d79c7b7212f63e24e9458da6a3e6b2cda33034` 继续修订：

- exact amount 的请求、响应和 exact event delta 改为 plain fixed-point decimal string；JSON number、指数形式和超过六位小数在 IEEE-754 转换前拒绝，PostgreSQL mapper 不再把 exact `numeric` 转成 JavaScript Number。
- schema 把 `"1.0"`、`"1.000000"` 等等值 alias 规范化为同一字符串后再计算 request hash；HTTP→PostgreSQL 回归证明创建批次和 consumed 均只写一次并重放原结果。
- 固定原始 JSON 字符串 `999999999.9999991`、`900000000.00000001`、`1e-6`、`9E8` 以及 JSON number 反例；全部在 HTTP contract 边界返回 400 且不写库存。
- 登录交换为 disabled AuthIdentity/User 返回 401 `application/problem+json`，不新增 Session；OpenAPI 明确声明并检查 401 problem response。

## 验证结果

### 阶段 05 第 10.1 节的 13 项门禁

| # | 结果 | 证据 |
| --- | --- | --- |
| 1 | Pass | PostgreSQL 18.4 一次性空 cluster 执行全部 migration；public schema 恰好九张业务表；migration/app role、FORCE RLS 和复合外键检查通过 |
| 2 | Pass | deterministic fake code 首次创建、再次恢复同一 User；身份表只有一条映射，provider subject 不在 response/application log；disabled identity/user 重新交换返回 401 且不新增 Session |
| 3 | Pass | 共享 `authenticatedSessionSchema` 与数据库 auth service 拒绝 disabled User、expired/revoked Session 和 User/Session 错配；复合外键额外阻止错配写入 |
| 4 | Pass | 创建家庭不构造 `HouseholdContext`；user-scope 同 key/body 重放同一 Household ID，key/body 冲突返回 `409 IDEMPOTENCY_KEY_REUSED` |
| 5 | Pass | 家庭列表只设置 `app.user_id`；两个 User、两个 Household 的正向列表/资源访问和四种交叉隔离结果通过 |
| 6 | Pass | 家庭资源在事务内 bootstrap active Membership；故意删除 SQL household filter 后，RLS 仍只返回当前家庭 |
| 7 | Pass | household-scope 同 key/body 并发创建一个 lot 和一个 acquired event，另一请求重放；版本为 `0/1/1` |
| 8 | Pass | consumed 只接受 plain fixed-point decimal string 的 exact；JSON number、`999999999.9999991`、`900000000.00000001` 和指数形式在 HTTP 前置拒绝且不写库。PostgreSQL `numeric(15, 6)` 验证 `0.3 - 0.1 - 0.2 = 0.000000`、上限减 `0.000001`，以及 decimal alias 规范化后创建/consumed 各只写一次；delta、before/after、单位、非负、active/depleted、estimated 与负库存路径保持通过 |
| 9 | Pass | 不同 key、相同 expectedVersion 的并发 consumed 为一个 201、一个 `409 INVENTORY_VERSION_CONFLICT` |
| 10 | Pass | 相同 key/body、两个独立 session 的并发 consumed 返回同一 event；只有一次执行，另一请求为 replay |
| 11 | Pass | session 绝对过期、撤销和 Membership 移除均在下一请求即时失效；不活跃过期路径与绝对过期使用同一 auth service 判断 |
| 12 | Pass | contract 类型/11 个运行时测试、API 类型/8 个单元测试/5 个 HTTP integration/19 个 PostgreSQL integration、环境前置、OpenAPI 检查和两个构建全部通过 |
| 13 | Pass | 单元、HTTP 和数据库日志 sentinel 扫描不含 login code、opaque token、provider subject、UnionID、AppSecret 或成员私密约束 |

### 最终命令

以下命令于 2026-07-24 实际执行并通过：

```bash
pnpm install --frozen-lockfile
pnpm stage06:check
pnpm --filter @meal-agent/api db:migrate:test
pnpm audit --prod
git diff --check
```

- `pnpm audit --prod`：`No known vulnerabilities found`
- OpenAPI：8 个 path、10 个 route method 均存在；consumed request 只生成 decimal string exact schema，提交产物与实时生成结果一致
- OpenAPI 错误响应只声明 `application/problem+json`；登录 401、413/415、pageInfo `oneOf`、exact string pattern/precision/scale 和 IEEE-754 前置拒绝元数据均由检查固定
- 本地 Markdown：48 个文件中的 86 个本地链接全部可解析
- 提交范围扫描：未发现私钥签名、常见 access token、非空 `.env.example` Secret/数据库 URL、真实手机号/邮箱或第二份核心 DTO
- 生成物扫描：没有跟踪 `node_modules`、`dist`、coverage、日志或 TypeScript 增量缓存；提交的 OpenAPI 是可复现审查产物

### Deferred — 外部依赖

真实 `wx.login` → code2Session → internal session → 合法 HTTPS 域名/真机链仍为 `Deferred — 外部依赖`。真实 AppID/AppSecret、测试号、合法域名、真机、体验版/审核/发布、生产云、托管 PostgreSQL、证书、Secret 管理、备份和可观测平台均未验证。fake adapter 的 Pass 只适用于内部身份与 session 纵切。

### 未解决问题

- 当前默认 shell 未把 Codex Node.js 24 运行时加入 `PATH`；验证命令仍需显式使用该运行时，但 `pnpm stage06:check` 已在执行门禁前验证精确 Node/PostgreSQL 版本和工具完整性。
- Docker/Docker Compose 仍不可用；本阶段用本机 PostgreSQL 18.4 完成全部数据库门禁，不影响已声明范围。
- Drizzle ORM 0.45.2 的声明包会加载未安装数据库引擎的可选类型并产生上游 declaration 错误；`services/api` 只对第三方声明启用 `skipLibCheck`，项目源码仍为 strict typecheck，实际 Drizzle/`pg`/PostgreSQL integration 已通过。后续升级 Drizzle 时复审。
- staging/production 的连接角色授予、migration job、限流、备份恢复和可观测性仍待部署平台确定后验证。

阶段 06 范围内没有未解决的功能或测试失败。
