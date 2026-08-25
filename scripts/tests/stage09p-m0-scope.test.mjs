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

import ts from 'typescript'

import {
  capabilityReasons,
  collectCapabilityFailures,
  collectChangedPathFailures,
  collectGovernanceStringParityFailures,
  collectJsonBoundaryParityFailures,
  collectManifestFailures,
  collectSchemaContractFailures,
  collectSchemaParityFailures,
  collectSchemaStringClosureFailures,
  collectSyntheticFailures,
  collectTypescriptLibSymbolIdentityFailures,
  evaluateGovernanceStringLayers,
  GOVERNANCE_STRING_CASE_IDS,
  governanceStringCases,
  governanceStringEvidenceStats,
  governanceStringLayerStats,
  governanceStringReasons,
  jsonBoundaryCases,
  jsonBoundaryReasons,
  programInputTrustStats,
  registeredDescriptorCallSites,
  registeredDescriptorOwnerFingerprints,
  registeredDescriptorSiteContracts,
  registeredModuleExportSurfaces,
  registeredProgramInputManifest,
  repositoryRoot,
  schemaClosureReasons,
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

const runScopeCheckerMutation = ({
  mutateChecker,
  witness,
  productionAppend = '',
  productionFile = 'types.ts',
  mutateProduction = null,
  mutateFixture = null
}) => {
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
    const productionPath = resolve(root, 'packages/domain/src', productionFile)
    writeFileSync(productionPath, `${readFileSync(productionPath, 'utf8')}\n${productionAppend}\n`)
  }
  if (mutateProduction !== null) {
    const productionPath = resolve(root, 'packages/domain/src', productionFile)
    const productionSource = readFileSync(productionPath, 'utf8')
    const productionMutant = mutateProduction(productionSource)
    assert.notEqual(productionMutant, productionSource, 'production mutation anchor disappeared')
    writeFileSync(productionPath, productionMutant)
  }
  if (mutateFixture !== null) mutateFixture(root)
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

const assertTargetedMutationFailure = (outcome, reason, label = reason) => {
  const output = `${outcome.stdout}${outcome.stderr}`
  assert.equal(outcome.status, 1, `${label}\n${output}`)
  assert.match(output, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(
    output,
    /ENOENT|ERR_MODULE_NOT_FOUND|Cannot find package|TypeError|timed out|timeout/i
  )
}

const capabilityFixtureRoot = () => {
  const root = fixtureRoot(
    'packages/domain/package.json',
    'packages/domain/src',
    'packages/domain/tests',
    'scripts/tests/stage09p-m0-scope.test.mjs'
  )
  symlinkSync(
    resolve(repositoryRoot, 'packages/domain/node_modules'),
    resolve(root, 'packages/domain/node_modules'),
    'dir'
  )
  return root
}

const capabilityFixtureFailures = (source, file = 'types.ts') => {
  const root = capabilityFixtureRoot()
  const path = resolve(root, 'packages/domain/src', file)
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n${source}\n`)
  return collectCapabilityFailures(root)
}

const capabilityExternalInputFailures = ({ declaration, referenceFile = 'canonical.ts' }) => {
  const root = capabilityFixtureRoot()
  const referencePath = resolve(root, 'packages/domain/src', referenceFile)
  writeFileSync(
    referencePath,
    `/// <reference path="../round53-augmentation.d.ts" />\n${readFileSync(referencePath, 'utf8')}`
  )
  writeFileSync(resolve(root, 'packages/domain/round53-augmentation.d.ts'), declaration)
  return collectCapabilityFailures(root)
}

const capabilityMutatedFileFailures = (file, mutate) => {
  const root = fixtureRoot(
    'packages/domain/package.json',
    'packages/domain/src',
    'packages/domain/tests',
    'scripts/tests/stage09p-m0-scope.test.mjs'
  )
  symlinkSync(
    resolve(repositoryRoot, 'packages/domain/node_modules'),
    resolve(root, 'packages/domain/node_modules'),
    'dir'
  )
  const path = resolve(root, 'packages/domain/src', file)
  const source = readFileSync(path, 'utf8')
  const mutant = mutate(source)
  assert.notEqual(mutant, source, `capability mutation anchor disappeared: ${file}`)
  writeFileSync(path, mutant)
  return collectCapabilityFailures(root)
}

const canonicalLibMemberIdentityFailures = (declaration) => {
  const root = mkdtempSync(join(tmpdir(), 'meal-agent-stage09p-r54-lib-'))
  temporaryRoots.push(root)
  const declarationPath = resolve(root, 'identity-fixture.d.ts')
  const usePath = resolve(root, 'identity-use.ts')
  writeFileSync(declarationPath, declaration)
  writeFileSync(
    usePath,
    'const round54Member = Object.getOwnPropertyDescriptor\nvoid round54Member\n'
  )
  const program = ts.createProgram({
    rootNames: [declarationPath, usePath],
    options: {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: []
    }
  })
  assert.equal(program.getSyntacticDiagnostics().length, 0)
  assert.equal(program.getOptionsDiagnostics().length, 0)
  assert.equal(program.getSemanticDiagnostics().length, 0)
  const tree = program.getSourceFile(usePath)
  assert.notEqual(tree, undefined)
  const checker = program.getTypeChecker()
  let memberSymbol
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) && node.name.text === 'getOwnPropertyDescriptor'
    ) memberSymbol = checker.getSymbolAtLocation(node.name)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.notEqual(memberSymbol, undefined)
  return collectTypescriptLibSymbolIdentityFailures(
    memberSymbol,
    'getOwnPropertyDescriptor'
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

  const provenanceMatrix = [
    {
      id: 'assertion-unknown-double',
      name: 'unknown double assertion impersonates an audited lib receiver',
      source: 'const impostor = { trim: () => "LOCAL" } as unknown as string; export const witness = () => impostor.trim()',
      reason: capabilityReasons.valueProvenance
    },
    {
      id: 'assertion-any-double',
      name: 'any double assertion impersonates an audited lib receiver',
      source: 'const impostor = { trim: () => "LOCAL" } as any as string; export const witness = () => impostor.trim()',
      reason: capabilityReasons.valueProvenance
    },
    {
      id: 'assertion-direct',
      name: 'direct incompatible assertion impersonates an audited lib receiver',
      source: 'const impostor = { trim: () => "LOCAL" } as string; export const witness = () => impostor.trim()',
      reason: capabilityReasons.valueProvenance
    },
    {
      id: 'assertion-alias-chain',
      name: 'assertion provenance survives aliases',
      source: 'const local = { trim: () => "LOCAL" }; const erased = local as any; const impostor = erased as string; export const witness = () => impostor.trim()',
      reason: capabilityReasons.valueProvenance
    },
    {
      id: 'reflect-direct',
      name: 'direct Reflect.get capability acquisition',
      source: 'export const leaked = Reflect.get(() => undefined, "constructor")',
      reason: capabilityReasons.reflectiveAcquisition
    },
    {
      id: 'reflect-object-alias',
      name: 'Reflect namespace alias capability acquisition',
      source: 'const reflectAlias = Reflect; export const leaked = reflectAlias.get(() => undefined, "constructor")',
      reason: capabilityReasons.reflectiveAcquisition
    },
    {
      id: 'reflect-property-alias',
      name: 'Reflect.get property alias capability acquisition',
      source: 'const reflectGet = Reflect.get; export const leaked = reflectGet(() => undefined, "constructor")',
      reason: capabilityReasons.reflectiveAcquisition
    },
    {
      id: 'reflect-element-direct',
      name: 'Reflect element access capability acquisition',
      source: 'export const leaked = Reflect["get"](() => undefined, "constructor")',
      reason: capabilityReasons.reflectiveAcquisition
    },
    {
      id: 'reflect-element-alias',
      name: 'Reflect alias element access capability acquisition',
      source: 'const reflectAlias = Reflect; export const leaked = reflectAlias["get"](() => undefined, "constructor")',
      reason: capabilityReasons.reflectiveAcquisition
    },
    {
      id: 'descriptor-object-direct',
      name: 'unaudited Object descriptor result forwarding',
      source: 'const descriptor = Object.getOwnPropertyDescriptor(() => undefined, "constructor"); export const leaked = descriptor?.value',
      reason: capabilityReasons.descriptorCallSite
    },
    {
      id: 'descriptor-method-alias',
      name: 'descriptor method alias acquisition',
      source: 'const descriptorLookup = Object.getOwnPropertyDescriptor; export const leaked = descriptorLookup(() => undefined, "constructor")',
      reason: capabilityReasons.descriptorAcquisition
    },
    {
      id: 'descriptor-receiver-alias',
      name: 'Object namespace alias descriptor acquisition',
      source: 'const objectAlias = Object; export const leaked = objectAlias.getOwnPropertyDescriptor(() => undefined, "constructor")',
      reason: capabilityReasons.descriptorAcquisition
    },
    {
      id: 'descriptor-reflect',
      name: 'Reflect descriptor acquisition',
      source: 'export const leaked = Reflect.getOwnPropertyDescriptor(() => undefined, "constructor")',
      reason: capabilityReasons.descriptorCallSite
    },
    {
      id: 'descriptor-dynamic-key',
      name: 'descriptor acquisition with unproved dynamic target key',
      source: 'declare const runtimeKey: PropertyKey; export const leaked = Object.getOwnPropertyDescriptor({}, runtimeKey)',
      reason: capabilityReasons.descriptorCallSite
    },
    {
      id: 'descriptor-unregistered-site',
      name: 'non-sensitive descriptor acquisition outside the audited decoder site',
      source: 'export const leaked = Object.getOwnPropertyDescriptor({}, "value")',
      reason: capabilityReasons.descriptorCallSite
    }
  ]
  assert.equal(provenanceMatrix.length, 15)
  assert.equal(new Set(provenanceMatrix.map(({ id }) => id)).size, 15)

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
    },
    {
      name: 'destructured constructor capability forwarding',
      source: 'const { constructor: leakedConstructor } = (() => undefined); export { leakedConstructor }',
      reason: capabilityReasons.valueProvenance
    },
    {
      name: 'runtime-computed key after type erasure',
      source: `const keyParts = ["con", "structor"]
const erasedKey = keyParts.join("")
const erasedCallable = (() => undefined) as unknown as Record<string, unknown>
export const leakedDynamicCapability = () => erasedCallable[erasedKey]`,
      reason: capabilityReasons.valueProvenance
    },
    {
      name: 'unapproved global capability forwarding',
      source: 'export const leakedRuntimeCrypto = crypto',
      reason: capabilityReasons.capabilitySource
    },
    {
      name: 'unregistered named public re-export',
      file: 'index.ts',
      source: 'export { createValidatedCatalogIndex } from "./catalog.js"',
      reason: capabilityReasons.publicSurface
    },
    {
      name: 'unregistered star public re-export',
      file: 'index.ts',
      source: 'export * from "./catalog.js"',
      reason: capabilityReasons.publicSurface
    },
    ...provenanceMatrix
  ]
  for (const current of cases) {
    const caseRoot = fixtureRoot(
      'packages/domain/package.json',
      'packages/domain/src',
      'packages/domain/tests',
      'scripts/tests/stage09p-m0-scope.test.mjs'
    )
    const casePath = resolve(caseRoot, 'packages/domain/src', current.file ?? 'types.ts')
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

test('Round 5.2 capability acquisition is rejected at reference and forwarding time', () => {
  const reflectCases = [
    ['namespace-direct', 'const leaked = Reflect; void leaked'],
    ['member-direct', 'const leaked = Reflect.get; void leaked'],
    ['namespace-alias', 'const first = Reflect; const leaked = first; void leaked'],
    ['member-alias', 'const first = Reflect.get; const leaked = first; void leaked'],
    ['destructured-member', 'const { get: leaked } = Reflect; void leaked'],
    ['element-member', 'const leaked = Reflect["get"]; void leaked'],
    ['return-forward', 'const leaked = () => Reflect; void leaked'],
    ['store-forward', 'const leaked = { value: Reflect }; void leaked'],
    ['pass-forward', 'const sink = (value: unknown) => value; sink(Reflect)'],
    ['export-forward', 'export const leakedRound52Reflect = Reflect.get']
  ]
  const descriptorCases = [
    ['object-member-direct', 'const leaked = Object.getOwnPropertyDescriptor; void leaked'],
    ['receiver-alias', 'const receiver = Object; const leaked = receiver.getOwnPropertyDescriptor; void leaked'],
    ['member-alias', 'const first = Object.getOwnPropertyDescriptor; const leaked = first; void leaked'],
    ['destructured-member', 'const { getOwnPropertyDescriptor: leaked } = Object; void leaked'],
    ['reflect-variant', 'const leaked = Reflect.getOwnPropertyDescriptor; void leaked'],
    ['element-member', 'const leaked = Object["getOwnPropertyDescriptor"]; void leaked'],
    ['return-forward', 'const leaked = () => Object.getOwnPropertyDescriptor; void leaked'],
    ['store-forward', 'const leaked = { value: Object.getOwnPropertyDescriptor }; void leaked'],
    ['pass-forward', 'const sink = (value: unknown) => value; sink(Object.getOwnPropertyDescriptor)'],
    ['export-forward', 'export const leakedRound52Descriptor = Object.getOwnPropertyDescriptor']
  ]
  assert.equal(reflectCases.length, 10)
  assert.equal(descriptorCases.length, 10)
  assert.equal(new Set(reflectCases.map(([id]) => id)).size, 10)
  assert.equal(new Set(descriptorCases.map(([id]) => id)).size, 10)
  for (const [id, source] of reflectCases) {
    assert.ok(
      capabilityFixtureFailures(source).includes(capabilityReasons.reflectiveAcquisition),
      `Reflect acquisition case: ${id}`
    )
  }
  for (const [id, source] of descriptorCases) {
    assert.ok(
      capabilityFixtureFailures(source).includes(capabilityReasons.descriptorAcquisition),
      `descriptor acquisition case: ${id}`
    )
  }
  assert.deepEqual(capabilityFixtureFailures(`
const safeOwnKeys = (value: object) => Reflect.ownKeys(value)
const safePrototype = Object.getPrototypeOf({ synthetic: true })
type SafeOwnKeys = typeof Reflect.ownKeys
const safeLiteral = { mode: "SYNTHETIC" } as const
void safeOwnKeys({})
void safePrototype
void safeLiteral
`), [])
})

test('Round 5.3 shorthand capability references are rejected before stored provenance can escape', () => {
  const cases = [
    ['shorthand-store', 'const box = { Reflect }; void box'],
    [
      'shorthand-member-forward',
      'const box = { Reflect }; const member = box.Reflect.getOwnPropertyDescriptor; void member'
    ],
    [
      'shorthand-pass',
      'const sink = (value: unknown) => value; sink({ Reflect })'
    ],
    [
      'shorthand-export',
      'export const round53ShorthandBox = { Reflect }'
    ]
  ]
  assert.equal(cases.length, 4)
  assert.equal(new Set(cases.map(([id]) => id)).size, 4)
  for (const [id, source] of cases) {
    assert.ok(
      capabilityFixtureFailures(source).includes(capabilityReasons.reflectiveAcquisition),
      id
    )
  }
  assert.deepEqual(capabilityFixtureFailures(`
const safeOwnKeys = (value: object) => Reflect.ownKeys(value)
const safePrototype = Object.getPrototypeOf({ synthetic: true })
type SafeOwnKeys = typeof Reflect.ownKeys
const safeLiteral = { mode: "SYNTHETIC" } as const
void safeOwnKeys({})
void safePrototype
void safeLiteral
`), [])
})

test('Round 5.3 compiler inputs and declaration augmentations equal the seven-module manifest', () => {
  const compilerInputReason =
    'domain TypeScript compiler inputs and augmentations must equal the seven-module registered manifest'
  const relativeAugmentation = capabilityFixtureFailures(`
declare module "./types.js" {
  interface GovernanceActor {
    readonly round53Augmented?: string
  }
}
type Round53Visible = import("./types.js").GovernanceActor["round53Augmented"]
void (null as unknown as Round53Visible)
`, 'canonical.ts')
  assert.ok(relativeAugmentation.includes(compilerInputReason))

  const externalInput = capabilityExternalInputFailures({
    declaration: 'interface Round53ExternalCompilerInput { readonly synthetic?: true }\n'
  })
  assert.ok(externalInput.includes(compilerInputReason))

  const mergedLib = capabilityExternalInputFailures({
    declaration: `interface ObjectConstructor {
  getOwnPropertyDescriptor(
    value: object,
    key: PropertyKey,
  ): PropertyDescriptor | undefined
}
`
  })
  assert.ok(mergedLib.includes(compilerInputReason))
  assert.equal(
    mergedLib.some((reason) =>
      reason.includes('round53') || reason.includes('SENTINEL') || reason.includes('/')),
    false
  )
})

test('Round 5.4 canonical ownership-first trust classifies every Program input exactly', () => {
  const compilerInputReason = capabilityReasons.compilerInput
  assert.deepEqual(programInputTrustStats(), {
    counts: {
      repository: 7,
      typescriptLib: 63,
      auditedDependency: 3,
      rejected: 0
    },
    exact: true
  })
  assert.equal(registeredProgramInputManifest.repository.length, 7)
  assert.equal(registeredProgramInputManifest.typescriptLib.length, 63)
  assert.equal(registeredProgramInputManifest.auditedDependency.length, 3)

  const referencedFailures = (configure) => {
    const root = capabilityFixtureRoot()
    const reference = configure(root)
    const referencePath = resolve(root, 'packages/domain/src/canonical.ts')
    writeFileSync(
      referencePath,
      `/// <reference path=${JSON.stringify(reference)} />\n${readFileSync(referencePath, 'utf8')}`
    )
    return collectCapabilityFailures(root)
  }
  const declaration =
    'interface Round54RepositoryOwnedInput { readonly synthetic?: true }\n'
  const cases = [
    ['ordinary-repo-dts', (root) => {
      const target = resolve(root, 'packages/domain/round54-regression.d.ts')
      writeFileSync(target, declaration)
      return '../round54-regression.d.ts'
    }],
    ['typescript-lib-shaped', (root) => {
      const target = resolve(
        root,
        'packages/domain/typescript/lib/lib.round54-regression.d.ts'
      )
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, declaration)
      return '../typescript/lib/lib.round54-regression.d.ts'
    }],
    ['node-modules-shaped', (root) => {
      const target = resolve(
        root,
        'packages/domain/vendor/node_modules/round54-regression.d.ts'
      )
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, declaration)
      return '../vendor/node_modules/round54-regression.d.ts'
    }],
    ['repo-symlink-to-external', (root) => {
      const external = mkdtempSync(join(tmpdir(), 'meal-agent-stage09p-r54-external-'))
      temporaryRoots.push(external)
      const externalTarget = resolve(external, 'round54-external.d.ts')
      writeFileSync(externalTarget, declaration)
      symlinkSync(externalTarget, resolve(root, 'packages/domain/round54-link.d.ts'))
      return '../round54-link.d.ts'
    }],
    ['external-symlink-to-repo', (root) => {
      const repositoryTarget = resolve(root, 'packages/domain/round54-owned.d.ts')
      writeFileSync(repositoryTarget, declaration)
      const external = mkdtempSync(join(tmpdir(), 'meal-agent-stage09p-r54-external-'))
      temporaryRoots.push(external)
      const externalLink = resolve(external, 'round54-link.d.ts')
      symlinkSync(repositoryTarget, externalLink)
      return externalLink
    }],
    ['unknown-external-dependency', () => {
      const external = mkdtempSync(join(tmpdir(), 'meal-agent-stage09p-r54-external-'))
      temporaryRoots.push(external)
      const target = resolve(external, 'round54-unknown.d.ts')
      writeFileSync(target, declaration)
      return target
    }]
  ]
  assert.equal(cases.length, 6)
  assert.equal(new Set(cases.map(([id]) => id)).size, 6)
  for (const [id, configure] of cases) {
    const failures = referencedFailures(configure)
    assert.deepEqual(failures, [compilerInputReason], id)
    assert.equal(failures.some((reason) => /round54|SENTINEL|\//u.test(reason)), false, id)
  }
})

test('Round 5.4 canonical TypeScript lib identity rejects every merged declaration', () => {
  assert.deepEqual(canonicalLibMemberIdentityFailures(''), [])
  assert.deepEqual(canonicalLibMemberIdentityFailures(`
interface ObjectConstructor {
  getOwnPropertyDescriptor(
    value: object,
    key: PropertyKey,
  ): PropertyDescriptor | undefined
}
`), [capabilityReasons.libDeclarationIdentity])
})

test('all seven production modules have an exact fixed export-surface registry', () => {
  const modules = Object.keys(registeredModuleExportSurfaces).sort()
  assert.deepEqual(modules, [
    'canonical.ts', 'catalog.ts', 'decode.ts', 'index.ts', 'resolution.ts', 'types.ts',
    'validation.ts'
  ])
  assert.equal(modules.every((file) => registeredModuleExportSurfaces[file].length > 0), true)
  for (const [index, file] of modules.entries()) {
    const failures = capabilityFixtureFailures(
      `export const round52Unregistered${index} = "SYNTHETIC"`,
      file
    )
    assert.ok(failures.includes(capabilityReasons.moduleSurface), file)
  }
  assert.ok(
    capabilityFixtureFailures('export type Round52UnregisteredType = "SYNTHETIC"')
      .includes(capabilityReasons.moduleSurface)
  )
  assert.ok(
    capabilityFixtureFailures(
      'const round52LocalAlias = "SYNTHETIC"; export { round52LocalAlias as round52Alias }'
    ).includes(capabilityReasons.moduleSurface)
  )
})

test('descriptor calls require real declaration identity and seven exact structural sites', () => {
  assert.equal(registeredDescriptorCallSites.length, 7)
  assert.equal(new Set(registeredDescriptorCallSites).size, 7)
  assert.deepEqual(collectCapabilityFailures(), [])

  const sameNamedSpoof = capabilityFixtureFailures(`
const canonicalValue = (value: object, key: PropertyKey) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor === undefined ? undefined : descriptor.value
}
void canonicalValue
`)
  assert.ok(sameNamedSpoof.includes(capabilityReasons.descriptorCallSite))

  const declarationIdentitySpoof = capabilityMutatedFileFailures('canonical.ts', (source) =>
    `${source.replace('const canonicalValue =', 'var canonicalValue =')}
var canonicalValue: (value: unknown, ancestors: Set<object>) => string;
`
  )
  assert.ok(declarationIdentitySpoof.includes(capabilityReasons.descriptorCallSite))

  const duplicateDeclaration = capabilityFixtureFailures(
    'const canonicalValue = () => "SYNTHETIC_DUPLICATE"',
    'canonical.ts'
  )
  assert.ok(duplicateDeclaration.includes(capabilityReasons.semanticDiagnostics))

  const copiedCall = capabilityMutatedFileFailures('canonical.ts', (source) => source.replace(
    '      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");',
    `      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const copiedDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (copiedDescriptor === undefined || !("value" in copiedDescriptor)) {
        throw new TypeError("INVALID_SHAPE");
      }`
  ))
  assert.ok(copiedCall.includes(capabilityReasons.descriptorCallSite))

  assert.ok(
    capabilityFixtureFailures('const unresolvedRound52: MissingRound52Type = "SYNTHETIC"')
      .includes(capabilityReasons.semanticDiagnostics)
  )
  assert.ok(
    capabilityFixtureFailures('const syntacticallyBrokenRound52 =')
      .includes(capabilityReasons.syntaxDiagnostics)
  )
})

test('Round 5.3 descriptor receiver, key, and local-continuation mutations remain rejected', () => {
  assert.equal(registeredDescriptorSiteContracts.length, 7)
  assert.equal(new Set(registeredDescriptorSiteContracts.map(({ site }) => site)).size, 7)
  assert.deepEqual(
    registeredDescriptorSiteContracts.map(({ site }) => site).sort(),
    [...registeredDescriptorCallSites]
  )
  const receiverSubstitution = capabilityMutatedFileFailures('canonical.ts', (source) =>
    source.replace(
      'Object.getOwnPropertyDescriptor(value, "length")',
      'Object.getOwnPropertyDescriptor(ancestors, "length")'
    )
  )
  assert.ok(receiverSubstitution.includes(capabilityReasons.descriptorCallSite))

  const keySubstitution = capabilityMutatedFileFailures('canonical.ts', (source) =>
    source.replace(
      'Object.getOwnPropertyDescriptor(value, key)',
      'Object.getOwnPropertyDescriptor(value, "length")'
    )
  )
  assert.ok(keySubstitution.includes(capabilityReasons.descriptorCallSite))

  const localContinuationSubstitution = capabilityMutatedFileFailures('canonical.ts', (source) =>
    source.replace(
      '        items.push(canonicalValue(descriptor.value, ancestors));',
      `        const continued = descriptor.value;
        items.push(canonicalValue(continued, ancestors));`
    )
  )
  assert.ok(localContinuationSubstitution.includes(capabilityReasons.descriptorCallSite))
  assert.deepEqual(collectCapabilityFailures(), [])
})

test('Round 5.4 descriptor contracts freeze complete owner control and sink structure', () => {
  assert.equal(Object.keys(registeredDescriptorOwnerFingerprints).length, 4)
  assert.equal(
    Object.values(registeredDescriptorOwnerFingerprints)
      .every((value) => /^sha256:[0-9a-f]{64}$/u.test(value)),
    true
  )
  assert.equal(
    registeredDescriptorSiteContracts.every(({ ownerFingerprint }) =>
      Object.values(registeredDescriptorOwnerFingerprints).includes(ownerFingerprint)),
    true
  )
  const cases = [
    [
      'dead-branch',
      'canonical.ts',
      (source) => source.replace(
        '        items.push(canonicalValue(descriptor.value, ancestors));',
        `        if (!ancestors.has(value)) {
          items.push(canonicalValue(descriptor.value, ancestors));
        }`
      )
    ],
    [
      'conditional-substitution',
      'canonical.ts',
      (source) => source.replace(
        '        items.push(canonicalValue(descriptor.value, ancestors));',
        `        items.push(canonicalValue(
          !ancestors.has(value) ? descriptor.value : "SYNTHETIC",
          ancestors,
        ));`
      )
    ],
    [
      'other-sink-argument',
      'canonical.ts',
      (source) => source.replace(
        '        items.push(canonicalValue(descriptor.value, ancestors));',
        '        items.push(canonicalValue(descriptor.value, new Set<object>()));'
      )
    ],
    [
      'redirect-assignment-target',
      'decode.ts',
      (source) => source.replace(
        '    values[stringKey] = (descriptor as PropertyDescriptor & { value: unknown }).value;',
        '    values["round54Redirect"] = (descriptor as PropertyDescriptor & { value: unknown }).value;'
      )
    ],
    [
      'assignment-under-dead-branch',
      'decode.ts',
      (source) => source.replace(
        '    values[stringKey] = (descriptor as PropertyDescriptor & { value: unknown }).value;',
        `    if (false) {
      values[stringKey] = (descriptor as PropertyDescriptor & { value: unknown }).value;
    }`
      )
    ],
    [
      'redirect-define-property-key',
      'decode.ts',
      (source) => source.replace(
        '      Object.defineProperty(decoded, stringKey, {',
        '      Object.defineProperty(decoded, "round54Redirect", {'
      )
    ]
  ]
  assert.equal(cases.length, 6)
  assert.equal(new Set(cases.map(([id]) => id)).size, 6)
  for (const [id, file, mutate] of cases) {
    assert.deepEqual(
      capabilityMutatedFileFailures(file, mutate),
      [capabilityReasons.descriptorCallSite],
      id
    )
  }
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

test('schema closure recursively distinguishes all eight governed keyword families', () => {
  const base = () => ({
    $defs: {
      scalarString: { type: 'string', format: 'unicode-scalar' }
    }
  })
  const fixtures = [
    [schemaClosureReasons.ref, { $ref: '#/$defs/missing' }],
    [schemaClosureReasons.allOf, { allOf: {} }],
    [schemaClosureReasons.oneOf, { oneOf: {} }],
    [schemaClosureReasons.items, { type: 'array', items: { type: 'string' } }],
    [schemaClosureReasons.additionalProperties, {
      type: 'object', additionalProperties: { type: 'string' }
    }],
    [schemaClosureReasons.propertyNames, {
      type: 'object', propertyNames: { type: 'string' }
    }],
    [schemaClosureReasons.const, { const: 'SYNTHETIC_CONST' }],
    [schemaClosureReasons.enum, { enum: ['SYNTHETIC_ENUM'] }]
  ]
  for (const [reason, value] of fixtures) {
    const schema = base()
    schema.$defs.value = value
    assert.deepEqual(collectSchemaStringClosureFailures(schema), [reason], reason)
  }
})

test('each schema closure keyword guard has an executable deletion witness', () => {
  const fixtures = [
    [schemaClosureReasons.ref, `{ $ref: '#/$defs/missing' }`],
    [schemaClosureReasons.allOf, `{ allOf: {} }`],
    [schemaClosureReasons.oneOf, `{ oneOf: {} }`],
    [schemaClosureReasons.items, `{ type: 'array', items: { type: 'string' } }`],
    [schemaClosureReasons.additionalProperties, `{ type: 'object', additionalProperties: { type: 'string' } }`],
    [schemaClosureReasons.propertyNames, `{ type: 'object', propertyNames: { type: 'string' } }`],
    [schemaClosureReasons.const, `{ const: 'SYNTHETIC_CONST' }`],
    [schemaClosureReasons.enum, `{ enum: ['SYNTHETIC_ENUM'] }`]
  ]
  for (const [reason, fixture] of fixtures) {
    const key = Object.entries(schemaClosureReasons).find(([, value]) => value === reason)[0]
    const checkerBefore = readFileSync(resolve(repositoryRoot, 'scripts/check-stage09p-m0-scope.mjs'))
    const outcome = runScopeCheckerMutation({
      mutateChecker: (source) => source.replace(
        `      failures.push(schemaClosureReasons.${key})`,
        '      void failures'
      ),
      witness: `import {
  collectSchemaStringClosureFailures,
  schemaClosureReasons
} from './scripts/check-stage09p-m0-scope.mjs'
const schema = { $defs: {
  scalarString: { type: 'string', format: 'unicode-scalar' },
  value: ${fixture}
} }
assert.deepEqual(
  collectSchemaStringClosureFailures(schema),
  [schemaClosureReasons.${key}],
  schemaClosureReasons.${key}
)`
    })
    assertTargetedMutationFailure(outcome, reason)
    assert.deepEqual(
      readFileSync(resolve(repositoryRoot, 'scripts/check-stage09p-m0-scope.mjs')),
      checkerBefore,
      `${key} witness must restore the production checker byte-for-byte`
    )
  }
})

test('governance string lexical contract is scalar-first across all schema families', () => {
  assert.deepEqual(collectGovernanceStringParityFailures(), [])
  assert.deepEqual(governanceStringEvidenceStats(), {
    count: 51,
    uniqueIds: 51,
    registeredIdOrderMatches: true,
    uniqueMaterials: 51,
    expectedDifferences: {
      ajvRawVsDecoderRaw: 6,
      ajvTextVsDecoderJson: 6,
      ajvRawVsFinalValidator: 0
    },
    expectedAccepts: {
      ajvRaw: 17,
      ajvText: 17,
      decoderRaw: 23,
      decoderJson: 23,
      finalValidator: 17
    }
  })
  assert.deepEqual(governanceStringLayerStats(), {
    executed: 51,
    accepts: {
      ajvRaw: 17,
      ajvText: 17,
      decoderRaw: 23,
      decoderJson: 23,
      finalValidator: 17
    },
    differences: {
      ajvRawVsDecoderRaw: 6,
      ajvTextVsDecoderJson: 6,
      ajvRawVsFinalValidator: 0
    }
  })
  assert.deepEqual(schemaExtensionExecutionStats(), {
    unicodeScalar: 1334,
    canonicalInstant: 120,
    notNegativeZero: 6
  })
  const mappingPattern = evaluateGovernanceStringLayers().find(
    ({ id }) => id === 'mapping-id:invalid-pattern'
  )
  assert.deepEqual(mappingPattern?.actual, {
    ajvRaw: false,
    ajvText: false,
    decoderRaw: true,
    decoderJson: true,
    finalValidator: false
  })
  const mutations = [
    {
      name: 'unified scalar base',
      mutate: (schema) => { delete schema.$defs.scalarString.format },
      reason: schemaClosureReasons.ref
    },
    {
      name: 'nonEmptyString scalar inheritance',
      mutate: (schema) => {
        schema.$defs.nonEmptyString = { type: 'string', minLength: 1 }
      },
      reason: schemaClosureReasons.ref
    },
    {
      name: 'bare array-item string',
      mutate: (schema) => {
        schema.$defs.governanceEnvelope.properties.applicableRegions.items = { type: 'string' }
      },
      reason: schemaClosureReasons.items
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
        current.reason
      ),
      current.name
    )
  }
})

test('governance string evidence guards report count, unique IDs, registry, materials, layering, and oracle independently', () => {
  const root = fixtureRoot('data/schemas', 'data/samples/stage09p-m0')
  const base = governanceStringCases(root)
  assert.deepEqual(base.map(({ id }) => id), GOVERNANCE_STRING_CASE_IDS)
  assert.deepEqual(collectGovernanceStringParityFailures(root, base), [])
  assert.deepEqual(collectGovernanceStringParityFailures(root, base.slice(0, -1)), [
    governanceStringReasons.count
  ])
  assert.deepEqual(collectGovernanceStringParityFailures(root, base.map((current) =>
    current.id === 'owner-role:astral' ? { ...current, id: 'owner-actor-id:astral' } : current
  )), [governanceStringReasons.idDistinct])
  assert.deepEqual(collectGovernanceStringParityFailures(root, base.map((current, index) => ({
    ...current,
    id: `renamed-${String(index).padStart(2, '0')}`
  }))), [governanceStringReasons.idRegistry])
  assert.deepEqual(collectGovernanceStringParityFailures(root, base.map((current) =>
    current.id === 'owner-role:astral' ? { ...current, id: 'owner-role:renamed' } : current
  )), [governanceStringReasons.idRegistry])
  assert.deepEqual(collectGovernanceStringParityFailures(root, base.map((current) =>
    current.id === 'owner-role:astral'
      ? { ...current, input: base.find(({ id }) => id === 'owner-actor-id:astral').input }
      : current
  )), [governanceStringReasons.materialDistinct])
  assert.deepEqual(collectGovernanceStringParityFailures(root, base.map((current) =>
    current.id === 'owner-role:astral'
      ? { ...current, expected: { ...current.expected, ajvRaw: false } }
      : current
  )), [governanceStringReasons.layering])
  const hostile = [...base]
  hostile[0] = {
    id: base[0].id,
    kind: base[0].kind,
    get input() { throw new Error('SYNTHETIC_ORACLE_FAILURE') },
    expected: base[0].expected
  }
  assert.deepEqual(collectGovernanceStringParityFailures(root, hostile), [
    governanceStringReasons.oracle
  ])
})

test('each governance string evidence guard has an executable deletion witness', () => {
  const witnesses = [
    {
      reason: governanceStringReasons.count,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:governance-string-count */',
        '  if (stats.count !== GOVERNANCE_STRING_CASE_COUNT) failures.push(governanceStringReasons.count)',
        '  void stats.count'
      ),
      cases: 'governanceStringCases(repositoryRoot).slice(0, -1)'
    },
    {
      reason: governanceStringReasons.idDistinct,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:governance-string-id-distinct */',
        `  if (stats.count === GOVERNANCE_STRING_CASE_COUNT && stats.uniqueIds !== stats.count) {
    failures.push(governanceStringReasons.idDistinct)
  }`,
        '  void stats.uniqueIds'
      ),
      cases: `governanceStringCases(repositoryRoot).map((current) =>
  current.id === 'owner-role:astral' ? { ...current, id: 'owner-actor-id:astral' } : current)`
    },
    {
      reason: governanceStringReasons.idRegistry,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:governance-string-id-registry */',
        `  if (
    stats.count === GOVERNANCE_STRING_CASE_COUNT && stats.uniqueIds === stats.count &&
    !stats.registeredIdOrderMatches
  ) failures.push(governanceStringReasons.idRegistry)`,
        '  void stats.registeredIdOrderMatches'
      ),
      cases: `governanceStringCases(repositoryRoot).map((current, index) => ({
  ...current,
  id: 'renamed-' + String(index).padStart(2, '0')
}))`
    },
    {
      reason: governanceStringReasons.materialDistinct,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:governance-string-material-distinct */',
        '  if (stats.uniqueMaterials !== stats.count) failures.push(governanceStringReasons.materialDistinct)',
        '  void stats.uniqueMaterials'
      ),
      cases: `(() => {
  const base = governanceStringCases(repositoryRoot)
  const duplicate = base.find(({ id }) => id === 'owner-actor-id:astral').input
  return base.map((current) => current.id === 'owner-role:astral'
    ? { ...current, input: duplicate }
    : current)
})()`
    },
    {
      reason: governanceStringReasons.layering,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:governance-string-layering */',
        '      ) failures.push(governanceStringReasons.layering)',
        '      ) void actual'
      ),
      cases: `governanceStringCases(repositoryRoot).map((current) =>
  current.id === 'owner-role:astral'
    ? { ...current, expected: { ...current.expected, ajvRaw: false } }
    : current)`
    },
    {
      reason: governanceStringReasons.oracle,
      mutateChecker: (source) => deleteCheckerGuard(
        source,
        '/* guard:governance-string-oracle */',
        '  failures.push(governanceStringReasons.oracle)',
        '  void failures'
      ),
      cases: `(() => {
  const base = [...governanceStringCases(repositoryRoot)]
  base[0] = {
    id: base[0].id,
    kind: base[0].kind,
    get input() { throw new Error('SYNTHETIC') },
    expected: base[0].expected
  }
  return base
})()`
    }
  ]
  for (const current of witnesses) {
    const checkerBefore = readFileSync(resolve(repositoryRoot, 'scripts/check-stage09p-m0-scope.mjs'))
    const outcome = runScopeCheckerMutation({
      mutateChecker: current.mutateChecker,
      witness: `import {
  collectGovernanceStringParityFailures,
  governanceStringCases,
  governanceStringReasons,
  repositoryRoot
} from './scripts/check-stage09p-m0-scope.mjs'
const cases = ${current.cases}
assert.deepEqual(
  collectGovernanceStringParityFailures(repositoryRoot, cases),
  [${JSON.stringify(current.reason)}],
  ${JSON.stringify(current.reason)}
)`
    })
    assertTargetedMutationFailure(outcome, current.reason)
    assert.deepEqual(
      readFileSync(resolve(repositoryRoot, 'scripts/check-stage09p-m0-scope.mjs')),
      checkerBefore,
      'governance witness must restore the production checker byte-for-byte'
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
    },
    {
      reason: capabilityReasons.valueProvenance,
      productionAppend: 'const impostor = { trim: () => "LOCAL" } as any as string; export const witness = () => impostor.trim()',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.valueProvenance)',
        '  void failures'
      )
    },
    {
      reason: capabilityReasons.reflectiveAcquisition,
      productionAppend: 'const reflectAlias = Reflect; export const leaked = reflectAlias.get(() => undefined, "constructor")',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.reflectiveAcquisition)',
        '  void failures'
      )
    },
    {
      reason: capabilityReasons.descriptorAcquisition,
      productionAppend: 'const descriptor = Object.getOwnPropertyDescriptor(() => undefined, "constructor"); export const leaked = descriptor?.value',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.descriptorAcquisition)',
        '  void failures'
      )
    },
    {
      reason: capabilityReasons.capabilitySource,
      productionAppend: 'void crypto',
      mutateChecker: (source) => source.replace(
        '        failures.push(capabilityReasons.capabilitySource)',
        '        void failures'
      )
    },
    {
      reason: capabilityReasons.publicSurface,
      productionFile: 'index.ts',
      productionAppend: 'export { createValidatedCatalogIndex } from "./catalog.js"',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.moduleSurface)',
        '  void failures'
      )
    }
  ]
  for (const current of witnesses) {
    const outcome = runScopeCheckerMutation({
      mutateChecker: current.mutateChecker,
      productionAppend: current.productionAppend,
      productionFile: current.productionFile,
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

test('Round 5.2 acquisition, module, declaration, diagnostics, and call-site guards have targeted witnesses', () => {
  const descriptorDeclarationSpoof = (source) =>
    `${source.replace('const dataObject =', 'var dataObject =')}
var dataObject: (
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
) => Readonly<Record<string, unknown>>;
`
  const witnesses = [
    {
      reason: capabilityReasons.reflectiveAcquisition,
      productionAppend: 'const round52ReflectForward = Reflect.get; void round52ReflectForward',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.reflectiveAcquisition)',
        '  void failures'
      )
    },
    {
      reason: capabilityReasons.descriptorAcquisition,
      productionAppend: 'const round52DescriptorForward = Object.getOwnPropertyDescriptor; void round52DescriptorForward',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.descriptorAcquisition)',
        '  void failures'
      )
    },
    {
      reason: capabilityReasons.moduleSurface,
      productionAppend: 'export const round52UnregisteredSurface = "SYNTHETIC"',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.moduleSurface)',
        '  void failures'
      )
    },
    {
      reason: capabilityReasons.descriptorCallSite,
      productionFile: 'decode.ts',
      mutateProduction: descriptorDeclarationSpoof,
      mutateChecker: (source) => source.replace(
        `  return symbol !== undefined && symbol.declarations?.length === 1 &&
    symbol.declarations[0] === declaration`,
        '  return true'
      )
    },
    {
      reason: capabilityReasons.semanticDiagnostics,
      productionAppend: 'const round52SemanticFailure: string = 42',
      mutateChecker: (source) => source.replace(
        '  failures.push(capabilityReasons.semanticDiagnostics)',
        '  void failures'
      )
    },
    {
      reason: capabilityReasons.descriptorCallSite,
      productionAppend: `const round52UnregisteredDescriptorOwner = () => {
  const descriptor = Object.getOwnPropertyDescriptor({}, "synthetic")
  return descriptor === undefined ? undefined : descriptor.value
}
void round52UnregisteredDescriptorOwner`,
      mutateChecker: (source) => source.replace(
        `          } else if (directDescriptorCallIdentity(node, checker)) {
            recordDescriptorCallSiteFailure(failures)`,
        `          } else if (directDescriptorCallIdentity(node, checker)) {
            void failures`
      )
    }
  ]
  assert.equal(witnesses.length, 6)
  for (const [index, current] of witnesses.entries()) {
    const outcome = runScopeCheckerMutation({
      mutateChecker: current.mutateChecker,
      productionAppend: current.productionAppend,
      productionFile: current.productionFile,
      mutateProduction: current.mutateProduction,
      witness: `import {
  capabilityReasons,
  collectCapabilityFailures,
  repositoryRoot
} from './scripts/check-stage09p-m0-scope.mjs'
const failures = collectCapabilityFailures(repositoryRoot)
assert.equal(
  failures.includes(${JSON.stringify(current.reason)}),
  true,
  ${JSON.stringify(current.reason)}
)`
    })
    assertTargetedMutationFailure(outcome, current.reason, `Round 5.2 witness ${index + 1}`)
  }
})

test('Round 5.3 shorthand, compiler-input, augmentation, and options guards retain targeted witnesses', () => {
  const compilerInputReason = capabilityReasons.compilerInput
  const addExternalInput = (root, declaration) => {
    const referencePath = resolve(root, 'packages/domain/src/canonical.ts')
    writeFileSync(
      referencePath,
      `/// <reference path="../round53-witness.d.ts" />\n${readFileSync(referencePath, 'utf8')}`
    )
    writeFileSync(resolve(root, 'packages/domain/round53-witness.d.ts'), declaration)
  }
  const witnesses = [
    {
      id: 'shorthand-reference',
      reason: capabilityReasons.reflectiveAcquisition,
      productionAppend: 'const round53Box = { Reflect }; void round53Box',
      mutateChecker: (source) => source.replace(
        `    ts.isPropertyAssignment(parent) && parent.name === node
    /* guard:shorthand-reference-provenance */`,
        `    ts.isPropertyAssignment(parent) && parent.name === node ||
    ts.isShorthandPropertyAssignment(parent)
    /* guard:shorthand-reference-provenance:weakened */`
      )
    },
    {
      id: 'compiler-input-manifest',
      reason: compilerInputReason,
      mutateFixture: (root) => addExternalInput(
        root,
        'interface Round53WitnessInput { readonly synthetic?: true }\n'
      ),
      mutateChecker: (source) => source.replace(
        '    if (!compilerInputsEqualRegisteredManifest(root, program, sourceFiles)) {',
        '    if (false && !compilerInputsEqualRegisteredManifest(root, program, sourceFiles)) {'
      )
    },
    {
      id: 'relative-module-augmentation',
      reason: compilerInputReason,
      productionFile: 'canonical.ts',
      productionAppend: `declare module "./types.js" {
  interface GovernanceActor { readonly round53Witness?: string }
}
type Round53WitnessVisible = import("./types.js").GovernanceActor["round53Witness"]
void (null as unknown as Round53WitnessVisible)`,
      mutateChecker: (source) => source.replace(
        '    if (treeContainsDeclarationAugmentation(tree)) recordCompilerInputFailure(failures)',
        '    if (false && treeContainsDeclarationAugmentation(tree)) recordCompilerInputFailure(failures)'
      )
    },
    {
      id: 'options-diagnostics',
      reason: capabilityReasons.optionsDiagnostics,
      mutateChecker: (source) => source
        .replace('    module: ts.ModuleKind.NodeNext,', '    module: ts.ModuleKind.CommonJS,')
        .replace(
          '  failures.push(capabilityReasons.optionsDiagnostics)',
          '  void failures'
        )
    }
  ]
  assert.equal(witnesses.length, 4)
  assert.equal(new Set(witnesses.map(({ id }) => id)).size, 4)
  for (const current of witnesses) {
    const outcome = runScopeCheckerMutation({
      mutateChecker: current.mutateChecker,
      productionAppend: current.productionAppend,
      productionFile: current.productionFile,
      mutateProduction: current.mutateProduction,
      mutateFixture: current.mutateFixture,
      witness: `import {
  capabilityReasons,
  collectCapabilityFailures,
  repositoryRoot
} from './scripts/check-stage09p-m0-scope.mjs'
const target = ${JSON.stringify(current.reason)}
const failures = collectCapabilityFailures(repositoryRoot)
if (failures.includes(target)) process.exit(0)
if (failures.length !== 0) {
  process.stderr.write('WRONG_REASON')
  process.exit(2)
}
process.stderr.write(target)
process.exit(1)`
    })
    assertTargetedMutationFailure(outcome, current.reason, current.id)
  }
})

test('Round 5.4 compiler input, canonical lib identity, and owner freeze have independent witnesses', () => {
  const ownerMutation = (source) => source.replace(
    '        items.push(canonicalValue(descriptor.value, ancestors));',
    `        if (!ancestors.has(value)) {
          items.push(canonicalValue(descriptor.value, ancestors));
        }`
  )
  const witnesses = [
    {
      id: 'compiler-input-exact-set',
      reason: capabilityReasons.compilerInput,
      mutateFixture: (root) => {
        const referencePath = resolve(root, 'packages/domain/src/canonical.ts')
        writeFileSync(
          referencePath,
          `/// <reference path="../typescript/lib/lib.round54-witness.d.ts" />\n${readFileSync(referencePath, 'utf8')}`
        )
        const target = resolve(
          root,
          'packages/domain/typescript/lib/lib.round54-witness.d.ts'
        )
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, 'interface Round54CompilerInputWitness {}\n')
      },
      mutateChecker: (source) => source.replace(
        '    if (!compilerInputsEqualRegisteredManifest(root, program, sourceFiles)) {',
        '    if (false && !compilerInputsEqualRegisteredManifest(root, program, sourceFiles)) {'
      ),
      witness: `import {
  capabilityReasons,
  collectCapabilityFailures,
  repositoryRoot
} from './scripts/check-stage09p-m0-scope.mjs'
const target = capabilityReasons.compilerInput
const failures = collectCapabilityFailures(repositoryRoot)
if (failures.includes(target)) process.exit(0)
if (failures.length !== 0) {
  process.stderr.write('WRONG_REASON')
  process.exit(2)
}
process.stderr.write(target)
process.exit(1)`
    },
    {
      id: 'canonical-lib-all-declarations',
      reason: capabilityReasons.libDeclarationIdentity,
      mutateChecker: (source) => source
        .replace(
          `  /* guard:canonical-lib-all-declarations */
  if (identities.some((identity) => identity === null)) return null`,
          `  /* guard:canonical-lib-all-declarations:weakened */
  const trustedIdentities = identities.filter((identity) => identity !== null)
  if (trustedIdentities.length === 0) return null`
        )
        .replace(
          "  return `${expectedName}|${identities.sort().join(',')}`",
          "  return `${expectedName}|${trustedIdentities.sort().join(',')}`"
        ),
      witness: `import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  capabilityReasons,
  collectTypescriptLibSymbolIdentityFailures,
  repositoryRoot
} from './scripts/check-stage09p-m0-scope.mjs'
const declarationPath = resolve(repositoryRoot, 'round54-lib-identity-witness.d.ts')
const usePath = resolve(repositoryRoot, 'round54-lib-identity-use.ts')
writeFileSync(declarationPath, \`interface ObjectConstructor {
  getOwnPropertyDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined
}
\`)
writeFileSync(usePath, 'const witness = Object.getOwnPropertyDescriptor\\nvoid witness\\n')
const program = ts.createProgram({
  rootNames: [declarationPath, usePath],
  options: {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: []
  }
})
const tree = program.getSourceFile(usePath)
const checker = program.getTypeChecker()
let member
const visit = (node) => {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'getOwnPropertyDescriptor') {
    member = checker.getSymbolAtLocation(node.name)
  }
  ts.forEachChild(node, visit)
}
visit(tree)
const target = capabilityReasons.libDeclarationIdentity
const failures = collectTypescriptLibSymbolIdentityFailures(
  member,
  'getOwnPropertyDescriptor'
)
if (failures.includes(target)) process.exit(0)
if (failures.length !== 0) {
  process.stderr.write('WRONG_REASON')
  process.exit(2)
}
process.stderr.write(target)
process.exit(1)`
    },
    {
      id: 'descriptor-reviewed-owner-ast',
      reason: capabilityReasons.descriptorCallSite,
      productionFile: 'canonical.ts',
      mutateProduction: ownerMutation,
      mutateChecker: (source) => source.replace(
        '  if (observed.ownerFingerprint !== expected.ownerFingerprint) return false',
        '  void observed.ownerFingerprint'
      ),
      witness: `import {
  capabilityReasons,
  collectCapabilityFailures,
  repositoryRoot
} from './scripts/check-stage09p-m0-scope.mjs'
const target = capabilityReasons.descriptorCallSite
const failures = collectCapabilityFailures(repositoryRoot)
if (failures.includes(target)) process.exit(0)
if (failures.length !== 0) {
  process.stderr.write('WRONG_REASON')
  process.exit(2)
}
process.stderr.write(target)
process.exit(1)`
    }
  ]
  assert.equal(witnesses.length, 3)
  assert.equal(new Set(witnesses.map(({ id }) => id)).size, 3)
  for (const current of witnesses) {
    const outcome = runScopeCheckerMutation({
      mutateChecker: current.mutateChecker,
      productionFile: current.productionFile,
      mutateProduction: current.mutateProduction,
      mutateFixture: current.mutateFixture,
      witness: current.witness
    })
    assertTargetedMutationFailure(outcome, current.reason, current.id)
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
    },
    {
      file: 'src/validation.ts',
      expectedTest: 'hard mapping identifiers satisfy the governed synthetic namespace at final validation',
      mutate: (source) => source.replace(
        `    if (!mappingIdPattern.test(mapping.mappingId)) {
      issues.push(issue("INVALID_SHAPE", \`hardMappings/\${index}/mappingId\`));
    }
`,
        ''
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
