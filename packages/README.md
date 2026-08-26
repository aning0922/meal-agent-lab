# Packages

跨应用共享模块：

- `domain/`：Stage 09P-M0 Recovery 候选的纯领域类型与确定性规则；production 固定为
  `types/decode/canonical/validation/catalog/resolution/index` 七模块。当前是 R3 audit
  candidate，M0 尚未 Accepted，M1 未开始。
- [`contracts/`](contracts/README.md)：正式 API、实体快照、事件和校验契约；同时提供 Zod schema 与推导的 TypeScript 类型。
- `ui/`：设计令牌和可跨端复用的 UI 约定。
- `config/`：共享构建、格式化、静态检查和测试配置。

共享包不得依赖某个具体 App 的页面或运行时状态。

客户端、服务端和测试不得复制 `contracts/` 已有的核心类型。数据库 row、内部领域聚合和页面 view-model 不属于网络 contract，应通过显式 mapper 连接。
