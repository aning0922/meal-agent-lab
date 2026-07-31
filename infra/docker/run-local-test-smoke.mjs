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
import { buildNeedles, runContainmentAndIsolation } from './local-test-containment.mjs'
import { checkSecretBundle, repositoryRoot } from './local-test-secrets-contract.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')
const migrationsDirectory = resolve(repositoryRoot, 'services/api/migrations')

/**
 * cleanup 只接受这两类 project name（smoke 自己与反例套件），范围外一律拒绝。
 * probe 的 `meal-agent-m3b-probe-*` 刻意**不在**范围内：并发运行的探针不该能
 * 被本 cleanup 摸到。
 */
export const smokeProjectPattern = /^meal-agent-m3b-(smoke|neg)-[a-z0-9][a-z0-9-]*$/

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
// transcript 与失败收集。**所有**输出（含失败路径上的容器日志摘录与子进程
// stderr）都先过 scrub：bundle 生成之后注册的每一条敏感值在输出里一律替换成
// 固定占位串。因此「本脚本的输出不含 Secret 取值」对成功与失败两条路径同时
// 成立，而不是只对精心挑选的正常输出成立。
// ---------------------------------------------------------------------------
const transcript = []
const failures = []
export const smokeState = { transcript, failures }

let scrubValues = []
const registerScrubValues = (values) => {
  // 长值优先替换，避免短前缀先替换后破坏长值匹配。
  scrubValues = [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((a, b) => b.length - a.length)
}
const scrub = (text) => {
  let output = text
  for (const value of scrubValues) {
    output = output.split(value).join('[redacted-secret]')
  }
  return output
}

const log = (line) => {
  const safe = scrub(line)
  transcript.push(safe)
  process.stdout.write(`${safe}\n`)
}
const fail = (message) => {
  const safe = scrub(message)
  failures.push(safe)
  log(`FAIL: ${safe}`)
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

  // 明文 Secret 目录**最先**删除：Docker 侧任何一步失败都不允许把八份明文
  // 口令留在 tmpdir 里。目录必须位于系统 tmpdir 下的固定前缀内，否则拒绝。
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

  // down 做一次常规回收（含 run 创建的一次性容器与匿名卷）。退出码不吞掉：
  // 失败记入 residue，随后的 label sweep 仍是权威回收路径。
  const down = run(
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
  if (down.status !== 0) {
    residue.push(
      `cleanup-warning: docker compose down exited ${String(down.status)}; ` +
        'relying on the label sweep below'
    )
  }

  // 再按 project label 逐类兜底。filter 是精确匹配；这里再核对一遍 label，
  // 保证永远不会碰到其他 project 的资源。容器删除带 -v：bootstrap 系列容器
  // 基于自带 VOLUME 的 postgres 镜像，不带 -v 会持续泄漏匿名卷。
  // 单类失败不中断其余类别的回收，错误记入 residue。
  const sweep = [
    {
      list: ['docker', 'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
      inspectLabel: (id) =>
        run(['docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', id]),
      remove: (ids) => run(['docker', 'rm', '-f', '-v', ...ids], { timeoutMs: 300_000 }),
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
    try {
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
    } catch (error) {
      residue.push(
        `cleanup-error (${kind}): ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return residue
}

/** 当前悬挂（无主）匿名卷集合：smoke 用它做前后对照，证明本轮没有泄漏匿名卷。 */
export const danglingVolumeSet = () =>
  new Set(
    run(['docker', 'volume', 'ls', '-qf', 'dangling=true'])
      .stdout.split('\n')
      .filter(Boolean)
  )

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
  // composeEnvironment 从第一刻起就带上 Secret 目录：即使在端口选定之前失败，
  // cleanup 的 `down` 也能用同一份环境解析配置，而不是回落到默认目录。
  let composeEnvironment = {
    ...process.env,
    MEAL_AGENT_SECRETS_DIR: secretsDirectory,
    MEAL_AGENT_API_HOST_PORT: '3000'
  }
  let preserved = false
  let chainStarted = false
  let bundleBodies = null
  // 匿名卷对照基线：postgres 镜像自带 VOLUME，容器删除必须带 -v；这里记录
  // 起点集合，结束时断言没有新增的悬挂匿名卷（匿名卷不带 project label，
  // 按 label 的 residue 检查在原理上看不见它们）。
  const danglingBaseline = danglingVolumeSet()

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

  /** inspect 的严格读取：读不到就抛，绝不把「inspect 失败」读成任何默认值。 */
  const mustInspect = (target, format, label) => {
    const value = inspectFormat(target, format)
    if (value === null) {
      throw new Error(
        `${label}: docker inspect failed; refusing to substitute a default value`
      )
    }
    return value
  }

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
    // Number('' / '<no value>') 是 NaN 会被下游当失败；Number(null) 却是 0，
    // 因此必须先经 mustInspect 把「读不到」显式变成错误。
    const exitCodeText = mustInspect(name, '{{.State.ExitCode}}', `${service} exit code`)
    const exitCode = Number(exitCodeText)
    if (!Number.isInteger(exitCode)) {
      throw new Error(`${service}: unreadable exit code ${JSON.stringify(exitCodeText)}`)
    }
    const startedAt = mustInspect(name, '{{.State.StartedAt}}', `${service} StartedAt`)
    return { service, exitCode, startedAt }
  }

  /** 常驻服务：启动 → 等 healthy；容器提前退出时立即失败，不空转到超时。 */
  const runService = async (service, timeoutMs) => {
    const name = containerNameOf(project, service)
    const started = compose(['up', '-d', '--no-deps', service], { timeoutMs: 180_000 })
    if (started.status !== 0) {
      throw new Error(`compose up ${service} failed: ${started.stderr.trim()}`)
    }
    await waitFor(
      `${service} health`,
      () => {
        if (inspectFormat(name, '{{.State.Status}}') === 'exited') {
          const logs = run(['docker', 'logs', name])
          throw new Error(
            `${service} exited before becoming healthy; last log lines:\n` +
              scrub((logs.stdout + logs.stderr).split('\n').slice(-15).join('\n'))
          )
        }
        return inspectFormat(name, '{{.State.Health.Status}}') === 'healthy' ? 'healthy' : null
      },
      timeoutMs
    )
    return {
      service,
      exitCode: 0,
      startedAt: mustInspect(name, '{{.State.StartedAt}}', `${service} StartedAt`)
    }
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
    // 把现场登记给 CLI 的信号处置（模块被 import 时 registerScene 不存在，
    // 此时没有信号接管，调用方自行负责）。
    smokeState.registerScene?.({ project, secretsDirectory, composeEnvironment })
    log(`smoke project: ${project}`)
    log(`temporary secrets: ${secretsDirectory} (synthetic, generated fresh)`)

    // 0. Secret 生成 + 预检 + 拓扑静态门禁：全部先于任何数据库容器。
    generateAndPreflight(secretsDirectory)
    // 只读回一次 bundle（预检刚通过，problems 必须为空），随后：
    //   - 把全部敏感值注册进输出 scrub（成功与失败路径的输出都过它）；
    //   - 同一份 bodies 直接交给 containment 阶段，不做第二次「丢弃 problems」
    //     的读取。
    const bundleCheck = checkSecretBundle(secretsDirectory, { scanTemplates: false })
    if (bundleCheck.problems.length > 0) {
      throw new Error(
        `the freshly preflighted bundle re-read with problems: ${bundleCheck.problems.join('; ')}`
      )
    }
    bundleBodies = bundleCheck.bodies
    registerScrubValues(buildNeedles(bundleBodies).map((needle) => needle.value))
    log('secret bundle generated and preflighted (8 files, cross-consistent; output scrubber armed)')

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
      ...composeEnvironment,
      MEAL_AGENT_API_HOST_PORT: String(hostPort)
    }
    smokeState.registerScene?.({ composeEnvironment })
    log(`host port: ${String(hostPort)} (free on 127.0.0.1 and ::1)`)

    // 1. 构建 API 镜像（compose 的 build stanza，不依赖宿主 dist/pnpm）。
    const build = compose(['build', 'api'], { timeoutMs: 1_200_000 })
    if (build.status !== 0) {
      throw new Error(`docker compose build api failed:\n${build.stderr.slice(-2000)}`)
    }
    log('api image built via the compose build stanza')

    // 2. 严格顺序执行完整链，独立读取每个一次性容器的退出码。
    chainStarted = true
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
          // 摘录容器日志帮助定位；scrub 保证失败路径的输出同样不含 Secret。
          const logs = run(['docker', 'logs', containerNameOf(project, service)])
          throw new Error(
            `${service} exited ${String(outcome.exitCode)}; last log lines:\n` +
              scrub((logs.stdout + logs.stderr).split('\n').slice(-15).join('\n'))
          )
        }
      }
      stepResults.push(outcome)
    }

    // 3. migrate 与 grants 重跑：同一 Compose 入口必须幂等。
    for (const service of ['migrate', 'bootstrap-grants']) {
      const before = mustInspect(
        containerNameOf(project, service),
        '{{.State.StartedAt}}',
        `${service} StartedAt before rerun`
      )
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

    // 6. Secret containment 扫描与动态网络隔离（api 仍在运行时取证）。
    // bodies 是启动前那次读取的同一份（problems 已断言为空），只在内存中流转。
    await runContainmentAndIsolation({
      project,
      hostPort,
      bodies: bundleBodies,
      composeFile,
      composeEnvironment,
      transcript,
      log,
      fail,
      run
    })

    return { project, hostPort, stepResults }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return { project, hostPort: null, stepResults }
  } finally {
    // --keep-failure 只在链路真的启动过（有现场可看）时才保留；启动前的失败
    // 没有诊断价值，不值得为它留一套明文凭据在 tmpdir。
    if (failures.length > 0 && keepFailure && chainStarted) {
      preserved = true
      log(
        `--keep-failure: preserving project ${project} and secrets directory ` +
          `${secretsDirectory} for inspection`
      )
      log(
        'WARNING: the preserved secrets directory contains real synthetic ' +
          'credentials for the preserved database; delete it after inspection'
      )
    } else {
      let residue
      try {
        residue = cleanupSmokeProject(project, secretsDirectory, {
          composeEnvironment
        })
      } catch (error) {
        residue = [
          `cleanup-error: ${error instanceof Error ? error.message : String(error)}`
        ]
      }
      // 匿名卷对照：本轮不允许新增任何悬挂匿名卷（它们不带 project label，
      // 上面的 residue 检查看不见）。
      try {
        const danglingNow = danglingVolumeSet()
        const newDangling = [...danglingNow].filter((id) => !danglingBaseline.has(id))
        if (newDangling.length > 0) {
          residue.push(
            `anonymous dangling volumes appeared during this run: ${newDangling.join(', ')}`
          )
        }
      } catch (error) {
        residue.push(
          `cleanup-error (dangling check): ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (residue.length > 0) {
        fail(`cleanup residue: ${residue.join(', ')}`)
      } else {
        log(
          'cleanup: no project containers, networks, volumes, anonymous ' +
            'dangling volumes or temporary secrets remain'
        )
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
  // 信号处置：Node 对 SIGINT/SIGTERM 的默认行为是直接终止，finally 不会执行，
  // 容器、卷与 tmpdir 里的明文 Secret 会整套留下。这里登记 runSmoke 当前的
  // 现场，在信号到达时做同一套 scoped cleanup 后再以 128+signo 退出。
  const activeScene = { project: null, secretsDirectory: null, composeEnvironment: process.env }
  smokeState.registerScene = (scene) => Object.assign(activeScene, scene)
  let terminating = false
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
      if (terminating) {
        return
      }
      terminating = true
      process.stderr.write(`\n${signal}: cleaning up the smoke scene before exiting\n`)
      try {
        if (activeScene.project !== null) {
          cleanupSmokeProject(activeScene.project, activeScene.secretsDirectory, {
            composeEnvironment: activeScene.composeEnvironment
          })
        }
      } catch (error) {
        process.stderr.write(
          `cleanup on ${signal} failed: ${error instanceof Error ? error.message : String(error)}\n`
        )
      }
      process.exit(code)
    })
  }
  await runSmoke({ keepFailure })
  process.exit(failures.length > 0 ? 1 : 0)
}
