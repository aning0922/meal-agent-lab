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
- 正式初始数量使用专用可持久化 schema：exact 需要正数 amount/unit，approximate 需要正数 amount/unit/confidence/originalText，qualitative 需要显式非 empty level；原始文本解析必须先由确认界面转为其中一种结构再提交。
- 初始事件规范化为 exact→exact numeric、结构化 approximate→estimated numeric、qualitative→`empty` 到当前 level；estimated delta 必须带 confidence/originalText，exact delta 禁止 confidence。
- 阶段 06 最小 consumed command 只接受 exact 正数；exact numeric amount 与 PostgreSQL `numeric(15, 6)` 统一为最多六位小数、最大 `999999999.999999`。成功结果必须返回 exact lot quantity，以及单位相同、`source = manual_confirmation` 的 exact numeric consumed event。exact 0/depleted 是合法结果；数量减法和前一版本快照由阶段 06 数据库集成测试验证。
- `InventoryLot.dates` 同一类型最多一项；创建输入最多四项，完整 lot 快照最多九项。
- `meta.idempotency.scope` 区分创建家庭等用户级 command 与家庭内 command；`pageInfo.hasMore` 与 `nextCursor` 必须一致。
- `AuthIdentity.providerSubject` 仅供服务端身份映射，不代表它可以出现在面向客户端的响应中。
- `http.ts` 组合阶段 06 的健康、登录、会话、`me`、家庭和库存 HTTP envelope；服务端路由和 OpenAPI 直接引用这些 schema，不维护第二份 DTO。能用 JSON Schema 表达的跨字段不变量使用 `oneOf`，其余 Zod refinement 通过 `x-zod-refinements` 保留在 OpenAPI 审查产物中。

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

契约升级遵循 API 版本策略：同一 major 内只做兼容性新增；删除、重命名、改变必填性或语义时必须进入新的 API major，并更新 ADR。
