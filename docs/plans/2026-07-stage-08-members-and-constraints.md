# 阶段 08：家庭成员与硬约束纵切实施计划

- 日期：2026-07-24
- 分支：`codex/stage-08-members-and-constraints`（待建）
- 基线：本地 `main` `eaedde3`（阶段 07 客户端纵切与模拟器走查修复已合并）
- 状态：已冻结（2026-07-24 用户批准方向，主负责人定稿；实施分支不得修改本范围，边界修订须在本文件追加记录）

## 范围与依据

本阶段实施"邀请加入家庭 → 成员与用餐档案 → 饮食硬/软约束（硬约束双确认）→ 字段级 response redaction"的服务端 + 客户端纵切，把推荐引擎（后续阶段）依赖的按参与者硬约束数据面建立起来，并补齐阶段 06 明确遗留的通用成员/档案读取 redaction（`Deferred — 后续范围`项在本阶段转正）。依据：

- [App 功能规格 5.2](../product/app-functional-spec.md)：FAM-002（凭邀请加入，过期/已使用/无权限语义）、FAM-003（登录成员与仅用餐档案）、FAM-004（约束分类记录，硬约束需二次确认）、FAM-008（所有者管理成员；普通成员不能修改他人的敏感约束）、FAM-010 的移除成员与退出子集
- [信息架构](../design/information-architecture.md)与低保真原型 O-02（成员与硬约束录入）、M-02（成员/邀请/隐私）
- [ADR-0003](../architecture/decisions/0003-identity-tenancy-and-api-semantics.md)：家庭租户、幂等作用域、404/403 语义、错误契约
- [`@meal-agent/contracts`](../../packages/contracts/README.md) 0.2.0 现有 `PersonProfile`、`DietaryConstraint`（hard/soft 判别、visibility、confirmedAt/confirmedByUserId）、`Membership`
- [SECURITY.md](../../SECURITY.md)与[食品安全基线](../safety/food-safety.md)：健康/宗教数据最小可见性；过敏等硬约束不得由行为推断
- [阶段 06 计划](2026-07-stage-06-backend-vertical-slice.md)（redaction 遗留项）与[阶段 07 计划](2026-07-stage-07-client-vertical-slice.md)（客户端分层与门禁模式）

不实施菜单推荐、菜谱数据、采购、做饭流程、Agent 对话、报餐/投票（FAM-009）、所有权转移与解散家庭（FAM-010 其余子集）、成员自定义角色、微信分享/真机链路、限流。

## 现状基线

- 数据层：`person_profiles` 表已存在（含 `dietary_constraints` jsonb、复合外键绑定家庭、乐观版本）；`memberships` 有 owner/member 角色与 capabilities；**没有邀请表**，`services/api` 只在创建家庭时写入 owner 档案，没有任何成员/档案/约束路由。
- 契约层：`dietaryConstraintSchema`（hard: allergy/religious/ethical/explicit_avoid/food_safety_exclusion，soft: preference；allergy 必须携带 allergenCodes 或 foodConceptIds；visibility household/subject_and_owner；confirmedAt/confirmedByUserId 已定义）、`personProfileSchema`、`safeOwnerProfileResponseSchema` 已存在；**没有**邀请、加入、成员列表、档案 CRUD、约束增删的请求/响应 schema。
- 已知欠账（阶段 06 审核记录）：通用成员/档案读取的字段级 redaction 为 `Deferred — 后续范围`；member 角色的授权/RLS 路径缺少第二成员真实用例与"单独缺一步 bootstrap"的反向测试。

## 验证环境基线

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| Git `main` | 可用 | 仓库未配置 remote；以本地 `main` `eaedde3` 为基线 |
| Node.js 24 | 可用 | `~/.nvm/versions/node/v24.14.0`（默认 shell 为 v20，命令需前置 `PATH`） |
| pnpm | 可用 | `11.9.0`（corepack） |
| PostgreSQL 18 | 可用 | Homebrew 18.4，`PG_BIN=/opt/homebrew/opt/postgresql@18/bin`；测试脚本自建一次性 cluster（已固定 `LC_ALL`/UTF8） |
| Docker | 不可用 | 非门禁前提 |
| 微信开发者工具 | 可用（GUI） | 服务端口默认关闭；自动化受合法域名校验限制（见阶段 07 记录），收口走查用 GUI 手工执行 |

## 契约与数据变更

1. `@meal-agent/contracts` 升级 **0.3.0**（`contractVersion` 同步）。新增均为 additive：
   - `HouseholdInvite` 实体（id、householdId、createdByUserId、状态 active/revoked/exhausted/expired、expiresAt、maxUses/usedCount、createdAt/version）；**明文邀请码只在创建响应出现一次**，实体不含明文与 digest。
   - `createHouseholdInviteRequest/Result`、`revokeHouseholdInviteRequest/Result`、`joinHouseholdRequest`（inviteCode 高熵字符串 22–128）`/Result`（membership + redacted household 视图）。
   - `householdMemberViewSchema`（成员列表条目：membership + 关联档案的 **redacted** 投影）与 `listHouseholdMembersResult`；redaction 不变量：`visibility = subject_and_owner` 的约束只出现在"本人或 owner 请求"的响应中，schema 层面以两种响应形状（self/owner 视图 vs household 视图）固定，household 视图结构上不可能携带私密约束（沿用 `safeOwnerProfileResponseSchema` 的 allowlist 思路，而非运行时删字段）。
   - `createPersonProfileRequest/Result`（登录成员关联档案与非登录用餐档案两种；与 membership 关联的档案每家庭每成员唯一，复用现有部分唯一索引）、`updatePersonProfileRequest`（expectedVersion）、`archivePersonProfileRequest`。
   - `addDietaryConstraintRequest`：hard 分支必须携带 `confirmation: { acknowledged: true }` 且服务端写入 confirmedAt/confirmedByUserId=操作者；soft 分支无确认要求。`removeDietaryConstraintRequest`（按 constraintId + profile expectedVersion）。不提供原地编辑（改 = 删 + 加，保双确认）。
   - `http.ts` 补全部新路由 envelope；错误码复用现有集合，不新增 code。
2. 数据库迁移 **`0001_stage_08.sql`**（首个增量迁移，验证 `migrate.ts` 多文件序列 + checksum 机制）：
   - 新表 `household_invites`：code **digest**（sha256）唯一、复合外键绑定 `(household_id, created_by_user_id)` → memberships、expiresAt ≤ 创建时间 + 7 天、max_uses 1–10、used_count 计数与状态 CHECK、FORCE RLS + 策略（owner 写、成员读自家、join 路径用 SECURITY DEFINER 函数或应用层专查 digest——实施时二选一并记录）。
   - `person_profiles` 不改结构（约束继续存 jsonb，靠 profile version 乐观并发 + 契约校验）；Drizzle schema 与 SQL 迁移保持约束名/索引名逐一对齐（阶段 06 教训）。

## 服务端路由（新增 8 个）

| 方法与路径 | 鉴权/角色 | 幂等 | 语义要点 |
| --- | --- | --- | --- |
| POST `/api/v1/households/:householdId/invites` | owner | household | 生成高熵邀请码，明文只返回一次，库存 digest；活跃邀请数上限 10 |
| GET `/api/v1/households/:householdId/invites` | owner | — | 列出邀请（无明文/digest），cursor 分页 |
| DELETE `/api/v1/households/:householdId/invites/:inviteId` | owner | household | 撤销；重复撤销 409 CONFLICT |
| POST `/api/v1/households/join` | 已认证 | user | 凭码加入；无效/过期/撤销/用尽一律 404 RESOURCE_NOT_FOUND（不泄露家庭存在性）；已是成员 409；成功计数 used_count 并发安全 |
| GET `/api/v1/households/:householdId/members` | member | — | 成员 + 档案 redacted 视图；owner 与本人见 `subject_and_owner` 约束，其余成员结构性不可见 |
| DELETE `/api/v1/households/:householdId/memberships/:membershipId` | owner 移除他人；member 仅可移除自己（退出） | household | 最后一个 owner 不可移除/退出（409）；被移除者下一请求即时 404（复用阶段 06 已验证语义） |
| POST `/api/v1/households/:householdId/person-profiles` | owner；member 仅限创建自己的关联档案 | household | 非登录用餐档案仅 owner 可建 |
| PATCH `/api/v1/households/:householdId/person-profiles/:profileId`（含约束增删子命令路由 POST/DELETE `.../dietary-constraints`） | owner 或档案本人（FAM-008：member 不得改他人约束） | household | expectedVersion 乐观并发；hard 约束写入要求显式 confirmation，缺失 422 VALIDATION 语义（400）拒绝 |

## 客户端（apps/client，沿用阶段 07 分层）

- 加入家庭：登录后入口输入邀请码，成功后切换家庭上下文；失败态按 404/409 语义呈现（不泄露信息）。
- M-02 成员页：成员列表（redacted 视图）、生成/复制/撤销邀请码（明文一次性展示 + 复制，微信分享保持 Deferred）、移除成员/退出（双确认弹层）、最后 owner 保护提示。
- O-02 档案与约束：创建/编辑用餐档案（饭量、常参与、厨艺沿用现有字段）；约束录入分硬/软两条流，**硬约束二次确认**（独立确认屏，展示后果说明后才允许提交）；`subject_and_owner` 可见性选择与说明。
- 页面状态基线适用子集：loading、failure、无权限（member 触碰 owner 操作）、并发冲突（档案 version）、重复提交、成功回退。页面零直接 `wx.*`，契约类型全部来自 `@meal-agent/contracts`。

## 实施步骤

1. 契约 0.3.0：新增上述 schema 与不变量测试；`pnpm --filter @meal-agent/contracts check` 全绿。
2. 迁移 `0001_stage_08.sql` + Drizzle schema 对齐 + `migrate.ts` 多文件与既有库增量应用验证（0000 已应用的 cluster 上仅执行 0001；空库全量两文件）。
3. 服务端邀请签发/列表/撤销 + join 命令（含并发 used_count、user 级幂等、digest 查询路径）。
4. 服务端成员列表 redaction、成员移除/退出与最后 owner 保护。
5. 服务端档案 CRUD 与约束增删（双确认校验、FAM-008 授权矩阵、household 级幂等、乐观并发）。
6. member 角色 RLS/授权反向测试补齐：第二成员真实用例全覆盖；"缺 user context / 缺 household context / 缺 membership"三类单独缺失的拒绝路径（补阶段 06 盲区）。
7. 客户端加入家庭、成员页、档案与约束流；51+ 单测基础上扩展 core 层与页面测试。
8. E2E（真实 api + 一次性 PG18）：双用户双 session 全流程——A 建家 → 签码 → B 凭码加入 → B 建自己档案并录入 `subject_and_owner` 硬约束（双确认）→ A 可见（owner）、假设第三成员 C 不可见（结构性断言）→ A 撤销邀请码、B 退出、A 移除档案 → 被移除者即时 404。
9. 新增 `stage08:check` 根脚本（environment:check + pnpm check + api/client E2E）；CI workflow 切换到该门禁。
10. 更新 README、项目状态、CHANGELOG 与本计划验证结果；密钥/真实数据/生成物扫描；仅提交阶段分支，不合并 `main`（合并走主负责人审核流程）。

## 验收门禁

| # | 门禁 |
| --- | --- |
| 1 | contracts 0.3.0 全部新增 schema strict、不变量有正反例测试；无第二份核心 DTO；变更为 additive（0.2.0 消费者不破坏） |
| 2 | 迁移序列：0000 已应用库上增量应用 0001 成功且 checksum 校验通过；空库两文件全量成功；Drizzle schema 与 SQL 约束/索引名零漂移 |
| 3 | 邀请码只存 digest、明文仅创建响应出现一次且不进日志/幂等缓存断言；过期（≤7 天）、次数（1–10）、撤销、用尽四种失效路径全部拒绝加入 |
| 4 | join：user 级幂等同 key/body 重放同一 membership；无效码 404 不泄露家庭存在性；已是成员 409；并发凭同码加入 used_count 恰好递增、不超 max_uses |
| 5 | 授权矩阵：member 不能签发/撤销邀请、不能移除他人、不能改他人档案与约束（403）；owner 全能但受最后 owner 保护（409）；跨家庭一律 404 |
| 6 | member 角色 RLS 反向测试：三类 bootstrap 单独缺失的拒绝路径 + 第二成员真实用例（补 06 盲区，不再只有 owner 行） |
| 7 | 硬约束双确认：无 confirmation 的 hard 写入 400 拒绝；成功写入记录 confirmedAt/confirmedByUserId；allergy 无结构化编码拒绝（复用契约不变量） |
| 8 | 字段级 redaction 转正：household 视图**结构上**不含 `subject_and_owner` 约束（schema 断言 + E2E 双向断言 + 日志脱敏 sentinel）；阶段 06 `Deferred — 后续范围`项在状态文档改记 Pass 并注明本阶段证据 |
| 9 | 档案乐观并发：过期 expectedVersion 409；约束增删与档案更新均幂等重放 |
| 10 | 客户端三条流页面零直接 `wx.*`；状态基线子集逐页可验证；weapp 生产构建通过（含 zod jitless 回归测试保持） |
| 11 | E2E 双用户全流程（实施步骤 8 的场景）在真实 api + PG18 上通过 |
| 12 | `pnpm stage08:check` 全绿；CI 更新并覆盖 client；`pnpm audit --prod` 无新增未记录通告；文档链接全部可解析 |
| 13 | 提交范围扫描：无密钥、无真实个人数据（过敏/宗教样例一律虚构且标注）、无生成物；GUI 模拟器走查 happy-path（加入 → 档案 → 硬约束 → 移除）通过并记录 |

## Deferred — 外部依赖

真实微信链（AppID/AppSecret、wx.login、合法域名、真机、分享邀请卡片、体验版/审核/发布）、生产云与托管数据库、Android/iOS/HarmonyOS 保持 `Deferred — 外部依赖`。邀请码在本阶段通过复制文本传递，微信分享只是未来的传输渠道，不影响服务端语义。

## 风险与既知限制

- **邀请码暴力猜测**：以 ≥128 bit 熵 + digest 存储 + 短有效期 + 次数上限缓解；请求限流（RATE_LIMITED）本阶段不实现，记录为待验证项，不得静默声称已防护。
- **jsonb 内约束的并发**：约束存于 `person_profiles.dietary_constraints` jsonb，靠档案 version 串行化；若实施中发现审计或查询需要（推荐引擎按参与者过滤），允许在边界修订中提升为独立表，但须在本文件记录并保持契约不变。
- **隐私**：宗教/健康类约束属敏感数据，redaction 采用"响应形状结构性排除"而非运行时删字段，杜绝漏删；测试夹具一律虚构样例。
- **双确认的语义边界**：confirmation 只表达"用户已理解硬约束后果"，不引入新的审批流；后续如需成员间代录确认（FAM-004 完整语义），另行修订。

## 计划验证命令

最终以实际执行结果为准：

```bash
pnpm install --frozen-lockfile
pnpm stage08:check
pnpm --filter @meal-agent/api db:migrate:test
pnpm audit --prod
git diff --check
```

完成后按阶段 06/07 相同流程收口：多视角对抗审核 → 修复 → 主负责人独立复验全绿 → 合并 `main`。
