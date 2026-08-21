import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import {
  chmodSync,
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
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  m5CliEntrypoints,
  m5ProductionGuards,
  m5ProtectedEntrypoints,
  m5ProtectedModules
} from '../../infra/docker/m5-production-guard-registry.mjs'
import {
  createOwnedTreeJournal,
  retireOwnedTree,
  runWithDeclaredOwnedTreeOutputs
} from '../../infra/docker/m5-evidence-protocol.mjs'

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
  if (placement.kind === 'source-direct-await') {
    return (
      ts.isExpressionStatement(statement) &&
      ts.isAwaitExpression(statement.expression) &&
      statement.expression.expression === call &&
      statement.parent === sourceFile
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
  if (placement.kind === 'main-guard-binding') {
    const block = statement.parent
    if (
      !ts.isVariableStatement(statement) ||
      !ts.isBlock(block) ||
      !ts.isIfStatement(block.parent) ||
      block.parent.thenStatement !== block ||
      block.parent.elseStatement !== undefined ||
      block.parent.parent !== sourceFile ||
      !mainGuardMatches(block.parent.expression, checker, sourceFile)
    ) return false
    const declarations = statement.declarationList.declarations
    return (
      declarations.length === 1 &&
      ts.isIdentifier(declarations[0].name) &&
      declarations[0].name.text === placement.binding &&
      ts.isAwaitExpression(declarations[0].initializer) &&
      declarations[0].initializer.expression === call
    )
  }
  const owner = nearestFunction(call)
  if (owner === undefined || owner.body === undefined) {
    return false
  }
  if (placement.kind === 'function-path-awaited') {
    let current = call.parent
    let staticallyDead = false
    while (current !== undefined && current !== owner) {
      if (
        ts.isIfStatement(current) &&
        current.expression.kind === ts.SyntaxKind.FalseKeyword
      ) staticallyDead = true
      current = current.parent
    }
    return (
      !staticallyDead &&
      ts.isAwaitExpression(call.parent) &&
      JSON.stringify(functionPath(call)) === JSON.stringify(placement.path)
    )
  }
  if (statement.parent !== owner.body) return false
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
      if (valid.length !== consumer.count) {
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
    /^(?:infra\/docker|scripts)\/.+\.mjs$/.test(path) &&
    !/(?:^|\/)fixtures\//.test(path) &&
    !/^scripts\/tests\//.test(path)).sort()
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

const isDeclarationOnlyIdentifier = (node) => {
  const parent = node.parent
  return (
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent)
  )
}

const discoverProductionCapabilities = (targets, overrides = new Map()) => {
  const candidates = [...new Set([
    ...trackedProductionModulePaths(),
    ...overrides.keys(),
    ...[...targets.values()].map(({ path }) => path)
  ])].sort()
  const program = compilerProgram(candidates, overrides)
  const checker = program.getTypeChecker()
  const targetBySymbol = new Map()
  const references = new Map()
  const byModule = new Map()
  for (const [targetKey, callee] of targets) {
    const absolute = resolve(repositoryRoot, callee.path)
    const targetFile = program.getSourceFile(absolute)
    assert.notEqual(targetFile, undefined, `guard declaration source was not parsed: ${callee.path}`)
    const targetSymbol = topLevelSymbol(checker, targetFile, callee.name)
    assert.notEqual(targetSymbol, undefined, `guard declaration disappeared: ${callee.path}#${callee.name}`)
    targetBySymbol.set(targetSymbol, targetKey)
    references.set(targetKey, [])
    const names = byModule.get(absolute) ?? new Set()
    names.add(callee.name)
    byModule.set(absolute, names)
  }
  const moduleProblems = []
  const localModuleAbsolutePath = (importerPath, moduleSpecifier) =>
    moduleSpecifier.startsWith('.')
      ? resolve(dirname(resolve(repositoryRoot, importerPath)), moduleSpecifier)
      : null
  for (const path of candidates) {
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, path))
    if (sourceFile === undefined) continue
    const visit = (node) => {
      if (ts.isIdentifier(node) && !isDeclarationOnlyIdentifier(node)) {
        const targetKey = targetBySymbol.get(resolvedSymbol(checker, node))
        if (targetKey !== undefined) {
          references.get(targetKey).push(Object.freeze({ path, node, sourceFile, checker }))
        }
      }
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = localModuleAbsolutePath(path, node.moduleSpecifier.text)
        const targetNames = target === null ? undefined : byModule.get(target)
        if (
          targetNames !== undefined &&
          node.importClause?.namedBindings !== undefined &&
          ts.isNamespaceImport(node.importClause.namedBindings)
        ) {
          for (const name of targetNames) {
            moduleProblems.push(`production capability namespace import was forbidden: ${node.moduleSpecifier.text}#${name}`)
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1
      ) {
        const moduleSpecifier = constantString(node.arguments[0], checker)
        if (moduleSpecifier === null) {
          moduleProblems.push(`${path}: production dynamic import specifier was not statically closed`)
          ts.forEachChild(node, visit)
          return
        }
        const target = localModuleAbsolutePath(path, moduleSpecifier)
        const targetNames = target === null ? undefined : byModule.get(target)
        if (targetNames !== undefined) {
          for (const name of targetNames) {
            moduleProblems.push(`production capability dynamic import was forbidden: ${moduleSpecifier}#${name}`)
          }
        }
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = localModuleAbsolutePath(path, node.moduleSpecifier.text)
        const targetNames = target === null ? undefined : byModule.get(target)
        if (targetNames !== undefined) {
          for (const name of targetNames) {
            moduleProblems.push(`production capability re-export was forbidden: ${node.moduleSpecifier.text}#${name}`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return { references, moduleProblems }
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
  const discovery = discoverProductionCapabilities(targets, overrides)
  for (const [targetKey, callee] of targets) {
    const registeredCounts = new Map()
    for (const { consumer } of consumers) {
      if (`${consumer.callee.path}#${consumer.callee.name}` !== targetKey) continue
      registeredCounts.set(consumer.path, (registeredCounts.get(consumer.path) ?? 0) + consumer.count)
    }
    const discoveredCounts = new Map()
    for (const { path } of discovery.references.get(targetKey) ?? []) {
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
  problems.push(...discovery.moduleProblems)
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
    if (match === null) {
      problems.push(`stage09a package script command was not canonical: ${name}`)
      continue
    }
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
    } else if (
      settlement === 'structured-stage09a-core' ||
      settlement === 'structured-stage09a-audit'
    ) {
      const consumer = {
        path,
        callee: {
          path,
          name: settlement === 'structured-stage09a-core'
            ? 'runStage09aCheck'
            : 'runStage09aAuditB'
        },
        placement: { kind: 'main-guard-binding', binding: 'outcome' },
        count: 1
      }
      const calls = consumerCalls(consumer, overrides)
      if (
        calls.filter(({ placementValid }) => placementValid).length !== 1
      ) {
        problems.push(`${path}: structured CLI boundary was not unique`)
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

const constantString = (node, checker, seen = new Set()) => {
  const current = unwrapExpression(node)
  if (ts.isStringLiteralLike(current)) return current.text
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current)
    if (symbol === undefined || seen.has(symbol)) return null
    seen.add(symbol)
    const declaration = symbol.declarations?.find((candidate) =>
      ts.isVariableDeclaration(candidate) &&
      candidate.initializer !== undefined &&
      ts.isVariableDeclarationList(candidate.parent) &&
      (candidate.parent.flags & ts.NodeFlags.Const) !== 0)
    return declaration === undefined
      ? null
      : constantString(declaration.initializer, checker, seen)
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = constantString(current.left, checker, seen)
    const right = constantString(current.right, checker, seen)
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
    const allowedProcessProperties = new Set([
      'argv',
      'env',
      'execPath',
      'exitCode',
      'kill',
      'on',
      'pid',
      'removeListener',
      'stderr',
      'stdout',
      'versions'
    ])
    const allowedGlobalProperties = new Set(['clearTimeout', 'setImmediate', 'setTimeout'])
    const isCanonicalGlobalObject = (node) => {
      const current = unwrapExpression(node)
      if (!ts.isIdentifier(current) || !['global', 'globalThis'].includes(current.text)) return false
      const symbol = checker.getSymbolAtLocation(current)
      return symbol?.declarations?.every((declaration) => declaration.getSourceFile() !== sourceFile) === true
    }
    const isGlobalProcessValue = (node) => {
      const current = unwrapExpression(node)
      return (
        ts.isPropertyAccessExpression(current) &&
        isCanonicalGlobalObject(current.expression) &&
        current.name.text === 'process'
      ) || (
        ts.isElementAccessExpression(current) &&
        isCanonicalGlobalObject(current.expression) &&
        constantString(current.argumentExpression, checker) === 'process'
      )
    }
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
        constantString(node.arguments[0], checker) === 'node:process'
      ) {
        namedExitImports.push(node)
      }
      ts.forEachChild(node, seed)
    }
    seed(sourceFile)
    const isProcessAlias = (node) => {
      const current = unwrapExpression(node)
      return isGlobalProcessValue(current) || (
        ts.isIdentifier(current) && processAliases.has(checker.getSymbolAtLocation(current))
      )
    }
    let changed = true
    while (changed) {
      changed = false
      const collectAliases = (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer !== undefined &&
          isProcessAlias(node.initializer) &&
          !processAliases.has(checker.getSymbolAtLocation(node.name))
        ) {
          processAliases.add(checker.getSymbolAtLocation(node.name))
          changed = true
        }
        ts.forEachChild(node, collectAliases)
      }
      collectAliases(sourceFile)
    }
    const isExitMember = (node) =>
      (ts.isPropertyAccessExpression(node) &&
        isProcessAlias(node.expression) &&
        node.name.text === 'exit') ||
      (ts.isElementAccessExpression(node) &&
        isProcessAlias(node.expression) &&
        constantString(node.argumentExpression, checker) === 'exit')
    const canonicalProcessUseIsConfined = (node) => {
      const parent = node.parent
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        return allowedProcessProperties.has(parent.name.text)
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const key = constantString(parent.argumentExpression, checker)
        return key !== null && allowedProcessProperties.has(key)
      }
      if (
        ts.isCallExpression(parent) &&
        parent.arguments[0] === node &&
        ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === 'bind' &&
        ts.isPropertyAccessExpression(parent.expression.expression) &&
        isProcessAlias(parent.expression.expression.expression) &&
        parent.expression.expression.name.text !== 'exit'
      ) {
        return true
      }
      return false
    }
    const canonicalGlobalUseIsConfined = (node) => {
      const parent = node.parent
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        return allowedGlobalProperties.has(parent.name.text)
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        return allowedGlobalProperties.has(constantString(parent.argumentExpression, checker))
      }
      if (
        ts.isCallExpression(parent) &&
        parent.arguments[0] === node &&
        ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === 'bind' &&
        ts.isPropertyAccessExpression(parent.expression.expression) &&
        isCanonicalGlobalObject(parent.expression.expression.expression) &&
        allowedGlobalProperties.has(parent.expression.expression.name.text)
      ) {
        return true
      }
      return false
    }
    const visit = (node) => {
      if (
        isCanonicalProcessIdentifier(checker, sourceFile, node) &&
        !canonicalProcessUseIsConfined(node)
      ) {
        problems.push(`${path}: process capability escaped through alias or value flow`)
      }
      if (isCanonicalGlobalObject(node) && !canonicalGlobalUseIsConfined(node)) {
        problems.push(`${path}: global object capability escaped the reviewed runtime surface`)
      }
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
        constantString(node.arguments[1], checker) === 'exit'
      ) {
        problems.push(`${path}: process.exit capability escaped through reflection`)
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'getBuiltinModule' &&
        isProcessAlias(node.expression.expression) &&
        node.arguments.length === 1 &&
        constantString(node.arguments[0], checker) === 'node:process'
      ) {
        problems.push(`${path}: process capability escaped through getBuiltinModule`)
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

test('new declaration-identity consumers cannot hide outside the reviewed command surface', () => {
  const path = 'infra/docker/new-protected-entrypoint.mjs'
  const source = [
    "import { exit as exitNow } from 'node:process'",
    "import { runSignalSettledCli } from './m3b-subprocess.mjs'",
    'await runSignalSettledCli(async () => 0)',
    'exitNow(7)',
    ''
  ].join('\n')
  const overrides = new Map([[path, source]])
  assert.equal(
    productionConsumerRegistryProblems(m5ProductionGuards, overrides)
      .some((problem) => problem.includes('runSignalSettledCli')),
    true
  )
  assert.equal(m5ProtectedEntrypoints.includes(path), false)
})

test('the real Stage09A execution graph cannot gain an undeclared settlement consumer', () => {
  const path = 'infra/docker/check-local-test-negatives.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = [
    source,
    "import { runSignalSettledCli as auditSettlement } from './m3b-subprocess.mjs'",
    'await auditSettlement(async () => 0)',
    ''
  ].join('\n')
  const overrides = new Map([[path, mutant]])
  assert.equal(
    productionConsumerRegistryProblems(m5ProductionGuards, overrides)
      .some((problem) => problem.includes('runSignalSettledCli')),
    true
  )
})

test('namespace imports of protected capability modules fail for their own reason', () => {
  const path = 'scripts/check-markdown-links.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = [
    source,
    "import * as core from './run-stage09a-check.mjs'",
    'void core.runStage09aCheck',
    ''
  ].join('\n')
  const problems = productionConsumerRegistryProblems(
    m5ProductionGuards,
    new Map([[path, mutant]])
  )
  assert.equal(problems.includes(
    'production capability namespace import was forbidden: ./run-stage09a-check.mjs#runStage09aCheck'
  ), true)
})

test('each protected capability value flow fails by declaration-identity drift', () => {
  const path = 'scripts/check-markdown-links.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const cases = [
    ['wrapper', 'const identity = (value) => value; identity(runStage09aCheck)'],
    ['callback', 'const receive = (_value) => undefined; receive(runStage09aCheck)'],
    ['holder', 'const holder = { capability: runStage09aCheck }; void holder.capability'],
    ['computed', 'const holder = { capability: runStage09aCheck }; void holder["capability"]'],
    ['destructure', 'const { capability } = { capability: runStage09aCheck }; void capability'],
    ['builder', 'const build = () => runStage09aCheck; void build'],
    ['projector', 'const project = (value) => ({ value }); project(runStage09aCheck)']
  ]
  const expectedPrefix =
    'production consumer registry drifted from declaration identity: ' +
    'scripts/run-stage09a-check.mjs#runStage09aCheck'
  for (const [label, body] of cases) {
    const mutant = [
      source,
      "import { runStage09aCheck } from './run-stage09a-check.mjs'",
      body,
      ''
    ].join('\n')
    const problems = productionConsumerRegistryProblems(
      m5ProductionGuards,
      new Map([[path, mutant]])
    )
    assert.equal(
      problems.filter((problem) => problem.startsWith(expectedPrefix)).length,
      1,
      `${label} did not fail by declaration-identity drift: ${JSON.stringify(problems)}`
    )
    assert.equal(
      problems.some((problem) => problem.includes('namespace import was forbidden')),
      false,
      `${label} was masked by a namespace-import failure`
    )
  }
})

test('a constant-expression dynamic import cannot hide a protected capability module', () => {
  const path = 'scripts/check-markdown-links.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = [
    source,
    'const hiddenCore = await import("./run-stage09a-check.mjs" + "")',
    'void hiddenCore.runStage09aCheck',
    ''
  ].join('\n')
  const problems = productionConsumerRegistryProblems(
    m5ProductionGuards,
    new Map([[path, mutant]])
  )
  assert.equal(
    problems.some((problem) =>
      problem === 'production capability dynamic import was forbidden: ./run-stage09a-check.mjs#runStage09aCheck'),
    true
  )
})

test('production dynamic import specifiers must be statically closed', () => {
  const path = 'scripts/check-markdown-links.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = [
    source,
    'const runtimeModuleName = process.env.M5_RUNTIME_MODULE',
    'void await import(runtimeModuleName)',
    ''
  ].join('\n')
  const problems = productionConsumerRegistryProblems(
    m5ProductionGuards,
    new Map([[path, mutant]])
  )
  assert.equal(
    problems.includes(`${path}: production dynamic import specifier was not statically closed`),
    true
  )
})

test('the reviewed production module surface includes nested executable modules', () => {
  const paths = trackedProductionModulePaths()
  assert.equal(paths.includes('infra/docker/postgres/no-ctty.mjs'), true)
  assert.equal(paths.some((path) => path.includes('/fixtures/')), false)
  assert.equal(paths.some((path) => path.startsWith('scripts/tests/')), false)
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
  const representative = m5ProtectedEntrypoints[0]
  const representativeSource = readFileSync(resolve(repositoryRoot, representative), 'utf8')
  for (const addition of [
    'const exitNow = process.exit\n',
    "const exitNow = process['exit']\n",
    "const exitNow = process['ex' + 'it']\n",
    "const exitKey = 'exit'; const exitNow = process[exitKey]\n",
    'const processIdentity = (value) => value; const exitNow = processIdentity(process).exit\n',
    'const processHolder = { runtime: process }; const exitNow = processHolder.runtime.exit\n',
    'const erasedProcess = /** @type {any} */ (process); const exitNow = erasedProcess.exit\n',
    'const { exit: exitNow } = process\n',
    "const exitNow = Reflect.get(process, 'exit')\n",
    "import { exit as exitNow } from 'node:process'\n",
    "const { exit: exitNow } = await import('node:process')\n"
  ]) {
    const problems = protectedExitCapabilityProblems(
      new Map([[representative, `${representativeSource}\n${addition}`]])
    )
    assert.equal(
      problems.some((problem) => problem.startsWith(`${representative}:`)),
      true,
      `${representative} did not reject ${addition.trim()}`
    )
  }
  for (const path of m5ProtectedEntrypoints) {
    const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
    const problems = protectedExitCapabilityProblems(
      new Map([[path, `${source}\nconst exitNow = process.exit\n`]])
    )
    assert.equal(
      problems.some((problem) => problem.startsWith(`${path}:`)),
      true,
      `${path} did not reject the canonical exit capability`
    )
  }
})

test('protected entrypoints cannot reacquire process before taking exit', () => {
  const path = m5ProtectedEntrypoints[0]
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  for (const addition of [
    'const processKey = "pro" + "cess"; const runtimeProcess = globalThis[processKey]; const exitNow = runtimeProcess.exit',
    'const runtimeGlobal = globalThis; const runtimeProcess = runtimeGlobal.process; const exitNow = runtimeProcess.exit',
    'const { exit: exitNow } = await import("node:" + "process")',
    'const exitNow = process.getBuiltinModule("node:process").exit',
    'const exitNow = process.constructor.constructor("return process.exit")()'
  ]) {
    const problems = protectedExitCapabilityProblems(
      new Map([[path, `${source}\n${addition}\n`]])
    )
    assert.equal(
      problems.some((problem) => problem.startsWith(`${path}:`)),
      true,
      `process capability reacquisition was not rejected: ${addition}`
    )
  }
})

test('the Markdown gate never reflects Git stderr or spawn errors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'm5-markdown-git-failure-'))
  const gitPath = join(directory, 'git')
  const sentinel = 'RAW-GIT-STDERR-SENTINEL'
  try {
    writeFileSync(gitPath, `#!/bin/sh\nprintf '%s\\n' '${sentinel}' >&2\nexit 77\n`)
    chmodSync(gitPath, 0o700)
    const rejected = spawnSync(
      process.execPath,
      ['scripts/check-markdown-links.mjs'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: directory }
      }
    )
    assert.equal(rejected.status, 1)
    assert.equal(rejected.stderr, 'markdown link check git subprocess failed\n')
    assert.doesNotMatch(rejected.stderr, new RegExp(sentinel))

    unlinkSync(gitPath)
    const missing = spawnSync(
      process.execPath,
      ['scripts/check-markdown-links.mjs'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: directory }
      }
    )
    assert.equal(missing.status, 1)
    assert.equal(missing.stderr, 'markdown link check failed to start git\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

guardTest('backup-pre-fork-runtime', 'the live backup guard is killed by an in-flight cleanup oracle', async () => {
  const positiveRoot = mkdtempSync(join(tmpdir(), 'm5-live-backup-positive-'))
  const positiveOutput = join(positiveRoot, 'fixture.dump.partial')
  const positiveJournal = createOwnedTreeJournal(positiveRoot)
  let positiveResidue = null
  try {
    const positiveResult = await runWithDeclaredOwnedTreeOutputs(
      positiveJournal,
      [positiveOutput],
      async () => {
        writeFileSync(positiveOutput, 'controlled bytes', { mode: 0o600 })
        try {
          retireOwnedTree(positiveJournal)
          positiveResidue = []
        } catch {
          positiveResidue = ['backup partial directory cleanup failed']
        }
        return { status: 17 }
      }
    )
    assert.equal(positiveResult.status, 17)
    assert.deepEqual(positiveResidue, [])
  } finally {
    rmSync(positiveRoot, { recursive: true, force: true })
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'm5-live-backup-declaration-mutant-'))
  const copiedDockerDirectory = join(temporaryRoot, 'infra/docker')
  cpSync(resolve(repositoryRoot, 'infra/docker'), copiedDockerDirectory, { recursive: true })
  const initialized = spawnSync('git', ['init', '-q'], { cwd: temporaryRoot, encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
  const backupPath = join(copiedDockerDirectory, 'backup-local-test.mjs')
  writeFileSync(backupPath, replaceExactly(
    readFileSync(backupPath, 'utf8'),
    `copied = await runWithDeclaredOwnedTreeOutputs(
            privatePartialJournal,
            [hostPartial],
            () => run(['docker', 'cp', \`${'${id}'}:/transfer/${'${name}'}\`, hostPartial], {
              timeoutMs: 300_000
            })
          )`,
    `copied = await run(['docker', 'cp', \`${'${id}'}:/transfer/${'${name}'}\`, hostPartial], {
            timeoutMs: 300_000
          })`
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
      /backup artifact cleanup failed/
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
  const path = 'scripts/run-stage09a-check.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = replaceExactly(
    source,
    'const outcome = await runStage09aCheck(argv, auditPresentation)',
    "const outcome = { gate: null, requestedSignal: null }"
  )
  const problems = productionConsumerProblems(new Map([[path, mutant]]))
  assert.equal(
    problems.some((problem) => problem.startsWith('[structured-stage09a-core]')),
    true
  )
})

guardTest('structured-stage09a-audit-receipt', 'Audit-B cannot substitute a forged core receipt', () => {
  const path = 'scripts/run-stage09a-audit-b.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = replaceExactly(
    source,
    'runReceipt = await runStage09aCheckForAudit([])',
    'runReceipt = Object.freeze({})'
  )
  const problems = productionConsumerProblems(new Map([[path, mutant]]))
  assert.equal(
    problems.some((problem) => problem.startsWith('[structured-stage09a-audit-receipt]')),
    true
  )
})

guardTest('structured-stage09a-report-receipt', 'the report cannot bypass receipt projection', () => {
  const path = 'scripts/run-stage09a-audit-b.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = replaceExactly(
    source,
    'const report = createStage09aAuditBReportFromReceipt(',
    'const report = createStage09aAuditBReport('
  )
  const problems = productionConsumerProblems(new Map([[path, mutant]]))
  assert.equal(
    problems.some((problem) => problem.startsWith('[structured-stage09a-report-receipt]')),
    true
  )
})

guardTest('structured-stage09a-receipt-projector', 'the receipt projector cannot be bypassed', () => {
  const path = 'scripts/stage09a-audit-b.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = replaceExactly(
    source,
    'const evidence = readStage09aAuditRunReceipt(runReceipt)',
    'const evidence = null'
  )
  const problems = productionConsumerProblems(new Map([[path, mutant]]))
  assert.equal(
    problems.some((problem) => problem.startsWith('[structured-stage09a-receipt-projector]')),
    true
  )
})

guardTest('structured-stage09a-report-builder', 'the receipt wrapper is the only report builder consumer', () => {
  const path = 'scripts/stage09a-audit-b.mjs'
  const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
  const mutant = replaceExactly(
    source,
    'return createStage09aAuditBReport(',
    'return Object.freeze('
  )
  const problems = productionConsumerProblems(new Map([[path, mutant]]))
  assert.equal(
    problems.some((problem) => problem.startsWith('[structured-stage09a-report-builder]')),
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
