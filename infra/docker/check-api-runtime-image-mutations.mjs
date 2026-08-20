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
// 每个需要构建的变异在 fork 前登记唯一 recovery tag；tag 只是 locator，只有
// immutable ID + unguessable claim + exact single tag 才授予 cleanup 权。suite 先跑一条正向 baseline
// （真实 Dockerfile 静态零 problem + 真实构建扫描零 problem），否则「一律报指定
// 理由」的回归会让全部变异恒绿。
//
// 变异 unpinned-base 只做静态判定，不构建：构建它意味着从网络拉取未固定的浮动
// 标签，这正是该判据要阻止的事。
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkDockerfileText,
  checkDockerignoreText,
  createStrictRunner,
  deriveExpectedClosure,
  dockerfilePath,
  dockerignorePath,
  parseOwnedScratchContainer,
  scanImage
} from './api-image-scan.mjs'
import {
  buildClaimLabel,
  parseBuildMetadataImageIdentity,
  parseClaimedBuildImage,
  parseCanonicalDockerImageId
} from './m3b-docker.mjs'
import {
  createSignalSafeCleanup,
  installSignalHandlers,
  runCommand,
  terminationSignal,
  terminationSignalAfterCleanupSettlement
} from './m3b-subprocess.mjs'
import {
  createOwnedTreeJournal,
  registerOwnedTree,
  retireOwnedTree,
  runWithDeclaredOwnedTreeOutputs
} from './m5-evidence-protocol.mjs'
import {
  settleClaimedRuntimeImage,
  settleOwnedScratchContainer
} from './m5-runtime-settlement.mjs'

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
      'denylist: client/build dependency must not ship in the runtime image',
      'unexpected root entry'
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
    id: 'inject-denylisted-bin-shim',
    describe: 'plant a webpack executable under the otherwise opaque .bin directory',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        "RUN mkdir -p /app/node_modules/.bin && printf '#!/bin/sh\\n' > /app/node_modules/.bin/webpack\n\nUSER 10001:10001"
      ),
    expectStatic: [],
    expectScan: [
      'closure: dependency payload differs byte-for-byte from the deploy-derived closure',
      'denylist: client/build dependency must not ship in the runtime image'
    ]
  },
  {
    id: 'inject-package-payload',
    describe: 'change package payload without changing package identities or links',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        "RUN target=\"$(find /app/node_modules/.pnpm -type d -path '*/node_modules/*' | head -n 1)\" && printf mutation > \"$target/M5_PAYLOAD_MUTATION\"\n\nUSER 10001:10001"
      ),
    expectStatic: [],
    expectScan: ['closure: dependency payload differs byte-for-byte from the deploy-derived closure']
  },
  {
    id: 'change-package-file-mode',
    describe: 'change an ordinary package file mode without changing its bytes',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        "RUN target=\"$(find /app/node_modules/.pnpm -type f -name '*.js' | head -n 1)\" && chmod 0755 \"$target\"\n\nUSER 10001:10001"
      ),
    expectStatic: [],
    expectScan: ['closure: dependency payload differs byte-for-byte from the deploy-derived closure']
  },
  {
    id: 'runtime-payload-owned-by-runtime-user',
    describe: 'make the runtime uid own the application payload',
    build: true,
    mutate: (text) => {
      const occurrences = text.split('--chown=0:0').length - 1
      if (occurrences !== 4) {
        fatal('mutation anchor count drifted for runtime COPY ownership')
      }
      return text.replaceAll('--chown=0:0', '--chown=10001:10001')
    },
    expectStatic: [],
    expectScan: ['runtime payload was not root-owned']
  },
  {
    id: 'runtime-entrypoint-unreadable-by-runtime-user',
    describe: 'make the fixed API entrypoint unreadable by uid 10001',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        'RUN chmod 0600 /app/dist/index.js\n\nUSER 10001:10001'
      ),
    expectStatic: [],
    expectScan: ['runtime uid could not traverse or read the fixed entrypoints']
  },
  {
    id: 'runtime-dist-untraversable-by-runtime-user',
    describe: 'make /app/dist untraversable by uid 10001',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        'RUN chmod 0700 /app/dist\n\nUSER 10001:10001'
      ),
    expectStatic: [],
    expectScan: ['runtime uid could not traverse or read the fixed entrypoints']
  },
  {
    id: 'runtime-entrypoint-escaped-symlink',
    describe: 'replace the runtime entrypoint with a symlink outside the protected app tree',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        'RUN rm -f /app/dist/index.js && ln -s ../../runtime/index.js /app/dist/index.js\n\nUSER 10001:10001'
      ),
    expectStatic: [],
    expectScan: ['runtime entrypoint was not a verified regular file']
  },
  {
    id: 'runtime-entrypoint-same-tree-symlink',
    describe: 'replace the runtime entrypoint with a same-tree symlink',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        'RUN mv /app/dist/index.js /app/dist/index.real.js && ln -s index.real.js /app/dist/index.js\n\nUSER 10001:10001'
      ),
    expectStatic: [],
    expectScan: ['runtime entrypoint was not a verified regular file']
  },
  {
    id: 'replace-skipped-readme-with-directory',
    describe: 'turn the skipped contracts README path into an opaque directory tree',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        'RUN set -eu; \\\n set -- /app/node_modules/.pnpm/@meal-agent+contracts@*/node_modules/@meal-agent/contracts; \\\n [ "$#" -eq 1 ] && [ -d "$1" ]; \\\n target="$1/README.md"; \\\n rm -f "$target"; \\\n mkdir -p "$target"; \\\n printf mutation > "$target/hidden-client.js"\n\nUSER 10001:10001'
      ),
    expectStatic: [],
    expectScan: ['closure: dependency payload differs byte-for-byte from the deploy-derived closure']
  },
  {
    id: 'secret-shaped-image-history',
    describe: 'leave a secret-shaped value only in immutable image history',
    build: true,
    mutate: (text) =>
      anchoredReplace(
        text,
        'USER 10001:10001',
        "RUN printf 'WECHAT_APP_SECRET=M5_HISTORY_SENTINEL' > /tmp/m5-history && rm /tmp/m5-history\n\nUSER 10001:10001"
      ),
    expectStatic: [],
    expectScan: ['image history: secret-shaped build instruction must not ship']
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
    id: 'wrong-stop-signal',
    describe: 'replace Docker default SIGTERM shutdown with SIGINT',
    build: true,
    mutate: (text) => `${text}\nSTOPSIGNAL SIGINT\n`,
    expectStatic: ['STOPSIGNAL must be absent so Docker uses SIGTERM'],
    expectScan: ['image config: StopSignal must be absent so Docker uses SIGTERM']
  },
  {
    id: 'deferred-onbuild-instruction',
    describe: 'leave a deferred build instruction in the runtime image config',
    build: true,
    mutate: (text) => `${text}\nONBUILD RUN printf mutation > /tmp/m5-onbuild\n`,
    expectStatic: ['ONBUILD instructions are not allowed in the runtime image'],
    expectScan: ['image config: OnBuild must be absent']
  },
  {
    id: 'missing-provenance',
    describe: 'build an otherwise valid image with provenance explicitly disabled',
    build: true,
    buildOptions: ['--provenance=false'],
    // A unique label prevents this intentionally provenance-free build from sharing one
    // manifest identity with another case. Cleanup can therefore prove exclusive ownership
    // and remove the immutable ID rather than trusting a mutable tag.
    mutate: (text) => `${text}\nLABEL meal-agent.m5.mutation=${runId}-missing-provenance\n`,
    expectStatic: [],
    expectScan: ['provenance is missing or not bound to the selected platform manifest']
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

const expectedBuiltMutationCount = 18
const expectedStaticOnlyMutationCount = 2

const cleanupState = {
  temporaryRoot: null,
  temporaryRootIdentity: null,
  temporaryJournal: null,
  builds: new Map()
}
const cleanupProblems = []
const cleanup = createSignalSafeCleanup(async (cleanupRunCommand) => {
  for (const [caseId, record] of cleanupState.builds) {
    try {
      if (record.scratchContainer !== null) {
        cleanupProblems.push(...(await settleOwnedScratchContainer(
          cleanupRunCommand,
          record.scratchContainer,
          { parseOwnedScratchContainer }
        )).map((message) => `${message} (${caseId})`))
        record.scratchContainer = null
      }
      cleanupProblems.push(...(await settleClaimedRuntimeImage(cleanupRunCommand, {
        recoveryTag: record.recoveryTag,
        claimToken: record.claimToken,
        ownedImageId: record.imageId
      })).map((message) => `${message} (${caseId})`))
    } catch {
      cleanupProblems.push(`immutable image cleanup did not complete (${caseId})`)
    }
  }
  cleanupState.builds.clear()
  if (cleanupState.temporaryRoot !== null) {
    try {
      const observed = lstatSync(cleanupState.temporaryRoot, { bigint: true })
      if (
        cleanupState.temporaryRootIdentity === null ||
        observed.dev !== cleanupState.temporaryRootIdentity.dev ||
        observed.ino !== cleanupState.temporaryRootIdentity.ino
      ) {
        cleanupProblems.push('temporary directory ownership drifted')
      } else {
        if (cleanupState.temporaryJournal === null) {
          cleanupProblems.push('temporary directory ownership journal was unavailable')
        } else {
          retireOwnedTree(cleanupState.temporaryJournal)
        }
      }
    } catch {
      if (existsSync(cleanupState.temporaryRoot)) {
        cleanupProblems.push('temporary directory removal failed')
      }
    }
    cleanupState.temporaryRoot = null
    cleanupState.temporaryRootIdentity = null
    cleanupState.temporaryJournal = null
  }
  return [...cleanupProblems]
})

installSignalHandlers(() => cleanup(), { label: 'api runtime image mutation cleanup' })

const failures = []

const buildAndScan = async ({
  caseId,
  dockerfileText,
  viaStdin,
  buildOptions = []
}) => {
  const caseDirectory = join(cleanupState.temporaryRoot, `case-${caseId}`)
  mkdirSync(caseDirectory, { recursive: true })
  registerOwnedTree(cleanupState.temporaryJournal, caseDirectory)
  const imageIdFile = join(caseDirectory, 'built-image.id')
  const metadataFile = join(caseDirectory, 'built-image.metadata.json')
  const claimToken = randomBytes(16).toString('hex')
  const recoveryTag = `meal-agent-api:m5-mut-${runId}-${caseId}`
  const record = {
    claimToken,
    recoveryTag,
    imageId: null,
    scratchContainer: null
  }
  cleanupState.builds.set(caseId, record)
  const buildArgs = viaStdin
    ? ['docker', 'build', ...buildOptions, '--tag', recoveryTag, '--iidfile', imageIdFile, '--metadata-file', metadataFile, '--label', `${buildClaimLabel}=${claimToken}`, '--file', '-', '.']
    : ['docker', 'build', ...buildOptions, '--tag', recoveryTag, '--iidfile', imageIdFile, '--metadata-file', metadataFile, '--label', `${buildClaimLabel}=${claimToken}`, '--file', 'services/api/Dockerfile', '.']
  await runWithDeclaredOwnedTreeOutputs(
    cleanupState.temporaryJournal,
    [imageIdFile, metadataFile],
    () => runStrict(buildArgs, {
      timeoutMs: 900_000,
      label: `docker build (${caseId})`,
      stdin: viaStdin ? dockerfileText : null
    })
  )
  const buildEvidence = parseBuildMetadataImageIdentity(
    readFileSync(metadataFile, 'utf8')
  )
  const { imageId: builtImageId, configId } = buildEvidence
  const iid = parseCanonicalDockerImageId(readFileSync(imageIdFile, 'utf8'))
  if (iid !== builtImageId && iid !== configId) {
    fatal('docker build iidfile did not match build metadata')
  }
  const ownership = await runStrict(['docker', 'image', 'inspect', builtImageId], {
    timeoutMs: 60_000,
    label: `docker image inspect ownership (${caseId})`
  })
  try {
    const payload = JSON.parse(ownership.stdout)
    const claim = parseClaimedBuildImage(
      Array.isArray(payload) && payload.length === 1 ? payload[0] : null,
      {
        expectedImageId: builtImageId,
        expectedClaimToken: claimToken,
        expectedTag: recoveryTag
      }
    )
    void claim
  } catch {
    fatal(`docker build ownership evidence did not match its claim (${caseId})`)
  }
  record.imageId = builtImageId
  const problems = []
  try {
    await scanImage({
      imageTag: null,
      expectedImageId: builtImageId,
      expectedBuildEvidence: buildEvidence,
      expected: suiteExpected,
      temporaryRoot: caseDirectory,
      runStrict,
      fatal,
      problem: (message) => problems.push(message),
      log: () => undefined,
      track: {
        image: () => undefined,
        path: (path) => registerOwnedTree(cleanupState.temporaryJournal, path),
        container: (scratch) => {
          record.scratchContainer = scratch
        }
      }
    })
  } catch (error) {
    if (error instanceof FatalSuiteError) {
      problems.push(error.message)
    } else {
      throw error
    }
  }
  return problems
}

let suiteExpected = null

const main = async () => {
  const builtMutationCount = mutations.filter((mutation) => mutation.build).length
  const staticOnlyMutationCount = mutations.length - builtMutationCount + 1
  if (
    builtMutationCount !== expectedBuiltMutationCount ||
    staticOnlyMutationCount !== expectedStaticOnlyMutationCount
  ) {
    fatal(
      `mutation registry count drifted (expected ${String(expectedBuiltMutationCount)} built + ` +
        `${String(expectedStaticOnlyMutationCount)} static-only)`
    )
  }

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
  {
    const stat = lstatSync(cleanupState.temporaryRoot, { bigint: true })
    cleanupState.temporaryRootIdentity = { dev: stat.dev, ino: stat.ino }
    cleanupState.temporaryJournal = createOwnedTreeJournal(cleanupState.temporaryRoot)
  }

  suiteExpected = await deriveExpectedClosure({
    runStrict,
    fatal,
    problem: (message) => failures.push(`expected-closure: ${message}`),
    temporaryRoot: cleanupState.temporaryRoot,
    log
  })
  registerOwnedTree(cleanupState.temporaryJournal, suiteExpected.deployDirectory)

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

  // `.dockerignore` 是镜像构建面的另一半。存在密钥排除行还不够：若后面再追加
  // 一个宽泛 negation，Docker 的 last-match-wins 会把密钥重新纳入上下文。
  const reopenedDockerignore = `${dockerignoreText}\n!services/api/**\n`
  const dockerignoreMutationProblems = []
  checkDockerignoreText(reopenedDockerignore, (message) => dockerignoreMutationProblems.push(message))
  if (!dockerignoreMutationProblems.some((message) => message.includes('must appear after every negation rule'))) {
    failures.push('mutation late-dockerignore-negation: static check missed the specified ordering reason')
  } else {
    log('mutation late-dockerignore-negation: caught statically with the specified reason')
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
      viaStdin: true,
      buildOptions: mutation.buildOptions ?? []
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
    fatalMessage = 'unexpected failure while collecting mutation evidence'
  }
}

let settledSignal = terminationSignal()
if (settledSignal === null) {
  await cleanup()
  for (const message of cleanupProblems) {
    failures.push(`cleanup: ${message}`)
  }
  settledSignal = await terminationSignalAfterCleanupSettlement()
}

if (settledSignal !== null) {
  // The shared handler owns cleanup and same-signal settlement.
} else if (fatalMessage !== null || failures.length > 0) {
  process.stderr.write('API runtime image mutation suite FAIL\n')
  if (fatalMessage !== null) {
    process.stderr.write(`  - ${fatalMessage}\n`)
  }
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exitCode = 1
}

const builtMutations = mutations.filter((mutation) => mutation.build).length
const staticOnlyMutations = mutations.length - builtMutations + 1
if (settledSignal === null && process.exitCode !== 1) {
  process.stdout.write(
    `API runtime image mutation suite PASS (1 baseline + ${String(builtMutations)} built ` +
      `+ ${String(staticOnlyMutations)} static-only mutations, all caught with the specified reasons)\n`
  )
}
