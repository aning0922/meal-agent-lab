import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";

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
  readonly logger: FastifyBaseLogger;
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
