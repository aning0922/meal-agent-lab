import '../../zod-runtime-config'
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import type { HouseholdId, PersonProfileId } from '@meal-agent/contracts'
import type { Recommendation } from '@meal-agent/contracts/meals'

import { getAppServices } from '../../app-runtime'
import { usePendingCommandSubscription } from '../../components/use-pending-command-subscription'
import type { RecommendationDraft } from '../../core/recommendation-flow'
import {
  MEALS_ROUTE,
  HOUSEHOLDS_ROUTE,
  LOGIN_ROUTE
} from '../../platform/ports'

type ProfileListState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded'
      readonly profiles: readonly SelectableProfile[]
    }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

interface SelectableProfile {
  readonly id: PersonProfileId
  readonly displayName: string
  readonly cookingSkill:
    | 'none'
    | 'beginner'
    | 'intermediate'
    | 'advanced'
    | null
}

type SubmitState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | { readonly kind: 'invalid'; readonly messages: readonly string[] }
  | { readonly kind: 'forbidden'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }
  | { readonly kind: 'blocked'; readonly blockerCodes: readonly string[] }
  | {
      readonly kind: 'generated'
      readonly recommendation: Recommendation
      readonly replayed: boolean
    }

interface Banner {
  readonly tone: 'info' | 'success' | 'warning' | 'error'
  readonly text: string
}

const COOKING_SKILL_TEXT: Record<string, string> = {
  none: '不下厨',
  beginner: '入门',
  intermediate: '熟练',
  advanced: '精通'
}

const BLOCKER_TEXT: Record<string, string> = {
  'menu.blocked.hard_constraint_allergy':
    '全桌过敏原硬约束命中（含不参加本餐的成员），已阻断。',
  'menu.blocked.hard_constraint_personal': '参与者个人硬约束命中，已阻断。',
  'menu.blocked.food_concept_unresolved':
    '食材缺少权威 foodConceptId，已 fail closed，未按名称匹配。',
  'menu.blocked.hard_constraint_unmapped':
    '存在无结构化代码的硬约束，无法证明已满足，已 fail closed。',
  'menu.blocked.no_recipe_within_time_budget':
    '在时间预算内没有合格的 active 食谱。',
  'menu.blocked.cook_skill_insufficient': '合格食谱全部超出厨艺上限。',
  'menu.blocked.purchase_tolerance_exceeded': '缺少项超出采购容忍度。',
  'menu.blocked.insufficient_suggested_dishes': '合格候选数少于建议菜数。',
  'menu.blocked.no_active_recipe': '当前没有 active 食谱 revision。',
  'menu.blocked.input_invalid': '本次条件不合法，请检查后重试。'
}

const blockerText = (code: string): string =>
  BLOCKER_TEXT[code] ?? `安全阻断：${code}`

const TOLERANCES = [
  ['none', '不允许采购'],
  ['limited', '仅可采购可选配料'],
  ['allowed', '允许采购']
] as const

export default function MealsPage() {
  usePendingCommandSubscription()
  const [householdId, setHouseholdId] = useState<HouseholdId | null>(null)
  const [profiles, setProfiles] = useState<ProfileListState>({
    kind: 'loading'
  })
  const [participantIds, setParticipantIds] = useState<
    readonly PersonProfileId[]
  >([])
  const [cookId, setCookId] = useState<PersonProfileId | null>(null)
  const [maxMinutes, setMaxMinutes] = useState('30')
  const [tolerance, setTolerance] =
    useState<'none' | 'limited' | 'allowed'>('none')
  const [dishCount, setDishCount] = useState(1)
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' })
  const [banner, setBanner] = useState<Banner | null>(null)
  const actionKeys = getAppServices().pendingCommands
  const epochRef = useRef(0)

  const leaveToHouseholds = async (): Promise<void> => {
    const services = getAppServices()
    await services.navigation.reLaunch(HOUSEHOLDS_ROUTE, () =>
      services.session.clearCurrentHouseholdId()
    )
  }

  const loadProfiles = async (
    activeHouseholdId: HouseholdId
  ): Promise<void> => {
    const epoch = ++epochRef.current
    setProfiles({ kind: 'loading' })
    const outcome = await getAppServices().api.listPersonProfiles(
      activeHouseholdId,
      'active'
    )
    if (epochRef.current !== epoch) return
    switch (outcome.kind) {
      case 'success': {
        const data = outcome.data
        const list: SelectableProfile[] =
          data.viewerRole === 'owner'
            ? data.profiles.map((profile) => ({
                id: profile.id,
                displayName: profile.displayName,
                cookingSkill: profile.cookingSkill
              }))
            : [
                ...(data.self === null
                  ? []
                  : [
                      {
                        id: data.self.id,
                        displayName: data.self.displayName,
                        cookingSkill: data.self.cookingSkill
                      }
                    ]),
                ...data.others.map((profile) => ({
                  id: profile.id,
                  displayName: profile.displayName,
                  cookingSkill: profile.cookingSkill
                }))
              ]
        setProfiles({ kind: 'loaded', profiles: list })
        return
      }
      case 'apiError':
        if (outcome.error.code === 'RESOURCE_NOT_FOUND') {
          await leaveToHouseholds()
          return
        }
        setProfiles({
          kind: 'failed',
          message: '加载用餐档案失败，请重试。',
          retryable: outcome.error.retryable
        })
        return
      case 'transportError':
        setProfiles({ kind: 'failed', message: '网络连接失败。', retryable: true })
        return
      case 'malformedResponse':
        setProfiles({
          kind: 'failed',
          message: '服务响应不符合契约。',
          retryable: false
        })
    }
  }

  useEffect(() => {
    const services = getAppServices()
    if (services.session.restore() === null) {
      void services.navigation.reLaunch(LOGIN_ROUTE)
      return
    }
    const currentId = services.session.restoreCurrentHouseholdId()
    if (currentId === null) {
      void services.navigation.reLaunch(HOUSEHOLDS_ROUTE)
      return
    }
    setHouseholdId(currentId)
    void loadProfiles(currentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleParticipant = (profileId: PersonProfileId): void => {
    setParticipantIds((previous) =>
      previous.includes(profileId)
        ? previous.filter((id) => id !== profileId)
        : [...previous, profileId]
    )
  }

  const buildDraft = (): RecommendationDraft | null => {
    if (cookId === null || participantIds.length === 0) return null
    const minutes = Number.parseInt(maxMinutes, 10)
    return {
      participantProfileIds: participantIds,
      cookProfileId: cookId,
      maximumTotalMinutes: Number.isFinite(minutes) ? minutes : 0,
      purchaseTolerance: tolerance,
      suggestedDishCount: dishCount
    }
  }

  const handleGenerate = async (): Promise<void> => {
    if (householdId === null || submit.kind === 'working') return
    const services = getAppServices()
    const action = 'recommendation:generate'
    if (actionKeys.hasOtherPending(action)) {
      setSubmit({
        kind: 'failed',
        message: '当前有未决写命令，只能使用原请求重试。',
        retryable: false
      })
      return
    }
    const draft = buildDraft()
    if (draft === null) {
      setSubmit({
        kind: 'invalid',
        messages: ['请至少选择一位用餐者，并指定一位厨师。']
      })
      return
    }
    setSubmit({ kind: 'working' })
    let outcome: Awaited<ReturnType<typeof generateViaCommand>>
    try {
      outcome = await generateViaCommand(services, householdId, draft)
    } catch {
      setSubmit({
        kind: 'failed',
        message: '请求结果未知；请保持当前条件并使用同一请求重试。',
        retryable: true
      })
      return
    }
    switch (outcome.kind) {
      case 'generated':
        if (outcome.recommendation.outcome === 'no_feasible_option') {
          setSubmit({
            kind: 'blocked',
            blockerCodes: outcome.recommendation.blockerCodes
          })
          setBanner({
            tone: 'warning',
            text: '硬约束下没有可行候选。这是安全结果，不是故障。'
          })
          return
        }
        setSubmit({
          kind: 'generated',
          recommendation: outcome.recommendation,
          replayed: outcome.replayed
        })
        setBanner({
          tone: 'success',
          text: outcome.replayed
            ? '重复提交：已返回第一次生成的结果。'
            : '已生成候选菜单。'
        })
        return
      case 'invalid':
        setSubmit(outcome)
        return
      case 'forbidden':
        setSubmit(outcome)
        return
      case 'householdMissing':
        await leaveToHouseholds()
        return
      case 'failed':
        setSubmit(outcome)
    }
  }

  const chip = (active: boolean): string =>
    active ? 'chip chip--active' : 'chip'
  const locked = submit.kind === 'working' || actionKeys.hasAnyPending()
  const pendingEnvelope = actionKeys.activeSnapshot()
  const hasPendingGenerate =
    pendingEnvelope?.command.kind === 'recommendation.generate'

  return (
    <View className='page'>
      <Text className='page-title'>今天吃什么</Text>

      {banner !== null && (
        <Text className={`notice notice--${banner.tone}`}>{banner.text}</Text>
      )}

      {hasPendingGenerate && pendingEnvelope !== null && (
        <View className='notice notice--error'>
          <Text>
            上一次生成结果未知。刷新不能证明命令是否执行；只能使用保存的条件
            与同一幂等键重试。
          </Text>
          <Button
            className='button'
            disabled={submit.kind === 'working'}
            onClick={() => {
              void handleGenerate()
            }}
          >
            重试原生成
          </Button>
        </View>
      )}

      <View className='chip-row'>
        <Text
          className='chip'
          onClick={() => {
            void leaveToHouseholds()
          }}
        >
          切换家庭
        </Text>
        <Text
          className='chip'
          onClick={() => {
            if (householdId !== null) void loadProfiles(householdId)
          }}
        >
          刷新档案
        </Text>
      </View>

      <View className='section'>
        <Text className='section-title'>本餐条件</Text>

        {profiles.kind === 'loading' && <Text>正在加载用餐档案…</Text>}
        {profiles.kind === 'failed' && (
          <View>
            <Text className='notice notice--error'>{profiles.message}</Text>
            {profiles.retryable && householdId !== null && (
              <Button
                className='button button--secondary'
                onClick={() => {
                  void loadProfiles(householdId)
                }}
              >
                重试加载
              </Button>
            )}
          </View>
        )}
        {profiles.kind === 'loaded' && profiles.profiles.length === 0 && (
          <Text>
            当前家庭还没有 active 用餐档案。请先在档案页创建成员档案。
          </Text>
        )}

        {profiles.kind === 'loaded' && profiles.profiles.length > 0 && (
          <View>
            <Text className='field-label'>用餐者（可多选）</Text>
            <View className='chip-row'>
              {profiles.profiles.map((profile) => (
                <Text
                  key={profile.id}
                  className={chip(participantIds.includes(profile.id))}
                  aria-disabled={locked}
                  onClick={() => {
                    if (!locked) toggleParticipant(profile.id)
                  }}
                >
                  {profile.displayName}
                </Text>
              ))}
            </View>

            <Text className='field-label'>厨师（单选）</Text>
            <View className='chip-row'>
              {profiles.profiles.map((profile) => (
                <Text
                  key={profile.id}
                  className={chip(cookId === profile.id)}
                  aria-disabled={locked}
                  onClick={() => {
                    if (!locked) setCookId(profile.id)
                  }}
                >
                  {profile.displayName}
                  {profile.cookingSkill === null
                    ? ''
                    : ` · ${COOKING_SKILL_TEXT[profile.cookingSkill]}`}
                </Text>
              ))}
            </View>

            <Text className='field-label'>总时间上限（分钟）</Text>
            <Input
              className='field-input'
              value={maxMinutes}
              disabled={locked}
              placeholder='例如：30'
              onInput={(event) => {
                setMaxMinutes(event.detail.value)
              }}
            />

            <Text className='field-label'>采购容忍度</Text>
            <View className='chip-row'>
              {TOLERANCES.map(([value, label]) => (
                <Text
                  key={value}
                  className={chip(tolerance === value)}
                  aria-disabled={locked}
                  onClick={() => {
                    if (!locked) setTolerance(value)
                  }}
                >
                  {label}
                </Text>
              ))}
            </View>

            <Text className='field-label'>建议菜数</Text>
            <View className='chip-row'>
              {[1, 2, 3].map((count) => (
                <Text
                  key={count}
                  className={chip(dishCount === count)}
                  aria-disabled={locked}
                  onClick={() => {
                    if (!locked) setDishCount(count)
                  }}
                >
                  {count}
                </Text>
              ))}
            </View>

            {submit.kind === 'invalid' && (
              <View className='notice notice--error'>
                {submit.messages.map((message) => (
                  <Text key={message}>{message}</Text>
                ))}
              </View>
            )}
            {submit.kind === 'forbidden' && (
              <View className='notice notice--error'>
                <Text>{submit.message}</Text>
              </View>
            )}
            {submit.kind === 'failed' && (
              <View className='notice notice--error'>
                <Text>{submit.message}</Text>
                {submit.retryable && (
                  <Text>（已保留条件，可使用同一请求重试）</Text>
                )}
              </View>
            )}

            <Button
              className={
                submit.kind === 'working'
                  ? 'button button--disabled'
                  : 'button'
              }
              disabled={
                submit.kind === 'working' ||
                actionKeys.hasOtherPending('recommendation:generate')
              }
              onClick={() => {
                void handleGenerate()
              }}
            >
              {submit.kind === 'working' ? '正在生成…' : '生成推荐'}
            </Button>
          </View>
        )}
      </View>

      {submit.kind === 'blocked' && (
        <View className='section'>
          <Text className='section-title'>安全阻断（这是正确结果）</Text>
          <Text className='notice notice--warning'>
            在全部硬约束下没有任何可行候选。受限家庭得到诚实阻断，而不是
            未经验证的菜单。
          </Text>
          {submit.blockerCodes.map((code) => (
            <Text key={code} className='list-item-detail'>
              · {blockerText(code)}
            </Text>
          ))}
        </View>
      )}

      {submit.kind === 'generated' && (
        <View className='section'>
          <Text className='section-title'>候选菜品</Text>
          {submit.recommendation.candidates.map((candidate) => (
            <View key={candidate.id} className='list-item'>
              <Text className='list-item-title'>
                {candidate.dishRole} · {candidate.totalMinutes} 分钟 · 版本 v
                {candidate.recipeVersion}
              </Text>
              <Text className='list-item-detail'>
                食谱 {candidate.recipeId} · 供应 {candidate.servings} 份
              </Text>
              <Text className='list-item-detail'>
                {candidate.missingFoodConceptIds.length === 0
                  ? '库存已覆盖全部所需食材。'
                  : `缺少 ${candidate.missingFoodConceptIds.length} 项食材。`}
              </Text>
              <Text className='list-item-detail'>
                硬约束检查：{candidate.hardConstraintCheck.status}（
                {candidate.hardConstraintCheck.policyVersion}）
              </Text>
            </View>
          ))}
          {submit.recommendation.preselectedCandidateIds.length > 0 && (
            <Text className='list-item-detail'>
              预选 {' '}
              {submit.recommendation.preselectedCandidateIds.length} 道。
            </Text>
          )}
        </View>
      )}
    </View>
  )
}

const generateViaCommand = async (
  services: ReturnType<typeof getAppServices>,
  householdId: HouseholdId,
  draft: RecommendationDraft
) =>
  services.commands.execute('recommendation:generate', MEALS_ROUTE, {
    kind: 'recommendation.generate',
    payload: { householdId, draft }
  })
