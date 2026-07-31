#!/usr/bin/env node
// 阶段 09A / M3B 第二轮阻断整改的窄反例。
//
//   node infra/docker/check-m3b-round2-negatives.mjs
//
// 本文件里的每一条都是**先写、先跑、先看它红**，再去实现修复的。它们覆盖总控
// 第二轮点名的七项 P1 里可以在**不启动 Docker 链**的前提下确定性触发的部分：
//
//   一 generator 的原子 promotion（禁止覆盖式 rename、只清理自己创建的路径）
//   二 generator 的 failure-safe cleanup（无吞错、continue-on-failure、独立复查）
//   三 preflight 信号窗口（scene 持续到 preflight 结束、成功输出前再查一次信号）
//   五 全仓 tracked 文件的 Git index containment（staged-only Secret 必须被抓）
//   六 子进程 PGID 生命周期（child 关闭后不得再对失效 PGID 发 SIGKILL）
//
// 四（smoke/probe 最早期窗口）与七的运行期部分需要真实 Docker，放在
// check-m3b-signal-windows.mjs 里。
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  discardGeneratedPaths,
  generateSecretBundle,
  SecretGeneratorError
} from './generate-local-test-secrets.mjs'
import { scanTrackedRepositoryForNeedles } from './local-test-containment.mjs'
import { generatePassword, secretFilenames } from './local-test-secrets-contract.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))

const failures = []
let caught = 0
const pass = (name, reason) => {
  caught += 1
  process.stdout.write(`  caught: ${name} (${reason})\n`)
}
const fail = (name, detail) => {
  failures.push(`${name}: ${detail}`)
}

const git = (args, options = {}) =>
  spawnSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options })

// ---------------------------------------------------------------------------
// 一、generator 的原子 promotion
// ---------------------------------------------------------------------------
process.stdout.write('P1-1: generator atomic promotion\n')

{
  // 并发反例：另一个写者在 promotion **之前**就把某个 final 文件放好了。
  // 覆盖式 rename 会静默改写它；原子 no-replace 必须失败，且外部文件的内容
  // 一个字节都不能变。
  const name = 'promotion never overwrites a pre-existing final file'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r2-'))
  const directory = resolve(parent, 'bundle')
  const victimName = secretFilenames[3]
  const victimBody = `FOREIGN-CONTENT-${randomBytes(8).toString('hex')}\n`
  try {
    mkdirSync(directory, { mode: 0o700 })
    // 先放一个「外部写者」的同名 final 文件。generator 的目录预检会因为
    // 「八份文件之一已存在」而拒绝——所以这里用一个**只在 promotion 阶段**
    // 才出现的竞争者：预检通过之后再放进去。
    const racer = setTimeout(() => {
      writeFileSync(resolve(directory, victimName), victimBody, { mode: 0o600 })
    }, 0)
    let threw = false
    try {
      generateSecretBundle(directory, {
        // 注入点：每份文件 promotion 之前调用，让竞争者恰好赢在第一份之前。
        beforePromotion: (filename) => {
          if (filename === secretFilenames[0]) {
            clearTimeout(racer)
            writeFileSync(resolve(directory, victimName), victimBody, { mode: 0o600 })
          }
        }
      })
    } catch (error) {
      threw = true
      if (!(error instanceof SecretGeneratorError) || !/already exists/.test(String(error))) {
        fail(name, `wrong error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    clearTimeout(racer)
    const survived =
      existsSync(resolve(directory, victimName)) &&
      readFileSync(resolve(directory, victimName), 'utf8') === victimBody
    if (!threw) {
      fail(name, 'NOT CAUGHT — promotion completed over a pre-existing final file')
    } else if (!survived) {
      fail(name, "the foreign file's content was overwritten or removed")
    } else {
      pass(name, 'no-replace promotion refused and the foreign file is byte-identical')
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

{
  // 清理只能删**本轮自己创建的**路径：外部同名文件必须原样留下。
  const name = 'cleanup never deletes a file this run did not create'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r2-'))
  const directory = resolve(parent, 'bundle')
  const foreignName = secretFilenames[5]
  const foreignBody = `FOREIGN-KEEP-${randomBytes(8).toString('hex')}\n`
  try {
    mkdirSync(directory, { mode: 0o700 })
    let promotionRejected = false
    try {
      generateSecretBundle(directory, {
        beforePromotion: (filename) => {
          if (filename === secretFilenames[0]) {
            writeFileSync(resolve(directory, foreignName), foreignBody, { mode: 0o600 })
          }
        }
      })
    } catch (error) {
      // **校验错误身份**：不校验的话，任何无关的提前抛错（此时一个文件都还
      // 没创建）都会让下面两条断言真空成立。
      promotionRejected =
        error instanceof SecretGeneratorError && /already exists/.test(String(error))
      if (!promotionRejected) {
        fail(name, `wrong error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const stillThere =
      existsSync(resolve(directory, foreignName)) &&
      readFileSync(resolve(directory, foreignName), 'utf8') === foreignBody
    const ownLeftovers = readdirSync(directory).filter((entry) => entry !== foreignName)
    if (!promotionRejected) {
      // 前面已经记过 fail；这里直接返回，避免真空通过。
    } else if (!stillThere) {
      fail(name, 'the foreign file was removed by the failure cleanup')
    } else if (ownLeftovers.length > 0) {
      fail(name, `the run left ${String(ownLeftovers.length)} of its own file(s) behind`)
    } else {
      pass(name, 'foreign file untouched, own staging/final all removed')
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 二、generator 的 failure-safe cleanup
// ---------------------------------------------------------------------------
process.stdout.write('P1-2: generator failure-safe cleanup\n')

{
  // 目录权限阻断删除时，八份文件必须**逐一**被报成 residue，且绝不宣称
  // 「was removed」。
  const name = 'blocked cleanup reports every remaining secret as residue'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r2-'))
  const directory = resolve(parent, 'bundle')
  try {
    mkdirSync(directory, { mode: 0o700 })
    generateSecretBundle(directory)
    // 现场登记在成功后被清空，这里手动重放一次「本轮创建了这八份」的状态，
    // 因为要测的是 cleanup 在**删不掉**时的行为。
    const created = secretFilenames.map((filename) => resolve(directory, filename))
    chmodSync(directory, 0o500)
    const outcome = discardGeneratedPaths({ paths: created, verifyDirectory: directory })
    chmodSync(directory, 0o700)
    const remaining = readdirSync(directory).filter((entry) =>
      secretFilenames.includes(entry)
    )
    // 八条「删不掉」+ 一条独立目录复查的汇总。
    const perFile = outcome.residue.filter((entry) =>
      /could not remove a generated secret file/.test(String(entry))
    )
    const sweep = outcome.residue.filter((entry) =>
      /still contains \d+ secret file/.test(String(entry))
    )
    if (perFile.length !== secretFilenames.length) {
      fail(
        name,
        `expected ${String(secretFilenames.length)} per-file residue entries, got ${String(perFile.length)}`
      )
    } else if (sweep.length !== 1) {
      fail(name, 'the independent directory sweep did not report the remaining secrets')
    } else if (outcome.removed.length > 0) {
      fail(name, 'the collector claimed it removed files it could not remove')
    } else if (remaining.length !== secretFilenames.length) {
      fail(name, 'the pre-condition failed: the files were not actually blocked')
    } else if (outcome.residue.some((entry) => /was removed/.test(String(entry)))) {
      fail(name, 'a residue message still claims the file "was removed"')
    } else {
      pass(
        name,
        `all ${String(secretFilenames.length)} blocked files reported as residue, plus the ` +
          'independent directory sweep'
      )
    }
  } finally {
    try {
      chmodSync(directory, 0o700)
    } catch {
      // 目录可能不存在。
    }
    rmSync(parent, { recursive: true, force: true })
  }
}

{
  // cleanup 之后必须**独立枚举目录**确认零 Secret 残留，而不是只相信 unlink
  // 的返回值。
  const name = 'cleanup independently verifies the directory is free of secrets'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r2-'))
  const directory = resolve(parent, 'bundle')
  try {
    mkdirSync(directory, { mode: 0o700 })
    generateSecretBundle(directory)
    const created = secretFilenames.map((filename) => resolve(directory, filename))
    // 只把其中一份交给 collector：它必须在**独立枚举**时发现另外七份仍在。
    const outcome = discardGeneratedPaths({
      paths: [created[0]],
      verifyDirectory: directory
    })
    if (outcome.residue.length === 0) {
      fail(name, 'NOT CAUGHT — seven secret files remained but nothing was reported')
    } else if (!outcome.residue.some((entry) => /still contains \d+ secret file/.test(String(entry)))) {
      fail(name, `wrong reason: ${outcome.residue.join('; ')}`)
    } else {
      pass(name, 'the independent directory sweep reported the remaining secrets')
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 三、preflight 信号窗口
// ---------------------------------------------------------------------------
process.stdout.write('P1-3: preflight signal window\n')

{
  // SIGINT 落在**同步 preflight** 期间：generator 不得 exit 0、不得输出成功、
  // 不得留下八份 Secret，且必须保持原信号语义。
  const name = 'SIGINT during the synchronous preflight leaves nothing and honours the signal'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r2-'))
  const bundle = resolve(parent, 'bundle')
  try {
    const child = spawn(
      process.execPath,
      [resolve(composeDirectory, 'generate-local-test-secrets.mjs'), '--directory', bundle],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // detached：pid 即 pgid，下面才能按**进程组**发信号。
        detached: true,
        env: { ...process.env, MEAL_AGENT_M3B_PREFLIGHT_DELAY_MS: '900' }
      }
    )
    const outcome = await new Promise((resolveOutcome) => {
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
        // 生产代码在进入 preflight 时打这一行（只有窗口标记，无 Secret）。
        if (/entering preflight/.test(stderr)) {
          try {
            process.kill(-child.pid, 'SIGINT')
          } catch {
            child.kill('SIGINT')
          }
        }
      })
      child.once('close', (code, signal) => resolveOutcome({ code, signal, stdout, stderr }))
    })
    const leftovers = existsSync(bundle)
      ? readdirSync(bundle).filter((entry) => secretFilenames.includes(entry))
      : []
    if (!/entering preflight/.test(outcome.stderr)) {
      fail(name, `the preflight window marker never appeared: ${outcome.stderr.trim()}`)
    } else if (leftovers.length > 0) {
      fail(name, `${String(leftovers.length)} secret file(s) survived the interrupted preflight`)
    } else if (/generated the local-test secret bundle/.test(outcome.stdout)) {
      fail(name, 'the generator printed success after being interrupted')
    } else if (outcome.signal !== 'SIGINT') {
      fail(
        name,
        `expected termination by SIGINT, got code=${String(outcome.code)} signal=${String(outcome.signal)}`
      )
    } else {
      pass(name, 'no secrets left, no success output, terminated by SIGINT')
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 五、全仓 Git index containment
// ---------------------------------------------------------------------------
process.stdout.write('P1-5: repository-wide git index containment\n')

{
  // 任意**非模板** tracked 文件：Secret 已 git add，工作树随后恢复干净。
  // 只读工作树的 containment 扫描完全看不见它。
  const name = 'a staged-only secret in an ordinary tracked file is caught'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r2-repo-'))
  try {
    const repo = resolve(parent, 'repo')
    mkdirSync(repo, { recursive: true })
    for (const args of [
      ['init', '--quiet', repo],
      ['-C', repo, 'config', 'user.email', 'r2@example.invalid'],
      ['-C', repo, 'config', 'user.name', 'M3B round two']
    ]) {
      const result = git(args)
      if (result.error !== undefined || result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed`)
      }
    }
    const ordinary = resolve(repo, 'services/api/src/notes.ts')
    mkdirSync(resolve(repo, 'services/api/src'), { recursive: true })
    const pristine = '// nothing sensitive here\nexport const notes = 1\n'
    writeFileSync(ordinary, pristine)
    git(['-C', repo, 'add', '-A'])
    git(['-C', repo, 'commit', '--quiet', '-m', 'baseline'])

    const secret = generatePassword()
    writeFileSync(ordinary, `${pristine}export const leaked = '${secret}'\n`)
    git(['-C', repo, 'add', '--', 'services/api/src/notes.ts'])
    writeFileSync(ordinary, pristine)

    const needles = [{ id: 1, category: 'password:runtime', value: secret }]
    const hits = scanTrackedRepositoryForNeedles(repo, needles)
    const indexHit = hits.some((hit) => /git index/.test(String(hit.label)))
    const leaks = hits.some((hit) => JSON.stringify(hit).includes(secret))
    if (hits.length === 0) {
      fail(name, 'NOT CAUGHT — the staged-only secret was invisible to the scan')
    } else if (!indexHit) {
      fail(name, `caught, but not attributed to the git index: ${JSON.stringify(hits)}`)
    } else if (leaks) {
      fail(name, 'the hit report echoes the secret value')
    } else {
      pass(name, 'the git index blob scan caught it without echoing the value')
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 六、子进程 PGID 生命周期
// ---------------------------------------------------------------------------
process.stdout.write('P1-6: subprocess PGID lifecycle\n')

{
  // child 在约 100ms 就关闭；等待超过 1 秒后**不得**出现对它 PGID 的
  // SIGKILL——否则那个 PGID 可能已经被别的进程组复用。
  const name = 'no SIGKILL is sent to a pgid whose child already closed'
  const observed = []
  const originalKill = process.kill.bind(process)
  process.kill = (pid, signal) => {
    observed.push({ pid, signal })
    return originalKill(pid, signal)
  }
  try {
    const { runCommand, terminateControlledSubtree } = await import('./m3b-subprocess.mjs')
    const started = runCommand(['sh', '-c', 'sleep 0.1'], { timeoutMs: 30_000 })
    await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    // 在 child 仍存活时要求终止：TERM 应当发出，KILL 的升级则必须在 child
    // 关闭后被取消。
    const terminated = terminateControlledSubtree({ graceMs: 1_500 })
    await started.catch(() => undefined)
    await terminated
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
    const kills = observed.filter((entry) => entry.signal === 'SIGKILL')
    const terms = observed.filter((entry) => entry.signal === 'SIGTERM')
    if (terms.length === 0) {
      fail(name, 'the pre-condition failed: no SIGTERM was sent at all')
    } else if (kills.length > 0) {
      fail(
        name,
        `a SIGKILL was sent to a closed child's pgid (${JSON.stringify(kills)})`
      )
    } else {
      pass(name, 'TERM sent, escalation cancelled once the child closed')
    }
  } finally {
    process.kill = originalKill
  }
}

{
  // 反向保证：**真实存活**且忽略 TERM 的后代仍必须被 KILL 收掉。
  const name = 'a descendant that ignores TERM is still killed'
  const { runCommand, terminateControlledSubtree } = await import('./m3b-subprocess.mjs')
  const marker = `m3b-r2-stubborn-${randomBytes(4).toString('hex')}`
  const started = runCommand(
    ['sh', '-c', `trap '' TERM; sleep 30 # ${marker}`],
    { timeoutMs: 30_000 }
  )
  await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  const before = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' })
  await terminateControlledSubtree({ graceMs: 500 })
  await started.catch(() => undefined)
  await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  const after = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' })
  const aliveBefore = before.status === 0 ? before.stdout.split('\n').filter(Boolean).length : 0
  const aliveAfter = after.status === 0 ? after.stdout.split('\n').filter(Boolean).length : 0
  if (aliveBefore === 0) {
    fail(name, 'the pre-condition failed: the stubborn descendant never started')
  } else if (aliveAfter > 0) {
    fail(name, `${String(aliveAfter)} stubborn descendant(s) survived`)
  } else {
    pass(name, `TERM-ignoring descendant went from ${String(aliveBefore)} to 0`)
  }
}

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------
const expectedCount = 8
if (caught + failures.length !== expectedCount) {
  fail(
    'suite completeness',
    `expected ${String(expectedCount)} negatives, got ${String(caught)} caught + ${String(failures.length)} failed`
  )
}
if (failures.length > 0) {
  process.stderr.write('M3B round-two negative suite FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}
process.stdout.write(
  `M3B round-two negative suite PASS (${String(caught)}/${String(expectedCount)} ` +
    'negatives caught with their named reasons)\n'
)
