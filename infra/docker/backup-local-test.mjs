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
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertCanonicalGitRepositoryView,
  repositoryRoot
} from './local-test-secrets-contract.mjs'
import {
  composeDirectory,
  composeFile,
  composeRunOneOff,
  createScopedArtifactCleanup,
  defaultProjectName,
  removeLingeringOneOffs
} from './m4-lifecycle.mjs'
import { createSecretScrubber } from './m3b-safe-output.mjs'
import { installSignalHandlers, runCommand, terminationSignal } from './m3b-subprocess.mjs'
import {
  parsePgRestoreListEvidence,
  directoryEvidenceStillNames,
  readStableRegularFile,
  sha256Bytes,
  snapshotDirectoryEvidence,
  verifyPublishedFileEvidence,
  writeExclusiveEvidenceFile
} from './m5-evidence-protocol.mjs'

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

const fileIdentity = (path) => {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.nlink !== 1n) {
    throw new Error('backup handoff did not produce one regular file')
  }
  return Object.freeze({ path, dev: stat.dev, ino: stat.ino })
}

const identityMatches = (identity) => {
  try {
    const stat = lstatSync(identity.path, { bigint: true })
    return stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino
  } catch {
    return false
  }
}

const removeOwnedFile = (identity) => {
  if (!identityMatches(identity)) return false
  unlinkSync(identity.path)
  return true
}

const createPrivateBackupDirectory = (parent) => {
  let path = null
  let identity = null
  try {
    path = mkdtempSync(resolve(parent, '.meal-agent-backup-'))
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isDirectory()) throw new Error('invalid private backup directory')
    identity = Object.freeze({ path, dev: stat.dev, ino: stat.ino })
    chmodSync(path, 0o700)
    return { path, identity }
  } catch {
    if (path !== null && identity !== null) {
      try {
        const current = lstatSync(path, { bigint: true })
        if (current.dev === identity.dev && current.ino === identity.ino) {
          rmSync(path, { recursive: true, force: true })
        }
      } catch {
        // 固定 setup 失败覆盖底层文本；路径残留由调用方/信号 scope 继续阻断。
      }
    }
    throw new Error('the private backup directory could not be created safely')
  }
}

export const writeChecksumSidecarNoReplace = (
  path,
  content,
  ownedIdentities = null,
  { write = writeFileSync, remove = removeOwnedFile } = {}
) => {
  let descriptor = null
  let identity = null
  let failed = false
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    )
    const stat = fstatSync(descriptor, { bigint: true })
    identity = Object.freeze({ path, dev: stat.dev, ino: stat.ino })
    ownedIdentities?.push(identity)
    write(descriptor, content)
  } catch {
    failed = true
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        failed = true
      }
    }
  }
  if (failed) {
    if (identity !== null) {
      try {
        remove(identity)
      } catch {
        // 固定错误覆盖所有外部细节；残留由调用方的路径存在性复查继续阻断。
      }
    }
    throw new Error('the backup checksum sidecar could not be created exclusively')
  }
  return identity
}

export const promoteBackupNoReplace = (
  stagingPath,
  publishedPath,
  { afterSourceCheck = null } = {}
) => {
  const stagingIdentity = fileIdentity(stagingPath)
  chmodSync(stagingPath, 0o600)
  if (!identityMatches(stagingIdentity)) {
    throw new Error('the backup handoff inode changed before promotion')
  }
  afterSourceCheck?.()
  try {
    linkSync(stagingPath, publishedPath)
  } catch {
    throw new Error('the backup output path appeared during no-replace promotion')
  }
  let publishedIdentity = null
  try {
    const linkedStat = lstatSync(publishedPath, { bigint: true })
    if (
      !linkedStat.isFile() ||
      linkedStat.dev !== stagingIdentity.dev ||
      linkedStat.ino !== stagingIdentity.ino ||
      !identityMatches(stagingIdentity)
    ) {
      throw new Error('the backup handoff inode changed during promotion')
    }
    // 只有证明 published 名仍指向**创建 link 前登记的 staging inode**之后，
    // 才能取得删除所有权。若名字在 link→lstat 窗口被外部替换，linkedStat
    // 不匹配，publishedIdentity 继续为 null，catch 绝不会删除替换物。
    publishedIdentity = Object.freeze({
      path: publishedPath,
      dev: stagingIdentity.dev,
      ino: stagingIdentity.ino
    })
    // 外部并发者若在 promotion 前给 staging inode 增加 hardlink，nlink 会是 3+
    // 而不是 2。先登记刚证明属于本轮 inode 的 published 名，再拒绝；catch 才能
    // 安全撤销我们创建的 link，而不会把正式路径遗留在失败结果里。
    if (linkedStat.nlink !== 2n) {
      throw new Error('the backup handoff link count drifted during promotion')
    }
    unlinkSync(stagingPath)
    const finalStat = lstatSync(publishedPath, { bigint: true })
    if (
      !finalStat.isFile() ||
      finalStat.nlink !== 1n ||
      finalStat.dev !== publishedIdentity.dev ||
      finalStat.ino !== publishedIdentity.ino
    ) {
      throw new Error('the published backup inode changed after promotion')
    }
    return publishedIdentity
  } catch (error) {
    // 只撤销**已经证明属于本轮 staging inode**的 published link。link 成功并不
    // 自动赋予路径名所有权；名字可能在紧随其后的 lstat 前被外部替换。
    if (
      publishedIdentity !== null &&
      existsSync(publishedPath) &&
      identityMatches(publishedIdentity)
    ) {
      removeOwnedFile(publishedIdentity)
    }
    throw error
  }
}

/**
 * 将要写入的**具体文件路径**必须在仓库之外，或被 Git 忽略。判据必须落在
 * 文件路径而不是目录本身：嵌套 `.gitignore` 的 `*` 只作用于目录**内部**的
 * 条目，目录自身并不被忽略——查目录会把合法的默认 `backups/` 误判成
 * 「未忽略」（残留审计实调复现）。`git check-ignore` 退出 1 表示「没有被
 * 忽略」，那是拒绝备份的理由；其余非零是工具失败，同样拒绝（无法判定不
 * 等于可以写）。
 */
export const assertBackupTargetsIgnored = async (run, paths) => {
  assertCanonicalGitRepositoryView(repositoryRoot, process.env)
  const physicalRepositoryRoot = realpathSync(repositoryRoot)
  for (const target of paths) {
    const absoluteTarget = resolve(target)
    const missingTail = []
    let existingAncestor = absoluteTarget
    while (!existsSync(existingAncestor)) {
      missingTail.unshift(basename(existingAncestor))
      const parent = resolve(existingAncestor, '..')
      if (parent === existingAncestor) {
        throw new Error('cannot resolve the physical backup target boundary')
      }
      existingAncestor = parent
    }
    const physicalTarget = resolve(realpathSync(existingAncestor), ...missingTail)
    const relativePath = relative(physicalRepositoryRoot, physicalTarget)
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      continue
    }
    const check = await run(
      ['git', '--no-replace-objects', 'check-ignore', '-q', '--', physicalTarget],
      {
      cwd: repositoryRoot
      }
    )
    if (check.status === 0) {
      continue
    }
    if (check.status === 1) {
      throw new Error(
        `refusing to write backup artifact ${physicalTarget}: the path is inside the ` +
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
  { compose, run, log, registerCleanup = null },
  { project, outputDirectory, fileName = null }
) => {
  const directory = resolve(outputDirectory)
  const name =
    fileName ?? `${project}-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.dump$/.test(name)) {
    throw new Error('the backup file name must be a plain *.dump basename')
  }
  const dumpPath = resolve(directory, name)
  const shaPath = `${dumpPath}.sha256`
  const partial = `${name}.partial`
  await assertBackupTargetsIgnored(run, [dumpPath, shaPath])
  mkdirSync(directory, { recursive: true })
  const outputDirectoryIdentity = snapshotDirectoryEvidence(directory, {
    code: 'backup-output-directory'
  })
  if (existsSync(dumpPath) || existsSync(shaPath)) {
    throw new Error('the backup output path already exists')
  }

  // partial 位于本轮独占的 0700 目录内；docker cp 完成后先验证普通文件身份，
  // 再以 link(2) 做 no-replace promotion。rename 会覆盖竞态中出现的外部文件，
  // 不能承担发布边界。
  const privateDirectory = createPrivateBackupDirectory(directory)
  const partialDirectory = privateDirectory.path
  const partialDirectoryIdentity = privateDirectory.identity
  const hostPartial = resolve(partialDirectory, partial)
  let publishedIdentity = null
  let publishedSidecarIdentity = null
  let publishedDumpBytes = null
  let publishedSidecarBytes = null
  const sidecarOwnedIdentities = []
  let completed = false
  let cleanupChain = Promise.resolve()
  let transientCleanupChain = Promise.resolve()
  let partialDirectoryRetired = false
  const cleanupTransientArtifacts = () => {
    const next = transientCleanupChain.then(async () => {
      const residue = []
      try {
        if (partialDirectoryRetired) {
          // An idempotent cleanup call after a proven removal has no new work.
        } else {
          const current = lstatSync(partialDirectory, { bigint: true })
          if (
            !current.isDirectory() ||
            current.dev !== partialDirectoryIdentity.dev ||
            current.ino !== partialDirectoryIdentity.ino
          ) {
            residue.push('backup partial directory ownership drifted')
          } else {
            rmSync(partialDirectory, { recursive: true, force: true })
            partialDirectoryRetired = true
          }
        }
      } catch {
        if (!partialDirectoryRetired) {
          residue.push(
            existsSync(partialDirectory)
              ? 'backup partial directory cleanup failed'
              : 'backup partial directory identity disappeared before cleanup'
          )
        }
      }
      try {
        const cleaned = await composeRunOneOff(
          { compose, run, warn: log },
          [
            '--entrypoint',
            'bash',
            'backup-transfer-loader',
            '-euc',
            `rm -f /transfer/${partial} /transfer/${name}; test ! -e /transfer/${partial}; test ! -e /transfer/${name}`
          ],
          { timeoutMs: 120_000, project, service: 'backup-transfer-loader' }
        )
        if (cleaned.status !== 0) residue.push('backup transfer artifact cleanup failed')
      } catch {
        residue.push('backup transfer artifact cleanup failed')
      }
      return residue
    }, async () => ['backup transient cleanup sequencing failed'])
    transientCleanupChain = next.then(() => undefined, () => undefined)
    return next
  }
  const cleanupArtifacts = () => {
    const next = cleanupChain.then(async () => {
      const residue = []
      if (!completed) {
        for (const identity of [
          ...sidecarOwnedIdentities,
          publishedSidecarIdentity,
          publishedIdentity
        ]) {
          if (identity === null || !existsSync(identity.path)) continue
          try {
            if (!removeOwnedFile(identity)) residue.push('backup artifact ownership drifted')
          } catch {
            residue.push('backup artifact cleanup failed')
          }
        }
      }
      residue.push(...(await cleanupTransientArtifacts()))
      return residue
    }, async () => ['backup cleanup sequencing failed'])
    cleanupChain = next.then(() => undefined, () => undefined)
    return next
  }
  const unregisterCleanup = registerCleanup?.(cleanupArtifacts) ?? (() => false)

  log(`backup: deployment=local-test project=${project} database=${targetDatabase} (starting)`)

  // pg_dump 在一次性容器内执行：备份口令只经 /run/secrets → 容器内 pgpass
  // 流转；dump 先写 *.partial，成功后原子改名——半途而废的文件绝不顶着正式
  // 文件名存在。`--lock-wait-timeout` 让锁等待有界。
  const script = [
    'set -euo pipefail',
    'umask 077',
    `printf 'postgres:5432:${targetDatabase}:meal_agent_backup_login:%s\\n' "$(< /run/secrets/meal_agent_backup_password/value)" > /tmp/backup.pgpass`,
    'export PGPASSFILE=/tmp/backup.pgpass',
    'pg_dump --no-password --format=custom --role=meal_agent_backup' +
      ' --lock-wait-timeout=120000 --host=postgres --port=5432' +
      ` --username=meal_agent_backup_login --dbname=${targetDatabase}` +
      ` --file=/transfer/${partial}`,
    `mv /transfer/${partial} /transfer/${name}`,
    'rm -f /tmp/backup.pgpass',
    // `docker exec` cannot inspect an exited one-shot container. Emit the digest
    // before exit and bind the handoff to the already identity-checked run result.
    `sha256sum /transfer/${name}`
  ].join('\n')
  try {
    const dump = await composeRunOneOff(
      { compose, run, warn: log },
      ['--entrypoint', 'bash', 'backup', '-c', script],
      {
        timeoutMs: 600_000,
        project,
        service: 'backup',
        beforeRemove: async ({ id, result }) => {
          const digestMatch =
            result.status === 0 && typeof result.stdout === 'string'
              ? new RegExp(
                  `^([0-9a-f]{64})[ \\t]+\\*?\\/transfer\\/${name.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&'
                  )}\\n?$`
                ).exec(result.stdout)
              : null
          if (digestMatch === null) {
            throw new Error('backup source digest evidence failed')
          }
          const copied = await run(['docker', 'cp', `${id}:/transfer/${name}`, hostPartial], {
            timeoutMs: 300_000
          })
          if (copied.status !== 0) {
            throw new Error('backup handoff failed')
          }
          if (sha256OfFile(hostPartial) !== digestMatch[1]) {
            throw new Error('backup handoff bytes differed from the container source')
          }
          // Take the one stable snapshot *before* the asynchronous TOC check.  Both
          // pg_restore and formal publication consume these exact bytes; the mutable
          // path is never reopened after the await.
          const source = readStableRegularFile(hostPartial, {
            code: 'backup-source-evidence'
          })
          if (source.identity.sha256 !== digestMatch[1]) {
            throw new Error('backup handoff bytes differed from the container source')
          }
          log('backup evidence: immutable source snapshot acquired')
          const listed = await run(['pg_restore', '--create', '--list'], {
            timeoutMs: 120_000,
            cwd: repositoryRoot,
            stdin: source.bytes
          })
          if (listed.status !== 0) {
            throw new Error('the backup archive structure could not be validated')
          }
          try {
            parsePgRestoreListEvidence(listed.stdout)
          } catch {
            throw new Error('the backup archive structure could not be validated')
          }
          log('backup evidence: complete custom-archive TOC validated')

          if (!directoryEvidenceStillNames(outputDirectoryIdentity)) {
            throw new Error('the backup output directory ownership drifted before publication')
          }
          publishedDumpBytes = source.bytes
          if (
            publishedDumpBytes.subarray(0, customFormatMagic.length).toString('latin1') !==
            customFormatMagic
          ) {
            throw new Error('the produced file does not carry the custom-format magic; refusing to checksum it')
          }
          const sha256 = sha256Bytes(publishedDumpBytes)
          publishedSidecarBytes = Buffer.from(`${sha256}  ${name}\n`, 'utf8')

          // Reserve and publish the sidecar first.  A competing sidecar therefore fails
          // before the sensitive formal dump name is ever created.
          publishedSidecarIdentity = writeExclusiveEvidenceFile(
            shaPath,
            publishedSidecarBytes,
            { code: 'backup-sidecar-publish' }
          )
          if (
            !directoryEvidenceStillNames(outputDirectoryIdentity) ||
            !verifyPublishedFileEvidence(publishedSidecarIdentity, publishedSidecarBytes)
          ) {
            throw new Error('the backup output directory ownership drifted before publication')
          }
          log('backup evidence: checksum sidecar published with no-replace semantics')
          publishedIdentity = writeExclusiveEvidenceFile(dumpPath, publishedDumpBytes, {
            code: 'backup-dump-publish'
          })
          log('backup evidence: dump published from the validated byte snapshot')
        }
      }
    )
    if (dump.status !== 0) {
      throw new Error('pg_dump failed')
    }

    if (publishedDumpBytes === null) {
      throw new Error('the backup handoff did not publish verified bytes')
    }
    const sha256 = sha256Bytes(publishedDumpBytes)
    if (publishedSidecarBytes === null || publishedSidecarIdentity === null) {
      throw new Error('the backup handoff did not publish verified checksum evidence')
    }

    // 成功返回前最后一次核对两个正式名字仍指向本轮登记的 inode。hash 计算与
    // sidecar 发布之后的路径替换不得被误记为一次成功备份。
    if (
      publishedIdentity === null ||
      !verifyPublishedFileEvidence(publishedIdentity, publishedDumpBytes) ||
      publishedSidecarIdentity === null ||
      !verifyPublishedFileEvidence(publishedSidecarIdentity, publishedSidecarBytes)
    ) {
      throw new Error('the published backup artifact ownership drifted before completion')
    }

    // 正式 artifact 的 commit 必须晚于 transfer/private transient cleanup。cleanup
    // 失败时仍处于未提交态，catch/finally 会删除本轮 dump 与 sidecar；不能返回
    // failure 却把两份敏感正式制品留在目标路径。
    const transientResidue = await cleanupTransientArtifacts()
    if (transientResidue.length > 0) {
      throw new Error('backup artifact cleanup failed')
    }
    if (
      publishedIdentity === null ||
      !verifyPublishedFileEvidence(publishedIdentity, publishedDumpBytes) ||
      publishedSidecarIdentity === null ||
      !verifyPublishedFileEvidence(publishedSidecarIdentity, publishedSidecarBytes)
    ) {
      throw new Error('the published backup artifact ownership drifted before completion')
    }
    completed = true
    log(`backup complete: deployment=local-test project=${project} database=${targetDatabase}`)
    log(`backup file: ${dumpPath}`)
    log(`backup sha256: ${sha256}`)
    return { dumpPath, shaPath, sha256 }
  } catch (error) {
    // 只有仍与本轮已登记 inode 相同的正式文件才可回滚；外部替换必须保留并把
    // ownership drift 作为固定附加失败。partial 目录独立清理，不依赖 handoff
    // callback 是否正常返回。
    let ownershipDrifted = false
    for (const identity of sidecarOwnedIdentities) {
      if (!existsSync(identity.path)) continue
      try {
        ownershipDrifted = !removeOwnedFile(identity) || ownershipDrifted
      } catch {
        ownershipDrifted = true
      }
    }
    if (publishedSidecarIdentity !== null && existsSync(shaPath)) {
      try {
        ownershipDrifted = !removeOwnedFile(publishedSidecarIdentity) || ownershipDrifted
      } catch {
        ownershipDrifted = true
      }
    }
    if (publishedIdentity !== null && existsSync(dumpPath)) {
      try {
        ownershipDrifted = !removeOwnedFile(publishedIdentity) || ownershipDrifted
      } catch {
        ownershipDrifted = true
      }
    }
    if (ownershipDrifted) {
      throw new Error('backup failed and the published artifact ownership drifted')
    }
    throw error
  } finally {
    const residue = await cleanupArtifacts()
    unregisterCleanup()
    if (residue.length > 0) throw new Error('backup artifact cleanup failed')
  }
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
  const artifactCleanup = createScopedArtifactCleanup()
  // 信号 cleanup 必须收掉 daemon 侧仍在跑的一次性容器：被「取消」的 pg_dump
  // 若继续跑完，宿主上会多出一份无人知晓的导出（容器内还有 pgpass 副本）。
  installSignalHandlers(async () => [
    ...(await removeLingeringOneOffs(run)),
    ...(await artifactCleanup.run())
  ], { label: 'backup cleanup' })

  // 信号在飞时主流程不得自己 process.exit（m3b-subprocess 的让位契约，与演练
  // executeDrill 同形）：普通退出码会抢在 handler 的 lingering sweep 与重投
  // 信号之前收场，被「取消」的 pg_dump 就在 daemon 侧继续跑完。无信号时 exit
  // 前补一次同样的清扫，兑现 composeRunOneOff「留待 sweep」的警告——失败路径
  // 也不把一次性容器留在 daemon 侧；残留只打印，不改变退出码。
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
    await performBackup(
      { compose, run, log, registerCleanup: artifactCleanup.register },
      { project: defaultProjectName, outputDirectory }
    )
    await exitAfterSweepUnlessSignalled(0)
  } catch (error) {
    if (terminationSignal() !== null) {
      log(`interrupted by ${terminationSignal()}; the signal handler owns the cleanup`)
    } else {
      process.stderr.write('backup operation failed\n')
      await exitAfterSweepUnlessSignalled(1)
    }
  }
}
