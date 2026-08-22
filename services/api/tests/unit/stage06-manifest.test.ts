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
  renderAuthorizationConvergeSql,
  renderAuthorizationVerifyAdapter,
  renderAuthorizationVerifySql,
} from "../../src/database/authorization-manifest-sql.js";
import {
  renderAuthorizationPolicyCtes,
  renderAuthorizationPreflightStatement,
  renderAuthorizationSharedCtes,
} from "../../src/database/authorization-policy-sql.js";
import {
  assertRenderableValue,
  authorizationDollarQuoteTags,
  AuthorizationRenderError,
} from "../../src/database/authorization-identity.js";
import {
  assertDefaultAclObjtypeMappings,
  defaultAclObjtypeMappings,
  renderAuthorizationProjectionAdapter,
  renderAuthorizationProjectionSql,
  renderAuthorizationProjectorCtes,
  type DefaultAclObjtypeMapping,
} from "../../src/database/authorization-projection-sql.js";
import {
  authorizationDigest,
  authorizationManifest,
  authorizationStateKey,
  authorizationStateKeys,
  AuthorizationManifestError,
  canonicalAuthorizationRows,
  canonicalAuthorizationText,
  validateAuthorizationManifest,
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
  // 排序是**逐字段**的 `(state, kind, identity)`，不是把三段拼起来再比：拼接会
  // 让分隔符参与比较（`default-effective` 与 `default` 就会互换位置）。
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const sorted = [...rows].sort(
    (left, right) =>
      compare(left.state, right.state) ||
      compare(left.kind, right.kind) ||
      compare(left.identity, right.identity),
  );
  assert.deepEqual(rows, sorted, "rows must be sorted");

  // 至少覆盖 0000-only 与当前 0000—0004 两个 ledger，各带两个阶段。
  const states = authorizationStateKeys();
  assert.equal(states.length, 4);
  // state identity 是结构化 JSON [[sorted names], phase]，不是拼接串。
  assert.ok(
    states.includes(authorizationStateKey(["0000_stage_06.sql"], "containment")),
  );
  assert.ok(
    states.includes(authorizationStateKey(["0000_stage_06.sql"], "final")),
  );
  assert.equal(
    states.filter((state) => state.endsWith(String.raw`, "final"]`)).length,
    2,
    "every ledger must have a final phase",
  );

  const kinds = new Set(rows.map((row) => row.kind));
  for (const kind of [
    "grant",
    "default",
    "default-effective",
    "effective",
    "routine",
  ]) {
    assert.ok(kinds.has(kind), `kind ${kind} must be covered`);
  }

  // identity 全部是结构化 JSON 数组，绝不是 `#`/`@` 拼接串。
  for (const row of rows) {
    assert.ok(
      row.identity.startsWith("[") && row.identity.endsWith("]"),
      `identity ${row.identity} must be a structured JSON array`,
    );
    assert.doesNotThrow(() => JSON.parse(row.identity) as unknown);
  }

  // 备份角色的表级 SELECT 只属于 final：两个阶段必须真的不同。
  const backupRelations = (state: string): number =>
    rows.filter(
      (row) =>
        row.state === state &&
        row.kind === "grant" &&
        row.identity.startsWith('[["relation"') &&
        row.identity.endsWith('"meal_agent_backup"]'),
    ).length;
  assert.equal(
    backupRelations(authorizationStateKey(["0000_stage_06.sql"], "containment")),
    0,
  );
  assert.ok(
    backupRelations(authorizationStateKey(["0000_stage_06.sql"], "final")) > 0,
  );

  // `defaults` 是 pg_default_acl 的**物理行**，`defaultEffective` 才是叠加结果。
  // 两者必须真的不同：物理行只有少数几条，有效默认权限覆盖全部槽位。
  for (const state of authorizationManifest.states) {
    assert.ok(
      state.defaults.length < state.defaultEffective.length,
      "physical default rows must be a strict subset of the composed effect",
    );
    for (const entry of state.defaults) {
      assert.ok(
        entry.scope === "-" ||
          authorizationManifest.managedSchemas.includes(entry.scope),
        `default scope ${entry.scope} must be global or a managed schema`,
      );
    }
  }
  const finalState = authorizationManifest.states.find(
    (state) => state.phase === "final" && state.ledger.length === 1,
  );
  assert.ok(finalState !== undefined);
  // 全局 FUNCTIONS 行是真实存在的物理行（它把 PUBLIC EXECUTE 从内建默认里去掉）。
  assert.ok(
    finalState.defaults.some(
      (entry) => entry.objtype === "f" && entry.scope === "-",
    ),
  );
  // sequence 的**有效**默认权限必须保留 SELECT/UPDATE/USAGE：把 defaclobjtype
  // 的 S 直接喂给 acldefault 会把它低报成只剩 USAGE。
  const sequenceOwnerDefault = finalState.defaultEffective.find(
    (entry) =>
      entry.objtype === "S" &&
      entry.scope === "public" &&
      entry.grantee === "meal_agent_migrator",
  );
  assert.deepEqual([...(sequenceOwnerDefault?.privileges ?? [])].sort(), [
    "SELECT",
    "UPDATE",
    "USAGE",
  ]);
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

  // 外部角色永远拿不到固定允许项：它们只能由策略匹配（结论恒为「不允许」）。
  const withExternalGrantee: AuthorizationManifest = {
    ...authorizationManifest,
    states: [{ ...first, grants: [{ ...grant, grantee: "postgres" }] }],
  };
  assert.throws(
    () => canonicalAuthorizationRows(withExternalGrantee),
    (error: unknown) =>
      error instanceof AuthorizationManifestError &&
      /not a project principal/.test(error.message),
  );

  // owner 的权限来自归属，由策略放行；把它登记成固定 grantee 会让「owner 自持」
  // 与「显式授予」两条规则重叠，直接拒绝。
  const withOwnerAsGrantee: AuthorizationManifest = {
    ...authorizationManifest,
    principals: {
      ...authorizationManifest.principals,
      grantees: [
        ...authorizationManifest.principals.grantees,
        authorizationManifest.principals.owner,
      ],
    },
  };
  assert.throws(
    () => canonicalAuthorizationRows(withOwnerAsGrantee),
    (error: unknown) =>
      error instanceof AuthorizationManifestError &&
      /canonical owner must not be registered/.test(error.message),
  );

  // type / column / language / Large Object 由策略判定，manifest 不得登记允许项。
  const withTypeGrant: AuthorizationManifest = {
    ...authorizationManifest,
    states: [
      {
        ...first,
        grants: [{ ...grant, object: ["type", "public", "users"] }],
      },
    ],
  };
  assert.throws(
    () => canonicalAuthorizationRows(withTypeGrant),
    (error: unknown) =>
      error instanceof AuthorizationManifestError &&
      /decided by policy/.test(error.message),
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

  // 动态枚举：共享事实层不得引用任何固定项目主体作为过滤条件。
  for (const principal of authorizationManifest.principals.grantees) {
    if (principal === "PUBLIC") {
      continue;
    }
    assert.ok(
      !first.includes(`'${principal}'`),
      `the projection must not filter on the static grantee ${principal}`,
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
    patch: Partial<{
      acldefaultObjtype: string;
      schemaScoped: boolean;
      ddlKeyword: string;
    }>,
  ): readonly DefaultAclObjtypeMapping[] =>
    defaultAclObjtypeMappings.map((mapping) =>
      mapping.objtype === objtype ? { ...mapping, ...patch } : mapping,
    );
  for (const [label, broken] of [
    ["missing", defaultAclObjtypeMappings.filter((m) => m.objtype !== "S")],
    [
      "extra",
      [
        ...defaultAclObjtypeMappings,
        {
          objtype: "x",
          acldefaultObjtype: "x",
          schemaScoped: false,
          ddlKeyword: "UNKNOWN",
        },
      ],
    ],
    ["reordered", [...defaultAclObjtypeMappings].reverse()],
    ["duplicated", [...defaultAclObjtypeMappings, ...defaultAclObjtypeMappings]],
    ["wrong target S->S", replace("S", { acldefaultObjtype: "S" })],
    ["wrong scope S->s/false", replace("S", { schemaScoped: false })],
    ["wrong target r->s", replace("r", { acldefaultObjtype: "s" })],
    ["wrong scope n->n/true", replace("n", { schemaScoped: true })],
    // DDL 关键字配错同样致命：sequence 的默认权限会被改到表上。
    ["wrong keyword S->TABLES", replace("S", { ddlKeyword: "TABLES" })],
  ] as const satisfies readonly (readonly [
    string,
    readonly DefaultAclObjtypeMapping[],
  ])[]) {
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
  assert.match(sql, /\n {6}\('S', 's', true, 'SEQUENCES'\),\n/);
  // 槽位的 schema 维度也由映射表决定，不再是硬编码的 objtype 名单。
  assert.ok(
    !sql.includes("t.objtype IN ('r', 'S', 'f', 'T')"),
    "schema-scoped slots must come from the mapping, not a hard-coded list",
  );
});

test("the shared render guard rejects SQL tokens, wrong privileges, wrong scopes and DO tags", () => {
  // 三个 renderer 都会把 manifest 里的标量原样拼进**高权限** SQL（收敛块会
  // SET LOCAL ROLE / GRANT / REVOKE / ALTER DEFAULT PRIVILEGES），因此守卫必须
  // 只有一份、并且在渲染之前就拒绝。
  for (const token of [
    "meal_agent'app",
    'meal_agent"app',
    "meal_agent;app",
    "meal_agent--app",
    "meal_agent/*app",
    "meal_agent*/app",
    "meal_agent\\app",
    "meal_agent\napp",
  ]) {
    assert.throws(
      () => {
        assertRenderableValue("role", token);
      },
      (error: unknown) =>
        error instanceof AuthorizationRenderError &&
        /cannot be rendered into a privileged SQL statement/.test(error.message),
      `the guard must reject ${JSON.stringify(token)}`,
    );
  }
  // dollar-quote 标签尤其致命：值里出现它就能提前关闭整个 DO 块。
  for (const tag of authorizationDollarQuoteTags) {
    assert.throws(
      () => {
        assertRenderableValue("role", `meal_agent_${tag}_app`);
      },
      (error: unknown) => error instanceof AuthorizationRenderError,
      `the guard must reject the ${tag} dollar-quote tag`,
    );
    // 同一道守卫也必须挡住经由 manifest 顶层字段注入的标签。
    const poisoned: AuthorizationManifest = {
      ...authorizationManifest,
      managedSchemas: [...authorizationManifest.managedSchemas, `x${tag}x`],
    };
    assert.throws(
      () => renderAuthorizationConvergeAdapter(poisoned),
      (error: unknown) => error instanceof AuthorizationRenderError,
    );
    assert.throws(
      () => renderAuthorizationVerifySql(poisoned),
      (error: unknown) => error instanceof AuthorizationRenderError,
    );
  }

  const [first] = authorizationManifest.states;
  assert.ok(first !== undefined);
  const [grant] = first.grants;
  assert.ok(grant !== undefined);

  // 权限必须落在**该对象类别**的精确 allowlist 里。
  const wrongPrivilege: AuthorizationManifest = {
    ...authorizationManifest,
    states: [
      {
        ...first,
        grants: [
          {
            object: ["relation", "public", "users"],
            grantee: "meal_agent_app",
            privileges: ["EXECUTE"],
          },
        ],
      },
    ],
  };
  assert.throws(
    () => canonicalAuthorizationRows(wrongPrivilege),
    (error: unknown) =>
      error instanceof AuthorizationManifestError &&
      /is not valid for grant on relation/.test(error.message),
  );

  // objtype × scope 的**组合**必须合法：schema 与 large object 没有 schema 作用域。
  for (const [objtype, scope, pattern] of [
    ["n", "public", /has no schema scope/],
    ["L", "public", /has no schema scope/],
    ["x", "-", /unknown default privilege objtype/],
    ["r", "not_a_schema", /neither global nor a managed schema/],
  ] as const) {
    const wrongScope: AuthorizationManifest = {
      ...authorizationManifest,
      states: [
        {
          ...first,
          defaults: [
            { objtype, scope, grantee: "meal_agent_migrator", privileges: ["USAGE"] },
          ],
        },
      ],
    };
    assert.throws(
      () => canonicalAuthorizationRows(wrongScope),
      (error: unknown) =>
        error instanceof AuthorizationManifestError && pattern.test(error.message),
      `${objtype}@${scope} must be rejected`,
    );
  }

  // 默认权限的权限名同样按 objtype 精确校验。
  const wrongDefaultPrivilege: AuthorizationManifest = {
    ...authorizationManifest,
    states: [
      {
        ...first,
        defaults: [
          { objtype: "T", scope: "-", grantee: "meal_agent_migrator", privileges: ["SELECT"] },
        ],
      },
    ],
  };
  assert.throws(
    () => canonicalAuthorizationRows(wrongDefaultPrivilege),
    (error: unknown) =>
      error instanceof AuthorizationManifestError &&
      /is not valid for default privilege T@-/.test(error.message),
  );
});

test("the canonical digest covers every top-level manifest field", () => {
  const baseline = authorizationDigest();
  const variants: readonly [string, AuthorizationManifest][] = [
    [
      "deniedRoutines order-insensitive control",
      {
        ...authorizationManifest,
        deniedRoutines: [...authorizationManifest.deniedRoutines].reverse(),
      },
    ],
    [
      "managedSchemas",
      {
        ...authorizationManifest,
        managedSchemas: [...authorizationManifest.managedSchemas, "extra_schema"],
      },
    ],
    [
      "deniedRoutines",
      {
        ...authorizationManifest,
        deniedRoutines: [
          ...authorizationManifest.deniedRoutines,
          "pg_catalog.lo_extra(oid)",
        ],
      },
    ],
    [
      "logins",
      {
        ...authorizationManifest,
        principals: {
          ...authorizationManifest.principals,
          logins: [...authorizationManifest.principals.logins].reverse(),
        },
      },
    ],
    [
      "memberships",
      {
        ...authorizationManifest,
        principals: {
          ...authorizationManifest.principals,
          memberships: [
            ...authorizationManifest.principals.memberships,
            { member: "meal_agent_runtime_login", granted: "meal_agent_backup" },
          ],
        },
      },
    ],
    ["version", { ...authorizationManifest, version: 99 }],
  ];
  for (const [field, variant] of variants) {
    if (field.includes("order-insensitive") || field === "logins") {
      // 顺序变化不应改变 digest：header 按 C 序规范化。
      assert.equal(
        authorizationDigest(variant),
        baseline,
        `reordering ${field} must not change the digest`,
      );
      continue;
    }
    assert.notEqual(
      authorizationDigest(variant),
      baseline,
      `changing ${field} must change the canonical digest`,
    );
  }

  // owner 同样进 digest，但换掉它会让全部 default privilege 的 grantee 变成
  // 「既不是 owner 也不是项目主体」——那是 fail closed 的场景，不是「digest 变了」
  // 的场景。因此这里直接断言两件事：canonical 文本确实带 owner 行，且伪造 owner
  // 会被拒绝。
  assert.match(
    canonicalAuthorizationText(),
    /^<manifest>\|owner\|\[\]\|meal_agent_migrator$/mu,
  );
  assert.throws(
    () =>
      authorizationDigest({
        ...authorizationManifest,
        principals: {
          ...authorizationManifest.principals,
          owner: "other_owner",
        },
      }),
    (error: unknown) => error instanceof AuthorizationManifestError,
  );
});

test("a newly registered empty state changes the canonical digest", () => {
  // 五类数组全空的 state 一行内容都不产生，却实质改变了「哪些 (ledger, phase)
  // 组合能通过 fail-closed 判定」。digest 因此必须包含**已登记 state key 的集合
  // 本身**，否则 generated adapter 头部的 digest 会对一次真实的策略放宽保持沉默。
  const baseline = authorizationDigest();
  const withEmptyState: AuthorizationManifest = {
    ...authorizationManifest,
    states: [
      ...authorizationManifest.states,
      {
        ledger: ["0000_stage_06.sql", "0005_future.sql"],
        phase: "final",
        routines: [],
        grants: [],
        defaults: [],
        defaultEffective: [],
        effective: [],
      },
    ],
  };
  // 空 state 确实一行都不产生。
  assert.equal(
    canonicalAuthorizationRows(withEmptyState).length,
    canonicalAuthorizationRows().length,
  );
  assert.notEqual(
    authorizationDigest(withEmptyState),
    baseline,
    "registering an empty state must still change the digest",
  );
  assert.match(
    canonicalAuthorizationText(withEmptyState),
    /^<manifest>\|states\|\[\]\|.*0005_future\.sql/mu,
  );
});

test("every exported renderer refuses a manifest that fails the unified validator", () => {
  // 每一个导出的 renderer 都会把 manifest 拼进高权限 SQL，因此**每一个**都必须
  // 在渲染之前走同一道 validateAuthorizationManifest()。这里逐个证明：没有任何
  // 一条 raw renderer 旁路能绕过 canonicalizer 校验。
  const renderers: readonly [string, (manifest: AuthorizationManifest) => string][] =
    [
      ["projector ctes", renderAuthorizationProjectorCtes],
      ["projection sql", renderAuthorizationProjectionSql],
      ["projection adapter", renderAuthorizationProjectionAdapter],
      ["policy ctes", renderAuthorizationPolicyCtes],
      ["shared ctes", renderAuthorizationSharedCtes],
      ["preflight", renderAuthorizationPreflightStatement],
      ["converge sql", renderAuthorizationConvergeSql],
      ["verify sql", renderAuthorizationVerifySql],
      ["converge adapter", renderAuthorizationConvergeAdapter],
      ["verify adapter", renderAuthorizationVerifyAdapter],
    ];

  const [first] = authorizationManifest.states;
  assert.ok(first !== undefined);
  const [grant] = first.grants;
  assert.ok(grant !== undefined);

  const poisoned: readonly [string, AuthorizationManifest][] = [
    [
      "malicious privilege",
      {
        ...authorizationManifest,
        states: [
          {
            ...first,
            grants: [
              {
                ...grant,
                privileges: ["SELECT; DROP TABLE users"],
              },
            ],
          },
        ],
      },
    ],
    [
      "malicious identity",
      {
        ...authorizationManifest,
        states: [
          {
            ...first,
            grants: [
              {
                ...grant,
                object: ["relation", "public", "users'; SELECT 1 --"],
              },
            ],
          },
        ],
      },
    ],
    [
      "unsupported version",
      { ...authorizationManifest, version: 9999 },
    ],
    [
      "non-integer version",
      { ...authorizationManifest, version: 2.5 },
    ],
    [
      "negative version",
      { ...authorizationManifest, version: -2 },
    ],
    [
      // 版本号被伪造成带换行的字符串（绕过类型系统）：拼进 RAISE 文本就会
      // 把后面的内容变成新的一行。
      "version newline injection",
      {
        ...authorizationManifest,
        version: "2\nRAISE NOTICE 'injected'" as unknown as number,
      },
    ],
    [
      "external default grantee",
      {
        ...authorizationManifest,
        states: [
          {
            ...first,
            defaults: [
              {
                objtype: "r",
                scope: "public",
                grantee: "stage09a_outsider",
                privileges: ["SELECT"],
              },
            ],
          },
        ],
      },
    ],
    [
      "external default-effective grantee",
      {
        ...authorizationManifest,
        states: [
          {
            ...first,
            defaultEffective: [
              {
                objtype: "r",
                scope: "public",
                grantee: "stage09a_outsider",
                privileges: ["SELECT"],
              },
            ],
          },
        ],
      },
    ],
    [
      "membership pointing at an unknown role",
      {
        ...authorizationManifest,
        principals: {
          ...authorizationManifest.principals,
          memberships: [
            ...authorizationManifest.principals.memberships,
            { member: "stage09a_outsider", granted: "meal_agent_app" },
          ],
        },
      },
    ],
  ];

  for (const [label, manifest] of poisoned) {
    // 校验入口本身拒绝。
    assert.throws(
      () => validateAuthorizationManifest(manifest),
      (error: unknown) =>
        error instanceof AuthorizationManifestError ||
        error instanceof AuthorizationRenderError,
      `validateAuthorizationManifest must reject: ${label}`,
    );
    // 每一个 renderer 也必须拒绝——没有旁路。
    for (const [name, render] of renderers) {
      assert.throws(
        () => render(manifest),
        (error: unknown) =>
          error instanceof AuthorizationManifestError ||
          error instanceof AuthorizationRenderError,
        `${name} must refuse to render: ${label}`,
      );
    }
  }

  // 正例：合法 manifest 全部 renderer 都能渲染出非空文本。
  for (const [name, render] of renderers) {
    assert.ok(
      render(authorizationManifest).length > 0,
      `${name} must still render the real manifest`,
    );
  }
});

test("the state identity is structural and cannot be forged by a comma in a filename", () => {
  // 旧编码是 `names.join(",") + "|" + phase`，它有歧义：一个**完全合法**的
  // migration 文件名里带逗号，就能拼出与两个真实文件完全相同的 key，于是
  // exact-ledger 这条 fail-closed 判据被一条数据绕过。结构化编码里每个元素各自
  // 由 JSON 引号包裹，分隔符不可能被数据伪造。
  const legacyKey = (ledger: readonly string[], phase: string): string =>
    `${[...ledger].sort().join(",")}|${phase}`;

  const collisions: readonly [string, readonly string[], readonly string[]][] = [
    [
      "five files vs a merged 0000/0001 filename",
      [
        "0000_stage_06.sql",
        "0001_stage_08.sql",
        "0002_stage_08_audit_closeout.sql",
        "0003_stage_08_secondary_closeout.sql",
        "0004_stage_08_final_closeout.sql",
      ],
      [
        "0000_stage_06.sql,0001_stage_08.sql",
        "0002_stage_08_audit_closeout.sql",
        "0003_stage_08_secondary_closeout.sql",
        "0004_stage_08_final_closeout.sql",
      ],
    ],
    [
      "two files vs one comma-bearing filename",
      ["0000_stage_06.sql", "a.sql", "b.sql"],
      ["0000_stage_06.sql", "a.sql,b.sql"],
    ],
  ];

  for (const [label, left, right] of collisions) {
    // 1. 旧编码确实会碰撞——这不是假想的风险。
    assert.equal(
      legacyKey(left, "final"),
      legacyKey(right, "final"),
      `the legacy encoding must really collide for: ${label}`,
    );
    // 2. 结构化编码不会。
    assert.notEqual(
      authorizationStateKey(left, "final"),
      authorizationStateKey(right, "final"),
      `the structural state identity must differ for: ${label}`,
    );
    // 3. identity 是 [[sorted names], phase] 的 JSON，可结构化解析回来。
    for (const ledger of [left, right]) {
      const parsed = JSON.parse(
        authorizationStateKey(ledger, "final"),
      ) as [readonly string[], string];
      assert.deepEqual(parsed[0], [...ledger].sort());
      assert.equal(parsed[1], "final");
    }
  }

  // 4. phase 也参与结构，不靠分隔符区分。
  assert.notEqual(
    authorizationStateKey(["0000_stage_06.sql"], "final"),
    authorizationStateKey(["0000_stage_06.sql"], "containment"),
  );

  // 5. digest 必须跟着变：把已登记的五文件 ledger 换成合并文件名之后，两份
  //    manifest 的 canonical digest 不可以相同。
  const [firstState] = authorizationManifest.states;
  assert.ok(firstState !== undefined);
  const merged: AuthorizationManifest = {
    ...authorizationManifest,
    states: authorizationManifest.states.map((state) =>
      state.ledger.length === 5
        ? {
            ...state,
            ledger: [
              "0000_stage_06.sql,0001_stage_08.sql",
              "0002_stage_08_audit_closeout.sql",
              "0003_stage_08_secondary_closeout.sql",
              "0004_stage_08_final_closeout.sql",
            ],
          }
        : state,
    ),
  };
  assert.notEqual(
    authorizationDigest(merged),
    authorizationDigest(),
    "a merged ledger filename must change the canonical digest",
  );
});

test("the complete preflight statement precedes the first mutation in the converge block", () => {
  // 结构证据（与「快照没变」互补）：快照只能证明**没有已提交的 mutation**，
  // 证明不了「进程内一步都没执行过」。这里直接在渲染文本上定位：完整的 preflight
  // 语句——包括它的 RAISE——必须整段排在**第一个** mutation 循环 / EXECUTE 之前。
  const converge = renderAuthorizationConvergeSql();

  const preflightStart = converge.indexOf("preflight_problem (rank, kind, entry)");
  assert.ok(preflightStart > 0, "the preflight CTE must be present");
  const preflightRaiseIndex = converge.indexOf(
    "authorization preflight failed for state",
  );
  assert.ok(preflightRaiseIndex > preflightStart);
  const preflightEnd = converge.indexOf("END IF;", preflightRaiseIndex);
  assert.ok(preflightEnd > preflightRaiseIndex, "the preflight must fail closed");

  // 第一个真正会改状态的东西：收敛动作循环，以及它里面的 EXECUTE。
  const firstLoop = converge.indexOf("FOR row_record IN");
  const firstExecute = converge.indexOf("EXECUTE format(");
  assert.ok(firstLoop > 0 && firstExecute > 0);
  assert.ok(
    preflightEnd < firstLoop,
    "the whole preflight statement must precede the first mutation loop",
  );
  assert.ok(
    preflightEnd < firstExecute,
    "the whole preflight statement must precede the first EXECUTE",
  );
  // preflight 自己不含任何 EXECUTE：它是一条只读语句。
  assert.equal(
    converge.slice(preflightStart, preflightEnd).includes("EXECUTE format("),
    false,
    "the preflight statement must not execute anything",
  );
  // verify block 里根本没有 mutation 循环。
  assert.equal(renderAuthorizationVerifySql().includes("EXECUTE format("), false);
});
