# 运维资料

后续在此维护：

- 环境与发布流程；
- 数据库迁移和回滚；
- 备份、恢复和数据删除；
- 模型、OCR 与通知供应商故障降级；
- 隐私请求和安全事件响应；
- 推荐质量、食品安全和模型成本监控。

在具体部署方案确定前不预设云厂商。当前先执行[阶段 09A 本地可部署性计划](../plans/2026-07-stage-09a-local-deployability-baseline.md)，不购买服务器、不开放公网。local、test、staging、production 的强制隔离基线已经在[阶段 05 后端架构](../architecture/backend-architecture-and-contracts.md#8-环境边界)确定；实际供应商、部署拓扑、备份 RPO/RTO 和监控产品仍待验证。
