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
  checkAllStage06Adapters,
  checkStage06ManifestAdapter,
  stage06Adapters,
  stage06ManifestAdapterIncludePath,
  stage06ManifestAdapterPath,
} from "../../scripts/stage06-manifest-adapter.js";
import {
  renderAuthorizationConvergeAdapter,
  renderAuthorizationVerifySql,
} from "../../src/database/authorization-manifest-sql.js";
import {
  assertDefaultAclObjtypeMappings,
  defaultAclObjtypeMappings,
  renderAuthorizationProjectionAdapter,
  renderAuthorizationProjectionSql,
} from "../../src/database/authorization-projection-sql.js";
import {
  authorizationManifest,
  authorizationStateKeys,
  AuthorizationManifestError,
  canonicalAuthorizationRows,
  defaultAclSlots,
  type AuthorizationManifest,
} from "../../src/database/authorization-manifest.js";

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

  // 排序是 (kind, identity) 的**元组序**，不是拼接字符串序：`constraint` 与
  // `constraint-trigger` 拼接后会交叉，元组比较才是渲染实际使用的顺序。
  const sorted = [...rows].sort(
    (left, right) =>
      (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
      (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0),
  );
  assert.deepEqual(
    rows.map((row) => `${row.kind}|${row.identity}`),
    sorted.map((row) => `${row.kind}|${row.identity}`),
    "rows must be sorted by kind then identity",
  );

  // 每个 kind 都必须真的有覆盖，避免「某一类静默变成空集合」。
  const kinds = new Set(rows.map((row) => row.kind));
  for (const kind of ["database", "schema", "relation", "column", "index",
    "constraint", "routine", "policy", "type", "constraint-trigger"]) {
    assert.ok(kinds.has(kind), `kind ${kind} must be covered`);
  }

  assert.deepEqual(managedSchemas(), [
    "drizzle",
    "meal_agent_private",
    "public",
  ]);
  // handoff 过渡态的对象：数据库自身、两个 schema、drizzle ledger 及其数组类型。
  assert.deepEqual(handoffPendingKeys(), [
    "database:<current>",
    "relation:drizzle.__meal_agent_migrations",
    "schema:drizzle",
    "schema:public",
    "type:drizzle.___meal_agent_migrations",
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

test("every tracked generated adapter matches its manifest byte-for-byte", async () => {
  for (const result of await checkAllStage06Adapters()) {
    assert.equal(result.ok, true, `${result.includePath}: ${result.detail}`);
    assert.match(result.detail, /\d+ bytes/);
  }
  assert.equal(stage06Adapters.length, 4);
  for (const adapter of stage06Adapters) {
    assert.ok(
      adapter.absolutePath.endsWith(adapter.includePath),
      `${adapter.absolutePath} must end with ${adapter.includePath}`,
    );
  }

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
    assert.match(editedResult.detail, /first difference at character \d+/);
    assert.match(editedResult.detail, /rendered \d+ bytes, tracked \d+ bytes/);
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

test("the authorization manifest is ledger and phase keyed with unique rows", () => {
  const rows = canonicalAuthorizationRows();
  assert.ok(rows.length > 200, "the authorization manifest must be non-trivial");

  const keys = rows.map((row) => `${row.state}:${row.kind}:${row.identity}`);
  assert.equal(new Set(keys).size, keys.length, "identities must be unique");
  const sorted = [...keys].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  assert.deepEqual(keys, sorted, "rows must be sorted");

  // 至少覆盖 0000-only 与当前 0000—0004 两个 ledger，各带两个阶段。
  const states = authorizationStateKeys();
  assert.equal(states.length, 4);
  assert.ok(states.includes("0000_stage_06.sql|containment"));
  assert.ok(states.includes("0000_stage_06.sql|final"));
  assert.equal(
    states.filter((state) => state.endsWith("|final")).length,
    2,
    "every ledger must have a final phase",
  );

  const kinds = new Set(rows.map((row) => row.kind));
  for (const kind of ["grant", "default", "effective", "routine"]) {
    assert.ok(kinds.has(kind), `kind ${kind} must be covered`);
  }

  // 备份角色的表级 SELECT 只属于 final：两个阶段必须真的不同。
  const backupRelations = (state: string): number =>
    rows.filter(
      (row) =>
        row.state === state &&
        row.kind === "grant" &&
        row.identity.startsWith("relation:") &&
        row.identity.endsWith("#meal_agent_backup"),
    ).length;
  assert.equal(backupRelations("0000_stage_06.sql|containment"), 0);
  assert.ok(backupRelations("0000_stage_06.sql|final") > 0);

  // 默认权限槽位覆盖三个 managed schema 与全局。
  const slots = defaultAclSlots().map((slot) => `${slot.objtype}@${slot.scope}`);
  assert.ok(slots.includes("f@global"));
  assert.ok(slots.includes("r@public"));
  assert.equal(new Set(slots).size, slots.length);
});

test("the authorization manifest rejects duplicates, empty and grantable privileges", () => {
  const [first] = authorizationManifest.states;
  assert.ok(first !== undefined);
  const [grant] = first.grants;
  assert.ok(grant !== undefined);

  const withDuplicateState: AuthorizationManifest = {
    ...authorizationManifest,
    states: [...authorizationManifest.states, first],
  };
  assert.throws(
    () => canonicalAuthorizationRows(withDuplicateState),
    (error: unknown) => error instanceof AuthorizationManifestError,
  );

  const withEmptyPrivileges: AuthorizationManifest = {
    ...authorizationManifest,
    states: [{ ...first, grants: [{ ...grant, privileges: [] }] }],
  };
  assert.throws(
    () => canonicalAuthorizationRows(withEmptyPrivileges),
    (error: unknown) =>
      error instanceof AuthorizationManifestError &&
      /empty privilege set/.test(error.message),
  );

  const withGrantOption: AuthorizationManifest = {
    ...authorizationManifest,
    states: [{ ...first, grants: [{ ...grant, privileges: ["SELECT*"] }] }],
  };
  assert.throws(
    () => canonicalAuthorizationRows(withGrantOption),
    (error: unknown) =>
      error instanceof AuthorizationManifestError &&
      /grant options are never allowed/.test(error.message),
  );

  const withUnwatchedGrantee: AuthorizationManifest = {
    ...authorizationManifest,
    states: [{ ...first, grants: [{ ...grant, grantee: "postgres" }] }],
  };
  assert.throws(
    () => canonicalAuthorizationRows(withUnwatchedGrantee),
    (error: unknown) =>
      error instanceof AuthorizationManifestError &&
      /unwatched grantee/.test(error.message),
  );
});

test("the authorization SQL keeps verify read-only and converge free of DDL", () => {
  const verify = renderAuthorizationVerifySql();
  const executable = withoutStringLiterals(verify);
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
  ]) {
    assert.ok(
      !executable.toUpperCase().includes(verb),
      `the verify block must not contain ${verb.trim()}`,
    );
  }

  // 收敛块按设计会改 ACL，但**不得**改归属或创建/删除任何对象。
  const converge = withoutStringLiterals(renderAuthorizationConvergeAdapter());
  for (const verb of [
    "CREATE ",
    "DROP ",
    "OWNER TO",
    "INSERT ",
    "UPDATE ",
    "DELETE ",
    "TRUNCATE ",
  ]) {
    assert.ok(
      !converge.toUpperCase().includes(verb.toUpperCase()),
      `the converge block must not contain ${verb.trim()}`,
    );
  }
  // 正向断言必须在**原文**上做：REVOKE / GRANT 都在 format() 的字面量里。
  const convergeRaw = renderAuthorizationConvergeAdapter();
  assert.match(convergeRaw, /REVOKE/);
  assert.match(convergeRaw, /GRANT/);

  // 两段都必须固定会话 GUC，否则 catalog 文本会随会话变化。
  for (const rendered of [verify, renderAuthorizationConvergeAdapter()]) {
    assert.match(rendered, /set_config\('search_path', 'pg_catalog', true\)/);
    assert.match(
      rendered,
      /set_config\('quote_all_identifiers', 'off', true\)/,
    );
  }
});

test("the authorization projection is deterministic and performs no mutation", () => {
  const first = renderAuthorizationProjectionSql();
  assert.equal(renderAuthorizationProjectionSql(), first);

  // 本轮不实现 convergence：投影必须是纯 SELECT。剥离字符串字面量之后不得出现
  // 任何权限或结构变更语句。
  const executable = withoutStringLiterals(first);
  for (const verb of [
    "GRANT ",
    "REVOKE ",
    "ALTER ",
    "SET ROLE",
    "RESET ROLE",
    "CREATE ",
    "DROP ",
    "INSERT ",
    "UPDATE ",
    "DELETE ",
    "TRUNCATE ",
    "COMMIT",
    "ROLLBACK",
    "SET LOCAL",
    "SET_CONFIG",
    "EXECUTE ",
  ]) {
    assert.ok(
      !executable.toUpperCase().includes(verb),
      `the projection must not contain ${verb.trim()}`,
    );
  }
  // 没有 psql 元命令。
  for (const line of first.split("\n")) {
    assert.ok(!line.trimStart().startsWith("\\"));
  }

  // 覆盖面：所有必须可观察的 kind 都在渲染文本里。`default-row` 是**物理行
  // 存在性**的唯一载体（空 ACL 展开为零行，与「没有这一行」无法区分），
  // `default-unmapped` 是未知 objtype 的 fail-closed 标记，两者都不可缺席。
  for (const kind of [
    "'acl'",
    // raw 层是 `'default-' || scope_kind`，因此这里断言前缀与叠加层。
    "'default-' || scope_kind",
    "'default-row'",
    "'default-effective'",
    "'default-unmapped'",
    "'effective'",
    "'owner'",
    "'large-object'",
    "'type-class'",
    "'role'",
  ]) {
    assert.ok(first.includes(kind), `projection must emit ${kind}`);
  }

  // 动态枚举：不得引用 watchedGrantees 静态名单。
  for (const watched of authorizationManifest.watchedGrantees) {
    if (watched === "PUBLIC") {
      continue;
    }
    assert.ok(
      !first.includes(`'${watched}'`),
      `the projection must not filter on the static grantee ${watched}`,
    );
  }

  const adapter = renderAuthorizationProjectionAdapter();
  assert.match(adapter, /GENERATED FILE — DO NOT EDIT\./);
  assert.ok(!adapter.includes("/Users/"));
  assert.ok(!/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(adapter));
});

test("the default ACL objtype mapping never confuses S (foreign server) with s (sequence)", () => {
  // 1. 映射穷尽六种 pg_default_acl objtype，且**只有** sequence 换字母。
  assert.deepEqual(
    defaultAclObjtypeMappings.map(
      (mapping) => `${mapping.objtype}->${mapping.acldefaultObjtype}`,
    ),
    ["L->L", "S->s", "T->T", "f->f", "n->n", "r->r"],
  );
  // 2. 只有 table/sequence/function/type 能带 schema；schema 与 large object
  //    只有全局形式（PostgreSQL 直接拒绝 `IN SCHEMA … ON SCHEMAS`）。
  assert.deepEqual(
    defaultAclObjtypeMappings
      .filter((mapping) => mapping.schemaScoped)
      .map((mapping) => mapping.objtype),
    ["S", "T", "f", "r"],
  );
  assertDefaultAclObjtypeMappings();

  // 3. 缺一个、多一个、乱序、重复，以及**映射目标错**或**作用域错**都必须 fail
  //    closed。后两类是集合检查抓不到的：`S->S` 会把 sequence 当 FOREIGN SERVER
  //    从而低报权限，`S->s/false` 会让 sequence 的 schema 级槽位整类消失。
  const replace = (
    objtype: string,
    patch: Partial<{ acldefaultObjtype: string; schemaScoped: boolean }>,
  ) =>
    defaultAclObjtypeMappings.map((mapping) =>
      mapping.objtype === objtype ? { ...mapping, ...patch } : mapping,
    );
  for (const [label, broken] of [
    ["missing", defaultAclObjtypeMappings.filter((m) => m.objtype !== "S")],
    [
      "extra",
      [
        ...defaultAclObjtypeMappings,
        { objtype: "x", acldefaultObjtype: "x", schemaScoped: false },
      ],
    ],
    ["reordered", [...defaultAclObjtypeMappings].reverse()],
    ["duplicated", [...defaultAclObjtypeMappings, ...defaultAclObjtypeMappings]],
    ["wrong target S->S", replace("S", { acldefaultObjtype: "S" })],
    ["wrong scope S->s/false", replace("S", { schemaScoped: false })],
    ["wrong target r->s", replace("r", { acldefaultObjtype: "s" })],
    ["wrong scope n->n/true", replace("n", { schemaScoped: true })],
  ] as const) {
    assert.throws(
      () => {
        assertDefaultAclObjtypeMappings(broken);
      },
      (error: unknown) =>
        error instanceof AuthorizationManifestError &&
        /canonical six/.test(error.message),
      `${label} must fail closed`,
    );
  }
  // 渲染入口本身也会先做这一步：canonical 映射通过，破坏后的映射拿不到 SQL。
  assert.equal(
    renderAuthorizationProjectionSql(),
    renderAuthorizationProjectionSql(),
  );

  // 4. 渲染出的 SQL 必须走映射列，绝不能再把 defaclobjtype 直接喂给 acldefault。
  const sql = renderAuthorizationProjectionSql();
  assert.ok(
    !sql.includes(`acldefault(sl.objtype::"char"`),
    "acldefault must never receive a raw pg_default_acl objtype",
  );
  assert.match(sql, /acldefault\(sl\.acldefault_objtype::"char"/);
  assert.match(sql, /\n {6}\('S', 's', true\),\n/);
  // 槽位的 schema 维度也由映射表决定，不再是硬编码的 objtype 名单。
  assert.ok(
    !sql.includes("t.objtype IN ('r', 'S', 'f', 'T')"),
    "schema-scoped slots must come from the mapping, not a hard-coded list",
  );
});
