#!/usr/bin/env node
//
// 阶段 09A / M5：API runtime image 的依赖与组件扫描门禁。
//
//   node infra/docker/check-api-runtime-image.mjs [--keep-failure]
//
// 回答的问题是「**将要交付的那份镜像**里到底装了什么」，而不是「源码树声称装了
// 什么」。因此证据全部取自真实构建产物：untagged claimed build → immutable image ID →
// `docker image save` 内容寻址层。扫描器验证 compressed digest、DiffID、history/config
// 绑定后自行重放 rootfs，再对 `/app` 负载逐包、逐文件比对。
//
// 期望值只有一个来源：在宿主上执行与 Dockerfile runtime-closure 阶段**完全相同**
// 的 `pnpm --filter @meal-agent/api deploy --prod --legacy`，用同一个 walker 走
// 宿主期望树与镜像实际树，两边的 `.pnpm` store key、顶层链接与 name@version 必须
// 精确相等。手写「应该有哪些包」的清单会漂移（peer 物化会把 @types/* 这类
// types-only 包合法地带进闭包），同一命令派生不会。
//
// 在精确闭包比对之上再叠一层**显名 denylist**（Taro、Swiper、webpack-dev-server
// 等客户端/构建工具族）：判定面是包清单 ∪ 全镜像文件清单里的 node_modules/<name>
// 路径段，两层判据互相独立，闭包比对的实现回归不会让「镜像不含客户端依赖」这句
// 话失去看守（阶段 09A 验收门禁 #13）。判别力由
// check-api-runtime-image-mutations.mjs 的变异反例证明。
//
// Docker CLI 缺失、daemon 不可达或任何证据命令非零退出时，一律以「缺少前置工具 /
// 无法判定」失败退出，不降级成静态检查后宣称通过（验收门禁 #11）。
//
// 清理纪律：成功失败都删除本轮 immutable image / 临时目录；失败现场只有
// 显式 `--keep-failure` 才保留（保留物逐项公告）。清理失败本身也是门禁失败。
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync } from 'node:fs'
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
import {
  buildClaimLabel,
  isAbsenceMessage,
  parseBuildMetadataImageIdentity,
  parseClaimedBuildImage,
  parseCanonicalDockerImageId
} from './m3b-docker.mjs'
import { installSignalHandlers, runCommand } from './m3b-subprocess.mjs'
import {
  createOwnedTreeJournal,
  registerOwnedTree,
  retireOwnedTree
} from './m5-evidence-protocol.mjs'

const usage = 'node infra/docker/check-api-runtime-image.mjs [--keep-failure]'
const cliArguments = process.argv.slice(2)
const keepFailure = cliArguments.includes('--keep-failure')
if (cliArguments.some((argument) => argument !== '--keep-failure')) {
  process.stderr.write(`usage: ${usage}\n`)
  process.exit(2)
}

const problems = []
const problem = (message) => {
  problems.push(message)
}

/** 硬失败：后续证据无从谈起（构建失败、导出失败、前置工具缺失）。 */
class FatalGateError extends Error {}
const fatal = (message) => {
  throw new FatalGateError(message)
}

const log = (message) => {
  process.stdout.write(`image-scan: ${message}\n`)
}

const runStrict = createStrictRunner(fatal)

const cleanupState = {
  temporaryRoot: null,
  temporaryRootIdentity: null,
  temporaryJournal: null,
  imageBuildStarted: false,
  ownedImageId: null,
  imageIdFile: null,
  imageMetadataFile: null,
  imageClaimToken: randomBytes(16).toString('hex'),
  cleanupPromise: null
}

const cleanupProblems = []
const cleanup = ({ keepScene = false } = {}) => {
  if (cleanupState.cleanupPromise !== null) {
    return cleanupState.cleanupPromise
  }
  cleanupState.cleanupPromise = (async () => {
  if (keepScene) {
    process.stderr.write('image-scan: --keep-failure set; keeping the failure scene:\n')
    if (cleanupState.temporaryRoot !== null) {
      process.stderr.write('image-scan:   kept owned temporary directory (path omitted)\n')
    }
    if (cleanupState.imageBuildStarted) {
      process.stderr.write('image-scan:   kept claimed immutable image evidence\n')
    }
    return []
  }
  if (cleanupState.imageBuildStarted) {
    try {
      if (
        cleanupState.ownedImageId === null &&
        cleanupState.imageIdFile !== null &&
        cleanupState.imageMetadataFile !== null &&
        existsSync(cleanupState.imageIdFile) &&
        existsSync(cleanupState.imageMetadataFile)
      ) {
        try {
          const metadata = parseBuildMetadataImageIdentity(
            readFileSync(cleanupState.imageMetadataFile, 'utf8')
          )
          const iid = parseCanonicalDockerImageId(readFileSync(cleanupState.imageIdFile, 'utf8'))
          if (iid !== metadata.imageId && iid !== metadata.configId) {
            throw new Error('build identity mismatch')
          }
          cleanupState.ownedImageId = metadata.imageId
        } catch {
          cleanupProblems.push('built image identity could not be recovered from closed evidence')
        }
      }
      if (
        cleanupState.ownedImageId === null &&
        !cleanupProblems.includes('built image identity could not be recovered from closed evidence')
      ) {
        cleanupProblems.push('built image identity could not be recovered from closed evidence')
      }
      if (cleanupState.ownedImageId !== null) {
        const owned = await runCommand(
          ['docker', 'image', 'inspect', cleanupState.ownedImageId],
          { timeoutMs: 60_000 }
        )
        if (owned.status === 0) {
          let claim
          try {
            const payload = JSON.parse(owned.stdout)
            claim = parseClaimedBuildImage(
              Array.isArray(payload) && payload.length === 1 ? payload[0] : null,
              {
                expectedImageId: cleanupState.ownedImageId,
                expectedClaimToken: cleanupState.imageClaimToken,
                requireUntagged: true
              }
            )
          } catch {
            cleanupProblems.push('owned image claim evidence was unreadable')
          }
          if (claim?.repoTags === null || claim?.repoTags?.length === 0) {
            const removal = await runCommand(
              ['docker', 'rmi', cleanupState.ownedImageId],
              { timeoutMs: 120_000 }
            )
            if (removal.status !== 0) cleanupProblems.push('owned immutable image removal failed')
          } else if (claim !== undefined) {
            cleanupProblems.push('owned image acquired another tag and was preserved')
          }
        } else if (
          !(
            owned.status === 1 &&
            isAbsenceMessage(owned.stderr, { kind: 'image', name: cleanupState.ownedImageId })
          )
        ) {
          cleanupProblems.push('owned image identity could not be verified')
        }
        const gone = await runCommand(
          ['docker', 'image', 'inspect', cleanupState.ownedImageId],
          { timeoutMs: 60_000 }
        )
        if (
          !(
            gone.status === 1 &&
            isAbsenceMessage(gone.stderr, {
              kind: 'image',
              name: cleanupState.ownedImageId
            })
          )
        ) {
          cleanupProblems.push('owned immutable image was not proven absent after cleanup')
        }
      }
    } catch {
      cleanupProblems.push('immutable image cleanup did not complete')
    }
    cleanupState.imageBuildStarted = false
    cleanupState.ownedImageId = null
  }
  if (cleanupState.temporaryRoot !== null) {
    if (cleanupProblems.includes('built image identity could not be recovered from closed evidence')) {
      cleanupProblems.push('temporary build evidence was preserved for manual recovery')
      return [...cleanupProblems]
    }
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
  })()
  return cleanupState.cleanupPromise
}

installSignalHandlers(() => cleanup(), { label: 'api runtime image scan cleanup' })

const main = async () => {
  // ---- 前置工具（验收门禁 #11：缺失必须显式失败，不降级） ----
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

  let dockerfileText = null
  try {
    dockerfileText = readFileSync(dockerfilePath, 'utf8')
  } catch {
    problem('Dockerfile: services/api/Dockerfile is missing')
  }
  if (dockerfileText !== null) {
    checkDockerfileText(dockerfileText, problem)
  }
  let dockerignoreText = null
  try {
    dockerignoreText = readFileSync(dockerignorePath, 'utf8')
  } catch {
    problem('.dockerignore: file is missing (build context would include the whole repository)')
  }
  if (dockerignoreText !== null) {
    checkDockerignoreText(dockerignoreText, problem)
  }

  cleanupState.temporaryRoot = mkdtempSync(join(tmpdir(), 'meal-agent-m5-image-scan-'))
  {
    const stat = lstatSync(cleanupState.temporaryRoot, { bigint: true })
    cleanupState.temporaryRootIdentity = { dev: stat.dev, ino: stat.ino }
    cleanupState.temporaryJournal = createOwnedTreeJournal(cleanupState.temporaryRoot)
  }

  const expected = await deriveExpectedClosure({
    runStrict,
    fatal,
    problem,
    temporaryRoot: cleanupState.temporaryRoot,
    log
  })
  registerOwnedTree(cleanupState.temporaryJournal, expected.deployDirectory)

  log('building an untagged claimed runtime image')
  const imageIdFile = join(cleanupState.temporaryRoot, 'built-image.id')
  const imageMetadataFile = join(cleanupState.temporaryRoot, 'built-image.metadata.json')
  cleanupState.imageIdFile = imageIdFile
  cleanupState.imageMetadataFile = imageMetadataFile
  // 构建期不发布 tag；metadata/iidfile 一旦可读，cleanup 就可以按 immutable
  // ID + unguessable claim 恢复所有权。
  cleanupState.imageBuildStarted = true
  await runStrict(['docker', 'build', '--iidfile', imageIdFile, '--metadata-file', imageMetadataFile, '--label', `${buildClaimLabel}=${cleanupState.imageClaimToken}`, '--file', 'services/api/Dockerfile', '.'], {
    timeoutMs: 900_000,
    label: 'docker build'
  })
  registerOwnedTree(cleanupState.temporaryJournal, imageIdFile)
  registerOwnedTree(cleanupState.temporaryJournal, imageMetadataFile)
  const metadata = parseBuildMetadataImageIdentity(readFileSync(imageMetadataFile, 'utf8'))
  const iid = parseCanonicalDockerImageId(readFileSync(imageIdFile, 'utf8'))
  if (iid !== metadata.imageId && iid !== metadata.configId) {
    fatal('docker build evidence identities did not agree')
  }
  const builtImageId = metadata.imageId
  const ownershipInspect = await runStrict(['docker', 'image', 'inspect', builtImageId], {
    timeoutMs: 60_000,
    label: 'docker image inspect (build ownership claim)'
  })
  try {
    const payload = JSON.parse(ownershipInspect.stdout)
    parseClaimedBuildImage(Array.isArray(payload) && payload.length === 1 ? payload[0] : null, {
      expectedImageId: builtImageId,
      expectedClaimToken: cleanupState.imageClaimToken,
      requireUntagged: true
    })
  } catch {
    fatal('docker build ownership evidence did not match its claim')
  }
  cleanupState.ownedImageId = builtImageId

  return scanImage({
    imageTag: null,
    expectedImageId: builtImageId,
    expectedBuildEvidence: metadata,
    expected,
    temporaryRoot: cleanupState.temporaryRoot,
    runStrict,
    fatal,
    problem,
    log,
    track: {
      image: (id) => {
        cleanupState.ownedImageId = id
      },
      path: (path) => {
        registerOwnedTree(cleanupState.temporaryJournal, path)
      }
    }
  })
}

let summary = null
let fatalMessage = null
try {
  summary = await main()
} catch (error) {
  if (error instanceof FatalGateError) {
    fatalMessage = error.message
  } else {
    fatalMessage = 'unexpected failure while collecting runtime image evidence'
  }
}

const failed = fatalMessage !== null || problems.length > 0
await cleanup({ keepScene: failed && keepFailure })
for (const message of cleanupProblems) {
  problems.push(`cleanup: ${message}`)
}

if (fatalMessage !== null || problems.length > 0) {
  process.stderr.write('API runtime image scan FAIL\n')
  if (fatalMessage !== null) {
    process.stderr.write(`  - ${fatalMessage}\n`)
  }
  for (const message of problems) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}

process.stdout.write(
  `API runtime image scan PASS (${String(summary.packageCount)} packages, ` +
    `${String(summary.linkCount)} top-level links, ${String(summary.migrationCount)} migrations, ` +
    `image ${summary.imageId})\n`
)
