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
  mkdirSync,
  openSync,
  readdirSync,
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
  secretFilenames,
  statIfExists
} from './local-test-secrets-contract.mjs'

export class SecretGeneratorError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SecretGeneratorError'
  }
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
  const isDefaultDirectory = target === defaultSecretsDirectory
  const existing = statIfExists(target)
  if (existing !== null && !existing.isDirectory()) {
    throw new SecretGeneratorError(`${target} exists and is not a directory`)
  }

  if (existing === null) {
    mkdirSync(target, { mode: 0o700 })
  }
  // 目录必须 owner-only。对 tracked 的默认目录同样生效（git 不记录目录权限）。
  chmodSync(target, 0o700)

  // 默认拒绝覆盖：八份文件任何一份已存在、或目录里有清单之外的条目都失败。
  const entries = readdirSync(target).sort()
  const allowed = new Set(isDefaultDirectory ? defaultDirectoryAllowedEntries : [])
  for (const entry of entries) {
    if (secretFilenames.includes(entry)) {
      throw new SecretGeneratorError(
        `${entry} already exists in ${target}; refusing to overwrite an ` +
          'existing bundle (remove it explicitly first)'
      )
    }
    if (!allowed.has(entry)) {
      throw new SecretGeneratorError(
        `${entry}: unexpected entry in ${target}; the generator only writes ` +
          'into an empty bundle directory' +
        (isDefaultDirectory ? ' (README.md and .gitignore excepted)' : '')
      )
    }
  }

  const passwords = {}
  for (const role of passwordRoles) {
    passwords[role] = generatePassword()
  }
  const bodies = deriveSecretBodies(passwords)

  // failure-safe：暂存 → 全部就绪 → rename。任何失败都清掉已创建的一切。
  const createdPaths = []
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

/** 生成 + 立即预检；预检不过时删除刚生成的全部文件，不留半套。 */
export const generateAndPreflight = (directory) => {
  const result = generateSecretBundle(directory)
  const { problems } = checkSecretBundle(result.directory)
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
