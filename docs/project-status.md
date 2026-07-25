# 项目状态

最后更新：2026-07-25

## 当前结论

阶段 08 二次审计整改已在 `codex/stage-08-audit-closeout` 完成本地实现、标准门禁与模拟器复跑，等待项目总控实施后评审；尚未合并 `main`，不得开始阶段 09。整改遵循 [ADR-0004](architecture/decisions/0004-stage-08-pre-release-audit-closeout.md) 的预发布窄例外：仓库没有已部署生产/测试消费者，因此 contracts 保持 `0.4.0` 并在 `/api/v1` 原地修正；若发现真实环境或外部消费者，该例外立即失效。

当前仍采用 Node.js 24 + Fastify 5 模块化单体、PostgreSQL 18 + Drizzle/`pg`、共享 Zod contracts 和 Taro/React，不拆微服务、不换数据库/客户端框架、不引入向量数据库。

## 阶段 08 整改结果

### 幂等与隐私

- 所有通用幂等写 route 由规范化路由注册表穷尽选择 `full`、`one-time-secret` 或 `receipt`，endpoint 不再传临时 redact 回调。
- PersonProfile 与 constraint 写操作首次和重放都只返回 receipt；完整资源只能通过授权 GET 获取。邀请码只在首次响应出现，缓存和重放使用安全投影。
- `0002_stage_08_audit_closeout.sql` 把历史敏感 profile 响应转为 receipt 或 `nonReplayable` tombstone；`0003_stage_08_secondary_closeout.sql` 保留并加固相同完成标识，成员自退出在 active membership 消失后仍可先于 bootstrap 重放，最终写入必须命中一行。
- `inviteCode` 的 camelCase、snake_case、大小写与嵌套日志键都进入脱敏边界。

### 数据库权限与并发

- `meal_agent_app` 不再拥有 `memberships UPDATE` 或 `person_profiles UPDATE`；档案身份字段不能由应用角色直接更改，初始 status/version/constraints 和 linked/dining-only 创建者均受 RLS 约束。
- 成员退出/移除、邀请赎回、profile 字段/状态/约束和关联确认通过窄参数 `SECURITY DEFINER` 函数执行，固定 `search_path`、完整限定对象、内部时钟、安全默认 capabilities、NULL version 拒绝并撤销 PUBLIC EXECUTE。
- HTTP capability 与跨家庭 404 仍是第一层授权，数据库函数和 FORCE RLS 是 defense-in-depth。
- 两个不同邀请码并发加入同一家庭按 household+user 串行化：一个成功，另一个稳定返回 already-member，不泄漏唯一约束为 500。

### PersonProfile 与成员

- 独立 profile list/get 覆盖 linked 与 dining-only profile，并支持 `active`、`archived`、`all`。
- archive 与 restore 始终复用原 profile ID；退出或移除成员时原子归档 linked profile，重新加入不自动恢复，也不复制私人约束。
- dining-only profile 关联成员由 owner 创建请求、目标用户确认；不按姓名合并。直接创建 linked profile 只能由其本人执行，并与关联确认共享锁和锁顺序；并发结果只能一方成功、另一方 409。
- pending link request 在同一锁内把过期、目标成员退出、档案归档和目标已有档案物化为终态，过期后可重新发起。
- owner/self 能读取完整字段；其他家庭成员只读安全投影，结构上排除 `subject_and_owner`。
- owner 行的 `isSelf` 已按实际登录用户计算并有页面级回归。

### 未知事实与硬约束

- `defaultParticipation`、`defaultPortionScale`、`cookingSkill` 均支持 `null`；新家庭和新档案不再猜测“参与/不参与”、饭量或厨艺，旧数据也不做推测性迁移。
- 客户端支持 allergy、religious、ethical、explicit avoid 和 food safety exclusion，并采集 allergen/food concept 标识符。
- 当前没有权威映射词表；字符串或 UUID 形状校验不构成 structured mapping。迁移、运行时、契约和客户端统一把全部 hard constraint 标为 `needs_structured_mapping`，后续推荐必须阻断。
- hard confirmation fingerprint 包含全部字段和 visibility，任一字段变化都会使旧确认失效。
- FAM-003 已完成。FAM-004 的登记、双确认、隐私和五类页面能力已实现，但在权威映射与推荐安全闭环完成前仍为部分完成。FAM-005 当前只完成厨艺等级与未知值的查看/编辑，仍为部分完成。

### 契约与 OpenAPI

- `@meal-agent/contracts` 为 `0.4.0`，客户端、API、测试和 OpenAPI 共用同一事实源。
- 当前公共边界的 32 条 refine/superRefine 与 2 条原生数值规则进入稳定 rule manifest，并逐 schema 绑定；OpenAPI 同时校验 binding、稳定 ID 和行为。
- 创建库存 initial amount、消耗 amount 必须为正数；inventory event delta 必须非零，lot `currentQuantity` 可以为零。运行时、生成 schema、OpenAPI 和关键 HTTP 行为有一致性测试。
- 生成产物为 [`services/api/openapi/stage-08.openapi.json`](../services/api/openapi/stage-08.openapi.json)，覆盖 19 个 path、25 个 method operation；禁止手工维护第二份 OpenAPI。

### 客户端与 GUI

- MembersPage、ProfilePage 和 HouseholdsPage 均有真实 React 页面渲染测试，不以 core/API 调用冒充页面测试。
- 同一次进行中的动作使用同一个 idempotency key，相关输入在请求期间冻结，payload/version 漂移会被客户端拒绝；成功或明确放弃后才释放。应用重启后通过 GET 对账，不持久化敏感请求体。
- 关联确认显示安全档案名称、可见约束摘要、权限和归档/保留后果，不只显示 UUID；不可恢复档案禁用恢复按钮并解释原因，切换档案会清除档案级草稿。
- weapp 生产构建已通过。微信开发者工具 RC `2.02.2607171` 在当前 worktree 的实际入口完成二次复跑，覆盖 fake 登录、合成家庭、owner/self、五类 hard constraint 入口、未经权威映射的阻断态和 archive/restore 同 ID。截图仅保留模拟器区域，清除相机/GPS/创建时间元数据并绑定实现 tree 与构建摘要；证据见 [GUI 记录](evidence/stage-08-gui/README.md)。

## 本地验收

项目标准 Codex runtime 直接执行 `pnpm stage08:check`，退出码为 `0`；没有临时注入 `rg` 或改写 PATH。当前门禁包含：

| 层 | 通过数量/结果 |
| --- | --- |
| contracts | 23/23 |
| API unit | 12/12 |
| API HTTP | 5/5 |
| PostgreSQL migration/RLS/concurrency | 38/38 |
| client unit + page rendering | 95/95 |
| stage 07 + stage 08 双用户 E2E | 21/21 |
| OpenAPI | 19 paths / 25 operations，生成一致 |
| weapp | production build Pass |
| Markdown links | Pass |

原始 `pnpm audit --prod` 仍以退出码 `1` 报告 1 critical、1 high、8 moderate。机器门禁只接受 [`security/audit-exceptions.json`](../security/audit-exceptions.json) 中精确、截至 2026-08-08 的 local/weapp-only 例外，并扫描构建产物；任何新增、变化、过期或已消失但未清理的 advisory 均失败。证据见 [weapp advisory scan](evidence/stage-08-audit/weapp-advisory-scan.json)。例外期间 H5、外部测试、体验版和发布被阻断，不能把 gate Pass 表述为漏洞修复。

## Deferred 与下一门禁

以下仍是 `Deferred — 外部依赖`，没有被本地 fake adapter 或模拟器改记为 Pass：

- 真实 AppID/AppSecret、真实 `wx.login`/code2Session、合法 HTTPS 域名；
- 真机、多设备真实会话、体验版、审核、发布与 CI 上传凭据；
- 云 API、托管 PostgreSQL、正式 Secret 管理、WAF、备份恢复和可观测平台；
- Android、iOS、HarmonyOS 工具链、签名、实机和发布。

菜单推荐、菜谱、采购、完整做饭、Agent、报餐/投票也不在阶段 08 范围。

仓库当前没有 remote/upstream 或远端 CI 证据。这不阻断本轮本地实现；项目总控合并阶段 08 到 main 后、开始阶段 09 前必须配置受控远端与真实 CI。下一步是实施后评审和总控决定是否合并，当前分支不得自行合并 main。
