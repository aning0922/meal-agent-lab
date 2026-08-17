// 阶段 09A / M5：外部证据与宿主 artifact 的共享、纯函数协议。
//
// 这个模块刻意不运行 Docker/Compose/PostgreSQL，也不接收日志函数。调用方只能
// 得到结构化证据或固定错误码，不能把外部 stdout/stderr、路径、键名或异常文本
// 重新拼进诊断。所有副作用必须发生在证据解析成功之后。
import fs, {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const sha256Pattern = /^[0-9a-f]{64}$/

export class EvidenceProtocolError extends Error {
  constructor(code) {
    super(`evidence protocol rejected: ${code}`)
    this.name = 'EvidenceProtocolError'
    this.code = code
  }
}

const treeEntryType = (stat) =>
  stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : null

const assertJournalRoot = (journal) => {
  const observed = lstatSync(journal.root, { bigint: true })
  if (
    !observed.isDirectory() ||
    observed.dev !== journal.rootIdentity.dev ||
    observed.ino !== journal.rootIdentity.ino
  ) {
    throw new EvidenceProtocolError('owned-tree-root-drift')
  }
}

export const createOwnedTreeJournal = (root) => {
  const absoluteRoot = resolve(root)
  const stat = lstatSync(absoluteRoot, { bigint: true })
  if (!stat.isDirectory()) throw new EvidenceProtocolError('owned-tree-root')
  return {
    root: absoluteRoot,
    rootIdentity: Object.freeze({ dev: stat.dev, ino: stat.ino }),
    entries: new Map(),
    declaredOutputs: new Map()
  }
}

const ownedTreeKey = (journal, target) => {
  const absoluteTarget = resolve(target)
  const relativeTarget = relative(journal.root, absoluteTarget)
  if (
    relativeTarget === '' ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`)
  ) {
    throw new EvidenceProtocolError('owned-tree-scope')
  }
  return { absoluteTarget, relativeTarget }
}

/**
 * Declare one exact output pathname before an external producer starts. The
 * journal may adopt only a regular, single-link file at this exact name after
 * the controlled producer group has settled. Unknown siblings still fail.
 */
export const declareOwnedTreeOutput = (journal, target) => {
  assertJournalRoot(journal)
  const { absoluteTarget, relativeTarget } = ownedTreeKey(journal, target)
  if (journal.entries.has(relativeTarget) || journal.declaredOutputs.has(relativeTarget)) {
    throw new EvidenceProtocolError('owned-tree-output-duplicate')
  }
  try {
    lstatSync(absoluteTarget)
    throw new EvidenceProtocolError('owned-tree-output-exists')
  } catch (error) {
    if (error instanceof EvidenceProtocolError) throw error
    if (error?.code !== 'ENOENT') throw new EvidenceProtocolError('owned-tree-output-state')
  }
  const parent = dirname(absoluteTarget)
  if (parent !== journal.root) {
    const parentKey = relative(journal.root, parent)
    const registeredParent = journal.entries.get(parentKey)
    if (registeredParent?.type !== 'directory') {
      throw new EvidenceProtocolError('owned-tree-output-parent')
    }
  }
  journal.declaredOutputs.set(relativeTarget, Object.freeze({
    path: absoluteTarget,
    type: 'file'
  }))
}

/**
 * Run one external producer whose exact output names are known before fork.
 * Outputs are captured in finally so a nonzero producer cannot bypass the
 * ownership journal. Signal cleanup may adopt the same declarations first.
 */
export const runWithDeclaredOwnedTreeOutputs = async (journal, targets, operation) => {
  if (!Array.isArray(targets) || targets.length === 0 || typeof operation !== 'function') {
    throw new EvidenceProtocolError('owned-tree-output-operation')
  }
  for (const target of targets) declareOwnedTreeOutput(journal, target)
  try {
    return await operation()
  } finally {
    for (const target of targets) {
      if (fs.existsSync(target)) registerOwnedTree(journal, target)
    }
  }
}

const adoptDeclaredOutput = (journal, key, stat) => {
  const declaration = journal.declaredOutputs.get(key)
  if (
    declaration === undefined ||
    declaration.type !== 'file' ||
    !stat.isFile() ||
    stat.nlink !== 1n
  ) {
    throw new EvidenceProtocolError('owned-tree-entry-drift')
  }
  const entry = Object.freeze({
    path: declaration.path,
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    type: 'file'
  })
  journal.entries.set(key, entry)
  journal.declaredOutputs.delete(key)
  return entry
}

/** Register a controlled output immediately after its creating operation settles. */
export const registerOwnedTree = (journal, target) => {
  assertJournalRoot(journal)
  const { absoluteTarget } = ownedTreeKey(journal, target)
  const visit = (path) => {
    const stat = lstatSync(path, { bigint: true })
    const type = treeEntryType(stat)
    if (type === null) throw new EvidenceProtocolError('owned-tree-entry-type')
    const key = relative(journal.root, path)
    let previous = journal.entries.get(key)
    if (previous === undefined && journal.declaredOutputs.has(key)) {
      previous = adoptDeclaredOutput(journal, key, stat)
    }
    if (
      previous !== undefined &&
      (previous.dev !== stat.dev || previous.ino !== stat.ino || previous.type !== type)
    ) {
      throw new EvidenceProtocolError('owned-tree-entry-drift')
    }
    journal.entries.set(key, Object.freeze({
      path,
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink,
      type
    }))
    if (type === 'directory') {
      for (const name of readdirSync(path).sort()) visit(resolve(path, name))
    }
  }
  visit(absoluteTarget)
}

/**
 * Validate the complete current tree before deleting the first name. Unknown
 * children and inode replacements remain untouched and turn cleanup red.
 */
export const retireOwnedTree = (journal) => {
  assertJournalRoot(journal)
  const observedEntries = []
  const visit = (path) => {
    const stat = lstatSync(path, { bigint: true })
    const type = treeEntryType(stat)
    const key = relative(journal.root, path)
    const expected = journal.entries.get(key) ?? (
      journal.declaredOutputs.has(key) ? adoptDeclaredOutput(journal, key, stat) : undefined
    )
    if (
      type === null ||
      expected === undefined ||
      expected.dev !== stat.dev ||
      expected.ino !== stat.ino ||
      (type !== 'directory' && expected.nlink !== stat.nlink) ||
      expected.type !== type
    ) {
      throw new EvidenceProtocolError('owned-tree-entry-drift')
    }
    observedEntries.push({ path, key, type })
    if (type === 'directory') {
      for (const name of readdirSync(path).sort()) visit(resolve(path, name))
    }
  }
  for (const name of readdirSync(journal.root).sort()) visit(resolve(journal.root, name))
  observedEntries.sort((left, right) => right.key.split(sep).length - left.key.split(sep).length)
  const removedLinksByInode = new Map()
  for (const entry of observedEntries) {
    const current = lstatSync(entry.path, { bigint: true })
    const expected = journal.entries.get(entry.key)
    const inodeKey = expected === undefined ? null : `${String(expected.dev)}:${String(expected.ino)}`
    const removedLinks = inodeKey === null ? 0n : (removedLinksByInode.get(inodeKey) ?? 0n)
    if (
      expected === undefined ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      treeEntryType(current) !== expected.type ||
      (expected.type !== 'directory' && current.nlink !== expected.nlink - removedLinks)
    ) {
      throw new EvidenceProtocolError('owned-tree-entry-drift')
    }
    if (entry.type === 'directory') rmdirSync(entry.path)
    else {
      unlinkSync(entry.path)
      removedLinksByInode.set(inodeKey, removedLinks + 1n)
    }
  }
  rmdirSync(journal.root)
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
 * `pg_restore --create --list` 的成功 stdout 是 archive 的**有界预检**，不是任意非空文本，
 * 也不是一份通用 PostgreSQL archive verifier。
 * 注释/头信息以 `;` 开头，真实 TOC 行以 dump id + catalog OID 对开头。至少要有
 * 一条 TOC；任意未知非空行、NUL、CR 或超界输出都 fail closed。PostgreSQL custom
 * archives 的 `TOC Entries` 还包含三条不会出现在 Selected TOC Entries 列表里的
 * archive-setting entries。其余 TOC description 仍由固定版本的 PostgreSQL 18 自己解析；
 * 本 helper 不冒充可以枚举所有 object type。PostgreSQL 18 的 `--create --list` 会物化 DATABASE，
 * DATABASE PROPERTIES 则可缺席；数据库身份同时由精确 `dbname` header 与唯一
 * DATABASE capability 行绑定，完整性关系为 declared = visible + 3。
 */
export const parsePgRestoreListEvidence = (
  text,
  { expectedDatabase = 'meal_agent' } = {}
) => {
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    text.length > 16 * 1024 * 1024 ||
    !text.endsWith('\n') ||
    /[\u0000\r]/.test(text)
  ) {
    throw new EvidenceProtocolError('archive-list-framing')
  }
  let entries = 0
  let comments = 0
  let declaredEntries = null
  let archiveHeaders = 0
  let customFormatHeaders = 0
  let dumpVersionHeaders = 0
  let databaseHeaders = 0
  let headerDatabase = null
  let databaseEntries = 0
  let targetDatabaseEntries = 0
  let databasePropertyEntries = 0
  let targetDatabasePropertyEntries = 0
  const dumpIds = new Set()
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (line.startsWith(';')) {
      comments += 1
      if (/^; Archive created at .+$/.test(line)) archiveHeaders += 1
      const tocEntries = /^;\s+TOC Entries: ([1-9][0-9]*)$/.exec(line)
      if (tocEntries !== null) {
        if (declaredEntries !== null) {
          throw new EvidenceProtocolError('archive-list-shape')
        }
        declaredEntries = Number(tocEntries[1])
      }
      if (/^;\s+Format: /.test(line)) {
        if (line !== ';     Format: CUSTOM') {
          throw new EvidenceProtocolError('archive-list-shape')
        }
        customFormatHeaders += 1
      }
      if (/^;\s+Dump Version: [1-9][0-9]*\.[0-9]+(?:-[0-9]+)?$/.test(line)) {
        dumpVersionHeaders += 1
      }
      const databaseHeader = /^;\s+dbname: ([A-Za-z_][A-Za-z0-9_]*)$/.exec(line)
      if (/^;\s+dbname:/.test(line) && databaseHeader === null) {
        throw new EvidenceProtocolError('archive-list-shape')
      }
      if (databaseHeader !== null) {
        databaseHeaders += 1
        headerDatabase = databaseHeader[1]
      }
      continue
    }
    const entry = /^([1-9][0-9]*); ([0-9]+) ([0-9]+) (.+)$/.exec(line)
    if (entry === null || dumpIds.has(entry[1])) {
      throw new EvidenceProtocolError('archive-list-shape')
    }
    dumpIds.add(entry[1])
    const databaseEntry = /^DATABASE - ([A-Za-z_][A-Za-z0-9_]*) ([A-Za-z_][A-Za-z0-9_]*)$/.exec(entry[4])
    const databasePropertyEntry = /^DATABASE PROPERTIES - ([A-Za-z_][A-Za-z0-9_]*) ([A-Za-z_][A-Za-z0-9_]*)$/.exec(entry[4])
    if (entry[4].startsWith('DATABASE - ') && databaseEntry === null) {
      throw new EvidenceProtocolError('archive-list-shape')
    }
    if (entry[4].startsWith('DATABASE PROPERTIES - ') && databasePropertyEntry === null) {
      throw new EvidenceProtocolError('archive-list-shape')
    }
    if (databaseEntry !== null) {
      if (entry[2] !== '1262' || !/^[1-9][0-9]*$/.test(entry[3])) {
        throw new EvidenceProtocolError('archive-list-shape')
      }
      databaseEntries += 1
      if (databaseEntry[1] === expectedDatabase) {
        targetDatabaseEntries += 1
      }
    }
    if (databasePropertyEntry !== null) {
      if (entry[2] !== '0' || entry[3] !== '0') {
        throw new EvidenceProtocolError('archive-list-shape')
      }
      databasePropertyEntries += 1
      if (databasePropertyEntry[1] === expectedDatabase) {
        targetDatabasePropertyEntries += 1
      }
    }
    entries += 1
  }
  if (
    comments === 0 ||
    entries === 0 ||
    archiveHeaders !== 1 ||
    customFormatHeaders !== 1 ||
    dumpVersionHeaders !== 1 ||
    databaseHeaders !== 1 ||
    headerDatabase !== expectedDatabase ||
    databaseEntries !== 1 ||
    targetDatabaseEntries !== 1 ||
    databasePropertyEntries > 1 ||
    targetDatabasePropertyEntries !== databasePropertyEntries ||
    declaredEntries !== entries + 3
  ) {
    throw new EvidenceProtocolError('archive-list-incomplete')
  }
  return Object.freeze({ comments, entries, database: expectedDatabase })
}

const sha256OfBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const statIdentity = (path, stat, sha256) =>
  Object.freeze({
    path,
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777n,
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
    return (
      stat.isFile() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino &&
      stat.nlink === identity.nlink &&
      stat.size === identity.size &&
      stat.uid === identity.uid &&
      stat.gid === identity.gid &&
      (stat.mode & 0o7777n) === identity.mode
    )
  } catch {
    return false
  }
}

export const snapshotDirectoryEvidence = (
  path,
  { code = 'directory-evidence' } = {}
) => {
  try {
    const absolute = resolve(path)
    const stat = lstatSync(absolute, { bigint: true })
    if (!stat.isDirectory()) throw new EvidenceProtocolError(code)
    return Object.freeze({ path: absolute, dev: stat.dev, ino: stat.ino })
  } catch (error) {
    if (error instanceof EvidenceProtocolError) throw error
    throw new EvidenceProtocolError(code)
  }
}

export const directoryEvidenceStillNames = (identity) => {
  try {
    const absolute = resolve(identity.path)
    const stat = lstatSync(absolute, { bigint: true })
    return stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino
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
      observed.identity.uid === identity.uid &&
      observed.identity.gid === identity.gid &&
      observed.identity.mode === identity.mode &&
      observed.identity.sha256 === identity.sha256 &&
      observed.bytes.equals(expectedBytes)
    )
  } catch {
    return false
  }
}

const syncDirectoryEntry = (directory) => {
  let fd = null
  let failed = false
  try {
    fd = fs.openSync(directory, constants.O_RDONLY)
    if (!fs.fstatSync(fd).isDirectory()) failed = true
    else fs.fsyncSync(fd)
  } catch {
    failed = true
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        failed = true
      }
    }
  }
  if (failed) throw new EvidenceProtocolError('directory-sync')
}

const productionEvidenceOperations = Object.freeze({
  closeFile: (fd) => fs.closeSync(fd),
  linkFile: (source, destination) => fs.linkSync(source, destination),
  syncDirectory: (directory) => syncDirectoryEntry(directory),
  syncFile: (fd) => fs.fsyncSync(fd),
  unlinkFile: (path) => fs.unlinkSync(path)
})

const removeExactInode = (path, identity, operations) => {
  try {
    const current = lstatSync(path, { bigint: true })
    if (
      current.isFile() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    ) {
      operations.unlinkFile(path)
      return true
    }
  } catch {
    // The caller reports the fixed protocol error and independently checks residue.
  }
  return false
}

/**
 * 同目录 staging + file fsync + close + link(2) no-replace promotion + parent
 * directory fsync 的正式文件发布。正式名字在完整字节已关闭前不可见；失败不覆盖
 * 既有名字，且只回收本轮取得的精确 inode。
 */
export const writeExclusiveEvidenceFile = (
  path,
  bytes,
  {
    mode = 0o600,
    code = 'exclusive-publish',
    operations = productionEvidenceOperations,
    registerStagingIdentity = null,
    registerPublishedIdentity = null,
    // Backward-compatible alias. It now means the published final inode, never
    // the still-open staging name.
    registerCreatedIdentity = registerPublishedIdentity
  } = {}
) => {
  if (!Buffer.isBuffer(bytes)) throw new EvidenceProtocolError(code)
  if (
    operations === null ||
    typeof operations !== 'object' ||
    typeof operations.closeFile !== 'function' ||
    typeof operations.linkFile !== 'function' ||
    typeof operations.syncDirectory !== 'function' ||
    typeof operations.syncFile !== 'function' ||
    typeof operations.unlinkFile !== 'function'
  ) {
    throw new EvidenceProtocolError(code)
  }
  const parent = dirname(path)
  const stagingPath = join(
    parent,
    `.${basename(path)}.meal-agent-${randomBytes(16).toString('hex')}.tmp`
  )
  let fd = null
  let stagingIdentity = null
  let publishedIdentity = null
  let finalNameClaimed = false
  let resultIdentity = null
  let failed = false
  try {
    fd = openSync(
      stagingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode
    )
    const opened = fstatSync(fd, { bigint: true })
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      (opened.mode & 0o7777n) !== BigInt(mode)
    ) {
      throw new EvidenceProtocolError(code)
    }
    stagingIdentity = statIdentity(stagingPath, opened, sha256OfBytes(Buffer.alloc(0)))
    registerStagingIdentity?.(stagingIdentity)
    writeFileSync(fd, bytes)
    const stat = fstatSync(fd, { bigint: true })
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.size !== BigInt(bytes.length) ||
      stat.uid !== opened.uid ||
      stat.gid !== opened.gid ||
      (stat.mode & 0o7777n) !== BigInt(mode)
    ) {
      throw new EvidenceProtocolError(code)
    }
    operations.syncFile(fd)
    resultIdentity = statIdentity(path, stat, sha256OfBytes(bytes))
  } catch (error) {
    failed = true
  } finally {
    if (fd !== null) {
      try {
        operations.closeFile(fd)
      } catch {
        failed = true
      }
    }
  }
  if (!failed && resultIdentity !== null) {
    try {
      operations.linkFile(stagingPath, path)
      finalNameClaimed = true
      const staged = lstatSync(stagingPath, { bigint: true })
      const published = lstatSync(path, { bigint: true })
      if (
        !staged.isFile() ||
        !published.isFile() ||
        staged.dev !== published.dev ||
        staged.ino !== published.ino ||
        staged.nlink !== 2n ||
        published.nlink !== 2n
      ) {
        throw new EvidenceProtocolError(code)
      }
      publishedIdentity = statIdentity(path, published, sha256OfBytes(bytes))
      registerCreatedIdentity?.(publishedIdentity)
      operations.unlinkFile(stagingPath)
      const solePublished = lstatSync(path, { bigint: true })
      if (
        !solePublished.isFile() ||
        solePublished.dev !== publishedIdentity.dev ||
        solePublished.ino !== publishedIdentity.ino ||
        solePublished.nlink !== 1n
      ) {
        throw new EvidenceProtocolError(code)
      }
      resultIdentity = statIdentity(path, solePublished, sha256OfBytes(bytes))
      operations.syncDirectory(parent)
    } catch {
      failed = true
    }
  }
  if (failed || resultIdentity === null) {
    let removed = false
    if (publishedIdentity !== null) {
      removed = removeExactInode(path, publishedIdentity, operations) || removed
    } else if (finalNameClaimed && stagingIdentity !== null) {
      removed = removeExactInode(path, stagingIdentity, operations) || removed
    }
    if (stagingIdentity !== null) {
      removed = removeExactInode(stagingPath, stagingIdentity, operations) || removed
    }
    if (removed) {
      try {
        operations.syncDirectory(parent)
      } catch {
        // Publication already failed; callers also verify exact-path residue.
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

/** A status-0 Compose call is not freshness evidence on its own. */
export const requireFreshContainerGeneration = (
  baseline,
  current,
  { code = 'container-generation' } = {}
) => {
  if (
    !isRecord(current) ||
    typeof current.Id !== 'string' ||
    current.Id === '' ||
    !isRecord(current.State) ||
    typeof current.State.StartedAt !== 'string' ||
    current.State.StartedAt === ''
  ) {
    throw new EvidenceProtocolError(code)
  }
  if (baseline === null) return current
  if (
    !isRecord(baseline) ||
    typeof baseline.Id !== 'string' ||
    baseline.Id === '' ||
    !isRecord(baseline.State) ||
    typeof baseline.State.StartedAt !== 'string' ||
    baseline.State.StartedAt === '' ||
    baseline.State.StartedAt === current.State.StartedAt
  ) {
    throw new EvidenceProtocolError(code)
  }
  return current
}

export const parseSignalResidueListing = (kind, stdout) => {
  if (!['container', 'network', 'volume'].includes(kind)) {
    throw new EvidenceProtocolError('signal-residue-listing')
  }
  if (typeof stdout !== 'string' || /[\u0000\r]/.test(stdout)) {
    throw new EvidenceProtocolError('signal-residue-listing')
  }
  const framed = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
  if (framed === '') return []
  const identifiers = framed.split('\n')
  const identityPattern = kind === 'volume'
    ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/
    : /^[0-9a-f]{64}$/
  if (
    identifiers.some((identifier) => !identityPattern.test(identifier)) ||
    new Set(identifiers).size !== identifiers.length
  ) {
    throw new EvidenceProtocolError('signal-residue-listing')
  }
  return identifiers
}
