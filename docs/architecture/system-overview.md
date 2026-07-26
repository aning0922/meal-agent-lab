# 系统概览

## 状态

阶段 08 最终审计整改已在独立分支完成本地实现，尚未合并 main。系统当前只有家庭、成员/用餐档案、硬约束和最小 exact 库存纵切；没有菜单推荐、菜谱、采购、完整做饭或 Agent。

## 逻辑边界

```text
Taro / React 微信小程序
  ├─ pages：登录、家庭、库存、成员、PersonProfile
  ├─ core flows：app 级 pending-command、不可变同 key 重试
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
  └─ migrations 0000 → 0001 → 0002 → 0003 → 0004
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
- dining-only 关联成员必须 owner 通过受控数据库函数发起、目标用户确认，不按姓名推断；应用角色不能直接插入 link request 或伪造披露；
- link request 固化 profile version 与安全披露快照；名称或约束变化会提交 `profile_changed` 终态，客户端重新 GET、展示并确认；历史请求没有发起时证据时明确为 `legacy_unavailable`；
- create/list/confirm、linked self-create、member remove 和 profile archive/restore 共用 household link advisory，再按 request/profile/membership 总序锁行。

## 写入安全

HTTP 层先验证 session、家庭上下文和 capability。数据库层再用 FORCE RLS、复合外键、撤销 `memberships`/`person_profiles` 表级 UPDATE 与 link request 直接 INSERT，以及窄参数 `SECURITY DEFINER` 函数阻断反向越权。函数内部取 `clock_timestamp()`，邀请赎回固定安全 capabilities，expectedVersion 不接受 NULL；应用角色不能直接改 role、profile 身份字段或绕过双确认。

通用幂等注册表只有三类：

- `full`：家庭、库存、无敏感字段的成员命令；
- `one-time-secret`：邀请码首次可见，缓存/重放仅安全投影；
- `receipt`：PersonProfile/constraint 首次与重放只返回安全 receipt。

完整 PersonProfile 必须再走 GET 并执行当前授权/redaction。历史不安全缓存被 `0002` 转为 receipt 或 non-replayable tombstone，但保留命令完成标识。成员自退出的完成记录可在 active membership 消失后、household bootstrap 之前重放，最终落库必须影响且仅影响一条幂等记录。

客户端普通资源 GET 不是 command-status：它不能证明一个 idempotency key 的命令已执行或未执行。结果未知时，app 级协调器跨页面保留原 payload snapshot、key 和不可变 `commandId`，以 CAS 阻止旧 attempt 结算新 envelope；retry 只允许原子 `unknown → in-flight`，因此 single-flight 不依赖页面按钮。服务端 definite outcome 先结算 command envelope，再执行 typed 本地 reconciliation；storage 或导航失败只留下不发写请求、绑定原 principal 的本地恢复计划，不会把已完成命令重新标成 unknown，也不能由换账号后的会话应用旧家庭上下文。401 后同 principal 从 envelope 恢复家庭上下文；若 storage 不可用则退到不依赖家庭上下文的全局恢复页，换 principal 则同时清除旧 envelope/家庭。typed registry 还负责 self-exit 和一次性邀请码内存交付；页面订阅 coordinator，在 pending 清除后重新渲染。GET 成功只能记录与 action/key 绑定的观察，GET 失败不产生证据。协调器不持久化邀请码或私密约束；进程重启后的安全恢复要等非敏感 locator + 服务端 receipt/status 或原子 fence，属于内部后续范围和发布阻断项。

## 契约与确定性规则

`packages/contracts` 是客户端、API、测试和 OpenAPI 的唯一 DTO/规则事实源。公共 refine/superRefine 必须在 schema 定义处通过统一 helper 绑定稳定 rule ID 与 boundary；binding 与 OpenAPI schema components 从实际 Zod metadata 派生，构建配置显式保留注册模块的 side effects，不维护第二份手写 schema 映射。每个节点的 `x-meal-agent-contract-rule-ids` 承载全部绑定规则，根 manifest 再区分 `native` 与 `runtime-only`。OpenAPI 生成器只转换数值型 exclusive bound、保留已有 boolean 形式且转换幂等；标准 validator、关键字扫描、三个 zero boundary 的 runtime parity 及故意错绑反向测试阻止非法 schema 或规则静默丢失。持久化公共字符串统一拒绝 U+0000 与孤立 surrogate，按 Unicode scalar value 计数；pair-first pattern 在无 flag、`u` flag 与 Ajv 8 默认配置下都接受合法 supplementary scalar并满足 80/81 emoji 边界。

硬约束由确定性代码处理。当前没有权威 allergen、food concept、宗教、伦理或食品安全映射词表，字符串/UUID 形状校验不构成 structured mapping；所有 hard constraint 使用 `needs_structured_mapping`，推荐边界必须阻断，模型不得补造规则。`foodConceptIds`/`allergenCodes` 最多 100 项且不得重复，food concept ID 使用小写 UUIDv7；未知饭量、参与和厨艺保持 `null`。

## 当前验证与边界

本地 `stage08:check` 覆盖 contracts、API unit/HTTP、PostgreSQL migration/RLS/concurrency、客户端页面测试、双用户 E2E、OpenAPI、weapp build、依赖例外和文档链接。开发者工具 GUI 证据见[阶段 08 走查记录](../evidence/stage-08-gui/README.md)。

依赖审计当前有一个截至 2026-08-08 的 local/weapp-only 例外；官方 HTTPS relay 不跟随 redirect，并分别限制原始和解压响应流为 16 MiB。H5、外部测试、体验版和发布被阻断。真实微信、合法域名、真机、云平台、原生三端和远端 CI 均没有本轮 Pass 证据，详见[项目状态](../project-status.md)。
