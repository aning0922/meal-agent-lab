import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { ReactTestRenderer, ReactTestRendererJSON } from 'react-test-renderer'
import { act, create } from 'react-test-renderer'

import { householdIdSchema } from '@meal-agent/contracts'
import { authenticatedSessionSchema } from '@meal-agent/contracts/identity'

import { installAppServicesForPageTest } from '../../src/app-runtime'
import { createAppServices } from '../../src/core/app-services'
import MealsPage from '../../src/pages/meals'
import { FakePlatform } from '../support/fake-platform'
import {
  apiErrorBody,
  authenticatedSessionFixture,
  personProfileFixture,
  successEnvelope,
  T0,
  uuidV7
} from '../support/fixtures'

let cleanupServices: (() => void) | undefined
let renderer: ReactTestRenderer | undefined

afterEach(() => {
  renderer?.unmount()
  renderer = undefined
  cleanupServices?.()
  cleanupServices = undefined
})

const settleEffects = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

const textContent = (
  node: ReactTestRendererJSON | readonly ReactTestRendererJSON[] | null
): string => {
  if (node === null) return ''
  if (Array.isArray(node)) return node.map(textContent).join('')
  const element = node as ReactTestRendererJSON
  return (element.children ?? [])
    .map((child) =>
      typeof child === 'string'
        ? child
        : textContent(child as ReactTestRendererJSON)
    )
    .join('')
}

const buttonText = (instance: {
  readonly children: readonly unknown[]
}): string =>
  instance.children
    .flat(Number.POSITIVE_INFINITY)
    .filter((child): child is string => typeof child === 'string')
    .join('')

const digest = (seed: number): string =>
  `sha256:${seed.toString(16).padStart(64, '0')}`

const blockedRecommendation = () => ({
  id: uuidV7(70),
  householdId: uuidV7(10),
  outcome: 'no_feasible_option',
  participantProfileIds: [uuidV7(21)],
  cookProfileId: uuidV7(21),
  maximumTotalMinutes: 30,
  purchaseTolerance: 'none',
  suggestedDishCount: 1,
  candidates: [],
  preselectedCandidateIds: [],
  blockerCodes: ['menu.blocked.hard_constraint_allergy'],
  assumptions: [],
  snapshot: {
    inventory: { lots: [], inventoryDigest: digest(1) },
    constraints: {
      profiles: [],
      mappingReleaseId: 'synthetic-m4a-constraint-mapping-v1',
      constraintDigest: digest(2)
    },
    recipes: { recipes: [], recipeDigest: digest(3) },
    policies: {
      foodConceptReleaseId: 'synthetic-m4a-food-concepts-v1',
      allergenReleaseId: 'synthetic-m4a-allergens-v1',
      religiousEthicalReleaseId: 'synthetic-m4a-religious-ethical-v1',
      foodSafetyReleaseId: 'synthetic-m4a-food-safety-v1',
      techniqueReleaseId: 'synthetic-m4a-techniques-v1',
      recommendationEngineVersion: 'stage09p-m4a-menu-engine-v1',
      policyDigest: digest(4)
    },
    snapshotDigest: digest(5)
  },
  recommendationPolicyVersion: 'stage09p-m4a-recommendation-policy-v1',
  createdAt: T0,
  expiresAt: '2026-07-24T00:10:00.000Z'
})

// --- 共享夹具：登录 + 当前家庭，渲染页面 ---
const setupPage = (): {
  readonly platform: FakePlatform
  readonly services: ReturnType<typeof createAppServices>
} => {
  const platform = new FakePlatform()
  const services = createAppServices(platform, 'http://127.0.0.1:3000')
  services.session.save(
    authenticatedSessionSchema.parse(authenticatedSessionFixture())
  )
  services.session.saveCurrentHouseholdId(householdIdSchema.parse(uuidV7(10)))
  cleanupServices = installAppServicesForPageTest(services)
  return { platform, services }
}

const renderPage = async (): Promise<void> => {
  await act(async () => {
    renderer = create(<MealsPage />)
    await settleEffects()
  })
}

const pageText = (): string => textContent(renderer?.toJSON() ?? null)

const chipWithText = (label: string) =>
  renderer?.root
    .findAll((node) => String(node.type) === 'taro-text')
    .find((node) => buttonText(node).trim() === label)

const findButton = (label: string) =>
  renderer?.root
    .findAll((node) => String(node.type) === 'taro-button')
    .find((button) => buttonText(button) === label)

const participantAndCookResponse = () =>
  successEnvelope({
    viewerRole: 'owner',
    profiles: [personProfileFixture({ displayName: '成员甲' })]
  })

const selectProfileAndGenerate = async (): Promise<void> => {
  await act(async () => {
    chipWithText('成员甲')?.props['onClick']()
    chipWithText('成员甲 · 入门')?.props['onClick']()
  })
  const generate = findButton('生成推荐')
  assert.ok(generate)
  await act(async () => {
    generate.props['onClick']()
    await settleEffects()
  })
}

const recommendationWrites = (platform: FakePlatform) =>
  platform.sentRequests.filter(
    (request) =>
      request.method === 'POST' && request.url.endsWith('/recommendations')
  )

describe('MealsPage 今天吃什么', () => {
  it('加载：档案返回前展示加载态', async () => {
    const { platform } = setupPage()
    platform.enqueueResponse(new Promise<never>(() => undefined))

    await act(async () => {
      renderer = create(<MealsPage />)
    })

    assert.match(pageText(), /正在加载用餐档案/)
  })

  it('空：没有 active 档案时展示空态', async () => {
    const { platform } = setupPage()
    platform.enqueueJson(
      200,
      successEnvelope({ viewerRole: 'owner', profiles: [] })
    )

    await renderPage()

    assert.match(pageText(), /当前家庭还没有 active 用餐档案/)
  })

  it('未知：结果未知保留原命令（不可变 snapshot + key），重试复用同一 key', async () => {
    const { platform, services } = setupPage()
    platform.enqueueJson(200, participantAndCookResponse())
    platform.enqueueResponse(new Error('synthetic network failure'))

    await renderPage()
    await selectProfileAndGenerate()

    assert.match(pageText(), /上一次生成结果未知/)
    const envelope = services.pendingCommands.snapshot('recommendation:generate')
    assert.ok(envelope)
    assert.equal(envelope.command.kind, 'recommendation.generate')
    assert.equal(envelope.householdId, uuidV7(10))
    assert.deepEqual(envelope.command.payload, {
      householdId: uuidV7(10),
      draft: {
        participantProfileIds: [uuidV7(21)],
        cookProfileId: uuidV7(21),
        maximumTotalMinutes: 30,
        purchaseTolerance: 'none',
        suggestedDishCount: 1
      }
    })

    const key = envelope.key
    const before = recommendationWrites(platform)
    assert.equal(before.length, 1)
    assert.equal(before[0]?.headers['idempotency-key'], key)

    platform.enqueueJson(201, successEnvelope(blockedRecommendation()))
    const retry = findButton('重试原生成')
    assert.ok(retry)
    await act(async () => {
      retry.props['onClick']()
      await settleEffects()
    })
    const after = recommendationWrites(platform)
    assert.equal(after.length, 2, 'retry must resend exactly once')
    assert.equal(
      after[1]?.headers['idempotency-key'],
      key,
      'retry must reuse the envelope key'
    )
  })

  it('失败：确定性 API 失败原地展示并清除未决命令', async () => {
    const { platform, services } = setupPage()
    platform.enqueueJson(200, participantAndCookResponse())
    platform.enqueueJson(400, apiErrorBody('VALIDATION_FAILED'))

    await renderPage()
    await selectProfileAndGenerate()

    assert.match(pageText(), /提交内容未通过服务端校验/)
    assert.doesNotMatch(pageText(), /上一次生成结果未知/)
    assert.equal(services.pendingCommands.status().phase, 'idle')
  })

  it('无权限：403 FORBIDDEN 展示权限文案', async () => {
    const { platform } = setupPage()
    platform.enqueueJson(200, participantAndCookResponse())
    platform.enqueueJson(403, apiErrorBody('FORBIDDEN'))

    await renderPage()
    await selectProfileAndGenerate()

    assert.match(pageText(), /当前身份没有生成推荐的权限/)
  })

  it('阻断是首页级的安全结果，展示 blocker 而不是错误屏幕', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, 'http://127.0.0.1:3000')
    services.session.save(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    services.session.saveCurrentHouseholdId(householdIdSchema.parse(uuidV7(10)))
    platform.enqueueJson(
      200,
      successEnvelope({
        viewerRole: 'owner',
        profiles: [personProfileFixture({ displayName: '成员甲' })]
      })
    )
    platform.enqueueJson(201, successEnvelope(blockedRecommendation()))
    cleanupServices = installAppServicesForPageTest(services)

    await act(async () => {
      renderer = create(<MealsPage />)
      await settleEffects()
    })

    const text = (): string => textContent(renderer?.toJSON() ?? null)
    assert.match(text(), /用餐者/)

    const chipWithText = (label: string) =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-text')
        .find((node) => buttonText(node).trim() === label)

    await act(async () => {
      chipWithText('成员甲')?.props['onClick']()
      chipWithText('成员甲 · 入门')?.props['onClick']()
    })

    const generate = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '生成推荐')
    assert.ok(generate)
    await act(async () => {
      generate.props['onClick']()
      await settleEffects()
    })

    const writes = platform.sentRequests.filter(
      (request) =>
        request.method === 'POST' &&
        request.url.endsWith('/recommendations')
    )
    assert.equal(writes.length, 1)
    const rendered = text()
    assert.match(rendered, /安全阻断/)
    assert.match(rendered, /全桌过敏原硬约束命中/)
    assert.doesNotMatch(rendered, /网络连接失败/)
    assert.equal(services.pendingCommands.status().phase, 'idle')
  })
})
