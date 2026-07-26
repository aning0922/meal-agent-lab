import { useEffect, useState } from 'react'

import { getAppServices } from '../app-runtime'

/**
 * 页面只订阅 coordinator，不各自实现 pending 状态机。全局恢复完成、
 * 确定失败或认证状态变化后，仍在栈内的页面会重新渲染并立即解除/收紧
 * 写入口，而不是等待另一个无关本地 state 变化。
 */
export const usePendingCommandSubscription = (): void => {
  const [, setRevision] = useState(0)

  useEffect(() => {
    const pending = getAppServices().pendingCommands
    return pending.subscribe(() => {
      setRevision((revision) => revision + 1)
    })
  }, [])
}
