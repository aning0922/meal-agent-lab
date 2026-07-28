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

import pg from "pg";

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

const runtimeDsn =
  "postgresql://meal_agent_runtime_login:pw@postgres:5432/meal_agent";

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

// ---------------------------------------------------------------------------
// PostgreSQL 连接串：核心字段必须全部来自 URL
// ---------------------------------------------------------------------------
// node-postgres 在连接串缺字段时会**静默回落**到 PG* 环境变量。因此这一组用例
// 注入互不相同的 ambient sentinel，再检查真实 `pg.Client` 的 connectionParameters。

const ambientPgSentinels = {
  PGHOST: "ambient-host.invalid",
  PGPORT: "15432",
  PGUSER: "ambient_user",
  PGPASSWORD: "ambient-password",
  PGDATABASE: "ambient_database",
} as const;

/** `pg` 的 TS 类型没有公开 connectionParameters，但它是真实存在的运行时字段。 */
interface ConnectionParameters {
  readonly host?: unknown;
  readonly port?: unknown;
  readonly user?: unknown;
  readonly password?: unknown;
  readonly database?: unknown;
}

const connectionParametersOf = (
  connectionString: string,
): ConnectionParameters =>
  (
    new pg.Client({ connectionString }) as unknown as {
      connectionParameters: ConnectionParameters;
    }
  ).connectionParameters;

/** `assert.throws` 不返回被抛出的错误，因此这里自己捕获以便断言具体理由。 */
const captureSecretSourceError = (run: () => unknown): SecretSourceError => {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof SecretSourceError,
      `expected a SecretSourceError, got ${String(error)}`,
    );
    return error;
  }
  return assert.fail("expected the call to throw");
};

const withAmbientPgEnvironment = <T>(run: () => T): T => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(ambientPgSentinels)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test("a valid connection URL supplies every core field itself", () => {
  const url =
    "postgresql://meal_agent_runtime_login:runtime-pw@127.0.0.1:5433/meal_agent";

  withAmbientPgEnvironment(() => {
    for (const [label, environment] of [
      ["direct", { DATABASE_URL: url }],
      ["file", { DATABASE_URL_FILE: secretFile(`${url}\n`) }],
    ] as const) {
      const source = resolveDatabaseUrlSource(environment);
      // 校验后返回**原始串**：不 trim、不规范化、不重写口令。
      assert.equal(source.value, url, label);

      const parameters = connectionParametersOf(source.value);
      assert.equal(parameters.host, "127.0.0.1", label);
      assert.equal(Number(parameters.port), 5433, label);
      assert.equal(parameters.user, "meal_agent_runtime_login", label);
      assert.equal(parameters.password, "runtime-pw", label);
      assert.equal(parameters.database, "meal_agent", label);

      const serialized = JSON.stringify(parameters);
      for (const sentinel of Object.values(ambientPgSentinels)) {
        assert.equal(
          serialized.includes(sentinel),
          false,
          `${label}: ${sentinel} must not reach the connection parameters`,
        );
      }
    }
  });
});

const rejectedConnectionUrls: readonly [string, string, RegExp][] = [
  ["scheme only", "postgresql://", /no explicit username/],
  [
    "missing username",
    "postgresql://:pw@127.0.0.1:5432/meal_agent",
    /no explicit username/,
  ],
  [
    "missing password",
    "postgresql://user@127.0.0.1:5432/meal_agent",
    /no explicit password/,
  ],
  [
    "explicit empty password",
    "postgresql://user:@127.0.0.1:5432/meal_agent",
    /no explicit password/,
  ],
  [
    "missing port",
    "postgresql://user:pw@127.0.0.1/meal_agent",
    /no explicit port/,
  ],
  [
    "database is a bare slash",
    "postgresql://user:pw@127.0.0.1:5432/",
    /exactly one database/,
  ],
  [
    "no path at all",
    "postgresql://user:pw@127.0.0.1:5432",
    /exactly one database/,
  ],
  [
    "two path segments",
    "postgresql://user:pw@127.0.0.1:5432/schema/meal_agent",
    /exactly one database/,
  ],
  [
    "query host override",
    "postgresql://user:pw@127.0.0.1:5432/meal_agent?host=/tmp",
    /must not carry a query string/,
  ],
  [
    "query options override",
    "postgresql://user:pw@127.0.0.1:5432/meal_agent?options=-csearch_path%3Devil",
    /must not carry a query string/,
  ],
  [
    "fragment",
    "postgresql://user:pw@127.0.0.1:5432/meal_agent#fragment",
    /must not carry a fragment/,
  ],
  [
    "percent-encoded Unix socket host",
    "postgresql://user:pw@%2Ftmp:5432/meal_agent",
    /not a Unix socket path/,
  ],
  [
    "Unix socket path form",
    "postgresql:///var/run/postgresql",
    /no explicit username/,
  ],
  [
    "multiple hosts",
    "postgresql://user:pw@host-a:5432,host-b:5432/meal_agent",
    /not a valid URL/,
  ],
  [
    "wrong scheme",
    "mysql://user:pw@127.0.0.1:3306/meal_agent",
    /must start with postgresql:\/\/ or postgres:\/\//,
  ],
  [
    "raw carriage return",
    "postgresql://user:pw@127.0.0.1:5432/meal_agent\r",
    // 内容判据先于连接串 validator 生效：两层都拒绝，理由来自前者。
    /carriage return/,
  ],
  [
    "raw line feed",
    "postgresql://user:pw@127.0.0.1:5432/meal_agent\n",
    /must contain a single line/,
  ],
  [
    "raw NUL",
    "postgresql://user:pw@127.0.0.1:5432/meal_agent\u0000",
    /contains a NUL byte/,
  ],
  [
    "byte order mark",
    "\uFEFFpostgresql://user:pw@127.0.0.1:5432/meal_agent",
    /contains a byte order mark/,
  ],
  [
    "unencoded space",
    "postgresql://user:p w@127.0.0.1:5432/meal_agent",
    /control character/,
  ],
  [
    "percent-encoded CR in the password",
    "postgresql://user:pw%0D@127.0.0.1:5432/meal_agent",
    /decodes to a value containing NUL, CR or LF/,
  ],
  [
    "percent-encoded LF in the username",
    "postgresql://us%0Aer:pw@127.0.0.1:5432/meal_agent",
    /decodes to a value containing NUL, CR or LF/,
  ],
  [
    "percent-encoded NUL in the database",
    "postgresql://user:pw@127.0.0.1:5432/meal_agent%00",
    /decodes to a value containing NUL, CR or LF/,
  ],
];

test("an under-specified connection URL is rejected on both sources", () => {
  withAmbientPgEnvironment(() => {
    for (const [label, url, expected] of rejectedConnectionUrls) {
      // direct 与 file 走的是**同一个** validator，因此两条来源都必须失败。
      // 含 CR/LF/NUL 的取值连 secret file 的内容判据都过不去——那一层会先拒绝，
      // 因此只对 direct 断言具体理由，对 file 只断言「必然被拒绝」。
      const failure = captureSecretSourceError(() =>
        resolveDatabaseUrlSource({ DATABASE_URL: url }),
      );
      assert.match(
        failure.message,
        expected,
        `${label} (direct) must explain itself`,
      );

      if (label === "raw line feed") {
        // 唯一一处两条来源**故意**不同：secret file 允许一个末尾 LF（文件格式
        // 惯例），因此这一条在 file 来源上是合法的，并且解析结果里没有那个 LF。
        const fromFile = resolveDatabaseUrlSource({
          DATABASE_URL_FILE: secretFile(url),
        });
        assert.equal(fromFile.value, url.replace(/\n$/, ""));
        continue;
      }
      assert.throws(
        () =>
          resolveDatabaseUrlSource({
            DATABASE_URL_FILE: secretFile(url),
          }),
        SecretSourceError,
        `${label} (file) must be rejected`,
      );
    }
  });
});

test("an under-specified connection URL never reaches node-postgres", () => {
  // 「拒绝」必须发生在**建立连接之前**。这里直接证明入口顺序：CLI 以校验错误
  // 退出，而不是以一个连接错误退出——后者才说明它已经带着回落来的 PG* 参数
  // 真的去连过数据库了。
  const ambient = {
    PGHOST: "127.0.0.1",
    PGPORT: "1",
    PGUSER: "ambient_user",
    PGPASSWORD: "ambient-password",
    PGDATABASE: "ambient_database",
  };
  for (const relative of [
    "database/migrate.ts",
    "database/bootstrap-0000.ts",
  ]) {
    const result = runEntryPoint(relative, [], {
      ...ambient,
      DATABASE_URL: "postgresql://",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no explicit username/);
    for (const connectionFailure of [
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "ambient_user",
      "ambient_database",
    ]) {
      assert.equal(
        result.stderr.includes(connectionFailure),
        false,
        `${relative} must fail before connecting (saw ${connectionFailure})`,
      );
    }
  }
});

test("direct values obey the same content rules as files", () => {
  const variable = "MEAL_AGENT_RUNTIME_PASSWORD";
  const cases: readonly [string, string, RegExp][] = [
    ["two identical lines", "foo\nfoo", /must contain a single line/],
    ["embedded newline", "first\nsecond", /must contain a single line/],
    ["trailing newline", "secret\n", /must contain a single line/],
    ["carriage return", "secret\r", /carriage return/],
    ["NUL byte", "sec\u0000ret", /contains a NUL byte/],
    ["byte order mark", "\uFEFFsecret", /contains a byte order mark/],
    ["oversized", "x".repeat(maximumSecretFileBytes + 1), /the limit is/],
  ];
  for (const [label, value, expected] of cases) {
    assert.throws(
      () => resolveSecretSource(variable, { [variable]: value }),
      (error: unknown) =>
        error instanceof SecretSourceError && expected.test(error.message),
      `a direct ${label} must be rejected`,
    );
  }

  // direct 同样不做任何 trim。
  for (const value of [
    "  spaced  ",
    "\ttabbed\t",
    "p@ss:w#rd/100%\\back",
    " leading and trailing ",
  ]) {
    assert.equal(
      resolveSecretSource(variable, { [variable]: value }).value,
      value,
      `${JSON.stringify(value)} must survive untouched`,
    );
  }
});
