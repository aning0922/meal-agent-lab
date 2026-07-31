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
 * 生成期间**本轮自己创建**的路径，以及 bundle 目录。CLI 的信号处置与失败路径
 * 都读它。`paths` 里只放本进程亲手 create/link 出来的条目——外部文件绝不进入
 * 这个集合，因此清理永远不会删掉别人的东西。
 */
export const activeGeneratorScene = { paths: [], directory: null }

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
 * 有任何残留时**绝不**声称 “was removed”；返回的 residue 只含文件名、计数与
 * errno，不含路径之外的内容，也不含任何 Secret 取值。
 */
export const discardGeneratedPaths = ({
  paths = activeGeneratorScene.paths,
  verifyDirectory = activeGeneratorScene.directory
} = {}) => {
  const removed = []
  const residue = []
  for (const path of paths) {
    try {
      unlinkSync(path)
      removed.push(path)
    } catch (error) {
      const code = errorCodeOf(error)
      if (code === 'ENOENT') {
        // 已经不在了：这既不是移除也不是残留。
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
      const remaining = readdirSync(verifyDirectory).filter(
        (entry) =>
          secretFilenames.includes(entry) ||
          secretFilenames.some((filename) => entry === `.staging.${filename}`)
      )
      if (remaining.length > 0) {
        residue.push(
          `the bundle directory still contains ${String(remaining.length)} secret ` +
            'file(s) after cleanup (names are deliberately not echoed)'
        )
      }
    } catch (error) {
      residue.push(
        `could not verify the bundle directory after cleanup (${errorCodeOf(error)})`
      )
    }
  }
  activeGeneratorScene.paths = []
  return { removed, residue }
}

const stagingName = (filename) => `.staging.${filename}`

/** 写一份暂存文件（0600、fsync）。同步与可中断两条路径共用。 */
const writeStagingFile = (target, filename, body, createdPaths) => {
  const stagingPath = resolve(target, stagingName(filename))
  const fd = openSync(stagingPath, 'wx', 0o600)
  createdPaths.push(stagingPath)
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
 * createdPaths 只登记**本轮亲手创建**的名字，因此失败清理永远不会碰外部文件。
 */
const promoteStagingFile = (target, filename, createdPaths) => {
  const stagingPath = resolve(target, stagingName(filename))
  const finalPath = resolve(target, filename)
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
  // final 名已经属于本轮：登记它，随后删掉 staging 名。
  createdPaths.push(finalPath)
  unlinkSync(stagingPath)
  createdPaths.splice(createdPaths.indexOf(stagingPath), 1)
  return finalPath
}

/**
 * 失败后统一清理：走共享 collector（continue-on-failure + 独立目录复查）。
 * 有残留时聚合成安全错误，**绝不**声称 “was removed”。
 */
const discardAfterFailure = (result, error) => {
  const discarded = discardGeneratedPaths({
    paths: [...result.files],
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

  const createdPaths = []
  activeGeneratorScene.paths = createdPaths
  activeGeneratorScene.directory = target
  try {
    for (const filename of secretFilenames) {
      writeStagingFile(target, filename, bodies.get(filename), createdPaths)
    }
    const finalPaths = []
    for (const filename of secretFilenames) {
      // 注入点**只给反例**用：让一个并发写者恰好抢在 promotion 之前放好同名
      // final 文件。生产路径永远不传它。
      beforePromotion?.(filename)
      finalPaths.push(promoteStagingFile(target, filename, createdPaths))
    }
    // 生成成功：现场登记必须清空。否则此后任何信号处置都会把一套**完好**的
    // bundle 当成半成品删掉，并谎报「discarded N partially generated files」。
    activeGeneratorScene.paths = []
    return { directory: target, files: finalPaths }
  } catch (error) {
    // 失败清理走**共享 collector**：continue-on-failure、聚合 residue、并做
    // 独立目录复查。它只删本轮自己创建的路径，外部同名文件绝不受影响。
    const discarded = discardGeneratedPaths({ paths: createdPaths, verifyDirectory: null })
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

  const createdPaths = []
  activeGeneratorScene.paths = createdPaths
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
      writeStagingFile(target, filename, bodies.get(filename), createdPaths)
    }
    const finalPaths = []
    for (const filename of secretFilenames) {
      await tick()
      abortIfSignalled()
      finalPaths.push(promoteStagingFile(target, filename, createdPaths))
    }
    activeGeneratorScene.paths = []
    return { directory: target, files: finalPaths }
  } catch (error) {
    // 被信号打断时**不**在这里删：现场登记仍持有已创建路径，处置会统一清理
    // 并把删不掉的条目报成 residue。其余失败按原来的 failure-safe 处理。
    if (!(error instanceof SecretGenerationInterrupted)) {
      const discarded = discardGeneratedPaths({ paths: createdPaths, verifyDirectory: null })
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
  activeGeneratorScene.paths = [...result.files]
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
  activeGeneratorScene.paths = []
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
  activeGeneratorScene.paths = [...result.files]
  activeGeneratorScene.directory = result.directory
  // 只给反例用的窗口标记与延时：让 SIGINT 能确定地落在**同步** preflight 中。
  const preflightDelayMs = Number(process.env['MEAL_AGENT_M3B_PREFLIGHT_DELAY_MS'] ?? '0')
  if (Number.isInteger(preflightDelayMs) && preflightDelayMs > 0) {
    process.stderr.write('entering preflight\n')
    const until = Date.now() + preflightDelayMs
    while (Date.now() < until) {
      // 刻意的同步忙等：模拟一次不让出事件循环的 preflight。
    }
  }
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
  activeGeneratorScene.paths = []
  return result
}

const usage = () => {
  process.stderr.write(
    'usage: generate-local-test-secrets.mjs [--directory <absolute path>]\n' +
      `       (default: ${defaultSecretsDirectory})\n`
  )
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

  // 信号处置：rename 窗口里被 SIGINT/SIGTERM 打断时，先清掉本轮已创建的
  // 全部路径再按原信号语义退出，绝不留半套 bundle。
  //
  // **生成必须切成可被信号打断的分片**：`installSignalHandlers` 装了监听器，
  // 但 Node 的信号监听器不 ref 事件循环，而生成本身是一段同步代码——实测
  // 在同步区间里 `kill -INT` 时 handler 从不执行，进程照常 exit 0 并把八份
  // 文件全部落盘。因此这里先把控制权交回事件循环（`setImmediate`），让已经
  // 排队的信号在**生成开始之前**被分发；生成期间到达的信号则由 handler 在
  // 同步段结束后立即处置（`activeGeneratorScene` 仍持有已创建路径）。
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
  } else {
  try {
    const result = await generateAndPreflightInterruptible(directory)
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
}
