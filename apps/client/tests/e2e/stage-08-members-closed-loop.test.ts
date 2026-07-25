import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import type {
  HouseholdId,
  HouseholdInviteId,
  MembershipId,
  PersonProfileId
} from '@meal-agent/contracts'

import {
  createAppServices,
  type AppServices
} from '../../src/core/app-services'
import { signIn } from '../../src/core/auth-flow'
import { createHousehold } from '../../src/core/household-flow'
import { createIdempotencyKey } from '../../src/core/idempotency'
import {
  createInvite,
  joinHousehold,
  loadMembers,
  removeMembership,
  revokeInvite
} from '../../src/core/members-flow'
import {
  addDietaryConstraint,
  createProfile
} from '../../src/core/profile-flow'
import { NodePlatform } from './support/node-platform'
import { startE2eStack, type E2eStack } from './support/stack'

/**
 * 阶段 08 端到端闭环：真实 services/api + 一次性 PostgreSQL 18 + fake 微信。
 * 双用户双 session 全流程——A 建家 → 签码 → B 加入 → B 建档案并录入
 * subject_and_owner 硬约束（双确认）→ A（owner）可见、第三成员 C 结构性
 * 不可见 → A 撤销邀请码、B 退出且关联档案原子归档 → 被移除者即时 404。
 * fake 适配器结果不得记为真实微信链路 Pass。
 */
describe('stage 08 members closed loop (real API + PostgreSQL 18)', () => {
  let stack: E2eStack
  let platformA: NodePlatform
  let platformB: NodePlatform
  let platformC: NodePlatform
  let servicesA: AppServices
  let servicesB: AppServices
  let servicesC: AppServices

  let householdId: HouseholdId
  let inviteCode: string
  let inviteId: HouseholdInviteId
  let bMembershipId: MembershipId
  let bProfileId: PersonProfileId
  let bProfileVersion: number

  const keyA = (): ReturnType<typeof createIdempotencyKey> =>
    createIdempotencyKey(platformA.runtime)
  const keyB = (): ReturnType<typeof createIdempotencyKey> =>
    createIdempotencyKey(platformB.runtime)

  before(async () => {
    stack = await startE2eStack()
    platformA = new NodePlatform('e2e-08-user-a')
    platformB = new NodePlatform('e2e-08-user-b')
    platformC = new NodePlatform('e2e-08-user-c')
    servicesA = createAppServices(platformA, stack.baseUrl)
    servicesB = createAppServices(platformB, stack.baseUrl)
    servicesC = createAppServices(platformC, stack.baseUrl)
    await signIn(servicesA)
    await signIn(servicesB)
    await signIn(servicesC)
  })

  after(async () => {
    await stack.stop()
  })

  it('A 建家并签发可多次使用的邀请码', async () => {
    const created = await createHousehold(
      servicesA,
      { name: 'E2E 08 家庭', ownerDisplayName: '户主A' },
      keyA()
    )
    assert.equal(created.kind, 'created')
    if (created.kind !== 'created') {
      return
    }
    householdId = created.result.household.id

    const invite = await createInvite(
      servicesA,
      householdId,
      { maxUses: 5, expiresInHours: 168 },
      keyA()
    )
    assert.equal(invite.kind, 'created')
    if (invite.kind !== 'created') {
      return
    }
    // 首次签发必然返回明文码（重放才可能缺失）；断言以收窄类型。
    assert.ok(
      invite.result.inviteCode,
      'first-issue invite must include the plaintext code'
    )
    inviteCode = invite.result.inviteCode
    inviteId = invite.result.invite.id
    assert.match(inviteCode, /^[A-Za-z0-9_-]{22,128}$/)
  })

  it('B 凭码加入并切换到该家庭', async () => {
    const joined = await joinHousehold(servicesB, inviteCode, keyB())
    assert.equal(joined.kind, 'joined')
    if (joined.kind !== 'joined') {
      return
    }
    assert.equal(joined.result.membership.role, 'member')
    assert.equal(joined.result.household.id, householdId)
    bMembershipId = joined.result.membership.id
    assert.equal(servicesB.session.restoreCurrentHouseholdId(), householdId)
  })

  it('B 建立自己的档案并录入 subject_and_owner 硬约束（双确认）', async () => {
    const profile = await createProfile(
      servicesB,
      householdId,
      {
        linkedMembershipId: bMembershipId,
        displayName: '成员B',
        defaultParticipation: true,
        defaultPortionScale: 1,
        cookingSkill: 'beginner'
      },
      keyB()
    )
    assert.equal(profile.kind, 'created')
    if (profile.kind !== 'created') {
      return
    }
    bProfileId = profile.profile.id

    const added = await addDietaryConstraint(
      servicesB,
      householdId,
      bProfileId,
      {
        enforcement: 'hard',
        kind: 'allergy',
        label: '虚构坚果过敏',
        allergenCodes: ['FICTION_TREE_NUT'],
        visibility: 'subject_and_owner',
        acknowledged: true
      },
      profile.profile.version,
      keyB()
    )
    assert.equal(added.kind, 'added')
    if (added.kind !== 'added') {
      return
    }
    bProfileVersion = added.profile.version
    const constraint = added.profile.dietaryConstraints[0]
    // 服务端写入 confirmedByUserId=操作者（B）。
    assert.equal(constraint?.confirmedByUserId, servicesB.session.restore()?.user.id)
  })

  it('未确认的硬约束被本地二次确认拦截，不触达服务端', async () => {
    const rejected = await addDietaryConstraint(
      servicesB,
      householdId,
      bProfileId,
      {
        enforcement: 'hard',
        kind: 'allergy',
        label: '未确认样例',
        allergenCodes: ['FICTION_SHELLFISH'],
        visibility: 'household',
        acknowledged: false
      },
      bProfileVersion,
      keyB()
    )
    assert.equal(rejected.kind, 'invalid')
  })

  it('C 加入后，A（owner）可见 B 的私密约束，C（成员）结构上不可见', async () => {
    const joinedC = await joinHousehold(
      servicesC,
      inviteCode,
      createIdempotencyKey(platformC.runtime)
    )
    assert.equal(joinedC.kind, 'joined')

    // owner 视图：A 能看到 B 的 subject_and_owner 约束。
    const ownerView = await loadMembers(servicesA, householdId)
    assert.equal(ownerView.kind, 'loaded')
    if (ownerView.kind !== 'loaded' || ownerView.view.viewerRole !== 'owner') {
      return
    }
    const ownerSeesB = ownerView.view.members.find(
      (entry) => entry.membership.id === bMembershipId
    )
    assert.equal(
      ownerSeesB?.profile?.dietaryConstraints.some(
        (constraint) => constraint.visibility === 'subject_and_owner'
      ),
      true
    )

    // member 视图：C 的 others 里结构上不可能出现 B 的私密约束。
    const memberView = await loadMembers(servicesC, householdId)
    assert.equal(memberView.kind, 'loaded')
    if (
      memberView.kind !== 'loaded' ||
      memberView.view.viewerRole !== 'member'
    ) {
      return
    }
    for (const entry of memberView.view.others) {
      for (const constraint of entry.profile?.dietaryConstraints ?? []) {
        assert.equal(constraint.visibility, 'household')
      }
    }
    assert.equal(
      JSON.stringify(memberView.view.others).includes('虚构坚果过敏'),
      false
    )
  })

  it('A 撤销邀请码后，新的加入尝试一律 404', async () => {
    const revoked = await revokeInvite(servicesA, householdId, inviteId, keyA())
    assert.equal(revoked.kind, 'revoked')

    const platformD = new NodePlatform('e2e-08-user-d')
    const servicesD = createAppServices(platformD, stack.baseUrl)
    await signIn(servicesD)
    const lateJoin = await joinHousehold(
      servicesD,
      inviteCode,
      createIdempotencyKey(platformD.runtime)
    )
    assert.equal(lateJoin.kind, 'inviteInvalid')
  })

  it('B 退出后即时失去访问（404），关联档案在同一事务自动归档', async () => {
    const left = await removeMembership(
      servicesB,
      householdId,
      bMembershipId,
      keyB()
    )
    assert.equal(left.kind, 'removed')

    // 被移除者的下一请求立即 404（householdMissing）。
    const afterLeave = await loadMembers(servicesB, householdId)
    assert.equal(afterLeave.kind, 'householdMissing')

    // A（owner）读取 archived 集合，确认退出命令已原子归档原 ID；
    // 不把它静默改成 dining-only，也不需要第二个归档命令。
    const profiles = await servicesA.api.listPersonProfiles(householdId, 'archived')
    assert.equal(profiles.kind, 'success')
    if (profiles.kind !== 'success' || profiles.data.viewerRole !== 'owner') {
      return
    }
    const archived = profiles.data.profiles.find(
      (profile) => profile.id === bProfileId
    )
    assert.equal(archived?.status, 'archived')
    assert.equal(archived?.linkedMembershipId, bMembershipId)
  })

  it('最后一位 owner 不可退出（保护）', async () => {
    const ownerView = await loadMembers(servicesA, householdId)
    assert.equal(ownerView.kind, 'loaded')
    if (ownerView.kind !== 'loaded' || ownerView.view.viewerRole !== 'owner') {
      return
    }
    const ownerEntry = ownerView.view.members.find(
      (entry) => entry.membership.role === 'owner'
    )
    assert.notEqual(ownerEntry, undefined)
    if (ownerEntry === undefined) {
      return
    }
    const outcome = await removeMembership(
      servicesA,
      householdId,
      ownerEntry.membership.id,
      keyA()
    )
    assert.equal(outcome.kind, 'conflict')
  })
})
