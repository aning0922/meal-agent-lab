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
  // 连接建立必须在 try 内：数据库不可达时 `connect()` 会 reject，若让它逃逸，
  // readiness 会被错误处理器兜底成 500 INTERNAL_ERROR，而不是 503 未就绪。
  let client: PoolClient | undefined;
  try {
    client = await persistence.pool.connect();
    const database = await client.query<{ ready: number }>(
      "SELECT 1 AS ready",
    );
    return database.rows[0]?.ready === 1 && (await migrationsAreCurrent(client));
  } catch {
    // 连接失败、探测查询失败和 migration ledger 读取失败都只代表未就绪。
    // 这里不返回、不记录也不重抛数据库错误，避免连接串或凭据进入响应与日志。
    return false;
  } finally {
    client?.release();
  }
};
