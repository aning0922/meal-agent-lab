#!/usr/bin/env node
// 阶段 09A / M3B：**targeted negative suite**（定点窄反例套件）。
//
//   node infra/docker/check-m3b-round2-negatives.mjs
//
// 文件名保留 `check-m3b-round2-negatives.mjs` 只是为了不改动已被文档与流程引用
// 的入口；**套件名称不再带轮次**。轮次编号会随每一次整改过期，把它写进当前门禁
// 的名字，等于每加一轮就得改一次名字、而且旧名字立刻变成错的。下面各节标题里的
// `P1-*` / `R3-*` / `R4-*` / `R5-*` / `R6` 是**历史实施记录**的锚点，标明每条
// 反例是哪一轮加的，不构成套件的当前名称。
//
// 本文件里的每一条都是**先写、先跑、先看它红**，再去实现修复的。它们覆盖总控
// 第二轮点名的七项 P1 里可以确定性触发的部分。**注意：本套件会启动真实 Docker
// 链**——P1-4 那条 case 通过 PATH shim 跑真实的 `run-local-test-smoke.mjs`：
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
//
// 第四轮追加（同样先证明旧行为会红）：
//
//   R4-1 one-shot ExitCode **fail closed**：`docker inspect` 退出 0 却不打印时
//        必须拒绝，退出码文本只接受规范的非负十进制整数且必须是安全整数；
//        含一条**真实调用链**反例（PATH shim 让 ExitCode inspect 返回
//        status=0 + 空 stdout，smoke 必须失败且不记录 exit=0）
//   R4-2 「资源不存在」对**整串** `stderr.trim()` 锚定匹配（不带 `m` 标志），
//        三处判据共用同一个 `isAbsenceMessage`，退出码必须仍精确等于 1
//   R4-3 模板扫描按**解码后**的 query key 判定 credential 参数
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
import {
  collectDockerArtifactsForProject,
  scanTrackedRepositoryForNeedles
} from './local-test-containment.mjs'
import {
  generatePassword,
  nodeActiveAssignment,
  repositoryRoot,
  scanTrackedTemplates,
  secretFilenames
} from './local-test-secrets-contract.mjs'
import {
  imageIdOf,
  isAbsenceMessage,
  parseInspectedExitCode
} from './m3b-docker.mjs'
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

/**
 * 把一行写进一个**临时 git 仓库**的 tracked 模板，再用真实的
 * `scanTrackedTemplates` 扫它。绝不变异仓库里的真实模板，因此本套件对工作树的
 * 副作用恒为零。
 */
const templateProblemsFor = (line, filename = 'local-test.env.example') => {
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-tmpl-repo-'))
  try {
    const repo = resolve(parent, 'repo')
    const templateDirectory = resolve(repo, 'infra/environments/local-test')
    mkdirSync(templateDirectory, { recursive: true })
    for (const args of [
      ['init', '--quiet', repo],
      ['-C', repo, 'config', 'user.email', 'templates@example.invalid'],
      ['-C', repo, 'config', 'user.name', 'M3B template negatives']
    ]) {
      const result = git(args)
      if (result.error !== undefined || result.status !== 0) {
        throw new Error(`git ${args[0]} failed`)
      }
    }
    // 文件名决定角色：`.env` 家族走 strict dotenv，README 等走 prose-aware。
    writeFileSync(resolve(templateDirectory, filename), `WECHAT_APP_ID=\n${line}\n`)
    if (filename !== 'local-test.env.example') {
      // 始终留一份合法的 .env.example，避免「零 tracked 模板」抛错。
      writeFileSync(resolve(templateDirectory, 'local-test.env.example'), 'WECHAT_APP_ID=\n')
    }
    git(['-C', repo, 'add', '-A'])
    git(['-C', repo, 'commit', '--quiet', '-m', 'baseline'])
    return scanTrackedTemplates(repo)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

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
// R4-1：one-shot ExitCode 的 fail-closed 读取
// ---------------------------------------------------------------------------
process.stdout.write('R4-1: one-shot ExitCode is read fail closed\n')

{
  // 解析器层：`Number()` 会把 `''`/`'  '`/`'\n'` 变成 0，把 `'+3'`/`'1.0'`/
  // `'1e3'`/`'0x10'` 变成数字。旧实现正是 `Number(text)` + `Number.isInteger`，
  // 因此第一类会把「读不到退出码」记成「这一步退出码为 0」。
  const name = 'the exit-code parser rejects every non-canonical numeric form'
  const rejected = ['', ' ', '\n', '  12', '12 ', '+3', '-1', '1.0', '1e3', '0x10', '01', 'abc', 'NaN', 'Infinity']
  const accepted = [['0', 0], ['1', 1], ['137', 137], ['255', 255]]
  const unsafe = '9007199254740993'
  const wrongly = rejected.filter((raw) => parseInspectedExitCode(raw).ok)
  const missed = accepted.filter(([raw, value]) => {
    const parsed = parseInspectedExitCode(raw)
    return !parsed.ok || parsed.value !== value
  })
  const unsafeAccepted = parseInspectedExitCode(unsafe).ok
  if (wrongly.length > 0) {
    fail(name, `${String(wrongly.length)} non-canonical form(s) were accepted as an exit code`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} canonical form(s) were rejected or mis-parsed`)
  } else if (unsafeAccepted) {
    fail(name, 'a value beyond the safe integer range was accepted')
  } else {
    pass(
      name,
      `${String(rejected.length)} non-canonical forms rejected (empty/blank/signed/float/` +
        `exponent/hex/leading-zero included), ${String(accepted.length)} canonical forms parsed, ` +
        'unsafe integer rejected'
    )
  }
}

{
  // **真实调用链**反例：PATH shim 让 `docker inspect --format {{.State.ExitCode}}`
  // 退出 0 且不打印任何东西（其余 docker 调用原样透传）。容器真实退出码本来
  // 就是 0，所以旧实现会把这次读不到读成 exit=0 并**照常通过整条 smoke**；
  // 新实现必须在第一个一次性服务上失败，且绝不记录任何 `exit=` 行。
  const name = 'an empty ExitCode payload fails the smoke instead of being recorded as exit=0'
  const shimDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r4-shim-'))
  try {
    const realDocker = spawnSync('which', ['docker'], { encoding: 'utf8' })
    if (realDocker.error !== undefined || realDocker.status !== 0) {
      fail(name, 'the precondition failed: the real docker path could not be resolved')
    } else {
      const shimPath = resolve(shimDirectory, 'docker')
      writeFileSync(
        shimPath,
        '#!/bin/sh\n' +
          'if [ "$1" = "inspect" ]; then\n' +
          '  for a in "$@"; do\n' +
          '    case "$a" in\n' +
          '      *State.ExitCode*) exit 0 ;;\n' +
          '    esac\n' +
          '  done\n' +
          'fi\n' +
          `exec ${realDocker.stdout.trim()} "$@"\n`,
        { mode: 0o700 }
      )
      const outcome = await new Promise((resolveOutcome) => {
        const child = spawn(
          process.execPath,
          [resolve(composeDirectory, 'run-local-test-smoke.mjs')],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              PATH: `${shimDirectory}:${process.env.PATH ?? ''}`
            }
          }
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
      const recordedExit = /chain [a-z-]+: exit=/.test(outcome.stdout)
      const refused = /exited 0 but printed nothing|refusing to read an exit code/.test(
        outcome.stdout
      )
      const claimedPass = /local-test smoke PASS/.test(outcome.stdout)
      if (claimedPass) {
        fail(name, 'NOT CAUGHT — the smoke passed while its exit-code reads returned nothing')
      } else if (recordedExit) {
        fail(name, 'a one-shot exit code was recorded from an empty inspect payload')
      } else if (!refused) {
        fail(name, wrongReason('/exited 0 but printed nothing/', [String(outcome.code)]))
      } else if (outcome.code === 0) {
        fail(name, 'the smoke reported failure but still exited 0')
      } else {
        pass(name, 'the smoke refused the empty payload, recorded no exit code and exited non-zero')
      }
    }
  } finally {
    rmSync(shimDirectory, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// R4-2：「资源不存在」必须整串匹配
// ---------------------------------------------------------------------------
process.stdout.write('R4-2: absence is judged on the whole trimmed stderr\n')

{
  // 三处判据（imageIdOf / containerPresence / 信号窗口）共用同一个
  // `isAbsenceMessage`。旧实现按行匹配（`m` 标志），于是多行包装的错误里只要
  // **某一行**长得像「不存在」就整条被读成「资源已消失」。
  const name = 'a prefixed, suffixed or multi-line wrapped message is never read as absence'
  const tag = 'meal-agent-api:m3b-r4probe'
  const container = 'meal-agent-m3b-r4-probe'
  const shapes = [
    ['exact image message', `Error response from daemon: No such image: ${tag}`, 'image', tag, true],
    ['exact object message', `error: no such object: ${container}`, 'object', container, true],
    ['surrounding whitespace', `  Error response from daemon: No such image: ${tag} \n`, 'image', tag, true],
    ['prefixed line', `warning: retrying\nError response from daemon: No such image: ${tag}`, 'image', tag, false],
    ['suffixed line', `Error response from daemon: No such image: ${tag}\nsee the daemon logs`, 'image', tag, false],
    ['inline prefix', `context deadline exceeded: Error response from daemon: No such image: ${tag}`, 'image', tag, false],
    ['inline suffix', `Error response from daemon: No such image: ${tag} (will retry)`, 'image', tag, false],
    ['another object', 'Error response from daemon: No such image: other/image:latest', 'image', tag, false],
    ['another container', 'error: no such object: some-other-container', 'object', container, false]
  ]
  const wrong = shapes.filter(
    ([, stderr, kind, subject, expected]) =>
      isAbsenceMessage(stderr, { kind, name: subject }) !== expected
  )

  // 退出码同样必须**恰好是 1**：用 shim 让 docker 以 7 退出却打印完全正确的
  // 「不存在」消息，`imageIdOf` 必须抛而不是返回 null。
  const shimDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r4-shim-'))
  let statusHonoured = null
  let wrappedHonoured = null
  try {
    const writeShim = (script) => {
      writeFileSync(resolve(shimDirectory, 'docker'), `#!/bin/sh\n${script}`, { mode: 0o700 })
      return { ...process.env, PATH: `${shimDirectory}:${process.env.PATH ?? ''}` }
    }
    const exactMessage = `Error response from daemon: No such image: ${tag}`
    let env = writeShim(`echo "${exactMessage}" >&2\nexit 7\n`)
    statusHonoured = await imageIdOf(tag, { env }).then(
      (value) => (value === null ? 'read as absent' : 'read as present'),
      () => 'threw'
    )
    env = writeShim(`echo "warning: retrying" >&2\necho "${exactMessage}" >&2\nexit 1\n`)
    wrappedHonoured = await imageIdOf(tag, { env }).then(
      (value) => (value === null ? 'read as absent' : 'read as present'),
      () => 'threw'
    )
  } finally {
    rmSync(shimDirectory, { recursive: true, force: true })
  }

  if (wrong.length > 0) {
    fail(name, `${String(wrong.length)} stderr shape(s) were judged incorrectly`)
  } else if (statusHonoured !== 'threw') {
    fail(name, `a non-1 exit code with a perfect absence message was ${statusHonoured}`)
  } else if (wrappedHonoured !== 'threw') {
    fail(name, `a multi-line wrapped absence message was ${wrappedHonoured}`)
  } else {
    pass(
      name,
      `${String(shapes.length)} stderr shapes judged correctly; exit 7 with a perfect message ` +
        'and a wrapped exit-1 message both fail closed'
    )
  }
}

// ---------------------------------------------------------------------------
// R4-3：模板扫描识别**解码后**的 credential query key
// ---------------------------------------------------------------------------
process.stdout.write('R4-3: encoded credential query keys are decoded before judging\n')

{
  // 只在原始文本上匹配词干时，`pass%77ord` 这类百分号编码在字节层面根本不含
  // `password`，于是整条连接串静默进 Git。判据改为按 WHATWG URL 解析后的
  // query key 判定。
  const name = 'percent-encoded and case-variant credential query keys are caught'
  const shapes = [
    ['pass%77ord', 'CACHE_A=redis://redis:6379?pass%77ord=SYNTHETIC-A', true],
    ['%70assword', 'CACHE_B=redis://redis:6379?%70assword=SYNTHETIC-B', true],
    ['access%5Ftoken', 'SEARCH_A=https://search.invalid/index?access%5Ftoken=SYNTHETIC-C', true],
    ['upper/mixed case', 'QUEUE_A=amqp://broker:5672?PassWord=SYNTHETIC-D', true],
    ['separator variant', 'SEARCH_B=https://search.invalid/index?X-API-KEY=SYNTHETIC-E', true],
    ['benign query', 'PG_A=postgresql://postgres:5432/db?sslmode=require', false],
    ['empty placeholder', 'CACHE_C=redis://redis:6379?password=', false]
  ]
  const misjudged = []
  const leaking = []
  for (const [label, line, expected] of shapes) {
    const problems = templateProblemsFor(line)
    const caught = problems.some((problem) => /connection string/.test(problem))
    if (caught !== expected) {
      misjudged.push(label)
    }
    const injected = line.slice(line.indexOf('=') + 1)
    if (problems.some((problem) => problem.includes(injected) || /SYNTHETIC-/.test(problem))) {
      leaking.push(label)
    }
  }
  if (misjudged.length > 0) {
    fail(name, `${String(misjudged.length)} encoded/benign query shape(s) were judged incorrectly`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message echoed the value or the full DSN (not reprinted here)')
  } else {
    pass(
      name,
      `${String(shapes.length)} shapes judged correctly (percent-encoded, case and separator ` +
        'variants caught; benign query and empty placeholder not flagged; no value echoed)'
    )
  }
}

// ---------------------------------------------------------------------------
// R5-1：absence 判据对**内嵌换行**的 stderr fail closed
// ---------------------------------------------------------------------------
process.stdout.write('R5-1: an absence message that spans lines is refused\n')

// 只去掉 `m` 标志是不够的：正则里的 `\s` 本身就跨行，于是两行 stderr 仍然整串
// 匹配成功、被读成「资源不存在」。判据现在先看 `trim()` 之后还有没有 CR/LF，
// 再用只含**水平**空白（`[ \t]*`）的正则。每种换行形态**各一条**反例，并且
// 都同时走**纯函数**与**真实 imageIdOf + PATH shim** 两条路径。
const absenceProbeTag = 'meal-agent-api:m3b-r5probe'

/** 用 PATH shim 让 docker 以指定退出码打印指定 stderr，再问真实的 imageIdOf。 */
const imageIdVerdictThroughShim = async (script) => {
  const shimDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-r5-shim-'))
  try {
    writeFileSync(resolve(shimDirectory, 'docker'), `#!/bin/sh\n${script}`, { mode: 0o700 })
    const env = { ...process.env, PATH: `${shimDirectory}:${process.env.PATH ?? ''}` }
    return await imageIdOf(absenceProbeTag, { env }).then(
      (value) => (value === null ? 'read as absent' : 'read as present'),
      () => 'threw'
    )
  } finally {
    rmSync(shimDirectory, { recursive: true, force: true })
  }
}

{
  const name = 'a daemon prefix followed by a newline is never read as absence'
  const stderr = `Error response from daemon:\nNo such image: ${absenceProbeTag}`
  const pure = isAbsenceMessage(stderr, { kind: 'image', name: absenceProbeTag })
  const crlf = isAbsenceMessage(
    `Error response from daemon:\r\nNo such image: ${absenceProbeTag}`,
    { kind: 'image', name: absenceProbeTag }
  )
  const throughShim = await imageIdVerdictThroughShim(
    'echo "Error response from daemon:" >&2\n' +
      `echo "No such image: ${absenceProbeTag}" >&2\nexit 1\n`
  )
  if (pure) {
    fail(name, 'the pure judge accepted a stderr whose absence message spans two lines')
  } else if (crlf) {
    fail(name, 'the pure judge accepted the CRLF variant of the same two-line message')
  } else if (throughShim !== 'threw') {
    fail(name, `the real imageIdOf path ${throughShim} instead of failing closed`)
  } else {
    pass(name, 'refused by the pure judge (LF and CRLF) and by the real imageIdOf/PATH shim path')
  }
}

{
  const name = 'an absence message split after the noun is never read as absence'
  const stderr = `No such image:\n${absenceProbeTag}`
  const pure = isAbsenceMessage(stderr, { kind: 'image', name: absenceProbeTag })
  const throughShim = await imageIdVerdictThroughShim(
    `echo "No such image:" >&2\necho "${absenceProbeTag}" >&2\nexit 1\n`
  )
  // 反向保证：真正的**单行**消息（以及水平制表符形态）必须仍然判为 absent，
  // 否则「全都判 false」也能让上面两条恒绿。
  const genuine = isAbsenceMessage(
    `Error response from daemon: No such image: ${absenceProbeTag}`,
    { kind: 'image', name: absenceProbeTag }
  )
  const tabbed = isAbsenceMessage(
    `Error response from daemon:\tNo such image: ${absenceProbeTag}`,
    { kind: 'image', name: absenceProbeTag }
  )
  const genuineThroughShim = await imageIdVerdictThroughShim(
    `echo "Error response from daemon: No such image: ${absenceProbeTag}" >&2\nexit 1\n`
  )
  if (pure) {
    fail(name, 'the pure judge accepted an absence message split after the noun')
  } else if (throughShim !== 'threw') {
    fail(name, `the real imageIdOf path ${throughShim} instead of failing closed`)
  } else if (!genuine || !tabbed) {
    fail(name, 'the genuine single-line form is no longer recognised (the judge rejects everything)')
  } else if (genuineThroughShim !== 'read as absent') {
    fail(name, `the genuine single-line exit-1 message was ${genuineThroughShim}`)
  } else {
    pass(
      name,
      'refused by the pure judge and the real imageIdOf path; the genuine single-line and ' +
        'horizontal-tab forms still read as absent'
    )
  }
}

// ---------------------------------------------------------------------------
// R5-2：连接串候选扫描不得静默免检
// ---------------------------------------------------------------------------
process.stdout.write('R5-2: connection string candidates are never silently skipped\n')

// 资源上限（最多 8 个候选、每个最长 2048 字符）保留，但**超限不再是免检额度**：
// 扫不完就必须以固定类别 fail closed。此前第 9 个候选被 `break` 跳过、超长候选
// 被长度判断跳过，两者都静默放行；而 `\S+` 还会把逗号后的第二条 URI 吞成第一条
// 的 query 取值，于是编码后的 key 根本不成其为 key。
const eightBenignCandidates = Array.from(
  { length: 8 },
  (_, index) => `https://benign-${String(index)}.invalid/path?mode=ok`
).join(' ')

/**
 * 失败消息不得回显取值、URL 或 key。扫描内部可以持有必要状态，但输出只有固定
 * 类别、文件标签与行号。
 */
/**
 * 模板扫描 problem 的**完整合法形状**。类别取自本仓源码里的固定字符串——
 * **没有任何一条允许出现输入派生的 key 或 value**：扫描内部可以持有必要状态，
 * 但输出只有固定类别、文件标签与行号。
 */
const allowedProblemShape = (() => {
  // 带行号的**逐行**判定消息。
  const perLine =
    /^[^\s:]+(?: \(git index\))?:\d+: tracked template (?:contains a full connection string with credentials|contains a connection string with a credential query parameter|contains an unscannable connection string candidate|assigns a non-empty value to a sensitive key)$/
  // 不带行号的**逐文件**消息（格式不受支持、工作树读不到、index blob 读不到）。
  // 它们同样必须在允许表里——否则这张表只是「碰巧覆盖了被测到的那几条」，
  // 一旦某条反例触发到它们就会误报成「消息回显了输入」。
  const perFile =
    /^[^\s:]+: (?:unsupported template format under infra\/environments; |tracked template could not be read from the worktree$|the git index blob could not be read \()/
  return { test: (text) => perLine.test(text) || perFile.test(text) }
})()

const echoesCandidateContent = (problems) =>
  problems.some((problem) =>
    /SYNTHETIC|benign-|oversize\.invalid|first\.invalid|second\.invalid|host\/path|pass%77ord/.test(
      String(problem)
    )
  )

{
  const name = 'a ninth connection string candidate fails closed instead of being skipped'
  const problems = templateProblemsFor(
    `NOTES=${eightBenignCandidates} redis://redis:6379?pass%77ord=SYNTHETIC-NINTH`
  )
  const clean = templateProblemsFor(`NOTES=${eightBenignCandidates}`)
  if (!problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
    fail(name, 'the ninth candidate was skipped instead of failing closed')
  } else if (echoesCandidateContent(problems)) {
    fail(name, 'a failure message echoed the value, the URL or the key (not reprinted here)')
  } else if (clean.some((problem) => /connection string/.test(problem))) {
    fail(name, 'eight benign candidates were wrongly flagged (the limit itself must not fire)')
  } else {
    pass(name, '/unscannable connection string candidate/ with nothing echoed; eight stay clean')
  }
}

{
  const name = 'an oversize connection string candidate fails closed instead of being skipped'
  const problems = templateProblemsFor(
    `NOTES=https://oversize.invalid/${'a'.repeat(2100)}?pass%77ord=SYNTHETIC-OVERSIZE`
  )
  const placeholder = templateProblemsFor('CACHE=redis://redis:6379?password=')
  if (!problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
    fail(name, 'a candidate longer than the 2048 character limit was skipped')
  } else if (echoesCandidateContent(problems)) {
    fail(name, 'a failure message echoed the value, the URL or the key (not reprinted here)')
  } else if (placeholder.some((problem) => /connection string/.test(problem))) {
    fail(name, 'an empty placeholder was wrongly flagged')
  } else {
    pass(name, '/unscannable connection string candidate/ with nothing echoed; placeholder clean')
  }
}

{
  const name = 'a comma-separated second URI is scanned instead of being swallowed'
  const problems = templateProblemsFor(
    'NOTES=https://first.invalid?mode=ok,redis://redis:6379?pass%77ord=SYNTHETIC-COMMA'
  )
  if (!problems.some((problem) => /credential query parameter/.test(problem))) {
    fail(name, 'the second URI was swallowed by the first candidate and never scanned')
  } else if (echoesCandidateContent(problems)) {
    fail(name, 'a failure message echoed the value, the URL or the key (not reprinted here)')
  } else {
    pass(name, '/credential query parameter/ on the second URI with nothing echoed')
  }
}

// ---------------------------------------------------------------------------
// R6：候选枚举的结构性回归（起点独立枚举 + 解析失败 fail closed）
// ---------------------------------------------------------------------------
process.stdout.write('R6: connection string candidates are enumerated by scheme start\n')

// 此前的扫描是「找到一个候选 → 从它的结束位置继续找下一个」，于是任何**落在
// 前一个候选内部**的 `scheme://` 起点被整段跳过。逗号只是这一结构缺陷最先暴露
// 的外衣；括号、方括号、花括号是同一个洞。下面四条覆盖的是**结构**，不是某个
// 分隔符字符。

{
  const name = 'a second URI wrapped in brackets is still enumerated and scanned'
  const shapes = [
    ['parentheses', 'NOTES=https://first.invalid?mode=ok(redis://redis:6379?pass%77ord=SYNTHETIC-PAREN)'],
    ['square brackets', 'NOTES=https://first.invalid?mode=ok[redis://redis:6379?pass%77ord=SYNTHETIC-SQUARE]'],
    ['curly braces', 'NOTES=https://first.invalid?mode=ok{redis://redis:6379?pass%77ord=SYNTHETIC-CURLY}']
  ]
  const missed = []
  const leaking = []
  for (const [label, line] of shapes) {
    const problems = templateProblemsFor(line)
    if (!problems.some((problem) => /credential query parameter|unscannable connection string candidate/.test(problem))) {
      missed.push(label)
    }
    if (echoesCandidateContent(problems)) {
      leaking.push(label)
    }
  }
  if (missed.length > 0) {
    fail(name, `${String(missed.length)} bracket shape(s) hid a second URI from the scanner`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message echoed the value, the URL or the key (not reprinted here)')
  } else {
    pass(name, `${String(shapes.length)} bracket shapes enumerated and judged, nothing echoed`)
  }
}

{
  const name = 'nine scheme starts inside one whitespace-free field fail closed'
  // 九个起点全部挤在**同一个无空白字段**里：靠分隔符定界的实现只会看到一个
  // 候选，起点计数才能发现这是第 9 个。
  const nine = Array.from(
    { length: 8 },
    (_, index) => `https://benign-${String(index)}.invalid/p?mode=ok`
  ).join('(') + '(redis://redis:6379?pass%77ord=SYNTHETIC-NINTH'
  const problems = templateProblemsFor(`NOTES=${nine}`)
  const eight = Array.from(
    { length: 8 },
    (_, index) => `https://benign-${String(index)}.invalid/p?mode=ok`
  ).join('(')
  const cleanEight = templateProblemsFor(`NOTES=${eight}`)
  if (!problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
    fail(name, 'the ninth scheme start inside one field was not counted')
  } else if (echoesCandidateContent(problems)) {
    fail(name, 'a failure message echoed the value, the URL or the key (not reprinted here)')
  } else if (cleanEight.some((problem) => /connection string/.test(problem))) {
    fail(name, 'eight scheme starts in one field were wrongly flagged (the limit itself must not fire)')
  } else {
    pass(name, '/unscannable connection string candidate/ on the ninth start; eight stay clean')
  }
}

/**
 * 解析失败必须 fail closed，但**不能退化成「一律 fail」**：每条都同时断言
 * 解析得动的 benign 形态仍然干净。
 */
const parseableShapesStillClean = () => {
  const boundary = `https://boundary.invalid/${'a'.repeat(2048 - 'https://boundary.invalid/'.length)}`
  return [
    ['a benign URL', 'CACHE=https://benign.invalid/path?mode=ok'],
    ['the 2048 character boundary', `NOTES=${boundary}`],
    ['an empty password placeholder', 'CACHE=redis://redis:6379?password=']
  ].filter(([, line]) =>
    templateProblemsFor(line).some((problem) => /connection string/.test(problem))
  )
}

{
  const name = 'a malformed IPv6 literal fails closed instead of being skipped'
  const problems = templateProblemsFor('NOTES=redis://[invalid?pass%77ord=SYNTHETIC-IPV6')
  const stillClean = parseableShapesStillClean()
  if (!problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
    fail(name, 'an unparseable IPv6 literal was skipped instead of failing closed')
  } else if (echoesCandidateContent(problems)) {
    fail(name, 'a failure message echoed the value, the URL or the key (not reprinted here)')
  } else if (stillClean.length > 0) {
    fail(name, `${String(stillClean.length)} parseable/benign shape(s) were wrongly flagged`)
  } else {
    pass(
      name,
      '/unscannable connection string candidate/; benign URL, the 2048 character boundary ' +
        'and the empty placeholder stay clean'
    )
  }
}

{
  const name = 'an illegal port fails closed instead of being skipped'
  const problems = templateProblemsFor('NOTES=redis://host:99999?pass%77ord=SYNTHETIC-PORT')
  const stillClean = parseableShapesStillClean()
  if (!problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
    fail(name, 'an out-of-range port was skipped instead of failing closed')
  } else if (echoesCandidateContent(problems)) {
    fail(name, 'a failure message echoed the value, the URL or the key (not reprinted here)')
  } else if (stillClean.length > 0) {
    fail(name, `${String(stillClean.length)} parseable/benign shape(s) were wrongly flagged`)
  } else {
    pass(
      name,
      '/unscannable connection string candidate/; benign URL, the 2048 character boundary ' +
        'and the empty placeholder stay clean'
    )
  }
}

{
  // 标点**不再**是候选边界。此前 `,;'"`<>|\` 都会终止候选，于是一条
  // **完全合法**的 URL 会被拦腰截断：`https://host/path,rest?pass%77ord=…`
  // 被切成 `https://host/path`，query 连同凭据一起消失——既不报「有凭据」也
  // 不报「扫不完」，静默放行。哪个标点算边界只能由 WHATWG URL 解析器按规范
  // 回答，不能靠维护一张标点表。
  const name = 'legal URL punctuation does not truncate the candidate'
  const shapes = [
    ['comma in the path', String.raw`https://host/path,rest?pass%77ord=SYNTHETIC-COMMA`, String.raw`https://host/path,rest?mode=ok`],
    ['semicolon after the host', String.raw`https://host;path?pass%77ord=SYNTHETIC-SEMI`, String.raw`https://host;path?mode=ok`],
    ['pipe in the path', String.raw`https://host/path|rest?pass%77ord=SYNTHETIC-PIPE`, String.raw`https://host/path|rest?mode=ok`],
    ['apostrophe in the path', String.raw`https://host/path'rest?pass%77ord=SYNTHETIC-QUOTE`, String.raw`https://host/path'rest?mode=ok`],
    ['backslash after the host', String.raw`https://host\?pass%77ord=SYNTHETIC-BACKSLASH`, String.raw`https://host\?mode=ok`]
  ]

  // 前置事实：每一条**整体**都是合法 URL，且解码后的 query key 就是
  // `password`。没有这一步，下面的断言可能只是在测一条根本不含凭据的字符串。
  const notCredential = shapes.filter(([, credentialUrl]) => {
    try {
      return ![...new URL(credentialUrl).searchParams.keys()].includes('password')
    } catch {
      return true
    }
  })

  const missed = []
  const viaUnscannable = []
  const leaking = []
  const dirtyBenign = []
  for (const [label, credentialUrl, benignUrl] of shapes) {
    const problems = templateProblemsFor(`NOTES=${credentialUrl}`)
    // **必须**判成 credential query parameter：靠 unscannable 蒙混过关等于
    // 「解析不动所以拦下了」，那不是这条反例要证明的能力。
    if (!problems.some((problem) => /credential query parameter/.test(problem))) {
      missed.push(label)
      if (problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
        viaUnscannable.push(label)
      }
    }
    if (echoesCandidateContent(problems)) {
      leaking.push(label)
    }
    // 同形态但**不含** credential query 的对照必须保持干净。
    if (templateProblemsFor(`NOTES=${benignUrl}`).some((problem) => /connection string/.test(problem))) {
      dirtyBenign.push(label)
    }
  }
  if (notCredential.length > 0) {
    fail(name, `the precondition failed: ${String(notCredential.length)} shape(s) do not decode to a password key`)
  } else if (viaUnscannable.length > 0) {
    fail(name, `${String(viaUnscannable.length)} shape(s) only passed via the unscannable category`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} legal-punctuation URL(s) were truncated before their query`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message echoed the value, the URL or the key (not reprinted here)')
  } else if (dirtyBenign.length > 0) {
    fail(name, `${String(dirtyBenign.length)} benign counterpart(s) were wrongly flagged`)
  } else {
    pass(
      name,
      `${String(shapes.length)} legal-punctuation URLs judged as credential query parameters ` +
        '(not via unscannable), their benign counterparts stay clean, nothing echoed'
    )
  }
}

{
  // 候选**视图**必须延伸到所在 dotenv 逻辑取值的末尾，内层起点只计数、不截断
  // 外层候选；引号内的空格与制表符必须原样保留。
  //
  // 此前每个候选都在「下一个起点」处结束，于是
  // `https://first.invalid?redirect=https://second.invalid/path&pass%77ord=…`
  // 的外层候选被砍成 `https://first.invalid?redirect=`——带凭据的 query 参数
  // 落在被砍掉的部分里，而内层视图没有 `?`，两个视图都判不出凭据；引号内的
  // 空格/制表符则被当成边界，`"https://host/path rest?pass%77ord=…"` 同样被
  // 拦腰截断。
  const name = 'a candidate view spans the whole dotenv logical value'
  const shapes = [
    [
      'nested https redirect',
      String.raw`https://first.invalid?redirect=https://second.invalid/path&pass%77ord=SYNTHETIC-NESTHTTPS`,
      String.raw`https://first.invalid?redirect=https://second.invalid/path&mode=ok`,
      (value) => `NOTES=${value}`
    ],
    [
      'nested redis redirect',
      String.raw`https://first.invalid?redirect=redis://second:6379/path&pass%77ord=SYNTHETIC-NESTREDIS`,
      String.raw`https://first.invalid?redirect=redis://second:6379/path&mode=ok`,
      (value) => `NOTES=${value}`
    ],
    [
      'quoted value with a space',
      String.raw`https://host/path rest?pass%77ord=SYNTHETIC-QUOTEDSPACE`,
      String.raw`https://host/path rest?mode=ok`,
      (value) => `NOTES="${value}"`
    ],
    [
      'quoted value with a real tab',
      `https://host/path\trest?pass%77ord=SYNTHETIC-QUOTEDTAB`,
      `https://host/path\trest?mode=ok`,
      (value) => `NOTES="${value}"`
    ]
  ]

  // 前置事实：每条**完整取值**都可解析，且解码后的 query key 就是 password。
  const notCredential = shapes.filter(([, credentialValue]) => {
    try {
      return ![...new URL(credentialValue).searchParams.keys()].includes('password')
    } catch {
      return true
    }
  })

  const missed = []
  const viaUnscannable = []
  const leaking = []
  const dirtyBenign = []
  for (const [label, credentialValue, benignValue, render] of shapes) {
    const problems = templateProblemsFor(render(credentialValue))
    if (!problems.some((problem) => /credential query parameter/.test(problem))) {
      missed.push(label)
      if (problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
        viaUnscannable.push(label)
      }
    }
    if (echoesCandidateContent(problems)) {
      leaking.push(label)
    }
    if (templateProblemsFor(render(benignValue)).some((problem) => /connection string/.test(problem))) {
      dirtyBenign.push(label)
    }
  }
  if (notCredential.length > 0) {
    fail(name, `the precondition failed: ${String(notCredential.length)} value(s) do not decode to a password key`)
  } else if (viaUnscannable.length > 0) {
    fail(name, `${String(viaUnscannable.length)} shape(s) only passed via the unscannable category`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} logical value(s) were truncated before their credential query`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message echoed the value, the URL or the key (not reprinted here)')
  } else if (dirtyBenign.length > 0) {
    fail(name, `${String(dirtyBenign.length)} benign counterpart(s) were wrongly flagged`)
  } else {
    pass(
      name,
      `${String(shapes.length)} shapes (nested scheme starts, quoted space, quoted tab) judged as ` +
        'credential query parameters (not via unscannable), benign counterparts clean, nothing echoed'
    )
  }
}

{
  // 真实的判定优先级（按代码执行顺序，不是理想化说法）：
  //
  //   1. `unscannable`——有一段没扫到，压过任何「扫到的那段是什么」的结论；
  //   2. **原始文本正则**——它**先跑**，是它覆盖的那些形态的主判据；
  //   3. **解析后的 URL**——补漏，负责正则看不见的形态。
  //
  // 这一条 case 针对的正是第 3 层：正则要求 `@` 之前没有空白，于是引号内合法
  // 保留的空格/制表符直接把它绕过去，只有解析器给出的 username/password 能补上。
  const name = 'userinfo is judged after URL parsing, not only by the raw regex'
  const shapes = [
    ['space inside the password', 'NOTES="https://user:pa ss@host/path"'],
    ['tab inside the password', 'NOTES="https://user:pa\tss@host/path"']
  ]
  // 审计追加：`unscannable` 必须**优先于** userinfo——同一行里后面还有一个解析
  // 不动的候选时，结论不得从「有一段没扫到」降级成「扫到的那段是 userinfo」。
  const precedenceHeld = templateProblemsFor(
    'NOTES="https://user:pa ss@host/path redis://[invalid?x=1"'
  ).some((problem) => /unscannable connection string candidate/.test(problem))
  const missed = []
  const viaUnscannable = []
  const leaking = []
  for (const [label, line] of shapes) {
    const problems = templateProblemsFor(line)
    if (!problems.some((problem) => /full connection string with credentials/.test(problem))) {
      missed.push(label)
      if (problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
        viaUnscannable.push(label)
      }
    }
    // 这里**不能**用「消息里出现了输入片段吗」当判据：消息只有固定类别加
    // `file:line`，那种守卫结构上永远不可能触发，等于一段死代码（审计实测）。
    // 改成**正向形状断言**：每一条 problem 都必须完全等于
    // `<file>:<line>: tracked template <已知类别>`——将来任何一次「开始回显
    // 输入」的回归都会让形状断言失败。
    if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
      leaking.push(label)
    }
  }
  // 退化 userinfo（解析器给出空 username/password）仍由原始文本正则拒绝；
  // 普通路径里的 `@` 必须保持干净——否则「一律判 userinfo」也能让上面恒绿。
  const degenerateKept = templateProblemsFor('NOTES=redis://@host').some((problem) =>
    /full connection string with credentials/.test(problem)
  )
  const pathAtClean = !templateProblemsFor('NOTES=https://host/path@part').some((problem) =>
    /connection string/.test(problem)
  )
  if (viaUnscannable.length > 0) {
    fail(name, `${String(viaUnscannable.length)} shape(s) only passed via the unscannable category`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} whitespace-bearing userinfo shape(s) went uncaught`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message echoed the URL, the user or the password (not reprinted here)')
  } else if (!degenerateKept) {
    fail(name, 'the degenerate userinfo form redis://@host is no longer rejected')
  } else if (!pathAtClean) {
    fail(name, 'an ordinary path containing @ was wrongly flagged as userinfo')
  } else if (!precedenceHeld) {
    fail(name, 'a userinfo hit preempted the unscannable verdict on the same line')
  } else {
    pass(
      name,
      'space and tab bearing userinfo caught as a full connection string (not via unscannable); ' +
        'degenerate redis://@host still rejected; ordinary path @ clean; unscannable still ' +
        'takes precedence over userinfo on the same line'
    )
  }
}

{
  // 敏感赋值判据必须跑在**每一个片段**上。此前只判定整行，于是行内注释里的
  // `PASSWORD=…` 被读成「键是 NOTES，不敏感」，完全没被看到。
  const name = 'an inline comment fragment goes through the same sensitive-assignment judge'
  const shapes = [
    ['quoted value with a trailing comment', 'NOTES="ok" # PASSWORD=SYNTHETIC-QUOTEDCOMMENT'],
    ['unquoted value with an inline comment', 'NOTES=ok # PASSWORD=SYNTHETIC-INLINECOMMENT'],
    // 审计追加：赋值不在片段开头、没有空格分隔的 `#`、引号内的赋值、注释里的
    // 第二个赋值、整行散文注释、以及 CRLF 行尾——六种形态此前全部漏检。
    ['prose before the assignment', 'NOTES=ok # do not commit: PASSWORD=SYNTHETIC-PROSE'],
    ['no space before the hash', 'NOTES=ok# PASSWORD=SYNTHETIC-NOSPACE'],
    ['assignment inside a quoted value', 'NOTES="PASSWORD=SYNTHETIC-QUOTEDVALUE"'],
    ['a second assignment in the comment', 'NOTES=ok # first=1 # SECRET=SYNTHETIC-SECOND'],
    ['a prose-only comment line', '# do not commit: PASSWORD=SYNTHETIC-PROSELINE'],
    ['a CRLF terminated line', 'PASSWORD=SYNTHETIC-CRLF\r']
  ]
  const benign = [
    ['a plain trailing note', 'NOTES="ok" # nothing sensitive in this note'],
    ['a plain inline note', 'NOTES=ok # nothing sensitive in this note'],
    ['a note mentioning a key with no value', 'NOTES=ok # remember to set PASSWORD='],
    ['an ordinary prose line', 'see the deployment notes for the rollout order']
  ]
  // 键名一律不回显（行内注释是自由文本，键位上可以放进 token）。第十轮把
  // 「高熵才不回显」的启发式整个删掉，改成**任何**敏感赋值都只报固定类别。
  const entropyProblems = templateProblemsFor('NOTES=ok # ghp_A1B2C3D4E5F6G7H8I9_TOKEN=1')
  const entropyWithheld =
    entropyProblems.some((problem) =>
      /assigns a non-empty value to a sensitive key/.test(problem)
    ) &&
    entropyProblems.every((problem) => allowedProblemShape.test(String(problem))) &&
    !entropyProblems.some((problem) => /ghp_A1B2C3|TOKEN/.test(problem))
  const missed = []
  const viaUnscannable = []
  const leaking = []
  for (const [label, line] of shapes) {
    const problems = templateProblemsFor(line)
    if (!problems.some((problem) => /assigns a non-empty value to a sensitive key/.test(problem))) {
      missed.push(label)
      if (problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
        viaUnscannable.push(label)
      }
    }
    // 消息里**既不该有取值也不该有键名**：`/SYNTHETIC/` 盯住取值，正向形状
    // 断言盯住「消息开始回显任何别的输入」。
    if (
      problems.some(
        (problem) => /SYNTHETIC/.test(String(problem)) || !allowedProblemShape.test(String(problem))
      )
    ) {
      leaking.push(label)
    }
  }
  const dirtyBenign = benign.filter(([, line]) =>
    templateProblemsFor(line).some((problem) => /sensitive key|connection string/.test(problem))
  )
  if (viaUnscannable.length > 0) {
    fail(name, `${String(viaUnscannable.length)} shape(s) only passed via the unscannable category`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} inline comment fragment(s) never reached the assignment judge`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message echoed the assigned value (not reprinted here)')
  } else if (dirtyBenign.length > 0) {
    fail(name, `${String(dirtyBenign.length)} benign inline comment(s) were wrongly flagged`)
  } else if (!entropyWithheld) {
    fail(name, 'a key name was echoed instead of being withheld')
  } else {
    pass(
      name,
      `${String(shapes.length)} fragment shapes (including prose-before-assignment, an ` +
        'assignment inside a quoted value, a second assignment in the comment and a CRLF line) ' +
        'hit the sensitive-key judge; values never echoed; the key name is never echoed; ' +
        `${String(benign.length)} benign shapes stay clean`
    )
  }
}

// ---------------------------------------------------------------------------
// R10：赋值取值解析、精确词干、键名零回显
// ---------------------------------------------------------------------------
process.stdout.write('R10: assignment values are parsed, not character-classed\n')

{
  // 取值的边界是**引号**，不是某几个字符。此前用 `([^\s#]*)` 取值，于是
  // `PASSWORD="#SYNTHETIC"` 只截到一个引号，去引号后成空串，被「空占位允许」
  // 规则放行。
  const name = 'a quoted assignment value containing # or a space is still a credential'
  const rejected = [
    ['double-quoted value starting with #', 'NOTES=ok # PASSWORD="#SYNTHETIC-DQHASH"'],
    ['double-quoted value starting with a space', 'NOTES=ok # PASSWORD=" SYNTHETIC-DQSPACE"'],
    ["single-quoted value starting with #", "NOTES=ok # PASSWORD='#SYNTHETIC-SQHASH'"],
    ["single-quoted value starting with a space", "NOTES=ok # PASSWORD=' SYNTHETIC-SQSPACE'"],
    // 审计追加：**引号取值内部**的赋值。跳过整个取值继续扫描曾经让这一族
    // 形态全部漏检（而旧的字符类实现因为在空格处停下反而抓得到）——这条是
    // 本轮引入又修掉的**检测回退**，必须钉死。
    ['a nested assignment inside a quoted value', 'DB_HOST=localhost # NOTES="a PASSWORD=SYNTHETIC-NESTED"'],
    ['a nested assignment in single quotes', "DB_HOST=x # CMD='psql PASSWORD=SYNTHETIC-NESTSQ'"],
    ['a nested assignment in a prose line', 'run with NOTES="x PASSWORD=SYNTHETIC-PROSE" then restart'],
    // 审计追加：取值边界的其余缺口。
    ['a space after the equals sign', 'NOTES=ok # PASSWORD= SYNTHETIC-SPACEAFTER'],
    ['a tab after the equals sign', 'NOTES=ok # PASSWORD=\tSYNTHETIC-TABAFTER'],
    ['spaces around the equals sign', 'NOTES=ok # PASSWORD = SYNTHETIC-SPACEAROUND'],
    ['an unquoted value starting with #', 'NOTES=ok # PASSWORD=#SYNTHETIC-HASHLEAD'],
    ['a semicolon separated second assignment', 'NOTES=ok # X=1;PASSWORD=SYNTHETIC-SEMI']
  ]
  const allowed = [
    ['an empty double-quoted placeholder', 'PASSWORD=""'],
    ['an empty single-quoted placeholder', "PASSWORD=''"],
    // 反向：空占位后面跟一句注释仍然必须干净（基线把注释整段读成取值，误报）。
    ['an empty value followed by a comment', 'PASSWORD= # placeholder note'],
    ['an empty quoted value followed by a comment', 'PASSWORD="" # placeholder note']
  ]
  const missed = []
  const viaUnscannable = []
  const leaking = []
  for (const [label, line] of rejected) {
    const problems = templateProblemsFor(line)
    if (!problems.some((problem) => /assigns a non-empty value to a sensitive key/.test(problem))) {
      missed.push(label)
      if (problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
        viaUnscannable.push(label)
      }
    }
    if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
      leaking.push(label)
    }
  }
  const wronglyFlagged = allowed.filter(([, line]) =>
    templateProblemsFor(line).some((problem) => /sensitive key/.test(problem))
  )
  if (viaUnscannable.length > 0) {
    fail(name, `${String(viaUnscannable.length)} shape(s) only passed via the unscannable category`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} quoted assignment value(s) were truncated into an empty value`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message left the fixed category shape (not reprinted here)')
  } else if (wronglyFlagged.length > 0) {
    fail(name, `${String(wronglyFlagged.length)} empty quoted placeholder(s) were wrongly flagged`)
  } else {
    pass(
      name,
      `${String(rejected.length)} quoted values containing # or a leading space rejected as ` +
        `sensitive assignments (not via unscannable); ${String(allowed.length)} empty quoted ` +
        'placeholders stay clean'
    )
  }
}

{
  // 精确追加两个词干。**刻意不加**宽泛的 auth / session / salt。
  const name = 'private_key and signature are covered in query, fragment and encoded form'
  const caught = [
    ['private_key in the query', 'NOTES=https://h.invalid/p?private_key=SYNTHETIC-PKQ', /credential query parameter/],
    ['private_key in the fragment', 'NOTES=https://h.invalid/p#private_key=SYNTHETIC-PKF', /credential query parameter/],
    ['percent-encoded private%5Fkey', 'NOTES=https://h.invalid/p?private%5Fkey=SYNTHETIC-PKE', /credential query parameter/],
    ['signature in the query', 'NOTES=https://h.invalid/p?signature=SYNTHETIC-SGQ', /credential query parameter/],
    ['signature in the fragment', 'NOTES=https://h.invalid/p#signature=SYNTHETIC-SGF', /credential query parameter/],
    ['percent-encoded signa%74ure', 'NOTES=https://h.invalid/p?signa%74ure=SYNTHETIC-SGE', /credential query parameter/],
    ['a SIGNATURE assignment', 'SIGNATURE=SYNTHETIC-SGA', /assigns a non-empty value to a sensitive key/]
  ]
  // 反向保证：本轮**没有**引入宽泛词干，否则「什么都判敏感」也能让上面全绿。
  const mustStayClean = [
    ['a broad auth query key', 'NOTES=https://h.invalid/p?auth=SYNTHETIC-AUTH'],
    ['a broad SESSION assignment', 'SESSION=SYNTHETIC-SESSION'],
    ['a SALT assignment', 'SALT=SYNTHETIC-SALT']
  ]
  const missed = []
  const viaUnscannable = []
  const leaking = []
  for (const [label, line, expected] of caught) {
    const problems = templateProblemsFor(line)
    if (!problems.some((problem) => expected.test(problem))) {
      missed.push(label)
      if (problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
        viaUnscannable.push(label)
      }
    }
    if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
      leaking.push(label)
    }
  }
  const overreach = mustStayClean.filter(([, line]) => templateProblemsFor(line).length > 0)
  if (viaUnscannable.length > 0) {
    fail(name, `${String(viaUnscannable.length)} shape(s) only passed via the unscannable category`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} private_key/signature shape(s) went uncaught`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message left the fixed category shape (not reprinted here)')
  } else if (overreach.length > 0) {
    fail(name, `${String(overreach.length)} deliberately-excluded stem(s) were flagged (scope creep)`)
  } else {
    pass(
      name,
      `${String(caught.length)} private_key/signature shapes caught across query, fragment and ` +
        `percent-encoded forms; ${String(mustStayClean.length)} deliberately-excluded stems ` +
        '(auth / SESSION / SALT) stay clean'
    )
  }
}

{
  // 敏感赋值消息里**不得出现任何输入派生的键名或取值**。启发式（「这个键名
  // 像不像 Secret」）只能缩小泄漏面：行内注释是自由文本，键位上可以放进任意
  // 内容。现在一律只报固定类别 + 文件标签 + 行号。
  const name = 'a sensitive assignment never echoes the input key or value'
  const shapes = [
    ['a UUID-shaped key', 'NOTES=ok # A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF_TOKEN=SYNTHETIC-UUIDKEY'],
    ['a sentinel-shaped key', 'NOTES=ok # M3B-SENTINEL-DEADBEEF_SECRET=SYNTHETIC-SENTINELKEY'],
    ['an ordinary short key', 'PASSWORD=SYNTHETIC-SHORTKEY']
  ]
  const messages = []
  const missed = []
  for (const [label, line] of shapes) {
    const problems = templateProblemsFor(line)
    const hit = problems.filter((problem) =>
      /assigns a non-empty value to a sensitive key/.test(problem)
    )
    if (hit.length === 0) {
      missed.push(label)
      continue
    }
    messages.push(...hit.map((problem) => problem.replace(/^[^:]+:\d+: /, '')))
  }
  // 三者必须得到**同一条**中性消息（去掉 file:line 之后完全相同）。
  const distinct = [...new Set(messages)]
  const echoes = shapes.filter(([, line]) => {
    const problems = templateProblemsFor(line)
    return problems.some(
      (problem) =>
        !allowedProblemShape.test(String(problem)) ||
        /SYNTHETIC|A1B2C3|DEADBEEF|PASSWORD|TOKEN|SECRET/.test(String(problem))
    )
  })
  if (missed.length > 0) {
    fail(name, `${String(missed.length)} key shape(s) were not judged sensitive at all`)
  } else if (echoes.length > 0) {
    fail(name, `${String(echoes.length)} message(s) echoed an input-derived key or value`)
  } else if (distinct.length !== 1) {
    fail(name, `the three key shapes produced ${String(distinct.length)} different messages`)
  } else {
    pass(
      name,
      `${String(shapes.length)} key shapes (UUID-like, sentinel-like, ordinary) all produce the ` +
        'same neutral category with no input-derived key or value'
    )
  }
}

// ---------------------------------------------------------------------------
// R11：quoted 取值的空判据、闭合引号之后的收尾、紧邻的嵌套赋值
// ---------------------------------------------------------------------------
process.stdout.write('R11: quoted values, trailing ambiguity and nested assignments\n')

{
  // 只有**长度精确为 0** 的 quoted 取值才是空占位。用 `trim()` 判空会把
  // `PASSWORD=" "` 这类「操作者显式用引号括起来的空白」抹成空串放行——那些
  // 字节是写进去的内容。
  const name = 'a quoted value made of whitespace is a value, not an empty placeholder'
  const rejected = [
    ['a single space', 'PASSWORD=" "'],
    ['a tab', 'PASSWORD="\t"'],
    ['single-quoted spaces', "PASSWORD='   '"],
    ['a non-breaking space', 'PASSWORD="\u00a0"'],
    ['a quoted space in a comment fragment', 'NOTES=ok # PASSWORD=" "']
  ]
  const allowed = [
    ['an empty double-quoted value', 'PASSWORD=""'],
    ['an empty single-quoted value', "PASSWORD=''"],
    ['a bare placeholder with a comment', 'PASSWORD= # placeholder'],
    ['an empty quoted value with a comment', 'PASSWORD="" # placeholder']
  ]
  const missed = []
  const viaUnscannable = []
  const leaking = []
  for (const [label, line] of rejected) {
    const problems = templateProblemsFor(line)
    if (!problems.some((problem) => /assigns a non-empty value to a sensitive key/.test(problem))) {
      missed.push(label)
      if (problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
        viaUnscannable.push(label)
      }
    }
    if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
      leaking.push(label)
    }
  }
  const wronglyFlagged = allowed.filter(([, line]) => templateProblemsFor(line).length > 0)
  if (viaUnscannable.length > 0) {
    fail(name, `${String(viaUnscannable.length)} shape(s) only passed via the unscannable category`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} whitespace-only quoted value(s) were read as empty`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message left the fixed category shape (not reprinted here)')
  } else if (wronglyFlagged.length > 0) {
    fail(name, `${String(wronglyFlagged.length)} genuine empty placeholder(s) were wrongly flagged`)
  } else {
    pass(
      name,
      `${String(rejected.length)} whitespace-only quoted values rejected (space, tab, NBSP, ` +
        `single quotes, comment fragment); ${String(allowed.length)} genuine empty placeholders ` +
        'stay clean'
    )
  }
}

{
  // 闭合引号之后只允许：输入结束、水平空白后结束、或（按既定语义）注释。
  // 其余收尾说不清「取值到底是什么」，一律 fail closed。**顶层与片段必须得出
  // 同一个结论**——两条路径共用同一个 `readAssignmentValue`。
  const name = 'an ambiguous tail after the closing quote fails closed on both paths'
  const fragments = [
    ['text immediately after a double quote', 'NOTES=ok # PASSWORD=""SYNTHETIC-DQTAIL'],
    ['text immediately after a single quote', "NOTES=ok # PASSWORD=''SYNTHETIC-SQTAIL"],
    ['whitespace then text', 'NOTES=ok # PASSWORD=""  SYNTHETIC-SPACETAIL'],
    ['a semicolon', 'NOTES=ok # PASSWORD="";'],
    ['a comma then text', 'NOTES=ok # PASSWORD="",SYNTHETIC-COMMATAIL']
  ]
  // 同样的取值形态放在**顶层**赋值上，必须得到同一个敏感赋值结论。
  const topLevel = fragments.map(([label, line]) => [label, line.replace(/^NOTES=ok # /, '')])
  const sensitiveIn = (line) =>
    templateProblemsFor(line).some((problem) =>
      /assigns a non-empty value to a sensitive key/.test(problem)
    )
  const missedFragment = fragments.filter(([, line]) => !sensitiveIn(line)).map(([l]) => l)
  const missedTopLevel = topLevel.filter(([, line]) => !sensitiveIn(line)).map(([l]) => l)
  const leaking = [...fragments, ...topLevel].filter(([, line]) =>
    templateProblemsFor(line).some((problem) => !allowedProblemShape.test(String(problem)))
  )
  const commentStillClean = templateProblemsFor('PASSWORD="" # comment').length === 0
  if (missedFragment.length > 0) {
    fail(name, `${String(missedFragment.length)} ambiguous tail(s) passed in a comment fragment`)
  } else if (missedTopLevel.length > 0) {
    fail(
      name,
      `${String(missedTopLevel.length)} ambiguous tail(s) reached a different conclusion at top level`
    )
  } else if (leaking.length > 0) {
    fail(name, 'a failure message left the fixed category shape (not reprinted here)')
  } else if (!commentStillClean) {
    fail(name, 'an empty quoted value with a trailing comment was wrongly flagged')
  } else {
    pass(
      name,
      `${String(fragments.length)} ambiguous tails fail closed identically at top level and in a ` +
        'comment fragment; an empty quoted value with a trailing comment stays clean'
    )
  }
}

{
  // 内层键紧贴着上一个 `=`：游标必须退回到那个 `=` 上，让它充当下一层赋值的
  // 分隔符，否则 `NOTES=PASSWORD=…` 这种紧邻嵌套永远匹配不上。
  const name = 'an assignment nested immediately after another equals sign is caught'
  const shapes = [
    ['prose with a nested assignment', 'run NOTES=PASSWORD=SYNTHETIC-PROSENEST then restart'],
    ['a comment line with a nested assignment', '# run NOTES=PASSWORD=SYNTHETIC-COMMENTNEST then restart'],
    ['a chained assignment', 'A=B=PASSWORD=SYNTHETIC-CHAINNEST'],
    ['a nested assignment inside quotes', 'NOTES="x PASSWORD=SYNTHETIC-QUOTENEST y"']
  ]
  const clean = [
    ['an ordinary assignment', 'NOTES=value'],
    ['an empty sensitive placeholder', 'PASSWORD='],
    ['an ordinary prose line', 'restart the service after editing the file']
  ]
  const missed = []
  const viaUnscannable = []
  const duplicated = []
  const leaking = []
  for (const [label, line] of shapes) {
    const problems = templateProblemsFor(line)
    const hits = problems.filter((problem) =>
      /assigns a non-empty value to a sensitive key/.test(problem)
    )
    if (hits.length === 0) {
      missed.push(label)
      if (problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
        viaUnscannable.push(label)
      }
    } else if (hits.length > 1) {
      // 「一行至多一条敏感赋值 problem」是**结构性**保证（扫描按行汇总命中数、
      // 只 push 一条），因此这个分支在当前实现下不会触发。保留它是把那条不变量
      // 写进断言：哪天改成逐条 push，游标退回一格就会立刻在这里暴露。
      duplicated.push(label)
    }
    if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
      leaking.push(label)
    }
  }
  const wronglyFlagged = clean.filter(([, line]) => templateProblemsFor(line).length > 0)
  if (viaUnscannable.length > 0) {
    fail(name, `${String(viaUnscannable.length)} shape(s) only passed via the unscannable category`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} immediately nested assignment(s) went uncaught`)
  } else if (duplicated.length > 0) {
    fail(name, `${String(duplicated.length)} line(s) produced a duplicate problem`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message left the fixed category shape (not reprinted here)')
  } else if (wronglyFlagged.length > 0) {
    fail(name, `${String(wronglyFlagged.length)} ordinary line(s) were wrongly flagged`)
  } else {
    pass(
      name,
      `${String(shapes.length)} immediately nested assignments caught, one problem each ` +
        '(single-problem-per-line is structural, not proven by this guard); no zero-width loop; ' +
        `${String(clean.length)} ordinary lines stay clean`
    )
  }
}

// ---------------------------------------------------------------------------
// R12/R13：whitespace 矩阵（真实 --env-file 证据）与结构化 unsupported gap
// ---------------------------------------------------------------------------
process.stdout.write('R12/R13: whitespace matrix and structural gap\n')

/** 七类空白 + 六类结构性字符，全部用转义写出，源码里没有裸控制字符。 */
const WS_SPACE = ' '
const WS_TAB = '\t'
const WS_NBSP = '\u00a0'
const WS_IDEO = '\u3000'
const WS_ZWSP = '\u200b'
const WS_VT = '\u000b'
const WS_FF = '\u000c'
const GAP_NEL = '\u0085'
const GAP_MONGOL = '\u180e'
const GAP_WORDJOIN = '\u2060'
const GAP_ZWNJ = '\u200c'
const GAP_ZWJ = '\u200d'
const GAP_VISIBLE = '\u2020'
const GAP_BOM = '\ufeff'

/** oracle 钉死的 Node 版本：换了版本，消费语义可能变，证据就不再成立。 */
const oracleNodeVersion = 'v24.18.0'

/**
 * **真实**的 Node 消费结果——不是测试里手写的预期，而且**自身 fail closed**。
 *
 * 起一个 `process.execPath --env-file=<临时文件>` 子进程，把它看到的目标环境
 * 变量打印回来。硬性要求：
 *
 *   - `process.version` 必须精确等于 `oracleNodeVersion`；
 *   - 子进程环境里**先删掉被探测的那个键**，否则 ambient `PASSWORD` 会让
 *     「Node 没定义它」这条判定失真；
 *   - spawn error、被信号杀死、非零退出、空输出、非法 JSON、非预期形状——
 *     任何一种都是 **oracle failure**，直接让整组失败；
 *   - oracle failure **绝不**转换成 `expectFlag = true`：那等于用坏掉的量具
 *     去证明被测物合格。
 */
const oracleFailureReasons = Object.freeze([
  'spawn error',
  'killed by a signal',
  'non-zero exit',
  'empty output',
  'invalid JSON',
  'unexpected result shape'
])

/**
 * spawn 结果 → oracle 判定。**纯函数**，`envFileConsumption` 真正调用的就是它，
 * 因此自检注入的六种结果穿过的是**生产实现**而不是复制品。
 *
 * 失败只回 `oracleFailureReasons` 里的**固定类别**：绝不带 stdout、stderr、
 * 键名或取值。
 */
const interpretEnvFileProbe = (result) => {
  if (result.error !== undefined) {
    return { ok: false, reason: 'spawn error' }
  }
  if (result.signal !== null && result.signal !== undefined) {
    return { ok: false, reason: 'killed by a signal' }
  }
  if (result.status !== 0) {
    return { ok: false, reason: 'non-zero exit' }
  }
  if (typeof result.stdout !== 'string' || result.stdout === '') {
    return { ok: false, reason: 'empty output' }
  }
  let value
  try {
    value = JSON.parse(result.stdout)
  } catch {
    return { ok: false, reason: 'invalid JSON' }
  }
  if (value !== null && typeof value !== 'string') {
    return { ok: false, reason: 'unexpected result shape' }
  }
  return { ok: true, defined: value !== null, empty: value === '' }
}

const envFileConsumption = (
  line,
  key = 'PASSWORD',
  { env = process.env, run = spawnSync } = {}
) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-envfile-'))
  try {
    const file = resolve(directory, 'probe.env')
    writeFileSync(file, `${line}\n`, 'utf8')
    // ambient 清洗：被探测的键绝不能从父进程漏进去。
    const childEnv = { ...env }
    delete childEnv[key]
    // **走注入 seam**：默认就是 `spawnSync`，自检把六种失败结果从这里送进来，
    // 因此它们穿过的是这条生产路径本身，而不是一份复制的判定。
    const result = run(
      process.execPath,
      [
        `--env-file=${file}`,
        '-e',
        // 读**这一行真正赋的那个键**——不是一律读 `PASSWORD`。`WECHAT_APP_SECRET=`
        // 这类行去读 PASSWORD 会永远得到 undefined，把合法空占位判成 unsupported；
        // `PASSWORD\u00e9=…` 这类行 Node 建的键是 `PASSWORD\u00e9`，只读 `PASSWORD`
        // 会把一条**活凭据**读成「未定义」。
        `process.stdout.write(JSON.stringify(process.env[${JSON.stringify(key)}] ?? null))`
      ],
      // 有界：卡住的子进程必须变成一次 oracle failure，而不是把整个套件挂住。
      { encoding: 'utf8', env: childEnv, timeout: 30_000, maxBuffer: 1 << 20, killSignal: 'SIGKILL' }
    )
    return interpretEnvFileProbe(result)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * **唯一一份证据门禁**。真实矩阵、structural、astral、boundary、Unicode 键与
 * 自反例都调用它——门禁只有一份实现，自反例证明的就是生产路径本身。
 *
 * 两种 identity 分开：
 *
 *   - `scanIdentityOf`：扫描器实际收到的**原始输入**，直接就是 `scanLine`。
 *     不带 group 标签——带了就能把同一个输入放进两个分组把数字凑够。
 *   - `oracleIdentityOf`：`[key, envLine]`，只在需要证明**送进 Node 的输入
 *     互异**时才设。同样不带 group 标签。
 *
 * 两个 distinct 都对**硬字面量**断言，不跟行数联动：行数与互异数是两回事。
 */
const evidenceGateProblems = ({
  rows,
  expectedRows,
  scanIdentityOf,
  expectedScanDistinct,
  oracleIdentityOf = null,
  expectedOracleDistinct = null,
  requiresOracle = false,
  oracleFailures = [],
  mismatches = [],
  leaking = []
}) => {
  const problems = []
  // **声明的互异数不得低于行数**。审计实测：把 69 行逐字节重复的 rows 配上
  // `expectedScanDistinct: 1`，旧版门禁一条问题都不报——那正是它要挡住的
  // 「用重复行凑数」，只是把凑数挪到了期望值上。这里把「行数 == 互异数」写成
  // 门禁自身的结构性不变式，调用方无法用一个低期望值绕过去。
  if (expectedScanDistinct !== expectedRows) {
    problems.push(
      `the declared scanner distinct count ${String(expectedScanDistinct)} does not equal the ` +
        `row count ${String(expectedRows)}`
    )
  }
  if (oracleIdentityOf !== null && expectedOracleDistinct !== expectedRows) {
    problems.push(
      `the declared oracle distinct count ${String(expectedOracleDistinct)} does not equal the ` +
        `row count ${String(expectedRows)}`
    )
  }
  if (requiresOracle && process.version !== oracleNodeVersion) {
    problems.push(`the oracle is pinned to Node ${oracleNodeVersion}; this run is ${process.version}`)
  }
  if (oracleFailures.length > 0) {
    // 量具坏了整组作废，绝不转成 `expectFlag = true`。
    problems.push(`${String(oracleFailures.length)} oracle probe(s) failed; the evidence is void`)
  }
  if (rows.length !== expectedRows) {
    problems.push(`expected ${String(expectedRows)} rows, got ${String(rows.length)}`)
  }
  const scanDistinct = new Set(rows.map(scanIdentityOf)).size
  if (scanDistinct !== expectedScanDistinct) {
    problems.push(
      `expected ${String(expectedScanDistinct)} distinct scanner inputs, got ${String(scanDistinct)}`
    )
  }
  let oracleDistinct = null
  if (oracleIdentityOf !== null) {
    oracleDistinct = new Set(rows.map(oracleIdentityOf)).size
    if (oracleDistinct !== expectedOracleDistinct) {
      problems.push(
        `expected ${String(expectedOracleDistinct)} distinct oracle inputs, got ${String(oracleDistinct)}`
      )
    }
  }
  if (mismatches.length > 0) {
    problems.push(`${String(mismatches.length)} row(s) disagreed with the real --env-file consumption`)
  }
  if (leaking.length > 0) {
    problems.push('a failure message left the fixed category shape (not reprinted here)')
  }
  return { problems, scanDistinct, oracleDistinct }
}

/** 扫描器实际收到的原始输入。 */
const scanIdentityOfRow = (row) => row.scanLine
/** 送进 `node --env-file` 的输入。 */
const oracleIdentityOfRow = (row) => JSON.stringify([row.key ?? 'PASSWORD', row.envLine])

{
  // 69 行对齐矩阵。每一行的期望都由**真实 --env-file 消费结果**推导：
  //   - Node 消费出**非空**取值        → 必须命中；
  //   - Node 消费出空串                → 空占位，必须干净；
  //   - Node 连**这个键**都没定义       → unsupported，fail closed，必须命中。
  //
  // 第三支说的是「这个键」而不是「整行」：键与 `=` 之间的非 ASCII 间隔并不会让
  // 整行失效，它让 Node 建出一个**扩展键**（`PASSWORD<NBSP>`）。因此这些行的
  // 探针读的就是那个扩展键，见下面的 `gapKeyOf`。
  const name = 'the whitespace matrix matches real --env-file consumption'
  const whitespace = [
    ['SPACE', WS_SPACE], ['TAB', WS_TAB], ['NBSP', WS_NBSP], ['U+3000', WS_IDEO],
    ['U+200B', WS_ZWSP], ['VT', WS_VT], ['FF', WS_FF]
  ]
  // 矩阵只放**空白/格式类**字符：可见字符（U+2020）不是间隔字符，它属于
  // structural-gap case 里的散文对照，放进这里会与「Node 未定义即 fail closed」
  // 的推导冲突。
  const structural = [
    ['U+0085 NEL', GAP_NEL], ['U+180E', GAP_MONGOL], ['U+2060', GAP_WORDJOIN],
    ['U+200C', GAP_ZWNJ], ['U+200D', GAP_ZWJ], ['U+FEFF', GAP_BOM]
  ]

  const rows = []
  // 1) 只有空白的取值（7）
  for (const [label, c] of whitespace) rows.push({ group: 'whitespace-only', label, envLine: `PASSWORD=${c}`, scanLine: `PASSWORD=${c}` })
  // 2) 空白 + 取值（7）
  for (const [label, c] of whitespace) rows.push({ group: 'whitespace+value', label, envLine: `PASSWORD=${c}SYNTHETIC-WSV`, scanLine: `PASSWORD=${c}SYNTHETIC-WSV` })
  // 3) 键与 `=` 之间的空白（7），以及它在 inline comment / prose 两条路径上的
  //    格位（各 7）。**这 14 个格位第十二轮就有**（当时按 `[...withValue,
  //    ...keyGap] \u00d7 perPath` 展开），第十三轮改写成 55 行矩阵时把 keyGap 的
  //    inline/prose 两种渲染删掉了，第十四轮恢复。
  // 探针必须读 **Node 真正建立的那个键**：ASCII SPACE/TAB 会被 Node 吃掉，键仍是
  // `PASSWORD`；其余间隔字符**留在键名里**，键是 `PASSWORD<c>`。此前这三组一律
  // 读 `PASSWORD`，于是「Node 整行不生效」的推导对其中 15 行是假的（审计实测，
  // 连同 structural-gap 共 21 行）——两种前提碰巧都得出「必须命中」，结论没错但
  // 依据是错的。
  const gapKeyOf = (c) => (c === WS_SPACE || c === WS_TAB ? 'PASSWORD' : `PASSWORD${c}`)
  for (const [label, c] of whitespace) rows.push({ group: 'key-gap', label, key: gapKeyOf(c), envLine: `PASSWORD${c}=SYNTHETIC-GAP`, scanLine: `PASSWORD${c}=SYNTHETIC-GAP` })
  for (const [label, c] of whitespace) rows.push({ group: 'key-gap-inline', label, key: gapKeyOf(c), envLine: `PASSWORD${c}=SYNTHETIC-GAPINL`, scanLine: `NOTES=ok # PASSWORD${c}=SYNTHETIC-GAPINL` })
  for (const [label, c] of whitespace) rows.push({ group: 'key-gap-prose', label, key: gapKeyOf(c), envLine: `PASSWORD${c}=SYNTHETIC-GAPPRO`, scanLine: `run PASSWORD${c}=SYNTHETIC-GAPPRO now` })
  // 4) 同形态在行内注释里（7）与散文片段里（7）
  for (const [label, c] of whitespace) rows.push({ group: 'inline-comment', label, envLine: `PASSWORD=${c}SYNTHETIC-INL`, scanLine: `NOTES=ok # PASSWORD=${c}SYNTHETIC-INL` })
  for (const [label, c] of whitespace) rows.push({ group: 'prose-fragment', label, envLine: `PASSWORD=${c}SYNTHETIC-PRO`, scanLine: `run PASSWORD=${c}SYNTHETIC-PRO now` })
  // 5) 合法空占位（8）
  for (const [label, line] of [
    ['bare', 'PASSWORD='], ['empty double quotes', 'PASSWORD=""'], ['empty single quotes', "PASSWORD=''"],
    ['bare with comment', 'PASSWORD= # placeholder'], ['empty quotes with comment', 'PASSWORD="" # placeholder'],
    // 这两行**必须与 whitespace-only 的 SPACE/TAB 行不同**：早先它们逐字节相同，
    // 55 行里只有 53 个互不相同的输入，覆盖面被虚报了 2（审计实测）。
    ['another sensitive key', 'MEAL_AGENT_RUNTIME_PASSWORD='],
    ['mixed ASCII whitespace', `PASSWORD=${WS_SPACE}${WS_TAB}`],
    ['AppSecret placeholder', 'WECHAT_APP_SECRET=']
  ]) rows.push({
    group: 'empty-placeholder',
    label,
    envLine: line,
    scanLine: line,
    key: /^([A-Z_]+)=/.exec(line)?.[1] ?? 'PASSWORD'
  })
  // 6) 结构性字符：取值位（6）与键/`=` 间隔位（6）
  for (const [label, c] of structural) rows.push({ group: 'structural-value', label, envLine: `PASSWORD=${c}SYNTHETIC-STV`, scanLine: `PASSWORD=${c}SYNTHETIC-STV` })
  for (const [label, c] of structural) rows.push({ group: 'structural-gap', label, key: `PASSWORD${c}`, envLine: `PASSWORD${c}=SYNTHETIC-STG`, scanLine: `PASSWORD${c}=SYNTHETIC-STG` })

  // **矩阵条数的硬门禁**：少一行不得静默通过。
  const expectedWhitespaceMatrixCount = 69
  const mismatches = []
  const leaking = []
  const oracleFailures = []
  for (const row of rows) {
    const consumption = envFileConsumption(row.envLine, row.key ?? 'PASSWORD')
    if (!consumption.ok) {
      // **量具坏了就整组失败**，绝不把它变成「期望命中」。
      oracleFailures.push(`${row.group}/${row.label}: ${consumption.reason}`)
      continue
    }
    // 期望：Node 读出非空 → 命中；读出空串 → 干净；整行不生效 → unsupported
    // → fail closed → 命中。
    const expectFlag = !consumption.defined || !consumption.empty
    const problems = templateProblemsFor(row.scanLine)
    const flagged = problems.some((problem) =>
      /assigns a non-empty value to a sensitive key/.test(problem)
    )
    if (flagged !== expectFlag) {
      mismatches.push(`${row.group}/${row.label}`)
    }
    if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
      leaking.push(`${row.group}/${row.label}`)
    }
  }
  // 互不相同的输入数由**共享门禁** `evidenceGateProblems` 判定，两种 identity
  // 各自对硬字面量断言。
  const expectedMatrixScanDistinct = 69
  const expectedMatrixOracleDistinct = 69
  const gate = evidenceGateProblems({
    rows,
    expectedRows: expectedWhitespaceMatrixCount,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: expectedMatrixScanDistinct,
    oracleIdentityOf: oracleIdentityOfRow,
    expectedOracleDistinct: expectedMatrixOracleDistinct,
    requiresOracle: true,
    oracleFailures,
    mismatches,
    leaking
  })
  if (gate.problems.length > 0) {
    fail(name, `${String(gate.problems.length)} gate problem(s); first: ${gate.problems[0]}`)
  } else {
    pass(
      name,
      `${String(expectedWhitespaceMatrixCount)}/${String(expectedWhitespaceMatrixCount)} rows ` +
        `(${String(gate.scanDistinct)} distinct scanner inputs, ${String(gate.oracleDistinct)} ` +
        'distinct oracle inputs) match the real --env-file consumption (expectations derived ' +
        'from live spawns, not hand-written), nothing echoed'
    )
  }
}

{
  // 结构化 unsupported gap：**不枚举**「哪些字符算非 ASCII 空白」。敏感键之后，
  // 任何非词字符构成的间隔只要有界地抵达 `=`：全是 SPACE/TAB 就 supported，
  // 含任何其他字符就 unsupported → fail closed。
  const name = 'an unsupported key/= gap fails closed on every path'
  // 空白/格式类字符构成的间隔 → unsupported → fail closed。
  const structural = [
    ['U+0085 NEL', GAP_NEL], ['U+180E', GAP_MONGOL], ['U+2060', GAP_WORDJOIN],
    ['U+200C', GAP_ZWNJ], ['U+200D', GAP_ZWJ]
  ]
  // **可见字符**（U+2020 DAGGER）不是间隔字符：`PASSWORD†=x` 不是一条赋值而是
  // 散文，必须保持干净。这条是**正向对照**——判据一旦退回「任何非词字符都算
  // 间隔」，两份 tracked README 里的 markdown/英文行会成片误报（审计实测 18/18
  // 种普通写法被判成敏感赋值）。任务书把这个字符列在覆盖清单里，本轮按
  // 「覆盖」而非「必须 fail closed」实现，差异已在计划文档中登记。
  const proseControls = [['U+2020 visible', GAP_VISIBLE]]
  const paths = [
    ['top level', (line) => line],
    ['inline comment', (line) => `NOTES=ok # ${line}`],
    ['prose fragment', (line) => `run ${line} before starting`]
  ]
  // 无 `=` 的 benign 对照：不能「见敏感词就一律报错」。
  const benign = [
    ['a bare mention', 'PASSWORD'],
    ['a prose mention', 'the PASSWORD is stored outside git'],
    ['a comment mention', '# remember the PASSWORD rotation policy'],
    ['a mention with punctuation but no equals', 'PASSWORD: see the runbook']
  ]

  const expectedStructuralGapCount = 23
  // 23 条各自建一个 identity，由共享门禁断言 23/23 互不相同。
  const rows = []
  const missed = []
  const disagreed = []
  const wronglyFlagged = []
  const leaking = []

  for (const [label, character] of structural) {
    const line = `PASSWORD${character}=SYNTHETIC-STRUCT`
    const verdicts = []
    for (const [pathLabel, render] of paths) {
      const scanLine = render(line)
      rows.push({ envLine: line, scanLine })
      const problems = templateProblemsFor(scanLine)
      const flagged = problems.some((problem) =>
        /assigns a non-empty value to a sensitive key/.test(problem)
      )
      verdicts.push(flagged)
      if (!flagged) {
        missed.push(`${label}/${pathLabel}`)
      }
      if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
        leaking.push(`${label}/${pathLabel}`)
      }
    }
    if (new Set(verdicts).size !== 1) {
      disagreed.push(label)
    }
  }
  // 可见字符对照**逐路径给期望**：顶层与散文片段在 prose 角色里是散文，必须
  // 干净；但**行内注释体**里的同一串是「被注释掉的凭据」，有界注释赋值判据必须
  // 抓住它（第十六轮起）。
  const proseControlExpectations = new Map([
    ['top level', false],
    ['inline comment', true],
    ['prose fragment', false]
  ])
  for (const [label, character] of proseControls) {
    const line = `PASSWORD${character}=SYNTHETIC-PROSECTL`
    for (const [pathLabel, render] of paths) {
      rows.push({ envLine: line, scanLine: render(line) })
      const flagged = templateProblemsFor(render(line), 'README.md').some((problem) =>
        /assigns a non-empty value to a sensitive key/.test(problem)
      )
      if (flagged !== proseControlExpectations.get(pathLabel)) {
        wronglyFlagged.push(`${label}/${pathLabel}`)
      }
    }
  }
  // 越界的间隔必须 fail closed：65 个空格之后的 `=` 在 Node 里是一条活凭据，
  // 放弃扫描不能等于放行。
  const overboundLine = `PASSWORD${' '.repeat(65)}=SYNTHETIC-OVERGAP`
  rows.push({ envLine: overboundLine, scanLine: overboundLine })
  if (!templateProblemsFor(overboundLine).some((problem) =>
    /assigns a non-empty value to a sensitive key/.test(problem)
  )) {
    missed.push('gap beyond the scan bound')
  }
  for (const [label, line] of benign) {
    rows.push({ envLine: line, scanLine: line })
    if (templateProblemsFor(line).length > 0) {
      wronglyFlagged.push(label)
    }
  }

  const gate = evidenceGateProblems({
    rows,
    expectedRows: expectedStructuralGapCount,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: expectedStructuralGapCount,
    leaking
  })
  if (gate.problems.length > 0) {
    fail(name, `${String(gate.problems.length)} gate problem(s); first: ${gate.problems[0]}`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} unsupported gap(s) were not failed closed`)
  } else if (disagreed.length > 0) {
    fail(name, `${String(disagreed.length)} gap character(s) disagreed across the three paths`)
  } else if (wronglyFlagged.length > 0) {
    fail(name, `${String(wronglyFlagged.length)} benign mention(s) without an equals were flagged`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message left the fixed category shape (not reprinted here)')
  } else {
    pass(
      name,
      `${String(structural.length)} whitespace/format gap characters (NEL, U+180E, U+2060, ` +
        `U+200C, U+200D) fail closed identically on all ${String(paths.length)} paths; a gap ` +
        'beyond the scan bound also fails closed; a visible U+2020 reads as prose at top level ' +
        'and in a prose fragment but is caught inside a comment body; ' +
        `${String(benign.length)} benign mentions without an equals stay ` +
        `clean (${String(expectedStructuralGapCount)} rows = 5\u00d73 unsupported + 3 visible ` +
        `prose + 1 overbound + 4 benign, all ${String(gate.scanDistinct)} distinct)`
    )
  }
}

// ---------------------------------------------------------------------------
// R14：星平面码点、文件角色、oracle 自身 fail closed、64 边界
// ---------------------------------------------------------------------------
process.stdout.write('R14: astral code points, file roles, oracle integrity, gap boundary\n')

/** 星平面（>BMP）的格式字符：UTF-16 下各占两个 code unit。 */
const ASTRAL_GAPS = [
  ['U+110BD', String.fromCodePoint(0x110bd)],
  ['U+1BCA0', String.fromCodePoint(0x1bca0)],
  ['U+13430', String.fromCodePoint(0x13430)]
]

{
  // `text[index]` 取的是 UTF-16 code unit，星平面字符被拆成孤立代理项，
  // `\p{Cf}` 对代理项为假——基线实测这三个字符在三条路径上 **9/9 全部漏检**。
  const name = 'an astral code point gap fails closed on every path'
  const paths = [
    ['top level', (line) => line],
    ['inline comment', (line) => `NOTES=ok # ${line}`],
    ['prose fragment', (line) => `run ${line} before starting`]
  ]
  const expectedAstralCount = 9
  const rows = []
  const missed = []
  const leaking = []
  for (const [label, character] of ASTRAL_GAPS) {
    const line = `PASSWORD${character}=SYNTHETIC-ASTRAL`
    for (const [pathLabel, render] of paths) {
      const scanLine = render(line)
      rows.push({ envLine: line, scanLine })
      const problems = templateProblemsFor(scanLine)
      if (!problems.some((problem) => /assigns a non-empty value to a sensitive key/.test(problem))) {
        missed.push(`${label}/${pathLabel}`)
      }
      if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
        leaking.push(`${label}/${pathLabel}`)
      }
    }
  }
  // BMP 的既有回归必须仍然成立。
  const bmpStillCaught = [GAP_NEL, GAP_MONGOL, GAP_WORDJOIN, GAP_ZWNJ, GAP_ZWJ].every(
    (character) =>
      templateProblemsFor(`PASSWORD${character}=SYNTHETIC-BMP`).some((problem) =>
        /assigns a non-empty value to a sensitive key/.test(problem)
      )
  )
  const gate = evidenceGateProblems({
    rows,
    expectedRows: expectedAstralCount,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: expectedAstralCount,
    leaking
  })
  if (gate.problems.length > 0) {
    fail(name, `${String(gate.problems.length)} gate problem(s); first: ${gate.problems[0]}`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} astral gap(s) were not failed closed`)
  } else if (!bmpStillCaught) {
    fail(name, 'a BMP gap character regressed while adding astral coverage')
  } else {
    pass(
      name,
      `${String(expectedAstralCount)} astral gap rows (U+110BD, U+1BCA0, U+13430 × 3 paths, all ` +
        'distinct) fail closed; the five BMP gap characters still fail closed'
    )
  }
}

{
  // 同一行取值，两种**文件角色**必须得到相反结论：`.env` 家族里的可见间隔是
  // 可疑的，README 里的同一写法是散文。两者共用同一个 parser，只是 context 不同。
  const name = 'a visible gap is judged by file role, not by a second grammar'
  const visible = `PASSWORD${GAP_VISIBLE}=SYNTHETIC-ROLE`
  const strictFiles = ['local-test.env.example', 'local-test.env', 'sample.env.template']
  const proseFiles = ['README.md', '.gitignore', '.gitkeep']
  const proseLines = [
    '- `POSTGRES_PASSWORD` = 数据库密码',
    'keys += 1',
    '# TOKEN >= 32 chars',
    'if (token != null) { }'
  ]
  // `.env` 家族里的**注释**同样是散文——Node 不消费注释。这四条是审计实测的
  // 假阳性原文：strict 曾经把它们逐条报成「敏感赋值」。
  const strictCommentLines = [
    '# POSTGRES_PASSWORD >= 32 chars',
    '# keys += 1',
    '# - `POSTGRES_PASSWORD` = 数据库密码',
    `# DATABASE_PASSWORD ${'-'.repeat(70)}`
  ]
  // strict 角色要按**渲染逐格**给出期望，不能笼统地「三种都命中」：会被 dotenv
  // 消费的两种渲染必须 fail closed，行内注释体则和 README 一样是散文。
  // 行内注释体从第十六轮起也必须命中：注释掉的凭据同样进 Git。
  const renderings = [
    ['top level', (line) => line, true],
    ['prose fragment', (line) => `run ${line} before starting`, true],
    ['inline comment', (line) => `NOTES=ok # ${line}`, true]
  ]
  const flagged = (line, file) =>
    templateProblemsFor(line, file).some((problem) =>
      /assigns a non-empty value to a sensitive key/.test(problem)
    )
  const strictWrong = []
  for (const file of strictFiles) {
    for (const [renderLabel, render, expected] of renderings) {
      if (flagged(render(visible), file) !== expected) {
        strictWrong.push(`${file}/${renderLabel}`)
      }
    }
    for (const [index, line] of strictCommentLines.entries()) {
      if (templateProblemsFor(line, file).length > 0) {
        strictWrong.push(`${file}/comment#${String(index + 1)}`)
      }
    }
  }
  const proseFlagged = proseFiles.filter((file) => templateProblemsFor(visible, file).length > 0)
  const proseLineFlagged = proseLines.filter(
    (line) => templateProblemsFor(line, 'README.md').length > 0
  )
  // strict 角色下真实 `.env.example` 里的凭据必须照旧被捕获。
  const realShapeCaught = flagged('WECHAT_APP_SECRET=synthetic-value', 'local-test.env.example')
  // **角色与「受支持格式」必须同步**：两个判定各写各的，一旦有人只放宽
  // `supportedTemplateFile`，新文件就会被当成散文扫描 = 静默漏掉凭据。这里按
  // 结果断言该不变式：env 形态的文件名要么被判不支持，要么必须 fail closed。
  const roleProbeFiles = [
    'local-test.env.local',
    'local-test.ENV',
    'local-test.env.example.bak',
    'local-test.env.yaml',
    'myenv',
    'prod.env.template'
  ]
  const roleDrift = roleProbeFiles.filter(
    (file) => templateProblemsFor(visible, file).length === 0
  )
  if (strictWrong.length > 0) {
    fail(name, `${String(strictWrong.length)} strict dotenv cell(s) judged a visible gap wrongly`)
  } else if (roleDrift.length > 0) {
    fail(name, `${String(roleDrift.length)} env-shaped filename(s) neither strict nor rejected`)
  } else if (proseFlagged.length > 0) {
    fail(name, `${String(proseFlagged.length)} prose file(s) flagged a visible gap`)
  } else if (proseLineFlagged.length > 0) {
    fail(name, `${String(proseLineFlagged.length)} ordinary prose line(s) were flagged`)
  } else if (!realShapeCaught) {
    fail(name, 'an ordinary sensitive assignment stopped being caught under the strict role')
  } else {
    pass(
      name,
      `${String(strictFiles.length)} strict dotenv files × ` +
        `${String(renderings.length)} renderings + ${String(strictCommentLines.length)} ` +
        'comment forms match their per-cell expectations; ' +
        `${String(roleProbeFiles.length)} env-shaped filenames stay fail closed; ` +
        `${String(proseFiles.length)} prose files and ${String(proseLines.length)} ordinary ` +
        'prose lines stay clean; ordinary sensitive assignments still caught'
    )
  }
}

{
  // 量具自身必须 fail closed：坏掉的 oracle 不能被当成「期望命中」。
  //
  // 六种失败结果**逐项注入**，而且穿过的是生产实现：`interpretEnvFileProbe` 就是
  // `envFileConsumption` 内部真正调用的那个纯函数，`run` 是它的注入 seam。
  const name = 'every broken-oracle result fails the gate instead of satisfying it'
  const pinned = process.version === oracleNodeVersion
  const injected = [
    ['spawn error', { error: new Error('SYNTHETIC-SPAWN'), signal: null, status: null, stdout: '' }, 'spawn error'],
    ['signal', { error: undefined, signal: 'SIGKILL', status: null, stdout: '' }, 'killed by a signal'],
    ['non-zero exit', { error: undefined, signal: null, status: 3, stdout: '"x"' }, 'non-zero exit'],
    ['empty stdout', { error: undefined, signal: null, status: 0, stdout: '' }, 'empty output'],
    ['invalid JSON', { error: undefined, signal: null, status: 0, stdout: 'SYNTHETIC-NOT-JSON' }, 'invalid JSON'],
    ['unexpected shape', { error: undefined, signal: null, status: 0, stdout: '{"PASSWORD":1}' }, 'unexpected result shape']
  ]
  const wrongVerdict = []
  const wrongCategoryLocal = []
  const notFixedCategory = []
  for (const [label, result, expectedReason] of injected) {
    // a) 纯函数直判
    const direct = interpretEnvFileProbe(result)
    // b) 同一个结果经**真实** `envFileConsumption`（注入 runner）再判一次
    const throughProduction = envFileConsumption('PASSWORD=x', 'PASSWORD', { run: () => result })
    for (const verdict of [direct, throughProduction]) {
      if (verdict.ok !== false) {
        wrongVerdict.push(label)
      } else if (verdict.reason !== expectedReason) {
        wrongCategoryLocal.push(label)
      }
      // 原因只能是固定类别：既不回显 stdout/stderr，也不回显键名或取值。
      if (!oracleFailureReasons.includes(verdict.reason ?? '')) {
        notFixedCategory.push(label)
      }
    }
  }
  // 任一 oracle failure 必须让**共享门禁**整体失败。
  const voidedByFailure = evidenceGateProblems({
    rows: [{ envLine: 'PASSWORD=x', scanLine: 'PASSWORD=x' }],
    expectedRows: 1,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: 1,
    requiresOracle: true,
    oracleFailures: ['synthetic']
  }).problems.length
  // 健康探针仍然必须成功，且缺失的 env 文件确实让 Node 非零退出（自检不空转）。
  const healthy = envFileConsumption('PASSWORD=x', 'PASSWORD')
  const brokenDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-oracle-'))
  let missingFileExitsNonZero = false
  try {
    const result = spawnSync(
      process.execPath,
      [`--env-file=${resolve(brokenDirectory, 'does-not-exist.env')}`, '-e', 'process.stdout.write("{}")'],
      { encoding: 'utf8' }
    )
    missingFileExitsNonZero = result.status !== 0
  } finally {
    rmSync(brokenDirectory, { recursive: true, force: true })
  }
  // ambient 污染：父进程里放一个 PASSWORD，探针必须不受影响。
  const ambient = envFileConsumption('PASSWORD=', 'PASSWORD', {
    env: { ...process.env, PASSWORD: 'AMBIENT-SYNTHETIC' }
  })
  if (!pinned) {
    fail(name, `the oracle is pinned to ${oracleNodeVersion}; this run is ${process.version}`)
  } else if (wrongVerdict.length > 0) {
    fail(name, `${String(wrongVerdict.length)} injected failure(s) were not treated as oracle failures`)
  } else if (wrongCategoryLocal.length > 0) {
    fail(name, `${String(wrongCategoryLocal.length)} injected failure(s) reported the wrong category`)
  } else if (notFixedCategory.length > 0) {
    fail(name, `${String(notFixedCategory.length)} oracle reason(s) left the fixed category list`)
  } else if (voidedByFailure === 0) {
    fail(name, 'an oracle failure did not void the shared evidence gate')
  } else if (!healthy.ok) {
    fail(name, 'the healthy oracle probe did not succeed')
  } else if (!missingFileExitsNonZero) {
    fail(name, 'a missing --env-file did not make Node exit non-zero; the self-check is vacuous')
  } else if (!ambient.ok || !ambient.defined || !ambient.empty) {
    fail(name, 'an ambient value leaked into the oracle probe')
  } else {
    pass(
      name,
      `pinned to ${oracleNodeVersion}; all ${String(injected.length)} broken-oracle results ` +
        '(spawn error, signal, non-zero exit, empty stdout, invalid JSON, unexpected shape) are ' +
        'oracle failures through both the pure interpreter and the real envFileConsumption, each ' +
        'reporting only a fixed category; one such failure voids the shared gate (never ' +
        'expectFlag=true); a missing env file still exits non-zero; an ambient value does not ' +
        'reach the child'
    )
  }
}

{
  // 64 是 **inclusive** 上限：消费完 64 个 gap code point 之后仍然检查终止字符，
  // 只有第 65 个 gap 才 exhausted。基线在 n=64 就越界，于是
  // `PASSWORD` + 64 空格 + `+=`（根本不是赋值）被误判成 fail closed（实测）。
  //
  // 九个格位都断言**完整的 Node tuple**，不是只看 `oracle.ok`：
  //
  //   - `=`（空值） → defined=true、empty=true   → Node 里是合法空占位；
  //   - `=<取值>`   → defined=true、empty=false  → Node 里是活凭据；
  //   - `+=<取值>`  → defined=false、empty=false → Node 根本不定义这个键。
  //
  // n=65 的 Node 语义与 63/64 **完全相同**（ASCII 空格照样被吃掉）；scanner 在
  // 那里**刻意偏离** Node：越过资源上限就放弃解析并 fail closed。偏离的格位必须
  // 精确列出，不能含混过去。
  const name = 'the 64 code point gap bound is inclusive and 65 deviates from Node deliberately'
  const expectedBoundaryCount = 9
  const rows = []
  const wrong = []
  const oracleFailures = []
  const deviations = []
  for (const size of [63, 64, 65]) {
    const gap = ' '.repeat(size)
    const exhausted = size > 64
    const shapes = [
      ['empty value', `PASSWORD${gap}=`, exhausted, { defined: true, empty: true }],
      ['non-empty value', `PASSWORD${gap}=SYNTHETIC-B${String(size)}`, true, { defined: true, empty: false }],
      ['not an assignment', `PASSWORD${gap}+=SYNTHETIC-B${String(size)}`, exhausted, { defined: false, empty: false }]
    ]
    for (const [label, line, expectFlag, expectedTuple] of shapes) {
      rows.push({ envLine: line, scanLine: line })
      // prose 角色：`+=` 在散文里就是「不是赋值」；strict 角色下它是可见间隔，
      // 由 file-role 那条 case 覆盖。
      const flagged = templateProblemsFor(line, 'README.md').some((problem) =>
        /assigns a non-empty value to a sensitive key/.test(problem)
      )
      if (flagged !== expectFlag) {
        wrong.push(`${String(size)}/${label}`)
      }
      const consumption = envFileConsumption(line, 'PASSWORD')
      if (!consumption.ok) {
        oracleFailures.push(`${String(size)}/${label}: ${consumption.reason}`)
        continue
      }
      if (
        consumption.defined !== expectedTuple.defined ||
        consumption.empty !== expectedTuple.empty
      ) {
        wrong.push(`${String(size)}/${label}: node tuple`)
        continue
      }
      // Node 认为这一行是活凭据吗？scanner 的判定与它不一致的格位就是偏离。
      const nodeSaysCredential = consumption.defined && !consumption.empty
      if (flagged !== nodeSaysCredential) {
        deviations.push(`${String(size)}/${label}`)
      }
    }
  }
  // scanner **只在**越过资源上限的两个非取值格位上偏离 Node，一个不多一个不少。
  const expectedDeviations = ['65/empty value', '65/not an assignment']
  const deviationsMatch =
    deviations.length === expectedDeviations.length &&
    expectedDeviations.every((entry) => deviations.includes(entry))
  const gate = evidenceGateProblems({
    rows,
    expectedRows: expectedBoundaryCount,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: expectedBoundaryCount,
    oracleIdentityOf: oracleIdentityOfRow,
    expectedOracleDistinct: expectedBoundaryCount,
    requiresOracle: true,
    oracleFailures,
    mismatches: wrong
  })
  if (gate.problems.length > 0) {
    fail(name, `${String(gate.problems.length)} gate problem(s); first: ${gate.problems[0]}`)
  } else if (!deviationsMatch) {
    fail(
      name,
      `${String(deviations.length)} row(s) deviate from the real Node consumption, expected ` +
        `exactly ${String(expectedDeviations.length)} at the resource bound`
    )
  } else {
    pass(
      name,
      `63 and 64 code point gaps still check the terminator; all ${String(expectedBoundaryCount)} ` +
        'cells assert the full Node tuple (empty => defined+empty, value => defined+non-empty, ' +
        '`+=` => not defined); at 65 Node reads exactly as it does at 63/64 and the scanner ' +
        `deviates on purpose in exactly ${String(expectedDeviations.length)} cells (resource ` +
        'bound => fail closed)'
    )
  }
}

{
  // 反身检查：走的是**同一个生产门禁** `evidenceGateProblems`，不是复制的判定。
  // 同一个 scanLine 放进两个 group 必须 distinct=1 且门禁失败；两个不同的
  // scanLine 必须 distinct=2 且门禁通过。
  const name = 'the shared evidence gate rejects the same input filed under two groups'
  const duplicated = [
    { group: 'alpha', key: 'PASSWORD', envLine: 'PASSWORD=x', scanLine: 'PASSWORD=x' },
    { group: 'beta', key: 'PASSWORD', envLine: 'PASSWORD=x', scanLine: 'PASSWORD=x' }
  ]
  const distinctRows = [
    { group: 'alpha', key: 'PASSWORD', envLine: 'PASSWORD=x', scanLine: 'PASSWORD=x' },
    { group: 'beta', key: 'PASSWORD', envLine: 'PASSWORD=y', scanLine: 'PASSWORD=y' }
  ]
  // 两条 identity **各自**都要有自反例：只测 scan 那一条的话，oracle identity
  // 分支回归了没人会发现（审计实测这个缺口）。
  const duplicatedGate = evidenceGateProblems({
    rows: duplicated,
    expectedRows: 2,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: 2,
    oracleIdentityOf: oracleIdentityOfRow,
    expectedOracleDistinct: 2
  })
  const distinctGate = evidenceGateProblems({
    rows: distinctRows,
    expectedRows: 2,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: 2,
    oracleIdentityOf: oracleIdentityOfRow,
    expectedOracleDistinct: 2
  })
  // 同一个 `[key, envLine]` 换一个 scanLine：scan 那条看着是 2，oracle 那条必须
  // 塌成 1 并让门禁失败。
  const sameOracleInput = [
    { group: 'alpha', key: 'PASSWORD', envLine: 'PASSWORD=x', scanLine: 'PASSWORD=x' },
    { group: 'beta', key: 'PASSWORD', envLine: 'PASSWORD=x', scanLine: 'NOTES=ok # PASSWORD=x' }
  ]
  const oracleGate = evidenceGateProblems({
    rows: sameOracleInput,
    expectedRows: 2,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: 2,
    oracleIdentityOf: oracleIdentityOfRow,
    expectedOracleDistinct: 2
  })
  // 声明一个低于行数的互异期望，门禁必须自己拒绝。
  const understatedGate = evidenceGateProblems({
    rows: duplicated,
    expectedRows: 2,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: 1
  })
  // 旧口径（identity 里带 group 标签）会把重复行算成两个不同输入。
  const groupTagged = new Set(duplicated.map((row) => `${row.group}|${row.scanLine}`)).size
  if (duplicatedGate.scanDistinct !== 1) {
    fail(name, 'two identical scanner inputs did not collapse to one identity')
  } else if (duplicatedGate.problems.length === 0) {
    fail(name, 'the shared gate accepted two identical scanner inputs as two')
  } else if (distinctGate.scanDistinct !== 2) {
    fail(name, 'two genuinely different scanner inputs collapsed to one identity')
  } else if (distinctGate.problems.length > 0) {
    fail(name, 'the shared gate rejected two genuinely different scanner inputs')
  } else if (oracleGate.oracleDistinct !== 1 || oracleGate.problems.length === 0) {
    fail(name, 'the same oracle input under two scan lines did not collapse and fail the gate')
  } else if (understatedGate.problems.length === 0) {
    fail(name, 'the gate accepted a declared distinct count below the row count')
  } else if (groupTagged !== 2) {
    fail(name, 'the superseded group-tagged identity no longer demonstrates the defect')
  } else {
    pass(
      name,
      'the same helper the matrices use: identity is the raw scanLine (and [key, envLine] for the ' +
        'oracle) with no group tag, so identical inputs collapse to 1 and fail the gate on both ' +
        'axes while genuinely different inputs stay 2 and pass; a declared distinct count below ' +
        'the row count is refused; the superseded group-tagged form counted the duplicates as 2'
    )
  }
}

// ---------------------------------------------------------------------------
// R15：strict dotenv 下的 Unicode 键续字符
// ---------------------------------------------------------------------------
process.stdout.write('R15: Unicode key continuation under the strict dotenv role\n')

{
  // 敏感 ASCII 词干之后的**非 ASCII 续字符**：Node 把它算进键名，于是整行定义出
  // 一个**活的**凭据，只是键名不叫 `PASSWORD`。基线实测 v24.18.0：
  // `PASSWORDé=` 定义 `PASSWORDé`、`PASSWORD٣=` 定义 `PASSWORD٣`、
  // `PASSWORD密码=` 定义 `PASSWORD密码`，而 strict 扫描器按「词字符
  // ⇒ 这不是赋值」终止，三条 **3/3 全部漏检**。组合附标（U+0301 / U+0327）不是
  // `\p{L}\p{N}_`，此前就走可见字符那一支 fail closed。
  //
  // 探针查询的是 **Node 实际创建的完整键名**，不是一律查 `PASSWORD`。
  const name = 'a key continuation after an ASCII stem fails closed under strict dotenv'
  const continuations = [
    ['latin small letter e with acute', 'é'],
    ['arabic-indic digit three', '٣'],
    ['han characters', '密码'],
    ['combining acute accent', '\u0301'],
    ['combining cedilla', '\u0327']
  ]
  const rows = []
  for (const [label, continuation] of continuations) {
    const key = `PASSWORD${continuation}`
    rows.push({ label, key, envLine: `${key}=AUDITVALUE-UNI`, scanLine: `${key}=AUDITVALUE-UNI` })
  }
  // ASCII 标点之后再接 ASCII 词字符：判据覆盖的是「词干之后、`=` 之前的任何
  // 有界续字符」，不只是非 ASCII 的那部分。Node 把这些同样定义成活的环境变量，
  // 所以它们必须有自己的注册反例，而不是靠上面几条顺带覆盖。
  for (const [label, continuation] of [
    ['ascii hyphen then words', '-FILE'],
    ['ascii dot then words', '.FILE'],
    ['ascii slash then words', '/v2'],
    ['ascii parentheses', '(old)']
  ]) {
    const key = `PASSWORD${continuation}`
    rows.push({ label, key, envLine: `${key}=AUDITVALUE-ASCII`, scanLine: `${key}=AUDITVALUE-ASCII` })
  }
  // 63 / 64 / 65 个续字符：**以 code point 计**的边界，确认没有新的 off-by-one。
  for (const size of [63, 64, 65]) {
    const key = `PASSWORD${'é'.repeat(size)}`
    const line = `${key}=AUDITVALUE-UNI${String(size)}`
    rows.push({ label: `${String(size)} continuation code points`, key, envLine: line, scanLine: line })
  }
  const expectedUnicodeKeyCount = 12
  const strictFiles = ['local-test.env.example', 'local-test.env', 'sample.env.template']
  const oracleFailures = []
  const mismatches = []
  const leaking = []
  const notLive = []
  const proseFlagged = []
  for (const row of rows) {
    // a) Node 真的用这个完整键名定义了一条非空取值吗？
    const consumption = envFileConsumption(row.envLine, row.key)
    if (!consumption.ok) {
      oracleFailures.push(`${row.label}: ${consumption.reason}`)
      continue
    }
    if (!consumption.defined || consumption.empty) {
      notLive.push(row.label)
      continue
    }
    // b) strict 角色的三种文件都必须 fail closed。
    for (const file of strictFiles) {
      const problems = templateProblemsFor(row.scanLine, file)
      if (!problems.some((problem) => /assigns a non-empty value to a sensitive key/.test(problem))) {
        mismatches.push(`${row.label}/${file}`)
      }
      if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
        leaking.push(`${row.label}/${file}`)
      }
    }
    // c) prose 角色保持「词字符 ⇒ 这不是赋值」，同一行必须干净。
    if (templateProblemsFor(row.scanLine, 'README.md').length > 0) {
      proseFlagged.push(row.label)
    }
  }
  // **键区里的 `#`**：`=` 之前的 `#` 对 Node 只是普通键名字符，整行照样定义出
  // 一条活凭据。审计实测这一族 5/5 漏检（strict 被截断、prose 按词字符终止）。
  const keyPositionHash = [
    ['ascii stem after a hash', 'FOO # PASSWORD=SECRET-KEYHASH', 'FOO # PASSWORD'],
    ['unicode continuation after a hash', 'FOO # PASSWORD\u00e9=SECRET-KEYHASH', 'FOO # PASSWORD\u00e9'],
    ['visible gap after a hash', 'FOO # PASSWORD\u2020=SECRET-KEYHASH', 'FOO # PASSWORD\u2020'],
    ['app secret after a hash', 'FOO # WECHAT_APP_SECRET\u5bc6=SECRET-KEYHASH', 'FOO # WECHAT_APP_SECRET\u5bc6'],
    ['stem embedded in a longer key', 'A # api_key\u00e9=SECRET-KEYHASH', 'A # api_key\u00e9']
  ]
  const keyHashMissed = []
  const keyHashNotLive = []
  for (const [label, line, nodeKey] of keyPositionHash) {
    const consumption = envFileConsumption(line, nodeKey)
    if (!consumption.ok) {
      oracleFailures.push(`${label}: ${consumption.reason}`)
      continue
    }
    if (!consumption.defined || consumption.empty) {
      keyHashNotLive.push(label)
      continue
    }
    for (const file of strictFiles) {
      if (
        !templateProblemsFor(line, file).some((problem) =>
          /assigns a non-empty value to a sensitive key/.test(problem)
        )
      ) {
        keyHashMissed.push(`${label}/${file}`)
      }
    }
  }
  // strict 的续字符规则只覆盖**键区**：取值内部的同样写法不得因此多报。
  const valueRegionControls = [
    'TIP="token \u6709\u6548\u671f=7\u5929"',
    'NOTE="password \u5bc6\u7801=x"',
    'NOTE_CN="\u8bbe\u7f6e token \u540e=\u751f\u6548"',
    'HELP="secret \u5bc6\u94a5=\u89c1 vault"'
  ]
  const valueRegionFlagged = valueRegionControls.filter((line) =>
    templateProblemsFor(line, 'local-test.env.example').length > 0
  )
  // prose 的既定普通文本对照仍然干净。
  const proseControls = [
    '- `POSTGRES_PASSWORD` = 数据库密码',
    'keys += 1',
    '# TOKEN >= 32 chars',
    'if (token != null) { }'
  ]
  const proseControlFlagged = proseControls.filter(
    (line) => templateProblemsFor(line, 'README.md').length > 0
  )
  const gate = evidenceGateProblems({
    rows,
    expectedRows: expectedUnicodeKeyCount,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: expectedUnicodeKeyCount,
    oracleIdentityOf: oracleIdentityOfRow,
    expectedOracleDistinct: expectedUnicodeKeyCount,
    requiresOracle: true,
    oracleFailures,
    mismatches,
    leaking
  })
  if (gate.problems.length > 0) {
    fail(name, `${String(gate.problems.length)} gate problem(s); first: ${gate.problems[0]}`)
  } else if (notLive.length > 0) {
    fail(name, `${String(notLive.length)} Unicode key row(s) are not live credentials in Node`)
  } else if (proseFlagged.length > 0) {
    fail(name, `${String(proseFlagged.length)} Unicode key row(s) were flagged in a prose file`)
  } else if (proseControlFlagged.length > 0) {
    fail(name, `${String(proseControlFlagged.length)} ordinary prose line(s) were flagged`)
  } else if (keyHashNotLive.length > 0) {
    fail(name, `${String(keyHashNotLive.length)} key-position hash row(s) are not live in Node`)
  } else if (keyHashMissed.length > 0) {
    fail(name, `${String(keyHashMissed.length)} key-position hash credential(s) went uncaught`)
  } else if (valueRegionFlagged.length > 0) {
    fail(name, `${String(valueRegionFlagged.length)} value-region line(s) were wrongly flagged`)
  } else {
    pass(
      name,
      `${String(expectedUnicodeKeyCount)} key continuations (5 non-ASCII forms + 4 ASCII ` +
        'punctuation-then-word forms + the 63/64/65 code point boundary, all distinct) are live ' +
        `credentials in Node ${oracleNodeVersion} and fail ` +
        `closed in all ${String(strictFiles.length)} strict dotenv files; the same lines stay ` +
        `clean under the prose role, as do ${String(proseControls.length)} ordinary prose lines; ` +
        `${String(keyPositionHash.length)} credentials hidden behind a key-position \`#\` are live ` +
        'in Node and fail closed in every strict file, while ' +
        `${String(valueRegionControls.length)} value-region lines with CJK and an equals sign stay ` +
        'clean (strict only governs the key region); no key or value echoed'
    )
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
    const { hits } = scanTrackedRepositoryForNeedles(repo, needles)
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

{
  const name = 'ambient Git repository views and zero tracked files fail closed'
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-git-view-'))
  const problems = []
  const sentinel = 'M3B-GIT-VIEW-SENTINEL'
  const previousIndex = process.env.GIT_INDEX_FILE
  try {
    const repo = resolve(parent, 'repo')
    const templateDirectory = resolve(repo, 'infra/environments/local-test')
    mkdirSync(templateDirectory, { recursive: true })
    for (const args of [
      ['init', '--quiet', repo],
      ['-C', repo, 'config', 'user.email', 'git-view@example.invalid'],
      ['-C', repo, 'config', 'user.name', 'M3B git view']
    ]) {
      const result = git(args)
      if (result.error !== undefined || result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed`)
      }
    }
    writeFileSync(resolve(templateDirectory, 'local-test.env.example'), 'SAFE_VALUE=\n')
    git(['-C', repo, 'add', '-A'])
    git(['-C', repo, 'commit', '--quiet', '-m', 'baseline'])

    const alternateIndex = resolve(parent, `${sentinel}.index`)
    const alternate = git(['-C', repo, 'read-tree', 'HEAD'], {
      env: { ...process.env, GIT_INDEX_FILE: alternateIndex }
    })
    if (alternate.error !== undefined || alternate.status !== 0) {
      throw new Error('could not create the alternate index precondition')
    }

    // canonical index 里确实暂存一份工作树看不见的 Secret；先证明正常视图会命中，
    // 再切到干净 alternate index。否则「拒绝 GIT_INDEX_FILE」虽然会绿，却没有证明
    // 这个 override 真能把待提交的 Secret 从扫描面里拿掉。
    writeFileSync(
      resolve(templateDirectory, 'local-test.env.example'),
      `PASSWORD=${sentinel}\n`,
      'utf8'
    )
    const staged = git([
      '-C',
      repo,
      'add',
      '--',
      'infra/environments/local-test/local-test.env.example'
    ])
    writeFileSync(resolve(templateDirectory, 'local-test.env.example'), 'SAFE_VALUE=\n', 'utf8')
    if (staged.error !== undefined || staged.status !== 0) {
      throw new Error('could not stage the canonical-index Secret precondition')
    }
    const canonicalTemplateProblems = scanTrackedTemplates(repo)
    const canonicalNeedleScan = scanTrackedRepositoryForNeedles(repo, [
      { id: 1, category: 'probe', value: sentinel }
    ])
    if (
      canonicalTemplateProblems.length === 0 ||
      !canonicalNeedleScan.hits.some((hit) => /git index/.test(String(hit.label))) ||
      JSON.stringify(canonicalTemplateProblems).includes(sentinel) ||
      JSON.stringify(canonicalNeedleScan).includes(sentinel)
    ) {
      throw new Error('the canonical-index Secret precondition was not detected safely')
    }

    process.env.GIT_INDEX_FILE = alternateIndex
    try {
      scanTrackedTemplates(repo)
      problems.push('the tracked-template scanner accepted an alternate index')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('GIT_INDEX_FILE') || message.includes(sentinel)) {
        problems.push('the tracked-template refusal used the wrong or unsafe reason')
      }
    }
    const overridden = scanTrackedRepositoryForNeedles(repo, [
      { id: 1, category: 'probe', value: sentinel }
    ])
    if (
      overridden.scannedFiles !== 0 ||
      !overridden.hits.some(
        (hit) => hit.category === 'scan-unavailable' && /GIT_INDEX_FILE/.test(hit.problem)
      ) ||
      JSON.stringify(overridden).includes(alternateIndex)
    ) {
      problems.push('the repository containment scan accepted or echoed an alternate index')
    }

    const shimDirectory = resolve(parent, 'bin')
    const dockerMarker = resolve(parent, 'docker-was-called')
    mkdirSync(shimDirectory)
    writeFileSync(
      resolve(shimDirectory, 'docker'),
      '#!/bin/sh\n: > "$M3B_DOCKER_MARKER"\nexit 99\n',
      'utf8'
    )
    chmodSync(resolve(shimDirectory, 'docker'), 0o755)
    const topology = spawnSync(
      process.execPath,
      [resolve(composeDirectory, 'check-compose-topology.mjs')],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          GIT_INDEX_FILE: alternateIndex,
          M3B_DOCKER_MARKER: dockerMarker,
          PATH: `${shimDirectory}:${process.env.PATH ?? ''}`
        }
      }
    )
    if (
      topology.error !== undefined ||
      topology.status !== 1 ||
      !/canonical Git repository view.*GIT_INDEX_FILE/.test(String(topology.stderr)) ||
      String(topology.stderr).includes(alternateIndex) ||
      existsSync(dockerMarker)
    ) {
      problems.push('the compose topology gate accepted an alternate index or reached Docker')
    }
    delete process.env.GIT_INDEX_FILE

    const emptyRepo = resolve(parent, 'empty')
    const initialized = git(['init', '--quiet', emptyRepo])
    if (initialized.error !== undefined || initialized.status !== 0) {
      throw new Error('could not create the empty repository precondition')
    }
    const empty = scanTrackedRepositoryForNeedles(emptyRepo, [
      { id: 1, category: 'probe', value: sentinel }
    ])
    if (
      empty.scannedFiles !== 0 ||
      !empty.hits.some(
        (hit) => hit.category === 'scan-unavailable' && /tracked-file set is empty/.test(hit.problem)
      )
    ) {
      problems.push('an empty canonical tracked-file set did not fail closed')
    }
  } catch (error) {
    problems.push(`fixture failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (previousIndex === undefined) {
      delete process.env.GIT_INDEX_FILE
    } else {
      process.env.GIT_INDEX_FILE = previousIndex
    }
    rmSync(parent, { recursive: true, force: true })
  }
  if (problems.length > 0) {
    fail(name, problems[0])
  } else {
    pass(
      name,
      'GIT_INDEX_FILE is refused by every production scanner/gate before Docker without ' +
        'echoing its value, and an empty canonical index is scan-unavailable'
    )
  }
}

{
  const name = 'Docker artifact collection rejects empty or malformed successful evidence'
  const problems = []
  const containerId = 'a'.repeat(64)
  const otherContainerId = 'c'.repeat(64)
  const imageId = `sha256:${'b'.repeat(64)}`
  const validContainerInspect = (id = containerId) => ({
    Id: id,
    Created: '2026-08-04T00:00:00.000000000Z',
    Name: '/fixture',
    Config: { Env: [], Cmd: [], Entrypoint: [] },
    State: {},
    HostConfig: {},
    NetworkSettings: {},
    Mounts: [],
    Args: [],
    Path: '/fixture',
    Image: imageId
  })
  const validImageInspect = () => ({
    Id: imageId,
    Created: '2026-08-04T00:00:00.000000000Z',
    Architecture: 'arm64',
    Os: 'linux',
    RepoTags: ['meal-agent-api:m3b-fixture'],
    Config: {},
    RootFS: { Layers: [`sha256:${'d'.repeat(64)}`] }
  })
  const validHistoryRow = () => ({
      ID: imageId,
      CreatedAt: '2026-08-04T00:00:00Z',
      CreatedBy: '/bin/sh -c fixture',
      Size: '0B',
      Comment: ''
    })
  const validHistory = () => `${JSON.stringify(validHistoryRow())}\n`
  const emptyInspectProblems = []
  const emptyInspect = await collectDockerArtifactsForProject({
    project: 'm3b-artifact-fixture',
    onProblem: (problem) => emptyInspectProblems.push(problem),
    run: async (args) => {
      if (args[1] === 'ps') {
        return { status: 0, stdout: `${containerId}\n`, stderr: '' }
      }
      if (args[1] === 'inspect') {
        return { status: 0, stdout: '[]', stderr: '' }
      }
      throw new Error(`unexpected fixture command: ${args.join(' ')}`)
    }
  })
  if (
    emptyInspectProblems.length !== 1 ||
    !/did not return one container object/.test(emptyInspectProblems[0]) ||
    emptyInspect.artifacts.length !== 0
  ) {
    problems.push('container inspect=[] was accepted or materialised as evidence')
  }

  const mismatchedContainerProblems = []
  const mismatchedContainer = await collectDockerArtifactsForProject({
    project: 'm3b-artifact-fixture',
    onProblem: (problem) => mismatchedContainerProblems.push(problem),
    run: async (args) => {
      if (args[1] === 'ps') {
        return { status: 0, stdout: `${containerId}\n`, stderr: '' }
      }
      if (args[1] === 'inspect') {
        return {
          status: 0,
          stdout: JSON.stringify([validContainerInspect(otherContainerId)]),
          stderr: ''
        }
      }
      throw new Error(`unexpected fixture command: ${args.join(' ')}`)
    }
  })
  if (
    !mismatchedContainerProblems.some((problem) =>
      /did not identify the requested container/.test(problem)
    ) ||
    mismatchedContainer.artifacts.length !== 0
  ) {
    problems.push('an inspect object for the wrong container was accepted as evidence')
  }

  const containerEvidenceMutations = [
    ['Created', (value) => delete value.Created],
    ['empty Created', (value) => (value.Created = '')],
    ['Name', (value) => delete value.Name],
    ['empty Name', (value) => (value.Name = '')],
    ['null Config', (value) => (value.Config = null)],
    ['array Config', (value) => (value.Config = [])],
    ['Config.Env', (value) => delete value.Config.Env],
    ['invalid Config.Env', (value) => (value.Config.Env = {})],
    ['Config.Cmd', (value) => delete value.Config.Cmd],
    ['invalid Config.Cmd', (value) => (value.Config.Cmd = {})],
    ['Config.Entrypoint', (value) => delete value.Config.Entrypoint],
    ['invalid Config.Entrypoint', (value) => (value.Config.Entrypoint = {})],
    ['State', (value) => delete value.State],
    ['null State', (value) => (value.State = null)],
    ['array State', (value) => (value.State = [])],
    ['HostConfig', (value) => delete value.HostConfig],
    ['null HostConfig', (value) => (value.HostConfig = null)],
    ['array HostConfig', (value) => (value.HostConfig = [])],
    ['NetworkSettings', (value) => delete value.NetworkSettings],
    ['null NetworkSettings', (value) => (value.NetworkSettings = null)],
    ['array NetworkSettings', (value) => (value.NetworkSettings = [])],
    ['Mounts', (value) => delete value.Mounts],
    ['invalid Mounts', (value) => (value.Mounts = {})],
    ['Args', (value) => delete value.Args],
    ['invalid Args', (value) => (value.Args = {})],
    ['Path', (value) => delete value.Path],
    ['invalid Path', (value) => (value.Path = {})],
    ['Image', (value) => delete value.Image],
    ['empty Image', (value) => (value.Image = '')]
  ]
  for (const [field, mutate] of containerEvidenceMutations) {
    const payload = validContainerInspect()
    mutate(payload)
    const fieldProblems = []
    const collected = await collectDockerArtifactsForProject({
      project: 'm3b-artifact-fixture',
      onProblem: (problem) => fieldProblems.push(problem),
      run: async (args) => {
        if (args[1] === 'ps') {
          return { status: 0, stdout: `${containerId}\n`, stderr: '' }
        }
        if (args[1] === 'inspect') {
          return { status: 0, stdout: JSON.stringify([payload]), stderr: '' }
        }
        throw new Error(`unexpected fixture command after missing ${field}: ${args.join(' ')}`)
      }
    })
    if (
      fieldProblems.length !== 1 ||
      !/omitted required evidence fields/.test(fieldProblems[0]) ||
      collected.artifacts.length !== 0
    ) {
      problems.push(`container inspect missing ${field} was accepted as evidence`)
    }
  }

  const imageEvidenceVariants = [
    {
      label: 'empty',
      inspect: '',
      history: '',
      inspectInvalid: true,
      historyInvalid: true
    }
  ]
  const imageInspectMutations = [
    ['wrong Id', (value) => (value.Id = `sha256:${'e'.repeat(64)}`)],
    ['missing Created', (value) => delete value.Created],
    ['empty Created', (value) => (value.Created = '')],
    ['missing Architecture', (value) => delete value.Architecture],
    ['empty Architecture', (value) => (value.Architecture = '')],
    ['missing Os', (value) => delete value.Os],
    ['empty Os', (value) => (value.Os = '')],
    ['missing RepoTags', (value) => delete value.RepoTags],
    ['invalid RepoTags', (value) => (value.RepoTags = {})],
    ['missing Config', (value) => delete value.Config],
    ['null Config', (value) => (value.Config = null)],
    ['invalid Config', (value) => (value.Config = [])],
    ['missing RootFS', (value) => delete value.RootFS],
    ['null RootFS', (value) => (value.RootFS = null)],
    ['invalid RootFS', (value) => (value.RootFS = [])],
    ['missing RootFS.Layers', (value) => delete value.RootFS.Layers],
    ['invalid RootFS.Layers', (value) => (value.RootFS.Layers = {})],
    ['empty RootFS.Layers', (value) => (value.RootFS.Layers = [])]
  ]
  for (const [label, mutate] of imageInspectMutations) {
    const image = validImageInspect()
    mutate(image)
    imageEvidenceVariants.push({
      label: `image inspect ${label}`,
      inspect: JSON.stringify([image]),
      history: validHistory(),
      inspectInvalid: true,
      historyInvalid: false
    })
  }
  const historyMutations = [
    ['wrong ID', (value) => (value.ID = `sha256:${'e'.repeat(64)}`)],
    ['missing CreatedAt', (value) => delete value.CreatedAt],
    ['empty CreatedAt', (value) => (value.CreatedAt = '')],
    ['missing CreatedBy', (value) => delete value.CreatedBy],
    ['missing Size', (value) => delete value.Size],
    ['missing Comment', (value) => delete value.Comment],
    ['invalid Comment', (value) => (value.Comment = 42)]
  ]
  for (const [label, mutate] of historyMutations) {
    const row = validHistoryRow()
    mutate(row)
    imageEvidenceVariants.push({
      label: `image history ${label}`,
      inspect: JSON.stringify([validImageInspect()]),
      history: `${JSON.stringify(row)}\n`,
      inspectInvalid: false,
      historyInvalid: true
    })
  }
  imageEvidenceVariants.push({
    label: 'image history second row is not an object',
    inspect: JSON.stringify([validImageInspect()]),
    history: `${validHistory()}null\n`,
    inspectInvalid: false,
    historyInvalid: true
  })
  imageEvidenceVariants.push({
    label: 'image history second row has a non-string ID',
    inspect: JSON.stringify([validImageInspect()]),
    history: `${validHistory()}${JSON.stringify({ ...validHistoryRow(), ID: 42 })}\n`,
    inspectInvalid: false,
    historyInvalid: true
  })
  for (const variant of imageEvidenceVariants) {
    const imageProblems = []
    const historyCommands = []
    const collected = await collectDockerArtifactsForProject({
      project: 'm3b-artifact-fixture',
      onProblem: (problem) => imageProblems.push(problem),
      run: async (args) => {
        if (args[1] === 'ps') {
          return { status: 0, stdout: `${containerId}\n`, stderr: '' }
        }
        if (args[1] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify([validContainerInspect()]),
            stderr: ''
          }
        }
        if (args[1] === 'logs') {
          return { status: 0, stdout: '', stderr: '' }
        }
        if (args[1] === 'image' && args[2] === 'inspect') {
          return { status: 0, stdout: variant.inspect, stderr: '' }
        }
        if (args[1] === 'image' && args[2] === 'history') {
          historyCommands.push(args)
          return { status: 0, stdout: variant.history, stderr: '' }
        }
        throw new Error(`unexpected fixture command: ${args.join(' ')}`)
      }
    })
    const imageArtifactLabels = collected.artifacts.map((artifact) => artifact.label)
    const inspectRejected = imageProblems.some((problem) =>
      /image inspect .* invalid evidence/.test(problem)
    )
    const historyRejected = imageProblems.some((problem) =>
      /image history .* invalid evidence/.test(problem)
    )
    const expectedHistoryCommand = [
      'docker',
      'image',
      'history',
      '--no-trunc',
      '--format',
      '{{json .}}',
      imageId
    ]
    if (
      inspectRejected !== variant.inspectInvalid ||
      historyRejected !== variant.historyInvalid ||
      imageProblems.length !== Number(variant.inspectInvalid) + Number(variant.historyInvalid) ||
      imageArtifactLabels.some(
        (label) =>
          (variant.inspectInvalid && /^image inspect/.test(label)) ||
          (variant.historyInvalid && /^image history/.test(label))
      ) ||
      (!variant.inspectInvalid && !imageArtifactLabels.some((label) => /^image inspect/.test(label))) ||
      (!variant.historyInvalid && !imageArtifactLabels.some((label) => /^image history/.test(label))) ||
      historyCommands.length !== 1 ||
      JSON.stringify(historyCommands[0]) !== JSON.stringify(expectedHistoryCommand)
    ) {
      problems.push(`${variant.label} image evidence was accepted as scanned evidence`)
    }
  }
  if (problems.length > 0) {
    fail(name, problems[0])
  } else {
    pass(
      name,
      'container inspect=[]/wrong-id/missing-field and independently empty/truncated image ' +
        'inspect/history payloads fail closed; history uses the pinned JSON format argv'
    )
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
// ---------------------------------------------------------------------------
// R16：Node-active 键文法、注释里的赋值、`export` 前缀的真实语义
// ---------------------------------------------------------------------------
process.stdout.write('R16: the real Node key grammar\n')

{
  // 数字开头的键：Node **接受**，自由文本的 `[A-Za-z_][A-Za-z0-9_]*` 匹配不上。
  // 基线实测 9 条非空形态 **9/9 全部漏检**（每条都先由 oracle 证明是活凭据）。
  const name = 'keys the free-text grammar cannot reach are scanned by the real dotenv grammar'
  const rows = []
  for (const [label, key] of [
    ['0PASSWD', '0PASSWD'],
    ['1PASSWORD', '1PASSWORD'],
    ['3TOKEN', '3TOKEN'],
    ['0DATABASE_URL', '0DATABASE_URL'],
    ['1PASSWORD + non-ASCII continuation', '1PASSWORD\u00e9'],
    ['1_POSTGRES_PASSWORD', '1_POSTGRES_PASSWORD']
  ]) {
    rows.push({ label, key, envLine: `${key}=AUDITVALUE-DIGIT`, scanLine: `${key}=AUDITVALUE-DIGIT` })
  }
  // `export` 前缀被 Node 认掉之后，键仍然是数字开头的那个。
  rows.push({
    label: 'export 9PASSWORD',
    key: '9PASSWORD',
    envLine: 'export 9PASSWORD=AUDITVALUE-DIGIT',
    scanLine: 'export 9PASSWORD=AUDITVALUE-DIGIT'
  })
  // 前导 ASCII 空白同样被 Node 吃掉。
  rows.push({
    label: 'leading spaces 0PASSWD',
    key: '0PASSWD',
    envLine: '  0PASSWD=AUDITVALUE-DIGITWS',
    scanLine: '  0PASSWD=AUDITVALUE-DIGITWS'
  })
  rows.push({
    label: 'leading tab 1PASSWORD',
    key: '1PASSWORD',
    envLine: '\t1PASSWORD=AUDITVALUE-DIGITTAB',
    scanLine: '\t1PASSWORD=AUDITVALUE-DIGITTAB'
  })
  // **行首多打一个 `=`**：Node 会跳过空键继续往后找，键仍然是后面那个。审计实测
  // 这一族 6/6 全漏，其中 `=0PASSWD=` 正好绕过上面那几条数字开头键。
  for (const [label, line, key] of [
    ['leading equals', '=0PASSWD=AUDITVALUE-LEADEQ', '0PASSWD'],
    ['double leading equals', '==0PASSWD=AUDITVALUE-LEADEQ2', '0PASSWD'],
    ['leading equals + non-ASCII', '=1PASSWORD\u00e9=AUDITVALUE-LEADEQ3', '1PASSWORD\u00e9'],
    ['leading equals + punctuation', '=WECHAT_APP_SECRET/v2=AUDITVALUE-LEADEQ4', 'WECHAT_APP_SECRET/v2']
  ]) {
    rows.push({ label, key, envLine: line, scanLine: line })
  }
  // 词干被 ASCII 标点从**内部**切断：`APP_ID` 散成 `APP` + `ID` 就不再命中。
  for (const [label, key] of [
    ['hyphen inside the stem', 'WECHAT_APP-ID'],
    ['dot inside the stem', 'WECHAT_APP.ID']
  ]) {
    rows.push({ label, key, envLine: `${key}=AUDITVALUE-STEM`, scanLine: `${key}=AUDITVALUE-STEM` })
  }
  // 63 / 64 / 65 码点续字符：资源边界上也不得漏。
  for (const size of [63, 64, 65]) {
    const key = `0PASSWORD${'\u00e9'.repeat(size)}`
    rows.push({
      label: `${String(size)} continuation code points`,
      key,
      envLine: `${key}=AUDITVALUE-DIGIT${String(size)}`,
      scanLine: `${key}=AUDITVALUE-DIGIT${String(size)}`
    })
  }
  const expectedDigitKeyCount = 18
  const strictFiles = ['local-test.env.example', 'local-test.env', 'sample.env.template']
  const oracleFailures = []
  const mismatches = []
  const leaking = []
  const notLive = []
  for (const row of rows) {
    const consumption = envFileConsumption(row.envLine, row.key)
    if (!consumption.ok) {
      oracleFailures.push(`${row.label}: ${consumption.reason}`)
      continue
    }
    if (!consumption.defined || consumption.empty) {
      notLive.push(row.label)
      continue
    }
    for (const file of strictFiles) {
      const problems = templateProblemsFor(row.scanLine, file)
      if (!problems.some((problem) => /assigns a non-empty value to a sensitive key/.test(problem))) {
        mismatches.push(`${row.label}/${file}`)
      }
      if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
        leaking.push(`${row.label}/${file}`)
      }
    }
  }
  // 同结构的**空占位**必须干净（Node 建的键存在但取值是空串）。
  const emptyPlaceholders = ['0PASSWD=', '1PASSWORD=', '3TOKEN=', 'export 9PASSWORD=']
  const placeholderFlagged = emptyPlaceholders.filter(
    (line) => templateProblemsFor(line, 'local-test.env.example').length > 0
  )
  // benign 散文对照。
  const benignProse = [
    '0 PASSWORD entries were rotated',
    'step 1 PASSWORD rotation is manual',
    '3 tokens remain',
    '`0PASSWD` 是历史遗留键名'
  ]
  const benignFlagged = benignProse.filter(
    (line) => templateProblemsFor(line, 'README.md').length > 0
  )
  const gate = evidenceGateProblems({
    rows,
    expectedRows: expectedDigitKeyCount,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: expectedDigitKeyCount,
    oracleIdentityOf: oracleIdentityOfRow,
    expectedOracleDistinct: expectedDigitKeyCount,
    requiresOracle: true,
    oracleFailures,
    mismatches,
    leaking
  })
  if (gate.problems.length > 0) {
    fail(name, `${String(gate.problems.length)} gate problem(s); first: ${gate.problems[0]}`)
  } else if (notLive.length > 0) {
    fail(name, `${String(notLive.length)} digit-leading key row(s) are not live credentials in Node`)
  } else if (placeholderFlagged.length > 0) {
    fail(name, `${String(placeholderFlagged.length)} empty placeholder(s) were wrongly flagged`)
  } else if (benignFlagged.length > 0) {
    fail(name, `${String(benignFlagged.length)} benign prose line(s) were flagged`)
  } else {
    pass(
      name,
      `${String(expectedDigitKeyCount)} Node-active keys the free-text grammar cannot reach ` +
        '(digit-leading plain / non-ASCII continuation / export prefix / leading whitespace, a ' +
        'leading `=` that Node skips, a stem split by ASCII punctuation, and the 63/64/65 ' +
        'code point boundary, ' +
        `all distinct) are live credentials in Node ${oracleNodeVersion} and fail closed in all ` +
        `${String(strictFiles.length)} strict dotenv files; ${String(emptyPlaceholders.length)} ` +
        `empty placeholders and ${String(benignProse.length)} benign prose lines stay clean; no ` +
        'key or value echoed'
    )
  }
}

{
  // 注释里的凭据同样会随 commit 进 Git。此前只有纯词字符键名能命中，含 ASCII
  // 标点续字符的形态实测 **6/6 全漏**（4 条整行 + 2 条行内；`# PASSWORD_OLD=` 与
  // `# PASSWORD=` 是能命中的
  // 正向对照，证明漏的是续字符而不是整条注释通路）。
  const name = 'a commented credential with an ASCII continuation is caught'
  const commented = [
    ['hyphen', '# PASSWORD-FILE=AUDITVALUE-CMT'],
    ['dot', '# PASSWORD.FILE=AUDITVALUE-CMT'],
    ['slash', '# PASSWORD/v2=AUDITVALUE-CMT'],
    ['parentheses', '# PASSWORD(old)=AUDITVALUE-CMT'],
    ['inline hyphen', 'NOTES=ok # PASSWORD-FILE=AUDITVALUE-CMTINL'],
    ['inline dot', 'NOTES=ok # PASSWORD.FILE=AUDITVALUE-CMTINL'],
    ['underscore control', '# PASSWORD_OLD=AUDITVALUE-CMT'],
    ['plain control', '# PASSWORD=AUDITVALUE-CMT']
  ]
  const files = ['local-test.env.example', 'README.md']
  const missed = []
  const leaking = []
  for (const [label, line] of commented) {
    for (const file of files) {
      const problems = templateProblemsFor(line, file)
      if (!problems.some((problem) => /assigns a non-empty value to a sensitive key/.test(problem))) {
        missed.push(`${label}/${file}`)
      }
      if (problems.some((problem) => !allowedProblemShape.test(String(problem)))) {
        leaking.push(`${label}/${file}`)
      }
    }
  }
  // 同结构的空占位必须干净。
  const emptyComments = [
    '# PASSWORD-FILE=',
    '# PASSWORD.FILE=',
    '# PASSWORD(old)=',
    '# PASSWORD_OLD=',
    'NOTES=ok # PASSWORD-FILE='
  ]
  const emptyFlagged = emptyComments.filter(
    (line) => templateProblemsFor(line, 'local-test.env.example').length > 0
  )
  // 普通 README / Markdown 散文必须保持干净——判据是有界的，不是「让散文吃
  // 可见字符」。
  const proseControls = [
    '- `POSTGRES_PASSWORD` = 数据库密码',
    'keys += 1',
    '# TOKEN >= 32 chars',
    'if (token != null) { }',
    '| `PASSWORD-FILE` | 说明 |',
    'see docs/setup.md#password-file for details',
    '# 说明：留空 = 使用默认值',
    '# PASSWORD rotation policy lives in the runbook',
    // 文档链接与 Markdown 标题：注释判据不得把 URL / query 当成 dotenv 键。
    '# See https://api.example.com/v1/keys?limit=10',
    '# GET /api/secrets?page=2',
    '# docs https://example.com/docs/tokens?lang=zh',
    '# [keys](https://example.com/keys?ref=doc)'
  ]
  const proseFlagged = proseControls.filter(
    (line) => templateProblemsFor(line, 'README.md').length > 0
  )
  // Node 对这些行**不定义任何变量**——这是纯 containment 面，证据要留痕。
  const wholeLineProbe = envFileConsumption('# PASSWORD-FILE=AUDITVALUE-CMT', 'PASSWORD-FILE')
  if (missed.length > 0) {
    fail(name, `${String(missed.length)} commented credential(s) went uncaught`)
  } else if (emptyFlagged.length > 0) {
    fail(name, `${String(emptyFlagged.length)} commented empty placeholder(s) were wrongly flagged`)
  } else if (proseFlagged.length > 0) {
    fail(name, `${String(proseFlagged.length)} ordinary prose line(s) were flagged`)
  } else if (leaking.length > 0) {
    fail(name, 'a failure message left the fixed category shape (not reprinted here)')
  } else if (!wholeLineProbe.ok || wholeLineProbe.defined) {
    fail(name, 'the containment premise is wrong: Node defined a variable for a comment line')
  } else {
    pass(
      name,
      `${String(commented.length)} commented credentials (hyphen, dot, slash, parentheses, two ` +
        'inline forms and the underscore/plain controls) are caught in both a strict dotenv file ' +
        `and a prose file; ${String(emptyComments.length)} commented empty placeholders and ` +
        `${String(proseControls.length)} ordinary prose lines stay clean; Node defines nothing ` +
        'for a comment line, so this surface is containment only'
    )
  }
}

{
  // `export` 前缀的真实语义：Node 只认 `export` + **SPACE**。
  const name = 'the export prefix follows Node exactly, including the TAB case'
  const cases = [
    ['one space', 'export PASSWORD=AUDITVALUE-EXP', 'PASSWORD', true],
    ['two spaces', 'export  PASSWORD=AUDITVALUE-EXP', 'PASSWORD', true],
    ['space then tab', 'export \tPASSWORD=AUDITVALUE-EXP', 'PASSWORD', true],
    ['tab keeps export in the key', 'export\tPASSWORD=AUDITVALUE-EXP', 'export\tPASSWORD', false],
    ['tab keeps export in the key (token)', 'export\tTOKEN=AUDITVALUE-EXP', 'export\tTOKEN', false],
    // `export` 后只有空白再遇 `=` 时，Node 把 `export` 本身当键；不能剥空之后
    // 错把后面的 PASSWORD 当成 active key。整行仍会因嵌套的赋值形文本按
    // containment fail closed，但 parser identity 必须与 Node 一致。
    ['empty prefixed key keeps export as the key', 'export =PASSWORD=V', 'export', true]
  ]
  const wrongKey = []
  const missed = []
  const oracleFailures = []
  for (const [label, line, expectedKey, plainKeyDefined] of cases) {
    const onExpected = envFileConsumption(line, expectedKey)
    const onPlain = envFileConsumption(line, expectedKey.replace(/^export\t/, ''))
    if (!onExpected.ok || !onPlain.ok) {
      oracleFailures.push(label)
      continue
    }
    // Node 必须用**这个**键定义出非空取值……
    if (!onExpected.defined || onExpected.empty) {
      wrongKey.push(`${label}: expected key not defined`)
      continue
    }
    // ……而 TAB 那两条里，去掉 `export\t` 之后的裸键必须**没有**被定义。
    if (onPlain.defined !== plainKeyDefined) {
      wrongKey.push(`${label}: bare key definition disagrees with Node`)
      continue
    }
    if (
      !templateProblemsFor(line, 'local-test.env.example').some((problem) =>
        /assigns a non-empty value to a sensitive key/.test(problem)
      )
    ) {
      missed.push(label)
    }
  }
  // `export\tPASSWORD=` 是空占位，必须干净。
  const emptyExport = templateProblemsFor('export\tPASSWORD=', 'local-test.env.example').length
  // **行为判据**（不是文本匹配）：扫描器自己解析出来的键，必须与 Node 真正建立的
  // 键逐条一致。审计实测：原先那条 `export[ \t]+` 源码文本断言挡不住把同一个缺陷
  // 换个拼法（`export[\t ]+`）写回来，而且五条 scanner 侧断言在有/无该缺陷时**结论
  // 完全相同**——它根本不具备判别力。现在改成拿 `nodeActiveAssignment` 的输出与
  // oracle 对质：一旦 TAB 又被当成前缀分隔符，键就会变成 `PASSWORD`，而 oracle 会
  // 证明 Node 根本没定义这个键，整条 case 立刻失败。
  const grammarDisagrees = []
  for (const [label, line, expectedKey] of cases) {
    const parsed = nodeActiveAssignment(line)
    if (parsed === null || parsed.key !== expectedKey) {
      grammarDisagrees.push(label)
    }
  }
  // 源码文本判据保留为第二道保险（便宜，但**不是**主判据）。
  const grammarSource = readFileSync(
    resolve(repositoryRoot, 'infra/docker/local-test-secrets-contract.mjs'),
    'utf8'
  )
  const fabricatedGrammar = grammarSource
    .split('\n')
    .filter((sourceLine) => {
      const trimmed = sourceLine.trim()
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
    })
    .some((sourceLine) => /export\[[^\]]*\]/.test(sourceLine))
  if (oracleFailures.length > 0) {
    fail(name, `${String(oracleFailures.length)} oracle probe(s) failed; the evidence is void`)
  } else if (wrongKey.length > 0) {
    fail(name, `${String(wrongKey.length)} export form(s) disagreed with the real Node key`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} export-prefixed credential(s) went uncaught`)
  } else if (grammarDisagrees.length > 0) {
    fail(
      name,
      `${String(grammarDisagrees.length)} export form(s): the scanner's parsed key disagrees ` +
        'with the key Node actually creates'
    )
  } else if (emptyExport > 0) {
    fail(name, 'an export-prefixed empty placeholder was wrongly flagged')
  } else if (fabricatedGrammar) {
    fail(name, 'the scanner still carries an `export[ \\t]+` grammar Node does not implement')
  } else {
    pass(
      name,
      `${String(cases.length)} export forms match Node ${oracleNodeVersion} exactly: one space, ` +
        'two spaces and space-then-tab all yield the bare key, while `export<TAB>KEY` keeps ' +
        '`export<TAB>` inside the key and the bare key stays undefined; the five sensitive-key ' +
        'forms fail closed, while the neutral `export` key is reported only because its value ' +
        'contains a nested credential assignment; the empty placeholder stays clean; the ' +
        "scanner's own parsed key matches the oracle-confirmed key on every form (a behavioural " +
        'guard, so respelling the character class cannot defeat it)'
    )
  }
}

// ---------------------------------------------------------------------------
// R17：Round 16 总控复验发现的相邻绕过与误报边界
// ---------------------------------------------------------------------------
process.stdout.write('R17: scanner candidate closure\n')

{
  const name = 'digits on both sides of a sensitive stem cannot hide a live Node key'
  const rows = [
    ['password', '1PASSWORD2'],
    ['token', '0TOKEN9'],
    ['pass', '3PASS4'],
    ['passwd', '9PASSWD0'],
    ['secret', '1SECRET2'],
    ['split token', '1TOK-EN2'],
    ['split secret', '0SEC-RET9']
  ].map(([label, key]) => ({
    label,
    key,
    envLine: `${key}=AUDITVALUE-R17-DIGIT`,
    scanLine: `${key}=AUDITVALUE-R17-DIGIT`
  }))
  const oracleFailures = []
  const mismatches = []
  for (const row of rows) {
    const consumption = envFileConsumption(row.envLine, row.key)
    if (!consumption.ok) {
      oracleFailures.push(`${row.label}: ${consumption.reason}`)
    } else if (!consumption.defined || consumption.empty) {
      oracleFailures.push(`${row.label}: Node did not create the expected non-empty key`)
    }
    if (
      !templateProblemsFor(row.scanLine, 'local-test.env.example').some((problem) =>
        /assigns a non-empty value to a sensitive key/.test(problem)
      )
    ) {
      mismatches.push(row.label)
    }
  }
  const emptyFlagged = rows.filter(
    (row) => templateProblemsFor(`${row.key}=`, 'local-test.env.example').length > 0
  )
  const benign = ['1NORMAL2=AUDITVALUE', '2ROTATION3=AUDITVALUE', '7MEAL8=AUDITVALUE']
  const benignFlagged = benign.filter(
    (line) => templateProblemsFor(line, 'local-test.env.example').length > 0
  )
  const gate = evidenceGateProblems({
    rows,
    expectedRows: 7,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: 7,
    oracleIdentityOf: oracleIdentityOfRow,
    expectedOracleDistinct: 7,
    requiresOracle: true,
    oracleFailures,
    mismatches
  })
  if (gate.problems.length > 0) {
    fail(name, `${String(gate.problems.length)} gate problem(s); first: ${gate.problems[0]}`)
  } else if (emptyFlagged.length > 0) {
    fail(name, `${String(emptyFlagged.length)} empty placeholder(s) were wrongly flagged`)
  } else if (benignFlagged.length > 0) {
    fail(name, `${String(benignFlagged.length)} benign digit-wrapped key(s) were wrongly flagged`)
  } else {
    pass(
      name,
      '7/7 oracle-proven live keys fail closed (including digit-wrapped split stems); matching ' +
        'empty placeholders and 3 benign digit-wrapped keys stay clean'
    )
  }
}

{
  const name = 'punctuation inside a sensitive stem cannot split it out of view'
  const keys = [
    'TOK-EN',
    'SEC-RET',
    'SIGN-ATURE',
    'CREDEN-TIAL',
    'WECHAT_APP_SE-CRET',
    'MY_TOK-EN_VALUE',
    'PREFIX_SEC-RET_VALUE',
    'MY_SIGN-ATURE_ALGORITHM',
    'MY_CREDEN-TIAL_VALUE',
    'WECHAT-APP-ID',
    'APP-ID-VALUE',
    'PRIVATE-KEY-PEM',
    'API-KEY-VALUE',
    'PASS-PHRASE',
    'PWD-FILE',
    'KEY-FILE',
    'DSN-VALUE',
    'ACCESS-KEY-ID',
    'KEY-MATERIAL',
    'KEY-CONTENT',
    'PASS-PIN',
    'PWD-HASH',
    'DSN-STRING',
    'X-P-A-S-S-W-O-R-D-Y',
    'PRE-T-O-K-EN-SUF',
    'MY-S-E-C-R-ET-VALUE',
    'PRE-C-R-E-D-E-N-T-I-A-L-SUF',
    'XPASS-WORD'
  ]
  const rows = keys.map((key) => ({
    label: key,
    key,
    envLine: `${key}=AUDITVALUE-R17-STEM`,
    scanLine: `${key}=AUDITVALUE-R17-STEM`
  }))
  const oracleFailures = []
  const mismatches = []
  for (const row of rows) {
    const consumption = envFileConsumption(row.envLine, row.key)
    if (!consumption.ok || !consumption.defined || consumption.empty) {
      oracleFailures.push(row.label)
    }
    if (
      !templateProblemsFor(row.scanLine, 'local-test.env.example').some((problem) =>
        /assigns a non-empty value to a sensitive key/.test(problem)
      )
    ) {
      mismatches.push(row.label)
    }
  }
  const emptyFlagged = keys.filter(
    (key) => templateProblemsFor(`${key}=`, 'local-test.env.example').length > 0
  )
  const benign = [
    'ROT-ATION=AUDITVALUE',
    'ME-AL=AUDITVALUE',
    'PLA-N=AUDITVALUE',
    'SE-CRETARY=AUDITVALUE',
    'PASS-AGE=AUDITVALUE',
    'KEY-BOARD=AUDITVALUE',
    'TO-KENYA=AUDITVALUE',
    'SIGN-ATURED=AUDITVALUE',
    'X-R-O-T-A-T-I-O-N-Y=AUDITVALUE',
    'PRE-M-E-A-L-SUF=AUDITVALUE',
    'MY-P-L-A-N-VALUE=AUDITVALUE',
    'C-O-M-P-A-S-S-I-O-N=AUDITVALUE',
    'S-E-C-R-E-T-A-R-Y=AUDITVALUE',
    'P-A-S-S-A-G-E=AUDITVALUE',
    'K-E-Y-B-O-A-R-D=AUDITVALUE',
    'S-I-G-N-A-T-U-R-E-D=AUDITVALUE',
    'T-O-K-E-N-Y-A=AUDITVALUE'
  ]
  const benignFlagged = benign.filter(
    (line) => templateProblemsFor(line, 'local-test.env.example').length > 0
  )
  const gate = evidenceGateProblems({
    rows,
    expectedRows: 28,
    scanIdentityOf: scanIdentityOfRow,
    expectedScanDistinct: 28,
    oracleIdentityOf: oracleIdentityOfRow,
    expectedOracleDistinct: 28,
    requiresOracle: true,
    oracleFailures,
    mismatches
  })
  if (gate.problems.length > 0) {
    fail(name, `${String(gate.problems.length)} gate problem(s); first: ${gate.problems[0]}`)
  } else if (emptyFlagged.length > 0) {
    fail(name, `${String(emptyFlagged.length)} empty placeholder(s) were wrongly flagged`)
  } else if (benignFlagged.length > 0) {
    fail(name, `${String(benignFlagged.length)} benign punctuation-bearing key(s) were flagged`)
  } else {
    pass(
      name,
      '28/28 oracle-proven live keys fail closed, including the restored XPASS-WORD suffix case and underscore/punctuation-delimited ' +
        'prefix/suffix combinations, ' +
        'unknown weak-stem compounds and 4+ piece split stems; matching empty placeholders and 17 explicitly ' +
        'registered benign compounds / near-miss punctuation keys stay clean'
    )
  }
}

{
  const name = 'a comment glued directly to the value delimiter is still scanned for credentials'
  const lines = [
    'NOTES=#PASSWORD-FILE=AUDITVALUE-R17-COMMENT',
    'NOTES=#PASSWORD/v2=AUDITVALUE-R17-COMMENT'
  ]
  const oracleFailures = lines.filter((line) => {
    const consumption = envFileConsumption(line, 'NOTES')
    return !consumption.ok || !consumption.defined || !consumption.empty
  })
  const missed = lines.filter((line) =>
    ['local-test.env.example', 'README.md'].some(
      (file) =>
        !templateProblemsFor(line, file).some((problem) =>
          /assigns a non-empty value to a sensitive key/.test(problem)
        )
    )
  )
  const empty = ['NOTES=#PASSWORD-FILE=', 'NOTES=#PASSWORD/v2=']
  const emptyFlagged = empty.filter((line) => templateProblemsFor(line).length > 0)
  const benign = ['NOTES=#rotation-policy', 'NOTES=#docs-only', 'NOTES=#mode=ok']
  const benignFlagged = benign.filter((line) => templateProblemsFor(line).length > 0)
  if (oracleFailures.length > 0) {
    fail(name, `${String(oracleFailures.length)} Node oracle premise(s) failed`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} glued comment credential(s) went uncaught`)
  } else if (emptyFlagged.length > 0) {
    fail(name, `${String(emptyFlagged.length)} glued empty placeholder(s) were flagged`)
  } else if (benignFlagged.length > 0) {
    fail(name, `${String(benignFlagged.length)} benign glued comment(s) were flagged`)
  } else {
    pass(
      name,
      'Node proves NOTES is defined as the empty string; 2 credential comments are caught in ' +
        'strict and prose roles, while 2 empty and 3 benign controls stay clean'
    )
  }
}

{
  const name = 'URL paths and Markdown links do not become prose assignments'
  const benign = [
    '# See https://example.invalid/password=placeholder',
    '# [reset](https://example.invalid/password=placeholder)',
    'See https://example.invalid/token=value',
    '| docs | https://example.invalid/secret=placeholder |',
    '# GET /api/password=placeholder?limit=10',
    '# [reset](docs/password=placeholder)',
    '# See ../docs/token=value',
    '| docs | docs/secret=placeholder |'
  ]
  const flagged = benign.filter((line) => templateProblemsFor(line, 'README.md').length > 0)
  const positives = ['# PASSWORD/v2=AUDITVALUE-R17', '# PASSWORD-FILE=AUDITVALUE-R17']
  const missed = positives.filter(
    (line) =>
      !templateProblemsFor(line, 'README.md').some((problem) =>
        /assigns a non-empty value to a sensitive key/.test(problem)
      )
  )
  if (flagged.length > 0) {
    fail(name, `${String(flagged.length)} benign URL/Markdown path(s) were flagged`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} positive comment credential(s) went uncaught`)
  } else {
    pass(
      name,
      '8 benign absolute/relative URL/path controls stay clean and 2 comment credentials remain caught'
    )
  }
}

{
  const name = 'the active-key segment limit has an exact benign boundary'
  const clean = ['='.repeat(15), '='.repeat(16)]
  const cleanFlagged = clean.filter(
    (line) => templateProblemsFor(line, 'local-test.env.example').length > 0
  )
  const failClosed = ['='.repeat(17), `${'='.repeat(16)}0PASSWD=AUDITVALUE-R17`]
  const missed = failClosed.filter(
    (line) =>
      !templateProblemsFor(line, 'local-test.env.example').some((problem) =>
        /assigns a non-empty value to a sensitive key/.test(problem)
      )
  )
  if (cleanFlagged.length > 0) {
    fail(name, `${String(cleanFlagged.length)} in-bound empty-segment line(s) were flagged`)
  } else if (missed.length > 0) {
    fail(name, `${String(missed.length)} over-bound segment line(s) did not fail closed`)
  } else {
    pass(name, '15/16 empty segments stay clean; 17 and 16-plus-live-key fail closed')
  }
}

const expectedCount = 53
if (caught + failures.length !== expectedCount) {
  fail(
    'suite completeness',
    `expected ${String(expectedCount)} negatives, got ${String(caught)} caught + ${String(failures.length)} failed`
  )
}
if (failures.length > 0) {
  process.stderr.write('M3B targeted negative suite FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}
process.stdout.write(
  `M3B targeted negative suite PASS (${String(caught)}/${String(expectedCount)} ` +
    'cases caught with their named reasons)\n'
)
