import assert from "node:assert/strict";
import test from "node:test";

import { checkReadiness, type Persistence } from "../../src/database/pool.js";

/**
 * readiness 的三类失败都必须收敛为 false，而不是让异常逃逸到 HTTP 错误处理器。
 * 同时验证它在事务内显式进入运行角色，并在归还连接前结束事务。
 *
 * 这里用受控 mock 覆盖连接、角色切换、探测查询和 migration ledger，
 * 不连真实数据库、不使用真实凭据。真实 PostgreSQL 18 的权限边界由
 * tests/database/stage09a.roles.database.test.ts 覆盖。
 */
interface ClientCall {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

const persistenceStub = (connect: () => Promise<unknown>): Persistence =>
  ({
    pool: { connect },
    appRole: "meal_agent_app",
  }) as unknown as Persistence;

// 合成的不可达连接串 sentinel：任何一处泄漏都能被断言捕获。
const dsnSentinel =
  "postgresql://readiness_probe@127.0.0.1:1/readiness_unreachable_sentinel";

/** 记录调用并按语句返回结果的假 client。 */
const recordingClient = (
  calls: ClientCall[],
  ledgerRows: readonly { name: string; hash: string }[],
  released: { count: number },
) => ({
  query: async (text: string, values?: readonly unknown[]) => {
    calls.push({ text, values });
    if (text.includes("SELECT 1 AS ready")) {
      return { rows: [{ ready: 1 }], rowCount: 1 };
    }
    if (text.includes("__meal_agent_migrations")) {
      return { rows: ledgerRows, rowCount: ledgerRows.length };
    }
    return { rows: [], rowCount: 0 };
  },
  release: () => {
    released.count += 1;
  },
});

test("readiness is false when the database connection is refused", async () => {
  let released = 0;
  const persistence = persistenceStub(async () => {
    const error = new Error(
      `connect ECONNREFUSED 127.0.0.1:1 while using ${dsnSentinel}`,
    );
    Object.assign(error, { code: "ECONNREFUSED" });
    throw error;
  });

  const ready = await checkReadiness(persistence);

  assert.equal(ready, false);
  // client 从未成功赋值，finally 不得因此抛出，也不得调用 release。
  assert.equal(released, 0);
});

test("readiness is false when the liveness probe query fails, and the client is still released", async () => {
  const released = { count: 0 };
  const persistence = persistenceStub(async () => ({
    query: async (text: string) => {
      if (text.includes("SELECT 1 AS ready")) {
        throw new Error(`server closed the connection: ${dsnSentinel}`);
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released.count += 1;
    },
  }));

  const ready = await checkReadiness(persistence);

  assert.equal(ready, false);
  assert.equal(released.count, 1);
});

test("readiness is false when entering the application role is denied", async () => {
  const released = { count: 0 };
  const persistence = persistenceStub(async () => ({
    query: async (text: string) => {
      if (text.includes("set_config")) {
        // NOINHERIT 的 runtime login 未被授予该角色时的真实错误形态。
        throw new Error('permission denied to set role "meal_agent_app"');
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released.count += 1;
    },
  }));

  const ready = await checkReadiness(persistence);

  assert.equal(ready, false);
  assert.equal(released.count, 1);
});

test("readiness reads the migration ledger inside a transaction as the application role and rolls back", async () => {
  const calls: ClientCall[] = [];
  const released = { count: 0 };
  const persistence = persistenceStub(async () =>
    // 空 ledger 与磁盘上的 migration 文件数量不符 → 未就绪。
    recordingClient(calls, [], released),
  );

  const ready = await checkReadiness(persistence);

  assert.equal(ready, false);
  assert.equal(released.count, 1);

  const texts = calls.map((call) => call.text);
  // 事务边界：BEGIN 在最前，ROLLBACK 在最后，连接不带残留状态归还。
  assert.equal(texts[0], "BEGIN");
  assert.equal(texts.at(-1), "ROLLBACK");

  // 角色切换使用 SET LOCAL 语义（第三个参数为 true），且角色名是参数不是拼接。
  const roleCall = calls.find((call) => call.text.includes("set_config"));
  assert.notEqual(roleCall, undefined);
  assert.match(String(roleCall?.text), /set_config\('role', \$1, true\)/);
  assert.deepEqual(roleCall?.values, ["meal_agent_app"]);

  // 顺序：先进入角色，再探测，再读 ledger。
  const indexOf = (needle: string): number =>
    texts.findIndex((text) => text.includes(needle));
  assert.equal(indexOf("set_config") < indexOf("SELECT 1 AS ready"), true);
  assert.equal(
    indexOf("SELECT 1 AS ready") < indexOf("__meal_agent_migrations"),
    true,
  );
});

test("readiness never surfaces the database error or connection string to its caller", async () => {
  const persistence = persistenceStub(async () => {
    throw new Error(dsnSentinel);
  });

  // 不抛出，只返回布尔值：调用方拿不到任何数据库错误细节。
  const ready = await checkReadiness(persistence);

  assert.equal(ready, false);
  assert.equal(typeof ready, "boolean");
});
