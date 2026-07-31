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

/** 仍然存活的受控进程组（负值 pgid 直接可用于 process.kill）。 */
const activeProcessGroups = new Set()

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
      activeProcessGroups.add(child.pid)
    })

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
    if (stdin !== null) {
      child.stdin.end(stdin)
    }

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) {
        killGroup(child.pid, 'SIGTERM')
        setTimeout(() => killGroup(child.pid, 'SIGKILL'), 1_000).unref()
      }
    }, timeoutMs)

    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (child.pid !== undefined) {
        activeProcessGroups.delete(child.pid)
      }
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
  const groups = [...activeProcessGroups]
  for (const pgid of groups) {
    killGroup(pgid, 'SIGTERM')
  }
  if (groups.length > 0) {
    await sleep(graceMs)
    for (const pgid of groups) {
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
