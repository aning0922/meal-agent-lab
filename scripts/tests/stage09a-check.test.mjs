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

test('termination lifecycle failure settles with a fixed nonzero result instead of hanging', { timeout: 12_000 }, async () => {
  const fixture = createFixture()
  let gate = null
  let grandchildPid = null
  try {
    const scriptsDirectory = resolve(fixture.directory, 'scripts')
    const infraDirectory = resolve(fixture.directory, 'infra/docker')
    mkdirSync(scriptsDirectory, { recursive: true })
    mkdirSync(infraDirectory, { recursive: true })
    const copiedEntrypoint = resolve(scriptsDirectory, 'run-stage09a-check.mjs')
    writeFileSync(copiedEntrypoint, readFileSync(entrypoint))
    writeFileSync(
      resolve(infraDirectory, 'm3b-subprocess.mjs'),
      `export const createProcessGroupLifecycle = () => {
  const active = new Set()
  return {
    register: (pgid) => { const handle = { pgid, generation: 1 }; active.add(handle); return handle },
    markLeaderClosed: () => undefined,
    retireIfGone: (handle) => active.delete(handle),
    unconfirmed: () => [...active],
    terminate: async () => { throw new Error('TERMINATION-PRIMITIVE-SENTINEL') },
    terminateAll: async () => { throw new Error('TERMINATION-PRIMITIVE-SENTINEL') }
  }
}\n`
    )
    gate = spawnGate(fixture, 'descendant-silent', copiedEntrypoint)
    const pidFile = resolve(fixture.directory, 'grandchild-pid')
    await waitFor(() => existsSync(pidFile), 3_000, 'descendant pid')
    grandchildPid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(processIsAlive(grandchildPid), true)
    gate.child.kill('SIGTERM')
    const outcome = await waitForClose(gate.child, 4_000)
    const output = Buffer.concat([...gate.stdout, ...gate.stderr]).toString('utf8')
    assert.equal(outcome.code, 1)
    assert.equal(outcome.signal, null)
    assert.match(output, /signal cleanup failed/)
    assert.doesNotMatch(output, /TERMINATION-PRIMITIVE-SENTINEL/)
  } finally {
    if (grandchildPid !== null && processIsAlive(grandchildPid)) {
      process.kill(grandchildPid, 'SIGKILL')
      await waitFor(() => !processIsAlive(grandchildPid), 1_000, 'fixture cleanup ESRCH')
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

test('the CI workflow delegates to the same fail-closed aggregate entrypoint', () => {
  const source = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
  assert.match(source, /^permissions:\n  contents: read$/m)
  assert.match(source, /^concurrency:\n  group: stage09a-/m)
  assert.equal((source.match(/run: pnpm stage09a:check/g) ?? []).length, 1)
  assert.match(source, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/)
  assert.match(source, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/)
  assert.doesNotMatch(source, /uses:\s+actions\/[^@]+@v\d+/)
  assert.doesNotMatch(source, /continue-on-error|pull_request_target/)
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
