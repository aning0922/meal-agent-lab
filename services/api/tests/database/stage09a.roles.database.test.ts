import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

import { loadConfig } from "../../src/config.js";
import {
  applyMigrations,
  MigrationLockTimeoutError,
  MigrationOptionError,
} from "../../src/database/migrate.js";
import { checkReadiness, createPersistence } from "../../src/database/pool.js";

/**
 * 阶段 09A / M2A：数据库身份、bootstrap、migration 与 readiness 权限边界。
 *
 * 本文件启动**专用**的一次性 PostgreSQL 18 集群，因为它需要共享集群没有的两个
 * 条件：真实的 scram-sha-256 host 认证，以及可被测试读取的服务端语句日志。
 *
 * 完整链路全部通过真实运维入口执行（bootstrap.sh 子进程 + db:migrate CLI 子
 * 进程），不直接调用内部函数冒充入口：
 *
 *   createdb
 *     → bootstrap.sh roles      角色基线（在冻结 0000 之前）
 *     → bootstrap.sh logins     SCRAM 口令
 *     → db:migrate --bootstrap-0000   （admin，唯一的窄例外）
 *     → bootstrap.sh handoff    owner 交接
 *     → db:migrate              （migration login，显式 SET ROLE）
 *     → bootstrap.sh grants     备份角色补授
 *     → readiness               （runtime login，事务内 SET LOCAL ROLE）
 *
 * 口令是本进程内临时生成的合成值，只经环境变量与 stdin 传递，不打印、不落盘、
 * 不进入 tracked 文件；断言失败信息里也不包含口令或完整日志。
 */

const postgresBin = process.env["PG_BIN"];
if (postgresBin === undefined || postgresBin === "") {
  throw new Error("PG_BIN is required");
}

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const apiDirectory = fileURLToPath(new URL("../../", import.meta.url));
const bootstrapScript = join(
  repositoryRoot,
  "infra/docker/postgres/bootstrap.sh",
);
const migrateEntry = join(apiDirectory, "src/database/migrate.ts");

const rolesDatabase = "meal_agent_stage09a_roles";

/** 合成口令：只存在于本进程内存与子进程环境中，从不打印。 */
const syntheticPassword = (): string => randomBytes(24).toString("base64url");
const passwords = {
  migration: syntheticPassword(),
  runtime: syntheticPassword(),
  backup: syntheticPassword(),
} as const;

let clusterRoot = "";
let dataDirectory = "";
let socketDirectory = "";
let serverLogPath = "";
let port = 0;
let clusterStarted = false;

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a test database port"));
        return;
      }
      const { port: allocated } = address;
      server.close(() => resolve(allocated));
    });
  });

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runCaptured = async (
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly stdin?: string;
  } = {},
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });

const mustSucceed = async (
  label: string,
  command: string,
  args: readonly string[],
  options: Parameters<typeof runCaptured>[2] = {},
): Promise<RunResult> => {
  const result = await runCaptured(command, args, options);
  assert.equal(
    result.code,
    0,
    // 只回显 stderr 的前若干字符；口令永远不会出现在这里，因为它只走 stdin/env。
    `${label} failed (exit ${String(result.code)}): ${result.stderr.slice(0, 600)}`,
  );
  return result;
};

/** 管理员走 Unix socket（trust）；三个 login 走 TCP（scram-sha-256）。 */
const adminEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  LC_ALL: process.env["LC_ALL"] ?? "C",
  PGHOST: socketDirectory,
  PGPORT: String(port),
  PGUSER: "postgres",
});

const adminPoolConfig = (database: string = rolesDatabase) => ({
  host: socketDirectory,
  port,
  user: "postgres",
  database,
});

const loginUrl = (role: string, password: string): string =>
  // base64url 口令只含 [A-Za-z0-9_-]，无需再做百分号编码。
  `postgresql://${role}:${password}@127.0.0.1:${String(port)}/${rolesDatabase}`;

/**
 * 管理员连接串走 Unix socket：pg_hba 对所有 TCP 登录强制 scram-sha-256，
 * 而 initdb 创建的 postgres 超级用户没有口令。这样「口令认证成立」的证据
 * 不会被任何 host trust 规则稀释。
 */
const adminUrl = (database: string = rolesDatabase): string =>
  `postgresql://postgres@/${database}` +
  `?host=${encodeURIComponent(socketDirectory)}&port=${String(port)}`;

const migrationLoginUrl = (): string =>
  loginUrl("meal_agent_migration_login", passwords.migration);
const runtimeLoginUrl = (): string =>
  loginUrl("meal_agent_runtime_login", passwords.runtime);
const backupLoginUrl = (): string =>
  loginUrl("meal_agent_backup_login", passwords.backup);

const runBootstrap = async (phase: string): Promise<RunResult> =>
  mustSucceed(`bootstrap ${phase}`, bootstrapScript, [
    phase,
    "--dbname",
    rolesDatabase,
  ], {
    env: {
      ...adminEnvironment(),
      PATH: `${postgresBin}:${process.env["PATH"] ?? ""}`,
      MEAL_AGENT_MIGRATION_PASSWORD: passwords.migration,
      MEAL_AGENT_RUNTIME_PASSWORD: passwords.runtime,
      MEAL_AGENT_BACKUP_PASSWORD: passwords.backup,
    },
  });

/** 通过真实 CLI 子进程运行 db:migrate，而不是直接调用内部函数。 */
const runMigrateCli = async (
  args: readonly string[],
  databaseUrl: string,
): Promise<RunResult> =>
  runCaptured(
    process.execPath,
    ["--import", "tsx", migrateEntry, ...args],
    {
      cwd: apiDirectory,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );

const withPool = async <T>(
  config: string | Record<string, unknown>,
  operation: (pool: Pool) => Promise<T>,
): Promise<T> => {
  const pool =
    typeof config === "string"
      ? new Pool({ connectionString: config, max: 2 })
      : new Pool({ ...config, max: 2 });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
};

/** 在事务内（可选）进入某角色后执行；返回失败信息，成功返回 undefined。 */
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

const asRole = async <T>(
  url: string,
  role: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> =>
  withPool(url, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('role', $1, false)", [role]);
      return await operation(client);
    } finally {
      client.release();
    }
  });

const households = {
  first: "018f0900-0000-7000-8000-000000000001",
  second: "018f0900-0000-7000-8000-000000000002",
} as const;
const owners = {
  first: "018f0900-0000-7000-8000-0000000000a1",
  second: "018f0900-0000-7000-8000-0000000000a2",
} as const;

const projectRoleSnapshot = async (): Promise<string> =>
  withPool(adminPoolConfig(), async (pool) => {
    const roles = await pool.query(
      `SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
              rolcreaterole, rolreplication, rolbypassrls, rolconnlimit,
              rolvaliduntil::text AS rolvaliduntil
       FROM pg_roles WHERE rolname LIKE 'meal\\_agent%' ORDER BY rolname`,
    );
    const memberships = await pool.query(
      `SELECT m.rolname AS member, g.rolname AS granted, gr.rolname AS grantor,
              a.admin_option, a.inherit_option, a.set_option
       FROM pg_auth_members a
       JOIN pg_roles m ON m.oid = a.member
       JOIN pg_roles g ON g.oid = a.roleid
       JOIN pg_roles gr ON gr.oid = a.grantor
       WHERE m.rolname LIKE 'meal\\_agent%' OR g.rolname LIKE 'meal\\_agent%'
       ORDER BY m.rolname, g.rolname, gr.rolname`,
    );
    const settings = await pool.query(
      `SELECT r.rolname, COALESCE(d.datname, '<global>') AS scope, s.setconfig
       FROM pg_db_role_setting s
       JOIN pg_roles r ON r.oid = s.setrole
       LEFT JOIN pg_database d ON d.oid = s.setdatabase
       WHERE r.rolname LIKE 'meal\\_agent%'
       ORDER BY r.rolname, scope`,
    );
    const databaseAcl = await pool.query(
      `SELECT candidate,
              has_database_privilege(candidate, current_database(), 'CONNECT') AS can_connect,
              has_database_privilege(candidate, current_database(), 'TEMP') AS can_temp,
              has_database_privilege(candidate, current_database(), 'CREATE') AS can_create
       FROM unnest(ARRAY[
         'public', 'meal_agent_migrator', 'meal_agent_app', 'meal_agent_backup',
         'meal_agent_migration_login', 'meal_agent_runtime_login',
         'meal_agent_backup_login'
       ]) AS candidate ORDER BY candidate`,
    );
    return JSON.stringify(
      {
        roles: roles.rows,
        memberships: memberships.rows,
        settings: settings.rows,
        databaseAcl: databaseAcl.rows,
      },
      null,
      1,
    );
  });

let baselineSnapshot = "";

before(async () => {
  clusterRoot = await mkdtemp(join(tmpdir(), "meal-agent-stage09a-roles-"));
  dataDirectory = join(clusterRoot, "data");
  socketDirectory = join(clusterRoot, "socket");
  serverLogPath = join(clusterRoot, "server.log");
  port = await freePort();
  await mkdir(socketDirectory);

  const environment = {
    ...process.env,
    LC_ALL: process.env["LC_ALL"] ?? "C",
  };

  await mustSucceed(
    "initdb",
    join(postgresBin, "initdb"),
    [
      "-D",
      dataDirectory,
      "--auth-local=trust",
      "--auth-host=scram-sha-256",
      "--username=postgres",
      "--encoding=UTF8",
      "--no-instructions",
    ],
    { env: environment },
  );

  // 管理员只走本地 socket（trust）；任何 TCP 登录都必须通过 scram-sha-256。
  // 这样「口令认证成立」的证据不会被 host trust 稀释。
  await writeFile(
    join(dataDirectory, "pg_hba.conf"),
    [
      "local   all   all                  trust",
      "host    all   all   127.0.0.1/32   scram-sha-256",
      "host    all   all   ::1/128        scram-sha-256",
      "",
    ].join("\n"),
    "utf8",
  );

  await mustSucceed(
    "pg_ctl start",
    join(postgresBin, "pg_ctl"),
    [
      "-D",
      dataDirectory,
      "-l",
      serverLogPath,
      "-o",
      `-F -p ${String(port)} -h 127.0.0.1 -k ${socketDirectory} ` +
        "-c log_statement=all -c log_connections=on -c log_min_messages=log",
      "-w",
      "start",
    ],
    { env: environment },
  );
  clusterStarted = true;

  await mustSucceed(
    "createdb",
    join(postgresBin, "createdb"),
    [rolesDatabase],
    { env: adminEnvironment() },
  );

  // 1. 角色基线（可以且确实在冻结的 0000 之前执行）。
  await runBootstrap("roles");
  // 2. SCRAM 口令。
  await runBootstrap("logins");
  // 3. admin 通过真实 CLI 的窄 bootstrap 模式应用 0000。
  await mustSucceedCli(
    "db:migrate --bootstrap-0000",
    await runMigrateCli(["--bootstrap-0000"], adminUrl()),
  );
  // 4. owner 交接。
  await runBootstrap("handoff");
  // 5. migration login 用默认命令完成 0001—0004。
  await mustSucceedCli(
    "db:migrate (migration login)",
    await runMigrateCli([], migrationLoginUrl()),
  );
  // 6. 备份角色补授。
  await runBootstrap("grants");

  // 合成数据：两个家庭，用于验证 backup 能跨 FORCE RLS 完整读取。
  await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
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
  });

  baselineSnapshot = await projectRoleSnapshot();
});

// 3 号步骤的 admin CLI 走 TCP，但 pg_hba 要求 scram；postgres 没有口令，因此
// 这里改用 socket。辅助函数放在 before 之后声明会被提升，故单独定义。
async function mustSucceedCli(label: string, result: RunResult): Promise<void> {
  assert.equal(
    result.code,
    0,
    `${label} failed (exit ${String(result.code)}): ${result.stderr.slice(0, 800)}`,
  );
}

after(async () => {
  if (clusterStarted) {
    await runCaptured(
      join(postgresBin, "pg_ctl"),
      ["-D", dataDirectory, "-m", "immediate", "-w", "stop"],
      { env: { ...process.env, LC_ALL: process.env["LC_ALL"] ?? "C" } },
    ).catch(() => undefined);
  }
  if (clusterRoot !== "") {
    await rm(clusterRoot, { recursive: true, force: true });
  }
});

test("the role baseline normalizes attributes, config and the exact membership graph", async () => {
  await withPool(adminPoolConfig(), async (pool) => {
    const roles = await pool.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolconnlimit: number;
      rolvaliduntil: string | null;
    }>(
      `SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
              rolcreaterole, rolreplication, rolbypassrls, rolconnlimit,
              rolvaliduntil::text AS rolvaliduntil
       FROM pg_roles WHERE rolname LIKE 'meal\\_agent%' ORDER BY rolname`,
    );
    const byName = new Map(roles.rows.map((row) => [row.rolname, row]));
    assert.equal(byName.size, 6, "exactly six project roles");

    for (const name of [
      "meal_agent_migrator",
      "meal_agent_app",
      "meal_agent_backup",
    ]) {
      const row = byName.get(name);
      assert.deepEqual(
        {
          login: row?.rolcanlogin,
          super: row?.rolsuper,
          createdb: row?.rolcreatedb,
          createrole: row?.rolcreaterole,
          replication: row?.rolreplication,
        },
        {
          login: false,
          super: false,
          createdb: false,
          createrole: false,
          replication: false,
        },
        `${name} business-role baseline`,
      );
    }
    // BYPASSRLS 是按职责精确设置的，不是一刀切。
    assert.equal(byName.get("meal_agent_migrator")?.rolbypassrls, true);
    assert.equal(byName.get("meal_agent_backup")?.rolbypassrls, true);
    assert.equal(byName.get("meal_agent_app")?.rolbypassrls, false);

    for (const name of [
      "meal_agent_migration_login",
      "meal_agent_runtime_login",
      "meal_agent_backup_login",
    ]) {
      const row = byName.get(name);
      assert.deepEqual(
        {
          login: row?.rolcanlogin,
          inherit: row?.rolinherit,
          super: row?.rolsuper,
          createdb: row?.rolcreatedb,
          createrole: row?.rolcreaterole,
          replication: row?.rolreplication,
          bypassrls: row?.rolbypassrls,
        },
        {
          login: true,
          inherit: false,
          super: false,
          createdb: false,
          createrole: false,
          replication: false,
          bypassrls: false,
        },
        `${name} login baseline`,
      );
      // connection limit 与 valid until 都是显式值，不是默认的 -1/NULL。
      assert.equal(
        (row?.rolconnlimit ?? -1) > 0,
        true,
        `${name} must declare an explicit connection limit`,
      );
      assert.equal(row?.rolvaliduntil, "infinity");
    }

    // 没有任何残留的 role-level GUC 配置（全局与每库都算）。
    const settings = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_db_role_setting s
       JOIN pg_roles r ON r.oid = s.setrole
       WHERE r.rolname LIKE 'meal\\_agent%'`,
    );
    assert.equal(settings.rows[0]?.count, "0");

    // membership 恰好三条边，选项完全确定。
    const memberships = await pool.query<{
      member: string;
      granted: string;
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }>(
      `SELECT m.rolname AS member, g.rolname AS granted,
              a.admin_option, a.inherit_option, a.set_option
       FROM pg_auth_members a
       JOIN pg_roles m ON m.oid = a.member
       JOIN pg_roles g ON g.oid = a.roleid
       WHERE m.rolname LIKE 'meal\\_agent%' OR g.rolname LIKE 'meal\\_agent%'
       ORDER BY m.rolname`,
    );
    assert.deepEqual(
      memberships.rows.map(
        (row) =>
          `${row.member} -> ${row.granted} ` +
          `[admin=${String(row.admin_option)} ` +
          `inherit=${String(row.inherit_option)} ` +
          `set=${String(row.set_option)}]`,
      ),
      [
        "meal_agent_backup_login -> meal_agent_backup " +
          "[admin=false inherit=false set=true]",
        "meal_agent_migration_login -> meal_agent_migrator " +
          "[admin=false inherit=false set=true]",
        "meal_agent_runtime_login -> meal_agent_app " +
          "[admin=false inherit=false set=true]",
      ],
    );
  });
});

test("the target database grants only CONNECT to the login roles and nothing to PUBLIC", async () => {
  await withPool(adminPoolConfig(), async (pool) => {
    const acl = await pool.query<{
      candidate: string;
      can_connect: boolean;
      can_temp: boolean;
    }>(
      `SELECT candidate,
              has_database_privilege(candidate, current_database(), 'CONNECT') AS can_connect,
              has_database_privilege(candidate, current_database(), 'TEMP') AS can_temp
       FROM unnest(ARRAY[
         'public', 'meal_agent_app', 'meal_agent_backup',
         'meal_agent_migration_login', 'meal_agent_runtime_login',
         'meal_agent_backup_login'
       ]) AS candidate ORDER BY candidate`,
    );
    const byName = new Map(acl.rows.map((row) => [row.candidate, row]));

    // PUBLIC 既不能连接也不能建临时对象。
    assert.deepEqual(
      {
        connect: byName.get("public")?.can_connect,
        temp: byName.get("public")?.can_temp,
      },
      { connect: false, temp: false },
    );

    // 三个 login 恰好只有 CONNECT。
    for (const name of [
      "meal_agent_migration_login",
      "meal_agent_runtime_login",
      "meal_agent_backup_login",
    ]) {
      assert.deepEqual(
        { connect: byName.get(name)?.can_connect, temp: byName.get(name)?.can_temp },
        { connect: true, temp: false },
        `${name} database privileges`,
      );
    }

    // app/backup 不得具有 TEMP。
    for (const name of ["meal_agent_app", "meal_agent_backup"]) {
      assert.equal(byName.get(name)?.can_temp, false, `${name} must not hold TEMP`);
    }

    // 登录角色除目标数据库 CONNECT 外，没有任何**直接**授予的
    // schema/table/sequence/function 权限。
    //
    // 这里检查 ACL 里的具名授予，而不是 has_*_privilege()：schema public 的
    // USAGE 由 PostgreSQL 默认授予 PUBLIC，任何角色都因此可见，那不是对登录
    // 角色的直接授予。
    const directTables = await pool.query<{ grantee: string }>(
      `SELECT DISTINCT grantee FROM information_schema.table_privileges
       WHERE grantee LIKE 'meal\\_agent%\\_login'`,
    );
    assert.deepEqual(directTables.rows, []);

    const directSchemas = await pool.query<{ entry: string }>(
      `SELECT n.nspname || ':' || pg_get_userbyid(acl.grantee) || ':' ||
              acl.privilege_type AS entry
       FROM pg_namespace n, aclexplode(n.nspacl) AS acl
       WHERE n.nspname IN ('public', 'drizzle', 'meal_agent_private')
         AND acl.grantee <> 0
         AND pg_get_userbyid(acl.grantee) LIKE 'meal\\_agent%\\_login'`,
    );
    assert.deepEqual(directSchemas.rows, []);

    const directRoutines = await pool.query<{ grantee: string }>(
      `SELECT DISTINCT grantee FROM information_schema.routine_privileges
       WHERE grantee LIKE 'meal\\_agent%\\_login'`,
    );
    assert.deepEqual(directRoutines.rows, []);
  });
});

test("passwords are stored as SCRAM verifiers and never reach the server log", async () => {
  await withPool(adminPoolConfig(), async (pool) => {
    const stored = await pool.query<{ rolname: string; kind: string }>(
      `SELECT rolname, left(rolpassword, 13) AS kind FROM pg_authid
       WHERE rolname LIKE 'meal\\_agent%\\_login' ORDER BY rolname`,
    );
    assert.deepEqual(
      stored.rows.map((row) => `${row.rolname}=${row.kind}`),
      [
        "meal_agent_backup_login=SCRAM-SHA-256",
        "meal_agent_migration_login=SCRAM-SHA-256",
        "meal_agent_runtime_login=SCRAM-SHA-256",
      ],
    );
  });

  // 服务端开启了 log_statement=all；原始口令不得出现在日志中的任何位置。
  const serverLog = await readFile(serverLogPath, "utf8");
  for (const [label, password] of Object.entries(passwords)) {
    assert.equal(
      serverLog.includes(password),
      false,
      // 断言信息里不包含口令本身，也不回显日志。
      `the ${label} password must never appear in the server log`,
    );
  }
  // 反向自检：日志确实在记录语句，否则上面的断言是空洞的。
  assert.equal(serverLog.includes("statement:"), true);
  assert.equal(serverLog.includes("ALTER ROLE"), true);
});

test("scram-sha-256 host authentication accepts the real password and rejects a wrong one", async () => {
  // 正确口令：TCP + scram 登录成功，并且身份就是登录角色本身。
  const authenticated = await withPool(runtimeLoginUrl(), async (pool) => {
    const result = await pool.query<{ current: string }>(
      "SELECT current_user AS current",
    );
    return result.rows[0]?.current;
  });
  assert.equal(authenticated, "meal_agent_runtime_login");

  // 错误口令：必须被拒绝。
  const wrongPool = new Pool({
    connectionString: loginUrl(
      "meal_agent_runtime_login",
      `${passwords.runtime}-wrong`,
    ),
    max: 1,
  });
  try {
    await assert.rejects(
      wrongPool.query("SELECT 1"),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /password authentication failed/i);
        return true;
      },
    );
  } finally {
    await wrongPool.end().catch(() => undefined);
  }
});

test("the real CLI applies 0000 as admin and 0001-0004 as the migration login", async () => {
  await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
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
  });

  await withPool(migrationLoginUrl(), async (pool) => {
    // NOINHERIT：不 SET ROLE 时连 ledger 都读不到，也没有 DDL 能力。
    const ledger = await attempt(pool, [
      "SELECT name FROM drizzle.__meal_agent_migrations",
    ]);
    assert.match(String(ledger), /permission denied/i);
    const ddl = await attempt(pool, [
      "CREATE TABLE public.stage09a_should_not_exist (id int)",
    ]);
    assert.match(String(ddl), /permission denied/i);
    // 显式进入 migrator 后才具备 DDL 能力。
    assert.equal(
      await attempt(
        pool,
        ["CREATE TABLE public.stage09a_rolled_back (id int)"],
        "meal_agent_migrator",
      ),
      undefined,
    );
  });
});

test("the CLI rejects unknown, repeated and combined arguments", async () => {
  const url = migrationLoginUrl();
  for (const args of [
    ["--role=postgres"],
    ["--only-through=0004_stage_08_final_closeout.sql"],
    ["--bootstrap-0000", "--role=postgres"],
    ["--bootstrap-0000", "--bootstrap-0000"],
    ["--bootstrap-0001"],
    ["bootstrap"],
    ["--bootstrap-0000", "extra"],
  ]) {
    const result = await runMigrateCli(args, url);
    assert.notEqual(
      result.code,
      0,
      `CLI must reject ${JSON.stringify(args)}`,
    );
    assert.match(result.stderr, /MigrationCliUsageError|Usage: db:migrate/);
  }
});

test("re-running the migration CLI is idempotent and checksum drift still fails closed", async () => {
  await mustSucceedCli(
    "second db:migrate",
    await runMigrateCli([], migrationLoginUrl()),
  );

  const originalHash = await asRole(
    migrationLoginUrl(),
    "meal_agent_migrator",
    async (client) => {
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__meal_agent_migrations",
      );
      assert.equal(count.rows[0]?.count, "5");
      const stored = await client.query<{ hash: string }>(
        `SELECT hash FROM drizzle.__meal_agent_migrations
         WHERE name = '0001_stage_08.sql'`,
      );
      return stored.rows[0]?.hash;
    },
  );
  assert.equal(typeof originalHash, "string");

  await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
    await client.query(
      `UPDATE drizzle.__meal_agent_migrations
       SET hash = repeat('0', 64) WHERE name = '0001_stage_08.sql'`,
    );
  });

  const drifted = await runMigrateCli([], migrationLoginUrl());
  assert.notEqual(drifted.code, 0);
  assert.match(drifted.stderr, /changed checksum/);

  await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
    await client.query(
      `UPDATE drizzle.__meal_agent_migrations SET hash = $1
       WHERE name = '0001_stage_08.sql'`,
      [originalHash],
    );
  });
  await mustSucceedCli(
    "restored db:migrate",
    await runMigrateCli([], migrationLoginUrl()),
  );
});

test("readiness runs under the real runtime login and leaves no role or transaction behind", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: runtimeLoginUrl(),
    WECHAT_ADAPTER: "fake",
  });
  const persistence = createPersistence(config);
  try {
    assert.equal(persistence.appRole, "meal_agent_app");
    assert.equal(await checkReadiness(persistence), true);

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

test("the runtime login cannot escalate, run DDL, create temp objects or bypass RLS", async () => {
  await withPool(runtimeLoginUrl(), async (pool) => {
    for (const role of ["meal_agent_migrator", "meal_agent_backup"]) {
      const escalation = await attempt(pool, [
        `SELECT set_config('role', '${role}', true)`,
      ]);
      assert.match(
        String(escalation),
        /permission denied|invalid value/i,
        `runtime must not reach ${role}`,
      );
    }

    assert.match(
      String(
        await attempt(
          pool,
          ["CREATE TABLE public.stage09a_runtime_ddl (id int)"],
          "meal_agent_app",
        ),
      ),
      /permission denied/i,
    );
    assert.match(
      String(
        await attempt(pool, ["DROP TABLE public.households"], "meal_agent_app"),
      ),
      /must be owner|permission denied/i,
    );
    assert.match(
      String(await attempt(pool, ["CREATE ROLE stage09a_should_not_exist"])),
      /permission denied/i,
    );
    // 数据库级 TEMPORARY 已被收回。
    assert.match(
      String(
        await attempt(
          pool,
          ["CREATE TEMP TABLE stage09a_temp (id int)"],
          "meal_agent_app",
        ),
      ),
      /permission denied/i,
    );
    assert.match(
      String(
        await attempt(
          pool,
          ["SET LOCAL row_security = off", "SELECT count(*) FROM households"],
          "meal_agent_app",
        ),
      ),
      /row[- ]level security|permission denied/i,
    );

    // FORCE RLS：没有 household 上下文时读不到任何合成家庭。
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
  await withPool(backupLoginUrl(), async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('role', $1, true)", [
        "meal_agent_backup",
      ]);
      const rows = await client.query<{ id: string }>(
        "SELECT id FROM households ORDER BY id",
      );
      assert.deepEqual(
        rows.rows.map((row) => row.id),
        [households.first, households.second],
      );
      const invites = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM household_invites",
      );
      assert.equal(invites.rows[0]?.count, "0");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    for (const statement of [
      "UPDATE households SET name = 'tampered'",
      "DELETE FROM households",
      "CREATE TABLE public.stage09a_backup_ddl (id int)",
      "ALTER TABLE households ADD COLUMN tampered int",
    ]) {
      assert.match(
        String(await attempt(pool, [statement], "meal_agent_backup")),
        /permission denied|must be owner/i,
        `backup must not run: ${statement.slice(0, 40)}`,
      );
    }

    for (const role of ["meal_agent_migrator", "meal_agent_app"]) {
      assert.notEqual(
        await attempt(pool, [`SELECT set_config('role', '${role}', true)`]),
        undefined,
        `backup must not reach ${role}`,
      );
    }
  });
});

test("deliberate privilege drift is converged back to the exact baseline by re-running bootstrap", async () => {
  // 故意在四个维度上扩大权限。
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("CREATE ROLE stage09a_drift_intruder NOLOGIN");
    // 1. 角色属性
    await pool.query(
      "ALTER ROLE meal_agent_app CREATEDB BYPASSRLS LOGIN INHERIT",
    );
    await pool.query(
      "ALTER ROLE meal_agent_runtime_login CONNECTION LIMIT -1 INHERIT " +
        "VALID UNTIL '2030-01-01'",
    );
    // 2. role config，含 RESET ALL 不会清掉的每库设置
    await pool.query(
      "ALTER ROLE meal_agent_runtime_login SET statement_timeout = '9s'",
    );
    await pool.query(
      `ALTER ROLE meal_agent_runtime_login IN DATABASE ${rolesDatabase} ` +
        "SET work_mem = '128MB'",
    );
    // 3. membership：越权边、外部角色进入项目角色，以及由**其他 grantor**
    //    授予的边（不带 GRANTED BY 的 REVOKE 清不掉它）
    await pool.query(
      "GRANT meal_agent_migrator TO meal_agent_runtime_login",
    );
    await pool.query("GRANT meal_agent_app TO stage09a_drift_intruder");
    await pool.query(
      "GRANT meal_agent_backup TO meal_agent_migration_login " +
        "WITH ADMIN TRUE, INHERIT TRUE, SET TRUE",
    );
    // 4. 数据库级权限
    await pool.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${rolesDatabase} TO PUBLIC`,
    );
    await pool.query(
      `GRANT ALL ON DATABASE ${rolesDatabase} TO meal_agent_runtime_login`,
    );
    await pool.query(
      `GRANT TEMPORARY ON DATABASE ${rolesDatabase} TO meal_agent_app`,
    );
  });

  const drifted = await projectRoleSnapshot();
  assert.notEqual(drifted, baselineSnapshot, "drift must actually change state");

  // 重跑 bootstrap 的角色基线。
  await runBootstrap("roles");

  assert.equal(
    await projectRoleSnapshot(),
    baselineSnapshot,
    "re-running the role baseline must converge to the exact baseline",
  );

  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("DROP ROLE IF EXISTS stage09a_drift_intruder");
  });

  // 收敛之后 readiness 仍然通过，数据仍在。
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: runtimeLoginUrl(),
    WECHAT_ADAPTER: "fake",
  });
  const persistence = createPersistence(config);
  try {
    assert.equal(await checkReadiness(persistence), true);
  } finally {
    await persistence.pool.end();
  }
  await asRole(backupLoginUrl(), "meal_agent_backup", async (client) => {
    const rows = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM households",
    );
    assert.equal(rows.rows[0]?.count, "2");
  });
});

test("re-running handoff and grants is repeatable and keeps ownership stable", async () => {
  const owners = async (): Promise<string> =>
    withPool(adminPoolConfig(), async (pool) => {
      const result = await pool.query(
        `SELECT n.nspname || '.' || c.relname AS relation,
                pg_catalog.pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p')
         ORDER BY 1`,
      );
      return JSON.stringify(result.rows);
    });

  const before = await owners();
  await runBootstrap("handoff");
  await runBootstrap("grants");
  assert.equal(await owners(), before);
});

test("owner handoff refuses to take ownership of an unmanaged table", async () => {
  // 由 bootstrap admin 直接建表：它不在 allowlist 里，handoff 必须报告并失败，
  // 而不是静默把它的所有权夺给 migrator。
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("CREATE TABLE public.stage09a_unmanaged (id int)");
  });
  try {
    const result = await runCaptured(bootstrapScript, [
      "handoff",
      "--dbname",
      rolesDatabase,
    ], {
      env: {
        ...adminEnvironment(),
        PATH: `${postgresBin}:${process.env["PATH"] ?? ""}`,
      },
    });
    assert.notEqual(result.code, 0, "handoff must fail on an unmanaged table");
    assert.match(result.stderr, /unmanaged table/i);
    assert.match(result.stderr, /stage09a_unmanaged/);
  } finally {
    await withPool(adminPoolConfig(), async (pool) => {
      await pool.query("DROP TABLE IF EXISTS public.stage09a_unmanaged");
    });
  }
});

test("bootstrap rejects connection strings and foreign database names", async () => {
  for (const candidate of [
    `postgresql://postgres@127.0.0.1:${String(port)}/${rolesDatabase}`,
    `host=127.0.0.1 dbname=${rolesDatabase}`,
    "postgres",
    "template1",
    "meal_agent; DROP DATABASE x",
    "MEAL_AGENT",
    "",
  ]) {
    const result = await runCaptured(bootstrapScript, [
      "roles",
      "--dbname",
      candidate,
    ], {
      env: {
        ...adminEnvironment(),
        PATH: `${postgresBin}:${process.env["PATH"] ?? ""}`,
      },
    });
    assert.notEqual(
      result.code,
      0,
      `--dbname must reject ${JSON.stringify(candidate)}`,
    );
    assert.match(result.stderr, /--dbname must be/);
  }
});

test("bootstrap phases fail closed when run out of order", async () => {
  const otherDatabase = "meal_agent_stage09a_order";
  await withPool(adminPoolConfig("postgres"), async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS ${otherDatabase}`);
    await pool.query(`CREATE DATABASE ${otherDatabase}`);
  });
  try {
    const environment = {
      ...adminEnvironment(),
      PATH: `${postgresBin}:${process.env["PATH"] ?? ""}`,
    };
    // handoff 早于 0000：必须明确失败。
    const handoff = await runCaptured(bootstrapScript, [
      "handoff",
      "--dbname",
      otherDatabase,
    ], { env: environment });
    assert.notEqual(handoff.code, 0);
    assert.match(handoff.stderr, /migration ledger is missing|bootstrap-0000/i);

    // grants 早于 handoff：必须明确失败。
    const grants = await runCaptured(bootstrapScript, [
      "grants",
      "--dbname",
      otherDatabase,
    ], { env: environment });
    assert.notEqual(grants.code, 0);
    assert.match(grants.stderr, /migration ledger is missing|handoff/i);
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${otherDatabase}`);
    });
  }
});

test("a migration job fails within a bounded wait when another session holds the advisory lock", async () => {
  const holder = new Pool({ ...adminPoolConfig(), max: 1 });
  const client = await holder.connect();
  try {
    await client.query("SELECT pg_advisory_lock(938006001)");

    const lockWaitMs = 1_500;
    const startedAt = Date.now();
    await assert.rejects(
      applyMigrations(migrationLoginUrl(), { lockWaitMs }),
      (error: unknown) => {
        assert.ok(
          error instanceof MigrationLockTimeoutError,
          `expected MigrationLockTimeoutError, received ${String(error)}`,
        );
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed >= lockWaitMs * 0.5,
      `expected a real wait, waited ${String(elapsed)}ms`,
    );
    assert.ok(
      elapsed < lockWaitMs * 6,
      `expected a bounded failure, waited ${String(elapsed)}ms`,
    );
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(938006001)")
      .catch(() => undefined);
    client.release();
    await holder.end();
  }

  await mustSucceedCli(
    "db:migrate after advisory unlock",
    await runMigrateCli([], migrationLoginUrl()),
  );
});

test("a migration job fails within a bounded wait when the ledger table is locked", async () => {
  // CREATE TABLE IF NOT EXISTS 在表已存在时不取冲突锁，真正阻塞的是 ledger
  // 的 SELECT（ACCESS SHARE 与 ACCESS EXCLUSIVE 冲突），由 lock_timeout 兜底。
  const holder = new Pool({ ...adminPoolConfig(), max: 1 });
  const client = await holder.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "LOCK TABLE drizzle.__meal_agent_migrations IN ACCESS EXCLUSIVE MODE",
    );

    const lockWaitMs = 1_500;
    const startedAt = Date.now();
    await assert.rejects(
      applyMigrations(migrationLoginUrl(), { lockWaitMs }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /lock timeout/i);
        assert.equal(
          (error as { code?: string }).code,
          "55P03",
          `expected SQLSTATE 55P03, received ${String((error as { code?: string }).code)}`,
        );
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed >= lockWaitMs * 0.5,
      `expected a real wait, waited ${String(elapsed)}ms`,
    );
    assert.ok(
      elapsed < lockWaitMs * 6,
      `expected a bounded failure, waited ${String(elapsed)}ms`,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await holder.end();
  }

  await mustSucceedCli(
    "db:migrate after table unlock",
    await runMigrateCli([], migrationLoginUrl()),
  );
});

test("invalid bounded-wait options are rejected before any connection is opened", async () => {
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    await assert.rejects(
      applyMigrations(migrationLoginUrl(), { lockWaitMs: invalid }),
      MigrationOptionError,
      `lockWaitMs ${String(invalid)} must be rejected`,
    );
    await assert.rejects(
      applyMigrations(migrationLoginUrl(), { connectionTimeoutMs: invalid }),
      MigrationOptionError,
      `connectionTimeoutMs ${String(invalid)} must be rejected`,
    );
  }
});
