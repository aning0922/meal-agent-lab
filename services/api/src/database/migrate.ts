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

export const applyMigrations = async (databaseUrl: string): Promise<void> => {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: "meal-agent-migration",
  });
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock(938_006_001)");
    await prepareMigrationMetadata(client);

    for (const migration of await readMigrations()) {
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
    await client.query("SELECT pg_advisory_unlock(938_006_001)").catch(
      () => undefined,
    );
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
