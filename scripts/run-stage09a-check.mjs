#!/usr/bin/env node
//
// 阶段 09A / M5：`pnpm stage09a:check` —— 阶段级聚合门禁。
//
//   pnpm stage09a:check                    # 完整链
//   pnpm stage09a:check -- --keep-failure  # 失败时保留支持该开关的门禁现场
//
// 本命令**只做串联**，不实现任何新检查：每一步都是仓库里已存在的独立门禁/演练
// 入口，逐条按计划文档「### M5」的链路顺序执行（stage08 → Dockerfile/Compose
// 静态检查 → 镜像构建与依赖扫描 → M3B 门禁面 → 空库全链 smoke → Secret 身份
// 探针 → 持久化重启演练 → 备份恢复演练）。九条 M3B 门禁全部在链内，相互之间
// 保持 infra/docker/README.md 门禁表的既有顺序。
//
// 纪律（计划文档 M5 第 1、2 项）：
//   - fail fast：任一步骤失败即停止后续步骤，逐步状态在结尾汇总表如实列出；
//   - 失败诊断：子门禁的输出原样透传（它们各自负责脱敏），本脚本自身只打印
//     固定文案、argv 与耗时，不回显环境变量，也不注入任何环境；
//   - 清理：每个动态门禁/演练自带 scoped cleanup 与零残留复查，成功失败都清理
//     本轮 container/network/volume/image tag；`--keep-failure` 逐层透传给支持
//     它的入口，显式 opt-in 才保留失败现场；
//   - 前置工具（验收门禁 #11）：Docker CLI / Compose v2 / daemon / git / pnpm
//     任一缺失时，本命令在执行任何检查之前明确失败为「缺少前置工具」，绝不
//     降级成部分静态检查后宣称通过。
//
// 每步有一个宽松的兜底超时（子门禁内部各有更紧的有界约束）：超时先 SIGTERM
// 留给子门禁做自己的清理，宽限后 SIGKILL，一律判失败。
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const stepController = resolve(repositoryRoot, 'scripts/stage09a-step-controller.mjs')
const usage = 'pnpm stage09a:check [-- --keep-failure]'

const cliArguments = process.argv.slice(2)
const keepFailure = cliArguments.includes('--keep-failure')
if (cliArguments.some((argument) => argument !== '--keep-failure')) {
  process.stderr.write(`usage: ${usage}\n`)
  process.exit(2)
}

// argv 是固定字符串；`--keep-failure` 只透传给声明支持它的入口。
const steps = [
  {
    id: 'stage08-check',
    title: 'stage08 全量门禁（workspace 语义不因容器化改变）',
    argv: ['pnpm', 'stage08:check'],
    timeoutMs: 2_400_000
  },
  {
    id: 'compose-topology',
    title: 'Compose 解析后拓扑静态门禁',
    argv: ['node', 'infra/docker/check-compose-topology.mjs'],
    timeoutMs: 900_000
  },
  {
    id: 'compose-topology-mutations',
    title: 'Compose 拓扑门禁的变异反例',
    argv: ['node', 'infra/docker/check-compose-topology-mutations.mjs'],
    timeoutMs: 900_000
  },
  {
    id: 'api-runtime-image',
    title: 'API runtime image 构建 + 依赖/组件扫描',
    argv: ['node', 'infra/docker/check-api-runtime-image.mjs'],
    timeoutMs: 1_800_000,
    forwardsKeepFailure: true
  },
  {
    id: 'api-runtime-image-mutations',
    title: '镜像扫描门禁的变异反例',
    argv: ['node', 'infra/docker/check-api-runtime-image-mutations.mjs'],
    timeoutMs: 2_700_000
  },
  {
    id: 'local-test-negatives',
    title: 'Secret 生成/预检/模板扫描反例面',
    argv: ['node', 'infra/docker/check-local-test-negatives.mjs'],
    timeoutMs: 1_800_000
  },
  {
    id: 'm3b-template-surface-sweep',
    title: 'tracked 模板绝对面普查',
    argv: ['node', 'infra/docker/check-m3b-template-surface-sweep.mjs'],
    timeoutMs: 900_000
  },
  {
    id: 'm3b-round2-negatives',
    title: 'M3B targeted negative suite',
    argv: ['node', 'infra/docker/check-m3b-round2-negatives.mjs'],
    timeoutMs: 2_700_000
  },
  {
    id: 'm3b-registry-integrity',
    title: '登记完整性（文档计数 ↔ 已提交数据）',
    argv: ['node', 'infra/docker/check-m3b-registry-integrity.mjs'],
    timeoutMs: 900_000
  },
  {
    id: 'm3b-signal-windows',
    title: '进程组回归 + 真实信号窗口取证',
    argv: ['node', 'infra/docker/check-m3b-signal-windows.mjs'],
    timeoutMs: 1_800_000
  },
  {
    id: 'local-test-smoke',
    title: '空 volume 完整链 smoke（含 containment 扫描与隔离）',
    argv: ['node', 'infra/docker/run-local-test-smoke.mjs'],
    timeoutMs: 2_700_000,
    forwardsKeepFailure: true
  },
  {
    id: 'compose-secret-identity',
    title: 'Compose Secret 容器内 UID/mode 证据',
    argv: ['node', 'infra/docker/probe-compose-secret-identity.mjs'],
    timeoutMs: 1_800_000
  },
  {
    id: 'lifecycle-drill',
    title: '生命周期演练（空库初始化、health/readiness、持久化重启）',
    argv: ['node', 'infra/docker/run-local-test-lifecycle.mjs'],
    timeoutMs: 2_700_000,
    forwardsKeepFailure: true
  },
  {
    id: 'restore-drill',
    title: '备份/恢复演练(备份、篡改反例、单事务恢复、授权面一致)',
    argv: ['node', 'infra/docker/run-local-test-restore-drill.mjs'],
    timeoutMs: 2_700_000,
    forwardsKeepFailure: true
  }
]

const results = []
let interruptedBy = null
let signalCleanupPromise = null
const interruptionWaiters = new Set()
const cooperativeShutdowns = new Set()
const ownedProcessGroups = new Set()
const nativeKill = process.kill.bind(process)
const cooperativeShutdownBudgetMs = 310_000

const processGroupIsAlive = (pgid) => {
  try {
    nativeKill(-pgid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

const purgeGoneProcessGroups = () => {
  for (const pgid of ownedProcessGroups) {
    if (!processGroupIsAlive(pgid)) {
      ownedProcessGroups.delete(pgid)
    }
  }
}

const signalOwnedGroup = (pgid, signal) => {
  try {
    nativeKill(-pgid, signal)
    return true
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

const waitForOwnedGroups = async (budgetMs) => {
  const deadline = performance.now() + budgetMs
  do {
    purgeGoneProcessGroups()
    if (ownedProcessGroups.size === 0) {
      return true
    }
    await delay(25)
  } while (performance.now() < deadline)
  purgeGoneProcessGroups()
  return ownedProcessGroups.size === 0
}

// 聚合器不依赖子门禁的 termination abstraction 来做最后兜底：异常或永不
// settlement 时，仍能用模块加载时抓下来的原生同步 signal primitive 有界收敛。
// 连续两个空窗口才算稳定，以覆盖 scoped cleanup 刚派生并通过 fd 3 登记的新组。
const terminateOwnedProcessGroups = async () => {
  let primitiveFailed = false
  let stablePasses = 0
  for (let sweep = 0; sweep < 8; sweep += 1) {
    purgeGoneProcessGroups()
    const snapshot = [...ownedProcessGroups]
    if (snapshot.length === 0) {
      stablePasses += 1
      if (stablePasses >= 2) {
        return { ok: !primitiveFailed, survivors: [] }
      }
      await delay(25)
      continue
    }
    stablePasses = 0
    for (const pgid of snapshot) {
      if (!signalOwnedGroup(pgid, 'SIGTERM')) {
        primitiveFailed = true
      }
    }
    await waitForOwnedGroups(500)
    for (const pgid of [...ownedProcessGroups]) {
      if (!signalOwnedGroup(pgid, 'SIGKILL')) {
        primitiveFailed = true
      }
    }
    await waitForOwnedGroups(3_000)
  }
  purgeGoneProcessGroups()
  return { ok: !primitiveFailed && ownedProcessGroups.size === 0, survivors: [...ownedProcessGroups] }
}

const requestCooperativeShutdown = async () => {
  const attempts = [...cooperativeShutdowns].map((shutdown) =>
    Promise.resolve()
      .then(() => shutdown(interruptedBy ?? 'SIGTERM'))
      .catch(() => undefined)
  )
  // 子门禁的 scoped cleanup（尤其 Docker/restore）本身有最长 300 秒的有界
  // residue 复查。聚合器必须等到 child 真正 close，才能把 cleanup 记为完成；
  // 不能用一个比内层预算更短的墙钟抢先 KILL 后宣称已经清理。
  const results = await Promise.race([
    Promise.all(attempts),
    delay(cooperativeShutdownBudgetMs, undefined, { ref: false }).then(() => [false])
  ])
  return results.every((result) => result === true)
}

const convergeAfterSignal = () => {
  if (signalCleanupPromise === null) {
    signalCleanupPromise = (async () => {
      const cooperativeOk = await requestCooperativeShutdown()
      const cleanup = await terminateOwnedProcessGroups()
      return { ok: cooperativeOk && cleanup.ok, survivorCount: cleanup.survivors.length }
    })()
  }
  return signalCleanupPromise
}

const settleInterruptedRuns = (cleanup) => {
  for (const waiter of [...interruptionWaiters]) {
    waiter(cleanup)
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (interruptedBy !== null) {
      return
    }
    interruptedBy = signal
    process.stderr.write(`\nstage09a:check: received ${signal}; terminating the controlled process subtree\n`)
    void convergeAfterSignal().then(settleInterruptedRuns)
  })
}

const runControlled = ({ argv, timeoutMs, stdio }) =>
  new Promise((resolvePromise) => {
    let settled = false
    let timedOut = false
    let closed = false
    let leaderExited = false
    let ownershipStreamEnded = false
    let producerDone = false
    let ownershipBuffer = ''
    let ownershipProtocolFailed = false
    let scopedCleanupStarted = false
    const activeScopedCleanups = new Set()
    let resolveCleanupStarted
    const cleanupStartedPromise = new Promise((resolveStart) => {
      resolveCleanupStarted = resolveStart
    })
    const stdoutChunks = []
    const childEnvironment = {
      ...process.env,
      MEAL_AGENT_STAGE09A_PGID_FD: '3'
    }
    const childStdio =
      stdio === 'inherit'
        ? ['inherit', 'inherit', 'inherit', 'pipe']
        : [stdio[0], stdio[1], stdio[2], 'pipe']
    const child = spawn(process.execPath, [stepController, JSON.stringify(argv)], {
      cwd: repositoryRoot,
      detached: true,
      env: childEnvironment,
      stdio: childStdio
    })

    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      ownedProcessGroups.add(child.pid)
    }
    if (child.stdout !== null) {
      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    }
    const ownershipStream = child.stdio[3]
    const registerRecognizablePgid = (text) => {
      const prefix = /^([1-9][0-9]*)/.exec(text)
      if (prefix === null) {
        return
      }
      const pgid = Number(prefix[1])
      if (Number.isSafeInteger(pgid) && pgid > 0) {
        ownedProcessGroups.add(pgid)
      }
    }
    const recordOwnershipFrame = (line) => {
      const producerFrame = /^PRODUCER ([1-9][0-9]*) DONE$/.exec(line)
      if (producerFrame !== null) {
        const producerPid = Number(producerFrame[1])
        if (producerDone || producerPid !== child.pid) {
          ownershipProtocolFailed = true
          return
        }
        producerDone = true
        return
      }
      const cleanupFrame = /^CLEANUP ([1-9][0-9]*) (START|DONE)$/.exec(line)
      if (cleanupFrame !== null) {
        const cleanupOwner = Number(cleanupFrame[1])
        if (!Number.isSafeInteger(cleanupOwner) || cleanupOwner <= 0) {
          ownershipProtocolFailed = true
          return
        }
        if (cleanupFrame[2] === 'START') {
          if (activeScopedCleanups.has(cleanupOwner)) {
            ownershipProtocolFailed = true
          }
          activeScopedCleanups.add(cleanupOwner)
          scopedCleanupStarted = true
          resolveCleanupStarted()
          return
        }
        if (!activeScopedCleanups.delete(cleanupOwner)) {
          ownershipProtocolFailed = true
        }
        return
      }
      if (!/^[1-9][0-9]*$/.test(line)) {
        // 协议失败不等于放弃清理。若前缀已经足以证明一个 detached PGID，
        // 先登记它，再把整帧判坏；否则 `123 EXTRA` 会固定 exit 1 却留下 123。
        registerRecognizablePgid(line)
        ownershipProtocolFailed = true
        return
      }
      const pgid = Number(line)
      if (!Number.isSafeInteger(pgid) || pgid <= 0) {
        ownershipProtocolFailed = true
        return
      }
      ownedProcessGroups.add(pgid)
    }
    ownershipStream?.on('data', (chunk) => {
      ownershipBuffer += chunk.toString('utf8')
      while (true) {
        const newline = ownershipBuffer.indexOf('\n')
        if (newline === -1) break
        const line = ownershipBuffer.slice(0, newline)
        ownershipBuffer = ownershipBuffer.slice(newline + 1)
        if (line.length > 4096) {
          registerRecognizablePgid(line)
          ownershipProtocolFailed = true
        } else {
          recordOwnershipFrame(line)
        }
      }
      if (ownershipBuffer.length > 4096) {
        registerRecognizablePgid(ownershipBuffer)
        ownershipProtocolFailed = true
        ownershipBuffer = ''
        ownershipStream?.destroy()
      }
    })
    ownershipStream?.on('error', () => {
      ownershipProtocolFailed = true
    })
    ownershipStream?.on('end', () => {
      ownershipStreamEnded = true
      if (ownershipBuffer.length > 0) {
        // 缺少终止 LF 时仍登记可证明的 PGID 以便收尾，但协议必须失败，
        // 所以该 step 绝不能 PASS。
        registerRecognizablePgid(ownershipBuffer)
        ownershipProtocolFailed = true
        ownershipBuffer = ''
      }
      if (!producerDone) {
        ownershipProtocolFailed = true
        void terminateOwnedProcessGroups()
      }
    })

    let resolveClosed
    let resolveLeaderExited
    const closedPromise = new Promise((resolveClose) => {
      resolveClosed = resolveClose
    })
    const leaderExitedPromise = new Promise((resolveExit) => {
      resolveLeaderExited = resolveExit
    })
    child.once('exit', () => {
      leaderExited = true
      resolveLeaderExited()
      if (ownershipBuffer.length > 0) {
        registerRecognizablePgid(ownershipBuffer)
        ownershipProtocolFailed = true
        ownershipBuffer = ''
        // fd 被未登记后代继承时，等待 EOF 会形成循环依赖。leader exit 已证明
        // 本轮 producer 不会再给出完整帧；关闭读端并按刚登记的 PGID 收敛。
        ownershipStream?.destroy()
        void terminateOwnedProcessGroups()
      }
    })
    const cooperativeShutdown = async (signal) => {
      if (!closed) {
        try {
          nativeKill(-child.pid, signal)
        } catch {
          // 最终收敛由聚合器自己的 owned-PGID fallback 保证。
        }
      }
      const first = await Promise.race([
        leaderExitedPromise.then(() => 'exit'),
        cleanupStartedPromise.then(() => 'cleanup'),
        delay(2_500, 'fallback', { ref: false })
      ])
      if (first === 'cleanup') {
        await Promise.race([
          leaderExitedPromise,
          delay(cooperativeShutdownBudgetMs, undefined, { ref: false })
        ])
      }
      if (scopedCleanupStarted && activeScopedCleanups.size > 0) {
        ownershipProtocolFailed = true
      }
      return !ownershipProtocolFailed
    }
    cooperativeShutdowns.add(cooperativeShutdown)

    const settle = (result) => {
      if (!settled) {
        settled = true
        interruptionWaiters.delete(interruptionWaiter)
        resolvePromise(result)
      }
    }
    const interruptionWaiter = (cleanup) => {
      clearTimeout(timer)
      if (!cleanup.ok) {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }
      settle({
        ok: false,
        code: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        detail: cleanup.ok ? `interrupted by ${interruptedBy}` : 'signal cleanup failed'
      })
    }
    const release = () => {
      closed = true
      cooperativeShutdowns.delete(cooperativeShutdown)
      resolveClosed()
      purgeGoneProcessGroups()
    }
    const timer = setTimeout(() => {
      if (settled || timedOut) {
        return
      }
      timedOut = true
      void (async () => {
        await cooperativeShutdown('SIGTERM')
        const cleanup = await terminateOwnedProcessGroups()
        const survivors = cleanup.survivors
        settle({
          ok: false,
          code: null,
          signal: null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          detail:
            !cleanup.ok || survivors.length > 0
              ? `timed out; ${String(survivors.length)} descendant process group(s) were not confirmed gone`
              : 'timed out'
        })
      })()
    }, timeoutMs)
    interruptionWaiters.add(interruptionWaiter)
    if (interruptedBy !== null) {
      void convergeAfterSignal().then(interruptionWaiter)
    }

    child.once('error', (error) => {
      clearTimeout(timer)
      resolveLeaderExited()
      release()
      if (settled || timedOut) {
        return
      }
      if (interruptedBy !== null) {
        void convergeAfterSignal().then((cleanup) => {
          settle({
            ok: false,
            code: null,
            signal: null,
            stdout: '',
            detail: cleanup.ok ? `interrupted by ${interruptedBy}` : 'signal cleanup failed'
          })
        })
        return
      }
      settle({
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        detail: 'failed to start'
      })
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      release()
      if (settled || timedOut) {
        return
      }
      const finish = (detail) =>
        settle({
          ok: detail === null && signal === null && code === 0,
          code,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          detail:
            detail ??
            (signal !== null ? `killed by ${signal}` : code === 0 ? 'PASS' : `exit ${String(code)}`)
        })
      if (interruptedBy !== null) {
        void convergeAfterSignal().then((cleanup) => {
          finish(cleanup.ok ? `interrupted by ${interruptedBy}` : 'signal cleanup failed')
        })
        return
      }
      if (
        ownershipStream === null ||
        (!ownershipStreamEnded && !ownershipProtocolFailed) ||
        !producerDone ||
        activeScopedCleanups.size > 0
      ) {
        ownershipProtocolFailed = true
      }
      if (ownershipProtocolFailed) {
        void (async () => {
          await terminateOwnedProcessGroups()
          finish('ownership channel failed')
        })()
        return
      }
      purgeGoneProcessGroups()
      const unexpectedGroups = [...ownedProcessGroups]
      if (unexpectedGroups.length > 0) {
        void (async () => {
          await terminateOwnedProcessGroups()
          finish(`left ${String(unexpectedGroups.length)} descendant process group(s) after exit`)
        })()
        return
      }
      finish(null)
    })
  })

const probe = async (argv, label) => {
  if (interruptedBy !== null) {
    return { ok: false, label, detail: `interrupted by ${interruptedBy}` }
  }
  const result = await runControlled({ argv, timeoutMs: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    ok: result.ok,
    label,
    detail: result.ok ? result.stdout.trim().split('\n')[0] : result.detail
  }
}

const runStep = (step) =>
  new Promise((resolvePromise) => {
    if (interruptedBy !== null) {
      resolvePromise({ ok: false, detail: `interrupted by ${interruptedBy}`, exitCode: 1, seconds: 0 })
      return
    }
    const argv = step.forwardsKeepFailure === true && keepFailure ? [...step.argv, '--keep-failure'] : step.argv
    const startedAt = performance.now()
    void runControlled({ argv, timeoutMs: step.timeoutMs, stdio: 'inherit' }).then((result) => {
      const seconds = Math.round((performance.now() - startedAt) / 1000)
      resolvePromise({
        ok: result.ok,
        detail: result.detail,
        exitCode: result.ok ? 0 : result.code === null || result.code === 0 ? 1 : result.code,
        seconds
      })
    })
  })

const printSummary = () => {
  process.stdout.write('\nstage09a:check summary:\n')
  for (const [index, step] of steps.entries()) {
    const result = results[index]
    if (result === undefined) {
      process.stdout.write(`  SKIP ${step.id}\n`)
      continue
    }
    const status = result.ok ? 'PASS' : 'FAIL'
    process.stdout.write(`  ${status} ${step.id} (${String(result.seconds)}s${result.ok ? '' : `, ${result.detail}`})\n`)
  }
}

const main = async () => {
  // ---- 前置工具 ----
  const probes = []
  for (const [argv, label] of [
    [['docker', 'version', '--format', '{{.Server.Version}}'], 'Docker daemon'],
    [['docker', 'compose', 'version', '--short'], 'Docker Compose v2'],
    [['git', '--version'], 'git'],
    [['pnpm', '--version'], 'pnpm']
  ]) {
    probes.push(await probe(argv, label))
    if (interruptedBy !== null) {
      break
    }
  }
  if (interruptedBy !== null) {
    const cleanup = await convergeAfterSignal()
    process.stderr.write(
      cleanup.ok
        ? `stage09a:check FAIL — interrupted by ${interruptedBy} during prerequisite checks; no checks were run\n`
        : 'stage09a:check FAIL — signal cleanup did not confirm every descendant process group gone\n'
    )
    return 1
  }

  const missingTools = probes.filter((entry) => !entry.ok)
  if (missingTools.length > 0) {
    process.stderr.write('stage09a:check FAIL — missing prerequisite tools; no checks were run:\n')
    for (const entry of missingTools) {
      process.stderr.write(`  - ${entry.label}: ${entry.detail}\n`)
    }
    process.stderr.write('Docker Engine with Compose v2 must be running before this gate can produce evidence.\n')
    return 1
  }
  process.stdout.write(
    `stage09a:check: prerequisites present (Docker daemon ${probes[0].detail}, Compose ${probes[1].detail})\n`
  )

  // ---- 顺序执行，fail fast ----
  let failedStep = null
  for (const [index, step] of steps.entries()) {
    if (interruptedBy !== null) {
      failedStep = {
        step,
        result: { ok: false, detail: `interrupted by ${interruptedBy}`, exitCode: 1, seconds: 0 }
      }
      break
    }
    process.stdout.write(
      `\nstage09a:check step ${String(index + 1)}/${String(steps.length)}: ${step.id} — ${step.title}\n` +
        `stage09a:check   $ ${(step.forwardsKeepFailure === true && keepFailure ? [...step.argv, '--keep-failure'] : step.argv).join(' ')}\n`
    )
    const result = await runStep(step)
    results.push(result)
    if (!result.ok) {
      failedStep = { step, result }
      break
    }
    process.stdout.write(
      `stage09a:check step ${String(index + 1)}/${String(steps.length)} PASS (${String(result.seconds)}s)\n`
    )
  }

  printSummary()
  if (failedStep !== null) {
    process.stderr.write(
      `stage09a:check FAIL at step ${failedStep.step.id} (${failedStep.result.detail}); later steps were not run\n`
    )
    return failedStep.result.exitCode === 0 ? 1 : failedStep.result.exitCode
  }
  process.stdout.write(`stage09a:check PASS (${String(steps.length)}/${String(steps.length)} steps)\n`)
  return 0
}

process.exitCode = await main()
