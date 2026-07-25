import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from 'node:fs'
import { relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

const assertExactKeys = (value, keys, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} keys are invalid: expected ${expected.join(',')}, got ${actual.join(',')}`
    )
  }
}

export const validateAuditPolicy = (input, now = Date.now()) => {
  assertExactKeys(
    input,
    [
      'schemaVersion',
      'decision',
      'acceptedAt',
      'expiresAt',
      'allowedTarget',
      'blockedTargets',
      'artifactRoot',
      'advisories',
      'forbiddenArtifactSignatures'
    ],
    'policy'
  )
  if (
    input.schemaVersion !== 1 ||
    input.decision !== 'temporary-local-weapp-only' ||
    input.allowedTarget !== 'local-weapp'
  ) {
    throw new Error('policy identity or decision is invalid')
  }
  const expiry =
    typeof input.expiresAt === 'string'
      ? Date.parse(input.expiresAt)
      : Number.NaN
  const expiryDate = input.expiresAt?.slice?.(0, 10)
  const expiryDateParts =
    typeof expiryDate === 'string'
      ? expiryDate.split('-').map(Number)
      : []
  const expiryCalendarDate =
    expiryDateParts.length === 3 &&
    expiryDateParts.every(Number.isInteger)
      ? new Date(
          Date.UTC(
            expiryDateParts[0],
            expiryDateParts[1] - 1,
            expiryDateParts[2]
          )
        )
          .toISOString()
          .slice(0, 10)
      : ''
  if (
    typeof input.expiresAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      input.expiresAt
    ) ||
    !Number.isFinite(expiry) ||
    expiryCalendarDate !== expiryDate
  ) {
    throw new Error('policy expiresAt must be a finite parseable timestamp')
  }
  if (now > expiry) {
    throw new Error(`exception expired at ${input.expiresAt}`)
  }
  if (
    typeof input.acceptedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.acceptedAt) ||
    !Number.isFinite(Date.parse(`${input.acceptedAt}T00:00:00Z`)) ||
    new Date(`${input.acceptedAt}T00:00:00Z`)
      .toISOString()
      .slice(0, 10) !== input.acceptedAt ||
    !Array.isArray(input.blockedTargets) ||
    input.blockedTargets.some((target) => typeof target !== 'string') ||
    JSON.stringify([...input.blockedTargets].sort()) !==
      JSON.stringify(
        ['h5', 'external-test', 'experience', 'release'].sort()
      ) ||
    input.artifactRoot !== 'apps/client/dist' ||
    !Array.isArray(input.advisories) ||
    !Array.isArray(input.forbiddenArtifactSignatures) ||
    input.forbiddenArtifactSignatures.some(
      (signature) => typeof signature !== 'string' || signature.length === 0
    ) ||
    new Set(input.forbiddenArtifactSignatures).size !==
      input.forbiddenArtifactSignatures.length
  ) {
    throw new Error('policy target, artifact, or array fields are invalid')
  }
  const seen = new Set()
  for (const advisory of input.advisories) {
    assertExactKeys(
      advisory,
      [
        'id',
        'module',
        'severity',
        'version',
        'pathCount',
        'pathSetSha256'
      ],
      'policy advisory'
    )
    if (
      typeof advisory.id !== 'string' ||
      !/^GHSA-[a-z0-9-]+$/i.test(advisory.id) ||
      typeof advisory.module !== 'string' ||
      advisory.module.length === 0 ||
      !['low', 'moderate', 'high', 'critical'].includes(advisory.severity) ||
      typeof advisory.version !== 'string' ||
      advisory.version.length === 0 ||
      !Number.isInteger(advisory.pathCount) ||
      advisory.pathCount < 1 ||
      !/^[0-9a-f]{64}$/.test(advisory.pathSetSha256) ||
      seen.has(advisory.id)
    ) {
      throw new Error(`policy advisory ${advisory.id ?? '(missing)'} is invalid`)
    }
    seen.add(advisory.id)
  }
  return input
}

const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex')

export const interpretAuditCommand = (command) => {
  if (command.error !== undefined) {
    throw new Error(`could not run pnpm audit: ${command.error.message}`)
  }
  if (
    command.signal !== null &&
    command.signal !== undefined
  ) {
    throw new Error(`pnpm audit terminated by signal ${command.signal}`)
  }
  if (command.status !== 0 && command.status !== 1) {
    throw new Error(
      `pnpm audit exit ${String(command.status)} is not a vulnerability result`
    )
  }
  let audit
  try {
    audit = JSON.parse(command.stdout)
  } catch {
    throw new Error(
      `pnpm audit returned no parseable JSON (exit=${command.status}): ` +
        `${command.stderr?.trim() || '(no stderr)'}`
    )
  }
  if (
    audit === null ||
    typeof audit !== 'object' ||
    Array.isArray(audit) ||
    audit.error !== undefined
  ) {
    throw new Error(
      `pnpm audit registry/network failure: ${JSON.stringify(audit?.error ?? audit)}`
    )
  }
  if (
    audit.advisories === null ||
    typeof audit.advisories !== 'object' ||
    Array.isArray(audit.advisories) ||
    audit.metadata?.vulnerabilities === null ||
    typeof audit.metadata?.vulnerabilities !== 'object' ||
    Array.isArray(audit.metadata.vulnerabilities)
  ) {
    throw new Error('pnpm audit returned no vulnerability metadata')
  }
  const vulnerabilityCounts = audit.metadata.vulnerabilities
  assertExactKeys(
    vulnerabilityCounts,
    ['info', 'low', 'moderate', 'high', 'critical'],
    'pnpm audit vulnerability metadata'
  )
  if (
    Object.values(vulnerabilityCounts).some(
      (count) => !Number.isInteger(count) || count < 0
    )
  ) {
    throw new Error('pnpm audit vulnerability counts are invalid')
  }
  const actual = Object.values(audit.advisories).map((advisory) => {
    if (
      advisory === null ||
      typeof advisory !== 'object' ||
      typeof advisory.github_advisory_id !== 'string' ||
      typeof advisory.module_name !== 'string' ||
      typeof advisory.severity !== 'string' ||
      !Array.isArray(advisory.findings) ||
      advisory.findings.length === 0 ||
      advisory.findings.some(
        (finding) =>
          finding === null ||
          typeof finding !== 'object' ||
          typeof finding.version !== 'string' ||
          !Array.isArray(finding.paths) ||
          finding.paths.some((path) => typeof path !== 'string')
      )
    ) {
      throw new Error('pnpm audit advisory metadata is malformed')
    }
    const paths = [
      ...new Set(advisory.findings.flatMap((finding) => finding.paths))
    ].sort()
    const versions = [
      ...new Set(advisory.findings.map((finding) => finding.version))
    ].sort()
    return {
      id: advisory.github_advisory_id,
      module: advisory.module_name,
      severity: advisory.severity,
      version: versions.join(','),
      pathCount: paths.length,
      pathSetSha256: sha256(JSON.stringify(paths))
    }
  })
  if (
    (command.status === 0 && actual.length !== 0) ||
    (command.status === 1 && actual.length === 0)
  ) {
    throw new Error(
      `pnpm audit exit ${command.status} contradicts advisory count ${actual.length}`
    )
  }
  const counted = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0
  }
  for (const advisory of actual) {
    if (!(advisory.severity in counted)) {
      throw new Error(
        `pnpm audit advisory severity ${advisory.severity} is invalid`
      )
    }
    counted[advisory.severity] += 1
  }
  if (
    Object.entries(counted).some(
      ([severity, count]) =>
        vulnerabilityCounts[severity] !== count
    )
  ) {
    throw new Error(
      'pnpm audit vulnerability metadata contradicts advisory findings'
    )
  }
  return { audit, actual }
}

export const assertAcceptedAdvisories = (policy, actual) => {
  const expectedById = new Map(
    policy.advisories.map((advisory) => [advisory.id, advisory])
  )
  const actualById = new Map(
    actual.map((advisory) => [advisory.id, advisory])
  )
  for (const advisory of actual) {
    const expected = expectedById.get(advisory.id)
    if (expected === undefined) {
      throw new Error(`new advisory ${advisory.id} (${advisory.module})`)
    }
    if (JSON.stringify(advisory) !== JSON.stringify(expected)) {
      throw new Error(
        `advisory ${advisory.id} changed\n` +
          `expected ${JSON.stringify(expected)}\n` +
          `actual   ${JSON.stringify(advisory)}`
      )
    }
  }
  for (const expected of policy.advisories) {
    if (!actualById.has(expected.id)) {
      throw new Error(
        `accepted advisory ${expected.id} disappeared; remove the stale exception`
      )
    }
  }
}

const collectFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })

const main = () => {
  const fail = (message) => {
    process.stderr.write(`audit gate failed: ${message}\n`)
    process.exitCode = 1
  }
  try {
    const policyPath = resolve(root, 'security/audit-exceptions.json')
    const policy = validateAuditPolicy(
      JSON.parse(readFileSync(policyPath, 'utf8'))
    )
    const targetArgument = process.argv.find((argument) =>
      argument.startsWith('--target=')
    )
    const target = targetArgument?.slice('--target='.length) ?? ''
    if (target !== policy.allowedTarget) {
      throw new Error(
        `target "${target || '(missing)'}" is blocked; exception only permits ${policy.allowedTarget}`
      )
    }
    const pnpmEntrypoint = process.env.npm_execpath
    const command =
      pnpmEntrypoint === undefined
        ? spawnSync('pnpm', ['audit', '--prod', '--json'], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024
          })
        : spawnSync(
            process.execPath,
            [pnpmEntrypoint, 'audit', '--prod', '--json'],
            {
              cwd: root,
              encoding: 'utf8',
              maxBuffer: 16 * 1024 * 1024
            }
          )
    const { audit, actual } = interpretAuditCommand(command)
    assertAcceptedAdvisories(policy, actual)

    const artifactRoot = resolve(root, policy.artifactRoot)
    if (!existsSync(artifactRoot)) {
      throw new Error(
        `weapp artifact is missing at ${policy.artifactRoot}; build it first`
      )
    }
    const files = collectFiles(artifactRoot).sort()
    if (files.length === 0) throw new Error('weapp artifact contains no files')
    const artifactDigest = createHash('sha256')
    for (const path of files) {
      const buffer = readFileSync(path)
      const fileName = relative(root, path)
      artifactDigest.update(fileName)
      artifactDigest.update('\0')
      artifactDigest.update(sha256(buffer))
      artifactDigest.update('\0')
      if (buffer.includes(0)) continue
      const text = buffer.toString('utf8')
      for (const signature of policy.forbiddenArtifactSignatures) {
        if (text.includes(signature)) {
          throw new Error(
            `vulnerable dependency signature "${signature}" found in ${fileName}`
          )
        }
      }
    }
    const result = {
      decision: policy.decision,
      auditExitCode: command.status,
      target,
      expiresAt: policy.expiresAt,
      advisories: actual.length,
      vulnerabilities: audit.metadata.vulnerabilities,
      artifactRoot: policy.artifactRoot,
      artifactFiles: files.length,
      artifactBytes: files.reduce(
        (sum, path) => sum + statSync(path).size,
        0
      ),
      artifactSha256: artifactDigest.digest('hex'),
      forbiddenSignaturesFound: 0
    }
    process.stdout.write(`audit exception gate PASS ${JSON.stringify(result)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
