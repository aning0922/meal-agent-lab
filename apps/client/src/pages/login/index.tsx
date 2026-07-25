import '../../zod-runtime-config'
import { useEffect, useState } from 'react'
import { Button, Text, View } from '@tarojs/components'

import { getAppServices } from '../../app-runtime'
import { signIn } from '../../core/auth-flow'
import {
  HOUSEHOLDS_ROUTE,
  INVENTORY_ROUTE
} from '../../platform/ports'

type LoginStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | {
      readonly kind: 'failed'
      readonly message: string
      readonly retryable: boolean
    }

export default function LoginPage() {
  const [status, setStatus] = useState<LoginStatus>({ kind: 'idle' })
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const services = getAppServices()
    setNotice(services.consumeUnauthorizedNotice())
    if (services.session.restore() !== null) {
      const route =
        services.session.restoreCurrentHouseholdId() !== null
          ? INVENTORY_ROUTE
          : HOUSEHOLDS_ROUTE
      void services.adapter.navigation.reLaunch(route)
    }
  }, [])

  const handleSignIn = async (): Promise<void> => {
    if (status.kind === 'working') {
      return
    }
    setStatus({ kind: 'working' })
    const services = getAppServices()
    const result = await signIn(services)
    if (result.kind === 'success') {
      await services.adapter.navigation.reLaunch(HOUSEHOLDS_ROUTE)
      return
    }
    setStatus(result)
  }

  return (
    <View className='page'>
      <Text className='page-title'>Meal Agent</Text>

      {notice !== null && (
        <Text className='notice notice--info'>{notice}</Text>
      )}

      {status.kind === 'failed' && (
        <View className='notice notice--error'>
          <Text>{status.message}</Text>
          {status.retryable && <Text>（可直接重试）</Text>}
        </View>
      )}

      <View className='section'>
        <Text className='section-title'>登录</Text>
        <Text>使用微信身份登录后管理家庭与库存。</Text>
        <Button
          className={
            status.kind === 'working'
              ? 'button button--disabled'
              : 'button'
          }
          disabled={status.kind === 'working'}
          onClick={() => {
            void handleSignIn()
          }}
        >
          {status.kind === 'working' ? '正在登录…' : '微信登录'}
        </Button>
      </View>
    </View>
  )
}
