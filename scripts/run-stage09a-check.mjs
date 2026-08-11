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
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
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
let activeChild = null

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interruptedBy !== null) {
      return
    }
    interruptedBy = signal
    process.stderr.write(`\nstage09a:check: received ${signal}; forwarding to the active step and waiting for its cleanup\n`)
    if (activeChild !== null) {
      activeChild.kill('SIGTERM')
      // 兜底：子门禁的清理自身有界，这里只防它彻底卡死。该定时器不 unref——
      // 关机路径上 unref 过的定时器可能永远不触发（logger 边界的既有教训）。
      setTimeout(() => {
        if (activeChild !== null) {
          activeChild.kill('SIGKILL')
        }
      }, 120_000)
    }
  })
}

const probe = (argv, label) =>
  new Promise((resolvePromise) => {
    let settled = false
    const child = spawn(argv[0], argv.slice(1), { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        resolvePromise({ ok: false, label, detail: 'probe timed out' })
      }
    }, 60_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        resolvePromise({ ok: false, label, detail: error.message })
      }
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        resolvePromise({
          ok: code === 0,
          label,
          detail: code === 0 ? Buffer.concat(chunks).toString('utf8').trim().split('\n')[0] : `exit ${String(code)}`
        })
      }
    })
  })

const runStep = (step) =>
  new Promise((resolvePromise) => {
    const argv = step.forwardsKeepFailure === true && keepFailure ? [...step.argv, '--keep-failure'] : step.argv
    const startedAt = performance.now()
    const child = spawn(argv[0], argv.slice(1), { cwd: repositoryRoot, stdio: 'inherit' })
    activeChild = child
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      process.stderr.write(`stage09a:check: step ${step.id} exceeded its backstop timeout; sending SIGTERM\n`)
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 120_000)
    }, step.timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      activeChild = null
      resolvePromise({ ok: false, detail: `failed to start (${error.message})`, exitCode: 1, seconds: 0 })
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      activeChild = null
      const seconds = Math.round((performance.now() - startedAt) / 1000)
      if (timedOut) {
        resolvePromise({ ok: false, detail: `backstop timeout, then ${signal ?? `exit ${String(code)}`}`, exitCode: 1, seconds })
        return
      }
      if (interruptedBy !== null) {
        resolvePromise({ ok: false, detail: `interrupted by ${interruptedBy}`, exitCode: 1, seconds })
        return
      }
      if (signal !== null) {
        resolvePromise({ ok: false, detail: `killed by ${signal}`, exitCode: 1, seconds })
        return
      }
      resolvePromise({ ok: code === 0, detail: code === 0 ? 'PASS' : `exit ${String(code)}`, exitCode: code ?? 1, seconds })
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

// ---- 前置工具 ----
const probes = [
  await probe(['docker', 'version', '--format', '{{.Server.Version}}'], 'Docker daemon'),
  await probe(['docker', 'compose', 'version', '--short'], 'Docker Compose v2'),
  await probe(['git', '--version'], 'git'),
  await probe(['pnpm', '--version'], 'pnpm')
]
const missingTools = probes.filter((entry) => !entry.ok)
if (missingTools.length > 0) {
  process.stderr.write('stage09a:check FAIL — missing prerequisite tools; no checks were run:\n')
  for (const entry of missingTools) {
    process.stderr.write(`  - ${entry.label}: ${entry.detail}\n`)
  }
  process.stderr.write('Docker Engine with Compose v2 must be running before this gate can produce evidence.\n')
  process.exit(1)
}
process.stdout.write(
  `stage09a:check: prerequisites present (Docker daemon ${probes[0].detail}, Compose ${probes[1].detail})\n`
)

// ---- 顺序执行，fail fast ----
let failedStep = null
for (const [index, step] of steps.entries()) {
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
  process.stdout.write(`stage09a:check step ${String(index + 1)}/${String(steps.length)} PASS (${String(result.seconds)}s)\n`)
  if (interruptedBy !== null) {
    failedStep = { step, result: { ...result, ok: false, detail: `interrupted by ${interruptedBy}` } }
    results[results.length - 1] = failedStep.result
    break
  }
}

printSummary()
if (failedStep !== null) {
  process.stderr.write(
    `stage09a:check FAIL at step ${failedStep.step.id} (${failedStep.result.detail}); later steps were not run\n`
  )
  process.exit(failedStep.result.exitCode === 0 ? 1 : failedStep.result.exitCode)
}
process.stdout.write(`stage09a:check PASS (${String(steps.length)}/${String(steps.length)} steps)\n`)
