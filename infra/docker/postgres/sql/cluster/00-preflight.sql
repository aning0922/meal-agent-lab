-- 阶段 09A / M2A：cluster scope 预检。
--
-- cluster 阶段连接的是明确的 maintenance/control 数据库（默认 postgres），
-- **不要求目标 meal_agent 数据库存在**，也不修改任何目标数据库的 ACL。
-- 因此这里只校验 admin 能力，不校验库名是不是项目库。

\set ON_ERROR_STOP on

DO $cluster_preflight$
BEGIN
  -- 角色创建、BYPASSRLS 授予与 role config 变更都需要 cluster superuser。
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE EXCEPTION
      'cluster preflight: % is not a cluster superuser; the cluster role '
      'baseline requires cluster-admin capability', current_user;
  END IF;
END
$cluster_preflight$;
