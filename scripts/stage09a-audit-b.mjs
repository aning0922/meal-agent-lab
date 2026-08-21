import { stage09aStepIds } from './stage09a-gate-registry.mjs'
import { readStage09aAuditRunReceipt } from './run-stage09a-check.mjs'

const canonicalSha = /^[0-9a-f]{40}$/
const requiredNodeVersionPattern = /^24\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
const actualNodeVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
const handledSignals = new Set(['SIGINT', 'SIGTERM', 'SIGHUP'])
const gateReasons = new Set(['complete', 'gate-failed', 'gate-signaled'])
const gateKeys = Object.freeze([
  'completedSteps',
  'exitCode',
  'failedStep',
  'reason',
  'signal',
  'status'
])

const canonicalShaValue = (value) =>
  typeof value === 'string' && canonicalSha.test(value)

const nonnegativeSafeInteger = (value) =>
  Number.isSafeInteger(value) && value >= 0

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())

const completedPrefixIsValid = (completedSteps) =>
  Array.isArray(completedSteps) &&
  completedSteps.length <= stage09aStepIds.length &&
  completedSteps.every((id, index) => id === stage09aStepIds[index])

export const validateStage09aGateResult = (gate) => {
  if (!exactKeys(gate, gateKeys)) return false
  if (gate.status !== 'pass' && gate.status !== 'fail') return false
  if (!gateReasons.has(gate.reason)) return false
  if (
    gate.exitCode !== null &&
    (!Number.isSafeInteger(gate.exitCode) || gate.exitCode < 0 || gate.exitCode > 255)
  ) return false
  if (gate.signal !== null && !handledSignals.has(gate.signal)) return false
  if (!completedPrefixIsValid(gate.completedSteps)) return false
  if (gate.failedStep !== null && !stage09aStepIds.includes(gate.failedStep)) return false

  if (gate.status === 'pass') {
    return (
      gate.reason === 'complete' &&
      gate.exitCode === 0 &&
      gate.signal === null &&
      gate.completedSteps.length === stage09aStepIds.length &&
      gate.failedStep === null
    )
  }
  if (gate.reason === 'gate-signaled') {
    if (gate.exitCode !== null || !handledSignals.has(gate.signal)) return false
    return gate.failedStep === null ||
      gate.failedStep === stage09aStepIds[gate.completedSteps.length]
  }
  if (
    gate.reason !== 'gate-failed' ||
    gate.signal !== null ||
    gate.exitCode === null ||
    gate.exitCode === 0
  ) {
    return false
  }
  if (gate.failedStep === null) return true
  return gate.failedStep === stage09aStepIds[gate.completedSteps.length]
}

const fixedInvalidGate = Object.freeze({
  exitCode: null,
  signal: null,
  completedSteps: Object.freeze([]),
  failedStep: null
})

const sanitizedGate = (gate) => validateStage09aGateResult(gate)
  ? Object.freeze({
      exitCode: gate.exitCode,
      signal: gate.signal,
      completedSteps: Object.freeze([...gate.completedSteps]),
      failedStep: gate.failedStep
    })
  : fixedInvalidGate

export const createStage09aAuditBReport = ({
  expectedCandidateHead,
  candidateHeadBefore,
  candidateHeadAfter,
  requiredNodeVersion,
  actualNodeVersion,
  worktreeCleanBefore,
  worktreeCleanAfter,
  invocationCount,
  retryCount,
  requestedSignal,
  gate,
  runEvidenceValid = true
}) => {
  const requiredNodeVersionValid =
    typeof requiredNodeVersion === 'string' &&
    requiredNodeVersionPattern.test(requiredNodeVersion)
  const actualNodeVersionValid =
    typeof actualNodeVersion === 'string' &&
    actualNodeVersionPattern.test(actualNodeVersion)
  const environmentScalarValid =
    canonicalShaValue(expectedCandidateHead) &&
    (candidateHeadBefore === null || canonicalShaValue(candidateHeadBefore)) &&
    (candidateHeadAfter === null || canonicalShaValue(candidateHeadAfter)) &&
    requiredNodeVersionValid &&
    actualNodeVersionValid &&
    typeof worktreeCleanBefore === 'boolean' &&
    typeof worktreeCleanAfter === 'boolean'
  const accountingShapeValid =
    nonnegativeSafeInteger(invocationCount) &&
    nonnegativeSafeInteger(retryCount) &&
    (requestedSignal === null || handledSignals.has(requestedSignal))
  const scalarInputValid =
    environmentScalarValid && accountingShapeValid && runEvidenceValid === true
  const gateValid = validateStage09aGateResult(gate) && gate.signal === requestedSignal
  const worktreeClean = worktreeCleanBefore === true && worktreeCleanAfter === true
  const environmentOk =
    scalarInputValid &&
    actualNodeVersion === requiredNodeVersion &&
    candidateHeadBefore === expectedCandidateHead &&
    candidateHeadAfter === expectedCandidateHead &&
    worktreeClean &&
    invocationCount === 1 &&
    retryCount === 0 &&
    requestedSignal === null

  let reason = gateValid ? gate.reason : 'gate-output-invalid'
  if (!environmentScalarValid) reason = 'report-input-invalid'
  else if (actualNodeVersion !== requiredNodeVersion) reason = 'node-version-mismatch'
  else if (candidateHeadBefore !== expectedCandidateHead) reason = 'candidate-head-mismatch'
  else if (!worktreeCleanBefore) reason = 'worktree-not-clean'
  else if (candidateHeadAfter !== expectedCandidateHead || !worktreeCleanAfter) {
    reason = 'repository-state-drift'
  } else if (runEvidenceValid !== true) reason = 'run-evidence-invalid'
  else if (!accountingShapeValid) reason = 'report-input-invalid'
  else if (!gateValid) reason = 'gate-output-invalid'
  else if (requestedSignal !== null) reason = 'audit-signaled'
  else if (invocationCount !== 1 || retryCount !== 0) reason = 'invocation-count-invalid'

  return Object.freeze({
    schemaVersion: 3,
    evidenceKind: 'stage09a-audit-b-single-run',
    candidateHead: canonicalShaValue(expectedCandidateHead) ? expectedCandidateHead : null,
    candidateHeadBefore:
      candidateHeadBefore === null || canonicalShaValue(candidateHeadBefore)
        ? candidateHeadBefore
        : null,
    candidateHeadAfter:
      candidateHeadAfter === null || canonicalShaValue(candidateHeadAfter)
        ? candidateHeadAfter
        : null,
    requiredNodeVersion: requiredNodeVersionValid ? requiredNodeVersion : null,
    actualNodeVersion: actualNodeVersionValid ? actualNodeVersion : null,
    worktreeClean,
    worktreeCleanBefore: worktreeCleanBefore === true,
    worktreeCleanAfter: worktreeCleanAfter === true,
    invocationCount: nonnegativeSafeInteger(invocationCount) ? invocationCount : null,
    retryCount: nonnegativeSafeInteger(retryCount) ? retryCount : null,
    requestedSignal: handledSignals.has(requestedSignal) ? requestedSignal : null,
    aggregateStepCount: stage09aStepIds.length,
    status: environmentOk && gateValid && gate.status === 'pass' ? 'pass' : 'fail',
    reason,
    gate: sanitizedGate(gate),
    remoteCiVerified: false,
    verdict: 'evidence-only-not-acceptance'
  })
}

/** Production boundary: only a receipt issued by the shared core may supply
 * gate, signal and invocation accounting to the published report. */
export const createStage09aAuditBReportFromReceipt = ({ runReceipt, ...environment }) => {
  const evidence = readStage09aAuditRunReceipt(runReceipt)
  return createStage09aAuditBReport({
    ...environment,
    runEvidenceValid: evidence !== null,
    invocationCount: evidence?.invocationCount ?? null,
    retryCount: evidence?.retryCount ?? null,
    requestedSignal: evidence?.requestedSignal ?? null,
    gate: evidence?.gate ?? null
  })
}

export const serializeStage09aAuditBReport = (report) =>
  Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
