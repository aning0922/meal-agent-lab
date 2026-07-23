import type { OpenAPIV3 } from "openapi-types";

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
      return app.swagger() as OpenAPIV3.Document;
    } finally {
      await app.close();
    }
  };
