import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  createStage09aAuditBReport,
  createStage09aTranscriptRecorder,
  serializeStage09aAuditBReport
} from '../stage09a-audit-b.mjs'
import {
  createStage09aAuditBSignalController,
  parseStage09aAuditBArguments
} from '../run-stage09a-audit-b.mjs'
import { stage09aStepIds } from '../stage09a-gate-registry.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const candidateHead = 'a'.repeat(40)

test('audit B accepts the argv shape produced by pnpm 11', () => {
  assert.deepEqual(
    parseStage09aAuditBArguments([
      '--',
      '--expected-head',
      candidateHead,
      '--report',
      'm5-candidate-b.json'
    ]),
    { expectedCandidateHead: candidateHead, reportName: 'm5-candidate-b.json' }
  )
  assert.deepEqual(
    parseStage09aAuditBArguments(['--expected-head', candidateHead]),
    { expectedCandidateHead: candidateHead, reportName: null }
  )
  assert.equal(parseStage09aAuditBArguments([]), null)
  assert.equal(parseStage09aAuditBArguments(['--report', 'm5-candidate-b.json']), null)
  assert.equal(parseStage09aAuditBArguments(['--', '--report', '../escape.json']), null)
})

const reportInput = ({
  gate,
  actualNodeVersion = '24.18.0',
  candidateHeadBefore = candidateHead,
  candidateHeadAfter = candidateHead,
  worktreeCleanBefore = true,
  worktreeCleanAfter = true,
  invocationCount = 1,
  retries = 0,
  requestedSignal = null
}) => ({
  expectedCandidateHead: candidateHead,
  candidateHeadBefore,
  candidateHeadAfter,
  requiredNodeVersion: '24.18.0',
  actualNodeVersion,
  worktreeCleanBefore,
  worktreeCleanAfter,
  invocationCount,
  retries,
  requestedSignal,
  gate
})

const successfulTranscript = () => [
  ...stage09aStepIds.flatMap((id, index) => [
    `stage09a:check step ${String(index + 1)}/${String(stage09aStepIds.length)}: ${id} — title`,
    `stage09a:check step ${String(index + 1)}/${String(stage09aStepIds.length)} PASS (1s)`
  ]),
  `stage09a:check PASS (${String(stage09aStepIds.length)}/${String(stage09aStepIds.length)} steps)`,
  ''
].join('\n')

test('audit B accepts exactly one ordered complete aggregate transcript', () => {
  const recorder = createStage09aTranscriptRecorder()
  const transcript = successfulTranscript()
  recorder.accept(transcript.slice(0, 79))
  recorder.accept(Buffer.from(transcript.slice(79)))
  assert.deepEqual(recorder.finish({ code: 0, signal: null }), {
    status: 'pass',
    reason: 'complete',
    exitCode: 0,
    signal: null,
    completedSteps: [...stage09aStepIds],
    failedStep: null
  })
})

test('zero exit cannot hide missing, reordered, duplicate or malformed evidence', () => {
  for (const transcript of [
    successfulTranscript().replace(/stage09a:check step 8\/14 PASS \(1s\)\n/, ''),
    successfulTranscript().replace('step 2/14:', 'step 3/14:'),
    successfulTranscript().replace(
      'stage09a:check PASS (14/14 steps)\n',
      'stage09a:check PASS (14/14 steps)\nstage09a:check PASS (14/14 steps)\n'
    ),
    `${successfulTranscript()}stage09a:check step 15/14 PASS (1s)\n`,
    `stage09a:check step 1/14: ${stage09aStepIds[0]} — ${'x'.repeat(70_000)}`
  ]) {
    const recorder = createStage09aTranscriptRecorder()
    recorder.accept(transcript)
    assert.equal(recorder.finish({ code: 0, signal: null }).reason, 'gate-output-invalid')
  }
})

test('failure reports contain only closed categories and trusted step ids', () => {
  const recorder = createStage09aTranscriptRecorder()
  recorder.accept(`stage09a:check step 1/14: ${stage09aStepIds[0]} — title\n`)
  recorder.acceptError([
    `stage09a:check FAIL at step ${stage09aStepIds[0]} (UNTRUSTED-SENTINEL)`,
    ''
  ].join('\n'))
  const gate = recorder.finish({ code: 1, signal: null })
  const report = createStage09aAuditBReport(reportInput({ gate }))
  const serialized = serializeStage09aAuditBReport(report).toString('utf8')
  assert.equal(report.status, 'fail')
  assert.equal(report.reason, 'gate-failed')
  assert.equal(report.gate.failedStep, stage09aStepIds[0])
  assert.doesNotMatch(serialized, /UNTRUSTED-SENTINEL/)
  assert.equal(report.invocationCount, 1)
  assert.equal(report.retries, 0)
  assert.equal(report.remoteCiVerified, false)
})

test('wrong Node and a dirty worktree prevent a PASS report', () => {
  const completeGate = createStage09aTranscriptRecorder()
  completeGate.accept(successfulTranscript())
  const gate = completeGate.finish({ code: 0, signal: null })
  assert.equal(createStage09aAuditBReport(reportInput({
    gate,
    actualNodeVersion: '20.0.0',
    invocationCount: 0
  })).reason, 'node-version-mismatch')
  assert.equal(createStage09aAuditBReport(reportInput({
    gate,
    worktreeCleanBefore: false,
    invocationCount: 0
  })).reason, 'worktree-not-clean')
})

test('the report binds the expected candidate to both repository snapshots', () => {
  const completeGate = createStage09aTranscriptRecorder()
  completeGate.accept(successfulTranscript())
  const gate = completeGate.finish({ code: 0, signal: null })
  const driftedHead = 'b'.repeat(40)
  const report = createStage09aAuditBReport(reportInput({
    gate,
    candidateHeadAfter: driftedHead
  }))
  assert.equal(report.status, 'fail')
  assert.equal(report.reason, 'repository-state-drift')
  assert.equal(report.candidateHead, candidateHead)
  assert.equal(report.candidateHeadBefore, candidateHead)
  assert.equal(report.candidateHeadAfter, driftedHead)
  assert.equal(report.worktreeClean, true)
})

test('invocation and retry evidence comes from the observed execution count', () => {
  const gate = Object.freeze({
    status: 'fail',
    reason: 'gate-not-started',
    exitCode: null,
    signal: null,
    completedSteps: Object.freeze([]),
    failedStep: null
  })
  const report = createStage09aAuditBReport(reportInput({
    gate,
    invocationCount: 0,
    retries: 0
  }))
  assert.equal(report.invocationCount, 0)
  assert.equal(report.retries, 0)
  assert.equal(report.status, 'fail')
})

test('audit B owns INT TERM and HUP across preflight child and publication phases', async () => {
  const processObject = new EventEmitter()
  const deliveries = []
  const child = { pid: 8123 }
  const controller = createStage09aAuditBSignalController({
    processObject,
    deliverToChild: (candidate, signal) => {
      deliveries.push([candidate.pid, signal])
      return true
    }
  })
  controller.install()
  assert.deepEqual(
    ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => processObject.listenerCount(signal)),
    [1, 1, 1]
  )
  processObject.emit('SIGHUP')
  controller.attach(child)
  assert.deepEqual(deliveries, [[8123, 'SIGHUP']])
  assert.deepEqual(controller.snapshot(), {
    requestedSignal: 'SIGHUP',
    deliveryFailed: false
  })
  await controller.checkpoint()
  controller.detach(child)
  controller.remove()
  assert.deepEqual(
    ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => processObject.listenerCount(signal)),
    [0, 0, 0]
  )
})

test('audit B treats a false child signal delivery as a fixed failure', () => {
  const processObject = new EventEmitter()
  let forceCount = 0
  const controller = createStage09aAuditBSignalController({
    processObject,
    deliverToChild: () => false,
    forceChildExit: () => { forceCount += 1 }
  })
  controller.install()
  controller.attach({ pid: 8124 })
  processObject.emit('SIGTERM')
  assert.deepEqual(controller.snapshot(), {
    requestedSignal: 'SIGTERM',
    deliveryFailed: true
  })
  assert.equal(forceCount, 1)
  controller.remove()
})

test('a latched signal prevents a complete aggregate from becoming PASS evidence', () => {
  const recorder = createStage09aTranscriptRecorder()
  recorder.accept(successfulTranscript())
  const report = createStage09aAuditBReport(reportInput({
    gate: recorder.finish({ code: 0, signal: null }),
    requestedSignal: 'SIGINT'
  }))
  assert.equal(report.status, 'fail')
  assert.equal(report.reason, 'audit-signaled')
})

test('the production entry is one aggregate invocation with no retry loop', () => {
  const source = readFileSync(resolve(repositoryRoot, 'scripts/run-stage09a-audit-b.mjs'), 'utf8')
  assert.equal((source.match(/spawn\(process\.execPath, \[aggregateEntrypoint\]/g) ?? []).length, 1)
  assert.equal((source.match(/runAggregateOnce\(signalController\)/g) ?? []).length, 1)
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts['stage09a:audit-b'], 'node scripts/run-stage09a-audit-b.mjs')
})
