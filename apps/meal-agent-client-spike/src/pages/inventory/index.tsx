import { Button, View } from '@tarojs/components'

import { platform } from '../../platform'

export default function InventoryPage() {
  const draft = platform.storage.loadDraft()

  return (
    <View className='page'>
      <View className='eyebrow'>NAVIGATION TARGET</View>
      <View className='title'>库存</View>
      <View className='subtitle'>
        这是用于验证路由与共享平台适配层的页面壳，不包含库存批次、数量或事件模型。
      </View>

      <View className='card'>
        <View className='card-title'>跨页读取</View>
        <View className='body'>
          今天页本地备注：{draft.note || '尚未保存'}
        </View>
        <View className='body'>
          最近保存时间：{draft.updatedAt || '尚未写入'}
        </View>
        <View className='status'>
          两个页面通过同一个 Storage Port 读取数据，页面未直接调用平台 API。
        </View>
      </View>

      <Button className='button button-secondary' onClick={platform.navigation.openToday}>
        返回今天页面
      </Button>
    </View>
  )
}
