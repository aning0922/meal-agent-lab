import { stage09aStepIds } from './stage09a-gate-registry.mjs'

const canonicalSha = /^[0-9a-f]{40}$/
const handledSignals = new Set(['SIGINT', 'SIGTERM', 'SIGHUP'])

export const createStage09aTranscriptRecorder = () => {
  let buffer = ''
  let errorBuffer = ''
  let discardingErrorLine = false
  let framingInvalid = false
  let finalPassCount = 0
  let failedStep = null
  const started = []
  const passed = []

  const consumeLine = (line) => {
    const start = /^stage09a:check step ([1-9][0-9]*)\/([1-9][0-9]*): ([a-z0-9-]+) — /.exec(line)
    if (start !== null) {
      const index = Number(start[1]) - 1
      if (
        Number(start[2]) !== stage09aStepIds.length ||
        index !== started.length ||
        stage09aStepIds[index] !== start[3]
      ) {
        framingInvalid = true
      } else {
        started.push(start[3])
      }
      return
    }
    const pass = /^stage09a:check step ([1-9][0-9]*)\/([1-9][0-9]*) PASS \((?:0|[1-9][0-9]*)s\)$/.exec(line)
    if (pass !== null) {
      const index = Number(pass[1]) - 1
      if (
        Number(pass[2]) !== stage09aStepIds.length ||
        index !== passed.length ||
        started[index] !== stage09aStepIds[index]
      ) {
        framingInvalid = true
      } else {
        passed.push(stage09aStepIds[index])
      }
      return
    }
    if (line === `stage09a:check PASS (${String(stage09aStepIds.length)}/${String(stage09aStepIds.length)} steps)`) {
      finalPassCount += 1
    }
  }

  const consumeErrorLine = (line) => {
    const failure = /^stage09a:check FAIL at step ([a-z0-9-]+) \(/.exec(line)
    if (failure === null) return
    if (!stage09aStepIds.includes(failure[1]) || failedStep !== null) {
      framingInvalid = true
    } else {
      failedStep = failure[1]
    }
  }

  return Object.freeze({
    accept(chunk) {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
        framingInvalid = true
        return
      }
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > 65_536) {
        framingInvalid = true
        buffer = ''
        return
      }
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.includes('\r')) framingInvalid = true
        consumeLine(line)
      }
    },
    acceptError(chunk) {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
        framingInvalid = true
        return
      }
      errorBuffer += chunk.toString('utf8')
      while (true) {
        const newline = errorBuffer.indexOf('\n')
        if (newline === -1) break
        const line = errorBuffer.slice(0, newline)
        errorBuffer = errorBuffer.slice(newline + 1)
        if (discardingErrorLine) {
          discardingErrorLine = false
          continue
        }
        if (line.includes('\r')) framingInvalid = true
        consumeErrorLine(line)
      }
      if (Buffer.byteLength(errorBuffer) > 65_536) {
        errorBuffer = ''
        discardingErrorLine = true
      }
    },
    finish({ code, signal, timedOut = false, spawnFailed = false }) {
      if (buffer.length > 0) {
        if (buffer.includes('\r')) framingInvalid = true
        consumeLine(buffer)
        buffer = ''
      }
      if (!discardingErrorLine && errorBuffer.length > 0) {
        if (errorBuffer.includes('\r')) framingInvalid = true
        consumeErrorLine(errorBuffer)
      }
      errorBuffer = ''
      discardingErrorLine = false
      const canonicalSignal = handledSignals.has(signal) ? signal : null
      const complete =
        code === 0 &&
        signal === null &&
        !timedOut &&
        !spawnFailed &&
        !framingInvalid &&
        started.length === stage09aStepIds.length &&
        passed.length === stage09aStepIds.length &&
        finalPassCount === 1 &&
        failedStep === null
      let reason = 'gate-failed'
      if (complete) reason = 'complete'
      else if (spawnFailed) reason = 'gate-spawn-failed'
      else if (timedOut) reason = 'gate-timeout'
      else if (signal !== null) reason = 'gate-signaled'
      else if (framingInvalid || code === 0) reason = 'gate-output-invalid'
      return Object.freeze({
        status: complete ? 'pass' : 'fail',
        reason,
        exitCode: Number.isSafeInteger(code) && code >= 0 && code <= 255 ? code : null,
        signal: canonicalSignal,
        completedSteps: Object.freeze([...passed]),
        failedStep
      })
    }
  })
}

export const createStage09aAuditBReport = ({
  expectedCandidateHead,
  candidateHeadBefore,
  candidateHeadAfter,
  requiredNodeVersion,
  actualNodeVersion,
  worktreeCleanBefore,
  worktreeCleanAfter,
  invocationCount,
  retries,
  requestedSignal,
  gate
}) => {
  const inputValid =
    canonicalSha.test(expectedCandidateHead) &&
    (candidateHeadBefore === null || canonicalSha.test(candidateHeadBefore)) &&
    (candidateHeadAfter === null || canonicalSha.test(candidateHeadAfter)) &&
    /^24\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(requiredNodeVersion) &&
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(actualNodeVersion) &&
    typeof worktreeCleanBefore === 'boolean' &&
    typeof worktreeCleanAfter === 'boolean' &&
    Number.isSafeInteger(invocationCount) && invocationCount >= 0 && invocationCount <= 1 &&
    Number.isSafeInteger(retries) && retries === Math.max(0, invocationCount - 1) &&
    (requestedSignal === null || handledSignals.has(requestedSignal)) &&
    gate !== null && typeof gate === 'object'
  if (!inputValid) {
    throw new TypeError('audit B report input was invalid')
  }
  const worktreeClean = worktreeCleanBefore && worktreeCleanAfter
  const environmentOk =
    actualNodeVersion === requiredNodeVersion &&
    candidateHeadBefore === expectedCandidateHead &&
    candidateHeadAfter === expectedCandidateHead &&
    worktreeClean &&
    invocationCount === 1 &&
    retries === 0 &&
    requestedSignal === null
  const passed = environmentOk && gate.status === 'pass'
  let reason = gate.reason
  if (actualNodeVersion !== requiredNodeVersion) reason = 'node-version-mismatch'
  else if (candidateHeadBefore !== expectedCandidateHead) reason = 'candidate-head-mismatch'
  else if (!worktreeCleanBefore) reason = 'worktree-not-clean'
  else if (candidateHeadAfter !== expectedCandidateHead || !worktreeCleanAfter) {
    reason = 'repository-state-drift'
  } else if (requestedSignal !== null) reason = 'audit-signaled'
  else if (invocationCount !== 1 || retries !== 0) reason = 'invocation-count-invalid'
  return Object.freeze({
    schemaVersion: 1,
    evidenceKind: 'stage09a-audit-b-single-run',
    candidateHead: expectedCandidateHead,
    candidateHeadBefore,
    candidateHeadAfter,
    requiredNodeVersion,
    actualNodeVersion,
    worktreeClean,
    worktreeCleanBefore,
    worktreeCleanAfter,
    invocationCount,
    retries,
    requestedSignal,
    aggregateStepCount: stage09aStepIds.length,
    status: passed ? 'pass' : 'fail',
    reason,
    gate: Object.freeze({
      exitCode: gate.exitCode,
      signal: gate.signal,
      completedSteps: Object.freeze([...gate.completedSteps]),
      failedStep: gate.failedStep
    }),
    remoteCiVerified: false,
    verdict: 'evidence-only-not-acceptance'
  })
}

export const serializeStage09aAuditBReport = (report) =>
  Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
