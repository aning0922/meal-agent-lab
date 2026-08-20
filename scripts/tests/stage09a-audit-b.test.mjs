import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  createStage09aAuditBReport,
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

const reportInput = ({
  gate = completeGate,
  actualNodeVersion = '24.18.0',
  candidateHeadBefore = candidateHead,
  candidateHeadAfter = candidateHead,
  worktreeCleanBefore = true,
  worktreeCleanAfter = true,
  invocationCount = 1,
  retryCount = 0,
  requestedSignal = null
} = {}) => ({
  expectedCandidateHead: candidateHead,
  candidateHeadBefore,
  candidateHeadAfter,
  requiredNodeVersion: '24.18.0',
  actualNodeVersion,
  worktreeCleanBefore,
  worktreeCleanAfter,
  invocationCount,
  retryCount,
  requestedSignal,
  gate
})

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
  const report = createStage09aAuditBReport(reportInput())
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.status, 'pass')
  assert.equal(report.reason, 'complete')
  assert.equal(report.invocationCount, 1)
  assert.equal(report.retryCount, 0)
  assert.equal(Object.hasOwn(report, 'retries'), false)
  assert.deepEqual(report.gate.completedSteps, [...stage09aStepIds])
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
    const report = createStage09aAuditBReport(reportInput({ gate }))
    assert.equal(report.status, 'fail')
    assert.equal(report.reason, 'gate-output-invalid')
    assert.deepEqual(report.gate.completedSteps, [])
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
    createStage09aAuditBReport(reportInput({ gate }))
  ).toString('utf8')
  assert.doesNotMatch(serialized, /UNTRUSTED/)
})

test('wrong Node candidate and repository state override a valid gate', () => {
  assert.equal(createStage09aAuditBReport(reportInput({
    actualNodeVersion: '20.0.0', invocationCount: 0
  })).reason, 'node-version-mismatch')
  assert.equal(createStage09aAuditBReport(reportInput({
    worktreeCleanBefore: false, invocationCount: 0
  })).reason, 'worktree-not-clean')
  const report = createStage09aAuditBReport(reportInput({
    candidateHeadAfter: 'b'.repeat(40)
  }))
  assert.equal(report.status, 'fail')
  assert.equal(report.reason, 'repository-state-drift')
})

test('actual invocation accounting records zero and multiple attempts without throwing', () => {
  const zero = createStage09aAuditBReport(reportInput({
    gate: {
      status: 'fail', reason: 'gate-failed', exitCode: 1, signal: null,
      completedSteps: [], failedStep: null
    },
    invocationCount: 0,
    retryCount: 0
  }))
  assert.equal(zero.status, 'fail')
  assert.equal(zero.reason, 'invocation-count-invalid')
  const repeated = createStage09aAuditBReport(reportInput({
    invocationCount: 2,
    retryCount: 1
  }))
  assert.equal(repeated.status, 'fail')
  assert.equal(repeated.reason, 'invocation-count-invalid')
  assert.equal(repeated.invocationCount, 2)
  assert.equal(repeated.retryCount, 1)
})

test('a latched signal prevents complete gate evidence from becoming PASS', () => {
  const report = createStage09aAuditBReport(reportInput({ requestedSignal: 'SIGINT' }))
  assert.equal(report.status, 'fail')
  assert.equal(report.reason, 'audit-signaled')
})

test('the report schema does not reflect untrusted input values', () => {
  const sentinel = 'UNTRUSTED-AUDIT-B-SENTINEL'
  const report = createStage09aAuditBReport(reportInput({
    gate: {
      status: 'pass', reason: sentinel, exitCode: 0, signal: sentinel,
      completedSteps: [sentinel], failedStep: sentinel
    }
  }))
  const serialized = serializeStage09aAuditBReport(report).toString('utf8')
  assert.equal(report.status, 'fail')
  assert.equal(report.reason, 'gate-output-invalid')
  assert.doesNotMatch(serialized, new RegExp(sentinel))
})

test('Audit-B calls the structured core directly and has no transcript or child aggregate', () => {
  const source = readFileSync(resolve(repositoryRoot, 'scripts/run-stage09a-audit-b.mjs'), 'utf8')
  assert.match(source, /import \{\s*runStage09aCheck,\s*stage09aInvocationSnapshot\s*\}/)
  assert.equal(source.includes('createStage09aTranscriptRecorder'), false)
  assert.equal(source.includes('runAggregateOnce'), false)
  assert.equal(source.includes("spawn(process.execPath"), false)
  assert.equal((source.match(/await runStage09aCheck\(\[\]\)/g) ?? []).length, 1)
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
