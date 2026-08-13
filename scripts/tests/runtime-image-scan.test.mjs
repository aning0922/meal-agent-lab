import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  parseImageHistory,
  parseImageInspect,
  parseSavedImageConfig,
  parseSavedImageManifest,
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
  const image = [{ Id: imageId, Config: {}, RootFS: { Type: 'layers', Layers: [layerId] } }]
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
    { CreatedSince: 'nonsense' }
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
    rootfs: { type: 'layers', diff_ids: [layerId] },
    history: contentHistory
  })
  const configPath = `blobs/sha256/${createHash('sha256').update(savedConfig).digest('hex')}`
  assert.equal(
    parseSavedImageManifest(
      JSON.stringify([{ Config: configPath, RepoTags: null, Layers: [`blobs/sha256/${'d'.repeat(64)}`] }]),
      1,
      throwingFatal
    ),
    configPath
  )
  const completeCliHistory = [
    { ...historyRow, CreatedBy: 'CMD ["node"]' },
    { ...historyRow, CreatedBy: 'RUN install-runtime' }
  ]
  assert.doesNotThrow(() =>
    parseSavedImageConfig(
      savedConfig,
      configPath,
      [layerId],
      completeCliHistory,
      throwingFatal,
      () => {}
    )
  )
  assert.throws(
    () =>
      parseSavedImageConfig(
        savedConfig,
        configPath,
        [layerId],
        completeCliHistory.slice(0, 1),
        throwingFatal,
        () => {}
      ),
    /incomplete immutable-image config evidence/
  )
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

test('an excluded package README cannot become an opaque directory subtree', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-image-skipped-path-'))
  try {
    const readme = resolve(directory, '.pnpm/key/node_modules/@meal-agent/contracts/README.md')
    mkdirSync(readme, { recursive: true })
    writeFileSync(resolve(readme, 'hidden-client.js'), 'mutation')
    const problems = []
    dependencyPayloadOf(directory, 'fixture', (message) => problems.push(message))
    assert.deepEqual(problems, ['fixture: skipped dependency metadata must remain a regular file'])
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

test('the scan resolves a mutable tag once and binds all later evidence to the immutable ID', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../infra/docker/api-image-scan.mjs'), 'utf8')
  const scanBody = source.slice(source.indexOf('export const scanImage'))
  assert.equal((scanBody.match(/imageTag/g) ?? []).length, 2, 'signature plus first tag resolution only')
  assert.match(scanBody, /\['docker', 'create', imageId\]/)
  assert.match(scanBody, /\['docker', 'image', 'inspect', imageId\]/)
  assert.match(scanBody, /\['docker', 'container', 'inspect', containerId\]/)
  assert.match(scanBody, /parseContainerInspect\([\s\S]*?containerId,[\s\S]*?imageId,/)
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
    `FROM ${sentinel} AS node-base\nCOPY apps/${sentinel} /app\n`,
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
      Healthcheck: { Test: [sentinel] }
    },
    (message) => problems.push(message),
    throwingFatal
  )

  assert.equal(problems.length > 0, true)
  assert.equal(problems.some((message) => message.includes(sentinel)), false)
})
