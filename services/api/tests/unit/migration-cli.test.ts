import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  BootstrapCliUsageError,
  parseBootstrapCliArguments,
} from "../../src/database/bootstrap-0000.js";
import {
  applyMigrations,
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

test("db:migrate takes no arguments and always switches to the migrator role", () => {
  assert.equal(parseMigrationCliArguments([]), undefined);
  assert.equal(migrationRole, "meal_agent_migrator");
});

test("the admin bootstrap entry point is separate and fixed", () => {
  assert.equal(parseBootstrapCliArguments([]), undefined);
  // 该入口的参数是固定值，调用方无法借它传入任意 role 或任意边界。
  assert.deepEqual(bootstrapMigrationOptions, {
    role: null,
    onlyThrough: "0000_stage_06.sql",
    adminBootstrap: true,
  });
  assert.equal(Object.isFrozen(bootstrapMigrationOptions), true);
});

test("db:migrate rejects every argument, including the admin bootstrap flag", () => {
  for (const argv of [
    ["--bootstrap-0000"],
    ["--role=postgres"],
    ["--role", "postgres"],
    ["--only-through=0004_stage_08_final_closeout.sql"],
    ["bootstrap"],
    [""],
    ["--", "--bootstrap-0000"],
  ]) {
    assert.throws(
      () => parseMigrationCliArguments(argv),
      MigrationCliUsageError,
      `db:migrate must reject ${JSON.stringify(argv)}`,
    );
  }
});

test("db:bootstrap rejects every argument", () => {
  for (const argv of [
    ["--bootstrap-0000"],
    ["--role=postgres"],
    ["--only-through=0000_stage_06.sql"],
    [""],
  ]) {
    assert.throws(
      () => parseBootstrapCliArguments(argv),
      BootstrapCliUsageError,
      `db:bootstrap must reject ${JSON.stringify(argv)}`,
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

test("the pool is ended even when the connection itself fails", async () => {
  // migrate.ts 自己构造 Pool，因此这里在 prototype 上做受控替身：
  // 连接失败时也必须走到 pool.end()，否则部署 job 会泄漏连接池。
  const pool = pg.Pool.prototype as unknown as {
    connect: () => Promise<never>;
    end: () => Promise<void>;
  };
  const originalConnect = pool.connect;
  const originalEnd = pool.end;
  let endCalls = 0;
  pool.connect = async () => {
    throw new Error("synthetic ECONNREFUSED");
  };
  pool.end = async () => {
    endCalls += 1;
  };
  try {
    await assert.rejects(
      applyMigrations("postgresql://invalid@127.0.0.1:1/invalid"),
      /synthetic ECONNREFUSED/,
    );
    assert.equal(endCalls, 1, "pool.end must run even when connect() rejects");
  } finally {
    pool.connect = originalConnect;
    pool.end = originalEnd;
  }
});
