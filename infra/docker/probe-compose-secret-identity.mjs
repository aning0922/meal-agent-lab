#!/usr/bin/env node
// 阶段 09A / M3B 第一步：真实 Compose Secret 的容器内 UID/mode 行为探针。
//
//   node infra/docker/probe-compose-secret-identity.mjs
//
// M3A 的消费判据要求 secret file 在**消费进程**看来：owner == 进程 EUID、
// mode 为 owner-only 的 0400/0600、普通文件、nlink=1、非 symlink、可读。
// file-backed Compose secret 本身是 bind mount，无法在原生 Linux 上做
// uid/gid/mode remap。生产拓扑先由 secret-materializer 把八份值分别写入
// project-scoped volume，再以消费者 UID 的 0600 文件挂载。本探针必须从
// **真实消费服务的 materialized volume**内取证，宿主 stat 不作数。
//
// 本探针用一套**临时合成** bundle（真实 generator 生成，用后即删）与唯一
// project name，把八份 secret 逐一挂进它们真实的消费服务里，在容器内检查：
//
//   UID 999：postgres_superuser_password（postgres）、postgres_admin.pgpass、
//            meal_agent_{migration,runtime,backup}_password（bootstrap-logins）
//   UID 10001：meal_agent_admin_database_url（bootstrap-schema）、
//              meal_agent_migration_database_url（migrate）、
//              meal_agent_runtime_database_url（api）
//
// 任何一条不满足即失败退出。失败与成功都会执行 scoped cleanup：只处理本次
// project 的 container/network/volume 与临时 secret 目录。
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateAndPreflight } from './generate-local-test-secrets.mjs'
import {
  assertCanonicalSecretProbePlan,
  canonicalSecretProbePlan,
  repositoryRoot,
  secretFiles
} from './local-test-secrets-contract.mjs'
import {
  buildApiImage,
  cleanupRun,
  inodeIdentityOf,
  danglingVolumes,
  inspectJsonStrict,
  listByProject,
  overridePathFor,
  runImageTagFor,
  verifyNoResidue,
  writeImageOverride
} from './m3b-docker.mjs'
import { composeRunOneOff } from './m4-lifecycle.mjs'
import { installSignalHandlers, runCommand, terminationSignal } from './m3b-subprocess.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')
/** probe 的 cleanup 范围：只认自己的 project 形状。 */
const probeProjectPattern = /^meal-agent-m3b-probe-[a-z0-9]+$/
const probeSecretsPrefix = 'meal-agent-m3b-probe-'

/** 每份 secret 在哪个服务里被消费（与 compose.local-test.yaml 的 secrets 一致）。 */
const probePlan = canonicalSecretProbePlan
assertCanonicalSecretProbePlan(probePlan)

const consumerUidOf = (secretName) => {
  const entry = secretFiles.find((candidate) => candidate.name === secretName)
  if (entry === undefined) {
    throw new Error(`unknown secret in probe plan: ${secretName}`)
  }
  return entry.consumerUid
}

const failures = []
const evidence = []

// 异步 spawn（自成进程组、有超时）：事件循环保持存活，信号可被真实处理。
const run = (args, options = {}) => runCommand(args, options)

// bash 侧（postgres 镜像，GNU stat）：每个文件输出一行固定格式的 PROBE 记录。
// 刻意不用 eval：stat 失败时 eval 空串会静默沿用上一个文件的取值。三个字段
// 各自独立赋值，任何一次 stat 失败都会在 set -e 下让整个探针以非零退出。
// readable 的判据与 node 侧一致：**读到至少 1 个字节**（空文件不算可读）。
const bashProbeScript = (targets) => `
set -euo pipefail
euid="$(id -u)"
for f in ${targets.join(' ')}; do
  if [ -L "$f" ]; then
    echo "PROBE $f SYMLINK"
    exit 1
  fi
  uid="$(stat -c '%u' "$f")"
  mode="$(stat -c '%04a' "$f")"
  nlink="$(stat -c '%h' "$f")"
  case "$(stat -c '%F' "$f")" in
    "regular file") regular=yes ;;
    *) regular=no ;;
  esac
  if [ -s "$f" ] && head -c 1 "$f" > /dev/null; then readable=yes; else readable=no; fi
  echo "PROBE $f euid=$euid uid=$uid mode=$mode nlink=$nlink regular=$regular readable=$readable symlink=no"
done
`

// node 侧（API 镜像）：同一格式。O_NOFOLLOW|O_NONBLOCK 打开后 fstat，与消费
// 实现同一条打开路径。
const nodeProbeScript = (targets) => `
const fs = require('node:fs');
const euid = process.geteuid();
for (const f of ${JSON.stringify(targets)}) {
  const l = fs.lstatSync(f);
  if (l.isSymbolicLink()) { console.log('PROBE ' + f + ' SYMLINK'); process.exit(1); }
  const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const s = fs.fstatSync(fd);
  const b = Buffer.alloc(1);
  const readable = fs.readSync(fd, b, 0, 1, null) === 1 ? 'yes' : 'no';
  fs.closeSync(fd);
  console.log('PROBE ' + f + ' euid=' + euid + ' uid=' + s.uid +
    ' mode=' + (s.mode & 0o7777).toString(8).padStart(4, '0') +
    ' nlink=' + s.nlink + ' regular=' + (s.isFile() ? 'yes' : 'no') +
    ' readable=' + readable + ' symlink=no');
}
`

const probeRecordPattern =
  /^PROBE (\S+) euid=([0-9]+) uid=([0-9]+) mode=([0-7]{4}) nlink=([0-9]+) regular=(yes|no) readable=(yes|no) symlink=(yes|no)$/

export const maximumProbeEvidenceBytes = 16 * 1024
const maximumProbeRecordBytes = 2 * 1024

/**
 * 把容器 stdout 解释成一个**闭合协议**，而不是从任意文本里捞出看起来像 PROBE 的行。
 * 字段名、顺序、数量、record 数量与 path 集合全部精确；未知/重复字段、额外文本、
 * 重复/缺失/额外 path 都用同一个固定异常拒绝，绝不把原始输出带进诊断。
 */
export const parseProbeEvidence = (stdout, expectedPaths) => {
  const invalid = () => {
    throw new Error('invalid probe evidence protocol')
  }
  if (
    typeof stdout !== 'string' ||
    Buffer.byteLength(stdout) > maximumProbeEvidenceBytes ||
    !Array.isArray(expectedPaths) ||
    expectedPaths.length === 0 ||
    expectedPaths.length > 8
  ) {
    invalid()
  }
  const framed = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
  const lines = framed.split('\n')
  if (
    lines.length !== expectedPaths.length ||
    lines.some(
      (line) => line.length === 0 || Buffer.byteLength(line) > maximumProbeRecordBytes
    )
  ) {
    invalid()
  }
  const expected = new Set(expectedPaths)
  if (expected.size !== expectedPaths.length) invalid()
  const byPath = new Map()
  for (const line of lines) {
    const match = probeRecordPattern.exec(line)
    if (match === null || !expected.has(match[1]) || byPath.has(match[1])) {
      invalid()
    }
    byPath.set(match[1], {
      euid: match[2],
      uid: match[3],
      mode: match[4],
      nlink: match[5],
      regular: match[6],
      readable: match[7],
      symlink: match[8]
    })
  }
  if (byPath.size !== expected.size) invalid()
  return byPath
}

/** CLI 信号处置读取的现场登记（正常、失败、信号三条路径共用同一套 cleanup）。 */
const activeProbeScene = {
  project: null,
  secretsDirectory: null,
  secretsIdentity: null,
  imageTag: null,
  imageId: null,
  runClaimToken: null,
  overridePath: null,
  composeEnvironment: process.env,
  composeArgs: [],
  danglingBaseline: null
}

/** probe 的 scoped cleanup：与 smoke 共用 m3b-docker 的分阶段收集器。 */
const cleanupProbe = async (scene) =>
  cleanupRun({
    project: scene.project,
    projectPattern: probeProjectPattern,
    secretsDirectory: scene.secretsDirectory,
    // 递归删除前复核 inode 身份：路径对不代表还是本轮 mkdtemp 出来的目录。
    secretsIdentity: scene.secretsIdentity ?? null,
    secretsPrefix: probeSecretsPrefix,
    imageTag: scene.imageTag,
    imageId: scene.imageId,
    runClaimToken: scene.runClaimToken,
    // override 只在**确实创建过**时才交给 cleanup（P1-4）：未创建时引用它会
    // 让 compose down 以 "no such file" 失败并被报成 residue。
    overridePath: scene.overrideCreated === true ? scene.overridePath : null,
    composeFile,
    composeEnvironment: scene.composeEnvironment,
    composeArgs: scene.overrideCreated === true ? scene.composeArgs : [],
    // 匿名悬挂卷同样是六类残留之一：postgres 镜像自带 VOLUME。
    danglingBaseline: scene.danglingBaseline,
    realpath: realpathSync
  })

const main = async () => {
  const runId = randomBytes(6).toString('hex')
  const runClaimToken = randomBytes(16).toString('hex')
  const project = `meal-agent-m3b-probe-${runId}`
  const imageTag = runImageTagFor(runId)
  const overridePath = overridePathFor(composeDirectory, runId)
  const secretsDirectory = mkdtempSync(resolve(tmpdir(), probeSecretsPrefix))
  const secretsIdentity = inodeIdentityOf(secretsDirectory)
  // **第一个资源刚创建就登记现场**（P1-4）：下面的 `await danglingVolumes()`
  // 是一次真实 Docker 查询，信号可以落在它期间。override 此刻尚未创建。
  Object.assign(activeProbeScene, {
    project,
    secretsDirectory,
    secretsIdentity,
    imageTag: null,
    imageId: null,
    runClaimToken,
    overridePath: null,
    overrideCreated: false,
    composeEnvironment: { ...process.env, MEAL_AGENT_SECRETS_DIR: secretsDirectory },
    composeArgs: [],
    danglingBaseline: null
  })
  let danglingBaseline = null
  const composeEnvironment = {
    ...process.env,
    MEAL_AGENT_SECRETS_DIR: secretsDirectory,
    MEAL_AGENT_API_HOST_PORT: '3000'
  }
  const composeArgs = ['--file', overridePath]
  Object.assign(activeProbeScene, {
    project,
    secretsDirectory,
    secretsIdentity,
    // imageTag / override 在 writeImageOverride 之后才登记。
    imageTag: null,
    overridePath,
    overrideCreated: false,
    composeEnvironment,
    composeArgs: [],
    danglingBaseline
  })
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
      { cwd: composeDirectory, env: composeEnvironment, ...options }
    )

  process.stdout.write(`probe project: ${project}\n`)
  process.stdout.write(`temporary secrets: ${secretsDirectory}\n`)

  // 任何抛出都先记进 failures 再走 finally 的 cleanup：抛错路径绝不能把
  // cleanup residue 与 verifyNoResidue 的结果一起吞掉（此前 build 失败时
  // 操作者只看到一条 build 错误，残留报告完全丢失）。
  try {
    // baseline 查询放进 try 内（P1-4）：dockerStrict 按设计会抛，放在 try 外
    // 会把刚建好的明文 Secret 目录留在盘上且不报 residue。
    danglingBaseline = await danglingVolumes()
    activeProbeScene.danglingBaseline = danglingBaseline

    generateAndPreflight(secretsDirectory)

    // BuildKit 构建期不发布可变 tag；取得 immutable ID 后才生成 override。
    const builtImageId = await buildApiImage({
      imageTag,
      repositoryRoot,
      env: composeEnvironment
    })
    activeProbeScene.imageId = builtImageId
    writeImageOverride(overridePath, builtImageId, runClaimToken)
    activeProbeScene.overrideCreated = true
    activeProbeScene.imageTag = imageTag
    activeProbeScene.composeArgs = composeArgs
    process.stdout.write(`built immutable image ${builtImageId}\n`)

    // 先跑真实 materializer；下面的 `run --no-deps` 只能看到已经物化
    // 的单份 volume，绝不直接挂宿主 source secret。
    const materialized = await compose(
      [
        'up',
        '--no-deps',
        '--abort-on-container-exit',
        '--exit-code-from',
        'secret-materializer',
        'secret-materializer'
      ],
      { timeoutMs: 300_000 }
    )
    if (materialized.status !== 0) {
      throw new Error('secret materialization failed before the identity probe')
    }
    const materializerIds = await listByProject('container', project, {
      env: composeEnvironment,
      claimToken: runClaimToken
    })
    const materializerMatches = []
    for (const id of materializerIds) {
      const container = await inspectJsonStrict(id, '{{json .}}', { env: composeEnvironment })
      const labels = container?.Config?.Labels
      if (labels?.['com.docker.compose.service'] === 'secret-materializer') {
        if (
          container?.Id !== id ||
          container?.State?.Status !== 'exited' ||
          container?.State?.ExitCode !== 0
        ) {
          throw new Error('secret materializer immutable outcome evidence was invalid')
        }
        materializerMatches.push(id)
      }
    }
    if (materializerMatches.length !== 1) {
      throw new Error('secret materializer generation evidence was not unique')
    }
    process.stdout.write('secret materializer completed with immutable outcome evidence\n')

    for (const plan of probePlan) {
      // 信号在飞时**不再新建容器**（成功分支同样要检查——此前只在失败分支里
      // 检查，信号落在两次 compose run 之间时仍会 spawn 出无人回收的容器）。
      if (terminationSignal() !== null) {
        break
      }
      const targets = plan.secrets.map((name) => `/run/secrets/${name}/value`)
      const runArgs =
        plan.runtime === 'bash'
          ? ['--entrypoint', 'bash', plan.service, '-c', bashProbeScript(targets)]
          : ['--entrypoint', 'node', plan.service, '-e', nodeProbeScript(targets)]
      let result
      try {
        result = await composeRunOneOff(
          { compose, run, environment: composeEnvironment },
          runArgs,
          { timeoutMs: 300_000, project, service: plan.service }
        )
      } catch {
        failures.push(
          `${plan.service}: in-container probe failed`
        )
        // 信号在飞时**立即停止**创建新容器：否则 handler 已经跑完 label
        // sweep，这里再 spawn 出来的容器无人回收。
        if (terminationSignal() !== null) {
          break
        }
        continue
      }
      const expectedPaths = plan.secrets.map(
        (secretName) => `/run/secrets/${secretName}/value`
      )
      let byPath
      try {
        byPath = parseProbeEvidence(result.stdout, expectedPaths)
      } catch {
        failures.push(`${plan.service}: in-container probe returned an invalid evidence protocol`)
        continue
      }
      for (const secretName of plan.secrets) {
        const target = `/run/secrets/${secretName}/value`
        const fields = byPath.get(target)
        const expectedUid = String(consumerUidOf(secretName))
        if (fields === undefined) {
          failures.push(`${plan.service}: an expected probe record is missing`)
          continue
        }
        const checks = [
          ['euid', expectedUid],
          ['uid', expectedUid],
          ['nlink', '1'],
          ['regular', 'yes'],
          ['readable', 'yes'],
          ['symlink', 'no']
        ]
        for (const [key, expected] of checks) {
          if (fields[key] !== expected) {
            failures.push(`${plan.service}: a Secret identity field drifted`)
          }
        }
        if (fields.mode !== '0400' && fields.mode !== '0600') {
          failures.push(`${plan.service}: Secret mode is not owner-only 0400 or 0600`)
        }
        evidence.push(
          `${plan.service} (uid ${expectedUid}): ${target} ` +
            `uid=${fields.uid} mode=${fields.mode} nlink=${fields.nlink} ` +
            `regular=${fields.regular} readable=${fields.readable} symlink=${fields.symlink}`
        )
      }
    }
  } catch {
    failures.push('Compose secret identity probe evidence collection failed')
  } finally {
    // 正常、失败与信号三条路径复用**同一套** scoped cleanup + 独立复查。
    // override 必须**在 cleanup 之后**删除：`compose down` 仍要用它解析配置。
    // 信号在飞时整段交给处置：主流程既不重复 cleanup 也不删 override。
    if (terminationSignal() !== null) {
      process.stderr.write('signal in flight: cleanup is owned by the signal handler\n')
      return
    }
    try {
      const cleanupResidue = await cleanupProbe(activeProbeScene)
      if (cleanupResidue.length > 0) {
        failures.push(`probe scoped cleanup left ${String(cleanupResidue.length)} residue item(s)`)
      }
    } catch {
      failures.push('probe scoped cleanup failed')
    }
    try {
      const residue = await verifyNoResidue({
          project,
          imageTag: activeProbeScene.imageTag,
          imageId: activeProbeScene.imageId,
          runClaimToken: activeProbeScene.runClaimToken,
          secretsDirectory,
          overridePath: activeProbeScene.overrideCreated === true ? overridePath : null,
          danglingBaseline,
          composeEnvironment,
          exists: existsSync
        })
      if (residue.length > 0) {
        failures.push(`probe residue recheck found ${String(residue.length)} item(s)`)
      }
    } catch {
      failures.push('probe residue recheck failed')
    }
  }

  if (terminationSignal() !== null) {
    // 信号在飞：把收场交给处置，不用普通退出码抢先。
    return
  }
  if (failures.length > 0) {
    process.stderr.write('Compose secret identity probe FAIL\n')
    for (const message of failures) {
      process.stderr.write(`  - ${message}\n`)
    }
    process.exit(1)
  }
  process.stdout.write('Compose secret identity probe PASS\n')
  for (const line of evidence) {
    process.stdout.write(`  - ${line}\n`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 信号：终止受控子树 → 与正常/失败路径**同一套** scoped cleanup → 复查
  // residue（必被打印）→ 按原信号语义退出。
  installSignalHandlers(
    async () => {
      const residue = []
      if (activeProbeScene.project === null) {
        return residue
      }
      try {
        residue.push(...(await cleanupProbe(activeProbeScene)))
      } catch {
        residue.push('probe scoped cleanup raised an internal failure')
      }
      try {
        residue.push(
          ...(await verifyNoResidue({
            project: activeProbeScene.project,
            imageTag: activeProbeScene.imageTag,
            imageId: activeProbeScene.imageId,
            runClaimToken: activeProbeScene.runClaimToken,
            secretsDirectory: activeProbeScene.secretsDirectory,
            overridePath:
              activeProbeScene.overrideCreated === true ? activeProbeScene.overridePath : null,
            danglingBaseline: activeProbeScene.danglingBaseline,
            composeEnvironment: activeProbeScene.composeEnvironment,
            exists: existsSync
          }))
        )
      } catch {
        residue.push('probe residue recheck raised an internal failure')
      }
      return residue
    },
    { label: 'probe scoped cleanup' }
  )

  try {
    await main()
  } catch {
    process.stderr.write('probe-compose-secret-identity: unhandled probe failure\n')
    process.exit(1)
  }
}
