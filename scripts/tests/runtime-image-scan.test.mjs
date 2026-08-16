import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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
  checkDockerignoreText,
  checkDockerfileText,
  checkImageConfig,
  createStrictRunner,
  dependencyPayloadOf,
  dockerignorePath,
  parseContainerInspect,
  parseOwnedScratchContainer,
  parseImageHistory,
  parseImageInspect,
  parseSavedImageConfig,
  parseSavedImageManifest,
  requireBoundProvenance,
  validateOciDescriptor,
  validateSlsaProvenanceStatement,
  verifySavedImageLayers,
  parseDockerContainerId,
  parseDockerImageId
} from '../../infra/docker/api-image-scan.mjs'

const throwingFatal = (message) => {
  throw new Error(message)
}

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
    const layerRoot = resolve(directory, 'layer-root')
    mkdirSync(layerRoot)
    writeFileSync(resolve(layerRoot, 'fixture.txt'), 'fixture layer bytes\n')
    const layerArchive = resolve(directory, 'layer.tar')
    const layerPacked = spawnSync(
      'tar',
      ['--format=ustar', '-cf', layerArchive, '-C', layerRoot, '.'],
      { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } }
    )
    assert.equal(layerPacked.status, 0, layerPacked.stderr)
    const layerBytes = readFileSync(layerArchive)
    const digest = createHash('sha256').update(layerBytes).digest('hex')
    const blobDirectory = resolve(directory, 'root/blobs/sha256')
    mkdirSync(blobDirectory, { recursive: true })
    writeFileSync(resolve(blobDirectory, digest), layerBytes)
    const archive = resolve(directory, 'image.tar')
    const packed = spawnSync(
      'tar',
      ['--format=ustar', '-cf', archive, '-C', resolve(directory, 'root'), 'blobs'],
      { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } }
    )
    assert.equal(packed.status, 0, packed.stderr)
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
    writeFileSync(resolve(blobDirectory, truncatedDigest), truncatedBytes)
    const truncatedArchive = resolve(directory, 'truncated-image.tar')
    const truncatedPacked = spawnSync(
      'tar',
      ['--format=ustar', '-cf', truncatedArchive, '-C', resolve(directory, 'root'), 'blobs'],
      { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } }
    )
    assert.equal(truncatedPacked.status, 0, truncatedPacked.stderr)
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
      const root = resolve(directory, `${name}-root`)
      const archive = resolve(directory, `${name}.tar`)
      mkdirSync(root)
      mkdirSync(resolve(root, 'app'))
      writeFileSync(resolve(root, 'app/payload.txt'), contents)
      const packed = spawnSync(
        'tar',
        ['--format=ustar', '--uid', '0', '--gid', '0', '-cf', archive, '-C', root, '.'],
        { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } }
      )
      assert.equal(packed.status, 0, packed.stderr)
      return archive
    }
    const layerA = buildLayer('a', 'VERIFIED-A')
    const layerB = buildLayer('b', 'UNVERIFIED-B')
    const layerBytes = readFileSync(layerA)
    const digest = createHash('sha256').update(layerBytes).digest('hex')
    const blobDirectory = resolve(directory, 'saved/blobs/sha256')
    mkdirSync(blobDirectory, { recursive: true })
    writeFileSync(resolve(blobDirectory, digest), layerBytes)
    const saved = resolve(directory, 'saved.tar')
    const packed = spawnSync(
      'tar',
      ['--format=ustar', '-cf', saved, '-C', resolve(directory, 'saved'), 'blobs'],
      { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } }
    )
    assert.equal(packed.status, 0, packed.stderr)

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
    const root = resolve(directory, 'layer-root')
    mkdirSync(resolve(root, 'app'), { recursive: true })
    writeFileSync(resolve(root, 'app/.wh.'), '')
    const layer = resolve(directory, 'layer.tar')
    const packedLayer = spawnSync(
      'tar',
      ['--format=ustar', '--uid', '0', '--gid', '0', '-cf', layer, '-C', root, '.'],
      { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } }
    )
    assert.equal(packedLayer.status, 0, packedLayer.stderr)
    const bytes = readFileSync(layer)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const blobDirectory = resolve(directory, 'saved/blobs/sha256')
    mkdirSync(blobDirectory, { recursive: true })
    writeFileSync(resolve(blobDirectory, digest), bytes)
    const saved = resolve(directory, 'saved.tar')
    const packed = spawnSync(
      'tar',
      ['--format=ustar', '-cf', saved, '-C', resolve(directory, 'saved'), 'blobs'],
      { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } }
    )
    assert.equal(packed.status, 0, packed.stderr)
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
    builder: { id: '' },
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
  for (const mutation of [
    { ...statement, subject: null },
    { ...statement, subject: [{}] },
    { ...statement, predicate: undefined },
    { ...statement, predicate: { runDetails } },
    { ...statement, predicate: { buildDefinition } },
    { ...statement, predicate: { buildDefinition: {}, runDetails } },
    { ...statement, predicate: { buildDefinition, runDetails: {} } }
  ]) {
    assert.throws(
      () => validateSlsaProvenanceStatement(mutation, throwingFatal),
      /invalid provenance attestation/
    )
  }
})

test('the selected platform manifest requires at least one bound provenance subject', () => {
  const digest = `sha256:${'b'.repeat(64)}`
  assert.doesNotThrow(() => requireBoundProvenance([digest], digest, throwingFatal))
  assert.throws(
    () => requireBoundProvenance([], digest, throwingFatal),
    /provenance is missing or not bound/
  )
  assert.throws(
    () => requireBoundProvenance([`sha256:${'c'.repeat(64)}`], digest, throwingFatal),
    /provenance is missing or not bound/
  )
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
    Config: { Labels: { 'meal-agent.m5.owner': name } }
  }]

  assert.equal(
    parseOwnedScratchContainer(JSON.stringify(payload), {
      expectedName: name,
      expectedImageId: imageId,
      expectedContainerId: containerId
    }, throwingFatal).Id,
    containerId
  )

  for (const mutation of [
    { ...payload[0], Id: 'c'.repeat(64) },
    { ...payload[0], Image: `sha256:${'d'.repeat(64)}` },
    { ...payload[0], Name: '/foreign' },
    { ...payload[0], Config: { Labels: { 'meal-agent.m5.owner': 'foreign' } } }
  ]) {
    assert.throws(
      () => parseOwnedScratchContainer(JSON.stringify([mutation]), {
        expectedName: name,
        expectedImageId: imageId,
        expectedContainerId: containerId
      }, throwingFatal),
      /identity did not match/
    )
  }
})

test('the production scan consumes an immutable ID while a test-only locator resolves at most once', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../infra/docker/api-image-scan.mjs'), 'utf8')
  const scanBody = source.slice(source.indexOf('export const scanImage'))
  assert.match(scanBody, /imageTag === null\s*\? expectedImageId/)
  assert.match(scanBody, /\['docker', 'image', 'inspect', imageId\]/)
  assert.match(scanBody, /\['docker', 'image', 'save', '-o', savedImageTarPath, imageId\]/)
  assert.match(scanBody, /validateSavedImageArchive\([\s\S]*?imageInspect[\s\S]*?historyRows/)
  assert.match(scanBody, /verifySavedImageLayers\([\s\S]*?materializeRoot: extractedRoot/)
  assert.doesNotMatch(scanBody, /'docker',\s*'export'/)
  assert.doesNotMatch(scanBody, /'docker',\s*'create'/)
})

test('runtime image entrypoints bind builds and cleanup to immutable ownership evidence', () => {
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
  assert.doesNotMatch(positive, /'--tag'/)
  assert.match(positive, /imageTag: null/)
  assert.match(positive, /cleanupPromise: null/)
  assert.match(positive, /return cleanupState\.cleanupPromise/)
  assert.match(positive, /built image identity could not be recovered/)

  assert.match(mutations, /--iidfile/)
  assert.match(mutations, /expectedImageId:/)
  assert.match(mutations, /parseClaimedBuildImage/)
  assert.match(mutations, /builds: new Map\(\)/)
  assert.match(mutations, /imageTag: null/)
  assert.doesNotMatch(mutations, /'--tag'/)
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
