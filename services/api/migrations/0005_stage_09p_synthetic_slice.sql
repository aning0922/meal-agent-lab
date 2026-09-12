-- 阶段 09P M-4a 有界合成纵切的 schema。
--
-- 0000—0004 已纳入 checksum，字节永久冻结，不得修改。本迁移只做 additive
-- 数据结构：
--   1. 三张**全局只读**参考表（与 users/auth_identities/sessions 同姿态：不开
--      RLS，靠 app 表级授权与代码过滤保护）：food_concepts、recipes、
--      recipe_ingredients；
--   2. 四张 **household 私有**表（ENABLE + FORCE RLS + household 策略）：
--      recommendations、recommendation_candidates、meals、meal_recipes；
--   3. 一条 additive 外键把既有的 inventory_lots.food_concept_id 绑到
--      food_concepts，使「按 displayName 匹配库存」在 schema 层不可达。
--
-- 本迁移是**纯合成**的：只建表，不写入任何真实食品事实、不激活任何词表、
-- 不做任何 source activation。合成行由使用方在测试/演练中显式种入。
--
-- 约束纪律：文件在**单一事务**内执行，因此不含 BEGIN/COMMIT/ROLLBACK，也不
-- 使用 CREATE INDEX CONCURRENTLY；以 SET ROLE meal_agent_migrator 执行，新建
-- 对象的 owner 因此自动是 meal_agent_migrator。

-- ---------------------------------------------------------------------------
-- 1. 全局只读参考表（无 RLS）。
-- ---------------------------------------------------------------------------

CREATE TABLE public.food_concepts (
  id uuid PRIMARY KEY,
  display_name varchar(120) NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  allergen_codes jsonb NOT NULL
    CHECK (jsonb_typeof(allergen_codes) = 'array'),
  may_contain_allergen_codes jsonb NOT NULL
    CHECK (jsonb_typeof(may_contain_allergen_codes) = 'array'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- id 必须是**小写** UUIDv7（契约 foodConceptIdSchema 的同一形状）。
  CONSTRAINT food_concepts_id_check CHECK (
    id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);

CREATE TABLE public.recipes (
  id uuid PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  status varchar(32) NOT NULL
    CHECK (status IN ('draft', 'reviewed', 'retired')),
  title varchar(160) NOT NULL,
  description varchar(1000),
  servings numeric NOT NULL CHECK (servings > 0),
  dish_role varchar(32) NOT NULL
    CHECK (dish_role IN ('staple', 'main', 'vegetable', 'soup', 'side')),
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  required_equipment jsonb NOT NULL
    CHECK (jsonb_typeof(required_equipment) = 'array'),
  active_minutes integer NOT NULL CHECK (active_minutes >= 0),
  total_minutes integer NOT NULL CHECK (total_minutes > 0),
  difficulty varchar(32) NOT NULL
    CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- 供 meal_recipes / recipe_ingredients 的复合外键引用。
  CONSTRAINT recipes_id_version_unique UNIQUE (id, version)
);

CREATE TABLE public.recipe_ingredients (
  id uuid PRIMARY KEY,
  recipe_id uuid NOT NULL,
  recipe_version integer NOT NULL,
  -- 强制更正 (b) 的结构落点：food_concept_id NOT NULL 且有 FK，使按
  -- display_name 匹配库存在 schema 层不可达；display_name 仅作展示文本。
  food_concept_id uuid NOT NULL REFERENCES public.food_concepts(id),
  display_name varchar(120) NOT NULL,
  quantity jsonb NOT NULL CHECK (jsonb_typeof(quantity) = 'object'),
  optional boolean NOT NULL,
  allergen_codes jsonb NOT NULL
    CHECK (jsonb_typeof(allergen_codes) = 'array'),
  may_contain_allergen_codes jsonb NOT NULL
    CHECK (jsonb_typeof(may_contain_allergen_codes) = 'array'),
  position integer NOT NULL CHECK (position >= 1),
  CONSTRAINT recipe_ingredients_recipe_foreign
    FOREIGN KEY (recipe_id, recipe_version)
    REFERENCES public.recipes(id, version),
  CONSTRAINT recipe_ingredients_id_unique UNIQUE (recipe_id, recipe_version, id)
);

-- ---------------------------------------------------------------------------
-- 2. household 私有表（ENABLE + FORCE RLS）。
-- ---------------------------------------------------------------------------

CREATE TABLE public.recommendations (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id),
  outcome varchar(32) NOT NULL
    CHECK (outcome IN ('options', 'no_feasible_option')),
  participant_profile_ids jsonb NOT NULL
    CHECK (jsonb_typeof(participant_profile_ids) = 'array'),
  cook_profile_id uuid NOT NULL,
  maximum_total_minutes integer NOT NULL CHECK (maximum_total_minutes > 0),
  purchase_tolerance varchar(16) NOT NULL
    CHECK (purchase_tolerance IN ('none', 'limited', 'allowed')),
  suggested_dish_count integer NOT NULL
    CHECK (suggested_dish_count BETWEEN 1 AND 3),
  blocker_codes jsonb NOT NULL CHECK (jsonb_typeof(blocker_codes) = 'array'),
  assumptions jsonb NOT NULL CHECK (jsonb_typeof(assumptions) = 'array'),
  -- 顺序化预选 id 数组单独保存，回读时原样还原 Recommendation 的必填字段，
  -- 不由 recommendation_candidates.position 推导。
  preselected_candidate_ids jsonb NOT NULL
    CHECK (jsonb_typeof(preselected_candidate_ids) = 'array'
      AND jsonb_array_length(preselected_candidate_ids) <= 3),
  -- 四段快照（inventory/constraints/recipes/policies + snapshotDigest）。
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  recommendation_policy_version varchar(100) NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  -- 供 recommendation_candidates 的复合外键引用。
  CONSTRAINT recommendations_household_id_unique UNIQUE (household_id, id)
);

CREATE TABLE public.recommendation_candidates (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  recipe_version integer NOT NULL,
  servings numeric NOT NULL CHECK (servings > 0),
  dish_role varchar(32) NOT NULL
    CHECK (dish_role IN ('staple', 'main', 'vegetable', 'soup', 'side')),
  active_minutes integer NOT NULL CHECK (active_minutes >= 0),
  total_minutes integer NOT NULL CHECK (total_minutes > 0),
  missing_food_concept_ids jsonb NOT NULL
    CHECK (jsonb_typeof(missing_food_concept_ids) = 'array'),
  planned_inventory_lot_ids jsonb NOT NULL
    CHECK (jsonb_typeof(planned_inventory_lot_ids) = 'array'),
  reason_codes jsonb NOT NULL
    CHECK (jsonb_typeof(reason_codes) = 'array'
      AND jsonb_array_length(reason_codes) >= 1),
  assumptions jsonb NOT NULL CHECK (jsonb_typeof(assumptions) = 'array'),
  -- status 是字面量 "passed"：引擎只在硬检查确证通过时才构造候选。
  hard_constraint_check jsonb NOT NULL
    CHECK (jsonb_typeof(hard_constraint_check) = 'object'
      AND (hard_constraint_check->>'status') = 'passed'),
  position integer NOT NULL,
  CONSTRAINT recommendation_candidates_recommendation_foreign
    FOREIGN KEY (household_id, recommendation_id)
    REFERENCES public.recommendations(household_id, id),
  CONSTRAINT recommendation_candidates_household_id_unique
    UNIQUE (household_id, id)
);

CREATE TABLE public.meals (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id),
  recommendation_id uuid,
  participant_profile_ids jsonb NOT NULL
    CHECK (jsonb_typeof(participant_profile_ids) = 'array'),
  cook_profile_id uuid NOT NULL,
  status varchar(32) NOT NULL
    CHECK (status IN (
      'draft', 'confirmed', 'shopping_required', 'ready',
      'cooking', 'completed', 'cancelled'
    )),
  scheduled_for timestamptz NOT NULL,
  -- 确认时的四段快照。
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  CONSTRAINT meals_household_id_unique UNIQUE (household_id, id)
);

CREATE TABLE public.meal_recipes (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  meal_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  recipe_version integer NOT NULL,
  servings numeric NOT NULL CHECK (servings > 0),
  position integer NOT NULL,
  CONSTRAINT meal_recipes_meal_foreign
    FOREIGN KEY (household_id, meal_id)
    REFERENCES public.meals(household_id, id),
  CONSTRAINT meal_recipes_household_id_unique UNIQUE (household_id, id)
);

-- ---------------------------------------------------------------------------
-- 3. 既有 inventory_lots 上的 additive 绑定（不改写 0000—0004 字节）。
-- ---------------------------------------------------------------------------

ALTER TABLE public.inventory_lots
  ADD CONSTRAINT inventory_lots_food_concept_foreign
  FOREIGN KEY (food_concept_id) REFERENCES public.food_concepts(id);

-- ---------------------------------------------------------------------------
-- 4. RLS：四张 household 私有表启用并 FORCE；三张全局只读表刻意不启用。
-- ---------------------------------------------------------------------------

ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recommendation_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendation_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meals FORCE ROW LEVEL SECURITY;
ALTER TABLE public.meal_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meal_recipes FORCE ROW LEVEL SECURITY;

CREATE POLICY recommendations_household_select ON public.recommendations
FOR SELECT TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);
CREATE POLICY recommendations_household_insert ON public.recommendations
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);

CREATE POLICY recommendation_candidates_household_select
ON public.recommendation_candidates
FOR SELECT TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);
CREATE POLICY recommendation_candidates_household_insert
ON public.recommendation_candidates
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);

CREATE POLICY meals_household_select ON public.meals
FOR SELECT TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);
CREATE POLICY meals_household_insert ON public.meals
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);
CREATE POLICY meals_household_update ON public.meals
FOR UPDATE TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
)
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);

CREATE POLICY meal_recipes_household_select ON public.meal_recipes
FOR SELECT TO meal_agent_app
USING (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);
CREATE POLICY meal_recipes_household_insert ON public.meal_recipes
FOR INSERT TO meal_agent_app
WITH CHECK (
  household_id = meal_agent_private.app_household_id()
  AND meal_agent_private.has_active_membership(household_id)
);

-- ---------------------------------------------------------------------------
-- 5. app 表级授权：全局只读表仅 SELECT；household 私有表 SELECT + INSERT
--    （meals 另加 UPDATE，供状态迁移）。
-- ---------------------------------------------------------------------------

GRANT SELECT ON public.food_concepts, public.recipes, public.recipe_ingredients
  TO meal_agent_app;
GRANT SELECT, INSERT ON public.recommendations
  TO meal_agent_app;
GRANT SELECT, INSERT ON public.recommendation_candidates
  TO meal_agent_app;
GRANT SELECT, INSERT, UPDATE ON public.meals TO meal_agent_app;
GRANT SELECT, INSERT ON public.meal_recipes TO meal_agent_app;
