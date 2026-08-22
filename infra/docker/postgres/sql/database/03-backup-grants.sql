-- 阶段 09A / M2A：目标数据库 ACL 基线——**final 阶段**（database scope）。
--
-- 由 bootstrap/admin 在 0001—最新 migration 应用之后执行；可重复执行。
--
-- containment（02-acl-baseline.sql）负责 migration 之前 / 恢复之后的收敛，
-- 那个阶段刻意**不**给备份角色任何表级 SELECT——migration 期间没有理由存在一份
-- 可读全库的授权。final 阶段才建立最终 ACL，并且**同时验证 PUBLIC、
-- meal_agent_app、meal_agent_backup 与三个 login**，而不是只看备份角色：
-- 只检查 backup 会漏掉「migration 顺手把某张新表授给了 PUBLIC」这类问题。
--
-- 授权本身由 ledger 感知的 manifest 与可移植策略描述：
--   事实源  services/api/src/database/authorization-manifest.ts
--   共享观察 services/api/src/database/authorization-projection-sql.ts
--   可移植策略 services/api/src/database/authorization-policy-sql.ts
--   收敛    generated/authorization-converge.generated.sql
--   断言    generated/authorization-verify.generated.sql
-- 两个 generated 文件都禁止手改，由 `manifest:check` 逐字节校验。
--
-- 本文件与 02-acl-baseline.sql 一样是**薄入口**：只固定阶段 GUC 与事务边界。
-- 全部致命前置条件由 generated 收敛块在任何 mutation 之前统一执行，因此
-- `acl` 与 `grants` 对同一批漂移给出**逐字相同**的拒绝理由；之前这里缺少
-- 归属与 managed schema 前置检查，只有 `acl` 有，两个阶段并不一致。
--
-- M4 的恢复流程只在此登记约束，本轮不实现：恢复时复用 cluster/01-roles.sql
-- 预建 dump 引用的角色，不得在已有 dump 目标上重跑 0000，也不得对 dump 已经
-- 建立的对象重跑 owner handoff。

\set ON_ERROR_STOP on

SELECT set_config('meal_agent.acl_phase', 'final', false);

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 授权收敛（生成文件，禁止手改）：final 阶段的允许集合包含备份角色的表级
--    非 grantable SELECT 与对应的 pg_default_acl 物理行。
-- ---------------------------------------------------------------------------
\ir generated/authorization-converge.generated.sql

-- ---------------------------------------------------------------------------
-- 2. 授权断言（生成文件，禁止手改）：PUBLIC、app、backup、三个 login 一起验证，
--    完整元组的 catalog ACL / default privilege 物理行与有效叠加 /
--    has_*_privilege 有效权限三者同时比对。
-- ---------------------------------------------------------------------------
\ir generated/authorization-verify.generated.sql

COMMIT;
