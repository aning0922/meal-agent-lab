# Infrastructure

- `docker/`：本地依赖和可复现开发环境。
  - `docker/postgres/`：数据库身份边界 bootstrap，见[该目录 README](docker/postgres/README.md)。
  - `docker/postgres/sql/database/generated/`：**生成文件，禁止手改**。事实源是 `services/api/src/database/stage06-manifest.ts`，由 `pnpm --filter @meal-agent/api manifest:generate` 生成，`manifest:check` 逐字节校验。
- `environments/`：各环境的非敏感配置和部署声明。

云厂商和具体部署产品尚未确定。阶段 09A 只建立 Docker Compose 本地/私有测试基线，不购买服务器；计划见[阶段 09A](../docs/plans/2026-07-stage-09a-local-deployability-baseline.md)。local、test、staging、production 必须隔离数据库、Secret、微信配置、域名和数据；详细边界见[阶段 05 后端架构](../docs/architecture/backend-architecture-and-contracts.md#8-环境边界)。

环境差异通过经 schema 校验的配置表达，密钥不得进入仓库；默认提供最小权限、可审查迁移、备份恢复和可观测性。
