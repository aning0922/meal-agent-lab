import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

import {
  checkDockerignoreText,
  checkDockerfileText,
  checkImageConfig,
  createStrictRunner,
  dependencyPayloadOf,
  dockerignorePath,
  indexSavedImageTar,
  parseContainerInspect,
  parseOwnedScratchContainer,
  scratchCapabilityExpectation,
  parseLayerTarEvidence,
  parseImageHistory,
  parseImageInspect,
  parseSavedImageConfig,
  parseSavedImageManifest,
  requireBoundProvenance,
  repositoryRoot,
  validateOciDescriptor,
  validateSlsaProvenanceStatement,
  verifySavedImageLayers,
  parseDockerContainerId,
  parseDockerImageId
} from '../../infra/docker/api-image-scan.mjs'

const requireFromApi = createRequire(new URL('../../services/api/package.json', import.meta.url))
const ts = requireFromApi('typescript')

const throwingFatal = (message) => {
  throw new Error(message)
}

const writeTarOctal = (header, offset, length, value) => {
  const text = value.toString(8).padStart(length - 1, '0')
  header.write(text, offset, length - 1, 'ascii')
  header[offset + length - 1] = 0
}

const tarHeader = ({ name, mode = 0o644, uid = 0, gid = 0, size = 0, type = '0', link = '' }) => {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  writeTarOctal(header, 100, 8, mode)
  writeTarOctal(header, 108, 8, uid)
  writeTarOctal(header, 116, 8, gid)
  writeTarOctal(header, 124, 12, size)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write(link, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  writeTarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0))
  return header
}

const paxRecord = (key, value) => {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body)
  }
  return Buffer.from(`${String(length)}${body}`)
}

const padTarPayload = (bytes) => Buffer.concat([
  bytes,
  Buffer.alloc((512 - (bytes.length % 512)) % 512)
])

const fixtureTar = (entries, { trailingZeroBlocks = 2 } = {}) => Buffer.concat([
  ...entries.flatMap((entry) => {
    const bytes = entry.bytes ?? Buffer.alloc(0)
    return [
      tarHeader({ ...entry, size: bytes.length }),
      padTarPayload(bytes)
    ]
  }),
  Buffer.alloc(trailingZeroBlocks * 512)
])

const assertSavedArchiveDescriptorDataflow = (source) => {
  const sourceFile = ts.createSourceFile(
    'api-image-scan.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  let scanBody = null
  const findScan = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'scanImage'
    ) {
      scanBody = node.initializer
      return
    }
    ts.forEachChild(node, findScan)
  }
  findScan(sourceFile)
  assert.notEqual(scanBody, null)

  const openedDescriptors = new Set()
  const consumerArguments = []
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'openSync'
    ) {
      openedDescriptors.add(node.name.text)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'validateSavedImageArchive'
    ) {
      consumerArguments.push(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(scanBody)
  assert.equal(consumerArguments.length, 1)
  assert.equal(consumerArguments.every((argument) => ts.isIdentifier(argument)), true)
  const names = consumerArguments.map((argument) => argument.text)
  assert.equal(new Set(names).size, 1)
  assert.equal(openedDescriptors.has(names[0]), true)
}

test('saved-image archive parsing stays on the inherited descriptor after path replacement', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-saved-image-custody-'))
  const archive = resolve(directory, 'image.tar')
  const replacement = resolve(directory, 'replacement.tar')
  const original = Buffer.concat([
    tarHeader({ name: 'original', size: 1 }),
    padTarPayload(Buffer.from('A')),
    Buffer.alloc(1024)
  ])
  const foreign = Buffer.concat([
    tarHeader({ name: 'foreign', size: 1 }),
    padTarPayload(Buffer.from('B')),
    Buffer.alloc(1024)
  ])
  writeFileSync(archive, original)
  writeFileSync(replacement, foreign)
  const fd = openSync(archive, 'r')
  try {
    renameSync(archive, `${archive}.original`)
    renameSync(replacement, archive)
    const members = indexSavedImageTar(fd, throwingFatal)
    assert.equal(members.has('original'), true)
    assert.equal(members.has('foreign'), false)
  } finally {
    closeSync(fd)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('saved-image archive parsing accepts only zero record padding after its terminator', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-saved-image-padding-'))
  try {
    const padded = fixtureTar(
      [{ name: 'fixture', bytes: Buffer.from('A') }],
      { trailingZeroBlocks: 20 }
    )
    const valid = resolve(directory, 'valid.tar')
    writeFileSync(valid, padded)
    assert.deepEqual([...indexSavedImageTar(valid, throwingFatal).keys()], ['fixture'])

    const nonzeroTail = Buffer.from(padded)
    nonzeroTail[nonzeroTail.length - 1] = 0x41
    const invalid = resolve(directory, 'invalid.tar')
    writeFileSync(invalid, nonzeroTail)
    assert.throws(
      () => indexSavedImageTar(invalid, throwingFatal),
      /data after the tar terminator/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the archive validator consumes the held descriptor and production does not replay layers', () => {
  const source = readFileSync(resolve(repositoryRoot, 'infra/docker/api-image-scan.mjs'), 'utf8')
  assert.doesNotThrow(() => assertSavedArchiveDescriptorDataflow(source))
  const mutant = source.replace('validateSavedImageArchive(\n      savedImageFd,', 'validateSavedImageArchive(\n      savedImageTarPath,')
  assert.notEqual(mutant, source)
  assert.throws(() => assertSavedArchiveDescriptorDataflow(mutant))
  const productionBody = source.slice(source.indexOf('export const scanImage'))
  assert.doesNotMatch(productionBody, /verifySavedImageLayers\(/)
})

test('the checked-in dockerignore keeps every secret exclusion after all negations', () => {
  const problems = []
  checkDockerignoreText(readFileSync(dockerignorePath, 'utf8'), (message) => problems.push(message))
  assert.deepEqual(problems, [])
})

test('immutable image, container and history evidence is identity-bound and complete', () => {
  const imageId = `sha256:${'a'.repeat(64)}`
  const layerId = `sha256:${'b'.repeat(64)}`
  const containerId = 'c'.repeat(64)
  const image = [{
    Id: imageId,
    Config: {},
    Architecture: 'arm64',
    Os: 'linux',
    Created: '2026-08-12T00:00:00Z',
    Descriptor: { digest: imageId },
    RootFS: { Type: 'layers', Layers: [layerId] }
  }]
  assert.equal(parseImageInspect(JSON.stringify(image), imageId, throwingFatal).Id, imageId)
  assert.throws(
    () => parseImageInspect(JSON.stringify([{ ...image[0], Id: layerId }]), imageId, throwingFatal),
    /invalid immutable-image evidence/
  )
  assert.equal(
    parseContainerInspect(
      JSON.stringify([{ Id: containerId, Image: imageId, Path: 'node' }]),
      containerId,
      imageId,
      throwingFatal
    ).Image,
    imageId
  )
  assert.throws(
    () =>
      parseContainerInspect(
        JSON.stringify([{ Id: containerId, Image: layerId, Path: 'node' }]),
        containerId,
        imageId,
        throwingFatal
      ),
    /did not bind/
  )

  const historyRow = {
    ID: imageId,
    CreatedAt: '2026-08-12T00:00:00Z',
    CreatedSince: '1 second ago',
    CreatedBy: 'RUN node build.js',
    Size: '1B',
    Comment: ''
  }
  assert.equal(parseImageHistory(`${JSON.stringify(historyRow)}\n`, imageId, 1, throwingFatal, () => {}).length, 1)
  assert.throws(
    () => parseImageHistory(`${JSON.stringify(historyRow)}\n`, imageId, 2, throwingFatal, () => {}),
    /incomplete or mismatched/
  )
  for (const mutation of [
    { CreatedAt: '2026-99-99T00:00:00Z' },
    { CreatedBy: '   ' },
    { CreatedSince: '' }
  ]) {
    assert.throws(
      () =>
        parseImageHistory(
          `${JSON.stringify({ ...historyRow, ...mutation })}\n`,
          imageId,
          1,
          throwingFatal,
          () => {}
        ),
      /incomplete or mismatched/
    )
  }
  assert.throws(
    () => parseImageHistory(JSON.stringify(historyRow), imageId, 1, throwingFatal, () => {}),
    /invalid framing/
  )
  assert.equal(
    parseImageHistory(
      `${JSON.stringify({ ...historyRow, CreatedSince: 'About an hour ago' })}\n`,
      imageId,
      1,
      throwingFatal,
      () => {}
    ).length,
    1
  )
  assert.throws(
    () =>
      parseImageHistory(
        `${JSON.stringify({ ...historyRow, Size: '' })}\n`,
        imageId,
        1,
        throwingFatal,
        () => {}
      ),
    /incomplete or mismatched/
  )
  const problems = []
  parseImageHistory(
    `${JSON.stringify({ ...historyRow, CreatedBy: 'RUN WECHAT_APP_SECRET=M5_HISTORY_SENTINEL' })}\n`,
    imageId,
    1,
    throwingFatal,
    (message) => problems.push(message)
  )
  assert.deepEqual(problems, ['image history: secret-shaped build instruction must not ship'])
  const commentProblems = []
  parseImageHistory(
    `${JSON.stringify({ ...historyRow, Comment: 'WECHAT_APP_SECRET=M5_COMMENT_SENTINEL' })}\n`,
    imageId,
    1,
    throwingFatal,
    (message) => commentProblems.push(message)
  )
  assert.deepEqual(commentProblems, ['image history: secret-shaped build instruction must not ship'])

  const contentHistory = [
    {
      created: '2026-08-11T00:00:00Z',
      created_by: 'RUN install-runtime',
      comment: ''
    },
    {
      created: '2026-08-12T00:00:00Z',
      created_by: 'CMD ["node"]',
      empty_layer: true
    }
  ]
  const savedConfig = JSON.stringify({
    architecture: 'arm64',
    os: 'linux',
    created: '2026-08-12T00:00:00Z',
    config: {},
    rootfs: { type: 'layers', diff_ids: [layerId] },
    history: contentHistory
  })
  const configPath = `blobs/sha256/${createHash('sha256').update(savedConfig).digest('hex')}`
  assert.deepEqual(
    parseSavedImageManifest(
      JSON.stringify([{ Config: configPath, RepoTags: null, Layers: [`blobs/sha256/${'d'.repeat(64)}`] }]),
      1,
      throwingFatal
    ),
    { Config: configPath, RepoTags: null, Layers: [`blobs/sha256/${'d'.repeat(64)}`] }
  )
  const completeCliHistory = [
    { ...historyRow, CreatedAt: '2026-08-12T00:00:00Z', CreatedBy: 'CMD ["node"]', Size: '0B' },
    { ...historyRow, CreatedAt: '2026-08-11T00:00:00Z', CreatedBy: 'RUN install-runtime' }
  ]
  assert.doesNotThrow(() =>
    parseSavedImageConfig(
      Buffer.from(savedConfig),
      configPath,
      image[0],
      completeCliHistory,
      throwingFatal,
      () => {}
    )
  )
  assert.throws(
    () =>
      parseSavedImageConfig(
        Buffer.from(savedConfig),
        configPath,
        image[0],
        completeCliHistory.slice(0, 1),
        throwingFatal,
        () => {}
      ),
    /incomplete immutable-image config evidence/
  )
  assert.throws(
    () =>
      parseSavedImageManifest(
        JSON.stringify([{ Config: configPath, RepoTags: null, Layers: [`blobs/sha256/${'d'.repeat(64)}`] }]),
        2,
        throwingFatal
      ),
    /incomplete immutable-image metadata/
  )
  assert.throws(
    () =>
      parseSavedImageConfig(
        Buffer.from(savedConfig),
        configPath,
        image[0],
        [{ ...completeCliHistory[0], CreatedAt: '2026-08-13T00:00:00Z' }, completeCliHistory[1]],
        throwingFatal,
        () => {}
      ),
    /does not match/
  )
})

test('saved layer blobs are bound by compressed digest and uncompressed diff ID', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-saved-layer-'))
  try {
    const layerBytes = fixtureTar([
      { name: 'fixture.txt', bytes: Buffer.from('fixture layer bytes\n') }
    ])
    const digest = createHash('sha256').update(layerBytes).digest('hex')
    const archive = resolve(directory, 'image.tar')
    writeFileSync(
      archive,
      fixtureTar([{ name: `blobs/sha256/${digest}`, bytes: layerBytes }])
    )
    await assert.doesNotReject(
      verifySavedImageLayers(
        archive,
        [`blobs/sha256/${digest}`],
        [{ digest: `sha256:${digest}`, mediaType: 'application/vnd.oci.image.layer.v1.tar' }],
        [`sha256:${digest}`],
        throwingFatal
      )
    )
    await assert.rejects(
      verifySavedImageLayers(
        archive,
        [`blobs/sha256/${digest}`],
        [{ digest: `sha256:${digest}`, mediaType: 'application/vnd.oci.image.layer.v1.tar' }],
        [`sha256:${'f'.repeat(64)}`],
        throwingFatal
      ),
      /wrong diff ID/
    )
    await assert.rejects(
      verifySavedImageLayers(
        archive,
        [`blobs/sha256/${digest}`],
        [{ digest: `sha256:${digest}`, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' }],
        [`sha256:${digest}`],
        throwingFatal
      ),
      /media type did not match/
    )

    const truncatedBytes = layerBytes.subarray(0, layerBytes.length - 512)
    const truncatedDigest = createHash('sha256').update(truncatedBytes).digest('hex')
    const truncatedArchive = resolve(directory, 'truncated-image.tar')
    writeFileSync(
      truncatedArchive,
      fixtureTar([
        { name: `blobs/sha256/${truncatedDigest}`, bytes: truncatedBytes }
      ])
    )
    await assert.rejects(
      verifySavedImageLayers(
        truncatedArchive,
        [`blobs/sha256/${truncatedDigest}`],
        [{ digest: `sha256:${truncatedDigest}`, mediaType: 'application/vnd.oci.image.layer.v1.tar' }],
        [`sha256:${truncatedDigest}`],
        throwingFatal
      ),
      /inner layer tar/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }

})

test('verified layer replay consumes inherited descriptors rather than a replaceable path', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-layer-custody-'))
  try {
    const buildLayer = (name, contents) => {
      const archive = resolve(directory, `${name}.tar`)
      writeFileSync(
        archive,
        fixtureTar([
          { name: 'app/payload.txt', bytes: Buffer.from(contents) },
          { name: 'app/dist/index.js', bytes: Buffer.from('entrypoint') },
          {
            name: 'app/dist/database/migrate.js',
            bytes: Buffer.from('migration entrypoint')
          }
        ])
      )
      return archive
    }
    const layerA = buildLayer('a', 'VERIFIED-A')
    const layerB = buildLayer('b', 'UNVERIFIED-B')
    const layerBytes = readFileSync(layerA)
    const digest = createHash('sha256').update(layerBytes).digest('hex')
    const saved = resolve(directory, 'saved.tar')
    writeFileSync(
      saved,
      fixtureTar([{ name: `blobs/sha256/${digest}`, bytes: layerBytes }])
    )

    const strict = createStrictRunner(throwingFatal)
    let replaced = false
    const runStrict = async (args, options) => {
      if (!replaced && args[0] === 'tar' && args[1] === '-tf') {
        const spool = `${saved}.layers/0.tar`
        renameSync(spool, `${spool}.aside`)
        writeFileSync(spool, readFileSync(layerB))
        replaced = true
      }
      return strict(args, options)
    }
    const materialized = resolve(directory, 'materialized')
    mkdirSync(materialized)
    await verifySavedImageLayers(
      saved,
      [`blobs/sha256/${digest}`],
      [{ digest: `sha256:${digest}`, mediaType: 'application/vnd.oci.image.layer.v1.tar' }],
      [`sha256:${digest}`],
      throwingFatal,
      { materializeRoot: materialized, runStrict }
    )
    assert.equal(replaced, true)
    assert.equal(readFileSync(resolve(materialized, 'app/payload.txt'), 'utf8'), 'VERIFIED-A')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('layer replay rejects a whiteout marker without a basename', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-layer-whiteout-'))
  try {
    const layer = resolve(directory, 'layer.tar')
    writeFileSync(layer, fixtureTar([{ name: 'app/.wh.' }]))
    const bytes = readFileSync(layer)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const saved = resolve(directory, 'saved.tar')
    writeFileSync(
      saved,
      fixtureTar([{ name: `blobs/sha256/${digest}`, bytes }])
    )
    const materialized = resolve(directory, 'materialized')
    mkdirSync(materialized)
    await assert.rejects(
      verifySavedImageLayers(
        saved,
        [`blobs/sha256/${digest}`],
        [{ digest: `sha256:${digest}`, mediaType: 'application/vnd.oci.image.layer.v1.tar' }],
        [`sha256:${digest}`],
        throwingFatal,
        { materializeRoot: materialized, runStrict: createStrictRunner(throwingFatal) }
      ),
      /invalid whiteout marker/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('PAX identity overrides and app symlink boundaries are part of rootfs evidence', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-pax-identity-'))
  try {
    const pax = Buffer.concat([paxRecord('uid', '10001'), paxRecord('gid', '10002')])
    const archive = resolve(directory, 'layer.tar')
    writeFileSync(
      archive,
      Buffer.concat([
        tarHeader({ name: 'PaxHeader', size: pax.length, type: 'x' }),
        padTarPayload(pax),
        tarHeader({ name: 'app/dist/index.js', uid: 0, gid: 0, size: 1 }),
        padTarPayload(Buffer.from('x')),
        Buffer.alloc(1024)
      ])
    )
    const fd = openSync(archive, 'r')
    try {
      const entries = parseLayerTarEvidence(fd, throwingFatal)
      assert.deepEqual(
        entries.map(({ name, uid, gid }) => ({ name, uid, gid })),
        [{ name: 'app/dist/index.js', uid: 10001, gid: 10002 }]
      )
    } finally {
      closeSync(fd)
    }
    const paxLayerBytes = readFileSync(archive)
    const paxDigest = createHash('sha256').update(paxLayerBytes).digest('hex')
    const saved = resolve(directory, 'saved.tar')
    writeFileSync(
      saved,
      fixtureTar([{ name: `blobs/sha256/${paxDigest}`, bytes: paxLayerBytes }])
    )
    const materialized = resolve(directory, 'materialized')
    mkdirSync(materialized)
    await assert.rejects(
      verifySavedImageLayers(
        saved,
        [`blobs/sha256/${paxDigest}`],
        [{ digest: `sha256:${paxDigest}`, mediaType: 'application/vnd.oci.image.layer.v1.tar' }],
        [`sha256:${paxDigest}`],
        throwingFatal,
        { materializeRoot: materialized, runStrict: createStrictRunner(throwingFatal) }
      ),
      /runtime payload was not root-owned/
    )

    const escaped = resolve(directory, 'escaped.tar')
    writeFileSync(
      escaped,
      Buffer.concat([
        tarHeader({
          name: 'app/dist/index.js',
          type: '2',
          link: '../../outside/index.js'
        }),
        Buffer.alloc(1024)
      ])
    )
    const escapedFd = openSync(escaped, 'r')
    try {
      assert.throws(
        () => parseLayerTarEvidence(escapedFd, throwingFatal),
        /symlink escaped the protected app tree/
      )
    } finally {
      closeSync(escapedFd)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('layer paths have one lexical identity and PAX filesystem metadata is closed', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-layer-canonical-'))
  try {
    for (const [label, records] of [
      [
        'double-root-alias',
        [tarHeader({ name: '././app/dist/index.js', size: 1 }), padTarPayload(Buffer.from('x'))]
      ],
      [
        'repeated-slash-alias',
        [tarHeader({ name: 'app//dist/index.js', size: 1 }), padTarPayload(Buffer.from('x'))]
      ],
      [
        'empty-pax-path',
        [
          tarHeader({ name: 'PaxHeader', size: paxRecord('path', '').length, type: 'x' }),
          padTarPayload(paxRecord('path', '')),
          tarHeader({ name: 'app/dist/index.js', size: 1 }),
          padTarPayload(Buffer.from('x'))
        ]
      ],
      [
        'xattr-pax',
        [
          tarHeader({
            name: 'PaxHeader',
            size: paxRecord('SCHILY.xattr.security.capability', 'AAAA').length,
            type: 'x'
          }),
          padTarPayload(paxRecord('SCHILY.xattr.security.capability', 'AAAA')),
          tarHeader({ name: 'app/dist/index.js', size: 1 }),
          padTarPayload(Buffer.from('x'))
        ]
      ]
    ]) {
      const archive = resolve(directory, `${label}.tar`)
      writeFileSync(archive, Buffer.concat([...records, Buffer.alloc(1024)]))
      const fd = openSync(archive, 'r')
      try {
        assert.throws(
          () => parseLayerTarEvidence(fd, throwingFatal),
          /unsafe archive path|PAX path metadata was empty|unsupported PAX filesystem metadata/
        )
      } finally {
        closeSync(fd)
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('OCI descriptor media types are exact for each evidence role', () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const valid = (mediaType) => ({ digest, size: 1, mediaType })
  assert.doesNotThrow(() =>
    validateOciDescriptor(valid('application/vnd.oci.image.manifest.v1+json'), 'root', throwingFatal)
  )
  assert.doesNotThrow(() =>
    validateOciDescriptor(valid('application/vnd.oci.image.config.v1+json'), 'config', throwingFatal)
  )
  assert.doesNotThrow(() =>
    validateOciDescriptor(valid('application/vnd.oci.image.layer.v1.tar+gzip'), 'layer', throwingFatal)
  )
  assert.doesNotThrow(() =>
    validateOciDescriptor(valid('application/vnd.in-toto+json'), 'attestation', throwingFatal)
  )
  for (const [role, mediaType] of [
    ['root', 'application/octet-stream'],
    ['config', 'application/vnd.oci.image.layer.v1.tar'],
    ['layer', 'application/vnd.oci.image.config.v1+json'],
    ['attestation', 'application/vnd.oci.image.layer.v1.tar']
  ]) {
    assert.throws(
      () => validateOciDescriptor(valid(mediaType), role, throwingFatal),
      /invalid OCI descriptor/
    )
  }
})

test('SLSA provenance requires the supported predicate envelope', () => {
  const buildDefinition = {
    buildType: 'https://mobyproject.org/buildkit@v1',
    externalParameters: {},
    internalParameters: {},
    resolvedDependencies: []
  }
  const runDetails = {
    builder: { id: 'https://mobyproject.org/buildkit@v1' },
    metadata: {
      invocationId: 'fixture',
      startedOn: '2026-08-14T00:00:00Z',
      finishedOn: '2026-08-14T00:00:01Z'
    }
  }
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'fixture', digest: { sha256: 'a'.repeat(64) } }],
    predicate: { buildDefinition, runDetails }
  }
  assert.equal(validateSlsaProvenanceStatement(statement, throwingFatal), statement)
  const untaggedStatement = { ...statement, subject: [] }
  assert.equal(
    validateSlsaProvenanceStatement(untaggedStatement, throwingFatal),
    untaggedStatement
  )
  // Local Docker Engine / BuildKit emits an empty builder.id for this untagged
  // local build. It is an unauthenticated metadata field, not the manifest
  // binding; the attestation descriptor and statement subjects are checked
  // separately by requireBoundProvenance().
  const localBuilderStatement = {
    ...untaggedStatement,
    predicate: {
      buildDefinition,
      runDetails: { ...runDetails, builder: { id: '' } }
    }
  }
  assert.equal(
    validateSlsaProvenanceStatement(localBuilderStatement, throwingFatal),
    localBuilderStatement
  )
  for (const mutation of [
    { ...statement, subject: null },
    { ...statement, subject: [{}] },
    { ...statement, predicate: undefined },
    { ...statement, predicate: { runDetails } },
    { ...statement, predicate: { buildDefinition } },
    { ...statement, predicate: { buildDefinition: {}, runDetails } },
    { ...statement, predicate: { buildDefinition, runDetails: {} } },
    {
      ...statement,
      predicate: {
        buildDefinition,
        runDetails: { ...runDetails, builder: { id: null } }
      }
    }
  ]) {
    assert.throws(
      () => validateSlsaProvenanceStatement(mutation, throwingFatal),
      /invalid provenance attestation/
    )
  }
})

test('the selected platform manifest requires at least one bound provenance subject', () => {
  const digest = `sha256:${'b'.repeat(64)}`
  assert.doesNotThrow(() =>
    requireBoundProvenance(
      [{ referenceDigest: digest, subjects: [] }],
      digest,
      throwingFatal
    )
  )
  assert.doesNotThrow(() =>
    requireBoundProvenance(
      [{ referenceDigest: digest, subjects: [digest] }],
      digest,
      throwingFatal
    )
  )
  assert.throws(
    () => requireBoundProvenance([], digest, throwingFatal),
    /provenance is missing or not bound/
  )
  assert.throws(
    () =>
      requireBoundProvenance(
        [{ referenceDigest: digest, subjects: [`sha256:${'c'.repeat(64)}`] }],
        digest,
        throwingFatal
      ),
    /provenance is missing or not bound/
  )
  assert.throws(
    () =>
      requireBoundProvenance(
        [{ referenceDigest: digest, subjects: [`sha256:${'c'.repeat(64)}`] }],
        digest,
        throwingFatal
      ),
    /provenance is missing or not bound/
  )
  for (const subjects of [
    [digest, `sha256:${'c'.repeat(64)}`],
    [`sha256:${'c'.repeat(64)}`, digest],
    [digest, digest]
  ]) {
    assert.throws(
      () => requireBoundProvenance([{ referenceDigest: digest, subjects }], digest, throwingFatal),
      /provenance is missing or not bound/
    )
  }
})

test('Dockerfile FROM parsing sees --platform and refuses a missing stage graph', () => {
  const base = [
    'USER 10001:10001',
    'ENTRYPOINT []',
    'CMD ["node", "/app/dist/index.js"]'
  ].join('\n')
  const platformProblems = []
  checkDockerfileText(
    `FROM --platform=linux/amd64 node:latest AS node-base\n${base}\n`,
    (message) => platformProblems.push(message)
  )
  assert.ok(platformProblems.includes('Dockerfile: FROM must use the pinned digest or a prior stage alias'))

  const missingProblems = []
  checkDockerfileText(base, (message) => missingProblems.push(message))
  assert.ok(missingProblems.includes('Dockerfile: at least one complete FROM instruction is required'))
})

test('dependency payload evidence includes .bin and package file bytes', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-image-payload-'))
  try {
    mkdirSync(resolve(directory, '.bin'))
    mkdirSync(resolve(directory, 'fixture'))
    writeFileSync(resolve(directory, 'fixture/package.json'), '{"name":"fixture"}')
    const baseline = dependencyPayloadOf(directory, 'fixture', () => {})
    writeFileSync(resolve(directory, '.bin/webpack'), '#!/bin/sh\n')
    const withBin = dependencyPayloadOf(directory, 'fixture', () => {})
    assert.notEqual(withBin.sha256, baseline.sha256)
    writeFileSync(resolve(directory, '.bin/webpack'), '#!/bin/sh\nexit 7\n')
    const withChangedBinBytes = dependencyPayloadOf(directory, 'fixture', () => {})
    assert.notEqual(withChangedBinBytes.sha256, withBin.sha256)
    chmodSync(resolve(directory, '.bin/webpack'), 0o755)
    const withChangedBinMode = dependencyPayloadOf(directory, 'fixture', () => {})
    assert.notEqual(withChangedBinMode.sha256, withChangedBinBytes.sha256)
    writeFileSync(resolve(directory, 'fixture/payload.js'), 'mutation')
    const withPayload = dependencyPayloadOf(directory, 'fixture', () => {})
    assert.notEqual(withPayload.sha256, withChangedBinMode.sha256)
    chmodSync(resolve(directory, 'fixture/payload.js'), 0o755)
    const withPayloadMode = dependencyPayloadOf(directory, 'fixture', () => {})
    assert.notEqual(withPayloadMode.sha256, withPayload.sha256)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('dependency payload normalizes only its declared deploy root and binds the self-link', () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-image-root-binding-'))
  try {
    const left = resolve(parent, 'left')
    const right = resolve(parent, 'right')
    for (const directory of [left, right]) {
      mkdirSync(resolve(directory, 'node_modules/.bin'), { recursive: true })
      mkdirSync(resolve(directory, 'node_modules/@meal-agent'), { recursive: true })
      symlinkSync('../..', resolve(directory, 'node_modules/@meal-agent/api'))
    }
    writeFileSync(
      resolve(left, 'node_modules/.bin/fixture'),
      `#!/bin/sh\nexec /outside/alpha/node_modules/pkg/data\n`
    )
    writeFileSync(
      resolve(right, 'node_modules/.bin/fixture'),
      `#!/bin/sh\nexec /outside/bravo/node_modules/pkg/data\n`
    )
    const leftPayload = dependencyPayloadOf(
      resolve(left, 'node_modules'),
      'left',
      () => {},
      { shimDeployRoot: left }
    )
    const rightPayload = dependencyPayloadOf(
      resolve(right, 'node_modules'),
      'right',
      () => {},
      { shimDeployRoot: right }
    )
    assert.notEqual(leftPayload.sha256, rightPayload.sha256)

    writeFileSync(
      resolve(left, 'node_modules/.bin/fixture'),
      `#!/bin/sh\nexport NODE_PATH="${left}/node_modules/pkg"\nprintf '%s\\n' '${left}/node_modules/semantic'\n`
    )
    writeFileSync(
      resolve(right, 'node_modules/.bin/fixture'),
      `#!/bin/sh\nexport NODE_PATH="${right}/node_modules/pkg"\nprintf '%s\\n' '<DEPLOY>/node_modules/semantic'\n`
    )
    const collisionLeft = dependencyPayloadOf(resolve(left, 'node_modules'), 'left', () => {}, {
      shimDeployRoot: left
    })
    const collisionRight = dependencyPayloadOf(resolve(right, 'node_modules'), 'right', () => {}, {
      shimDeployRoot: right
    })
    assert.notEqual(
      collisionLeft.sha256,
      collisionRight.sha256,
      'semantic shim bytes must not be hidden by deploy-root normalization'
    )

    rmSync(resolve(right, 'node_modules/@meal-agent/api'))
    symlinkSync('/tmp/attacker-api', resolve(right, 'node_modules/@meal-agent/api'))
    const problems = []
    dependencyPayloadOf(
      resolve(right, 'node_modules'),
      'right',
      (message) => problems.push(message),
      { shimDeployRoot: right }
    )
    assert.deepEqual(problems, [
      'right: the @meal-agent/api self-link must match the deploy-derived target'
    ])
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('every image-side package README byte participates in the dependency payload', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-image-skipped-path-'))
  try {
    const packageDirectory = resolve(directory, '.pnpm/key/node_modules/@meal-agent/contracts')
    mkdirSync(packageDirectory, { recursive: true })
    const readme = resolve(packageDirectory, 'README.md')
    writeFileSync(readme, 'baseline')
    const problems = []
    const baseline = dependencyPayloadOf(directory, 'fixture', (message) => problems.push(message))
    writeFileSync(readme, 'mutation')
    const mutated = dependencyPayloadOf(directory, 'fixture', (message) => problems.push(message))
    assert.notEqual(mutated.sha256, baseline.sha256)
    rmSync(readme)
    mkdirSync(readme)
    writeFileSync(resolve(readme, 'hidden-client.js'), 'mutation')
    const directoryMutation = dependencyPayloadOf(directory, 'fixture', (message) => problems.push(message))
    assert.notEqual(directoryMutation.sha256, mutated.sha256)
    assert.deepEqual(problems, [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a broad late negation cannot reopen dotenv or private-key build context paths', () => {
  const text = `${readFileSync(dockerignorePath, 'utf8')}\n!services/api/**\n`
  const problems = []
  checkDockerignoreText(text, (message) => problems.push(message))

  assert.equal(
    problems.some((message) => message.includes('must appear after every negation rule')),
    true
  )
})

test('Docker evidence identities must use canonical immutable forms', () => {
  const imageId = `sha256:${'a'.repeat(64)}`
  const containerId = 'b'.repeat(64)
  assert.equal(parseDockerImageId(`${imageId}\n`, throwingFatal), imageId)
  assert.equal(parseDockerContainerId(`${containerId}\n`, throwingFatal), containerId)

  for (const invalid of ['', 'sha256:', 'sha256:not-hex', 'a'.repeat(64), `sha256:${'A'.repeat(64)}`]) {
    assert.throws(() => parseDockerImageId(invalid, throwingFatal), /noncanonical image ID/)
  }
  for (const invalid of ['', 'short', 'sha256:' + 'b'.repeat(64), 'B'.repeat(64)]) {
    assert.throws(() => parseDockerContainerId(invalid, throwingFatal), /noncanonical container ID/)
  }
})

test('scratch-container cleanup ownership is proven by exact identity, image, name and label', () => {
  const imageId = `sha256:${'a'.repeat(64)}`
  const containerId = 'b'.repeat(64)
  const name = 'meal-agent-m5-image-scan-fixture'
  const payload = [{
    Id: containerId,
    Image: imageId,
    Name: `/${name}`,
    Path: 'node',
    Config: {
      User: '10001:10001',
      Labels: { 'meal-agent.m5.owner': name }
    },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true }
  }]

  assert.equal(
    parseOwnedScratchContainer(JSON.stringify(payload), {
      expectedName: name,
      expectedImageId: imageId,
      expectedContainerId: containerId,
      expectedUser: '10001:10001',
      expectedNetworkMode: 'none',
      expectedReadonlyRootfs: true
    }, throwingFatal).Id,
    containerId
  )

  for (const mutation of [
    { ...payload[0], Id: 'c'.repeat(64) },
    { ...payload[0], Image: `sha256:${'d'.repeat(64)}` },
    { ...payload[0], Name: '/foreign' },
    {
      ...payload[0],
      Config: {
        ...payload[0].Config,
        Labels: { 'meal-agent.m5.owner': 'foreign' }
      }
    },
    { ...payload[0], Config: { ...payload[0].Config, User: '0:0' } },
    { ...payload[0], HostConfig: { ...payload[0].HostConfig, NetworkMode: 'bridge' } },
    { ...payload[0], HostConfig: { ...payload[0].HostConfig, ReadonlyRootfs: false } }
  ]) {
    assert.throws(
      () => parseOwnedScratchContainer(JSON.stringify([mutation]), {
        expectedName: name,
        expectedImageId: imageId,
        expectedContainerId: containerId,
        expectedUser: '10001:10001',
        expectedNetworkMode: 'none',
        expectedReadonlyRootfs: true
      }, throwingFatal),
      /identity did not match/
    )
  }
  for (const missingCapability of [
    { expectedUser: undefined },
    { expectedNetworkMode: undefined },
    { expectedReadonlyRootfs: undefined }
  ]) {
    assert.throws(
      () => parseOwnedScratchContainer(JSON.stringify(payload), {
        expectedName: name,
        expectedImageId: imageId,
        expectedContainerId: containerId,
        expectedUser: '10001:10001',
        expectedNetworkMode: 'none',
        expectedReadonlyRootfs: true,
        ...missingCapability
      }, throwingFatal),
      /identity did not match/
    )
  }
})

test('production scratch capability expectations are closed and non-optional', () => {
  assert.deepEqual(
    scratchCapabilityExpectation({
      name: 'fixture',
      imageId: `sha256:${'a'.repeat(64)}`,
      containerId: 'b'.repeat(64),
      user: '10001:10001'
    }),
    {
      expectedName: 'fixture',
      expectedImageId: `sha256:${'a'.repeat(64)}`,
      expectedContainerId: 'b'.repeat(64),
      expectedUser: '10001:10001',
      expectedNetworkMode: 'none',
      expectedReadonlyRootfs: true
    }
  )
})

test('the production scan consumes an immutable ID while a test-only locator resolves at most once', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../infra/docker/api-image-scan.mjs'), 'utf8')
  const scanBody = source.slice(source.indexOf('export const scanImage'))
  assert.match(scanBody, /imageTag === null\s*\? expectedImageId/)
  assert.match(scanBody, /\['docker', 'image', 'inspect', imageId\]/)
  assert.match(scanBody, /\['docker', 'image', 'save', imageId\][\s\S]*?stdoutFd: savedImageIdentity\.fd/)
  assert.match(scanBody, /validateSavedImageArchive\([\s\S]*?imageInspect[\s\S]*?historyRows/)
  assert.match(scanBody, /'docker', 'container', 'create'[\s\S]*?imageId/)
  assert.match(scanBody, /parseOwnedScratchContainer\([\s\S]*?scratchCapabilityExpectation\(/)
  assert.match(scanBody, /\['docker', 'container', 'export', containerId\][\s\S]*?stdoutFd: rootfsIdentity\.fd/)
  assert.doesNotMatch(scanBody, /verifySavedImageLayers\(/)
})

test('runtime image entrypoints register recovery locators before immutable ownership evidence', () => {
  const positive = readFileSync(
    resolve(import.meta.dirname, '../../infra/docker/check-api-runtime-image.mjs'),
    'utf8'
  )
  const mutations = readFileSync(
    resolve(import.meta.dirname, '../../infra/docker/check-api-runtime-image-mutations.mjs'),
    'utf8'
  )

  assert.match(positive, /--iidfile/)
  assert.match(positive, /parseCanonicalDockerImageId/)
  assert.match(positive, /expectedImageId: builtImageId/)
  assert.match(positive, /parseClaimedBuildImage/)
  assert.match(positive, /'--tag', cleanupState\.imageRecoveryTag/)
  assert.ok(
    positive.indexOf('imageRecoveryTag:') <
      positive.indexOf('await runWithDeclaredOwnedTreeOutputs(')
  )
  assert.match(positive, /runWithDeclaredOwnedTreeOutputs\([\s\S]*?imageIdFile[\s\S]*?imageMetadataFile/)
  assert.match(positive, /imageTag: null/)
  assert.match(positive, /createSignalSafeCleanup\(async/)
  assert.match(positive, /settleClaimedRuntimeImage\(cleanupRunCommand/)

  assert.match(mutations, /--iidfile/)
  assert.match(mutations, /expectedImageId:/)
  assert.match(mutations, /parseClaimedBuildImage/)
  assert.match(mutations, /builds: new Map\(\)/)
  assert.match(mutations, /imageTag: null/)
  assert.match(mutations, /'--tag', recoveryTag/)
  assert.match(mutations, /runWithDeclaredOwnedTreeOutputs\([\s\S]*?imageIdFile[\s\S]*?metadataFile/)
  assert.match(mutations, /createSignalSafeCleanup\(async/)
  assert.match(mutations, /settleClaimedRuntimeImage\(cleanupRunCommand/)
})

test('a pre-evidence build failure is recovered by exact tag, claim and immutable id', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'm5-runtime-recovery-test-'))
  const shimDirectory = resolve(directory, 'bin')
  const statePath = resolve(directory, 'docker-state.json')
  const buildReachedPath = resolve(directory, 'docker-build-reached')
  mkdirSync(shimDirectory)
  const realPnpm = spawnSync('/bin/sh', ['-c', 'command -v pnpm'], {
    encoding: 'utf8'
  }).stdout.trim()
  assert.notEqual(realPnpm, '')
  const pnpmShim = resolve(shimDirectory, 'pnpm')
  writeFileSync(
    pnpmShim,
    '#!/bin/sh\n' +
      'if [ "$1" = "--version" ]; then printf "11.9.0\\n"; exit 0; fi\n' +
      'exec "$M5_REAL_PNPM" "$@"\n'
  )
  chmodSync(pnpmShim, 0o755)
  const dockerShim = resolve(shimDirectory, 'docker')
  writeFileSync(
    dockerShim,
    [
      '#!/usr/bin/env node',
      "import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'",
      "const args = process.argv.slice(2)",
      "const statePath = process.env.M5_DOCKER_STATE",
      "const absent = (name) => { process.stderr.write(`Error response from daemon: No such image: ${name}\\n`); process.exit(1) }",
      "if (args[0] === 'version') { process.stdout.write('29.6.2\\n'); process.exit(0) }",
      "if (args[0] === 'build') {",
      "  const tag = args[args.indexOf('--tag') + 1]",
      "  const iidfile = args[args.indexOf('--iidfile') + 1]",
      "  const metadataFile = args[args.indexOf('--metadata-file') + 1]",
      "  const label = args[args.indexOf('--label') + 1]",
      "  const separator = label.indexOf('=')",
      "  const id = `sha256:${'a'.repeat(64)}`",
      "  writeFileSync(process.env.M5_BUILD_REACHED, 'yes')",
      "  writeFileSync(iidfile, `${id}\\n`)",
      "  writeFileSync(metadataFile, JSON.stringify({ 'containerimage.digest': id, 'containerimage.config.digest': id, 'containerimage.descriptor': { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: id, size: 1 } }))",
      "  writeFileSync(statePath, JSON.stringify({ id, tag, labelKey: label.slice(0, separator), claim: label.slice(separator + 1), tagged: true }))",
      "  process.exit(7)",
      "}",
      "if (args[0] === 'image' && args[1] === 'inspect') {",
      "  if (!existsSync(statePath)) absent(args[2])",
      "  const state = JSON.parse(readFileSync(statePath, 'utf8'))",
      "  if (args[2] !== state.id && !(state.tagged && args[2] === state.tag)) absent(args[2])",
      "  process.stdout.write(JSON.stringify([{ Id: state.id, RepoTags: state.tagged ? [state.tag] : null, Config: { Labels: { [state.labelKey]: state.claim } } }]))",
      "  process.exit(0)",
      "}",
      "if (args[0] === 'image' && args[1] === 'rm') {",
      "  if (!existsSync(statePath)) absent(args[2])",
      "  const state = JSON.parse(readFileSync(statePath, 'utf8'))",
      "  if (args[2] === state.tag && state.tagged) { state.tagged = false; writeFileSync(statePath, JSON.stringify(state)); process.exit(0) }",
      "  if (args[2] === state.id && !state.tagged) { unlinkSync(statePath); process.exit(0) }",
      "  process.exit(7)",
      "}",
      "process.exit(97)",
      ''
    ].join('\n')
  )
  chmodSync(dockerShim, 0o755)
  const before = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith('meal-agent-m5-image-scan-'))
  )
  try {
    const result = spawnSync(
      process.execPath,
      [resolve(repositoryRoot, 'infra/docker/check-api-runtime-image.mjs')],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${shimDirectory}:${process.env.PATH}`,
          M5_REAL_PNPM: realPnpm,
          M5_DOCKER_STATE: statePath,
          M5_BUILD_REACHED: buildReachedPath
        },
        encoding: 'utf8',
        timeout: 120_000
      }
    )
    assert.equal(result.status, 1)
    assert.equal(result.signal, null)
    assert.equal(readFileSync(buildReachedPath, 'utf8'), 'yes')
    assert.equal(existsSync(statePath), false, 'claimed image must be removed by immutable identity')
    const after = readdirSync(tmpdir()).filter(
      (name) => name.startsWith('meal-agent-m5-image-scan-') && !before.has(name)
    )
    assert.deepEqual(after, [])
    assert.match(result.stderr, /API runtime image scan FAIL/)
    assert.match(result.stderr, /docker build failed \(exit 7\)/)
    assert.doesNotMatch(result.stderr, /docker-state|sha256:[a-f0-9]{64}/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('signals in both recovery-build entrypoints cannot be stolen by ordinary CLI settlement', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'm5-runtime-signal-test-'))
  const shimDirectory = resolve(directory, 'bin')
  const statePath = resolve(directory, 'docker-state.json')
  const buildReachedPath = resolve(directory, 'docker-build-reached')
  mkdirSync(shimDirectory)
  const realPnpm = spawnSync('/bin/sh', ['-c', 'command -v pnpm'], {
    encoding: 'utf8'
  }).stdout.trim()
  assert.notEqual(realPnpm, '')
  writeFileSync(
    resolve(shimDirectory, 'pnpm'),
    '#!/bin/sh\n' +
      'if [ "$1" = "--version" ]; then printf "11.9.0\\n"; exit 0; fi\n' +
      'exec "$M5_REAL_PNPM" "$@"\n'
  )
  chmodSync(resolve(shimDirectory, 'pnpm'), 0o755)
  writeFileSync(
    resolve(shimDirectory, 'docker'),
    [
      '#!/usr/bin/env node',
      "import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'",
      'const args = process.argv.slice(2)',
      'const statePath = process.env.M5_DOCKER_STATE',
      "const absent = (name) => { process.stderr.write(`Error response from daemon: No such image: ${name}\\n`); process.exit(1) }",
      "if (args[0] === 'version') { process.stdout.write('29.6.2\\n'); process.exit(0) }",
      "if (args[0] === 'build') {",
      "  const tag = args[args.indexOf('--tag') + 1]",
      "  const iidfile = args[args.indexOf('--iidfile') + 1]",
      "  const metadataFile = args[args.indexOf('--metadata-file') + 1]",
      "  const label = args[args.indexOf('--label') + 1]",
      "  const separator = label.indexOf('=')",
      "  const id = `sha256:${'a'.repeat(64)}`",
      "  writeFileSync(process.env.M5_BUILD_REACHED, 'yes')",
      "  writeFileSync(iidfile, `${id}\n`)",
      "  writeFileSync(metadataFile, '{')",
      "  writeFileSync(statePath, JSON.stringify({ id, tag, labelKey: label.slice(0, separator), claim: label.slice(separator + 1), tagged: true }))",
      "  setInterval(() => {}, 1000)",
      "  await new Promise(() => {})",
      '}',
      "if (args[0] === 'image' && args[1] === 'inspect') {",
      '  if (!existsSync(statePath)) absent(args[2])',
      "  const state = JSON.parse(readFileSync(statePath, 'utf8'))",
      '  if (args[2] !== state.id && !(state.tagged && args[2] === state.tag)) absent(args[2])',
      "  process.stdout.write(JSON.stringify([{ Id: state.id, RepoTags: state.tagged ? [state.tag] : null, Config: { Labels: { [state.labelKey]: state.claim } } }]))",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'image' && args[1] === 'rm') {",
      '  if (!existsSync(statePath)) absent(args[2])',
      "  const state = JSON.parse(readFileSync(statePath, 'utf8'))",
      "  if (args[2] === state.tag && state.tagged) { state.tagged = false; writeFileSync(statePath, JSON.stringify(state)); process.exit(0) }",
      '  if (args[2] === state.id && !state.tagged) { unlinkSync(statePath); process.exit(0) }',
      '  process.exit(7)',
      '}',
      'process.exit(97)',
      ''
    ].join('\n')
  )
  chmodSync(resolve(shimDirectory, 'docker'), 0o755)
  try {
    for (const [entrypoint, temporaryPrefix] of [
      ['infra/docker/check-api-runtime-image.mjs', 'meal-agent-m5-image-scan-'],
      ['infra/docker/check-api-runtime-image-mutations.mjs', 'meal-agent-m5-image-mut-']
    ]) for (const requestedSignal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      if (existsSync(buildReachedPath)) unlinkSync(buildReachedPath)
      if (existsSync(statePath)) unlinkSync(statePath)
      const before = new Set(
        readdirSync(tmpdir()).filter((name) => name.startsWith(temporaryPrefix))
      )
      const child = spawn(process.execPath, [resolve(repositoryRoot, entrypoint)], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${shimDirectory}:${process.env.PATH}`,
          M5_REAL_PNPM: realPnpm,
          M5_DOCKER_STATE: statePath,
          M5_BUILD_REACHED: buildReachedPath
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      try {
        const deadline = Date.now() + 60_000
        while (!existsSync(buildReachedPath) && Date.now() < deadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
        }
        assert.equal(
          existsSync(buildReachedPath),
          true,
          `${entrypoint}: the controlled build window must be reached`
        )
        child.kill(requestedSignal)
        let watchdog = null
        const outcome = await Promise.race([
          new Promise((resolvePromise) => child.once('close', (code, signal) => {
            resolvePromise({ code, signal })
          })),
          new Promise((_, rejectPromise) => {
            watchdog = setTimeout(
              () => rejectPromise(new Error('signal fixture timed out')),
              60_000
            )
          })
        ]).finally(() => clearTimeout(watchdog))
        assert.deepEqual(outcome, { code: null, signal: requestedSignal })
        assert.match(
          stderr,
          new RegExp(`${requestedSignal}: terminating child processes, then running scoped cleanup`)
        )
        assert.doesNotMatch(stderr, /scoped cleanup left/)
        assert.equal(existsSync(statePath), false)
        assert.doesNotMatch(stdout, /API runtime image (?:scan|mutation suite) PASS/)
        assert.doesNotMatch(stderr, /API runtime image (?:scan|mutation suite) FAIL/)
        const after = readdirSync(tmpdir()).filter(
          (name) => name.startsWith(temporaryPrefix) && !before.has(name)
        )
        assert.deepEqual(after, [])
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('signals arriving during ordinary cleanup share one signal-safe cleanup settlement', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'm5-runtime-cleanup-race-'))
  const shimDirectory = resolve(directory, 'bin')
  const statePath = resolve(directory, 'docker-state.json')
  const cleanupReachedPath = resolve(directory, 'cleanup-reached')
  mkdirSync(shimDirectory)
  const realPnpm = spawnSync('/bin/sh', ['-c', 'command -v pnpm'], {
    encoding: 'utf8'
  }).stdout.trim()
  assert.notEqual(realPnpm, '')
  writeFileSync(
    resolve(shimDirectory, 'pnpm'),
    '#!/bin/sh\n' +
      'if [ "$1" = "--version" ]; then printf "11.9.0\\n"; exit 0; fi\n' +
      'exec "$M5_REAL_PNPM" "$@"\n'
  )
  chmodSync(resolve(shimDirectory, 'pnpm'), 0o755)
  writeFileSync(
    resolve(shimDirectory, 'docker'),
    [
      '#!/usr/bin/env node',
      "import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'",
      'const args = process.argv.slice(2)',
      'const statePath = process.env.M5_DOCKER_STATE',
      "const absent = (name) => { process.stderr.write(`Error response from daemon: No such image: ${name}\\n`); process.exit(1) }",
      "if (args[0] === 'version') { process.stdout.write('29.6.2\\n'); process.exit(0) }",
      "if (args[0] === 'build') {",
      "  const tag = args[args.indexOf('--tag') + 1]",
      "  const iidfile = args[args.indexOf('--iidfile') + 1]",
      "  const metadataFile = args[args.indexOf('--metadata-file') + 1]",
      "  const label = args[args.indexOf('--label') + 1]",
      "  const separator = label.indexOf('=')",
      "  const id = `sha256:${'a'.repeat(64)}`",
      "  writeFileSync(iidfile, `${id}\\n`)",
      "  writeFileSync(metadataFile, '{')",
      "  writeFileSync(statePath, JSON.stringify({ id, tag, labelKey: label.slice(0, separator), claim: label.slice(separator + 1), tagged: true }))",
      '  process.exit(7)',
      '}',
      "if (args[0] === 'image' && args[1] === 'inspect') {",
      '  if (!existsSync(statePath)) absent(args[2])',
      "  if (!existsSync(process.env.M5_CLEANUP_REACHED)) { writeFileSync(process.env.M5_CLEANUP_REACHED, 'yes'); await new Promise((resolve) => setTimeout(resolve, 500)) }",
      "  const state = JSON.parse(readFileSync(statePath, 'utf8'))",
      '  if (args[2] !== state.id && !(state.tagged && args[2] === state.tag)) absent(args[2])',
      "  process.stdout.write(JSON.stringify([{ Id: state.id, RepoTags: state.tagged ? [state.tag] : null, Config: { Labels: { [state.labelKey]: state.claim } } }]))",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'image' && args[1] === 'rm') {",
      '  if (!existsSync(statePath)) absent(args[2])',
      "  const state = JSON.parse(readFileSync(statePath, 'utf8'))",
      "  if (args[2] === state.tag && state.tagged) { state.tagged = false; writeFileSync(statePath, JSON.stringify(state)); process.exit(0) }",
      '  if (args[2] === state.id && !state.tagged) { unlinkSync(statePath); process.exit(0) }',
      '  process.exit(7)',
      '}',
      'process.exit(97)',
      ''
    ].join('\n')
  )
  chmodSync(resolve(shimDirectory, 'docker'), 0o755)
  try {
    for (const [entrypoint, temporaryPrefix] of [
      ['infra/docker/check-api-runtime-image.mjs', 'meal-agent-m5-image-scan-'],
      ['infra/docker/check-api-runtime-image-mutations.mjs', 'meal-agent-m5-image-mut-']
    ]) for (const requestedSignal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      rmSync(statePath, { force: true })
      rmSync(cleanupReachedPath, { force: true })
      const before = new Set(
        readdirSync(tmpdir()).filter((name) => name.startsWith(temporaryPrefix))
      )
      const child = spawn(process.execPath, [resolve(repositoryRoot, entrypoint)], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${shimDirectory}:${process.env.PATH}`,
          M5_REAL_PNPM: realPnpm,
          M5_DOCKER_STATE: statePath,
          M5_CLEANUP_REACHED: cleanupReachedPath
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      try {
        const deadline = Date.now() + 60_000
        while (!existsSync(cleanupReachedPath) && Date.now() < deadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
        }
        assert.equal(existsSync(cleanupReachedPath), true)
        child.kill(requestedSignal)
        const outcome = await new Promise((resolvePromise, rejectPromise) => {
          const watchdog = setTimeout(
            () => rejectPromise(new Error('cleanup-race fixture timed out')),
            60_000
          )
          child.once('close', (code, signal) => {
            clearTimeout(watchdog)
            resolvePromise({ code, signal })
          })
        })
        assert.deepEqual(outcome, { code: null, signal: requestedSignal })
        assert.match(stderr, new RegExp(`${requestedSignal}: terminating child processes`))
        assert.doesNotMatch(stderr, /scoped cleanup left|cleanup failed/)
        assert.equal(existsSync(statePath), false)
        assert.doesNotMatch(stdout, /API runtime image (?:scan|mutation suite) PASS/)
        assert.deepEqual(
          readdirSync(tmpdir()).filter(
            (name) => name.startsWith(temporaryPrefix) && !before.has(name)
          ),
          []
        )
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('every build caller publishes its cleanup locator before BuildKit starts', () => {
  for (const [relativePath, assignment] of [
    ['infra/docker/run-local-test-smoke.mjs', 'scene.imageTag = imageTag'],
    ['infra/docker/probe-compose-secret-identity.mjs', 'activeProbeScene.imageTag = imageTag'],
    ['infra/docker/m4-lifecycle.mjs', 'shared.imageTag = imageTag']
  ]) {
    const source = readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
    const assignmentIndex = source.indexOf(assignment)
    const buildIndex = source.indexOf('await buildApiImage', assignmentIndex)
    assert.notEqual(assignmentIndex, -1, `${relativePath} must publish the locator`)
    assert.notEqual(buildIndex, -1, `${relativePath} must call BuildKit after the locator`)
    assert.ok(assignmentIndex < buildIndex)
  }
})

test('strict command failures never echo runner-controlled stderr or exception text', async () => {
  const sentinel = 'RUNTIME-IMAGE-SCAN-SENTINEL-DO-NOT-ECHO'
  const nonzero = createStrictRunner(throwingFatal, async () => ({
    status: 7,
    signal: null,
    stdout: '',
    stderr: sentinel
  }))
  await assert.rejects(
    nonzero(['fixture'], { timeoutMs: 10, label: 'fixture evidence' }),
    (error) => error.message === 'fixture evidence failed (exit 7)' && !error.message.includes(sentinel)
  )

  const thrown = createStrictRunner(throwingFatal, async () => {
    throw new Error(sentinel)
  })
  await assert.rejects(
    thrown(['fixture'], { timeoutMs: 10, label: 'fixture evidence' }),
    (error) => error.message === 'fixture evidence: command failed to run' && !error.message.includes(sentinel)
  )
})

test('static and Config failures use fixed diagnostics without evidence-controlled text', () => {
  const sentinel = 'RUNTIME-IMAGE-SCAN-SENTINEL-DO-NOT-ECHO'
  const problems = []
  checkDockerfileText(
    `FROM ${sentinel} AS node-base\nCOPY apps/${sentinel} /app\nSTOPSIGNAL ${sentinel}\n`,
    (message) => problems.push(message)
  )
  checkDockerignoreText(
    `${readFileSync(dockerignorePath, 'utf8')}\n!services/api/${sentinel}/**\n`,
    (message) => problems.push(message)
  )
  checkImageConfig(
    {
      User: sentinel,
      WorkingDir: sentinel,
      Entrypoint: [sentinel],
      Cmd: [sentinel],
      Env: [`PASSWORD=${sentinel}`],
      ExposedPorts: { [sentinel]: {} },
      Volumes: { [sentinel]: {} },
      Healthcheck: { Test: [sentinel] },
      StopSignal: sentinel
    },
    (message) => problems.push(message),
    throwingFatal
  )

  assert.equal(problems.length > 0, true)
  assert.equal(problems.some((message) => message.includes(sentinel)), false)
})
