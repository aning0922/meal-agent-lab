#!/usr/bin/env node
// M5 动态审计的唯一执行入口：固定 Node、单次完整链、零重试、结构化报告。
// 它不作 CLEAN/Accepted 裁定；审计 B 只读检查源码并消费本命令的一份报告。

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  identityStillNamesFile,
  writeExclusiveEvidenceFile
} from '../infra/docker/m5-evidence-protocol.mjs'
import { ambientGitRepositoryViewOverrides } from '../infra/docker/local-test-secrets-contract.mjs'
import {
  createStage09aAuditBReport,
  createStage09aTranscriptRecorder,
  serializeStage09aAuditBReport
} from './stage09a-audit-b.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const reportDirectory = resolve(repositoryRoot, '.local/audit-reports')
const aggregateEntrypoint = resolve(repositoryRoot, 'scripts/run-stage09a-check.mjs')
const nativeKill = process.kill.bind(process)
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis)
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis)
const nativeSetImmediate = globalThis.setImmediate.bind(globalThis)
const nativeWrite = (fd, value) => {
  try {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (!Number.isSafeInteger(written) || written <= 0) return false
      offset += written
    }
    return true
  } catch {
    return false
  }
}

const fixedDiagnostic = (message) => nativeWrite(2, `stage09a:audit-b FAIL — ${message}\n`)
const reportNamePattern = /^m5-[a-z0-9][a-z0-9.-]{0,79}-b\.json$/

export const parseStage09aAuditBArguments = (argv) => {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv
  if (
    normalized.length === 2 &&
    normalized[0] === '--expected-head' &&
    /^[0-9a-f]{40}$/.test(normalized[1])
  ) {
    return { expectedCandidateHead: normalized[1], reportName: null }
  }
  if (
    normalized.length === 4 &&
    normalized[0] === '--expected-head' &&
    /^[0-9a-f]{40}$/.test(normalized[1]) &&
    normalized[2] === '--report' &&
    reportNamePattern.test(normalized[3])
  ) {
    return { expectedCandidateHead: normalized[1], reportName: normalized[3] }
  }
  return null
}

const readRepositoryState = () => {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024
  })
  const status = spawnSync('git', ['status', '--short'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  })
  const candidateHead = head.status === 0 && /^[0-9a-f]{40}\n?$/.test(head.stdout)
    ? head.stdout.trim()
    : null
  const worktreeClean = status.status === 0 && status.stdout === ''
  return { candidateHead, worktreeClean }
}

const eventLoopTurn = () => new Promise((resolveTurn) => nativeSetImmediate(resolveTurn))

export const createStage09aAuditBSignalController = ({
  processObject = process,
  deliverToChild = (child, signal) => child.kill(signal),
  forceChildExit = (child) => nativeKill(child.pid, 'SIGKILL')
} = {}) => {
  let installed = false
  let child = null
  let requestedSignal = null
  let deliveryFailed = false
  const handlers = new Map()
  const deliver = () => {
    if (child === null || requestedSignal === null) return
    try {
      if (deliverToChild(child, requestedSignal) !== true) deliveryFailed = true
    } catch {
      deliveryFailed = true
    }
    if (deliveryFailed) {
      try { forceChildExit(child) } catch {}
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers.set(signal, () => {
      if (requestedSignal !== null) return
      requestedSignal = signal
      deliver()
    })
  }
  return Object.freeze({
    install() {
      if (installed) return
      installed = true
      for (const [signal, handler] of handlers) processObject.on(signal, handler)
    },
    attach(nextChild) {
      child = nextChild
      deliver()
    },
    detach(expectedChild) {
      if (child === expectedChild) child = null
    },
    remove() {
      if (!installed) return
      for (const [signal, handler] of handlers) processObject.removeListener(signal, handler)
      installed = false
    },
    async checkpoint() {
      await eventLoopTurn()
      await eventLoopTurn()
    },
    snapshot() {
      return Object.freeze({ requestedSignal, deliveryFailed })
    }
  })
}

const runAggregateOnce = (signalController) => new Promise((resolveRun) => {
  const recorder = createStage09aTranscriptRecorder()
  let child = null
  let closed = false
  let timedOut = false
  let spawnFailed = false
  let timeoutTimer = null
  let killTimer = null
  const finish = (code, signal) => {
    if (closed) return
    closed = true
    if (timeoutTimer !== null) nativeClearTimeout(timeoutTimer)
    if (killTimer !== null) nativeClearTimeout(killTimer)
    signalController.detach(child)
    resolveRun({
      gate: recorder.finish({ code, signal, timedOut, spawnFailed })
    })
  }
  try {
    child = spawn(process.execPath, [aggregateEntrypoint], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe']
    })
  } catch {
    spawnFailed = true
    finish(null, null)
    return
  }
  child.stdout.on('data', (chunk) => {
    recorder.accept(chunk)
    nativeWrite(1, chunk)
  })
  child.stderr.on('data', (chunk) => {
    recorder.acceptError(chunk)
    nativeWrite(2, chunk)
  })
  child.once('error', () => {
    spawnFailed = true
  })
  child.once('close', finish)
  signalController.attach(child)
  // 宽于 14 个子门禁各自上限的审计外层硬界；只启动一次聚合链，不做 retry。
  timeoutTimer = nativeSetTimeout(() => {
    timedOut = true
    try { child.kill('SIGTERM') } catch {}
    killTimer = nativeSetTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, 330_000)
  }, 21_600_000)
})

export const runStage09aAuditB = async (argv = process.argv.slice(2)) => {
  const signalController = createStage09aAuditBSignalController()
  signalController.install()
  let publishedIdentity = null
  let reportPath = null
  let reportPublished = false
  const removePublishedReport = () => {
    if (
      publishedIdentity !== null &&
      identityStillNamesFile(publishedIdentity)
    ) {
      try {
        unlinkSync(publishedIdentity.path)
        return true
      } catch {}
    }
    return false
  }
  const settle = async (exitCode) => {
    await signalController.checkpoint()
    const { requestedSignal, deliveryFailed } = signalController.snapshot()
    signalController.remove()
    if (requestedSignal === null) return deliveryFailed ? 1 : exitCode
    if (deliveryFailed) return 1
    try {
      nativeKill(process.pid, requestedSignal)
      await new Promise(() => {})
    } catch {
      fixedDiagnostic('final signal rethrow failed')
      return 1
    }
  }
  const parsed = parseStage09aAuditBArguments(argv)
  if (parsed === null) {
    fixedDiagnostic(
      'usage: pnpm stage09a:audit-b -- --expected-head <40-hex-sha>' +
      ' [--report m5-<label>-b.json]'
    )
    return settle(1)
  }
  let requiredNodeVersion
  try {
    requiredNodeVersion = readFileSync(resolve(repositoryRoot, '.node-version'), 'utf8').trim()
  } catch {
    fixedDiagnostic('required Node version could not be read')
    return settle(1)
  }
  if (ambientGitRepositoryViewOverrides(process.env).length > 0) {
    fixedDiagnostic('ambient Git repository view override is not permitted')
    return settle(1)
  }
  const repositoryBefore = readRepositoryState()
  if (
    repositoryBefore.candidateHead === null ||
    repositoryBefore.candidateHead !== parsed.expectedCandidateHead
  ) {
    fixedDiagnostic('candidate HEAD did not match the expected immutable commit')
    return settle(1)
  }
  const reportName = parsed.reportName ??
    `m5-${parsed.expectedCandidateHead.slice(0, 12)}-b.json`
  reportPath = resolve(reportDirectory, reportName)
  if (existsSync(reportPath)) {
    fixedDiagnostic('the single-run report already exists')
    return settle(1)
  }
  await signalController.checkpoint()
  let invocationCount = 0
  let gate = Object.freeze({
    status: 'fail', reason: 'gate-not-started', exitCode: null, signal: null,
    completedSteps: Object.freeze([]), failedStep: null
  })
  if (
    process.versions.node === requiredNodeVersion &&
    repositoryBefore.worktreeClean &&
    signalController.snapshot().requestedSignal === null
  ) {
    invocationCount += 1
    ;({ gate } = await runAggregateOnce(signalController))
  }
  await signalController.checkpoint()
  const repositoryAfter = readRepositoryState()
  const makeReport = () => createStage09aAuditBReport({
    expectedCandidateHead: parsed.expectedCandidateHead,
    candidateHeadBefore: repositoryBefore.candidateHead,
    candidateHeadAfter: repositoryAfter.candidateHead,
    requiredNodeVersion,
    actualNodeVersion: process.versions.node,
    worktreeCleanBefore: repositoryBefore.worktreeClean,
    worktreeCleanAfter: repositoryAfter.worktreeClean,
    invocationCount,
    retries: Math.max(0, invocationCount - 1),
    requestedSignal: signalController.snapshot().requestedSignal,
    gate
  })
  let report = makeReport()
  try {
    mkdirSync(reportDirectory, { recursive: true, mode: 0o700 })
    publishedIdentity = writeExclusiveEvidenceFile(
      reportPath,
      serializeStage09aAuditBReport(report)
    )
    reportPublished = true
  } catch {
    fixedDiagnostic('the structured report could not be published')
    return settle(1)
  }
  await signalController.checkpoint()
  if (report.status === 'pass' && signalController.snapshot().requestedSignal !== null) {
    if (!removePublishedReport()) {
      fixedDiagnostic('the interrupted report could not be retired')
      return settle(1)
    }
    reportPublished = false
    report = makeReport()
    try {
      publishedIdentity = writeExclusiveEvidenceFile(
        reportPath,
        serializeStage09aAuditBReport(report)
      )
      reportPublished = true
    } catch {
      fixedDiagnostic('the interrupted report could not be published')
      return settle(1)
    }
  }
  nativeWrite(1, `stage09a:audit-b report: .local/audit-reports/${reportName}\n`)
  return settle(reportPublished && report.status === 'pass' ? 0 : 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runStage09aAuditB()
}
