# Meal Agent Lab

面向家庭场景的膳食规划与执行实验仓库。当前技术路线为 Node.js/Fastify 模块化单体、PostgreSQL、共享 Zod contracts 和 Taro/React 微信小程序；不拆微服务、不引入向量数据库，也没有第二份客户端 DTO。

## 当前阶段

阶段 08“家庭成员、用餐档案与硬约束”已完成最终本地审计整改，并于 2026-07-26 通过 fast-forward 合并至 `main`（实现落点 `df8107c`）。`@meal-agent/contracts` 当前为 `0.4.0`；API、数据库 migration、客户端、OpenAPI 和依赖审计已按 [ADR-0004](docs/architecture/decisions/0004-stage-08-pre-release-audit-closeout.md) 收口，外部能力仍保持 Deferred。

[阶段 09A“本地可部署性与私有测试基线”](docs/plans/2026-07-stage-09a-local-deployability-baseline.md)**进行中**：M1「API 容器构建基线」已由项目总控 Accepted（`services/api/Dockerfile` 与根 `.dockerignore`，固定 Node 24.18.0 digest、非 root `10001:10001`、runtime 无包管理器与客户端依赖）；M2A「数据库身份、bootstrap、migration 与 readiness 权限边界」的 **R8A 只读授权投影最终修订**已完成、待总控复验（见 [`infra/docker/postgres/`](infra/docker/postgres/)）。R8A 只交付**可观察性**：canonical projector 是一段纯 SELECT，**尚未接入** verify/converge，因此 **ACL 全主体覆盖**与 **default privilege 叠加语义**目前只做到「能被完整、确定地观察」，收敛仍由旧的静态名单承担；类型与 Large Object 的策略已决定，R8B 只负责落实。R8B 另需**统一替换** `currentDefaultCte` 的整套 default privilege 缺陷（COALESCE 伪叠加、空 global 行语义、sequence S→s），它同时影响收敛与断言，替换后要重新生成、复验 converge 与 verify 两个 generated adapter。R8B 未开始；M2B（Compose 拓扑）、M3、M4、M5 未开始，且在 M2A 通过复验前**禁止进入**。数据库基线固定 PostgreSQL 18.4，M2B 才解析并固定 exact image digest。当前不购买服务器，不接真实微信配置，也不开放公网。

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
