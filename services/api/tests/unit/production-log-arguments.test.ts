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
        if (
          (pino && (name === "Logger" || name === "BaseLogger")) ||
          (fastify && name === "FastifyBaseLogger")
        ) {
          logger.add(node);
        }
      }
      // mutation 成员的声明可能挂在 interface 上，也可能挂在类型别名的类型字面量
      // 里（pino 的 `Logger` 就是 `BaseLogger & {…}`）。因此在 pino/fastify 自己的
      // `.d.ts` 里**凡是**同名的成员声明都收下——身份仍然来自它们自己的声明节点，
      // 不是名字匹配。
      if (
        (ts.isPropertySignature(node) || ts.isMethodSignature(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name) &&
        mutationMemberNames.has(node.name.text)
      ) {
        mutationMembers.add(node);
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
 * `Pick<Logger, "warn">` 之类的结构类型：符号已经不是 Logger 的声明了，但它的成员
 * 仍然是 pino 的 `LogFn`。逐个成员看一眼就能认出来。
 */
const exposesLogFunction = (
  checker: ts.TypeChecker,
  type: ts.Type,
  declarations: ReadonlySet<ts.Declaration>,
  node: ts.Node,
): boolean =>
  type
    .getProperties()
    .some((property) =>
      typeResolvesTo(
        checker.getTypeOfSymbolAtLocation(property, node),
        declarations,
      ),
    );

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
): readonly LoggerCallSite[] => {
  const checker = program.getTypeChecker();
  const declarations = resolveCapabilityDeclarations(program);
  const facadeModule = join(sourceRoot, "log-events.ts");
  const loggingModule = join(sourceRoot, "logging.ts");
  const compositionRoot = join(sourceRoot, "app.ts");
  const found = new Map<string, LoggerCallSite>();

  /**
   * app.ts 的白名单：**精确节点 + 精确参数位置**，不按祖先子树放行。
   *
   * 上一版是往上走祖先链，只要撞到 `loggerInstance:` 或 `createEventLogSink(...)`
   * 就放行。那等于放行了整棵子树——`loggerInstance: externalRelay(logger)` 与
   * `createEventLogSink(externalRelay(logger))` 都能溜过去（实测两条都假绿）。
   *
   * 现在只认三个**确切的**位置，而且节点形状也钉死：
   *
   *   1. `createLoggingContext(level, <node>)` 的第 1 个实参，且 `<node>` 必须是
   *      一个成员访问（`options.logger`）；
   *   2. `loggerInstance: <node>`，且 `<node>` 必须是 `<ctx>.framework`；
   *   3. `createEventLogSink(<node>)` 的第 0 个实参，且 `<node>` 必须是
   *      `<ctx>.events`。
   *
   * 任何把 logger 先过一手函数的写法都不满足「节点形状」，因此拿不到放行。
   */
  const isContextMember = (node: ts.Node, member: string): boolean =>
    ts.isPropertyAccessExpression(node) && node.name.text === member;

  const isAllowedAppNode = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (parent === undefined) {
      return false;
    }
    if (
      ts.isCallExpression(parent) &&
      parent.arguments[1] === node &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "logger" &&
      resolvesToExport(
        checker,
        parent.expression,
        loggingModule,
        "createLoggingContext",
      )
    ) {
      return true;
    }
    if (
      ts.isPropertyAssignment(parent) &&
      ts.isIdentifier(parent.name) &&
      parent.name.text === "loggerInstance" &&
      parent.initializer === node &&
      isContextMember(node, "framework")
    ) {
      return true;
    }
    if (
      ts.isCallExpression(parent) &&
      parent.arguments[0] === node &&
      isContextMember(node, "events") &&
      resolvesToExport(
        checker,
        parent.expression,
        facadeModule,
        "createEventLogSink",
      )
    ) {
      return true;
    }
    return false;
  };

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(withinPath)) {
      continue;
    }
    const isBoundary =
      file.fileName === facadeModule || file.fileName === loggingModule;
    const isCompositionRoot = file.fileName === compositionRoot;

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
            ts.isImportSpecifier(node.parent) ||
            ts.isImportClause(node.parent)));
      // 声明处的**名字**不是表达式位置：`readonly logger?: Logger` 里的
      // `logger`、`const logger = …` 里的 `logger`、参数名、解构名，都不算一次
      // 能力取用。
      const isDeclarationName =
        node.parent !== undefined &&
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
            node.parent.name === node));

      if (
        ts.isExpression(node) &&
        !isTypePosition &&
        !isDeclarationName &&
        !ts.isStringLiteralLike(node)
      ) {
        const type = checker.getTypeAtLocation(node);
        if (typeResolvesTo(type, declarations.logFunction)) {
          if (!isBoundary) {
            record(node, "[LogFn]");
          }
        } else if (
          typeResolvesTo(type, declarations.logger) ||
          exposesLogFunction(checker, type, declarations.logFunction, node)
        ) {
          if (!isBoundary && !(isCompositionRoot && isAllowedAppNode(node))) {
            record(node, "[Logger]");
          }
        }
      }

      if (file.fileName !== loggingModule) {
        const member = accessedMutationMember(
          checker,
          node,
          declarations.mutationMembers,
        );
        if (member !== undefined) {
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

test("the round-9 regex scanner false-greens on the whole fixture", () => {
  assert.deepEqual(
    roundNineRegexScanner(readFileSync(escapeFixture, "utf8")),
    [],
    "the round-9 regex scanner is expected to false-green on these shapes",
  );
});
