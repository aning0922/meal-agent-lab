#!/usr/bin/env node
// 阶段 09A / M4：local-test 部署的 pg_dump 自定义格式备份（运维入口）。
//
//   node infra/docker/backup-local-test.mjs [--output-dir <dir>]
//
// 语义（与 runbook 一致，见 docs/operations/stage-09a-local-test-lifecycle.md）：
//
//   - 以 `meal_agent_backup_login` 连接、`--role=meal_agent_backup` 执行
//     pg_dump：备份角色带 BYPASSRLS，因此 FORCE RLS 表被**完整**导出而不是
//     被静默截断；口令只经容器内 pgpass 文件流转，不进 argv / 环境变量；
//   - 备份为 `--format=custom`，落在**已被 Git 忽略**的目录里（默认
//     `infra/docker/backups/`），目录不被忽略时拒绝执行；
//   - 备份完成后在宿主侧计算 SHA-256 并写 `<dump>.sha256` sidecar
//     （`shasum -a 256 -c` 兼容格式）；恢复入口在调用 pg_restore 之前必须
//     先按它校验；
//   - 执行前后打印目标环境与数据库标识；不打印口令或任何连接串。
//
// `pg_dump` **不包含 cluster roles**（角色属于 pg_dumpall 的范围）：恢复路径
// 必须先由 bootstrap 的 `cluster` + `logins` 重建角色，见 runbook。
import { chmodSync, mkdirSync, openSync, readSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { repositoryRoot } from './local-test-secrets-contract.mjs'
import {
  composeDirectory,
  composeFile,
  composeRunOneOff,
  defaultProjectName,
  removeLingeringOneOffs
} from './m4-lifecycle.mjs'
import { createSecretScrubber } from './m3b-safe-output.mjs'
import { installSignalHandlers, runCommand } from './m3b-subprocess.mjs'

export const defaultBackupsDirectory = resolve(composeDirectory, 'backups')
const targetDatabase = 'meal_agent'

/** 自定义格式 dump 的五字节魔数。 */
const customFormatMagic = 'PGDMP'

export const readDumpMagic = (path) => {
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(customFormatMagic.length)
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytes).toString('latin1')
  } finally {
    closeSync(descriptor)
  }
}

export const sha256OfFile = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * 将要写入的**具体文件路径**必须在仓库之外，或被 Git 忽略。判据必须落在
 * 文件路径而不是目录本身：嵌套 `.gitignore` 的 `*` 只作用于目录**内部**的
 * 条目，目录自身并不被忽略——查目录会把合法的默认 `backups/` 误判成
 * 「未忽略」（残留审计实调复现）。`git check-ignore` 退出 1 表示「没有被
 * 忽略」，那是拒绝备份的理由；其余非零是工具失败，同样拒绝（无法判定不
 * 等于可以写）。
 */
export const assertBackupTargetsIgnored = async (run, paths) => {
  for (const target of paths) {
    const relativePath = relative(repositoryRoot, target)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      continue
    }
    const check = await run(['git', 'check-ignore', '-q', '--', target], {
      cwd: repositoryRoot
    })
    if (check.status === 0) {
      continue
    }
    if (check.status === 1) {
      throw new Error(
        `refusing to write backup artifact ${target}: the path is inside the ` +
          'repository but not git-ignored; backups must never enter Git'
      )
    }
    throw new Error(
      'git check-ignore failed; cannot prove the backup target is ignored, refusing to proceed'
    )
  }
}

/**
 * 执行一次备份。`compose(args, options)` 由调用方提供（运维入口用默认
 * project，演练用每轮唯一 project + override）。返回 dump 与 sidecar 的路径
 * 及 SHA-256。
 */
export const performBackup = async (
  { compose, run, log },
  { project, outputDirectory, fileName = null }
) => {
  const directory = resolve(outputDirectory)
  const name =
    fileName ?? `${project}-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.dump$/.test(name)) {
    throw new Error('the backup file name must be a plain *.dump basename')
  }
  const dumpPath = resolve(directory, name)
  const partial = `${name}.partial`
  await assertBackupTargetsIgnored(run, [dumpPath, `${dumpPath}.sha256`])
  mkdirSync(directory, { recursive: true })

  log(`backup: deployment=local-test project=${project} database=${targetDatabase} (starting)`)

  // pg_dump 在一次性容器内执行：备份口令只经 /run/secrets → 容器内 pgpass
  // 流转；dump 先写 *.partial，成功后原子改名——半途而废的文件绝不顶着正式
  // 文件名存在。`--lock-wait-timeout` 让锁等待有界。
  const script = [
    'set -euo pipefail',
    'umask 077',
    `printf 'postgres:5432:${targetDatabase}:meal_agent_backup_login:%s\\n' "$(< /run/secrets/meal_agent_backup_password)" > /tmp/backup.pgpass`,
    'export PGPASSFILE=/tmp/backup.pgpass',
    'pg_dump --no-password --format=custom --role=meal_agent_backup' +
      ' --lock-wait-timeout=120000 --host=postgres --port=5432' +
      ` --username=meal_agent_backup_login --dbname=${targetDatabase}` +
      ` --file=/backup/${partial}`,
    `mv /backup/${partial} /backup/${name}`,
    'rm -f /tmp/backup.pgpass'
  ].join('\n')
  const dump = await composeRunOneOff(
    { compose, run, warn: log },
    ['--volume', `${directory}:/backup`, '--entrypoint', 'bash', 'bootstrap-logins', '-c', script],
    { timeoutMs: 600_000 }
  )
  if (dump.status !== 0) {
    // 失败路径不把半份导出（真实数据）留在备份目录里。partial 删不掉时把
    // 这一事实并进错误——它是含数据的残留，不能静默。
    let partialNote = ''
    try {
      rmSync(resolve(directory, partial), { force: true })
    } catch {
      partialNote = `; additionally the partial file ${partial} could not be removed`
    }
    const tail = String(dump.stderr ?? '').trim().split('\n').slice(-6).join(' / ')
    throw new Error(
      `pg_dump failed with exit ${String(dump.status)}: ${tail === '' ? '(no stderr)' : tail}${partialNote}`
    )
  }

  const magic = readDumpMagic(dumpPath)
  if (magic !== customFormatMagic) {
    throw new Error('the produced file does not carry the custom-format magic; refusing to checksum it')
  }
  const sha256 = sha256OfFile(dumpPath)
  const shaPath = `${dumpPath}.sha256`
  writeFileSync(shaPath, `${sha256}  ${name}\n`, { mode: 0o600 })
  chmodSync(dumpPath, 0o600)

  log(`backup complete: deployment=local-test project=${project} database=${targetDatabase}`)
  log(`backup file: ${dumpPath}`)
  log(`backup sha256: ${sha256}`)
  return { dumpPath, shaPath, sha256 }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let outputDirectory = defaultBackupsDirectory
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output-dir' && index + 1 < args.length) {
      outputDirectory = resolve(args[index + 1])
      index += 1
    } else {
      process.stderr.write('usage: backup-local-test.mjs [--output-dir <dir>]\n')
      process.exit(2)
    }
  }

  const scrubber = createSecretScrubber()
  const log = (line) => process.stdout.write(`${scrubber.scrub(line)}\n`)
  const run = (commandArgs, { env, timeoutMs = 120_000, cwd = composeDirectory } = {}) =>
    runCommand(commandArgs, { env: env ?? process.env, timeoutMs, cwd })
  const compose = (composeArgs, options = {}) =>
    run(
      [
        'docker',
        'compose',
        '--file',
        composeFile,
        '--profile',
        'bootstrap',
        '--project-name',
        defaultProjectName,
        ...composeArgs
      ],
      options
    )
  // 信号 cleanup 必须收掉 daemon 侧仍在跑的一次性容器：被「取消」的 pg_dump
  // 若继续跑完，宿主上会多出一份无人知晓的导出（容器内还有 pgpass 副本）。
  installSignalHandlers(async () => removeLingeringOneOffs(run), { label: 'backup cleanup' })

  try {
    await performBackup(
      { compose, run, log },
      { project: defaultProjectName, outputDirectory }
    )
    process.exit(0)
  } catch (error) {
    process.stderr.write(
      `${scrubber.scrubUntrusted(error instanceof Error ? error.message : String(error))}\n`
    )
    process.exit(1)
  }
}
