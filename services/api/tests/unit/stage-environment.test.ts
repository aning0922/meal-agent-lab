import assert from "node:assert/strict";
import test from "node:test";

import {
  isSupportedPostgres,
  supportedPostgresVersion,
} from "../../scripts/stage-environment.js";

/**
 * 阶段 09A / M2A：PostgreSQL 版本判据的自动化证据。
 *
 * 对象 manifest 与授权 manifest 的 catalog 基线是从**具体 patch**采集的：
 * `pg_get_constraintdef` / `pg_get_indexdef` 的规范化文本、NOT NULL 的登记方式、
 * `acldefault` 的取值都可能随 patch 变化。因此判据必须 fail closed 到 exact
 * 18.4——而「18.3 会被拒绝」不能只写在注释里，必须有测试。
 */

test("the resolver pins an exact PostgreSQL patch version", () => {
  assert.equal(supportedPostgresVersion, "18.4");
});

test("a standard PostgreSQL 18.3 banner is rejected by the exact-18.4 resolver", () => {
  // `postgres --version` 的标准输出形态，逐字与真实二进制一致。
  const banners = [
    "postgres (PostgreSQL) 18.3",
    "postgres (PostgreSQL) 18.3\n",
    "postgres (PostgreSQL) 18.3 (Homebrew)",
    "postgres (PostgreSQL) 18.3 (Debian 18.3-1.pgdg13+1)",
  ];
  for (const banner of banners) {
    assert.equal(
      isSupportedPostgres(banner),
      false,
      `18.3 must be refused: ${JSON.stringify(banner)}`,
    );
  }
});

test("only the pinned patch is accepted, in every standard banner shape", () => {
  for (const banner of [
    "postgres (PostgreSQL) 18.4",
    "postgres (PostgreSQL) 18.4\n",
    "postgres (PostgreSQL) 18.4 (Homebrew)",
  ]) {
    assert.equal(
      isSupportedPostgres(banner),
      true,
      `18.4 must be accepted: ${JSON.stringify(banner)}`,
    );
  }

  // 相邻 major、相邻 patch 与「看起来像」的字符串都必须被拒绝。前两条覆盖
  // 真实的升级场景，后两条覆盖前缀/子串匹配这一类实现错误。
  for (const banner of [
    "postgres (PostgreSQL) 17.4",
    "postgres (PostgreSQL) 19.4",
    "postgres (PostgreSQL) 18.5",
    "postgres (PostgreSQL) 18.40",
    "postgres (PostgreSQL) 118.4",
    "postgres (PostgreSQL) 18.44 (Homebrew)",
  ]) {
    assert.equal(
      isSupportedPostgres(banner),
      false,
      `must be refused: ${JSON.stringify(banner)}`,
    );
  }
});
