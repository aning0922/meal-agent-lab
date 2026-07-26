import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  assertAcceptedAdvisories,
  interpretAuditCommand,
  normalizeAuditRegistryBody,
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

test('exit 2 fails even when JSON contains matching advisories', () => {
  assert.throws(
    () => interpretAuditCommand(command({ status: 2 })),
    /is not a vulnerability result/
  )
})

test('a signalled audit subprocess fails closed', () => {
  assert.throws(
    () =>
      interpretAuditCommand(
        command({ status: null, signal: 'SIGTERM' })
      ),
    /terminated by signal/
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

test('audit registry transport accepts plain JSON and valid gzip JSON', () => {
  const report = Buffer.from(
    JSON.stringify({ advisory: { id: 'GHSA-test-test-test' } })
  )
  assert.deepEqual(normalizeAuditRegistryBody(report), report)
  assert.deepEqual(normalizeAuditRegistryBody(gzipSync(report)), report)
})

test('audit registry transport rejects corrupt gzip and non-JSON bodies', () => {
  assert.throws(
    () =>
      normalizeAuditRegistryBody(
        Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01])
      ),
    /invalid gzip/
  )
  assert.throws(
    () => normalizeAuditRegistryBody(Buffer.from('<html>failure</html>')),
    /non-JSON/
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

test('a new advisory fails closed', () => {
  const { actual } = interpretAuditCommand(command())
  assert.throws(
    () => assertAcceptedAdvisories(validateAuditPolicy(policy()), actual),
    /new advisory/
  )
})

test('a disappeared advisory fails closed', () => {
  const { actual } = interpretAuditCommand(command())
  const accepted = validateAuditPolicy({
    ...policy(),
    advisories: actual
  })
  assert.throws(
    () => assertAcceptedAdvisories(accepted, []),
    /disappeared/
  )
})
