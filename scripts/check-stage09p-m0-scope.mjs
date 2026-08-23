#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sampleRoot = resolve(repositoryRoot, 'data/samples/stage09p-m0')
const validDirectory = resolve(sampleRoot, 'valid')
const invalidDirectory = resolve(sampleRoot, 'invalid')
const schemaDirectory = resolve(repositoryRoot, 'data/schemas')
const domainRoot = resolve(repositoryRoot, 'packages/domain')

const expectedValid = [
  'allergen.json',
  'cooking-technique.json',
  'food-concept.json',
  'food-safety.json',
  'religious-ethical.json'
]
const expectedInvalid = [
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
]
const expectedSchemas = [
  'governance-release.schema.json',
  'invalid-governance-fixture.schema.json'
]
const expectedIssueByFile = new Map([
  ['alias-conflict.json', 'ALIAS_CONFLICT'],
  ['hard-mapping-unresolved.json', 'HARD_MAPPING_UNRESOLVED'],
  ['missing-language.json', 'MISSING_LANGUAGE'],
  ['missing-license.json', 'MISSING_LICENSE'],
  ['missing-region.json', 'MISSING_REGION'],
  ['missing-source.json', 'MISSING_SOURCE'],
  ['release-digest-mismatch.json', 'RELEASE_DIGEST_MISMATCH'],
  ['reused-id.json', 'REUSED_ENTITY_ID'],
  ['unknown-revision.json', 'UNKNOWN_REVISION'],
  ['withdrawn-reference.json', 'WITHDRAWN_REFERENCE']
])
const expectedKinds = new Set([
  'food_concept',
  'allergen',
  'religious_ethical',
  'food_safety',
  'cooking_technique'
])
const allowedMutationFields = new Set([
  'sourceReferences',
  'sourceSnapshots',
  'aliases',
  'applicableRegions',
  'languages',
  'licenseStatus',
  'licenseReference',
  'entityId',
  'lifecycleStatus',
  'withdrawalState',
  'withdrawalReason',
  'withdrawnAt',
  'contentDigest'
])
const reservedSyntheticEntityId = /^01900000-7000-7000-8000-0000000000[0-9]{2}$/
const failures = []

const parseJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    failures.push('all M0 JSON assets must parse')
    return null
  }
}

const exactFiles = (directory, expected, label) => {
  const actual = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map(({ name }) => name)
    .sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label} file manifest must be exact`)
  }
}

exactFiles(validDirectory, expectedValid, 'valid fixture')
exactFiles(invalidDirectory, expectedInvalid, 'invalid fixture')
const actualM0Schemas = readdirSync(schemaDirectory)
  .filter((name) => expectedSchemas.includes(name))
  .sort()
if (JSON.stringify(actualM0Schemas) !== JSON.stringify(expectedSchemas)) {
  failures.push('M0 schema file manifest must be exact')
}

const kinds = new Set()
for (const file of expectedValid) {
  const release = parseJson(resolve(validDirectory, file))
  if (release === null || !Array.isArray(release.envelopes) || release.envelopes.length !== 1) {
    failures.push('each valid sample must contain exactly one synthetic envelope')
    continue
  }
  const envelope = release.envelopes[0]
  kinds.add(envelope.datasetKind)
  const evidence = envelope.syntheticEvidence
  if (
    evidence?.classification !== 'fully_synthetic' ||
    evidence?.generator !== 'stage09p-m0-fixture-v1' ||
    evidence?.containsRealUserData !== false ||
    evidence?.containsRealFoodFacts !== false ||
    evidence?.purpose !== 'governance-format-and-fail-closed-testing-only'
  ) {
    failures.push('every valid sample must carry the exact mechanical synthetic evidence')
  }
  if (
    !String(envelope.datasetId).startsWith('syn:dataset:') ||
    !String(envelope.releaseId).startsWith('syn:release:') ||
    !reservedSyntheticEntityId.test(String(envelope.entityId)) ||
    envelope.sourceTier !== 'L3' ||
    envelope.sourceReferences?.some(
      (reference) =>
        !String(reference.referenceId).startsWith('syn:source:') ||
        !String(reference.locator).startsWith('synthetic://')
    ) ||
    envelope.sourceSnapshots?.some((snapshot) => !String(snapshot.snapshotId).startsWith('syn:snapshot:')) ||
    !String(envelope.licenseReference).startsWith('synthetic-license://') ||
    envelope.applicableRegions?.some((region) => !String(region).startsWith('SYNTHETIC-')) ||
    envelope.languages?.some((language) => language !== 'x-synthetic') ||
    envelope.aliases?.some((alias) => !String(alias.value).startsWith('SYNTHETIC_')) ||
    !String(envelope.content?.syntheticToken).startsWith('SYNTHETIC_')
  ) {
    failures.push('valid sample values must remain inside reserved synthetic namespaces')
  }
}
if (kinds.size !== expectedKinds.size || [...kinds].some((kind) => !expectedKinds.has(kind))) {
  failures.push('valid samples must cover the five exact governance kinds once each')
}

for (const file of expectedInvalid) {
  const fixture = parseJson(resolve(invalidDirectory, file))
  if (fixture === null) continue
  if (
    fixture.syntheticFixture !== 'fully_synthetic_mutation' ||
    !Array.isArray(fixture.baseValidFiles) ||
    fixture.baseValidFiles.length === 0 ||
    fixture.baseValidFiles.some((base) => !expectedValid.includes(base)) ||
    !Array.isArray(fixture.mutations) ||
    !Array.isArray(fixture.hardMappings) ||
    !Array.isArray(fixture.expectedIssueCodes) ||
    fixture.expectedIssueCodes.length !== 1 ||
    fixture.expectedIssueCodes[0] !== expectedIssueByFile.get(file)
  ) {
    failures.push('invalid fixtures must be exact, single-reason synthetic mutations')
    continue
  }
  for (const mutation of fixture.mutations) {
    if (
      mutation.operation === 'set'
        ? !allowedMutationFields.has(mutation.field)
        : mutation.operation !== 'duplicate_envelope' ||
          !reservedSyntheticEntityId.test(String(mutation.entityId)) ||
          !String(mutation.syntheticToken).startsWith('SYNTHETIC_') ||
          !String(mutation.aliasValue).trim().toUpperCase().startsWith('SYNTHETIC_')
    ) {
      failures.push('invalid fixture mutation escaped the synthetic mutation allowlist')
    }
  }
  for (const mapping of fixture.hardMappings) {
    if (
      !String(mapping.mappingId).startsWith('syn:mapping:') ||
      !String(mapping.source?.datasetId).startsWith('syn:dataset:') ||
      !reservedSyntheticEntityId.test(String(mapping.source?.entityId)) ||
      !String(mapping.target?.datasetId).startsWith('syn:dataset:') ||
      !reservedSyntheticEntityId.test(String(mapping.target?.entityId)) ||
      mapping.required !== true
    ) {
      failures.push('invalid fixture hard mappings must remain synthetic and required')
    }
  }
}

const governanceSchema = parseJson(resolve(schemaDirectory, expectedSchemas[0]))
const fixtureSchema = parseJson(resolve(schemaDirectory, expectedSchemas[1]))
if (
  governanceSchema?.$defs?.governanceEnvelope === undefined ||
  governanceSchema?.$defs?.syntheticEvidence === undefined ||
  fixtureSchema?.properties?.syntheticFixture?.const !== 'fully_synthetic_mutation'
) {
  failures.push('M0 schemas must retain governance and synthetic proof definitions')
}

const packageJson = parseJson(resolve(domainRoot, 'package.json'))
if (JSON.stringify(Object.keys(packageJson?.dependencies ?? {})) !== JSON.stringify(['@noble/hashes'])) {
  failures.push('domain runtime dependency set must remain the reviewed pure allowlist')
}
const sourceFiles = readdirSync(resolve(domainRoot, 'src')).filter((name) => name.endsWith('.ts')).sort()
const testFiles = readdirSync(resolve(domainRoot, 'tests')).filter((name) => name.endsWith('.test.ts')).sort()
const forbiddenProductionCapability = /(?:from|import\s*\()["'](?:node:|fastify|drizzle|@tarojs|react|zod|openai|@anthropic-ai|pg(?:\/|["']))/
for (const file of sourceFiles) {
  if (forbiddenProductionCapability.test(readFileSync(resolve(domainRoot, 'src', file), 'utf8'))) {
    failures.push('domain production source imported a forbidden runtime capability')
  }
}
for (const file of testFiles) {
  const source = readFileSync(resolve(domainRoot, 'tests', file), 'utf8')
  if (/\b(?:skip|todo)\s*[:(]/.test(source)) {
    failures.push('M0 tests must not contain skip or todo')
  }
}

if (failures.length > 0) {
  process.stderr.write(`Stage 09P M0 scope check FAIL (${failures.length} issue(s))\n`)
  process.exit(1)
}
process.stdout.write(
  `Stage 09P M0 scope check PASS (${expectedValid.length} valid, ${expectedInvalid.length} exclusive invalid, ${expectedSchemas.length} schemas, ${sourceFiles.length} pure source files, ${testFiles.length} test files)\n`
)
