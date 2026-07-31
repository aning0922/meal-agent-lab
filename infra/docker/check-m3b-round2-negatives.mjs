#!/usr/bin/env node
// 阶段 09A / M3B 第二、三轮阻断整改的窄反例。
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
//
// 第三轮追加（同样是先写、先跑、先看它红）：
//
//   R3-1 cleanup 的 **inode ownership**：外部把成品 unlink 后放了同名替身时，
//        清理必须按 dev/ino 认出「这不是我的」，拒绝 unlink 并报 ownership
//        drift；替身逐字节不变，本轮自己的 staging/final inode 全部收敛
//   R3-2 生产 CLI **没有** preflight 忙等钩子：旧的
//        `MEAL_AGENT_M3B_PREFLIGHT_DELAY_MS` 已从生产源码删除，设置它不改变
//        任何时序；信号窗口回归改由 fixtures/preflight-signal-window.mjs 用
//        库级注入 seam 制造，跑的是真实 runGeneratorCli 与真实 signal handler
//   R3-4 cleanup 集成反例走 **generateAndPreflight 的真实接线**，不只直接调
//        helper
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
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  discardGeneratedPaths,
  generateAndPreflight,
  generateSecretBundle,
  SecretGeneratorError
} from './generate-local-test-secrets.mjs'
import { scanTrackedRepositoryForNeedles } from './local-test-containment.mjs'
import {
  generatePassword,
  repositoryRoot,
  secretFilenames
} from './local-test-secrets-contract.mjs'
import { wrongReason } from './m3b-safe-output.mjs'

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
    // 用**生成器返回的真实 owned 记录**（path + 创建时刻的 dev/ino）重放一次
    // 「本轮创建了这八份」的状态：现场登记在成功后被清空，而要测的是 cleanup
    // 在**删不掉**时的行为。
    const generated = generateSecretBundle(directory)
    chmodSync(directory, 0o500)
    const outcome = discardGeneratedPaths({
      owned: generated.owned,
      verifyDirectory: directory
    })
    chmodSync(directory, 0o700)
    const remaining = readdirSync(directory).filter((entry) =>
      secretFilenames.includes(entry)
    )
    // 八条「删不掉」+ 一条独立目录复查的汇总。
    const perFile = outcome.residue.filter((entry) =>
      /could not remove a generated secret file/.test(String(entry))
    )
    const sweep = outcome.residue.filter((entry) =>
      /still contains \d+ file\(s\) at generated secret name/.test(String(entry))
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
    const generated = generateSecretBundle(directory)
    // 只把其中一份交给 collector：它必须在**独立枚举**时发现另外七份仍在。
    const outcome = discardGeneratedPaths({
      owned: [generated.owned[0]],
      verifyDirectory: directory
    })
    if (outcome.residue.length === 0) {
      fail(name, 'NOT CAUGHT — seven secret files remained but nothing was reported')
    } else if (
      !outcome.residue.some((entry) =>
        /still contains \d+ file\(s\) at generated secret name/.test(String(entry))
      )
    ) {
      fail(name, wrongReason('/still contains N file(s) at generated secret name/', outcome.residue))
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
process.stdout.write('P1-3 / R3-2: preflight signal window and the retired busy-wait hook\n')

{
  // SIGINT 落在**同步 preflight** 期间：generator 不得 exit 0、不得输出成功、
  // 不得留下八份 Secret，且必须保持原信号语义。
  //
  // 窗口由 **fixture** 制造，不再由生产二进制的环境变量分支制造：
  // fixtures/preflight-signal-window.mjs 调的是**真实**的 `runGeneratorCli`
  // （生产 CLI 入口调的同一个函数），只通过库级 `preflight` seam 换上一段
  // 「先打标记、再同步忙等、最后跑真实 checkSecretBundle」的预检。因此真实的
  // installSignalHandlers 处置、真实的 generateAndPreflightInterruptible 与
  // 真实的中断判定全部照原样参与。
  const name = 'SIGINT during the synchronous preflight leaves nothing and honours the signal'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r2-'))
  const bundle = resolve(parent, 'bundle')
  try {
    const child = spawn(
      process.execPath,
      [
        resolve(composeDirectory, 'fixtures/preflight-signal-window.mjs'),
        '--directory',
        bundle,
        '--hold-ms',
        '900'
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // detached：pid 即 pgid，下面才能按**进程组**发信号。
        detached: true
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
        // fixture 在进入同步 preflight 时打这一行（只有窗口标记，无 Secret）。
        if (/entered the synchronous preflight window/.test(stderr)) {
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
    if (!/entered the synchronous preflight window/.test(outcome.stderr)) {
      fail(name, 'the fixture never announced the preflight window')
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
      pass(name, 'no secrets left, no success output, terminated by SIGINT (fixture-driven window)')
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

{
  // R3-2 的反例：**生产 CLI 不认识**任何 preflight 忙等钩子。
  //
  // 两条断言缺一不可：
  //   1. 静态——**全仓任何 tracked 文件**里都不得再出现 `*_PREFLIGHT_DELAY_MS`
  //      这个标识符（只放行本反例文件、fixtures/ 与 Markdown 文档三处）；
  //   2. 动态——把旧环境变量设成 5 秒，真实 CLI 的耗时相对**不设它**的基线
  //      不得出现任何可归因的增长，也不得打印任何窗口标记。
  const name = 'the production generator CLI never busy-waits on the retired preflight env var'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r2-'))
  try {
    const productionSources = [
      'generate-local-test-secrets.mjs',
      'preflight-local-test-secrets.mjs',
      'local-test-secrets-contract.mjs',
      'run-local-test-smoke.mjs',
      'probe-compose-secret-identity.mjs',
      'local-test-containment.mjs',
      'm3b-docker.mjs',
      'm3b-subprocess.mjs',
      'm3b-safe-output.mjs',
      'compose.local-test.yaml'
    ]
    const offenders = productionSources.filter((file) =>
      /PREFLIGHT_DELAY_MS/.test(readFileSync(resolve(composeDirectory, file), 'utf8'))
    )

    const runCli = async (extraEnv) => {
      const directory = resolve(parent, `bundle-${randomBytes(4).toString('hex')}`)
      const startedAt = Date.now()
      const outcome = await new Promise((resolveOutcome) => {
        const child = spawn(
          process.execPath,
          [
            resolve(composeDirectory, 'generate-local-test-secrets.mjs'),
            '--directory',
            directory
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } }
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString('utf8')
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8')
        })
        child.once('close', (code) => resolveOutcome({ code, stdout, stderr }))
      })
      return { ...outcome, elapsedMs: Date.now() - startedAt, directory }
    }

    const requestedDelayMs = 5_000
    const baseline = await runCli({})
    const withRetiredVariable = await runCli({
      MEAL_AGENT_M3B_PREFLIGHT_DELAY_MS: String(requestedDelayMs)
    })
    // 判据是**相对基线**的增量，不是一个绝对墙钟阈值：机器负载会同时抬高两次
    // 运行，只有「那 5 秒真的被等了」才会让差值逼近 5 秒。
    const overhead = withRetiredVariable.elapsedMs - baseline.elapsedMs
    const marker = /entering preflight|preflight window/.test(withRetiredVariable.stderr)

    if (offenders.length > 0) {
      fail(
        name,
        `${String(offenders.length)} tracked file(s) outside the test/documentation ` +
          'allowlist still reference the retired preflight delay variable'
      )
    } else if (baseline.code !== 0 || withRetiredVariable.code !== 0) {
      fail(
        name,
        `the precondition failed: the CLI did not succeed (baseline=${String(baseline.code)}, ` +
          `withVariable=${String(withRetiredVariable.code)})`
      )
    } else if (marker) {
      fail(name, 'the production CLI still announced a preflight window')
    } else if (overhead > requestedDelayMs / 2) {
      fail(
        name,
        `the retired variable still cost ${String(overhead)}ms over the baseline ` +
          `(a live busy-wait would cost about ${String(requestedDelayMs)}ms)`
      )
    } else {
      pass(
        name,
        `no tracked reference outside the test/doc allowlist, no window marker, ` +
          `${String(overhead)}ms overhead against a requested ${String(requestedDelayMs)}ms delay`
      )
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// R3-1：cleanup 的 inode ownership
// ---------------------------------------------------------------------------
process.stdout.write('R3-1: cleanup honours inode ownership\n')

{
  // 场景（总控点名的五步）：
  //   1. 第一份 final 完成 promotion；
  //   2. 外部把它 unlink，并在同名位置写入一个**不同 inode** 的替身；
  //   3. 第二次 promotion 之前抛错，触发失败清理；
  //   4. 替身必须仍在，且逐字节不变；
  //   5. 本轮自己的 staging 与 final inode 必须全部收敛（目录里只剩替身）。
  //
  // 只登记路径的实现在第 4 步就会红：它会按名字把替身 unlink 掉。
  const name = 'failure cleanup refuses to unlink an external replacement at a generated name'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r3-'))
  const directory = resolve(parent, 'bundle')
  const victimName = secretFilenames[0]
  const replacementBody = `EXTERNAL-REPLACEMENT-${randomBytes(8).toString('hex')}\n`
  const injectedMarker = `injected-failure-${randomBytes(4).toString('hex')}`
  try {
    mkdirSync(directory, { mode: 0o700 })
    let replacementIno = null
    let caughtError = null
    try {
      generateSecretBundle(directory, {
        beforePromotion: (filename) => {
          // 第二份 promotion 之前：换掉第一份的 final，然后抛错。
          if (filename !== secretFilenames[1]) {
            return
          }
          const victimPath = resolve(directory, victimName)
          unlinkSync(victimPath)
          writeFileSync(victimPath, replacementBody, { mode: 0o600 })
          replacementIno = statSync(victimPath, { bigint: true }).ino
          throw new Error(injectedMarker)
        }
      })
    } catch (error) {
      caughtError = error
    }
    const message = caughtError instanceof Error ? caughtError.message : String(caughtError)
    const replacementPath = resolve(directory, victimName)
    const survived =
      existsSync(replacementPath) && readFileSync(replacementPath, 'utf8') === replacementBody
    const sameInode =
      survived && replacementIno !== null && statSync(replacementPath, { bigint: true }).ino === replacementIno
    const leftovers = readdirSync(directory).filter((entry) => entry !== victimName)

    if (caughtError === null) {
      fail(name, 'the precondition failed: the injected failure did not propagate')
    } else if (!message.includes(injectedMarker)) {
      fail(name, wrongReason(`/${injectedMarker}/`, [message]))
    } else if (!survived) {
      fail(name, 'the external replacement was removed or rewritten by the failure cleanup')
    } else if (!sameInode) {
      fail(name, 'the entry at that name is no longer the external replacement inode')
    } else if (leftovers.length > 0) {
      fail(
        name,
        `${String(leftovers.length)} entr(y|ies) created by this run survived the cleanup`
      )
    } else if (!/ownership drift/.test(message)) {
      fail(name, wrongReason('/ownership drift/', [message]))
    } else {
      pass(
        name,
        'replacement byte-identical and still the same inode, every own staging/final inode ' +
          'converged, ownership drift reported'
      )
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

{
  // R3-1（staging 侧）：`link(2)` 解析的是**名字**。审计实测：把 staging 名换成
  // 一个外部 inode 之后，旧实现会 (a) 把**外部** inode 链到成品名上、(b) 用
  // **我们的** dev/ino 登记它、(c) unlink 掉那个外部 staging 文件、(d) 返回
  // **成功**——同时删了别人的文件、又把别人的内容留在了一个规范 Secret 名上。
  // 正确行为：promotion 之前先证明 staging 名仍指向本轮创建的 inode，对不上就
  // 拒绝，既不链接也不删除。
  const name = 'promotion refuses a staging name that no longer refers to this run\'s inode'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r3-'))
  const directory = resolve(parent, 'bundle')
  const first = secretFilenames[0]
  const stagingName = `.staging.${first}`
  const foreignBody = `FOREIGN-STAGING-${randomBytes(8).toString('hex')}\n`
  try {
    mkdirSync(directory, { mode: 0o700 })
    let caughtError = null
    let foreignIno = null
    try {
      generateSecretBundle(directory, {
        beforePromotion: (filename) => {
          if (filename !== first) {
            return
          }
          unlinkSync(resolve(directory, stagingName))
          writeFileSync(resolve(directory, stagingName), foreignBody, { mode: 0o600 })
          foreignIno = statSync(resolve(directory, stagingName), { bigint: true }).ino
        }
      })
    } catch (error) {
      caughtError = error
    }
    const message = caughtError instanceof Error ? caughtError.message : String(caughtError)
    const stagingPath = resolve(directory, stagingName)
    const foreignSurvived =
      existsSync(stagingPath) &&
      readFileSync(stagingPath, 'utf8') === foreignBody &&
      foreignIno !== null &&
      statSync(stagingPath, { bigint: true }).ino === foreignIno
    const promotedAnyway = existsSync(resolve(directory, first))
    const ownLeftovers = readdirSync(directory).filter((entry) => entry !== stagingName)

    if (caughtError === null) {
      fail(name, 'NOT CAUGHT — the run promoted a swapped staging name and returned success')
    } else if (promotedAnyway) {
      fail(name, 'the foreign inode was linked into a canonical secret filename anyway')
    } else if (!foreignSurvived) {
      fail(name, "the foreign staging file was unlinked — this run deleted a file it did not create")
    } else if (ownLeftovers.length > 0) {
      fail(name, `${String(ownLeftovers.length)} entr(y|ies) created by this run survived`)
    } else if (!/ownership drift at the staging entry/.test(message)) {
      fail(name, wrongReason('/ownership drift at the staging entry/', [message]))
    } else {
      pass(
        name,
        'no promotion, no unlink of the foreign file, every own entry cleaned, drift reported'
      )
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

{
  // R3-4：同一条 ownership 纪律必须在 **generateAndPreflight 的真实接线**上
  // 成立，而不只是直接调 discardGeneratedPaths。这里让**真实**的预检返回
  // problems 触发真实的失败清理，替身在预检期间被放进去。
  const name = "generateAndPreflight's real failure cleanup honours inode ownership"
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r3-'))
  const directory = resolve(parent, 'bundle')
  const victimName = secretFilenames[2]
  const replacementBody = `EXTERNAL-REPLACEMENT-${randomBytes(8).toString('hex')}\n`
  try {
    let replacementIno = null
    let caughtError = null
    try {
      generateAndPreflight(directory, {
        // 库级注入 seam：预检期间外部换掉一份成品，然后判定失败。
        preflight: (bundleDirectory) => {
          const victimPath = resolve(bundleDirectory, victimName)
          unlinkSync(victimPath)
          writeFileSync(victimPath, replacementBody, { mode: 0o600 })
          replacementIno = statSync(victimPath, { bigint: true }).ino
          return { problems: ['synthetic preflight rejection'], bodies: new Map() }
        }
      })
    } catch (error) {
      caughtError = error
    }
    const message = caughtError instanceof Error ? caughtError.message : String(caughtError)
    const replacementPath = resolve(directory, victimName)
    const survived =
      existsSync(replacementPath) && readFileSync(replacementPath, 'utf8') === replacementBody
    const sameInode =
      survived && replacementIno !== null && statSync(replacementPath, { bigint: true }).ino === replacementIno
    const ownLeftovers = readdirSync(directory).filter((entry) => entry !== victimName)

    if (caughtError === null) {
      fail(name, 'the precondition failed: the failing preflight did not propagate')
    } else if (!survived) {
      fail(name, 'the external replacement was removed by the real failure cleanup')
    } else if (!sameInode) {
      fail(name, 'the entry at that name is no longer the external replacement inode')
    } else if (ownLeftovers.length > 0) {
      fail(name, `${String(ownLeftovers.length)} of this run's own secret file(s) survived`)
    } else if (!/ownership drift/.test(message)) {
      fail(name, wrongReason('/ownership drift/', [message]))
    } else {
      pass(name, 'real generateAndPreflight wiring: replacement untouched, own files all removed')
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
const expectedCount = 12
if (caught + failures.length !== expectedCount) {
  fail(
    'suite completeness',
    `expected ${String(expectedCount)} negatives, got ${String(caught)} caught + ${String(failures.length)} failed`
  )
}
if (failures.length > 0) {
  process.stderr.write('M3B round-two/three negative suite FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}
process.stdout.write(
  `M3B round-two/three negative suite PASS (${String(caught)}/${String(expectedCount)} ` +
    'negatives caught with their named reasons)\n'
)
