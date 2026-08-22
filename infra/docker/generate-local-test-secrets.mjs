#!/usr/bin/env node
// 阶段 09A / M3B：八份 local-test Secret 的单一来源生成器。
//
//   node infra/docker/generate-local-test-secrets.mjs [--directory <绝对路径>]
//
// 只生成**四个**原始 CSPRNG 口令（superuser / migration / runtime / backup），
// 再由 local-test-secrets-contract.mjs 的同一份常量派生八个固定文件。生成过程：
//
//   - 目录权限 0700，文件权限 0600（预检同时接受 0400）；
//   - 默认拒绝覆盖：目标目录里已存在八份文件中的任何一份、或出现清单之外的
//     条目（默认目录只额外允许 README.md 与 .gitignore）都直接失败；
//   - failure-safe：先写 `.staging.<name>`，全部八份就绪后统一 rename；任何
//     一步失败都把已创建的暂存与成品全部删掉，不留半套 bundle。进程被 SIGKILL
//     打断的窗口无法由用户态兜底，残留的暂存条目会被预检当作未知条目拒绝；
//   - 口令绝不进入 stdout、stderr、argv、环境变量或 Git——本脚本的全部输出只有
//     文件名与目录路径。
//
// 生成完成后自动执行一次完整预检（preflight-local-test-secrets.mjs 的同一段
// 实现），预检不过时同样删除刚生成的全部文件。
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkSecretBundle,
  defaultDirectoryAllowedEntries,
  defaultSecretsDirectory,
  deriveSecretBodies,
  generatePassword,
  passwordRoles,
  safeRealpath,
  secretFilenames
} from './local-test-secrets-contract.mjs'
import { installSignalHandlers, terminationSignal } from './m3b-subprocess.mjs'

/** lstat 帮助器：**不**跟随 symlink 的存在性/类型判断。 */
const lstatIfExists = (path) => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

export class SecretGeneratorError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SecretGeneratorError'
  }
}

/**
 * 生成期间**本轮自己创建**的条目，以及 bundle 目录。CLI 的信号处置与失败路径
 * 都读它。`owned` 里只放本进程亲手 create/link 出来的条目——外部文件绝不进入
 * 这个集合，因此清理永远不会删掉别人的东西。
 *
 * 每个条目都是 `{ path, dev, ino }`：**路径不是身份**。路径只是一个名字，随时
 * 可能被外部 unlink 后指向另一个 inode；只登记路径的 cleanup 会把那个替身当成
 * 自己的产物删掉。身份取自**创建那一刻的 fd**（`fstat`），因此不存在「先按路径
 * stat 再认领」的 TOCTOU 空档。
 */
export const activeGeneratorScene = { owned: [], directory: null }

/** 成功收尾：owned 与 directory 都必须清空（见下面的 discardGeneratedPaths）。 */
const clearGeneratorScene = () => {
  activeGeneratorScene.owned = []
  activeGeneratorScene.directory = null
}

/**
 * 一条 owned 记录的身份判据。`dev`/`ino` 用 **BigInt**（`{ bigint: true }`）：
 * 默认的 double 形态在大 inode 号上会丢精度，而丢精度的比较等于把「不是我的
 * 文件」判成「是我的」。
 */
const identityOf = (entry) =>
  typeof entry === 'object' &&
  entry !== null &&
  typeof entry.path === 'string' &&
  entry.path !== '' &&
  typeof entry.dev === 'bigint' &&
  typeof entry.ino === 'bigint'
    ? entry
    : null

/** 从一个**刚由本进程创建**的 fd 上取身份。 */
const ownedFromFd = (path, fd) => {
  const stats = fstatSync(fd, { bigint: true })
  return { path, dev: stats.dev, ino: stats.ino }
}

const basenameOf = (path) => path.slice(path.lastIndexOf('/') + 1)

const errorCodeOf = (error) =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'unknown'

/**
 * 共享 cleanup collector：删除**本轮自己创建**的一切（暂存与成品），
 * **continue-on-failure**——一条删不掉不阻断其余，全部问题聚合成 residue。
 * 之后**独立枚举目录**再确认一次零 Secret 残留：只相信 unlink 的返回值是不够
 * 的（它证明不了目录里没有别的路径指向同一批 Secret）。
 *
 * **删除前逐条复核 inode 身份**：路径仍在，但已经指向另一个 inode（外部把它
 * unlink 后放了一个同名替身）时，绝不 unlink——那是别人的文件。这类情形记成
 * ownership drift 残留，替身原样留下。
 *
 * 有任何残留时**绝不**声称 “was removed”；返回的 residue 只含类别、计数与
 * errno，不含文件名、路径之外的内容，也不含任何 Secret 取值。
 */
export const discardGeneratedPaths = ({
  owned = activeGeneratorScene.owned,
  verifyDirectory = activeGeneratorScene.directory,
  ownNames = null
} = {}) => {
  const removed = []
  const residue = []
  for (const entry of owned) {
    const identity = identityOf(entry)
    if (identity === null) {
      // 没有可验证身份的条目一律不删：宁可留下残留，也不按名字误删。
      residue.push(
        'a registered entry carries no verifiable inode identity; refusing to ' +
          'unlink it by name alone'
      )
      continue
    }
    let observed = null
    try {
      // lstat：**不跟随 symlink**。外部把我们的成品换成指向别处的软链接时，
      // 跟随会让 unlink 的判据落在链接目标上。
      observed = lstatSync(identity.path, { bigint: true })
    } catch (error) {
      const code = errorCodeOf(error)
      if (code === 'ENOENT') {
        // 已经不在了：这既不是移除也不是残留。
        continue
      }
      residue.push(
        `could not verify a generated secret file's inode identity (${code}); ` +
          'refusing to unlink it'
      )
      continue
    }
    if (observed.dev !== identity.dev || observed.ino !== identity.ino) {
      residue.push(
        'ownership drift at a generated secret path: it no longer refers to the ' +
          'inode this run created; the entry now at that name was left untouched'
      )
      continue
    }
    try {
      unlinkSync(identity.path)
      removed.push(identity.path)
    } catch (error) {
      const code = errorCodeOf(error)
      if (code === 'ENOENT') {
        continue
      }
      residue.push(
        `could not remove a generated secret file (${code}); it is still on disk`
      )
    }
  }
  // 独立复查：直接枚举目录，看还有没有属于八份清单的条目（含 `.staging.` 前缀）。
  if (typeof verifyDirectory === 'string' && verifyDirectory !== '') {
    try {
      // ownNames 为 null 时复查整份八文件清单（信号处置路径：本轮拥有整套）；
      // 给了 ownNames 就只查本轮自己创建过的那些名字——失败清理不能把促发
      // 失败的外部同名文件误报成本轮残留。
      const watched =
        ownNames === null
          ? [
              ...secretFilenames,
              ...secretFilenames.map((filename) => `.staging.${filename}`)
            ]
          : ownNames
      const remaining = readdirSync(verifyDirectory).filter((entry) => watched.includes(entry))
      if (remaining.length > 0) {
        // 复查刻意**按名字**判定、不按 inode 身份收窄：一个坐在八份清单名字上的
        // 文件，无论是不是本轮的产物，都可能是 Secret 材料。这里宁可多报也不
        // 漏报——「不是我的」由上面的 ownership drift 单独说明。
        residue.push(
          `the bundle directory still contains ${String(remaining.length)} file(s) ` +
            'at generated secret name(s) after cleanup (names are deliberately not echoed)'
        )
      }
    } catch (error) {
      residue.push(
        `could not verify the bundle directory after cleanup (${errorCodeOf(error)})`
      )
    }
  }
  activeGeneratorScene.owned = []
  return { removed, residue }
}

const stagingName = (filename) => `.staging.${filename}`

/**
 * 写一份暂存文件（0600、fsync）。同步与可中断两条路径共用。
 *
 * `wx` 保证这个 fd 指向的 inode 一定是**本次调用创建**的（已存在即 EEXIST）；
 * 身份就从这个 fd 上取，因此登记的 dev/ino 无可争议地属于本轮。
 */
const writeStagingFile = (target, filename, body, owned) => {
  const stagingPath = resolve(target, stagingName(filename))
  const fd = openSync(stagingPath, 'wx', 0o600)
  owned.push(ownedFromFd(stagingPath, fd))
  try {
    const bytes = Buffer.from(`${body}\n`, 'utf8')
    let written = 0
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written, null)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 把一份暂存文件**原子且不覆盖**地提升为成品。
 *
 * 刻意**不用 rename**：POSIX 的 `rename(2)` 语义是「目标存在就静默替换」，
 * 于是一个并发写者（或上一轮残留）在 promotion 之前放好的同名 final 文件会被
 * 无声改写。`link(2)` 在目标已存在时以 EEXIST 失败，这正是需要的
 * no-replace 原子性：先硬链接到 final 名，成功后再删掉 staging 名。
 *
 * owned 只登记**本轮亲手创建**的 inode，因此失败清理永远不会碰外部文件。
 * final 名登记的身份就是 staging 的 dev/ino——但**必须先证明**那个 staging 名
 * 此刻仍指向本轮创建的 inode，链接之后再证明成品名指向的也是它：`link(2)` 解析
 * 的是**名字**，「link 成功 ⇒ 是我的 inode」并不成立。之后有人把 final 名换掉，
 * cleanup 的身份复核会发现并拒绝删除。
 */
const promoteStagingFile = (target, filename, owned) => {
  const stagingPath = resolve(target, stagingName(filename))
  const finalPath = resolve(target, filename)
  const stagingIndex = owned.findIndex((entry) => entry.path === stagingPath)
  const stagingIdentity = stagingIndex === -1 ? null : identityOf(owned[stagingIndex])
  if (stagingIdentity === null) {
    throw new SecretGeneratorError(
      `${filename} has no registered staging identity; refusing to promote an ` +
        'entry this run cannot prove it created'
    )
  }
  // **link(2) 解析的是名字，不是 inode**。因此 promotion 之前必须先确认那个
  // staging 名字**此刻仍然**指向本轮创建的 inode：不确认的话，一个同 uid 的
  // 并发写者把 staging 名换掉之后，我们会把**它的** inode 链到成品名上、并把
  // 它登记成自己的产物——这正是「路径不是身份」的漏洞，只是换到了创建成品的
  // 那条路径上。
  const stagingBefore = lstatSync(stagingPath, { bigint: true })
  if (
    stagingBefore.dev !== stagingIdentity.dev ||
    stagingBefore.ino !== stagingIdentity.ino
  ) {
    throw new SecretGeneratorError(
      `ownership drift at the staging entry for ${filename}: it no longer refers to ` +
        'the inode this run created; refusing to promote it'
    )
  }
  try {
    linkSync(stagingPath, finalPath)
  } catch (error) {
    if (errorCodeOf(error) === 'EEXIST') {
      throw new SecretGeneratorError(
        `${filename} already exists in the bundle directory at promotion time; ` +
          'refusing to replace a file this run did not create'
      )
    }
    throw error
  }
  // link 与上面那次 lstat 之间仍有一个极小的窗口（POSIX 没有「按 inode 链接」
  // 的原语）。窗口被抢到时**不能**把结果当成自己的：既不登记、也不删除任何一
  // 边——登记会让 cleanup 认领别人的 inode，删除会毁掉别人的文件。只报 drift。
  const promoted = lstatSync(finalPath, { bigint: true })
  if (promoted.dev !== stagingIdentity.dev || promoted.ino !== stagingIdentity.ino) {
    throw new SecretGeneratorError(
      `ownership drift while promoting ${filename}: the promoted name refers to an ` +
        'inode this run did not create; it was neither registered nor removed'
    )
  }
  // final 名已经属于本轮（与 staging 同 inode）：登记它，随后删掉 staging 名。
  owned.push({ path: finalPath, dev: stagingIdentity.dev, ino: stagingIdentity.ino })
  // 这一次 unlink **不走** discardGeneratedPaths，因此身份复核要在这里自己做：
  // 有人在 link 与 unlink 之间把 staging 名换掉时，按名字删就是删别人的文件。
  // 对不上就抛——staging 记录留在 owned 里，失败清理会把它报成 ownership drift。
  const stagingNow = lstatSync(stagingPath, { bigint: true })
  if (stagingNow.dev !== stagingIdentity.dev || stagingNow.ino !== stagingIdentity.ino) {
    throw new SecretGeneratorError(
      `the staging entry for ${filename} no longer refers to the inode this run ` +
        'created; refusing to unlink it'
    )
  }
  unlinkSync(stagingPath)
  owned.splice(stagingIndex, 1)
  return finalPath
}

/**
 * 失败后统一清理：走共享 collector（continue-on-failure + 独立目录复查）。
 * 有残留时聚合成安全错误，**绝不**声称 “was removed”。
 */
const discardAfterFailure = (result, error) => {
  const discarded = discardGeneratedPaths({
    owned: [...result.owned],
    verifyDirectory: result.directory
  })
  if (discarded.residue.length > 0) {
    return new SecretGeneratorError(
      `${error instanceof Error ? error.message : String(error)}; the cleanup could ` +
        `not remove everything: ${discarded.residue.join('; ')}`
    )
  }
  return error
}

/** 让出一次事件循环：排队中的信号在这里被分发。 */
const tick = () =>
  new Promise((resolveTick) => {
    setImmediate(resolveTick)
  })

/** 生成被信号打断时抛出的错误（CLI 据此让位给信号处置）。 */
export class SecretGenerationInterrupted extends Error {
  constructor(signal) {
    super(`secret generation was interrupted by ${signal}`)
    this.name = 'SecretGenerationInterrupted'
  }
}

/**
 * 生成一套完整 bundle。返回生成的文件路径列表；**从不**返回或输出口令。
 * 口令只存在于本函数的局部变量与写出的文件里。
 */
const prepareBundleDirectory = (directory) => {
  if (typeof directory !== 'string' || directory === '') {
    throw new SecretGeneratorError('the target directory must be a non-empty path')
  }
  if (!isAbsolute(directory)) {
    throw new SecretGeneratorError(`${directory} is not an absolute path`)
  }

  const target = resolve(directory)
  // lstat 而不是 stat：目标是 symlink 时直接拒绝，绝不跟随链接把 Secret 写进
  // 链接指向的目录（预检对 bundle 目录用的是同一条判据）。
  const existing = lstatIfExists(target)
  if (existing !== null && existing.isSymbolicLink()) {
    throw new SecretGeneratorError(
      `${target} is a symbolic link; the bundle directory must be a real directory`
    )
  }
  if (existing !== null && !existing.isDirectory()) {
    throw new SecretGeneratorError(`${target} exists and is not a directory`)
  }
  // isDefaultDirectory 与预检同口径：按 realpath 比较，不是字符串相等。
  const isDefaultDirectory =
    existing !== null
      ? realpathSync(target) === safeRealpath(defaultSecretsDirectory)
      : target === defaultSecretsDirectory

  if (existing === null) {
    mkdirSync(target, { mode: 0o700 })
  }

  // 默认拒绝覆盖：八份文件任何一份已存在、或目录里有清单之外的条目都失败。
  // 这一步在任何副作用（chmod）之前：对一个会被拒绝的目录不留任何改动。
  // 已存在的八份文件名是受信常量，可以点名；**未知条目只报数量不回显名字**
  // ——目录里的陌生文件名是不可信输入，甚至可能本身就是一段 Secret。
  const entries = readdirSync(target).sort()
  const allowed = new Set(isDefaultDirectory ? defaultDirectoryAllowedEntries : [])
  for (const entry of entries) {
    if (secretFilenames.includes(entry)) {
      throw new SecretGeneratorError(
        `${entry} already exists in ${target}; refusing to overwrite an ` +
          'existing bundle (remove it explicitly first)'
      )
    }
  }
  const unknownEntries = entries.filter(
    (entry) => !secretFilenames.includes(entry) && !allowed.has(entry)
  )
  if (unknownEntries.length > 0) {
    throw new SecretGeneratorError(
      `the target directory contains ${String(unknownEntries.length)} ` +
        'unexpected entr' + (unknownEntries.length === 1 ? 'y' : 'ies') +
        '; the generator only writes into an empty bundle directory' +
        (isDefaultDirectory ? ' (README.md and .gitignore excepted)' : '') +
        ' (unknown names are deliberately not echoed)'
    )
  }
  // 目录必须 owner-only。对 tracked 的默认目录同样生效（git 不记录目录权限）。
  chmodSync(target, 0o700)
  return { target, isDefaultDirectory }
}

/**
 * 生成一套完整 bundle（**同步**版，供库调用方与反例使用）。返回生成的文件
 * 路径列表；**从不**返回或输出口令。CLI 走的是可中断的异步版。
 */
export const generateSecretBundle = (directory, { beforePromotion = null } = {}) => {
  const { target } = prepareBundleDirectory(directory)
  const passwords = {}
  for (const role of passwordRoles) {
    passwords[role] = generatePassword()
  }
  const bodies = deriveSecretBodies(passwords)

  const owned = []
  activeGeneratorScene.owned = owned
  activeGeneratorScene.directory = target
  try {
    for (const filename of secretFilenames) {
      writeStagingFile(target, filename, bodies.get(filename), owned)
    }
    const finalPaths = []
    for (const filename of secretFilenames) {
      // 注入点**只给反例**用：让一个并发写者恰好抢在 promotion 之前放好同名
      // final 文件。生产路径永远不传它。
      beforePromotion?.(filename)
      finalPaths.push(promoteStagingFile(target, filename, owned))
    }
    // 生成成功：现场登记必须**整体**清空（owned 与 directory 都要）。只清
    // owned 会让此后的信号处置用默认 verifyDirectory 去枚举一套**完好**的
    // bundle，然后谎报「目录里还残留 8 份 Secret」。返回的 owned 是快照，供
    // 调用方（generateAndPreflight、反例）继续持有身份。
    const ownedSnapshot = [...owned]
    clearGeneratorScene()
    return { directory: target, files: finalPaths, owned: ownedSnapshot }
  } catch (error) {
    // 失败清理走**共享 collector**：continue-on-failure、聚合 residue、并做
    // 独立目录复查。它只删本轮自己创建的 inode，外部同名文件绝不受影响。
    // 复查按**本轮自己创建过的名字**收窄（`ownNames`），因此不会把促发失败的
    // 那个外部同名文件误报成残留。
    const discarded = discardGeneratedPaths({
      owned,
      verifyDirectory: target,
      ownNames: owned.map((entry) => basenameOf(entry.path))
    })
    if (discarded.residue.length > 0) {
      throw new SecretGeneratorError(
        `${error instanceof Error ? error.message : String(error)}; additionally the ` +
          `failure cleanup left residue: ${discarded.residue.join('; ')}`
      )
    }
    throw error
  }
}

/**
 * **可中断**的生成：与同步版逐字节等价，但在每一份文件之间让出事件循环，
 * 因此排队中的 SIGINT/SIGTERM 能在生成**中途**被分发。这是 CLI 走的路径。
 *
 * 同步版 `generateSecretBundle` 保留给库调用方与反例：它跑在一个不可中断的
 * 同步区间里，这一点是实测过的事实（在同步区间内 `kill -INT` 时 Node 的信号
 * 监听器根本不会被调用），因此 CLI 不能用它。
 */
export const generateSecretBundleInterruptible = async (directory) => {
  const prepared = prepareBundleDirectory(directory)
  const { target } = prepared
  const passwords = {}
  for (const role of passwordRoles) {
    passwords[role] = generatePassword()
  }
  const bodies = deriveSecretBodies(passwords)

  const owned = []
  activeGeneratorScene.owned = owned
  activeGeneratorScene.directory = target
  const abortIfSignalled = () => {
    const signal = terminationSignal()
    if (signal !== null) {
      throw new SecretGenerationInterrupted(signal)
    }
  }
  try {
    for (const filename of secretFilenames) {
      await tick()
      abortIfSignalled()
      writeStagingFile(target, filename, bodies.get(filename), owned)
    }
    const finalPaths = []
    for (const filename of secretFilenames) {
      await tick()
      abortIfSignalled()
      finalPaths.push(promoteStagingFile(target, filename, owned))
    }
    const ownedSnapshot = [...owned]
    clearGeneratorScene()
    return { directory: target, files: finalPaths, owned: ownedSnapshot }
  } catch (error) {
    // 被信号打断时**不**在这里删：现场登记仍持有已创建条目，处置会统一清理
    // 并把删不掉的条目报成 residue。其余失败按原来的 failure-safe 处理。
    if (!(error instanceof SecretGenerationInterrupted)) {
      const discarded = discardGeneratedPaths({
        owned,
        verifyDirectory: target,
        ownNames: owned.map((entry) => basenameOf(entry.path))
      })
      if (discarded.residue.length > 0) {
        throw new SecretGeneratorError(
          `${error instanceof Error ? error.message : String(error)}; additionally the ` +
            `failure cleanup left residue: ${discarded.residue.join('; ')}`
        )
      }
    }
    throw error
  }
}

/**
 * 生成 + 立即预检；预检不过时删除刚生成的全部文件，不留半套。
 * 预检**抛出**（而不是返回 problems）时同样删除——「生成失败」的任何形态都
 * 不允许把一套完整可用的真凭据留在磁盘上。
 *
 * `preflight` 参数是**只给回归测试**的注入 seam：预检自身的可抛出点全是环境
 * 异常（realpath/geteuid），无法非破坏性地稳定触发；生产调用方一律用默认的
 * checkSecretBundle。
 */
export const generateAndPreflight = (
  directory,
  { preflight = checkSecretBundle } = {}
) => {
  const result = generateSecretBundle(directory)
  // 预检期间现场登记必须**保持有效**（P1-3）：信号落在同步 preflight 里时，
  // 处置要能删掉这八份文件。
  activeGeneratorScene.owned = [...result.owned]
  activeGeneratorScene.directory = result.directory
  let problems
  try {
    problems = preflight(result.directory).problems
  } catch (error) {
    throw discardAfterFailure(result, error)
  }
  if (problems.length > 0) {
    throw discardAfterFailure(
      result,
      new SecretGeneratorError(
        'the freshly generated bundle failed its own preflight:\n' +
          problems.map((problem) => `  - ${problem}`).join('\n')
      )
    )
  }
  clearGeneratorScene()
  return result
}

/**
 * 可中断的生成 + 预检：CLI 走这一条。生成被信号打断时**不**清理（现场登记
 * 仍持有已创建路径，交给信号处置统一删并报 residue），其余失败仍按
 * failure-safe 删干净。
 */
export const generateAndPreflightInterruptible = async (
  directory,
  { preflight = checkSecretBundle } = {}
) => {
  const result = await generateSecretBundleInterruptible(directory)
  // P1-3：现场登记保持到 preflight 完成为止。
  activeGeneratorScene.owned = [...result.owned]
  activeGeneratorScene.directory = result.directory
  // 这里**没有**任何测试专用的环境变量分支。preflight 信号窗口的回归改由
  // fixtures/preflight-signal-window.mjs 用**库级注入 seam**（下面的 `preflight`
  // 形参）制造：生产二进制不认识 `MEAL_AGENT_M3B_*_DELAY_MS` 之类的取值，
  // 因此没有任何环境变量能让它进入忙等或改变时序。
  let problems
  try {
    problems = preflight(result.directory).problems
  } catch (error) {
    throw discardAfterFailure(result, error)
  }
  if (problems.length > 0) {
    throw discardAfterFailure(
      result,
      new SecretGeneratorError(
        'the freshly generated bundle failed its own preflight:\n' +
          problems.map((problem) => `  - ${problem}`).join('\n')
      )
    )
  }
  // 成功输出**之前**再让出一次事件循环并复查信号：同步 preflight 期间排队的
  // SIGINT/SIGTERM 必须在这里被分发，绝不能先打印成功再收场。
  await tick()
  const signal = terminationSignal()
  if (signal !== null) {
    throw new SecretGenerationInterrupted(signal)
  }
  clearGeneratorScene()
  return result
}

const usage = () => {
  process.stderr.write(
    'usage: generate-local-test-secrets.mjs [--directory <absolute path>]\n' +
      `       (default: ${defaultSecretsDirectory})\n`
  )
}

/**
 * CLI 的**全部**运行期接线：信号处置安装、生成前的让位 tick、可中断的
 * 生成 + 预检、成功输出与失败/中断判定。CLI 入口与 preflight 信号窗口
 * fixture 调的是**同一个**函数——fixture 因此运行的是真实
 * `generateAndPreflightInterruptible` 与真实 signal handler，而不是一份会漂移
 * 的复制品。
 *
 * `preflight` 是**唯一**的注入 seam，只能由库调用方（fixture）传入；命令行与
 * 环境变量都无法触达它，生产进程永远用默认的 checkSecretBundle。
 */
export const runGeneratorCli = async (
  directory,
  { preflight = checkSecretBundle } = {}
) => {
  // 信号处置：promotion 窗口里被 SIGINT/SIGTERM 打断时，先清掉本轮已创建的
  // 全部条目再按原信号语义退出，绝不留半套 bundle。
  //
  // **生成必须切成可被信号打断的分片**：`installSignalHandlers` 装了监听器，
  // 但 Node 的信号监听器不 ref 事件循环，而生成本身是一段同步代码——实测
  // 在同步区间里 `kill -INT` 时 handler 从不执行，进程照常 exit 0 并把八份
  // 文件全部落盘。因此这里先把控制权交回事件循环（`setImmediate`），让已经
  // 排队的信号在**生成开始之前**被分发；生成期间到达的信号则由 handler 在
  // 同步段结束后立即处置（`activeGeneratorScene` 仍持有已创建条目）。
  installSignalHandlers(
    () => {
      const { removed, residue } = discardGeneratedPaths()
      process.stderr.write(
        `discarded ${String(removed.length)} generated file(s)\n`
      )
      return residue
    },
    { label: 'generator cleanup' }
  )

  // 让事件循环先跑一轮：已经排队的 SIGINT/SIGTERM 在此被分发，处置得以在
  // 任何文件被创建之前接管。
  await new Promise((resolveTick) => {
    setImmediate(resolveTick)
  })
  if (terminationSignal() !== null) {
    // 信号已在处置中：不开始生成，也不自己退出。
    process.exitCode = 0
    return
  }
  try {
    const result = await generateAndPreflightInterruptible(directory, { preflight })
    process.stdout.write(
      `generated the local-test secret bundle in ${result.directory}\n`
    )
    for (const filename of secretFilenames) {
      process.stdout.write(`  - ${filename}\n`)
    }
    process.stdout.write(
      'the four raw passwords exist only inside these files; ' +
        'they were not printed, logged or exported\n'
    )
  } catch (error) {
    // 被信号打断不是失败：处置拥有清理与退出语义，这里不再打印错误。
    // **先让出一次事件循环**再判定：Node 的信号回调只能在事件循环里跑，而
    // 失败可能是同步 preflight 里的 git 子进程被同一个 Ctrl-C（进程组信号）
    // 杀掉导致的。不让出就 `process.exit(1)`，会把已经排队的 SIGINT 整个吞
    // 掉，并把中断误报成「bundle 预检失败」。
    await new Promise((resolveTick) => {
      setImmediate(resolveTick)
    })
    if (error instanceof SecretGenerationInterrupted || terminationSignal() !== null) {
      // 处置会打印它删掉了什么，并按原信号语义收场。
    } else {
      process.stderr.write(
        `generate-local-test-secrets: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      )
      process.exit(1)
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let directory = defaultSecretsDirectory
  if (args.length === 2 && args[0] === '--directory') {
    directory = args[1]
  } else if (args.length !== 0) {
    usage()
    process.exit(2)
  }
  // 生产入口**不传第二个参数**：预检永远是 checkSecretBundle。
  await runGeneratorCli(directory)
}
