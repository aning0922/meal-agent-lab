-- 阶段 09A / M2A：owner 交接（database scope，仅全新安装路径）。
--
-- 由 bootstrap/admin 在冻结的 0000 应用之后、0001 之前执行；可重复执行。
-- 恢复路径**不**运行本文件：dump 已经带着正确的 owner，重跑交接只会制造漂移。
--
-- 设计要点：
--   1. **所有状态检查先于任何 ownership mutation**；任一检查失败时，
--      database/schema/table owner 全部保持原状。
--   2. admin 真正需要交接的只有三类明确对象：目标 database、三个 schema，
--      以及由 migration runner 以 admin 身份建立的 drizzle ledger。
--   3. 业务表与 meal_agent_private 函数的 owner 由冻结的 0000 自己设置为
--      migrator，这里只**验证**，不动态接管：不符合就失败。
--   4. 对象与安全属性清单**不再在本文件里手写**。它由
--      `services/api/src/database/stage06-manifest.ts` 的 typed manifest 渲染成
--      generated SQL，本文件在 mutation 之前、事务之内用相对路径 `\ir` 加载。
--      `services/api/src/database/migrate.ts` 的 0000-only 重跑预检执行的是
--      同一段文本，因此两个入口对同一批漂移给出同一条拒绝理由。

\set ON_ERROR_STOP on

-- psql 不在 dollar-quoted 块内做变量替换，因此先把 0000 的期望 checksum 放进
-- 带命名空间的自定义 GUC。该值由 bootstrap.sh 从磁盘上的 migration 文件算出。
SELECT set_config('meal_agent.stage06_hash', :'stage06_hash', false);

BEGIN;

-- ---------------------------------------------------------------------------
-- 阶段 1a：顺序前置条件。这里只处理 manifest 覆盖不到的两件事——migration
--          ledger 的内容与 checksum，以及 pg_database 层面的 owner。
--          任何失败都在此抛出，此时尚未做过任何归属变更。
-- ---------------------------------------------------------------------------
DO $checks$
DECLARE
  bootstrap_admin constant text := current_user;
  expected_hash constant text := current_setting('meal_agent.stage06_hash');
  applied_names text[];
  applied_hash text;
  database_owner text;
BEGIN
  -- ledger 必须存在，且**恰好**只有 checksum 正确的 0000。
  IF to_regclass('drizzle.__meal_agent_migrations') IS NULL THEN
    RAISE EXCEPTION
      'owner handoff: migration ledger is missing; run '
      '"pnpm --filter @meal-agent/api db:bootstrap" first';
  END IF;

  SELECT array_agg(name ORDER BY name) INTO applied_names
  FROM drizzle.__meal_agent_migrations;
  applied_names := coalesce(applied_names, ARRAY[]::text[]);

  IF applied_names <> ARRAY['0000_stage_06.sql'] THEN
    RAISE EXCEPTION
      'owner handoff: this is a fresh-install, 0000-only step; the ledger must '
      'contain exactly 0000_stage_06.sql but contains %', applied_names;
  END IF;

  SELECT hash INTO applied_hash FROM drizzle.__meal_agent_migrations
  WHERE name = '0000_stage_06.sql';
  IF applied_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION
      'owner handoff: the recorded 0000_stage_06.sql checksum does not match '
      'the migration file on disk';
  END IF;

  -- mutation 前先确认 database owner 只能是当前 bootstrap admin 或 migrator。
  -- pg_database 不属于 manifest 覆盖的 namespace 对象，因此留在这里。
  SELECT pg_catalog.pg_get_userbyid(datdba) INTO database_owner
  FROM pg_database WHERE datname = current_database();
  IF database_owner NOT IN (bootstrap_admin, 'meal_agent_migrator') THEN
    RAISE EXCEPTION
      'owner handoff: database owner is %, expected % or meal_agent_migrator',
      database_owner, bootstrap_admin;
  END IF;
END
$checks$;

-- ---------------------------------------------------------------------------
-- 阶段 1b：对象与安全属性 manifest。
--
-- **生成文件，禁止手改**：事实源是 services/api/src/database/stage06-manifest.ts，
-- 由 `pnpm --filter @meal-agent/api manifest:generate` 生成，
-- `manifest:check` 逐字节保证它与内存渲染结果一致。
--
-- 它覆盖：三个 managed schema 的存在性与「没有多余 schema」、relation 的
-- schema/name/relkind/owner 与 RLS/FORCE RLS 状态、index 与 constraint 的规范化
-- 定义、routine 的 identity args/prokind/owner/SECURITY DEFINER/language/
-- proconfig/正文摘要、policy 的 command/roles/permissive/USING/WITH CHECK、
-- 以及 type 与 trigger。只读：不匹配时 RAISE EXCEPTION，不做任何变更。
-- ---------------------------------------------------------------------------
\ir generated/0000-object-manifest.generated.sql

-- ---------------------------------------------------------------------------
-- 阶段 2：归属变更。只有上面全部检查通过才会执行到这里。
--         交接对象是明确的三类：database、三个 schema、drizzle ledger。
-- ---------------------------------------------------------------------------
ALTER DATABASE :"expected_db" OWNER TO meal_agent_migrator;

ALTER SCHEMA public OWNER TO meal_agent_migrator;
ALTER SCHEMA drizzle OWNER TO meal_agent_migrator;
ALTER SCHEMA meal_agent_private OWNER TO meal_agent_migrator;

ALTER TABLE drizzle.__meal_agent_migrations OWNER TO meal_agent_migrator;

-- ---------------------------------------------------------------------------
-- 阶段 3：结果自检
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  problem text;
BEGIN
  IF (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_database
      WHERE datname = current_database()) <> 'meal_agent_migrator' THEN
    RAISE EXCEPTION 'owner handoff: database owner is not meal_agent_migrator';
  END IF;

  SELECT string_agg(nspname, ', ' ORDER BY nspname) INTO problem
  FROM pg_namespace
  WHERE nspname IN ('public', 'drizzle', 'meal_agent_private')
    AND pg_catalog.pg_get_userbyid(nspowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'owner handoff: schema(s) % not owned by migrator', problem;
  END IF;

  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO problem
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle')
    AND c.relkind IN ('r', 'p')
    AND pg_catalog.pg_get_userbyid(c.relowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'owner handoff: table(s) % not owned by migrator', problem;
  END IF;
END
$verify$;

COMMIT;
