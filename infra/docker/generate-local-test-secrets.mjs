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
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
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
import { installSignalHandlers } from './m3b-subprocess.mjs'

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
 * 生成期间已创建的路径。CLI 的信号处置读它，把 rename 窗口里被中断的半套
 * bundle 清掉。测试也用它断言「信号中断后目录里没有任何 Secret 残留」。
 */
export const activeGeneratorScene = { paths: [] }

/** 删除本轮已创建的一切（暂存与成品），供信号处置与失败路径共用。 */
export const discardGeneratedPaths = () => {
  const removed = []
  for (const path of activeGeneratorScene.paths) {
    try {
      unlinkSync(path)
      removed.push(path)
    } catch {
      // 尽力而为；残留会被预检当作未知条目拒绝。
    }
  }
  activeGeneratorScene.paths = []
  return removed
}

const stagingName = (filename) => `.staging.${filename}`

/**
 * 生成一套完整 bundle。返回生成的文件路径列表；**从不**返回或输出口令。
 * 口令只存在于本函数的局部变量与写出的文件里。
 */
export const generateSecretBundle = (directory) => {
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

  const passwords = {}
  for (const role of passwordRoles) {
    passwords[role] = generatePassword()
  }
  const bodies = deriveSecretBodies(passwords)

  // failure-safe：暂存 → 全部就绪 → rename。任何失败都清掉已创建的一切。
  // createdPaths 同时登记给 CLI 的信号处置：rename 窗口里被 SIGINT 打断时，
  // 处置会删掉这批路径，因此不留半套 bundle（KILL 除外，用户态兜不住）。
  const createdPaths = []
  activeGeneratorScene.paths = createdPaths
  try {
    for (const filename of secretFilenames) {
      const stagingPath = resolve(target, stagingName(filename))
      const fd = openSync(stagingPath, 'wx', 0o600)
      createdPaths.push(stagingPath)
      try {
        const bytes = Buffer.from(`${bodies.get(filename)}\n`, 'utf8')
        let written = 0
        while (written < bytes.length) {
          written += writeSync(fd, bytes, written, bytes.length - written, null)
        }
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    const finalPaths = []
    for (const filename of secretFilenames) {
      const stagingPath = resolve(target, stagingName(filename))
      const finalPath = resolve(target, filename)
      renameSync(stagingPath, finalPath)
      createdPaths.splice(createdPaths.indexOf(stagingPath), 1)
      createdPaths.push(finalPath)
      finalPaths.push(finalPath)
    }
    return { directory: target, files: finalPaths }
  } catch (error) {
    for (const path of createdPaths) {
      try {
        unlinkSync(path)
      } catch {
        // 清理是尽力而为；留下的暂存条目会被预检当作未知条目拒绝。
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
  let problems
  try {
    problems = preflight(result.directory).problems
  } catch (error) {
    for (const path of result.files) {
      try {
        unlinkSync(path)
      } catch {
        // 清理是尽力而为；残留由下一次预检拒绝。
      }
    }
    throw error
  }
  if (problems.length > 0) {
    for (const path of result.files) {
      try {
        unlinkSync(path)
      } catch {
        // 同上：残留由预检拒绝。
      }
    }
    throw new SecretGeneratorError(
      'the freshly generated bundle failed its own preflight and was removed:\n' +
        problems.map((problem) => `  - ${problem}`).join('\n')
    )
  }
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
  installSignalHandlers(
    () => {
      const removed = discardGeneratedPaths()
      process.stderr.write(
        `discarded ${String(removed.length)} partially generated file(s)\n`
      )
      return []
    },
    { label: 'generator cleanup' }
  )

  try {
    const result = generateAndPreflight(directory)
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
    process.stderr.write(
      `generate-local-test-secrets: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    )
    process.exit(1)
  }
}
