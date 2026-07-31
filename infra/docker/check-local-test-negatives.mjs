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
  overridePathFor,
  runImageTagFor,
  writeImageOverride
} from './m3b-docker.mjs'
import { runCommand, terminateControlledSubtree } from './m3b-subprocess.mjs'

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
      fail(
        name,
        `caught, but for the wrong reason (expected ${String(expected)}):\n` +
          problems.map((problem) => `    - ${problem}`).join('\n')
      )
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
  // **正向基线**：一套刚生成的干净 bundle 预检必须零问题。没有它，「所有
  // bundle 一律判失败」的回归会让下面每一条反例都恒绿（审计实测：把
  // 0700 判据改成拒绝一切正确目录，33 条反例全部照常通过）。
  const name = 'a freshly generated bundle passes preflight with zero problems'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  const directory = resolve(parent, 'bundle')
  try {
    generateSecretBundle(directory)
    const { problems } = checkSecretBundle(directory, { scanTemplates: false })
    if (problems.length > 0) {
      fail(name, `a clean bundle was rejected: ${problems.join('; ')}`)
    } else {
      pass(name, 'zero problems on a pristine bundle (guards against blanket rejection)')
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
    rewriteSecret(
      directory,
      'meal_agent_admin_database_url',
      renderDatabaseUrl('postgres', generatePassword())
    )
  }
)

preflightNegative(
  'pgpass password does not match the superuser password file',
  /endpoint line 2 password does not match the superuser password file/,
  (directory) => {
    const superuser = readBody(directory, 'postgres_superuser_password')
    rewriteSecret(
      directory,
      'postgres_admin.pgpass',
      `postgres:5432:postgres:postgres:${superuser}\n` +
        `postgres:5432:meal_agent:postgres:${generatePassword()}`
    )
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
    rewriteSecret(
      directory,
      'meal_agent_runtime_database_url',
      `postgresql://meal_agent_runtime_login:${password.slice(0, 10)}\t${password.slice(10)}@postgres:5432/meal_agent`
    )
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
      fail(name, `expected the tracked-secret reason, got:\n${problems.join('\n')}`)
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
        `expected ${String(expected)}, got:\n${problems.map((p) => `    - ${p}`).join('\n') || '    (no problems)'}`
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
  /assigns a non-empty value to the sensitive key WECHAT_APP_SECRET/
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
  /assigns a non-empty value to the sensitive key WECHAT_APP_SECRET/
)

templateNegative(
  'a non-postgres connection string with credentials is caught',
  (source) => `${source}\nREDIS_URL=redis://default:synthetic-pass@redis:6379\n`,
  /contains a full connection string with credentials/
)

// **index-only 反例**：Secret 已经 git add，工作树随后被恢复干净。只扫工作树
// 的实现会完全看不见它，而它仍会随下一次 commit 进入历史。
templateNegative(
  'a staged secret with a clean worktree is still caught (git index scan)',
  (source) => source.replace('WECHAT_APP_SECRET=\n', 'WECHAT_APP_SECRET=staged-only-value\n'),
  /\(git index\).*assigns a non-empty value to the sensitive key WECHAT_APP_SECRET/,
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
        fail(name, `wrong reason: ${error instanceof Error ? error.message : String(error)}`)
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
        fail(name, `wrong reason: ${message}`)
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
        fail(name, `wrong reason: ${error instanceof Error ? error.message : String(error)}`)
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
            `caught, but for the wrong reason (expected ${String(mutation.expect)}):\n${output.trim()}`
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
        fail(
          testCase.name,
          `NOT CAUGHT — the scanner missed the sentinel (hits: ${JSON.stringify(hits)})`
        )
      } else if (JSON.stringify(hits).includes(sentinel)) {
        fail(testCase.name, 'the hit report itself contains the sentinel value')
      } else {
        pass(testCase.name, String(testCase.expectLabel))
      }
      await run(['docker', 'rm', '-f', '-v', testCase.createArgs[testCase.createArgs.indexOf('--name') + 1]])
    }
  } finally {
    const leftoverResult = await run([
      'docker',
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=${negativeProject}`
    ])
    const leftover = leftoverResult.stdout.split('\n').filter(Boolean)
    if (leftover.length > 0) {
      await run(['docker', 'rm', '-f', '-v', ...leftover])
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
  try {
    await cleanupSmokeProject(outOfScope)
    fail(name, 'NOT CAUGHT — cleanup accepted an out-of-scope project name')
  } catch (error) {
    if (/outside the meal-agent-m3b-\* smoke scope/.test(String(error))) {
      pass(name, '/outside the meal-agent-m3b-\\* smoke scope/')
    } else {
      fail(name, `wrong reason: ${error instanceof Error ? error.message : String(error)}`)
    }
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
      fail(
        name,
        `NOT CAUGHT — cleanup did not report the out-of-scope directory: ${residue.join('; ')}`
      )
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
        const survived = await run(['docker', 'inspect', decoyName])
        const removed = await run(['docker', 'inspect', targetName])
        if (survived.status !== 0) {
          fail(name, 'NOT CAUGHT — the decoy container of another project was removed')
        } else if (removed.status === 0) {
          fail(name, 'NOT CAUGHT — cleanup left its own project container behind (a no-op cleanup would pass the decoy check)')
        } else {
          pass(name, 'own project removed (lower bound) and decoy untouched (upper bound)')
        }
      }
    } finally {
      await run(['docker', 'rm', '-f', '-v', decoyName])
      await run(['docker', 'rm', '-f', '-v', targetName])
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
      fail(cleanupName, `cleanup reported residue: ${residueA.join('; ')}`)
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
    await cleanupSmokeProject(projectB, secretsB, { imageTag: tagB }).catch(() => undefined)
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
    fail(name, `NOT CAUGHT — cleanup accepted a foreign tag: ${residue.join('; ')}`)
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
  const realDocker = (await run(['which', 'docker'])).stdout.trim()
  for (const shimCase of shimCases) {
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
        fail(shimCase.name, `NOT CAUGHT — residue was ${JSON.stringify(residue)}`)
      }
    } finally {
      rmSync(shimDirectory, { recursive: true, force: true })
    }
  }
}

{
  // 一个阶段失败不阻断其余阶段：compose down 失败时，容器/网络/卷 sweep 仍
  // 必须执行（本例用一个真实 decoy 容器证明它确实被删掉）。
  const name = 'a failing stage does not block the remaining cleanup stages'
  const project = `meal-agent-m3b-neg-stage-${randomBytes(3).toString('hex')}`
  usedNegativeProjects.push(project)
  const pinned = /image: (docker\.io\/library\/postgres:[^\n]+)/.exec(readFileSync(composeFile, 'utf8'))
  const shimDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-shim-'))
  const containerName = `${project}-victim`
  try {
    const realDocker = (await run(['which', 'docker'])).stdout.trim()
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
      const containerGone = (await run(['docker', 'inspect', containerName])).status !== 0
      if (!downFailed) {
        fail(name, 'the injected compose-down failure was not reported')
      } else if (!containerGone) {
        fail(name, 'the container sweep was skipped after the compose-down failure')
      } else {
        pass(name, 'compose-down failure reported AND the container sweep still ran')
      }
    }
  } finally {
    await run(['docker', 'rm', '-f', '-v', containerName])
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
      { stdio: ['ignore', 'pipe', 'pipe'] }
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
  for (const [kind, listArgs] of [
    ['container', ['docker', 'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]],
    ['network', ['docker', 'network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]],
    ['volume', ['docker', 'volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]]
  ]) {
    const residueResult = await run(listArgs)
    const residue = residueResult.stdout.split('\n').filter(Boolean)
    if (residue.length > 0) {
      fail('suite residue', `${kind}s left behind under ${project}: ${residue.join(', ')}`)
    }
  }
}

// 反例数量的精确下界：任何新增的早退路径若忘了调 fail()，都会在这里被计数
// 差额暴露，而不是静默变成「跑得更少的绿」。
const expectedNegativeCount = 67
if (caught + failures.length !== expectedNegativeCount) {
  fail(
    'suite completeness',
    `expected ${String(expectedNegativeCount)} negatives to be evaluated, ` +
      `got ${String(caught)} caught + ${String(failures.length)} failed`
  )
}

if (failures.length > 0) {
  process.stderr.write('local-test negative suite FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}
process.stdout.write(
  `local-test negative suite PASS (${String(caught)}/${String(expectedNegativeCount)} ` +
    'negatives caught with their named reasons, 0 escapes, no secret values in ' +
    'any failure message)\n'
)
