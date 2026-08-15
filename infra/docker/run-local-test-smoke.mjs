#!/usr/bin/env node
// 阶段 09A / M3B：从空 volume 开始的完整 local-test Compose bootstrap 链 smoke。
//
//   node infra/docker/run-local-test-smoke.mjs [--keep-failure]
//
// 只使用 Node 内置模块与 Docker CLI；不依赖全局 pnpm、宿主 node_modules 或
// 未构建的 dist（API 镜像由 Compose 的 build stanza 现场构建）。每次运行：
//
//   - 唯一、不可碰撞的 project name（meal-agent-m3b-smoke-<随机>）**与唯一
//     image tag**（meal-agent-api:m3b-<同一 run id>，经临时 Compose override
//     注入，不改 M2B 已 Accepted 的默认拓扑）；build 后读取 immutable image ID
//     并断言三个 API 镜像服务容器的 `.Image` 全部等于它；
//   - 全新 named volume（project scope 决定真实名称）；
//   - 临时 synthetic Secret 目录（真实 generator 生成，任何数据库容器启动之前
//     先过完整预检与 Compose 拓扑静态门禁）；
//   - 随机未占用 host port（127.0.0.1 与 ::1 双侧确认空闲）；
//   - 严格顺序执行 postgres → bootstrap-cluster → bootstrap-logins →
//     bootstrap-createdb → bootstrap-schema → bootstrap-handoff → bootstrap-acl
//     → migrate → bootstrap-grants → api，**独立读取**每个一次性容器的真实
//     退出码（严格 inspect，读不到即失败，不依赖 depends_on 推断）；
//   - migrate 与 bootstrap-grants 各重跑一次，证明 Compose 入口幂等；
//   - /healthz 与 /readyz 必须 200；数据库证据（ledger、owner、RLS、角色属性、
//     runtime 最小权限、readiness 连接身份、逐服务 secret 可见面）逐项断言。
//
// 子进程全部走**异步 spawn**（自成进程组、有超时），因此事件循环存活、
// SIGINT/SIGTERM 可被真实处理：信号 → 终止受控子树 → 分阶段 scoped cleanup
// （residue 必被打印）→ 按原信号语义退出。正常、失败与信号三条路径复用**同一
// 套** cleanup 与同一套 residue 复查。
//
// 本脚本的输出**从不**包含任何 Secret 取值：bundle 生成后全部敏感值注册进
// scrubber，每一条输出（含失败路径的容器日志摘录与子进程 stderr）都过它。
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateAndPreflight } from './generate-local-test-secrets.mjs'
import { buildNeedles, runContainmentAndIsolation } from './local-test-containment.mjs'
import { checkSecretBundle, repositoryRoot } from './local-test-secrets-contract.mjs'
import {
  cleanupRun,
  danglingVolumes,
  imageIdOf,
  inodeIdentityOf,
  inspectJsonStrict,
  inspectStrict,
  parseInspectedExitCode,
  listByProject,
  overridePathFor,
  runImageTagFor,
  verifyNoResidue,
  writeImageOverride
} from './m3b-docker.mjs'
import { createSecretScrubber } from './m3b-safe-output.mjs'
import { installSignalHandlers, runCommand, terminationSignal } from './m3b-subprocess.mjs'

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

/** 十一个服务的启动顺序（Secret 物化必须早于数据库）。 */
const chainOrder = [
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

/** 使用 API 镜像的三个服务：它们的 `.Image` 必须等于本轮 build 出的 image ID。 */
const apiImageServices = ['bootstrap-schema', 'migrate', 'api']

/**
 * 每个服务允许看到的 secret 挂载，逐项固定 source 文件名、容器内 target 与
 * 只读标志——不再只筛 `/run/secrets/` 前缀，任何多余挂载都会被发现。
 */
const secretVolumeSources = {
  postgres_superuser_password: 'postgres-superuser-secret',
  postgres_admin_pgpass: 'postgres-admin-pgpass-secret',
  meal_agent_migration_password: 'migration-password-secret',
  meal_agent_runtime_password: 'runtime-password-secret',
  meal_agent_backup_password: 'backup-password-secret',
  meal_agent_admin_database_url: 'admin-url-secret',
  meal_agent_migration_database_url: 'migration-url-secret',
  meal_agent_runtime_database_url: 'runtime-url-secret'
}
const secretFilenames = {
  ...Object.fromEntries(Object.keys(secretVolumeSources).map((name) => [name, name])),
  postgres_admin_pgpass: 'postgres_admin.pgpass'
}
const volumeSecret = (name, target = `/run/secrets/${name}`, readOnly = true) => ({
  type: 'volume',
  name: secretVolumeSources[name],
  target,
  readOnly
})
const rawSecret = (name) => ({
  type: 'bind',
  filename: secretFilenames[name],
  target: `/run/source-secrets/${name}`,
  readOnly: true
})
const expectedSecretMounts = {
  'secret-materializer': [
    ...Object.keys(secretVolumeSources).map(rawSecret),
    ...Object.keys(secretVolumeSources).map((name) =>
      volumeSecret(name, `/materialized/${name}`, false)
    ),
    { type: 'volume', name: 'backup-transfer', target: '/transfer', readOnly: false }
  ],
  postgres: [volumeSecret('postgres_superuser_password')],
  'bootstrap-cluster': [volumeSecret('postgres_admin_pgpass')],
  'bootstrap-logins': [
    volumeSecret('postgres_admin_pgpass'),
    volumeSecret('meal_agent_migration_password'),
    volumeSecret('meal_agent_runtime_password'),
    volumeSecret('meal_agent_backup_password')
  ],
  'bootstrap-createdb': [volumeSecret('postgres_admin_pgpass')],
  'bootstrap-schema': [volumeSecret('meal_agent_admin_database_url')],
  'bootstrap-handoff': [volumeSecret('postgres_admin_pgpass')],
  'bootstrap-acl': [volumeSecret('postgres_admin_pgpass')],
  'bootstrap-grants': [volumeSecret('postgres_admin_pgpass')],
  migrate: [volumeSecret('meal_agent_migration_database_url')],
  api: [volumeSecret('meal_agent_runtime_database_url')]
}
// 可见面快照取在五条 admin SQL 证据与一条 runtime 最小权限探针之后：
// 这些 one-off 容器到 scoped cleanup 才统一移除。因此基数不是“至少有一个”，
// 而是 11 个 chain container + 5 个 bootstrap-acl query + 1 个
// bootstrap-logins runtime probe 的精确多重集。
const expectedVisibilityServiceLabels = [
  ...chainOrder,
  ...Array.from({ length: 5 }, () => 'bootstrap-acl'),
  'bootstrap-logins'
].sort()

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
// transcript、scrub 与失败收集
// ---------------------------------------------------------------------------
const transcript = []
const failures = []
export const smokeState = { transcript, failures }

// 共享的输出边界（m3b-safe-output.mjs）：证据行按**取值**打码（image ID 之类
// 必须保持可读），失败消息按**取值 + 形状**打码——失败文本里混着 docker
// stderr、容器日志摘录与 problems，而形状层在 bundle 尚未生成 / 已被删除时
// 仍然拦得住口令形态的长串与连接串。
const scrubber = createSecretScrubber()
const registerScrubValues = (values) => scrubber.register(values)
const scrub = (text) => scrubber.scrub(text)

const log = (line) => {
  const safe = scrub(line)
  transcript.push(safe)
  process.stdout.write(`${safe}\n`)
}
const fail = (message) => {
  const safe = scrubber.scrubUntrusted(message)
  failures.push(safe)
  log(`FAIL: ${safe}`)
}

// ---------------------------------------------------------------------------
// 异步子进程（自成进程组、有超时；signal handler 可整组回收）
// ---------------------------------------------------------------------------
const run = (args, { env, timeoutMs = 120_000, cwd = composeDirectory } = {}) =>
  runCommand(args, { env: env ?? process.env, timeoutMs, cwd })

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds)
  })

/**
 * 失败诊断用的容器日志摘录。**退出码必须检查**：`docker logs` 非零时输出是空的，
 * 若直接拼进消息，操作者看到的就是「last log lines:」后面什么都没有——证据静默
 * 消失，而失败原因看起来像「容器没打日志」。
 */
const logExcerpt = async (containerName) => {
  const logs = await run(['docker', 'logs', containerName])
  if (logs.status !== 0) {
    return (
      'the log excerpt is unavailable: docker logs exited ' +
      `${logs.status === null ? `on signal ${String(logs.signal)}` : String(logs.status)}`
    )
  }
  const excerpt = (logs.stdout + logs.stderr).split('\n').slice(-15).join('\n')
  return excerpt.trim() === ''
    ? 'docker logs succeeded but the container produced no output'
    : `last log lines:\n${scrub(excerpt)}`
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
    const candidate = 20_000 + (randomBytes(2).readUInt16BE(0) % 40_000)
    if ((await portIsFree('127.0.0.1', candidate)) && (await portIsFree('::1', candidate))) {
      return candidate
    }
  }
  throw new Error('could not find a free host port on both 127.0.0.1 and ::1')
}

const containerNameOf = (project, service) => `${project}-${service}-1`

/** 信号在飞时抛出的中断错误：它不是「smoke 失败」，而是「被要求停下」。 */
class SmokeInterrupted extends Error {
  constructor(signal) {
    super(`interrupted by ${signal}`)
    this.name = 'SmokeInterrupted'
  }
}

const throwIfInterrupted = () => {
  const signal = terminationSignal()
  if (signal !== null) {
    throw new SmokeInterrupted(signal)
  }
}

const waitFor = async (label, predicate, timeoutMs, intervalMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // 信号在飞：立刻停下，别再去 inspect 正在被 handler 删掉的容器——那会
    // 让严格读取抛错并被记成 smoke 自己的失败。
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

/**
 * 供反例套件复用的 scoped cleanup 入口（分阶段收集器；project/目录/tag 三者
 * 都有形状约束）。返回 residue 列表，调用方必须处理它。
 */
export const cleanupSmokeProject = async (
  project,
  secretsDirectory = null,
  {
    composeEnvironment = process.env,
    imageTag = null,
    imageId = null,
    composeArgs = [],
    danglingBaseline = null,
    overridePath = null,
    secretsIdentity = null
  } = {}
) =>
  cleanupRun({
    project,
    projectPattern: smokeProjectPattern,
    secretsDirectory,
    // 递归删除前的 inode 身份复核：路径对不代表还是本轮 mkdtemp 出来的目录。
    secretsIdentity,
    secretsPrefix: temporarySecretsPrefix,
    imageTag,
    imageId,
    // override 是**正式 cleanup 阶段**（P1-4），排在 compose down 之后并进入
    // residue 复查；未创建时传 null，cleanup 不得引用它。
    overridePath,
    composeFile,
    composeEnvironment,
    composeArgs,
    danglingBaseline,
    realpath: realpathSync
  })

export const runSmoke = async ({ keepFailure = false } = {}) => {
  const runId = randomBytes(6).toString('hex')
  const project = `meal-agent-m3b-smoke-${runId}`
  const imageTag = runImageTagFor(runId)
  const overridePath = overridePathFor(composeDirectory, runId)
  const secretsDirectory = mkdtempSync(resolve(tmpdir(), temporarySecretsPrefix))
  // 刚 mkdtemp 出来就取 inode 身份：cleanup 的递归删除必须能证明「删的还是
  // 本轮创建的那个目录」，而不是一个后来占用同名路径的替身。
  const secretsIdentity = inodeIdentityOf(secretsDirectory)
  // **第一个资源刚创建就登记现场**（P1-4）：下面还有 `await danglingVolumes()`
  // 等 Docker 查询，信号可以落在那里；此前 scene 要到 runSmoke 里才登记，那段
  // 窗口内被中断会把明文 Secret 目录留在盘上。override 此刻**尚未创建**，因此
  // 显式标成 null——cleanup 绝不能引用一个不存在的 override（引用它会让
  // `compose down` 以 "no such file" 失败并被报成 residue）。
  smokeState.registerScene?.({
    project,
    secretsDirectory,
    secretsIdentity,
    imageTag: null,
    imageId: null,
    overridePath: null,
    overrideCreated: false,
    composeEnvironment: { ...process.env, MEAL_AGENT_SECRETS_DIR: secretsDirectory },
    composeArgs: [],
    danglingBaseline: null
  })
  const stepResults = []
  let composeEnvironment = {
    ...process.env,
    MEAL_AGENT_SECRETS_DIR: secretsDirectory,
    MEAL_AGENT_API_HOST_PORT: '3000'
  }
  let preserved = false
  let chainStarted = false
  let bundleBodies = null
  let builtImageId = null
  let danglingBaseline = null

  // **第一行输出必须早于 baseline 查询**（P1-4）：它是外部套件定位
  // pre-baseline 窗口的唯一锚点。此前第一行打在 `await danglingVolumes()`
  // 之后，那个窗口在外部看来根本不可达。
  log(`smoke project: ${project}`)
  log(`per-run image tag: ${imageTag}`)
  log(`temporary secrets: ${secretsDirectory} (synthetic, generated fresh)`)

  // 唯一 tag 的 override 参与**每一次** compose 调用（含 cleanup 的 down）。
  const composeArgs = ['--file', overridePath]
  const compose = (args, options = {}) =>
    run(
      [
        'docker',
        'compose',
        '--file',
        composeFile,
        ...composeArgs,
        '--profile',
        'bootstrap',
        '--project-name',
        project,
        ...args
      ],
      { env: composeEnvironment, ...options }
    )

  /** 现场登记：signal handler 与 finally 用同一份状态跑同一套 cleanup。 */
  // 现在 baseline 也拿到了：补齐现场。imageTag 与 override 仍标成「未创建」，
  // 直到 writeImageOverride 真正落盘为止。
  const scene = {
    project,
    secretsDirectory,
    secretsIdentity,
    imageTag: null,
    overridePath,
    overrideCreated: false,
    composeEnvironment,
    composeArgs: [],
    danglingBaseline: null
  }
  smokeState.registerScene?.(scene)

  /** 一次性服务：启动 → 等 exited → 严格读取真实退出码 + StartedAt。 */
  const runOneShot = async (service, timeoutMs) => {
    // 信号在飞时**不再新建容器**：处置可能已经跑完 label sweep，此后创建的
    // 容器无人回收。
    throwIfInterrupted()
    const name = containerNameOf(project, service)
    const started = await compose(['up', '-d', '--no-deps', service], { timeoutMs: 180_000 })
    if (started.status !== 0) {
      throw new Error(`compose up ${service} failed: ${scrub(started.stderr.trim())}`)
    }
    await waitFor(
      `${service} run`,
      async () => ((await inspectStrict(name, '{{.State.Status}}')) === 'exited' ? 'exited' : null),
      timeoutMs,
      1_000
    )
    // 退出码是整条链最关键的一条证据，因此两层都必须 fail closed：
    // `inspectStrict` 拒绝「退出 0 但没打印」，`parseInspectedExitCode` 只接受
    // 规范的非负十进制整数。此前用的是 `Number(text)` + `Number.isInteger`，
    // 而 `Number('')` 是 0——一次读不到会被记成「这一步退出码为 0」。
    const exitCodeText = await inspectStrict(name, '{{.State.ExitCode}}')
    const parsedExitCode = parseInspectedExitCode(exitCodeText)
    if (!parsedExitCode.ok) {
      throw new Error(
        `${service}: refusing to read an exit code that is ${parsedExitCode.reason}`
      )
    }
    return {
      service,
      exitCode: parsedExitCode.value,
      startedAt: await inspectStrict(name, '{{.State.StartedAt}}')
    }
  }

  /** 常驻服务：启动 → 等 healthy；容器提前退出时立即失败，不空转到超时。 */
  const runService = async (service, timeoutMs) => {
    throwIfInterrupted()
    const name = containerNameOf(project, service)
    const started = await compose(['up', '-d', '--no-deps', service], { timeoutMs: 180_000 })
    if (started.status !== 0) {
      throw new Error(`compose up ${service} failed: ${scrub(started.stderr.trim())}`)
    }
    await waitFor(
      `${service} health`,
      async () => {
        if ((await inspectStrict(name, '{{.State.Status}}')) === 'exited') {
          throw new Error(
            `${service} exited before becoming healthy; ${await logExcerpt(name)}`
          )
        }
        return (await inspectStrict(name, '{{.State.Health.Status}}')) === 'healthy'
          ? 'healthy'
          : null
      },
      timeoutMs
    )
    return { service, exitCode: 0, startedAt: await inspectStrict(name, '{{.State.StartedAt}}') }
  }

  /** 证据查询：以 cluster admin 通过一次性 psql 容器执行（凭据走 PGPASSFILE）。 */
  const adminSql = async (statements, { dbname = 'meal_agent' } = {}) => {
    throwIfInterrupted()
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
    const result = await compose(args, { timeoutMs: 120_000 })
    if (result.status !== 0) {
      throw new Error(`admin evidence query failed: ${scrub(result.stderr.trim())}`)
    }
    return result.stdout
  }

  try {
    // baseline 查询放进 try 内（P1-4）：它是 fail-closed 的 dockerStrict，
    // 按设计会抛（daemon 不可达等）。放在 try 外时那一抛会绕过整个 finally，
    // 把刚建好的明文 Secret 目录留在盘上且不报任何 residue。
    danglingBaseline = await danglingVolumes()
    scene.danglingBaseline = danglingBaseline
    smokeState.registerScene?.(scene)

    // 0. Secret 生成 + 预检 + 拓扑静态门禁：全部先于任何数据库容器。
    generateAndPreflight(secretsDirectory)
    const bundleCheck = checkSecretBundle(secretsDirectory, { scanTemplates: false })
    if (bundleCheck.problems.length > 0) {
      throw new Error(
        `the freshly preflighted bundle re-read with problems: ${bundleCheck.problems.join('; ')}`
      )
    }
    bundleBodies = bundleCheck.bodies
    registerScrubValues(buildNeedles(bundleBodies).map((needle) => needle.value))
    log('secret bundle generated and preflighted (8 files, cross-consistent; output scrubber armed)')

    const gate = await run(['node', resolve(composeDirectory, 'check-compose-topology.mjs')], {
      timeoutMs: 300_000,
      cwd: repositoryRoot
    })
    if (gate.status !== 0) {
      throw new Error(`compose topology gate failed before any container:\n${scrub(gate.stderr)}`)
    }
    log('compose topology static gate PASS (before any container start, default topology)')

    const hostPort = await pickFreePort()
    composeEnvironment = { ...composeEnvironment, MEAL_AGENT_API_HOST_PORT: String(hostPort) }
    scene.composeEnvironment = composeEnvironment
    smokeState.registerScene?.(scene)
    log(`host port: ${String(hostPort)} (free on 127.0.0.1 and ::1)`)

    // 1. 写临时 override 并构建：本轮 image tag 唯一，绝不覆盖别的 worktree/
    //    project 的镜像。build 后读取 immutable image ID。
    writeImageOverride(overridePath, imageTag)
    // override 已经落盘：从这一刻起 cleanup 才可以引用它（compose 调用也才
    // 需要带 `--file <override>`）。
    scene.overrideCreated = true
    scene.imageTag = imageTag
    scene.composeArgs = composeArgs
    smokeState.registerScene?.(scene)
    const build = await compose(['build', 'api'], { timeoutMs: 1_800_000 })
    if (build.status !== 0) {
      throw new Error(`docker compose build api failed:\n${scrub(build.stderr.slice(-2000))}`)
    }
    builtImageId = await imageIdOf(imageTag, { env: composeEnvironment })
    if (builtImageId === null) {
      throw new Error(`the per-run image tag ${imageTag} does not exist after build`)
    }
    scene.imageId = builtImageId
    // signal handler 持有的是 `activeScene` 的物化快照，而不是这个局部对象本身。
    // immutable identity 一旦取得就必须立即同步过去；否则链路窗口收到信号时，
    // cleanup 只能看到 tag 却看不到本轮记录的 ID，并会按设计拒绝无所有权删除。
    smokeState.registerScene?.(scene)
    log(`api image built as ${imageTag} (image id ${builtImageId})`)

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
          throw new Error(
            `${service} exited ${String(outcome.exitCode)}; ` +
              `${await logExcerpt(containerNameOf(project, service))}`
          )
        }
      }
      stepResults.push(outcome)
    }

    // 2b. 三个 API 镜像服务的容器 `.Image` 必须逐一等于本轮 build ID。
    let imageBindingProblems = 0
    for (const service of apiImageServices) {
      const actual = await inspectStrict(containerNameOf(project, service), '{{.Image}}')
      if (actual !== builtImageId) {
        imageBindingProblems += 1
        fail(
          `image binding: ${service} container runs image ${actual}, expected the ` +
            `per-run build ${builtImageId}`
        )
      }
    }
    // 成功证据只在该组零 problem 时输出（P1-7）。
    if (imageBindingProblems === 0) {
      log(
        `image binding: bootstrap-schema/migrate/api all run the per-run image id ${builtImageId}`
      )
    }

    // 3. migrate 与 grants 重跑：同一 Compose 入口必须幂等。
    for (const service of ['migrate', 'bootstrap-grants']) {
      const before = await inspectStrict(containerNameOf(project, service), '{{.State.StartedAt}}')
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
    const expectedLedger = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => {
        const sql = readFileSync(resolve(migrationsDirectory, name), 'utf8')
        return `${name}:${createHash('sha256').update(sql).digest('hex')}`
      })
    const ledger = (
      await adminSql([
        'SELECT name || \':\' || hash FROM drizzle.__meal_agent_migrations ORDER BY name COLLATE "C"'
      ])
    )
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

    const ownerRows = (
      await adminSql([
        "SELECT 'database:' || datname || '=' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()",
        "SELECT 'schema:' || nspname || '=' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname IN ('public','drizzle','meal_agent_private') ORDER BY 1",
        "SELECT 'relation:' || n.nspname || '.' || c.relname || '=' || pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle','meal_agent_private') AND c.relkind IN ('r','p','v','m','S') ORDER BY 1",
        "SELECT 'routine:' || n.nspname || '.' || p.proname || '=' || pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','drizzle','meal_agent_private') ORDER BY 1"
      ])
    )
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

    const rlsRows = (
      await adminSql([
        "SELECT n.nspname || '.' || c.relname || '=' || c.relrowsecurity || ':' || c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle','meal_agent_private') AND c.relkind IN ('r','p') ORDER BY 1"
      ])
    )
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

    const roleRows = (
      await adminSql([
        "SELECT rolname || '=' || rolsuper || ':' || rolbypassrls || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolinherit || ':' || rolcanlogin FROM pg_roles WHERE rolname LIKE 'meal_agent%' ORDER BY 1"
      ])
    )
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

    const runtimeProbe = await compose(
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
          'printf "postgres:5432:meal_agent:meal_agent_runtime_login:%s\\n" "$(< /run/secrets/meal_agent_runtime_password/value)" > /tmp/runtime.pgpass',
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
    if (runtimeProbe.status !== 0) {
      fail(
        `runtime privilege probe: the probe container exited ${String(runtimeProbe.status)}; ` +
          'its output cannot be treated as evidence'
      )
    }
    const probeOut = runtimeProbe.stdout
    const probeLines = probeOut.split('\n').map((line) => line.trim()).filter(Boolean)
    const probeExpectations = [
      ['whoami=meal_agent_runtime_login', 'runtime login connects as itself'],
      ['create-table-exit=1', 'runtime login cannot CREATE TABLE'],
      ['set-role-migrator-exit=1', 'runtime login cannot SET ROLE meal_agent_migrator'],
      ['app-ledger-read-exit=0', 'SET ROLE meal_agent_app can read the migration ledger']
    ]
    for (const [needle, meaning] of probeExpectations) {
      if (!probeLines.includes(needle)) {
        fail(`runtime privilege probe: expected "${needle}" (${meaning})`)
      }
    }
    // 成功证据只在**命令 exit 0 且该组一条 problem 都没有**时才输出（P1-7）。
    if (
      runtimeProbe.status === 0 &&
      probeExpectations.every(([needle]) => probeLines.includes(needle))
    ) {
      log('runtime least privilege: no DDL, no migrator role, app-role ledger read works')
    }

    await fetch(`http://127.0.0.1:${String(hostPort)}/readyz`, {
      signal: AbortSignal.timeout(10_000)
    })
    const activity = (
      await adminSql([
        "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = 'meal_agent' ORDER BY 1"
      ])
    )
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
    if (activity.includes('meal_agent_runtime_login') && unexpectedIdentities.length === 0) {
      log(
        'readiness identity: api connects as meal_agent_runtime_login only ' +
          '(admin observer connection excepted)'
      )
    }

    // 5g. 逐服务 secret 可见面：严格 inspect（无默认值）、service 必须是
    // expectedSecretMounts 的**自有键**、Mounts 结构逐项验证、source/target/
    // 只读标志与**集合**全等比较。
    const containerIds = await listByProject('container', project, { env: composeEnvironment })
    let secretVisibilityProblems = 0
    const failVisibility = (message) => {
      secretVisibilityProblems += 1
      fail(message)
    }
    if (containerIds.length === 0) {
      failVisibility('secret visibility: no project containers were found to check')
    }
    if (containerIds.length !== expectedVisibilityServiceLabels.length) {
      failVisibility(
        `secret visibility: expected exactly ` +
          `${String(expectedVisibilityServiceLabels.length)} evidence containers, ` +
          `got ${String(containerIds.length)}`
      )
    }
    const observedServices = []
    for (const id of containerIds) {
      // 这一处**显式**接受空串：下面紧接着就有一条具名判定（「没有 compose
      // service label」），比抛一个通用读取错误更有信息量。
      const service = await inspectStrict(
        id,
        '{{index .Config.Labels "com.docker.compose.service"}}',
        { allowEmpty: true }
      )
      if (service === '' || service === '<no value>') {
        failVisibility(`secret visibility: a project container carries no compose service label (${id})`)
        continue
      }
      if (!Object.hasOwn(expectedSecretMounts, service)) {
        failVisibility(`secret visibility: unknown compose service ${service} in this project`)
        continue
      }
      observedServices.push(service)
      const mounts = await inspectJsonStrict(id, '{{json .Mounts}}')
      if (!Array.isArray(mounts)) {
        failVisibility(`secret visibility: ${service} Mounts is not an array`)
        continue
      }
      // **全部** mount 都要看，不只是 /run/secrets/ 前缀内的：把整个 bundle
      // 目录挂到别处、或把某份 Secret 挂到 /tmp，前缀过滤都看不见。
      const observed = []
      for (const mount of mounts) {
        if (typeof mount !== 'object' || mount === null) {
          failVisibility(`secret visibility: ${service} has a malformed mount entry`)
          continue
        }
        const destination = String(mount.Destination ?? '')
        const source = String(mount.Source ?? '')
        // 允许的非 secret 挂载：M2A 的只读 bootstrap 资产、handoff 的那一个
        // 冻结 0000 文件、以及数据库 named volume。其余一律进入比较集合。
        const isRepositoryAsset =
          destination === '/opt/meal-agent/bootstrap' ||
          destination === '/services/api/migrations/0000_stage_06.sql'
        const isDatabaseVolume =
          destination === '/var/lib/postgresql' && String(mount.Type ?? '') === 'volume'
        if (isRepositoryAsset || isDatabaseVolume) {
          continue
        }
        observed.push({
          type: String(mount.Type ?? ''),
          target: destination,
          // bind 比对全路径；named volume 比对 Docker inspect 里的
          // 精确 project-scoped Name，不依赖 daemon 内部 `_data` 路径。
          source: String(mount.Type ?? '') === 'volume' ? String(mount.Name ?? '') : source,
          readOnly: mount.RW === false
        })
      }
      const expected = expectedSecretMounts[service]
        .map((mount) => ({
          type: mount.type,
          target: mount.target,
          source:
            mount.type === 'volume'
              ? `${project}_${mount.name}`
              : resolve(secretsDirectory, mount.filename),
          readOnly: mount.readOnly
        }))
        .sort((a, b) => a.target.localeCompare(b.target))
      observed.sort((a, b) => a.target.localeCompare(b.target))
      if (JSON.stringify(observed) !== JSON.stringify(expected)) {
        failVisibility(
          `secret visibility: ${service} mounts ${JSON.stringify(observed)}, ` +
            `expected exactly ${JSON.stringify(expected)}`
        )
      }
      // tmpfs 不出现在 .Mounts 里：单独读 HostConfig.Tmpfs，任何挂到
      // /run/secrets 下的 tmpfs 都必须被发现。
      // `{{json .HostConfig.Tmpfs}}` 在「没有 tmpfs」时打印字面量 `null`，那是
      // 一条**合法的阴性证据**；而**空 stdout** 是读不到，inspectJsonStrict 现在
      // 会为此抛错，不再把它折叠成同一个 null。
      const tmpfs = await inspectJsonStrict(id, '{{json .HostConfig.Tmpfs}}')
      if (tmpfs !== null && (typeof tmpfs !== 'object' || Array.isArray(tmpfs))) {
        failVisibility(`secret visibility: ${service} HostConfig.Tmpfs is not an object`)
        continue
      }
      const tmpfsTargets = tmpfs === null ? [] : Object.keys(tmpfs)
      const secretTmpfs = tmpfsTargets.filter((target) => target.startsWith('/run/secrets'))
      if (secretTmpfs.length > 0) {
        failVisibility(
          `secret visibility: ${service} mounts a tmpfs under /run/secrets ` +
            `(${secretTmpfs.join(', ')})`
        )
      }
    }
    observedServices.sort()
    if (
      JSON.stringify(observedServices) !==
      JSON.stringify(expectedVisibilityServiceLabels)
    ) {
      failVisibility(
        `secret visibility: compose service labels drifted: got ` +
          `[${observedServices.join(', ')}], expected ` +
          `[${expectedVisibilityServiceLabels.join(', ')}]`
      )
    }
    if (secretVisibilityProblems === 0) {
      log(
        `secret visibility: ${String(containerIds.length)} project containers each mount ` +
          'exactly their declared secret set (full source path, target, type and ' +
          'read-only all checked; every non-asset mount and any /run/secrets tmpfs ' +
          'is in scope)'
      )
    }

    // 6. Secret containment 扫描与动态网络隔离（api 仍在运行时取证）。
    await runContainmentAndIsolation({
      project,
      hostPort,
      bodies: bundleBodies,
      composeFile,
      composeArgs,
      composeEnvironment,
      transcript,
      log,
      fail,
      run
    })

    return { project, imageTag, builtImageId, hostPort, stepResults }
  } catch (error) {
    if (error instanceof SmokeInterrupted || terminationSignal() !== null) {
      // 被信号打断不是失败：处置拥有 cleanup 与退出语义，这里只留一行说明。
      log(`interrupted by ${terminationSignal() ?? 'a signal'}; the signal handler owns the cleanup`)
    } else {
      fail(error instanceof Error ? error.message : String(error))
    }
    return { project, imageTag, builtImageId, hostPort: null, stepResults }
  } finally {
    // override 在 cleanup **之后**删除：`compose down` 仍要用它解析配置。
    if (terminationSignal() !== null) {
      // 信号处置拥有 cleanup **与 override 的删除**：主流程既不重复 cleanup，
      // 也**不能**在这里删 override——handler 的 `compose down` 还要用它解析
      // 配置（实测：主流程先删会让 down 以 "no such file or directory" 失败
      // 并被报成 residue）。
      log('signal in flight: the scoped cleanup is owned by the signal handler')
    } else if (failures.length > 0 && keepFailure && chainStarted) {
      preserved = true
      log(
        `--keep-failure: preserving project ${project}, image tag ${imageTag} and ` +
          `secrets directory ${secretsDirectory} for inspection`
      )
      log(
        'WARNING: the preserved secrets directory contains real synthetic ' +
          'credentials for the preserved database; delete it after inspection'
      )
    } else {
      let residue = []
      try {
        residue = await cleanupSmokeProject(project, secretsDirectory, {
          composeEnvironment,
          secretsIdentity,
          imageTag: scene.imageTag,
          imageId: scene.imageId,
          composeArgs: scene.overrideCreated ? composeArgs : [],
          overridePath: scene.overrideCreated ? overridePath : null,
          danglingBaseline
        })
      } catch (error) {
        residue = [`cleanup-error: ${error instanceof Error ? error.message : String(error)}`]
      }
      // cleanup 之后**独立复查**六类。
      try {
        residue.push(
          ...(await verifyNoResidue({
            project,
            imageTag: scene.imageTag,
            secretsDirectory,
            overridePath: scene.overrideCreated ? overridePath : null,
            danglingBaseline,
            composeEnvironment,
            exists: existsSync
          }))
        )
      } catch (error) {
        residue.push(
          `residue recheck failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (residue.length > 0) {
        fail(`cleanup residue: ${residue.join(', ')}`)
      } else {
        log(
          'cleanup: container, network, named volume, anonymous dangling volume, ' +
            'per-run image tag and temporary secrets all verified absent'
        )
      }
    }


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
    // **信号路径绝不输出 PASS**：被中断的运行没有跑完全部证据，即使
    // `failures` 为空也不能声称通过（被打断不记为 failure，正是为了不把
    // 「被要求停下」写成 smoke 的缺陷）。
    const interrupted = terminationSignal()
    if (interrupted !== null) {
      log(`local-test smoke INTERRUPTED by ${interrupted}; no PASS is claimed`)
    } else if (failures.length > 0) {
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

  // 信号：终止受控子树 → 与正常/失败路径**同一套** scoped cleanup → 复查
  // residue（必被打印）→ 按原信号语义退出。
  const activeScene = {
    project: null,
    secretsDirectory: null,
    secretsIdentity: null,
    imageTag: null,
    imageId: null,
    overridePath: null,
    overrideCreated: false,
    composeEnvironment: process.env,
    composeArgs: [],
    danglingBaseline: null
  }
  smokeState.registerScene = (partial) => Object.assign(activeScene, partial)
  installSignalHandlers(
    async () => {
      const residue = []
      if (activeScene.project === null) {
        return residue
      }
      try {
        residue.push(
          ...(await cleanupSmokeProject(activeScene.project, activeScene.secretsDirectory, {
            composeEnvironment: activeScene.composeEnvironment,
            secretsIdentity: activeScene.secretsIdentity,
            imageTag: activeScene.imageTag,
            imageId: activeScene.imageId,
            composeArgs: activeScene.overrideCreated ? activeScene.composeArgs : [],
            overridePath: activeScene.overrideCreated ? activeScene.overridePath : null,
            danglingBaseline: activeScene.danglingBaseline
          }))
        )
      } catch (error) {
        residue.push(`cleanup-error: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        residue.push(
          ...(await verifyNoResidue({
            project: activeScene.project,
            imageTag: activeScene.imageTag,
            secretsDirectory: activeScene.secretsDirectory,
            overridePath: activeScene.overrideCreated ? activeScene.overridePath : null,
            danglingBaseline: activeScene.danglingBaseline,
            composeEnvironment: activeScene.composeEnvironment,
            exists: existsSync
          }))
        )
      } catch (error) {
        residue.push(`residue recheck failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return residue
    },
    { label: 'smoke scoped cleanup' }
  )

  await runSmoke({ keepFailure })
  // 信号在飞时不自己退出：处置会跑完 scoped cleanup 再按原信号语义收场。
  if (terminationSignal() === null) {
    process.exit(failures.length > 0 ? 1 : 0)
  }
}
