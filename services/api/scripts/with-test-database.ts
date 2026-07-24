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
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        [
          "auth_identities",
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
  } else {
    const testsDirectory = new URL("../tests/database/", import.meta.url);
    const testFiles = (await readdir(testsDirectory))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => new URL(name, testsDirectory).pathname);
    assert.ok(testFiles.length > 0, "database tests are required");
    await run(
      process.execPath,
      ["--import", "tsx", "--test", ...testFiles],
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
