// 阶段 09A / M3B：四个 M3B CLI 共用的子进程与信号基础设施。
//
// 设计目标（阻断整改第二条）：
//
//   1. **不用 spawnSync 冒充可响应信号的实现**——长时间运行的子进程（docker
//      build/up/logs、node 门禁）全部走异步 spawn，事件循环保持存活，
//      SIGINT/SIGTERM 随时可被处理；
//   2. 每个子进程 `detached: true` 自成进程组并以 `(pgid, generation)` 登记，
//      终止时对**当前代的整个组** TERM → 宽限 → KILL，并有界确认 ESRCH；
//   3. 超时同样按组终止，并以明确错误 reject；
//   4. `installSignalHandlers` 的次序固定：先终止受控子树 → 再执行调用方的
//      scoped cleanup（其 residue 必须被打印，不得丢弃）→ 最后卸下自身 handler
//      并**重投同名信号**，让进程按原信号语义退出（128+signo），而不是伪装成
//      普通退出码。
//
// 本模块自身不打印任何 Secret：它只透传调用方给的参数与输出。
import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'

const aggregateOwnershipFdName = 'MEAL_AGENT_STAGE09A_PGID_FD'
const aggregateOwnershipFd = (() => {
  const raw = process.env[aggregateOwnershipFdName]
  if (raw === undefined) {
    return null
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 3 ? value : null
})()

const writeAggregateFrame = (frame) => {
  if (aggregateOwnershipFd === null) {
    return true
  }
  const bytes = Buffer.from(frame, 'utf8')
  try {
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(
        aggregateOwnershipFd,
        bytes,
        offset,
        bytes.length - offset
      )
      if (!Number.isSafeInteger(written) || written <= 0) {
        return false
      }
      offset += written
    }
    return true
  } catch {
    return false
  }
}

const announceProcessGroupOwnership = (pgid) => {
  process.stderr.write(`m3b-descendant-pgid ${String(pgid)}\n`)
  if (!writeAggregateFrame(`${String(pgid)}\n`)) {
    process.stderr.write('aggregate ownership announcement failed\n')
    return false
  }
  return true
}

const announceCleanupState = (state) => {
  if (!writeAggregateFrame(`CLEANUP ${String(process.pid)} ${state}\n`)) {
    process.stderr.write('aggregate cleanup acknowledgement failed\n')
    return false
  }
  return true
}

/**
 * raw-spawn 的控制层若仍处于 stage09a 聚合器下，必须把机器可读 ownership fd
 * 原样传到子 CLI 的 fd 3。实际 Docker/命令 child 仍由本模块先登记 PGID，随后
 * 删除环境变量且不继承 fd；它们不直接持有聚合器通道。
 */
export const ownershipAwareSpawnStdio = (stdio) =>
  aggregateOwnershipFd === null ? stdio : [...stdio, aggregateOwnershipFd]

/**
 * 尚未确认消失的受控进程组：pgid → { leaderClosed }。
 *
 * **组长 close 不等于整组消失。** `close` 只说明我们 spawn 的那个 leader 退出且
 * stdio 关闭了；它 detach 出去的后代仍然留在同一个 pgid 里。此前 close 处理器
 * 直接把 pgid 从表里删掉，于是 `terminateControlledSubtree` 再也不会对它发信号，
 * 孤儿就此存活——signal-window 套件实测两个窗口各留下 1 个仍存活的 announced
 * pgid，两次独立运行稳定复现。
 *
 * 现在 close 只登记 `leaderClosed`；只有 `kill(-pgid, 0)` 得到 **ESRCH** 才把
 * 这一条**退休**。退休之后绝不再对该 pgid 发任何信号（pid 会被系统复用）。
 */
const generationKey = (pgid, generation) => `${String(pgid)}:${String(generation)}`

/**
 * 正在处置中的信号（null 表示没有）。CLI 用它给信号处置**让位**：一旦信号
 * 在飞，主流程就不再自己 `process.exit()`，否则普通退出码会抢在信号语义
 * 之前收场（实测：build 窗口发 SIGINT，主流程因子进程被杀而失败退出 1，
 * 信号语义被吞掉）。
 */
let pendingSignal = null
export const terminationSignal = () => pendingSignal

/**
 * 本进程**曾经**派生过的全部进程组（不因退出而移除）。外部套件读 stderr 上的
 * `m3b-descendant-pgid <pgid>` 行拿到同一份集合，用它逐个确认后代真的消失。
 */
const observedProcessGroups = new Set()
export const observedDescendantPgids = () => [...observedProcessGroups]

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds)
  })

const killGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH' || error?.code === 'EPERM') {
      return false
    }
    throw error
  }
}

/**
 * 这个进程组还在吗？
 *
 * `kill(-pgid, 0)` 只做权限/存在性检查，不投递信号。**只有 ESRCH 才算消失**：
 * EPERM 说明组还在、只是不归我们管，那绝不能当成「已经没了」。
 */
const groupIsAlive = (pgid) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/**
 * 一份按 `(pgid, generation)` 持有所有权的进程组 registry。
 *
 * 工厂接受的三个原语也让回归可以**确定性**构造同号 PGID 复用：不再依赖
 * OS 恰好在一次测试里复用 pid。这是正常的库级抽象，不是环境变量或忙等注入钩子。
 *
 * 已确认 ESRCH 之后，旧 handle 永不再对那个数字 PGID 发信号。若本 registry 后续
 * 登记同号新代，旧 handle 会先因 generation 不同而退休，不会触碰新代。
 * 无 pidfd 平台上，在一次同步 `kill(0)` 与紧随的 signal 之间被**无关进程**复用
 * 仍是 OS 级 TOCTOU 边界；不把它写成已被形式化消除。
 */
export const createProcessGroupLifecycle = ({
  probeGroup = groupIsAlive,
  signalGroup = killGroup,
  delay = sleep
} = {}) => {
  const active = new Map()
  const retired = new Set()
  let generationCounter = 0

  const currentEntry = ({ pgid, generation }) => {
    const entry = active.get(pgid)
    return entry !== undefined && entry.generation === generation ? entry : null
  }

  const retire = (handle) => {
    retired.add(generationKey(handle.pgid, handle.generation))
    if (currentEntry(handle) !== null) {
      active.delete(handle.pgid)
    }
  }

  const register = (pgid) => {
    const previous = active.get(pgid)
    if (previous !== undefined) {
      retire(previous)
    }
    generationCounter += 1
    const handle = Object.freeze({ pgid, generation: generationCounter })
    active.set(pgid, { ...handle, leaderClosed: false })
    return handle
  }

  const markLeaderClosed = (handle) => {
    const entry = currentEntry(handle)
    if (entry !== null) {
      entry.leaderClosed = true
    }
  }

  const retireIfGone = (handle) => {
    const key = generationKey(handle.pgid, handle.generation)
    if (retired.has(key)) {
      return true
    }
    // 同号新代已由本 registry 登记：旧 handle 的所有权已结束，绝不对
    // 这个数字再做 probe/signal。
    if (currentEntry(handle) === null) {
      retired.add(key)
      return true
    }
    if (probeGroup(handle.pgid)) {
      return false
    }
    retire(handle)
    return true
  }

  const waitForExit = async (handle, budgetMs, stepMs = 25) => {
    const steps = Math.max(1, Math.ceil(budgetMs / stepMs))
    for (let attempt = 0; attempt < steps; attempt += 1) {
      if (retireIfGone(handle)) {
        return true
      }
      await delay(stepMs)
    }
    return retireIfGone(handle)
  }

  const signalIfCurrent = (handle, signal) => {
    if (retireIfGone(handle)) {
      return false
    }
    // probe 与 signal 都是同步调用；JS 无法在两者之间登记一个新代。仍在
    // signal 前再查一次 generation，把所有权判据写在真正的副作用边界上。
    if (currentEntry(handle) === null) {
      retire(handle)
      return false
    }
    return signalGroup(handle.pgid, signal)
  }

  const terminate = async (
    handles,
    { graceMs = 1_000, killWaitMs = 3_000 } = {}
  ) => {
    const pending = handles.filter((handle) => !retireIfGone(handle))
    for (const handle of pending) {
      signalIfCurrent(handle, 'SIGTERM')
    }
    await Promise.all(pending.map((handle) => waitForExit(handle, graceMs)))
    const survivors = pending.filter((handle) => !retireIfGone(handle))
    for (const handle of survivors) {
      signalIfCurrent(handle, 'SIGKILL')
    }
    await Promise.all(survivors.map((handle) => waitForExit(handle, killWaitMs)))
    return survivors.filter((handle) => !retireIfGone(handle))
  }

  /**
   * 把 registry 收敛到一个**稳定**状态，而不是只处置一次 `active` 快照。
   *
   * signal cleanup 自己也会派生 docker 子进程；旧实现的最终 sweep 若已快照 A，
   * 此时新登记的 B 不在那份数组里，A 消失后函数便直接返回，B 会跟着「干净」
   * 的原信号语义一起被遗忘。这里反复取新快照：每一代只处置一次，连续两个
   * stability window 都没有新代才算收敛。达到固定轮数仍不稳定则抛出固定错误，
   * 调用方必须 fail closed。
   */
  const terminateAll = async ({
    graceMs = 1_000,
    killWaitMs = 3_000,
    maxSweeps = 8,
    stablePasses = 2,
    stabilityMs = 25
  } = {}) => {
    const failed = new Set()
    let emptyPasses = 0

    for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
      const current = [...active.values()].filter((handle) => !retireIfGone(handle))
      const pending = current.filter(
        (handle) => !failed.has(generationKey(handle.pgid, handle.generation))
      )

      if (pending.length === 0) {
        emptyPasses += 1
        if (emptyPasses >= stablePasses) {
          return current
        }
        await delay(stabilityMs)
        continue
      }

      emptyPasses = 0
      const survivors = await terminate(pending, { graceMs, killWaitMs })
      for (const survivor of survivors) {
        failed.add(generationKey(survivor.pgid, survivor.generation))
      }
    }

    throw new Error('process-group cleanup did not reach a stable state')
  }
  const unconfirmed = () =>
    [...active.values()]
      .filter((handle) => !retired.has(generationKey(handle.pgid, handle.generation)))
      .map(({ pgid }) => pgid)

  return Object.freeze({
    register,
    markLeaderClosed,
    retireIfGone,
    terminate,
    terminateAll,
    unconfirmed
  })
}

const processGroupLifecycle = createProcessGroupLifecycle()

/**
 * raw `spawn()` 控制层本身若使用 `detached: true`，必须在返回事件循环前同步登记
 * 自己的 PGID；仅把 fd 3 传给它是不够的——它首次调用 `runCommand()` 之前仍有一个
 * 聚合器不可达窗口。调用方应在 `spawn()` 后立即用本函数包装返回值。
 */
export const registerRawSpawnedChild = async (child) => {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    child?.once?.('error', () => undefined)
    throw new Error('raw detached child did not expose a process-group id')
  }
  const handle = processGroupLifecycle.register(child.pid)
  observedProcessGroups.add(child.pid)
  child.once('close', () => {
    processGroupLifecycle.markLeaderClosed(handle)
    processGroupLifecycle.retireIfGone(handle)
  })
  if (!announceProcessGroupOwnership(child.pid)) {
    let survivors = [handle]
    try {
      survivors = await processGroupLifecycle.terminate([handle])
    } catch {
      // 固定失败由下面的 throw 给出；registry 保留未确认组供最终 sweep 复核。
    }
    throw new Error(
      survivors.length === 0
        ? 'aggregate ownership announcement failed'
        : 'aggregate ownership announcement failed; descendant process group was not confirmed gone'
    )
  }
  return child
}

// scoped cleanup 完成后的最终收敛一旦稳定，立即同步关闭新派生入口；随后再做一轮
// registry 复核。赋值与复核之间不会让事件循环运行，因此不存在「最后一次空快照
// 之后、重投信号之前」又登记一个新组的窗口。
let childProcessStartsClosed = false

const refuseChildProcessStart = () => {
  const refusal = Promise.reject(
    new Error('child process start refused during final signal convergence')
  )
  // 调用方 await 时仍收到 rejection；内部 handler 只防止一个已经返回的
  // fire-and-forget callback 在 signal cleanup 中制造 unhandled-rejection 竞态。
  void refusal.catch(() => undefined)
  return refusal
}

/**
 * 异步执行一个命令并收集输出。接口与旧的 spawnSync wrapper 对齐：
 * resolve 为 { status, stdout, stderr }；spawn 自身失败或超时才 reject。
 *
 * 超时处理：对整个进程组先 SIGTERM，1 秒宽限后 SIGKILL，随后以
 * 「timed out」reject——绝不静默把超时当成功。
 */
const runCommandUnchecked = (
  args,
  { env = process.env, cwd, timeoutMs = 120_000, stdin = null } = {}
) =>
  new Promise((resolvePromise, rejectPromise) => {
    const childEnvironment = { ...env }
    delete childEnvironment[aggregateOwnershipFdName]
    const child = spawn(args[0], args.slice(1), {
      cwd,
      env: childEnvironment,
      detached: true,
      stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
    })
    let settled = false
    let timedOut = false
    let childHandle = null
    const stdoutChunks = []
    const stderrChunks = []

    // `spawn()` 成功返回后 pid 已经可用；在任何 timer / event 之前登记，
    // `timeoutMs: 0` 也不会落进「pid 存在但还没 generation」的窗口。
    let ownershipAnnouncementFailed = false
    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      childHandle = processGroupLifecycle.register(child.pid)
      observedProcessGroups.add(child.pid)
      // 每个子进程都是 detached，因此**自成进程组**——它们不属于本进程的
      // pgid，`pgrep -g <cli pid>` 永远看不到它们（实测：CLI 退出后该查询恒
      // 返回空）。把真实 pgid 逐个公布出去，外部套件才可能真的核查后代是否
      // 全部消失，而不是做一次结构性空真的查询。
      ownershipAnnouncementFailed = !announceProcessGroupOwnership(child.pid)
    }

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
    if (stdin !== null) {
      child.stdin.end(stdin)
    }

    // 超时调用方自己拥有 settlement：即使 leader 永远不发 `close`，
    // TERM → KILL → 有界确认的预算到期后也会 reject，不把 hard bound 寄托给 close。
    const timer = setTimeout(() => {
      if (settled || timedOut || ownershipAnnouncementFailed) {
        return
      }
      timedOut = true
      void (async () => {
        let survivors = []
        let terminationFailed = false
        try {
          survivors =
            childHandle === null ? [] : await processGroupLifecycle.terminate([childHandle])
        } catch {
          terminationFailed = true
          survivors = childHandle === null ? [] : [childHandle]
        }
        if (settled) {
          return
        }
        settled = true
        const suffix =
          terminationFailed || survivors.length > 0
            ? `; ${String(survivors.length)} descendant process group(s) were not confirmed gone`
            : ''
        rejectPromise(new Error(`${args.join(' ')} timed out after ${String(timeoutMs)}ms${suffix}`))
      })()
    }, timeoutMs)

    const releaseChild = () => {
      clearTimeout(timer)
      if (childHandle !== null) {
        processGroupLifecycle.markLeaderClosed(childHandle)
        // **不删除**：组长走了不代表整组走了。只有确认 ESRCH 才退休。
        processGroupLifecycle.retireIfGone(childHandle)
      }
    }
    child.once('error', (error) => {
      releaseChild()
      if (ownershipAnnouncementFailed) {
        return
      }
      if (!settled && !timedOut) {
        settled = true
        rejectPromise(new Error(`failed to run ${args.join(' ')}: ${error.message}`))
      }
    })

    child.once('close', (code, signal) => {
      releaseChild()
      // announcement failure 已经把 settlement 所有权交给下面的异步终止分支；
      // 快速 `/usr/bin/true` 的 close 绝不能抢先 resolve status 0。
      if (ownershipAnnouncementFailed) {
        return
      }
      if (settled) {
        return
      }
      if (timedOut) {
        // timeout 分支独占 settlement；close 只做 release，不能抢先 reject。
        return
      }
      settled = true
      resolvePromise({
        status: signal !== null ? null : code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      })
    })

    if (ownershipAnnouncementFailed && childHandle !== null) {
      void (async () => {
        let survivors = [childHandle]
        try {
          survivors = await processGroupLifecycle.terminate([childHandle])
        } catch {
          // 只返回固定诊断，不回显底层异常或命令。
        }
        if (!settled) {
          settled = true
          clearTimeout(timer)
          rejectPromise(
            new Error(
              survivors.length === 0
                ? 'aggregate ownership announcement failed'
                : 'aggregate ownership announcement failed; descendant process group was not confirmed gone'
            )
          )
        }
      })()
    }
  })

export const runCommand = (args, options = {}) =>
  childProcessStartsClosed
    ? refuseChildProcessStart()
    : runCommandUnchecked(args, options)

/**
 * 终止全部尚未确认消失的受控进程组，并**确认**它们真的消失。
 *
 * 返回仍未确认消失的 pgid 列表；空数组表示全部确认 ESRCH。幂等；signal
 * handler 与超时路径共用同一套原语。
 */
export const terminateControlledSubtree = async ({
  graceMs = 1_000,
  killWaitMs = 3_000
} = {}) =>
  processGroupLifecycle.terminateAll({ graceMs, killWaitMs })

/** 尚未确认消失的受控进程组（测试与门禁用）。 */
export const unconfirmedProcessGroups = () =>
  processGroupLifecycle.unconfirmed()

/**
 * 安装 SIGINT/SIGTERM/SIGHUP 处置。收到信号：
 *   1. 终止受控子树（等待宽限）；
 *   2. 执行调用方的 scoped cleanup（异步；只报告固定原因与 residue 数量，不回显
 *      调用方内容）；
 *   3. 再次收敛受控子树；只有两类清理都成功时才重投同名信号，否则 exit 1。
 *
 * 第二个同名/异名信号在清理期间只登记不重入。
 */
export const installSignalHandlers = (cleanup, { label = 'cleanup' } = {}) => {
  let terminating = false
  const handler = (signal) => {
    if (terminating) {
      return
    }
    terminating = true
    pendingSignal = signal
    const cleanupStartAnnounced = announceCleanupState('START')
    process.stderr.write(`\n${signal}: terminating child processes, then running ${label}\n`)
    void (async () => {
      let survivors = []
      let terminationFailed = false
      let cleanupFailed = false
      let cleanupMayRun = true
      try {
        survivors = await terminateControlledSubtree()
      } catch {
        terminationFailed = true
        process.stderr.write('subtree termination failed\n')
      }

      // 达到 sweep 上限或仍有未确认组时，不能带着活跃子进程进入 scoped cleanup。
      // 先同步关闭普通派生入口，再做一次 mutation-free 收敛；只有确认清空后才
      // 临时重开入口给 cleanup 使用。首次异常仍保留，最终必须 exit 1。
      if (terminationFailed || survivors.length > 0) {
        terminationFailed = true
        childProcessStartsClosed = true
        try {
          survivors = await terminateControlledSubtree()
          cleanupMayRun = survivors.length === 0
        } catch {
          cleanupMayRun = false
        }
        if (cleanupMayRun) {
          childProcessStartsClosed = false
        }
      }

      if (cleanupMayRun) {
        try {
          const residue = await cleanup(signal)
          if (!Array.isArray(residue)) {
            cleanupFailed = true
            process.stderr.write(`${label} returned an invalid cleanup result\n`)
          } else if (residue.length > 0) {
            cleanupFailed = true
            process.stderr.write(`${label} left ${String(residue.length)} residue item(s)\n`)
          }
        } catch {
          cleanupFailed = true
          process.stderr.write(`${label} failed during signal cleanup\n`)
        }
      }
      // cleanup 期间可能又派生了子进程（scoped cleanup 自己要跑 docker 命令）。
      // **重投原信号之前反复收敛到稳定空集**。第一次稳定返回后同步关闭新派生
      // 入口，再复核一次 registry；这样最终判定既能抓到 sweep 期间登记的新组，
      // 也不会在最后一次空快照与重投信号之间重新打开竞态窗口。
      try {
        survivors = await terminateControlledSubtree()
      } catch {
        terminationFailed = true
        process.stderr.write('subtree termination failed\n')
      }
      childProcessStartsClosed = true
      try {
        const finalSurvivors = await terminateControlledSubtree()
        survivors = [...new Set([...survivors, ...finalSurvivors])]
      } catch {
        if (!terminationFailed) {
          process.stderr.write('subtree termination failed\n')
        }
        terminationFailed = true
      }
      for (const handledSignal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.removeListener(handledSignal, handler)
      }
      // DONE 只表示本轮清理生命周期已经走完（含最终子树收敛），不表示 scoped
      // cleanup 的业务结果成功。负向门禁会故意制造 residue / throw，并在固定 exit 1
      // 后由父测试验证；它们同样必须先确认生命周期结束，不能在聚合器看来留下一个
      // 永远悬空的 START。相反，若进程在这里之前消失，缺 DONE 仍会由聚合器拒绝。
      const cleanupDoneAnnounced = cleanupStartAnnounced && announceCleanupState('DONE')
      if (!cleanupDoneAnnounced) {
        process.stderr.write('aggregate cleanup acknowledgement failed\n')
        process.exit(1)
      }
      if (terminationFailed || cleanupFailed || survivors.length > 0) {
        // **fail closed**：受控子树或 scoped cleanup 任一失败，都不能用「干净的
        // 信号语义」收场。子树失败只报固定原因，不回显任何命令内容。
        if (terminationFailed || survivors.length > 0) {
          process.stderr.write('descendant process groups were not confirmed gone\n')
        }
        process.exit(1)
      }
      // 重投同名信号：进程以真实的信号处置收场（退出状态 128+signo）。
      try {
        process.kill(process.pid, signal)
      } catch {
        // 最终 self-signal 也是一条会失败的 termination primitive。不得让它的
        // Error/stack（可能含调用方文字）逃到 Node 默认异常输出。
        process.stderr.write('final signal rethrow failed\n')
        process.exit(1)
      }
    })()
  }
  for (const handledSignal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(handledSignal, handler)
  }
  return () => {
    for (const handledSignal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.removeListener(handledSignal, handler)
    }
  }
}
