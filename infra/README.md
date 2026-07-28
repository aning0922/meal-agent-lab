# Infrastructure

- `docker/`：本地依赖和可复现开发环境。
  - `docker/postgres/`：数据库身份边界 bootstrap，见[该目录 README](docker/postgres/README.md)。
  - `docker/postgres/sql/database/generated/`：**生成文件，禁止手改**。共**四个** adapter——对象 manifest、授权收敛、授权断言，以及 canonical projector 的只读投影出口（R8A 已 Accepted；R8B 已把它上面的共享结构化 CTE 接入 verify 与 converge，同样已由总控 Accepted）。事实源分别是 `services/api/src/database/stage06-manifest.ts`、`authorization-manifest.ts`（期望值）、`authorization-policy-sql.ts`（可移植策略）与 `authorization-projection-sql.ts`（共享观察），由 `pnpm --filter @meal-agent/api manifest:generate` 生成，`manifest:check` 逐字节校验。
- `environments/`：各环境的非敏感配置和部署声明。**当前为空骨架**，M3 才落地。

云厂商和具体部署产品尚未确定。阶段 09A 只建立 Docker Compose 本地/私有测试基线，不购买服务器；计划见[阶段 09A](../docs/plans/2026-07-stage-09a-local-deployability-baseline.md)。当前进度：M1 Accepted；M2A 的 R8A 只读 projector 已由总控 Accepted（验收落点 `ca65275`）；R8B 已由总控 **Accepted**，**M2A 整体已 Accepted**（验收落点 `5e480803`）；**M2B（Compose 拓扑）In Progress**，M3—M5 未开始，`environments/` 模板、容器 smoke、备份恢复脚本与部署运行手册**均尚未存在**。数据库基线固定 **PostgreSQL 18.4**；M2B 落 Compose 时必须解析真实仓库得到 exact image digest 再固定，本仓库当前不得写入任何编造的 digest。local、test、staging、production 必须隔离数据库、Secret、微信配置、域名和数据；详细边界见[阶段 05 后端架构](../docs/architecture/backend-architecture-and-contracts.md#8-环境边界)。

环境差异通过经 schema 校验的配置表达，密钥不得进入仓库；默认提供最小权限、可审查迁移、备份恢复和可观测性。
