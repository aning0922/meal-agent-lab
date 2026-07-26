import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { loadConfig } from "../../src/config.js";
import {
  applyMigrations,
  MigrationLockTimeoutError,
} from "../../src/database/migrate.js";
import { checkReadiness, createPersistence } from "../../src/database/pool.js";

/**
 * 阶段 09A / M2A：数据库身份、bootstrap、migration 与 readiness 权限边界。
 *
 * 本文件在同一个一次性 PostgreSQL 18 集群里另建一个独立数据库，完整走一遍
 *   admin 0000 → owner 交接 → 登录角色 → migration login SET ROLE 0001—0004
 *   → backup 补授 → runtime login readiness
 * 并对每一条边界做正向与反向验证。
 *
 * 密码是本进程内临时生成的合成值，只经环境变量传给 psql，不打印、不落盘、
 * 不进入 tracked 文件。
 */

const adminUrl = process.env["TEST_DATABASE_URL"];
if (adminUrl === undefined || adminUrl === "") {
  throw new Error("TEST_DATABASE_URL is required");
}
const postgresBin = process.env["PG_BIN"];
if (postgresBin === undefined || postgresBin === "") {
  throw new Error("PG_BIN is required");
}

const adminConnection = new URL(adminUrl);
const host = adminConnection.hostname;
const port = adminConnection.port;
const rolesDatabase = "meal_agent_stage09a_roles";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const bootstrapScript = join(
  repositoryRoot,
  "infra/docker/postgres/bootstrap.sh",
);

/** 合成密码：只存在于本进程内存与子进程环境中。 */
const syntheticPassword = (): string => randomBytes(24).toString("base64url");
const passwords = {
  migration: syntheticPassword(),
  runtime: syntheticPassword(),
  backup: syntheticPassword(),
};

const urlFor = (role: string): string =>
  `postgresql://${role}@${host}:${port}/${rolesDatabase}`;

const migrationLoginUrl = urlFor("meal_agent_migration_login");
const runtimeLoginUrl = urlFor("meal_agent_runtime_login");
const backupLoginUrl = urlFor("meal_agent_backup_login");

const runBootstrap = async (phase: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(bootstrapScript, [phase, "--dbname", rolesDatabase], {
      env: {
        ...process.env,
        PATH: `${postgresBin}:${process.env["PATH"] ?? ""}`,
        PGHOST: host,
        PGPORT: port,
        PGUSER: "postgres",
        MEAL_AGENT_MIGRATION_PASSWORD: passwords.migration,
        MEAL_AGENT_RUNTIME_PASSWORD: passwords.runtime,
        MEAL_AGENT_BACKUP_PASSWORD: passwords.backup,
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `bootstrap ${phase} failed with ` +
            `${signal ?? `exit code ${String(code)}`}`,
        ),
      );
    });
  });

const withPool = async <T>(
  url: string,
  operation: (pool: Pool) => Promise<T>,
): Promise<T> => {
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
};

/** 以指定 login 进入其业务角色后执行，返回失败信息（成功则返回 undefined）。 */
const attempt = async (
  pool: Pool,
  statements: readonly string[],
  role?: string,
): Promise<string | undefined> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (role !== undefined) {
      await client.query("SELECT set_config('role', $1, true)", [role]);
    }
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return error instanceof Error ? error.message : String(error);
  } finally {
    client.release();
  }
};

const households = {
  first: "018f0900-0000-7000-8000-000000000001",
  second: "018f0900-0000-7000-8000-000000000002",
} as const;
const owners = {
  first: "018f0900-0000-7000-8000-0000000000a1",
  second: "018f0900-0000-7000-8000-0000000000a2",
} as const;

before(async () => {
  // 1. 全新空数据库，由 cluster admin 创建。
  await withPool(adminUrl, async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS ${rolesDatabase}`);
    await pool.query(`CREATE DATABASE ${rolesDatabase}`);
  });

  const adminRolesUrl = `postgresql://postgres@${host}:${port}/${rolesDatabase}`;

  // 2. bootstrap/admin 执行冻结的 0000（含 CREATE ROLE 与 BYPASSRLS，
  //    必须由 cluster admin 执行，此时 migrator 角色还不存在）。
  await applyMigrations(adminRolesUrl, {
    role: null,
    onlyThrough: "0000_stage_06.sql",
  });

  // 3. owner 交接 + 备份角色，4. 登录角色。
  await runBootstrap("handoff");
  await runBootstrap("logins");

  // 5. migration login 显式进入 meal_agent_migrator 执行 0001—0004。
  await applyMigrations(migrationLoginUrl);

  // 6. migration 之后的 backup 只读补授。
  await runBootstrap("grants");

  // 合成数据：两个家庭，用于验证 backup 能跨 FORCE RLS 完整读取。
  await withPool(migrationLoginUrl, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('role', $1, false)", [
        "meal_agent_migrator",
      ]);
      const now = "2026-07-26T00:00:00.000Z";
      for (const key of ["first", "second"] as const) {
        await client.query(
          `INSERT INTO users (id, status, display_name, locale,
             created_at, updated_at, version)
           VALUES ($1, 'active', $2, 'zh-CN', $3, $3, 0)`,
          [owners[key], `合成用户-${key}`, now],
        );
        await client.query(
          `INSERT INTO households (id, name, timezone, locale, status,
             created_by_user_id, created_at, updated_at, version)
           VALUES ($1, $2, 'Asia/Shanghai', 'zh-CN', 'active', $3, $4, $4, 0)`,
          [households[key], `合成家庭-${key}`, owners[key], now],
        );
      }
    } finally {
      client.release();
    }
  });
});

after(async () => {
  await withPool(adminUrl, async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS ${rolesDatabase}`);
  });
});

test("bootstrap hands database, schema and ledger ownership to the migrator", async () => {
  await withPool(adminUrl, async (pool) => {
    const database = await pool.query<{ owner: string }>(
      `SELECT pg_catalog.pg_get_userbyid(datdba) AS owner
       FROM pg_database WHERE datname = $1`,
      [rolesDatabase],
    );
    assert.equal(database.rows[0]?.owner, "meal_agent_migrator");
  });

  await withPool(migrationLoginUrl, async (pool) => {
    const schemas = await pool.query<{ nspname: string; owner: string }>(
      `SELECT nspname, pg_catalog.pg_get_userbyid(nspowner) AS owner
       FROM pg_namespace
       WHERE nspname IN ('public', 'drizzle', 'meal_agent_private')
       ORDER BY nspname`,
    );
    assert.deepEqual(schemas.rows, [
      { nspname: "drizzle", owner: "meal_agent_migrator" },
      { nspname: "meal_agent_private", owner: "meal_agent_migrator" },
      { nspname: "public", owner: "meal_agent_migrator" },
    ]);

    // migration ledger 与全部业务表都归 migrator。
    const tables = await pool.query<{ relname: string; owner: string }>(
      `SELECT c.relname, pg_catalog.pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`,
    );
    assert.equal(tables.rows.length > 0, true);
    assert.deepEqual(
      tables.rows.filter((row) => row.owner !== "meal_agent_migrator"),
      [],
    );
    assert.equal(
      tables.rows.some((row) => row.relname === "__meal_agent_migrations"),
      true,
    );

    // SECURITY DEFINER 函数的 owner 决定其有效权限，必须是 migrator。
    const functions = await pool.query<{ proname: string; owner: string }>(
      `SELECT p.proname, pg_catalog.pg_get_userbyid(p.proowner) AS owner
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'meal_agent_private'
       ORDER BY p.proname`,
    );
    assert.equal(functions.rows.length > 0, true);
    assert.deepEqual(
      functions.rows.filter((row) => row.owner !== "meal_agent_migrator"),
      [],
    );
  });
});

test("the migration login applies 0001-0004 only after explicitly entering the migrator role", async () => {
  await withPool(migrationLoginUrl, async (pool) => {
    // NOINHERIT：不 SET ROLE 时，migration login 连 migration ledger 都读不到。
    const ledgerWithoutRole = await attempt(pool, [
      "SELECT name FROM drizzle.__meal_agent_migrations",
    ]);
    assert.notEqual(ledgerWithoutRole, undefined);
    assert.match(String(ledgerWithoutRole), /permission denied/i);

    // 同样不具备 DDL 能力。
    const ddlWithoutRole = await attempt(pool, [
      "CREATE TABLE public.stage09a_should_not_exist (id int)",
    ]);
    assert.notEqual(ddlWithoutRole, undefined);
    assert.match(String(ddlWithoutRole), /permission denied/i);

    // 显式进入 migrator 之后：五个 migration 全部登记，且具备 DDL 能力。
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('role', $1, true)", [
        "meal_agent_migrator",
      ]);
      const applied = await client.query<{ name: string }>(
        "SELECT name FROM drizzle.__meal_agent_migrations ORDER BY name",
      );
      assert.deepEqual(
        applied.rows.map((row) => row.name),
        [
          "0000_stage_06.sql",
          "0001_stage_08.sql",
          "0002_stage_08_audit_closeout.sql",
          "0003_stage_08_secondary_closeout.sql",
          "0004_stage_08_final_closeout.sql",
        ],
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const ddlWithRole = await attempt(
      pool,
      ["CREATE TABLE public.stage09a_rolled_back (id int)"],
      "meal_agent_migrator",
    );
    assert.equal(ddlWithRole, undefined);
  });
});

/** 以 migration login 显式进入 migrator role 后执行。 */
const asMigrator = async <T>(
  operation: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> =>
  withPool(migrationLoginUrl, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('role', $1, false)", [
        "meal_agent_migrator",
      ]);
      return await operation(client);
    } finally {
      client.release();
    }
  });

test("re-running migrations is idempotent and checksum drift still fails closed", async () => {
  // 第二次执行是 no-op：不重跑、不报错。
  await applyMigrations(migrationLoginUrl);

  const originalHash = await asMigrator(async (client) => {
    const applied = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__meal_agent_migrations",
    );
    assert.equal(applied.rows[0]?.count, "5");
    const stored = await client.query<{ hash: string }>(
      `SELECT hash FROM drizzle.__meal_agent_migrations
       WHERE name = '0001_stage_08.sql'`,
    );
    return stored.rows[0]?.hash;
  });
  assert.equal(typeof originalHash, "string");

  // 篡改已登记的 hash 后必须 fail closed。
  await asMigrator(async (client) => {
    await client.query(
      `UPDATE drizzle.__meal_agent_migrations
       SET hash = repeat('0', 64) WHERE name = '0001_stage_08.sql'`,
    );
  });

  await assert.rejects(
    applyMigrations(migrationLoginUrl),
    /changed checksum/,
  );

  // 还原，供后续用例使用。
  await asMigrator(async (client) => {
    await client.query(
      `UPDATE drizzle.__meal_agent_migrations SET hash = $1
       WHERE name = '0001_stage_08.sql'`,
      [originalHash],
    );
  });
  await applyMigrations(migrationLoginUrl);
});

test("login roles carry no cluster privileges and only reach their own business role", async () => {
  await withPool(adminUrl, async (pool) => {
    const roles = await pool.query<{
      rolname: string;
      rolsuper: boolean;
      rolinherit: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
              rolreplication, rolbypassrls, rolcanlogin
       FROM pg_roles
       WHERE rolname LIKE 'meal_agent%'
       ORDER BY rolname`,
    );
    const byName = new Map(roles.rows.map((row) => [row.rolname, row]));

    for (const login of [
      "meal_agent_migration_login",
      "meal_agent_runtime_login",
      "meal_agent_backup_login",
    ]) {
      const row = byName.get(login);
      assert.notEqual(row, undefined, `${login} must exist`);
      assert.deepEqual(
        {
          rolsuper: row?.rolsuper,
          rolinherit: row?.rolinherit,
          rolcreaterole: row?.rolcreaterole,
          rolcreatedb: row?.rolcreatedb,
          rolreplication: row?.rolreplication,
          rolbypassrls: row?.rolbypassrls,
          rolcanlogin: row?.rolcanlogin,
        },
        {
          rolsuper: false,
          rolinherit: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolbypassrls: false,
          rolcanlogin: true,
        },
        `${login} attribute baseline`,
      );
    }

    // NOLOGIN 业务角色：migrator/backup 有 BYPASSRLS，app 没有。
    assert.equal(byName.get("meal_agent_migrator")?.rolbypassrls, true);
    assert.equal(byName.get("meal_agent_migrator")?.rolcanlogin, false);
    assert.equal(byName.get("meal_agent_backup")?.rolbypassrls, true);
    assert.equal(byName.get("meal_agent_backup")?.rolcanlogin, false);
    assert.equal(byName.get("meal_agent_app")?.rolbypassrls, false);
    assert.equal(byName.get("meal_agent_app")?.rolcanlogin, false);

    // membership 矩阵：每个 login 只能进入自己那一个角色。
    const memberships = await pool.query<{
      member: string;
      granted: string;
      inherited: boolean;
    }>(
      `SELECT m.rolname AS member, g.rolname AS granted, a.inherit_option AS inherited
       FROM pg_auth_members a
       JOIN pg_roles m ON m.oid = a.member
       JOIN pg_roles g ON g.oid = a.roleid
       WHERE m.rolname LIKE 'meal_agent%'
       ORDER BY m.rolname, g.rolname`,
    );
    assert.deepEqual(
      memberships.rows.map((row) => `${row.member} -> ${row.granted}`),
      [
        "meal_agent_backup_login -> meal_agent_backup",
        "meal_agent_migration_login -> meal_agent_migrator",
        "meal_agent_runtime_login -> meal_agent_app",
      ],
    );
    // 全部 membership 都是显式 SET ROLE，不继承。
    assert.deepEqual(
      memberships.rows.filter((row) => row.inherited),
      [],
    );
  });
});

test("readiness runs under the real runtime login and leaves no role or transaction behind", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: runtimeLoginUrl,
    WECHAT_ADAPTER: "fake",
  });
  const persistence = createPersistence(config);
  try {
    assert.equal(persistence.appRole, "meal_agent_app");
    assert.equal(await checkReadiness(persistence), true);

    // 连接归还池后不得残留 role 或事务上下文。
    const client = await persistence.pool.connect();
    try {
      const state = await client.query<{
        current: string;
        session: string;
        in_transaction: boolean;
      }>(
        `SELECT current_user AS current, session_user AS session,
                pg_current_xact_id_if_assigned() IS NOT NULL AS in_transaction`,
      );
      assert.equal(state.rows[0]?.current, "meal_agent_runtime_login");
      assert.equal(state.rows[0]?.session, "meal_agent_runtime_login");
      assert.equal(state.rows[0]?.in_transaction, false);
    } finally {
      client.release();
    }
  } finally {
    await persistence.pool.end();
  }
});

test("the runtime login cannot escalate, run DDL or bypass RLS", async () => {
  await withPool(runtimeLoginUrl, async (pool) => {
    // 不能进入 migrator / backup。
    for (const role of ["meal_agent_migrator", "meal_agent_backup"]) {
      const escalation = await attempt(pool, [
        `SELECT set_config('role', '${role}', true)`,
      ]);
      assert.notEqual(escalation, undefined, `must not reach ${role}`);
      assert.match(String(escalation), /permission denied|invalid value/i);
    }

    // 不能 DDL（即使已进入 meal_agent_app）。
    const ddl = await attempt(
      pool,
      ["CREATE TABLE public.stage09a_runtime_ddl (id int)"],
      "meal_agent_app",
    );
    assert.notEqual(ddl, undefined);
    assert.match(String(ddl), /permission denied/i);

    const drop = await attempt(
      pool,
      ["DROP TABLE public.households"],
      "meal_agent_app",
    );
    assert.notEqual(drop, undefined);
    assert.match(String(drop), /must be owner|permission denied/i);

    // 不能创建角色或数据库。
    const createRole = await attempt(pool, [
      "CREATE ROLE stage09a_should_not_exist",
    ]);
    assert.notEqual(createRole, undefined);
    assert.match(String(createRole), /permission denied/i);

    // 不能关闭 row security（没有 BYPASSRLS）。
    const bypass = await attempt(
      pool,
      ["SET LOCAL row_security = off", "SELECT count(*) FROM households"],
      "meal_agent_app",
    );
    assert.notEqual(bypass, undefined);
    assert.match(String(bypass), /row[- ]level security|permission denied/i);

    // FORCE RLS 生效：没有 household 上下文时读不到任何合成家庭。
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('role', $1, true)", [
        "meal_agent_app",
      ]);
      const visible = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM households",
      );
      assert.equal(visible.rows[0]?.count, "0");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

test("the backup role reads every synthetic household but cannot write or run DDL", async () => {
  await withPool(backupLoginUrl, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('role', $1, true)", [
        "meal_agent_backup",
      ]);
      // BYPASSRLS：FORCE RLS 下仍能完整导出两个家庭。
      const rows = await client.query<{ id: string }>(
        "SELECT id FROM households ORDER BY id",
      );
      assert.deepEqual(
        rows.rows.map((row) => row.id),
        [households.first, households.second],
      );
      // 0001 之后新建的表也可读（ALTER DEFAULT PRIVILEGES + 补授生效）。
      const invites = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM household_invites",
      );
      assert.equal(invites.rows[0]?.count, "0");
      const ledger = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__meal_agent_migrations",
      );
      assert.equal(ledger.rows[0]?.count, "5");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // 写操作与 DDL 全部拒绝。
    for (const statement of [
      "INSERT INTO households (id, name, timezone, locale, status, created_by_user_id, created_at, updated_at, version) VALUES ('018f0900-0000-7000-8000-0000000000ff', 'x', 'Asia/Shanghai', 'zh-CN', 'active', '018f0900-0000-7000-8000-0000000000a1', now(), now(), 0)",
      "UPDATE households SET name = 'tampered'",
      "DELETE FROM households",
      "CREATE TABLE public.stage09a_backup_ddl (id int)",
      "ALTER TABLE households ADD COLUMN tampered int",
    ]) {
      const failure = await attempt(pool, [statement], "meal_agent_backup");
      assert.notEqual(
        failure,
        undefined,
        `backup must not be able to run: ${statement.slice(0, 40)}`,
      );
      assert.match(String(failure), /permission denied|must be owner/i);
    }

    // 不能进入 migrator/app。
    for (const role of ["meal_agent_migrator", "meal_agent_app"]) {
      const escalation = await attempt(pool, [
        `SELECT set_config('role', '${role}', true)`,
      ]);
      assert.notEqual(escalation, undefined, `backup must not reach ${role}`);
    }
  });
});

test("re-running bootstrap is repeatable and does not widen privileges or destroy data", async () => {
  const snapshot = async (): Promise<string> =>
    withPool(adminUrl, async (pool) => {
      const roles = await pool.query(
        `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                rolreplication, rolbypassrls, rolcanlogin
         FROM pg_roles WHERE rolname LIKE 'meal_agent%' ORDER BY rolname`,
      );
      const members = await pool.query(
        `SELECT m.rolname AS member, g.rolname AS granted, a.inherit_option
         FROM pg_auth_members a
         JOIN pg_roles m ON m.oid = a.member
         JOIN pg_roles g ON g.oid = a.roleid
         WHERE m.rolname LIKE 'meal_agent%'
         ORDER BY m.rolname, g.rolname`,
      );
      return JSON.stringify({ roles: roles.rows, members: members.rows });
    });

  const before = await snapshot();

  await runBootstrap("handoff");
  await runBootstrap("logins");
  await runBootstrap("grants");

  assert.equal(await snapshot(), before, "bootstrap must be convergent");

  // 数据仍在。
  await withPool(backupLoginUrl, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('role', $1, true)", [
        "meal_agent_backup",
      ]);
      const rows = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM households",
      );
      assert.equal(rows.rows[0]?.count, "2");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  // readiness 依然通过。
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: runtimeLoginUrl,
    WECHAT_ADAPTER: "fake",
  });
  const persistence = createPersistence(config);
  try {
    assert.equal(await checkReadiness(persistence), true);
  } finally {
    await persistence.pool.end();
  }
});

test("a migration job fails within a bounded wait when another session holds the advisory lock", async () => {
  // advisory lock 的键空间按数据库隔离，持锁会话必须连到同一个数据库。
  const holder = new Pool({
    connectionString: `postgresql://postgres@${host}:${port}/${rolesDatabase}`,
    max: 1,
  });
  const client = await holder.connect();
  try {
    await client.query("SELECT pg_advisory_lock(938006001)");

    const lockWaitMs = 1_500;
    const startedAt = Date.now();
    await assert.rejects(
      applyMigrations(migrationLoginUrl, { lockWaitMs }),
      (error: unknown) => {
        assert.ok(
          error instanceof MigrationLockTimeoutError,
          `expected MigrationLockTimeoutError, received ${String(error)}`,
        );
        assert.match(String(error), /advisory lock/i);
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;

    // 有界：既真的等待过，也没有无限阻塞。
    assert.ok(
      elapsed >= lockWaitMs * 0.5,
      `expected to wait for the lock, waited ${String(elapsed)}ms`,
    );
    assert.ok(
      elapsed < lockWaitMs * 6,
      `expected a bounded failure, waited ${String(elapsed)}ms`,
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock(938006001)").catch(
      () => undefined,
    );
    client.release();
    await holder.end();
  }

  // 锁释放后恢复正常。
  await applyMigrations(migrationLoginUrl);
});
