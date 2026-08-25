# Packages

跨应用共享模块：

- [`domain/`](domain/README.md)：阶段 09P-M0 的纯 TypeScript 治理信封、canonical
  digest、strict decode、validated catalog index、引用解析与合成 fail-closed 规则；
  Round 5.2 implementation complete, pending total-control review，不含后续
  Recipe/Recommendation/Meal/Shopping 业务，也未 Accepted。
- [`contracts/`](contracts/README.md)：正式 API、实体快照、事件和校验契约；同时提供 Zod schema 与推导的 TypeScript 类型。
- `ui/`：设计令牌和可跨端复用的 UI 约定。
- `config/`：共享构建、格式化、静态检查和测试配置。

共享包不得依赖某个具体 App 的页面或运行时状态。

客户端、服务端和测试不得复制 `contracts/` 已有的核心类型。数据库 row、内部领域聚合和页面 view-model 不属于网络 contract，应通过显式 mapper 连接。

`domain/` 与 `contracts/` 是两条不同边界：前者不定义网络 DTO 或副作用接口，后者不
承担领域引擎职责。M0 没有修改 `contracts/`、API、数据库或客户端。
