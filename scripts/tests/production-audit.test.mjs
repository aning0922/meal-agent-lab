import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import {
  assertAcceptedAdvisories,
  assertAuditUpstreamStatus,
  interpretAuditCommand,
  normalizeAuditRegistryBody,
  readLimitedAuditStream,
  validateAuditPolicy
} from '../check-production-audit.mjs'

const policy = (expiresAt = '2026-08-08T23:59:59+08:00') => ({
  schemaVersion: 1,
  decision: 'temporary-local-weapp-only',
  acceptedAt: '2026-07-25',
  expiresAt,
  allowedTarget: 'local-weapp',
  blockedTargets: ['h5', 'external-test', 'experience', 'release'],
  artifactRoot: 'apps/client/dist',
  advisories: [],
  forbiddenArtifactSignatures: []
})

const rawAdvisory = {
  github_advisory_id: 'GHSA-test-test-test',
  module_name: 'fixture-module',
  severity: 'high',
  findings: [{ version: '1.0.0', paths: ['fixture>module'] }]
}

const command = (overrides = {}) => ({
  status: 1,
  signal: null,
  stdout: JSON.stringify({
    advisories: { 1: rawAdvisory },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 1,
        critical: 0
      }
    }
  }),
  stderr: '',
  ...overrides
})

test('invalid or infinite expiry fails closed', () => {
  assert.throws(
    () => validateAuditPolicy(policy('not-a-date'), Date.parse('2026-07-25')),
    /finite parseable/
  )
  assert.throws(
    () =>
      validateAuditPolicy(
        policy('2026-02-31T23:59:59+08:00'),
        Date.parse('2026-01-01')
      ),
    /finite parseable/
  )
})

test('an already-expired exception fails closed', () => {
  // 到期强制是「不得静默续期」的工具链侧另一半：过期后任何 target 的审计都
  // 必须硬失败，而不是继续沿用旧例外。到期日当天仍然有效，次日拒绝。
  assert.throws(
    () => validateAuditPolicy(policy(), Date.parse('2026-08-09T00:00:01+08:00')),
    /audit exception has expired/
  )
  assert.doesNotThrow(() =>
    validateAuditPolicy(policy(), Date.parse('2026-08-08T23:59:58+08:00'))
  )
})

test('exit 2 fails even when JSON contains matching advisories', () => {
  assert.throws(
    () => interpretAuditCommand(command({ status: 2 })),
    /non-vulnerability exit status/
  )
})

test('a signalled audit subprocess fails closed', () => {
  assert.throws(
    () =>
      interpretAuditCommand(
        command({ status: null, signal: 'SIGTERM' })
      ),
    /terminated by a signal/
  )
})

test('registry/network error payload fails closed', () => {
  assert.throws(
    () =>
      interpretAuditCommand(
        command({
          status: 1,
          stdout: JSON.stringify({ error: { summary: 'registry unavailable' } })
        })
      ),
    /registry\/network failure/
  )
})

test('audit command failures never echo runner or registry controlled text', () => {
  const sentinel = 'AUDIT-UNTRUSTED-SENTINEL'
  for (const fixture of [
    command({ status: 0, stdout: 'not-json', stderr: sentinel }),
    command({ status: 1, stdout: JSON.stringify({ error: { summary: sentinel } }), stderr: '' }),
    command({ status: null, signal: null, stdout: '', stderr: '', error: new Error(sentinel) })
  ]) {
    assert.throws(
      () => interpretAuditCommand(fixture),
      (error) => error instanceof Error && !error.message.includes(sentinel)
    )
  }
})

test('unexpected metadata keys and advisory identities never enter diagnostics', () => {
  const sentinel = 'AUDIT-UNTRUSTED-SENTINEL'
  const extraKey = command({
    stdout: JSON.stringify({
      advisories: { 1: rawAdvisory },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 1,
          critical: 0,
          [sentinel]: 1
        }
      }
    })
  })
  assert.throws(
    () => interpretAuditCommand(extraKey),
    (error) => error instanceof Error && !error.message.includes(sentinel)
  )

  const duplicate = command({
    stdout: JSON.stringify({
      advisories: { 1: rawAdvisory, 2: { ...rawAdvisory } },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0 }
      }
    })
  })
  assert.throws(() => interpretAuditCommand(duplicate), /duplicate advisory identities/)
})

test('the audit CLI boundary never echoes an untrusted target argument', () => {
  const sentinel = 'AUDIT-UNTRUSTED-SENTINEL'
  const outcome = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, '../check-production-audit.mjs'), `--target=${sentinel}`],
    { encoding: 'utf8' }
  )
  assert.equal(outcome.status, 1)
  assert.match(outcome.stderr, /requested target is not permitted/)
  assert.doesNotMatch(outcome.stderr, new RegExp(sentinel))
})

test('audit registry transport accepts plain JSON and valid gzip JSON', async () => {
  const report = Buffer.from(
    JSON.stringify({ advisory: { id: 'GHSA-test-test-test' } })
  )
  assert.deepEqual(await normalizeAuditRegistryBody(report), report)
  assert.deepEqual(
    await normalizeAuditRegistryBody(gzipSync(report)),
    report
  )
})

test('audit registry transport rejects corrupt gzip and non-JSON bodies', async () => {
  await assert.rejects(
    async () =>
      normalizeAuditRegistryBody(
        Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01])
      ),
    /invalid gzip/
  )
  await assert.rejects(
    async () =>
      normalizeAuditRegistryBody(Buffer.from('<html>failure</html>')),
    /non-JSON/
  )
})

test('audit upstream rejects redirects instead of following them', () => {
  for (const statusCode of [301, 302, 307, 308]) {
    assert.throws(
      () => assertAuditUpstreamStatus(statusCode),
      /redirects are forbidden/
    )
  }
  assert.doesNotThrow(() => assertAuditUpstreamStatus(200))
})

test('audit transport applies separate 16 MiB raw and decoded stream limits', async () => {
  const overLimit = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61)
  await assert.rejects(
    async () =>
      readLimitedAuditStream(
        Readable.from([overLimit]),
        'raw audit registry response'
      ),
    /raw audit registry response exceeds the 16 MiB/
  )
  await assert.rejects(
    async () => normalizeAuditRegistryBody(gzipSync(overLimit)),
    /decoded audit registry response exceeds the 16 MiB/
  )
})

test('missing vulnerability metadata fails closed', () => {
  assert.throws(
    () =>
      interpretAuditCommand(
        command({
          stdout: JSON.stringify({ advisories: { 1: rawAdvisory } })
        })
      ),
    /no vulnerability metadata/
  )
})

// 下面两条必须传显式 `now`：夹具的默认到期日是过去式的 2026-08-08，靠真实挂钟
// 会在到期次日让这两条先撞上「exception expired」而不是各自要断言的理由——
// 2026-08-11 实测整个 suite 就是这样红掉的（时间炸弹，而非判定失真）。
test('a new advisory fails closed', () => {
  const { actual } = interpretAuditCommand(command())
  assert.throws(
    () =>
      assertAcceptedAdvisories(
        validateAuditPolicy(policy(), Date.parse('2026-07-25')),
        actual
      ),
    /unaccepted advisory/
  )
})

test('a disappeared advisory fails closed', () => {
  const { actual } = interpretAuditCommand(command())
  const accepted = validateAuditPolicy(
    {
      ...policy(),
      advisories: actual
    },
    Date.parse('2026-07-25')
  )
  assert.throws(
    () => assertAcceptedAdvisories(accepted, []),
    /disappeared/
  )
})
