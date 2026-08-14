#!/usr/bin/env node
//
// 阶段 09A / M5：API runtime image 的依赖与组件扫描门禁。
//
//   node infra/docker/check-api-runtime-image.mjs [--keep-failure]
//
// 回答的问题是「**将要交付的那份镜像**里到底装了什么」，而不是「源码树声称装了
// 什么」。因此证据全部取自真实构建产物：本轮唯一 tag 构建 → `docker create` +
// `docker export` 的全文件系统清单（不启动容器、不执行镜像内代码）→ 从 tar 提取
// `/app` 负载做逐包、逐文件比对。
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
// 清理纪律：成功失败都删除本轮 container / image tag / 临时目录；失败现场只有
// 显式 `--keep-failure` 才保留（保留物逐项公告）。清理失败本身也是门禁失败。
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkDockerfileText,
  checkDockerignoreText,
  createStrictRunner,
  deriveExpectedClosure,
  dockerfilePath,
  dockerignorePath,
  parseDockerImageId,
  parseOwnedScratchContainer,
  scanImage
} from './api-image-scan.mjs'
import { isAbsenceMessage } from './m3b-docker.mjs'
import { installSignalHandlers, runCommand } from './m3b-subprocess.mjs'

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

const runId = randomBytes(6).toString('hex')
const imageTag = `meal-agent-api:m5-image-scan-${runId}`

const cleanupState = {
  temporaryRoot: null,
  containerClaims: new Map(),
  ownedImageTag: false,
  ownedImageId: null,
  imageIdFile: null,
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
    for (const claim of cleanupState.containerClaims.values()) {
      process.stderr.write(`image-scan:   kept container ${claim.name}\n`)
    }
    if (cleanupState.ownedImageTag) {
      process.stderr.write(`image-scan:   kept image tag ${imageTag}\n`)
    }
    return []
  }
  for (const claim of [...cleanupState.containerClaims.values()]) {
    try {
      const current = await runCommand(['docker', 'container', 'inspect', claim.name], {
        timeoutMs: 60_000
      })
      if (current.status === 0) {
        let owned = null
        try {
          owned = parseOwnedScratchContainer(current.stdout, {
            expectedName: claim.name,
            expectedImageId: claim.imageId,
            expectedContainerId: claim.id ?? null
          }, () => { throw new Error('identity drift') })
        } catch {
          cleanupProblems.push('scratch container ownership drifted; foreign container was preserved')
          continue
        }
        const removal = await runCommand(['docker', 'rm', '-f', owned.Id], { timeoutMs: 60_000 })
        if (removal.status !== 0) {
          cleanupProblems.push('scratch container removal failed')
          continue
        }
      } else if (!(
        current.status === 1 &&
        isAbsenceMessage(current.stderr, { kind: 'container', name: claim.name })
      )) {
        cleanupProblems.push('scratch container identity could not be verified')
        continue
      }
      const gone = await runCommand(['docker', 'container', 'inspect', claim.name], {
        timeoutMs: 60_000
      })
      if (!(
        gone.status === 1 &&
        isAbsenceMessage(gone.stderr, { kind: 'container', name: claim.name })
      )) {
        cleanupProblems.push('scratch container was not proven absent after removal')
      } else {
        cleanupState.containerClaims.delete(claim.name)
      }
    } catch {
      cleanupProblems.push('scratch container removal did not complete')
    }
  }
  if (cleanupState.ownedImageTag) {
    try {
      if (
        cleanupState.ownedImageId === null &&
        cleanupState.imageIdFile !== null &&
        existsSync(cleanupState.imageIdFile)
      ) {
        try {
          cleanupState.ownedImageId = parseDockerImageId(
            readFileSync(cleanupState.imageIdFile, 'utf8'),
            () => { throw new Error('invalid iidfile') }
          )
        } catch {
          cleanupProblems.push('built image identity could not be recovered from iidfile')
        }
      }
      const current = await runCommand(
        ['docker', 'image', 'inspect', '--format', '{{.Id}}', imageTag],
        { timeoutMs: 60_000 }
      )
      const currentId = current.status === 0 ? current.stdout.trim() : null
      if (current.status === 0 && currentId !== cleanupState.ownedImageId) {
        cleanupProblems.push('run image tag ownership drifted; foreign tag was preserved')
      } else if (current.status === 0) {
        const removal = await runCommand(['docker', 'rmi', imageTag], { timeoutMs: 120_000 })
        if (removal.status !== 0) {
          cleanupProblems.push('run image tag removal failed')
        }
      } else if (
        !(
          current.status === 1 &&
          isAbsenceMessage(current.stderr, { kind: 'image', name: imageTag })
        )
      ) {
        cleanupProblems.push('run image tag identity could not be verified')
      }

      const gone = await runCommand(
        ['docker', 'image', 'inspect', '--format', '{{.Id}}', imageTag],
        { timeoutMs: 60_000 }
      )
      if (!(
        gone.status === 1 &&
        isAbsenceMessage(gone.stderr, { kind: 'image', name: imageTag })
      )) {
        cleanupProblems.push('run image tag was not proven absent after cleanup')
      } else {
        cleanupState.ownedImageTag = false
      }

      // 若 tag 在扫描中被重绑，绝不删除外来的新 tag；只清理由本轮记录的 A，
      // 且仅当 A 已无任何 tag 时按 immutable ID 删除。已有其他 tag 表示镜像对象
      // 并非本轮独占，必须保留。
      if (cleanupState.ownedImageId !== null) {
        const owned = await runCommand(
          ['docker', 'image', 'inspect', '--format', '{{json .RepoTags}}', cleanupState.ownedImageId],
          { timeoutMs: 60_000 }
        )
        if (owned.status === 0) {
          let repoTags
          try {
            repoTags = JSON.parse(owned.stdout.trim())
          } catch {
            cleanupProblems.push('owned image tag set was unreadable')
          }
          if (repoTags === null || (Array.isArray(repoTags) && repoTags.length === 0)) {
            const removal = await runCommand(
              ['docker', 'rmi', cleanupState.ownedImageId],
              { timeoutMs: 120_000 }
            )
            if (removal.status !== 0) cleanupProblems.push('owned dangling image removal failed')
          } else if (!Array.isArray(repoTags)) {
            cleanupProblems.push('owned image tag set had an invalid shape')
          }
        } else if (
          !(
            owned.status === 1 &&
            isAbsenceMessage(owned.stderr, { kind: 'image', name: cleanupState.ownedImageId })
          )
        ) {
          cleanupProblems.push('owned image identity could not be verified')
        }
      }
    } catch {
      cleanupProblems.push('run image tag removal did not complete')
    }
    if (!cleanupState.ownedImageTag) cleanupState.ownedImageId = null
  }
  if (cleanupState.temporaryRoot !== null) {
    try {
      rmSync(cleanupState.temporaryRoot, { recursive: true, force: true })
    } catch {
      cleanupProblems.push('temporary directory removal failed')
    }
    cleanupState.temporaryRoot = null
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

  const expected = await deriveExpectedClosure({
    runStrict,
    fatal,
    problem,
    temporaryRoot: cleanupState.temporaryRoot,
    log
  })

  log(`building ${imageTag}`)
  const imageIdFile = join(cleanupState.temporaryRoot, 'built-image.id')
  cleanupState.imageIdFile = imageIdFile
  const preexistingImage = await runCommand(['docker', 'image', 'inspect', imageTag], { timeoutMs: 60_000 })
  if (
    preexistingImage.status === 0 ||
    !(preexistingImage.status === 1 && isAbsenceMessage(preexistingImage.stderr, { kind: 'image', name: imageTag }))
  ) {
    fatal('per-run image tag was not proven absent before build')
  }
  // 从确认 absent 起本轮拥有这个唯一 tag：即使 docker build 已完成 tag 写入后
  // credential helper/stdio 卡住并最终超时，finally 也必须尝试精确删除它。
  cleanupState.ownedImageTag = true
  await runStrict(['docker', 'build', '--iidfile', imageIdFile, '--file', 'services/api/Dockerfile', '--tag', imageTag, '.'], {
    timeoutMs: 900_000,
    label: 'docker build'
  })
  const builtImageId = parseDockerImageId(readFileSync(imageIdFile, 'utf8'), fatal)
  cleanupState.ownedImageId = builtImageId

  return scanImage({
    imageTag,
    expectedImageId: builtImageId,
    expected,
    temporaryRoot: cleanupState.temporaryRoot,
    runStrict,
    fatal,
    problem,
    log,
    scratchContainerName: `meal-agent-m5-image-scan-${runId}`,
    track: {
      image: (id) => {
        cleanupState.ownedImageId = id
      },
      container: (claim) => {
        cleanupState.containerClaims.set(claim.name, claim)
      },
      containerGone: (name) => {
        cleanupState.containerClaims.delete(name)
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
