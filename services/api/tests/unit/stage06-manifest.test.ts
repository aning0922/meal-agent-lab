import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  renderStage06CatalogProjectionSql,
  renderStage06ManifestAdapter,
  renderStage06ManifestCheckSql,
} from "../../src/database/stage06-manifest-sql.js";
import {
  canonicalManifestRows,
  canonicalManifestText,
  handoffPendingKeys,
  managedSchemas,
  manifestDigest,
  Stage06ManifestError,
  stage06ManifestVersion,
  stage06SecurityManifest,
  type Stage06Manifest,
} from "../../src/database/stage06-manifest.js";
import {
  checkStage06ManifestAdapter,
  stage06ManifestAdapterIncludePath,
  stage06ManifestAdapterPath,
} from "../../scripts/stage06-manifest-adapter.js";

/**
 * 阶段 09A / M2A：manifest、renderer 与 generated adapter 门禁的单元测试。
 *
 * 这里不连数据库：真实 PostgreSQL 18 的 semantic parity 与全部权限反例在
 * `tests/database/stage09a.roles.database.test.ts`。本文件只覆盖
 * 「TypeScript manifest ↔ 渲染文本 ↔ tracked generated 文件」这条链路。
 */

const withTemporaryDirectory = async <T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), "meal-agent-manifest-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/**
 * 去掉全部单引号字符串字面量。渲染出的 SQL 把索引定义原样放进字面量，其中包含
 * `CREATE UNIQUE INDEX ...`，因此「是否含有 DDL 动词」只能在剥离字面量之后判断。
 * manifest 侧已保证字面量里没有反斜杠，所以 `''` 是唯一的转义形式。
 */
const withoutStringLiterals = (sql: string): string => {
  let result = "";
  let inLiteral = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'") {
      inLiteral = !inLiteral;
      continue;
    }
    if (!inLiteral) {
      result += character;
    }
  }
  return result;
};

test("the canonical projection has unique identities and a fixed order", () => {
  const rows = canonicalManifestRows();
  assert.ok(rows.length > 200, "the frozen 0000 projects more than 200 objects");

  const keys = rows.map((row) => `${row.kind}:${row.identity}`);
  assert.equal(new Set(keys).size, keys.length, "identities must be unique");

  const sorted = [...keys].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  assert.deepEqual(keys, sorted, "rows must be sorted by kind then identity");

  // 每个 kind 都必须真的有覆盖，避免「某一类静默变成空集合」。
  const kinds = new Set(rows.map((row) => row.kind));
  for (const kind of ["schema", "relation", "index", "constraint", "routine",
    "policy"]) {
    assert.ok(kinds.has(kind), `kind ${kind} must be covered`);
  }

  assert.deepEqual(managedSchemas(), [
    "drizzle",
    "meal_agent_private",
    "public",
  ]);
  assert.deepEqual(handoffPendingKeys(), [
    "relation:drizzle.__meal_agent_migrations",
    "schema:drizzle",
    "schema:public",
  ]);
});

test("declaration order does not change the canonical projection", () => {
  const reversed: Stage06Manifest = {
    ...stage06SecurityManifest,
    constraints: [...stage06SecurityManifest.constraints].reverse(),
    policies: [...stage06SecurityManifest.policies].reverse(),
    routines: [...stage06SecurityManifest.routines].reverse(),
  };
  assert.equal(canonicalManifestText(reversed), canonicalManifestText());
  assert.equal(manifestDigest(reversed), manifestDigest());
});

test("a duplicate identity is rejected instead of silently winning", () => {
  const [first] = stage06SecurityManifest.routines;
  assert.ok(first !== undefined);
  const duplicated: Stage06Manifest = {
    ...stage06SecurityManifest,
    routines: [...stage06SecurityManifest.routines, first],
  };
  assert.throws(
    () => canonicalManifestRows(duplicated),
    (error: unknown) =>
      error instanceof Stage06ManifestError &&
      /duplicate identity routine:/.test(error.message),
  );
});

test("values that cannot be rendered deterministically are rejected", () => {
  const [first] = stage06SecurityManifest.constraints;
  assert.ok(first !== undefined);
  for (const definition of [
    `${first.definition} \\gexec`,
    `${first.definition}\nCREATE TABLE injected (id int)`,
  ]) {
    const poisoned: Stage06Manifest = {
      ...stage06SecurityManifest,
      constraints: [{ ...first, name: "poisoned", definition }],
    };
    assert.throws(
      () => canonicalManifestRows(poisoned),
      (error: unknown) => error instanceof Stage06ManifestError,
    );
  }
});

test("the rendered SQL is deterministic, pure SQL and read-only", () => {
  const first = renderStage06ManifestCheckSql();
  assert.equal(renderStage06ManifestCheckSql(), first);

  // 1. 没有 psql 元命令：任何以反斜杠开头的行都不允许。
  for (const line of first.split("\n")) {
    assert.ok(
      !line.trimStart().startsWith("\\"),
      `rendered SQL must not contain a psql meta-command: ${line.slice(0, 60)}`,
    );
  }

  // 2. 剥离字符串字面量之后不得出现任何变更语句。
  const executable = withoutStringLiterals(first);
  for (const verb of [
    "ALTER ",
    "GRANT ",
    "REVOKE ",
    "CREATE ",
    "DROP ",
    "INSERT ",
    "UPDATE ",
    "DELETE ",
    "TRUNCATE ",
    "COMMIT",
    "ROLLBACK",
  ]) {
    assert.ok(
      !executable.toUpperCase().includes(verb),
      `rendered SQL must not contain ${verb.trim()}`,
    );
  }

  // 3. 只把 search_path 设成事务内局部值，不改任何持久设置。
  assert.match(first, /set_config\('search_path', 'pg_catalog', true\)/);
  assert.match(first, /RAISE EXCEPTION/);

  // 4. 投影是渲染块的一部分，不是第二份归一化规则。
  assert.ok(first.includes(renderStage06CatalogProjectionSql()));
});

test("the generated adapter header is stable and free of environment traces", async () => {
  const adapter = renderStage06ManifestAdapter();
  assert.equal(renderStage06ManifestAdapter(), adapter);
  assert.match(adapter, /GENERATED FILE — DO NOT EDIT\./);
  assert.match(adapter, /manifest:generate/);
  assert.match(
    adapter,
    new RegExp(`manifest version: ${String(stage06ManifestVersion)}`),
  );
  assert.match(
    adapter,
    new RegExp(`canonical manifest digest: sha256:${manifestDigest()}`),
  );

  // 不含时间戳、绝对路径、locale 或随机值。
  assert.ok(!/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(adapter));
  assert.ok(!adapter.includes("/Users/"));
  assert.ok(!adapter.includes("/home/"));
  assert.ok(!adapter.includes(process.cwd()));
  assert.equal(adapter.endsWith("\n"), true);
  assert.ok(!adapter.includes("\r"));
});

test("the tracked generated adapter matches the manifest byte-for-byte", async () => {
  const result = await checkStage06ManifestAdapter();
  assert.equal(result.ok, true, result.detail);

  const tracked = await readFile(stage06ManifestAdapterPath, "utf8");
  assert.equal(tracked, renderStage06ManifestAdapter());

  // handoff 用的相对 \ir 路径必须指向同一个文件。
  assert.ok(
    stage06ManifestAdapterPath.endsWith(stage06ManifestAdapterIncludePath),
    `${stage06ManifestAdapterPath} must end with ${stage06ManifestAdapterIncludePath}`,
  );
});

test("a stale or hand-edited adapter fails the gate without being rewritten", async () => {
  const rendered = renderStage06ManifestAdapter();
  await withTemporaryDirectory(async (directory) => {
    // 1. 陈旧：内容来自一个更早的 manifest（这里用少一条 policy 模拟）。
    const stalePath = join(directory, "stale.sql");
    const stale = renderStage06ManifestAdapter({
      ...stage06SecurityManifest,
      policies: stage06SecurityManifest.policies.slice(1),
    });
    await writeFile(stalePath, stale, "utf8");
    const staleResult = await checkStage06ManifestAdapter(stalePath);
    assert.equal(staleResult.ok, false);
    assert.match(staleResult.detail, /manifest:generate/);
    assert.equal(await readFile(stalePath, "utf8"), stale, "gate must not write");

    // 2. 手改：只动一个字符。
    const editedPath = join(directory, "edited.sql");
    const edited = rendered.replace("meal_agent_migrator", "meal_agent_migratoR");
    assert.notEqual(edited, rendered);
    await writeFile(editedPath, edited, "utf8");
    const before = await stat(editedPath);
    const editedResult = await checkStage06ManifestAdapter(editedPath);
    assert.equal(editedResult.ok, false);
    assert.match(editedResult.detail, /do not hand-edit/);
    assert.match(editedResult.detail, /first difference at byte \d+/);
    assert.equal(await readFile(editedPath, "utf8"), edited, "gate must not write");
    assert.equal((await stat(editedPath)).size, before.size);

    // 3. 缺失。
    const missingResult = await checkStage06ManifestAdapter(
      join(directory, "absent.sql"),
    );
    assert.equal(missingResult.ok, false);
    assert.match(missingResult.detail, /missing/);
  });
});
