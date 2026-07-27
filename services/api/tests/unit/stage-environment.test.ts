import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePostgresToolchain,
  parsePostgresBanner,
  requiredPostgresExecutables,
  supportedPostgresVersion,
  type PostgresExecutable,
  type PostgresToolBanner,
} from "../../scripts/stage-environment.js";

/**
 * 阶段 09A / M2A：PostgreSQL 工具链版本判据的自动化证据。
 *
 * 对象 manifest 与授权 manifest 的 catalog 基线是从具体 patch 采集的，因此判据必须
 * fail closed 到 exact 18.4，而且必须覆盖**整套工具**：`initdb` 建集群、`pg_ctl`
 * 起停、`createdb` 建库、`psql` 执行 bootstrap 与 generated adapter。「只有 server
 * 是 18.4」是最容易发生、也最难被发现的那种混装。
 *
 * 这些结论不能只写在注释里，所以下面逐条断言。
 */

/** Homebrew 形态的标准 banner；vendor suffix 是合法的、不影响主版本字段。 */
const banner = (tool: string, version: string): string =>
  `${tool} (PostgreSQL) ${version} (Homebrew)`;

const healthyToolchain = (): Record<PostgresExecutable, PostgresToolBanner> =>
  Object.fromEntries(
    requiredPostgresExecutables.map((tool) => [
      tool,
      banner(tool, supportedPostgresVersion),
    ]),
  ) as Record<PostgresExecutable, PostgresToolBanner>;

test("the toolchain gate pins an exact patch and covers every required tool", () => {
  assert.equal(supportedPostgresVersion, "18.4");
  assert.deepEqual(
    [...requiredPostgresExecutables],
    ["createdb", "initdb", "pg_ctl", "postgres", "psql"],
  );
  assert.deepEqual(evaluatePostgresToolchain(healthyToolchain()), []);
});

test("each standard banner shape is parsed by its major version field", () => {
  for (const tool of requiredPostgresExecutables) {
    for (const text of [
      `${tool} (PostgreSQL) 18.4`,
      `${tool} (PostgreSQL) 18.4\n`,
      `${tool} (PostgreSQL) 18.4 (Homebrew)`,
      `${tool} (PostgreSQL) 18.4 (Debian 18.4-1.pgdg13+1)`,
    ]) {
      const parsed = parsePostgresBanner(tool, text);
      assert.equal(parsed.ok, true, `${tool} must accept ${JSON.stringify(text)}`);
      assert.equal(parsed.version, "18.4");
    }
  }
});

test("a major version of 18.3 is refused even when the vendor suffix contains 18.4", () => {
  // 子串判据在这一条上会误判为通过：`18.4` 确实出现在字符串里，但主版本字段是
  // 18.3。这正是不允许 includes / 任意子串判断的原因。
  const deceptive = "psql (PostgreSQL) 18.3 (Ubuntu 18.4-1.pgdg24.04+1)";
  assert.ok(deceptive.includes("18.4"), "the trap only matters if 18.4 is present");
  const parsed = parsePostgresBanner("psql", deceptive);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.version, "18.3");
  assert.match(parsed.detail, /expected PostgreSQL 18\.4, found 18\.3/);

  for (const text of [
    "psql (PostgreSQL) 18.3",
    "psql (PostgreSQL) 18.3 (Homebrew)",
    "psql (PostgreSQL) 17.4 (18.4 build)",
  ]) {
    assert.equal(parsePostgresBanner("psql", text).ok, false, text);
  }
});

test("near-miss version fields and non-PostgreSQL banners are refused", () => {
  for (const text of [
    // 相邻 patch / major。
    "psql (PostgreSQL) 18.5",
    "psql (PostgreSQL) 19.4",
    // 前缀/后缀相似但不是 18.4 这个字段。
    "psql (PostgreSQL) 18.40",
    "psql (PostgreSQL) 118.4",
    "psql (PostgreSQL) 18.44 (Homebrew)",
    // 三段版本或预发布后缀：不宽容解析，直接拒绝。
    "psql (PostgreSQL) 18.4.1",
    "psql (PostgreSQL) 18.4beta1",
    // 非 PostgreSQL 发行版。
    "psql (EnterpriseDB) 18.4",
    "psql (PostgreSQL Advanced Server) 18.4",
    "psql 18.4",
    "PostgreSQL 18.4",
    // 空、多行与前置噪声。
    "",
    "   ",
    "psql (PostgreSQL) 18.4\npsql (PostgreSQL) 18.3",
    "WARNING: shim\npsql (PostgreSQL) 18.4",
  ]) {
    assert.equal(
      parsePostgresBanner("psql", text).ok,
      false,
      `must be refused: ${JSON.stringify(text)}`,
    );
  }
});

test("a banner that reports another tool's name is refused", () => {
  // 伪造场景：一个把自己报成 postgres 的 psql。工具名必须与实际执行的可执行文件
  // 一致，否则「整套工具链同版本」的结论没有意义。
  const parsed = parsePostgresBanner("psql", banner("postgres", "18.4"));
  assert.equal(parsed.ok, false);
  assert.match(parsed.detail, /banner reports "postgres" but the executable is "psql"/);
});

test("a mixed toolchain is refused even when postgres itself is 18.4", () => {
  for (const tool of requiredPostgresExecutables) {
    if (tool === "postgres") {
      continue;
    }
    // 1. 另一个工具是 18.3。
    const olderPatch = { ...healthyToolchain(), [tool]: banner(tool, "18.3") };
    assert.deepEqual(
      evaluatePostgresToolchain(olderPatch).map((failure) => failure.tool),
      [tool],
      `${tool} at 18.3 must be refused while postgres is 18.4`,
    );

    // 2. 另一个工具的 banner 被伪造成 postgres 的。
    const forged = { ...healthyToolchain(), [tool]: banner("postgres", "18.4") };
    assert.deepEqual(
      evaluatePostgresToolchain(forged).map((failure) => failure.tool),
      [tool],
      `${tool} with a forged banner must be refused`,
    );

    // 3. 另一个工具缺失或不可执行。
    const missing = { ...healthyToolchain(), [tool]: null };
    const failures = evaluatePostgresToolchain(missing);
    assert.deepEqual(failures.map((failure) => failure.tool), [tool]);
    assert.match(failures[0]?.detail ?? "", /missing or not executable/);
  }

  // 反向：postgres 自己是 18.3 时同样必须被拒绝。
  assert.deepEqual(
    evaluatePostgresToolchain({
      ...healthyToolchain(),
      postgres: banner("postgres", "18.3"),
    }).map((failure) => failure.tool),
    ["postgres"],
  );

  // 全部失败项一次报出，不是只报第一个。
  assert.equal(
    evaluatePostgresToolchain({
      createdb: banner("createdb", "18.3"),
      initdb: null,
      pg_ctl: banner("pg_ctl", "18.4"),
      postgres: banner("postgres", "18.4"),
      psql: "psql (EnterpriseDB) 18.4",
    }).length,
    3,
  );

  // 完全没有工具链时，五个工具全部报缺失。
  assert.equal(evaluatePostgresToolchain({}).length, 5);
});
