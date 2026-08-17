import assert from 'node:assert/strict'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  linkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  EvidenceProtocolError,
  createOwnedTreeJournal,
  parsePgRestoreListEvidence,
  parseSignalResidueListing,
  readStableRegularFile,
  registerOwnedTree,
  requireFreshContainerGeneration,
  requireClosedRecord,
  retireOwnedTree,
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
  const canonical =
    '; Archive created at 2026-08-16 00:00:00 UTC\n' +
    ';     TOC Entries: 5\n' +
    ';     Dump Version: 1.16-0\n' +
    ';     Format: CUSTOM\n' +
    ';     dbname: meal_agent\n' +
    '1; 1262 16384 DATABASE - meal_agent owner\n' +
    '2; 0 0 DATABASE PROPERTIES - meal_agent owner\n'
  for (const malformed of [
    canonical.replace('1; 1262 16384 DATABASE', '1; 9999 16384 DATABASE'),
    canonical.replace('2; 0 0 DATABASE PROPERTIES', '2; 1 1 DATABASE PROPERTIES'),
    canonical.slice(0, -1),
    canonical.replace('dbname: meal_agent', 'dbname: foreign-name')
  ]) {
    assert.throws(() => parsePgRestoreListEvidence(malformed), EvidenceProtocolError)
  }
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

test('exclusive publication synchronizes file data and its parent directory before success', () => {
  const directory = mkdtempSync(join(tmpdir(), 'm5-evidence-sync-'))
  try {
    const calls = []
    const path = join(directory, 'artifact')
    const identity = writeExclusiveEvidenceFile(path, Buffer.from('durable bytes'), {
      syncFile: (fd) => {
        calls.push('file')
        fsyncSync(fd)
      },
      syncDirectory: (parent) => {
        calls.push(`directory:${parent === directory ? 'expected' : 'foreign'}`)
      }
    })
    assert.deepEqual(calls, ['file', 'directory:expected'])
    assert.equal(verifyPublishedFileEvidence(identity, Buffer.from('durable bytes')), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('file and parent-directory sync failures retract the exact exclusive name', () => {
  for (const failure of ['file', 'directory']) {
    const directory = mkdtempSync(join(tmpdir(), `m5-evidence-${failure}-sync-`))
    try {
      const path = join(directory, 'artifact')
      let directoryCalls = 0
      assert.throws(
        () =>
          writeExclusiveEvidenceFile(path, Buffer.from('published bytes'), {
            syncFile: failure === 'file'
              ? () => { throw new Error('untrusted file-sync text') }
              : fsyncSync,
            syncDirectory: () => {
              directoryCalls += 1
              if (failure === 'directory' && directoryCalls === 1) {
                throw new Error('untrusted directory-sync text')
              }
            }
          }),
        (error) =>
          error instanceof EvidenceProtocolError &&
          error.message === 'evidence protocol rejected: exclusive-publish' &&
          !error.message.includes('untrusted')
      )
      assert.equal(existsSync(path), false)
      assert.equal(directoryCalls, failure === 'directory' ? 2 : 1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('owned tree retirement preserves unknown children and inode replacements', () => {
  for (const variant of ['unknown', 'replacement']) {
    const directory = mkdtempSync(join(tmpdir(), `m5-owned-tree-${variant}-`))
    try {
      const journal = createOwnedTreeJournal(directory)
      const registered = join(directory, 'registered')
      writeFileSync(registered, 'owned')
      registerOwnedTree(journal, registered)
      if (variant === 'unknown') {
        writeFileSync(join(directory, 'foreign'), 'foreign')
      } else {
        rmSync(registered)
        writeFileSync(registered, 'replacement')
      }
      assert.throws(() => retireOwnedTree(journal), EvidenceProtocolError)
      assert.equal(existsSync(directory), true)
      assert.equal(existsSync(registered), true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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

test('exclusive publication reports the created inode before close and rollback can fail', () => {
  const directory = mkdtempSync(join(tmpdir(), 'm5-evidence-journal-'))
  try {
    const path = join(directory, 'artifact')
    let journaled = null
    assert.throws(
      () =>
        writeExclusiveEvidenceFile(path, Buffer.from('published bytes'), {
          registerCreatedIdentity: (identity) => {
            journaled = identity
          },
          closeFile: (fd) => {
            closeSync(fd)
            chmodSync(directory, 0o500)
            throw new Error('hostile close text')
          }
        }),
      EvidenceProtocolError
    )
    assert.notEqual(journaled, null)
    assert.equal(journaled.path, path)
    assert.equal(typeof journaled.dev, 'bigint')
    assert.equal(typeof journaled.ino, 'bigint')
    chmodSync(directory, 0o700)
    const observed = lstatSync(path, { bigint: true })
    assert.equal(observed.dev, journaled.dev)
    assert.equal(observed.ino, journaled.ino)
    rmSync(path)
  } finally {
    chmodSync(directory, 0o700)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Compose success requires a fresh container generation', () => {
  const old = { Id: 'old', State: { StartedAt: '2026-08-16T00:00:00Z' } }
  const freshSameId = { Id: 'old', State: { StartedAt: '2026-08-16T00:00:01Z' } }
  const freshNewId = { Id: 'new', State: { StartedAt: '2026-08-16T00:00:00Z' } }
  assert.equal(requireFreshContainerGeneration(null, old), old)
  assert.equal(requireFreshContainerGeneration(old, freshSameId), freshSameId)
  assert.throws(
    () => requireFreshContainerGeneration(old, freshNewId),
    EvidenceProtocolError
  )
  assert.equal(
    requireFreshContainerGeneration(old, {
      Id: 'new',
      State: { StartedAt: '2026-08-16T00:00:01Z' }
    }).Id,
    'new'
  )
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

test('a process group that reaches ESRCH before signal delivery is clean settlement', async () => {
  let probes = 0
  let signals = 0
  const lifecycle = createProcessGroupLifecycle({
    probeGroup: () => {
      probes += 1
      return probes === 1
    },
    signalGroup: () => {
      signals += 1
      return true
    },
    delay: async () => undefined
  })
  const handle = lifecycle.register(4242)
  const outcome = await lifecycle.terminateDetailed([handle], { graceMs: 0, killWaitMs: 0 })
  assert.deepEqual(outcome.survivors, [])
  assert.equal(outcome.primitiveFailed, false)
  assert.equal(signals, 0)
})
