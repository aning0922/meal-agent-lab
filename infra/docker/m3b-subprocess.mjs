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
 * 仍然存活的受控进程组：pgid → { alive }。
 *
 * 只登记**尚未 close 的** child。任何升级（TERM → KILL）都必须在发信号之前
 * 重新确认这一条仍然 alive——否则一个已经退出的 pgid 可能已被别的进程组复用，
 * 我们就会把 SIGKILL 发给无关进程。
 */
const activeProcessGroups = new Map()

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
      activeProcessGroups.set(child.pid, { alive: true })
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

    // 超时升级：TERM → 宽限 → KILL。升级 timer **绑定这个 child 的生命周期**，
    // close/error 时被取消，且发信号前再确认一次它仍 alive。
    let escalation = null
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) {
        killGroup(child.pid, 'SIGTERM')
        escalation = setTimeout(() => {
          if (activeProcessGroups.get(child.pid)?.alive === true) {
            killGroup(child.pid, 'SIGKILL')
          }
        }, 1_000)
        escalation.unref()
      }
    }, timeoutMs)

    const releaseChild = () => {
      clearTimeout(timer)
      if (escalation !== null) {
        clearTimeout(escalation)
        escalation = null
      }
      if (child.pid !== undefined) {
        const entry = activeProcessGroups.get(child.pid)
        if (entry !== undefined) {
          entry.alive = false
        }
        activeProcessGroups.delete(child.pid)
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
 * 终止全部仍存活的受控进程组：先整组 TERM，宽限后对残余整组 KILL。
 * 幂等；signal handler 与超时路径共用。
 */
export const terminateControlledSubtree = async ({ graceMs = 1_000 } = {}) => {
  const entries = [...activeProcessGroups.entries()]
  for (const [pgid, state] of entries) {
    if (state.alive) {
      killGroup(pgid, 'SIGTERM')
    }
  }
  if (entries.length === 0) {
    return
  }
  await sleep(graceMs)
  // **升级前重新确认**：宽限期内自行退出的 child 已被 close 处理器标记为
  // 非 alive 并从表里移除，绝不能再对那个 pgid 发 SIGKILL——它可能已被复用。
  for (const [pgid] of entries) {
    if (activeProcessGroups.get(pgid)?.alive === true) {
      killGroup(pgid, 'SIGKILL')
    }
  }
}

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
      try {
        await terminateControlledSubtree()
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
      process.removeListener('SIGINT', handler)
      process.removeListener('SIGTERM', handler)
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
