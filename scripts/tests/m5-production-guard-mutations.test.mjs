import assert from 'node:assert/strict'
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '../..')

const replaceExactly = (source, needle, replacement) => {
  const first = source.indexOf(needle)
  assert.notEqual(first, -1, `production mutation anchor disappeared: ${needle}`)
  assert.equal(source.indexOf(needle, first + needle.length), -1, `mutation anchor duplicated: ${needle}`)
  return source.slice(0, first) + replacement + source.slice(first + needle.length)
}

const importFresh = (path, label) =>
  import(`${pathToFileURL(path).href}?mutation=${encodeURIComponent(label)}-${Date.now()}`)

test('the pre-fork declaration guard is killed by an in-flight cleanup oracle', async () => {
  const sourcePath = resolve(repositoryRoot, 'infra/docker/m5-evidence-protocol.mjs')
  const source = readFileSync(sourcePath, 'utf8')
  const mutant = replaceExactly(
    source,
    'for (const target of targets) declareOwnedTreeOutput(journal, target)',
    'for (const target of targets) void target'
  )
  const directory = mkdtempSync(join(tmpdir(), 'm5-declaration-mutant-'))
  const modulePath = join(directory, 'protocol.mjs')
  writeFileSync(modulePath, mutant)
  const implementation = await importFresh(modulePath, 'declaration')
  const ownedRoot = mkdtempSync(join(tmpdir(), 'm5-declaration-oracle-'))
  const output = join(ownedRoot, 'producer.out')
  try {
    const journal = implementation.createOwnedTreeJournal(ownedRoot)
    await assert.rejects(
      implementation.runWithDeclaredOwnedTreeOutputs(journal, [output], async () => {
        writeFileSync(output, 'bytes before producer settlement')
        implementation.retireOwnedTree(journal)
      }),
      (error) =>
        error instanceof implementation.EvidenceProtocolError &&
        error.code === 'owned-tree-entry-drift'
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(ownedRoot, { recursive: true, force: true })
  }
})

test('the production link-count guards reject a multi-link publication mutant', async () => {
  const sourcePath = resolve(repositoryRoot, 'infra/docker/m5-evidence-protocol.mjs')
  let mutant = readFileSync(sourcePath, 'utf8')
  for (const guard of [
    'staged.nlink !== 2n',
    'published.nlink !== 2n',
    'solePublished.nlink !== 1n'
  ]) {
    mutant = replaceExactly(mutant, guard, 'false')
  }
  const directory = mkdtempSync(join(tmpdir(), 'm5-nlink-mutant-'))
  const modulePath = join(directory, 'protocol.mjs')
  writeFileSync(modulePath, mutant)
  const implementation = await importFresh(modulePath, 'nlink')
  const path = join(directory, 'artifact')
  const alias = join(directory, 'external-alias')
  const operations = {
    closeFile: closeSync,
    linkFile: (source, destination) => {
      linkSync(source, destination)
      linkSync(source, alias)
    },
    syncDirectory: () => undefined,
    syncFile: fsyncSync,
    unlinkFile: unlinkSync
  }
  try {
    const bytes = Buffer.from('durable mutation bytes')
    const identity = implementation.writeExclusiveEvidenceFile(path, bytes, { operations })
    assert.equal(lstatSync(path, { bigint: true }).nlink, 2n)
    assert.equal(implementation.verifyPublishedFileEvidence(identity, bytes), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('scratch capability fields are production data, not optional call-site decoration', async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'm5-scratch-capability-mutant-'))
  const copiedDockerDirectory = join(temporaryRoot, 'infra/docker')
  cpSync(resolve(repositoryRoot, 'infra/docker'), copiedDockerDirectory, { recursive: true })
  const modulePath = join(copiedDockerDirectory, 'api-image-scan.mjs')
  const original = readFileSync(modulePath, 'utf8')
  const helperStart = original.indexOf('export const scratchCapabilityExpectation')
  const helperEnd = original.indexOf('export const parseImageHistory', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)
  const helper = original.slice(helperStart, helperEnd)
  const imageId = `sha256:${'a'.repeat(64)}`
  const containerId = 'b'.repeat(64)
  const name = 'fixture'
  const payload = JSON.stringify([{
    Id: containerId,
    Image: imageId,
    Name: `/${name}`,
    Path: 'node',
    Config: { User: '10001:10001', Labels: { 'meal-agent.m5.owner': name } },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true }
  }])
  try {
    for (const [field, line] of [
      ['user', '  expectedUser: user,\n'],
      ['network', "  expectedNetworkMode: 'none',\n"],
      ['readonly', '  expectedReadonlyRootfs: true\n']
    ]) {
      const mutantHelper = replaceExactly(helper, line, '')
      writeFileSync(
        modulePath,
        original.slice(0, helperStart) + mutantHelper + original.slice(helperEnd)
      )
      const implementation = await importFresh(modulePath, field)
      const expectation = implementation.scratchCapabilityExpectation({
        name,
        imageId,
        containerId,
        user: '10001:10001'
      })
      assert.throws(
        () => implementation.parseOwnedScratchContainer(
          payload,
          expectation,
          (message) => { throw new Error(message) }
        ),
        /scratch container identity did not match this run/
      )
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('mutation fixtures leave no production evidence names behind', () => {
  assert.equal(existsSync(resolve(repositoryRoot, 'm5-declaration-mutant')), false)
})
