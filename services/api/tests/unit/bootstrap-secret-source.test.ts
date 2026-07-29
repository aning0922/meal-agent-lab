import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as openConstants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  /** spawnSync 的外部 timeout 是否触发（触发时 signal 为 SIGTERM）。 */
  readonly timedOut: boolean;
}

/**
 * 外部 timeout。它比实现自己的 5 秒上界稍宽，只用来把「实现没有上界」变成一次
 * **确定的测试失败**而不是一次挂死；断言要求它**不能**被触发。
 */
const externalTimeoutMs = 12_000;

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
      timeout: externalTimeoutMs,
      killSignal: "SIGKILL",
    },
  );

  const log = readFileSync(logPath, "utf8");
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    psqlCalls: log.split("\n").filter((line) => line.startsWith("ARGV")).length,
    log,
    timedOut: result.signal !== null || result.error !== undefined,
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
      /only owner-only 0400 or 0600 is accepted/,
    ],
    [
      "world readable",
      fileEnvironment({ backup: secretFile(passwords.backup, 0o604) }),
      /only owner-only 0400 or 0600 is accepted/,
    ],
    [
      "owner executable",
      fileEnvironment({ backup: secretFile(passwords.backup, 0o700) }),
      /only owner-only 0400 or 0600 is accepted/,
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

test("direct values obey exactly the same content rules as files", () => {
  // 多行 direct 是这一组里最重要的一条：`foo\nfoo` 交给 psql 的 `\password`
  // 会被读成两次相同输入，于是口令被**静默**设置成 `foo`。必须在任何 psql
  // 调用之前拒绝，而不是让它「看起来成功」。
  const cases: readonly [string, string, RegExp][] = [
    ["two identical lines", `foo\nfoo`, /must contain a single line/],
    ["embedded newline", `${passwords.backup}\nsecond`, /must contain a single line/],
    ["trailing newline", `${passwords.backup}\n`, /must contain a single line/],
    ["carriage return", `${passwords.backup}\r`, /carriage return/],
    ["CRLF", `${passwords.backup}\r\n`, /carriage return|single line/],
    ["byte order mark", `\uFEFF${passwords.backup}`, /byte order mark/],
    ["oversized", "x".repeat(4097), /the limit is 4096/],
  ];

  for (const [label, value, expected] of cases) {
    const result = runLogins({
      MEAL_AGENT_MIGRATION_PASSWORD: passwords.migration,
      MEAL_AGENT_RUNTIME_PASSWORD: passwords.runtime,
      MEAL_AGENT_BACKUP_PASSWORD: value,
    });
    assert.notEqual(result.status, 0, `${label} must fail: ${result.output}`);
    assert.match(result.output, expected, `${label} must explain itself`);
    assert.equal(
      result.psqlCalls,
      0,
      `${label} must not reach psql (got ${String(result.psqlCalls)} calls)`,
    );
    assertNoSentinel(result.output, `the ${label} failure output`);
  }

  // 反面：direct 同样不做任何 trim。
  const preserved = " p@ss:w#rd/100%\\back\t ";
  const kept = runLogins({
    MEAL_AGENT_MIGRATION_PASSWORD: preserved,
    MEAL_AGENT_RUNTIME_PASSWORD: passwords.runtime,
    MEAL_AGENT_BACKUP_PASSWORD: passwords.backup,
  });
  assert.equal(kept.status, 0, kept.output);
  assert.equal(
    kept.log.includes(`STDIN\t${stdinDigest(preserved)}`),
    true,
    "a direct value must reach psql byte-for-byte",
  );
});

/**
 * 受控的 `stat` 包装器：转发给真实 stat，并在被问到指定对象之后把目标路径
 * 替换掉。它只存在于测试的 PATH 上——生产脚本里没有任何故障注入开关。
 *
 * 两个注入点对应两种不同的攻击时刻：
 *   - `SWAP_ON_FD`：描述符已经取到、路径 stat 还没做 → 身份绑定必须发现不一致；
 *   - `SWAP_ON_PATH`：metadata 已经全部检查完 → 必须仍然消费最初那个 inode。
 */
const statWrapperDirectory = join(workspace, "stat-wrapper");
mkdirSync(statWrapperDirectory, { recursive: true });
writeFileSync(
  join(statWrapperDirectory, "stat"),
  [
    "#!/usr/bin/env bash",
    "set -u",
    'real="/usr/bin/stat"',
    "# 一次性：源文件被移走之后就不会再触发。",
    'swap() {',
    '  if [ -e "$MEAL_AGENT_TEST_SWAP_FROM" ]; then',
    '    mv -f "$MEAL_AGENT_TEST_SWAP_FROM" "$MEAL_AGENT_TEST_SWAP_TO"',
    "  fi",
    "}",
    "# 第 N 次被问到某一类对象之后才动手，因此注入点在时间上是确定的。",
    'armed() {',
    '  local seen',
    '  seen=$(( $(cat "$MEAL_AGENT_TEST_SWAP_COUNTER" 2>/dev/null || echo 0) + 1 ))',
    '  printf "%s" "$seen" > "$MEAL_AGENT_TEST_SWAP_COUNTER"',
    '  [ "$seen" -eq "${MEAL_AGENT_TEST_SWAP_AT:-1}" ]',
    "}",
    'saw_fd="no"',
    'saw_target="no"',
    'for argument in "$@"; do',
    '  case "$argument" in',
    '    /dev/fd/*) saw_fd="yes" ;;',
    '    "$MEAL_AGENT_TEST_SWAP_TO") saw_target="yes" ;;',
    "  esac",
    "done",
    '"$real" "$@"',
    'status=$?',
    'if [ "${MEAL_AGENT_TEST_SWAP_ON:-}" = "fd" ] && [ "$saw_fd" = "yes" ] && armed; then swap; fi',
    'if [ "${MEAL_AGENT_TEST_SWAP_ON:-}" = "path" ] && [ "$saw_target" = "yes" ] && armed; then swap; fi',
    'exit "$status"',
  ].join("\n"),
);
chmodSync(join(statWrapperDirectory, "stat"), 0o755);

let swapRun = 0;
const runWithPathSwap = (
  swapOn: "fd" | "path",
  original: string,
  replacement: string,
): LoginsResult => {
  swapRun += 1;
  const target = join(workspace, `swap-target-${swapOn}-${String(swapRun)}`);
  writeFileSync(target, original);
  chmodSync(target, 0o600);
  const counter = join(workspace, `swap-counter-${String(swapRun)}`);
  return runLogins({
    PATH: `${statWrapperDirectory}:${process.env["PATH"] ?? ""}`,
    MEAL_AGENT_TEST_SWAP_ON: swapOn,
    MEAL_AGENT_TEST_SWAP_FROM: replacement,
    MEAL_AGENT_TEST_SWAP_TO: target,
    MEAL_AGENT_TEST_SWAP_COUNTER: counter,
    // 三份口令都走文件，因此 `/dev/fd/*` 的 stat 依次是 migration、runtime、
    // backup；第 3 次正是 backup 取到描述符、还没做路径 stat 的那一刻。
    // 路径 stat 只会问到 backup 的目标路径一次，因此第 1 次即可。
    MEAL_AGENT_TEST_SWAP_AT: swapOn === "fd" ? "3" : "1",
    MEAL_AGENT_MIGRATION_PASSWORD_FILE: secretFile(passwords.migration),
    MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretFile(passwords.runtime),
    MEAL_AGENT_BACKUP_PASSWORD_FILE: target,
  });
};

test("replacing the path after its metadata was checked cannot swap the content", () => {
  const replacementValue = "REPLACEMENT-PASSWORD-SENTINEL";

  // 1. metadata 全部检查完之后替换：必须仍然消费最初已验证的那个 inode。
  const afterMetadata = runWithPathSwap(
    "path",
    passwords.backup,
    secretFile(replacementValue),
  );
  assert.equal(afterMetadata.status, 0, afterMetadata.output);
  assert.equal(afterMetadata.psqlCalls, 6);
  assert.equal(
    afterMetadata.log.includes(`STDIN\t${stdinDigest(passwords.backup)}`),
    true,
    "the originally validated inode must be the one that is consumed",
  );
  assert.equal(
    afterMetadata.log.includes(`STDIN\t${stdinDigest(replacementValue)}`),
    false,
    "the replacement content must never reach psql",
  );
  assert.equal(afterMetadata.log.includes(replacementValue), false);

  // 2. 描述符已取、路径 stat 之前替换：身份绑定必须发现 inode 不一致。
  const duringValidation = runWithPathSwap(
    "fd",
    passwords.backup,
    secretFile(replacementValue),
  );
  assert.notEqual(duringValidation.status, 0, duringValidation.output);
  assert.match(
    duringValidation.output,
    /was replaced while it was being validated/,
  );
  assert.equal(duringValidation.psqlCalls, 0);

  // 3. 换成 symlink 与弱权限文件同样不能被消费。
  const symlinkReplacement = join(workspace, "swap-symlink");
  if (!existsSync(symlinkReplacement)) {
    symlinkSync(secretFile(replacementValue), symlinkReplacement);
  }
  const weakReplacement = secretFile(replacementValue, 0o644);
  for (const replacement of [symlinkReplacement, weakReplacement]) {
    const swapped = runWithPathSwap("fd", passwords.backup, replacement);
    assert.notEqual(swapped.status, 0, swapped.output);
    assert.equal(swapped.psqlCalls, 0);
    assert.equal(swapped.log.includes(replacementValue), false);
  }
});

/**
 * 有界读取：`-f` 粗筛与 `open()` 之间路径被换成**无写端 FIFO**。
 *
 * shell 没有 `O_NONBLOCK`，`exec 9<` 会永久阻塞，因此这是「实现必须自带上界」
 * 唯一的证明方式。注入点仍然是受控 `PATH` 上的 `stat` 包装器：
 * `meal_agent_detect_stat` 探测 `.` 的那一次调用恰好落在粗筛之后、open 之前。
 */
const fifoWrapperDirectory = join(workspace, "fifo-wrapper");
mkdirSync(fifoWrapperDirectory, { recursive: true });
writeFileSync(
  join(fifoWrapperDirectory, "stat"),
  [
    "#!/usr/bin/env bash",
    "set -u",
    'real="/usr/bin/stat"',
    'saw_probe="no"',
    'saw_target="no"',
    'for argument in "$@"; do',
    '  case "$argument" in',
    '    .) saw_probe="yes" ;;',
    '    "$MEAL_AGENT_TEST_TARGET") saw_target="yes" ;;',
    "  esac",
    "done",
    '"$real" "$@"',
    "status=$?",
    "# 一次性：用标记文件保证只替换一次，与平台上 detect_stat 探测几次无关。",
    'if [ "${MEAL_AGENT_TEST_MODE:-}" = "fifo" ] && [ "$saw_probe" = "yes" ] \\',
    '  && [ ! -e "$MEAL_AGENT_TEST_MARKER" ]; then',
    '  : > "$MEAL_AGENT_TEST_MARKER"',
    '  rm -f "$MEAL_AGENT_TEST_TARGET"',
    '  mkfifo "$MEAL_AGENT_TEST_TARGET"',
    '  chmod 600 "$MEAL_AGENT_TEST_TARGET"',
    "fi",
    "# 增长注入：fd 的 fstat 已经取到原始大小，之后把文件撑大。",
    'if [ -n "${MEAL_AGENT_TEST_GROW_BY:-}" ] && [ "$saw_target" = "yes" ] \\',
    '  && [ ! -e "$MEAL_AGENT_TEST_MARKER" ]; then',
    '  : > "$MEAL_AGENT_TEST_MARKER"',
    '  head -c "$MEAL_AGENT_TEST_GROW_BY" /dev/zero | tr "\\0" "x" \\',
    '    >> "$MEAL_AGENT_TEST_TARGET"',
    "fi",
    'exit "$status"',
  ].join("\n"),
);
chmodSync(join(fifoWrapperDirectory, "stat"), 0o755);

let boundedRun = 0;
const runBounded = (
  mode: "fifo" | "grow",
  growBy: number,
): {
  readonly result: LoginsResult;
  readonly elapsedMs: number;
  readonly target: string;
  readonly temporaryDirectory: string;
} => {
  boundedRun += 1;
  const temporaryDirectory = join(workspace, `bounded-tmp-${String(boundedRun)}`);
  mkdirSync(temporaryDirectory, { recursive: true });
  const target = join(workspace, `bounded-target-${String(boundedRun)}`);
  writeFileSync(target, passwords.migration);
  chmodSync(target, 0o600);

  const started = Date.now();
  const result = runLogins({
    PATH: `${fifoWrapperDirectory}:${process.env["PATH"] ?? ""}`,
    // 受控 TMPDIR：用后可以直接断言「没有快照残留」。
    TMPDIR: temporaryDirectory,
    MEAL_AGENT_TEST_MODE: mode === "fifo" ? "fifo" : "",
    ...(mode === "grow" ? { MEAL_AGENT_TEST_GROW_BY: String(growBy) } : {}),
    MEAL_AGENT_TEST_TARGET: target,
    MEAL_AGENT_TEST_MARKER: join(workspace, `bounded-marker-${String(boundedRun)}`),
    MEAL_AGENT_MIGRATION_PASSWORD_FILE: target,
    MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretFile(passwords.runtime),
    MEAL_AGENT_BACKUP_PASSWORD_FILE: secretFile(passwords.backup),
  });
  return {
    result,
    elapsedMs: Date.now() - started,
    target,
    temporaryDirectory,
  };
};

test("a FIFO substituted between the precheck and open fails within a strict bound", () => {
  const { result, elapsedMs, target, temporaryDirectory } = runBounded("fifo", 0);

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /could not be opened and read within 5s/);
  assert.match(result.output, /would otherwise block without a bound/);
  assert.equal(
    result.timedOut,
    false,
    "the implementation must stop itself; the external timeout must never fire",
  );
  assert.equal(
    result.psqlCalls,
    0,
    `a blocked open must not reach psql (got ${String(result.psqlCalls)})`,
  );
  // 实现自己的上界是 5s；只给进程启动与轮询留一点余量，不再放宽到几十秒。
  assert.ok(
    elapsedMs < 10_000,
    `bootstrap must fail close to its own 5s bound, took ${String(elapsedMs)}ms`,
  );
  assertNoSentinel(result.output, "the bounded-open failure output");

  // 没有残留的后台读端：FIFO 没有 reader 时，以 O_WRONLY|O_NONBLOCK 打开必然
  // ENXIO；如果还有一个卡在 open() 里的子进程，这里会成功并把它唤醒。
  assert.equal(statSync(target).isFIFO(), true);
  assert.throws(
    () => {
      const descriptor = openSync(
        target,
        openConstants.O_WRONLY | openConstants.O_NONBLOCK,
      );
      closeSync(descriptor);
    },
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENXIO",
    "no reader may survive the bounded open",
  );

  // 没有快照残留：受控 TMPDIR 里不应剩下任何私有快照目录。
  assert.deepEqual(
    readdirSync(temporaryDirectory).filter((entry) =>
      entry.startsWith("meal-agent-secret."),
    ),
    [],
  );
});

test("a file that grows after its fstat is rejected within the read bound", () => {
  // 1. 长大但仍在上限内：快照字节数与 fstat 的 size 不一致，必须拒绝。
  const modest = runBounded("grow", 32);
  assert.notEqual(modest.result.status, 0, modest.result.output);
  assert.match(modest.result.output, /changed size while it was being read/);
  assert.equal(modest.result.psqlCalls, 0);
  assert.deepEqual(
    readdirSync(modest.temporaryDirectory).filter((entry) =>
      entry.startsWith("meal-agent-secret."),
    ),
    [],
  );

  // 2. 长大到超过上限：读取本身就被 `head -c` 截在 4097 字节，因此是**有界**
  //    拒绝，而不是先把任意大小读进磁盘再判断。
  const oversized = runBounded("grow", 8192);
  assert.notEqual(oversized.result.status, 0, oversized.result.output);
  assert.match(oversized.result.output, /grew past 4096 bytes/);
  assert.equal(oversized.result.psqlCalls, 0);
  assert.deepEqual(
    readdirSync(oversized.temporaryDirectory).filter((entry) =>
      entry.startsWith("meal-agent-secret."),
    ),
    [],
  );
});

test("a byte order mark anywhere in the value is rejected on both sources", () => {
  // Node 侧与 shell 侧此前只查开头，中间藏一个 U+FEFF 会被放行——两条实现
  // 因此在同一份取值上给出不同结论。现在两侧都按「任何位置」判定。
  const withInternalMark = `meal${"\uFEFF"}agent`;
  for (const [label, environment] of [
    [
      "file",
      {
        MEAL_AGENT_MIGRATION_PASSWORD_FILE: secretFile(withInternalMark),
        MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretFile(passwords.runtime),
        MEAL_AGENT_BACKUP_PASSWORD_FILE: secretFile(passwords.backup),
      },
    ],
    [
      "direct",
      {
        MEAL_AGENT_MIGRATION_PASSWORD: withInternalMark,
        MEAL_AGENT_RUNTIME_PASSWORD: passwords.runtime,
        MEAL_AGENT_BACKUP_PASSWORD: passwords.backup,
      },
    ],
  ] as const) {
    const result = runLogins(environment);
    assert.notEqual(result.status, 0, `${label}: ${result.output}`);
    assert.match(result.output, /contains a byte order mark/, label);
    assert.equal(result.psqlCalls, 0, label);
  }

  // 结尾处的 U+FEFF 同样拒绝（此前也只有开头被覆盖）。
  const trailingMark = runLogins({
    MEAL_AGENT_MIGRATION_PASSWORD_FILE: secretFile(`meal-agent${"\uFEFF"}`),
    MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretFile(passwords.runtime),
    MEAL_AGENT_BACKUP_PASSWORD_FILE: secretFile(passwords.backup),
  });
  assert.notEqual(trailingMark.status, 0, trailingMark.output);
  assert.match(trailingMark.output, /contains a byte order mark/);
  assert.equal(trailingMark.psqlCalls, 0);
});

/**
 * 复制阶段被拖住，而且拖住它的**后代进程忽略 TERM**。
 *
 * 这一条与 FIFO 那一条覆盖的是不同的失败位置：FIFO 卡在 `open()`，这里卡在
 * `head` 的读取。它要证明的是清理范围——超时必须收掉**整棵**受控子树，而不是
 * 只 kill worker 这一个 PID 把后代留成孤儿（后者实测会让被阻塞的 head 存活）。
 */
const stallWrapperDirectory = join(workspace, "stall-wrapper");
mkdirSync(stallWrapperDirectory, { recursive: true });
writeFileSync(
  join(stallWrapperDirectory, "head"),
  [
    "#!/usr/bin/env bash",
    "set -u",
    'if [ -n "${MEAL_AGENT_TEST_STALL:-}" ] && [ ! -e "$MEAL_AGENT_TEST_STALL_MARKER" ]; then',
    '  : > "$MEAL_AGENT_TEST_STALL_MARKER"',
    '  printf "%s" "$$" > "$MEAL_AGENT_TEST_STALL_PID"',
    '  printf "%s" "$PPID" > "$MEAL_AGENT_TEST_STALL_PPID"',
    "  # 第三层：wrapper 自己派生的 sleep。清理必须一直收到这一层。",
    "  sleep 600 &",
    '  printf "%s" "$!" > "$MEAL_AGENT_TEST_STALL_SLEEP_PID"',
    "  # 忽略 TERM：只有 KILL 才收得掉，因此清理必须补一发 KILL。",
    "  trap '' TERM",
    "  wait",
    "  exit 0",
    "fi",
    'exec /usr/bin/head "$@"',
  ].join("\n"),
);
chmodSync(join(stallWrapperDirectory, "head"), 0o755);

/** 本用例自己拉起来的进程，测试结束时无论成败都要收干净。 */
const spawnedByStallTest: number[] = [];
after(() => {
  for (const pid of spawnedByStallTest) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经退出。
    }
  }
});

const processIsGone = (pid: number): boolean => {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    // 同步轮询：被 KILL 的进程要等父进程回收，给它一点时间。
    execFileSync("sleep", ["0.1"]);
  }
};

test("a stalled copy that ignores TERM is killed together with its descendants", () => {
  const temporaryDirectory = join(workspace, "stall-tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  const stallPidFile = join(workspace, "stall.pid");
  const stallPpidFile = join(workspace, "stall.ppid");
  const stallSleepPidFile = join(workspace, "stall.sleep.pid");

  const started = Date.now();
  const result = runLogins({
    PATH: `${stallWrapperDirectory}:${process.env["PATH"] ?? ""}`,
    TMPDIR: temporaryDirectory,
    MEAL_AGENT_TEST_STALL: "1",
    MEAL_AGENT_TEST_STALL_MARKER: join(workspace, "stall.marker"),
    MEAL_AGENT_TEST_STALL_PID: stallPidFile,
    MEAL_AGENT_TEST_STALL_PPID: stallPpidFile,
    MEAL_AGENT_TEST_STALL_SLEEP_PID: stallSleepPidFile,
    MEAL_AGENT_MIGRATION_PASSWORD_FILE: secretFile(passwords.migration),
    MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretFile(passwords.runtime),
    MEAL_AGENT_BACKUP_PASSWORD_FILE: secretFile(passwords.backup),
  });
  const elapsedMs = Date.now() - started;

  const stalledPid = Number(readFileSync(stallPidFile, "utf8"));
  const workerPid = Number(readFileSync(stallPpidFile, "utf8"));
  const sleepPid = Number(readFileSync(stallSleepPidFile, "utf8"));
  spawnedByStallTest.push(stalledPid, workerPid, sleepPid);

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /could not be opened and read within 5s/);
  assert.equal(
    result.timedOut,
    false,
    "the implementation must stop itself; the external timeout must never fire",
  );
  assert.ok(
    elapsedMs < 10_000,
    `bootstrap must fail close to its own 5s bound, took ${String(elapsedMs)}ms`,
  );
  assert.equal(result.psqlCalls, 0);
  assertNoSentinel(result.output, "the stalled-copy failure output");
  assertNoSentinel(result.log, "the recorded psql argv");

  // worker 与**全部后代**都必须消失，即使后代忽略了 TERM。
  assert.ok(
    processIsGone(stalledPid),
    `the stalled descendant ${String(stalledPid)} must be killed`,
  );
  assert.ok(
    processIsGone(workerPid),
    `the worker ${String(workerPid)} must be killed`,
  );
  // 第三层同样要收掉：只收 worker 与 wrapper 会把 sleep 留成孤儿。
  assert.ok(
    processIsGone(sleepPid),
    `the sleep grandchild ${String(sleepPid)} must be killed`,
  );

  // 没有快照残留。
  assert.deepEqual(
    readdirSync(temporaryDirectory).filter((entry) =>
      entry.startsWith("meal-agent-secret."),
    ),
    [],
  );
});

/**
 * 外部信号（SIGTERM 发给 bootstrap **父进程**）。
 *
 * 与内部超时那一条互补：超时是 bootstrap 自己决定收手，这里是别人来收它。
 * 两者共用同一段 worker-group 清理，因此这条用例证明的是「共用」确实成立——
 * 修复前 bootstrap 死了而 worker/head/sleep 三层全部存活。
 */
const signalWrapperDirectory = join(workspace, "signal-wrapper");
mkdirSync(signalWrapperDirectory, { recursive: true });
writeFileSync(
  join(signalWrapperDirectory, "head"),
  [
    "#!/usr/bin/env bash",
    "set -u",
    'if [ ! -e "$MEAL_AGENT_TEST_SIGNAL_MARKER" ]; then',
    '  : > "$MEAL_AGENT_TEST_SIGNAL_MARKER"',
    '  printf "%s" "$$" > "$MEAL_AGENT_TEST_SIGNAL_HEAD"',
    '  printf "%s" "$PPID" > "$MEAL_AGENT_TEST_SIGNAL_WORKER"',
    "  # 真实的 FIFO reader：read-write 打开不会阻塞，但只要本进程活着，",
    "  # 以 O_WRONLY|O_NONBLOCK 打开该 FIFO 就不会 ENXIO。",
    '  exec 7<> "$MEAL_AGENT_TEST_SIGNAL_FIFO"',
    "  sleep 600 &",
    '  printf "%s" "$!" > "$MEAL_AGENT_TEST_SIGNAL_SLEEP"',
    "  trap '' TERM",
    "  wait",
    "  exit 0",
    "fi",
    'exec /usr/bin/head "$@"',
  ].join("\n"),
);
chmodSync(join(signalWrapperDirectory, "head"), 0o755);

const spawnedBySignalTest: number[] = [];
after(() => {
  for (const pid of spawnedBySignalTest) {
    // 先按进程组收，再按单个 PID 兜底；两者都可能已经不存在。
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // 已经退出。
      }
    }
  }
});

test("an external SIGTERM tears down the whole controlled subtree", async () => {
  const temporaryDirectory = join(workspace, "signal-tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  const fifo = join(workspace, "signal-fifo");
  if (!existsSync(fifo)) {
    execFileSync("mkfifo", [fifo]);
  }
  const headFile = join(workspace, "signal.head.pid");
  const workerFile = join(workspace, "signal.worker.pid");
  const sleepFile = join(workspace, "signal.sleep.pid");
  const logPath = join(workspace, "signal-psql.log");
  writeFileSync(logPath, "");

  const child = spawn(
    "bash",
    [bootstrapScript, "logins", "--maintenance-db", "postgres"],
    {
      // 独立进程组：测试收尾时可以整组清理，不依赖单个 PID。
      detached: true,
      env: {
        PATH: `${signalWrapperDirectory}:${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"] ?? "",
        TMPDIR: temporaryDirectory,
        PSQL: fakePsql,
        MEAL_AGENT_FAKE_PSQL_LOG: logPath,
        MEAL_AGENT_TEST_SIGNAL_MARKER: join(workspace, "signal.marker"),
        MEAL_AGENT_TEST_SIGNAL_HEAD: headFile,
        MEAL_AGENT_TEST_SIGNAL_WORKER: workerFile,
        MEAL_AGENT_TEST_SIGNAL_SLEEP: sleepFile,
        MEAL_AGENT_TEST_SIGNAL_FIFO: fifo,
        MEAL_AGENT_MIGRATION_PASSWORD_FILE: secretFile(passwords.migration),
        MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretFile(passwords.runtime),
        MEAL_AGENT_BACKUP_PASSWORD_FILE: secretFile(passwords.backup),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const bootstrapPid = child.pid ?? 0;
  spawnedBySignalTest.push(bootstrapPid);

  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));

  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  try {
    // 等三层 PID 全部出现，再发信号——否则测的可能是「还没来得及起来」。
    const deadline = Date.now() + 20_000;
    while (!existsSync(sleepFile)) {
      if (Date.now() >= deadline) {
        throw new Error("the stall wrapper never reached the copy stage");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const headPid = Number(readFileSync(headFile, "utf8"));
    const workerPid = Number(readFileSync(workerFile, "utf8"));
    const sleepPid = Number(readFileSync(sleepFile, "utf8"));
    spawnedBySignalTest.push(headPid, workerPid, sleepPid);

    // 只有 reader 还在时，以 O_WRONLY|O_NONBLOCK 打开 FIFO 才不会 ENXIO。
    const writer = openSync(
      fifo,
      openConstants.O_WRONLY | openConstants.O_NONBLOCK,
    );
    closeSync(writer);

    process.kill(bootstrapPid, "SIGTERM");
    const result = await exited;

    // 正确的信号退出语义：被 SIGTERM 结束，而不是一个普通退出码。
    assert.equal(result.signal, "SIGTERM", `unexpected exit ${String(result.code)}`);

    // bootstrap、worker、head、sleep 四层都必须消失。
    for (const [label, pid] of [
      ["bootstrap", bootstrapPid],
      ["worker", workerPid],
      ["head", headPid],
      ["sleep", sleepPid],
    ] as const) {
      assert.ok(
        processIsGone(pid),
        `${label} ${String(pid)} must be gone after the external SIGTERM`,
      );
    }

    // 没有残留的 FIFO reader。
    assert.throws(
      () => {
        const descriptor = openSync(
          fifo,
          openConstants.O_WRONLY | openConstants.O_NONBLOCK,
        );
        closeSync(descriptor);
      },
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENXIO",
      "no FIFO reader may survive the signal cleanup",
    );

    const log = readFileSync(logPath, "utf8");
    assert.equal(
      log.split("\n").filter((line) => line.startsWith("ARGV")).length,
      0,
      "a signalled run must never reach psql",
    );
    assertNoSentinel(output, "the signalled bootstrap output");
    assertNoSentinel(log, "the recorded psql argv");
    assert.deepEqual(
      readdirSync(temporaryDirectory).filter((entry) =>
        entry.startsWith("meal-agent-secret."),
      ),
      [],
    );
  } finally {
    try {
      process.kill(-bootstrapPid, "SIGKILL");
    } catch {
      // 进程组已经消失。
    }
  }
});
