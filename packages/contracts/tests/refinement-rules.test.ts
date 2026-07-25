import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { z } from "zod";

import {
  consumeInventoryLotRequestSchema,
  contractRuleBindings,
  contractRuleManifest,
  contractRuleSchemaBindings,
  createInventoryLotRequestSchema,
  exactQuantityAmountSchema,
  quantityDeltaSchema,
  validateContractRuleSchemaBindings,
} from "../src/index.js";

const refinementSources = [
  "api.ts",
  "identity.ts",
  "inventory.ts",
  "meals.ts",
  "members.ts",
  "primitives.ts",
  "shopping.ts",
] as const;

test("every public refinement uses the rule helper and actual schema metadata is the only binding source", async () => {
  for (const name of refinementSources) {
    const source = await readFile(
      new URL(`../src/${name}`, import.meta.url),
      "utf8",
    );
    assert.equal(
      source.match(/\.(?:superRefine|refine)\s*\(/g)?.length ?? 0,
      0,
      `${name} must not bypass the rule helper`,
    );
  }
  validateContractRuleSchemaBindings(contractRuleSchemaBindings);
  const boundIds = contractRuleBindings.flatMap((binding) =>
    binding.ruleIds.map((id) => [id, binding.boundary] as const),
  );
  assert.equal(boundIds.length, contractRuleManifest.length);
  assert.equal(new Set(boundIds.map(([id]) => id)).size, boundIds.length);
  assert.deepEqual(
    [...boundIds].map(([id]) => id).sort(),
    contractRuleManifest
      .map((rule) => rule.id)
      .sort(),
  );
  assert.deepEqual(
    contractRuleSchemaBindings.map(({ boundary, ruleIds }) => ({
      boundary,
      ruleIds,
    })),
    contractRuleBindings,
  );
  assert.equal(
    new Set(contractRuleManifest.map((rule) => rule.id)).size,
    contractRuleManifest.length,
  );
  for (const rule of contractRuleManifest) {
    assert.match(rule.id, /^[a-z0-9.-]+\.v\d+$/);
    if (rule.enforcement === "native") {
      assert.ok((rule.jsonSchemaKeywords?.length ?? 0) > 0);
    }
  }
  for (const binding of contractRuleSchemaBindings) {
    const generated = JSON.stringify(z.toJSONSchema(binding.schema));
    const boundRules = binding.ruleIds.map((id) => {
      const rule = contractRuleManifest.find((candidate) => candidate.id === id);
      assert.notEqual(rule, undefined, `${id} must exist in the manifest`);
      return rule!;
    });
    assert.equal(
      typeof binding.schema.safeParse,
      "function",
      `${binding.boundary} must bind an actual runtime schema`,
    );
    for (const rule of boundRules.filter(
      () => true,
    )) {
      assert.equal(
        generated.includes(
          `"x-meal-agent-runtime-rule-ids":["${rule.id}"`,
        ) ||
          generated.includes(`"${rule.id}"`),
        true,
        `${binding.boundary} must embed rule ${rule.id}`,
      );
    }
  }
});

test("a deliberately wrong schema-boundary pairing fails closed", () => {
  const original = contractRuleSchemaBindings[0];
  assert.notEqual(original, undefined);
  assert.throws(
    () =>
      validateContractRuleSchemaBindings([
        {
          ...original!,
          boundary: "deliberatelyWrongSchema",
        },
        ...contractRuleSchemaBindings.slice(1),
      ]),
    /does not match schema metadata/,
  );
});

test("positive and nonzero quantity boundaries agree at runtime and generated JSON Schema", () => {
  const initial = (amount: string) =>
    createInventoryLotRequestSchema.safeParse({
      displayName: "测试食材",
      storageLocation: "refrigerated",
      initialQuantity: { kind: "exact", amount, unit: "kg" },
      dates: [],
    }).success;
  const consumed = (amount: string) =>
    consumeInventoryLotRequestSchema.safeParse({
      consumedQuantity: { kind: "exact", amount, unit: "kg" },
      expectedVersion: 1,
    }).success;
  for (const zero of ["0", "0.0", "0.000000"]) {
    assert.equal(
      exactQuantityAmountSchema.safeParse(zero).success,
      true,
      "lot currentQuantity may be zero",
    );
    assert.equal(initial(zero), false);
    assert.equal(consumed(zero), false);
    assert.equal(
      quantityDeltaSchema.safeParse({
        kind: "numeric",
        amount: zero,
        unit: "kg",
        precision: "exact",
      }).success,
      false,
    );
  }
  assert.equal(initial("0.000001"), true);
  assert.equal(consumed("1"), true);
  assert.equal(
    quantityDeltaSchema.safeParse({
      kind: "numeric",
      amount: 0,
      unit: "kg",
      precision: "estimated",
      confidence: "high",
      originalText: "零",
    }).success,
    false,
  );

  const initialJson = JSON.stringify(
    z.toJSONSchema(createInventoryLotRequestSchema),
  );
  const consumeJson = JSON.stringify(
    z.toJSONSchema(consumeInventoryLotRequestSchema),
  );
  const deltaJson = JSON.stringify(z.toJSONSchema(quantityDeltaSchema));
  for (const generated of [initialJson, consumeJson]) {
    assert.match(generated, /\(\?!0/);
  }
  assert.match(deltaJson, /\(\?!-\?0/);
  assert.match(deltaJson, /"not":\{"const":0\}/);
});
