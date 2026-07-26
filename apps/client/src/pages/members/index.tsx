import '../../zod-runtime-config'
import { useEffect, useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import type {
  HouseholdId,
  HouseholdInviteId,
  MembershipId
} from '@meal-agent/contracts'
import type {
  CreateHouseholdInviteResult,
  ListHouseholdMembersResult
} from '@meal-agent/contracts/members'

import { getAppServices } from '../../app-runtime'
import { usePendingCommandSubscription } from '../../components/use-pending-command-subscription'
import {
  createInvite,
  loadMembers,
  removeMembership,
  revokeInvite
} from '../../core/members-flow'
import {
  HOUSEHOLDS_ROUTE,
  LOGIN_ROUTE,
  MEMBERS_ROUTE,
  PROFILE_ROUTE
} from '../../platform/ports'

type MembersState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly view: ListHouseholdMembersResult }
  | { readonly kind: 'householdMissing'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

type Notice =
  | { readonly kind: 'none' }
  | { readonly kind: 'info'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

// 明文邀请码只在创建响应出现一次，展示后不再可读取。
type InviteReveal =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'revealed'
      readonly result: CreateHouseholdInviteResult
    }

const constraintSummary = (count: number): string =>
  count === 0 ? '无已登记约束' : `${count} 条饮食约束`

export default function MembersPage() {
  usePendingCommandSubscription()
  const [state, setState] = useState<MembersState>({ kind: 'loading' })
  const [notice, setNotice] = useState<Notice>({ kind: 'none' })
  const [reveal, setReveal] = useState<InviteReveal>({ kind: 'none' })
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const actionKeys = getAppServices().pendingCommands

  const householdId =
    getAppServices().session.restoreCurrentHouseholdId()

  const refresh = async (id: HouseholdId): Promise<void> => {
    setState({ kind: 'loading' })
    const result = await loadMembers(getAppServices(), id)
    if (result.kind === 'loaded') {
      setState({ kind: 'loaded', view: result.view })
    } else {
      setState(result)
    }
  }

  useEffect(() => {
    const services = getAppServices()
    if (services.session.restore() === null) {
      void services.navigation.reLaunch(LOGIN_ROUTE)
      return
    }
    if (householdId === null) {
      void services.navigation.reLaunch(HOUSEHOLDS_ROUTE)
      return
    }
    void refresh(householdId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (householdId === null) {
    return (
      <View className='page'>
        <Text>未选择家庭，正在返回…</Text>
      </View>
    )
  }

  const handleGenerateInvite = async (): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    setNotice({ kind: 'none' })
    const services = getAppServices()
    const action = 'invite:create'
    if (actionKeys.hasOtherPending(action)) {
      setBusy(false)
      setNotice({
        kind: 'error',
        message: '当前有未决命令，只能重试原动作。'
      })
      return
    }
    const payload = {
      maxUses: 1,
      expiresInHours: 168
    }
    let outcome: Awaited<ReturnType<typeof createInvite>>
    try {
      outcome = await services.commands.execute(
        action,
        MEMBERS_ROUTE,
        {
          kind: 'invite.create',
          payload: { householdId, draft: payload }
        }
      )
    } catch {
      setNotice({
        kind: 'error',
        message: '邀请创建结果未知；只能用原请求和原幂等键重试。'
      })
      return
    } finally {
      setBusy(false)
    }
    switch (outcome.kind) {
      case 'created':
        setReveal({ kind: 'revealed', result: outcome.result })
        setNotice({
          kind: 'info',
          message: outcome.replayed
            ? '已重放上次生成的邀请（幂等）。'
            : '邀请码已生成，请立即复制，页面离开后无法再次查看。'
        })
        return
      case 'forbidden':
        setNotice({ kind: 'error', message: outcome.message })
        return
      case 'failed':
        setNotice({ kind: 'error', message: outcome.message })
    }
  }

  const handleRevoke = async (
    inviteId: HouseholdInviteId
  ): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    const services = getAppServices()
    const action = `invite:revoke:${inviteId}`
    if (actionKeys.hasOtherPending(action)) {
      setBusy(false)
      setNotice({
        kind: 'error',
        message: '当前有未决命令，只能重试原动作。'
      })
      return
    }
    let outcome: Awaited<ReturnType<typeof revokeInvite>>
    try {
      outcome = await services.commands.execute(
        action,
        MEMBERS_ROUTE,
        {
          kind: 'invite.revoke',
          payload: { householdId, inviteId }
        }
      )
    } catch {
      setNotice({
        kind: 'error',
        message: '撤销结果未知；只能用原请求和原幂等键重试。'
      })
      return
    } finally {
      setBusy(false)
    }
    if (outcome.kind === 'revoked') {
      setNotice({ kind: 'info', message: '邀请已撤销。' })
    } else if (outcome.kind === 'alreadyInactive') {
      setNotice({ kind: 'info', message: outcome.message })
    } else {
      setNotice({ kind: 'error', message: outcome.message })
    }
    await refresh(householdId)
  }

  const handleRemove = async (
    membershipId: MembershipId,
    isSelf: boolean
  ): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    const services = getAppServices()
    const action = `membership:remove:${membershipId}`
    if (actionKeys.hasOtherPending(action)) {
      setBusy(false)
      setNotice({
        kind: 'error',
        message: '当前有未决命令，只能重试原动作。'
      })
      return
    }
    let outcome: Awaited<ReturnType<typeof removeMembership>>
    try {
      outcome = await services.commands.execute(
        action,
        MEMBERS_ROUTE,
        {
          kind: 'membership.remove',
          payload: { householdId, membershipId, isSelf }
        }
      )
    } catch {
      setNotice({
        kind: 'error',
        message: '退出或移除结果未知；只能用原请求和原幂等键重试。'
      })
      return
    } finally {
      setBusy(false)
    }
    if (!actionKeys.hasPending(action)) {
      setPendingRemoval(null)
    }
    switch (outcome.kind) {
      case 'removed':
        if (isSelf) {
          // 退出自己后已失去该家庭访问权：直接离开到家庭列表，
          // 不能再 refresh 当前家庭（否则成员列表请求必然 404）。
          void services.navigation.reLaunch(
            HOUSEHOLDS_ROUTE,
            () => services.session.clearCurrentHouseholdId()
          )
          return
        }
        setNotice({ kind: 'info', message: '已移除该成员。' })
        break
      case 'conflict':
      case 'forbidden':
      case 'notFound':
      case 'failed':
        setNotice({ kind: 'error', message: outcome.message })
        break
    }
    await refresh(householdId)
  }

  return (
    <View className='page'>
      <Text className='page-title'>家庭成员</Text>

      {notice.kind !== 'none' && (
        <View
          className={
            notice.kind === 'error'
              ? 'notice notice--error'
              : 'notice'
          }
        >
          <Text>{notice.message}</Text>
        </View>
      )}

      {state.kind === 'loading' && <Text>正在加载成员…</Text>}

      {state.kind === 'householdMissing' && (
        <View className='notice notice--error'>
          <Text>{state.message}</Text>
          <Button
            className='button button--secondary'
            onClick={() => {
              void getAppServices().navigation.reLaunch(
                HOUSEHOLDS_ROUTE
              )
            }}
          >
            返回家庭列表
          </Button>
        </View>
      )}

      {state.kind === 'failed' && (
        <View className='notice notice--error'>
          <Text>{state.message}</Text>
          {state.retryable && (
            <Button
              className='button button--secondary'
              onClick={() => {
                void refresh(householdId)
              }}
            >
              重试
            </Button>
          )}
        </View>
      )}

      {state.kind === 'loaded' &&
        renderLoaded(
          state.view,
          pendingRemoval,
          setPendingRemoval,
          handleRemove,
          busy,
          getAppServices().session.restore()?.user.id,
          (membershipId) =>
            actionKeys.hasOtherPending(
              `membership:remove:${membershipId}`
            ),
          (membershipId) =>
            actionKeys.hasPending(
              `membership:remove:${membershipId}`
            )
        )}

      {state.kind === 'loaded' && state.view.viewerRole === 'owner' && (
        <View className='section'>
          <Text className='section-title'>邀请管理</Text>
          <Text className='list-item-detail'>
            默认生成单次使用、7 天有效的邀请码。微信分享仍在后续阶段
            （Deferred），当前通过复制文本传递。
          </Text>
          <Button
            className={busy ? 'button button--disabled' : 'button'}
            disabled={
              busy || actionKeys.hasOtherPending('invite:create')
            }
            onClick={() => {
              void handleGenerateInvite()
            }}
          >
            生成邀请码
          </Button>
          {reveal.kind === 'revealed' && (
            <View className='section'>
              {reveal.result.inviteCode !== undefined ? (
                <>
                  <Text className='field-label'>邀请码（仅显示一次）</Text>
                  <Text className='list-item-title' selectable>
                    {reveal.result.inviteCode}
                  </Text>
                  <Text className='list-item-detail'>
                    长按可复制。上限 {reveal.result.invite.maxUses} 次 · 到期
                    {reveal.result.invite.expiresAt}
                  </Text>
                </>
              ) : (
                <Text className='list-item-detail'>
                  邀请已生成，但本次响应未包含明文码（通常因网络重试命中已处理请求）。明文码只显示一次，请撤销此邀请后重新生成。
                </Text>
              )}
              <Button
                className='button button--secondary'
                disabled={
                  busy ||
                  actionKeys.hasOtherPending(
                    `invite:revoke:${reveal.result.invite.id}`
                  )
                }
                onClick={() => {
                  void handleRevoke(reveal.result.invite.id)
                }}
              >
                撤销此邀请
              </Button>
            </View>
          )}
        </View>
      )}

      <Button
        className='button button--secondary'
        disabled={actionKeys.hasAnyPending()}
        onClick={() => {
          void getAppServices().navigation.navigateTo(PROFILE_ROUTE)
        }}
      >
        我的用餐档案与约束
      </Button>
      <Button
        className='button button--secondary'
        disabled={actionKeys.hasAnyPending()}
        onClick={() => {
          void getAppServices().navigation.reLaunch(HOUSEHOLDS_ROUTE)
        }}
      >
        返回家庭列表
      </Button>
    </View>
  )
}

type MemberEntry = {
  readonly membershipId: MembershipId
  readonly displayName: string
  readonly role: string
  readonly isSelf: boolean
  readonly constraintCount: number
}

const collectEntries = (
  view: ListHouseholdMembersResult,
  currentUserId: string | undefined
): {
  readonly entries: readonly MemberEntry[]
  readonly ownerCount: number
} => {
  const rows =
    view.viewerRole === 'owner'
      ? view.members.map((entry) => ({
          entry,
          isSelf: entry.membership.userId === currentUserId
        }))
      : [
          { entry: view.self, isSelf: true },
          ...view.others.map((entry) => ({ entry, isSelf: false }))
        ]
  const entries = rows.map(({ entry, isSelf }) => ({
    membershipId: entry.membership.id,
    displayName: entry.profile?.displayName ?? '（未建立档案）',
    role: entry.membership.role,
    isSelf,
    constraintCount: entry.profile?.dietaryConstraints.length ?? 0
  }))
  const ownerCount = entries.filter((entry) => entry.role === 'owner').length
  return { entries, ownerCount }
}

const renderLoaded = (
  view: ListHouseholdMembersResult,
  pendingRemoval: string | null,
  setPendingRemoval: (value: string | null) => void,
  handleRemove: (membershipId: MembershipId, isSelf: boolean) => Promise<void>,
  busy: boolean,
  currentUserId: string | undefined,
  hasOtherPendingRemoval: (membershipId: MembershipId) => boolean,
  isPendingRemoval: (membershipId: MembershipId) => boolean
) => {
  const { entries, ownerCount } = collectEntries(view, currentUserId)
  const isOwnerViewer = view.viewerRole === 'owner'
  return (
    <View className='section'>
      <Text className='section-title'>
        成员列表（{isOwnerViewer ? '所有者视图' : '成员视图'}）
      </Text>
      {entries.map((entry) => {
        // owner 可移除他人；成员只能退出自己。最后一位 owner 受保护。
        // owner 可移除他人，也可在至少还有另一位 owner 时退出自己；
        // 普通成员只能退出自己。
        const canRemove = isOwnerViewer || entry.isSelf
        const lastOwnerProtected =
          entry.role === 'owner' && ownerCount <= 1
        return (
          <View key={entry.membershipId} className='list-item'>
            <Text className='list-item-title'>
              {entry.displayName}
              {entry.isSelf ? '（我）' : ''} · {entry.role}
            </Text>
            <Text className='list-item-detail'>
              {constraintSummary(entry.constraintCount)}
            </Text>
            {canRemove && lastOwnerProtected && (
              <Text className='list-item-detail'>
                最后一位所有者不可退出；请先转移或新增所有者。
              </Text>
            )}
            {canRemove && !lastOwnerProtected && (
              <View>
                {pendingRemoval === entry.membershipId ? (
                  <View>
                    <Text className='notice'>
                      {entry.isSelf
                        ? '确认退出该家庭？关联档案将立即归档，数据按既定保留策略保留；重新加入不会自动恢复，须显式恢复原档案。'
                        : '确认移除该成员？访问将立即失效，关联档案会归档且数据继续保留；重新加入不会自动恢复。'}
                    </Text>
                    <Button
                      className={busy ? 'button button--disabled' : 'button'}
                      disabled={
                        busy ||
                        hasOtherPendingRemoval(entry.membershipId)
                      }
                      onClick={() => {
                        void handleRemove(entry.membershipId, entry.isSelf)
                      }}
                    >
                      确认{entry.isSelf ? '退出' : '移除'}
                    </Button>
                    <Button
                      className='button button--secondary'
                      disabled={
                        busy ||
                        hasOtherPendingRemoval(entry.membershipId) ||
                        isPendingRemoval(entry.membershipId)
                      }
                      onClick={() => {
                        setPendingRemoval(null)
                      }}
                    >
                      取消
                    </Button>
                  </View>
                ) : (
                  <Button
                    className='button button--secondary'
                    disabled={
                      busy ||
                      hasOtherPendingRemoval(entry.membershipId) ||
                      isPendingRemoval(entry.membershipId)
                    }
                    onClick={() => {
                      setPendingRemoval(entry.membershipId)
                    }}
                  >
                    {entry.isSelf ? '退出家庭' : '移除成员'}
                  </Button>
                )}
              </View>
            )}
          </View>
        )
      })}
    </View>
  )
}
