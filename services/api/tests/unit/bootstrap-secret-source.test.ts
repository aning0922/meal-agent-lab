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
const secretFile = (contents: string | Uint8Array, mode = 0o600): string => {
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
    [
      ...bashArguments,
      bootstrapScript,
      "logins",
      "--maintenance-db",
      "postgres",
    ],
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
    [
      "directory",
      fileEnvironment({ backup: directory }),
      /is not a regular file/,
    ],
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
    ["newline only", fileEnvironment({ backup: secretFile("\n") }), /is empty/],
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
        backup: secretFile(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0x62])),
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
    [
      "embedded newline",
      `${passwords.backup}\nsecond`,
      /must contain a single line/,
    ],
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
    "swap() {",
    '  if [ -e "$MEAL_AGENT_TEST_SWAP_FROM" ]; then',
    '    mv -f "$MEAL_AGENT_TEST_SWAP_FROM" "$MEAL_AGENT_TEST_SWAP_TO"',
    "  fi",
    "}",
    "# 第 N 次被问到某一类对象之后才动手，因此注入点在时间上是确定的。",
    "armed() {",
    "  local seen",
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
    "status=$?",
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
  const temporaryDirectory = join(
    workspace,
    `bounded-tmp-${String(boundedRun)}`,
  );
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
    MEAL_AGENT_TEST_MARKER: join(
      workspace,
      `bounded-marker-${String(boundedRun)}`,
    ),
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
  const { result, elapsedMs, target, temporaryDirectory } = runBounded(
    "fifo",
    0,
  );

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
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENXIO",
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

/**
 * 本用例自己拉起来的进程。用例的 finally 收完就**立刻清空**：PID 会被系统回收
 * 再分配，把已经死掉的 PID 长期留在文件级 after 里，等到 after 执行时 kill 过去
 * 就是在杀别人的进程。这个数组在正常路径下退出用例时永远是空的。
 */
const spawnedByStallTest: number[] = [];
after(() => {
  for (const pid of spawnedByStallTest) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经退出。
    }
  }
  spawnedByStallTest.length = 0;
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

  try {
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
  } finally {
    // 有界清理：worker 是 `set -m` 造出来的组长，因此它的 PID 就是真实 PGID；
    // stalled head 与 sleep 不是组长，只按单个 PID 收。
    try {
      process.kill(-workerPid, "SIGKILL");
    } catch {
      // 进程组已经消失。
    }
    for (const pid of [stalledPid, sleepPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已经退出。
      }
    }
    spawnedByStallTest.length = 0;
  }
});

// ---------------------------------------------------------------------------
// 外部信号：证据必须来自实现，不能来自测试自己的清理
// ---------------------------------------------------------------------------
//
// 这一组与 `infra/docker/postgres/signal-matrix.sh` 分工明确：
//
//   - 矩阵负责**语义广度**（四种调用方处置 × 三个信号 × starting/terminating 两个
//     窗口 × first-wins × EXIT trap 链式执行），并在 macOS/bash 3.2 与钉住 digest
//     的 Debian/bash 5.2 两侧各跑一遍，由 `bootstrap-signal-matrix.test.ts` 纳入门禁；
//   - 这里负责**这个测试进程才能拿到的证据**：FIFO 读端是否真的没了
//     （`O_WRONLY|O_NONBLOCK` 必然 `ENXIO`）、psql 调用次数是否为 0、真实
//     bootstrap.sh 的输出里是否有 sentinel，以及 harness 自身的 failure-safe。
//
// 最要紧的一条纪律：**断言先于清理**。所有关于「实现留下了什么」的观察都在
// `finally` 之前完成并冻结；`finally` 只是兜底，不改变被测事实。上一轮不是这样：
// 清理在 `runSignalScenario` 返回**之前**就 SIGKILL 掉了整棵子树，于是用例后面
// 那句 `processIsGone(...)` 证明的其实是「测试自己把它杀了」。

const secretSourceScript = join(
  repositoryRoot,
  "infra/docker/postgres/secret-source.sh",
);

const signalWrapperDirectory = join(workspace, "signal-wrapper");
mkdirSync(signalWrapperDirectory, { recursive: true });
writeFileSync(
  join(signalWrapperDirectory, "head"),
  [
    "#!/usr/bin/env bash",
    "set -u",
    'if [ ! -e "$MEAL_AGENT_TEST_SIGNAL_MARKER" ]; then',
    '  : > "$MEAL_AGENT_TEST_SIGNAL_MARKER"',
    // head 与它派生的孙进程**都**忽略 TERM/INT/HUP。忽略要在 fork 之前设好，
    // 这样 sleep 会把 SIG_IGN 一起继承下去——于是「TERM 就够了」这条捷径被彻底
    // 堵死，只有对整个进程组补一发 KILL 才收得干净。
    "  trap '' TERM INT HUP",
    '  printf "%s" "$$" > "$MEAL_AGENT_TEST_SIGNAL_HEAD"',
    '  printf "%s" "$PPID" > "$MEAL_AGENT_TEST_SIGNAL_WORKER"',
    "  # 交出 bootstrap 的 stdout/stderr。不这么做的话，「受控子树还活着」与",
    "  # 「管道还没关」就永远绑在一起：任何清理缺陷都只会表现成 harness 的 12 秒",
    "  # 硬上界，掩盖掉「进程确实泄漏了」这个真正要证明的事实。断开之后，两件事",
    "  # 才是各自独立、各自可断言的。",
    "  exec > /dev/null 2>&1",
    "  # 真实的 FIFO reader：read-write 打开不会阻塞，但只要本进程活着，",
    "  # 以 O_WRONLY|O_NONBLOCK 打开该 FIFO 就不会 ENXIO。",
    '  exec 7<> "$MEAL_AGENT_TEST_SIGNAL_FIFO"',
    "  sleep 600 &",
    '  printf "%s" "$!" > "$MEAL_AGENT_TEST_SIGNAL_SLEEP"',
    "  wait",
    "  exit 0",
    "fi",
    'exec /usr/bin/head "$@"',
  ].join("\n"),
);
chmodSync(join(signalWrapperDirectory, "head"), 0o755);

const readPidFile = (path: string): number | undefined => {
  if (!existsSync(path)) {
    return undefined;
  }
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

/** 一次进程表快照。`ps -A -o pid=,ppid=,pgid=` 在 macOS 与 Linux 上写法相同。 */
const processTable = (): readonly ProcessRow[] => {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], {
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (parts): parts is [number, number, number] =>
        parts.length === 3 && parts.every((n) => Number.isInteger(n)),
    )
    .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
};

/**
 * 从 root 出发广度优先枚举当前还活着的后代。
 *
 * **只在 root 还活着的时候有意义**：root 一死，它的孩子立刻被 reparent 到 pid 1，
 * 从 root 出发就再也走不到它们。所以「清理干净了没有」不能靠 root 死后再枚举一次
 * ——那个检查恒为空，等于测试自己满足了自己。真正的判据是对**存活期间采样到的
 * PID 集合**逐个做有界确认。
 */
const descendantsOf = (root: number): readonly ProcessRow[] => {
  const table = processTable();
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of table) {
    const bucket = byParent.get(row.ppid);
    if (bucket === undefined) {
      byParent.set(row.ppid, [row]);
    } else {
      bucket.push(row);
    }
  }
  const found: ProcessRow[] = [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift() as number) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
};

/** 对一批 PID 逐个做有界确认，返回仍然存活的那些。 */
const residualOf = async (
  pids: Iterable<number>,
  budgetMs = 3_000,
): Promise<readonly number[]> => {
  const remaining: number[] = [];
  for (const pid of pids) {
    if (!(await awaitGone(pid, budgetMs))) {
      remaining.push(pid);
    }
  }
  return remaining;
};

const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/** 有界确认一个 PID 真的消失了。实现可以慢一点回收，但不能无限期。 */
const awaitGone = async (pid: number, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (processIsGone(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await pause(25);
  }
};

/** FIFO 是否还有读端。只要还有一个 reader 活着，这次 open 就不会 ENXIO。 */
const fifoHasReader = (fifo: string): boolean => {
  try {
    closeSync(
      openSync(fifo, openConstants.O_WRONLY | openConstants.O_NONBLOCK),
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENXIO") {
      return false;
    }
    throw error;
  }
};

/**
 * 只登记**当前还可能活着**的进程组，用例自己的 finally 清理完就立刻注销。
 *
 * 文件级 `after` 里不能长期堆积已经死掉的 PID：PID 会被系统回收再分配，等到
 * `after` 执行时 kill 过去就是在杀别人的进程。这个集合在正常路径下永远是空的，
 * 它只兜底「用例在 finally 之前就抛了」。
 */
const liveSignalGroups = new Set<number>();
after(() => {
  for (const pgid of liveSignalGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 进程组已经消失。
    }
  }
  liveSignalGroups.clear();
});

/** 整个外部信号用例的**硬上界**：绝不出现裸 `await`，挂死一律变成确定失败。 */
const withHardCap = async <T>(work: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label} did not finish within ${String(externalTimeoutMs)}ms`,
            ),
          );
        }, externalTimeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

interface SignalScenario {
  /** 文件名前缀，必须逐个用例唯一。 */
  readonly slot: string;
  /** 依次投递的信号。 */
  readonly signals: readonly NodeJS.Signals[];
  /**
   * 第二个信号落在哪里。`terminating` 由**实现暴露的 marker** 决定，不是猜时间：
   * 实现进入 TERM→KILL 之间的窗口时创建 marker 文件并有界等待 release 文件。
   */
  readonly secondSignalWindow?: "terminating";
  /** true 走调用方驱动脚本（自带 trap），false 走 bootstrap.sh。 */
  readonly callerTraps: boolean;
  /** false 时不挂 stall wrapper，用于「正常完成后 trap 仍被还回去」。 */
  readonly stall: boolean;
}

/**
 * 已经**冻结**的观察结果。每一项都在 finally 之前采集完毕，因此它描述的是实现
 * 留下的状态，而不是清理之后的状态。
 */
interface SignalOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly log: string;
  readonly leftovers: readonly string[];
  readonly fifoReaderSurvived: boolean;
  readonly stillAlive: readonly string[];
  readonly recorded: readonly string[];
  readonly residualDescendants: readonly number[];
}

const runSignalScenario = async (
  scenario: SignalScenario,
): Promise<SignalOutcome> => {
  const temporaryDirectory = join(workspace, `${scenario.slot}-tmp`);
  mkdirSync(temporaryDirectory, { recursive: true });
  const markerDirectory = join(workspace, `${scenario.slot}-markers`);
  mkdirSync(markerDirectory, { recursive: true });
  // 这一组用例只针对 terminating 窗口。starting 的 release 预先放好，否则实现会在
  // 那里白白等满自己的 5 秒上界——三份口令就是 19.5 秒，直接顶穿 12 秒硬上界。
  writeFileSync(join(markerDirectory, "starting.release"), "");
  const fifo = join(workspace, `${scenario.slot}.fifo`);
  if (!existsSync(fifo)) {
    execFileSync("mkfifo", [fifo]);
  }
  const headFile = join(workspace, `${scenario.slot}.head.pid`);
  const workerFile = join(workspace, `${scenario.slot}.worker.pid`);
  const sleepFile = join(workspace, `${scenario.slot}.sleep.pid`);
  const logPath = join(workspace, `${scenario.slot}.psql.log`);
  writeFileSync(logPath, "");

  /**
   * 在等待期间持续累积「见过的后代与它们的真实 pgid」。
   *
   * hard-cap 在 worker 把自己的 PID 写进文件**之前**就到期时，PID 文件是空的，
   * 而 worker 在 `set -m` 下是**独立**进程组的组长——它的 pgid 既不是 bootstrap
   * 的，也无从从文件里读到。这份持续快照就是那种情况下唯一能收干净的依据。
   */
  const observedPids = new Set<number>();
  const observedGroups = new Set<number>();
  const sampleDescendants = (root: number): void => {
    for (const row of descendantsOf(root)) {
      observedPids.add(row.pid);
      observedGroups.add(row.pgid);
    }
  };

  const basePath = process.env["PATH"] ?? "";
  const child = spawn(
    "bash",
    scenario.callerTraps
      ? [signalDriver]
      : [bootstrapScript, "logins", "--maintenance-db", "postgres"],
    {
      // 独立进程组：收尾时可以整组清理，不依赖单个 PID。
      detached: true,
      env: {
        PATH: scenario.stall
          ? `${signalWrapperDirectory}:${basePath}`
          : basePath,
        HOME: process.env["HOME"] ?? "",
        TMPDIR: temporaryDirectory,
        PSQL: fakePsql,
        MEAL_AGENT_FAKE_PSQL_LOG: logPath,
        MEAL_AGENT_SECRET_SOURCE: secretSourceScript,
        // 只有需要精确投递的用例才打开窗口 marker；其余用例保持生产形态（未设置
        // 时实现里那两个函数是纯空操作）。
        ...(scenario.secondSignalWindow === undefined
          ? {}
          : { MEAL_AGENT_SECRET_WINDOW_MARKER_DIR: markerDirectory }),
        MEAL_AGENT_TEST_SIGNAL_MARKER: join(
          workspace,
          `${scenario.slot}.marker`,
        ),
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

  // pid 必须是**真实的正整数**：`spawn` 失败时 `child.pid` 是 undefined，而
  // `?? 0` 之后的 `kill(-0, …)` 会把信号发给**测试进程自己所在的进程组**。
  const bootstrapPid = child.pid;
  assert.equal(
    typeof bootstrapPid === "number" &&
      Number.isInteger(bootstrapPid) &&
      bootstrapPid > 0,
    true,
    `${scenario.slot}: spawn must report a positive integer pid`,
  );
  const groupLeader = bootstrapPid as number;
  liveSignalGroups.add(groupLeader);
  observedGroups.add(groupLeader);

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  // 等 `close` 而不是 `exit`：只有 close 才保证 stdout/stderr 已经排空。用 exit
  // 去扫 sentinel，扫的可能是**还没读完**的输出，那种「通过」是假的。
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });

  try {
    return await withHardCap(
      (async (): Promise<SignalOutcome> => {
        if (scenario.stall) {
          // 等三层 PID 全部出现再发信号，否则测的可能是「还没来得及起来」。
          //
          // 循环自己也必须有界。`withHardCap` 是 `Promise.race`，它**不会取消**
          // 输掉的那一侧：一个无界的轮询循环会在断言失败之后继续排定计时器，于是
          // 断言红了、进程却永远不退出，连测试摘要都打不出来。
          const stallDeadline = Date.now() + externalTimeoutMs;
          while (readPidFile(sleepFile) === undefined) {
            if (Date.now() >= stallDeadline) {
              throw new Error(
                `${scenario.slot}: the stall wrapper never reached the copy stage`,
              );
            }
            sampleDescendants(groupLeader);
            await pause(25);
          }
          sampleDescendants(groupLeader);

          // 只有 reader 还在时，以 O_WRONLY|O_NONBLOCK 打开 FIFO 才不会 ENXIO。
          // 这是「实现清理之前确实有一个读端」的正向证据。
          assert.equal(
            fifoHasReader(fifo),
            true,
            `${scenario.slot}: the stalled head must hold the FIFO open before the signal`,
          );

          for (const [index, signal] of scenario.signals.entries()) {
            if (index > 0 && scenario.secondSignalWindow === "terminating") {
              // 确定地落进 terminating：实现在 TERM 已发、KILL 未发时创建
              // marker 并有界等待 release。等到 marker 才发第二个信号。
              const markerDeadline = Date.now() + externalTimeoutMs;
              while (!existsSync(join(markerDirectory, "terminating"))) {
                if (Date.now() >= markerDeadline) {
                  throw new Error(
                    `${scenario.slot}: the terminating marker never appeared`,
                  );
                }
                await pause(10);
              }
            }
            process.kill(groupLeader, signal);
          }
          if (scenario.secondSignalWindow === "terminating") {
            writeFileSync(join(markerDirectory, "terminating.release"), "");
          }
        }
        const result = await closed;

        // --- 观察窗口：全部在 finally 之前完成，结果冻结进 outcome -----------
        const recorded: string[] = [];
        const stillAlive: string[] = [];
        for (const [label, path] of [
          ["worker", workerFile],
          ["head", headFile],
          ["sleep", sleepFile],
        ] as const) {
          const pid = readPidFile(path);
          if (pid === undefined) {
            continue;
          }
          recorded.push(label);
          observedPids.add(pid);
          // 有界确认：父进程退出之后实现仍可能在回收，但必须有界。
          if (!(await awaitGone(pid, 3_000))) {
            stillAlive.push(`${label} ${String(pid)}`);
          }
        }
        if (!(await awaitGone(groupLeader, 3_000))) {
          stillAlive.push(`bootstrap ${String(groupLeader)}`);
        }

        return {
          ...result,
          output,
          log: readFileSync(logPath, "utf8"),
          leftovers: readdirSync(temporaryDirectory).filter((entry) =>
            entry.startsWith("meal-agent-secret."),
          ),
          fifoReaderSurvived: fifoHasReader(fifo),
          stillAlive,
          recorded,
          // 对**采样期间见过的每一个后代**逐个有界确认，而不是在 root 死后再从
          // 它出发枚举一次（那样恒为空）。
          residualDescendants: await residualOf(observedPids),
        };
      })(),
      `${scenario.slot}: the external signal case`,
    );
  } finally {
    // 兜底清理。它排在**全部观察之后**，因此不可能替实现把断言弄绿。
    //
    // hard-cap 路径也必须能收干净：worker 的 pgid 可能从来没被写进文件，所以这里
    // 用等待期间持续采样得到的**真实 pgid** 集合，而不是只认 PID 文件。
    sampleDescendants(groupLeader);
    for (const pgid of observedGroups) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // 进程组已经消失。
      }
    }
    const worker = readPidFile(workerFile);
    if (worker !== undefined) {
      try {
        process.kill(-worker, "SIGKILL");
      } catch {
        // 进程组已经消失。
      }
    }
    for (const pid of observedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已经退出。
      }
    }
    liveSignalGroups.delete(groupLeader);
    child.stdout.destroy();
    child.stderr.destroy();
  }
};

const assertControlledSubtreeGone = (outcome: SignalOutcome): void => {
  assert.deepEqual(
    [...outcome.recorded].sort(),
    ["head", "sleep", "worker"],
    "all three controlled layers must have recorded themselves",
  );
  assert.deepEqual(
    outcome.stillAlive,
    [],
    "the implementation must have collected the whole controlled subtree",
  );
  assert.deepEqual(
    outcome.residualDescendants,
    [],
    "no descendant of bootstrap may survive",
  );
  assert.equal(
    outcome.fifoReaderSurvived,
    false,
    "no FIFO reader may survive the signal cleanup",
  );
  assert.equal(
    outcome.log.split("\n").filter((line) => line.startsWith("ARGV")).length,
    0,
    "a signalled run must never reach psql",
  );
  assertNoSentinel(outcome.output, "the signalled bootstrap output");
  assertNoSentinel(outcome.log, "the recorded psql argv");
  assert.deepEqual(outcome.leftovers, []);
};

for (const [signal, slot] of [
  ["SIGTERM", "signal-term"],
  ["SIGINT", "signal-int"],
  ["SIGHUP", "signal-hup"],
] as const) {
  test(`an external ${signal} tears down the whole controlled subtree`, async () => {
    const outcome = await runSignalScenario({
      slot,
      signals: [signal],
      callerTraps: false,
      stall: true,
    });

    // 正确的信号退出语义：被同一个信号结束，而不是一个普通退出码。
    assert.equal(
      outcome.signal,
      signal,
      `unexpected exit ${String(outcome.code)} / ${String(outcome.signal)}`,
    );
    assertControlledSubtreeGone(outcome);
  });
}

test("a second signal lands inside the terminating window and loses", async () => {
  // HUP 的投递点由**实现暴露的 marker** 决定：TERM 已发、KILL 未发。上一轮是
  // 「sleep 100ms 然后但愿它落在 0.2s 窗口里」，那种绿证明不了任何事。
  // 裁决是先到者胜，因此退出语义仍然是 SIGTERM。
  const outcome = await runSignalScenario({
    slot: "signal-term-then-hup",
    signals: ["SIGTERM", "SIGHUP"],
    secondSignalWindow: "terminating",
    callerTraps: false,
    stall: true,
  });

  assert.equal(
    outcome.signal,
    "SIGTERM",
    `first-wins: the winner must stay SIGTERM, got ${String(outcome.signal)} / ${String(outcome.code)}`,
  );
  assertControlledSubtreeGone(outcome);
});

test("the hard cap still collects a worker whose pid file never appeared", async () => {
  // 反过来验证 harness 自己：worker 在**记录自己之前**就被拦住时，PID 文件是空的，
  // 而 worker 在 `set -m` 下是独立进程组的组长。这条用例证明兜底清理不依赖 PID
  // 文件——它用的是等待期间持续采样得到的真实 pgid，并在最后有界确认无残留。
  const temporaryDirectory = join(workspace, "signal-nopid-tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  const logPath = join(workspace, "signal-nopid.psql.log");
  writeFileSync(logPath, "");
  // 直接把 FIFO 当 `*_FILE` 传是没用的：粗筛的 `-f` 会在起 worker 之前就拒掉它。
  // 这里复用已有的 stat wrapper，在粗筛之后、`open()` 之前把常规文件换成无写端的
  // FIFO——worker 因此**确实存在**、卡在 `exec 9<` 上，而且永远走不到复制阶段，
  // 也就永远不会写出任何 PID 文件。
  const target = join(workspace, "signal-nopid-target");
  writeFileSync(target, passwords.migration);
  chmodSync(target, 0o600);

  const child = spawn(
    "bash",
    [bootstrapScript, "logins", "--maintenance-db", "postgres"],
    {
      detached: true,
      env: {
        PATH: `${fifoWrapperDirectory}:${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"] ?? "",
        TMPDIR: temporaryDirectory,
        PSQL: fakePsql,
        MEAL_AGENT_FAKE_PSQL_LOG: logPath,
        MEAL_AGENT_TEST_MODE: "fifo",
        MEAL_AGENT_TEST_TARGET: target,
        MEAL_AGENT_TEST_MARKER: join(workspace, "signal-nopid-marker"),
        MEAL_AGENT_MIGRATION_PASSWORD_FILE: target,
        MEAL_AGENT_RUNTIME_PASSWORD_FILE: secretFile(passwords.runtime),
        MEAL_AGENT_BACKUP_PASSWORD_FILE: secretFile(passwords.backup),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const groupLeader = child.pid as number;
  assert.equal(
    Number.isInteger(groupLeader) && groupLeader > 0,
    true,
    "spawn must report a positive integer pid",
  );
  liveSignalGroups.add(groupLeader);

  const observedGroups = new Set<number>([groupLeader]);
  const observedPids = new Set<number>();
  try {
    // 等 worker 真的存在（它是 bootstrap 的后代，且自成进程组）。
    const deadline = Date.now() + 5_000;
    let sawSeparateGroup = false;
    while (Date.now() < deadline) {
      for (const row of descendantsOf(groupLeader)) {
        observedPids.add(row.pid);
        observedGroups.add(row.pgid);
        if (row.pgid !== groupLeader) {
          sawSeparateGroup = true;
        }
      }
      if (sawSeparateGroup) {
        break;
      }
      await pause(25);
    }
    assert.equal(
      sawSeparateGroup,
      true,
      "the worker must run in its own process group",
    );
    // 这条用例的前提是「worker 存在但还没走到会写 PID 文件的那一步」。检查一个
    // 谁都不会写的路径是重言式，没有信息量；真正要证明的是**兜底清理的依据只能
    // 来自采样**：观察到的进程组里必须有一个不是 bootstrap 自己的。
    assert.ok(
      [...observedGroups].some((pgid) => pgid !== groupLeader),
      "the fallback must have a real worker pgid that no pid file could provide",
    );
  } finally {
    for (const pgid of observedGroups) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // 已经消失。
      }
    }
    for (const pid of observedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已经退出。
      }
    }
    liveSignalGroups.delete(groupLeader);
    child.stdout.destroy();
    child.stderr.destroy();
  }

  // 有界确认：兜底清理之后，**采样期间见过的每一个 PID** 都不剩。用
  // descendantsOf(groupLeader) 是不行的——bootstrap 已经死了，孤儿被 reparent 到
  // pid 1，从它出发枚举恒为空，那个断言证明不了任何事。
  assert.ok(
    observedPids.size > 0,
    "the sampling must actually have seen the worker subtree",
  );
  assert.deepEqual(
    await residualOf(observedPids, 5_000),
    [],
    "the pgid-based fallback cleanup must leave nothing behind",
  );
});

/**
 * 调用方驱动脚本：在 source 之前就装好自己的 TERM/INT/HUP 与 EXIT trap，并把
 * 解析结束后的 `trap -p` 打出来。
 *
 * 更宽的处置矩阵（default / exit / return / ignore × 三个信号 × 两个窗口）由
 * `infra/docker/postgres/signal-matrix.sh` 覆盖，并在钉住 digest 的容器里也跑
 * 一遍；这里只保留「归还」这一条，用来和上面那些真实 bootstrap.sh 的用例共用
 * 同一套 failure-safe harness。
 */
const signalDriver = join(workspace, "signal-driver.sh");
writeFileSync(
  signalDriver,
  [
    "#!/usr/bin/env bash",
    "set -u",
    "trap 'echo CALLER-EXIT-MARKER >&2' EXIT",
    "trap 'echo CALLER-TRAP-TERM >&2; exit 71' TERM",
    "trap 'echo CALLER-TRAP-INT >&2; exit 72' INT",
    "trap 'echo CALLER-TRAP-HUP >&2; exit 73' HUP",
    // shellcheck source=/dev/null
    'source "$MEAL_AGENT_SECRET_SOURCE"',
    "meal_agent_resolve_secret MEAL_AGENT_RUNTIME_PASSWORD",
    'echo "RESOLVED ${#MEAL_AGENT_RUNTIME_PASSWORD}"',
    "echo TRAPS-AFTER-BEGIN",
    "trap -p TERM INT HUP",
    "trap -p EXIT",
    "echo TRAPS-AFTER-END",
    "exit 0",
  ].join("\n"),
);
chmodSync(signalDriver, 0o755);

test("the caller's traps are still restored after a normal completion", async () => {
  const outcome = await runSignalScenario({
    slot: "signal-caller-normal",
    signals: [],
    callerTraps: true,
    stall: false,
  });

  assert.equal(
    outcome.code,
    0,
    `the driver must succeed; output: ${outcome.output}`,
  );
  // 口令确实解析出来了（只断言长度，绝不打印取值）。
  assert.equal(
    outcome.output.includes(`RESOLVED ${String(passwords.runtime.length)}`),
    true,
    outcome.output,
  );
  // 解析结束后，调用方原有的四个 trap 一个不少地回到原位。
  const lines = outcome.output.split("\n");
  const begin = lines.indexOf("TRAPS-AFTER-BEGIN");
  const end = lines.indexOf("TRAPS-AFTER-END");
  assert.equal(begin >= 0 && end > begin, true, outcome.output);
  const restored = lines.slice(begin + 1, end).join("\n");
  for (const fragment of [
    "exit 71",
    "exit 72",
    "exit 73",
    "CALLER-EXIT-MARKER",
  ]) {
    assert.equal(
      restored.includes(fragment),
      true,
      `the caller trap containing "${fragment}" must be restored; got ${restored}`,
    );
  }
  // 我们的链式 EXIT handler 必须已经交还，不能赖在调用方的 EXIT 处置上。
  assert.equal(
    restored.includes("meal_agent_run_exit_trap"),
    false,
    `the chained EXIT handler must be handed back; got ${restored}`,
  );
  assertNoSentinel(outcome.output, "the normal-completion driver output");
});
