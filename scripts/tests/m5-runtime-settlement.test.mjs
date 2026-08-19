import assert from 'node:assert/strict'
import test from 'node:test'

import {
  settleClaimedRuntimeImage,
  settleOwnedScratchContainer
} from '../../infra/docker/m5-runtime-settlement.mjs'
import { buildClaimLabel } from '../../infra/docker/m3b-docker.mjs'

const imageId = (character) => `sha256:${character.repeat(64)}`
const containerId = (character) => character.repeat(64)
const ok = (stdout = '') => ({ status: 0, signal: null, stdout, stderr: '' })
const absent = (kind, name) => ({
  status: 1,
  signal: null,
  stdout: '',
  stderr: `Error response from daemon: No such ${kind}: ${name}\n`
})

const runtimeDaemon = ({
  tag = 'meal-agent-api:m5-recovery-fixture',
  claim = 'a'.repeat(32),
  image = imageId('a'),
  initialTags = [tag],
  imageRemovalStatus = 0,
  tagRemovalStatus = 0,
  rebindTagAfterImageRemoval = false,
  containerRemovalStatus = 0,
  rebindContainerAfterRemoval = false
} = {}) => {
  const images = new Map([[image, { claim, tags: [...initialTags] }]])
  const foreignImage = imageId('f')
  images.set(foreignImage, { claim: 'f'.repeat(32), tags: [] })
  const ownedContainerId = containerId('b')
  const foreignContainerId = containerId('c')
  const containerName = 'm5-scratch-fixture'
  const containers = new Map([[ownedContainerId, {
    id: ownedContainerId,
    image,
    name: containerName,
    user: '10001:10001'
  }]])

  const imageObject = (id, value) => ({
    Id: id,
    RepoTags: value.tags.length === 0 ? null : [...value.tags],
    Config: { Labels: { [buildClaimLabel]: value.claim } }
  })
  const containerObject = (value) => ({
    Id: value.id,
    Image: value.image,
    Name: `/${value.name}`,
    Path: 'node',
    Config: {
      User: value.user,
      Labels: { 'meal-agent.m5.owner': value.name }
    },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true }
  })
  const findImageByTag = (value) =>
    [...images].find(([, record]) => record.tags.includes(value)) ?? null
  const findContainer = (value) =>
    containers.get(value) ??
    [...containers.values()].find((record) => record.name === value) ??
    null

  const run = async (argv) => {
    if (argv[0] !== 'docker') throw new Error('unexpected command')
    if (argv[1] === 'image' && argv[2] === 'inspect') {
      const locator = argv[3]
      const byId = images.get(locator)
      const byTag = findImageByTag(locator)
      const found = byId === undefined ? byTag : [locator, byId]
      return found === null || found === undefined
        ? absent('image', locator)
        : ok(JSON.stringify([imageObject(found[0], found[1])]))
    }
    if (argv[1] === 'image' && argv[2] === 'ls') {
      const label = argv.at(-1)
      const expectedClaim = label.slice(label.lastIndexOf('=') + 1)
      const ids = [...images]
        .filter(([, value]) => value.claim === expectedClaim)
        .map(([id]) => id)
      return ok(ids.length === 0 ? '' : `${ids.join('\n')}\n`)
    }
    if (argv[1] === 'image' && argv[2] === 'rm') {
      const locator = argv[3]
      const byTag = findImageByTag(locator)
      if (byTag !== null) {
        byTag[1].tags = byTag[1].tags.filter((value) => value !== locator)
        return { ...ok(), status: tagRemovalStatus }
      }
      if (images.has(locator)) {
        images.delete(locator)
        if (rebindTagAfterImageRemoval) images.get(foreignImage).tags.push(tag)
        return { ...ok(), status: imageRemovalStatus }
      }
      return absent('image', locator)
    }
    if (argv[1] === 'container' && argv[2] === 'inspect') {
      const locator = argv[3]
      const found = findContainer(locator)
      return found === null
        ? absent('container', locator)
        : ok(JSON.stringify([containerObject(found)]))
    }
    if (argv[1] === 'container' && argv[2] === 'rm') {
      const locator = argv.at(-1)
      const found = findContainer(locator)
      if (found === null) return absent('container', locator)
      containers.delete(found.id)
      if (rebindContainerAfterRemoval) {
        containers.set(foreignContainerId, {
          id: foreignContainerId,
          image: foreignImage,
          name: containerName,
          user: '10001:10001'
        })
      }
      return { ...ok(), status: containerRemovalStatus }
    }
    throw new Error(`unexpected command: ${argv.join(' ')}`)
  }

  return {
    run,
    images,
    containers,
    record: {
      name: containerName,
      id: ownedContainerId,
      expectedImageId: image,
      expectedUser: '10001:10001',
      expectedNetworkMode: 'none',
      expectedReadonlyRootfs: true
    },
    tag,
    claim,
    image,
    foreignImage,
    foreignContainerId
  }
}

test('destructive nonzero results are superseded by proven final absence', async () => {
  const daemon = runtimeDaemon({
    imageRemovalStatus: 17,
    tagRemovalStatus: 17,
    containerRemovalStatus: 17
  })
  assert.deepEqual(await settleOwnedScratchContainer(daemon.run, daemon.record), [])
  assert.deepEqual(await settleClaimedRuntimeImage(daemon.run, {
    recoveryTag: daemon.tag,
    claimToken: daemon.claim,
    ownedImageId: daemon.image
  }), [])
  assert.equal(daemon.containers.size, 0)
  assert.equal(daemon.images.has(daemon.image), false)
})

test('a tagless current-run image is recovered from the exact claim and removed', async () => {
  const daemon = runtimeDaemon({ initialTags: [] })
  assert.deepEqual(await settleClaimedRuntimeImage(daemon.run, {
    recoveryTag: daemon.tag,
    claimToken: daemon.claim,
    ownedImageId: null
  }), [])
  assert.equal(daemon.images.has(daemon.image), false)
})

test('post-removal locator rebinding preserves the foreign object and fails fixed', async () => {
  const daemon = runtimeDaemon({
    rebindTagAfterImageRemoval: true,
    rebindContainerAfterRemoval: true
  })
  assert.deepEqual(
    await settleOwnedScratchContainer(daemon.run, daemon.record),
    ['owned runtime probe name changed or remained after cleanup']
  )
  assert.equal(daemon.containers.has(daemon.foreignContainerId), true)
  assert.deepEqual(
    await settleClaimedRuntimeImage(daemon.run, {
      recoveryTag: daemon.tag,
      claimToken: daemon.claim,
      ownedImageId: daemon.image
    }),
    ['owned recovery locator changed or remained after cleanup']
  )
  assert.equal(daemon.images.get(daemon.foreignImage).tags.includes(daemon.tag), true)
})

test('a foreign tag set on a current-run image is preserved and reported', async () => {
  const daemon = runtimeDaemon({ initialTags: ['foreign:test'] })
  assert.deepEqual(await settleClaimedRuntimeImage(daemon.run, {
    recoveryTag: daemon.tag,
    claimToken: daemon.claim,
    ownedImageId: null
  }), [
    'owned image claim or tag set drifted',
    'owned immutable image was not proven absent after cleanup'
  ])
  assert.equal(daemon.images.has(daemon.image), true)
  assert.deepEqual(daemon.images.get(daemon.image).tags, ['foreign:test'])
})
