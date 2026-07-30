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
