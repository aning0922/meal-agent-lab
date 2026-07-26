import assert from "node:assert/strict";
import test from "node:test";

import { checkReadiness, type Persistence } from "../../src/database/pool.js";

/**
 * readiness 的三类失败都必须收敛为 false，而不是让异常逃逸到 HTTP 错误处理器。
 * 这里用受控 mock 覆盖连接、查询和 migration ledger 三个阶段，不连真实数据库、
 * 不使用真实凭据。
 */
interface ClientCall {
  readonly text: string;
}

const persistenceStub = (
  connect: () => Promise<unknown>,
): Persistence =>
  ({
    pool: { connect },
    appRole: "meal_agent_app",
  }) as unknown as Persistence;

// 合成的不可达连接串 sentinel：任何一处泄漏都能被断言捕获。
const dsnSentinel =
  "postgresql://readiness_probe@127.0.0.1:1/readiness_unreachable_sentinel";

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
  let released = 0;
  const persistence = persistenceStub(async () => ({
    query: async () => {
      throw new Error(`server closed the connection: ${dsnSentinel}`);
    },
    release: () => {
      released += 1;
    },
  }));

  const ready = await checkReadiness(persistence);

  assert.equal(ready, false);
  assert.equal(released, 1);
});

test("readiness is false when the migration ledger does not match, and the client is still released", async () => {
  let released = 0;
  const calls: ClientCall[] = [];
  const persistence = persistenceStub(async () => ({
    query: async (text: string) => {
      calls.push({ text });
      if (text.includes("SELECT 1 AS ready")) {
        return { rows: [{ ready: 1 }], rowCount: 1 };
      }
      // 空 ledger 与磁盘上的 migration 文件数量不符。
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released += 1;
    },
  }));

  const ready = await checkReadiness(persistence);

  assert.equal(ready, false);
  assert.equal(released, 1);
  // 探测查询确实先于 ledger 查询执行。
  assert.equal(calls[0]?.text.includes("SELECT 1 AS ready"), true);
  assert.equal(calls.length > 1, true);
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
