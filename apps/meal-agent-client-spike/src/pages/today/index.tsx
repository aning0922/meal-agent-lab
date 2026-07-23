import { useEffect, useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'

import { platform } from '../../platform'
import type {
  MockAuthSession,
  SpikeApiResult,
  SpikeDraft
} from '../../platform/contracts'

export default function TodayPage() {
  const [draft, setDraft] = useState<SpikeDraft>({ note: '', updatedAt: null })
  const [session, setSession] = useState<MockAuthSession | null>(null)
  const [apiResult, setApiResult] = useState<SpikeApiResult | null>(null)
  const [apiStatus, setApiStatus] = useState('尚未调用本地模拟 API')

  useEffect(() => {
    setDraft(platform.storage.loadDraft())
    setSession(platform.auth.restore())
  }, [])

  const saveDraft = () => {
    setDraft(platform.storage.saveDraft(draft.note))
  }

  const loginWithMock = async () => {
    setSession(await platform.auth.login())
  }

  const logoutMock = () => {
    platform.auth.logout()
    setSession(null)
  }

  const callMockApi = async () => {
    setApiStatus('请求中…')
    try {
      const result = await platform.network.loadTodaySignal()
      setApiResult(result)
      setApiStatus('模拟 API 调用成功')
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      setApiStatus(`调用失败：${message}`)
    }
  }

  return (
    <View className='page'>
      <View className='eyebrow'>CROSS-PLATFORM SPIKE</View>
      <View className='title'>今天</View>
      <View className='subtitle'>
        仅验证页面、状态、网络和平台边界；不是正式 Meal Agent 客户端。
      </View>

      <View className='card'>
        <View className='card-title'>本地状态</View>
        <View className='body'>输入一段无业务含义的验证备注，再关闭并重开页面。</View>
        <Input
          className='input'
          placeholder='例如：本地状态已验证'
          value={draft.note}
          onInput={(event) => {
            setDraft({ ...draft, note: event.detail.value })
          }}
        />
        <Button className='button' onClick={saveDraft}>
          保存到本地
        </Button>
        <View className='status'>
          {draft.updatedAt
            ? `已保存：${draft.updatedAt}`
            : '还没有保存过'}
        </View>
      </View>

      <View className='card'>
        <View className='card-title'>Mock 登录</View>
        <View className='body'>
          只验证 AuthPort、Mock 会话与本地恢复；不会调用 wx.login。
        </View>
        <View className='button-row'>
          <Button className='button' onClick={loginWithMock}>
            Mock 登录
          </Button>
          <Button className='button button-secondary' onClick={logoutMock}>
            退出 Mock
          </Button>
        </View>
        <View className='status'>
          {session
            ? `${session.displayName} · ${session.source} · ${session.createdAt}`
            : '当前没有 Mock 会话'}
        </View>
      </View>

      <View className='card'>
        <View className='card-title'>模拟 API</View>
        <View className='body'>
          请求本机 127.0.0.1:8787；需要先运行 pnpm mock:api。
        </View>
        <Button className='button' onClick={callMockApi}>
          调用模拟 API
        </Button>
        <View className='status'>
          <Text>{apiStatus}</Text>
          {apiResult ? (
            <View>
              {apiResult.message} · {apiResult.generatedAt}
            </View>
          ) : null}
        </View>
      </View>

      <View className='card'>
        <View className='card-title'>上下文 Agent 边界</View>
        <View className='body'>
          Agent 入口保留在业务页面内；本实验不实现对话、模型调用或写操作。
        </View>
      </View>

      <View className='card'>
        <View className='card-title'>平台能力适配层</View>
        {platform.capabilities.map((capability) => (
          <View className='capability-row' key={capability.name}>
            <Text>{capability.name}</Text>
            <Text className='capability-value'>
              {capability.result}
            </Text>
          </View>
        ))}
      </View>

      <Button className='button button-secondary' onClick={platform.navigation.openInventory}>
        打开库存页面
      </Button>
    </View>
  )
}
