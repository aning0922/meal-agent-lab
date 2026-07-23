# Services

服务端目录边界：

- `api/`：P0 唯一部署单元；内部包含账号、家庭、库存、菜谱、购物清单、推荐和受限 Agent 工具模块。
- `agent/`：未来只有在模型调用形成明确独立隔离/扩缩容边界时启用；当前不部署。
- `worker/`：P1 OCR、通知、数据导入或长任务出现后再启用；当前不部署。

正式后端基线为 Node.js 24 LTS + Fastify 5 + PostgreSQL 18 + Drizzle/`pg` 模块化单体，见 [ADR-0002](../docs/architecture/decisions/0002-backend-runtime-framework-and-persistence.md)。只有出现清晰的独立扩缩容、故障或合规隔离需求时才拆分部署单元。
