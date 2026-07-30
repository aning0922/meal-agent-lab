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
 * 允许直接调用 logger 的生产文件，只有两个，而且都**是 logger 边界本身**：
 *
 *   - `src/log-events.ts`：facade，业务代码的唯一入口；
 *   - `src/logging.ts`：中央边界自己。它的 `hooks.logMethod` 必须
 *     `method.apply(this, safe)` 把净化后的实参交给 pino——那正是这一层的职责。
 *
 * 其余任何 `src/` 文件出现 logger 调用都是违规。
 */
const allowedDirectCallers = new Set([
  join(sourceRoot, "log-events.ts"),
  join(sourceRoot, "logging.ts"),
]);

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

/** 某个类型（含 union 成员）是否就是 pino 的 `LogFn`。 */
const isLogFunctionType = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  const seen = new Set<ts.Type>();
  const walk = (candidate: ts.Type): boolean => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    const symbol = candidate.aliasSymbol ?? candidate.getSymbol();
    if (symbol !== undefined && symbol.getName() === "LogFn") {
      return true;
    }
    if (candidate.isUnionOrIntersection()) {
      return candidate.types.some(walk);
    }
    return false;
  };
  void checker;
  return walk(type);
};

/**
 * 收集一个 program 里所有的 logger 调用点。
 *
 * 两种形态：
 *   1. 直接调用一个 `LogFn`——`logger.info(…)`、`logger["error"](…)`、
 *      `logger?.warn?.(…)`、`const emit = logger.error; emit(…)`；
 *   2. 对一个 `LogFn` 用 `call`/`apply`/`bind`——那是绕开第一条的标准写法。
 */
const collectLoggerCalls = (
  program: ts.Program,
  withinDirectory: string,
): readonly LoggerCallSite[] => {
  const checker = program.getTypeChecker();
  const found: LoggerCallSite[] = [];

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(withinDirectory)) {
      continue;
    }
    const record = (node: ts.Node, callee: ts.Node): void => {
      found.push({
        file: file.fileName,
        line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        text: callee.getText().replace(/\s+/g, " ").slice(0, 80),
      });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (isLogFunctionType(checker, checker.getTypeAtLocation(callee))) {
          record(node, callee);
        } else if (
          (ts.isPropertyAccessExpression(callee) ||
            ts.isElementAccessExpression(callee)) &&
          ["call", "apply", "bind"].includes(
            ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : String(
                  ts.isStringLiteralLike(callee.argumentExpression)
                    ? callee.argumentExpression.text
                    : "",
                ),
          ) &&
          isLogFunctionType(
            checker,
            checker.getTypeAtLocation(callee.expression),
          )
        ) {
          record(node, callee);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
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

test("only the logging facade may call a logger directly in src", () => {
  const program = buildProgram([]);
  const calls = collectLoggerCalls(program, sourceRoot);

  // 正向断言：扫描器必须真的看见了 facade 里那次调用，否则「没有违规」也可能只是
  // 类型解析失败、一个调用点都没识别出来。
  assert.ok(
    calls.length > 0,
    "the checker must resolve at least the facade's own logger call",
  );

  const violations = calls
    .filter((call) => !allowedDirectCallers.has(call.file))
    .map(
      (call) =>
        `${relative(packageRoot, call.file)}:${String(call.line)} -> ${call.text}`,
    );
  assert.deepEqual(
    violations,
    [],
    "business code must go through logEvent(); direct logger calls found:\n" +
      violations.join("\n"),
  );

  // 只有那两个边界文件里有调用，一个不多。
  assert.deepEqual(
    [
      ...new Set(calls.map((call) => relative(packageRoot, call.file))),
    ].sort(),
    ["src/log-events.ts", "src/logging.ts"],
  );
});

test("the AST gate catches every shape the round-9 regex scanner missed", () => {
  const program = buildProgram([escapeFixture]);
  const fixtureCalls = collectLoggerCalls(program, escapeFixture);
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
  // 七处：六种写法，其中「别名」那一种同时被 `.bind` 与随后的裸调用各抓一次。
  assert.equal(
    fixtureCalls.length,
    7,
    `the AST gate must catch every escape shape, got ${String(
      fixtureCalls.length,
    )}:\n${lines.join("\n")}`,
  );
  for (const [shape, expected] of [
    ["method alias / bind", "logger.error.bind"],
    ["method alias / call", "emit"],
    ["renamed logger", "audit.error"],
    ["element access", 'logger["error"]'],
    ["optional chain", "logger?.warn"],
    ["printf argument", "logger.info"],
    ["const index alias + call", "emit.call"],
  ] as const) {
    assert.ok(
      lines.some((text) => text.startsWith(expected)),
      `${shape}: expected a call site starting with \`${expected}\`, got\n${lines.join("\n")}`,
    );
  }
});

test("the facade only accepts declared events with primitive fields", async () => {
  const { logEvent } = await import("../../src/log-events.js");
  const emitted: { level: string; payload: unknown; message: unknown }[] = [];
  const fakeLogger = Object.fromEntries(
    (["debug", "info", "warn", "error", "fatal"] as const).map((level) => [
      level,
      (payload: unknown, message: unknown) => {
        emitted.push({ level, payload, message });
      },
    ]),
  ) as unknown as Parameters<typeof logEvent>[0];

  logEvent(fakeLogger, "request.rejected", {
    errorCode: "VALIDATION_FAILED",
    statusCode: 422,
  });
  logEvent(fakeLogger, "shutdown.timed-out", {});

  assert.deepEqual(emitted, [
    {
      level: "warn",
      payload: {
        event: "request.rejected",
        errorCode: "VALIDATION_FAILED",
        statusCode: 422,
      },
      message: "request rejected",
    },
    {
      level: "fatal",
      payload: { event: "shutdown.timed-out" },
      message: "graceful shutdown timed out",
    },
  ]);

  // 运行期兜底：即使有人用 `as` 绕过类型，非原始类型的字段也进不了 payload。
  const smuggled = {
    errorCode: "X",
    statusCode: 500,
    leaked: { password: "SMUGGLED-SENTINEL" },
  } as unknown as Parameters<typeof logEvent<"request.rejected">>[2];
  emitted.length = 0;
  logEvent(fakeLogger, "request.rejected", smuggled);
  assert.deepEqual(emitted[0]?.payload, {
    event: "request.rejected",
    errorCode: "X",
    statusCode: 500,
  });
});
