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
  migrationLimits,
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
 *   bootstrap.sh cluster      角色基线（**早于 createdb**，pristine 首次执行）
 *     → bootstrap.sh logins     SCRAM 口令
 *     → createdb
 *     → pnpm db:bootstrap       （admin，独立零参数入口，应用冻结的 0000）
 *     → bootstrap.sh handoff    owner 交接（fresh-install，0000-only）
 *     → bootstrap.sh acl        目标数据库 ACL 基线
 *     → pnpm db:migrate         （migration login，显式 SET ROLE，零参数）
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
const bootstrapScript = join(
  repositoryRoot,
  "infra/docker/postgres/bootstrap.sh",
);

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

/** bootstrap 环境：口令只经环境传入，绝不进入命令行。 */
const bootstrapEnvironment = (): NodeJS.ProcessEnv => ({
  ...adminEnvironment(),
  PATH: `${postgresBin}:${process.env["PATH"] ?? ""}`,
  MEAL_AGENT_MIGRATION_PASSWORD: passwords.migration,
  MEAL_AGENT_RUNTIME_PASSWORD: passwords.runtime,
  MEAL_AGENT_BACKUP_PASSWORD: passwords.backup,
});

/** cluster scope 连 maintenance DB；database scope 连目标库。 */
const bootstrapArguments = (
  phase: string,
  database: string = rolesDatabase,
): readonly string[] =>
  phase === "cluster" || phase === "logins"
    ? [phase, "--maintenance-db", "postgres"]
    : [phase, "--dbname", database];

const bootstrap = async (
  phase: string,
  database?: string,
): Promise<RunResult> =>
  runCaptured(bootstrapScript, bootstrapArguments(phase, database), {
    env: bootstrapEnvironment(),
  });

const runBootstrap = async (
  phase: string,
  database?: string,
): Promise<RunResult> => {
  const result = await bootstrap(phase, database);
  assert.equal(
    result.code,
    0,
    `bootstrap ${phase} failed (exit ${String(result.code)}): ` +
      `${result.stderr.slice(0, 700)}`,
  );
  return result;
};

/**
 * 原样 spawn README 里的 pnpm 命令，而不是 `node --import tsx migrate.ts`。
 * 这样测试覆盖的就是运维实际会敲的入口，包括 pnpm 的参数传递语义。
 */
const runPnpm = async (
  script: "db:bootstrap" | "db:migrate",
  databaseUrl: string,
  extraArgs: readonly string[] = [],
): Promise<RunResult> =>
  runCaptured(
    "pnpm",
    ["--filter", "@meal-agent/api", script, ...extraArgs],
    {
      cwd: repositoryRoot,
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

  // 1. cluster scope 角色基线。**在目标库存在之前**首次执行——这是 pristine
  //    集群上的首次证据，不是角色已存在后的幂等重跑。
  await runBootstrap("cluster");
  // 2. SCRAM 口令（同样是 cluster scope，同样早于 createdb）。
  await runBootstrap("logins");
  // 3. 目标库现在才创建。
  await mustSucceed(
    "createdb",
    join(postgresBin, "createdb"),
    [rolesDatabase],
    { env: adminEnvironment() },
  );
  // 4. admin 通过真实 pnpm 入口应用冻结的 0000。
  await mustSucceedCli(
    "pnpm db:bootstrap",
    await runPnpm("db:bootstrap", adminUrl()),
  );
  // 5. owner 交接（仅全新安装路径）。
  await runBootstrap("handoff");
  // 6. 目标数据库 ACL 基线。
  await runBootstrap("acl");
  // 7. migration login 用真实 pnpm 默认命令完成 0001—0004。
  await mustSucceedCli(
    "pnpm db:migrate",
    await runPnpm("db:migrate", migrationLoginUrl()),
  );
  // 8. 备份角色补授。
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
    const result = await runPnpm("db:migrate", url, args);
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
    await runPnpm("db:migrate", migrationLoginUrl()),
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

  const drifted = await runPnpm("db:migrate", migrationLoginUrl());
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
    await runPnpm("db:migrate", migrationLoginUrl()),
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

  // 重跑**完整** baseline：cluster scope（角色/config/membership）与
  // database scope（数据库 ACL、public schema、对象授权）。
  await runBootstrap("cluster");
  await runBootstrap("acl");

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

test("re-running acl and grants is repeatable and keeps ownership stable", async () => {
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
  // handoff 是 fresh-install 的 0000-only 步骤，完整 migration 之后不再适用；
  // 可复用的是 acl 与 grants。
  await runBootstrap("acl");
  await runBootstrap("grants");
  assert.equal(await owners(), before);
});

test("owner handoff refuses unmanaged objects on a 0000-only database", async () => {
  // 在独立的全新库上重放 fresh-install 前半段，然后注入各类未管理对象，
  // 逐个证明 handoff 在**没有做过任何 ownership 变更**的情况下失败。
  const probe = "meal_agent_stage09a_handoff";
  await withPool(adminPoolConfig("postgres"), async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    await pool.query(`CREATE DATABASE ${probe}`);
  });
  try {
    await mustSucceedCli(
      "pnpm db:bootstrap (handoff probe)",
      await runPnpm("db:bootstrap", adminUrl(probe)),
    );

    const ownerSnapshot = async (): Promise<string> =>
      withPool(adminPoolConfig(probe), async (pool) => {
        const result = await pool.query(
          `SELECT 'db:' || d.datname AS ident,
                  pg_catalog.pg_get_userbyid(d.datdba) AS owner
             FROM pg_database d WHERE d.datname = current_database()
           UNION ALL
           SELECT 'schema:' || nspname, pg_catalog.pg_get_userbyid(nspowner)
             FROM pg_namespace
            WHERE nspname IN ('public','drizzle','meal_agent_private')
           UNION ALL
           SELECT 'rel:' || n.nspname || '.' || c.relname,
                  pg_catalog.pg_get_userbyid(c.relowner)
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public','drizzle')
              AND c.relkind IN ('r','p','v','m','S')
           ORDER BY 1`,
        );
        return JSON.stringify(result.rows);
      });

    const injections: readonly [string, readonly string[], RegExp][] = [
      ["public view", ["CREATE VIEW public.stage09a_v AS SELECT 1 AS x"],
        /unexpected object\(s\) in public/i],
      ["public sequence", ["CREATE SEQUENCE public.stage09a_s"],
        /unexpected object\(s\) in public/i],
      ["public routine", [
        "CREATE FUNCTION public.stage09a_f() RETURNS int LANGUAGE sql " +
          "SECURITY DEFINER AS $$SELECT 1$$",
      ], /unexpected routine\(s\) in public/i],
      ["private routine", [
        "CREATE FUNCTION meal_agent_private.stage09a_p() RETURNS int " +
          "LANGUAGE sql AS $$SELECT 1$$",
      ], /unexpected or mis-owned routine/i],
      ["custom schema", ["CREATE SCHEMA stage09a_extra"],
        /unexpected schema/i],
      ["user type", ["CREATE TYPE public.stage09a_t AS (a int)"],
        /unexpected object|unexpected user-defined type/i],
      ["pre-created 0001 table", [
        "CREATE TABLE public.household_invites (id uuid PRIMARY KEY)",
      ], /unexpected object\(s\) in public/i],
      ["dropped 0000 table", ["DROP TABLE public.sessions CASCADE"],
        /table\(s\) missing|unexpected/i],
      ["tampered ledger checksum", [
        "UPDATE drizzle.__meal_agent_migrations SET hash = repeat('0', 64)",
      ], /checksum does not match/i],
    ];

    for (const [label, statements, expected] of injections) {
      await withPool(adminPoolConfig(probe), async (pool) => {
        for (const statement of statements) {
          await pool.query(statement);
        }
      });
      // 注入之后、handoff 之前取快照：handoff 失败后归属必须与此完全一致。
      const before = await ownerSnapshot();
      const result = await bootstrap("handoff", probe);
      assert.notEqual(result.code, 0, `handoff must reject: ${label}`);
      assert.match(result.stderr, expected, `wrong reason for: ${label}`);
      // 失败后 owner 快照必须完全不变。
      assert.equal(
        await ownerSnapshot(),
        before,
        `handoff mutated ownership before failing on: ${label}`,
      );
      // 还原注入，供下一个用例使用。
      await withPool(adminPoolConfig("postgres"), async (pool) => {
        await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
        await pool.query(`CREATE DATABASE ${probe}`);
      });
      await mustSucceedCli(
        `pnpm db:bootstrap (reset after ${label})`,
        await runPnpm("db:bootstrap", adminUrl(probe)),
      );
    }

    // 干净的 0000-only 库上 handoff 必须成功。
    await runBootstrap("handoff", probe);
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
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
      "acl",
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
    await runPnpm("db:migrate", migrationLoginUrl()),
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
    await runPnpm("db:migrate", migrationLoginUrl()),
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

// ---------------------------------------------------------------------------
// 第二轮整改新增证据
// ---------------------------------------------------------------------------

test("the cluster baseline runs before the target database exists and enables createdb --owner", async () => {
  // M4 恢复顺序的前置证据：cluster scope 只连 maintenance DB，不要求目标库存在。
  const probeDatabase = "meal_agent_restore_probe";
  await withPool(adminPoolConfig("postgres"), async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS ${probeDatabase}`);
  });

  // 目标库尚不存在时运行 cluster 阶段。
  await runBootstrap("cluster");
  await withPool(adminPoolConfig("postgres"), async (pool) => {
    const exists = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_database WHERE datname = $1",
      [probeDatabase],
    );
    assert.equal(exists.rows[0]?.count, "0", "probe database must not exist yet");
  });

  // 角色已就位，因此可以直接把新库的 owner 设为 migrator——这正是恢复路径
  // 需要的前置条件。本轮不执行 pg_restore。
  const created = await runCaptured(
    join(postgresBin, "createdb"),
    ["--owner=meal_agent_migrator", probeDatabase],
    { env: adminEnvironment() },
  );
  assert.equal(
    created.code,
    0,
    `createdb --owner=meal_agent_migrator failed: ${created.stderr.slice(0, 400)}`,
  );

  try {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      const owner = await pool.query<{ owner: string }>(
        `SELECT pg_catalog.pg_get_userbyid(datdba) AS owner
         FROM pg_database WHERE datname = $1`,
        [probeDatabase],
      );
      assert.equal(owner.rows[0]?.owner, "meal_agent_migrator");
    });
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probeDatabase}`);
    });
  }
});

test("admin bootstrap refuses a non-project database and leaves no trace", async () => {
  // 指向 postgres / template1 / 普通外部库都必须失败，且不留下 drizzle schema、
  // ledger 或 0000 的任何对象。
  const foreign = "meal_agent_not_a_project_db_control";
  await withPool(adminPoolConfig("postgres"), async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS ${foreign.replace(/^meal_agent_/, "outsider_")}`);
    await pool.query(`CREATE DATABASE outsider_control`);
  });
  try {
    for (const database of ["postgres", "template1", "outsider_control"]) {
      const result = await runPnpm("db:bootstrap", adminUrl(database));
      assert.notEqual(
        result.code,
        0,
        `db:bootstrap must refuse database ${database}`,
      );
      assert.match(
        `${result.stdout}${result.stderr}`,
        /not a project database|MigrationPreflightError/,
      );

      if (database === "template1") {
        continue;
      }
      // 零副作用：没有 drizzle schema、没有 ledger、没有 0000 的表。
      await withPool(adminPoolConfig(database), async (pool) => {
        const traces = await pool.query<{
          drizzle: string | null;
          ledger: string | null;
          users: string | null;
        }>(
          `SELECT to_regnamespace('drizzle')::text AS drizzle,
                  to_regclass('drizzle.__meal_agent_migrations')::text AS ledger,
                  to_regclass('public.users')::text AS users`,
        );
        assert.deepEqual(
          traces.rows[0],
          { drizzle: null, ledger: null, users: null },
          `db:bootstrap left traces in ${database}`,
        );
      });
    }
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query("DROP DATABASE IF EXISTS outsider_control");
    });
  }
});

test("object-level privilege drift on the login roles is converged and reverse-tested", async () => {
  // 注入六类直接对象授权，包括 column、sequence、routine 与异常 default privilege。
  await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
    await client.query("CREATE SEQUENCE IF NOT EXISTS public.stage09a_drift_seq");
  });
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("GRANT CREATE, USAGE ON SCHEMA public TO meal_agent_runtime_login");
    await pool.query("GRANT SELECT ON drizzle.__meal_agent_migrations TO meal_agent_runtime_login");
    await pool.query("GRANT INSERT, UPDATE ON public.households TO meal_agent_runtime_login");
    await pool.query("GRANT SELECT (name) ON public.households TO meal_agent_backup_login");
    await pool.query("GRANT USAGE, SELECT ON SEQUENCE public.stage09a_drift_seq TO meal_agent_runtime_login");
    await pool.query("GRANT USAGE ON SCHEMA meal_agent_private TO meal_agent_runtime_login");
    await pool.query(
      "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA meal_agent_private TO meal_agent_runtime_login",
    );
    await pool.query(
      "ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public " +
        "GRANT SELECT ON TABLES TO meal_agent_runtime_login",
    );
  });

  // catalog 上确实出现了直接授权。
  const directGrants = async (): Promise<number> =>
    withPool(adminPoolConfig(), async (pool) => {
      const result = await pool.query<{ count: string }>(
        `SELECT (
           (SELECT count(*) FROM pg_namespace n, aclexplode(n.nspacl) a
            WHERE a.grantee <> 0
              AND pg_get_userbyid(a.grantee) LIKE 'meal\\_agent%\\_login')
         + (SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a
            WHERE a.grantee <> 0
              AND pg_get_userbyid(a.grantee) LIKE 'meal\\_agent%\\_login')
         + (SELECT count(*) FROM pg_attribute t, aclexplode(t.attacl) a
            WHERE a.grantee <> 0
              AND pg_get_userbyid(a.grantee) LIKE 'meal\\_agent%\\_login')
         + (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a
            WHERE a.grantee <> 0
              AND pg_get_userbyid(a.grantee) LIKE 'meal\\_agent%\\_login')
         + (SELECT count(*) FROM pg_default_acl d, aclexplode(d.defaclacl) a
            WHERE a.grantee <> 0
              AND pg_get_userbyid(a.grantee) LIKE 'meal\\_agent%\\_login')
         )::text AS count`,
      );
      return Number(result.rows[0]?.count ?? "0");
    });
  assert.ok(await directGrants() > 0, "drift must actually grant something");

  // 重跑完整 baseline。
  await runBootstrap("cluster");
  await runBootstrap("acl");

  // catalog 侧：直接授权清零。
  assert.equal(await directGrants(), 0, "all direct login grants must be revoked");

  // 反向侧：用真实 login 连接实际尝试。
  await withPool(runtimeLoginUrl(), async (pool) => {
    assert.match(
      String(await attempt(pool, ["CREATE TABLE public.stage09a_after_drift (id int)"])),
      /permission denied/i,
      "runtime login must not retain schema CREATE",
    );
    assert.match(
      String(await attempt(pool, ["SELECT name FROM drizzle.__meal_agent_migrations"])),
      /permission denied/i,
      "runtime login must not retain ledger SELECT before SET ROLE",
    );
    assert.match(
      String(await attempt(pool, ["INSERT INTO public.households (id) VALUES (gen_random_uuid())"])),
      /permission denied/i,
      "runtime login must not retain table writes",
    );
    assert.match(
      String(await attempt(pool, ["SELECT nextval('public.stage09a_drift_seq')"])),
      /permission denied/i,
      "runtime login must not retain sequence USAGE",
    );
    assert.match(
      String(await attempt(pool, ["SELECT meal_agent_private.app_user_id()"])),
      /permission denied/i,
      "runtime login must not retain private schema USAGE / function EXECUTE",
    );
  });
  await withPool(backupLoginUrl(), async (pool) => {
    assert.match(
      String(await attempt(pool, ["SELECT name FROM public.households"])),
      /permission denied/i,
      "backup login must not retain the column-level grant",
    );
  });

  await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
    await client.query("DROP SEQUENCE IF EXISTS public.stage09a_drift_seq");
  });
  await runBootstrap("acl");
});

test("the public schema baseline is strict in both directions", async () => {
  const schemaState = async (): Promise<Record<string, boolean>> =>
    withPool(adminPoolConfig(), async (pool) => {
      const result = await pool.query<{
        public_usage: boolean;
        public_create: boolean;
        app_usage: boolean;
        backup_usage: boolean;
        app_create: boolean;
      }>(
        `SELECT has_schema_privilege('public', 'public', 'USAGE') AS public_usage,
                has_schema_privilege('public', 'public', 'CREATE') AS public_create,
                has_schema_privilege('meal_agent_app', 'public', 'USAGE') AS app_usage,
                has_schema_privilege('meal_agent_backup', 'public', 'USAGE') AS backup_usage,
                has_schema_privilege('meal_agent_app', 'public', 'CREATE') AS app_create`,
      );
      return result.rows[0] as unknown as Record<string, boolean>;
    });

  // 基线：PUBLIC 无 USAGE/CREATE；app/backup 有 USAGE、无 CREATE。
  assert.deepEqual(await schemaState(), {
    public_usage: false,
    public_create: false,
    app_usage: true,
    backup_usage: true,
    app_create: false,
  });

  // app 在没有 PUBLIC 默认 USAGE 的情况下仍然正常工作。
  await asRole(runtimeLoginUrl(), "meal_agent_app", async (client) => {
    const ok = await client.query<{ ready: number }>(
      "SELECT count(*)::int AS ready FROM public.households",
    );
    assert.equal(typeof ok.rows[0]?.ready, "number");
  });

  // 人为重新授予 PUBLIC USAGE/CREATE，再跑 baseline 必须收回。
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("GRANT USAGE, CREATE ON SCHEMA public TO PUBLIC");
  });
  const widened = await schemaState();
  assert.equal(widened["public_usage"], true, "drift must actually widen");
  await runBootstrap("acl");
  assert.deepEqual(await schemaState(), {
    public_usage: false,
    public_create: false,
    app_usage: true,
    backup_usage: true,
    app_create: false,
  });
});

test("membership granted by an independent grantor is still converged", async () => {
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("DROP ROLE IF EXISTS stage09a_grantor");
    await pool.query("CREATE ROLE stage09a_grantor LOGIN NOINHERIT");
    // 给独立 grantor ADMIN OPTION，再由**它**产生 membership。
    await pool.query(
      "GRANT meal_agent_app TO stage09a_grantor WITH ADMIN OPTION",
    );
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('role', 'stage09a_grantor', false)");
      await client.query("GRANT meal_agent_app TO meal_agent_backup_login");
    } finally {
      client.release();
    }
  });

  // 先断言 grantor 确实不是 postgres。
  const grantors = await withPool(adminPoolConfig(), async (pool) => {
    const result = await pool.query<{ grantor: string; member: string }>(
      `SELECT gr.rolname AS grantor, m.rolname AS member
       FROM pg_auth_members a
       JOIN pg_roles m ON m.oid = a.member
       JOIN pg_roles g ON g.oid = a.roleid
       JOIN pg_roles gr ON gr.oid = a.grantor
       WHERE g.rolname = 'meal_agent_app' AND m.rolname = 'meal_agent_backup_login'`,
    );
    return result.rows;
  });
  assert.equal(grantors.length, 1);
  assert.equal(
    grantors[0]?.grantor,
    "stage09a_grantor",
    "the membership must genuinely be granted by an independent grantor",
  );

  // 重跑 baseline：必须把它收敛掉（REVOKE ... GRANTED BY 逐行处理）。
  await runBootstrap("cluster");

  await withPool(adminPoolConfig(), async (pool) => {
    const edges = await pool.query<{ edge: string }>(
      `SELECT m.rolname || ' -> ' || g.rolname AS edge
       FROM pg_auth_members a
       JOIN pg_roles m ON m.oid = a.member
       JOIN pg_roles g ON g.oid = a.roleid
       WHERE m.rolname = ANY(ARRAY['meal_agent_migrator','meal_agent_app',
             'meal_agent_backup','meal_agent_migration_login',
             'meal_agent_runtime_login','meal_agent_backup_login'])
          OR g.rolname = ANY(ARRAY['meal_agent_migrator','meal_agent_app',
             'meal_agent_backup','meal_agent_migration_login',
             'meal_agent_runtime_login','meal_agent_backup_login'])
       ORDER BY edge`,
    );
    assert.deepEqual(
      edges.rows.map((row) => row.edge),
      [
        "meal_agent_backup_login -> meal_agent_backup",
        "meal_agent_migration_login -> meal_agent_migrator",
        "meal_agent_runtime_login -> meal_agent_app",
      ],
    );
    await pool.query("DROP ROLE IF EXISTS stage09a_grantor");
  });
  await runBootstrap("acl");
});

test("bounded-wait options have an explicit product-level maximum", async () => {
  const url = migrationLoginUrl();
  // 上界通过。
  await assert.doesNotReject(
    applyMigrations(url, {
      lockWaitMs: migrationLimits.lockWaitMs,
      connectionTimeoutMs: migrationLimits.connectionTimeoutMs,
    }),
  );
  // 上界 + 1 与 MAX_SAFE_INTEGER 都必须失败（避免 Node timer 溢出退化为约 1ms）。
  for (const invalid of [
    migrationLimits.lockWaitMs + 1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    await assert.rejects(
      applyMigrations(url, { lockWaitMs: invalid }),
      MigrationOptionError,
      `lockWaitMs ${String(invalid)} must be rejected`,
    );
  }
  for (const invalid of [
    migrationLimits.connectionTimeoutMs + 1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    await assert.rejects(
      applyMigrations(url, { connectionTimeoutMs: invalid }),
      MigrationOptionError,
      `connectionTimeoutMs ${String(invalid)} must be rejected`,
    );
  }
});

test("the server log never reports an unowned advisory lock unlock", async () => {
  // 上面的 advisory/表锁用例都跑过了；此时日志里不应出现「解锁未持有的锁」。
  const serverLog = await readFile(serverLogPath, "utf8");
  assert.equal(
    serverLog.includes("you don't own a lock"),
    false,
    "pg_advisory_unlock must only run when the lock was actually acquired",
  );
});

// ---------------------------------------------------------------------------
// 第三轮整改新增证据
// ---------------------------------------------------------------------------

test("db:migrate rejects the admin flag through the real pnpm entry point", async () => {
  // 上一轮的缺陷：db:migrate 接受 --bootstrap-0000 就可能误入 admin 模式。
  // 现在 admin 路径是独立入口，db:migrate 只接受零参数。
  for (const args of [["--bootstrap-0000"], ["--role=postgres"], ["extra"]]) {
    const result = await runPnpm("db:migrate", migrationLoginUrl(), args);
    assert.notEqual(result.code, 0, `db:migrate must reject ${String(args)}`);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /MigrationCliUsageError|takes no arguments/,
    );
  }
  for (const args of [["--bootstrap-0000"], ["--role=postgres"]]) {
    const result = await runPnpm("db:bootstrap", adminUrl(), args);
    assert.notEqual(result.code, 0, `db:bootstrap must reject ${String(args)}`);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /BootstrapCliUsageError|takes no arguments/,
    );
  }
});

test("the fresh bootstrap preflight rejects every non-empty target and leaves no trace", async () => {
  const probe = "meal_agent_stage09a_fresh";
  const reset = async (): Promise<void> => {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      await pool.query(`CREATE DATABASE ${probe}`);
    });
  };
  const traces = async (): Promise<Record<string, string | null>> =>
    withPool(adminPoolConfig(probe), async (pool) => {
      const result = await pool.query<{
        drizzle: string | null;
        ledger: string | null;
        users: string | null;
        priv: string | null;
      }>(
        `SELECT to_regnamespace('drizzle')::text AS drizzle,
                to_regclass('drizzle.__meal_agent_migrations')::text AS ledger,
                to_regclass('public.users')::text AS users,
                to_regnamespace('meal_agent_private')::text AS priv`,
      );
      return result.rows[0] as unknown as Record<string, string | null>;
    });

  const cases: readonly [string, string, RegExp][] = [
    ["public view", "CREATE VIEW public.probe_v AS SELECT 1 AS x",
      /relation public\.probe_v/],
    ["public sequence", "CREATE SEQUENCE public.probe_s",
      /relation public\.probe_s/],
    ["public routine", "CREATE FUNCTION public.probe_f() RETURNS int " +
      "LANGUAGE sql AS $$SELECT 1$$", /routine public\.probe_f/],
    ["user type", "CREATE TYPE public.probe_t AS (a int)",
      /type public\.probe_t|relation public\.probe_t/],
    ["empty drizzle schema", "CREATE SCHEMA drizzle", /schema drizzle/],
    ["custom schema", "CREATE SCHEMA probe_extra", /schema probe_extra/],
    ["private schema", "CREATE SCHEMA meal_agent_private",
      /schema meal_agent_private/],
    ["existing table", "CREATE TABLE public.probe_tbl (id int)",
      /relation public\.probe_tbl/],
  ];

  try {
    for (const [label, statement, expected] of cases) {
      await reset();
      await withPool(adminPoolConfig(probe), async (pool) => {
        await pool.query(statement);
      });
      const result = await runPnpm("db:bootstrap", adminUrl(probe));
      assert.notEqual(result.code, 0, `db:bootstrap must reject: ${label}`);
      assert.match(
        `${result.stdout}${result.stderr}`,
        /is not empty/,
        `wrong reason for: ${label}`,
      );
      assert.match(
        `${result.stdout}${result.stderr}`,
        expected,
        `must name the offending object for: ${label}`,
      );
      // 零残留：bootstrap 不得新增 ledger、0000 对象或 meal_agent_private；
      // drizzle schema 只在不是本用例自己造的时候断言不存在。
      const after = await traces();
      assert.equal(after["ledger"], null, `${label} left a ledger`);
      assert.equal(after["users"], null, `${label} left 0000 tables`);
      if (!statement.includes("CREATE SCHEMA meal_agent_private")) {
        assert.equal(after["priv"], null, `${label} left meal_agent_private`);
      }
      if (!statement.includes("CREATE SCHEMA drizzle")) {
        assert.equal(after["drizzle"], null, `${label} left a drizzle schema`);
      }
    }

    // 合法项目库但非 superuser：同样拒绝且零残留。
    await reset();
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(
        `GRANT CONNECT ON DATABASE ${probe} TO meal_agent_migration_login`,
      );
    });
    const nonSuper = await runPnpm(
      "db:bootstrap",
      `postgresql://meal_agent_migration_login:${passwords.migration}` +
        `@127.0.0.1:${String(port)}/${probe}`,
    );
    assert.notEqual(nonSuper.code, 0);
    assert.match(
      `${nonSuper.stdout}${nonSuper.stderr}`,
      /lacks cluster-admin capability/,
    );
    assert.deepEqual(await traces(), {
      drizzle: null,
      ledger: null,
      users: null,
      priv: null,
    });

    // 正确的 0000 重跑是幂等 no-op；0001+ 之后再跑必须拒绝。
    await reset();
    await mustSucceedCli(
      "pnpm db:bootstrap (fresh)",
      await runPnpm("db:bootstrap", adminUrl(probe)),
    );
    await mustSucceedCli(
      "pnpm db:bootstrap (idempotent re-run)",
      await runPnpm("db:bootstrap", adminUrl(probe)),
    );
    await runBootstrap("handoff", probe);
    await runBootstrap("acl", probe);
    await mustSucceedCli(
      "pnpm db:migrate (probe)",
      await runPnpm("db:migrate", migrationLoginUrl().replace(
        rolesDatabase,
        probe,
      )),
    );
    const afterLatest = await runPnpm("db:bootstrap", adminUrl(probe));
    assert.notEqual(afterLatest.code, 0, "0001+ must be refused");
    assert.match(
      `${afterLatest.stdout}${afterLatest.stderr}`,
      /expected an empty database or exactly 0000/,
    );
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    });
  }
});

test("object ACL drift granted by an independent grantor is converged", async () => {
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("DROP ROLE IF EXISTS stage09a_obj_grantor");
    await pool.query("CREATE ROLE stage09a_obj_grantor NOLOGIN");
    // 让独立 grantor 拥有可再授予的权限，再由**它**授予登录角色。
    await pool.query(
      "GRANT SELECT ON public.households TO stage09a_obj_grantor " +
        "WITH GRANT OPTION",
    );
    await pool.query("GRANT USAGE ON SCHEMA public TO stage09a_obj_grantor");
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('role', 'stage09a_obj_grantor', false)");
      await client.query(
        "GRANT SELECT ON public.households TO meal_agent_runtime_login",
      );
    } finally {
      client.release();
    }
  });

  // 断言 grantor 确实不是 postgres。
  const grantor = await withPool(adminPoolConfig(), async (pool) => {
    const result = await pool.query<{ grantor: string }>(
      `SELECT pg_catalog.pg_get_userbyid(acl.grantor) AS grantor
       FROM pg_class c, aclexplode(c.relacl) AS acl
       WHERE c.relname = 'households' AND acl.grantee <> 0
         AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_runtime_login'`,
    );
    return result.rows[0]?.grantor;
  });
  assert.equal(grantor, "stage09a_obj_grantor");

  await runBootstrap("acl");

  await withPool(adminPoolConfig(), async (pool) => {
    const left = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c, aclexplode(c.relacl) AS acl
       WHERE acl.grantee <> 0
         AND pg_catalog.pg_get_userbyid(acl.grantee) LIKE 'meal\\_agent%\\_login'`,
    );
    assert.equal(left.rows[0]?.count, "0");
    await pool.query("DROP OWNED BY stage09a_obj_grantor");
    await pool.query("DROP ROLE IF EXISTS stage09a_obj_grantor");
  });
  await withPool(runtimeLoginUrl(), async (pool) => {
    assert.match(
      String(await attempt(pool, ["SELECT id FROM public.households"])),
      /permission denied/i,
    );
  });
});

test("the backup role holds an exact read-only baseline including future objects", async () => {
  await withPool(backupLoginUrl(), async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('role', $1, true)", [
        "meal_agent_backup",
      ]);
      // meal_agent_private 既不可见也不可执行。
      const priv = await client
        .query("SELECT meal_agent_private.app_user_id()")
        .then(() => undefined)
        .catch((error: Error) => error.message);
      assert.match(String(priv), /permission denied/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  // migrator 今后新建的 table/sequence 自动获得 backup 只读权限。
  await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
    await client.query("CREATE TABLE public.stage09a_future (id int)");
    await client.query("CREATE SEQUENCE public.stage09a_future_seq");
  });
  try {
    await withPool(backupLoginUrl(), async (pool) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('role', $1, true)", [
          "meal_agent_backup",
        ]);
        // 新表可读。
        const rows = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.stage09a_future",
        );
        assert.equal(rows.rows[0]?.count, "0");
        // 新 sequence 只可 SELECT，不可 nextval/setval。
        const current = await client.query(
          "SELECT last_value FROM public.stage09a_future_seq",
        );
        assert.equal(current.rows.length, 1);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      for (const statement of [
        "SELECT nextval('public.stage09a_future_seq')",
        "SELECT setval('public.stage09a_future_seq', 5)",
        "INSERT INTO public.stage09a_future (id) VALUES (1)",
      ]) {
        assert.match(
          String(await attempt(pool, [statement], "meal_agent_backup")),
          /permission denied/i,
          `backup must not run: ${statement}`,
        );
      }
    });
  } finally {
    await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
      await client.query("DROP TABLE IF EXISTS public.stage09a_future");
      await client.query("DROP SEQUENCE IF EXISTS public.stage09a_future_seq");
    });
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("an unknown SECURITY DEFINER function in public is refused by the acl baseline", async () => {
  await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
    await client.query(
      "CREATE FUNCTION public.stage09a_backdoor() RETURNS int " +
        "LANGUAGE sql SECURITY DEFINER AS $$SELECT 1$$",
    );
  });
  try {
    const result = await bootstrap("acl");
    assert.notEqual(result.code, 0, "acl must refuse a public SECURITY DEFINER");
    assert.match(result.stderr, /public must not contain business routines/i);

    // acl 是 fail closed 而不是静默阉割，因此此刻该函数仍保留默认的
    // PUBLIC EXECUTE。收回 PUBLIC EXECUTE（正是基线对已知 routine 做的事）
    // 之后，runtime/app 就无法再调用它。
    await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
      await client.query(
        "REVOKE EXECUTE ON FUNCTION public.stage09a_backdoor() FROM PUBLIC",
      );
    });
    await withPool(runtimeLoginUrl(), async (pool) => {
      assert.match(
        String(
          await attempt(pool, ["SELECT public.stage09a_backdoor()"],
            "meal_agent_app"),
        ),
        /permission denied/i,
      );
    });
  } finally {
    await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
      await client.query("DROP FUNCTION IF EXISTS public.stage09a_backdoor()");
    });
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("bootstrap never leaks a password under xtrace, even when psql fails", async () => {
  // bash -x + 三个合成 sentinel + 注定失败的 PSQL：合并 stdout/stderr 必须零命中。
  const sentinels = {
    migration: `XtraceMigration-${randomBytes(9).toString("hex")}`,
    runtime: `XtraceRuntime-${randomBytes(9).toString("hex")}`,
    backup: `XtraceBackup-${randomBytes(9).toString("hex")}`,
  };
  const result = await runCaptured(
    "bash",
    ["-x", bootstrapScript, "logins", "--maintenance-db", "postgres"],
    {
      env: {
        ...adminEnvironment(),
        PATH: `${postgresBin}:${process.env["PATH"] ?? ""}`,
        // 指向一个不存在的 psql，保证在展开 Secret 之后失败。
        PSQL: join(clusterRoot, "definitely-not-psql"),
        MEAL_AGENT_MIGRATION_PASSWORD: sentinels.migration,
        MEAL_AGENT_RUNTIME_PASSWORD: sentinels.runtime,
        MEAL_AGENT_BACKUP_PASSWORD: sentinels.backup,
      },
    },
  );
  assert.notEqual(result.code, 0, "the failing PSQL must make bootstrap fail");
  const combined = `${result.stdout}${result.stderr}`;
  assert.ok(combined.includes("+"), "bash -x must actually have traced");
  for (const [label, sentinel] of Object.entries(sentinels)) {
    assert.equal(
      combined.includes(sentinel),
      false,
      `the ${label} password must not appear under xtrace`,
    );
  }
});

test("the no-ctty wrapper forwards signals and propagates termination", async () => {
  const wrapper = join(repositoryRoot, "infra/docker/postgres/no-ctty.mjs");
  // 子进程处于新会话，父进程必须显式转发信号并如实传播终止原因。
  const child = spawn(
    process.execPath,
    [wrapper, "sh", "-c", "trap 'exit 42' TERM; sleep 30"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  child.kill("SIGTERM");
  const outcome = await exited;
  assert.equal(
    outcome.code,
    42,
    "SIGTERM must reach the detached child, which exits 42",
  );
});
