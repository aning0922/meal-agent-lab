/**
 * 阶段 09A / M3A：统一的 Node Secret 来源解析器。
 *
 * 三个 Node 入口共用同一段实现，因此 `DATABASE_URL` 与 `DATABASE_URL_FILE` 的
 * 互斥语义、文件安全判据与错误措辞在三处逐字一致：
 *
 *   - API   `loadConfig()`（`src/config.ts`）
 *   - CLI   `db:migrate`（`src/database/migrate.ts`）
 *   - CLI   `db:bootstrap`（`src/database/bootstrap-0000.ts`）
 *
 * 刻意**不**放进 Zod：`transform`/`refine` 里藏文件 I/O 会让「配置校验」与
 * 「读磁盘」在同一步发生，失败原因互相污染，而且顺序取决于 schema 内部实现。
 * 这里的顺序是显式的——先解析来源拿到字符串，再交给配置 schema 校验格式。
 *
 * 全部判据都是 **fail closed** 的：任何一条无法判定就拒绝，不降级、不猜测、
 * 也**绝不**在选中的来源失败时回落到另一个来源（那会让「文件权限错了」
 * 静默变成「用了进程环境里的旧值」）。错误信息只含变量名、路径与原因，
 * 从不包含 Secret 内容。
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Secret file 的字节上限。连接串与口令都远小于此；上限存在的意义是让
 * 「指向了一个大文件」立刻失败，而不是把几百 MB 读进内存再判断。
 */
export const maximumSecretFileBytes = 4_096;

export type SecretOrigin = "environment" | "file";

export interface SecretSource {
  /** 直接注入使用的变量名，例如 `DATABASE_URL`。 */
  readonly variable: string;
  /** 文件注入使用的变量名，例如 `DATABASE_URL_FILE`。 */
  readonly fileVariable: string;
  /** 实际选中的来源。两者互斥，因此它同时是「没有回落发生」的证据。 */
  readonly origin: SecretOrigin;
  readonly value: string;
}

/** 解析失败的统一错误类型。message 永远不含 Secret 内容。 */
export class SecretSourceError extends Error {
  public readonly variable: string;

  public constructor(variable: string, detail: string) {
    super(`${variable}: ${detail}`);
    this.name = "SecretSourceError";
    this.variable = variable;
  }
}

/** `<NAME>` → `<NAME>_FILE`。 */
export const secretFileVariable = (variable: string): string =>
  `${variable}_FILE`;

const environmentVariablePattern = /^[A-Z_][A-Z0-9_]*$/;

/**
 * 「已出现」的定义只看**是否是字符串**，不看内容：空字符串同样算已出现。
 * 否则 `DATABASE_URL=` 会被当成「没设置」，于是同时设置 `DATABASE_URL=` 与
 * `DATABASE_URL_FILE=/run/secrets/...` 就会被降级成合法的 file-only 注入——
 * 而这恰恰是一个必须被拒绝的冲突配置。
 */
const isPresent = (
  environment: NodeJS.ProcessEnv,
  variable: string,
): boolean => typeof environment[variable] === "string";

const effectiveUid = (variable: string): number => {
  const geteuid = process.geteuid;
  if (typeof geteuid !== "function") {
    throw new SecretSourceError(
      variable,
      "the current platform does not expose an effective UID, so secret " +
        "file ownership cannot be verified",
    );
  }
  return geteuid.call(process);
};

const openSecretFile = (
  variable: string,
  path: string,
): number => {
  try {
    // O_NOFOLLOW：最后一段是 symlink 时直接失败，而不是跟过去读别的文件。
    // O_NONBLOCK：FIFO 在没有写端时会让 open() 永久阻塞；加上它以后 open 立即
    // 返回，随后由 fstat 判定它不是普通文件并拒绝。对普通文件无副作用。
    return openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "unknown";
    if (code === "ELOOP" || code === "EMLINK") {
      throw new SecretSourceError(
        variable,
        `${path} is a symbolic link; secret files must be opened directly`,
      );
    }
    if (code === "ENOENT") {
      throw new SecretSourceError(variable, `${path} does not exist`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new SecretSourceError(variable, `${path} is not readable`);
    }
    throw new SecretSourceError(
      variable,
      `${path} could not be opened (${code})`,
    );
  }
};

/**
 * 打开后用 **fstat** 判定，而不是先 stat 路径再 open：后者会在两次系统调用之间
 * 留下一个可被替换的窗口。这里检查的始终是**已经握在手里的那个文件描述符**。
 */
const assertSecretFileDescriptor = (
  variable: string,
  path: string,
  fileDescriptor: number,
  maximumBytes: number,
): number => {
  const stats = fstatSync(fileDescriptor);

  if (!stats.isFile()) {
    throw new SecretSourceError(
      variable,
      `${path} is not a regular file (directories, FIFOs, sockets and ` +
        "devices are rejected)",
    );
  }
  if (stats.nlink !== 1) {
    throw new SecretSourceError(
      variable,
      `${path} has ${String(stats.nlink)} hard links; a secret file must ` +
        "have exactly one name",
    );
  }

  const owner = effectiveUid(variable);
  if (stats.uid !== owner) {
    throw new SecretSourceError(
      variable,
      `${path} is owned by uid ${String(stats.uid)} but this process runs ` +
        `as uid ${String(owner)}`,
    );
  }

  // 允许的位只有 owner 的读与写（0600）。因此 group/world 的任何位、owner 的
  // 执行位，以及 setuid/setgid/sticky 都会被拒绝。
  const permissions = stats.mode & 0o7777;
  if ((permissions & 0o7177) !== 0) {
    throw new SecretSourceError(
      variable,
      `${path} has mode ${permissions.toString(8).padStart(4, "0")}; only ` +
        "owner read/write (0600) is accepted",
    );
  }
  if ((permissions & 0o400) === 0) {
    throw new SecretSourceError(
      variable,
      `${path} is not readable by its owner`,
    );
  }
  if (stats.size > maximumBytes) {
    throw new SecretSourceError(
      variable,
      `${path} is ${String(stats.size)} bytes; the limit is ` +
        `${String(maximumBytes)}`,
    );
  }

  return stats.size;
};

/**
 * 取值内容的共同判据，direct 与 file **两条来源都要过**。
 *
 * `subject` 只用于错误措辞（direct 是变量名，file 是路径），因此两条来源给出的
 * 拒绝理由结构一致但能指向正确的位置。绝不包含取值本身。
 *
 * 这一层不做任何 trim：前后空格、tab、`:`、`\`、`@`、`/`、`#`、`%` 都必须逐字节
 * 保留。file 来源允许在**调用本函数之前**移除一个末尾 LF，那是文件格式惯例；
 * direct 来源没有这个惯例，任何 LF 都是错误。
 */
const assertSecretContent = (
  variable: string,
  subject: string,
  value: string,
  maximumBytes: number,
): void => {
  if (value === "") {
    throw new SecretSourceError(variable, `${subject} is empty`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximumBytes) {
    throw new SecretSourceError(
      variable,
      `${subject} is ${String(bytes)} bytes; the limit is ` +
        `${String(maximumBytes)}`,
    );
  }
  if (value.includes("\u0000")) {
    throw new SecretSourceError(variable, `${subject} contains a NUL byte`);
  }
  if (value.includes("\uFEFF")) {
    throw new SecretSourceError(
      variable,
      `${subject} contains a byte order mark`,
    );
  }
  if (value.includes("\n")) {
    throw new SecretSourceError(
      variable,
      `${subject} must contain a single line`,
    );
  }
  if (value.includes("\r")) {
    throw new SecretSourceError(
      variable,
      `${subject} contains a carriage return (CRLF line endings are rejected)`,
    );
  }
};

const decodeSecretBytes = (
  variable: string,
  path: string,
  bytes: Buffer,
  maximumBytes: number,
): string => {
  let text: string;
  try {
    // fatal：非法 UTF-8 抛错，而不是静默替换成 U+FFFD。
    // ignoreBOM: true：不静默剥掉 BOM——「原样保留」优先于「看起来能用」，
    // 而且 U+FEFF 出现在**任何**位置都会被下面的共用内容判据拒绝。
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new SecretSourceError(variable, `${path} is not valid UTF-8`);
  }

  // 最多移除**一个**末尾 LF。这是 file 来源**唯一**与 direct 不同的地方；
  // 其余判据由同一个 assertSecretContent 承担，因此 U+FEFF、NUL、CR 与多行
  // 在两条来源上是**同一条**规则，不会出现「换个注入方式就能绕过」。
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;

  if (body.endsWith("\n")) {
    throw new SecretSourceError(
      variable,
      `${path} ends with more than one newline`,
    );
  }

  assertSecretContent(variable, path, body, maximumBytes);
  return body;
};

/**
 * 读取并校验一个 secret file。校验顺序是刻意的：路径形态 → 打开 → fstat →
 * 读取 → 解码与内容形态。任何一步失败都立即抛出，不继续往下走。
 */
export const readSecretFile = (
  variable: string,
  path: string,
  maximumBytes: number = maximumSecretFileBytes,
): string => {
  if (path === "") {
    throw new SecretSourceError(variable, "the file path must not be empty");
  }
  if (!isAbsolute(path)) {
    throw new SecretSourceError(
      variable,
      `${path} is not an absolute path`,
    );
  }

  const fileDescriptor = openSecretFile(variable, path);
  try {
    const size = assertSecretFileDescriptor(
      variable,
      path,
      fileDescriptor,
      maximumBytes,
    );

    // 缓冲区比上限多一个字节：文件在 fstat 之后被撑大时，多出来的那个字节会被
    // 读到并触发拒绝，而不是被静默截断成一个「看起来合法」的短 Secret。
    const buffer = Buffer.alloc(maximumBytes + 1);
    let read = 0;
    for (;;) {
      const chunk = readSync(
        fileDescriptor,
        buffer,
        read,
        buffer.length - read,
        null,
      );
      if (chunk === 0) {
        break;
      }
      read += chunk;
      if (read > maximumBytes) {
        throw new SecretSourceError(
          variable,
          `${path} is larger than ${String(maximumBytes)} bytes`,
        );
      }
    }
    if (read !== size) {
      throw new SecretSourceError(
        variable,
        `${path} changed size while it was being read`,
      );
    }

    return decodeSecretBytes(
      variable,
      path,
      buffer.subarray(0, read),
      maximumBytes,
    );
  } finally {
    closeSync(fileDescriptor);
  }
};

export interface ResolveSecretSourceOptions {
  readonly maximumBytes?: number;
}

/**
 * 解析 `<NAME>` 与 `<NAME>_FILE` 这一对互斥来源。
 *
 * | `<NAME>` | `<NAME>_FILE` | 结果 |
 * | --- | --- | --- |
 * | 未设置 | 未设置 | 拒绝：缺少凭据 |
 * | 非空 | 未设置 | 采用进程环境 |
 * | 空 | 未设置 | 拒绝：空值不是有效凭据 |
 * | 未设置 | 非空 | 采用文件（全部安全判据必须通过） |
 * | 未设置 | 空 | 拒绝：空路径 |
 * | 已出现 | 已出现 | 拒绝：冲突。**不比较内容**，即使两边完全相同 |
 *
 * 最后一行是刻意的：两个来源同时出现说明部署配置本身有歧义，「内容恰好一样」
 * 只是这一次碰巧，不能作为放行理由。
 */
export const resolveSecretSource = (
  variable: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: ResolveSecretSourceOptions = {},
): SecretSource => {
  if (!environmentVariablePattern.test(variable)) {
    throw new SecretSourceError(
      variable,
      "is not a valid environment variable name",
    );
  }
  const fileVariable = secretFileVariable(variable);
  const directPresent = isPresent(environment, variable);
  const filePresent = isPresent(environment, fileVariable);

  if (directPresent && filePresent) {
    throw new SecretSourceError(
      variable,
      `${variable} and ${fileVariable} are mutually exclusive; exactly one ` +
        "must be set (their values are never compared)",
    );
  }
  if (!directPresent && !filePresent) {
    throw new SecretSourceError(
      variable,
      `either ${variable} or ${fileVariable} is required`,
    );
  }

  const maximumBytes = options.maximumBytes ?? maximumSecretFileBytes;

  if (directPresent) {
    const value = environment[variable] ?? "";
    if (value === "") {
      throw new SecretSourceError(
        variable,
        `${variable} is set but empty; an empty value is never a valid ` +
          `credential and must not fall back to ${fileVariable}`,
      );
    }
    // direct 与 file 的**内容**判据必须一致，否则「换个注入方式」就能绕过它。
    // 唯一的差别是末尾 LF：file 允许一个（文件格式惯例），direct 一个都不允许。
    //
    // 多行 direct 尤其危险：`foo\nfoo` 喂给 psql 的 `\password` 会被读成两次
    // 相同输入，于是口令被**静默**设置成 `foo`——部署以为自己设了一个更长的
    // 口令，实际生效的是它的第一行。
    assertSecretContent(variable, variable, value, maximumBytes);
    return { variable, fileVariable, origin: "environment", value };
  }

  // 选中文件之后**不再**回落：文件缺失、权限不对或内容非法时直接失败。
  const value = readSecretFile(
    fileVariable,
    environment[fileVariable] ?? "",
    maximumBytes,
  );
  return { variable, fileVariable, origin: "file", value };
};

// ---------------------------------------------------------------------------
// PostgreSQL 连接串的专用校验
//
// 存在的唯一理由：**node-postgres 会在连接串缺字段时静默回落到 `PG*` 环境变量**。
// 实测（`pg` 8.22）在 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` 都有值时：
//
//   postgresql://                          → 五个核心字段全部来自 PG* 环境变量
//   postgresql://u:p@h:5432/db?host=/tmp   → host 变成 unix socket `/tmp`
//   postgresql://u:p@%2Ftmp/db             → host 变成 `/tmp`，port 回落到 PGPORT
//
// 于是「secret file 注入了连接串」这件事本身并不能保证连接目标来自那份 secret。
// 因此把校验放在**三个入口共用的这一层**，而不是只放在 `config.ts`：`db:migrate`
// 与 `db:bootstrap` 不经过 `loadConfig()`，只修 `config.ts` 会漏掉两个高权限入口。
//
// 本轮只保证「核心字段必须显式来自 URL」。把用户名固定为某个角色、把 host/port
// 固定为 `postgres:5432`、把 database identity 固定为 `meal_agent*`，属于 M3B。
// ---------------------------------------------------------------------------

/**
 * 原始串里绝不允许出现的字符：C0 控制符（含 NUL/CR/LF）、DEL、BOM，以及**未编码**
 * 的空白。它们要么会被 URL 解析器静默吃掉或改写，要么会在后续拼接中改变语义；
 * 合法连接串里出现这些字符时一律应当百分号编码。
 */
const forbiddenRawUrlCharacter = /[\u0000-\u0020\u007F\uFEFF]|\s/u;

const postgresUrlPrefixes = ["postgresql://", "postgres://"] as const;

/** 百分号解码后仍然不允许出现的字符（解码是攻击者可控的还原点）。 */
const forbiddenDecodedCharacter = /[\u0000\r\n]/u;

const decodeUrlComponent = (
  variable: string,
  field: string,
  value: string,
): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SecretSourceError(
      variable,
      `the connection URL has a malformed percent-encoded ${field}`,
    );
  }
};

/**
 * 校验一条 PostgreSQL 连接串，**返回原始串**：不 trim、不规范化、不重写口令。
 * 返回值与输入逐字节相同，因此百分号编码的口令原样交给 `pg`。
 */
export const assertPostgresConnectionUrl = (
  variable: string,
  raw: string,
): string => {
  if (forbiddenRawUrlCharacter.test(raw)) {
    throw new SecretSourceError(
      variable,
      "the connection URL contains a control character, a byte order mark " +
        "or unencoded whitespace",
    );
  }
  if (!postgresUrlPrefixes.some((prefix) => raw.startsWith(prefix))) {
    throw new SecretSourceError(
      variable,
      "the connection URL must start with postgresql:// or postgres://",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // 多 host（`h1:5432,h2:5432`）等形态在这里就被解析器拒绝。
    throw new SecretSourceError(
      variable,
      "the connection URL is not a valid URL",
    );
  }

  // 五个核心字段必须**显式非空**。任何一个缺失都会让 pg 回落到 PG* 环境变量。
  const required: readonly [string, string, string][] = [
    ["username", url.username, "PGUSER"],
    ["password", url.password, "PGPASSWORD"],
    ["hostname", url.hostname, "PGHOST"],
    ["port", url.port, "PGPORT"],
  ];
  for (const [field, value, environmentVariable] of required) {
    if (value === "") {
      throw new SecretSourceError(
        variable,
        `the connection URL has no explicit ${field}; node-postgres would ` +
          `fall back to ${environmentVariable}`,
      );
    }
  }

  if (!/^[0-9]+$/.test(url.port)) {
    throw new SecretSourceError(
      variable,
      "the connection URL port must be decimal digits",
    );
  }
  const port = Number(url.port);
  if (port < 1 || port > 65_535) {
    throw new SecretSourceError(
      variable,
      "the connection URL port must be between 1 and 65535",
    );
  }

  // database 必须是**恰好一个**非空 path segment。`/` 会让 pg 回落到 PGDATABASE，
  // `/a/b` 不是一个合法的库名，`postgresql:///var/run/postgresql` 是 unix socket。
  const segments = url.pathname.split("/");
  if (segments.length !== 2 || segments[0] !== "" || segments[1] === "") {
    throw new SecretSourceError(
      variable,
      "the connection URL must name exactly one database as a single path " +
        "segment; node-postgres would otherwise fall back to PGDATABASE",
    );
  }
  const database = segments[1] ?? "";

  if (url.search !== "") {
    throw new SecretSourceError(
      variable,
      "the connection URL must not carry a query string; parameters such as " +
        "?host= and ?options= override the connection target",
    );
  }
  if (url.hash !== "") {
    throw new SecretSourceError(
      variable,
      "the connection URL must not carry a fragment",
    );
  }

  // hostname 必须是一个真正的网络主机名：`%2Ftmp`（解码后 `/tmp`）是 unix socket
  // 目录，逗号是多 host 语法。两者都会把连接目标换成别的东西。
  const hostname = decodeUrlComponent(variable, "hostname", url.hostname);
  if (hostname.includes("/") || hostname.startsWith(".")) {
    throw new SecretSourceError(
      variable,
      "the connection URL host must be a network host, not a Unix socket path",
    );
  }
  if (hostname.includes(",")) {
    throw new SecretSourceError(
      variable,
      "the connection URL must name exactly one host",
    );
  }

  // 百分号解码之后再查一次：编码形态可以把 NUL/CR/LF 藏过原始串的检查。
  for (const [field, value] of [
    ["username", url.username],
    ["password", url.password],
    ["database", database],
  ] as const) {
    if (forbiddenDecodedCharacter.test(decodeUrlComponent(variable, field, value))) {
      throw new SecretSourceError(
        variable,
        `the connection URL ${field} decodes to a value containing NUL, CR ` +
          "or LF",
      );
    }
  }

  // 原样返回：调用方拿到的仍是 secret 里那一份字节。
  return raw;
};

/**
 * node-postgres 会读取、而**连接串无法覆盖**的 ambient 环境变量。
 *
 * 逐条来自 `pg@8.22.0` 的 `lib/connection-parameters.js`：`val()` 在
 * `config[key]` 为 falsy 时回落到 `process.env['PG' + KEY]`，另有三处显式命名的
 * 环境变量（`PGSSLNEGOTIATION`、`PGAPPNAME`、`PGCONNECT_TIMEOUT`）与一处
 * `readSSLConfigFromEnvironment()`（`PGSSLMODE`）。
 *
 * `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` **不在**这张表里：
 * 连接串校验已经保证这五项必须显式来自 URL，而 `val()` 优先取 `config`，因此
 * 它们即使存在也不会生效（有 `pg.Client.connectionParameters` 的正面用例）。
 * 剩下这些则完全没有 URL 对应物——它们能改协议协商、会话参数与传输格式，
 * 却不属于「这份 secret 描述的连接」，因此在共用边界 fail closed。
 *
 * 注意 `val()` 用的是 `||` 而不是 `??`：把 `binary: false` 之类的显式假值放进
 * config **不能**阻止回落，所以这里选择拒绝环境变量，而不是构造「显式假值」。
 */
export const rejectedAmbientPostgresVariables = [
  "PGAPPNAME",
  "PGBINARY",
  "PGCLIENT_ENCODING",
  "PGCONNECT_TIMEOUT",
  "PGOPTIONS",
  "PGREPLICATION",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
] as const;

/**
 * ambient 环境不得改写连接语义。错误只列出**变量名**，绝不包含取值——
 * `PGOPTIONS` 之类的取值本身可能带有部署细节。
 */
export const assertNoAmbientPostgresOverrides = (
  variable: string,
  environment: NodeJS.ProcessEnv,
): void => {
  // 两个来源都要看。node-postgres 读的**永远是 `process.env`**，与调用方传进来
  // 的 environment 无关；而调用方传进来的那一份是这次解析的契约。只查其中一个
  // 都会留下一条真实的绕过路径。
  const sources =
    environment === process.env ? [environment] : [environment, process.env];
  const present = rejectedAmbientPostgresVariables.filter((name) =>
    sources.some((source) => isPresent(source, name)),
  );
  if (present.length > 0) {
    throw new SecretSourceError(
      variable,
      `the environment sets ${present.join(", ")}; node-postgres would apply ` +
        "them on top of the connection URL, so the connection would no longer " +
        "be described by this secret alone (unset them)",
    );
  }
};

/**
 * 三个 Node 入口的共用调用点。它存在的意义是让「API、db:migrate、db:bootstrap
 * 共用同一条规则」成为**结构上**成立的事实，而不是三处各写一遍后靠约定维持。
 *
 * 来源解析（互斥 + 文件安全判据）、连接串校验与 ambient 覆盖检查都在这里完成，
 * 因此两条来源（direct 与 file）走的是**同一套**判据。
 */
export const resolveDatabaseUrlSource = (
  environment: NodeJS.ProcessEnv = process.env,
): SecretSource => {
  const source = resolveSecretSource("DATABASE_URL", environment);
  const subject =
    source.origin === "file" ? source.fileVariable : source.variable;
  assertPostgresConnectionUrl(subject, source.value);
  assertNoAmbientPostgresOverrides(subject, environment);
  return source;
};
