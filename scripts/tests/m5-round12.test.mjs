import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import {
  parseDockerContainerId,
  parseDockerImageId
} from '../../infra/docker/api-image-scan.mjs'
import {
  isResolvedServiceRecord,
  parseResolvedComposeDocument,
  resolvedDependencyProjection,
  resolvedHealthcheckProjection
} from '../../infra/docker/compose-topology-evidence.mjs'
import {
  assertGracefulStopTransition,
  composeRunOneOff
} from '../../infra/docker/m4-lifecycle.mjs'
import {
  assertCanonicalSecretProbePlan,
  canonicalSecretProbePlan
} from '../../infra/docker/local-test-secrets-contract.mjs'
import {
  createCommandRunner,
  createProcessGroupLifecycle
} from '../../infra/docker/m3b-subprocess.mjs'
import { parseBuildMetadataImageIdentity } from '../../infra/docker/m3b-docker.mjs'
import { parseProbeEvidence } from '../../infra/docker/probe-compose-secret-identity.mjs'
import { interpretPrerequisiteEvidence } from '../stage09a-prerequisite-evidence.mjs'

const fatal = (message) => {
  throw new Error(message)
}

test('BuildKit metadata keeps manifest and config identities distinct and fail closed', () => {
  const manifest = `sha256:${'a'.repeat(64)}`
  const config = `sha256:${'b'.repeat(64)}`
  assert.deepEqual(
    parseBuildMetadataImageIdentity(JSON.stringify({
      'containerimage.digest': manifest,
      'containerimage.config.digest': config,
      'containerimage.descriptor': {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: manifest,
        size: 123,
        platform: { architecture: 'arm64', os: 'linux' }
      },
      'image.name': 'docker.io/library/meal-agent-api:m5-fixture'
    })),
    {
      imageId: manifest,
      configId: config,
      descriptor: {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: manifest,
        size: 123,
        platform: { architecture: 'arm64', os: 'linux' }
      }
    }
  )
  assert.deepEqual(
    parseBuildMetadataImageIdentity(JSON.stringify({
      'containerimage.digest': manifest,
      'containerimage.descriptor': {
        mediaType: 'application/vnd.oci.image.index.v1+json',
        digest: manifest,
        size: 123
      }
    })),
    {
      imageId: manifest,
      configId: null,
      descriptor: {
        mediaType: 'application/vnd.oci.image.index.v1+json',
        digest: manifest,
        size: 123,
        platform: null
      }
    }
  )
  for (const malformed of [
    'not-json-METADATA-SENTINEL',
    '[]',
    '{}',
    JSON.stringify({
      'containerimage.digest': manifest,
      'containerimage.config.digest': config,
      'containerimage.descriptor': {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: `sha256:${'c'.repeat(64)}`,
        size: 123
      }
    }),
    JSON.stringify({
      'containerimage.digest': manifest,
      'containerimage.config.digest': config,
      'containerimage.descriptor': {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: manifest,
        size: 123,
        platform: { architecture: 'arm64', os: 'linux', variant: 'v8' }
      }
    }),
    JSON.stringify({
      'containerimage.digest': manifest,
      'containerimage.config.digest': config,
      'containerimage.descriptor': {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: manifest,
        size: 123
      },
      'foreign.capability': true
    })
  ]) {
    assert.throws(
      () => parseBuildMetadataImageIdentity(malformed),
      (error) => !String(error).includes('METADATA-SENTINEL')
    )
  }
})

test('resolved Compose capabilities reject null services and project every nested field', () => {
  assert.equal(isResolvedServiceRecord(null), false)
  assert.equal(isResolvedServiceRecord('service'), false)
  assert.equal(isResolvedServiceRecord([]), false)
  assert.equal(isResolvedServiceRecord({}), true)

  assert.equal(
    resolvedDependencyProjection({ condition: 'service_healthy', required: false }),
    null
  )
  assert.equal(
    resolvedDependencyProjection({
      condition: 'service_healthy',
      required: true,
      restart: true
    }),
    null
  )
  assert.equal(
    resolvedDependencyProjection({ condition: 'service_healthy', required: true }),
    'service_healthy'
  )
  assert.deepEqual(resolvedHealthcheckProjection({ test: ['NONE'], disable: true }), {
    test: ['NONE'],
    interval: null,
    timeout: null,
    retries: null,
    start_period: null,
    start_interval: null,
    disable: true
  })
  assert.equal(
    resolvedHealthcheckProjection({ test: ['NONE'], disable: true, post_start: ['id'] }),
    null
  )

  const document = JSON.stringify({
    name: 'meal-agent-local-test',
    services: {},
    networks: {},
    volumes: {},
    secrets: {},
    'x-hardening': {},
    'x-api-image': {},
    'x-bootstrap-psql': {},
    'x-pg-cluster-env': {}
  })
  assert.equal(parseResolvedComposeDocument(document)?.name, 'meal-agent-local-test')
  for (const malformed of [
    '',
    'null',
    '[]',
    '{',
    JSON.stringify({ name: 'x', services: [], networks: {}, volumes: {}, secrets: {} }),
    JSON.stringify({ name: 'x', services: {}, networks: null, volumes: {}, secrets: {} })
  ]) {
    assert.equal(parseResolvedComposeDocument(malformed), null)
  }
})

test('the Secret identity plan is bound to the canonical eight facts', () => {
  assert.equal(assertCanonicalSecretProbePlan(canonicalSecretProbePlan), true)
  assert.throws(
    () => assertCanonicalSecretProbePlan(canonicalSecretProbePlan.slice(0, -1)),
    /drifted from the canonical eight facts/
  )
  const reordered = canonicalSecretProbePlan.map((entry) => ({
    ...entry,
    secrets: [...entry.secrets]
  }))
  reordered[1].secrets.reverse()
  assert.throws(
    () => assertCanonicalSecretProbePlan(reordered),
    /drifted from the canonical eight facts/
  )
})

test('stage09a prerequisite success requires one canonical nonempty version line', () => {
  assert.deepEqual(
    interpretPrerequisiteEvidence('Docker daemon', { ok: true, stdout: '29.6.2\n' }),
    { ok: true, detail: '29.6.2' }
  )
  assert.deepEqual(
    interpretPrerequisiteEvidence('git', {
      ok: true,
      stdout: 'git version 2.50.1 (Apple Git-155)\n'
    }),
    { ok: true, detail: 'git version 2.50.1 (Apple Git-155)' }
  )
  assert.deepEqual(
    interpretPrerequisiteEvidence('git', {
      ok: true,
      stdout: 'git version 2.50.1 (Apple Git-155-UNTRUSTED)\n'
    }),
    { ok: false, detail: 'prerequisite evidence was invalid' }
  )
  for (const stdout of [
    '',
    '\n',
    'garbage\n',
    '29.6.2\r\n',
    '29.6.2\nUNTRUSTED-PREREQUISITE-SENTINEL\n',
    ' '.repeat(300)
  ]) {
    const interpreted = interpretPrerequisiteEvidence('Docker daemon', {
      ok: true,
      stdout
    })
    assert.deepEqual(interpreted, {
      ok: false,
      detail: 'prerequisite evidence was invalid'
    })
    assert.doesNotMatch(interpreted.detail, /SENTINEL|garbage/)
  }
})

test('every Docker identity reader rejects whitespace-normalized evidence', () => {
  const imageId = `sha256:${'a'.repeat(64)}`
  const containerId = 'b'.repeat(64)

  assert.equal(parseDockerImageId(`${imageId}\n`, fatal), imageId)
  assert.equal(parseDockerContainerId(`${containerId}\n`, fatal), containerId)
  for (const framed of [
    ` ${imageId}\n`,
    `${imageId} \n`,
    `\n${imageId}\n`,
    `${imageId}\r\n`,
    `${imageId}\n\n`
  ]) {
    assert.throws(() => parseDockerImageId(framed, fatal), /noncanonical image ID/)
  }
  for (const framed of [
    ` ${containerId}\n`,
    `${containerId} \n`,
    `\n${containerId}\n`,
    `${containerId}\r\n`,
    `${containerId}\n\n`
  ]) {
    assert.throws(() => parseDockerContainerId(framed, fatal), /noncanonical container ID/)
  }
})

test('the Secret identity protocol rejects an overlong record before interpretation', () => {
  const path = `/run/secrets/${'a'.repeat(8192)}/value`
  const evidence =
    `PROBE ${path} euid=999 uid=999 mode=0600 nlink=1 ` +
    'regular=yes readable=yes symlink=no\n'
  assert.throws(
    () => parseProbeEvidence(evidence, [path]),
    /invalid probe evidence protocol/
  )
})

test('the command runner bounds stdout before concatenating the full child output', { timeout: 10_000 }, async () => {
  let pgid = null
  const runner = createCommandRunner({
    spawnProcess: (...args) => {
      const child = spawn(...args)
      pgid = child.pid
      return child
    }
  })

  await assert.rejects(
    runner(
      [
        process.execPath,
        '-e',
        "process.stdout.write('A'.repeat(1024 * 1024)); setInterval(() => {}, 1000)"
      ],
      { timeoutMs: 30_000, maxStdoutBytes: 4096, maxStderrBytes: 4096 }
    ),
    (error) => {
      assert.equal(error instanceof Error && error.message, 'command stdout exceeded its byte limit')
      assert.equal(Number.isSafeInteger(pgid) && pgid > 0, true)
      assert.throws(
        () => process.kill(-pgid, 0),
        (probeError) => probeError?.code === 'ESRCH'
      )
      return true
    }
  )
})

test('a status-zero one-off result is not evidence unless the owned container actually exists', async () => {
  const absent = (name) => ({
    status: 1,
    signal: null,
    stdout: '',
    stderr: `Error response from daemon: No such container: ${name}\n`
  })
  const run = async (argv) => {
    if (argv[1] === 'container' && argv[2] === 'inspect') return absent(argv[3])
    if (argv[1] === 'ps') return { status: 0, signal: null, stdout: '', stderr: '' }
    throw new Error('unexpected fixture command')
  }
  const compose = async () => ({ status: 0, signal: null, stdout: '', stderr: '' })

  await assert.rejects(
    composeRunOneOff(
      { compose, run },
      ['fixture'],
      { project: 'fixture-project', service: 'fixture-service' }
    ),
    /one-off success evidence did not identify the owned container/
  )
})

test('a no-op lifecycle stop cannot pass as graceful SIGTERM evidence', () => {
  const running = {
    id: 'a'.repeat(64),
    name: '/meal-agent-m4-lifecycle-api-1',
    image: `sha256:${'b'.repeat(64)}`,
    project: 'meal-agent-m4-lifecycle-fixture',
    service: 'api',
    state: {
      Status: 'running',
      Running: true,
      ExitCode: 0,
      StartedAt: '2026-08-15T01:00:00Z',
      FinishedAt: '0001-01-01T00:00:00Z'
    }
  }
  assert.throws(
    () => assertGracefulStopTransition(running, running),
    /did not prove a running-to-exited graceful stop transition/
  )
  assert.equal(
    assertGracefulStopTransition(running, {
      ...running,
      state: {
        ...running.state,
        Status: 'exited',
        Running: false,
        FinishedAt: '2026-08-15T01:00:01Z'
      }
    }),
    true
  )
  assert.throws(
    () =>
      assertGracefulStopTransition(running, {
        ...running,
        id: 'c'.repeat(64),
        state: { ...running.state, Status: 'exited', Running: false }
      }),
    /stable graceful-stop identity/
  )
})

test('a transient termination primitive failure is retried before lifecycle settlement', async () => {
  let alive = true
  let killAttempts = 0
  const lifecycle = createProcessGroupLifecycle({
    probeGroup: () => alive,
    signalGroup: (_pgid, signal) => {
      if (signal === 'SIGTERM') return true
      killAttempts += 1
      if (killAttempts === 1) throw new Error('UNTRUSTED-PRIMITIVE-SENTINEL')
      alive = false
      return true
    },
    delay: async () => undefined
  })
  const handle = lifecycle.register(4242)

  const outcome = await lifecycle.terminateDetailed([handle], {
    graceMs: 1,
    killWaitMs: 3
  })
  assert.deepEqual(outcome.survivors, [])
  assert.equal(outcome.primitiveFailed, true)
  assert.equal(killAttempts >= 2, true)
})

test('one-off command failures never expose caller-controlled error text', async () => {
  const sentinel = 'UNTRUSTED-M4-FAILURE-SENTINEL'
  const absent = (name) => ({
    status: 1,
    signal: null,
    stdout: '',
    stderr: `Error response from daemon: No such container: ${name}\n`
  })
  const run = async (argv) => {
    if (argv[1] === 'container' && argv[2] === 'inspect') return absent(argv[3])
    if (argv[1] === 'ps') return { status: 0, signal: null, stdout: '', stderr: '' }
    throw new Error('unexpected fixture command')
  }
  const compose = async () => {
    throw new Error(sentinel)
  }

  await assert.rejects(
    composeRunOneOff(
      { compose, run },
      ['fixture'],
      { project: 'fixture-project', service: 'fixture-service' }
    ),
    (error) => {
      assert.equal(error instanceof Error && error.message, 'one-off command execution failed')
      assert.doesNotMatch(error.message, new RegExp(sentinel))
      return true
    }
  )
})
