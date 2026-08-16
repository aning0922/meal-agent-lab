// 阶段 09A / M5：外部证据与宿主 artifact 的共享、纯函数协议。
//
// 这个模块刻意不运行 Docker/Compose/PostgreSQL，也不接收日志函数。调用方只能
// 得到结构化证据或固定错误码，不能把外部 stdout/stderr、路径、键名或异常文本
// 重新拼进诊断。所有副作用必须发生在证据解析成功之后。
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'

const sha256Pattern = /^[0-9a-f]{64}$/

export class EvidenceProtocolError extends Error {
  constructor(code) {
    super(`evidence protocol rejected: ${code}`)
    this.name = 'EvidenceProtocolError'
    this.code = code
  }
}

export const sameKeySet = (value, expectedKeys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === expectedKeys.length &&
  expectedKeys.every((key) => Object.hasOwn(value, key))

export const requireClosedRecord = (
  value,
  { requiredKeys, optionalKeys = [], code = 'record-shape' }
) => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !requiredKeys.includes(key) && !optionalKeys.includes(key)
    )
  ) {
    throw new EvidenceProtocolError(code)
  }
  return value
}

/**
 * `pg_restore --list` 的成功 stdout 是 archive 的 TOC 证据，不是任意非空文本。
 * 注释/头信息以 `;` 开头，真实 TOC 行以 dump id + catalog OID 对开头。至少要有
 * 一条 TOC；任意未知非空行、NUL、CR 或超界输出都 fail closed。
 */
export const parsePgRestoreListEvidence = (text) => {
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    text.length > 16 * 1024 * 1024 ||
    /[\u0000\r]/.test(text)
  ) {
    throw new EvidenceProtocolError('archive-list-framing')
  }
  let entries = 0
  let comments = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (line.startsWith(';')) {
      comments += 1
      continue
    }
    if (!/^[1-9][0-9]*; [0-9]+ [0-9]+ .+$/.test(line)) {
      throw new EvidenceProtocolError('archive-list-shape')
    }
    entries += 1
  }
  if (comments === 0 || entries === 0) {
    throw new EvidenceProtocolError('archive-list-incomplete')
  }
  return Object.freeze({ comments, entries })
}

const sha256OfBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')

const statIdentity = (path, stat, sha256) =>
  Object.freeze({
    path,
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    sha256
  })

/**
 * 通过 O_NOFOLLOW 打开并一次读取普通、单链接文件；打开前后使用同一个 fd 的
 * fstat 绑定 dev/ino/nlink/size，读取结果再绑定 SHA-256。返回的 Buffer 是后续
 * 发布/恢复唯一允许使用的字节源，调用方不得重新按路径读取。
 */
export const readStableRegularFile = (
  path,
  { maxBytes = 1024 * 1024 * 1024, code = 'file-evidence' } = {}
) => {
  let fd = null
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd, { bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 0n ||
      before.size > BigInt(maxBytes)
    ) {
      throw new EvidenceProtocolError(code)
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1n ||
      after.size !== before.size ||
      BigInt(bytes.length) !== before.size
    ) {
      throw new EvidenceProtocolError(code)
    }
    return Object.freeze({
      bytes,
      identity: statIdentity(path, after, sha256OfBytes(bytes))
    })
  } catch (error) {
    if (error instanceof EvidenceProtocolError) throw error
    throw new EvidenceProtocolError(code)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export const identityStillNamesFile = (identity) => {
  try {
    const stat = lstatSync(identity.path, { bigint: true })
    return stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino
  } catch {
    return false
  }
}

export const verifyPublishedFileEvidence = (identity, expectedBytes) => {
  if (
    identity === null ||
    typeof identity !== 'object' ||
    !Buffer.isBuffer(expectedBytes) ||
    !sha256Pattern.test(identity.sha256 ?? '') ||
    !identityStillNamesFile(identity)
  ) {
    return false
  }
  try {
    const observed = readStableRegularFile(identity.path, {
      maxBytes: Math.max(1, expectedBytes.length),
      code: 'published-file-drift'
    })
    return (
      observed.identity.dev === identity.dev &&
      observed.identity.ino === identity.ino &&
      observed.identity.nlink === 1n &&
      observed.identity.size === BigInt(expectedBytes.length) &&
      observed.identity.sha256 === identity.sha256 &&
      observed.bytes.equals(expectedBytes)
    )
  } catch {
    return false
  }
}

/** O_EXCL + O_NOFOLLOW 的正式文件发布；失败不覆盖既有名字。 */
export const writeExclusiveEvidenceFile = (
  path,
  bytes,
  { mode = 0o600, code = 'exclusive-publish' } = {}
) => {
  if (!Buffer.isBuffer(bytes)) throw new EvidenceProtocolError(code)
  let fd = null
  let createdIdentity = null
  let resultIdentity = null
  let failed = false
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode
    )
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new EvidenceProtocolError(code)
    }
    createdIdentity = statIdentity(path, opened, sha256OfBytes(Buffer.alloc(0)))
    writeFileSync(fd, bytes)
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.length)) {
      throw new EvidenceProtocolError(code)
    }
    resultIdentity = statIdentity(path, stat, sha256OfBytes(bytes))
  } catch (error) {
    failed = true
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        failed = true
      }
    }
  }
  if (failed || resultIdentity === null) {
    if (createdIdentity !== null && identityStillNamesFile(createdIdentity)) {
      try {
        unlinkSync(path)
      } catch {
        // 固定协议错误覆盖底层文本；调用方仍会以正式路径 residue 阻断。
      }
    }
    throw new EvidenceProtocolError(code)
  }
  return resultIdentity
}

export const sha256Bytes = (bytes) => {
  if (!Buffer.isBuffer(bytes)) throw new EvidenceProtocolError('sha256-input')
  return sha256OfBytes(bytes)
}
