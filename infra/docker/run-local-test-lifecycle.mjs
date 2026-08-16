#!/usr/bin/env node
// 阶段 09A / M4：生命周期演练——构建 → 空 volume 初始化 → migration → 启动 →
// 健康检查 → 合成数据 → 停止/重启数据仍在 → down/再起数据仍在 → 销毁归零。
//
//   node infra/docker/run-local-test-lifecycle.mjs [--keep-failure]
//
// 它是计划书 M4 第 1 条「明确命令」的自动化对应物（逐条命令见 runbook：
// docs/operations/stage-09a-local-test-lifecycle.md），并顺带取得两条 DoD 7
// 相关的容器侧证据：
//
//   - `compose stop` 的 SIGTERM 让 api 容器以 exit 0 优雅退出（真实耗时打印）；
//   - 强制退出分支的证据在 services/api 的 subprocess 回归里，不在这里。
//
// 每轮唯一 project + image tag + 合成 Secret；正常/失败/信号三条路径共用同一
// 套 scoped cleanup 与 residue 复查；输出不含任何 Secret 取值。
import { fileURLToPath } from 'node:url'

import {
  authorizedReadExpectations,
  authorizedReadScript,
  executeDrill,
  expectedLedgerFromDisk,
  assertGracefulStopTransition,
  parseDrillArguments,
  readContainerRuntimeState,
  runFreshInstallChain,
  sentinelInsertStatements,
  sentinelSnapshotStatements
} from './m4-lifecycle.mjs'

const drillBody = async ({ stacks, log, fail, timed, buildImage, run }) => {
  const [stack] = stacks

  await stack.assignHostPort()
  await timed('build api image', () => buildImage(stack))

  await timed('fresh install chain from an empty volume', () => runFreshInstallChain(stack, log))

  const expectHttp = async (path) => {
    const status = await stack.fetchStatus(path)
    if (status !== 200) {
      fail(`${path} returned ${String(status)}, expected 200`)
    } else {
      log(`${path}: 200`)
    }
  }
  await expectHttp('/healthz')
  await expectHttp('/readyz')

  let sentinelBaseline = null
  await timed('sentinel data (synthetic households)', async () => {
    await stack.adminSql(sentinelInsertStatements())
    sentinelBaseline = await stack.adminSql(sentinelSnapshotStatements())
    log('sentinel: synthetic households, memberships, lots and events inserted')
  })
  await stack.expectProbe(
    'authorized read (before any restart)',
    authorizedReadScript(),
    authorizedReadExpectations
  )

  const expectSentinelIntact = async (label) => {
    const now = await stack.adminSql(sentinelSnapshotStatements())
    if (now !== sentinelBaseline) {
      fail(`${label}: the sentinel rows drifted across the restart`)
    } else {
      log(`${label}: sentinel rows are byte-identical`)
    }
  }

  // --- 停止并重启：数据仍在 -------------------------------------------------
  await timed('graceful stop (SIGTERM path)', async () => {
    const apiName = stack.containerName('api')
    const startedApi = stack.getServiceEvidence('api')
    if (startedApi === null) {
      throw new Error('the API service has no recorded immutable start evidence')
    }
    const beforeStop = await readContainerRuntimeState(
      apiName,
      stack.composeEnvironment,
      startedApi
    )
    const stopStart = performance.now()
    // 30 秒宽限：留给 shutdown.ts 的 10 秒强制退出分支充分表达自己——若容器
    // 是被 compose 的 SIGKILL 收走的，退出码会是 137 而不是 0/1。
    const stopped = await stack.compose(['stop', '--timeout', '30', 'api'], {
      timeoutMs: 120_000
    })
    const stopMs = Math.round(performance.now() - stopStart)
    if (stopped.status !== 0) {
      fail(`compose stop api failed with exit ${String(stopped.status)}`)
      return
    }
    const afterStop = await readContainerRuntimeState(
      apiName,
      stack.composeEnvironment,
      startedApi
    )
    try {
      assertGracefulStopTransition(beforeStop, afterStop)
      const shutdownLogs = await run(['docker', 'logs', apiName], {
        env: stack.composeEnvironment,
        timeoutMs: 60_000
      })
      if (
        shutdownLogs.status !== 0 ||
        !shutdownLogs.stdout.includes('"event":"shutdown.started"') ||
        !shutdownLogs.stdout.includes('"signal":"SIGTERM"')
      ) {
        throw new Error('the owned API container did not record the SIGTERM shutdown event')
      }
      log(`api stopped gracefully on SIGTERM in ${String(stopMs)}ms (container exit code 0)`)
    } catch {
      fail('api stop did not prove a running-to-exited graceful transition')
    }
    const rest = await stack.compose(['stop', '--timeout', '30'], { timeoutMs: 300_000 })
    if (rest.status !== 0) {
      fail(`compose stop (remaining services) failed with exit ${String(rest.status)}`)
    }
  })

  await timed('restart after stop (containers kept)', async () => {
    await stack.startService('postgres', 240_000)
    await stack.startService('api', 180_000)
    await expectHttp('/readyz')
    await expectSentinelIntact('restart after stop')
  })

  // --- down（容器与网络移除，named volume 保留）后再起：数据仍在 -----------
  await timed('down without volumes, then re-up', async () => {
    await stack.downKeepingData()
    log(
      'down keeping data: containers removed with their anonymous volumes, ' +
        'networks removed, named volume kept'
    )
    await stack.runService('postgres', 240_000)
    await stack.runOneShotExpectZero('migrate', 660_000)
    log('migrate re-run against the persisted volume: exit=0 (idempotent)')
    await stack.runService('api', 180_000)
    await expectHttp('/readyz')
    await expectSentinelIntact('re-up after down')
  })
  await stack.expectProbe(
    'authorized read (after both restarts)',
    authorizedReadScript(),
    authorizedReadExpectations
  )

  // ledger 完整性（重启不动 ledger）。
  const expectedLedger = expectedLedgerFromDisk()
  const ledger = (
    await stack.adminSql([
      'SELECT name || \':\' || hash FROM drizzle.__meal_agent_migrations ORDER BY name COLLATE "C"'
    ])
  )
    .split('\n')
    .filter(Boolean)
  if (JSON.stringify(ledger) !== JSON.stringify(expectedLedger)) {
    fail('the migration ledger drifted across the lifecycle drill')
  } else {
    log('ledger: entries and hashes still match the frozen migrations on disk')
  }

  // 销毁（DoD 1 最后一步）由 executeDrill 的统一 cleanup 承担：down --volumes、
  // label sweep、image tag、临时 Secret，与独立 residue 复查。这里不重复。
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { keepFailure } = parseDrillArguments('run-local-test-lifecycle.mjs [--keep-failure]')
  await executeDrill({
    kind: 'lifecycle',
    title: 'local-test lifecycle drill',
    stackSuffixes: ['lifecycle'],
    keepFailure,
    body: drillBody
  })
}
