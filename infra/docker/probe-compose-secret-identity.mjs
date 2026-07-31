#!/usr/bin/env node
// 阶段 09A / M3B 第一步：真实 Compose Secret 的容器内 UID/mode 行为探针。
//
//   node infra/docker/probe-compose-secret-identity.mjs
//
// M3A 的消费判据要求 secret file 在**消费进程**看来：owner == 进程 EUID、
// mode 为 owner-only 的 0400/0600、普通文件、nlink=1、非 symlink、可读。
// Compose 在非 swarm 模式下把 secret 直接 bind mount 进容器，因此这组判据能否
// 成立取决于容器引擎的文件共享实现——必须**在容器内**取证，宿主 stat 不作数。
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
import { secretFiles } from './local-test-secrets-contract.mjs'
import {
  cleanupRun,
  danglingVolumes,
  imageIdOf,
  inspectStrict,
  overridePathFor,
  runImageTagFor,
  verifyNoResidue,
  writeImageOverride
} from './m3b-docker.mjs'
import { installSignalHandlers, runCommand, terminationSignal } from './m3b-subprocess.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')
/** probe 的 cleanup 范围：只认自己的 project 形状。 */
const probeProjectPattern = /^meal-agent-m3b-probe-[a-z0-9]+$/
const probeSecretsPrefix = 'meal-agent-m3b-probe-'

/** 每份 secret 在哪个服务里被消费（与 compose.local-test.yaml 的 secrets 一致）。 */
const probePlan = [
  { service: 'postgres', runtime: 'bash', secrets: ['postgres_superuser_password'] },
  {
    service: 'bootstrap-logins',
    runtime: 'bash',
    secrets: [
      'postgres_admin_pgpass',
      'meal_agent_migration_password',
      'meal_agent_runtime_password',
      'meal_agent_backup_password'
    ]
  },
  { service: 'bootstrap-schema', runtime: 'node', secrets: ['meal_agent_admin_database_url'] },
  { service: 'migrate', runtime: 'node', secrets: ['meal_agent_migration_database_url'] },
  { service: 'api', runtime: 'node', secrets: ['meal_agent_runtime_database_url'] }
]

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

const parseProbeLine = (line) => {
  const fields = {}
  const parts = line.trim().split(/\s+/)
  for (const part of parts.slice(2)) {
    const [key, value] = part.split('=')
    fields[key] = value
  }
  return { path: parts[1], fields }
}

/** CLI 信号处置读取的现场登记（正常、失败、信号三条路径共用同一套 cleanup）。 */
const activeProbeScene = {
  project: null,
  secretsDirectory: null,
  imageTag: null,
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
    secretsPrefix: probeSecretsPrefix,
    imageTag: scene.imageTag,
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
  const project = `meal-agent-m3b-probe-${runId}`
  const imageTag = runImageTagFor(runId)
  const overridePath = overridePathFor(composeDirectory, runId)
  const secretsDirectory = mkdtempSync(resolve(tmpdir(), probeSecretsPrefix))
  // **第一个资源刚创建就登记现场**（P1-4）：下面的 `await danglingVolumes()`
  // 是一次真实 Docker 查询，信号可以落在它期间。override 此刻尚未创建。
  Object.assign(activeProbeScene, {
    project,
    secretsDirectory,
    imageTag: null,
    overridePath: null,
    overrideCreated: false,
    composeEnvironment: { ...process.env, MEAL_AGENT_SECRETS_DIR: secretsDirectory },
    composeArgs: [],
    danglingBaseline: null
  })
  const danglingBaseline = await danglingVolumes()
  const composeEnvironment = {
    ...process.env,
    MEAL_AGENT_SECRETS_DIR: secretsDirectory,
    MEAL_AGENT_API_HOST_PORT: '3000'
  }
  const composeArgs = ['--file', overridePath]
  Object.assign(activeProbeScene, {
    project,
    secretsDirectory,
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
    generateAndPreflight(secretsDirectory)

    // 本轮唯一 image tag：经临时 override 注入，绝不覆盖全局 tag，也不会与
    // 并行 worktree/project 互相覆盖。build 之后读取 immutable image ID。
    writeImageOverride(overridePath, imageTag)
    activeProbeScene.overrideCreated = true
    activeProbeScene.imageTag = imageTag
    activeProbeScene.composeArgs = composeArgs
    const build = await compose(['build', 'api'], { timeoutMs: 1_800_000 })
    if (build.status !== 0) {
      throw new Error(`docker compose build api failed:\n${build.stderr.slice(-2000)}`)
    }
    const builtImageId = await imageIdOf(imageTag, { env: composeEnvironment })
    if (builtImageId === null) {
      throw new Error(`the per-run image tag ${imageTag} does not exist after build`)
    }
    process.stdout.write(`built ${imageTag} (image id ${builtImageId})\n`)

    for (const plan of probePlan) {
      const targets = plan.secrets.map((name) => `/run/secrets/${name}`)
      const args =
        plan.runtime === 'bash'
          ? ['run', '--rm', '--no-deps', '--entrypoint', 'bash', plan.service, '-c', bashProbeScript(targets)]
          : ['run', '--rm', '--no-deps', '--entrypoint', 'node', plan.service, '-e', nodeProbeScript(targets)]
      const result = await compose(args, { timeoutMs: 300_000 })
      if (result.status !== 0) {
        failures.push(
          `${plan.service}: in-container probe exited ${String(result.status)}: ` +
            `${result.stderr.trim().split('\n').slice(-3).join(' / ')}`
        )
        // 信号在飞时**立即停止**创建新容器：否则 handler 已经跑完 label
        // sweep，这里再 spawn 出来的容器无人回收。
        if (terminationSignal() !== null) {
          break
        }
        continue
      }
      const lines = result.stdout.split('\n').filter((line) => line.startsWith('PROBE '))
      const byPath = new Map(lines.map((line) => {
        const parsed = parseProbeLine(line)
        return [parsed.path, parsed.fields]
      }))
      for (const secretName of plan.secrets) {
        const target = `/run/secrets/${secretName}`
        const fields = byPath.get(target)
        const expectedUid = String(consumerUidOf(secretName))
        if (fields === undefined) {
          failures.push(`${plan.service}: no probe record for ${target}`)
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
            failures.push(
              `${plan.service}: ${target} ${key}=${fields[key] ?? '(missing)'} (expected ${expected})`
            )
          }
        }
        if (fields.mode !== '0400' && fields.mode !== '0600') {
          failures.push(
            `${plan.service}: ${target} mode=${fields.mode ?? '(missing)'} ` +
              '(expected owner-only 0400 or 0600)'
          )
        }
        evidence.push(
          `${plan.service} (uid ${expectedUid}): ${target} ` +
            `uid=${fields.uid} mode=${fields.mode} nlink=${fields.nlink} ` +
            `regular=${fields.regular} readable=${fields.readable} symlink=${fields.symlink}`
        )
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  } finally {
    // 正常、失败与信号三条路径复用**同一套** scoped cleanup + 独立复查。
    // override 必须**在 cleanup 之后**删除：`compose down` 仍要用它解析配置。
    // 信号在飞时整段交给处置：主流程既不重复 cleanup 也不删 override。
    if (terminationSignal() !== null) {
      process.stderr.write('signal in flight: cleanup is owned by the signal handler\n')
      return
    }
    try {
      failures.push(...(await cleanupProbe(activeProbeScene)))
    } catch (error) {
      failures.push(
        `cleanup-error: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    try {
      failures.push(
        ...(await verifyNoResidue({
          project,
          imageTag: activeProbeScene.imageTag,
          secretsDirectory,
          overridePath: activeProbeScene.overrideCreated === true ? overridePath : null,
          danglingBaseline,
          composeEnvironment,
          exists: existsSync
        }))
      )
    } catch (error) {
      failures.push(
        `residue recheck failed: ${error instanceof Error ? error.message : String(error)}`
      )
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
      } catch (error) {
        residue.push(`cleanup-error: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        residue.push(
          ...(await verifyNoResidue({
            project: activeProbeScene.project,
            imageTag: activeProbeScene.imageTag,
            secretsDirectory: activeProbeScene.secretsDirectory,
            overridePath:
              activeProbeScene.overrideCreated === true ? activeProbeScene.overridePath : null,
            danglingBaseline: activeProbeScene.danglingBaseline,
            composeEnvironment: activeProbeScene.composeEnvironment,
            exists: existsSync
          }))
        )
      } catch (error) {
        residue.push(
          `residue recheck failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return residue
    },
    { label: 'probe scoped cleanup' }
  )

  try {
    await main()
  } catch (error) {
    process.stderr.write(
      `probe-compose-secret-identity: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    )
    process.exit(1)
  }
}
