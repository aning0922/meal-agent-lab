import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { ReactTestRenderer, ReactTestRendererJSON } from 'react-test-renderer'
import { act, create } from 'react-test-renderer'

import {
  householdIdSchema,
  membershipIdSchema
} from '@meal-agent/contracts'
import { authenticatedSessionSchema } from '@meal-agent/contracts/identity'

import { installAppServicesForPageTest } from '../../src/app-runtime'
import { PendingCommandRecovery } from '../../src/components/pending-command-recovery'
import { createAppServices } from '../../src/core/app-services'
import { HOUSEHOLDS_ROUTE } from '../../src/platform/ports'
import HouseholdsPage from '../../src/pages/households'
import InventoryPage from '../../src/pages/inventory'
import MembersPage from '../../src/pages/members'
import ProfilePage from '../../src/pages/profile'
import { FakePlatform } from '../support/fake-platform'
import {
  authenticatedSessionFixture,
  apiErrorBody,
  createHouseholdInviteResultFixture,
  getPersonProfileResultFixture,
  hardConstraintFixture,
  INVITE_CODE,
  joinHouseholdResultFixture,
  createHouseholdResultFixture,
  householdFixture,
  householdInviteFixture,
  inventoryLotFixture,
  memberMembersViewFixture,
  membershipFixture,
  ownerMembersViewFixture,
  personProfileFixture,
  removeMembershipResultFixture,
  successEnvelope,
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

const renderWithServices = (
  Page: () => JSX.Element,
  responses: readonly { readonly status: number; readonly body: unknown }[]
) => {
  const platform = new FakePlatform()
  const services = createAppServices(platform, 'http://127.0.0.1:3000')
  services.session.save(
    authenticatedSessionSchema.parse(authenticatedSessionFixture())
  )
  services.session.saveCurrentHouseholdId(householdIdSchema.parse(uuidV7(10)))
  for (const response of responses) {
    platform.enqueueJson(response.status, response.body)
  }
  cleanupServices = installAppServicesForPageTest(services)
  return { Page, platform, services }
}

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

const requireRenderer = (): ReactTestRenderer => {
  assert.ok(renderer)
  return renderer
}

const requireCleanup = (): (() => void) => {
  assert.ok(cleanupServices)
  return cleanupServices
}

describe('真实页面渲染回归', () => {
  it('全局恢复入口在原生 Back 后仍从 registry snapshot 重试原命令', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, 'http://127.0.0.1:3000')
    services.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    platform.enqueueResponse(new Error('lost create response'))
    await services.commands.execute(
      'household:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '原始家庭', ownerDisplayName: '原始成员' }
      }
    )
    // 模拟宿主原生 Back 绕过程序化 navigation port；coordinator 仍在 app
    // service 中持有 envelope，恢复入口不依赖原页面闭包。
    await platform.navigation.navigateBack()
    platform.enqueueJson(
      201,
      successEnvelope(createHouseholdResultFixture())
    )
    cleanupServices = installAppServicesForPageTest(services)

    await act(async () => {
      renderer = create(<PendingCommandRecovery />)
    })
    assert.ok(renderer)
    const retry = renderer.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '重试原命令')
    assert.ok(retry)
    const beforeRetry = platform.sentRequests.length
    await act(async () => {
      retry.props['onClick']()
      await settleEffects()
    })
    assert.equal(platform.sentRequests.length, beforeRetry + 1)
    const writes = platform.sentRequests.filter(
      (request) =>
        request.method === 'POST' && request.url.endsWith('/households')
    )
    assert.equal(writes.length, 2)
    assert.equal(
      writes[0]?.headers['idempotency-key'],
      writes[1]?.headers['idempotency-key']
    )
    assert.equal(writes[0]?.body, writes[1]?.body)
    assert.equal(
      services.session.restoreCurrentHouseholdId(),
      createHouseholdResultFixture().household.id
    )
    assert.deepEqual(platform.navigations.at(-1), {
      kind: 'reLaunch',
      route: '/pages/inventory/index'
    })
    assert.match(
      textContent(renderer.toJSON()),
      /家庭已创建，已切换到该家庭/
    )
    assert.ok(
      renderer.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((button) => buttonText(button) === '知道了')
    )
  })

  it('全局恢复交付一次性邀请码明文，并在安全重放无明文时保留撤销重建引导', async () => {
    const setup = async (withSecret: boolean) => {
      const platform = new FakePlatform()
      const services = createAppServices(
        platform,
        'http://127.0.0.1:3000'
      )
      services.authenticate(
        authenticatedSessionSchema.parse(authenticatedSessionFixture())
      )
      const householdId = householdIdSchema.parse(uuidV7(10))
      platform.enqueueResponse(new Error('lost invite response'))
      await services.commands.execute(
        `invite:create:${withSecret ? 'secret' : 'replay'}`,
        '/pages/members/index',
        {
          kind: 'invite.create',
          payload: {
            householdId,
            draft: { maxUses: 1, expiresInHours: 24 }
          }
        }
      )
      platform.enqueueJson(
        201,
        successEnvelope(
          withSecret
            ? createHouseholdInviteResultFixture()
            : { invite: householdInviteFixture() }
        )
      )
      cleanupServices = installAppServicesForPageTest(services)
      await act(async () => {
        renderer = create(<PendingCommandRecovery />)
      })
      const activeRenderer = requireRenderer()
      const retry = activeRenderer.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((button) => buttonText(button) === '重试原命令')
      assert.ok(retry)
      await act(async () => {
        retry.props['onClick']()
        await settleEffects()
      })
      return textContent(activeRenderer.toJSON())
    }

    const secretText = await setup(true)
    assert.match(secretText, new RegExp(INVITE_CODE))
    assert.match(secretText, /只显示这一次/)
    renderer?.unmount()
    cleanupServices?.()
    renderer = undefined
    cleanupServices = undefined

    const replayText = await setup(false)
    assert.doesNotMatch(replayText, new RegExp(INVITE_CODE))
    assert.match(replayText, /撤销该邀请.*新邀请/)
  })

  it('全局恢复 self-exit 后清家庭上下文、离开家庭并展示归档保留语义', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, 'http://127.0.0.1:3000')
    services.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    const householdId = householdIdSchema.parse(uuidV7(10))
    const membershipId = membershipIdSchema.parse(
      membershipFixture({ sequence: 20 }).id
    )
    services.session.saveCurrentHouseholdId(householdId)
    platform.enqueueResponse(new Error('lost exit response'))
    await services.commands.execute(
      'membership:remove:self',
      '/pages/members/index',
      {
        kind: 'membership.remove',
        payload: { householdId, membershipId, isSelf: true }
      }
    )
    platform.enqueueJson(
      200,
      successEnvelope(removeMembershipResultFixture('left'))
    )
    cleanupServices = installAppServicesForPageTest(services)
    await act(async () => {
      renderer = create(<PendingCommandRecovery />)
    })
    const activeRenderer = requireRenderer()
    const retry = activeRenderer.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '重试原命令')
    assert.ok(retry)
    await act(async () => {
      retry.props['onClick']()
      await settleEffects()
    })

    assert.equal(services.session.restoreCurrentHouseholdId(), null)
    assert.deepEqual(platform.navigations.at(-1), {
      kind: 'reLaunch',
      route: HOUSEHOLDS_ROUTE
    })
    assert.match(
      textContent(activeRenderer.toJSON()),
      /档案已归档并保留.*不会自动恢复/
    )
  })

  it('全局恢复 join 后切换家庭，确定失败和认证暂停都有可见状态', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, 'http://127.0.0.1:3000')
    services.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    platform.enqueueResponse(new Error('lost join response'))
    await services.commands.execute(
      'household:join',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.join',
        payload: { inviteCode: INVITE_CODE }
      }
    )
    platform.enqueueJson(200, successEnvelope(joinHouseholdResultFixture()))
    cleanupServices = installAppServicesForPageTest(services)
    await act(async () => {
      renderer = create(<PendingCommandRecovery />)
    })
    let activeRenderer = requireRenderer()
    assert.match(textContent(activeRenderer.toJSON()), /结果未知/)
    const retry = activeRenderer.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '重试原命令')
    assert.ok(retry)
    await act(async () => {
      retry.props['onClick']()
      await settleEffects()
    })
    assert.equal(
      services.session.restoreCurrentHouseholdId(),
      joinHouseholdResultFixture().household.id
    )
    assert.match(textContent(activeRenderer.toJSON()), /已加入家庭并切换到成员页/)

    activeRenderer.unmount()
    requireCleanup()()
    renderer = undefined
    cleanupServices = undefined

    const forbiddenPlatform = new FakePlatform()
    const forbiddenServices = createAppServices(
      forbiddenPlatform,
      'http://127.0.0.1:3000'
    )
    forbiddenServices.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    const householdId = householdIdSchema.parse(uuidV7(10))
    forbiddenPlatform.enqueueResponse(new Error('lost invite response'))
    await forbiddenServices.commands.execute(
      'invite:create:forbidden',
      '/pages/members/index',
      {
        kind: 'invite.create',
        payload: {
          householdId,
          draft: { maxUses: 1, expiresInHours: 24 }
        }
      }
    )
    forbiddenPlatform.enqueueJson(403, apiErrorBody('FORBIDDEN'))
    cleanupServices = installAppServicesForPageTest(forbiddenServices)
    await act(async () => {
      renderer = create(<PendingCommandRecovery />)
    })
    activeRenderer = requireRenderer()
    const forbiddenRetry = activeRenderer.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '重试原命令')
    assert.ok(forbiddenRetry)
    await act(async () => {
      forbiddenRetry.props['onClick']()
      await settleEffects()
    })
    assert.match(textContent(activeRenderer.toJSON()), /只有家庭所有者/)
    assert.equal(forbiddenServices.pendingCommands.status().phase, 'idle')

    activeRenderer.unmount()
    requireCleanup()()
    renderer = undefined
    cleanupServices = undefined

    const suspendedPlatform = new FakePlatform()
    const suspendedServices = createAppServices(
      suspendedPlatform,
      'http://127.0.0.1:3000'
    )
    suspendedServices.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    suspendedPlatform.enqueueResponse(new Error('lost create response'))
    await suspendedServices.commands.execute(
      'household:create:suspended',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '暂停家庭', ownerDisplayName: '成员甲' }
      }
    )
    suspendedServices.pendingCommands.suspendForAuthentication()
    cleanupServices = installAppServicesForPageTest(suspendedServices)
    await act(async () => {
      renderer = create(<PendingCommandRecovery />)
    })
    assert.match(
      textContent(requireRenderer().toJSON()),
      /会话已暂停.*原账号/
    )
  })

  it('全局 retry 清除 pending 后，相关真实页面通过订阅重新渲染并解除禁用', async () => {
    const platform = new FakePlatform()
    const services = createAppServices(platform, 'http://127.0.0.1:3000')
    services.authenticate(
      authenticatedSessionSchema.parse(authenticatedSessionFixture())
    )
    platform.enqueueResponse(new Error('lost create response'))
    await services.commands.execute(
      'household:create',
      HOUSEHOLDS_ROUTE,
      {
        kind: 'household.create',
        payload: { name: '恢复家庭', ownerDisplayName: '成员甲' }
      }
    )
    platform.enqueueJson(
      200,
      successEnvelope({
        items: [],
        pageInfo: { nextCursor: null, hasMore: false }
      })
    )
    platform.enqueueJson(
      201,
      successEnvelope(createHouseholdResultFixture())
    )
    cleanupServices = installAppServicesForPageTest(services)
    await act(async () => {
      renderer = create(
        <>
          <HouseholdsPage />
          <PendingCommandRecovery />
        </>
      )
      await settleEffects()
    })
    const householdName = () =>
      requireRenderer().root
        .findAll((node) => String(node.type) === 'taro-input')
        .find((input) => input.props['placeholder'] === '例如：我家')
    assert.equal(householdName()?.props['disabled'], true)
    const retry = requireRenderer().root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '重试原命令')
    assert.ok(retry)
    await act(async () => {
      retry.props['onClick']()
      await settleEffects()
    })
    assert.equal(services.pendingCommands.status().phase, 'idle')
    assert.equal(householdName()?.props['disabled'], false)
    assert.match(
      textContent(requireRenderer().toJSON()),
      /家庭已创建，已切换到该家庭/
    )
  })

  it('HouseholdsPage 明示新成员事实为未知且不再展示推测默认值', async () => {
    const { Page } = renderWithServices(HouseholdsPage, [
      {
        status: 200,
        body: successEnvelope({
          items: [],
          pageInfo: { nextCursor: null, hasMore: false }
        })
      }
    ])

    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })

    const pageText = textContent(renderer?.toJSON() ?? null)
    assert.match(pageText, /饭量、默认参与和厨艺默认未知/)
    assert.doesNotMatch(pageText, /厨艺默认 beginner/)
  })

  it('HouseholdsPage 对同一次加入动作的可重试失败复用幂等键', async () => {
    const { Page, platform } = renderWithServices(HouseholdsPage, [
      {
        status: 200,
        body: successEnvelope({
          items: [],
          pageInfo: { nextCursor: null, hasMore: false }
        })
      }
    ])
    platform.enqueueResponse(new Error('temporary network failure'))
    platform.enqueueJson(
      200,
      successEnvelope(joinHouseholdResultFixture())
    )

    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })

    const inviteInput = renderer?.root
      .findAll((node) => String(node.type) === 'taro-input')
      .find((input) => input.props['placeholder'] === '粘贴家庭所有者提供的邀请码')
    assert.ok(inviteInput)
    await act(async () => {
      inviteInput.props['onInput']({ detail: { value: INVITE_CODE } })
    })

    const joinButton = () =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((button) => buttonText(button) === '加入家庭')

    await act(async () => {
      joinButton()?.props['onClick']()
      await settleEffects()
    })
    const frozenInvite = renderer?.root
      .findAll((node) => String(node.type) === 'taro-input')
      .find((input) => input.props['placeholder'] === '粘贴家庭所有者提供的邀请码')
    assert.equal(frozenInvite?.props['disabled'], true)
    await act(async () => {
      joinButton()?.props['onClick']()
      await settleEffects()
    })

    const joinRequests = platform.sentRequests.filter((request) =>
      request.url.endsWith('/households/join')
    )
    assert.equal(joinRequests.length, 2)
    assert.equal(
      joinRequests[0]?.headers['idempotency-key'],
      joinRequests[1]?.headers['idempotency-key']
    )
  })

  it('HouseholdsPage 创建结果未知时冻结表单并复用不可变请求', async () => {
    const { Page, platform } = renderWithServices(HouseholdsPage, [
      {
        status: 200,
        body: successEnvelope({
          items: [],
          pageInfo: { nextCursor: null, hasMore: false }
        })
      }
    ])
    platform.enqueueResponse(new Error('lost create response'))
    platform.enqueueJson(
      201,
      successEnvelope(createHouseholdResultFixture())
    )
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })
    const inputFor = (placeholder: string) =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-input')
        .find((input) => input.props['placeholder'] === placeholder)
    await act(async () => {
      inputFor('例如：我家')?.props['onInput']({
        detail: { value: '测试家庭' }
      })
      inputFor('例如：小明')?.props['onInput']({
        detail: { value: '测试成员' }
      })
    })
    const createButton = () =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((button) => buttonText(button) === '创建家庭')
    await act(async () => {
      createButton()?.props['onClick']()
      await settleEffects()
    })
    assert.equal(inputFor('例如：我家')?.props['disabled'], true)
    await act(async () => {
      createButton()?.props['onClick']()
      await settleEffects()
    })
    const requests = platform.sentRequests.filter(
      (request) =>
        request.method === 'POST' &&
        request.url.endsWith('/households')
    )
    assert.equal(requests.length, 2)
    assert.equal(
      requests[0]?.headers['idempotency-key'],
      requests[1]?.headers['idempotency-key']
    )
    assert.equal(requests[0]?.body, requests[1]?.body)
  })

  it('HouseholdsPage create/join 共享 app 级 pending，未知时阻止交叉动作和离页', async () => {
    const existing = householdFixture()
    const { Page, platform } = renderWithServices(HouseholdsPage, [
      {
        status: 200,
        body: successEnvelope({
          items: [existing],
          pageInfo: { nextCursor: null, hasMore: false }
        })
      }
    ])
    platform.enqueueResponse(new Error('lost household create response'))
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })
    const inputs = renderer?.root.findAll(
      (node) => String(node.type) === 'taro-input'
    ) ?? []
    const inputFor = (placeholder: string) =>
      inputs.find((input) => input.props['placeholder'] === placeholder)
    await act(async () => {
      inputFor('例如：我家')?.props['onInput']({
        detail: { value: '未知结果家庭' }
      })
      inputFor('例如：小明')?.props['onInput']({
        detail: { value: '测试成员' }
      })
    })
    const button = (text: string) =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((candidate) => buttonText(candidate) === text)
    await act(async () => {
      button('创建家庭')?.props['onClick']()
      await settleEffects()
    })
    assert.equal(
      inputFor('粘贴家庭所有者提供的邀请码')?.props['disabled'],
      true
    )
    assert.equal(button('加入家庭')?.props['disabled'], true)
    await act(async () => {
      button('加入家庭')?.props['onClick']()
      button('库存')?.props['onClick']()
      await settleEffects()
    })
    assert.equal(
      platform.sentRequests.filter((request) =>
        request.url.endsWith('/households/join')
      ).length,
      0
    )
    assert.deepEqual(platform.navigations, [])
  })

  it('InventoryPage 消耗结果未知时冻结数量并用原 key 重试，避免重复扣减', async () => {
    const lot = inventoryLotFixture({ amount: '12', version: 1 })
    const otherLot = inventoryLotFixture({ sequence: 31, amount: '8' })
    const { Page, platform } = renderWithServices(InventoryPage, [
      {
        status: 200,
        body: successEnvelope({
          items: [lot, otherLot],
          pageInfo: { nextCursor: null, hasMore: false }
        })
      }
    ])
    platform.enqueueResponse(new Error('lost consume response'))
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })
    const consumeButton = () =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((button) => buttonText(button) === '消耗')
    await act(async () => consumeButton()?.props['onClick']())
    const amountInput = () =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-input')
        .find((input) => input.props['placeholder'] === '例如：2')
    await act(async () => {
      amountInput()?.props['onInput']({ detail: { value: '2' } })
    })
    const submit = () =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((button) => buttonText(button) === '确认消耗')
    await act(async () => {
      submit()?.props['onClick']()
      await settleEffects()
    })
    assert.equal(amountInput()?.props['disabled'], true)
    const switchLot = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '消耗')
    assert.equal(switchLot?.props['disabled'], true)

    platform.enqueueJson(
      200,
      successEnvelope({
        items: [{ ...lot, version: 9 }, otherLot],
        pageInfo: { nextCursor: null, hasMore: false }
      })
    )
    const reconcile = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '刷新库存（仅观察）')
    assert.ok(reconcile)
    await act(async () => {
      reconcile.props['onClick']()
      await settleEffects()
    })
    platform.enqueueResponse(new Error('retry response also lost'))
    const retryOriginal = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '重试原消耗')
    assert.ok(retryOriginal)
    await act(async () => {
      retryOriginal.props['onClick']()
      await settleEffects()
    })
    const requests = platform.sentRequests.filter((request) =>
      request.url.includes('/events/consumed')
    )
    assert.equal(requests.length, 2)
    assert.equal(
      requests[0]?.headers['idempotency-key'],
      requests[1]?.headers['idempotency-key']
    )
    assert.equal(requests[0]?.body, requests[1]?.body)
    assert.match(requests[0]?.body ?? '', /"expectedVersion":1/)
    assert.doesNotMatch(requests[1]?.body ?? '', /"expectedVersion":9/)
    assert.match(
      textContent(renderer?.toJSON() ?? null),
      /消耗结果未知/
    )
  })

  it('InventoryPage GET 失败不开放完成或放弃未知命令', async () => {
    const lot = inventoryLotFixture({ amount: '12', version: 1 })
    const { Page, platform } = renderWithServices(InventoryPage, [
      {
        status: 200,
        body: successEnvelope({
          items: [lot],
          pageInfo: { nextCursor: null, hasMore: false }
        })
      }
    ])
    platform.enqueueResponse(new Error('lost consume response'))
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })
    const button = (text: string) =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((candidate) => buttonText(candidate) === text)
    await act(async () => button('消耗')?.props['onClick']())
    const amount = renderer?.root
      .findAll((node) => String(node.type) === 'taro-input')
      .find((input) => input.props['placeholder'] === '例如：2')
    await act(async () => {
      amount?.props['onInput']({ detail: { value: '2' } })
      button('确认消耗')?.props['onClick']()
      await settleEffects()
    })
    platform.enqueueResponse(new Error('GET inventory failed'))
    await act(async () => {
      button('刷新库存对账')?.props['onClick']()
      await settleEffects()
    })
    const allButtonText = (
      renderer?.root.findAll(
        (node) => String(node.type) === 'taro-button'
      ) ?? []
    ).map(buttonText)
    assert.equal(allButtonText.includes('对账确认已完成'), false)
    assert.equal(allButtonText.includes('确认未执行并放弃旧动作'), false)
  })

  it('MembersPage 在 owner 视图正确标记本人，且保护最后一位 owner', async () => {
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 1
    })
    const view = ownerMembersViewFixture([
      {
        membership: ownerMembership,
        profile: personProfileFixture({ membershipSeq: 20 })
      }
    ])
    const { Page } = renderWithServices(MembersPage, [
      { status: 200, body: successEnvelope(view) }
    ])

    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })

    const pageText = textContent(renderer?.toJSON() ?? null)
    assert.match(pageText, /成员甲（我） · owner/)
    assert.match(pageText, /最后一位所有者不可退出/)
    assert.match(pageText, /邀请管理/)
  })

  it('MembersPage 邀请创建响应丢失后用原 key 识别已创建邀请并引导撤销重建', async () => {
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 1
    })
    const { Page, platform } = renderWithServices(MembersPage, [
      {
        status: 200,
        body: successEnvelope(
          ownerMembersViewFixture([
            {
              membership: ownerMembership,
              profile: personProfileFixture({ membershipSeq: 20 })
            }
          ])
        )
      }
    ])
    platform.enqueueResponse(new Error('lost invite response'))
    platform.enqueueJson(
      201,
      successEnvelope(
        { invite: householdInviteFixture() },
        {
          idempotency: {
            key: 'placeholder-replaced-by-client',
            scope: 'household',
            replayed: true,
            firstProcessedAt: '2026-07-24T00:00:00.000Z',
            originalRequestId: '3f2b8c1d-9e4a-4c6b-8d7e-5a1b2c3d4e5f'
          }
        }
      )
    )
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })
    const generate = () =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((candidate) => buttonText(candidate) === '生成邀请码')
    const firstGenerate = generate()
    assert.ok(firstGenerate)
    await act(async () => {
      firstGenerate.props['onClick']()
      await settleEffects()
      const retryGenerate = generate()
      assert.ok(retryGenerate)
      const beforeRetry = platform.sentRequests.length
      retryGenerate.props['onClick']()
      await settleEffects()
      assert.equal(platform.sentRequests.length, beforeRetry + 1)
    })
    const requests = platform.sentRequests.filter((request) =>
      request.url.endsWith('/invites') &&
      request.method === 'POST'
    )
    assert.equal(requests.length, 2)
    assert.equal(
      requests[0]?.headers['idempotency-key'],
      requests[1]?.headers['idempotency-key']
    )
    assert.match(
      textContent(renderer?.toJSON() ?? null),
      /请撤销此邀请后重新生成/
    )
    assert.ok(
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((candidate) => buttonText(candidate) === '撤销此邀请')
    )
  })

  it('MembersPage 明确 403 会释放旧命令，按钮真实存在且下一次点击确实发出新请求', async () => {
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 1
    })
    const { Page, platform, services } = renderWithServices(MembersPage, [
      {
        status: 200,
        body: successEnvelope(
          ownerMembersViewFixture([
            {
              membership: ownerMembership,
              profile: personProfileFixture({ membershipSeq: 20 })
            }
          ])
        )
      },
      { status: 403, body: apiErrorBody('FORBIDDEN') },
      {
        status: 201,
        body: successEnvelope({
          invite: householdInviteFixture(),
          inviteCode: INVITE_CODE
        })
      }
    ])
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })
    const findGenerate = () =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((button) => buttonText(button) === '生成邀请码')

    const first = findGenerate()
    assert.ok(first)
    const beforeFirst = platform.sentRequests.length
    await act(async () => {
      first.props['onClick']()
      await settleEffects()
    })
    assert.equal(platform.sentRequests.length, beforeFirst + 1)
    assert.equal(services.pendingCommands.status().phase, 'idle')

    const second = findGenerate()
    assert.ok(second)
    const beforeSecond = platform.sentRequests.length
    await act(async () => {
      second.props['onClick']()
      await settleEffects()
    })
    assert.equal(platform.sentRequests.length, beforeSecond + 1)
    const inviteRequests = platform.sentRequests.filter(
      (request) =>
        request.method === 'POST' && request.url.endsWith('/invites')
    )
    assert.equal(inviteRequests.length, 2)
    assert.notEqual(
      inviteRequests[0]?.headers['idempotency-key'],
      inviteRequests[1]?.headers['idempotency-key']
    )
  })

  it('ProfilePage 渲染 FAM003/004/005 范围，并让字段变化使硬约束确认失效', async () => {
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 1
    })
    const activeProfile = personProfileFixture({
      membershipSeq: 20,
      dietaryConstraints: [
        hardConstraintFixture({
          kind: 'food_safety_exclusion',
          label: '虚构安全排除',
          allergenCodes: [],
          mappingStatus: 'needs_structured_mapping'
        })
      ]
    })
    const diningOnly = {
      ...personProfileFixture({
        sequence: 23,
        membershipSeq: 23,
        displayName: '访客'
      }),
      linkedMembershipId: undefined,
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null
    }
    const view = ownerMembersViewFixture([
      { membership: ownerMembership, profile: activeProfile }
    ])
    const { Page } = renderWithServices(ProfilePage, [
      { status: 200, body: successEnvelope(view) },
      {
        status: 200,
        body: successEnvelope({
          viewerRole: 'owner',
          profiles: [activeProfile, diningOnly]
        })
      },
      { status: 200, body: successEnvelope({ requests: [] }) }
    ])

    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })

    const pageText = textContent(renderer?.toJSON() ?? null)
    assert.match(pageText, /新建仅用餐档案/)
    assert.match(pageText, /新建时饭量、默认参与和厨艺均为“未知”/)
    assert.match(pageText, /过敏宗教伦理明确忌口食品安全排除/)
    assert.match(pageText, /待权威结构化映射；推荐必须阻断/)
    assert.match(pageText, /保存档案事实/)

    const enterConfirmation = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '进入硬约束确认')
    assert.ok(enterConfirmation)
    await act(async () => {
      enterConfirmation.props['onClick']()
    })
    assert.match(textContent(renderer?.toJSON() ?? null), /确认全部字段并登记/)

    const visibility = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button).startsWith('可见性：'))
    assert.ok(visibility)
    await act(async () => {
      visibility.props['onClick']()
    })
    const changedText = textContent(renderer?.toJSON() ?? null)
    assert.match(changedText, /进入硬约束确认/)
    assert.doesNotMatch(changedText, /确认全部字段并登记/)
  })

  it('ProfilePage 对 archived 档案提供原 ID 恢复入口', async () => {
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 1
    })
    const archived = personProfileFixture({
      membershipSeq: 20,
      status: 'archived',
      version: 4
    })
    const { Page } = renderWithServices(ProfilePage, [
      {
        status: 200,
        body: successEnvelope(
          ownerMembersViewFixture([
            { membership: ownerMembership, profile: archived }
          ])
        )
      },
      {
        status: 200,
        body: successEnvelope({
          viewerRole: 'owner',
          profiles: [archived]
        })
      },
      { status: 200, body: successEnvelope({ requests: [] }) }
    ])

    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })

    const pageText = textContent(renderer?.toJSON() ?? null)
    assert.match(pageText, /成员甲 · 已归档/)
    assert.match(pageText, /恢复原档案/)
    assert.match(pageText, /状态 archived · 版本 4/)
  })

  it('MembersPage 在退出与移除前说明档案归档、保留和重新加入语义', async () => {
    const selfOwner = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 1
    })
    const otherOwner = membershipFixture({
      role: 'owner',
      sequence: 22,
      userSeq: 2
    })
    const { Page } = renderWithServices(MembersPage, [
      {
        status: 200,
        body: successEnvelope(
          ownerMembersViewFixture([
            {
              membership: selfOwner,
              profile: personProfileFixture({ membershipSeq: 20 })
            },
            {
              membership: otherOwner,
              profile: personProfileFixture({
                sequence: 23,
                membershipSeq: 22,
                displayName: '另一所有者'
              })
            }
          ])
        )
      }
    ])
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })

    const exit = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '退出家庭')
    assert.ok(exit)
    await act(async () => exit.props['onClick']())
    const warning = textContent(renderer?.toJSON() ?? null)
    assert.match(warning, /关联档案将立即归档/)
    assert.match(warning, /数据按既定保留策略保留/)
    assert.match(warning, /重新加入不会自动恢复/)
  })

  it('ProfilePage 不可恢复时禁用按钮并说明重新加入后仍须显式恢复', async () => {
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 1
    })
    const archived = personProfileFixture({
      sequence: 31,
      membershipSeq: 99,
      displayName: '已离开成员档案',
      status: 'archived',
      version: 3
    })
    const { Page } = renderWithServices(ProfilePage, [
      {
        status: 200,
        body: successEnvelope(
          ownerMembersViewFixture([
            { membership: ownerMembership, profile: null }
          ])
        )
      },
      {
        status: 200,
        body: successEnvelope({
          viewerRole: 'owner',
          profiles: [archived]
        })
      },
      { status: 200, body: successEnvelope({ requests: [] }) }
    ])
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })

    const restore = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '恢复原档案')
    assert.ok(restore)
    assert.equal(restore.props['disabled'], true)
    assert.match(
      textContent(renderer?.toJSON() ?? null),
      /关联成员当前不在家庭中，无法恢复；重新加入后仍须显式恢复原档案/
    )
  })

  it('ProfilePage 关联确认披露安全名称、约束摘要、权限和归档后果而非 UUID', async () => {
    const selfMembership = membershipFixture({
      role: 'member',
      sequence: 22,
      userSeq: 1
    })
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 2
    })
    const profileId = uuidV7(31)
    const linkRequest = {
      id: uuidV7(71),
      householdId: uuidV7(10),
      profileId,
      targetMembershipId: selfMembership.id,
      initiatedByUserId: ownerMembership.userId,
      status: 'pending' as const,
      createdAt: '2026-07-24T08:00:00.000Z',
      expiresAt: '2026-07-25T08:00:00.000Z',
      disclosure: {
        availability: 'available' as const,
        disclosureVersion: 1 as const,
        profileVersion: 0,
        profileDisplayName: '安全披露访客',
        householdVisibleHardConstraintCount: 1,
        householdVisibleSoftConstraintCount: 0,
        privateConstraintCount: 2,
        subjectWillGainProfileAccess: true as const,
        membershipExitArchivesProfile: true as const,
        rejoinRestoresAutomatically: false as const,
        privateConstraintContentsRemainPrivate: true as const
      },
      version: 0
    }
    const { Page } = renderWithServices(ProfilePage, [
      {
        status: 200,
        body: successEnvelope(
          memberMembersViewFixture(
            { membership: selfMembership, profile: null },
            [{ membership: ownerMembership, profile: null }]
          )
        )
      },
      {
        status: 200,
        body: successEnvelope({
          viewerRole: 'member',
          self: null,
          others: []
        })
      },
      {
        status: 200,
        body: successEnvelope({ requests: [linkRequest] })
      }
    ])
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })

    const pageText = textContent(renderer?.toJSON() ?? null)
    assert.match(pageText, /档案“安全披露访客”/)
    assert.match(pageText, /可见约束摘要：硬约束1条，偏好0条/)
    assert.match(pageText, /另有私密约束2条（不披露内容）/)
    assert.match(pageText, /本人和家庭所有者可管理完整档案/)
    assert.match(pageText, /退出或被移除会归档档案并保留数据/)
    assert.doesNotMatch(pageText, new RegExp(profileId))
    assert.doesNotMatch(pageText, new RegExp(selfMembership.id))
  })

  it('ProfilePage 切换档案清空约束与关联草稿，写请求期间冻结相关输入', async () => {
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 1
    })
    const dining = {
      ...personProfileFixture({
        sequence: 31,
        membershipSeq: 31,
        displayName: '仅用餐甲'
      }),
      linkedMembershipId: undefined
    }
    const linked = personProfileFixture({
      sequence: 32,
      membershipSeq: 20,
      displayName: '本人档案'
    })
    const view = ownerMembersViewFixture([
      { membership: ownerMembership, profile: linked }
    ])
    const { Page, platform } = renderWithServices(ProfilePage, [
      { status: 200, body: successEnvelope(view) },
      {
        status: 200,
        body: successEnvelope({
          viewerRole: 'owner',
          profiles: [dining, linked]
        })
      },
      { status: 200, body: successEnvelope({ requests: [] }) }
    ])
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })

    const diningButton = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button).includes('仅用餐甲 · 使用中'))
    assert.ok(diningButton)
    await act(async () => diningButton.props['onClick']())

    const constraintInput = () =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-input')
        .find((input) => input.props['placeholder'] === '约束名称')
    assert.ok(constraintInput())
    await act(async () => {
      constraintInput()?.props['onInput']({
        detail: { value: '不应跨档案保留' }
      })
    })
    const memberChoice = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '本人档案')
    assert.ok(memberChoice)
    await act(async () => memberChoice.props['onClick']())
    const linkedButton = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button).includes('本人档案 · 使用中'))
    assert.ok(linkedButton)
    await act(async () => linkedButton.props['onClick']())
    assert.equal(constraintInput()?.props['value'], '')
    await act(async () => {
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((button) => buttonText(button).includes('仅用餐甲 · 使用中'))
        ?.props['onClick']()
    })
    const resetChoice = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '本人档案')
    assert.equal(
      String(resetChoice?.props['className']).includes('button--secondary'),
      true
    )

    let resolvePatch:
      | ((response: { statusCode: number; body: string }) => void)
      | undefined
    platform.enqueueResponse(
      new Promise((resolve) => {
        resolvePatch = resolve
      })
    )
    platform.enqueueJson(
      200,
      successEnvelope(
        getPersonProfileResultFixture({
          ...dining,
          displayName: '仅用餐甲',
          version: 1
        })
      )
    )
    platform.enqueueJson(200, successEnvelope(view))
    platform.enqueueJson(
      200,
      successEnvelope({
        viewerRole: 'owner',
        profiles: [{ ...dining, version: 1 }, linked]
      })
    )
    platform.enqueueJson(200, successEnvelope({ requests: [] }))
    const save = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '保存档案事实')
    assert.ok(save)
    await act(async () => {
      save.props['onClick']()
      await new Promise<void>((resolve) => setImmediate(resolve))
    })
    const frozenInputs = renderer?.root.findAll(
      (node) => String(node.type) === 'taro-input'
    )
    assert.ok(frozenInputs)
    assert.equal(
      frozenInputs.every((input) => input.props['disabled'] === true),
      true
    )
    assert.equal(
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .filter((button) =>
          buttonText(button).includes(' · 使用中')
        )
        .every((button) => button.props['disabled'] === true),
      true
    )
    const patchRequest = platform.sentRequests.find(
      (request) => request.method === 'PATCH'
    )
    assert.ok(patchRequest)
    const requestBodyBefore = patchRequest.body
    const keyBefore = patchRequest.headers['idempotency-key']
    await act(async () => {
      resolvePatch?.({
        statusCode: 200,
        body: JSON.stringify(
          successEnvelope({
            householdId: uuidV7(10),
            profileId: dining.id,
            operation: 'update',
            status: 'active',
            resultingVersion: 1
          })
        )
      })
      await settleEffects()
    })
    assert.equal(patchRequest.body, requestBodyBefore)
    assert.equal(patchRequest.headers['idempotency-key'], keyBefore)
  })

  it('ProfilePage transport 失败后冻结档案草稿并用原 key 重试', async () => {
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 1
    })
    const profile = personProfileFixture({
      sequence: 31,
      membershipSeq: 20,
      displayName: '不可变档案草稿'
    })
    const view = ownerMembersViewFixture([
      { membership: ownerMembership, profile }
    ])
    const { Page, platform } = renderWithServices(ProfilePage, [
      { status: 200, body: successEnvelope(view) },
      {
        status: 200,
        body: successEnvelope({
          viewerRole: 'owner',
          profiles: [profile]
        })
      },
      { status: 200, body: successEnvelope({ requests: [] }) }
    ])
    platform.enqueueResponse(new Error('lost profile response'))
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })
    const editInput = () =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-input')
        .find((input) => input.props['value'] === '不可变档案草稿')
    const save = () =>
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .find((button) => buttonText(button) === '保存档案事实')
    await act(async () => {
      save()?.props['onClick']()
      await settleEffects()
    })
    assert.equal(editInput()?.props['disabled'], true)
    const archive = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '归档')
    const createProfileButton = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '创建档案')
    assert.equal(save()?.props['disabled'], false)
    assert.equal(archive?.props['disabled'], true)
    assert.equal(createProfileButton?.props['disabled'], true)
    assert.match(
      textContent(renderer?.toJSON() ?? null),
      /所有其他写操作已禁用/
    )
    const refreshedProfile = { ...profile, version: 7 }
    const refreshedView = ownerMembersViewFixture([
      { membership: ownerMembership, profile: refreshedProfile }
    ])
    platform.enqueueJson(200, successEnvelope(refreshedView))
    platform.enqueueJson(
      200,
      successEnvelope({
        viewerRole: 'owner',
        profiles: [refreshedProfile]
      })
    )
    platform.enqueueJson(200, successEnvelope({ requests: [] }))
    const reconcile = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '刷新资源（仅观察）')
    assert.ok(reconcile)
    await act(async () => {
      reconcile.props['onClick']()
      await settleEffects()
    })
    assert.equal(
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .some((button) => buttonText(button) === '对账确认已完成'),
      false
    )
    platform.enqueueJson(
      200,
      successEnvelope({
        householdId: uuidV7(10),
        profileId: profile.id,
        operation: 'update',
        status: 'active',
        resultingVersion: 2
      })
    )
    platform.enqueueJson(
      200,
      successEnvelope(
        getPersonProfileResultFixture({ ...profile, version: 2 })
      )
    )
    platform.enqueueJson(200, successEnvelope(view))
    platform.enqueueJson(
      200,
      successEnvelope({
        viewerRole: 'owner',
        profiles: [{ ...profile, version: 2 }]
      })
    )
    platform.enqueueJson(200, successEnvelope({ requests: [] }))
    await act(async () => {
      save()?.props['onClick']()
      await settleEffects()
    })
    const patches = platform.sentRequests.filter(
      (request) => request.method === 'PATCH'
    )
    assert.equal(patches.length, 2)
    assert.equal(
      patches[0]?.headers['idempotency-key'],
      patches[1]?.headers['idempotency-key']
    )
    assert.equal(patches[0]?.body, patches[1]?.body)
    assert.match(patches[0]?.body ?? '', /"expectedVersion":0/)
    assert.doesNotMatch(patches[1]?.body ?? '', /"expectedVersion":7/)
  })

  it('ProfilePage 在关联确认 409 后终止旧请求并要求 owner 重新发起', async () => {
    const selfMembership = membershipFixture({
      role: 'member',
      sequence: 22,
      userSeq: 1
    })
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 2
    })
    const membersView = memberMembersViewFixture(
      { membership: selfMembership, profile: null },
      [{ membership: ownerMembership, profile: null }]
    )
    const disclosure = (
      idSequence: number,
      name: string,
      privateCount: number
    ) => ({
      id: uuidV7(idSequence),
      householdId: uuidV7(10),
      profileId: uuidV7(31),
      targetMembershipId: selfMembership.id,
      initiatedByUserId: ownerMembership.userId,
      status: 'pending' as const,
      createdAt: '2026-07-24T08:00:00.000Z',
      expiresAt: '2026-07-25T08:00:00.000Z',
      disclosure: {
        availability: 'available' as const,
        disclosureVersion: 1 as const,
        profileVersion: idSequence - 71,
        profileDisplayName: name,
        householdVisibleHardConstraintCount: 0,
        householdVisibleSoftConstraintCount: 0,
        privateConstraintCount: privateCount,
        subjectWillGainProfileAccess: true as const,
        membershipExitArchivesProfile: true as const,
        rejoinRestoresAutomatically: false as const,
        privateConstraintContentsRemainPrivate: true as const
      },
      version: 0
    })
    const before = disclosure(71, '披露前名称', 0)
    const { Page } = renderWithServices(ProfilePage, [
      { status: 200, body: successEnvelope(membersView) },
      {
        status: 200,
        body: successEnvelope({
          viewerRole: 'member',
          self: null,
          others: []
        })
      },
      { status: 200, body: successEnvelope({ requests: [before] }) },
      { status: 409, body: apiErrorBody('CONFLICT') },
      { status: 200, body: successEnvelope(membersView) },
      {
        status: 200,
        body: successEnvelope({
          viewerRole: 'member',
          self: null,
          others: []
        })
      },
      { status: 200, body: successEnvelope({ requests: [] }) }
    ])
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })
    assert.match(textContent(renderer?.toJSON() ?? null), /披露前名称/)
    const confirm = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((button) => buttonText(button) === '我确认关联')
    assert.ok(confirm)
    await act(async () => {
      confirm.props['onClick']()
      await settleEffects()
    })
    const refreshedText = textContent(renderer?.toJSON() ?? null)
    assert.match(refreshedText, /旧关联请求已终止/)
    assert.match(refreshedText, /所有者必须重新发起/)
    assert.doesNotMatch(refreshedText, /披露前名称/)
    assert.equal(
      renderer?.root
        .findAll((node) => String(node.type) === 'taro-button')
        .some((button) => buttonText(button) === '我确认关联'),
      false
    )
  })

  it('ProfilePage link confirm 403 不冒充已提交终态 409', async () => {
    const selfMembership = membershipFixture({
      role: 'member',
      sequence: 22,
      userSeq: 1
    })
    const ownerMembership = membershipFixture({
      role: 'owner',
      sequence: 20,
      userSeq: 2
    })
    const request = {
      id: uuidV7(81),
      householdId: uuidV7(10),
      profileId: uuidV7(31),
      targetMembershipId: selfMembership.id,
      initiatedByUserId: ownerMembership.userId,
      status: 'pending' as const,
      createdAt: '2026-07-24T08:00:00.000Z',
      expiresAt: '2026-07-25T08:00:00.000Z',
      disclosure: {
        availability: 'available' as const,
        disclosureVersion: 1 as const,
        profileVersion: 0,
        profileDisplayName: '权限测试档案',
        householdVisibleHardConstraintCount: 0,
        householdVisibleSoftConstraintCount: 0,
        privateConstraintCount: 0,
        subjectWillGainProfileAccess: true as const,
        membershipExitArchivesProfile: true as const,
        rejoinRestoresAutomatically: false as const,
        privateConstraintContentsRemainPrivate: true as const
      },
      version: 0
    }
    const { Page, platform } = renderWithServices(ProfilePage, [
      {
        status: 200,
        body: successEnvelope(
          memberMembersViewFixture(
            { membership: selfMembership, profile: null },
            [{ membership: ownerMembership, profile: null }]
          )
        )
      },
      {
        status: 200,
        body: successEnvelope({
          viewerRole: 'member',
          self: null,
          others: []
        })
      },
      { status: 200, body: successEnvelope({ requests: [request] }) },
      { status: 403, body: apiErrorBody('FORBIDDEN') }
    ])
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })
    const confirm = renderer?.root
      .findAll((node) => String(node.type) === 'taro-button')
      .find((candidate) => buttonText(candidate) === '我确认关联')
    assert.ok(confirm)
    const beforeConfirm = platform.sentRequests.length
    await act(async () => {
      confirm.props['onClick']()
      await settleEffects()
    })
    assert.equal(platform.sentRequests.length, beforeConfirm + 1)
    const text = textContent(renderer?.toJSON() ?? null)
    assert.match(text, /无权确认|权限/)
    assert.doesNotMatch(text, /所有者必须重新发起/)
  })
})
