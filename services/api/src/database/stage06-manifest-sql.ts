import {
  canonicalManifestRows,
  databaseIdentity,
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
 * 会话稳定性：`pg_get_indexdef` / `pg_get_constraintdef` / `pg_get_expr` /
 * `pg_get_triggerdef` 的输出同时受两个 GUC 影响——
 *   - `search_path` 决定是否省略 schema 限定；
 *   - `quote_all_identifiers` 决定是否给每个标识符加双引号。
 * 两者都在 `DO` 块开头以**事务内**方式固定，块结束即失效，因此同一个数据库在任何
 * 会话里都得到同一份规范化文本。字面量本身不含反斜杠（manifest 侧强制），因此
 * `standard_conforming_strings` 的取值不影响结果。
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
  values.length === 0
    ? "ARRAY[]::text[]"
    : `ARRAY[${values.map(sqlLiteral).join(", ")}]::text[]`;

/**
 * handoff 阶段由**整组** owner 状态判定，而不是 database owner 单字段。
 *
 * 只有两种合法状态：整组都还没交接（pre-handoff），或整组都已属于
 * `meal_agent_migrator`（post-handoff）。任何混合态——例如「handoff 之后只把
 * database owner 夺回给 admin」或「database 属于 admin 而 schema/ledger 已属于
 * migrator」——都不是一个可以继续推理的状态，必须直接拒绝，否则单字段判据会被
 * 一次局部改动整体带偏。
 *
 * `handoff_pending_owners` 返回该组对象当前 owner 的去重集合。
 */
export const handoffOwnerTupleSql = (
  manifest: Stage06Manifest = stage06SecurityManifest,
): string => {
  const pending = handoffPendingKeys(manifest);
  return `SELECT DISTINCT owner_name FROM (
      SELECT pg_catalog.pg_get_userbyid(d.datdba)::text AS owner_name
        FROM pg_catalog.pg_database d
       WHERE d.datname = current_database()
         AND ${sqlLiteral(`database:${databaseIdentity}`)}
               = ANY (${sqlTextArray(pending)})
      UNION ALL
      SELECT pg_catalog.pg_get_userbyid(n.nspowner)::text
        FROM pg_catalog.pg_namespace n
       WHERE 'schema:' || n.nspname = ANY (${sqlTextArray(pending)})
      UNION ALL
      SELECT pg_catalog.pg_get_userbyid(c.relowner)::text
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE 'relation:' || n.nspname || '.' || c.relname
               = ANY (${sqlTextArray(pending)})
      UNION ALL
      SELECT pg_catalog.pg_get_userbyid(t.typowner)::text
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE 'type:' || n.nspname || '.' || t.typname
               = ANY (${sqlTextArray(pending)})
    ) AS handoff_owners`;
};

/**
 * 合法过渡态的 owner 取值：migrator（已交接）、`pg_database_owner` 或当前执行
 * bootstrap 的 admin（未交接）。
 */
const transitionalOwnerArray =
  "ARRAY['meal_agent_migrator', 'pg_database_owner', current_user::text]::text[]";

/**
 * owner 归一化。只有**声明为 handoff-pending 的对象**、且 handoff 尚未完成时，
 * 才把 bootstrap admin / `pg_database_owner` 归一化成占位符；handoff 完成之后
 * 这些对象必须精确属于 migrator，否则如实报出真实 owner。
 */
const ownerExpression = (
  kind: string,
  identityExpression: string,
  ownerExpressionSql: string,
  pending: readonly string[],
): string =>
  `CASE
              WHEN ${sqlLiteral(`${kind}:`)} || ${identityExpression}
                     = ANY (${sqlTextArray(pending)})
                   AND ${ownerExpressionSql} = ANY (${transitionalOwnerArray})
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
  const database = sqlLiteral(databaseIdentity);

  return `SELECT kind, identity, detail
      FROM (
        SELECT 'database'::text AS kind,
               ${database}::text AS identity,
               ('owner=' || ${ownerExpression(
                 "database",
                 `${database}::text`,
                 "pg_catalog.pg_get_userbyid(d.datdba)::text",
                 pending,
               )})::text AS detail
          FROM pg_catalog.pg_database d
         WHERE d.datname = current_database()
        UNION ALL
        SELECT 'schema'::text,
               n.nspname::text,
               ('owner=' || ${ownerExpression(
                 "schema",
                 "n.nspname::text",
                 "pg_catalog.pg_get_userbyid(n.nspowner)::text",
                 pending,
               )})::text
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
                 || ' persistence=' || c.relpersistence::text
                 || ' rls=' || CASE WHEN c.relrowsecurity THEN 't' ELSE 'f' END
                 || ' force='
                 || CASE WHEN c.relforcerowsecurity THEN 't' ELSE 'f' END)::text
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY (${managed})
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        UNION ALL
        SELECT 'column'::text,
               (n.nspname || '.' || c.relname || '.' || a.attname)::text,
               ('attnum=' || a.attnum::text
                 || ' type=' || pg_catalog.format_type(a.atttypid, a.atttypmod)
                 || ' notnull=' || CASE WHEN a.attnotnull THEN 't' ELSE 'f' END
                 || ' identity=' || a.attidentity::text
                 || ' generated=' || a.attgenerated::text
                 || ' storage=' || a.attstorage::text
                 || ' compression=' || a.attcompression::text
                 || ' collation=' || COALESCE(
                      (SELECT co.collname::text FROM pg_catalog.pg_collation co
                        WHERE co.oid = a.attcollation), '')
                 || ' default=' || COALESCE(
                      (SELECT pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)
                         FROM pg_catalog.pg_attrdef ad
                        WHERE ad.adrelid = c.oid AND ad.adnum = a.attnum),
                      ''))::text
          FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY (${managed})
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
           AND a.attnum > 0 AND NOT a.attisdropped
        UNION ALL
        SELECT 'index'::text,
               (n.nspname || '.' || ci.relname)::text,
               ('table=' || n.nspname || '.' || ct.relname
                 || ' valid=' || CASE WHEN i.indisvalid THEN 't' ELSE 'f' END
                 || ' ready=' || CASE WHEN i.indisready THEN 't' ELSE 'f' END
                 || ' def=' || pg_catalog.pg_get_indexdef(i.indexrelid))::text
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ci ON ci.oid = i.indexrelid
          JOIN pg_catalog.pg_class ct ON ct.oid = i.indrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ci.relnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'constraint'::text,
               (n.nspname || '.' || COALESCE(ct.relname, tt.typname, '-')
                 || '.' || con.conname)::text,
               ('contype=' || con.contype::text
                 || ' validated='
                 || CASE WHEN con.convalidated THEN 't' ELSE 'f' END
                 || ' def=' || pg_catalog.pg_get_constraintdef(con.oid))::text
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
          LEFT JOIN pg_catalog.pg_class ct ON ct.oid = con.conrelid
          LEFT JOIN pg_catalog.pg_type tt ON tt.oid = con.contypid
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
                 || ' strict='
                 || CASE WHEN p.proisstrict THEN 't' ELSE 'f' END
                 || ' set=' || CASE WHEN p.proretset THEN 't' ELSE 'f' END
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
               ('typtype=' || t.typtype::text
                 || ' owner=' || ${ownerExpression(
                   "type",
                   "(n.nspname || '.' || t.typname)::text",
                   "pg_catalog.pg_get_userbyid(t.typowner)::text",
                   pending,
                 )}
                 || ' category=' || t.typcategory::text
                 || ' defined=' || CASE WHEN t.typisdefined THEN 't' ELSE 'f' END
                 || ' len=' || t.typlen::text
                 || ' byval=' || CASE WHEN t.typbyval THEN 't' ELSE 'f' END
                 || ' align=' || t.typalign::text
                 || ' storage=' || t.typstorage::text
                 || ' notnull=' || CASE WHEN t.typnotnull THEN 't' ELSE 'f' END
                 || ' delim=' || t.typdelim::text
                 || ' elem=' || COALESCE(
                      (SELECT pg_catalog.format_type(t.typelem, NULL)
                        WHERE t.typelem <> 0), '')
                 || ' base=' || COALESCE(
                      (SELECT pg_catalog.format_type(t.typbasetype, t.typtypmod)
                        WHERE t.typbasetype <> 0), '')
                 || ' ndims=' || t.typndims::text
                 || ' collation=' || COALESCE(
                      (SELECT co.collname::text FROM pg_catalog.pg_collation co
                        WHERE co.oid = t.typcollation), '')
                 || ' default=' || COALESCE(t.typdefault, ''))::text
          FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = ANY (${managed})
           AND NOT EXISTS (SELECT 1
                             FROM pg_catalog.pg_class c
                            WHERE c.oid = t.typrelid AND c.relkind <> 'c')
        UNION ALL
        SELECT 'trigger'::text,
               (n.nspname || '.' || ct.relname || '.' || tg.tgname)::text,
               ('enabled=' || tg.tgenabled::text
                 || ' def=' || pg_catalog.pg_get_triggerdef(tg.oid))::text
          FROM pg_catalog.pg_trigger tg
          JOIN pg_catalog.pg_class ct ON ct.oid = tg.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ct.relnamespace
         WHERE n.nspname = ANY (${managed})
           AND NOT tg.tgisinternal
        UNION ALL
        SELECT 'constraint-trigger'::text,
               (n.nspname || '.' || ct.relname || '.'
                 || COALESCE(con.conname, '-') || '#' || fp.proname)::text,
               ('enabled=' || tg.tgenabled::text
                 || ' type=' || tg.tgtype::text
                 || ' deferrable='
                 || CASE WHEN tg.tgdeferrable THEN 't' ELSE 'f' END
                 || ' initdeferred='
                 || CASE WHEN tg.tginitdeferred THEN 't' ELSE 'f' END)::text
          FROM pg_catalog.pg_trigger tg
          JOIN pg_catalog.pg_class ct ON ct.oid = tg.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = ct.relnamespace
          JOIN pg_catalog.pg_proc fp ON fp.oid = tg.tgfoid
          LEFT JOIN pg_catalog.pg_constraint con ON con.oid = tg.tgconstraint
         WHERE n.nspname = ANY (${managed})
           AND tg.tgisinternal
        UNION ALL
        SELECT 'rule'::text,
               (n.nspname || '.' || ct.relname || '.' || rw.rulename)::text,
               ('enabled=' || rw.ev_enabled::text
                 || ' def=' || pg_catalog.pg_get_ruledef(rw.oid))::text
          FROM pg_catalog.pg_rewrite rw
          JOIN pg_catalog.pg_class ct ON ct.oid = rw.ev_class
          JOIN pg_catalog.pg_namespace n ON n.oid = ct.relnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'operator'::text,
               (n.nspname || '.' || o.oprname || '('
                 || COALESCE(pg_catalog.format_type(o.oprleft, NULL), '-')
                 || ',' || COALESCE(pg_catalog.format_type(o.oprright, NULL), '-')
                 || ')')::text,
               ('owner=' || pg_catalog.pg_get_userbyid(o.oprowner)::text
                 || ' kind=' || o.oprkind::text)::text
          FROM pg_catalog.pg_operator o
          JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'opclass'::text,
               (n.nspname || '.' || oc.opcname)::text,
               ('owner=' || pg_catalog.pg_get_userbyid(oc.opcowner)::text
                 || ' default='
                 || CASE WHEN oc.opcdefault THEN 't' ELSE 'f' END)::text
          FROM pg_catalog.pg_opclass oc
          JOIN pg_catalog.pg_namespace n ON n.oid = oc.opcnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'opfamily'::text,
               (n.nspname || '.' || opf.opfname)::text,
               ('owner=' || pg_catalog.pg_get_userbyid(opf.opfowner)::text)::text
          FROM pg_catalog.pg_opfamily opf
          JOIN pg_catalog.pg_namespace n ON n.oid = opf.opfnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'collation'::text,
               (n.nspname || '.' || co.collname)::text,
               ('owner=' || pg_catalog.pg_get_userbyid(co.collowner)::text
                 || ' provider=' || co.collprovider::text
                 || ' deterministic='
                 || CASE WHEN co.collisdeterministic THEN 't' ELSE 'f' END)::text
          FROM pg_catalog.pg_collation co
          JOIN pg_catalog.pg_namespace n ON n.oid = co.collnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'conversion'::text,
               (n.nspname || '.' || cv.conname)::text,
               ('owner=' || pg_catalog.pg_get_userbyid(cv.conowner)::text
                 || ' default='
                 || CASE WHEN cv.condefault THEN 't' ELSE 'f' END)::text
          FROM pg_catalog.pg_conversion cv
          JOIN pg_catalog.pg_namespace n ON n.oid = cv.connamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'statistics'::text,
               (n.nspname || '.' || st.stxname)::text,
               ('owner=' || pg_catalog.pg_get_userbyid(st.stxowner)::text)::text
          FROM pg_catalog.pg_statistic_ext st
          JOIN pg_catalog.pg_namespace n ON n.oid = st.stxnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'text-search'::text,
               (n.nspname || '.config:' || tc.cfgname)::text,
               ('owner=' || pg_catalog.pg_get_userbyid(tc.cfgowner)::text)::text
          FROM pg_catalog.pg_ts_config tc
          JOIN pg_catalog.pg_namespace n ON n.oid = tc.cfgnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'text-search'::text,
               (n.nspname || '.dictionary:' || td.dictname)::text,
               ('owner=' || pg_catalog.pg_get_userbyid(td.dictowner)::text)::text
          FROM pg_catalog.pg_ts_dict td
          JOIN pg_catalog.pg_namespace n ON n.oid = td.dictnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'text-search'::text,
               (n.nspname || '.parser:' || tp.prsname)::text,
               ''::text
          FROM pg_catalog.pg_ts_parser tp
          JOIN pg_catalog.pg_namespace n ON n.oid = tp.prsnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'text-search'::text,
               (n.nspname || '.template:' || tt.tmplname)::text,
               ''::text
          FROM pg_catalog.pg_ts_template tt
          JOIN pg_catalog.pg_namespace n ON n.oid = tt.tmplnamespace
         WHERE n.nspname = ANY (${managed})
        UNION ALL
        SELECT 'extension'::text,
               (n.nspname || '.' || ex.extname)::text,
               ('owner=' || pg_catalog.pg_get_userbyid(ex.extowner)::text
                 || ' version=' || ex.extversion)::text
          FROM pg_catalog.pg_extension ex
          JOIN pg_catalog.pg_namespace n ON n.oid = ex.extnamespace
         WHERE n.nspname = ANY (${managed})
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
  saved_search_path text;
  saved_quoting text;
  owner_states text;
  divergence_count integer;
  divergence text;
BEGIN
  -- set_config 的第三个参数只表示「事务内」：它在**事务**结束时才恢复，不会在
  -- DO 块结束时恢复。本块是在一个显式事务里被包含进来执行的，因此必须自己保存
  -- 并还原，否则同一事务的后续语句会继承被改过的两个 GUC。
  saved_search_path := current_setting('search_path');
  saved_quoting := current_setting('quote_all_identifiers');
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
  PERFORM pg_catalog.set_config('quote_all_identifiers', 'off', true);

  -- owner handoff 的阶段由**整组** owner 判定。只有「整组都还没交接」和「整组
  -- 都属于 migrator」两种合法状态；混合态说明有人只改了其中一部分，不是可以继续
  -- 推理的状态。
  SELECT pg_catalog.string_agg(owner_name, ',' ORDER BY owner_name COLLATE "C")
    INTO owner_states
    FROM (${handoffOwnerTupleSql(manifest)}) AS tuple_owners;
  IF owner_states IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM (${handoffOwnerTupleSql(manifest)}) AS bad
       WHERE bad.owner_name <> ALL (${transitionalOwnerArray})
    ) THEN
      RAISE EXCEPTION
        'stage06 object manifest: unexpected owner(s) on the handoff group: %',
        owner_states;
    END IF;
    IF EXISTS (SELECT 1 FROM (${handoffOwnerTupleSql(
      manifest,
    )}) AS a WHERE a.owner_name = 'meal_agent_migrator')
       AND EXISTS (SELECT 1 FROM (${handoffOwnerTupleSql(
         manifest,
       )}) AS b WHERE b.owner_name <> 'meal_agent_migrator') THEN
      RAISE EXCEPTION
        'stage06 object manifest: the owner handoff group is in a mixed state '
        '(%); it must be entirely pre-handoff or entirely owned by '
        'meal_agent_migrator', owner_states;
    END IF;
  END IF;

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
             WHEN 'database' THEN 1 WHEN 'schema' THEN 2 WHEN 'relation' THEN 3
             WHEN 'routine' THEN 4 WHEN 'policy' THEN 5 WHEN 'column' THEN 6
             WHEN 'trigger' THEN 7 WHEN 'constraint-trigger' THEN 8
             WHEN 'rule' THEN 9 WHEN 'type' THEN 10 WHEN 'index' THEN 11
             WHEN 'constraint' THEN 12 ELSE 13
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

  PERFORM pg_catalog.set_config('search_path', saved_search_path, true);
  PERFORM pg_catalog.set_config('quote_all_identifiers', saved_quoting, true);
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
