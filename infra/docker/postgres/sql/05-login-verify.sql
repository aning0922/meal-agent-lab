-- 阶段 09A / M2A：设置口令后的强制后置校验。
--
-- psql 的 \password 在口令为空字符串时，服务端会 RAISE NOTICE
-- "empty string is not a valid password, clearing password" 并把 rolpassword
-- **清空**，而 psql 仍然退出 0。仅凭退出码无法判断口令是否真的设置成功，
-- 因此这里回查 pg_authid，确认三个登录角色都持有 SCRAM-SHA-256 verifier。
--
-- 只读取 verifier 的前缀用于判定，绝不输出 verifier 或口令本身。

\set ON_ERROR_STOP on

DO $login_verify$
DECLARE
  problem text;
BEGIN
  SELECT string_agg(candidate, ', ' ORDER BY candidate) INTO problem
  FROM unnest(ARRAY[
    'meal_agent_migration_login',
    'meal_agent_runtime_login',
    'meal_agent_backup_login'
  ]) AS candidate
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_authid
    WHERE rolname = candidate
      AND rolpassword IS NOT NULL
      AND left(rolpassword, 14) = 'SCRAM-SHA-256$'
  );

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION
      'login verify: % do not hold a SCRAM-SHA-256 verifier; the password may '
      'have been empty and silently cleared', problem;
  END IF;
END
$login_verify$;
