import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from 'node:fs'
import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const auditEndpoint =
  'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'
const maximumAuditBodyBytes = 16 * 1024 * 1024

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
    throw new Error('could not run pnpm audit')
  }
  if (
    command.signal !== null &&
    command.signal !== undefined
  ) {
    throw new Error('pnpm audit terminated by a signal')
  }
  if (command.status !== 0 && command.status !== 1) {
    throw new Error('pnpm audit returned a non-vulnerability exit status')
  }
  let audit
  try {
    audit = JSON.parse(command.stdout)
  } catch {
    throw new Error('pnpm audit returned no parseable JSON')
  }
  if (
    audit === null ||
    typeof audit !== 'object' ||
    Array.isArray(audit) ||
    audit.error !== undefined
  ) {
    throw new Error('pnpm audit registry/network failure')
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
      throw new Error('pnpm audit advisory severity is invalid')
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
      throw new Error('pnpm audit returned an unaccepted advisory')
    }
    if (JSON.stringify(advisory) !== JSON.stringify(expected)) {
      throw new Error('pnpm audit advisory evidence changed')
    }
  }
  for (const expected of policy.advisories) {
    if (!actualById.has(expected.id)) {
      throw new Error('an accepted advisory disappeared; remove the stale exception')
    }
  }
}

/**
 * npm audit 的 HKG 边缘曾返回无 Content-Encoding 头的 gzip payload。
 * 这里只接受两种可验证表示：直接 JSON，或带 gzip magic/CRC 的 JSON。
 * 任何损坏压缩、超限、非 JSON 或非 object 仍 fail closed。
 */
export const readLimitedAuditStream = async (stream, label) => {
  const chunks = []
  let bytes = 0
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes += chunk.length
    if (bytes > maximumAuditBodyBytes) {
      throw new Error(`${label} exceeds the 16 MiB size limit`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export const normalizeAuditRegistryBody = async (input) => {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new Error('audit registry returned an empty body')
  }
  if (input.length > maximumAuditBodyBytes) {
    throw new Error(
      'raw audit registry response exceeds the 16 MiB size limit'
    )
  }
  const isGzip = input[0] === 0x1f && input[1] === 0x8b
  let body
  if (isGzip) {
    try {
      body = await readLimitedAuditStream(
        Readable.from([input]).pipe(createGunzip()),
        'decoded audit registry response'
      )
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('16 MiB size limit')
      ) {
        throw error
      }
      throw new Error('audit registry returned invalid gzip')
    }
  } else {
    body = input
  }
  let parsed
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('audit registry returned non-JSON data')
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new Error('audit registry JSON must be an object')
  }
  return body
}

const readRequestBody = async (request) => {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maximumAuditBodyBytes) {
      throw new Error('audit request exceeds the size limit')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export const assertAuditUpstreamStatus = (statusCode) => {
  if (statusCode !== 200) {
    throw new Error(
      `audit registry responded with HTTP ${String(statusCode)}; redirects are forbidden`
    )
  }
}

const requestAuditUpstream = async (requestBody) =>
  await new Promise((resolvePromise, reject) => {
    const upstreamRequest = httpsRequest(
      auditEndpoint,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
          'content-type': 'application/json',
          'content-length': String(requestBody.length)
        }
      },
      (upstreamResponse) => {
        void readLimitedAuditStream(
          upstreamResponse,
          'raw audit registry response'
        )
          .then((body) => {
            assertAuditUpstreamStatus(upstreamResponse.statusCode)
            resolvePromise(body)
          })
          .catch(reject)
      }
    )
    upstreamRequest.setTimeout(60_000, () => {
      upstreamRequest.destroy(
        new Error('audit registry request timed out')
      )
    })
    upstreamRequest.once('error', reject)
    upstreamRequest.end(requestBody)
  })

/**
 * pnpm 仍负责根据 lockfile 生成请求、计算实际依赖路径并产生标准 audit
 * JSON。loopback relay 只修复官方 HTTPS endpoint 的传输表示，不生成、
 * 缓存或伪造 advisory；所有异常都返回 502，让 pnpm/gate 失败。
 */
const startAuditRegistryRelay = async () => {
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== 'POST' ||
        request.url !== '/-/npm/v1/security/advisories/bulk'
      ) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'unsupported audit route' }))
        return
      }
      const requestBody = await readRequestBody(request)
      // node:https 不实现自动 redirect；任何 3xx 都由 status assertion
      // fail closed。原始响应流和 gzip 解压流分别受独立 16 MiB 上限。
      const upstreamBody = await requestAuditUpstream(requestBody)
      const normalized = await normalizeAuditRegistryBody(upstreamBody)
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(normalized.length),
        'cache-control': 'no-store'
      })
      response.end(normalized)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error)
      response.writeHead(502, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      })
      response.end(JSON.stringify({ error: message }))
    }
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('could not bind the audit registry relay')
  }
  return {
    registry: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) =>
          error === undefined ? resolvePromise() : reject(error)
        )
      })
  }
}

const runAuditCommand = async (registry) => {
  const pnpmEntrypoint = process.env.npm_execpath
  const executable =
    pnpmEntrypoint === undefined ? 'pnpm' : process.execPath
  const argumentsList =
    pnpmEntrypoint === undefined
      ? ['audit', '--prod', '--json', `--registry=${registry}`]
      : [
          pnpmEntrypoint,
          'audit',
          '--prod',
          '--json',
          `--registry=${registry}`
        ]
  return await new Promise((resolvePromise) => {
    const child = spawn(executable, argumentsList, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let exceededBuffer = false
    const collect = (chunks, chunk, currentBytes) => {
      const nextBytes = currentBytes + chunk.length
      if (nextBytes > maximumAuditBodyBytes) {
        exceededBuffer = true
        child.kill('SIGTERM')
        return nextBytes
      }
      chunks.push(chunk)
      return nextBytes
    }
    child.stdout.on('data', (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes)
    })
    child.once('error', (error) => {
      resolvePromise({
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        error
      })
    })
    child.once('close', (status, signal) => {
      resolvePromise({
        status: exceededBuffer ? 2 : status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      })
    })
  })
}

const collectFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })

const main = async () => {
  const fail = (message) => {
    process.stderr.write(`audit gate failed: ${message}\n`)
    process.exitCode = 1
  }
  let relay
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
    relay = await startAuditRegistryRelay()
    const command = await runAuditCommand(relay.registry)
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
  } finally {
    await relay?.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
