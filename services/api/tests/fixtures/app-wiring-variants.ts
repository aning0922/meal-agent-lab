import type { Writable } from "node:stream";

import type { Logger } from "pino";

import {
  createLoggingContext,
  type EventLogSink,
  type LoggingContext,
} from "../../src/log-events.js";
import { createLogger } from "../../src/logging.js";
import { frameworkFactory } from "./app-wiring-framework.js";

/**
 * 阶段 09A / M3A：**组装根**的合法与违规接线变体，供 capability gate 的自动化
 * 回归使用。
 *
 * 第十三轮的 app.ts 假绿是靠**手工改文件**验证的——那种验证跑完就没了，下一轮
 * 谁也不知道它还成不成立。这个 fixture 把每一种写法固定下来，测试把它当成
 * 「组装根」喂给收集器，因此「精确节点白名单」这件事是有回归的。
 *
 * 约定：函数名以 `allowed` 开头的必须**不**被报出；以 `violating` 开头的必须被
 * 报出。测试按这个约定逐条断言。
 */

interface Wiring {
  readonly level: string;
  readonly injected?: Logger;
  readonly destination?: Writable;
}

const externalRelay = <T>(value: T): T => value;

// ---------------------------------------------------------------------------
// 合法：三个精确位置
// ---------------------------------------------------------------------------

export const allowedWiring = (options: Wiring): EventLogSink => {
  const logging = createLoggingContext(
    options.level,
    options.injected,
    options.destination,
  );
  const app = frameworkFactory({
    bodyLimit: 1,
    loggerInstance: logging.framework,
  });
  void app;
  return logging.eventLog;
};

// ---------------------------------------------------------------------------
// 违规：把能力先过一手，或者换个容器带出去
// ---------------------------------------------------------------------------

/** 1. `loggerInstance` 位置上先过一个中继函数。 */
export const violatingRelayedFramework = (options: Wiring): {
  readonly loggerInstance: Logger;
} => {
  const logging = createLoggingContext(options.level, options.injected);
  return { loggerInstance: externalRelay(logging.framework) };
};

/** 2. 把整个 context 交给外部中继。 */
export const violatingRelayedContext = (options: Wiring): LoggingContext =>
  externalRelay(createLoggingContext(options.level, options.injected));

/** 3. 换个别名字段把 framework 带出去。 */
export const violatingAliasedFramework = (options: Wiring): {
  readonly alias: Logger;
} => {
  const logging = createLoggingContext(options.level, options.injected);
  return { alias: logging.framework };
};

/** 4. 解构出来再返回。 */
export const violatingDestructuredFramework = (options: Wiring): Logger => {
  const { framework } = createLoggingContext(options.level, options.injected);
  return framework;
};

/** 5. 装进一个容器带出边界。 */
export const violatingContainer = (options: Wiring): readonly Logger[] => [
  createLoggingContext(options.level, options.injected).framework,
];

/** 6. 通过 indexed access 类型取出来。 */
export const violatingIndexedAccess = (
  options: Wiring,
): LoggingContext["framework"] =>
  createLoggingContext(options.level, options.injected).framework;

/** 7. 直接把一个新建的 root 带出去。 */
export const violatingRawRoot = (options: Wiring): Logger =>
  createLogger(options.level);
