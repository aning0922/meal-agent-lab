import type { z } from "zod";

import type { ContractRule } from "./refinement-rules.js";

export type ContractRuleSchemaBinding<
  Id extends string = string,
> = {
  readonly boundary: string;
  readonly ruleIds: readonly Id[];
  readonly schema: z.ZodType;
};

export type ContractRuleSchemaRegistry<Id extends string> = {
  readonly ruleRefine: <T extends z.ZodType>(
    schema: T,
    id: Id,
    boundary: string,
    check: Parameters<T["refine"]>[0],
    params?: Parameters<T["refine"]>[1],
  ) => T;
  readonly ruleSuperRefine: <T extends z.ZodType>(
    schema: T,
    id: Id,
    boundary: string,
    check: Parameters<T["superRefine"]>[0],
  ) => T;
  readonly bindNativeContractRule: <T extends z.ZodType>(
    schema: T,
    id: Id,
    boundary: string,
  ) => T;
  readonly getContractRuleSchemaBindings: (
  ) => readonly ContractRuleSchemaBinding<Id>[];
  readonly validateContractRuleSchemaBindings: (
    bindings: readonly ContractRuleSchemaBinding<Id>[],
  ) => void;
};

/**
 * Creates one isolated registration scope. Each manifest owns its own maps, so
 * evaluating schemas from another package subpath cannot change this scope's
 * bindings or make its result depend on module import order.
 */
export const createContractRuleSchemaRegistry = <
  const Manifest extends readonly ContractRule[],
>(
  manifest: Manifest,
): ContractRuleSchemaRegistry<Manifest[number]["id"]> => {
  type Id = Manifest[number]["id"];

  const rulesById = new Map<string, ContractRule>();
  for (const rule of manifest) {
    if (rulesById.has(rule.id)) {
      throw new Error(`${rule.id} is registered more than once in the rule manifest`);
    }
    rulesById.set(rule.id, rule);
  }

  const schemaBindings = new Map<
    string,
    {
      readonly boundary: string;
      readonly ruleIds: Id[];
      schema: z.ZodType;
    }
  >();

  const attachRule = <T extends z.ZodType>(
    schema: T,
    id: Id,
    boundary: string,
  ): T => {
    const rule = rulesById.get(id);
    if (rule === undefined) {
      throw new Error(`unknown contract rule: ${id}`);
    }
    const metadata = schema.meta() ?? {};
    const existingIds = Array.isArray(
      metadata["x-meal-agent-contract-rule-ids"],
    )
      ? (metadata["x-meal-agent-contract-rule-ids"] as Id[])
      : [];
    const next = schema.meta({
      ...metadata,
      "x-meal-agent-contract-rule-ids": [
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

  const ruleRefine = <T extends z.ZodType>(
    schema: T,
    id: Id,
    boundary: string,
    check: Parameters<T["refine"]>[0],
    params?: Parameters<T["refine"]>[1],
  ): T =>
    attachRule(
      schema.refine(check as never, params as never) as T,
      id,
      boundary,
    );

  const ruleSuperRefine = <T extends z.ZodType>(
    schema: T,
    id: Id,
    boundary: string,
    check: Parameters<T["superRefine"]>[0],
  ): T =>
    attachRule(
      schema.superRefine(check as never) as T,
      id,
      boundary,
    );

  const bindNativeContractRule = <T extends z.ZodType>(
    schema: T,
    id: Id,
    boundary: string,
  ): T => attachRule(schema, id, boundary);

  const getContractRuleSchemaBindings = (
  ): readonly ContractRuleSchemaBinding<Id>[] =>
    [...schemaBindings.values()]
      .map((binding) => ({
        boundary: binding.boundary,
        ruleIds: [...binding.ruleIds],
        schema: binding.schema,
      }))
      .sort((left, right) =>
        left.boundary.localeCompare(right.boundary)
      );

  const validateContractRuleSchemaBindings = (
    bindings: readonly ContractRuleSchemaBinding<Id>[],
  ): void => {
    const seen = new Set<string>();
    const seenBoundaries = new Set<string>();
    for (const binding of bindings) {
      if (seenBoundaries.has(binding.boundary)) {
        throw new Error(`${binding.boundary} is registered more than once`);
      }
      seenBoundaries.add(binding.boundary);
      const metadata = binding.schema.meta() ?? {};
      const actualIds = metadata["x-meal-agent-contract-rule-ids"];
      const actualBoundary = metadata["x-meal-agent-rule-boundary"];
      if (!Array.isArray(actualIds)) {
        throw new Error(`${binding.boundary} has no rule metadata`);
      }
      if (actualBoundary !== binding.boundary) {
        throw new Error(
          `${binding.boundary} does not match schema metadata ${String(actualBoundary)}`,
        );
      }
      const actualStrings = actualIds.map(String);
      const expectedStrings = binding.ruleIds.map(String);
      if (
        actualStrings.length !== expectedStrings.length ||
        actualStrings.some((id, index) => id !== expectedStrings[index])
      ) {
        throw new Error(
          `${binding.boundary} metadata rule IDs do not exactly match its binding`,
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
    for (const rule of manifest) {
      if (!seen.has(rule.id)) {
        throw new Error(`${rule.id} has no schema binding`);
      }
    }
  };

  return {
    ruleRefine,
    ruleSuperRefine,
    bindNativeContractRule,
    getContractRuleSchemaBindings,
    validateContractRuleSchemaBindings,
  };
};
