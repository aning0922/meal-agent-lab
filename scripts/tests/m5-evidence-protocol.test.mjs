import assert from 'node:assert/strict'
import { mkdtempSync, linkSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  EvidenceProtocolError,
  parsePgRestoreListEvidence,
  readStableRegularFile,
  requireClosedRecord,
  verifyPublishedFileEvidence,
  writeExclusiveEvidenceFile
} from '../../infra/docker/m5-evidence-protocol.mjs'
import { parseResolvedComposeDocument } from '../../infra/docker/compose-topology-evidence.mjs'
import {
  createProcessGroupLifecycle,
  probeProcessGroup
} from '../../infra/docker/m3b-subprocess.mjs'
import {
  buildClaimLabel,
  parseBuildMetadataImageIdentity,
  parseOwnedBuildImage
} from '../../infra/docker/m3b-docker.mjs'
import { m5CriticalGuardRegistry } from '../../infra/docker/m5-critical-guard-registry.mjs'

const repositoryRoot = new URL('../../', import.meta.url)

const validCompose = () => ({
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

test('resolved Compose evidence is a closed root capability schema', () => {
  assert.notEqual(parseResolvedComposeDocument(JSON.stringify(validCompose())), null)
  assert.equal(
    parseResolvedComposeDocument(JSON.stringify({ ...validCompose(), configs: {} })),
    null
  )
  assert.equal(
    parseResolvedComposeDocument(JSON.stringify({ ...validCompose(), 'x-extra': {} })),
    null
  )
})

test('closed records reject unknown capabilities instead of ignoring them', () => {
  assert.deepEqual(
    requireClosedRecord({ id: 'a', generation: 1 }, {
      requiredKeys: ['id', 'generation'],
      code: 'fixture'
    }),
    { id: 'a', generation: 1 }
  )
  assert.throws(
    () => requireClosedRecord({ id: 'a', generation: 1, foreign: true }, {
      requiredKeys: ['id', 'generation'],
      code: 'fixture'
    }),
    (error) => error instanceof EvidenceProtocolError && error.code === 'fixture'
  )
})

test('pg_restore list evidence requires comments and at least one canonical TOC row', () => {
  assert.deepEqual(
    parsePgRestoreListEvidence(
      '; Archive created at 2026-08-16 00:00:00 UTC\n' +
      ';     TOC Entries: 4\n' +
      ';     Dump Version: 1.16-0\n' +
      ';     Format: CUSTOM\n' +
      ';     dbname: meal_agent\n' +
      '1; 2615 2200 SCHEMA - public owner\n'
    ),
    { comments: 5, entries: 1 }
  )
  for (const value of ['', '   ', 'PGDMP', '; comments only\n', 'arbitrary nonempty\n']) {
    assert.throws(() => parsePgRestoreListEvidence(value), EvidenceProtocolError)
  }
  assert.throws(
    () =>
      parsePgRestoreListEvidence(
        '; Archive created at 2026-08-16 00:00:00 UTC\n' +
        ';     TOC Entries: 5\n' +
        ';     Dump Version: 1.16-0\n' +
        ';     Format: CUSTOM\n' +
        '1; 2615 2200 SCHEMA - public owner\n'
      ),
    EvidenceProtocolError
  )
})

test('published file evidence binds bytes, inode, link count and exclusive name', () => {
  const directory = mkdtempSync(join(tmpdir(), 'm5-evidence-test-'))
  try {
    const path = join(directory, 'artifact')
    const bytes = Buffer.from('bound bytes', 'utf8')
    const identity = writeExclusiveEvidenceFile(path, bytes)
    assert.equal(verifyPublishedFileEvidence(identity, bytes), true)
    assert.throws(() => writeExclusiveEvidenceFile(path, bytes), EvidenceProtocolError)

    const alias = join(directory, 'alias')
    linkSync(path, alias)
    assert.equal(verifyPublishedFileEvidence(identity, bytes), false)
    rmSync(alias)
    writeFileSync(path, 'drifted bytes')
    assert.equal(verifyPublishedFileEvidence(identity, bytes), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('stable file reads reject hardlinks and return one byte-bound snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'm5-evidence-read-'))
  try {
    const path = join(directory, 'source')
    writeFileSync(path, 'source')
    const evidence = readStableRegularFile(path)
    assert.equal(evidence.bytes.toString('utf8'), 'source')
    linkSync(path, join(directory, 'alias'))
    assert.throws(() => readStableRegularFile(path), EvidenceProtocolError)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unknown process-group probe error survives later ESRCH settlement', async () => {
  let probes = 0
  const lifecycle = createProcessGroupLifecycle({
    probeGroup: () => {
      probes += 1
      if (probes === 1) throw new Error('untrusted primitive text')
      return false
    },
    signalGroup: () => true,
    delay: async () => undefined
  })
  const handle = lifecycle.register(4242)
  const outcome = await lifecycle.terminateDetailed([handle], { graceMs: 1, killWaitMs: 1 })
  assert.equal(outcome.primitiveFailed, true)
  assert.deepEqual(outcome.survivors, [])
})

test('build ownership binds metadata, immutable ID, one tag and an unguessable claim', () => {
  const imageId = `sha256:${'a'.repeat(64)}`
  assert.deepEqual(
    parseBuildMetadataImageIdentity(JSON.stringify({
      'containerimage.digest': imageId,
      'containerimage.descriptor': {
        mediaType: 'application/vnd.oci.image.index.v1+json',
        digest: imageId,
        size: 123
      }
    })),
    { imageId, configId: null }
  )
  const image = {
    Id: imageId,
    RepoTags: ['meal-agent-api:m5-fixture'],
    Config: { Labels: { [buildClaimLabel]: 'claim-a' } }
  }
  assert.equal(
    parseOwnedBuildImage(image, {
      expectedImageId: imageId,
      expectedTag: 'meal-agent-api:m5-fixture',
      expectedClaimToken: 'claim-a'
    }).imageId,
    imageId
  )
  for (const mutated of [
    { ...image, Id: `sha256:${'b'.repeat(64)}` },
    { ...image, RepoTags: ['meal-agent-api:foreign'] },
    { ...image, Config: { Labels: { [buildClaimLabel]: 'claim-b' } } }
  ]) {
    assert.throws(
      () => parseOwnedBuildImage(mutated, {
        expectedImageId: imageId,
        expectedTag: 'meal-agent-api:m5-fixture',
        expectedClaimToken: 'claim-a'
      }),
      /ownership evidence did not match/
    )
  }
})

test('the production process-group probe distinguishes gone, denied and unknown states', () => {
  assert.equal(
    probeProcessGroup(4242, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }),
    false
  )
  assert.equal(
    probeProcessGroup(4242, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }),
    true
  )
  assert.throws(
    () => probeProcessGroup(4242, () => { throw new Error('unknown') }),
    /unknown/
  )
})

test('every critical evidence guard remains mapped to its registered production call site', () => {
  const ids = new Set()
  for (const guard of m5CriticalGuardRegistry) {
    assert.equal(ids.has(guard.id), false, `duplicate guard id ${guard.id}`)
    ids.add(guard.id)
    const source = readFileSync(new URL(guard.file, repositoryRoot), 'utf8')
    const occurrences = source.split(guard.needle).length - 1
    assert.equal(
      occurrences,
      guard.occurrences,
      `${guard.id} must occur exactly ${String(guard.occurrences)} time(s)`
    )
  }
  assert.equal(m5CriticalGuardRegistry.length, 15)
})
