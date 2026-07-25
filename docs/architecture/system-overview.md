# 系统概览

## 状态

阶段 08 审计整改已在独立分支完成本地实现，尚未合并 main。系统当前只有家庭、成员/用餐档案、硬约束和最小 exact 库存纵切；没有菜单推荐、菜谱、采购、完整做饭或 Agent。

## 逻辑边界

```text
Taro / React 微信小程序
  ├─ pages：登录、家庭、库存、成员、PersonProfile
  ├─ core flows：状态机、同动作幂等、GET 对账
  └─ platform adapter：wx 能力隔离
          │
          │ @meal-agent/contracts 0.4.0
          ▼
Fastify 5 模块化单体
  ├─ route/runtime Zod validation
  ├─ HTTP authorization + field-level redaction
  ├─ normalized idempotency policy registry
  └─ repository transaction boundary
          │
          ▼
PostgreSQL 18
  ├─ FORCE RLS + transaction-local user/household context
  ├─ restricted application role
  ├─ SECURITY DEFINER state transitions
  └─ migrations 0000 → 0001 → 0002
```

服务端保持一个部署单元，领域模块共享契约和事务边界。当前规模不支持拆微服务，也没有检索需求需要向量数据库。

## 身份、租户与 PersonProfile

内部身份保持 AuthIdentity → User → Session → Membership 四层，PersonProfile 表示实际用餐者，可以关联 Membership，也可以是 dining-only。Session 不携带家庭权限快照；每个家庭请求都以数据库当前 active membership 重新授权。

`/members` 是登录成员目录。独立 profile list/get 是 PersonProfile 的统一读取资源：

- owner 或 linked profile 本人得到完整视图；
- 其他 active 成员得到安全投影；
- `subject_and_owner` 约束在安全投影 schema 中结构性不存在；
- active/archived 明确过滤，archive/restore 复用同一 ID；
- 成员退出/移除与 linked profile 归档在同一事务；
- dining-only 关联成员必须 owner 发起、目标用户确认，不按姓名推断。

## 写入安全

HTTP 层先验证 session、家庭上下文和 capability。数据库层再用 FORCE RLS、复合外键、撤销表级 UPDATE 和窄参数 `SECURITY DEFINER` 函数阻断反向越权。普通成员无法把本人 role 更新为 owner，应用角色也不能直接更新 membership 行。

通用幂等注册表只有三类：

- `full`：家庭、库存、无敏感字段的成员命令；
- `one-time-secret`：邀请码首次可见，缓存/重放仅安全投影；
- `receipt`：PersonProfile/constraint 首次与重放只返回安全 receipt。

完整 PersonProfile 必须再走 GET 并执行当前授权/redaction。历史不安全缓存被 `0002` 转为 receipt 或 non-replayable tombstone，但保留命令完成标识。

## 契约与确定性规则

`packages/contracts` 是客户端、API、测试和 OpenAPI 的唯一 DTO/规则事实源。公共 refine/superRefine 必须出现在稳定 rule manifest：JSON Schema 能表达的生成原生约束，不能表达的生成带 rule ID 的 runtime-only 扩展。生成器、runtime 与 OpenAPI parity 测试阻止规则静默丢失。

硬约束由确定性代码和结构化标识处理。尚无正式宗教、伦理或食品安全规则映射时使用 `needs_structured_mapping`，推荐边界必须阻断，模型不得补造规则。未知饭量、参与和厨艺保持 `null`，不由客户端、迁移或模型猜测。

## 当前验证与边界

本地 `stage08:check` 覆盖 contracts、API unit/HTTP、PostgreSQL migration/RLS/concurrency、客户端页面测试、双用户 E2E、OpenAPI、weapp build、依赖例外和文档链接。开发者工具 GUI 证据见[阶段 08 走查记录](../evidence/stage-08-gui/README.md)。

依赖审计当前有一个截至 2026-08-08 的 local/weapp-only 例外；H5、外部测试、体验版和发布被阻断。真实微信、合法域名、真机、云平台、原生三端和远端 CI 均没有本轮 Pass 证据，详见[项目状态](../project-status.md)。
