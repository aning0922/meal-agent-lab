import type { z } from "zod";

import { apiErrorSchema } from "./api.js";
import {
  authenticatedSessionSchema,
  createHouseholdResultSchema,
  dietaryConstraintSchema,
  membershipSchema,
  safeOwnerProfileResponseSchema,
  sessionSchema,
} from "./identity.js";
import {
  consumeInventoryLotResultSchema,
  createInventoryLotDateInputSchema,
  createInventoryLotRequestSchema,
  createInventoryLotResultSchema,
  inventoryEventSchema,
  inventoryLotSchema,
} from "./inventory.js";
import {
  mealSchema,
  recommendationSchema,
  recipeSchema,
} from "./meals.js";
import {
  createHouseholdInviteResultSchema,
  dietaryConstraintInputSchema,
  householdInviteSchema,
  joinHouseholdResultSchema,
  removeMembershipResultSchema,
  revokeHouseholdInviteResultSchema,
  updatePersonProfileRequestSchema,
} from "./members.js";
import {
  approximateQuantitySchema,
  foodDateSchema,
  informationSourceSchema,
  nonEmptyQuantitySchema,
  nonZeroEstimatedQuantityDeltaAmountSchema,
  persistableInitialQuantitySchema,
  positiveApproximateQuantityAmountSchema,
  quantityDeltaSchema,
} from "./primitives.js";
import type { ContractRule } from "./refinement-rules.js";
import { shoppingItemSchema } from "./shopping.js";

export type ContractRuleBinding = {
  readonly boundary: string;
  readonly ruleIds: readonly ContractRule["id"][];
};

export type ContractRuleSchemaBinding = ContractRuleBinding & {
  /**
   * 实际运行时 schema 对象。门禁以此验证 binding，而不是扫描源码后只比较
   * refine 调用总数；同一 schema 上的多个规则必须逐 ID 列出。
   */
  readonly schema: z.ZodType;
};

export const contractRuleSchemaBindings = [
  {
    boundary: "apiErrorSchema",
    ruleIds: ["api.problem.status-code-consistency.v1"],
    schema: apiErrorSchema,
  },
  {
    boundary: "sessionSchema",
    ruleIds: ["identity.session.lifecycle.v1"],
    schema: sessionSchema,
  },
  {
    boundary: "authenticatedSessionSchema",
    ruleIds: ["identity.authenticated-session.consistency.v1"],
    schema: authenticatedSessionSchema,
  },
  {
    boundary: "membershipSchema.capabilities",
    ruleIds: ["identity.membership.capabilities-unique.v1"],
    schema: membershipSchema,
  },
  {
    boundary: "dietaryConstraintSchema",
    ruleIds: ["identity.constraint.allergy-identifier.v1"],
    schema: dietaryConstraintSchema,
  },
  {
    boundary: "safeOwnerProfileResponseSchema",
    ruleIds: ["identity.profile.household-visibility.v1"],
    schema: safeOwnerProfileResponseSchema,
  },
  {
    boundary: "createHouseholdResultSchema",
    ruleIds: ["identity.household-create.consistency.v1"],
    schema: createHouseholdResultSchema,
  },
  {
    boundary: "inventoryLotSchema.dates",
    ruleIds: ["inventory.lot.dates-unique.v1"],
    schema: inventoryLotSchema,
  },
  {
    boundary: "inventoryLotSchema",
    ruleIds: ["inventory.lot.state-quantity-safety.v1"],
    schema: inventoryLotSchema,
  },
  {
    boundary: "createInventoryLotDateInputSchema",
    ruleIds: ["inventory.create-date.provenance.v1"],
    schema: createInventoryLotDateInputSchema,
  },
  {
    boundary: "createInventoryLotRequestSchema.dates",
    ruleIds: ["inventory.create.dates-unique.v1"],
    schema: createInventoryLotRequestSchema,
  },
  {
    boundary: "inventoryEventSchema",
    ruleIds: ["inventory.event.consistency.v1"],
    schema: inventoryEventSchema,
  },
  {
    boundary: "createInventoryLotResultSchema",
    ruleIds: ["inventory.create-result.consistency.v1"],
    schema: createInventoryLotResultSchema,
  },
  {
    boundary: "consumeInventoryLotResultSchema",
    ruleIds: ["inventory.consume-result.consistency.v1"],
    schema: consumeInventoryLotResultSchema,
  },
  {
    boundary: "recipeSchema",
    ruleIds: ["meal.recipe.review-and-steps.v1"],
    schema: recipeSchema,
  },
  {
    boundary: "mealSchema",
    ruleIds: ["meal.instance.unique-participants-recipes.v1"],
    schema: mealSchema,
  },
  {
    boundary: "recommendationSchema",
    ruleIds: ["meal.recommendation.outcome-consistency.v1"],
    schema: recommendationSchema,
  },
  {
    boundary: "householdInviteSchema",
    ruleIds: ["members.invite.entity-consistency.v1"],
    schema: householdInviteSchema,
  },
  {
    boundary: "createHouseholdInviteResultSchema",
    ruleIds: ["members.invite.create-result.v1"],
    schema: createHouseholdInviteResultSchema,
  },
  {
    boundary: "revokeHouseholdInviteResultSchema",
    ruleIds: ["members.invite.revoke-result.v1"],
    schema: revokeHouseholdInviteResultSchema,
  },
  {
    boundary: "joinHouseholdResultSchema",
    ruleIds: ["members.join.result-consistency.v1"],
    schema: joinHouseholdResultSchema,
  },
  {
    boundary: "removeMembershipResultSchema",
    ruleIds: ["members.remove.result-consistency.v1"],
    schema: removeMembershipResultSchema,
  },
  {
    boundary: "updatePersonProfileRequestSchema",
    ruleIds: ["profiles.update.non-empty.v1"],
    schema: updatePersonProfileRequestSchema,
  },
  {
    boundary: "dietaryConstraintInputSchema",
    ruleIds: ["profiles.constraint.confirmation-and-allergy.v1"],
    schema: dietaryConstraintInputSchema,
  },
  {
    boundary: "informationSourceSchema",
    ruleIds: ["quantity.information-source.consistency.v1"],
    schema: informationSourceSchema,
  },
  {
    boundary: "foodDateSchema",
    ruleIds: ["quantity.food-date.kind-source.v1"],
    schema: foodDateSchema,
  },
  {
    boundary: "approximateQuantitySchema.amount",
    ruleIds: ["quantity.approximate.scale.v1"],
    schema: positiveApproximateQuantityAmountSchema,
  },
  {
    boundary: "approximateQuantitySchema",
    ruleIds: ["quantity.approximate.amount-unit-pair.v1"],
    schema: approximateQuantitySchema,
  },
  {
    boundary: "nonEmptyQuantitySchema",
    ruleIds: ["quantity.non-empty.v1"],
    schema: nonEmptyQuantitySchema,
  },
  {
    boundary: "quantityDeltaSchema.estimated.amount",
    ruleIds: [
      "quantity.delta.estimated-scale.v1",
      "quantity.delta.estimated-nonzero.v1",
    ],
    schema: nonZeroEstimatedQuantityDeltaAmountSchema,
  },
  {
    boundary: "shoppingItemSchema",
    ruleIds: ["shopping.item.lifecycle.v1"],
    schema: shoppingItemSchema,
  },
  {
    boundary: "persistableInitialQuantitySchema.exact.amount",
    ruleIds: ["quantity.exact.positive.v1"],
    schema: persistableInitialQuantitySchema,
  },
  {
    boundary: "quantityDeltaSchema.exact.amount",
    ruleIds: ["quantity.delta.exact-nonzero.v1"],
    schema: quantityDeltaSchema,
  },
] as const satisfies readonly ContractRuleSchemaBinding[];

/** 可序列化到 OpenAPI 根扩展的逐 boundary binding。 */
export const contractRuleBindings: readonly ContractRuleBinding[] =
  contractRuleSchemaBindings.map(({ boundary, ruleIds }) => ({
    boundary,
    ruleIds,
  }));
