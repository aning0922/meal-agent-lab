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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runImageTagPrefix } from './m3b-docker.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repositoryRoot = resolve(composeDirectory, '..', '..')
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')

const failures = []
let caught = 0
const pass = (name, reason) => {
  caught += 1
  process.stdout.write(`  caught: ${name} (${reason})\n`)
}
const fail = (name, detail) => {
  failures.push(`${name}: ${detail}`)
}

const docker = (args) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

const listByLabel = (kind, project) => {
  const base =
    kind === 'container'
      ? ['ps', '-aq']
      : kind === 'network'
        ? ['network', 'ls', '-q']
        : ['volume', 'ls', '-q']
  const result = docker([...base, '--filter', `label=com.docker.compose.project=${project}`])
  if (result.status !== 0) {
    throw new Error(`docker ${base.join(' ')} failed while checking residue`)
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
  waitForProcess = null
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
          } else {
            await sleep(1_500)
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
    const image = docker(['image', 'inspect', '--format', '{{.Id}}', scene.imageTag])
    if (image.status === 0) {
      problems.push(`image tag ${scene.imageTag} still exists`)
    } else if (!/No such image|no such image/.test(image.stderr ?? '')) {
      // 只有「镜像不存在」才算已删除；daemon 不可达等非零退出不得被读成通过。
      problems.push(
        `could not determine whether ${scene.imageTag} still exists ` +
          `(docker image inspect exited ${String(image.status)})`
      )
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
  // pgrep 找不到匹配时退出码是 1（正常），其余非零退出说明**无法判定**。
  const dockerChildren = spawnSync('pgrep', ['-f', scene.project], { encoding: 'utf8' })
  if (dockerChildren.error !== undefined || ![0, 1].includes(dockerChildren.status)) {
    problems.push(
      `could not determine whether docker child processes remain ` +
        `(pgrep exited ${String(dockerChildren.status)})`
    )
  } else if (dockerChildren.status === 0) {
    const alive = dockerChildren.stdout.split('\n').filter(Boolean)
    problems.push(
      `${String(alive.length)} process(es) referencing this project are still alive`
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
  // 本套件不应留下任何临时 secret 目录（除了被测 CLI 自己的那一个，已在上面
  // 单独断言）。
  const strayBundles = readdirSync(tmpdir()).filter(
    (entry) =>
      entry.startsWith('meal-agent-m3b-secrets-') || entry.startsWith('meal-agent-m3b-probe-')
  )
  const ownBundle =
    scene.secretsDirectory === null ? null : scene.secretsDirectory.split('/').pop()
  const foreignBundles = strayBundles.filter((entry) => entry !== ownBundle)
  if (foreignBundles.length > 0) {
    problems.push(
      `${String(foreignBundles.length)} temporary secret director(y|ies) remain in tmpdir`
    )
  }
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
  const reportedFailures = result.stdout
    .split('\n')
    .filter((line) => /^FAIL: |cleanup residue:/.test(line))
  if (reportedFailures.length > 0) {
    problems.push(`the CLI reported its own problems: ${reportedFailures.join(' | ')}`)
  }
  const reportedResidue = result.stderr
    .split('\n')
    .filter((line) => /residue after SIG/.test(line))
  if (reportedResidue.length > 0) {
    problems.push(`the signal handler reported residue: ${reportedResidue.join(' | ')}`)
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

const expectedCount = 3
if (caught + failures.length !== expectedCount) {
  fail(
    'suite completeness',
    `expected ${String(expectedCount)} signal windows, got ${String(caught)} caught + ${String(failures.length)} failed`
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
  `M3B signal-window suite PASS (${String(caught)}/${String(expectedCount)} windows: ` +
    'children gone, tracked files unchanged, zero docker/secret/image residue)\n'
)
