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
    // 参数化设置 role GUC，等价于 SET LOCAL ROLE，但角色名不进入 SQL 文本。
    await client.query("SELECT set_config('role', $1, true)", [
      persistence.appRole,
    ]);
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
    // readiness 必须在真实 runtime 权限下成立：runtime login 是 NOINHERIT，
    // 必须显式进入 meal_agent_app 才拿得到 ledger 的读权限。用事务内
    // SET LOCAL（set_config 的 local 形式）而不是会话级 SET ROLE，
    // 保证连接归还池时不残留角色。
    await client.query("BEGIN");
    await client.query("SELECT set_config('role', $1, true)", [
      persistence.appRole,
    ]);
    const database = await client.query<{ ready: number }>(
      "SELECT 1 AS ready",
    );
    const ready =
      database.rows[0]?.ready === 1 && (await migrationsAreCurrent(client));
    // 只读探针：始终 ROLLBACK，事务与 SET LOCAL role 一并结束。
    await client.query("ROLLBACK");
    return ready;
  } catch {
    // 连接失败、角色切换失败、探测查询失败和 migration ledger 读取失败都只
    // 代表未就绪。这里不返回、不记录也不重抛数据库错误，避免连接串或凭据
    // 进入响应与日志。
    if (client !== undefined) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    return false;
  } finally {
    client?.release();
  }
};
