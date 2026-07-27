import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { renderStage06ManifestAdapter } from "../src/database/stage06-manifest-sql.js";

/**
 * 阶段 09A / M2A：generated manifest adapter 的路径与只读门禁。
 *
 * adapter 只有一个用途：让 `psql`（bootstrap 的 owner handoff）通过相对路径
 * `\ir` 加载与 TypeScript 侧**逐字节相同**的检查 SQL。PostgreSQL 与 bootstrap
 * 运行时都不执行 Node，因此不能在那里现场渲染；但也不允许 adapter 独立漂移，
 * 所以有本门禁。
 *
 * 门禁是**只读**的：它只比较，不会自动改写 tracked 文件。渲染结果与 tracked 内容
 * 不一致时，必须由人显式重新生成并复核 diff。
 */

/** tracked 的 generated adapter。相对路径，避免把本机绝对路径写进任何产物。 */
export const stage06ManifestAdapterPath = fileURLToPath(
  new URL(
    "../../../infra/docker/postgres/sql/database/generated/" +
      "0000-object-manifest.generated.sql",
    import.meta.url,
  ),
);

/** 供 `01-owner-handoff.sql` 使用的 `\ir` 相对路径，文档与测试共用同一常量。 */
export const stage06ManifestAdapterIncludePath =
  "generated/0000-object-manifest.generated.sql";

export interface Stage06AdapterCheckResult {
  readonly ok: boolean;
  readonly detail: string;
}

const describeFirstDifference = (
  expected: string,
  actual: string,
): string => {
  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && expected[index] === actual[index]) {
    index += 1;
  }
  const line = expected.slice(0, index).split("\n").length;
  return (
    `first difference at byte ${String(index)} (line ${String(line)}); ` +
    `rendered length ${String(expected.length)}, ` +
    `tracked length ${String(actual.length)}`
  );
};

/**
 * 逐字节比较内存渲染结果与 tracked 文件。
 *
 * 不做任何写入：结果只是 `ok` 与一段可读的差异说明。
 */
export const checkStage06ManifestAdapter = async (
  adapterPath: string = stage06ManifestAdapterPath,
): Promise<Stage06AdapterCheckResult> => {
  const rendered = renderStage06ManifestAdapter();
  let tracked: string;
  try {
    tracked = await readFile(adapterPath, "utf8");
  } catch {
    return {
      ok: false,
      detail:
        `the generated manifest adapter is missing at ${adapterPath}; ` +
        "run: pnpm --filter @meal-agent/api manifest:generate",
    };
  }
  if (tracked === rendered) {
    return {
      ok: true,
      detail: `generated manifest adapter matches byte-for-byte (${String(rendered.length)} bytes)`,
    };
  }
  return {
    ok: false,
    detail:
      "the generated manifest adapter does not match the manifest rendered " +
      "from services/api/src/database/stage06-manifest.ts: " +
      `${describeFirstDifference(rendered, tracked)}. ` +
      "It is a generated file — do not hand-edit it; change the manifest and " +
      "run: pnpm --filter @meal-agent/api manifest:generate",
  };
};
