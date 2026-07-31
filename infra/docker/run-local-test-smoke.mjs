#!/usr/bin/env node
// 阶段 09A / M3B：从空 volume 开始的完整 local-test Compose bootstrap 链 smoke。
//
//   node infra/docker/run-local-test-smoke.mjs [--keep-failure]
//
// 只使用 Node 内置模块与 Docker CLI；不依赖全局 pnpm、宿主 node_modules 或
// 未构建的 dist（API 镜像由 Compose 的 build stanza 现场构建）。每次运行：
//
//   - 唯一、不可碰撞的 project name（meal-agent-m3b-smoke-<随机>）；
//   - 全新 named volume（project scope 决定真实名称）；
//   - 临时 synthetic Secret 目录（真实 generator 生成，任何数据库容器启动之前
//     先过完整预检与 Compose 拓扑静态门禁）；
//   - 随机未占用 host port（127.0.0.1 与 ::1 双侧确认空闲）；
//   - 严格顺序执行 postgres → bootstrap-cluster → bootstrap-logins →
//     bootstrap-createdb → bootstrap-schema → bootstrap-handoff → bootstrap-acl
//     → migrate → bootstrap-grants → api，**独立读取**每个一次性容器的真实
//     退出码（docker inspect，不依赖 depends_on 推断）；
//   - migrate 与 bootstrap-grants 各重跑一次，证明 Compose 入口幂等；
//   - /healthz 与 /readyz 必须 200；数据库证据（ledger、owner、RLS、角色属性、
//     runtime 最小权限、readiness 连接身份、逐服务 secret 可见面）逐项断言；
//   - 失败也执行 scoped cleanup（只处理本次 project 的 container/network/volume
//     与临时 Secret 目录）；只有显式 --keep-failure 才保留失败现场。
//
// 本脚本的输出**从不**包含任何 Secret 取值；全部输出先进入内存 transcript，
// containment 扫描（local-test-containment.mjs）会把它与容器产物一起过一遍。
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateAndPreflight } from './generate-local-test-secrets.mjs'
import { repositoryRoot } from './local-test-secrets-contract.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')
const migrationsDirectory = resolve(repositoryRoot, 'services/api/migrations')

/** cleanup 只接受这一形状的 project name：范围外的名称一律拒绝处理。 */
export const smokeProjectPattern = /^meal-agent-m3b-[a-z0-9][a-z0-9-]*$/

/** 临时 Secret 目录只允许出现在系统 tmpdir 下的这一前缀里。 */
const temporarySecretsPrefix = 'meal-agent-m3b-secrets-'

/** 十个服务的启动顺序（严格按 M2A 的全新安装顺序）。 */
const chainOrder = [
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

/** 每个服务允许看到的 secret target（/run/secrets/ 下的文件名）。 */
const expectedSecretMounts = {
  postgres: ['postgres_superuser_password'],
  'bootstrap-cluster': ['postgres_admin_pgpass'],
  'bootstrap-logins': [
    'meal_agent_backup_password',
    'meal_agent_migration_password',
    'meal_agent_runtime_password',
    'postgres_admin_pgpass'
  ],
  'bootstrap-createdb': ['postgres_admin_pgpass'],
  'bootstrap-schema': ['meal_agent_admin_database_url'],
  'bootstrap-handoff': ['postgres_admin_pgpass'],
  'bootstrap-acl': ['postgres_admin_pgpass'],
  'bootstrap-grants': ['postgres_admin_pgpass'],
  migrate: ['meal_agent_migration_database_url'],
  api: ['meal_agent_runtime_database_url']
}

/**
 * RLS 期望来自冻结迁移的事实（0000 六张 + 0001 invites + 0002 link_requests
 * 启用并 FORCE；其余表刻意不启用），不是对观察值的追认。
 */
const expectedRowSecurity = {
  'drizzle.__meal_agent_migrations': false,
  'public.auth_identities': false,
  'public.household_invites': true,
  'public.households': true,
  'public.idempotency_records': true,
  'public.inventory_events': true,
  'public.inventory_lots': true,
  'public.memberships': true,
  'public.person_profile_link_requests': true,
  'public.person_profiles': true,
  'public.sessions': false,
  'public.users': false
}

const migrationRole = 'meal_agent_migrator'

// ---------------------------------------------------------------------------
// transcript 与失败收集
// ---------------------------------------------------------------------------
const transcript = []
const failures = []
export const smokeState = { transcript, failures }

const log = (line) => {
  transcript.push(line)
  process.stdout.write(`${line}\n`)
}
const fail = (message) => {
  failures.push(message)
  log(`FAIL: ${message}`)
}

// ---------------------------------------------------------------------------
// 子进程帮助器（全部有界）
// ---------------------------------------------------------------------------
const run = (args, { env, timeoutMs = 120_000, cwd = composeDirectory } = {}) => {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs
  })
  if (result.error !== undefined) {
    throw new Error(`failed to run ${args.join(' ')}: ${result.error.message}`)
  }
  return result
}

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds)
  })

// ---------------------------------------------------------------------------
// scoped cleanup（供反向测试 import；范围外的 project name 一律拒绝）
// ---------------------------------------------------------------------------
export const cleanupSmokeProject = (
  project,
  secretsDirectory = null,
  { composeEnvironment = process.env } = {}
) => {
  if (typeof project !== 'string' || !smokeProjectPattern.test(project)) {
    throw new Error(
      `cleanup refused: project name ${JSON.stringify(project)} is outside ` +
        'the meal-agent-m3b-* smoke scope'
    )
  }
  const residue = []
  // down 先做一次常规回收（包括 run 创建的一次性容器）。
  run(
    [
      'docker',
      'compose',
      '--file',
      composeFile,
      '--profile',
      'bootstrap',
      '--project-name',
      project,
      'down',
      '--volumes',
      '--remove-orphans'
    ],
    { env: composeEnvironment, timeoutMs: 300_000 }
  )
  // 再按 project label 逐类兜底。filter 是精确匹配；这里再核对一遍 label，
  // 保证永远不会碰到其他 project 的资源。
  const sweep = [
    {
      list: ['docker', 'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
      inspectLabel: (id) =>
        run(['docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', id]),
      remove: (ids) => run(['docker', 'rm', '-f', ...ids], { timeoutMs: 300_000 }),
      kind: 'container'
    },
    {
      list: ['docker', 'network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
      inspectLabel: (id) =>
        run(['docker', 'network', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', id]),
      remove: (ids) => run(['docker', 'network', 'rm', ...ids], { timeoutMs: 120_000 }),
      kind: 'network'
    },
    {
      list: ['docker', 'volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
      inspectLabel: (id) =>
        run(['docker', 'volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', id]),
      remove: (ids) => run(['docker', 'volume', 'rm', '-f', ...ids], { timeoutMs: 120_000 }),
      kind: 'volume'
    }
  ]
  for (const { list, inspectLabel, remove, kind } of sweep) {
    const listed = run(list)
    const identifiers = listed.stdout.split('\n').filter(Boolean)
    const owned = identifiers.filter(
      (id) => inspectLabel(id).stdout.trim() === project
    )
    if (owned.length !== identifiers.length) {
      throw new Error(
        `cleanup refused: a listed ${kind} does not carry the project label ${project}`
      )
    }
    if (owned.length > 0) {
      remove(owned)
    }
    const remaining = run(list).stdout.split('\n').filter(Boolean)
    for (const id of remaining) {
      residue.push(`${kind} ${id}`)
    }
  }
  if (secretsDirectory !== null) {
    const realTmp = realpathSync(tmpdir())
    const realDir = realpathSync(secretsDirectory)
    if (!realDir.startsWith(resolve(realTmp, temporarySecretsPrefix))) {
      throw new Error(
        `cleanup refused: ${secretsDirectory} is not a ${temporarySecretsPrefix}* ` +
          'directory under the system tmpdir'
      )
    }
    rmSync(realDir, { recursive: true, force: true })
  }
  return residue
}

// ---------------------------------------------------------------------------
// 随机未占用端口（127.0.0.1 与 ::1 双侧确认）
// ---------------------------------------------------------------------------
const portIsFree = (host, port) =>
  new Promise((resolvePort) => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolvePort(true))
    })
  })

const pickFreePort = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = 20_000 + randomBytes(2).readUInt16BE(0) % 40_000
    if ((await portIsFree('127.0.0.1', candidate)) && (await portIsFree('::1', candidate))) {
      return candidate
    }
  }
  throw new Error('could not find a free host port on both 127.0.0.1 and ::1')
}

// ---------------------------------------------------------------------------
// 链路执行
// ---------------------------------------------------------------------------
const containerNameOf = (project, service) => `${project}-${service}-1`

const inspectFormat = (target, format) => {
  const result = run(['docker', 'inspect', '--format', format, target])
  if (result.status !== 0) {
    return null
  }
  return result.stdout.trim()
}

const waitFor = async (label, predicate, timeoutMs, intervalMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== null) {
      return value
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: timed out after ${String(timeoutMs)}ms`)
    }
    await sleep(intervalMs)
  }
}

export const runSmoke = async ({ keepFailure = false } = {}) => {
  const project = `meal-agent-m3b-smoke-${randomBytes(6).toString('hex')}`
  const secretsDirectory = mkdtempSync(resolve(tmpdir(), temporarySecretsPrefix))
  const stepResults = []
  let composeEnvironment = process.env
  let preserved = false

  const compose = (args, options = {}) =>
    run(
      [
        'docker',
        'compose',
        '--file',
        composeFile,
        '--profile',
        'bootstrap',
        '--project-name',
        project,
        ...args
      ],
      { env: composeEnvironment, ...options }
    )

  /** 一次性服务：启动 → 等 exited → 独立读取真实退出码 + StartedAt。 */
  const runOneShot = async (service, timeoutMs) => {
    const name = containerNameOf(project, service)
    const started = compose(['up', '-d', '--no-deps', service], { timeoutMs: 180_000 })
    if (started.status !== 0) {
      throw new Error(`compose up ${service} failed: ${started.stderr.trim()}`)
    }
    await waitFor(
      `${service} run`,
      () => (inspectFormat(name, '{{.State.Status}}') === 'exited' ? 'exited' : null),
      timeoutMs,
      1_000
    )
    const exitCode = Number(inspectFormat(name, '{{.State.ExitCode}}'))
    const startedAt = inspectFormat(name, '{{.State.StartedAt}}')
    return { service, exitCode, startedAt }
  }

  /** 常驻服务：启动 → 等 healthy。 */
  const runService = async (service, timeoutMs) => {
    const name = containerNameOf(project, service)
    const started = compose(['up', '-d', '--no-deps', service], { timeoutMs: 180_000 })
    if (started.status !== 0) {
      throw new Error(`compose up ${service} failed: ${started.stderr.trim()}`)
    }
    await waitFor(
      `${service} health`,
      () => (inspectFormat(name, '{{.State.Health.Status}}') === 'healthy' ? 'healthy' : null),
      timeoutMs
    )
    return { service, exitCode: 0, startedAt: inspectFormat(name, '{{.State.StartedAt}}') }
  }

  /** 证据查询：以 cluster admin 通过一次性 psql 容器执行（凭据走 PGPASSFILE）。 */
  const adminSql = (statements, { dbname = 'meal_agent' } = {}) => {
    const args = [
      'run',
      '--no-deps',
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
    const result = compose(args, { timeoutMs: 120_000 })
    if (result.status !== 0) {
      throw new Error(`admin evidence query failed: ${result.stderr.trim()}`)
    }
    return result.stdout
  }

  try {
    log(`smoke project: ${project}`)
    log(`temporary secrets: ${secretsDirectory} (synthetic, generated fresh)`)

    // 0. Secret 生成 + 预检 + 拓扑静态门禁：全部先于任何数据库容器。
    generateAndPreflight(secretsDirectory)
    log('secret bundle generated and preflighted (8 files, cross-consistent)')

    const gate = run(['node', resolve(composeDirectory, 'check-compose-topology.mjs')], {
      timeoutMs: 300_000,
      cwd: repositoryRoot
    })
    if (gate.status !== 0) {
      throw new Error(`compose topology gate failed before any container:\n${gate.stderr}`)
    }
    log('compose topology static gate PASS (before any container start)')

    const hostPort = await pickFreePort()
    composeEnvironment = {
      ...process.env,
      MEAL_AGENT_SECRETS_DIR: secretsDirectory,
      MEAL_AGENT_API_HOST_PORT: String(hostPort)
    }
    log(`host port: ${String(hostPort)} (free on 127.0.0.1 and ::1)`)

    // 1. 构建 API 镜像（compose 的 build stanza，不依赖宿主 dist/pnpm）。
    const build = compose(['build', 'api'], { timeoutMs: 1_200_000 })
    if (build.status !== 0) {
      throw new Error(`docker compose build api failed:\n${build.stderr.slice(-2000)}`)
    }
    log('api image built via the compose build stanza')

    // 2. 严格顺序执行完整链，独立读取每个一次性容器的退出码。
    for (const service of chainOrder) {
      let outcome
      if (service === 'postgres') {
        outcome = await runService('postgres', 240_000)
        log('chain postgres: healthy (fresh named volume)')
      } else if (service === 'api') {
        outcome = await runService('api', 180_000)
        log('chain api: healthy')
      } else {
        outcome = await runOneShot(service, service === 'migrate' ? 660_000 : 300_000)
        log(`chain ${service}: exit=${String(outcome.exitCode)}`)
        if (outcome.exitCode !== 0) {
          const logs = run(['docker', 'logs', containerNameOf(project, service)])
          throw new Error(
            `${service} exited ${String(outcome.exitCode)}; last log lines:\n` +
              `${(logs.stdout + logs.stderr).split('\n').slice(-15).join('\n')}`
          )
        }
      }
      stepResults.push(outcome)
    }

    // 3. migrate 与 grants 重跑：同一 Compose 入口必须幂等。
    for (const service of ['migrate', 'bootstrap-grants']) {
      const before = inspectFormat(containerNameOf(project, service), '{{.State.StartedAt}}')
      const rerun = await runOneShot(service, 300_000)
      if (rerun.exitCode !== 0) {
        fail(`${service} rerun exited ${String(rerun.exitCode)}; the entry point is not idempotent`)
      } else if (rerun.startedAt === before) {
        fail(`${service} rerun did not actually restart the container`)
      } else {
        log(`idempotence ${service}: second run exit=0 (container restarted)`)
      }
      stepResults.push({ service: `${service} (rerun)`, exitCode: rerun.exitCode })
    }

    // 4. /healthz 与 /readyz。
    for (const path of ['/healthz', '/readyz']) {
      const response = await fetch(`http://127.0.0.1:${String(hostPort)}${path}`, {
        signal: AbortSignal.timeout(10_000)
      })
      if (response.status !== 200) {
        fail(`${path} returned ${String(response.status)}, expected 200`)
      } else {
        log(`${path}: 200`)
      }
    }

    // 5. 数据库证据。
    // 5a. ledger 精确等于磁盘上的 0000—0004（名称 + sha256 + 顺序）。
    const expectedLedger = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => {
        const sql = readFileSync(resolve(migrationsDirectory, name), 'utf8')
        return `${name}:${createHash('sha256').update(sql).digest('hex')}`
      })
    const ledger = adminSql([
      'SELECT name || \':\' || hash FROM drizzle.__meal_agent_migrations ORDER BY name COLLATE "C"'
    ])
      .split('\n')
      .filter(Boolean)
    if (JSON.stringify(ledger) !== JSON.stringify(expectedLedger)) {
      fail(
        `migration ledger drifted: got [${ledger.map((row) => row.split(':')[0]).join(', ')}], ` +
          `expected [${expectedLedger.map((row) => row.split(':')[0]).join(', ')}] ` +
          '(names, hashes and order are all compared)'
      )
    } else {
      log(`ledger: exactly ${String(ledger.length)} entries 0000—0004, hashes match disk`)
    }

    // 5b. database/schema/relation/routine owner 全部归 meal_agent_migrator。
    const ownerRows = adminSql([
      "SELECT 'database:' || datname || '=' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()",
      "SELECT 'schema:' || nspname || '=' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname IN ('public','drizzle','meal_agent_private') ORDER BY 1",
      "SELECT 'relation:' || n.nspname || '.' || c.relname || '=' || pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle','meal_agent_private') AND c.relkind IN ('r','p','v','m','S') ORDER BY 1",
      "SELECT 'routine:' || n.nspname || '.' || p.proname || '=' || pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','drizzle','meal_agent_private') ORDER BY 1"
    ])
      .split('\n')
      .filter(Boolean)
    const schemaRows = ownerRows.filter((row) => row.startsWith('schema:'))
    if (schemaRows.length !== 3) {
      fail(`expected the three managed schemas, saw ${String(schemaRows.length)}`)
    }
    const badOwners = ownerRows.filter((row) => !row.endsWith(`=${migrationRole}`))
    if (badOwners.length > 0) {
      fail(`owners drifted from ${migrationRole}: ${badOwners.join('; ')}`)
    } else {
      log(
        `owners: database, 3 schemas, ${String(ownerRows.filter((row) => row.startsWith('relation:')).length)} relations, ` +
          `${String(ownerRows.filter((row) => row.startsWith('routine:')).length)} routines all owned by ${migrationRole}`
      )
    }

    // 5c. RLS enable/force 与冻结迁移声明逐表一致。
    const rlsRows = adminSql([
      "SELECT n.nspname || '.' || c.relname || '=' || c.relrowsecurity || ':' || c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle','meal_agent_private') AND c.relkind IN ('r','p') ORDER BY 1"
    ])
      .split('\n')
      .filter(Boolean)
    const actualRls = Object.fromEntries(
      rlsRows.map((row) => {
        const [ident, state] = row.split('=')
        return [ident, state]
      })
    )
    const expectedRls = Object.fromEntries(
      Object.entries(expectedRowSecurity).map(([ident, enabled]) => [
        ident,
        enabled ? 'true:true' : 'false:false'
      ])
    )
    if (JSON.stringify(actualRls) !== JSON.stringify(expectedRls)) {
      fail(
        `row security state drifted: got ${JSON.stringify(actualRls)}, ` +
          `expected ${JSON.stringify(expectedRls)}`
      )
    } else {
      log('row security: enable/force state matches the frozen migrations for all 12 tables')
    }

    // 5d. 角色属性：三个 login 无任何高权限属性且 NOINHERIT；migrator/backup
    // 的 BYPASSRLS 如实记录；app 不带 BYPASSRLS。
    const roleRows = adminSql([
      "SELECT rolname || '=' || rolsuper || ':' || rolbypassrls || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolinherit || ':' || rolcanlogin FROM pg_roles WHERE rolname LIKE 'meal_agent%' ORDER BY 1"
    ])
      .split('\n')
      .filter(Boolean)
    const expectedRoles = [
      'meal_agent_app=false:false:false:false:true:false',
      'meal_agent_backup=false:true:false:false:true:false',
      'meal_agent_backup_login=false:false:false:false:false:true',
      'meal_agent_migration_login=false:false:false:false:false:true',
      'meal_agent_migrator=false:true:false:false:true:false',
      'meal_agent_runtime_login=false:false:false:false:false:true'
    ]
    if (JSON.stringify(roleRows) !== JSON.stringify(expectedRoles)) {
      fail(
        `role attributes drifted: got ${JSON.stringify(roleRows)}, ` +
          `expected ${JSON.stringify(expectedRoles)}`
      )
    } else {
      log('roles: login/NOLOGIN attribute matrix matches the accepted identity model')
    }

    // 5e. runtime 最小权限（以 runtime login 真实连接执行）。
    const runtimeProbe = compose(
      [
        'run',
        '--no-deps',
        '--entrypoint',
        'bash',
        'bootstrap-logins',
        '-c',
        [
          'set -uo pipefail',
          'umask 077',
          'printf "postgres:5432:meal_agent:meal_agent_runtime_login:%s\\n" "$(< /run/secrets/meal_agent_runtime_password)" > /tmp/runtime.pgpass',
          'export PGPASSFILE=/tmp/runtime.pgpass',
          'RUNPSQL="psql --no-psqlrc --no-password -tA -h postgres -p 5432 -U meal_agent_runtime_login -d meal_agent"',
          'echo "whoami=$($RUNPSQL -c "SELECT current_user" 2>&1)"',
          '$RUNPSQL -c "CREATE TABLE public.m3b_probe(x int)" > /dev/null 2>&1; echo "create-table-exit=$?"',
          '$RUNPSQL -c "SET ROLE meal_agent_migrator" > /dev/null 2>&1; echo "set-role-migrator-exit=$?"',
          '$RUNPSQL -c "SET ROLE meal_agent_app; SELECT count(*) FROM drizzle.__meal_agent_migrations" > /dev/null 2>&1; echo "app-ledger-read-exit=$?"',
          'rm -f /tmp/runtime.pgpass'
        ].join('\n')
      ],
      { timeoutMs: 120_000 }
    )
    const probeOut = runtimeProbe.stdout
    const probeExpectations = [
      ['whoami=meal_agent_runtime_login', 'runtime login connects as itself'],
      ['create-table-exit=1', 'runtime login cannot CREATE TABLE'],
      ['set-role-migrator-exit=1', 'runtime login cannot SET ROLE meal_agent_migrator'],
      ['app-ledger-read-exit=0', 'SET ROLE meal_agent_app can read the migration ledger']
    ]
    for (const [needle, meaning] of probeExpectations) {
      if (!probeOut.includes(needle)) {
        fail(`runtime privilege probe: expected "${needle}" (${meaning})`)
      }
    }
    if (probeExpectations.every(([needle]) => probeOut.includes(needle))) {
      log('runtime least privilege: no DDL, no migrator role, app-role ledger read works')
    }

    // 5f. readiness 使用 runtime 连接：触发 /readyz 后，目标库上的连接身份
    // 只能是 runtime login（外加本查询自己的 admin 连接）。
    await fetch(`http://127.0.0.1:${String(hostPort)}/readyz`, {
      signal: AbortSignal.timeout(10_000)
    })
    const activity = adminSql([
      "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = 'meal_agent' ORDER BY 1"
    ])
      .split('\n')
      .filter(Boolean)
    if (!activity.includes('meal_agent_runtime_login')) {
      fail('readiness identity: no meal_agent_runtime_login connection is present')
    }
    const unexpectedIdentities = activity.filter(
      (name) => name !== 'meal_agent_runtime_login' && name !== 'postgres'
    )
    if (unexpectedIdentities.length > 0) {
      fail(
        `readiness identity: unexpected database identities are connected: ${unexpectedIdentities.join(', ')}`
      )
    }
    if (
      activity.includes('meal_agent_runtime_login') &&
      unexpectedIdentities.length === 0
    ) {
      log(
        'readiness identity: api connects as meal_agent_runtime_login only ' +
          '(admin observer connection excepted)'
      )
    }

    // 5g. 逐服务 secret 可见面：每个容器（含证据用一次性容器）只允许它所属
    // service 声明的 secret target。
    const containerIds = run([
      'docker',
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=${project}`
    ])
      .stdout.split('\n')
      .filter(Boolean)
    for (const id of containerIds) {
      const service = inspectFormat(id, '{{index .Config.Labels "com.docker.compose.service"}}')
      const mounts = JSON.parse(inspectFormat(id, '{{json .Mounts}}') ?? '[]')
      const secretTargets = mounts
        .map((mount) => String(mount.Destination ?? ''))
        .filter((destination) => destination.startsWith('/run/secrets/'))
        .map((destination) => destination.slice('/run/secrets/'.length))
        .sort()
      const expected = [...(expectedSecretMounts[service] ?? [])].sort()
      if (JSON.stringify(secretTargets) !== JSON.stringify(expected)) {
        fail(
          `secret visibility: ${service} container sees [${secretTargets.join(', ')}], ` +
            `allowed [${expected.join(', ')}]`
        )
      }
    }
    log(
      `secret visibility: ${String(containerIds.length)} project containers each ` +
        'mount exactly their declared secret set'
    )

    return { project, hostPort, stepResults }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return { project, hostPort: null, stepResults }
  } finally {
    if (failures.length > 0 && keepFailure) {
      preserved = true
      log(
        `--keep-failure: preserving project ${project} and secrets directory ` +
          `${secretsDirectory} for inspection`
      )
    } else {
      const residue = cleanupSmokeProject(project, secretsDirectory, {
        composeEnvironment
      })
      if (residue.length > 0) {
        fail(`cleanup residue: ${residue.join(', ')}`)
      } else {
        log('cleanup: no project containers, networks, volumes or temporary secrets remain')
      }
    }

    // 结果报告。
    log('--- chain exit codes ---')
    for (const step of stepResults) {
      log(
        `  ${step.service}: ${
          step.service === 'postgres' || step.service === 'api'
            ? 'healthy'
            : `exit=${String(step.exitCode)}`
        }`
      )
    }
    if (failures.length > 0) {
      log(`local-test smoke FAIL (${String(failures.length)} problems)`)
      for (const message of failures) {
        log(`  - ${message}`)
      }
      if (preserved) {
        log('failure scene preserved (--keep-failure)')
      }
    } else {
      log('local-test smoke PASS')
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const keepFailure = args.includes('--keep-failure')
  const unknown = args.filter((arg) => arg !== '--keep-failure')
  if (unknown.length > 0) {
    process.stderr.write('usage: run-local-test-smoke.mjs [--keep-failure]\n')
    process.exit(2)
  }
  await runSmoke({ keepFailure })
  process.exit(failures.length > 0 ? 1 : 0)
}
