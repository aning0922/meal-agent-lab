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
//   3. 本轮 immutable image 已被删除；
//   4. 临时 Secret 目录已被删除（明文凭据不留在盘上）；
//   5. 临时 Compose override 已被删除，tracked 文件逐字节未变；
//   6. 进程按**原信号语义**收场（信号终止，而不是伪装成普通退出码）。
//
// 窗口由 smoke/probe 自己的输出定位（build 阶段、链路运行阶段），因此命中是
// 确定的，不靠猜时间。
import { spawn, spawnSync } from 'node:child_process'
import {
  createProcessGroupLifecycle,
  ownershipAwareSpawnStdio,
  observedDescendantPgids,
  registerRawSpawnedChild,
  runCommand
} from './m3b-subprocess.mjs'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))

import { isAbsenceMessage } from './m3b-docker.mjs'
import { parseSignalResidueListing } from './m5-evidence-protocol.mjs'

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

/** 测试自身的 failure-safe 收尾：精确 PGID、整组 KILL、有界确认 ESRCH。 */
const killAndConfirmGroups = (pgids, budgetMs = 5_000) => {
  const unique = [...new Set(pgids.filter((pgid) => Number.isSafeInteger(pgid) && pgid > 0))]
  for (const pgid of unique) {
    if (!groupAlive(pgid)) {
      continue
    }
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // 下面的有界确认给最终结论。
    }
  }
  return unique.filter((pgid) => groupSurvives(pgid, budgetMs))
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
    throw new Error('docker signal-window evidence command could not start')
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
  return parseSignalResidueListing(kind, result.stdout)
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
 * 退出语义、project 名、immutable image ID、Secret 目录、残留与后代进程。
 */
const runAndSignal = async ({
  script,
  trigger,
  signal,
  timeoutMs = 900_000,
  waitForProcess = null,
  signalDelayMs = 1_500
}) => {
  const buildEvidenceBaseline = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith('meal-agent-m3b-build-'))
  )
  const child = await registerRawSpawnedChild(
    spawn(process.execPath, [resolve(composeDirectory, script)], {
      cwd: repositoryRoot,
      stdio: ownershipAwareSpawnStdio(['ignore', 'pipe', 'pipe']),
      detached: true
    })
  )
  let stdout = ''
  let stderr = ''
  let signalled = false
  let windowConfirmed = waitForProcess === null
  const scene = { project: null, imageId: null, secretsDirectory: null, buildEvidenceBaseline }

  const observe = (text) => {
    const project = /(?:smoke project|probe project|negative project): (\S+)/.exec(text)
    if (project !== null) {
      scene.project = project[1]
    }
    const image = /(?:api image built with immutable identity|built immutable image) (sha256:[0-9a-f]{64})/.exec(
      text
    )
    if (image !== null) {
      scene.imageId = image[1]
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
  const problems = []
  // 先从已经收集完的 stderr 中取得精确 PGID，再进入任何可能抛错的证据读取。
  // cleanup 必须位于词法 finally：即使后面的目录、Git 或 Docker 探针异常，
  // 被测 CLI 公布过的进程组也不能因此逃过测试自身的 failure-safe 收尾。
  const announced = [
    ...new Set(
      [...result.stderr.matchAll(/m3b-descendant-pgid (\d+)/g)].map((match) => Number(match[1]))
    )
  ]
  try {
  if (!result.signalled) {
    problems.push('the trigger never matched')
  }
  if (!result.windowConfirmed) {
    problems.push(
      'the expected child process never appeared, so the signal did not land in ' +
        'the intended window (the residue assertions would be vacuously true)'
    )
  }
  if (scene.project === null) {
    problems.push('could not observe the project name from the output')
  }
  if (scene.project !== null) {
    for (const kind of ['container', 'network', 'volume']) {
      try {
        const remaining = listByLabel(kind, scene.project)
        if (remaining.length > 0) {
          problems.push(`${String(remaining.length)} ${kind}(s) left`)
        }
      } catch {
        problems.push(`${kind} residue evidence could not be collected`)
      }
    }
  }
  if (scene.imageId !== null) {
    // 与 m3b-docker.mjs 的 image absence 读取走**同一个** `isAbsenceMessage`：退出码
    // 必须恰好是 1，且 stderr 整串锚定匹配（不带 `m` 标志）。此前这里用的是无
    // 锚点子串匹配、也不检查退出码是否为 1，于是被信号杀掉的 docker CLI
    // （status === null）或一条关于**别的镜像**的错误都会被读成「本轮 tag 已被
    // 删除」——而这是唯一一处在信号路径上验证 per-run immutable image 消失的地方。
    // 整块也要 try/catch：`docker()` 在 spawn 失败时抛，不接住会让进程带着栈
    // 直接死掉，FAIL 汇总与 5 窗口完整性计数都不会打印。
    try {
      const image = docker(['image', 'inspect', '--format', '{{.Id}}', scene.imageId])
      if (image.status === 0) {
        problems.push('the per-run immutable image still exists')
      } else if (
        !(
          image.status === 1 &&
          isAbsenceMessage(image.stderr, { kind: 'image', name: scene.imageId })
        )
      ) {
        problems.push(
          'could not determine whether the per-run immutable image still exists ' +
            `(docker image inspect exited ${
              image.status === null ? `on signal ${String(image.signal)}` : String(image.status)
            })`
        )
      }
    } catch {
      problems.push('the per-run immutable image check could not run')
    }
  }
  if (scene.secretsDirectory !== null && existsSync(scene.secretsDirectory)) {
    problems.push('the temporary secrets directory still exists')
  }
  const newBuildEvidence = readdirSync(tmpdir()).filter(
    (name) =>
      name.startsWith('meal-agent-m3b-build-') &&
      !scene.buildEvidenceBaseline.has(name)
  )
  if (newBuildEvidence.length > 0) {
    problems.push(
      `${String(newBuildEvidence.length)} build-evidence director` +
        `${newBuildEvidence.length === 1 ? 'y' : 'ies'} remain from this window`
    )
  }
  // 只查**本轮**的 override（按 run id）：并发的 M3B 运行不该让这里误红。
  const runId =
    scene.project === null
      ? null
      : /^meal-agent-m3b-(?:smoke|probe)-([a-z0-9]+)$/.exec(scene.project)?.[1] ?? null
  if (runId !== null) {
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
  } catch {
    problems.push('an evidence probe threw before the scene could be fully verified')
  } finally {
    const cleanupSurvivors = killAndConfirmGroups(announced)
    if (cleanupSurvivors.length > 0) {
      problems.push(
        `fixture cleanup could not confirm ${String(cleanupSurvivors.length)} exact process ` +
          'group(s) reached ESRCH'
      )
    }
  }
  if (problems.length > 0) {
    fail(name, problems.join('; '))
  } else {
    pass(
      name,
      `${expectSignal} honoured; no container/network/volume/image/secret/build-evidence/override residue`
    )
  }
}

process.stdout.write('M3B signal-window negatives\n')

// 窗口 1：**build 阶段**。trigger 必须是「build 确实已经开始」之后才出现的
// 输出——过早的 run-locator 输出会让信号大概率落在其后的拓扑门禁子进程期间，
// 那时 override / immutable image / 容器都还不存在，全部残留断言都是空真。
// `host port:` 是 build 之前的最后一条输出，随后就是 BuildKit，因此以它为
// 锚点并**确认带 iidfile 的 build 子进程真的在跑**。
assertCleanScene(
  'SIGINT during the smoke build window',
  await runAndSignal({
    script: 'run-local-test-smoke.mjs',
    trigger: /host port: /,
    signal: 'SIGINT',
    waitForProcess: /docker.*build.*--iidfile/
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
// override 与 immutable image 都还不存在，cleanup 绝不能引用它们。
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
    trigger: /secret materializer completed with immutable outcome evidence/,
    signal: 'SIGINT',
    signalDelayMs: 0
  }),
  { expectSignal: 'SIGINT' }
)

// 窗口 4：反例套件已经在 daemon 中创建了 scoped 容器。外部信号必须先走
// 本套件自己的 scoped cleanup；不能依赖随后不会再执行的顶层收尾循环。
assertCleanScene(
  'SIGTERM after the local-test negative suite creates a daemon container',
  await runAndSignal({
    script: 'check-local-test-negatives.mjs',
    trigger: /container-created/,
    signal: 'SIGTERM',
    signalDelayMs: 0
  }),
  { expectSignal: 'SIGTERM' }
)

// ---------------------------------------------------------------------------
// 确定性进程组回归（**不依赖 Docker**，与下面 6 个真实信号窗口分开计数）
// ---------------------------------------------------------------------------
//
// 组长 close **不等于**整组消失：`sh -c 'sleep 30 & exit 0'` 的 leader 立刻退出，
// 而它 detach 出去的 `sleep` 仍留在同一个 pgid 里。status 0 settlement 必须先
// 终止并确认整组到达 ESRCH；旧实现会先把成功交给调用方并留下孤儿。
const regressionProblems = []
let orphanPgid = null
try {
  const observedBefore = new Set(observedDescendantPgids())
  const result = await runCommand([
    '/bin/sh',
    '-c',
    'sleep 30 </dev/null >/dev/null 2>&1 & exit 0'
  ])
  const newlyObserved = observedDescendantPgids().filter((pgid) => !observedBefore.has(pgid))
  orphanPgid = newlyObserved.at(-1) ?? null
  if (result.status !== 0) {
    regressionProblems.push('the leader did not exit cleanly; the fixture is not measuring what it claims')
  }
  if (orphanPgid === null) {
    regressionProblems.push('no descendant pgid was observed; the fixture would be vacuous')
  } else {
    // 修复后：runCommand 返回 status 0 时，整组必须已经确认消失。
    if (groupSurvives(orphanPgid, 5_000)) {
      regressionProblems.push('status 0 settled before the descendant process group reached ESRCH')
    }
  }
} catch {
  regressionProblems.push('the deterministic fixture raised an internal failure')
} finally {
  // 按**精确 pgid** 兜底清理，绝不做模糊匹配。
  const cleanupSurvivors = killAndConfirmGroups(orphanPgid === null ? [] : [orphanPgid])
  if (cleanupSurvivors.length > 0) {
    regressionProblems.push('fixture cleanup could not confirm the orphaned pgid is gone')
  }
}
const expectedRegressionChecks = 5
let regressionCaught = 0
if (regressionProblems.length > 0) {
  fail('deterministic process-group regression', regressionProblems[0])
} else {
  regressionCaught += 1
  pass(
    'deterministic process-group regression',
    'status 0 settles only after a leader-close descendant group reaches ESRCH (no Docker involved)'
  )
}

// --- timeout settlement：调用方拿到 rejection 之后立即退出，整组仍必须已 ESRCH ---
//
// 判别形态必须让**孙进程扛住 TERM**：否则 leader 一死 `close` 就到，rejection
// 天然排在终止之后，反例无法区分新旧实现（实测基线同样通过）。用
// `(trap "" TERM; sleep 45)` 之后，基线在调用方退出时**留下 1 个存活组**，
// 修复后为 0。
const timeoutFixture = resolve(tmpdir(), `m3b-timeout-settlement-${String(process.pid)}.mjs`)
const timeoutProblems = []
let timeoutPgids = []
try {
  writeFileSync(
    timeoutFixture,
    [
      `const m = await import(${JSON.stringify(resolve(moduleDirectory, 'm3b-subprocess.mjs'))})`,
      "const originalKill = process.kill.bind(process)",
      "if (process.argv[2] === 'stubborn') {",
      "  process.kill = (pid, signal) => pid < 0 && signal !== 0 ? true : originalKill(pid, signal)",
      '}',
      'try {',
      "  await m.runCommand(['/bin/sh','-c'," +
        JSON.stringify('(trap "" TERM; sleep 45) </dev/null >/dev/null 2>&1 & sleep 45') +
        '], { timeoutMs: 400 })',
      "  process.stdout.write('NO-REJECTION')",
      "} catch (error) {",
      "  const suffix = String(error?.message ?? '').includes('not confirmed gone') ? '-UNCONFIRMED' : ''",
      "  process.stdout.write('REJECTED' + suffix); process.exit(7)",
      '}',
      ''
    ].join('\n'),
    'utf8'
  )
  const run = spawnSync(process.execPath, [timeoutFixture], {
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
    stdio: ownershipAwareSpawnStdio(['ignore', 'pipe', 'pipe'])
  })
  if (run.error !== undefined) {
    timeoutProblems.push('the real-signal timeout fixture exceeded its independent watchdog')
  }
  timeoutPgids = [...String(run.stderr ?? '').matchAll(/m3b-descendant-pgid (\d+)/g)].map((m) =>
    Number(m[1])
  )
  if (run.status !== 7 || !String(run.stdout ?? '').includes('REJECTED')) {
    timeoutProblems.push('the timeout did not reject; the fixture is not measuring settlement')
  }
  if (timeoutPgids.length === 0) {
    timeoutProblems.push('no descendant pgid was announced; the fixture would be vacuous')
  }
  const survivors = timeoutPgids.filter((pgid) => groupSurvives(pgid, 5_000))
  if (survivors.length > 0) {
    timeoutProblems.push(
      `${String(survivors.length)} process group(s) outlived the caller after a timeout rejection`
    )
  }

  // 信号调用返回成功、但 leader 与孙进程始终不 close：timeout 仍必须
  // 在 grace + KILL-wait 预算结束后自主 reject，不能等 close 才 settle。
  const stubbornStarted = Date.now()
  const stubborn = spawnSync(process.execPath, [timeoutFixture, 'stubborn'], {
    encoding: 'utf8',
    timeout: 8_000,
    killSignal: 'SIGKILL',
    stdio: ownershipAwareSpawnStdio(['ignore', 'pipe', 'pipe'])
  })
  const stubbornElapsed = Date.now() - stubbornStarted
  const stubbornPgids = [
    ...String(stubborn.stderr ?? '').matchAll(/m3b-descendant-pgid (\d+)/g)
  ].map((match) => Number(match[1]))
  timeoutPgids.push(...stubbornPgids)
  if (stubborn.error !== undefined) {
    timeoutProblems.push('the close-independent timeout fixture exceeded its watchdog')
  } else if (
    stubborn.status !== 7 ||
    !String(stubborn.stdout ?? '').includes('REJECTED-UNCONFIRMED') ||
    stubbornElapsed > 7_000
  ) {
    timeoutProblems.push('timeout settlement still depended on the child close event')
  }
  if (stubbornPgids.length === 0) {
    timeoutProblems.push('the close-independent fixture announced no pgid and is vacuous')
  }
} catch {
  timeoutProblems.push('the timeout fixture raised an internal failure')
} finally {
  const cleanupSurvivors = killAndConfirmGroups(timeoutPgids)
  if (cleanupSurvivors.length > 0) {
    timeoutProblems.push(
      `fixture cleanup could not confirm ${String(cleanupSurvivors.length)} pgid(s) are gone`
    )
  }
  try {
    rmSync(timeoutFixture, { force: true })
  } catch {
    /* best effort */
  }
}
if (timeoutProblems.length > 0) {
  fail('timeout settlement waits for the whole group', timeoutProblems[0])
} else {
  regressionCaught += 1
  pass(
    'timeout settlement waits for the whole group',
    'a timeout rejection is settled only after TERM -> KILL -> bounded ESRCH, so a caller that ' +
      'exits immediately still leaves no surviving process group'
  )
}

// --- generation：确定性复用**同一个数字** PGID ---
const generationProblems = []
try {
  let alive = true
  const delivered = []
  let releaseOldDelay = null
  let markOldDelayEntered = null
  const oldDelayEntered = new Promise((resolveEntered) => {
    markOldDelayEntered = resolveEntered
  })
  const resumeOldSweep = new Promise((resolveDelay) => {
    releaseOldDelay = resolveDelay
  })
  let delayCalls = 0
  const lifecycle = createProcessGroupLifecycle({
    probeGroup: () => alive,
    signalGroup: (pgid, signal) => {
      delivered.push(`${String(pgid)}:${signal}`)
      if (signal === 'SIGKILL') {
        alive = false
      }
      return true
    },
    delay: async () => {
      delayCalls += 1
      if (delayCalls === 1) {
        markOldDelayEntered()
        await resumeOldSweep
      }
    }
  })
  const first = lifecycle.register(42)
  const oldSweep = lifecycle.terminate([first], { graceMs: 1, killWaitMs: 1 })
  let delayWatchdog = null
  let second = null
  let beforeOldSweepResumes = 0
  try {
    await Promise.race([
      oldDelayEntered,
      new Promise((_, rejectWait) => {
        delayWatchdog = setTimeout(
          () => rejectWait(new Error('the old generation never reached its TERM wait')),
          2_000
        )
      })
    ])
    if (delivered.join(',') !== '42:SIGTERM') {
      generationProblems.push('the in-flight old sweep did not reach its TERM wait')
    }
    second = lifecycle.register(42)
    beforeOldSweepResumes = delivered.length
  } finally {
    if (delayWatchdog !== null) {
      clearTimeout(delayWatchdog)
    }
    // 即使 watchdog 或断言失败，也必须放开旧 sweep，不能让确定性夹具自己挂住。
    releaseOldDelay()
  }
  const oldSurvivors = await oldSweep
  if (oldSurvivors.length !== 0) {
    generationProblems.push('the superseded old generation remained a reported survivor')
  }
  if (delivered.length !== beforeOldSweepResumes) {
    generationProblems.push(
      'an in-flight old generation delivered a late signal to the same-number new generation'
    )
  }
  if (lifecycle.unconfirmed().join(',') !== '42') {
    generationProblems.push('the same-number new generation inherited retired state')
  }
  const beforeNewSweep = delivered.length
  const survivors = await lifecycle.terminate([second], { graceMs: 1, killWaitMs: 1 })
  const newGenerationSignals = delivered.slice(beforeNewSweep)
  if (
    survivors.length > 0 ||
    lifecycle.unconfirmed().length > 0 ||
    JSON.stringify(newGenerationSignals) !== JSON.stringify(['42:SIGTERM', '42:SIGKILL'])
  ) {
    generationProblems.push('the new generation did not receive its own TERM/KILL lifecycle')
  }
} catch {
  generationProblems.push('the generation fixture raised an internal failure')
}
if (generationProblems.length > 0) {
  fail('process-group generation is not inherited', generationProblems[0])
} else {
  regressionCaught += 1
  pass(
    'process-group generation is not inherited',
    'an in-flight old TERM wait cannot deliver a late KILL after the same numeric pgid is ' +
      'registered as a new generation'
  )
}

// --- mutation-closed cleanup：最终 sweep 快照后登记的新组仍必须被收掉 ---
//
// cleanup 启动 A 后返回；A 收到最终 sweep 的 TERM 才写 marker。测试侧看到 marker
// 后才启动 B，因此 B 的登记确定发生在 A 已进入那份快照**之后**。旧实现只处置 A
// 便重投 SIGTERM，B 稳定存活；收敛实现必须在下一轮快照看到 B，并在重投前确认
// A/B 两组均 ESRCH。
// 独占目录让两个 marker 的初始不存在成为结构事实。若复用基于 PID 的固定路径，
// 前一次 SIGKILL 遗留的 marker + PID 复用会让 B 在 A 真正收到 TERM 前启动，使旧的
// 单快照实现也可能假绿。
const mutationDirectory = mkdtempSync(resolve(tmpdir(), 'm3b-mutation-closed-'))
const mutationFixture = resolve(mutationDirectory, 'fixture.mjs')
const mutationReadyMarker = resolve(mutationDirectory, 'group-a.ready')
const mutationTermMarker = resolve(mutationDirectory, 'group-a.term')
const mutationProblems = []
let mutationPgids = []
try {
  if (existsSync(mutationReadyMarker) || existsSync(mutationTermMarker)) {
    mutationProblems.push('the exclusive mutation fixture directory did not start marker-free')
  }
  writeFileSync(
    mutationFixture,
    [
      `const m = await import(${JSON.stringify(resolve(moduleDirectory, 'm3b-subprocess.mjs'))})`,
      `const readyMarker = ${JSON.stringify(mutationReadyMarker)}`,
      `const termMarker = ${JSON.stringify(mutationTermMarker)}`,
      'const nativeKill = process.kill.bind(process)',
      'const nativeTimer = globalThis.setTimeout',
      "const { existsSync } = await import('node:fs')",
      'const sleep = (ms) => new Promise((resolveSleep) => nativeTimer(resolveSleep, ms))',
      "m.installSignalHandlers(async () => {",
      "  void m.runCommand(['/bin/sh','-c'," +
        JSON.stringify(
          "trap 'printf A_TERM > \"$2\"' TERM; " +
            "printf A_READY > \"$1\"; while :; do sleep 1; done"
        ) +
        ",'fixture-a',readyMarker,termMarker], { timeoutMs: 60000 })",
      '  const readyDeadline = Date.now() + 5000',
      '  while (!existsSync(readyMarker) && Date.now() < readyDeadline) {',
      '    await sleep(10)',
      '  }',
      '  if (!existsSync(readyMarker)) {',
      "    process.stderr.write('MUTATION_GROUP_A_NOT_READY' + String.fromCharCode(10))",
      '    return []',
      '  }',
      '  void (async () => {',
      '    const deadline = Date.now() + 5000',
      '    while (!existsSync(termMarker) && Date.now() < deadline) {',
      '      await sleep(10)',
      '    }',
      '    if (!existsSync(termMarker)) {',
      "      process.stderr.write('MUTATION_GROUP_B_MISSING' + String.fromCharCode(10))",
      '      return',
      '    }',
      "    void m.runCommand(['/bin/sh','-c'," +
        JSON.stringify('trap "" TERM; sleep 45 </dev/null >/dev/null 2>&1') +
        "], { timeoutMs: 60000 })",
      "    process.stderr.write('MUTATION_GROUP_B_STARTED' + String.fromCharCode(10))",
      '  })()',
      '  return []',
      "}, { label: 'mutation-closed cleanup' })",
      "nativeTimer(() => nativeKill(process.pid, 'SIGTERM'), 100)",
      'await sleep(60000)',
      ''
    ].join('\n'),
    'utf8'
  )
  const run = spawnSync(process.execPath, [mutationFixture], {
    encoding: 'utf8',
    timeout: 12_000,
    killSignal: 'SIGKILL',
    stdio: ownershipAwareSpawnStdio(['ignore', 'pipe', 'pipe'])
  })
  const stderr = String(run.stderr ?? '')
  mutationPgids = [...stderr.matchAll(/m3b-descendant-pgid (\d+)/g)].map((match) =>
    Number(match[1])
  )
  if (run.error !== undefined) {
    mutationProblems.push('the mutation-closed fixture exceeded its watchdog')
  } else if (run.status !== null || run.signal !== 'SIGTERM') {
    mutationProblems.push('clean mutation-closed cleanup did not preserve SIGTERM semantics')
  }
  if (!stderr.includes('MUTATION_GROUP_B_STARTED')) {
    mutationProblems.push(
      'group B was not registered after group A entered the final sweep ' +
        `(a-not-ready=${String(stderr.includes('MUTATION_GROUP_A_NOT_READY'))}, ` +
        `term-marker-missing=${String(stderr.includes('MUTATION_GROUP_B_MISSING'))}, ` +
        `pgids=${String(mutationPgids.length)}, status=${String(run.status)}, ` +
        `signal=${String(run.signal)})`
    )
  }
  if (mutationPgids.length !== 2 || new Set(mutationPgids).size !== 2) {
    mutationProblems.push('the fixture did not announce exactly two distinct process groups')
  }
  const survivors = mutationPgids.filter((pgid) => groupSurvives(pgid, 5_000))
  if (survivors.length > 0) {
    mutationProblems.push(
      `${String(survivors.length)} process group(s) survived the mutation-closed cleanup`
    )
  }

  // 固定轮数不是装饰：若每个 stability window 都登记新代，不能在某个瞬时
  // 空快照上返回成功。用注入原语确定性证明达到上限会 fail closed，且已看到的
  // generation 仍逐一被处置。
  const syntheticAlive = new Map([[100, true]])
  let syntheticLifecycle = null
  let syntheticNextPgid = 100
  let syntheticMutationsOpen = true
  syntheticLifecycle = createProcessGroupLifecycle({
    probeGroup: (pgid) => syntheticAlive.get(pgid) === true,
    signalGroup: (pgid) => {
      syntheticAlive.set(pgid, false)
      return true
    },
    delay: async () => {
      if (!syntheticMutationsOpen) {
        return
      }
      syntheticNextPgid += 1
      syntheticAlive.set(syntheticNextPgid, true)
      syntheticLifecycle.register(syntheticNextPgid)
    }
  })
  syntheticLifecycle.register(100)
  let cappedFailure = null
  try {
    await syntheticLifecycle.terminateAll({
      graceMs: 1,
      killWaitMs: 1,
      maxSweeps: 8,
      stablePasses: 2,
      stabilityMs: 1
    })
  } catch (error) {
    cappedFailure = error
  }
  if (
    !(cappedFailure instanceof Error) ||
    cappedFailure.message !== 'process-group cleanup did not reach a stable state'
  ) {
    mutationProblems.push('a continuously mutating registry did not fail closed at the sweep cap')
  }
  if (syntheticLifecycle.unconfirmed().length !== 1) {
    mutationProblems.push('the sweep-cap fixture did not create its final tail generation')
  }
  syntheticMutationsOpen = false
  const finalSyntheticSurvivors = await syntheticLifecycle.terminateAll({
    graceMs: 1,
    killWaitMs: 1,
    maxSweeps: 8,
    stablePasses: 2,
    stabilityMs: 1
  })
  if (
    finalSyntheticSurvivors.length > 0 ||
    syntheticLifecycle.unconfirmed().length > 0
  ) {
    mutationProblems.push('the closed final convergence left an observed generation unconfirmed')
  }
} catch {
  mutationProblems.push('the mutation-closed fixture raised an internal failure')
} finally {
  const cleanupSurvivors = killAndConfirmGroups(mutationPgids)
  if (cleanupSurvivors.length > 0) {
    mutationProblems.push(
      `fixture cleanup could not confirm ${String(cleanupSurvivors.length)} pgid(s) are gone`
    )
  }
  try {
    rmSync(mutationDirectory, { recursive: true, force: true })
  } catch {
    mutationProblems.push('the mutation fixture directory could not be removed')
  }
}
if (mutationProblems.length > 0) {
  fail('signal cleanup is closed over process-group mutations', mutationProblems[0])
} else {
  regressionCaught += 1
  pass(
    'signal cleanup is closed over process-group mutations',
    'group B is registered only after snapshotted group A receives TERM, yet both announced ' +
      'process groups reach ESRCH before the clean SIGTERM rethrow'
  )
}

// --- signal handler：终止原语、scoped cleanup residue/异常都不得伪装成干净信号退出 ---
const handlerProblems = []
try {
  let syntheticAlive = true
  const falseReturningLifecycle = createProcessGroupLifecycle({
    probeGroup: () => syntheticAlive,
    signalGroup: () => {
      // 确定性模拟 EPERM / 未投递：随后资源恰好自行消失，不能据此抹掉
      // signal primitive 已经明确返回 false 的失败事实。
      syntheticAlive = false
      return false
    },
    delay: async () => undefined
  })
  const handle = falseReturningLifecycle.register(73)
  const outcome = await falseReturningLifecycle.terminateDetailed([handle], {
    graceMs: 1,
    killWaitMs: 1
  })
  if (!outcome.primitiveFailed || outcome.survivors.length !== 0) {
    handlerProblems.push(
      'a false-returning termination primitive was erased after the group disappeared'
    )
  }
} catch {
  handlerProblems.push('the false-returning termination primitive probe threw')
}
const handlerCases = [
  {
    label: 'clean',
    cleanup: 'async () => []',
    beforeSignal: '',
    expectedStatus: null,
    expectedSignal: 'SIGTERM',
    expectedReason: /terminating child processes/
  },
  {
    label: 'residue',
    cleanup:
      "async () => { void m.runCommand(['/bin/sh','-c','trap \\\"\\\" TERM; sleep 45'], " +
      "{ timeoutMs: 60000 }); await new Promise((resolve) => nativeTimer(resolve, 50)); " +
      "return ['CALLER-SENTINEL'] }",
    beforeSignal: '',
    expectedStatus: 1,
    expectedSignal: null,
    expectedReason: /scoped cleanup left 1 residue item/
  },
  {
    label: 'throw',
    cleanup: "async () => { throw new Error('CALLER-SENTINEL') }",
    beforeSignal: '',
    expectedStatus: 1,
    expectedSignal: null,
    expectedReason: /scoped cleanup failed during signal handling/
  },
  {
    label: 'invalid-return',
    cleanup: "async () => ({ residue: ['CALLER-SENTINEL'] })",
    beforeSignal: '',
    expectedStatus: 1,
    expectedSignal: null,
    expectedReason: /scoped cleanup returned an invalid result/
  },
  {
    label: 'termination-primitive',
    cleanup: 'async () => []',
    beforeSignal:
      "let primitiveFailed = false; process.kill = (pid, signal) => { " +
      "if (pid < 0 && signal === 'SIGTERM' && !primitiveFailed) { primitiveFailed = true; " +
      "throw new Error('CALLER-SENTINEL') }; return nativeKill(pid, signal) }",
    expectedStatus: 1,
    expectedSignal: null,
    expectedReason: /subtree termination failed/
  },
  {
    label: 'final-signal-primitive',
    cleanup: 'async () => []',
    beforeSignal:
      "process.kill = (pid, signal) => { if (pid === process.pid && signal === 'SIGTERM') " +
      "{ throw new Error('CALLER-SENTINEL') }; return nativeKill(pid, signal) }",
    expectedStatus: 1,
    expectedSignal: null,
    expectedReason: /final signal rethrow failed/
  }
]
const expectedHandlerCaseLabels = [
  'clean',
  'residue',
  'throw',
  'invalid-return',
  'termination-primitive',
  'final-signal-primitive'
]
if (
  JSON.stringify(handlerCases.map((handlerCase) => handlerCase.label)) !==
  JSON.stringify(expectedHandlerCaseLabels)
) {
  handlerProblems.push('signal-handler case declarations drifted')
}
for (const handlerCase of handlerCases) {
  const handlerFixture = resolve(
    tmpdir(),
    `m3b-handler-${handlerCase.label}-${String(process.pid)}.mjs`
  )
  let handlerPgids = []
  try {
    writeFileSync(
      handlerFixture,
      [
        `const m = await import(${JSON.stringify(resolve(moduleDirectory, 'm3b-subprocess.mjs'))})`,
        'const nativeTimer = globalThis.setTimeout',
        'const nativeKill = process.kill.bind(process)',
        `m.installSignalHandlers(${handlerCase.cleanup}, { label: 'fixture cleanup' })`,
        "void m.runCommand(['/bin/sh','-c','trap \"\" TERM; sleep 45'], { timeoutMs: 60000 })",
        'nativeTimer(() => {',
        `  ${handlerCase.beforeSignal}`,
        "  nativeKill(process.pid, 'SIGTERM')",
        '}, 150)',
        ''
      ].join('\n'),
      'utf8'
    )
    const run = spawnSync(process.execPath, [handlerFixture], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
      stdio: ownershipAwareSpawnStdio(['ignore', 'pipe', 'pipe'])
    })
    const stdout = String(run.stdout ?? '')
    const stderr = String(run.stderr ?? '')
    const output = `${stdout}\n${stderr}`
    handlerPgids = [...stderr.matchAll(/m3b-descendant-pgid (\d+)/g)].map((match) =>
      Number(match[1])
    )
    if (run.error !== undefined) {
      handlerProblems.push(`${handlerCase.label}: fixture exceeded its watchdog`)
    } else if (
      run.status !== handlerCase.expectedStatus ||
      run.signal !== handlerCase.expectedSignal
    ) {
      handlerProblems.push(
        `${handlerCase.label}: cleanup outcome used the wrong exit semantics ` +
          `(status=${String(run.status)}, signal=${String(run.signal)})`
      )
    } else if (!handlerCase.expectedReason.test(stderr)) {
      handlerProblems.push(`${handlerCase.label}: cleanup outcome used the wrong reason`)
    }
    if (output.includes('CALLER-SENTINEL')) {
      handlerProblems.push(
        `${handlerCase.label}: caller-controlled cleanup text leaked to process output`
      )
    }
    if (handlerPgids.length === 0) {
      handlerProblems.push(`${handlerCase.label}: fixture announced no pgid and is vacuous`)
    } else if (handlerPgids.some((pgid) => groupAlive(pgid))) {
      handlerProblems.push(
        `${handlerCase.label}: an announced pgid was still alive when the fixture settled`
      )
    }
  } catch {
    handlerProblems.push(`${handlerCase.label}: fixture raised an internal failure`)
  } finally {
    const cleanupSurvivors = killAndConfirmGroups(handlerPgids)
    if (cleanupSurvivors.length > 0) {
      handlerProblems.push(
        `${handlerCase.label}: fixture cleanup could not confirm the announced pgid is gone`
      )
    }
    try {
      rmSync(handlerFixture, { force: true })
    } catch {
      /* best effort */
    }
  }
}
if (handlerProblems.length > 0) {
  fail('signal-handler subtree and scoped-cleanup failures are fail closed', handlerProblems[0])
} else {
  regressionCaught += 1
  pass(
    'signal-handler subtree and scoped-cleanup failures are fail closed',
    'clean cleanup preserves SIGTERM, while residue, invalid return, cleanup throw and ' +
      'both subtree and final-signal primitive failures use fixed exit 1 without caller text; ' +
      'every announced pgid reaches ESRCH'
  )
}

const expectedCount = 6
// `caught` 同时计入确定性反例与 6 个真实窗口，因此完整性判据按**两部分之和**。
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
    'zero docker/secret/image/build-evidence residue)\n'
)
