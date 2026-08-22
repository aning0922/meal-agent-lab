import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 受监管的 PostgreSQL 工具。门禁不只看 `postgres`：`initdb` 建集群、`pg_ctl` 起
 * 停、`createdb` 建库、`psql` 执行 bootstrap 与 generated adapter、`pg_dump` /
 * `pg_restore` 产生并验证备份。任何一个来自另一个 patch 的安装，采集到的
 * catalog 或 archive 证据就可能与冻结基线不一致，而
 * 「只有 server 是 18.4」恰恰是最容易发生、也最难被发现的那种混装。
 */
export const requiredPostgresExecutables = [
  "createdb",
  "initdb",
  "pg_ctl",
  "pg_dump",
  "pg_restore",
  "postgres",
  "psql",
] as const;

export type PostgresExecutable = (typeof requiredPostgresExecutables)[number];

/**
 * 对象 manifest 与授权 manifest 的 catalog 基线是从**具体 patch** 采集并冻结的：
 * `pg_get_constraintdef` / `pg_get_indexdef` / `pg_get_expr` 的规范化文本、
 * PostgreSQL 18 把 NOT NULL 登记为约束的方式、`acldefault` 的取值都可能随 patch
 * 变化。因此判据 fail closed 到 exact 18.4，而不是宽松的 `18.x`：patch 升级必须
 * 重新 capture manifest、重跑 parity 并显式 rebaseline。
 *
 * M2B 落地 Compose 之后，还要额外登记容器镜像的 exact image digest（必须解析真实
 * 镜像仓库获得，不得编造）。
 */
export const supportedPostgresVersion = "18.4";

/**
 * 标准 banner 的严格文法：`<tool> (PostgreSQL) <major>.<minor>[ <vendor suffix>]`。
 *
 * 整串锚定匹配，**不做任何 `includes` / 子串判断**——子串判据会把
 * `psql (PostgreSQL) 18.3 (Ubuntu 18.4-1.pgdg24.04+1)` 误判为 18.4：主版本字段是
 * 18.3，`18.4` 只出现在 vendor suffix 里。版本号也必须恰好是两段，`18.4.1` 或
 * `18.4beta1` 这类形态一律拒绝而不是宽容解析。vendor suffix 必须以非空白字符
 * 开头，因此 `18.4 `（行尾多余空格）也不算合法 banner。
 */
const bannerPattern =
  /^(?<tool>[A-Za-z_][A-Za-z0-9_]*) \(PostgreSQL\) (?<version>\d+\.\d+)(?: \S.*)?$/;

/**
 * 只剥掉**一个正常行尾换行**：`\r\n` 或 `\n`，别的一律不动，也不做 `trim()`。
 *
 * `trim()` 会连前导空白与前导空行一起吃掉，于是 `"  psql (PostgreSQL) 18.4"` 或
 * 一段带前导噪声的输出都能通过——而那已经不是这个可执行文件的标准 banner 了。
 * 裸 `\r` 同理：它不是正常行尾，剥掉它等于替一个畸形输出打补丁，因此保留在串里，
 * 由后面的 CR/LF 检查拒绝。
 */
const stripLineEnding = (banner: string): string => {
  if (banner.endsWith("\r\n")) {
    return banner.slice(0, -2);
  }
  return banner.endsWith("\n") ? banner.slice(0, -1) : banner;
};

export interface PostgresBannerResult {
  readonly ok: boolean;
  /** 解析出的主版本字段，仅在文法匹配时存在。 */
  readonly version?: string;
  /** 失败原因；成功时为空串。 */
  readonly detail: string;
}

/**
 * 解析单个工具的 `--version` 输出。
 *
 * banner 里的工具名必须与**实际执行的**工具名一致：否则一个把自己报成
 * `postgres (PostgreSQL) 18.4` 的伪造 `psql` 就能骗过版本检查。
 */
export const parsePostgresBanner = (
  tool: string,
  banner: string,
): PostgresBannerResult => {
  const line = stripLineEnding(banner);
  if (line === "" || line.includes("\n") || line.includes("\r")) {
    return {
      ok: false,
      detail: `expected a single-line version banner, got ${JSON.stringify(
        banner,
      )}`,
    };
  }
  // 行尾空白（空格或 Tab）也不是正常行尾：vendor suffix 之后不应该再有东西。
  if (/\s$/.test(line)) {
    return {
      ok: false,
      detail: `version banner has trailing whitespace: ${JSON.stringify(line)}`,
    };
  }
  const match = bannerPattern.exec(line);
  if (match?.groups === undefined) {
    return {
      ok: false,
      detail:
        `expected a PostgreSQL version banner, got ${JSON.stringify(line)}`,
    };
  }
  const reported = match.groups["tool"];
  const version = match.groups["version"];
  if (reported === undefined || version === undefined) {
    return {
      ok: false,
      detail: `unparsable version banner: ${JSON.stringify(line)}`,
    };
  }
  if (reported !== tool) {
    return {
      ok: false,
      detail:
        `banner reports ${JSON.stringify(reported)} but the executable ` +
        `is ${JSON.stringify(tool)}: ${JSON.stringify(line)}`,
    };
  }
  if (version !== supportedPostgresVersion) {
    return {
      ok: false,
      version,
      detail:
        `expected PostgreSQL ${supportedPostgresVersion}, found ` +
        `${version}: ${JSON.stringify(line)}`,
    };
  }
  return { ok: true, version, detail: "" };
};

/** `null` 表示该工具缺失、不可执行或执行失败。 */
export type PostgresToolBanner = string | null;

export interface PostgresToolchainFailure {
  readonly tool: string;
  readonly detail: string;
}

/**
 * 判定一整套工具链。返回**全部**失败项而不是第一项：混装时运维需要一次看清
 * 哪几个工具来自别的安装。
 */
export const evaluatePostgresToolchain = (
  banners: Readonly<Partial<Record<PostgresExecutable, PostgresToolBanner>>>,
): readonly PostgresToolchainFailure[] => {
  const failures: PostgresToolchainFailure[] = [];
  for (const tool of requiredPostgresExecutables) {
    const banner = banners[tool];
    if (banner === undefined || banner === null) {
      failures.push({ tool, detail: "is missing or not executable" });
      continue;
    }
    const parsed = parsePostgresBanner(tool, banner);
    if (!parsed.ok) {
      failures.push({ tool, detail: parsed.detail });
    }
  }
  return failures;
};

const describeFailures = (
  failures: readonly PostgresToolchainFailure[],
): string =>
  failures.map((failure) => `${failure.tool} ${failure.detail}`).join("; ");

export const assertStageNodeVersion = (): void => {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map(Number);
  if (major !== 24 || minor < 14) {
    throw new Error(
      `Stage 06 requires Node.js >=24.14.0 <25; found ${process.versions.node}`,
    );
  }
};

const executableExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** 逐个执行 `--version`；缺失或执行失败都返回 `null`，交给判定层统一处理。 */
const collectToolchainBanners = async (
  binDirectory: string,
): Promise<Record<PostgresExecutable, PostgresToolBanner>> => {
  const entries = await Promise.all(
    requiredPostgresExecutables.map(
      async (tool): Promise<[PostgresExecutable, PostgresToolBanner]> => {
        const path = join(binDirectory, tool);
        if (!(await executableExists(path))) {
          return [tool, null];
        }
        try {
          const { stdout } = await execFileAsync(path, ["--version"]);
          return [tool, stdout];
        } catch {
          return [tool, null];
        }
      },
    ),
  );
  return Object.fromEntries(entries) as Record<
    PostgresExecutable,
    PostgresToolBanner
  >;
};

export const findPostgres18Bin = async (): Promise<{
  readonly binDirectory: string;
  readonly version: string;
}> => {
  const describe = (
    banners: Record<PostgresExecutable, PostgresToolBanner>,
  ): string => (banners.postgres ?? "an incomplete installation").trim();

  const explicit = process.env["PG_BIN"];
  if (explicit !== undefined) {
    const banners = await collectToolchainBanners(explicit);
    const failures = evaluatePostgresToolchain(banners);
    if (failures.length > 0) {
      throw new Error(
        `PG_BIN must contain a complete PostgreSQL ${supportedPostgresVersion} ` +
          `toolchain (${requiredPostgresExecutables.join(", ")}); ` +
          describeFailures(failures),
      );
    }
    return { binDirectory: explicit, version: describe(banners) };
  }

  const candidates = [
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
    ...(process.env["PATH"] ?? "")
      .split(delimiter)
      .filter((entry) => entry !== ""),
  ];
  for (const candidate of new Set(candidates)) {
    const banners = await collectToolchainBanners(candidate);
    if (evaluatePostgresToolchain(banners).length === 0) {
      return { binDirectory: candidate, version: describe(banners) };
    }
  }
  throw new Error(
    `Stage 06 requires a complete PostgreSQL ${supportedPostgresVersion} ` +
      `toolchain (${requiredPostgresExecutables.join(", ")}); install ` +
      `PostgreSQL ${supportedPostgresVersion} or set PG_BIN to its bin directory`,
  );
};
