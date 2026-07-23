# Infrastructure

- `docker/`：本地依赖和可复现开发环境。
- `environments/`：各环境的非敏感配置和部署声明。

云厂商和具体部署产品尚未确定。local、test、staging、production 必须隔离数据库、Secret、微信配置、域名和数据；详细边界见[阶段 05 后端架构](../docs/architecture/backend-architecture-and-contracts.md#8-环境边界)。

环境差异通过经 schema 校验的配置表达，密钥不得进入仓库；默认提供最小权限、可审查迁移、备份恢复和可观测性。
