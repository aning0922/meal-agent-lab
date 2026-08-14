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
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  createReadStream
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createGunzip, createZstdDecompress } from 'node:zlib'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCommand } from './m3b-subprocess.mjs'
import { isAbsenceMessage } from './m3b-docker.mjs'

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
export const createStrictRunner =
  (fatal, commandRunner = runCommand) =>
  async (args, { timeoutMs, cwd = repositoryRoot, label, stdin = null } = {}) => {
    let outcome
    try {
      outcome = await commandRunner(args, { timeoutMs, cwd, stdin })
    } catch {
      fatal(`${label ?? args[0]}: command failed to run`)
    }
    if (outcome.status !== 0) {
      const detail = outcome.signal !== null ? `killed by ${outcome.signal}` : `exit ${String(outcome.status)}`
      fatal(`${label ?? args[0]} failed (${detail})`)
    }
    return outcome
  }

// --------------------------------------------------------------------------
// Dockerfile 与 .dockerignore 的静态断言（只覆盖 BLOCK 向：客户端内容进入
// 构建面、镜像获得公网/参数化面）。Compose 侧静态检查另有专门门禁。
// --------------------------------------------------------------------------
export const checkDockerfileText = (text, problem) => {
  const stageAliases = new Set()
  let fromCount = 0
  let sawUser = false
  let sawEmptyEntrypoint = false
  let sawExpectedCmd = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (/^FROM\b/i.test(line)) {
      const fromMatch = /^FROM(?:\s+--platform=(?:"[^"]+"|'[^']+'|\S+))?\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line)
      if (fromMatch === null) {
        problem('Dockerfile: FROM has an unsupported or incomplete instruction shape')
        continue
      }
      fromCount += 1
      const [, reference, alias] = fromMatch
      if (reference !== pinnedBaseImage && !stageAliases.has(reference)) {
        problem('Dockerfile: FROM must use the pinned digest or a prior stage alias')
      }
      if (alias !== undefined) {
        stageAliases.add(alias)
      }
      continue
    }
    if (/^(ARG|EXPOSE)\b/i.test(line)) {
      problem('Dockerfile: ARG/EXPOSE instructions are not allowed in this image')
    }
    if (/^COPY\b/i.test(line) && /apps\/|packages\/ui/.test(line)) {
      problem('Dockerfile: COPY must not reference client workspaces')
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
  if (fromCount === 0) {
    problem('Dockerfile: at least one complete FROM instruction is required')
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
      problem('.dockerignore: negation rule must not re-admit client or secret material')
    }
  }
  const lastNegationIndex = rules.findLastIndex((rule) => rule.startsWith('!'))
  for (const required of [
    '.env',
    '**/.env',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
    '**/*.crt',
    '**/*.cer',
    '**/*.p12',
    '**/*.pfx',
    '**/*.jks',
    '**/*.keystore',
    '**/id_rsa*',
    '**/id_ecdsa*',
    '**/id_ed25519*',
    '**/*.gpg',
    '**/*.asc',
    '**/project.private.config.json'
  ]) {
    const index = rules.lastIndexOf(required)
    if (index === -1) {
      problem(`.dockerignore: unconditional secret exclusion \`${required}\` is missing`)
    } else if (index < lastNegationIndex) {
      problem(`.dockerignore: unconditional secret exclusion \`${required}\` must appear after every negation rule`)
    }
  }
}

export const parseDockerImageId = (stdout, fatal) => {
  const value = stdout.trim()
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    fatal('docker image inspect returned a noncanonical image ID')
  }
  return value
}

export const parseDockerContainerId = (stdout, fatal) => {
  const value = stdout.trim()
  if (!/^[0-9a-f]{64}$/.test(value)) {
    fatal('docker create returned a noncanonical container ID')
  }
  return value
}

export const checkImageConfig = (imageConfig, problem, fatal) => {
  if (imageConfig === null || Array.isArray(imageConfig) || typeof imageConfig !== 'object') {
    fatal('docker image inspect returned a non-object Config payload')
  }
  if (imageConfig.User !== expectedImageConfig.user) {
    problem(`image config: User must be ${expectedImageConfig.user}`)
  }
  if (imageConfig.WorkingDir !== expectedImageConfig.workingDir) {
    problem(`image config: WorkingDir must be ${expectedImageConfig.workingDir}`)
  }
  if (
    !(
      imageConfig.Entrypoint === null ||
      imageConfig.Entrypoint === undefined ||
      (Array.isArray(imageConfig.Entrypoint) && imageConfig.Entrypoint.length === 0)
    )
  ) {
    problem('image config: Entrypoint must be empty')
  }
  if (JSON.stringify(imageConfig.Cmd) !== JSON.stringify(expectedImageConfig.cmd)) {
    problem(`image config: Cmd must be ${JSON.stringify(expectedImageConfig.cmd)}`)
  }
  if (JSON.stringify(imageConfig.Env) !== JSON.stringify(expectedImageConfig.env)) {
    problem('image config: Env must be exactly the four pinned variables')
  }
  for (const [field, value] of [
    ['ExposedPorts', imageConfig.ExposedPorts],
    ['Volumes', imageConfig.Volumes],
    ['Healthcheck', imageConfig.Healthcheck]
  ]) {
    if (value !== null && value !== undefined) {
      problem(`image config: ${field} must be absent`)
    }
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isImageId = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
const ociIndexMediaType = 'application/vnd.oci.image.index.v1+json'
const ociManifestMediaType = 'application/vnd.oci.image.manifest.v1+json'
const ociConfigMediaType = 'application/vnd.oci.image.config.v1+json'
const inTotoMediaType = 'application/vnd.in-toto+json'
const layerMediaTypes = new Set([
  'application/vnd.oci.image.layer.v1.tar',
  'application/vnd.oci.image.layer.v1.tar+gzip',
  'application/vnd.oci.image.layer.v1.tar+zstd',
  'application/vnd.docker.image.rootfs.diff.tar.gzip'
])

export const validateOciDescriptor = (descriptor, role, fatal) => {
  if (
    !isRecord(descriptor) ||
    !isImageId(descriptor.digest) ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size <= 0 ||
    typeof descriptor.mediaType !== 'string' ||
    (role === 'root' && ![ociIndexMediaType, ociManifestMediaType].includes(descriptor.mediaType)) ||
    (role === 'config' && descriptor.mediaType !== ociConfigMediaType) ||
    (role === 'layer' && !layerMediaTypes.has(descriptor.mediaType)) ||
    (role === 'attestation' && descriptor.mediaType !== inTotoMediaType) ||
    !['root', 'config', 'layer', 'attestation'].includes(role)
  ) {
    fatal('docker image save returned an invalid OCI descriptor')
  }
  return descriptor
}

export const validateSlsaProvenanceStatement = (statement, fatal) => {
  const buildDefinition = statement?.predicate?.buildDefinition
  const runDetails = statement?.predicate?.runDetails
  if (
    !isRecord(statement) ||
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
    !isRecord(statement.predicate) ||
    !isRecord(buildDefinition) ||
    typeof buildDefinition.buildType !== 'string' ||
    buildDefinition.buildType === '' ||
    !isRecord(buildDefinition.externalParameters) ||
    !isRecord(buildDefinition.internalParameters) ||
    !Array.isArray(buildDefinition.resolvedDependencies) ||
    !isRecord(runDetails) ||
    !isRecord(runDetails.builder) ||
    typeof runDetails.builder.id !== 'string' ||
    !isRecord(runDetails.metadata) ||
    typeof runDetails.metadata.invocationId !== 'string' ||
    runDetails.metadata.invocationId === '' ||
    typeof runDetails.metadata.startedOn !== 'string' ||
    runDetails.metadata.startedOn === '' ||
    typeof runDetails.metadata.finishedOn !== 'string' ||
    runDetails.metadata.finishedOn === '' ||
    !Array.isArray(statement.subject) ||
    statement.subject.length === 0 ||
    statement.subject.some(
      (subject) =>
        !isRecord(subject) ||
        typeof subject.name !== 'string' ||
        subject.name === '' ||
        !isRecord(subject.digest) ||
        typeof subject.digest.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(subject.digest.sha256)
    )
  ) {
    fatal('docker image save returned an invalid provenance attestation')
  }
  return statement
}

export const requireBoundProvenance = (
  attestationSubjects,
  selectedManifestDigest,
  fatal
) => {
  if (
    attestationSubjects.length === 0 ||
    selectedManifestDigest === null ||
    !attestationSubjects.includes(selectedManifestDigest)
  ) {
    fatal('docker image save provenance is missing or not bound to the selected platform manifest')
  }
}
const historySecretPattern = /(?:DATABASE_URL|APP_SECRET|APPSECRET|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN)\s*=/i
const historyTextContainsSecret = (value) => historySecretPattern.test(value)

export const parseImageInspect = (stdout, expectedId, fatal) => {
  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    fatal('docker image inspect returned unparsable JSON')
  }
  if (
    !Array.isArray(payload) ||
    payload.length !== 1 ||
    !isRecord(payload[0]) ||
    payload[0].Id !== expectedId ||
    !isRecord(payload[0].Config) ||
    typeof payload[0].Architecture !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(payload[0].Architecture) ||
    typeof payload[0].Os !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(payload[0].Os) ||
    typeof payload[0].Created !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(payload[0].Created) ||
    !Number.isFinite(Date.parse(payload[0].Created)) ||
    !isRecord(payload[0].Descriptor) ||
    payload[0].Descriptor.digest !== expectedId ||
    !isRecord(payload[0].RootFS) ||
    payload[0].RootFS.Type !== 'layers' ||
    !Array.isArray(payload[0].RootFS.Layers) ||
    payload[0].RootFS.Layers.length === 0 ||
    !payload[0].RootFS.Layers.every(isImageId)
  ) {
    fatal('docker image inspect returned invalid immutable-image evidence')
  }
  return payload[0]
}

export const parseContainerInspect = (stdout, expectedContainerId, expectedImageId, fatal) => {
  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    fatal('docker container inspect returned unparsable JSON')
  }
  if (
    !Array.isArray(payload) ||
    payload.length !== 1 ||
    !isRecord(payload[0]) ||
    payload[0].Id !== expectedContainerId ||
    payload[0].Image !== expectedImageId ||
    typeof payload[0].Path !== 'string' ||
    payload[0].Path === ''
  ) {
    fatal('docker container inspect did not bind the scratch container to the immutable image')
  }
  return payload[0]
}

export const parseOwnedScratchContainer = (
  stdout,
  { expectedName, expectedImageId, expectedContainerId = null },
  fatal
) => {
  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    fatal('scratch container identity evidence was unreadable')
  }
  const container = payload?.[0]
  if (
    !Array.isArray(payload) ||
    payload.length !== 1 ||
    !isRecord(container) ||
    !/^[0-9a-f]{64}$/.test(container.Id ?? '') ||
    (expectedContainerId !== null && container.Id !== expectedContainerId) ||
    container.Image !== expectedImageId ||
    container.Name !== `/${expectedName}` ||
    typeof container.Path !== 'string' ||
    container.Path === '' ||
    !isRecord(container.Config) ||
    !isRecord(container.Config.Labels) ||
    container.Config.Labels['meal-agent.m5.owner'] !== expectedName
  ) {
    fatal('scratch container identity did not match this run')
  }
  return container
}

export const parseImageHistory = (stdout, expectedImageId, minimumRows, fatal, problem) => {
  const text = String(stdout ?? '')
  if (text === '' || text.includes('\r') || !text.endsWith('\n')) {
    fatal('docker image history returned invalid framing')
  }
  const body = text.slice(0, -1)
  const lines = body.split('\n')
  let rows
  try {
    rows = lines.map((line) => JSON.parse(line))
  } catch {
    fatal('docker image history returned unparsable JSON lines')
  }
  if (
    lines.some((line) => line === '') ||
    rows.length < minimumRows ||
    rows[0]?.ID !== expectedImageId ||
    rows.some(
      (row) =>
        !isRecord(row) ||
        JSON.stringify(Object.keys(row).sort()) !==
          JSON.stringify(['Comment', 'CreatedAt', 'CreatedBy', 'CreatedSince', 'ID', 'Size']) ||
        !(row.ID === '<missing>' || isImageId(row.ID)) ||
        typeof row.CreatedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}(?:T| )/.test(row.CreatedAt) ||
        !Number.isFinite(Date.parse(row.CreatedAt)) ||
        typeof row.CreatedBy !== 'string' ||
        row.CreatedBy.trim() === '' ||
        typeof row.CreatedSince !== 'string' ||
        row.CreatedSince.trim() === '' ||
        /[\r\n]/.test(row.CreatedSince) ||
        typeof row.Size !== 'string' ||
        !/^\d+(?:\.\d+)?(?:B|kB|MB|GB|TB)$/.test(row.Size) ||
        typeof row.Comment !== 'string'
    )
  ) {
    fatal('docker image history returned incomplete or mismatched evidence')
  }
  if (rows.some((row) => historyTextContainsSecret(row.CreatedBy) || historyTextContainsSecret(row.Comment))) {
    problem('image history: secret-shaped build instruction must not ship')
  }
  return rows
}

export const parseSavedImageManifest = (stdout, expectedLayerCount, fatal) => {
  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    fatal('docker image save returned an unreadable manifest')
  }
  const entry = payload?.[0]
  if (
    !Array.isArray(payload) ||
    payload.length !== 1 ||
    !isRecord(entry) ||
    !/^blobs\/sha256\/[0-9a-f]{64}$/.test(entry.Config ?? '') ||
    entry.RepoTags !== null ||
    !Array.isArray(entry.Layers) ||
    entry.Layers.length !== expectedLayerCount ||
    new Set(entry.Layers).size !== entry.Layers.length ||
    !entry.Layers.every((layer) => /^blobs\/sha256\/[0-9a-f]{64}$/.test(layer))
  ) {
    fatal('docker image save returned incomplete immutable-image metadata')
  }
  return entry
}

export const parseSavedImageConfig = (
  bytes,
  configPath,
  expectedImageEvidence,
  historyRows,
  fatal,
  problem
) => {
  const expectedLayers = expectedImageEvidence.RootFS.Layers
  const expectedDigest = configPath.slice('blobs/sha256/'.length)
  if (!Buffer.isBuffer(bytes) || createHash('sha256').update(bytes).digest('hex') !== expectedDigest) {
    fatal('docker image save returned a config blob with the wrong digest')
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fatal('docker image save returned a config blob with invalid UTF-8')
  }
  let config
  try {
    config = JSON.parse(text)
  } catch {
    fatal('docker image save returned an unreadable config blob')
  }
  const history = config?.history
  if (
    !isRecord(config) ||
    config.architecture !== expectedImageEvidence.Architecture ||
    config.os !== expectedImageEvidence.Os ||
    Date.parse(config.created) !== Date.parse(expectedImageEvidence.Created) ||
    JSON.stringify(config.config) !== JSON.stringify(expectedImageEvidence.Config) ||
    !isRecord(config.rootfs) ||
    config.rootfs.type !== 'layers' ||
    JSON.stringify(config.rootfs.diff_ids) !== JSON.stringify(expectedLayers) ||
    !Array.isArray(history) ||
    history.length !== historyRows.length
  ) {
    fatal('docker image save returned incomplete immutable-image config evidence')
  }
  const chronologicalRows = [...historyRows].reverse()
  let nonemptyLayers = 0
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index]
    const cli = chronologicalRows[index]
    if (
      !isRecord(entry) ||
      !Object.keys(entry).every((key) =>
        ['comment', 'created', 'created_by', 'empty_layer'].includes(key)
      ) ||
      typeof entry.created !== 'string' ||
      !Number.isFinite(Date.parse(entry.created)) ||
      typeof entry.created_by !== 'string' ||
      entry.created_by.trim() === '' ||
      (entry.comment !== undefined && typeof entry.comment !== 'string') ||
      (entry.empty_layer !== undefined && entry.empty_layer !== true) ||
      cli.CreatedBy !== entry.created_by ||
      cli.Comment !== (entry.comment ?? '') ||
      Math.floor(Date.parse(cli.CreatedAt) / 1_000) !==
        Math.floor(Date.parse(entry.created) / 1_000) ||
      (entry.empty_layer === true && cli.Size !== '0B')
    ) {
      fatal('docker image history does not match the content-addressed config history')
    }
    if (entry.empty_layer !== true) {
      nonemptyLayers += 1
    }
    if (historyTextContainsSecret(entry.created_by) || historyTextContainsSecret(entry.comment ?? '')) {
      problem('image history: secret-shaped build instruction must not ship')
    }
  }
  if (nonemptyLayers !== expectedLayers.length) {
    fatal('docker image config history does not account for every filesystem layer')
  }
}

const tarBlockSize = 512

const tarField = (bytes) => {
  const zero = bytes.indexOf(0)
  if (zero === -1) return bytes.toString('utf8')
  if (!bytes.subarray(zero).every((byte) => byte === 0)) return null
  return bytes.subarray(0, zero).toString('utf8')
}

const parseTarOctal = (bytes) => {
  const text = bytes.toString('ascii').replace(/\0.*$/s, '').trim()
  if (!/^[0-7]+$/.test(text)) return null
  const value = Number.parseInt(text, 8)
  return Number.isSafeInteger(value) ? value : null
}

export const indexSavedImageTar = (archivePath, fatal) => {
  const fd = openSync(archivePath, 'r')
  const members = new Map()
  try {
    const archiveSize = fstatSync(fd).size
    let offset = 0
    let zeroBlocks = 0
    while (offset + tarBlockSize <= archiveSize) {
      const header = Buffer.alloc(tarBlockSize)
      if (readSync(fd, header, 0, header.length, offset) !== header.length) {
        fatal('docker image save returned a truncated tar header')
      }
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1
        offset += tarBlockSize
        if (zeroBlocks === 2) break
        continue
      }
      zeroBlocks = 0
      const recordedChecksum = parseTarOctal(header.subarray(148, 156))
      const checksumHeader = Buffer.from(header)
      checksumHeader.fill(0x20, 148, 156)
      const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0)
      const size = parseTarOctal(header.subarray(124, 136))
      const name = tarField(header.subarray(0, 100))
      const prefix = tarField(header.subarray(345, 500))
      if (name === null || prefix === null) fatal('docker image save returned noncanonical tar text fields')
      const path = prefix === '' ? name : `${prefix}/${name}`
      const type = header[156]
      if (
        recordedChecksum === null ||
        recordedChecksum !== actualChecksum ||
        size === null ||
        path === '' ||
        path.includes('\0') ||
        offset + tarBlockSize + size > archiveSize
      ) {
        fatal('docker image save returned malformed tar evidence')
      }
      if (members.has(path)) fatal('docker image save returned duplicate tar evidence')
      if (type === 0 || type === 0x30) {
        members.set(path, { offset: offset + tarBlockSize, size })
      } else if (
        type === 0x35 &&
        size === 0 &&
        ['blobs', 'blobs/', 'blobs/sha256', 'blobs/sha256/'].includes(path)
      ) {
        members.set(path, { directory: true, offset: offset + tarBlockSize, size })
      } else {
        fatal('docker image save returned an unsupported tar member')
      }
      offset += tarBlockSize + Math.ceil(size / tarBlockSize) * tarBlockSize
    }
    if (zeroBlocks !== 2) fatal('docker image save returned an unterminated tar archive')
    if (offset !== archiveSize) fatal('docker image save returned data after the tar terminator')
    return members
  } finally {
    closeSync(fd)
  }
}

const readArchiveMember = (archivePath, member, fatal) => {
  if (member === undefined || member.directory === true) {
    fatal('docker image save omitted a declared regular-file member')
  }
  const bytes = Buffer.alloc(member.size)
  const fd = openSync(archivePath, 'r')
  try {
    if (member.size > 0 && readSync(fd, bytes, 0, member.size, member.offset) !== member.size) {
      fatal('docker image save returned a truncated member')
    }
  } finally {
    closeSync(fd)
  }
  return bytes
}

export const validateSavedImageArchive = (
  archivePath,
  expectedImageEvidence,
  historyRows,
  fatal,
  problem
) => {
  const members = indexSavedImageTar(archivePath, fatal)
  const decodeJson = (path, label) => {
    const bytes = readArchiveMember(archivePath, members.get(path), fatal)
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      fatal(`${label} is not valid UTF-8`)
    }
    return { bytes, text }
  }
  const manifestBytes = decodeJson('manifest.json', 'docker image save manifest')
  const manifest = parseSavedImageManifest(
    manifestBytes.text,
    expectedImageEvidence.RootFS.Layers.length,
    fatal
  )
  const allowed = new Set([
    'blobs/',
    'blobs/sha256/',
    'index.json',
    'manifest.json',
    'oci-layout',
    manifest.Config,
    ...manifest.Layers
  ])
  const layout = decodeJson('oci-layout', 'docker image save OCI layout')
  let layoutPayload
  try { layoutPayload = JSON.parse(layout.text) } catch {
    fatal('docker image save returned an unreadable OCI layout')
  }
  if (
    !isRecord(layoutPayload) ||
    Object.keys(layoutPayload).length !== 1 ||
    layoutPayload.imageLayoutVersion !== '1.0.0'
  ) {
    fatal('docker image save returned an unsupported OCI layout')
  }
  const index = decodeJson('index.json', 'docker image save OCI index')
  let indexPayload
  try { indexPayload = JSON.parse(index.text) } catch { fatal('docker image save returned an unreadable OCI index') }
  if (
    !isRecord(indexPayload) ||
    indexPayload.schemaVersion !== 2 ||
    indexPayload.mediaType !== 'application/vnd.oci.image.index.v1+json' ||
    !Array.isArray(indexPayload.manifests) ||
    indexPayload.manifests.length !== 1
  ) {
    fatal('docker image save returned incomplete OCI index evidence')
  }
  const rootDescriptor = indexPayload.manifests[0]
  if (!isRecord(rootDescriptor) || rootDescriptor.digest !== expectedImageEvidence.Id) {
    fatal('docker image save OCI index is not bound to the immutable image ID')
  }
  let selectedManifest = null
  let selectedManifestDescriptor = null
  const attestationSubjects = []
  const visitDescriptor = (descriptor, role) => {
    validateOciDescriptor(descriptor, role, fatal)
    const path = `blobs/sha256/${descriptor.digest.slice('sha256:'.length)}`
    const member = members.get(path)
    const bytes = readArchiveMember(archivePath, member, fatal)
    if (
      bytes.length !== descriptor.size ||
      createHash('sha256').update(bytes).digest('hex') !== descriptor.digest.slice(7)
    ) {
      fatal('docker image save returned an OCI blob with the wrong identity')
    }
    allowed.add(path)
    if (role === 'attestation') {
      let statement
      try {
        statement = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } catch {
        fatal('docker image save returned an unreadable provenance attestation')
      }
      validateSlsaProvenanceStatement(statement, fatal)
      attestationSubjects.push(...statement.subject.map((subject) => `sha256:${subject.digest.sha256}`))
      return
    }
    if (descriptor.mediaType === ociIndexMediaType) {
      let nested
      try { nested = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch {
        fatal('docker image save returned an unreadable nested OCI index')
      }
      if (!isRecord(nested) || nested.schemaVersion !== 2 || !Array.isArray(nested.manifests)) {
        fatal('docker image save returned an invalid nested OCI index')
      }
      for (const child of nested.manifests) visitDescriptor(child, 'root')
      return
    }
    if (descriptor.mediaType === ociManifestMediaType) {
      let manifestPayload
      try { manifestPayload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch {
        fatal('docker image save returned an unreadable OCI manifest')
      }
      if (
        !isRecord(manifestPayload) ||
        manifestPayload.schemaVersion !== 2 ||
        !isRecord(manifestPayload.config) ||
        !Array.isArray(manifestPayload.layers)
      ) {
        fatal('docker image save returned an invalid OCI manifest')
      }
      const platform = descriptor.platform
      const isAttestation =
        isRecord(descriptor.annotations) &&
        descriptor.annotations['vnd.docker.reference.type'] === 'attestation-manifest' &&
        isRecord(platform) &&
        platform.architecture === 'unknown' &&
        platform.os === 'unknown'
      if (isAttestation) {
        if (
          manifestPayload.layers.length !== 1 ||
          !isRecord(manifestPayload.layers[0]) ||
          !isRecord(manifestPayload.layers[0].annotations) ||
          manifestPayload.layers[0].annotations['in-toto.io/predicate-type'] !==
            'https://slsa.dev/provenance/v1'
        ) {
          fatal('docker image save returned an invalid provenance attestation manifest')
        }
      } else if (
        (isRecord(platform) &&
          platform.architecture === expectedImageEvidence.Architecture &&
          platform.os === expectedImageEvidence.Os) ||
        (descriptor === rootDescriptor && platform === undefined)
      ) {
        if (selectedManifest !== null) fatal('docker image save returned multiple matching platform manifests')
        selectedManifest = manifestPayload
        selectedManifestDescriptor = descriptor
      } else {
        fatal('docker image save returned an unexpected platform manifest')
      }
      visitDescriptor(manifestPayload.config, 'config')
      for (const layer of manifestPayload.layers) {
        visitDescriptor(layer, isAttestation ? 'attestation' : 'layer')
      }
    }
  }
  visitDescriptor(rootDescriptor, 'root')
  requireBoundProvenance(
    attestationSubjects,
    selectedManifestDescriptor?.digest ?? null,
    fatal
  )
  if (
    selectedManifest === null ||
    selectedManifest.config.digest !== `sha256:${manifest.Config.slice('blobs/sha256/'.length)}` ||
    JSON.stringify(selectedManifest.layers.map((layer) => `blobs/sha256/${layer.digest.slice(7)}`)) !==
      JSON.stringify(manifest.Layers)
  ) {
    fatal('docker image save platform manifest does not match the exported image metadata')
  }
  for (const path of members.keys()) {
    if (!allowed.has(path)) fatal('docker image save returned an undeclared archive member')
  }
  for (const path of allowed) {
    if (!members.has(path)) fatal('docker image save omitted a required archive member')
  }
  const config = decodeJson(manifest.Config, 'docker image save config')
  parseSavedImageConfig(config.bytes, manifest.Config, expectedImageEvidence, historyRows, fatal, problem)
  return { members, manifest, layerDescriptors: selectedManifest.layers }
}

const hashArchiveMember = async (archivePath, member, { decompress = false } = {}) => {
  const hash = createHash('sha256')
  if (member.size === 0) return hash.digest('hex')
  let stream = createReadStream(archivePath, {
    start: member.offset,
    end: member.offset + member.size - 1
  })
  if (decompress) {
    const fd = openSync(archivePath, 'r')
    const magic = Buffer.alloc(4)
    try {
      readSync(fd, magic, 0, magic.length, member.offset)
    } finally {
      closeSync(fd)
    }
    if (magic[0] === 0x1f && magic[1] === 0x8b) {
      stream = stream.pipe(createGunzip())
    } else if (magic.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
      stream = stream.pipe(createZstdDecompress())
    }
  }
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

const validateLayerTarFraming = (path, fatal) => {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    let offset = 0
    let zeroBlocks = 0
    let sawTerminator = false
    while (offset + tarBlockSize <= size) {
      const header = Buffer.alloc(tarBlockSize)
      if (readSync(fd, header, 0, header.length, offset) !== header.length) {
        fatal('docker image save returned a truncated inner layer tar header')
      }
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1
        offset += tarBlockSize
        if (zeroBlocks >= 2) sawTerminator = true
        continue
      }
      if (sawTerminator) {
        fatal('docker image save returned data after the inner layer tar terminator')
      }
      zeroBlocks = 0
      const recordedChecksum = parseTarOctal(header.subarray(148, 156))
      const checksumHeader = Buffer.from(header)
      checksumHeader.fill(0x20, 148, 156)
      const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0)
      const memberSize = parseTarOctal(header.subarray(124, 136))
      const type = header[156]
      const supportedTypes = new Set([
        0, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
        0x67, 0x78, 0x4c, 0x4b
      ])
      if (
        recordedChecksum === null ||
        recordedChecksum !== actualChecksum ||
        memberSize === null ||
        !supportedTypes.has(type) ||
        offset + tarBlockSize + memberSize > size
      ) {
        fatal('docker image save returned malformed inner layer tar evidence')
      }
      offset += tarBlockSize + Math.ceil(memberSize / tarBlockSize) * tarBlockSize
    }
    if (!sawTerminator || offset !== size) {
      fatal('docker image save returned an unterminated or trailing inner layer tar')
    }
  } finally {
    closeSync(fd)
  }
}

const readLayerMagic = (archivePath, member) => {
  const fd = openSync(archivePath, 'r')
  const magic = Buffer.alloc(4)
  try {
    readSync(fd, magic, 0, magic.length, member.offset)
  } finally {
    closeSync(fd)
  }
  return magic
}

const layerCodec = (magic) =>
  magic[0] === 0x1f && magic[1] === 0x8b
    ? 'gzip'
    : magic.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
      ? 'zstd'
      : 'raw'

const expectedLayerCodec = (mediaType) =>
  mediaType.endsWith('+gzip') ||
  mediaType === 'application/vnd.docker.image.rootfs.diff.tar.gzip'
    ? 'gzip'
    : mediaType.endsWith('+zstd')
      ? 'zstd'
      : 'raw'

const hashAndValidateLayer = async (
  archivePath,
  member,
  mediaType,
  outputPath,
  fatal
) => {
  const hash = createHash('sha256')
  const actualCodec = layerCodec(readLayerMagic(archivePath, member))
  if (actualCodec !== expectedLayerCodec(mediaType)) {
    fatal('docker image save layer media type did not match the blob codec')
  }
  let stream = createReadStream(archivePath, {
    start: member.offset,
    end: member.offset + member.size - 1
  })
  const fd = openSync(outputPath, 'wx', 0o600)
  try {
    if (actualCodec === 'gzip') {
      stream = stream.pipe(createGunzip())
    } else if (actualCodec === 'zstd') {
      stream = stream.pipe(createZstdDecompress())
    }
    for await (const chunk of stream) {
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.length) {
        const written = writeSync(fd, chunk, offset, chunk.length - offset)
        if (!Number.isSafeInteger(written) || written <= 0) {
          fatal('docker image save inner layer spool did not make progress')
        }
        offset += written
      }
    }
  } catch {
    fatal('docker image save returned an unreadable compressed layer')
  } finally {
    closeSync(fd)
  }
  validateLayerTarFraming(outputPath, fatal)
  return hash.digest('hex')
}

export const verifySavedImageLayers = async (
  archivePath,
  layerPaths,
  layerDescriptors,
  expectedDiffIds,
  fatal
) => {
  if (
    layerPaths.length !== expectedDiffIds.length ||
    layerDescriptors.length !== layerPaths.length
  ) {
    fatal('docker image save layer count does not match immutable image evidence')
  }
  const members = indexSavedImageTar(archivePath, fatal)
  const layerWork = `${archivePath}.layers`
  mkdirSync(layerWork, { recursive: false, mode: 0o700 })
  try {
    for (let index = 0; index < layerPaths.length; index += 1) {
      const layerPath = layerPaths[index]
      const descriptor = layerDescriptors[index]
      if (
        !isRecord(descriptor) ||
        typeof descriptor.digest !== 'string' ||
        `blobs/sha256/${descriptor.digest.slice(7)}` !== layerPath
      ) {
        fatal('docker image save layer descriptor order did not match exported metadata')
      }
      const member = members.get(layerPath)
      if (member === undefined) fatal('docker image save omitted a declared layer blob')
      const blobDigest = layerPath.slice('blobs/sha256/'.length)
      if ((await hashArchiveMember(archivePath, member)) !== blobDigest) {
        fatal('docker image save returned a layer blob with the wrong digest')
      }
      const diffDigest = expectedDiffIds[index].slice('sha256:'.length)
      const actualDiff = await hashAndValidateLayer(
        archivePath,
        member,
        descriptor.mediaType,
        join(layerWork, `${String(index)}.tar`),
        fatal
      )
      if (actualDiff !== diffDigest) {
        fatal('docker image save returned a layer blob with the wrong diff ID')
      }
    }
  } finally {
    rmSync(layerWork, { recursive: true, force: true })
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

const encodeGeneratedShimLine = (line, replacements) => {
  let pieces = [['text', line]]
  for (const [literal, token] of replacements) {
    const next = []
    for (const piece of pieces) {
      if (piece[0] !== 'text') {
        next.push(piece)
        continue
      }
      const parts = piece[1].split(literal)
      for (const [index, part] of parts.entries()) {
        if (part !== '') next.push(['text', part])
        if (index < parts.length - 1) next.push([token])
      }
    }
    pieces = next
  }
  return pieces
}

export const dependencyPayloadOf = (
  nodeModulesDirectory,
  label,
  problem,
  {
    shimDeployRoot = dirname(nodeModulesDirectory),
    shimWorkspaceRoot = null,
    omitExpectedContractsReadme = false,
    expectedSelfLinkText = relative(
      join(nodeModulesDirectory, '@meal-agent'),
      dirname(nodeModulesDirectory)
    )
  } = {}
) => {
  const payload = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      const name = relative(nodeModulesDirectory, path)
      const stat = lstatSync(path)
      const isHostSpecificMetadata =
        name === '.modules.yaml' ||
        name === '.package-map.json' ||
        name === '.pnpm/lock.yaml'
      const isExpectedOnlyContractsReadme =
        omitExpectedContractsReadme &&
        name.endsWith('/node_modules/@meal-agent/contracts/README.md')
      if (isHostSpecificMetadata || isExpectedOnlyContractsReadme) {
        // pnpm writes the absolute deploy directory into this host-local metadata file.
        // Docker's filtered build context omits the workspace README, so the host oracle drops
        // that one host-only file. The image side never enables this option: every regular byte
        // it actually ships (including a maliciously inserted README) enters the payload digest.
        if (!stat.isFile()) {
          problem(`${label}: skipped dependency metadata must remain a regular file`)
        }
        continue
      }
      const isExecutableShim = name.split('/').includes('.bin')
      const isSelfLink =
        stat.isSymbolicLink() &&
        (name === selfLinkName || name.endsWith(`/node_modules/${selfLinkName}`))
      if (isSelfLink) {
        const target = readlinkSync(path)
        if (target !== expectedSelfLinkText) {
          problem(`${label}: the ${selfLinkName} self-link must match the deploy-derived target`)
        }
        payload.push(`link\0${name}\0<DEPLOY>`)
        continue
      }
      if (stat.isSymbolicLink()) {
        payload.push(`link\0${name}\0${readlinkSync(path)}`)
      } else if (stat.isDirectory()) {
        payload.push(`directory\0${name}`)
        visit(path)
      } else if (stat.isFile()) {
        const kind = isExecutableShim ? 'bin-file' : 'file'
        const mode = `${String(stat.mode & 0o7777)}\0`
        const bytes = readFileSync(path)
        let comparableBytes = bytes
        if (isExecutableShim) {
          const text = bytes.toString('utf8')
          if (!Buffer.from(text, 'utf8').equals(bytes)) {
            problem(`${label}: executable dependency shim must be valid UTF-8 text`)
          } else {
            // pnpm cmd shims embed the absolute deploy root. The host oracle is created in
            // a random temp directory while the image build uses /opt/...; normalize only
            // that root prefix and compare every remaining byte, mode and resulting size.
            const deployRoots = [shimDeployRoot]
            if (existsSync(shimDeployRoot)) {
              deployRoots.push(realpathSync(shimDeployRoot))
            }
            const distinctDeployRoots = [...new Set(deployRoots)]
              .sort((left, right) => right.length - left.length)
            const replacements = distinctDeployRoots
              .map((root) => [`${root}/node_modules/`, 'deploy'])
            if (shimWorkspaceRoot !== null) {
              replacements.push([`${shimWorkspaceRoot}/`, 'workspace'])
            }
            const comparableText = JSON.stringify(text
              .split('\n')
              .map((line) => {
                const generated =
                  line.trimStart().startsWith('export NODE_PATH="') ||
                  line.trimStart().startsWith('# cmd-shim-target=')
                return generated
                  ? encodeGeneratedShimLine(line, replacements)
                  : [['text', line]]
              }))
            comparableBytes = Buffer.from(comparableText, 'utf8')
          }
        }
        payload.push(
          `${kind}\0${name}\0${mode}${String(comparableBytes.length)}\0` +
            createHash('sha256').update(comparableBytes).digest('hex')
        )
      } else {
        problem(`${label}: unsupported filesystem entry in dependency payload`)
      }
    }
  }
  visit(nodeModulesDirectory)
  return {
    entries: payload,
    count: payload.length,
    sha256: createHash('sha256').update(payload.join('\n')).digest('hex')
  }
}

export const inventoryNodeModules = (
  nodeModulesDirectory,
  label,
  problem,
  {
    shimDeployRoot = dirname(nodeModulesDirectory),
    shimWorkspaceRoot = null,
    omitExpectedContractsReadme = false,
    expectedSelfLinkText = relative(
      join(nodeModulesDirectory, '@meal-agent'),
      dirname(nodeModulesDirectory)
    )
  } = {}
) => {
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
      problem(`${label}: unreadable package.json in the dependency tree`)
      return null
    }
    if (
      typeof parsed.name !== 'string' ||
      parsed.name === '' ||
      typeof parsed.version !== 'string' ||
      parsed.version === ''
    ) {
      problem(`${label}: dependency package.json lacks a usable name/version`)
      return null
    }
    return { name: parsed.name, version: parsed.version }
  }

  const recordLink = (linkPath, linkName) => {
    let target
    try {
      target = readlinkSync(linkPath)
    } catch {
      problem(`${label}: dependency entry is not a readable symlink`)
      return
    }
    const resolved = resolve(dirname(linkPath), target)
    if (linkName === selfLinkName) {
      sawSelfLink = true
      if (target !== expectedSelfLinkText) {
        problem(`${label}: the ${selfLinkName} self-link must match the deploy-derived target`)
      }
      links.set(linkName, '<DEPLOY>')
      return
    }
    if (!isInside(resolved, pnpmDirectory)) {
      problem(`${label}: dependency link escapes the .pnpm store`)
      return
    }
    const identity = readPackageIdentity(resolved)
    if (identity !== null && identity.name !== linkName) {
      problem(`${label}: dependency link resolves to a package with the wrong identity`)
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
          problem(`${label}: scoped dependency container must be a plain directory`)
          continue
        }
        for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
          const scopedName = `${entry.name}/${scoped.name}`
          if (!scoped.isSymbolicLink()) {
            problem(`${label}: scoped dependency must be a symlink into .pnpm`)
            continue
          }
          recordLink(join(entryPath, scoped.name), scopedName)
        }
        continue
      }
      if (!entry.isSymbolicLink()) {
        problem(`${label}: dependency must be a symlink into .pnpm`)
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
        problem(`${label}: root scoped dependency container must be a plain directory`)
        continue
      }
      for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
        const scopedName = `${entry.name}/${scoped.name}`
        if (!scoped.isSymbolicLink()) {
          problem(`${label}: root scoped dependency must be a symlink into .pnpm`)
          continue
        }
        recordLink(join(entryPath, scoped.name), scopedName)
      }
      continue
    }
    if (!entry.isSymbolicLink()) {
      problem(`${label}: unexpected root entry (neither known metadata nor a package symlink)`)
      continue
    }
    recordLink(entryPath, entry.name)
  }

  if (!existsSync(pnpmDirectory)) {
    problem(`${label}: .pnpm store directory is missing`)
    return { links, packages, payloadCount: 0, payloadSha256: null }
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
      problem(`${label}: unexpected .pnpm entry`)
      continue
    }
    const mountRoot = join(entryPath, 'node_modules')
    if (!existsSync(mountRoot)) {
      problem(`${label}: store key has no node_modules mount`)
      continue
    }
    const physicalHere = []
    const classifyLeaf = (leafPath, leafName) => {
      const stat = lstatSync(leafPath)
      if (stat.isSymbolicLink()) {
        const resolved = resolve(dirname(leafPath), readlinkSync(leafPath))
        if (!isInside(resolved, pnpmDirectory)) {
          problem(`${label}: store dependency link escapes the .pnpm store`)
        }
        return
      }
      if (!stat.isDirectory()) {
        problem(`${label}: unexpected file under a store key`)
        return
      }
      const identity = readPackageIdentity(leafPath)
      if (identity === null) {
        return
      }
      if (identity.name !== leafName) {
        problem(`${label}: physical package declares the wrong identity`)
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
          problem(`${label}: unexpected entry under a store key`)
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
        `${label}: store key holds ${String(physicalHere.length)} physical packages (expected exactly 1)`
      )
    }
    packages.push(...physicalHere)
  }
  if (!sawSelfLink) {
    problem(`${label}: the ${selfLinkName} self-link produced by pnpm deploy is missing`)
  }
  packages.sort((left, right) => (left.storeKey < right.storeKey ? -1 : left.storeKey > right.storeKey ? 1 : 0))
  const payload = dependencyPayloadOf(nodeModulesDirectory, label, problem, {
    shimDeployRoot,
    shimWorkspaceRoot,
    omitExpectedContractsReadme,
    expectedSelfLinkText
  })
  return {
    links,
    packages,
    payloadEntries: payload.entries,
    payloadCount: payload.count,
    payloadSha256: payload.sha256
  }
}

const packageSetOf = (inventory) =>
  new Set(inventory.packages.map((entry) => `${entry.storeKey} :: ${entry.name}@${entry.version}`))

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
    inventory: inventoryNodeModules(
      join(expectedDeployDirectory, 'node_modules'),
      'expected-closure',
      problem,
      {
        shimDeployRoot: expectedDeployDirectory,
        shimWorkspaceRoot: repositoryRoot,
        omitExpectedContractsReadme: true,
        expectedSelfLinkText: relative(
          join(expectedDeployDirectory, 'node_modules/.pnpm/node_modules/@meal-agent'),
          resolve(repositoryRoot, 'services/api')
        )
      }
    )
  }
}

// --------------------------------------------------------------------------
// 对一个**已构建**的镜像 tag 做完整扫描。container 的创建与移除都在这里完成；
// 中途失败时调用方通过 track.container 拿到残留 id 负责兜底移除。
// --------------------------------------------------------------------------
export const scanImage = async ({
  imageTag,
  expectedImageId,
  expected,
  temporaryRoot,
  runStrict,
  fatal,
  problem,
  log,
  scratchContainerName,
  track = {
    image: () => undefined,
    container: () => undefined,
    containerGone: () => undefined
  }
}) => {
  const imageTarPath = join(temporaryRoot, 'image.tar')
  const savedImageTarPath = join(temporaryRoot, 'saved-image.tar')
  const extractedRoot = join(temporaryRoot, 'image-root')

  const imageId = parseDockerImageId(
    (
      await runStrict(['docker', 'image', 'inspect', '--format', '{{.Id}}', imageTag], {
        timeoutMs: 60_000,
        label: 'docker image inspect (id)'
      })
    ).stdout,
    fatal
  )
  if (imageId !== expectedImageId) {
    fatal('per-run image tag no longer identifies the image produced by this build')
  }
  track.image(imageId)
  log(`image id ${imageId}`)

  // 从这一刻起只使用 immutable ID；tag 只是第一次解析入口，不能继续参与证据收集。
  const imageInspect = parseImageInspect(
    (
      await runStrict(['docker', 'image', 'inspect', imageId], {
        timeoutMs: 60_000,
        label: 'docker image inspect (immutable evidence)'
      })
    ).stdout,
    imageId,
    fatal
  )
  checkImageConfig(imageInspect.Config, problem, fatal)

  const historyRaw = (
    await runStrict(
      ['docker', 'image', 'history', '--no-trunc', '--format', '{{json .}}', imageId],
      {
        timeoutMs: 60_000,
        label: 'docker image history (immutable evidence)'
      }
    )
  ).stdout
  // Dockerfile 至少会产生一个 metadata-only history row，故完整 history 必须
  // 严格多于非空 RootFS layer 数；这也使删除一整条合法尾行不能伪装成完整证据。
  const historyRows = parseImageHistory(
    historyRaw,
    imageId,
    imageInspect.RootFS.Layers.length + 1,
    fatal,
    problem
  )
  await runStrict(['docker', 'image', 'save', '-o', savedImageTarPath, imageId], {
    timeoutMs: 300_000,
    label: 'docker image save (content-addressed history evidence)'
  })
  const archiveEvidence = validateSavedImageArchive(
    savedImageTarPath,
    imageInspect,
    historyRows,
    fatal,
    problem
  )
  const savedManifest = archiveEvidence.manifest
  await verifySavedImageLayers(
    savedImageTarPath,
    savedManifest.Layers,
    archiveEvidence.layerDescriptors,
    imageInspect.RootFS.Layers,
    fatal
  )
  // ---- 全文件系统取证：不启动容器 ----
  if (
    typeof scratchContainerName !== 'string' ||
    !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(scratchContainerName)
  ) {
    fatal('scratch container name is not a canonical per-run identifier')
  }
  const preexistingContainer = await runCommand(
    ['docker', 'container', 'inspect', scratchContainerName],
    { timeoutMs: 60_000 }
  )
  if (
    preexistingContainer.status === 0 ||
    !(
      preexistingContainer.status === 1 &&
      isAbsenceMessage(preexistingContainer.stderr, {
        kind: 'container',
        name: scratchContainerName
      })
    )
  ) {
    fatal('per-run scratch container was not proven absent before create')
  }
  track.container({
    state: 'intent',
    name: scratchContainerName,
    imageId
  })
  const created = await runStrict(
    [
      'docker',
      'create',
      '--name',
      scratchContainerName,
      '--label',
      `meal-agent.m5.owner=${scratchContainerName}`,
      imageId
    ],
    {
    timeoutMs: 60_000,
    label: 'docker create (immutable image)'
    }
  )
  const containerId = parseDockerContainerId(created.stdout, fatal)
  const containerInspectText = (
      await runStrict(['docker', 'container', 'inspect', containerId], {
        timeoutMs: 60_000,
        label: 'docker container inspect (identity binding)'
      })
    ).stdout
  parseOwnedScratchContainer(
    containerInspectText,
    {
      expectedName: scratchContainerName,
      expectedImageId: imageId,
      expectedContainerId: containerId
    },
    fatal
  )
  track.container({
    state: 'owned',
    name: scratchContainerName,
    id: containerId,
    imageId
  })
  await runStrict(['docker', 'export', containerId, '-o', imageTarPath], {
    timeoutMs: 300_000,
    label: 'docker export'
  })
  const containerRemoval = await runCommand(['docker', 'rm', containerId], { timeoutMs: 60_000 })
  if (containerRemoval.status !== 0) {
    problem('scratch container could not be removed after export')
  } else {
    let removalConfirmed = true
    for (const identifier of [containerId, scratchContainerName]) {
      const gone = await runCommand(['docker', 'container', 'inspect', identifier], {
        timeoutMs: 60_000
      })
      if (!(
        gone.status === 1 &&
        isAbsenceMessage(gone.stderr, { kind: 'container', name: identifier })
      )) {
        problem('scratch container was not proven absent after removal')
        removalConfirmed = false
        break
      }
    }
    if (removalConfirmed) {
      track.containerGone(scratchContainerName)
    }
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
      problem('image filesystem: build-stage residue must not ship')
    }
    if (/^usr\/local\/lib\/node_modules\/./.test(entry)) {
      usrLocalLibNodeModulesChildren += 1
    }
    const binMatch = /^usr\/local\/bin\/([^/]+)\/?$/.exec(entry)
    if (binMatch !== null) {
      usrLocalBin.add(binMatch[1])
    }
    if (basename(entry).startsWith('.env')) {
      problem('image filesystem: dotenv material must not ship')
    }
    if (entry.startsWith('app/') && (entry.endsWith('pnpm-lock.yaml') || basename(entry) === '.npmrc')) {
      problem('image filesystem: package-manager metadata must not ship under /app')
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
    const executableShimMatch = /(?:^|\/)node_modules\/\.bin\/([^/]+)\/?$/.exec(entry)
    if (executableShimMatch !== null) {
      listingNodeModuleNames.add(executableShimMatch[1])
    }
  }
  const expectedAppTopLevel = ['dist', 'migrations', 'node_modules', 'package.json']
  if (JSON.stringify([...appTopLevel].sort()) !== JSON.stringify(expectedAppTopLevel)) {
    problem(`image filesystem: /app must hold exactly ${expectedAppTopLevel.join(', ')}`)
  }
  if (!sawDistIndex) {
    problem('image filesystem: app/dist/index.js (the CMD target) is missing')
  }
  if (!sawDistMigrate) {
    problem('image filesystem: app/dist/database/migrate.js (the migrate one-off target) is missing')
  }
  if (strayTypescript.length > 0) {
    problem('image filesystem: TypeScript source must not ship in dist')
  }
  if (strayPackageJson.length > 0) {
    problem('image filesystem: unexpected package.json outside /app')
  }
  if (usrLocalLibNodeModulesChildren !== 0) {
    problem('image filesystem: /usr/local/lib/node_modules must stay empty after the package-manager cleanup')
  }
  const expectedUsrLocalBin = ['docker-entrypoint.sh', 'node', 'nodejs']
  if (JSON.stringify([...usrLocalBin].sort()) !== JSON.stringify(expectedUsrLocalBin)) {
    problem(`image filesystem: /usr/local/bin must hold exactly ${expectedUsrLocalBin.join(', ')}`)
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
      'migrations: image set must equal repository set'
    )
  } else {
    for (const name of repositoryMigrations) {
      const repositoryBytes = readFileSync(join(migrationsDirectory, name))
      const imageBytes = readFileSync(join(extractedRoot, 'app/migrations', name))
      if (!repositoryBytes.equals(imageBytes)) {
        problem('migrations: a file differs byte-for-byte between image and repository')
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
      problem('image /app: package.json name must be @meal-agent/api')
    }
    for (const field of ['name', 'version', 'dependencies']) {
      if (JSON.stringify(imageManifest[field]) !== JSON.stringify(expectedManifest[field])) {
        problem(`image /app: package.json ${field} differs from the deploy-derived manifest`)
      }
    }
  }

  const imageInventory = inventoryNodeModules(
    join(extractedRoot, 'app/node_modules'),
    'image',
    problem,
    {
      shimDeployRoot: '/opt/meal-agent-api-runtime',
      shimWorkspaceRoot: '/workspace',
      expectedSelfLinkText: posix.relative(
        '/opt/meal-agent-api-runtime/node_modules/.pnpm/node_modules/@meal-agent',
        '/workspace/services/api'
      )
    }
  )

  // ---- 闭包精确比对 ----
  const expectedSet = packageSetOf(expected.inventory)
  const imageSet = packageSetOf(imageInventory)
  const missingFromImage = [...expectedSet].filter((entry) => !imageSet.has(entry))
  const unexpectedInImage = [...imageSet].filter((entry) => !expectedSet.has(entry))
  if (missingFromImage.length > 0) {
    problem(`closure: ${String(missingFromImage.length)} package(s) are missing from the image`)
  }
  if (unexpectedInImage.length > 0) {
    problem(`closure: ${String(unexpectedInImage.length)} unexpected package(s) are present in the image`)
  }
  if (
    imageInventory.payloadCount !== expected.inventory.payloadCount ||
    imageInventory.payloadSha256 !== expected.inventory.payloadSha256
  ) {
    problem('closure: dependency payload differs byte-for-byte from the deploy-derived closure')
  }
  const expectedLinkNames = [...expected.inventory.links.keys()].sort()
  const imageLinkNames = [...imageInventory.links.keys()].sort()
  if (JSON.stringify(expectedLinkNames) !== JSON.stringify(imageLinkNames)) {
    problem(
      'closure: top-level dependency links differ'
    )
  } else {
    for (const name of expectedLinkNames) {
      if (expected.inventory.links.get(name) !== imageInventory.links.get(name)) {
        problem('closure: a top-level link points at a different store entry in the image')
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
  if (forbiddenHits.length > 0) {
    problem('denylist: client/build dependency must not ship in the runtime image')
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
