#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'
import ts from 'typescript'

import * as domain from '../packages/domain/dist/index.js'

export const BASELINE_SHA = '2c2ccd9015268fe44db4bb5446f3340e551914be'
export const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

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

const surfaceRoots = (root) => Object.freeze({
  valid: resolve(root, 'data/samples/stage09p-m0/valid'),
  invalid: resolve(root, 'data/samples/stage09p-m0/invalid'),
  schemas: resolve(root, 'data/schemas'),
  sources: resolve(root, 'packages/domain/src'),
  tests: resolve(root, 'packages/domain/tests')
})

const surfaceType = (entry) => {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'directory'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'special'
}

const enumerateSurface = (directory) => {
  const entries = []
  let readable = true
  const visit = (current, prefix) => {
    let children
    try {
      children = readdirSync(current, { withFileTypes: true })
    } catch {
      readable = false
      return
    }
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const child of children) {
      const path = prefix.length === 0 ? child.name : `${prefix}/${child.name}`
      const type = surfaceType(child)
      entries.push(Object.freeze({ path, type }))
      if (type === 'directory') visit(resolve(current, child.name), path)
    }
  }
  visit(directory, '')
  return Object.freeze({ directory, entries: Object.freeze(entries), readable })
}

export const collectM0Surfaces = (root = repositoryRoot) => {
  const roots = surfaceRoots(root)
  return Object.freeze(Object.fromEntries(
    Object.entries(roots).map(([name, directory]) => [name, enumerateSurface(directory)])
  ))
}

const expectedSurface = (files) => files.map((path) => ({ path, type: 'file' }))
const sameSurface = (surface, files) =>
  surface.readable &&
  JSON.stringify(surface.entries) === JSON.stringify(expectedSurface(files))
const surfaceFiles = (surface) => surface.entries
  .filter(({ type }) => type === 'file')
  .map(({ path }) => path)

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
export const collectManifestFailures = (root = repositoryRoot, surfaces = collectM0Surfaces(root)) => {
  const failures = []
  const checks = [
    [surfaces.valid, manifests.valid, 'valid fixture'],
    [surfaces.invalid, manifests.invalid, 'invalid fixture'],
    [surfaces.schemas, manifests.schemas, 'schema'],
    [surfaces.sources, manifests.sources, 'domain source'],
    [surfaces.tests, manifests.tests, 'domain test']
  ]
  for (const [surface, expected, label] of checks) {
    if (!sameSurface(surface, expected)) {
      failures.push(`${label} recursive manifest must be exact across paths and node types`)
    }
  }
  try {
    const actual = enumerateSurface(resolve(root, 'scripts/tests')).entries
      .filter(({ path, type }) => {
        const name = path.split('/').at(-1) ?? ''
        return type !== 'directory' && name.startsWith('stage09p-m0-') && name.endsWith('.test.mjs')
      })
      .map(({ path, type }) => ({ path, type }))
    if (JSON.stringify(actual) !== JSON.stringify(expectedSurface(manifests.mutationTests))) {
      failures.push('M0 mutation-test recursive manifest must be exact across paths and node types')
    }
  } catch {
    failures.push('M0 mutation-test recursive manifest must be exact across paths and node types')
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

export const collectSyntheticFailures = (root = repositoryRoot, surfaces = collectM0Surfaces(root)) => {
  const failures = []
  if (!sameSurface(surfaces.valid, manifests.valid)) {
    failures.push('valid fixture synthetic leaf/key registry must cover the exact recursive surface')
  }
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

export const collectInvalidSyntheticFailures = (
  root = repositoryRoot,
  surfaces = collectM0Surfaces(root)
) => {
  const failures = []
  if (!sameSurface(surfaces.invalid, manifests.invalid)) {
    failures.push('invalid fixture synthetic leaf/key registry must cover the exact recursive surface')
  }
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
const forbiddenCapabilityNames = new Set([
  'fetch', 'process', 'require', 'eval', 'Function', 'WebSocket', 'Worker', 'globalThis',
  'XMLHttpRequest', 'Deno', 'Bun', 'readFile', 'readFileSync', 'writeFile',
  'writeFileSync', 'appendFile', 'open', 'createReadStream', 'createWriteStream',
  'connect', 'createConnection', 'indexedDB', 'localStorage', 'sessionStorage',
  'document', 'window', 'navigator', 'setTimeout', 'setInterval', 'createRequire',
  'getBuiltinModule', 'dlopen', 'module', 'global', 'AsyncFunction', 'GeneratorFunction'
])
const forbiddenMemberNames = new Set([
  ...forbiddenCapabilityNames,
  'constructor', 'prototype', '__proto__', 'caller', 'callee', 'arguments', 'construct'
])
const auditedLibCallNames = new Set([
  'Number', 'String', 'add', 'create', 'defineProperty', 'delete', 'freeze', 'get',
  'getOwnPropertyDescriptor', 'getPrototypeOf', 'has', 'hasOwn', 'includes', 'is',
  'isArray', 'isFinite', 'isSafeInteger', 'join', 'map', 'max', 'min', 'normalize',
  'ownKeys', 'parse', 'push', 'replace', 'set', 'slice', 'some', 'sort', 'stringify',
  'test', 'toISOString', 'toLowerCase', 'trim', 'values'
])
const auditedLibConstructors = new Set([
  'Date', 'Map', 'Set', 'TypeError', 'WeakMap', 'WeakSet'
])
const auditedNobleCalls = new Set(['bytesToHex', 'sha256', 'utf8ToBytes'])
const auditedParameterCalls = new Set([
  'canonical.ts#compareStructural:fields',
  'canonical.ts#compareStructural:material',
  'decode.ts#dataArray:decodeItem',
  'decode.ts#result:operation'
])

export const capabilityReasons = Object.freeze({
  moduleGrammar: 'domain module grammar must remain static, literal, relative-or-audited, and ImportEquals-free',
  capabilitySource: 'domain production source acquires a forbidden capability by declaration identity',
  prototypeChain: 'domain production source cannot acquire capability through constructor or prototype chains',
  computedSensitive: 'domain production source cannot acquire sensitive capability through computed member keys',
  declarationIdentity: 'domain call/new/tagged-template must resolve to an audited declaration identity'
})

const resolvedSymbol = (checker, node) => {
  const symbol = checker.getSymbolAtLocation(node)
  return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol
}

const unwrapExpression = (node) => {
  let current = node
  while (
    current !== undefined &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current))
  ) current = current.expression
  return current
}

const constantString = (node, checker, seen = new Set()) => {
  const current = unwrapExpression(node)
  if (current === undefined) return null
  if (ts.isStringLiteralLike(current)) return current.text
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = constantString(current.left, checker, seen)
    const right = constantString(current.right, checker, seen)
    return left === null || right === null ? null : `${left}${right}`
  }
  if (ts.isIdentifier(current)) {
    const symbol = resolvedSymbol(checker, current)
    if (symbol === undefined || seen.has(symbol)) return null
    seen.add(symbol)
    const declarations = symbol.declarations ?? []
    if (declarations.length !== 1 || !ts.isVariableDeclaration(declarations[0])) return null
    const declaration = declarations[0]
    if (
      declaration.initializer === undefined ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) return null
    return constantString(declaration.initializer, checker, seen)
  }
  return null
}

const isDeclarationName = (node) => {
  const parent = node.parent
  return (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent)) && parent.name === node
  )
}

const isNonReferenceIdentifier = (node) => {
  const parent = node.parent
  return isDeclarationName(node) ||
    ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) ||
    ts.isTypeReferenceNode(parent) || ts.isLiteralTypeNode(parent) || ts.isExternalModuleReference(parent) ||
    ts.isPropertyAccessExpression(parent) && parent.name === node ||
    ts.isPropertyAssignment(parent) && parent.name === node ||
    ts.isShorthandPropertyAssignment(parent)
}

const relativeSourcePath = (sourceRoot, fileName) =>
  fileName.startsWith(`${sourceRoot}/`) ? fileName.slice(sourceRoot.length + 1) : null

const nearestNamedFunction = (node) => {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)
    ) return current.parent.name.text
    current = current.parent
  }
  return null
}

const auditedParameterIdentity = (declaration, sourceRoot) => {
  if (!ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) return null
  const file = relativeSourcePath(sourceRoot, declaration.getSourceFile().fileName)
  const owner = nearestNamedFunction(declaration)
  return file === null || owner === null ? null : `${file}#${owner}:${declaration.name.text}`
}

const declarationIsLocalCallable = (declaration, sourceRoot) => {
  if (relativeSourcePath(sourceRoot, declaration.getSourceFile().fileName) === null) return false
  if (ts.isFunctionDeclaration(declaration)) return true
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false
  const initializer = unwrapExpression(declaration.initializer)
  return initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
}

const symbolHasAuditedLibDeclaration = (symbol, allowedNames) =>
  symbol !== undefined &&
  allowedNames.has(symbol.getName()) &&
  symbol.declarations?.some((declaration) =>
    /[/\\]typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/u.test(
      declaration.getSourceFile().fileName
    )) === true

const symbolHasAuditedNobleDeclaration = (symbol) =>
  symbol !== undefined &&
  auditedNobleCalls.has(symbol.getName()) &&
  symbol.declarations?.some((declaration) =>
    /[/\\]@noble\+hashes@[^/\\]+[/\\]node_modules[/\\]@noble[/\\]hashes[/\\]/u.test(
      declaration.getSourceFile().fileName
    )) === true

const callHasAuditedIdentity = (node, checker, sourceRoot) => {
  const expression = unwrapExpression(node.expression)
  if (expression === undefined) return false
  const symbolNode = ts.isPropertyAccessExpression(expression)
    ? expression.name
    : ts.isElementAccessExpression(expression)
      ? expression.argumentExpression
      : expression
  const symbol = resolvedSymbol(checker, symbolNode)
  if (symbolHasAuditedLibDeclaration(symbol, auditedLibCallNames)) return true
  if (symbolHasAuditedNobleDeclaration(symbol)) return true
  if (symbol?.declarations?.some((declaration) => declarationIsLocalCallable(declaration, sourceRoot))) {
    return true
  }
  return symbol?.declarations?.some((declaration) => {
    const identity = auditedParameterIdentity(declaration, sourceRoot)
    return identity !== null && auditedParameterCalls.has(identity)
  }) === true
}

const newHasAuditedIdentity = (node, checker) => {
  const expression = unwrapExpression(node.expression)
  if (expression === undefined) return false
  return symbolHasAuditedLibDeclaration(
    resolvedSymbol(checker, expression),
    auditedLibConstructors
  )
}

const moduleSpecifierFailure = (file, specifier, sourceSet) => {
  if (!ts.isStringLiteral(specifier)) return true
  const value = specifier.text
  if (
    value.length === 0 || value.includes('?') || value.includes('#') || value.includes('%') ||
    value.includes('\\') || /\p{White_Space}|\p{Cf}/u.test(value) ||
    value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)
  ) return true
  if (value.startsWith('.')) {
    if (!/^\.\.?\/[A-Za-z0-9./-]+\.js$/u.test(value)) return true
    const target = posix.normalize(posix.join(posix.dirname(file), value)).replace(/\.js$/u, '.ts')
    return target.startsWith('../') || !sourceSet.has(target)
  }
  return !permittedRuntimeImports.has(value)
}

const programForDomainSources = (root, sourceFiles) => ts.createProgram({
  rootNames: sourceFiles.map((file) => resolve(root, 'packages/domain/src', file)),
  options: {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: []
  }
})

const recordModuleGrammarFailure = (failures) => {
  /* guard:module-grammar */
  failures.push(capabilityReasons.moduleGrammar)
}
const recordPrototypeChainFailure = (failures) => {
  /* guard:prototype-chain */
  failures.push(capabilityReasons.prototypeChain)
}
const recordComputedSensitiveFailure = (failures) => {
  /* guard:computed-sensitive */
  failures.push(capabilityReasons.computedSensitive)
}
const recordDeclarationIdentityFailure = (failures) => {
  /* guard:declaration-identity */
  failures.push(capabilityReasons.declarationIdentity)
}

export const collectCapabilityFailures = (root = repositoryRoot, surfaces = collectM0Surfaces(root)) => {
  const failures = []
  const sourceRoot = resolve(root, 'packages/domain/src')
  const testRoot = resolve(root, 'packages/domain/tests')
  const packageJson = parseJson(resolve(root, 'packages/domain/package.json'), failures, 'domain package')
  if (JSON.stringify(Object.keys(packageJson?.dependencies ?? {})) !== '["@noble/hashes"]') {
    failures.push('domain runtime dependencies must equal the audited pure allowlist')
  }
  if (!surfaces.sources.readable || surfaces.sources.entries.some(({ type }) => type !== 'file')) {
    failures.push('domain production recursive source surface must contain registered ordinary files only')
  }
  const sourceFiles = surfaceFiles(surfaces.sources)
  const sourceSet = new Set(sourceFiles)
  let program
  try {
    program = programForDomainSources(root, sourceFiles)
  } catch {
    failures.push('domain source must be readable for AST capability analysis')
  }
  if (program !== undefined) {
    const checker = program.getTypeChecker()
    if (program.getSyntacticDiagnostics().length > 0) {
      failures.push('domain source must parse as TypeScript')
    }
    for (const file of sourceFiles) {
      const tree = program.getSourceFile(resolve(sourceRoot, file))
      if (tree === undefined) {
        failures.push('domain source must be readable for AST capability analysis')
        continue
      }
    const visit = (node) => {
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined
      ) {
        if (moduleSpecifierFailure(file, node.moduleSpecifier, sourceSet)) {
          recordModuleGrammarFailure(failures)
        }
      }
      if (
        ts.isImportEqualsDeclaration(node) || ts.isExternalModuleReference(node) ||
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) recordModuleGrammarFailure(failures)
      if (
        ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
      ) {
        const key = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : constantString(node.argumentExpression, checker)
        if (key === 'constructor' || key === 'prototype' || key === '__proto__' ||
          key === 'caller' || key === 'callee' || key === 'arguments') {
          const safePrototype = ts.isPropertyAccessExpression(node) &&
            key === 'prototype' && ts.isIdentifier(node.expression) &&
            (node.expression.text === 'Array' || node.expression.text === 'Object') &&
            symbolHasAuditedLibDeclaration(resolvedSymbol(checker, node.expression), new Set([
              'Array', 'Object'
            ]))
          if (!safePrototype) recordPrototypeChainFailure(failures)
        }
        if (
          key !== null && forbiddenMemberNames.has(key) &&
          !['constructor', 'prototype', '__proto__', 'caller', 'callee', 'arguments'].includes(key)
        ) recordComputedSensitiveFailure(failures)
        if (ts.isElementAccessExpression(node) && key === null) {
          const type = checker.getTypeAtLocation(node.expression)
          if (
            (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
            type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0
          ) recordComputedSensitiveFailure(failures)
        }
      }
      if (
        ts.isIdentifier(node) && forbiddenCapabilityNames.has(node.text) &&
        !isNonReferenceIdentifier(node)
      ) {
        failures.push(capabilityReasons.capabilitySource)
      }
      if (
        ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword &&
        !callHasAuditedIdentity(node, checker, sourceRoot)
      ) recordDeclarationIdentityFailure(failures)
      if (ts.isNewExpression(node) && !newHasAuditedIdentity(node, checker)) {
        recordDeclarationIdentityFailure(failures)
      }
      if (ts.isTaggedTemplateExpression(node)) {
        recordDeclarationIdentityFailure(failures)
      }
      if (
        (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name !== undefined && /(?:Dto|DTO|DatabaseRow|Repository|Adapter)$/.test(node.name.text)
      ) failures.push('domain source cannot define transport, row, or side-effect interface types')
      ts.forEachChild(node, visit)
    }
    visit(tree)
    }
  }
  if (!surfaces.tests.readable || surfaces.tests.entries.some(({ type }) => type !== 'file')) {
    failures.push('M0 recursive test surface must contain registered ordinary files only')
  }
  for (const file of surfaceFiles(surfaces.tests)) {
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
  if (
    typeof value !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)
  ) return false
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return false
  try {
    return new Date(milliseconds).toISOString() === value
  } catch {
    return false
  }
}

const unicodeScalar = (value) =>
  typeof value === 'string' &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)

const createSchemaValidator = (executionCounts = null) => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true })
  ajv.addFormat('canonical-utc-instant', {
    type: 'string',
    validate: (value) => {
      if (executionCounts !== null) executionCounts.canonicalInstant += 1
      return canonicalInstant(value)
    }
  })
  ajv.addFormat('unicode-scalar', {
    type: 'string',
    validate: (value) => {
      if (executionCounts !== null) executionCounts.unicodeScalar += 1
      return unicodeScalar(value)
    }
  })
  ajv.addKeyword({
    keyword: 'notNegativeZero',
    schemaType: 'boolean',
    type: 'number',
    errors: false,
    validate: (enabled, value) => {
      if (executionCounts !== null) executionCounts.notNegativeZero += 1
      return !enabled || !Object.is(value, -0)
    }
  })
  return ajv
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

const compiledSchemas = (root, executionCounts = null) => {
  const ajv = createSchemaValidator(executionCounts)
  return {
    governance: ajv.compile(JSON.parse(
      readFileSync(resolve(root, 'data/schemas/governance-release.schema.json'), 'utf8')
    )),
    fixture: ajv.compile(JSON.parse(
      readFileSync(resolve(root, 'data/schemas/invalid-governance-fixture.schema.json'), 'utf8')
    ))
  }
}

const ownJsonObject = (entries) => {
  const value = {}
  for (const [key, child] of entries) {
    Object.defineProperty(value, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: child
    })
  }
  return value
}

export const JSON_BOUNDARY_CASE_COUNT = 30
export const jsonBoundaryCases = () => Object.freeze([
  Object.freeze({ id: 'empty-object', value: {}, expected: true }),
  Object.freeze({ id: 'null', value: null, expected: true }),
  Object.freeze({ id: 'true', value: true, expected: true }),
  Object.freeze({ id: 'false', value: false, expected: true }),
  Object.freeze({ id: 'zero', value: 0, expected: true }),
  Object.freeze({ id: 'finite-positive', value: 1.25, expected: true }),
  Object.freeze({ id: 'finite-negative', value: -2.5, expected: true }),
  Object.freeze({ id: 'negative-zero', value: -0, expected: false }),
  Object.freeze({ id: 'nan', value: Number.NaN, expected: false }),
  Object.freeze({ id: 'positive-infinity', value: Number.POSITIVE_INFINITY, expected: false }),
  Object.freeze({ id: 'negative-infinity', value: Number.NEGATIVE_INFINITY, expected: false }),
  Object.freeze({ id: 'empty-string', value: '', expected: true }),
  Object.freeze({ id: 'nul-value', value: '\u0000', expected: true }),
  Object.freeze({ id: 'bmp-value', value: 'SYNTHETIC_É', expected: true }),
  Object.freeze({ id: 'astral-value', value: 'SYNTHETIC_😀', expected: true }),
  Object.freeze({ id: 'lone-high-value', value: '\uD800', expected: false }),
  Object.freeze({ id: 'lone-low-value', value: '\uDC00', expected: false }),
  Object.freeze({ id: 'array', value: [null, true, 1, 'SYNTHETIC_ARRAY'], expected: true }),
  Object.freeze({
    id: 'nested-object-array',
    value: { nested: { values: [false, 2.5, 'SYNTHETIC_NESTED'] } },
    expected: true
  }),
  Object.freeze({ id: 'empty-key', value: ownJsonObject([['', 'SYNTHETIC_EMPTY_KEY']]), expected: true }),
  Object.freeze({ id: 'nul-key', value: ownJsonObject([['\u0000', 'SYNTHETIC_NUL_KEY']]), expected: true }),
  Object.freeze({ id: 'bmp-key', value: ownJsonObject([['é', 'SYNTHETIC_BMP_KEY']]), expected: true }),
  Object.freeze({ id: 'astral-key', value: ownJsonObject([['😀', 'SYNTHETIC_ASTRAL_KEY']]), expected: true }),
  Object.freeze({ id: 'lone-high-key', value: ownJsonObject([['\uD800', 'SYNTHETIC_BAD_KEY']]), expected: false }),
  Object.freeze({ id: 'lone-low-key', value: ownJsonObject([['\uDC00', 'SYNTHETIC_BAD_KEY']]), expected: false }),
  Object.freeze({ id: 'proto-key', value: ownJsonObject([['__proto__', 'SYNTHETIC_PROTO']]), expected: true }),
  Object.freeze({ id: 'constructor-key', value: ownJsonObject([['constructor', 'SYNTHETIC_CONSTRUCTOR']]), expected: true }),
  Object.freeze({ id: 'prototype-key', value: ownJsonObject([['prototype', 'SYNTHETIC_PROTOTYPE']]), expected: true }),
  Object.freeze({
    id: 'combined-special-keys',
    value: ownJsonObject([
      ['__proto__', 'SYNTHETIC_PROTO'],
      ['constructor', 'SYNTHETIC_CONSTRUCTOR'],
      ['prototype', 'SYNTHETIC_PROTOTYPE'],
      ['', 'SYNTHETIC_EMPTY'],
      ['\u0000', 'SYNTHETIC_NUL'],
      ['😀', 'SYNTHETIC_ASTRAL']
    ]),
    expected: true
  }),
  Object.freeze({
    id: 'deep-mixed-json',
    value: { array: [ownJsonObject([['__proto__', null]]), { scalar: 'SYNTHETIC_DEEP' }] },
    expected: true
  })
])

const stringCodeUnits = (value) => {
  const units = []
  for (let index = 0; index < value.length; index += 1) {
    units.push(value.charCodeAt(index).toString(16).padStart(4, '0'))
  }
  return units.join('-')
}

const boundaryIdentity = (value) => {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return `boolean:${value}`
  if (typeof value === 'string') return `string:${stringCodeUnits(value)}`
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return 'number:-0'
    if (Number.isNaN(value)) return 'number:NaN'
    if (value === Number.POSITIVE_INFINITY) return 'number:+Infinity'
    if (value === Number.NEGATIVE_INFINITY) return 'number:-Infinity'
    return `number:${value}`
  }
  if (Array.isArray(value)) return `array:[${value.map(boundaryIdentity).join(',')}]`
  const entries = Object.keys(value).map((key) => [key, value[key]])
  entries.sort((left, right) => stringCodeUnits(left[0]) < stringCodeUnits(right[0]) ? -1 : 1)
  return `object:{${entries.map(([key, child]) =>
    `${stringCodeUnits(key)}:${boundaryIdentity(child)}`).join(',')}}`
}

export const jsonBoundaryReasons = Object.freeze({
  count: 'JSON boundary parity case count must remain exactly 30',
  idDistinct: 'JSON boundary parity case IDs must remain distinct',
  materialDistinct: 'JSON boundary parity material inputs must remain distinct',
  parity: 'JSON boundary schema/runtime parity must match the exact expected matrix',
  oracle: 'JSON boundary parity oracle must execute successfully'
})

export const jsonBoundaryEvidenceStats = (cases = jsonBoundaryCases()) => {
  const identities = cases.map(({ value }) => boundaryIdentity(value))
  return Object.freeze({
    count: cases.length,
    uniqueIds: new Set(cases.map(({ id }) => id)).size,
    uniqueMaterials: new Set(identities).size
  })
}

export const SCHEMA_EXTENSION_EXECUTION_COUNTS = Object.freeze({
  unicodeScalar: 1184,
  canonicalInstant: 120,
  notNegativeZero: 6
})

export const schemaExtensionExecutionStats = (root = repositoryRoot) => {
  const executionCounts = { unicodeScalar: 0, canonicalInstant: 0, notNegativeZero: 0 }
  const validators = compiledSchemas(root, executionCounts)
  const baseText = readFileSync(
    resolve(fixtureRoot(root), 'valid/food-concept.json'),
    'utf8'
  )
  for (const boundary of jsonBoundaryCases()) {
    const release = JSON.parse(baseText)
    release.envelopes[0].content = boundary.value
    validators.governance(release)
  }
  return Object.freeze({ ...executionCounts })
}

const recordJsonBoundaryOracleFailure = (failures) => {
  /* guard:json-boundary-oracle */
  failures.push(jsonBoundaryReasons.oracle)
}

export const collectJsonBoundaryParityFailures = (
  root = repositoryRoot,
  cases = jsonBoundaryCases()
) => {
  const failures = []
  let stats
  try {
    stats = jsonBoundaryEvidenceStats(cases)
  } catch {
    recordJsonBoundaryOracleFailure(failures)
    return failures
  }
  /* guard:json-boundary-count */
  if (stats.count !== JSON_BOUNDARY_CASE_COUNT) failures.push(jsonBoundaryReasons.count)
  /* guard:json-boundary-id-distinct */
  if (stats.uniqueIds !== stats.count) failures.push(jsonBoundaryReasons.idDistinct)
  /* guard:json-boundary-material-distinct */
  if (stats.uniqueMaterials !== stats.count) failures.push(jsonBoundaryReasons.materialDistinct)
  try {
    const validators = compiledSchemas(root)
    const baseText = readFileSync(
      resolve(fixtureRoot(root), 'valid/food-concept.json'),
      'utf8'
    )
    for (const boundary of cases) {
      const release = JSON.parse(baseText)
      release.envelopes[0].content = boundary.value
      const decoded = domain.decodeGovernanceRelease(release)
      let runtimeOk = decoded.ok
      if (decoded.ok) {
        release.envelopes[0].contentDigest = domain.canonicalReleaseDigest(release)
        runtimeOk = domain.validateGovernanceRelease(release).ok
      }
      const schemaOk = validators.governance(release)
      /* guard:json-boundary-parity */
      if (schemaOk !== boundary.expected || runtimeOk !== boundary.expected || schemaOk !== runtimeOk) {
        failures.push(jsonBoundaryReasons.parity)
      }
    }
  } catch {
    recordJsonBoundaryOracleFailure(failures)
  }
  return [...new Set(failures)]
}

const releaseStringMutationBuilders = Object.freeze([
  Object.freeze({ id: 'root-schema', mutate: (release, value) => { release.$schema = value } }),
  Object.freeze({ id: 'dataset-id', mutate: (release, value) => { release.envelopes[0].datasetId = value } }),
  Object.freeze({ id: 'release-id', mutate: (release, value) => { release.envelopes[0].releaseId = value } }),
  Object.freeze({ id: 'owner-actor-id', mutate: (release, value) => { release.envelopes[0].owner.actorId = value } }),
  Object.freeze({ id: 'owner-role', mutate: (release, value) => { release.envelopes[0].owner.role = value } }),
  Object.freeze({ id: 'source-locator', mutate: (release, value) => { release.envelopes[0].sourceReferences[0].locator = value } }),
  Object.freeze({ id: 'alias-value', mutate: (release, value) => { release.envelopes[0].aliases[0].value = value } }),
  Object.freeze({
    id: 'region-array-item',
    mutate: (release, value) => {
      release.envelopes[0].applicableRegions[0] = value
      release.envelopes[0].aliases[0].region = value
    }
  }),
  Object.freeze({
    id: 'language-array-item',
    mutate: (release, value) => {
      release.envelopes[0].languages[0] = value
      release.envelopes[0].aliases[0].language = value
    }
  }),
  Object.freeze({ id: 'nullable-license-reference', mutate: (release, value) => { release.envelopes[0].licenseReference = value } })
])

const semanticStringMutationBuilders = Object.freeze([
  Object.freeze({ id: 'enum-dataset-kind', mutate: (release, value) => { release.envelopes[0].datasetKind = value } }),
  Object.freeze({ id: 'uuid-entity-id', mutate: (release, value) => { release.envelopes[0].entityId = value } }),
  Object.freeze({ id: 'digest-content-digest', mutate: (release, value) => { release.envelopes[0].contentDigest = value } }),
  Object.freeze({ id: 'timestamp-reviewed-at', mutate: (release, value) => { release.envelopes[0].reviewedAt = value } })
])

const validMappingFixture = () => ({
  $schema: '../../../schemas/invalid-governance-fixture.schema.json',
  syntheticFixture: 'fully_synthetic_mutation',
  baseValidFiles: ['food-concept.json'],
  mutations: [],
  hardMappings: [{
    mappingId: 'syn:mapping:lexical-parity',
    source: {
      datasetId: 'syn:dataset:food-concept',
      entityId: '01900000-7000-7000-8000-000000000001',
      entityRevision: 1
    },
    target: {
      datasetId: 'syn:dataset:food-concept',
      entityId: '01900000-7000-7000-8000-000000000001',
      entityRevision: 1
    },
    required: true
  }],
  recomputeReleaseDigests: true,
  expectedIssueCodes: ['HARD_MAPPING_UNRESOLVED']
})

export const GOVERNANCE_STRING_CASE_COUNT = 51
export const governanceStringCases = (root = repositoryRoot) => {
  const baseText = readFileSync(
    resolve(fixtureRoot(root), 'valid/food-concept.json'),
    'utf8'
  )
  const cases = []
  for (const builder of releaseStringMutationBuilders) {
    for (const variant of [
      { id: 'lone-high', value: '\uD800', expected: false },
      { id: 'lone-low', value: '\uDC00', expected: false },
      { id: 'astral', value: 'SYNTHETIC_😀', expected: true }
    ]) {
      const release = JSON.parse(baseText)
      builder.mutate(release, variant.value)
      cases.push(Object.freeze({
        id: `${builder.id}:${variant.id}`,
        kind: 'release',
        input: release,
        expected: variant.expected
      }))
    }
  }
  const semanticValues = Object.freeze({
    'enum-dataset-kind': 'allergen',
    'uuid-entity-id': '01900000-7000-7000-8000-000000000011',
    'digest-content-digest': `sha256:${'b'.repeat(64)}`,
    'timestamp-reviewed-at': '2000-01-02T00:00:00.001Z'
  })
  for (const builder of semanticStringMutationBuilders) {
    for (const variant of [
      { id: 'lone-high', value: '\uD800', expected: false },
      { id: 'lone-low', value: '\uDC00', expected: false },
      { id: 'valid-family-control', value: semanticValues[builder.id], expected: true }
    ]) {
      const release = JSON.parse(baseText)
      builder.mutate(release, variant.value)
      cases.push(Object.freeze({
        id: `${builder.id}:${variant.id}`,
        kind: 'release',
        input: release,
        expected: variant.expected
      }))
    }
  }
  const mappingBuilders = Object.freeze([
    Object.freeze({
      id: 'mapping-id',
      valid: 'syn:mapping:lexical-parity-control',
      mutate: (fixture, value) => { fixture.hardMappings[0].mappingId = value }
    }),
    Object.freeze({
      id: 'mapping-dataset-id',
      valid: 'syn:dataset:lexical-control',
      mutate: (fixture, value) => { fixture.hardMappings[0].source.datasetId = value }
    }),
    Object.freeze({
      id: 'mapping-entity-id',
      valid: '01900000-7000-7000-8000-000000000011',
      mutate: (fixture, value) => { fixture.hardMappings[0].source.entityId = value }
    })
  ])
  for (const builder of mappingBuilders) {
    for (const variant of [
      { id: 'lone-high', value: `${builder.valid.split(':').slice(0, -1).join(':')}:\uD800`, expected: false },
      { id: 'lone-low', value: `${builder.valid.split(':').slice(0, -1).join(':')}:\uDC00`, expected: false },
      { id: 'valid-family-control', value: builder.valid, expected: true }
    ]) {
      const fixture = validMappingFixture()
      builder.mutate(fixture, variant.value)
      cases.push(Object.freeze({
        id: `${builder.id}:${variant.id}`,
        kind: 'fixture',
        input: fixture,
        expected: variant.expected
      }))
    }
  }
  return Object.freeze(cases)
}

const governanceStringReasons = Object.freeze({
  shape: 'governance string lexical matrix count, IDs, and material inputs must remain exact',
  parity: 'governance string lexical parity must match Ajv raw/text and runtime raw/text',
  oracle: 'governance string lexical parity oracle must execute successfully'
})

export const governanceStringEvidenceStats = (cases = governanceStringCases()) => ({
  count: cases.length,
  uniqueIds: new Set(cases.map(({ id }) => id)).size,
  uniqueMaterials: new Set(cases.map(({ kind, input }) =>
    boundaryIdentity(ownJsonObject([['kind', kind], ['input', input]])))).size
})

export const collectGovernanceStringParityFailures = (
  root = repositoryRoot,
  cases = governanceStringCases(root)
) => {
  const failures = []
  try {
    const stats = governanceStringEvidenceStats(cases)
    if (
      stats.count !== GOVERNANCE_STRING_CASE_COUNT ||
      stats.uniqueIds !== stats.count ||
      stats.uniqueMaterials !== stats.count
    ) failures.push(governanceStringReasons.shape)
    const validators = compiledSchemas(root)
    const validDirectory = resolve(fixtureRoot(root), 'valid')
    for (const current of cases) {
      const text = JSON.stringify(current.input)
      const parsed = JSON.parse(text)
      let ajvRaw
      let ajvText
      let runtimeRaw
      let runtimeText
      if (current.kind === 'release') {
        ajvRaw = validators.governance(current.input)
        ajvText = validators.governance(parsed)
        runtimeRaw = domain.decodeGovernanceRelease(current.input).ok
        runtimeText = domain.decodeGovernanceReleaseJson(text).ok
      } else {
        ajvRaw = validators.fixture(current.input)
        ajvText = validators.fixture(parsed)
        const rawCatalog = materializeFixture(current.input, validDirectory, domain)
        const textCatalog = materializeFixture(parsed, validDirectory, domain)
        runtimeRaw = domain.decodeGovernanceCatalog(rawCatalog).ok
        runtimeText = domain.decodeGovernanceCatalogJson(JSON.stringify(textCatalog)).ok
      }
      if (
        ajvRaw !== current.expected || ajvText !== current.expected ||
        runtimeRaw !== current.expected || runtimeText !== current.expected
      ) failures.push(governanceStringReasons.parity)
    }
  } catch {
    failures.push(governanceStringReasons.oracle)
  }
  return [...new Set(failures)]
}

const schemaStringContractClosed = (schema) => {
  const scalarReference = '#/$defs/scalarString'
  if (
    schema?.$defs?.scalarString?.type !== 'string' ||
    schema.$defs.scalarString.format !== 'unicode-scalar'
  ) return false
  let closed = true
  const visit = (node, protectedByScalar = false, scalarNode = false) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    const allOfProtects = Array.isArray(node.allOf) &&
      node.allOf.some((child) => child?.$ref === scalarReference)
    const protectedHere = protectedByScalar || allOfProtects || node.$ref === scalarReference
    const acceptsOpenString =
      node.type === 'string' ||
      Array.isArray(node.type) && node.type.includes('string') ||
      typeof node.pattern === 'string' || typeof node.format === 'string' ||
      typeof node.minLength === 'number' ||
      Array.isArray(node.enum) && node.enum.some((value) => typeof value === 'string') ||
      typeof node.const === 'string'
    if (acceptsOpenString && !protectedHere && !scalarNode) closed = false
    for (const [key, child] of Object.entries(node)) {
      if (key === 'scalarString' && node === schema.$defs) {
        visit(child, true, true)
      } else if (key !== '$defs' || child !== schema.$defs) {
        visit(child, protectedHere, false)
      } else {
        for (const [definition, definitionNode] of Object.entries(child)) {
          visit(definitionNode, definition === 'scalarString', definition === 'scalarString')
        }
      }
    }
  }
  visit(schema)
  return closed
}

export const collectSchemaContractFailures = (
  root = repositoryRoot,
  surfaces = collectM0Surfaces(root)
) => {
  const failures = []
  if (!sameSurface(surfaces.schemas, manifests.schemas)) {
    failures.push('schema compile registry must cover the exact recursive surface')
  }
  try {
    for (const file of surfaceFiles(surfaces.schemas)) {
      const schema = JSON.parse(readFileSync(resolve(root, 'data/schemas', file), 'utf8'))
      createSchemaValidator().compile(schema)
      if (!schemaStringContractClosed(schema)) {
        failures.push('schema string lexical contract must route every string family through unicode scalar base')
      }
    }
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
    if (
      JSON.stringify(schemaExtensionExecutionStats(root)) !==
      JSON.stringify(SCHEMA_EXTENSION_EXECUTION_COUNTS)
    ) failures.push('schema format and keyword execution counts must remain exact')
  } catch {
    failures.push('both M0 schemas must compile and execute with the independent 2020-12 validator')
  }
  return [...new Set(failures)]
}

export const collectSchemaParityFailures = async (
  root = repositoryRoot,
  surfaces = collectM0Surfaces(root)
) => {
  const failures = collectSchemaContractFailures(root, surfaces)
  try {
    const validators = compiledSchemas(root)
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
    failures.push(...collectJsonBoundaryParityFailures(root))
    failures.push(...collectGovernanceStringParityFailures(root))
  } catch {
    failures.push('both M0 schemas must compile and execute with the independent 2020-12 validator')
  }
  return [...new Set(failures)]
}

export const runStage09pM0ScopeCheck = async (root = repositoryRoot) => {
  const surfaces = collectM0Surfaces(root)
  const groups = [
    collectManifestFailures(root, surfaces),
    collectSyntheticFailures(root, surfaces),
    collectInvalidSyntheticFailures(root, surfaces),
    collectCapabilityFailures(root, surfaces),
    collectRepositoryScopeFailures(root),
    await collectSchemaParityFailures(root, surfaces)
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
    const boundaryStats = jsonBoundaryEvidenceStats()
    const stringStats = governanceStringEvidenceStats()
    const extensionStats = schemaExtensionExecutionStats()
    process.stdout.write(
      `Stage 09P M0 scope check PASS (${manifests.valid.length} valid, ` +
      `${manifests.invalid.length} exclusive invalid, ${manifests.schemas.length} compiled schemas, ` +
      `${manifests.sources.length} pure source, ${manifests.tests.length} domain test files, ` +
      `${manifests.valid.length + manifests.invalid.length} fixture parity + ` +
      `${boundaryStats.count} JSON boundary parity cases / ${boundaryStats.uniqueIds} unique IDs / ` +
      `${boundaryStats.uniqueMaterials} unique material inputs + ${stringStats.count} governance ` +
      `string parity cases / ${stringStats.uniqueIds} unique IDs / ` +
      `${stringStats.uniqueMaterials} unique material inputs; schema extension executions ` +
      `unicode=${extensionStats.unicodeScalar}, utc=${extensionStats.canonicalInstant}, ` +
      `negative-zero=${extensionStats.notNegativeZero})\n`
    )
  }
}
