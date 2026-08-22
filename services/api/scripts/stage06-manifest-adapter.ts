import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  renderAuthorizationConvergeAdapter,
  renderAuthorizationVerifyAdapter,
} from "../src/database/authorization-manifest-sql.js";
import { renderAuthorizationProjectionAdapter } from "../src/database/authorization-projection-sql.js";
import { renderStage06ManifestAdapter } from "../src/database/stage06-manifest-sql.js";

/**
 * 阶段 09A / M2A：generated adapter 的登记表与只读门禁。
 *
 * adapter 只有一个用途：让 `psql` 通过相对路径 `\ir` 加载与 TypeScript 侧
 * **逐字节相同**的 SQL。PostgreSQL 服务器进程不执行 Node，`bootstrap.sh` 的
 * SQL 阶段也只调用 `psql`（只有 `logins` 阶段在缺少 `setsid` 时会用仓库内的
 * `no-ctty.mjs` 包装器，那是一个 Node 标准库脚本），因此不能在那里现场渲染；
 * 但也不允许 adapter 独立漂移，所以有本门禁。
 *
 * 门禁是**只读**的：它只比较，不会自动改写 tracked 文件。渲染结果与 tracked 内容
 * 不一致时，必须由人显式重新生成并复核 diff。
 */

export interface Stage06Adapter {
  /** `\ir` 使用的相对路径，同时也是 tracked 文件名。 */
  readonly includePath: string;
  readonly absolutePath: string;
  readonly render: () => string;
}

const generatedFile = (name: string): string =>
  fileURLToPath(
    new URL(
      `../../../infra/docker/postgres/sql/database/generated/${name}`,
      import.meta.url,
    ),
  );

/**
 * 四个 generated adapter：对象 manifest、授权收敛、授权断言，以及第八轮 A 新增的
 * **只读**授权投影。前三个在本轮保持字节不变。
 */
export const stage06Adapters: readonly Stage06Adapter[] = Object.freeze([
  {
    includePath: "generated/0000-object-manifest.generated.sql",
    absolutePath: generatedFile("0000-object-manifest.generated.sql"),
    render: renderStage06ManifestAdapter,
  },
  {
    includePath: "generated/authorization-converge.generated.sql",
    absolutePath: generatedFile("authorization-converge.generated.sql"),
    render: renderAuthorizationConvergeAdapter,
  },
  {
    includePath: "generated/authorization-verify.generated.sql",
    absolutePath: generatedFile("authorization-verify.generated.sql"),
    render: renderAuthorizationVerifyAdapter,
  },
  {
    includePath: "generated/authorization-projection.generated.sql",
    absolutePath: generatedFile("authorization-projection.generated.sql"),
    render: renderAuthorizationProjectionAdapter,
  },
]);

/** 兼容旧引用：对象 manifest adapter 的路径。 */
export const stage06ManifestAdapterPath = generatedFile(
  "0000-object-manifest.generated.sql",
);
export const stage06ManifestAdapterIncludePath =
  "generated/0000-object-manifest.generated.sql";

export interface Stage06AdapterCheckResult {
  readonly ok: boolean;
  readonly detail: string;
}

const describeFirstDifference = (expected: string, actual: string): string => {
  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && expected[index] === actual[index]) {
    index += 1;
  }
  const line = expected.slice(0, index).split("\n").length;
  return (
    `first difference at character ${String(index)} (line ${String(line)}); ` +
    `rendered ${String(Buffer.byteLength(expected, "utf8"))} bytes, ` +
    `tracked ${String(Buffer.byteLength(actual, "utf8"))} bytes`
  );
};

/**
 * 逐字节比较内存渲染结果与 tracked 文件。
 *
 * 不做任何写入：结果只是 `ok` 与一段可读的差异说明。
 */
export const checkStage06ManifestAdapter = async (
  adapterPath: string = stage06ManifestAdapterPath,
  render: () => string = renderStage06ManifestAdapter,
): Promise<Stage06AdapterCheckResult> => {
  const rendered = render();
  let tracked: string;
  try {
    tracked = await readFile(adapterPath, "utf8");
  } catch {
    return {
      ok: false,
      detail:
        `the generated adapter is missing at ${adapterPath}; ` +
        "run: pnpm --filter @meal-agent/api manifest:generate",
    };
  }
  if (tracked === rendered) {
    return {
      ok: true,
      detail:
        `generated adapter matches byte-for-byte ` +
        `(${String(Buffer.byteLength(rendered, "utf8"))} bytes)`,
    };
  }
  return {
    ok: false,
    detail:
      "the generated adapter does not match the manifest rendered from " +
      "services/api/src/database: " +
      `${describeFirstDifference(rendered, tracked)}. ` +
      "It is a generated file — do not hand-edit it; change the manifest and " +
      "run: pnpm --filter @meal-agent/api manifest:generate",
  };
};

/** 检查全部 adapter，返回逐个结果。 */
export const checkAllStage06Adapters = async (): Promise<
  readonly (Stage06AdapterCheckResult & { readonly includePath: string })[]
> =>
  Promise.all(
    stage06Adapters.map(async (adapter) => ({
      includePath: adapter.includePath,
      ...(await checkStage06ManifestAdapter(
        adapter.absolutePath,
        adapter.render,
      )),
    })),
  );
