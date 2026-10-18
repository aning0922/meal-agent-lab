<div align="center">

<img src="assets/brand/zaobian-fanshibu/avatar-v1.png" alt="灶边饭事簿：深绿记事簿与一碗热饭" width="156" height="156" />

# 灶边饭事簿

**记好家中食材，安排一日三餐。**

Meal Agent Lab · 面向家庭的膳食规划与执行实验项目

![status](https://img.shields.io/badge/状态-开发中-1f5137)
![client](https://img.shields.io/badge/客户端-Taro%20%2B%20React-2563eb)
![api](https://img.shields.io/badge/API-Fastify-222222)
![database](https://img.shields.io/badge/数据库-PostgreSQL-4169e1)

[项目介绍](#为什么做这个项目) · [当前能力](#当前能做什么) · [本地体验](#本地体验) · [文档导航](docs/README.md) · [开发状态](docs/project-status.md)

</div>

---

## 为什么做这个项目

冰箱里还有什么？今天一家人吃什么？下班路上还需要买什么？

灶边饭事簿希望把这些日常小事连起来：先记清食材和用餐成员，再结合时间、厨艺与家庭约束安排一餐，让采购、做饭和库存变化有据可循。

目标是服务经常在家做饭的家庭，减少反复决策和重复采购，也让剩余食材更容易被看见。

```text
家里有什么 → 这一餐怎么吃 → 还需要买什么 → 做完以后记下来
   库存          餐次规划          采购补充           消耗与反馈
```

> 上面是产品目标流程。当前公开主线提供家庭与库存基础能力，完整推荐与执行闭环仍在开发。

## 当前能做什么

以下能力以本仓库 `main` 已集成的代码为准。

| 能力 | 当前实现 |
| --- | --- |
| 家庭协作 | 创建家庭、邀请码加入、成员目录、退出与移除 |
| 用餐档案 | 管理关联成员或仅用餐档案，编辑、归档与恢复 |
| 饮食约束 | 登记过敏及其他硬约束，保留确认、可见范围和待映射状态 |
| 食材库存 | 按批次新增库存，以事件记录精确消耗 |
| 操作恢复 | 请求结果未知时保留原始操作快照和幂等键，在当前进程内安全重试 |
| 本地部署 | Docker Compose、最小权限数据库身份、健康检查、备份与恢复演练 |

**开发进度**：阶段 08 家庭与档案基础、阶段 09A 本地部署基线已完成验收。后续推荐、采购、餐后消耗和菜谱草稿等探索位于独立开发分支或本地工作树，尚未全部合入本主线。历史验收、实现落点与当前交接见[项目状态](docs/project-status.md)。

**使用边界**：当前仅用于本地开发与合成数据验证。真实微信登录、真机、外部测试和产品发布尚未开放；权威食材与过敏原等映射未完成，硬约束保持 `needs_structured_mapping`，不能据此生成真实食品建议。

## 设计原则

- **库存有来龙去脉。** 按批次管理，用事件记录变更，保留消耗历史。
- **未知就保持未知。** 包装标注、用户输入和默认估算区分来源与置信度，购买日期不充当生产日期。
- **安全约束优先。** 过敏、宗教禁忌和明确不可食用项作为硬约束；模型不能绕过校验或确认。
- **家庭共享有边界。** 权限校验、字段级可见性与 PostgreSQL RLS 共同隔离家庭和个人信息。
- **先做扎实的小闭环。** 一个 API 部署单元、一份共享契约，按实际需要扩展。

## 技术栈与结构

```text
Taro / React 微信小程序
          │
          │  @meal-agent/contracts · Zod 共享契约
          ▼
Node.js / Fastify 模块化单体
          │
          │  事务 · 权限 · 幂等 · 字段脱敏
          ▼
PostgreSQL · RLS · 批次与事件记录
```

| 目录 | 用途 |
| --- | --- |
| [`apps/client`](apps/client/) | Taro / React 微信小程序客户端 |
| [`services/api`](services/api/) | Fastify API、数据库迁移与 OpenAPI |
| [`packages/contracts`](packages/contracts/) | 跨端唯一的领域契约与规则 manifest |
| [`infra/docker`](infra/docker/) | 本地 Compose、数据库身份与生命周期工具 |
| [`docs`](docs/) | 产品、架构、食品安全、实施计划与证据 |
| [`tests`](tests/) | 跨模块、端到端与安全回归 |
| [`ai`](ai/) | Agent 提示词、评测与模型策略的预留目录 |
| [`assets`](assets/) | 品牌、图标与设计资源 |

架构细节见[系统概览](docs/architecture/system-overview.md)与[架构决策记录](docs/architecture/decisions/README.md)。

## 本地体验

### 1. 准备环境

| 工具 | 项目基线 |
| --- | --- |
| Node.js | **24.18.0**，用于复现验收环境 |
| pnpm | **11.9.0**，由 `packageManager` 固定 |
| PostgreSQL | **18.4**，包括 `initdb`、`pg_ctl`、`psql` 等全部七项工具 |
| 微信开发者工具 | 查看本地小程序模拟器 |
| Docker Engine + Compose v2 | 仅容器部署和完整阶段 09A 验证需要 |

数据库工具版本由环境检查核实；必要时通过 `PG_BIN` 指向 PostgreSQL 18.4 的 `bin` 目录。

### 2. 安装依赖

```bash
git clone https://github.com/aning0922/meal-agent-lab.git
cd meal-agent-lab
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @meal-agent/api environment:check
pnpm --filter @meal-agent/contracts build
```

### 3. 启动本地联调栈

在一个终端运行：

```bash
MEAL_AGENT_DEV_API_PORT=3000 pnpm --filter @meal-agent/client dev:stack
```

该命令自动创建临时 PostgreSQL 集群、执行迁移并启动 fake 微信登录 API。按 `Ctrl-C` 退出时清理临时数据库，适合一次性体验；请仅录入合成数据。

在另一个终端构建客户端：

```bash
pnpm --filter @meal-agent/client build:weapp
```

在微信开发者工具中导入 `apps/client/dist`，使用仓库内的 `touristappid` 配置。本地模拟器按需关闭合法域名校验，API 默认指向 `http://127.0.0.1:3000`。可依次体验：**本地登录 → 创建家庭 → 查看成员与档案 → 新增库存批次 → 登记精确消耗**。

联调细节见[客户端说明](apps/client/README.md)；持久化本地部署与备份恢复请使用 [local-test 环境说明](infra/environments/local-test/README.md)和[运维手册](docs/operations/stage-09a-local-test-lifecycle.md)。配置模板只保留示例，真实密钥通过环境变量或本机受保护文件提供。

## 开发与验证

```bash
pnpm typecheck                  # contracts、API、客户端类型检查
pnpm test                       # 含真实 PostgreSQL 的模块测试
pnpm docs:links:check            # Markdown 本地链接
pnpm stage08:check               # 家庭与档案纵切的完整检查
pnpm stage09a:check              # 加上容器、生命周期与备份恢复验证
```

完整门禁需要上述数据库工具；阶段 09A 还需要运行中的 Docker Engine。测试范围与证据详见[脚本说明](scripts/README.md)。依赖安全例外、有效期及允许范围见 [`security/audit-exceptions.json`](security/audit-exceptions.json)，当前例外仅覆盖本地 weapp，外部使用和发布仍受限制。

## 继续了解

| 想了解什么 | 从这里开始 |
| --- | --- |
| 产品要解决的问题 | [产品简述](docs/product/product-brief.md) · [核心流程](docs/product/core-user-flows.md) |
| 已实现与尚未完成的工作 | [项目状态](docs/project-status.md) |
| 食品安全与模型边界 | [食品安全](docs/safety/food-safety.md) · [Agent 设计](docs/agent/agent-design.md) |
| 数据结构和接口 | [领域模型](docs/domain/data-model.md) · [API 说明](services/api/README.md) |
| 参与开发 | [协作约定](AGENTS.md) · [文档导航](docs/README.md) |

欢迎通过 [Issues](https://github.com/aning0922/meal-agent-lab/issues) 反馈问题或讨论产品想法。提交问题时请使用合成示例，避免附带真实家庭、健康数据或密钥。

## 许可

仓库公开供浏览和交流；目前尚未选择开源许可证，包元数据保持 `UNLICENSED`。如需复制、修改、分发或商用，请先与维护者确认授权。品牌资源、外部食品规则与数据的使用权限分别记录，不因仓库公开而自动授予。
