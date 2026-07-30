import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

/**
 * 阶段 09A / M3A：业务代码**不得直接调用 logger** 的静态门禁。
 *
 * ## 为什么从「检查实参形状」改成「禁止直接调用」
 *
 * 第九轮的门禁是一条正则加一次源码文本切分：找 `\blog\.(info|warn|…)\s*\(`，再看
 * **第一个**实参里有没有裸的 `request`/`error`/`config`/…。它有一整类结构性漏网：
 * 别名、变量改名、元素访问、可选链，以及 printf 的后续参数——`tests/fixtures/
 * log-escape-shapes.ts` 把这六种写法逐条摆了出来，下面那条反向测试证明旧扫描器
 * 对它们**全部假绿**。
 *
 * 现在改成用 TypeScript 的 **type checker**：凡是调用一个类型为 pino `LogFn` 的
 * 表达式（无论怎么取到它），或者对它用 `call`/`apply`/`bind`，都算一次 logger
 * 调用。`src/` 里只有 `src/log-events.ts` 这一个 facade 允许出现这种调用；业务
 * 代码只能经由 `logEvent()` 记录**闭集事件 + 显式声明的原始类型字段**。
 *
 * 于是「原始 Error / Request / Reply / Config / Secret 不进业务日志」这件事由
 * **类型系统**保证，而不是靠出口处的净化器去追平任意输入。
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

/**
 * 允许持有 **LogFn 能力**的生产文件，只有两个，而且都**是 logger 边界本身**：
 *
 *   - `src/log-events.ts`：facade，业务代码的唯一入口；
 *   - `src/logging.ts`：中央边界自己。它的 `hooks.logMethod` 必须
 *     `method.apply(this, safe)` 把净化后的实参交给 pino——那正是这一层的职责。
 */
const logFunctionHolders = new Set([
  join(sourceRoot, "log-events.ts"),
  join(sourceRoot, "logging.ts"),
]);

/**
 * 允许**命名** Logger 的生产文件，比上面多一个组装根。
 *
 * `src/app.ts` 必须把 logger 交给 Fastify（`loggerInstance`），因此它会出现
 * Logger 类型的表达式。但它只能**传递**——一旦在 Logger 上做成员访问（无论是
 * `.info` 还是 `.child`），就说明它在用这项能力，那是违规。
 */
const loggerHolders = new Set([...logFunctionHolders, join(sourceRoot, "app.ts")]);

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

/** 某个类型（含 union / intersection 成员）里是否出现某个具名符号。 */
const typeMentions = (type: ts.Type, names: ReadonlySet<string>): boolean => {
  const seen = new Set<ts.Type>();
  const walk = (candidate: ts.Type): boolean => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    const symbol = candidate.aliasSymbol ?? candidate.getSymbol();
    if (symbol !== undefined && names.has(symbol.getName())) {
      return true;
    }
    if (candidate.isUnionOrIntersection()) {
      return candidate.types.some(walk);
    }
    return false;
  };
  return walk(type);
};

const logFunctionNames = new Set(["LogFn"]);
const loggerNames = new Set([
  "Logger",
  "BaseLogger",
  "FastifyBaseLogger",
  "pino",
]);

/** pino / Fastify logger 上会改变实例状态或派生新实例的成员。 */
const mutationMembers = new Set([
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
 * 收集一个 program 里所有的 **logger capability** 出现点。
 *
 * 第十轮只看 `CallExpression` 的 callee，因此 `Reflect.apply(logger.error, …)`、
 * 把 `LogFn` 当参数传出去的高阶转发、以及「先 `as unknown as` 擦掉类型再调用」
 * 全都溜过去了——那三种写法的 callee 分别是 `Reflect.apply`、形参 `emit` 与一个
 * 已经不是 `LogFn` 的函数类型。
 *
 * 这一轮改成看**能力本身**：任何**表达式**只要类型是 `LogFn`，或者类型是 Logger
 * 而它出现在不被允许的位置，就算一次 capability 取用。调用与否无关紧要——拿到了
 * 就是拿到了。
 */
const collectCapabilityUses = (
  program: ts.Program,
  withinPath: string,
): readonly LoggerCallSite[] => {
  const checker = program.getTypeChecker();
  const found = new Map<string, LoggerCallSite>();

  /** `logEvent(logger, …)` 的第 0 个实参是 Logger 唯一允许出现的业务位置。 */
  const isFacadeLoggerArgument = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (parent === undefined || !ts.isCallExpression(parent)) {
      return false;
    }
    if (parent.arguments[0] !== node) {
      return false;
    }
    const callee = parent.expression;
    const calleeText = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : callee.getText();
    return calleeText === "logEvent";
  };

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(withinPath)) {
      continue;
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
      // 只看表达式位置；类型标注、声明名、import 说明符都跳过。
      const isTypePosition =
        ts.isTypeNode(node) ||
        (node.parent !== undefined &&
          (ts.isTypeReferenceNode(node.parent) ||
            ts.isImportSpecifier(node.parent) ||
            ts.isImportClause(node.parent)));
      const isPropertyName =
        node.parent !== undefined &&
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node;

      if (
        ts.isExpression(node) &&
        !isTypePosition &&
        !isPropertyName &&
        !ts.isStringLiteralLike(node)
      ) {
        const type = checker.getTypeAtLocation(node);
        if (typeMentions(type, logFunctionNames)) {
          record(node, "[LogFn]");
        } else if (typeMentions(type, loggerNames)) {
          if (!isFacadeLoggerArgument(node)) {
            record(node, "[Logger]");
          }
        }
      }

      // mutation API：`<Logger>.child(…)` / `.setBindings(…)` 之类。
      if (
        ts.isPropertyAccessExpression(node) &&
        mutationMembers.has(node.name.text) &&
        typeMentions(checker.getTypeAtLocation(node.expression), loggerNames)
      ) {
        record(node, "[mutation]");
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
 * 它只找 `log.<level>(`，只看第一个实参的源码文本。保留它不是为了继续用，而是
 * 为了让「旧门禁在这些形状上是假绿的」变成一条会跑的断言，而不是一句说法。
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
  const uses = collectCapabilityUses(program, sourceRoot);

  // 正向断言：checker 必须真的解析出了边界文件里的那些取用，否则「没有违规」也
  // 可能只是类型解析失败、一个点都没识别出来。
  assert.ok(
    uses.length > 0,
    "the checker must resolve at least the boundary's own logger capability uses",
  );

  const violations = uses
    .filter((use) => {
      if (use.text.startsWith("[LogFn]")) {
        return !logFunctionHolders.has(use.file);
      }
      // Logger 与 mutation：组装根 app.ts 可以**命名** logger，但不能在它上面做
      // 任何成员访问；mutation 只有 logging.ts 自己可以做。
      if (use.text.startsWith("[mutation]")) {
        return use.file !== join(sourceRoot, "logging.ts");
      }
      return !loggerHolders.has(use.file);
    })
    .map(
      (use) =>
        `${relative(packageRoot, use.file)}:${String(use.line)} -> ${use.text}`,
    );
  assert.deepEqual(
    violations,
    [],
    "the logger capability escaped the boundary:\n" + violations.join("\n"),
  );

  // app.ts 只能**传递** logger：它里面不允许出现任何 LogFn 或 mutation。
  const appFile = join(sourceRoot, "app.ts");
  const appMisuse = uses
    .filter(
      (use) =>
        use.file === appFile &&
        (use.text.startsWith("[LogFn]") || use.text.startsWith("[mutation]")),
    )
    .map((use) => `app.ts:${String(use.line)} -> ${use.text}`);
  assert.deepEqual(
    appMisuse,
    [],
    "the composition root may only pass the logger along:\n" +
      appMisuse.join("\n"),
  );

  // LogFn 只出现在两个边界文件里，一个不多。
  assert.deepEqual(
    [
      ...new Set(
        uses
          .filter((use) => use.text.startsWith("[LogFn]"))
          .map((use) => relative(packageRoot, use.file)),
      ),
    ].sort(),
    ["src/log-events.ts", "src/logging.ts"],
  );
});

test("the AST gate catches every shape the round-9 regex scanner missed", () => {
  const program = buildProgram([escapeFixture]);
  const fixtureCalls = collectCapabilityUses(program, escapeFixture);
  const fixtureSource = readFileSync(escapeFixture, "utf8");

  // 旧门禁：一条都抓不到——别名、改名、元素访问、可选链、printf 后续参数，
  // 每一种都从 `\blog\.(…)\(` 底下走过去了。
  assert.deepEqual(
    roundNineRegexScanner(fixtureSource),
    [],
    "the round-9 regex scanner is expected to false-green on these shapes",
  );

  // 新门禁：六种全部抓到。
  const lines = fixtureCalls.map((call) => call.text);

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
  ] as const) {
    assert.ok(
      lines.includes(marker),
      `${shape}: expected \`${marker}\` among\n${lines.join("\n")}`,
    );
  }

  // 第十轮的门禁只看 CallExpression 的 callee，因此 7/8/9 三种写法它也抓不到：
  // callee 分别是 `Reflect.apply`、形参 `emit`、以及一个已经被擦成普通函数类型
  // 的表达式。这一条把「只看 callee 不够」也变成一条会跑的断言。
  const calleeOnly = fixtureCalls.filter((use) =>
    use.text.startsWith("[LogFn]"),
  );
  assert.ok(
    calleeOnly.some((use) => use.text === "[LogFn] logger.fatal"),
    "the capability gate must see a LogFn that is only ever type-erased",
  );
});

test("the round-9 regex scanner false-greens on the whole fixture", () => {
  // 旧门禁只找 `log.<level>(`，只看第一个实参。fixture 里十一种写法它一条都抓不到。
  assert.deepEqual(
    roundNineRegexScanner(readFileSync(escapeFixture, "utf8")),
    [],
    "the round-9 regex scanner is expected to false-green on these shapes",
  );
});
