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

const attemptConnect = (host, port, timeoutMs = 3_000) =>
  new Promise((resolveAttempt) => {
    // zone 后缀（fe80::…%en0）不影响 family 判定：按去掉 zone 的裸地址判。
    const bare = host.split('%')[0]
    const socket = connect({ host, port, family: isIP(bare) === 6 ? 6 : 4 })
    let settled = false
    const done = (outcome) => {
      if (!settled) {
        settled = true
        socket.destroy()
        resolveAttempt(outcome)
      }
    }
    socket.once('connect', () => done('connected'))
    socket.once('error', (error) => done(`refused:${error.code ?? 'unknown'}`))
    setTimeout(() => done('timeout'), timeoutMs).unref()
  })

/** HTTP 层判定「是不是我们的 API」：/healthz 200 且 body 是它的成功形状。 */
const probeApiHttp = async (host, port) => {
  // IPv6（含带 zone 的 link-local）用方括号形式；zone 分隔符 % 在 URL 里必须
  // 编码为 %25。
  const bare = host.split('%')[0]
  const target =
    isIP(bare) === 6
      ? `http://[${host.replace('%', '%25')}]:${String(port)}/healthz`
      : `http://${host}:${String(port)}/healthz`
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(4_000) })
    const body = await response.text()
    if (response.status === 200 && body.includes('"status":"ok"')) {
      return 'api-reachable'
    }
    return `http-${String(response.status)}-not-our-api`
  } catch {
    return 'http-unreachable'
  }
}

/**
 * 采集一个 label project 的全部 Docker 产物：每个容器的完整 inspect、单列的
 * Config.Env / Config.Cmd/Args / Mounts、stdout/stderr logs，以及它们镜像的
 * inspect 与 `history --no-trunc`。smoke 与反向测试用**同一个**采集器。
 */
export const collectDockerArtifactsForProject = ({ project, run, onProblem }) => {
  const artifacts = []
  const addArtifact = (label, content) => {
    artifacts.push({ label, content: content ?? '' })
  }
  const containerIds = run([
    'docker',
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`
  ])
    .stdout.split('\n')
    .filter(Boolean)
  const imageIds = new Set()
  for (const id of containerIds) {
    const inspect = run(['docker', 'inspect', id])
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
    const logs = run(['docker', 'logs', id], { timeoutMs: 120_000 })
    if (logs.status !== 0) {
      onProblem(`containment: docker logs ${name} failed; its output cannot be scanned`)
    }
    addArtifact(`container logs ${name}`, `${logs.stdout}\n${logs.stderr}`)
  }
  for (const imageId of imageIds) {
    const inspect = run(['docker', 'image', 'inspect', imageId])
    if (inspect.status !== 0) {
      onProblem(`containment: docker image inspect ${imageId} failed`)
    } else {
      addArtifact(`image inspect ${imageId.slice(0, 19)}`, inspect.stdout)
    }
    const history = run(['docker', 'image', 'history', '--no-trunc', imageId])
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
        '--profile',
        'bootstrap',
        '--project-name',
        project,
        ...args
      ],
      { env: composeEnvironment, ...options }
    )

  assertNeedleCompleteness(bodies, needles, fail)

  const resolvedConfig = compose(['config'], { timeoutMs: 120_000 })
  if (resolvedConfig.status !== 0) {
    fail(
      'containment: docker compose config failed; the resolved configuration ' +
        'cannot be scanned'
    )
  }
  const artifacts = [
    { label: 'docker compose config', content: resolvedConfig.stdout }
  ]
  const collected = collectDockerArtifactsForProject({ project, run, onProblem: fail })
  artifacts.push(...collected.artifacts)
  if (collected.containerIds.length === 0) {
    fail('containment: no project containers were found to scan')
  }

  // Git tracked files：全仓库逐文件字节扫描。
  const tracked = run(['git', 'ls-files', '-z'], {
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
        `(http probe: ${http}); the API must not be reachable over IPv6 loopback`
    )
  } else {
    log(`isolation: [::1]:${String(hostPort)} -> ${ipv6Loopback} (as required)`)
  }

  // HTTP 探针的正向自检：它必须能在 127.0.0.1 上认出我们自己的 API，否则
  // 下面 accept-all 分支的「API 级探测失败 = 安全」就没有裁决能力。
  const selfProbe = await probeApiHttp('127.0.0.1', hostPort)
  if (selfProbe !== 'api-reachable') {
    fail(
      `isolation: the HTTP probe cannot recognise our own API on 127.0.0.1 ` +
        `(${selfProbe}); every accept-all verdict below would be meaningless`
    )
  } else {
    log('isolation: HTTP probe self-check on 127.0.0.1 recognises the API (positive control)')
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
  let controlPort = 0
  for (let attempt = 0; attempt < 20 && controlPort === 0; attempt += 1) {
    const candidate = 20_000 + (randomBytes(2).readUInt16BE(0) % 40_000)
    if (candidate === hostPort) {
      continue
    }
    if ((await portIsBindable('127.0.0.1', candidate)) && (await portIsBindable('::1', candidate))) {
      controlPort = candidate
    }
  }
  if (controlPort === 0) {
    fail('isolation: could not find a listener-free control port; accept-all verdicts would be unfounded')
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
    if (outcome !== 'connected') {
      log(`isolation: ${interfaceName} ${address}:${String(hostPort)} -> ${outcome} (as required)`)
      continue
    }
    const control = controlPort === 0 ? 'unverified' : await attemptConnect(address, controlPort)
    const http = await probeApiHttp(address, hostPort)
    if (http === 'api-reachable') {
      fail(
        `isolation: the API answered /healthz from non-loopback address ` +
          `${interfaceName} ${address}; the loopback boundary is broken`
      )
    } else if (control === 'connected' && selfProbe === 'api-reachable') {
      log(
        `isolation: ${interfaceName} ${address} is an accept-all interface proxy ` +
          `(listener-free control port ${String(controlPort)} also accepts); ` +
          `API-level probe failed as required (${http})`
      )
    } else {
      fail(
        `isolation: ${interfaceName} ${address}:${String(hostPort)} accepted TCP ` +
          `(control=${control}, http=${http}); this acceptance cannot be ` +
          'attributed to an accept-all proxy and is treated as exposure'
      )
    }
  }

  // postgres：没有任何 PublishedPort / PortBinding。inspect 失败必须 fail
  // closed——「容器不存在」不能被读成「没有发布端口」。
  const strictInspectJson = (target, format, label) => {
    const result = run(['docker', 'inspect', '--format', format, target])
    if (result.status !== 0) {
      fail(`isolation: docker inspect ${label} failed; the check cannot pass by default`)
      return null
    }
    return JSON.parse(result.stdout.trim() || 'null')
  }
  const postgresName = `${project}-postgres-1`
  const postgresPorts = strictInspectJson(
    postgresName,
    '{{json .NetworkSettings.Ports}}',
    `${postgresName} ports`
  )
  const postgresBindings = strictInspectJson(
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
  const apiPorts = strictInspectJson(
    apiName,
    '{{json .NetworkSettings.Ports}}',
    `${apiName} ports`
  ) ?? {}
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
