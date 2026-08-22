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
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  createReadStream
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { createGunzip, createZstdDecompress } from 'node:zlib'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { runCommand } from './m3b-subprocess.mjs'
import {
  isAbsenceMessage,
  parseCanonicalDockerContainerId,
  parseCanonicalDockerImageId
} from './m3b-docker.mjs'
import { settleOwnedScratchContainer } from './m5-runtime-settlement.mjs'

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
  async (
    args,
    {
      timeoutMs,
      cwd = repositoryRoot,
      label,
      stdin = null,
      inheritedFds = [],
      stdoutFd = null
    } = {}
  ) => {
    let outcome
    try {
      outcome = await commandRunner(args, {
        timeoutMs,
        cwd,
        stdin,
        inheritedFds,
        stdoutFd
      })
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
    if (/^STOPSIGNAL\b/i.test(line)) {
      problem('Dockerfile: STOPSIGNAL must be absent so Docker uses SIGTERM')
    }
    if (/^ONBUILD\b/i.test(line)) {
      problem('Dockerfile: ONBUILD instructions are not allowed in the runtime image')
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
  try {
    return parseCanonicalDockerImageId(stdout)
  } catch {
    fatal('docker image inspect returned a noncanonical image ID')
  }
}

export const parseDockerContainerId = (stdout, fatal) => {
  try {
    return parseCanonicalDockerContainerId(stdout)
  } catch {
    fatal('docker create returned a noncanonical container ID')
  }
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
    ['Healthcheck', imageConfig.Healthcheck],
    ['OnBuild', imageConfig.OnBuild]
  ]) {
    if (value !== null && value !== undefined) {
      problem(`image config: ${field} must be absent`)
    }
  }
  if (
    imageConfig.StopSignal !== null &&
    imageConfig.StopSignal !== undefined &&
    imageConfig.StopSignal !== ''
  ) {
    problem('image config: StopSignal must be absent so Docker uses SIGTERM')
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
  provenanceEvidence,
  selectedManifestDigest,
  fatal
) => {
  if (
    provenanceEvidence.length === 0 ||
    selectedManifestDigest === null ||
    provenanceEvidence.some((evidence) => {
      if (
        !isRecord(evidence) ||
        !isImageId(evidence.referenceDigest) ||
        !Array.isArray(evidence.subjects)
      ) {
        return true
      }
      // BuildKit may emit an empty subject for an untagged build. Only that exact
      // case may use the attestation descriptor reference as the binding. Once the
      // statement names a subject, this local single-output protocol requires one
      // canonical subject and no conflicting/duplicate companions.
      const binding = evidence.subjects.length === 0
        ? evidence.referenceDigest
        : evidence.subjects.length === 1 && evidence.subjects[0] === evidence.referenceDigest
          ? evidence.referenceDigest
          : null
      return binding !== selectedManifestDigest
    })
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
  {
    expectedName,
    expectedImageId,
    expectedContainerId = null,
    expectedUser,
    expectedNetworkMode,
    expectedReadonlyRootfs
  },
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
    typeof expectedUser !== 'string' ||
    expectedUser === '' ||
    expectedNetworkMode !== 'none' ||
    expectedReadonlyRootfs !== true ||
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
    container.Config.Labels['meal-agent.m5.owner'] !== expectedName ||
    container.Config.User !== expectedUser ||
    !isRecord(container.HostConfig) ||
    container.HostConfig.NetworkMode !== expectedNetworkMode ||
    container.HostConfig.ReadonlyRootfs !== expectedReadonlyRootfs
  ) {
    fatal('scratch container identity did not match this run')
  }
  return container
}

/**
 * The four production inspect boundaries share one closed capability
 * constructor. A caller cannot accidentally omit user/network/read-only and
 * silently turn those checks into optional parser branches.
 */
export const scratchCapabilityExpectation = ({
  name,
  imageId,
  containerId,
  user
}) => Object.freeze({
  expectedName: name,
  expectedImageId: imageId,
  expectedContainerId: containerId,
  expectedUser: user,
  expectedNetworkMode: 'none',
  expectedReadonlyRootfs: true
})

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

export const indexSavedImageTar = (archiveSource, fatal) => {
  const ownsFd = !Number.isSafeInteger(archiveSource)
  const fd = ownsFd ? openSync(archiveSource, 'r') : archiveSource
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
        if (zeroBlocks === 2) {
          if ((archiveSize - offset) % tarBlockSize !== 0) {
            fatal('docker image save returned data after the tar terminator')
          }
          while (offset < archiveSize) {
            const trailing = Buffer.alloc(Math.min(64 * 1024, archiveSize - offset))
            if (readSync(fd, trailing, 0, trailing.length, offset) !== trailing.length) {
              fatal('docker image save returned a truncated tar padding record')
            }
            if (!trailing.every((byte) => byte === 0)) {
              fatal('docker image save returned data after the tar terminator')
            }
            offset += trailing.length
          }
          break
        }
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
    if (ownsFd) closeSync(fd)
  }
}

const readArchiveMember = (archiveSource, member, fatal) => {
  if (member === undefined || member.directory === true) {
    fatal('docker image save omitted a declared regular-file member')
  }
  const bytes = Buffer.alloc(member.size)
  const ownsFd = !Number.isSafeInteger(archiveSource)
  const fd = ownsFd ? openSync(archiveSource, 'r') : archiveSource
  try {
    if (member.size > 0 && readSync(fd, bytes, 0, member.size, member.offset) !== member.size) {
      fatal('docker image save returned a truncated member')
    }
  } finally {
    if (ownsFd) closeSync(fd)
  }
  return bytes
}

export const validateSavedImageArchive = (
  archivePath,
  expectedImageEvidence,
  expectedBuildEvidence,
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
  const buildPlatform = expectedBuildEvidence?.descriptor?.platform
  const buildPlatformMatchesImage =
    buildPlatform === null ||
    (buildPlatform?.architecture === expectedImageEvidence.Architecture &&
      buildPlatform?.os === expectedImageEvidence.Os)
  const exportedPlatformMatchesBuild =
    rootDescriptor.platform === undefined ||
    JSON.stringify(rootDescriptor.platform) === JSON.stringify(buildPlatform)
  if (
    expectedBuildEvidence === null ||
    !isRecord(expectedBuildEvidence) ||
    !isRecord(expectedBuildEvidence.descriptor) ||
    rootDescriptor.digest !== expectedBuildEvidence.descriptor.digest ||
    rootDescriptor.mediaType !== expectedBuildEvidence.descriptor.mediaType ||
    rootDescriptor.size !== expectedBuildEvidence.descriptor.size ||
    !buildPlatformMatchesImage ||
    !exportedPlatformMatchesBuild
  ) {
    fatal('docker image save root descriptor did not match BuildKit evidence')
  }
  let selectedManifest = null
  let selectedManifestDescriptor = null
  const provenanceEvidence = []
  const visitDescriptor = (descriptor, role, attestationReference = null) => {
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
      if (!isImageId(attestationReference)) {
        fatal('docker image save provenance attestation lacked a manifest reference')
      }
      provenanceEvidence.push(Object.freeze({
        referenceDigest: attestationReference,
        subjects: Object.freeze(
          statement.subject.map((subject) => `sha256:${subject.digest.sha256}`)
        )
      }))
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
      let referenceDigest = null
      if (isAttestation) {
        referenceDigest = descriptor.annotations['vnd.docker.reference.digest']
        if (
          !isImageId(referenceDigest) ||
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
        visitDescriptor(
          layer,
          isAttestation ? 'attestation' : 'layer',
          isAttestation ? referenceDigest : null
        )
      }
    }
  }
  visitDescriptor(rootDescriptor, 'root')
  requireBoundProvenance(
    provenanceEvidence,
    selectedManifestDescriptor?.digest ?? null,
    fatal
  )
  if (
    selectedManifest === null ||
    (expectedBuildEvidence.configId !== null &&
      selectedManifest.config.digest !== expectedBuildEvidence.configId) ||
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

const hashArchiveMember = async (archiveSource, member, { decompress = false } = {}) => {
  const hash = createHash('sha256')
  if (member.size === 0) return hash.digest('hex')
  const ownsFd = !Number.isSafeInteger(archiveSource)
  const fd = ownsFd ? openSync(archiveSource, 'r') : archiveSource
  let stream = createReadStream(null, {
    fd,
    autoClose: false,
    start: member.offset,
    end: member.offset + member.size - 1
  })
  try {
    if (decompress) {
    const magic = Buffer.alloc(4)
      readSync(fd, magic, 0, magic.length, member.offset)
      if (magic[0] === 0x1f && magic[1] === 0x8b) {
        stream = stream.pipe(createGunzip())
      } else if (magic.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
        stream = stream.pipe(createZstdDecompress())
      }
    }
    for await (const chunk of stream) hash.update(chunk)
    return hash.digest('hex')
  } finally {
    if (ownsFd) closeSync(fd)
  }
}

const validateLayerTarFraming = (fd, fatal) => {
  {
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
  }
}

const tarString = (bytes) => {
  const nul = bytes.indexOf(0)
  return bytes.subarray(0, nul === -1 ? bytes.length : nul).toString('utf8')
}

const normalizeLayerMemberName = (name, fatal) => {
  if (typeof name !== 'string') {
    fatal('docker image layer contained an unsafe archive path')
  }
  // A single conventional `./` root marker and one directory trailing slash are
  // admissible. Any further lexical alias is rejected rather than normalized:
  // the evidence ledger and the host tar replay must have exactly one path key.
  const withoutRootMarker = name.startsWith('./') ? name.slice(2) : name
  const stripped = withoutRootMarker.endsWith('/')
    ? withoutRootMarker.slice(0, -1)
    : withoutRootMarker
  if (stripped === '') return null
  if (
    stripped.includes('\u0000') ||
    posix.isAbsolute(stripped) ||
    stripped.split('/').includes('..') ||
    posix.normalize(stripped) !== stripped
  ) {
    fatal('docker image layer contained an unsafe archive path')
  }
  return stripped
}

const readTarPayload = (fd, offset, size, fatal) => {
  if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) {
    fatal('docker image layer metadata payload exceeded its bound')
  }
  const bytes = Buffer.alloc(size)
  if (size > 0 && readSync(fd, bytes, 0, size, offset) !== size) {
    fatal('docker image layer metadata payload was truncated')
  }
  return bytes
}

const parsePaxMetadata = (bytes, fatal) => {
  let cursor = 0
  let path = null
  let linkPath = null
  let uid = null
  let gid = null
  const seen = new Set()
  while (cursor < bytes.length) {
    const space = bytes.indexOf(0x20, cursor)
    if (space === -1) fatal('docker image layer PAX metadata was malformed')
    const lengthText = bytes.subarray(cursor, space).toString('ascii')
    if (!/^[1-9][0-9]*$/.test(lengthText)) {
      fatal('docker image layer PAX metadata was malformed')
    }
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || cursor + length > bytes.length) {
      fatal('docker image layer PAX metadata was malformed')
    }
    const record = bytes.subarray(space + 1, cursor + length)
    if (record.at(-1) !== 0x0a) fatal('docker image layer PAX metadata was malformed')
    const equals = record.indexOf(0x3d)
    if (equals > 0) {
      const key = record.subarray(0, equals).toString('utf8')
      const value = record.subarray(equals + 1, -1).toString('utf8')
      if (seen.has(key)) fatal('docker image layer PAX metadata was ambiguous')
      seen.add(key)
      const ignoredMetadataKeys = new Set(['mtime', 'atime', 'ctime', 'uname', 'gname'])
      if (
        !['path', 'linkpath', 'uid', 'gid'].includes(key) &&
        !ignoredMetadataKeys.has(key)
      ) {
        fatal('docker image layer contained unsupported PAX filesystem metadata')
      }
      if (key === 'path') {
        if (value === '') fatal('docker image layer PAX path metadata was empty')
        path = value
      }
      if (key === 'linkpath') {
        if (value === '') fatal('docker image layer PAX link metadata was empty')
        linkPath = value
      }
      if (key === 'uid' || key === 'gid') {
        if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
          fatal('docker image layer PAX identity metadata was malformed')
        }
        const numeric = Number(value)
        if (!Number.isSafeInteger(numeric)) {
          fatal('docker image layer PAX identity metadata was malformed')
        }
        if (key === 'uid') uid = numeric
        else gid = numeric
      }
      if (['mtime', 'atime', 'ctime'].includes(key) && !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
        fatal('docker image layer PAX timestamp metadata was malformed')
      }
    }
    cursor += length
  }
  return Object.freeze({ path, linkPath, uid, gid })
}

/**
 * 解析 inner layer tar 自带的文件系统身份。宿主提取目录的 owner 不能代表镜像内
 * owner，因此 runtime `/app` 的 uid/gid/mode 必须直接来自内容寻址 tar header。
 */
export const parseLayerTarEvidence = (fd, fatal) => {
  const size = fstatSync(fd).size
  const entries = []
  const names = new Set()
  let offset = 0
  let pendingPath = null
  let pendingLinkPath = null
  let pendingUid = null
  let pendingGid = null
  let globalUid = null
  let globalGid = null
  while (offset + tarBlockSize <= size) {
    const header = Buffer.alloc(tarBlockSize)
    if (readSync(fd, header, 0, header.length, offset) !== header.length) {
      fatal('docker image save returned a truncated inner layer tar header')
    }
    if (header.every((byte) => byte === 0)) break
    const memberSize = parseTarOctal(header.subarray(124, 136))
    const mode = parseTarOctal(header.subarray(100, 108))
    const uid = parseTarOctal(header.subarray(108, 116))
    const gid = parseTarOctal(header.subarray(116, 124))
    if (memberSize === null || mode === null || uid === null || gid === null) {
      fatal('docker image layer identity metadata was malformed')
    }
    const type = header[156]
    const payloadOffset = offset + tarBlockSize
    if (type === 0x67 || type === 0x78) {
      const metadata = parsePaxMetadata(
        readTarPayload(fd, payloadOffset, memberSize, fatal),
        fatal
      )
      if (type === 0x67) {
        if (metadata.path !== null || metadata.linkPath !== null) {
          fatal('docker image layer global PAX metadata changed a member path')
        }
        if (metadata.uid !== null) globalUid = metadata.uid
        if (metadata.gid !== null) globalGid = metadata.gid
      } else {
        if (
          pendingPath !== null ||
          pendingLinkPath !== null ||
          pendingUid !== null ||
          pendingGid !== null
        ) {
          fatal('docker image layer contained stacked local PAX metadata')
        }
        pendingPath = metadata.path
        pendingLinkPath = metadata.linkPath
        pendingUid = metadata.uid
        pendingGid = metadata.gid
      }
    } else if (type === 0x4c) {
      pendingPath = tarString(readTarPayload(fd, payloadOffset, memberSize, fatal))
      if (pendingPath === '') fatal('docker image layer long path metadata was empty')
    } else if (type === 0x4b) {
      pendingLinkPath = tarString(readTarPayload(fd, payloadOffset, memberSize, fatal))
      if (pendingLinkPath === '') fatal('docker image layer long link metadata was empty')
    } else {
      const prefix = tarString(header.subarray(345, 500))
      const headerName = tarString(header.subarray(0, 100))
      const name = normalizeLayerMemberName(
        pendingPath ?? (prefix === '' ? headerName : `${prefix}/${headerName}`),
        fatal
      )
      pendingPath = null
      const rawLinkTarget = [0x31, 0x32].includes(type)
        ? (pendingLinkPath ?? tarString(header.subarray(157, 257)))
        : null
      const linkTarget = type === 0x31
        ? normalizeLayerMemberName(rawLinkTarget, fatal)
        : rawLinkTarget
      if (![0x31, 0x32].includes(type) && pendingLinkPath !== null) {
        fatal('docker image layer link metadata did not describe a link')
      }
      pendingLinkPath = null
      const effectiveUid = pendingUid ?? globalUid ?? uid
      const effectiveGid = pendingGid ?? globalGid ?? gid
      pendingUid = null
      pendingGid = null
      if (name === null) {
        offset += tarBlockSize + Math.ceil(memberSize / tarBlockSize) * tarBlockSize
        continue
      }
      if (names.has(name)) fatal('docker image layer contained duplicate archive members')
      names.add(name)
      const basename = posix.basename(name)
      if (
        basename.startsWith('.wh.') &&
        (basename === '.wh.' || ![0, 0x30].includes(type) || memberSize !== 0)
      ) {
        fatal('docker image layer contained an invalid whiteout marker')
      }
      if (name === 'app' || name.startsWith('app/')) {
        if (
          type === 0x31 &&
          !(linkTarget === 'app' || linkTarget?.startsWith('app/'))
        ) {
          fatal('docker image runtime payload contained an unsafe hardlink')
        }
        if (type === 0x32) {
          const specialPnpmSelfLink =
            name === 'app/node_modules/.pnpm/node_modules/@meal-agent/api' &&
            rawLinkTarget === '../../../../../../workspace/services/api'
          const resolvedTarget = posix.isAbsolute(rawLinkTarget)
            ? posix.normalize(rawLinkTarget).replace(/^\/+/, '')
            : posix.normalize(posix.join(posix.dirname(name), rawLinkTarget))
          if (
            !specialPnpmSelfLink &&
            !(resolvedTarget === 'app' || resolvedTarget.startsWith('app/'))
          ) {
            fatal('docker image runtime payload symlink escaped the protected app tree')
          }
        }
      }
      entries.push(Object.freeze({
        name,
        type,
        size: memberSize,
        mode,
        uid: effectiveUid,
        gid: effectiveGid,
        linkTarget
      }))
    }
    offset += tarBlockSize + Math.ceil(memberSize / tarBlockSize) * tarBlockSize
  }
  if (
    pendingPath !== null ||
    pendingLinkPath !== null ||
    pendingUid !== null ||
    pendingGid !== null
  ) {
    fatal('docker image layer metadata had no following member')
  }
  return Object.freeze(entries)
}

const applyLayerIdentityEvidence = (identityByPath, entries, fatal) => {
  for (const entry of entries) {
    const basename = posix.basename(entry.name)
    if (!basename.startsWith('.wh.')) continue
    const parent = posix.dirname(entry.name)
    if (basename === '.wh..wh..opq') {
      const prefix = parent === '.' ? '' : `${parent}/`
      for (const name of identityByPath.keys()) {
        if (name.startsWith(prefix) && name !== parent) identityByPath.delete(name)
      }
    } else {
      const target = parent === '.'
        ? basename.slice('.wh.'.length)
        : `${parent}/${basename.slice('.wh.'.length)}`
      for (const name of identityByPath.keys()) {
        if (name === target || name.startsWith(`${target}/`)) identityByPath.delete(name)
      }
    }
  }
  for (const entry of entries) {
    const basename = posix.basename(entry.name)
    if (basename.startsWith('.wh.')) continue
    if (entry.type !== 0x35) {
      for (const name of identityByPath.keys()) {
        if (name.startsWith(`${entry.name}/`)) identityByPath.delete(name)
      }
    }
    if (entry.type === 0x31) {
      const target = identityByPath.get(entry.linkTarget)
      if (target === undefined) {
        fatal('docker image runtime payload hardlink target was not in the verified layer view')
      }
      identityByPath.set(
        entry.name,
        Object.freeze({
          ...target,
          name: entry.name,
          type: entry.type,
          linkTarget: entry.linkTarget
        })
      )
    } else {
      identityByPath.set(entry.name, entry)
    }
  }
}

const readLayerMagic = (archiveFd, member) => {
  const magic = Buffer.alloc(4)
  readSync(archiveFd, magic, 0, magic.length, member.offset)
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
  archiveFd,
  member,
  mediaType,
  outputPath,
  fatal
) => {
  const hash = createHash('sha256')
  const actualCodec = layerCodec(readLayerMagic(archiveFd, member))
  if (actualCodec !== expectedLayerCodec(mediaType)) {
    fatal('docker image save layer media type did not match the blob codec')
  }
  let stream = createReadStream(null, {
    fd: archiveFd,
    autoClose: false,
    start: member.offset,
    end: member.offset + member.size - 1
  })
  const fd = openSync(outputPath, 'wx', 0o600)
  const custodyFds = []
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
    const writtenIdentity = fstatSync(fd, { bigint: true })
    if (
      !writtenIdentity.isFile() ||
      writtenIdentity.nlink !== 1n ||
      (writtenIdentity.mode & 0o7777n) !== 0o600n
    ) {
      fatal('docker image save inner layer spool identity was invalid')
    }
    for (let index = 0; index < 2; index += 1) {
      const readFd = openSync(outputPath, 'r')
      const observed = fstatSync(readFd, { bigint: true })
      if (
        !observed.isFile() ||
        observed.dev !== writtenIdentity.dev ||
        observed.ino !== writtenIdentity.ino ||
        observed.nlink !== 1n ||
        observed.size !== writtenIdentity.size ||
        observed.uid !== writtenIdentity.uid ||
        observed.gid !== writtenIdentity.gid ||
        (observed.mode & 0o7777n) !== 0o600n
      ) {
        closeSync(readFd)
        fatal('docker image save inner layer spool ownership drifted')
      }
      custodyFds.push(readFd)
    }
    validateLayerTarFraming(custodyFds[0], fatal)
    const entries = parseLayerTarEvidence(custodyFds[0], fatal)
    return Object.freeze({
      diffId: hash.digest('hex'),
      listingFd: custodyFds[0],
      extractionFd: custodyFds[1],
      entries
    })
  } catch (error) {
    for (const custodyFd of custodyFds) {
      try { closeSync(custodyFd) } catch {}
    }
    if (error instanceof Error && error.message.startsWith('docker image ')) {
      throw error
    }
    fatal('docker image save returned an unreadable compressed layer')
  } finally {
    closeSync(fd)
  }
}

export const verifySavedImageLayers = async (
  archiveSource,
  layerPaths,
  layerDescriptors,
  expectedDiffIds,
  fatal,
  { materializeRoot = null, runStrict = null } = {}
) => {
  if (
    layerPaths.length !== expectedDiffIds.length ||
    layerDescriptors.length !== layerPaths.length
  ) {
    fatal('docker image save layer count does not match immutable image evidence')
  }
  const ownsArchiveFd = !Number.isSafeInteger(archiveSource)
  let archiveFd = null
  let layerWork = null
  const identityByPath = new Map()
  try {
    archiveFd = ownsArchiveFd ? openSync(archiveSource, 'r') : archiveSource
    const members = indexSavedImageTar(archiveFd, fatal)
    layerWork = ownsArchiveFd
      ? `${archiveSource}.layers`
      : mkdtempSync(join(tmpdir(), 'meal-agent-layer-replay-'))
    if (ownsArchiveFd) mkdirSync(layerWork, { recursive: false, mode: 0o700 })
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
      if ((await hashArchiveMember(archiveFd, member)) !== blobDigest) {
        fatal('docker image save returned a layer blob with the wrong digest')
      }
      const diffDigest = expectedDiffIds[index].slice('sha256:'.length)
      const layerCustody = await hashAndValidateLayer(
        archiveFd,
        member,
        descriptor.mediaType,
        join(layerWork, `${String(index)}.tar`),
        fatal
      )
      if (layerCustody.diffId !== diffDigest) {
        closeSync(layerCustody.listingFd)
        closeSync(layerCustody.extractionFd)
        fatal('docker image save returned a layer blob with the wrong diff ID')
      }
      applyLayerIdentityEvidence(identityByPath, layerCustody.entries, fatal)
      try {
        if (materializeRoot !== null) {
          if (runStrict === null) fatal('docker image rootfs materializer was unavailable')
          await applyVerifiedLayer(
            layerCustody,
            join(layerWork, `${String(index)}.root`),
            materializeRoot,
            runStrict,
            fatal
          )
        }
      } finally {
        closeSync(layerCustody.listingFd)
        closeSync(layerCustody.extractionFd)
      }
    }
    if (materializeRoot !== null) {
      const runtimePayload = [...identityByPath.values()].filter(
        (entry) => entry.name === 'app' || entry.name.startsWith('app/')
      )
      if (runtimePayload.length === 0) {
        fatal('docker image runtime payload identity evidence was empty')
      }
      if (runtimePayload.some((entry) => entry.uid !== 0 || entry.gid !== 0)) {
        fatal('docker image runtime payload was not root-owned')
      }
      if (
        runtimePayload.some(
          (entry) => entry.type !== 0x32 && (entry.mode & 0o022) !== 0
        )
      ) {
        fatal('docker image runtime payload was group-or-world writable')
      }
      for (const required of ['app/dist/index.js', 'app/dist/database/migrate.js']) {
        const entry = identityByPath.get(required)
        if (entry === undefined || ![0, 0x30].includes(entry.type)) {
          fatal('docker image runtime entrypoint was not a verified regular file')
        }
        const materialized = lstatSync(join(materializeRoot, required))
        if (
          !materialized.isFile() ||
          materialized.isSymbolicLink() ||
          (materialized.mode & 0o7777) !== entry.mode
        ) {
          fatal('docker image runtime entrypoint replay did not match its identity ledger')
        }
      }
    }
  } finally {
    if (layerWork !== null) rmSync(layerWork, { recursive: true, force: true })
    if (ownsArchiveFd && archiveFd !== null) closeSync(archiveFd)
  }
}

const materializedSymlinkTarget = (relativeName, target) => {
  if (typeof target !== 'string' || target === '') return null
  if (
    relativeName === 'app/node_modules/.pnpm/node_modules/@meal-agent/api' &&
    target === '../../../../../../workspace/services/api'
  ) {
    // pnpm deploy's documented self-link points back to the build workspace and is
    // deliberately dangling in the runtime image.  The inventory treats this exact
    // link as data and never follows it; no other root-escaping link is admissible.
    return target
  }
  if (posix.isAbsolute(target)) {
    const rootRelative = posix.normalize(target).replace(/^\/+/, '')
    if (rootRelative === '' || rootRelative === '..' || rootRelative.startsWith('../')) return null
    return posix.relative(posix.dirname(relativeName), rootRelative)
  }
  const stack = posix.dirname(relativeName).split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) return null
      stack.pop()
    } else {
      stack.push(segment)
    }
  }
  return target
}

const mergeVerifiedLayerTree = (source, target, root, fatal) => {
  const entries = readdirSync(source, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
  if (entries.some((entry) => entry.name === '.wh..wh..opq')) {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true, mode: 0o700 })
  }
  for (const entry of entries) {
    if (entry.name === '.wh..wh..opq') continue
    if (entry.name.startsWith('.wh.')) {
      const marker = lstatSync(join(source, entry.name))
      if (
        entry.name === '.wh.' ||
        !marker.isFile() ||
        marker.size !== 0
      ) {
        fatal('docker image layer contained an invalid whiteout marker')
      }
      rmSync(join(target, entry.name.slice('.wh.'.length)), {
        recursive: true,
        force: true
      })
    }
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.wh.')) continue
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    const relativeName = relative(root, targetPath).split(sep).join('/')
    const stat = lstatSync(sourcePath)
    if (stat.isDirectory()) {
      if (existsSync(targetPath) && !lstatSync(targetPath).isDirectory()) {
        rmSync(targetPath, { recursive: true, force: true })
      }
      mkdirSync(targetPath, { recursive: true, mode: 0o700 })
      mergeVerifiedLayerTree(sourcePath, targetPath, root, fatal)
    } else if (stat.isSymbolicLink()) {
      const linkTarget = materializedSymlinkTarget(relativeName, readlinkSync(sourcePath))
      if (linkTarget === null) {
        fatal('docker image layer contained a symlink outside the materialized rootfs')
      }
      rmSync(targetPath, { recursive: true, force: true })
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
      symlinkSync(linkTarget, targetPath)
    } else if (stat.isFile()) {
      rmSync(targetPath, { recursive: true, force: true })
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
      copyFileSync(sourcePath, targetPath)
    } else {
      fatal('docker image layer contained an unsupported filesystem entry')
    }
  }
}

const applyVerifiedLayer = async (custody, layerRoot, root, runStrict, fatal) => {
  mkdirSync(layerRoot, { recursive: false, mode: 0o700 })
  const listing = (
    await runStrict(['tar', '-tf', '/dev/fd/3'], {
      timeoutMs: 300_000,
      label: 'verified layer listing',
      inheritedFds: [custody.listingFd]
    })
  ).stdout.split('\n').filter(Boolean)
  if (new Set(listing).size !== listing.length) {
    fatal('docker image layer contained duplicate archive members')
  }
  if (
    listing.some((name) =>
      name.includes('\u0000') ||
      posix.isAbsolute(name) ||
      name.split('/').includes('..')
    )
  ) {
    fatal('docker image layer contained an unsafe archive path')
  }
  await runStrict(['tar', '-xf', '/dev/fd/3', '-C', layerRoot], {
    timeoutMs: 300_000,
    label: 'verified layer extraction',
    inheritedFds: [custody.extractionFd]
  })
  mergeVerifiedLayerTree(layerRoot, root, root, fatal)
}

const filesystemListing = (root) => {
  const listing = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(directory, entry.name)
      const name = relative(root, path).split(sep).join('/')
      listing.push(entry.isDirectory() ? `${name}/` : name)
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(root)
  return listing
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
const createOwnedOutputFile = (path, track, fatal) => {
  let fd
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch {
    fatal('runtime image evidence output could not be created exclusively')
  }
  track.path?.(path)
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    fatal('runtime image evidence output did not have a private file identity')
  }
  return Object.freeze({ fd, dev: stat.dev, ino: stat.ino })
}

const requireOwnedOutputFile = (path, identity, fatal) => {
  let stat
  try {
    stat = lstatSync(path, { bigint: true })
  } catch {
    fatal('runtime image evidence output disappeared')
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.dev !== identity.dev ||
    stat.ino !== identity.ino ||
    stat.size <= 0n
  ) {
    fatal('runtime image evidence output identity drifted')
  }
}

const runtimeProbeScript = [
  'if [ ! -d /app ] || [ ! -f /app/dist/index.js ] || [ -L /app/dist/index.js ] || [ ! -f /app/dist/database/migrate.js ] || [ -L /app/dist/database/migrate.js ]; then',
  "  printf 'M5_RUNTIME_ENTRY_FAIL\\n'",
  '  exit 0',
  'fi',
  'if ! bad="$(find /app -xdev \\( \\( -type f -o -type d \\) -a \\( ! -user 0 -o ! -group 0 -o -perm /022 \\) \\) -print -quit)"; then',
  "  printf 'M5_RUNTIME_PROBE_FAIL\\n'",
  '  exit 0',
  'fi',
  'if [ -n "$bad" ]; then',
  "  printf 'M5_RUNTIME_OWNER_MODE_FAIL\\n'",
  '  exit 0',
  'fi',
  "printf 'M5_RUNTIME_PROBE_OK\\n'"
].join('\n')

const runtimeAccessProbeScript = [
  'for directory in /app /app/dist /app/dist/database; do',
  '  if [ ! -d "$directory" ] || [ ! -x "$directory" ]; then',
  "    printf 'M5_RUNTIME_ACCESS_FAIL\\n'",
  '    exit 0',
  '  fi',
  'done',
  'for entry in /app/dist/index.js /app/dist/database/migrate.js; do',
  '  if [ ! -f "$entry" ] || [ -L "$entry" ] || [ ! -r "$entry" ]; then',
  "    printf 'M5_RUNTIME_ACCESS_FAIL\\n'",
  '    exit 0',
  '  fi',
  'done',
  "printf 'M5_RUNTIME_ACCESS_OK\\n'"
].join('\n')

export const scanImage = async ({
  imageTag = null,
  expectedImageId,
  expectedBuildEvidence,
  expected,
  temporaryRoot,
  runStrict,
  fatal,
  problem,
  log,
  track = {
    image: () => undefined
  }
}) => {
  const savedImageTarPath = join(temporaryRoot, 'saved-image.tar')
  const exportedRootfsTarPath = join(temporaryRoot, 'exported-rootfs.tar')
  const extractedRoot = join(temporaryRoot, 'image-root')

  const imageId =
    imageTag === null
      ? expectedImageId
      : parseDockerImageId(
          (
            await runStrict(['docker', 'image', 'inspect', '--format', '{{.Id}}', imageTag], {
              timeoutMs: 60_000,
              label: 'docker image inspect (id)'
            })
          ).stdout,
          fatal
        )
  if (imageId !== expectedImageId) {
    fatal('runtime image locator no longer identifies the immutable build result')
  }
  track.image(imageId)
  log(`image id ${imageId}`)

  // 生产入口从 BuildKit iidfile 直接交付 immutable ID；可选 tag 仅保留给
  // 纯函数反例证明“locator 只能解析一次”，不参与生产证据链。
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
  const savedImageIdentity = createOwnedOutputFile(savedImageTarPath, track, fatal)
  try {
    await runStrict(['docker', 'image', 'save', imageId], {
      timeoutMs: 300_000,
      label: 'docker image save (content-addressed history evidence)',
      stdoutFd: savedImageIdentity.fd
    })
  } finally {
    closeSync(savedImageIdentity.fd)
  }
  requireOwnedOutputFile(savedImageTarPath, savedImageIdentity, fatal)
  const savedImageFd = openSync(savedImageTarPath, 'r')
  try {
    const savedImageStat = fstatSync(savedImageFd, { bigint: true })
    if (!savedImageStat.isFile() || savedImageStat.nlink !== 1n) {
      fatal('docker image save archive custody was not a private regular file')
    }
    const archiveEvidence = validateSavedImageArchive(
      savedImageFd,
      imageInspect,
      expectedBuildEvidence,
      historyRows,
      fatal,
      problem
    )
    // archiveEvidence 只负责把 Config/history/provenance 与 immutable ID 绑定。
    // 最终 rootfs 不再由这里自行 replay OCI layers。
    void archiveEvidence
  } finally {
    closeSync(savedImageFd)
  }

  const scratchName = `meal-agent-m5-scan-${randomBytes(8).toString('hex')}`
  const scratchRecord = {
    name: scratchName,
    id: null,
    expectedImageId: imageId,
    expectedUser: '0:0',
    expectedNetworkMode: 'none',
    expectedReadonlyRootfs: true
  }
  track.container?.(scratchRecord)
  const containerId = parseDockerContainerId(
    (
      await runStrict(
        [
          'docker', 'container', 'create',
          '--name', scratchName,
          '--label', `meal-agent.m5.owner=${scratchName}`,
          '--network', 'none',
          '--read-only',
          '--user', '0:0',
          imageId,
          '/bin/sh', '-c', runtimeProbeScript
        ],
        { timeoutMs: 60_000, label: 'docker container create (immutable runtime probe)' }
      )
    ).stdout,
    fatal
  )
  scratchRecord.id = containerId
  track.container?.(scratchRecord)
  parseOwnedScratchContainer(
    (
      await runStrict(['docker', 'container', 'inspect', containerId], {
        timeoutMs: 60_000,
        label: 'docker container inspect (immutable runtime binding)'
      })
    ).stdout,
    scratchCapabilityExpectation({
      name: scratchName,
      imageId,
      containerId,
      user: '0:0'
    }),
    fatal
  )
  const probe = await runStrict(['docker', 'container', 'start', '--attach', containerId], {
    timeoutMs: 60_000,
    label: 'docker container start (runtime owner and entry probe)'
  })
  if (probe.stdout === 'M5_RUNTIME_ENTRY_FAIL\n') {
    fatal('docker image runtime entrypoint was not a verified regular file')
  }
  if (probe.stdout === 'M5_RUNTIME_OWNER_MODE_FAIL\n') {
    fatal('docker image runtime payload was not root-owned or was writable')
  }
  if (probe.stdout !== 'M5_RUNTIME_PROBE_OK\n') {
    fatal('runtime owner and entry probe returned invalid success evidence')
  }

  const rootfsIdentity = createOwnedOutputFile(exportedRootfsTarPath, track, fatal)
  try {
    await runStrict(['docker', 'container', 'export', containerId], {
      timeoutMs: 300_000,
      label: 'docker container export (daemon materialized rootfs)',
      stdoutFd: rootfsIdentity.fd
    })
  } finally {
    closeSync(rootfsIdentity.fd)
  }
  requireOwnedOutputFile(exportedRootfsTarPath, rootfsIdentity, fatal)
  mkdirSync(extractedRoot, { recursive: false, mode: 0o700 })
  track.path?.(extractedRoot)
  try {
    await runStrict(['tar', '-xf', exportedRootfsTarPath, '-C', extractedRoot], {
      timeoutMs: 300_000,
      label: 'tar extract (daemon materialized rootfs)'
    })
  } finally {
    // runCommand 只有在该进程组到达 ESRCH 后才 settle。无论成功、signal 还是
    // timeout，此处都在 destructive cleanup 前把 trusted tar 已物化的完整/部分树
    // 收进同一 ownership journal；cleanup 不再有递归删除旁路。
    if (existsSync(extractedRoot)) track.path?.(extractedRoot)
  }

  parseOwnedScratchContainer(
    (
      await runStrict(['docker', 'container', 'inspect', containerId], {
        timeoutMs: 60_000,
        label: 'docker container inspect (pre-cleanup binding)'
      })
    ).stdout,
    scratchCapabilityExpectation({
      name: scratchName,
      imageId,
      containerId,
      user: '0:0'
    }),
    fatal
  )
  await settleTrackedRuntimeProbe({
    run: runCommand,
    record: scratchRecord,
    fatal,
    retire: () => track.container?.(null)
  })

  // Root ownership and runtime readability are deliberately separate
  // capabilities. A root probe cannot prove that the configured runtime UID
  // can traverse /app or read the two fixed JavaScript entrypoints.
  const runtimeAccessName = `meal-agent-m5-access-${randomBytes(8).toString('hex')}`
  const runtimeAccessRecord = {
    name: runtimeAccessName,
    id: null,
    expectedImageId: imageId,
    expectedUser: '10001:10001',
    expectedNetworkMode: 'none',
    expectedReadonlyRootfs: true
  }
  track.container?.(runtimeAccessRecord)
  const runtimeAccessContainerId = parseDockerContainerId(
    (
      await runStrict(
        [
          'docker', 'container', 'create',
          '--name', runtimeAccessName,
          '--label', `meal-agent.m5.owner=${runtimeAccessName}`,
          '--network', 'none',
          '--read-only',
          '--user', '10001:10001',
          imageId,
          '/bin/sh', '-c', runtimeAccessProbeScript
        ],
        { timeoutMs: 60_000, label: 'docker container create (runtime uid access probe)' }
      )
    ).stdout,
    fatal
  )
  runtimeAccessRecord.id = runtimeAccessContainerId
  track.container?.(runtimeAccessRecord)
  parseOwnedScratchContainer(
    (
      await runStrict(['docker', 'container', 'inspect', runtimeAccessContainerId], {
        timeoutMs: 60_000,
        label: 'docker container inspect (runtime uid access binding)'
      })
    ).stdout,
    scratchCapabilityExpectation({
      name: runtimeAccessName,
      imageId,
      containerId: runtimeAccessContainerId,
      user: '10001:10001'
    }),
    fatal
  )
  const runtimeAccessProbe = await runStrict(
    ['docker', 'container', 'start', '--attach', runtimeAccessContainerId],
    { timeoutMs: 60_000, label: 'docker container start (runtime uid access probe)' }
  )
  if (runtimeAccessProbe.stdout === 'M5_RUNTIME_ACCESS_FAIL\n') {
    fatal('docker image runtime uid could not traverse or read the fixed entrypoints')
  }
  if (runtimeAccessProbe.stdout !== 'M5_RUNTIME_ACCESS_OK\n') {
    fatal('runtime uid access probe returned invalid success evidence')
  }
  parseOwnedScratchContainer(
    (
      await runStrict(['docker', 'container', 'inspect', runtimeAccessContainerId], {
        timeoutMs: 60_000,
        label: 'docker container inspect (runtime uid pre-cleanup binding)'
      })
    ).stdout,
    scratchCapabilityExpectation({
      name: runtimeAccessName,
      imageId,
      containerId: runtimeAccessContainerId,
      user: '10001:10001'
    }),
    fatal
  )
  await settleTrackedRuntimeProbe({
    run: runCommand,
    record: runtimeAccessRecord,
    fatal,
    retire: () => track.container?.(null)
  })

  // Docker daemon 对 immutable ID 的最终 materialization 是唯一 rootfs 事实源。
  const listing = filesystemListing(extractedRoot)

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

/**
 * Production scan callsites settle scratch containers from final immutable-ID
 * and mutable-name observations. The tracking record is retired only after the
 * shared protocol proves both locators absent; command status never substitutes
 * for the final daemon facts.
 */
export const settleTrackedRuntimeProbe = async ({ run, record, fatal, retire }) => {
  let problems
  try {
    problems = await settleOwnedScratchContainer(run, record, {
      parseOwnedScratchContainer
    })
  } catch {
    fatal('owned runtime probe cleanup did not complete')
  }
  if (!Array.isArray(problems) || problems.length > 0) {
    fatal(Array.isArray(problems) && problems.length > 0
      ? problems[0]
      : 'owned runtime probe cleanup returned invalid evidence')
  }
  retire()
}
