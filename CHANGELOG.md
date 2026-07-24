# Changelog

## Unreleased
- 模拟器走查发现并修复真实运行时缺陷：Zod v4 对象校验 JIT 依赖动态代码执行、被微信小程序沙箱禁用，客户端全局关闭 jitless（须先于契约 schema 构造），并加固 api-client 让 safeParse 异常降级为 malformedResponse。该缺陷 Node 单测/E2E 全过、仅真机运行时暴露。

- 实现阶段 07 正式客户端纵切：`apps/client`（Taro 4.2.1 + React 18.3.1）进入根 workspace，平台端口 + 唯一 Taro 触点分层，登录/家庭/库存三页打通“登录 → 创建家庭 → 新增三态数量批次 → exact-only 消耗”闭环，幂等重放、版本冲突、401 引导与跨家庭 404 语义全部经真实 API + PostgreSQL 18 端到端验证；删除一次性 Taro spike，CI 升级为 stage07 全量门禁。
- 建立项目目录、协作规范和基础产品、架构、领域及安全文档。
- 细化 App 功能编号、信息架构、核心用户流程、MVP 验收和产品开放决策。
- 确认产品默认方案，进入低保真原型准备阶段。
- 独立评审低保真原型并修复采购状态、菜单条件校验、做饭阻断、步骤用量、临期安全和餐后默认写入等问题。
- 新增库存临期与家庭页面、业务页上下文 Agent、暂停恢复和全页面状态模拟。
- 建立 P0 页面状态基线与正式评审结论，将产品文档状态更新为可进入技术验证。
- 修复原型站点构建辅助文件缺失，并扩充构建、渲染和安全基线检查。
- 按产品负责人确认关闭 RV-001～RV-003：保留“建议数量 + 预选组合 + 可选菜”，合并完成与库存确认，第四导航改为“我的”。
- 补齐登录恢复、库存搜索与批次历史、成员邀请与隐私、Agent 二级页，使全部 P0 页面均有可点击原型入口。
- 完成首发客户端跨端技术验证，接受 Taro 4.2.1 微信小程序优先路线，并记录 Android、iOS、HarmonyOS 的条件性复用与复审门槛。
- 新增一次性 Taro 客户端 spike，验证页面导航、本地状态、模拟 API、平台适配边界、自动测试及微信开发者工具预览。
- 调整阶段 04 验收范围，统一使用四态验证结果；新增 Mock `AuthPort`、测试号预览准备命令，并将真实登录/合法域名、体验版、审核和发布移至对应后续门禁。
- 完成阶段 05 后端架构定稿，接受 Node.js 24/Fastify 模块化单体、PostgreSQL 18/Drizzle、内部身份与家庭租户、REST/幂等/RLS 基线。
- 建立 `@meal-agent/contracts` 正式共享契约，覆盖身份、家庭、库存批次与事件、餐食与推荐、采购和统一 API 语义，并通过类型检查、10 个测试和构建。
- 明确 local/test/staging/production 隔离边界与阶段 06“登录 → 家庭 → 库存批次 → 幂等重放 → 最小 consumed 事件”纵切范围，同时保留阶段 04 Deferred 项。
- 完成阶段 05 合并前修订：拆分认证/家庭上下文与 RLS bootstrap，区分用户级/家庭级幂等，并加强 session、库存创建结果、日期、分页和 schema 推导不变量。
- 完成第二轮合并前修订：创建家庭结果使用安全 owner profile，初始库存事件按 canonical quantity mapping 可重建批次投影。
- 实现阶段 06 最小服务端纵切：`services/api` 首个真实服务（登录交换、session、家庭、库存批次与 exact-only consumed），九表迁移、FORCE RLS、两级幂等与 OpenAPI 生成校验。
- 完成阶段 06 合并前独立复验与审核修复：修正微信 code2Session errcode 语义（errcode 0 为成功；40029/40163/40226 映射 401；-1/45011 保持可重试 503），`WECHAT_ADAPTER` 取消默认值实现 fail-closed，Drizzle schema 与 SQL 迁移完全对齐（幂等唯一约束、事件数量形状检查、二级索引与约束命名统一），补强库存批次 approximate 数量的数据库约束，contracts 升级 0.2.0 记录 exact 数量 decimal string 线上格式修订，新增 GitHub Actions CI，并固定测试数据库 locale/UTF8 编码。
