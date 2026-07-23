import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { OpenAPIV3 } from "openapi-types";

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
] as const;

const generated = await generateOpenApiDocument();
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
assert.equal(consumedRequest.includes('"exact"'), true);
assert.equal(consumedRequest.includes('"approximate"'), false);
assert.equal(consumedRequest.includes('"multipleOf":0.000001'), true);
assert.equal(
  consumedRequest.includes("without floating-point tolerance"),
  true,
);
assert.equal(
  consumedRequest.includes('"maximum":999999999.999999'),
  true,
);
for (const status of ["413", "415"]) {
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
assert.equal(
  consumedResponse.includes(
    "consumed result requires a consistent exact negative event",
  ),
  true,
);

const output = fileURLToPath(
  new URL("../openapi/stage-06.openapi.json", import.meta.url),
);
const committed: unknown = JSON.parse(await readFile(output, "utf8"));
assert.deepEqual(committed, generated);
