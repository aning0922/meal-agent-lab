#!/usr/bin/env node
/**
 * M3B tracked-template **绝对面普查**。
 *
 * 与 `check-m3b-round2-negatives.mjs` 的分工：那份是**差分向**的注册反例——每条
 * case 钉住一个已修复的具体缺陷。这份是**绝对向**的——它不问「这一轮改了什么」，
 * 只问「**以 Node `--env-file` 为唯一 oracle，凡是会真的建立活键且取值非空的写法，
 * 扫描器看得见吗**」。
 *
 * 为什么必须有这一份：差分锚点**结构性看不见「一直就是错的」那一类**。Round 23
 * 的 P1-2（词元层缺 `endsWith`）比整个 M3B 里程碑还早 24 个提交，任何「上一个候选
 * → 本次候选」的差分都发现不了它；它那次被抓到是审计员多加了一个镜头的**偶然**，
 * 不是流程保证。
 *
 * **本门禁不声称扫描器是干净的。** 恰恰相反：它把**当前已知开着的族逐一登记**，
 * 然后钉住这个集合。任何一族的状态变化都转红——
 *
 *   - 未登记的族变沉默  → 新的 fail-open，必须裁定；
 *   - 已登记的族被捕获  → 好消息，但覆盖面变了，登记必须同步更新后才准通过。
 *
 * 后者同样转红是刻意的：这份文件的价值在于「表面是已知的」，而不是「表面是干净
 * 的」。悄悄变好和悄悄变坏一样会让登记失真。
 *
 * **登记表本身在 [`m3b-surface-registry.mjs`](m3b-surface-registry.mjs)**，并在普查
 * 之前先过一遍自校验。此前这张表零自校验：`expect` 拼错成 `opne` → exit 0 且打印
 * 「4 族命中」（那个数是**减**出来的，任何认不出的状态都被算进命中侧）；删掉一族
 * → exit 0；删掉一个视图 → exit 0 且打印「40 格（8 族 × 6 视图）」（`× 6 视图` 是
 * 硬编码字面量，8 × 6 = 48 ≠ 40）；`why` 置空 → exit 0 仍称「逐族附了原因」。
 * 现在这四种变异全部以指定理由转红，且对外打印的每个数字都由登记表导出。
 *
 * 输出纪律：只报**族标签 + 计数**。族标签是登记表模块里的静态字面量，不含任何
 * 输入派生内容；合成取值一律 `AUDITVALUE`，绝不使用真实 Secret。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { scanTrackedTemplates, repositoryRoot } from './local-test-secrets-contract.mjs'
import {
  driftFor,
  registry,
  registrySummary,
  validateRegistry
} from './m3b-surface-registry.mjs'

const { families, views } = registry

const oracleNodeVersion = 'v24.18.0'
/** 合成占位。本门禁**永不**使用真实 Secret 取值。 */
const value = 'AUDITVALUE'

const failures = []
const passes = []
const pass = (name, reason) => passes.push(`  caught: ${name} (${reason})`)
const fail = (name, detail) => failures.push(`${name}: ${detail}`)

const git = (args, options = {}) =>
  spawnSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options })

// ---------------------------------------------------------------------------
// oracle：Node 真的会建立活键吗？取值非空吗？
// ---------------------------------------------------------------------------
const ambientKeys = new Set(
  JSON.parse(
    spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], {
      encoding: 'utf8'
    }).stdout
  )
)

/**
 * 一次 spawn 判一整批：把 N 行写进同一个 env 文件，读回**新增**的键。
 * 逐行 spawn 会让这份门禁慢一个数量级，而批量对「哪些行造出了非空活键」这个
 * 问题是等价的——每行的键名互不相同（由生成器保证）。
 */
const oracleBatch = (lines) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-sweep-oracle-'))
  try {
    const file = resolve(directory, 'probe.env')
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    const result = spawnSync(
      process.execPath,
      [`--env-file=${file}`, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 << 20, killSignal: 'SIGKILL' }
    )
    if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout === '') {
      return null
    }
    const added = new Map()
    for (const [key, environmentValue] of Object.entries(JSON.parse(result.stdout))) {
      if (!ambientKeys.has(key)) {
        added.set(key, environmentValue)
      }
    }
    return added
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 扫描：真实生产入口，仓库外临时 git 仓库
// ---------------------------------------------------------------------------
const scanBatch = (strictLines, proseLines) => {
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-sweep-scan-'))
  try {
    const repository = resolve(parent, 'repo')
    const directory = resolve(repository, 'infra/environments/local-test')
    mkdirSync(directory, { recursive: true })
    for (const args of [
      ['init', '--quiet', repository],
      ['-C', repository, 'config', 'user.email', 'sweep@example.invalid'],
      ['-C', repository, 'config', 'user.name', 'M3B surface sweep']
    ]) {
      const result = git(args)
      if (result.error !== undefined || result.status !== 0) {
        throw new Error(`git ${args[0]} failed`)
      }
    }
    writeFileSync(
      resolve(directory, 'local-test.env.example'),
      ['WECHAT_APP_ID=', ...strictLines].join('\n') + '\n'
    )
    writeFileSync(resolve(directory, 'README.md'), (proseLines.join('\n') || '# doc') + '\n')
    git(['-C', repository, 'add', '-A'])
    git(['-C', repository, 'commit', '--quiet', '-m', 'sweep'])
    const strictHits = new Set()
    const proseHits = new Set()
    for (const problem of scanTrackedTemplates(repository)) {
      const match =
        /(local-test\.env\.example|README\.md):(\d+): tracked template assigns a non-empty value to a sensitive key/.exec(
          problem
        )
      if (match === null) {
        continue
      }
      if (match[1] === 'README.md') {
        proseHits.add(Number(match[2]))
      } else {
        strictHits.add(Number(match[2]))
      }
    }
    return {
      strict: strictLines.map((_, index) => strictHits.has(index + 2)),
      prose: proseLines.map((_, index) => proseHits.has(index + 1))
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
process.stdout.write('M3B tracked-template surface sweep\n')

// 登记表自校验**先于**普查。一张自己就不自洽的登记表钉不住任何东西：此前
// `expect` 拼错、族被删、视图被删、`why` 置空**四种变异全部 exit 0**，其中拼错
// 还会让打印出来的「命中族数」凭空 +1（那个数是减出来的）。
const registryProblems = validateRegistry(registry)
for (const problem of registryProblems) {
  fail('surface sweep registry', problem)
}

if (registryProblems.length > 0) {
  // 登记表不可信时不再执行普查：拿一张坏表跑出来的绿是假绿。
} else if (process.version !== oracleNodeVersion) {
  fail('oracle version', `the oracle is pinned to ${oracleNodeVersion}; this run is ${process.version}`)
} else {
  // 每族 × 每视图 = 一格
  const cells = []
  for (const family of families) {
    for (const view of views) {
      const key = family.key()
      cells.push({ family, view, key, assignment: `${key}=${value}`, line: view.render(`${key}=${value}`) })
    }
  }

  // oracle：只有 premise 为 self 的格子能直接批量验证（键名互不相同）
  const selfCells = cells.filter((cell) => cell.view.premise === 'self')
  const oracleKeys = [...new Set(selfCells.map((cell) => cell.key))]
  const added = oracleBatch(oracleKeys.map((key) => `${key}=${value}`))
  const oracleFailures =
    added === null
      ? oracleKeys
      : oracleKeys.filter((key) => !added.has(key) || added.get(key) === '')

  const strictCells = cells.filter((cell) => cell.view.role === 'strict')
  const proseCells = cells.filter((cell) => cell.view.role === 'prose')
  const scanned = scanBatch(strictCells.map((c) => c.line), proseCells.map((c) => c.line))
  strictCells.forEach((cell, index) => {
    cell.caught = scanned.strict[index]
  })
  proseCells.forEach((cell, index) => {
    cell.caught = scanned.prose[index]
  })

  // 逐族比对实测与登记（三态判定在登记表模块里，由合成用例单独覆盖）
  const drifted = []
  for (const family of families) {
    const caughtViewIds = new Set(
      cells.filter((cell) => cell.family === family && cell.caught).map((cell) => cell.view.id)
    )
    const drift = driftFor(family, caughtViewIds, views)
    if (drift !== null) {
      drifted.push(drift)
    }
  }

  if (oracleFailures.length > 0) {
    fail(
      'surface sweep oracle',
      `${String(oracleFailures.length)} 个键构造未能在 Node ${oracleNodeVersion} 上建立非空活键`
    )
  } else if (drifted.length > 0) {
    for (const drift of drifted) {
      fail('surface sweep', drift)
    }
  } else {
    // 每个数字都从登记表**导出**。此前 `× 6 视图` 是硬编码字面量、命中族数是
    // 「族总数 - open 数」减出来的——删掉一个视图会打印「40 格（8 族 × 6 视图）」，
    // 8 × 6 = 48 ≠ 40，而门禁照样 exit 0。
    const summary = registrySummary(registry)
    if (summary.cells !== cells.length) {
      fail(
        'surface sweep',
        `登记表导出 ${String(summary.cells)} 格，实际展开 ${String(cells.length)} 格`
      )
    } else {
      pass(
        'tracked template surface sweep',
        `${String(summary.cells)} 格（${String(summary.families)} 族 × ` +
          `${String(summary.views)} 视图）与登记一致：${String(summary.caught)} 族命中，` +
          `${String(summary.open)} 族**已登记为开着**、${String(summary.mixed)} 族逐视图混合，` +
          `非 caught 族均带非空原因（由登记表自校验强制）；另有 ${String(summary.unguarded)} ` +
          '族门禁结构上表达不了、零看守，见 m3b-surface-registry.mjs 的 unguardedFamilies'
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 扫描面本身：pathspec 之外的 tracked dotenv 模板
// ---------------------------------------------------------------------------
{
  const name = 'the scan pathspec covers every tracked dotenv-shaped template'
  // `scanTrackedTemplates` 的 pathspec 写死为 infra/environments。仓库里其它位置
  // 的 tracked dotenv 模板**一遍都不扫**——这不是启发式边界，是"根本没看"。
  // 已登记的例外必须逐条列出；出现新的未登记文件即转红。
  const registeredOutside = ['.env.example', 'services/api/.env.example']
  // `-z` + NUL 切分，与 `local-test-secrets-contract.mjs:2019` 对齐。不加 `-z` 时
  // git 会对非 ASCII 路径做 C-quoting：`docs/配置.env` 打印成
  // `"docs/\351\205\215\347\275\256.env"`，尾部那个 `"` 挡在 `$` 锚点前面，于是
  // 一份带凭据的模板**整份逃过覆盖检查**（实测 GREEN；ASCII 同名文件 RED）。
  // 含换行的文件名同样走 C-quoting，且 `core.quotepath=false` **关不掉**——
  // 所以配置不是缓解手段，唯一修法就是 `-z`。
  const listing = git(['ls-files', '-z'], { cwd: repositoryRoot })
  if (listing.error !== undefined || listing.status !== 0) {
    fail(name, 'git ls-files 失败')
  } else {
    const dotenvShaped = listing.stdout
      .split('\u0000')
      .filter(Boolean)
      // 覆盖检查应当**过近似**（宁可多列，不可漏列），与解析器必须欠近似相反：
      // 漏列一份带凭据的 tracked 模板，这条检查就白做了。此前的窄正则要求
      // `env` 结尾或后接 example/sample/template，于是 `.env.local`、`.env.prod`、
      // `.env.dist`、`.env.bak` 全部不在枚举内——实测 `apps/client/app.env.local`
      // 带 POSTGRES_PASSWORD 提交后门禁 exit 0，同字节改名 `.env.example` 即 exit 1。
      // 注意**不要**直接复用 `supportedTemplateFile`：实测那会把文档散文也拉进来，
      // 产出约 6 条误报。
      .filter((file) => /(^|\/|\.)env(\.[^/]*)?$/i.test(file))
    const outside = dotenvShaped.filter((file) => !file.startsWith('infra/environments/'))
    const unregistered = outside.filter((file) => !registeredOutside.includes(file))
    const missing = registeredOutside.filter((file) => !outside.includes(file))
    if (unregistered.length > 0) {
      fail(
        name,
        `${String(unregistered.length)} 份 tracked dotenv 模板在扫描面之外且未登记——` +
          '要么纳入 pathspec，要么显式登记'
      )
    } else if (missing.length > 0) {
      fail(name, `${String(missing.length)} 份已登记的扫描面外模板已消失，登记须同步`)
    } else {
      pass(
        name,
        `${String(dotenvShaped.length)} 份 tracked dotenv 模板中 ${String(outside.length)} 份在 ` +
          'pathspec 之外，且全部已登记（扫描器对它们零判据，属已披露边界）'
      )
    }
  }
}

for (const line of passes) {
  process.stdout.write(`${line}\n`)
}
if (failures.length > 0) {
  process.stderr.write('M3B tracked-template surface sweep FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}
process.stdout.write('M3B tracked-template surface sweep PASS\n')
