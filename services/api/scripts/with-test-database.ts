import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { Pool } from "pg";

import { applyMigrations } from "../src/database/migrate.js";
import {
  assertStageNodeVersion,
  findPostgres18Bin,
} from "./stage-environment.js";

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate test database port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error === undefined) {
          resolve(port);
        } else {
          reject(error);
        }
      });
    });
  });

const run = async (
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} failed with ${signal ?? `exit code ${String(code)}`}`,
          ),
        );
      }
    });
  });

const mode = process.argv[2];
if (mode !== "migration" && mode !== "test") {
  throw new Error("expected mode: migration or test");
}

assertStageNodeVersion();
const { binDirectory: postgresBin } = await findPostgres18Bin();
const clusterRoot = await mkdtemp(join(tmpdir(), "meal-agent-stage-06-pg18-"));
const dataDirectory = join(clusterRoot, "data");
const socketDirectory = join(clusterRoot, "socket");
const port = await freePort();
const environment = {
  ...process.env,
  // macOS: with LC_ALL unset the postmaster can abort at boot
  // ("postmaster became multithreaded during startup") when CoreFoundation
  // initializes locale support, so pin a valid locale for the PG toolchain.
  LC_ALL: process.env["LC_ALL"] ?? "C",
  PGHOST: "127.0.0.1",
  PGPORT: String(port),
  PGUSER: "postgres",
};
let started = false;

try {
  await mkdir(socketDirectory);
  await run(
    join(postgresBin, "initdb"),
    [
      "-D",
      dataDirectory,
      "--auth-local=trust",
      "--auth-host=trust",
      "--username=postgres",
      "--encoding=UTF8",
      "--no-instructions",
    ],
    environment,
  );
  await run(
    join(postgresBin, "pg_ctl"),
    [
      "-D",
      dataDirectory,
      "-o",
      `-F -p ${port} -h 127.0.0.1 -k ${socketDirectory}`,
      "-w",
      "start",
    ],
    environment,
  );
  started = true;
  await run(
    join(postgresBin, "createdb"),
    ["meal_agent_test"],
    environment,
  );

  const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/meal_agent_test`;
  await applyMigrations(databaseUrl);

  if (mode === "migration") {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const version = await pool.query<{ server_version: string }>(
        "SHOW server_version",
      );
      assert.match(version.rows[0]?.server_version ?? "", /^18\./);
      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      );
      // 空库两文件全量成功：主库已由上面的 applyMigrations 建好全部表。
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        [
          "auth_identities",
          "household_invites",
          "households",
          "idempotency_records",
          "inventory_events",
          "inventory_lots",
          "memberships",
          "person_profiles",
          "sessions",
          "users",
        ],
      );
    } finally {
      await pool.end();
    }

    // 增量应用 + checksum 校验：新建第二个库，先只上 0000（断言此时没有
    // household_invites），再单独增量上 0001（断言表出现、0000 未重跑），
    // 最后篡改存储 hash 证明 checksum 守卫会拒绝漂移。
    const incrementalDatabase = "meal_agent_incremental_test";
    await run(
      join(postgresBin, "createdb"),
      [incrementalDatabase],
      environment,
    );
    const incrementalUrl = `postgresql://postgres@127.0.0.1:${port}/${incrementalDatabase}`;

    await applyMigrations(incrementalUrl, {
      onlyThrough: "0000_stage_06.sql",
    });
    const baselinePool = new Pool({ connectionString: incrementalUrl });
    try {
      const invitesBefore = await baselinePool.query<{
        present: string | null;
      }>("SELECT to_regclass('public.household_invites') AS present");
      assert.equal(
        invitesBefore.rows[0]?.present,
        null,
        "household_invites must not exist before 0001 is applied",
      );
      const appliedBaseline = await baselinePool.query<{ name: string }>(
        "SELECT name FROM drizzle.__meal_agent_migrations ORDER BY name",
      );
      assert.deepEqual(
        appliedBaseline.rows.map((row) => row.name),
        ["0000_stage_06.sql"],
      );
    } finally {
      await baselinePool.end();
    }

    await applyMigrations(incrementalUrl);
    const incrementalPool = new Pool({ connectionString: incrementalUrl });
    try {
      const invitesAfter = await incrementalPool.query<{
        present: string | null;
      }>("SELECT to_regclass('public.household_invites') AS present");
      assert.notEqual(
        invitesAfter.rows[0]?.present,
        null,
        "household_invites must exist after 0001 is applied incrementally",
      );
      const appliedIncrement = await incrementalPool.query<{ name: string }>(
        "SELECT name FROM drizzle.__meal_agent_migrations ORDER BY name",
      );
      assert.deepEqual(
        appliedIncrement.rows.map((row) => row.name),
        ["0000_stage_06.sql", "0001_stage_08.sql"],
      );
      // 重复应用是幂等 no-op：全部 checksum 匹配，不抛错、不重跑。
      await applyMigrations(incrementalUrl);
      // checksum 守卫：把 0001 的存储 hash 改坏后再应用必须抛错。
      await incrementalPool.query(
        `UPDATE drizzle.__meal_agent_migrations
         SET hash = repeat('0', 64)
         WHERE name = '0001_stage_08.sql'`,
      );
      await assert.rejects(
        applyMigrations(incrementalUrl),
        /changed checksum/,
      );
    } finally {
      await incrementalPool.end();
    }
  } else {
    const testsDirectory = new URL("../tests/database/", import.meta.url);
    const testFiles = (await readdir(testsDirectory))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => new URL(name, testsDirectory).pathname);
    assert.ok(testFiles.length > 0, "database tests are required");
    await run(
      process.execPath,
      // 多个数据库测试文件共享同一套一次性库；串行执行文件，避免各文件
      // beforeEach 的 TRUNCATE 相互竞态。
      ["--import", "tsx", "--test", "--test-concurrency=1", ...testFiles],
      {
        ...process.env,
        TEST_DATABASE_URL: databaseUrl,
        DATABASE_URL: databaseUrl,
        PG_BIN: postgresBin,
      },
    );
  }
} finally {
  if (started) {
    await run(join(postgresBin, "pg_ctl"), [
      "-D",
      dataDirectory,
      "-m",
      "immediate",
      "-w",
      "stop",
    ]).catch(() => undefined);
  }
  await rm(clusterRoot, { recursive: true, force: true });
}
