import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { ReactTestRenderer, ReactTestRendererJSON } from 'react-test-renderer'
import { act, create } from 'react-test-renderer'

import { householdIdSchema } from '@meal-agent/contracts'
import { authenticatedSessionSchema } from '@meal-agent/contracts/identity'

import { installAppServicesForPageTest } from '../../src/app-runtime'
import { createAppServices } from '../../src/core/app-services'
import HouseholdsPage from '../../src/pages/households'
import MembersPage from '../../src/pages/members'
import ProfilePage from '../../src/pages/profile'
import { FakePlatform } from '../support/fake-platform'
import {
  authenticatedSessionFixture,
  getPersonProfileResultFixture,
  hardConstraintFixture,
  INVITE_CODE,
  joinHouseholdResultFixture,
  memberMembersViewFixture,
  membershipFixture,
  ownerMembersViewFixture,
  personProfileFixture,
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

describe('真实页面渲染回归', () => {
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
    const diningProfile = {
      ...personProfileFixture({
        sequence: 31,
        displayName: '安全披露访客',
        dietaryConstraints: [
          hardConstraintFixture({
            kind: 'religious',
            label: '家庭可见约束',
            allergenCodes: []
          })
        ]
      }),
      linkedMembershipId: undefined
    }
    const linkRequest = {
      id: uuidV7(71),
      householdId: uuidV7(10),
      profileId,
      targetMembershipId: selfMembership.id,
      initiatedByUserId: ownerMembership.userId,
      status: 'pending' as const,
      createdAt: '2026-07-24T08:00:00.000Z',
      expiresAt: '2026-07-25T08:00:00.000Z',
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
      },
      {
        status: 200,
        body: successEnvelope({
          access: 'household',
          profile: diningProfile
        })
      }
    ])
    await act(async () => {
      renderer = create(<Page />)
      await settleEffects()
    })

    const pageText = textContent(renderer?.toJSON() ?? null)
    assert.match(pageText, /档案“安全披露访客”/)
    assert.match(pageText, /可见约束摘要：硬约束1条，偏好0条/)
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
})
