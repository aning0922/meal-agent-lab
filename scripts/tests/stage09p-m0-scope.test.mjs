import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'

import {
  collectCapabilityFailures,
  collectChangedPathFailures,
  collectManifestFailures,
  collectSchemaContractFailures,
  collectSyntheticFailures,
  repositoryRoot
} from '../check-stage09p-m0-scope.mjs'

const temporaryRoots = []
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

const fixtureRoot = (...paths) => {
  const root = mkdtempSync(join(tmpdir(), 'meal-agent-stage09p-m0-'))
  temporaryRoots.push(root)
  for (const relative of paths) {
    const target = resolve(root, relative)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(resolve(repositoryRoot, relative), target, { recursive: true })
  }
  return root
}

test('manifest mutation witness rejects an unregistered source and test file', () => {
  const root = fixtureRoot(
    'data/samples/stage09p-m0',
    'data/schemas',
    'packages/domain/src',
    'packages/domain/tests',
    'scripts/tests'
  )
  writeFileSync(resolve(root, 'packages/domain/src/unchecked.ts'), 'export const unchecked = true\n')
  writeFileSync(resolve(root, 'packages/domain/tests/unchecked.test.ts'), 'export {}\n')
  const failures = collectManifestFailures(root)
  assert.ok(failures.includes('domain source manifest must be exact'))
  assert.ok(failures.includes('domain test manifest must be exact'))
})

test('synthetic mutation witness rejects an unregistered leaf regardless of self-attestation', () => {
  const root = fixtureRoot('data/samples/stage09p-m0/valid')
  const path = resolve(root, 'data/samples/stage09p-m0/valid/food-concept.json')
  const release = JSON.parse(readFileSync(path, 'utf8'))
  release.envelopes[0].uncheckedExternalFact = 'SYNTHETIC_UNCHECKED'
  writeFileSync(path, `${JSON.stringify(release, null, 2)}\n`)
  assert.ok(
    collectSyntheticFailures(root).includes(
      'every valid leaf and key must match the complete M0 synthetic registry'
    )
  )
})

test('capability mutation witness is AST-based and rejects executable fetch only', () => {
  const root = fixtureRoot(
    'packages/domain/package.json',
    'packages/domain/src',
    'packages/domain/tests',
    'scripts/tests/stage09p-m0-scope.test.mjs'
  )
  const path = resolve(root, 'packages/domain/src/types.ts')
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, `${original}\nconst harmlessText = "fetch process require"\n// fetch("ignored")\n`)
  assert.deepEqual(collectCapabilityFailures(root), [])
  writeFileSync(path, `${original}\nexport const capabilityWitness = () => fetch("synthetic://blocked")\n`)
  assert.ok(
    collectCapabilityFailures(root).includes(
      'domain production source references a forbidden side-effect capability'
    )
  )
})

test('schema mutation witness executes the same compiled 2020-12 contract checks', () => {
  const root = fixtureRoot('data/schemas', 'data/samples/stage09p-m0')
  const path = resolve(root, 'data/schemas/governance-release.schema.json')
  const schema = JSON.parse(readFileSync(path, 'utf8'))
  schema.$defs.alias.required = schema.$defs.alias.required.filter(
    (key) => key !== 'sourceReferenceRevision'
  )
  writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`)
  assert.ok(
    collectSchemaContractFailures(root).includes(
      'compiled governance schema must require alias source revision'
    )
  )
})

test('scope mutation witness rejects frozen implementation and acceptance surfaces', () => {
  assert.deepEqual(
    collectChangedPathFailures([
      'packages/domain/src/types.ts',
      'data/schemas/governance-release.schema.json',
      'scripts/tests/stage09p-m0-scope.test.mjs'
    ]),
    []
  )
  const failures = collectChangedPathFailures([
    'packages/contracts/src/index.ts',
    'services/api/src/app.ts',
    'apps/client/src/app.ts',
    'docs/architecture/decisions/0006-production-security-containment-baseline.md'
  ])
  assert.equal(failures.length, 4)
  assert.equal(
    failures.every((failure) => failure === 'baseline changed-path allowlist rejects scope expansion'),
    true
  )
})
