import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { createContractRuleSchemaRegistry } from "../src/contract-rule-registry.js";
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
  "inventory-v2.ts",
  "meals.ts",
  "members.ts",
  "primitives.ts",
  "shopping.ts",
  "seasoning-v1.ts",
] as const;

test("contract rule registry instances do not share registrations", () => {
  const firstManifest = [
    {
      id: "test.first.non-empty.v1",
      sourceKind: "refinement",
      enforcement: "runtime-only",
      description: "first value is non-empty",
    },
  ] as const;
  const secondManifest = [
    {
      id: "test.second.non-empty.v1",
      sourceKind: "refinement",
      enforcement: "runtime-only",
      description: "second value is non-empty",
    },
  ] as const;
  const first = createContractRuleSchemaRegistry(firstManifest);
  const second = createContractRuleSchemaRegistry(secondManifest);

  first.ruleRefine(
    z.string(),
    "test.first.non-empty.v1",
    "firstSchema",
    (value) => value.length > 0,
  );
  second.ruleRefine(
    z.string(),
    "test.second.non-empty.v1",
    "secondSchema",
    (value) => value.length > 0,
  );

  const firstBindings = first.getContractRuleSchemaBindings();
  const secondBindings = second.getContractRuleSchemaBindings();
  first.validateContractRuleSchemaBindings(firstBindings);
  second.validateContractRuleSchemaBindings(secondBindings);
  assert.deepEqual(firstBindings.map(({ boundary }) => boundary), ["firstSchema"]);
  assert.deepEqual(secondBindings.map(({ boundary }) => boundary), ["secondSchema"]);
  assert.throws(
    () =>
      first.ruleRefine(
        z.string(),
        "test.second.non-empty.v1" as never,
        "crossScopeSchema",
        () => true,
      ),
    /unknown contract rule/,
  );
  assert.throws(
    () =>
      createContractRuleSchemaRegistry([
        firstManifest[0],
        firstManifest[0],
      ]),
    /registered more than once in the rule manifest/,
  );
});

test("root registration sources do not import or contain M2 registries", async () => {
  const indexSource = await readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  const bindingSource = await readFile(
    new URL("../src/refinement-bindings.ts", import.meta.url),
    "utf8",
  );
  const manifestSource = await readFile(
    new URL("../src/refinement-rules.ts", import.meta.url),
    "utf8",
  );
  for (const [name, source] of [
    ["index.ts", indexSource],
    ["refinement-bindings.ts", bindingSource],
  ] as const) {
    assert.doesNotMatch(source, /["']\.\/(?:inventory-v2|seasoning-v1)\.js["']/u, name);
  }
  assert.doesNotMatch(manifestSource, /(?:inventory\.v2|seasoning\.v1)\./u);
});

test("root registry is invariant when either M2 subpath is imported first", () => {
  const rootUrl = new URL("../src/index.ts", import.meta.url).href;
  const inventoryUrl = new URL("../src/inventory-v2.ts", import.meta.url).href;
  const seasoningUrl = new URL("../src/seasoning-v1.ts", import.meta.url).href;
  const orders = [
    [rootUrl],
    [inventoryUrl, rootUrl],
    [seasoningUrl, rootUrl],
    [rootUrl, inventoryUrl],
    [rootUrl, seasoningUrl],
    [inventoryUrl, seasoningUrl, rootUrl],
    [seasoningUrl, inventoryUrl, rootUrl],
  ] as const;

  for (const order of orders) {
    const source = `
      const rootUrl = ${JSON.stringify(rootUrl)};
      let root;
      for (const url of ${JSON.stringify(order)}) {
        const loaded = await import(url);
        if (url === rootUrl) root = loaded;
      }
      root ??= await import(rootUrl);
      const boundIds = root.contractRuleBindings.flatMap((binding) => binding.ruleIds);
      process.stdout.write(JSON.stringify({
        manifest: root.contractRuleManifest.length,
        bindings: root.contractRuleSchemaBindings.length,
        boundIds: boundIds.length,
        hasM2Rule: root.contractRuleManifest.some((rule) => /^(?:inventory\\.v2|seasoning\\.v1)\\./u.test(rule.id)),
        hasM2Binding: boundIds.some((id) => /^(?:inventory\\.v2|seasoning\\.v1)\\./u.test(id)),
        hasInventorySchema: "inventoryLotV2Schema" in root,
        hasSeasoningSchema: "seasoningProjectionV1Schema" in root,
        hasInventoryRegistry: "inventoryV2ContractRuleManifest" in root,
        hasSeasoningRegistry: "seasoningV1ContractRuleManifest" in root,
      }));
    `;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
      },
    );
    assert.equal(
      child.status,
      0,
      `order ${order.join(" -> ")} failed: ${child.stderr}`,
    );
    assert.deepEqual(JSON.parse(child.stdout), {
      manifest: 35,
      bindings: 34,
      boundIds: 35,
      hasM2Rule: false,
      hasM2Binding: false,
      hasInventorySchema: false,
      hasSeasoningSchema: false,
      hasInventoryRegistry: false,
      hasSeasoningRegistry: false,
    });
  }
});

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
  assert.equal(contractRuleManifest.length, 35);
  assert.equal(contractRuleSchemaBindings.length, 34);
  assert.equal(boundIds.length, 35);
  assert.equal(
    contractRuleManifest.some((rule) =>
      /^(?:inventory\.v2|seasoning\.v1)\./u.test(rule.id)
    ),
    false,
  );
  assert.equal(
    boundIds.some(([id]) =>
      /^(?:inventory\.v2|seasoning\.v1)\./u.test(id)
    ),
    false,
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
          `"x-meal-agent-contract-rule-ids":["${rule.id}"`,
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

test("binding metadata equality rejects extra, missing and reordered IDs", () => {
  const single = contractRuleSchemaBindings.find((binding) => binding.ruleIds.length === 1);
  const multiple = contractRuleSchemaBindings.find((binding) => binding.ruleIds.length > 1);
  assert.notEqual(single, undefined);
  assert.notEqual(multiple, undefined);
  if (single === undefined || multiple === undefined) return;

  const alternate = contractRuleManifest.find((rule) => rule.id !== single.ruleIds[0]);
  assert.notEqual(alternate, undefined);
  if (alternate === undefined) return;

  const replace = (
    target: typeof single,
    schema: typeof single.schema,
  ) => contractRuleSchemaBindings.map((binding) =>
    binding.boundary === target.boundary ? { ...binding, schema } : binding,
  );

  const extra = single.schema.meta({
    ...(single.schema.meta() ?? {}),
    "x-meal-agent-contract-rule-ids": [single.ruleIds[0], alternate.id],
  });
  assert.throws(
    () => validateContractRuleSchemaBindings(replace(single, extra)),
    /metadata rule IDs do not exactly match its binding/,
  );

  const missing = single.schema.meta({
    ...(single.schema.meta() ?? {}),
    "x-meal-agent-contract-rule-ids": [],
  });
  assert.throws(
    () => validateContractRuleSchemaBindings(replace(single, missing)),
    /metadata rule IDs do not exactly match its binding/,
  );

  const duplicated = single.schema.meta({
    ...(single.schema.meta() ?? {}),
    "x-meal-agent-contract-rule-ids": [single.ruleIds[0], single.ruleIds[0]],
  });
  assert.throws(
    () => validateContractRuleSchemaBindings(replace(single, duplicated)),
    /metadata rule IDs do not exactly match its binding/,
  );

  const reordered = multiple.schema.meta({
    ...(multiple.schema.meta() ?? {}),
    "x-meal-agent-contract-rule-ids": [...multiple.ruleIds].reverse(),
  });
  assert.throws(
    () => validateContractRuleSchemaBindings(replace(multiple, reordered)),
    /metadata rule IDs do not exactly match its binding/,
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
