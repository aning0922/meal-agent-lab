import type { Quantity } from '@meal-agent/contracts'
import type { StorageLocation } from '@meal-agent/contracts/inventory'

export const STORAGE_LOCATION_TEXT: Record<StorageLocation, string> = {
  pantry: '常温',
  refrigerated: '冷藏',
  frozen: '冷冻',
  other: '其他'
}

const QUALITATIVE_LEVEL_TEXT = {
  plenty: '充足',
  some: '一些',
  low: '偏少',
  empty: '已空',
  unknown: '未知'
} as const

export const CONFIDENCE_TEXT = {
  high: '高',
  medium: '中',
  low: '低'
} as const

/** 数量展示保持来源与置信度可见：估算量和感性量不得伪装成精确量。 */
export const formatQuantity = (quantity: Quantity): string => {
  switch (quantity.kind) {
    case 'exact':
      return `${quantity.amount} ${quantity.unit}`
    case 'approximate': {
      const base =
        quantity.amount !== undefined && quantity.unit !== undefined
          ? `约 ${quantity.amount} ${quantity.unit}`
          : '约（数值未知）'
      return `${base} · 置信度${CONFIDENCE_TEXT[quantity.confidence]} · “${quantity.originalText}”`
    }
    case 'qualitative': {
      const level = QUALITATIVE_LEVEL_TEXT[quantity.level]
      return quantity.originalText === undefined
        ? level
        : `${level}（“${quantity.originalText}”）`
    }
  }
}
