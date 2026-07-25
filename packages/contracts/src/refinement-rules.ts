/**
 * Zod refine/superRefine 无法自动降级为 JSON Schema。此清单是生成
 * OpenAPI 的稳定扩展语义：每个公共边界 refinement 必须有稳定 rule ID，
 * 并明确由原生 JSON Schema 还是 runtime-only 校验执行。
 */
export type ContractRule = {
  readonly id: string;
  readonly sourceKind: "refinement" | "native-schema";
  readonly enforcement: "runtime-only" | "native";
  readonly boundary: string;
  readonly description: string;
  readonly jsonSchemaKeywords?: readonly string[];
};

export const contractRuleManifest = [
  {
    id: "api.problem.status-code-consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "apiErrorSchema",
    description: "problem status must match its stable API error code",
  },
  {
    id: "identity.session.lifecycle.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "sessionSchema",
    description: "session status, revokedAt and timestamps are consistent",
  },
  {
    id: "identity.authenticated-session.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "authenticatedSessionSchema",
    description: "authenticated user and session are active and share user id",
  },
  {
    id: "identity.membership.capabilities-unique.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "membershipSchema.capabilities",
    description: "membership capability values are unique",
  },
  {
    id: "identity.constraint.allergy-identifier.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "dietaryConstraintSchema",
    description:
      "allergy requires an identifier-shaped allergen or food concept input while mapping remains blocked",
  },
  {
    id: "identity.profile.household-visibility.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "safeOwnerProfileResponseSchema",
    description: "redacted profiles contain only household-visible constraints",
  },
  {
    id: "identity.household-create.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "createHouseholdResultSchema",
    description: "household, owner membership and owner profile are linked",
  },
  {
    id: "inventory.lot.dates-unique.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "inventoryLotSchema.dates",
    description: "inventory lot date kinds are unique",
  },
  {
    id: "inventory.lot.state-quantity-safety.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "inventoryLotSchema",
    description: "lot state matches quantity and blocked safety has reasons",
  },
  {
    id: "inventory.create-date.provenance.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "createInventoryLotDateInputSchema",
    description: "package labels cannot establish purchase dates",
  },
  {
    id: "inventory.create.dates-unique.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "createInventoryLotRequestSchema.dates",
    description: "create-lot date kinds are unique",
  },
  {
    id: "inventory.event.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "inventoryEventSchema",
    description: "event type, quantity direction and versions are consistent",
  },
  {
    id: "inventory.create-result.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "createInventoryLotResultSchema",
    description: "created lot and acquired event are atomically consistent",
  },
  {
    id: "inventory.consume-result.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "consumeInventoryLotResultSchema",
    description: "consume result has exact negative event and safe projection",
  },
  {
    id: "meal.recipe.review-and-steps.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "recipeSchema",
    description: "review state and recipe step order are consistent",
  },
  {
    id: "meal.instance.unique-participants-recipes.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "mealSchema",
    description: "meal participants and recipes are unique",
  },
  {
    id: "meal.recommendation.outcome-consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "recommendationSchema",
    description: "recommendation outcome, candidates and blockers agree",
  },
  {
    id: "members.invite.entity-consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "householdInviteSchema",
    description: "invite usage and expiry are consistent",
  },
  {
    id: "members.invite.create-result.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "createHouseholdInviteResultSchema",
    description: "new invite is active with zero uses",
  },
  {
    id: "members.invite.revoke-result.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "revokeHouseholdInviteResultSchema",
    description: "revoked invite reports revoked status",
  },
  {
    id: "members.join.result-consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "joinHouseholdResultSchema",
    description: "join result is an active member in returned household",
  },
  {
    id: "members.remove.result-consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "removeMembershipResultSchema",
    description: "removed membership cannot remain active",
  },
  {
    id: "profiles.update.non-empty.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "updatePersonProfileRequestSchema",
    description: "profile update changes at least one field",
  },
  {
    id: "profiles.constraint.confirmation-and-allergy.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "dietaryConstraintInputSchema",
    description: "hard confirmation fingerprint and allergy ids are valid",
  },
  {
    id: "quantity.information-source.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "informationSourceSchema",
    description: "information source carries required rule or confirmer",
  },
  {
    id: "quantity.food-date.kind-source.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "foodDateSchema",
    description: "food date value and provenance match its kind",
  },
  {
    id: "quantity.approximate.scale.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "approximateQuantitySchema.amount",
    description: "approximate number has at most six decimal places",
  },
  {
    id: "quantity.approximate.amount-unit-pair.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "approximateQuantitySchema",
    description: "approximate amount and unit appear together",
  },
  {
    id: "quantity.non-empty.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "nonEmptyQuantitySchema",
    description: "quantity does not represent empty",
  },
  {
    id: "quantity.delta.estimated-scale.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "quantityDeltaSchema.estimated.amount",
    description: "estimated delta has at most six decimal places",
  },
  {
    id: "quantity.delta.estimated-nonzero.v1",
    sourceKind: "refinement",
    enforcement: "native",
    boundary: "quantityDeltaSchema.estimated.amount",
    description: "estimated delta cannot be zero",
    jsonSchemaKeywords: ["not"],
  },
  {
    id: "shopping.item.lifecycle.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    boundary: "shoppingItemSchema",
    description: "shopping status, purchase facts and lots are consistent",
  },
  {
    id: "quantity.exact.positive.v1",
    sourceKind: "native-schema",
    enforcement: "native",
    boundary: "persistableInitialQuantitySchema.exact.amount",
    description: "initial and consumed exact amounts are strictly positive",
    jsonSchemaKeywords: ["pattern"],
  },
  {
    id: "quantity.delta.exact-nonzero.v1",
    sourceKind: "native-schema",
    enforcement: "native",
    boundary: "quantityDeltaSchema.exact.amount",
    description: "exact quantity delta cannot be mathematical zero",
    jsonSchemaKeywords: ["pattern"],
  },
] as const satisfies readonly ContractRule[];
