import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  createStage09aAuditBReportFromReceipt,
  isCanonicalStage09aAuditCount,
  serializeStage09aAuditBReport,
  validateStage09aGateResult
} from '../stage09a-audit-b.mjs'
import { parseStage09aAuditBArguments } from '../run-stage09a-audit-b.mjs'
import { stage09aStepIds } from '../stage09a-gate-registry.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const candidateHead = 'a'.repeat(40)
const completeGate = Object.freeze({
  status: 'pass',
  reason: 'complete',
  exitCode: 0,
  signal: null,
  completedSteps: Object.freeze([...stage09aStepIds]),
  failedStep: null
})

const reportEnvironment = ({
  actualNodeVersion = '24.18.0',
  candidateHeadBefore = candidateHead,
  candidateHeadAfter = candidateHead,
  worktreeCleanBefore = true,
  worktreeCleanAfter = true
} = {}) => ({
  expectedCandidateHead: candidateHead,
  candidateHeadBefore,
  candidateHeadAfter,
  requiredNodeVersion: '24.18.0',
  actualNodeVersion,
  worktreeCleanBefore,
  worktreeCleanAfter
})

const reportFromReceipt = (runReceipt, overrides = {}) => {
  const environment = reportEnvironment(overrides)
  return createStage09aAuditBReportFromReceipt(
    runReceipt,
    environment.expectedCandidateHead,
    environment.candidateHeadBefore,
    environment.candidateHeadAfter,
    environment.requiredNodeVersion,
    environment.actualNodeVersion,
    environment.worktreeCleanBefore,
    environment.worktreeCleanAfter
  )
}

test('audit B accepts only the basename argv shape produced by pnpm', () => {
  assert.deepEqual(
    parseStage09aAuditBArguments([
      '--', '--expected-head', candidateHead, '--report', 'm5-candidate-b.json'
    ]),
    { expectedCandidateHead: candidateHead, reportName: 'm5-candidate-b.json' }
  )
  assert.deepEqual(
    parseStage09aAuditBArguments(['--expected-head', candidateHead]),
    { expectedCandidateHead: candidateHead, reportName: null }
  )
  assert.equal(parseStage09aAuditBArguments([]), null)
  assert.equal(parseStage09aAuditBArguments(['--report', 'm5-candidate-b.json']), null)
  assert.equal(parseStage09aAuditBArguments([
    '--expected-head', candidateHead, '--report', '../escape-b.json'
  ]), null)
})

test('the structured gate accepts exactly one closed 14-step PASS shape', () => {
  assert.equal(validateStage09aGateResult(completeGate), true)
  const forged = reportFromReceipt(Object.freeze({}))
  assert.equal(forged.schemaVersion, 3)
  assert.equal(forged.status, 'fail')
  assert.equal(forged.reason, 'run-evidence-invalid')
  assert.equal(forged.invocationCount, null)
  assert.equal(forged.retryCount, null)
  assert.equal(Object.hasOwn(forged, 'retries'), false)
  assert.deepEqual(forged.gate.completedSteps, [])
})

test('empty reordered duplicate and unknown gate evidence can never publish PASS', () => {
  const mutations = [
    { ...completeGate, completedSteps: [] },
    { ...completeGate, completedSteps: [...stage09aStepIds].reverse() },
    { ...completeGate, completedSteps: [...stage09aStepIds, stage09aStepIds.at(-1)] },
    { ...completeGate, reason: 'UNTRUSTED-REASON' },
    { ...completeGate, extra: true },
    { ...completeGate, signal: 'SIGUSR1' },
    { ...completeGate, failedStep: stage09aStepIds[0] }
  ]
  for (const gate of mutations) {
    assert.equal(validateStage09aGateResult(gate), false)
  }
})

test('a failure gate is a trusted ordered prefix with the next failed step', () => {
  const gate = Object.freeze({
    status: 'fail',
    reason: 'gate-failed',
    exitCode: 23,
    signal: null,
    completedSteps: Object.freeze(stage09aStepIds.slice(0, 3)),
    failedStep: stage09aStepIds[3]
  })
  assert.equal(validateStage09aGateResult(gate), true)
  const serialized = serializeStage09aAuditBReport(
    reportFromReceipt(Object.freeze({}))
  ).toString('utf8')
  assert.doesNotMatch(serialized, /UNTRUSTED/)
})

test('wrong Node candidate and repository state override an invalid receipt safely', () => {
  const receipt = Object.freeze({})
  assert.equal(reportFromReceipt(receipt, {
    actualNodeVersion: '20.0.0'
  }).reason, 'node-version-mismatch')
  assert.equal(reportFromReceipt(receipt, {
    worktreeCleanBefore: false
  }).reason, 'worktree-not-clean')
  const report = reportFromReceipt(receipt, {
    candidateHeadAfter: 'b'.repeat(40)
  })
  assert.equal(report.status, 'fail')
  assert.equal(report.reason, 'repository-state-drift')
})

test('a forged receipt cannot reflect untrusted input values', () => {
  const sentinel = 'UNTRUSTED-AUDIT-B-SENTINEL'
  const report = reportFromReceipt(Object.freeze({ [sentinel]: sentinel }))
  const serialized = serializeStage09aAuditBReport(report).toString('utf8')
  assert.equal(report.status, 'fail')
  assert.equal(report.reason, 'run-evidence-invalid')
  assert.doesNotMatch(serialized, new RegExp(sentinel))
})

test('invalid scalar fields and forged run receipts collapse without reflecting input', () => {
  const sentinel = 'UNTRUSTED-NODE-VERSION-SENTINEL'
  const environment = reportEnvironment()
  const scalarReport = createStage09aAuditBReportFromReceipt(
    Object.freeze({}),
    environment.expectedCandidateHead,
    environment.candidateHeadBefore,
    environment.candidateHeadAfter,
    sentinel,
    sentinel,
    environment.worktreeCleanBefore,
    environment.worktreeCleanAfter
  )
  const scalarSerialized = serializeStage09aAuditBReport(scalarReport).toString('utf8')
  assert.equal(scalarReport.status, 'fail')
  assert.equal(scalarReport.reason, 'report-input-invalid')
  assert.equal(scalarReport.requiredNodeVersion, null)
  assert.equal(scalarReport.actualNodeVersion, null)
  assert.doesNotMatch(scalarSerialized, new RegExp(sentinel))

  const receiptReport = reportFromReceipt(Object.freeze({}))
  assert.equal(receiptReport.status, 'fail')
  assert.equal(receiptReport.reason, 'run-evidence-invalid')
  assert.equal(receiptReport.invocationCount, null)
  assert.deepEqual(receiptReport.gate.completedSteps, [])
})

test('candidate scalars are positional canonical primitives without coercion', () => {
  let coercions = 0
  const sentinel = 'NONCANONICAL-CANDIDATE-SENTINEL'
  const hostileCandidate = {
    toString() {
      coercions += 1
      return candidateHead
    },
    toJSON() {
      return sentinel
    },
    [Symbol.toPrimitive]() {
      coercions += 1
      return candidateHead
    }
  }
  const report = createStage09aAuditBReportFromReceipt(
    Object.freeze({}),
    hostileCandidate,
    hostileCandidate,
    hostileCandidate,
    '24.18.0',
    '24.18.0',
    true,
    true
  )
  const serialized = serializeStage09aAuditBReport(report).toString('utf8')
  assert.equal(report.status, 'fail')
  assert.equal(report.reason, 'report-input-invalid')
  assert.equal(report.candidateHead, null)
  assert.equal(report.candidateHeadBefore, null)
  assert.equal(report.candidateHeadAfter, null)
  assert.equal(report.invocationCount, null)
  assert.equal(report.retryCount, null)
  assert.equal(coercions, 0)
  assert.doesNotMatch(serialized, new RegExp(sentinel))
})

test('the report boundary has no object-shaped environment record to read', () => {
  let getterCalls = 0
  const hostileScalar = {}
  Object.defineProperty(hostileScalar, 'value', {
    get() {
      getterCalls += 1
      return candidateHead
    }
  })
  const accessorReport = createStage09aAuditBReportFromReceipt(
    Object.freeze({}),
    hostileScalar,
    candidateHead,
    candidateHead,
    '24.18.0',
    '24.18.0',
    true,
    true
  )
  assert.equal(getterCalls, 0)
  assert.equal(accessorReport.status, 'fail')
  assert.equal(accessorReport.reason, 'report-input-invalid')

  let proxyReads = 0
  const proxyReceipt = new Proxy({}, {
    get(target, key, receiver) {
      proxyReads += 1
      return Reflect.get(target, key, receiver)
    }
  })
  const proxyReport = reportFromReceipt(proxyReceipt)
  assert.equal(proxyReads, 0)
  assert.equal(proxyReport.status, 'fail')
  assert.equal(proxyReport.reason, 'run-evidence-invalid')
})

test('negative zero is not canonical invocation accounting', () => {
  assert.equal(isCanonicalStage09aAuditCount(-0), false)
  assert.equal(isCanonicalStage09aAuditCount(0), true)
  assert.equal(isCanonicalStage09aAuditCount(1), true)
})

test('the audit receipt core has a silent presentation boundary', () => {
  const fixture = [
    `import { runStage09aCheckForAudit } from ${JSON.stringify(resolve(repositoryRoot, 'scripts/run-stage09a-check.mjs'))}`,
    "await runStage09aCheckForAudit(['--invalid-audit-fixture'])"
  ].join('\n')
  const outcome = spawnSync(process.execPath, ['--input-type=module', '--eval', fixture], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000
  })
  assert.equal(outcome.status, 0, outcome.stderr)
  assert.equal(outcome.stdout, '')
  assert.equal(outcome.stderr, '')
})

test('a later aggregate invocation invalidates an already issued receipt', () => {
  const fixture = [
    `import { readStage09aAuditRunReceipt, runStage09aCheck, runStage09aCheckForAudit } from ${JSON.stringify(resolve(repositoryRoot, 'scripts/run-stage09a-check.mjs'))}`,
    "const receipt = await runStage09aCheckForAudit(['--invalid-audit-fixture'])",
    'const before = readStage09aAuditRunReceipt(receipt) !== null',
    "await runStage09aCheck(['--invalid-second-invocation'])",
    'const after = readStage09aAuditRunReceipt(receipt) !== null',
    'process.stdout.write(JSON.stringify({ before, after }))'
  ].join('\n')
  const outcome = spawnSync(process.execPath, ['--input-type=module', '--eval', fixture], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000
  })
  assert.equal(outcome.status, 0, outcome.stderr)
  assert.deepEqual(JSON.parse(outcome.stdout), { before: true, after: false })
})

test('a concurrent public invocation cannot switch an active audit presentation', () => {
  const fixture = [
    `import { runStage09aCheck, runStage09aCheckForAudit } from ${JSON.stringify(resolve(repositoryRoot, 'scripts/run-stage09a-check.mjs'))}`,
    "const audit = runStage09aCheckForAudit(['--invalid-audit-fixture'])",
    "await runStage09aCheck(['--invalid-public-fixture'])",
    'await audit'
  ].join('\n')
  const outcome = spawnSync(process.execPath, ['--input-type=module', '--eval', fixture], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000
  })
  assert.equal(outcome.status, 0, outcome.stderr)
  assert.equal(outcome.stdout, '')
  assert.equal(outcome.stderr, '')
})

test('ordinary and signaled gate evidence rejects contradictory settlement shapes', () => {
  const invalid = [
    {
      status: 'fail', reason: 'gate-failed', exitCode: null, signal: null,
      completedSteps: [], failedStep: null
    },
    {
      status: 'fail', reason: 'gate-signaled', exitCode: null, signal: 'SIGTERM',
      completedSteps: [], failedStep: stage09aStepIds.at(-1)
    }
  ]
  for (const gate of invalid) assert.equal(validateStage09aGateResult(gate), false)
})

test('Audit-B calls the structured core directly and has no transcript or child aggregate', () => {
  const source = readFileSync(resolve(repositoryRoot, 'scripts/run-stage09a-audit-b.mjs'), 'utf8')
  assert.match(source, /import \{\s*runStage09aCheckForAudit\s*\}/)
  assert.equal(source.includes('createStage09aTranscriptRecorder'), false)
  assert.equal(source.includes('runAggregateOnce'), false)
  assert.equal(source.includes("spawn(process.execPath"), false)
  assert.equal((source.match(/await runStage09aCheckForAudit\(\[\]\)/g) ?? []).length, 1)
  assert.equal(source.includes('stage09aInvocationSnapshot'), false)
  assert.equal(source.includes('outcome.gate'), false)
  assert.match(source, /nativeWrite\(1, 'stage09a:audit-b structured report published\\n'\)/)
  assert.equal(source.includes('.local/audit-reports/${reportName}'), false)
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts['stage09a:audit-b'], 'node scripts/run-stage09a-audit-b.mjs')
})

test('canonical Git reads are mandatory before both repository snapshots', () => {
  const source = readFileSync(resolve(repositoryRoot, 'scripts/run-stage09a-audit-b.mjs'), 'utf8')
  assert.match(source, /assertCanonicalGitRepositoryView\(repositoryRoot, process\.env\)/)
  assert.match(source, /canonicalGitArguments\(\['rev-parse'/)
  assert.match(source, /canonicalGitArguments\(\['status'/)
  assert.equal((source.match(/readRepositoryState\(\)/g) ?? []).length, 2)
})
