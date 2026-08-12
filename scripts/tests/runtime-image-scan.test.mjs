import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  checkDockerignoreText,
  checkDockerfileText,
  checkImageConfig,
  createStrictRunner,
  dockerignorePath,
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
