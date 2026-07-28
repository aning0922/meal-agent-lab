import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  maximumSecretFileBytes,
  readSecretFile,
  resolveDatabaseUrlSource,
  resolveSecretSource,
  SecretSourceError,
} from "../../src/config-source.js";
import { loadConfig } from "../../src/config.js";

/**
 * 阶段 09A / M3A：`<NAME>` 与 `<NAME>_FILE` 的互斥语义，以及 secret file 的
 * fail-closed 判据。
 *
 * 这些用例大量创建带特定属主/权限/链接数的临时文件；全部落在进程自己的临时
 * 目录里，不触碰仓库，也不使用任何真实凭据——sentinel 都是显式的合成值。
 */

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

const workspace = mkdtempSync(join(tmpdir(), "meal-agent-secret-source-"));
test.after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let sequence = 0;
const secretFile = (
  contents: string | Uint8Array,
  mode = 0o600,
): string => {
  sequence += 1;
  const path = join(workspace, `secret-${String(sequence)}`);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
};

const runtimeDsn = "postgresql://meal_agent_runtime_login:pw@postgres/meal_agent";

test("direct-only and file-only are both accepted and never fall back", () => {
  const direct = resolveSecretSource("DATABASE_URL", {
    DATABASE_URL: runtimeDsn,
  });
  assert.deepEqual(direct, {
    variable: "DATABASE_URL",
    fileVariable: "DATABASE_URL_FILE",
    origin: "environment",
    value: runtimeDsn,
  });

  const path = secretFile(`${runtimeDsn}\n`);
  const fromFile = resolveSecretSource("DATABASE_URL", {
    DATABASE_URL_FILE: path,
  });
  assert.deepEqual(fromFile, {
    variable: "DATABASE_URL",
    fileVariable: "DATABASE_URL_FILE",
    origin: "file",
    value: runtimeDsn,
  });
});

test("both sources present is a conflict even when the contents are identical", () => {
  const path = secretFile(runtimeDsn);

  // 内容完全相同也必须失败：两个来源同时出现说明部署配置本身有歧义。
  assert.throws(
    () =>
      resolveSecretSource("DATABASE_URL", {
        DATABASE_URL: runtimeDsn,
        DATABASE_URL_FILE: path,
      }),
    (error: unknown) =>
      error instanceof SecretSourceError &&
      /mutually exclusive/.test(error.message),
  );

  // 空字符串同样算「已出现」：空 direct 不得把配置降级成合法的 file-only 注入。
  for (const conflicting of [
    { DATABASE_URL: "", DATABASE_URL_FILE: path },
    { DATABASE_URL: runtimeDsn, DATABASE_URL_FILE: "" },
    { DATABASE_URL: "", DATABASE_URL_FILE: "" },
  ]) {
    assert.throws(
      () => resolveSecretSource("DATABASE_URL", conflicting),
      (error: unknown) =>
        error instanceof SecretSourceError &&
        /mutually exclusive/.test(error.message),
      `${JSON.stringify(conflicting)} must be rejected as a conflict`,
    );
  }

  // 选中来源失败时**不得**回落：direct 合法但 _FILE 指向一个根本不存在的路径，
  // 结果仍然只能是冲突，绝不能悄悄用 direct 的值。
  assert.throws(
    () =>
      resolveSecretSource("DATABASE_URL", {
        DATABASE_URL: runtimeDsn,
        DATABASE_URL_FILE: join(workspace, "does-not-exist"),
      }),
    (error: unknown) =>
      error instanceof SecretSourceError &&
      /mutually exclusive/.test(error.message),
  );
});

test("a missing or empty source fails closed", () => {
  assert.throws(
    () => resolveSecretSource("DATABASE_URL", {}),
    (error: unknown) =>
      error instanceof SecretSourceError && /is required/.test(error.message),
  );
  assert.throws(
    () => resolveSecretSource("DATABASE_URL", { DATABASE_URL: "" }),
    (error: unknown) =>
      error instanceof SecretSourceError &&
      /set but empty/.test(error.message),
  );
  assert.throws(
    () => resolveSecretSource("DATABASE_URL", { DATABASE_URL_FILE: "" }),
    (error: unknown) =>
      error instanceof SecretSourceError &&
      /must not be empty/.test(error.message),
  );
});

test("secret file paths must be absolute", () => {
  assert.throws(
    () => readSecretFile("DATABASE_URL_FILE", "relative/secret"),
    (error: unknown) =>
      error instanceof SecretSourceError &&
      /is not an absolute path/.test(error.message),
  );
});

test("only regular, single-named, owner-only files are accepted", () => {
  const directory = join(workspace, "a-directory");
  mkdirSync(directory);
  assert.throws(
    () => readSecretFile("DATABASE_URL_FILE", directory),
    (error: unknown) =>
      error instanceof SecretSourceError &&
      /is not a regular file/.test(error.message),
  );

  assert.throws(
    () => readSecretFile("DATABASE_URL_FILE", join(workspace, "absent")),
    (error: unknown) =>
      error instanceof SecretSourceError &&
      /does not exist/.test(error.message),
  );

  const target = secretFile(runtimeDsn);
  const link = join(workspace, "symlinked-secret");
  symlinkSync(target, link);
  assert.throws(
    () => readSecretFile("DATABASE_URL_FILE", link),
    (error: unknown) =>
      error instanceof SecretSourceError &&
      /is a symbolic link/.test(error.message),
  );

  const hardLink = join(workspace, "hard-linked-secret");
  linkSync(target, hardLink);
  try {
    for (const path of [target, hardLink]) {
      assert.throws(
        () => readSecretFile("DATABASE_URL_FILE", path),
        (error: unknown) =>
          error instanceof SecretSourceError &&
          /hard links/.test(error.message),
        `${path} must be rejected while a second name exists`,
      );
    }
  } finally {
    rmSync(hardLink);
  }
  // 解除硬链接后同一个文件重新变得合法，证明拒绝理由确实是链接数。
  assert.equal(readSecretFile("DATABASE_URL_FILE", target), runtimeDsn);

  const fifo = join(workspace, "a-fifo");
  execFileSync("mkfifo", [fifo]);
  chmodSync(fifo, 0o600);
  assert.throws(
    () => readSecretFile("DATABASE_URL_FILE", fifo),
    (error: unknown) =>
      error instanceof SecretSourceError &&
      /is not a regular file/.test(error.message),
  );
});

test("group, world and execute permission bits are rejected", () => {
  for (const mode of [0o640, 0o604, 0o660, 0o666, 0o700, 0o601]) {
    const path = secretFile(runtimeDsn, mode);
    assert.throws(
      () => readSecretFile("DATABASE_URL_FILE", path),
      (error: unknown) =>
        error instanceof SecretSourceError &&
        /only owner read\/write \(0600\) is accepted/.test(error.message),
      `mode ${mode.toString(8)} must be rejected`,
    );
  }
  // 0400 与 0600 都在允许范围内。
  for (const mode of [0o400, 0o600]) {
    assert.equal(
      readSecretFile("DATABASE_URL_FILE", secretFile(runtimeDsn, mode)),
      runtimeDsn,
    );
  }
});

test("a secret file owned by another uid is rejected", () => {
  const path = secretFile(runtimeDsn);
  const host = process as { geteuid?: (() => number) | undefined };
  const original = host.geteuid;
  assert.equal(typeof original, "function");
  // 无法在测试里创建一个属于别的 uid 的文件（那需要 root），因此在**同一条
  // 比较**的另一侧注入差异：进程的 effective UID 与文件属主不一致时必须拒绝。
  host.geteuid = () => (original?.call(process) ?? 0) + 1;
  try {
    assert.throws(
      () => readSecretFile("DATABASE_URL_FILE", path),
      (error: unknown) =>
        error instanceof SecretSourceError &&
        /is owned by uid/.test(error.message),
    );
  } finally {
    host.geteuid = original;
  }

  // 平台不提供 effective UID 时同样 fail closed，而不是跳过属主校验。
  host.geteuid = undefined;
  try {
    assert.throws(
      () => readSecretFile("DATABASE_URL_FILE", path),
      (error: unknown) =>
        error instanceof SecretSourceError &&
        /does not expose an effective UID/.test(error.message),
    );
  } finally {
    host.geteuid = original;
  }
});

test("oversized secret files are rejected before they are read", () => {
  const path = secretFile("x".repeat(maximumSecretFileBytes + 1));
  assert.throws(
    () => readSecretFile("DATABASE_URL_FILE", path),
    (error: unknown) =>
      error instanceof SecretSourceError && /the limit is/.test(error.message),
  );
  // 恰好等于上限仍然合法。
  const atLimit = secretFile("y".repeat(maximumSecretFileBytes));
  assert.equal(
    readSecretFile("DATABASE_URL_FILE", atLimit).length,
    maximumSecretFileBytes,
  );
});

test("empty, NUL, invalid UTF-8, BOM, CRLF and multi-line contents are rejected", () => {
  const cases: readonly [string, string | Uint8Array, RegExp][] = [
    ["zero bytes", "", /is empty/],
    ["only a newline", "\n", /is empty/],
    ["NUL byte", "meal\u0000agent", /contains a NUL byte/],
    ["invalid UTF-8", Uint8Array.from([0x41, 0xff, 0x42]), /is not valid UTF-8/],
    ["lone continuation byte", Uint8Array.from([0x80]), /is not valid UTF-8/],
    ["byte order mark", "\uFEFFmeal-agent", /byte order mark/],
    ["CRLF", "meal-agent\r\n", /carriage return/],
    ["bare CR", "meal\ragent", /carriage return/],
    ["two lines", "meal\nagent", /single line/],
    ["two trailing newlines", "meal-agent\n\n", /more than one newline/],
    ["three trailing newlines", "meal-agent\n\n\n", /more than one newline/],
  ];
  for (const [label, contents, expected] of cases) {
    const path = secretFile(contents);
    assert.throws(
      () => readSecretFile("DATABASE_URL_FILE", path),
      (error: unknown) =>
        error instanceof SecretSourceError && expected.test(error.message),
      `${label} must be rejected`,
    );
  }
});

test("at most one trailing newline is removed and nothing else is trimmed", () => {
  assert.equal(
    readSecretFile("DATABASE_URL_FILE", secretFile("meal-agent\n")),
    "meal-agent",
  );
  assert.equal(
    readSecretFile("DATABASE_URL_FILE", secretFile("meal-agent")),
    "meal-agent",
  );

  // 口令与连接串里合法出现的字符必须逐字节保留，包括前后空格。
  const preserved = [
    "  leading and trailing spaces  ",
    "colon:separated",
    "back\\slash",
    "user@example",
    "slash/inside",
    "hash#fragmentish",
    "percent%40encoded",
    "tab\tseparated",
    " p@ss w#rd/100% ",
  ];
  for (const value of preserved) {
    assert.equal(
      readSecretFile("DATABASE_URL_FILE", secretFile(value)),
      value,
      `${JSON.stringify(value)} must not be trimmed or rewritten`,
    );
    assert.equal(
      readSecretFile("DATABASE_URL_FILE", secretFile(`${value}\n`)),
      value,
      `${JSON.stringify(value)} must survive a single trailing newline`,
    );
  }
});

test("secret source errors never carry the secret value", () => {
  const sentinel = "SECRET-SOURCE-VALUE-SENTINEL";
  const failures: SecretSourceError[] = [];
  const collect = (run: () => unknown): void => {
    try {
      run();
    } catch (error) {
      assert.ok(error instanceof SecretSourceError);
      failures.push(error);
    }
  };

  collect(() =>
    resolveSecretSource("DATABASE_URL", {
      DATABASE_URL: sentinel,
      DATABASE_URL_FILE: secretFile(sentinel),
    }),
  );
  collect(() =>
    readSecretFile("DATABASE_URL_FILE", secretFile(`${sentinel}\n\n`)),
  );
  collect(() =>
    readSecretFile("DATABASE_URL_FILE", secretFile(sentinel, 0o644)),
  );
  collect(() =>
    readSecretFile(
      "DATABASE_URL_FILE",
      secretFile(sentinel.repeat(maximumSecretFileBytes)),
    ),
  );

  assert.equal(failures.length, 4);
  for (const failure of failures) {
    assert.equal(
      failure.message.includes(sentinel),
      false,
      `error must not leak the secret: ${failure.message}`,
    );
  }
});

test("loadConfig resolves DATABASE_URL through the shared secret source", () => {
  const path = secretFile(`${runtimeDsn}\n`);
  const fromFile = loadConfig({
    NODE_ENV: "test",
    DEPLOYMENT_STAGE: "local-test",
    DEPLOYMENT_EXPOSURE: "loopback",
    DATABASE_URL_FILE: path,
    WECHAT_ADAPTER: "fake",
  });
  assert.equal(fromFile.databaseUrl, runtimeDsn);
  assert.equal(fromFile.databaseUrlOrigin, "file");

  const fromEnvironment = loadConfig({
    NODE_ENV: "test",
    DEPLOYMENT_STAGE: "local-test",
    DEPLOYMENT_EXPOSURE: "loopback",
    DATABASE_URL: runtimeDsn,
    WECHAT_ADAPTER: "fake",
  });
  assert.equal(fromEnvironment.databaseUrlOrigin, "environment");

  for (const environment of [
    { DATABASE_URL: runtimeDsn, DATABASE_URL_FILE: path },
    {},
    { DATABASE_URL: "" },
    { DATABASE_URL_FILE: secretFile("not-a-postgres-dsn") },
  ]) {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "test",
          DEPLOYMENT_STAGE: "local-test",
          DEPLOYMENT_EXPOSURE: "loopback",
          WECHAT_ADAPTER: "fake",
          ...environment,
        }),
      `${JSON.stringify(environment)} must not produce a config`,
    );
  }
});

test("all three Node entry points consume the one shared resolver", () => {
  // 「共用」必须是结构上的事实，不是三处各写一遍的约定。
  for (const relative of [
    "config.ts",
    "database/migrate.ts",
    "database/bootstrap-0000.ts",
  ]) {
    const source = readFileSync(join(sourceRoot, relative), "utf8");
    assert.match(
      source,
      /resolveDatabaseUrlSource/,
      `${relative} must resolve DATABASE_URL through config-source.ts`,
    );
    assert.doesNotMatch(
      source,
      /process\.env\["DATABASE_URL"\]/,
      `${relative} must not read DATABASE_URL from the environment directly`,
    );
  }
  assert.equal(typeof resolveDatabaseUrlSource, "function");
});

const runEntryPoint = (
  relative: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): { status: number | null; stderr: string } => {
  // 先移除继承来的两个变量，再叠加用例自己的取值：否则 `pnpm test` 所在的
  // shell 里恰好导出过 DATABASE_URL 就会让「两者都缺」这个用例变成别的场景。
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  delete childEnvironment["DATABASE_URL"];
  delete childEnvironment["DATABASE_URL_FILE"];
  Object.assign(childEnvironment, environment);

  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", join(sourceRoot, relative), ...argv],
      {
        encoding: "utf8",
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { status: 0, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number | null; stderr?: string };
    return { status: failure.status ?? null, stderr: failure.stderr ?? "" };
  }
};

test("the CLI entry points validate arguments before touching a secret file", () => {
  // 非法参数时既不读 Secret 文件也不连接数据库：即使 _FILE 指向一个不存在的
  // 路径，失败理由也必须是参数用法，而不是文件读取。
  const absent = join(workspace, "never-read");
  for (const [relative, argv, expected] of [
    ["database/migrate.ts", ["--bootstrap-0000"], /db:migrate takes no arguments/],
    ["database/bootstrap-0000.ts", ["--role=postgres"], /db:bootstrap takes no arguments/],
  ] as const) {
    const result = runEntryPoint(relative, argv, {
      DATABASE_URL_FILE: absent,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /DATABASE_URL_FILE/);
  }
});

test("the CLI entry points fail closed on a conflicting or unusable secret source", () => {
  const good = secretFile(runtimeDsn);
  for (const relative of [
    "database/migrate.ts",
    "database/bootstrap-0000.ts",
  ]) {
    const conflict = runEntryPoint(relative, [], {
      DATABASE_URL: runtimeDsn,
      DATABASE_URL_FILE: good,
    });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /mutually exclusive/);
    assert.equal(conflict.stderr.includes(runtimeDsn), false);

    const missing = runEntryPoint(relative, [], {});
    assert.notEqual(missing.status, 0);
    assert.match(
      missing.stderr,
      /either DATABASE_URL or DATABASE_URL_FILE is required/,
    );

    const weak = runEntryPoint(relative, [], {
      DATABASE_URL_FILE: secretFile(runtimeDsn, 0o644),
    });
    assert.notEqual(weak.status, 0);
    assert.match(weak.stderr, /only owner read\/write \(0600\) is accepted/);
    assert.equal(weak.stderr.includes(runtimeDsn), false);
  }
});
