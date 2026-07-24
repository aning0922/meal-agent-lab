import { useEffect, useRef, useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import type { IdempotencyKey } from '@meal-agent/contracts/api'
import type { Household } from '@meal-agent/contracts/identity'

import { getAppServices } from '../../app-runtime'
import { signOut } from '../../core/auth-flow'
import {
  createHousehold,
  loadHouseholds,
  HOUSEHOLD_DEFAULTS
} from '../../core/household-flow'
import { createIdempotencyKey } from '../../core/idempotency'
import { joinHousehold } from '../../core/members-flow'
import {
  INVENTORY_ROUTE,
  LOGIN_ROUTE,
  MEMBERS_ROUTE
} from '../../platform/ports'

type ListState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded'
      readonly households: readonly Household[]
      readonly hasMore: boolean
    }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

type SubmitState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

export default function HouseholdsPage() {
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [name, setName] = useState('')
  const [ownerDisplayName, setOwnerDisplayName] = useState('')
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' })
  const [signingOut, setSigningOut] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [joinState, setJoinState] = useState<SubmitState>({ kind: 'idle' })
  const pendingKeyRef = useRef<IdempotencyKey | null>(null)
  const currentHouseholdId =
    getAppServices().session.restoreCurrentHouseholdId()

  const refreshList = async (): Promise<void> => {
    setList({ kind: 'loading' })
    const result = await loadHouseholds(getAppServices())
    if (result.kind === 'loaded') {
      setList({
        kind: 'loaded',
        households: result.page.items,
        hasMore: result.page.pageInfo.hasMore
      })
    } else {
      setList(result)
    }
  }

  useEffect(() => {
    const services = getAppServices()
    if (services.session.restore() === null) {
      void services.adapter.navigation.reLaunch(LOGIN_ROUTE)
      return
    }
    void refreshList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openHousehold = async (household: Household): Promise<void> => {
    const services = getAppServices()
    services.session.saveCurrentHouseholdId(household.id)
    await services.adapter.navigation.reLaunch(INVENTORY_ROUTE)
  }

  const openMembers = async (household: Household): Promise<void> => {
    const services = getAppServices()
    services.session.saveCurrentHouseholdId(household.id)
    await services.adapter.navigation.navigateTo(MEMBERS_ROUTE)
  }

  const handleJoin = async (): Promise<void> => {
    if (joinState.kind === 'working') {
      return
    }
    setJoinState({ kind: 'working' })
    const services = getAppServices()
    // 每次加入是一次逻辑写操作；成功或失败后都换新键。
    const outcome = await joinHousehold(
      services,
      inviteCode,
      createIdempotencyKey(services.adapter.runtime)
    )
    switch (outcome.kind) {
      case 'joined':
        setJoinState({ kind: 'idle' })
        setInviteCode('')
        // 成功加入后切到该家庭的成员页。
        await services.adapter.navigation.navigateTo(MEMBERS_ROUTE)
        return
      case 'invalid':
        setJoinState({ kind: 'invalid', messages: outcome.messages })
        return
      case 'inviteInvalid':
      case 'alreadyMember':
        setJoinState({
          kind: 'failed',
          message: outcome.message,
          retryable: false
        })
        return
      case 'failed':
        setJoinState({
          kind: 'failed',
          message: outcome.message,
          retryable: outcome.retryable
        })
    }
  }

  const handleCreate = async (): Promise<void> => {
    if (submit.kind === 'working') {
      return
    }
    setSubmit({ kind: 'working' })
    const services = getAppServices()
    // 同一次逻辑提交（含失败重试）复用同一幂等键；表单修改后换新键。
    pendingKeyRef.current ??= createIdempotencyKey(
      services.adapter.runtime
    )
    const outcome = await createHousehold(
      services,
      { name, ownerDisplayName },
      pendingKeyRef.current
    )
    switch (outcome.kind) {
      case 'created':
        pendingKeyRef.current = null
        await services.adapter.navigation.reLaunch(INVENTORY_ROUTE)
        return
      case 'invalid':
        // 本地校验失败不算发起过写操作，允许直接换键重新提交。
        pendingKeyRef.current = null
        setSubmit(outcome)
        return
      case 'failed':
        setSubmit(outcome)
    }
  }

  const handleSignOut = async (): Promise<void> => {
    if (signingOut) {
      return
    }
    setSigningOut(true)
    const services = getAppServices()
    await signOut(services)
    await services.adapter.navigation.reLaunch(LOGIN_ROUTE)
  }

  return (
    <View className='page'>
      <Text className='page-title'>选择家庭</Text>

      <View className='section'>
        <Text className='section-title'>我的家庭</Text>
        {list.kind === 'loading' && <Text>正在加载家庭列表…</Text>}
        {list.kind === 'failed' && (
          <View>
            <Text className='notice notice--error'>{list.message}</Text>
            {list.retryable && (
              <Button
                className='button button--secondary'
                onClick={() => {
                  void refreshList()
                }}
              >
                重试加载
              </Button>
            )}
          </View>
        )}
        {list.kind === 'loaded' && list.households.length === 0 && (
          <Text>还没有家庭。请在下方创建你的第一个家庭。</Text>
        )}
        {list.kind === 'loaded' &&
          list.households.map((household) => (
            <View key={household.id} className='list-item'>
              <Text
                className='list-item-title'
                onClick={() => {
                  void openHousehold(household)
                }}
              >
                {household.name}
                {household.id === currentHouseholdId ? '（当前）' : ''}
              </Text>
              <Text className='list-item-detail'>
                时区 {household.timezone} · 语言 {household.locale}
              </Text>
              <View className='row'>
                <Button
                  className='button button--secondary'
                  onClick={() => {
                    void openHousehold(household)
                  }}
                >
                  库存
                </Button>
                <Button
                  className='button button--secondary'
                  onClick={() => {
                    void openMembers(household)
                  }}
                >
                  成员与档案
                </Button>
              </View>
            </View>
          ))}
        {list.kind === 'loaded' && list.hasMore && (
          <Text className='list-item-detail'>
            仅显示前 50 个家庭；更多家庭的浏览不在本阶段范围。
          </Text>
        )}
      </View>

      <View className='section'>
        <Text className='section-title'>凭邀请码加入家庭</Text>
        {joinState.kind === 'invalid' && (
          <View className='notice notice--error'>
            {joinState.messages.map((message) => (
              <Text key={message}>{message}</Text>
            ))}
          </View>
        )}
        {joinState.kind === 'failed' && (
          <View className='notice notice--error'>
            <Text>{joinState.message}</Text>
          </View>
        )}
        <Text className='field-label'>邀请码</Text>
        <Input
          className='field-input'
          value={inviteCode}
          placeholder='粘贴家庭所有者提供的邀请码'
          onInput={(event) => {
            setInviteCode(event.detail.value)
          }}
        />
        <Button
          className={
            joinState.kind === 'working'
              ? 'button button--disabled'
              : 'button'
          }
          disabled={joinState.kind === 'working'}
          onClick={() => {
            void handleJoin()
          }}
        >
          {joinState.kind === 'working' ? '正在加入…' : '加入家庭'}
        </Button>
      </View>

      <View className='section'>
        <Text className='section-title'>创建新家庭</Text>

        {submit.kind === 'invalid' && (
          <View className='notice notice--error'>
            {submit.messages.map((message) => (
              <Text key={message}>{message}</Text>
            ))}
          </View>
        )}
        {submit.kind === 'failed' && (
          <View className='notice notice--error'>
            <Text>{submit.message}</Text>
            {submit.retryable && (
              <Text>（已保留输入，可使用同一请求重试）</Text>
            )}
          </View>
        )}

        <Text className='field-label'>家庭名称</Text>
        <Input
          className='field-input'
          value={name}
          placeholder='例如：我家'
          onInput={(event) => {
            setName(event.detail.value)
            pendingKeyRef.current = null
          }}
        />

        <Text className='field-label'>我的称呼</Text>
        <Input
          className='field-input'
          value={ownerDisplayName}
          placeholder='例如：小明'
          onInput={(event) => {
            setOwnerDisplayName(event.detail.value)
            pendingKeyRef.current = null
          }}
        />

        <Text className='list-item-detail'>
          时区 {HOUSEHOLD_DEFAULTS.timezone} · 语言{' '}
          {HOUSEHOLD_DEFAULTS.locale} · 厨艺默认
          {' beginner'}（本阶段固定默认值）
        </Text>

        <Button
          className={
            submit.kind === 'working'
              ? 'button button--disabled'
              : 'button'
          }
          disabled={submit.kind === 'working'}
          onClick={() => {
            void handleCreate()
          }}
        >
          {submit.kind === 'working' ? '正在创建…' : '创建家庭'}
        </Button>
      </View>

      <Button
        className={
          signingOut
            ? 'button button--secondary button--disabled'
            : 'button button--secondary'
        }
        disabled={signingOut}
        onClick={() => {
          void handleSignOut()
        }}
      >
        {signingOut ? '正在退出…' : '退出登录'}
      </Button>
    </View>
  )
}
