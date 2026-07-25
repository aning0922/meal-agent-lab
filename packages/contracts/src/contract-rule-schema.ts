import { z } from "zod";

import {
  contractRuleManifest,
  type ContractRule,
} from "./refinement-rules.js";

export type ContractRuleId =
  (typeof contractRuleManifest)[number]["id"];

export type ContractRuleSchemaBinding = {
  readonly boundary: string;
  readonly ruleIds: readonly ContractRuleId[];
  readonly schema: z.ZodType;
};

const rulesById = new Map<string, ContractRule>(
  contractRuleManifest.map((rule) => [rule.id, rule]),
);
const schemaBindings = new Map<
  string,
  {
    readonly boundary: string;
    readonly ruleIds: ContractRuleId[];
    schema: z.ZodType;
  }
>();

const attachRule = <T extends z.ZodType>(
  schema: T,
  id: ContractRuleId,
  boundary: string,
): T => {
  const rule = rulesById.get(id);
  if (rule === undefined) {
    throw new Error(`unknown contract rule: ${id}`);
  }
  const metadata = schema.meta() ?? {};
  const existingIds = Array.isArray(
    metadata["x-meal-agent-runtime-rule-ids"],
  )
    ? (metadata[
        "x-meal-agent-runtime-rule-ids"
      ] as ContractRuleId[])
    : [];
  const next = schema.meta({
    ...metadata,
    "x-meal-agent-runtime-rule-ids": [
      ...new Set([...existingIds, id]),
    ],
    "x-zod-refinements": [
      ...new Set([
        ...(Array.isArray(metadata["x-zod-refinements"])
          ? (metadata["x-zod-refinements"] as string[])
          : []),
        rule.description,
      ]),
    ],
    "x-meal-agent-rule-boundary": boundary,
  }) as T;
  const binding = schemaBindings.get(boundary);
  if (binding === undefined) {
    schemaBindings.set(boundary, {
      boundary,
      ruleIds: [id],
      schema: next,
    });
  } else {
    if (!binding.ruleIds.includes(id)) binding.ruleIds.push(id);
    binding.schema = next;
  }
  return next;
};

export const ruleRefine = <T extends z.ZodType>(
  schema: T,
  id: ContractRuleId,
  boundary: string,
  check: Parameters<T["refine"]>[0],
  params?: Parameters<T["refine"]>[1],
): T =>
  attachRule(
    schema.refine(check as never, params as never) as T,
    id,
    boundary,
  );

export const ruleSuperRefine = <T extends z.ZodType>(
  schema: T,
  id: ContractRuleId,
  boundary: string,
  check: Parameters<T["superRefine"]>[0],
): T =>
  attachRule(
    schema.superRefine(check as never) as T,
    id,
    boundary,
  );

export const bindNativeContractRule = <T extends z.ZodType>(
  schema: T,
  id: ContractRuleId,
  boundary: string,
): T => attachRule(schema, id, boundary);

export const getContractRuleSchemaBindings = (
): readonly ContractRuleSchemaBinding[] =>
  [...schemaBindings.values()]
    .map((binding) => ({
      boundary: binding.boundary,
      ruleIds: [...binding.ruleIds],
      schema: binding.schema,
    }))
    .sort((left, right) =>
      left.boundary.localeCompare(right.boundary)
    );

export const validateContractRuleSchemaBindings = (
  bindings: readonly ContractRuleSchemaBinding[],
): void => {
  const seen = new Set<string>();
  for (const binding of bindings) {
    const metadata = binding.schema.meta() ?? {};
    const actualIds =
      metadata["x-meal-agent-runtime-rule-ids"];
    const actualBoundary =
      metadata["x-meal-agent-rule-boundary"];
    if (!Array.isArray(actualIds)) {
      throw new Error(`${binding.boundary} has no rule metadata`);
    }
    if (actualBoundary !== binding.boundary) {
      throw new Error(
        `${binding.boundary} does not match schema metadata ${String(actualBoundary)}`,
      );
    }
    for (const id of binding.ruleIds) {
      const rule = rulesById.get(id);
      if (rule === undefined) {
        throw new Error(`${id} is not in the rule manifest`);
      }
      if (!actualIds.includes(id)) {
        throw new Error(
          `${binding.boundary} metadata does not contain ${id}`,
        );
      }
      if (seen.has(id)) {
        throw new Error(`${id} is bound more than once`);
      }
      seen.add(id);
    }
  }
  for (const rule of contractRuleManifest) {
    if (!seen.has(rule.id)) {
      throw new Error(`${rule.id} has no schema binding`);
    }
  }
};
