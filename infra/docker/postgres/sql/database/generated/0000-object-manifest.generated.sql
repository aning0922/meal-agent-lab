-- 阶段 09A / M2A：冻结 0000 的对象与安全属性 manifest。
--
-- GENERATED FILE — DO NOT EDIT.
-- 事实源： services/api/src/database/stage06-manifest.ts
-- 重新生成： pnpm --filter @meal-agent/api manifest:generate
-- 门禁： pnpm --filter @meal-agent/api manifest:check（内存渲染逐字节比对，不会自动改写本文件）
-- manifest version: 1
-- canonical manifest digest: sha256:5e477c5298141759dbdea589988fa5a32bf506c57ac8c7608ab682321ea8d18a
--
-- 本文件是纯 SQL：不含 psql 元命令，不做任何 ownership/ACL/DDL 变更，只在与
-- manifest 不符时 RAISE EXCEPTION。pg 与 psql 都能直接执行。

DO $meal_agent_stage06_manifest$
DECLARE
  divergence_count integer;
  divergence text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);

  WITH expected (kind, identity, detail) AS (
    VALUES
      ('constraint'::text, 'drizzle.__meal_agent_migrations.__meal_agent_migrations_applied_at_not_null'::text, 'contype=n def=NOT NULL applied_at'::text),
      ('constraint', 'drizzle.__meal_agent_migrations.__meal_agent_migrations_hash_not_null', 'contype=n def=NOT NULL hash'),
      ('constraint', 'drizzle.__meal_agent_migrations.__meal_agent_migrations_name_not_null', 'contype=n def=NOT NULL name'),
      ('constraint', 'drizzle.__meal_agent_migrations.__meal_agent_migrations_pkey', 'contype=p def=PRIMARY KEY (name)'),
      ('constraint', 'public.auth_identities.auth_identities_created_at_not_null', 'contype=n def=NOT NULL created_at'),
      ('constraint', 'public.auth_identities.auth_identities_id_not_null', 'contype=n def=NOT NULL id'),
      ('constraint', 'public.auth_identities.auth_identities_id_user_unique', 'contype=u def=UNIQUE (id, user_id)'),
      ('constraint', 'public.auth_identities.auth_identities_last_authenticated_at_not_null', 'contype=n def=NOT NULL last_authenticated_at'),
      ('constraint', 'public.auth_identities.auth_identities_pkey', 'contype=p def=PRIMARY KEY (id)'),
      ('constraint', 'public.auth_identities.auth_identities_provider_check', 'contype=c def=CHECK (((provider)::text = ANY ((ARRAY[''wechat_miniprogram''::character varying, ''phone''::character varying, ''apple''::character varying, ''huawei''::character varying])::text[])))'),
      ('constraint', 'public.auth_identities.auth_identities_provider_not_null', 'contype=n def=NOT NULL provider'),
      ('constraint', 'public.auth_identities.auth_identities_provider_subject_not_null', 'contype=n def=NOT NULL provider_subject'),
      ('constraint', 'public.auth_identities.auth_identities_provider_subject_unique', 'contype=u def=UNIQUE (provider, provider_tenant_key, provider_subject)'),
      ('constraint', 'public.auth_identities.auth_identities_provider_tenant_key_not_null', 'contype=n def=NOT NULL provider_tenant_key'),
      ('constraint', 'public.auth_identities.auth_identities_status_check', 'contype=c def=CHECK (((status)::text = ANY ((ARRAY[''active''::character varying, ''disabled''::character varying])::text[])))'),
      ('constraint', 'public.auth_identities.auth_identities_status_not_null', 'contype=n def=NOT NULL status'),
      ('constraint', 'public.auth_identities.auth_identities_user_id_fkey', 'contype=f def=FOREIGN KEY (user_id) REFERENCES public.users(id)'),
      ('constraint', 'public.auth_identities.auth_identities_user_id_not_null', 'contype=n def=NOT NULL user_id'),
      ('constraint', 'public.households.households_created_at_not_null', 'contype=n def=NOT NULL created_at'),
      ('constraint', 'public.households.households_created_by_user_id_fkey', 'contype=f def=FOREIGN KEY (created_by_user_id) REFERENCES public.users(id)'),
      ('constraint', 'public.households.households_created_by_user_id_not_null', 'contype=n def=NOT NULL created_by_user_id'),
      ('constraint', 'public.households.households_id_not_null', 'contype=n def=NOT NULL id'),
      ('constraint', 'public.households.households_locale_not_null', 'contype=n def=NOT NULL locale'),
      ('constraint', 'public.households.households_name_not_null', 'contype=n def=NOT NULL name'),
      ('constraint', 'public.households.households_pkey', 'contype=p def=PRIMARY KEY (id)'),
      ('constraint', 'public.households.households_status_check', 'contype=c def=CHECK (((status)::text = ANY ((ARRAY[''active''::character varying, ''deletion_pending''::character varying, ''deleted''::character varying])::text[])))'),
      ('constraint', 'public.households.households_status_not_null', 'contype=n def=NOT NULL status'),
      ('constraint', 'public.households.households_timezone_not_null', 'contype=n def=NOT NULL timezone'),
      ('constraint', 'public.households.households_updated_at_not_null', 'contype=n def=NOT NULL updated_at'),
      ('constraint', 'public.households.households_version_check', 'contype=c def=CHECK ((version >= 0))'),
      ('constraint', 'public.households.households_version_not_null', 'contype=n def=NOT NULL version'),
      ('constraint', 'public.idempotency_records.idempotency_records_completion_check', 'contype=c def=CHECK (((status_code IS NULL) = (response_body IS NULL)))'),
      ('constraint', 'public.idempotency_records.idempotency_records_expires_at_not_null', 'contype=n def=NOT NULL expires_at'),
      ('constraint', 'public.idempotency_records.idempotency_records_first_processed_at_not_null', 'contype=n def=NOT NULL first_processed_at'),
      ('constraint', 'public.idempotency_records.idempotency_records_id_not_null', 'contype=n def=NOT NULL id'),
      ('constraint', 'public.idempotency_records.idempotency_records_idempotency_key_not_null', 'contype=n def=NOT NULL idempotency_key'),
      ('constraint', 'public.idempotency_records.idempotency_records_membership_foreign', 'contype=f def=FOREIGN KEY (household_id, user_id) REFERENCES public.memberships(household_id, user_id)'),
      ('constraint', 'public.idempotency_records.idempotency_records_method_not_null', 'contype=n def=NOT NULL method'),
      ('constraint', 'public.idempotency_records.idempotency_records_normalized_route_not_null', 'contype=n def=NOT NULL normalized_route'),
      ('constraint', 'public.idempotency_records.idempotency_records_original_request_id_not_null', 'contype=n def=NOT NULL original_request_id'),
      ('constraint', 'public.idempotency_records.idempotency_records_pkey', 'contype=p def=PRIMARY KEY (id)'),
      ('constraint', 'public.idempotency_records.idempotency_records_request_hash_not_null', 'contype=n def=NOT NULL request_hash'),
      ('constraint', 'public.idempotency_records.idempotency_records_scope_check', 'contype=c def=CHECK (((((scope_kind)::text = ''user''::text) AND (household_id IS NULL)) OR (((scope_kind)::text = ''household''::text) AND (household_id IS NOT NULL))))'),
      ('constraint', 'public.idempotency_records.idempotency_records_scope_kind_not_null', 'contype=n def=NOT NULL scope_kind'),
      ('constraint', 'public.idempotency_records.idempotency_records_scope_unique', 'contype=u def=UNIQUE NULLS NOT DISTINCT (user_id, household_id, method, normalized_route, idempotency_key)'),
      ('constraint', 'public.idempotency_records.idempotency_records_status_check', 'contype=c def=CHECK (((status_code IS NULL) OR ((status_code >= 200) AND (status_code <= 299))))'),
      ('constraint', 'public.idempotency_records.idempotency_records_user_id_fkey', 'contype=f def=FOREIGN KEY (user_id) REFERENCES public.users(id)'),
      ('constraint', 'public.idempotency_records.idempotency_records_user_id_not_null', 'contype=n def=NOT NULL user_id'),
      ('constraint', 'public.inventory_events.inventory_events_actor_membership_foreign', 'contype=f def=FOREIGN KEY (household_id, actor_user_id) REFERENCES public.memberships(household_id, user_id)'),
      ('constraint', 'public.inventory_events.inventory_events_actor_user_id_not_null', 'contype=n def=NOT NULL actor_user_id'),
      ('constraint', 'public.inventory_events.inventory_events_correction_foreign', 'contype=f def=FOREIGN KEY (household_id, correction_of_event_id) REFERENCES public.inventory_events(household_id, id)'),
      ('constraint', 'public.inventory_events.inventory_events_expected_lot_version_not_null', 'contype=n def=NOT NULL expected_lot_version'),
      ('constraint', 'public.inventory_events.inventory_events_household_actor_route_idempotency_unique', 'contype=u def=UNIQUE (household_id, actor_user_id, normalized_route, idempotency_key)'),
      ('constraint', 'public.inventory_events.inventory_events_household_id_not_null', 'contype=n def=NOT NULL household_id'),
      ('constraint', 'public.inventory_events.inventory_events_household_id_unique', 'contype=u def=UNIQUE (household_id, id)'),
      ('constraint', 'public.inventory_events.inventory_events_id_not_null', 'contype=n def=NOT NULL id'),
      ('constraint', 'public.inventory_events.inventory_events_idempotency_key_not_null', 'contype=n def=NOT NULL idempotency_key'),
      ('constraint', 'public.inventory_events.inventory_events_inventory_lot_id_not_null', 'contype=n def=NOT NULL inventory_lot_id'),
      ('constraint', 'public.inventory_events.inventory_events_lot_foreign', 'contype=f def=FOREIGN KEY (household_id, inventory_lot_id) REFERENCES public.inventory_lots(household_id, id)'),
      ('constraint', 'public.inventory_events.inventory_events_normalized_route_not_null', 'contype=n def=NOT NULL normalized_route'),
      ('constraint', 'public.inventory_events.inventory_events_occurred_at_not_null', 'contype=n def=NOT NULL occurred_at'),
      ('constraint', 'public.inventory_events.inventory_events_pkey', 'contype=p def=PRIMARY KEY (id)'),
      ('constraint', 'public.inventory_events.inventory_events_quantity_shape_check', 'contype=c def=CHECK ((((quantity_change_kind IS NULL) AND (quantity_change_amount IS NULL) AND (quantity_from_level IS NULL) AND (quantity_to_level IS NULL)) OR (((quantity_change_kind)::text = ''numeric''::text) AND (quantity_change_amount IS NOT NULL) AND (quantity_change_amount <> (0)::numeric) AND (quantity_change_unit IS NOT NULL) AND ((quantity_change_precision)::text = ANY ((ARRAY[''exact''::character varying, ''estimated''::character varying])::text[])) AND (quantity_from_level IS NULL) AND (quantity_to_level IS NULL) AND ((((quantity_change_precision)::text = ''exact''::text) AND (quantity_change_confidence IS NULL)) OR (((quantity_change_precision)::text = ''estimated''::text) AND ((quantity_change_confidence)::text = ANY ((ARRAY[''high''::character varying, ''medium''::character varying, ''low''::character varying])::text[])) AND (quantity_change_original_text IS NOT NULL)))) OR (((quantity_change_kind)::text = ''qualitative''::text) AND (quantity_change_amount IS NULL) AND (quantity_change_unit IS NULL) AND (quantity_change_precision IS NULL) AND ((quantity_from_level)::text = ANY ((ARRAY[''plenty''::character varying, ''some''::character varying, ''low''::character varying, ''empty''::character varying, ''unknown''::character varying])::text[])) AND ((quantity_to_level)::text = ANY ((ARRAY[''plenty''::character varying, ''some''::character varying, ''low''::character varying, ''empty''::character varying, ''unknown''::character varying])::text[])) AND ((quantity_from_level)::text <> (quantity_to_level)::text))))'),
      ('constraint', 'public.inventory_events.inventory_events_recorded_at_not_null', 'contype=n def=NOT NULL recorded_at'),
      ('constraint', 'public.inventory_events.inventory_events_resulting_lot_version_not_null', 'contype=n def=NOT NULL resulting_lot_version'),
      ('constraint', 'public.inventory_events.inventory_events_source_not_null', 'contype=n def=NOT NULL source'),
      ('constraint', 'public.inventory_events.inventory_events_type_not_null', 'contype=n def=NOT NULL type'),
      ('constraint', 'public.inventory_events.inventory_events_version_check', 'contype=c def=CHECK (((expected_lot_version >= 0) AND (resulting_lot_version = (expected_lot_version + 1))))'),
      ('constraint', 'public.inventory_lots.inventory_lots_created_at_not_null', 'contype=n def=NOT NULL created_at'),
      ('constraint', 'public.inventory_lots.inventory_lots_created_by_user_id_not_null', 'contype=n def=NOT NULL created_by_user_id'),
      ('constraint', 'public.inventory_lots.inventory_lots_creator_membership_foreign', 'contype=f def=FOREIGN KEY (household_id, created_by_user_id) REFERENCES public.memberships(household_id, user_id)'),
      ('constraint', 'public.inventory_lots.inventory_lots_current_quantity_kind_not_null', 'contype=n def=NOT NULL current_quantity_kind'),
      ('constraint', 'public.inventory_lots.inventory_lots_dates_check', 'contype=c def=CHECK (((jsonb_typeof(dates) = ''array''::text) AND (jsonb_array_length(dates) <= 9)))'),
      ('constraint', 'public.inventory_lots.inventory_lots_dates_not_null', 'contype=n def=NOT NULL dates'),
      ('constraint', 'public.inventory_lots.inventory_lots_display_name_not_null', 'contype=n def=NOT NULL display_name'),
      ('constraint', 'public.inventory_lots.inventory_lots_household_id_fkey', 'contype=f def=FOREIGN KEY (household_id) REFERENCES public.households(id)'),
      ('constraint', 'public.inventory_lots.inventory_lots_household_id_not_null', 'contype=n def=NOT NULL household_id'),
      ('constraint', 'public.inventory_lots.inventory_lots_household_id_unique', 'contype=u def=UNIQUE (household_id, id)'),
      ('constraint', 'public.inventory_lots.inventory_lots_id_not_null', 'contype=n def=NOT NULL id'),
      ('constraint', 'public.inventory_lots.inventory_lots_origin_check', 'contype=c def=CHECK (((origin)::text = ANY ((ARRAY[''manual''::character varying, ''shopping_confirmation''::character varying, ''leftover''::character varying, ''confirmed_import''::character varying])::text[])))'),
      ('constraint', 'public.inventory_lots.inventory_lots_origin_not_null', 'contype=n def=NOT NULL origin'),
      ('constraint', 'public.inventory_lots.inventory_lots_pkey', 'contype=p def=PRIMARY KEY (id)'),
      ('constraint', 'public.inventory_lots.inventory_lots_quantity_shape_check', 'contype=c def=CHECK (((((current_quantity_kind)::text = ''exact''::text) AND (current_quantity_amount IS NOT NULL) AND (current_quantity_amount >= (0)::numeric) AND (current_quantity_unit IS NOT NULL) AND (current_quantity_confidence IS NULL) AND (current_quantity_level IS NULL)) OR (((current_quantity_kind)::text = ''approximate''::text) AND (current_quantity_amount IS NOT NULL) AND (current_quantity_amount >= (0)::numeric) AND (current_quantity_unit IS NOT NULL) AND ((current_quantity_confidence)::text = ANY ((ARRAY[''high''::character varying, ''medium''::character varying, ''low''::character varying])::text[])) AND (current_quantity_original_text IS NOT NULL) AND (current_quantity_level IS NULL)) OR (((current_quantity_kind)::text = ''qualitative''::text) AND (current_quantity_amount IS NULL) AND (current_quantity_unit IS NULL) AND (current_quantity_confidence IS NULL) AND ((current_quantity_level)::text = ANY ((ARRAY[''plenty''::character varying, ''some''::character varying, ''low''::character varying, ''empty''::character varying, ''unknown''::character varying])::text[])))))'),
      ('constraint', 'public.inventory_lots.inventory_lots_safety_evaluated_at_not_null', 'contype=n def=NOT NULL safety_evaluated_at'),
      ('constraint', 'public.inventory_lots.inventory_lots_safety_policy_version_not_null', 'contype=n def=NOT NULL safety_policy_version'),
      ('constraint', 'public.inventory_lots.inventory_lots_safety_reason_codes_check', 'contype=c def=CHECK ((jsonb_typeof(safety_reason_codes) = ''array''::text))'),
      ('constraint', 'public.inventory_lots.inventory_lots_safety_reason_codes_not_null', 'contype=n def=NOT NULL safety_reason_codes'),
      ('constraint', 'public.inventory_lots.inventory_lots_safety_status_check', 'contype=c def=CHECK (((safety_status)::text = ANY ((ARRAY[''eligible''::character varying, ''blocked''::character varying, ''unknown''::character varying])::text[])))'),
      ('constraint', 'public.inventory_lots.inventory_lots_safety_status_not_null', 'contype=n def=NOT NULL safety_status'),
      ('constraint', 'public.inventory_lots.inventory_lots_state_check', 'contype=c def=CHECK (((state)::text = ANY ((ARRAY[''active''::character varying, ''depleted''::character varying, ''discarded''::character varying])::text[])))'),
      ('constraint', 'public.inventory_lots.inventory_lots_state_not_null', 'contype=n def=NOT NULL state'),
      ('constraint', 'public.inventory_lots.inventory_lots_state_quantity_check', 'contype=c def=CHECK (((((state)::text = ''active''::text) AND ((((current_quantity_kind)::text = ANY ((ARRAY[''exact''::character varying, ''approximate''::character varying])::text[])) AND (current_quantity_amount > (0)::numeric)) OR (((current_quantity_kind)::text = ''qualitative''::text) AND ((current_quantity_level)::text <> ''empty''::text)))) OR (((state)::text = ANY ((ARRAY[''depleted''::character varying, ''discarded''::character varying])::text[])) AND ((((current_quantity_kind)::text = ''exact''::text) AND (current_quantity_amount = (0)::numeric)) OR (((current_quantity_kind)::text = ''qualitative''::text) AND ((current_quantity_level)::text = ''empty''::text))))))'),
      ('constraint', 'public.inventory_lots.inventory_lots_storage_location_check', 'contype=c def=CHECK (((storage_location)::text = ANY ((ARRAY[''pantry''::character varying, ''refrigerated''::character varying, ''frozen''::character varying, ''other''::character varying])::text[])))'),
      ('constraint', 'public.inventory_lots.inventory_lots_storage_location_not_null', 'contype=n def=NOT NULL storage_location'),
      ('constraint', 'public.inventory_lots.inventory_lots_updated_at_not_null', 'contype=n def=NOT NULL updated_at'),
      ('constraint', 'public.inventory_lots.inventory_lots_version_check', 'contype=c def=CHECK ((version > 0))'),
      ('constraint', 'public.inventory_lots.inventory_lots_version_not_null', 'contype=n def=NOT NULL version'),
      ('constraint', 'public.memberships.memberships_capabilities_check', 'contype=c def=CHECK ((jsonb_typeof(capabilities) = ''array''::text))'),
      ('constraint', 'public.memberships.memberships_capabilities_not_null', 'contype=n def=NOT NULL capabilities'),
      ('constraint', 'public.memberships.memberships_household_id_fkey', 'contype=f def=FOREIGN KEY (household_id) REFERENCES public.households(id)'),
      ('constraint', 'public.memberships.memberships_household_id_not_null', 'contype=n def=NOT NULL household_id'),
      ('constraint', 'public.memberships.memberships_household_id_unique', 'contype=u def=UNIQUE (household_id, id)'),
      ('constraint', 'public.memberships.memberships_household_user_unique', 'contype=u def=UNIQUE (household_id, user_id)'),
      ('constraint', 'public.memberships.memberships_id_not_null', 'contype=n def=NOT NULL id'),
      ('constraint', 'public.memberships.memberships_joined_at_not_null', 'contype=n def=NOT NULL joined_at'),
      ('constraint', 'public.memberships.memberships_pkey', 'contype=p def=PRIMARY KEY (id)'),
      ('constraint', 'public.memberships.memberships_role_check', 'contype=c def=CHECK (((role)::text = ANY ((ARRAY[''owner''::character varying, ''member''::character varying])::text[])))'),
      ('constraint', 'public.memberships.memberships_role_not_null', 'contype=n def=NOT NULL role'),
      ('constraint', 'public.memberships.memberships_status_check', 'contype=c def=CHECK (((status)::text = ANY ((ARRAY[''active''::character varying, ''left''::character varying, ''removed''::character varying])::text[])))'),
      ('constraint', 'public.memberships.memberships_status_not_null', 'contype=n def=NOT NULL status'),
      ('constraint', 'public.memberships.memberships_updated_at_not_null', 'contype=n def=NOT NULL updated_at'),
      ('constraint', 'public.memberships.memberships_user_id_fkey', 'contype=f def=FOREIGN KEY (user_id) REFERENCES public.users(id)'),
      ('constraint', 'public.memberships.memberships_user_id_not_null', 'contype=n def=NOT NULL user_id'),
      ('constraint', 'public.memberships.memberships_version_check', 'contype=c def=CHECK ((version >= 0))'),
      ('constraint', 'public.memberships.memberships_version_not_null', 'contype=n def=NOT NULL version'),
      ('constraint', 'public.person_profiles.person_profiles_cooking_skill_check', 'contype=c def=CHECK (((cooking_skill)::text = ANY ((ARRAY[''none''::character varying, ''beginner''::character varying, ''intermediate''::character varying, ''advanced''::character varying])::text[])))'),
      ('constraint', 'public.person_profiles.person_profiles_cooking_skill_not_null', 'contype=n def=NOT NULL cooking_skill'),
      ('constraint', 'public.person_profiles.person_profiles_created_at_not_null', 'contype=n def=NOT NULL created_at'),
      ('constraint', 'public.person_profiles.person_profiles_default_participation_check', 'contype=c def=CHECK ((default_participation = ANY (ARRAY[0, 1])))'),
      ('constraint', 'public.person_profiles.person_profiles_default_participation_not_null', 'contype=n def=NOT NULL default_participation'),
      ('constraint', 'public.person_profiles.person_profiles_default_portion_scale_check', 'contype=c def=CHECK (((default_portion_scale >= 0.25) AND (default_portion_scale <= (4)::numeric)))'),
      ('constraint', 'public.person_profiles.person_profiles_default_portion_scale_not_null', 'contype=n def=NOT NULL default_portion_scale'),
      ('constraint', 'public.person_profiles.person_profiles_dietary_constraints_check', 'contype=c def=CHECK ((jsonb_typeof(dietary_constraints) = ''array''::text))'),
      ('constraint', 'public.person_profiles.person_profiles_dietary_constraints_not_null', 'contype=n def=NOT NULL dietary_constraints'),
      ('constraint', 'public.person_profiles.person_profiles_display_name_not_null', 'contype=n def=NOT NULL display_name'),
      ('constraint', 'public.person_profiles.person_profiles_household_id_fkey', 'contype=f def=FOREIGN KEY (household_id) REFERENCES public.households(id)'),
      ('constraint', 'public.person_profiles.person_profiles_household_id_not_null', 'contype=n def=NOT NULL household_id'),
      ('constraint', 'public.person_profiles.person_profiles_household_id_unique', 'contype=u def=UNIQUE (household_id, id)'),
      ('constraint', 'public.person_profiles.person_profiles_id_not_null', 'contype=n def=NOT NULL id'),
      ('constraint', 'public.person_profiles.person_profiles_membership_foreign', 'contype=f def=FOREIGN KEY (household_id, linked_membership_id) REFERENCES public.memberships(household_id, id)'),
      ('constraint', 'public.person_profiles.person_profiles_pkey', 'contype=p def=PRIMARY KEY (id)'),
      ('constraint', 'public.person_profiles.person_profiles_status_check', 'contype=c def=CHECK (((status)::text = ANY ((ARRAY[''active''::character varying, ''archived''::character varying])::text[])))'),
      ('constraint', 'public.person_profiles.person_profiles_status_not_null', 'contype=n def=NOT NULL status'),
      ('constraint', 'public.person_profiles.person_profiles_updated_at_not_null', 'contype=n def=NOT NULL updated_at'),
      ('constraint', 'public.person_profiles.person_profiles_version_check', 'contype=c def=CHECK ((version >= 0))'),
      ('constraint', 'public.person_profiles.person_profiles_version_not_null', 'contype=n def=NOT NULL version'),
      ('constraint', 'public.sessions.sessions_auth_identity_id_not_null', 'contype=n def=NOT NULL auth_identity_id'),
      ('constraint', 'public.sessions.sessions_expires_at_not_null', 'contype=n def=NOT NULL expires_at'),
      ('constraint', 'public.sessions.sessions_expiry_check', 'contype=c def=CHECK (((expires_at > issued_at) AND (idle_expires_at > issued_at)))'),
      ('constraint', 'public.sessions.sessions_id_not_null', 'contype=n def=NOT NULL id'),
      ('constraint', 'public.sessions.sessions_identity_user_foreign', 'contype=f def=FOREIGN KEY (auth_identity_id, user_id) REFERENCES public.auth_identities(id, user_id)'),
      ('constraint', 'public.sessions.sessions_idle_expires_at_not_null', 'contype=n def=NOT NULL idle_expires_at'),
      ('constraint', 'public.sessions.sessions_issued_at_not_null', 'contype=n def=NOT NULL issued_at'),
      ('constraint', 'public.sessions.sessions_last_seen_at_not_null', 'contype=n def=NOT NULL last_seen_at'),
      ('constraint', 'public.sessions.sessions_pkey', 'contype=p def=PRIMARY KEY (id)'),
      ('constraint', 'public.sessions.sessions_revoked_at_check', 'contype=c def=CHECK ((((status)::text = ''revoked''::text) = (revoked_at IS NOT NULL)))'),
      ('constraint', 'public.sessions.sessions_status_check', 'contype=c def=CHECK (((status)::text = ANY ((ARRAY[''active''::character varying, ''expired''::character varying, ''revoked''::character varying])::text[])))'),
      ('constraint', 'public.sessions.sessions_status_not_null', 'contype=n def=NOT NULL status'),
      ('constraint', 'public.sessions.sessions_token_digest_not_null', 'contype=n def=NOT NULL token_digest'),
      ('constraint', 'public.sessions.sessions_token_digest_unique', 'contype=u def=UNIQUE (token_digest)'),
      ('constraint', 'public.sessions.sessions_token_version_check', 'contype=c def=CHECK ((token_version > 0))'),
      ('constraint', 'public.sessions.sessions_token_version_not_null', 'contype=n def=NOT NULL token_version'),
      ('constraint', 'public.sessions.sessions_user_id_fkey', 'contype=f def=FOREIGN KEY (user_id) REFERENCES public.users(id)'),
      ('constraint', 'public.sessions.sessions_user_id_not_null', 'contype=n def=NOT NULL user_id'),
      ('constraint', 'public.users.users_created_at_not_null', 'contype=n def=NOT NULL created_at'),
      ('constraint', 'public.users.users_id_not_null', 'contype=n def=NOT NULL id'),
      ('constraint', 'public.users.users_locale_not_null', 'contype=n def=NOT NULL locale'),
      ('constraint', 'public.users.users_pkey', 'contype=p def=PRIMARY KEY (id)'),
      ('constraint', 'public.users.users_status_check', 'contype=c def=CHECK (((status)::text = ANY ((ARRAY[''active''::character varying, ''disabled''::character varying, ''deletion_pending''::character varying])::text[])))'),
      ('constraint', 'public.users.users_status_not_null', 'contype=n def=NOT NULL status'),
      ('constraint', 'public.users.users_updated_at_not_null', 'contype=n def=NOT NULL updated_at'),
      ('constraint', 'public.users.users_version_check', 'contype=c def=CHECK ((version >= 0))'),
      ('constraint', 'public.users.users_version_not_null', 'contype=n def=NOT NULL version'),
      ('index', 'drizzle.__meal_agent_migrations_pkey', 'table=drizzle.__meal_agent_migrations def=CREATE UNIQUE INDEX __meal_agent_migrations_pkey ON drizzle.__meal_agent_migrations USING btree (name)'),
      ('index', 'public.auth_identities_id_user_unique', 'table=public.auth_identities def=CREATE UNIQUE INDEX auth_identities_id_user_unique ON public.auth_identities USING btree (id, user_id)'),
      ('index', 'public.auth_identities_pkey', 'table=public.auth_identities def=CREATE UNIQUE INDEX auth_identities_pkey ON public.auth_identities USING btree (id)'),
      ('index', 'public.auth_identities_provider_subject_unique', 'table=public.auth_identities def=CREATE UNIQUE INDEX auth_identities_provider_subject_unique ON public.auth_identities USING btree (provider, provider_tenant_key, provider_subject)'),
      ('index', 'public.households_pkey', 'table=public.households def=CREATE UNIQUE INDEX households_pkey ON public.households USING btree (id)'),
      ('index', 'public.idempotency_records_pkey', 'table=public.idempotency_records def=CREATE UNIQUE INDEX idempotency_records_pkey ON public.idempotency_records USING btree (id)'),
      ('index', 'public.idempotency_records_scope_unique', 'table=public.idempotency_records def=CREATE UNIQUE INDEX idempotency_records_scope_unique ON public.idempotency_records USING btree (user_id, household_id, method, normalized_route, idempotency_key) NULLS NOT DISTINCT'),
      ('index', 'public.inventory_events_household_actor_route_idempotency_unique', 'table=public.inventory_events def=CREATE UNIQUE INDEX inventory_events_household_actor_route_idempotency_unique ON public.inventory_events USING btree (household_id, actor_user_id, normalized_route, idempotency_key)'),
      ('index', 'public.inventory_events_household_id_unique', 'table=public.inventory_events def=CREATE UNIQUE INDEX inventory_events_household_id_unique ON public.inventory_events USING btree (household_id, id)'),
      ('index', 'public.inventory_events_lot_recorded_index', 'table=public.inventory_events def=CREATE INDEX inventory_events_lot_recorded_index ON public.inventory_events USING btree (household_id, inventory_lot_id, recorded_at, id)'),
      ('index', 'public.inventory_events_pkey', 'table=public.inventory_events def=CREATE UNIQUE INDEX inventory_events_pkey ON public.inventory_events USING btree (id)'),
      ('index', 'public.inventory_lots_household_created_index', 'table=public.inventory_lots def=CREATE INDEX inventory_lots_household_created_index ON public.inventory_lots USING btree (household_id, created_at, id)'),
      ('index', 'public.inventory_lots_household_id_unique', 'table=public.inventory_lots def=CREATE UNIQUE INDEX inventory_lots_household_id_unique ON public.inventory_lots USING btree (household_id, id)'),
      ('index', 'public.inventory_lots_pkey', 'table=public.inventory_lots def=CREATE UNIQUE INDEX inventory_lots_pkey ON public.inventory_lots USING btree (id)'),
      ('index', 'public.memberships_household_id_unique', 'table=public.memberships def=CREATE UNIQUE INDEX memberships_household_id_unique ON public.memberships USING btree (household_id, id)'),
      ('index', 'public.memberships_household_user_unique', 'table=public.memberships def=CREATE UNIQUE INDEX memberships_household_user_unique ON public.memberships USING btree (household_id, user_id)'),
      ('index', 'public.memberships_pkey', 'table=public.memberships def=CREATE UNIQUE INDEX memberships_pkey ON public.memberships USING btree (id)'),
      ('index', 'public.memberships_user_active_index', 'table=public.memberships def=CREATE INDEX memberships_user_active_index ON public.memberships USING btree (user_id, household_id) WHERE ((status)::text = ''active''::text)'),
      ('index', 'public.person_profiles_household_id_unique', 'table=public.person_profiles def=CREATE UNIQUE INDEX person_profiles_household_id_unique ON public.person_profiles USING btree (household_id, id)'),
      ('index', 'public.person_profiles_linked_membership_unique', 'table=public.person_profiles def=CREATE UNIQUE INDEX person_profiles_linked_membership_unique ON public.person_profiles USING btree (household_id, linked_membership_id) WHERE (linked_membership_id IS NOT NULL)'),
      ('index', 'public.person_profiles_pkey', 'table=public.person_profiles def=CREATE UNIQUE INDEX person_profiles_pkey ON public.person_profiles USING btree (id)'),
      ('index', 'public.sessions_pkey', 'table=public.sessions def=CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (id)'),
      ('index', 'public.sessions_token_digest_unique', 'table=public.sessions def=CREATE UNIQUE INDEX sessions_token_digest_unique ON public.sessions USING btree (token_digest)'),
      ('index', 'public.users_pkey', 'table=public.users def=CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)'),
      ('policy', 'public.households.households_creator_insert', 'cmd=a permissive=t roles=meal_agent_app using= check=((id = meal_agent_private.app_household_id()) AND (created_by_user_id = meal_agent_private.app_user_id()) AND ((status)::text = ''active''::text))'),
      ('policy', 'public.households.households_user_list_select', 'cmd=r permissive=t roles=meal_agent_app using=(((meal_agent_private.app_household_id() IS NULL) OR (id = meal_agent_private.app_household_id())) AND meal_agent_private.has_active_membership(id)) check='),
      ('policy', 'public.idempotency_records.idempotency_records_scope_insert', 'cmd=a permissive=t roles=meal_agent_app using= check=((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = ''user''::text) AND (household_id IS NULL)) OR (((scope_kind)::text = ''household''::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))))'),
      ('policy', 'public.idempotency_records.idempotency_records_scope_select', 'cmd=r permissive=t roles=meal_agent_app using=((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = ''user''::text) AND (household_id IS NULL)) OR (((scope_kind)::text = ''household''::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id)))) check='),
      ('policy', 'public.idempotency_records.idempotency_records_scope_update', 'cmd=w permissive=t roles=meal_agent_app using=((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = ''user''::text) AND (household_id IS NULL)) OR (((scope_kind)::text = ''household''::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id)))) check=((user_id = meal_agent_private.app_user_id()) AND ((((scope_kind)::text = ''user''::text) AND (household_id IS NULL)) OR (((scope_kind)::text = ''household''::text) AND (household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))))'),
      ('policy', 'public.inventory_events.inventory_events_household_insert', 'cmd=a permissive=t roles=meal_agent_app using= check=((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))'),
      ('policy', 'public.inventory_events.inventory_events_household_select', 'cmd=r permissive=t roles=meal_agent_app using=((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id)) check='),
      ('policy', 'public.inventory_lots.inventory_lots_household_insert', 'cmd=a permissive=t roles=meal_agent_app using= check=((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))'),
      ('policy', 'public.inventory_lots.inventory_lots_household_select', 'cmd=r permissive=t roles=meal_agent_app using=((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id)) check='),
      ('policy', 'public.inventory_lots.inventory_lots_household_update', 'cmd=w permissive=t roles=meal_agent_app using=((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id)) check=((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))'),
      ('policy', 'public.memberships.memberships_bootstrap_select', 'cmd=r permissive=t roles=meal_agent_app using=((user_id = meal_agent_private.app_user_id()) AND ((status)::text = ''active''::text) AND ((meal_agent_private.app_household_id() IS NULL) OR (household_id = meal_agent_private.app_household_id()))) check='),
      ('policy', 'public.memberships.memberships_creator_insert', 'cmd=a permissive=t roles=meal_agent_app using= check=((household_id = meal_agent_private.app_household_id()) AND (user_id = meal_agent_private.app_user_id()) AND ((role)::text = ''owner''::text) AND ((status)::text = ''active''::text) AND meal_agent_private.is_household_creator(household_id))'),
      ('policy', 'public.person_profiles.person_profiles_household_insert', 'cmd=a permissive=t roles=meal_agent_app using= check=((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id))'),
      ('policy', 'public.person_profiles.person_profiles_household_select', 'cmd=r permissive=t roles=meal_agent_app using=((household_id = meal_agent_private.app_household_id()) AND meal_agent_private.has_active_membership(household_id)) check='),
      ('relation', 'drizzle.__meal_agent_migrations', 'relkind=r owner=handoff-pending rls=f force=f'),
      ('relation', 'public.auth_identities', 'relkind=r owner=meal_agent_migrator rls=f force=f'),
      ('relation', 'public.households', 'relkind=r owner=meal_agent_migrator rls=t force=t'),
      ('relation', 'public.idempotency_records', 'relkind=r owner=meal_agent_migrator rls=t force=t'),
      ('relation', 'public.inventory_events', 'relkind=r owner=meal_agent_migrator rls=t force=t'),
      ('relation', 'public.inventory_lots', 'relkind=r owner=meal_agent_migrator rls=t force=t'),
      ('relation', 'public.memberships', 'relkind=r owner=meal_agent_migrator rls=t force=t'),
      ('relation', 'public.person_profiles', 'relkind=r owner=meal_agent_migrator rls=t force=t'),
      ('relation', 'public.sessions', 'relkind=r owner=meal_agent_migrator rls=f force=f'),
      ('relation', 'public.users', 'relkind=r owner=meal_agent_migrator rls=f force=f'),
      ('routine', 'meal_agent_private.app_household_id()', 'prokind=f owner=meal_agent_migrator secdef=f lang=sql volatile=s parallel=s leakproof=f result=uuid config= body=e819902d79596d6c78928edad3ee0958ccb5776d8b5b8f4428b2449703e13246'),
      ('routine', 'meal_agent_private.app_user_id()', 'prokind=f owner=meal_agent_migrator secdef=f lang=sql volatile=s parallel=s leakproof=f result=uuid config= body=e3aed6cdba18c19ee29c76279c780af119a11fddd9c9a1737c57684553871c5a'),
      ('routine', 'meal_agent_private.has_active_membership(target_household_id uuid)', 'prokind=f owner=meal_agent_migrator secdef=t lang=sql volatile=s parallel=u leakproof=f result=boolean config=search_path=pg_catalog, public|row_security=off body=07ed8a19a0ee1b8b9d03a6113c3f02b0c0e4a756755ca08bd791cdb19f73cf6b'),
      ('routine', 'meal_agent_private.is_household_creator(target_household_id uuid)', 'prokind=f owner=meal_agent_migrator secdef=t lang=sql volatile=s parallel=u leakproof=f result=boolean config=search_path=pg_catalog, public|row_security=off body=5ff25647b8bfcdb0cdca164f011c959e2aeae10f7ce85d97fc420689dfe01a7a'),
      ('schema', 'drizzle', 'owner=handoff-pending'),
      ('schema', 'meal_agent_private', 'owner=meal_agent_migrator'),
      ('schema', 'public', 'owner=handoff-pending')
  ),
  actual (kind, identity, detail) AS (
    SELECT kind, identity, detail
      FROM (
        SELECT 'schema'::text AS kind,
               n.nspname::text AS identity,
               'owner=' || CASE
              WHEN 'schema:' || n.nspname::text
                     = ANY (ARRAY['relation:drizzle.__meal_agent_migrations', 'schema:drizzle', 'schema:public']::text[])
                   AND pg_catalog.pg_get_userbyid(n.nspowner)::text = ANY (ARRAY['meal_agent_migrator', 'pg_database_owner', current_user::text]::text[])
                THEN 'handoff-pending'
              ELSE pg_catalog.pg_get_userbyid(n.nspowner)::text
            END AS detail
          FROM pg_catalog.pg_namespace n
         WHERE n.nspname <> 'information_schema'
           AND n.nspname !~ '^pg_'
        UNION ALL
        SELECT 'relation'::text,
               (n.nspname || '.' || c.relname)::text,
               ('relkind=' || c.relkind::text
                 || ' owner=' || CASE
              WHEN 'relation:' || (n.nspname || '.' || c.relname)::text
                     = ANY (ARRAY['relation:drizzle.__meal_agent_migrations', 'schema:drizzle', 'schema:public']::text[])
                   AND pg_catalog.pg_get_userbyid(c.relowner)::text = ANY (ARRAY['meal_agent_migrator', 'pg_database_owner', current_user::text]::text[])
                THEN 'handoff-pending'
              ELSE pg_catalog.pg_get_userbyid(c.relowner)::text
            END
                 || ' rls=' || CASE WHEN c.relrowsecurity THEN 't' ELSE 'f' END
                 || ' force='
                 || CASE WHEN c.relforcerowsecurity THEN 't' ELSE 'f' END)::text
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        UNION ALL
        SELECT 'index'::text,
               (n.nspname || '.' || ci.relname)::text,
               ('table=' || n.nspname || '.' || ct.relname
                 || ' def=' || pg_catalog.pg_get_indexdef(i.indexrelid))::text
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ci ON ci.oid = i.indexrelid
          JOIN pg_catalog.pg_class ct ON ct.oid = i.indrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ci.relnamespace
         WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
        UNION ALL
        SELECT 'constraint'::text,
               (n.nspname || '.' || ct.relname || '.' || con.conname)::text,
               ('contype=' || con.contype::text
                 || ' def=' || pg_catalog.pg_get_constraintdef(con.oid))::text
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class ct ON ct.oid = con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ct.relnamespace
         WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
        UNION ALL
        SELECT 'routine'::text,
               (n.nspname || '.' || p.proname || '('
                 || pg_catalog.pg_get_function_identity_arguments(p.oid)
                 || ')')::text,
               ('prokind=' || p.prokind::text
                 || ' owner=' || CASE
              WHEN 'routine:' || (n.nspname || '.' || p.proname || '('
                        || pg_catalog.pg_get_function_identity_arguments(p.oid)
                        || ')')::text
                     = ANY (ARRAY['relation:drizzle.__meal_agent_migrations', 'schema:drizzle', 'schema:public']::text[])
                   AND pg_catalog.pg_get_userbyid(p.proowner)::text = ANY (ARRAY['meal_agent_migrator', 'pg_database_owner', current_user::text]::text[])
                THEN 'handoff-pending'
              ELSE pg_catalog.pg_get_userbyid(p.proowner)::text
            END
                 || ' secdef=' || CASE WHEN p.prosecdef THEN 't' ELSE 'f' END
                 || ' lang=' || l.lanname
                 || ' volatile=' || p.provolatile::text
                 || ' parallel=' || p.proparallel::text
                 || ' leakproof='
                 || CASE WHEN p.proleakproof THEN 't' ELSE 'f' END
                 || ' result=' || pg_catalog.pg_get_function_result(p.oid)
                 || ' config='
                 || COALESCE(pg_catalog.array_to_string(p.proconfig, '|'), '')
                 || ' body='
                 || pg_catalog.encode(
                      pg_catalog.sha256(
                        pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex'))::text
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_catalog.pg_language l ON l.oid = p.prolang
         WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
        UNION ALL
        SELECT 'policy'::text,
               (n.nspname || '.' || ct.relname || '.' || pol.polname)::text,
               ('cmd=' || pol.polcmd::text
                 || ' permissive='
                 || CASE WHEN pol.polpermissive THEN 't' ELSE 'f' END
                 || ' roles=' || COALESCE(
                      (SELECT pg_catalog.string_agg(
                                r.rolname::text, ','
                                ORDER BY r.rolname::text COLLATE "C")
                         FROM pg_catalog.pg_roles r
                        WHERE r.oid = ANY (pol.polroles)), 'PUBLIC')
                 || ' using=' || COALESCE(
                      pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '')
                 || ' check=' || COALESCE(
                      pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid),
                      ''))::text
          FROM pg_catalog.pg_policy pol
          JOIN pg_catalog.pg_class ct ON ct.oid = pol.polrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ct.relnamespace
         WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
        UNION ALL
        SELECT 'type'::text,
               (n.nspname || '.' || t.typname)::text,
               ('typtype=' || t.typtype::text)::text
          FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
           AND t.typtype IN ('c', 'e', 'd', 'r', 'm')
           AND NOT EXISTS (SELECT 1
                             FROM pg_catalog.pg_class c
                            WHERE c.oid = t.typrelid AND c.relkind <> 'c')
        UNION ALL
        SELECT 'trigger'::text,
               (n.nspname || '.' || ct.relname || '.' || tg.tgname)::text,
               ('def=' || pg_catalog.pg_get_triggerdef(tg.oid))::text
          FROM pg_catalog.pg_trigger tg
          JOIN pg_catalog.pg_class ct ON ct.oid = tg.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ct.relnamespace
         WHERE n.nspname = ANY (ARRAY['drizzle', 'meal_agent_private', 'public']::text[])
           AND NOT tg.tgisinternal
      ) AS stage06_projection
  ),
  divergence_rows (kind, entry) AS (
    SELECT a.kind,
           'unexpected ' || a.kind || ' ' || a.identity || ' [' || a.detail || ']'
      FROM actual a
      LEFT JOIN expected e ON e.kind = a.kind AND e.identity = a.identity
     WHERE e.kind IS NULL
    UNION ALL
    SELECT e.kind, 'missing ' || e.kind || ' ' || e.identity
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
  ),
  -- 报告顺序按「结构性 → 派生性」固定：一张表被删掉时，operator 首先要看到的是
  -- "missing relation"，而不是它连带的十几条约束。排序完全确定，不依赖 locale。
  ranked_divergences (rank, entry) AS (
    SELECT CASE kind
             WHEN 'schema' THEN 1 WHEN 'relation' THEN 2 WHEN 'routine' THEN 3
             WHEN 'policy' THEN 4 WHEN 'trigger' THEN 5 WHEN 'type' THEN 6
             WHEN 'index' THEN 7 WHEN 'constraint' THEN 8 ELSE 9
           END,
           entry
      FROM divergence_rows
  )
  SELECT (SELECT count(*) FROM ranked_divergences)::integer,
         (SELECT pg_catalog.string_agg(
                   pg_catalog.left(entry, 500), '; '
                   ORDER BY rank, entry COLLATE "C")
            FROM (SELECT rank, entry FROM ranked_divergences
                   ORDER BY rank, entry COLLATE "C"
                   LIMIT 8) AS capped)
    INTO divergence_count, divergence;

  IF divergence_count > 0 THEN
    RAISE EXCEPTION
      'stage06 object manifest does not match the frozen 0000 '
      '(% divergence(s), manifest version 1): %',
      divergence_count,
      divergence
        || CASE WHEN divergence_count > 8
                  THEN '; ...' ELSE '' END;
  END IF;
END
$meal_agent_stage06_manifest$;
