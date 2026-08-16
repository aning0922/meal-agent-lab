import assert from 'node:assert/strict'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  linkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  EvidenceProtocolError,
  parsePgRestoreListEvidence,
  parseSignalResidueListing,
  readStableRegularFile,
  requireFreshContainerGeneration,
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
  parseClaimedBuildImage
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

test('pg_restore list evidence binds the database header and the complete visible TOC', () => {
  assert.deepEqual(
    parsePgRestoreListEvidence(
      '; Archive created at 2026-08-16 00:00:00 UTC\n' +
      ';     TOC Entries: 6\n' +
      ';     Dump Version: 1.16-0\n' +
      ';     Format: CUSTOM\n' +
      ';     dbname: meal_agent\n' +
      '1; 1262 16384 DATABASE - meal_agent owner\n' +
      '2; 2615 2200 SCHEMA - public owner\n' +
      '3; 1259 2201 TABLE public fixture owner\n'
    ),
    { comments: 5, entries: 3, database: 'meal_agent' }
  )
  for (const value of ['', '   ', 'PGDMP', '; comments only\n', 'arbitrary nonempty\n']) {
    assert.throws(() => parsePgRestoreListEvidence(value), EvidenceProtocolError)
  }
  assert.throws(
    () =>
      parsePgRestoreListEvidence(
        '; Archive created at 2026-08-16 00:00:00 UTC\n' +
        ';     TOC Entries: 4\n' +
        ';     Dump Version: 1.16-0\n' +
        ';     Format: CUSTOM\n' +
        ';     dbname: meal_agent\n' +
        '1; 2615 2200 SCHEMA - public owner\n'
      ),
    EvidenceProtocolError
  )
  for (const conflictingHeader of [
    ';     TOC Entries: 999\n',
    ';     Format: TAR\n',
    ';     Dump Version: 1.15-0\n',
    ';     dbname: foreign_database\n'
  ]) {
    assert.throws(
      () =>
        parsePgRestoreListEvidence(
          '; Archive created at 2026-08-16 00:00:00 UTC\n' +
          conflictingHeader +
          ';     TOC Entries: 4\n' +
          ';     Dump Version: 1.16-0\n' +
          ';     Format: CUSTOM\n' +
          ';     dbname: meal_agent\n' +
          '1; 1262 16384 DATABASE - meal_agent owner\n'
        ),
      EvidenceProtocolError
    )
  }
  assert.throws(
    () =>
      parsePgRestoreListEvidence(
        '; Archive created at 2026-08-16 00:00:00 UTC\n' +
        ';     TOC Entries: 4\n' +
        ';     Dump Version: 1.16-0\n' +
        ';     Format: CUSTOM\n' +
        ';     dbname: meal_agent\n' +
        '1; 1262 16384 DATABASE - meal_agent foreign_suffix owner\n'
      ),
    EvidenceProtocolError
  )
  assert.throws(
    () =>
      parsePgRestoreListEvidence(
        '; Archive created at 2026-08-16 00:00:00 UTC\n' +
        ';     TOC Entries: 5\n' +
        ';     Dump Version: 1.16-0\n' +
        ';     Format: CUSTOM\n' +
        ';     dbname: other_database\n' +
        '1; 2615 2200 SCHEMA - public owner\n' +
        '2; 1259 2201 TABLE public fixture owner\n'
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
    const originalMode = identity.mode
    assert.equal(typeof originalMode, 'bigint')
    chmodSync(path, 0o644)
    assert.equal(verifyPublishedFileEvidence(identity, bytes), false)
    chmodSync(path, Number(originalMode))
    writeFileSync(path, 'drifted bytes')
    assert.equal(verifyPublishedFileEvidence(identity, bytes), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a close failure retracts the exact file created by exclusive publication', () => {
  const directory = mkdtempSync(join(tmpdir(), 'm5-evidence-close-'))
  try {
    const path = join(directory, 'artifact')
    assert.throws(
      () =>
        writeExclusiveEvidenceFile(path, Buffer.from('published bytes'), {
          closeFile: (fd) => {
            closeSync(fd)
            throw new Error('hostile close text')
          }
        }),
      EvidenceProtocolError
    )
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Compose success requires a fresh container generation', () => {
  const old = { Id: 'old', State: { StartedAt: '2026-08-16T00:00:00Z' } }
  const freshSameId = { Id: 'old', State: { StartedAt: '2026-08-16T00:00:01Z' } }
  const freshNewId = { Id: 'new', State: { StartedAt: '2026-08-16T00:00:00Z' } }
  assert.equal(requireFreshContainerGeneration(null, old), old)
  assert.equal(requireFreshContainerGeneration(old, freshSameId), freshSameId)
  assert.equal(requireFreshContainerGeneration(old, freshNewId), freshNewId)
  assert.throws(() => requireFreshContainerGeneration(old, old), EvidenceProtocolError)
  assert.throws(
    () => requireFreshContainerGeneration(old, { Id: 'new', State: { StartedAt: '' } }),
    EvidenceProtocolError
  )
})

test('signal residue listings are canonical and never return untrusted labels', () => {
  const containerId = 'a'.repeat(64)
  assert.deepEqual(parseSignalResidueListing('container', `${containerId}\n`), [containerId])
  assert.deepEqual(parseSignalResidueListing('volume', 'fixture_volume\n'), ['fixture_volume'])
  for (const hostile of ['SHORT-SENTINEL\n', `${containerId}\n${containerId}\n`, 'x\r\n']) {
    assert.throws(
      () => parseSignalResidueListing('container', hostile),
      (error) =>
        error instanceof EvidenceProtocolError &&
        error.message === 'evidence protocol rejected: signal-residue-listing' &&
        !error.message.includes('SENTINEL')
    )
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

test('build ownership binds metadata, immutable ID and an unguessable claim without a tag', () => {
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
    {
      imageId,
      configId: null,
      descriptor: {
        mediaType: 'application/vnd.oci.image.index.v1+json',
        digest: imageId,
        size: 123,
        platform: null
      }
    }
  )
  const image = {
    Id: imageId,
    RepoTags: null,
    Config: { Labels: { [buildClaimLabel]: 'claim-a' } }
  }
  assert.equal(
    parseClaimedBuildImage(image, {
      expectedImageId: imageId,
      expectedClaimToken: 'claim-a',
      requireUntagged: true
    }).imageId,
    imageId
  )
  const tagged = { ...image, RepoTags: ['meal-agent-api:m3b-fixture'] }
  assert.equal(
    parseClaimedBuildImage(tagged, {
      expectedImageId: imageId,
      expectedClaimToken: 'claim-a',
      expectedTag: 'meal-agent-api:m3b-fixture'
    }).imageId,
    imageId
  )
  assert.throws(
    () => parseClaimedBuildImage(
      { ...tagged, RepoTags: ['meal-agent-api:m3b-foreign'] },
      {
        expectedImageId: imageId,
        expectedClaimToken: 'claim-a',
        expectedTag: 'meal-agent-api:m3b-fixture'
      }
    ),
    /ownership evidence did not match/
  )
  for (const mutated of [
    { ...image, Id: `sha256:${'b'.repeat(64)}` },
    { ...image, RepoTags: ['meal-agent-api:foreign'] },
    { ...image, Config: { Labels: { [buildClaimLabel]: 'claim-b' } } }
  ]) {
    assert.throws(
      () => parseClaimedBuildImage(mutated, {
        expectedImageId: imageId,
        expectedClaimToken: 'claim-a',
        requireUntagged: true
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
    const executableSource = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    const occurrences = executableSource.split(guard.needle).length - 1
    assert.equal(
      occurrences,
      guard.occurrences,
      `${guard.id} must occur exactly ${String(guard.occurrences)} time(s)`
    )
  }
  assert.equal(m5CriticalGuardRegistry.length, 24)
})

test('commenting out the backup TOC guard is detected as an inactive mutation', () => {
  const guard = m5CriticalGuardRegistry.find((entry) => entry.id === 'backup.list-structure-v1')
  assert.notEqual(guard, undefined)
  const source = readFileSync(new URL(guard.file, repositoryRoot), 'utf8')
  const mutant = source.replace(
    guard.needle,
    `// ${guard.needle}`
  )
  const executableMutant = mutant
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  assert.equal(executableMutant.split(guard.needle).length - 1, 0)
})
