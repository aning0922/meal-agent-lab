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
 * 输出纪律：只报**族标签 + 计数**。族标签是本文件里的静态字面量，不含任何输入
 * 派生内容；合成取值一律 `AUDITVALUE`，绝不使用真实 Secret。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { scanTrackedTemplates, repositoryRoot } from './local-test-secrets-contract.mjs'

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
// 语料生成器：每族一个键构造，跨 6 个视图展开
// ---------------------------------------------------------------------------
/** 顶层活赋值（strict）。其余视图的 oracle 前提由 `outerLive` / `noKey` 描述。 */
const views = [
  { id: 'active', role: 'strict', render: (a) => a, premise: 'self' },
  { id: 'nested', role: 'strict', render: (a) => `NOTES=${a}`, premise: 'outer' },
  { id: 'quoted', role: 'strict', render: (a) => `NOTES="${a}"`, premise: 'outer' },
  { id: 'comment', role: 'strict', render: (a) => `# ${a}`, premise: 'none' },
  { id: 'inline', role: 'strict', render: (a) => `NOTES=ok # ${a}`, premise: 'outer' },
  { id: 'prose', role: 'prose', render: (a) => `${a}`, premise: 'self' }
]

/**
 * **族**：一个键构造 + 它在 6 个视图下的预期。
 *
 * `expect` 是**当前实测事实**，不是愿望：`caught` = 六视图全部命中；
 * `open` = 六视图全部沉默；`mixed` = 逐视图列出（`openViews`）。
 *
 * 每条 `open` / `mixed` 都必须带 `why` —— 登记一个开口而不写清楚它为什么开着，
 * 等于把缺陷洗成边界。
 */
const families = [
  // ---- 正向对照：这些必须命中，否则整份普查失去意义 ----
  { id: 'control/plain-stem', key: () => 'POSTGRES_PASSWORD', expect: 'caught' },
  { id: 'control/underscore-token', key: () => 'APP_SECRET', expect: 'caught' },
  { id: 'control/crossing-punctuation', key: () => 'PA-SSWORD', expect: 'caught' },

  // ---- 已登记开着的族（Round 24 普查首次系统枚举）----
  {
    id: 'open/case-expanding-codepoint',
    key: () => 'POSTGRES_PA\u{FB01}SSWORD',
    expect: 'open',
    why:
      'toUpperCase() 会把 \u{FB01} 展开成两个**真 ASCII 字母** FI，' +
      'replace(/[^A-Z0-9]/g,"") 删不掉它们，PASSWORD 被从中间劈开。' +
      '全 Unicode 闭集共 17 个这类码点。'
  },
  {
    id: 'open/digit-leading-glued-stem',
    key: () => '0PGPASSWORD',
    expect: 'open',
    why:
      'legacy 路径的前置断言 (?:^|[^A-Za-z0-9_]) 在数字开头键内**任何位置都无法起步**，' +
      '于是 isSensitiveKeyName（唯一带 endsWith 的强判据）对整族结构性不可达。'
  },
  {
    id: 'open/glued-stem-joint-digit',
    key: () => 'PGPASSWORD2',
    expect: 'open',
    why:
      'stripBoundaryDigits 只剥首尾数字且剥完必须**恰好等于**注册 token；' +
      'PGPASSWORD2 既不 startsWith 也不 endsWith 任何后缀。'
  },
  {
    id: 'open/benign-allowlist-injection',
    key: () => 'SIGNATURE_D',
    expect: 'open',
    why:
      'isBenignWeakPunctuationCompound 在任何子片段判据**之前**无条件短路，判据是' +
      '「整键去掉非 [A-Z0-9] 后精确等于 6 个注册词之一」。强词干 + 一个短尾巴即可' +
      '让 compact 形落进白名单。历次审计只从 benign 一侧压误报，从未从凭据一侧压。'
  },
  {
    id: 'open/operator-tail-key',
    key: () => 'PGPASSWORD_OLD+',
    expect: 'open',
    why:
      '键尾 + 让活键变成 PGPASSWORD_OLD+，OLD+ 这个 component 含标点、pieces 只剩 OLD，' +
      '而 PGPASSWORD 是纯字母数字 component 拿不到强判据。Round 20 登记 ' +
      'compoundOperatorTail 残留时写的「active strict 视图不受影响」**不成立**。'
  }
]

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
process.stdout.write('M3B tracked-template surface sweep\n')

if (process.version !== oracleNodeVersion) {
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

  // 逐族比对实测与登记
  const drifted = []
  for (const family of families) {
    const own = cells.filter((cell) => cell.family === family)
    const caught = own.filter((cell) => cell.caught).length
    if (family.expect === 'caught' && caught !== own.length) {
      drifted.push(`${family.id}: 登记为全部命中，实测 ${String(caught)}/${String(own.length)}`)
    }
    if (family.expect === 'open' && caught !== 0) {
      drifted.push(
        `${family.id}: 登记为全部沉默，实测有 ${String(caught)} 格被捕获——覆盖面变好了，` +
          '但登记必须同步更新后才准通过'
      )
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
    const openFamilies = families.filter((f) => f.expect === 'open')
    pass(
      'tracked template surface sweep',
      `${String(cells.length)} 格（${String(families.length)} 族 × 6 视图）与登记一致：` +
        `${String(families.length - openFamilies.length)} 族命中，` +
        `${String(openFamilies.length)} 族**已登记为开着**且逐族附了原因`
    )
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
  const listing = git(['ls-files'], { cwd: repositoryRoot })
  if (listing.error !== undefined || listing.status !== 0) {
    fail(name, 'git ls-files 失败')
  } else {
    const dotenvShaped = listing.stdout
      .split('\n')
      .filter(Boolean)
      .filter((file) => /(^|\/)([^/]*\.)?env(\.(example|sample|template))?$/.test(file))
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
