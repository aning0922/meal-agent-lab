import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { OpenAPIV3 } from "openapi-types";

import { contractRuleManifest } from "@meal-agent/contracts";

import { generateOpenApiDocument } from "./openapi.js";

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
assert.equal(generated.info.version, "0.4.0");
assert.deepEqual(
  (
    generated as OpenAPIV3.Document & {
      readonly "x-meal-agent-contract-rules": unknown;
    }
  )["x-meal-agent-contract-rules"],
  contractRuleManifest,
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
assert.equal(consumedRequest.includes('"exact"'), true);
assert.equal(consumedRequest.includes('"approximate"'), false);
assert.equal(consumedRequest.includes('"type":"string"'), true);
assert.equal(consumedRequest.includes('"multipleOf"'), false);
assert.equal(
  consumedRequest.includes('"id":"quantity.exact.positive"'),
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
    "consumed result requires a consistent exact negative event",
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
