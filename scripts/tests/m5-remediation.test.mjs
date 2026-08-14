import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  assertBackupTargetsIgnored,
  promoteBackupNoReplace,
  writeChecksumSidecarNoReplace
} from '../../infra/docker/backup-local-test.mjs'
import { discardOverride, writeImageOverride } from '../../infra/docker/m3b-docker.mjs'
import {
  connectOutcomeForErrorCode,
  nonLoopbackOutcomeDisposition,
  requireNonLoopbackIsolationEvidence
} from '../../infra/docker/local-test-containment.mjs'
import {
  observedDescendantPgids,
  runCommand,
  unconfirmedProcessGroups
} from '../../infra/docker/m3b-subprocess.mjs'

import {
  composeRunOneOff,
  createScopedArtifactCleanup,
  oneOffIsGone,
  removeLingeringOneOffs,
  startExistingContainer
} from '../../infra/docker/m4-lifecycle.mjs'
import {
  checksumSidecarUnparseableReason,
  createRestoreCommandRunner,
  runRestoreOneOff,
  verifyBackupChecksum
} from '../../infra/docker/restore-local-test.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')

const processGroupIsAlive = (pgid) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

const waitForGone = async (pgid, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processGroupIsAlive(pgid)) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  assert.equal(processGroupIsAlive(pgid), false, `process group ${String(pgid)} must reach ESRCH`)
}

test('M4 scoped artifact cleanup is failure-safe across every registered task', async () => {
  const cleanup = createScopedArtifactCleanup()
  const calls = []
  cleanup.register(async () => {
    calls.push('first')
    throw new Error('UNTRUSTED-CLEANUP-SENTINEL')
  })
  cleanup.register(async () => {
    calls.push('second')
    return ['scoped artifact remains']
  })
  cleanup.register(async () => {
    calls.push('third')
    return []
  })

  assert.deepEqual(await cleanup.run(), [
    'scoped artifact cleanup failed',
    'scoped artifact remains'
  ])
  assert.deepEqual(calls, ['first', 'second', 'third'])
})

test('runCommand treats stdin EPIPE as cleanup-before-settlement', { timeout: 10_000 }, async () => {
  const before = new Set(observedDescendantPgids())
  await assert.rejects(
    runCommand(
      ['/bin/sh', '-c', 'exec 0<&-; trap "" TERM INT HUP; sleep 30'],
      { stdin: Buffer.alloc(16 * 1024 * 1024, 0x41), timeoutMs: 60_000 }
    ),
    (error) => error instanceof Error && error.message === 'command stdin failed'
  )
  const created = observedDescendantPgids().filter((pgid) => !before.has(pgid))
  assert.equal(created.length, 1)
  for (const pgid of created) await waitForGone(pgid)
  assert.deepEqual(unconfirmedProcessGroups(), [])
})

test('runCommand is not redirected by caller timer primitive replacement', { timeout: 10_000 }, async () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const sentinel = 'CALLER-TIMER-PRIMITIVE-SENTINEL'
  try {
    globalThis.setTimeout = () => { throw new Error(sentinel) }
    globalThis.clearTimeout = () => { throw new Error(sentinel) }
    const result = await runCommand(['/bin/sh', '-c', 'sleep 0.05; exit 0'], {
      timeoutMs: 5_000
    })
    assert.equal(result.status, 0)
    assert.equal(result.signal, null)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
  assert.deepEqual(unconfirmedProcessGroups(), [])
})

test('a stale aggregate fd environment value does not claim a closed descriptor', () => {
  const modulePath = resolve(repositoryRoot, 'infra/docker/m3b-subprocess.mjs')
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const m = await import(${JSON.stringify(modulePath)}); ` +
        `const result = await m.runCommand(['/bin/sh', '-c', 'exit 0']); ` +
        `if (result.status !== 0) process.exit(2)`
    ],
    {
      env: {
        ...process.env,
        MEAL_AGENT_STAGE09A_PGID_FD: '3',
        MEAL_AGENT_STAGE09A_PGID_AUTH_FD: '4',
        MEAL_AGENT_STAGE09A_PGID_AUTH_TOKEN: 'a'.repeat(64)
      },
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
    }
  )
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0)
  assert.equal(child.signal, null)
  assert.doesNotMatch(`${String(child.stdout)}\n${String(child.stderr)}`, /announcement failed/)
})

test('M4 absence evidence requires the exact single-line Docker result', () => {
  assert.equal(
    oneOffIsGone(
      { status: 1, stderr: 'Error response from daemon: No such container: fixture\n' },
      'fixture'
    ),
    true
  )
  assert.equal(
    oneOffIsGone(
      {
        status: 7,
        stderr: 'transport failed\nError response from daemon: No such container: fixture\n'
      },
      'fixture'
    ),
    false
  )
  for (const stderr of [
    'Error response from daemon: No such container: fixture\r\n',
    'Error response from daemon: No such container: fixture\nextra',
    'prefix\nError response from daemon: No such container: fixture'
  ]) {
    assert.equal(oneOffIsGone({ status: 1, stderr }, 'fixture'), false)
  }
})

test('M4 never removes a same-name container without its ownership label', async () => {
  let state = 'absent'
  let removed = false
  const run = async (argv) => {
    if (argv[1] === 'container' && argv[2] === 'inspect') {
      const name = argv[3]
      if (state === 'absent') {
        return {
          status: 1,
          stdout: '',
          stderr: `Error response from daemon: No such container: ${name}\n`
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            Id: 'a'.repeat(64),
            Config: { Labels: { 'com.meal-agent.m4.oneoff-owner': 'FOREIGN' } }
          }
        ]),
        stderr: ''
      }
    }
    if (argv[1] === 'rm') {
      removed = true
      return { status: 0, stdout: '', stderr: '' }
    }
    throw new Error('unexpected fixture command')
  }
  const compose = async () => {
    state = 'foreign'
    return { status: 1, stdout: '', stderr: '' }
  }
  await assert.rejects(
    composeRunOneOff({ compose, run }, ['fixture']),
    /cleanup could not verify ownership/
  )
  assert.equal(removed, false)
  const residue = await removeLingeringOneOffs(run)
  assert.equal(residue.length, 1)
  assert.equal(removed, false)
})

test('M4 one-off handoff preserves binary stdin and disables TTY framing', async () => {
  const payload = Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0x00, 0xff])
  let state = 'absent'
  let ownerToken = null
  let observed = null
  const run = async (argv) => {
    if (argv[1] === 'container' && argv[2] === 'inspect') {
      const name = argv[3]
      if (state === 'absent') {
        return {
          status: 1,
          stdout: '',
          stderr: `Error response from daemon: No such container: ${name}\n`
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            Id: 'b'.repeat(64),
            Config: { Labels: { 'com.meal-agent.m4.oneoff-owner': ownerToken } }
          }
        ]),
        stderr: ''
      }
    }
    if (argv[1] === 'rm') {
      state = 'absent'
      return { status: 0, stdout: '', stderr: '' }
    }
    throw new Error('unexpected fixture command')
  }
  const compose = async (argv, options) => {
    const labelAt = argv.indexOf('--label')
    ownerToken = argv[labelAt + 1].split('=')[1]
    state = 'owned'
    observed = { argv, options }
    return { status: 0, stdout: '', stderr: '' }
  }

  const result = await composeRunOneOff(
    { compose, run },
    ['--entrypoint', 'bash', 'backup-transfer-loader', '-c', 'cat >/transfer/input.dump'],
    { stdin: payload }
  )
  assert.equal(result.status, 0)
  assert.ok(observed.argv.includes('--no-TTY'))
  assert.equal(observed.options.stdin, payload)
  assert.equal(state, 'absent')
})

test('the standalone restore runner forwards the verified dump bytes as stdin', async () => {
  const payload = Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0x00, 0xff])
  let observed = null
  const run = createRestoreCommandRunner(async (argv, options) => {
    observed = { argv, options }
    return { status: 0, stdout: '', stderr: '' }
  }, { defaultCwd: '/fixture', defaultEnv: { FIXTURE: 'yes' } })
  await run(['docker', 'compose'], { stdin: payload, timeoutMs: 7 })
  assert.deepEqual(observed.argv, ['docker', 'compose'])
  assert.equal(observed.options.stdin, payload)
  assert.equal(observed.options.cwd, '/fixture')
  assert.deepEqual(observed.options.env, { FIXTURE: 'yes' })
})

test('backup checksum sidecar creation is exclusive and never follows a symlink', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-backup-sidecar-'))
  try {
    const foreign = resolve(directory, 'foreign')
    const sidecar = resolve(directory, 'fixture.dump.sha256')
    writeFileSync(foreign, 'FOREIGN')
    symlinkSync(foreign, sidecar)
    assert.throws(
      () => writeChecksumSidecarNoReplace(sidecar, 'a'.repeat(64)),
      /could not be created exclusively/
    )
    assert.equal(readFileSync(foreign, 'utf8'), 'FOREIGN')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a failed sidecar writer reports the created inode to the outer cleanup owner', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-sidecar-failure-owner-'))
  try {
    const sidecar = resolve(directory, 'fixture.dump.sha256')
    const identities = []
    assert.throws(
      () => writeChecksumSidecarNoReplace(sidecar, 'unused', identities, {
        write: () => { throw new Error('CALLER-SENTINEL') },
        remove: () => false
      }),
      /could not be created exclusively/
    )
    assert.equal(identities.length, 1)
    assert.equal(identities[0].path, sidecar)
    assert.equal(existsSync(sidecar), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('backup no-replace promotion rejects a swapped staging inode without deleting it', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-backup-promotion-'))
  try {
    const staging = resolve(directory, 'staging.dump')
    const original = resolve(directory, 'original.dump')
    const published = resolve(directory, 'published.dump')
    writeFileSync(staging, 'PGDMP-OWNED')
    assert.throws(
      () => promoteBackupNoReplace(staging, published, {
        afterSourceCheck: () => {
          renameSync(staging, original)
          writeFileSync(staging, 'PGDMP-FOREIGN')
        }
      }),
      /inode changed during promotion/
    )
    assert.equal(readFileSync(staging, 'utf8'), 'PGDMP-FOREIGN')
    assert.equal(readFileSync(original, 'utf8'), 'PGDMP-OWNED')
    assert.equal(existsSync(published), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('M4 restarts only the exact existing container without traversing Compose dependencies', async () => {
  const calls = []
  await startExistingContainer(async (argv, options) => {
    calls.push({ argv, options })
    return { status: 0, signal: null, stdout: 'fixture-postgres-1\n', stderr: '' }
  }, 'fixture-postgres-1')
  assert.deepEqual(calls, [
    {
      argv: ['docker', 'start', 'fixture-postgres-1'],
      options: { timeoutMs: 120_000 }
    }
  ])

  const sentinel = 'DOCKER-START-STDERR-SENTINEL'
  await assert.rejects(
    startExistingContainer(
      async () => ({ status: 7, signal: null, stdout: '', stderr: sentinel }),
      'fixture-postgres-1'
    ),
    (error) =>
      error instanceof Error &&
      error.message === 'existing container start failed with exit 7' &&
      !error.message.includes(sentinel)
  )
})

test('restore sidecars must be bounded regular files', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m5-sidecar-'))
  try {
    const dump = resolve(directory, 'fixture.dump')
    writeFileSync(dump, 'PGDMPfixture')
    mkdirSync(`${dump}.sha256`)
    assert.throws(
      () => verifyBackupChecksum(dump),
      (error) => error instanceof Error && error.message === checksumSidecarUnparseableReason
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('restore sidecars reject BOM, multiline, CRLF and NUL framing', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m5-sidecar-framing-'))
  try {
    const dump = resolve(directory, 'fixture.dump')
    const bytes = Buffer.from('PGDMPfixture')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const line = `${digest}  fixture.dump`
    writeFileSync(dump, bytes)
    for (const invalid of [
      Buffer.from(`\uFEFF${line}`),
      Buffer.from(`${line}\nextra`),
      Buffer.from(`${line}\r\n`),
      Buffer.concat([Buffer.from(line), Buffer.from([0])])
    ]) {
      writeFileSync(`${dump}.sha256`, invalid)
      assert.throws(
        () => verifyBackupChecksum(dump),
        (error) => error instanceof Error && error.message === checksumSidecarUnparseableReason
      )
    }
    writeFileSync(`${dump}.sha256`, `${line}\n`)
    assert.equal(verifyBackupChecksum(dump).sha256, digest)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('restore handoff bytes are the exact snapshot that passed checksum verification', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-restore-snapshot-'))
  try {
    const dump = resolve(directory, 'fixture.dump')
    const replacement = resolve(directory, 'replacement.dump')
    const verified = Buffer.from('PGDMP-VERIFIED-A')
    const unverified = Buffer.from('PGDMP-UNVERIFIED-B')
    const digest = createHash('sha256').update(verified).digest('hex')
    writeFileSync(dump, verified)
    writeFileSync(`${dump}.sha256`, `${digest}  fixture.dump\n`)
    const snapshot = verifyBackupChecksum(dump)
    writeFileSync(replacement, unverified)
    renameSync(replacement, dump)
    assert.deepEqual(snapshot.verifiedBytes, verified)
    assert.notDeepEqual(readFileSync(dump), snapshot.verifiedBytes)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('backup target containment follows a symlink alias to its physical repository path', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-backup-alias-'))
  try {
    const alias = resolve(directory, 'alias')
    symlinkSync(resolve(repositoryRoot, 'services/api'), alias)
    const calls = []
    await assert.rejects(
      assertBackupTargetsIgnored(async (argv, options) => {
        calls.push({ argv, options })
        return { status: 1, stdout: '', stderr: '' }
      }, [resolve(alias, 'audit.dump')]),
      /inside the repository but not git-ignored/
    )
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].argv.slice(0, 3), ['git', '--no-replace-objects', 'check-ignore'])
    assert.match(calls[0].argv.at(-1), /services\/api\/audit\.dump$/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a repository path whose basename starts with two dots is still inside the repository', async () => {
  const calls = []
  await assert.rejects(
    assertBackupTargetsIgnored(async (argv) => {
      calls.push(argv)
      return { status: 1, stdout: '', stderr: '' }
    }, [resolve(repositoryRoot, '..fixture.dump')]),
    /inside the repository but not git-ignored/
  )
  assert.equal(calls.length, 1)
})

test('restore one-off exceptions are replaced by the fixed stage reason', async () => {
  const sentinel = 'RESTORE-ONEOFF-SENTINEL'
  await assert.rejects(
    runRestoreOneOff(
      async () => { throw new Error(sentinel) },
      ['restore'],
      { timeoutMs: 1 },
      'restore failed while applying the verified backup'
    ),
    (error) =>
      error instanceof Error &&
      error.message === 'restore failed while applying the verified backup' &&
      !error.message.includes(sentinel)
  )
})

test('zero usable non-loopback outcomes can never satisfy the isolation gate', () => {
  const failures = []
  requireNonLoopbackIsolationEvidence(0, (message) => failures.push(message))
  assert.deepEqual(failures, [
    'isolation: no non-loopback address produced usable refusal, timeout, HTTP, or calibrated proxy evidence'
  ])
  requireNonLoopbackIsolationEvidence(1, (message) => failures.push(message))
  assert.equal(failures.length, 1)
})

test('only an explicit connection refusal is counted as refusal evidence', () => {
  assert.equal(connectOutcomeForErrorCode('ECONNREFUSED'), 'refused:ECONNREFUSED')
  assert.equal(connectOutcomeForErrorCode('EHOSTUNREACH'), 'unattemptable:EHOSTUNREACH')
  for (const code of ['EMFILE', 'ENFILE', 'ENOMEM', 'ECONNRESET', 'EACCES', 'unknown']) {
    assert.equal(connectOutcomeForErrorCode(code), `unusable:${code}`)
  }
})

test('one unusable non-loopback probe invalidates a mixed evidence set', () => {
  const dispositions = [
    connectOutcomeForErrorCode('ECONNREFUSED'),
    connectOutcomeForErrorCode('EMFILE')
  ].map(nonLoopbackOutcomeDisposition)
  assert.deepEqual(dispositions, ['evidence', 'fail'])
  assert.equal(dispositions.includes('fail'), true)
})

test('temporary compose override cleanup is bound to the inode this run created', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-override-owner-'))
  try {
    const path = resolve(directory, 'override.yaml')
    const original = resolve(directory, 'owned.yaml')
    writeImageOverride(path, 'meal-agent-api:m3b-fixture')
    renameSync(path, original)
    writeFileSync(path, 'foreign')
    discardOverride(path)
    assert.equal(existsSync(path), true, 'a replacement inode must be preserved')
    rmSync(path)
    renameSync(original, path)
    discardOverride(path)
    assert.equal(existsSync(path), false, 'the registered inode must be removable')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
