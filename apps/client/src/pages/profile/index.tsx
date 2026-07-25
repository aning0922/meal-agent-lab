import '../../zod-runtime-config'
import { useEffect, useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import type {
  DietaryConstraintId,
  HouseholdId,
  MembershipId
} from '@meal-agent/contracts'
import type { PersonProfile } from '@meal-agent/contracts/identity'

import { getAppServices } from '../../app-runtime'
import { createIdempotencyKey } from '../../core/idempotency'
import { loadMembers } from '../../core/members-flow'
import {
  addDietaryConstraint,
  archiveProfile,
  createProfile,
  removeDietaryConstraint,
  type ConstraintDraft
} from '../../core/profile-flow'
import {
  HOUSEHOLDS_ROUTE,
  LOGIN_ROUTE,
  MEMBERS_ROUTE
} from '../../platform/ports'

type PageState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'needsProfile'
      readonly membershipId: MembershipId
    }
  | { readonly kind: 'ready'; readonly profile: PersonProfile }
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

type Visibility = 'household' | 'subject_and_owner'

// 硬约束录入的二次确认：先进入 confirming，展示后果说明，确认后才提交。
type ConstraintForm = {
  readonly enforcement: 'hard' | 'soft'
  readonly label: string
  readonly allergenCode: string
  readonly preference: 'prefer' | 'dislike'
  readonly visibility: Visibility
}

const EMPTY_FORM: ConstraintForm = {
  enforcement: 'hard',
  label: '',
  allergenCode: '',
  preference: 'dislike',
  visibility: 'household'
}

export default function ProfilePage() {
  const [state, setState] = useState<PageState>({ kind: 'loading' })
  const [notice, setNotice] = useState<Notice>({ kind: 'none' })
  const [displayName, setDisplayName] = useState('')
  const [form, setForm] = useState<ConstraintForm>(EMPTY_FORM)
  const [confirmingHard, setConfirmingHard] = useState(false)
  const [busy, setBusy] = useState(false)

  const householdId =
    getAppServices().session.restoreCurrentHouseholdId()

  const refresh = async (id: HouseholdId): Promise<void> => {
    setState({ kind: 'loading' })
    const result = await loadMembers(getAppServices(), id)
    if (result.kind !== 'loaded') {
      setState(
        result.kind === 'householdMissing'
          ? result
          : { kind: 'failed', message: result.message, retryable: result.retryable }
      )
      return
    }
    // 定位本人条目：owner 视图在 members 里找 self，member 视图直接是 self。
    const self =
      result.view.viewerRole === 'member'
        ? result.view.self
        : result.view.members.find((entry) => {
            const currentUser = getAppServices().session.restore()?.user.id
            return entry.membership.userId === currentUser
          })
    if (self === undefined) {
      setState({
        kind: 'failed',
        message: '未能在成员列表中定位到本人条目。',
        retryable: true
      })
      return
    }
    if (self.profile === null) {
      setState({ kind: 'needsProfile', membershipId: self.membership.id })
    } else {
      setState({ kind: 'ready', profile: self.profile })
    }
  }

  useEffect(() => {
    const services = getAppServices()
    if (services.session.restore() === null) {
      void services.adapter.navigation.reLaunch(LOGIN_ROUTE)
      return
    }
    if (householdId === null) {
      void services.adapter.navigation.reLaunch(HOUSEHOLDS_ROUTE)
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

  const handleCreate = async (membershipId: MembershipId): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    setNotice({ kind: 'none' })
    const services = getAppServices()
    const outcome = await createProfile(
      services,
      householdId,
      {
        linkedMembershipId: membershipId,
        displayName,
        defaultParticipation: true,
        defaultPortionScale: 1,
        cookingSkill: 'beginner'
      },
      createIdempotencyKey(services.adapter.runtime)
    )
    setBusy(false)
    if (outcome.kind === 'created') {
      setNotice({ kind: 'info', message: '用餐档案已创建。' })
      setState({ kind: 'ready', profile: outcome.profile })
    } else if (outcome.kind === 'invalid') {
      setNotice({ kind: 'error', message: outcome.messages.join('；') })
    } else {
      setNotice({ kind: 'error', message: outcome.message })
    }
  }

  const submitConstraint = async (profile: PersonProfile): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    setNotice({ kind: 'none' })
    const services = getAppServices()
    const draft: ConstraintDraft =
      form.enforcement === 'hard'
        ? {
            enforcement: 'hard',
            kind: 'allergy',
            label: form.label,
            allergenCodes:
              form.allergenCode.trim() === ''
                ? []
                : [form.allergenCode.trim()],
            visibility: form.visibility,
            acknowledged: true
          }
        : {
            enforcement: 'soft',
            label: form.label,
            preference: form.preference,
            visibility: form.visibility
          }
    const outcome = await addDietaryConstraint(
      services,
      householdId,
      profile.id,
      draft,
      profile.version,
      createIdempotencyKey(services.adapter.runtime)
    )
    setBusy(false)
    setConfirmingHard(false)
    if (outcome.kind === 'added') {
      setForm(EMPTY_FORM)
      setNotice({ kind: 'info', message: '约束已登记。' })
      setState({ kind: 'ready', profile: outcome.profile })
    } else if (outcome.kind === 'invalid') {
      setNotice({ kind: 'error', message: outcome.messages.join('；') })
    } else if (outcome.kind === 'versionConflict') {
      setNotice({ kind: 'error', message: outcome.message })
      await refresh(householdId)
    } else {
      setNotice({ kind: 'error', message: outcome.message })
    }
  }

  const handleRemoveConstraint = async (
    profile: PersonProfile,
    constraintId: DietaryConstraintId
  ): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    const services = getAppServices()
    const outcome = await removeDietaryConstraint(
      services,
      householdId,
      profile.id,
      constraintId,
      profile.version,
      createIdempotencyKey(services.adapter.runtime)
    )
    setBusy(false)
    if (outcome.kind === 'removed') {
      setNotice({ kind: 'info', message: '约束已移除。' })
      setState({ kind: 'ready', profile: outcome.profile })
    } else if (outcome.kind === 'versionConflict') {
      setNotice({ kind: 'error', message: outcome.message })
      await refresh(householdId)
    } else if (outcome.kind !== 'invalid') {
      setNotice({ kind: 'error', message: outcome.message })
    }
  }

  const handleArchive = async (profile: PersonProfile): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    const services = getAppServices()
    const outcome = await archiveProfile(
      services,
      householdId,
      profile.id,
      profile.version,
      createIdempotencyKey(services.adapter.runtime)
    )
    setBusy(false)
    if (outcome.kind === 'updated') {
      setNotice({ kind: 'info', message: '档案已归档。' })
      await refresh(householdId)
    } else if (outcome.kind === 'versionConflict') {
      setNotice({ kind: 'error', message: outcome.message })
      await refresh(householdId)
    } else if (outcome.kind === 'invalid') {
      setNotice({ kind: 'error', message: outcome.messages.join('；') })
    } else {
      setNotice({ kind: 'error', message: outcome.message })
    }
  }

  return (
    <View className='page'>
      <Text className='page-title'>用餐档案与约束</Text>

      {notice.kind !== 'none' && (
        <View
          className={
            notice.kind === 'error' ? 'notice notice--error' : 'notice'
          }
        >
          <Text>{notice.message}</Text>
        </View>
      )}

      {state.kind === 'loading' && <Text>正在加载档案…</Text>}

      {state.kind === 'householdMissing' && (
        <View className='notice notice--error'>
          <Text>{state.message}</Text>
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

      {state.kind === 'needsProfile' && (
        <View className='section'>
          <Text className='section-title'>创建我的用餐档案</Text>
          <Text className='field-label'>称呼</Text>
          <Input
            className='field-input'
            value={displayName}
            placeholder='例如：我'
            onInput={(event) => {
              setDisplayName(event.detail.value)
            }}
          />
          <Text className='list-item-detail'>
            饭量、常参与、厨艺沿用默认值（本阶段固定）。
          </Text>
          <Button
            className={busy ? 'button button--disabled' : 'button'}
            disabled={busy}
            onClick={() => {
              void handleCreate(state.membershipId)
            }}
          >
            创建档案
          </Button>
        </View>
      )}

      {state.kind === 'ready' &&
        renderReady(
          state.profile,
          form,
          setForm,
          confirmingHard,
          setConfirmingHard,
          busy,
          submitConstraint,
          handleRemoveConstraint,
          handleArchive
        )}

      <Button
        className='button button--secondary'
        onClick={() => {
          void getAppServices().adapter.navigation.reLaunch(MEMBERS_ROUTE)
        }}
      >
        返回成员页
      </Button>
    </View>
  )
}

const renderReady = (
  profile: PersonProfile,
  form: ConstraintForm,
  setForm: (form: ConstraintForm) => void,
  confirmingHard: boolean,
  setConfirmingHard: (value: boolean) => void,
  busy: boolean,
  submitConstraint: (profile: PersonProfile) => Promise<void>,
  handleRemoveConstraint: (
    profile: PersonProfile,
    constraintId: DietaryConstraintId
  ) => Promise<void>,
  handleArchive: (profile: PersonProfile) => Promise<void>
) => (
  <View>
    <View className='section'>
      <Text className='section-title'>{profile.displayName}</Text>
      <Text className='list-item-detail'>
        饭量 {profile.defaultPortionScale} · 厨艺 {profile.cookingSkill} · 版本
        {profile.version}
      </Text>
    </View>

    <View className='section'>
      <Text className='section-title'>已登记约束</Text>
      {profile.dietaryConstraints.length === 0 && (
        <Text>暂无约束。</Text>
      )}
      {profile.dietaryConstraints.map((constraint) => (
        <View key={constraint.id} className='list-item'>
          <Text className='list-item-title'>
            {constraint.label}（
            {constraint.enforcement === 'hard' ? '硬约束' : '偏好'}）
          </Text>
          <Text className='list-item-detail'>
            可见性
            {constraint.visibility === 'subject_and_owner'
              ? '：仅本人与所有者'
              : '：全家可见'}
          </Text>
          <Button
            className='button button--secondary'
            disabled={busy}
            onClick={() => {
              void handleRemoveConstraint(profile, constraint.id)
            }}
          >
            移除
          </Button>
        </View>
      ))}
    </View>

    <View className='section'>
      <Text className='section-title'>新增约束</Text>
      <View className='row'>
        <Button
          className={
            form.enforcement === 'hard'
              ? 'button'
              : 'button button--secondary'
          }
          onClick={() => {
            setConfirmingHard(false)
            setForm({ ...form, enforcement: 'hard' })
          }}
        >
          硬约束
        </Button>
        <Button
          className={
            form.enforcement === 'soft'
              ? 'button'
              : 'button button--secondary'
          }
          onClick={() => {
            setConfirmingHard(false)
            setForm({ ...form, enforcement: 'soft' })
          }}
        >
          软偏好
        </Button>
      </View>

      <Text className='field-label'>标签</Text>
      <Input
        className='field-input'
        value={form.label}
        placeholder={
          form.enforcement === 'hard' ? '例如：花生过敏' : '例如：少油'
        }
        onInput={(event) => {
          setConfirmingHard(false)
          setForm({ ...form, label: event.detail.value })
        }}
      />

      {form.enforcement === 'hard' && (
        <View>
          <Text className='field-label'>过敏原编码（硬约束需结构化编码）</Text>
          <Input
            className='field-input'
            value={form.allergenCode}
            placeholder='例如：PEANUT'
            onInput={(event) => {
              setConfirmingHard(false)
              setForm({ ...form, allergenCode: event.detail.value })
            }}
          />
        </View>
      )}

      <View className='row'>
        <Button
          className={
            form.visibility === 'household'
              ? 'button'
              : 'button button--secondary'
          }
          onClick={() => {
            setForm({ ...form, visibility: 'household' })
          }}
        >
          全家可见
        </Button>
        <Button
          className={
            form.visibility === 'subject_and_owner'
              ? 'button'
              : 'button button--secondary'
          }
          onClick={() => {
            setForm({ ...form, visibility: 'subject_and_owner' })
          }}
        >
          仅本人与所有者
        </Button>
      </View>

      {form.enforcement === 'soft' ? (
        <Button
          className={busy ? 'button button--disabled' : 'button'}
          disabled={busy}
          onClick={() => {
            void submitConstraint(profile)
          }}
        >
          登记软偏好
        </Button>
      ) : confirmingHard ? (
        // 硬约束二次确认屏：展示后果说明后才允许提交。
        <View className='notice'>
          <Text>
            硬约束将强制从推荐中排除相关食物，不可由行为推断。确认登记
            “{form.label}”（{form.visibility === 'subject_and_owner'
              ? '仅本人与所有者可见'
              : '全家可见'}）吗？
          </Text>
          <Button
            className={busy ? 'button button--disabled' : 'button'}
            disabled={busy}
            onClick={() => {
              void submitConstraint(profile)
            }}
          >
            我已理解后果，确认登记
          </Button>
          <Button
            className='button button--secondary'
            onClick={() => {
              setConfirmingHard(false)
            }}
          >
            返回修改
          </Button>
        </View>
      ) : (
        <Button
          className='button'
          onClick={() => {
            setConfirmingHard(true)
          }}
        >
          继续（硬约束需二次确认）
        </Button>
      )}
    </View>

    <Button
      className='button button--secondary'
      disabled={busy}
      onClick={() => {
        void handleArchive(profile)
      }}
    >
      归档此档案
    </Button>
  </View>
)
