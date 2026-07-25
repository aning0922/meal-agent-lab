# `@meal-agent/contracts`

正式客户端、服务端和测试共享的传输契约基线。包同时导出 Zod 运行时 schema 与由 schema 推导出的 TypeScript 类型；调用方不得复制一份平行 DTO。

## 边界

- 这里只放跨进程或跨应用需要共同理解的 API、实体快照、事件和错误语义。
- 数据库表、服务内部聚合、页面状态和平台 SDK 类型不放入本包。
- 所有 schema 默认拒绝未声明字段；外部输入必须在信任边界执行运行时解析。
- `ApiSuccess<T>`、`ApiResult<T>` 和 `PaginatedData<T>` 从对应 schema factory 的输出推导，不维护手写平行泛型。
- 实体标识符在 TypeScript 中使用 nominal brand，并在运行时校验 UUIDv7；JSON 消费方仍必须把它当作 opaque string。`requestId` 可使用任意标准 UUID。
- `InventoryLot.currentQuantity` 是事件聚合后的投影；`InventoryEvent` 才是库存变化事实。
- `createHouseholdResultSchema` 使用安全 owner profile 响应，只允许 household-visible constraints；私密 `subject_and_owner` 约束不能进入结果或幂等缓存。
- 手工创建批次的结果固定为同家庭、同批次的初始 `acquired` 事件，`expectedLotVersion/resultingLotVersion/lot.version` 为 `0/1/1`。
- 正式初始数量使用专用可持久化 schema：exact 需要正数 plain decimal string amount/unit，approximate 需要正数 amount/unit/confidence/originalText，qualitative 需要显式非 empty level；原始文本解析必须先由确认界面转为其中一种结构再提交。
- 初始事件规范化为 exact→exact numeric、结构化 approximate→estimated numeric、qualitative→`empty` 到当前 level；estimated delta 必须带 confidence/originalText，exact delta 禁止 confidence。
- 创建批次的 exact initial amount 与最小 consumed command 只接受正数；inventory event delta 与消耗后的 exact lot quantity 明确允许零。exact numeric amount 在 JSON 中是 plain fixed-point decimal string，与 PostgreSQL `numeric(15, 6)` 统一为最多六位小数、最大 `999999999.999999`。JSON number、指数形式和七位以上小数在 IEEE-754 转换前即被拒绝；`"1.0"` 与 `"1.000000"` 等等值别名在幂等哈希前规范化为同一字符串。正数/零值边界在 runtime、生成 schema、OpenAPI 和 HTTP 之间做等价性验证。
- `InventoryLot.dates` 同一类型最多一项；创建输入最多四项，完整 lot 快照最多九项。
- `meta.idempotency.scope` 区分创建家庭等用户级 command 与家庭内 command；`pageInfo.hasMore` 与 `nextCursor` 必须一致。
- `AuthIdentity.providerSubject` 仅供服务端身份映射，不代表它可以出现在面向客户端的响应中。
- `http.ts` 组合全部当前 HTTP envelope；服务端路由和 OpenAPI 直接引用这些 schema，不维护第二份 DTO。
- 公共边界上的 refine/superRefine 必须进入 `refinement-rules.ts` 稳定 manifest：可表达规则生成原生 JSON Schema，其他规则通过带稳定 rule ID 的 `x-meal-agent-runtime-rules` 扩展保留，并由生成器校验覆盖。
- PersonProfile/constraint mutation 只返回安全 receipt；完整资源通过授权 GET 获取。hard constraint 使用结构化 allergen/food concept 和 `mappingStatus`，未映射 hard constraint 必须阻断未来推荐。

## 命令

从仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm check
```

`check` 依次执行类型检查、运行时契约测试和声明文件构建。

## 使用

```ts
import {
  inventoryLotSchema,
  type InventoryLot,
} from "@meal-agent/contracts/inventory";

const lot: InventoryLot = inventoryLotSchema.parse(untrustedPayload);
```

契约升级遵循 API 版本策略。阶段 08 的 `0.4.0` 原地修正是仅在没有已部署环境或外部消费者时适用的预发布窄例外，详见 [ADR-0004](../../docs/architecture/decisions/0004-stage-08-pre-release-audit-closeout.md)；例外条件不成立时，删除、重命名或改变响应语义必须进入新的 API 版本。

包版本 0.2.0 记录阶段 06 的 exact 数量线上格式变更（JSON number → plain decimal string）与 approximate 数量的上限/小数位收紧。该变更发生在任何已部署消费者之前，因此按 0.x 语义以 minor 表达破坏性修订，不新开 API major；`contractVersion` 常量与包版本保持一致。

包版本 0.3.0 是阶段 08 首版纵切的历史基线。审计后 `0.4.0` 增加 PersonProfile collection/get/restore/link-confirmation、mutation receipt、nullable 用户事实、完整 hard constraint mapping 状态与 rule manifest，并原地修正不安全的 profile mutation response。仓库内 API 和客户端已同步；没有仓库外消费者。
