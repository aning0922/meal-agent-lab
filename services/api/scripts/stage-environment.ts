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

export const findPostgres18Bin = async (): Promise<{
  readonly binDirectory: string;
  readonly version: string;
}> => {
  const explicit = process.env["PG_BIN"];
  if (explicit !== undefined) {
    const version = await postgresVersionAt(explicit);
    if (version === undefined || !/\b18\./.test(version)) {
      throw new Error(
        `PG_BIN must contain PostgreSQL 18 binaries; found ${version ?? "an incomplete installation"}`,
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
    if (version !== undefined && /\b18\./.test(version)) {
      return { binDirectory: candidate, version };
    }
  }
  throw new Error(
    "Stage 06 requires PostgreSQL 18 binaries; install PostgreSQL 18 or set PG_BIN to its bin directory",
  );
};
