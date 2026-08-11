import { writeSync } from "node:fs";

import type { EventLogSink, ShutdownSignal } from "./log-events.js";

/**
 * 阶段 09A / M3A：进程级关机契约。
 *
 * 它从 `index.ts` 里抽出来，是为了让 subprocess 回归跑的是**生产代码本身**，而不是
 * 一份形状相同的抄件——抄件跑绿不代表生产那份还在。
 *
 * 参数刻意收窄成下面这个接口：关机只需要「关」和「记一条业务事件」，不需要整个
 * Fastify 实例。顺带也让 capability gate 不必为这个文件开任何口子。
 */
export interface ClosableApp {
  readonly eventLog: EventLogSink;
  close: () => Promise<unknown>;
}

/**
 * 优雅关闭的兜底时限。到点**真正退出进程**（阶段 09A / M4）：此前只设
 * `process.exitCode` 的版本不构成强制退出——`close()` 永不 settle 时，退出码
 * 根本轮不到生效，进程要么被容器运行时 SIGKILL，要么（定时器被 `unref` 时）
 * 以 0 静默退出。
 */
const defaultForceCloseMs = 10_000;

/** 只为 subprocess 回归开的窄口：生产入口（`index.ts`）不传，用默认时限。 */
export interface ShutdownOptions {
  readonly forceCloseMs?: number;
}

/**
 * **应用**关闭失败时唯一的对外痕迹。
 *
 * `app.close()` 会跑完所有 onClose hook——日志 flush 只是其中一个，连接池、插件的
 * 清理同样可能失败，所以文案不把原因归到日志上。
 *
 * 写的是**一行完全固定的中性文本**：不带阶段、不带类型名、不带任何来自错误对象的
 * 东西。能用来记录这件事的东西之一（日志）本身可能就是坏的，而错误对象的 message
 * 是不可信文本。退出码同时钉成 1，不去依赖 Node 对未处理拒绝的默认行为。
 */
const reportCloseFailure = (): void => {
  process.stderr.write("shutdown: close failed\n");
  process.exitCode = 1;
};

/** 装上 SIGINT / SIGTERM 的优雅关机处理器。第一个信号赢，后续信号被忽略。 */
export const installShutdownHandlers = (
  app: ClosableApp,
  { forceCloseMs = defaultForceCloseMs }: ShutdownOptions = {},
): void => {
  let closing = false;
  // 参数类型收窄成 facade 的 `ShutdownSignal`：这个进程只为这两个信号安装 handler，
  // 而日志字段也只接受这两个。用 `NodeJS.Signals` 就等于把「任意信号名」这条自由
  // 字符串又放了回来。
  const shutdown = async (signal: ShutdownSignal): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      app.eventLog.emit("shutdown.started", { signal });
    } catch {
      // sink 坏掉不能改变关机路径：不设防时这一抛会让 `void shutdown(…)` 变成
      // unhandled rejection——close 不执行、强制退出定时器没建立、原始错误对象
      // 还被 Node 默认输出打上 stderr，正是本文件其余分支极力避免的三件事。
    }

    const forceClose = setTimeout(() => {
      // 三步各自兜底：日志与 stderr 都可能正是坏掉的那一环，任何一步失败都
      // 不得挡住最后的强制退出。emit 是尽力而为；writeSync(2) 是同步的固定
      // 中性文本，不含任何来自错误对象或调用方的内容。
      try {
        app.eventLog.emit("shutdown.timed-out", {});
      } catch {
        // 日志目的地坏掉不改变结局。
      }
      try {
        writeSync(2, "shutdown: forced exit after timeout\n");
      } catch {
        // stderr 坏掉同样不改变结局。
      }
      process.exit(1);
    }, forceCloseMs);
    // 刻意**不** `unref()`：关机正是「事件循环里没有别的 handle」的那一刻
    // （监听 socket 已关、连接池已 end、信号监听器不 ref 循环）。unref 过的
    // 定时器在那一刻不会触发，`close()` 永不 settle 时进程会以 0 静默退出——
    // 这条已在 M3A 的 stalled-flush 回归里实测过。ref 的代价只是：close 挂死
    // 时进程会活到时限为止，然后被这里强制退出，这正是想要的语义；close 正常
    // settle 时 finally 里的 clearTimeout 会立即放掉这个 handle。

    try {
      await app.close();
    } catch {
      // 不接住的话，`void shutdown(…)` 会把这个 rejection 丢掉。
      reportCloseFailure();
    } finally {
      clearTimeout(forceClose);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
};

/**
 * 启动失败之后的关闭。它**同样**可能失败。
 *
 * 不接住的话，rejection 会从 top-level await 逃出去：调用点那行退出码根本轮不到
 * 执行，整个错误对象还会被打到 stderr。
 */
export const closeAfterStartupFailure = async (
  app: ClosableApp,
): Promise<void> => {
  try {
    await app.close();
  } catch {
    reportCloseFailure();
  }
};
