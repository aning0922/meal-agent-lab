import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const requiredPostgresExecutables = [
  "postgres",
  "initdb",
  "pg_ctl",
  "createdb",
] as const;

const executableExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const postgresVersionAt = async (
  binDirectory: string,
): Promise<string | undefined> => {
  if (
    !(
      await Promise.all(
        requiredPostgresExecutables.map((name) =>
          executableExists(join(binDirectory, name)),
        ),
      )
    ).every(Boolean)
  ) {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync(
      join(binDirectory, "postgres"),
      ["--version"],
    );
    return stdout.trim();
  } catch {
    return undefined;
  }
};

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

/**
 * 对象 manifest 的 catalog 基线是从**具体 patch 版本**采集并冻结的：
 * `pg_get_constraintdef` / `pg_get_indexdef` / `pg_get_expr` 的规范化文本、
 * PostgreSQL 18 把 NOT NULL 登记为约束的方式、`acldefault` 的取值都可能随 patch
 * 变化。因此这里 fail closed 到 exact 18.4，而不是宽松的 `18.x`：patch 升级必须
 * 重新 capture manifest、重跑 parity 并显式 rebaseline。
 *
 * M2B 落地 Compose 之后，还要额外登记容器镜像的 exact manifest digest。
 */
export const supportedPostgresVersion = "18.4";

const isSupportedPostgres = (version: string): boolean =>
  version.includes(` ${supportedPostgresVersion} `) ||
  version.includes(` ${supportedPostgresVersion}\n`) ||
  version.trimEnd().endsWith(` ${supportedPostgresVersion}`);

export const findPostgres18Bin = async (): Promise<{
  readonly binDirectory: string;
  readonly version: string;
}> => {
  const explicit = process.env["PG_BIN"];
  if (explicit !== undefined) {
    const version = await postgresVersionAt(explicit);
    if (version === undefined || !isSupportedPostgres(version)) {
      throw new Error(
        `PG_BIN must contain PostgreSQL ${supportedPostgresVersion} binaries; ` +
          `found ${version ?? "an incomplete installation"}`,
      );
    }
    return { binDirectory: explicit, version };
  }

  const candidates = [
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
    ...(process.env["PATH"] ?? "")
      .split(delimiter)
      .filter((entry) => entry !== ""),
  ];
  for (const candidate of new Set(candidates)) {
    const version = await postgresVersionAt(candidate);
    if (version !== undefined && isSupportedPostgres(version)) {
      return { binDirectory: candidate, version };
    }
  }
  throw new Error(
    `Stage 06 requires PostgreSQL ${supportedPostgresVersion} binaries; ` +
      `install PostgreSQL ${supportedPostgresVersion} or set PG_BIN to its ` +
      "bin directory",
  );
};
