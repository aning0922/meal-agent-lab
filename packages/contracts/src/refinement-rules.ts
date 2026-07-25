/**
 * Zod refine/superRefine 无法自动降级为 JSON Schema。此清单是生成
 * OpenAPI 的稳定扩展语义：每个公共边界 refinement 必须有稳定 rule ID，
 * 并明确由原生 JSON Schema 还是 runtime-only 校验执行。
 */
export type ContractRule = {
  readonly id: string;
  readonly sourceKind: "refinement" | "native-schema";
  readonly enforcement: "runtime-only" | "native";
  readonly description: string;
  readonly jsonSchemaKeywords?: readonly string[];
};

export const contractRuleManifest = [
  {
    id: "api.problem.status-code-consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "problem status must match its stable API error code",
  },
  {
    id: "identity.session.lifecycle.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "session status, revokedAt and timestamps are consistent",
  },
  {
    id: "identity.authenticated-session.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "authenticated user and session are active and share user id",
  },
  {
    id: "identity.membership.capabilities-unique.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "membership capability values are unique",
  },
  {
    id: "identity.profile.household-visibility.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "redacted profiles contain only household-visible constraints",
  },
  {
    id: "identity.household-create.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "household, owner membership and owner profile are linked",
  },
  {
    id: "inventory.lot.dates-unique.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "inventory lot date kinds are unique",
  },
  {
    id: "inventory.lot.state-quantity-safety.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "lot state matches quantity and blocked safety has reasons",
  },
  {
    id: "inventory.create-date.provenance.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "package labels cannot establish purchase dates",
  },
  {
    id: "inventory.create.dates-unique.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "create-lot date kinds are unique",
  },
  {
    id: "inventory.event.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "event type, quantity direction and versions are consistent",
  },
  {
    id: "inventory.create-result.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "created lot and acquired event are atomically consistent",
  },
  {
    id: "inventory.consume-result.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "consume result has exact negative event and safe projection",
  },
  {
    id: "meal.recipe.review-and-steps.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "review state and recipe step order are consistent",
  },
  {
    id: "meal.instance.unique-participants-recipes.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "meal participants and recipes are unique",
  },
  {
    id: "meal.recommendation.outcome-consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "recommendation outcome, candidates and blockers agree",
  },
  {
    id: "members.invite.entity-consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "invite usage and expiry are consistent",
  },
  {
    id: "members.invite.create-result.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "new invite is active with zero uses",
  },
  {
    id: "members.invite.revoke-result.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "revoked invite reports revoked status",
  },
  {
    id: "members.join.result-consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "join result is an active member in returned household",
  },
  {
    id: "members.remove.result-consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "removed membership cannot remain active",
  },
  {
    id: "profiles.update.non-empty.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "profile update changes at least one field",
  },
  {
    id: "profiles.constraint.confirmation-fingerprint.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description:
      "hard confirmation fingerprint covers every submitted field",
  },
  {
    id: "quantity.information-source.consistency.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "information source carries required rule or confirmer",
  },
  {
    id: "quantity.food-date.kind-source.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "food date value and provenance match its kind",
  },
  {
    id: "quantity.approximate.scale.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "approximate number has at most six decimal places",
  },
  {
    id: "quantity.approximate.amount-unit-pair.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "approximate amount and unit appear together",
  },
  {
    id: "quantity.non-empty.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "quantity does not represent empty",
  },
  {
    id: "quantity.delta.estimated-scale.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "estimated delta has at most six decimal places",
  },
  {
    id: "quantity.delta.estimated-nonzero.v1",
    sourceKind: "refinement",
    enforcement: "native",
    description: "estimated delta cannot be zero",
    jsonSchemaKeywords: ["not"],
  },
  {
    id: "shopping.item.lifecycle.v1",
    sourceKind: "refinement",
    enforcement: "runtime-only",
    description: "shopping status, purchase facts and lots are consistent",
  },
  {
    id: "quantity.exact.positive.v1",
    sourceKind: "native-schema",
    enforcement: "native",
    description: "initial and consumed exact amounts are strictly positive",
    jsonSchemaKeywords: ["pattern"],
  },
  {
    id: "quantity.delta.exact-nonzero.v1",
    sourceKind: "native-schema",
    enforcement: "native",
    description: "exact quantity delta cannot be mathematical zero",
    jsonSchemaKeywords: ["pattern"],
  },
] as const satisfies readonly ContractRule[];
