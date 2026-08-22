import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { stage06Adapters } from "./stage06-manifest-adapter.js";

/**
 * 阶段 09A / M2A：开发期 generator。
 *
 * 只在开发机/CI 上运行，把 TypeScript manifest 渲染出的 adapter 写进 tracked 的
 * generated 目录。PostgreSQL 服务器进程不执行 Node，`bootstrap.sh` 的 SQL 阶段
 * 也只调用 psql，因此必须提前生成。
 *
 * 该命令**会覆盖** tracked 文件，因此它不是门禁；门禁是只读的 `manifest:check`。
 */

if (process.argv.slice(2).length > 0) {
  throw new Error(
    "manifest:generate takes no arguments; its output paths are fixed",
  );
}

for (const adapter of stage06Adapters) {
  const rendered = adapter.render();
  await mkdir(dirname(adapter.absolutePath), { recursive: true });
  await writeFile(adapter.absolutePath, rendered, "utf8");
  process.stdout.write(
    `wrote ${adapter.includePath} ` +
      `(${String(Buffer.byteLength(rendered, "utf8"))} bytes)\n`,
  );
}
