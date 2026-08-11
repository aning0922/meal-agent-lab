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
 * 因此本进程能在时限内退出的**唯一**路径是超时分支真正调用 `process.exit`：
 * 定时器被 `unref` 时它根本不会触发（本夹具里 interval 吊着循环，unref 形态
 * 退化为「永不退出」），只设 exitCode 时循环照样被 interval 吊着。只有
 * 「ref 的定时器 + 到点 `process.exit(1)`」才能让本进程在时限内以 1 退出，
 * 并留下那一行固定的中性 stderr。运行的是 `src/shutdown.ts` 里的**生产函数
 * 本身**，不是抄件。
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
