/**
 * 有界合成纵切的确定性菜单引擎（M-4b 实现，设计冻结见
 * `docs/evidence/stage09p-m4a/m4a-synthetic-slice-design-freeze.md` §5）。
 *
 * 纯函数：无 I/O、无 Fastify、无 Drizzle、无 Taro、无模型 SDK、无副作用。
 * 同一输入逐字节同输出（§8.3）。禁止 `Date.now` / `Math.random`，因此时钟与
 * 候选 id 由调用方经输入注入。
 *
 * 安全边界（§5.4/§5.5、强制更正 a/b）：
 * - 缺项只能经 `foodConceptId` 计算，**绝不**比较 `displayName`；
 * - ingredient 缺 `foodConceptId` 一律 fail closed，不产生候选；
 * - 全桌 allergy 对**所有** active 档案生效（含非参与者）；
 * - 无结构化代码的硬约束 fail closed，不当成「无风险」放行；
 * - 只在硬检查确证通过时才构造 `hardConstraintCheck.status === "passed"` 的候选。
 */
import {
  canonicalJson,
  canonicalSha256Digest,
  compareUtf8,
} from "./canonical.js";

export const RECOMMENDATION_ENGINE_VERSION =
  "stage09p-m4a-menu-engine-v1" as const;
export const RECOMMENDATION_POLICY_VERSION =
  "stage09p-m4a-recommendation-policy-v1" as const;
export const MENU_CONSTRAINT_POLICY_VERSION =
  "stage09p-m4a-menu-constraint-policy-v1" as const;

/** 冻结的候选 reason 闭集（§5.6）。 */
export const menuCandidateReasonCodes = [
  "menu.candidate.within_time_budget",
  "menu.candidate.cook_skill_satisfied",
  "menu.candidate.hard_constraints_clear",
  "menu.candidate.fully_stocked",
  "menu.candidate.missing_items_within_tolerance",
] as const;
export type MenuCandidateReasonCode =
  (typeof menuCandidateReasonCodes)[number];

/** 冻结的 recommendation blocker 闭集（§5.6）。 */
export const menuBlockerCodes = [
  "menu.blocked.hard_constraint_allergy",
  "menu.blocked.hard_constraint_personal",
  "menu.blocked.food_concept_unresolved",
  "menu.blocked.hard_constraint_unmapped",
  "menu.blocked.no_recipe_within_time_budget",
  "menu.blocked.cook_skill_insufficient",
  "menu.blocked.purchase_tolerance_exceeded",
  "menu.blocked.insufficient_suggested_dishes",
  "menu.blocked.no_active_recipe",
  "menu.blocked.input_invalid",
] as const;
export type MenuBlockerCode = (typeof menuBlockerCodes)[number];

export type MenuCookingSkill =
  | "none"
  | "beginner"
  | "intermediate"
  | "advanced";
export type MenuDifficulty = "beginner" | "intermediate" | "advanced";
export type MenuDishRole =
  | "staple"
  | "main"
  | "vegetable"
  | "soup"
  | "side";
export type MenuPurchaseTolerance = "none" | "limited" | "allowed";
export type MenuInventorySafetyStatus = "eligible" | "blocked" | "unknown";

export type MenuConstraintKind =
  | "allergy"
  | "religious"
  | "ethical"
  | "explicit_avoid"
  | "food_safety_exclusion"
  | "preference";
export type MenuConstraintEnforcement = "hard" | "soft";

/** 引擎消费的**未脱敏**单条约束事实（§5.2）。 */
export interface MenuConstraintFact {
  readonly kind: MenuConstraintKind;
  readonly enforcement: MenuConstraintEnforcement;
  readonly mappingStatus: string;
  readonly allergenCodes: readonly string[];
  readonly foodConceptIds: readonly string[];
}

export interface MenuProfileConstraintFacts {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly status: "active" | "archived";
  readonly constraints: readonly MenuConstraintFact[];
}

declare const unredactedConstraintBrand: unique symbol;

/**
 * §6(a) 的类型商标：只有本模块的 `asUnredactedProfileConstraints` 能铸造它。
 * 脱敏投影（`SafeOwnerProfileResponse` / `PersonProfile` 的成员视图）既没有
 * 这个幻影属性，也不是本模块的窄元素形状，因此在**类型层**无法喂入引擎。
 */
export type UnredactedProfileConstraints = readonly MenuProfileConstraintFacts[] & {
  readonly [unredactedConstraintBrand]: "UnredactedProfileConstraints";
};

export const asUnredactedProfileConstraints = (
  profiles: readonly MenuProfileConstraintFacts[],
): UnredactedProfileConstraints =>
  profiles as UnredactedProfileConstraints;

export interface MenuQuantity {
  readonly kind: "exact" | "approximate" | "qualitative";
  readonly amount: number | null;
  readonly level: "plenty" | "some" | "low" | "unknown" | null;
}

export interface MenuInventoryLot {
  readonly lotId: string;
  readonly foodConceptId: string | null;
  readonly quantity: MenuQuantity;
  readonly safetyStatus: MenuInventorySafetyStatus;
  readonly version: number;
  readonly foodConceptRevision: number;
  readonly safetyAssessmentRevision: number;
  readonly safetyPolicyVersion: string;
}

export interface MenuRecipeIngredient {
  readonly foodConceptId: string | null;
  readonly displayName: string;
  readonly optional: boolean;
  readonly allergenCodes: readonly string[];
  readonly mayContainAllergenCodes: readonly string[];
}

export interface MenuRecipe {
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly totalMinutes: number;
  readonly activeMinutes: number;
  readonly difficulty: MenuDifficulty;
  readonly servings: number;
  readonly dishRole: MenuDishRole;
  readonly contentDigest: string;
  readonly ingredients: readonly MenuRecipeIngredient[];
}

export interface MenuPolicyReleaseIds {
  readonly foodConceptReleaseId: string;
  readonly allergenReleaseId: string;
  readonly religiousEthicalReleaseId: string;
  readonly foodSafetyReleaseId: string;
  readonly techniqueReleaseId: string;
  readonly recipeDatasetReleaseId: string;
  readonly constraintMappingReleaseId: string;
}

export interface MenuGenerationInput {
  readonly participantProfileIds: readonly string[];
  readonly cookProfileId: string;
  readonly cookSkill: MenuCookingSkill | null;
  readonly maximumTotalMinutes: number;
  readonly purchaseTolerance: MenuPurchaseTolerance;
  readonly suggestedDishCount: number;
  readonly inventoryLots: readonly MenuInventoryLot[];
  readonly recipes: readonly MenuRecipe[];
  /** §6(a)：唯一允许的约束来源是未脱敏批量读；类型商标在此强制。 */
  readonly profileConstraints: UnredactedProfileConstraints;
  /**
   * 纯引擎不生成随机 id：调用方按 active 食谱顺序预分配候选 id 池，
   * 引擎按评估顺序逐位取用（保持确定性）。
   */
  readonly candidateIds: readonly string[];
  readonly recommendationEngineVersion: string;
  readonly policyReleases: MenuPolicyReleaseIds;
  /** 注入时钟：`hardConstraintCheck.checkedAt`（纯引擎不得读 Date.now）。 */
  readonly evaluatedAt: string;
}

export interface MenuCandidate {
  readonly id: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly servings: number;
  readonly dishRole: MenuDishRole;
  readonly activeMinutes: number;
  readonly totalMinutes: number;
  readonly missingFoodConceptIds: readonly string[];
  readonly plannedInventoryLotIds: readonly string[];
  readonly reasonCodes: readonly MenuCandidateReasonCode[];
  readonly assumptions: readonly string[];
  readonly hardConstraintCheck: {
    readonly status: "passed";
    readonly policyVersion: string;
    readonly checkedAt: string;
  };
}

export interface MenuSnapshot {
  readonly inventory: {
    readonly lots: readonly {
      readonly lotId: string;
      readonly lotVersion: number;
      readonly foodConceptRevision: number;
      readonly safetyAssessmentRevision: number;
    }[];
    readonly inventoryDigest: string;
  };
  readonly constraints: {
    readonly profiles: readonly {
      readonly participantProfileId: string;
      readonly profileVersion: number;
      readonly constraintSetDigest: string;
    }[];
    readonly mappingReleaseId: string;
    readonly constraintDigest: string;
  };
  readonly recipes: {
    readonly recipes: readonly {
      readonly recipeId: string;
      readonly recipeVersion: number;
      readonly contentDigest: string;
      readonly datasetReleaseId: string;
    }[];
    readonly recipeDigest: string;
  };
  readonly policies: {
    readonly foodConceptReleaseId: string;
    readonly allergenReleaseId: string;
    readonly religiousEthicalReleaseId: string;
    readonly foodSafetyReleaseId: string;
    readonly techniqueReleaseId: string;
    readonly recommendationEngineVersion: string;
    readonly policyDigest: string;
  };
  readonly snapshotDigest: string;
}

export interface MenuGenerationResult {
  readonly outcome: "options" | "no_feasible_option";
  readonly participantProfileIds: readonly string[];
  readonly cookProfileId: string;
  readonly maximumTotalMinutes: number;
  readonly purchaseTolerance: MenuPurchaseTolerance;
  readonly suggestedDishCount: number;
  readonly candidates: readonly MenuCandidate[];
  readonly preselectedCandidateIds: readonly string[];
  readonly blockerCodes: readonly MenuBlockerCode[];
  readonly assumptions: readonly string[];
  readonly snapshot: MenuSnapshot;
  readonly recommendationPolicyVersion: string;
}

const SKILL_CEILING: Readonly<Record<MenuCookingSkill, number>> = {
  none: 1,
  beginner: 1,
  intermediate: 2,
  advanced: 3,
};
const DIFFICULTY_RANK: Readonly<Record<MenuDifficulty, number>> = {
  beginner: 1,
  intermediate: 2,
  advanced: 3,
};

const SUBJECT_HARD_KINDS: ReadonlySet<MenuConstraintKind> = new Set([
  "religious",
  "ethical",
  "explicit_avoid",
  "food_safety_exclusion",
]);

const ENGINE_ASSUMPTIONS: readonly string[] = [
  "未知或不可评估的库存批次按不覆盖处理（fail closed）。",
  "总用时按食谱 revision 的 totalMinutes 原样比较，不含份量缩放。",
  "普通难度超限按硬阻断处理，不降级为软排序。",
];

const isHardConstraint = (constraint: MenuConstraintFact): boolean =>
  constraint.enforcement === "hard";

const hasStructuredCodes = (constraint: MenuConstraintFact): boolean =>
  constraint.allergenCodes.length > 0 ||
  constraint.foodConceptIds.length > 0;

const intersects = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
};

const ingredientMatchesConstraint = (
  ingredient: MenuRecipeIngredient,
  constraint: MenuConstraintFact,
): boolean => {
  if (
    ingredient.foodConceptId !== null &&
    constraint.foodConceptIds.includes(ingredient.foodConceptId)
  ) {
    return true;
  }
  const exposure = [
    ...ingredient.allergenCodes,
    ...ingredient.mayContainAllergenCodes,
  ];
  return intersects(constraint.allergenCodes, exposure);
};

/** §5.4 数量覆盖判定：批次数量非空/为正才算覆盖；无法判定即不覆盖。 */
const lotQuantityCovers = (quantity: MenuQuantity): boolean => {
  if (quantity.kind === "qualitative") {
    return quantity.level !== null && quantity.level !== "unknown";
  }
  return quantity.amount !== null && quantity.amount > 0;
};

const lotProvidesConcept = (
  lot: MenuInventoryLot,
  foodConceptId: string,
): boolean =>
  lot.foodConceptId === foodConceptId &&
  lot.safetyStatus === "eligible" &&
  lotQuantityCovers(lot.quantity);

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareUtf8);

const sortBlockerCodes = (
  codes: Iterable<MenuBlockerCode>,
): MenuBlockerCode[] =>
  [...new Set(codes)].sort(compareUtf8) as MenuBlockerCode[];

/** 非 null 对象判定（类型谓词）。用于 policies 段容器读取。 */
const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * 数组判定，刻意**不**写成类型谓词：`Array.isArray` 会把 `readonly T[]` 收窄为
 * `any[]`，让后续对输入元素类型的静态检查失效（例如 `recipe.difficulty` 退化为
 * `any`）。结构校验只需要一个布尔，不应顺带改变输入类型。
 */
const isArray = (value: unknown): boolean => Array.isArray(value);

/** 数组元素的结构判定：过滤掉 null / 非对象元素，使快照构造不因元素而抛异常。 */
const isObjectElement = (value: unknown): boolean =>
  typeof value === "object" && value !== null;

/** recipe 的结构完整性：`ingredients` 及各 ingredient 的 allergen 数组必须均为数组。 */
const isStructurallyValidRecipe = (recipe: MenuRecipe): boolean =>
  isRecord(recipe) &&
  Array.isArray(recipe.ingredients) &&
  recipe.ingredients.every(
    (ingredient) =>
      isObjectElement(ingredient) &&
      Array.isArray(ingredient.allergenCodes) &&
      Array.isArray(ingredient.mayContainAllergenCodes),
  );

/**
 * lot 的结构完整性：`evaluateRecipe` 经 §5.4 数量覆盖判定（`lotQuantityCovers`）
 * 解引用**嵌套**的 `lot.quantity`（`quantity.kind` / `.level` / `.amount`），故该嵌套
 * 对象必须存在且是对象——否则 `lotQuantityCovers` 会对 `null` / `undefined` 取属性而抛
 * TypeError，绕过 `menu.blocked.input_invalid` 的结构化 blocker 路径。
 */
const isStructurallyValidLot = (lot: MenuInventoryLot): boolean =>
  isObjectElement(lot) && isObjectElement(lot.quantity);

/**
 * policies 段的字段读取：容器非对象、或字段缺失 / 非字符串时取空串（空段语义）。
 * 仅在结构非法输入上生效；合法输入（字段均为 `string`）逐字节不变。
 */
const releaseId = (
  releases: MenuPolicyReleaseIds,
  key: keyof MenuPolicyReleaseIds,
): string => {
  if (!isRecord(releases)) return "";
  const value = releases[key];
  return typeof value === "string" ? value : "";
};

interface RecipeEvaluation {
  readonly blockedCodes: readonly MenuBlockerCode[];
  readonly candidate: MenuCandidate | null;
}

const evaluateRecipe = (
  input: MenuGenerationInput,
  recipe: MenuRecipe,
  activeProfiles: readonly MenuProfileConstraintFacts[],
  participantSet: ReadonlySet<string>,
  candidateId: string,
): RecipeEvaluation => {
  const blocked: MenuBlockerCode[] = [];

  // §5.4 / §6(b)：任一 ingredient 缺 foodConceptId 一律 fail closed，
  // 绝不退化为 displayName 字符串匹配。
  if (recipe.ingredients.some((ingredient) => ingredient.foodConceptId === null)) {
    return {
      blockedCodes: ["menu.blocked.food_concept_unresolved"],
      candidate: null,
    };
  }

  // §5.5：全桌 allergy（table scope）对**所有** active 档案生效。
  const tableHard = activeProfiles.flatMap((profile) =>
    profile.constraints.filter(
      (constraint) => isHardConstraint(constraint) && constraint.kind === "allergy",
    ),
  );
  // §5.5：参与者个人硬约束（subject scope）。
  const subjectHard = activeProfiles
    .filter((profile) => participantSet.has(profile.profileId))
    .flatMap((profile) =>
      profile.constraints.filter(
        (constraint) =>
          isHardConstraint(constraint) &&
          SUBJECT_HARD_KINDS.has(constraint.kind),
      ),
    );

  const checkScope = (
    constraints: readonly MenuConstraintFact[],
    hitCode: MenuBlockerCode,
  ): void => {
    for (const constraint of constraints) {
      // §5.5 第 5 条：无结构化代码的硬约束无法被证明已满足，fail closed。
      if (!hasStructuredCodes(constraint)) {
        blocked.push("menu.blocked.hard_constraint_unmapped");
        continue;
      }
      if (
        recipe.ingredients.some((ingredient) =>
          ingredientMatchesConstraint(ingredient, constraint),
        )
      ) {
        blocked.push(hitCode);
      }
    }
  };

  checkScope(tableHard, "menu.blocked.hard_constraint_allergy");
  checkScope(subjectHard, "menu.blocked.hard_constraint_personal");

  if (blocked.length > 0) {
    return { blockedCodes: blocked, candidate: null };
  }

  // §5.4：只经 foodConceptId 计算缺项；覆盖要求 eligible 且数量满足。
  const missing: string[] = [];
  const plannedLots: string[] = [];
  for (const ingredient of recipe.ingredients) {
    const foodConceptId = ingredient.foodConceptId;
    if (foodConceptId === null) {
      // 上面的 fail-closed 已返回；此处仅作类型收窄。
      return {
        blockedCodes: ["menu.blocked.food_concept_unresolved"],
        candidate: null,
      };
    }
    const coveringLots = input.inventoryLots.filter((lot) =>
      lotProvidesConcept(lot, foodConceptId),
    );
    if (coveringLots.length === 0) {
      missing.push(foodConceptId);
    } else {
      for (const lot of coveringLots) plannedLots.push(lot.lotId);
    }
  }
  const missingFoodConceptIds = sortedUnique(missing);
  const plannedInventoryLotIds = sortedUnique(plannedLots);

  // §5.7 采购容忍度。
  const missingIngredients = recipe.ingredients.filter(
    (ingredient) =>
      ingredient.foodConceptId !== null &&
      missingFoodConceptIds.includes(ingredient.foodConceptId),
  );
  const toleranceOk = (() => {
    if (missingFoodConceptIds.length === 0) return true;
    if (input.purchaseTolerance === "allowed") return true;
    if (input.purchaseTolerance === "limited") {
      return missingIngredients.every((ingredient) => ingredient.optional);
    }
    return false;
  })();
  if (!toleranceOk) {
    return {
      blockedCodes: ["menu.blocked.purchase_tolerance_exceeded"],
      candidate: null,
    };
  }

  const reasonCodes: MenuCandidateReasonCode[] = [
    "menu.candidate.within_time_budget",
    "menu.candidate.cook_skill_satisfied",
    "menu.candidate.hard_constraints_clear",
    missingFoodConceptIds.length === 0
      ? "menu.candidate.fully_stocked"
      : "menu.candidate.missing_items_within_tolerance",
  ];

  return {
    blockedCodes: [],
    candidate: {
      id: candidateId,
      recipeId: recipe.recipeId,
      recipeVersion: recipe.recipeVersion,
      servings: recipe.servings,
      dishRole: recipe.dishRole,
      activeMinutes: recipe.activeMinutes,
      totalMinutes: recipe.totalMinutes,
      missingFoodConceptIds,
      plannedInventoryLotIds,
      reasonCodes,
      assumptions: [ENGINE_ASSUMPTIONS[1] as string],
      hardConstraintCheck: {
        status: "passed",
        policyVersion: MENU_CONSTRAINT_POLICY_VERSION,
        checkedAt: input.evaluatedAt,
      },
    },
  };
};

const compareCandidates = (left: MenuCandidate, right: MenuCandidate): number => {
  const missing = left.missingFoodConceptIds.length - right.missingFoodConceptIds.length;
  if (missing !== 0) return missing;
  const minutes = left.totalMinutes - right.totalMinutes;
  if (minutes !== 0) return minutes;
  return compareUtf8(left.recipeId, right.recipeId);
};

const buildSnapshot = (input: MenuGenerationInput): MenuSnapshot => {
  // 本函数不只服务成功路径：`menu.blocked.input_invalid` 与四条 sibling early exit
  // （no_active_recipe / no_recipe_within_time_budget / cook_skill_insufficient /
  // insufficient_suggested_dishes）都在返回 blocker 之前先经此处构造快照。
  //
  // 因此对**结构非法**的输入段一律按空段处理，使 blocker 能在不抛异常的前提下被构造：
  //   - 段容器非数组（inventoryLots / recipes / profileConstraints / constraints）→ 空段；
  //   - 段容器非对象（policyReleases）→ policies 段字段全取空串；
  //   - 段内元素为 null / 非对象 → 跳过该元素；
  //   - constraints 段内的 allergenCodes / foodConceptIds 非数组 → 空数组。
  //
  // 边界（不得读作「对任意非法输入都不抛」）：**记录内的标量字段**缺损（如
  // `lot.version`、`profile.profileId`、`recipe.recipeId` 为 `undefined`）或非 JSON 标量
  // 仍会让 `canonicalJson` 抛 `INVALID_CANONICAL_INPUT`。该字段级路径不在本函数防御
  // 范围内，已在 R1 报告中列为 remaining throw path；不得据此断言本函数是全函数。
  const lotSource = Array.isArray(input.inventoryLots) ? input.inventoryLots : [];
  const lots = [...lotSource]
    .filter(isObjectElement)
    .sort((left, right) => compareUtf8(left.lotId, right.lotId))
    .map((lot) => ({
      lotId: lot.lotId,
      lotVersion: lot.version,
      foodConceptRevision: lot.foodConceptRevision,
      safetyAssessmentRevision: lot.safetyAssessmentRevision,
    }));
  // 结构校验失败时 blocker 仍需经本函数构造，故此处按空段处理，使非法的
  // `profileConstraints` / `constraints` 也走同一条不抛异常的 blocker 路径。
  const profileConstraintFacts: readonly MenuProfileConstraintFacts[] =
    Array.isArray(input.profileConstraints) ? input.profileConstraints : [];
  const profiles = profileConstraintFacts
    .filter(isObjectElement)
    .filter((profile) => profile.status === "active")
    .slice()
    .sort((left, right) => compareUtf8(left.profileId, right.profileId))
    .map((profile) => {
      const constraintFacts: readonly MenuConstraintFact[] = Array.isArray(
        profile.constraints,
      )
        ? profile.constraints.filter(isObjectElement)
        : [];
      return {
        participantProfileId: profile.profileId,
        profileVersion: profile.profileVersion,
        // §3.4：constraintSetDigest 对**未脱敏**约束集计算，只承载摘要不承载原文。
        constraintSetDigest: canonicalSha256Digest(
          [...constraintFacts]
            .map((constraint) => ({
              kind: constraint.kind,
              enforcement: constraint.enforcement,
              mappingStatus: constraint.mappingStatus,
              allergenCodes: Array.isArray(constraint.allergenCodes)
                ? [...constraint.allergenCodes].sort(compareUtf8)
                : [],
              foodConceptIds: Array.isArray(constraint.foodConceptIds)
                ? [...constraint.foodConceptIds].sort(compareUtf8)
                : [],
            }))
            .sort((left, right) =>
              compareUtf8(canonicalJson(left), canonicalJson(right)),
            ),
        ),
      };
    });
  const recipeSource = Array.isArray(input.recipes) ? input.recipes : [];
  const recipes = [...recipeSource]
    .filter(isObjectElement)
    .sort((left, right) => {
      const id = compareUtf8(left.recipeId, right.recipeId);
      return id !== 0 ? id : left.recipeVersion - right.recipeVersion;
    })
    .map((recipe) => ({
      recipeId: recipe.recipeId,
      recipeVersion: recipe.recipeVersion,
      contentDigest: recipe.contentDigest,
      datasetReleaseId: releaseId(input.policyReleases, "recipeDatasetReleaseId"),
    }));

  const inventory = {
    lots,
    inventoryDigest: canonicalSha256Digest(lots),
  };
  const constraints = {
    profiles,
    mappingReleaseId: releaseId(input.policyReleases, "constraintMappingReleaseId"),
    constraintDigest: canonicalSha256Digest({
      profiles,
      mappingReleaseId: releaseId(input.policyReleases, "constraintMappingReleaseId"),
    }),
  };
  const recipeSegment = {
    recipes,
    recipeDigest: canonicalSha256Digest(recipes),
  };
  const policiesMaterial = {
    foodConceptReleaseId: releaseId(input.policyReleases, "foodConceptReleaseId"),
    allergenReleaseId: releaseId(input.policyReleases, "allergenReleaseId"),
    religiousEthicalReleaseId: releaseId(
      input.policyReleases,
      "religiousEthicalReleaseId",
    ),
    foodSafetyReleaseId: releaseId(input.policyReleases, "foodSafetyReleaseId"),
    techniqueReleaseId: releaseId(input.policyReleases, "techniqueReleaseId"),
    // 同属 policies 段：非字符串（含缺失）取空串，与上列 release id 同一口径。
    recommendationEngineVersion:
      typeof input.recommendationEngineVersion === "string"
        ? input.recommendationEngineVersion
        : "",
  };
  const policies = {
    ...policiesMaterial,
    policyDigest: canonicalSha256Digest(policiesMaterial),
  };
  const snapshotDigest = canonicalSha256Digest({
    inventory,
    constraints,
    recipes: recipeSegment,
    policies,
  });
  return {
    inventory,
    constraints,
    recipes: recipeSegment,
    policies,
    snapshotDigest,
  };
};

const blockedResult = (
  input: MenuGenerationInput,
  codes: readonly MenuBlockerCode[],
): MenuGenerationResult => ({
  outcome: "no_feasible_option",
  // 空/非数组参与者也要能安全回写 blocker，而不是在构造结果时抛异常。
  participantProfileIds: Array.isArray(input.participantProfileIds)
    ? [...input.participantProfileIds]
    : [],
  cookProfileId: input.cookProfileId,
  maximumTotalMinutes: input.maximumTotalMinutes,
  purchaseTolerance: input.purchaseTolerance,
  suggestedDishCount: input.suggestedDishCount,
  candidates: [],
  preselectedCandidateIds: [],
  blockerCodes: sortBlockerCodes(codes),
  assumptions: [...ENGINE_ASSUMPTIONS],
  snapshot: buildSnapshot(input),
  recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
});

/**
 * 确定性菜单引擎（§5）。输出即 `recommendationSchema` 的字段形状（不含
 * 服务端落库的 id/householdId/createdAt/expiresAt）。
 */
export const generateMenuCandidates = (
  input: MenuGenerationInput,
): MenuGenerationResult => {
  const blockers: MenuBlockerCode[] = [];

  // §5.2 输入完整性 fail closed（**容器形状**）：以下两类容器形状非法一律记
  // `menu.blocked.input_invalid`，且都在 `evaluateRecipe` 解引用之前判定：
  //   - 段容器本身形状非法：participantProfileIds / profileConstraints / recipes /
  //     inventoryLots / candidateIds 非数组、policyReleases 非对象，或 participantProfileIds 为空；
  //   - 段内被解引用的**嵌套容器**缺失或形状非法：`profile.constraints`、`constraint` 的
  //     `allergenCodes` / `foodConceptIds`、`recipe.ingredients`、`ingredient` 的
  //     `allergenCodes` / `mayContainAllergenCodes`，以及 **`lot.quantity`**（§5.4 数量
  //     覆盖判定解引用的对象）。
  // 这样四条 sibling early exit（no_active_recipe / no_recipe_within_time_budget /
  // cook_skill_insufficient / insufficient_suggested_dishes）与 input_invalid 一样只返回
  // 结构化 blocker，不抛 TypeError——它们都先经 buildSnapshot 构造快照才返回。
  //
  // **本判定只覆盖容器形状，不覆盖字段级 / 标量边界**，故不得据此断言它是全函数：
  //   - 未防御者：元素本身是数组（`isObjectElement` / `isRecord` 对数组为真）或缺少标量
  //     字段（如 `recipe.recipeId` / `lot.version` / `profile.profileId` 为 `undefined`），
  //     或标量取到非 JSON 值；
  //   - 后果：这类输入即使被本判定拦下（返回 input_invalid），`buildSnapshot` 的标量读取
  //     仍会在构造快照时抛 `INVALID_CANONICAL_INPUT`（边界与实例见 buildSnapshot 注释）。
  //     真正的全函数边界应落在 `buildSnapshot` 的标量读取上，不在本判定内。
  const invalidInput = (): MenuGenerationResult =>
    blockedResult(input, ["menu.blocked.input_invalid"]);
  if (!isArray(input.participantProfileIds) || input.participantProfileIds.length === 0) {
    return invalidInput();
  }
  if (!isArray(input.profileConstraints)) {
    return invalidInput();
  }
  for (const profile of input.profileConstraints) {
    if (!isObjectElement(profile) || !isArray(profile.constraints)) {
      return invalidInput();
    }
    for (const constraint of profile.constraints) {
      if (
        !isObjectElement(constraint) ||
        !isArray(constraint.allergenCodes) ||
        !isArray(constraint.foodConceptIds)
      ) {
        return invalidInput();
      }
    }
  }
  if (!isArray(input.recipes) || !input.recipes.every(isStructurallyValidRecipe)) {
    return invalidInput();
  }
  if (!isArray(input.inventoryLots) || !input.inventoryLots.every(isStructurallyValidLot)) {
    return invalidInput();
  }
  if (!isArray(input.candidateIds)) {
    return invalidInput();
  }
  if (!isObjectElement(input.policyReleases)) {
    return invalidInput();
  }
  if (
    !Number.isInteger(input.maximumTotalMinutes) ||
    input.maximumTotalMinutes <= 0 ||
    !Number.isInteger(input.suggestedDishCount) ||
    input.suggestedDishCount < 1 ||
    input.suggestedDishCount > 3
  ) {
    return invalidInput();
  }

  const activeProfiles = input.profileConstraints.filter(
    (profile) => profile.status === "active",
  );
  const participantSet = new Set(input.participantProfileIds);

  // §5.6 无 active recipe revision。
  if (input.recipes.length === 0) {
    return blockedResult(input, ["menu.blocked.no_active_recipe"]);
  }

  // §5.6/§5.7：时间预算与厨艺为硬过滤。
  const withinTimeBudget = input.recipes.filter(
    (recipe) => recipe.totalMinutes <= input.maximumTotalMinutes,
  );
  if (withinTimeBudget.length === 0) {
    return blockedResult(input, ["menu.blocked.no_recipe_within_time_budget"]);
  }
  const ceiling = SKILL_CEILING[input.cookSkill ?? "none"];
  const skillEligible = withinTimeBudget.filter(
    (recipe) => DIFFICULTY_RANK[recipe.difficulty] <= ceiling,
  );
  if (skillEligible.length === 0) {
    return blockedResult(input, ["menu.blocked.cook_skill_insufficient"]);
  }

  const candidates: MenuCandidate[] = [];
  let poolIndex = 0;
  for (const recipe of skillEligible) {
    const candidateId = input.candidateIds[poolIndex];
    poolIndex += 1;
    if (candidateId === undefined) {
      blockers.push("menu.blocked.input_invalid");
      continue;
    }
    const evaluation = evaluateRecipe(
      input,
      recipe,
      activeProfiles,
      participantSet,
      candidateId,
    );
    if (evaluation.candidate === null) {
      for (const code of evaluation.blockedCodes) blockers.push(code);
      continue;
    }
    candidates.push(evaluation.candidate);
  }

  candidates.sort(compareCandidates);

  if (candidates.length < input.suggestedDishCount) {
    if (blockers.length === 0) {
      blockers.push("menu.blocked.insufficient_suggested_dishes");
    }
    return blockedResult(input, blockers);
  }

  return {
    outcome: "options",
    participantProfileIds: [...input.participantProfileIds],
    cookProfileId: input.cookProfileId,
    maximumTotalMinutes: input.maximumTotalMinutes,
    purchaseTolerance: input.purchaseTolerance,
    suggestedDishCount: input.suggestedDishCount,
    candidates,
    preselectedCandidateIds: candidates
      .slice(0, input.suggestedDishCount)
      .map((candidate) => candidate.id),
    blockerCodes: [],
    assumptions: [...ENGINE_ASSUMPTIONS],
    snapshot: buildSnapshot(input),
    recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
  };
};
