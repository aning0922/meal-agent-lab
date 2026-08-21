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
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { interpretPrerequisiteEvidence } from './stage09a-prerequisite-evidence.mjs'
import { stage09aSteps } from './stage09a-gate-registry.mjs'

const safeWrite = (fd, message) => {
  const bytes = Buffer.from(message, 'utf8')
  try {
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (!Number.isSafeInteger(written) || written <= 0) return false
      offset += written
    }
    return true
  } catch {
    return false
  }
}

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const stepController = resolve(repositoryRoot, 'scripts/stage09a-step-controller.mjs')
const usage = 'pnpm stage09a:check [-- --keep-failure]'
const ownershipFd = 3
const ownershipAuthFd = 4
const humanPresentation = Object.freeze({ childStdio: 'inherit', visible: true })
const auditPresentation = Object.freeze({
  childStdio: Object.freeze(['ignore', 'ignore', 'ignore']),
  visible: false
})
let activePresentation = humanPresentation

const createOwnershipCapability = () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-stage09a-owner-'))
  const path = resolve(directory, 'capability')
  const token = randomBytes(32).toString('hex')
  let fd = null
  try {
    writeFileSync(path, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    fd = openSync(path, 'r')
    unlinkSync(path)
    rmdirSync(directory)
    return Object.freeze({ fd, token })
  } catch {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 下面只返回固定启动失败；外部错误不得进入诊断。
      }
    }
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // 固定启动失败覆盖底层文本。
    }
    throw new Error('ownership capability creation failed')
  }
}

let keepFailure = false
let usageInvalid = false
let aggregateRunStarted = false
let aggregateInvocationCount = 0
const auditRunReceipts = new WeakMap()

// argv 是固定字符串；`--keep-failure` 只透传给声明支持它的入口。
const steps = stage09aSteps

const results = []
let interruptedBy = null
let signalCleanupPromise = null
let aggregatePrimitiveFailed = false
const interruptionWaiters = new Set()
const cooperativeShutdowns = new Set()
const ownedProcessGroups = new Map()
const quarantinedProcessGroups = new Map()
const currentProcessGroupGenerations = new Map()
const closedOwnedGroupLeaders = new Set()
let aggregateGenerationCounter = 0
const nativeKill = process.kill.bind(process)
const nativeNow = Date.now.bind(Date)
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis)
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis)
const nativeSetImmediate = globalThis.setImmediate.bind(globalThis)
const cooperativeShutdownBudgetMs = 310_000

const writePresentation = (fd, message) =>
  activePresentation.visible ? safeWrite(fd, message) : true

const safeDiagnostic = (message) => writePresentation(2, message)

const writeControlled = (fd, message) => {
  if (!writePresentation(fd, message)) {
    aggregatePrimitiveFailed = true
    throw new Error('aggregate output channel failed')
  }
}

const safeDelay = (milliseconds, { ref = true } = {}) =>
  new Promise((resolveDelay) => {
    const timer = nativeSetTimeout(resolveDelay, milliseconds)
    if (!ref && typeof timer?.unref === 'function') {
      timer.unref()
    }
  })

const ownershipLineage = ({ producer, pgid }) =>
  `${String(producer)}:${String(pgid)}`
const ownershipKey = ({ producer, pgid, generation }) =>
  `${ownershipLineage({ producer, pgid })}:${String(generation)}`

const registerOwnedProcessGroup = (handle) => {
  if (
    !Number.isSafeInteger(handle?.producer) ||
    handle.producer <= 0 ||
    !Number.isSafeInteger(handle?.pgid) ||
    handle.pgid <= 0 ||
    !Number.isSafeInteger(handle?.generation) ||
    handle.generation < 0
  ) {
    return false
  }
  const lineage = ownershipLineage(handle)
  quarantinedProcessGroups.delete(lineage)
  const previousGeneration = currentProcessGroupGenerations.get(lineage)
  if (previousGeneration !== undefined && handle.generation <= previousGeneration) {
    return false
  }
  if (previousGeneration !== undefined) {
    ownedProcessGroups.delete(
      ownershipKey({ ...handle, generation: previousGeneration })
    )
  }
  currentProcessGroupGenerations.set(lineage, handle.generation)
  ownedProcessGroups.set(ownershipKey(handle), Object.freeze({ ...handle }))
  return true
}

// generation 前被截断的帧不能取得正常所有权，但 producer + pgid 已足以证明
// 这是受控子树刚公布的组。把它放入只用于终止的 quarantine，直到确认 ESRCH。
const registerQuarantinedProcessGroup = ({ producer, pgid }) => {
  if (
    !Number.isSafeInteger(producer) || producer <= 0 ||
    !Number.isSafeInteger(pgid) || pgid <= 0
  ) {
    return false
  }
  const lineage = ownershipLineage({ producer, pgid })
  if (!currentProcessGroupGenerations.has(lineage)) {
    quarantinedProcessGroups.set(lineage, Object.freeze({ producer, pgid }))
  }
  return true
}

const probeQuarantinedGroup = (handle) => {
  try {
    nativeKill(-handle.pgid, 0)
    return { primitiveFailed: false }
  } catch (error) {
    if (error?.code === 'ESRCH') {
      quarantinedProcessGroups.delete(ownershipLineage(handle))
      return { primitiveFailed: false }
    }
    return { primitiveFailed: true }
  }
}

const signalQuarantinedGroup = (handle, signal) => {
  try {
    nativeKill(-handle.pgid, signal)
    return { primitiveFailed: false }
  } catch (error) {
    if (error?.code === 'ESRCH') {
      quarantinedProcessGroups.delete(ownershipLineage(handle))
      return { primitiveFailed: false }
    }
    return { primitiveFailed: true }
  }
}

const handleIsCurrent = (handle) =>
  currentProcessGroupGenerations.get(ownershipLineage(handle)) ===
  handle.generation

const retireOwnedProcessGroup = (handle) => {
  if (!handleIsCurrent(handle)) return
  ownedProcessGroups.delete(ownershipKey(handle))
  currentProcessGroupGenerations.delete(ownershipLineage(handle))
}

const processGroupIsAlive = (handle) => {
  try {
    nativeKill(-handle.pgid, 0)
    return { alive: true, primitiveFailed: false }
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return { alive: false, primitiveFailed: false }
    }
    return { alive: true, primitiveFailed: true }
  }
}

const purgeGoneProcessGroups = () => {
  let primitiveFailed = false
  for (const handle of ownedProcessGroups.values()) {
    if (!handleIsCurrent(handle)) {
      ownedProcessGroups.delete(ownershipKey(handle))
      continue
    }
    const probe = processGroupIsAlive(handle)
    primitiveFailed = probe.primitiveFailed || primitiveFailed
    if (!probe.alive) {
      retireOwnedProcessGroup(handle)
    }
  }
  for (const handle of quarantinedProcessGroups.values()) {
    primitiveFailed = probeQuarantinedGroup(handle).primitiveFailed || primitiveFailed
  }
  return primitiveFailed
}

const signalOwnedGroup = (handle, signal) => {
  if (!handleIsCurrent(handle)) {
    return { delivered: false, primitiveFailed: false }
  }
  try {
    nativeKill(-handle.pgid, signal)
    return { delivered: true, primitiveFailed: false }
  } catch (error) {
    if (error?.code === 'ESRCH') {
      retireOwnedProcessGroup(handle)
      return { delivered: false, primitiveFailed: false }
    }
    return { delivered: false, primitiveFailed: true }
  }
}

const waitForOwnedGroups = async (budgetMs) => {
  let primitiveFailed = false
  const attempts = Math.max(1, Math.ceil(budgetMs / 25))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    primitiveFailed = purgeGoneProcessGroups() || primitiveFailed
    if (ownedProcessGroups.size === 0 && quarantinedProcessGroups.size === 0) {
      return { gone: true, primitiveFailed }
    }
    await safeDelay(25)
  }
  primitiveFailed = purgeGoneProcessGroups() || primitiveFailed
  return {
    gone: ownedProcessGroups.size === 0 && quarantinedProcessGroups.size === 0,
    primitiveFailed
  }
}

// 聚合器不依赖子门禁的 termination abstraction 来做最后兜底：异常或永不
// settlement 时，仍能用模块加载时抓下来的原生同步 signal primitive 有界收敛。
// 连续两个空窗口才算稳定，以覆盖 scoped cleanup 刚派生并通过 fd 3 登记的新组。
const terminateOwnedProcessGroups = async () => {
  let primitiveFailed = false
  let stablePasses = 0
  try {
    for (let sweep = 0; sweep < 8; sweep += 1) {
      primitiveFailed = purgeGoneProcessGroups() || primitiveFailed
      const snapshot = [...ownedProcessGroups.values()]
      const quarantineSnapshot = [...quarantinedProcessGroups.values()]
      if (snapshot.length === 0 && quarantineSnapshot.length === 0) {
        stablePasses += 1
        if (stablePasses >= 2) {
          return { ok: !primitiveFailed, primitiveFailed, survivors: [] }
        }
        await safeDelay(25)
        continue
      }
      stablePasses = 0
      for (const handle of snapshot) {
        primitiveFailed = signalOwnedGroup(handle, 'SIGTERM').primitiveFailed || primitiveFailed
      }
      for (const handle of quarantineSnapshot) {
        primitiveFailed = signalQuarantinedGroup(handle, 'SIGTERM').primitiveFailed || primitiveFailed
      }
      const termWait = await waitForOwnedGroups(500)
      primitiveFailed = termWait.primitiveFailed || primitiveFailed
      for (const handle of [...ownedProcessGroups.values()]) {
        primitiveFailed = signalOwnedGroup(handle, 'SIGKILL').primitiveFailed || primitiveFailed
      }
      for (const handle of [...quarantinedProcessGroups.values()]) {
        primitiveFailed = signalQuarantinedGroup(handle, 'SIGKILL').primitiveFailed || primitiveFailed
      }
      const killWait = await waitForOwnedGroups(3_000)
      primitiveFailed = killWait.primitiveFailed || primitiveFailed
    }
  } catch {
    primitiveFailed = true
  }
  primitiveFailed = purgeGoneProcessGroups() || primitiveFailed
  return {
    ok:
      !primitiveFailed &&
      ownedProcessGroups.size === 0 &&
      quarantinedProcessGroups.size === 0,
    primitiveFailed,
    survivors: [...ownedProcessGroups.values(), ...quarantinedProcessGroups.values()]
  }
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
  try {
    const results = await Promise.race([
      Promise.all(attempts),
      safeDelay(cooperativeShutdownBudgetMs, { ref: false }).then(() => [false])
    ])
    return results.every((result) => result === true)
  } catch {
    return false
  }
}

const convergeAfterSignal = () => {
  if (signalCleanupPromise === null) {
    signalCleanupPromise = (async () => {
      try {
        const cooperativeOk = await requestCooperativeShutdown()
        const cleanup = await terminateOwnedProcessGroups()
        const primitiveFailed = aggregatePrimitiveFailed || cleanup.primitiveFailed
        return {
          ok: cooperativeOk && cleanup.ok && !primitiveFailed,
          cooperativeOk,
          primitiveFailed,
          survivorCount: cleanup.survivors.length
        }
      } catch {
        const cleanup = await terminateOwnedProcessGroups()
        return { ok: false, survivorCount: cleanup.survivors.length }
      }
    })()
  }
  return signalCleanupPromise
}

const settleInterruptedRuns = (cleanup) => {
  for (const waiter of [...interruptionWaiters]) {
    waiter(cleanup)
  }
}

const handledSignals = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP'])
const aggregateSignalHandler = (signal) => {
  if (interruptedBy !== null) {
    return
  }
  interruptedBy = signal
  if (!safeDiagnostic(`\nstage09a:check: received ${signal}; terminating the controlled process subtree\n`)) {
    aggregatePrimitiveFailed = true
  }
  void convergeAfterSignal()
    .then(settleInterruptedRuns)
    .catch(() => settleInterruptedRuns({
      ok: false,
      survivorCount: ownedProcessGroups.size + quarantinedProcessGroups.size
    }))
}
const installAggregateSignalHandlers = () => {
  for (const signal of handledSignals) {
    process.on(signal, aggregateSignalHandler)
  }
}

const removeAggregateSignalHandlers = () => {
  for (const signal of handledSignals) {
    process.removeListener(signal, aggregateSignalHandler)
  }
}

const nativeImmediateTurn = () =>
  new Promise((resolveImmediate, rejectImmediate) => {
    try {
      nativeSetImmediate(resolveImmediate)
    } catch {
      rejectImmediate(new Error('aggregate signal delivery primitive failed'))
    }
  })

/**
 * Publish the aggregate result only after pending signals have had two native
 * event-loop turns to reach the handler. A signal winner is rethrown only after
 * scoped cleanup and every owned/quarantined PGID reach final settlement.
 */
const settleAggregateProcess = async (ordinaryExitCode) => {
  const normalizedExitCode =
    Number.isSafeInteger(ordinaryExitCode) && ordinaryExitCode >= 0 && ordinaryExitCode <= 255
      ? ordinaryExitCode
      : 1
  try {
    await nativeImmediateTurn()
    await nativeImmediateTurn()
  } catch {
    aggregatePrimitiveFailed = true
  }

  if (interruptedBy === null) {
    removeAggregateSignalHandlers()
    if (aggregatePrimitiveFailed) {
      await terminateOwnedProcessGroups()
      return Object.freeze({ exitCode: 1, requestedSignal: null })
    }
    return Object.freeze({ exitCode: normalizedExitCode, requestedSignal: null })
  }

  let cleanup
  try {
    cleanup = await convergeAfterSignal()
  } catch {
    cleanup = { ok: false, survivorCount: ownedProcessGroups.size + quarantinedProcessGroups.size }
  }
  const finalCleanup = await terminateOwnedProcessGroups()
  const signal = interruptedBy
  removeAggregateSignalHandlers()
  if (!cleanup.ok || !finalCleanup.ok || finalCleanup.survivors.length > 0 || aggregatePrimitiveFailed) {
    safeDiagnostic('stage09a:check FAIL — signal cleanup did not reach final settlement\n')
    return Object.freeze({ exitCode: 1, requestedSignal: null })
  }
  return Object.freeze({ exitCode: null, requestedSignal: signal })
}

const runControlled = ({ argv, timeoutMs, stdio, maxStdoutBytes = 64 * 1024 * 1024 }) =>
  new Promise((resolvePromise) => {
    let settled = false
    let timedOut = false
    let closed = false
    let ownershipStreamEnded = false
    let producerDone = false
    let ownershipBuffer = ''
    let ownershipProtocolFailed = false
    const activeScopedCleanups = new Set()
    let resolveCleanupStarted
    let cleanupStartedPromise
    const resetCleanupStartedPromise = () => {
      cleanupStartedPromise = new Promise((resolveStart) => {
        resolveCleanupStarted = resolveStart
      })
    }
    resetCleanupStartedPromise()
    const stdoutChunks = []
    let stdoutBytes = 0
    let stdoutOverflow = false
    let ownershipCapability
    try {
      ownershipCapability = createOwnershipCapability()
    } catch {
      resolvePromise({
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        detail: 'failed to start'
      })
      return
    }
    const childEnvironment = {
      ...process.env,
      MEAL_AGENT_STAGE09A_PGID_FD: String(ownershipFd),
      MEAL_AGENT_STAGE09A_PGID_AUTH_FD: String(ownershipAuthFd),
      MEAL_AGENT_STAGE09A_PGID_AUTH_TOKEN: ownershipCapability.token
    }
    const childStdio = stdio === 'inherit'
      ? ['inherit', 'inherit', 'inherit', 'pipe', ownershipCapability.fd]
      : [stdio[0], stdio[1], stdio[2], 'pipe', ownershipCapability.fd]
    let child
    let lifecyclePrimitiveFailed = false
    let postForkPrimitiveFailed = false
    try {
      child = spawn(process.execPath, [stepController, JSON.stringify(argv)], {
        cwd: repositoryRoot,
        detached: true,
        env: childEnvironment,
        stdio: childStdio
      })
    } catch {
      try {
        closeSync(ownershipCapability.fd)
      } catch {
        aggregatePrimitiveFailed = true
      }
      resolvePromise({
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        detail: 'failed to start'
      })
      return
    }

    let controllerHandle = null
    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      aggregateGenerationCounter += 1
      controllerHandle = Object.freeze({
        producer: process.pid,
        pgid: child.pid,
        generation: aggregateGenerationCounter
      })
      if (!registerOwnedProcessGroup(controllerHandle)) {
        ownershipProtocolFailed = true
      }
    } else {
      ownershipProtocolFailed = true
    }
    try {
      closeSync(ownershipCapability.fd)
    } catch {
      // The detached group already has immutable ownership in the ledger.
      // Any post-fork primitive failure must converge through that handle.
      aggregatePrimitiveFailed = true
      lifecyclePrimitiveFailed = true
      ownershipProtocolFailed = true
      postForkPrimitiveFailed = true
    }
    if (child.stdout !== null) {
      child.stdout.on('data', (chunk) => {
        if (stdoutOverflow) return
        stdoutBytes += Buffer.byteLength(chunk)
        if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 0 || stdoutBytes > maxStdoutBytes) {
          stdoutOverflow = true
          ownershipProtocolFailed = true
          child.stdout?.destroy()
          void terminateOwnedProcessGroups()
          return
        }
        stdoutChunks.push(chunk)
      })
    }
    const ownershipStream = child.stdio[ownershipFd]
    const quarantineRecognizableLineage = (text, { frameComplete }) => {
      // EOF 本身不是数字 token 的边界：`... 123` 也可能只是实际 `12345` 的
      // 截断前缀。只有完整 LF frame，或缓冲区中已经出现非数字字符时，producer
      // 与 PGID 才可安全进入 quarantine。generation 可坏/溢出，但不能因此遗忘
      // 已经完整证明的 lineage。
      const pattern = frameComplete
        ? /^GROUP ([1-9][0-9]*) ([1-9][0-9]*)(?: |$)/
        : /^GROUP ([1-9][0-9]*) ([1-9][0-9]*)(?=[^0-9])/
      const match = pattern.exec(text)
      if (match === null) return false
      return registerQuarantinedProcessGroup({
        producer: Number(match[1]),
        pgid: Number(match[2])
      })
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
          resolveCleanupStarted()
          return
        }
        if (!activeScopedCleanups.delete(cleanupOwner)) {
          ownershipProtocolFailed = true
        }
        if (activeScopedCleanups.size === 0) {
          // CLEANUP START/DONE 是一次活跃区间，不是永久历史标志。后续 producer
          // 仍可能登记新组或开始新一轮 cleanup；为下一轮建立尚未 resolve 的等待点，
          // 不能让旧的 DONE 把 drain/cooperative wait 永久短路。
          resetCleanupStartedPromise()
        }
        return
      }
      const groupFrame = /^GROUP ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*)$/.exec(line)
      if (groupFrame === null) {
        quarantineRecognizableLineage(line, { frameComplete: true })
        ownershipProtocolFailed = true
        return
      }
      const handle = {
        producer: Number(groupFrame[1]),
        pgid: Number(groupFrame[2]),
        generation: Number(groupFrame[3])
      }
      if (!registerOwnedProcessGroup(handle)) {
        quarantineRecognizableLineage(line, { frameComplete: true })
        ownershipProtocolFailed = true
      }
    }
    ownershipStream?.on('data', (chunk) => {
      ownershipBuffer += chunk.toString('utf8')
      while (true) {
        const newline = ownershipBuffer.indexOf('\n')
        if (newline === -1) break
        const line = ownershipBuffer.slice(0, newline)
        ownershipBuffer = ownershipBuffer.slice(newline + 1)
        if (line.length > 4096) {
          quarantineRecognizableLineage(line, { frameComplete: true })
          ownershipProtocolFailed = true
        } else {
          recordOwnershipFrame(line)
        }
      }
      if (ownershipBuffer.length > 4096) {
        quarantineRecognizableLineage(ownershipBuffer, { frameComplete: false })
        ownershipProtocolFailed = true
        ownershipBuffer = ''
        ownershipStream?.destroy()
      }
    })
    ownershipStream?.on('error', () => {
      ownershipProtocolFailed = true
    })
    const finishOwnershipStream = () => {
      if (ownershipStreamEnded) return
      ownershipStreamEnded = true
      if (ownershipBuffer.length > 0) {
        // 缺少终止 LF 时仍登记可证明的 PGID 以便收尾，但协议必须失败，
        // 所以该 step 绝不能 PASS。
        quarantineRecognizableLineage(ownershipBuffer, { frameComplete: false })
        ownershipProtocolFailed = true
        ownershipBuffer = ''
      }
      if (!producerDone) {
        ownershipProtocolFailed = true
        void terminateOwnedProcessGroups()
      }
    }
    ownershipStream?.on('end', finishOwnershipStream)
    ownershipStream?.on('close', finishOwnershipStream)

    let resolveClosed
    let resolveLeaderExited
    const closedPromise = new Promise((resolveClose) => {
      resolveClosed = resolveClose
    })
    const leaderExitedPromise = new Promise((resolveExit) => {
      resolveLeaderExited = resolveExit
    })
    let ownershipDrainTimer = null
    child.once('exit', () => {
      if (controllerHandle !== null) {
        closedOwnedGroupLeaders.add(ownershipKey(controllerHandle))
      }
      resolveLeaderExited()
      // leader exit 后给内核 pipe 一个很短的 drain 窗口。即使 buffer 为空，
      // 未登记后代仍可能继承 fd 3 并永远不产生 EOF；旧实现会因此等不到 close。
      try {
        ownershipDrainTimer = nativeSetTimeout(() => {
          if (ownershipStreamEnded || activeScopedCleanups.size > 0) return
          if (ownershipBuffer.length > 0) {
            quarantineRecognizableLineage(ownershipBuffer, { frameComplete: false })
            ownershipBuffer = ''
          }
          ownershipProtocolFailed = true
          ownershipStream?.destroy()
          void terminateOwnedProcessGroups()
        }, interruptedBy === null ? 500 : 2_500)
      } catch {
        aggregatePrimitiveFailed = true
        lifecyclePrimitiveFailed = true
        ownershipProtocolFailed = true
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
          aggregatePrimitiveFailed = true
        }
      }
      const first = await Promise.race([
        leaderExitedPromise.then(() => 'leader-exit'),
        closedPromise.then(() => 'closed'),
        cleanupStartedPromise.then(() => 'cleanup'),
        safeDelay(2_500, { ref: false }).then(() => 'fallback')
      ])
      const afterLeader =
        first === 'leader-exit'
          ? await Promise.race([
              closedPromise.then(() => 'closed'),
              cleanupStartedPromise.then(() => 'cleanup'),
              safeDelay(2_500, { ref: false }).then(() => 'leader-grace-expired')
            ])
          : first
      if (afterLeader === 'cleanup') {
        await Promise.race([
          closedPromise,
          safeDelay(cooperativeShutdownBudgetMs, { ref: false })
        ])
      }
      if (
        first === 'fallback' ||
        activeScopedCleanups.size > 0
      ) {
        ownershipProtocolFailed = true
      }
      // signal 可以在 PRODUCER DONE 之前结束 controller；这本身不是 scoped
      // cleanup protocol 失败。普通 step 的完整 ownership 判据仍在 close 路径执行。
      return (
        (first !== 'fallback' || aggregatePrimitiveFailed) &&
        activeScopedCleanups.size === 0
      )
    }
    cooperativeShutdowns.add(cooperativeShutdown)

    const settle = (result) => {
      if (!settled) {
        settled = true
        interruptionWaiters.delete(interruptionWaiter)
        resolvePromise(result)
      }
    }
    const settleLifecyclePrimitiveFailure = () => {
      void (async () => {
        const cleanup = await terminateOwnedProcessGroups()
        settle({
          ok: false,
          code: null,
          signal: null,
          stdout: '',
          detail:
            cleanup.ok && cleanup.survivors.length === 0
              ? 'aggregate lifecycle primitive failed'
              : 'aggregate lifecycle primitive failed; descendant cleanup was not confirmed'
        })
      })()
    }
    let timer = null
    const clearTimer = (value) => {
      if (value === null) return true
      try {
        nativeClearTimeout(value)
        return true
      } catch {
        aggregatePrimitiveFailed = true
        lifecyclePrimitiveFailed = true
        try {
          value?.unref?.()
        } catch {
          // The fixed lifecycle-failure path below owns the final result.
        }
        return false
      }
    }
    const interruptionWaiter = (cleanup) => {
      clearTimer(timer)
      if (!cleanup.ok) {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }
      settle({
        ok: false,
        code: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        detail:
          cleanup.ok
            ? `interrupted by ${interruptedBy}`
            : cleanup.cooperativeOk === false
              ? 'signal cleanup protocol failed'
              : cleanup.primitiveFailed
                ? 'signal cleanup primitive failed'
                : 'signal cleanup failed'
      })
    }
    const release = () => {
      closed = true
      cooperativeShutdowns.delete(cooperativeShutdown)
      resolveClosed()
      aggregatePrimitiveFailed = purgeGoneProcessGroups() || aggregatePrimitiveFailed
    }
    let timerStartFailed = false
    try {
      timer = nativeSetTimeout(() => {
        if (settled || timedOut) {
          return
        }
        timedOut = true
        void (async () => {
          try {
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
          } catch {
            settle({ ok: false, code: null, signal: null, stdout: '', detail: 'timed out; cleanup failed' })
          }
        })()
      }, timeoutMs)
    } catch {
      timerStartFailed = true
      aggregatePrimitiveFailed = true
      lifecyclePrimitiveFailed = true
      ownershipProtocolFailed = true
    }
    interruptionWaiters.add(interruptionWaiter)
    if (interruptedBy !== null) {
      void convergeAfterSignal().then(interruptionWaiter).catch(() =>
        interruptionWaiter({
          ok: false,
          survivorCount: ownedProcessGroups.size + quarantinedProcessGroups.size
        })
      )
    }

    child.once('error', (error) => {
      clearTimer(timer)
      clearTimer(ownershipDrainTimer)
      resolveLeaderExited()
      release()
      if (settled || timedOut) {
        return
      }
      if (lifecyclePrimitiveFailed) {
        settleLifecyclePrimitiveFailure()
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
        }).catch(() => settle({ ok: false, code: null, signal: null, stdout: '', detail: 'signal cleanup failed' }))
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
      clearTimer(timer)
      clearTimer(ownershipDrainTimer)
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
      if (lifecyclePrimitiveFailed) {
        settleLifecyclePrimitiveFailure()
        return
      }
      if (interruptedBy !== null) {
        void convergeAfterSignal().then((cleanup) => {
          finish(cleanup.ok ? `interrupted by ${interruptedBy}` : 'signal cleanup failed')
        }).catch(() => finish('signal cleanup failed'))
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
      aggregatePrimitiveFailed = purgeGoneProcessGroups() || aggregatePrimitiveFailed
      const unexpectedGroups = [
        ...ownedProcessGroups.values(),
        ...quarantinedProcessGroups.values()
      ]
      if (unexpectedGroups.length > 0 || aggregatePrimitiveFailed) {
        void (async () => {
          await terminateOwnedProcessGroups()
          finish(
            aggregatePrimitiveFailed
              ? 'process-group ownership probe failed'
              : `left ${String(unexpectedGroups.length)} descendant process group(s) after exit`
          )
        })()
        return
      }
      finish(null)
    })
    if (timerStartFailed || postForkPrimitiveFailed) {
      settleLifecyclePrimitiveFailure()
    }
  })

const probe = async (argv, label) => {
  if (interruptedBy !== null) {
    return { ok: false, label, detail: `interrupted by ${interruptedBy}` }
  }
  let result
  try {
    result = await runControlled({
      argv,
      timeoutMs: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxStdoutBytes: 256
    })
  } catch {
    result = { ok: false, stdout: '', detail: 'failed to run prerequisite probe' }
  }
  return { label, ...interpretPrerequisiteEvidence(label, result) }
}

const runStep = (step) =>
  new Promise((resolvePromise) => {
    if (interruptedBy !== null) {
      resolvePromise({ ok: false, detail: `interrupted by ${interruptedBy}`, exitCode: 1, seconds: 0 })
      return
    }
    const argv = step.forwardsKeepFailure === true && keepFailure ? [...step.argv, '--keep-failure'] : step.argv
    const startedAt = nativeNow()
    void runControlled({
      argv,
      timeoutMs: step.timeoutMs,
      stdio: activePresentation.childStdio
    })
      .then((result) => {
        const seconds = Math.max(0, Math.round((nativeNow() - startedAt) / 1000))
        resolvePromise({
          ok: result.ok,
          detail: result.detail,
          exitCode: result.ok ? 0 : result.code === null || result.code === 0 ? 1 : result.code,
          seconds
        })
      })
      .catch(() => {
        resolvePromise({ ok: false, detail: 'aggregate control failed', exitCode: 1, seconds: 0 })
      })
  })

const printSummary = () => {
  writeControlled(1, '\nstage09a:check summary:\n')
  for (const [index, step] of steps.entries()) {
    const result = results[index]
    if (result === undefined) {
      writeControlled(1, `  SKIP ${step.id}\n`)
      continue
    }
    const status = result.ok ? 'PASS' : 'FAIL'
    writeControlled(1, `  ${status} ${step.id} (${String(result.seconds)}s${result.ok ? '' : `, ${result.detail}`})\n`)
  }
}

const main = async () => {
  if (usageInvalid) {
    return 2
  }
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
    writeControlled(2,
      cleanup.ok
        ? `stage09a:check FAIL — interrupted by ${interruptedBy} during prerequisite checks; no checks were run\n`
        : 'stage09a:check FAIL — signal cleanup did not confirm every descendant process group gone\n'
    )
    return 1
  }

  const missingTools = probes.filter((entry) => !entry.ok)
  if (missingTools.length > 0) {
    writeControlled(2, 'stage09a:check FAIL — missing prerequisite tools; no checks were run:\n')
    for (const entry of missingTools) {
      writeControlled(2, `  - ${entry.label}: ${entry.detail}\n`)
    }
    writeControlled(2, 'Docker Engine with Compose v2 must be running before this gate can produce evidence.\n')
    return 1
  }
  writeControlled(1,
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
    writeControlled(1,
      `\nstage09a:check step ${String(index + 1)}/${String(steps.length)}: ${step.id} — ${step.title}\n` +
        `stage09a:check   $ ${(step.forwardsKeepFailure === true && keepFailure ? [...step.argv, '--keep-failure'] : step.argv).join(' ')}\n`
    )
    const result = await runStep(step)
    results.push(result)
    if (!result.ok) {
      failedStep = { step, result }
      break
    }
    writeControlled(1,
      `stage09a:check step ${String(index + 1)}/${String(steps.length)} PASS (${String(result.seconds)}s)\n`
    )
  }

  printSummary()
  if (failedStep !== null) {
    writeControlled(2,
      `stage09a:check FAIL at step ${failedStep.step.id} (${failedStep.result.detail}); later steps were not run\n`
    )
    return 1
  }
  writeControlled(1, `stage09a:check PASS (${String(steps.length)}/${String(steps.length)} steps)\n`)
  return 0
}

const stage09aGateResult = ({ exitCode, requestedSignal }) => {
  const completedSteps = results
    .map((result, index) => result.ok ? steps[index].id : null)
    .filter((id) => id !== null)
  const failedResultIndex = results.findIndex((result) => !result.ok)
  const complete =
    exitCode === 0 &&
    requestedSignal === null &&
    completedSteps.length === steps.length
  return Object.freeze({
    status: complete ? 'pass' : 'fail',
    reason: complete
      ? 'complete'
      : requestedSignal !== null
        ? 'gate-signaled'
        : 'gate-failed',
    exitCode,
    signal: requestedSignal,
    completedSteps: Object.freeze(completedSteps),
    failedStep: failedResultIndex === -1 ? null : steps[failedResultIndex].id
  })
}

/**
 * Run the complete Stage 09A plan exactly once in this process. This is the
 * only machine-result producer used by both the human CLI and Audit-B; stdout
 * is presentation, never evidence input.
 */
export const runStage09aCheck = async (argv = [], presentation = humanPresentation) => {
  aggregateInvocationCount += 1
  if (aggregateRunStarted) {
    return Object.freeze({
      gate: Object.freeze({
        status: 'fail',
        reason: 'gate-failed',
        exitCode: 1,
        signal: null,
        completedSteps: Object.freeze([]),
        failedStep: null
      }),
      requestedSignal: null
    })
  }
  // A later/concurrent invocation invalidates an issued receipt, but it must
  // never switch the presentation capability of the already active run.
  activePresentation = presentation === auditPresentation
    ? auditPresentation
    : humanPresentation
  aggregateRunStarted = true
  keepFailure = argv.includes('--keep-failure')
  usageInvalid = argv.some((argument) => argument !== '--keep-failure')
  if (usageInvalid) writePresentation(2, `usage: ${usage}\n`)
  installAggregateSignalHandlers()

  let ordinaryExitCode = 1
  try {
    ordinaryExitCode = await main()
  } catch {
    const cleanup = await terminateOwnedProcessGroups()
    safeDiagnostic(
      cleanup.ok
        ? 'stage09a:check FAIL — aggregate control failed\n'
        : 'stage09a:check FAIL — aggregate control failed and descendant cleanup was not confirmed\n'
    )
    ordinaryExitCode = 1
  }
  const settlement = await settleAggregateProcess(ordinaryExitCode)
  return Object.freeze({
    gate: stage09aGateResult(settlement),
    requestedSignal: settlement.requestedSignal
  })
}

/**
 * Audit-B receives an opaque receipt, never the mutable wiring fields that
 * make up the gate result.  The receipt is issued in this module immediately
 * around the one real core invocation, so a consumer cannot substitute a
 * forged gate or hard-code invocation/retry accounting.
 */
export const runStage09aCheckForAudit = async (argv = []) => {
  const invocationCountBefore = aggregateInvocationCount
  const outcome = await runStage09aCheck(argv, auditPresentation)
  const invocationCount = aggregateInvocationCount - invocationCountBefore
  const receipt = Object.freeze({})
  const evidence = Object.freeze({
    gate: outcome.gate,
    requestedSignal: outcome.requestedSignal,
    invocationCount,
    retryCount: Math.max(0, invocationCount - 1)
  })
  auditRunReceipts.set(receipt, Object.freeze({
    aggregateInvocationCount,
    evidence
  }))
  return receipt
}

export const readStage09aAuditRunReceipt = (receipt) => {
  if (receipt === null || typeof receipt !== 'object') return null
  const record = auditRunReceipts.get(receipt)
  return record !== undefined && record.aggregateInvocationCount === aggregateInvocationCount
    ? record.evidence
    : null
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outcome = await runStage09aCheck(process.argv.slice(2))
  if (outcome.requestedSignal === null) {
    process.exitCode = outcome.gate.exitCode ?? 1
  } else {
    try {
      nativeKill(process.pid, outcome.requestedSignal)
      await new Promise(() => {})
    } catch {
      safeDiagnostic('stage09a:check FAIL — final signal rethrow failed\n')
      process.exitCode = 1
    }
  }
}
