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

/** 优雅关闭的兜底时限。到点只改退出码，不强杀。 */
const forceCloseMs = 10_000;

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
export const installShutdownHandlers = (app: ClosableApp): void => {
  let closing = false;
  // 参数类型收窄成 facade 的 `ShutdownSignal`：这个进程只为这两个信号安装 handler，
  // 而日志字段也只接受这两个。用 `NodeJS.Signals` 就等于把「任意信号名」这条自由
  // 字符串又放了回来。
  const shutdown = async (signal: ShutdownSignal): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    app.eventLog.emit("shutdown.started", { signal });

    const forceClose = setTimeout(() => {
      app.eventLog.emit("shutdown.timed-out", {});
      process.exitCode = 1;
    }, forceCloseMs);
    forceClose.unref();

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
