// 阶段 09A / M4：生命周期与备份/恢复演练共用的库模块（**非**入口，无 shebang）。
//
// 两个演练入口（run-local-test-lifecycle.mjs、run-local-test-restore-drill.mjs）
// 与两个运维入口（backup-local-test.mjs、restore-local-test.mjs）共享这里的
// 基础设施。M4 **不改动**已 Accepted 的 M3B smoke/probe；本模块复用的是它们
// 沉淀下来的库（m3b-docker / m3b-subprocess / m3b-safe-output / secrets 契约）
// 与链式步骤**模式**，不是复制一份形状相同的抄件能替代的那几条硬保证：
//
//   - 所有 Docker 证据读取 fail closed（exact singleton inspect + inspectStrict）；
//   - 分阶段 scoped cleanup + 独立 residue 复查（cleanupRun / verifyNoResidue）；
//   - 输出边界：本仓自己的证据行按取值打码，外来文本按取值 + 形状打码；
//   - 子进程自成进程组、有超时，SIGINT/SIGTERM 全程可被处理。
//
// 唯一的命名妥协：per-run image tag 仍在 `meal-agent-api:m3b-<run id>` 命名
// 空间里（`m3b-docker.mjs` 的 cleanup 只肯删这一形状的 tag）。M4 的 run id 带
// `m4-` 前缀，因此不会与任何 M3B 轮次碰撞，而 cleanup / residue 机器完全复用，
// 不必修改已被多轮审计钉住的共享库。
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateAndPreflight } from './generate-local-test-secrets.mjs'
import { buildNeedles } from './local-test-containment.mjs'
import { checkSecretBundle, repositoryRoot } from './local-test-secrets-contract.mjs'
import {
  buildApiImage,
  cleanupRun,
  danglingVolumes,
  dockerStrict,
  inodeIdentityOf,
  inspectJsonStrict,
  inspectStrict,
  isAbsenceMessage,
  listByProject,
  overridePathFor,
  runImageTagFor,
  verifyNoResidue,
  writeImageOverride
} from './m3b-docker.mjs'
import { createSecretScrubber } from './m3b-safe-output.mjs'
import { installSignalHandlers, runCommand, terminationSignal } from './m3b-subprocess.mjs'

export const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
export const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')
export const migrationsDirectory = resolve(repositoryRoot, 'services/api/migrations')

const zeroDockerTimestamp = '0001-01-01T00:00:00Z'

export const parseContainerRuntimeState = (value) => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['running', 'exited'].includes(value.Status) ||
    typeof value.Running !== 'boolean' ||
    !Number.isSafeInteger(value.ExitCode) ||
    value.ExitCode < 0 ||
    typeof value.StartedAt !== 'string' ||
    value.StartedAt === '' ||
    typeof value.FinishedAt !== 'string' ||
    value.FinishedAt === ''
  ) {
    throw new Error('container lifecycle evidence was invalid')
  }
  return Object.freeze({
    status: value.Status,
    running: value.Running,
    exitCode: value.ExitCode,
    startedAt: value.StartedAt,
    finishedAt: value.FinishedAt
  })
}

export const assertGracefulStopTransition = (before, after) => {
  const identityKeys = ['id', 'name', 'image', 'project', 'service']
  if (
    before === null ||
    typeof before !== 'object' ||
    after === null ||
    typeof after !== 'object' ||
    identityKeys.some(
      (key) => typeof before[key] !== 'string' || before[key] === '' || before[key] !== after[key]
    )
  ) {
    throw new Error('container did not prove one stable graceful-stop identity')
  }
  const initial = parseContainerRuntimeState(before.state)
  const final = parseContainerRuntimeState(after.state)
  if (
    initial.status !== 'running' ||
    initial.running !== true ||
    final.status !== 'exited' ||
    final.running !== false ||
    final.exitCode !== 0 ||
    final.startedAt !== initial.startedAt ||
    final.finishedAt === zeroDockerTimestamp ||
    final.finishedAt === initial.finishedAt
  ) {
    throw new Error('container did not prove a running-to-exited graceful stop transition')
  }
  return true
}

export const readContainerRuntimeState = async (name, environment) => {
  const container = await inspectJsonStrict(name, '{{json .}}', { env: environment })
  const labels = container?.Config?.Labels
  const evidence = {
    id: container?.Id,
    name: container?.Name,
    image: container?.Image,
    project: labels?.['com.docker.compose.project'],
    service: labels?.['com.docker.compose.service'],
    state: container?.State
  }
  if (
    typeof evidence.id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(evidence.id) ||
    evidence.name !== `/${name}` ||
    typeof evidence.image !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(evidence.image) ||
    typeof evidence.project !== 'string' ||
    evidence.project === '' ||
    typeof evidence.service !== 'string' ||
    evidence.service === '' ||
    evidence.state === null ||
    typeof evidence.state !== 'object' ||
    Array.isArray(evidence.state)
  ) {
    throw new Error('container graceful-stop identity evidence was malformed')
  }
  return evidence
}

/** 默认（长驻）local-test 部署的 project name：compose 文件里的 `name:`。 */
export const defaultProjectName = 'meal-agent-local-test'

/**
 * 运维入口与 signal handler 共享的 scoped artifact 清理登记表。
 * task 只能返回固定、无外部内容的 residue 标签；每次快照全部执行，单项异常不
 * 阻断后续项。这样 Docker one-off 与宿主/transfer artifact 属于同一个信号结算。
 */
export const createScopedArtifactCleanup = () => {
  const tasks = new Set()
  return Object.freeze({
    register(task) {
      tasks.add(task)
      return () => tasks.delete(task)
    },
    async run() {
      const residue = []
      for (const task of [...tasks]) {
        try {
          const result = await task()
          if (Array.isArray(result)) residue.push(...result)
          else residue.push('scoped artifact cleanup returned an invalid result')
        } catch {
          residue.push('scoped artifact cleanup failed')
        }
      }
      return residue
    }
  })
}

/**
 * cleanup 只接受 M4 自己的两类演练 project，范围外一律拒绝。M3B 的
 * smoke/neg/probe 与默认部署都刻意**不在**范围内。
 */
export const m4ProjectPattern =
  /^meal-agent-m4-(?:lifecycle|restore-[ab])-[a-z0-9][a-z0-9-]*$/

/** 演练的临时 Secret 目录只允许出现在系统 tmpdir 下的这一前缀里。 */
export const temporarySecretsPrefix = 'meal-agent-m4-secrets-'

/** 十一个服务的全新安装顺序（先物化 Secret，再启动数据库）。 */
export const chainOrder = [
  'secret-materializer',
  'postgres',
  'bootstrap-cluster',
  'bootstrap-logins',
  'bootstrap-createdb',
  'bootstrap-schema',
  'bootstrap-handoff',
  'bootstrap-acl',
  'migrate',
  'bootstrap-grants',
  'api'
]

const migrationRole = 'meal_agent_migrator'
const targetDatabase = 'meal_agent'

// ---------------------------------------------------------------------------
// 合成 sentinel 数据（两个家庭；固定 UUID 与固定时间戳，round-trip 可逐字比较）
// ---------------------------------------------------------------------------
const at = '2026-08-11T00:00:00Z'
export const sentinel = {
  users: [
    { id: '00000000-0000-4000-8000-0000000000a1', name: 'sentinel-user-one' },
    { id: '00000000-0000-4000-8000-0000000000a2', name: 'sentinel-user-two' }
  ],
  households: [
    { id: '00000000-0000-4000-8000-0000000000b1', name: 'sentinel-household-one' },
    { id: '00000000-0000-4000-8000-0000000000b2', name: 'sentinel-household-two' }
  ],
  memberships: [
    { id: '00000000-0000-4000-8000-0000000000c1' },
    { id: '00000000-0000-4000-8000-0000000000c2' }
  ],
  lots: [
    { id: '00000000-0000-4000-8000-0000000000d1', name: 'sentinel-lot-one' },
    { id: '00000000-0000-4000-8000-0000000000d2', name: 'sentinel-lot-two' }
  ],
  events: [
    { id: '00000000-0000-4000-8000-0000000000e1', key: 'sentinel-key-one' },
    { id: '00000000-0000-4000-8000-0000000000e2', key: 'sentinel-key-two' }
  ]
}

/**
 * sentinel 插入语句（以 cluster admin 执行；superuser 天然越过 FORCE RLS，
 * 这一步是演练前置，不是授权模型的证据——授权证据在下面的探针里）。
 */
export const sentinelInsertStatements = () => {
  const [u1, u2] = sentinel.users
  const [h1, h2] = sentinel.households
  const [m1, m2] = sentinel.memberships
  const [d1, d2] = sentinel.lots
  const [e1, e2] = sentinel.events
  return [
    `INSERT INTO public.users (id, status, display_name, locale, created_at, updated_at, version) VALUES
       ('${u1.id}', 'active', '${u1.name}', 'zh-CN', '${at}', '${at}', 0),
       ('${u2.id}', 'active', '${u2.name}', 'zh-CN', '${at}', '${at}', 0)`,
    `INSERT INTO public.households (id, name, timezone, locale, status, created_by_user_id, created_at, updated_at, version) VALUES
       ('${h1.id}', '${h1.name}', 'Asia/Shanghai', 'zh-CN', 'active', '${u1.id}', '${at}', '${at}', 0),
       ('${h2.id}', '${h2.name}', 'Asia/Shanghai', 'zh-CN', 'active', '${u2.id}', '${at}', '${at}', 0)`,
    `INSERT INTO public.memberships (id, household_id, user_id, role, capabilities, status, joined_at, updated_at, version) VALUES
       ('${m1.id}', '${h1.id}', '${u1.id}', 'owner', '[]'::jsonb, 'active', '${at}', '${at}', 0),
       ('${m2.id}', '${h2.id}', '${u2.id}', 'owner', '[]'::jsonb, 'active', '${at}', '${at}', 0)`,
    `INSERT INTO public.inventory_lots (id, household_id, food_concept_id, display_name, state, storage_location,
       current_quantity_kind, current_quantity_amount, current_quantity_unit, dates,
       safety_status, safety_reason_codes, safety_policy_version, safety_evaluated_at,
       origin, created_by_user_id, created_at, updated_at, version) VALUES
       ('${d1.id}', '${h1.id}', NULL, '${d1.name}', 'active', 'pantry', 'exact', 2.5, 'kg', '[]'::jsonb,
        'eligible', '[]'::jsonb, 'sentinel-policy-1', '${at}', 'manual', '${u1.id}', '${at}', '${at}', 1),
       ('${d2.id}', '${h2.id}', NULL, '${d2.name}', 'active', 'refrigerated', 'exact', 1.25, 'kg', '[]'::jsonb,
        'eligible', '[]'::jsonb, 'sentinel-policy-1', '${at}', 'manual', '${u2.id}', '${at}', '${at}', 1)`,
    `INSERT INTO public.inventory_events (id, household_id, inventory_lot_id, type, actor_user_id, source,
       occurred_at, recorded_at, idempotency_key, normalized_route,
       expected_lot_version, resulting_lot_version, note) VALUES
       ('${e1.id}', '${h1.id}', '${d1.id}', 'sentinel-recorded', '${u1.id}', 'm4-drill',
        '${at}', '${at}', '${e1.key}', 'sentinel/inventory', 0, 1, 'sentinel event one'),
       ('${e2.id}', '${h2.id}', '${d2.id}', 'sentinel-recorded', '${u2.id}', 'm4-drill',
        '${at}', '${at}', '${e2.key}', 'sentinel/inventory', 0, 1, 'sentinel event two')`
  ]
}

/** sentinel 五张表的逐行 JSON 快照语句（to_jsonb 键序确定，可逐字比较）。 */
export const sentinelSnapshotStatements = () => [
  `SELECT 'users:' || to_jsonb(t)::text FROM public.users t ORDER BY t.id`,
  `SELECT 'households:' || to_jsonb(t)::text FROM public.households t ORDER BY t.id`,
  `SELECT 'memberships:' || to_jsonb(t)::text FROM public.memberships t ORDER BY t.id`,
  `SELECT 'inventory_lots:' || to_jsonb(t)::text FROM public.inventory_lots t ORDER BY t.id`,
  `SELECT 'inventory_events:' || to_jsonb(t)::text FROM public.inventory_events t ORDER BY t.id`
]

// ---------------------------------------------------------------------------
// 授权面快照：owner / GRANT / RLS / policy / 角色属性 / membership / ledger
// ---------------------------------------------------------------------------
const managedSchemas = `('public', 'drizzle', 'meal_agent_private')`
// 排序的两个陷阱都在首轮演练里实测过：`ORDER BY 1 COLLATE "C"` 的 `1` 被解析
// 成**带 collation 的整数字面量**（`collations are not supported by type
// integer`），而 `ORDER BY line COLLATE "C"` 的别名一旦进入表达式就回到 FROM
// 作用域解析（`column "line" does not exist`）。唯一稳妥的形态是子查询包装：
// 别名在外层是真实列，COLLATE 才能作用于它。
const sortedLines = (inner) =>
  `SELECT line FROM (${inner}) AS snapshot_rows ORDER BY line COLLATE "C"`
const aclLine = (prefix, ident, aclExpression) =>
  sortedLines(`SELECT '${prefix}:' || ${ident} || ':' ||
     pg_get_userbyid(a.grantor) || '=>' ||
     CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END ||
     ':' || a.privilege_type || ':grantable=' || a.is_grantable AS line
   FROM ${aclExpression}`)

/**
 * 「与备份前一致」的判据语句。全部行以固定前缀开头、C collation 排序；NULL ACL
 * 按 R8B projector 的口径展开为隐式内建默认（`acldefault`），因此比较的是**授权
 * 语义**，不是 catalog 的物理 NULL 与否。
 */
export const authorizationSnapshotStatements = () => [
  `SELECT 'db:' || d.datname || ':owner=' || pg_get_userbyid(d.datdba)
     FROM pg_database d WHERE d.datname = current_database()`,
  aclLine(
    'db-acl',
    'd.datname',
    `pg_database d, LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
     WHERE d.datname = current_database()`
  ),
  sortedLines(`SELECT 'schema:' || n.nspname || ':owner=' || pg_get_userbyid(n.nspowner) AS line
     FROM pg_namespace n WHERE n.nspname IN ${managedSchemas}`),
  aclLine(
    'schema-acl',
    'n.nspname',
    `pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
     WHERE n.nspname IN ${managedSchemas}`
  ),
  sortedLines(`SELECT 'rel:' || n.nspname || '.' || c.relname || ':owner=' || pg_get_userbyid(c.relowner) ||
       ':rls=' || c.relrowsecurity || ':force=' || c.relforcerowsecurity AS line
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ${managedSchemas} AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`),
  aclLine(
    'rel-acl',
    `n.nspname || '.' || c.relname`,
    `pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
     LATERAL aclexplode(coalesce(c.relacl,
       acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) a
     WHERE n.nspname IN ${managedSchemas} AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`
  ),
  aclLine(
    'col-acl',
    `n.nspname || '.' || c.relname || '.' || att.attname`,
    `pg_attribute att
       JOIN pg_class c ON c.oid = att.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace,
     LATERAL aclexplode(att.attacl) a
     WHERE att.attacl IS NOT NULL AND n.nspname IN ${managedSchemas}`
  ),
  sortedLines(`SELECT 'routine:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' ||
       ':owner=' || pg_get_userbyid(p.proowner) || ':secdef=' || p.prosecdef ||
       ':config=' || coalesce(p.proconfig::text, '-') AS line
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ${managedSchemas}`),
  aclLine(
    'routine-acl',
    `n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'`,
    `pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
     LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE n.nspname IN ${managedSchemas}`
  ),
  aclLine(
    'defacl',
    `pg_get_userbyid(d.defaclrole) || ':' ||
     CASE WHEN d.defaclnamespace = 0 THEN 'global'
          ELSE (SELECT nspname FROM pg_namespace WHERE oid = d.defaclnamespace) END ||
     ':' || d.defaclobjtype::text`,
    `pg_default_acl d, LATERAL aclexplode(d.defaclacl) a`
  ),
  sortedLines(`SELECT 'policy:' || p.schemaname || '.' || p.tablename || ':' || p.policyname ||
       ':' || coalesce(p.cmd, '-') || ':permissive=' || p.permissive ||
       ':roles=' || array_to_string(p.roles, ',') ||
       ':using=' || coalesce(p.qual, '-') || ':check=' || coalesce(p.with_check, '-') AS line
     FROM pg_policies p WHERE p.schemaname IN ${managedSchemas}`),
  sortedLines(`SELECT 'role:' || r.rolname || '=' || r.rolsuper || ':' || r.rolbypassrls || ':' ||
       r.rolcreatedb || ':' || r.rolcreaterole || ':' || r.rolinherit || ':' ||
       r.rolcanlogin || ':connlimit=' || r.rolconnlimit AS line
     FROM pg_roles r WHERE r.rolname LIKE 'meal\\_agent%'`),
  sortedLines(`SELECT 'member:' || pg_get_userbyid(m.roleid) || '<-' || pg_get_userbyid(m.member) ||
       ':by=' || pg_get_userbyid(m.grantor) || ':admin=' || m.admin_option ||
       ':inherit=' || m.inherit_option || ':set=' || m.set_option AS line
     FROM pg_auth_members m
     WHERE pg_get_userbyid(m.roleid) LIKE 'meal\\_agent%'
        OR pg_get_userbyid(m.member) LIKE 'meal\\_agent%'`),
  sortedLines(`SELECT 'ledger:' || name || ':' || hash AS line
     FROM drizzle.__meal_agent_migrations`)
]

/** 磁盘上的 migration ledger 期望（name:sha256，与 smoke 同口径）。 */
export const expectedLedgerFromDisk = () =>
  readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(resolve(migrationsDirectory, name), 'utf8')
      return `${name}:${createHash('sha256').update(sql).digest('hex')}`
    })

// ---------------------------------------------------------------------------
// 探针脚本（在一次性容器内以 bash 执行；口令只经 pgpass 流转，不进 argv）
// ---------------------------------------------------------------------------
const pgpassPreamble = (loginRole, passwordSecret) => [
  'set -uo pipefail',
  'umask 077',
  `printf 'postgres:5432:${targetDatabase}:${loginRole}:%s\\n' "$(< /run/secrets/${passwordSecret}/value)" > /tmp/probe.pgpass`,
  'export PGPASSFILE=/tmp/probe.pgpass',
  `RUNPSQL="psql --no-psqlrc --no-password -tA -h postgres -p 5432 -U ${loginRole} -d ${targetDatabase}"`
]

/**
 * 授权读取 + runtime 最小权限探针（runtime login）。期望 needle 见
 * `authorizedReadExpectations`。
 */
export const authorizedReadScript = () => {
  const [u1] = sentinel.users
  const [h1, h2] = sentinel.households
  const context = (household) =>
    `SET ROLE meal_agent_app; SET app.user_id = '${u1.id}'; SET app.household_id = '${household}';`
  // 多语句 `-c` 会把前面每个 SET 的命令标签一并打出来（实测 -tA 不抑制标签），
  // 因此计数只取**最后一行**；出错时最后一行是 ERROR 文本，同样保证 needle
  // 失配而不是伪匹配。
  return [
    ...pgpassPreamble('meal_agent_runtime_login', 'meal_agent_runtime_password'),
    `echo "whoami=$($RUNPSQL -c "SELECT current_user" 2>&1)"`,
    `echo "h1-households=$($RUNPSQL -c "${context(h1.id)} SELECT count(*) FROM public.households" 2>&1 | tail -n 1)"`,
    `echo "h1-lots=$($RUNPSQL -c "${context(h1.id)} SELECT count(*) FROM public.inventory_lots" 2>&1 | tail -n 1)"`,
    `echo "h1-events=$($RUNPSQL -c "${context(h1.id)} SELECT count(*) FROM public.inventory_events" 2>&1 | tail -n 1)"`,
    // u1 换到 h2 的上下文：不是成员，一行都不该看见。
    `echo "cross-households=$($RUNPSQL -c "${context(h2.id)} SELECT count(*) FROM public.households" 2>&1 | tail -n 1)"`,
    // 无上下文：app 角色 GUC 为空时策略不放行任何行。
    `echo "nocontext-lots=$($RUNPSQL -c "SET ROLE meal_agent_app; SELECT count(*) FROM public.inventory_lots" 2>&1 | tail -n 1)"`,
    `$RUNPSQL -c "CREATE TABLE public.m4_probe(x int)" > /dev/null 2>&1; echo "create-table-exit=$?"`,
    `$RUNPSQL -c "SET ROLE ${migrationRole}" > /dev/null 2>&1; echo "set-role-migrator-exit=$?"`,
    'rm -f /tmp/probe.pgpass'
  ].join('\n')
}

export const authorizedReadExpectations = [
  ['whoami=meal_agent_runtime_login', 'runtime login connects as itself'],
  ['h1-households=1', 'the member sees exactly its own household'],
  ['h1-lots=1', 'the member sees exactly its own inventory lot'],
  ['h1-events=1', 'the member sees exactly its own inventory event'],
  ['cross-households=0', 'a non-member context sees zero rows of the other household'],
  ['nocontext-lots=0', 'an app session without GUC context sees zero rows'],
  ['create-table-exit=1', 'the runtime login cannot run DDL'],
  ['set-role-migrator-exit=1', 'the runtime login cannot enter the migrator role']
]

/**
 * 备份角色探针（backup login）：BYPASSRLS 全量可读、不可写、不可 DDL；以及
 * 「错误角色去 dump 会**响亮失败**而不是被 FORCE RLS 静默截断」的反例。
 */
export const backupRoleScript = () => [
  ...pgpassPreamble('meal_agent_backup_login', 'meal_agent_backup_password'),
  `echo "backup-households=$($RUNPSQL -c "SET ROLE meal_agent_backup; SELECT count(*) FROM public.households" 2>&1 | tail -n 1)"`,
  `echo "backup-users=$($RUNPSQL -c "SET ROLE meal_agent_backup; SELECT count(*) FROM public.users" 2>&1 | tail -n 1)"`,
  `echo "backup-lots=$($RUNPSQL -c "SET ROLE meal_agent_backup; SELECT count(*) FROM public.inventory_lots" 2>&1 | tail -n 1)"`,
  `echo "backup-events=$($RUNPSQL -c "SET ROLE meal_agent_backup; SELECT count(*) FROM public.inventory_events" 2>&1 | tail -n 1)"`,
  `$RUNPSQL -c "SET ROLE meal_agent_backup; INSERT INTO public.users (id, status, locale, created_at, updated_at, version) VALUES ('00000000-0000-4000-8000-00000000dead', 'active', 'zh-CN', now(), now(), 0)" > /dev/null 2>&1; echo "backup-insert-exit=$?"`,
  `$RUNPSQL -c "SET ROLE meal_agent_backup; CREATE TABLE public.m4_backup_probe(x int)" > /dev/null 2>&1; echo "backup-ddl-exit=$?"`,
  'rm -f /tmp/probe.pgpass'
].join('\n')

export const backupRoleExpectations = [
  ['backup-households=2', 'the backup role sees both synthetic households'],
  ['backup-users=2', 'the backup role sees both synthetic users'],
  ['backup-lots=2', 'the backup role sees both inventory lots'],
  ['backup-events=2', 'the backup role sees both inventory events'],
  ['backup-insert-exit=1', 'the backup role cannot write business tables'],
  ['backup-ddl-exit=1', 'the backup role cannot run DDL']
]

/**
 * 「app 角色的 pg_dump 响亮失败」反例：pg_dump 默认 `row_security = off`，
 * 无 BYPASSRLS 的角色会得到服务器的 row-level security 拒绝——失败，而不是
 * 一份被静默截断的 dump。这正是「完整导出不受 FORCE RLS 截断」主张的反面
 * 证据：截断形态在这条路径上根本走不到文件落盘。
 */
export const appRoleDumpRefusalScript = () => [
  ...pgpassPreamble('meal_agent_runtime_login', 'meal_agent_runtime_password'),
  // 注意 pg_dump 在撞上 RLS 错误之前就已经创建了输出文件（实测 exit=1 时
  // /tmp/app-dump.dump 存在），因此「文件不存在」不能当判据；载荷证据是
  // 非零退出 + 明确的 row-level security 错误——失败是响亮的，不是一份
  // 被静默截断、被当作完好备份的文件。
  'pg_dump --no-password --format=custom --role=meal_agent_app' +
    ` --host=postgres --port=5432 --username=meal_agent_runtime_login --dbname=${targetDatabase}` +
    ' --file=/tmp/app-dump.dump 2> /tmp/app-dump.err; echo "app-dump-exit=$?"',
  'grep -qi "row-level security" /tmp/app-dump.err && echo "app-dump-refusal=row-level-security"',
  'rm -f /tmp/app-dump.dump /tmp/app-dump.err /tmp/probe.pgpass'
].join('\n')

export const appRoleDumpRefusalExpectations = [
  ['app-dump-exit=1', 'pg_dump under the app role fails instead of truncating'],
  ['app-dump-refusal=row-level-security', 'the refusal is the row-level security error, not something else']
]

// ---------------------------------------------------------------------------
// 运行上下文
// ---------------------------------------------------------------------------
const portIsFree = (host, port) =>
  new Promise((resolvePort) => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolvePort(true))
    })
  })

export const pickFreePort = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = 20_000 + (randomBytes(2).readUInt16BE(0) % 40_000)
    if ((await portIsFree('127.0.0.1', candidate)) && (await portIsFree('::1', candidate))) {
      return candidate
    }
  }
  throw new Error('could not find a free host port on both 127.0.0.1 and ::1')
}

/**
 * 一次性 `compose run` 的零残留封装。
 *
 * PostgreSQL 官方镜像声明 `VOLUME /var/lib/postgresql`，因此**每个**未在该
 * 路径挂载任何东西的一次性容器都会得到一个匿名卷；`compose run --rm` 只删
 * 容器、**不**删匿名卷（首轮演练实测：残留的匿名悬挂卷正好等于一次性查询的
 * 次数）。这里改为 `--name` + 显式 `docker rm -f -v`：容器与它的匿名卷一起
 * 消失，而且 `rm -f` 对超时后仍在跑的容器同样有效。
 */
const activeOneOffContainers = new Map()
const oneOffOwnershipLabel = 'com.meal-agent.m4.oneoff-owner'

export const oneOffIsGone = (removed, name) =>
  removed.status === 0 ||
  (removed.status === 1 && isAbsenceMessage(removed.stderr, { kind: 'container', name }))

const inspectOneOff = async (run, entry, environment) => {
  const target = entry.id ?? entry.name
  let inspected
  try {
    inspected = await run(['docker', 'container', 'inspect', target], { env: environment })
  } catch {
    return { state: 'unreadable', id: null }
  }
  if (
    inspected.status === 1 &&
    isAbsenceMessage(inspected.stderr, { kind: 'container', name: target })
  ) {
    return { state: 'absent', id: null }
  }
  if (inspected.status !== 0 || typeof inspected.stdout !== 'string' || inspected.stdout === '') {
    return { state: 'unreadable', id: null }
  }
  let payload
  try {
    payload = JSON.parse(inspected.stdout)
  } catch {
    return { state: 'unreadable', id: null }
  }
  const container = Array.isArray(payload) && payload.length === 1 ? payload[0] : null
  const id = container?.Id
  const name = container?.Name
  const labels = container?.Config?.Labels
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(id) ||
    (entry.id === undefined && name !== `/${entry.name}`) ||
    (entry.id !== undefined && id !== entry.id) ||
    labels === null ||
    typeof labels !== 'object' ||
    Array.isArray(labels)
  ) {
    return { state: 'unreadable', id: null }
  }
  return labels[oneOffOwnershipLabel] === entry.token
    ? { state: 'owned', id, container }
    : { state: 'foreign', id: null }
}

const oneOffOutcomeIsBound = (inspected, result) => {
  const state = inspected.container?.State
  return (
    inspected.state === 'owned' &&
    state !== null &&
    typeof state === 'object' &&
    !Array.isArray(state) &&
    state.Status === 'exited' &&
    state.Running === false &&
    Number.isSafeInteger(state.ExitCode) &&
    state.ExitCode >= 0 &&
    state.ExitCode === result?.status &&
    typeof state.FinishedAt === 'string' &&
    state.FinishedAt !== '' &&
    state.FinishedAt !== '0001-01-01T00:00:00Z'
  )
}

const removeOwnedOneOff = async (run, entry, environment) => {
  const inspected = await inspectOneOff(run, entry, environment)
  if (inspected.state === 'absent') {
    activeOneOffContainers.delete(entry.name)
    return true
  }
  if (inspected.state !== 'owned') {
    // foreign / unreadable 均不能盲删；entry 保留给 residue 报告。
    return false
  }
  let removed
  try {
    removed = await run(['docker', 'rm', '-f', '-v', inspected.id], { env: environment })
  } catch {
    return false
  }
  if (!oneOffIsGone(removed, inspected.id)) {
    return false
  }
  const finalState = await inspectOneOff(run, entry, environment)
  if (finalState.state !== 'absent') {
    return false
  }
  activeOneOffContainers.delete(entry.name)
  return true
}

export const composeRunOneOff = async (
  { compose, run, environment = process.env, warn = null },
  runArgs,
  { timeoutMs = 120_000, stdin = null, beforeRemove = null } = {}
) => {
  const name = `m4-oneoff-${randomBytes(12).toString('hex')}`
  const entry = { name, token: randomBytes(16).toString('hex'), id: undefined }
  const baseline = await inspectOneOff(run, entry, environment)
  if (baseline.state !== 'absent') {
    throw new Error('one-off container name was not proven absent before create')
  }
  // 只有证明 name absent 后才登记；label 让信号清理能够区分本轮容器与并发抢占者。
  activeOneOffContainers.set(name, entry)
  let result
  let composeError = null
  try {
    result = await compose(
      [
        'run',
        '--no-TTY',
        '--name',
        name,
        '--label',
        `${oneOffOwnershipLabel}=${entry.token}`,
        '--no-deps',
        ...runArgs
      ],
      { timeoutMs, stdin }
    )
  } catch (error) {
    composeError = new Error('one-off command execution failed')
  }
  if (composeError === null) {
    const inspected = await inspectOneOff(run, entry, environment)
    if (!oneOffOutcomeIsBound(inspected, result)) {
      composeError = new Error('one-off success evidence did not identify the owned container')
    } else if (result.status !== 0) {
      composeError = new Error('one-off command failed')
    } else {
      // 第一次 exact singleton inspect 一旦确认 owner token，就把 immutable ID
      // 写回 registry。之后即使并发 rename，cleanup 仍按 ID 找到并删除本轮对象；
      // 可变 name 只用于创建前的 absent 证明。
      entry.id = inspected.id
    }
    if (composeError === null && beforeRemove !== null) {
      try {
        await beforeRemove({ id: inspected.id, name: entry.name })
      } catch {
        composeError = new Error('one-off container handoff failed')
      }
    }
  }
  const removed = await removeOwnedOneOff(run, entry, environment)
  if (!removed) {
    if (warn !== null) {
      warn('one-off container could not be confirmed owned and removed; it stays registered')
    }
    throw new Error('one-off container cleanup could not verify ownership and absence')
  }
  if (composeError !== null) {
    throw composeError
  }
  return result
}

/**
 * 清掉所有尚未确认移除的一次性容器（连同匿名卷）。运维入口把它接进信号
 * cleanup——没有它，SIGINT 之后 daemon 侧的一次性容器（内含 pgpass 副本）
 * 会继续运行且无人发现；演练把它并进 cleanupAll 作第一道兜底。
 */
export const removeLingeringOneOffs = async (run, { environment = process.env } = {}) => {
  const residue = []
  for (const entry of [...activeOneOffContainers.values()]) {
    if (!(await removeOwnedOneOff(run, entry, environment))) {
      residue.push(`one-off container ${entry.name} could not be confirmed owned and removed`)
    }
  }
  return residue
}

/** 信号在飞时抛出的中断错误：不是「演练失败」，而是「被要求停下」。 */
export class DrillInterrupted extends Error {
  constructor(signal) {
    super(`interrupted by ${signal}`)
    this.name = 'DrillInterrupted'
  }
}

export const throwIfInterrupted = () => {
  const signal = terminationSignal()
  if (signal !== null) {
    throw new DrillInterrupted(signal)
  }
}

/**
 * 启动一个已经存在的受控容器，不让 Compose 重新遍历 depends_on。
 * 失败诊断只包含固定类别与退出状态，绝不带 Docker stderr。
 */
export const startExistingContainer = async (run, containerName) => {
  const result = await run(['docker', 'start', containerName], { timeoutMs: 120_000 })
  if (result.status !== 0) {
    const outcome =
      result.status === null ? `signal ${String(result.signal ?? 'unknown')}` : String(result.status)
    throw new Error(`existing container start failed with exit ${outcome}`)
  }
}

/**
 * 演练运行上下文：每轮唯一的 run id / image tag / override / 临时 Secret 目录、
 * 输出边界与计时器，以及一到两个 project 栈。**必须在第一个 `await` 之前**
 * 创建全部栈并装上 signal handler——mkdtemp 与栈登记都是同步的，信号只会落在
 * 之后的 await 点上，因此不存在「Secret 目录已建、现场未登记」的窗口。
 */
export const createM4Run = ({ kind }) => {
  const runId = `m4-${kind}-${randomBytes(6).toString('hex')}`
  const imageTag = runImageTagFor(runId)
  const overridePath = overridePathFor(composeDirectory, runId)
  const secretsDirectory = mkdtempSync(resolve(tmpdir(), temporarySecretsPrefix))
  const secretsIdentity = inodeIdentityOf(secretsDirectory)
  const artifactCleanup = createScopedArtifactCleanup()

  const transcript = []
  const failures = []
  const scrubber = createSecretScrubber()
  const log = (line) => {
    const safe = scrubber.scrub(line)
    transcript.push(safe)
    process.stdout.write(`${safe}\n`)
  }
  const fail = (message) => {
    const safe = scrubber.scrubUntrusted(message)
    failures.push(safe)
    log(`FAIL: ${safe}`)
  }

  const durations = []
  const timed = async (label, fn) => {
    const start = performance.now()
    try {
      return await fn()
    } finally {
      durations.push({ label, ms: Math.round(performance.now() - start) })
    }
  }

  const run = (
    args,
    { env, timeoutMs = 120_000, cwd = composeDirectory, stdin = null } = {}
  ) => runCommand(args, { env: env ?? process.env, timeoutMs, cwd, stdin })

  const shared = {
    imageTag: null,
    imageId: null,
    overridePath,
    overrideCreated: false,
    danglingBaseline: null
  }
  const stacks = []

  const sleep = (milliseconds) =>
    new Promise((resolveSleep) => {
      setTimeout(resolveSleep, milliseconds)
    })

  const waitFor = async (label, predicate, timeoutMs, intervalMs = 2_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      throwIfInterrupted()
      const value = await predicate()
      if (value !== null) {
        return value
      }
      if (Date.now() >= deadline) {
        throw new Error(`${label}: timed out after ${String(timeoutMs)}ms`)
      }
      await sleep(intervalMs)
    }
  }

  const logExcerpt = async (containerName, environment) => {
    const logs = await run(['docker', 'logs', containerName], { env: environment })
    if (logs.status !== 0) {
      return 'the container log evidence was unavailable'
    }
    return logs.stdout === '' && logs.stderr === ''
      ? 'docker logs succeeded but the container produced no output'
      : 'the container log was withheld at the trust boundary'
  }

  const createStack = (suffix) => {
    const project = `meal-agent-m4-${suffix}-${runId.slice('m4-'.length + kind.length + 1)}`
    if (!m4ProjectPattern.test(project)) {
      throw new Error(`internal error: ${project} does not satisfy the m4 project pattern`)
    }
    const stack = {
      project,
      hostPort: null,
      composeEnvironment: {
        ...process.env,
        MEAL_AGENT_SECRETS_DIR: secretsDirectory,
        MEAL_AGENT_API_HOST_PORT: '3000'
      }
    }
    stack.containerName = (service) => `${project}-${service}-1`
    stack.compose = (args, options = {}) =>
      run(
        [
          'docker',
          'compose',
          '--file',
          composeFile,
          ...(shared.overrideCreated ? ['--file', overridePath] : []),
          '--profile',
          'bootstrap',
          '--project-name',
          project,
          ...args
        ],
        { env: stack.composeEnvironment, ...options }
      )
    stack.assignHostPort = async () => {
      const port = await pickFreePort()
      stack.hostPort = port
      stack.composeEnvironment = {
        ...stack.composeEnvironment,
        MEAL_AGENT_API_HOST_PORT: String(port)
      }
      return port
    }
    const inspectStackService = async (service) => {
      const name = stack.containerName(service)
      const inspected = await run(['docker', 'container', 'inspect', name], {
        env: stack.composeEnvironment
      })
      if (inspected.status !== 0 || typeof inspected.stdout !== 'string' || inspected.stdout === '') {
        throw new Error(`${service}: container evidence was unavailable`)
      }
      let payload
      try {
        payload = JSON.parse(inspected.stdout)
      } catch {
        throw new Error(`${service}: container evidence was malformed`)
      }
      const container = Array.isArray(payload) && payload.length === 1 ? payload[0] : null
      const labels = container?.Config?.Labels
      if (
        typeof container?.Id !== 'string' ||
        !/^[0-9a-f]{64}$/.test(container.Id) ||
        container.Name !== `/${name}` ||
        typeof container.Image !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(container.Image) ||
        labels?.['com.docker.compose.project'] !== stack.project ||
        labels?.['com.docker.compose.service'] !== service ||
        container.State === null ||
        typeof container.State !== 'object' ||
        Array.isArray(container.State)
      ) {
        throw new Error(`${service}: container identity evidence was invalid`)
      }
      return container
    }
    /** 一次性服务：启动 → 等 exited → 严格读取真实退出码。 */
    stack.runOneShot = async (service, timeoutMs) => {
      throwIfInterrupted()
      const name = stack.containerName(service)
      const started = await stack.compose(['up', '-d', '--no-deps', service], {
        timeoutMs: 180_000
      })
      if (started.status !== 0) {
        throw new Error(`compose up ${service} failed`)
      }
      let claimedId = null
      const container = await waitFor(
        `${service} run`,
        async () => {
          const current = await inspectStackService(service)
          if (claimedId === null) claimedId = current.Id
          if (current.Id !== claimedId) {
            throw new Error(`${service}: container identity changed while collecting evidence`)
          }
          return current.State.Status === 'exited' ? current : null
        },
        timeoutMs,
        1_000
      )
      if (
        container.State.Running !== false ||
        !Number.isSafeInteger(container.State.ExitCode) ||
        container.State.ExitCode < 0 ||
        typeof container.State.StartedAt !== 'string' ||
        container.State.StartedAt === '' ||
        typeof container.State.FinishedAt !== 'string' ||
        container.State.FinishedAt === '' ||
        container.State.FinishedAt === zeroDockerTimestamp
      ) {
        throw new Error(`${service}: exited container state evidence was invalid`)
      }
      return {
        service,
        exitCode: container.State.ExitCode,
        startedAt: container.State.StartedAt,
        containerId: container.Id,
        imageId: container.Image
      }
    }
    /** 一次性服务 + 非零即抛（带日志摘录）。 */
    stack.runOneShotExpectZero = async (service, timeoutMs) => {
      const outcome = await stack.runOneShot(service, timeoutMs)
      if (outcome.exitCode !== 0) {
        throw new Error(
          `${service} exited ${String(outcome.exitCode)}; ` +
            `${await logExcerpt(stack.containerName(service), stack.composeEnvironment)}`
        )
      }
      return outcome
    }
    /** 常驻服务：启动 → 等 healthy；提前退出立即失败。 */
    stack.runService = async (service, timeoutMs) => {
      throwIfInterrupted()
      const name = stack.containerName(service)
      const started = await stack.compose(['up', '-d', '--no-deps', service], {
        timeoutMs: 180_000
      })
      if (started.status !== 0) {
        throw new Error(`compose up ${service} failed`)
      }
      await waitFor(
        `${service} health`,
        async () => {
          if (
            (await inspectStrict(name, '{{.State.Status}}', { env: stack.composeEnvironment })) ===
            'exited'
          ) {
            throw new Error(
              `${service} exited before becoming healthy; ` +
                `${await logExcerpt(name, stack.composeEnvironment)}`
            )
          }
          return (await inspectStrict(name, '{{.State.Health.Status}}', {
            env: stack.composeEnvironment
          })) === 'healthy'
            ? 'healthy'
            : null
        },
        timeoutMs
      )
      return { service, exitCode: 0 }
    }
    /**
     * 「down 但保数据」：graceful stop → 逐个 `docker rm -v`（容器连同**匿名**
     * 卷一起走；named volume 不受 `rm -v` 影响）→ `compose down` 收网络。
     *
     * 直接 `compose down`（不带 `--volumes`）会把 psql 镜像一次性容器的匿名
     * 卷孤儿化——镜像声明了 `VOLUME /var/lib/postgresql`，而孤儿匿名卷没有
     * project label，最后的 label sweep 摸不到（首轮演练实测残留正好是六个
     * bootstrap 一次性容器的数量）。
     */
    stack.downKeepingData = async () => {
      const stopped = await stack.compose(['stop', '--timeout', '30'], { timeoutMs: 300_000 })
      if (stopped.status !== 0) {
        throw new Error(`compose stop before down failed with exit ${String(stopped.status)}`)
      }
      const containers = await listByProject('container', stack.project, {
        env: stack.composeEnvironment
      })
      if (containers.length > 0) {
        await dockerStrict(['docker', 'rm', '-v', ...containers], {
          env: stack.composeEnvironment,
          timeoutMs: 120_000
        })
      }
      const down = await stack.compose(['down'], { timeoutMs: 300_000 })
      if (down.status !== 0) {
        throw new Error(`compose down (without volumes) failed with exit ${String(down.status)}`)
      }
    }
    /**
     * 已存在但被 stop 的常驻服务：只启动这个受控的既有容器，再等 healthy。
     *
     * 这里不能使用 `docker compose start <service>`。Compose 会沿 depends_on
     * 把已经成功退出的 one-shot `secret-materializer` 再启动一次；那既不是
     * 「重启既有常驻容器」的语义，也会让一次性 Secret 物化重新发生。
     */
    stack.startService = async (service, timeoutMs) => {
      throwIfInterrupted()
      const name = stack.containerName(service)
      await startExistingContainer(run, name)
      await waitFor(
        `${service} restart health`,
        async () =>
          (await inspectStrict(name, '{{.State.Health.Status}}', {
            env: stack.composeEnvironment
          })) === 'healthy'
            ? 'healthy'
            : null,
        timeoutMs
      )
    }
    /**
     * 证据查询：cluster admin 经一次性 psql 容器执行（PGPASSFILE 走 secret）。
     * 一次性容器连同其匿名卷一起回收（见 composeRunOneOff）。
     */
    stack.adminSql = async (statements, { dbname = targetDatabase, timeoutMs = 120_000 } = {}) => {
      throwIfInterrupted()
      const args = [
        '--entrypoint',
        'psql',
        'bootstrap-acl',
        '--no-psqlrc',
        '-tA',
        '-v',
        'ON_ERROR_STOP=1',
        '--dbname',
        dbname
      ]
      for (const statement of statements) {
        args.push('--command', statement)
      }
      const result = await composeRunOneOff(
        { compose: stack.compose, run, environment: stack.composeEnvironment, warn: log },
        args,
        { timeoutMs }
      )
      if (result.status !== 0) {
        throw new Error('admin evidence query failed')
      }
      return result.stdout
    }
    /** 在一次性容器内跑一段 bash 探针（口令只经容器内 pgpass 流转）。 */
    stack.bashProbe = async (script, { volumes = [], timeoutMs = 120_000 } = {}) => {
      throwIfInterrupted()
      const args = []
      for (const volume of volumes) {
        args.push('--volume', volume)
      }
      args.push('--entrypoint', 'bash', 'bootstrap-logins', '-c', script)
      return composeRunOneOff(
        { compose: stack.compose, run, environment: stack.composeEnvironment, warn: log },
        args,
        { timeoutMs }
      )
    }
    /** needle 探针的统一断言：命令 exit 0 且全部期望 needle 在场。 */
    stack.expectProbe = async (label, script, expectations, options = {}) => {
      const probe = await stack.bashProbe(script, options)
      let problems = 0
      if (probe.status !== 0) {
        problems += 1
        fail(
          `${label}: the probe container exited ${String(probe.status)}; ` +
            'its output cannot be treated as evidence'
        )
      } else {
        // **整行**匹配，不是子串：`…exit=1` 用 includes 会被 `…exit=137`
        // （psql 被信号收走，$? = 128+n）伪匹配成「权限被拒」的阴性证据。
        const lines = probe.stdout.split('\n')
        for (const [needle, meaning] of expectations) {
          if (!lines.includes(needle)) {
            problems += 1
            fail(`${label}: expected the exact line "${needle}" (${meaning})`)
          }
        }
      }
      if (problems > 0) {
        log(`${label}: probe output withheld at the trust boundary`)
      } else {
        // 成功证据只在该组零 problem 时输出（与 smoke 的 P1-7 同口径）。
        log(`${label}: all ${String(expectations.length)} expectations hold`)
      }
      return problems === 0
    }
    stack.fetchStatus = async (path) => {
      const response = await fetch(`http://127.0.0.1:${String(stack.hostPort)}${path}`, {
        signal: AbortSignal.timeout(10_000)
      })
      return response.status
    }
    stacks.push(stack)
    return stack
  }

  /** Secret 生成 + 预检 + 输出打码武装。任何数据库容器启动之前调用。 */
  const generateSecrets = () => {
    generateAndPreflight(secretsDirectory)
    const bundleCheck = checkSecretBundle(secretsDirectory, { scanTemplates: false })
    if (bundleCheck.problems.length > 0) {
      throw new Error(
        `the freshly preflighted bundle re-read with problems: ${bundleCheck.problems.join('; ')}`
      )
    }
    scrubber.register(buildNeedles(bundleCheck.bodies).map((needle) => needle.value))
    log('secret bundle generated and preflighted (synthetic, cross-consistent; output scrubber armed)')
  }

  /** 写唯一 tag 的 override 并构建 API 镜像；返回 immutable image ID。 */
  const buildImage = async (stack) => {
    writeImageOverride(overridePath, imageTag)
    shared.overrideCreated = true
    shared.imageTag = imageTag
    const builtImageId = await buildApiImage({
      imageTag,
      repositoryRoot,
      env: stack.composeEnvironment
    })
    shared.imageId = builtImageId
    log(`api image built as ${imageTag} (image id ${builtImageId})`)
    return builtImageId
  }

  /**
   * 全部栈的分阶段 scoped cleanup。共享资源的归属是刻意的：明文 Secret 目录
   * 挂在**第一次** cleanupRun（其阶段 1 保证最先删），image tag / override /
   * 匿名卷对照挂在**最后一次**（tag 只能在所有栈的容器都消失之后删除）。
   */
  const cleanupAll = async () => {
    const residue = []
    // 第一道兜底：未确认移除的一次性容器（label sweep 之外多一层显式确认）。
    try {
      residue.push(...(await removeLingeringOneOffs(run)))
    } catch {
      residue.push('one-off sweep failed')
    }
    for (let index = 0; index < stacks.length; index += 1) {
      const first = index === 0
      const last = index === stacks.length - 1
      try {
        residue.push(
          ...(await cleanupRun({
            project: stacks[index].project,
            projectPattern: m4ProjectPattern,
            secretsDirectory: first ? secretsDirectory : null,
            secretsIdentity: first ? secretsIdentity : null,
            secretsPrefix: temporarySecretsPrefix,
            imageTag: last ? shared.imageTag : null,
            imageId: last ? shared.imageId : null,
            overridePath: last && shared.overrideCreated ? overridePath : null,
            composeFile,
            composeEnvironment: stacks[index].composeEnvironment,
            composeArgs:
              shared.overrideCreated && existsSync(overridePath) ? ['--file', overridePath] : [],
            danglingBaseline: last ? shared.danglingBaseline : null,
            realpath: realpathSync
          }))
        )
      } catch {
        residue.push('cleanup failed')
      }
    }
    return residue
  }

  /** cleanup 之后的独立复查（六类；共享资源只查一次）。 */
  const verifyResidueAll = async () => {
    const problems = []
    for (let index = 0; index < stacks.length; index += 1) {
      const first = index === 0
      const last = index === stacks.length - 1
      try {
        problems.push(
          ...(await verifyNoResidue({
            project: stacks[index].project,
            imageTag: last ? shared.imageTag : null,
            secretsDirectory: first ? secretsDirectory : null,
            overridePath: last && shared.overrideCreated ? overridePath : null,
            danglingBaseline: last ? shared.danglingBaseline : null,
            composeEnvironment: stacks[index].composeEnvironment,
            exists: existsSync
          }))
        )
      } catch {
        problems.push('residue recheck failed')
      }
    }
    return problems
  }

  return {
    runId,
    imageTag,
    overridePath,
    secretsDirectory,
    scrubber,
    transcript,
    failures,
    durations,
    log,
    fail,
    timed,
    run,
    shared,
    stacks,
    createStack,
    generateSecrets,
    buildImage,
    cleanupAll,
    verifyResidueAll,
    registerArtifactCleanup: artifactCleanup.register,
    cleanupArtifacts: artifactCleanup.run,
    waitFor,
    logExcerpt
  }
}

/** 全新安装十一步链（Secret 物化 + 严格 M2A 顺序）。 */
export const runFreshInstallChain = async (stack, log) => {
  for (const service of chainOrder) {
    if (service === 'postgres') {
      await stack.runService('postgres', 240_000)
      log('chain postgres: healthy (fresh named volume)')
    } else if (service === 'api') {
      await stack.runService('api', 180_000)
      log('chain api: healthy')
    } else {
      await stack.runOneShotExpectZero(service, service === 'migrate' ? 660_000 : 300_000)
      log(`chain ${service}: exit=0`)
    }
  }
}

/**
 * 演练主流程的统一骨架：signal handler、匿名卷 baseline、正常/失败/信号三条
 * 路径共用同一套 cleanup 与 residue 复查、固定的收尾输出与退出码。
 *
 * `body(context)` 只写演练本身的证据逻辑。`--keep-failure` 与 smoke 同语义：
 * 仅在**失败**时保留现场（含明文合成凭据，收尾必须手工删除）。
 */
export const executeDrill = async ({ kind, title, stackSuffixes, keepFailure = false, body }) => {
  const context = createM4Run({ kind })
  const { log, fail, failures, durations } = context
  const stacks = stackSuffixes.map((suffix) => context.createStack(suffix))

  installSignalHandlers(
    async () => {
      const residue = await context.cleanupArtifacts()
      residue.push(...(await context.cleanupAll()))
      residue.push(...(await context.verifyResidueAll()))
      return residue
    },
    { label: `${kind} drill scoped cleanup` }
  )

  log(`${title}: run ${context.runId}`)
  log(`projects: ${stacks.map((stack) => stack.project).join(', ')}`)
  log(`temporary secrets: ${context.secretsDirectory} (synthetic, generated fresh)`)

  let preserved = false
  try {
    // baseline 在 try 内：fail-closed 的 Docker 查询按设计会抛（daemon 不可达
    // 等），放在外面会绕过 finally 并把明文 Secret 目录留在盘上。
    context.shared.danglingBaseline = await danglingVolumes()
    context.generateSecrets()
    await body({ ...context, stacks })
  } catch (error) {
    if (error instanceof DrillInterrupted || terminationSignal() !== null) {
      log(`interrupted by ${terminationSignal() ?? 'a signal'}; the signal handler owns the cleanup`)
    } else {
      fail('drill execution failed')
    }
  } finally {
    if (terminationSignal() !== null) {
      log('signal in flight: the scoped cleanup is owned by the signal handler')
    } else if (failures.length > 0 && keepFailure) {
      preserved = true
      log(
        `--keep-failure: preserving projects ${stacks.map((stack) => stack.project).join(', ')}, ` +
          `image tag ${context.imageTag} and secrets directory ${context.secretsDirectory}`
      )
      log(
        'WARNING: the preserved secrets directory contains real synthetic ' +
          'credentials for the preserved databases; delete it after inspection'
      )
    } else {
      let residue = []
      try {
        residue = await context.cleanupArtifacts()
        residue.push(...(await context.cleanupAll()))
      } catch {
        residue = ['cleanup failed']
      }
      try {
        residue.push(...(await context.verifyResidueAll()))
      } catch {
        residue.push('residue recheck failed')
      }
      if (residue.length > 0) {
        fail(`cleanup residue: ${residue.join(', ')}`)
      } else {
        log(
          'cleanup: containers, networks, named volumes, anonymous dangling volumes, ' +
            'per-run image tag and temporary secrets all verified absent'
        )
      }
    }

    log('--- local drill durations (informational; no RPO/RTO is claimed) ---')
    for (const entry of durations) {
      log(`  ${entry.label}: ${String(entry.ms)}ms`)
    }
    const interrupted = terminationSignal()
    if (interrupted !== null) {
      log(`${title} INTERRUPTED by ${interrupted}; no PASS is claimed`)
    } else if (failures.length > 0) {
      log(`${title} FAIL (${String(failures.length)} problems)`)
      for (const message of failures) {
        log(`  - ${message}`)
      }
      if (preserved) {
        log('failure scene preserved (--keep-failure)')
      }
    } else {
      log(`${title} PASS`)
    }
  }

  if (terminationSignal() === null) {
    process.exit(failures.length > 0 ? 1 : 0)
  }
}

/** 演练入口共用的 argv 解析：只认 --keep-failure。 */
export const parseDrillArguments = (usage) => {
  const args = process.argv.slice(2)
  const keepFailure = args.includes('--keep-failure')
  const unknown = args.filter((argument) => argument !== '--keep-failure')
  if (unknown.length > 0) {
    process.stderr.write(`usage: ${usage}\n`)
    process.exit(2)
  }
  return { keepFailure }
}
