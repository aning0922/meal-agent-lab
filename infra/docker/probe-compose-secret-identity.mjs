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
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateAndPreflight } from './generate-local-test-secrets.mjs'
import { secretFiles } from './local-test-secrets-contract.mjs'

const composeDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const composeFile = resolve(composeDirectory, 'compose.local-test.yaml')
const apiImage = 'meal-agent-api:stage09a-local-test'

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

const run = (args, options = {}) => {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options
  })
  if (result.error !== undefined) {
    throw new Error(`failed to run ${args[0]}: ${result.error.message}`)
  }
  return result
}

// bash 侧（postgres 镜像，GNU stat）：每个文件输出一行固定格式的 PROBE 记录。
const bashProbeScript = (targets) => `
set -euo pipefail
euid="$(id -u)"
for f in ${targets.join(' ')}; do
  if [ -L "$f" ]; then
    echo "PROBE $f SYMLINK"
    exit 1
  fi
  eval "$(stat -c 'uid=%u mode=%04a nlink=%h' "$f")"
  case "$(stat -c '%F' "$f")" in
    "regular file") regular=yes ;;
    *) regular=no ;;
  esac
  if head -c 1 "$f" > /dev/null; then readable=yes; else readable=no; fi
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

const main = () => {
  const project = `meal-agent-m3b-probe-${randomBytes(6).toString('hex')}`
  const secretsDirectory = mkdtempSync(resolve(tmpdir(), 'meal-agent-m3b-probe-'))
  const composeEnvironment = {
    ...process.env,
    MEAL_AGENT_SECRETS_DIR: secretsDirectory,
    MEAL_AGENT_API_HOST_PORT: '3000'
  }
  const compose = (args) =>
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
      { cwd: composeDirectory, env: composeEnvironment }
    )

  try {
    generateAndPreflight(secretsDirectory)

    // API 镜像必须存在（三个 UID 10001 服务都用它）。缺失时构建——这与后续
    // smoke 使用的是同一个 build stanza。
    const inspect = run(['docker', 'image', 'inspect', apiImage])
    if (inspect.status !== 0) {
      process.stdout.write(`building ${apiImage} (missing locally)...\n`)
      const build = compose(['build', 'api'])
      if (build.status !== 0) {
        throw new Error(`docker compose build api failed:\n${build.stderr}`)
      }
    }

    for (const plan of probePlan) {
      const targets = plan.secrets.map((name) => `/run/secrets/${name}`)
      const args =
        plan.runtime === 'bash'
          ? ['run', '--rm', '--no-deps', '--entrypoint', 'bash', plan.service, '-c', bashProbeScript(targets)]
          : ['run', '--rm', '--no-deps', '--entrypoint', 'node', plan.service, '-e', nodeProbeScript(targets)]
      const result = compose(args)
      if (result.status !== 0) {
        failures.push(
          `${plan.service}: in-container probe exited ${String(result.status)}: ` +
            `${result.stderr.trim().split('\n').slice(-3).join(' / ')}`
        )
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
  } finally {
    // scoped cleanup：只处理本次 project 与本次临时目录。
    compose(['down', '--volumes', '--remove-orphans'])
    for (const [listArgs, removeArgs] of [
      [['docker', 'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], ['docker', 'rm', '-f']],
      [['docker', 'network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], ['docker', 'network', 'rm']],
      [['docker', 'volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], ['docker', 'volume', 'rm', '-f']]
    ]) {
      const listed = run(listArgs)
      const identifiers = listed.stdout.split('\n').filter(Boolean)
      if (identifiers.length > 0) {
        run([...removeArgs, ...identifiers])
      }
    }
    rmSync(secretsDirectory, { recursive: true, force: true })
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
  try {
    main()
  } catch (error) {
    process.stderr.write(
      `probe-compose-secret-identity: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    )
    process.exit(1)
  }
}
