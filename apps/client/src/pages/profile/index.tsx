import '../../zod-runtime-config'
import { useEffect, useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import type {
  DietaryConstraintId,
  HouseholdId,
  MembershipId,
  PersonProfileId
} from '@meal-agent/contracts'
import type { PersonProfile } from '@meal-agent/contracts/identity'
import type {
  PersonProfileLinkRequest
} from '@meal-agent/contracts/members'

import { getAppServices } from '../../app-runtime'
import type {
  ClientCommandKind,
  RegisteredCommand,
  RegisteredCommandOutcome
} from '../../core/command-registry'
import { loadMembers } from '../../core/members-flow'
import type { ConstraintDraft } from '../../core/profile-flow'
import {
  HOUSEHOLDS_ROUTE,
  LOGIN_ROUTE,
  MEMBERS_ROUTE,
  PROFILE_ROUTE
} from '../../platform/ports'

type CookingSkill = 'none' | 'beginner' | 'intermediate' | 'advanced'
type Visibility = 'household' | 'subject_and_owner'
type HardKind =
  | 'allergy'
  | 'religious'
  | 'ethical'
  | 'explicit_avoid'
  | 'food_safety_exclusion'

type MemberChoice = {
  readonly id: MembershipId
  readonly label: string
}

type LinkDisclosure = {
  readonly displayName: string
  readonly hardConstraintCount: number
  readonly softConstraintCount: number
  readonly privateConstraintCount: number
}

type LoadedState = {
  readonly kind: 'loaded'
  readonly viewerRole: 'owner' | 'member'
  readonly selfMembershipId: MembershipId
  readonly profiles: readonly PersonProfile[]
  readonly linkRequests: readonly PersonProfileLinkRequest[]
  readonly members: readonly MemberChoice[]
  readonly linkDisclosures: Readonly<Record<string, LinkDisclosure>>
}

type PageState =
  | { readonly kind: 'loading' }
  | LoadedState
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

type ConstraintForm = {
  readonly enforcement: 'hard' | 'soft'
  readonly hardKind: HardKind
  readonly label: string
  readonly allergenCode: string
  readonly foodConceptId: string
  readonly preference: 'prefer' | 'dislike'
  readonly visibility: Visibility
}

const EMPTY_CONSTRAINT: ConstraintForm = {
  enforcement: 'hard',
  hardKind: 'allergy',
  label: '',
  allergenCode: '',
  foodConceptId: '',
  preference: 'dislike',
  visibility: 'household'
}

const hardKindLabel: Readonly<Record<HardKind, string>> = {
  allergy: '过敏',
  religious: '宗教',
  ethical: '伦理',
  explicit_avoid: '明确忌口',
  food_safety_exclusion: '食品安全排除'
}

const skillLabel = (
  value: CookingSkill | null
): string =>
  value === null
    ? '未知'
    : {
        none: '不会做饭',
        beginner: '新手',
        intermediate: '熟练',
        advanced: '进阶'
      }[value]

export default function ProfilePage() {
  const [state, setState] = useState<PageState>({ kind: 'loading' })
  const [notice, setNotice] = useState<Notice>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<PersonProfileId | null>(null)
  const [createName, setCreateName] = useState('')
  const [editName, setEditName] = useState('')
  const [participation, setParticipation] = useState<boolean | null>(null)
  const [portionText, setPortionText] = useState('')
  const [cookingSkill, setCookingSkill] =
    useState<CookingSkill | null>(null)
  const [constraint, setConstraint] =
    useState<ConstraintForm>(EMPTY_CONSTRAINT)
  const [confirmingHard, setConfirmingHard] = useState(false)
  const [linkTarget, setLinkTarget] = useState<MembershipId | null>(null)
  const [pendingRevision, setPendingRevision] = useState(0)
  const actionKeys = getAppServices().pendingCommands

  const householdId =
    getAppServices().session.restoreCurrentHouseholdId()

  const chooseProfile = (profile: PersonProfile): void => {
    setSelectedId(profile.id)
    setEditName(profile.displayName)
    setParticipation(profile.defaultParticipation)
    setPortionText(
      profile.defaultPortionScale === null
        ? ''
        : String(profile.defaultPortionScale)
    )
    setCookingSkill(profile.cookingSkill)
    setConstraint(EMPTY_CONSTRAINT)
    setConfirmingHard(false)
    setLinkTarget(null)
  }

  const refresh = async (id: HouseholdId): Promise<boolean> => {
    setState({ kind: 'loading' })
    const services = getAppServices()
    const membersResult = await loadMembers(services, id)
    if (membersResult.kind !== 'loaded') {
      setState(
        membersResult.kind === 'householdMissing'
          ? membersResult
          : {
              kind: 'failed',
              message: membersResult.message,
              retryable: membersResult.retryable
            }
      )
      return false
    }

    const profilesResult = await services.api.listPersonProfiles(id, 'all')
    const linksResult = await services.api.listPersonProfileLinkRequests(id)
    if (profilesResult.kind !== 'success' || linksResult.kind !== 'success') {
      setState({
        kind: 'failed',
        message: '档案读取失败，请稍后重试。',
        retryable: true
      })
      return false
    }

    const currentUserId = services.session.restore()?.user.id
    const memberEntries =
      membersResult.view.viewerRole === 'owner'
        ? membersResult.view.members
        : [membersResult.view.self, ...membersResult.view.others]
    const selfEntry =
      membersResult.view.viewerRole === 'member'
        ? membersResult.view.self
        : memberEntries.find(
            (entry) => entry.membership.userId === currentUserId
          )
    if (selfEntry === undefined) {
      setState({
        kind: 'failed',
        message: '未能在成员列表中定位本人。',
        retryable: true
      })
      return false
    }

    const profiles =
      profilesResult.data.viewerRole === 'owner'
        ? profilesResult.data.profiles
        : profilesResult.data.self === null
          ? []
          : [profilesResult.data.self]
    const linkDisclosures: Record<string, LinkDisclosure> = {}
    for (const request of linksResult.data.requests) {
      if (request.status !== 'pending') continue
      const disclosure = request.disclosure
      if (disclosure.availability !== 'available') continue
      linkDisclosures[request.id] = {
        displayName: disclosure.profileDisplayName,
        hardConstraintCount:
          disclosure.householdVisibleHardConstraintCount,
        softConstraintCount:
          disclosure.householdVisibleSoftConstraintCount,
        privateConstraintCount: disclosure.privateConstraintCount
      }
    }
    const nextState: LoadedState = {
      kind: 'loaded',
      viewerRole: profilesResult.data.viewerRole,
      selfMembershipId: selfEntry.membership.id,
      profiles,
      linkRequests: linksResult.data.requests,
      linkDisclosures,
      members: memberEntries.map((entry) => ({
        id: entry.membership.id,
        label: entry.profile?.displayName ?? '未建档成员'
      }))
    }
    setState(nextState)

    const selected =
      profiles.find((profile) => profile.id === selectedId) ??
      profiles.find(
        (profile) =>
          profile.linkedMembershipId === selfEntry.membership.id
      ) ??
      profiles[0]
    if (selected !== undefined) {
      chooseProfile(selected)
    } else {
      setSelectedId(null)
    }
    return true
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
    // 应用重启后不恢复请求体/幂等 key；先 GET 完整状态再允许新命令。
    void refresh(householdId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (householdId === null) {
    return <View className='page'><Text>未选择家庭，正在返回…</Text></View>
  }

  const executeCommand = async <K extends ClientCommandKind>(
    action: string,
    command: RegisteredCommand<K>
  ): Promise<RegisteredCommandOutcome<K> | null> => {
    if (actionKeys.hasOtherPending(action)) {
      setNotice({
        kind: 'error',
        message: '已有未决命令；只能使用保存的原请求和原幂等键重试。'
      })
      return null
    }
    setBusy(true)
    try {
      setPendingRevision((value) => value + 1)
      const outcome = await getAppServices().commands.execute(
        action,
        PROFILE_ROUTE,
        command
      )
      setPendingRevision((value) => value + 1)
      return outcome
    } catch {
      actionKeys.markUnknown(action)
      setPendingRevision((value) => value + 1)
      setNotice({
        kind: 'error',
        message: '请求结果未知；相关输入已冻结，只能使用同一请求和原幂等键重试。'
      })
      return null
    } finally {
      setBusy(false)
    }
  }

  const createNewProfile = async (
    linkedMembershipId?: MembershipId
  ): Promise<void> => {
    if (busy) return
    const payload = {
      ...(linkedMembershipId === undefined
        ? {}
        : { linkedMembershipId }),
      displayName: createName,
      defaultParticipation: null,
      defaultPortionScale: null,
      cookingSkill: null
    }
    const action =
      linkedMembershipId === undefined
        ? 'profile:create:dining'
        : `profile:create:self:${linkedMembershipId}`
    const outcome = await executeCommand(
      action,
      {
        kind: 'profile.create',
        payload: { householdId, draft: payload }
      }
    )
    if (outcome === null) return
    if (outcome.kind === 'created') {
      setCreateName('')
      setNotice({ kind: 'info', message: '用餐档案已创建。' })
      setSelectedId(outcome.profile.id)
      await refresh(householdId)
    } else if (outcome.kind === 'invalid') {
      setNotice({ kind: 'error', message: outcome.messages.join('；') })
    } else {
      setNotice({ kind: 'error', message: outcome.message })
    }
  }

  const saveProfile = async (profile: PersonProfile): Promise<void> => {
    if (busy) return
    const draft = {
      displayName: editName,
      defaultParticipation: participation,
      defaultPortionScale:
        portionText.trim() === '' ? null : Number(portionText),
      cookingSkill
    }
    const action = `profile:update:${profile.id}`
    const payload = {
      profileId: profile.id,
      draft,
      expectedVersion: profile.version
    }
    const outcome = await executeCommand(
      action,
      {
        kind: 'profile.update',
        payload: { householdId, ...payload }
      }
    )
    if (outcome === null) return
    if (outcome.kind === 'updated') {
      setNotice({ kind: 'info', message: '档案事实已更新。' })
      await refresh(householdId)
    } else if (outcome.kind === 'invalid') {
      setNotice({ kind: 'error', message: outcome.messages.join('；') })
    } else {
      setNotice({ kind: 'error', message: outcome.message })
      if (outcome.kind === 'versionConflict') await refresh(householdId)
    }
  }

  const changeArchiveState = async (
    profile: PersonProfile,
    operation: 'archive' | 'restore'
  ): Promise<void> => {
    if (busy) return
    const action = `profile:${operation}:${profile.id}`
    const payload = {
      householdId,
      profileId: profile.id,
      expectedVersion: profile.version
    }
    const outcome =
      operation === 'archive'
        ? await executeCommand(action, {
            kind: 'profile.archive',
            payload
          })
        : await executeCommand(action, {
            kind: 'profile.restore',
            payload
          })
    if (outcome === null) return
    if (outcome.kind === 'updated') {
      setNotice({
        kind: 'info',
        message: operation === 'archive' ? '档案已归档。' : '档案已恢复。'
      })
      await refresh(householdId)
    } else {
      setNotice({
        kind: 'error',
        message:
          outcome.kind === 'invalid'
            ? outcome.messages.join('；')
            : outcome.message
      })
    }
  }

  const submitConstraint = async (profile: PersonProfile): Promise<void> => {
    if (busy) return
    const foodConceptIds =
      constraint.foodConceptId.trim() === ''
        ? []
        : [constraint.foodConceptId.trim()]
    const draft: ConstraintDraft =
      constraint.enforcement === 'hard'
        ? {
            enforcement: 'hard',
            kind: constraint.hardKind,
            label: constraint.label,
            allergenCodes:
              constraint.allergenCode.trim() === ''
                ? []
                : [constraint.allergenCode.trim()],
            foodConceptIds,
            visibility: constraint.visibility,
            acknowledged: true
          }
        : {
            enforcement: 'soft',
            label: constraint.label,
            preference: constraint.preference,
            foodConceptIds,
            visibility: constraint.visibility
          }
    const action = `constraint:add:${profile.id}`
    const payload = {
      profileId: profile.id,
      draft,
      expectedVersion: profile.version
    }
    const outcome = await executeCommand(
      action,
      {
        kind: 'constraint.add',
        payload: { householdId, ...payload }
      }
    )
    if (outcome === null) return
    if (!actionKeys.hasPending(action)) {
      setConfirmingHard(false)
    }
    if (outcome.kind === 'added') {
      setConstraint(EMPTY_CONSTRAINT)
      setNotice({ kind: 'info', message: '约束已登记。' })
      await refresh(householdId)
    } else if (outcome.kind === 'invalid') {
      setNotice({ kind: 'error', message: outcome.messages.join('；') })
    } else {
      setNotice({ kind: 'error', message: outcome.message })
      if (outcome.kind === 'versionConflict') await refresh(householdId)
    }
  }

  const removeConstraint = async (
    profile: PersonProfile,
    constraintId: DietaryConstraintId
  ): Promise<void> => {
    if (busy) return
    const action = `constraint:remove:${constraintId}`
    const payload = {
      profileId: profile.id,
      constraintId,
      expectedVersion: profile.version
    }
    const outcome = await executeCommand(
      action,
      {
        kind: 'constraint.remove',
        payload: { householdId, ...payload }
      }
    )
    if (outcome === null) return
    if (outcome.kind === 'removed') {
      setNotice({ kind: 'info', message: '约束已移除。' })
      await refresh(householdId)
    } else if (outcome.kind !== 'invalid') {
      setNotice({ kind: 'error', message: outcome.message })
      if (outcome.kind === 'versionConflict') await refresh(householdId)
    }
  }

  const requestLink = async (profile: PersonProfile): Promise<void> => {
    if (linkTarget === null || busy) return
    const action = `profile:link-request:${profile.id}`
    const payload = {
      profileId: profile.id,
      request: {
        targetMembershipId: linkTarget,
        expiresInHours: 168,
        ownerConfirmation: { acknowledged: true as const }
      }
    }
    const outcome = await executeCommand(
      action,
      {
        kind: 'profile.link-request',
        payload: { householdId, ...payload }
      }
    )
    if (outcome === null) return
    if (outcome.kind === 'success') {
      setNotice({
        kind: 'info',
        message: '关联请求已发出，须由目标成员再次确认。'
      })
      await refresh(householdId)
    } else {
      setNotice({ kind: 'error', message: '关联请求提交失败。' })
    }
  }

  const confirmLink = async (
    request: PersonProfileLinkRequest
  ): Promise<void> => {
    if (busy) return
    const action = `profile:link-confirm:${request.id}`
    const payload = {
      requestId: request.id,
      request: {
        expectedVersion: request.version,
        subjectConfirmation: { acknowledged: true as const }
      }
    }
    const outcome = await executeCommand(
      action,
      {
        kind: 'profile.link-confirm',
        payload: { householdId, ...payload }
      }
    )
    if (outcome === null) return
    if (outcome.kind === 'success') {
      setNotice({ kind: 'info', message: '关联已确认。' })
      await refresh(householdId)
    } else if (
      outcome.kind === 'apiError' &&
      outcome.error.status === 409 &&
      outcome.error.code === 'CONFLICT'
    ) {
      setNotice({
        kind: 'error',
        message:
          '旧关联请求已终止。所有者必须重新发起；你重新 GET 并阅读新披露后才能再次确认。'
      })
      await refresh(householdId)
    } else if (
      outcome.kind === 'apiError' &&
      outcome.error.status === 403
    ) {
      setNotice({
        kind: 'error',
        message: '你无权确认此关联请求；不会提示所有者重新发起。'
      })
    } else if (
      outcome.kind === 'apiError' &&
      outcome.error.status === 404
    ) {
      setNotice({
        kind: 'error',
        message: '关联请求不存在或当前不可访问，请返回后重新加载。'
      })
    } else {
      setNotice({
        kind: 'error',
        message:
          '确认结果未知；关联请求可能已处理，只能用保存的原请求和原幂等键重试。'
      })
    }
  }

  const selected =
    state.kind === 'loaded'
      ? state.profiles.find((profile) => profile.id === selectedId)
      : undefined
  const selfProfile =
    state.kind === 'loaded'
      ? state.profiles.find(
          (profile) =>
            profile.linkedMembershipId === state.selfMembershipId
        )
      : undefined
  const restoreBlockedReason =
    state.kind === 'loaded' &&
    selected?.status === 'archived' &&
    selected.linkedMembershipId !== undefined &&
    !state.members.some(
      (member) => member.id === selected.linkedMembershipId
    )
      ? '关联成员当前不在家庭中，无法恢复；重新加入后仍须显式恢复原档案。'
      : null
  const pendingCommand =
    pendingRevision >= 0 ? actionKeys.activeSnapshot() : null
  const pendingAction = pendingCommand?.action ?? null
  const fieldsLocked = busy || pendingAction !== null

  return (
    <View className='page'>
      <Text className='page-title'>用餐档案与约束</Text>
      {notice.kind !== 'none' && (
        <View className={notice.kind === 'error' ? 'notice notice--error' : 'notice'}>
          <Text>{notice.message}</Text>
        </View>
      )}
      {pendingCommand !== null && (
        <View className='notice notice--error'>
          <Text>
            存在未决档案命令“{pendingCommand.action}”。所有其他写操作已禁用；
            请使用原动作按钮重试，重试会发送保存的完整请求和原幂等键。
          </Text>
          <Button
            className='button button--secondary'
            disabled={busy}
            onClick={() => {
              void (async () => {
                setBusy(true)
                try {
                  const loaded = await refresh(householdId)
                  if (loaded) {
                    actionKeys.recordObservation(
                      pendingCommand.action,
                      pendingCommand.key,
                      {
                        kind: 'resource-get',
                        observedAt: new Date(
                          getAppServices().adapter.runtime.nowMs()
                        ).toISOString(),
                        summary:
                          'members, profiles and link requests refreshed'
                      }
                    )
                    setNotice({
                      kind: 'info',
                      message:
                        '已刷新资源；普通 GET 不能证明命令是否执行，仍只能重试原命令。'
                    })
                    setPendingRevision((value) => value + 1)
                  }
                } finally {
                  setBusy(false)
                }
              })()
            }}
          >
            刷新资源（仅观察）
          </Button>
        </View>
      )}
      {state.kind === 'loading' && <Text>正在加载档案…</Text>}
      {state.kind === 'householdMissing' && (
        <View className='notice notice--error'><Text>{state.message}</Text></View>
      )}
      {state.kind === 'failed' && (
        <View className='notice notice--error'>
          <Text>{state.message}</Text>
          {state.retryable && (
            <Button className='button button--secondary' onClick={() => void refresh(householdId)}>
              重试
            </Button>
          )}
        </View>
      )}

      {state.kind === 'loaded' && (
        <>
          <View className='section'>
            <Text className='section-title'>档案列表</Text>
            {state.profiles.map((profile) => (
              <Button
                key={profile.id}
                className={profile.id === selectedId ? 'button' : 'button button--secondary'}
                disabled={fieldsLocked}
                onClick={() => chooseProfile(profile)}
              >
                {profile.displayName} · {profile.status === 'active' ? '使用中' : '已归档'}
                {profile.linkedMembershipId === undefined ? ' · 仅用餐' : ''}
              </Button>
            ))}
          </View>

          {selfProfile === undefined && (
            <CreateSection
              title='创建我的用餐档案'
              name={createName}
              setName={setCreateName}
              busy={busy}
              fieldsLocked={fieldsLocked}
              pendingAction={pendingAction}
              action={
                `profile:create:self:${state.selfMembershipId}`
              }
              onCreate={() => void createNewProfile(state.selfMembershipId)}
            />
          )}
          {state.viewerRole === 'owner' && (
            <CreateSection
              title='新建仅用餐档案'
              name={createName}
              setName={setCreateName}
              busy={busy}
              fieldsLocked={fieldsLocked}
              pendingAction={pendingAction}
              action='profile:create:dining'
              onCreate={() => void createNewProfile()}
            />
          )}

          {selected !== undefined && (
            <ProfileEditor
              profile={selected}
              viewerRole={state.viewerRole}
              members={state.members}
              linkTarget={linkTarget}
              setLinkTarget={setLinkTarget}
              editName={editName}
              setEditName={setEditName}
              participation={participation}
              setParticipation={setParticipation}
              portionText={portionText}
              setPortionText={setPortionText}
              cookingSkill={cookingSkill}
              setCookingSkill={setCookingSkill}
              constraint={constraint}
              setConstraint={setConstraint}
              confirmingHard={confirmingHard}
              setConfirmingHard={setConfirmingHard}
              busy={busy}
              fieldsLocked={fieldsLocked}
              pendingAction={pendingAction}
              restoreBlockedReason={restoreBlockedReason}
              onSave={() => void saveProfile(selected)}
              onArchive={() => void changeArchiveState(selected, 'archive')}
              onRestore={() => void changeArchiveState(selected, 'restore')}
              onAddConstraint={() => void submitConstraint(selected)}
              onRemoveConstraint={(id) => void removeConstraint(selected, id)}
              onRequestLink={() => void requestLink(selected)}
            />
          )}

          {state.linkRequests.some((request) => request.status === 'pending') && (
            <View className='section'>
              <Text className='section-title'>待确认档案关联</Text>
              {state.linkRequests
                .filter((request) => request.status === 'pending')
                .map((request) => (
                  <View key={request.id} className='list-item'>
                    {state.linkDisclosures[request.id] === undefined ? (
                      <Text>
                        档案详情暂不可安全读取，请刷新后再确认；当前不会仅凭标识符授权关联。
                      </Text>
                    ) : (
                      <>
                        <Text className='list-item-title'>
                          档案“{state.linkDisclosures[request.id]?.displayName}”
                        </Text>
                        <Text className='list-item-detail'>
                          可见约束摘要：硬约束
                          {state.linkDisclosures[request.id]?.hardConstraintCount}
                          条，偏好
                          {state.linkDisclosures[request.id]?.softConstraintCount}
                          条；另有私密约束
                          {state.linkDisclosures[request.id]?.privateConstraintCount}
                          条（不披露内容）。
                        </Text>
                        <Text className='list-item-detail'>
                          确认后，该档案将关联到你的登录成员；本人和家庭所有者可管理完整档案，
                          其他成员仅能读取家庭可见字段。退出或被移除会归档档案并保留数据，
                          重新加入不会自动恢复。
                        </Text>
                      </>
                    )}
                    {request.targetMembershipId === state.selfMembershipId && (
                      <Button
                        className='button'
                        disabled={
                          busy ||
                          state.linkDisclosures[request.id] === undefined ||
                          (
                            pendingAction !== null &&
                            pendingAction !==
                              `profile:link-confirm:${request.id}`
                          )
                        }
                        onClick={() => void confirmLink(request)}
                      >
                        我确认关联
                      </Button>
                    )}
                  </View>
                ))}
            </View>
          )}
        </>
      )}

      <Button
        className='button button--secondary'
        disabled={actionKeys.hasAnyPending()}
        onClick={() => void getAppServices().navigation.reLaunch(MEMBERS_ROUTE)}
      >
        返回成员页
      </Button>
    </View>
  )
}

const CreateSection = (props: {
  readonly title: string
  readonly name: string
  readonly setName: (value: string) => void
  readonly busy: boolean
  readonly fieldsLocked: boolean
  readonly pendingAction: string | null
  readonly action: string
  readonly onCreate: () => void
}) => (
  <View className='section'>
    <Text className='section-title'>{props.title}</Text>
    <Input
      className='field-input'
      value={props.name}
      disabled={props.fieldsLocked}
      placeholder='称呼'
      onInput={(event) => props.setName(event.detail.value)}
    />
    <Text className='list-item-detail'>
      新建时饭量、默认参与和厨艺均为“未知”，不会替用户猜测。
    </Text>
    <Button
      className='button'
      disabled={
        props.busy ||
        (
          props.pendingAction !== null &&
          props.pendingAction !== props.action
        )
      }
      onClick={props.onCreate}
    >
      创建档案
    </Button>
  </View>
)

const ProfileEditor = (props: {
  readonly profile: PersonProfile
  readonly viewerRole: 'owner' | 'member'
  readonly members: readonly MemberChoice[]
  readonly linkTarget: MembershipId | null
  readonly setLinkTarget: (value: MembershipId) => void
  readonly editName: string
  readonly setEditName: (value: string) => void
  readonly participation: boolean | null
  readonly setParticipation: (value: boolean | null) => void
  readonly portionText: string
  readonly setPortionText: (value: string) => void
  readonly cookingSkill: CookingSkill | null
  readonly setCookingSkill: (value: CookingSkill | null) => void
  readonly constraint: ConstraintForm
  readonly setConstraint: (value: ConstraintForm) => void
  readonly confirmingHard: boolean
  readonly setConfirmingHard: (value: boolean) => void
  readonly busy: boolean
  readonly fieldsLocked: boolean
  readonly pendingAction: string | null
  readonly restoreBlockedReason: string | null
  readonly onSave: () => void
  readonly onArchive: () => void
  readonly onRestore: () => void
  readonly onAddConstraint: () => void
  readonly onRemoveConstraint: (id: DietaryConstraintId) => void
  readonly onRequestLink: () => void
}) => {
  const actionBlocked = (action: string): boolean =>
    props.busy ||
    (
      props.pendingAction !== null &&
      props.pendingAction !== action
    )
  return (
  <View>
    <View className='section'>
      <Text className='section-title'>{props.profile.displayName}</Text>
      <Text className='list-item-detail'>
        状态 {props.profile.status} · 版本 {props.profile.version}
      </Text>
      {props.profile.status === 'archived' ? (
        <>
          <Button
            className='button'
            disabled={
              actionBlocked(`profile:restore:${props.profile.id}`) ||
              props.restoreBlockedReason !== null
            }
            onClick={props.onRestore}
          >
            恢复原档案
          </Button>
          {props.restoreBlockedReason !== null && (
            <Text className='list-item-detail'>
              {props.restoreBlockedReason}
            </Text>
          )}
        </>
      ) : (
        <>
          <Text className='field-label'>称呼</Text>
          <Input
            className='field-input'
            value={props.editName}
            disabled={props.fieldsLocked}
            onInput={(event) => props.setEditName(event.detail.value)}
          />
          <Text className='field-label'>默认参与</Text>
          <View className='row'>
            {([
              [null, '未知'],
              [true, '参与'],
              [false, '不参与']
            ] as const).map(([value, label]) => (
              <Button
                key={label}
                className={props.participation === value ? 'button' : 'button button--secondary'}
                disabled={props.fieldsLocked}
                onClick={() => props.setParticipation(value)}
              >
                {label}
              </Button>
            ))}
          </View>
          <Text className='field-label'>饭量倍率（留空=未知）</Text>
          <Input
            className='field-input'
            type='digit'
            value={props.portionText}
            disabled={props.fieldsLocked}
            placeholder='0.25–4'
            onInput={(event) => props.setPortionText(event.detail.value)}
          />
          <Text className='field-label'>厨艺：{skillLabel(props.cookingSkill)}</Text>
          <View className='row'>
            {([
              [null, '未知'],
              ['none', '不会'],
              ['beginner', '新手'],
              ['intermediate', '熟练'],
              ['advanced', '进阶']
            ] as const).map(([value, label]) => (
              <Button
                key={label}
                className={props.cookingSkill === value ? 'button' : 'button button--secondary'}
                disabled={props.fieldsLocked}
                onClick={() => props.setCookingSkill(value)}
              >
                {label}
              </Button>
            ))}
          </View>
          <Button
            className='button'
            disabled={actionBlocked(`profile:update:${props.profile.id}`)}
            onClick={props.onSave}
          >
            保存档案事实
          </Button>
          <Button
            className='button button--secondary'
            disabled={actionBlocked(`profile:archive:${props.profile.id}`)}
            onClick={props.onArchive}
          >
            归档
          </Button>
        </>
      )}
    </View>

    {props.profile.status === 'active' &&
      props.viewerRole === 'owner' &&
      props.profile.linkedMembershipId === undefined && (
        <View className='section'>
          <Text className='section-title'>关联登录成员（双确认）</Text>
          {props.members.map((member) => (
            <Button
              key={member.id}
              className={props.linkTarget === member.id ? 'button' : 'button button--secondary'}
              disabled={props.fieldsLocked}
              onClick={() => props.setLinkTarget(member.id)}
            >
              {member.label}
            </Button>
          ))}
          <Button
            className='button'
            disabled={
              actionBlocked(
                `profile:link-request:${props.profile.id}`
              ) || props.linkTarget === null
            }
            onClick={props.onRequestLink}
          >
            所有者确认并发起
          </Button>
        </View>
      )}

    {props.profile.status === 'active' && (
      <>
        <View className='section'>
          <Text className='section-title'>已登记约束</Text>
          {props.profile.dietaryConstraints.length === 0 && <Text>暂无约束。</Text>}
          {props.profile.dietaryConstraints.map((item) => (
            <View key={item.id} className='list-item'>
              <Text className='list-item-title'>
                {item.label}（{item.enforcement === 'hard' ? '硬约束' : '偏好'}）
              </Text>
              {item.enforcement === 'hard' && (
                <Text className='list-item-detail'>
                  映射状态：待权威结构化映射；推荐必须阻断
                </Text>
              )}
              <Text className='list-item-detail'>
                {item.visibility === 'subject_and_owner'
                  ? '仅本人与所有者可见'
                  : '全家可见'}
              </Text>
              <Button
                className='button button--secondary'
                disabled={actionBlocked(`constraint:remove:${item.id}`)}
                onClick={() => props.onRemoveConstraint(item.id)}
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
              className={props.constraint.enforcement === 'hard' ? 'button' : 'button button--secondary'}
              disabled={props.fieldsLocked}
              onClick={() => {
                props.setConfirmingHard(false)
                props.setConstraint({
                  ...props.constraint,
                  enforcement: 'hard',
                  preference: 'dislike'
                })
              }}
            >
              硬约束
            </Button>
            <Button
              className={props.constraint.enforcement === 'soft' ? 'button' : 'button button--secondary'}
              disabled={props.fieldsLocked}
              onClick={() => {
                props.setConfirmingHard(false)
                props.setConstraint({
                  ...props.constraint,
                  enforcement: 'soft',
                  allergenCode: ''
                })
              }}
            >
              普通偏好
            </Button>
          </View>
          {props.constraint.enforcement === 'hard' && (
            <View className='row'>
              {(Object.keys(hardKindLabel) as HardKind[]).map((kind) => (
                <Button
                  key={kind}
                  className={props.constraint.hardKind === kind ? 'button' : 'button button--secondary'}
                  disabled={props.fieldsLocked}
                  onClick={() => {
                    props.setConfirmingHard(false)
                    props.setConstraint({
                      ...props.constraint,
                      hardKind: kind,
                      allergenCode:
                        kind === 'allergy'
                          ? props.constraint.allergenCode
                          : ''
                    })
                  }}
                >
                  {hardKindLabel[kind]}
                </Button>
              ))}
            </View>
          )}
          <Input
            className='field-input'
            value={props.constraint.label}
            disabled={props.fieldsLocked}
            placeholder='约束名称'
            onInput={(event) => {
              props.setConfirmingHard(false)
              props.setConstraint({ ...props.constraint, label: event.detail.value })
            }}
          />
          <Input
            className='field-input'
            value={props.constraint.foodConceptId}
            disabled={props.fieldsLocked}
            placeholder='FoodConcept 标识（尚未权威映射，可选）'
            onInput={(event) => {
              props.setConfirmingHard(false)
              props.setConstraint({ ...props.constraint, foodConceptId: event.detail.value })
            }}
          />
          {props.constraint.enforcement === 'hard' &&
            props.constraint.hardKind === 'allergy' && (
              <Input
                className='field-input'
                value={props.constraint.allergenCode}
                disabled={props.fieldsLocked}
                placeholder='权威 allergen 标识（可选；不知道请留空）'
                onInput={(event) => {
                  props.setConfirmingHard(false)
                  props.setConstraint({ ...props.constraint, allergenCode: event.detail.value })
                }}
              />
            )}
          <Button
            className='button button--secondary'
            disabled={props.fieldsLocked}
            onClick={() => {
              props.setConfirmingHard(false)
              props.setConstraint({
                ...props.constraint,
                visibility:
                  props.constraint.visibility === 'household'
                    ? 'subject_and_owner'
                    : 'household'
              })
            }}
          >
            可见性：
            {props.constraint.visibility === 'household'
              ? '全家'
              : '仅本人与所有者'}
          </Button>
          {props.constraint.enforcement === 'hard' && !props.confirmingHard ? (
            <View>
              <Text className='list-item-detail'>
                当前尚无权威词表；只填写自然语言名称也可诚实登记。五类硬约束均保持
                “待结构化映射”，在安全闭环前一律阻断推荐。
              </Text>
              <Button
                className='button'
                disabled={props.fieldsLocked}
                onClick={() => props.setConfirmingHard(true)}
              >
                进入硬约束确认
              </Button>
            </View>
          ) : props.constraint.enforcement === 'hard' ? (
            <View className='notice'>
              <Text>
                请确认：类型 {hardKindLabel[props.constraint.hardKind]}、名称
                {props.constraint.label || '（空）'}、可见性
                {props.constraint.visibility === 'household' ? '全家' : '私密'}、
                FoodConcept 标识
                {props.constraint.foodConceptId || '（无）'}、allergen 标识
                {props.constraint.allergenCode || '（无）'}、映射状态
                needs_structured_mapping。五类硬约束均将阻断推荐，模型不得猜测。
              </Text>
              <Button
                className='button'
                disabled={actionBlocked(`constraint:add:${props.profile.id}`)}
                onClick={props.onAddConstraint}
              >
                确认全部字段并登记
              </Button>
            </View>
          ) : (
            <Button
              className='button'
              disabled={actionBlocked(`constraint:add:${props.profile.id}`)}
              onClick={props.onAddConstraint}
            >
              添加偏好
            </Button>
          )}
        </View>
      </>
    )}
  </View>
  )
}
