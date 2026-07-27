import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { renderStage06ManifestAdapter } from "../src/database/stage06-manifest-sql.js";
import { manifestDigest } from "../src/database/stage06-manifest.js";
import { stage06ManifestAdapterPath } from "./stage06-manifest-adapter.js";

/**
 * 阶段 09A / M2A：开发期 generator。
 *
 * 只在开发机/CI 上运行，把 `stage06-manifest.ts` 渲染出的 adapter 写进 tracked 的
 * generated 目录。PostgreSQL 与 bootstrap 运行时都不执行 Node。
 *
 * 该命令**会覆盖** tracked 文件，因此它不是门禁；门禁是只读的 `manifest:check`。
 */

if (process.argv.slice(2).length > 0) {
  throw new Error(
    "manifest:generate takes no arguments; its output path is fixed",
  );
}

const adapter = renderStage06ManifestAdapter();
await mkdir(dirname(stage06ManifestAdapterPath), { recursive: true });
await writeFile(stage06ManifestAdapterPath, adapter, "utf8");
process.stdout.write(
  `wrote ${String(adapter.length)} bytes; canonical manifest digest sha256:${manifestDigest()}\n`,
);
