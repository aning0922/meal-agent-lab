import { useEffect, useState } from 'react'
import { Button, Text, View } from '@tarojs/components'

import { getAppServices } from '../app-runtime'
import { commandLabel } from '../core/command-registry'
import type { PendingCommandStatus } from '../core/idempotency'

export const PendingCommandRecovery = () => {
  const services = getAppServices()
  const [status, setStatus] = useState<PendingCommandStatus>(
    services.pendingCommands.status()
  )
  const [retrying, setRetrying] = useState(false)

  useEffect(
    () =>
      services.pendingCommands.subscribe(() => {
        setStatus(services.pendingCommands.status())
      }),
    [services]
  )

  if (status.phase === 'idle') return null

  return (
    <View className='pending-command-recovery'>
      <Text>
        未决命令：{commandLabel(status.commandKind)}。
        {status.phase === 'auth-suspended'
          ? '会话已暂停；必须使用原账号重新登录，其他账号不能读取或执行此命令。'
          : '普通 GET、页面切换或资源消失都不会释放该命令。'}
      </Text>
      {status.phase !== 'auth-suspended' && (
        <Button
          className={retrying ? 'button button--disabled' : 'button'}
          disabled={retrying}
          onClick={() => {
            if (retrying) return
            setRetrying(true)
            void services.commands.retryActive().finally(() => {
              setRetrying(false)
            })
          }}
        >
          {retrying ? '正在重试原命令…' : '重试原命令'}
        </Button>
      )}
      <Button
        className='button button--secondary'
        disabled={status.phase === 'auth-suspended'}
        onClick={() => {
          void services.navigation.reLaunch(status.ownerRoute)
        }}
      >
        返回命令页面
      </Button>
    </View>
  )
}
