import assert from "node:assert/strict";
import test from "node:test";

import { requestIdSchema } from "@meal-agent/contracts";
import {
  createMealRequestSchema,
  generateRecommendationRequestSchema,
} from "@meal-agent/contracts/meals";

import { loadConfig } from "../../src/config.js";
import { ApiRepository } from "../../src/database/repository.js";
import type { Persistence } from "../../src/database/pool.js";
import { AppError } from "../../src/errors.js";
import type { WechatAdapter } from "../../src/wechat/adapter.js";

/**
 * 仓库级集成测试，驱动真实的建议读路径（含其约束读取）与确认路径：
 *
 * - §8.4(a)：一条 `visibility === "subject_and_owner"` 的 allergy 硬约束命中
 *   食谱主料时，推荐落 `no_feasible_option` + `menu.blocked.hard_constraint_allergy`。
 *   这是「读投影会漏检」的判别测试：若实现走了脱敏读路径
 *   （`listPersonProfiles` / `listHouseholdMembers` / `mapRedactedPersonProfile`），
 *   私密约束会被整体 filter 掉，食谱会产出候选，本测试**必然失败**。它**不得**
 *   被替换为「手工喂入未脱敏输入」的 domain 单测。
 * - §4.3：draft revision 不得成为候选；读路径必须限制在 reviewed。
 * - §3.2 / §8.4(c)：confirmMeal 在 `expectedSnapshotDigest` 漂移时必须返回
 *   稳定冲突（409），而不是 500。
 *
 * 只有数据库传输被替换为一个确定性假客户端；仓储、映射与引擎全是真实代码。
 */

const HOUSEHOLD_ID = "018f0000-0000-7000-8000-000000000004";
const USER_ID = "018f0000-0000-7000-8000-000000000001";
const MEMBERSHIP_ID = "018f0000-0000-7000-8000-000000000007";
const PROFILE_ID = "018f0000-0000-7000-8000-000000000006";
const LOT_ID = "018f0000-0000-7000-8000-000000000008";
const RECIPE_ID = "018f0000-0000-7000-8000-000000000010";
const INGREDIENT_ID = "018f0000-0000-7000-8000-000000000011";
const FOOD_CONCEPT_ID = "018f0000-0000-7000-8000-000000000012";
const SESSION_ID = "018f0000-0000-7000-8000-000000000003";
const IDENTITY_ID = "018f0000-0000-7000-8000-000000000002";
const CONSTRAINT_ID = "018f0000-0000-7000-8000-000000000013";
const RECOMMENDATION_ID = "018f0000-0000-7000-8000-000000000014";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const TOKEN = "t".repeat(43);
const FAR_FUTURE = new Date("2099-01-01T00:00:00Z");

const digest = (seed: number): string =>
  `sha256:${seed.toString(16).padStart(64, "0")}`;

interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
}

const normalize = (sql: string): string =>
  sql.replace(/\s+/gu, " ").trim().toLowerCase();

const beginMarker = "018f0000-0000-7000-8000-0000000000ff";

const REVIEWED_RECIPE_ROW = {
  id: RECIPE_ID,
  version: 1,
  title: "合成白酱",
  description: null,
  servings: "2",
  dish_role: "main",
  active_minutes: 10,
  total_minutes: 20,
  difficulty: "beginner",
  status: "reviewed",
};

const DRAFT_RECIPE_ROW = {
  ...REVIEWED_RECIPE_ROW,
  status: "draft",
};

interface FakeClientOptions {
  readonly privateConstraintVisible: boolean;
  /** 假客户端按查询里的 status 谓词**模拟** DB 过滤（见下方 from recipes）。 */
  readonly recipeRows?: readonly Record<string, unknown>[];
  readonly storedRecommendation?: Record<string, unknown> | undefined;
}

/**
 * 记录每条 SQL 的确定性假客户端。它只做「哪条语句返回哪些行」的分派；
 * 任何未预期的语句都抛错，避免测试因未建模的读而假绿。
 *
 * `from recipes` 分支按 SQL 自带的 `status = 'reviewed'` 谓词投影行，使
 * 「draft 不得成为候选」成为**行为**断言：实现若退回 `status <> 'retired'`，
 * draft 行会被返回，测试转红（真 DB 由 Postgres 施加同一谓词）。
 */
const createFakeClient = (
  sessionKnowledge: FakeClientOptions,
) => {
  const statements: string[] = [];
  const recipeRows = sessionKnowledge.recipeRows ?? [REVIEWED_RECIPE_ROW];
  const profileConstraints = sessionKnowledge.privateConstraintVisible
    ? [
        {
          id: CONSTRAINT_ID,
          kind: "allergy",
          enforcement: "hard",
          label: "乳制品过敏（私密）",
          foodConceptIds: [],
          allergenCodes: ["allergen.milk"],
          mappingStatus: "needs_structured_mapping",
          visibility: "subject_and_owner",
          confirmedAt: "2026-07-23T12:00:00Z",
          confirmedByUserId: USER_ID,
        },
      ]
    : [];

  const query = async (sql: string): Promise<QueryResult> => {
    const text = normalize(sql);
    statements.push(text);
    if (
      text === "begin" ||
      text === "commit" ||
      text === "rollback" ||
      text.startsWith("select set_config(")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("from sessions s")) {
      return {
        rows: [
          {
            session_id: SESSION_ID,
            session_user_id: USER_ID,
            session_auth_identity_id: IDENTITY_ID,
            session_status: "active",
            session_issued_at: new Date("2026-07-01T00:00:00Z"),
            session_expires_at: FAR_FUTURE,
            session_idle_expires_at: FAR_FUTURE,
            session_last_seen_at: new Date("2026-07-01T00:00:00Z"),
            session_revoked_at: null,
            session_token_version: 1,
            user_id_value: USER_ID,
            user_status: "active",
            user_display_name: "家庭所有者",
            user_locale: "zh-CN",
            user_created_at: new Date("2026-07-01T00:00:00Z"),
            user_updated_at: new Date("2026-07-01T00:00:00Z"),
            user_version: 0,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("update sessions")) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("from memberships")) {
      return {
        rows: [
          {
            id: MEMBERSHIP_ID,
            household_id: HOUSEHOLD_ID,
            user_id: USER_ID,
            role: "owner",
            capabilities: ["meal:write", "inventory:write"],
            status: "active",
            joined_at: new Date("2026-07-01T00:00:00Z"),
            updated_at: new Date("2026-07-01T00:00:00Z"),
            version: 0,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("from person_profiles")) {
      return {
        rows: [
          {
            id: PROFILE_ID,
            version: 3,
            status: "active",
            dietary_constraints: profileConstraints,
            cooking_skill: "intermediate",
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("from inventory_lots")) {
      return {
        rows: [
          {
            id: LOT_ID,
            household_id: HOUSEHOLD_ID,
            food_concept_id: FOOD_CONCEPT_ID,
            display_name: "合成牛奶",
            state: "active",
            storage_location: "refrigerated",
            current_quantity_kind: "exact",
            current_quantity_amount: "4.000000",
            current_quantity_unit: "L",
            current_quantity_original_text: null,
            current_quantity_confidence: null,
            current_quantity_level: null,
            dates: [],
            safety_status: "eligible",
            safety_reason_codes: [],
            safety_policy_version: "stage-06-manual-v1",
            safety_evaluated_at: new Date("2026-07-01T00:00:00Z"),
            origin: "manual",
            created_by_user_id: USER_ID,
            created_at: new Date("2026-07-01T00:00:00Z"),
            updated_at: new Date("2026-07-01T00:00:00Z"),
            version: 1,
            food_concept_revision: 1,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("from recipe_ingredients")) {
      return {
        rows: [
          {
            recipe_id: RECIPE_ID,
            recipe_version: 1,
            food_concept_id: FOOD_CONCEPT_ID,
            display_name: "合成牛奶",
            optional: false,
            allergen_codes: ["allergen.milk"],
            may_contain_allergen_codes: [],
            position: 1,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("from recipes")) {
      const reviewedOnly = text.includes("status = 'reviewed'");
      const rows = recipeRows.filter((row) =>
        reviewedOnly ? row["status"] === "reviewed" : row["status"] !== "retired",
      );
      return { rows, rowCount: rows.length };
    }
    if (text.includes("from recommendations")) {
      const stored = sessionKnowledge.storedRecommendation;
      return stored === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [stored], rowCount: 1 };
    }
    if (text.includes("insert into idempotency_records")) {
      return { rows: [{ id: beginMarker }], rowCount: 1 };
    }
    if (
      text.includes("update idempotency_records") ||
      text.includes("insert into recommendations")
    ) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("insert into recommendation_candidates")) {
      return { rows: [], rowCount: 1 };
    }
    if (
      text.includes("insert into meals") ||
      text.includes("insert into meal_recipes")
    ) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in read-path test: ${text}`);
  };

  return {
    client: { query, release: (): void => undefined },
    statements,
  };
};

const buildRepository = (
  options: FakeClientOptions,
): { readonly repository: ApiRepository; readonly statements: string[] } => {
  const { client, statements } = createFakeClient(options);
  const persistence = {
    pool: { connect: async () => client },
    drizzle: {},
    appRole: "meal_agent_app",
  } as unknown as Persistence;
  const config = loadConfig({
    NODE_ENV: "test",
    DEPLOYMENT_STAGE: "local-test",
    DEPLOYMENT_EXPOSURE: "loopback",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgresql://api_tests:synthetic-not-a-real-password@127.0.0.1:5432/not-used",
    WECHAT_ADAPTER: "fake",
  });
  const wechatAdapter = {} as WechatAdapter;
  return {
    repository: new ApiRepository(persistence, config, wechatAdapter),
    statements,
  };
};

const request = generateRecommendationRequestSchema.parse({
  participantProfileIds: [PROFILE_ID],
  cookProfileId: PROFILE_ID,
  maximumTotalMinutes: 60,
  purchaseTolerance: "none",
  suggestedDishCount: 1,
});

test("a subject_and_owner allergy hard constraint blocks its recipe through the real read path", async () => {
  const { repository, statements } = buildRepository({
    privateConstraintVisible: true,
  });
  const response = await repository.generateRecommendation(
    TOKEN,
    requestIdSchema.parse(REQUEST_ID),
    HOUSEHOLD_ID,
    "recommendation-readpath-0001",
    request,
  );
  const recommendation = response.body.data;

  assert.equal(
    recommendation.outcome,
    "no_feasible_option",
    "a household whose private allergy hits a recipe must be blocked, not served a menu",
  );
  assert.deepEqual(recommendation.candidates, []);
  assert.ok(
    recommendation.blockerCodes.includes("menu.blocked.hard_constraint_allergy"),
    `expected the allergy blocker, got ${JSON.stringify(recommendation.blockerCodes)}`,
  );
  // 配方确已产出证据：读路径读到了 profile 与食谱（而非早退）。
  assert.ok(
    statements.some((sql) => sql.includes("from person_profiles")),
    "the constraint read path must query person_profiles",
  );
  assert.ok(
    statements.some((sql) => sql.includes("from recipes")),
    "the engine must be fed recipes",
  );
});

test("a draft recipe revision is excluded so an unreviewed revision can never become a candidate", async () => {
  // §4.3：只有 reviewed 的 revision 可成为候选。draft-only 读集下引擎必须
  // 落在 no_active_recipe（无候选），而不是把 draft 当候选。
  const draftOnly = buildRepository({
    privateConstraintVisible: false,
    recipeRows: [DRAFT_RECIPE_ROW],
  });
  const draftResponse = await draftOnly.repository.generateRecommendation(
    TOKEN,
    requestIdSchema.parse(REQUEST_ID),
    HOUSEHOLD_ID,
    "recommendation-draft-0001",
    request,
  );
  assert.equal(
    draftResponse.body.data.outcome,
    "no_feasible_option",
    "a draft-only recipe set must not yield a menu",
  );
  assert.deepEqual(draftResponse.body.data.candidates, []);
  assert.ok(
    draftResponse.body.data.blockerCodes.includes("menu.blocked.no_active_recipe"),
    `expected no_active_recipe, got ${JSON.stringify(draftResponse.body.data.blockerCodes)}`,
  );
  assert.ok(
    draftOnly.statements.some((sql) => sql.includes("status = 'reviewed'")),
    "the recipes read must restrict to reviewed revisions",
  );

  // 对照组：同一读路径下 reviewed 修订可成为候选，证明上面的空结果来自
  // 谓词而非「读不到任何食谱」。
  const reviewedOnly = buildRepository({
    privateConstraintVisible: false,
    recipeRows: [REVIEWED_RECIPE_ROW],
  });
  const reviewedResponse = await reviewedOnly.repository.generateRecommendation(
    TOKEN,
    requestIdSchema.parse(REQUEST_ID),
    HOUSEHOLD_ID,
    "recommendation-reviewed-0001",
    request,
  );
  assert.equal(reviewedResponse.body.data.outcome, "options");
  assert.equal(reviewedResponse.body.data.candidates.length, 1);
});

const mealRequest = createMealRequestSchema.parse({
  recommendationId: RECOMMENDATION_ID,
  participantProfileIds: [PROFILE_ID],
  cookProfileId: PROFILE_ID,
  recipes: [{ recipeId: RECIPE_ID, recipeVersion: 1, servings: 2 }],
  scheduledFor: "2026-07-23T12:00:00Z",
  expectedSnapshotDigest: digest(8),
});

test("confirmMeal returns a stable 409 conflict when the expected snapshot digest drifts, never a 500", async () => {
  const { repository } = buildRepository({
    privateConstraintVisible: true,
    // 已持久化 Recommendation 的 snapshotDigest 与请求携带的不一致。
    storedRecommendation: {
      id: RECOMMENDATION_ID,
      snapshot: { snapshotDigest: digest(9) },
    },
  });

  for (const key of ["meal-confirm-0001", "meal-confirm-0002"]) {
    await assert.rejects(
      () =>
        repository.confirmMeal(
          TOKEN,
          requestIdSchema.parse(REQUEST_ID),
          HOUSEHOLD_ID,
          key,
          mealRequest,
        ),
      (error: unknown) => {
        assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
        assert.equal(error.code, "CONFLICT");
        assert.equal(error.status, 409);
        return true;
      },
    );
  }
});
