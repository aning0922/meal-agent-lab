import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const entrypoint = resolve(repositoryRoot, 'scripts/run-stage09a-check.mjs')
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
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
])

const ciWorkflowPolicyProblems = (source) => {
  const problems = []
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
  if [ "\${STAGE09A_FIXTURE_MODE:-}" = preflight ]; then
    : > "\${STAGE09A_FIXTURE_DIR}/probe-ready"
    printf '%s\\n' "$$" > "\${STAGE09A_FIXTURE_DIR}/probe-pid"
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

const directory = process.env.STAGE09A_FIXTURE_DIR
const child = spawn(process.execPath, [resolve(directory, 'grandchild.mjs')], {
  detached: true,
  stdio: 'ignore'
})
writeFileSync(resolve(directory, 'inner-pgid'), String(child.pid))
writeSync(3, String(child.pid) + '\\n')

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
if [ "\${STAGE09A_FIXTURE_MODE:-}" = nested-cleanup ]; then
  exec "\${STAGE09A_FIXTURE_NODE}" "\${STAGE09A_FIXTURE_DIR}/nested-parent.mjs"
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
  const child = spawn(process.execPath, [gateEntrypoint], {
    cwd: repositoryRoot,
    detached: true,
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
    assert.equal(outcome.code, 1)
    assert.equal(outcome.signal, null)
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
      process.kill(-gate.child.pid, 'SIGKILL')
    }
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

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

test('the aggregate registry keeps the exact accepted gate order', () => {
  const source = readFileSync(entrypoint, 'utf8')
  const actualStepIds = [...source.matchAll(/^    id: '([^']+)',$/gm)].map((match) => match[1])
  assert.deepEqual(actualStepIds, expectedStepIds)
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

    assert.equal(outcome.code, 1)
    assert.equal(outcome.signal, null)
    assert.equal(existsSync(resolve(fixture.directory, 'step-started')), false)
    assert.match(output, /interrupted by SIGTERM during prerequisite checks; no checks were run/)
    assert.doesNotMatch(output, /stage09a:check step 1\/14/)
  } finally {
    if (gate !== null && processIsAlive(gate.child.pid)) {
      process.kill(-gate.child.pid, 'SIGKILL')
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

    assert.equal(outcome.code, 1)
    assert.equal(outcome.signal, null)
    assert.match(output, /received SIGTERM; terminating the controlled process subtree/)
    assert.match(output, /FAIL at step stage08-check \(interrupted by SIGTERM\)/)
  } finally {
    if (grandchildPid !== null && processIsAlive(grandchildPid)) {
      process.kill(grandchildPid, 'SIGKILL')
    }
    if (gate !== null && processIsAlive(gate.child.pid)) {
      process.kill(-gate.child.pid, 'SIGKILL')
    }
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
      assert.equal(outcome.code, 1)
      assert.equal(outcome.signal, null)
      assert.equal(existsSync(resolve(fixture.directory, 'step-started')), false)
      assert.match(output, new RegExp(`interrupted by ${signal} during prerequisite checks`))
      await waitFor(() => !processIsAlive(probePid), 1_000, 'prerequisite group ESRCH')
    } finally {
      if (gate !== null && processIsAlive(gate.child.pid)) {
        process.kill(-gate.child.pid, 'SIGKILL')
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
      assert.equal(outcome.code, 1)
      assert.equal(outcome.signal, null)
      assert.match(output, new RegExp(`received ${signal}`))
      assert.match(output, new RegExp(`interrupted by ${signal}`))
    } finally {
      if (grandchildPid !== null && processIsAlive(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL')
      }
      if (gate !== null && processIsAlive(gate.child.pid)) {
        process.kill(-gate.child.pid, 'SIGKILL')
      }
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })
}
