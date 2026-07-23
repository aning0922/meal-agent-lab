# `@meal-agent/contracts`

正式客户端、服务端和测试共享的传输契约基线。包同时导出 Zod 运行时 schema 与由 schema 推导出的 TypeScript 类型；调用方不得复制一份平行 DTO。

## 边界

- 这里只放跨进程或跨应用需要共同理解的 API、实体快照、事件和错误语义。
- 数据库表、服务内部聚合、页面状态和平台 SDK 类型不放入本包。
- 所有 schema 默认拒绝未声明字段；外部输入必须在信任边界执行运行时解析。
- 标识符在 TypeScript 中使用 nominal brand，在 JSON 中仍是 opaque UUID string。
- `InventoryLot.currentQuantity` 是事件聚合后的投影；`InventoryEvent` 才是库存变化事实。
- `AuthIdentity.providerSubject` 仅供服务端身份映射，不代表它可以出现在面向客户端的响应中。

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
