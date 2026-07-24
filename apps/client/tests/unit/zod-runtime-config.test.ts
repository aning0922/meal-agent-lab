import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { z } from 'zod'

import '../../src/zod-runtime-config'

/**
 * 小程序运行时禁用动态代码执行，Zod v4 的对象校验 JIT 快路径会失效。
 * 客户端必须全局关闭 JIT（jitless），且必须先于契约 schema 构造。
 * Node 里 JIT 可用、无法复现小程序崩溃，因此这里退而固定配置本身，
 * 防止 jitless 被误删。
 */
describe('zod-runtime-config', () => {
  it('全局关闭 zod JIT（jitless）', () => {
    const config = z.config() as { jitless?: boolean }
    assert.equal(config.jitless, true)
  })

  it('对象 schema 在 jitless 下仍正确解析', () => {
    const schema = z.strictObject({ a: z.string(), b: z.number() })
    assert.equal(schema.safeParse({ a: 'x', b: 1 }).success, true)
    assert.equal(schema.safeParse({ a: 'x' }).success, false)
  })
})
