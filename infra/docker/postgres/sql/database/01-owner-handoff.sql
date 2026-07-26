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
--   3. 业务表与 meal_agent_private 函数的 owner 由冻结的 0000—0004 自己设置为
--      migrator，这里只**验证**，不动态接管：不符合就失败。
--   4. 允许出现的对象集合由 **ledger 实际内容**推导：只应用了 0000 时，
--      0001/0002 的表出现就是异常，不能提前放行。

\set ON_ERROR_STOP on

-- psql 不在 dollar-quoted 块内做变量替换，因此先把 0000 的期望 checksum 放进
-- 带命名空间的自定义 GUC。该值由 bootstrap.sh 从磁盘上的 migration 文件算出。
SELECT set_config('meal_agent.stage06_hash', :'stage06_hash', false);

BEGIN;

-- ---------------------------------------------------------------------------
-- 阶段 1：只读检查。任何失败都在此抛出，此时尚未做过任何归属变更。
-- ---------------------------------------------------------------------------
DO $checks$
DECLARE
  -- 冻结的 0000 恰好建立的对象集合。handoff 是 fresh-install 的 0000-only
  -- 步骤，因此这里不再维护 0001—0004 的第二份表名映射。
  stage06_tables constant text[] := ARRAY[
    'auth_identities', 'households', 'idempotency_records', 'inventory_events',
    'inventory_lots', 'memberships', 'person_profiles', 'sessions', 'users'
  ];
  stage06_routines constant text[] := ARRAY[
    'app_household_id', 'app_user_id', 'has_active_membership',
    'is_household_creator'
  ];
  stage06_schemas constant text[] := ARRAY[
    'public', 'drizzle', 'meal_agent_private'
  ];
  bootstrap_admin constant text := current_user;
  expected_hash constant text := current_setting('meal_agent.stage06_hash');
  applied_names text[];
  applied_hash text;
  database_owner text;
  problem text;
BEGIN
  -- 1a. ledger 必须存在，且**恰好**只有 checksum 正确的 0000。
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

  -- 1b. mutation 前先确认 database owner 只能是当前 bootstrap admin 或 migrator。
  SELECT pg_catalog.pg_get_userbyid(datdba) INTO database_owner
  FROM pg_database WHERE datname = current_database();
  IF database_owner NOT IN (bootstrap_admin, 'meal_agent_migrator') THEN
    RAISE EXCEPTION
      'owner handoff: database owner is %, expected % or meal_agent_migrator',
      database_owner, bootstrap_admin;
  END IF;

  -- 1c. schema 集合必须恰好是 0000 之后应有的三个（外加系统 schema）。
  SELECT string_agg(nspname, ', ' ORDER BY nspname) INTO problem
  FROM pg_namespace
  WHERE nspname <> 'information_schema'
    AND nspname !~ '^pg_'
    AND NOT (nspname = ANY(stage06_schemas));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'owner handoff: unexpected schema(s): %', problem;
  END IF;

  -- 1d. public 中的关系必须恰好是 0000 的九张表——view/matview/sequence/
  --     foreign table 或任何 0001+ 的表出现都说明状态不对。
  SELECT string_agg(format('%s %s (owner %s)',
           CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                          WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview'
                          WHEN 'S' THEN 'sequence' ELSE 'foreign table' END,
           c.relname, pg_catalog.pg_get_userbyid(c.relowner)),
         ', ' ORDER BY c.relname)
    INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    AND NOT (c.relkind IN ('r', 'p') AND c.relname = ANY(stage06_tables));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: unexpected object(s) in public for a 0000-only '
      'database: %', problem;
  END IF;

  SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO problem
  FROM unnest(stage06_tables) AS candidate
  WHERE to_regclass('public.' || candidate) IS NULL;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: 0000 is recorded as applied but table(s) missing: %',
      problem;
  END IF;

  -- 1e. public 中不得有任何用户 routine：0000 的函数都在 meal_agent_private。
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: unexpected routine(s) in public: %', problem;
  END IF;

  -- 1f. meal_agent_private 中的 routine 必须恰好是 0000 建立的四个，且归 migrator。
  SELECT string_agg(format('%s (owner %s)', p.proname,
                           pg_catalog.pg_get_userbyid(p.proowner)),
                    ', ' ORDER BY p.proname)
    INTO problem
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'meal_agent_private'
    AND (NOT (p.proname = ANY(stage06_routines))
         OR pg_catalog.pg_get_userbyid(p.proowner) <> 'meal_agent_migrator');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: unexpected or mis-owned routine(s) in '
      'meal_agent_private: %', problem;
  END IF;

  SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO problem
  FROM unnest(stage06_routines) AS candidate
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'meal_agent_private' AND p.proname = candidate
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: 0000 routine(s) missing from meal_agent_private: %',
      problem;
  END IF;

  -- 1g. 业务表 owner 只验证不接管。
  SELECT string_agg(format('%s (owner %s)', c.relname,
                           pg_catalog.pg_get_userbyid(c.relowner)),
                    ', ' ORDER BY c.relname)
    INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    AND pg_catalog.pg_get_userbyid(c.relowner) <> 'meal_agent_migrator';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: business table(s) are not owned by meal_agent_migrator; '
      'the frozen 0000 sets this, so this is an unexpected state: %', problem;
  END IF;

  -- 1h. 用户自定义类型：0000 不建立任何，出现即异常。
  SELECT string_agg(n.nspname || '.' || t.typname, ', ') INTO problem
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = ANY(ARRAY['public', 'meal_agent_private'])
    AND t.typtype IN ('c', 'e', 'd', 'r')
    AND NOT EXISTS (SELECT 1 FROM pg_class c
                    WHERE c.oid = t.typrelid AND c.relkind <> 'c');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'owner handoff: unexpected user-defined type(s): %', problem;
  END IF;

  -- 1i. drizzle schema 里除 ledger 外不应有其他对象。
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'drizzle'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    AND c.relname <> '__meal_agent_migrations';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'owner handoff: unexpected object(s) in schema drizzle: %', problem;
  END IF;

  -- 1j. 待交接的 schema 与 ledger，其当前 owner 只能是 migrator 或 bootstrap admin。
  SELECT string_agg(format('schema %s (owner %s)', nspname,
                           pg_catalog.pg_get_userbyid(nspowner)),
                    ', ' ORDER BY nspname)
    INTO problem
  FROM pg_namespace
  WHERE nspname = ANY(stage06_schemas)
    AND pg_catalog.pg_get_userbyid(nspowner)
        NOT IN ('meal_agent_migrator', bootstrap_admin, 'pg_database_owner');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'owner handoff: unexpected schema owner(s): %', problem;
  END IF;

  IF (SELECT pg_catalog.pg_get_userbyid(c.relowner)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'drizzle' AND c.relname = '__meal_agent_migrations')
     NOT IN ('meal_agent_migrator', bootstrap_admin) THEN
    RAISE EXCEPTION
      'owner handoff: the migration ledger has an unexpected owner';
  END IF;
END
$checks$;

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
