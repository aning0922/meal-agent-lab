import type { OpenAPIV3 } from "openapi-types";
import { contractRuleSchemaBindings } from "@meal-agent/contracts";
import { z } from "zod";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

export const generateOpenApiDocument =
  async (): Promise<OpenAPIV3.Document> => {
    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "3000",
      LOG_LEVEL: "silent",
      DATABASE_URL: "postgresql://openapi.invalid/meal_agent",
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
        schemas[componentName] =
          schema as OpenAPIV3.SchemaObject;
      }
      document.components = {
        ...document.components,
        schemas,
      };
      return document;
    } finally {
      await app.close();
    }
  };
