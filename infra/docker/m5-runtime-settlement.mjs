import { parseOwnedScratchContainer } from './api-image-scan.mjs'
import {
  buildClaimLabel,
  isAbsenceMessage,
  parseClaimedBuildImage,
  parseCanonicalDockerImageId
} from './m3b-docker.mjs'

const inspectJsonObject = (stdout) => {
  const payload = JSON.parse(stdout)
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error('inspect envelope')
  }
  return payload[0]
}

const isAbsent = (result, kind, name) =>
  result.status === 1 && isAbsenceMessage(result.stderr, { kind, name })

const unique = (values) => [...new Set(values)]

const claimedImageIds = async (run, claimToken) => {
  const result = await run([
    'docker',
    'image',
    'ls',
    '--no-trunc',
    '--quiet',
    '--filter',
    `label=${buildClaimLabel}=${claimToken}`
  ], { timeoutMs: 60_000 })
  if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.includes('\r')) {
    throw new Error('claim listing')
  }
  const lines = result.stdout === ''
    ? []
    : result.stdout.endsWith('\n')
      ? result.stdout.slice(0, -1).split('\n')
      : [result.stdout]
  if (lines.some((line) => line === '')) throw new Error('claim listing')
  const ids = unique(lines.map((line) => parseCanonicalDockerImageId(line)))
  if (ids.length !== lines.length || ids.length > 1) throw new Error('claim listing')
  return ids
}

const observeTag = async (run, recoveryTag) => {
  const result = await run(['docker', 'image', 'inspect', recoveryTag], {
    timeoutMs: 60_000
  })
  if (isAbsent(result, 'image', recoveryTag)) return Object.freeze({ kind: 'absent' })
  if (result.status !== 0) return Object.freeze({ kind: 'unreadable' })
  try {
    return Object.freeze({ kind: 'present', value: inspectJsonObject(result.stdout) })
  } catch {
    return Object.freeze({ kind: 'unreadable' })
  }
}

const observeImage = async (run, imageId) => {
  const result = await run(['docker', 'image', 'inspect', imageId], {
    timeoutMs: 60_000
  })
  if (isAbsent(result, 'image', imageId)) return Object.freeze({ kind: 'absent' })
  if (result.status !== 0) return Object.freeze({ kind: 'unreadable' })
  try {
    return Object.freeze({ kind: 'present', value: inspectJsonObject(result.stdout) })
  } catch {
    return Object.freeze({ kind: 'unreadable' })
  }
}

/**
 * Settle one claimed runtime image from final observable facts. Destructive
 * command status is deliberately not latched: Docker may perform the removal
 * and then report a transport/nonzero result. Success requires final absence
 * of the immutable ID, the recovery locator and every image carrying this
 * run's unguessable claim. A rebound/foreign locator is preserved and fails.
 */
export const settleClaimedRuntimeImage = async (
  run,
  { recoveryTag, claimToken, ownedImageId = null }
) => {
  const problems = []
  let imageId = ownedImageId
  const initialTag = await observeTag(run, recoveryTag)

  if (initialTag.kind === 'present') {
    try {
      const candidateId = parseCanonicalDockerImageId(initialTag.value?.Id)
      parseClaimedBuildImage(initialTag.value, {
        expectedImageId: candidateId,
        expectedClaimToken: claimToken,
        expectedTag: recoveryTag
      })
      if (imageId !== null && imageId !== candidateId) {
        problems.push('owned image immutable identity drifted')
      } else {
        imageId = candidateId
      }
    } catch {
      problems.push('owned recovery locator identity drifted')
    }
  } else if (initialTag.kind === 'unreadable') {
    problems.push('owned recovery locator could not be verified')
  }

  if (imageId === null) {
    try {
      const ids = await claimedImageIds(run, claimToken)
      if (ids.length === 1) imageId = ids[0]
    } catch {
      problems.push('built image claim set could not be verified')
    }
  }

  if (imageId !== null) {
    const initialImage = await observeImage(run, imageId)
    if (initialImage.kind === 'present') {
      let exactTag = false
      let untagged = false
      try {
        parseClaimedBuildImage(initialImage.value, {
          expectedImageId: imageId,
          expectedClaimToken: claimToken,
          expectedTag: recoveryTag
        })
        exactTag = true
      } catch {
        try {
          parseClaimedBuildImage(initialImage.value, {
            expectedImageId: imageId,
            expectedClaimToken: claimToken,
            requireUntagged: true
          })
          untagged = true
        } catch {
          problems.push('owned image claim or tag set drifted')
        }
      }

      if (exactTag) {
        await run(['docker', 'image', 'rm', recoveryTag], { timeoutMs: 120_000 })
        const afterUntag = await observeImage(run, imageId)
        if (afterUntag.kind === 'present') {
          try {
            parseClaimedBuildImage(afterUntag.value, {
              expectedImageId: imageId,
              expectedClaimToken: claimToken,
              requireUntagged: true
            })
            untagged = true
          } catch {
            problems.push('owned image did not become exclusively untagged')
          }
        } else if (afterUntag.kind === 'unreadable') {
          problems.push('owned image state could not be verified after untag')
        }
      }

      if (untagged) {
        await run(['docker', 'image', 'rm', imageId], { timeoutMs: 120_000 })
      }
    } else if (initialImage.kind === 'unreadable') {
      problems.push('owned immutable image identity could not be verified')
    }

    const finalImage = await observeImage(run, imageId)
    if (finalImage.kind !== 'absent') {
      problems.push('owned immutable image was not proven absent after cleanup')
    }
  }

  const finalTag = await observeTag(run, recoveryTag)
  if (finalTag.kind !== 'absent') {
    problems.push('owned recovery locator changed or remained after cleanup')
  }

  return unique(problems)
}

const observeContainer = async (run, locator) => {
  const result = await run(['docker', 'container', 'inspect', locator], {
    timeoutMs: 60_000
  })
  if (isAbsent(result, 'container', locator)) return Object.freeze({ kind: 'absent' })
  if (result.status !== 0) return Object.freeze({ kind: 'unreadable' })
  return Object.freeze({ kind: 'present', stdout: result.stdout })
}

/** Settle one scratch container by immutable ID and then recheck its mutable name. */
export const settleOwnedScratchContainer = async (run, record) => {
  const problems = []
  const locator = record.id ?? record.name
  const initial = await observeContainer(run, locator)
  if (initial.kind === 'present') {
    try {
      const owned = parseOwnedScratchContainer(
        initial.stdout,
        {
          expectedName: record.name,
          expectedImageId: record.expectedImageId,
          expectedContainerId: record.id,
          expectedUser: record.expectedUser,
          expectedNetworkMode: record.expectedNetworkMode,
          expectedReadonlyRootfs: record.expectedReadonlyRootfs
        },
        () => { throw new Error('scratch identity') }
      )
      await run(['docker', 'container', 'rm', '-f', '-v', owned.Id], {
        timeoutMs: 120_000
      })
    } catch {
      problems.push('owned runtime probe identity could not be verified')
    }
  } else if (initial.kind === 'unreadable') {
    problems.push('owned runtime probe identity could not be verified')
  }

  if (record.id !== null) {
    const finalId = await observeContainer(run, record.id)
    if (finalId.kind !== 'absent') {
      problems.push('owned runtime probe immutable identity was not proven absent')
    }
  }
  const finalName = await observeContainer(run, record.name)
  if (finalName.kind !== 'absent') {
    problems.push('owned runtime probe name changed or remained after cleanup')
  }
  return unique(problems)
}
