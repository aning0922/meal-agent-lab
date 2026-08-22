import type { OpenAPIV3 } from "openapi-types";
import { contractRuleSchemaBindings } from "@meal-agent/contracts";
import { z } from "zod";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Zod 4 emits JSON Schema 2020-12 while the service publishes OpenAPI 3.0.3.
 * Convert the small set of dialect differences instead of asserting the
 * incompatible output into an OpenAPIV3 type.
 */
export const toOpenApi30 = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(toOpenApi30);
  }
  if (!isObject(value)) {
    return value;
  }

  const source = { ...value };
  delete source["$schema"];
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(source)) {
    if (
      key === "const" ||
      ((key === "exclusiveMinimum" || key === "exclusiveMaximum") &&
        typeof item === "number") ||
      key === "anyOf"
    ) {
      continue;
    }
    output[key] = toOpenApi30(item);
  }

  if ("const" in source) {
    output["enum"] = [toOpenApi30(source["const"])];
  }
  if (typeof source["exclusiveMinimum"] === "number") {
    output["minimum"] = source["exclusiveMinimum"];
    output["exclusiveMinimum"] = true;
  }
  if (typeof source["exclusiveMaximum"] === "number") {
    output["maximum"] = source["exclusiveMaximum"];
    output["exclusiveMaximum"] = true;
  }

  if (Array.isArray(source["type"])) {
    const types = source["type"].filter((item) => item !== "null");
    if (types.length !== source["type"].length) {
      output["nullable"] = true;
    }
    output["type"] = types.length === 1 ? types[0] : types;
  }

  if (Array.isArray(source["anyOf"])) {
    const nonNull = source["anyOf"].filter(
      (item) => !(isObject(item) && item["type"] === "null"),
    );
    if (nonNull.length !== source["anyOf"].length) {
      if (nonNull.length === 1 && isObject(nonNull[0])) {
        const converted = toOpenApi30(nonNull[0]);
        if (!isObject(converted)) {
          throw new Error("nullable schema branch is not an object");
        }
        Object.assign(output, converted, { nullable: true });
      } else {
        output["anyOf"] = nonNull.map((item) => {
          const converted = toOpenApi30(item);
          return isObject(converted)
            ? { ...converted, nullable: true }
            : converted;
          });
      }
    } else {
      output["anyOf"] = source["anyOf"].map(toOpenApi30);
    }
  }

  if (output["type"] === "null") {
    throw new Error("standalone JSON Schema null type cannot be OpenAPI 3.0");
  }
  return output;
};

export const generateOpenApiDocument =
  async (): Promise<OpenAPIV3.Document> => {
    const config = loadConfig({
      NODE_ENV: "test",
      DEPLOYMENT_STAGE: "local-test",
      DEPLOYMENT_EXPOSURE: "loopback",
      HOST: "127.0.0.1",
      PORT: "3000",
      LOG_LEVEL: "silent",
      DATABASE_URL:
        "postgresql://openapi:synthetic-not-a-real-password@openapi.invalid:5432/meal_agent",
      DATABASE_APP_ROLE: "meal_agent_app",
      WECHAT_ADAPTER: "fake",
      SESSION_ABSOLUTE_TTL_DAYS: "30",
      SESSION_IDLE_TTL_DAYS: "7",
    });
    const app = await buildApp({ config });
    try {
      await app.ready();
      const document = app.swagger() as OpenAPIV3.Document;
      const schemas = document.components?.schemas ?? {};
      for (const binding of contractRuleSchemaBindings) {
        const componentName =
          `ContractRule.${binding.boundary}`.replace(
            /[^A-Za-z0-9._-]/g,
            "_",
          );
        const {
          $schema: _schemaDialect,
          ...schema
        } = z.toJSONSchema(binding.schema);
        schemas[componentName] = toOpenApi30(
          schema,
        ) as OpenAPIV3.SchemaObject;
      }
      document.components = {
        ...document.components,
        schemas,
      };
      return toOpenApi30(document) as OpenAPIV3.Document;
    } finally {
      await app.close();
    }
  };
