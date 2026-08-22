/**
 * 阶段 09A / M2A：admin bootstrap 入口（`pnpm --filter @meal-agent/api db:bootstrap`）。
 *
 * 这是一个**独立、固定、零参数**的入口，只做一件事：以 cluster admin 身份把
 * 冻结的 `0000_stage_06.sql` 原子地应用到一个全新的项目数据库。
 *
 * 之所以单独成文件而不是给 db:migrate 加 flag：只要 flag 存在，
 * `pnpm ... db:migrate --bootstrap-0000` 就可能误入 admin 模式。现在 db:migrate
 * 只接受零参数，admin 路径与常规迁移路径在入口层面就是两个不同的程序。
 */
import { fileURLToPath } from "node:url";

import { resolveDatabaseUrlSource } from "../config-source.js";
import { applyMigrations, bootstrapMigrationOptions } from "./migrate.js";

export class BootstrapCliUsageError extends Error {
  public constructor(received: readonly string[]) {
    super(
      "db:bootstrap takes no arguments (received " +
        `${JSON.stringify(received)}); its semantics are fixed: apply only ` +
        "0000_stage_06.sql as the cluster admin",
    );
    this.name = "BootstrapCliUsageError";
  }
}

export const parseBootstrapCliArguments = (
  argv: readonly string[],
): void => {
  if (argv.length > 0) {
    throw new BootstrapCliUsageError(argv);
  }
};

// 只有作为脚本直接运行时才执行；被 import 时不产生副作用。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 与 db:migrate 完全相同的顺序：参数校验 → Secret 来源解析 → 数据库连接。
  // 非法调用既不读 Secret 文件也不建立 Pool；连接串来源由三个 Node 入口共用的
  // resolveDatabaseUrlSource 判定（DATABASE_URL 与 DATABASE_URL_FILE 互斥）。
  parseBootstrapCliArguments(process.argv.slice(2));

  const databaseUrl = resolveDatabaseUrlSource().value;

  await applyMigrations(databaseUrl, bootstrapMigrationOptions);
}
