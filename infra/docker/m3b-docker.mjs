// 阶段 09A / M3B：Docker 证据的 fail-closed 读取与分阶段 scoped cleanup。
//
// 阻断整改第一、三条的落点：
//
//   - **所有** docker down/list/inspect/remove/re-list/dangling 查询都检查退出
//     码，读不到就报错，绝不用 null/`{}`/`[]` 默认值冒充「没有」；
//   - cleanup 是一个**分阶段收集器**：临时 Secret 目录、compose down、容器、
//     网络、卷、本轮 immutable image 各自成阶段，一个阶段失败不阻断其余，全部
//     问题聚合成 residue 返回（signal handler 也必须打印它，不得丢弃）；
//   - cleanup 之后**独立复查** container / network / named volume / 匿名悬挂卷 /
//     immutable image / Secret 目录六类，复查本身同样 fail closed。
//
// 每次 smoke/probe 在 BuildKit 前登记不可猜 per-run tag，专供中断窗口恢复；
// BuildKit 交付 immutable image ID 后，临时 Compose override 只引用该 ID。
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runCommand } from './m3b-subprocess.mjs'
import { secretFiles } from './local-test-secrets-contract.mjs'

/** 旧命名保留的每轮 locator 前缀；该字符串从不作为 Docker build tag 发布。 */
export const runImageTagPrefix = 'meal-agent-api:m3b-'

export const runImageTagFor = (runId) => `${runImageTagPrefix}${runId}`

const secretBundleFilenames = Object.freeze(secretFiles.map((entry) => entry.filename))

const ownedOverrideInodes = new Map()
const ownedBuildEvidenceDirectories = new Map()
export const buildClaimLabel = 'meal-agent.m3b.build-claim'
export const runClaimLabel = 'meal-agent.m3b.run-claim'
const ownedBuildImageClaims = new Map()
const composeServiceNames = Object.freeze([
  'secret-materializer',
  'postgres',
  'bootstrap-cluster',
  'bootstrap-logins',
  'bootstrap-createdb',
  'bootstrap-schema',
  'bootstrap-handoff',
  'bootstrap-acl',
  'bootstrap-grants',
  'backup',
  'backup-transfer-loader',
  'restore',
  'migrate',
  'api'
])
const composeNetworkNames = Object.freeze(['internal', 'edge'])
const composeVolumeNames = Object.freeze([
  'postgres-data',
  'postgres-superuser-secret',
  'postgres-admin-pgpass-secret',
  'migration-password-secret',
  'runtime-password-secret',
  'backup-password-secret',
  'admin-url-secret',
  'migration-url-secret',
  'runtime-url-secret',
  'backup-transfer'
])

const removeOwnedBuildEvidenceDirectory = (directory) => {
  const record = ownedBuildEvidenceDirectories.get(directory)
  if (record === undefined) return
  const expected = record.identity
  if (!existsSync(directory)) {
    ownedBuildEvidenceDirectories.delete(directory)
    return
  }
  const observed = lstatSync(directory, { bigint: true })
  if (observed.dev !== expected.dev || observed.ino !== expected.ino) {
    throw new DockerEvidenceError('build evidence directory ownership drifted')
  }
  const expectedPaths = new Map([
    [record.metadataFile, record.fileIdentities.get(record.metadataFile)],
    [record.iidfile, record.fileIdentities.get(record.iidfile)]
  ])
  const actualNames = readdirSync(directory)
  if (actualNames.some((name) => !expectedPaths.has(resolve(directory, name)))) {
    throw new DockerEvidenceError('build evidence directory contained an unowned entry')
  }
  // Validate the complete set before deleting the first member. Cleanup is
  // all-or-nothing with respect to ownership drift.
  for (const [path, expectedFile] of expectedPaths) {
    if (!existsSync(path)) continue
    if (expectedFile === undefined) {
      throw new DockerEvidenceError('build evidence directory contained an unowned entry')
    }
    const file = lstatSync(path, { bigint: true })
    if (
      !file.isFile() ||
      file.nlink !== 1n ||
      file.dev !== expectedFile.dev ||
      file.ino !== expectedFile.ino
    ) {
      throw new DockerEvidenceError('build evidence file ownership drifted')
    }
  }
  for (const path of expectedPaths.keys()) {
    if (!existsSync(path)) continue
    unlinkSync(path)
  }
  rmdirSync(directory)
  ownedBuildEvidenceDirectories.delete(directory)
}

const buildEvidenceDirectoryIsEmpty = (record) =>
  readdirSync(resolve(record.metadataFile, '..')).length === 0

const buildEvidenceFilesAreOwnedAndEmpty = (record) => {
  const directory = resolve(record.metadataFile, '..')
  const expectedPaths = new Set([record.metadataFile, record.iidfile])
  const actual = readdirSync(directory).map((name) => resolve(directory, name))
  if (actual.some((path) => !expectedPaths.has(path))) return false
  return actual.every((path) => {
    const expected = record.fileIdentities.get(path)
    if (expected === undefined || expected.size !== 0n) return false
    const observed = lstatSync(path, { bigint: true })
    return (
      observed.isFile() &&
      observed.nlink === 1n &&
      observed.dev === expected.dev &&
      observed.ino === expected.ino &&
      observed.size === 0n
    )
  })
}

export const captureBuildEvidenceFiles = (record, { requireComplete = true } = {}) => {
  const expectedNames = new Set([
    record.metadataFile.split('/').at(-1),
    record.iidfile.split('/').at(-1)
  ])
  const directory = resolve(record.metadataFile, '..')
  const names = readdirSync(directory)
  if (names.some((name) => !expectedNames.has(name))) {
    throw new DockerEvidenceError('docker build evidence directory was not closed')
  }
  if (requireComplete && names.length !== expectedNames.size) {
    throw new DockerEvidenceError('docker build evidence directory was not complete')
  }
  const captured = new Map()
  for (const path of [record.metadataFile, record.iidfile]) {
    if (!existsSync(path)) continue
    let descriptor = null
    try {
      descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      const before = fstatSync(descriptor, { bigint: true })
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > 1048576n ||
        (requireComplete && before.size <= 0n)
      ) {
        throw new DockerEvidenceError('docker build evidence file was not a bounded regular file')
      }
      const bytes = readFileSync(descriptor)
      const after = fstatSync(descriptor, { bigint: true })
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.nlink !== 1n ||
        after.size !== before.size ||
        BigInt(bytes.length) !== before.size
      ) {
        throw new DockerEvidenceError('docker build evidence file changed while being read')
      }
      captured.set(path, {
        text: bytes.toString('utf8'),
        identity: Object.freeze({ dev: after.dev, ino: after.ino, size: after.size })
      })
    } catch (error) {
      if (error instanceof DockerEvidenceError) throw error
      throw new DockerEvidenceError('docker build evidence file could not be read')
    } finally {
      if (descriptor !== null) closeSync(descriptor)
    }
  }
  for (const [path, value] of captured) {
    const previous = record.fileIdentities.get(path)
    if (
      previous !== undefined &&
      (previous.dev !== value.identity.dev || previous.ino !== value.identity.ino)
    ) {
      throw new DockerEvidenceError('docker build evidence file ownership drifted')
    }
  }
  for (const [path, value] of captured) record.fileIdentities.set(path, value.identity)
  return Object.freeze({
    metadataText: captured.get(record.metadataFile)?.text ?? null,
    iidText: captured.get(record.iidfile)?.text ?? null
  })
}

/** 临时 Compose override：三个 API 服务只引用 BuildKit 交付的 immutable ID。 */
export const writeImageOverride = (path, imageIdentity, runClaimToken) => {
  parseCanonicalDockerImageId(imageIdentity)
  if (typeof runClaimToken !== 'string' || !/^[0-9a-f]{32}$/.test(runClaimToken)) {
    throw new DockerEvidenceError('run ownership claim was not canonical')
  }
  const serviceLines = composeServiceNames.map((name) => {
    const imageLine = ['api', 'migrate', 'bootstrap-schema'].includes(name)
      ? `    image: ${imageIdentity}\n`
      : ''
    return `  ${name}:\n${imageLine}    labels:\n      ${runClaimLabel}: ${runClaimToken}\n`
  }).join('')
  const networkLines = composeNetworkNames
    .map((name) => `  ${name}:\n    labels:\n      ${runClaimLabel}: ${runClaimToken}\n`)
    .join('')
  const volumeLines = composeVolumeNames
    .map((name) => `  ${name}:\n    labels:\n      ${runClaimLabel}: ${runClaimToken}\n`)
    .join('')
  writeFileSync(
    path,
    '# 阶段 09A / M3B：**临时** override，三个 API 镜像服务只引用\n' +
      '# BuildKit 本轮交付的 immutable image ID。默认拓扑（M2B 已 Accepted）\n' +
      '# 保持不变，且不存在 tag absence 与 publish 之间的竞态。用后即删。\n' +
      `# 所有可变 Docker 资源同时持有本轮不可猜 claim；project label 只是 locator。\n` +
      `services:\n${serviceLines}` +
      `networks:\n${networkLines}` +
      `volumes:\n${volumeLines}`,
    { flag: 'wx', mode: 0o600 }
  )
  const identity = inodeIdentityOf(path)
  ownedOverrideInodes.set(path, identity)
  return identity
}

/**
 * 取一个**刚由本轮创建**的路径的 inode 身份（`mkdtemp` 之后立即调用）。
 * BigInt 形态：默认的 double 在大 inode 号上会丢精度，而丢精度的比较等于把
 * 「不是我的目录」判成「是我的」。
 */
export const inodeIdentityOf = (path) => {
  const stats = lstatSync(path, { bigint: true })
  return { dev: stats.dev, ino: stats.ino }
}

export const snapshotSecretBundleIdentity = (directory, directoryIdentity) => {
  const observedDirectory = lstatSync(directory, { bigint: true })
  if (
    !observedDirectory.isDirectory() ||
    observedDirectory.dev !== directoryIdentity.dev ||
    observedDirectory.ino !== directoryIdentity.ino
  ) {
    throw new DockerEvidenceError('temporary secrets directory ownership drifted')
  }
  const files = Object.create(null)
  for (const filename of secretBundleFilenames) {
    const path = resolve(directory, filename)
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new DockerEvidenceError('temporary secret file identity was invalid')
    }
    files[filename] = Object.freeze({ dev: stat.dev, ino: stat.ino })
  }
  return Object.freeze({
    dev: directoryIdentity.dev,
    ino: directoryIdentity.ino,
    files: Object.freeze(files)
  })
}

export const retireSecretBundleDirectory = (directory, secretsIdentity) => {
  const observedDirectory = lstatSync(directory, { bigint: true })
  if (
    !observedDirectory.isDirectory() ||
    observedDirectory.dev !== secretsIdentity.dev ||
    observedDirectory.ino !== secretsIdentity.ino
  ) {
    throw new DockerEvidenceError('temporary secrets directory ownership drifted')
  }
  const actualNames = readdirSync(directory)
  if (actualNames.some((filename) => !secretBundleFilenames.includes(filename))) {
    throw new DockerEvidenceError('temporary secrets directory contained an unowned entry')
  }
  // Acquire deletion authority for every present member before deleting any of
  // them. A reserved name without a captured inode is still foreign.
  for (const filename of actualNames) {
    const path = resolve(directory, filename)
    const observed = lstatSync(path, { bigint: true })
    const expectedFile = secretsIdentity?.files?.[filename]
    if (
      expectedFile === undefined ||
      !observed.isFile() ||
      observed.nlink !== 1n ||
      observed.dev !== expectedFile.dev ||
      observed.ino !== expectedFile.ino
    ) {
      throw new DockerEvidenceError('temporary secret file ownership drifted')
    }
  }
  for (const filename of actualNames) {
    const path = resolve(directory, filename)
    unlinkSync(path)
  }
  rmdirSync(directory)
}

export class DockerEvidenceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DockerEvidenceError'
  }
}

const canonicalDockerLine = (raw, pattern, reason) => {
  if (typeof raw !== 'string') {
    throw new DockerEvidenceError(reason)
  }
  const match = pattern.exec(raw)
  if (match === null) {
    throw new DockerEvidenceError(reason)
  }
  return match[1]
}

/**
 * Docker CLI 的 immutable identity 统一文法。只允许 canonical 值本身，或 CLI
 * 常见的**一个**末尾 LF；禁止 trim/CRLF/首尾空白/多行包装。所有 sibling
 * checker、cleanup 与 iidfile 读取必须复用这里，不能各自维护宽松版本。
 */
export const parseCanonicalDockerImageId = (raw) =>
  canonicalDockerLine(
    raw,
    /^(sha256:[0-9a-f]{64})\n?$/,
    'docker image inspect returned an invalid image ID'
  )

export const parseCanonicalDockerContainerId = (raw) =>
  canonicalDockerLine(
    raw,
    /^([0-9a-f]{64})\n?$/,
    'docker container evidence returned an invalid container ID'
  )

/**
 * BuildKit 的 `--metadata-file` 同时给出 manifest digest 与 config digest。Docker
 * Desktop 的 `--iidfile` 是 config digest，而 `docker image inspect .Id` 是 manifest
 * digest；开启 provenance 时 iidfile 则是 manifest-list digest。这里要求 metadata
 * 的两处 manifest identity 自洽，并把可选的 config identity 留给调用方与 iidfile
 * 交叉核对。
 */
export const parseBuildMetadataImageIdentity = (raw) => {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new DockerEvidenceError('docker build metadata was not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DockerEvidenceError('docker build metadata had an invalid shape')
  }
  const allowedRootKeys = new Set([
    'buildx.build.provenance',
    'buildx.build.ref',
    'buildx.build.warnings',
    'containerimage.config.digest',
    'containerimage.descriptor',
    'containerimage.digest',
    'image.name'
  ])
  if (Object.keys(value).some((key) => !allowedRootKeys.has(key))) {
    throw new DockerEvidenceError('docker build metadata exposed an unsupported capability')
  }
  if (
    (value['buildx.build.ref'] !== undefined &&
      (typeof value['buildx.build.ref'] !== 'string' || value['buildx.build.ref'] === '')) ||
    (value['buildx.build.warnings'] !== undefined &&
      !Array.isArray(value['buildx.build.warnings'])) ||
    (value['image.name'] !== undefined &&
      (typeof value['image.name'] !== 'string' ||
        value['image.name'] === '' ||
        /[\r\n]/.test(value['image.name']))) ||
    (value['buildx.build.provenance'] !== undefined &&
      (value['buildx.build.provenance'] === null ||
        typeof value['buildx.build.provenance'] !== 'object' ||
        Array.isArray(value['buildx.build.provenance'])))
  ) {
    throw new DockerEvidenceError('docker build metadata had an invalid optional capability')
  }
  const descriptor = value['containerimage.descriptor']
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new DockerEvidenceError('docker build metadata had an invalid descriptor')
  }
  const imageId = parseCanonicalDockerImageId(value['containerimage.digest'])
  if (parseCanonicalDockerImageId(descriptor.digest) !== imageId) {
    throw new DockerEvidenceError('docker build metadata identities did not agree')
  }
  const allowedDescriptorKeys = new Set(['mediaType', 'digest', 'size', 'platform'])
  const platform = descriptor.platform
  const platformIsValid =
    platform === undefined ||
    (platform !== null &&
      typeof platform === 'object' &&
      !Array.isArray(platform) &&
      Object.keys(platform).length === 2 &&
      typeof platform.architecture === 'string' &&
      /^[a-z0-9_+-]+$/.test(platform.architecture) &&
      platform.os === 'linux')
  if (
    Object.keys(descriptor).some((key) => !allowedDescriptorKeys.has(key)) ||
    !platformIsValid ||
    ![
      'application/vnd.docker.distribution.manifest.v2+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.oci.image.index.v1+json'
    ].includes(descriptor.mediaType) ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size <= 0
  ) {
    throw new DockerEvidenceError('docker build metadata descriptor was incomplete')
  }
  const configId = value['containerimage.config.digest'] === undefined
    ? null
    : parseCanonicalDockerImageId(value['containerimage.config.digest'])
  if (
    configId === null &&
    ![
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.index.v1+json'
    ].includes(descriptor.mediaType)
  ) {
    throw new DockerEvidenceError('docker build metadata omitted its config identity')
  }
  return Object.freeze({
    imageId,
    configId,
    descriptor: Object.freeze({
      mediaType: descriptor.mediaType,
      digest: imageId,
      size: descriptor.size,
      platform: platform === undefined
        ? null
        : Object.freeze({ architecture: platform.architecture, os: platform.os })
    })
  })
}

export const parseClaimedBuildImage = (
  value,
  { expectedImageId, expectedClaimToken, requireUntagged = false, expectedTag = null }
) => {
  const labels = value?.Config?.Labels
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    parseCanonicalDockerImageId(value.Id) !== expectedImageId ||
    !(value.RepoTags === null || Array.isArray(value.RepoTags)) ||
    (Array.isArray(value.RepoTags) &&
      value.RepoTags.some((tag) => typeof tag !== 'string' || tag === '')) ||
    labels === null ||
    typeof labels !== 'object' ||
    Array.isArray(labels) ||
    labels[buildClaimLabel] !== expectedClaimToken ||
    (requireUntagged && Array.isArray(value.RepoTags) && value.RepoTags.length !== 0) ||
    (expectedTag !== null &&
      JSON.stringify(value.RepoTags) !== JSON.stringify([expectedTag]))
  ) {
    throw new DockerEvidenceError('docker build ownership evidence did not match its claim')
  }
  return Object.freeze({
    imageId: expectedImageId,
    claimToken: expectedClaimToken,
    repoTags: value.RepoTags
  })
}

export const inspectClaimedBuildImage = async (
  { imageId, claimToken, imageTag },
  { env } = {}
) => parseClaimedBuildImage(
  await inspectJsonStrict(imageId, '{{json .}}', { env }),
  {
    expectedImageId: imageId,
    expectedClaimToken: claimToken,
    expectedTag: imageTag
  }
)

/** 执行一条 docker 命令并要求退出码为 0；否则抛 DockerEvidenceError。 */
export const dockerStrict = async (args, { timeoutMs = 120_000, env } = {}) => {
  const result = await runCommand(args, { timeoutMs, env })
  if (result.status !== 0) {
    throw new DockerEvidenceError(
      `docker command failed (${
        result.status === null ? `signal ${String(result.signal ?? 'unknown')}` : String(result.status)
      })`
    )
  }
  return result
}

/**
 * `docker inspect --format` 的严格读取：读不到即抛，不返回默认值。
 *
 * **退出 0 但 stdout 为空同样算读不到**。模板求值给出空串的原因可能是字段不
 * 存在、daemon 返回了非预期结构，或 PATH 上有个只会 `exit 0` 的 shim；无论
 * 哪一种，把它交给调用方都会变成一条伪造的阴性证据——`Number('')` 是 0，于是
 * 「读不到退出码」会被记成「这一步退出码为 0」。要显式接受空串的调用方必须
 * 传 `allowEmpty: true`，并自己给出具名判定。
 */
export const inspectStrict = async (target, format, { env, allowEmpty = false } = {}) => {
  const result = await dockerStrict(
    ['docker', 'inspect', '--format', format, target],
    { env }
  )
  const raw = result.stdout
  const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  if (/\r|\n/.test(value)) {
    throw new DockerEvidenceError(
      'docker inspect returned a noncanonical multiline field'
    )
  }
  if (value === '' && !allowEmpty) {
    throw new DockerEvidenceError(
      'docker inspect exited 0 but did not provide the required field evidence'
    )
  }
  return value
}

/**
 * 把 `{{.State.ExitCode}}` 的文本解析成退出码。**只接受规范的非负十进制整数**。
 *
 * `Number()` 会把 `''`、`'  '`、`'\n'` 变成 0，把 `'+3'`/`'1.0'`/`'1e3'`/`'0x10'`
 * 变成数字——这些形态里没有一个是 docker 真实打印的退出码，而其中第一类恰好
 * 会把「读不到」伪装成「成功」。因此先按文法判定，再确认它落在安全整数范围内
 * （超出 2^53 的字面量在 double 上会失真）。
 */
export const parseInspectedExitCode = (raw) => {
  const text = String(raw ?? '')
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    return { ok: false, reason: 'not a canonical non-negative decimal integer' }
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: 'outside the safe integer range' }
  }
  return { ok: true, value }
}

/**
 * docker CLI 「这个对象不存在」的**唯一**判据，三处调用点共用
 * （`imageIdOf`、反例套件的 container presence、信号窗口的 per-run tag 复查）。
 *
 * 判定对**整串** `stderr.trim()` 做锚定匹配，且**不带 `m` 标志**。但仅仅去掉
 * `m` 是不够的：`\s` 本身就跨行，于是
 *
 *   Error response from daemon:\nNo such image: <tag>
 *   No such image:\n<tag>
 *
 * 这类**内嵌换行**的两行 stderr 仍然会整串匹配成功，被读成「资源不存在」。
 * 因此这里做两件事：
 *
 *   1. `trim()` 之后**只要还含 CR 或 LF 就直接判 false**——docker 的
 *      「找不到对象」永远是**单行**；多行意味着还有别的信息，不能当成不存在；
 *   2. 正则内部**不使用任何可跨行的 `\s`**，只允许必要的**水平**空白
 *      `[ \t]*`。
 *
 * 调用方还必须自己确认退出码恰好是 1——只有那一个组合才是 docker 的
 * 「找不到对象」。本函数只返回布尔值，不构造任何含外部内容的消息。
 */
export const isAbsenceMessage = (stderr, { kind, name }) => {
  const raw = String(stderr ?? '')
  // Docker CLI 可以在唯一一行诊断后带一个 LF；除此之外任何前导/额外换行、
  // CR 或空白包装都不是 canonical absence evidence。不能先 trim()，否则证据
  // 包装会在判定前被抹掉。
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  if (/[\r\n]/.test(line)) {
    return false
  }
  const noun = kind === 'image' ? 'image' : kind === 'container' ? '(?:container|object)' : 'object'
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `^(?:[Ee]rror(?: response from daemon)?:[ \\t]*)?[Nn]o such ${noun}:?[ \\t]*${escaped}$`
  )
  return pattern.test(line)
}

/** 严格读取一段 JSON 形态的 inspect 字段（空 payload 由 inspectStrict 拒绝）。 */
export const inspectJsonStrict = async (target, format, { env } = {}) => {
  const raw = await inspectStrict(target, format, { env })
  try {
    return JSON.parse(raw)
  } catch {
    throw new DockerEvidenceError('docker inspect did not return valid JSON evidence')
  }
}

/** 按 project label 列出资源；退出码非 0 即抛。 */
export const listByProject = async (kind, project, { env, claimToken = null } = {}) => {
  if (!['container', 'network', 'volume'].includes(kind)) {
    throw new DockerEvidenceError('docker resource kind was not registered')
  }
  const base =
    kind === 'container'
      ? ['docker', 'ps', '--no-trunc', '-aq']
      : kind === 'network'
        ? ['docker', 'network', 'ls', '--no-trunc', '-q']
        : ['docker', 'volume', 'ls', '-q']
  const filters = ['--filter', `label=com.docker.compose.project=${project}`]
  if (claimToken !== null) {
    filters.push('--filter', `label=${runClaimLabel}=${claimToken}`)
  }
  const result = await dockerStrict(
    [...base, ...filters],
    { env }
  )
  if (
    typeof result.stdout !== 'string' ||
    result.stdout.length > 4 * 1024 * 1024 ||
    /[\u0000\r]/.test(result.stdout)
  ) {
    throw new DockerEvidenceError('docker resource listing had invalid framing')
  }
  const framed = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout
  if (framed === '') return []
  const identifiers = framed.split('\n')
  const pattern = kind === 'volume'
    ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/
    : /^[0-9a-f]{64}$/
  if (
    identifiers.some((identifier) => !pattern.test(identifier)) ||
    new Set(identifiers).size !== identifiers.length
  ) {
    throw new DockerEvidenceError('docker resource listing had invalid identities')
  }
  return identifiers
}

/** 当前悬挂（无主）匿名卷集合；退出码非 0 即抛。 */
export const danglingVolumes = async ({ env } = {}) => {
  const result = await dockerStrict(['docker', 'volume', 'ls', '-qf', 'dangling=true'], { env })
  if (
    typeof result.stdout !== 'string' ||
    result.stdout.length > 4 * 1024 * 1024 ||
    /[\u0000\r]/.test(result.stdout)
  ) {
    throw new DockerEvidenceError('docker dangling-volume listing had invalid framing')
  }
  const framed = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout
  if (framed === '') return new Set()
  const identifiers = framed.split('\n')
  if (
    identifiers.some((identifier) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(identifier)) ||
    new Set(identifiers).size !== identifiers.length
  ) {
    throw new DockerEvidenceError('docker dangling-volume listing had invalid identities')
  }
  return new Set(identifiers)
}

/**
 * 某个 image tag 是否存在（存在返回 image ID，不存在返回 null）。
 *
 * 这是**全仓唯一**允许把非零退出解释成「资源不存在」的地方，因此判据收得很紧：
 *
 *   - 退出码必须**恰好是 1**（docker CLI 的「找不到对象」）。`status === null`
 *     表示 CLI 自己被信号杀掉，绝不是「镜像不存在」；
 *   - stderr 必须整串匹配 `isAbsenceMessage`（锚定、**不带 `m` 标志**），而不是
 *     任意位置出现 "no such image" 字样——被包装的多行错误、带前缀或后缀的
 *     错误、PATH 上的 shim 回显、或一条关于**另一个**镜像的消息都不算数；
 *   - 其余一律抛出。
 */
export const imageIdOf = async (tag, { env } = {}) => {
  const result = await runCommand(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', tag],
    { env }
  )
  if (result.status === 0) {
    // Docker 的成功证据必须是**一行 canonical immutable ID**。`trim()` 会把空白、
    // CRLF 与多行包装都规范化掉，使调用方随后把任意 status-0 stdout 当成 image
    // identity 传给 inspect/create/cleanup。只容许 CLI 常见的一个末尾 LF；其余 framing
    // 与非 sha256 identity 一律固定理由 fail closed。
    return parseCanonicalDockerImageId(result.stdout)
  }
  if (result.status === 1 && isAbsenceMessage(result.stderr, { kind: 'image', name: tag })) {
    return null
  }
  throw new DockerEvidenceError(
    `docker image inspect evidence failed (${
      result.status === null ? `on signal ${String(result.signal)}` : String(result.status)
    })`
  )
}

/**
 * 构建三个 API 服务共用的本轮镜像。manifest identity 来自 BuildKit 自己写出的
 * `--metadata-file`，config identity 则与 `--iidfile` 交叉核对。不可猜的 per-run tag
 * 在启动 BuildKit 前就交给 cleanup，只作为中断窗口的恢复 locator；成功证据与删除
 * 所有权仍以 immutable ID + claim + exact singleton tag 三者共同确定。
 */
export const buildApiImage = async ({
  imageTag,
  repositoryRoot,
  runClaimToken,
  env = process.env
}) => {
  if (!imageTag.startsWith(runImageTagPrefix)) {
    throw new DockerEvidenceError('refusing to build outside the per-run locator namespace')
  }
  if (typeof runClaimToken !== 'string' || !/^[0-9a-f]{32}$/.test(runClaimToken)) {
    throw new DockerEvidenceError('build evidence owner claim was not canonical')
  }
  const directory = mkdtempSync(join(tmpdir(), 'meal-agent-m3b-build-'))
  const metadataFile = resolve(directory, 'built-image.metadata.json')
  const iidfile = resolve(directory, 'built-image.id')
  const claimToken = randomBytes(16).toString('hex')
  const fileIdentities = new Map()
  const evidenceRecord = Object.freeze({
    identity: inodeIdentityOf(directory),
    runClaimToken,
    imageTag,
    metadataFile,
    iidfile,
    claimToken,
    fileIdentities,
    recovery: { imageId: null }
  })
  ownedBuildEvidenceDirectories.set(directory, evidenceRecord)
  const result = await runCommand(
      [
        'docker',
        'build',
        '--iidfile',
        iidfile,
        '--metadata-file',
        metadataFile,
        '--tag',
        imageTag,
        '--label',
        `${buildClaimLabel}=${claimToken}`,
        '--file',
        'services/api/Dockerfile',
        '.'
      ],
      { timeoutMs: 1_800_000, env, cwd: repositoryRoot }
    )
  const captured = captureBuildEvidenceFiles(evidenceRecord, {
    requireComplete: result.status === 0
  })
  if (result.status !== 0) {
    throw new DockerEvidenceError('docker build failed')
  }
  const { imageId, configId } = parseBuildMetadataImageIdentity(
    captured.metadataText
  )
  const iid = parseCanonicalDockerImageId(captured.iidText)
  if (iid !== imageId && iid !== configId) {
    throw new DockerEvidenceError('docker build iidfile did not match build metadata')
  }
  await inspectClaimedBuildImage({ imageId, claimToken, imageTag }, { env })
  ownedBuildEvidenceDirectories.get(directory).recovery.imageId = imageId
  ownedBuildImageClaims.set(imageId, Object.freeze({ imageTag, claimToken }))
  return imageId
}

/**
 * 分阶段 scoped cleanup。stages 之间互不阻断，全部问题聚合进 residue。
 *
 * 顺序是刻意的：**明文 Secret 目录最先删**（Docker 侧任何失败都不允许把它
 * 留在盘上），随后按 claim + immutable ID 逐类收敛本轮 Docker 资源。
 *
 * project / secretsDirectory / legacy locator 三者都有形状约束，范围外一律拒绝，
 * 且拒绝本身记入 residue 而不是静默跳过。
 */
let cleanupChain = Promise.resolve()

/**
 * cleanup 串行化：信号处置与主流程的 finally 可能同时到达，两次并发的
 * `docker rm` 会互相看到「资源刚刚消失」的中间态。这里把它们排成一条链，
 * 第二次执行只会发现已经干净。
 */
export const cleanupRun = (options) => {
  const next = cleanupChain.then(
    () => cleanupRunUnsynchronized(options),
    () => cleanupRunUnsynchronized(options)
  )
  cleanupChain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

const cleanupRunUnsynchronized = async ({
  project,
  projectPattern,
  secretsDirectory = null,
  secretsIdentity = null,
  secretsPrefix,
  imageTag = null,
  imageId = null,
  runClaimToken = null,
  buildEvidenceClaimToken = null,
  overridePath = null,
  composeFile,
  composeEnvironment = process.env,
  composeArgs = [],
  danglingBaseline = null,
  realpath
}) => {
  const residue = []
  let resolvedImageId = imageId
  const recordedImageClaim = imageId === null ? null : (ownedBuildImageClaims.get(imageId) ?? null)
  let resolvedImageClaimToken = recordedImageClaim?.claimToken ?? null
  let resolvedImageTag = recordedImageClaim?.imageTag ?? imageTag
  const stage = async (label, run) => {
    try {
      await run()
    } catch {
      residue.push(`${label}: cleanup stage failed`)
    }
  }

  // 阶段 1：明文 Secret 目录（**最先**，而且**先于** project 形状校验）。
  // 否则「project 名不合规」会连带把明文凭据留在盘上——注释承诺的是「Docker
  // 侧任何失败都不允许把它留在盘上」，project 校验也属于这一类。
  await stage('secrets-directory', async () => {
    if (secretsDirectory === null) {
      return
    }
    // 目录已被上一次 cleanup 删掉时不算问题：串行化之后第二次执行本来就该
    // 「发现已经干净」。realpath 对不存在路径会抛 ENOENT，必须先判存在性。
    if (!existsSync(secretsDirectory)) {
      return
    }
    const realDir = realpath(secretsDirectory)
    // 守卫必须是「系统 tmpdir 下的该前缀开头」，不是无锚点的 includes：
    // `/Users/x/notes/meal-agent-m3b-secrets-archive` 这类路径不得被删。
    const expectedPrefix = resolve(realpath(tmpdir()), secretsPrefix)
    if (!realDir.startsWith(expectedPrefix)) {
      throw new DockerEvidenceError(
        `${secretsDirectory} is not a ${secretsPrefix}* directory under the system tmpdir`
      )
    }
    // **inode 身份复核**：路径与前缀都对，不代表它还是本轮 mkdtemp 出来的那个
    // 目录。递归删除是不可逆操作，必须先确认它仍指向本轮创建的那个 inode；
    // 对不上就报 ownership drift 并原样留下，绝不递归删别人的目录。
    if (secretsIdentity !== null) {
      const observed = lstatSync(realDir, { bigint: true })
      if (
        observed.dev !== secretsIdentity.dev ||
        observed.ino !== secretsIdentity.ino
      ) {
        throw new DockerEvidenceError(
          'ownership drift at the temporary secrets directory: it no longer refers ' +
            'to the inode this run created; refusing to remove it recursively'
        )
      }
    }
    // Never recursively delete after an asynchronous boundary. An unknown child keeps
    // the directory non-empty and turns cleanup red instead of being destroyed.
    retireSecretBundleDirectory(realDir, secretsIdentity ?? inodeIdentityOf(realDir))
  })

  // 阶段 1.5：build iidfile 的独占临时目录。正常路径会在 build 返回时删除；
  // signal/异常路径仍由 scoped cleanup 以 inode 身份逐个收敛。
  await stage('build-evidence', async () => {
    for (const [directory, record] of [...ownedBuildEvidenceDirectories.entries()]) {
      if (
        buildEvidenceClaimToken === null ||
        record.runClaimToken !== buildEvidenceClaimToken
      ) {
        continue
      }
      if (resolvedImageId === null) {
        try {
          const captured = captureBuildEvidenceFiles(record)
          const { imageId: recoveredImageId, configId } = parseBuildMetadataImageIdentity(
            captured.metadataText
          )
          const recoveredIid = parseCanonicalDockerImageId(
            captured.iidText
          )
          if (recoveredIid !== recoveredImageId && recoveredIid !== configId) {
            throw new DockerEvidenceError('docker build evidence identities did not agree')
          }
          await inspectClaimedBuildImage(
            {
              imageId: recoveredImageId,
              claimToken: record.claimToken,
              imageTag: record.imageTag
            },
            { env: composeEnvironment }
          )
          resolvedImageId = recoveredImageId
          resolvedImageClaimToken = record.claimToken
          resolvedImageTag = record.imageTag
          record.recovery.imageId = recoveredImageId
          ownedBuildImageClaims.set(
            recoveredImageId,
            Object.freeze({ imageTag: record.imageTag, claimToken: record.claimToken })
          )
        } catch {
          // metadata/iid 尚不完整时，per-run tag 是唯一恢复 locator；它只允许在随后
          // inspect 同时证明 immutable ID、claim 与 exact singleton tag 后转成 ownership。
          const recoveredFromTag = await imageIdOf(record.imageTag, { env: composeEnvironment })
          if (recoveredFromTag === null) {
            if (
              buildEvidenceDirectoryIsEmpty(record) ||
              buildEvidenceFilesAreOwnedAndEmpty(record)
            ) {
              removeOwnedBuildEvidenceDirectory(directory)
              continue
            }
            throw new DockerEvidenceError(
              'interrupted build evidence remained after its recovery tag disappeared'
            )
          }
          await inspectClaimedBuildImage(
            {
              imageId: recoveredFromTag,
              claimToken: record.claimToken,
              imageTag: record.imageTag
            },
            { env: composeEnvironment }
          )
          resolvedImageId = recoveredFromTag
          resolvedImageClaimToken = record.claimToken
          resolvedImageTag = record.imageTag
          record.recovery.imageId = recoveredFromTag
          ownedBuildImageClaims.set(
            recoveredFromTag,
            Object.freeze({ imageTag: record.imageTag, claimToken: record.claimToken })
          )
        }
      }
    }
  })

  if (typeof project !== 'string' || !projectPattern.test(project)) {
    // 记成 residue 而不是 throw：裸 throw 会把阶段 1（明文 Secret 目录）已经
    // 收集到的失败一起丢掉，而那正是最不能丢的一条。
    residue.push(
      'cleanup refused: project name is outside the meal-agent-m3b-* smoke scope'
    )
    return residue
  }

  // `compose down` 只依赖公开 project label，无法作为 destructive ownership
  // proof。所有删除因此只经过下面的 project locator + unguessable claim +
  // immutable ID 扫描；同 project 但无 claim 的外部资源保留并使 cleanup 失败。
  if (typeof runClaimToken !== 'string' || !/^[0-9a-f]{32}$/.test(runClaimToken)) {
    residue.push('cleanup refused: a valid run ownership claim is required')
    return residue
  }

  // 阶段 3—5：容器 / 网络 / 卷。每类：列出 → 逐个复核 label → 删除 → 再列一次。
  const sweeps = [
    { kind: 'container', remove: (ids) => ['docker', 'rm', '-f', '-v', ...ids], inspect: (id, label) => ['docker', 'inspect', '--format', `{{index .Config.Labels "${label}"}}`, id] },
    { kind: 'network', remove: (ids) => ['docker', 'network', 'rm', ...ids], inspect: (id, label) => ['docker', 'network', 'inspect', '--format', `{{index .Labels "${label}"}}`, id] },
    { kind: 'volume', remove: (ids) => ['docker', 'volume', 'rm', '-f', ...ids], inspect: (id, label) => ['docker', 'volume', 'inspect', '--format', `{{index .Labels "${label}"}}`, id] }
  ]
  for (const sweep of sweeps) {
    await stage(`${sweep.kind}-sweep`, async () => {
      const identifiers = await listByProject(sweep.kind, project, {
        env: composeEnvironment,
        claimToken: runClaimToken
      })
      for (const id of identifiers) {
        const projectLabel = await dockerStrict(
          sweep.inspect(id, 'com.docker.compose.project'),
          { env: composeEnvironment }
        )
        const claimLabel = await dockerStrict(sweep.inspect(id, runClaimLabel), {
          env: composeEnvironment
        })
        if (
          projectLabel.stdout.trim() !== project ||
          claimLabel.stdout.trim() !== runClaimToken
        ) {
          throw new DockerEvidenceError(
            `a listed ${sweep.kind} does not carry the exact run ownership claim`
          )
        }
      }
      if (identifiers.length > 0) {
        await dockerStrict(sweep.remove(identifiers), {
          timeoutMs: 300_000,
          env: composeEnvironment
        })
      }
      const remaining = await listByProject(sweep.kind, project, {
        env: composeEnvironment,
        claimToken: runClaimToken
      })
      if (remaining.length > 0) {
        throw new DockerEvidenceError(
          `${String(remaining.length)} ${sweep.kind}(s) remain after removal`
        )
      }
      const unclaimed = await listByProject(sweep.kind, project, { env: composeEnvironment })
      if (unclaimed.length > 0) {
        throw new DockerEvidenceError(
          `${String(unclaimed.length)} same-project ${sweep.kind}(s) lack the run claim and were preserved`
        )
      }
    })
  }

  // 阶段 6：只按 BuildKit 返回/恢复且由 claim + exact tag 复核过的 immutable ID 删除。
  await stage('image-identity', async () => {
    if (resolvedImageId === null) {
      return
    }
    const before = await runCommand(['docker', 'image', 'inspect', resolvedImageId], {
      timeoutMs: 60_000,
      env: composeEnvironment
    })
    if (
      before.status === 1 &&
      isAbsenceMessage(before.stderr, { kind: 'image', name: resolvedImageId })
    ) {
      ownedBuildImageClaims.delete(resolvedImageId)
      for (const [directory, record] of [...ownedBuildEvidenceDirectories.entries()]) {
        if (record.recovery.imageId === resolvedImageId) {
          removeOwnedBuildEvidenceDirectory(directory)
        }
      }
      return
    }
    if (before.status !== 0 || typeof before.stdout !== 'string' || before.stdout.trim() === '') {
      throw new DockerEvidenceError('owned immutable image identity could not be inspected')
    }
    if (resolvedImageClaimToken === null) {
      throw new DockerEvidenceError('recorded image identity has no ownership claim')
    }
    if (imageTag !== null && imageTag !== resolvedImageTag) {
      throw new DockerEvidenceError('recorded image locator does not match the cleanup request')
    }
    await inspectClaimedBuildImage(
      {
        imageId: resolvedImageId,
        claimToken: resolvedImageClaimToken,
        imageTag: resolvedImageTag
      },
      { env: composeEnvironment }
    )
    await dockerStrict(['docker', 'image', 'rm', resolvedImageId], {
      env: composeEnvironment
    })
    const after = await runCommand(['docker', 'image', 'inspect', resolvedImageId], {
      timeoutMs: 60_000,
      env: composeEnvironment
    })
    if (!(after.status === 1 && isAbsenceMessage(after.stderr, { kind: 'image', name: resolvedImageId }))) {
      throw new DockerEvidenceError('owned immutable image still exists after removal')
    }
    ownedBuildImageClaims.delete(resolvedImageId)
    for (const [directory, record] of [...ownedBuildEvidenceDirectories.entries()]) {
      if (record.recovery.imageId === resolvedImageId) {
        removeOwnedBuildEvidenceDirectory(directory)
      }
    }
  })

  // 阶段 7：临时 Compose override。它是**正式阶段**（不是随手 rm）：必须排在
  // compose down 之后（down 还要用它解析配置），并进入下面的 residue 复查。
  await stage('compose-override', async () => {
    if (overridePath === null) {
      return
    }
    if (!existsSync(overridePath)) {
      ownedOverrideInodes.delete(overridePath)
      return
    }
    const expectedIdentity = ownedOverrideInodes.get(overridePath)
    const observed = lstatSync(overridePath, { bigint: true })
    if (
      expectedIdentity === undefined ||
      observed.dev !== expectedIdentity.dev ||
      observed.ino !== expectedIdentity.ino
    ) {
      throw new DockerEvidenceError(
        'ownership drift at the temporary compose override; refusing to remove it'
      )
    }
    rmSync(overridePath, { force: false })
    if (existsSync(overridePath)) {
      throw new DockerEvidenceError('the temporary compose override still exists')
    }
    ownedOverrideInodes.delete(overridePath)
  })

  // 阶段 8：匿名悬挂卷前后对照（匿名卷不带 project label，label sweep 看不见）。
  await stage('dangling-volumes', async () => {
    if (danglingBaseline === null) {
      return
    }
    const now = await danglingVolumes({ env: composeEnvironment })
    const added = [...now].filter((id) => !danglingBaseline.has(id))
    if (added.length > 0) {
      throw new DockerEvidenceError(
        `${String(added.length)} anonymous dangling volume(s) appeared during this run`
      )
    }
  })

  return residue
}

/**
 * cleanup 之后的**独立复查**：六类逐项确认为空/消失。它不复用 cleanup 的中间
 * 结果，全部重新查询，且每一次查询都 fail closed。
 */
export const verifyNoResidue = async ({
  project,
  imageTag = null,
  imageId = null,
  runClaimToken = null,
  buildEvidenceClaimToken = null,
  secretsDirectory = null,
  overridePath = null,
  danglingBaseline = null,
  composeEnvironment = process.env,
  exists
}) => {
  const problems = []
  if (
    typeof buildEvidenceClaimToken === 'string' &&
    [...ownedBuildEvidenceDirectories.values()].some(
      (record) => record.runClaimToken === buildEvidenceClaimToken
    )
  ) {
    problems.push('interrupted build evidence still registered')
  }
  for (const kind of ['container', 'network', 'volume']) {
    try {
      if (typeof runClaimToken !== 'string' || !/^[0-9a-f]{32}$/.test(runClaimToken)) {
        throw new DockerEvidenceError('run claim unavailable')
      }
      const remaining = await listByProject(kind, project, {
        env: composeEnvironment,
        claimToken: runClaimToken
      })
      if (remaining.length > 0) {
        problems.push(`${String(remaining.length)} claimed ${kind}(s) still present`)
      }
      const sameProject = await listByProject(kind, project, { env: composeEnvironment })
      if (sameProject.length > 0) {
        problems.push(`${String(sameProject.length)} same-project ${kind}(s) still present`)
      }
    } catch {
      problems.push(`${kind} recheck failed`)
    }
  }
  if (imageId !== null) {
    try {
      const result = await runCommand(['docker', 'image', 'inspect', imageId], {
        timeoutMs: 60_000,
        env: composeEnvironment
      })
      if (
        !(
          result.status === 1 &&
          isAbsenceMessage(result.stderr, { kind: 'image', name: imageId })
        )
      ) {
        problems.push('owned immutable image still present')
      }
    } catch {
      problems.push('immutable image recheck failed')
    }
  }
  if (danglingBaseline !== null) {
    try {
      const now = await danglingVolumes({ env: composeEnvironment })
      const added = [...now].filter((id) => !danglingBaseline.has(id))
      if (added.length > 0) {
        problems.push(`${String(added.length)} anonymous dangling volume(s) still present`)
      }
    } catch {
      problems.push('dangling volume recheck failed')
    }
  }
  if (secretsDirectory !== null && exists(secretsDirectory)) {
    problems.push('the temporary secrets directory still exists')
  }
  if (overridePath !== null && exists(overridePath)) {
    problems.push('the temporary compose override still exists')
  }
  return problems
}

/** 临时 override 文件的删除（用后即删，失败只记 residue）。 */
export const discardOverride = (path) => {
  try {
    if (!existsSync(path)) {
      ownedOverrideInodes.delete(path)
      return
    }
    const expectedIdentity = ownedOverrideInodes.get(path)
    const observed = lstatSync(path, { bigint: true })
    if (
      expectedIdentity === undefined ||
      observed.dev !== expectedIdentity.dev ||
      observed.ino !== expectedIdentity.ino
    ) {
      return
    }
    rmSync(path, { force: false })
    ownedOverrideInodes.delete(path)
  } catch {
    // 尽力而为。
  }
}

export const overridePathFor = (directory, runId) =>
  resolve(directory, `.m3b-image-override-${runId}.yaml`)
