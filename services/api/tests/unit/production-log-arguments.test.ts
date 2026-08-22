import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

/**
 * 阶段 09A / M3A：**logger capability 不得离开日志边界**的静态门禁。
 *
 * ## 判据的演进
 *
 * 第九轮是正则 + 只看第一个实参：别名、改名、元素访问、可选链、printf 后续参数
 * 全部漏网。第十轮改成 type checker，但只看 `CallExpression` 的 callee：
 * `Reflect.apply`、高阶转发、类型擦除仍然漏网。第十一轮改成看**能力本身**，但
 * 判据是**类型名字符串**——两头都错：局部声明一个同名 `LogFn` 会被误报，
 * `Pick<Logger, "warn">` 这类结构变换之后的类型会被漏报。
 *
 * 这一轮改成**声明身份**：从 program 里找出 pino 与 fastify 自己的 `.d.ts` 声明
 * 节点，之后一律比对节点身份；结构类型再按成员看一眼。
 *
 * ## 规则
 *
 *   1. `LogFn` 类型的表达式只允许出现在 `src/log-events.ts`（facade）与
 *      `src/logging.ts`（中央边界）里；
 *   2. `child`/`setBindings` 等 mutation API 只有 `src/logging.ts` 可以碰；
 *   3. Logger 类型的表达式只允许出现在上面两个边界文件，以及组装根 `src/app.ts`
 *      的**三个精确上下文**里——不是整文件放行。
 *
 * ## 它是什么，不是什么
 *
 * **这是工程护栏，不是形式化安全证明。** 它建立在 TypeScript 的类型解析之上，
 * 因此凡是类型系统看不见的东西（`any`、跨越 `JSON.parse` 的运行期值、动态
 * `import()` 之后的反射、用 `declare` 伪造的声明）都不在它的射程里。它拦的是
 * **日常演进中会自然出现的**那些写法，而不是一个有决心的攻击者。
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
const sourceRoot = join(packageRoot, "src");
const escapeFixture = join(
  packageRoot,
  "tests",
  "fixtures",
  "log-escape-shapes.ts",
);
const wiringFixture = join(
  packageRoot,
  "tests",
  "fixtures",
  "app-wiring-variants.ts",
);

interface LoggerCallSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const buildProgram = (extraFiles: readonly string[]): ts.Program => {
  const configPath = join(packageRoot, "tsconfig.json");
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(raw.error, undefined, "tsconfig.json must be readable");
  const parsed = ts.parseJsonConfigFileContent(
    raw.config as object,
    ts.sys,
    packageRoot,
  );
  const files = [
    ...parsed.fileNames.filter((name) => name.startsWith(sourceRoot)),
    ...extraFiles,
  ];
  assert.ok(
    files.length > 5,
    `the program must actually include src files, got ${String(files.length)}`,
  );
  return ts.createProgram(files, { ...parsed.options, noEmit: true });
};

/**
 * 按**声明身份**建立能力类型的判据，而不是按类型名字符串。
 *
 * 名字匹配两头都错：局部声明一个同名 `LogFn` 会被误报；而 `Pick<Logger, "warn">`
 * 这类结构变换之后的类型，符号名已经不叫 Logger 了，会被漏报。这里改成从 program
 * 里找出 **pino 与 fastify 自己的 .d.ts 声明节点**，之后一律比对节点身份。
 */
interface CapabilityDeclarations {
  readonly logFunction: ReadonlySet<ts.Declaration>;
  readonly logger: ReadonlySet<ts.Declaration>;
  /** pino/fastify logger 上那些 mutation 成员的**成员声明节点**。 */
  readonly mutationMembers: ReadonlySet<ts.Declaration>;
}

const fromPackage = (fileName: string, name: string): boolean =>
  fileName.includes(`/node_modules/`) && fileName.includes(`/${name}/`);

const resolveCapabilityDeclarations = (
  program: ts.Program,
): CapabilityDeclarations => {
  const logFunction = new Set<ts.Declaration>();
  const logger = new Set<ts.Declaration>();
  const mutationMembers = new Set<ts.Declaration>();
  for (const file of program.getSourceFiles()) {
    const pino = fromPackage(file.fileName, "pino");
    const fastify = fromPackage(file.fileName, "fastify");
    if (!pino && !fastify) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        if (pino && name === "LogFn") {
          logFunction.add(node);
        }
        const isLoggerShape =
          (pino &&
            (name === "Logger" ||
              name === "BaseLogger" ||
              name === "LoggerExtras")) ||
          (fastify && name === "FastifyBaseLogger");
        if (isLoggerShape) {
          if (name !== "LoggerExtras") {
            logger.add(node);
          }
          // mutation 成员**只**从真实的 Logger/BaseLogger/LoggerExtras/
          // FastifyBaseLogger 上收集——不是「pino 的 .d.ts 里凡是同名的成员」。
          // 后者会把无关类型上的同名成员也收进来，名单一旦变宽，判据就又退回
          // 名字匹配了。
          const collect = (container: ts.Node): void => {
            container.forEachChild((member) => {
              if (
                (ts.isPropertySignature(member) ||
                  ts.isMethodSignature(member)) &&
                member.name !== undefined &&
                ts.isIdentifier(member.name) &&
                mutationMemberNames.has(member.name.text)
              ) {
                mutationMembers.add(member);
              }
              // 类型别名里的类型字面量（`Logger` 是 `BaseLogger & {…}`）。
              if (
                ts.isTypeLiteralNode(member) ||
                ts.isIntersectionTypeNode(member)
              ) {
                collect(member);
              }
            });
          };
          collect(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  assert.ok(
    logFunction.size > 0,
    "the program must contain pino's own LogFn declaration",
  );
  assert.ok(
    logger.size > 0,
    "the program must contain pino/fastify logger declarations",
  );
  assert.ok(
    mutationMembers.size > 0,
    "the program must contain pino's own mutation member declarations",
  );
  return { logFunction, logger, mutationMembers };
};

/** 类型（含 union / intersection 成员）是否解析到给定的声明节点之一。 */
const typeResolvesTo = (
  type: ts.Type,
  declarations: ReadonlySet<ts.Declaration>,
): boolean => {
  const seen = new Set<ts.Type>();
  const walk = (candidate: ts.Type): boolean => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    for (const symbol of [candidate.aliasSymbol, candidate.getSymbol()]) {
      for (const declaration of symbol?.getDeclarations() ?? []) {
        if (declarations.has(declaration)) {
          return true;
        }
      }
    }
    if (candidate.isUnionOrIntersection()) {
      return candidate.types.some(walk);
    }
    return false;
  };
  return walk(type);
};

/**
 * 一个类型是否**携带**了 logger 能力——直接是、成员是、元素是、类型实参是，都算。
 *
 * 只看类型本身是不够的：`readonly Logger[]`、`{ alias: Logger }`、
 * `Pick<Logger, "warn">`、`Logger["setBindings"]`、mapped type、以及解构出来的
 * 单个成员——这些写法都能把能力装进另一个壳子里带出边界。深度有界，避免在
 * 递归类型上打转。
 */
const carriesCapability = (
  checker: ts.TypeChecker,
  type: ts.Type,
  declarations: ReadonlySet<ts.Declaration>,
  node: ts.Node,
  depth = 0,
  seen: Set<ts.Type> = new Set(),
): boolean => {
  if (depth > 4 || seen.has(type)) {
    return false;
  }
  seen.add(type);
  if (typeResolvesTo(type, declarations)) {
    return true;
  }
  // 只往**自家或匿名**的类型里走成员。第三方框架类型（`FastifyRequest`、
  // `FastifyInstance`）几乎都间接挂着一个 `log`，往里走会把每一个 request/reply
  // 都报成能力泄漏——那不是「用容器把能力带出边界」，那是框架本来的形状。
  // 从它们身上**取出** logger（`request.log`）仍然由直接判据抓住。
  const declaredInDependencies = (
    type.getSymbol()?.getDeclarations() ?? []
  ).some(
    (declaration) =>
      declaration.getSourceFile().fileName.includes("/node_modules/"),
  );
  if (!declaredInDependencies) {
    for (const property of type.getProperties()) {
      if (
        carriesCapability(
          checker,
          checker.getTypeOfSymbolAtLocation(property, node),
          declarations,
          node,
          depth + 1,
          seen,
        )
      ) {
        return true;
      }
    }
  }
  // 类型实参只在**数组/元组**这类真正的容器上走。第三方框架类型的泛型参数不算
  // 「用容器把能力带出边界」——`FastifyRequest` 的第七个类型参数就是 `Logger`，
  // 往里走会把每一个 request 形参都报成泄漏。
  const isContainer =
    checker.isArrayType(type) ||
    checker.isTupleType(type) ||
    !declaredInDependencies;
  if (isContainer) {
    for (const argument of checker.getTypeArguments(
      type as ts.TypeReference,
    ) ?? []) {
      if (
        carriesCapability(checker, argument, declarations, node, depth + 1, seen)
      ) {
        return true;
      }
    }
  }
  return false;
};

/** pino / Fastify logger 上会改变实例状态或派生新实例的成员名。 */
const mutationMemberNames = new Set([
  "child",
  "setBindings",
  "bindings",
  "flush",
  "level",
  "silent",
  "on",
  "addListener",
  "removeListener",
]);

/**
 * 一次成员访问是否落在 pino 的 mutation 成员上——判据是**成员声明身份**。
 *
 * 按名字匹配抓不到 `Pick<Logger, "setBindings">`（接收者类型已经不是 Logger），
 * 也抓不到 `logger["setBindings"]`（`node.name` 根本不存在）。这里改成：先算出
 * 被访问的成员名，再从**接收者的类型**上取那个属性的符号，比对它的声明节点。
 * 映射类型（`Pick`）产生的属性符号仍然指向原始的 `PropertySignature`。
 */
const accessedMutationMember = (
  checker: ts.TypeChecker,
  node: ts.Node,
  declarations: ReadonlySet<ts.Declaration>,
): string | undefined => {
  let receiver: ts.Expression;
  let member: string;
  if (ts.isPropertyAccessExpression(node)) {
    receiver = node.expression;
    member = node.name.text;
  } else if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    receiver = node.expression;
    member = node.argumentExpression.text;
  } else {
    return undefined;
  }
  if (!mutationMemberNames.has(member)) {
    return undefined;
  }
  const property = checker
    .getTypeAtLocation(receiver)
    .getProperty(member);
  const hit = (property?.getDeclarations() ?? []).some((declaration) =>
    declarations.has(declaration),
  );
  return hit ? member : undefined;
};

/** 某个表达式是否解析到某个模块的**真实导出符号**（import alias 也认得出来）。 */
const resolvesToExport = (
  checker: ts.TypeChecker,
  callee: ts.Expression,
  moduleFile: string,
  exportName: string,
): boolean => {
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol === undefined) {
    return false;
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  if (symbol.getName() !== exportName) {
    return false;
  }
  return (symbol.getDeclarations() ?? []).some(
    (declaration) => declaration.getSourceFile().fileName === moduleFile,
  );
};

/**
 * 收集一个 program 里所有的 **logger capability** 出现点。
 *
 * 判据是**能力本身**：任何表达式只要类型解析到 pino 的 `LogFn` 声明（或结构上
 * 暴露了它），或者解析到 pino/fastify 的 logger 声明，就算一次 capability 取用。
 * 调用与否无关紧要——拿到了就是拿到了。
 *
 * **这是工程护栏，不是形式化安全证明。** 它建立在 TypeScript 的类型解析之上，
 * 因此凡是类型系统看不见的东西（`any`、跨越 `JSON.parse` 的运行期值、动态
 * `import()` 之后的反射、用 `declare` 伪造的声明）都不在它的射程里。它拦的是
 * **日常演进中会自然出现的**那些写法，而不是一个有决心的攻击者。
 */
const collectCapabilityUses = (
  program: ts.Program,
  withinPath: string,
  compositionRootOverride?: string,
  compositionEntryName = "buildApp",
): readonly LoggerCallSite[] => {
  const checker = program.getTypeChecker();
  const declarations = resolveCapabilityDeclarations(program);
  const facadeModule = join(sourceRoot, "log-events.ts");
  const loggingModule = join(sourceRoot, "logging.ts");
  // 组装根可以被覆盖，好让 fixture 扮演它——app.ts 的白名单因此有**自动化回归**，
  // 而不是靠每轮手工改一次文件再改回来。
  const compositionRoot = compositionRootOverride ?? join(sourceRoot, "app.ts");
  /**
   * 组装根**入口函数的第一个形参**的真实符号——生产里就是
   * `buildApp(options: BuildAppOptions)` 的 `options`。
   *
   * 上一版判的是「任何 FunctionLike 的第一个形参」。那不是身份，是形状：随手写一个
   * helper，它自己的首参就成了合法注入源
   * （`(input: { logger: Logger }) => createLoggingContext(level, input.logger)`
   * 实测 0 report）。注入槽只有一个来源，必须按**这条 parameter 声明**登记。
   */
  const optionsSymbols = new Set<ts.Symbol>();
  const found = new Map<string, LoggerCallSite>();

  /**
   * app.ts 的白名单：**精确节点 + 精确参数位置**，不按祖先子树放行。
   *
   * 上一版是往上走祖先链，只要撞到 `loggerInstance:` 或 `createEventLogSink(...)`
   * 就放行。那等于放行了整棵子树——`loggerInstance: externalRelay(logger)` 与
   * `createEventLogSink(externalRelay(logger))` 都能溜过去（实测两条都假绿）。
   *
   * 现在只认这些**确切的**位置，而且节点形状也钉死（完整清单见 `isAllowedAppNode`
   * 上的注释）：
   *
   *   1. `createLoggingContext(level, <node>)` 的第 1 个实参，且 `<node>` 必须是
   *      一个成员访问（`options.logger`）；
   *   2. `loggerInstance: <node>`，`<node>` 必须是 `<ctx>.framework`，而且这个属性
   *      必须写在**框架工厂**自己那次调用的选项字面量里；
   *   3. `<ctx>` 只能作为**成员访问的基**出现，不能整个被传出去或 return 掉。
   *
   * 任何把 logger 先过一手函数的写法都不满足「节点形状」，因此拿不到放行。
   */
  /** 一个调用是否就是 `log-events.ts` 真实导出的 `createLoggingContext`。 */
  const isContextFactoryCall = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    resolvesToExport(
      checker,
      node.expression,
      facadeModule,
      "createLoggingContext",
    );

  /**
   * 一个调用是否就是 **fastify 自己的** 工厂。
   *
   * 判据同样是**声明身份**：callee 解析出来的符号（穿过 import alias）必须叫
   * `fastify`，而且它的声明必须落在 fastify 包自己的 `fastify.d.ts` 里。一个自造的
   * 同名工厂、或者任何「返回值恰好长得像 FastifyInstance」的函数都对不上。
   */
  const fastifyEntry = program
    .getSourceFiles()
    .map((file) => file.fileName)
    .find((name) => name.endsWith("/node_modules/fastify/fastify.d.ts"));
  if (fastifyEntry === undefined) {
    // fail closed：认不出框架工厂就不该退化成「什么调用都放行」。
    throw new Error(
      "the capability gate needs fastify's own declaration file to identify the framework factory",
    );
  }
  const isFrameworkFactoryCall = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    resolvesToExport(checker, node.expression, fastifyEntry, "fastify");

  /**
   * 一个表达式是否**就是** `createLoggingContext` 这个符号本身。
   *
   * 工厂本身也是能力：拿到它就能凭空造出一个 `LoggingContext`，`.framework` 也就
   * 跟着到手了。因此它只允许出现在组装根**那一次**合法的工厂调用的 callee 位置；
   * 取别名（`const build = createLoggingContext`）或者交给别人
   * （`relay(createLoggingContext)`）一律报红。
   */
  const isFactoryReference = (node: ts.Node, module: string, name: string): boolean =>
    (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
    resolvesToExport(checker, node as ts.Expression, module, name);

  const isContextFactoryReference = (node: ts.Node): boolean =>
    isFactoryReference(node, facadeModule, "createLoggingContext");

  /**
   * `logging.ts` 的 root 工厂。它**直接返回一个 raw `Logger`**，能力严格强于
   * `createLoggingContext`，因此在两个边界文件之外**一处都不许出现**——连做 callee
   * 都不行。
   */
  const isRootLoggerFactoryReference = (node: ts.Node): boolean =>
    isFactoryReference(node, loggingModule, "createLogger");

  /**
   * 组装根里由**工厂 initializer** 声明出来的那些 context 变量的**真实符号**。
   *
   * 白名单绑的是符号身份，不是成员文本：`logging.framework` 之所以放行，是因为
   * `logging` 这个标识符解析到的符号确实来自一条
   * `const … = createLoggingContext(…)` 的声明——换个同名变量、或者先过一手中继
   * 函数，都对不上。
   */
  const contextSymbols = new Set<ts.Symbol>();
  /**
   * 组装根用**框架自己的工厂**建出来的容器符号：`const app = Fastify(…)`。
   *
   * 它和 `contextSymbols` 分开，因为两者的允许面**不一样**：`buildApp` 的契约就是
   * 把 `app` return 出去，门禁改不掉；而 `LoggingContext` 一旦整个离开组装根，
   * `.framework` 也就跟着出去了，所以它只允许作为**成员访问的基**出现。
   *
   * 无论哪一类，从容器身上取出来的 logger 成员都照样逐个判定：`app.log` 或
   * 白名单之外位置上的 `logging.framework` 仍然会被报出来。
   */
  const frameworkHeldSymbols = new Set<ts.Symbol>();
  const collectContextSymbols = (file: ts.SourceFile): void => {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol !== undefined) {
          if (isContextFactoryCall(node.initializer)) {
            contextSymbols.add(symbol);
          } else if (isFrameworkFactoryCall(node.initializer)) {
            // 组装根用**框架自己的**工厂建出来的容器（`Fastify(…)` 返回的
            // `FastifyInstance`）。绑的是**这条声明的符号**加上**它的 factory
            // initializer 的声明身份**——不是名字，也不是类型文本。
            //
            // 上一版这里写的是 `ts.isCallExpression(node.initializer)`：**任何**
            // 调用的返回值都被当成「组装根持有的容器」。那等于说
            // `const held = externalRelay(logging)` 之后 `held` 随便怎么用都放行
            // ——一个中继函数就能把整个 context 带出边界（实测假绿）。
            frameworkHeldSymbols.add(symbol);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  };

  /** 登记组装根入口函数（`buildApp` / fixture 里指定的那一个）的首参符号。 */
  const collectEntryOptions = (file: ts.SourceFile): void => {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === compositionEntryName &&
        node.initializer !== undefined &&
        ts.isFunctionLike(node.initializer)
      ) {
        const parameter = node.initializer.parameters[0];
        const symbol =
          parameter === undefined
            ? undefined
            : checker.getSymbolAtLocation(parameter.name);
        if (symbol !== undefined) {
          optionsSymbols.add(symbol);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  };

  /** `<ctx>.framework`，且 `<ctx>` 必须解析到上面收集到的那些符号之一。 */
  const isContextMemberAccess = (node: ts.Node, member: string): boolean => {
    if (
      !ts.isPropertyAccessExpression(node) ||
      node.name.text !== member ||
      !ts.isIdentifier(node.expression)
    ) {
      return false;
    }
    const symbol = checker.getSymbolAtLocation(node.expression);
    return symbol !== undefined && contextSymbols.has(symbol);
  };

  /**
   * 组装根函数自己的形参，且**只能作为成员访问的基**出现。
   *
   * 上一版是无条件放行「任何解析到形参的标识符」。那不是一个位置判据，是一张
   * 通行证：`(logger: Logger): Logger => logger` 这种直通函数整条都是绿的，
   * 因为 `logger` 也是一个形参。现在只认 `options.logger` 这种**取一个字段**的
   * 写法；`options` 本身被传出去、装进容器或者 return 掉，都不在此列。
   */
  const isCompositionInputMember = (node: ts.Node, parent: ts.Node): boolean => {
    if (
      !ts.isIdentifier(node) ||
      !ts.isPropertyAccessExpression(parent) ||
      parent.expression !== node
    ) {
      return false;
    }
    const symbol = checker.getSymbolAtLocation(node);
    return (symbol?.getDeclarations() ?? []).some(
      (declaration) =>
        ts.isParameter(declaration) &&
        declaration.parent !== undefined &&
        ts.isFunctionLike(declaration.parent),
    );
  };

  /** 一个标识符是否解析到某个已登记的组装根符号。 */
  const resolvesToHeld = (
    node: ts.Node,
    held: ReadonlySet<ts.Symbol>,
  ): boolean => {
    if (!ts.isIdentifier(node)) {
      return false;
    }
    const symbol = checker.getSymbolAtLocation(node);
    return symbol !== undefined && held.has(symbol);
  };

  /** `Object.defineProperty(…)`：按 TypeScript lib 里那条声明的身份认。 */
  const isObjectDefinePropertyCall = (node: ts.Node): node is ts.CallExpression => {
    if (!ts.isCallExpression(node)) {
      return false;
    }
    let symbol = checker.getSymbolAtLocation(node.expression);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    if (symbol?.getName() !== "defineProperty") {
      return false;
    }
    return (symbol.getDeclarations() ?? []).some((declaration) =>
      /\/node_modules\/typescript\/lib\/lib\..*\.d\.ts$/.test(
        declaration.getSourceFile().fileName,
      ),
    );
  };

  /** 传给**框架工厂**的选项对象字面量（`Fastify({ … })` 的那个）。 */
  const isFrameworkOptionsLiteral = (node: ts.Node): boolean =>
    ts.isObjectLiteralExpression(node) &&
    node.parent !== undefined &&
    isFrameworkFactoryCall(node.parent) &&
    node.parent.arguments.includes(node);

  /**
   * 组装根里被放行的**精确节点**。
   *
   * 每一条都同时钉住「是什么」与「在哪」。收尾修订前有三条是按「形状」放行的，
   * 叠加起来就是一条完整的能力出口（实测假绿）：
   *
   *   - 「结果被丢弃的调用」放行**任何** callee，于是
   *     `frameworkFactory({ loggerInstance: logging.framework });` 整条语句全绿；
   *   - 「传给调用的选项对象字面量」放行**任何**调用的实参字面量；
   *   - 「`loggerInstance:`」从不检查外层调用是不是框架工厂，于是
   *     `app.register(plugin, { loggerInstance: logging.framework })` 也全绿。
   *
   * 现在：丢弃规则只认「callee 是**框架容器**上的成员访问」或
   * `Object.defineProperty(<框架容器>, …)`；选项字面量与 `loggerInstance:` 都必须
   * 落在**框架工厂自己**那次调用上。
   */
  /**
   * 组装根入口函数**自己的 options 对象**上的一个字段。
   *
   * 光是「基是某个形参」不够：多加一个形参就能绕过去
   * （`(options, foreign: { logger: Logger }) => …`）。「任何 FunctionLike 的第一个
   * 形参」同样不够——随手写一个 helper，它自己的首参就成了合法注入源。
   *
   * 判据是**声明身份**：必须解析到 `optionsSymbols` 里那个符号，也就是组装根入口
   * 函数（生产里的 `buildApp`）第一个形参的那条声明。
   */
  const isCompositionOptionsMember = (node: ts.Node, parent: ts.Node): boolean => {
    if (
      !ts.isIdentifier(node) ||
      !ts.isPropertyAccessExpression(parent) ||
      parent.expression !== node
    ) {
      return false;
    }
    const symbol = checker.getSymbolAtLocation(node);
    return symbol !== undefined && optionsSymbols.has(symbol);
  };

  const isAllowedAppNode = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (parent === undefined) {
      return false;
    }
    if (isCompositionInputMember(node, parent)) {
      return true;
    }
    // 1. 框架实例本身。组装根建它、配它、最后把它 return 出去——那就是 buildApp 的
    //    契约，门禁改不掉，也不该假装改得掉。
    if (resolvesToHeld(node, frameworkHeldSymbols)) {
      return true;
    }
    // 2. `LoggingContext` 只能作为**成员访问的基**出现：`logging.framework` /
    //    `logging.eventLog` / `logging.close()`。把 `logging` 本身传出去、装进容器
    //    或者 return 掉，都不在此列。
    if (
      resolvesToHeld(node, contextSymbols) &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node
    ) {
      return true;
    }
    // 3. 两个真实工厂的调用，且必须**就是**它们那条变量声明的 initializer。
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isIdentifier(parent.name) &&
      (isContextFactoryCall(node) || isFrameworkFactoryCall(node))
    ) {
      const symbol = checker.getSymbolAtLocation(parent.name);
      if (
        symbol !== undefined &&
        (contextSymbols.has(symbol) || frameworkHeldSymbols.has(symbol))
      ) {
        return true;
      }
    }
    // 4. 结果被**丢弃**的框架调用：`app.register(…)` / `app.decorate(…)` /
    //    `Object.defineProperty(app, …)`。callee 必须落在框架容器上——值没有去处
    //    不等于能力没出去，能力可以顺着**实参**走。
    if (ts.isCallExpression(node)) {
      let cursor: ts.Node = node;
      while (
        cursor.parent !== undefined &&
        ts.isAwaitExpression(cursor.parent)
      ) {
        cursor = cursor.parent;
      }
      const discarded =
        cursor.parent !== undefined && ts.isExpressionStatement(cursor.parent);
      const onFrameworkInstance =
        (ts.isPropertyAccessExpression(node.expression) &&
          resolvesToHeld(node.expression.expression, frameworkHeldSymbols)) ||
        (isObjectDefinePropertyCall(node) &&
          node.arguments[0] !== undefined &&
          resolvesToHeld(node.arguments[0], frameworkHeldSymbols));
      if (discarded && onFrameworkInstance) {
        return true;
      }
    }
    // 5. 交给**框架工厂**的选项对象字面量：里面的 `loggerInstance` 另有精确白名单。
    if (isFrameworkOptionsLiteral(node)) {
      return true;
    }
    // 6. `createLoggingContext(level, <options.logger>, …)` 的第 1 个实参，且这个
    //    成员访问的**基**必须是组装根自己的形参。
    //
    //    上一版只判 `isPropertyAccessExpression`，从不看基是什么。于是
    //    `createLoggingContext(level, app.log)` 与
    //    `createLoggingContext(level, foreign.logger)` 在这个位置上整条无报告——
    //    任何来源的 `X.logger` 都能无声进入 `LoggingContext.framework`。
    //    「基是某个形参」也不够：多加一个形参就绕过去了，所以钉的是组装根**自己的
    //    options 对象**。
    if (
      isContextFactoryCall(parent) &&
      parent.arguments[1] === node &&
      ts.isPropertyAccessExpression(node) &&
      isCompositionOptionsMember(node.expression, node)
    ) {
      return true;
    }
    // 7. `loggerInstance: <ctx>.framework`，且这个属性必须写在**框架工厂**的选项
    //    字面量里——插件选项、自造工厂的选项都不算。
    if (
      ts.isPropertyAssignment(parent) &&
      ts.isIdentifier(parent.name) &&
      parent.name.text === "loggerInstance" &&
      parent.initializer === node &&
      isContextMemberAccess(node, "framework") &&
      parent.parent !== undefined &&
      isFrameworkOptionsLiteral(parent.parent)
    ) {
      return true;
    }
    return false;
  };

  // 直接判据用的声明集合：logger 接口本身、`LogFn`，**以及每一个 mutation 成员
  // 的声明**。最后这一项是 `Logger["setBindings"]` 这种 indexed access 的落点——
  // 接口把它重声明成自己的字段（`readonly mutate: Logger["setBindings"]`）之后，
  // 成员名已经不叫 setBindings 了，但那个字段的**类型符号**仍然指回 pino 里
  // `setBindings` 的那条声明。
  const capabilityDeclarations = new Set([
    ...declarations.logger,
    ...declarations.logFunction,
    ...declarations.mutationMembers,
  ]);

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(withinPath)) {
      continue;
    }
    const isBoundary =
      file.fileName === facadeModule || file.fileName === loggingModule;
    const isCompositionRoot = file.fileName === compositionRoot;
    if (isCompositionRoot) {
      collectContextSymbols(file);
      collectEntryOptions(file);
    }

    const record = (node: ts.Node, kind: string): void => {
      const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const text = node.getText().replace(/\s+/g, " ").slice(0, 80);
      found.set(`${file.fileName}:${String(line)}:${text}`, {
        file: file.fileName,
        line,
        text: `${kind} ${text}`,
      });
    };

    const visit = (node: ts.Node): void => {
      const isTypePosition =
        ts.isTypeNode(node) ||
        (node.parent !== undefined &&
          (ts.isTypeReferenceNode(node.parent) ||
            // `typeof X`：纯类型层面的引用，不是一次运行期取用。
            ts.isTypeQueryNode(node.parent) ||
            ts.isImportSpecifier(node.parent) ||
            ts.isImportClause(node.parent)));
      // 声明处的**名字**不是表达式位置：`readonly logger?: Logger` 里的
      // `logger`、`const logger = …` 里的 `logger`、参数名、解构名，都不算一次
      // 能力取用。
      const isTypeDeclarationName =
        node.parent !== undefined &&
        (ts.isInterfaceDeclaration(node.parent) ||
          ts.isTypeAliasDeclaration(node.parent) ||
          ts.isModuleDeclaration(node.parent) ||
          ts.isClassDeclaration(node.parent)) &&
        (node.parent as { name?: ts.Node }).name === node;
      const isDeclarationName =
        isTypeDeclarationName ||
        (node.parent !== undefined &&
        ((ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node) ||
          ((ts.isPropertySignature(node.parent) ||
            ts.isPropertyDeclaration(node.parent) ||
            ts.isParameter(node.parent) ||
            ts.isVariableDeclaration(node.parent) ||
            ts.isBindingElement(node.parent) ||
            ts.isPropertyAssignment(node.parent) ||
            ts.isMethodSignature(node.parent) ||
            ts.isMethodDeclaration(node.parent)) &&
            node.parent.name === node)));

      if (
        ts.isExpression(node) &&
        !isTypePosition &&
        !isDeclarationName &&
        !ts.isStringLiteralLike(node)
      ) {
        // 工厂符号本身即能力：只有组装根**那一次**合法工厂调用的 callee 位置放行。
        if (isContextFactoryReference(node)) {
          const asCallee =
            node.parent !== undefined &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression === node &&
            isCompositionRoot &&
            isAllowedAppNode(node.parent);
          if (!isBoundary && !asCallee) {
            record(node, "[factory]");
          }
        } else if (isRootLoggerFactoryReference(node) && !isBoundary) {
          record(node, "[factory]");
        }
        const type = checker.getTypeAtLocation(node);
        if (typeResolvesTo(type, declarations.logFunction)) {
          if (!isBoundary) {
            record(node, "[LogFn]");
          }
        } else if (
          carriesCapability(
            checker,
            type,
            capabilityDeclarations,
            node,
          )
        ) {
          if (!isBoundary && !(isCompositionRoot && isAllowedAppNode(node))) {
            record(node, "[Logger]");
          }
        }
      }

      {
        const member = accessedMutationMember(
          checker,
          node,
          declarations.mutationMembers,
        );
        if (member !== undefined && !isBoundary) {
          record(node, "[mutation]");
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return [...found.values()];
};

/**
 * 第九轮的正则扫描器，**逐字保留**下来做对照。
 *
 * 保留它不是为了继续用，而是为了让「旧门禁在这些形状上是假绿的」变成一条会跑的
 * 断言，而不是一句说法。
 */
const roundNineRegexScanner = (source: string): readonly string[] => {
  const strip = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const firstArgument = (text: string, openIndex: number): string => {
    let depth = 0;
    for (let index = openIndex; index < text.length; index += 1) {
      const character = text[index] as string;
      if ("([{".includes(character)) {
        depth += 1;
        continue;
      }
      if (")]}".includes(character)) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(openIndex + 1, index);
        }
        continue;
      }
      if (character === "," && depth === 1) {
        return text.slice(openIndex + 1, index);
      }
    }
    return text.slice(openIndex + 1);
  };
  const forbidden = [
    /\brequest\b/,
    /\breply\b/,
    /\braw\b/,
    /\berror\b/,
    /\berr\s*:/,
    /\bconfig\b/,
    /\bsecret\b/i,
    /\bpassword\b/i,
    /\btoken\b/i,
  ];
  const violations: string[] = [];
  const stripped = strip(source);
  const pattern = /\blog\.(?:trace|debug|info|warn|error|fatal)\s*\(/g;
  let match = pattern.exec(stripped);
  while (match !== null) {
    const argument = firstArgument(
      stripped,
      match.index + match[0].length - 1,
    ).trim();
    if (forbidden.some((rule) => rule.test(argument))) {
      violations.push(argument);
    }
    match = pattern.exec(stripped);
  }
  return violations;
};

test("the logger capability never leaves the logging boundary in src", () => {
  const program = buildProgram([]);
  const violations = collectCapabilityUses(program, sourceRoot).map(
    (use) =>
      `${relative(packageRoot, use.file)}:${String(use.line)} -> ${use.text}`,
  );
  assert.deepEqual(
    violations,
    [],
    "the logger capability escaped the boundary:\n" + violations.join("\n"),
  );

  // 正向断言：收集器必须真的能在**别处**认出能力，否则「没有违规」也可能只是
  // 类型解析失败、一个点都没识别出来。用 fixture 当探针。
  const probe = buildProgram([escapeFixture]);
  assert.ok(
    collectCapabilityUses(probe, escapeFixture).length > 0,
    "the collector must be able to resolve logger capability at all",
  );
});

test("the capability gate catches every escape shape, by declaration identity", () => {
  const program = buildProgram([escapeFixture]);
  const uses = collectCapabilityUses(program, escapeFixture);
  const lines = uses.map((use) => use.text);

  // 断言的是**每一种写法都被覆盖到**，不是一个总数——总数会随 fixture 的无关改动
  // 漂移，覆盖面不会。
  for (const [shape, marker] of [
    ["1 method alias / bind", "[LogFn] logger.error.bind(logger)"],
    ["1 method alias / call", "[LogFn] emit"],
    ["2 renamed logger", "[LogFn] audit.error"],
    ["3 element access", '[LogFn] logger["error"]'],
    ["4 optional chain", "[LogFn] logger?.warn"],
    ["5 printf argument", "[LogFn] logger.info"],
    ["6 const index alias", "[LogFn] logger[level]"],
    ["7 Reflect.apply", "[LogFn] logger.error"],
    ["8 higher-order forward", "[LogFn] logger.warn"],
    ["9 type erasure", "[LogFn] logger.fatal"],
    ["10 child mutation", "[mutation] logger.child"],
    ["11 setBindings mutation", "[mutation] logger.setBindings"],
    ["12 generic parameter", "[Logger] l"],
    ["13 Pick<Logger, …>", "[LogFn] picked.warn"],
    ["14 computed access", "[LogFn] logger[key]"],
    ["15 locally shadowed factory", "[Logger] root"],
    ["17 Pick<Logger, 'setBindings'>", "[mutation] picked.setBindings"],
    ["18 element-access mutation", '[mutation] logger["setBindings"]'],
    ["19 type-erased mutation", "[mutation] logger.setBindings"],
    ["20 mapped type member", "[Logger] mapped.setBindings"],
    ["21 interface re-declared member", "[Logger] relay.mutate"],
    ["22 destructured Pick", "[Logger] child"],
    ["23 level mutation", "[mutation] logger.level"],
  ] as const) {
    assert.ok(
      lines.includes(marker),
      `${shape}: expected \`${marker}\` among\n${lines.join("\n")}`,
    );
  }

  // 16 无关的同名 `LogFn`：**不得**误报。判据是声明身份，不是名字。
  //
  // fixture 最后声明了一个局部的 `type LogFn = (message: string) => void`，并用它
  // 标注一个参数。按名字匹配的判据会把那个参数也算成能力取用；按声明身份就不会。
  const fixtureSource = readFileSync(escapeFixture, "utf8").split("\n");
  const unrelatedFrom =
    fixtureSource.findIndex((line) =>
      line.startsWith("type LogFn = (message: string)"),
    ) + 1;
  assert.ok(unrelatedFrom > 1, "the unrelated LogFn declaration must exist");
  const inUnrelatedRegion = uses.filter((use) => use.line >= unrelatedFrom);
  assert.deepEqual(
    inUnrelatedRegion.map((use) => `${String(use.line)} ${use.text}`),
    [],
    "an unrelated locally declared LogFn must not be reported",
  );
});

test("the composition-root allowlist admits only the exact wiring nodes", () => {
  // 第十三轮的 app.ts 假绿是**手工改文件**验证的：改一版、跑一次、改回来。那种
  // 验证跑完就没了，下一轮没人知道它还成不成立。这里把每一种接线写法固定进
  // fixture，再把 fixture **当作组装根**喂给收集器——白名单于是有了回归。
  const program = buildProgram([wiringFixture]);
  // fixture 扮演组装根时，入口函数**明确指定**为 `allowedWiring`——只有它的首参
  // 是合法注入源，别的导出（包括 helper 自己的首参）都不是。
  const uses = collectCapabilityUses(
    program,
    wiringFixture,
    wiringFixture,
    "allowedWiring",
  );
  const source = readFileSync(wiringFixture, "utf8").split("\n");
  const lineOf = (name: string): number => {
    const index = source.findIndex((line) =>
      line.startsWith(`export const ${name} `),
    );
    assert.ok(index >= 0, `fixture must declare ${name}`);
    return index + 1;
  };
  const ends = source
    .map((line, index) => (line.startsWith("export const ") ? index + 1 : 0))
    .filter((line) => line > 0);
  /** 一个导出变体自己那一段里被报出来的用点。 */
  const within = (name: string): readonly string[] => {
    const from = lineOf(name);
    const to = ends.find((line) => line > from) ?? source.length + 1;
    return uses
      .filter((use) => use.line >= from && use.line < to)
      .map((use) => use.text);
  };

  // 合法：工厂调用、`options.injected` 作为第 1 个实参、
  // `loggerInstance: logging.framework`、以及组装根持有的容器本身——「持有」只认
  // `createLoggingContext` 与 **fastify 自己的**工厂这两个声明身份。
  assert.deepEqual(
    within("allowedWiring"),
    [],
    "the exact production wiring must not be reported",
  );

  // 违规：每一种都必须被报出来。这里断言的是**覆盖面**，不是总数。
  for (const name of [
    "violatingRelayedFramework",
    "violatingRelayedContext",
    "violatingAliasedFramework",
    "violatingDestructuredFramework",
    "violatingContainer",
    "violatingIndexedAccess",
    "violatingRawRoot",
    "violatingForeignFactoryHolder",
    "violatingForeignFrameworkHolder",
    "violatingDiscardedForeignCall",
    "violatingPluginOption",
    "violatingReturnedContextCall",
    "violatingReturnedContext",
    "violatingPassthrough",
    "violatingFactoryAlias",
    "violatingFactoryHandover",
    "violatingAppLogIntoFactory",
    "violatingForeignLoggerIntoFactory",
    "violatingRootFactoryAlias",
    "violatingRootFactoryHandover",
    "violatingFactoryProbe",
    "violatingNestedHelperInput",
  ]) {
    assert.ok(
      within(name).length > 0,
      `${name}: expected the capability gate to report it, got nothing`,
    );
  }
});

test("the round-9 regex scanner false-greens on the whole fixture", () => {
  assert.deepEqual(
    roundNineRegexScanner(readFileSync(escapeFixture, "utf8")),
    [],
    "the round-9 regex scanner is expected to false-green on these shapes",
  );
});
