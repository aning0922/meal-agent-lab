import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";

import {
  approximateQuantitySchema,
  contractRuleBindings,
  contractRuleManifest,
  contractRuleSchemaBindings,
  inventoryEventSchema,
  sessionSchema,
} from "@meal-agent/contracts";

import {
  generateOpenApiDocument,
  toOpenApi30,
} from "./openapi.js";

const requiredPaths = [
  "/healthz",
  "/readyz",
  "/api/v1/auth/wechat/exchange",
  "/api/v1/session",
  "/api/v1/me",
  "/api/v1/households",
  "/api/v1/households/{id}/inventory-lots",
  "/api/v1/households/{id}/inventory-lots/{lotId}/events/consumed",
  "/api/v1/households/{id}/invites",
  "/api/v1/households/{id}/invites/{inviteId}",
  "/api/v1/households/join",
  "/api/v1/households/{id}/members",
  "/api/v1/households/{id}/memberships/{membershipId}",
  "/api/v1/households/{id}/person-profiles",
  "/api/v1/households/{id}/person-profiles/{profileId}",
  "/api/v1/households/{id}/person-profiles/{profileId}/dietary-constraints",
  "/api/v1/households/{id}/person-profiles/{profileId}/link-requests",
  "/api/v1/households/{id}/person-profile-link-requests",
  "/api/v1/households/{id}/person-profile-link-requests/{requestId}/confirm",
] as const;

const generated = await generateOpenApiDocument();
await SwaggerParser.validate(generated);

const booleanExclusiveSchema = {
  type: "number",
  minimum: 0,
  exclusiveMinimum: true,
};
assert.deepEqual(
  toOpenApi30(booleanExclusiveSchema),
  booleanExclusiveSchema,
  "existing OpenAPI 3.0 boolean exclusive bounds must be preserved",
);
const numericExclusiveSchema = {
  type: "number",
  exclusiveMinimum: 0,
};
assert.deepEqual(
  toOpenApi30(toOpenApi30(numericExclusiveSchema)),
  toOpenApi30(numericExclusiveSchema),
  "OpenAPI conversion must be idempotent",
);

const dialectViolations: string[] = [];
const inspectDialect = (value: unknown, path = "$"): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      inspectDialect(item, `${path}[${index}]`)
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (key === "const") dialectViolations.push(`${itemPath}: const`);
    if (
      (key === "exclusiveMinimum" ||
        key === "exclusiveMaximum") &&
      typeof item === "number"
    ) {
      dialectViolations.push(`${itemPath}: numeric exclusive bound`);
    }
    if (
      key === "type" &&
      (item === "null" ||
        (Array.isArray(item) && item.includes("null")))
    ) {
      dialectViolations.push(`${itemPath}: null type`);
    }
    inspectDialect(item, itemPath);
  }
};
inspectDialect(generated);
assert.deepEqual(
  dialectViolations,
  [],
  "generated OpenAPI must use only OpenAPI 3.0 schema keywords",
);
assert.equal(generated.info.version, "0.4.0");
assert.deepEqual(
  (
    generated as OpenAPIV3.Document & {
      readonly "x-meal-agent-contract-rules": unknown;
      readonly "x-meal-agent-contract-rule-bindings": unknown;
    }
  )["x-meal-agent-contract-rules"],
  contractRuleManifest,
);
assert.deepEqual(
  (
    generated as OpenAPIV3.Document & {
      readonly "x-meal-agent-contract-rule-bindings": unknown;
    }
  )["x-meal-agent-contract-rule-bindings"],
  contractRuleBindings,
);
const boundRuleIds = contractRuleBindings.flatMap((binding) =>
  binding.ruleIds.map((id) => [id, binding.boundary] as const),
);
assert.deepEqual(
  [...boundRuleIds].map(([id]) => id).sort(),
  contractRuleManifest
    .map((rule) => rule.id)
    .sort(),
);
for (const binding of contractRuleSchemaBindings) {
  const componentName =
    `ContractRule.${binding.boundary}`.replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
  const component = generated.components?.schemas?.[
    componentName
  ];
  assert.notEqual(
    component,
    undefined,
    `${binding.boundary} must have a generated OpenAPI schema node`,
  );
  const componentJson = JSON.stringify(component);
  assert.equal(
    componentJson.includes(
      `"x-meal-agent-rule-boundary":"${binding.boundary}"`,
    ),
    true,
    `${binding.boundary} schema node must retain its definition metadata`,
  );
  for (const id of binding.ruleIds) {
    assert.equal(
      componentJson.includes(`"${id}"`),
      true,
      `${id} must appear on ${binding.boundary}'s OpenAPI schema node`,
    );
  }
}
const generatedJson = JSON.stringify(generated);
for (const nativeRuleId of [
  "quantity.exact.positive.v1",
  "quantity.delta.exact-nonzero.v1",
]) {
  assert.equal(
    generatedJson.includes(`"id":"${nativeRuleId}"`),
    true,
    `OpenAPI must retain native rule ${nativeRuleId}`,
  );
}
assert.equal(
  generatedJson.includes('"id":"quantity.exact.positive"'),
  false,
);
assert.equal(
  generatedJson.includes('"id":"quantity.delta.exact.nonzero"'),
  false,
);
assert.equal(
  generatedJson.includes(
    '"mappingStatus":{"type":"string","enum":["needs_structured_mapping"]',
  ),
  true,
  "hard constraint mappings must remain blocked until authoritative mapping",
);
for (const path of requiredPaths) {
  assert.ok(generated.paths[path] !== undefined, `missing OpenAPI path ${path}`);
}
assert.equal(
  generated.components?.securitySchemes?.["bearerAuth"] === undefined,
  false,
);
assert.equal(
  generated.paths["/api/v1/households"]?.post?.requestBody === undefined,
  false,
);
assert.equal(
  generated.paths[
    "/api/v1/households/{id}/inventory-lots/{lotId}/events/consumed"
  ]?.post?.requestBody === undefined,
  false,
);
const consumedRequest = JSON.stringify(
  generated.paths[
    "/api/v1/households/{id}/inventory-lots/{lotId}/events/consumed"
  ]?.post?.requestBody,
);
const createLotRequest = JSON.stringify(
  generated.paths[
    "/api/v1/households/{id}/inventory-lots"
  ]?.post?.requestBody,
);
const addConstraintRequestObject =
  generated.paths[
    "/api/v1/households/{id}/person-profiles/{profileId}/dietary-constraints"
  ]?.post?.requestBody;
const collectPropertySchemas = (
  value: unknown,
  propertyName: string,
): Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      collectPropertySchemas(item, propertyName)
    );
  }
  if (value === null || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const properties =
    object["properties"] !== null &&
    typeof object["properties"] === "object" &&
    !Array.isArray(object["properties"])
      ? object["properties"] as Record<string, unknown>
      : {};
  const direct =
    properties[propertyName] !== null &&
    typeof properties[propertyName] === "object" &&
    !Array.isArray(properties[propertyName])
      ? [properties[propertyName] as Record<string, unknown>]
      : [];
  return [
    ...direct,
    ...Object.values(object).flatMap((item) =>
      collectPropertySchemas(item, propertyName)
    ),
  ];
};
const openApiNumberAccepts = (
  schema: Record<string, unknown>,
  value: number,
): boolean => {
  if (
    schema["type"] === "integer" &&
    !Number.isInteger(value)
  ) {
    return false;
  }
  if (
    typeof schema["minimum"] === "number" &&
    (
      schema["exclusiveMinimum"] === true
        ? value <= schema["minimum"]
        : value < schema["minimum"]
    )
  ) {
    return false;
  }
  if (
    typeof schema["maximum"] === "number" &&
    (
      schema["exclusiveMaximum"] === true
        ? value >= schema["maximum"]
        : value > schema["maximum"]
    )
  ) {
    return false;
  }
  return true;
};
const componentSchema = (
  name: string,
): Record<string, unknown> => {
  const component = generated.components?.schemas?.[name];
  assert.notEqual(component, undefined, `missing component ${name}`);
  assert.equal("$ref" in component!, false, `${name} must be inline`);
  return component as Record<string, unknown>;
};
const componentProperty = (
  componentName: string,
  propertyName: string,
): Record<string, unknown> => {
  const component = componentSchema(componentName);
  const properties = component["properties"];
  assert.equal(
    properties !== null &&
      typeof properties === "object" &&
      !Array.isArray(properties),
    true,
    `${componentName} must expose properties`,
  );
  const property = (properties as Record<string, unknown>)[propertyName];
  assert.equal(
    property !== null &&
      typeof property === "object" &&
      !Array.isArray(property),
    true,
    `${componentName}.${propertyName} must be a schema`,
  );
  return property as Record<string, unknown>;
};
const zeroBoundaries = [
  {
    name: "approximate amount",
    runtimeAccepts:
      approximateQuantitySchema.shape.amount.safeParse(0).success,
    openApi: componentSchema(
      "ContractRule.approximateQuantitySchema.amount",
    ),
  },
  {
    name: "session tokenVersion",
    runtimeAccepts:
      sessionSchema.shape.tokenVersion.safeParse(0).success,
    openApi: componentProperty(
      "ContractRule.sessionSchema",
      "tokenVersion",
    ),
  },
  {
    name: "inventory event resultingLotVersion",
    runtimeAccepts:
      inventoryEventSchema.shape.resultingLotVersion.safeParse(0).success,
    openApi: componentProperty(
      "ContractRule.inventoryEventSchema",
      "resultingLotVersion",
    ),
  },
] as const;
for (const boundary of zeroBoundaries) {
  assert.equal(
    boundary.runtimeAccepts,
    false,
    `${boundary.name} runtime must reject zero`,
  );
  assert.equal(
    openApiNumberAccepts(boundary.openApi, 0),
    false,
    `${boundary.name} OpenAPI semantics must reject zero`,
  );
}
for (const propertyName of ["foodConceptIds", "allergenCodes"]) {
  const schemas = collectPropertySchemas(
    addConstraintRequestObject,
    propertyName,
  );
  assert.ok(
    schemas.length > 0,
    `${propertyName} must appear in the public request schema`,
  );
  for (const schema of schemas) {
    assert.equal(schema["maxItems"], 100);
    assert.equal(schema["uniqueItems"], true);
  }
}
for (const schema of collectPropertySchemas(
  addConstraintRequestObject,
  "foodConceptIds",
)) {
  assert.equal(
    JSON.stringify(schema).includes(
      "^[0-9a-f]{8}-[0-9a-f]{4}-7",
    ),
    true,
    "food concept UUIDv7 must use the lowercase public pattern",
  );
}
assert.equal(consumedRequest.includes('"exact"'), true);
assert.equal(consumedRequest.includes('"approximate"'), false);
assert.equal(consumedRequest.includes('"type":"string"'), true);
assert.equal(consumedRequest.includes('"multipleOf"'), false);
assert.equal(
  consumedRequest.includes('"id":"quantity.exact.positive.v1"'),
  true,
);
for (const requestSchema of [createLotRequest, consumedRequest]) {
  const patterns = [
    ...requestSchema.matchAll(/"pattern":"((?:\\.|[^"])*)"/g),
  ].map((match) =>
    JSON.parse(`"${match[1] ?? ""}"`) as string
  );
  const positivePattern = patterns.find(
    (pattern) =>
      new RegExp(pattern).test("0.000001") &&
      !new RegExp(pattern).test("0"),
  );
  assert.notEqual(
    positivePattern,
    undefined,
    "exact positive quantity pattern must reject mathematical zero",
  );
}
assert.equal(
  consumedRequest.includes(
    '"x-decimal-maximum":"999999999.999999"',
  ),
  true,
);
for (const status of ["401", "413", "415"]) {
  assert.equal(
    generated.paths["/api/v1/auth/wechat/exchange"]?.post?.responses[
      status
    ] === undefined,
    false,
  );
}

const methods = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
] as const;
for (const pathItem of Object.values(generated.paths)) {
  if (pathItem === undefined) {
    continue;
  }
  for (const method of methods) {
    const operation = pathItem[method] as
      | OpenAPIV3.OperationObject
      | undefined;
    if (operation === undefined) {
      continue;
    }
    const responses = Object.entries(operation.responses) as [
      string,
      OpenAPIV3.ReferenceObject | OpenAPIV3.ResponseObject,
    ][];
    for (const [status, response] of responses) {
      if (Number(status) < 400 || "$ref" in response) {
        continue;
      }
      assert.deepEqual(
        Object.keys(response.content ?? {}),
        ["application/problem+json"],
        `${method.toUpperCase()} error ${status} must use problem+json`,
      );
      assert.equal(
        JSON.stringify(
          response.content?.["application/problem+json"]?.schema,
        ).includes('"x-zod-refinements"'),
        true,
        `${method.toUpperCase()} error ${status} must retain error refinements`,
      );
    }
  }
}

const householdPageResponse = JSON.stringify(
  generated.paths["/api/v1/households"]?.get?.responses["200"],
);
assert.equal(householdPageResponse.includes('"pageInfo"'), true);
assert.equal(householdPageResponse.includes('"oneOf"'), true);

const consumedResponse = JSON.stringify(
  generated.paths[
    "/api/v1/households/{id}/inventory-lots/{lotId}/events/consumed"
  ]?.post?.responses["201"],
);
const createLotResponse = JSON.stringify(
  generated.paths[
    "/api/v1/households/{id}/inventory-lots"
  ]?.post?.responses["201"],
);
assert.equal(
  consumedResponse.includes(
    '"x-meal-agent-runtime-rule-ids":["inventory.consume-result.consistency.v1"]',
  ),
  true,
);
assert.equal(
  createLotResponse.includes(
    '"x-meal-agent-runtime-rule-ids":["inventory.create-result.consistency.v1"]',
  ),
  true,
);
for (const responseSchema of [createLotResponse, consumedResponse]) {
  const patterns = [
    ...responseSchema.matchAll(/"pattern":"((?:\\.|[^"])*)"/g),
  ].map((match) =>
    JSON.parse(`"${match[1] ?? ""}"`) as string
  );
  assert.equal(
    patterns.some(
      (pattern) =>
        new RegExp(pattern).test("-0.000001") &&
        !new RegExp(pattern).test("0") &&
        !new RegExp(pattern).test("-0.0"),
    ),
    true,
    "inventory event exact delta OpenAPI pattern must reject mathematical zero",
  );
  assert.equal(
    responseSchema.includes('"not":{"enum":[0]}'),
    true,
    "inventory event estimated delta OpenAPI schema must reject numeric zero",
  );
}

const output = fileURLToPath(
  new URL("../openapi/stage-08.openapi.json", import.meta.url),
);
const committed: unknown = JSON.parse(await readFile(output, "utf8"));
assert.deepEqual(committed, generated);
