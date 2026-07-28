import {
  authorizationDigest,
  authorizationManifest,
  authorizationStateKeys,
  validateAuthorizationManifest,
  type AuthorizationManifest,
} from "./authorization-manifest.js";
import {
  granteeSql,
  policyLiteral,
  policyTextArray,
  renderAuthorizationPreflightStatement,
  renderAuthorizationSharedCtes,
} from "./authorization-policy-sql.js";

/**
 * 阶段 09A / M2A（R8B）：把 ledger 感知的授权 manifest 渲染成两段确定性 SQL。
 *
 *   - **converge**：按真实 grantor 撤销一切「策略不允许」的授权，然后只重建
 *     manifest 允许的项。它是唯一会改 ACL 的产物，由 database scope 的
 *     containment / final 两个阶段各调用一次。
 *   - **verify**：只读断言。
 *
 * 两段共享同一条链路，这是 R8B 的结构要求：
 *
 * ```text
 * PostgreSQL catalog
 *   → 共享结构化 projector CTE（authorization-projection-sql.ts）
 *       → 公开只读 projection adapter
 *       → 可移植策略匹配器（authorization-policy-sql.ts）→ verify
 *       → 可移植策略匹配器（authorization-policy-sql.ts）→ converge
 * ```
 *
 * 共享的是**事实采集**，不是把动态投影冻结成跨环境快照：两段都从
 * `acl_source` / `default_row` / `default_raw` / `default_effective` /
 * `effective_source` / `owner_source` / `type_class` / `role_membership` /
 * `probe_role` 读同一套事实，再套同一份可移植策略。因此本文件里**没有**
 * `watchedGrantees` 那样的观察过滤，也**没有**第二份 catalog 枚举。
 *
 * 阶段通过带命名空间的 GUC `meal_agent.acl_phase` 传入（`containment` /
 * `final`），ledger 从 `drizzle.__meal_agent_migrations` 现场读取。未登记的
 * `(ledger, phase)` 组合一律 fail closed。
 *
 * ## 收敛的顺序保证
 *
 * 1. **致命前置条件**（`authorization-policy-sql.ts` 的 preflight）先于任何
 *    mutation 执行。不允许「先改、再靠事务回滚冒充 preflight」。
 * 2. 再按真实 grantor 撤销策略不允许的授权，以及一切可再授予标志。
 * 3. 再以 canonical grantor（`principals.owner`）补齐缺失的固定允许项。
 * 4. 最后按 `pg_default_acl` 的**物理行**收敛默认权限；`default_effective`
 *    只在 verify 里做语义验证，绝不用来反推该执行哪条语句。
 */

const convergeTag = "$meal_agent_authorization_converge$";
const verifyTag = "$meal_agent_authorization_verify$";



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
  IF NOT (state_key = ANY (${policyTextArray(
    authorizationStateKeys(manifest),
  )})) THEN
    RAISE EXCEPTION
      'authorization manifest: unregistered (ledger, phase) state %; register '
      'it in services/api/src/database/authorization-manifest.ts before '
      'running this baseline', state_key;
  END IF;`;

const declarations = `DECLARE
  ledger_signature text;
  acl_phase text;
  state_key text;
  problem_count integer;
  problem_detail text;`;

/**
 * 收敛。**全部致命前置条件先于任何 mutation 执行**；随后按真实 grantor 撤销策略
 * 不允许的授权与一切可再授予标志，再以 canonical grantor 补齐固定允许项，最后
 * 按 `pg_default_acl` 的物理行收敛默认权限。
 */
export const renderAuthorizationConvergeSql = (
  manifest: AuthorizationManifest = authorizationManifest,
): string => {
  validateAuthorizationManifest(manifest);
  const owner = policyLiteral(manifest.principals.owner);
  const shared = renderAuthorizationSharedCtes(manifest);
  return `DO ${convergeTag}
${declarations}
  row_record record;
BEGIN
${sessionPreamble}
${stateResolution(manifest)}

  -- 1. 致命前置条件。**在任何 mutation 之前**：managed schema、项目角色、归属、
  --    routine 指纹、manifest 要求的对象、未知 defaclobjtype、任意 Large
  --    Object，以及无法由 ACL mutation 修复的 membership 漂移。
${renderAuthorizationPreflightStatement(manifest)}

  -- 2. 一次性算出**全部**收敛动作，再按固定顺序执行。动作流在 mutation 开始
  --    之前就已经确定，因此顺序是可复核的：
  --      1) 按真实 grantor 撤销策略不允许的直接授权（含列级）；
  --      2) 收回一切可再授予标志；
  --      3) 以 canonical grantor 补齐缺失的固定允许项；
  --      4) 按 pg_default_acl 的**物理行**收敛默认权限。
  --
  --    为什么必须按真实 grantor：普通 REVOKE 只撤销「由执行者授予」的那一份，
  --    第三方 grantor 授予的授权会残留。因此先 SET LOCAL ROLE 成该 grantor 再
  --    撤销——这是**真正的收敛**，而不是等后置校验失败再整体回滚（回滚只让命令
  --    失败，权限仍然留在数据库里）。
  --
  --    条目本身允许、只是多带了可再授予标志时只收回该标志，不动 owner 自身的
  --    权限。Large Object 已在前置条件里 fail closed，不参与任何 mutation。
  --
  --    默认权限的判据是**物理行**：内建默认不需要任何语句，只有物理行才需要。
  --    绝不从 default_effective 反推语句——那会把「本来就该有的内建默认」当成
  --    需要显式授予的项。
  FOR row_record IN
    WITH
${shared}
    SELECT action.action_kind, action.run_as, action.target_sql, action.colname,
           action.privilege, action.grantee_sql, action.verb,
           action.defaclrole, action.scope_kind, action.scope,
           action.ddl_keyword
      FROM (
        SELECT 1 AS ordinal,
               CASE WHEN v.colname IS NOT NULL THEN 'acl-revoke-column'
                    WHEN v.privilege_allowed THEN 'acl-revoke-option'
                    ELSE 'acl-revoke' END AS action_kind,
               v.grantor AS run_as, v.target_sql, v.colname, v.privilege,
               ${granteeSql("v.grantee")} AS grantee_sql,
               NULL::text AS verb, NULL::text AS defaclrole,
               NULL::text AS scope_kind, NULL::text AS scope,
               NULL::text AS ddl_keyword,
               v.objkey::text AS sort_key
          FROM acl_verdict v
         WHERE v.object_class <> 'largeobject'
           AND (NOT v.privilege_allowed OR v.grantable)
        UNION ALL
        SELECT 2, 'acl-grant', ${owner}, mo.target_sql, NULL, g.privilege,
               ${granteeSql("g.grantee")}, NULL, NULL, NULL, NULL, NULL,
               g.objkey::text
          FROM allowed_grants g
          JOIN managed_object mo ON mo.objkey = g.objkey
         WHERE g.state = state_key
           AND NOT EXISTS (SELECT 1 FROM acl_source s
                            WHERE s.objkey = g.objkey
                              AND s.grantee = g.grantee
                              AND s.privilege = g.privilege
                              AND s.grantor = ${owner}
                              AND NOT s.grantable)
        UNION ALL
        -- language 的必需授权（内建 owner 与 PUBLIC USAGE）缺失时以 language
        -- owner 的身份补回：grantor 必须是 owner，否则下一轮立刻又是漂移。
        SELECT 2, 'acl-grant', r.owner_name, r.target_sql, NULL, r.privilege,
               ${granteeSql("r.grantee")}, NULL, NULL, NULL, NULL, NULL,
               r.objkey::text
          FROM required_language_grants r
         WHERE NOT EXISTS (SELECT 1 FROM acl_source s
                            WHERE s.objkey = r.objkey
                              AND s.grantee = r.grantee
                              AND s.grantor = r.owner_name
                              AND s.privilege = r.privilege
                              AND NOT s.grantable)
        UNION ALL
        -- 非 canonical owner 的默认权限条目一律是漂移：逐条撤销。撤空之后剩下
        -- 的空物理行是**无效应状态**，予以容忍——不去动外部角色的默认权限，也
        -- 不把它的 owner 冻结进任何允许集合。
        SELECT 3, 'default', NULL, NULL, NULL, r.privilege,
               ${granteeSql("r.grantee")}, 'REVOKE', r.defaclrole,
               r.scope_kind, r.scope, t.ddl_keyword, r.defaclrole
          FROM default_raw r
          JOIN default_objtype t ON t.objtype = r.objtype
         WHERE r.defaclrole <> ${owner}
        UNION ALL
        -- canonical owner 的槽位按「当前 → 目标」逐条收敛。目标由 default_raw
        -- 与起算点共同决定，**不是**从 default_effective 反推出来的。
        SELECT 3, 'default', NULL, NULL, NULL, c.privilege,
               ${granteeSql("c.grantee")}, 'REVOKE', c.defaclrole,
               c.scope_kind, c.scope, t.ddl_keyword, c.defaclrole
          FROM default_current c
          JOIN default_objtype t ON t.objtype = c.objtype
         WHERE c.defaclrole = ${owner}
           AND NOT EXISTS (SELECT 1 FROM default_target d
                            WHERE d.objtype = c.objtype AND d.scope = c.scope
                              AND d.grantee = c.grantee
                              AND d.grantor = c.grantor
                              AND d.privilege = c.privilege
                              AND d.grantable = c.grantable)
        UNION ALL
        SELECT 4, 'default', NULL, NULL, NULL, d.privilege,
               ${granteeSql("d.grantee")}, 'GRANT', d.defaclrole,
               d.scope_kind, d.scope, t.ddl_keyword, d.defaclrole
          FROM default_target d
          JOIN default_objtype t ON t.objtype = d.objtype
         WHERE NOT EXISTS (SELECT 1 FROM default_current c
                            WHERE c.defaclrole = d.defaclrole
                              AND c.objtype = d.objtype AND c.scope = d.scope
                              AND c.grantee = d.grantee
                              AND c.grantor = d.grantor
                              AND c.privilege = d.privilege
                              AND c.grantable = d.grantable)
      ) AS action
     ORDER BY action.ordinal, action.sort_key COLLATE "C",
              action.grantee_sql COLLATE "C",
              COALESCE(action.run_as, '') COLLATE "C",
              COALESCE(action.scope, '') COLLATE "C",
              action.privilege COLLATE "C"
  LOOP
    IF row_record.run_as IS NOT NULL THEN
      EXECUTE format('SET LOCAL ROLE %I', row_record.run_as);
    END IF;
    IF row_record.action_kind = 'acl-revoke-column' THEN
      EXECUTE format('REVOKE %s (%I) ON %s FROM %s CASCADE',
                     row_record.privilege, row_record.colname,
                     row_record.target_sql, row_record.grantee_sql);
    ELSIF row_record.action_kind = 'acl-revoke-option' THEN
      EXECUTE format('REVOKE GRANT OPTION FOR %s ON %s FROM %s CASCADE',
                     row_record.privilege, row_record.target_sql,
                     row_record.grantee_sql);
    ELSIF row_record.action_kind = 'acl-revoke' THEN
      EXECUTE format('REVOKE %s ON %s FROM %s CASCADE',
                     row_record.privilege, row_record.target_sql,
                     row_record.grantee_sql);
    ELSIF row_record.action_kind = 'acl-grant' THEN
      EXECUTE format('GRANT %s ON %s TO %s', row_record.privilege,
                     row_record.target_sql, row_record.grantee_sql);
    ELSE
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s %s %s ON %s %s %s',
                     row_record.defaclrole,
                     CASE WHEN row_record.scope_kind = 'global' THEN ''
                          ELSE ' IN SCHEMA ' || quote_ident(row_record.scope)
                     END,
                     row_record.verb, row_record.privilege,
                     row_record.ddl_keyword,
                     CASE WHEN row_record.verb = 'GRANT' THEN 'TO' ELSE 'FROM'
                     END,
                     row_record.grantee_sql);
    END IF;
    IF row_record.run_as IS NOT NULL THEN
      RESET ROLE;
    END IF;
  END LOOP;
END
${convergeTag};
`;
};

/**
 * 只读断言。同一套共享事实 + 同一份可移植策略，只是不执行任何 mutation：
 * catalog ACL 的**完整元组**（object + grantee + grantor + privilege +
 * grantable）、`pg_default_acl` 的物理行与叠加出的**有效**默认权限，以及
 * `has_*_privilege` 的有效权限三者同时比对。
 */
export const renderAuthorizationVerifySql = (
  manifest: AuthorizationManifest = authorizationManifest,
): string => {
  validateAuthorizationManifest(manifest);
  const owner = policyLiteral(manifest.principals.owner);
  return `DO ${verifyTag}
${declarations}
  divergence_count integer;
  divergence text;
BEGIN
${sessionPreamble}
${stateResolution(manifest)}

  -- 1. 与收敛完全相同的致命前置条件，同样先于一切判断。
${renderAuthorizationPreflightStatement(manifest)}

  -- 2. 策略比对。三层同时看：完整元组的直接授权、default privilege 的物理行与
  --    有效叠加、has_*_privilege 的有效权限。
  WITH
${renderAuthorizationSharedCtes(manifest)},
  default_effective_actual (objtype, scope, grantee, privileges, grantable) AS (
    SELECT objtype, scope, grantee,
           array_agg(privilege ORDER BY privilege COLLATE "C"),
           bool_or(grantable)
      FROM default_effective
     WHERE defaclrole = ${owner}
     GROUP BY objtype, scope, grantee
  ),
  divergence_rows (rank, kind, entry) AS (
    -- 有效权限：项目主体逐条精确匹配；外部角色在受监管四类对象上必须为空。
    SELECT 1, 'effective'::text,
           'unexpected effective ' || jsonb_build_array(e.objkey, e.role_name)::text
             || ' [privs=' || array_to_string(e.privileges, ',') || ']'
      FROM effective_regulated e
      LEFT JOIN allowed_effective a
        ON a.state = state_key AND a.objkey = e.objkey
       AND a.role_name = e.role_name
     WHERE a.objkey IS NULL
    UNION ALL
    SELECT 1, 'effective',
           'missing effective ' || jsonb_build_array(a.objkey, a.role_name)::text
             || ' [expected privs=' || array_to_string(a.privileges, ',') || ']'
      FROM allowed_effective a
      LEFT JOIN effective_regulated e
        ON e.objkey = a.objkey AND e.role_name = a.role_name
     WHERE a.state = state_key AND e.objkey IS NULL
    UNION ALL
    SELECT 1, 'effective',
           'drifted effective ' || jsonb_build_array(a.objkey, a.role_name)::text
             || ' [expected privs=' || array_to_string(a.privileges, ',')
             || '] [found privs=' || array_to_string(e.privileges, ',') || ']'
      FROM allowed_effective a
      JOIN effective_regulated e
        ON e.objkey = a.objkey AND e.role_name = a.role_name
     WHERE a.state = state_key AND e.privileges IS DISTINCT FROM a.privileges
    UNION ALL
    -- language：PostgreSQL 的内建默认让每个探测主体恰好有 USAGE。多一点少一点
    -- 都说明有人显式动过 lanacl。
    SELECT 1, 'effective',
           'unexpected language privileges '
             || jsonb_build_array(e.objkey, e.role_name)::text
             || ' [privs=' || array_to_string(e.privileges, ',') || ']'
      FROM effective_actual e
     WHERE e.object_class = 'language'
       AND e.privileges IS DISTINCT FROM ARRAY['USAGE']
    UNION ALL
    -- 类型、20 个 Large Object 入口点与 Large Object 本身：除对象 owner 之外
    -- 任何主体都不得有效到达。
    SELECT 1, 'effective',
           'unexpected effective ' || jsonb_build_array(e.objkey, e.role_name)::text
             || ' [privs=' || array_to_string(e.privileges, ',') || ']'
      FROM effective_actual e
     WHERE e.object_class IN ('type', 'denied-routine', 'largeobject')
       AND NOT (e.object_class = 'type' AND e.role_name = ${owner})
    UNION ALL
    -- owner 必须**保留** managed 非数组类型的 USAGE：收敛只收回别人的权限。
    SELECT 1, 'effective',
           'owner lost USAGE on type ' || tc.objkey::text
      FROM type_class tc
     WHERE tc.class_name <> 'array'
       AND NOT EXISTS (SELECT 1 FROM effective_actual e
                        WHERE e.objkey = tc.objkey
                          AND e.object_class = 'type'
                          AND e.role_name = ${owner}
                          AND e.privileges = ARRAY['USAGE'])
    UNION ALL
    -- 列级有效权限必须是同表表级有效权限的子集：列级授权一律不允许，出现即说明
    -- 收敛没有覆盖到列。
    SELECT 1, 'effective',
           'column privileges exceed table privileges '
             || jsonb_build_array(c.objkey, c.role_name)::text
             || ' [privs=' || array_to_string(c.privileges, ',') || ']'
      FROM effective_actual c
      LEFT JOIN effective_actual r
        ON r.object_class = 'relation' AND r.role_name = c.role_name
       AND r.objkey = jsonb_build_array('relation', c.objkey->1, c.objkey->2)
     WHERE c.object_class = 'column'
       AND NOT (c.privileges <@ COALESCE(r.privileges, ARRAY[]::text[]))
    UNION ALL
    -- 直接授权的**完整元组**：object + grantee + grantor + privilege +
    -- grantable。权限集合看起来合规但 grantor 错误、重复授权或可再授予，
    -- 都在这里现形。
    SELECT 3, 'grant',
           'unexpected grant '
             || jsonb_build_array(v.objkey, v.grantee, v.grantor,
                                  v.privilege)::text
             || ' [grantable=' || CASE WHEN v.grantable THEN 't' ELSE 'f' END
             || ']'
      FROM acl_verdict v
     WHERE NOT v.privilege_allowed
    UNION ALL
    SELECT 3, 'grant',
           'grant option on '
             || jsonb_build_array(v.objkey, v.grantee, v.grantor,
                                  v.privilege)::text
      FROM acl_verdict v
     WHERE v.privilege_allowed AND v.grantable
    UNION ALL
    SELECT 3, 'grant',
           'missing grant '
             || jsonb_build_array(g.objkey, g.grantee, ${owner},
                                  g.privilege)::text
      FROM allowed_grants g
     WHERE g.state = state_key
       AND NOT EXISTS (SELECT 1 FROM acl_source s
                        WHERE s.objkey = g.objkey
                          AND s.grantee = g.grantee
                          AND s.privilege = g.privilege
                          AND s.grantor = ${owner}
                          AND NOT s.grantable)
    UNION ALL
    SELECT 3, 'grant',
           'missing language grant '
             || jsonb_build_array(r.objkey, r.grantee, r.owner_name,
                                  r.privilege)::text
      FROM required_language_grants r
     WHERE NOT EXISTS (SELECT 1 FROM acl_source s
                        WHERE s.objkey = r.objkey
                          AND s.grantee = r.grantee
                          AND s.grantor = r.owner_name
                          AND s.privilege = r.privilege
                          AND NOT s.grantable)
    UNION ALL
    -- pg_default_acl 的**物理行**：它决定实际执行哪条默认权限语句。
    SELECT 4, 'default',
           'unexpected default privilege '
             || jsonb_build_array(v.defaclrole, v.objtype, v.scope, v.grantee,
                                  v.grantor, v.privilege)::text
             || ' [grantable=' || CASE WHEN v.grantable THEN 't' ELSE 'f' END
             || ']'
      FROM default_verdict v
     WHERE NOT v.privilege_allowed
    UNION ALL
    SELECT 4, 'default',
           'grant option on default privilege '
             || jsonb_build_array(v.defaclrole, v.objtype, v.scope, v.grantee,
                                  v.grantor, v.privilege)::text
      FROM default_verdict v
     WHERE v.privilege_allowed AND v.grantable
    UNION ALL
    SELECT 4, 'default',
           'missing default privilege '
             || jsonb_build_array(${owner}, ad.objtype, ad.scope, ad.grantee,
                                  ${owner}, ad.privilege)::text
      FROM allowed_default ad
     WHERE ad.state = state_key
       AND NOT EXISTS (SELECT 1 FROM default_raw r
                        WHERE r.defaclrole = ${owner}
                          AND r.grantor = ${owner}
                          AND r.objtype = ad.objtype
                          AND r.scope = ad.scope
                          AND r.grantee = ad.grantee
                          AND r.privilege = ad.privilege
                          AND NOT r.grantable)
    UNION ALL
    -- 叠加出的**有效**默认权限：只在这里做最终语义验证，绝不据此反推语句。
    SELECT 4, 'default-effective',
           'unexpected effective default privilege '
             || jsonb_build_array(da.objtype, da.scope, da.grantee)::text
             || ' [privs=' || array_to_string(da.privileges, ',')
             || ' grantable=' || CASE WHEN da.grantable THEN 't' ELSE 'f' END
             || ']'
      FROM default_effective_actual da
      LEFT JOIN allowed_default_effective ae
        ON ae.state = state_key AND ae.objtype = da.objtype
       AND ae.scope = da.scope AND ae.grantee = da.grantee
     WHERE ae.objtype IS NULL
    UNION ALL
    SELECT 4, 'default-effective',
           'missing effective default privilege '
             || jsonb_build_array(ae.objtype, ae.scope, ae.grantee)::text
             || ' [expected privs=' || array_to_string(ae.privileges, ',') || ']'
      FROM allowed_default_effective ae
      LEFT JOIN default_effective_actual da
        ON da.objtype = ae.objtype AND da.scope = ae.scope
       AND da.grantee = ae.grantee
     WHERE ae.state = state_key AND da.objtype IS NULL
    UNION ALL
    SELECT 4, 'default-effective',
           'drifted effective default privilege '
             || jsonb_build_array(ae.objtype, ae.scope, ae.grantee)::text
             || ' [expected privs=' || array_to_string(ae.privileges, ',')
             || '] [found privs=' || array_to_string(da.privileges, ',')
             || ' grantable=' || CASE WHEN da.grantable THEN 't' ELSE 'f' END
             || ']'
      FROM allowed_default_effective ae
      JOIN default_effective_actual da
        ON da.objtype = ae.objtype AND da.scope = ae.scope
       AND da.grantee = ae.grantee
     WHERE ae.state = state_key
       AND (da.privileges IS DISTINCT FROM ae.privileges OR da.grantable)
    UNION ALL
    -- 数组类型只向元素类型委托：PostgreSQL 直接拒绝对它们授权与改属，因此它们
    -- 既不能成为收敛目标，也不该有任何直接 ACL 条目。
    SELECT 5, 'type',
           'array type ' || tc.objkey::text
             || ' must never be an authorization target'
      FROM type_class tc
     WHERE tc.class_name = 'array'
       AND (EXISTS (SELECT 1 FROM managed_object mo WHERE mo.objkey = tc.objkey)
            OR EXISTS (SELECT 1 FROM acl_source a WHERE a.objkey = tc.objkey))
  )
  SELECT (SELECT count(*) FROM divergence_rows)::integer,
         (SELECT pg_catalog.string_agg(pg_catalog.left(entry, 400), '; '
                                       ORDER BY rank, entry COLLATE "C")
            FROM (SELECT rank, entry FROM divergence_rows
                   ORDER BY rank, entry COLLATE "C" LIMIT 8) AS capped)
    INTO divergence_count, divergence;

  IF divergence_count > 0 THEN
    RAISE EXCEPTION
      'authorization manifest does not match state % '
      '(% divergence(s), manifest version ${String(manifest.version)}): %',
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
): readonly string[] => {
  validateAuthorizationManifest(manifest);
  return [
  `-- 阶段 09A / M2A：${title}`,
  "--",
  "-- GENERATED FILE — DO NOT EDIT.",
  "-- 事实源： services/api/src/database/authorization-manifest.ts",
  "-- 共享观察： services/api/src/database/authorization-projection-sql.ts",
  "-- 可移植策略： services/api/src/database/authorization-policy-sql.ts",
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
};

export const renderAuthorizationConvergeAdapter = (
  manifest: AuthorizationManifest = authorizationManifest,
): string =>
  [
    ...adapterHeader(
      manifest,
      "授权收敛（按真实 grantor 撤销一切策略不允许的授权，再只重建允许项）。",
      "本文件会修改 ACL：这是它的职责。它不改 ownership，也不建任何对象；" +
        "全部致命前置条件先于任何 mutation 执行。",
    ),
    renderAuthorizationConvergeSql(manifest),
  ].join("\n");

export const renderAuthorizationVerifyAdapter = (
  manifest: AuthorizationManifest = authorizationManifest,
): string =>
  [
    ...adapterHeader(
      manifest,
      "授权断言（完整元组的 catalog ACL + default privilege 物理行与有效叠加 + " +
        "has_*_privilege 有效权限）。",
      "本文件是纯只读 SQL：不匹配时 RAISE EXCEPTION，不做任何变更。",
    ),
    renderAuthorizationVerifySql(manifest),
  ].join("\n");
