#!/usr/bin/env node
// 阶段 09A / M3B：Secret 生成/预检、containment 扫描器与 cleanup 范围的反向测试。
//
//   node infra/docker/check-local-test-negatives.mjs
//
// 每个反例都必须**以指定理由**失败——只要求「失败了」不够，一条无关报错也能让
// 套件变绿。三条通用断言贯穿全部反例：
//
//   1. 拒绝发生在任何数据库容器启动或数据库 mutation 之前（预检类反例根本不
//      触碰 Docker；套件结束时按 label 断言没有本套件的容器残留）；
//   2. 失败消息不包含任何 Secret 取值（逐条与本例 bundle 的全部敏感值比对）；
//   3. 不留下部分 bundle 或本套件之外的 Docker 资源。
//
// Compose 变异类反例沿用 check-compose-topology-mutations.mjs 的机制：要求
// tracked 文件干净、临时改写、立即还原、结束逐字节复核。
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  linkSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  generateAndPreflight,
  generateSecretBundle
} from './generate-local-test-secrets.mjs'
import {
  buildNeedles,
  collectDockerArtifactsForProject,
  scanArtifactsForNeedles
} from './local-test-containment.mjs'
import {
  checkSecretBundle,
  generatePassword,
  renderDatabaseUrl,
  repositoryRoot,
  scanTrackedTemplates,
  secretFilenames
} from './local-test-secrets-contract.mjs'
import { cleanupSmokeProject } from './run-local-test-smoke.mjs'
import {
  imageIdOf,
  inodeIdentityOf,
  isAbsenceMessage,
  overridePathFor,
  runImageTagFor,
  writeImageOverride
} from './m3b-docker.mjs'
import { createSecretScrubber, wrongReason } from './m3b-safe-output.mjs'
import {
  ownershipAwareSpawnStdio,
  runCommand,
  terminateControlledSubtree
} from './m3b-subprocess.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')
const topologyChecker = resolve(composeDirectory, 'check-compose-topology.mjs')
const templateFile = resolve(
  repositoryRoot,
  'infra/environments/local-test/local-test.env.example'
)

const failures = []
/** 本套件用过的 docker project 名，收尾时逐个断言零残留。 */
const usedNegativeProjects = []
let caught = 0
const pass = (name, reason) => {
  caught += 1
  process.stdout.write(`  caught: ${name} (${reason})\n`)
}
const fail = (name, detail) => {
  failures.push(`${name}: ${detail}`)
}

// 异步 spawn（自成进程组、有超时）：与其余三个 M3B CLI 同一套子进程基础设施。
const run = (args, options = {}) => runCommand(args, { timeoutMs: 300_000, ...options })

/**
 * 本套件自己的输出边界。反例断言的文本几乎全部来自不可信来源（problems、
 * residue、子进程 stdout/stderr、目录条目名），因此：
 *
 *   - 「抓到了但理由不对」一律走 `wrongReason`：**只输出固定类别与计数**；
 *   - 其余要落地的外来文本先过 `scrubUntrusted`（按取值 + 按形状）。
 */
const scrubber = createSecretScrubber()
const safe = (text) => scrubber.scrubUntrusted(text)

/**
 * 一条命令必须成功；不成功就记一条失败并返回 null。**空 stdout 绝不当成
 * 「什么都没有」**——那正是「列举失败」与「确实为空」被混为一谈的地方。
 */
const runStrict = async (name, args, what) => {
  const result = await run(args)
  if (result.status !== 0) {
    fail(
      name,
      `${what} could not be read: ${args[0]} ${args[1] ?? ''} exited ${
        result.status === null ? `on signal ${String(result.signal)}` : String(result.status)
      }`
    )
    return null
  }
  return result
}

/**
 * 一个容器**是否存在**的 fail-closed 判据。
 *
 * 非零退出**不等于**「不存在」：daemon 不可达、CLI 出错、被信号杀掉
 * （status === null）、超时——每一种都会给出非零。只有「退出码恰好 1 且 stderr
 * 是锚定的 no such object」才判为 absent，其余一律 unknown（调用方按失败处理）。
 */
const containerPresence = async (containerName, env = process.env) => {
  const result = await run(['docker', 'inspect', '--format', '{{.Id}}', containerName], { env })
  if (result.status === 0 && result.stdout.trim() !== '') {
    return 'present'
  }
  // 与 m3b-docker.mjs 的 `imageIdOf` 走**同一个** `isAbsenceMessage`：对整串
  // `stderr.trim()` 做锚定匹配、不带 `m` 标志。前缀、后缀、多行包装、以及一条
  // 关于**别的对象**的错误，全都不算「不存在」。
  if (result.status === 1 && isAbsenceMessage(result.stderr, {
    kind: 'object',
    name: containerName
  })) {
    return 'absent'
  }
  return 'unknown'
}

/**
 * 按 project label 列举一类资源，**读得到与读不到分开返回**。
 *
 * `docker ps` / `network ls` / `volume ls` 任一非零都会给出空 stdout；直接读它
 * 就等于宣布「没有残留」。收尾的零残留结论与下面的 fail-closed 反例共用这一个
 * 判据，因此那条结论是被反例真实覆盖的，而不是一段没人验证过的内联逻辑。
 */
const residueListingFor = async (kind, project, env = process.env) => {
  const listArgs =
    kind === 'container'
      ? ['docker', 'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]
      : kind === 'network'
        ? ['docker', 'network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]
        : ['docker', 'volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]
  const result = await run(listArgs, { env })
  if (result.status !== 0) {
    return {
      readable: false,
      ids: [],
      detail:
        result.status === null ? `signal ${String(result.signal)}` : `exit ${String(result.status)}`
    }
  }
  return { readable: true, ids: result.stdout.split('\n').filter(Boolean), detail: 'exit 0' }
}

/** 删除必须成功；失败要被报出来，不能让 finally 静默吞掉。 */
const removeOrReport = async (label, args) => {
  const result = await run(args)
  if (result.status !== 0 && !/no such (object|container)/i.test(result.stderr)) {
    fail(
      'suite cleanup',
      `${label}: ${args.slice(0, 3).join(' ')} exited ${
        result.status === null ? `on signal ${String(result.signal)}` : String(result.status)
      }`
    )
  }
}

// ---------------------------------------------------------------------------
// Group A：预检反例（不触碰 Docker）
// ---------------------------------------------------------------------------

/**
 * 读取一个 bundle 的全部敏感值——与 containment 扫描器**同一个** buildNeedles
 * （口令、16 字符前缀、URL、pgpass 行与各自的 URL 编码形态）。只在内存中，
 * 绝不输出。
 */
const sensitiveValuesOf = (directory) => {
  const bodies = new Map()
  for (const filename of secretFilenames) {
    let content
    try {
      content = readFileSync(resolve(directory, filename), 'utf8')
    } catch {
      continue
    }
    bodies.set(filename, content.endsWith('\n') ? content.slice(0, -1) : content)
  }
  return buildNeedles(bodies).map((needle) => needle.value)
}

/**
 * 通用预检反例：建一套新 bundle →（**先**采集敏感值再）mutate →
 * checkSecretBundle 必须给出指定理由，且所有消息不含任何敏感值。
 * 值在 mutate 之前采集：被删除/被改写文件的原值同样不允许出现在消息里。
 */
const preflightNegative = (name, expected, mutate, options = {}) => {
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  const directory = resolve(parent, 'bundle')
  try {
    generateSecretBundle(directory)
    const values = sensitiveValuesOf(directory)
    // mutate 可以返回 additionalSensitiveValues：变异**引入**的取值（例如被
    // 当作文件名的口令）同样不允许出现在任何失败消息里。
    const { additionalSensitiveValues = [], ...checkOverrides } = mutate(directory, parent) ?? {}
    values.push(...additionalSensitiveValues)
    const checkOptions = { scanTemplates: false, ...checkOverrides }
    const { problems } = checkSecretBundle(directory, checkOptions)
    if (problems.length === 0) {
      fail(name, 'NOT CAUGHT — the preflight still passed')
      return
    }
    if (!problems.some((problem) => expected.test(problem))) {
      // **固定类别**：problems 可能内嵌被变异注入的取值、目录条目名或 git 输出，
      // 一律不回显（此前这里整份 dump，而且 `return` 还跳过了下面的泄漏检查）。
      fail(name, wrongReason(expected, problems))
      return
    }
    const leaking = problems.filter((problem) =>
      values.some((value) => problem.includes(value))
    )
    if (leaking.length > 0) {
      fail(name, 'a failure message contains a secret value (not reprinted here)')
      return
    }
    pass(name, String(expected))
  } finally {
    // 变异可能把目录权限改成不可写（0500 等），先恢复再删，否则临时 bundle
    // 会留在 tmpdir 里。
    try {
      chmodSync(directory, 0o700)
    } catch {
      // 目录可能已经不存在。
    }
    rmSync(parent, { recursive: true, force: true })
  }
}

const rewriteSecret = (directory, filename, body) => {
  const path = resolve(directory, filename)
  unlinkSync(path)
  writeFileSync(path, `${body}\n`, { mode: 0o600 })
}

const readBody = (directory, filename) => {
  const text = readFileSync(resolve(directory, filename), 'utf8')
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

process.stdout.write('Group A: secret preflight negatives\n')

{
  // **正向基线**（一条 case，三项断言同时成立）。没有它，「所有 bundle 一律
  // 判失败」的回归会让下面每一条反例都恒绿（审计实测：把 0700 判据改成拒绝
  // 一切正确目录，33 条反例全部照常通过）。三项缺一不可：
  //
  //   1. 刚生成的干净 bundle 预检零问题——挡住 bundle 判据的全盘拒绝回归；
  //   2. **当前真实 tracked 模板**扫描零问题——挡住模板判据的全盘拒绝回归
  //      （第三轮收紧了 userinfo 与 credential 查询参数判据，如果新判据误伤
  //      真实模板，这一项立刻红；只跑临时仓库里的变异副本看不出来）；
  //   3. Git index 与工作树**内容一致**时不得报出任何差异——挡住「index 扫描
  //      恒报不一致」这种把两层扫描变成噪声的回归。
  const name =
    'the positive baseline holds: clean bundle, real tracked templates, index/worktree parity'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  const directory = resolve(parent, 'bundle')
  try {
    generateSecretBundle(directory)
    const bundleProblems = checkSecretBundle(directory, { scanTemplates: false }).problems
    let templateProblems = null
    let templateError = null
    try {
      // 真实仓库、真实 tracked 模板：不复制、不变异、不写入。
      templateProblems = scanTrackedTemplates(repositoryRoot)
    } catch (error) {
      templateError = error instanceof Error ? error.message : String(error)
    }
    // index/worktree parity：逐个 tracked 模板比对 `git show :<path>` 与工作树
    // 字节。两者相等时扫描器只扫一遍；不等就说明工作区有未暂存改动，基线
    // 无法断言「当前 index 是干净的」。
    const parityMismatches = []
    const listed = spawnSync('git', ['ls-files', '-z', '--', 'infra/environments'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    })
    if (listed.error !== undefined || listed.status !== 0) {
      parityMismatches.push('the tracked template listing could not be read')
    } else {
      const files = listed.stdout.split('\u0000').filter(Boolean)
      if (files.length === 0) {
        parityMismatches.push('the tracked template listing was empty')
      }
      for (const file of files) {
        const blob = spawnSync('git', ['show', `:${file}`], {
          cwd: repositoryRoot,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024
        })
        if (blob.error !== undefined || blob.status !== 0) {
          parityMismatches.push(`${file}: the git index blob could not be read`)
          continue
        }
        let worktree = null
        try {
          worktree = readFileSync(resolve(repositoryRoot, file), 'utf8')
        } catch {
          parityMismatches.push(`${file}: the worktree copy could not be read`)
          continue
        }
        if (blob.stdout !== worktree) {
          parityMismatches.push(`${file}: the git index blob and the worktree copy differ`)
        }
      }
    }
    if (bundleProblems.length > 0) {
      fail(name, wrongReason('zero problems on a pristine bundle', bundleProblems))
    } else if (templateError !== null) {
      fail(name, `the tracked template scan threw on the real repository: ${safe(templateError)}`)
    } else if (templateProblems.length > 0) {
      fail(name, wrongReason('zero problems on the real tracked templates', templateProblems))
    } else if (parityMismatches.length > 0) {
      fail(name, `git index/worktree parity: ${parityMismatches.join('; ')}`)
    } else {
      pass(
        name,
        'pristine bundle, real tracked templates and index/worktree parity all clean ' +
          '(guards against blanket rejection in either scanner)'
      )
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

preflightNegative(
  'wrong URL user (meal_agent_migration without _login)',
  /the connection URL user must be meal_agent_migration_login/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_migration_password')
    rewriteSecret(
      directory,
      'meal_agent_migration_database_url',
      renderDatabaseUrl('meal_agent_migration', password)
    )
  }
)

preflightNegative(
  'wrong URL host',
  /the connection URL host must be postgres/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_runtime_password')
    rewriteSecret(
      directory,
      'meal_agent_runtime_database_url',
      `postgresql://meal_agent_runtime_login:${password}@evil-host:5432/meal_agent`
    )
  }
)

preflightNegative(
  'wrong URL port',
  /the connection URL port must be 5432/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_runtime_password')
    rewriteSecret(
      directory,
      'meal_agent_runtime_database_url',
      `postgresql://meal_agent_runtime_login:${password}@postgres:5433/meal_agent`
    )
  }
)

preflightNegative(
  'wrong URL database',
  /the connection URL database must be exactly \/meal_agent/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_runtime_password')
    rewriteSecret(
      directory,
      'meal_agent_runtime_database_url',
      `postgresql://meal_agent_runtime_login:${password}@postgres:5432/meal_agent_evil`
    )
  }
)

preflightNegative(
  'URL query string smuggled in',
  /meal_agent_runtime_database_url: the connection URL must not carry a query string/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_runtime_password')
    rewriteSecret(
      directory,
      'meal_agent_runtime_database_url',
      `postgresql://meal_agent_runtime_login:${password}@postgres:5432/meal_agent?host=/tmp`
    )
  }
)

preflightNegative(
  'URL password does not match the password file',
  /the connection URL password does not match the superuser password file/,
  (directory) => {
    // 注入的新口令与新 URL 同样不允许出现在失败消息里。
    const injected = generatePassword()
    const url = renderDatabaseUrl('postgres', injected)
    rewriteSecret(directory, 'meal_agent_admin_database_url', url)
    return { additionalSensitiveValues: [injected, url] }
  }
)

preflightNegative(
  'pgpass password does not match the superuser password file',
  /endpoint line 2 password does not match the superuser password file/,
  (directory) => {
    const superuser = readBody(directory, 'postgres_superuser_password')
    const injected = generatePassword()
    rewriteSecret(
      directory,
      'postgres_admin.pgpass',
      `postgres:5432:postgres:postgres:${superuser}\n` +
        `postgres:5432:meal_agent:postgres:${injected}`
    )
    return { additionalSensitiveValues: [injected] }
  }
)

preflightNegative(
  'pgpass carries a third endpoint',
  /postgres_admin\.pgpass: must contain exactly 2 endpoint lines/,
  (directory) => {
    const superuser = readBody(directory, 'postgres_superuser_password')
    rewriteSecret(
      directory,
      'postgres_admin.pgpass',
      `postgres:5432:postgres:postgres:${superuser}\n` +
        `postgres:5432:meal_agent:postgres:${superuser}\n` +
        `postgres:5432:template1:postgres:${superuser}`
    )
  }
)

preflightNegative(
  'pgpass uses a wildcard database rule',
  /postgres_admin\.pgpass: endpoint line 2 must not use wildcard rules/,
  (directory) => {
    const superuser = readBody(directory, 'postgres_superuser_password')
    rewriteSecret(
      directory,
      'postgres_admin.pgpass',
      `postgres:5432:postgres:postgres:${superuser}\n` +
        `postgres:5432:*:postgres:${superuser}`
    )
  }
)

preflightNegative(
  'a secret file is missing',
  /meal_agent_backup_password: missing from the bundle directory/,
  (directory) => {
    unlinkSync(resolve(directory, 'meal_agent_backup_password'))
  }
)

preflightNegative(
  'an unknown file appears in the bundle',
  /the bundle directory contains 1 unknown entry.*not echoed/,
  (directory) => {
    writeFileSync(resolve(directory, 'stray.txt'), 'not a secret\n', { mode: 0o600 })
  }
)

preflightNegative(
  'weak permissions (0644)',
  /postgres_superuser_password: has mode 0644; only owner-only 0400 or 0600 is accepted/,
  (directory) => {
    chmodSync(resolve(directory, 'postgres_superuser_password'), 0o644)
  }
)

preflightNegative(
  'wrong owner uid (via the expectedOwnerUid seam)',
  /postgres_superuser_password: is owned by uid \d+ but the expected owner is uid/,
  () => ({ expectedOwnerUid: process.geteuid() + 12_345 })
)

preflightNegative(
  'a secret file is a symlink',
  /meal_agent_runtime_password: is a symbolic link/,
  (directory, parent) => {
    const original = resolve(directory, 'meal_agent_runtime_password')
    const aside = resolve(parent, 'aside-runtime-password')
    renameSync(original, aside)
    symlinkSync(aside, original)
  }
)

preflightNegative(
  'a secret file has a second hard link',
  /meal_agent_migration_password: has 2 hard links/,
  (directory, parent) => {
    linkSync(
      resolve(directory, 'meal_agent_migration_password'),
      resolve(parent, 'hardlink-copy')
    )
  }
)

// —— 内容卫生与口令字母表（审计补充：这些判据此前没有回归保护）——

preflightNegative(
  'a secret file is empty',
  /postgres_superuser_password: is empty/,
  (directory) => {
    const path = resolve(directory, 'postgres_superuser_password')
    unlinkSync(path)
    writeFileSync(path, '', { mode: 0o600 })
  }
)

preflightNegative(
  'a secret file exceeds the 4096-byte limit',
  /the limit is 4096/,
  (directory) => {
    rewriteSecret(directory, 'meal_agent_backup_password', 'A'.repeat(5000))
  }
)

preflightNegative(
  'a password file contains a second line',
  /meal_agent_runtime_password: must contain a single line/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_runtime_password')
    rewriteSecret(directory, 'meal_agent_runtime_password', `${password}\n${password}`)
  }
)

preflightNegative(
  'a secret file contains a carriage return',
  /meal_agent_runtime_password: contains a carriage return/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_runtime_password')
    rewriteSecret(directory, 'meal_agent_runtime_password', `${password}\r`)
  }
)

preflightNegative(
  'a secret file contains a NUL byte',
  /meal_agent_runtime_password: contains a NUL byte/,
  (directory) => {
    const path = resolve(directory, 'meal_agent_runtime_password')
    unlinkSync(path)
    writeFileSync(path, Buffer.from('abc\u0000def\n', 'utf8'), { mode: 0o600 })
  }
)

preflightNegative(
  'a secret file contains a byte order mark',
  /meal_agent_runtime_password: contains a byte order mark/,
  (directory) => {
    const path = resolve(directory, 'meal_agent_runtime_password')
    unlinkSync(path)
    writeFileSync(path, Buffer.from('\uFEFFabcdef\n', 'utf8'), { mode: 0o600 })
  }
)

preflightNegative(
  'a secret file is not valid UTF-8',
  /meal_agent_runtime_password: is not valid UTF-8/,
  (directory) => {
    const path = resolve(directory, 'meal_agent_runtime_password')
    unlinkSync(path)
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x41, 0x0a]), { mode: 0o600 })
  }
)

preflightNegative(
  'a secret file is a FIFO',
  /meal_agent_runtime_password: is not a regular file/,
  (directory) => {
    const path = resolve(directory, 'meal_agent_runtime_password')
    unlinkSync(path)
    // 同步创建 FIFO：mutate 回调是同步的，这里不能起异步子进程。
    const made = spawnSync('mkfifo', ['-m', '600', path], { encoding: 'utf8' })
    if (made.error !== undefined || made.status !== 0) {
      throw new Error(`mkfifo failed: ${made.error?.message ?? made.stderr}`)
    }
  }
)

preflightNegative(
  'a password uses characters outside the URL/pgpass-safe alphabet',
  /meal_agent_runtime_password: the password must use only \[A-Za-z0-9\]/,
  (directory) => {
    rewriteSecret(
      directory,
      'meal_agent_runtime_password',
      'AAAAAAAA:BBBBBBBB\\CCCCCCCC@DDDDDDDD'
    )
  }
)

preflightNegative(
  'a password is not exactly 48 characters',
  /meal_agent_runtime_password: the password must be exactly 48 characters/,
  (directory) => {
    rewriteSecret(directory, 'meal_agent_runtime_password', 'Abc123')
  }
)

// 「Secret 本身被当成文件名」：未知条目的名字绝不能被回显出来。
preflightNegative(
  'a secret value used as an unknown file name is never echoed',
  /the bundle directory contains 1 unknown entry.*not echoed/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_runtime_password')
    writeFileSync(resolve(directory, password), '', { mode: 0o600 })
    return { additionalSensitiveValues: [password] }
  }
)

for (const mode of [0o500, 0o600, 0o1700]) {
  preflightNegative(
    `the bundle directory mode ${mode.toString(8).padStart(4, '0')} is rejected (only exactly 0700)`,
    /the bundle directory mode must be exactly 0700/,
    (directory) => {
      chmodSync(directory, mode)
    }
  )
}

preflightNegative(
  'two raw passwords are identical',
  /the backup password is identical to the migration password/,
  (directory) => {
    rewriteSecret(
      directory,
      'meal_agent_backup_password',
      readBody(directory, 'meal_agent_migration_password')
    )
  }
)

preflightNegative(
  'a connection URL carries a fragment',
  /meal_agent_runtime_database_url: the connection URL must not carry a fragment/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_runtime_password')
    rewriteSecret(
      directory,
      'meal_agent_runtime_database_url',
      `postgresql://meal_agent_runtime_login:${password}@postgres:5432/meal_agent#frag`
    )
  }
)

// WHATWG URL parser 会剥离口令里的 tab，因此**全部字段级判据都会通过**
// （url.password 与口令文件逐字节相等）——这一条只有 canonical 全等兜底能抓。
// 它是 canonical 那一行的专属回归。
preflightNegative(
  'a tab smuggled into the URL password survives every field check',
  /meal_agent_runtime_database_url: the connection URL is not byte-identical to the canonical/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_runtime_password')
    const smuggled = `${password.slice(0, 10)}\t${password.slice(10)}`
    rewriteSecret(
      directory,
      'meal_agent_runtime_database_url',
      `postgresql://meal_agent_runtime_login:${smuggled}@postgres:5432/meal_agent`
    )
    return { additionalSensitiveValues: [smuggled] }
  }
)

preflightNegative(
  'a Unix socket path smuggled as the URL host',
  /meal_agent_runtime_database_url: the connection URL host must be postgres/,
  (directory) => {
    const password = readBody(directory, 'meal_agent_runtime_password')
    rewriteSecret(
      directory,
      'meal_agent_runtime_database_url',
      `postgresql://meal_agent_runtime_login:${password}@%2Ftmp:5432/meal_agent`
    )
  }
)

// tracked Secret：临时 git 仓库里把一份 secret staged 进索引。
{
  const name = 'a secret file is tracked by git'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  try {
    const repo = resolve(parent, 'repo')
    spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' })
    const directory = resolve(repo, 'secrets')
    generateSecretBundle(directory)
    spawnSync('git', ['-C', repo, 'add', '--', 'secrets/postgres_superuser_password'], { encoding: 'utf8' })
    const values = sensitiveValuesOf(directory)
    const { problems } = checkSecretBundle(directory, { scanTemplates: false })
    if (!problems.some((problem) => /postgres_superuser_password: is tracked by git/.test(problem))) {
      fail(name, wrongReason('/postgres_superuser_password: is tracked by git/', problems))
    } else if (problems.some((problem) => values.some((value) => problem.includes(value)))) {
      fail(name, 'a failure message contains a secret value (not reprinted here)')
    } else {
      pass(name, '/is tracked by git/')
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

// tracked 模板反例：**绝不变异真实 tracked 文件**。做法是把真实模板复制进一个
// 临时 git 仓库（同样的 infra/environments/local-test/ 路径），在副本上变异并
// 提交/暂存，再用同一个 scanTrackedTemplates 扫那个仓库。因此本套件对工作树的
// 副作用恒为零，也不需要「还原窗口」。
const templateNegative = (name, mutate, expected, { stageOnly = false } = {}) => {
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-repo-'))
  try {
    const repo = resolve(parent, 'repo')
    const templateDirectory = resolve(repo, 'infra/environments/local-test')
    mkdirSync(templateDirectory, { recursive: true })
    for (const args of [
      ['init', '--quiet', repo],
      ['-C', repo, 'config', 'user.email', 'negatives@example.invalid'],
      ['-C', repo, 'config', 'user.name', 'M3B negatives']
    ]) {
      const result = spawnSync('git', args, { encoding: 'utf8' })
      if (result.error !== undefined || result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed`)
      }
    }
    const copyPath = resolve(templateDirectory, 'local-test.env.example')
    const pristine = readFileSync(templateFile, 'utf8')
    writeFileSync(copyPath, pristine)
    for (const args of [
      ['-C', repo, 'add', '-A'],
      ['-C', repo, 'commit', '--quiet', '-m', 'baseline']
    ]) {
      const result = spawnSync('git', args, { encoding: 'utf8' })
      if (result.error !== undefined || result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed`)
      }
    }

    const mutated = mutate(pristine)
    if (stageOnly) {
      // 「已 git add、随后把工作树恢复干净」——只有扫 index blob 才能发现。
      writeFileSync(copyPath, mutated)
      spawnSync('git', ['-C', repo, 'add', '--', 'infra/environments/local-test/local-test.env.example'], { encoding: 'utf8' })
      writeFileSync(copyPath, pristine)
    } else {
      writeFileSync(copyPath, mutated)
    }

    let problems
    try {
      problems = scanTrackedTemplates(repo)
    } catch (error) {
      fail(name, `template scan threw: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!problems.some((problem) => expected.test(problem))) {
      fail(
        name,
        wrongReason(expected, problems)
      )
      return
    }
    // 泄漏检查：变异值本身不得出现在任何 problem 里。
    const injected = mutated
      .split('\n')
      .filter((line) => !pristine.includes(line) && line.trim() !== '')
      .map((line) => line.split('=').slice(1).join('=').trim())
      .filter((value) => value.length > 6)
    if (problems.some((problem) => injected.some((value) => problem.includes(value)))) {
      fail(name, 'a failure message echoes the injected value (not reprinted here)')
      return
    }
    pass(name, String(expected))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

templateNegative(
  'a tracked template assigns a non-empty AppSecret',
  (source) => source.replace('WECHAT_APP_SECRET=\n', 'WECHAT_APP_SECRET=synthetic-value\n'),
  /assigns a non-empty value to a sensitive key/
)

templateNegative(
  'a tracked template embeds a full DSN',
  (source) =>
    `${source}\n# poisoned line for the negative test only\n` +
    'EXAMPLE=postgresql://synthetic-user:synthetic-pass@synthetic-host:5432/x\n',
  /contains a full connection string with credentials/
)

templateNegative(
  'a double-commented secret assignment is still caught',
  (source) => source.replace('WECHAT_APP_SECRET=\n', '# WECHAT_APP_SECRET=double-commented\n'),
  /assigns a non-empty value to a sensitive key/
)

templateNegative(
  'a non-postgres connection string with credentials is caught',
  (source) => `${source}\nREDIS_URL=redis://default:synthetic-pass@redis:6379\n`,
  /contains a full connection string with credentials/
)

// 第三轮：连接串判据**与键名无关**。下面四条的赋值键全部是中性的
// （`CACHE_*` / `QUEUE_*` / `SEARCH_*` 都不属于敏感键族，实测 sensitive 判据
// 对它们返回 false），凭据只藏在取值里——旧判据要求 userinfo 必须是
// `user:password@` 形态、且查询参数只认 postgres + `password` 词干，因此这四条
// 在旧实现下**一条都抓不到**。
templateNegative(
  'a neutral key with a token-only userinfo is caught',
  (source) => `${source}\nCACHE_ENDPOINT=redis://TOKEN@redis:6379/0\n`,
  /contains a full connection string with credentials/
)

templateNegative(
  'a neutral key with a credential query parameter is caught',
  (source) => `${source}\nCACHE_REPLICA=redis://redis:6379?password=VALUE\n`,
  /contains a connection string with a credential query parameter/
)

templateNegative(
  'a neutral key with a password-only userinfo is caught',
  (source) => `${source}\nQUEUE_ENDPOINT=amqp://:synthetic-pass@broker:5672/vhost\n`,
  /contains a full connection string with credentials/
)

templateNegative(
  'a neutral key with a non-password credential query parameter is caught',
  (source) => `${source}\nSEARCH_ENDPOINT=https://search.invalid/index?access_token=VALUE\n`,
  /contains a connection string with a credential query parameter/
)

// 模板扫描**只支持 dotenv 形态**：出现 YAML/JSON 等未知格式时必须直接拒绝，
// 而不是静默跳过（跳过等于给那一类格式发免检通行证）。
{
  const name = 'an unsupported template format under infra/environments is rejected'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-repo-'))
  try {
    const repo = resolve(parent, 'repo')
    const templateDirectory = resolve(repo, 'infra/environments/local-test')
    mkdirSync(templateDirectory, { recursive: true })
    for (const args of [
      ['init', '--quiet', repo],
      ['-C', repo, 'config', 'user.email', 'negatives@example.invalid'],
      ['-C', repo, 'config', 'user.name', 'M3B negatives']
    ]) {
      spawnSync('git', args, { encoding: 'utf8' })
    }
    writeFileSync(resolve(templateDirectory, 'local-test.env.example'), 'WECHAT_APP_ID=\n')
    // 一个 YAML 形态的模板：扫描器没有它的判据，必须拒绝。
    writeFileSync(
      resolve(templateDirectory, 'settings.yaml'),
      'wechat:\n  appSecret: synthetic-value\n'
    )
    spawnSync('git', ['-C', repo, 'add', '-A'], { encoding: 'utf8' })
    spawnSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'baseline'], { encoding: 'utf8' })
    const problems = scanTrackedTemplates(repo)
    if (!problems.some((problem) => /unsupported template format/.test(problem))) {
      fail(name, wrongReason('/unsupported template format/', problems))
    } else if (problems.some((problem) => problem.includes('synthetic-value'))) {
      fail(name, 'the rejection echoed the file content')
    } else {
      pass(name, '/unsupported template format/')
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

// **index-only 反例**：Secret 已经 git add，工作树随后被恢复干净。只扫工作树
// 的实现会完全看不见它，而它仍会随下一次 commit 进入历史。
templateNegative(
  'a staged secret with a clean worktree is still caught (git index scan)',
  (source) => source.replace('WECHAT_APP_SECRET=\n', 'WECHAT_APP_SECRET=staged-only-value\n'),
  /\(git index\).*assigns a non-empty value to a sensitive key/,
  { stageOnly: true }
)

// generator 反例：默认拒绝覆盖 / 未知条目拒绝。
{
  const name = 'the generator refuses to overwrite an existing bundle'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  try {
    const directory = resolve(parent, 'bundle')
    generateSecretBundle(directory)
    const before = secretFilenames.map((filename) =>
      readFileSync(resolve(directory, filename))
    )
    let threw = false
    try {
      generateSecretBundle(directory)
    } catch (error) {
      threw = true
      if (!/refusing to overwrite an existing bundle/.test(String(error))) {
        fail(name, wrongReason('/refusing to overwrite an existing bundle/', [String(error)]))
      }
    }
    if (!threw) {
      fail(name, 'NOT CAUGHT — the generator overwrote an existing bundle')
    } else {
      const unchanged = secretFilenames.every((filename, index) =>
        readFileSync(resolve(directory, filename)).equals(before[index])
      )
      if (!unchanged) {
        fail(name, 'the existing bundle was modified during the refusal')
      } else {
        pass(name, '/refusing to overwrite/')
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

{
  const name = 'the generator never echoes an unknown entry name'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  try {
    const directory = resolve(parent, 'bundle')
    mkdirSync(directory, { mode: 0o700 })
    // 用一段口令形态的字符串当文件名：它绝不能出现在错误消息里。
    const secretLikeName = generatePassword()
    writeFileSync(resolve(directory, secretLikeName), '', { mode: 0o600 })
    try {
      generateSecretBundle(directory)
      fail(name, 'NOT CAUGHT — the generator accepted a directory with an unknown entry')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes(secretLikeName)) {
        fail(name, 'the generator echoed the unknown entry name (not reprinted here)')
      } else if (!/unexpected entr/.test(message)) {
        fail(name, wrongReason('/unexpected entr(y|ies)/', [message]))
      } else {
        pass(name, 'category and count only, no entry name')
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

{
  // 要求 7 的回归：预检**抛出**时，刚生成的八份文件必须被删干净。
  const name = 'generateAndPreflight discards the bundle when preflight throws'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  try {
    const directory = resolve(parent, 'bundle')
    let threw = false
    try {
      generateAndPreflight(directory, {
        preflight: () => {
          throw new Error('synthetic preflight failure')
        }
      })
    } catch (error) {
      threw = true
      if (!/synthetic preflight failure/.test(String(error))) {
        fail(name, `wrong error propagated: ${String(error)}`)
      }
    }
    const leftovers = existsSync(directory)
      ? readdirSync(directory).filter((entry) => secretFilenames.includes(entry))
      : []
    if (!threw) {
      fail(name, 'NOT CAUGHT — the throwing preflight did not propagate')
    } else if (leftovers.length > 0) {
      fail(name, `${String(leftovers.length)} secret file(s) survived a throwing preflight`)
    } else {
      pass(name, 'the throwing preflight left no secret files behind')
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

{
  const name = 'the generator refuses a directory with unknown entries'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  try {
    const directory = resolve(parent, 'bundle')
    mkdirSync(directory, { mode: 0o700 })
    writeFileSync(resolve(directory, 'not-a-bundle.txt'), 'x\n')
    let threw = false
    try {
      generateSecretBundle(directory)
    } catch (error) {
      threw = true
      if (!/unexpected entry/.test(String(error))) {
        fail(name, wrongReason('/unexpected entry/', [String(error)]))
      }
    }
    if (!threw) {
      fail(name, 'NOT CAUGHT — the generator wrote into a non-empty directory')
    } else {
      const leftovers = secretFilenames.filter((filename) =>
        existsSync(resolve(directory, filename))
      )
      if (leftovers.length > 0) {
        fail(name, `partial bundle left behind: ${leftovers.join(', ')}`)
      } else {
        pass(name, '/unexpected entry/')
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Group B：Compose 变异反例（改写-还原 + 拓扑门禁的指定理由）
// ---------------------------------------------------------------------------
process.stdout.write('Group B: compose mutation negatives\n')

// Compose 变异反例：**绝不改动真实 tracked compose 文件**。把它复制进临时目录
// 变异，再让拓扑门禁用 MEAL_AGENT_COMPOSE_FILE 指向副本运行。真实文件因此没有
// 任何改写窗口——信号中断也不可能留下被篡改的 tracked 文件。
{
  const composeSource = readFileSync(composeFile, 'utf8')
  const composeMutations = [
    {
      name: 'postgres publishes a host port',
      from: '    # 刻意不声明 ports：数据库只在 internal network 内可达。\n',
      to: '    ports:\n      - "127.0.0.1:15432:5432"\n',
      expect: /postgres: must not publish any host port/
    },
    {
      name: 'api additionally mounts the admin secret',
      from: '    secrets:\n      - meal_agent_runtime_database_url\n    ports:\n',
      to:
        '    secrets:\n      - meal_agent_runtime_database_url\n' +
        '      - meal_agent_admin_database_url\n    ports:\n',
      expect: /api: runtime must never receive the meal_agent_admin_database_url credential/
    },
    {
      name: 'api additionally mounts the migration secret',
      from: '    secrets:\n      - meal_agent_runtime_database_url\n    ports:\n',
      to:
        '    secrets:\n      - meal_agent_runtime_database_url\n' +
        '      - meal_agent_migration_database_url\n    ports:\n',
      expect: /api: runtime must never receive the meal_agent_migration_database_url credential/
    },
    {
      name: 'the api host publish address becomes 0.0.0.0',
      from: '      - host_ip: 127.0.0.1\n',
      to: '      - host_ip: 0.0.0.0\n',
      expect: /host publish address must be exactly 127\.0\.0\.1/
    },
    {
      name: 'a connection string is smuggled into migrate argv',
      from: '    command:\n      - node\n      - /app/dist/database/migrate.js\n',
      to:
        '    command:\n      - node\n      - /app/dist/database/migrate.js\n' +
        '      - postgresql://synthetic-user:synthetic-pass@postgres:5432/meal_agent\n',
      expect: /migrate: expected command/
    }
  ]
  for (const mutation of composeMutations) {
    const occurrences = composeSource.split(mutation.from).length - 1
    if (occurrences !== 1) {
      fail(mutation.name, `anchor appears ${String(occurrences)} times (expected exactly 1)`)
      continue
    }
    const scratch = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-compose-'))
    try {
      // 副本必须与真实文件同目录名布局：门禁按 compose 文件所在目录解析
      // ./postgres、./secrets 等相对路径。这里直接放进 infra/docker 的同级
      // 临时目录并通过 symlink 复用真实资产是不安全的（会引入 symlink 语义），
      // 因此改为把副本放在 infra/docker 下、用唯一文件名，跑完即删。
      const copyPath = resolve(composeDirectory, `.m3b-neg-compose-${randomBytes(4).toString('hex')}.yaml`)
      const anchorIndex = composeSource.indexOf(mutation.from)
      writeFileSync(
        copyPath,
        composeSource.slice(0, anchorIndex) +
          mutation.to +
          composeSource.slice(anchorIndex + mutation.from.length)
      )
      try {
        const result = await run([process.execPath, topologyChecker, '--compose-file', copyPath], {
          cwd: repositoryRoot
        })
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
        if (result.status === 0) {
          fail(mutation.name, 'NOT CAUGHT — the topology checker still passed')
        } else if (!mutation.expect.test(output)) {
          fail(
            mutation.name,
            wrongReason(mutation.expect, output.trim().split('\n'))
          )
        } else {
          pass(mutation.name, String(mutation.expect))
        }
      } finally {
        rmSync(copyPath, { force: true })
      }
    } catch (error) {
      fail(
        mutation.name,
        `checker invocation threw: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  // 真实 tracked compose 文件全程未被改写。
  const dirty = await run(['git', 'status', '--porcelain', '--', composeFile], { cwd: repositoryRoot })
  if (dirty.status !== 0 || dirty.stdout.trim() !== '') {
    fail('compose mutations', 'the tracked compose file is dirty after the mutation negatives')
  } else {
    pass('compose mutations leave the tracked file untouched', 'git status clean for the tracked compose file')
  }
}

// ---------------------------------------------------------------------------
// Group C：containment 扫描器反例（sentinel 真进 environment / argv，必须命中）
// ---------------------------------------------------------------------------
process.stdout.write('Group C: containment scanner negatives\n')

const pinnedImageMatch = /image: (docker\.io\/library\/postgres:[^\n]+)/.exec(
  readFileSync(composeFile, 'utf8')
)
if (pinnedImageMatch === null) {
  fail('scanner negatives', 'could not find the pinned postgres image in the compose file')
} else {
  const image = pinnedImageMatch[1]
  const negativeProject = `meal-agent-m3b-neg-${randomBytes(4).toString('hex')}`
  usedNegativeProjects.push(negativeProject)
  const sentinel = `M3B-NEG-SENTINEL-${randomBytes(12).toString('hex')}`
  const needle = [{ id: 1, category: 'scanner-sentinel', value: sentinel }]
  try {
    const cases = [
      {
        name: 'a secret value in a container environment is detected',
        createArgs: [
          'docker',
          'create',
          '--label',
          `com.docker.compose.project=${negativeProject}`,
          '--name',
          `${negativeProject}-env`,
          '--entrypoint',
          'true',
          '-e',
          `M3B_LEAK_PROBE=${sentinel}`,
          image
        ],
        expectLabel: /Config\.Env/
      },
      {
        name: 'a secret value in container argv is detected',
        createArgs: [
          'docker',
          'create',
          '--label',
          `com.docker.compose.project=${negativeProject}`,
          '--name',
          `${negativeProject}-argv`,
          '--entrypoint',
          'echo',
          image,
          sentinel
        ],
        expectLabel: /Config\.Cmd\/Args/
      }
    ]
    for (const testCase of cases) {
      const created = await run(testCase.createArgs)
      if (created.status !== 0) {
        fail(testCase.name, `docker create failed: ${created.stderr.trim()}`)
        continue
      }
      const { artifacts } = await collectDockerArtifactsForProject({
        project: negativeProject,
        run,
        onProblem: (message) => fail(testCase.name, message)
      })
      const hits = scanArtifactsForNeedles(artifacts, needle)
      const matching = hits.filter((hit) => testCase.expectLabel.test(hit.label))
      if (matching.length === 0) {
        fail(testCase.name, wrongReason(testCase.expectLabel, hits))
      } else if (JSON.stringify(hits).includes(sentinel)) {
        fail(testCase.name, 'the hit report itself contains the sentinel value')
      } else {
        pass(testCase.name, String(testCase.expectLabel))
      }
      await removeOrReport(
      'group C container',
      ['docker', 'rm', '-f', '-v', testCase.createArgs[testCase.createArgs.indexOf('--name') + 1]]
    )
    }
  } finally {
    // 列举**必须**检查退出码：失败的 `docker ps` 给出空 stdout，直接读就等于
    // 「这里没有残留」，于是真实容器被留在宿主上而套件照常绿。
    const leftoverResult = await runStrict(
      'suite cleanup',
      ['docker', 'ps', '-aq', '--filter', `label=com.docker.compose.project=${negativeProject}`],
      'the group C leftover container listing'
    )
    const leftover = leftoverResult === null ? [] : leftoverResult.stdout.split('\n').filter(Boolean)
    if (leftover.length > 0) {
      await removeOrReport('group C leftovers', ['docker', 'rm', '-f', '-v', ...leftover])
    }
  }
}

// ---------------------------------------------------------------------------
// Group D：cleanup 范围反例
// ---------------------------------------------------------------------------
process.stdout.write('Group D: cleanup scope negatives\n')

// probe 的 project 名刻意在 cleanup 范围之外：并发运行的探针不该能被摸到。
for (const outOfScope of [
  'meal-agent-local-test',
  'evil-project',
  '',
  'meal-agent-m3b-probe-deadbeef'
]) {
  const name = `cleanup refuses the out-of-scope project name ${JSON.stringify(outOfScope)}`
  // 拒绝现在**记入 residue** 而不是 throw：裸 throw 会把阶段 1（明文 Secret
  // 目录）已经收集到的失败一起丢掉。调用方仍然因 residue 非空而失败。
  try {
    const residue = await cleanupSmokeProject(outOfScope)
    if (residue.some((entry) => /outside the meal-agent-m3b-\* smoke scope/.test(String(entry)))) {
      pass(name, '/outside the meal-agent-m3b-\\* smoke scope/')
    } else {
      fail(name, wrongReason('/outside the meal-agent-m3b-* smoke scope/', residue))
    }
  } catch (error) {
    fail(name, `unexpected throw: ${error instanceof Error ? error.message : String(error)}`)
  }
}

{
  // 范围外目录：分阶段收集器把它记成 residue（调用方因此失败），而**绝不
  // 删除**它——一个阶段的拒绝不再中断其余阶段，但也绝不被静默吞掉。
  const name = 'cleanup refuses a secrets directory outside the smoke tmp prefix'
  const decoyDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-not-secrets-'))
  const scopeProject = `meal-agent-m3b-neg-scope-${randomBytes(4).toString('hex')}`
  usedNegativeProjects.push(scopeProject)
  try {
    const residue = await cleanupSmokeProject(scopeProject, decoyDirectory)
    const reported = residue.some((entry) =>
      /secrets-directory: .*is not a meal-agent-m3b-secrets-\* directory under the system tmpdir/.test(
        String(entry)
      )
    )
    const stillThere = existsSync(decoyDirectory)
    if (!reported) {
      fail(name, wrongReason('/secrets-directory: not a … directory under the system tmpdir/', residue))
    } else if (!stillThere) {
      fail(name, 'the out-of-scope directory disappeared')
    } else {
      pass(name, '/secrets-directory: not a meal-agent-m3b-secrets-\\* directory/')
    }
  } finally {
    rmSync(decoyDirectory, { recursive: true, force: true })
  }
}

{
  // 上界 + 下界同时断言：cleanup 必须删掉 target project 里的容器（下界，
  // 空实现过不了），同时不碰 decoy project 的容器（上界）。
  const name = 'cleanup removes its own project and leaves other projects untouched'
  const decoyProject = `meal-agent-m3b-neg-decoy-${randomBytes(4).toString('hex')}`
  const targetProject = `meal-agent-m3b-neg-target-${randomBytes(4).toString('hex')}`
  usedNegativeProjects.push(decoyProject, targetProject)
  const pinned = /image: (docker\.io\/library\/postgres:[^\n]+)/.exec(
    readFileSync(composeFile, 'utf8')
  )
  if (pinned === null) {
    fail(name, 'could not find the pinned postgres image in the compose file')
  } else {
    const decoyName = `${decoyProject}-decoy`
    const targetName = `${targetProject}-victim`
    try {
      const createdDecoy = await run([
        'docker',
        'create',
        '--label',
        `com.docker.compose.project=${decoyProject}`,
        '--name',
        decoyName,
        '--entrypoint',
        'true',
        pinned[1]
      ])
      const createdTarget = await run([
        'docker',
        'create',
        '--label',
        `com.docker.compose.project=${targetProject}`,
        '--name',
        targetName,
        '--entrypoint',
        'true',
        pinned[1]
      ])
      if (createdDecoy.status !== 0 || createdTarget.status !== 0) {
        fail(name, `docker create failed: ${(createdDecoy.stderr + createdTarget.stderr).trim()}`)
      } else {
        await cleanupSmokeProject(targetProject)
        // **存在性判据 fail closed**：非零退出不等于「不存在」。unknown 一律
        // 按失败处理，绝不让一次 daemon 抖动冒充「cleanup 删掉了它」。
        const decoyState = await containerPresence(decoyName)
        const targetState = await containerPresence(targetName)
        if (decoyState === 'unknown' || targetState === 'unknown') {
          fail(name, 'the container presence check could not be read; it must not default to absent')
        } else if (decoyState !== 'present') {
          fail(name, 'NOT CAUGHT — the decoy container of another project was removed')
        } else if (targetState !== 'absent') {
          fail(name, 'NOT CAUGHT — cleanup left its own project container behind (a no-op cleanup would pass the decoy check)')
        } else {
          pass(name, 'own project removed (lower bound) and decoy untouched (upper bound)')
        }
      }
    } finally {
      await removeOrReport('decoy container', ['docker', 'rm', '-f', '-v', decoyName])
      await removeOrReport('target container', ['docker', 'rm', '-f', '-v', targetName])
    }
  }
}

// ---------------------------------------------------------------------------
// Group E：镜像隔离（唯一 tag + immutable ID）
// ---------------------------------------------------------------------------
process.stdout.write('Group E: image isolation negatives\n')

{
  // 两个 project 交错 build/up：各自的唯一 tag 必须指向**不同**的 image ID，
  // 且任一方的 build 都不能改写对方 tag 指向的镜像。
  const name = 'two interleaved projects keep independent per-run image tags'
  const runIdA = `neg${randomBytes(3).toString('hex')}`
  const runIdB = `neg${randomBytes(3).toString('hex')}`
  const tagA = runImageTagFor(runIdA)
  const tagB = runImageTagFor(runIdB)
  const overrideA = overridePathFor(composeDirectory, runIdA)
  const overrideB = overridePathFor(composeDirectory, runIdB)
  const projectA = `meal-agent-m3b-neg-imga-${randomBytes(3).toString('hex')}`
  const projectB = `meal-agent-m3b-neg-imgb-${randomBytes(3).toString('hex')}`
  usedNegativeProjects.push(projectA, projectB)
  const secretsA = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-secrets-'))
  const secretsB = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-secrets-'))
  try {
    generateSecretBundle(secretsA)
    generateSecretBundle(secretsB)
    writeImageOverride(overrideA, tagA)
    writeImageOverride(overrideB, tagB)
    const buildFor = (project, override, secrets) =>
      run(
        [
          'docker',
          'compose',
          '--file',
          composeFile,
          '--file',
          override,
          '--project-name',
          project,
          'build',
          'api'
        ],
        {
          cwd: composeDirectory,
          timeoutMs: 1_800_000,
          env: { ...process.env, MEAL_AGENT_SECRETS_DIR: secrets, MEAL_AGENT_API_HOST_PORT: '3000' }
        }
      )
    // 交错顺序：A build → B build → 再读两个 tag 的 image ID。
    const builtA = await buildFor(projectA, overrideA, secretsA)
    if (builtA.status !== 0) {
      throw new Error(`project A build failed: ${builtA.stderr.slice(-400)}`)
    }
    const idA1 = await imageIdOf(tagA)
    const builtB = await buildFor(projectB, overrideB, secretsB)
    if (builtB.status !== 0) {
      throw new Error(`project B build failed: ${builtB.stderr.slice(-400)}`)
    }
    const idA2 = await imageIdOf(tagA)
    const idB = await imageIdOf(tagB)
    if (idA1 === null || idB === null) {
      fail(name, 'a per-run tag does not exist after its own build')
    } else if (idA2 !== idA1) {
      fail(name, "project B's build changed the image that project A's tag points at")
    } else if (tagA === tagB) {
      fail(name, 'the two runs produced the same tag')
    } else {
      pass(
        name,
        `${tagA} -> ${idA1.slice(0, 19)} stayed put while ${tagB} -> ${idB.slice(0, 19)} was built`
      )
    }

    // cleanup 只删自己那一个 tag：删 A 之后 B 必须还在。
    const cleanupName = 'per-run cleanup removes only its own image tag'
    const residueA = await cleanupSmokeProject(projectA, secretsA, { imageTag: tagA })
    const afterA = await imageIdOf(tagA)
    const survivingB = await imageIdOf(tagB)
    if (residueA.length > 0) {
      fail(cleanupName, wrongReason('an empty residue list', residueA))
    } else if (afterA !== null) {
      fail(cleanupName, 'the run tag still exists after cleanup')
    } else if (survivingB === null) {
      fail(cleanupName, "cleanup removed the other project's tag")
    } else {
      pass(cleanupName, "own tag removed, the other project's tag untouched")
    }
  } catch (error) {
    fail(name, `image isolation negative threw: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    // 这里此前 `.catch(() => undefined)` 并丢弃返回的 residue：projectB 的镜像与
    // 容器清理若失败，整个套件看不见。现在两种失败都记账。
    const residueB = await cleanupSmokeProject(projectB, secretsB, { imageTag: tagB }).catch(
      (error) => [`cleanup-error: ${safe(error instanceof Error ? error.message : String(error))}`]
    )
    if (residueB.length > 0) {
      fail('suite cleanup', wrongReason('an empty residue list for the second image project', residueB))
    }
    for (const path of [overrideA, overrideB]) {
      rmSync(path, { force: true })
    }
    for (const directory of [secretsA, secretsB]) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

{
  // cleanup 拒绝删除任何非本轮形状的 tag（例如全局共享 tag）。
  const name = 'cleanup refuses to remove a tag outside the per-run namespace'
  const project = `meal-agent-m3b-neg-tag-${randomBytes(3).toString('hex')}`
  usedNegativeProjects.push(project)
  const residue = await cleanupSmokeProject(project, null, {
    imageTag: 'meal-agent-api:stage09a-local-test'
  })
  if (residue.some((entry) => /image-tag: refusing to remove .*not a per-run/.test(String(entry)))) {
    pass(name, '/image-tag: refusing to remove … not a per-run/')
  } else {
    fail(name, wrongReason('/image-tag: refusing to remove … not a per-run/', residue))
  }
}

// ---------------------------------------------------------------------------
// Group F：Docker 证据 fail closed（list/inspect/remove 非零 & 部分删除失败）
// ---------------------------------------------------------------------------
process.stdout.write('Group F: docker evidence fail-closed negatives\n')

{
  // 用 PATH 影子 docker 让指定子命令非零退出，证明证据读取不会 fail open。
  const shimCases = [
    {
      name: 'a failing docker ps makes the container sweep report residue instead of passing',
      script: 'if [ "$1" = "ps" ]; then echo "boom" >&2; exit 7; fi\nexec /usr/local/bin/docker "$@"\n',
      expect: /container-sweep: docker ps .*exited 7/
    },
    {
      name: 'a failing docker volume ls makes the dangling check report residue',
      script: 'if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then echo "boom" >&2; exit 9; fi\nexec /usr/local/bin/docker "$@"\n',
      expect: /(volume-sweep|dangling-volumes): docker volume ls .*exited 9/
    },
    {
      name: 'a failing docker compose down is reported instead of silently ignored',
      script: 'if [ "$1" = "compose" ]; then echo "boom" >&2; exit 5; fi\nexec /usr/local/bin/docker "$@"\n',
      expect: /compose-down: docker compose .*exited 5/
    }
  ]
  // `which docker` 的退出码必须检查：读不到真实路径时 shim 会退化成
  // `exec  "$@"`，三条 fail-closed 反例就是在对着一个坏掉的夹具下判断。
  const realDockerResult = await runStrict(
    'Group F shim setup',
    ['which', 'docker'],
    'the real docker path for the PATH shim'
  )
  const realDocker = realDockerResult === null ? '' : realDockerResult.stdout.trim()
  for (const shimCase of realDocker === '' ? [] : shimCases) {
    const shimDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-shim-'))
    const project = `meal-agent-m3b-neg-shim-${randomBytes(3).toString('hex')}`
    usedNegativeProjects.push(project)
    try {
      const shimPath = resolve(shimDirectory, 'docker')
      writeFileSync(
        shimPath,
        `#!/bin/sh\n${shimCase.script.replaceAll('/usr/local/bin/docker', realDocker)}`,
        { mode: 0o700 }
      )
      const residue = await cleanupSmokeProject(project, null, {
        composeEnvironment: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH ?? ''}` },
        danglingBaseline: new Set()
      })
      if (residue.some((entry) => shimCase.expect.test(String(entry)))) {
        pass(shimCase.name, String(shimCase.expect))
      } else {
        fail(shimCase.name, wrongReason(shimCase.expect, residue))
      }
    } finally {
      rmSync(shimDirectory, { recursive: true, force: true })
    }
  }
}

stageIsolationNegative: {
  // 一个阶段失败不阻断其余阶段：compose down 失败时，容器/网络/卷 sweep 仍
  // 必须执行（本例用一个真实 decoy 容器证明它确实被删掉）。
  const name = 'a failing stage does not block the remaining cleanup stages'
  const project = `meal-agent-m3b-neg-stage-${randomBytes(3).toString('hex')}`
  usedNegativeProjects.push(project)
  const pinned = /image: (docker\.io\/library\/postgres:[^\n]+)/.exec(readFileSync(composeFile, 'utf8'))
  const shimDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-shim-'))
  const containerName = `${project}-victim`
  try {
    if (pinned === null) {
      // 与上面那个 project 对照块同一条守卫：没有它，正则一旦失配就会在
      // `pinned[1]` 上抛 TypeError，反例**死掉**而不是失败。`break` 会正常
      // 执行 finally，再退出这个带标签的块。
      fail(name, 'could not find the pinned postgres image in the compose file')
      break stageIsolationNegative
    }
    const realDockerResult = await runStrict(
      'Group F stage isolation setup',
      ['which', 'docker'],
      'the real docker path for the PATH shim'
    )
    const realDocker = realDockerResult === null ? '' : realDockerResult.stdout.trim()
    const created = await run([
      'docker',
      'create',
      '--label',
      `com.docker.compose.project=${project}`,
      '--name',
      containerName,
      '--entrypoint',
      'true',
      pinned[1]
    ])
    if (created.status !== 0) {
      fail(name, `docker create failed: ${created.stderr.trim()}`)
    } else {
      const shimPath = resolve(shimDirectory, 'docker')
      writeFileSync(
        shimPath,
        `#!/bin/sh\nif [ "$1" = "compose" ]; then echo "boom" >&2; exit 5; fi\nexec ${realDocker} "$@"\n`,
        { mode: 0o700 }
      )
      const residue = await cleanupSmokeProject(project, null, {
        composeEnvironment: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH ?? ''}` }
      })
      const downFailed = residue.some((entry) => /compose-down/.test(String(entry)))
      // 非零退出**不等于**「容器已被删掉」：此前一次 daemon 抖动就能让这条
      // 反例在 cleanup 完全没删东西的情况下判绿。
      const victimState = await containerPresence(containerName)
      if (victimState === 'unknown') {
        fail(name, 'the container presence check could not be read; it must not default to absent')
      } else if (!downFailed) {
        fail(name, 'the injected compose-down failure was not reported')
      } else if (victimState !== 'absent') {
        fail(name, 'the container sweep was skipped after the compose-down failure')
      } else {
        pass(name, 'compose-down failure reported AND the container sweep still ran')
      }
    }
  } finally {
    await removeOrReport('stage isolation victim', ['docker', 'rm', '-f', '-v', containerName])
    rmSync(shimDirectory, { recursive: true, force: true })
  }
}

{
  // R3-1（目录层）：`cleanupRun` 在**递归删除**临时 Secret 目录之前复核 inode
  // 身份。这一半此前没有任何门禁触及——`secretsIdentity` 只有 smoke 与 probe
  // 传，四套反例一律走默认的 null，于是把那段守卫整个删掉，所有门禁照样绿。
  // 这里显式构造 drift：先在 tmp 前缀下建一个目录并记下它的 inode，删掉它，
  // 再在**同一路径**上建一个新目录（不同 inode），然后带着旧身份跑 cleanup。
  const name = 'cleanup refuses to recursively delete a secrets directory it does not own'
  const project = `meal-agent-m3b-neg-inode-${randomBytes(4).toString('hex')}`
  usedNegativeProjects.push(project)
  const secretsDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-secrets-'))
  const staleIdentity = inodeIdentityOf(secretsDirectory)
  let replacementIdentity = null
  try {
    rmSync(secretsDirectory, { recursive: true, force: true })
    mkdirSync(secretsDirectory, { mode: 0o700 })
    writeFileSync(resolve(secretsDirectory, 'not-ours.txt'), 'foreign\n', { mode: 0o600 })
    replacementIdentity = inodeIdentityOf(secretsDirectory)

    const residue = await cleanupSmokeProject(project, secretsDirectory, {
      secretsIdentity: staleIdentity
    })
    const reportedDrift = residue.some((entry) =>
      /secrets-directory: ownership drift at the temporary secrets directory/.test(String(entry))
    )
    const survived = existsSync(resolve(secretsDirectory, 'not-ours.txt'))
    const sameInode =
      existsSync(secretsDirectory) &&
      inodeIdentityOf(secretsDirectory).ino === replacementIdentity.ino

    if (staleIdentity.ino === replacementIdentity.ino) {
      fail(name, 'the precondition failed: the replacement directory reused the same inode')
    } else if (!reportedDrift) {
      fail(name, wrongReason('/secrets-directory: ownership drift/', residue))
    } else if (!survived || !sameInode) {
      fail(name, 'the foreign directory was recursively deleted despite the identity mismatch')
    } else {
      pass(name, 'ownership drift reported and the foreign directory left untouched')
    }
  } finally {
    rmSync(secretsDirectory, { recursive: true, force: true })
  }
}

{
  // R3-4：门禁**自身**的读取纪律。用一个恒定非零退出的 PATH shim 证明两条：
  //
  //   1. 「容器还在不在」的判据不得把 daemon 故障读成「已被删除」——旧写法
  //      `(await run(['docker','inspect',name])).status !== 0` 恰好如此；
  //   2. 残留列举读不到时必须报出来，不得因为 stdout 为空而宣布零残留。
  //
  // 两条都直接调用收尾逻辑用的**同一个**判据函数，因此这条反例覆盖的就是
  // 真正跑在生产路径上的那段代码。
  const presenceName = 'a docker failure is never read as "the container is gone"'
  const listingName = 'an unreadable residue listing is reported instead of being read as zero'
  const shimDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-shim-'))
  try {
    writeFileSync(
      resolve(shimDirectory, 'docker'),
      '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 7\n',
      { mode: 0o700 }
    )
    const shimEnv = { ...process.env, PATH: `${shimDirectory}:${process.env.PATH ?? ''}` }
    const presence = await containerPresence('meal-agent-m3b-neg-absent-probe', shimEnv)
    if (presence === 'absent') {
      fail(presenceName, 'NOT CAUGHT — a failing docker inspect was read as "the container is gone"')
    } else if (presence !== 'unknown') {
      fail(presenceName, wrongReason("'unknown'", [presence]))
    } else {
      pass(presenceName, "a non-zero docker inspect reads as 'unknown', never as 'absent'")
    }

    const listing = await residueListingFor(
      'container',
      'meal-agent-m3b-neg-listing-probe',
      shimEnv
    )
    if (listing.readable) {
      fail(listingName, 'NOT CAUGHT — a failing docker ps was reported as a readable listing')
    } else if (listing.ids.length !== 0) {
      fail(listingName, wrongReason('an empty id list on an unreadable listing', listing.ids))
    } else {
      pass(listingName, `an unreadable listing is flagged (${listing.detail}), not read as zero`)
    }
  } finally {
    rmSync(shimDirectory, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Group G：子进程与信号（build / run / cleanup / 文件变异 / rename 五个窗口）
// ---------------------------------------------------------------------------
process.stdout.write('Group G: subprocess and signal negatives\n')

{
  // generator 的生成窗口：SIGINT 落在**生成过程中**必须清掉半套 bundle，并
  // 按原信号语义收场。这条用**真实 CLI**（`generate-local-test-secrets.mjs`）
  // 跑，不再自己手搓 handler——审计指出上一版用同步的 generateSecretBundle
  // 做 fixture，信号只可能落在生成之前或之后，`leftovers.length > 0` 恒不
  // 成立，任何实现都能通过（实测：把可中断路径换成同步版，这条仍然绿）。
  const name = 'SIGINT during generation leaves no bundle and honours the signal'
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-gen-'))
  const bundle = resolve(directory, 'bundle')
  try {
    const child = spawn(
      process.execPath,
      [resolve(composeDirectory, 'generate-local-test-secrets.mjs'), '--directory', bundle],
      { stdio: ownershipAwareSpawnStdio(['ignore', 'pipe', 'pipe']) }
    )
    const outcome = await new Promise((resolveOutcome) => {
      let stdout = ''
      let stderr = ''
      // 生成是分片的（每份文件之间让出事件循环）。轮询到**第一份暂存文件
      // 真的出现**再发信号，窗口因此确定落在生成过程中，而不是靠猜时间。
      const poll = setInterval(() => {
        const started = existsSync(bundle) && readdirSync(bundle).length > 0
        if (started) {
          clearInterval(poll)
          child.kill('SIGINT')
        }
      }, 5)
      setTimeout(() => {
        clearInterval(poll)
        child.kill('SIGINT')
      }, 5_000).unref()
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })
      child.once('close', (code, signal) => resolveOutcome({ code, signal, stdout, stderr }))
    })
    const leftovers = existsSync(bundle)
      ? readdirSync(bundle).filter((entry) => !entry.startsWith('.keep'))
      : []
    if (leftovers.length > 0) {
      fail(name, `the interrupted generator left ${String(leftovers.length)} file(s) behind`)
    } else if (outcome.signal !== 'SIGINT') {
      fail(
        name,
        `expected termination by SIGINT, got code=${String(outcome.code)} signal=${String(outcome.signal)}`
      )
    } else if (/discarded \d+ generated file/.test(outcome.stderr) === false) {
      fail(name, `the cleanup did not report what it discarded: ${outcome.stderr.trim()}`)
    } else {
      pass(name, 'no bundle left behind and the process was terminated by SIGINT')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

{
  // 受控子树：runCommand 起的子进程自成进程组，terminateControlledSubtree
  // 必须把整组带走（用一个长时间 sleep 的子进程证明）。
  const name = 'the controlled subtree is terminated as a group'
  const started = runCommand(['sh', '-c', 'sleep 60'], { timeoutMs: 30_000 })
  await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  const before = (await run(['sh', '-c', 'pgrep -f "sleep 60" | wc -l'])).stdout.trim()
  await terminateControlledSubtree({ graceMs: 300 })
  await started.catch(() => undefined)
  await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  const after = (await run(['sh', '-c', 'pgrep -f "sleep 60" | wc -l'])).stdout.trim()
  if (Number(before) < 1) {
    fail(name, 'the controlled child never started')
  } else if (Number(after) >= Number(before)) {
    fail(name, `the child survived termination (before=${before}, after=${after})`)
  } else {
    pass(name, `controlled subtree went from ${before} to ${after} matching processes`)
  }
}

// ---------------------------------------------------------------------------
// 收尾：本套件不得留下任何 Docker 资源（容器、网络、卷都查）。docker 的
// label filter 是精确值匹配，因此按「本套件真实用过的 project 名」逐个断言。
// ---------------------------------------------------------------------------
for (const project of usedNegativeProjects) {
  for (const kind of ['container', 'network', 'volume']) {
    // 套件收尾的零残留结论**必须** fail closed（判据与下面那条反例同一个）。
    const listing = await residueListingFor(kind, project)
    if (!listing.readable) {
      fail(
        'suite residue',
        `the ${kind} residue listing for ${project} could not be read (${listing.detail}); ` +
          'an unreadable listing must not be read as zero residue'
      )
      continue
    }
    if (listing.ids.length > 0) {
      fail('suite residue', `${kind}s left behind under ${project}: ${listing.ids.join(', ')}`)
    }
  }
}

// case 数量的精确下界：任何新增的早退路径若忘了调 fail()，都会在这里被计数
// 差额暴露，而不是静默变成「跑得更少的绿」。
// 本套件的**准确口径**：75 个 case = **1 个正向 baseline + 74 个反例/边界
// 检查**。此前变量与输出都叫「negatives」，把那条正向 baseline 也算成了反例
// ——而它恰恰是唯一一条「必须通过」的用例（没有它，「一律判失败」的回归会让
// 其余 74 条恒绿）。
const expectedCaseCount = 75
const positiveBaselineCount = 1
const negativeCaseCount = expectedCaseCount - positiveBaselineCount
if (caught + failures.length !== expectedCaseCount) {
  fail(
    'suite completeness',
    `expected ${String(expectedCaseCount)} cases to be evaluated ` +
      `(${String(positiveBaselineCount)} positive baseline + ${String(negativeCaseCount)} ` +
      `negative/boundary), got ${String(caught)} satisfied + ${String(failures.length)} failed`
  )
}

if (failures.length > 0) {
  process.stderr.write('local-test case suite FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}
process.stdout.write(
  `local-test case suite PASS (${String(caught)}/${String(expectedCaseCount)} cases: ` +
    `${String(positiveBaselineCount)} positive baseline + ${String(negativeCaseCount)} ` +
    'negative/boundary cases, each satisfied for its named reason, 0 escapes, ' +
    'no secret values in any failure message)\n'
)
