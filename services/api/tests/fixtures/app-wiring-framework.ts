import type { Logger } from "pino";

/**
 * 阶段 09A / M3A：`app-wiring-variants.ts` 用的框架替身。
 *
 * 真实的 `Fastify(…)` 声明在 `node_modules` 里，capability gate 因此从不往它的
 * 成员里走。这里把替身放在**另一个文件**，是为了让它同样落在被扫描的范围之外：
 * 测试只把 `app-wiring-variants.ts` 那一个文件喂给收集器，脚手架本身不参与判定。
 */

export interface FrameworkStub {
  readonly log: Logger;
}

export interface FrameworkOptions {
  readonly bodyLimit: number;
  readonly loggerInstance: Logger;
}

export const frameworkFactory = (options: FrameworkOptions): FrameworkStub => ({
  log: options.loggerInstance,
});
