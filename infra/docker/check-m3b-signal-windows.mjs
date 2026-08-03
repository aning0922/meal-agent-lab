#!/usr/bin/env node
// 阶段 09A / M3B：smoke 与 probe 在真实信号下的 failure-safe 反例。
//
//   node infra/docker/check-m3b-signal-windows.mjs
//
// 这条套件单独成文件，因为它必须**真的把 smoke/probe 作为子进程跑起来**，
// 在指定窗口向它们发 SIGINT/SIGTERM，然后逐项证明：
//
//   1. 子进程（含它们自己起的 docker 子进程）全部消失；
//   2. 本轮 project 的 container / network / volume 一个不剩；
//   3. 本轮唯一 image tag 已被删除；
//   4. 临时 Secret 目录已被删除（明文凭据不留在盘上）；
//   5. 临时 Compose override 已被删除，tracked 文件逐字节未变；
//   6. 进程按**原信号语义**收场（信号终止，而不是伪装成普通退出码）。
//
// 窗口由 smoke/probe 自己的输出定位（build 阶段、链路运行阶段），因此命中是
// 确定的，不靠猜时间。
import { spawn, spawnSync } from 'node:child_process'
import {
  runCommand,
  terminateControlledSubtree,
  unconfirmedProcessGroups
} from './m3b-subprocess.mjs'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isAbsenceMessage, runImageTagPrefix } from './m3b-docker.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repositoryRoot = resolve(composeDirectory, '..', '..')
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')

const failures = []
let caught = 0
const pass = (name, reason) => {
  caught += 1
  process.stdout.write(`  caught: ${name} (${reason})\n`)
}
/** 组内还有成员吗？ESRCH = 已空；EPERM = 还在但不归我们（同样算未消失）。 */
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return String(error?.code ?? '') !== 'ESRCH'
  }
}

/** 有界轮询：预算内一直没消失才算「仍存活」。 */
const groupSurvives = (pgid, budgetMs, stepMs = 50) => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (!groupAlive(pgid)) {
      return false
    }
    if (Date.now() >= deadline) {
      return true
    }
    const until = Math.min(Date.now() + stepMs, deadline)
    // 同步等待：这条判据必须在拿到结论之前不放行。
    while (Date.now() < until) {
      /* bounded spin */
    }
  }
}

const fail = (name, detail) => {
  failures.push(`${name}: ${detail}`)
}

/**
 * `spawnSync` 包装：**`error` 也要检查**。docker 不在 PATH 上时 status 是 null，
 * 调用方若只比较 `!== 0` 会把「根本没跑起来」和「跑了但失败」混在一起。
 */
const docker = (args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error !== undefined) {
    throw new Error(`failed to run docker ${args[0] ?? ''}: ${result.error.message}`)
  }
  return result
}

/** 所有 residue 查询都检查退出码：读不到即抛，绝不当成「没有残留」。 */
const listByLabel = (kind, project) => {
  const base =
    kind === 'container'
      ? ['ps', '-aq']
      : kind === 'network'
        ? ['network', 'ls', '-q']
        : ['volume', 'ls', '-q']
  const result = docker([...base, '--filter', `label=com.docker.compose.project=${project}`])
  if (result.status !== 0) {
    throw new Error(
      `docker ${base.join(' ')} exited ${
        result.status === null ? `on signal ${String(result.signal)}` : String(result.status)
      } while checking residue`
    )
  }
  return result.stdout.split('\n').filter(Boolean)
}

const processAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds)
  })

/**
 * 把一个 M3B CLI 跑起来，等它的输出命中 `trigger`，发 `signal`，然后收集：
 * 退出语义、project 名、image tag、Secret 目录、残留与后代进程。
 */
const runAndSignal = async ({
  script,
  trigger,
  signal,
  timeoutMs = 900_000,
  waitForProcess = null,
  signalDelayMs = 1_500
}) => {
  const child = spawn(process.execPath, [resolve(composeDirectory, script)], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })
  let stdout = ''
  let stderr = ''
  let signalled = false
  let windowConfirmed = waitForProcess === null
  const scene = { project: null, imageTag: null, secretsDirectory: null }

  const observe = (text) => {
    const project = /(?:smoke project|probe project): (\S+)/.exec(text)
    if (project !== null) {
      scene.project = project[1]
    }
    const tag = new RegExp(`(${runImageTagPrefix.replace(':', ':')}[a-z0-9]+)`).exec(text)
    if (tag !== null) {
      scene.imageTag = tag[1]
    }
    const secrets = /(?:temporary secrets|secrets directory): (\S+)/.exec(text)
    if (secrets !== null) {
      scene.secretsDirectory = secrets[1]
    }
  }

  const exited = new Promise((resolveExit) => {
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stdout += text
      observe(stdout)
      if (!signalled && trigger.test(stdout)) {
        signalled = true
        void (async () => {
          if (waitForProcess !== null) {
            // 等到那个子进程**真的存在**再发信号，窗口因此是确定的而不是靠
            // 猜时间。60 秒内没出现就照发，让断言去暴露问题。
            const deadline = Date.now() + 60_000
            for (;;) {
              const found = spawnSync('pgrep', ['-f', waitForProcess.source], {
                encoding: 'utf8'
              })
              if (found.status === 0) {
                windowConfirmed = true
                break
              }
              if (Date.now() >= deadline) {
                break
              }
              await sleep(300)
            }
          } else if (signalDelayMs > 0) {
            await sleep(signalDelayMs)
          }
          try {
            child.kill(signal)
          } catch {
            // 已退出。
          }
        })()
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.once('close', (code, closeSignal) => resolveExit({ code, closeSignal }))
  })

  const guard = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // 已退出。
    }
  }, timeoutMs)
  const outcome = await exited
  clearTimeout(guard)
  // 给 cleanup 的最后一点 I/O 一点时间落地。
  await sleep(1_000)
  return { ...outcome, stdout, stderr, scene, signalled, windowConfirmed, pid: child.pid }
}

const assertCleanScene = (name, result, { expectSignal }) => {
  const { scene } = result
  if (!result.signalled) {
    fail(name, `the trigger never matched; output was:\n${result.stdout.slice(-500)}`)
    return
  }
  if (!result.windowConfirmed) {
    fail(
      name,
      'the expected child process never appeared, so the signal did not land in ' +
        'the intended window (the residue assertions would be vacuously true)'
    )
    return
  }
  if (scene.project === null) {
    fail(name, 'could not observe the project name from the output')
    return
  }
  const problems = []
  for (const kind of ['container', 'network', 'volume']) {
    try {
      const remaining = listByLabel(kind, scene.project)
      if (remaining.length > 0) {
        problems.push(`${kind}(s) left: ${remaining.join(', ')}`)
      }
    } catch (error) {
      problems.push(String(error))
    }
  }
  if (scene.imageTag !== null) {
    // 与 m3b-docker.mjs 的 `imageIdOf` 走**同一个** `isAbsenceMessage`：退出码
    // 必须恰好是 1，且 stderr 整串锚定匹配（不带 `m` 标志）。此前这里用的是无
    // 锚点子串匹配、也不检查退出码是否为 1，于是被信号杀掉的 docker CLI
    // （status === null）或一条关于**别的镜像**的错误都会被读成「本轮 tag 已被
    // 删除」——而这是唯一一处在信号路径上验证 per-run tag 消失的地方。
    // 整块也要 try/catch：`docker()` 在 spawn 失败时抛，不接住会让进程带着栈
    // 直接死掉，FAIL 汇总与 5 窗口完整性计数都不会打印。
    try {
      const image = docker(['image', 'inspect', '--format', '{{.Id}}', scene.imageTag])
      if (image.status === 0) {
        problems.push(`image tag ${scene.imageTag} still exists`)
      } else if (
        !(
          image.status === 1 &&
          isAbsenceMessage(image.stderr, { kind: 'image', name: scene.imageTag })
        )
      ) {
        problems.push(
          `could not determine whether ${scene.imageTag} still exists ` +
            `(docker image inspect exited ${
              image.status === null ? `on signal ${String(image.signal)}` : String(image.status)
            })`
        )
      }
    } catch (error) {
      problems.push(`the per-run image tag check could not run: ${String(error)}`)
    }
  }
  if (scene.secretsDirectory !== null && existsSync(scene.secretsDirectory)) {
    problems.push('the temporary secrets directory still exists')
  }
  // 只查**本轮**的 override（按 run id）：并发的 M3B 运行不该让这里误红。
  const runId = scene.imageTag === null ? null : scene.imageTag.split(':m3b-')[1]
  if (runId !== undefined && runId !== null) {
    const own = readdirSync(composeDirectory).filter(
      (entry) => entry === `.m3b-image-override-${runId}.yaml`
    )
    if (own.length > 0) {
      problems.push('this run left its compose override file behind')
    }
  }
  if (processAlive(result.pid)) {
    problems.push('the CLI process is still alive')
  }
  // 后代检查按**被测 CLI 自己公布的真实 pgid** 逐个确认（它在 stderr 上打
  // `m3b-descendant-pgid <pgid>`）。不能用 `pgrep -g <cli pid>`：CLI 起的每个
  // 子进程都是 detached、**自成进程组**，那条查询结构上恒为空（已实测），
  // 五个窗口的「后代全部消失」会变成空真。也不做全局 pgrep（会误抓别的
  // worktree）。
  const announced = [
    ...new Set(
      [...result.stderr.matchAll(/m3b-descendant-pgid (\d+)/g)].map((match) => Number(match[1]))
    )
  ]
  if (announced.length === 0) {
    problems.push(
      'the CLI never announced a descendant pgid; the descendant check would be vacuous'
    )
  }
  // **有界轮询**确认消失，而不是做一次瞬时 kill(0)：被测 CLI 是在收到信号之后
  // 才走完整组终止流程的，瞬时快照会把「正在退出」误判成「没退出」。
  const stillAlive = announced.filter((pgid) => groupSurvives(pgid, 5_000))
  if (stillAlive.length > 0) {
    problems.push(
      `${String(stillAlive.length)} of ${String(announced.length)} announced descendant ` +
        `process group(s) are still alive: ${stillAlive.join(', ')}`
    )
  }
  // tracked compose 文件必须**逐字节**等于 HEAD 里的版本（git status 只说
  // 「有没有改动」，这里直接比字节）。
  const dirty = spawnSync('git', ['status', '--porcelain', '--', composeFile], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  })
  if (dirty.status !== 0 || dirty.stdout.trim() !== '') {
    problems.push('the tracked compose file is dirty')
  }
  const committed = spawnSync('git', ['show', `HEAD:infra/docker/compose.local-test.yaml`], {
    cwd: repositoryRoot,
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024
  })
  if (committed.error !== undefined || committed.status !== 0) {
    problems.push('could not read the committed compose file for a byte comparison')
  } else if (!readFileSync(composeFile).equals(committed.stdout)) {
    problems.push('the tracked compose file differs byte-for-byte from HEAD')
  }
  // 临时 secret 目录只按**本轮**判定（上面已单独断言 scene.secretsDirectory
  // 被删）。刻意**不**做全局 tmpdir 扫描：并行 worktree 的运行、或此前某次
  // 崩溃留下的空目录，会让本套件的后续每一个窗口连锁误红。
  // **只接受真实的信号终止**。`process.exit(130)` 这类伪装恰恰是本套件要
  // 拒绝的东西，所以不再接受「退出码等于 128+signo」。
  if (result.closeSignal !== expectSignal) {
    problems.push(
      `expected termination by ${expectSignal}, got code=${String(result.code)} ` +
        `signal=${String(result.closeSignal)}`
    )
  }
  // G3：被测 CLI 自己报出的 residue/失败必须一并被看见，否则「外部状态干净」
  // 会掩盖「CLI 认为自己没清干净」。
  // 信号路径**绝不允许**出现 PASS：被中断的运行没有跑完全部证据。
  if (/local-test smoke PASS|Compose secret identity probe PASS/.test(result.stdout)) {
    problems.push('the CLI printed a PASS verdict on a signal path')
  }
  const reportedFailures = result.stdout
    .split('\n')
    .filter((line) => /^FAIL: |cleanup residue:/.test(line))
  if (reportedFailures.length > 0) {
    // 固定类别：这些行来自被测 CLI 的 stdout，内容不可信（内嵌 docker stderr、
    // 目录路径与 problems）。只报计数。
    problems.push(
      `the CLI reported ${String(reportedFailures.length)} problem line(s) of its own ` +
        '(deliberately not echoed)'
    )
  }
  const reportedResidue = result.stderr
    .split('\n')
    .filter((line) => /residue after SIG/.test(line))
  if (reportedResidue.length > 0) {
    problems.push(
      `the signal handler reported ${String(reportedResidue.length)} residue line(s) ` +
        '(deliberately not echoed)'
    )
  }
  if (problems.length > 0) {
    fail(name, problems.join('; '))
  } else {
    pass(
      name,
      `${expectSignal} honoured; no container/network/volume/image-tag/secret/override residue`
    )
  }
}

process.stdout.write('M3B signal-window negatives\n')

// 窗口 1：**build 阶段**。trigger 必须是「build 确实已经开始」之后才出现的
// 输出——用 `per-run image tag:` 会让信号大概率落在其后的拓扑门禁子进程期间，
// 那时 override / image tag / 容器都还不存在，全部残留断言都是空真（这正是
// 修复前的实测形态）。`host port:` 是 build 之前的最后一条输出，随后就是
// `compose build`，因此以它为锚点并**确认 build 子进程真的在跑**。
assertCleanScene(
  'SIGINT during the smoke build window',
  await runAndSignal({
    script: 'run-local-test-smoke.mjs',
    trigger: /host port: /,
    signal: 'SIGINT',
    waitForProcess: /compose.*build api/
  }),
  { expectSignal: 'SIGINT' }
)

// 窗口 2：链路运行阶段（postgres 已经起来，卷与网络都已存在）。
assertCleanScene(
  'SIGTERM during the smoke chain window',
  await runAndSignal({
    script: 'run-local-test-smoke.mjs',
    trigger: /chain postgres: healthy/,
    signal: 'SIGTERM'
  }),
  { expectSignal: 'SIGTERM' }
)

// 窗口 0a：**pre-baseline** 窗口——临时 Secret 目录刚建好、`danglingVolumes()`
// 这次 Docker 查询还没返回。此前 scene 要到更晚才登记，这段窗口内被中断会把
// 明文 Secret 目录留在盘上。trigger 是 smoke 打出的第一行（project 名），此时
// override 与 image tag 都还不存在，cleanup 绝不能引用它们。
assertCleanScene(
  'SIGINT in the smoke pre-baseline window',
  await runAndSignal({
    script: 'run-local-test-smoke.mjs',
    trigger: /smoke project: /,
    signal: 'SIGINT',
    signalDelayMs: 0
  }),
  { expectSignal: 'SIGINT' }
)

// 窗口 0b：**pre-override** 窗口——secret bundle 已生成、拓扑门禁正在跑，
// override 仍未写盘。cleanup 必须把明文 bundle 删掉，且**不得**因为引用一个
// 不存在的 override 而报 residue。
assertCleanScene(
  'SIGTERM in the smoke pre-override window',
  await runAndSignal({
    script: 'run-local-test-smoke.mjs',
    trigger: /secret bundle generated and preflighted/,
    signal: 'SIGTERM',
    signalDelayMs: 0
  }),
  { expectSignal: 'SIGTERM' }
)

// 窗口 3：probe 的容器运行阶段。
assertCleanScene(
  'SIGINT during the probe run window',
  await runAndSignal({
    script: 'probe-compose-secret-identity.mjs',
    trigger: /built meal-agent-api:m3b-/,
    signal: 'SIGINT'
  }),
  { expectSignal: 'SIGINT' }
)

// ---------------------------------------------------------------------------
// 确定性进程组回归（**不依赖 Docker**，与下面 5 个真实信号窗口分开计数）
// ---------------------------------------------------------------------------
//
// 组长 close **不等于**整组消失：`sh -c 'sleep 30 & exit 0'` 的 leader 立刻退出，
// 而它 detach 出去的 `sleep` 仍留在同一个 pgid 里。此前 close 处理器直接把 pgid
// 从受控表里删掉，`terminateControlledSubtree()` 再也不会碰它——孤儿就此存活。
// 这条反例把那个场景钉死，不用起任何容器。
const regressionProblems = []
let orphanPgid = null
try {
  const result = await runCommand([
    '/bin/sh',
    '-c',
    'sleep 30 </dev/null >/dev/null 2>&1 & exit 0'
  ])
  orphanPgid = [...String(result.stderr).matchAll(/m3b-descendant-pgid (\d+)/g)]
    .map((match) => Number(match[1]))
    .at(-1) ?? null
  if (orphanPgid === null) {
    // runCommand 把 pgid 公布在**自己**的 stderr 上，而不是子进程的 stderr。
    orphanPgid = unconfirmedProcessGroups().at(-1) ?? null
  }
  if (result.status !== 0) {
    regressionProblems.push('the leader did not exit cleanly; the fixture is not measuring what it claims')
  }
  if (orphanPgid === null) {
    regressionProblems.push('no descendant pgid was observed; the fixture would be vacuous')
  } else {
    // a) 组长已经 close，但整组**仍然存活**——这正是旧实现放过的状态。
    if (!groupAlive(orphanPgid)) {
      regressionProblems.push('the detached grandchild did not survive the leader; the fixture is vacuous')
    }
    // b) 修复后：terminateControlledSubtree() 必须确认整组消失。
    const survivors = await terminateControlledSubtree()
    if (survivors.length > 0) {
      regressionProblems.push(
        `${String(survivors.length)} process group(s) were not confirmed gone by terminateControlledSubtree`
      )
    }
    if (groupSurvives(orphanPgid, 5_000)) {
      regressionProblems.push('the orphaned process group is still alive after termination')
    }
  }
} catch (error) {
  regressionProblems.push(
    `the deterministic fixture threw: ${error instanceof Error ? error.message : String(error)}`
  )
} finally {
  // 按**精确 pgid** 兜底清理，绝不做模糊匹配。
  if (orphanPgid !== null && groupAlive(orphanPgid)) {
    try {
      process.kill(-orphanPgid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}
const expectedRegressionChecks = 1
let regressionCaught = 0
if (regressionProblems.length > 0) {
  fail('deterministic process-group regression', regressionProblems[0])
} else {
  regressionCaught = 1
  pass(
    'deterministic process-group regression',
    'a detached grandchild outlives its leader, and terminateControlledSubtree confirms the ' +
      'whole group reaches ESRCH (no Docker involved)'
  )
}

const expectedCount = 5
// `caught` 同时计入确定性反例与 5 个真实窗口，因此完整性判据按**两部分之和**。
const expectedTotal = expectedCount + expectedRegressionChecks
if (caught + failures.length !== expectedTotal) {
  fail(
    'suite completeness',
    `expected ${String(expectedRegressionChecks)} deterministic regression check + ` +
      `${String(expectedCount)} signal windows, got ${String(caught)} caught + ` +
      `${String(failures.length)} failed`
  )
}

if (failures.length > 0) {
  process.stderr.write('M3B signal-window suite FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}
process.stdout.write(
  'M3B signal-window suite PASS (' +
    `${String(regressionCaught)}/${String(expectedRegressionChecks)} deterministic ` +
    'process-group regression (no Docker) + ' +
    `${String(caught - regressionCaught)}/${String(expectedCount)} real signal windows: ` +
    'announced descendant pgids confirmed gone by bounded polling, tracked files unchanged, ' +
    'zero docker/secret/image residue)\n'
)
