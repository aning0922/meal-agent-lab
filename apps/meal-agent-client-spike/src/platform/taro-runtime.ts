import Taro from '@tarojs/taro'

import type { RuntimePort, RuntimeResponse } from './contracts'

export const taroRuntime: RuntimePort = {
  getStorage(key) {
    return Taro.getStorageSync(key)
  },
  async request<T>(url: string): Promise<RuntimeResponse<T>> {
    const response = await Taro.request<T>({
      method: 'GET',
      timeout: 5000,
      url
    })

    return {
      data: response.data,
      statusCode: response.statusCode
    }
  },
  setStorage(key, value) {
    Taro.setStorageSync(key, value)
  },
  async switchTab(url) {
    await Taro.switchTab({ url })
  }
}
