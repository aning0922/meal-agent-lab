import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

const output = fileURLToPath(
  new URL("../openapi/stage-06.openapi.json", import.meta.url),
);
const committed: unknown = JSON.parse(await readFile(output, "utf8"));
assert.deepEqual(committed, generated);
