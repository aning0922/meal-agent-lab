import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMigrations,
  bootstrapMigrationFlag,
  bootstrapMigrationOptions,
  MigrationCliUsageError,
  MigrationOptionError,
  migrationRole,
  parseMigrationCliArguments,
} from "../../src/database/migrate.js";

/**
 * db:migrate 的运维入口必须窄而固定：默认命令走安全路径（显式进入
 * meal_agent_migrator），`--bootstrap-0000` 是唯一的 admin 例外，且不接受
 * 任意 role 或任意 migration 边界。
 */

test("the default migration command switches to the migrator role", () => {
  assert.equal(parseMigrationCliArguments([]), "default");
  assert.equal(migrationRole, "meal_agent_migrator");
});

test("the admin bootstrap flag is narrow and fixed", () => {
  assert.equal(
    parseMigrationCliArguments([bootstrapMigrationFlag]),
    "bootstrap-0000",
  );
  // 该模式的参数是固定值，调用方无法借它传入任意 role 或任意边界。
  assert.deepEqual(bootstrapMigrationOptions, {
    role: null,
    onlyThrough: "0000_stage_06.sql",
  });
  assert.equal(Object.isFrozen(bootstrapMigrationOptions), true);
});

test("unknown, repeated and combined arguments are rejected", () => {
  for (const argv of [
    ["--role=postgres"],
    ["--role", "postgres"],
    ["--only-through=0004_stage_08_final_closeout.sql"],
    ["--bootstrap-0001"],
    ["bootstrap"],
    [""],
    [bootstrapMigrationFlag, "--role=postgres"],
    [bootstrapMigrationFlag, bootstrapMigrationFlag],
    [bootstrapMigrationFlag, "extra"],
  ]) {
    assert.throws(
      () => parseMigrationCliArguments(argv),
      MigrationCliUsageError,
      `must reject ${JSON.stringify(argv)}`,
    );
  }
});

test("bounded-wait options must be positive finite safe integers", async () => {
  // 校验发生在建立连接之前，因此这些用例不需要任何数据库。
  const unreachable = "postgresql://invalid@127.0.0.1:1/invalid";
  for (const invalid of [
    0,
    -1,
    -0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 2,
  ]) {
    await assert.rejects(
      applyMigrations(unreachable, { lockWaitMs: invalid }),
      MigrationOptionError,
      `lockWaitMs ${String(invalid)} must be rejected`,
    );
    await assert.rejects(
      applyMigrations(unreachable, { connectionTimeoutMs: invalid }),
      MigrationOptionError,
      `connectionTimeoutMs ${String(invalid)} must be rejected`,
    );
  }
});
