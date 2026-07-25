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
const policyPath = resolve(root, 'security/audit-exceptions.json')
const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
const targetArgument = process.argv.find((argument) =>
  argument.startsWith('--target=')
)
const target = targetArgument?.slice('--target='.length) ?? ''

const fail = (message) => {
  process.stderr.write(`audit gate failed: ${message}\n`)
  process.exit(1)
}

if (target !== policy.allowedTarget) {
  fail(
    `target "${target || '(missing)'}" is blocked; the exception is only valid for ${policy.allowedTarget}`
  )
}
if (Date.now() > Date.parse(policy.expiresAt)) {
  fail(`exception expired at ${policy.expiresAt}`)
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
if (command.error !== undefined) {
  fail(`could not run pnpm audit: ${command.error.message}`)
}

let audit
try {
  audit = JSON.parse(command.stdout)
} catch {
  fail(`pnpm audit did not return JSON: ${command.stderr.trim()}`)
}

const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex')
const actual = Object.values(audit.advisories ?? {}).map((advisory) => {
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
const expectedById = new Map(
  policy.advisories.map((advisory) => [advisory.id, advisory])
)
const actualById = new Map(
  actual.map((advisory) => [advisory.id, advisory])
)

for (const advisory of actual) {
  const expected = expectedById.get(advisory.id)
  if (expected === undefined) {
    fail(`new advisory ${advisory.id} (${advisory.module})`)
  }
  if (JSON.stringify(advisory) !== JSON.stringify(expected)) {
    fail(
      `advisory ${advisory.id} changed\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(advisory)}`
    )
  }
}
for (const expected of policy.advisories) {
  if (!actualById.has(expected.id)) {
    fail(
      `accepted advisory ${expected.id} is no longer present; review and remove the stale exception`
    )
  }
}

const artifactRoot = resolve(root, policy.artifactRoot)
if (!existsSync(artifactRoot)) {
  fail(`weapp artifact is missing at ${policy.artifactRoot}; build it first`)
}
const collectFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })
const files = collectFiles(artifactRoot).sort()
if (files.length === 0) {
  fail('weapp artifact contains no files')
}

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
      fail(`vulnerable dependency signature "${signature}" found in ${fileName}`)
    }
  }
}

const result = {
  decision: policy.decision,
  target,
  expiresAt: policy.expiresAt,
  advisories: actual.length,
  vulnerabilities: audit.metadata?.vulnerabilities,
  artifactRoot: policy.artifactRoot,
  artifactFiles: files.length,
  artifactBytes: files.reduce((sum, path) => sum + statSync(path).size, 0),
  artifactSha256: artifactDigest.digest('hex'),
  forbiddenSignaturesFound: 0
}
process.stdout.write(`audit exception gate PASS ${JSON.stringify(result)}\n`)
