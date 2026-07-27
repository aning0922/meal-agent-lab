-- 阶段 09A / M2A：授权断言（catalog ACL + 有效默认权限 + has_*_privilege 有效权限）。
--
-- GENERATED FILE — DO NOT EDIT.
-- 事实源： services/api/src/database/authorization-manifest.ts
-- 重新生成： pnpm --filter @meal-agent/api manifest:generate
-- 门禁： pnpm --filter @meal-agent/api manifest:check（内存渲染逐字节比对，不会自动改写本文件）
-- manifest version: 1
-- canonical manifest digest: sha256:ceb71dc24e49e7616a280461887a6121e23e0370034ec59038e71de70ad082e9
--
-- 本文件是纯只读 SQL：不匹配时 RAISE EXCEPTION，不做任何变更。
-- 调用方必须先设置 GUC meal_agent.acl_phase（containment 或 final）。

DO $meal_agent_authorization_verify$
DECLARE
  ledger_signature text;
  acl_phase text;
  state_key text;
  divergence_count integer;
  divergence text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
  PERFORM pg_catalog.set_config('quote_all_identifiers', 'off', true);

  IF to_regclass('drizzle.__meal_agent_migrations') IS NULL THEN
    RAISE EXCEPTION
      'authorization manifest: the migration ledger is missing; the database '
      'is not in a state this baseline can reason about';
  END IF;
  SELECT COALESCE(
           pg_catalog.string_agg(name, ',' ORDER BY name COLLATE "C"), '')
    INTO ledger_signature
    FROM drizzle.__meal_agent_migrations;
  acl_phase := current_setting('meal_agent.acl_phase');
  IF acl_phase NOT IN ('containment', 'final') THEN
    RAISE EXCEPTION
      'authorization manifest: unknown phase %; expected containment or final',
      acl_phase;
  END IF;
  state_key := ledger_signature || '|' || acl_phase;
  IF NOT (state_key = ANY (ARRAY['0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', '0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', '0000_stage_06.sql|containment', '0000_stage_06.sql|final']::text[])) THEN
    RAISE EXCEPTION
      'authorization manifest: unregistered (ledger, phase) state %; register '
      'it in services/api/src/database/authorization-manifest.ts before '
      'running this baseline', state_key;
  END IF;

  WITH expected_all (state, kind, identity, detail) AS (
    VALUES
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment'::text, 'default'::text, 'T@drizzle#PUBLIC'::text, 'privs=USAGE'::text),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'default', 'T@global#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'default', 'T@meal_agent_private#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'default', 'T@public#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'database:<current>#meal_agent_backup_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'database:<current>#meal_agent_migration_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'database:<current>#meal_agent_runtime_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:drizzle.__meal_agent_migrations#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.auth_identities#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.household_invites#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.households#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.idempotency_records#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.inventory_events#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.inventory_lots#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.memberships#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.person_profile_link_requests#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.person_profiles#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.sessions#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'relation:public.users#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.app_household_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.app_user_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'schema:drizzle#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'schema:drizzle#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'schema:meal_agent_private#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'schema:public#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'effective', 'schema:public#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'database:<current>#meal_agent_backup_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'database:<current>#meal_agent_migration_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'database:<current>#meal_agent_runtime_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:drizzle.__meal_agent_migrations#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.auth_identities#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.household_invites#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.households#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.idempotency_records#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.inventory_events#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.inventory_lots#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.memberships#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.person_profile_link_requests#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.person_profiles#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.sessions#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'relation:public.users#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.app_household_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.app_user_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'schema:drizzle#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'schema:drizzle#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'schema:meal_agent_private#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'schema:public#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'schema:public#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:drizzle.___meal_agent_migrations#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._auth_identities#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._household_invites#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._households#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._idempotency_records#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._inventory_events#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._inventory_lots#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._memberships#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._person_profile_link_requests#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._person_profiles#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._sessions#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'grant', 'type:public._users#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=8b3b8383eaafef2859c7c6c400fea4560397e2e791398f34eb3d92c983b84d19'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.app_household_id()', 'owner=meal_agent_migrator secdef=f config= body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.app_user_id()', 'owner=meal_agent_migrator secdef=f config= body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=d8bd3080b2b718d97dd351aa88cabb64d887a05f70188c42875bd93598455ff4'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=340b7dafbb3538c8f7be9b75680eee66ac11d95cb7bb63c7eacecc1f0dd181b4'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.has_active_membership(target_household_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.is_active_owner(target_household_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=2f6eaefdd9503cc95274b27a06bd2c026510ccef5b7d5ee1e39c493856a12b1c'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.is_household_creator(target_household_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=49c69edb63ba9c79f1cebedfa662a79008307ef7ff58c654b90b3fa0a5f5802d'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.owns_profile(p_linked_membership_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=8a6ca11f5b63ddd757d2ab4ee55bd6d8eeafa0b86109e48d57804f7beb983d56'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=9f114cec5f9c266b441cb4225ca188bd3069bbcc80b2dbb7d066725a3e3013b2'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=bda888f524207ddd8ecb1875ed75cff298b4c8e57d27e869370f55cf92702e2a'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)', 'owner=meal_agent_migrator secdef=f config=search_path=pg_catalog, public body=aaee625351184de80262214f2f0b048e1941afac9200ffd5c54b8956c71f250a'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=73fd5f37faf85bef8803c3902375365d9f3d2eb5ced6d318813a911864b35df4'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=5dabf7d1671c857717fd8a18d72ea7961ab6f582965f6177dcdb697d2f14988c'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|containment', 'routine', 'meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=44e6d5df0e195097d4a782ae2b4a0fd6e9eb6e2e74d570910ab075e804af1cc9'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'default', 'S@public#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'default', 'T@drizzle#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'default', 'T@global#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'default', 'T@meal_agent_private#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'default', 'T@public#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'default', 'r@drizzle#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'default', 'r@public#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'database:<current>#meal_agent_backup_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'database:<current>#meal_agent_migration_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'database:<current>#meal_agent_runtime_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:drizzle.__meal_agent_migrations#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:drizzle.__meal_agent_migrations#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.auth_identities#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.auth_identities#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.household_invites#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.household_invites#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.households#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.households#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.idempotency_records#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.idempotency_records#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.inventory_events#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.inventory_events#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.inventory_lots#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.inventory_lots#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.memberships#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.memberships#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.person_profile_link_requests#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.person_profile_link_requests#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.person_profiles#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.person_profiles#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.sessions#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.sessions#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.users#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'relation:public.users#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.app_household_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.app_user_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'schema:drizzle#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'schema:drizzle#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'schema:meal_agent_private#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'schema:public#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'effective', 'schema:public#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'database:<current>#meal_agent_backup_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'database:<current>#meal_agent_migration_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'database:<current>#meal_agent_runtime_login', 'privs=CONNECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:drizzle.__meal_agent_migrations#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:drizzle.__meal_agent_migrations#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.auth_identities#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.auth_identities#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.household_invites#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.household_invites#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.households#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.households#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.idempotency_records#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.idempotency_records#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.inventory_events#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.inventory_events#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.inventory_lots#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.inventory_lots#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.memberships#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.memberships#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.person_profile_link_requests#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.person_profile_link_requests#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.person_profiles#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.person_profiles#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.sessions#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.sessions#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.users#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'relation:public.users#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.app_household_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.app_user_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.is_active_owner(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.owns_profile(p_linked_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'routine:meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'schema:drizzle#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'schema:drizzle#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'schema:meal_agent_private#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'schema:public#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'schema:public#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:drizzle.___meal_agent_migrations#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._auth_identities#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._household_invites#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._households#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._idempotency_records#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._inventory_events#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._inventory_lots#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._memberships#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._person_profile_link_requests#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._person_profiles#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._sessions#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'grant', 'type:public._users#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.add_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid, p_constraint_input jsonb, p_hard_confirmed boolean)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=8b3b8383eaafef2859c7c6c400fea4560397e2e791398f34eb3d92c983b84d19'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.app_household_id()', 'owner=meal_agent_migrator secdef=f config= body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.app_user_id()', 'owner=meal_agent_migrator secdef=f config= body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.confirm_person_profile_link(p_request_id uuid, p_expected_version integer)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=d8bd3080b2b718d97dd351aa88cabb64d887a05f70188c42875bd93598455ff4'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.create_person_profile_link_request(p_request_id uuid, p_profile_id uuid, p_target_membership_id uuid, p_expires_in_hours integer)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=340b7dafbb3538c8f7be9b75680eee66ac11d95cb7bb63c7eacecc1f0dd181b4'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.has_active_membership(target_household_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.is_active_owner(target_household_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=2f6eaefdd9503cc95274b27a06bd2c026510ccef5b7d5ee1e39c493856a12b1c'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.is_household_creator(target_household_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.materialize_person_profile_link_requests(p_household_id uuid, p_profile_id uuid, p_target_membership_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=49c69edb63ba9c79f1cebedfa662a79008307ef7ff58c654b90b3fa0a5f5802d'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.owns_profile(p_linked_membership_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=8a6ca11f5b63ddd757d2ab4ee55bd6d8eeafa0b86109e48d57804f7beb983d56'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.redeem_household_invite(p_code_digest character, p_membership_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=9f114cec5f9c266b441cb4225ca188bd3069bbcc80b2dbb7d066725a3e3013b2'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.remove_person_profile_constraint(p_profile_id uuid, p_expected_version integer, p_constraint_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=bda888f524207ddd8ecb1875ed75cff298b4c8e57d27e869370f55cf92702e2a'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.stage08_constraints_are_safe(p_constraints jsonb)', 'owner=meal_agent_migrator secdef=f config=search_path=pg_catalog, public body=aaee625351184de80262214f2f0b048e1941afac9200ffd5c54b8956c71f250a'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.transition_membership_status(p_target_membership_id uuid, p_expected_version integer)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=73fd5f37faf85bef8803c3902375365d9f3d2eb5ced6d318813a911864b35df4'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.transition_person_profile_status(p_profile_id uuid, p_expected_version integer, p_operation text)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=5dabf7d1671c857717fd8a18d72ea7961ab6f582965f6177dcdb697d2f14988c'),
      ('0000_stage_06.sql,0001_stage_08.sql,0002_stage_08_audit_closeout.sql,0003_stage_08_secondary_closeout.sql,0004_stage_08_final_closeout.sql|final', 'routine', 'meal_agent_private.update_person_profile_fields(p_profile_id uuid, p_expected_version integer, p_set_display_name boolean, p_display_name text, p_set_default_participation boolean, p_default_participation integer, p_set_default_portion_scale boolean, p_default_portion_scale numeric, p_set_cooking_skill boolean, p_cooking_skill text)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=44e6d5df0e195097d4a782ae2b4a0fd6e9eb6e2e74d570910ab075e804af1cc9'),
      ('0000_stage_06.sql|containment', 'default', 'T@drizzle#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'default', 'T@global#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'default', 'T@meal_agent_private#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'default', 'T@public#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'effective', 'database:<current>#meal_agent_backup_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|containment', 'effective', 'database:<current>#meal_agent_migration_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|containment', 'effective', 'database:<current>#meal_agent_runtime_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|containment', 'effective', 'relation:drizzle.__meal_agent_migrations#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql|containment', 'effective', 'relation:public.auth_identities#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|containment', 'effective', 'relation:public.households#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|containment', 'effective', 'relation:public.idempotency_records#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|containment', 'effective', 'relation:public.inventory_events#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|containment', 'effective', 'relation:public.inventory_lots#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|containment', 'effective', 'relation:public.memberships#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|containment', 'effective', 'relation:public.person_profiles#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|containment', 'effective', 'relation:public.sessions#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|containment', 'effective', 'relation:public.users#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|containment', 'effective', 'routine:meal_agent_private.app_household_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|containment', 'effective', 'routine:meal_agent_private.app_user_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|containment', 'effective', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|containment', 'effective', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|containment', 'effective', 'schema:drizzle#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'effective', 'schema:drizzle#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'effective', 'schema:meal_agent_private#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'effective', 'schema:public#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'effective', 'schema:public#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'database:<current>#meal_agent_backup_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|containment', 'grant', 'database:<current>#meal_agent_migration_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|containment', 'grant', 'database:<current>#meal_agent_runtime_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|containment', 'grant', 'relation:drizzle.__meal_agent_migrations#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql|containment', 'grant', 'relation:public.auth_identities#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|containment', 'grant', 'relation:public.households#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|containment', 'grant', 'relation:public.idempotency_records#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|containment', 'grant', 'relation:public.inventory_events#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|containment', 'grant', 'relation:public.inventory_lots#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|containment', 'grant', 'relation:public.memberships#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|containment', 'grant', 'relation:public.person_profiles#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|containment', 'grant', 'relation:public.sessions#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|containment', 'grant', 'relation:public.users#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|containment', 'grant', 'routine:meal_agent_private.app_household_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|containment', 'grant', 'routine:meal_agent_private.app_user_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|containment', 'grant', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|containment', 'grant', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|containment', 'grant', 'schema:drizzle#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'schema:drizzle#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'schema:meal_agent_private#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'schema:public#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'schema:public#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'type:drizzle.___meal_agent_migrations#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'type:public._auth_identities#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'type:public._households#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'type:public._idempotency_records#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'type:public._inventory_events#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'type:public._inventory_lots#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'type:public._memberships#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'type:public._person_profiles#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'type:public._sessions#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'grant', 'type:public._users#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|containment', 'routine', 'meal_agent_private.app_household_id()', 'owner=meal_agent_migrator secdef=f config= body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
      ('0000_stage_06.sql|containment', 'routine', 'meal_agent_private.app_user_id()', 'owner=meal_agent_migrator secdef=f config= body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
      ('0000_stage_06.sql|containment', 'routine', 'meal_agent_private.has_active_membership(target_household_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
      ('0000_stage_06.sql|containment', 'routine', 'meal_agent_private.is_household_creator(target_household_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a'),
      ('0000_stage_06.sql|final', 'default', 'S@public#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'default', 'T@drizzle#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'default', 'T@global#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'default', 'T@meal_agent_private#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'default', 'T@public#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'default', 'r@drizzle#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'default', 'r@public#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'database:<current>#meal_agent_backup_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|final', 'effective', 'database:<current>#meal_agent_migration_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|final', 'effective', 'database:<current>#meal_agent_runtime_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:drizzle.__meal_agent_migrations#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:drizzle.__meal_agent_migrations#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.auth_identities#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.auth_identities#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.households#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.households#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.idempotency_records#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.idempotency_records#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.inventory_events#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.inventory_events#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.inventory_lots#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.inventory_lots#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.memberships#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.memberships#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.person_profiles#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.person_profiles#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.sessions#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.sessions#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.users#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|final', 'effective', 'relation:public.users#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'effective', 'routine:meal_agent_private.app_household_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|final', 'effective', 'routine:meal_agent_private.app_user_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|final', 'effective', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|final', 'effective', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|final', 'effective', 'schema:drizzle#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'effective', 'schema:drizzle#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'effective', 'schema:meal_agent_private#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'effective', 'schema:public#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'effective', 'schema:public#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'database:<current>#meal_agent_backup_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|final', 'grant', 'database:<current>#meal_agent_migration_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|final', 'grant', 'database:<current>#meal_agent_runtime_login', 'privs=CONNECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:drizzle.__meal_agent_migrations#meal_agent_app', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:drizzle.__meal_agent_migrations#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.auth_identities#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.auth_identities#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.households#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.households#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.idempotency_records#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.idempotency_records#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.inventory_events#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.inventory_events#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.inventory_lots#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.inventory_lots#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.memberships#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.memberships#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.person_profiles#meal_agent_app', 'privs=INSERT,SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.person_profiles#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.sessions#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.sessions#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.users#meal_agent_app', 'privs=INSERT,SELECT,UPDATE'),
      ('0000_stage_06.sql|final', 'grant', 'relation:public.users#meal_agent_backup', 'privs=SELECT'),
      ('0000_stage_06.sql|final', 'grant', 'routine:meal_agent_private.app_household_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|final', 'grant', 'routine:meal_agent_private.app_user_id()#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|final', 'grant', 'routine:meal_agent_private.has_active_membership(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|final', 'grant', 'routine:meal_agent_private.is_household_creator(target_household_id uuid)#meal_agent_app', 'privs=EXECUTE'),
      ('0000_stage_06.sql|final', 'grant', 'schema:drizzle#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'schema:drizzle#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'schema:meal_agent_private#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'schema:public#meal_agent_app', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'schema:public#meal_agent_backup', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'type:drizzle.___meal_agent_migrations#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'type:public._auth_identities#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'type:public._households#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'type:public._idempotency_records#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'type:public._inventory_events#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'type:public._inventory_lots#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'type:public._memberships#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'type:public._person_profiles#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'type:public._sessions#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'grant', 'type:public._users#PUBLIC', 'privs=USAGE'),
      ('0000_stage_06.sql|final', 'routine', 'meal_agent_private.app_household_id()', 'owner=meal_agent_migrator secdef=f config= body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
      ('0000_stage_06.sql|final', 'routine', 'meal_agent_private.app_user_id()', 'owner=meal_agent_migrator secdef=f config= body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
      ('0000_stage_06.sql|final', 'routine', 'meal_agent_private.has_active_membership(target_household_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
      ('0000_stage_06.sql|final', 'routine', 'meal_agent_private.is_household_creator(target_household_id uuid)', 'owner=meal_agent_migrator secdef=t config=search_path=pg_catalog, public|row_security=off body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a')
  ),
  expected AS (
    SELECT kind, identity, detail FROM expected_all WHERE state = state_key
  ),
    current_acl (objkey, target, colname, grantee, grantor, privilege,
                 grantable) AS (
      SELECT 'database:<current>'::text,
             ('DATABASE ' || quote_ident(current_database()))::text,
             NULL::text,
             (CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(acl.grantee) END)::text,
             pg_catalog.pg_get_userbyid(acl.grantor)::text,
             acl.privilege_type::text, acl.is_grantable
        FROM pg_catalog.pg_database d,
             -- datacl 为 NULL 时是**隐式**默认 ACL（PUBLIC 有 CONNECT/TEMPORARY），
             -- aclexplode(NULL) 会漏掉它，因此用 acldefault 展开。
             aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
       WHERE d.datname = current_database()
      UNION ALL
      SELECT 'schema:' || n.nspname,
             'SCHEMA ' || quote_ident(n.nspname), NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'relation:' || n.nspname || '.' || c.relname,
             CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END
               || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
             aclexplode(c.relacl) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'column:' || n.nspname || '.' || c.relname || '.' || a.attname,
             'TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
             a.attname::text,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
             aclexplode(a.attacl) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'routine:' || n.nspname || '.' || p.proname || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             'ROUTINE ' || quote_ident(n.nspname) || '.'
               || quote_ident(p.proname) || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
             aclexplode(COALESCE(p.proacl,
                                 acldefault('f', p.proowner))) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'type:' || n.nspname || '.' || t.typname,
             'TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname),
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace,
             aclexplode(COALESCE(t.typacl,
                                 acldefault('T', t.typowner))) AS acl
       WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
      UNION ALL
      SELECT 'language:' || l.lanname,
             'LANGUAGE ' || quote_ident(l.lanname), NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_language l, aclexplode(l.lanacl) AS acl
    ),
    default_slots (objtype, scope) AS (
      VALUES
        ('L'::text, 'global'::text),
        ('S', 'drizzle'),
        ('S', 'global'),
        ('S', 'meal_agent_private'),
        ('S', 'public'),
        ('T', 'drizzle'),
        ('T', 'global'),
        ('T', 'meal_agent_private'),
        ('T', 'public'),
        ('f', 'drizzle'),
        ('f', 'global'),
        ('f', 'meal_agent_private'),
        ('f', 'public'),
        ('n', 'global'),
        ('r', 'drizzle'),
        ('r', 'global'),
        ('r', 'meal_agent_private'),
        ('r', 'public')
    ),
    current_default (scope_key, grantee, privilege) AS (
      SELECT s.objtype || '@' || s.scope,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             acl.privilege_type::text
        FROM default_slots s,
             LATERAL (
               SELECT COALESCE(
                 (SELECT d.defaclacl
                    FROM pg_catalog.pg_default_acl d
                    JOIN pg_catalog.pg_namespace dn ON dn.oid = d.defaclnamespace
                   WHERE pg_catalog.pg_get_userbyid(d.defaclrole)
                           = 'meal_agent_migrator'
                     AND d.defaclobjtype = s.objtype::"char"
                     AND dn.nspname = s.scope),
                 (SELECT d.defaclacl
                    FROM pg_catalog.pg_default_acl d
                   WHERE pg_catalog.pg_get_userbyid(d.defaclrole)
                           = 'meal_agent_migrator'
                     AND d.defaclobjtype = s.objtype::"char"
                     AND d.defaclnamespace = 0),
                 acldefault(s.objtype::"char",
                            (SELECT oid FROM pg_catalog.pg_roles
                              WHERE rolname = 'meal_agent_migrator'))
               ) AS effective_acl
             ) AS resolved,
             aclexplode(resolved.effective_acl) AS acl
       WHERE (CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(acl.grantee) END)
             = ANY (ARRAY['PUBLIC', 'meal_agent_app', 'meal_agent_backup', 'meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_runtime_login']::text[])
    ),
  watched (grantee, probe) AS (
    VALUES
      ('PUBLIC'::text, 'public'::text),
      ('meal_agent_app', 'meal_agent_app'),
      ('meal_agent_backup', 'meal_agent_backup'),
      ('meal_agent_backup_login', 'meal_agent_backup_login'),
      ('meal_agent_migration_login', 'meal_agent_migration_login'),
      ('meal_agent_runtime_login', 'meal_agent_runtime_login')
  ),
  actual (kind, identity, detail) AS (
    -- 受控 routine 的精确指纹：identity + owner + SECURITY DEFINER + proconfig
    -- + 正文摘要。EXECUTE 授权只是一半，另一半是「以谁的身份、带什么
    -- search_path / row_security、跑的是不是原来那份正文」。
    SELECT 'routine'::text,
           (n.nspname || '.' || p.proname || '('
             || pg_catalog.pg_get_function_identity_arguments(p.oid)
             || ')')::text,
           ('owner=' || pg_catalog.pg_get_userbyid(p.proowner)
             || ' secdef=' || CASE WHEN p.prosecdef THEN 't' ELSE 'f' END
             || ' config='
             || COALESCE(pg_catalog.array_to_string(p.proconfig, '|'), '')
             || ' body='
             || pg_catalog.encode(
                  pg_catalog.sha256(
                    pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex'))::text
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
    UNION ALL
    -- 同一条权限可能由多个 grantor 分别授予，aclexplode 会给出多行。这里先
    -- DISTINCT 再聚合，否则「两个 grantor 都授了 SELECT」会渲染成 SELECT,SELECT。
    SELECT 'grant', (objkey || '#' || grantee)::text,
           ('privs=' || pg_catalog.string_agg(entry, ','
                                              ORDER BY entry COLLATE "C"))::text
      FROM (
        SELECT DISTINCT objkey, grantee,
               privilege || CASE WHEN grantable THEN '*' ELSE '' END AS entry
          FROM current_acl
         WHERE grantee = ANY (ARRAY['PUBLIC', 'meal_agent_app', 'meal_agent_backup', 'meal_agent_backup_login', 'meal_agent_migration_login', 'meal_agent_runtime_login']::text[])
      ) AS distinct_acl
     GROUP BY objkey, grantee
    UNION ALL
    SELECT 'default', scope_key || '#' || grantee,
           'privs=' || pg_catalog.string_agg(privilege, ','
                                             ORDER BY privilege COLLATE "C")
      FROM current_default
     GROUP BY scope_key, grantee
    UNION ALL
    SELECT 'effective', object || '#' || role, 'privs=' || privileges
      FROM (
        SELECT 'database:<current>' AS object, w.grantee AS role,
               (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
                  FROM unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p
                 WHERE has_database_privilege(w.probe, current_database(), p))
                 AS privileges
          FROM watched w
        UNION ALL
        SELECT 'schema:' || n.nspname, w.grantee,
               (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
                  FROM unnest(ARRAY['CREATE', 'USAGE']) AS p
                 WHERE has_schema_privilege(w.probe, n.oid, p))
          FROM pg_catalog.pg_namespace n, watched w
         WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
        UNION ALL
        SELECT 'relation:' || n.nspname || '.' || c.relname, w.grantee,
               CASE WHEN c.relkind = 'S' THEN
                 (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
                    FROM unnest(ARRAY['SELECT', 'UPDATE', 'USAGE']) AS p
                   WHERE has_sequence_privilege(w.probe, c.oid, p))
               ELSE
                 (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
                    FROM unnest(ARRAY['DELETE', 'INSERT', 'MAINTAIN',
                                      'REFERENCES', 'SELECT', 'TRIGGER',
                                      'TRUNCATE', 'UPDATE']) AS p
                   WHERE has_table_privilege(w.probe, c.oid, p))
               END
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, watched w
         WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        UNION ALL
        SELECT 'routine:' || n.nspname || '.' || p.proname || '('
                 || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
               w.grantee,
               CASE WHEN has_function_privilege(w.probe, p.oid, 'EXECUTE')
                    THEN 'EXECUTE' ELSE NULL END
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace, watched w
         WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
        UNION ALL
        SELECT 'routine:' || denied.identity, w.grantee,
               CASE WHEN has_function_privilege(
                      w.probe, denied.identity::regprocedure, 'EXECUTE')
                    THEN 'EXECUTE' ELSE NULL END
          FROM unnest(ARRAY['pg_catalog.lo_close(integer)', 'pg_catalog.lo_creat(integer)', 'pg_catalog.lo_create(oid)', 'pg_catalog.lo_export(oid, text)', 'pg_catalog.lo_from_bytea(oid, bytea)', 'pg_catalog.lo_get(oid)', 'pg_catalog.lo_get(oid, bigint, integer)', 'pg_catalog.lo_import(text)', 'pg_catalog.lo_import(text, oid)', 'pg_catalog.lo_lseek(integer, integer, integer)', 'pg_catalog.lo_lseek64(integer, bigint, integer)', 'pg_catalog.lo_open(oid, integer)', 'pg_catalog.lo_put(oid, bigint, bytea)', 'pg_catalog.lo_tell(integer)', 'pg_catalog.lo_tell64(integer)', 'pg_catalog.lo_truncate(integer, integer)', 'pg_catalog.lo_truncate64(integer, bigint)', 'pg_catalog.lo_unlink(oid)', 'pg_catalog.loread(integer, integer)', 'pg_catalog.lowrite(integer, bytea)']::text[]) AS denied(identity), watched w
         WHERE to_regprocedure(denied.identity) IS NOT NULL
      ) AS effective_rows
     WHERE privileges IS NOT NULL
  ),
  divergence_rows (kind, entry) AS (
    SELECT a.kind,
           'unexpected ' || a.kind || ' ' || a.identity || ' [' || a.detail || ']'
      FROM actual a
      LEFT JOIN expected e ON e.kind = a.kind AND e.identity = a.identity
     WHERE e.kind IS NULL
    UNION ALL
    SELECT e.kind, 'missing ' || e.kind || ' ' || e.identity
             || ' [expected ' || e.detail || ']'
      FROM expected e
      LEFT JOIN actual a ON a.kind = e.kind AND a.identity = e.identity
     WHERE a.kind IS NULL
    UNION ALL
    SELECT e.kind,
           'drifted ' || e.kind || ' ' || e.identity
             || ' [expected ' || e.detail || '] [found ' || a.detail || ']'
      FROM expected e
      JOIN actual a ON a.kind = e.kind AND a.identity = e.identity
     WHERE a.detail IS DISTINCT FROM e.detail
  )
  SELECT (SELECT count(*) FROM divergence_rows)::integer,
         (SELECT pg_catalog.string_agg(pg_catalog.left(entry, 400), '; '
                                       ORDER BY rank, entry COLLATE "C")
            FROM (SELECT CASE kind WHEN 'effective' THEN 1 WHEN 'routine' THEN 2
                                   WHEN 'grant' THEN 3 ELSE 4 END AS rank,
                         entry
                    FROM divergence_rows
                   ORDER BY rank, entry COLLATE "C" LIMIT 8) AS capped)
    INTO divergence_count, divergence;

  IF divergence_count > 0 THEN
    RAISE EXCEPTION
      'authorization manifest does not match state % '
      '(% divergence(s), manifest version 1): %',
      state_key, divergence_count,
      divergence || CASE WHEN divergence_count > 8 THEN '; ...' ELSE '' END;
  END IF;
END
$meal_agent_authorization_verify$;
