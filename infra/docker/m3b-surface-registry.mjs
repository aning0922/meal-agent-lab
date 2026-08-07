/**
 * M3B tracked-template 表面**登记表**——族、视图与登记状态的唯一事实源。
 *
 * 为什么它是独立模块而不是留在门禁脚本里：这条整改链连续七轮被判 BLOCK，最近
 * 两轮的根因同为「**手写的完整性声明与它所概括的枚举脱钩**」——文档写「9 族全部
 * 由门禁钉死」而门禁只有 5 族；文档写「八条门禁」而表里 7 行；文档写「321 tracked
 * 文件」而树上 322。人写一个新总数只要一秒，人工发现它要一整轮审计。
 *
 * 把登记表抽成模块，是为了让**文档去比对它**（见 `check-m3b-registry-integrity.mjs`）
 * 而不是各自手抄一份。规则一句话：
 *
 *   > 任何进入文档的计数、比例或全称词，要么由脚本对**已提交的数据**导出，要么删掉。
 *
 * 本模块只放**数据与纯函数**，不做任何 I/O、不产生副作用，因此两份门禁都可以安全
 * import（`check-m3b-template-surface-sweep.mjs` 执行普查，
 * `check-m3b-registry-integrity.mjs` 校验登记表自身并与文档比对）。
 *
 * 输出纪律：本模块产出的所有消息只含**本文件里的静态字面量**（族 id、视图 id）
 * 与计数，不含任何输入派生内容，也绝不含合成取值或真实 Secret。
 */

/**
 * 六个视图。`premise` 描述该视图下 oracle 的前提：
 *
 *   - `self`  —— 被测赋值自己就是顶层活赋值，oracle 可直接验证这个键；
 *   - `outer` —— 活键是外层的 `NOTES`，被测赋值嵌在取值里，oracle 验证外层键；
 *   - `none`  —— 整行是注释，不建立任何键。
 *
 * （历史注记：此处曾写「其余视图的 oracle 前提由 `outerLive` / `noKey` 描述」，
 * 而代码里从来只有 `premise` 这一个字段、取值也从来是上面三个——那两个标识符
 * 是**注释里的幽灵**，代码一次都没读过。已按实际字段名更正。）
 */
export const views = Object.freeze([
  { id: 'active', role: 'strict', render: (a) => a, premise: 'self' },
  { id: 'nested', role: 'strict', render: (a) => `NOTES=${a}`, premise: 'outer' },
  { id: 'quoted', role: 'strict', render: (a) => `NOTES="${a}"`, premise: 'outer' },
  { id: 'comment', role: 'strict', render: (a) => `# ${a}`, premise: 'none' },
  { id: 'inline', role: 'strict', render: (a) => `NOTES=ok # ${a}`, premise: 'outer' },
  { id: 'prose', role: 'prose', render: (a) => `${a}`, premise: 'self' }
])

/** `expect` 的**闭集**。不在这个集合里的取值一律 fail closed，不得静默当成别的状态。 */
export const expectStates = Object.freeze(['caught', 'open', 'mixed'])

/**
 * **族**：一个键构造 + 它在全部视图下的预期。
 *
 * `expect` 是**当前实测事实**，不是愿望：
 *   - `caught` = 全部视图命中；
 *   - `open`   = 全部视图沉默；
 *   - `mixed`  = 逐视图混合，由 `openViews` 精确列出**沉默**的那些视图，其余必须命中。
 *
 * 每条 `open` / `mixed` 都必须带非空 `why` —— 登记一个开口而不写清楚它为什么开着，
 * 等于把缺陷洗成边界。这条由 `validateRegistry` 强制，不再靠文案自觉。
 *
 * 当前没有任何一族是 `mixed`（8 族实测都是全或无）。`mixed` 仍然实现并由
 * `check-m3b-registry-integrity.mjs` 的合成登记表用例覆盖，因为**登记表必须表达得下
 * 真相**：prose 角色活行那一族的真实状态就是逐视图混合，此前 `expect` 只有两个
 * 全或无状态，用任一个登记都会立刻转红，于是它只能留在文档表格里、门禁完全看不住。
 */
export const families = Object.freeze([
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
      '**闭集 17 个的判据是「非 ASCII 的字母/数字，且注入后劈开 token」**——全 Unicode 枚举得 ' +
      '79 个劈开 token 的码点，其中 62 个是 ASCII [A-Za-z0-9] 自身，余下恰为 17 个。' +
      '注意「大小写扩张」只是其中一条路径：\u{0131}(i) 与 \u{017F}(long s) **并不展开**，' +
      '它们靠自身即非 ASCII 字母而入集，故族名描述的是主要成因而非充要判据。'
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
      '真正的机理**不是** component/pieces 分析——谓词层实测 containsSensitiveKeyToken 对 ' +
      'PGPASSWORD_OLD+ 与对照组 PGPASSWORD_OLD **同为 false**（不可能是差异所在），而 ' +
      'isSensitiveKeyName 对两者**同为 true**。差异在于 readAssignmentGap 走 prose 分支返回 ' +
      'reachedEquals:false，于是那个为真的 isSensitiveKeyName 判定**从未被计入**；次级杠杆是 ' +
      'sensitiveCompactAssignments 对 compoundOperatorTail 直接 continue。`+` 不特殊：' +
      'PGPASSWORD_OLD- 同样六视图沉默。Round 20 登记 compoundOperatorTail 残留时写的' +
      '「active strict 视图不受影响」**不成立**（该结论属实，错的是上一版此处的机理归因）。'
  }
])

/**
 * **门禁结构上表达不了、因此零看守的族**。
 *
 * 它们不是「还没写的 case」，而是当前六个视图模板**渲染不出来**的形态：0/6 含反引号、
 * 0/6 含 `://`、0/6 含「`=` 后空白再接 `#`」。给它们一个稳定 id，是为了让文档能被
 * **机械比对**——此前这 4 族只以中文族名散落在计划文档表格里，与门禁完全脱钩，
 * 于是「9 族全部已由门禁钉死」这句假话活了整整一轮。
 *
 * 本模块**不测试**它们；`whyUnguarded` 说明为什么看不住。要真正钉住它们，必须先
 * 扩视图模板（新增反引号 / URL / `= #` 三个 render），那是独立里程碑，不在 M3B 范围。
 */
export const unguardedFamilies = Object.freeze([
  {
    id: 'unguarded/nested-hash-is-comment',
    whyUnguarded:
      '需要一个「`=` 后空白再接 `#`」的渲染面，六个视图模板 0/6 含该形态。'
  },
  {
    id: 'unguarded/backtick-quote',
    whyUnguarded:
      '需要一个含反引号的渲染面，六个视图模板 0/6 含反引号。这是当前**已披露的最大' +
      '未守面**：一个「整行含反引号即豁免敏感判据」的回归三张网全绿。反引号面无守' +
      '并非疏忽——round2 有一条已注册的反向要求，48 个反引号/粗体/括号包裹的键名在 ' +
      'prose 与 comment 两视图共 96 格必须保持干净（`WECHAT_APP_ID` 就是本项目键名），' +
      '当前的无守状态正是那条误报抑制要求的直接代价。'
  },
  {
    id: 'unguarded/url-prefix-nesting',
    whyUnguarded: '需要一个含 `://` 的渲染面，六个视图模板 0/6 含 `://`。'
  },
  {
    id: 'unguarded/prose-role-live-line',
    whyUnguarded:
      '真实状态是逐视图混合（prose 角色沉默、strict 角色命中）。`expect` 现已实现 ' +
      '`mixed`，但该族仍需要**按角色分组**的渲染面才能落格：当前 6 个视图里只有 1 个 ' +
      'prose 角色视图，混合态无法只靠 openViews 表达。'
  }
])

/**
 * 登记表自校验。返回**固定形状**的问题列表（只含本文件的静态 id 与计数）。
 * 非空即必须 fail closed——一张自己就不自洽的登记表，钉不住任何东西。
 */
export const validateRegistry = (registry) => {
  const problems = []
  const familyList = registry.families
  const unguardedList = registry.unguardedFamilies
  const viewList = registry.views
  const viewIds = new Set(viewList.map((view) => view.id))

  if (viewList.length === 0) {
    problems.push('视图集合为空：零视图的普查恒绿')
  }
  if (viewIds.size !== viewList.length) {
    problems.push('视图 id 有重复')
  }
  if (familyList.length === 0) {
    problems.push('族集合为空：零族的普查恒绿')
  }

  const seen = new Set()
  for (const family of familyList) {
    if (seen.has(family.id)) {
      problems.push(`${family.id}: 族 id 重复`)
    }
    seen.add(family.id)
    if (!expectStates.includes(family.expect)) {
      // 这一条是 F1 的核心：此前 expect 拼错（如 'opne'）会被 openFamilies 过滤器
      // 漏掉，然后被「families.length - openFamilies.length」**减**成一个命中族，
      // 门禁 exit 0 且打印「4 族命中」。任何不在闭集里的取值现在直接转红。
      problems.push(`${family.id}: expect 不在闭集 {${expectStates.join(', ')}} 内`)
      continue
    }
    if (family.expect !== 'caught') {
      if (typeof family.why !== 'string' || family.why.trim() === '') {
        problems.push(`${family.id}: 登记为非 caught 却没有非空 why`)
      }
    } else if (family.why !== undefined) {
      problems.push(`${family.id}: caught 族不得带 why`)
    }
    if (family.expect === 'mixed') {
      const openViews = family.openViews
      if (!Array.isArray(openViews) || openViews.length === 0) {
        problems.push(`${family.id}: mixed 族必须用非空 openViews 列出沉默视图`)
      } else if (openViews.length >= viewList.length) {
        problems.push(`${family.id}: mixed 族的 openViews 覆盖了全部视图，应登记为 open`)
      } else if (new Set(openViews).size !== openViews.length) {
        problems.push(`${family.id}: mixed 族的 openViews 有重复`)
      } else if (openViews.some((id) => !viewIds.has(id))) {
        problems.push(`${family.id}: mixed 族的 openViews 含未知视图 id`)
      }
    } else if (family.openViews !== undefined) {
      problems.push(`${family.id}: 只有 mixed 族才能带 openViews`)
    }
    if (typeof family.key !== 'function') {
      problems.push(`${family.id}: 缺少 key 生成器`)
    }
  }

  for (const family of unguardedList) {
    if (seen.has(family.id)) {
      problems.push(`${family.id}: 零看守族 id 与受测族冲突`)
    }
    seen.add(family.id)
    if (typeof family.whyUnguarded !== 'string' || family.whyUnguarded.trim() === '') {
      problems.push(`${family.id}: 零看守族必须写明为什么看不住`)
    }
  }

  // 三态计数必须**加**得回总数。此前命中族数是「总数 - open 数」**减**出来的，
  // 于是任何没被识别的 expect 都会悄悄计入命中侧。
  const byState = Object.fromEntries(
    expectStates.map((state) => [state, familyList.filter((f) => f.expect === state).length])
  )
  const accounted = expectStates.reduce((sum, state) => sum + byState[state], 0)
  if (accounted !== familyList.length) {
    problems.push(`族状态计数 ${String(accounted)} 与族总数 ${String(familyList.length)} 不符`)
  }
  return problems
}

/**
 * 逐族比对实测与登记。`caughtViewIds` 是该族**实测被捕获**的视图 id 集合。
 * 返回漂移说明或 `null`。
 *
 * 两个方向都转红是刻意的：未登记的族变沉默是新 fail-open；已登记的族被捕获是好
 * 消息，但覆盖面变了，登记必须同步更新后才准通过。
 */
export const driftFor = (family, caughtViewIds, viewList) => {
  const total = viewList.length
  const caught = viewList.filter((view) => caughtViewIds.has(view.id)).length
  if (family.expect === 'caught') {
    return caught === total
      ? null
      : `${family.id}: 登记为全部命中，实测 ${String(caught)}/${String(total)}`
  }
  if (family.expect === 'open') {
    return caught === 0
      ? null
      : `${family.id}: 登记为全部沉默，实测有 ${String(caught)} 格被捕获——覆盖面变好了，` +
          '但登记必须同步更新后才准通过'
  }
  const expectedOpen = new Set(family.openViews)
  const wrong = viewList.filter(
    (view) => expectedOpen.has(view.id) === caughtViewIds.has(view.id)
  )
  return wrong.length === 0
    ? null
    : `${family.id}: 登记为逐视图混合，实测有 ${String(wrong.length)} 个视图与 openViews 不符`
}

/** 由登记表**导出**的计数。任何对外打印的数字都必须走这里，不得手写。 */
export const registrySummary = (registry) => {
  const byState = Object.fromEntries(
    expectStates.map((state) => [
      state,
      registry.families.filter((family) => family.expect === state).length
    ])
  )
  return {
    views: registry.views.length,
    families: registry.families.length,
    cells: registry.families.length * registry.views.length,
    caught: byState.caught,
    open: byState.open,
    mixed: byState.mixed,
    unguarded: registry.unguardedFamilies.length,
    registered: registry.families.filter((family) => family.expect !== 'caught').length +
      registry.unguardedFamilies.length
  }
}

/** 默认登记表（生产实例）。 */
export const registry = Object.freeze({ views, families, unguardedFamilies })
