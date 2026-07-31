# Meal Agent Lab

面向家庭场景的膳食规划与执行实验仓库。当前技术路线为 Node.js/Fastify 模块化单体、PostgreSQL、共享 Zod contracts 和 Taro/React 微信小程序；不拆微服务、不引入向量数据库，也没有第二份客户端 DTO。

## 当前阶段

阶段 08“家庭成员、用餐档案与硬约束”已完成最终本地审计整改，并于 2026-07-26 通过 fast-forward 合并至 `main`（实现落点 `df8107c`）。`@meal-agent/contracts` 当前为 `0.4.0`；API、数据库 migration、客户端、OpenAPI 和依赖审计已按 [ADR-0004](docs/architecture/decisions/0004-stage-08-pre-release-audit-closeout.md) 收口，外部能力仍保持 Deferred。

[阶段 09A“本地可部署性与私有测试基线”](docs/plans/2026-07-stage-09a-local-deployability-baseline.md)**进行中**：M1「API 容器构建基线」已由项目总控 Accepted（`services/api/Dockerfile` 与根 `.dockerignore`，固定 Node 24.18.0 digest、非 root `10001:10001`、runtime 无包管理器与客户端依赖）；M2A「数据库身份、bootstrap、migration 与 readiness 权限边界」的 **R8A 只读授权投影**已由项目总控 **Accepted**，验收落点 `ca65275`（见 [`infra/docker/postgres/`](infra/docker/postgres/)）。R8A 只交付**可观察性**：canonical projector 是一段纯 SELECT，因此 **ACL 全主体覆盖**与 **default privilege 叠加语义**在 R8A 只做到「能被完整、确定地观察」。**R8B 已由项目总控 Accepted**：canonical projector 已接入 verify/converge，观察、策略判断与收敛共享同一套 catalog 事实；`currentDefaultCte` 的整套 default privilege 缺陷（COALESCE 伪叠加、空 global 行语义、sequence S→s）连同 `currentAclCte` 与 `watchedGrantees` 静态名单一并删除，两个 generated adapter 已重新生成并在真实 PostgreSQL 18.4 上复验；ACL 比较覆盖完整元组（object + grantee + grantor + privilege + grantable），已决定的类型与 Large Object 策略已落实。**M2A 整体已由项目总控 Accepted，验收落点 `5e480803`**。**M2B（Compose 拓扑）已由项目总控 Accepted，验收落点 `d0f2219`**：[`infra/docker/compose.local-test.yaml`](infra/docker/compose.local-test.yaml) 与解析后配置的静态门禁已落地并取得实测证据——PostgreSQL 固定 exact tag + 真实解析所得的多架构 manifest digest 且不发布 host 端口、API 只发布到 `127.0.0.1`、bootstrap 只能显式调用、无 privileged/host network/Docker socket/数据库 bind mount。**M3A（配置与 Secret file 消费核心）已由项目总控 Accepted，验收落点 `a839df1`**：`DATABASE_URL`/`DATABASE_URL_FILE` 与三对 `MEAL_AGENT_*_PASSWORD` 的互斥来源解析器（Node 与 shell **按条对齐**，机制差异与残留边界已登记）、fail-closed 的 secret file 安全判据、连接串核心字段必须全部来自 URL、且连接串无法覆盖的那 8 个 ambient `PG*` 变量逐条拒绝、**无默认值**的 `DEPLOYMENT_STAGE`/`DEPLOYMENT_EXPOSURE`、逐字节固定的官方 code2Session endpoint、中央 logger 脱敏边界与全响应 `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` 均已落地并有反向测试。**M3B（环境模板、八份 Secret 的生成与交叉一致性、完整 bootstrap 链、`/readyz=200` 与网络隔离实证）为 implementation complete, pending total-control review**：从空 volume 起的十步链（cluster → logins → createdb → 0000 → handoff → acl → migrate → grants → api）全部真实退出码为 0，`/healthz` 与 `/readyz` 均为 200，Secret containment 扫描与宿主动态网络隔离取得实证（见 [`infra/docker/`](infra/docker/README.md) 与[阶段 09A 计划](docs/plans/2026-07-stage-09a-local-deployability-baseline.md)），未自行标记 Accepted；M4（停止/重启持久化与备份恢复）、M5（阶段总门禁与 CI）未开始，阶段 09A 不得记为 Pass。当前不购买服务器，不接真实微信配置，也不开放公网。

当前纵切覆盖：

- fake 微信登录、家庭与 exact-only 最小库存流；
- 邀请、加入、成员目录和退出/移除；
- linked 与 dining-only PersonProfile 的 list/get/edit/archive/restore；
- dining-only profile 关联成员的 owner 发起 + 被关联用户确认；
- 关联请求保存发起时的安全披露与 profile version，确认前变化稳定终态为 `profile_changed`；
- 全部现有 hard constraint 类型、标识符输入、双确认、未映射阻断和字段级 redaction；
- 饭量、默认参与、厨艺的明确 unknown/null 与编辑；
- 集中式 `full` / `one-time-secret` / `receipt` 幂等策略；
- PostgreSQL RLS、受控 `SECURITY DEFINER` 状态转换和数据库反向越权测试；
- 结果未知时保留不可变 payload + 原 idempotency key 的统一客户端命令状态机。

FAM-003 已完成。FAM-004 的登记、确认、隐私和页面范围已实现，但当前没有权威 allergen/food concept/宗教/伦理/食品安全映射词表，所有 hard constraint 都保持 `needs_structured_mapping`，因此安全闭环仍为部分完成。FAM-005 也只完成当前阶段的厨艺等级与未知值维护。菜单推荐、菜谱、采购、完整做饭或 Agent 不在阶段 08 范围。

## 本地门禁

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm stage08:check
```

`stage08:check` 串联环境检查、迁移、contracts、API 单元/HTTP/PostgreSQL/OpenAPI、客户端页面单测、weapp 构建、双用户 E2E、依赖审计策略和 Markdown 本地链接检查。依赖审计的限时 local/weapp-only 例外见 [`security/audit-exceptions.json`](security/audit-exceptions.json)；例外期间 H5、外部测试、体验版和发布均被阻断。

## 仓库结构

- [`apps/client`](apps/client/)：Taro/React 正式客户端；
- [`services/api`](services/api/)：Fastify 模块化单体 API；
- [`packages/contracts`](packages/contracts/)：跨端唯一契约与规则 manifest；
- [`docs`](docs/)：产品、架构、安全、计划和状态事实源；
- [`tests`](tests/)：跨模块和安全回归；
- [`security`](security/)：机器可读安全例外；
- [`ai`](ai/)：后续 Agent 运行时资产，本阶段不使用。

## 外部依赖边界

真实 AppID/AppSecret、真实 `wx.login`/code2Session、合法 HTTPS 域名、真机、体验版、审核/发布、云平台和原生三端仍是 `Deferred — 外部依赖`。本地 fake adapter、PostgreSQL 测试和开发者工具模拟器结果不能替代这些证据。

继续工作前阅读 [`AGENTS.md`](AGENTS.md)、[文档导航](docs/README.md)和[当前项目状态](docs/project-status.md)。
