import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { generateOpenApiDocument } from "./openapi.js";

const output = fileURLToPath(
  new URL("../openapi/stage-08.openapi.json", import.meta.url),
);
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `${JSON.stringify(await generateOpenApiDocument(), null, 2)}\n`,
  "utf8",
);
