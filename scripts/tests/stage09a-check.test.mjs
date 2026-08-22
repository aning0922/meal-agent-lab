import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { stage09aStepIds } from '../stage09a-gate-registry.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const entrypoint = resolve(repositoryRoot, 'scripts/run-stage09a-check.mjs')
const subprocessModule = resolve(repositoryRoot, 'infra/docker/m3b-subprocess.mjs')
const expectedStepIds = [
  'stage08-check',
  'compose-topology',
  'compose-topology-mutations',
  'api-runtime-image',
  'api-runtime-image-mutations',
  'local-test-negatives',
  'm3b-template-surface-sweep',
  'm3b-round2-negatives',
  'm3b-registry-integrity',
  'm3b-signal-windows',
  'local-test-smoke',
  'compose-secret-identity',
  'lifecycle-drill',
  'restore-drill'
]

const expectedActions = new Set([
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'docker/setup-docker-action@77e84dbf09b47d1e29270283c22f16145aa85ca1',
  'docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e',
  'docker/setup-compose-action@4eb059ff7f16592f9c84d5ca339c53cb7c5064e2'
])
const expectedWorkflowSha256 = '1bf308e1c997bf2ce92790d4683a8f9b786d571e37afe1d632e7e452e3773137'

const expectedPostgresql18Artifacts = [
  {
    url: 'https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/postgresql-client-18_18.4-1.pgdg24.04%2B1_amd64.deb',
    sha256: 'ff3fb9af478e4bdada47168681d9987917fd3170b043c612d6d01f0c923469c2'
  },
  {
    url: 'https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/postgresql-18_18.4-1.pgdg24.04%2B1_amd64.deb',
    sha256: '13f382b7c876ffafd98a43431007697827197da78a86dd01b4e5a3da5e3de5eb'
  }
]

const countLiteral = (source, literal) => source.split(literal).length - 1
const countLine = (source, expected) =>
  source.split('\n').filter((line) => line === expected).length

const ciPostgresql18PolicyProblems = (source) => {
  const problems = []
  if (!source.includes('if [ "$(dpkg --print-architecture)" != amd64 ]; then')) {
    problems.push('CI PostgreSQL packages must be bound to the reviewed amd64 runner architecture')
  }
  if (countLiteral(source, 'sudo apt-get update') !== 2) {
    problems.push('CI must refresh apt metadata before and after adding the PGDG repository')
  }
  if (
    countLiteral(
      source,
      "curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error"
    ) !== expectedPostgresql18Artifacts.length
  ) {
    problems.push('CI PostgreSQL artifacts must use the reviewed fail-closed HTTPS download shape')
  }
  for (const artifact of expectedPostgresql18Artifacts) {
    if (countLiteral(source, artifact.url) !== 1 || countLiteral(source, artifact.sha256) !== 1) {
      problems.push('CI PostgreSQL artifact URL and checksum allowlist drifted')
      break
    }
  }
  if (!source.includes('| sha256sum --check --strict')) {
    problems.push('CI PostgreSQL artifacts must pass strict SHA-256 verification before installation')
  }
  if (!source.includes('sudo apt-get install -y "$pg_client_deb" "$pg_server_deb"')) {
    problems.push('CI must install both reviewed PostgreSQL 18.4 artifacts')
  }
  if (/sudo apt-get install -y postgresql-(?:client-)?18(?:\s|$)/m.test(source)) {
    problems.push('CI must not install the floating PostgreSQL 18 package candidate')
  }
  if (!source.includes('for tool in createdb initdb pg_ctl postgres psql; do')) {
    problems.push('CI must expose all five PostgreSQL tools to the exact-version environment gate')
  }
  return problems
}

const ciDockerEvidencePolicyProblems = (source) => {
  const problems = []
  for (const action of [
    'docker/setup-docker-action@77e84dbf09b47d1e29270283c22f16145aa85ca1',
    'docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e',
    'docker/setup-compose-action@4eb059ff7f16592f9c84d5ca339c53cb7c5064e2'
  ]) {
    if (countLiteral(source, action) !== 1) {
      problems.push('CI Docker setup actions must be the reviewed immutable releases')
      break
    }
  }
  for (const expected of [
    '          version: v29.6.2',
    '          set-host: true',
    '                "containerd-snapshotter": true',
    '          version: v0.35.0',
    '          driver: docker',
    '          version: v5.3.1',
    '          if [ "$(docker version --format \'{{.Server.Version}}\')" != 29.6.2 ]; then',
    '          if [ "$(docker info --format \'{{json .DriverStatus}}\')" != \'[["driver-type","io.containerd.snapshotter.v1"]]\' ]; then',
    '          if [ "$(docker buildx version | awk \'{print $2}\')" != v0.35.0 ]; then',
    '          if [ "$(docker compose version --short)" != 5.3.1 ]; then'
  ]) {
    if (countLine(source, expected) !== 1) {
      problems.push('CI Docker 29.6.2 evidence capability policy drifted')
      break
    }
  }
  return problems
}

const ciWorkflowPolicyProblems = (source) => {
  const problems = []
  const actualSha256 = createHash('sha256').update(source).digest('hex')
  if (actualSha256 !== expectedWorkflowSha256) {
    problems.push('CI workflow must match the reviewed byte-for-byte policy')
    return problems
  }
  problems.push(...ciDockerEvidencePolicyProblems(source))
  problems.push(...ciPostgresql18PolicyProblems(source))
  const lines = source.split('\n')
  const executableSource = lines.filter((line) => !/^\s*#/.test(line)).join('\n')
  const uses = []
  for (const line of lines) {
    if (!/\buses:/.test(line)) continue
    const match = /^\s*-\s+uses:\s+(\S+)(?:\s+#.*)?$/.exec(line)
    if (match === null) {
      problems.push('CI action reference has an unsupported shape')
      continue
    }
    uses.push(match[1])
  }
  if (
    uses.length !== expectedActions.size ||
    uses.some((reference) => !expectedActions.has(reference)) ||
    [...expectedActions].some((reference) => !uses.includes(reference))
  ) {
    problems.push('CI actions must be the exact immutable allowlist')
  }
  if (uses.some((reference) => !/@[0-9a-f]{40}$/.test(reference))) {
    problems.push('CI actions must use immutable commit SHAs')
  }

  if (!/^permissions:\n  contents: read\n(?:\n|concurrency:)/m.test(source)) {
    problems.push('CI top-level permissions must be exactly contents: read')
  }
  if (lines.some((line) => /^\s+permissions:\s*$/.test(line))) {
    problems.push('CI jobs must not override top-level permissions')
  }
  if (!/^concurrency:\n  group: stage09a-[^\n]+\n  cancel-in-progress: true$/m.test(source)) {
    problems.push('CI concurrency cancellation must remain enabled')
  }

  const frozenInstalls = lines.filter(
    (line) => line.trim() === 'run: pnpm install --frozen-lockfile'
  ).length
  const allInstalls = (executableSource.match(/\bpnpm\s+install\b/g) ?? []).length
  if (frozenInstalls !== 1 || allInstalls !== 1) {
    problems.push('CI must perform one frozen-lockfile install')
  }

  const aggregateLines = lines.filter(
    (line) => line.trim() === 'run: pnpm stage09a:check'
  ).length
  const aggregateMentions = (executableSource.match(/\bpnpm\s+stage09a:check\b/g) ?? []).length
  if (aggregateLines !== 1 || aggregateMentions !== 1) {
    problems.push('CI must invoke the aggregate gate exactly once')
  }
  if (/continue-on-error|pull_request_target/.test(source)) {
    problems.push('CI contains a fail-open trigger or step option')
  }
  return problems
}

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

const processGroupIsAlive = (pgid) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

const writeExecutable = (path, source) => {
  writeFileSync(path, source)
  chmodSync(path, 0o700)
}

const createFixture = () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-stage09a-check-'))
  const bin = resolve(directory, 'bin')
  mkdirSync(bin)
  writeExecutable(
    resolve(bin, 'docker'),
    `#!/bin/sh
set -eu
if [ "\${1:-}" = version ]; then
  if [ "\${STAGE09A_FIXTURE_MODE:-}" = prerequisite-overflow ]; then
    head -c 1048576 /dev/zero | tr '\\000' A
    printf '%s\\n' 'UNTRUSTED-PREREQUISITE-OVERFLOW-SENTINEL'
    exit 0
  fi
  if [ "\${STAGE09A_FIXTURE_MODE:-}" = preflight ]; then
    printf '%s\\n' "$$" > "\${STAGE09A_FIXTURE_DIR}/probe-pid"
    : > "\${STAGE09A_FIXTURE_DIR}/probe-ready"
    sleep 30
  fi
  printf '%s\\n' 29.6.2
  exit 0
fi
if [ "\${1:-}" = compose ]; then
  printf '%s\\n' 5.3.1
  exit 0
fi
exit 97
`
  )
  writeExecutable(resolve(bin, 'git'), "#!/bin/sh\nprintf '%s\\n' 'git version 2.50.1'\n")
  writeFileSync(
    resolve(directory, 'grandchild.mjs'),
    "process.on('SIGTERM', () => {})\nprocess.on('SIGINT', () => {})\nsetInterval(() => {}, 1_000)\n"
  )
  writeFileSync(
    resolve(directory, 'nested-parent.mjs'),
    `import { spawn } from 'node:child_process'
import { writeFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const directory = process.env.STAGE09A_FIXTURE_DIR
const child = spawn(process.execPath, [resolve(directory, 'grandchild.mjs')], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore', 'ignore']
})
child.unref()
writeFileSync(resolve(directory, 'inner-pgid'), String(child.pid))
writeSync(3, 'GROUP ' + String(process.pid) + ' ' + String(child.pid) + ' 1\\n')

let settling = false
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (settling) return
    settling = true
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
      child.once('close', () => {
        writeFileSync(resolve(directory, 'nested-cleanup-complete'), signal)
        process.exit(71)
      })
    }, 1_500)
  })
}
setInterval(() => {}, 1_000)
`
  )
  writeFileSync(
    resolve(directory, 'shared-handler.mjs'),
    `import { writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { installSignalHandlers, runCommand } from ${JSON.stringify(subprocessModule)}
const directory = process.env.STAGE09A_FIXTURE_DIR
writeFileSync(directory + '/shared-ready', 'yes')
installSignalHandlers(async () => {
  writeFileSync(directory + '/shared-cleanup-started', 'yes')
  await delay(3_500)
  writeFileSync(directory + '/shared-cleanup-complete', 'yes')
  return []
}, { label: 'fixture cleanup' })
await runCommand(['/bin/sh', '-c', 'trap "" TERM INT HUP; sleep 30'], { timeoutMs: 60_000 })
`
  )
  writeFileSync(
    resolve(directory, 'partial-parent.mjs'),
    `import { spawn } from 'node:child_process'
import { writeFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const directory = process.env.STAGE09A_FIXTURE_DIR
const child = spawn(process.execPath, [resolve(directory, 'grandchild.mjs')], {
  detached: false,
  stdio: ['ignore', 'ignore', 'ignore', 'ignore']
})
child.unref()
writeFileSync(resolve(directory, 'grandchild-pid'), String(child.pid))
// EOF 不是数字 token 边界。这个 group 仍属于 controller 自己的 PGID，故聚合器
// 可经 controller ownership 安全回收它，但绝不能把截断数字当成独立 PGID。
writeSync(3, 'GROUP ' + String(process.pid) + ' ' + String(process.pid))
await delay(500)
`
  )
  writeFileSync(
    resolve(directory, 'overflow-generation-parent.mjs'),
    `import { spawn } from 'node:child_process'
import { writeFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const directory = process.env.STAGE09A_FIXTURE_DIR
const child = spawn(process.execPath, [resolve(directory, 'grandchild.mjs')], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore', 'ignore']
})
child.unref()
writeFileSync(resolve(directory, 'overflow-generation-pgid'), String(child.pid))
await delay(200)
writeSync(3, 'GROUP ' + String(process.pid) + ' ' + String(child.pid) + ' 999999999999999999999999999999\\n')
`
  )
  writeFileSync(
    resolve(directory, 'extra-token-parent.mjs'),
    `import { spawn } from 'node:child_process'
import { writeFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const directory = process.env.STAGE09A_FIXTURE_DIR
const child = spawn(process.execPath, [resolve(directory, 'grandchild.mjs')], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore', 'ignore']
})
child.unref()
writeFileSync(resolve(directory, 'grandchild-pid'), String(child.pid))
writeSync(3, 'GROUP ' + String(process.pid) + ' ' + String(child.pid) + ' 1 EXTRA\\n')
await delay(500)
`
  )
  writeFileSync(
    resolve(directory, 'empty-eof-parent.mjs'),
    `import { closeSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const directory = process.env.STAGE09A_FIXTURE_DIR
closeSync(3)
writeFileSync(directory + '/empty-eof-ready', 'yes')
await delay(500)
`
  )
  writeFileSync(
    resolve(directory, 'fd-holder-parent.mjs'),
    `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const directory = process.env.STAGE09A_FIXTURE_DIR
const child = spawn(process.execPath, [resolve(directory, 'grandchild.mjs')], {
  detached: false,
  stdio: ['ignore', 'ignore', 'ignore', 3]
})
child.unref()
writeFileSync(directory + '/fd-holder-pid', String(child.pid))
`
  )
  writeFileSync(
    resolve(directory, 'generation-replay-child.mjs'),
    `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.STAGE09A_FIXTURE_DIR + '/generation-replay-ready', 'yes')
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
setInterval(() => {}, 1_000)
`
  )
  writeFileSync(
    resolve(directory, 'generation-replay-parent.mjs'),
    `import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
const directory = process.env.STAGE09A_FIXTURE_DIR
const child = spawn(process.execPath, [resolve(directory, 'generation-replay-child.mjs')], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore']
})
child.unref()
writeFileSync(resolve(directory, 'generation-replay-pgid'), String(child.pid))
while (!existsSync(resolve(directory, 'generation-replay-ready'))) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
}
const frame = 'GROUP ' + String(process.pid) + ' ' + String(child.pid) + ' 1\\n'
writeSync(3, frame)
writeSync(3, frame)
writeSync(3, 'PRODUCER ' + String(process.pid) + ' DONE\\n')
`
  )
  writeFileSync(
    resolve(directory, 'cleanup-missing-done.mjs'),
    `import { writeSync } from 'node:fs'
writeSync(3, 'CLEANUP ' + String(process.pid) + ' START\\n')
`
  )
  writeFileSync(
    resolve(directory, 'cleanup-history-holder.mjs'),
    `import { spawn } from 'node:child_process'
import { writeFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
const directory = process.env.STAGE09A_FIXTURE_DIR
writeSync(3, 'CLEANUP ' + String(process.pid) + ' START\\n')
writeSync(3, 'CLEANUP ' + String(process.pid) + ' DONE\\n')
const child = spawn(process.execPath, [resolve(directory, 'grandchild.mjs')], {
  detached: false,
  stdio: ['ignore', 'ignore', 'ignore', 3]
})
child.unref()
writeFileSync(directory + '/cleanup-history-holder-pid', String(child.pid))
`
  )
  writeFileSync(
    resolve(directory, 'announcement-failure.mjs'),
    `import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { observedDescendantPgids, runCommand } from ${JSON.stringify(subprocessModule)}
const directory = process.env.STAGE09A_FIXTURE_DIR
writeFileSync(directory + '/announcement-ready', 'yes')
while (!existsSync(directory + '/announcement-go')) await delay(5)
let outcome = 'resolved'
try {
  await runCommand(['/bin/sh', '-c', 'trap "" TERM INT HUP; sleep 30'], { timeoutMs: 60_000 })
} catch (error) {
  outcome = error instanceof Error ? error.message : 'non-error'
}
writeFileSync(directory + '/announcement-outcome', outcome)
writeFileSync(directory + '/announcement-pgids', observedDescendantPgids().join('\\n'))
process.exit(outcome === 'aggregate ownership announcement failed' ? 7 : 8)
`
  )
  writeExecutable(
    resolve(bin, 'pnpm'),
    `#!/bin/sh
set -eu
if [ "\${1:-}" = --version ]; then
  printf '%s\\n' 11.9.0
  exit 0
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = preflight ]; then
  : > "\${STAGE09A_FIXTURE_DIR}/step-started"
  exit 9
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = ordinary-failure ]; then
  : > "\${STAGE09A_FIXTURE_DIR}/step-started"
  exit 73
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = nested-cleanup ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/nested-parent.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = shared-cleanup ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/shared-handler.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = ownership-partial ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/partial-parent.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = ownership-overflow-generation ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/overflow-generation-parent.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = ownership-extra-token ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/extra-token-parent.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = ownership-empty-eof ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/empty-eof-parent.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = ownership-fd-holder ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/fd-holder-parent.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = ownership-generation-replay ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/generation-replay-parent.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = cleanup-missing-done ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/cleanup-missing-done.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = cleanup-history-holder ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/cleanup-history-holder.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = announcement-failure ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/announcement-failure.mjs"
fi
if [ "\${STAGE09A_FIXTURE_MODE:-}" = descendant ] || [ "\${STAGE09A_FIXTURE_MODE:-}" = descendant-silent ]; then
  if [ "\${STAGE09A_FIXTURE_MODE:-}" = descendant-silent ]; then
    exec </dev/null >/dev/null 2>&1
    "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/grandchild.mjs" </dev/null >/dev/null 2>&1 &
  else
    "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/grandchild.mjs" &
  fi
  child_pid=$!
  printf '%s\\n' "$child_pid" > "\${STAGE09A_FIXTURE_DIR}/grandchild-pid"
  wait "$child_pid"
fi
exit 98
`
  )
  return { directory, bin }
}

const spawnGate = ({ directory, bin }, mode, gateEntrypoint = entrypoint) => {
  const stdout = []
  const stderr = []
  const child = spawn(process.execPath, [realpathSync(gateEntrypoint)], {
    cwd: repositoryRoot,
    // 测试 runner 自己属于正式 stage08 链；不能再派生一个聚合器不可见的
    // detached 根。被测聚合器会为它自己的 step controller 建组并负责收敛。
    detached: false,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      STAGE09A_FIXTURE_DIR: directory,
      STAGE09A_FIXTURE_MODE: mode,
      STAGE09A_FIXTURE_NODE: process.execPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  return { child, stdout, stderr }
}

test('the Audit-B presentation sink suppresses core and child stdout and stderr', () => {
  const fixture = createFixture()
  const mutatedEntrypoint = resolve(fixture.directory, 'audit-presentation-stage09a.mjs')
  const registryPath = resolve(fixture.directory, 'audit-presentation-registry.mjs')
  const stepPath = resolve(fixture.directory, 'audit-presentation-step.mjs')
  const runnerPath = resolve(fixture.directory, 'audit-presentation-runner.mjs')
  const sentinel = 'AUDIT-PRESENTATION-UNTRUSTED-SENTINEL'
  try {
    writeFileSync(
      stepPath,
      `process.stdout.write(${JSON.stringify(`${sentinel}-OUT\\n`)})\n` +
        `process.stderr.write(${JSON.stringify(`${sentinel}-ERR\\n`)})\n`
    )
    writeFileSync(
      registryPath,
      `export const stage09aSteps = Object.freeze([Object.freeze({\n` +
        `  id: 'audit-presentation-fixture',\n` +
        `  title: 'audit presentation fixture',\n` +
        `  argv: Object.freeze([${JSON.stringify(process.execPath)}, ${JSON.stringify(stepPath)}]),\n` +
        `  timeoutMs: 10_000,\n` +
        `  forwardsKeepFailure: false\n` +
        `})])\n`
    )
    const originalSource = readFileSync(entrypoint, 'utf8')
    const mutatedSource = originalSource
      .replace(
        "from './stage09a-prerequisite-evidence.mjs'",
        `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-prerequisite-evidence.mjs'))}`
      )
      .replace(
        "from './stage09a-gate-registry.mjs'",
        `from ${JSON.stringify(registryPath)}`
      )
      .replace(
        "const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))",
        `const repositoryRoot = ${JSON.stringify(repositoryRoot)}`
      )
    assert.notEqual(mutatedSource, originalSource)
    writeFileSync(mutatedEntrypoint, mutatedSource)
    writeFileSync(
      runnerPath,
      `import { runStage09aCheckForAudit } from ${JSON.stringify(mutatedEntrypoint)}\n` +
        `await runStage09aCheckForAudit([])\n`
    )
    const outcome = spawnSync(process.execPath, [runnerPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
        STAGE09A_FIXTURE_DIR: fixture.directory,
        STAGE09A_FIXTURE_MODE: 'audit-presentation',
        STAGE09A_FIXTURE_NODE: process.execPath
      }
    })
    assert.equal(outcome.status, 0, outcome.stderr)
    assert.equal(outcome.signal, null)
    assert.equal(outcome.stdout, '')
    assert.equal(outcome.stderr, '')
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('the aggregate waits for nested scoped cleanup and every announced process group', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  let innerPgid = null
  try {
    gate = spawnGate(fixture, 'nested-cleanup')
    const pidFile = resolve(fixture.directory, 'inner-pgid')
    await waitFor(() => existsSync(pidFile), 3_000, 'nested process-group announcement')
    innerPgid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(processIsAlive(innerPgid), true, 'the negative must begin with a live nested group')
    gate.child.kill('SIGTERM')
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, null)
    assert.equal(outcome.signal, 'SIGTERM')
    assert.equal(
      existsSync(resolve(fixture.directory, 'nested-cleanup-complete')),
      true,
      'the aggregate must not exit before the scoped cleanup completes'
    )
    await waitFor(() => !processIsAlive(innerPgid), 1_000, 'nested process-group ESRCH')
    assert.match(output, /interrupted by SIGTERM/)
  } finally {
    if (innerPgid !== null && processIsAlive(innerPgid)) {
      process.kill(-innerPgid, 'SIGKILL')
      await waitFor(() => !processIsAlive(innerPgid), 1_000, 'fixture cleanup ESRCH')
    }
    if (gate !== null && processIsAlive(gate.child.pid)) {
      gate.child.kill('SIGKILL')
    }
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('the aggregate waits beyond the fallback window for shared cleanup acknowledgement', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  try {
    gate = spawnGate(fixture, 'shared-cleanup')
    await waitFor(
      () => existsSync(resolve(fixture.directory, 'shared-ready')),
      3_000,
      'shared handler readiness'
    )
    gate.child.kill('SIGHUP')
    const outcome = await waitForClose(gate.child, 9_000)
    assert.equal(outcome.code, null)
    assert.equal(outcome.signal, 'SIGHUP')
    assert.equal(existsSync(resolve(fixture.directory, 'shared-cleanup-started')), true)
    assert.equal(existsSync(resolve(fixture.directory, 'shared-cleanup-complete')), true)
  } finally {
    if (gate !== null && processIsAlive(gate.child.pid)) {
      gate.child.kill('SIGKILL')
    }
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('an EOF-partial ownership frame fails closed and the announced group reaches ESRCH', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  let pgid = null
  try {
    gate = spawnGate(fixture, 'ownership-partial')
    const pidFile = resolve(fixture.directory, 'grandchild-pid')
    await waitFor(() => existsSync(pidFile), 3_000, 'partial-frame group')
    pgid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(processIsAlive(pgid), true)
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.match(output, /ownership channel failed/)
    await waitFor(() => !processGroupIsAlive(pgid), 4_000, 'partial-frame group ESRCH')
  } finally {
    if (pgid !== null && processIsAlive(pgid)) {
      process.kill(-pgid, 'SIGKILL')
    }
    if (gate !== null && processIsAlive(gate.child.pid)) {
      gate.child.kill('SIGKILL')
    }
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a complete frame with an overflowing generation quarantines its proven PGID', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  let pgid = null
  try {
    gate = spawnGate(fixture, 'ownership-overflow-generation')
    const pidFile = resolve(fixture.directory, 'overflow-generation-pgid')
    await waitFor(() => existsSync(pidFile), 3_000, 'overflow-generation group')
    pgid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(processGroupIsAlive(pgid), true)
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.match(output, /ownership channel failed/)
    await waitFor(() => !processGroupIsAlive(pgid), 4_000, 'overflow-generation group ESRCH')
  } finally {
    if (pgid !== null && processGroupIsAlive(pgid)) process.kill(-pgid, 'SIGKILL')
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('EOF is not accepted as the end of a partial PGID token', () => {
  const source = readFileSync(entrypoint, 'utf8')
  assert.match(source, /\(\?=\[\^0-9\]\)/)
  assert.doesNotMatch(source, /\(\?=\[\^0-9\]\|\$\)/)
})

test('a recognizable PGID with an extra token fails closed and still reaches ESRCH', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  let pgid = null
  try {
    gate = spawnGate(fixture, 'ownership-extra-token')
    const pidFile = resolve(fixture.directory, 'grandchild-pid')
    await waitFor(() => existsSync(pidFile), 3_000, 'malformed-frame group')
    pgid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(processIsAlive(pgid), true)
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.match(output, /ownership channel failed/)
    await waitFor(() => !processIsAlive(pgid), 1_000, 'malformed-frame group ESRCH')
  } finally {
    if (pgid !== null && processIsAlive(pgid)) process.kill(-pgid, 'SIGKILL')
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('the controller retains ownership when the direct command closes its inherited fd', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  try {
    gate = spawnGate(fixture, 'ownership-empty-eof')
    await waitFor(() => existsSync(resolve(fixture.directory, 'empty-eof-ready')), 3_000, 'empty EOF')
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.match(output, /PASS stage08-check/)
    assert.doesNotMatch(output, /FAIL stage08-check .*ownership channel failed/)
  } finally {
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a leader exit with an inherited fd3 holder fails closed and cleans the controller group', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  let holderPid = null
  try {
    gate = spawnGate(fixture, 'ownership-fd-holder')
    const pidFile = resolve(fixture.directory, 'fd-holder-pid')
    await waitFor(() => existsSync(pidFile), 3_000, 'fd3 holder pid')
    holderPid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(processIsAlive(holderPid), true)
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.match(output, /ownership channel failed/)
    await waitFor(() => !processIsAlive(holderPid), 1_000, 'fd3 holder ESRCH')
  } finally {
    if (holderPid !== null && processIsAlive(holderPid)) process.kill(holderPid, 'SIGKILL')
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('an ownership generation replay fails at the protocol boundary and cleans the exact group', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  let pgid = null
  try {
    gate = spawnGate(fixture, 'ownership-generation-replay')
    const pidFile = resolve(fixture.directory, 'generation-replay-pgid')
    await waitFor(() => existsSync(pidFile), 3_000, 'generation replay group')
    await waitFor(
      () => existsSync(resolve(fixture.directory, 'generation-replay-ready')),
      3_000,
      'generation replay child readiness'
    )
    pgid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(processIsAlive(pgid), true)
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.match(output, /ownership channel failed/)
    assert.doesNotMatch(output, /left 1 descendant process group/)
    await waitFor(() => !processIsAlive(pgid), 1_000, 'generation replay group ESRCH')
  } finally {
    if (pgid !== null && processIsAlive(pgid)) process.kill(-pgid, 'SIGKILL')
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('cleanup START without DONE can never become a successful step', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  try {
    gate = spawnGate(fixture, 'cleanup-missing-done')
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.match(output, /ownership channel failed/)
  } finally {
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a completed cleanup frame cannot hide a later fd3 holder', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  let holderPid = null
  try {
    gate = spawnGate(fixture, 'cleanup-history-holder')
    const pidFile = resolve(fixture.directory, 'cleanup-history-holder-pid')
    await waitFor(() => existsSync(pidFile), 3_000, 'post-cleanup fd3 holder')
    holderPid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(processIsAlive(holderPid), true)
    gate.child.kill('SIGTERM')
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, null)
    assert.equal(outcome.signal, 'SIGTERM')
    assert.match(output, /ownership channel failed|interrupted by SIGTERM/)
    await waitFor(() => !processIsAlive(holderPid), 1_500, 'post-cleanup holder ESRCH')
  } finally {
    if (holderPid !== null && processIsAlive(holderPid)) process.kill(holderPid, 'SIGKILL')
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('an ownership diagnostic EPIPE is local-cleaned before the caller can settle', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let child = null
  try {
    child = spawn(process.execPath, [resolve(fixture.directory, 'announcement-failure.mjs')], {
      cwd: repositoryRoot,
      detached: true,
      env: { ...process.env, STAGE09A_FIXTURE_DIR: fixture.directory },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    await waitFor(
      () => existsSync(resolve(fixture.directory, 'announcement-ready')),
      2_000,
      'announcement readiness'
    )
    child.stderr.destroy()
    writeFileSync(resolve(fixture.directory, 'announcement-go'), 'yes')
    const outcome = await waitForClose(child, 7_000)
    const result = readFileSync(resolve(fixture.directory, 'announcement-outcome'), 'utf8')
    const pgids = readFileSync(resolve(fixture.directory, 'announcement-pgids'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(Number)
    assert.equal(result, 'aggregate ownership announcement failed')
    assert.equal(pgidssafe(pgids), true)
    assert.equal(outcome.code, 7)
    for (const pgid of pgids) {
      await waitFor(() => !processIsAlive(pgid), 1_000, 'announcement-failure group ESRCH')
    }
  } finally {
    if (child !== null && processIsAlive(child.pid)) process.kill(-child.pid, 'SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

const pgidssafe = (pgids) =>
  pgids.length === 1 && pgids.every((pgid) => Number.isSafeInteger(pgid) && pgid > 0)

const waitForClose = (child, timeoutMs) =>
  new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`stage09a:check did not close within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal })
    })
  })

test('oversized prerequisite evidence fails closed before any gate starts', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  try {
    gate = spawnGate(fixture, 'prerequisite-overflow')
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.equal(outcome.signal, null)
    assert.doesNotMatch(output, /UNTRUSTED-PREREQUISITE-OVERFLOW-SENTINEL/)
    assert.equal(existsSync(resolve(fixture.directory, 'step-started')), false)
  } finally {
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('the aggregate registry keeps the exact accepted gate order', () => {
  const source = readFileSync(entrypoint, 'utf8')
  assert.match(source, /import \{ stage09aSteps \} from '\.\/stage09a-gate-registry\.mjs'/)
  assert.deepEqual([...stage09aStepIds], expectedStepIds)
})

test('every host detached spawn in the formal chain has an explicit ownership boundary', () => {
  const listing = spawnSync(
    'git',
    ['ls-files', '-z', '--', 'infra', 'scripts', 'services'],
    { cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }
  )
  assert.equal(listing.error, undefined)
  assert.equal(listing.status, 0)
  const files = Buffer.from(listing.stdout)
    .toString('utf8')
    .split('\0')
    .filter((file) => /\.(?:mjs|js|ts)$/.test(file))
  const sites = []
  for (const file of files) {
    const source = readFileSync(resolve(repositoryRoot, file), 'utf8')
    for (const line of source.split('\n')) {
      const trimmed = line.trim()
      if (
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*') &&
        /\bdetached\s*:\s*true\b/.test(line)
      ) {
        sites.push(file)
      }
    }
  }
  assert.deepEqual(
    sites.sort(),
    [
      'infra/docker/check-local-test-negatives.mjs',
      'infra/docker/check-m3b-round2-negatives.mjs',
      'infra/docker/check-m3b-signal-windows.mjs',
      'infra/docker/m3b-subprocess.mjs',
      'infra/docker/postgres/no-ctty.mjs',
      'scripts/run-stage09a-check.mjs',
      'scripts/tests/m5-remediation.test.mjs',
      'scripts/tests/stage09a-check.test.mjs',
      'scripts/tests/stage09a-check.test.mjs',
      'scripts/tests/stage09a-check.test.mjs',
      'scripts/tests/stage09a-check.test.mjs',
      'scripts/tests/stage09a-check.test.mjs'
    ],
    'a new detached spawn must be registered or explicitly proven container-internal'
  )
  for (const file of sites.filter((file) => /check-(?:local-test|m3b)/.test(file))) {
    const source = readFileSync(resolve(repositoryRoot, file), 'utf8')
    assert.match(source, /await registerRawSpawnedChild\(/)
    assert.match(source, /ownershipAwareSpawnStdio\(/)
  }
  assert.match(
    readFileSync(resolve(repositoryRoot, 'scripts/run-stage09a-check.mjs'), 'utf8'),
    /spawn\(process\.execPath, \[stepController, JSON\.stringify\(argv\)\]/
  )
  assert.match(
    readFileSync(resolve(repositoryRoot, 'infra/docker/postgres/no-ctty.mjs'), 'utf8'),
    /ownership exception: 这是 Docker 容器内部/
  )
})

test('the CI PostgreSQL 18.4 installer rejects floating or unverifiable toolchains', () => {
  const source = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
  assert.deepEqual(ciPostgresql18PolicyProblems(source), [])

  const mutations = [
    source.replace('if [ "$(dpkg --print-architecture)" != amd64 ]; then', 'if false; then'),
    source.replace('postgresql-client-18_18.4-1.pgdg24.04%2B1_amd64.deb', 'postgresql-client-18_18.6-1.pgdg24.04%2B2_amd64.deb'),
    source.replace(
      '13f382b7c876ffafd98a43431007697827197da78a86dd01b4e5a3da5e3de5eb',
      '03f382b7c876ffafd98a43431007697827197da78a86dd01b4e5a3da5e3de5eb'
    ),
    source.replace('| sha256sum --check --strict', '| true'),
    source.replace(
      'sudo apt-get install -y "$pg_client_deb" "$pg_server_deb"',
      'sudo apt-get install -y postgresql-18'
    ),
    source.replace(
      'for tool in createdb initdb pg_ctl postgres psql; do',
      'for tool in postgres; do'
    ),
    source.replace(
      "curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error",
      "curl --proto '=https' --tlsv1.2 --location --silent --show-error"
    )
  ]
  for (const mutant of mutations) {
    assert.notDeepEqual(ciPostgresql18PolicyProblems(mutant), [])
  }
})

test('the CI Docker evidence environment is immutable and capability-complete', () => {
  const source = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
  assert.deepEqual(ciDockerEvidencePolicyProblems(source), [])

  const mutations = [
    source.replace(
      'docker/setup-docker-action@77e84dbf09b47d1e29270283c22f16145aa85ca1',
      'docker/setup-docker-action@v5'
    ),
    source.replace(
      'docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e',
      'docker/setup-buildx-action@v4'
    ),
    source.replace(
      'docker/setup-compose-action@4eb059ff7f16592f9c84d5ca339c53cb7c5064e2',
      'docker/setup-compose-action@v2'
    ),
    source.replace('          version: v29.6.2', '          version: latest'),
    source.replace('          set-host: true', '          set-host: false'),
    source.replace(
      '                "containerd-snapshotter": true',
      '                "containerd-snapshotter": false'
    ),
    source.replace('          version: v0.35.0', '          version: latest'),
    source.replace('          driver: docker', '          driver: docker-container'),
    source.replace('          version: v5.3.1', '          version: latest'),
    source.replace(
      '          if [ "$(docker version --format \'{{.Server.Version}}\')" != 29.6.2 ]; then',
      '          if false; then'
    ),
    source.replace(
      '          if [ "$(docker info --format \'{{json .DriverStatus}}\')" != \'[["driver-type","io.containerd.snapshotter.v1"]]\' ]; then',
      '          if false; then'
    ),
    source.replace(
      '          if [ "$(docker buildx version | awk \'{print $2}\')" != v0.35.0 ]; then',
      '          if false; then'
    ),
    source.replace(
      '          if [ "$(docker compose version --short)" != 5.3.1 ]; then',
      '          if false; then'
    )
  ]
  for (const mutant of mutations) {
    assert.notDeepEqual(ciDockerEvidencePolicyProblems(mutant), [])
  }
})

test('the CI workflow policy rejects every audited weakening shape', () => {
  const source = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
  assert.deepEqual(ciWorkflowPolicyProblems(source), [])

  const mutations = [
    source.replace('cancel-in-progress: true', 'cancel-in-progress: false'),
    source.replace('pnpm install --frozen-lockfile', 'pnpm install'),
    source.replace('    runs-on: ubuntu-latest', '    permissions:\n      contents: write\n    runs-on: ubuntu-latest'),
    source.replace(
      '      - name: Install workspace dependencies',
      '      - uses: actions/cache@v4\n\n      - name: Install workspace dependencies'
    ),
    source.replace(
      '        run: pnpm stage09a:check',
      '        run: |\n          pnpm stage09a:check\n          pnpm stage09a:check'
    )
  ]
  for (const mutant of mutations) {
    assert.notDeepEqual(ciWorkflowPolicyProblems(mutant), [])
  }

  for (const mutant of [
    source.replace(
      '      - name: Install workspace dependencies',
      '      - name: injected\n        "uses": actions/cache@v4\n\n      - name: Install workspace dependencies'
    ),
    source.replace(
      '      - name: Stage 09A full gate (same single entry point as local)',
      '      - name: Stage 09A full gate (same single entry point as local)\n        if: ${{ false }}'
    ),
    source.replace('    runs-on: ubuntu-latest', '    permissions: write-all\n    runs-on: ubuntu-latest'),
    source.replace('        run: pnpm stage09a:check', '        run: |\n          pnpm stage09a:check')
  ]) {
    assert.deepEqual(ciWorkflowPolicyProblems(mutant), [
      'CI workflow must match the reviewed byte-for-byte policy'
    ])
  }
})

test('a signal during prerequisite probes prevents every gate step from starting', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  try {
    gate = spawnGate(fixture, 'preflight')
    await waitFor(() => existsSync(resolve(fixture.directory, 'probe-ready')), 2_000, 'probe readiness')
    gate.child.kill('SIGTERM')
    const outcome = await waitForClose(gate.child, 6_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')

    assert.equal(outcome.code, null)
    assert.equal(outcome.signal, 'SIGTERM')
    assert.equal(existsSync(resolve(fixture.directory, 'step-started')), false)
    assert.match(output, /interrupted by SIGTERM during prerequisite checks; no checks were run/)
    assert.doesNotMatch(output, /stage09a:check step 1\/14/)
  } finally {
    if (gate !== null && processIsAlive(gate.child.pid)) {
      gate.child.kill('SIGKILL')
    }
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a signal waits for the active step process group to reach ESRCH', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  let grandchildPid = null
  try {
    gate = spawnGate(fixture, 'descendant')
    const pidFile = resolve(fixture.directory, 'grandchild-pid')
    await waitFor(() => existsSync(pidFile), 3_000, 'descendant pid')
    grandchildPid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, true)
    assert.equal(processIsAlive(grandchildPid), true, 'the negative must begin with a live descendant')

    gate.child.kill('SIGTERM')
    const outcome = await waitForClose(gate.child, 7_000)
    await waitFor(() => !processIsAlive(grandchildPid), 1_000, 'descendant ESRCH')
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')

    assert.equal(outcome.code, null)
    assert.equal(outcome.signal, 'SIGTERM')
    assert.match(output, /received SIGTERM; terminating the controlled process subtree/)
    assert.match(output, /FAIL at step stage08-check \(interrupted by SIGTERM\)/)
  } finally {
    if (grandchildPid !== null && processIsAlive(grandchildPid)) {
      process.kill(grandchildPid, 'SIGKILL')
    }
    if (gate !== null && processIsAlive(gate.child.pid)) {
      gate.child.kill('SIGKILL')
    }
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a termination primitive exception is fixed-output, bounded, and does not skip later cleanup', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  const mutatedEntrypoint = resolve(fixture.directory, 'primitive-failure-stage09a.mjs')
  const sentinel = 'TERMINATION-PRIMITIVE-SENTINEL'
  const originalSource = readFileSync(entrypoint, 'utf8')
  const mutatedSource = originalSource
    .replace(
      "from './stage09a-prerequisite-evidence.mjs'",
      `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-prerequisite-evidence.mjs'))}`
    )
    .replace(
      "from './stage09a-gate-registry.mjs'",
      `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-gate-registry.mjs'))}`
    )
    .replace(
      "const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))",
      `const repositoryRoot = ${JSON.stringify(repositoryRoot)}`
    )
    .replace(
      'const nativeKill = process.kill.bind(process)',
      `let primitiveFailureInjected = false
const nativeKill = (pid, signal) => {
  if (!primitiveFailureInjected && pid < 0 && signal === 'SIGTERM') {
    primitiveFailureInjected = true
    throw new Error(${JSON.stringify(sentinel)})
  }
  return process.kill(pid, signal)
}`
    )
  assert.notEqual(mutatedSource, originalSource)
  writeFileSync(mutatedEntrypoint, mutatedSource)

  let gate = null
  let grandchildPid = null
  try {
    gate = spawnGate(fixture, 'descendant', mutatedEntrypoint)
    const pidFile = resolve(fixture.directory, 'grandchild-pid')
    try {
      await waitFor(() => existsSync(pidFile), 3_000, 'primitive-failure descendant')
    } catch (error) {
      const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
      throw new Error(`${error.message}; child output: ${output}`)
    }
    grandchildPid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(processIsAlive(grandchildPid), true)
    gate.child.kill('SIGTERM')
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.equal(outcome.signal, null)
    assert.match(output, /signal cleanup primitive failed/)
    assert.doesNotMatch(output, new RegExp(sentinel))
    await waitFor(() => !processIsAlive(grandchildPid), 1_000, 'primitive-failure ESRCH')
  } finally {
    if (grandchildPid !== null && processIsAlive(grandchildPid)) {
      process.kill(grandchildPid, 'SIGKILL')
    }
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

for (const signal of ['SIGINT', 'SIGHUP']) {
  test(`${signal} during prerequisite probes prevents every gate step and cleans its group`, { timeout: 12_000 }, async () => {
    const fixture = createFixture()
    let gate = null
    try {
      gate = spawnGate(fixture, 'preflight')
      await waitFor(() => existsSync(resolve(fixture.directory, 'probe-ready')), 2_000, 'probe readiness')
      const probePid = Number(readFileSync(resolve(fixture.directory, 'probe-pid'), 'utf8').trim())
      assert.equal(processIsAlive(probePid), true)
      gate.child.kill(signal)
      const outcome = await waitForClose(gate.child, 6_000)
      const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
      assert.equal(outcome.code, null, output)
      assert.equal(outcome.signal, signal, output)
      assert.equal(existsSync(resolve(fixture.directory, 'step-started')), false)
      assert.match(output, new RegExp(`interrupted by ${signal} during prerequisite checks`))
      await waitFor(() => !processIsAlive(probePid), 1_000, 'prerequisite group ESRCH')
    } finally {
      if (gate !== null && processIsAlive(gate.child.pid)) {
        gate.child.kill('SIGKILL')
      }
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  test(`${signal} waits for an active TERM-ignoring descendant to reach ESRCH`, { timeout: 12_000 }, async () => {
    const fixture = createFixture()
    let gate = null
    let grandchildPid = null
    try {
      gate = spawnGate(fixture, 'descendant')
      const pidFile = resolve(fixture.directory, 'grandchild-pid')
      await waitFor(() => existsSync(pidFile), 3_000, 'descendant pid')
      grandchildPid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.equal(processIsAlive(grandchildPid), true)
      gate.child.kill(signal)
      const outcome = await waitForClose(gate.child, 7_000)
      await waitFor(() => !processIsAlive(grandchildPid), 1_000, 'descendant ESRCH')
      const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
      if (/signal cleanup primitive failed/.test(output)) {
        assert.equal(outcome.code, 1, output)
        assert.equal(outcome.signal, null, output)
      } else {
        assert.equal(outcome.code, null, output)
        assert.equal(outcome.signal, signal, output)
      }
      assert.match(output, new RegExp(`received ${signal}`))
      assert.match(
        output,
        new RegExp(`(?:interrupted by ${signal}|signal cleanup primitive failed)`)
      )
    } finally {
      if (grandchildPid !== null && processIsAlive(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL')
      }
      if (gate !== null && processIsAlive(gate.child.pid)) {
        gate.child.kill('SIGKILL')
      }
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })
}

test('ordinary child failures are normalized to exit 1', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  try {
    gate = spawnGate(fixture, 'ordinary-failure')
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.equal(outcome.signal, null)
    assert.match(output, /FAIL at step stage08-check \(exit 73\)/)
  } finally {
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`a ${signal} delivered after the aggregate result is rethrown after settlement`, { timeout: 12_000 }, async () => {
    const fixture = createFixture()
    const mutatedEntrypoint = resolve(fixture.directory, `settlement-${signal}.mjs`)
    const originalSource = readFileSync(entrypoint, 'utf8')
    const mutatedSource = originalSource
      .replace(
        "from './stage09a-prerequisite-evidence.mjs'",
        `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-prerequisite-evidence.mjs'))}`
      )
      .replace(
        "from './stage09a-gate-registry.mjs'",
        `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-gate-registry.mjs'))}`
      )
      .replace(
        "const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))",
        `const repositoryRoot = ${JSON.stringify(repositoryRoot)}`
      )
      .replace(
        'const settlement = await settleAggregateProcess(ordinaryExitCode)',
        `process.kill(process.pid, ${JSON.stringify(signal)})\n  const settlement = await settleAggregateProcess(ordinaryExitCode)`
      )
    assert.notEqual(mutatedSource, originalSource)
    writeFileSync(mutatedEntrypoint, mutatedSource)
    let gate = null
    try {
      gate = spawnGate(fixture, 'ordinary-failure', mutatedEntrypoint)
      const outcome = await waitForClose(gate.child, 7_000)
      const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
      assert.equal(outcome.code, null)
      assert.equal(outcome.signal, signal)
      assert.match(output, /FAIL at step stage08-check \(exit 73\)/)
      assert.match(output, new RegExp(`received ${signal}`))
    } finally {
      if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })
}

test('a step timer creation exception settles only after the owned group reaches ESRCH', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  const mutatedEntrypoint = resolve(fixture.directory, 'timer-create-failure-stage09a.mjs')
  const sentinel = 'TIMER-CREATE-PRIMITIVE-SENTINEL'
  const originalSource = readFileSync(entrypoint, 'utf8')
  const mutatedSource = originalSource
    .replace(
      "from './stage09a-prerequisite-evidence.mjs'",
      `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-prerequisite-evidence.mjs'))}`
    )
    .replace(
      "from './stage09a-gate-registry.mjs'",
      `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-gate-registry.mjs'))}`
    )
    .replace(
      "const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))",
      `const repositoryRoot = ${JSON.stringify(repositoryRoot)}`
    )
    .replace(
      'const nativeSetTimeout = globalThis.setTimeout.bind(globalThis)',
      `const capturedSetTimeout = globalThis.setTimeout.bind(globalThis)
const nativeSetTimeout = (callback, milliseconds, ...args) => {
  if (milliseconds === 2_400_000) {
    const exists = process.getBuiltinModule('node:fs').existsSync
    const marker = process.env.STAGE09A_FIXTURE_DIR + '/grandchild-pid'
    const deadline = Date.now() + 3_000
    while (!exists(marker) && Date.now() < deadline) {}
    throw new Error(${JSON.stringify(sentinel)})
  }
  return capturedSetTimeout(callback, milliseconds, ...args)
}`
    )
  assert.notEqual(mutatedSource, originalSource)
  writeFileSync(mutatedEntrypoint, mutatedSource)
  let gate = null
  let grandchildPid = null
  try {
    gate = spawnGate(fixture, 'descendant', mutatedEntrypoint)
    const pidFile = resolve(fixture.directory, 'grandchild-pid')
    await waitFor(() => existsSync(pidFile), 4_000, 'timer-create descendant')
    grandchildPid = Number(readFileSync(pidFile, 'utf8').trim())
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.equal(outcome.signal, null)
    assert.match(output, /aggregate lifecycle primitive failed/)
    assert.doesNotMatch(output, new RegExp(sentinel))
    await waitFor(() => !processIsAlive(grandchildPid), 1_000, 'timer-create ESRCH')
  } finally {
    if (grandchildPid !== null && processIsAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL')
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a post-fork descriptor primitive failure is cleaned through the already registered PGID', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  const mutatedEntrypoint = resolve(fixture.directory, 'post-fork-close-failure-stage09a.mjs')
  const originalSource = readFileSync(entrypoint, 'utf8')
  const mutatedSource = originalSource
    .replace(
      "from './stage09a-prerequisite-evidence.mjs'",
      `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-prerequisite-evidence.mjs'))}`
    )
    .replace(
      "from './stage09a-gate-registry.mjs'",
      `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-gate-registry.mjs'))}`
    )
    .replace(
      "const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))",
      `const repositoryRoot = ${JSON.stringify(repositoryRoot)}`
    )
    .replace(
      '    let controllerHandle = null',
      `    writeFileSync(resolve(process.env.STAGE09A_FIXTURE_DIR, 'post-fork-controller-pgid'), String(child.pid))
    let controllerHandle = null`
    )
    .replace('  closeSync,', '  closeSync as nativeCloseSync,')
    .replace(
      "const safeWrite = (fd, message) => {",
      `let closeFailureInjected = false
const closeSync = (fd) => {
  if (!closeFailureInjected) {
    closeFailureInjected = true
    throw new Error('POST-FORK-CLOSE-SENTINEL')
  }
  return nativeCloseSync(fd)
}

const safeWrite = (fd, message) => {`
    )
  assert.notEqual(mutatedSource, originalSource)
  writeFileSync(mutatedEntrypoint, mutatedSource)
  let gate = null
  let controllerPgid = null
  try {
    gate = spawnGate(fixture, 'descendant-silent', mutatedEntrypoint)
    const pgidFile = resolve(fixture.directory, 'post-fork-controller-pgid')
    await waitFor(() => existsSync(pgidFile), 4_000, 'post-fork controller ownership')
    controllerPgid = Number(readFileSync(pgidFile, 'utf8').trim())
    assert.equal(Number.isSafeInteger(controllerPgid) && controllerPgid > 0, true)
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.equal(outcome.signal, null)
    assert.doesNotMatch(output, /POST-FORK-CLOSE-SENTINEL/)
    await waitFor(() => !processGroupIsAlive(controllerPgid), 2_000, 'post-fork controller ESRCH')
  } finally {
    if (controllerPgid !== null && processGroupIsAlive(controllerPgid)) {
      try { process.kill(-controllerPgid, 'SIGKILL') } catch {}
    }
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a step timer clear exception is fixed-output and cleanup-before-settlement', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  const mutatedEntrypoint = resolve(fixture.directory, 'timer-clear-failure-stage09a.mjs')
  const sentinel = 'TIMER-CLEAR-PRIMITIVE-SENTINEL'
  const originalSource = readFileSync(entrypoint, 'utf8')
  const mutatedSource = originalSource
    .replace(
      "from './stage09a-prerequisite-evidence.mjs'",
      `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-prerequisite-evidence.mjs'))}`
    )
    .replace(
      "from './stage09a-gate-registry.mjs'",
      `from ${JSON.stringify(resolve(repositoryRoot, 'scripts/stage09a-gate-registry.mjs'))}`
    )
    .replace(
      "const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))",
      `const repositoryRoot = ${JSON.stringify(repositoryRoot)}`
    )
    .replace(
      'const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis)',
      `const capturedClearTimeout = globalThis.clearTimeout.bind(globalThis)
let clearFailureInjected = false
const nativeClearTimeout = (timer) => {
  const exists = process.getBuiltinModule('node:fs').existsSync
  if (!clearFailureInjected && exists(process.env.STAGE09A_FIXTURE_DIR + '/step-started')) {
    clearFailureInjected = true
    throw new Error(${JSON.stringify(sentinel)})
  }
  return capturedClearTimeout(timer)
}`
    )
  assert.notEqual(mutatedSource, originalSource)
  writeFileSync(mutatedEntrypoint, mutatedSource)
  let gate = null
  try {
    gate = spawnGate(fixture, 'ordinary-failure', mutatedEntrypoint)
    const outcome = await waitForClose(gate.child, 7_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.equal(outcome.signal, null)
    assert.match(output, /process-group ownership probe failed|aggregate lifecycle primitive failed/)
    assert.doesNotMatch(output, new RegExp(sentinel))
  } finally {
    if (gate !== null && processIsAlive(gate.child.pid)) gate.child.kill('SIGKILL')
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})
