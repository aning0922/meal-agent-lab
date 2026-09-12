# Meal Agent Lab 功能盘点（按能力逐项）

- 盘点基准：`main` @ `23450a1`（Git 索引事实源）；分支事实另标注。
- 09P 相关：`codex/stage-09p-m2-inventory` 与 `codex/stage-09p-wp-o3` 均**未合并 main、未推送远端**（`git merge-base --is-ancestor codex/stage-09p-m2-inventory main` = NO；`git branch -r` 无 `origin/codex/stage-09p-*`）。
- 状态词仅有七个：**已实现 / 已实现但不生效 / 仅契约 / 仅分支 / 仅设计 / 阻断 / 未开始**。
- 本文件只描述“今天真实存在什么”，不描述“打算做什么”。所有结论均可由“数据口径说明”一节的路径复核。

---

## 一、部署与运维

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 服务存活探针 | 提供 liveness 探针，不触库、不鉴权 | 已实现 | `services/api/src/routes.ts:193-209`（operationId `getHealth`，返回常量 `{status:"ok"}`） | 无 |
| 服务就绪探针 | 检查数据库与迁移，不就绪返回 503 | 已实现 | `services/api/src/routes.ts:212-238`（operationId `getReadiness`，抛 `EXTERNAL_DEPENDENCY_UNAVAILABLE` 503 retryable） | 无 |
| 本地可部署基线 | Stage 09A：本地容器/部署基线可运行 | 已实现 | `git log` 23450a1「docs(stage09a): record final acceptance and main integration」已合入 main；09A 计划不含任何 FAM-xxx 标签，纯部署能力 | 仅本地基线，非产品功能 |

---

## 二、身份与登录

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 微信登录换取会话 | FAM-001：用户可登录 | 已实现 | `services/api/src/routes.ts:244-263`（`POST /api/v1/auth/wechat/exchange`）；`repository.ts:385-520`；`wechat/adapter.ts:16-38`；客户端 `apps/client/src/core/auth-flow.ts`(signIn) + `tests/e2e/stage-07-closed-loop.test.ts:52` | 真实微信链路未打通（见“阻断”） |
| 退出当前会话 | FAM-001：可退出登录 | 已实现 | `services/api/src/routes.ts:270-289`（`DELETE /api/v1/session`）；`repository.ts:941-961`（置 revoked，非 active 抛 SESSION_EXPIRED） | 无 |
| 新设备恢复所属家庭 | FAM-001：新设备可恢复家庭上下文 | 已实现 | `services/api/src/routes.ts:293-314`（`GET /api/v1/me`）；`repository.ts:963-988`；客户端 `session-store.ts`(restore) | `getMe` 客户端已封装（`endpoints.ts:83`）但页面仅 E2E 使用，无独立“我的”页接线 |
| 服务端会话与令牌 | 会话/令牌管理，只存摘要 | 已实现 | `services/api/migrations/0000_stage_06.sql:42-62`（`sessions.token_digest` 唯一）；`repository.ts:491-508,542-567` | `users`/`auth_identities`/`sessions` 三表无 RLS（见缺口） |
| 客户端登录与自动跳转 | 登录页 + 会话恢复后按上下文跳转 | 已实现 | `apps/client/src/pages/login/index.tsx:27-33,43`；`apps/client/src/core/session-store.ts`(restore) | 无 |

---

## 三、家庭与成员

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 创建家庭 | FAM-002：创建家庭并成为所有者 | 已实现 | `services/api/src/routes.ts:316-358`（`POST /api/v1/households`，需 Idempotency-Key）；`repository.ts:1030-1145` | 家庭名/时区/语言创建后无任何修改入口（SET-001 未开始） |
| 列出家庭 | FAM-002：查看所属家庭 | 已实现 | `services/api/src/routes.ts:342-363`；`repository.ts:990-1028`（仅当前用户 active membership） | 客户端硬编码 `limit:50`，无 cursor 翻页控件 |
| 通过邀请加入家庭 | FAM-002/FAM-007：凭有效邀请加入 | 已实现 | `services/api/src/routes.ts:533-558`（`POST .../join`）；`repository.ts:1725-1808`；`0003_stage_08_secondary_closeout.sql:297-394`(redeem 函数) | 无 |
| 家庭成员列表（角色差异视图） | FAM-008：成员可见性按角色区分 | 已实现 | `services/api/src/routes.ts:559-583`；`repository.ts:1810-1903`；`mappers.ts:238-259`(mapRedactedPersonProfile) | 无 |
| 成员能力（capabilities）门控 | FAM-008：按能力授权写操作 | 已实现但不生效 | 加入者的 capabilities 由函数硬编码为 `'[]'`（`0003...sql:365,378`），成员永远无任何 capability；能力门控仅覆盖 `inventory:write`（`repository.ts:643-651`）；owner 三项 capability 为固定数组（`repository.ts:1086-1090`） | `meal:write`/`shopping:write` 无任何路由消费；普通成员无法写库存 |
| 移除成员 / 自退出 | FAM-010：可移除成员、成员可退出 | 已实现 | `services/api/src/routes.ts:584-610`；`repository.ts:1905-2028`；`0004...sql:529-677`(transition_membership_status，last_owner 保护) | 无 |
| 所有权转移 | FAM-010：支持转移所有权 | 未开始 | `services/api/src/routes.ts:584-610` 仅 memberships DELETE；无 transfer 路由/命令（`apps/client/src/core/command-registry.ts:58-163` 15 命令无相关项） | 无对应实现 |
| 退出/移除时数据删除或保留规则 | FAM-010：按规则删除或保留共享数据 | 未开始 | 仅归档 linked profile（`0004...sql:529-677`）；无数据导出/删除/保留规则实现 | 无对应实现 |
| 参与本餐选择 | FAM-007：每次推荐选择实际用餐者 | 未开始 | profile 仅 `default_participation` 长期字段（`mappers.ts:80-93`）；无 per-meal participant 路由/UI | 仅长期默认值，无法逐餐选择 |
| 报餐与投票 | FAM-009（P1）：标记是否回家吃饭、候选菜单偏好 | 未开始 | 无 vote/poll 路由；无页面（`apps/client/src/app.config.ts:2-8` 仅 5 页） | 无对应实现 |

---

## 四、邀请

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 创建邀请 | 核心流程7：owner 生成有时效邀请 | 已实现 | `services/api/src/routes.ts:451-478`；`repository.ts:1522-1610`；`0001_stage_08.sql:6-33`（一次明文码，落库仅 code_digest） | 客户端只能展示刚创建那一次的码 |
| 列出邀请 | 核心流程7：查看已发邀请 | 已实现 | `services/api/src/routes.ts:479-505`；`repository.ts:1612-1656`（过期仍 active 的呈现为 expired） | 客户端 `loadInvites`（`members-flow.ts:238`）无任何页面调用（`grep loadInvites` 仅命中定义处） |
| 撤销邀请 | 核心流程7：撤销邀请 | 已实现 | `services/api/src/routes.ts:506-532`；`repository.ts:1658-1723` | 无 |
| 邀请异常处理 | 核心流程7：过期/已用/家庭已满/已属该家庭给明确结果 | 已实现 | `0003...sql:297-394`（无效/过期/撤销/用尽统一 404 不泄露存在性）；已是成员 409（`routes.ts:533-558`） | “家庭已满”无容量上限模型，仅有每户邀请数上限 10 |
| 客户端邀请列表展示 | 核心流程7：可管理已发邀请 | 未开始 | `apps/client/src/core/endpoints.ts:162` 已封装 `listHouseholdInvites`，但无页面渲染 | 已封装未接线 |

---

## 五、用餐档案与硬约束

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 用餐档案 list/get | FAM-003：linked/dining-only 统一 list/get | 已实现 | `services/api/src/routes.ts:611-663`；`repository.ts:2030-2121`；`docs/plans/2026-07-stage-08-members-and-constraints.md:20-28` | 无 |
| 创建用餐档案 | FAM-003：可加登录成员或仅用餐档案 | 已实现 | `services/api/src/routes.ts:689-716`；`repository.ts:2406-2554` | 无 |
| 更新档案字段（可未知） | FAM-003：昵称/默认饭量/参与/厨艺，跳过=未知≠否 | 已实现 | `services/api/src/routes.ts:717-745`；`0002_stage_08_audit_closeout.sql:13-38`（字段可空化）；`0003...sql:852-1415`(update 函数) | 无 |
| 归档/恢复档案（同 ID） | FAM-003：active/archived 过滤与同 ID 恢复 | 已实现 | `services/api/src/routes.ts:717-745`（operation=archive/restore）；`0004...sql:860-...`(transition 函数) | 无 |
| 档案关联双确认 | FAM-003：owner 发起 + 被关联成员确认，避免同名 | 已实现 | `services/api/src/routes.ts:664-688,804-861`；`0004...sql:245-385,387-527,679-858` | 无 |
| 饮食约束登记 | FAM-004：过敏/宗教/伦理/忌口/食品安全 + 软偏好 | 已实现 | `services/api/src/routes.ts:746-774`；`repository.ts:2699-2808`；`0004...sql:1000-1254` | 无 |
| 硬约束二次确认 | FAM-004：硬约束需二次确认 | 已实现 | `services/api/src/routes.ts:746-774`（缺 confirmation 抛 409 confirmation_required）；客户端 fingerprint 覆盖全字段（`profile-flow.ts`） | 无 |
| 删除饮食约束 | FAM-004：可移除约束 | 已实现 | `services/api/src/routes.ts:775-803`；`repository.ts:2810-2906`；`0003...sql:1310-...` | 无 |
| 硬约束权威结构化映射 | FAM-004：硬约束应映射到权威词表以支持推荐阻断 | 已实现但不生效 | 契约恒为字面量 `z.literal("needs_structured_mapping")`（`packages/contracts/src/identity.ts:230`）；DB 迁移以表级 CHECK 强制全部 hard 约束只能取该值（`0003...sql:87-121,1264`）；客户端写死文案（`apps/client/src/pages/profile/index.tsx:1182`） | **无任何权威 allergen/food-concept/宗教/伦理词表**；`food_concept_id` 是无外键裸 uuid（`0000_stage_06.sql:120`）。产品文档自述 FAM-004 **部分完成、不得声称完成**（`docs/project-status.md:99`） |
| 厨艺等级查看/编辑 | FAM-005：记录做饭水平 | 已实现 | `0000_stage_06.sql:100-101`(cooking_skill 枚举，可 NULL=未知)；随 profile update 路由 | 仅四档+未知 |
| cooking-technique 词表 | FAM-005：记录“不会或不愿执行的技术” | 未开始 | 契约层无对应模块；仅治理类别字符串 `cooking_technique`（`packages/domain/src/types.ts:15`，datasetKind 枚举值）与合成 fixture（`data/samples/stage09p-m0/valid/cooking-technique.json`），均在分支；无 cooking-technique schema、无表、无路由 | 产品文档自述 FAM-005 **部分完成**（`docs/project-status.md:99`） |
| 厨房设备 | FAM-006：维护灶具/烤箱/空气炸锅等 | 未开始 | `mappers.ts:80-93`(PersonProfileRow 无设备字段)；无 equipment 路由/表/UI | 无对应实现 |
| 硬约束安全脱敏投影 | FAM-004：owner/self 全量、他人脱敏 | 已实现 | `mappers.ts:238-259`(mapRedactedPersonProfile，仅保留 visibility=household 约束)；`routes.ts:638-663` | 无 |

> 说明：`docs/product/app-functional-spec.md:63`/`:64` 与阶段 08 计划的“部分完成”自述与代码一致——FAM-003 可称完成，FAM-004/FAM-005 不得称完成。

---

## 六、库存

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 快速添加批次 | INV-001：搜索/手填食材并快速入库 | 已实现 | `services/api/src/routes.ts:394-421`（`POST .../inventory-lots`）；`repository.ts:1185-1337`；客户端 `apps/client/src/pages/inventory/index.tsx`(handleCreate) | 客户端只能手工新增，无搜索选择 |
| 批次数量形态 | INV-002/PD-005：模糊/精确/定性数量 | 已实现 | `0000_stage_06.sql:149-193`（exact/approximate/qualitative CHECK）；`repository.ts:1196-1201` | 非精确批次不可消耗（见下） |
| 储存位置 | INV-002：储存位置 | 已实现 | `0000_stage_06.sql:117-194`(pantry/refrigerated/frozen/other)；`repository.ts:1288-1320` | 无默认位置偏好（SET-001 未开始） |
| 批次日期字段与来源（API/DB） | INV-002：购买日/标签到期日，区分来源与置信度 | 已实现 | `repository.ts:1220-1230,1282`（dates 含 kind/value/source/capturedAt）；契约 `packages/contracts/src/inventory.ts:119-137` | 日期被存储但从不据以行动（无到期排序/筛选/提醒） |
| 客户端日期录入 UI | INV-002：用户可填购买日/标签到期日 | 未开始 | `apps/client/src/core/inventory-flow.ts:156`(`dates: []` 恒发)；`apps/client/src/pages/inventory/index.tsx:502-620` 无日期控件 | 「明确日期 vs 规则估算」入口在客户端不存在 |
| 开封状态 | INV-002：记录开封状态 | 未开始 | 全仓 migrations 与 `schema.ts` 无 `opened`/`开封` 列；日期 kind 无“开封后期限”（`packages/contracts/src/inventory.ts:119-137`） | 无存储列、无写路径、无路由；事件**类型** `opened` 已在契约声明（`packages/contracts/src/inventory.ts:170-181`）但无任何生产者 |
| 库存总览列表 | INV-003：库存总览 | 已实现 | `services/api/src/routes.ts:367-393`（`GET .../inventory-lots`，游标分页）；`repository.ts:1147-1183` | 无搜索/筛选/排序参数 |
| 搜索与筛选 | INV-004：按名称/位置等搜索筛选 | 未开始 | `routes.ts:367-393` 无查询参数；客户端 `limit:50` 无筛选控件 | 无对应实现 |
| 单批次详情与历史 | INV-005：批次详情与历史 | 未开始 | 仅有 list/create/consume 三条库存路由（`routes.ts:367-450`），无单批次 GET、无事件列表 | 无对应实现 |
| 快捷状态操作 | INV-006：快捷状态操作 | 未开始 | 无对应路由/UI | 无对应实现 |
| 常备调味品 | INV-007：有/快没了/没有，仍参与过敏校验 | 仅契约 | 契约 `packages/contracts/src/seasoning-v1.ts:29,127-166`（observe_seasoning），仅在 `codex/stage-09p-m2-inventory` 分支、经 subpath 导出（main 无此模块）；`git grep 'seasoning-v1' -- services apps` 无匹配 | 分支未合并；无表、无路由、无消费者；仍不参与任何过敏校验 |
| 不确定性处理（未知≠没有） | INV-008：未知≠没有 | 已实现 | 数量形态含 qualitative（`0000...sql:149-193`）；档案字段可空=未知（`0002...sql:13-38`） | “未知不参与推荐/不自动填否”的推荐侧语义无落地（推荐未开始） |
| 买后入库 | INV-009/SHOP-005：已买→待确认→正式库存 | 未开始 | 无购物侧来源；`inventory_lots.origin` 恒 `'manual'`（`repository.ts:1267`） | 缺购物清单来源链路 |
| 语音录入 | INV-010（P1） | 未开始 | 无语音依赖/路由/UI | 无对应实现 |
| 条码/标签/小票识别 | INV-011（P1） | 未开始 | 无 OCR/条码路由/依赖 | 无对应实现 |
| 冰箱图片辅助识别 | INV-012（P2） | 未开始 | 无对应路由/模型接线 | 无对应实现 |
| 库存消耗/扣减 | 核心流程5写路径：按菜单消耗并防负库存 | 已实现 | `services/api/src/routes.ts:422-450`（`POST .../:lotId/events/consumed`）；`repository.ts:1339-1485`（乐观版本校验 + SQL `WHERE current_quantity_amount>=consumed`） | 仅支持 `exact` 且单位匹配 |
| 非精确批次消耗 | 核心流程5：模糊数量批次也可扣减 | 未开始 | 客户端只对 `exact` 渲染消耗按钮（`apps/client/src/pages/inventory/index.tsx:806-810`）；逻辑层拒绝非 exact（`inventory-flow.ts:271`） | 契约只接受 exact |
| 库存事件溯源（不可覆盖历史） | AGENTS.md 底线：变更用事件记录，不覆盖历史 | 已实现 | `0000_stage_06.sql:196-275`（events 只 SELECT+INSERT，唯一约束防重放）；`repository.ts:1299,1448` | 无 |
| 批次来源 origin（采购/剩菜/导入） | 核心流程2/4/5：区分入库来源 | 已实现但不生效 | 枚举含 `shopping_confirmation/leftover/confirmed_import`（`0000...sql:139-140`），但插入恒 `'manual'`（`repository.ts:1267`），且无任何 UPDATE origin 路径 | 三个来源值不可达，入库来源建模是死的 |
| 库存事件类型覆盖 | 契约声明 10 种事件类型 | 已实现但不生效 | 契约声明 10 种（`packages/contracts/src/inventory.ts:170-181`），实际只写 `acquired`/`consumed`（`repository.ts:1299,1448`）；source 只写 `manual_confirmation` | opened/frozen/thawed/discarded/adjusted/corrected 及 meal_completion_confirmation 等不可达 |
| 丢弃批次 | 核心流程6：丢弃并更新库存 | 未开始 | `state='discarded'` 枚举存在（`0000...sql:122`）但无任何写路径；consume 只会置 `depleted`（`repository.ts:1412-1414`） | 丢弃（核心流程6）无写路径 |
| 食品安全评估 | MVP 安全底线：高风险食材不得进入推荐 | 已实现但不生效 | `safetyAssessment` 恒为 `{status:'unknown', reasonCodes:[], policyVersion:'stage-06-manual-v1'}`（写入 `repository.ts:1261-1267`；读出 `mappers.ts:318-323`） | **无任何评估/更新代码**；API 测试从未断言该字段（`services/api/tests` 内 safety 仅 1 次且是 kind 字符串）——食品安全“存了但不执行” |
| food_concept 权威词表 | FAM-004 依赖的权威食物概念 | 未开始 | `inventory_lots.food_concept_id` 是无外键裸 uuid（`0000...sql:120`）；全仓无 `CREATE TABLE food_concept` | 无表、无词典、无非空写入路径 |

---

## 七、菜单与推荐（P0 闭环核心）

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| P0 主干低保真原型（非正式客户端） | 可点击原型覆盖整条 P0 主干：登录与恢复→首批食材→今天吃什么→建议组合与可选菜→共享采购→已买待入库→做饭→完成与库存确认 | 仅设计 | `apps/meal-agent-prototype/app/page.tsx`（`composeMenu`:644、“今天吃什么”:121、采购/做饭/扣减原型屏）；`apps/meal-agent-prototype/README.md`（明言非正式客户端，不连接真实账号/库存/同步）；2026-07-23 stage-05 收口冻结（`4adfaab`）、未列入 `pnpm-workspace.yaml`、不进任何门禁 | 纯设计/评审产物，非产品能力；不提供任何真实链路，无对应 API/DB |
| 菜单推荐闭环 | REC-001..009 / 核心流程3：本餐条件→确认→建议组合与可选菜→确认本餐再校验 | 未开始 | `services/api/src/routes.ts:193-861` 25 个 operationId 中无 recommendation/menu/meal；无对应表（migrations 无 recipe/meal/recommendation） | API/DB/客户端 0 代码 |
| 菜品/餐次/推荐契约 | 提供 Recipe/Meal/Recommendation 形状 | 仅契约 | `packages/contracts/src/meals.ts:28-184`，经 barrel 导出；`git grep 'recipeSchema\|recommendationSchema\|mealSchema' main -- services apps` 仅命中 openapi JSON | services/apps **零消费者**（无路由、无表、无客户端）；但**非零导入者**——`packages/contracts/src/refinement-bindings.ts:7` 有包内副作用 `import "./meals.js"`；OpenAPI 产物含 `ContractRule.mealSchema`/`recipeSchema`/`recommendationSchema` 组件 |
| 推荐快照（immutable snapshot） | data-model 描述 4 类不可变推荐快照 | 仅设计 | `docs/domain/data-model.md`（仅设计描述，无实现；09P 增补章节明言本阶段不新增 API/SQL） | 无实现 |
| 周菜单/个性化学习 | REC-010/011（P1） | 未开始 | 无对应实现 | 无对应实现 |

---

## 八、采购

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 共享购物清单 | SHOP-001..005 / 核心流程4：缺少项入清单、合并、多人勾选、已买待入库 | 未开始 | `routes.ts:193-861` 无 shopping 路由；migrations 无 shopping 表；owner `shopping:write` capability 无路由消费（`repository.ts:1086-1090`） | API/DB/客户端 0 代码 |
| 购物清单契约 | 提供 ShoppingItem/来源合并形状 | 仅契约 | `packages/contracts/src/shopping.ts:16-112`；`git grep 'contracts/shopping' main -- services apps` = NONE | services/apps **零消费者**；但**非零导入者**——`packages/contracts/src/refinement-bindings.ts:10` 有包内副作用 `import "./shopping.js"`；OpenAPI 产物含 `ContractRule.shoppingItemSchema` 组件；`apps/meal-agent-prototype` 的购物 UI 是独立原型，不导入本契约 |
| 分派/历史/比价下单 | SHOP-006..008（P1/P2） | 未开始 | 无对应实现 | 无对应实现 |

---

## 九、做饭与消耗

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 做饭模式（开始前检查/分步/暂停恢复） | COOK-001..003 / 核心流程5 | 未开始 | `routes.ts:193-861` 无 cook/steps 路由；客户端无做饭页（`app.config.ts:2-8` 仅 5 页） | 页面重载不自动完成/扣减的语义无实现 |
| 完成与库存确认 | COOK-004 / PD-015：全部/部分/没做，确认前不写库存 | 未开始 | 仅有底层 `inventory consumed` 事件（`routes.ts:422-450`），无“全部/部分/没做”确认页后端 | 无对应实现 |
| 剩菜回库 | COOK-005 / 核心流程5 | 未开始 | `origin='leftover'` 不可达（`repository.ts:1267`） | 无写路径 |
| 餐后反馈 | COOK-006 / 核心流程5 | 未开始 | 无反馈路由/表/UI | 无对应实现 |
| 多菜并行/计时器/语音陪做 | COOK-007/008（P1） | 未开始 | 无对应实现 | 无对应实现 |

---

## 十、Agent

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| Agent 二级页与上下文入口 | AGT-001/002（P0） | 未开始 | 无 Agent 路由/页面；token/UI 中无 Agent 入口 | 无对应实现 |
| 工具结果可见与写操作确认 | AGT-003/004（P0） | 未开始 | 无工具调用/确认机制 | 无对应实现 |
| 对话纠错与记忆 | AGT-005/006/007 | 未开始 | 无对应实现 | 无对应实现 |

---

## 十一、提醒 / 历史 / 设置

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 应用内临期提醒 | REM-001（P0）/ 核心流程6 | 未开始 | `inventory_lots.dates` 只存不读；`grep expiry/临期` 于 src 未命中库存日期，仅命中会话/邀请过期 | 无到期排序/筛选/提醒 |
| 外部通知 | REM-002（P1） | 未开始 | 无 notification 表/路由 | 无对应实现 |
| 餐食历史 / 浪费记录 | HIST-001/002（P1） | 未开始 | migrations 无 history 表 | 无对应实现 |
| 家庭设置 | SET-001：名称/地区/时区/默认人数/计量偏好/储存位置 | 未开始 | `households` 有 locale/timezone 列但无 `UPDATE households` 语句；客户端创建时硬编码 Asia-Shanghai/zh-CN | 无修改入口 |
| 通知设置 | SET-002（P1） | 未开始 | 无对应实现 | 无对应实现 |
| 隐私与数据导出/删除 | SET-003（P0） | 未开始 | 无导出/删除接口；`users.status='deletion_pending'` 不可达 | 无对应实现 |
| 操作记录 | SET-004（P0）：操作者/时间/纠正入口 | 未开始 | 无通用 audit 表；仅 `inventory_events`/`idempotency_records` 局部记录 | 无对应实现 |

---

## 十二、客户端（apps/client 纵向切片）

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 5 页客户端切片 | 登录/家庭/库存/成员/档案页面可跑 | 已实现 | `apps/client/src/app.config.ts:2-13`（5 页）；15 条 typed 写命令（`command-registry.ts:58-163`）；`tests/unit/page-rendering.test.tsx` 渲染 + `tests/e2e/*` 真实 API+PostgreSQL | 仅覆盖阶段 08 范围 |
| 底部导航 / 第四导航“我的” | PD-013：4 导航模型，第四导航=我的 | 未开始 | `app.config.ts` 无 `tabBar` 字段；全部跳转靠 reLaunch/navigateTo 按钮 | 与 PD-013 不符 |
| 幂等 pending 命令协调器 | 跨页幂等、单飞重试、会话切换恢复 | 已实现 | `apps/client/src/core/idempotency.ts:107,284,312,322,371`；`components/pending-command-recovery.tsx`；`app.tsx`；`tests/unit/app-services.test.ts:489,536` | 该类注释明言“仅驻内存” |
| 列表分页 | 家庭/批次/邀请列表可翻页 | 未开始 | `loadHouseholds/loadInventoryLots/loadInvites` 固定 `limit:50`；页面仅显示“仅显示前 50 个…分页浏览不在本阶段范围” | 无 cursor 控件 |
| `getMe` 封装接线 | 客户端可读取当前用户 | 已实现但不生效 | `apps/client/src/core/endpoints.ts:83` 定义了 `getMe`，但 `src` 内无页面/流程调用，仅 E2E 使用 | 已封装未接线 |
| 进程重启后未决命令恢复 | 重启后安全恢复未决写命令 | 阻断 | `apps/client/README.md:23` 明说“进程重启后的安全恢复尚未实现…阻断发布”；`idempotency.ts` 仅驻内存 | 需服务端 command-status/receipt 或原子 fence；普通 GET 不能替代 |
| 真实微信链路与发布 | 真实登录/合法域名/真机/发布 | 阻断 | `apps/client/project.config.json:5`（touristappid）；`README.md:50`（依赖例外关闭前 H5/外部测试/体验版/发布全部阻断）；E2E 用本机 fake 微信适配器（`tests/e2e/stage-07-closed-loop.test.ts:31-34`） | 依赖例外未关闭，处于 Deferred |

---

## 十三、契约与安全底座（横向）

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| 幂等写模型（服务端） | MVP 阻断条件⑤：重试/重复点击不产生重复事件 | 已实现 | `repository.ts:233-289,690-939`（Idempotency-Key 抢占 + request_hash 比对 + 响应策略）；`inventory_events` 唯一约束二次幂等 | `idempotency_records.expires_at`（30 天）写入但从不被读取/GC（`repository.ts:856`；重放查询 `702-719` 无过滤） |
| 错误模型 | 声明完整错误码集合 | 已实现但不生效 | 契约声明 18 码（`packages/contracts/src/api.ts:7-47`）；`SAFETY_BLOCKED(422)`/`RATE_LIMITED(429)`/`PRECONDITION_FAILED(412)` 在整个 `services/api/src` 无 throw 点（仅 `errors.ts:41-52` 的消息映射）；`commonErrorResponses` 未列 412/422/429（`routes.ts:139-151`） | 三码既不可产生也不被逐路由文档化 |
| 行级安全（RLS） | 家庭/成员数据隔离到底层 | 已实现 | 8 张表 FORCE RLS（`0000...sql:392-403`；`0001...sql:196-197`；`0002...sql:432-433`；测试 `tests/database/stage06.database.test.ts:296-311`） | 见下条缺口 |
| RLS 缺口（三表无 RLS） | 所有用户数据行级兜底 | 未开始 | `users`/`auth_identities`/`sessions` 无 ENABLE/FORCE RLS，却授 `meal_agent_app` SELECT/INSERT/UPDATE 全权（`0000...sql:546-553` 授权 vs `392-403` 仅 6 表 ENABLE） | 与其余 8 张 FORCE RLS 表不一致；应用层按 token_digest 隔离，无 DB 层兜底 |
| 全局页面状态基线 | 每个 P0 页面定义 9 类状态 | 仅设计 | `docs/design/p0-page-state-baseline.md` 存在（`docs/design/` 目录） | 无实现落地 |
| 关键观测指标与 P0 埋点事件 | 8 个 P0 事件 + 关键指标 | 未开始 | 无事件发射代码（`grep household_created` 于 src 仅命中一个索引名巧合）；定义仅见 `docs/product/mvp.md:85-101`、`app-functional-spec.md:183-198` | 无埋点实现 |
| OpenAPI 产物 | 由真实路由生成的接口文档 | 已实现 | `services/api/openapi/stage-08.openapi.json`（19 path / 25 operation / 34 组件）；门禁 `scripts/check-openapi.ts`（校验 requiredPaths、version、规则绑定） | `info.description` 仍为 “Stage 08 audited modular-monolith API”，与当前 09P 阶段脱节 |

---

## 十四、09P 分支产物（全部未合并 main、未推送远端）

| 能力 | 规格 | 实际状态 | 证据 | 阻塞或缺口 |
| --- | --- | --- | --- | --- |
| @meal-agent/domain 纯领域包（M0 治理核心） | 治理信封/规范摘要/引用与 hard-mapping fail-closed 解析 | 仅分支 | `codex/stage-09p-m2-inventory` 新增 `packages/domain/src/{types,decode,canonical,validation,catalog,resolution,index}.ts`（main 上 `packages/domain` 只有 `.gitkeep`）；`scripts/run-stage09p-m0-check.mjs` | 分支未合并；**无任何 services/apps 运行时消费者**（`git grep '@meal-agent/domain'` 仅 docs/root/check 脚本） |
| @meal-agent/domain M1 家庭餐桌安全求值 | 对一桌菜品按硬约束评估安全 | 仅分支 | `packages/domain/src/resolution.ts:1871`(evaluateHouseholdDishSafety)；测试 `tests/household-safety.test.ts`（≈292 test） | 分支未合并；且对真实数据**恒不返回 allowed**：唯一 source pack 为 `draft`（`data/reference/ingredients/stage09p-m1-household-safety-source-pack.json`），trust allowlist 写死为空数组（`resolution.ts:311`）；只有 `__testOnly*` 合成 seam 能走到结论 |
| 09P 新契约（inventory-v2 / seasoning-v1 / stage09p-input） | 库存 V2 命令/历史/replay、常备调味品观测、共享输入边界 | 仅分支 | `packages/contracts/src/inventory-v2.ts`、`seasoning-v1.ts`、`stage09p-input.ts`、`contract-rule-registry.ts`（均 A 状态，仅分支）；`packages/contracts/src/index.ts` 未导出它们；`git grep -n 'inventory-v2\|seasoning-v1' -- services apps` = NONE | 无路由、无 DB 表、无 service/client 消费者；refinement-bindings 显式不加载 M2 |
| R7-B / R7-C shadow design | checkpoint 认证、request-stream/route 集成设计 | 仅设计 | `codex/stage-09p-m2-inventory:docs/evidence/stage-09p-m2/r7b-shadow-design.md`、`codex/stage-09p-m2-inventory:docs/evidence/stage-09p-m2/r7c-shadow-design-r1.md`；`codex/stage-09p-m2-inventory:docs/project-status.md:13,15,17`（分支版本；main 上该文件无 09P 内容）（SHADOW_DESIGN_ACCEPTED / IMPLEMENTATION_BLOCKED，T01–T50 执行数 0） | 无 SQL/RLS/路由/流式/client 代码 |
| WP-O1..O4 决策材料 | 命令边界/记录权威/公开语义等设计决策 | 仅设计 | `.local/worktrees/wp-o3/docs/evidence/stage-09p-m2/wp-o{1,2,3,4}-*.md`（WP-O3/O4 仅在 `codex/stage-09p-wp-o3`，提交 e41a441/54f99ea）；WP-O4 自述 `DESIGN_ONLY`，不冻结任何 DTO/route/DB | 不授权实现、不冻结 contract |
| 09P source pack / fixtures / scope guards | 合成 fixtures、JSON Schema、范围守卫 | 仅分支 | `data/samples/stage09p-m0/`（5 valid + 10 invalid）、`data/schemas/governance-*.schema.json`；`scripts/check-stage09p-m0-scope.mjs`、`check-stage09p-m1-scope.mjs` | 分支未合并；仅供分支自证 |

> 关键事实：`git diff --stat main codex/stage-09p-m2-inventory -- services apps` 为空——**09P 分支对 API 与客户端零改动**。所有用户可见能力（FAM/REC/INV/COOK/SHOP/AGT/HOME 等）在 09P 分支上同样无落点。

---

## 整体结论

**这个产品今天能真正做的事，用一句话说：能登录、能建家/加入、能管成员与用餐档案、能录入一笔库存批次并对“精确数量”批次做一次扣减。**

具体地，端到端可用的只有一条**“家庭与库存台账”**链路：微信登录换取会话 → 创建家庭或凭邀请码加入 → 查看/邀请/移除成员 → 创建用餐档案（linked 或仅用餐）、编辑昵称/饭量/参与/厨艺、归档恢复、登记与移除饮食约束（硬约束带二次确认）→ 手工新增库存批次（名称/位置/exact|approximate|qualitative 数量）→ 对精确批次消耗一次。这条链路在 API、数据库（8 表 FORCE RLS + 13 个受控函数）、契约与微信小程序客户端三层都真实落地，并被单元测试、数据库测试与真实 API+PostgreSQL E2E 覆盖。

**但产品最核心的那件事——“今天吃什么”——完全不存在。** 菜单推荐闭环（REC-001..009、核心流程 3）、共享购物清单（SHOP、核心流程 4）、做饭与完成确认（COOK、核心流程 5）在 API、数据库、契约消费者、客户端四处均为 0 代码；首页/提醒/历史/设置/Agent 同样为 0。也就是说，MVP 所说的“首次获得价值”“快速入库→得到菜单→采购→做饭→扣减”的闭环，目前只有最左端的“录入”和最右端的一次性“扣减”两段，中间整条断了。

**食品安全底线“存了但不执行”。** 库存批次的 `safetyAssessment` 恒为 `unknown`，硬约束的 `mappingStatus` 恒为 `needs_structured_mapping`——这是**刻意的 fail-closed**（无权威词表就不许声称映射、不许放行），本身是诚实的；但它同时意味着**今天没有任何一条过敏原/禁忌能被机器执行地阻断推荐**，因为推荐器根本不存在。产品文档对此的自述（FAM-004/FAM-005 部分完成、不得声称完成）与代码一致，未夸大。

**09P 目前没有产生任何用户可见能力。** 所有 09P 产物都在未合并、未推送的分支上：`@meal-agent/domain`（M0 治理核心/m1 家庭餐桌安全求值）、`inventory-v2`/`seasoning-v1` 新契约、R7-B/R7-C 与 WP-O1..O4 设计材料。M1 的公开评估器对真实数据恒不返回 `allowed`（source pack 是 draft、trust allowlist 写死为空），只有测试 seam 能走到结论；`inventory-v2`/`seasoning-v1` 无路由、无表、无消费者。用一句话概括 09P：**把“将来能安全地做判断”所需的地基与纪律建起来了，但一块用户看得见的砖还没砌。**

**一句话决策参考：** 距离“一个家庭今晚能用它决定吃什么并据实扣减库存”，缺的不是打磨，而是推荐、采购、做饭三条 P0 主干从零到一；现有能力是一套可用但孤立的家庭/档案/库存台账，可作为主干的地基，但自身尚不构成产品价值闭环。

---

## 数据口径说明

本文件的状态判定来自以下文件与命令，读者可逐条复现。

**规格来源（`main` @ 23450a1）：**
- `docs/product/app-functional-spec.md`（功能编号 HOME/FAM/INV/REC/SHOP/COOK/AGT/REM/HIST/SET、P0 埋点事件 `:183-198`）
- `docs/product/core-user-flows.md`（7 条核心流程，状态行 `:4`）
- `docs/product/mvp.md`（11 条必须具备 `:10-22`、P0 故事 `:27-38`、验收场景 `:40-44`、8 条发布阻断 `:46-59`、P1/P2 `:61-74`、指标 `:85-101`）
- `docs/product/open-decisions.md`（PD-001..015）、`docs/product/product-brief.md`、`docs/design/p0-page-state-baseline.md`、`AGENTS.md:23-31`、`docs/safety/food-safety.md:13-26`
- `docs/plans/2026-07-stage-08-members-and-constraints.md:20-49`（FAM-003/004/005 自述完成状态）、`docs/project-status.md:99`

**实际状态来源：**
- API 路由与操作：`services/api/src/routes.ts`（`grep -n 'operationId:'` 得 25 条，行 197–837）
- 仓库实现与写死值：`services/api/src/database/repository.ts`（能力 `1082-1090`、批次插入 `1261-1267`、消耗 `1339-1485`、幂等 `233-289,690-939`）、`services/api/src/database/mappers.ts`
- 数据库：`services/api/migrations/0000..0004`（表/RLS/函数/CHECK）；缺 RLS 依据 `0000_stage_06.sql:546-553` vs `392-403`
- 契约：`packages/contracts/src/{api,identity,inventory,meals,shopping,primitives,refinement-*}.ts`；`openapi/stage-08.openapi.json`（python 统计 paths=19/ops=25/components=34）
- 客户端：`apps/client/src/app.config.ts`、`src/core/command-registry.ts`、`src/core/{endpoints,inventory-flow,idempotency,session-store}.ts`、`src/pages/*/index.tsx`、`apps/client/README.md`
- 错误码未抛出：`grep -rn 'SAFETY_BLOCKED\|RATE_LIMITED\|PRECONDITION_FAILED' services/api/src` 仅命中 `errors.ts:41-52`
- 埋点未实现：`grep -rniE 'household_created\|recommendation_generated\|inventory_deduction_confirmed\|meal_completed' services/api/src apps/client/src packages/contracts/src` 仅命中一个索引名

**分支事实（`codex/stage-09p-m2-inventory`、`codex/stage-09p-wp-o3`）：**
- 合并状态：`git merge-base --is-ancestor codex/stage-09p-m2-inventory main` → NO；`git branch -r` 仅 `origin/main` 与 `claude/stage-09a-*`
- 零产品改动：`git diff --stat main codex/stage-09p-m2-inventory -- services apps` 为空
- 新产物：`git diff --name-status main codex/stage-09p-m2-inventory -- packages/contracts packages/domain`
- domain M1 惰性：`packages/domain/src/resolution.ts:311,665,1871,1950-1962`；source pack `data/reference/ingredients/stage09p-m1-household-safety-source-pack.json`（`lifecycleStatus: draft`）
- 设计材料：`.local/worktrees/wp-o3/docs/evidence/stage-09p-m2/wp-o{3,4}-*.md`、`docs/project-status.md:11-21`

**状态判定口径：** “已实现”=代码存在且被路由/页面/流程接线并有测试；“已实现但不生效”=代码存在但产出恒为占位/固定值或无消费方；“仅契约”=Zod schema 存在但无路由/表/消费者；“仅分支”=只存在于未合并分支；“仅设计”=仅设计文档；“阻断”=有指明原因无法实现；“未开始”=无对应代码。凡未能建立证据者，本文件标注为“未开始”并在缺口中说明，不做推测性上调。
