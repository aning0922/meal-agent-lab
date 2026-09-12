import assert from "node:assert/strict";
import test from "node:test";

import {
  RECOMMENDATION_ENGINE_VERSION,
  asUnredactedProfileConstraints,
  canonicalJson,
  generateMenuCandidates,
  type MenuConstraintFact,
  type MenuGenerationInput,
  type MenuInventoryLot,
  type MenuPolicyReleaseIds,
  type MenuProfileConstraintFacts,
  type MenuQuantity,
  type MenuRecipe,
  type MenuRecipeIngredient,
} from "../src/index.js";

/**
 * 冻结 §8.3 Domain 层：引擎确定性、排序稳定、缺项只经 `foodConceptId`、
 * 空 `foodConceptId` fail closed、无结构化代码的硬约束 fail closed。
 */

const RELEASES = {
  foodConceptReleaseId: "release-fc",
  allergenReleaseId: "release-allergen",
  religiousEthicalReleaseId: "release-re",
  foodSafetyReleaseId: "release-fs",
  techniqueReleaseId: "release-tech",
  recipeDatasetReleaseId: "release-recipes",
  constraintMappingReleaseId: "release-mapping",
} as const;

const EVALUATED_AT = "2026-07-23T12:00:00.000Z";

const lot = (overrides: Partial<MenuInventoryLot> = {}): MenuInventoryLot => ({
  lotId: "lot-1",
  foodConceptId: "fc-milk",
  quantity: { kind: "exact", amount: 4, level: null },
  safetyStatus: "eligible",
  version: 1,
  foodConceptRevision: 1,
  safetyAssessmentRevision: 1,
  safetyPolicyVersion: "synthetic-v1",
  ...overrides,
});

const recipe = (overrides: Partial<MenuRecipe> = {}): MenuRecipe => ({
  recipeId: "recipe-1",
  recipeVersion: 1,
  totalMinutes: 20,
  activeMinutes: 10,
  difficulty: "beginner",
  servings: 2,
  dishRole: "main",
  contentDigest: "sha256:" + "a".repeat(64),
  ingredients: [
    {
      foodConceptId: "fc-milk",
      displayName: "牛奶",
      optional: false,
      allergenCodes: ["allergen.milk"],
      mayContainAllergenCodes: [],
    },
  ],
  ...overrides,
});

const profile = (
  overrides: Partial<MenuProfileConstraintFacts> = {},
): MenuProfileConstraintFacts => ({
  profileId: "profile-1",
  profileVersion: 1,
  status: "active",
  constraints: [],
  ...overrides,
});

const baseInput = (
  overrides: Partial<MenuGenerationInput> = {},
): MenuGenerationInput => ({
  participantProfileIds: ["profile-1"],
  cookProfileId: "profile-1",
  cookSkill: "intermediate",
  maximumTotalMinutes: 60,
  purchaseTolerance: "none",
  suggestedDishCount: 1,
  inventoryLots: [lot()],
  recipes: [recipe()],
  profileConstraints: asUnredactedProfileConstraints([profile()]),
  candidateIds: ["candidate-1"],
  recommendationEngineVersion: RECOMMENDATION_ENGINE_VERSION,
  policyReleases: RELEASES,
  evaluatedAt: EVALUATED_AT,
  ...overrides,
});

test("the engine is deterministic: identical input yields byte-identical output", () => {
  const input = baseInput();
  assert.equal(
    canonicalJson(generateMenuCandidates(input)),
    canonicalJson(generateMenuCandidates(baseInput())),
  );
});

test("missing items are computed only through foodConceptId, never display names", () => {
  const covered = generateMenuCandidates(baseInput());
  assert.equal(covered.outcome, "options");
  assert.deepEqual(covered.candidates[0]?.missingFoodConceptIds, []);

  // Same display name, different foodConceptId -> still missing (fail closed).
  const nameOnly = generateMenuCandidates(
    baseInput({
      purchaseTolerance: "allowed",
      inventoryLots: [
        lot({ lotId: "lot-x", foodConceptId: "fc-something-else" }),
      ],
    }),
  );
  assert.equal(nameOnly.outcome, "options");
  assert.deepEqual(nameOnly.candidates[0]?.missingFoodConceptIds, ["fc-milk"]);
});

test("an unresolved ingredient foodConceptId fails closed without name matching", () => {
  const result = generateMenuCandidates(
    baseInput({
      recipes: [
        recipe({
          ingredients: [
            {
              foodConceptId: null,
              displayName: "牛奶",
              optional: false,
              allergenCodes: ["allergen.milk"],
              mayContainAllergenCodes: [],
            },
          ],
        }),
      ],
    }),
  );
  assert.equal(result.outcome, "no_feasible_option");
  assert.deepEqual(result.candidates, []);
  assert.ok(result.blockerCodes.includes("menu.blocked.food_concept_unresolved"));
});

test("an unmapped hard constraint fails closed instead of passing silently", () => {
  const result = generateMenuCandidates(
    baseInput({
      profileConstraints: asUnredactedProfileConstraints([
        profile({
          constraints: [
            {
              kind: "allergy",
              enforcement: "hard",
              mappingStatus: "needs_structured_mapping",
              allergenCodes: [],
              foodConceptIds: [],
            },
          ],
        }),
      ]),
    }),
  );
  assert.equal(result.outcome, "no_feasible_option");
  assert.ok(result.blockerCodes.includes("menu.blocked.hard_constraint_unmapped"));
});

test("table-scope allergy from a non-participant still blocks the recipe", () => {
  const result = generateMenuCandidates(
    baseInput({
      participantProfileIds: ["profile-1"],
      profileConstraints: asUnredactedProfileConstraints([
        profile(),
        profile({
          profileId: "profile-2",
          constraints: [
            {
              kind: "allergy",
              enforcement: "hard",
              mappingStatus: "needs_structured_mapping",
              allergenCodes: ["allergen.milk"],
              foodConceptIds: [],
            },
          ],
        }),
      ]),
    }),
  );
  assert.equal(result.outcome, "no_feasible_option");
  assert.ok(result.blockerCodes.includes("menu.blocked.hard_constraint_allergy"));
});

test("purchase tolerance governs missing items deterministically", () => {
  const missingLots = { inventoryLots: [] as MenuInventoryLot[] };
  const none = generateMenuCandidates(
    baseInput({ ...missingLots, purchaseTolerance: "none" }),
  );
  assert.equal(none.outcome, "no_feasible_option");
  assert.ok(
    none.blockerCodes.includes("menu.blocked.purchase_tolerance_exceeded"),
  );

  const limitedRequired = generateMenuCandidates(
    baseInput({ ...missingLots, purchaseTolerance: "limited" }),
  );
  assert.equal(limitedRequired.outcome, "no_feasible_option");
  assert.ok(
    limitedRequired.blockerCodes.includes(
      "menu.blocked.purchase_tolerance_exceeded",
    ),
  );

  const limitedOptional = generateMenuCandidates(
    baseInput({
      ...missingLots,
      purchaseTolerance: "limited",
      recipes: [
        recipe({
          ingredients: [
            {
              foodConceptId: "fc-milk",
              displayName: "牛奶",
              optional: true,
              allergenCodes: [],
              mayContainAllergenCodes: [],
            },
          ],
        }),
      ],
    }),
  );
  assert.equal(limitedOptional.outcome, "options");
  assert.ok(
    limitedOptional.candidates[0]?.reasonCodes.includes(
      "menu.candidate.missing_items_within_tolerance",
    ),
  );
});

test("time budget and cook skill are hard filters with honest blockers", () => {
  const overTime = generateMenuCandidates(
    baseInput({ maximumTotalMinutes: 5 }),
  );
  assert.ok(
    overTime.blockerCodes.includes("menu.blocked.no_recipe_within_time_budget"),
  );

  const skillShort = generateMenuCandidates(
    baseInput({
      cookSkill: "none",
      recipes: [recipe({ difficulty: "advanced" })],
    }),
  );
  assert.ok(
    skillShort.blockerCodes.includes("menu.blocked.cook_skill_insufficient"),
  );

  const noRecipe = generateMenuCandidates(baseInput({ recipes: [] }));
  assert.ok(noRecipe.blockerCodes.includes("menu.blocked.no_active_recipe"));
});

test("a non-array constraints set fails closed with a blocker, never an exception", () => {
  // §5.2：任一 active 档案的 constraints 缺失（非数组）即记 input_invalid。
  // 这条路径不得抛异常——blocker 的构造要先经过快照构造。
  const malformedProfile = {
    profileId: "profile-1",
    profileVersion: 1,
    status: "active",
    constraints: { not: "an array" },
  } as unknown as MenuProfileConstraintFacts;

  const result = generateMenuCandidates(
    baseInput({
      profileConstraints: asUnredactedProfileConstraints([malformedProfile]),
    }),
  );
  assert.equal(result.outcome, "no_feasible_option");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.blockerCodes, ["menu.blocked.input_invalid"]);
  assert.doesNotThrow(() => canonicalJson(result.snapshot));
});

test("a malformed nested lot.quantity fails closed with a blocker, never an exception", () => {
  // §5.4 数量覆盖判定会解引用嵌套的 lot.quantity（quantity.kind / .level / .amount）。
  // 该嵌套对象缺失或非对象时，必须在本判定中转 input_invalid，而不是在 evaluateRecipe
  // 里对 null / undefined 取属性抛 TypeError。
  const malformedQuantities: ReadonlyArray<readonly [string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["missing key", undefined],
  ];
  for (const [name, quantity] of malformedQuantities) {
    const result = generateMenuCandidates(
      baseInput({
        inventoryLots: [
          lot({ quantity: quantity as unknown as MenuQuantity }),
        ],
      }),
    );
    assert.equal(result.outcome, "no_feasible_option", name);
    assert.deepEqual(result.candidates, [], name);
    assert.deepEqual(result.blockerCodes, ["menu.blocked.input_invalid"], name);
    assert.doesNotThrow(() => canonicalJson(result.snapshot), name);
    assert.match(result.snapshot.snapshotDigest, /^sha256:[0-9a-f]{64}$/u, name);
  }
});

test("every sibling early exit returns its own blocker on well-formed input", () => {
  // 四条 sibling early exit（与 input_invalid 同族、先经 buildSnapshot 才返回）各自
  // 在**结构合法**输入上返回自己的结构化 blocker。
  const noRecipe = generateMenuCandidates(baseInput({ recipes: [] }));
  assert.equal(noRecipe.outcome, "no_feasible_option");
  assert.deepEqual(noRecipe.blockerCodes, ["menu.blocked.no_active_recipe"]);

  const overTime = generateMenuCandidates(baseInput({ maximumTotalMinutes: 5 }));
  assert.deepEqual(overTime.blockerCodes, [
    "menu.blocked.no_recipe_within_time_budget",
  ]);

  const skillShort = generateMenuCandidates(
    baseInput({ cookSkill: "none", recipes: [recipe({ difficulty: "advanced" })] }),
  );
  assert.deepEqual(skillShort.blockerCodes, [
    "menu.blocked.cook_skill_insufficient",
  ]);

  const tooFew = generateMenuCandidates(
    baseInput({ suggestedDishCount: 2, candidateIds: ["candidate-1", "candidate-2"] }),
  );
  assert.equal(tooFew.outcome, "no_feasible_option");
  assert.deepEqual(tooFew.blockerCodes, [
    "menu.blocked.insufficient_suggested_dishes",
  ]);
});

test("structurally malformed input returns a structured blocker, never a TypeError", () => {
  // R1：结构非法输入（非数组集合、null/非对象容器与元素）不得在构造 blocker 之前抛
  // TypeError。每个用例同时是四条 sibling early exit 中某一条的触发形态——若结构校验
  // 或 buildSnapshot 的任一处防御被移除，对应用例将抛异常而非返回 blocker。
  const cases: ReadonlyArray<readonly [string, Partial<MenuGenerationInput>]> = [
    [
      "no_active_recipe sibling: non-array recipes",
      { recipes: undefined as unknown as readonly MenuRecipe[] },
    ],
    [
      "no_recipe_within_time_budget sibling: non-array inventoryLots",
      {
        inventoryLots: undefined as unknown as readonly MenuInventoryLot[],
        maximumTotalMinutes: 5,
      },
    ],
    [
      "cook_skill_insufficient sibling: non-array inventoryLots",
      {
        inventoryLots: undefined as unknown as readonly MenuInventoryLot[],
        cookSkill: "none",
        recipes: [recipe({ difficulty: "advanced" })],
      },
    ],
    [
      "insufficient_suggested_dishes sibling: non-array inventoryLots",
      {
        inventoryLots: undefined as unknown as readonly MenuInventoryLot[],
        suggestedDishCount: 2,
        candidateIds: ["candidate-1", "candidate-2"],
      },
    ],
    [
      "non-array policyReleases",
      { policyReleases: undefined as unknown as MenuPolicyReleaseIds },
    ],
    [
      "non-array candidateIds",
      { candidateIds: undefined as unknown as readonly string[] },
    ],
    [
      "null profile entry",
      {
        profileConstraints: asUnredactedProfileConstraints([
          null as unknown as MenuProfileConstraintFacts,
        ]),
      },
    ],
    [
      "null constraint entry",
      {
        profileConstraints: asUnredactedProfileConstraints([
          profile({
            constraints: [null as unknown as MenuConstraintFact],
          }),
        ]),
      },
    ],
    [
      "non-array constraint allergenCodes",
      {
        profileConstraints: asUnredactedProfileConstraints([
          profile({
            constraints: [
              {
                kind: "allergy",
                enforcement: "hard",
                mappingStatus: "needs_structured_mapping",
                allergenCodes: undefined as unknown as readonly string[],
                foodConceptIds: [],
              },
            ],
          }),
        ]),
      },
    ],
    [
      "null recipe element",
      { recipes: [null as unknown as MenuRecipe] },
    ],
    [
      "ingredient missing allergenCodes array",
      {
        recipes: [
          recipe({
            ingredients: [
              {
                foodConceptId: "fc-milk",
                displayName: "牛奶",
                optional: false,
                mayContainAllergenCodes: [],
              } as unknown as MenuRecipeIngredient,
            ],
          }),
        ],
      },
    ],
    [
      "lot missing quantity object",
      {
        inventoryLots: [lot({ quantity: undefined as unknown as MenuQuantity })],
      },
    ],
    [
      "lot quantity null",
      {
        inventoryLots: [lot({ quantity: null as unknown as MenuQuantity })],
      },
    ],
  ];

  for (const [name, overrides] of cases) {
    let result;
    assert.doesNotThrow(() => {
      result = generateMenuCandidates(baseInput(overrides));
    }, name);
    assert.equal(result!.outcome, "no_feasible_option", name);
    assert.deepEqual(result!.candidates, [], name);
    assert.ok(
      result!.blockerCodes.includes("menu.blocked.input_invalid"),
      name,
    );
    assert.doesNotThrow(() => canonicalJson(result!.snapshot), name);
    assert.match(result!.snapshot.snapshotDigest, /^sha256:[0-9a-f]{64}$/u, name);
  }
});

test("the snapshot digest covers all four segments; changing any one changes it", () => {
  const base = generateMenuCandidates(baseInput());
  const baseDigest = base.snapshot.snapshotDigest;
  assert.match(baseDigest, /^sha256:[0-9a-f]{64}$/);

  const inventoryChanged = generateMenuCandidates(
    baseInput({ inventoryLots: [lot({ version: 2 })] }),
  );
  assert.notEqual(
    inventoryChanged.snapshot.snapshotDigest,
    baseDigest,
    "changing an inventory lot revision must change the snapshot digest",
  );

  const constraintsChanged = generateMenuCandidates(
    baseInput({
      profileConstraints: asUnredactedProfileConstraints([
        profile({
          constraints: [
            {
              kind: "preference",
              enforcement: "soft",
              mappingStatus: "needs_structured_mapping",
              allergenCodes: [],
              foodConceptIds: [],
            },
          ],
        }),
      ]),
    }),
  );
  assert.notEqual(
    constraintsChanged.snapshot.snapshotDigest,
    baseDigest,
    "changing a profile constraint set must change the snapshot digest",
  );

  const recipesChanged = generateMenuCandidates(
    baseInput({ recipes: [recipe({ contentDigest: "sha256:" + "b".repeat(64) })] }),
  );
  assert.notEqual(
    recipesChanged.snapshot.snapshotDigest,
    baseDigest,
    "changing a recipe revision must change the snapshot digest",
  );

  const policiesChanged = generateMenuCandidates(
    baseInput({
      policyReleases: { ...RELEASES, foodSafetyReleaseId: "release-fs-2" },
    }),
  );
  assert.notEqual(
    policiesChanged.snapshot.snapshotDigest,
    baseDigest,
    "changing a policy release must change the snapshot digest",
  );
});

test("sorting is stable by missing count, then total minutes, then recipe id", () => {
  const result = generateMenuCandidates(
    baseInput({
      suggestedDishCount: 2,
      purchaseTolerance: "allowed",
      candidateIds: ["candidate-1", "candidate-2", "candidate-3"],
      inventoryLots: [],
      recipes: [
        recipe({
          recipeId: "recipe-b",
          totalMinutes: 30,
          ingredients: [
            {
              foodConceptId: "fc-milk",
              displayName: "牛奶",
              optional: false,
              allergenCodes: [],
              mayContainAllergenCodes: [],
            },
          ],
        }),
        recipe({
          recipeId: "recipe-a",
          totalMinutes: 10,
          ingredients: [
            {
              foodConceptId: "fc-bread",
              displayName: "面包",
              optional: false,
              allergenCodes: [],
              mayContainAllergenCodes: [],
            },
          ],
        }),
      ],
    }),
  );
  assert.equal(result.outcome, "options");
  // Both are missing one item; the shorter recipe sorts first.
  assert.equal(result.candidates[0]?.recipeId, "recipe-a");
  assert.equal(result.candidates[1]?.recipeId, "recipe-b");
  assert.deepEqual(result.preselectedCandidateIds, [
    "candidate-2",
    "candidate-1",
  ]);
});
