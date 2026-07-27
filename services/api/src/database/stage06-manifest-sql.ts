import {
  canonicalManifestRows,
  handoffPendingKeys,
  managedSchemas,
  manifestDigest,
  Stage06ManifestError,
  stage06ManifestVersion,
  stage06SecurityManifest,
  type Stage06Manifest,
} from "./stage06-manifest.js";

/**
 * 阶段 09A / M2A：把 typed manifest 确定性地渲染成**纯 SQL**。
 *
 * 约束（三个消费者共同决定）：
 *
 *   1. `pg` 与 `psql` 都要能直接执行，因此不含 `\ir`、`\set` 等 psql 元命令，
 *      整体是一条 `DO` 语句；
 *   2. 只读：不做任何 ownership / ACL / DDL 变更，不匹配时只 `RAISE EXCEPTION`；
 *   3. 确定性：同一 manifest 渲染出逐字节相同的文本，不含时间戳、绝对路径、
 *      locale 相关排序或随机值。
 *
 * 规范化投影必须与 `search_path` 无关：`pg_get_indexdef` / `pg_get_constraintdef`
 * / `pg_get_expr` 会省略「当前 search_path 可见」的 schema 限定，于是同一个数据库
 * 在不同会话里会给出不同文本。`DO` 块开头把 `search_path` 事务内固定为
 * `pg_catalog`，块结束即失效。
 */

const dollarTag = "$meal_agent_stage06_manifest$";

/** 与 manifest 侧同一条不变量：这些字符无法被确定性地渲染成 SQL 字面量。 */
const unrenderable = (value: string): boolean =>
  ["\\", "\r", "\n", String.fromCharCode(0), dollarTag].some((forbidden) =>
    value.includes(forbidden),
  );

const sqlLiteral = (value: string): string => {
  if (unrenderable(value)) {
    throw new Stage06ManifestError(
      "a manifest value cannot be rendered as a deterministic SQL literal",
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
};

const sqlTextArray = (values: readonly string[]): string =>
  `ARRAY[${values.map(sqlLiteral).join(", ")}]::text[]`;

/**
 * owner handoff 之前，`public` / `drizzle` 与 drizzle ledger 合法地属于
 * `pg_database_owner` 或执行 bootstrap 的 admin；之后属于 migrator。这三个取值
 * 归一化为同一个占位符，其余一律按真实 owner 名比较。
 */
const transitionalOwners =
  "ARRAY['meal_agent_migrator', 'pg_database_owner', current_user::text]::text[]";

const ownerExpression = (
  kind: string,
  identityExpression: string,
  ownerExpressionSql: string,
  pending: readonly string[],
): string =>
  `CASE
              WHEN ${sqlLiteral(`${kind}:`)} || ${identityExpression}
                     = ANY (${sqlTextArray(pending)})
                   AND ${ownerExpressionSql} = ANY (${transitionalOwners})
                THEN 'handoff-pending'
              ELSE ${ownerExpressionSql}
            END`;

/**
 * 只读的规范化投影：每个被管理对象一行 `(kind, identity, detail)`，与
 * `canonicalManifestRows` 的文本格式逐字对应。parity 测试与渲染出的比对块共用
 * 这一段，因此 TypeScript 侧与 catalog 侧不存在第二份归一化规则。
 */
export const renderStage06CatalogProjectionSql = (
  manifest: Stage06Manifest = stage06SecurityManifest,
): string => {
  const managed = sqlTextArray(managedSchemas(manifest));
  const pending = handoffPendingKeys(manifest);

  return `SELECT kind, identity, detail
      FROM (
        SELECT 'schema'::text AS kind,
               n.nspname::text AS identity,
               'owner=' || ${ownerExpression(
                 "schema",
                 "n.nspname::text",
                 "pg_catalog.pg_get_userbyid(n.nspowner)::text",
                 pending,
               )} AS detail
          FROM pg_catalog.pg_namespace n
         WHERE n.nspname <> 'information_schema'
           AND n.nspname !~ '^pg_'
        UNION ALL
        SELECT 'relation'::text,
               (n.nspname || '.' || c.relname)::text,
               ('relkind=' || c.relkind::text
                 || ' owner=' || ${ownerExpression(
                   "relation",
                   "(n.nspname || '.' || c.relname)::text",
                   "pg_catalog.pg_get_userbyid(c.relowner)::text",
                   pending,
                 )}
                 || ' rls=' || CASE WHEN c.relrowsecurity THEN 't' ELSE 'f' END
                 || ' force='
                 || CASE WHEN c.relforcerowsecurity THEN 't' ELSE 'f' END)::text
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY (${managed})
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        UNION ALL
        SELECT 'index'::text,
               (n.nspname || '.' || ci.relname)::text,
               ('table=' || n.nspname || '.' || ct.relname
                 || ' def=' || pg_catalog.pg_get_indexdef(i.indexrelid))::text
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ci ON ci.oid = i.indexrelid
          JOIN pg_catalog.pg_class ct ON ct.oid = i.indrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ci.relnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'constraint'::text,
               (n.nspname || '.' || ct.relname || '.' || con.conname)::text,
               ('contype=' || con.contype::text
                 || ' def=' || pg_catalog.pg_get_constraintdef(con.oid))::text
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class ct ON ct.oid = con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ct.relnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'routine'::text,
               (n.nspname || '.' || p.proname || '('
                 || pg_catalog.pg_get_function_identity_arguments(p.oid)
                 || ')')::text,
               ('prokind=' || p.prokind::text
                 || ' owner=' || ${ownerExpression(
                   "routine",
                   `(n.nspname || '.' || p.proname || '('
                        || pg_catalog.pg_get_function_identity_arguments(p.oid)
                        || ')')::text`,
                   "pg_catalog.pg_get_userbyid(p.proowner)::text",
                   pending,
                 )}
                 || ' secdef=' || CASE WHEN p.prosecdef THEN 't' ELSE 'f' END
                 || ' lang=' || l.lanname
                 || ' volatile=' || p.provolatile::text
                 || ' parallel=' || p.proparallel::text
                 || ' leakproof='
                 || CASE WHEN p.proleakproof THEN 't' ELSE 'f' END
                 || ' result=' || pg_catalog.pg_get_function_result(p.oid)
                 || ' config='
                 || COALESCE(pg_catalog.array_to_string(p.proconfig, '|'), '')
                 || ' body='
                 || pg_catalog.encode(
                      pg_catalog.sha256(
                        pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex'))::text
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_catalog.pg_language l ON l.oid = p.prolang
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'policy'::text,
               (n.nspname || '.' || ct.relname || '.' || pol.polname)::text,
               ('cmd=' || pol.polcmd::text
                 || ' permissive='
                 || CASE WHEN pol.polpermissive THEN 't' ELSE 'f' END
                 || ' roles=' || COALESCE(
                      (SELECT pg_catalog.string_agg(
                                r.rolname::text, ','
                                ORDER BY r.rolname::text COLLATE "C")
                         FROM pg_catalog.pg_roles r
                        WHERE r.oid = ANY (pol.polroles)), 'PUBLIC')
                 || ' using=' || COALESCE(
                      pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '')
                 || ' check=' || COALESCE(
                      pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid),
                      ''))::text
          FROM pg_catalog.pg_policy pol
          JOIN pg_catalog.pg_class ct ON ct.oid = pol.polrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ct.relnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'type'::text,
               (n.nspname || '.' || t.typname)::text,
               ('typtype=' || t.typtype::text)::text
          FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = ANY (${managed})
           AND t.typtype IN ('c', 'e', 'd', 'r', 'm')
           AND NOT EXISTS (SELECT 1
                             FROM pg_catalog.pg_class c
                            WHERE c.oid = t.typrelid AND c.relkind <> 'c')
        UNION ALL
        SELECT 'trigger'::text,
               (n.nspname || '.' || ct.relname || '.' || tg.tgname)::text,
               ('def=' || pg_catalog.pg_get_triggerdef(tg.oid))::text
          FROM pg_catalog.pg_trigger tg
          JOIN pg_catalog.pg_class ct ON ct.oid = tg.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ct.relnamespace
         WHERE n.nspname = ANY (${managed})
           AND NOT tg.tgisinternal
      ) AS stage06_projection`;
};

/** 报告里最多列出的差异条数与每条差异的最大长度，避免异常信息无界增长。 */
const reportedDivergences = 8;
const reportedEntryLength = 500;

/**
 * 渲染出的比对块：`expected`（manifest）与 `actual`（catalog 规范化投影）做全外
 * 连接，任何 unexpected / missing / drifted 都会 `RAISE EXCEPTION`。两个入口执行
 * 的是同一段文本，因此同一批 mutation 得到的拒绝结果逐字一致。
 */
export const renderStage06ManifestCheckSql = (
  manifest: Stage06Manifest = stage06SecurityManifest,
): string => {
  const rows = canonicalManifestRows(manifest);
  if (rows.length === 0) {
    throw new Stage06ManifestError("the manifest must not be empty");
  }
  const expected = rows
    .map(
      (row, index) =>
        `      (${sqlLiteral(row.kind)}${index === 0 ? "::text" : ""}, ` +
        `${sqlLiteral(row.identity)}${index === 0 ? "::text" : ""}, ` +
        `${sqlLiteral(row.detail)}${index === 0 ? "::text" : ""})`,
    )
    .join(",\n");

  return `DO ${dollarTag}
DECLARE
  divergence_count integer;
  divergence text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);

  WITH expected (kind, identity, detail) AS (
    VALUES
${expected}
  ),
  actual (kind, identity, detail) AS (
    ${renderStage06CatalogProjectionSql(manifest)}
  ),
  divergence_rows (kind, entry) AS (
    SELECT a.kind,
           'unexpected ' || a.kind || ' ' || a.identity || ' [' || a.detail || ']'
      FROM actual a
      LEFT JOIN expected e ON e.kind = a.kind AND e.identity = a.identity
     WHERE e.kind IS NULL
    UNION ALL
    SELECT e.kind, 'missing ' || e.kind || ' ' || e.identity
      FROM expected e
      LEFT JOIN actual a ON a.kind = e.kind AND a.identity = e.identity
     WHERE a.kind IS NULL
    UNION ALL
    SELECT e.kind,
           'drifted ' || e.kind || ' ' || e.identity
             || ' [expected ' || e.detail || '] [found ' || a.detail || ']'
      FROM expected e
      JOIN actual a ON a.kind = e.kind AND a.identity = e.identity
     WHERE a.detail IS DISTINCT FROM e.detail
  ),
  -- 报告顺序按「结构性 → 派生性」固定：一张表被删掉时，operator 首先要看到的是
  -- "missing relation"，而不是它连带的十几条约束。排序完全确定，不依赖 locale。
  ranked_divergences (rank, entry) AS (
    SELECT CASE kind
             WHEN 'schema' THEN 1 WHEN 'relation' THEN 2 WHEN 'routine' THEN 3
             WHEN 'policy' THEN 4 WHEN 'trigger' THEN 5 WHEN 'type' THEN 6
             WHEN 'index' THEN 7 WHEN 'constraint' THEN 8 ELSE 9
           END,
           entry
      FROM divergence_rows
  )
  SELECT (SELECT count(*) FROM ranked_divergences)::integer,
         (SELECT pg_catalog.string_agg(
                   pg_catalog.left(entry, ${String(reportedEntryLength)}), '; '
                   ORDER BY rank, entry COLLATE "C")
            FROM (SELECT rank, entry FROM ranked_divergences
                   ORDER BY rank, entry COLLATE "C"
                   LIMIT ${String(reportedDivergences)}) AS capped)
    INTO divergence_count, divergence;

  IF divergence_count > 0 THEN
    RAISE EXCEPTION
      'stage06 object manifest does not match the frozen 0000 '
      '(% divergence(s), manifest version ${String(stage06ManifestVersion)}): %',
      divergence_count,
      divergence
        || CASE WHEN divergence_count > ${String(reportedDivergences)}
                  THEN '; ...' ELSE '' END;
  END IF;
END
${dollarTag};
`;
};

/** generated adapter 的固定文件头。不含时间戳、绝对路径、locale 或随机值。 */
export const renderStage06ManifestAdapter = (
  manifest: Stage06Manifest = stage06SecurityManifest,
): string =>
  [
    "-- 阶段 09A / M2A：冻结 0000 的对象与安全属性 manifest。",
    "--",
    "-- GENERATED FILE — DO NOT EDIT.",
    "-- 事实源： services/api/src/database/stage06-manifest.ts",
    "-- 重新生成： pnpm --filter @meal-agent/api manifest:generate",
    "-- 门禁： pnpm --filter @meal-agent/api manifest:check（内存渲染逐字节比对，" +
      "不会自动改写本文件）",
    `-- manifest version: ${String(manifest.version)}`,
    `-- canonical manifest digest: sha256:${manifestDigest(manifest)}`,
    "--",
    "-- 本文件是纯 SQL：不含 psql 元命令，不做任何 ownership/ACL/DDL 变更，只在与",
    "-- manifest 不符时 RAISE EXCEPTION。pg 与 psql 都能直接执行。",
    "",
    renderStage06ManifestCheckSql(manifest),
  ].join("\n");
