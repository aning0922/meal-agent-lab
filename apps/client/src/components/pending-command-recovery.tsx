import { useEffect, useState } from 'react'
import { Button, Text, View } from '@tarojs/components'

import { getAppServices } from '../app-runtime'
import {
  commandLabel,
  type CommandLocalRecovery,
  type CommandReconciliation
} from '../core/command-registry'
import type { PendingCommandStatus } from '../core/idempotency'

export const PendingCommandRecovery = () => {
  const services = getAppServices()
  const [status, setStatus] = useState<PendingCommandStatus>(
    services.pendingCommands.status()
  )
  const [retrying, setRetrying] = useState(false)
  const [recoveringLocally, setRecoveringLocally] = useState(false)
  const [reconciliation, setReconciliation] =
    useState<CommandReconciliation | null>(null)
  const [localRecovery, setLocalRecovery] =
    useState<CommandLocalRecovery | null>(null)

  useEffect(
    () =>
      services.pendingCommands.subscribe(() => {
        const next = services.pendingCommands.status()
        setStatus(next)
        if (next.phase !== 'idle') {
          setReconciliation(null)
          setLocalRecovery(null)
        }
      }),
    [services]
  )

  if (status.phase === 'idle' && reconciliation === null) return null

  return (
    <View className='pending-command-recovery'>
      {status.phase !== 'idle' && (
        <Text>
          未决命令：{commandLabel(status.commandKind)}。
          {status.phase === 'auth-suspended'
            ? '会话已暂停；必须使用原账号重新登录，其他账号不能读取或执行此命令。'
            : status.phase === 'in-flight'
              ? '请求正在执行；为避免重复写入，当前不能再次发送。'
              : '结果未知；只能使用原 snapshot 和原 key 重试。普通 GET、页面切换或资源消失都不会释放该命令。'}
        </Text>
      )}
      {reconciliation !== null && (
        <View>
          <Text>{reconciliation.message}</Text>
          {reconciliation.secret !== undefined && (
            <Text>
              {reconciliation.secret.label}：
              {reconciliation.secret.value}
            </Text>
          )}
        </View>
      )}
      {status.phase === 'unknown' && (
        <Button
          className={retrying ? 'button button--disabled' : 'button'}
          disabled={retrying}
          onClick={() => {
            if (retrying) return
            setRetrying(true)
            void services.commands
              .retryActive()
              .then((result) => {
                switch (result.kind) {
                  case 'reconciled':
                    setReconciliation(result.presentation)
                    setLocalRecovery(null)
                    return
                  case 'local-recovery-required':
                    setReconciliation(result.presentation)
                    setLocalRecovery(result.recovery)
                    return
                  case 'unknown':
                  case 'unexpected-error':
                    setReconciliation({
                      tone: 'warning',
                      message:
                        '重试结果仍未知；原命令和原 key 已保留，只能再次重试。'
                    })
                    setLocalRecovery(null)
                    return
                  case 'auth-suspended':
                    setReconciliation({
                      tone: 'warning',
                      message: '认证已暂停，请使用原账号重新登录后恢复。'
                    })
                    setLocalRecovery(null)
                    return
                  case 'in-flight':
                    setReconciliation({
                      tone: 'warning',
                      message: '原命令已在执行，没有发送第二个请求。'
                    })
                    setLocalRecovery(null)
                    return
                  case 'stale-attempt':
                    setReconciliation({
                      tone: 'warning',
                      message:
                        '该响应属于已失效的旧请求，没有修改当前未决命令。'
                    })
                    setLocalRecovery(null)
                    return
                  case 'idle':
                    return
                }
              })
              .finally(() => {
                setRetrying(false)
              })
          }}
        >
          {retrying ? '正在重试原命令…' : '重试原命令'}
        </Button>
      )}
      {status.phase !== 'idle' && (
        <Button
          className='button button--secondary'
          disabled={status.phase === 'auth-suspended'}
          onClick={() => {
            void services.navigation.reLaunch(
              services.pendingRecoveryRoute()
            )
          }}
        >
          返回命令页面
        </Button>
      )}
      {status.phase === 'idle' && localRecovery !== null && (
        <Button
          className={
            recoveringLocally
              ? 'button button--disabled'
              : 'button'
          }
          disabled={recoveringLocally}
          onClick={() => {
            if (recoveringLocally) return
            setRecoveringLocally(true)
            void services.commands
              .retryLocalRecovery(localRecovery)
              .then((result) => {
                setReconciliation(result.presentation)
                setLocalRecovery(
                  result.kind === 'local-recovery-required'
                    ? result.recovery
                    : null
                )
              })
              .finally(() => setRecoveringLocally(false))
          }}
        >
          {recoveringLocally
            ? '正在恢复页面切换…'
            : '安全重试页面切换'}
        </Button>
      )}
      {status.phase === 'idle' &&
        reconciliation !== null &&
        localRecovery === null && (
          <Button
            className='button button--secondary'
            onClick={() => setReconciliation(null)}
          >
            知道了
          </Button>
        )}
    </View>
  )
}
