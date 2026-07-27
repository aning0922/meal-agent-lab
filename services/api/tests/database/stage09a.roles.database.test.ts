import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

import { loadConfig } from "../../src/config.js";
import {
  applyMigrations,
  bootstrapMigrationOptions,
  defaultMigrationsDirectory,
  migrationLimits,
  MigrationLockTimeoutError,
  MigrationOptionError,
} from "../../src/database/migrate.js";
import {
  encodeProjectionIdentity,
  projectionDatabaseKey,
  type ProjectionIdentityPart,
} from "../../src/database/authorization-projection-sql.js";
import { renderStage06CatalogProjectionSql } from "../../src/database/stage06-manifest-sql.js";
import {
  byCodeUnit,
  canonicalManifestRows,
} from "../../src/database/stage06-manifest.js";
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

  // 重跑**完整** baseline：cluster scope（角色/config/membership）与 database
  // scope 的两个阶段——containment 收敛，final 才建立备份角色的表级 SELECT。
  await runBootstrap("cluster");
  await runBootstrap("acl");
  await runBootstrap("grants");

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

    // 期望信息全部来自渲染出的 manifest 检查块（checksum 那条除外——它由
    // handoff 自己的顺序前置条件抛出，早于 manifest）。
    const injections: readonly [string, readonly string[], RegExp][] = [
      ["public view", ["CREATE VIEW public.stage09a_v AS SELECT 1 AS x"],
        /unexpected relation public\.stage09a_v/],
      ["public sequence", ["CREATE SEQUENCE public.stage09a_s"],
        /unexpected relation public\.stage09a_s/],
      ["public routine", [
        "CREATE FUNCTION public.stage09a_f() RETURNS int LANGUAGE sql " +
          "SECURITY DEFINER AS $$SELECT 1$$",
      ], /unexpected routine public\.stage09a_f\(\) .*secdef=t/],
      ["private routine", [
        "CREATE FUNCTION meal_agent_private.stage09a_p() RETURNS int " +
          "LANGUAGE sql AS $$SELECT 1$$",
      ], /unexpected routine meal_agent_private\.stage09a_p\(\)/],
      ["custom schema", ["CREATE SCHEMA stage09a_extra"],
        /unexpected schema stage09a_extra/],
      ["user type", ["CREATE TYPE public.stage09a_t AS (a int)"],
        /unexpected type public\.stage09a_t/],
      ["pre-created 0001 table", [
        "CREATE TABLE public.household_invites (id uuid PRIMARY KEY)",
      ], /unexpected relation public\.household_invites/],
      ["dropped 0000 table", ["DROP TABLE public.sessions CASCADE"],
        /missing relation public\.sessions/],
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

  // migrator 今后新建的 table/sequence 自动获得 backup 只读权限。default
  // privileges 属于 final 阶段，因此先确保数据库处于该阶段再建对象。
  await runBootstrap("grants");
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
    assert.match(
      result.stderr,
      /public and drizzle must not contain routines: public\.stage09a_backdoor\(\) \[security definer: t\]/i,
    );

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

// ---------------------------------------------------------------------------
// 第四轮整改新增证据
// ---------------------------------------------------------------------------

test("db:bootstrap loads exactly 0000 and refuses a prequel or a missing file", async () => {
  // 这个用例过去把文件写进 tracked 的 migrations 目录、再把 0000 挪走还原。
  // 那意味着一次中断的测试会留下被破坏的仓库。改用 applyMigrations 的只读注入
  // seam：把 tracked 文件**复制**进临时目录，只在副本上制造异常。
  const trackedDirectory = defaultMigrationsDirectory;
  const probe = "meal_agent_stage09a_exact";
  const sandbox = join(clusterRoot, "migrations-sandbox");
  await rm(sandbox, { recursive: true, force: true });
  await mkdir(sandbox, { recursive: true });
  const frozen = await readFile(
    join(trackedDirectory, "0000_stage_06.sql"),
    "utf8",
  );
  await writeFile(join(sandbox, "0000_stage_06.sql"), frozen, "utf8");

  const bootstrapWith = async (
    directory: string,
  ): Promise<string | undefined> => {
    try {
      await applyMigrations(adminUrl(probe), {
        ...bootstrapMigrationOptions,
        migrationsDirectory: directory,
      });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  await withPool(adminPoolConfig("postgres"), async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    await pool.query(`CREATE DATABASE ${probe}`);
  });
  try {
    // 1. 字典序排在 0000 之前的文件绝不能被 admin 路径执行。
    const prequel = join(sandbox, "0000_aaa_prequel.sql");
    await writeFile(
      prequel,
      "CREATE TABLE public.prequel_should_never_run (id int);\n",
      "utf8",
    );
    const withPrequel = await bootstrapWith(sandbox);
    assert.match(String(withPrequel), /migration selection|sort before it/);
    await withPool(adminPoolConfig(probe), async (pool) => {
      const trace = await pool.query<{ present: string | null }>(
        "SELECT to_regclass('public.prequel_should_never_run')::text AS present",
      );
      assert.equal(trace.rows[0]?.present, null, "the prequel must not run");
    });
    await rm(prequel, { force: true });

    // 2. 目标文件缺失：零连接、零 DDL。
    const empty = join(clusterRoot, "migrations-empty");
    await rm(empty, { recursive: true, force: true });
    await mkdir(empty, { recursive: true });
    const missing = await bootstrapWith(empty);
    assert.match(String(missing), /was not found on disk/);
    await withPool(adminPoolConfig(probe), async (pool) => {
      const trace = await pool.query<{ drizzle: string | null }>(
        "SELECT to_regnamespace('drizzle')::text AS drizzle",
      );
      assert.equal(trace.rows[0]?.drizzle, null, "no DDL may have run");
    });

    // 3. 只有冻结的 0000 时正常成功。
    assert.equal(await bootstrapWith(sandbox), undefined);

    // 4. tracked 目录自始至终没有被改动。
    assert.equal(
      await readFile(join(trackedDirectory, "0000_stage_06.sql"), "utf8"),
      frozen,
      "the tracked migration must never be rewritten by a test",
    );
    const tracked = await readdir(trackedDirectory);
    assert.deepEqual(
      [...tracked].sort(),
      [
        "0000_stage_06.sql",
        "0001_stage_08.sql",
        "0002_stage_08_audit_closeout.sql",
        "0003_stage_08_secondary_closeout.sql",
        "0004_stage_08_final_closeout.sql",
      ],
      "no test may add or remove a tracked migration",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    });
  }
});

test("a 0000-only re-run still validates full object state", async () => {
  const probe = "meal_agent_stage09a_rerun";
  const snapshot = async (): Promise<string> =>
    withPool(adminPoolConfig(probe), async (pool) => {
      const result = await pool.query(
        `SELECT n.nspname || '.' || c.relname AS ident,
                pg_catalog.pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public','drizzle','meal_agent_private')
            AND c.relkind IN ('r','p','v','m','S')
          ORDER BY 1`,
      );
      return JSON.stringify(result.rows);
    });

  const injections: readonly [string, string, RegExp][] = [
    ["view", "CREATE VIEW public.rerun_v AS SELECT 1 AS x", /relation public\.rerun_v/],
    ["sequence", "CREATE SEQUENCE public.rerun_s", /relation public\.rerun_s/],
    ["routine", "CREATE FUNCTION public.rerun_f() RETURNS int LANGUAGE sql AS $$SELECT 1$$",
      /routine public\.rerun_f/],
    ["type", "CREATE TYPE public.rerun_t AS (a int)", /type public\.rerun_t/],
    ["schema", "CREATE SCHEMA rerun_extra", /schema rerun_extra/],
  ];
  try {
    for (const [label, statement, expected] of injections) {
      await withPool(adminPoolConfig("postgres"), async (pool) => {
        await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
        await pool.query(`CREATE DATABASE ${probe}`);
      });
      await mustSucceedCli(
        `pnpm db:bootstrap (${label})`,
        await runPnpm("db:bootstrap", adminUrl(probe)),
      );
      await withPool(adminPoolConfig(probe), async (pool) => {
        await pool.query(statement);
      });
      const before = await snapshot();
      const result = await runPnpm("db:bootstrap", adminUrl(probe));
      assert.notEqual(result.code, 0, `re-run must reject: ${label}`);
      assert.match(
        `${result.stdout}${result.stderr}`,
        /stage06 object manifest does not match the frozen 0000/,
        `wrong reason for: ${label}`,
      );
      assert.match(`${result.stdout}${result.stderr}`, expected);
      assert.equal(await snapshot(), before, `${label} changed object state`);
    }
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    });
  }
});

test("handoff enforces the exact 0000 routine and relation manifest", async () => {
  const probe = "meal_agent_stage09a_manifest";
  const snapshot = async (): Promise<string> =>
    withPool(adminPoolConfig(probe), async (pool) => {
      const result = await pool.query(
        `SELECT 'db' AS ident, pg_catalog.pg_get_userbyid(datdba) AS owner
           FROM pg_database WHERE datname = current_database()
         UNION ALL
         SELECT 'schema:' || nspname, pg_catalog.pg_get_userbyid(nspowner)
           FROM pg_namespace
          WHERE nspname IN ('public','drizzle','meal_agent_private')
         ORDER BY 1`,
      );
      return JSON.stringify(result.rows);
    });

  const injections: readonly [string, string, RegExp][] = [
    ["drizzle SECURITY DEFINER routine",
      "CREATE FUNCTION drizzle.evil() RETURNS int LANGUAGE sql " +
        "SECURITY DEFINER AS $$SELECT 1$$",
      /unexpected routine drizzle\.evil/],
    ["private same-name overload",
      "CREATE FUNCTION meal_agent_private.app_user_id(extra int) " +
        "RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$",
      /unexpected routine meal_agent_private\.app_user_id\(extra integer\)/],
    ["private unmanaged table",
      "CREATE TABLE meal_agent_private.stash (id int)",
      /unexpected relation meal_agent_private\.stash/],
    ["drizzle type",
      "CREATE TYPE drizzle.weird AS (a int)",
      /unexpected type drizzle\.weird|unexpected relation drizzle\.weird/],
    ["drizzle sequence",
      "CREATE SEQUENCE drizzle.counter",
      /unexpected relation drizzle\.counter/],
  ];
  try {
    for (const [label, statement, expected] of injections) {
      await withPool(adminPoolConfig("postgres"), async (pool) => {
        await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
        await pool.query(`CREATE DATABASE ${probe}`);
      });
      await mustSucceedCli(
        `pnpm db:bootstrap (${label})`,
        await runPnpm("db:bootstrap", adminUrl(probe)),
      );
      await withPool(adminPoolConfig(probe), async (pool) => {
        await pool.query(statement);
      });
      const before = await snapshot();
      const result = await bootstrap("handoff", probe);
      assert.notEqual(result.code, 0, `handoff must reject: ${label}`);
      assert.match(result.stderr, /object manifest does not match/,
        `wrong category for: ${label}`);
      assert.match(result.stderr, expected, `wrong detail for: ${label}`);
      assert.equal(await snapshot(), before, `${label} mutated ownership`);
    }
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    });
  }
});

test("the acl baseline refuses to run when ownership is wrong", async () => {
  // 把 drizzle schema 的 owner 改掉，acl 必须 fail closed 且不改变任何归属。
  const snapshot = async (): Promise<string> =>
    withPool(adminPoolConfig(), async (pool) => {
      const result = await pool.query(
        `SELECT nspname AS ident, pg_catalog.pg_get_userbyid(nspowner) AS owner
           FROM pg_namespace
          WHERE nspname IN ('public','drizzle','meal_agent_private') ORDER BY 1`,
      );
      return JSON.stringify(result.rows);
    });
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("ALTER SCHEMA drizzle OWNER TO postgres");
  });
  const before = await snapshot();
  try {
    const result = await bootstrap("acl");
    assert.notEqual(result.code, 0, "acl must refuse a wrong schema owner");
    assert.match(result.stderr, /not owned by meal_agent_migrator/);
    assert.equal(await snapshot(), before, "acl mutated ownership before failing");
  } finally {
    await withPool(adminPoolConfig(), async (pool) => {
      await pool.query("ALTER SCHEMA drizzle OWNER TO meal_agent_migrator");
    });
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("backup default privilege drift is converged and future objects stay read-only", async () => {
  // 注入默认 INSERT、SELECT WITH GRANT OPTION 与 sequence USAGE/UPDATE。
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query(
      "ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public " +
        "GRANT INSERT ON TABLES TO meal_agent_backup",
    );
    await pool.query(
      "ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public " +
        "GRANT SELECT ON TABLES TO meal_agent_backup WITH GRANT OPTION",
    );
    await pool.query(
      "ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public " +
        "GRANT USAGE, UPDATE ON SEQUENCES TO meal_agent_backup",
    );
  });
  await runBootstrap("grants");

  // 收敛之后新建对象，证明只读。
  await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
    await client.query("CREATE TABLE public.stage09a_defacl (id int)");
    await client.query("CREATE SEQUENCE public.stage09a_defacl_seq");
  });
  try {
    await withPool(backupLoginUrl(), async (pool) => {
      for (const statement of [
        "INSERT INTO public.stage09a_defacl (id) VALUES (1)",
        "SELECT nextval('public.stage09a_defacl_seq')",
        "SELECT setval('public.stage09a_defacl_seq', 5)",
      ]) {
        assert.match(
          String(await attempt(pool, [statement], "meal_agent_backup")),
          /permission denied|must be owner|grant option/i,
          `backup must not run: ${statement.slice(0, 46)}`,
        );
      }
      // 再授权无效：PostgreSQL 在 grantor 缺少 grant option 时只发 WARNING
      // 并且**不授予任何权限**，因此这里断言实际效果而不是错误。
      await attempt(
        pool,
        ["GRANT SELECT ON public.stage09a_defacl TO meal_agent_app"],
        "meal_agent_backup",
      );
      // 只读仍然成立。
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('role', $1, true)", [
          "meal_agent_backup",
        ]);
        const rows = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.stage09a_defacl",
        );
        assert.equal(rows.rows[0]?.count, "0");
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    // app 没有因为 backup 的再授权尝试而拿到任何权限。
    await withPool(adminPoolConfig(), async (pool) => {
      const granted = await pool.query<{ ok: boolean }>(
        `SELECT has_table_privilege('meal_agent_app',
                'public.stage09a_defacl', 'SELECT') AS ok`,
      );
      assert.equal(granted.rows[0]?.ok, false,
        "backup must not be able to re-grant");
    });
  } finally {
    await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
      await client.query("DROP TABLE IF EXISTS public.stage09a_defacl");
      await client.query("DROP SEQUENCE IF EXISTS public.stage09a_defacl_seq");
    });
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("no-ctty forwards SIGTERM to the whole detached process group quickly", async () => {
  const wrapper = join(repositoryRoot, "infra/docker/postgres/no-ctty.mjs");
  const markerFile = join(clusterRoot, "no-ctty-descendant.pid");
  await rm(markerFile, { force: true });
  // 子进程再派生一个后代；两者都必须随 SIGTERM 消失。
  const child = spawn(
    process.execPath,
    [
      wrapper,
      "sh",
      "-c",
      `sh -c 'echo $$ > ${markerFile}; sleep 60' & wait`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const descendant = Number((await readFile(markerFile, "utf8")).trim());
  assert.ok(Number.isInteger(descendant) && descendant > 0);

  const startedAt = Date.now();
  child.kill("SIGTERM");
  await exited;
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 2_000, `termination took ${String(elapsed)}ms`);

  // 后代进程也必须已经退出。
  await new Promise((resolve) => setTimeout(resolve, 200));
  let alive = true;
  try {
    process.kill(descendant, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the descendant process must be gone too");
  process.stdout.write(
    `no-ctty signal case: terminated in ${String(elapsed)}ms\n`,
  );
});

test("backup routine grants from an independent grantor are converged", async () => {
  // 回归：backup routine 撤销循环此前多传了一个未 SELECT 的 grantee 参数，
  // 只有在真的存在 backup routine 授权时才会触发运行时错误。
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("DROP ROLE IF EXISTS stage09a_fn_grantor");
    await pool.query("CREATE ROLE stage09a_fn_grantor NOLOGIN");
    // 基线已收回 PUBLIC 对 meal_agent_private 的 USAGE，grantor 需要显式取得，
    // 否则它连函数都解析不到。
    await pool.query(
      "GRANT USAGE ON SCHEMA meal_agent_private TO stage09a_fn_grantor",
    );
    await pool.query(
      "GRANT EXECUTE ON FUNCTION meal_agent_private.app_user_id() " +
        "TO stage09a_fn_grantor WITH GRANT OPTION",
    );
    const client = await pool.connect();
    try {
      await client.query(
        "SELECT set_config('role', 'stage09a_fn_grantor', false)",
      );
      await client.query(
        "GRANT EXECUTE ON FUNCTION meal_agent_private.app_user_id() " +
          "TO meal_agent_backup",
      );
    } finally {
      client.release();
    }
  });

  const grantor = await withPool(adminPoolConfig(), async (pool) => {
    const result = await pool.query<{ grantor: string }>(
      `SELECT pg_catalog.pg_get_userbyid(acl.grantor) AS grantor
       FROM pg_proc p, aclexplode(COALESCE(p.proacl,
              acldefault('f', p.proowner))) AS acl
       WHERE p.proname = 'app_user_id' AND acl.grantee <> 0
         AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'`,
    );
    return result.rows[0]?.grantor;
  });
  assert.equal(grantor, "stage09a_fn_grantor");

  // 这一步在修复前会因为 format 参数过多而运行时失败。
  await runBootstrap("grants");

  await withPool(adminPoolConfig(), async (pool) => {
    const left = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_proc p, aclexplode(COALESCE(p.proacl,
              acldefault('f', p.proowner))) AS acl
       WHERE acl.grantee <> 0
         AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'`,
    );
    assert.equal(left.rows[0]?.count, "0", "backup must hold no routine EXECUTE");
    await pool.query("DROP OWNED BY stage09a_fn_grantor");
    await pool.query("DROP ROLE IF EXISTS stage09a_fn_grantor");
  });
  await runBootstrap("acl");
  await runBootstrap("grants");
});

// ---------------------------------------------------------------------------
// 阶段 09A / M2A 第五轮：冻结 0000 的安全 manifest，以及 private schema、
// 恢复路径 routine、Large Object 与数据库 PUBLIC 跨 grantor 的反例。
// ---------------------------------------------------------------------------

/** 在指定库上以 admin 身份跑规范化投影，返回排序后的规范化行。 */
const catalogProjection = async (
  database: string,
): Promise<readonly { kind: string; identity: string; detail: string }[]> =>
  withPool(adminPoolConfig(database), async (pool) => {
    const client = await pool.connect();
    try {
      // 投影结果与 search_path 有关（pg_get_indexdef / pg_get_expr 会省略可见
      // schema 的限定），因此这里用与渲染块相同的固定值。
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = pg_catalog");
      const result = await client.query<{
        kind: string;
        identity: string;
        detail: string;
      }>(renderStage06CatalogProjectionSql());
      await client.query("ROLLBACK");
      return [...result.rows].sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind < right.kind ? -1 : 1;
        }
        if (left.identity === right.identity) {
          return 0;
        }
        return left.identity < right.identity ? -1 : 1;
      });
    } finally {
      client.release();
    }
  });

/** 从合并输出里抽出 manifest 拒绝信息，用于比较两个入口是否一致。 */
const manifestRejection = (result: RunResult): string => {
  const combined = `${result.stdout}${result.stderr}`;
  const match = /stage06 object manifest does not match[^\n]*/.exec(combined);
  return match === null ? "" : match[0];
};

test("the frozen 0000 projects exactly the TypeScript manifest on real PostgreSQL 18", async () => {
  // 证明 manifest 不是「和 generated SQL 自洽」而已：真实 PostgreSQL 18 上执行
  // 冻结 0000 之后，catalog 的规范化安全投影必须与 TypeScript manifest 逐行相同。
  const probe = "meal_agent_stage09a_parity";
  try {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      await pool.query(`CREATE DATABASE ${probe}`);
    });
    await mustSucceedCli(
      "pnpm db:bootstrap (parity)",
      await runPnpm("db:bootstrap", adminUrl(probe)),
    );

    const expected = canonicalManifestRows().map((row) => ({
      kind: row.kind,
      identity: row.identity,
      detail: row.detail,
    }));
    assert.ok(expected.length > 200, "the manifest must be non-trivial");

    // 1. owner handoff **之前**：public / drizzle / ledger 的 owner 仍是
    //    bootstrap admin 或 pg_database_owner，属于合法过渡态。
    assert.deepEqual(await catalogProjection(probe), expected);

    // 2. owner handoff **之后**：owner 变成 migrator，同一份 manifest 仍然成立。
    await runBootstrap("handoff", probe);
    assert.deepEqual(await catalogProjection(probe), expected);

    process.stdout.write(
      `stage06 manifest parity: ${String(expected.length)} canonical rows ` +
        "matched before and after owner handoff\n",
    );
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    });
  }
});

test("every security-relevant drift is rejected identically by both entry points", async () => {
  const probe = "meal_agent_stage09a_drift";
  const admin = adminPoolConfig(probe);

  /** 注入前先记下精确定义，回滚时按原样恢复，避免测试之间互相污染。 */
  const captured = new Map<string, string>();
  const capture = async (key: string, sql: string): Promise<void> => {
    await withPool(admin, async (pool) => {
      const result = await pool.query<{ definition: string }>(sql);
      const definition = result.rows[0]?.definition;
      assert.ok(definition !== undefined, `could not capture ${key}`);
      captured.set(key, definition);
    });
  };
  const definitionOf = (key: string): string => {
    const definition = captured.get(key);
    assert.ok(definition !== undefined, `missing captured definition ${key}`);
    return definition;
  };

  const ownerSnapshot = async (): Promise<string> =>
    withPool(admin, async (pool) => {
      const result = await pool.query(
        `SELECT 'db' AS ident, pg_catalog.pg_get_userbyid(datdba) AS owner
           FROM pg_database WHERE datname = current_database()
         UNION ALL
         SELECT 'schema:' || nspname, pg_catalog.pg_get_userbyid(nspowner)
           FROM pg_namespace
          WHERE nspname IN ('public','drizzle','meal_agent_private')
         ORDER BY 1`,
      );
      return JSON.stringify(result.rows);
    });

  const runStatements = async (statements: readonly string[]): Promise<void> => {
    await withPool(admin, async (pool) => {
      for (const statement of statements) {
        await pool.query(statement);
      }
    });
  };

  try {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      await pool.query(`CREATE DATABASE ${probe}`);
    });
    await mustSucceedCli(
      "pnpm db:bootstrap (drift probe)",
      await runPnpm("db:bootstrap", adminUrl(probe)),
    );

    await capture(
      "app_user_id",
      `SELECT pg_catalog.pg_get_functiondef(
                'meal_agent_private.app_user_id()'::regprocedure) AS definition`,
    );
    await capture(
      "linked_membership_index",
      `SELECT pg_catalog.pg_get_indexdef(
                'public.person_profiles_linked_membership_unique'::regclass)
              AS definition`,
    );
    await capture(
      "users_status_check",
      `SELECT pg_catalog.pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE conname = 'users_status_check'`,
    );
    await capture(
      "households_user_list_select_using",
      `SELECT pg_catalog.pg_get_expr(polqual, polrelid) AS definition
         FROM pg_policy WHERE polname = 'households_user_list_select'`,
    );
    await capture(
      "households_creator_insert_check",
      `SELECT pg_catalog.pg_get_expr(polwithcheck, polrelid) AS definition
         FROM pg_policy WHERE polname = 'households_creator_insert'`,
    );

    interface DriftCase {
      readonly label: string;
      readonly inject: readonly string[];
      readonly revert: readonly string[];
      readonly expected: RegExp;
      /**
       * 有些漂移无法逐字节还原：PostgreSQL 重新解析 `pg_get_constraintdef` 的
       * 输出时会给出**等价但文本不同**的规范化结果。这类用例直接重建探针库，
       * 而不是假装还原成功——manifest 的意义正是不接受「等价即可」。
       */
      readonly rebuild?: true;
    }

    const cases: readonly DriftCase[] = [
      {
        label: "private routine added",
        inject: [
          "CREATE FUNCTION meal_agent_private.stage09a_added() RETURNS int " +
            "LANGUAGE sql AS $$SELECT 1$$",
        ],
        revert: ["DROP FUNCTION meal_agent_private.stage09a_added()"],
        expected: /unexpected routine meal_agent_private\.stage09a_added\(\)/,
      },
      {
        label: "private routine missing",
        // 重命名而不是 DROP：四个函数都被 policy 引用，DROP CASCADE 会连带删除
        // policy，掩盖「routine 缺失」这一条本身。
        inject: [
          "ALTER FUNCTION meal_agent_private.app_user_id() " +
            "RENAME TO app_user_id_moved",
        ],
        revert: [
          "ALTER FUNCTION meal_agent_private.app_user_id_moved() " +
            "RENAME TO app_user_id",
        ],
        expected: /missing routine meal_agent_private\.app_user_id\(\)/,
      },
      {
        label: "private routine overload",
        inject: [
          "CREATE FUNCTION meal_agent_private.app_user_id(extra int) " +
            "RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$",
        ],
        revert: ["DROP FUNCTION meal_agent_private.app_user_id(int)"],
        expected:
          /unexpected routine meal_agent_private\.app_user_id\(extra integer\)/,
      },
      {
        label: "private routine body drift",
        inject: [
          "CREATE OR REPLACE FUNCTION meal_agent_private.app_user_id() " +
            "RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE " +
            "AS $$SELECT '00000000-0000-7000-8000-000000000000'::uuid$$",
        ],
        revert: [],
        expected: /drifted routine meal_agent_private\.app_user_id\(\).*body=/,
      },
      {
        label: "private routine owner drift",
        inject: [
          "ALTER FUNCTION meal_agent_private.app_user_id() OWNER TO postgres",
        ],
        revert: [
          "ALTER FUNCTION meal_agent_private.app_user_id() " +
            "OWNER TO meal_agent_migrator",
        ],
        expected:
          /drifted routine meal_agent_private\.app_user_id\(\).*owner=postgres/,
      },
      {
        label: "SECURITY DEFINER search_path drift",
        inject: [
          "ALTER FUNCTION meal_agent_private.has_active_membership(uuid) " +
            "SET search_path = public",
        ],
        revert: [
          "ALTER FUNCTION meal_agent_private.has_active_membership(uuid) " +
            "SET search_path = pg_catalog, public",
        ],
        expected:
          /drifted routine meal_agent_private\.has_active_membership\(target_household_id uuid\).*config=search_path=public/,
      },
      {
        label: "SECURITY DEFINER row_security drift",
        inject: [
          "ALTER FUNCTION meal_agent_private.is_household_creator(uuid) " +
            "RESET row_security",
        ],
        revert: [
          "ALTER FUNCTION meal_agent_private.is_household_creator(uuid) " +
            "SET row_security = off",
        ],
        expected:
          /drifted routine meal_agent_private\.is_household_creator\(target_household_id uuid\)/,
      },
      {
        label: "SECURITY DEFINER turned into SECURITY INVOKER",
        inject: [
          "ALTER FUNCTION meal_agent_private.has_active_membership(uuid) " +
            "SECURITY INVOKER",
        ],
        revert: [
          "ALTER FUNCTION meal_agent_private.has_active_membership(uuid) " +
            "SECURITY DEFINER",
        ],
        expected:
          /drifted routine meal_agent_private\.has_active_membership\(target_household_id uuid\).*secdef=f/,
      },
      {
        label: "row level security disabled",
        inject: ["ALTER TABLE public.households DISABLE ROW LEVEL SECURITY"],
        revert: ["ALTER TABLE public.households ENABLE ROW LEVEL SECURITY"],
        expected: /drifted relation public\.households.*rls=f/,
      },
      {
        label: "force row level security dropped",
        inject: ["ALTER TABLE public.memberships NO FORCE ROW LEVEL SECURITY"],
        revert: ["ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY"],
        expected: /drifted relation public\.memberships.*force=f/,
      },
      {
        label: "policy added",
        inject: [
          "CREATE POLICY stage09a_extra ON public.households " +
            "FOR SELECT TO meal_agent_app USING (true)",
        ],
        revert: ["DROP POLICY stage09a_extra ON public.households"],
        expected: /unexpected policy public\.households\.stage09a_extra/,
      },
      {
        label: "policy removed",
        inject: [
          "ALTER POLICY households_user_list_select ON public.households " +
            "RENAME TO households_user_list_select_moved",
        ],
        revert: [
          "ALTER POLICY households_user_list_select_moved ON public.households " +
            "RENAME TO households_user_list_select",
        ],
        expected:
          /missing policy public\.households\.households_user_list_select/,
      },
      {
        label: "policy roles widened to PUBLIC",
        inject: [
          "ALTER POLICY households_user_list_select ON public.households " +
            "TO PUBLIC",
        ],
        revert: [
          "ALTER POLICY households_user_list_select ON public.households " +
            "TO meal_agent_app",
        ],
        expected:
          /drifted policy public\.households\.households_user_list_select.*roles=PUBLIC/,
      },
      {
        label: "policy USING rewritten",
        inject: [
          "ALTER POLICY households_user_list_select ON public.households " +
            "USING (true)",
        ],
        revert: [],
        expected:
          /drifted policy public\.households\.households_user_list_select.*using=true/,
      },
      {
        label: "policy WITH CHECK rewritten",
        inject: [
          "ALTER POLICY households_creator_insert ON public.households " +
            "WITH CHECK (true)",
        ],
        revert: [],
        expected:
          /drifted policy public\.households\.households_creator_insert.*check=true/,
      },
      {
        label: "policy command and permissiveness rewritten",
        inject: [
          "DROP POLICY households_creator_insert ON public.households",
          "CREATE POLICY households_creator_insert ON public.households " +
            "AS RESTRICTIVE FOR ALL TO meal_agent_app USING (true)",
        ],
        revert: [],
        expected:
          /drifted policy public\.households\.households_creator_insert.*permissive=f/,
      },
      {
        label: "index removed",
        inject: [
          "DROP INDEX public.person_profiles_linked_membership_unique",
        ],
        revert: [],
        expected:
          /missing index public\.person_profiles_linked_membership_unique/,
      },
      {
        label: "index added",
        inject: [
          "CREATE INDEX stage09a_extra_index ON public.users (locale)",
        ],
        revert: ["DROP INDEX public.stage09a_extra_index"],
        expected: /unexpected index public\.stage09a_extra_index/,
      },
      {
        label: "constraint removed",
        inject: [
          "ALTER TABLE public.users DROP CONSTRAINT users_status_check",
        ],
        revert: [],
        rebuild: true,
        expected: /missing constraint public\.users\.users_status_check/,
      },
      {
        label: "not null constraint dropped",
        inject: ["ALTER TABLE public.users ALTER COLUMN locale DROP NOT NULL"],
        revert: ["ALTER TABLE public.users ALTER COLUMN locale SET NOT NULL"],
        expected: /missing constraint public\.users\.users_locale_not_null/,
      },
    ];

    // 需要用捕获定义还原的用例，在这里补上还原语句。
    const revertOverrides = new Map<string, readonly string[]>([
      [
        "private routine body drift",
        // pg_get_functiondef 是 CREATE OR REPLACE 形式，可直接重放。
        [definitionOf("app_user_id")],
      ],
      [
        "policy USING rewritten",
        [
          "ALTER POLICY households_user_list_select ON public.households " +
            `USING (${definitionOf("households_user_list_select_using")})`,
        ],
      ],
      [
        "policy WITH CHECK rewritten",
        [
          "ALTER POLICY households_creator_insert ON public.households " +
            `WITH CHECK (${definitionOf("households_creator_insert_check")})`,
        ],
      ],
      [
        "policy command and permissiveness rewritten",
        [
          "DROP POLICY households_creator_insert ON public.households",
          "CREATE POLICY households_creator_insert ON public.households " +
            "FOR INSERT TO meal_agent_app WITH CHECK " +
            `(${definitionOf("households_creator_insert_check")})`,
        ],
      ],
      ["index removed", [definitionOf("linked_membership_index")]],
    ]);

    const cleanState = await ownerSnapshot();
    for (const driftCase of cases) {
      await runStatements(driftCase.inject);
      const beforeOwners = await ownerSnapshot();

      const rerun = await runPnpm("db:bootstrap", adminUrl(probe));
      const handoff = await bootstrap("handoff", probe);

      assert.notEqual(
        rerun.code,
        0,
        `db:bootstrap must reject: ${driftCase.label}`,
      );
      assert.notEqual(
        handoff.code,
        0,
        `handoff must reject: ${driftCase.label}`,
      );

      const rerunMessage = manifestRejection(rerun);
      const handoffMessage = manifestRejection(handoff);
      assert.match(
        rerunMessage,
        driftCase.expected,
        `db:bootstrap gave the wrong reason for: ${driftCase.label} ` +
          `(${rerunMessage.slice(0, 300)})`,
      );
      assert.equal(
        rerunMessage,
        handoffMessage,
        `the two entry points disagreed on: ${driftCase.label}`,
      );
      assert.equal(
        await ownerSnapshot(),
        beforeOwners,
        `${driftCase.label} mutated ownership before failing`,
      );

      if (driftCase.rebuild === true) {
        await withPool(adminPoolConfig("postgres"), async (pool) => {
          await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
          await pool.query(`CREATE DATABASE ${probe}`);
        });
      } else {
        await runStatements(
          revertOverrides.get(driftCase.label) ?? driftCase.revert,
        );
      }

      // 还原之后必须重新干净：这既证明反例是可逆的，也保证下一个用例不会
      // 建立在残留漂移之上。
      await mustSucceedCli(
        `pnpm db:bootstrap (clean after ${driftCase.label})`,
        await runPnpm("db:bootstrap", adminUrl(probe)),
      );
      assert.equal(
        await ownerSnapshot(),
        cleanState,
        `${driftCase.label} left ownership changed`,
      );
    }
    process.stdout.write(
      `stage06 manifest drift cases: ${String(cases.length)} rejected ` +
        "identically by db:bootstrap and bootstrap.sh handoff\n",
    );
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    });
  }
});

test("the private schema stays closed and the app role cannot create objects there", async () => {
  const privateState = async (): Promise<Record<string, boolean>> =>
    withPool(adminPoolConfig(), async (pool) => {
      const result = await pool.query(
        `SELECT
           has_schema_privilege('public', 'meal_agent_private', 'USAGE')
             AS public_usage,
           has_schema_privilege('public', 'meal_agent_private', 'CREATE')
             AS public_create,
           has_schema_privilege('meal_agent_app', 'meal_agent_private', 'USAGE')
             AS app_usage,
           has_schema_privilege('meal_agent_app', 'meal_agent_private', 'CREATE')
             AS app_create,
           has_schema_privilege('meal_agent_backup', 'meal_agent_private',
                                'USAGE') AS backup_usage,
           has_schema_privilege('meal_agent_runtime_login',
                                'meal_agent_private', 'USAGE')
             AS runtime_login_usage,
           has_schema_privilege('meal_agent_backup_login',
                                'meal_agent_private', 'USAGE')
             AS backup_login_usage,
           has_schema_privilege('meal_agent_migration_login',
                                'meal_agent_private', 'USAGE')
             AS migration_login_usage`,
      );
      return result.rows[0] as unknown as Record<string, boolean>;
    });

  const baseline = {
    public_usage: false,
    public_create: false,
    app_usage: true,
    app_create: false,
    backup_usage: false,
    runtime_login_usage: false,
    backup_login_usage: false,
    migration_login_usage: false,
  };
  assert.deepEqual(await privateState(), baseline);

  // 注入：PUBLIC 拿到 USAGE + CREATE，app 直接拿到 CREATE，backup 拿到 USAGE，
  // 并且其中一条由独立 grantor 授予，证明收敛是按真实 grantor 进行的。
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("DROP ROLE IF EXISTS stage09a_private_grantor");
    await pool.query("CREATE ROLE stage09a_private_grantor NOLOGIN");
    await pool.query(
      "GRANT USAGE ON SCHEMA meal_agent_private TO stage09a_private_grantor " +
        "WITH GRANT OPTION",
    );
    await pool.query(
      "GRANT USAGE, CREATE ON SCHEMA meal_agent_private TO PUBLIC",
    );
    await pool.query(
      "GRANT CREATE ON SCHEMA meal_agent_private TO meal_agent_app",
    );
    const client = await pool.connect();
    try {
      await client.query(
        "SELECT set_config('role', 'stage09a_private_grantor', false)",
      );
      await client.query(
        "GRANT USAGE ON SCHEMA meal_agent_private TO meal_agent_backup",
      );
    } finally {
      client.release();
    }
  });

  const widened = await privateState();
  assert.equal(widened["public_create"], true, "drift must actually widen");
  assert.equal(widened["backup_usage"], true, "drift must actually widen");

  const grantor = await withPool(adminPoolConfig(), async (pool) => {
    const result = await pool.query<{ grantor: string }>(
      `SELECT pg_catalog.pg_get_userbyid(acl.grantor) AS grantor
         FROM pg_namespace n, aclexplode(n.nspacl) AS acl
        WHERE n.nspname = 'meal_agent_private' AND acl.grantee <> 0
          AND pg_catalog.pg_get_userbyid(acl.grantee) = 'meal_agent_backup'`,
    );
    return result.rows[0]?.grantor;
  });
  assert.equal(grantor, "stage09a_private_grantor");

  try {
    await runBootstrap("acl");
    assert.deepEqual(
      await privateState(),
      baseline,
      "the acl baseline must converge meal_agent_private back to the baseline",
    );

    // app 仍然能调用受控函数，但不能在这个 schema 里建任何对象。
    await withPool(runtimeLoginUrl(), async (pool) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('role', 'meal_agent_app', true)");
        const callable = await client.query<{ value: string | null }>(
          "SELECT meal_agent_private.app_user_id()::text AS value",
        );
        assert.equal(callable.rows[0]?.value, null);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      for (const statement of [
        "CREATE TABLE meal_agent_private.stage09a_app_owned (id int)",
        "CREATE FUNCTION meal_agent_private.stage09a_app_fn() RETURNS int " +
          "LANGUAGE sql AS $$SELECT 1$$",
      ]) {
        assert.match(
          String(await attempt(pool, [statement], "meal_agent_app")),
          /permission denied/i,
          `meal_agent_app must not create objects in meal_agent_private: ` +
            statement.slice(0, 50),
        );
      }
    });

    // backup 连 schema 都进不去。
    await withPool(backupLoginUrl(), async (pool) => {
      assert.match(
        String(
          await attempt(
            pool,
            ["SELECT meal_agent_private.app_user_id()"],
            "meal_agent_backup",
          ),
        ),
        /permission denied/i,
      );
    });
  } finally {
    await withPool(adminPoolConfig(), async (pool) => {
      await pool.query(
        "REVOKE ALL ON SCHEMA meal_agent_private FROM stage09a_private_grantor",
      );
      await pool.query("DROP ROLE IF EXISTS stage09a_private_grantor");
    });
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("a restore-style SECURITY DEFINER routine in drizzle fails both baselines closed", async () => {
  // 恢复路径不跑 0000，对象全部来自 dump：dump 可以把任意函数带进 drizzle。
  // 这类函数默认带 PUBLIC EXECUTE，于是 app 与 backup 会**派生**出以 migrator
  // 身份执行的能力。基线必须 fail closed，而不是只看直接授权后放行。
  await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
    await client.query(
      "CREATE FUNCTION drizzle.stage09a_restored_backdoor() RETURNS text " +
        "LANGUAGE sql SECURITY DEFINER AS $$SELECT current_user::text$$",
    );
  });
  try {
    // 0. 基线的 default privileges 已经收回了「migrator 新建函数默认给 PUBLIC
    //    EXECUTE」，所以刚建好时还没有派生权限。
    const beforeRestoreGrant = await withPool(
      adminPoolConfig(),
      async (pool) => {
        const result = await pool.query<{ app: boolean }>(
          `SELECT has_function_privilege('meal_agent_app',
                    'drizzle.stage09a_restored_backdoor()'::regprocedure,
                    'EXECUTE') AS app`,
        );
        return result.rows[0]?.app;
      },
    );
    assert.equal(
      beforeRestoreGrant,
      false,
      "the default-privilege baseline must already deny PUBLIC EXECUTE",
    );

    // 1. pg_restore 会把 dump 里记录的 ACL 原样重放，包括显式的
    //    `GRANT EXECUTE ... TO PUBLIC`。default privileges 管不到它。
    await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
      await client.query(
        "GRANT EXECUTE ON FUNCTION drizzle.stage09a_restored_backdoor() " +
          "TO PUBLIC",
      );
    });

    // 派生 EXECUTE 客观存在：这正是只查直接授权会漏掉的那一份。
    const derived = await withPool(adminPoolConfig(), async (pool) => {
      const result = await pool.query<{ app: boolean; backup: boolean }>(
        `SELECT has_function_privilege('meal_agent_app',
                  'drizzle.stage09a_restored_backdoor()'::regprocedure,
                  'EXECUTE') AS app,
                has_function_privilege('meal_agent_backup',
                  'drizzle.stage09a_restored_backdoor()'::regprocedure,
                  'EXECUTE') AS backup`,
      );
      return result.rows[0];
    });
    assert.equal(derived?.app, true, "PUBLIC EXECUTE derives to app");
    assert.equal(derived?.backup, true, "PUBLIC EXECUTE derives to backup");

    // 2. 两个 database scope 阶段都必须拒绝。
    const acl = await bootstrap("acl");
    assert.notEqual(acl.code, 0, "acl must refuse a drizzle routine");
    assert.match(
      acl.stderr,
      /public and drizzle must not contain routines: drizzle\.stage09a_restored_backdoor\(\) \[security definer: t\]/,
    );

    const grants = await bootstrap("grants");
    assert.notEqual(grants.code, 0, "grants must refuse a drizzle routine");
    assert.match(
      grants.stderr,
      /backup grants: public and drizzle must not contain routines: drizzle\.stage09a_restored_backdoor\(\) \[security definer: t\]/,
    );

    // 3. 收回 PUBLIC EXECUTE（基线对已知 routine 做的事）之后，app 与 backup
    //    都不能再以 migrator 身份执行它。
    await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
      await client.query(
        "REVOKE EXECUTE ON FUNCTION drizzle.stage09a_restored_backdoor() " +
          "FROM PUBLIC",
      );
    });
    for (const [url, role] of [
      [runtimeLoginUrl(), "meal_agent_app"],
      [backupLoginUrl(), "meal_agent_backup"],
    ] as const) {
      await withPool(url, async (pool) => {
        assert.match(
          String(
            await attempt(
              pool,
              ["SELECT drizzle.stage09a_restored_backdoor()"],
              role,
            ),
          ),
          /permission denied/i,
          `${role} must not execute a drizzle SECURITY DEFINER routine`,
        );
      });
    }
  } finally {
    await asRole(migrationLoginUrl(), "meal_agent_migrator", async (client) => {
      await client.query(
        "DROP FUNCTION IF EXISTS drizzle.stage09a_restored_backdoor()",
      );
    });
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("large object privileges are converged and stay unreachable for runtime and backup", async () => {
  // Large Object 不受 schema ACL 与 RLS 约束：任何项目角色拿到 LO 权限都等于
  // 绕开整套边界。当前产品不使用 LO，因此基线的策略是「存在即收敛并断言为空」。
  const largeObjectId = await withPool(adminPoolConfig(), async (pool) => {
    const result = await pool.query<{ loid: string }>(
      "SELECT lo_from_bytea(0, 'stage09a-sentinel'::bytea)::text AS loid",
    );
    const loid = result.rows[0]?.loid;
    assert.ok(loid !== undefined);
    return loid;
  });

  const leftover = async (): Promise<number> =>
    withPool(adminPoolConfig(), async (pool) => {
      const result = await pool.query<{ count: string }>(
        `SELECT (
           (SELECT count(*) FROM pg_largeobject_metadata m,
                   aclexplode(m.lomacl) AS acl
             WHERE acl.grantee = 0
                OR pg_catalog.pg_get_userbyid(acl.grantee) LIKE 'meal\\_agent%')
           + (SELECT count(*) FROM pg_default_acl d, aclexplode(d.defaclacl) acl
               WHERE d.defaclobjtype = 'L'
                 AND acl.grantee IS DISTINCT FROM d.defaclrole)
         )::text AS count`,
      );
      return Number(result.rows[0]?.count ?? "-1");
    });

  try {
    assert.equal(await leftover(), 0, "the baseline starts with no LO grants");

    // 注入：直接授权、PUBLIC 授权与 objtype='L' 的默认权限漂移。
    await withPool(adminPoolConfig(), async (pool) => {
      await pool.query(
        `GRANT SELECT, UPDATE ON LARGE OBJECT ${largeObjectId} ` +
          "TO meal_agent_app, meal_agent_backup, meal_agent_runtime_login",
      );
      await pool.query(
        `GRANT SELECT ON LARGE OBJECT ${largeObjectId} TO PUBLIC`,
      );
      await pool.query(
        "ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator " +
          "GRANT SELECT, UPDATE ON LARGE OBJECTS TO meal_agent_backup",
      );
      await pool.query(
        "ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator " +
          "GRANT SELECT ON LARGE OBJECTS TO PUBLIC",
      );
    });
    assert.ok(await leftover() > 0, "the drift must actually widen");

    await runBootstrap("acl");
    assert.equal(
      await leftover(),
      0,
      "the acl baseline must converge every large object privilege",
    );
    await runBootstrap("grants");
    assert.equal(await leftover(), 0, "grants must keep the LO baseline empty");

    // runtime 与 backup 都不能写入 Large Object。
    for (const [url, role] of [
      [runtimeLoginUrl(), "meal_agent_app"],
      [backupLoginUrl(), "meal_agent_backup"],
    ] as const) {
      await withPool(url, async (pool) => {
        for (const statement of [
          `SELECT lo_put(${largeObjectId}, 0, 'tampered'::bytea)`,
          `SELECT lo_get(${largeObjectId})`,
          `UPDATE pg_largeobject SET data = 'x'::bytea ` +
            `WHERE loid = ${largeObjectId}`,
        ]) {
          assert.match(
            String(await attempt(pool, [statement], role)),
            /permission denied|must be owner/i,
            `${role} must not reach large object ${largeObjectId}: ` +
              statement.slice(0, 40),
          );
        }
      });
    }
  } finally {
    await withPool(adminPoolConfig(), async (pool) => {
      await pool.query(`SELECT lo_unlink(${largeObjectId})`).catch(() => undefined);
    });
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("a database-level PUBLIC grant from an independent grantor is converged, not rolled back", async () => {
  // 回归：跨 grantor 的 PUBLIC CONNECT 此前只在后置校验里失败并整体回滚，
  // 权限依旧留在数据库里。现在它必须被**真正撤销**，且命令成功返回。
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("DROP ROLE IF EXISTS stage09a_db_grantor");
    await pool.query("CREATE ROLE stage09a_db_grantor NOLOGIN");
    await pool.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${rolesDatabase} ` +
        "TO stage09a_db_grantor WITH GRANT OPTION",
    );
    const client = await pool.connect();
    try {
      await client.query(
        "SELECT set_config('role', 'stage09a_db_grantor', false)",
      );
      await client.query(
        `GRANT CONNECT, TEMPORARY ON DATABASE ${rolesDatabase} TO PUBLIC`,
      );
    } finally {
      client.release();
    }
  });

  try {
    const injected = await withPool(adminPoolConfig(), async (pool) => {
      const result = await pool.query<{ grantor: string; privilege: string }>(
        `SELECT pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
                acl.privilege_type AS privilege
           FROM pg_database d, aclexplode(d.datacl) AS acl
          WHERE d.datname = current_database() AND acl.grantee = 0
          ORDER BY privilege`,
      );
      return result.rows;
    });
    assert.deepEqual(
      injected.map((row) => `${row.grantor}:${row.privilege}`),
      ["stage09a_db_grantor:CONNECT", "stage09a_db_grantor:TEMPORARY"],
      "the PUBLIC grant must genuinely come from an independent grantor",
    );

    // 收敛必须成功——不是「失败并回滚」。
    await runBootstrap("acl");

    await withPool(adminPoolConfig(), async (pool) => {
      const remaining = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_database d, aclexplode(d.datacl) AS acl
          WHERE d.datname = current_database() AND acl.grantee = 0`,
      );
      assert.equal(remaining.rows[0]?.count, "0", "PUBLIC must hold nothing");
      const effective = await pool.query<{ connect: boolean; temp: boolean }>(
        `SELECT has_database_privilege('public', current_database(), 'CONNECT')
                  AS connect,
                has_database_privilege('public', current_database(), 'TEMP')
                  AS temp`,
      );
      assert.equal(effective.rows[0]?.connect, false);
      assert.equal(effective.rows[0]?.temp, false);
    });
  } finally {
    await withPool(adminPoolConfig(), async (pool) => {
      await pool.query(
        `REVOKE ALL ON DATABASE ${rolesDatabase} ` +
          "FROM stage09a_db_grantor CASCADE",
      );
      await pool.query("DROP ROLE IF EXISTS stage09a_db_grantor");
    });
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("a missing managed schema fails the acl baseline before any mutation", async () => {
  const probe = "meal_agent_stage09a_missing_schema";
  try {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      await pool.query(`CREATE DATABASE ${probe}`);
    });
    await mustSucceedCli(
      "pnpm db:bootstrap (missing schema probe)",
      await runPnpm("db:bootstrap", adminUrl(probe)),
    );
    await runBootstrap("handoff", probe);
    await runBootstrap("acl", probe);

    // 先制造一处**可观察的**待收敛漂移，再删掉一个 managed schema：
    // 失败必须发生在任何 mutation 之前，因此漂移必须原封不动地留着。
    await withPool(adminPoolConfig(probe), async (pool) => {
      await pool.query("GRANT USAGE, CREATE ON SCHEMA public TO PUBLIC");
      await pool.query("DROP SCHEMA meal_agent_private CASCADE");
    });

    const result = await bootstrap("acl", probe);
    assert.notEqual(result.code, 0, "acl must refuse a missing managed schema");
    assert.match(
      result.stderr,
      /managed schema\(s\) missing: meal_agent_private/,
    );

    await withPool(adminPoolConfig(probe), async (pool) => {
      const state = await pool.query<{ usage: boolean; create: boolean }>(
        `SELECT has_schema_privilege('public', 'public', 'USAGE') AS usage,
                has_schema_privilege('public', 'public', 'CREATE') AS create`,
      );
      assert.equal(
        state.rows[0]?.usage,
        true,
        "the baseline must not have converged anything before failing",
      );
      assert.equal(state.rows[0]?.create, true);
    });
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 阶段 09A / M2A 第六轮：对象 manifest 的补全项、ledger 感知的授权 manifest，
// 以及 Large Object 创建入口的封堵。
// ---------------------------------------------------------------------------

const generatedSql = (name: string): string =>
  join(repositoryRoot, "infra/docker/postgres/sql/database/generated", name);

/** 只跑 generated 的授权断言块（不收敛），用于验证「后验」本身抓得住漂移。 */
const runAuthorizationVerify = async (
  phase: "containment" | "final",
  database: string = rolesDatabase,
): Promise<RunResult> =>
  runCaptured(
    join(postgresBin, "psql"),
    [
      "--no-psqlrc",
      "--quiet",
      "--no-password",
      "--set",
      "ON_ERROR_STOP=on",
      "--dbname",
      database,
      "--command",
      `SELECT set_config('meal_agent.acl_phase', '${phase}', false)`,
      "--file",
      generatedSql("authorization-verify.generated.sql"),
    ],
    { env: adminEnvironment() },
  );

/** 只跑 generated 的对象 manifest 块。 */
const runObjectManifest = async (database: string): Promise<RunResult> =>
  runCaptured(
    join(postgresBin, "psql"),
    [
      "--no-psqlrc",
      "--quiet",
      "--no-password",
      "--set",
      "ON_ERROR_STOP=on",
      "--dbname",
      database,
      "--file",
      generatedSql("0000-object-manifest.generated.sql"),
    ],
    { env: adminEnvironment() },
  );

test("the object manifest covers columns, user types, namespace objects and constraint triggers", async () => {
  const probe = "meal_agent_stage09a_objects";
  const cases: readonly [string, readonly string[], readonly string[], RegExp][] =
    [
      [
        "column added",
        ["ALTER TABLE public.users ADD COLUMN stage09a_extra int"],
        ["ALTER TABLE public.users DROP COLUMN stage09a_extra"],
        /unexpected column public\.users\.stage09a_extra/,
      ],
      [
        "column type widened",
        ["ALTER TABLE public.users ALTER COLUMN locale TYPE varchar(64)"],
        [],
        /drifted column public\.users\.locale.*type=character varying\(64\)/,
      ],
      [
        "column default introduced",
        ["ALTER TABLE public.users ALTER COLUMN locale SET DEFAULT 'zh-CN'"],
        ["ALTER TABLE public.users ALTER COLUMN locale DROP DEFAULT"],
        /drifted column public\.users\.locale.*default='zh-CN'/,
      ],
      [
        "column renamed",
        ["ALTER TABLE public.users RENAME COLUMN locale TO locale_moved"],
        ["ALTER TABLE public.users RENAME COLUMN locale_moved TO locale"],
        /missing column public\.users\.locale/,
      ],
      [
        "shell type created",
        ["CREATE TYPE public.stage09a_shell"],
        ["DROP TYPE public.stage09a_shell"],
        /unexpected type public\.stage09a_shell/,
      ],
      [
        "enum type created",
        ["CREATE TYPE public.stage09a_enum AS ENUM ('a', 'b')"],
        ["DROP TYPE public.stage09a_enum"],
        /unexpected type public\.stage09a_enum/,
      ],
      [
        "operator created",
        [
          "CREATE FUNCTION public.stage09a_op(int, int) RETURNS int " +
            "LANGUAGE sql IMMUTABLE AS $$SELECT $1 + $2$$",
          "CREATE OPERATOR public.### (LEFTARG = int, RIGHTARG = int, " +
            "FUNCTION = public.stage09a_op)",
        ],
        [
          "DROP OPERATOR public.### (int, int)",
          "DROP FUNCTION public.stage09a_op(int, int)",
        ],
        /unexpected operator public\.###/,
      ],
      [
        "collation created",
        [
          "CREATE COLLATION public.stage09a_collation " +
            "(provider = libc, locale = 'C')",
        ],
        ["DROP COLLATION public.stage09a_collation"],
        /unexpected collation public\.stage09a_collation/,
      ],
      [
        "rule created",
        [
          "CREATE RULE stage09a_rule AS ON DELETE TO public.users " +
            "DO INSTEAD NOTHING",
        ],
        ["DROP RULE stage09a_rule ON public.users"],
        /unexpected rule public\.users\.stage09a_rule/,
      ],
      [
        "foreign key enforcement disabled",
        // 内部触发器被禁用之后，外键不再强制，而表结构、约束定义与 RLS 全都
        // 看不出任何变化——这正是必须覆盖 tgisinternal 的原因。
        ["ALTER TABLE public.auth_identities DISABLE TRIGGER ALL"],
        ["ALTER TABLE public.auth_identities ENABLE TRIGGER ALL"],
        /drifted constraint-trigger public\.auth_identities\..*enabled=D/,
      ],
    ];

  try {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      await pool.query(`CREATE DATABASE ${probe}`);
    });
    await mustSucceedCli(
      "pnpm db:bootstrap (object probe)",
      await runPnpm("db:bootstrap", adminUrl(probe)),
    );
    assert.equal((await runObjectManifest(probe)).code, 0, "clean baseline");

    for (const [label, inject, revert, expected] of cases) {
      await withPool(adminPoolConfig(probe), async (pool) => {
        for (const statement of inject) {
          await pool.query(statement);
        }
      });
      const result = await runObjectManifest(probe);
      assert.notEqual(result.code, 0, `manifest must reject: ${label}`);
      assert.match(result.stderr, expected, `wrong detail for: ${label}`);

      if (revert.length === 0) {
        await withPool(adminPoolConfig("postgres"), async (pool) => {
          await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
          await pool.query(`CREATE DATABASE ${probe}`);
        });
        await mustSucceedCli(
          `pnpm db:bootstrap (rebuild after ${label})`,
          await runPnpm("db:bootstrap", adminUrl(probe)),
        );
      } else {
        await withPool(adminPoolConfig(probe), async (pool) => {
          for (const statement of revert) {
            await pool.query(statement);
          }
        });
      }
      assert.equal(
        (await runObjectManifest(probe)).code,
        0,
        `state must be clean again after ${label}`,
      );
    }
    process.stdout.write(
      `stage06 manifest object cases: ${String(cases.length)} rejected\n`,
    );
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    });
  }
});

test("the object manifest is stable across session GUCs and catches a post-handoff owner grab", async () => {
  const probe = "meal_agent_stage09a_session";
  try {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      await pool.query(`CREATE DATABASE ${probe}`);
    });
    await mustSucceedCli(
      "pnpm db:bootstrap (session probe)",
      await runPnpm("db:bootstrap", adminUrl(probe)),
    );

    // 1. quote_all_identifiers 与宽 search_path 都不得制造假阳性：
    //    pg_get_indexdef / pg_get_constraintdef / pg_get_expr 的输出受这两个
    //    GUC 影响，渲染块在事务内固定它们。
    for (const guc of [
      "SET quote_all_identifiers = on",
      "SET search_path = public, meal_agent_private, drizzle",
    ]) {
      const result = await runCaptured(
        join(postgresBin, "psql"),
        [
          "--no-psqlrc",
          "--quiet",
          "--no-password",
          "--set",
          "ON_ERROR_STOP=on",
          "--dbname",
          probe,
          "--command",
          guc,
          "--file",
          generatedSql("0000-object-manifest.generated.sql"),
        ],
        { env: adminEnvironment() },
      );
      assert.equal(
        result.code,
        0,
        `the manifest must be stable under: ${guc} (${result.stderr.slice(0, 300)})`,
      );
    }

    // 2. handoff **之前** admin 拥有 public/drizzle 是合法过渡态；handoff 之后
    //    整组属于 migrator 也是合法态。两者都必须正向通过。
    assert.equal((await runObjectManifest(probe)).code, 0, "legal pre-handoff");
    await runBootstrap("handoff", probe);
    assert.equal((await runObjectManifest(probe)).code, 0, "legal post-handoff");

    // 2b. `set_config(..., true)` 只在事务结束时恢复，不会在 DO 结束时恢复。
    //     这些块是在 BEGIN…COMMIT 里被 \ir 进来的，因此必须显式还原，否则同一
    //     事务里后续语句会继承被改过的 GUC。
    const restored = await runCaptured(
      join(postgresBin, "psql"),
      [
        "--no-psqlrc",
        "--quiet",
        "--no-password",
        "--tuples-only",
        "--no-align",
        "--set",
        "ON_ERROR_STOP=on",
        "--dbname",
        probe,
        "--command",
        "BEGIN",
        "--command",
        "SET quote_all_identifiers = on",
        "--command",
        "SET search_path = public",
        "--file",
        generatedSql("0000-object-manifest.generated.sql"),
        "--command",
        "SHOW quote_all_identifiers",
        "--command",
        "SHOW search_path",
        "--command",
        "COMMIT",
      ],
      { env: adminEnvironment() },
    );
    assert.equal(restored.code, 0, restored.stderr.slice(0, 300));
    // 精确断言：SHOW 的两行输出必须**恰好**是调用方设置的值。
    const shown = restored.stdout.split("\n").filter((line) => line !== "");
    assert.deepEqual(
      shown,
      ["on", '"public"'],
      `both GUCs must be restored exactly, saw: ${JSON.stringify(restored.stdout)}`,
    );

    // 3. handoff 阶段由**整组** owner 判定，不是 database owner 单字段。任何
    //    混合态都必须直接拒绝——单字段判据会被一次局部改动整体带偏。
    //
    //    每个用例的注入必须是**真正不同**的混合态，并由独立 catalog 查询给出
    //    「哪些成员已被夺回」的实际集合：两个注入语句相同、只有断言措辞不同的
    //    用例证明不了任何额外的事。
    const handoffOwners = async (): Promise<readonly string[]> =>
      withPool(adminPoolConfig(probe), async (pool) => {
        const result = await pool.query<{ entry: string }>(
          `SELECT 'database:' || pg_catalog.pg_get_userbyid(d.datdba) AS entry
             FROM pg_catalog.pg_database d WHERE d.datname = current_database()
           UNION ALL
           SELECT 'schema:' || n.nspname || ':'
                  || pg_catalog.pg_get_userbyid(n.nspowner)
             FROM pg_catalog.pg_namespace n
            WHERE n.nspname IN ('drizzle', 'public')
           UNION ALL
           SELECT 'relation:' || pg_catalog.pg_get_userbyid(c.relowner)
             FROM pg_catalog.pg_class c
            WHERE c.oid = 'drizzle.__meal_agent_migrations'::regclass
           UNION ALL
           SELECT 'type:' || pg_catalog.pg_get_userbyid(t.typowner)
             FROM pg_catalog.pg_type t
            WHERE t.oid = 'drizzle.___meal_agent_migrations'::regtype
           ORDER BY 1`,
        );
        return result.rows.map((row) => row.entry);
      });

    for (const [label, grab, restore, expected, preHandoff] of [
      [
        "only the database owner grabbed back",
        [`ALTER DATABASE ${probe} OWNER TO postgres`],
        [`ALTER DATABASE ${probe} OWNER TO meal_agent_migrator`],
        /owner handoff group is in a mixed state \(meal_agent_migrator,postgres\)/,
        ["database:postgres"],
      ],
      [
        "only schema drizzle grabbed back",
        ["ALTER SCHEMA drizzle OWNER TO postgres"],
        ["ALTER SCHEMA drizzle OWNER TO meal_agent_migrator"],
        /entirely pre-handoff or entirely owned by meal_agent_migrator/,
        ["schema:drizzle:postgres"],
      ],
      [
        // 真正的「分裂」：整个 drizzle 子树回到 admin，而 database 与 public
        // 仍然已交接。上一个用例只夺回 schema，本用例连 ledger 与其数组类型
        // 一起夺回——两者的实际 owner 集合不同。
        "the whole drizzle subtree pre-handoff while database and public stay",
        [
          "ALTER SCHEMA drizzle OWNER TO postgres",
          "ALTER TABLE drizzle.__meal_agent_migrations OWNER TO postgres",
        ],
        [
          "ALTER TABLE drizzle.__meal_agent_migrations OWNER TO meal_agent_migrator",
          "ALTER SCHEMA drizzle OWNER TO meal_agent_migrator",
        ],
        /owner handoff group is in a mixed state \(meal_agent_migrator,postgres\)/,
        [
          "relation:postgres",
          "schema:drizzle:postgres",
          "type:postgres",
        ],
      ],
      [
        "only schema public grabbed back",
        ["ALTER SCHEMA public OWNER TO postgres"],
        ["ALTER SCHEMA public OWNER TO meal_agent_migrator"],
        /owner handoff group is in a mixed state/,
        ["schema:public:postgres"],
      ],
      [
        "only the ledger grabbed back",
        ["ALTER TABLE drizzle.__meal_agent_migrations OWNER TO postgres"],
        [
          "ALTER TABLE drizzle.__meal_agent_migrations OWNER TO meal_agent_migrator",
        ],
        /owner handoff group is in a mixed state/,
        ["relation:postgres", "type:postgres"],
      ],
    ] as const) {
      const handedOff = await handoffOwners();
      await withPool(adminPoolConfig(probe), async (pool) => {
        for (const statement of grab) {
          await pool.query(statement);
        }
      });
      // 注入产生的实际混合态：与其它用例逐一不同。
      assert.deepEqual(
        (await handoffOwners()).filter((entry) => entry.endsWith(":postgres")),
        preHandoff,
        `${label} must inject exactly this mixed-owner set`,
      );
      const result = await runObjectManifest(probe);
      assert.notEqual(result.code, 0, `post-handoff ${label} grab must fail`);
      assert.match(result.stderr, expected);
      await withPool(adminPoolConfig(probe), async (pool) => {
        for (const statement of restore) {
          await pool.query(statement);
        }
      });
      assert.deepEqual(
        await handoffOwners(),
        handedOff,
        `${label} must restore the exact owner tuple`,
      );
      assert.equal((await runObjectManifest(probe)).code, 0);
    }
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
    });
  }
});

test("the authorization manifest is ledger-aware and fails closed on unknown states", async () => {
  // 1. 当前 ledger 的两个阶段都必须通过。
  await runBootstrap("grants");
  assert.equal((await runAuthorizationVerify("final")).code, 0);

  // 2. containment 阶段的期望与 final 不同：备份角色的表级 SELECT 只属于 final。
  const containment = await runAuthorizationVerify("containment");
  assert.notEqual(
    containment.code,
    0,
    "a final-phase database must not satisfy the containment expectation",
  );
  assert.match(
    containment.stderr,
    /unexpected (grant|effective) relation:[a-z_.]+#meal_agent_backup/,
  );

  // 3. 未登记的 ledger：加一条假 migration 记录，两个阶段都必须 fail closed。
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query(
      `INSERT INTO drizzle.__meal_agent_migrations (name, hash)
       VALUES ('9999_not_registered.sql', repeat('0', 64))`,
    );
  });
  try {
    for (const phase of ["containment", "final"] as const) {
      const result = await runAuthorizationVerify(phase);
      assert.notEqual(result.code, 0, `${phase} must refuse an unknown ledger`);
      assert.match(
        result.stderr,
        /unregistered \(ledger, phase\) state .*9999_not_registered\.sql/,
      );
    }
    const acl = await bootstrap("acl");
    assert.notEqual(acl.code, 0, "converge must refuse an unknown ledger too");
    assert.match(acl.stderr, /unregistered \(ledger, phase\) state/);
  } finally {
    await withPool(adminPoolConfig(), async (pool) => {
      await pool.query(
        "DELETE FROM drizzle.__meal_agent_migrations WHERE name = '9999_not_registered.sql'",
      );
    });
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("the final authorization check covers PUBLIC and app, not only backup", async () => {
  interface AuthorizationCase {
    readonly label: string;
    readonly inject: readonly string[];
    readonly expected: RegExp;
  }
  const cases: readonly AuthorizationCase[] = [
    {
      label: "app widened with DELETE",
      inject: ["GRANT DELETE ON public.users TO meal_agent_app"],
      expected: /drifted (grant|effective) relation:public\.users#meal_agent_app/,
    },
    {
      label: "PUBLIC granted table SELECT",
      inject: ["GRANT SELECT ON public.households TO PUBLIC"],
      expected: /unexpected (grant|effective) relation:public\.households#PUBLIC/,
    },
    {
      label: "PUBLIC granted EXECUTE on a private routine",
      // 只查直接授权看不见这一份：它是 PUBLIC 派生给 backup 与三个 login 的。
      inject: [
        "GRANT EXECUTE ON FUNCTION meal_agent_private.app_user_id() TO PUBLIC",
      ],
      expected:
        /unexpected effective routine:meal_agent_private\.app_user_id\(\)#meal_agent_backup/,
    },
    {
      label: "login granted schema USAGE",
      inject: ["GRANT USAGE ON SCHEMA public TO meal_agent_runtime_login"],
      expected: /unexpected (grant|effective) schema:public#meal_agent_runtime_login/,
    },
    {
      label: "backup default privilege widened",
      inject: [
        "ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator IN SCHEMA public " +
          "GRANT INSERT ON TABLES TO meal_agent_backup",
      ],
      expected: /drifted default r@public#meal_agent_backup/,
    },
    {
      label: "large object entry point reopened",
      inject: ["GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO PUBLIC"],
      expected:
        /unexpected effective routine:pg_catalog\.lo_create\(oid\)#meal_agent_app/,
    },
  ];

  try {
    for (const authorizationCase of cases) {
      await withPool(adminPoolConfig(), async (pool) => {
        for (const statement of authorizationCase.inject) {
          await pool.query(statement);
        }
      });
      const verified = await runAuthorizationVerify("final");
      assert.notEqual(
        verified.code,
        0,
        `the final check must reject: ${authorizationCase.label}`,
      );
      assert.match(
        verified.stderr,
        authorizationCase.expected,
        `wrong detail for: ${authorizationCase.label}`,
      );

      // 收敛之后必须重新通过——「撤销一切不在 manifest 里的，再只重建允许项」。
      await runBootstrap("grants");
      assert.equal(
        (await runAuthorizationVerify("final")).code,
        0,
        `converge must restore the baseline after: ${authorizationCase.label}`,
      );
    }
    process.stdout.write(
      `authorization drift cases: ${String(cases.length)} rejected and converged\n`,
    );
  } finally {
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("a private routine is matched by identity, owner, SECURITY DEFINER, proconfig and body", async () => {
  // 禁止 schema 级通配豁免：meal_agent_private 里的每个 routine 都按 identity
  // 精确匹配指纹，而不是「只要在这个 schema 就放行」。
  const cases: readonly [string, string, string, RegExp][] = [
    [
      "owner drift",
      "ALTER FUNCTION meal_agent_private.app_user_id() OWNER TO postgres",
      "ALTER FUNCTION meal_agent_private.app_user_id() OWNER TO meal_agent_migrator",
      /drifted routine meal_agent_private\.app_user_id\(\).*owner=postgres/,
    ],
    [
      "SECURITY INVOKER",
      "ALTER FUNCTION meal_agent_private.is_active_owner(uuid) SECURITY INVOKER",
      "ALTER FUNCTION meal_agent_private.is_active_owner(uuid) SECURITY DEFINER",
      /drifted routine meal_agent_private\.is_active_owner\(target_household_id uuid\).*secdef=f/,
    ],
    [
      "search_path drift",
      "ALTER FUNCTION meal_agent_private.is_active_owner(uuid) SET search_path = public",
      "ALTER FUNCTION meal_agent_private.is_active_owner(uuid) " +
        "SET search_path = pg_catalog, public",
      /drifted routine meal_agent_private\.is_active_owner\(target_household_id uuid\).*config=search_path=public/,
    ],
    [
      "row_security drift",
      "ALTER FUNCTION meal_agent_private.is_active_owner(uuid) RESET row_security",
      "ALTER FUNCTION meal_agent_private.is_active_owner(uuid) SET row_security = off",
      /drifted routine meal_agent_private\.is_active_owner\(target_household_id uuid\)/,
    ],
    [
      "unexpected routine",
      "CREATE FUNCTION meal_agent_private.stage09a_sixth() RETURNS int " +
        "LANGUAGE sql AS $$SELECT 1$$",
      "DROP FUNCTION meal_agent_private.stage09a_sixth()",
      /unexpected routine meal_agent_private\.stage09a_sixth\(\)/,
    ],
  ];

  try {
    assert.equal((await runAuthorizationVerify("final")).code, 0);
    for (const [label, inject, revert, expected] of cases) {
      await withPool(adminPoolConfig(), async (pool) => {
        await pool.query(inject);
      });
      const result = await runAuthorizationVerify("final");
      assert.notEqual(result.code, 0, `must reject: ${label}`);
      assert.match(result.stderr, expected, `wrong detail for: ${label}`);
      await withPool(adminPoolConfig(), async (pool) => {
        await pool.query(revert);
      });
      assert.equal(
        (await runAuthorizationVerify("final")).code,
        0,
        `state must be clean again after ${label}`,
      );
    }
  } finally {
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

test("large object creation entry points are closed for the runtime login", async () => {
  // 只封堵已有 LO 的对象权限是不够的：只要 lo_create / lo_creat /
  // lo_from_bytea 还开着，runtime 就能自己造出一个不受 schema ACL 与 RLS
  // 约束的存储面。
  const entryPoints = [
    "SELECT lo_create(0)",
    "SELECT lo_creat(-1)",
    "SELECT lo_from_bytea(0, 'x'::bytea)",
    "SELECT lo_import('/etc/hostname')",
  ];
  await withPool(runtimeLoginUrl(), async (pool) => {
    for (const statement of entryPoints) {
      assert.match(
        String(await attempt(pool, [statement], "meal_agent_app")),
        /permission denied/i,
        `meal_agent_app must not reach: ${statement}`,
      );
    }
    // 不进入业务角色（即 runtime login 自身）同样不行。
    for (const statement of entryPoints) {
      assert.match(
        String(await attempt(pool, [statement])),
        /permission denied/i,
        `meal_agent_runtime_login must not reach: ${statement}`,
      );
    }
  });
  await withPool(backupLoginUrl(), async (pool) => {
    for (const statement of entryPoints) {
      assert.match(
        String(await attempt(pool, [statement], "meal_agent_backup")),
        /permission denied/i,
        `meal_agent_backup must not reach: ${statement}`,
      );
    }
  });

  // 重新打开入口之后，收敛必须把它关回去。
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query(
      "GRANT EXECUTE ON FUNCTION pg_catalog.lo_creat(integer) TO PUBLIC",
    );
  });
  const reopened = await withPool(adminPoolConfig(), async (pool) => {
    const result = await pool.query<{ open: boolean }>(
      `SELECT has_function_privilege('meal_agent_app',
                'pg_catalog.lo_creat(integer)'::regprocedure, 'EXECUTE') AS open`,
    );
    return result.rows[0]?.open;
  });
  assert.equal(reopened, true, "the drift must actually reopen the entry point");
  await runBootstrap("acl");
  await withPool(adminPoolConfig(), async (pool) => {
    const result = await pool.query<{ open: boolean }>(
      `SELECT has_function_privilege('meal_agent_app',
                'pg_catalog.lo_creat(integer)'::regprocedure, 'EXECUTE') AS open`,
    );
    assert.equal(result.rows[0]?.open, false, "converge must close it again");
  });
  await runBootstrap("grants");
});

test("an abnormal grant from an independent grantor is converged and only manifest items are rebuilt", async () => {
  await withPool(adminPoolConfig(), async (pool) => {
    await pool.query("DROP ROLE IF EXISTS stage09a_sixth_grantor");
    await pool.query("CREATE ROLE stage09a_sixth_grantor NOLOGIN");
    // 基线已收回 PUBLIC 对 public 的 USAGE，独立 grantor 需要显式取得，
    // 否则它连表都解析不到。
    await pool.query("GRANT USAGE ON SCHEMA public TO stage09a_sixth_grantor");
    await pool.query(
      "GRANT SELECT, INSERT ON public.users TO stage09a_sixth_grantor " +
        "WITH GRANT OPTION",
    );
    const client = await pool.connect();
    try {
      await client.query(
        "SELECT set_config('role', 'stage09a_sixth_grantor', false)",
      );
      // 一条完全不该存在的授权，和一条 manifest 允许但带 grant option 的授权。
      await client.query("GRANT INSERT ON public.users TO meal_agent_backup");
      await client.query(
        "GRANT SELECT ON public.users TO meal_agent_app WITH GRANT OPTION",
      );
    } finally {
      client.release();
    }
  });

  const grantors = await withPool(adminPoolConfig(), async (pool) => {
    const result = await pool.query<{ entry: string }>(
      `SELECT pg_catalog.pg_get_userbyid(acl.grantor) || ':'
              || pg_catalog.pg_get_userbyid(acl.grantee) || ':'
              || acl.privilege_type
              || CASE WHEN acl.is_grantable THEN '*' ELSE '' END AS entry
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
              aclexplode(c.relacl) AS acl
        WHERE n.nspname = 'public' AND c.relname = 'users'
          AND pg_catalog.pg_get_userbyid(acl.grantor) = 'stage09a_sixth_grantor'
        ORDER BY entry`,
    );
    return result.rows.map((row) => row.entry);
  });
  assert.deepEqual(grantors, [
    "stage09a_sixth_grantor:meal_agent_app:SELECT*",
    "stage09a_sixth_grantor:meal_agent_backup:INSERT",
  ]);

  try {
    await runBootstrap("grants");
    assert.equal((await runAuthorizationVerify("final")).code, 0);

    await withPool(adminPoolConfig(), async (pool) => {
      const left = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
                aclexplode(c.relacl) AS acl
          WHERE n.nspname = 'public' AND c.relname = 'users'
            AND pg_catalog.pg_get_userbyid(acl.grantee)
                  = ANY (ARRAY['meal_agent_app', 'meal_agent_backup'])
            AND (acl.is_grantable
                 OR (pg_catalog.pg_get_userbyid(acl.grantee)
                       = 'meal_agent_backup'
                     AND acl.privilege_type <> 'SELECT'))`,
      );
      assert.equal(
        left.rows[0]?.count,
        "0",
        "the abnormal grant and the grant option must both be gone",
      );
      // manifest 允许的那一份仍在，只是不再 grantable。
      const kept = await pool.query<{ ok: boolean }>(
        `SELECT has_table_privilege('meal_agent_app', 'public.users', 'SELECT')
                AS ok`,
      );
      assert.equal(kept.rows[0]?.ok, true, "allowed grants must be rebuilt");
    });
  } finally {
    await withPool(adminPoolConfig(), async (pool) => {
      await pool.query("DROP OWNED BY stage09a_sixth_grantor");
      await pool.query(
        "REVOKE ALL ON SCHEMA public FROM stage09a_sixth_grantor CASCADE",
      );
      await pool.query("DROP ROLE IF EXISTS stage09a_sixth_grantor");
    });
    await runBootstrap("acl");
    await runBootstrap("grants");
  }
});

// ---------------------------------------------------------------------------
// 阶段 09A / M2A 第八轮 A（最终修订）：**只读**授权 catalog 投影。
//
// 本轮不实现 ACL convergence。这些用例只证明一件事：所有权限状态都能被完整、
// 确定地**观察**出来。
//
// 三条方法学约束（上一版不满足，本版逐条修正）：
//
//   1. 投影通过 `pg` 的**三列结构化结果**读取。psql 的 `|` 分隔文本在含 `|`、
//      引号或换行的合法名字上会错位，而「特殊名称不会错位」正是要证明的事情
//      之一，因此不能用会被同一问题污染的读法去证明它。
//   2. 断言按解析后的 `(kind, identity, detail)` 做**严格等值与行数**判断，
//      不用 `some(row.includes(...))`，也不用截断 identity 前缀——那两种写法会
//      让 `privs=SELECT` 误配 `privs=SELECT,UPDATE`，也会让 grantor 错误被放过。
//   3. 清理由**独立 catalog 查询**验证；投影自身回到 baseline 只是附加证据。
// ---------------------------------------------------------------------------

interface ProjectionRow {
  readonly kind: string;
  readonly identity: string;
  readonly detail: string;
}

const projectionSqlPath = generatedSql("authorization-projection.generated.sql");

/** 在**既有连接**上执行投影，返回结构化三列。 */
const projectionOn = async (
  client: PoolClient,
): Promise<readonly ProjectionRow[]> => {
  const sql = await readFile(projectionSqlPath, "utf8");
  const result = await client.query<ProjectionRow>(sql);
  return result.rows.map(({ kind, identity, detail }) => ({
    kind,
    identity,
    detail,
  }));
};

const authorizationProjection = async (
  database: string = rolesDatabase,
): Promise<readonly ProjectionRow[]> =>
  withPool(adminPoolConfig(database), async (pool) => {
    const client = await pool.connect();
    try {
      return await projectionOn(client);
    } finally {
      client.release();
    }
  });

const rowsFor = (
  rows: readonly ProjectionRow[],
  kind: string,
  identity: string,
): readonly ProjectionRow[] =>
  rows.filter((row) => row.kind === kind && row.identity === identity);

/** 该 `(kind, identity)` 必须**恰好一行**，且 detail 逐字相等。 */
const assertExactRow = (
  rows: readonly ProjectionRow[],
  expected: ProjectionRow,
  label: string,
): void => {
  assert.deepEqual(
    rowsFor(rows, expected.kind, expected.identity),
    [expected],
    `${label}: the projection must contain exactly this row`,
  );
};

const assertNoRow = (
  rows: readonly ProjectionRow[],
  kind: string,
  identity: string,
  label: string,
): void => {
  assert.deepEqual(rowsFor(rows, kind, identity), [], label);
};

const aclRow = (
  objectKey: readonly ProjectionIdentityPart[],
  grantee: string,
  grantor: string,
  privilege: string,
  grantable: boolean,
): ProjectionRow => ({
  kind: "acl",
  identity: encodeProjectionIdentity([objectKey, grantee, grantor, privilege]),
  detail: `grantable=${grantable ? "t" : "f"}`,
});

const effectiveRow = (
  objectKey: readonly ProjectionIdentityPart[],
  role: string,
  privileges: readonly string[],
): ProjectionRow => ({
  kind: "effective",
  identity: encodeProjectionIdentity([objectKey, role]),
  detail: `privs=${privileges.join(",")}`,
});

const ownerRow = (
  objectKey: readonly ProjectionIdentityPart[],
  owner: string,
): ProjectionRow => ({
  kind: "owner",
  identity: encodeProjectionIdentity(objectKey),
  detail: `owner=${owner}`,
});

const defaultEffectiveRow = (
  defaclrole: string,
  objtype: string,
  scope: string,
  grantee: string,
  grantor: string,
  privilege: string,
  grantable: boolean,
): ProjectionRow => ({
  kind: "default-effective",
  identity: encodeProjectionIdentity([
    defaclrole,
    objtype,
    scope,
    grantee,
    grantor,
    privilege,
  ]),
  detail: `grantable=${grantable ? "t" : "f"}`,
});

const defaultPhysicalRow = (
  defaclrole: string,
  objtype: string,
  scope: string,
  scopeKind: "global" | "schema",
  empty: boolean,
): ProjectionRow => ({
  kind: "default-row",
  identity: encodeProjectionIdentity([defaclrole, objtype, scope, scopeKind]),
  detail: `exists=t empty=${empty ? "t" : "f"}`,
});

/** 某个 `(defaclrole, objtype, scope, grantee)` 在 default-effective 里的权限集合。 */
const defaultEffectivePrivileges = (
  rows: readonly ProjectionRow[],
  defaclrole: string,
  objtype: string,
  scope: string,
  grantee: string,
): readonly string[] =>
  rows
    .filter((row) => row.kind === "default-effective")
    .flatMap((row) => {
      const parsed: unknown = JSON.parse(row.identity);
      if (!Array.isArray(parsed) || parsed.length !== 6) {
        return [];
      }
      const [role, type, rowScope, rowGrantee, , privilege] = parsed as string[];
      return role === defaclrole &&
        type === objtype &&
        rowScope === scope &&
        rowGrantee === grantee &&
        privilege !== undefined
        ? [privilege]
        : [];
    })
    .sort(byCodeUnit);

const migratorRole = "meal_agent_migrator";

const gucSnapshot = async (
  client: PoolClient,
): Promise<{ readonly searchPath: string; readonly quoting: string }> => {
  const searchPath = await client.query<{ search_path: string }>(
    "SHOW search_path",
  );
  const quoting = await client.query<{ quote_all_identifiers: string }>(
    "SHOW quote_all_identifiers",
  );
  return {
    searchPath: searchPath.rows[0]?.search_path ?? "",
    quoting: quoting.rows[0]?.quote_all_identifiers ?? "",
  };
};

test("the projection is structurally read, round-trips its identities and never touches session GUCs", async () => {
  await withPool(adminPoolConfig(), async (pool) => {
    const client = await pool.connect();
    try {
      const baseline = await projectionOn(client);
      assert.ok(baseline.length > 300, "the projection must be non-trivial");

      // 1. 每个 identity 都是合法 JSON 数组，且 Node 侧 encodeProjectionIdentity
      //    与 PostgreSQL 的 jsonb_build_array(...)::text **逐字节相同**。
      for (const row of baseline) {
        const parsed: unknown = JSON.parse(row.identity);
        assert.ok(
          Array.isArray(parsed),
          `identity must be a JSON array: ${row.kind} ${row.identity}`,
        );
        assert.equal(
          encodeProjectionIdentity(parsed as readonly ProjectionIdentityPart[]),
          row.identity,
          `Node and PostgreSQL must encode ${row.kind} identically`,
        );
        assert.match(
          row.detail,
          /^(grantable|privs|owner|exists|class|acldefault-objtype)=/,
          `unexpected detail shape for ${row.kind} ${row.identity}`,
        );
      }

      // 2. 覆盖面：每一个必须存在的 kind 都真的有行（default-row 在内）。
      const kinds = new Set(baseline.map((row) => row.kind));
      for (const kind of [
        "acl",
        "default-effective",
        "default-row",
        "effective",
        "owner",
        "role",
        "type-class",
      ]) {
        assert.ok(kinds.has(kind), `projection kind ${kind} must be present`);
      }
      // 未知 objtype 是 fail-closed 标记；健康库里恒为空。
      assert.deepEqual(
        baseline.filter((row) => row.kind === "default-unmapped"),
        [],
        "a healthy database has no unmapped pg_default_acl objtype",
      );

      // 3. 两组不同的会话 GUC 下，投影逐行相同：identity 不经过
      //    pg_get_function_identity_arguments / format_type，因此不受 GUC 影响。
      const underGuc: ProjectionRow[][] = [];
      for (const [searchPath, quoting] of [
        ["pg_catalog, public", "on"],
        ["public, meal_agent_private, drizzle", "off"],
      ] as const) {
        await client.query(`SET search_path = ${searchPath}`);
        await client.query(`SET quote_all_identifiers = ${quoting}`);
        const before = await gucSnapshot(client);
        underGuc.push([...(await projectionOn(client))]);
        // 4. 投影不含任何 SET / set_config，因此调用方会话必须原样保留。
        assert.deepEqual(
          await gucSnapshot(client),
          before,
          `the projection must not change session GUCs (${searchPath})`,
        );
      }
      assert.deepEqual(
        underGuc[0],
        underGuc[1],
        "the projection must be byte-identical under different session GUCs",
      );
      assert.deepEqual(underGuc[0], [...baseline]);

      // 5. language：implicit / raw / effective 三者的真实结果。
      //    plpgsql 是受信语言且 lanacl IS NULL——物理上没有任何 aclitem，规范化
      //    语义却是「PUBLIC 与 owner 都有 USAGE」，这正是 acl kind 展开隐式默认
      //    权限的意义。
      const languageAcl = await client.query<{ entry: string }>(
        `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(acl.grantee)::text END
                || ':' || acl.privilege_type AS entry
           FROM pg_catalog.pg_language l,
                aclexplode(acldefault('l', l.lanowner)) AS acl
          WHERE l.lanname = 'plpgsql' AND l.lanacl IS NULL`,
      );
      assert.deepEqual(
        languageAcl.rows.map((row) => row.entry).sort(byCodeUnit),
        ["PUBLIC:USAGE", "postgres:USAGE"],
        "plpgsql must have a NULL lanacl with implicit PUBLIC USAGE",
      );
      assertExactRow(
        baseline,
        aclRow(["language", "plpgsql"], "PUBLIC", "postgres", "USAGE", false),
        "implicit PUBLIC USAGE on plpgsql",
      );
      assertExactRow(
        baseline,
        effectiveRow(["language", "plpgsql"], "meal_agent_app", ["USAGE"]),
        "effective USAGE on plpgsql",
      );
      // 非受信语言（C）的真实语义与直觉相反：acldefault 与受信语言完全相同，
      // PUBLIC 同样拿到隐式 USAGE，非受信的限制在 CREATE FUNCTION 时按 superuser
      // 判定。因此 raw 与 effective 必须**一致地**报告它，任何一层按 lanpltrusted
      // 过滤都会制造自相矛盾的两层结论。
      const untrusted = await client.query<{
        lanacl: string | null;
        trusted: boolean;
        implicit: string;
        app_usage: boolean;
      }>(
        `SELECT l.lanacl::text AS lanacl, l.lanpltrusted AS trusted,
                acldefault('l', l.lanowner)::text AS implicit,
                has_language_privilege('meal_agent_app', l.oid, 'USAGE')
                  AS app_usage
           FROM pg_catalog.pg_language l WHERE l.lanname = 'c'`,
      );
      assert.deepEqual(untrusted.rows[0], {
        lanacl: null,
        trusted: false,
        implicit: "{=U/postgres,postgres=U/postgres}",
        app_usage: true,
      });
      assertExactRow(
        baseline,
        aclRow(["language", "c"], "PUBLIC", "postgres", "USAGE", false),
        "an untrusted language still carries implicit PUBLIC USAGE",
      );
      assertExactRow(
        baseline,
        effectiveRow(["language", "c"], "meal_agent_app", ["USAGE"]),
        "effective must agree with the implicit ACL of an untrusted language",
      );
    } finally {
      client.release();
    }
  });
});

test("only the database identity is portable; the rest of the projection is environment bound", async () => {
  const probes = [
    "meal_agent_stage09a_ident_a",
    "meal_agent_stage09a_ident_b",
  ] as const;
  let largeObjectId = "";
  try {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      for (const probe of probes) {
        await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
        await pool.query(`CREATE DATABASE ${probe}`);
      }
    });

    // 两个合法的 meal_agent_<suffix> 数据库：database identity 必须是同一个
    // 逻辑键，库名不进入 identity。identity 一律解析后按结构比较，不做前缀匹配。
    for (const probe of probes) {
      const rows = await authorizationProjection(probe);
      assertExactRow(
        rows,
        ownerRow(["database", projectionDatabaseKey], "postgres"),
        `${probe} database owner`,
      );
      const databaseAcl = rows.filter((row) => {
        if (row.kind !== "acl") {
          return false;
        }
        const [key] = JSON.parse(row.identity) as readonly unknown[];
        return Array.isArray(key) && key[0] === "database";
      });
      assert.ok(
        databaseAcl.length > 0,
        `${probe} must project its database ACL under the logical key`,
      );
      for (const row of databaseAcl) {
        const [key] = JSON.parse(row.identity) as readonly unknown[];
        assert.deepEqual(
          key,
          ["database", projectionDatabaseKey],
          `${probe} must not put its real database name into the identity`,
        );
      }
      assert.ok(
        !rows.some((row) => row.identity.includes(probe)),
        `${probe} must not leak its own database name into any identity`,
      );
    }

    // 但**不得**据此声称整份投影跨库固定：往其中一个库里放一个 Large Object，
    // 它的 identity 带 OID，另一个库根本没有这一行。
    largeObjectId = await withPool(
      adminPoolConfig(probes[0]),
      async (pool) => {
        const created = await pool.query<{ loid: string }>(
          "SELECT lo_from_bytea(0, 'stage09a-identity'::bytea)::text AS loid",
        );
        const loid = created.rows[0]?.loid;
        assert.ok(loid !== undefined);
        return loid;
      },
    );
    const withLargeObject = await authorizationProjection(probes[0]);
    const withoutLargeObject = await authorizationProjection(probes[1]);
    assertExactRow(
      withLargeObject,
      {
        kind: "large-object",
        identity: encodeProjectionIdentity(["largeobject", largeObjectId]),
        detail: "owner=postgres",
      },
      "the large object is visible in the database that owns it",
    );
    assert.deepEqual(
      withoutLargeObject.filter((row) => row.kind === "large-object"),
      [],
      "the sibling database has no large object row",
    );
    assert.notDeepEqual(
      withLargeObject,
      withoutLargeObject,
      "the projection as a whole is environment bound, not a portable snapshot",
    );
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      for (const probe of probes) {
        await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      }
    });
  }
});

test("default privilege composition matches the ACL of really created objects", async () => {
  const probe = "meal_agent_stage09a_defaults";
  const reader = "stage09a_defaults_reader";
  const schema = "meal_agent_private";
  try {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      await pool.query(`CREATE DATABASE ${probe}`);
      await pool.query(`DROP ROLE IF EXISTS ${reader}`);
      await pool.query(`CREATE ROLE ${reader} NOLOGIN`);
    });
    await mustSucceedCli(
      "pnpm db:bootstrap (default-acl probe)",
      await runPnpm("db:bootstrap", adminUrl(probe)),
    );
    // owner 交接必须在任何注入之前完成：之后 migrator 才是 public 的 owner，
    // 「同一个 owner 在两个 scope 下建对象」这件事才成立。
    await runBootstrap("handoff", probe);

    // ---------------------------------------------------------------------
    // 1. **非空** global 行**替换**内建默认，而不是与之合并。
    // ---------------------------------------------------------------------
    await withPool(adminPoolConfig(probe), async (pool) => {
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} ` +
          `REVOKE TRUNCATE ON TABLES FROM ${migratorRole}`,
      );
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${migratorRole}`);
        await client.query(`CREATE TABLE ${schema}.d1 (id int)`);
      } finally {
        client.release();
      }
    });

    let rows = await authorizationProjection(probe);
    const realTablePrivileges = await withPool(
      adminPoolConfig(probe),
      async (pool) => {
        const result = await pool.query<{ privilege: string }>(
          `SELECT p AS privilege
             FROM unnest(ARRAY['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES',
                               'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']) AS p
            WHERE has_table_privilege($1, '${schema}.d1', p)
            ORDER BY p COLLATE "C"`,
          [migratorRole],
        );
        return result.rows.map((row) => row.privilege);
      },
    );
    // 独立事实：TRUNCATE 真的没了，MAINTAIN 真的还在。
    assert.ok(
      !realTablePrivileges.includes("TRUNCATE"),
      "the non-empty global row must really remove TRUNCATE",
    );
    assert.ok(realTablePrivileges.includes("MAINTAIN"));
    assert.deepEqual(
      defaultEffectivePrivileges(rows, migratorRole, "r", schema, migratorRole),
      realTablePrivileges,
      "default-effective must equal the privileges of the real new table",
    );
    assertExactRow(
      rows,
      defaultPhysicalRow(migratorRole, "r", "-", "global", false),
      "the non-empty global table row exists",
    );

    // ---------------------------------------------------------------------
    // 2. **空** global 行等价于「没有行」，但 default-row 仍能区分两者。
    // ---------------------------------------------------------------------
    await withPool(adminPoolConfig(probe), async (pool) => {
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} ` +
          `REVOKE ALL ON FUNCTIONS FROM ${migratorRole}, PUBLIC`,
      );
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${migratorRole}`);
        await client.query(
          `CREATE FUNCTION ${schema}.d2() RETURNS int LANGUAGE sql ` +
            "IMMUTABLE AS $$SELECT 1$$",
        );
      } finally {
        client.release();
      }
    });

    rows = await authorizationProjection(probe);
    const functionFacts = await withPool(adminPoolConfig(probe), async (pool) => {
      const result = await pool.query<{
        proacl: string | null;
        owner: string;
        public_execute: boolean;
        owner_execute: boolean;
      }>(
        `SELECT p.proacl::text AS proacl,
                pg_catalog.pg_get_userbyid(p.proowner)::text AS owner,
                has_function_privilege('public', p.oid, 'EXECUTE')
                  AS public_execute,
                has_function_privilege($1, p.oid, 'EXECUTE') AS owner_execute
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $2 AND p.proname = 'd2'`,
        [migratorRole, schema],
      );
      return result.rows[0];
    });
    // 独立事实：新函数落回内建默认——proacl 是 NULL，PUBLIC 仍有 EXECUTE。
    assert.deepEqual(functionFacts, {
      proacl: null,
      owner: migratorRole,
      public_execute: true,
      owner_execute: true,
    });
    // 物理行**存在且为空**，与「根本没有这一行」在投影里是两条不同的事实。
    assertExactRow(
      rows,
      defaultPhysicalRow(migratorRole, "f", "-", "global", true),
      "the empty global function row still exists physically",
    );
    assertNoRow(
      rows,
      "default-row",
      encodeProjectionIdentity([migratorRole, "T", "-", "global"]),
      "no type row was ever created, so no physical row may be reported",
    );
    // 但两者的**有效**默认权限相同：都落回内建默认。
    assert.deepEqual(
      defaultEffectivePrivileges(rows, migratorRole, "f", schema, "PUBLIC"),
      ["EXECUTE"],
      "an empty global row must behave exactly like a missing row",
    );
    assert.deepEqual(
      defaultEffectivePrivileges(rows, migratorRole, "T", schema, "PUBLIC"),
      ["USAGE"],
      "the missing type row falls back to the builtin default as well",
    );
    // 新函数的规范化直接授权与 owner 也必须与真实 catalog 一致。
    const routineKey: readonly ProjectionIdentityPart[] = [
      "routine",
      schema,
      "d2",
      [],
    ];
    assertExactRow(
      rows,
      aclRow(routineKey, "PUBLIC", migratorRole, "EXECUTE", false),
      "the new function's implicit PUBLIC EXECUTE",
    );
    assertExactRow(
      rows,
      ownerRow(routineKey, migratorRole),
      "the new function's owner",
    );

    // ---------------------------------------------------------------------
    // 3. **空** global sequence 行：内建默认必须是 sequence 的默认，不是
    //    FOREIGN SERVER 的。acldefault 的 objtype 是 `s`，pg_default_acl 的是 `S`。
    // ---------------------------------------------------------------------
    await withPool(adminPoolConfig(probe), async (pool) => {
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} ` +
          `REVOKE ALL ON SEQUENCES FROM ${migratorRole}`,
      );
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${migratorRole}`);
        await client.query(`CREATE SEQUENCE ${schema}.d3`);
      } finally {
        client.release();
      }
    });

    rows = await authorizationProjection(probe);
    const realSequencePrivileges = await withPool(
      adminPoolConfig(probe),
      async (pool) => {
        const result = await pool.query<{ privilege: string }>(
          `SELECT p AS privilege
             FROM unnest(ARRAY['SELECT', 'UPDATE', 'USAGE']) AS p
            WHERE has_sequence_privilege($1, '${schema}.d3', p)
            ORDER BY p COLLATE "C"`,
          [migratorRole],
        );
        return result.rows.map((row) => row.privilege);
      },
    );
    assert.deepEqual(
      realSequencePrivileges,
      ["SELECT", "UPDATE", "USAGE"],
      "a sequence created under an empty global row keeps the builtin default",
    );
    assertExactRow(
      rows,
      defaultPhysicalRow(migratorRole, "S", "-", "global", true),
      "the empty global sequence row exists",
    );
    assert.deepEqual(
      defaultEffectivePrivileges(rows, migratorRole, "S", schema, migratorRole),
      realSequencePrivileges,
      "default-effective must not degrade a sequence to a FOREIGN SERVER",
    );

    // ---------------------------------------------------------------------
    // 4. global 非 grantable SELECT + schema `WITH GRANT OPTION`：同一 identity
    //    只出**一行**，grantable 取真实聚合值。
    // ---------------------------------------------------------------------
    await withPool(adminPoolConfig(probe), async (pool) => {
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} ` +
          `GRANT SELECT ON TABLES TO ${reader}`,
      );
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${schema} ` +
          `GRANT SELECT ON TABLES TO ${reader} WITH GRANT OPTION`,
      );
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${migratorRole}`);
        await client.query(`CREATE TABLE ${schema}.d4 (id int)`);
        await client.query("CREATE TABLE public.d5 (id int)");
      } finally {
        client.release();
      }
    });

    rows = await authorizationProjection(probe);
    const realGrants = await withPool(adminPoolConfig(probe), async (pool) => {
      const result = await pool.query<{ entry: string }>(
        `SELECT c.relname || ':' || acl.privilege_type || ':'
                || CASE WHEN acl.is_grantable THEN 't' ELSE 'f' END AS entry
           FROM pg_catalog.pg_class c,
                aclexplode(c.relacl) AS acl
          WHERE c.oid = ANY (ARRAY['${schema}.d4'::regclass,
                                   'public.d5'::regclass])
            AND pg_catalog.pg_get_userbyid(acl.grantee) = $1
          ORDER BY entry`,
        [reader],
      );
      return result.rows.map((row) => row.entry);
    });
    // 独立事实：schema 内的新表拿到 grantable SELECT，且**只有一条**；
    // schema 外的新表只有 global 的非 grantable SELECT。
    assert.deepEqual(realGrants, ["d4:SELECT:t", "d5:SELECT:f"]);
    assertExactRow(
      rows,
      defaultEffectiveRow(
        migratorRole,
        "r",
        schema,
        reader,
        migratorRole,
        "SELECT",
        true,
      ),
      "the overlay collapses to a single grantable SELECT",
    );
    assertExactRow(
      rows,
      defaultEffectiveRow(
        migratorRole,
        "r",
        "public",
        reader,
        migratorRole,
        "SELECT",
        false,
      ),
      "a scope without a schema row keeps the non-grantable global SELECT",
    );
    // 两条 raw 层事实也必须分别可见，且 schema 层确实带 grant option。
    assertExactRow(
      rows,
      {
        kind: "default-global",
        identity: encodeProjectionIdentity([
          migratorRole,
          "r",
          "-",
          reader,
          migratorRole,
          "SELECT",
        ]),
        detail: "grantable=f",
      },
      "raw global default privilege",
    );
    assertExactRow(
      rows,
      {
        kind: "default-schema",
        identity: encodeProjectionIdentity([
          migratorRole,
          "r",
          schema,
          reader,
          migratorRole,
          "SELECT",
        ]),
        detail: "grantable=t",
      },
      "raw schema default privilege",
    );
    process.stdout.write(
      "default ACL parity: 4 PostgreSQL 18.4 scenarios matched real objects\n",
    );
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      await pool.query(`DROP ROLE IF EXISTS ${reader}`);
    });
  }
});

test("the read-only authorization projection observes every ACL subject", async () => {
  const baseline = await authorizationProjection();
  const outsider = "stage09a_r8a_outsider";
  const inheritor = "stage09a_r8a_inheritor";
  // 列级反例必须用一个**没有任何表级授权**的角色：inheritor 通过继承拿到了
  // 表级 SELECT/INSERT，用它证明不了「没有表级授权时列级仍可见」。
  const columnOnly = "stage09a_r8a_column";
  const object = (
    ...parts: readonly string[]
  ): readonly ProjectionIdentityPart[] => parts;
  const databaseObject = object("database", projectionDatabaseKey);

  const largeObjectId = await withPool(adminPoolConfig(), async (pool) => {
    const result = await pool.query<{ loid: string }>(
      "SELECT lo_from_bytea(0, 'stage09a-r8a'::bytea)::text AS loid",
    );
    const loid = result.rows[0]?.loid;
    assert.ok(loid !== undefined);
    return loid;
  });

  try {
    await withPool(adminPoolConfig(), async (pool) => {
      for (const statement of [
        `CREATE ROLE ${outsider} NOLOGIN`,
        `CREATE ROLE ${inheritor} LOGIN INHERIT`,
        `CREATE ROLE ${columnOnly} LOGIN`,
        `GRANT USAGE ON SCHEMA public TO ${outsider}`,
        // 1. 未知 grantee 拿到 database / schema / table / routine / type 权限
        `GRANT CONNECT ON DATABASE ${rolesDatabase} TO ${outsider}`,
        `GRANT USAGE ON SCHEMA meal_agent_private TO ${outsider}`,
        `GRANT SELECT ON public.households TO ${outsider}`,
        "GRANT EXECUTE ON FUNCTION meal_agent_private.app_user_id() " +
          `TO ${outsider}`,
        `GRANT USAGE ON TYPE public.users TO ${outsider}`,
        // 2. 只有列级授权，表级什么都没有
        `GRANT SELECT (display_name) ON public.users TO ${columnOnly}`,
        // 3. WITH GRANT OPTION
        `GRANT SELECT, INSERT ON public.users TO ${outsider} WITH GRANT OPTION`,
        // 4 + 5. default privilege 叠加与 default grant option
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} ` +
          `GRANT INSERT ON TABLES TO ${outsider}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA public ` +
          `GRANT SELECT ON TABLES TO ${outsider}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA public ` +
          "GRANT SELECT ON TABLES TO meal_agent_backup WITH GRANT OPTION",
        // 6. 外部非 superuser LOGIN 通过继承取得权限
        `GRANT ${outsider} TO ${inheritor}`,
        // 7. 非项目角色拥有的 Large Object 及其 ACL
        `ALTER LARGE OBJECT ${largeObjectId} OWNER TO ${outsider}`,
        `GRANT SELECT ON LARGE OBJECT ${largeObjectId} TO meal_agent_app`,
        `GRANT SELECT ON LARGE OBJECT ${largeObjectId} TO ${outsider}`,
        `GRANT UPDATE ON LARGE OBJECT ${largeObjectId} TO PUBLIC`,
        `GRANT EXECUTE ON FUNCTION pg_catalog.lo_creat(integer) TO ${outsider}`,
        // 8. final 阶段的 relation / routine / type owner 漂移
        `ALTER TABLE public.sessions OWNER TO ${outsider}`,
        `ALTER FUNCTION meal_agent_private.app_user_id() OWNER TO ${outsider}`,
      ]) {
        await pool.query(statement);
      }
      // 9. 第三方 grantor 授予一个「权限集合看似合规」的重复 SELECT。
      const client = await pool.connect();
      try {
        await client.query("SELECT set_config('role', $1, false)", [outsider]);
        await client.query("GRANT SELECT ON public.users TO meal_agent_app");
        await client.query(
          "GRANT INSERT ON public.users TO meal_agent_backup WITH GRANT OPTION",
        );
      } finally {
        client.release();
      }
    });

    const drifted = await authorizationProjection();
    // `ALTER … OWNER TO` 会把 ACL 里旧 owner 的 grantor/grantee 一并改写，因此
    // 归属漂移之后 app_user_id 的 EXECUTE 由新 owner 授予——这正是必须逐字断言
    // grantor、而不是截断 identity 的原因。
    const routineKey: readonly ProjectionIdentityPart[] = [
      "routine",
      "meal_agent_private",
      "app_user_id",
      [],
    ];
    const loEntryPoint: readonly ProjectionIdentityPart[] = [
      "routine",
      "pg_catalog",
      "lo_creat",
      [["pg_catalog", "int4"]],
    ];

    const expectations: readonly [string, ProjectionRow][] = [
      [
        "unknown grantee on the database",
        aclRow(databaseObject, outsider, migratorRole, "CONNECT", false),
      ],
      [
        "unknown grantee on a managed schema",
        aclRow(
          object("schema", "meal_agent_private"),
          outsider,
          migratorRole,
          "USAGE",
          false,
        ),
      ],
      [
        "unknown grantee on a table",
        aclRow(
          object("relation", "public", "households"),
          outsider,
          migratorRole,
          "SELECT",
          false,
        ),
      ],
      [
        "unknown grantee on a routine, granted by the drifted owner",
        aclRow(routineKey, outsider, outsider, "EXECUTE", false),
      ],
      [
        "unknown grantee on a type",
        aclRow(
          object("type", "public", "users"),
          outsider,
          migratorRole,
          "USAGE",
          false,
        ),
      ],
      [
        "third-party grantor duplicating a compliant-looking SELECT",
        aclRow(
          object("relation", "public", "users"),
          "meal_agent_app",
          outsider,
          "SELECT",
          false,
        ),
      ],
      [
        "the canonical SELECT is still a separate row",
        aclRow(
          object("relation", "public", "users"),
          "meal_agent_app",
          migratorRole,
          "SELECT",
          false,
        ),
      ],
      [
        "WITH GRANT OPTION",
        aclRow(
          object("relation", "public", "users"),
          "meal_agent_backup",
          outsider,
          "INSERT",
          true,
        ),
      ],
      [
        "a column-only grant is visible in the raw ACL",
        aclRow(
          object("column", "public", "users", "display_name"),
          columnOnly,
          migratorRole,
          "SELECT",
          false,
        ),
      ],
      [
        "a column-only grant is visible in the effective privileges",
        effectiveRow(
          object("column", "public", "users", "display_name"),
          columnOnly,
          ["SELECT"],
        ),
      ],
      [
        "raw global default privilege",
        {
          kind: "default-global",
          identity: encodeProjectionIdentity([
            migratorRole,
            "r",
            "-",
            outsider,
            migratorRole,
            "INSERT",
          ]),
          detail: "grantable=f",
        },
      ],
      [
        "raw schema default privilege",
        {
          kind: "default-schema",
          identity: encodeProjectionIdentity([
            migratorRole,
            "r",
            "public",
            outsider,
            migratorRole,
            "SELECT",
          ]),
          detail: "grantable=f",
        },
      ],
      [
        "the global default row's existence is preserved separately",
        defaultPhysicalRow(migratorRole, "r", "-", "global", false),
      ],
      [
        "global INSERT survives the overlay",
        defaultEffectiveRow(
          migratorRole,
          "r",
          "public",
          outsider,
          migratorRole,
          "INSERT",
          false,
        ),
      ],
      [
        "schema SELECT survives the overlay",
        defaultEffectiveRow(
          migratorRole,
          "r",
          "public",
          outsider,
          migratorRole,
          "SELECT",
          false,
        ),
      ],
      [
        "default SELECT WITH GRANT OPTION collapses to one grantable row",
        defaultEffectiveRow(
          migratorRole,
          "r",
          "public",
          "meal_agent_backup",
          migratorRole,
          "SELECT",
          true,
        ),
      ],
      [
        "external LOGIN inheriting privileges",
        effectiveRow(object("relation", "public", "households"), inheritor, [
          "SELECT",
        ]),
      ],
      [
        "external LOGIN reaching a large object entry point",
        effectiveRow(loEntryPoint, inheritor, ["EXECUTE"]),
      ],
      [
        "a large object owned by a non-project role",
        {
          kind: "large-object",
          identity: encodeProjectionIdentity(["largeobject", largeObjectId]),
          detail: `owner=${outsider}`,
        },
      ],
      [
        "large object ACL granted to PUBLIC",
        aclRow(
          object("largeobject", largeObjectId),
          "PUBLIC",
          outsider,
          "UPDATE",
          false,
        ),
      ],
      [
        "large object direct privilege for a project role",
        effectiveRow(object("largeobject", largeObjectId), "meal_agent_app", [
          "SELECT",
          "UPDATE",
        ]),
      ],
      [
        "large object privilege reached through role inheritance",
        effectiveRow(object("largeobject", largeObjectId), inheritor, [
          "SELECT",
          "UPDATE",
        ]),
      ],
      [
        "relation owner drift",
        ownerRow(object("relation", "public", "sessions"), outsider),
      ],
      ["routine owner drift", ownerRow(routineKey, outsider)],
      [
        "type owner drift follows the relation",
        ownerRow(object("type", "public", "sessions"), outsider),
      ],
      [
        "array types are flagged as delegating, not independently grantable",
        {
          kind: "type-class",
          identity: encodeProjectionIdentity(
            object("type", "public", "_households"),
          ),
          detail: `class=array delegates-to=${encodeProjectionIdentity([
            "public",
            "households",
          ])}`,
        },
      ],
      [
        "row types are flagged as directly grantable",
        {
          kind: "type-class",
          identity: encodeProjectionIdentity(
            object("type", "public", "households"),
          ),
          detail: "class=row grantable-directly=t",
        },
      ],
    ];
    for (const [label, expected] of expectations) {
      assertExactRow(drifted, expected, label);
    }

    // 列级角色**没有**任何表级有效权限：投影对空权限集不产生行，因此这一条只能
    // 用「该 identity 不存在」表达，不能写成 privs= 空串。
    assertNoRow(
      drifted,
      "effective",
      encodeProjectionIdentity([
        object("relation", "public", "users"),
        columnOnly,
      ]),
      "a column-only grantee must have no table-level effective privilege",
    );

    // 独立 catalog 事实：上面每一类断言都必须能被投影之外的查询复现。
    await withPool(adminPoolConfig(), async (pool) => {
      const owners = await pool.query<{ entry: string }>(
        `SELECT 'relation:' || pg_catalog.pg_get_userbyid(c.relowner) AS entry
           FROM pg_catalog.pg_class c WHERE c.oid = 'public.sessions'::regclass
         UNION ALL
         SELECT 'routine:' || pg_catalog.pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc p
          WHERE p.oid = 'meal_agent_private.app_user_id()'::regprocedure
         UNION ALL
         SELECT 'largeobject:' || pg_catalog.pg_get_userbyid(m.lomowner)
           FROM pg_catalog.pg_largeobject_metadata m WHERE m.oid = $1
         ORDER BY 1`,
        [largeObjectId],
      );
      assert.deepEqual(owners.rows.map((row) => row.entry), [
        `largeobject:${outsider}`,
        `relation:${outsider}`,
        `routine:${outsider}`,
      ]);
      const effective = await pool.query<{
        column_only: boolean;
        table_level: boolean;
        lo_select: boolean;
        lo_update: boolean;
      }>(
        `SELECT has_column_privilege($1, 'public.users', 'display_name',
                                     'SELECT') AS column_only,
                has_table_privilege($1, 'public.users', 'SELECT')
                  AS table_level,
                has_largeobject_privilege($2, $3, 'SELECT') AS lo_select,
                has_largeobject_privilege($2, $3, 'UPDATE') AS lo_update`,
        [columnOnly, inheritor, largeObjectId],
      );
      // 列级授权成立、表级不成立——这正是「只看表级会整类漏掉」的证据；
      // Large Object 的两项则来自 inheritor 的角色继承与 PUBLIC。
      assert.deepEqual(effective.rows[0], {
        column_only: true,
        table_level: false,
        lo_select: true,
        lo_update: true,
      });
    });

    // 外部 NOLOGIN 的边界必须写清并断言：raw 直接 ACL 可见，但它**不在** effective
    // 探测范围内（探测集合 = PUBLIC + 全部非 superuser LOGIN + meal_agent 前缀）。
    assertNoRow(
      drifted,
      "role",
      encodeProjectionIdentity([outsider]),
      "an external NOLOGIN role is not an effective probe subject",
    );
    assert.deepEqual(
      drifted.filter(
        (row) =>
          row.kind === "effective" &&
          (JSON.parse(row.identity) as readonly unknown[])[1] === outsider,
      ),
      [],
      "an external NOLOGIN role must not appear in effective probes",
    );
    assertExactRow(
      drifted,
      {
        kind: "role",
        identity: encodeProjectionIdentity([inheritor]),
        detail: "class=login",
      },
      "every non-superuser LOGIN is probed",
    );
    assertExactRow(
      drifted,
      {
        kind: "role",
        identity: encodeProjectionIdentity(["meal_agent_app"]),
        detail: "class=nologin",
      },
      "project NOLOGIN roles are probed",
    );

    // 数组类型没有独立 ACL 行：PostgreSQL 直接拒绝对它们授权或改属。
    // 「哪些是数组类型」取自 type-class 行本身，不按名字前缀猜——`_` 开头的名字
    // 也可能是一张真实表的行类型（drizzle.__meal_agent_migrations 就是）。
    const arrayTypes = new Set(
      drifted
        .filter(
          (row) =>
            row.kind === "type-class" && row.detail.startsWith("class=array"),
        )
        .map((row) => row.identity),
    );
    assert.ok(arrayTypes.size >= 10, "the managed schemas do have array types");
    const arrayTypeAcl = drifted.filter((row) => {
      if (row.kind !== "acl") {
        return false;
      }
      const [key] = JSON.parse(row.identity) as readonly unknown[];
      return (
        Array.isArray(key) &&
        key[0] === "type" &&
        arrayTypes.has(encodeProjectionIdentity(key as readonly string[]))
      );
    });
    assert.deepEqual(
      arrayTypeAcl,
      [],
      "array types must not be projected as independently grantable",
    );
    const arrayGrant = await withPool(adminPoolConfig(), async (pool) =>
      attempt(pool, ["GRANT USAGE ON TYPE public._households TO PUBLIC"]),
    );
    assert.match(
      arrayGrant ?? "",
      /cannot set privileges of array types/,
      "PostgreSQL itself refuses to grant on an array type",
    );

    // row type 的 PUBLIC USAGE：全新安装后 typacl 已经是
    // {meal_agent_migrator=U/meal_agent_migrator}，PUBLIC 不在其中。本轮只如实
    // 报告这一状态，不收敛（R8B 待裁定）。
    assertExactRow(
      drifted,
      aclRow(
        object("type", "public", "households"),
        migratorRole,
        migratorRole,
        "USAGE",
        false,
      ),
      "the row type's own ACL",
    );
    assertNoRow(
      drifted,
      "acl",
      encodeProjectionIdentity([
        object("type", "public", "households"),
        "PUBLIC",
        migratorRole,
        "USAGE",
      ]),
      "a fresh install has no PUBLIC USAGE on the row type",
    );

    process.stdout.write(
      `authorization projection: ${String(expectations.length)} injected ` +
        `subjects asserted exactly across ${String(drifted.length)} rows\n`,
    );
  } finally {
    // 1. 核心对象的 owner 恢复**不允许**被吞掉：DROP OWNED BY 会删掉仍归属于
    //    该角色的对象，所以恢复失败必须立刻暴露，而不是继续往下走。
    await withPool(adminPoolConfig(), async (pool) => {
      await pool.query(
        `ALTER TABLE public.sessions OWNER TO ${migratorRole}`,
      );
      await pool.query(
        "ALTER FUNCTION meal_agent_private.app_user_id() " +
          `OWNER TO ${migratorRole}`,
      );
    });

    // 2. 独立 catalog 查询确认归属已经回到 migrator，**然后**才允许 DROP OWNED。
    await withPool(adminPoolConfig(), async (pool) => {
      const restored = await pool.query<{ entry: string }>(
        `SELECT 'relation:' || pg_catalog.pg_get_userbyid(c.relowner) AS entry
           FROM pg_catalog.pg_class c WHERE c.oid = 'public.sessions'::regclass
         UNION ALL
         SELECT 'routine:' || pg_catalog.pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc p
          WHERE p.oid = 'meal_agent_private.app_user_id()'::regprocedure
         UNION ALL
         SELECT 'type:' || pg_catalog.pg_get_userbyid(t.typowner)
           FROM pg_catalog.pg_type t WHERE t.oid = 'public.sessions'::regtype
         ORDER BY 1`,
      );
      assert.deepEqual(
        restored.rows.map((row) => row.entry),
        [
          `relation:${migratorRole}`,
          `routine:${migratorRole}`,
          `type:${migratorRole}`,
        ],
        "ownership must be restored before DROP OWNED BY is allowed to run",
      );
    });

    // 3. 现在才拆授权、default privilege、成员关系与 Large Object。
    await withPool(adminPoolConfig(), async (pool) => {
      for (const statement of [
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} ` +
          `REVOKE INSERT ON TABLES FROM ${outsider}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA public ` +
          `REVOKE SELECT ON TABLES FROM ${outsider}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA public ` +
          "REVOKE GRANT OPTION FOR SELECT ON TABLES FROM meal_agent_backup",
        `REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer) FROM ${outsider}`,
        `REVOKE SELECT (display_name) ON public.users FROM ${columnOnly}`,
        `ALTER LARGE OBJECT ${largeObjectId} OWNER TO postgres`,
        `SELECT lo_unlink(${largeObjectId})`,
        `REVOKE ${outsider} FROM ${inheritor}`,
        `DROP OWNED BY ${outsider}, ${inheritor}, ${columnOnly}`,
        `DROP ROLE IF EXISTS ${outsider}`,
        `DROP ROLE IF EXISTS ${inheritor}`,
        `DROP ROLE IF EXISTS ${columnOnly}`,
      ]) {
        await pool.query(statement);
      }
    });

    // 4. 清理证据由**独立查询**给出，不靠投影自证。
    await withPool(adminPoolConfig(), async (pool) => {
      const leftovers = await pool.query<{ what: string; count: string }>(
        `SELECT 'roles' AS what, count(*)::text AS count
           FROM pg_catalog.pg_roles WHERE rolname LIKE 'stage09a!_r8a!_%' ESCAPE '!'
         UNION ALL
         SELECT 'memberships', count(*)::text
           FROM pg_catalog.pg_auth_members a
           JOIN pg_catalog.pg_roles m ON m.oid = a.member
           JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
          WHERE m.rolname LIKE 'stage09a!_r8a!_%' ESCAPE '!'
             OR g.rolname LIKE 'stage09a!_r8a!_%' ESCAPE '!'
         UNION ALL
         SELECT 'relation-acl', count(*)::text FROM pg_catalog.pg_class
          WHERE relacl::text LIKE '%stage09a\\_r8a\\_%'
         UNION ALL
         SELECT 'column-acl', count(*)::text FROM pg_catalog.pg_attribute
          WHERE attacl::text LIKE '%stage09a\\_r8a\\_%'
         UNION ALL
         SELECT 'routine-acl', count(*)::text FROM pg_catalog.pg_proc
          WHERE proacl::text LIKE '%stage09a\\_r8a\\_%'
         UNION ALL
         SELECT 'schema-acl', count(*)::text FROM pg_catalog.pg_namespace
          WHERE nspacl::text LIKE '%stage09a\\_r8a\\_%'
         UNION ALL
         SELECT 'type-acl', count(*)::text FROM pg_catalog.pg_type
          WHERE typacl::text LIKE '%stage09a\\_r8a\\_%'
         UNION ALL
         SELECT 'database-acl', count(*)::text FROM pg_catalog.pg_database
          WHERE datacl::text LIKE '%stage09a\\_r8a\\_%'
         UNION ALL
         SELECT 'default-acl', count(*)::text FROM pg_catalog.pg_default_acl
          WHERE defaclacl::text LIKE '%stage09a\\_r8a\\_%'
         UNION ALL
         SELECT 'large-object', count(*)::text
           FROM pg_catalog.pg_largeobject_metadata WHERE oid = $1
         UNION ALL
         SELECT 'large-object-data', count(*)::text
           FROM pg_catalog.pg_largeobject WHERE loid = $1
         ORDER BY 1`,
        [largeObjectId],
      );
      assert.deepEqual(
        leftovers.rows.filter((row) => row.count !== "0"),
        [],
        "cleanup must leave no role, grant, default privilege or large object",
      );
      // 归属的正向断言：不是「没有 outsider」，而是「确实回到 migrator」。
      const restored = await pool.query<{ entry: string }>(
        `SELECT 'sessions:' || pg_catalog.pg_get_userbyid(c.relowner) AS entry
           FROM pg_catalog.pg_class c WHERE c.oid = 'public.sessions'::regclass
         UNION ALL
         SELECT 'app_user_id:' || pg_catalog.pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc p
          WHERE p.oid = 'meal_agent_private.app_user_id()'::regprocedure
         ORDER BY 1`,
      );
      assert.deepEqual(restored.rows.map((row) => row.entry), [
        `app_user_id:${migratorRole}`,
        `sessions:${migratorRole}`,
      ]);
    });

    // 5. 投影回到 baseline 只是**附加**证据。
    assert.deepEqual(
      await authorizationProjection(),
      baseline,
      "the projection must return to the exact baseline after cleanup",
    );
  }
});

test("the projection keeps identities unambiguous for names containing # @ | and quotes", async () => {
  const probe = "meal_agent_stage09a_odd";
  const oddRole = 'stage09a#r8a@odd|role"q"';
  const oddTable = 'stage09a|odd#tbl@x"y"';
  const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  try {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      await pool.query(`CREATE DATABASE ${probe}`);
      await pool.query(`CREATE ROLE ${quoted(oddRole)} NOLOGIN`);
    });
    await withPool(adminPoolConfig(probe), async (pool) => {
      await pool.query(`CREATE TABLE public.${quoted(oddTable)} (id int)`);
      await pool.query(
        `GRANT SELECT ON public.${quoted(oddTable)} TO ${quoted(oddRole)}`,
      );
    });

    const rows = await authorizationProjection(probe);
    const tableKey: readonly ProjectionIdentityPart[] = [
      "relation",
      "public",
      oddTable,
    ];
    // 1. 三列没有错位：identity 仍是合法 JSON，detail 仍是完整的 grantable=…。
    assertExactRow(
      rows,
      aclRow(tableKey, oddRole, "postgres", "SELECT", false),
      "a grant to a role whose name contains # @ | and quotes",
    );
    assertExactRow(
      rows,
      ownerRow(tableKey, "postgres"),
      "the odd table's owner",
    );

    // 2. Node 与 PostgreSQL 的编码逐字节相同——包括被 JSON 转义的双引号。
    const encoded = encodeProjectionIdentity([tableKey, oddRole]);
    assert.ok(
      encoded.includes('\\"'),
      "the identity must carry JSON-escaped quotes rather than raw ones",
    );
    const fromDatabase = await withPool(adminPoolConfig(probe), async (pool) => {
      const result = await pool.query<{ identity: string }>(
        `SELECT jsonb_build_array(
                  jsonb_build_array('relation', 'public', $1::text), $2::text
                )::text AS identity`,
        [oddTable, oddRole],
      );
      return result.rows[0]?.identity;
    });
    assert.equal(fromDatabase, encoded);

    // 3. identity 不碰撞：换一个只是分隔符位置不同的名字，identity 必须不同。
    assert.notEqual(
      encodeProjectionIdentity([["relation", "public", "a|b"], "c"]),
      encodeProjectionIdentity([["relation", "public", "a"], "b|c"]),
    );
  } finally {
    await withPool(adminPoolConfig("postgres"), async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS ${probe}`);
      await pool.query(`DROP ROLE IF EXISTS ${quoted(oddRole)}`);
      const cleaned = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_catalog.pg_roles
          WHERE rolname LIKE 'stage09a#%'`,
      );
      assert.equal(
        cleaned.rows[0]?.count,
        "0",
        "the odd-named role must be gone",
      );
    });
  }
});
