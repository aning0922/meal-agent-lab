import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 阶段 09A / M4 / DoD 7：SIGTERM 必须在限定时间内**真正退出进程**。
 *
 * 夹具里 `close()` 永不 settle 且持有一个永不清除的 interval（模拟卡死的
 * 资源吊着事件循环，详见 fixtures/stalled-close-shutdown.ts）。断言逐条钉住
 * 历史失败形态：
 *
 *   - 进程必须**自己**退出而不是被 harness 杀掉——「只设 `process.exitCode`
 *     再等循环自然排空」的旧分支在循环被吊着时永不退出；
 *   - 退出码必须是 1，且真实耗时不小于夹具设定的时限——`unref` 过的定时器
 *     或提前的自然退出都到不了这条组合；
 *   - 耗时也必须有上界——「限定时间内」是 DoD 的原文，不是氛围；
 *   - stderr 必须恰好是那一行固定中性文本——强制退出不得携带任何来自错误
 *     对象或日志目的地的内容。
 */
test("SIGTERM with a close() that never settles still exits 1 within the deadline", () => {
  const fixtureForceCloseMs = 1_500;
  const before = performance.now();
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(packageRoot, "tests", "fixtures", "stalled-close-shutdown.ts"),
    ],
    { cwd: packageRoot, encoding: "utf8", timeout: 30_000 },
  );
  // 同步调用返回之后重新量——阻塞期间没有任何定时器在跑。
  const elapsedMs = performance.now() - before;

  assert.equal(
    run.signal,
    null,
    `the probe must exit by itself, not be killed by the harness\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );
  assert.equal(
    run.status,
    1,
    `forced shutdown must exit 1\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );
  assert.equal(
    run.stderr,
    "shutdown: forced exit after timeout\n",
    "stderr must be exactly one fixed neutral line",
  );
  assert.equal(run.stdout, "", "the forced exit path writes nothing to stdout");
  assert.ok(
    elapsedMs >= fixtureForceCloseMs,
    `the process exited after ${String(Math.round(elapsedMs))}ms, before the ` +
      `${String(fixtureForceCloseMs)}ms deadline could have fired; an unref'd ` +
      "timer exiting 0 early must not pass as a forced exit",
  );
  // 上界给足解释器启动与慢 CI 的余量；它挡住的是「几十秒后才被什么东西
  // 收走」的形态，不是在量启动性能。
  assert.ok(
    elapsedMs < 15_000,
    `the forced exit took ${String(Math.round(elapsedMs))}ms; a bounded ` +
      "deadline must not degenerate into an unbounded wait",
  );
});
