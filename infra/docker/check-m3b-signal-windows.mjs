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
const runAndSignal = async ({ script, trigger, signal, timeoutMs = 900_000 }) => {
  const child = spawn(process.execPath, [resolve(composeDirectory, script)], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })
  let stdout = ''
  let stderr = ''
  let signalled = false
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
        // 给它一点时间真正进入那个窗口（例如 build 已经在跑）。
        setTimeout(() => {
          try {
            child.kill(signal)
          } catch {
            // 已退出。
          }
        }, 1_500)
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
  return { ...outcome, stdout, stderr, scene, signalled, pid: child.pid }
}

const assertCleanScene = (name, result, { expectSignal }) => {
  const { scene } = result
  if (!result.signalled) {
    fail(name, `the trigger never matched; output was:\n${result.stdout.slice(-500)}`)
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
    }
  }
  if (scene.secretsDirectory !== null && existsSync(scene.secretsDirectory)) {
    problems.push('the temporary secrets directory still exists')
  }
  const overrides = readdirSync(composeDirectory).filter((entry) =>
    entry.startsWith('.m3b-image-override-')
  )
  if (overrides.length > 0) {
    problems.push(`${String(overrides.length)} compose override file(s) left behind`)
  }
  if (processAlive(result.pid)) {
    problems.push('the CLI process is still alive')
  }
  const dockerChildren = spawnSync('sh', ['-c', `pgrep -f "${scene.project}" | wc -l`], {
    encoding: 'utf8'
  })
  if (Number(dockerChildren.stdout.trim()) > 0) {
    problems.push('a docker child process referencing this project is still alive')
  }
  const dirty = spawnSync('git', ['status', '--porcelain', '--', composeFile], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  })
  if (dirty.status !== 0 || dirty.stdout.trim() !== '') {
    problems.push('the tracked compose file is dirty')
  }
  const semanticsOk =
    result.closeSignal === expectSignal || result.code === (expectSignal === 'SIGINT' ? 130 : 143)
  if (!semanticsOk) {
    problems.push(
      `expected ${expectSignal} semantics, got code=${String(result.code)} signal=${String(result.closeSignal)}`
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

// 窗口 1：build 阶段（此时有一个长时间运行的 docker build 子进程）。
assertCleanScene(
  'SIGINT during the smoke build window',
  await runAndSignal({
    script: 'run-local-test-smoke.mjs',
    trigger: /per-run image tag: /,
    signal: 'SIGINT'
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
