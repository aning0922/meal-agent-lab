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

// ---------------------------------------------------------------------------
// 第十四轮收尾追加：形参不是通行证，工厂符号本身也是能力
// ---------------------------------------------------------------------------

/**
 * 14. 形参直通：`passthrough(logger: Logger): Logger => logger`。
 *
 * 上一版的 `isCompositionInput` 无条件放行**任何**解析到形参的标识符——那不是位置
 * 判据，是一张通行证。于是这条把 raw `Logger` 原样递出去的函数整个是绿的。
 */
export const violatingPassthrough = (logger: Logger): Logger => logger;

/**
 * 15. 给工厂取个别名。
 *
 * 工厂本身就是能力：拿到它就能凭空造一个 `LoggingContext`，`.framework` 也就跟着
 * 到手了。它只允许出现在组装根那一次合法工厂调用的 callee 位置。
 */
export const violatingFactoryAlias = (options: Wiring): EventLogSink => {
  const build = createLoggingContext;
  return build(options.level, options.injected).eventLog;
};

/** 16. 把工厂交给外部持有。 */
export const violatingFactoryHandover = (): typeof createLoggingContext =>
  externalRelay(createLoggingContext);

// ---------------------------------------------------------------------------
// 第十四轮收尾复评二：白名单第 6 条的「基」、以及第二个 root 工厂
// ---------------------------------------------------------------------------

/**
 * 17. 把框架容器自己的 logger 喂回工厂。
 *
 * 白名单第 6 条上一版只判「第 1 个实参是不是成员访问」，从不看基是什么。于是
 * `app.log` 落在这个位置整条无报告——raw framework logger 就这样无声进了第二个
 * `LoggingContext`。
 */
export const violatingAppLogIntoFactory = (options: Wiring): EventLogSink => {
  const boot = createLoggingContext(options.level);
  const app = Fastify({ bodyLimit: 1, loggerInstance: boot.framework });
  const second = createLoggingContext(options.level, app.log);
  return second.eventLog;
};

/**
 * 18. 任意第三方对象的 `.logger` 字段喂回工厂，同一条口子。
 *
 * 刻意写成「先命名再取 `eventLog`」：直接把工厂调用的结果当表达式用，收紧前就
 * 已经因为别的判据报红了，那样这条对第 6 条没有回归力。
 */
export const violatingForeignLoggerIntoFactory = (
  options: Wiring,
  foreign: { readonly logger: Logger },
): EventLogSink => {
  const second = createLoggingContext(options.level, foreign.logger);
  return second.eventLog;
};

/**
 * 19. `logging.ts` 的 root 工厂被取别名。
 *
 * `createLogger` 直接返回 raw `Logger`，能力严格强于 `createLoggingContext`，
 * 因此在两个边界文件之外**一处都不许出现**——连做 callee 都不行。
 */
export const violatingRootFactoryAlias = (): boolean => {
  const build = createLogger;
  // 连调用都没有：报红只可能来自「工厂符号本身即能力」这条判据。
  return typeof build === "function";
};

/** 20. 把 root 工厂交给外部持有。 */
export const violatingRootFactoryHandover = (): typeof createLogger =>
  externalRelay(createLogger);

/**
 * 21. 只是把工厂取个别名看一眼，连调用都没有。
 *
 * 第 15 号（`violatingFactoryAlias`）在收紧**之前**就已经是红的（它报的是
 * `build(…)` 的返回值和 `options.injected`），因此对「工厂符号本身即能力」这条
 * 规则没有回归力。这一条才有：收紧前它整条是绿的。
 */
export const violatingFactoryProbe = (): boolean => {
  const build = createLoggingContext;
  return typeof build === "function";
};
