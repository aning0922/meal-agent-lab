import Taro from '@tarojs/taro'

import type {
  AppRoute,
  HttpRequest,
  HttpResponse,
  PlatformAdapter
} from './ports'

/**
 * 唯一允许触碰 Taro/wx API 的模块。页面和核心逻辑一律通过
 * PlatformAdapter 端口访问平台能力。
 */

const requestViaTaro = async (request: HttpRequest): Promise<HttpResponse> => {
  const response = await Taro.request({
    url: request.url,
    method: request.method,
    header: request.headers,
    ...(request.body === undefined ? {} : { data: request.body }),
    // dataType 非 json：平台不做 JSON.parse，核心层统一解析原始文本。
    dataType: '其他',
    responseType: 'text',
    timeout: 15_000
  })

  return {
    statusCode: response.statusCode,
    body:
      typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data)
  }
}

let idempotencyCounter = 0

const fallbackRandomSegment = (): string =>
  Math.random().toString(36).slice(2, 10)

const randomToken = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined) {
    return uuid
  }
  idempotencyCounter = (idempotencyCounter + 1) % 1_679_616
  return [
    Date.now().toString(36),
    idempotencyCounter.toString(36),
    fallbackRandomSegment(),
    fallbackRandomSegment(),
    fallbackRandomSegment()
  ].join('.')
}

export const createTaroPlatformAdapter = (): PlatformAdapter => ({
  auth: {
    async getLoginCode() {
      const result = await Taro.login()
      if (result.code === undefined || result.code === '') {
        throw new Error(`wx.login did not return a code: ${result.errMsg}`)
      }
      return result.code
    }
  },
  network: {
    async request(request) {
      try {
        return await requestViaTaro(request)
      } catch (error) {
        const message =
          typeof (error as { errMsg?: unknown }).errMsg === 'string'
            ? (error as { errMsg: string }).errMsg
            : String(error)
        throw new Error(`network request failed: ${message}`)
      }
    }
  },
  storage: {
    get(key) {
      const value: unknown = Taro.getStorageSync(key)
      // wx 的同步存储用空字符串表示键不存在；本应用不会存空字符串。
      return value === '' ? undefined : value
    },
    set(key, value) {
      Taro.setStorageSync(key, value)
    },
    remove(key) {
      Taro.removeStorageSync(key)
    }
  },
  navigation: {
    async reLaunch(route: AppRoute) {
      await Taro.reLaunch({ url: route })
    },
    async navigateTo(route: AppRoute) {
      await Taro.navigateTo({ url: route })
    },
    async navigateBack() {
      await Taro.navigateBack()
    }
  },
  runtime: {
    nowMs: () => Date.now(),
    randomToken
  }
})
