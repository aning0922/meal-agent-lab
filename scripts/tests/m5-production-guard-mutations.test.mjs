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
  m5CliEntrypoints,
  m5ProductionGuards,
  m5ProtectedEntrypoints,
  m5ProtectedModules
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
  if (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) {
    const name = node.parent.name
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null
  }
  return null
}

const functionPath = (node) => {
  const path = []
  let current = node.parent
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) {
      const name = functionName(current)
      if (name !== null) path.push(name)
    }
    current = current.parent
  }
  return path
}

const importedDeclarationSymbol = (checker, sourceFile, moduleName, exportName) => {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) continue
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) !== exportName) continue
      return resolvedSymbol(checker, element.name)
    }
  }
  return undefined
}

const isCanonicalProcessIdentifier = (checker, sourceFile, node) => {
  if (!ts.isIdentifier(node) || node.text !== 'process') return false
  const symbol = resolvedSymbol(checker, node)
  return symbol?.declarations?.some((declaration) => {
    const declarationFile = declaration.getSourceFile()
    return declarationFile !== sourceFile && /[/\\]@types[/\\]node[/\\]globals\.d\.ts$/.test(declarationFile.fileName)
  }) === true
}

const isImportMetaUrl = (node) =>
  ts.isPropertyAccessExpression(node) &&
  node.name.text === 'url' &&
  ts.isMetaProperty(node.expression) &&
  node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
  node.expression.name.text === 'meta'

const mainGuardMatches = (expression, checker, sourceFile) => {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
    !ts.isElementAccessExpression(expression.left) ||
    !ts.isNumericLiteral(expression.left.argumentExpression) ||
    expression.left.argumentExpression.text !== '1' ||
    !ts.isPropertyAccessExpression(expression.left.expression) ||
    expression.left.expression.name.text !== 'argv' ||
    !isCanonicalProcessIdentifier(checker, sourceFile, expression.left.expression.expression) ||
    !ts.isCallExpression(expression.right) ||
    expression.right.arguments.length !== 1 ||
    !isImportMetaUrl(expression.right.arguments[0]) ||
    !ts.isIdentifier(expression.right.expression)
  ) return false
  const canonicalFileUrlToPath = importedDeclarationSymbol(
    checker,
    sourceFile,
    'node:url',
    'fileURLToPath'
  )
  return canonicalFileUrlToPath !== undefined &&
    resolvedSymbol(checker, expression.right.expression) === canonicalFileUrlToPath
}

const placementMatches = (call, placement, sourceFile, checker) => {
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
      mainGuardMatches(block.parent.expression, checker, sourceFile)
    )
  }
  const owner = nearestFunction(call)
  if (owner === undefined || owner.body === undefined || statement.parent !== owner.body) {
    return false
  }
  return placement.kind === 'function-path-direct' &&
    JSON.stringify(functionPath(call)) === JSON.stringify(placement.path)
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
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ['node'],
    typeRoots: [resolve(repositoryRoot, 'services/api/node_modules/@types')]
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
          placementValid: placementMatches(node, consumer.placement, sourceFile, checker),
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
  problems.push(...productionConsumerRegistryProblems(m5ProductionGuards, overrides))
  return problems
}

const consumerSignature = (guardId, consumer) => [
  guardId,
  consumer.path,
  `${consumer.callee.path}#${consumer.callee.name}`,
  consumer.placement.kind,
  (consumer.placement.path ?? []).join('>'),
  consumer.placement.binding ?? '',
  String(consumer.count)
].join('|')

const trackedProductionModulePaths = () => {
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'infra/docker/*.mjs', 'scripts/*.mjs'], {
    cwd: repositoryRoot,
    encoding: 'buffer',
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  })
  assert.equal(listed.status, 0, 'tracked production module set could not be read')
  return listed.stdout.toString('utf8').split('\0').filter((path) =>
    /^(?:infra\/docker|scripts)\/[^/]+\.mjs$/.test(path)).sort()
}

const compilerProgram = (paths, overrides = new Map()) => {
  const options = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ['node'],
    typeRoots: [resolve(repositoryRoot, 'services/api/node_modules/@types')]
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
  return ts.createProgram({
    rootNames: [...new Set(paths.map((path) => resolve(repositoryRoot, path)))],
    options,
    host
  })
}

const discoveredTargetCalls = (callee, overrides = new Map()) => {
  const candidates = [...new Set([
    ...trackedProductionModulePaths(),
    ...overrides.keys(),
    callee.path
  ])].sort()
  const program = compilerProgram(candidates, overrides)
  const checker = program.getTypeChecker()
  const targetFile = program.getSourceFile(resolve(repositoryRoot, callee.path))
  assert.notEqual(targetFile, undefined, `guard declaration source was not parsed: ${callee.path}`)
  const targetSymbol = topLevelSymbol(checker, targetFile, callee.name)
  assert.notEqual(targetSymbol, undefined, `guard declaration disappeared: ${callee.path}#${callee.name}`)
  const calls = []
  for (const path of candidates) {
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, path))
    if (sourceFile === undefined) continue
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        resolvedSymbol(checker, node.expression) === targetSymbol
      ) {
        calls.push(Object.freeze({ path, node, sourceFile, checker }))
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return calls
}

const productionConsumerRegistryProblems = (
  registry = m5ProductionGuards,
  overrides = new Map()
) => {
  const problems = []
  const consumers = registry.flatMap((guard) =>
    (guard.consumers ?? []).map((consumer) => ({ guard, consumer })))
  const signatures = consumers.map(({ guard, consumer }) =>
    consumerSignature(guard.id, consumer))
  if (signatures.length !== new Set(signatures).size) {
    problems.push('production consumer registry contained duplicate declarations')
  }
  const targets = new Map()
  for (const { consumer } of consumers) {
    const key = `${consumer.callee.path}#${consumer.callee.name}`
    if (!targets.has(key)) targets.set(key, consumer.callee)
  }
  for (const [targetKey, callee] of targets) {
    const registeredCounts = new Map()
    for (const { consumer } of consumers) {
      if (`${consumer.callee.path}#${consumer.callee.name}` !== targetKey) continue
      registeredCounts.set(consumer.path, (registeredCounts.get(consumer.path) ?? 0) + consumer.count)
    }
    const discoveredCounts = new Map()
    for (const { path } of discoveredTargetCalls(callee, overrides)) {
      discoveredCounts.set(path, (discoveredCounts.get(path) ?? 0) + 1)
    }
    if (
      JSON.stringify([...registeredCounts].sort()) !==
      JSON.stringify([...discoveredCounts].sort())
    ) {
      problems.push(
        `production consumer registry drifted from declaration identity: ${targetKey}` +
        ` registered=${JSON.stringify([...registeredCounts].sort())}` +
        ` discovered=${JSON.stringify([...discoveredCounts].sort())}`
      )
    }
  }
  return problems
}

const declaredProtectedEntrypointProblems = (overrides = new Map()) => {
  const problems = []
  const manifestPaths = m5CliEntrypoints.map(({ path }) => path)
  if (manifestPaths.length !== new Set(manifestPaths).size) {
    problems.push('M5 CLI manifest contained duplicate paths')
  }
  if (
    JSON.stringify([...manifestPaths].sort()) !==
    JSON.stringify([...m5ProtectedEntrypoints].sort())
  ) {
    problems.push('protected entrypoint list drifted from the M5 CLI manifest')
  }
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    if (!name.startsWith('stage09a:')) continue
    const match = /^node ([a-z0-9_./-]+\.mjs)$/.exec(command)
    assert.notEqual(match, null, `stage09a production entrypoint command was not canonical: ${name}`)
    if (!manifestPaths.includes(match[1])) {
      problems.push(`stage09a package script was absent from the M5 CLI manifest: ${name}`)
    }
  }
  for (const { path, settlement } of m5CliEntrypoints) {
    const source = overrides.get(path) ?? readFileSync(resolve(repositoryRoot, path), 'utf8')
    if (settlement === 'signal-settled-cli') {
      const consumer = {
        path,
        callee: {
          path: 'infra/docker/m3b-subprocess.mjs',
          name: 'runSignalSettledCli'
        },
        placement: { kind: 'main-guard-direct' },
        count: 1
      }
      const calls = consumerCalls(consumer, overrides)
      if (
        calls.length !== 1 ||
        calls.filter(({ placementValid }) => placementValid).length !== 1
      ) {
        problems.push(`${path}: signal-settled CLI boundary was not unique`)
      }
    } else if (settlement === 'structured-stage09a-core') {
      if ((source.match(/await runStage09aCheck\(/g) ?? []).length !== 1) {
        problems.push(`${path}: structured Stage09A core boundary was not unique`)
      }
    } else if (settlement === 'structured-stage09a-audit') {
      if (
        (source.match(/await runStage09aAuditB\(/g) ?? []).length !== 1 ||
        (source.match(/await runStage09aCheck\(/g) ?? []).length !== 1
      ) {
        problems.push(`${path}: structured Audit-B boundary was not unique`)
      }
    } else {
      problems.push(`${path}: M5 CLI manifest used an unknown settlement kind`)
    }
  }
  return problems
}

const unwrapExpression = (node) => {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

const constantString = (node) => {
  const current = unwrapExpression(node)
  if (ts.isStringLiteralLike(current)) return current.text
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = constantString(current.left)
    const right = constantString(current.right)
    return left === null || right === null ? null : left + right
  }
  return null
}

const protectedExitCapabilityProblems = (overrides = new Map()) => {
  const paths = [...new Set([
    ...m5ProtectedEntrypoints,
    ...m5ProtectedModules,
  ])].sort()
  const program = compilerProgram(paths, overrides)
  const checker = program.getTypeChecker()
  const problems = []
  for (const path of paths) {
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, path))
    if (sourceFile === undefined) continue
    const processAliases = new Set()
    const namedExitImports = []
    const seed = (node) => {
      if (isCanonicalProcessIdentifier(checker, sourceFile, node)) {
        processAliases.add(checker.getSymbolAtLocation(node))
      }
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'node:process'
      ) {
        namedExitImports.push(node)
        const clause = node.importClause
        if (clause?.name !== undefined) processAliases.add(checker.getSymbolAtLocation(clause.name))
        if (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
          processAliases.add(checker.getSymbolAtLocation(clause.namedBindings.name))
        }
        if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            if ((element.propertyName?.text ?? element.name.text) === 'exit') {
              namedExitImports.push(element)
            }
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === 'node:process'
      ) {
        namedExitImports.push(node)
      }
      ts.forEachChild(node, seed)
    }
    seed(sourceFile)
    let changed = true
    while (changed) {
      changed = false
      const collectAliases = (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer !== undefined &&
          ts.isIdentifier(unwrapExpression(node.initializer)) &&
          processAliases.has(checker.getSymbolAtLocation(unwrapExpression(node.initializer))) &&
          !processAliases.has(checker.getSymbolAtLocation(node.name))
        ) {
          processAliases.add(checker.getSymbolAtLocation(node.name))
          changed = true
        }
        ts.forEachChild(node, collectAliases)
      }
      collectAliases(sourceFile)
    }
    const isProcessAlias = (node) => {
      const current = unwrapExpression(node)
      return ts.isIdentifier(current) && processAliases.has(checker.getSymbolAtLocation(current))
    }
    const isExitMember = (node) =>
      (ts.isPropertyAccessExpression(node) &&
        isProcessAlias(node.expression) &&
        node.name.text === 'exit') ||
      (ts.isElementAccessExpression(node) &&
        isProcessAlias(node.expression) &&
        constantString(node.argumentExpression) === 'exit')
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
        constantString(node.arguments[1]) === 'exit'
      ) {
        problems.push(`${path}: process.exit capability escaped through reflection`)
      }
      ts.forEachChild(node, visit)
    }
    for (const element of namedExitImports) {
      problems.push(`${path}: process.exit capability escaped through node:process import`)
    }
    visit(sourceFile)
  }
  problems.push(...declaredProtectedEntrypointProblems(overrides))
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

test('declared consumers and the explicit CLI manifest match current production', () => {
  assert.deepEqual(productionConsumerRegistryProblems(), [])
  assert.deepEqual(declaredProtectedEntrypointProblems(), [])
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

test('manifest settlement boundaries require the real declaration and direct main guard', () => {
  const path = 'infra/docker/backup-local-test.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutations = [
    source
      .replace(
        '  runSignalSettledCli,',
        '  runSignalSettledCli as realRunSignalSettledCli,'
      )
      .replace(
        "} from './m5-evidence-protocol.mjs'\n",
        "} from './m5-evidence-protocol.mjs'\n" +
          'const runSignalSettledCli = async (operation) => operation()\n'
      ),
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
    const problems = declaredProtectedEntrypointProblems(new Map([[path, mutant]]))
    assert.equal(
      problems.some((problem) => problem.startsWith(`${path}:`)),
      true
    )
  }
})

test('main guards bind fileURLToPath to the node:url declaration identity', () => {
  const path = 'infra/docker/backup-local-test.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = source.replace(
    "import { fileURLToPath } from 'node:url'",
    [
      "import { fileURLToPath as realFileURLToPath } from 'node:url'",
      "function fileURLToPath() { return '/never-the-entrypoint' }"
    ].join('\n')
  )
  assert.notEqual(mutant, source)
  assert.equal(
    declaredProtectedEntrypointProblems(new Map([[path, mutant]]))
      .some((problem) => problem.startsWith(`${path}:`)),
    true
  )
})

test('the manifest is the complete reviewed command surface, not arbitrary tracked code', () => {
  const path = 'infra/docker/new-protected-entrypoint.mjs'
  const source = [
    "import { exit as exitNow } from 'node:process'",
    "import { runSignalSettledCli } from './m3b-subprocess.mjs'",
    'await runSignalSettledCli(async () => 0)',
    'exitNow(7)',
    ''
  ].join('\n')
  const overrides = new Map([[path, source]])
  assert.deepEqual(declaredProtectedEntrypointProblems(overrides), [])
  assert.deepEqual(protectedExitCapabilityProblems(overrides), [])
  assert.equal(m5ProtectedEntrypoints.includes(path), false)
})

test('the production registry requires every exact consumer path once', () => {
  const mutant = m5ProductionGuards.map((guard) => {
    if (guard.id !== 'scratch-capability') return guard
    const consumers = guard.consumers.map((consumer) =>
      Object.freeze({ ...consumer, count: consumer.count + 1 }))
    return Object.freeze({ ...guard, consumers: Object.freeze(consumers) })
  })
  assert.equal(
    productionConsumerRegistryProblems(mutant).some((problem) =>
      problem.startsWith('production consumer registry drifted from declaration identity:')),
    true
  )
})

test('protected production entrypoints cannot obtain the process.exit capability', () => {
  for (const path of m5ProtectedEntrypoints) {
    const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
    for (const addition of [
      'const exitNow = process.exit\n',
      "const exitNow = process['exit']\n",
      "const exitNow = process['ex' + 'it']\n",
      'const erasedProcess = /** @type {any} */ (process); const exitNow = erasedProcess.exit\n',
      'const { exit: exitNow } = process\n',
      "const exitNow = Reflect.get(process, 'exit')\n",
      "import { exit as exitNow } from 'node:process'\n",
      "const { exit: exitNow } = await import('node:process')\n"
    ]) {
      const problems = protectedExitCapabilityProblems(
        new Map([[path, `${source}\n${addition}`]])
      )
      assert.equal(
        problems.some((problem) => problem.startsWith(`${path}:`)),
        true,
        `${path} did not reject ${addition.trim()}`
      )
    }
  }
})

guardTest('backup-pre-fork-runtime', 'the live backup guard is killed by an in-flight cleanup oracle', async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'm5-live-backup-declaration-mutant-'))
  const copiedDockerDirectory = join(temporaryRoot, 'infra/docker')
  cpSync(resolve(repositoryRoot, 'infra/docker'), copiedDockerDirectory, { recursive: true })
  const initialized = spawnSync('git', ['init', '-q'], { cwd: temporaryRoot, encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
  const backupPath = join(copiedDockerDirectory, 'backup-local-test.mjs')
  const evidencePath = join(copiedDockerDirectory, 'm5-evidence-protocol.mjs')
  writeFileSync(evidencePath, replaceExactly(
    readFileSync(evidencePath, 'utf8'),
    'for (const target of targets) declareOwnedTreeOutput(journal, target)',
    'void targets'
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

guardTest('structured-stage09a-core', 'Audit-B cannot bypass the single structured execution core', () => {
  const path = 'scripts/run-stage09a-audit-b.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = replaceExactly(
    source,
    'const outcome = await runStage09aCheck([])',
    "const outcome = { gate: gateNotStarted, requestedSignal: null }"
  )
  const problems = declaredProtectedEntrypointProblems(new Map([[path, mutant]]))
  assert.equal(
    problems.some((problem) => problem.startsWith(`${path}:`)),
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
