// 阶段 09A / M3B：四个 M3B CLI 共用的子进程与信号基础设施。
//
// 设计目标（阻断整改第二条）：
//
//   1. **不用 spawnSync 冒充可响应信号的实现**——长时间运行的子进程（docker
//      build/up/logs、node 门禁）全部走异步 spawn，事件循环保持存活，
//      SIGINT/SIGTERM 随时可被处理；
//   2. 每个子进程 `detached: true` 自成进程组并登记进 activeProcessGroups，
//      终止时对**整个组** TERM → 宽限 → KILL，不留孤儿；
//   3. 超时同样按组终止，并以明确错误 reject；
//   4. `installSignalHandlers` 的次序固定：先终止受控子树 → 再执行调用方的
//      scoped cleanup（其 residue 必须被打印，不得丢弃）→ 最后卸下自身 handler
//      并**重投同名信号**，让进程按原信号语义退出（128+signo），而不是伪装成
//      普通退出码。
//
// 本模块自身不打印任何 Secret：它只透传调用方给的参数与输出。
import { spawn } from 'node:child_process'

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
const activeProcessGroups = new Map()

/** 已确认消失的 pgid。一旦进入这里就永远不再被发信号。 */
const retiredProcessGroups = new Set()

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
  } catch {
    return false
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

/** 确认消失即退休；返回是否已退休。 */
const retireIfGone = (pgid) => {
  if (retiredProcessGroups.has(pgid)) {
    return true
  }
  if (groupIsAlive(pgid)) {
    return false
  }
  retiredProcessGroups.add(pgid)
  activeProcessGroups.delete(pgid)
  return true
}

/** 有界轮询等待一个进程组消失；返回是否确认消失。 */
const waitForGroupExit = async (pgid, budgetMs, stepMs = 25) => {
  const steps = Math.max(1, Math.ceil(budgetMs / stepMs))
  for (let attempt = 0; attempt < steps; attempt += 1) {
    if (retireIfGone(pgid)) {
      return true
    }
    await sleep(stepMs)
  }
  return retireIfGone(pgid)
}

/**
 * 对**本次调用真实派生出来的** pgid 走完整生命周期：
 * TERM → 有界宽限 → 对仍存活的整组 KILL → 有界等待，直到 `kill(-pgid, 0)`
 * 得到 ESRCH。返回**仍未确认消失**的 pgid 列表——调用方据此 fail closed。
 */
const terminateGroups = async (pgids, { graceMs = 1_000, killWaitMs = 3_000 } = {}) => {
  const pending = pgids.filter((pgid) => !retireIfGone(pgid))
  for (const pgid of pending) {
    killGroup(pgid, 'SIGTERM')
  }
  await Promise.all(pending.map((pgid) => waitForGroupExit(pgid, graceMs)))
  const survivors = pending.filter((pgid) => !retireIfGone(pgid))
  for (const pgid of survivors) {
    // 升级前再确认一次：宽限期内自己走掉的组已经退休，绝不对复用的 pgid 发 KILL。
    killGroup(pgid, 'SIGKILL')
  }
  await Promise.all(survivors.map((pgid) => waitForGroupExit(pgid, killWaitMs)))
  return survivors.filter((pgid) => !retireIfGone(pgid))
}

/**
 * 异步执行一个命令并收集输出。接口与旧的 spawnSync wrapper 对齐：
 * resolve 为 { status, stdout, stderr }；spawn 自身失败或超时才 reject。
 *
 * 超时处理：对整个进程组先 SIGTERM，1 秒宽限后 SIGKILL，随后以
 * 「timed out」reject——绝不静默把超时当成功。
 */
export const runCommand = (
  args,
  { env = process.env, cwd, timeoutMs = 120_000, stdin = null } = {}
) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
    })
    let settled = false
    let timedOut = false
    const stdoutChunks = []
    const stderrChunks = []

    child.once('error', (error) => {
      if (!settled) {
        settled = true
        rejectPromise(
          new Error(`failed to run ${args.join(' ')}: ${error.message}`)
        )
      }
    })

    // spawn 成功后才有 pid；error 事件与 spawn 事件互斥。
    child.once('spawn', () => {
      activeProcessGroups.set(child.pid, { leaderClosed: false })
      observedProcessGroups.add(child.pid)
      // 每个子进程都是 detached，因此**自成进程组**——它们不属于本进程的
      // pgid，`pgrep -g <cli pid>` 永远看不到它们（实测：CLI 退出后该查询恒
      // 返回空）。把真实 pgid 逐个公布出去，外部套件才可能真的核查后代是否
      // 全部消失，而不是做一次结构性空真的查询。
      process.stderr.write(`m3b-descendant-pgid ${String(child.pid)}\n`)
    })

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
    if (stdin !== null) {
      child.stdin.end(stdin)
    }

    // 超时**走同一套组生命周期**：不再自己写一遍 TERM/KILL 的时序。
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) {
        void terminateGroups([child.pid])
      }
    }, timeoutMs)

    const releaseChild = () => {
      clearTimeout(timer)
      if (child.pid !== undefined) {
        const entry = activeProcessGroups.get(child.pid)
        if (entry !== undefined) {
          entry.leaderClosed = true
        }
        // **不删除**：组长走了不代表整组走了。只有确认 ESRCH 才退休。
        retireIfGone(child.pid)
      }
    }
    child.once('error', releaseChild)

    child.once('close', (code, signal) => {
      releaseChild()
      if (settled) {
        return
      }
      settled = true
      if (timedOut) {
        rejectPromise(
          new Error(`${args.join(' ')} timed out after ${String(timeoutMs)}ms`)
        )
        return
      }
      resolvePromise({
        status: signal !== null ? null : code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      })
    })
  })

/**
 * 终止全部尚未确认消失的受控进程组，并**确认**它们真的消失。
 *
 * 返回仍未确认消失的 pgid 列表；空数组表示全部确认 ESRCH。幂等；signal
 * handler 与超时路径共用同一套原语。
 */
export const terminateControlledSubtree = async ({
  graceMs = 1_000,
  killWaitMs = 3_000
} = {}) => terminateGroups([...activeProcessGroups.keys()], { graceMs, killWaitMs })

/** 尚未确认消失的受控进程组（测试与门禁用）。 */
export const unconfirmedProcessGroups = () =>
  [...activeProcessGroups.keys()].filter((pgid) => !retiredProcessGroups.has(pgid))

/**
 * 安装 SIGINT/SIGTERM 处置。收到信号：
 *   1. 终止受控子树（等待宽限）；
 *   2. 执行调用方的 scoped cleanup（异步；其返回的 residue 列表被完整打印，
 *      异常也被打印——绝不静默丢弃）；
 *   3. 卸下自身 handler 后**重投同名信号**，按原信号语义退出。
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
    process.stderr.write(`\n${signal}: terminating child processes, then running ${label}\n`)
    void (async () => {
      let survivors = []
      try {
        survivors = await terminateControlledSubtree()
      } catch (error) {
        process.stderr.write(
          `subtree termination failed: ${error instanceof Error ? error.message : String(error)}\n`
        )
      }
      try {
        const residue = await cleanup(signal)
        if (Array.isArray(residue) && residue.length > 0) {
          process.stderr.write(`${label} residue after ${signal}:\n`)
          for (const item of residue) {
            process.stderr.write(`  - ${String(item)}\n`)
          }
        }
      } catch (error) {
        process.stderr.write(
          `${label} on ${signal} failed: ${error instanceof Error ? error.message : String(error)}\n`
        )
      }
      // cleanup 期间可能又派生了子进程（scoped cleanup 自己要跑 docker 命令）。
      // **重投原信号之前再做一次统一终止与确认**。
      try {
        survivors = await terminateControlledSubtree()
      } catch (error) {
        process.stderr.write(
          `subtree termination failed: ${error instanceof Error ? error.message : String(error)}\n`
        )
      }
      process.removeListener('SIGINT', handler)
      process.removeListener('SIGTERM', handler)
      if (survivors.length > 0) {
        // **fail closed**：有后代进程组没能确认消失，就不能用「干净的信号语义」
        // 收场。只报个数，不回显任何命令内容。
        process.stderr.write(
          `${String(survivors.length)} descendant process group(s) were not confirmed gone\n`
        )
        process.exit(1)
      }
      // 重投同名信号：进程以真实的信号处置收场（退出状态 128+signo）。
      process.kill(process.pid, signal)
    })()
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  return () => {
    process.removeListener('SIGINT', handler)
    process.removeListener('SIGTERM', handler)
  }
}
