import {
  authorizationDigest,
  authorizationManifest,
  authorizationManifestVersion,
  AuthorizationManifestError,
  authorizationStateKey,
  authorizationStateKeys,
  canonicalAuthorizationRows,
  defaultAclSlots,
  type AuthorizationManifest,
} from "./authorization-manifest.js";
import { byCodeUnit } from "./stage06-manifest.js";

/**
 * 阶段 09A / M2A：把 ledger 感知的授权 manifest 渲染成两段确定性 SQL。
 *
 *   - **converge**：按真实 grantor 撤销一切「不在 manifest 里」的授权，然后只
 *     重建 manifest 允许的项。它是唯一会改 ACL 的产物，由 database scope 的
 *     containment / final 两个阶段各调用一次。
 *   - **verify**：只读断言。同时比对 catalog ACL、`pg_default_acl` 的**有效**
 *     默认权限，以及 `has_*_privilege` 的**有效**权限——后者会把 `PUBLIC` 派生和
 *     角色继承算进来，只查直接授权看不见的洞在这里才会显形。
 *
 * 阶段通过带命名空间的 GUC `meal_agent.acl_phase` 传入（`containment` /
 * `final`），ledger 从 `drizzle.__meal_agent_migrations` 现场读取。未登记的
 * `(ledger, phase)` 组合一律 fail closed。
 */

const convergeTag = "$meal_agent_authorization_converge$";
const verifyTag = "$meal_agent_authorization_verify$";

const unrenderable = (value: string): boolean =>
  ["\\", "\r", "\n", String.fromCharCode(0), convergeTag, verifyTag].some(
    (forbidden) => value.includes(forbidden),
  );

const literal = (value: string): string => {
  if (unrenderable(value)) {
    throw new AuthorizationManifestError(
      "a manifest value cannot be rendered as a deterministic SQL literal",
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
};

const textArray = (values: readonly string[]): string =>
  values.length === 0
    ? "ARRAY[]::text[]"
    : `ARRAY[${values.map(literal).join(", ")}]::text[]`;

/** `PUBLIC` 在 `has_*_privilege` 里写作小写 `public`，在 SQL 语句里写作 `PUBLIC`。 */
const granteeProbe = (grantee: string): string =>
  grantee === "PUBLIC" ? "public" : grantee;

const sessionPreamble = `  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
  PERFORM pg_catalog.set_config('quote_all_identifiers', 'off', true);`;

/** 从 ledger 与 GUC 解析 state key；未登记组合 fail closed。 */
const stateResolution = (manifest: AuthorizationManifest): string => `
  IF to_regclass('drizzle.__meal_agent_migrations') IS NULL THEN
    RAISE EXCEPTION
      'authorization manifest: the migration ledger is missing; the database '
      'is not in a state this baseline can reason about';
  END IF;
  SELECT COALESCE(
           pg_catalog.string_agg(name, ',' ORDER BY name COLLATE "C"), '')
    INTO ledger_signature
    FROM drizzle.__meal_agent_migrations;
  acl_phase := current_setting('meal_agent.acl_phase');
  IF acl_phase NOT IN ('containment', 'final') THEN
    RAISE EXCEPTION
      'authorization manifest: unknown phase %; expected containment or final',
      acl_phase;
  END IF;
  state_key := ledger_signature || '|' || acl_phase;
  IF NOT (state_key = ANY (${textArray(authorizationStateKeys(manifest))})) THEN
    RAISE EXCEPTION
      'authorization manifest: unregistered (ledger, phase) state %; register '
      'it in services/api/src/database/authorization-manifest.ts before '
      'running this baseline', state_key;
  END IF;`;

const watchedArray = (manifest: AuthorizationManifest): string =>
  textArray([...manifest.watchedGrantees].sort(byCodeUnit));

const managedArray = (manifest: AuthorizationManifest): string =>
  textArray([...manifest.managedSchemas].sort(byCodeUnit));

/**
 * 被管理对象及其 SQL 目标片段。`GRANT` 需要它来定位那些当前**还没有任何 ACL 行**
 * 的对象，因此不能只从现有 ACL 反推。
 */
const managedObjectsCte = (manifest: AuthorizationManifest): string => `
    managed_objects (objkey, target) AS (
      SELECT 'database:<current>'::text,
             ('DATABASE ' || quote_ident(current_database()))::text
      UNION ALL
      SELECT 'schema:' || n.nspname,
             'SCHEMA ' || quote_ident(n.nspname)
        FROM pg_catalog.pg_namespace n
       WHERE n.nspname = ANY (${managedArray(manifest)})
      UNION ALL
      SELECT 'relation:' || n.nspname || '.' || c.relname,
             CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END
               || quote_ident(n.nspname) || '.' || quote_ident(c.relname)
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY (${managedArray(manifest)})
         AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      UNION ALL
      SELECT 'routine:' || n.nspname || '.' || p.proname || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             'ROUTINE ' || quote_ident(n.nspname) || '.'
               || quote_ident(p.proname) || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = ANY (${managedArray(manifest)})
      UNION ALL
      SELECT 'type:' || n.nspname || '.' || t.typname,
             'TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname)
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = ANY (${managedArray(manifest)})
      UNION ALL
      SELECT 'language:' || l.lanname, 'LANGUAGE ' || quote_ident(l.lanname)
        FROM pg_catalog.pg_language l
    )`;

/**
 * 当前直接授权。带 grantor 与目标片段，供收敛阶段以**真实 grantor 身份**撤销；
 * 列级授权单独带 colname，因为它不在 `relacl` 里。
 */
const currentAclCte = (manifest: AuthorizationManifest): string => `
    current_acl (objkey, target, colname, grantee, grantor, privilege,
                 grantable) AS (
      SELECT 'database:<current>'::text,
             ('DATABASE ' || quote_ident(current_database()))::text,
             NULL::text,
             (CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(acl.grantee) END)::text,
             pg_catalog.pg_get_userbyid(acl.grantor)::text,
             acl.privilege_type::text, acl.is_grantable
        FROM pg_catalog.pg_database d,
             -- datacl 为 NULL 时是**隐式**默认 ACL（PUBLIC 有 CONNECT/TEMPORARY），
             -- aclexplode(NULL) 会漏掉它，因此用 acldefault 展开。
             aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) AS acl
       WHERE d.datname = current_database()
      UNION ALL
      SELECT 'schema:' || n.nspname,
             'SCHEMA ' || quote_ident(n.nspname), NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) AS acl
       WHERE n.nspname = ANY (${managedArray(manifest)})
      UNION ALL
      SELECT 'relation:' || n.nspname || '.' || c.relname,
             CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END
               || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
             aclexplode(c.relacl) AS acl
       WHERE n.nspname = ANY (${managedArray(manifest)})
      UNION ALL
      SELECT 'column:' || n.nspname || '.' || c.relname || '.' || a.attname,
             'TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
             a.attname::text,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
             aclexplode(a.attacl) AS acl
       WHERE n.nspname = ANY (${managedArray(manifest)})
      UNION ALL
      SELECT 'routine:' || n.nspname || '.' || p.proname || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             'ROUTINE ' || quote_ident(n.nspname) || '.'
               || quote_ident(p.proname) || '('
               || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
             aclexplode(COALESCE(p.proacl,
                                 acldefault('f', p.proowner))) AS acl
       WHERE n.nspname = ANY (${managedArray(manifest)})
      UNION ALL
      SELECT 'type:' || n.nspname || '.' || t.typname,
             'TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname),
             NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace,
             aclexplode(COALESCE(t.typacl,
                                 acldefault('T', t.typowner))) AS acl
       WHERE n.nspname = ANY (${managedArray(manifest)})
      UNION ALL
      SELECT 'language:' || l.lanname,
             'LANGUAGE ' || quote_ident(l.lanname), NULL,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             pg_catalog.pg_get_userbyid(acl.grantor),
             acl.privilege_type, acl.is_grantable
        FROM pg_catalog.pg_language l, aclexplode(l.lanacl) AS acl
    )`;

/** `pg_default_acl` 的**有效**默认权限：schema 行 → 全局行 → 内建默认。 */
const currentDefaultCte = (manifest: AuthorizationManifest): string => {
  const slots = defaultAclSlots(manifest)
    .map(
      (slot, index) =>
        `        (${literal(slot.objtype)}${index === 0 ? "::text" : ""}, ` +
        `${literal(slot.scope)}${index === 0 ? "::text" : ""})`,
    )
    .join(",\n");
  return `
    default_slots (objtype, scope) AS (
      VALUES
${slots}
    ),
    current_default (scope_key, grantee, privilege) AS (
      SELECT s.objtype || '@' || s.scope,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
             acl.privilege_type::text
        FROM default_slots s,
             LATERAL (
               SELECT COALESCE(
                 (SELECT d.defaclacl
                    FROM pg_catalog.pg_default_acl d
                    JOIN pg_catalog.pg_namespace dn ON dn.oid = d.defaclnamespace
                   WHERE pg_catalog.pg_get_userbyid(d.defaclrole)
                           = 'meal_agent_migrator'
                     AND d.defaclobjtype = s.objtype::"char"
                     AND dn.nspname = s.scope),
                 (SELECT d.defaclacl
                    FROM pg_catalog.pg_default_acl d
                   WHERE pg_catalog.pg_get_userbyid(d.defaclrole)
                           = 'meal_agent_migrator'
                     AND d.defaclobjtype = s.objtype::"char"
                     AND d.defaclnamespace = 0),
                 acldefault(s.objtype::"char",
                            (SELECT oid FROM pg_catalog.pg_roles
                              WHERE rolname = 'meal_agent_migrator'))
               ) AS effective_acl
             ) AS resolved,
             aclexplode(resolved.effective_acl) AS acl
       WHERE (CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(acl.grantee) END)
             = ANY (${watchedArray(manifest)})
    )`;
};

/** manifest 允许的直接授权 / 默认权限，带 state key 供运行期筛选。 */
const allowedCtes = (manifest: AuthorizationManifest): string => {
  const grantRows: string[] = [];
  const defaultRows: string[] = [];
  for (const state of manifest.states) {
    const key = authorizationStateKey(state.ledger, state.phase);
    for (const entry of state.grants) {
      for (const privilege of entry.privileges) {
        grantRows.push(
          `        (${literal(key)}, ${literal(entry.object)}, ` +
            `${literal(entry.grantee)}, ${literal(privilege)})`,
        );
      }
    }
    for (const entry of state.defaults) {
      for (const privilege of entry.privileges) {
        defaultRows.push(
          `        (${literal(key)}, ${literal(entry.scope)}, ` +
            `${literal(entry.grantee)}, ${literal(privilege)})`,
        );
      }
    }
  }
  grantRows.sort(byCodeUnit);
  defaultRows.sort(byCodeUnit);
  const cast = (rows: string[]): string =>
    rows
      .map((row, index) =>
        index === 0
          ? row.replace(/, /gu, "::text, ").replace(/\)$/u, "::text)")
          : row,
      )
      .join(",\n");
  return `
    allowed_grant (state, objkey, grantee, privilege) AS (
      VALUES
${cast(grantRows)}
    ),
    allowed_default (state, scope_key, grantee, privilege) AS (
      VALUES
${cast(defaultRows)}
    )`;
};

const objtypeKeyword = `CASE split_part(scope_key, '@', 1)
             WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES'
             WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES'
             WHEN 'n' THEN 'SCHEMAS' WHEN 'L' THEN 'LARGE OBJECTS' END`;

/**
 * 收敛：先关闭 Large Object 入口，再撤销一切不在 manifest 里的授权（按真实
 * grantor），最后只重建 manifest 允许的项。`GRANT OPTION` 一律不允许，因此存在
 * grant option 时无条件先收回。
 */
export const renderAuthorizationConvergeSql = (
  manifest: AuthorizationManifest = authorizationManifest,
): string => `DO ${convergeTag}
DECLARE
  ledger_signature text;
  acl_phase text;
  state_key text;
  missing text;
  row_record record;
BEGIN
${sessionPreamble}
${stateResolution(manifest)}

  -- 1. Large Object 入口。产品声明禁用 LO，因此 pg_catalog 的创建/读写入口不能
  --    保留 PUBLIC EXECUTE——否则 runtime 可以自己造出不受 schema ACL 与 RLS
  --    约束的存储面。同时清掉可能直接授予被监管角色的那一份。
  FOR row_record IN
    SELECT identity FROM unnest(${textArray(
      [...manifest.deniedRoutines].sort(byCodeUnit),
    )}) AS identity
  LOOP
    IF to_regprocedure(row_record.identity) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC CASCADE',
                     row_record.identity);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %s CASCADE',
                     row_record.identity,
                     (SELECT string_agg(quote_ident(g), ', ' ORDER BY g)
                        FROM unnest(${watchedArray(manifest)}) AS g
                       WHERE g <> 'PUBLIC'));
    END IF;
  END LOOP;

  -- 1b. Large Object 上的对象权限。LO 不受 schema ACL 与 RLS 约束，产品也不使用
  --     它，因此指向被监管角色或 PUBLIC 的 lomacl 条目一律按真实 grantor 撤销。
  --     LO 的**归属**不在这里处理：项目角色拥有 LO 由调用方报告并失败，不删数据。
  FOR row_record IN
    SELECT m.oid AS loid,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident(pg_catalog.pg_get_userbyid(acl.grantee))
           END AS grantee_sql,
           pg_catalog.pg_get_userbyid(acl.grantor) AS grantor,
           acl.privilege_type AS privilege
      FROM pg_catalog.pg_largeobject_metadata m,
           aclexplode(m.lomacl) AS acl
     WHERE acl.grantee = 0
        OR pg_catalog.pg_get_userbyid(acl.grantee)
             = ANY (${watchedArray(manifest)})
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', row_record.grantor);
    EXECUTE format('REVOKE %s ON LARGE OBJECT %s FROM %s CASCADE',
                   row_record.privilege, row_record.loid,
                   row_record.grantee_sql);
    RESET ROLE;
  END LOOP;

  -- 2. 撤销 current − allowed，按真实 grantor。列级授权一律不允许。
  FOR row_record IN
    WITH${currentAclCte(manifest)},${allowedCtes(manifest)}
    SELECT ca.target, ca.colname, ca.privilege, ca.grantable,
           ca.grantor,
           CASE WHEN ca.grantee = 'PUBLIC' THEN 'PUBLIC'
                ELSE quote_ident(ca.grantee) END AS grantee_sql,
           EXISTS (SELECT 1 FROM allowed_grant a
                    WHERE a.state = state_key AND a.objkey = ca.objkey
                      AND a.grantee = ca.grantee
                      AND a.privilege = ca.privilege) AS is_allowed
      FROM current_acl ca
     WHERE ca.grantee = ANY (${watchedArray(manifest)})
  LOOP
    IF row_record.is_allowed AND NOT row_record.grantable
       AND row_record.colname IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', row_record.grantor);
    IF row_record.colname IS NOT NULL THEN
      EXECUTE format('REVOKE %s (%I) ON %s FROM %s CASCADE',
                     row_record.privilege, row_record.colname,
                     row_record.target, row_record.grantee_sql);
    ELSE
      EXECUTE format('REVOKE GRANT OPTION FOR %s ON %s FROM %s CASCADE',
                     row_record.privilege, row_record.target,
                     row_record.grantee_sql);
      IF NOT row_record.is_allowed THEN
        EXECUTE format('REVOKE %s ON %s FROM %s CASCADE',
                       row_record.privilege, row_record.target,
                       row_record.grantee_sql);
      END IF;
    END IF;
    RESET ROLE;
  END LOOP;

  -- 3. manifest 声明的对象必须真实存在，否则 GRANT 会静默漏掉。
  WITH${managedObjectsCte(manifest)},${allowedCtes(manifest)}
  SELECT string_agg(DISTINCT a.objkey, ', ' ORDER BY a.objkey) INTO missing
    FROM allowed_grant a
   WHERE a.state = state_key
     AND NOT EXISTS (SELECT 1 FROM managed_objects mo
                      WHERE mo.objkey = a.objkey);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'authorization manifest: state % expects object(s) that do not exist: %',
      state_key, missing;
  END IF;

  -- 4. 授予 allowed − current。
  FOR row_record IN
    WITH${managedObjectsCte(manifest)},${currentAclCte(
      manifest,
    )},${allowedCtes(manifest)}
    SELECT mo.target,
           CASE WHEN a.grantee = 'PUBLIC' THEN 'PUBLIC'
                ELSE quote_ident(a.grantee) END AS grantee_sql,
           a.privilege
      FROM allowed_grant a
      JOIN managed_objects mo ON mo.objkey = a.objkey
     WHERE a.state = state_key
       AND NOT EXISTS (SELECT 1 FROM current_acl ca
                        WHERE ca.objkey = a.objkey
                          AND ca.grantee = a.grantee
                          AND ca.privilege = a.privilege
                          AND ca.colname IS NULL)
  LOOP
    EXECUTE format('GRANT %s ON %s TO %s', row_record.privilege,
                   row_record.target, row_record.grantee_sql);
  END LOOP;

  -- 5. default privileges：逐槽位比较有效默认权限并收敛。
  FOR row_record IN
    WITH${currentDefaultCte(manifest)},${allowedCtes(manifest)}
    SELECT scope_key, grantee, privilege, action FROM (
      SELECT cd.scope_key, cd.grantee, cd.privilege, 'REVOKE'::text AS action
        FROM current_default cd
       WHERE NOT EXISTS (SELECT 1 FROM allowed_default ad
                          WHERE ad.state = state_key
                            AND ad.scope_key = cd.scope_key
                            AND ad.grantee = cd.grantee
                            AND ad.privilege = cd.privilege)
      UNION ALL
      SELECT ad.scope_key, ad.grantee, ad.privilege, 'GRANT'
        FROM allowed_default ad
       WHERE ad.state = state_key
         AND NOT EXISTS (SELECT 1 FROM current_default cd
                          WHERE cd.scope_key = ad.scope_key
                            AND cd.grantee = ad.grantee
                            AND cd.privilege = ad.privilege)
    ) AS diff
     ORDER BY action DESC, scope_key, grantee, privilege
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE meal_agent_migrator%s %s %s ON %s %s %s',
      CASE WHEN split_part(row_record.scope_key, '@', 2) = 'global' THEN ''
           ELSE ' IN SCHEMA '
                || quote_ident(split_part(row_record.scope_key, '@', 2)) END,
      row_record.action, row_record.privilege,
      ${objtypeKeyword.replaceAll("scope_key", "row_record.scope_key")},
      CASE WHEN row_record.action = 'REVOKE' THEN 'FROM' ELSE 'TO' END,
      CASE WHEN row_record.grantee = 'PUBLIC' THEN 'PUBLIC'
           ELSE quote_ident(row_record.grantee) END);
  END LOOP;
END
${convergeTag};
`;

/** 只读断言：catalog ACL、有效默认权限与 `has_*_privilege` 有效权限三者同时比对。 */
export const renderAuthorizationVerifySql = (
  manifest: AuthorizationManifest = authorizationManifest,
): string => {
  const rows = canonicalAuthorizationRows(manifest);
  if (rows.length === 0) {
    throw new AuthorizationManifestError("the manifest must not be empty");
  }
  const expected = rows
    .map(
      (row, index) =>
        `      (${literal(row.state)}${index === 0 ? "::text" : ""}, ` +
        `${literal(row.kind)}${index === 0 ? "::text" : ""}, ` +
        `${literal(row.identity)}${index === 0 ? "::text" : ""}, ` +
        `${literal(row.detail)}${index === 0 ? "::text" : ""})`,
    )
    .join(",\n");

  return `DO ${verifyTag}
DECLARE
  ledger_signature text;
  acl_phase text;
  state_key text;
  divergence_count integer;
  divergence text;
BEGIN
${sessionPreamble}
${stateResolution(manifest)}

  WITH expected_all (state, kind, identity, detail) AS (
    VALUES
${expected}
  ),
  expected AS (
    SELECT kind, identity, detail FROM expected_all WHERE state = state_key
  ),${currentAclCte(manifest)},${currentDefaultCte(manifest)},
  watched (grantee, probe) AS (
    VALUES
${manifest.watchedGrantees
  .map(
    (grantee, index) =>
      `      (${literal(grantee)}${index === 0 ? "::text" : ""}, ` +
      `${literal(granteeProbe(grantee))}${index === 0 ? "::text" : ""})`,
  )
  .join(",\n")}
  ),
  actual (kind, identity, detail) AS (
    -- 受控 routine 的精确指纹：identity + owner + SECURITY DEFINER + proconfig
    -- + 正文摘要。EXECUTE 授权只是一半，另一半是「以谁的身份、带什么
    -- search_path / row_security、跑的是不是原来那份正文」。
    SELECT 'routine'::text,
           (n.nspname || '.' || p.proname || '('
             || pg_catalog.pg_get_function_identity_arguments(p.oid)
             || ')')::text,
           ('owner=' || pg_catalog.pg_get_userbyid(p.proowner)
             || ' secdef=' || CASE WHEN p.prosecdef THEN 't' ELSE 'f' END
             || ' config='
             || COALESCE(pg_catalog.array_to_string(p.proconfig, '|'), '')
             || ' body='
             || pg_catalog.encode(
                  pg_catalog.sha256(
                    pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex'))::text
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY (${managedArray(manifest)})
    UNION ALL
    -- 同一条权限可能由多个 grantor 分别授予，aclexplode 会给出多行。这里先
    -- DISTINCT 再聚合，否则「两个 grantor 都授了 SELECT」会渲染成 SELECT,SELECT。
    SELECT 'grant', (objkey || '#' || grantee)::text,
           ('privs=' || pg_catalog.string_agg(entry, ','
                                              ORDER BY entry COLLATE "C"))::text
      FROM (
        SELECT DISTINCT objkey, grantee,
               privilege || CASE WHEN grantable THEN '*' ELSE '' END AS entry
          FROM current_acl
         WHERE grantee = ANY (${watchedArray(manifest)})
      ) AS distinct_acl
     GROUP BY objkey, grantee
    UNION ALL
    SELECT 'default', scope_key || '#' || grantee,
           'privs=' || pg_catalog.string_agg(privilege, ','
                                             ORDER BY privilege COLLATE "C")
      FROM current_default
     GROUP BY scope_key, grantee
    UNION ALL
    SELECT 'effective', object || '#' || role, 'privs=' || privileges
      FROM (
        SELECT 'database:<current>' AS object, w.grantee AS role,
               (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
                  FROM unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p
                 WHERE has_database_privilege(w.probe, current_database(), p))
                 AS privileges
          FROM watched w
        UNION ALL
        SELECT 'schema:' || n.nspname, w.grantee,
               (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
                  FROM unnest(ARRAY['CREATE', 'USAGE']) AS p
                 WHERE has_schema_privilege(w.probe, n.oid, p))
          FROM pg_catalog.pg_namespace n, watched w
         WHERE n.nspname = ANY (${managedArray(manifest)})
        UNION ALL
        SELECT 'relation:' || n.nspname || '.' || c.relname, w.grantee,
               CASE WHEN c.relkind = 'S' THEN
                 (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
                    FROM unnest(ARRAY['SELECT', 'UPDATE', 'USAGE']) AS p
                   WHERE has_sequence_privilege(w.probe, c.oid, p))
               ELSE
                 (SELECT pg_catalog.string_agg(p, ',' ORDER BY p COLLATE "C")
                    FROM unnest(ARRAY['DELETE', 'INSERT', 'MAINTAIN',
                                      'REFERENCES', 'SELECT', 'TRIGGER',
                                      'TRUNCATE', 'UPDATE']) AS p
                   WHERE has_table_privilege(w.probe, c.oid, p))
               END
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, watched w
         WHERE n.nspname = ANY (${managedArray(manifest)})
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        UNION ALL
        SELECT 'routine:' || n.nspname || '.' || p.proname || '('
                 || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
               w.grantee,
               CASE WHEN has_function_privilege(w.probe, p.oid, 'EXECUTE')
                    THEN 'EXECUTE' ELSE NULL END
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace, watched w
         WHERE n.nspname = ANY (${managedArray(manifest)})
        UNION ALL
        SELECT 'routine:' || denied.identity, w.grantee,
               CASE WHEN has_function_privilege(
                      w.probe, denied.identity::regprocedure, 'EXECUTE')
                    THEN 'EXECUTE' ELSE NULL END
          FROM unnest(${textArray(
            [...manifest.deniedRoutines].sort(byCodeUnit),
          )}) AS denied(identity), watched w
         WHERE to_regprocedure(denied.identity) IS NOT NULL
      ) AS effective_rows
     WHERE privileges IS NOT NULL
  ),
  divergence_rows (kind, entry) AS (
    SELECT a.kind,
           'unexpected ' || a.kind || ' ' || a.identity || ' [' || a.detail || ']'
      FROM actual a
      LEFT JOIN expected e ON e.kind = a.kind AND e.identity = a.identity
     WHERE e.kind IS NULL
    UNION ALL
    SELECT e.kind, 'missing ' || e.kind || ' ' || e.identity
             || ' [expected ' || e.detail || ']'
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
  )
  SELECT (SELECT count(*) FROM divergence_rows)::integer,
         (SELECT pg_catalog.string_agg(pg_catalog.left(entry, 400), '; '
                                       ORDER BY rank, entry COLLATE "C")
            FROM (SELECT CASE kind WHEN 'effective' THEN 1 WHEN 'routine' THEN 2
                                   WHEN 'grant' THEN 3 ELSE 4 END AS rank,
                         entry
                    FROM divergence_rows
                   ORDER BY rank, entry COLLATE "C" LIMIT 8) AS capped)
    INTO divergence_count, divergence;

  IF divergence_count > 0 THEN
    RAISE EXCEPTION
      'authorization manifest does not match state % '
      '(% divergence(s), manifest version ${String(
        authorizationManifestVersion,
      )}): %',
      state_key, divergence_count,
      divergence || CASE WHEN divergence_count > 8 THEN '; ...' ELSE '' END;
  END IF;
END
${verifyTag};
`;
};

const adapterHeader = (
  manifest: AuthorizationManifest,
  title: string,
  nature: string,
): readonly string[] => [
  `-- 阶段 09A / M2A：${title}`,
  "--",
  "-- GENERATED FILE — DO NOT EDIT.",
  "-- 事实源： services/api/src/database/authorization-manifest.ts",
  "-- 重新生成： pnpm --filter @meal-agent/api manifest:generate",
  "-- 门禁： pnpm --filter @meal-agent/api manifest:check（内存渲染逐字节比对，" +
    "不会自动改写本文件）",
  `-- manifest version: ${String(manifest.version)}`,
  `-- canonical manifest digest: sha256:${authorizationDigest(manifest)}`,
  "--",
  `-- ${nature}`,
  "-- 调用方必须先设置 GUC meal_agent.acl_phase（containment 或 final）。",
  "",
];

export const renderAuthorizationConvergeAdapter = (
  manifest: AuthorizationManifest = authorizationManifest,
): string =>
  [
    ...adapterHeader(
      manifest,
      "授权收敛（按真实 grantor 撤销一切不在 manifest 内的授权，再只重建允许项）。",
      "本文件会修改 ACL：这是它的职责。它不改 ownership，也不建任何对象。",
    ),
    renderAuthorizationConvergeSql(manifest),
  ].join("\n");

export const renderAuthorizationVerifyAdapter = (
  manifest: AuthorizationManifest = authorizationManifest,
): string =>
  [
    ...adapterHeader(
      manifest,
      "授权断言（catalog ACL + 有效默认权限 + has_*_privilege 有效权限）。",
      "本文件是纯只读 SQL：不匹配时 RAISE EXCEPTION，不做任何变更。",
    ),
    renderAuthorizationVerifySql(manifest),
  ].join("\n");
