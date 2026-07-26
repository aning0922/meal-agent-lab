import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

const migrationsDirectory = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly hash: string;
}

const readMigrations = async (): Promise<readonly MigrationFile[]> => {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(`${migrationsDirectory}/${name}`, "utf8");
      return {
        name,
        sql,
        hash: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
};

const prepareMigrationMetadata = async (
  client: PoolClient,
): Promise<void> => {
  await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__meal_agent_migrations (
      name text PRIMARY KEY,
      hash char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
};

/** 迁移执行角色：migration login 必须显式进入该 NOLOGIN 高权限角色。 */
export const migrationRole = "meal_agent_migrator";

const advisoryLockKey = 938_006_001;

/** 默认的有界等待。任何一项都不允许无限阻塞部署 job。 */
export const migrationDefaults = {
  connectionTimeoutMs: 10_000,
  lockWaitMs: 30_000,
  lockRetryDelayMs: 250,
} as const;

export class MigrationLockTimeoutError extends Error {
  public constructor(waitedMs: number) {
    super(
      `could not acquire the migration advisory lock within ${waitedMs}ms; ` +
        "another migration is holding it",
    );
    this.name = "MigrationLockTimeoutError";
  }
}

export class MigrationOptionError extends Error {
  public constructor(option: string) {
    super(
      `${option} must be a positive, finite, safe integer count of milliseconds`,
    );
    this.name = "MigrationOptionError";
  }
}

/**
 * 有界等待参数必须是正的有限安全整数：0、负数、NaN、Infinity 和小数一律立即
 * 拒绝，避免把「无界等待」或「立即超时」偷偷带进部署 job。
 */
const boundedMilliseconds = (
  option: string,
  value: number | undefined,
  fallback: number,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new MigrationOptionError(option);
  }
  return resolved;
};

export interface ApplyMigrationsOptions {
  /**
   * 只应用文件名 <= 该值的迁移（含），用于验证多文件序列的增量应用：
   * 先只上 0000，再单独增量上 0001。缺省应用全部待应用迁移。
   */
  readonly onlyThrough?: string;
  /**
   * 迁移执行角色。缺省显式 SET ROLE meal_agent_migrator，供 NOINHERIT 的
   * migration login 使用。
   *
   * 传 null 表示不切换角色，仅用于 bootstrap/admin 路径：冻结的 0000 自身要
   * CREATE ROLE 并设置 BYPASSRLS，必须由 cluster admin 执行，此时 migrator
   * 角色尚不存在，无法先切换过去。
   */
  readonly role?: string | null;
  /** 建立数据库连接的上界。 */
  readonly connectionTimeoutMs?: number;
  /** advisory lock 与 DDL 锁等待的上界；超时后明确失败，不无限等待。 */
  readonly lockWaitMs?: number;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref?.();
  });

/**
 * 有界获取 advisory lock：在 deadline 内轮询 pg_try_advisory_lock，
 * 超时抛出明确错误而不是永久阻塞。
 */
const acquireAdvisoryLock = async (
  client: PoolClient,
  waitMs: number,
  retryDelayMs: number,
): Promise<void> => {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const attempt = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [advisoryLockKey],
    );
    if (attempt.rows[0]?.locked === true) {
      return;
    }
    if (Date.now() + retryDelayMs >= deadline) {
      throw new MigrationLockTimeoutError(waitMs);
    }
    await sleep(retryDelayMs);
  }
};

export const applyMigrations = async (
  databaseUrl: string,
  options: ApplyMigrationsOptions = {},
): Promise<void> => {
  // 参数校验先于建立连接：非法上界不得先打开连接再失败。
  const connectionTimeoutMs = boundedMilliseconds(
    "connectionTimeoutMs",
    options.connectionTimeoutMs,
    migrationDefaults.connectionTimeoutMs,
  );
  const lockWaitMs = boundedMilliseconds(
    "lockWaitMs",
    options.lockWaitMs,
    migrationDefaults.lockWaitMs,
  );
  const role = options.role === undefined ? migrationRole : options.role;
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: connectionTimeoutMs,
    application_name: "meal-agent-migration",
  });
  // 连接建立也在 try 内：连接失败时仍必须 pool.end()，client 只在存在时释放，
  // advisory lock 只在确实取得后才解锁（否则会留下 "you don't own a lock" 警告）。
  let client: PoolClient | undefined;
  let advisoryLockHeld = false;

  try {
    client = await pool.connect();
    if (role !== null) {
      // 参数化设置 role GUC，等价于 SET ROLE，但角色名不进入 SQL 文本。
      await client.query("SELECT set_config('role', $1, false)", [role]);
    }
    // DDL 取锁同样有界：另一会话持表锁时明确失败，不无限等待。
    await client.query("SELECT set_config('lock_timeout', $1, false)", [
      `${String(lockWaitMs)}ms`,
    ]);
    await acquireAdvisoryLock(
      client,
      lockWaitMs,
      migrationDefaults.lockRetryDelayMs,
    );
    advisoryLockHeld = true;
    await prepareMigrationMetadata(client);

    for (const migration of await readMigrations()) {
      if (
        options.onlyThrough !== undefined &&
        migration.name > options.onlyThrough
      ) {
        break;
      }
      const existing = await client.query<{ hash: string }>(
        "SELECT hash FROM drizzle.__meal_agent_migrations WHERE name = $1",
        [migration.name],
      );

      if (existing.rowCount === 1) {
        if (existing.rows[0]?.hash !== migration.hash) {
          throw new Error(
            `applied migration ${migration.name} has changed checksum`,
          );
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO drizzle.__meal_agent_migrations (name, hash)
           VALUES ($1, $2)`,
          [migration.name, migration.hash],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    if (client !== undefined) {
      if (advisoryLockHeld) {
        await client
          .query("SELECT pg_advisory_unlock($1)", [advisoryLockKey])
          .catch(() => undefined);
      }
      client.release();
    }
    await pool.end();
  }
};

export const migrationsAreCurrent = async (
  client: PoolClient,
): Promise<boolean> => {
  const migrations = await readMigrations();
  const result = await client.query<{ name: string; hash: string }>(
    `SELECT name, hash
     FROM drizzle.__meal_agent_migrations
     ORDER BY name`,
  );

  return (
    result.rows.length === migrations.length &&
    migrations.every(
      (migration, index) =>
        result.rows[index]?.name === migration.name &&
        result.rows[index]?.hash === migration.hash,
    )
  );
};

// ---------------------------------------------------------------------------
// 运维入口
//
// 默认命令走安全路径：显式 SET ROLE meal_agent_migrator 应用全部待应用 migration。
//
// `--bootstrap-0000` 是唯一的 admin 例外，且是窄而固定的：它只能以 cluster admin
// 身份（不切换 role）应用冻结的 0000，因为 0000 自身要 CREATE ROLE 并设置
// BYPASSRLS，此时 meal_agent_migrator 还不存在。该模式不接受任意 role，也不接受
// 任意 migration 边界。
// ---------------------------------------------------------------------------

export const bootstrapMigrationFlag = "--bootstrap-0000";

/** `--bootstrap-0000` 的固定参数，调用方无法改写。 */
export const bootstrapMigrationOptions: ApplyMigrationsOptions = Object.freeze({
  role: null,
  onlyThrough: "0000_stage_06.sql",
});

export type MigrationCliMode = "default" | "bootstrap-0000";

export class MigrationCliUsageError extends Error {
  public constructor(detail: string) {
    super(
      `${detail}. Usage: db:migrate [${bootstrapMigrationFlag}] ` +
        "(no other arguments are accepted)",
    );
    this.name = "MigrationCliUsageError";
  }
}

export const parseMigrationCliArguments = (
  argv: readonly string[],
): MigrationCliMode => {
  if (argv.length === 0) {
    return "default";
  }
  if (argv.length === 1 && argv[0] === bootstrapMigrationFlag) {
    return "bootstrap-0000";
  }
  if (argv.length > 1) {
    throw new MigrationCliUsageError(
      `expected at most one argument, received ${String(argv.length)}`,
    );
  }
  throw new MigrationCliUsageError(
    `unknown argument ${JSON.stringify(argv[0])}`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = parseMigrationCliArguments(process.argv.slice(2));
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is required");
  }
  await applyMigrations(
    databaseUrl,
    mode === "bootstrap-0000" ? bootstrapMigrationOptions : {},
  );
}
