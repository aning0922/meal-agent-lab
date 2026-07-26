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
  const lockWaitMs = options.lockWaitMs ?? migrationDefaults.lockWaitMs;
  const role = options.role === undefined ? migrationRole : options.role;
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis:
      options.connectionTimeoutMs ?? migrationDefaults.connectionTimeoutMs,
    application_name: "meal-agent-migration",
  });
  const client = await pool.connect();

  try {
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
    await client
      .query("SELECT pg_advisory_unlock($1)", [advisoryLockKey])
      .catch(() => undefined);
    client.release();
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is required");
  }
  await applyMigrations(databaseUrl);
}
