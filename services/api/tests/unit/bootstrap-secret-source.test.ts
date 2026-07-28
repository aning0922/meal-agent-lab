import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
import test, { after } from "node:test";

/**
 * 阶段 09A / M3A：`infra/docker/postgres/secret-source.sh` 的反向测试。
 *
 * 它与 `services/api/src/config-source.ts` 是同一套语义的两个实现，因此这里
 * 覆盖的反例与 `secret-source.test.ts` 逐条对应。两件事是这一组用例真正要
 * 证明的，也是别处证明不了的：
 *
 *   1. 三份口令**全部**在任何 psql 调用之前解析——任一份不合格时 psql 调用
 *      次数恒为 0；
 *   2. 口令既不进入 psql 的 argv，也不进入 psql 子进程的 environ，`bash -x`
 *      下同样不出现在输出里。
 *
 * 用受控的假 psql 记录 argv 与 stdin 的 **sha256**（绝不记录明文），因此断言
 * 本身也不会把 sentinel 写进测试产物。
 *
 * 它放在 API 包的单元测试里，是为了让它进入 `pnpm --filter @meal-agent/api
 * check` 这条已有门禁；根 `package.json` 属于本轮的冻结路径，不能为它新增脚本。
 */

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const bootstrapScript = join(
  repositoryRoot,
  "infra/docker/postgres/bootstrap.sh",
);

const workspace = mkdtempSync(join(tmpdir(), "meal-agent-bootstrap-secret-"));
after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

// 假 psql：把每次调用的 argv 逐项记录下来，并把 stdin 折算成 sha256。
// 它还会检查三个口令变量是否出现在自己的 environ 里——这是 `export -n` 的直接
// 反向证据。
const fakePsql = join(workspace, "fake-psql");
writeFileSync(
  fakePsql,
  [
    "#!/usr/bin/env bash",
    "set -eu",
    'printf "ARGV" >> "$MEAL_AGENT_FAKE_PSQL_LOG"',
    'for argument in "$@"; do printf "\\t%s" "$argument" >> "$MEAL_AGENT_FAKE_PSQL_LOG"; done',
    'printf "\\n" >> "$MEAL_AGENT_FAKE_PSQL_LOG"',
    "for leaked in MEAL_AGENT_MIGRATION_PASSWORD MEAL_AGENT_RUNTIME_PASSWORD \\",
    "  MEAL_AGENT_BACKUP_PASSWORD; do",
    '  if [ -n "${!leaked+x}" ]; then',
    '    printf "ENV_LEAK\\t%s\\n" "$leaked" >> "$MEAL_AGENT_FAKE_PSQL_LOG"',
    "  fi",
    "done",
    'printf "STDIN\\t%s\\n" "$(cat | shasum -a 256 | cut -d\' \' -f1)" \\',
    '  >> "$MEAL_AGENT_FAKE_PSQL_LOG"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakePsql, 0o755);

let sequence = 0;
const secretFile = (
  contents: string | Uint8Array,
  mode = 0o600,
): string => {
  sequence += 1;
  const path = join(workspace, `bootstrap-secret-${String(sequence)}`);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
};

const passwords = {
  migration: "MIGRATION-PASSWORD-SENTINEL",
  runtime: "RUNTIME-PASSWORD-SENTINEL",
  backup: "BACKUP-PASSWORD-SENTINEL",
} as const;
const sentinels = Object.values(passwords);

const stdinDigest = (password: string): string =>
  createHash("sha256").update(`${password}\n${password}\n`).digest("hex");

interface LoginsResult {
  readonly status: number | null;
  readonly output: string;
  readonly psqlCalls: number;
  readonly log: string;
}

let run = 0;
const runLogins = (
  environment: NodeJS.ProcessEnv,
  bashArguments: readonly string[] = [],
): LoginsResult => {
  run += 1;
  const logPath = join(workspace, `psql-log-${String(run)}`);
  writeFileSync(logPath, "");

  // 只保留必须的变量：宿主 shell 里恰好导出过同名变量时，用例语义不能被污染。
  const childEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    PSQL: fakePsql,
    MEAL_AGENT_FAKE_PSQL_LOG: logPath,
    ...environment,
  };

  const result = spawnSync(
    "bash",
    [...bashArguments, bootstrapScript, "logins", "--maintenance-db", "postgres"],
    {
      encoding: "utf8",
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const log = readFileSync(logPath, "utf8");
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    psqlCalls: log.split("\n").filter((line) => line.startsWith("ARGV")).length,
    log,
  };
};

const fileEnvironment = (
  overrides: Partial<Record<"migration" | "runtime" | "backup", string>> = {},
): NodeJS.ProcessEnv => ({
  MEAL_AGENT_MIGRATION_PASSWORD_FILE:
    overrides.migration ?? secretFile(passwords.migration),
  MEAL_AGENT_RUNTIME_PASSWORD_FILE:
    overrides.runtime ?? secretFile(passwords.runtime),
  MEAL_AGENT_BACKUP_PASSWORD_FILE:
    overrides.backup ?? secretFile(passwords.backup),
});

const assertNoSentinel = (haystack: string, label: string): void => {
  for (const sentinel of sentinels) {
    assert.equal(
      haystack.includes(sentinel),
      false,
      `${label} must not contain ${sentinel}`,
    );
  }
};

test("the bootstrap logins phase consumes all three password files", () => {
  const result = runLogins(fileEnvironment());
  assert.equal(result.status, 0, result.output);

  // 00-preflight + 02-login-preflight + 三次 \password + 03-login-verify。
  assert.equal(result.psqlCalls, 6);

  // 口令只经 stdin 到达 psql：argv 与 environ 都干净。
  assertNoSentinel(result.log, "the recorded psql argv");
  assertNoSentinel(result.output, "the bootstrap output");
  assert.equal(
    result.log.includes("ENV_LEAK"),
    false,
    "psql must not inherit the password variables",
  );

  // 三条 \password 的 stdin 恰好是「口令两遍」，且三条互不相同。
  for (const password of sentinels) {
    assert.equal(
      result.log.includes(`STDIN\t${stdinDigest(password)}`),
      true,
      "each role must receive its own password on stdin",
    );
  }
});

test("direct environment values remain supported for non-Compose local testing", () => {
  const result = runLogins({
    MEAL_AGENT_MIGRATION_PASSWORD: passwords.migration,
    MEAL_AGENT_RUNTIME_PASSWORD: passwords.runtime,
    MEAL_AGENT_BACKUP_PASSWORD: passwords.backup,
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.psqlCalls, 6);
  assertNoSentinel(result.log, "the recorded psql argv");
  assertNoSentinel(result.output, "the bootstrap output");
  // 即使取值来自进程环境，psql 子进程也不该在 environ 里看到它。
  assert.equal(result.log.includes("ENV_LEAK"), false);

  // 每个 secret 的两个来源各自独立，因此三份口令可以来自不同的来源。
  const mixed = runLogins({
    MEAL_AGENT_MIGRATION_PASSWORD_FILE: secretFile(passwords.migration),
    MEAL_AGENT_RUNTIME_PASSWORD: passwords.runtime,
    MEAL_AGENT_BACKUP_PASSWORD_FILE: secretFile(`${passwords.backup}\n`),
  });
  assert.equal(mixed.status, 0, mixed.output);
  assert.equal(mixed.psqlCalls, 6);
});

test("values are passed through byte-for-byte and never trimmed", () => {
  const awkward = " p@ss:w#rd/100%\\back ";
  const result = runLogins({
    MEAL_AGENT_MIGRATION_PASSWORD_FILE: secretFile(`${awkward}\n`),
    MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretFile(awkward),
    MEAL_AGENT_BACKUP_PASSWORD_FILE: secretFile(passwords.backup),
  });
  assert.equal(result.status, 0, result.output);
  // 两个来源（带/不带末尾 LF）必须产生**同一个** stdin 摘要，且它等于原样保留
  // 前后空格与特殊字符的取值——任何 trim 都会改变这个摘要。
  const digest = stdinDigest(awkward);
  assert.equal(
    result.log.split("\n").filter((line) => line === `STDIN\t${digest}`).length,
    2,
  );
});

test("any unusable password source leaves the psql call count at zero", () => {
  const directory = join(workspace, "a-directory");
  if (!existsSync(directory)) {
    mkdirSync(directory);
  }

  const symlinkTarget = secretFile(passwords.backup);
  const symlink = join(workspace, "symlinked-password");
  if (!existsSync(symlink)) {
    symlinkSync(symlinkTarget, symlink);
  }

  const hardLinkTarget = secretFile(passwords.backup);
  const hardLink = join(workspace, "hard-linked-password");
  if (!existsSync(hardLink)) {
    linkSync(hardLinkTarget, hardLink);
  }

  const fifo = join(workspace, "a-fifo-password");
  if (!existsSync(fifo)) {
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o600);
  }

  const cases: readonly [string, NodeJS.ProcessEnv, RegExp][] = [
    [
      "no source at all",
      {
        MEAL_AGENT_MIGRATION_PASSWORD_FILE: secretFile(passwords.migration),
        MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretFile(passwords.runtime),
      },
      /either MEAL_AGENT_BACKUP_PASSWORD or MEAL_AGENT_BACKUP_PASSWORD_FILE is required/,
    ],
    [
      "both sources at once",
      {
        ...fileEnvironment(),
        MEAL_AGENT_BACKUP_PASSWORD: passwords.backup,
      },
      /mutually exclusive/,
    ],
    [
      "empty direct value",
      {
        MEAL_AGENT_MIGRATION_PASSWORD: "",
        MEAL_AGENT_RUNTIME_PASSWORD: passwords.runtime,
        MEAL_AGENT_BACKUP_PASSWORD: passwords.backup,
      },
      /set but empty/,
    ],
    [
      "empty file path",
      { ...fileEnvironment(), MEAL_AGENT_BACKUP_PASSWORD_FILE: "" },
      /is set but empty/,
    ],
    [
      "relative file path",
      fileEnvironment({ backup: "infra/docker/secrets/backup" }),
      /is not an absolute path/,
    ],
    [
      "missing file",
      fileEnvironment({ backup: join(workspace, "absent-password") }),
      /does not exist/,
    ],
    ["directory", fileEnvironment({ backup: directory }), /is not a regular file/],
    ["symlink", fileEnvironment({ backup: symlink }), /is a symbolic link/],
    ["hard link", fileEnvironment({ backup: hardLink }), /hard links/],
    ["FIFO", fileEnvironment({ backup: fifo }), /is not a regular file/],
    [
      "group readable",
      fileEnvironment({ backup: secretFile(passwords.backup, 0o640) }),
      /only owner read\/write \(0600\) is accepted/,
    ],
    [
      "world readable",
      fileEnvironment({ backup: secretFile(passwords.backup, 0o604) }),
      /only owner read\/write \(0600\) is accepted/,
    ],
    [
      "owner executable",
      fileEnvironment({ backup: secretFile(passwords.backup, 0o700) }),
      /only owner read\/write \(0600\) is accepted/,
    ],
    [
      "oversized",
      fileEnvironment({ backup: secretFile("x".repeat(4097)) }),
      /the limit is 4096/,
    ],
    ["empty file", fileEnvironment({ backup: secretFile("") }), /is empty/],
    [
      "newline only",
      fileEnvironment({ backup: secretFile("\n") }),
      /is empty/,
    ],
    [
      "NUL byte",
      fileEnvironment({
        backup: secretFile(Uint8Array.from([0x61, 0x00, 0x62])),
      }),
      /contains a NUL byte/,
    ],
    [
      "invalid UTF-8",
      fileEnvironment({
        backup: secretFile(Uint8Array.from([0x41, 0xff, 0x42])),
      }),
      /is not valid UTF-8/,
    ],
    [
      "byte order mark",
      fileEnvironment({
        backup: secretFile(
          Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0x62]),
        ),
      }),
      /byte order mark/,
    ],
    [
      "CRLF",
      fileEnvironment({ backup: secretFile(`${passwords.backup}\r\n`) }),
      /carriage return/,
    ],
    [
      "multiple lines",
      fileEnvironment({ backup: secretFile("first\nsecond") }),
      /single line/,
    ],
    [
      "two trailing newlines",
      fileEnvironment({ backup: secretFile(`${passwords.backup}\n\n`) }),
      /at most one trailing newline/,
    ],
    [
      "the first secret is the broken one",
      fileEnvironment({ migration: secretFile("", 0o600) }),
      /is empty/,
    ],
  ];

  for (const [label, environment, expected] of cases) {
    const result = runLogins(environment);
    assert.notEqual(result.status, 0, `${label} must fail: ${result.output}`);
    assert.match(result.output, expected, `${label} must explain itself`);
    assert.equal(
      result.psqlCalls,
      0,
      `${label} must not reach psql (got ${String(result.psqlCalls)} calls)`,
    );
    assertNoSentinel(result.output, `the ${label} failure output`);
  }
});

test("bash -x never traces a password value", () => {
  const traced = runLogins(fileEnvironment(), ["-x"]);
  assert.equal(traced.status, 0, traced.output);
  assert.equal(traced.psqlCalls, 6);
  assert.match(traced.output, /\+ /, "xtrace must actually be enabled");
  assertNoSentinel(traced.output, "the xtrace output");
  assertNoSentinel(traced.log, "the recorded psql argv under xtrace");

  // 直接注入的取值同样不得出现在 xtrace 里。
  const tracedDirect = runLogins(
    {
      MEAL_AGENT_MIGRATION_PASSWORD: passwords.migration,
      MEAL_AGENT_RUNTIME_PASSWORD: passwords.runtime,
      MEAL_AGENT_BACKUP_PASSWORD: passwords.backup,
    },
    ["-x"],
  );
  assert.equal(tracedDirect.status, 0, tracedDirect.output);
  assertNoSentinel(tracedDirect.output, "the xtrace output for direct values");
});
