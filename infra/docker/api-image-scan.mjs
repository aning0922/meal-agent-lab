// 阶段 09A / M5：API runtime image 依赖与组件扫描的共享核心。
//
// 两个入口共用本模块：
//   - check-api-runtime-image.mjs            —— 门禁本体（真实 Dockerfile 构建）
//   - check-api-runtime-image-mutations.mjs  —— 门禁自身的变异反例套件
//
// 设计要点见门禁入口的头注释。本模块没有 shebang，不是可执行入口；它不持有
// 全局状态，problem/fatal 收集器由调用方注入，Docker 资源（container/tag）的
// 清理责任也在调用方。
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCommand } from './m3b-subprocess.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
export const repositoryRoot = resolve(composeDirectory, '..', '..')
export const dockerfilePath = resolve(repositoryRoot, 'services/api/Dockerfile')
export const dockerignorePath = resolve(repositoryRoot, '.dockerignore')
const lockfilePath = resolve(repositoryRoot, 'pnpm-lock.yaml')
const migrationsDirectory = resolve(repositoryRoot, 'services/api/migrations')

// 与 services/api/Dockerfile 的 node-base 阶段逐字一致；变更基础镜像必须同步
// 这里，否则门禁立即转红——这是刻意的双登记，不是重复。
export const pinnedBaseImage =
  'docker.io/library/node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d'

export const expectedImageConfig = {
  user: '10001:10001',
  workingDir: '/app',
  cmd: ['node', '/app/dist/index.js'],
  env: [
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'NODE_VERSION=24.18.0',
    'YARN_VERSION=1.22.22',
    'NODE_ENV=production'
  ]
}

// 客户端与构建工具族。exact 按完整包名匹配，prefix 按前缀匹配（scope 一律带
// 结尾斜杠，避免 `@babel/` 误配 `@babeljs-fake`）。三个计划显名族（Taro、
// Swiper、webpack-dev-server）在报告里单列，其余是同一风险面的已知家族。
// 判定面是「包清单 ∪ 全镜像文件清单里的 node_modules/<name> 路径段」：后者是
// 取证面，pnpm 布局之外的畸形植入（直接 mkdir 进 node_modules、藏进某个包的
// vendored node_modules）同样命中。
export const forbiddenExactNames = new Set([
  'taro',
  'taro-ui',
  'swiper',
  'webpack',
  'webpack-cli',
  'webpack-dev-server',
  'webpack-dev-middleware',
  'babel-loader',
  'react',
  'react-dom',
  'react-refresh',
  'vue',
  'vite',
  'esbuild',
  'typescript',
  'tsx',
  'drizzle-kit',
  '@meal-agent/client'
])
export const forbiddenNamePrefixes = [
  '@tarojs/',
  '@babel/',
  '@webpack',
  '@vitejs/',
  '@vue/',
  '@esbuild/',
  '@swc/',
  'sockjs'
]
export const namedFamilies = [
  {
    label: 'Taro',
    matches: (name) => name === 'taro' || name === 'taro-ui' || name.startsWith('@tarojs/')
  },
  { label: 'Swiper', matches: (name) => name === 'swiper' },
  { label: 'webpack-dev-server', matches: (name) => name === 'webpack-dev-server' }
]

// `pnpm deploy --legacy` 会在 node_modules 里留一个指回项目自身的 self-link
// （镜像里指向构建阶段的 /workspace 路径，运行期悬空）。它是已知产物：必须存在、
// 必须是符号链接、绝不允许解析回 node_modules 之内；不参与闭包比对。
export const selfLinkName = '@meal-agent/api'

// --------------------------------------------------------------------------
// 有界命令封装：非零退出一律 fatal（证据缺失不可降级），输出原样返回。
// --------------------------------------------------------------------------
export const createStrictRunner = (fatal) => async (args, { timeoutMs, cwd = repositoryRoot, label, stdin = null } = {}) => {
  let outcome
  try {
    outcome = await runCommand(args, { timeoutMs, cwd, stdin })
  } catch (error) {
    fatal(`${label ?? args[0]}: ${error instanceof Error ? error.message : 'command failed to run'}`)
  }
  if (outcome.status !== 0) {
    const detail = outcome.signal !== null ? `killed by ${outcome.signal}` : `exit ${String(outcome.status)}`
    const stderrTail = outcome.stderr.split('\n').filter(Boolean).slice(-8).join('\n    ')
    fatal(`${label ?? args.join(' ')} failed (${detail})${stderrTail === '' ? '' : `\n    ${stderrTail}`}`)
  }
  return outcome
}

// --------------------------------------------------------------------------
// Dockerfile 与 .dockerignore 的静态断言（只覆盖 BLOCK 向：客户端内容进入
// 构建面、镜像获得公网/参数化面）。Compose 侧静态检查另有专门门禁。
// --------------------------------------------------------------------------
export const checkDockerfileText = (text, problem) => {
  const stageAliases = new Set()
  let sawUser = false
  let sawEmptyEntrypoint = false
  let sawExpectedCmd = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    const fromMatch = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line)
    if (fromMatch !== null) {
      const [, reference, alias] = fromMatch
      if (reference !== pinnedBaseImage && !stageAliases.has(reference)) {
        problem(`Dockerfile: FROM must use the pinned digest or a prior stage alias, got ${reference}`)
      }
      if (alias !== undefined) {
        stageAliases.add(alias)
      }
      continue
    }
    if (/^(ARG|EXPOSE)\b/i.test(line)) {
      problem(`Dockerfile: ${line.split(/\s/)[0]} instructions are not allowed in this image`)
    }
    if (/^COPY\b/i.test(line) && /apps\/|packages\/ui/.test(line)) {
      problem(`Dockerfile: COPY must not reference client workspaces (${line})`)
    }
    if (line === 'USER 10001:10001') {
      sawUser = true
    }
    if (line === 'ENTRYPOINT []') {
      sawEmptyEntrypoint = true
    }
    if (line === 'CMD ["node", "/app/dist/index.js"]') {
      sawExpectedCmd = true
    }
  }
  if (!sawUser) {
    problem('Dockerfile: exact line `USER 10001:10001` is required')
  }
  if (!sawEmptyEntrypoint) {
    problem('Dockerfile: exact line `ENTRYPOINT []` is required')
  }
  if (!sawExpectedCmd) {
    problem('Dockerfile: exact line `CMD ["node", "/app/dist/index.js"]` is required')
  }
}

export const checkDockerignoreText = (text, problem) => {
  const rules = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (rules[0] !== '**') {
    problem('.dockerignore: the first effective rule must be the default-deny `**`')
  }
  for (const rule of rules) {
    if (rule.startsWith('!') && /apps\/|packages\/ui|secrets|\.env|\.pem|\.key/.test(rule)) {
      problem(`.dockerignore: negation rule must not re-admit client or secret material (${rule})`)
    }
  }
  for (const required of ['**/.env', '**/.env.*', '**/*.pem', '**/*.key']) {
    if (!rules.includes(required)) {
      problem(`.dockerignore: unconditional secret exclusion \`${required}\` is missing`)
    }
  }
}

// --------------------------------------------------------------------------
// 同一个 walker 走两棵 `pnpm deploy --prod --legacy` 布局的 node_modules。
// physical package = `.pnpm/<key>/node_modules/<name>` 下的真实目录；顶层与
// hoist 区只允许指回 `.pnpm` 的符号链接。未知形态一律记 problem（fail
// closed），不静默跳过。
// --------------------------------------------------------------------------
const knownRootExtras = new Set(['.bin', '.modules.yaml', '.package-map.json', '.pnpm'])

const isInside = (candidate, ancestor) => {
  const relation = relative(ancestor, candidate)
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation)
}

export const inventoryNodeModules = (nodeModulesDirectory, label, problem) => {
  const links = new Map()
  const packages = []
  let sawSelfLink = false
  const pnpmDirectory = join(nodeModulesDirectory, '.pnpm')

  const readPackageIdentity = (packageDirectory) => {
    const manifestPath = join(packageDirectory, 'package.json')
    let parsed
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      problem(`${label}: unreadable package.json under ${basename(packageDirectory)}`)
      return null
    }
    if (
      typeof parsed.name !== 'string' ||
      parsed.name === '' ||
      typeof parsed.version !== 'string' ||
      parsed.version === ''
    ) {
      problem(`${label}: package.json under ${basename(packageDirectory)} lacks a usable name/version`)
      return null
    }
    return { name: parsed.name, version: parsed.version }
  }

  const recordLink = (linkPath, linkName) => {
    let target
    try {
      target = readlinkSync(linkPath)
    } catch {
      problem(`${label}: ${linkName} is not a readable symlink`)
      return
    }
    const resolved = resolve(dirname(linkPath), target)
    if (linkName === selfLinkName) {
      sawSelfLink = true
      if (existsSync(resolved) && isInside(resolved, nodeModulesDirectory)) {
        problem(`${label}: the ${selfLinkName} self-link must not resolve inside node_modules (${target})`)
      }
      return
    }
    if (!isInside(resolved, pnpmDirectory)) {
      problem(`${label}: ${linkName} escapes the .pnpm store (${target})`)
      return
    }
    const identity = readPackageIdentity(resolved)
    if (identity !== null && identity.name !== linkName) {
      problem(`${label}: link ${linkName} resolves to package named ${identity.name}`)
    }
    links.set(linkName, target)
  }

  const walkLinkArea = (areaDirectory, areaLabel) => {
    for (const entry of readdirSync(areaDirectory, { withFileTypes: true })) {
      if (entry.name === '.bin') {
        continue
      }
      const entryPath = join(areaDirectory, entry.name)
      if (entry.name.startsWith('@')) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          problem(`${label}: scope entry ${areaLabel}${entry.name} must be a plain directory`)
          continue
        }
        for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
          const scopedName = `${entry.name}/${scoped.name}`
          if (!scoped.isSymbolicLink()) {
            problem(`${label}: ${areaLabel}${scopedName} must be a symlink into .pnpm`)
            continue
          }
          recordLink(join(entryPath, scoped.name), scopedName)
        }
        continue
      }
      if (!entry.isSymbolicLink()) {
        problem(`${label}: ${areaLabel}${entry.name} must be a symlink into .pnpm`)
        continue
      }
      recordLink(entryPath, entry.name)
    }
  }

  for (const entry of readdirSync(nodeModulesDirectory, { withFileTypes: true })) {
    if (knownRootExtras.has(entry.name)) {
      continue
    }
    const entryPath = join(nodeModulesDirectory, entry.name)
    if (entry.name.startsWith('@')) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        problem(`${label}: scope entry ${entry.name} must be a plain directory`)
        continue
      }
      for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
        const scopedName = `${entry.name}/${scoped.name}`
        if (!scoped.isSymbolicLink()) {
          problem(`${label}: ${scopedName} must be a symlink into .pnpm`)
          continue
        }
        recordLink(join(entryPath, scoped.name), scopedName)
      }
      continue
    }
    if (!entry.isSymbolicLink()) {
      problem(`${label}: unexpected root entry ${entry.name} (neither known metadata nor a package symlink)`)
      continue
    }
    recordLink(entryPath, entry.name)
  }

  if (!existsSync(pnpmDirectory)) {
    problem(`${label}: .pnpm store directory is missing`)
    return { links, packages }
  }
  for (const entry of readdirSync(pnpmDirectory, { withFileTypes: true })) {
    if (entry.name === 'lock.yaml') {
      continue
    }
    const entryPath = join(pnpmDirectory, entry.name)
    if (entry.name === 'node_modules') {
      walkLinkArea(entryPath, '.pnpm/node_modules/')
      continue
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      problem(`${label}: unexpected .pnpm entry ${entry.name}`)
      continue
    }
    const mountRoot = join(entryPath, 'node_modules')
    if (!existsSync(mountRoot)) {
      problem(`${label}: store key ${entry.name} has no node_modules mount`)
      continue
    }
    const physicalHere = []
    const classifyLeaf = (leafPath, leafName) => {
      const stat = lstatSync(leafPath)
      if (stat.isSymbolicLink()) {
        const resolved = resolve(dirname(leafPath), readlinkSync(leafPath))
        if (!isInside(resolved, pnpmDirectory)) {
          problem(`${label}: ${entry.name} dependency link ${leafName} escapes the .pnpm store`)
        }
        return
      }
      if (!stat.isDirectory()) {
        problem(`${label}: unexpected file ${leafName} under store key ${entry.name}`)
        return
      }
      const identity = readPackageIdentity(leafPath)
      if (identity === null) {
        return
      }
      if (identity.name !== leafName) {
        problem(`${label}: physical package at ${entry.name}/${leafName} declares name ${identity.name}`)
      }
      physicalHere.push({ storeKey: entry.name, name: identity.name, version: identity.version })
    }
    for (const mounted of readdirSync(mountRoot, { withFileTypes: true })) {
      if (mounted.name === '.bin') {
        continue
      }
      const mountedPath = join(mountRoot, mounted.name)
      if (mounted.name.startsWith('@')) {
        if (mounted.isSymbolicLink()) {
          classifyLeaf(mountedPath, mounted.name)
          continue
        }
        if (!mounted.isDirectory()) {
          problem(`${label}: unexpected entry ${mounted.name} under store key ${entry.name}`)
          continue
        }
        for (const scoped of readdirSync(mountedPath, { withFileTypes: true })) {
          classifyLeaf(join(mountedPath, scoped.name), `${mounted.name}/${scoped.name}`)
        }
        continue
      }
      classifyLeaf(mountedPath, mounted.name)
    }
    if (physicalHere.length !== 1) {
      problem(
        `${label}: store key ${entry.name} holds ${String(physicalHere.length)} physical packages (expected exactly 1)`
      )
    }
    packages.push(...physicalHere)
  }
  if (!sawSelfLink) {
    problem(`${label}: the ${selfLinkName} self-link produced by pnpm deploy is missing`)
  }
  packages.sort((left, right) => (left.storeKey < right.storeKey ? -1 : left.storeKey > right.storeKey ? 1 : 0))
  return { links, packages }
}

const packageSetOf = (inventory) =>
  new Set(inventory.packages.map((entry) => `${entry.storeKey} :: ${entry.name}@${entry.version}`))

const listSample = (values, limit = 12) => {
  const sorted = [...values].sort()
  const sample = sorted.slice(0, limit).join(', ')
  return sorted.length > limit ? `${sample}, … +${String(sorted.length - limit)} more` : sample
}

// --------------------------------------------------------------------------
// 期望闭包：与 Dockerfile runtime-closure 阶段完全相同的一条命令，且必须只读
// （lockfile 逐字节不变）。
// --------------------------------------------------------------------------
export const deriveExpectedClosure = async ({ runStrict, fatal, problem, temporaryRoot, log }) => {
  const expectedDeployDirectory = join(temporaryRoot, 'expected')
  const lockfileBefore = readFileSync(lockfilePath)
  log('deriving the expected production closure via pnpm deploy --prod --legacy')
  await runStrict(
    ['pnpm', '--filter', '@meal-agent/api', 'deploy', '--prod', '--legacy', expectedDeployDirectory],
    { timeoutMs: 300_000, label: 'expected-closure deploy' }
  )
  if (!lockfileBefore.equals(readFileSync(lockfilePath))) {
    fatal('pnpm deploy mutated pnpm-lock.yaml; the expected closure derivation must be read-only')
  }
  return {
    deployDirectory: expectedDeployDirectory,
    inventory: inventoryNodeModules(join(expectedDeployDirectory, 'node_modules'), 'expected-closure', problem)
  }
}

// --------------------------------------------------------------------------
// 对一个**已构建**的镜像 tag 做完整扫描。container 的创建与移除都在这里完成；
// 中途失败时调用方通过 track.container 拿到残留 id 负责兜底移除。
// --------------------------------------------------------------------------
export const scanImage = async ({
  imageTag,
  expected,
  temporaryRoot,
  runStrict,
  fatal,
  problem,
  log,
  track = { container: () => undefined }
}) => {
  const imageTarPath = join(temporaryRoot, 'image.tar')
  const extractedRoot = join(temporaryRoot, 'image-root')

  const imageId = (
    await runStrict(['docker', 'image', 'inspect', '--format', '{{.Id}}', imageTag], {
      timeoutMs: 60_000,
      label: 'docker image inspect (id)'
    })
  ).stdout.trim()
  log(`image id ${imageId}`)

  // ---- 镜像 Config 断言 ----
  const configRaw = (
    await runStrict(['docker', 'image', 'inspect', '--format', '{{json .Config}}', imageTag], {
      timeoutMs: 60_000,
      label: 'docker image inspect (config)'
    })
  ).stdout
  let imageConfig
  try {
    imageConfig = JSON.parse(configRaw)
  } catch {
    fatal('docker image inspect returned unparsable Config JSON')
  }
  if (imageConfig.User !== expectedImageConfig.user) {
    problem(`image config: User must be ${expectedImageConfig.user}, got ${String(imageConfig.User)}`)
  }
  if (imageConfig.WorkingDir !== expectedImageConfig.workingDir) {
    problem(`image config: WorkingDir must be ${expectedImageConfig.workingDir}, got ${String(imageConfig.WorkingDir)}`)
  }
  if (
    !(
      imageConfig.Entrypoint === null ||
      imageConfig.Entrypoint === undefined ||
      (Array.isArray(imageConfig.Entrypoint) && imageConfig.Entrypoint.length === 0)
    )
  ) {
    problem(`image config: Entrypoint must be empty, got ${JSON.stringify(imageConfig.Entrypoint)}`)
  }
  if (JSON.stringify(imageConfig.Cmd) !== JSON.stringify(expectedImageConfig.cmd)) {
    problem(`image config: Cmd must be ${JSON.stringify(expectedImageConfig.cmd)}, got ${JSON.stringify(imageConfig.Cmd)}`)
  }
  if (JSON.stringify(imageConfig.Env) !== JSON.stringify(expectedImageConfig.env)) {
    problem(`image config: Env must be exactly the four pinned variables, got ${JSON.stringify(imageConfig.Env)}`)
  }
  for (const [field, value] of [
    ['ExposedPorts', imageConfig.ExposedPorts],
    ['Volumes', imageConfig.Volumes],
    ['Healthcheck', imageConfig.Healthcheck]
  ]) {
    if (value !== null && value !== undefined) {
      problem(`image config: ${field} must be absent, got ${JSON.stringify(value)}`)
    }
  }

  // ---- 全文件系统取证：不启动容器 ----
  const created = await runStrict(['docker', 'create', imageTag], { timeoutMs: 60_000, label: 'docker create' })
  const containerId = created.stdout.trim()
  track.container(containerId)
  await runStrict(['docker', 'export', containerId, '-o', imageTarPath], {
    timeoutMs: 300_000,
    label: 'docker export'
  })
  const containerRemoval = await runCommand(['docker', 'rm', containerId], { timeoutMs: 60_000 })
  if (containerRemoval.status !== 0) {
    problem('scratch container could not be removed after export')
  } else {
    track.container(null)
  }

  const listing = (
    await runStrict(['tar', '-tf', imageTarPath], { timeoutMs: 300_000, label: 'tar listing' })
  ).stdout
    .split('\n')
    .filter(Boolean)

  // ---- 结构断言：/app 恰好四项、无 stray 组件、无第二个依赖树 ----
  const appTopLevel = new Set()
  const migrationEntries = new Set()
  const strayTypescript = []
  const strayPackageJson = []
  const usrLocalBin = new Set()
  const listingNodeModuleNames = new Set()
  let usrLocalLibNodeModulesChildren = 0
  let sawDistIndex = false
  let sawDistMigrate = false
  for (const entry of listing) {
    const topMatch = /^app\/([^/]+)\/?$/.exec(entry)
    if (topMatch !== null) {
      appTopLevel.add(topMatch[1])
    }
    const migrationMatch = /^app\/migrations\/([^/]+)$/.exec(entry)
    if (migrationMatch !== null) {
      migrationEntries.add(migrationMatch[1])
    }
    if (entry === 'app/dist/index.js') {
      sawDistIndex = true
    }
    if (entry === 'app/dist/database/migrate.js') {
      sawDistMigrate = true
    }
    if (entry.startsWith('app/dist/') && entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      strayTypescript.push(entry)
    }
    if (/(^|\/)package\.json$/.test(entry) && !entry.startsWith('app/node_modules/') && entry !== 'app/package.json') {
      strayPackageJson.push(entry)
    }
    if (/workspace/.test(entry) || entry.startsWith('opt/meal-agent-api-runtime')) {
      problem(`image filesystem: build-stage residue must not ship (${entry})`)
    }
    if (/^usr\/local\/lib\/node_modules\/./.test(entry)) {
      usrLocalLibNodeModulesChildren += 1
    }
    const binMatch = /^usr\/local\/bin\/([^/]+)\/?$/.exec(entry)
    if (binMatch !== null) {
      usrLocalBin.add(binMatch[1])
    }
    if (basename(entry).startsWith('.env')) {
      problem(`image filesystem: dotenv material must not ship (${entry})`)
    }
    if (entry.startsWith('app/') && (entry.endsWith('pnpm-lock.yaml') || basename(entry) === '.npmrc')) {
      problem(`image filesystem: package-manager metadata must not ship under /app (${entry})`)
    }
    // denylist 的取证面：整个文件系统里任何 node_modules/<name> 路径段。
    const segmentMatch = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+?)\/?$/.exec(entry)
    if (segmentMatch !== null && !segmentMatch[1].startsWith('.')) {
      listingNodeModuleNames.add(segmentMatch[1])
    }
    const interiorMatch = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\//.exec(entry)
    if (interiorMatch !== null) {
      listingNodeModuleNames.add(interiorMatch[1])
    }
  }
  const expectedAppTopLevel = ['dist', 'migrations', 'node_modules', 'package.json']
  if (JSON.stringify([...appTopLevel].sort()) !== JSON.stringify(expectedAppTopLevel)) {
    problem(`image filesystem: /app must hold exactly ${expectedAppTopLevel.join(', ')}; got ${listSample(appTopLevel)}`)
  }
  if (!sawDistIndex) {
    problem('image filesystem: app/dist/index.js (the CMD target) is missing')
  }
  if (!sawDistMigrate) {
    problem('image filesystem: app/dist/database/migrate.js (the migrate one-off target) is missing')
  }
  for (const entry of strayTypescript.slice(0, 8)) {
    problem(`image filesystem: TypeScript source must not ship in dist (${entry})`)
  }
  for (const entry of strayPackageJson.slice(0, 8)) {
    problem(`image filesystem: unexpected package.json outside /app (${entry})`)
  }
  if (usrLocalLibNodeModulesChildren !== 0) {
    problem('image filesystem: /usr/local/lib/node_modules must stay empty after the package-manager cleanup')
  }
  const expectedUsrLocalBin = ['docker-entrypoint.sh', 'node', 'nodejs']
  if (JSON.stringify([...usrLocalBin].sort()) !== JSON.stringify(expectedUsrLocalBin)) {
    problem(`image filesystem: /usr/local/bin must hold exactly ${expectedUsrLocalBin.join(', ')}; got ${listSample(usrLocalBin)}`)
  }

  // ---- 提取 /app 负载：migrations 逐字节、package.json 逐字段、node_modules 逐包 ----
  mkdirSync(extractedRoot, { recursive: true })
  await runStrict(
    ['tar', '-xf', imageTarPath, '-C', extractedRoot, 'app/node_modules', 'app/package.json', 'app/migrations'],
    { timeoutMs: 300_000, label: 'tar extraction' }
  )

  const repositoryMigrations = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const imageMigrations = [...migrationEntries].sort()
  if (JSON.stringify(imageMigrations) !== JSON.stringify(repositoryMigrations)) {
    problem(
      `migrations: image set (${listSample(imageMigrations)}) must equal repository set (${listSample(repositoryMigrations)})`
    )
  } else {
    for (const name of repositoryMigrations) {
      const repositoryBytes = readFileSync(join(migrationsDirectory, name))
      const imageBytes = readFileSync(join(extractedRoot, 'app/migrations', name))
      if (!repositoryBytes.equals(imageBytes)) {
        problem(`migrations: ${name} differs byte-for-byte between image and repository`)
      }
    }
  }

  const parseManifest = (path, label) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      problem(`${label}: package.json is unreadable`)
      return null
    }
  }
  const imageManifest = parseManifest(join(extractedRoot, 'app/package.json'), 'image /app')
  const expectedManifest = parseManifest(join(expected.deployDirectory, 'package.json'), 'expected-closure')
  if (imageManifest !== null && expectedManifest !== null) {
    if (imageManifest.name !== '@meal-agent/api') {
      problem(`image /app: package.json name must be @meal-agent/api, got ${String(imageManifest.name)}`)
    }
    for (const field of ['name', 'version', 'dependencies']) {
      if (JSON.stringify(imageManifest[field]) !== JSON.stringify(expectedManifest[field])) {
        problem(`image /app: package.json ${field} differs from the deploy-derived manifest`)
      }
    }
  }

  const imageInventory = inventoryNodeModules(join(extractedRoot, 'app/node_modules'), 'image', problem)

  // ---- 闭包精确比对 ----
  const expectedSet = packageSetOf(expected.inventory)
  const imageSet = packageSetOf(imageInventory)
  const missingFromImage = [...expectedSet].filter((entry) => !imageSet.has(entry))
  const unexpectedInImage = [...imageSet].filter((entry) => !expectedSet.has(entry))
  if (missingFromImage.length > 0) {
    problem(`closure: packages missing from the image: ${listSample(missingFromImage)}`)
  }
  if (unexpectedInImage.length > 0) {
    problem(`closure: packages in the image but not in the deploy-derived closure: ${listSample(unexpectedInImage)}`)
  }
  const expectedLinkNames = [...expected.inventory.links.keys()].sort()
  const imageLinkNames = [...imageInventory.links.keys()].sort()
  if (JSON.stringify(expectedLinkNames) !== JSON.stringify(imageLinkNames)) {
    problem(
      `closure: top-level dependency links differ (expected ${listSample(expectedLinkNames)}; image ${listSample(imageLinkNames)})`
    )
  } else {
    for (const name of expectedLinkNames) {
      if (expected.inventory.links.get(name) !== imageInventory.links.get(name)) {
        problem(`closure: top-level link ${name} points at a different store entry in the image`)
      }
    }
  }

  // ---- 显名 denylist（独立于闭包比对的第二层；判定面含全镜像路径段） ----
  const imageNames = new Set(imageInventory.links.keys())
  for (const entry of imageInventory.packages) {
    imageNames.add(entry.name)
  }
  for (const name of listingNodeModuleNames) {
    imageNames.add(name)
  }
  imageNames.delete(selfLinkName)
  const forbiddenHits = [...imageNames].filter(
    (name) => forbiddenExactNames.has(name) || forbiddenNamePrefixes.some((prefix) => name.startsWith(prefix))
  )
  for (const name of forbiddenHits.sort()) {
    problem(`denylist: client/build dependency must not ship in the runtime image: ${name}`)
  }
  for (const family of namedFamilies) {
    const hits = [...imageNames].filter((name) => family.matches(name))
    if (hits.length === 0) {
      log(`named family absent from the runtime image: ${family.label}`)
    }
  }
  if (!imageNames.has('@meal-agent/contracts')) {
    problem('closure: workspace dependency @meal-agent/contracts is missing from the runtime image')
  }

  return {
    packageCount: imageInventory.packages.length,
    linkCount: imageInventory.links.size,
    migrationCount: imageMigrations.length,
    imageId
  }
}
