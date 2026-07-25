import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { z } from "zod";

import {
  consumeInventoryLotRequestSchema,
  contractRuleManifest,
  createInventoryLotRequestSchema,
  quantityDeltaSchema,
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

test("every public refine/superRefine is classified by a stable rule id", async () => {
  let sourceCount = 0;
  for (const name of refinementSources) {
    const source = await readFile(
      new URL(`../src/${name}`, import.meta.url),
      "utf8",
    );
    sourceCount +=
      source.match(/\.(?:superRefine|refine)\s*\(/g)?.length ?? 0;
  }
  const refinementRules = contractRuleManifest.filter(
    (rule) => rule.sourceKind === "refinement",
  );
  assert.equal(sourceCount, 32);
  assert.equal(refinementRules.length, sourceCount);
  assert.equal(
    new Set(contractRuleManifest.map((rule) => rule.id)).size,
    contractRuleManifest.length,
  );
  for (const rule of contractRuleManifest) {
    assert.match(rule.id, /^[a-z0-9.-]+\.v\d+$/);
    assert.ok(rule.boundary.length > 0);
    if (rule.enforcement === "native") {
      assert.ok((rule.jsonSchemaKeywords?.length ?? 0) > 0);
    }
  }
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
