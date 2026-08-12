# Infrastructure

- `docker/`：本地依赖和可复现开发环境，见[该目录 README](docker/README.md)。
  - `docker/compose.local-test.yaml`：单机 local-test Compose 拓扑（M2B）。
  - `docker/check-compose-topology.mjs`：解析后 Compose 配置的静态门禁。
  - `docker/postgres/`：数据库身份边界 bootstrap，见[该目录 README](docker/postgres/README.md)。
  - `docker/postgres/sql/database/generated/`：**生成文件，禁止手改**。共**四个** adapter——对象 manifest、授权收敛、授权断言，以及 canonical projector 的只读投影出口（R8A 已 Accepted；R8B 已把它上面的共享结构化 CTE 接入 verify 与 converge，同样已由总控 Accepted）。事实源分别是 `services/api/src/database/stage06-manifest.ts`、`authorization-manifest.ts`（期望值）、`authorization-policy-sql.ts`（可移植策略）与 `authorization-projection-sql.ts`（共享观察），由 `pnpm --filter @meal-agent/api manifest:generate` 生成，`manifest:check` 逐字节校验。
- `environments/`：各环境的非敏感配置和部署声明。M3B 已落地唯一的
  [`local-test/`](environments/local-test/README.md) 模板（非敏感配置与空占位；
  不是 staging/production）。

云厂商和具体部署产品尚未确定。阶段 09A 只建立 Docker Compose 本地/私有测试基线，不购买服务器；计划见[阶段 09A](../docs/plans/2026-07-stage-09a-local-deployability-baseline.md)。当前进度：M1 Accepted；M2A 的 R8A 只读 projector 已由总控 Accepted（验收落点 `ca65275`）；R8B 已由总控 **Accepted**，**M2A 整体已 Accepted**（验收落点 `5e480803`）；**M2B（Compose 拓扑）已由总控 Accepted**（验收落点 `d0f2219`）——local-test Compose 拓扑与静态门禁已实现并取得实测证据；**M3A（配置与 Secret file 消费核心）已由总控 Accepted**（验收落点 `a839df1`），它只覆盖代码侧消费能力；**M3B（环境模板、八份 Secret 的生成与交叉一致性、完整 bootstrap 链、`/readyz=200` 与网络隔离实证）已于 2026-08-11 Accepted，验收落点 `cf43452`**——`environments/local-test/` 模板、八份 Secret 的生成/预检/容器内 UID 探针与完整链 smoke（`infra/docker/run-local-test-smoke.mjs`）均已落地并取得实测证据。**M4（生命周期、备份和恢复）已于 2026-08-11 Accepted，验收落点 `f671c51`**：备份/恢复运维入口、两条演练与 runbook（`docs/operations/stage-09a-local-test-lifecycle.md`）均已存在并有演练实证。M5 候选 `929e50b` 经两路独立审计 BLOCK 后已在 `4ada983` 定点整改并通过主工作树 `pnpm stage09a:check` 14/14，当前等待新候选独立复审，仍未 Accepted；09A 总验收未完成，阶段 09A 不得记为 Pass。数据库基线固定 **PostgreSQL 18.4**，M2B 已用 `docker buildx imagetools inspect` 解析真实仓库并固定 exact image digest（覆盖 `linux/amd64` 与 `linux/arm64/v8`），仓库中没有任何编造的 digest。local、test、staging、production 必须隔离数据库、Secret、微信配置、域名和数据；详细边界见[阶段 05 后端架构](../docs/architecture/backend-architecture-and-contracts.md#8-环境边界)。

环境差异通过经 schema 校验的配置表达，密钥不得进入仓库；默认提供最小权限、可审查迁移、备份恢复和可观测性。
