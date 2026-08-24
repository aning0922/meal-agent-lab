#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BASELINE_SHA = '2c2ccd9015268fe44db4bb5446f3340e551914be'
export const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

const domainRequire = createRequire(resolve(repositoryRoot, 'packages/domain/package.json'))
const Ajv2020 = domainRequire('ajv/dist/2020').default
const ts = domainRequire('typescript')

export const manifests = Object.freeze({
  valid: Object.freeze([
    'allergen.json',
    'cooking-technique.json',
    'food-concept.json',
    'food-safety.json',
    'religious-ethical.json'
  ]),
  invalid: Object.freeze([
    'alias-conflict.json',
    'hard-mapping-unresolved.json',
    'missing-language.json',
    'missing-license.json',
    'missing-region.json',
    'missing-source.json',
    'release-digest-mismatch.json',
    'reused-id.json',
    'unknown-revision.json',
    'withdrawn-reference.json'
  ]),
  schemas: Object.freeze([
    'governance-release.schema.json',
    'invalid-governance-fixture.schema.json'
  ]),
  sources: Object.freeze([
    'canonical.ts',
    'catalog.ts',
    'decode.ts',
    'index.ts',
    'resolution.ts',
    'types.ts',
    'validation.ts'
  ]),
  tests: Object.freeze(['adversarial.test.ts', 'boundary.test.ts', 'governance.test.ts']),
  mutationTests: Object.freeze(['stage09p-m0-scope.test.mjs'])
})

const fixtureRoot = (root) => resolve(root, 'data/samples/stage09p-m0')
const parseJson = (path, failures, label) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    failures.push(`${label} must parse as JSON`)
    return null
  }
}
const exactKeys = (value, expected) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
const exactFiles = (directory, expected) =>
  JSON.stringify(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map(({ name }) => name)
      .sort()
  ) === JSON.stringify([...expected].sort())

export const collectManifestFailures = (root = repositoryRoot) => {
  const failures = []
  const checks = [
    [resolve(fixtureRoot(root), 'valid'), manifests.valid, 'valid fixture'],
    [resolve(fixtureRoot(root), 'invalid'), manifests.invalid, 'invalid fixture'],
    [resolve(root, 'data/schemas'), manifests.schemas, 'schema'],
    [resolve(root, 'packages/domain/src'), manifests.sources, 'domain source'],
    [resolve(root, 'packages/domain/tests'), manifests.tests, 'domain test']
  ]
  for (const [directory, expected, label] of checks) {
    try {
      if (!exactFiles(directory, expected)) failures.push(`${label} manifest must be exact`)
    } catch {
      failures.push(`${label} manifest must be exact`)
    }
  }
  try {
    const actual = readdirSync(resolve(root, 'scripts/tests'))
      .filter((name) => name.startsWith('stage09p-m0-') && name.endsWith('.test.mjs'))
      .sort()
    if (JSON.stringify(actual) !== JSON.stringify(manifests.mutationTests)) {
      failures.push('M0 mutation-test manifest must be exact')
    }
  } catch {
    failures.push('M0 mutation-test manifest must be exact')
  }
  return failures
}

const validConfiguration = Object.freeze({
  'allergen.json': ['allergen', 'allergen', '000000000002', 'ALLERGEN', 'data-steward', 'safety-approver', '2'],
  'cooking-technique.json': ['cooking-technique', 'cooking_technique', '000000000005', 'COOKING_TECHNIQUE', 'content-steward', 'content-approver', '5'],
  'food-concept.json': ['food-concept', 'food_concept', '000000000001', 'FOOD_CONCEPT', 'data-steward', 'product-approver', '1'],
  'food-safety.json': ['food-safety', 'food_safety', '000000000004', 'FOOD_SAFETY', 'safety-steward', 'safety-approver', '4'],
  'religious-ethical.json': ['religious-ethical', 'religious_ethical', '000000000003', 'RELIGIOUS_ETHICAL', 'policy-steward', 'policy-approver', '3']
})
const envelopeKeys = [
  'schemaVersion', 'datasetId', 'datasetKind', 'releaseId', 'releaseRevision', 'contentDigest',
  'entityId', 'entityRevision', 'lifecycleStatus', 'owner', 'approvers', 'sourceTier',
  'sourceReferences', 'sourceSnapshots', 'applicableRegions', 'languages', 'licenseStatus',
  'licenseReference', 'retrievedAt', 'reviewedAt', 'reviewDueAt', 'aliases', 'supersededBy',
  'withdrawalState', 'withdrawalReason', 'withdrawnAt', 'content', 'syntheticEvidence'
]
const reservedEntityId = /^01900000-7000-7000-8000-0000000000[0-9]{2}$/
const digest = /^sha256:[0-9a-f]{64}$/

export const collectSyntheticFailures = (root = repositoryRoot) => {
  const failures = []
  const validDirectory = resolve(fixtureRoot(root), 'valid')
  for (const file of manifests.valid) {
    const release = parseJson(resolve(validDirectory, file), failures, 'valid fixture')
    const config = validConfiguration[file]
    if (
      release === null ||
      !exactKeys(release, ['$schema', 'envelopes']) ||
      release.$schema !== '../../../schemas/governance-release.schema.json' ||
      !Array.isArray(release.envelopes) ||
      release.envelopes.length !== 1 ||
      config === undefined
    ) {
      failures.push('valid fixture release shape and schema reference must be exact')
      continue
    }
    const [slug, kind, uuidTail, tokenStem, ownerRole, approverRole, snapshotDigit] = config
    const envelope = release.envelopes[0]
    const sourceId = `syn:source:${slug}`
    const token = `SYNTHETIC_${tokenStem}_ALPHA`
    const source = envelope?.sourceReferences?.[0]
    const snapshot = envelope?.sourceSnapshots?.[0]
    const alias = envelope?.aliases?.[0]
    const evidence = envelope?.syntheticEvidence
    if (
      !exactKeys(envelope, envelopeKeys) ||
      envelope.schemaVersion !== 1 ||
      envelope.datasetId !== `syn:dataset:${slug}` ||
      envelope.datasetKind !== kind ||
      envelope.releaseId !== `syn:release:${slug}:1` ||
      envelope.releaseRevision !== 1 ||
      !digest.test(envelope.contentDigest) ||
      envelope.entityId !== `01900000-7000-7000-8000-${uuidTail}` ||
      envelope.entityRevision !== 1 ||
      envelope.lifecycleStatus !== 'active' ||
      !exactKeys(envelope.owner, ['actorId', 'role']) ||
      envelope.owner.actorId !== `syn:actor:${slug}-owner` ||
      envelope.owner.role !== ownerRole ||
      !Array.isArray(envelope.approvers) ||
      envelope.approvers.length !== 1 ||
      !exactKeys(envelope.approvers[0], ['actorId', 'role']) ||
      envelope.approvers[0].actorId !== `syn:actor:${slug}-approver` ||
      envelope.approvers[0].role !== approverRole ||
      envelope.sourceTier !== 'L3' ||
      !Array.isArray(envelope.sourceReferences) ||
      envelope.sourceReferences.length !== 1 ||
      !exactKeys(source, ['referenceId', 'referenceRevision', 'locator']) ||
      source.referenceId !== sourceId ||
      source.referenceRevision !== 'syn-revision-1' ||
      source.locator !== `synthetic://stage09p-m0/${slug}` ||
      !Array.isArray(envelope.sourceSnapshots) ||
      envelope.sourceSnapshots.length !== 1 ||
      !exactKeys(snapshot, ['snapshotId', 'referenceId', 'referenceRevision', 'contentDigest', 'retrievedAt']) ||
      snapshot.snapshotId !== `syn:snapshot:${slug}:1` ||
      snapshot.referenceId !== sourceId ||
      snapshot.referenceRevision !== 'syn-revision-1' ||
      snapshot.contentDigest !== `sha256:${snapshotDigit.repeat(64)}` ||
      snapshot.retrievedAt !== '2000-01-01T00:00:00.000Z' ||
      JSON.stringify(envelope.applicableRegions) !== '["SYNTHETIC-REGION-1"]' ||
      JSON.stringify(envelope.languages) !== '["x-synthetic"]' ||
      envelope.licenseStatus !== 'approved' ||
      envelope.licenseReference !== 'synthetic-license://stage09p-m0/internal-original' ||
      envelope.retrievedAt !== '2000-01-01T00:00:00.000Z' ||
      envelope.reviewedAt !== '2000-01-02T00:00:00.000Z' ||
      envelope.reviewDueAt !== '2099-01-01T00:00:00.000Z' ||
      !Array.isArray(envelope.aliases) ||
      envelope.aliases.length !== 1 ||
      !exactKeys(alias, ['value', 'region', 'language', 'sourceReferenceId', 'sourceReferenceRevision']) ||
      alias.value !== token ||
      alias.region !== 'SYNTHETIC-REGION-1' ||
      alias.language !== 'x-synthetic' ||
      alias.sourceReferenceId !== sourceId ||
      alias.sourceReferenceRevision !== 'syn-revision-1' ||
      envelope.supersededBy !== null ||
      envelope.withdrawalState !== 'not_withdrawn' ||
      envelope.withdrawalReason !== null ||
      envelope.withdrawnAt !== null ||
      !exactKeys(envelope.content, ['syntheticToken']) ||
      envelope.content.syntheticToken !== token ||
      !exactKeys(evidence, ['classification', 'generator', 'containsRealUserData', 'containsRealFoodFacts', 'purpose']) ||
      evidence.classification !== 'fully_synthetic' ||
      evidence.generator !== 'stage09p-m0-fixture-v1' ||
      evidence.containsRealUserData !== false ||
      evidence.containsRealFoodFacts !== false ||
      evidence.purpose !== 'governance-format-and-fail-closed-testing-only'
    ) {
      failures.push('every valid leaf and key must match the complete M0 synthetic registry')
    }
  }
  return failures
}

const expectedIssueByFile = Object.freeze({
  'alias-conflict.json': 'ALIAS_CONFLICT',
  'hard-mapping-unresolved.json': 'HARD_MAPPING_UNRESOLVED',
  'missing-language.json': 'MISSING_LANGUAGE',
  'missing-license.json': 'MISSING_LICENSE',
  'missing-region.json': 'MISSING_REGION',
  'missing-source.json': 'MISSING_SOURCE',
  'release-digest-mismatch.json': 'RELEASE_DIGEST_MISMATCH',
  'reused-id.json': 'REUSED_ENTITY_ID',
  'unknown-revision.json': 'UNKNOWN_REVISION',
  'withdrawn-reference.json': 'WITHDRAWN_REFERENCE'
})
const emptyArrayFields = new Set([
  'sourceReferences',
  'sourceSnapshots',
  'aliases',
  'applicableRegions',
  'languages'
])
const validSetMutation = (mutation) => {
  if (
    !exactKeys(mutation, ['operation', 'releaseIndex', 'envelopeIndex', 'field', 'value']) ||
    mutation.operation !== 'set' ||
    !Number.isSafeInteger(mutation.releaseIndex) || mutation.releaseIndex < 0 ||
    !Number.isSafeInteger(mutation.envelopeIndex) || mutation.envelopeIndex < 0
  ) return false
  if (emptyArrayFields.has(mutation.field)) return Array.isArray(mutation.value) && mutation.value.length === 0
  if (mutation.field === 'licenseStatus') return mutation.value === 'pending'
  if (mutation.field === 'licenseReference') return mutation.value === null
  if (mutation.field === 'entityId') return reservedEntityId.test(String(mutation.value))
  if (mutation.field === 'lifecycleStatus') return mutation.value === 'withdrawn'
  if (mutation.field === 'withdrawalState') return mutation.value === 'withdrawn'
  if (mutation.field === 'withdrawalReason') return mutation.value === 'SYNTHETIC_WITHDRAWAL_REASON'
  if (mutation.field === 'withdrawnAt') return mutation.value === '2000-01-03T00:00:00.000Z'
  if (mutation.field === 'contentDigest') return mutation.value === `sha256:${'0'.repeat(64)}`
  return false
}
const validDuplicateMutation = (mutation) =>
  exactKeys(mutation, [
    'operation', 'releaseIndex', 'envelopeIndex', 'entityId', 'syntheticToken', 'aliasValue'
  ]) &&
  mutation.operation === 'duplicate_envelope' &&
  Number.isSafeInteger(mutation.releaseIndex) && mutation.releaseIndex >= 0 &&
  Number.isSafeInteger(mutation.envelopeIndex) && mutation.envelopeIndex >= 0 &&
  reservedEntityId.test(String(mutation.entityId)) &&
  /^SYNTHETIC_[A-Z0-9_]+$/.test(String(mutation.syntheticToken)) &&
  String(mutation.aliasValue).trim().toUpperCase() === 'SYNTHETIC_FOOD_CONCEPT_ALPHA'

export const collectInvalidSyntheticFailures = (root = repositoryRoot) => {
  const failures = []
  const invalidDirectory = resolve(fixtureRoot(root), 'invalid')
  for (const file of manifests.invalid) {
    const fixture = parseJson(resolve(invalidDirectory, file), failures, 'invalid fixture')
    if (
      fixture === null ||
      !exactKeys(fixture, [
        '$schema', 'syntheticFixture', 'baseValidFiles', 'mutations', 'hardMappings',
        'recomputeReleaseDigests', 'expectedIssueCodes'
      ]) ||
      fixture.$schema !== '../../../schemas/invalid-governance-fixture.schema.json' ||
      fixture.syntheticFixture !== 'fully_synthetic_mutation' ||
      !Array.isArray(fixture.baseValidFiles) || fixture.baseValidFiles.length === 0 ||
      new Set(fixture.baseValidFiles).size !== fixture.baseValidFiles.length ||
      fixture.baseValidFiles.some((name) => !manifests.valid.includes(name)) ||
      !Array.isArray(fixture.mutations) ||
      !Array.isArray(fixture.hardMappings) ||
      typeof fixture.recomputeReleaseDigests !== 'boolean' ||
      JSON.stringify(fixture.expectedIssueCodes) !== JSON.stringify([expectedIssueByFile[file]])
    ) {
      failures.push('invalid fixture roots must be exact registered synthetic mutations')
      continue
    }
    for (const mutation of fixture.mutations) {
      if (!(mutation?.operation === 'set' ? validSetMutation(mutation) : validDuplicateMutation(mutation))) {
        failures.push('invalid fixture mutation leaves the complete synthetic leaf allowlist')
      }
    }
    for (const mapping of fixture.hardMappings) {
      const referenceValid = (reference) =>
        exactKeys(reference, ['datasetId', 'entityId', 'entityRevision']) &&
        String(reference.datasetId).startsWith('syn:dataset:') &&
        reservedEntityId.test(String(reference.entityId)) &&
        Number.isSafeInteger(reference.entityRevision) && reference.entityRevision > 0
      if (
        !exactKeys(mapping, ['mappingId', 'source', 'target', 'required']) ||
        !String(mapping.mappingId).startsWith('syn:mapping:') ||
        !referenceValid(mapping.source) || !referenceValid(mapping.target) || mapping.required !== true
      ) {
        failures.push('invalid fixture hard mapping leaves the complete synthetic leaf allowlist')
      }
    }
  }
  return failures
}

const allowedChangedPath = (path) =>
  path.startsWith('packages/domain/') ||
  path.startsWith('data/schemas/') ||
  path.startsWith('data/samples/stage09p-m0/') ||
  path === 'data/README.md' ||
  path === 'packages/README.md' ||
  path === 'README.md' ||
  path === 'docs/README.md' ||
  path === 'docs/project-status.md' ||
  path === 'package.json' ||
  path === 'pnpm-workspace.yaml' ||
  path === 'pnpm-lock.yaml' ||
  path === 'scripts/check-stage09p-m0-scope.mjs' ||
  /^scripts\/tests\/stage09p-m0-[a-z0-9-]+\.test\.mjs$/.test(path) ||
  path === 'infra/docker/m3b-evidence-baseline.json'

export const collectChangedPathFailures = (changedPaths) => {
  const failures = []
  if (changedPaths.length === 0) failures.push('baseline changed-path set must not be empty')
  for (const path of changedPaths) {
    if (!allowedChangedPath(path)) failures.push('baseline changed-path allowlist rejects scope expansion')
  }
  return failures
}

const gitText = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const protectedStage09a = (text) => {
  const start = text.indexOf('## 阶段 09A 计划与下一门禁')
  const end = text.indexOf('## 阶段 09P 规划 Accepted')
  return start >= 0 && end > start ? text.slice(start, end) : null
}

export const collectRepositoryScopeFailures = (root = repositoryRoot, baseline = BASELINE_SHA) => {
  const failures = []
  try {
    const changedPaths = gitText(root, ['diff', '--name-only', baseline, '--'])
      .trim().split('\n').filter(Boolean)
    const untracked = gitText(root, ['ls-files', '--others', '--exclude-standard'])
      .trim().split('\n').filter(Boolean)
    failures.push(...collectChangedPathFailures([...new Set([...changedPaths, ...untracked])]))

    const baselineStatus = gitText(root, ['show', `${baseline}:docs/project-status.md`])
    const currentStatus = readFileSync(resolve(root, 'docs/project-status.md'), 'utf8')
    if (
      protectedStage09a(baselineStatus) === null ||
      protectedStage09a(currentStatus) !== protectedStage09a(baselineStatus)
    ) failures.push('stage 09A historical status region must remain byte-identical')

    const baselineEvidence = JSON.parse(
      gitText(root, ['show', `${baseline}:infra/docker/m3b-evidence-baseline.json`])
    )
    const currentEvidence = JSON.parse(
      readFileSync(resolve(root, 'infra/docker/m3b-evidence-baseline.json'), 'utf8')
    )
    const currentCount = Number.parseInt(gitText(root, ['ls-files']).trim().split('\n').length, 10)
    if (currentEvidence.trackedFileCount !== currentCount) {
      failures.push('M3B trackedFileCount must equal the exact tracked file count')
    }
    currentEvidence.trackedFileCount = baselineEvidence.trackedFileCount
    if (JSON.stringify(currentEvidence) !== JSON.stringify(baselineEvidence)) {
      failures.push('M3B evidence may change trackedFileCount only')
    }
  } catch {
    failures.push('baseline scope evidence must be mechanically readable')
  }
  return failures
}

const permittedRuntimeImports = new Set([
  '@noble/hashes/sha2.js',
  '@noble/hashes/utils.js'
])
const bannedCapabilities = new Set([
  'fetch', 'process', 'require', 'eval', 'Function', 'WebSocket', 'Worker',
  'XMLHttpRequest', 'Deno', 'Bun', 'readFile', 'readFileSync', 'writeFile',
  'writeFileSync', 'appendFile', 'open', 'createReadStream', 'createWriteStream',
  'connect', 'createConnection', 'indexedDB', 'localStorage', 'sessionStorage',
  'document', 'window', 'navigator', 'setTimeout', 'setInterval'
])

export const collectCapabilityFailures = (root = repositoryRoot) => {
  const failures = []
  const sourceRoot = resolve(root, 'packages/domain/src')
  const testRoot = resolve(root, 'packages/domain/tests')
  const packageJson = parseJson(resolve(root, 'packages/domain/package.json'), failures, 'domain package')
  if (JSON.stringify(Object.keys(packageJson?.dependencies ?? {})) !== '["@noble/hashes"]') {
    failures.push('domain runtime dependencies must equal the audited pure allowlist')
  }
  const sourceSet = new Set(manifests.sources)
  for (const file of manifests.sources) {
    let source
    try {
      source = readFileSync(resolve(sourceRoot, file), 'utf8')
    } catch {
      failures.push('domain source must be readable for AST capability analysis')
      continue
    }
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    if (tree.parseDiagnostics.length > 0) failures.push('domain source must parse as TypeScript')
    const visit = (node) => {
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined
      ) {
        const specifier = node.moduleSpecifier
        if (!ts.isStringLiteral(specifier)) {
          failures.push('domain module specifiers must be static strings')
        } else if (specifier.text.startsWith('.')) {
          const target = specifier.text.replace(/^\.\//, '').replace(/\.js$/, '.ts')
          if (specifier.text.includes('..') || !sourceSet.has(target)) {
            failures.push('domain relative module graph must remain inside the exact source manifest')
          }
        } else if (!permittedRuntimeImports.has(specifier.text)) {
          failures.push('domain production source imports a forbidden runtime capability')
        }
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ) failures.push('domain production source cannot dynamically load modules')
      if (ts.isIdentifier(node) && bannedCapabilities.has(node.text)) {
        failures.push('domain production source references a forbidden side-effect capability')
      }
      if (
        (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name !== undefined && /(?:Dto|DTO|DatabaseRow|Repository|Adapter)$/.test(node.name.text)
      ) failures.push('domain source cannot define transport, row, or side-effect interface types')
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  for (const file of manifests.tests) {
    try {
      const source = readFileSync(resolve(testRoot, file), 'utf8')
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      let testCalls = 0
      const visit = (node) => {
        if (ts.isCallExpression(node)) {
          if (ts.isIdentifier(node.expression) && node.expression.text === 'test') testCalls += 1
          if (
            ts.isPropertyAccessExpression(node.expression) &&
            (node.expression.name.text === 'skip' || node.expression.name.text === 'todo')
          ) failures.push('M0 tests cannot contain skip or todo calls')
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
      if (testCalls === 0) failures.push('every M0 test file must register at least one test')
    } catch {
      failures.push('M0 tests must be readable for AST analysis')
    }
  }
  for (const file of manifests.mutationTests) {
    try {
      const source = readFileSync(resolve(root, 'scripts/tests', file), 'utf8')
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      let testCalls = 0
      const visit = (node) => {
        if (ts.isCallExpression(node)) {
          if (ts.isIdentifier(node.expression) && node.expression.text === 'test') testCalls += 1
          if (
            ts.isPropertyAccessExpression(node.expression) &&
            (node.expression.name.text === 'skip' || node.expression.name.text === 'todo')
          ) failures.push('M0 tests cannot contain skip or todo calls')
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
      if (testCalls === 0) failures.push('every M0 test file must register at least one test')
    } catch {
      failures.push('M0 tests must be readable for AST analysis')
    }
  }
  return [...new Set(failures)]
}

const canonicalInstant = (value) => {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return false
  try {
    return new Date(milliseconds).toISOString() === value
  } catch {
    return false
  }
}

const materializeFixture = (fixture, validDirectory, domain) => {
  const releases = fixture.baseValidFiles.map((file) =>
    structuredClone(JSON.parse(readFileSync(resolve(validDirectory, file), 'utf8')))
  )
  for (const mutation of fixture.mutations) {
    const envelope = releases[mutation.releaseIndex]?.envelopes?.[mutation.envelopeIndex]
    if (envelope === undefined) throw new TypeError('INVALID_FIXTURE')
    if (mutation.operation === 'set') {
      envelope[mutation.field] = mutation.value
    } else {
      const duplicate = structuredClone(envelope)
      duplicate.entityId = mutation.entityId
      duplicate.content = { syntheticToken: mutation.syntheticToken }
      duplicate.aliases = duplicate.aliases.map((alias) => ({ ...alias, value: mutation.aliasValue }))
      releases[mutation.releaseIndex].envelopes.push(duplicate)
    }
  }
  if (fixture.recomputeReleaseDigests) {
    for (const release of releases) {
      const releaseDigest = domain.canonicalReleaseDigest(release)
      for (const envelope of release.envelopes) envelope.contentDigest = releaseDigest
    }
  }
  return { releases, hardMappings: fixture.hardMappings }
}

const compiledSchemas = (root) => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true })
  ajv.addFormat('canonical-utc-instant', { type: 'string', validate: canonicalInstant })
  return {
    governance: ajv.compile(JSON.parse(
      readFileSync(resolve(root, 'data/schemas/governance-release.schema.json'), 'utf8')
    )),
    fixture: ajv.compile(JSON.parse(
      readFileSync(resolve(root, 'data/schemas/invalid-governance-fixture.schema.json'), 'utf8')
    ))
  }
}

export const collectSchemaContractFailures = (root = repositoryRoot) => {
  const failures = []
  try {
    const validators = compiledSchemas(root)
    const validDirectory = resolve(fixtureRoot(root), 'valid')
    const invalidDirectory = resolve(fixtureRoot(root), 'invalid')
    for (const file of manifests.valid) {
      const release = JSON.parse(readFileSync(resolve(validDirectory, file), 'utf8'))
      if (!validators.governance(release)) failures.push('every valid fixture must pass compiled governance schema')
    }
    for (const file of manifests.invalid) {
      const fixture = JSON.parse(readFileSync(resolve(invalidDirectory, file), 'utf8'))
      if (!validators.fixture(fixture)) failures.push('every invalid descriptor must pass compiled fixture schema')
    }
    const missingAliasRevision = JSON.parse(
      readFileSync(resolve(validDirectory, 'food-concept.json'), 'utf8')
    )
    delete missingAliasRevision.envelopes[0].aliases[0].sourceReferenceRevision
    if (validators.governance(missingAliasRevision)) {
      failures.push('compiled governance schema must require alias source revision')
    }
    const invalidInstant = JSON.parse(
      readFileSync(resolve(validDirectory, 'food-concept.json'), 'utf8')
    )
    invalidInstant.envelopes[0].reviewedAt = '2000-97-01T00:00:00.000Z'
    if (validators.governance(invalidInstant)) {
      failures.push('compiled governance schema must reject non-existent UTC instants')
    }
    const unknownEnvelopeKey = JSON.parse(
      readFileSync(resolve(validDirectory, 'food-concept.json'), 'utf8')
    )
    unknownEnvelopeKey.envelopes[0].uncheckedExternalFact = 'SYNTHETIC_UNCHECKED'
    if (validators.governance(unknownEnvelopeKey)) {
      failures.push('compiled governance schema must reject unknown envelope keys')
    }
  } catch {
    failures.push('both M0 schemas must compile and execute with the independent 2020-12 validator')
  }
  return [...new Set(failures)]
}

export const collectSchemaParityFailures = async (root = repositoryRoot) => {
  const failures = collectSchemaContractFailures(root)
  if (failures.length > 0) return failures
  try {
    const validators = compiledSchemas(root)
    const domain = await import(new URL('../packages/domain/dist/index.js', import.meta.url))
    const validDirectory = resolve(fixtureRoot(root), 'valid')
    const invalidDirectory = resolve(fixtureRoot(root), 'invalid')
    for (const file of manifests.valid) {
      const release = JSON.parse(readFileSync(resolve(validDirectory, file), 'utf8'))
      if (!validators.governance(release) || !domain.validateGovernanceRelease(release).ok) {
        failures.push('valid fixture must pass both compiled schema and runtime validation')
      }
    }
    const schemaExpressible = new Set([
      'MISSING_SOURCE', 'MISSING_LICENSE', 'MISSING_REGION', 'MISSING_LANGUAGE'
    ])
    for (const file of manifests.invalid) {
      const fixture = JSON.parse(readFileSync(resolve(invalidDirectory, file), 'utf8'))
      if (!validators.fixture(fixture)) {
        failures.push('invalid fixture descriptor must pass the compiled mutation schema')
        continue
      }
      const catalog = materializeFixture(fixture, validDirectory, domain)
      const result = domain.validateGovernanceCatalog(catalog)
      const codes = [...new Set(result.issues.map(({ code }) => code))]
      if (result.ok || JSON.stringify(codes) !== JSON.stringify(fixture.expectedIssueCodes)) {
        failures.push('materialized invalid fixture must have its one exact runtime reason')
      }
      const releaseSchemaResults = catalog.releases.map((release) => validators.governance(release))
      const shouldHaveSchemaFailure = schemaExpressible.has(fixture.expectedIssueCodes[0])
      if (shouldHaveSchemaFailure === releaseSchemaResults.every(Boolean)) {
        failures.push('materialized fixture schema/runtime parity matrix must match expressibility')
      }
    }
  } catch {
    failures.push('both M0 schemas must compile and execute with the independent 2020-12 validator')
  }
  return [...new Set(failures)]
}

export const runStage09pM0ScopeCheck = async (root = repositoryRoot) => {
  const groups = [
    collectManifestFailures(root),
    collectSyntheticFailures(root),
    collectInvalidSyntheticFailures(root),
    collectCapabilityFailures(root),
    collectRepositoryScopeFailures(root),
    await collectSchemaParityFailures(root)
  ]
  const failures = groups.flat()
  return { ok: failures.length === 0, failures: [...new Set(failures)] }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runStage09pM0ScopeCheck()
  if (!result.ok) {
    process.stderr.write(`Stage 09P M0 scope check FAIL (${result.failures.length} issue(s))\n`)
    for (const failure of result.failures) process.stderr.write(`- ${failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      `Stage 09P M0 scope check PASS (${manifests.valid.length} valid, ` +
      `${manifests.invalid.length} exclusive invalid, ${manifests.schemas.length} compiled schemas, ` +
      `${manifests.sources.length} pure source, ${manifests.tests.length} domain test files, ` +
      `${manifests.valid.length + manifests.invalid.length} schema/runtime matrix cases)\n`
    )
  }
}
