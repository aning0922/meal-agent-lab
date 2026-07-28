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

const decodeSecretBytes = (
  variable: string,
  path: string,
  bytes: Buffer,
): string => {
  let text: string;
  try {
    // fatal：非法 UTF-8 抛错，而不是静默替换成 U+FFFD。
    // ignoreBOM: true：不静默剥掉 BOM——「原样保留」优先于「看起来能用」。
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new SecretSourceError(variable, `${path} is not valid UTF-8`);
  }

  if (text.startsWith("\uFEFF")) {
    throw new SecretSourceError(
      variable,
      `${path} starts with a byte order mark`,
    );
  }
  if (text.includes("\u0000")) {
    throw new SecretSourceError(variable, `${path} contains a NUL byte`);
  }

  // 最多移除**一个**末尾 LF。除此之外不做任何 trim：前后空格、冒号、反斜杠、
  // `@`、`/`、`#`、`%` 都必须原样进入连接串与口令。
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;

  if (body.endsWith("\n")) {
    throw new SecretSourceError(
      variable,
      `${path} ends with more than one newline`,
    );
  }
  if (body.includes("\n")) {
    throw new SecretSourceError(
      variable,
      `${path} must contain a single line`,
    );
  }
  if (body.includes("\r")) {
    throw new SecretSourceError(
      variable,
      `${path} contains a carriage return (CRLF line endings are rejected)`,
    );
  }
  if (body === "") {
    throw new SecretSourceError(variable, `${path} is empty`);
  }

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

    return decodeSecretBytes(variable, path, buffer.subarray(0, read));
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

  if (directPresent) {
    const value = environment[variable] ?? "";
    if (value === "") {
      throw new SecretSourceError(
        variable,
        `${variable} is set but empty; an empty value is never a valid ` +
          `credential and must not fall back to ${fileVariable}`,
      );
    }
    return { variable, fileVariable, origin: "environment", value };
  }

  // 选中文件之后**不再**回落：文件缺失、权限不对或内容非法时直接失败。
  const value = readSecretFile(
    fileVariable,
    environment[fileVariable] ?? "",
    options.maximumBytes,
  );
  return { variable, fileVariable, origin: "file", value };
};

/**
 * 三个 Node 入口的共用调用点。它存在的意义是让「API、db:migrate、db:bootstrap
 * 共用同一条规则」成为**结构上**成立的事实，而不是三处各写一遍后靠约定维持。
 */
export const resolveDatabaseUrlSource = (
  environment: NodeJS.ProcessEnv = process.env,
): SecretSource => resolveSecretSource("DATABASE_URL", environment);
