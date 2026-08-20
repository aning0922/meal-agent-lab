import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  m5ProductionGuards,
  m5ProtectedEntrypoints
} from '../../infra/docker/m5-production-guard-registry.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const requireFromApiWorkspace = createRequire(resolve(repositoryRoot, 'services/api/package.json'))
const ts = requireFromApiWorkspace('typescript')

const nearestStatement = (node) => {
  let current = node
  while (current !== undefined && !ts.isStatement(current)) current = current.parent
  return current
}

const nearestFunction = (node) => {
  let current = node.parent
  while (current !== undefined && !ts.isFunctionLike(current)) current = current.parent
  return current
}

const functionName = (node) => {
  if (node === undefined) return null
  if (node.name !== undefined && ts.isIdentifier(node.name)) return node.name.text
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text
  }
  return null
}

const placementMatches = (call, placement, sourceFile) => {
  const statement = nearestStatement(call)
  if (statement === undefined) return false
  if (placement.kind === 'source-direct') {
    if (!ts.isVariableStatement(statement) || statement.parent !== sourceFile) return false
    const declarations = statement.declarationList.declarations
    return (
      declarations.length === 1 &&
      ts.isIdentifier(declarations[0].name) &&
      declarations[0].name.text === placement.binding &&
      ts.isAwaitExpression(declarations[0].initializer) &&
      declarations[0].initializer.expression === call
    )
  }
  if (placement.kind === 'main-guard-direct') {
    const block = statement.parent
    return (
      ts.isExpressionStatement(statement) &&
      ts.isAwaitExpression(statement.expression) &&
      statement.expression.expression === call &&
      ts.isBlock(block) &&
      ts.isIfStatement(block.parent) &&
      block.parent.thenStatement === block &&
      block.parent.elseStatement === undefined &&
      block.parent.parent === sourceFile &&
      block.parent.expression
        .getText(sourceFile)
        .replace(/\s+/g, ' ') ===
        'process.argv[1] === fileURLToPath(import.meta.url)'
    )
  }
  const owner = nearestFunction(call)
  if (owner === undefined || owner.body === undefined || statement.parent !== owner.body) {
    return false
  }
  if (placement.kind === 'nearest-function-direct') return true
  return placement.kind === 'named-function-direct' && functionName(owner) === placement.name
}

const topLevelSymbol = (checker, sourceFile, name) => {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name
    ) {
      return checker.getSymbolAtLocation(statement.name)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          return checker.getSymbolAtLocation(declaration.name)
        }
      }
    }
  }
  return undefined
}

const resolvedSymbol = (checker, node) => {
  const symbol = checker.getSymbolAtLocation(node)
  return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol
}

const consumerCalls = (consumer, overrides = new Map()) => {
  const consumerAbsolute = resolve(repositoryRoot, consumer.path)
  const targetAbsolute = resolve(repositoryRoot, consumer.callee.path)
  const options = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext
  }
  const host = ts.createCompilerHost(options, true)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const relativeName = fileName.startsWith(`${repositoryRoot}/`)
      ? fileName.slice(repositoryRoot.length + 1)
      : null
    const override = relativeName === null ? undefined : overrides.get(relativeName)
    return override === undefined
      ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, override, languageVersion, true, ts.ScriptKind.JS)
  }
  const program = ts.createProgram({
    rootNames: [...new Set([consumerAbsolute, targetAbsolute])],
    options,
    host
  })
  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(consumerAbsolute)
  const targetFile = program.getSourceFile(targetAbsolute)
  assert.notEqual(sourceFile, undefined, `consumer source was not parsed: ${consumer.path}`)
  assert.notEqual(targetFile, undefined, `guard declaration source was not parsed: ${consumer.callee.path}`)
  const targetSymbol = topLevelSymbol(checker, targetFile, consumer.callee.name)
  assert.notEqual(
    targetSymbol,
    undefined,
    `guard declaration disappeared: ${consumer.callee.path}#${consumer.callee.name}`
  )
  const calls = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (resolvedSymbol(checker, node.expression) === targetSymbol) {
        calls.push(Object.freeze({
          call: node,
          statement: nearestStatement(node),
          placementValid: placementMatches(node, consumer.placement, sourceFile),
          sourceFile
        }))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

const productionConsumerProblems = (overrides = new Map()) => {
  const problems = []
  for (const guard of m5ProductionGuards) {
    for (const consumer of guard.consumers ?? []) {
      const calls = consumerCalls(consumer, overrides)
      const valid = calls.filter(({ placementValid }) => placementValid)
      if (calls.length !== consumer.count || valid.length !== consumer.count) {
        problems.push(`[${guard.id}] production consumer is not directly reachable: ${consumer.path}`)
      }
    }
  }
  return problems
}

const consumerSignature = (guardId, consumer) => [
  guardId,
  consumer.path,
  `${consumer.callee.path}#${consumer.callee.name}`,
  consumer.placement.kind,
  consumer.placement.name ?? '',
  consumer.placement.binding ?? '',
  String(consumer.count)
].join('|')

const expectedConsumerSignatures = Object.freeze([
  'aggregate-final-signal-delivery|scripts/run-stage09a-check.mjs|scripts/run-stage09a-check.mjs#settleAggregateProcess|source-direct||finalExitCode|1',
  'backup-pre-fork-declaration|infra/docker/backup-local-test.mjs|infra/docker/backup-local-test.mjs#runBackupCopyWithDeclaredOutput|nearest-function-direct|||1',
  'cleanup-signal-delivery-barrier|infra/docker/backup-local-test.mjs|infra/docker/m3b-subprocess.mjs#runSignalSettledCli|main-guard-direct|||1',
  'cleanup-signal-delivery-barrier|infra/docker/restore-local-test.mjs|infra/docker/m3b-subprocess.mjs#runSignalSettledCli|main-guard-direct|||1',
  'cleanup-signal-delivery-barrier|infra/docker/run-local-test-lifecycle.mjs|infra/docker/m3b-subprocess.mjs#runSignalSettledCli|main-guard-direct|||1',
  'cleanup-signal-delivery-barrier|infra/docker/run-local-test-restore-drill.mjs|infra/docker/m3b-subprocess.mjs#runSignalSettledCli|main-guard-direct|||1',
  'cleanup-signal-delivery-barrier|infra/docker/run-local-test-smoke.mjs|infra/docker/m3b-subprocess.mjs#runSignalSettledCli|main-guard-direct|||1',
  'runtime-scratch-final-settlement|infra/docker/api-image-scan.mjs|infra/docker/api-image-scan.mjs#settleTrackedRuntimeProbe|named-function-direct|scanImage||2',
  'scratch-capability|infra/docker/api-image-scan.mjs|infra/docker/api-image-scan.mjs#scratchCapabilityExpectation|named-function-direct|scanImage||4'
].sort())

const productionConsumerRegistryProblems = (registry = m5ProductionGuards) => {
  const signatures = registry
    .flatMap((guard) => (guard.consumers ?? []).map((consumer) =>
      consumerSignature(guard.id, consumer)))
    .sort()
  return signatures.length === new Set(signatures).size &&
      JSON.stringify(signatures) === JSON.stringify(expectedConsumerSignatures)
    ? []
    : ['production consumer registry did not match the exact required consumer set']
}

const expectedProtectedEntrypoints = Object.freeze([
  'infra/docker/backup-local-test.mjs',
  'infra/docker/restore-local-test.mjs',
  'infra/docker/run-local-test-smoke.mjs',
  'infra/docker/m4-lifecycle.mjs',
  'infra/docker/run-local-test-lifecycle.mjs',
  'infra/docker/run-local-test-restore-drill.mjs',
  'scripts/run-stage09a-check.mjs',
  'scripts/run-stage09a-audit-b.mjs'
])

const protectedExitCapabilityProblems = (overrides = new Map()) => {
  const rootNames = m5ProtectedEntrypoints.map((path) => resolve(repositoryRoot, path))
  const options = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext
  }
  const host = ts.createCompilerHost(options, true)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const relativeName = fileName.startsWith(`${repositoryRoot}/`)
      ? fileName.slice(repositoryRoot.length + 1)
      : null
    const override = relativeName === null ? undefined : overrides.get(relativeName)
    return override === undefined
      ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, override, languageVersion, true, ts.ScriptKind.JS)
  }
  const program = ts.createProgram({ rootNames, options, host })
  const problems = []
  for (const path of m5ProtectedEntrypoints) {
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, path))
    const processAliases = new Set(['process'])
    let changed = true
    while (changed) {
      changed = false
      const collectAliases = (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer !== undefined &&
          ts.isIdentifier(node.initializer) &&
          processAliases.has(node.initializer.text) &&
          !processAliases.has(node.name.text)
        ) {
          processAliases.add(node.name.text)
          changed = true
        }
        ts.forEachChild(node, collectAliases)
      }
      collectAliases(sourceFile)
    }
    const isProcessAlias = (node) =>
      ts.isIdentifier(node) && processAliases.has(node.text)
    const isExitMember = (node) =>
      (ts.isPropertyAccessExpression(node) &&
        isProcessAlias(node.expression) &&
        node.name.text === 'exit') ||
      (ts.isElementAccessExpression(node) &&
        isProcessAlias(node.expression) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'exit')
    const visit = (node) => {
      if (isExitMember(node)) {
        problems.push(`${path}: process.exit capability escaped the shared settlement boundary`)
      }
      if (
        ts.isBindingElement(node) &&
        (node.propertyName?.getText(sourceFile) ?? node.name.getText(sourceFile)) === 'exit'
      ) {
        const declaration = node.parent.parent
        const initializer = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined
        if (initializer !== undefined && isProcessAlias(initializer)) {
          problems.push(`${path}: process.exit capability escaped through destructuring`)
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(sourceFile) === 'Reflect.get' &&
        node.arguments.length >= 2 &&
        isProcessAlias(node.arguments[0]) &&
        ts.isStringLiteralLike(node.arguments[1]) &&
        node.arguments[1].text === 'exit'
      ) {
        problems.push(`${path}: process.exit capability escaped through reflection`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return problems
}

const replaceExactly = (source, needle, replacement) => {
  const first = source.indexOf(needle)
  assert.notEqual(first, -1, `production mutation anchor disappeared: ${needle}`)
  assert.equal(source.indexOf(needle, first + needle.length), -1, `mutation anchor duplicated: ${needle}`)
  return source.slice(0, first) + replacement + source.slice(first + needle.length)
}

const importFresh = (path, label) =>
  import(`${pathToFileURL(path).href}?mutation=${encodeURIComponent(label)}-${Date.now()}`)

const registeredGuardIds = new Set(m5ProductionGuards.map(({ id }) => id))
const executedGuardIds = new Set()
assert.equal(registeredGuardIds.size, m5ProductionGuards.length)
const guardTest = (id, name, operation) => {
  assert.equal(registeredGuardIds.has(id), true, `unregistered production guard: ${id}`)
  test(`[${id}] ${name}`, async () => {
    assert.equal(executedGuardIds.has(id), false, `duplicate production guard oracle: ${id}`)
    await operation()
    executedGuardIds.add(id)
  })
}
test.after(() => {
  assert.deepEqual([...executedGuardIds].sort(), [...registeredGuardIds].sort())
})

test('every declared production consumer resolves to its declaration and direct AST position', () => {
  assert.deepEqual(productionConsumerRegistryProblems(), [])
  assert.deepEqual([...m5ProtectedEntrypoints], [...expectedProtectedEntrypoints])
  assert.deepEqual(productionConsumerProblems(), [])
  assert.deepEqual(protectedExitCapabilityProblems(), [])
})

test('moving any registered consumer unchanged into if(false) is rejected', () => {
  for (const guard of m5ProductionGuards) {
    for (const consumer of guard.consumers ?? []) {
      const source = readFileSync(resolve(repositoryRoot, consumer.path), 'utf8')
      const [target] = consumerCalls(consumer).filter(({ placementValid }) => placementValid)
      assert.notEqual(target, undefined, `[${guard.id}] no live consumer was found`)
      const start = target.statement.getStart(target.sourceFile)
      const end = target.statement.getEnd()
      const mutant =
        source.slice(0, start) +
        `if (false) {\n${source.slice(start, end)}\n}` +
        source.slice(end)
      const problems = productionConsumerProblems(new Map([[consumer.path, mutant]]))
      assert.equal(
        problems.some((problem) => problem.startsWith(`[${guard.id}]`)),
        true,
        `[${guard.id}] a dead production consumer satisfied the registry`
      )
    }
  }
})

test('a same-name local function cannot impersonate the imported settlement capability', () => {
  const consumer = m5ProductionGuards
    .find(({ id }) => id === 'cleanup-signal-delivery-barrier')
    .consumers.find(({ path }) => path === 'infra/docker/backup-local-test.mjs')
  const source = readFileSync(resolve(repositoryRoot, consumer.path), 'utf8')
  const [target] = consumerCalls(consumer).filter(({ placementValid }) => placementValid)
  assert.notEqual(target, undefined)
  const start = target.statement.getStart(target.sourceFile)
  const mutant =
    source.slice(0, start) +
    'const runSignalSettledCli = async (operation) => operation()\n  ' +
    source.slice(start)
  const problems = productionConsumerProblems(new Map([[consumer.path, mutant]]))
  assert.equal(
    problems.some((problem) => problem.startsWith('[cleanup-signal-delivery-barrier]')),
    true
  )
})

test('main guards require the exact condition and a direct top-level await', () => {
  const consumer = m5ProductionGuards
    .find(({ id }) => id === 'cleanup-signal-delivery-barrier')
    .consumers.find(({ path }) => path === 'infra/docker/backup-local-test.mjs')
  const path = consumer.path
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutations = [
    source.replace(
      'process.argv[1] === fileURLToPath(import.meta.url)',
      "process.argv.includes('--invalid')"
    ),
    source.replace(
      'await runSignalSettledCli(async () => {',
      'false && await runSignalSettledCli(async () => {'
    ),
    source.replace(
      'await runSignalSettledCli(async () => {',
      'runSignalSettledCli(async () => {'
    ),
    source.replace(
      'await runSignalSettledCli(async () => {',
      'await runSignalSettledCli(async () => {'
    ).replace(
      '\n  })\n}',
      '\n  }).catch(() => undefined)\n}'
    )
  ]
  for (const mutant of mutations) {
    const problems = productionConsumerProblems(new Map([[path, mutant]]))
    assert.equal(
      problems.some((problem) => problem.startsWith('[cleanup-signal-delivery-barrier]')),
      true
    )
  }
})

test('the production registry requires every exact consumer path once', () => {
  const mutant = m5ProductionGuards.map((guard) => {
    if (guard.id !== 'cleanup-signal-delivery-barrier') return guard
    const consumers = guard.consumers.map((consumer) =>
      consumer.path === 'infra/docker/restore-local-test.mjs'
        ? Object.freeze({ ...consumer, path: 'infra/docker/backup-local-test.mjs' })
        : consumer)
    return Object.freeze({ ...guard, consumers: Object.freeze(consumers) })
  })
  assert.deepEqual(productionConsumerRegistryProblems(mutant), [
    'production consumer registry did not match the exact required consumer set'
  ])
})

test('protected production entrypoints cannot obtain the process.exit capability', () => {
  for (const path of m5ProtectedEntrypoints) {
    const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
    for (const addition of [
      'const exitNow = process.exit\n',
      "const exitNow = process['exit']\n",
      'const { exit: exitNow } = process\n',
      "const exitNow = Reflect.get(process, 'exit')\n"
    ]) {
      const problems = protectedExitCapabilityProblems(
        new Map([[path, `${source}\n${addition}`]])
      )
      assert.equal(problems.some((problem) => problem.startsWith(`${path}:`)), true)
    }
  }
})

guardTest('backup-pre-fork-declaration', 'the live backup guard is killed by an in-flight cleanup oracle', async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'm5-live-backup-declaration-mutant-'))
  const copiedDockerDirectory = join(temporaryRoot, 'infra/docker')
  cpSync(resolve(repositoryRoot, 'infra/docker'), copiedDockerDirectory, { recursive: true })
  const initialized = spawnSync('git', ['init', '-q'], { cwd: temporaryRoot, encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
  const backupPath = join(copiedDockerDirectory, 'backup-local-test.mjs')
  writeFileSync(backupPath, replaceExactly(
    readFileSync(backupPath, 'utf8'),
    'runWithDeclaredOwnedTreeOutputs(journal, [target], operation)',
    'operation()'
  ))
  const implementation = await importFresh(
    join(copiedDockerDirectory, 'backup-local-test.mjs'),
    'live-backup-declaration'
  )
  const outputDirectory = mkdtempSync(join(tmpdir(), 'm5-live-backup-declaration-output-'))
  const archiveBytes = Buffer.from('PGDMP-live-guard-fixture')
  const archiveDigest = createHash('sha256').update(archiveBytes).digest('hex')
  const containers = new Map()
  let cleanupTask = null
  let inFlightResidue = null
  let sequence = 0
  const absent = (name) => ({
    status: 1,
    signal: null,
    stdout: '',
    stderr: `Error response from daemon: No such container: ${name}\n`
  })
  const run = async (argv) => {
    if (argv[0] === 'docker' && argv[1] === 'container' && argv[2] === 'inspect') {
      const query = argv[3]
      const entry = [...containers.values()].find(
        (candidate) => candidate.name === query || candidate.id === query
      )
      if (entry === undefined) return absent(query)
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify([{
          Id: entry.id,
          Image: `sha256:${'d'.repeat(64)}`,
          Created: '2026-08-19T01:00:00Z',
          Name: `/${entry.name}`,
          Config: { Labels: {
            'com.meal-agent.m4.oneoff-owner': entry.token,
            'com.docker.compose.project': 'meal-agent-fixture',
            'com.docker.compose.service': entry.service,
            'com.docker.compose.oneoff': 'True'
          } },
          State: {
            Status: 'exited', Running: false, ExitCode: 0,
            StartedAt: '2026-08-19T01:00:00Z', FinishedAt: '2026-08-19T01:00:01Z'
          }
        }]),
        stderr: ''
      }
    }
    if (argv[0] === 'docker' && argv[1] === 'cp') {
      writeFileSync(argv[3], archiveBytes, { mode: 0o600 })
      inFlightResidue = await cleanupTask()
      return { status: 17, signal: null, stdout: '', stderr: 'UNTRUSTED' }
    }
    if (argv[0] === 'docker' && argv[1] === 'rm') {
      const id = argv.at(-1)
      for (const [name, entry] of containers) {
        if (entry.id === id) containers.delete(name)
      }
      return { status: 0, signal: null, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected fixture command: ${argv.join(' ')}`)
  }
  const compose = async (argv) => {
    const name = argv[argv.indexOf('--name') + 1]
    const token = argv[argv.indexOf('--label') + 1].split('=')[1]
    const transfer = argv.includes('backup-transfer-loader')
    sequence += 1
    containers.set(name, {
      name,
      id: String(sequence).padStart(64, transfer ? 'b' : 'a'),
      token,
      service: transfer ? 'backup-transfer-loader' : 'backup'
    })
    return {
      status: 0,
      signal: null,
      stdout: transfer ? '' : `${archiveDigest}  /transfer/fixture.dump\n`,
      stderr: ''
    }
  }
  try {
    await assert.rejects(
      implementation.performBackup(
        {
          compose,
          run,
          log: () => undefined,
          registerCleanup: (task) => {
            cleanupTask = task
            return () => true
          }
        },
        {
          project: 'meal-agent-fixture',
          outputDirectory,
          fileName: 'fixture.dump'
        }
      ),
      /one-off container handoff failed|backup artifact cleanup failed/
    )
    assert.deepEqual(inFlightResidue, ['backup partial directory cleanup failed'])
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

guardTest('publication-link-count', 'the production guards reject a multi-link publication mutant', async () => {
  const sourcePath = resolve(repositoryRoot, 'infra/docker/m5-evidence-protocol.mjs')
  let mutant = readFileSync(sourcePath, 'utf8')
  for (const guard of [
    'staged.nlink !== 2n',
    'published.nlink !== 2n',
    'solePublished.nlink !== 1n'
  ]) {
    mutant = replaceExactly(mutant, guard, 'false')
  }
  const directory = mkdtempSync(join(tmpdir(), 'm5-nlink-mutant-'))
  const modulePath = join(directory, 'protocol.mjs')
  writeFileSync(modulePath, mutant)
  const implementation = await importFresh(modulePath, 'nlink')
  const path = join(directory, 'artifact')
  const alias = join(directory, 'external-alias')
  const operations = {
    closeFile: closeSync,
    linkFile: (source, destination) => {
      linkSync(source, destination)
      linkSync(source, alias)
    },
    syncDirectory: () => undefined,
    syncFile: fsyncSync,
    unlinkFile: unlinkSync
  }
  try {
    const bytes = Buffer.from('durable mutation bytes')
    const identity = implementation.writeExclusiveEvidenceFile(path, bytes, { operations })
    assert.equal(lstatSync(path, { bigint: true }).nlink, 2n)
    assert.equal(implementation.verifyPublishedFileEvidence(identity, bytes), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

guardTest('cleanup-memoization', 'the guard is killed by a concurrent-call oracle', async () => {
  const sourcePath = resolve(repositoryRoot, 'infra/docker/m3b-subprocess.mjs')
  const source = readFileSync(sourcePath, 'utf8')
  const mutant = replaceExactly(
    source,
    `if (cleanupPromise === null) {
      cleanupPromise = Promise.resolve().then(() => operation(cleanupRunner, options))
    }
    return cleanupPromise`,
    `cleanupPromise = Promise.resolve().then(() => operation(cleanupRunner, options))
    return cleanupPromise`
  )
  const directory = mkdtempSync(join(tmpdir(), 'm5-cleanup-memoization-mutant-'))
  const modulePath = join(directory, 'm3b-subprocess.mjs')
  writeFileSync(modulePath, mutant)
  const implementation = await importFresh(modulePath, 'cleanup-memoization')
  let calls = 0
  const releases = []
  const cleanup = implementation.createSignalSafeCleanup(async () => {
    calls += 1
    await new Promise((resolveRelease) => { releases.push(resolveRelease) })
    return []
  })
  try {
    const first = cleanup()
    const second = cleanup()
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    assert.notEqual(first, second)
    assert.equal(calls, 2)
    for (const release of releases) release()
    await Promise.all([first, second])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

guardTest('cleanup-signal-delivery-barrier', 'the guard is killed by an ordinary-exit oracle', () => {
  const sourcePath = resolve(repositoryRoot, 'infra/docker/m3b-subprocess.mjs')
  const source = readFileSync(sourcePath, 'utf8')
  const mutant = replaceExactly(
    source,
    'const cleanupSettlementBarrier = createCleanupSettlementBarrier()',
    'const cleanupSettlementBarrier = async () => Object.freeze({ ok: true, signal: pendingSignal })'
  )
  const directory = mkdtempSync(join(tmpdir(), 'm5-pending-signal-mutant-'))
  const modulePath = join(directory, 'm3b-subprocess.mjs')
  writeFileSync(modulePath, mutant)
  const moduleUrl = pathToFileURL(modulePath).href
  const fixture = [
    `import { createSignalSafeCleanup, installSignalHandlers, settleCliExitCode } from ${JSON.stringify(moduleUrl)}`,
    'const cleanup = createSignalSafeCleanup(async () => {',
    "  process.kill(process.pid, 'SIGTERM')",
    '  return []',
    '})',
    "installSignalHandlers(() => cleanup(), { label: 'pending signal mutant cleanup' })",
    'await cleanup()',
    'const signal = await settleCliExitCode(42)',
    'if (signal === null) process.exit(42)',
    'await new Promise(() => {})'
  ].join('\n')
  try {
    const outcome = spawnSync(process.execPath, ['--input-type=module', '--eval', fixture], {
      encoding: 'utf8',
      timeout: 8_000
    })
    assert.equal(outcome.status, 42, outcome.stderr)
    assert.equal(outcome.signal, null)

    const oneTurn = replaceExactly(source, 'turn < 2', 'turn < 1')
    writeFileSync(modulePath, oneTurn)
    const oneTurnFixture = [
      `import { createCleanupSettlementBarrier } from ${JSON.stringify(`${moduleUrl}?one-turn`)}`,
      'let calls = 0',
      'const barrier = createCleanupSettlementBarrier({',
      '  scheduleImmediate(callback) {',
      '    calls += 1',
      "    if (calls === 2) throw new Error('SECOND-TURN-SENTINEL')",
      '    callback()',
      '  }',
      '})',
      'const outcome = await barrier()',
      'process.stdout.write(JSON.stringify({ calls, outcome }))'
    ].join('\n')
    const oneTurnOutcome = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', oneTurnFixture],
      { encoding: 'utf8', timeout: 4_000 }
    )
    assert.equal(oneTurnOutcome.status, 0, oneTurnOutcome.stderr)
    assert.deepEqual(JSON.parse(oneTurnOutcome.stdout), {
      calls: 1,
      outcome: { ok: true, signal: null }
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

guardTest('aggregate-final-signal-delivery', 'the aggregate result stays behind the production signal settlement', () => {
  const source = readFileSync(resolve(repositoryRoot, 'scripts/run-stage09a-check.mjs'), 'utf8')
  const consumer = 'const finalExitCode = await settleAggregateProcess(ordinaryExitCode)'
  const mutant = replaceExactly(
    source,
    consumer,
    'const finalExitCode = ordinaryExitCode'
  )
  const problems = productionConsumerProblems(new Map([
    ['scripts/run-stage09a-check.mjs', mutant]
  ]))
  assert.equal(
    problems.some((problem) => problem.startsWith('[aggregate-final-signal-delivery]')),
    true
  )
})

guardTest('runtime-image-claim', 'the guards are killed by a wrong-claim removal oracle', async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'm5-runtime-claim-mutant-'))
  const copiedDockerDirectory = join(temporaryRoot, 'infra/docker')
  cpSync(resolve(repositoryRoot, 'infra/docker'), copiedDockerDirectory, { recursive: true })
  const modulePath = join(copiedDockerDirectory, 'm5-runtime-settlement.mjs')
  let mutant = readFileSync(modulePath, 'utf8')
  const needle = 'parseClaimedBuildImage('
  const count = mutant.split(needle).length - 1
  assert.equal(count, 4)
  mutant = mutant.replaceAll(needle, 'acceptAnyClaim(')
  mutant = mutant.replace(
    "const inspectJsonObject = (stdout) => {",
    "const acceptAnyClaim = () => undefined\n\nconst inspectJsonObject = (stdout) => {"
  )
  writeFileSync(modulePath, mutant)
  const implementation = await importFresh(modulePath, 'runtime-claim')
  const imageId = `sha256:${'a'.repeat(64)}`
  const tag = 'meal-agent-api:m5-recovery-fixture'
  const expectedClaim = 'a'.repeat(32)
  let present = true
  let tagged = true
  const absentImage = (name) => ({
    status: 1,
    signal: null,
    stdout: '',
    stderr: `Error response from daemon: No such image: ${name}\n`
  })
  const run = async (argv) => {
    if (argv[1] === 'image' && argv[2] === 'inspect') {
      if (!present || (argv[3] !== imageId && !(tagged && argv[3] === tag))) {
        return absentImage(argv[3])
      }
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify([{
          Id: imageId,
          RepoTags: tagged ? [tag] : null,
          Config: { Labels: { 'meal-agent.m3b.build-claim': 'foreign-claim' } }
        }]),
        stderr: ''
      }
    }
    if (argv[1] === 'image' && argv[2] === 'ls') {
      return { status: 0, signal: null, stdout: '', stderr: '' }
    }
    if (argv[1] === 'image' && argv[2] === 'rm') {
      if (argv[3] === tag) tagged = false
      if (argv[3] === imageId) present = false
      return { status: 0, signal: null, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected fixture command: ${argv.join(' ')}`)
  }
  try {
    assert.deepEqual(await implementation.settleClaimedRuntimeImage(run, {
      recoveryTag: tag,
      claimToken: expectedClaim,
      ownedImageId: imageId
    }), [])
    assert.equal(present, false, 'the claim-check mutant must delete the foreign image')
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

guardTest('scratch-capability', 'fields are production data, not optional call-site decoration', async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'm5-scratch-capability-mutant-'))
  const copiedDockerDirectory = join(temporaryRoot, 'infra/docker')
  cpSync(resolve(repositoryRoot, 'infra/docker'), copiedDockerDirectory, { recursive: true })
  const modulePath = join(copiedDockerDirectory, 'api-image-scan.mjs')
  const original = readFileSync(modulePath, 'utf8')
  const helperStart = original.indexOf('export const scratchCapabilityExpectation')
  const helperEnd = original.indexOf('export const parseImageHistory', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)
  const helper = original.slice(helperStart, helperEnd)
  const imageId = `sha256:${'a'.repeat(64)}`
  const containerId = 'b'.repeat(64)
  const name = 'fixture'
  const payload = JSON.stringify([{
    Id: containerId,
    Image: imageId,
    Name: `/${name}`,
    Path: 'node',
    Config: { User: '10001:10001', Labels: { 'meal-agent.m5.owner': name } },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true }
  }])
  try {
    for (const [field, line] of [
      ['user', '  expectedUser: user,\n'],
      ['network', "  expectedNetworkMode: 'none',\n"],
      ['readonly', '  expectedReadonlyRootfs: true\n']
    ]) {
      const mutantHelper = replaceExactly(helper, line, '')
      writeFileSync(
        modulePath,
        original.slice(0, helperStart) + mutantHelper + original.slice(helperEnd)
      )
      const implementation = await importFresh(modulePath, field)
      const expectation = implementation.scratchCapabilityExpectation({
        name,
        imageId,
        containerId,
        user: '10001:10001'
      })
      assert.throws(
        () => implementation.parseOwnedScratchContainer(
          payload,
          expectation,
          (message) => { throw new Error(message) }
        ),
        /scratch container identity did not match this run/
      )
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

guardTest('runtime-scratch-final-settlement', 'the live runtime consumer retires only after final identity settlement', async () => {
  const implementation = await importFresh(
    resolve(repositoryRoot, 'infra/docker/api-image-scan.mjs'),
    'runtime-scratch-final-settlement'
  )
  const imageId = `sha256:${'a'.repeat(64)}`
  const record = {
    name: 'meal-agent-m5-scan-fixture',
    id: 'b'.repeat(64),
    expectedImageId: imageId,
    expectedUser: '10001:10001',
    expectedNetworkMode: 'none',
    expectedReadonlyRootfs: true
  }
  let present = true
  let foreign = false
  let retired = false
  const inspect = () => JSON.stringify([{
    Id: foreign ? 'd'.repeat(64) : record.id,
    Image: imageId,
    Name: `/${record.name}`,
    Path: 'node',
    Config: {
      User: record.expectedUser,
      Labels: { 'meal-agent.m5.owner': foreign ? 'foreign' : record.name }
    },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true }
  }])
  const run = async (argv) => {
    if (argv[2] === 'rm') {
      foreign = true
      return { status: 17, signal: null, stdout: '', stderr: 'UNTRUSTED' }
    }
    if (argv[2] === 'inspect') {
      if (!present) return { status: 1, signal: null, stdout: '', stderr: 'No such container' }
      return { status: 0, signal: null, stdout: inspect(), stderr: '' }
    }
    throw new Error('unexpected runtime settlement fixture command')
  }
  const fatal = (message) => { throw new Error(message) }
  await assert.rejects(
    implementation.settleTrackedRuntimeProbe({
      run,
      record,
      fatal,
      retire: () => { retired = true }
    }),
    /owned runtime probe immutable identity was not proven absent/
  )
  assert.equal(retired, false)
})

test('mutation fixtures leave no production evidence names behind', () => {
  assert.equal(existsSync(resolve(repositoryRoot, 'm5-declaration-mutant')), false)
})
