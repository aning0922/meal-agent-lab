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
  capabilityReasons,
  collectCapabilityFailures,
  collectChangedPathFailures,
  collectGovernanceStringParityFailures,
  collectJsonBoundaryParityFailures,
  collectManifestFailures,
  collectSchemaContractFailures,
  collectSchemaParityFailures,
  collectSyntheticFailures,
  governanceStringEvidenceStats,
  jsonBoundaryCases,
  jsonBoundaryReasons,
  repositoryRoot,
  schemaExtensionExecutionStats
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

const runScopeCheckerMutation = ({ mutateChecker, witness, productionAppend = '' }) => {
  const root = fixtureRoot(
    'data/samples/stage09p-m0',
    'data/schemas',
    'packages/domain/dist',
    'packages/domain/package.json',
    'packages/domain/src',
    'packages/domain/tests',
    'scripts/check-stage09p-m0-scope.mjs',
    'scripts/tests/stage09p-m0-scope.test.mjs'
  )
  symlinkSync(resolve(repositoryRoot, 'node_modules'), resolve(root, 'node_modules'), 'dir')
  symlinkSync(
    resolve(repositoryRoot, 'packages/domain/node_modules'),
    resolve(root, 'packages/domain/node_modules'),
    'dir'
  )
  const checkerPath = resolve(root, 'scripts/check-stage09p-m0-scope.mjs')
  const checkerSource = readFileSync(checkerPath, 'utf8')
  const checkerMutant = mutateChecker(checkerSource)
  assert.notEqual(checkerMutant, checkerSource, 'scope checker mutation anchor disappeared')
  writeFileSync(checkerPath, checkerMutant)
  if (productionAppend.length > 0) {
    const productionPath = resolve(root, 'packages/domain/src/types.ts')
    writeFileSync(productionPath, `${readFileSync(productionPath, 'utf8')}\n${productionAppend}\n`)
  }
  const witnessPath = resolve(root, 'round4-mutation-witness.mjs')
  writeFileSync(
    witnessPath,
    `import assert from 'node:assert/strict'\n${witness}\n`
  )
  return spawnSync(process.execPath, [witnessPath], {
    cwd: root,
    encoding: 'utf8',
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')
    ),
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  })
}

const assertTargetedMutationFailure = (outcome, reason) => {
  const output = `${outcome.stdout}${outcome.stderr}`
  assert.equal(outcome.status, 1, output)
  assert.match(output, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(
    output,
    /ENOENT|ERR_MODULE_NOT_FOUND|Cannot find package|TypeError|timed out|timeout/i
  )
}

const deleteCheckerGuard = (source, marker, statement, replacement) => {
  if (source.includes(statement)) return source.replace(statement, replacement)
  return source.replace(marker, `${marker.slice(0, -2)}:already-deleted */`)
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

test('capability grammar closes declaration identity, value flow, members, and modules', () => {
  const root = fixtureRoot(
    'packages/domain/package.json',
    'packages/domain/src',
    'packages/domain/tests',
    'scripts/tests/stage09p-m0-scope.test.mjs'
  )
  const path = resolve(root, 'packages/domain/src/types.ts')
  symlinkSync(
    resolve(repositoryRoot, 'packages/domain/node_modules'),
    resolve(root, 'packages/domain/node_modules'),
    'dir'
  )
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, `${original}\nconst harmlessText = "fetch process require"\n// fetch("ignored")\n`)
  assert.deepEqual(collectCapabilityFailures(root), [])

  const cases = [
    {
      name: 'direct fetch',
      source: 'export const witness = () => fetch("synthetic://blocked")',
      reason: capabilityReasons.capabilitySource
    },
    {
      name: 'computed Function constructor to global fetch',
      source: `export const witness = () => {
  const getGlobal = (() => undefined).constructor("return " + "globalThis")
  const runtimeGlobal = getGlobal()
  return runtimeGlobal["fetch"]("https://example.invalid/")
}`,
      reason: capabilityReasons.prototypeChain
    },
    {
      name: 'constant-concatenated computed capability',
      source: 'declare const runtimeGlobal: { fetch: unknown }; void runtimeGlobal["fe" + "tch"]',
      reason: capabilityReasons.computedSensitive
    },
    {
      name: 'object prototype constructor chain',
      source: 'void Object.prototype.constructor',
      reason: capabilityReasons.prototypeChain
    },
    {
      name: 'array constructor chain',
      source: 'void ([] as unknown[]).constructor',
      reason: capabilityReasons.prototypeChain
    },
    {
      name: 'function prototype chain',
      source: 'void (() => undefined).prototype',
      reason: capabilityReasons.prototypeChain
    },
    {
      name: 'eval source',
      source: 'void eval',
      reason: capabilityReasons.capabilitySource
    },
    {
      name: 'Function source',
      source: 'void Function',
      reason: capabilityReasons.capabilitySource
    },
    {
      name: 'Reflect construct',
      source: 'void Reflect.construct',
      reason: capabilityReasons.computedSensitive
    },
    {
      name: 'ImportEquals external module reference',
      source: 'import fs = require("node:fs"); void fs',
      reason: capabilityReasons.moduleGrammar
    },
    {
      name: 'dynamic import',
      source: 'export const witness = () => import("node:" + "fs")',
      reason: capabilityReasons.moduleGrammar
    },
    {
      name: 'createRequire import',
      source: 'import { createRequire } from "node:module"; void createRequire',
      reason: capabilityReasons.moduleGrammar
    },
    {
      name: 'require call',
      source: 'export const witness = () => require("node:fs")',
      reason: capabilityReasons.capabilitySource
    },
    {
      name: 'query module identity',
      source: 'import "./decode.js?escape"',
      reason: capabilityReasons.moduleGrammar
    },
    {
      name: 'fragment module identity',
      source: 'import "./decode.js#escape"',
      reason: capabilityReasons.moduleGrammar
    },
    {
      name: 'absolute module identity',
      source: 'import "/tmp/escape.js"',
      reason: capabilityReasons.moduleGrammar
    },
    {
      name: 'higher-order opaque forwarding',
      source: 'declare const opaque: () => unknown; export const witness = () => opaque()',
      reason: capabilityReasons.declarationIdentity
    }
  ]
  for (const current of cases) {
    const caseRoot = fixtureRoot(
      'packages/domain/package.json',
      'packages/domain/src',
      'packages/domain/tests',
      'scripts/tests/stage09p-m0-scope.test.mjs'
    )
    const casePath = resolve(caseRoot, 'packages/domain/src/types.ts')
    symlinkSync(
      resolve(repositoryRoot, 'packages/domain/node_modules'),
      resolve(caseRoot, 'packages/domain/node_modules'),
      'dir'
    )
    writeFileSync(casePath, `${readFileSync(casePath, 'utf8')}\n${current.source}\n`)
    assert.ok(
      collectCapabilityFailures(caseRoot).includes(current.reason),
      current.name
    )
  }

  const nestedRoot = fixtureRoot(
    'packages/domain/package.json',
    'packages/domain/src',
    'packages/domain/tests',
    'scripts/tests/stage09p-m0-scope.test.mjs'
  )
  const nestedPath = resolve(nestedRoot, 'packages/domain/src/nested/escape.ts')
  symlinkSync(
    resolve(repositoryRoot, 'packages/domain/node_modules'),
    resolve(nestedRoot, 'packages/domain/node_modules'),
    'dir'
  )
  mkdirSync(dirname(nestedPath), { recursive: true })
  writeFileSync(nestedPath, 'export { decodeGovernanceRelease } from "@escape/domain"\n')
  assert.ok(collectCapabilityFailures(nestedRoot).includes(capabilityReasons.moduleGrammar))
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

test('governance string lexical contract is scalar-first across all schema families', () => {
  assert.deepEqual(collectGovernanceStringParityFailures(), [])
  assert.deepEqual(governanceStringEvidenceStats(), {
    count: 51,
    uniqueIds: 51,
    uniqueMaterials: 51
  })
  assert.deepEqual(schemaExtensionExecutionStats(), {
    unicodeScalar: 1184,
    canonicalInstant: 120,
    notNegativeZero: 6
  })
  const mutations = [
    {
      name: 'unified scalar base',
      mutate: (schema) => { delete schema.$defs.scalarString.format }
    },
    {
      name: 'nonEmptyString scalar inheritance',
      mutate: (schema) => {
        schema.$defs.nonEmptyString = { type: 'string', minLength: 1 }
      }
    },
    {
      name: 'bare array-item string',
      mutate: (schema) => {
        schema.$defs.governanceEnvelope.properties.applicableRegions.items = { type: 'string' }
      }
    }
  ]
  for (const current of mutations) {
    const root = fixtureRoot('data/schemas', 'data/samples/stage09p-m0')
    const path = resolve(root, 'data/schemas/governance-release.schema.json')
    const schema = JSON.parse(readFileSync(path, 'utf8'))
    current.mutate(schema)
    writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`)
    assert.ok(
      collectSchemaContractFailures(root).includes(
        'schema string lexical contract must route every string family through unicode scalar base'
      ),
      current.name
    )
  }
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
    capabilityReasons.capabilitySource
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
  delete schema.$defs.scalarString.format
  writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`)
  assert.ok((await collectSchemaParityFailures(root)).includes(
    'JSON boundary schema/runtime parity must match the exact expected matrix'
  ))
})

test('JSON boundary evidence guards report count, IDs, materials, parity, and oracle independently', () => {
  const root = fixtureRoot('data/schemas', 'data/samples/stage09p-m0/valid')
  const base = jsonBoundaryCases()
  assert.deepEqual(collectJsonBoundaryParityFailures(root, base.slice(0, -1)), [
    jsonBoundaryReasons.count
  ])
  assert.deepEqual(collectJsonBoundaryParityFailures(root, base.map((current) =>
    current.id === 'finite-positive' ? { ...current, id: 'zero' } : current
  )), [jsonBoundaryReasons.idDistinct])
  assert.deepEqual(collectJsonBoundaryParityFailures(root, base.map((current) =>
    current.id === 'finite-positive' ? { ...current, value: 0 } : current
  )), [jsonBoundaryReasons.materialDistinct])
  assert.deepEqual(collectJsonBoundaryParityFailures(root, base.map((current) =>
    current.id === 'finite-positive' ? { ...current, expected: false } : current
  )), [jsonBoundaryReasons.parity])
  const hostile = [...base]
  hostile[0] = {
    id: 'empty-object',
    get value() { throw new Error('SYNTHETIC_ORACLE_FAILURE') },
    expected: true
  }
  assert.deepEqual(collectJsonBoundaryParityFailures(root, hostile), [
    jsonBoundaryReasons.oracle
  ])
})

test('each JSON boundary evidence guard has an executable deletion witness', () => {
  const witnesses = [
    {
      reason: jsonBoundaryReasons.count,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:json-boundary-count */',
        '  if (stats.count !== JSON_BOUNDARY_CASE_COUNT) failures.push(jsonBoundaryReasons.count)',
        '  void stats.count'
      ),
      cases: 'jsonBoundaryCases().slice(0, -1)'
    },
    {
      reason: jsonBoundaryReasons.idDistinct,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:json-boundary-id-distinct */',
        '  if (stats.uniqueIds !== stats.count) failures.push(jsonBoundaryReasons.idDistinct)',
        '  void stats.uniqueIds'
      ),
      cases: `jsonBoundaryCases().map((current) =>
  current.id === 'finite-positive' ? { ...current, id: 'zero' } : current)`
    },
    {
      reason: jsonBoundaryReasons.materialDistinct,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:json-boundary-material-distinct */',
        '  if (stats.uniqueMaterials !== stats.count) failures.push(jsonBoundaryReasons.materialDistinct)',
        '  void stats.uniqueMaterials'
      ),
      cases: `jsonBoundaryCases().map((current) =>
  current.id === 'finite-positive' ? { ...current, value: 0 } : current)`
    },
    {
      reason: jsonBoundaryReasons.parity,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:json-boundary-parity */',
        '        failures.push(jsonBoundaryReasons.parity)',
        '        void schemaOk'
      ),
      cases: `jsonBoundaryCases().map((current) =>
  current.id === 'finite-positive' ? { ...current, expected: false } : current)`
    },
    {
      reason: jsonBoundaryReasons.oracle,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:json-boundary-oracle */',
        '  failures.push(jsonBoundaryReasons.oracle)',
        '  void failures'
      ),
      cases: `(() => {
  const cases = [...jsonBoundaryCases()]
  cases[0] = { id: 'empty-object', get value() { throw new Error('SYNTHETIC') }, expected: true }
  return cases
})()`
    }
  ]
  for (const current of witnesses) {
    const outcome = runScopeCheckerMutation({
      mutateChecker: current.mutateChecker,
      witness: `import {
  collectJsonBoundaryParityFailures,
  jsonBoundaryCases,
  jsonBoundaryReasons,
  repositoryRoot
} from './scripts/check-stage09p-m0-scope.mjs'
const cases = ${current.cases}
assert.deepEqual(
  collectJsonBoundaryParityFailures(repositoryRoot, cases),
  [${JSON.stringify(current.reason)}],
  ${JSON.stringify(current.reason)}
)`
    })
    assertTargetedMutationFailure(outcome, current.reason)
  }
})

test('capability grammar guard families have executable deletion witnesses', () => {
  const witnesses = [
    {
      reason: capabilityReasons.prototypeChain,
      productionAppend: 'void (() => undefined).constructor',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.prototypeChain)',
        '  void failures'
      )
    },
    {
      reason: capabilityReasons.computedSensitive,
      productionAppend: 'declare const runtimeGlobal: { fetch: unknown }; void runtimeGlobal["fe" + "tch"]',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.computedSensitive)',
        '  void failures'
      )
    },
    {
      reason: capabilityReasons.declarationIdentity,
      productionAppend: 'declare const opaque: () => unknown; export const witness = () => opaque()',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.declarationIdentity)',
        '  void failures'
      )
    },
    {
      reason: capabilityReasons.moduleGrammar,
      productionAppend: 'import fs = require("node:fs"); void fs',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.moduleGrammar)',
        '  void failures'
      )
    }
  ]
  for (const current of witnesses) {
    const outcome = runScopeCheckerMutation({
      mutateChecker: current.mutateChecker,
      productionAppend: current.productionAppend,
      witness: `import {
  capabilityReasons,
  collectCapabilityFailures,
  repositoryRoot
} from './scripts/check-stage09p-m0-scope.mjs'
assert.deepEqual(
  collectCapabilityFailures(repositoryRoot),
  [${JSON.stringify(current.reason)}],
  ${JSON.stringify(current.reason)}
)`
    })
    assertTargetedMutationFailure(outcome, current.reason)
  }
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
