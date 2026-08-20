#!/usr/bin/env node
// M5 动态审计的唯一执行入口：固定 Node、单次完整链、零重试、结构化报告。
// 它不作 CLEAN/Accepted 裁定；审计 B 只读检查源码并消费本命令的一份报告。

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeExclusiveEvidenceFile } from '../infra/docker/m5-evidence-protocol.mjs'
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
  if (normalized.length === 0) return { reportName: null }
  if (
    normalized.length === 2 &&
    normalized[0] === '--report' &&
    reportNamePattern.test(normalized[1])
  ) {
    return { reportName: normalized[1] }
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

const runAggregateOnce = () => new Promise((resolveRun) => {
  const recorder = createStage09aTranscriptRecorder()
  let child = null
  let closed = false
  let timedOut = false
  let spawnFailed = false
  let requestedSignal = null
  let timeoutTimer = null
  let killTimer = null
  const handlers = new Map()
  const removeHandlers = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
  const finish = (code, signal) => {
    if (closed) return
    closed = true
    if (timeoutTimer !== null) nativeClearTimeout(timeoutTimer)
    if (killTimer !== null) nativeClearTimeout(killTimer)
    removeHandlers()
    resolveRun({
      gate: recorder.finish({ code, signal, timedOut, spawnFailed }),
      requestedSignal
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
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      if (requestedSignal !== null) return
      requestedSignal = signal
      try {
        child.kill(signal)
      } catch {
        // child close/error 决定固定结果；绝不回显底层异常。
      }
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
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
  const parsed = parseStage09aAuditBArguments(argv)
  if (parsed === null) {
    fixedDiagnostic('usage: pnpm stage09a:audit-b [-- --report m5-<label>-b.json]')
    return 1
  }
  let requiredNodeVersion
  try {
    requiredNodeVersion = readFileSync(resolve(repositoryRoot, '.node-version'), 'utf8').trim()
  } catch {
    fixedDiagnostic('required Node version could not be read')
    return 1
  }
  if (ambientGitRepositoryViewOverrides(process.env).length > 0) {
    fixedDiagnostic('ambient Git repository view override is not permitted')
    return 1
  }
  const repository = readRepositoryState()
  if (repository.candidateHead === null) {
    fixedDiagnostic('candidate HEAD could not be verified')
    return 1
  }
  const reportName = parsed.reportName ?? `m5-${repository.candidateHead.slice(0, 12)}-b.json`
  const reportPath = resolve(reportDirectory, reportName)
  if (existsSync(reportPath)) {
    fixedDiagnostic('the single-run report already exists')
    return 1
  }
  if (process.versions.node !== requiredNodeVersion || !repository.worktreeClean) {
    const gate = Object.freeze({
      status: 'fail', reason: 'gate-not-started', exitCode: null, signal: null,
      completedSteps: Object.freeze([]), failedStep: null
    })
    const report = createStage09aAuditBReport({
      candidateHead: repository.candidateHead,
      requiredNodeVersion,
      actualNodeVersion: process.versions.node,
      worktreeClean: repository.worktreeClean,
      gate
    })
    try {
      mkdirSync(reportDirectory, { recursive: true, mode: 0o700 })
      writeExclusiveEvidenceFile(reportPath, serializeStage09aAuditBReport(report))
    } catch {
      fixedDiagnostic('the structured report could not be published')
      return 1
    }
    fixedDiagnostic(report.reason === 'node-version-mismatch' ? 'Node version mismatch' : 'worktree is not clean')
    return 1
  }

  const { gate, requestedSignal } = await runAggregateOnce()
  const report = createStage09aAuditBReport({
    candidateHead: repository.candidateHead,
    requiredNodeVersion,
    actualNodeVersion: process.versions.node,
    worktreeClean: true,
    gate
  })
  try {
    mkdirSync(reportDirectory, { recursive: true, mode: 0o700 })
    writeExclusiveEvidenceFile(reportPath, serializeStage09aAuditBReport(report))
  } catch {
    fixedDiagnostic('the structured report could not be published')
    return 1
  }
  nativeWrite(1, `stage09a:audit-b report: .local/audit-reports/${reportName}\n`)
  if (requestedSignal !== null) {
    try {
      nativeKill(process.pid, requestedSignal)
      await new Promise(() => {})
    } catch {
      fixedDiagnostic('final signal rethrow failed')
      return 1
    }
  }
  return report.status === 'pass' ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runStage09aAuditB()
}
