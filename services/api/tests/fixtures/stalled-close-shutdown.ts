import type { EventLogSink } from "../../src/log-events.js";
import { installShutdownHandlers } from "../../src/shutdown.js";

/**
 * 阶段 09A / M4：「`close()` 永不 settle」的**独立进程**复现。
 *
 * DoD 7 要求 SIGTERM 在限定时间内**真正退出进程**——只设 `process.exitCode`
 * 的超时分支不算证据。这一条与 stalled-flush 一样必须另起进程：`node --test`
 * 的 runner 自己吊着事件循环，任何「定时器到底会不会到、进程到底会不会退」
 * 的问题在 runner 里都测不出来。
 *
 * 这个脚本刻意构造关机的最坏形态：
 *
 *   - `close()` 永不 settle，并且**持有一个永不清除的 interval**——这模拟的
 *     是现实里卡死的资源（挂住的连接池 socket、僵住的 flush）：事件循环被它
 *     吊着，「只设 `process.exitCode` 再等循环自然排空」的旧分支在这里**永不
 *     退出**，只会等到外部 SIGKILL；
 *   - `eventLog.emit` 是同步 no-op，不产生输出。
 *
 * 本夹具钉住的是 **exitCode-only 维度**：只设 exitCode 时循环被 interval 吊着
 * 永不退出，能在时限内以 1 退出的路径只剩超时分支真正调用 `process.exit`。
 * 它**抓不住 unref 维度**——被 interval 吊着的事件循环不会排空，`unref` 过的
 * 定时器照样到点触发（审计变异实验：unref + `process.exit(1)` 在本夹具下全绿）。
 * unref 维度要由「`close()` 永不 settle 且不持有任何 handle」的空循环第二夹具
 * 钉住（backlog K1）：那里 unref 定时器不吊循环，进程会在时限之前静默退 0。
 * 运行的是 `src/shutdown.ts` 里的**生产函数本身**，不是抄件。
 */

const events: string[] = [];
const eventLog = {
  emit: (event: string) => {
    events.push(event);
  },
} as unknown as EventLogSink;

installShutdownHandlers(
  {
    eventLog,
    close: () => {
      // 卡死的资源：既不 settle，也不放开事件循环。
      setInterval(() => undefined, 1_000);
      return new Promise<never>(() => undefined);
    },
  },
  // 缩短时限只为让回归有界；走的分支与生产默认值完全相同。
  { forceCloseMs: 1_500 },
);

process.kill(process.pid, "SIGTERM");
