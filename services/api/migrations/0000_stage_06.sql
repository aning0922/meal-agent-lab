DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meal_agent_migrator') THEN
    CREATE ROLE meal_agent_migrator NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meal_agent_app') THEN
    CREATE ROLE meal_agent_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$roles$;

ALTER ROLE meal_agent_migrator BYPASSRLS;
ALTER ROLE meal_agent_app NOBYPASSRLS;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  status varchar(32) NOT NULL
    CHECK (status IN ('active', 'disabled', 'deletion_pending')),
  display_name varchar(80),
  locale varchar(35) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE TABLE auth_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  provider varchar(32) NOT NULL
    CHECK (provider IN ('wechat_miniprogram', 'phone', 'apple', 'huawei')),
  provider_tenant_key varchar(128) NOT NULL,
  provider_subject varchar(255) NOT NULL,
  provider_union_subject varchar(255),
  status varchar(32) NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL,
  last_authenticated_at timestamptz NOT NULL,
  CONSTRAINT auth_identities_provider_subject_unique
    UNIQUE (provider, provider_tenant_key, provider_subject),
  CONSTRAINT auth_identities_id_user_unique UNIQUE (id, user_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  auth_identity_id uuid NOT NULL,
  token_digest char(64) NOT NULL
    CONSTRAINT sessions_token_digest_unique UNIQUE,
  status varchar(32) NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,
  token_version integer NOT NULL DEFAULT 1 CHECK (token_version > 0),
  CONSTRAINT sessions_identity_user_foreign
    FOREIGN KEY (auth_identity_id, user_id)
    REFERENCES auth_identities(id, user_id),
  CONSTRAINT sessions_expiry_check
    CHECK (expires_at > issued_at AND idle_expires_at > issued_at),
  CONSTRAINT sessions_revoked_at_check
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE households (
  id uuid PRIMARY KEY,
  name varchar(80) NOT NULL,
  timezone varchar(64) NOT NULL,
  locale varchar(35) NOT NULL,
  status varchar(32) NOT NULL
    CHECK (status IN ('active', 'deletion_pending', 'deleted')),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role varchar(32) NOT NULL CHECK (role IN ('owner', 'member')),
  capabilities jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'array'),
  status varchar(32) NOT NULL CHECK (status IN ('active', 'left', 'removed')),
  joined_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  CONSTRAINT memberships_household_user_unique UNIQUE (household_id, user_id),
  CONSTRAINT memberships_household_id_unique UNIQUE (household_id, id)
);

CREATE TABLE person_profiles (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  linked_membership_id uuid,
  display_name varchar(80) NOT NULL,
  status varchar(32) NOT NULL CHECK (status IN ('active', 'archived')),
  default_participation integer NOT NULL CHECK (default_participation IN (0, 1)),
  default_portion_scale numeric(6, 3) NOT NULL
    CHECK (default_portion_scale BETWEEN 0.25 AND 4),
  cooking_skill varchar(32) NOT NULL
    CHECK (cooking_skill IN ('none', 'beginner', 'intermediate', 'advanced')),
  dietary_constraints jsonb NOT NULL
    CHECK (jsonb_typeof(dietary_constraints) = 'array'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  CONSTRAINT person_profiles_household_id_unique UNIQUE (household_id, id),
  CONSTRAINT person_profiles_membership_foreign
    FOREIGN KEY (household_id, linked_membership_id)
    REFERENCES memberships(household_id, id)
);

CREATE UNIQUE INDEX person_profiles_linked_membership_unique
  ON person_profiles(household_id, linked_membership_id)
  WHERE linked_membership_id IS NOT NULL;

CREATE TABLE inventory_lots (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  food_concept_id uuid,
  display_name varchar(120) NOT NULL,
  state varchar(32) NOT NULL CHECK (state IN ('active', 'depleted', 'discarded')),
  storage_location varchar(32) NOT NULL
    CHECK (storage_location IN ('pantry', 'refrigerated', 'frozen', 'other')),
  current_quantity_kind varchar(32) NOT NULL,
  current_quantity_amount numeric(15, 6),
  current_quantity_unit varchar(32),
  current_quantity_original_text varchar(200),
  current_quantity_confidence varchar(16),
  current_quantity_level varchar(16),
  dates jsonb NOT NULL
    CHECK (jsonb_typeof(dates) = 'array' AND jsonb_array_length(dates) <= 9),
  safety_status varchar(32) NOT NULL
    CHECK (safety_status IN ('eligible', 'blocked', 'unknown')),
  safety_reason_codes jsonb NOT NULL
    CHECK (jsonb_typeof(safety_reason_codes) = 'array'),
  safety_policy_version varchar(100) NOT NULL,
  safety_evaluated_at timestamptz NOT NULL,
  origin varchar(32) NOT NULL
    CHECK (origin IN ('manual', 'shopping_confirmation', 'leftover', 'confirmed_import')),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT inventory_lots_household_id_unique UNIQUE (household_id, id),
  CONSTRAINT inventory_lots_creator_membership_foreign
    FOREIGN KEY (household_id, created_by_user_id)
    REFERENCES memberships(household_id, user_id),
  CONSTRAINT inventory_lots_quantity_shape_check CHECK (
    (
      current_quantity_kind = 'exact'
      AND current_quantity_amount IS NOT NULL
      AND current_quantity_amount >= 0
      AND current_quantity_unit IS NOT NULL
      AND current_quantity_confidence IS NULL
      AND current_quantity_level IS NULL
    )
    OR
    (
      current_quantity_kind = 'approximate'
      AND current_quantity_amount IS NOT NULL
      AND current_quantity_amount >= 0
      AND current_quantity_unit IS NOT NULL
      AND current_quantity_confidence IN ('high', 'medium', 'low')
      AND current_quantity_original_text IS NOT NULL
      AND current_quantity_level IS NULL
    )
    OR
    (
      current_quantity_kind = 'qualitative'
      AND current_quantity_amount IS NULL
      AND current_quantity_unit IS NULL
      AND current_quantity_confidence IS NULL
      AND current_quantity_level IN ('plenty', 'some', 'low', 'empty', 'unknown')
    )
  ),
  CONSTRAINT inventory_lots_state_quantity_check CHECK (
    (
      state = 'active'
      AND (
        (current_quantity_kind IN ('exact', 'approximate') AND current_quantity_amount > 0)
        OR (current_quantity_kind = 'qualitative' AND current_quantity_level <> 'empty')
      )
    )
    OR
    (
      state IN ('depleted', 'discarded')
      AND (
        (current_quantity_kind = 'exact' AND current_quantity_amount = 0)
        OR (current_quantity_kind = 'qualitative' AND current_quantity_level = 'empty')
      )
    )
  )
);

CREATE TABLE inventory_events (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  inventory_lot_id uuid NOT NULL,
  type varchar(32) NOT NULL,
  quantity_change_kind varchar(32),
  quantity_change_amount numeric(15, 6),
  quantity_change_unit varchar(32),
  quantity_change_precision varchar(16),
  quantity_change_confidence varchar(16),
  quantity_change_original_text varchar(200),
  quantity_from_level varchar(16),
  quantity_to_level varchar(16),
  from_storage_location varchar(32),
  to_storage_location varchar(32),
  correction_of_event_id uuid,
  actor_user_id uuid NOT NULL,
  source varchar(48) NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  normalized_route varchar(255) NOT NULL,
  expected_lot_version integer NOT NULL,
  resulting_lot_version integer NOT NULL,
  note text,
  CONSTRAINT inventory_events_household_id_unique UNIQUE (household_id, id),
  CONSTRAINT inventory_events_household_actor_route_idempotency_unique
    UNIQUE (household_id, actor_user_id, normalized_route, idempotency_key),
  CONSTRAINT inventory_events_lot_foreign
    FOREIGN KEY (household_id, inventory_lot_id)
    REFERENCES inventory_lots(household_id, id),
  CONSTRAINT inventory_events_actor_membership_foreign
    FOREIGN KEY (household_id, actor_user_id)
    REFERENCES memberships(household_id, user_id),
  CONSTRAINT inventory_events_correction_foreign
    FOREIGN KEY (household_id, correction_of_event_id)
    REFERENCES inventory_events(household_id, id),
  CONSTRAINT inventory_events_version_check
    CHECK (
      expected_lot_version >= 0
      AND resulting_lot_version = expected_lot_version + 1
    ),
  CONSTRAINT inventory_events_quantity_shape_check CHECK (
    (
      quantity_change_kind IS NULL
      AND quantity_change_amount IS NULL
      AND quantity_from_level IS NULL
      AND quantity_to_level IS NULL
    )
    OR
    (
      quantity_change_kind = 'numeric'
      AND quantity_change_amount IS NOT NULL
      AND quantity_change_amount <> 0
      AND quantity_change_unit IS NOT NULL
      AND quantity_change_precision IN ('exact', 'estimated')
      AND quantity_from_level IS NULL
      AND quantity_to_level IS NULL
      AND (
        (quantity_change_precision = 'exact' AND quantity_change_confidence IS NULL)
        OR
        (
          quantity_change_precision = 'estimated'
          AND quantity_change_confidence IN ('high', 'medium', 'low')
          AND quantity_change_original_text IS NOT NULL
        )
      )
    )
    OR
    (
      quantity_change_kind = 'qualitative'
      AND quantity_change_amount IS NULL
      AND quantity_change_unit IS NULL
      AND quantity_change_precision IS NULL
      AND quantity_from_level IN ('plenty', 'some', 'low', 'empty', 'unknown')
      AND quantity_to_level IN ('plenty', 'some', 'low', 'empty', 'unknown')
      AND quantity_from_level <> quantity_to_level
    )
  )
);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY,
  scope_kind varchar(16) NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  household_id uuid,
  method varchar(16) NOT NULL,
  normalized_route varchar(255) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  status_code integer,
  response_body jsonb,
  original_request_id uuid NOT NULL,
  first_processed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_records_membership_foreign
    FOREIGN KEY (household_id, user_id)
    REFERENCES memberships(household_id, user_id),
  CONSTRAINT idempotency_records_scope_check CHECK (
    (scope_kind = 'user' AND household_id IS NULL)
    OR (scope_kind = 'household' AND household_id IS NOT NULL)
  ),
  CONSTRAINT idempotency_records_completion_check
    CHECK ((status_code IS NULL) = (response_body IS NULL)),
  CONSTRAINT idempotency_records_status_check
    CHECK (status_code IS NULL OR status_code BETWEEN 200 AND 299),
  CONSTRAINT idempotency_records_scope_unique
    UNIQUE NULLS NOT DISTINCT
    (user_id, household_id, method, normalized_route, idempotency_key)
);

CREATE INDEX memberships_user_active_index
  ON memberships(user_id, household_id)
  WHERE status = 'active';
CREATE INDEX inventory_lots_household_created_index
  ON inventory_lots(household_id, created_at, id);
CREATE INDEX inventory_events_lot_recorded_index
  ON inventory_events(household_id, inventory_lot_id, recorded_at, id);

ALTER TABLE users OWNER TO meal_agent_migrator;
ALTER TABLE auth_identities OWNER TO meal_agent_migrator;
ALTER TABLE sessions OWNER TO meal_agent_migrator;
ALTER TABLE households OWNER TO meal_agent_migrator;
ALTER TABLE memberships OWNER TO meal_agent_migrator;
ALTER TABLE person_profiles OWNER TO meal_agent_migrator;
ALTER TABLE inventory_lots OWNER TO meal_agent_migrator;
ALTER TABLE inventory_events OWNER TO meal_agent_migrator;
ALTER TABLE idempotency_records OWNER TO meal_agent_migrator;

CREATE SCHEMA IF NOT EXISTS meal_agent_private AUTHORIZATION meal_agent_migrator;

CREATE FUNCTION meal_agent_private.app_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$function$;

CREATE FUNCTION meal_agent_private.app_household_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT NULLIF(current_setting('app.household_id', true), '')::uuid
$function$;

CREATE FUNCTION meal_agent_private.has_active_membership(target_household_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships
    WHERE household_id = target_household_id
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      AND status = 'active'
  )
$function$;

CREATE FUNCTION meal_agent_private.is_household_creator(target_household_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.households
    WHERE id = target_household_id
      AND created_by_user_id =
        NULLIF(current_setting('app.user_id', true), '')::uuid
      AND id = NULLIF(current_setting('app.household_id', true), '')::uuid
      AND status = 'active'
  )
$function$;

ALTER FUNCTION meal_agent_private.app_user_id() OWNER TO meal_agent_migrator;
ALTER FUNCTION meal_agent_private.app_household_id() OWNER TO meal_agent_migrator;
ALTER FUNCTION meal_agent_private.has_active_membership(uuid)
  OWNER TO meal_agent_migrator;
ALTER FUNCTION meal_agent_private.is_household_creator(uuid)
  OWNER TO meal_agent_migrator;

REVOKE ALL ON SCHEMA meal_agent_private FROM PUBLIC;
GRANT USAGE ON SCHEMA meal_agent_private TO meal_agent_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA meal_agent_private TO meal_agent_app;

ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE households FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE person_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_lots FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_events FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;

CREATE POLICY households_user_list_select ON households
FOR SELECT TO meal_agent_app
USING (
  (meal_agent_private.app_household_id() IS NULL
    OR id = meal_agent_private.app_household_id())
  AND meal_agent_private.has_active_membership(id)
);

CREATE POLICY households_creator_insert ON households
FOR INSERT TO meal_agent_app
WITH CHECK (
  id = meal_agent_private.app_household_id()
  AND created_by_user_id = meal_agent_private.app_user_id()
  AND status = 'active'
);

CREATE POLICY memberships_bootstrap_select ON memberships
FOR SELECT TO meal_agent_app
USING (
  user_id = meal_agent_private.app_user_id()
  AND status = 'active'
  AND (
    meal_agent_private.app_household_id() IS NULL
    OR household_id = meal_agent_private.app_household_id()
  )
);

CREATE POLICY memberships_creator_insert ON memberships
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND user_id = meal_agent_private.app_user_id()
  AND role = 'owner'
  AND status = 'active'
  AND meal_agent_private.is_household_creator(household_id)
);

CREATE POLICY person_profiles_household_select ON person_profiles
FOR SELECT TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);
CREATE POLICY person_profiles_household_insert ON person_profiles
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);

CREATE POLICY inventory_lots_household_select ON inventory_lots
FOR SELECT TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);
CREATE POLICY inventory_lots_household_insert ON inventory_lots
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);
CREATE POLICY inventory_lots_household_update ON inventory_lots
FOR UPDATE TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
)
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);

CREATE POLICY inventory_events_household_select ON inventory_events
FOR SELECT TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);
CREATE POLICY inventory_events_household_insert ON inventory_events
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);

CREATE POLICY idempotency_records_scope_select ON idempotency_records
FOR SELECT TO meal_agent_app
USING (
  user_id = meal_agent_private.app_user_id()
  AND (
    (scope_kind = 'user' AND household_id IS NULL)
    OR
    (
      scope_kind = 'household'
      AND household_id = meal_agent_private.app_household_id()
      AND meal_agent_private.has_active_membership(household_id)
    )
  )
);
CREATE POLICY idempotency_records_scope_insert ON idempotency_records
FOR INSERT TO meal_agent_app
WITH CHECK (
  user_id = meal_agent_private.app_user_id()
  AND (
    (scope_kind = 'user' AND household_id IS NULL)
    OR
    (
      scope_kind = 'household'
      AND household_id = meal_agent_private.app_household_id()
      AND meal_agent_private.has_active_membership(household_id)
    )
  )
);
CREATE POLICY idempotency_records_scope_update ON idempotency_records
FOR UPDATE TO meal_agent_app
USING (
  user_id = meal_agent_private.app_user_id()
  AND (
    (scope_kind = 'user' AND household_id IS NULL)
    OR
    (
      scope_kind = 'household'
      AND household_id = meal_agent_private.app_household_id()
      AND meal_agent_private.has_active_membership(household_id)
    )
  )
)
WITH CHECK (
  user_id = meal_agent_private.app_user_id()
  AND (
    (scope_kind = 'user' AND household_id IS NULL)
    OR
    (
      scope_kind = 'household'
      AND household_id = meal_agent_private.app_household_id()
      AND meal_agent_private.has_active_membership(household_id)
    )
  )
);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON users, auth_identities, sessions
  TO meal_agent_app;
GRANT SELECT, INSERT ON households, memberships, person_profiles
  TO meal_agent_app;
GRANT SELECT, INSERT, UPDATE ON inventory_lots, idempotency_records
  TO meal_agent_app;
GRANT SELECT, INSERT ON inventory_events TO meal_agent_app;
GRANT USAGE ON SCHEMA drizzle TO meal_agent_app;
GRANT SELECT ON drizzle.__meal_agent_migrations TO meal_agent_app;
