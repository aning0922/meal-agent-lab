import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import {
  canonicalErrorTypeNames,
  isAllowedErrorType,
} from "../../src/logging.js";

const workspace = mkdtempSync(join(tmpdir(), "meal-agent-error-allowlist-"));
after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * 阶段 09A / M3A：`allowedErrorTypes` 与仓库真实错误类的**静态防漂移**。
 *
 * 这条名单是 fail closed 的：不在名单里的类型名一律输出 `Error`。代价是新增一个
 * 错误类而忘了登记时，日志里只会看到 `Error`——诊断信息悄悄消失，而且不会有任何
 * 用例失败。第六轮就是这么漏掉 `Stage06ManifestError` 的：它 2026-07 起就存在于
 * `src/database/stage06-manifest.ts`，一直被折成 `Error`，而当时 logging.ts 的注
 * 释还写着「名单 = `grep 'this.name ='` 得到」。
 *
 * 因此这里直接扫源码，把「注释里的承诺」变成一条会红的断言。
 */

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

/**
 * `this.name = "X"`：本仓库每个错误类都用这一种写法登记自己的类型名。
 *
 * 锚在行首（允许缩进）。不锚的话，块注释里的 ` * this.name = "X"` 也会被当成
 * 一次真实声明。
 */
const nameAssignmentPattern = /^\s*this\.name\s*=\s*"([A-Za-z0-9_$]+)"/gm;
/**
 * `class X extends Error`：与上面互相校验，避免只认一种写法而漏掉新写法。
 *
 * 同样锚在行首。第一版没锚，于是把 logging.ts 注释里举例用的
 * `class Boom extends Error { get name() { … } }` 当成了真实类——扫描器自己先
 * 假阳性了一次，这里把它钉死。
 */
const errorSubclassPattern =
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)\s+extends\s+Error\b/gm;
/**
 * TypeScript 的类字段写法：`override readonly name = "X"`。它同样是一个**自身
 * 数据属性**，因此 logger 会如实读到它——但 `this.name =` 那条扫描看不见。
 */
const nameFieldPattern =
  /^\s*(?:public\s+|protected\s+|private\s+|override\s+|readonly\s+|declare\s+|static\s+)*name\s*=\s*"([A-Za-z0-9_$]+)"/gm;
/**
 * 继承自**本仓库其它错误类**的子类：`class X extends AppError`。它不 `extends
 * Error`，因此上一条也看不见。第七轮的对抗性复核就是拿这两种写法把扫描器绕过去
 * 的，两条都补上。
 */
const derivedSubclassPattern =
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)\s+extends\s+([A-Za-z0-9_$]+Error)\b/gm;

/**
 * 去掉注释再扫。行首锚点已经挡掉了本仓库的注释风格，但「靠缩进风格」不是一条
 * 能长期成立的假设，因此这里先做一次显式的剥离。
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

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

const matchAll = (
  files: readonly string[],
  pattern: RegExp,
): ReadonlySet<string> => {
  const found = new Set<string>();
  for (const file of files) {
    const source = withoutComments(readFileSync(file, "utf8"));
    // 每个文件都用新的 lastIndex，`g` 标志的正则不能跨文件复用状态。
    const scoped = new RegExp(pattern.source, pattern.flags);
    let match = scoped.exec(source);
    while (match !== null) {
      found.add(match[1] as string);
      match = scoped.exec(source);
    }
  }
  return found;
};

test("every error class defined in src is registered in the logger allowlist", () => {
  const files = typescriptFilesUnder(sourceRoot);
  assert.ok(files.length > 10, "the source scan must actually find files");

  const declared = new Set([
    ...matchAll(files, nameAssignmentPattern),
    ...matchAll(files, nameFieldPattern),
  ]);
  const subclasses = new Set([
    ...matchAll(files, errorSubclassPattern),
    ...matchAll(files, derivedSubclassPattern),
  ]);

  assert.ok(
    declared.size >= 10,
    `expected the repository's error classes to be found, got ${String(declared.size)}`,
  );

  const missing = [...declared]
    .filter((name) => !isAllowedErrorType(name))
    .sort();
  assert.deepEqual(
    missing,
    [],
    "these error classes set this.name but are not in allowedErrorTypes, so the logger " +
      "silently collapses them to \"Error\": " +
      missing.join(", "),
  );

  // 两种写法必须彼此覆盖：出现一个只 `extends Error` 却不 `this.name =` 的类，
  // 说明有了新写法，这条扫描就不再完整，必须显式处理而不是默默漏掉。
  const withoutRegisteredName = [...subclasses]
    .filter((name) => !declared.has(name))
    .sort();
  assert.deepEqual(
    withoutRegisteredName,
    [],
    "these classes are Error subclasses but register no name, so the logger " +
      "collapses them to \"Error\": " + withoutRegisteredName.join(", "),
  );

  // 扫描器自己也要有正向证据：三种写法都真的能被识别出来，否则「没有漂移」也可能
  // 只是因为正则从来没匹配到任何东西。
  const probe = [
    'class ProbeAssignedError extends Error {\n  constructor() {\n    super("x");\n    this.name = "ProbeAssignedError";\n  }\n}',
    'export class ProbeFieldError extends Error {\n  override readonly name = "ProbeFieldError";\n}',
    "export class ProbeDerivedError extends AppError {}",
  ].join("\n");
  const probeFile = join(workspace, "probe.ts");
  writeFileSync(probeFile, probe);
  assert.deepEqual(
    [...matchAll([probeFile], nameAssignmentPattern)],
    ["ProbeAssignedError"],
  );
  assert.deepEqual(
    [...matchAll([probeFile], nameFieldPattern)],
    ["ProbeFieldError"],
  );
  assert.deepEqual(
    [...matchAll([probeFile], derivedSubclassPattern)],
    ["ProbeDerivedError"],
  );
});

test("the allowlist keeps the built-in and dependency types on purpose", () => {
  // 名单**不是**仓库错误类的等价集合：内建类型与依赖类型是刻意加进去的，
  // 因此上面那条只能断言单向包含。这里把「刻意」写死，避免有人为了让漂移测试
  // 变绿而把它们删掉。
  for (const name of [
    "Error",
    "AggregateError",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
    "AbortError",
    "FastifyError",
    "ZodError",
  ]) {
    assert.equal(
      isAllowedErrorType(name),
      true,
      `${name} must stay in the allowlist`,
    );
  }
});

test("the allowlist cannot be tampered with at runtime", () => {
  // 上一版导出的是 `ReadonlySet<string>`——那只是类型上的只读。
  // `(allowedErrorTypes as Set<string>).add("EVIL")` 在运行期照样成功，于是任何
  // 拿得到这个模块的人都能给自己开一个后门。现在 Set 是模块私有的，对外只有
  // 一个冻结数组与一个 predicate。
  const exported = canonicalErrorTypeNames as unknown as Record<string, unknown>;
  assert.equal(
    typeof exported["add"],
    "undefined",
    "the canonical export must not be a mutable Set",
  );
  assert.equal(Object.isFrozen(canonicalErrorTypeNames), true);

  // 试着改冻结数组本身：非严格模式下静默失败，严格模式下抛错——两种都不能让
  // 判定放行。
  try {
    (canonicalErrorTypeNames as unknown as string[]).push("EVIL_TYPE_SENTINEL");
  } catch {
    // 冻结数组在严格模式下抛错，这正是期望。
  }
  assert.equal(
    isAllowedErrorType("EVIL_TYPE_SENTINEL"),
    false,
    "tampering with the exported snapshot must not widen the predicate",
  );
  assert.equal(canonicalErrorTypeNames.includes("EVIL_TYPE_SENTINEL"), false);

  // predicate 自身也不接受非字符串与原型链上的东西。
  for (const probe of [
    undefined,
    null,
    123,
    Symbol("AppError"),
    { toString: () => "AppError" },
    new String("AppError"),
    "constructor",
    "toString",
    "hasOwnProperty",
  ]) {
    assert.equal(
      isAllowedErrorType(probe),
      false,
      `isAllowedErrorType must reject ${String(probe)}`,
    );
  }

  // 真实类型名仍然放行。
  assert.equal(isAllowedErrorType("AppError"), true);
});

test("test-only error classes are deliberately out of scope", () => {
  // `tests/` 下的错误类（例如 stage09a.roles.database.test.ts 里的
  // AuthorizationCleanupError）不会进入产品日志，因此扫描只覆盖 `src/`。
  // 把这条写成断言，是为了让「扫描范围」这个决定本身是显式的，而不是某次
  // 复制粘贴的副产物。
  assert.equal(
    isAllowedErrorType("AuthorizationCleanupError"),
    false,
    "a test-harness-only error class must not be registered as a product type",
  );
});
