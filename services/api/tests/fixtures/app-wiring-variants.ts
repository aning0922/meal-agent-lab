import type { Writable } from "node:stream";

import Fastify, { type FastifyPluginAsync } from "fastify";
import type { Logger } from "pino";

import {
  createLoggingContext,
  type EventLogSink,
  type LoggingContext,
} from "../../src/log-events.js";
import { createLogger } from "../../src/logging.js";
import { frameworkFactory, type FrameworkStub } from "./app-wiring-framework.js";

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

/** 一个「要一个 logger」的插件。它的选项**不是**框架工厂的选项。 */
const auditPlugin: FastifyPluginAsync<{
  readonly loggerInstance: Logger;
}> = async () => undefined;

// ---------------------------------------------------------------------------
// 合法：三个精确位置，加上组装根对**两个真实工厂**产物的持有
// ---------------------------------------------------------------------------

export const allowedWiring = (options: Wiring): EventLogSink => {
  const logging = createLoggingContext(
    options.level,
    options.injected,
    options.destination,
  );
  // 用的是 **fastify 自己的**工厂。放行绑的是它的声明身份，不是「initializer 恰好
  // 是一个调用」——后者曾经让任何中继函数的返回值都变成「组装根持有的容器」。
  const app = Fastify({
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

// ---------------------------------------------------------------------------
// 第十四轮收尾：`const … = <任意调用>` 曾被当成「组装根持有的容器」而整体放行
// ---------------------------------------------------------------------------

/**
 * 8. 中继函数的返回值。
 *
 * 上一版的 root-held 判据是 `ts.isCallExpression(node.initializer)`——**任何**调用
 * 都算。于是 `const held = externalRelay(logging)` 之后，`held` 怎么用都放行，整个
 * context 一步就出了边界。
 */
export const violatingForeignFactoryHolder = (
  options: Wiring,
): LoggingContext => {
  const logging = createLoggingContext(options.level, options.injected);
  const held = externalRelay(logging);
  return held;
};

/**
 * 9. 自造的「框架」工厂。
 *
 * 它返回的东西身上挂着一个 `Logger`，形状和 `FastifyInstance` 没有区别；靠「是不是
 * 一个调用」根本分不出它和真的 `Fastify(…)`。判据必须是**声明身份**。
 */
export const violatingForeignFrameworkHolder = (
  options: Wiring,
): FrameworkStub => {
  const logging = createLoggingContext(options.level, options.injected);
  const stub = frameworkFactory({
    bodyLimit: 1,
    loggerInstance: logging.framework,
  });
  return stub;
};

// ---------------------------------------------------------------------------
// 第十四轮收尾复评：按「形状」放行的三条规则叠加起来是一条完整的能力出口
// ---------------------------------------------------------------------------

/**
 * 10. 结果被丢弃的自造工厂调用。
 *
 * 「值没有去处」只覆盖**返回值**。能力是顺着**实参**出去的：callee 已经拿到了
 * `logging.framework`。上一版三条规则（丢弃的调用 / 任意调用的选项字面量 /
 * `loggerInstance:` 不看外层 callee）叠加之后，这整条语句一条都不报。
 */
export const violatingDiscardedForeignCall = (options: Wiring): EventLogSink => {
  const logging = createLoggingContext(options.level, options.injected);
  frameworkFactory({ bodyLimit: 1, loggerInstance: logging.framework });
  return logging.eventLog;
};

/**
 * 11. 插件选项里的 `loggerInstance`。
 *
 * 和 app.ts 里真实存在的 `app.register(fastifySwagger, { … })` 是同一种语句形状，
 * 只是把 raw framework logger 交给了任意插件。`loggerInstance:` 这条白名单必须
 * 检查**外层调用是不是框架工厂**，否则这里全绿。
 */
export const violatingPluginOption = (options: Wiring): EventLogSink => {
  const logging = createLoggingContext(options.level, options.injected);
  const app = Fastify({ bodyLimit: 1, loggerInstance: logging.framework });
  app.register(auditPlugin, { loggerInstance: logging.framework });
  return logging.eventLog;
};

/** 12. 直接把工厂调用的结果 return 出去——整个 context（含 `.framework`）出边界。 */
export const violatingReturnedContextCall = (options: Wiring): LoggingContext =>
  createLoggingContext(options.level, options.injected);

/** 13. 先命名再 return。绕一手中继的写法早就被抓住了，最简单的这个反而漏了。 */
export const violatingReturnedContext = (options: Wiring): LoggingContext => {
  const logging = createLoggingContext(options.level, options.injected);
  return logging;
};
