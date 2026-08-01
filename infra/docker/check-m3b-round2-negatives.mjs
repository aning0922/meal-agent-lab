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
import { scanTrackedRepositoryForNeedles } from './local-test-containment.mjs'
import {
  generatePassword,
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
const templateProblemsFor = (line) => {
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
    writeFileSync(
      resolve(templateDirectory, 'local-test.env.example'),
      `WECHAT_APP_ID=\n${line}\n`
    )
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

/** 失败消息不得回显取值、URL 或 key。 */
/**
 * 模板扫描 problem 的**完整合法形状**：`<file>:<line>: tracked template <类别>`。
 * 类别取自本仓源码里的固定字符串；敏感键那条额外允许一个键名（键名本身是消息
 * 的必要信息，高熵形态由扫描器改写成「不回显」）。
 */
const allowedProblemShape =
  /^[^\s:]+(?: \(git index\))?:\d+: tracked template (?:contains a full connection string with credentials|contains a connection string with a credential query parameter|contains an unscannable connection string candidate|assigns a non-empty value to the sensitive key [A-Za-z_][A-Za-z0-9_]*|assigns a non-empty value to a sensitive key \(its name is high-entropy and deliberately not echoed\))$/

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
  // userinfo 的事实源必须是**解析器**，原始文本正则退居纵深防御。那条正则要求
  // `@` 之前没有空白，于是引号内合法保留的空格/制表符直接把它绕过去。
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
  // 审计追加：高熵键名不得被回显（行内注释是自由文本，键位上可以放进 token）。
  const entropyProblems = templateProblemsFor('NOTES=ok # ghp_A1B2C3D4E5F6G7H8I9_TOKEN=1')
  const entropyWithheld =
    entropyProblems.some((problem) => /high-entropy and deliberately not echoed/.test(problem)) &&
    !entropyProblems.some((problem) => /ghp_A1B2C3/.test(problem))
  const missed = []
  const viaUnscannable = []
  const leaking = []
  for (const [label, line] of shapes) {
    const problems = templateProblemsFor(line)
    if (!problems.some((problem) => /assigns a non-empty value to the sensitive key/.test(problem))) {
      missed.push(label)
      if (problems.some((problem) => /unscannable connection string candidate/.test(problem))) {
        viaUnscannable.push(label)
      }
    }
    // 键名（PASSWORD）本来就是消息的一部分；这里断言的是**取值**不得出现，
    // 同时用正向形状断言兜住「消息开始回显别的输入」。
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
    fail(name, 'a high-entropy key name was echoed instead of being withheld')
  } else {
    pass(
      name,
      `${String(shapes.length)} fragment shapes (including prose-before-assignment, an ` +
        'assignment inside a quoted value, a second assignment in the comment and a CRLF line) ' +
        'hit the sensitive-key judge; values never echoed; a high-entropy key name is withheld; ' +
        `${String(benign.length)} benign shapes stay clean`
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
const expectedCount = 29
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
