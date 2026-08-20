#!/usr/bin/env node
// M5 动态审计的唯一执行入口。它与人类 CLI 直接复用同一个结构化聚合核心，
// 不 spawn 第二个 aggregate、不解析人类 stdout，也不复制进程组所有权。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeExclusiveEvidenceFile } from '../infra/docker/m5-evidence-protocol.mjs'
import {
  assertCanonicalGitRepositoryView,
  canonicalGitArguments
} from '../infra/docker/local-test-secrets-contract.mjs'
import {
  runStage09aCheck,
  stage09aInvocationSnapshot
} from './run-stage09a-check.mjs'
import {
  createStage09aAuditBReport,
  serializeStage09aAuditBReport
} from './stage09a-audit-b.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const reportDirectory = resolve(repositoryRoot, '.local/audit-reports')
const nativeKill = process.kill.bind(process)
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
  try {
    assertCanonicalGitRepositoryView(repositoryRoot, process.env)
  } catch {
    return { candidateHead: null, worktreeClean: false }
  }
  const head = spawnSync('git', canonicalGitArguments(['rev-parse', '--verify', 'HEAD']), {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024
  })
  const status = spawnSync('git', canonicalGitArguments(['status', '--short']), {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  })
  const candidateHead =
    head.status === 0 && /^[0-9a-f]{40}\n?$/.test(head.stdout)
      ? head.stdout.trim()
      : null
  const worktreeClean = status.status === 0 && status.stdout === ''
  return { candidateHead, worktreeClean }
}

const gateNotStarted = Object.freeze({
  status: 'fail',
  reason: 'gate-failed',
  exitCode: 1,
  signal: null,
  completedSteps: Object.freeze([]),
  failedStep: null
})

export const runStage09aAuditB = async (argv = process.argv.slice(2)) => {
  const parsed = parseStage09aAuditBArguments(argv)
  if (parsed === null) {
    fixedDiagnostic(
      'usage: pnpm stage09a:audit-b -- --expected-head <40-hex-sha>' +
      ' [--report m5-<label>-b.json]'
    )
    return Object.freeze({ exitCode: 1, requestedSignal: null })
  }

  let requiredNodeVersion = null
  try {
    requiredNodeVersion = readFileSync(resolve(repositoryRoot, '.node-version'), 'utf8').trim()
  } catch {
    fixedDiagnostic('required Node version could not be read')
  }
  const reportName = parsed.reportName ??
    `m5-${parsed.expectedCandidateHead.slice(0, 12)}-b.json`
  const reportPath = resolve(reportDirectory, reportName)
  if (existsSync(reportPath)) {
    fixedDiagnostic('the single-run report already exists')
    return Object.freeze({ exitCode: 1, requestedSignal: null })
  }

  const repositoryBefore = readRepositoryState()
  const invocationCountBefore = stage09aInvocationSnapshot()
  let gate = gateNotStarted
  let requestedSignal = null
  const canRun =
    requiredNodeVersion !== null &&
    process.versions.node === requiredNodeVersion &&
    repositoryBefore.candidateHead === parsed.expectedCandidateHead &&
    repositoryBefore.worktreeClean
  if (canRun) {
    try {
      const outcome = await runStage09aCheck([])
      gate = outcome.gate
      requestedSignal = outcome.requestedSignal
    } catch {
      gate = gateNotStarted
    }
  }
  const invocationCount = stage09aInvocationSnapshot() - invocationCountBefore
  const repositoryAfter = readRepositoryState()
  const retryCount = Math.max(0, invocationCount - 1)
  const report = createStage09aAuditBReport({
    expectedCandidateHead: parsed.expectedCandidateHead,
    candidateHeadBefore: repositoryBefore.candidateHead,
    candidateHeadAfter: repositoryAfter.candidateHead,
    requiredNodeVersion,
    actualNodeVersion: process.versions.node,
    worktreeCleanBefore: repositoryBefore.worktreeClean,
    worktreeCleanAfter: repositoryAfter.worktreeClean,
    invocationCount,
    retryCount,
    requestedSignal,
    gate
  })

  try {
    mkdirSync(reportDirectory, { recursive: true, mode: 0o700 })
    writeExclusiveEvidenceFile(reportPath, serializeStage09aAuditBReport(report))
  } catch {
    fixedDiagnostic('the structured report could not be published')
    return Object.freeze({ exitCode: 1, requestedSignal: null })
  }
  nativeWrite(1, `stage09a:audit-b report: .local/audit-reports/${reportName}\n`)
  return Object.freeze({
    exitCode: report.status === 'pass' ? 0 : 1,
    requestedSignal
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outcome = await runStage09aAuditB()
  if (outcome.requestedSignal === null) {
    process.exitCode = outcome.exitCode
  } else {
    try {
      nativeKill(process.pid, outcome.requestedSignal)
      await new Promise(() => {})
    } catch {
      fixedDiagnostic('final signal rethrow failed')
      process.exitCode = 1
    }
  }
}
