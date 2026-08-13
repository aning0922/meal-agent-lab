import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  composeRunOneOff,
  oneOffIsGone,
  removeLingeringOneOffs
} from '../../infra/docker/m4-lifecycle.mjs'
import {
  checksumSidecarUnparseableReason,
  verifyBackupChecksum
} from '../../infra/docker/restore-local-test.mjs'

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
