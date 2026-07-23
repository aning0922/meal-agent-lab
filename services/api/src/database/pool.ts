import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";

import type { AppConfig } from "../config.js";
import { migrationsAreCurrent } from "./migrate.js";
import * as schema from "./schema.js";

export interface Persistence {
  readonly pool: Pool;
  readonly drizzle: NodePgDatabase<typeof schema>;
  readonly appRole: string;
}

export const createPersistence = (config: AppConfig): Persistence => {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.nodeEnv === "test" ? 8 : 20,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: "meal-agent-api",
  });

  return {
    pool,
    drizzle: drizzle(pool, { schema }),
    appRole: config.databaseAppRole,
  };
};

export const withAppTransaction = async <T>(
  persistence: Persistence,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await persistence.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${persistence.appRole}`);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export const setUserContext = async (
  client: PoolClient,
  userId: string,
): Promise<void> => {
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
};

export const setHouseholdContext = async (
  client: PoolClient,
  householdId: string,
): Promise<void> => {
  await client.query("SELECT set_config('app.household_id', $1, true)", [
    householdId,
  ]);
};

export const checkReadiness = async (
  persistence: Persistence,
): Promise<boolean> => {
  const client = await persistence.pool.connect();
  try {
    const database = await client.query<{ ready: number }>(
      "SELECT 1 AS ready",
    );
    return database.rows[0]?.ready === 1 && (await migrationsAreCurrent(client));
  } catch {
    return false;
  } finally {
    client.release();
  }
};
