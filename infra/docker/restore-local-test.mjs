#!/usr/bin/env node
// 阶段 09A / M4：从自定义格式备份恢复到**全新** meal_agent 数据库（运维入口）。
//
//   node infra/docker/restore-local-test.mjs --dump <path>
//
// 前置与后续步骤属于 runbook（docs/operations/stage-09a-local-test-lifecycle.md）：
// `pg_dump` 不包含 cluster roles，因此目标 cluster 必须已经跑过 bootstrap 的
// `cluster` 与 `logins` 两个阶段；本入口只覆盖中段——
//
//   1. **恢复前校验 SHA-256 sidecar**：sidecar 缺失、文件名不配对或摘要不匹配
//      时一律拒绝，且拒绝发生在任何 Docker 调用之前——pg_restore 根本不会被
//      调用；
//   2. 目标数据库必须**不存在**（恢复只进全新库，绝不覆盖既有数据）；
//   3. `createdb --owner=meal_agent_migrator`。template 带来的 `public` schema
//      **保留**：PostgreSQL 15+ 的 pg_dump 对 `public` 刻意不发 `CREATE SCHEMA`
//      （假定 initdb 已建），只发 `ALTER SCHEMA public OWNER TO …` 与 ACL——
//      删掉它会让恢复在 ALTER OWNER 上直接失败（实测）；
//   4. `pg_restore --single-transaction --exit-on-error`：恢复内容要么全部
//      提交，要么整体回滚。注意 `createdb` 在该事务**之外**：pg_restore 失败
//      时留下的是一个空的 `meal_agent` 库（owner 已是 migrator，无业务对象），
//      重跑会被「已存在」响亮拒绝——按 runbook 的销毁流程处理后重来。
//
// 之后由 runbook 继续：`bootstrap-acl` → `migrate` → `bootstrap-grants` → 验证。
// 执行前后打印目标环境与数据库标识；不打印口令或任何连接串。
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readDumpMagic, sha256OfFile } from './backup-local-test.mjs'
import {
  composeDirectory,
  composeFile,
  composeRunOneOff,
  defaultProjectName,
  removeLingeringOneOffs
} from './m4-lifecycle.mjs'
import { createSecretScrubber } from './m3b-safe-output.mjs'
import { installSignalHandlers, runCommand, terminationSignal } from './m3b-subprocess.mjs'

const targetDatabase = 'meal_agent'
const migrationRole = 'meal_agent_migrator'

/** 失败诊断的 stderr 尾部（调用方的输出边界统一负责打码）。 */
const stderrTail = (result) => {
  const tail = String(result.stderr ?? '').trim().split('\n').slice(-6).join(' / ')
  return tail === '' ? '(no stderr)' : tail
}

/** 固定拒绝理由（演练的反例按整句断言，不接受任何别的失败冒充）。 */
export const dumpNotRegularFileReason =
  'restore refused: the dump path does not resolve to a regular file; pg_restore was not invoked'
export const checksumSidecarMissingReason =
  'restore refused: the sha256 sidecar is missing; pg_restore was not invoked'
export const checksumSidecarUnparseableReason =
  'restore refused: the sha256 sidecar is not in the expected format; pg_restore was not invoked'
export const checksumSidecarMismatchedNameReason =
  'restore refused: the sha256 sidecar names a different file; pg_restore was not invoked'
export const checksumMismatchReason =
  'restore refused: the backup does not match its sha256 sidecar; pg_restore was not invoked'
export const dumpMagicReason =
  'restore refused: the file does not carry the pg_dump custom-format magic; pg_restore was not invoked'

const readChecksumSidecar = (sidecarPath) => {
  let fd = null
  try {
    fd = openSync(
      sidecarPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1024) {
      throw new Error(checksumSidecarUnparseableReason)
    }
    const bytes = readFileSync(fd)
    try {
      // ignoreBOM=true 表示**保留** BOM 为 U+FEFF，让下面的严格 framing 拒绝；
      // 默认 decoder 会吞掉 BOM，从而把带 BOM 的非规范 sidecar 当成合法首行。
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw new Error(checksumSidecarUnparseableReason)
    }
  } catch (error) {
    if (error instanceof Error && error.message === checksumSidecarUnparseableReason) {
      throw error
    }
    throw new Error(checksumSidecarUnparseableReason)
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}

/**
 * 恢复前校验：全部在宿主侧完成，不触碰 Docker。
 *
 * 校验对象是 **realpath 解析后的普通文件**，返回它连同 SHA-256——后续容器
 * 挂载的必须是同一个物理路径。否则「宿主 hash 的是符号链接目标 A、容器读到
 * 的是它自己文件系统里的 B」这种分叉会让校验失去意义（sidecar 名字仍按调用
 * 方给的路径配对；单人运维工具不试图消除 hash 与挂载之间的 TOCTOU 窗口，
 * 该边界与 M3B 的威胁模型一致）。
 */
export const verifyBackupChecksum = (dumpPath) => {
  let physicalPath
  try {
    physicalPath = realpathSync(dumpPath)
  } catch {
    throw new Error(dumpNotRegularFileReason)
  }
  if (!lstatSync(physicalPath).isFile()) {
    throw new Error(dumpNotRegularFileReason)
  }
  const sidecarPath = `${dumpPath}.sha256`
  if (!existsSync(sidecarPath)) {
    throw new Error(checksumSidecarMissingReason)
  }
  const rawSidecar = readChecksumSidecar(sidecarPath)
  const sidecar = rawSidecar.endsWith('\n') ? rawSidecar.slice(0, -1) : rawSidecar
  if (/[\r\n\u0000]/.test(sidecar)) {
    throw new Error(checksumSidecarUnparseableReason)
  }
  const parsed = /^([0-9a-f]{64})[ \t]+\*?(.+)$/.exec(sidecar)
  if (parsed === null) {
    throw new Error(checksumSidecarUnparseableReason)
  }
  if (parsed[2] !== basename(dumpPath)) {
    throw new Error(checksumSidecarMismatchedNameReason)
  }
  if (sha256OfFile(physicalPath) !== parsed[1]) {
    throw new Error(checksumMismatchReason)
  }
  if (readDumpMagic(physicalPath) !== 'PGDMP') {
    throw new Error(dumpMagicReason)
  }
  return { sha256: parsed[1], physicalPath }
}

/**
 * 执行恢复中段（校验 → 空库断言 → createdb → 单事务 pg_restore）。
 * `compose(args, options)` 与 `run` 由调用方提供。
 */
export const performRestore = async ({ compose, run, log }, { project, dumpPath }) => {
  const { sha256, physicalPath } = verifyBackupChecksum(resolve(dumpPath))
  // 容器挂载的是 realpath 解析后的物理目录/文件名：宿主校验与容器读取指向
  // 同一个文件。
  const directory = dirname(physicalPath)
  const name = basename(physicalPath)
  const oneOff = (runArgs, options) =>
    composeRunOneOff({ compose, run, warn: log }, runArgs, options)

  log(`restore: deployment=local-test project=${project} database=${targetDatabase} (starting)`)
  log(`restore source sha256: ${sha256} (verified against the sidecar before any restore step)`)

  // 目标数据库必须不存在：恢复只进全新库。
  const present = await oneOff(
    [
      '--entrypoint',
      'psql',
      'bootstrap-cluster',
      '--no-psqlrc',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '--command',
      `SELECT count(*) FROM pg_database WHERE datname = '${targetDatabase}'`
    ],
    { timeoutMs: 120_000 }
  )
  if (present.status !== 0) {
    throw new Error(`could not verify the target database is absent (psql exited ${String(present.status)})`)
  }
  if (present.stdout.trim() !== '0') {
    throw new Error(
      `restore refused: database ${targetDatabase} already exists in this cluster; ` +
        'restores only target a fresh cluster (see the runbook for the destroy path)'
    )
  }

  // createdb --owner=meal_agent_migrator：恢复路径不执行 0000，也不执行 owner
  // handoff——dump 自带正确的 owner，数据库本身的 owner 在这里一次到位。
  const created = await oneOff(
    [
      '--entrypoint',
      'createdb',
      'bootstrap-cluster',
      '--no-password',
      '--owner',
      migrationRole,
      '--',
      targetDatabase
    ],
    { timeoutMs: 120_000 }
  )
  if (created.status !== 0) {
    throw new Error(
      `createdb --owner=${migrationRole} failed with exit ${String(created.status)}: ${stderrTail(created)}`
    )
  }
  log(`created ${targetDatabase} owned by ${migrationRole}`)

  // 单事务恢复：要么全部成功，要么整体回滚。凭据是 cluster admin 的
  // PGPASSFILE（bootstrap-acl 服务声明的 secret），不经 argv。
  const restored = await oneOff(
    [
      '--volume',
      `${directory}:/backup:ro`,
      '--entrypoint',
      'pg_restore',
      'bootstrap-acl',
      '--no-password',
      '--single-transaction',
      '--exit-on-error',
      '--host=postgres',
      '--port=5432',
      '--username=postgres',
      `--dbname=${targetDatabase}`,
      `/backup/${name}`
    ],
    { timeoutMs: 900_000 }
  )
  if (restored.status !== 0) {
    throw new Error(
      `pg_restore --single-transaction failed with exit ${String(restored.status)}: ${stderrTail(restored)}`
    )
  }
  log(`restore complete: deployment=local-test project=${project} database=${targetDatabase} (single transaction)`)
  return { sha256 }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let dumpPath = null
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--dump' && index + 1 < args.length) {
      dumpPath = resolve(args[index + 1])
      index += 1
    } else {
      process.stderr.write('usage: restore-local-test.mjs --dump <path>\n')
      process.exit(2)
    }
  }
  if (dumpPath === null) {
    process.stderr.write('usage: restore-local-test.mjs --dump <path>\n')
    process.exit(2)
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
  // 信号 cleanup 必须收掉 daemon 侧仍在跑的一次性容器：被「取消」的 pg_restore
  // 若继续把单事务跑完并提交，「已取消」的恢复就实际落库了。
  installSignalHandlers(async () => removeLingeringOneOffs(run), { label: 'restore cleanup' })

  // 信号在飞时主流程不得自己 process.exit（m3b-subprocess 的让位契约，与演练
  // executeDrill 同形）：普通退出码会抢在 handler 的 lingering sweep 与重投
  // 信号之前收场，被「取消」的 pg_restore 就在 daemon 侧把单事务提交掉。无信号
  // 时 exit 前补一次同样的清扫，兑现 composeRunOneOff「留待 sweep」的警告——
  // 失败路径也不把一次性容器留在 daemon 侧；残留只打印，不改变退出码。
  const exitAfterSweepUnlessSignalled = async (code) => {
    if (terminationSignal() !== null) {
      return
    }
    for (const item of await removeLingeringOneOffs(run)) {
      process.stderr.write(`${scrubber.scrubUntrusted(item)}\n`)
    }
    if (terminationSignal() === null) {
      process.exit(code)
    }
  }

  try {
    await performRestore({ compose, run, log }, { project: defaultProjectName, dumpPath })
    log('next steps (runbook): bootstrap-acl -> migrate -> bootstrap-grants -> verification')
    await exitAfterSweepUnlessSignalled(0)
  } catch (error) {
    if (terminationSignal() !== null) {
      log(`interrupted by ${terminationSignal()}; the signal handler owns the cleanup`)
    } else {
      process.stderr.write(
        `${scrubber.scrubUntrusted(error instanceof Error ? error.message : String(error))}\n`
      )
      await exitAfterSweepUnlessSignalled(1)
    }
  }
}
