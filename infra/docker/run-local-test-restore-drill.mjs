#!/usr/bin/env node
// 阶段 09A / M4：备份/恢复演练——同一 ledger 的完整 round-trip。
//
//   node infra/docker/run-local-test-restore-drill.mjs [--keep-failure]
//
// 两个每轮唯一的栈：
//
//   A（restore-a）：全新安装十步链 → 合成 sentinel（含两个家庭）→ 授权/备份
//     角色探针 → 授权面与 sentinel 快照 → `performBackup`（pg_dump 自定义格式
//     + SHA-256 sidecar，写入演练自己的临时目录）；
//   B（restore-b）：postgres → bootstrap `cluster` + `logins`（角色不在 dump
//     里）→ **反例**：篡改过的备份必须以固定理由在 pg_restore 之前被拒 →
//     `performRestore`（校验 → createdb --owner → 单事务 pg_restore）→
//     `bootstrap-acl`（containment）→ `migrate`（round-trip 补齐，应为
//     no-op）→ `bootstrap-grants` → api。
//
// 恢复后的判据（计划书 M4 第 4、5 条逐条）：ledger 与 checksum 完整且与磁盘
// 一致、`/readyz` 200、合成家庭/库存记录可授权读取、runtime 不能绕 RLS 或
// DDL、database owner 为 meal_agent_migrator 且全部 owner / SECURITY DEFINER /
// GRANT / RLS / policy / 角色属性 / membership 与备份前逐字一致、sentinel 五张
// 表逐行 JSON 一致（两个家庭都在——FORCE RLS 没有截断导出）。
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { performBackup, retirePrivateBackupDirectory } from './backup-local-test.mjs'
import {
  appRoleDumpRefusalExpectations,
  appRoleDumpRefusalScript,
  authorizedReadExpectations,
  authorizedReadScript,
  backupRoleExpectations,
  backupRoleScript,
  executeDrill,
  expectedLedgerFromDisk,
  parseDrillArguments,
  runFreshInstallChain,
  authorizationSnapshotStatements,
  sentinelInsertStatements,
  sentinelSnapshotStatements
} from './m4-lifecycle.mjs'
import { checksumMismatchReason, performRestore } from './restore-local-test.mjs'

/** 快照差异的诊断（等值判据是整串相等；这里只为失败时的可读性）。 */
const snapshotDiff = (before, after) => {
  const beforeLines = before.split('\n').filter(Boolean)
  const afterLines = after.split('\n').filter(Boolean)
  const beforeSet = new Set(beforeLines)
  const afterSet = new Set(afterLines)
  return {
    onlyBefore: beforeLines.filter((line) => !afterSet.has(line)),
    onlyAfter: afterLines.filter((line) => !beforeSet.has(line))
  }
}

const drillBody = async ({
  stacks,
  log,
  fail,
  timed,
  buildImage,
  run,
  registerArtifactCleanup
}) => {
  const [stackA, stackB] = stacks

  await stackA.assignHostPort()
  await stackB.assignHostPort()
  await timed('build api image', () => buildImage(stackA))

  // --- 栈 A：全新安装 + sentinel + 备份前证据 -------------------------------
  await timed('stack A fresh install chain', () => runFreshInstallChain(stackA, log))
  const expectHttp = async (stack, label, path) => {
    const status = await stack.fetchStatus(path)
    if (status !== 200) {
      fail(`${label} ${path} returned ${String(status)}, expected 200`)
    } else {
      log(`${label} ${path}: 200`)
    }
  }
  await expectHttp(stackA, 'stack A', '/readyz')

  await timed('sentinel data (two synthetic households)', async () => {
    await stackA.adminSql(sentinelInsertStatements())
    log('sentinel: two synthetic households with memberships, lots and events inserted')
  })
  await stackA.expectProbe(
    'stack A authorized read (pre-backup)',
    authorizedReadScript(),
    authorizedReadExpectations
  )
  await stackA.expectProbe(
    'stack A backup role (pre-backup)',
    backupRoleScript(),
    backupRoleExpectations
  )
  await stackA.expectProbe(
    'stack A app-role dump refusal (fails loudly instead of truncating)',
    appRoleDumpRefusalScript(),
    appRoleDumpRefusalExpectations,
    { timeoutMs: 300_000 }
  )

  // --- 备份（演练自己的临时目录；dump 内容是合成数据，不是凭据）-------------
  const backupsDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m4-backup-'))
  const backupDirectoryStat = lstatSync(backupsDirectory, { bigint: true })
  const backupDirectoryIdentity = Object.freeze({
    path: backupsDirectory,
    dev: backupDirectoryStat.dev,
    ino: backupDirectoryStat.ino
  })
  const backupFileIdentities = []
  let backupDirectoryCleanupPromise = null
  const cleanupBackupDirectory = () => {
    backupDirectoryCleanupPromise ??= Promise.resolve().then(() => {
      try {
        return retirePrivateBackupDirectory(backupDirectoryIdentity, backupFileIdentities)
      } catch {
        return ['restore drill backup directory cleanup failed']
      }
    })
    return backupDirectoryCleanupPromise
  }
  const unregisterBackupDirectory = registerArtifactCleanup(cleanupBackupDirectory)
  try {
    await restoreRoundTrip({
      stacks,
      log,
      fail,
      timed,
      run,
      backupsDirectory,
      backupFileIdentities,
      registerArtifactCleanup
    })
  } finally {
    // 正常、失败、信号三条路径都不把演练备份留在盘上。
    const residue = await cleanupBackupDirectory()
    unregisterBackupDirectory()
    if (residue.length > 0) throw new Error('restore drill backup directory cleanup failed')
    log('drill backup directory removed')
  }
}

const restoreRoundTrip = async ({
  stacks,
  log,
  fail,
  timed,
  run,
  backupsDirectory,
  backupFileIdentities,
  registerArtifactCleanup
}) => {
  const [stackA, stackB] = stacks
  const captureBackupFile = (path) => {
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new Error('restore drill artifact identity was invalid')
    }
    backupFileIdentities.push(Object.freeze({ path, dev: stat.dev, ino: stat.ino }))
  }
  const expectHttp = async (stack, label, path) => {
    const status = await stack.fetchStatus(path)
    if (status !== 200) {
      fail(`${label} ${path} returned ${String(status)}, expected 200`)
    } else {
      log(`${label} ${path}: 200`)
    }
  }
  let authorizationBefore = null
  let sentinelBefore = null
  await timed('pre-backup snapshots', async () => {
    authorizationBefore = await stackA.adminSql(authorizationSnapshotStatements(), {
      timeoutMs: 300_000
    })
    sentinelBefore = await stackA.adminSql(sentinelSnapshotStatements())
    log('pre-backup snapshots captured (authorization surface + sentinel rows)')
  })

  let backup = null
  await timed('pg_dump custom-format backup + sha256 sidecar', async () => {
    backup = await performBackup(
      {
        compose: stackA.compose,
        run,
        log,
        registerCleanup: registerArtifactCleanup
      },
      { project: stackA.project, outputDirectory: backupsDirectory, fileName: 'restore-drill.dump' }
    )
  })
  captureBackupFile(backup.dumpPath)
  captureBackupFile(backup.shaPath)

  // --- 栈 B：cluster/logins（角色不在 dump 里）------------------------------
  await timed('stack B cluster bootstrap (roles are not in the dump)', async () => {
    await stackB.runOneShotExpectZero('secret-materializer', 300_000)
    log('stack B secret-materializer: exit=0')
    await stackB.runService('postgres', 240_000)
    log('stack B postgres: healthy (fresh named volume)')
    await stackB.runOneShotExpectZero('bootstrap-cluster', 300_000)
    await stackB.runOneShotExpectZero('bootstrap-logins', 300_000)
    log('stack B bootstrap cluster + logins: exit=0')
  })

  // --- 反例：篡改过的备份必须在 pg_restore 之前被拒 -------------------------
  await timed('negative: a tampered backup is refused before pg_restore', async () => {
    const corruptedPath = resolve(backupsDirectory, 'tampered.dump')
    copyFileSync(backup.dumpPath, corruptedPath)
    // 翻转正文中间的一个字节（避开魔数），并给它配一个**原始**摘要的 sidecar：
    // 这正是「备份在落盘后被改动」的形态。
    const body = readFileSync(corruptedPath)
    const flipAt = Math.floor(body.length / 2)
    body[flipAt] = body[flipAt] ^ 0xff
    writeFileSync(corruptedPath, body)
    writeFileSync(`${corruptedPath}.sha256`, `${backup.sha256}  ${basename(corruptedPath)}\n`, {
      mode: 0o600
    })
    captureBackupFile(corruptedPath)
    captureBackupFile(`${corruptedPath}.sha256`)
    let refusedForChecksum = false
    try {
      await performRestore(
        { compose: stackB.compose, run, log },
        { project: stackB.project, dumpPath: corruptedPath }
      )
    } catch (error) {
      // Compare only against this module's fixed diagnostic. Never retain or
      // forward a runner-controlled exception value into drill output.
      refusedForChecksum =
        error instanceof Error && error.message === checksumMismatchReason
    }
    if (!refusedForChecksum) {
      fail('the tampered backup was restored instead of being refused')
    } else {
      log('tampered backup refused with the fixed checksum reason, before any restore step')
    }
    const present = await stackB.adminSql(
      ["SELECT count(*) FROM pg_database WHERE datname = 'meal_agent'"],
      { dbname: 'postgres' }
    )
    if (present.trim() !== '0') {
      fail('the refused restore still left a meal_agent database behind')
    } else {
      log('after the refusal the target database is still absent')
    }
  })

  // --- 真实恢复：校验 → createdb --owner → 单事务 pg_restore ----------------
  await timed('restore into stack B (single transaction)', async () => {
    await performRestore(
      {
        compose: stackB.compose,
        run,
        log,
        registerCleanup: registerArtifactCleanup
      },
      { project: stackB.project, dumpPath: backup.dumpPath }
    )
  })

  // --- 恢复路径其余阶段：acl → migrate（no-op 补齐）→ grants → api ---------
  await timed('stack B acl -> migrate -> grants -> api', async () => {
    await stackB.runOneShotExpectZero('bootstrap-acl', 300_000)
    log('stack B bootstrap-acl (containment phase): exit=0 against the restored database')
    await stackB.runOneShotExpectZero('migrate', 660_000)
    log('stack B migrate: exit=0 (same-ledger round trip; nothing to apply)')
    await stackB.runOneShotExpectZero('bootstrap-grants', 300_000)
    log('stack B bootstrap-grants (final phase): exit=0')
    await stackB.runService('api', 180_000)
    log('stack B api: healthy against the restored database')
  })

  // --- 恢复后的逐条判据 -----------------------------------------------------
  await expectHttp(stackB, 'stack B (restored)', '/healthz')
  await expectHttp(stackB, 'stack B (restored)', '/readyz')

  const expectedLedger = expectedLedgerFromDisk()
  const ledgerAfter = (
    await stackB.adminSql([
      'SELECT name || \':\' || hash FROM drizzle.__meal_agent_migrations ORDER BY name COLLATE "C"'
    ])
  )
    .split('\n')
    .filter(Boolean)
  if (JSON.stringify(ledgerAfter) !== JSON.stringify(expectedLedger)) {
    fail('restored ledger drifted from the frozen migrations on disk (names, hashes or order)')
  } else {
    log('restored ledger: entries and checksums match the frozen migrations on disk (round trip)')
  }

  await stackB.expectProbe(
    'stack B authorized read (post-restore)',
    authorizedReadScript(),
    authorizedReadExpectations
  )
  await stackB.expectProbe(
    'stack B backup role (post-restore; both households present, FORCE RLS did not truncate)',
    backupRoleScript(),
    backupRoleExpectations
  )

  await timed('post-restore snapshots and comparison', async () => {
    const authorizationAfter = await stackB.adminSql(authorizationSnapshotStatements(), {
      timeoutMs: 300_000
    })
    const sentinelAfter = await stackB.adminSql(sentinelSnapshotStatements())
    if (authorizationAfter === authorizationBefore) {
      log(
        'authorization surface: owners, SECURITY DEFINER, GRANTs, RLS/policies, ' +
          'role attributes and memberships are byte-identical to the pre-backup snapshot'
      )
    } else {
      const diff = snapshotDiff(authorizationBefore, authorizationAfter)
      fail(
        `authorization surface drifted across the restore: ` +
          `${String(diff.onlyBefore.length)} line(s) only before, ` +
          `${String(diff.onlyAfter.length)} line(s) only after`
      )
    }
    if (sentinelAfter === sentinelBefore) {
      log('sentinel rows: all five tables byte-identical across the round trip (both households)')
    } else {
      const diff = snapshotDiff(sentinelBefore, sentinelAfter)
      fail(
        `sentinel rows drifted across the restore: ` +
          `${String(diff.onlyBefore.length)} line(s) only before, ` +
          `${String(diff.onlyAfter.length)} line(s) only after`
      )
    }
  })

}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { keepFailure } = parseDrillArguments('run-local-test-restore-drill.mjs [--keep-failure]')
  await executeDrill({
    kind: 'restore',
    title: 'local-test backup/restore drill',
    stackSuffixes: ['restore-a', 'restore-b'],
    keepFailure,
    body: drillBody
  })
}
