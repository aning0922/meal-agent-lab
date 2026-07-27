-- 阶段 09A / M2A：目标数据库 ACL 基线——**containment 阶段**（database scope）。
--
-- 全新安装时它在 owner handoff 之后、migration 之前运行；恢复时它在 pg_restore
-- 之后、migration 之前运行。两条路径的共同点是：此刻数据库里的授权可能来自
-- 任何地方（dump 带回来的、历史遗留的、第三方 grantor 授予的），因此这一阶段的
-- 职责是**收敛**——把一切策略不允许的授权按真实 grantor 撤销，再只重建允许项。
-- 备份角色的表级 SELECT 属于 migration 之后的 final 阶段（见 03-backup-grants.sql），
-- 这里不建立，也因此不会在 migration 期间多留一份可读全库的授权。
--
-- 授权本身由 ledger 感知的 manifest 与可移植策略描述：
--   事实源  services/api/src/database/authorization-manifest.ts
--   共享观察 services/api/src/database/authorization-projection-sql.ts
--   可移植策略 services/api/src/database/authorization-policy-sql.ts
--   收敛    generated/authorization-converge.generated.sql
--   断言    generated/authorization-verify.generated.sql
-- 两个 generated 文件都禁止手改，由 `manifest:check` 逐字节校验。
--
-- 本文件是**薄入口**：它只固定阶段 GUC 与事务边界。R8B 起，全部致命前置条件
-- （managed schema 齐全、六个项目角色存在、归属正确、登录角色不拥有任何对象、
-- routine 指纹与未知 routine、manifest 要求的对象存在、未知 defaclobjtype、
-- **任意** Large Object、无法由 ACL mutation 修复的 membership 漂移）都由
-- generated 收敛块在**任何 mutation 之前**统一执行。放在这里再手写一份只会
-- 与新策略互相矛盾——例如旧的 LO 检查只覆盖「项目角色拥有的 LO」，而新策略
-- 对任意 LO 都 fail closed，两者会让 acl 与 grants 对同一批漂移给出不同理由。

\set ON_ERROR_STOP on

-- generated 收敛/断言块通过这个带命名空间的 GUC 得知当前阶段。
SELECT set_config('meal_agent.acl_phase', 'containment', false);

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 授权收敛（生成文件，禁止手改）。
--    先执行全部致命前置条件，再按真实 grantor 撤销一切策略不允许的授权与可再
--    授予标志，然后以 canonical grantor 重建允许项，最后按 pg_default_acl 的
--    物理行收敛默认权限。
-- ---------------------------------------------------------------------------
\ir generated/authorization-converge.generated.sql

-- ---------------------------------------------------------------------------
-- 2. 授权断言（生成文件，禁止手改）。
--    完整元组的 catalog ACL、pg_default_acl 的物理行与叠加出的有效默认权限，
--    以及 has_*_privilege 的有效权限——PUBLIC 派生与角色继承都算在内。
-- ---------------------------------------------------------------------------
\ir generated/authorization-verify.generated.sql

COMMIT;
