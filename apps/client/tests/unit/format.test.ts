import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { quantitySchema } from '@meal-agent/contracts'

import { formatQuantity } from '../../src/core/format'

describe('formatQuantity', () => {
  it('精确数量显示数值与单位', () => {
    assert.equal(
      formatQuantity(
        quantitySchema.parse({ kind: 'exact', amount: '2.5', unit: '个' })
      ),
      '2.5 个'
    )
  })

  it('估算数量保留置信度与原始描述，不伪装成精确量', () => {
    const text = formatQuantity(
      quantitySchema.parse({
        kind: 'approximate',
        amount: 0.5,
        unit: '袋',
        confidence: 'low',
        originalText: '大概半袋'
      })
    )
    assert.match(text, /约 0\.5 袋/)
    assert.match(text, /置信度低/)
    assert.match(text, /大概半袋/)
  })

  it('估算数量缺数值时明确显示数值未知', () => {
    const text = formatQuantity(
      quantitySchema.parse({
        kind: 'approximate',
        confidence: 'medium',
        originalText: '还有一点'
      })
    )
    assert.match(text, /数值未知/)
  })

  it('感性数量显示等级', () => {
    assert.equal(
      formatQuantity(
        quantitySchema.parse({ kind: 'qualitative', level: 'some' })
      ),
      '一些'
    )
  })
})
