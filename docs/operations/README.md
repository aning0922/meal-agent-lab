# 运维资料

本目录维护：

- 环境与发布流程；
- 数据库迁移和回滚；
- 备份、恢复和数据删除；
- 模型、OCR 与通知供应商故障降级；
- 隐私请求和安全事件响应；
- 推荐质量、食品安全和模型成本监控。

阶段 09A 的本地/私有测试生命周期、停止/重启、备份/恢复与清理命令见
[`stage-09a-local-test-lifecycle.md`](stage-09a-local-test-lifecycle.md)。M4 已于
2026-08-11 Accepted（`f671c51`）；M5 总控首轮整改已通过本地聚合门禁 14/14，
当前等待独立只读审计，09A 尚未总验收。

当前不预设云厂商，不购买服务器、不开放公网。local、test、staging、production 的
强制隔离基线已经在[阶段 05 后端架构](../architecture/backend-architecture-and-contracts.md#8-环境边界)
确定；实际供应商、部署拓扑、备份 RPO/RTO 和监控产品仍待阶段 09B 以后验证。
