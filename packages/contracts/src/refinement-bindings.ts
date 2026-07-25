// Importing public schema modules evaluates their definition-local rule helpers.
// The resulting registry is therefore derived from actual schema metadata rather
// than maintained as a second hand-written boundary map.
import "./api.js";
import "./identity.js";
import "./inventory.js";
import "./meals.js";
import "./members.js";
import "./primitives.js";
import "./shopping.js";

import {
  getContractRuleSchemaBindings,
  validateContractRuleSchemaBindings,
  type ContractRuleSchemaBinding,
} from "./contract-rule-schema.js";

export type { ContractRuleSchemaBinding };

export type ContractRuleBinding = Omit<
  ContractRuleSchemaBinding,
  "schema"
>;

export const contractRuleSchemaBindings =
  getContractRuleSchemaBindings();

validateContractRuleSchemaBindings(contractRuleSchemaBindings);

/** 可序列化到 OpenAPI 根扩展的逐 boundary binding。 */
export const contractRuleBindings: readonly ContractRuleBinding[] =
  contractRuleSchemaBindings.map(({ boundary, ruleIds }) => ({
    boundary,
    ruleIds,
  }));

export { validateContractRuleSchemaBindings };
