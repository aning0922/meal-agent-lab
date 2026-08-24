import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'

import {
  collectCapabilityFailures,
  collectChangedPathFailures,
  collectJsonBoundaryParityFailures,
  collectManifestFailures,
  collectSchemaContractFailures,
  collectSchemaParityFailures,
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

const runDomainMutation = (relativePath, mutate) => {
  const root = fixtureRoot(
    'data/samples/stage09p-m0',
    'packages/domain/package.json',
    'packages/domain/src',
    'packages/domain/tests',
    'packages/domain/tsconfig.json',
    'packages/domain/tsconfig.build.json'
  )
  symlinkSync(
    resolve(repositoryRoot, 'packages/domain/node_modules'),
    resolve(root, 'packages/domain/node_modules'),
    'dir'
  )
  const path = resolve(root, 'packages/domain', relativePath)
  const source = readFileSync(path, 'utf8')
  const mutant = mutate(source)
  assert.notEqual(mutant, source, `domain mutation anchor disappeared: ${relativePath}`)
  writeFileSync(path, mutant)
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      'tests/adversarial.test.ts',
      'tests/boundary.test.ts',
      'tests/governance.test.ts'
    ],
    {
      cwd: resolve(root, 'packages/domain'),
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')
      ),
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    }
  )
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
  assert.ok(failures.includes(
    'domain source recursive manifest must be exact across paths and node types'
  ))
  assert.ok(failures.includes(
    'domain test recursive manifest must be exact across paths and node types'
  ))
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

test('recursive surface witnesses reject nested capability, synthetic, and schema escapes', () => {
  const root = fixtureRoot(
    'data/samples/stage09p-m0',
    'data/schemas',
    'packages/domain/package.json',
    'packages/domain/src',
    'packages/domain/tests',
    'scripts/tests'
  )
  const nestedSource = resolve(root, 'packages/domain/src/nested/escape.ts')
  const nestedSample = resolve(
    root,
    'data/samples/stage09p-m0/valid/nested/unregistered.json'
  )
  const nestedSchema = resolve(root, 'data/schemas/nested/unregistered.schema.json')
  for (const path of [nestedSource, nestedSample, nestedSchema]) {
    mkdirSync(dirname(path), { recursive: true })
  }
  writeFileSync(
    nestedSource,
    'export const escape = () => globalThis["fetch"]("synthetic://blocked")\n'
  )
  writeFileSync(
    nestedSample,
    '{"uncheckedExternalFact":"NON_SYNTHETIC_SENTINEL"}\n'
  )
  writeFileSync(
    nestedSchema,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}\n'
  )

  const manifestFailures = collectManifestFailures(root)
  assert.ok(manifestFailures.includes(
    'domain source recursive manifest must be exact across paths and node types'
  ))
  assert.ok(manifestFailures.includes(
    'valid fixture recursive manifest must be exact across paths and node types'
  ))
  assert.ok(manifestFailures.includes(
    'schema recursive manifest must be exact across paths and node types'
  ))
  assert.ok(collectSyntheticFailures(root).includes(
    'valid fixture synthetic leaf/key registry must cover the exact recursive surface'
  ))
  assert.ok(collectCapabilityFailures(root).includes(
    'domain production source references a forbidden side-effect capability'
  ))
  assert.ok(collectSchemaContractFailures(root).includes(
    'schema compile registry must cover the exact recursive surface'
  ))
})

test('recursive manifest records symlinks as forbidden nodes instead of following them', () => {
  const root = fixtureRoot(
    'data/samples/stage09p-m0',
    'data/schemas',
    'packages/domain/src',
    'packages/domain/tests',
    'scripts/tests'
  )
  symlinkSync('types.ts', resolve(root, 'packages/domain/src/unregistered-link.ts'))
  assert.ok(collectManifestFailures(root).includes(
    'domain source recursive manifest must be exact across paths and node types'
  ))
  assert.ok(collectCapabilityFailures(root).includes(
    'domain production recursive source surface must contain registered ordinary files only'
  ))
})

test('Unicode scalar schema weakening is killed by the generated boundary parity matrix', async () => {
  const root = fixtureRoot('data/schemas', 'data/samples/stage09p-m0')
  const path = resolve(root, 'data/schemas/governance-release.schema.json')
  const schema = JSON.parse(readFileSync(path, 'utf8'))
  delete schema.$defs.unicodeScalarString.format
  writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`)
  assert.ok((await collectSchemaParityFailures(root)).includes(
    'JSON boundary schema/runtime parity must match the exact expected matrix'
  ))
})

test('JSON boundary parity matrix cannot be emptied or deduplicated into a false green', () => {
  const root = fixtureRoot('data/schemas', 'data/samples/stage09p-m0/valid')
  assert.deepEqual(collectJsonBoundaryParityFailures(root, []), [
    'JSON boundary parity matrix count and distinct inputs must remain exact'
  ])
})

test('domain trust, copy, comparator, and chronology guards have executable deletion witnesses', () => {
  const mutations = [
    {
      file: 'src/decode.ts',
      expectedTest: 'JSON text entrypoints are total and never coerce hostile non-strings',
      mutate: (source) => source
        .replace('    if (typeof text !== "string") fail("release");\n', '')
        .replace('    if (typeof text !== "string") fail("catalog");\n', '')
    },
    {
      file: 'src/decode.ts',
      expectedTest: 'hostile thrown values cannot forge or escape the private decode failure identity',
      mutate: (source) => source.replace(
        '? decodeFailures.get(error)',
        '? Reflect.get(error, "path") as string | undefined'
      )
    },
    {
      file: 'src/decode.ts',
      expectedTest: 'lossless snapshots preserve every legal JSON key across object and text entrypoints',
      mutate: (source) => source.replace(
        `      Object.defineProperty(decoded, stringKey, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: decodeJsonValue(
          (descriptor as PropertyDescriptor & { value: unknown }).value,
          path,
          ancestors,
        ),
      });`,
        `      decoded[stringKey] = decodeJsonValue(
        (descriptor as PropertyDescriptor & { value: unknown }).value,
        path,
        ancestors,
      );`
      )
    },
    {
      file: 'src/canonical.ts',
      expectedTest: 'full canonical material is the deterministic tie-break for equal envelope identities',
      mutate: (source) => source.replace(
        '  return compareUtf8(canonicalJson(material(left)), canonicalJson(material(right)));',
        '  return 0;'
      )
    },
    {
      file: 'src/validation.ts',
      expectedTest: 'source snapshot chronology is closed over review and due-time boundaries',
      mutate: (source) => source.replace(
        `        (snapshotInstantValid &&
          isCanonicalInstant(envelope.reviewedAt) &&
          snapshot.retrievedAt > envelope.reviewedAt)`,
        '        false'
      )
    }
  ]

  for (const mutation of mutations) {
    const outcome = runDomainMutation(mutation.file, mutation.mutate)
    const output = `${outcome.stdout}${outcome.stderr}`
    assert.equal(outcome.status, 1, output)
    assert.match(output, new RegExp(mutation.expectedTest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(output, /ENOENT|ERR_MODULE_NOT_FOUND|Cannot find package/)
  }
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
