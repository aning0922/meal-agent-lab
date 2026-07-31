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
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
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

import { generateSecretBundle } from './generate-local-test-secrets.mjs'
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

const run = (args, options = {}) => {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
    ...options
  })
  if (result.error !== undefined) {
    throw new Error(`failed to run ${args.join(' ')}: ${result.error.message}`)
  }
  return result
}

// ---------------------------------------------------------------------------
// Group A：预检反例（不触碰 Docker）
// ---------------------------------------------------------------------------

/** 读取一个 bundle 的全部敏感值（口令 + URL + pgpass 行），供「消息不含
 * Secret」断言使用。只在内存中，绝不输出。 */
const sensitiveValuesOf = (directory) => {
  const values = new Set()
  for (const filename of secretFilenames) {
    let content
    try {
      content = readFileSync(resolve(directory, filename), 'utf8')
    } catch {
      continue
    }
    for (const line of content.split('\n')) {
      if (line !== '') {
        values.add(line)
      }
    }
  }
  return [...values]
}

/**
 * 通用预检反例：建一套新 bundle → mutate → checkSecretBundle 必须给出指定
 * 理由，且所有消息不含任何敏感值。
 */
const preflightNegative = (name, expected, mutate, options = {}) => {
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  const directory = resolve(parent, 'bundle')
  try {
    generateSecretBundle(directory)
    const checkOptions = { scanTemplates: false, ...(mutate(directory, parent) ?? {}) }
    const values = sensitiveValuesOf(directory)
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
  /must not carry a query string/,
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
  /must contain exactly 2 endpoint lines/,
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
  /must not use wildcard rules/,
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
  /unknown entry in the bundle directory/,
  (directory) => {
    writeFileSync(resolve(directory, 'stray.txt'), 'not a secret\n', { mode: 0o600 })
  }
)

preflightNegative(
  'weak permissions (0644)',
  /has mode 0644; only owner-only 0400 or 0600 is accepted/,
  (directory) => {
    chmodSync(resolve(directory, 'postgres_superuser_password'), 0o644)
  }
)

preflightNegative(
  'wrong owner uid (via the expectedOwnerUid seam)',
  /expected owner is uid/,
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

// tracked Secret：临时 git 仓库里把一份 secret staged 进索引。
{
  const name = 'a secret file is tracked by git'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  try {
    const repo = resolve(parent, 'repo')
    run(['git', 'init', '--quiet', repo])
    const directory = resolve(repo, 'secrets')
    generateSecretBundle(directory)
    run(['git', '-C', repo, 'add', '--', 'secrets/postgres_superuser_password'])
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

// tracked 模板反例：临时改写真实模板文件，扫描必须拒绝，随后逐字节还原。
const templateNegative = (name, mutate, expected) => {
  const status = run(['git', 'status', '--porcelain', '--', templateFile], {
    cwd: repositoryRoot
  })
  if (status.status !== 0 || status.stdout.trim() !== '') {
    fail(name, `refusing to run: ${templateFile} is dirty or unreadable in git`)
    return
  }
  const original = readFileSync(templateFile)
  try {
    writeFileSync(templateFile, mutate(original.toString('utf8')))
    const problems = scanTrackedTemplates()
    if (!problems.some((problem) => expected.test(problem))) {
      fail(
        name,
        `expected ${String(expected)}, got:\n${problems.map((p) => `    - ${p}`).join('\n') || '    (no problems)'}`
      )
      return
    }
    pass(name, String(expected))
  } finally {
    writeFileSync(templateFile, original)
  }
  if (!readFileSync(templateFile).equals(original)) {
    fail(name, `FATAL: ${templateFile} was not restored byte-for-byte`)
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
  const name = 'the generator refuses a directory with unknown entries'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-'))
  try {
    const directory = resolve(parent, 'bundle')
    run(['mkdir', '-m', '700', directory])
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

const composeStatus = run(['git', 'status', '--porcelain', '--', composeFile], {
  cwd: repositoryRoot
})
if (composeStatus.status !== 0 || composeStatus.stdout.trim() !== '') {
  fail('compose mutations', `refusing to run: ${composeFile} is dirty in git`)
} else {
  const original = readFileSync(composeFile)
  const source = original.toString('utf8')
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
    const occurrences = source.split(mutation.from).length - 1
    if (occurrences !== 1) {
      fail(
        mutation.name,
        `anchor appears ${String(occurrences)} times (expected exactly 1)`
      )
      continue
    }
    try {
      writeFileSync(composeFile, source.replace(mutation.from, mutation.to))
      const result = run([process.execPath, topologyChecker], {
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
      writeFileSync(composeFile, original)
    }
  }
  if (!readFileSync(composeFile).equals(original)) {
    fail('compose mutations', `FATAL: ${composeFile} was not restored byte-for-byte`)
    process.stderr.write(`Run: git restore -- ${composeFile}\n`)
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
      const created = run(testCase.createArgs)
      if (created.status !== 0) {
        fail(testCase.name, `docker create failed: ${created.stderr.trim()}`)
        continue
      }
      const { artifacts } = collectDockerArtifactsForProject({
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
      run(['docker', 'rm', '-f', testCase.createArgs[testCase.createArgs.indexOf('--name') + 1]])
    }
  } finally {
    const leftover = run([
      'docker',
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=${negativeProject}`
    ])
      .stdout.split('\n')
      .filter(Boolean)
    if (leftover.length > 0) {
      run(['docker', 'rm', '-f', ...leftover])
    }
  }
}

// ---------------------------------------------------------------------------
// Group D：cleanup 范围反例
// ---------------------------------------------------------------------------
process.stdout.write('Group D: cleanup scope negatives\n')

for (const outOfScope of ['meal-agent-local-test', 'evil-project', '']) {
  const name = `cleanup refuses the out-of-scope project name ${JSON.stringify(outOfScope)}`
  try {
    cleanupSmokeProject(outOfScope)
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
  const name = 'cleanup refuses a secrets directory outside the smoke tmp prefix'
  const decoyDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-neg-not-secrets-'))
  try {
    cleanupSmokeProject(`meal-agent-m3b-neg-scope-${randomBytes(4).toString('hex')}`, decoyDirectory)
    fail(name, 'NOT CAUGHT — cleanup removed a directory outside its scope')
  } catch (error) {
    const reasonOk = /is not a meal-agent-m3b-secrets-\* directory under the system tmpdir/.test(
      String(error)
    )
    const stillThere = existsSync(decoyDirectory)
    if (!reasonOk) {
      fail(name, `wrong reason: ${error instanceof Error ? error.message : String(error)}`)
    } else if (!stillThere) {
      fail(name, 'the out-of-scope directory disappeared')
    } else {
      pass(name, '/not a meal-agent-m3b-secrets-\\* directory/')
    }
  } finally {
    rmSync(decoyDirectory, { recursive: true, force: true })
  }
}

{
  const name = 'cleanup leaves other projects untouched (decoy survival)'
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
    try {
      const created = run([
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
      if (created.status !== 0) {
        fail(name, `docker create failed: ${created.stderr.trim()}`)
      } else {
        cleanupSmokeProject(targetProject)
        const survived = run(['docker', 'inspect', decoyName])
        if (survived.status !== 0) {
          fail(name, 'NOT CAUGHT — the decoy container of another project was removed')
        } else {
          pass(name, 'label-scoped cleanup only touches its own project')
        }
      }
    } finally {
      run(['docker', 'rm', '-f', decoyName])
    }
  }
}

// ---------------------------------------------------------------------------
// 收尾：本套件不得留下任何 Docker 资源。docker 的 label filter 是精确值匹配，
// 因此按「本套件真实用过的 project 名」逐个断言为空。
// ---------------------------------------------------------------------------
for (const project of usedNegativeProjects) {
  const residue = run([
    'docker',
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`
  ])
    .stdout.split('\n')
    .filter(Boolean)
  if (residue.length > 0) {
    fail('suite residue', `containers left behind under ${project}: ${residue.join(', ')}`)
  }
}

if (failures.length > 0) {
  process.stderr.write('local-test negative suite FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}
process.stdout.write(
  `local-test negative suite PASS (${String(caught)} negatives caught with their ` +
    'named reasons, 0 escapes, no secret values in any failure message)\n'
)
