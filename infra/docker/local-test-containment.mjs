// 阶段 09A / M3B：Secret containment 扫描与动态网络隔离。
//
// 由 run-local-test-smoke.mjs 在完整链跑通、api 仍在运行时调用。
//
// containment 扫描：把本轮 bundle 的全部敏感 needle（四个原始口令、它们的
// URL 编码形态、三条完整 DATABASE_URL、两条 pgpass 记录）与一个本轮随机的
// scanner sentinel 一起，在内存中比对以下真实产物：
//
//   1. docker compose config（解析后配置）
//   2. 全部本 project 容器的 docker inspect（并单列 Config.Env、
//      Config.Cmd/Args、Mounts 三类）
//   3. docker image inspect（本链用到的全部镜像）
//   4. docker image history --no-trunc（同上）
//   5. 全部本 project 容器的 stdout/stderr logs
//   6. Git tracked files（全仓库逐文件字节扫描）
//   7. smoke 自身的全部输出（transcript，含 generator 路径上的输出）
//
// 扫描器先用「包含全部 needle 的合成产物」自检：每一条 needle 都必须被命中，
// 证明匹配机制对本轮随机值真实有效，而不是固定测试字符串。任何真实产物命中
// 时，失败消息只报告 needle 的类别与位置，**绝不**重新打印命中的取值。
//
// 动态网络隔离（宿主侧真实连接，不用 inspect 冒充）：
//
//   - 127.0.0.1:<port>/healthz 与 /readyz 可访问（200）；
//   - ::1:<port> 不可访问（端口在启动前已确认 ::1 空闲）；
//   - 枚举宿主全部非 loopback IPv4/IPv6 地址逐一连接，必须失败。已知例外是
//     Docker Desktop 自己的 accept-all utun 接口：它对**任意**端口都完成 TCP
//     accept（用一个无监听的对照端口证明），此时判定改由 HTTP 层承担——API
//     级探测必须失败，且对照端口必须同样 accept，否则仍按失败处理；
//   - postgres 容器没有任何 PublishedPort/PortBinding；
//   - api 容器恰好一个 host binding：127.0.0.1:<port>→3000/tcp。
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect, createServer, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'

import { repositoryRoot, secretFiles } from './local-test-secrets-contract.mjs'

/**
 * 由 bundle bodies 构造分类 needle 清单（只在内存中存在）。
 *
 * 口令字母表是纯字母数字，因此口令的 URL 编码形态与原值相同（原值 needle 已
 * 覆盖）；URL 与 pgpass 行则各自多一条编码形态。另为每个口令加一条 16 字符
 * 前缀 needle，兜住「显式截断后再输出」的泄漏形态——48 字符随机值的 16 字符
 * 前缀独立撞车的概率可以忽略。
 */
export const buildNeedles = (bodies) => {
  const needles = []
  const push = (category, value) => {
    if (typeof value === 'string' && value.length > 0) {
      needles.push({ id: needles.length + 1, category, value })
    }
  }
  for (const entry of secretFiles) {
    const body = bodies.get(entry.filename)
    if (typeof body !== 'string') {
      continue
    }
    if (entry.kind === 'password') {
      push(`password:${entry.role}`, body)
      push(`password-prefix:${entry.role}`, body.slice(0, 16))
      const encoded = encodeURIComponent(body)
      if (encoded !== body) {
        push(`password-url-encoded:${entry.role}`, encoded)
      }
    } else if (entry.kind === 'url') {
      push(`database-url:${entry.role}`, body)
      push(`database-url-encoded:${entry.role}`, encodeURIComponent(body))
    } else {
      for (const [index, line] of body.split('\n').entries()) {
        push(`pgpass-line-${String(index + 1)}`, line)
        push(`pgpass-line-${String(index + 1)}-encoded`, encodeURIComponent(line))
      }
    }
  }
  return needles
}

/**
 * needle 完整性：八份 body 一份都不能少，且每个必需类别都必须已构造出来。
 * bodies 缺项会静默缩小扫描面，因此这里 fail closed。
 */
export const assertNeedleCompleteness = (bodies, needles, onProblem) => {
  for (const entry of secretFiles) {
    if (typeof bodies.get(entry.filename) !== 'string') {
      onProblem(
        `containment: the bundle body for ${entry.filename} is missing; ` +
          'the needle set would silently shrink'
      )
    }
  }
  const categories = new Set(needles.map((needle) => needle.category))
  const required = []
  for (const entry of secretFiles) {
    if (entry.kind === 'password') {
      required.push(`password:${entry.role}`, `password-prefix:${entry.role}`)
    } else if (entry.kind === 'url') {
      required.push(`database-url:${entry.role}`, `database-url-encoded:${entry.role}`)
    } else {
      required.push('pgpass-line-1', 'pgpass-line-2', 'pgpass-line-1-encoded', 'pgpass-line-2-encoded')
    }
  }
  for (const category of required) {
    if (!categories.has(category)) {
      onProblem(`containment: required needle category ${category} was not built`)
    }
  }
}

/**
 * 「本地根本无法发起这次连接」的 errno：地址族不支持、地址非法、接口 down、
 * 路由不可达。它们证明的是**本机没能试**，不是「对端拒绝了」，因此不能当作
 * 隔离证据——必须与 ECONNREFUSED 区分开。
 */
const unattemptableErrorCodes = new Set([
  'EINVAL',
  'EAFNOSUPPORT',
  'EADDRNOTAVAIL',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN'
])

const attemptConnect = (host, port, timeoutMs = 3_000) =>
  new Promise((resolveAttempt) => {
    // zone 后缀（fe80::…%en0）不影响 family 判定：按去掉 zone 的裸地址判。
    const bare = host.split('%')[0]
    let socket
    try {
      socket = connect({ host, port, family: isIP(bare) === 6 ? 6 : 4 })
    } catch (error) {
      resolveAttempt(`unattemptable:${String(error?.code ?? 'construct-failed')}`)
      return
    }
    let settled = false
    const done = (outcome) => {
      if (!settled) {
        settled = true
        socket.destroy()
        resolveAttempt(outcome)
      }
    }
    socket.once('connect', () => done('connected'))
    socket.once('error', (error) => {
      const code = String(error.code ?? 'unknown')
      done(unattemptableErrorCodes.has(code) ? `unattemptable:${code}` : `refused:${code}`)
    })
    setTimeout(() => done('timeout'), timeoutMs).unref()
  })

/**
 * HTTP 层判定「是不是我们的 API」。**不用 fetch**：WHATWG URL 不接受 IPv6
 * zone（`fe80::1%en0`），一旦构造失败 fetch 会抛错，而把「请求根本没构造出
 * 来」和「请求发出后没人应答」混成同一个 http-unreachable，正是上一版把
 * link-local 证据做成空转的根因。这里改成**原始 socket + 手写 HTTP/1.1
 * 请求**，socket 层原生支持 zone，并给出六种互斥结局：
 *
 *   not-constructed  连 socket 都没建起来（地址不合法）——**不是**隔离证据
 *   not-sent         连接未建立（TCP 拒绝/超时），请求字节从未发出
 *   tcp-refused      TCP 明确被拒
 *   no-response      TCP 连上、请求已写出，但**一个响应字节都没读到**
 *                    （RST / 静默丢弃 / 超时）——它证明不了对端是 HTTP 服务，
 *                    因此**不算**「请求被应答」
 *   not-api          确实读到了 HTTP 响应，但不是我们的 /healthz 成功形状
 *   api-reachable    /healthz 200 且 body 是它的成功形状
 *
 * 只有 `not-api` 与 `api-reachable` 证明「请求确实发出**并被 HTTP 应答**」，
 * 才可以进入隔离裁决。`no-response` 必须单独成一类：Docker Desktop 的
 * accept-all 接口恰恰是「accept 之后立刻 RST」，把它算成 not-api 会让
 * accept-all 的对照端口论证整条变成死代码（实测：accept-then-RST 会被上一版
 * 判成 not-api 并直接放行）。
 */
const probeApiHttp = (host, port, timeoutMs = 4_000) =>
  new Promise((resolveProbe) => {
    const bare = host.split('%')[0]
    const family = isIP(bare) === 6 ? 6 : 4
    let socket
    try {
      socket = connect({ host, port, family })
    } catch (error) {
      resolveProbe({ outcome: 'not-constructed', detail: String(error?.code ?? error) })
      return
    }
    let settled = false
    let connected = false
    let body = ''
    const done = (outcome, detail) => {
      if (!settled) {
        settled = true
        socket.destroy()
        resolveProbe({ outcome, detail })
      }
    }
    const timer = setTimeout(
      () => done(connected ? (body === '' ? 'no-response' : 'not-api') : 'not-sent', 'timeout'),
      timeoutMs
    )
    timer.unref()
    socket.once('error', (error) => {
      done(
        connected ? (body === '' ? 'no-response' : 'not-api') : 'tcp-refused',
        String(error.code ?? 'unknown')
      )
    })
    socket.once('connect', () => {
      connected = true
      // Host 头用裸地址（不带 zone）：zone 是本机路由概念，不属于 HTTP。
      const hostHeader = family === 6 ? `[${bare}]:${String(port)}` : `${bare}:${String(port)}`
      socket.write(
        `GET /healthz HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`
      )
    })
    socket.on('data', (chunk) => {
      body += chunk.toString('utf8')
      if (body.includes('"status":"ok"') && /^HTTP\/1\.[01] 200/.test(body)) {
        done('api-reachable', 'healthz 200 with the API success shape')
      }
    })
    socket.once('close', () => {
      if (settled) {
        return
      }
      if (!connected) {
        done('not-sent', 'closed before connect')
        return
      }
      if (body === '') {
        done('no-response', 'the peer closed without sending a single byte')
        return
      }
      const statusLine = body.split('\r\n')[0] ?? ''
      done('not-api', statusLine)
    })
  })

/** 只有这两种结局证明请求确实发出**并被 HTTP 应答**。 */
const requestActuallySent = (outcome) =>
  outcome === 'api-reachable' || outcome === 'not-api'

/**
 * 采集一个 label project 的全部 Docker 产物：每个容器的完整 inspect、单列的
 * Config.Env / Config.Cmd/Args / Mounts、stdout/stderr logs，以及它们镜像的
 * inspect 与 `history --no-trunc`。smoke 与反向测试用**同一个**采集器。
 */
export const collectDockerArtifactsForProject = async ({ project, run, onProblem }) => {
  const artifacts = []
  const addArtifact = (label, content) => {
    artifacts.push({ label, content: content ?? '' })
  }
  const listing = await run([
    'docker',
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`
  ])
  if (listing.status !== 0) {
    onProblem('containment: listing project containers failed; artifacts cannot be collected')
  }
  const containerIds = listing.stdout.split('\n').filter(Boolean)
  const imageIds = new Set()
  for (const id of containerIds) {
    const inspect = await run(['docker', 'inspect', id])
    if (inspect.status !== 0) {
      onProblem(`containment: docker inspect ${id} failed`)
      continue
    }
    const parsed = JSON.parse(inspect.stdout)[0] ?? {}
    const name = String(parsed.Name ?? id).replace(/^\//, '')
    addArtifact(`container inspect ${name}`, inspect.stdout)
    addArtifact(`container Config.Env ${name}`, JSON.stringify(parsed.Config?.Env ?? []))
    addArtifact(
      `container Config.Cmd/Args ${name}`,
      JSON.stringify({
        cmd: parsed.Config?.Cmd ?? null,
        entrypoint: parsed.Config?.Entrypoint ?? null,
        args: parsed.Args ?? null,
        path: parsed.Path ?? null
      })
    )
    addArtifact(`container Mounts ${name}`, JSON.stringify(parsed.Mounts ?? []))
    if (typeof parsed.Image === 'string') {
      imageIds.add(parsed.Image)
    }
    const logs = await run(['docker', 'logs', id], { timeoutMs: 120_000 })
    if (logs.status !== 0) {
      onProblem(`containment: docker logs ${name} failed; its output cannot be scanned`)
    }
    addArtifact(`container logs ${name}`, `${logs.stdout}\n${logs.stderr}`)
  }
  for (const imageId of imageIds) {
    const inspect = await run(['docker', 'image', 'inspect', imageId])
    if (inspect.status !== 0) {
      onProblem(`containment: docker image inspect ${imageId} failed`)
    } else {
      addArtifact(`image inspect ${imageId.slice(0, 19)}`, inspect.stdout)
    }
    const history = await run(['docker', 'image', 'history', '--no-trunc', imageId])
    if (history.status !== 0) {
      onProblem(`containment: docker image history ${imageId} failed`)
    } else {
      addArtifact(`image history ${imageId.slice(0, 19)}`, history.stdout)
    }
  }
  return { artifacts, containerIds }
}

/**
 * 扫描产物。返回 hits（产物 label + needle 序号 + 类别），**不含**命中的取值；
 * 调用方组装失败消息时同样不得回显取值。
 */
export const scanArtifactsForNeedles = (artifacts, needles) => {
  const hits = []
  for (const artifact of artifacts) {
    for (const needle of needles) {
      if (artifact.content.includes(needle.value)) {
        hits.push({ label: artifact.label, id: needle.id, category: needle.category })
      }
    }
  }
  return hits
}

export const runContainmentAndIsolation = async ({
  project,
  hostPort,
  bodies,
  composeFile,
  composeArgs = [],
  composeEnvironment,
  transcript,
  log,
  fail,
  run
}) => {
  // -------------------------------------------------------------------------
  // 1. containment 扫描
  // -------------------------------------------------------------------------
  const needles = buildNeedles(bodies)
  const scannerSentinel = `M3B-SCANNER-SENTINEL-${randomBytes(12).toString('hex')}`
  const sentinelNeedle = {
    id: needles.length + 1,
    category: 'scanner-sentinel',
    value: scannerSentinel
  }

  const compose = (args, options = {}) =>
    run(
      [
        'docker',
        'compose',
        '--file',
        composeFile,
        ...composeArgs,
        '--profile',
        'bootstrap',
        '--project-name',
        project,
        ...args
      ],
      { env: composeEnvironment, ...options }
    )

  assertNeedleCompleteness(bodies, needles, fail)

  const resolvedConfig = await compose(['config'], { timeoutMs: 120_000 })
  if (resolvedConfig.status !== 0) {
    fail(
      'containment: docker compose config failed; the resolved configuration ' +
        'cannot be scanned'
    )
  }
  const artifacts = [
    { label: 'docker compose config', content: resolvedConfig.stdout }
  ]
  const collected = await collectDockerArtifactsForProject({ project, run, onProblem: fail })
  artifacts.push(...collected.artifacts)
  if (collected.containerIds.length === 0) {
    fail('containment: no project containers were found to scan')
  }

  // Git tracked files：全仓库逐文件字节扫描。
  const tracked = await run(['git', 'ls-files', '-z'], {
    cwd: repositoryRoot,
    timeoutMs: 60_000
  })
  if (tracked.status !== 0) {
    fail('containment: git ls-files failed; tracked files cannot be scanned')
  }
  const trackedFiles = tracked.stdout.split('\u0000').filter(Boolean)

  // 自检：合成产物包含每一条 needle 与 sentinel，必须被**同一个**
  // scanArtifactsForNeedles 逐条命中，证明匹配机制对本轮随机值真实有效。
  const selfTestHits = scanArtifactsForNeedles(
    [
      {
        label: 'synthetic-self-test',
        content: [
          ...needles.map((needle) => `payload ${needle.value} payload`),
          `payload ${sentinelNeedle.value} payload`
        ].join('\n')
      }
    ],
    [...needles, sentinelNeedle]
  )
  for (const needle of [...needles, sentinelNeedle]) {
    if (!selfTestHits.some((hit) => hit.id === needle.id)) {
      fail(
        `containment self-test: needle #${String(needle.id)} (${needle.category}) ` +
          'was not detectable in the synthetic artifact; the scanner is broken'
      )
    }
  }
  log(
    `containment self-test: ${String(needles.length + 1)} needles (incl. the ` +
      'per-run random scanner sentinel) all detectable in a synthetic artifact'
  )

  // 真实产物扫描：命中即失败，只报类别与位置，不回显取值。transcript 快照也
  // 作为一个产物参加扫描（之后的输出只有固定文本与计数）。
  const scannedArtifacts = [
    ...artifacts,
    {
      label: 'smoke transcript (generator and smoke output)',
      content: transcript.join('\n')
    }
  ]
  for (const hit of scanArtifactsForNeedles(scannedArtifacts, needles)) {
    fail(
      `containment: ${hit.label} contains secret needle #${String(hit.id)} ` +
        `(${hit.category}); the value is not reprinted here`
    )
  }
  let scannedTrackedFiles = 0
  for (const file of trackedFiles) {
    let buffer
    try {
      buffer = readFileSync(resolve(repositoryRoot, file))
    } catch {
      fail(`containment: tracked file ${file} could not be read for scanning`)
      continue
    }
    scannedTrackedFiles += 1
    for (const needle of needles) {
      if (buffer.includes(needle.value)) {
        fail(
          `containment: tracked file ${file} contains secret needle ` +
            `#${String(needle.id)} (${needle.category}); the value is not reprinted here`
        )
      }
    }
  }

  log(
    `containment scan: ${String(needles.length)} needles against ` +
      `${String(scannedArtifacts.length)} docker/config/log/transcript artifacts ` +
      `and ${String(scannedTrackedFiles)} tracked files — no hits`
  )

  // -------------------------------------------------------------------------
  // 2. 动态网络隔离
  // -------------------------------------------------------------------------
  for (const path of ['/healthz', '/readyz']) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(hostPort)}${path}`, {
        signal: AbortSignal.timeout(10_000)
      })
      if (response.status !== 200) {
        fail(`isolation: 127.0.0.1${path} returned ${String(response.status)}`)
      } else {
        log(`isolation: 127.0.0.1:${String(hostPort)}${path} -> 200`)
      }
    } catch (error) {
      fail(`isolation: 127.0.0.1${path} was unreachable (${String(error)})`)
    }
  }

  const ipv6Loopback = await attemptConnect('::1', hostPort)
  if (ipv6Loopback === 'connected') {
    const http = await probeApiHttp('::1', hostPort)
    fail(
      `isolation: [::1]:${String(hostPort)} accepted a TCP connection ` +
        `(http probe: ${http.outcome}); the API must not be reachable over IPv6 loopback`
    )
  } else {
    log(`isolation: [::1]:${String(hostPort)} -> ${ipv6Loopback} (as required)`)
  }

  // HTTP 探针的正向自检：它必须能在 127.0.0.1 上认出我们自己的 API，否则
  // 下面 accept-all 分支的「API 级探测失败 = 安全」就没有裁决能力。
  const selfProbe = await probeApiHttp('127.0.0.1', hostPort)
  if (selfProbe.outcome !== 'api-reachable') {
    fail(
      `isolation: the HTTP probe cannot recognise our own API on 127.0.0.1 ` +
        `(${selfProbe.outcome}: ${selfProbe.detail}); every accept-all verdict ` +
        'below would be meaningless'
    )
  } else {
    log('isolation: HTTP probe self-check on 127.0.0.1 recognises the API (positive control)')
  }

  // **带 zone 的 IPv6 正向对照**：证明探针在 scoped link-local 上真的能发出
  // 请求并收到应答——否则「link-local 探测失败」就分不清「隔离成立」和
  // 「请求根本没发出去」。做法：在本机第一个 link-local 地址上起一个临时
  // HTTP 监听，用与隔离判定**同一个** probeApiHttp 打它，要求结局是
  // `not-api`（连上了、发出了请求、拿到 HTTP 响应，但不是我们的 API 形状）。
  const linkLocal = []
  for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (
        !address.internal &&
        address.family === 'IPv6' &&
        address.address.toLowerCase().startsWith('fe80:')
      ) {
        linkLocal.push({ interfaceName, address: address.address })
      }
    }
  }
  if (linkLocal.length === 0) {
    log(
      'isolation: the host has no link-local IPv6 address; the zoned-probe ' +
        'positive control cannot be obtained on this host (no link-local ' +
        'address participates in the adjudication below either)'
    )
  } else {
    const { interfaceName, address } = linkLocal[0]
    const scoped = `${address}%${interfaceName}`
    const control = createServer((socket) => {
      socket.end('HTTP/1.1 418 I am a control\r\nConnection: close\r\n\r\ncontrol')
    })
    const controlOutcome = await new Promise((resolveControl) => {
      control.once('error', (error) =>
        resolveControl({ outcome: 'listen-failed', detail: String(error.code ?? error) })
      )
      control.listen({ host: scoped, port: 0 }, async () => {
        const { port } = control.address()
        const probed = await probeApiHttp(scoped, port)
        resolveControl(probed)
      })
    })
    control.close()
    if (controlOutcome.outcome === 'not-api') {
      log(
        `isolation: zoned IPv6 positive control on ${scoped} — the probe really ` +
          `sent a request and read a response (${controlOutcome.detail})`
      )
    } else {
      fail(
        `isolation: the zoned IPv6 positive control on ${scoped} returned ` +
          `${controlOutcome.outcome} (${controlOutcome.detail}); link-local ` +
          'results below cannot be treated as isolation evidence'
      )
    }
  }

  // 对照端口：本轮随机选择、与 API 端口不同，并且**验证过**本机确实没有任何
  // 监听（127.0.0.1 与 ::1 双侧可绑定——0.0.0.0/:: 的监听会让绑定失败）。
  // accept-all 接口会连它一起 accept，这让「TCP accept」在那类接口上失去
  // 信息量，判定改由 HTTP 层承担。
  const portIsBindable = (host, port) =>
    new Promise((resolveBindable) => {
      const server = createServer()
      server.once('error', () => resolveBindable(false))
      server.listen({ host, port, exclusive: true }, () => {
        server.close(() => resolveBindable(true))
      })
    })
  // 取**两个**互相独立的无监听对照端口：accept-all 接口的判据因此是「对任意
  // 端口都 accept」，而不是「恰好对某一个端口 accept」。
  const controlPorts = []
  for (let attempt = 0; attempt < 40 && controlPorts.length < 2; attempt += 1) {
    const candidate = 20_000 + (randomBytes(2).readUInt16BE(0) % 40_000)
    if (candidate === hostPort || controlPorts.includes(candidate)) {
      continue
    }
    if ((await portIsBindable('127.0.0.1', candidate)) && (await portIsBindable('::1', candidate))) {
      controlPorts.push(candidate)
    }
  }
  if (controlPorts.length < 2) {
    fail(
      'isolation: could not find two listener-free control ports; accept-all ' +
        'verdicts would be unfounded'
    )
  }

  // link-local IPv6（fe80::/10）必须带 zone（scope id）才能真的被路由：不带
  // zone 的连接是 EHOSTUNREACH 的空转，不构成证据。os.networkInterfaces() 把
  // zone 放在 scopeid 字段里，这里拼回 `<address>%<interface>`。
  const nonLoopback = []
  for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) {
        continue
      }
      const isLinkLocal =
        address.family === 'IPv6' && address.address.toLowerCase().startsWith('fe80:')
      nonLoopback.push({
        interfaceName,
        address: isLinkLocal ? `${address.address}%${interfaceName}` : address.address
      })
    }
  }
  if (nonLoopback.length === 0) {
    log('isolation: the host has no non-loopback addresses; no dynamic evidence is obtainable for this item')
  }
  for (const { interfaceName, address } of nonLoopback) {
    const outcome = await attemptConnect(address, hostPort)
    if (outcome.startsWith('unattemptable:')) {
      // 本机根本没能发起这次连接（地址族/路由/接口问题）。这**不是**隔离
      // 证据，如实记为无法取证，不算通过也不算失败。
      log(
        `isolation: ${interfaceName} ${address}:${String(hostPort)} -> ${outcome} ` +
          '(the host could not attempt this connection; no isolation evidence ' +
          'is obtainable for this address)'
      )
      continue
    }
    if (outcome !== 'connected') {
      log(`isolation: ${interfaceName} ${address}:${String(hostPort)} -> ${outcome} (as required)`)
      continue
    }
    // TCP 连上了：此时必须真的把 HTTP 请求发出去再判。probe 的五种结局里，
    // 只有 api-reachable / not-api 证明请求确实发出并被应答。
    const http = await probeApiHttp(address, hostPort)
    if (http.outcome === 'api-reachable') {
      fail(
        `isolation: the API answered /healthz from non-loopback address ` +
          `${interfaceName} ${address}; the loopback boundary is broken`
      )
      continue
    }
    // 连上了但**没读到 HTTP 响应**（no-response）或请求根本没发出：这在
    // 「端口真的被发布」的情形下不该发生，只有当该接口被证明是 accept-all
    // 代理时才允许放行。判据必须是**两个**独立的无监听对照端口都 accept，
    // 并且它们的 HTTP 层结局与本次一致（同样读不到响应）——否则「对任意端口
    // 都 accept」这条解释不成立。
    if (!requestActuallySent(http.outcome)) {
      const controls =
        controlPorts.length < 2
          ? []
          : await Promise.all(controlPorts.map((port) => attemptConnect(address, port)))
      const acceptsAll = controls.length === 2 && controls.every((r) => r === 'connected')
      const controlProbes =
        acceptsAll && controlPorts.length === 2
          ? await Promise.all(controlPorts.map((port) => probeApiHttp(address, port)))
          : []
      const controlsBehaveTheSame =
        controlProbes.length === 2 &&
        controlProbes.every((probe) => probe.outcome === http.outcome)
      if (acceptsAll && controlsBehaveTheSame && selfProbe.outcome === 'api-reachable') {
        log(
          `isolation: ${interfaceName} ${address} is a proven accept-all interface ` +
            `proxy (both listener-free control ports ${controlPorts.join(', ')} accept ` +
            `and produce the same ${http.outcome} result); the API-level request on ` +
            `the published port produced ${http.outcome} (${http.detail}) as required`
        )
      } else {
        fail(
          `isolation: ${interfaceName} ${address}:${String(hostPort)} accepted TCP ` +
            `but the probe result is ${http.outcome} (${http.detail}); control ports ` +
            `returned [${controls.join(', ') || 'unverified'}] with probe outcomes ` +
            `[${controlProbes.map((probe) => probe.outcome).join(', ') || 'unverified'}]; ` +
            'this acceptance cannot be attributed to a proven accept-all proxy'
        )
      }
      continue
    }
    log(
      `isolation: ${interfaceName} ${address}:${String(hostPort)} answered ` +
        `${http.outcome} (${http.detail}) — a real HTTP response was read and it is not our API`
    )
  }

  // postgres：没有任何 PublishedPort / PortBinding。inspect 失败必须 fail
  // closed——「容器不存在」不能被读成「没有发布端口」。
  const strictInspectJson = async (target, format, label) => {
    const result = await run(['docker', 'inspect', '--format', format, target])
    if (result.status !== 0) {
      fail(`isolation: docker inspect ${label} failed; the check cannot pass by default`)
      return null
    }
    try {
      return JSON.parse(result.stdout.trim() || 'null')
    } catch {
      fail(`isolation: docker inspect ${label} did not return valid JSON`)
      return null
    }
  }
  const postgresName = `${project}-postgres-1`
  const postgresPorts = await strictInspectJson(
    postgresName,
    '{{json .NetworkSettings.Ports}}',
    `${postgresName} ports`
  )
  const postgresBindings = await strictInspectJson(
    postgresName,
    '{{json .HostConfig.PortBindings}}',
    `${postgresName} bindings`
  )
  if (postgresPorts !== null && postgresBindings !== null) {
    const publishedPostgres = Object.entries(postgresPorts ?? {}).filter(
      ([, bindings]) => Array.isArray(bindings) && bindings.length > 0
    )
    if (publishedPostgres.length > 0 || Object.keys(postgresBindings ?? {}).length > 0) {
      fail('isolation: postgres publishes a host port; the database must stay internal-only')
    } else {
      log('isolation: postgres has no PublishedPort and no PortBinding')
    }
  }

  // api：恰好一个 host binding，127.0.0.1:<port> → 3000/tcp。
  const apiName = `${project}-api-1`
  const apiPorts =
    (await strictInspectJson(apiName, '{{json .NetworkSettings.Ports}}', `${apiName} ports`)) ?? {}
  const apiBindings = Object.entries(apiPorts ?? {}).flatMap(([containerPort, bindings]) =>
    (bindings ?? []).map((binding) => ({ containerPort, ...binding }))
  )
  const expectedBinding =
    apiBindings.length === 1 &&
    apiBindings[0].containerPort === '3000/tcp' &&
    apiBindings[0].HostIp === '127.0.0.1' &&
    apiBindings[0].HostPort === String(hostPort)
  if (!expectedBinding) {
    fail(
      `isolation: api host bindings drifted: ${JSON.stringify(apiBindings)} ` +
        `(expected exactly 127.0.0.1:${String(hostPort)} -> 3000/tcp)`
    )
  } else {
    log(
      `isolation: api has exactly one host listener binding ` +
        `127.0.0.1:${String(hostPort)} -> 3000/tcp (no 0.0.0.0 / :: / LAN binding)`
    )
  }
}
