import { stage09aStepIds } from './stage09a-gate-registry.mjs'

const canonicalSha = /^[0-9a-f]{40}$/
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
    return gate.exitCode === null && handledSignals.has(gate.signal)
  }
  if (gate.reason !== 'gate-failed' || gate.signal !== null || gate.exitCode === 0) {
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
  gate
}) => {
  const scalarInputValid =
    canonicalSha.test(expectedCandidateHead) &&
    (candidateHeadBefore === null || canonicalSha.test(candidateHeadBefore)) &&
    (candidateHeadAfter === null || canonicalSha.test(candidateHeadAfter)) &&
    /^24\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(requiredNodeVersion) &&
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(actualNodeVersion) &&
    typeof worktreeCleanBefore === 'boolean' &&
    typeof worktreeCleanAfter === 'boolean' &&
    Number.isSafeInteger(invocationCount) && invocationCount >= 0 &&
    Number.isSafeInteger(retryCount) && retryCount >= 0 &&
    (requestedSignal === null || handledSignals.has(requestedSignal))
  const gateValid = validateStage09aGateResult(gate)
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
  if (!scalarInputValid) reason = 'report-input-invalid'
  else if (actualNodeVersion !== requiredNodeVersion) reason = 'node-version-mismatch'
  else if (candidateHeadBefore !== expectedCandidateHead) reason = 'candidate-head-mismatch'
  else if (!worktreeCleanBefore) reason = 'worktree-not-clean'
  else if (candidateHeadAfter !== expectedCandidateHead || !worktreeCleanAfter) {
    reason = 'repository-state-drift'
  } else if (requestedSignal !== null) reason = 'audit-signaled'
  else if (invocationCount !== 1 || retryCount !== 0) reason = 'invocation-count-invalid'

  return Object.freeze({
    schemaVersion: 2,
    evidenceKind: 'stage09a-audit-b-single-run',
    candidateHead: canonicalSha.test(expectedCandidateHead) ? expectedCandidateHead : null,
    candidateHeadBefore:
      candidateHeadBefore === null || canonicalSha.test(candidateHeadBefore)
        ? candidateHeadBefore
        : null,
    candidateHeadAfter:
      candidateHeadAfter === null || canonicalSha.test(candidateHeadAfter)
        ? candidateHeadAfter
        : null,
    requiredNodeVersion:
      typeof requiredNodeVersion === 'string' ? requiredNodeVersion : null,
    actualNodeVersion: typeof actualNodeVersion === 'string' ? actualNodeVersion : null,
    worktreeClean,
    worktreeCleanBefore: worktreeCleanBefore === true,
    worktreeCleanAfter: worktreeCleanAfter === true,
    invocationCount: Number.isSafeInteger(invocationCount) ? invocationCount : null,
    retryCount: Number.isSafeInteger(retryCount) ? retryCount : null,
    requestedSignal: handledSignals.has(requestedSignal) ? requestedSignal : null,
    aggregateStepCount: stage09aStepIds.length,
    status: environmentOk && gateValid && gate.status === 'pass' ? 'pass' : 'fail',
    reason,
    gate: sanitizedGate(gate),
    remoteCiVerified: false,
    verdict: 'evidence-only-not-acceptance'
  })
}

export const serializeStage09aAuditBReport = (report) =>
  Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
