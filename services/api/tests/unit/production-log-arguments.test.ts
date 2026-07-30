import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 阶段 09A / M3A：生产代码**不得把原始对象塞进 log record**的静态门禁。
 *
 * 边界收窄的方向是：logger 不再充当「任意对象 / Proxy 净化器」。只要生产代码写
 * `log.error({ err: error }, …)`、`log.info({ req: request }, …)`、
 * `log.info({ config }, …)` 这类调用，安全性就整条压在 logger 那一层的净化器上——
 * 而那一层已经被反复证明是补不完的（原型污染、有状态 Proxy、装箱字符串、继承
 * 访问器……每一轮都能再找出一个）。
 *
 * 因此规则改成在**调用点**就交出纯数据：
 *
 *   - Error → `safeErrorRecord(error)`（调用点折成 `{ err: { type, message } }`）；
 *   - Request/Reply → 字段在 Fastify 可信边界读完、经 `registerRequestLogFields`
 *     物化，日志里只出现 `req`/`res` 这两个由固定 serializer 投影的键；
 *   - 配置与 Secret → 根本不进日志。
 *
 * 这条扫描只覆盖 `src/`。测试代码故意构造恶意输入，正是它们该做的事。
 */

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

const typescriptFilesUnder = (directory: string): readonly string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...typescriptFilesUnder(path));
      continue;
    }
    if (entry.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
};

/** 去掉注释与字符串字面量，避免在文档与错误文案上误报。 */
const strip = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");

const logCallPattern = /\blog\.(?:trace|debug|info|warn|error|fatal)\s*\(/g;

/** 从 `(` 之后按括号配平取出第一个实参的源码文本。 */
const firstArgument = (source: string, openIndex: number): string => {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index] as string;
    if ("([{".includes(character)) {
      depth += 1;
      continue;
    }
    if (")]}".includes(character)) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex + 1, index);
      }
      continue;
    }
    if (character === "," && depth === 1) {
      return source.slice(openIndex + 1, index);
    }
  }
  return source.slice(openIndex + 1);
};

/**
 * 禁止出现在 log record 第一个实参里的标识符。
 *
 * 匹配的是**裸标识符**，因此 `safeErrorRecord(error)` 这种包装写法不会被误伤：
 * 它整体是一个调用表达式，下面的检查会先把已知的安全包装剥掉。
 */
const forbidden = [
  { pattern: /\brequest\b/, why: "raw Fastify Request" },
  { pattern: /\breply\b/, why: "raw Fastify Reply" },
  { pattern: /\braw\b/, why: "raw Node request/response" },
  { pattern: /\berror\b/, why: "raw Error" },
  { pattern: /\berr\s*:/, why: "raw Error under an err key" },
  { pattern: /\bconfig\b/, why: "configuration object" },
  { pattern: /\bsecret\b/i, why: "secret material" },
  { pattern: /\bpassword\b/i, why: "secret material" },
  { pattern: /\btoken\b/i, why: "secret material" },
] as const;

/** 调用点允许的安全包装：它们在这里就把取值折成纯数据。 */
const safeWrappers = /\bsafeErrorRecord\s*\([^)]*\)/g;

test("production code never puts a raw object into a log record", () => {
  const files = typescriptFilesUnder(sourceRoot);
  assert.ok(files.length > 10, "the source scan must actually find files");

  const violations: string[] = [];
  let scannedCalls = 0;

  for (const file of files) {
    const source = strip(readFileSync(file, "utf8"));
    const scoped = new RegExp(logCallPattern.source, logCallPattern.flags);
    let match = scoped.exec(source);
    while (match !== null) {
      scannedCalls += 1;
      const argument = firstArgument(source, match.index + match[0].length - 1)
        .replace(safeWrappers, "")
        .trim();
      for (const rule of forbidden) {
        if (rule.pattern.test(argument)) {
          violations.push(
            `${file.slice(sourceRoot.length)}: ${rule.why} in \`${argument}\``,
          );
        }
      }
      match = scoped.exec(source);
    }
  }

  // 正向断言：扫描器必须真的看见了生产代码里的 log 调用，否则「没有违规」也可能
  // 只是正则从来没匹配到任何东西。
  assert.ok(
    scannedCalls >= 3,
    `expected the scan to find production log calls, found ${String(scannedCalls)}`,
  );
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("the scanner really catches the shapes it is meant to catch", () => {
  // 扫描器自检：把几条**故意违规**的写法喂给同一套逻辑，必须全部被抓到。
  const probes = [
    "request.log.error({ err: error }, 'x');",
    "app.log.info({ req: request }, 'x');",
    "app.log.info({ config }, 'x');",
    "app.log.warn({ password: value }, 'x');",
    "app.log.debug({ raw: reply.raw }, 'x');",
  ];
  for (const probe of probes) {
    const source = strip(probe);
    const scoped = new RegExp(logCallPattern.source, logCallPattern.flags);
    const match = scoped.exec(source);
    assert.ok(match, `the scanner must see the call in ${probe}`);
    const argument = firstArgument(source, match.index + match[0].length - 1)
      .replace(safeWrappers, "")
      .trim();
    assert.ok(
      forbidden.some((rule) => rule.pattern.test(argument)),
      `the scanner must reject ${probe}`,
    );
  }

  // 反过来：已经折成纯数据的写法必须放行。
  for (const allowed of [
    "request.log.error(safeErrorRecord(error), 'request failed');",
    "app.log.info({ signal }, 'graceful shutdown started');",
    "app.log.fatal('graceful shutdown timed out');",
  ]) {
    const source = strip(allowed);
    const scoped = new RegExp(logCallPattern.source, logCallPattern.flags);
    const match = scoped.exec(source);
    assert.ok(match, allowed);
    const argument = firstArgument(source, match.index + match[0].length - 1)
      .replace(safeWrappers, "")
      .trim();
    assert.equal(
      forbidden.some((rule) => rule.pattern.test(argument)),
      false,
      `the scanner must allow ${allowed}`,
    );
  }
});
