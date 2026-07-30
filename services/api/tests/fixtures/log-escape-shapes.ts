import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";

/**
 * 阶段 09A / M3A：**故意违规**的日志调用形状，专供静态门禁的反向测试使用。
 *
 * 第九轮的门禁是一条正则：`\blog\.(trace|debug|info|warn|error|fatal)\s*\(`，
 * 然后只看**第一个**实参的源码文本。下面每一种写法都能从它底下走过去：别名、
 * 变量改名、元素访问、可选链、以及 printf 的后续参数。
 *
 * 这个文件**不在** `src/` 下，因此生产门禁不会扫它；它只被
 * `tests/unit/production-log-arguments.test.ts` 当作素材，用来同时喂给新旧两套
 * 扫描器，证明旧的会假绿、新的会红。
 */

interface EscapeInputs {
  /** 用 pino 的 `Logger`：`setBindings` 这类 mutation API 只在它上面有。 */
  readonly logger: Logger;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly error: Error;
}

/** 1. 别名：把 log 方法先取出来再调用。 */
export const viaMethodAlias = ({ logger, error }: EscapeInputs): void => {
  const emit = logger.error.bind(logger);
  emit({ err: error }, "aliased method");
};

/** 2. 变量改名：logger 本身换个名字。 */
export const viaRenamedLogger = ({ request, error }: EscapeInputs): void => {
  const audit = request.log;
  audit.error({ err: error }, "renamed logger");
};

/** 3. 元素访问：用字符串下标取方法。 */
export const viaElementAccess = ({ logger, error }: EscapeInputs): void => {
  logger["error"]({ err: error }, "element access");
};

/** 4. 可选链调用。 */
export const viaOptionalChain = ({ logger, request }: EscapeInputs): void => {
  logger?.warn?.({ req: request }, "optional chain");
};

/** 5. printf 后续参数：第一个实参完全无辜，秘密在后面。 */
export const viaPrintfArgument = ({ logger, reply }: EscapeInputs): void => {
  logger.info("reply was %o", reply);
};

/** 6. 常量下标 + 别名叠加。 */
export const viaConstIndexAlias = ({ logger, error }: EscapeInputs): void => {
  const level = "fatal" as const;
  const emit = logger[level];
  emit.call(logger, { err: error }, "const index alias");
};

// ---------------------------------------------------------------------------
// 第十一轮：只看 CallExpression 的 callee 仍然抓不到的形状
// ---------------------------------------------------------------------------

/** 7. `Reflect.apply`：callee 是 `Reflect.apply`，不是 LogFn。 */
export const viaReflectApply = ({ logger, error }: EscapeInputs): void => {
  Reflect.apply(logger.error, logger, [{ err: error }, "reflect apply"]);
};

/** 8. 高阶转发：把 LogFn 当参数传出去，在别处调用。 */
export const viaHigherOrderForward = ({ logger, request }: EscapeInputs): void => {
  const forward = (emit: (payload: unknown, message: string) => void): void => {
    emit({ req: request }, "higher order forward");
  };
  forward(logger.warn);
};

/** 9. 类型擦除：先擦成 unknown 再调用，callee 的类型已经不是 LogFn。 */
export const viaTypeErasure = ({ logger, error }: EscapeInputs): void => {
  const erased = logger.fatal as unknown as (
    payload: unknown,
    message: string,
  ) => void;
  erased({ err: error }, "type erased");
};

/** 10. mutation API：child 会把 binding 永久挂在子 logger 上。 */
export const viaChildBinding = ({ logger, error }: EscapeInputs): void => {
  const child = logger.child({ err: error });
  child.info("child binding");
};

/** 11. mutation API：setBindings 直接改当前实例。 */
export const viaSetBindings = ({ logger, request }: EscapeInputs): void => {
  logger.setBindings({ req: request });
};

// ---------------------------------------------------------------------------
// 第十二轮：按类型名字符串匹配会漏掉 / 误报的形状
// ---------------------------------------------------------------------------

/** 12. 泛型参数：能力藏在类型参数里。 */
export const viaGeneric = <T extends Logger>({ error }: EscapeInputs, l: T): void => {
  l.error({ err: error }, "generic logger");
};

/** 13. `Pick`：只挑一个方法出来，类型名不再叫 Logger。 */
export const viaPick = (
  { error }: EscapeInputs,
  picked: Pick<Logger, "warn">,
): void => {
  picked.warn({ err: error }, "picked logger");
};

/** 14. computed access：下标是一个计算出来的常量。 */
export const viaComputedAccess = ({ logger, error }: EscapeInputs): void => {
  const key = ("er" + "ror") as "error";
  logger[key]({ err: error }, "computed access");
};

/** 15. import alias：换个名字导入 facade，不能因此拿到放行。 */
export const viaAliasedFacade = ({ logger }: EscapeInputs): void => {
  const createEventLogSink = (root: Logger): { emit: () => void } => ({
    emit: () => {
      root.info("locally shadowed factory");
    },
  });
  createEventLogSink(logger).emit();
};

// ---------------------------------------------------------------------------
// 第十三轮：mutation API 按**成员声明身份**识别才抓得到的形状
// ---------------------------------------------------------------------------

/** 17. `Pick<Logger, "setBindings">`：类型已经不是 Logger，成员还在。 */
export const viaPickedMutation = (
  { request }: EscapeInputs,
  picked: Pick<Logger, "setBindings">,
): void => {
  picked.setBindings({ req: request });
};

/** 18. element access 形式的 mutation。 */
export const viaElementMutation = ({ logger, request }: EscapeInputs): void => {
  logger["setBindings"]({ req: request });
};

/** 19. 类型擦除之后的 mutation。 */
export const viaErasedMutation = ({ logger, request }: EscapeInputs): void => {
  const mutate = logger.setBindings as unknown as (
    bindings: Record<string, unknown>,
  ) => void;
  mutate({ req: request });
};

// ---------------------------------------------------------------------------
// 第十四轮：容器 / mapped / indexed / 接口重声明 / 解构
// ---------------------------------------------------------------------------

/** 20. mapped type 里的 setBindings。 */
type MappedLogger = { [Key in "setBindings" | "info"]: Logger[Key] };
export const viaMappedMutation = (
  { request }: EscapeInputs,
  mapped: MappedLogger,
): void => {
  mapped.setBindings({ req: request });
};

/** 21. 接口重声明：把 `Logger["setBindings"]` 当成自己的字段。 */
interface RelayInterface {
  readonly mutate: Logger["setBindings"];
}
export const viaInterfaceField = (
  { request }: EscapeInputs,
  relay: RelayInterface,
): void => {
  relay.mutate({ req: request });
};

/** 22. 解构一个 Pick 出来的能力。 */
export const viaDestructuredPick = (
  { error }: EscapeInputs,
  picked: Pick<Logger, "child" | "error">,
): void => {
  const { child, error: emit } = picked;
  emit({ err: error }, "destructured pick");
  child({}).info("destructured child");
};

/** 23. `useLevelLabels` / `onChild` 这类 pino 选项面的成员。 */
export const viaLoggerOptionMembers = ({ logger }: EscapeInputs): void => {
  const level = logger.level;
  logger.level = level;
};

/**
 * 16. 无关的同名 `LogFn`：局部声明一个同名类型，**不得**被误报。
 * 它与 pino 的 `LogFn` 只是重名。
 */
type LogFn = (message: string) => void;
export const unrelatedSameNameLogFn = (emit: LogFn): void => {
  emit("this is not a pino logger");
};
