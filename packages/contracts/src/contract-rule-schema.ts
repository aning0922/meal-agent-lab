import {
  createContractRuleSchemaRegistry,
  type ContractRuleSchemaBinding as ScopedContractRuleSchemaBinding,
} from "./contract-rule-registry.js";
import { contractRuleManifest } from "./refinement-rules.js";

export type ContractRuleId =
  (typeof contractRuleManifest)[number]["id"];

export type ContractRuleSchemaBinding =
  ScopedContractRuleSchemaBinding<ContractRuleId>;

const legacyContractRuleSchemaRegistry =
  createContractRuleSchemaRegistry(contractRuleManifest);

export const ruleRefine =
  legacyContractRuleSchemaRegistry.ruleRefine;
export const ruleSuperRefine =
  legacyContractRuleSchemaRegistry.ruleSuperRefine;
export const bindNativeContractRule =
  legacyContractRuleSchemaRegistry.bindNativeContractRule;
export const getContractRuleSchemaBindings =
  legacyContractRuleSchemaRegistry.getContractRuleSchemaBindings;
export const validateContractRuleSchemaBindings =
  legacyContractRuleSchemaRegistry.validateContractRuleSchemaBindings;
