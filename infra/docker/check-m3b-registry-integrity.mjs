#!/usr/bin/env node
/**
 * M3B **登记完整性门禁**——把「已发表的话」钉到「已提交的数据」上。
 *
 * 为什么有这一份：这条整改链连续七轮被判 BLOCK，最近两轮的根因**同一个形状**——
 * 手写的完整性声明与它所概括的枚举脱钩：
 *
 *   - ADR/project-status 写「9 族全部已由门禁钉死」，门禁实际只有 5 族；
 *   - `infra/docker/README.md` 写「七条」，表里 8 行；
 *   - 计划文档写「321 tracked 文件」，树上 322；
 *   - 计划文档写「19 格 = 17 沉默」，改成 16 之后仍然不可复核（语料根本不在仓库里）；
 *   - 计划文档表格里 11 行有 1 行的判定列与实测相反（反引号那格）；
 *   - 两份 README 的反引号分母写 73/22，真实行数是 72/21（误用了 `split('\n').length`）。
 *
 * 同一形状在一轮产物里出现过七次。写一个新的手写总数只要一秒，人工发现它要一整轮
 * 审计——所以这份门禁执行的规则只有一句：
 *
 *   > **任何进入文档的计数、比例或族名列表，要么由脚本对已提交的数据导出，要么删掉。
 *   > 手算的数不许发表。**
 *
 * 七节，逐节 fail closed：
 *   §1 登记表自校验 + 合成登记表用例（把三态判定本身也测了，`mixed` 不是死代码）
 *   §2 文档里的族名列表 ↔ 登记表 id 集合
 *   §3 已发表的普查形状（族数/视图数/格数/命中/开着/零看守）↔ 登记表
 *   §4 计划文档表格**逐格**用真实 `scanTrackedTemplates` 复跑断言 + 合计数
 *   §5 已发表的反引号行数 ↔ 真实文件行数
 *   §6 已发表的 tracked 文件数 ↔ `git ls-files`
 *   §7 已发表的门禁清单 ↔ 仓库里真实的门禁脚本集合
 *
 * 输出纪律：只报**本文件/登记表里的静态字面量 + 计数**。文档侧多出来的内容一律
 * 只报数量、不回显（文档是可被改写的输入）；合成取值一律 `AUDITVALUE`，绝不使用
 * 真实 Secret，也绝不回显被扫描行的原文。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { scanTrackedTemplates, repositoryRoot } from './local-test-secrets-contract.mjs'
import {
  driftFor,
  registry,
  registrySummary,
  unguardedFamilies,
  validateRegistry,
  views
} from './m3b-surface-registry.mjs'

/** 合成占位。本门禁**永不**使用真实 Secret 取值。 */
const value = 'AUDITVALUE'

const failures = []
const passes = []
const pass = (name, reason) => passes.push(`  caught: ${name} (${reason})`)
const fail = (name, detail) => failures.push(`${name}: ${detail}`)

const readDocument = (relative) => readFileSync(resolve(repositoryRoot, relative), 'utf8')

const PLAN = 'docs/plans/2026-07-stage-09a-local-deployability-baseline.md'
const STATUS = 'docs/project-status.md'
const ADR = 'docs/architecture/decisions/0005-local-private-deployment-baseline.md'
const DOCKER_README = 'infra/docker/README.md'

const sameSet = (left, right) => {
  const a = new Set(left)
  const b = new Set(right)
  return a.size === b.size && [...a].every((item) => b.has(item))
}

// ===========================================================================
// §1 登记表自校验 + 合成登记表用例
// ===========================================================================
{
  const name = 'the surface registry validates itself'
  const problems = validateRegistry(registry)
  if (problems.length > 0) {
    fail(name, `生产登记表自校验有 ${String(problems.length)} 条问题`)
  } else {
    pass(name, `${String(registrySummary(registry).families)} 族 + ` +
      `${String(registrySummary(registry).unguarded)} 零看守族，自校验零问题`)
  }
}

{
  // 合成登记表：每条都必须被 validateRegistry 以**指定理由**抓住。
  //
  // 为什么断言理由片段而不只断言「非空」：校验器里若干条规则是**同外延**的——
  // `expect` 白名单与三态计数一致性在完全相同的条件下触发，谁也隔离不了谁。
  // 只断言「被拒了」时，单独删掉白名单仍然全绿（另一条把它兜住了），于是那条
  // 规则的判别力无从证明。断言理由片段之后，删掉任何一条都会让对应用例失配。
  const name = 'the registry validator rejects malformed registries'
  const viewsOf = (n) => views.slice(0, n)
  const ok = { id: 'control/x', key: () => 'K', expect: 'caught' }
  const badExpect = { families: [{ id: 'a/b', key: () => 'K', expect: 'opne' }], unguardedFamilies: [], views }
  const cases = [
    ['expect 不在闭集', badExpect, '不在闭集'],
    ['三态计数加不回总数', badExpect, '与族总数'],
    ['open 缺 why', { families: [{ id: 'a/b', key: () => 'K', expect: 'open' }], unguardedFamilies: [], views }, '没有非空 why'],
    ['open 的 why 为空串', { families: [{ id: 'a/b', key: () => 'K', expect: 'open', why: '   ' }], unguardedFamilies: [], views }, '没有非空 why'],
    ['caught 带 why', { families: [{ id: 'a/b', key: () => 'K', expect: 'caught', why: 'x' }], unguardedFamilies: [], views }, 'caught 族不得带 why'],
    ['mixed 缺 openViews', { families: [{ id: 'a/b', key: () => 'K', expect: 'mixed', why: 'x' }], unguardedFamilies: [], views }, '必须用非空 openViews'],
    ['mixed 的 openViews 为空', { families: [{ id: 'a/b', key: () => 'K', expect: 'mixed', why: 'x', openViews: [] }], unguardedFamilies: [], views }, '必须用非空 openViews'],
    ['mixed 的 openViews 覆盖全部视图', { families: [{ id: 'a/b', key: () => 'K', expect: 'mixed', why: 'x', openViews: views.map((v) => v.id) }], unguardedFamilies: [], views }, '覆盖了全部视图'],
    ['mixed 的 openViews 含未知视图', { families: [{ id: 'a/b', key: () => 'K', expect: 'mixed', why: 'x', openViews: ['nope'] }], unguardedFamilies: [], views }, '含未知视图 id'],
    ['mixed 的 openViews 有重复', { families: [{ id: 'a/b', key: () => 'K', expect: 'mixed', why: 'x', openViews: ['active', 'active'] }], unguardedFamilies: [], views }, 'openViews 有重复'],
    ['非 mixed 带 openViews', { families: [{ id: 'a/b', key: () => 'K', expect: 'open', why: 'x', openViews: ['active'] }], unguardedFamilies: [], views }, '只有 mixed 族才能带 openViews'],
    ['族 id 重复', { families: [ok, { ...ok }], unguardedFamilies: [], views }, '族 id 重复'],
    ['缺 key 生成器', { families: [{ id: 'a/b', expect: 'caught' }], unguardedFamilies: [], views }, '缺少 key 生成器'],
    ['族集合为空', { families: [], unguardedFamilies: [], views }, '族集合为空'],
    ['视图集合为空', { families: [ok], unguardedFamilies: [], views: [] }, '视图集合为空'],
    ['视图 id 重复', { families: [ok], unguardedFamilies: [], views: [views[0], views[0]] }, '视图 id 有重复'],
    ['零看守族缺 whyUnguarded', { families: [ok], unguardedFamilies: [{ id: 'u/x' }], views }, '必须写明为什么看不住'],
    ['零看守族 id 与受测族冲突', { families: [ok], unguardedFamilies: [{ id: 'control/x', whyUnguarded: 'y' }], views }, '与受测族冲突']
  ]
  const missed = cases.filter(
    ([, bad, reason]) => !validateRegistry(bad).some((problem) => problem.includes(reason))
  )
  // 正向对照：一张**合法的 mixed 登记表**必须干净通过，否则上面的全红没有判别力。
  const goodMixed = {
    families: [{ id: 'a/b', key: () => 'K', expect: 'mixed', why: 'x', openViews: [viewsOf(2)[0].id] }],
    unguardedFamilies: [{ id: 'u/x', whyUnguarded: 'y' }],
    views: viewsOf(2)
  }
  const goodProblems = validateRegistry(goodMixed)
  if (missed.length > 0) {
    fail(name, `${String(missed.length)}/${String(cases.length)} 条畸形登记表未被校验器以指定理由拒绝`)
  } else if (goodProblems.length > 0) {
    fail(name, `合法的 mixed 登记表被误拒，${String(goodProblems.length)} 条问题`)
  } else {
    pass(name, `${String(cases.length)} 条畸形登记表全部以指定理由被拒，合法 mixed 登记表通过`)
  }
}

{
  // 三态漂移判定。`mixed` 在生产登记表里当前零使用，必须由这里覆盖，
  // 否则它就是一条没人跑过的分支。
  const name = 'the three-state drift comparison is discriminating'
  const ids = views.map((view) => view.id)
  const all = new Set(ids)
  const none = new Set()
  const first = new Set([ids[0]])
  const exceptFirst = new Set(ids.slice(1))
  const caught = { id: 'c/x', key: () => 'K', expect: 'caught' }
  const open = { id: 'o/x', key: () => 'K', expect: 'open', why: 'w' }
  const mixed = { id: 'm/x', key: () => 'K', expect: 'mixed', why: 'w', openViews: [ids[0]] }
  const expectations = [
    ['caught 全命中 → 无漂移', driftFor(caught, all, views) === null],
    ['caught 有沉默 → 漂移', driftFor(caught, exceptFirst, views) !== null],
    ['open 全沉默 → 无漂移', driftFor(open, none, views) === null],
    ['open 有命中 → 漂移', driftFor(open, first, views) !== null],
    ['mixed 恰好按 openViews → 无漂移', driftFor(mixed, exceptFirst, views) === null],
    ['mixed 全命中 → 漂移', driftFor(mixed, all, views) !== null],
    ['mixed 全沉默 → 漂移', driftFor(mixed, none, views) !== null],
    ['mixed 反过来 → 漂移', driftFor(mixed, first, views) !== null]
  ]
  const wrong = expectations.filter(([, held]) => !held)
  if (wrong.length > 0) {
    fail(name, `${String(wrong.length)}/${String(expectations.length)} 条三态漂移预期不成立`)
  } else {
    pass(name, `${String(expectations.length)} 条三态漂移预期全部成立（含 mixed 四向）`)
  }
}

// ===========================================================================
// §2 文档里的族名列表 ↔ 登记表 id 集合
// ===========================================================================
{
  const name = 'the family lists published in the docs match the registry ids'
  const idPattern = /`((?:open|unguarded|control)\/[a-z0-9-]+)`/g
  const idsOnLinePrefixedBy = (content, prefix) => {
    const line = content.split('\n').find((candidate) => candidate.startsWith(prefix))
    return line === undefined ? null : [...line.matchAll(idPattern)].map((match) => match[1])
  }
  const expectedOpen = registry.families.filter((f) => f.expect === 'open').map((f) => f.id)
  const expectedUnguarded = unguardedFamilies.map((f) => f.id)
  const problems = []
  for (const relative of [STATUS, ADR]) {
    const content = readDocument(relative)
    const published = { '（甲）': idsOnLinePrefixedBy(content, '**（甲）'), '（乙）': idsOnLinePrefixedBy(content, '**（乙）') }
    for (const [label, expected] of [['（甲）', expectedOpen], ['（乙）', expectedUnguarded]]) {
      const actual = published[label]
      if (actual === null) {
        problems.push(`${label} 列表在某份文档里找不到`)
      } else if (!sameSet(actual, expected)) {
        // 不回显文档侧内容：只报数量与登记表侧（静态字面量）缺了哪些。
        const absent = expected.filter((id) => !actual.includes(id))
        problems.push(
          `${label} 列表与登记表不符：文档列出 ${String(actual.length)} 个 id，` +
            `登记表有 ${String(expected.length)} 个，其中 ${String(absent.length)} 个未被文档列出` +
            (absent.length > 0 ? `（${absent.join(', ')}）` : '')
        )
      }
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) {
      fail(name, problem)
    }
  } else {
    pass(
      name,
      `2 份文档 × 2 份列表：（甲）${String(expectedOpen.length)} 族、` +
        `（乙）${String(expectedUnguarded.length)} 族，与登记表逐 id 相符`
    )
  }
}

// ===========================================================================
// §3 已发表的普查形状 ↔ 登记表
// ===========================================================================
{
  // 族数/视图数/格数/命中族数/开着族数是 `infra/docker/README.md` 发表的**形状**。
  // 没有这一节，删掉一整族或一个视图时普查门禁**照样 exit 0**——它把一切都从
  // 登记表导出，因此 7 族 × 6 视图 = 42 格是自洽的，只有仓库外的已发表形状能发现
  // 覆盖面缩水（实测：删族与删视图两种变异在只有普查门禁时都是 GREEN）。
  const name = 'the published sweep shape matches the registry'
  const content = readDocument(DOCKER_README)
  const summary = registrySummary(registry)
  const shape = /(\d+) 族 × (\d+) 视图 = (\d+) 格/.exec(content)
  const split = /(\d+) 族登记为命中、(\d+) 族\*\*登记为开着且逐族附原因\*\*/.exec(content)
  const unguardedClaim = /另有 (\d+) 族门禁结构上表达不了/.exec(content)
  if (shape === null || split === null || unguardedClaim === null) {
    fail(name, 'README 里找不到完整的「N 族 × M 视图 = K 格 / 命中 / 开着 / 零看守」形状声明')
  } else if (
    Number(shape[1]) !== summary.families ||
    Number(shape[2]) !== summary.views ||
    Number(shape[3]) !== summary.cells ||
    Number(split[1]) !== summary.caught ||
    Number(split[2]) !== summary.open ||
    Number(unguardedClaim[1]) !== summary.unguarded
  ) {
    fail(
      name,
      `README 发表的普查形状与登记表不符：实测 ${String(summary.families)} 族 × ` +
        `${String(summary.views)} 视图 = ${String(summary.cells)} 格，` +
        `${String(summary.caught)} 命中 / ${String(summary.open)} 开着 / ` +
        `${String(summary.unguarded)} 零看守`
    )
  } else {
    pass(
      name,
      `${String(summary.families)} 族 × ${String(summary.views)} 视图 = ` +
        `${String(summary.cells)} 格、${String(summary.caught)} 命中 / ` +
        `${String(summary.open)} 开着 / ${String(summary.unguarded)} 零看守，与 README 相符`
    )
  }
}

// ===========================================================================
// §4 计划文档表格逐格断言
// ===========================================================================
const scanRoleBatch = (strictLines, proseLines) => {
  const parent = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-registry-scan-'))
  try {
    const repository = resolve(parent, 'repo')
    const directory = resolve(repository, 'infra/environments/local-test')
    mkdirSync(directory, { recursive: true })
    for (const args of [
      ['init', '--quiet', repository],
      ['-C', repository, 'config', 'user.email', 'registry@example.invalid'],
      ['-C', repository, 'config', 'user.name', 'M3B registry integrity']
    ]) {
      const result = spawnSync('git', args, { encoding: 'utf8' })
      if (result.error !== undefined || result.status !== 0) {
        throw new Error(`git ${args[0]} failed`)
      }
    }
    writeFileSync(
      resolve(directory, 'local-test.env.example'),
      ['WECHAT_APP_ID=', ...strictLines].join('\n') + '\n'
    )
    writeFileSync(resolve(directory, 'README.md'), (proseLines.join('\n') || '# doc') + '\n')
    spawnSync('git', ['-C', repository, 'add', '-A'], { encoding: 'utf8' })
    spawnSync('git', ['-C', repository, 'commit', '--quiet', '-m', 'registry'], { encoding: 'utf8' })
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
      ;(match[1] === 'README.md' ? proseHits : strictHits).add(Number(match[2]))
    }
    return {
      strict: strictLines.map((_, index) => strictHits.has(index + 2)),
      prose: proseLines.map((_, index) => proseHits.has(index + 1))
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

const ambientKeys = new Set(Object.keys(process.env))
const oracleLine = (line) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-registry-oracle-'))
  try {
    const file = resolve(directory, 'probe.env')
    writeFileSync(file, `${line}\n`, 'utf8')
    const result = spawnSync(
      process.execPath,
      [`--env-file=${file}`, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 << 20, killSignal: 'SIGKILL' }
    )
    if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout === '') {
      return false
    }
    return Object.entries(JSON.parse(result.stdout)).some(
      ([key, environmentValue]) => !ambientKeys.has(key) && environmentValue !== ''
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

{
  const name = 'every cell in the plan surface table matches the real scanner'
  const content = readDocument(PLAN)
  const lines = content.split('\n')
  const anchor = lines.findIndex((line) => line.includes('<!-- m3b:surface-table -->'))
  if (anchor === -1) {
    fail(name, '计划文档里找不到 m3b:surface-table 锚点')
  } else {
    const rows = []
    let malformed = 0
    for (let index = anchor + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line.startsWith('|')) {
        if (rows.length > 0) {
          break
        }
        continue
      }
      const columns = line.split('|').slice(1, -1).map((column) => column.trim())
      if (columns.length !== 4 || /^-+$/.test(columns[0]) || columns[0] === '族') {
        continue
      }
      const [, role, examples, verdict] = columns
      const spans = [...examples.matchAll(/`([^`]+)`/g)].map((match) => match[1])
      if (!['strict', 'prose'].includes(role) || !['沉默', '命中'].includes(verdict) || spans.length === 0) {
        malformed += 1
        continue
      }
      for (const span of spans) {
        const decoded = span
          .replace(/<U\+([0-9A-Fa-f]{4,6})>/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
          .replace(/<反引号>/g, '`')
          .replace(/<值>/g, value)
        // 未知记法必须 fail closed：否则一个写错的占位会被当成字面文本静默通过。
        if (/<[^>]*>/.test(decoded)) {
          malformed += 1
          continue
        }
        rows.push({ role, verdict, line: decoded })
      }
    }
    const strictRows = rows.filter((row) => row.role === 'strict')
    const proseRows = rows.filter((row) => row.role === 'prose')
    if (malformed > 0) {
      fail(name, `表格里有 ${String(malformed)} 处记法/列格式无法解析`)
    } else if (rows.length === 0) {
      fail(name, '表格解析出 0 个例：零覆盖不是通过')
    } else {
      const scanned = scanRoleBatch(strictRows.map((r) => r.line), proseRows.map((r) => r.line))
      strictRows.forEach((row, index) => {
        row.caught = scanned.strict[index]
      })
      proseRows.forEach((row, index) => {
        row.caught = scanned.prose[index]
      })
      const wrong = rows.filter((row) => (row.caught ? '命中' : '沉默') !== row.verdict)
      // 每个例都必须真的是一行会建立非空活键的凭据写法（整行注释除外——它按定义
      // 不建立任何键，`# 0PASSWD=` 那一格就是这种）。否则表格可以拿稻草人凑数。
      const notLive = rows.filter((row) => !row.line.trimStart().startsWith('#') && !oracleLine(row.line))
      if (wrong.length > 0) {
        // 不回显被扫描行：只报数量与角色分布。
        fail(
          name,
          `${String(wrong.length)}/${String(rows.length)} 个例的判定列与实测相反` +
            `（strict ${String(wrong.filter((r) => r.role === 'strict').length)} 个、` +
            `prose ${String(wrong.filter((r) => r.role === 'prose').length)} 个）`
        )
      } else if (notLive.length > 0) {
        fail(name, `${String(notLive.length)} 个非注释例未能建立非空活键，不构成有效反例`)
      } else {
        const silent = rows.filter((row) => row.verdict === '沉默').length
        const hit = rows.length - silent
        // 合计数由上面**数出来**，再与文档里发表的那句话比对。
        const tally = /上表 (\d+) 行共 (\d+) 个例：(\d+) 沉默 \+ (\d+) 命中/.exec(content)
        const tableRows = lines
          .slice(anchor + 1)
          .filter((line) => line.startsWith('|'))
          .slice(2, 2 + 999)
          .filter((line, index, all) => all.indexOf(line) >= 0)
        const declaredRows = tableRows.filter((line) => {
          const columns = line.split('|').slice(1, -1).map((column) => column.trim())
          return columns.length === 4 && !/^-+$/.test(columns[0]) && columns[0] !== '族'
        }).length
        if (tally === null) {
          fail(name, '计划文档里找不到「上表 N 行共 M 个例：X 沉默 + Y 命中」的合计句')
        } else if (
          Number(tally[1]) !== declaredRows ||
          Number(tally[2]) !== rows.length ||
          Number(tally[3]) !== silent ||
          Number(tally[4]) !== hit
        ) {
          fail(
            name,
            `合计句与实测不符：实测 ${String(declaredRows)} 行 / ${String(rows.length)} 例 / ` +
              `${String(silent)} 沉默 / ${String(hit)} 命中`
          )
        } else {
          pass(
            name,
            `${String(declaredRows)} 行共 ${String(rows.length)} 个例逐格与真实 scanTrackedTemplates ` +
              `一致（${String(silent)} 沉默 + ${String(hit)} 命中），非注释例均经 oracle 确认建立非空活键`
          )
        }
      }
    }
  }
}

// ===========================================================================
// §5 已发表的反引号行数 ↔ 真实文件行数
// ===========================================================================
{
  const name = 'the published backtick line ratios match the real files'
  // 只锚到「有 N/M 行」为止：句子后半截在两份文档里不一样（一处接「、」，
  // 一处接「含反引号（…）」）。要求整句一致会让**一半的声明悄悄不被检查**——
  // 实测早期版本正是如此：4 条声明只匹配到 2 条，把 72 改回 73 照样 GREEN。
  const pattern = /`(infra\/environments\/[^`]*README\.md)` 有 (\d+)\/(\d+) 行/g
  const claims = []
  for (const relative of [STATUS, ADR]) {
    for (const match of readDocument(relative).matchAll(pattern)) {
      claims.push({ target: match[1], backticks: Number(match[2]), total: Number(match[3]) })
    }
  }
  if (claims.length === 0) {
    fail(name, '两份文档里找不到任何「N/M 行含反引号」的声明')
  } else {
    const wrong = claims.filter((claim) => {
      const body = readDocument(claim.target)
      // 真实行数 = 去掉尾随换行后的行数（`awk END{NR}` / `grep -c ''` 的口径）。
      // 此前发表的分母用的是 `content.split('\n').length`，尾随 LF 会多出一个
      // 空元素，于是 72/21 被写成 73/22。
      const bodyLines = body.split('\n')
      if (bodyLines.at(-1) === '') {
        bodyLines.pop()
      }
      return (
        bodyLines.length !== claim.total ||
        bodyLines.filter((line) => line.includes('`')).length !== claim.backticks
      )
    })
    if (wrong.length > 0) {
      fail(name, `${String(wrong.length)}/${String(claims.length)} 条反引号行数声明与真实文件不符`)
    } else {
      pass(name, `${String(claims.length)} 条反引号行数声明与真实文件逐条相符`)
    }
  }
}

// ===========================================================================
// §6 已发表的 tracked 文件数 ↔ git ls-files
// ===========================================================================
{
  const name = 'the published tracked-file count matches git ls-files'
  const listing = spawnSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
  if (listing.error !== undefined || listing.status !== 0) {
    fail(name, 'git ls-files 失败')
  } else {
    const tracked = listing.stdout.split('\u0000').filter(Boolean).length
    const claim = /artifacts × (\d+) tracked 文件/.exec(readDocument(PLAN))
    if (claim === null) {
      fail(name, '计划文档里找不到 tracked 文件数声明')
    } else if (Number(claim[1]) !== tracked) {
      fail(name, `计划文档发表的 tracked 文件数与实测 ${String(tracked)} 不符`)
    } else {
      pass(name, `发表的 tracked 文件数 ${String(tracked)} 与 git ls-files 相符`)
    }
  }
}

// ===========================================================================
// §7 已发表的门禁清单 ↔ 真实门禁脚本集合
// ===========================================================================
{
  const name = 'the published M3B gate list matches the real gate scripts'
  const content = readDocument(DOCKER_README)
  const declared = /M3B 的\*\*完整门禁清单\*\*（共 (\d+) 条/.exec(content)
  // **只**取 M3B 那张表：本文件前面还有一张「生成/预检」表，整份文件正则会把它
  // 的两行也算进来（实测 2 + 9 = 11 ≠ 9）。从声明句起、到该表结束为止。
  const afterDeclaration = declared === null ? '' : content.slice(declared.index)
  const listed = []
  let insideTable = false
  for (const line of afterDeclaration.split('\n')) {
    const match = /^\| `node (infra\/docker\/[a-z0-9.-]+\.mjs)` \|/.exec(line)
    if (match !== null) {
      insideTable = true
      listed.push(match[1])
      continue
    }
    if (insideTable && !line.startsWith('|')) {
      break
    }
  }
  const listing = spawnSync('git', ['ls-files', '-z', '--', 'infra/docker'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
  if (listing.error !== undefined || listing.status !== 0) {
    fail(name, 'git ls-files 失败')
  } else {
    const tracked = listing.stdout.split('\u0000').filter(Boolean)
    const checks = tracked.filter((file) => /^infra\/docker\/check-[a-z0-9.-]+\.mjs$/.test(file))
    const missing = checks.filter((file) => !listed.includes(file))
    const phantom = listed.filter((file) => !tracked.includes(file))
    if (missing.length > 0) {
      fail(name, `${String(missing.length)} 份 check-*.mjs 门禁未出现在 README 清单里（${missing.join(', ')}）`)
    } else if (phantom.length > 0) {
      fail(name, `README 清单里有 ${String(phantom.length)} 条指向不存在的脚本`)
    } else if (declared === null) {
      fail(name, 'README 里找不到「共 N 条」的门禁清单声明')
    } else if (Number(declared[1]) !== listed.length) {
      fail(name, `README 声明的门禁条数与表里实际 ${String(listed.length)} 行不符`)
    } else {
      pass(
        name,
        `${String(listed.length)} 条清单与表内行数、${String(checks.length)} 份 check-*.mjs 全部相符`
      )
    }
  }
}

// ===========================================================================
for (const line of passes) {
  process.stdout.write(`${line}\n`)
}
if (failures.length > 0) {
  process.stderr.write('M3B registry integrity FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}
process.stdout.write('M3B registry integrity PASS\n')
