#!/usr/bin/env node
/**
 * M3B **登记完整性门禁**——把「已发表的话」钉到「已提交的数据」上。
 *
 * 为什么有这一份：这条整改链反复被判 BLOCK，根因**同一个形状**——手写的完整性声明
 * 与它所概括的枚举脱钩。族名列表、门禁条数、tracked 文件数、表格判定列、反引号分母，
 * 都出现过这个形状。写一个新的手写总数只要一秒，人工发现它要一整轮审计——所以这份
 * 门禁执行的规则只有一句：
 *
 *   > **任何进入文档的计数、比例或族名列表，要么由脚本对已提交的数据导出，要么删掉。
 *   > 手算的数不许发表。**
 *
 * 分节。每节独立判定、独立报告，**通过的节即时打印**，因此一节崩溃不会吞掉前面已
 * 通过的节的诊断。注意这不等于「逐节隔离」：本文件是顺序执行的顶层脚本，某节抛出
 * **未捕获**异常仍会中止整轮，后面的节不会跑。已知的两处崩溃面（文档记法解码的
 * 越界码点、文档派生路径的读取）已各自 fail closed，见 `decodeSpan` 与
 * `readReferencedDocument`。各节：
 *   §1 登记表自校验 + 合成登记表用例（把三态判定本身也测了，`mixed` 不是死代码）
 *   §2 文档里的族名列表 ↔ 登记表 id 集合
 *   §3 已发表的普查形状（族数/视图数/格数/命中/开着/零看守）↔ 登记表
 *   §4 计划文档表格**逐格**用真实 `scanTrackedTemplates` 复跑断言 + 合计数
 *   §4b 表格**第 1 列**：族 id ↔ 登记表；闭集大小与成员 ↔ 脚本枚举出的闭集
 *   §5 已发表的反引号行数 ↔ 真实文件行数
 *   §6 已发表的 tracked 文件数 ↔ `git ls-files`
 *   §7 已发表的门禁清单 ↔ 仓库里真实的门禁脚本集合
 *   §8 README 当前 mutation 数 ↔ 两份可执行套件的硬计数
 *
 * 输出纪律：只报**本文件/登记表里的静态字面量 + 计数**。文档侧多出来的内容一律
 * 只报数量、不回显（文档是可被改写的输入）；合成取值一律 `AUDITVALUE`，绝不使用
 * 真实 Secret，也绝不回显被扫描行的原文。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  assertCanonicalGitRepositoryView,
  canonicalGitArguments,
  scanTrackedTemplates,
  repositoryRoot
} from './local-test-secrets-contract.mjs'
import {
  caseFoldingSplitCodePoints,
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
// **逐节即时输出**，不攒到最后统一打印。此前 passes 攒在数组里、在文件末尾才打印，
// 于是任何一节抛异常都会把**已经通过的节的诊断一起吞掉**——实测 §4 一个越界码点
// 让整轮 stdout 为空，读者看不出崩溃前 §1–§3 已经过了。
const pass = (name, reason) => process.stdout.write(`  caught: ${name} (${reason})\n`)
const fail = (name, detail) => failures.push(`${name}: ${detail}`)

const readDocument = (relative) => readFileSync(resolve(repositoryRoot, relative), 'utf8')
assertCanonicalGitRepositoryView(repositoryRoot)

/**
 * 读一份**由文档内容指定路径**的文件。与 `readDocument` 严格区分：那个的路径是本
 * 文件里的常量，这个的路径来自可被改写的输入。
 *
 * 实测未加约束时：路径指向不存在的文件 → **未捕获 ENOENT**；路径写成
 * `infra/environments/../../../../../../private/tmp/…/README.md` → 门禁**读到仓库外**
 * 的文件并据此下结论。两者都不可接受。
 *
 * 约束：必须落在 `infra/environments/` 下、不得含 `..`，且 resolve 之后仍在该目录内
 * （前两条挡记法，第三条挡 symlink 以外的一切绕法）。读不到一律返回 `null` 由调用方
 * 记为「不符」，**绝不回显路径本身**。
 */
const ENVIRONMENTS_ROOT = resolve(repositoryRoot, 'infra/environments')
const readReferencedDocument = (relative) => {
  if (!relative.startsWith('infra/environments/') || relative.split('/').includes('..')) {
    return null
  }
  const absolute = resolve(repositoryRoot, relative)
  if (!absolute.startsWith(`${ENVIRONMENTS_ROOT}/`)) {
    return null
  }
  try {
    return readFileSync(absolute, 'utf8')
  } catch {
    return null
  }
}

const PLAN = 'docs/plans/2026-07-stage-09a-local-deployability-baseline.md'
const STATUS = 'docs/project-status.md'
const ADR = 'docs/architecture/decisions/0005-local-private-deployment-baseline.md'
const DOCKER_README = 'infra/docker/README.md'

/**
 * 族 id 的**形状**，§2 与 §4b 共用。
 *
 * 字符类刻意比登记表里实际用到的宽（登记表全是小写加连字符）：**窄字符类会让一个
 * 大小写写错的 id 根本不被采集**，于是「幽灵族」判据看不见它。实测
 * `open/GHOST-FAMILY` 在 `[a-z0-9-]` 下不匹配——它只有在**替换**掉一个真 id 时才被
 * 「漏列」判据间接抓到，若是**新增**一个则全绿。宽采集、再与登记表逐 id 比对，
 * 才是 fail closed 的方向。
 */
const FAMILY_ID_PATTERN = /`((?:open|unguarded|control)\/[A-Za-z0-9_-]+)`/g

/**
 * 取**唯一**匹配；匹配数 ≠ 1 一律返回 `null`，由调用方转红。
 *
 * 为什么锚点必须断言唯一性：此前每个锚点都取「第一个匹配」。实测在
 * `docs/project-status.md` **顶部**放一条内容**正确**的 `**（甲）…` 诱饵行、再把下方
 * 那条权威行改坏 → **exit 0**；不放诱饵、只改坏权威行的对照组正确转红。取首个匹配
 * 的锚点等于给改写者留了一条免检通道：把正确的话说一遍，错的话写在后面。
 *
 * 传进来的正则必须带 `g`（`matchAll` 的要求），否则这里会抛，属编程错误而非输入错误。
 */
const uniqueMatch = (content, pattern) => {
  const all = [...content.matchAll(pattern)]
  return all.length === 1 ? all[0] : null
}

/** 同上，按行首前缀取唯一一行。返回行内容或 `null`。 */
const uniqueLineStartingWith = (content, prefix) => {
  const found = content.split('\n').filter((line) => line.startsWith(prefix))
  return found.length === 1 ? found[0] : null
}

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
  const expectedMalformedRegistryCount = 18
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
  if (cases.length !== expectedMalformedRegistryCount) {
    fail(
      name,
      `畸形登记表用例数漂移：应为 ${String(expectedMalformedRegistryCount)}，实际 ${String(cases.length)}`
    )
  } else if (missed.length > 0) {
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
  const idsOnLinePrefixedBy = (content, prefix) => {
    const line = uniqueLineStartingWith(content, prefix)
    return line === null ? null : [...line.matchAll(FAMILY_ID_PATTERN)].map((match) => match[1])
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
        // 找不到、或**不止一条**（诱饵行）——两种都不合格，都不回显文档内容。
        problems.push(`${label} 锚点在某份文档里不是恰好 1 行`)
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
  // 三个锚点都要求**恰好一处**匹配，否则一条正确的诱饵句就能让下面那条假的免检。
  const shape = uniqueMatch(content, /(\d+) 族 × (\d+) 视图 = (\d+) 格/g)
  const split = uniqueMatch(content, /(\d+) 族登记为命中、(\d+) 族\*\*登记为开着且逐族附原因\*\*/g)
  const unguardedClaim = uniqueMatch(content, /另有 (\d+) 族门禁结构上表达不了/g)
  if (shape === null || split === null || unguardedClaim === null) {
    fail(name, 'README 里「N 族 × M 视图 = K 格 / 命中 / 开着 / 零看守」形状声明不是恰好各一处')
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

/**
 * 记法解码：`<U+XXXX>` / `<反引号>` / `<值>`。**第 1 列的成员与第 3 列的例共用这一套**
 * ——两列若各写各的记法，第 1 列就又成了一个无人看守的面（Round 26 的 P1 之一正是
 * 长在第 1 列上）。
 *
 * 两种情况必须 fail closed：越界码点让 `String.fromCodePoint` 抛 `RangeError`；
 * 未知记法解码后仍留着尖括号。返回 `null` 表示不可解码，**绝不回显被扫描原文**。
 */
const decodeSpan = (span) => {
  let decoded
  try {
    decoded = span
      .replace(/<U\+([0-9A-Fa-f]{4,6})>/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/<反引号>/g, '`')
      .replace(/<值>/g, value)
  } catch {
    return null
  }
  return /<[^>]*>/.test(decoded) ? null : decoded
}

/** 第 1 列（族列）的解析结果，由 §4 的行扫描填充，由 §4b 判定。 */
const familyColumn = { ids: [], closedSetClaims: [], malformed: 0 }

/**
 * 表格行的**唯一分类器**。§4 的逐格断言与合计句里的 `declaredRows` 都走这一个函数
 * ——两处各写一遍谓词，就会出现「一处认为这是数据行、另一处不认」的缝。
 *
 * `'skip'`  表头与分隔行，按定义不是数据；
 * `'data'`  正好 4 列的数据行；
 * `'bad'`   列数不是 4。**必须转红，不得 `continue`**：GFM 下多出来的单元格会被
 *           **丢弃**，一条 5 列行照样渲染成完整的 4 列——读者看到的是一行判定列
 *           正常的普通行，而门禁根本没读过它。实测一条判定列写假的 5 列行在配套
 *           改掉合计句之后 exit 0。少于 4 列同理。
 */
const classifyTableRow = (columns) => {
  if (columns.length !== 4) {
    return 'bad'
  }
  return /^-+$/.test(columns[0]) || columns[0] === '族' ? 'skip' : 'data'
}

const tableColumnsOf = (line) => line.split('|').slice(1, -1).map((column) => column.trim())

{
  const name = 'every cell in the plan surface table matches the real scanner'
  const content = readDocument(PLAN)
  const lines = content.split('\n')
  // 锚点也要求唯一：两个 `m3b:surface-table` 注释会让门禁只认第一张表，第二张表
  // 里写什么都无所谓。
  const anchors = lines
    .map((line, index) => (line.includes('<!-- m3b:surface-table -->') ? index : -1))
    .filter((index) => index >= 0)
  const anchor = anchors.length === 1 ? anchors[0] : -1
  if (anchor === -1) {
    fail(name, `计划文档里 m3b:surface-table 锚点不是恰好 1 处（实测 ${String(anchors.length)} 处）`)
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
      const columns = tableColumnsOf(line)
      const kind = classifyTableRow(columns)
      if (kind === 'bad') {
        malformed += 1
        continue
      }
      if (kind === 'skip') {
        continue
      }
      // ---- 第 1 列（族列）：先收集，判定在 §4b。 ----
      // 放在角色/判定列检查**之前**，好让一个写坏的第 3 列不至于把第 1 列的问题遮住。
      const family = columns[0]
      for (const match of family.matchAll(FAMILY_ID_PATTERN)) {
        familyColumn.ids.push(match[1])
      }
      if (family.includes('闭集')) {
        const claim = /闭集 (\d+) 个：(.*?)等/.exec(family)
        if (claim === null) {
          // 声明了闭集却写不成可解析的形状：fail closed，不得当作「没有声明」跳过。
          familyColumn.malformed += 1
        } else {
          familyColumn.closedSetClaims.push({
            declared: Number(claim[1]),
            spans: [...claim[2].matchAll(/`([^`]+)`/g)].map((match) => match[1])
          })
        }
      }

      const [, role, examples, verdict] = columns
      const spans = [...examples.matchAll(/`([^`]+)`/g)].map((match) => match[1])
      if (!['strict', 'prose'].includes(role) || !['沉默', '命中'].includes(verdict) || spans.length === 0) {
        malformed += 1
        continue
      }
      for (const span of spans) {
        // 未知记法与越界码点必须 fail closed：否则一个写错的占位会被当成字面文本静默通过。
        const decoded = decodeSpan(span)
        if (decoded === null) {
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
        const tally = uniqueMatch(content, /上表 (\d+) 行共 (\d+) 个例：(\d+) 沉默 \+ (\d+) 命中/g)
        // 与上面的逐格扫描**同一个分类器**。此前这里各写了一遍谓词，于是一条 5 列
        // 行在一处被静默丢弃、在另一处也不计入，两边「自洽地」都看不见它。
        const declaredRows = lines
          .slice(anchor + 1)
          .filter((line) => line.startsWith('|'))
          .filter((line) => classifyTableRow(tableColumnsOf(line)) === 'data').length
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
// §4b 计划文档表格**第 1 列**：族 id ↔ 登记表，闭集大小与成员 ↔ 脚本导出的枚举
// ===========================================================================
{
  // 为什么单列一节：此前 §4 只解码第 3 列、只断言第 4 列，**第 1 列零判据**。实测
  // 三种注入全部 exit 0——第 1 列写登记表里不存在的族 id、把「闭集 17 个」写成
  // 「闭集 99 个」、把成员写成 `Q` `7` `@`。Round 26 两条 P1 的第一条就长在这里：
  // 那一格把 ASCII `ss`（两个码点）与 `i` 发表为 17 码点闭集的成员。
  const name = 'the family column of the plan surface table matches the registry and the derived closed set'
  const closedSet = new Set(caseFoldingSplitCodePoints())
  const registryIds = new Set([
    ...registry.families.map((family) => family.id),
    ...unguardedFamilies.map((family) => family.id)
  ])
  // 本表枚举的是**已登记开着的面**（open + 零看守）。control 族是正向对照，表里点名
  // 一个即可——要求第 1 列与 families ∪ unguardedFamilies **同外延**会把一张正确的
  // 表判红（表内 10 个 id，登记表并集 12 个，另两个 control 是刻意不点名的）。
  const enumeratedIds = [
    ...registry.families.filter((family) => family.expect !== 'caught').map((family) => family.id),
    ...unguardedFamilies.map((family) => family.id)
  ]
  const named = new Set(familyColumn.ids)
  const problems = []

  if (familyColumn.malformed > 0) {
    problems.push(`第 1 列有 ${String(familyColumn.malformed)} 处闭集声明无法解析`)
  }
  // A1 幽灵族：第 1 列点名的每个族 id 必须在登记表里。文档侧 id 不回显，只报数量。
  const ghosts = [...named].filter((id) => !registryIds.has(id))
  if (ghosts.length > 0) {
    problems.push(`第 1 列有 ${String(ghosts.length)} 个族 id 不在登记表里`)
  }
  // A2 漏列：登记表里每个 open / 零看守族都必须在第 1 列出现过。缺的是登记表侧的
  // 静态字面量，可以回显。
  const absent = enumeratedIds.filter((id) => !named.has(id))
  if (absent.length > 0) {
    problems.push(
      `第 1 列漏列 ${String(absent.length)}/${String(enumeratedIds.length)} 个已登记族（${absent.join(', ')}）`
    )
  }
  for (const claim of familyColumn.closedSetClaims) {
    // B 闭集大小：发表的 N 必须等于门禁**枚举出来**的大小，不许手写。
    if (claim.declared !== closedSet.size) {
      problems.push(`第 1 列发表的闭集大小与枚举出的 ${String(closedSet.size)} 不符`)
    }
    // C 成员：每个成员解码后必须是**单个码点**且 ∈ 枚举出的闭集。
    // 解码走 §4 第 3 列同一套记法，未知记法与越界码点一律算不合格。
    const outside = claim.spans.filter((span) => {
      const decoded = decodeSpan(span)
      if (decoded === null) {
        return true
      }
      const points = [...decoded]
      return points.length !== 1 || !closedSet.has(points[0].codePointAt(0))
    })
    if (outside.length > 0) {
      problems.push(
        `第 1 列举出的 ${String(outside.length)}/${String(claim.spans.length)} 个闭集成员` +
          '解码后不是枚举出的闭集里的单个码点'
      )
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      fail(name, problem)
    }
  } else {
    pass(
      name,
      `第 1 列 ${String(named.size)} 个族 id 全部在登记表内、${String(enumeratedIds.length)} 个` +
        `已登记族全部被点名，${String(familyColumn.closedSetClaims.length)} 条闭集声明与枚举出的 ` +
        `${String(closedSet.size)} 个成员逐个相符`
    )
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
      const body = readReferencedDocument(claim.target)
      if (body === null) {
        // 越界、含 `..`、或读不到：记为不符。不回显路径——它是文档派生字符串。
        return true
      }
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
// §6 已发表的 tracked 文件口径 ↔ git ls-files
// ===========================================================================
{
  const name = 'the published tracked-file evidence is derived from git ls-files'
  const listing = spawnSync('git', canonicalGitArguments(['ls-files', '-z']), {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
  if (listing.error !== undefined || listing.status !== 0) {
    fail(name, 'git ls-files 失败')
  } else {
    const tracked = listing.stdout.split('\u0000').filter(Boolean).length
    const claim = uniqueMatch(
      readDocument(PLAN),
      /artifacts × `git ls-files` 派生的 tracked 文件/g
    )
    if (claim === null) {
      fail(name, '计划文档里的 tracked 文件证据没有唯一声明为 git ls-files 派生')
    } else {
      pass(name, `tracked 文件证据由 git ls-files 派生（本次 ${String(tracked)} 个）`)
    }
  }
}

// ===========================================================================
// §7 已发表的门禁清单 ↔ 真实门禁脚本集合
// ===========================================================================
{
  const name = 'the published M3B gate list matches the real gate scripts'
  const content = readDocument(DOCKER_README)
  const declared = uniqueMatch(content, /M3B 的\*\*完整门禁清单\*\*（共 (\d+) 条/g)
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
  // 整份 README 里被记录下来的脚本：M3B 门禁表 + 它前面那张「生成/预检」运维表。
  // `listed` 仍然只取门禁表（「共 N 条」比对的是它），两者用途不同，不要混用。
  const documented = new Set(
    [...content.matchAll(/^\| `node (infra\/docker\/[a-z0-9.-]+\.mjs)` \|/gm)].map(
      (match) => match[1]
    )
  )
  const listing = spawnSync(
    'git',
    canonicalGitArguments(['ls-files', '-z', '--', 'infra/docker']),
    {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
    }
  )
  if (listing.error !== undefined || listing.status !== 0) {
    fail(name, 'git ls-files 失败')
  } else {
    const tracked = listing.stdout.split('\u0000').filter(Boolean)
    // **可执行入口** = 顶层 `infra/docker/*.mjs` 且带 shebang。子目录（`fixtures/`、
    // `postgres/`）不是入口，库模块没有 shebang。这是一个**机械导出**的集合，不是
    // 手写清单——本轮的规则同样约束门禁自己。实测该集合 = 门禁表 9 条 + 运维表 2 条。
    const executable = tracked.filter(
      (file) =>
        /^infra\/docker\/[a-z0-9.-]+\.mjs$/.test(file) &&
        readFileSync(resolve(repositoryRoot, file), 'utf8').startsWith('#!')
    )
    // 此前这里只要求 `check-*.mjs` 全部在清单里，而头部自述的是「本清单 ↔ 真实门禁
    // 脚本集合」——**保证面窄于自述面**。两个不叫 check- 的脚本因此可以静默消失：
    // 实测删掉 `run-local-test-smoke.mjs` 那一行并把 9 改成 8 → exit 0，删掉
    // `probe-compose-secret-identity.mjs` 同样 exit 0。唯一的全链动态 smoke 与唯一的
    // Secret 身份探针就这样离开保证面，而门禁全绿。
    //
    // 现在比对的是**整份 README 记录下来的脚本**（门禁表 + 前面那张运维表）↔ 可执行
    // 入口集合。放宽到两张表是必须的：那 2 份运维命令本来就登记在运维表里，只看门禁
    // 表会把它们判成「未记录」。
    const missing = executable.filter((file) => !documented.has(file))
    const phantom = [...documented].filter((file) => !tracked.includes(file))
    if (missing.length > 0) {
      fail(
        name,
        `${String(missing.length)} 份可执行脚本未出现在 README 的任何清单里（${missing.join(', ')}）`
      )
    } else if (phantom.length > 0) {
      fail(name, `README 清单里有 ${String(phantom.length)} 条指向不存在的脚本`)
    } else if (declared === null) {
      fail(name, 'README 里找不到「共 N 条」的门禁清单声明')
    } else if (Number(declared[1]) !== listed.length) {
      fail(name, `README 声明的门禁条数与表里实际 ${String(listed.length)} 行不符`)
    } else {
      pass(
        name,
        `${String(listed.length)} 条门禁清单与表内行数相符；` +
          `${String(executable.length)} 份可执行脚本全部被 README 记录，无悬空条目`
      )
    }
  }
}

// ===========================================================================
// §8 已发表的当前计数 ↔ 可执行套件硬计数
// ===========================================================================
{
  const name = 'published executable counts match the executable hard gates'
  const readme = readDocument(DOCKER_README)
  const topologySource = readDocument('infra/docker/check-compose-topology-mutations.mjs')
  const imageSource = readDocument('infra/docker/check-api-runtime-image-mutations.mjs')
  const localSource = readDocument('infra/docker/check-local-test-negatives.mjs')
  const targetedSource = readDocument('infra/docker/check-m3b-round2-negatives.mjs')
  const signalSource = readDocument('infra/docker/check-m3b-signal-windows.mjs')
  const topologyPublished = uniqueMatch(
    readme,
    /^\| `node infra\/docker\/check-compose-topology-mutations\.mjs` \| \*\*(\d+) 项\*\*/gm
  )
  const imagePublished = uniqueMatch(
    readme,
    /^\| `node infra\/docker\/check-api-runtime-image-mutations\.mjs` \|[^\n]*\*\*(\d+) 个 built \+ (\d+) 个 static-only\*\*/gm
  )
  const topologyExecutable = uniqueMatch(
    topologySource,
    /^const expectedMutationCount = (\d+)$/gm
  )
  const imageBuiltExecutable = uniqueMatch(
    imageSource,
    /^const expectedBuiltMutationCount = (\d+)$/gm
  )
  const imageStaticExecutable = uniqueMatch(
    imageSource,
    /^const expectedStaticOnlyMutationCount = (\d+)$/gm
  )
  const localPublished = uniqueMatch(
    readme,
    /^\| `node infra\/docker\/check-local-test-negatives\.mjs` \| \*\*(\d+) cases = 1 个正向 baseline \+ (\d+) 个反例\/边界检查\*\*/gm
  )
  const localExecutable = uniqueMatch(localSource, /^const expectedCaseCount = (\d+)$/gm)
  const targetedPublished = uniqueMatch(
    readme,
    /^\| `node infra\/docker\/check-m3b-round2-negatives\.mjs` \| \*\*M3B targeted negative suite：(\d+) cases\*\*[\s\S]*?collector 子门禁为 \*\*(\d+) 个\*\*唯一向量，resolved-config 子门禁为 \*\*(\d+) 个\*\*唯一向量。/gm
  )
  const targetedExecutable = uniqueMatch(targetedSource, /^const expectedCount = (\d+)$/gm)
  const vectorCounts = [...targetedSource.matchAll(/^  const expectedVectorCount = (\d+)$/gm)].map(
    (match) => match[1]
  )
  const signalPublished = uniqueMatch(
    readme,
    /^\| `node infra\/docker\/check-m3b-signal-windows\.mjs` \| \*\*(\d+) 个\*\*[\s\S]*?\+ \*\*(\d+) 个\*\*真实信号窗口/gm
  )
  const signalDeterministicExecutable = uniqueMatch(
    signalSource,
    /^const expectedRegressionChecks = (\d+)$/gm
  )
  const signalRealExecutable = uniqueMatch(signalSource, /^const expectedCount = (\d+)$/gm)
  if (
    topologyPublished === null ||
    imagePublished === null ||
    topologyExecutable === null ||
    imageBuiltExecutable === null ||
    imageStaticExecutable === null ||
    localPublished === null ||
    localExecutable === null ||
    targetedPublished === null ||
    targetedExecutable === null ||
    vectorCounts.length !== 2 ||
    signalPublished === null ||
    signalDeterministicExecutable === null ||
    signalRealExecutable === null
  ) {
    fail(name, 'README 或可执行套件缺少唯一的当前计数锚点')
  } else if (
    topologyPublished[1] !== topologyExecutable[1] ||
    imagePublished[1] !== imageBuiltExecutable[1] ||
    imagePublished[2] !== imageStaticExecutable[1] ||
    localPublished[1] !== localExecutable[1] ||
    Number(localPublished[2]) !== Number(localExecutable[1]) - 1 ||
    targetedPublished[1] !== targetedExecutable[1] ||
    targetedPublished[2] !== vectorCounts[0] ||
    targetedPublished[3] !== vectorCounts[1] ||
    signalPublished[1] !== signalDeterministicExecutable[1] ||
    signalPublished[2] !== signalRealExecutable[1]
  ) {
    fail(name, 'README 发表的当前计数与可执行套件硬门禁不一致')
  } else {
    pass(
      name,
      `topology ${topologyExecutable[1]}；runtime image ` +
        `${imageBuiltExecutable[1]} built + ${imageStaticExecutable[1]} static-only；` +
        `local ${localExecutable[1]}；targeted ${targetedExecutable[1]} ` +
        `(collector ${vectorCounts[0]} + resolved ${vectorCounts[1]})；signal ` +
        `${signalDeterministicExecutable[1]} + ${signalRealExecutable[1]}`
    )
  }
}

// ===========================================================================
// 通过的节已在各自执行时打印过了，这里只收尾。
if (failures.length > 0) {
  process.stderr.write('M3B registry integrity FAIL\n')
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}
process.stdout.write('M3B registry integrity PASS\n')
