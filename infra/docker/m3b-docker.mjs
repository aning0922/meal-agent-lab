// 阶段 09A / M3B：Docker 证据的 fail-closed 读取与分阶段 scoped cleanup。
//
// 阻断整改第一、三条的落点：
//
//   - **所有** docker down/list/inspect/remove/re-list/dangling 查询都检查退出
//     码，读不到就报错，绝不用 null/`{}`/`[]` 默认值冒充「没有」；
//   - cleanup 是一个**分阶段收集器**：临时 Secret 目录、compose down、容器、
//     网络、卷、本轮唯一 image tag 各自成阶段，一个阶段失败不阻断其余，全部
//     问题聚合成 residue 返回（signal handler 也必须打印它，不得丢弃）；
//   - cleanup 之后**独立复查** container / network / named volume / 匿名悬挂卷 /
//     image tag / Secret 目录六类，复查本身同样 fail closed。
//
// 每次 smoke/probe 运行使用**唯一 image tag**（`meal-agent-api:m3b-<run id>`），
// 通过临时 Compose override 注入，因此并行 worktree/project 不会互相覆盖；
// build 之后读取 immutable image ID 并绑定到三个 API 镜像服务的 `.Image`。
import { existsSync, lstatSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { runCommand } from './m3b-subprocess.mjs'

/** 唯一 image tag 的固定前缀：cleanup 只删这一形状的本轮 tag。 */
export const runImageTagPrefix = 'meal-agent-api:m3b-'

export const runImageTagFor = (runId) => `${runImageTagPrefix}${runId}`

const ownedOverrideInodes = new Map()

/** 唯一 tag 的临时 Compose override（三个 API 镜像服务共用同一个 tag）。 */
export const writeImageOverride = (path, imageTag) => {
  writeFileSync(
    path,
    '# 阶段 09A / M3B：**临时** override，只把三个 API 镜像服务的 image tag 换成\n' +
      '# 本轮唯一值。默认拓扑（M2B 已 Accepted）因此保持不变，而并行 worktree /\n' +
      '# project 不会互相覆盖同一个全局 tag。用后即删。\n' +
      'services:\n' +
      `  api:\n    image: ${imageTag}\n` +
      `  migrate:\n    image: ${imageTag}\n` +
      `  bootstrap-schema:\n    image: ${imageTag}\n`,
    { flag: 'wx', mode: 0o600 }
  )
  const identity = inodeIdentityOf(path)
  ownedOverrideInodes.set(path, identity)
  return identity
}

/**
 * 取一个**刚由本轮创建**的路径的 inode 身份（`mkdtemp` 之后立即调用）。
 * BigInt 形态：默认的 double 在大 inode 号上会丢精度，而丢精度的比较等于把
 * 「不是我的目录」判成「是我的」。
 */
export const inodeIdentityOf = (path) => {
  const stats = lstatSync(path, { bigint: true })
  return { dev: stats.dev, ino: stats.ino }
}

export class DockerEvidenceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DockerEvidenceError'
  }
}

/** 执行一条 docker 命令并要求退出码为 0；否则抛 DockerEvidenceError。 */
export const dockerStrict = async (args, { timeoutMs = 120_000, env } = {}) => {
  const result = await runCommand(args, { timeoutMs, env })
  if (result.status !== 0) {
    throw new DockerEvidenceError(
      `${args.join(' ')} exited ${String(result.status ?? `signal ${result.signal}`)}: ` +
        `${result.stderr.trim().split('\n').slice(-2).join(' / ') || '(no stderr)'}`
    )
  }
  return result
}

/**
 * `docker inspect --format` 的严格读取：读不到即抛，不返回默认值。
 *
 * **退出 0 但 stdout 为空同样算读不到**。模板求值给出空串的原因可能是字段不
 * 存在、daemon 返回了非预期结构，或 PATH 上有个只会 `exit 0` 的 shim；无论
 * 哪一种，把它交给调用方都会变成一条伪造的阴性证据——`Number('')` 是 0，于是
 * 「读不到退出码」会被记成「这一步退出码为 0」。要显式接受空串的调用方必须
 * 传 `allowEmpty: true`，并自己给出具名判定。
 */
export const inspectStrict = async (target, format, { env, allowEmpty = false } = {}) => {
  const result = await dockerStrict(
    ['docker', 'inspect', '--format', format, target],
    { env }
  )
  const value = result.stdout.trim()
  if (value === '' && !allowEmpty) {
    throw new DockerEvidenceError(
      `docker inspect ${target} ${format} exited 0 but printed nothing; ` +
        'an unreadable field must not be read as an empty or zero one'
    )
  }
  return value
}

/**
 * 把 `{{.State.ExitCode}}` 的文本解析成退出码。**只接受规范的非负十进制整数**。
 *
 * `Number()` 会把 `''`、`'  '`、`'\n'` 变成 0，把 `'+3'`/`'1.0'`/`'1e3'`/`'0x10'`
 * 变成数字——这些形态里没有一个是 docker 真实打印的退出码，而其中第一类恰好
 * 会把「读不到」伪装成「成功」。因此先按文法判定，再确认它落在安全整数范围内
 * （超出 2^53 的字面量在 double 上会失真）。
 */
export const parseInspectedExitCode = (raw) => {
  const text = String(raw ?? '')
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    return { ok: false, reason: 'not a canonical non-negative decimal integer' }
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: 'outside the safe integer range' }
  }
  return { ok: true, value }
}

/**
 * docker CLI 「这个对象不存在」的**唯一**判据，三处调用点共用
 * （`imageIdOf`、反例套件的 container presence、信号窗口的 per-run tag 复查）。
 *
 * 判定对**整串** `stderr.trim()` 做锚定匹配，且**不带 `m` 标志**。但仅仅去掉
 * `m` 是不够的：`\s` 本身就跨行，于是
 *
 *   Error response from daemon:\nNo such image: <tag>
 *   No such image:\n<tag>
 *
 * 这类**内嵌换行**的两行 stderr 仍然会整串匹配成功，被读成「资源不存在」。
 * 因此这里做两件事：
 *
 *   1. `trim()` 之后**只要还含 CR 或 LF 就直接判 false**——docker 的
 *      「找不到对象」永远是**单行**；多行意味着还有别的信息，不能当成不存在；
 *   2. 正则内部**不使用任何可跨行的 `\s`**，只允许必要的**水平**空白
 *      `[ \t]*`。
 *
 * 调用方还必须自己确认退出码恰好是 1——只有那一个组合才是 docker 的
 * 「找不到对象」。本函数只返回布尔值，不构造任何含外部内容的消息。
 */
export const isAbsenceMessage = (stderr, { kind, name }) => {
  const raw = String(stderr ?? '')
  // Docker CLI 可以在唯一一行诊断后带一个 LF；除此之外任何前导/额外换行、
  // CR 或空白包装都不是 canonical absence evidence。不能先 trim()，否则证据
  // 包装会在判定前被抹掉。
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  if (/[\r\n]/.test(line)) {
    return false
  }
  const noun = kind === 'image' ? 'image' : kind === 'container' ? '(?:container|object)' : 'object'
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `^(?:[Ee]rror(?: response from daemon)?:[ \\t]*)?[Nn]o such ${noun}:?[ \\t]*${escaped}$`
  )
  return pattern.test(line)
}

/** 严格读取一段 JSON 形态的 inspect 字段（空 payload 由 inspectStrict 拒绝）。 */
export const inspectJsonStrict = async (target, format, { env } = {}) => {
  const raw = await inspectStrict(target, format, { env })
  try {
    return JSON.parse(raw)
  } catch {
    throw new DockerEvidenceError(
      `docker inspect ${target} ${format} did not return valid JSON`
    )
  }
}

/** 按 project label 列出资源；退出码非 0 即抛。 */
export const listByProject = async (kind, project, { env } = {}) => {
  const base =
    kind === 'container'
      ? ['docker', 'ps', '-aq']
      : kind === 'network'
        ? ['docker', 'network', 'ls', '-q']
        : ['docker', 'volume', 'ls', '-q']
  const result = await dockerStrict(
    [...base, '--filter', `label=com.docker.compose.project=${project}`],
    { env }
  )
  return result.stdout.split('\n').filter(Boolean)
}

/** 当前悬挂（无主）匿名卷集合；退出码非 0 即抛。 */
export const danglingVolumes = async ({ env } = {}) => {
  const result = await dockerStrict(['docker', 'volume', 'ls', '-qf', 'dangling=true'], { env })
  return new Set(result.stdout.split('\n').filter(Boolean))
}

/**
 * 某个 image tag 是否存在（存在返回 image ID，不存在返回 null）。
 *
 * 这是**全仓唯一**允许把非零退出解释成「资源不存在」的地方，因此判据收得很紧：
 *
 *   - 退出码必须**恰好是 1**（docker CLI 的「找不到对象」）。`status === null`
 *     表示 CLI 自己被信号杀掉，绝不是「镜像不存在」；
 *   - stderr 必须整串匹配 `isAbsenceMessage`（锚定、**不带 `m` 标志**），而不是
 *     任意位置出现 "no such image" 字样——被包装的多行错误、带前缀或后缀的
 *     错误、PATH 上的 shim 回显、或一条关于**另一个**镜像的消息都不算数；
 *   - 其余一律抛出。
 */
export const imageIdOf = async (tag, { env } = {}) => {
  const result = await runCommand(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', tag],
    { env }
  )
  if (result.status === 0) {
    // Docker 的成功证据必须是**一行 canonical immutable ID**。`trim()` 会把空白、
    // CRLF 与多行包装都规范化掉，使调用方随后把任意 status-0 stdout 当成 image
    // identity 传给 inspect/create/cleanup。只容许 CLI 常见的一个末尾 LF；其余 framing
    // 与非 sha256 identity 一律固定理由 fail closed。
    const match = /^(sha256:[0-9a-f]{64})\n?$/.exec(result.stdout)
    if (match === null) {
      throw new DockerEvidenceError('docker image inspect returned an invalid image ID')
    }
    return match[1]
  }
  if (result.status === 1 && isAbsenceMessage(result.stderr, { kind: 'image', name: tag })) {
    return null
  }
  throw new DockerEvidenceError(
    `docker image inspect evidence failed (${
      result.status === null ? `on signal ${String(result.signal)}` : String(result.status)
    })`
  )
}

/**
 * 分阶段 scoped cleanup。stages 之间互不阻断，全部问题聚合进 residue。
 *
 * 顺序是刻意的：**明文 Secret 目录最先删**（Docker 侧任何失败都不允许把它
 * 留在盘上），随后 compose down，再按 label 逐类兜底，最后删本轮唯一 tag。
 *
 * project / secretsDirectory / imageTag 三者都有形状约束，范围外一律拒绝，
 * 且拒绝本身记入 residue 而不是静默跳过。
 */
let cleanupChain = Promise.resolve()

/**
 * cleanup 串行化：信号处置与主流程的 finally 可能同时到达，两次并发的
 * `docker rm` 会互相看到「资源刚刚消失」的中间态。这里把它们排成一条链，
 * 第二次执行只会发现已经干净。
 */
export const cleanupRun = (options) => {
  const next = cleanupChain.then(
    () => cleanupRunUnsynchronized(options),
    () => cleanupRunUnsynchronized(options)
  )
  cleanupChain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

const cleanupRunUnsynchronized = async ({
  project,
  projectPattern,
  secretsDirectory = null,
  secretsIdentity = null,
  secretsPrefix,
  imageTag = null,
  overridePath = null,
  composeFile,
  composeEnvironment = process.env,
  composeArgs = [],
  danglingBaseline = null,
  realpath
}) => {
  const residue = []
  const stage = async (label, run) => {
    try {
      await run()
    } catch (error) {
      residue.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  // 阶段 1：明文 Secret 目录（**最先**，而且**先于** project 形状校验）。
  // 否则「project 名不合规」会连带把明文凭据留在盘上——注释承诺的是「Docker
  // 侧任何失败都不允许把它留在盘上」，project 校验也属于这一类。
  await stage('secrets-directory', async () => {
    if (secretsDirectory === null) {
      return
    }
    // 目录已被上一次 cleanup 删掉时不算问题：串行化之后第二次执行本来就该
    // 「发现已经干净」。realpath 对不存在路径会抛 ENOENT，必须先判存在性。
    if (!existsSync(secretsDirectory)) {
      return
    }
    const realDir = realpath(secretsDirectory)
    // 守卫必须是「系统 tmpdir 下的该前缀开头」，不是无锚点的 includes：
    // `/Users/x/notes/meal-agent-m3b-secrets-archive` 这类路径不得被删。
    const expectedPrefix = resolve(realpath(tmpdir()), secretsPrefix)
    if (!realDir.startsWith(expectedPrefix)) {
      throw new DockerEvidenceError(
        `${secretsDirectory} is not a ${secretsPrefix}* directory under the system tmpdir`
      )
    }
    // **inode 身份复核**：路径与前缀都对，不代表它还是本轮 mkdtemp 出来的那个
    // 目录。递归删除是不可逆操作，必须先确认它仍指向本轮创建的那个 inode；
    // 对不上就报 ownership drift 并原样留下，绝不递归删别人的目录。
    if (secretsIdentity !== null) {
      const observed = lstatSync(realDir, { bigint: true })
      if (
        observed.dev !== secretsIdentity.dev ||
        observed.ino !== secretsIdentity.ino
      ) {
        throw new DockerEvidenceError(
          'ownership drift at the temporary secrets directory: it no longer refers ' +
            'to the inode this run created; refusing to remove it recursively'
        )
      }
    }
    rmSync(realDir, { recursive: true, force: true })
  })

  if (typeof project !== 'string' || !projectPattern.test(project)) {
    // 记成 residue 而不是 throw：裸 throw 会把阶段 1（明文 Secret 目录）已经
    // 收集到的失败一起丢掉，而那正是最不能丢的一条。
    residue.push(
      `cleanup refused: project name ${JSON.stringify(project)} is outside the ` +
        'meal-agent-m3b-* smoke scope'
    )
    return residue
  }

  // 阶段 2：compose down（退出码检查，失败不阻断后面的 label sweep）。
  // 若 override 已被**上一次** cleanup 的阶段 7 删掉，这里就不能再引用它——
  // 否则 compose 会以 "no such file" 失败并产出一条假 residue。
  const effectiveComposeArgs = []
  for (let index = 0; index < composeArgs.length; index += 1) {
    const argument = composeArgs[index]
    if (argument === '--file' && index + 1 < composeArgs.length) {
      const file = composeArgs[index + 1]
      if (!existsSync(file)) {
        index += 1
        continue
      }
    }
    effectiveComposeArgs.push(argument)
  }
  await stage('compose-down', async () => {
    await dockerStrict(
      [
        'docker',
        'compose',
        '--file',
        composeFile,
        ...effectiveComposeArgs,
        '--profile',
        'bootstrap',
        '--project-name',
        project,
        'down',
        '--volumes',
        '--remove-orphans'
      ],
      { timeoutMs: 300_000, env: composeEnvironment }
    )
  })

  // 阶段 3—5：容器 / 网络 / 卷。每类：列出 → 逐个复核 label → 删除 → 再列一次。
  const sweeps = [
    { kind: 'container', remove: (ids) => ['docker', 'rm', '-f', '-v', ...ids], inspect: (id) => ['docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', id] },
    { kind: 'network', remove: (ids) => ['docker', 'network', 'rm', ...ids], inspect: (id) => ['docker', 'network', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', id] },
    { kind: 'volume', remove: (ids) => ['docker', 'volume', 'rm', '-f', ...ids], inspect: (id) => ['docker', 'volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', id] }
  ]
  for (const sweep of sweeps) {
    await stage(`${sweep.kind}-sweep`, async () => {
      const identifiers = await listByProject(sweep.kind, project, { env: composeEnvironment })
      for (const id of identifiers) {
        const label = await dockerStrict(sweep.inspect(id), { env: composeEnvironment })
        if (label.stdout.trim() !== project) {
          throw new DockerEvidenceError(
            `a listed ${sweep.kind} does not carry the project label ${project}`
          )
        }
      }
      if (identifiers.length > 0) {
        await dockerStrict(sweep.remove(identifiers), {
          timeoutMs: 300_000,
          env: composeEnvironment
        })
      }
      const remaining = await listByProject(sweep.kind, project, { env: composeEnvironment })
      if (remaining.length > 0) {
        throw new DockerEvidenceError(
          `${String(remaining.length)} ${sweep.kind}(s) remain after removal`
        )
      }
    })
  }

  // 阶段 6：本轮唯一 image tag（只删这一个 tag，并复核已消失）。
  await stage('image-tag', async () => {
    if (imageTag === null) {
      return
    }
    if (!imageTag.startsWith(runImageTagPrefix)) {
      throw new DockerEvidenceError(
        `refusing to remove ${imageTag}: not a per-run ${runImageTagPrefix}* tag`
      )
    }
    if ((await imageIdOf(imageTag, { env: composeEnvironment })) !== null) {
      await dockerStrict(['docker', 'image', 'rm', imageTag], {
        env: composeEnvironment
      })
    }
    if ((await imageIdOf(imageTag, { env: composeEnvironment })) !== null) {
      throw new DockerEvidenceError(`${imageTag} still exists after removal`)
    }
  })

  // 阶段 7：临时 Compose override。它是**正式阶段**（不是随手 rm）：必须排在
  // compose down 之后（down 还要用它解析配置），并进入下面的 residue 复查。
  await stage('compose-override', async () => {
    if (overridePath === null) {
      return
    }
    if (!existsSync(overridePath)) {
      ownedOverrideInodes.delete(overridePath)
      return
    }
    const expectedIdentity = ownedOverrideInodes.get(overridePath)
    const observed = lstatSync(overridePath, { bigint: true })
    if (
      expectedIdentity === undefined ||
      observed.dev !== expectedIdentity.dev ||
      observed.ino !== expectedIdentity.ino
    ) {
      throw new DockerEvidenceError(
        'ownership drift at the temporary compose override; refusing to remove it'
      )
    }
    rmSync(overridePath, { force: false })
    if (existsSync(overridePath)) {
      throw new DockerEvidenceError('the temporary compose override still exists')
    }
    ownedOverrideInodes.delete(overridePath)
  })

  // 阶段 8：匿名悬挂卷前后对照（匿名卷不带 project label，label sweep 看不见）。
  await stage('dangling-volumes', async () => {
    if (danglingBaseline === null) {
      return
    }
    const now = await danglingVolumes({ env: composeEnvironment })
    const added = [...now].filter((id) => !danglingBaseline.has(id))
    if (added.length > 0) {
      throw new DockerEvidenceError(
        `${String(added.length)} anonymous dangling volume(s) appeared during this run: ${added.join(', ')}`
      )
    }
  })

  return residue
}

/**
 * cleanup 之后的**独立复查**：六类逐项确认为空/消失。它不复用 cleanup 的中间
 * 结果，全部重新查询，且每一次查询都 fail closed。
 */
export const verifyNoResidue = async ({
  project,
  imageTag = null,
  secretsDirectory = null,
  overridePath = null,
  danglingBaseline = null,
  composeEnvironment = process.env,
  exists
}) => {
  const problems = []
  for (const kind of ['container', 'network', 'volume']) {
    try {
      const remaining = await listByProject(kind, project, { env: composeEnvironment })
      if (remaining.length > 0) {
        problems.push(`${kind}(s) still present: ${remaining.join(', ')}`)
      }
    } catch (error) {
      problems.push(
        `${kind} recheck failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (imageTag !== null) {
    try {
      if ((await imageIdOf(imageTag, { env: composeEnvironment })) !== null) {
        problems.push(`image tag ${imageTag} still present`)
      }
    } catch (error) {
      problems.push(
        `image tag recheck failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (danglingBaseline !== null) {
    try {
      const now = await danglingVolumes({ env: composeEnvironment })
      const added = [...now].filter((id) => !danglingBaseline.has(id))
      if (added.length > 0) {
        problems.push(`anonymous dangling volume(s) still present: ${added.join(', ')}`)
      }
    } catch (error) {
      problems.push(
        `dangling volume recheck failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (secretsDirectory !== null && exists(secretsDirectory)) {
    problems.push('the temporary secrets directory still exists')
  }
  if (overridePath !== null && exists(overridePath)) {
    problems.push('the temporary compose override still exists')
  }
  return problems
}

/** 临时 override 文件的删除（用后即删，失败只记 residue）。 */
export const discardOverride = (path) => {
  try {
    if (!existsSync(path)) {
      ownedOverrideInodes.delete(path)
      return
    }
    const expectedIdentity = ownedOverrideInodes.get(path)
    const observed = lstatSync(path, { bigint: true })
    if (
      expectedIdentity === undefined ||
      observed.dev !== expectedIdentity.dev ||
      observed.ino !== expectedIdentity.ino
    ) {
      return
    }
    rmSync(path, { force: false })
    ownedOverrideInodes.delete(path)
  } catch {
    // 尽力而为。
  }
}

export const overridePathFor = (directory, runId) =>
  resolve(directory, `.m3b-image-override-${runId}.yaml`)
