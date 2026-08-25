#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, posix, relative, resolve, sep } from 'node:path'
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
  path === 'docs/plans/2026-08-stage-09p-safe-deterministic-product-core.md' ||
  path === 'docs/architecture/decisions/0007-food-knowledge-governance-and-domain-core.md' ||
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
  'getBuiltinModule', 'dlopen', 'module', 'global', 'crypto', 'AsyncFunction',
  'GeneratorFunction'
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

const frozenStrings = (values) => Object.freeze([...values].sort())

const domainCompilerOptions = Object.freeze({
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  types: Object.freeze([])
})

const registeredTypescriptVersion = '5.9.3'
const registeredNobleHashesVersion = '2.0.1'
export const registeredTypescriptLibInputs = frozenStrings([
  'lib.decorators.d.ts',
  'lib.decorators.legacy.d.ts',
  'lib.dom.asynciterable.d.ts',
  'lib.dom.d.ts',
  'lib.dom.iterable.d.ts',
  'lib.es2015.collection.d.ts',
  'lib.es2015.core.d.ts',
  'lib.es2015.d.ts',
  'lib.es2015.generator.d.ts',
  'lib.es2015.iterable.d.ts',
  'lib.es2015.promise.d.ts',
  'lib.es2015.proxy.d.ts',
  'lib.es2015.reflect.d.ts',
  'lib.es2015.symbol.d.ts',
  'lib.es2015.symbol.wellknown.d.ts',
  'lib.es2016.array.include.d.ts',
  'lib.es2016.d.ts',
  'lib.es2016.intl.d.ts',
  'lib.es2017.arraybuffer.d.ts',
  'lib.es2017.d.ts',
  'lib.es2017.date.d.ts',
  'lib.es2017.intl.d.ts',
  'lib.es2017.object.d.ts',
  'lib.es2017.sharedmemory.d.ts',
  'lib.es2017.string.d.ts',
  'lib.es2017.typedarrays.d.ts',
  'lib.es2018.asyncgenerator.d.ts',
  'lib.es2018.asynciterable.d.ts',
  'lib.es2018.d.ts',
  'lib.es2018.intl.d.ts',
  'lib.es2018.promise.d.ts',
  'lib.es2018.regexp.d.ts',
  'lib.es2019.array.d.ts',
  'lib.es2019.d.ts',
  'lib.es2019.intl.d.ts',
  'lib.es2019.object.d.ts',
  'lib.es2019.string.d.ts',
  'lib.es2019.symbol.d.ts',
  'lib.es2020.bigint.d.ts',
  'lib.es2020.d.ts',
  'lib.es2020.date.d.ts',
  'lib.es2020.intl.d.ts',
  'lib.es2020.number.d.ts',
  'lib.es2020.promise.d.ts',
  'lib.es2020.sharedmemory.d.ts',
  'lib.es2020.string.d.ts',
  'lib.es2020.symbol.wellknown.d.ts',
  'lib.es2021.d.ts',
  'lib.es2021.intl.d.ts',
  'lib.es2021.promise.d.ts',
  'lib.es2021.string.d.ts',
  'lib.es2021.weakref.d.ts',
  'lib.es2022.array.d.ts',
  'lib.es2022.d.ts',
  'lib.es2022.error.d.ts',
  'lib.es2022.full.d.ts',
  'lib.es2022.intl.d.ts',
  'lib.es2022.object.d.ts',
  'lib.es2022.regexp.d.ts',
  'lib.es2022.string.d.ts',
  'lib.es5.d.ts',
  'lib.scripthost.d.ts',
  'lib.webworker.importscripts.d.ts'
])
export const registeredAuditedDependencyInputs = Object.freeze({
  [`@noble/hashes@${registeredNobleHashesVersion}`]: frozenStrings([
    '_md.d.ts',
    'sha2.d.ts',
    'utils.d.ts'
  ])
})

const pathInside = (root, candidate) =>
  candidate === root || candidate.startsWith(`${root}${sep}`)

const safeRealpath = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

const safePackageVersion = (root) => {
  try {
    const value = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    return typeof value.version === 'string' ? value.version : null
  } catch {
    return null
  }
}

const fixedTypescriptTrust = (() => {
  try {
    const entry = resolve(fileURLToPath(import.meta.resolve('typescript')))
    const packageLexicalRoot = resolve(dirname(entry), '..')
    const packageCanonicalRoot = realpathSync(packageLexicalRoot)
    const defaultLib = resolve(ts.getDefaultLibFilePath(domainCompilerOptions))
    const libLexicalRoot = dirname(defaultLib)
    const libCanonicalRoot = realpathSync(libLexicalRoot)
    const valid =
      ts.version === registeredTypescriptVersion &&
      safePackageVersion(packageCanonicalRoot) === registeredTypescriptVersion &&
      pathInside(packageLexicalRoot, libLexicalRoot) &&
      pathInside(packageCanonicalRoot, libCanonicalRoot) &&
      realpathSync(defaultLib) === realpathSync(
        resolve(libCanonicalRoot, 'lib.es2022.full.d.ts')
      )
    return Object.freeze({
      valid,
      lexicalRoot: libLexicalRoot,
      canonicalRoot: libCanonicalRoot,
      inputs: registeredTypescriptLibInputs,
      prefix: `typescript@${registeredTypescriptVersion}`
    })
  } catch {
    return Object.freeze({
      valid: false,
      lexicalRoot: '',
      canonicalRoot: '',
      inputs: registeredTypescriptLibInputs,
      prefix: `typescript@${registeredTypescriptVersion}`
    })
  }
})()

const auditedDependencyTrust = (root) => {
  const lexicalRoot = resolve(root, 'packages/domain/node_modules/@noble/hashes')
  const canonicalRoot = safeRealpath(lexicalRoot)
  if (canonicalRoot === null) return null
  return Object.freeze({
    valid: safePackageVersion(canonicalRoot) === registeredNobleHashesVersion,
    lexicalRoot,
    canonicalRoot,
    inputs: registeredAuditedDependencyInputs[
      `@noble/hashes@${registeredNobleHashesVersion}`
    ],
    prefix: `@noble/hashes@${registeredNobleHashesVersion}`
  })
}

const relativeInside = (root, candidate) => {
  const value = relative(root, candidate).replaceAll('\\', '/')
  return value === '' || value === '..' || value.startsWith('../') || /^[A-Za-z]:\//u.test(value)
    ? null
    : value
}

const trustedRootInputIdentity = (fileName, trust) => {
  if (trust === null || !trust.valid) return null
  const lexical = resolve(fileName)
  const canonical = safeRealpath(lexical)
  if (canonical === null) return null
  const canonicalRelative = relativeInside(trust.canonicalRoot, canonical)
  if (canonicalRelative === null || !trust.inputs.includes(canonicalRelative)) return null
  const lexicalRelative = relativeInside(trust.lexicalRoot, lexical)
  const canonicalAsLexicalRelative = relativeInside(trust.canonicalRoot, lexical)
  if (
    lexicalRelative !== canonicalRelative &&
    canonicalAsLexicalRelative !== canonicalRelative
  ) return null
  const registeredCanonical = safeRealpath(resolve(trust.canonicalRoot, canonicalRelative))
  if (registeredCanonical === null || registeredCanonical !== canonical) return null
  return `${trust.prefix}:${canonicalRelative}`
}

const repositoryInputOwnership = (root, fileName) => {
  const lexicalRoot = resolve(root)
  const canonicalRoot = safeRealpath(lexicalRoot)
  const lexical = resolve(fileName)
  const canonical = safeRealpath(lexical)
  return Object.freeze({
    lexicalRoot,
    canonicalRoot,
    lexical,
    canonical,
    lexicalOwned: pathInside(lexicalRoot, lexical),
    canonicalOwned: canonicalRoot !== null && canonical !== null &&
      pathInside(canonicalRoot, canonical)
  })
}

export const registeredModuleExportSurfaces = Object.freeze({
  'canonical.ts': frozenStrings([
    'declaration:value:variable:canonicalJson',
    'declaration:value:variable:canonicalReleaseDigest',
    'declaration:value:variable:canonicalReleaseText',
    'declaration:value:variable:compareUtf8'
  ]),
  'catalog.ts': frozenStrings([
    'declaration:value:variable:createValidatedCatalogIndex',
    'declaration:value:variable:isValidatedCatalogIndex',
    'declaration:value:variable:resolveValidatedReference'
  ]),
  'decode.ts': frozenStrings([
    'declaration:value:variable:decodeGovernanceCatalog',
    'declaration:value:variable:decodeGovernanceCatalogJson',
    'declaration:value:variable:decodeGovernanceRelease',
    'declaration:value:variable:decodeGovernanceReleaseJson',
    'declaration:value:variable:decodeGovernedReference'
  ]),
  'index.ts': frozenStrings([
    'reexport:type:CatalogValidationResult<-CatalogValidationResult@./types.js',
    'reexport:type:DatasetKind<-DatasetKind@./types.js',
    'reexport:type:DecodeResult<-DecodeResult@./types.js',
    'reexport:type:DecodedGovernanceCatalog<-DecodedGovernanceCatalog@./types.js',
    'reexport:type:DecodedGovernanceRelease<-DecodedGovernanceRelease@./types.js',
    'reexport:type:GovernanceActor<-GovernanceActor@./types.js',
    'reexport:type:GovernanceAlias<-GovernanceAlias@./types.js',
    'reexport:type:GovernanceCatalog<-GovernanceCatalog@./types.js',
    'reexport:type:GovernanceEnvelope<-GovernanceEnvelope@./types.js',
    'reexport:type:GovernanceRelease<-GovernanceRelease@./types.js',
    'reexport:type:GovernedReference<-GovernedReference@./types.js',
    'reexport:type:HardMapping<-HardMapping@./types.js',
    'reexport:type:JsonPrimitive<-JsonPrimitive@./types.js',
    'reexport:type:JsonValue<-JsonValue@./types.js',
    'reexport:type:LicenseStatus<-LicenseStatus@./types.js',
    'reexport:type:LifecycleStatus<-LifecycleStatus@./types.js',
    'reexport:type:MappingResolution<-MappingResolution@./types.js',
    'reexport:type:MappingStatus<-MappingStatus@./types.js',
    'reexport:type:ReleaseValidationResult<-ReleaseValidationResult@./types.js',
    'reexport:type:SourceReference<-SourceReference@./types.js',
    'reexport:type:SourceSnapshot<-SourceSnapshot@./types.js',
    'reexport:type:SourceTier<-SourceTier@./types.js',
    'reexport:type:SyntheticEvidence<-SyntheticEvidence@./types.js',
    'reexport:type:ValidatedCatalogIndex<-ValidatedCatalogIndex@./types.js',
    'reexport:type:ValidationIssue<-ValidationIssue@./types.js',
    'reexport:type:ValidationIssueCode<-ValidationIssueCode@./types.js',
    'reexport:type:ValidationResult<-ValidationResult@./types.js',
    'reexport:type:WithdrawalState<-WithdrawalState@./types.js',
    'reexport:value:canonicalJson<-canonicalJson@./canonical.js',
    'reexport:value:canonicalReleaseDigest<-canonicalReleaseDigest@./canonical.js',
    'reexport:value:canonicalReleaseText<-canonicalReleaseText@./canonical.js',
    'reexport:value:compareUtf8<-compareUtf8@./canonical.js',
    'reexport:value:datasetKinds<-datasetKinds@./types.js',
    'reexport:value:decodeGovernanceCatalog<-decodeGovernanceCatalog@./decode.js',
    'reexport:value:decodeGovernanceCatalogJson<-decodeGovernanceCatalogJson@./decode.js',
    'reexport:value:decodeGovernanceRelease<-decodeGovernanceRelease@./decode.js',
    'reexport:value:decodeGovernanceReleaseJson<-decodeGovernanceReleaseJson@./decode.js',
    'reexport:value:decodeGovernedReference<-decodeGovernedReference@./decode.js',
    'reexport:value:licenseStatuses<-licenseStatuses@./types.js',
    'reexport:value:lifecycleStatuses<-lifecycleStatuses@./types.js',
    'reexport:value:mappingStatuses<-mappingStatuses@./types.js',
    'reexport:value:resolveGovernedReference<-resolveGovernedReference@./resolution.js',
    'reexport:value:sourceTiers<-sourceTiers@./types.js',
    'reexport:value:validateGovernanceCatalog<-validateGovernanceCatalog@./validation.js',
    'reexport:value:validateGovernanceRelease<-validateGovernanceRelease@./validation.js',
    'reexport:value:withdrawalStates<-withdrawalStates@./types.js'
  ]),
  'resolution.ts': frozenStrings([
    'declaration:value:variable:resolveGovernedReference'
  ]),
  'types.ts': frozenStrings([
    'declaration:type:interface:GovernanceActor',
    'declaration:type:interface:GovernanceAlias',
    'declaration:type:interface:GovernanceCatalog',
    'declaration:type:interface:GovernanceEnvelope',
    'declaration:type:interface:GovernanceRelease',
    'declaration:type:interface:GovernedReference',
    'declaration:type:interface:HardMapping',
    'declaration:type:interface:SourceReference',
    'declaration:type:interface:SourceSnapshot',
    'declaration:type:interface:SyntheticEvidence',
    'declaration:type:interface:ValidatedCatalogIndex',
    'declaration:type:interface:ValidationIssue',
    'declaration:type:type:CatalogValidationResult',
    'declaration:type:type:DatasetKind',
    'declaration:type:type:DecodeResult',
    'declaration:type:type:DecodedGovernanceCatalog',
    'declaration:type:type:DecodedGovernanceRelease',
    'declaration:type:type:JsonPrimitive',
    'declaration:type:type:JsonValue',
    'declaration:type:type:LicenseStatus',
    'declaration:type:type:LifecycleStatus',
    'declaration:type:type:MappingResolution',
    'declaration:type:type:MappingStatus',
    'declaration:type:type:ReleaseValidationResult',
    'declaration:type:type:SourceTier',
    'declaration:type:type:ValidationIssueCode',
    'declaration:type:type:ValidationResult',
    'declaration:type:type:WithdrawalState',
    'declaration:value:variable:datasetKinds',
    'declaration:value:variable:licenseStatuses',
    'declaration:value:variable:lifecycleStatuses',
    'declaration:value:variable:mappingStatuses',
    'declaration:value:variable:sourceTiers',
    'declaration:value:variable:withdrawalStates'
  ]),
  'validation.ts': frozenStrings([
    'declaration:value:variable:validateGovernanceCatalog',
    'declaration:value:variable:validateGovernanceRelease'
  ])
})

export const capabilityReasons = Object.freeze({
  moduleGrammar: 'domain module grammar must remain static, literal, relative-or-audited, and ImportEquals-free',
  capabilitySource: 'domain production source acquires a forbidden capability by declaration identity',
  prototypeChain: 'domain production source cannot acquire capability through constructor or prototype chains',
  computedSensitive: 'domain production source cannot acquire sensitive capability through computed member keys',
  declarationIdentity: 'domain call/new/tagged-template must resolve to an audited declaration identity',
  valueProvenance: 'domain capability values must retain an audited declaration and acquisition provenance',
  reflectiveAcquisition: 'domain source cannot acquire capabilities through reflective lookup or aliases',
  descriptorAcquisition: 'domain property descriptor acquisition and result flow must equal the audited decoder boundary',
  descriptorCallSite: 'domain descriptor call sites must equal the registered declaration-identity structural fingerprints',
  moduleSurface: 'domain module export surfaces must equal the seven-module registered declarations',
  publicSurface: 'domain module export surfaces must equal the seven-module registered declarations',
  compilerInput: 'domain TypeScript compiler inputs and augmentations must equal the seven-module registered manifest',
  libDeclarationIdentity: 'domain audited TypeScript lib symbols must contain canonical fixed-compiler declarations only',
  syntaxDiagnostics: 'domain TypeScript program must have zero syntactic diagnostics',
  optionsDiagnostics: 'domain TypeScript program must have zero options diagnostics',
  semanticDiagnostics: 'domain TypeScript program must have zero semantic diagnostics'
})

const resolvedSymbol = (checker, node) => {
  const symbol = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node)
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
    ts.isPropertyAssignment(parent) && parent.name === node
    /* guard:shorthand-reference-provenance */
}

const nodeIsInTypePosition = (node) => {
  let current = node.parent
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isTypeNode(current)) return true
    current = current.parent
  }
  return false
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

const typescriptLibDeclarationIdentity = (declaration) => {
  const identity = trustedRootInputIdentity(
    declaration.getSourceFile().fileName,
    fixedTypescriptTrust
  )
  return identity === null ? null : `${identity}:${ts.SyntaxKind[declaration.kind]}`
}

const exactTypescriptLibSymbolIdentity = (symbol, expectedName = symbol?.getName()) => {
  if (symbol === undefined || symbol.getName() !== expectedName) return null
  const declarations = symbol.declarations ?? []
  if (declarations.length === 0) return null
  const identities = declarations.map(typescriptLibDeclarationIdentity)
  /* guard:canonical-lib-all-declarations */
  if (identities.some((identity) => identity === null)) return null
  return `${expectedName}|${identities.sort().join(',')}`
}

export const collectTypescriptLibSymbolIdentityFailures = (symbol, expectedName) =>
  exactTypescriptLibSymbolIdentity(symbol, expectedName) === null
    ? [capabilityReasons.libDeclarationIdentity]
    : []

const symbolHasAuditedLibDeclaration = (symbol, allowedNames) =>
  symbol !== undefined && allowedNames.has(symbol.getName()) &&
  exactTypescriptLibSymbolIdentity(symbol) !== null

const symbolHasTypescriptLibDeclaration = (symbol) =>
  exactTypescriptLibSymbolIdentity(symbol) !== null

const assertionChangesValueProvenance = (node, checker) => {
  if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return false
  if (node.type.getText() === 'const') return false
  const source = checker.getTypeAtLocation(node.expression)
  const target = checker.getTypeAtLocation(node)
  if (
    (source.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
    (target.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  ) return true
  return !checker.isTypeAssignableTo(source, target) &&
    !checker.isTypeAssignableTo(target, source)
}

const nodeContainsTypeErasure = (node, checker) => {
  let found = false
  const visit = (child) => {
    if (assertionChangesValueProvenance(child, checker)) found = true
    if (!found) ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

const expressionHasTypeErasedProvenance = (expression, checker, seen = new Set()) => {
  const current = unwrapExpression(expression)
  if (current === undefined) return false
  if (nodeContainsTypeErasure(expression, checker)) return true
  if (!ts.isIdentifier(current)) return false
  const symbol = resolvedSymbol(checker, current)
  if (symbol === undefined || seen.has(symbol)) return false
  seen.add(symbol)
  return symbol.declarations?.some((declaration) =>
    ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined &&
    expressionHasTypeErasedProvenance(declaration.initializer, checker, seen)
  ) === true
}

const callUsesTypeErasedReceiver = (node, checker) => {
  const expression = unwrapExpression(node.expression)
  if (expression === undefined) return false
  return (
    ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
  ) && expressionHasTypeErasedProvenance(expression.expression, checker)
}

const symbolHasTypescriptLibName = (symbol, expectedName) =>
  exactTypescriptLibSymbolIdentity(symbol, expectedName) !== null

const expressionOriginatesFromLibNamespace = (
  expression,
  checker,
  expectedName,
  seen = new Set()
) => {
  const current = unwrapExpression(expression)
  if (current === undefined || !ts.isIdentifier(current)) return false
  const symbol = resolvedSymbol(checker, current)
  if (symbol === undefined || seen.has(symbol)) return false
  if (symbolHasTypescriptLibName(symbol, expectedName)) return true
  seen.add(symbol)
  return symbol.declarations?.some((declaration) =>
    ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined &&
    expressionOriginatesFromLibNamespace(
      declaration.initializer,
      checker,
      expectedName,
      seen
    )
  ) === true
}

const expressionOriginatesFromLibMember = (
  expression,
  checker,
  namespaceName,
  memberName,
  seen = new Set()
) => {
  const current = unwrapExpression(expression)
  if (current === undefined) return false
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const key = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : constantString(current.argumentExpression, checker)
    return key === memberName && expressionOriginatesFromLibNamespace(
      current.expression,
      checker,
      namespaceName
    )
  }
  if (!ts.isIdentifier(current)) return false
  const symbol = resolvedSymbol(checker, current)
  if (symbol === undefined || seen.has(symbol)) return false
  seen.add(symbol)
  return symbol.declarations?.some((declaration) => {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      return expressionOriginatesFromLibMember(
        declaration.initializer,
        checker,
        namespaceName,
        memberName,
        seen
      )
    }
    if (!ts.isBindingElement(declaration)) return false
    const property = declaration.propertyName ?? declaration.name
    const key = ts.isIdentifier(property) || ts.isStringLiteralLike(property)
      ? property.text
      : ts.isComputedPropertyName(property)
        ? constantString(property.expression, checker)
        : null
    const variable = declaration.parent.parent
    return key === memberName && ts.isVariableDeclaration(variable) &&
      variable.initializer !== undefined && expressionOriginatesFromLibNamespace(
        variable.initializer,
        checker,
        namespaceName
      )
  }) === true
}

const isReflectiveValueLookup = (node, checker) =>
  expressionOriginatesFromLibMember(node.expression, checker, 'Reflect', 'get')

const nearestFunctionLike = (node) => {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) return current
    current = current.parent
  }
  return null
}

export const registeredDescriptorCallSites = frozenStrings([
  'canonical.ts|owner=FirstStatement@7/VariableDeclarationList@0/VariableDeclaration@0|ArrowFunction|params=2|call=Block@4/TryStatement@7/Block@0/IfStatement@0/Block@1/FirstStatement@2/VariableDeclarationList@0/VariableDeclaration@0/CallExpression@1',
  'canonical.ts|owner=FirstStatement@7/VariableDeclarationList@0/VariableDeclaration@0|ArrowFunction|params=2|call=Block@4/TryStatement@7/Block@0/IfStatement@0/Block@1/ForStatement@7/Block@3/FirstStatement@0/VariableDeclarationList@0/VariableDeclaration@0/CallExpression@1',
  'canonical.ts|owner=FirstStatement@7/VariableDeclarationList@0/VariableDeclaration@0|ArrowFunction|params=2|call=Block@4/TryStatement@7/Block@0/ForOfStatement@8/Block@2/FirstStatement@1/VariableDeclarationList@0/VariableDeclaration@0/CallExpression@1',
  'decode.ts|owner=FirstStatement@11/VariableDeclarationList@0/VariableDeclaration@0|ArrowFunction|params=4|call=Block@6/ForOfStatement@7/Block@2/FirstStatement@2/VariableDeclarationList@0/VariableDeclaration@0/CallExpression@1',
  'decode.ts|owner=FirstStatement@12/VariableDeclarationList@0/VariableDeclaration@0|ArrowFunction|params=3|call=Block@6/FirstStatement@3/VariableDeclarationList@0/VariableDeclaration@0/CallExpression@1',
  'decode.ts|owner=FirstStatement@12/VariableDeclarationList@0/VariableDeclaration@0|ArrowFunction|params=3|call=Block@6/ForStatement@9/Block@3/FirstStatement@0/VariableDeclarationList@0/VariableDeclaration@0/CallExpression@1',
  'decode.ts|owner=FirstStatement@13/VariableDeclarationList@0/VariableDeclaration@0|ArrowFunction|params=3|call=Block@5/TryStatement@7/Block@0/ForOfStatement@4/Block@2/FirstStatement@2/VariableDeclarationList@0/VariableDeclaration@0/CallExpression@1'
])

const registeredDescriptorCallee =
  'Object|typescript@5.9.3:lib.es5.d.ts:InterfaceDeclaration,typescript@5.9.3:lib.es5.d.ts:VariableDeclaration/getOwnPropertyDescriptor|typescript@5.9.3:lib.es5.d.ts:MethodSignature'

const registeredDescriptorSiteBindings = Object.freeze([
  Object.freeze({
    site: registeredDescriptorCallSites[0],
    callee: registeredDescriptorCallee,
    receiver: 'parameter:0',
    key: 'local:VariableDeclaration@242.4/259.7/242.0/251.8/262.0/261.0<-for-of(local:VariableDeclaration@242.4/259.7/242.0/244.5/262.0/261.0<-assert:ArrayType(local:VariableDeclaration@242.4/259.7/242.0/244.3/262.0/261.0<-call:lib:ownKeys(parameter:0)))',
  }),
  Object.freeze({
    site: registeredDescriptorCallSites[1],
    callee: registeredDescriptorCallee,
    receiver: 'parameter:0',
    key: 'string:"length"',
  }),
  Object.freeze({
    site: registeredDescriptorCallSites[2],
    callee: registeredDescriptorCallee,
    receiver: 'parameter:0',
    key: 'call:lib:String(local:VariableDeclaration@242.4/259.7/242.0/246.0/242.1/249.7/262.0/261.0<-number:0)',
  }),
  Object.freeze({
    site: registeredDescriptorCallSites[3],
    callee: registeredDescriptorCallee,
    receiver: 'local:VariableDeclaration@242.6/244.1/262.0/261.0<-assert:ObjectKeyword(parameter:0)',
    key: 'local:VariableDeclaration@242.6/251.7/242.2/244.1/262.0/261.0<-assert:StringKeyword(local:VariableDeclaration@242.6/251.7/262.0/261.0<-for-of(local:VariableDeclaration@242.6/244.5/262.0/261.0<-call:lib:ownKeys(local:VariableDeclaration@242.6/244.1/262.0/261.0<-assert:ObjectKeyword(parameter:0))))',
  }),
  Object.freeze({
    site: registeredDescriptorCallSites[4],
    callee: registeredDescriptorCallee,
    receiver: 'local:VariableDeclaration@242.6/244.1/262.0/261.0<-assert:ArrayType(parameter:0)',
    key: 'string:"length"',
  }),
  Object.freeze({
    site: registeredDescriptorCallSites[5],
    callee: registeredDescriptorCallee,
    receiver: 'local:VariableDeclaration@242.6/244.1/262.0/261.0<-assert:ArrayType(parameter:0)',
    key: 'call:lib:String(local:VariableDeclaration@242.6/249.9/262.0/261.0<-number:0)',
  }),
  Object.freeze({
    site: registeredDescriptorCallSites[6],
    callee: registeredDescriptorCallee,
    receiver: 'local:VariableDeclaration@242.5/244.4/262.0/261.0<-assert:ObjectKeyword(parameter:0)',
    key: 'local:VariableDeclaration@242.5/259.7/242.0/251.4/242.2/244.1/262.0/261.0<-assert:StringKeyword(local:VariableDeclaration@242.5/259.7/242.0/251.4/262.0/261.0<-for-of(call:lib:ownKeys(local:VariableDeclaration@242.5/244.4/262.0/261.0<-assert:ObjectKeyword(parameter:0))))',
  })
])

const descriptorOwnerIdentity = (site) => site.slice(0, site.indexOf('|call='))

export const registeredDescriptorOwnerFingerprints = Object.freeze({
  [descriptorOwnerIdentity(registeredDescriptorCallSites[0])]:
    'sha256:22dc56048d1e23c1eec4ca397adcea6306f51c1c024449583fc17da7c189cdad',
  [descriptorOwnerIdentity(registeredDescriptorCallSites[3])]:
    'sha256:4f61f378f3e3d3ab12bad5b3c4401723d4daeea4a8265a7cf25f63a6c26e7d08',
  [descriptorOwnerIdentity(registeredDescriptorCallSites[4])]:
    'sha256:3ca5d995e764c3ac88d320409a829f24f6dcb973a2ba9f80877d90d3120c10ac',
  [descriptorOwnerIdentity(registeredDescriptorCallSites[6])]:
    'sha256:e15ae61aeee037ef3810b6aeacb6f013c1d95918b344cb31571c9c5158be3216'
})

export const registeredDescriptorSiteContracts = Object.freeze(
  registeredDescriptorSiteBindings.map((binding) => Object.freeze({
    site: binding.site,
    callee: binding.callee,
    receiver: binding.receiver,
    key: binding.key,
    ownerFingerprint: registeredDescriptorOwnerFingerprints[
      descriptorOwnerIdentity(binding.site)
    ]
  }))
)

const directChildren = (node) => {
  const children = []
  node.forEachChild((child) => { children.push(child) })
  return children
}

const structuralNodePath = (owner, node) => {
  const parts = []
  let current = node
  while (current !== owner) {
    const parent = current.parent
    if (parent === undefined) return null
    const siblings = directChildren(parent)
    const index = siblings.indexOf(current)
    if (index < 0) return null
    parts.unshift(`${ts.SyntaxKind[current.kind]}@${index}`)
    current = parent
  }
  return parts.join('/')
}

const structuralContractPath = (owner, node) => {
  const parts = []
  let current = node
  while (current !== owner) {
    const parent = current.parent
    if (parent === undefined) return null
    const siblings = directChildren(parent)
    const index = siblings.indexOf(current)
    if (index < 0) return null
    parts.unshift(`${current.kind}.${index}`)
    current = parent
  }
  return parts.join('/')
}

const functionOwnerDeclaration = (owner) => {
  let declaration
  let name
  if (ts.isFunctionDeclaration(owner) && owner.name !== undefined) {
    declaration = owner
    name = owner.name
  } else if (
    (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
    ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)
  ) {
    declaration = owner.parent
    name = owner.parent.name
  } else {
    return null
  }
  return { declaration, name }
}

const functionDeclarationIdentityIsExact = (owner, checker) => {
  const identity = functionOwnerDeclaration(owner)
  if (identity === null) return false
  const { declaration, name } = identity
  const symbol = resolvedSymbol(checker, name)
  return symbol !== undefined && symbol.declarations?.length === 1 &&
    symbol.declarations[0] === declaration
}

const descriptorCallSiteFingerprint = (node, checker, sourceRoot) => {
  const owner = nearestFunctionLike(node)
  if (owner === null || !functionDeclarationIdentityIsExact(owner, checker)) return null
  const ownerIdentity = functionOwnerDeclaration(owner)
  if (ownerIdentity === null) return null
  const file = relativeSourcePath(sourceRoot, owner.getSourceFile().fileName)
  const ownerPath = structuralNodePath(owner.getSourceFile(), ownerIdentity.declaration)
  const callPath = structuralNodePath(owner, node)
  if (file === null || ownerPath === null || callPath === null) return null
  return `${file}|owner=${ownerPath}|${ts.SyntaxKind[owner.kind]}|params=${owner.parameters.length}|call=${callPath}`
}

const declarationInside = (declaration, owner) =>
  declaration.getSourceFile() === owner.getSourceFile() &&
  declaration.pos >= owner.pos && declaration.end <= owner.end

const exactSingleDeclaration = (symbol) => {
  const declarations = symbol?.declarations ?? []
  return declarations.length === 1 ? declarations[0] : null
}

const declarationPathContract = (owner, declaration) => {
  const path = structuralContractPath(owner, declaration)
  return path === null ? null : `${ts.SyntaxKind[declaration.kind]}@${path}`
}

const sourceDeclarationIdentity = (symbol, sourceRoot) => {
  if (symbol === undefined) return null
  const libIdentity = exactTypescriptLibSymbolIdentity(symbol)
  if (libIdentity !== null) return `lib:${symbol.getName()}`
  const declarations = symbol.declarations ?? []
  if (declarations.length === 0) return null
  const identities = declarations.map((declaration) => {
    const file = relativeSourcePath(sourceRoot, declaration.getSourceFile().fileName)
    const path = structuralContractPath(declaration.getSourceFile(), declaration)
    return file === null || path === null
      ? null
      : `local:${file}:${ts.SyntaxKind[declaration.kind]}@${path}`
  })
  return identities.some((identity) => identity === null)
    ? null
    : identities.sort().join(',')
}

const fingerprintSymbolIdentity = (symbol, sourceRoot) => {
  if (symbol === undefined) return null
  const typescriptIdentity = exactTypescriptLibSymbolIdentity(symbol)
  if (typescriptIdentity !== null) return `typescript:${typescriptIdentity}`
  const nobleIdentity = exactAuditedNobleSymbolIdentity(
    symbol,
    resolve(sourceRoot, '../../..')
  )
  if (nobleIdentity !== null) return `dependency:${nobleIdentity}`
  const declarations = symbol.declarations ?? []
  if (declarations.length === 0) {
    return `transient:${symbol.flags}:${symbol.getName()}`
  }
  const identities = declarations.map((declaration) => {
    const file = relativeSourcePath(sourceRoot, declaration.getSourceFile().fileName)
    const path = structuralContractPath(declaration.getSourceFile(), declaration)
    return file === null || path === null
      ? null
      : `local:${file}:${ts.SyntaxKind[declaration.kind]}@${path}`
  })
  return identities.some((identity) => identity === null)
    ? null
    : identities.sort().join(',')
}

const callableSymbolNode = (expression) => {
  const current = unwrapExpression(expression)
  if (current === undefined) return null
  if (ts.isPropertyAccessExpression(current)) return current.name
  if (ts.isElementAccessExpression(current)) return current.argumentExpression
  return current
}

const ownerAstShape = (node, sourceFile) => {
  const children = directChildren(node)
  return [
    node.kind,
    children.length === 0 ? node.getText(sourceFile) : null,
    children.map((child) => ownerAstShape(child, sourceFile))
  ]
}

const ownerPrinter = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed
})

const descriptorOwnerFingerprint = (owner, checker, sourceRoot) => {
  const sourceFile = owner.getSourceFile()
  const ownerIdentity = functionOwnerDeclaration(owner)
  if (ownerIdentity === null || !functionDeclarationIdentityIsExact(owner, checker)) return null
  const declarationPath = structuralNodePath(sourceFile, ownerIdentity.declaration)
  if (declarationPath === null) return null
  const resolvedIdentities = []
  let valid = true
  const visit = (node) => {
    if (!valid) return
    if (ts.isIdentifier(node)) {
      const symbol = resolvedSymbol(checker, node)
      if (symbol !== undefined) {
        const identity = fingerprintSymbolIdentity(symbol, sourceRoot)
        const path = structuralContractPath(owner, node)
        if (path === null) {
          valid = false
          return
        }
        resolvedIdentities.push(
          `identifier:${path}:${identity ?? `guarded-unresolved:${symbol.flags}`}`
        )
      }
    }
    if (
      ts.isCallExpression(node) || ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node)
    ) {
      const expression = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression
      const symbolNode = callableSymbolNode(expression)
      const identity = symbolNode === null
        ? null
        : fingerprintSymbolIdentity(resolvedSymbol(checker, symbolNode), sourceRoot)
      const path = structuralContractPath(owner, node)
      if (identity === null || path === null) {
        valid = false
        return
      }
      resolvedIdentities.push(`callable:${path}:${identity}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(owner)
  if (!valid) return null
  const material = JSON.stringify({
    version: 1,
    owner: `${ts.SyntaxKind[owner.kind]}@${declarationPath}`,
    syntax: ownerPrinter.printNode(ts.EmitHint.Unspecified, owner, sourceFile),
    shape: ownerAstShape(owner, sourceFile),
    identities: resolvedIdentities.sort()
  })
  return `sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`
}

const expressionProvenanceContract = (
  expression,
  owner,
  checker,
  sourceRoot,
  seen = new Set()
) => {
  if (ts.isParenthesizedExpression(expression)) {
    const child = expressionProvenanceContract(expression.expression, owner, checker, sourceRoot, seen)
    return child === null ? null : `paren(${child})`
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    const child = expressionProvenanceContract(expression.expression, owner, checker, sourceRoot, seen)
    return child === null ? null : `assert:${ts.SyntaxKind[expression.type.kind]}(${child})`
  }
  if (ts.isSatisfiesExpression(expression)) {
    const child = expressionProvenanceContract(expression.expression, owner, checker, sourceRoot, seen)
    return child === null ? null : `satisfies:${ts.SyntaxKind[expression.type.kind]}(${child})`
  }
  if (ts.isNonNullExpression(expression)) {
    const child = expressionProvenanceContract(expression.expression, owner, checker, sourceRoot, seen)
    return child === null ? null : `non-null(${child})`
  }
  if (ts.isStringLiteralLike(expression)) return `string:${JSON.stringify(expression.text)}`
  if (ts.isNumericLiteral(expression)) return `number:${expression.text}`
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return 'boolean:true'
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return 'boolean:false'
  if (ts.isIdentifier(expression)) {
    const symbol = resolvedSymbol(checker, expression)
    if (symbol === undefined || seen.has(symbol)) return null
    const libIdentity = exactTypescriptLibSymbolIdentity(symbol)
    if (libIdentity !== null) return `lib:${libIdentity}`
    const declaration = exactSingleDeclaration(symbol)
    if (declaration === null || !declarationInside(declaration, owner)) return null
    if (ts.isParameter(declaration) && declaration.parent === owner) {
      const index = owner.parameters.indexOf(declaration)
      return index < 0 ? null : `parameter:${index}`
    }
    if (!ts.isVariableDeclaration(declaration)) return null
    const path = declarationPathContract(owner, declaration)
    if (path === null) return null
    seen.add(symbol)
    let origin = null
    if (declaration.initializer !== undefined) {
      origin = expressionProvenanceContract(
        declaration.initializer,
        owner,
        checker,
        sourceRoot,
        seen
      )
    } else if (
      ts.isVariableDeclarationList(declaration.parent) &&
      ts.isForOfStatement(declaration.parent.parent)
    ) {
      origin = expressionProvenanceContract(
        declaration.parent.parent.expression,
        owner,
        checker,
        sourceRoot,
        seen
      )
      if (origin !== null) origin = `for-of(${origin})`
    }
    seen.delete(symbol)
    return origin === null ? null : `local:${path}<-${origin}`
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const receiver = expressionProvenanceContract(
      expression.expression,
      owner,
      checker,
      sourceRoot,
      seen
    )
    const key = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : constantString(expression.argumentExpression, checker)
    const symbolNode = ts.isPropertyAccessExpression(expression)
      ? expression.name
      : expression.argumentExpression
    const identity = sourceDeclarationIdentity(resolvedSymbol(checker, symbolNode), sourceRoot)
    return receiver === null || key === null || identity === null
      ? null
      : `member:${JSON.stringify(key)}:${identity}(${receiver})`
  }
  if (ts.isCallExpression(expression)) {
    const callee = sourceDeclarationIdentity(
      resolvedSymbol(
        checker,
        ts.isPropertyAccessExpression(unwrapExpression(expression.expression))
          ? unwrapExpression(expression.expression).name
          : ts.isElementAccessExpression(unwrapExpression(expression.expression))
            ? unwrapExpression(expression.expression).argumentExpression
            : unwrapExpression(expression.expression)
      ),
      sourceRoot
    )
    const args = expression.arguments.map((argument) =>
      expressionProvenanceContract(argument, owner, checker, sourceRoot, new Set(seen))
    )
    return callee === null || args.some((argument) => argument === null)
      ? null
      : `call:${callee}(${args.join(',')})`
  }
  return null
}

const outerExpression = (node) => {
  let current = node
  while (
    ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent)
  ) current = current.parent
  return current
}

const isDescriptorAcquisition = (node, checker) =>
  expressionOriginatesFromLibMember(
    node.expression,
    checker,
    'Object',
    'getOwnPropertyDescriptor'
  ) || expressionOriginatesFromLibMember(
    node.expression,
    checker,
    'Reflect',
    'getOwnPropertyDescriptor'
  )

const descriptorSiteContract = (node, checker, sourceRoot) => {
  const fingerprint = descriptorCallSiteFingerprint(node, checker, sourceRoot)
  if (fingerprint === null) return null
  const expression = unwrapExpression(node.expression)
  if (
    !ts.isPropertyAccessExpression(expression) || expression.name.text !== 'getOwnPropertyDescriptor' ||
    !ts.isIdentifier(expression.expression) ||
    !symbolHasTypescriptLibName(resolvedSymbol(checker, expression.expression), 'Object') ||
    !symbolHasTypescriptLibName(resolvedSymbol(checker, expression.name), 'getOwnPropertyDescriptor') ||
    node.arguments.length !== 2
  ) return null
  const owner = nearestFunctionLike(node)
  if (owner === null) return null
  const declaration = node.parent
  if (
    !ts.isVariableDeclaration(declaration) || declaration.initializer !== node ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) return null
  const namespaceIdentity = exactTypescriptLibSymbolIdentity(
    resolvedSymbol(checker, expression.expression),
    'Object'
  )
  const memberIdentity = exactTypescriptLibSymbolIdentity(
    resolvedSymbol(checker, expression.name),
    'getOwnPropertyDescriptor'
  )
  const receiver = expressionProvenanceContract(
    node.arguments[0], owner, checker, sourceRoot
  )
  const key = expressionProvenanceContract(node.arguments[1], owner, checker, sourceRoot)
  const ownerFingerprint = descriptorOwnerFingerprint(owner, checker, sourceRoot)
  if (
    namespaceIdentity === null || memberIdentity === null || receiver === null || key === null ||
    ownerFingerprint === null
  ) return null
  return Object.freeze({
    site: fingerprint,
    callee: `${namespaceIdentity}/${memberIdentity}`,
    receiver,
    key,
    ownerFingerprint
  })
}

const isAuditedDescriptorAcquisition = (node, checker, sourceRoot) => {
  const observed = descriptorSiteContract(node, checker, sourceRoot)
  if (observed === null) return false
  const expected = registeredDescriptorSiteContracts.find(({ site }) => site === observed.site)
  if (expected === undefined || observed.callee !== expected.callee) return false
  /* guard:descriptor-receiver-contract */
  if (observed.receiver !== expected.receiver) return false
  /* guard:descriptor-key-contract */
  if (observed.key !== expected.key) return false
  /* guard:descriptor-owner-contract */
  if (observed.ownerFingerprint !== expected.ownerFingerprint) return false
  return true
}

const memberKey = (node, checker) => ts.isPropertyAccessExpression(node)
  ? node.name.text
  : ts.isElementAccessExpression(node)
    ? constantString(node.argumentExpression, checker)
    : null

const memberIsDirectCallCallee = (node) => {
  const expression = outerExpression(node)
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression
}

const directLibMemberIdentity = (node, checker, namespaceName, memberName) => {
  const current = unwrapExpression(node)
  if (
    current === undefined ||
    (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) ||
    memberKey(current, checker) !== memberName ||
    !expressionOriginatesFromLibNamespace(current.expression, checker, namespaceName)
  ) return false
  const symbolNode = ts.isPropertyAccessExpression(current)
    ? current.name
    : current.argumentExpression
  return symbolHasTypescriptLibName(resolvedSymbol(checker, symbolNode), memberName)
}

const directDescriptorCallIdentity = (node, checker) => {
  if (!ts.isCallExpression(node)) return false
  const expression = unwrapExpression(node.expression)
  if (
    expression === undefined || !ts.isPropertyAccessExpression(expression) ||
    !ts.isIdentifier(expression.expression) || expression.name.text !== 'getOwnPropertyDescriptor'
  ) return false
  const namespace = resolvedSymbol(checker, expression.expression)
  return (
    symbolHasTypescriptLibName(namespace, 'Object') ||
    symbolHasTypescriptLibName(namespace, 'Reflect')
  ) && symbolHasTypescriptLibName(
    resolvedSymbol(checker, expression.name),
    'getOwnPropertyDescriptor'
  )
}

const bindingElementSource = (node) => {
  if (!ts.isBindingElement(node) || !ts.isObjectBindingPattern(node.parent)) return null
  const declaration = node.parent.parent
  return ts.isVariableDeclaration(declaration) ? declaration.initializer ?? null : null
}

const bindingElementKey = (node, checker) => {
  if (!ts.isBindingElement(node)) return null
  const property = node.propertyName ?? node.name
  if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) return property.text
  return ts.isComputedPropertyName(property) ? constantString(property.expression, checker) : null
}

const reflectNamespaceReferenceIsAudited = (node, checker) => {
  const reference = outerExpression(node)
  const parent = reference.parent
  if (
    (!ts.isPropertyAccessExpression(parent) && !ts.isElementAccessExpression(parent)) ||
    parent.expression !== reference
  ) return false
  const key = memberKey(parent, checker)
  if (key === 'get' || key === 'getOwnPropertyDescriptor') return true
  return key === 'ownKeys' && memberIsDirectCallCallee(parent) &&
    directLibMemberIdentity(parent, checker, 'Reflect', 'ownKeys')
}

const referenceAcquisitionFailures = (node, checker, sourceRoot) => {
  const reasons = []
  if (nodeIsInTypePosition(node)) return reasons
  if (
    ts.isIdentifier(node) && !isNonReferenceIdentifier(node) &&
    expressionOriginatesFromLibNamespace(node, checker, 'Reflect') &&
    !reflectNamespaceReferenceIsAudited(node, checker)
  ) reasons.push(capabilityReasons.reflectiveAcquisition)

  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    if (expressionOriginatesFromLibMember(node, checker, 'Reflect', 'get')) {
      reasons.push(capabilityReasons.reflectiveAcquisition)
    }
    if (
      expressionOriginatesFromLibMember(node, checker, 'Object', 'getOwnPropertyDescriptor') ||
      expressionOriginatesFromLibMember(node, checker, 'Reflect', 'getOwnPropertyDescriptor')
    ) {
      const call = memberIsDirectCallCallee(node) ? outerExpression(node).parent : null
      if (
        call === null || !ts.isCallExpression(call) ||
        (!isAuditedDescriptorAcquisition(call, checker, sourceRoot) &&
          directDescriptorCallIdentity(call, checker) === false)
      ) reasons.push(capabilityReasons.descriptorAcquisition)
    }
  }

  if (ts.isBindingElement(node)) {
    const source = bindingElementSource(node)
    const key = bindingElementKey(node, checker)
    if (source !== null && key === 'get' &&
      expressionOriginatesFromLibNamespace(source, checker, 'Reflect')) {
      reasons.push(capabilityReasons.reflectiveAcquisition)
    }
    if (
      source !== null && key === 'getOwnPropertyDescriptor' &&
      (expressionOriginatesFromLibNamespace(source, checker, 'Object') ||
        expressionOriginatesFromLibNamespace(source, checker, 'Reflect'))
    ) reasons.push(capabilityReasons.descriptorAcquisition)
  }
  return reasons
}

const exportModifiers = (node) => ({
  exported: node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true,
  defaulted: node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true
})

const moduleExportSurface = (tree) => {
  const surface = []
  for (const statement of tree.statements) {
    const modifiers = exportModifiers(statement)
    if (modifiers.exported) {
      const prefix = modifiers.defaulted ? 'declaration:default' : 'declaration'
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          surface.push(`${prefix}:value:variable:${declaration.name.getText()}`)
        }
      } else if (ts.isFunctionDeclaration(statement)) {
        surface.push(`${prefix}:value:function:${statement.name?.text ?? '<anonymous>'}`)
      } else if (ts.isClassDeclaration(statement)) {
        surface.push(`${prefix}:both:class:${statement.name?.text ?? '<anonymous>'}`)
      } else if (ts.isEnumDeclaration(statement)) {
        surface.push(`${prefix}:both:enum:${statement.name.text}`)
      } else if (ts.isInterfaceDeclaration(statement)) {
        surface.push(`${prefix}:type:interface:${statement.name.text}`)
      } else if (ts.isTypeAliasDeclaration(statement)) {
        surface.push(`${prefix}:type:type:${statement.name.text}`)
      } else {
        surface.push(`${prefix}:unsupported:${ts.SyntaxKind[statement.kind]}`)
      }
    }
    if (ts.isExportAssignment(statement)) {
      surface.push(statement.isExportEquals ? 'export-assignment:equals' : 'export-assignment:default')
      continue
    }
    if (!ts.isExportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : '<local>'
    if (statement.exportClause === undefined) {
      surface.push(`${statement.isTypeOnly ? 'star:type' : 'star:value'}:${specifier}`)
      continue
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      surface.push(`${statement.isTypeOnly ? 'namespace:type' : 'namespace:value'}:${statement.exportClause.name.text}@${specifier}`)
      continue
    }
    for (const element of statement.exportClause.elements) {
      const family = statement.moduleSpecifier === undefined ? 'alias' : 'reexport'
      const kind = statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value'
      surface.push(`${family}:${kind}:${element.name.text}<-${element.propertyName?.text ?? element.name.text}@${specifier}`)
    }
  }
  return surface.sort()
}

const registeredModuleSurfaceMatches = (file, tree) =>
  JSON.stringify(moduleExportSurface(tree)) ===
  JSON.stringify(registeredModuleExportSurfaces[file] ?? null)

const exactAuditedNobleSymbolIdentity = (symbol, root) => {
  if (symbol === undefined || !auditedNobleCalls.has(symbol.getName())) return null
  const declarations = symbol.declarations ?? []
  if (declarations.length === 0) return null
  const trust = auditedDependencyTrust(root)
  const identities = declarations.map((declaration) => {
    const identity = trustedRootInputIdentity(declaration.getSourceFile().fileName, trust)
    return identity === null ? null : `${identity}:${ts.SyntaxKind[declaration.kind]}`
  })
  return identities.some((identity) => identity === null)
    ? null
    : `${symbol.getName()}|${identities.sort().join(',')}`
}

const symbolHasAuditedNobleDeclaration = (symbol, root) =>
  exactAuditedNobleSymbolIdentity(symbol, root) !== null

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
  if (symbolHasAuditedNobleDeclaration(symbol, resolve(sourceRoot, '../../..'))) return true
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
  options: domainCompilerOptions
})

export const inspectDescriptorSiteContracts = (root = repositoryRoot) => {
  const sourceRoot = resolve(root, 'packages/domain/src')
  const program = programForDomainSources(root, manifests.sources)
  const checker = program.getTypeChecker()
  const contracts = []
  for (const file of manifests.sources) {
    const tree = program.getSourceFile(resolve(sourceRoot, file))
    if (tree === undefined) continue
    const visit = (node) => {
      if (ts.isCallExpression(node) && directDescriptorCallIdentity(node, checker)) {
        const contract = descriptorSiteContract(node, checker, sourceRoot)
        if (contract !== null) contracts.push(contract)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return contracts.sort((left, right) => left.site < right.site ? -1 : left.site > right.site ? 1 : 0)
}

export const registeredProgramInputManifest = Object.freeze({
  repository: frozenStrings(
    manifests.sources.map((file) => `repository:packages/domain/src/${file}`)
  ),
  typescriptLib: frozenStrings(
    registeredTypescriptLibInputs.map((file) =>
      `typescript@${registeredTypescriptVersion}:${file}`)
  ),
  auditedDependency: frozenStrings(
    registeredAuditedDependencyInputs[`@noble/hashes@${registeredNobleHashesVersion}`]
      .map((file) => `@noble/hashes@${registeredNobleHashesVersion}:${file}`)
  )
})

const registeredRepositoryInputIdentity = (root, fileName, sourceFiles) => {
  const lexical = resolve(fileName)
  const canonical = safeRealpath(lexical)
  if (canonical === null) return null
  for (const file of sourceFiles) {
    const expectedLexical = resolve(root, 'packages/domain/src', file)
    const expectedCanonical = safeRealpath(expectedLexical)
    if (
      expectedCanonical !== null && lexical === expectedLexical && canonical === expectedCanonical
    ) return `repository:packages/domain/src/${file}`
  }
  return null
}

const compilerInputIdentity = (root, tree, sourceFiles) => {
  /* Ownership is computed before any external trust-root classification. */
  const ownership = repositoryInputOwnership(root, tree.fileName)
  const repositoryIdentity = registeredRepositoryInputIdentity(root, tree.fileName, sourceFiles)
  if (repositoryIdentity !== null) return repositoryIdentity

  const typescriptIdentity = trustedRootInputIdentity(tree.fileName, fixedTypescriptTrust)
  if (typescriptIdentity !== null) return typescriptIdentity
  const dependencyIdentity = trustedRootInputIdentity(
    tree.fileName,
    auditedDependencyTrust(root)
  )
  if (dependencyIdentity !== null) return dependencyIdentity

  if (ownership.lexicalOwned || ownership.canonicalOwned) return null
  return null
}

const registeredProgramInputIdentities = (sourceFiles) => frozenStrings([
  ...sourceFiles.map((file) => `repository:packages/domain/src/${file}`),
  ...registeredProgramInputManifest.typescriptLib,
  ...registeredProgramInputManifest.auditedDependency
])

const inspectProgramInputs = (root, program, sourceFiles) => {
  const identities = program.getSourceFiles().map((tree) =>
    compilerInputIdentity(root, tree, sourceFiles)
  )
  const counts = {
    repository: identities.filter((identity) => identity?.startsWith('repository:')).length,
    typescriptLib: identities.filter((identity) => identity?.startsWith('typescript@')).length,
    auditedDependency: identities.filter((identity) => identity?.startsWith('@noble/hashes@')).length,
    rejected: identities.filter((identity) => identity === null).length
  }
  const expected = registeredProgramInputIdentities(sourceFiles)
  const observed = identities.every((identity) => identity !== null)
    ? frozenStrings(identities)
    : Object.freeze([])
  return Object.freeze({
    counts: Object.freeze(counts),
    exact: identities.every((identity) => identity !== null) &&
      JSON.stringify(observed) === JSON.stringify(expected)
  })
}

export const programInputTrustStats = (root = repositoryRoot) => {
  const program = programForDomainSources(root, manifests.sources)
  return inspectProgramInputs(root, program, manifests.sources)
}

const compilerInputsEqualRegisteredManifest = (root, program, sourceFiles) =>
  inspectProgramInputs(root, program, sourceFiles).exact

const treeContainsDeclarationAugmentation = (tree) => {
  let found = false
  const visit = (node) => {
    if (ts.isModuleDeclaration(node)) found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

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
const recordValueProvenanceFailure = (failures) => {
  /* guard:value-provenance */
  failures.push(capabilityReasons.valueProvenance)
}
const recordReflectiveAcquisitionFailure = (failures) => {
  /* guard:reflective-acquisition */
  failures.push(capabilityReasons.reflectiveAcquisition)
}
const recordDescriptorAcquisitionFailure = (failures) => {
  /* guard:descriptor-acquisition */
  failures.push(capabilityReasons.descriptorAcquisition)
}
const recordDescriptorCallSiteFailure = (failures) => {
  /* guard:descriptor-call-site */
  failures.push(capabilityReasons.descriptorCallSite)
}
const recordPublicSurfaceFailure = (failures) => {
  /* guard:module-export-surface */
  failures.push(capabilityReasons.moduleSurface)
}
const recordCompilerInputFailure = (failures) => {
  /* guard:compiler-input-manifest */
  failures.push(capabilityReasons.compilerInput)
}
const recordSyntacticDiagnosticsFailure = (failures) => {
  /* guard:syntactic-diagnostics */
  failures.push(capabilityReasons.syntaxDiagnostics)
}
const recordOptionsDiagnosticsFailure = (failures) => {
  /* guard:options-diagnostics */
  failures.push(capabilityReasons.optionsDiagnostics)
}
const recordSemanticDiagnosticsFailure = (failures) => {
  /* guard:semantic-diagnostics */
  failures.push(capabilityReasons.semanticDiagnostics)
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
    const observedDescriptorCallSites = []
    const expectedDescriptorOwners = frozenStrings([
      ...new Set(registeredDescriptorCallSites.map(descriptorOwnerIdentity))
    ])
    if (
      JSON.stringify(Object.keys(registeredDescriptorOwnerFingerprints).sort()) !==
        JSON.stringify(expectedDescriptorOwners) ||
      Object.values(registeredDescriptorOwnerFingerprints).some(
        (value) => !/^sha256:[0-9a-f]{64}$/u.test(value)
      )
    ) recordDescriptorCallSiteFailure(failures)
    /* guard:program-diagnostics */
    try {
      if (program.getSyntacticDiagnostics().length > 0) {
        recordSyntacticDiagnosticsFailure(failures)
      }
    } catch {
      recordSyntacticDiagnosticsFailure(failures)
    }
    try {
      if (program.getOptionsDiagnostics().length > 0) {
        recordOptionsDiagnosticsFailure(failures)
      }
    } catch {
      recordOptionsDiagnosticsFailure(failures)
    }
    try {
      if (program.getSemanticDiagnostics().length > 0) {
        recordSemanticDiagnosticsFailure(failures)
      }
    } catch {
      recordSemanticDiagnosticsFailure(failures)
    }
    if (
      JSON.stringify(Object.keys(registeredModuleExportSurfaces).sort()) !==
      JSON.stringify([...sourceFiles].sort())
    ) recordPublicSurfaceFailure(failures)
    if (!compilerInputsEqualRegisteredManifest(root, program, sourceFiles)) {
      recordCompilerInputFailure(failures)
    }
    for (const file of sourceFiles) {
      const tree = program.getSourceFile(resolve(sourceRoot, file))
      if (tree === undefined) {
        failures.push('domain source must be readable for AST capability analysis')
        continue
      }
    if (!registeredModuleSurfaceMatches(file, tree)) recordPublicSurfaceFailure(failures)
    if (treeContainsDeclarationAugmentation(tree)) recordCompilerInputFailure(failures)
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
          const assignmentTarget = ts.isBinaryExpression(node.parent) &&
            node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            node.parent.left === node
          if (!assignmentTarget && expressionHasTypeErasedProvenance(node.expression, checker)) {
            recordValueProvenanceFailure(failures)
          }
        }
      }
      if (ts.isBindingElement(node)) {
        const property = node.propertyName ?? node.name
        const key = ts.isIdentifier(property) || ts.isStringLiteralLike(property)
          ? property.text
          : ts.isComputedPropertyName(property)
            ? constantString(property.expression, checker)
            : null
        if (
          key === 'constructor' || key === 'prototype' || key === '__proto__' ||
          key === 'caller' || key === 'callee' || key === 'arguments' ||
          key !== null && forbiddenMemberNames.has(key)
        ) recordValueProvenanceFailure(failures)
      }
      if (
        ts.isIdentifier(node) && forbiddenCapabilityNames.has(node.text) &&
        !isNonReferenceIdentifier(node) && !nodeIsInTypePosition(node)
      ) {
        failures.push(capabilityReasons.capabilitySource)
      }
      /* guard:reference-acquisition */
      for (const reason of referenceAcquisitionFailures(node, checker, sourceRoot)) {
        if (reason === capabilityReasons.reflectiveAcquisition) {
          recordReflectiveAcquisitionFailure(failures)
        } else {
          recordDescriptorAcquisitionFailure(failures)
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
        if (isDescriptorAcquisition(node, checker)) {
          if (isAuditedDescriptorAcquisition(node, checker, sourceRoot)) {
            const fingerprint = descriptorCallSiteFingerprint(node, checker, sourceRoot)
            if (fingerprint === null) {
              recordDescriptorCallSiteFailure(failures)
            } else {
              observedDescriptorCallSites.push(fingerprint)
            }
          } else if (directDescriptorCallIdentity(node, checker)) {
            recordDescriptorCallSiteFailure(failures)
          } else {
            recordDescriptorAcquisitionFailure(failures)
          }
        } else if (isReflectiveValueLookup(node, checker)) {
          recordReflectiveAcquisitionFailure(failures)
        } else if (callUsesTypeErasedReceiver(node, checker)) {
          recordValueProvenanceFailure(failures)
        } else if (!callHasAuditedIdentity(node, checker, sourceRoot)) {
          recordDeclarationIdentityFailure(failures)
        }
      }
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
    /* guard:descriptor-call-site-exactness */
    if (
      JSON.stringify(observedDescriptorCallSites.sort()) !==
      JSON.stringify(registeredDescriptorCallSites)
    ) recordDescriptorCallSiteFailure(failures)
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
  unicodeScalar: 1334,
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

const layerPolicy = (ajvRaw, ajvText, decoderRaw, decoderJson, finalValidator) =>
  Object.freeze({ ajvRaw, ajvText, decoderRaw, decoderJson, finalValidator })
const allLayersAccept = layerPolicy(true, true, true, true, true)
const allLayersReject = layerPolicy(false, false, false, false, false)
const schemaRejectsShapeAcceptsFinalRejects = layerPolicy(false, false, true, true, false)

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
export const GOVERNANCE_STRING_CASE_IDS = Object.freeze([
  'root-schema:lone-high',
  'root-schema:empty',
  'root-schema:astral',
  'dataset-id:lone-high',
  'dataset-id:null',
  'dataset-id:astral',
  'release-id:lone-high',
  'release-id:lone-low',
  'release-id:astral',
  'owner-actor-id:lone-high',
  'owner-actor-id:lone-low',
  'owner-actor-id:astral',
  'owner-role:lone-high',
  'owner-role:lone-low',
  'owner-role:astral',
  'source-locator:lone-high',
  'source-locator:lone-low',
  'source-locator:astral',
  'alias-value:lone-high',
  'alias-value:lone-low',
  'alias-value:astral',
  'region-array-item:lone-high',
  'region-array-item:lone-low',
  'region-array-item:astral',
  'language-array-item:lone-high',
  'language-array-item:lone-low',
  'language-array-item:astral',
  'nullable-license-reference:lone-high',
  'nullable-license-reference:lone-low',
  'nullable-license-reference:astral',
  'enum-dataset-kind:invalid-enum',
  'enum-dataset-kind:lone-low',
  'enum-dataset-kind:valid-enum',
  'uuid-entity-id:invalid-uuid',
  'uuid-entity-id:lone-low',
  'uuid-entity-id:valid-uuid',
  'digest-content-digest:invalid-digest',
  'digest-content-digest:lone-low',
  'digest-content-digest:valid-digest',
  'timestamp-reviewed-at:invalid-timestamp',
  'timestamp-reviewed-at:lone-low',
  'timestamp-reviewed-at:valid-timestamp',
  'mapping-id:lone-high',
  'mapping-id:invalid-pattern',
  'mapping-id:valid-family-control',
  'mapping-dataset-id:lone-high',
  'mapping-dataset-id:invalid-pattern',
  'mapping-dataset-id:valid-family-control',
  'mapping-entity-id:lone-high',
  'mapping-entity-id:invalid-uuid',
  'mapping-entity-id:valid-family-control'
])
export const governanceStringCases = (root = repositoryRoot) => {
  const baseText = readFileSync(
    resolve(fixtureRoot(root), 'valid/food-concept.json'),
    'utf8'
  )
  const cases = []
  for (const builder of releaseStringMutationBuilders) {
    const thirdVariant = builder.id === 'root-schema'
      ? { id: 'empty', value: '', expected: allLayersReject }
      : builder.id === 'dataset-id'
        ? { id: 'null', value: null, expected: allLayersReject }
        : { id: 'lone-low', value: '\uDC00', expected: allLayersReject }
    for (const variant of [
      { id: 'lone-high', value: '\uD800', expected: allLayersReject },
      thirdVariant,
      { id: 'astral', value: 'SYNTHETIC_😀', expected: allLayersAccept }
    ]) {
      const release = JSON.parse(baseText)
      builder.mutate(release, variant.value)
      cases.push(Object.freeze({
        id: `${builder.id}:${variant.id}`,
        kind: 'release',
        input: release,
        expected: variant.expected,
        resign: true
      }))
    }
  }
  const semanticVariants = Object.freeze({
    'enum-dataset-kind': Object.freeze([
      Object.freeze({ id: 'invalid-enum', value: 'not_a_dataset_kind', expected: allLayersReject }),
      Object.freeze({ id: 'lone-low', value: '\uDC00', expected: allLayersReject }),
      Object.freeze({ id: 'valid-enum', value: 'allergen', expected: allLayersAccept })
    ]),
    'uuid-entity-id': Object.freeze([
      Object.freeze({ id: 'invalid-uuid', value: 'not-a-uuid', expected: schemaRejectsShapeAcceptsFinalRejects }),
      Object.freeze({ id: 'lone-low', value: '\uDC00', expected: allLayersReject }),
      Object.freeze({ id: 'valid-uuid', value: '01900000-7000-7000-8000-000000000011', expected: allLayersAccept })
    ]),
    'digest-content-digest': Object.freeze([
      Object.freeze({ id: 'invalid-digest', value: 'sha256:bad', expected: schemaRejectsShapeAcceptsFinalRejects, resign: false }),
      Object.freeze({ id: 'lone-low', value: '\uDC00', expected: allLayersReject, resign: false }),
      Object.freeze({ id: 'valid-digest', value: null, expected: allLayersAccept, resign: true })
    ]),
    'timestamp-reviewed-at': Object.freeze([
      Object.freeze({ id: 'invalid-timestamp', value: '2000-97-01T00:00:00.000Z', expected: schemaRejectsShapeAcceptsFinalRejects }),
      Object.freeze({ id: 'lone-low', value: '\uDC00', expected: allLayersReject }),
      Object.freeze({ id: 'valid-timestamp', value: '2000-01-02T00:00:00.001Z', expected: allLayersAccept })
    ])
  })
  for (const builder of semanticStringMutationBuilders) {
    for (const variant of semanticVariants[builder.id]) {
      const release = JSON.parse(baseText)
      if (variant.value !== null) builder.mutate(release, variant.value)
      cases.push(Object.freeze({
        id: `${builder.id}:${variant.id}`,
        kind: 'release',
        input: release,
        expected: variant.expected,
        resign: variant.resign ?? true
      }))
    }
  }
  const mappingBuilders = Object.freeze([
    Object.freeze({
      id: 'mapping-id',
      valid: 'syn:mapping:lexical-parity-control',
      invalidId: 'invalid-pattern',
      invalid: 'not-a-mapping-id',
      mutate: (fixture, value) => { fixture.hardMappings[0].mappingId = value }
    }),
    Object.freeze({
      id: 'mapping-dataset-id',
      valid: 'syn:dataset:food-concept',
      invalidId: 'invalid-pattern',
      invalid: 'not-a-dataset-id',
      mutate: (fixture, value) => {
        fixture.hardMappings[0].mappingId = 'syn:mapping:lexical-dataset'
        fixture.hardMappings[0].source.datasetId = value
        fixture.hardMappings[0].target.datasetId = value
      }
    }),
    Object.freeze({
      id: 'mapping-entity-id',
      valid: '01900000-7000-7000-8000-000000000001',
      invalidId: 'invalid-uuid',
      invalid: 'not-a-uuid',
      mutate: (fixture, value) => {
        fixture.hardMappings[0].mappingId = 'syn:mapping:lexical-entity'
        fixture.hardMappings[0].source.entityId = value
        fixture.hardMappings[0].target.entityId = value
      }
    })
  ])
  for (const builder of mappingBuilders) {
    for (const variant of [
      { id: 'lone-high', value: `syn:\uD800`, expected: allLayersReject },
      { id: builder.invalidId, value: builder.invalid, expected: schemaRejectsShapeAcceptsFinalRejects },
      { id: 'valid-family-control', value: builder.valid, expected: allLayersAccept }
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

export const governanceStringReasons = Object.freeze({
  count: 'governance string evidence case count must remain exactly 51',
  idDistinct: 'governance string evidence case IDs must remain unique',
  idRegistry: 'governance string evidence case IDs must equal the registered order',
  materialDistinct: 'governance string evidence input materials must remain distinct',
  layering: 'governance string declared schema/decode/final-validator layering policy must match',
  oracle: 'governance string evidence oracle must execute every declared layer successfully'
})

const governancePolicyKeys = Object.freeze([
  'ajvRaw', 'ajvText', 'decoderRaw', 'decoderJson', 'finalValidator'
])

export const governanceStringEvidenceStats = (cases = governanceStringCases()) => {
  const expectedDifferences = {
    ajvRawVsDecoderRaw: 0,
    ajvTextVsDecoderJson: 0,
    ajvRawVsFinalValidator: 0
  }
  const expectedAccepts = Object.fromEntries(governancePolicyKeys.map((key) => [key, 0]))
  for (const current of cases) {
    const expected = current.expected
    if (expected?.ajvRaw !== expected?.decoderRaw) expectedDifferences.ajvRawVsDecoderRaw += 1
    if (expected?.ajvText !== expected?.decoderJson) expectedDifferences.ajvTextVsDecoderJson += 1
    if (expected?.ajvRaw !== expected?.finalValidator) expectedDifferences.ajvRawVsFinalValidator += 1
    for (const key of governancePolicyKeys) if (expected?.[key] === true) expectedAccepts[key] += 1
  }
  return Object.freeze({
    count: cases.length,
    uniqueIds: new Set(cases.map(({ id }) => id)).size,
    registeredIdOrderMatches: cases.length === GOVERNANCE_STRING_CASE_IDS.length &&
      cases.every(({ id }, index) => id === GOVERNANCE_STRING_CASE_IDS[index]),
    uniqueMaterials: new Set(cases.map(({ kind, input }) =>
      boundaryIdentity(ownJsonObject([['kind', kind], ['input', input]])))).size,
    expectedDifferences: Object.freeze(expectedDifferences),
    expectedAccepts: Object.freeze(expectedAccepts)
  })
}

const validGovernancePolicy = (expected) =>
  expected !== null && typeof expected === 'object' && !Array.isArray(expected) &&
  JSON.stringify(Object.keys(expected).sort()) === JSON.stringify([...governancePolicyKeys].sort()) &&
  governancePolicyKeys.every((key) => typeof expected[key] === 'boolean')

const recordGovernanceStringOracleFailure = (failures) => {
  /* guard:governance-string-oracle */
  failures.push(governanceStringReasons.oracle)
}

export const evaluateGovernanceStringLayers = (
  root = repositoryRoot,
  cases = governanceStringCases(root)
) => {
  const validators = compiledSchemas(root)
  const validDirectory = resolve(fixtureRoot(root), 'valid')
  return Object.freeze(cases.map((current) => {
    const text = JSON.stringify(current.input)
    const parsed = JSON.parse(text)
    let ajvRaw
    let ajvText
    let decoderRaw
    let decoderJson
    let finalValidator
    if (current.kind === 'release') {
      ajvRaw = validators.governance(current.input)
      ajvText = validators.governance(parsed)
      decoderRaw = domain.decodeGovernanceRelease(current.input).ok
      decoderJson = domain.decodeGovernanceReleaseJson(text).ok
      const finalInput = JSON.parse(text)
      if (current.resign !== false && domain.decodeGovernanceRelease(finalInput).ok) {
        finalInput.envelopes[0].contentDigest = domain.canonicalReleaseDigest(finalInput)
      }
      finalValidator = domain.validateGovernanceRelease(finalInput).ok
    } else {
      ajvRaw = validators.fixture(current.input)
      ajvText = validators.fixture(parsed)
      const rawCatalog = materializeFixture(current.input, validDirectory, domain)
      const textCatalog = materializeFixture(parsed, validDirectory, domain)
      decoderRaw = domain.decodeGovernanceCatalog(rawCatalog).ok
      decoderJson = domain.decodeGovernanceCatalogJson(JSON.stringify(textCatalog)).ok
      finalValidator = domain.validateGovernanceCatalog(rawCatalog).ok
    }
    return Object.freeze({
      id: current.id,
      actual: Object.freeze({ ajvRaw, ajvText, decoderRaw, decoderJson, finalValidator })
    })
  }))
}

export const governanceStringLayerStats = (
  root = repositoryRoot,
  cases = governanceStringCases(root)
) => {
  const results = evaluateGovernanceStringLayers(root, cases)
  const accepts = Object.fromEntries(governancePolicyKeys.map((key) => [
    key,
    results.filter(({ actual }) => actual[key]).length
  ]))
  const differences = {
    ajvRawVsDecoderRaw: results.filter(({ actual }) =>
      actual.ajvRaw !== actual.decoderRaw).length,
    ajvTextVsDecoderJson: results.filter(({ actual }) =>
      actual.ajvText !== actual.decoderJson).length,
    ajvRawVsFinalValidator: results.filter(({ actual }) =>
      actual.ajvRaw !== actual.finalValidator).length
  }
  return Object.freeze({
    executed: results.length,
    accepts: Object.freeze(accepts),
    differences: Object.freeze(differences)
  })
}

export const collectGovernanceStringParityFailures = (
  root = repositoryRoot,
  cases = governanceStringCases(root)
) => {
  const failures = []
  let stats
  try {
    stats = governanceStringEvidenceStats(cases)
  } catch {
    recordGovernanceStringOracleFailure(failures)
    return failures
  }
  /* guard:governance-string-count */
  if (stats.count !== GOVERNANCE_STRING_CASE_COUNT) failures.push(governanceStringReasons.count)
  /* guard:governance-string-id-distinct */
  if (stats.count === GOVERNANCE_STRING_CASE_COUNT && stats.uniqueIds !== stats.count) {
    failures.push(governanceStringReasons.idDistinct)
  }
  /* guard:governance-string-id-registry */
  if (
    stats.count === GOVERNANCE_STRING_CASE_COUNT && stats.uniqueIds === stats.count &&
    !stats.registeredIdOrderMatches
  ) failures.push(governanceStringReasons.idRegistry)
  /* guard:governance-string-material-distinct */
  if (stats.uniqueMaterials !== stats.count) failures.push(governanceStringReasons.materialDistinct)
  if (cases.some((current) => !validGovernancePolicy(current.expected))) {
    failures.push(governanceStringReasons.layering)
    return [...new Set(failures)]
  }
  let executed = 0
  try {
    const results = evaluateGovernanceStringLayers(root, cases)
    for (let index = 0; index < cases.length; index += 1) {
      const current = cases[index]
      const actual = results[index]?.actual
      /* guard:governance-string-layering */
      if (
        actual === undefined || governancePolicyKeys.some(
          (key) => actual[key] !== current.expected[key]
        )
      ) failures.push(governanceStringReasons.layering)
      executed += 1
    }
  } catch {
    recordGovernanceStringOracleFailure(failures)
  }
  if (executed !== cases.length) recordGovernanceStringOracleFailure(failures)
  return [...new Set(failures)]
}

export const schemaClosureReasons = Object.freeze({
  ref: 'schema closure $ref targets and scalar routing must remain exact',
  allOf: 'schema closure allOf nodes must remain recursively enumerable arrays',
  oneOf: 'schema closure oneOf nodes must remain recursively enumerable arrays',
  items: 'schema closure items string families must route through unicode scalar base',
  additionalProperties: 'schema closure additionalProperties string families must route through unicode scalar base',
  propertyNames: 'schema closure propertyNames string families must route through unicode scalar base',
  const: 'schema closure string const constraints must route through unicode scalar base',
  enum: 'schema closure string enum constraints must route through unicode scalar base'
})

const scalarReference = '#/$defs/scalarString'
const schemaNodeAcceptsString = (node) =>
  node !== null && typeof node === 'object' && !Array.isArray(node) && (
    node.type === 'string' ||
    Array.isArray(node.type) && node.type.includes('string') ||
    typeof node.pattern === 'string' || typeof node.format === 'string' ||
    typeof node.minLength === 'number'
  )

const recordSchemaClosureFailure = (failures, reason) => {
  switch (reason) {
    case schemaClosureReasons.ref: {
      /* guard:schema-closure-ref */
      failures.push(schemaClosureReasons.ref)
      break
    }
    case schemaClosureReasons.allOf: {
      /* guard:schema-closure-allOf */
      failures.push(schemaClosureReasons.allOf)
      break
    }
    case schemaClosureReasons.oneOf: {
      /* guard:schema-closure-oneOf */
      failures.push(schemaClosureReasons.oneOf)
      break
    }
    case schemaClosureReasons.items: {
      /* guard:schema-closure-items */
      failures.push(schemaClosureReasons.items)
      break
    }
    case schemaClosureReasons.additionalProperties: {
      /* guard:schema-closure-additionalProperties */
      failures.push(schemaClosureReasons.additionalProperties)
      break
    }
    case schemaClosureReasons.propertyNames: {
      /* guard:schema-closure-propertyNames */
      failures.push(schemaClosureReasons.propertyNames)
      break
    }
    case schemaClosureReasons.const: {
      /* guard:schema-closure-const */
      failures.push(schemaClosureReasons.const)
      break
    }
    case schemaClosureReasons.enum: {
      /* guard:schema-closure-enum */
      failures.push(schemaClosureReasons.enum)
      break
    }
  }
}

export const collectSchemaStringClosureFailures = (schema) => {
  const failures = []
  const definitions = schema?.$defs
  if (
    definitions === null || typeof definitions !== 'object' || Array.isArray(definitions) ||
    definitions.scalarString?.type !== 'string' ||
    definitions.scalarString.format !== 'unicode-scalar'
  ) {
    recordSchemaClosureFailure(failures, schemaClosureReasons.ref)
    return failures
  }
  const definitionNames = new Set(Object.keys(definitions))
  const visit = (node, state = Object.freeze({ protectedByScalar: false, keyword: null, scalarNode: false })) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, state)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (Object.hasOwn(node, '$ref')) {
      const reference = node.$ref
      if (
        typeof reference !== 'string' || !reference.startsWith('#/$defs/') ||
        !definitionNames.has(reference.slice('#/$defs/'.length))
      ) recordSchemaClosureFailure(failures, schemaClosureReasons.ref)
    }
    if (Object.hasOwn(node, 'allOf') && !Array.isArray(node.allOf)) {
      recordSchemaClosureFailure(failures, schemaClosureReasons.allOf)
    }
    if (Object.hasOwn(node, 'oneOf') && !Array.isArray(node.oneOf)) {
      recordSchemaClosureFailure(failures, schemaClosureReasons.oneOf)
    }
    const allOfProtects = Array.isArray(node.allOf) &&
      node.allOf.some((child) => child?.$ref === scalarReference)
    const protectedHere = state.protectedByScalar || state.scalarNode || allOfProtects ||
      node.$ref === scalarReference
    const directString = schemaNodeAcceptsString(node)
    if (directString && !protectedHere) {
      const reason = state.keyword === 'items'
        ? schemaClosureReasons.items
        : state.keyword === 'additionalProperties'
          ? schemaClosureReasons.additionalProperties
          : state.keyword === 'propertyNames'
            ? schemaClosureReasons.propertyNames
            : state.keyword === 'oneOf'
              ? schemaClosureReasons.oneOf
              : schemaClosureReasons.ref
      recordSchemaClosureFailure(failures, reason)
    }
    if (typeof node.const === 'string' && !protectedHere) {
      recordSchemaClosureFailure(failures, schemaClosureReasons.const)
    }
    if (
      Array.isArray(node.enum) && node.enum.some((value) => typeof value === 'string') &&
      !protectedHere
    ) recordSchemaClosureFailure(failures, schemaClosureReasons.enum)
    for (const [key, child] of Object.entries(node)) {
      const scalarNode = key === 'scalarString' && node === definitions
      const keyword = [
        'allOf', 'oneOf', 'items', 'additionalProperties', 'propertyNames'
      ].includes(key) ? key : state.keyword
      visit(child, {
        protectedByScalar: protectedHere || scalarNode,
        keyword,
        scalarNode
      })
    }
  }
  visit(schema)
  return [...new Set(failures)]
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
      failures.push(...collectSchemaStringClosureFailures(schema))
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
    const stringLayerStats = governanceStringLayerStats()
    const extensionStats = schemaExtensionExecutionStats()
    const inputStats = programInputTrustStats()
    process.stdout.write(
      `Stage 09P M0 scope check PASS (${manifests.valid.length} valid, ` +
      `${manifests.invalid.length} exclusive invalid, ${manifests.schemas.length} compiled schemas, ` +
      `${manifests.sources.length} pure source, ${manifests.tests.length} domain test files, ` +
      `${manifests.valid.length + manifests.invalid.length} fixture parity + ` +
      `${boundaryStats.count} JSON boundary parity cases / ${boundaryStats.uniqueIds} unique IDs / ` +
      `${boundaryStats.uniqueMaterials} unique material inputs + ${stringStats.count} governance ` +
      `string layered cases / ${stringStats.uniqueIds} unique IDs / ` +
      `registered ID order=${stringStats.registeredIdOrderMatches ? 'match' : 'mismatch'} / ` +
      `${stringStats.uniqueMaterials} unique material inputs / ${stringLayerStats.executed} complete ` +
      `layer oracles; layer accepts ajv-raw=${stringLayerStats.accepts.ajvRaw}, ` +
      `ajv-text=${stringLayerStats.accepts.ajvText}, decoder-raw=${stringLayerStats.accepts.decoderRaw}, ` +
      `decoder-json=${stringLayerStats.accepts.decoderJson}, final=${stringLayerStats.accepts.finalValidator}; ` +
      `declared differences schema/decode raw=${stringLayerStats.differences.ajvRawVsDecoderRaw}, ` +
      `text=${stringLayerStats.differences.ajvTextVsDecoderJson}, ` +
      `schema/final=${stringLayerStats.differences.ajvRawVsFinalValidator}; schema extension executions ` +
      `unicode=${extensionStats.unicodeScalar}, utc=${extensionStats.canonicalInstant}, ` +
      `negative-zero=${extensionStats.notNegativeZero}; Program inputs ` +
      `repository=${inputStats.counts.repository}, TypeScript-lib=${inputStats.counts.typescriptLib}, ` +
      `audited-dependency=${inputStats.counts.auditedDependency}, rejected=${inputStats.counts.rejected}, ` +
      `exact=${inputStats.exact}; descriptor sites=${registeredDescriptorCallSites.length}, ` +
      `reviewed owners=${Object.keys(registeredDescriptorOwnerFingerprints).length})\n`
    )
  }
}
