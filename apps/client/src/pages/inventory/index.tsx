import '../../zod-runtime-config'
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import type { Confidence, HouseholdId } from '@meal-agent/contracts'
import type {
  InventoryLot,
  StorageLocation
} from '@meal-agent/contracts/inventory'

import { getAppServices } from '../../app-runtime'
import {
  CONFIDENCE_TEXT,
  formatQuantity,
  STORAGE_LOCATION_TEXT
} from '../../core/format'
import {
  consumeInventoryLot,
  createInventoryLot,
  loadInventoryLots,
  type CreateLotQuantityDraft
} from '../../core/inventory-flow'
import {
  dispositionForOutcome,
  PendingActionIdempotency
} from '../../core/idempotency'
import {
  HOUSEHOLDS_ROUTE,
  LOGIN_ROUTE
} from '../../platform/ports'

type ListState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded'
      readonly lots: readonly InventoryLot[]
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

interface Banner {
  readonly tone: 'info' | 'success' | 'error'
  readonly text: string
}

type QuantityKind = CreateLotQuantityDraft['kind']

const STORAGE_LOCATIONS: readonly StorageLocation[] = [
  'pantry',
  'refrigerated',
  'frozen',
  'other'
]
const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low']
const QUALITATIVE_LEVELS = [
  'plenty',
  'some',
  'low',
  'unknown'
] as const
const QUALITATIVE_LEVEL_LABEL: Record<
  (typeof QUALITATIVE_LEVELS)[number],
  string
> = {
  plenty: '充足',
  some: '一些',
  low: '偏少',
  unknown: '未知'
}

export default function InventoryPage() {
  const [householdId, setHouseholdId] = useState<HouseholdId | null>(null)
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [banner, setBanner] = useState<Banner | null>(null)

  const [showCreate, setShowCreate] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftLocation, setDraftLocation] =
    useState<StorageLocation>('pantry')
  const [quantityKind, setQuantityKind] = useState<QuantityKind>('exact')
  const [exactAmount, setExactAmount] = useState('')
  const [exactUnit, setExactUnit] = useState('')
  const [approxAmount, setApproxAmount] = useState('')
  const [approxUnit, setApproxUnit] = useState('')
  const [approxConfidence, setApproxConfidence] =
    useState<Confidence>('medium')
  const [approxOriginalText, setApproxOriginalText] = useState('')
  const [qualLevel, setQualLevel] =
    useState<(typeof QUALITATIVE_LEVELS)[number]>('some')
  const [qualOriginalText, setQualOriginalText] = useState('')
  const [createStatus, setCreateStatus] = useState<SubmitState>({
    kind: 'idle'
  })
  const [consumeLotId, setConsumeLotId] = useState<string | null>(null)
  const [consumeAmount, setConsumeAmount] = useState('')
  const [consumeStatus, setConsumeStatus] = useState<SubmitState>({
    kind: 'idle'
  })
  const [actionKeys] = useState(
    () =>
      new PendingActionIdempotency(
        getAppServices().adapter.runtime
      )
  )
  // 列表纪元：消耗成功会使在途的旧列表响应作废，防止旧快照覆盖新状态。
  const listEpochRef = useRef(0)

  const leaveToHouseholds = async (): Promise<void> => {
    const services = getAppServices()
    services.session.clearCurrentHouseholdId()
    await services.adapter.navigation.reLaunch(HOUSEHOLDS_ROUTE)
  }

  const refresh = async (
    activeHouseholdId: HouseholdId
  ): Promise<void> => {
    const epoch = ++listEpochRef.current
    setList({ kind: 'loading' })
    const result = await loadInventoryLots(
      getAppServices(),
      activeHouseholdId
    )
    if (listEpochRef.current !== epoch) {
      // 期间发生了更新（新刷新或消耗成功），本次结果已过期，丢弃。
      return
    }
    switch (result.kind) {
      case 'loaded':
        setList({
          kind: 'loaded',
          lots: result.page.items,
          hasMore: result.page.pageInfo.hasMore
        })
        return
      case 'householdMissing':
        await leaveToHouseholds()
        return
      case 'failed':
        setList(result)
    }
  }

  useEffect(() => {
    const services = getAppServices()
    if (services.session.restore() === null) {
      void services.adapter.navigation.reLaunch(LOGIN_ROUTE)
      return
    }
    const currentId = services.session.restoreCurrentHouseholdId()
    if (currentId === null) {
      void services.adapter.navigation.reLaunch(HOUSEHOLDS_ROUTE)
      return
    }
    setHouseholdId(currentId)
    void refresh(currentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resetCreateForm = (): void => {
    setDraftName('')
    setExactAmount('')
    setExactUnit('')
    setApproxAmount('')
    setApproxUnit('')
    setApproxOriginalText('')
    setQualOriginalText('')
    setCreateStatus({ kind: 'idle' })
  }

  const buildQuantityDraft = (): CreateLotQuantityDraft => {
    switch (quantityKind) {
      case 'exact':
        return { kind: 'exact', amount: exactAmount, unit: exactUnit }
      case 'approximate':
        return {
          kind: 'approximate',
          amount: approxAmount,
          unit: approxUnit,
          confidence: approxConfidence,
          originalText: approxOriginalText
        }
      case 'qualitative':
        return {
          kind: 'qualitative',
          level: qualLevel,
          originalText: qualOriginalText
        }
    }
  }

  const handleCreate = async (): Promise<void> => {
    if (householdId === null || createStatus.kind === 'working') {
      return
    }
    setCreateStatus({ kind: 'working' })
    const services = getAppServices()
    const action = 'inventory:create'
    const payload = {
      displayName: draftName,
      storageLocation: draftLocation,
      quantity: buildQuantityDraft()
    }
    let outcome: Awaited<ReturnType<typeof createInventoryLot>>
    try {
      outcome = await createInventoryLot(
        services,
        householdId,
        payload,
        actionKeys.acquire(action, payload)
      )
    } catch {
      actionKeys.markUnknown(action)
      setCreateStatus({
        kind: 'failed',
        message: '请求结果未知；请保持当前输入并使用同一请求重试。',
        retryable: true
      })
      return
    }
    actionKeys.settle(action, dispositionForOutcome(outcome))
    switch (outcome.kind) {
      case 'created':
        setBanner({
          tone: 'success',
          text: outcome.replayed
            ? `重复提交：已返回第一次创建“${outcome.result.lot.displayName}”的结果（${outcome.result.event.recordedAt}）。`
            : `已创建批次“${outcome.result.lot.displayName}”。`
        })
        resetCreateForm()
        setShowCreate(false)
        await refresh(householdId)
        return
      case 'invalid':
        setCreateStatus(outcome)
        return
      case 'householdMissing':
        await leaveToHouseholds()
        return
      case 'failed':
        setCreateStatus(outcome)
    }
  }

  const handleConsume = async (lot: InventoryLot): Promise<void> => {
    if (householdId === null || consumeStatus.kind === 'working') {
      return
    }
    setConsumeStatus({ kind: 'working' })
    const services = getAppServices()
    const action = `inventory:consume:${lot.id}`
    const payload = {
      lotId: lot.id,
      expectedVersion: lot.version,
      amount: consumeAmount.trim()
    }
    let outcome: Awaited<ReturnType<typeof consumeInventoryLot>>
    try {
      outcome = await consumeInventoryLot(
        services,
        householdId,
        lot,
        consumeAmount,
        actionKeys.acquire(action, payload)
      )
    } catch {
      actionKeys.markUnknown(action)
      setConsumeStatus({
        kind: 'failed',
        message: '消耗结果未知；请保持数量并使用同一请求重试。',
        retryable: true
      })
      return
    }
    actionKeys.settle(action, dispositionForOutcome(outcome))
    switch (outcome.kind) {
      case 'consumed': {
        const updatedLot = outcome.result.lot
        setBanner({
          tone: 'success',
          text: outcome.replayed
            ? `重复提交：已返回第一次消耗的结果（${outcome.result.event.recordedAt}），未重复扣减。`
            : `已消耗“${updatedLot.displayName}”，当前余量 ${formatQuantity(updatedLot.currentQuantity)}。`
        })
        setConsumeLotId(null)
        setConsumeAmount('')
        setConsumeStatus({ kind: 'idle' })
        // 使在途的旧列表请求作废，再落最新批次投影。
        listEpochRef.current += 1
        setList((previous) =>
          previous.kind === 'loaded'
            ? {
                ...previous,
                lots: previous.lots.map((item) =>
                  item.id === updatedLot.id ? updatedLot : item
                )
              }
            : previous
        )
        return
      }
      case 'versionConflict':
        // 并发冲突：不静默覆盖，刷新最新版本后由用户重新决定。
        setBanner({ tone: 'error', text: outcome.message })
        setConsumeStatus({ kind: 'idle' })
        await refresh(householdId)
        return
      case 'notFound':
        setBanner({ tone: 'error', text: outcome.message })
        setConsumeStatus({ kind: 'idle' })
        await refresh(householdId)
        return
      case 'invalid':
        setConsumeStatus(outcome)
        return
      case 'failed':
        setConsumeStatus(outcome)
    }
  }

  const chip = (active: boolean): string =>
    active ? 'chip chip--active' : 'chip'
  const createFieldsLocked =
    createStatus.kind === 'working' ||
    actionKeys.hasPending('inventory:create')

  return (
    <View className='page'>
      <Text className='page-title'>库存批次</Text>

      {banner !== null && (
        <Text className={`notice notice--${banner.tone}`}>
          {banner.text}
        </Text>
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
            if (householdId !== null) {
              void refresh(householdId)
            }
          }}
        >
          刷新列表
        </Text>
        <Text
          className={chip(showCreate)}
          aria-disabled={createFieldsLocked}
          onClick={() => {
            if (!createFieldsLocked) {
              setShowCreate((previous) => !previous)
            }
          }}
        >
          {showCreate ? '收起新增' : '新增批次'}
        </Text>
      </View>

      {showCreate && (
        <View className='section'>
          <Text className='section-title'>手工新增批次</Text>

          {createStatus.kind === 'invalid' && (
            <View className='notice notice--error'>
              {createStatus.messages.map((message) => (
                <Text key={message}>{message}</Text>
              ))}
            </View>
          )}
          {createStatus.kind === 'failed' && (
            <View className='notice notice--error'>
              <Text>{createStatus.message}</Text>
              {createStatus.retryable && (
                <Text>（已保留输入，可使用同一请求重试）</Text>
              )}
            </View>
          )}

          <Text className='field-label'>名称</Text>
          <Input
            className='field-input'
            value={draftName}
            disabled={createFieldsLocked}
            placeholder='例如：鸡蛋'
            onInput={(event) => {
              setDraftName(event.detail.value)
            }}
          />

          <Text className='field-label'>存放位置</Text>
          <View className='chip-row'>
            {STORAGE_LOCATIONS.map((location) => (
              <Text
                key={location}
                className={chip(draftLocation === location)}
                aria-disabled={createFieldsLocked}
                onClick={() => {
                  if (!createFieldsLocked) setDraftLocation(location)
                }}
              >
                {STORAGE_LOCATION_TEXT[location]}
              </Text>
            ))}
          </View>

          <Text className='field-label'>初始数量类型</Text>
          <View className='chip-row'>
            {(
              [
                ['exact', '精确'],
                ['approximate', '估算'],
                ['qualitative', '感性']
              ] as const
            ).map(([kind, label]) => (
              <Text
                key={kind}
                className={chip(quantityKind === kind)}
                aria-disabled={createFieldsLocked}
                onClick={() => {
                  if (!createFieldsLocked) setQuantityKind(kind)
                }}
              >
                {label}
              </Text>
            ))}
          </View>

          {quantityKind === 'exact' && (
            <View>
              <Text className='field-label'>数量（精确小数）</Text>
              <Input
                className='field-input'
                value={exactAmount}
                disabled={createFieldsLocked}
                placeholder='例如：12'
                onInput={(event) => {
                  setExactAmount(event.detail.value)
                }}
              />
              <Text className='field-label'>单位</Text>
              <Input
                className='field-input'
                value={exactUnit}
                disabled={createFieldsLocked}
                placeholder='例如：个'
                onInput={(event) => {
                  setExactUnit(event.detail.value)
                }}
              />
            </View>
          )}

          {quantityKind === 'approximate' && (
            <View>
              <Text className='field-label'>估算数量</Text>
              <Input
                className='field-input'
                value={approxAmount}
                disabled={createFieldsLocked}
                placeholder='例如：0.5'
                onInput={(event) => {
                  setApproxAmount(event.detail.value)
                }}
              />
              <Text className='field-label'>单位</Text>
              <Input
                className='field-input'
                value={approxUnit}
                disabled={createFieldsLocked}
                placeholder='例如：袋'
                onInput={(event) => {
                  setApproxUnit(event.detail.value)
                }}
              />
              <Text className='field-label'>置信度</Text>
              <View className='chip-row'>
                {CONFIDENCES.map((confidence) => (
                  <Text
                    key={confidence}
                    className={chip(approxConfidence === confidence)}
                    aria-disabled={createFieldsLocked}
                    onClick={() => {
                      if (!createFieldsLocked) {
                        setApproxConfidence(confidence)
                      }
                    }}
                  >
                    {CONFIDENCE_TEXT[confidence]}
                  </Text>
                ))}
              </View>
              <Text className='field-label'>原始描述（必填）</Text>
              <Input
                className='field-input'
                value={approxOriginalText}
                disabled={createFieldsLocked}
                placeholder='例如：大概还剩半袋'
                onInput={(event) => {
                  setApproxOriginalText(event.detail.value)
                }}
              />
            </View>
          )}

          {quantityKind === 'qualitative' && (
            <View>
              <Text className='field-label'>感性水平</Text>
              <View className='chip-row'>
                {QUALITATIVE_LEVELS.map((level) => (
                  <Text
                    key={level}
                    className={chip(qualLevel === level)}
                    aria-disabled={createFieldsLocked}
                    onClick={() => {
                      if (!createFieldsLocked) setQualLevel(level)
                    }}
                  >
                    {QUALITATIVE_LEVEL_LABEL[level]}
                  </Text>
                ))}
              </View>
              <Text className='field-label'>原始描述（可选）</Text>
              <Input
                className='field-input'
                value={qualOriginalText}
                disabled={createFieldsLocked}
                placeholder='例如：还有一些'
                onInput={(event) => {
                  setQualOriginalText(event.detail.value)
                }}
              />
            </View>
          )}

          <Button
            className={
              createStatus.kind === 'working'
                ? 'button button--disabled'
                : 'button'
            }
            disabled={createStatus.kind === 'working'}
            onClick={() => {
              void handleCreate()
            }}
          >
            {createStatus.kind === 'working' ? '正在创建…' : '创建批次'}
          </Button>
        </View>
      )}

      <View className='section'>
        <Text className='section-title'>批次列表</Text>
        {list.kind === 'loading' && <Text>正在加载库存批次…</Text>}
        {list.kind === 'failed' && (
          <View>
            <Text className='notice notice--error'>{list.message}</Text>
            {list.retryable && (
              <Button
                className='button button--secondary'
                onClick={() => {
                  if (householdId !== null) {
                    void refresh(householdId)
                  }
                }}
              >
                重试加载
              </Button>
            )}
          </View>
        )}
        {list.kind === 'loaded' && list.lots.length === 0 && (
          <Text>
            当前家庭还没有库存批次。点击上方“新增批次”手工录入第一条。
          </Text>
        )}
        {list.kind === 'loaded' &&
          list.lots.map((lot) => (
            <View key={lot.id} className='list-item'>
              <Text className='list-item-title'>{lot.displayName}</Text>
              <Text className='list-item-detail'>
                {STORAGE_LOCATION_TEXT[lot.storageLocation]} ·{' '}
                {formatQuantity(lot.currentQuantity)} · 状态 {lot.state} ·
                版本 v{lot.version}
              </Text>

              {lot.state === 'active' &&
                lot.currentQuantity.kind === 'exact' && (
                  <View>
                    {consumeLotId === lot.id ? (
                      <View>
                        {consumeStatus.kind === 'invalid' && (
                          <View className='notice notice--error'>
                            {consumeStatus.messages.map((message) => (
                              <Text key={message}>{message}</Text>
                            ))}
                          </View>
                        )}
                        {consumeStatus.kind === 'failed' && (
                          <View className='notice notice--error'>
                            <Text>{consumeStatus.message}</Text>
                            {consumeStatus.retryable && (
                              <Text>
                                （已保留输入，可使用同一请求重试）
                              </Text>
                            )}
                          </View>
                        )}
                        <Text className='field-label'>
                          消耗数量（{lot.currentQuantity.unit}）
                        </Text>
                        <Input
                          className='field-input'
                          value={consumeAmount}
                          disabled={
                            consumeStatus.kind === 'working' ||
                            actionKeys.hasPending(
                              `inventory:consume:${lot.id}`
                            )
                          }
                          placeholder='例如：2'
                          onInput={(event) => {
                            setConsumeAmount(event.detail.value)
                          }}
                        />
                        <Button
                          className={
                            consumeStatus.kind === 'working'
                              ? 'button button--disabled'
                              : 'button'
                          }
                          disabled={consumeStatus.kind === 'working'}
                          onClick={() => {
                            void handleConsume(lot)
                          }}
                        >
                          {consumeStatus.kind === 'working'
                            ? '正在提交…'
                            : '确认消耗'}
                        </Button>
                        <Button
                          className={
                            consumeStatus.kind === 'working' ||
                            actionKeys.hasPending(
                              `inventory:consume:${lot.id}`
                            )
                              ? 'button button--secondary button--disabled'
                              : 'button button--secondary'
                          }
                          disabled={
                            consumeStatus.kind === 'working' ||
                            actionKeys.hasPending(
                              `inventory:consume:${lot.id}`
                            )
                          }
                          onClick={() => {
                            setConsumeLotId(null)
                            setConsumeAmount('')
                            setConsumeStatus({ kind: 'idle' })
                          }}
                        >
                          取消
                        </Button>
                      </View>
                    ) : (
                      <Button
                        className={
                          consumeStatus.kind === 'working'
                            ? 'button button--secondary button--disabled'
                            : 'button button--secondary'
                        }
                        disabled={consumeStatus.kind === 'working'}
                        onClick={() => {
                          setConsumeLotId(lot.id)
                          setConsumeAmount('')
                          setConsumeStatus({ kind: 'idle' })
                        }}
                      >
                        消耗
                      </Button>
                    )}
                  </View>
                )}

              {lot.state === 'active' &&
                lot.currentQuantity.kind !== 'exact' && (
                  <Text className='list-item-detail'>
                    本阶段仅支持精确数量批次的消耗操作。
                  </Text>
                )}
            </View>
          ))}
        {list.kind === 'loaded' && list.hasMore && (
          <Text className='list-item-detail'>
            仅显示前 50 个批次；分页浏览不在本阶段范围。
          </Text>
        )}
      </View>
    </View>
  )
}
