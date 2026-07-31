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
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { runCommand } from './m3b-subprocess.mjs'

/** 唯一 image tag 的固定前缀：cleanup 只删这一形状的本轮 tag。 */
export const runImageTagPrefix = 'meal-agent-api:m3b-'

export const runImageTagFor = (runId) => `${runImageTagPrefix}${runId}`

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
    { mode: 0o600 }
  )
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

/** `docker inspect --format` 的严格读取：读不到即抛，不返回默认值。 */
export const inspectStrict = async (target, format, { env } = {}) => {
  const result = await dockerStrict(
    ['docker', 'inspect', '--format', format, target],
    { env }
  )
  return result.stdout.trim()
}

/** 严格读取一段 JSON 形态的 inspect 字段。 */
export const inspectJsonStrict = async (target, format, { env } = {}) => {
  const raw = await inspectStrict(target, format, { env })
  try {
    return JSON.parse(raw === '' ? 'null' : raw)
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

/** 某个 image tag 是否存在（存在返回 image ID，不存在返回 null）。 */
export const imageIdOf = async (tag, { env } = {}) => {
  const result = await runCommand(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', tag],
    { env }
  )
  if (result.status === 0) {
    return result.stdout.trim()
  }
  // 只有「镜像不存在」才允许非零退出；其余情形（daemon 不可达等）必须抛。
  if (/No such image|no such image/.test(result.stderr)) {
    return null
  }
  throw new DockerEvidenceError(
    `docker image inspect ${tag} exited ${String(result.status)}: ` +
      `${result.stderr.trim().split('\n').slice(-1)[0] ?? '(no stderr)'}`
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
  secretsPrefix,
  imageTag = null,
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
    rmSync(realDir, { recursive: true, force: true })
  })

  if (typeof project !== 'string' || !projectPattern.test(project)) {
    throw new DockerEvidenceError(
      `cleanup refused: project name ${JSON.stringify(project)} is outside the ` +
        'meal-agent-m3b-* smoke scope'
    )
  }

  // 阶段 2：compose down（退出码检查，失败不阻断后面的 label sweep）。
  await stage('compose-down', async () => {
    await dockerStrict(
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
        'down',
        '--volumes',
        '--remove-orphans'
      ],
      { timeoutMs: 300_000, env: composeEnvironment }
    )
  })

  // 阶段 3—5：容器 / 网络 / 卷。每类：列出 → 逐个复核 label → 删除 → 再列一次。
  const sweeps = [
    { kind: 'container', remove: (ids) => ['docker', 'rm', '-f', '-v', ...ids], labelFormat: '{{index .Config.Labels "com.docker.compose.project"}}', inspect: (id) => ['docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', id] },
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

  // 阶段 7：匿名悬挂卷前后对照（匿名卷不带 project label，label sweep 看不见）。
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
  return problems
}

/** 临时 override 文件的删除（用后即删，失败只记 residue）。 */
export const discardOverride = (path) => {
  try {
    rmSync(path, { force: true })
  } catch {
    // 尽力而为。
  }
}

export const overridePathFor = (directory, runId) =>
  resolve(directory, `.m3b-image-override-${runId}.yaml`)
