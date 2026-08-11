#!/usr/bin/env node
//
// 阶段 09A / M5：API runtime image 扫描门禁**自身的变异反例套件**。
//
//   node infra/docker/check-api-runtime-image-mutations.mjs
//
// 只证明门禁「正向绿」不构成判别力证据（M3B 移交清单明确要求把判别力抽查放进
// M5 收口）。本套件对 Dockerfile 施加定向变异，要求扫描核心把每一项都**以指定
// 理由**拒绝——只失败不够，一条无关报错也能让套件变绿。
//
// 与 compose 变异套件不同，这里**不改写任何 tracked 文件**：变异后的 Dockerfile
// 文本经 `docker build --file -`（stdin）喂给 BuildKit，构建上下文仍是真实仓库。
// 每个需要构建的变异使用本轮唯一 tag，用后即删；suite 先跑一条正向 baseline
// （真实 Dockerfile 静态零 problem + 真实构建扫描零 problem），否则「一律报指定
// 理由」的回归会让全部变异恒绿。
//
// 变异 unpinned-base 只做静态判定，不构建：构建它意味着从网络拉取未固定的浮动
// 标签，这正是该判据要阻止的事。
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkDockerfileText,
  checkDockerignoreText,
  createStrictRunner,
  deriveExpectedClosure,
  dockerfilePath,
  dockerignorePath,
  scanImage
} from './api-image-scan.mjs'
import { isAbsenceMessage } from './m3b-docker.mjs'
import { installSignalHandlers, runCommand } from './m3b-subprocess.mjs'

const usage = 'node infra/docker/check-api-runtime-image-mutations.mjs'
if (process.argv.length > 2) {
  process.stderr.write(`usage: ${usage}\n`)
  process.exit(2)
}

/** 硬失败：套件自身无法继续（前置工具缺失、baseline 构建失败等）。 */
class FatalSuiteError extends Error {}
const fatal = (message) => {
  throw new FatalSuiteError(message)
}

const log = (message) => {
  process.stdout.write(`image-mutations: ${message}\n`)
}

const runStrict = createStrictRunner(fatal)

const runId = randomBytes(6).toString('hex')
const tagFor = (caseId) => `meal-agent-api:m5-image-mut-${runId}-${caseId}`

// 变异是**锚定**的文本变换：锚不存在时抛错拒跑（Dockerfile 形状变了必须先修
// 套件，而不是让变异静默变成空操作后「恒被捕获」）。
const anchoredReplace = (text, anchor, replacement) => {
  if (!text.includes(anchor)) {
    fatal(`mutation anchor not found in Dockerfile: ${anchor}`)
  }
  return text.replace(anchor, replacement)
}

const mutations = [
  {
    id: 'inject-denylisted-package',
    describe: 'plant a swiper package directly into /app/node_modules',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        'RUN mkdir -p /app/node_modules/swiper \\\n && printf \'{"name":"swiper","version":"0.0.0-mutation"}\' > /app/node_modules/swiper/package.json\n\nUSER 10001:10001'
      ),
    expectStatic: [],
    expectScan: [
      'denylist: client/build dependency must not ship in the runtime image: swiper',
      'unexpected root entry swiper'
    ]
  },
  {
    id: 'inject-workspace-residue',
    describe: 'leave build-stage residue at /workspace',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        'RUN mkdir -p /workspace && touch /workspace/leftover\n\nUSER 10001:10001'
      ),
    expectStatic: [],
    expectScan: ['image filesystem: build-stage residue must not ship']
  },
  {
    id: 'expose-port',
    describe: 'declare a host-facing EXPOSE port',
    build: true,
    mutate: (text) => `${text}\nEXPOSE 3000\n`,
    expectStatic: ['EXPOSE instructions are not allowed'],
    expectScan: ['image config: ExposedPorts must be absent']
  },
  {
    id: 'secret-shaped-env',
    describe: 'bake a secret-shaped ENV value into the image config',
    build: true,
    mutate: (text) => `${text}\nENV WECHAT_APP_SECRET=mutation-not-a-real-secret\n`,
    expectStatic: [],
    expectScan: ['image config: Env must be exactly the four pinned variables']
  },
  {
    id: 'root-user',
    describe: 'run the runtime stage as root',
    build: true,
    mutate: (text) => anchoredReplace(text, 'USER 10001:10001', 'USER 0:0'),
    expectStatic: ['exact line `USER 10001:10001` is required'],
    expectScan: ['image config: User must be 10001:10001']
  },
  {
    id: 'unpinned-base',
    describe: 'float the base image instead of pinning the digest',
    build: false,
    mutate: (text) =>
      anchoredReplace(
        text,
        /^FROM docker\.io\/library\/node:[^\n]+ AS node-base$/m.exec(text)?.[0] ??
          '__missing-from-line__',
        'FROM node:24-bookworm-slim AS node-base'
      ),
    expectStatic: ['FROM must use the pinned digest'],
    expectScan: []
  }
]

const cleanupState = {
  temporaryRoot: null,
  containerId: null,
  builtTags: new Set(),
  done: false
}
const cleanupProblems = []
const cleanup = async () => {
  if (cleanupState.done) {
    return
  }
  cleanupState.done = true
  if (cleanupState.containerId !== null) {
    try {
      const removal = await runCommand(['docker', 'rm', '-f', cleanupState.containerId], { timeoutMs: 60_000 })
      if (
        removal.status !== 0 &&
        !isAbsenceMessage(removal.stderr, { kind: 'container', name: cleanupState.containerId })
      ) {
        cleanupProblems.push('scratch container removal failed')
      }
    } catch {
      cleanupProblems.push('scratch container removal did not complete')
    }
    cleanupState.containerId = null
  }
  for (const tag of cleanupState.builtTags) {
    try {
      const removal = await runCommand(['docker', 'rmi', tag], { timeoutMs: 120_000 })
      if (removal.status !== 0 && !isAbsenceMessage(removal.stderr, { kind: 'image', name: tag })) {
        cleanupProblems.push(`image tag removal failed (${tag})`)
        continue
      }
      const gone = await runCommand(['docker', 'image', 'inspect', tag], { timeoutMs: 60_000 })
      if (gone.status === 0 || !isAbsenceMessage(gone.stderr, { kind: 'image', name: tag })) {
        cleanupProblems.push(`image tag still present after removal (${tag})`)
      }
    } catch {
      cleanupProblems.push(`image tag removal did not complete (${tag})`)
    }
  }
  cleanupState.builtTags.clear()
  if (cleanupState.temporaryRoot !== null) {
    try {
      rmSync(cleanupState.temporaryRoot, { recursive: true, force: true })
    } catch {
      cleanupProblems.push('temporary directory removal failed')
    }
    cleanupState.temporaryRoot = null
  }
}

installSignalHandlers(() => cleanup(), { label: 'api runtime image mutation cleanup' })

const failures = []

const buildAndScan = async ({ caseId, dockerfileText, viaStdin }) => {
  const tag = tagFor(caseId)
  const caseDirectory = join(cleanupState.temporaryRoot, `case-${caseId}`)
  mkdirSync(caseDirectory, { recursive: true })
  const buildArgs = viaStdin
    ? ['docker', 'build', '--file', '-', '--tag', tag, '.']
    : ['docker', 'build', '--file', 'services/api/Dockerfile', '--tag', tag, '.']
  await runStrict(buildArgs, {
    timeoutMs: 900_000,
    label: `docker build (${caseId})`,
    stdin: viaStdin ? dockerfileText : null
  })
  cleanupState.builtTags.add(tag)
  const problems = []
  await scanImage({
    imageTag: tag,
    expected: suiteExpected,
    temporaryRoot: caseDirectory,
    runStrict,
    fatal,
    problem: (message) => problems.push(message),
    log: () => undefined,
    track: {
      container: (id) => {
        cleanupState.containerId = id
      }
    }
  })
  return problems
}

let suiteExpected = null

const main = async () => {
  for (const [args, label] of [
    [['docker', 'version', '--format', '{{.Server.Version}}'], 'docker daemon'],
    [['pnpm', '--version'], 'pnpm'],
    [['tar', '--version'], 'tar']
  ]) {
    try {
      const probe = await runCommand(args, { timeoutMs: 60_000 })
      if (probe.status !== 0) {
        fatal(`missing prerequisite tool: ${label} is unavailable (${args.join(' ')} failed)`)
      }
    } catch (error) {
      fatal(
        `missing prerequisite tool: ${label} is unavailable (${error instanceof Error ? error.message : 'probe failed'})`
      )
    }
  }

  const dockerfileText = readFileSync(dockerfilePath, 'utf8')
  const dockerignoreText = readFileSync(dockerignorePath, 'utf8')
  cleanupState.temporaryRoot = mkdtempSync(join(tmpdir(), 'meal-agent-m5-image-mut-'))

  suiteExpected = await deriveExpectedClosure({
    runStrict,
    fatal,
    problem: (message) => failures.push(`expected-closure: ${message}`),
    temporaryRoot: cleanupState.temporaryRoot,
    log
  })

  // ---- 正向 baseline：真实 Dockerfile 必须静态零 problem、扫描零 problem ----
  const baselineStatic = []
  checkDockerfileText(dockerfileText, (message) => baselineStatic.push(message))
  checkDockerignoreText(dockerignoreText, (message) => baselineStatic.push(message))
  if (baselineStatic.length > 0) {
    for (const message of baselineStatic) {
      failures.push(`baseline static: ${message}`)
    }
  }
  log('baseline: building and scanning the unmutated Dockerfile')
  const baselineProblems = await buildAndScan({
    caseId: 'baseline',
    dockerfileText,
    viaStdin: false
  })
  if (baselineProblems.length > 0) {
    for (const message of baselineProblems.slice(0, 12)) {
      failures.push(`baseline scan: ${message}`)
    }
  } else {
    log('baseline: clean')
  }

  // ---- 变异：每项都必须以指定理由被拒 ----
  for (const mutation of mutations) {
    const mutated = mutation.mutate(dockerfileText)
    if (mutated === dockerfileText) {
      failures.push(`mutation ${mutation.id}: text transform was a no-op`)
      continue
    }
    const staticProblems = []
    checkDockerfileText(mutated, (message) => staticProblems.push(message))
    for (const expected of mutation.expectStatic) {
      if (!staticProblems.some((message) => message.includes(expected))) {
        failures.push(`mutation ${mutation.id}: static check missed the specified reason "${expected}"`)
      }
    }
    if (!mutation.build) {
      log(`mutation ${mutation.id}: caught statically with the specified reasons`)
      continue
    }
    const scanProblems = await buildAndScan({
      caseId: mutation.id,
      dockerfileText: mutated,
      viaStdin: true
    })
    let missed = false
    for (const expected of mutation.expectScan) {
      if (!scanProblems.some((message) => message.includes(expected))) {
        failures.push(`mutation ${mutation.id}: scan missed the specified reason "${expected}"`)
        missed = true
      }
    }
    if (!missed) {
      log(`mutation ${mutation.id}: caught with the specified reasons`)
    }
  }
}

let fatalMessage = null
try {
  await main()
} catch (error) {
  if (error instanceof FatalSuiteError) {
    fatalMessage = error.message
  } else {
    fatalMessage = `unexpected failure: ${error instanceof Error ? error.message : 'unknown error'}`
  }
}

await cleanup()
for (const message of cleanupProblems) {
  failures.push(`cleanup: ${message}`)
}

if (fatalMessage !== null || failures.length > 0) {
  process.stderr.write('API runtime image mutation suite FAIL\n')
  if (fatalMessage !== null) {
    process.stderr.write(`  - ${fatalMessage}\n`)
  }
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}

const builtMutations = mutations.filter((mutation) => mutation.build).length
const staticOnlyMutations = mutations.length - builtMutations
process.stdout.write(
  `API runtime image mutation suite PASS (1 baseline + ${String(builtMutations)} built ` +
    `+ ${String(staticOnlyMutations)} static-only mutations, all caught with the specified reasons)\n`
)
